import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ProposedOrder, QuoteSnapshot, Thesis, ThesisKind } from './types.js';
import type { Config } from './config.js';
import { loadConfig } from './config.js';
import { currentSession, nowET, sessionEnabled } from './clock.js';
import { activeEventBlackout, entryTimingAllowed, sessionGate } from './session-risk.js';
import { costScalar, drawdownThrottle, participationQty, riskOffTriggered } from './signals.js';
import { appendAudit } from './audit.js';
import { evaluateExit, resolveExitPlan } from './exits.js';
import { ensureOut, OUT_DIR, readJsonIfExists, thesisPath } from './paths.js';
import { prunePositionPeaks, readHaltState, trackPositionPeak, updatePeakEquity, writeHalt } from './state.js';
import { riskCheck, type RiskContext } from './risk.js';
import type { BrokerClient } from './broker/client.js';
import { AlpacaBroker } from './broker/client.js';
import { AlpacaMarketData, type NewsItem } from './broker/marketdata.js';
import { judgeTick } from './agents/judge.js';
import type { LlmClient } from './agents/llm.js';

export interface TickDeps {
  cfg?: Config;
  broker?: BrokerClient;
  marketData?: AlpacaMarketData;
  llm?: LlmClient;
  now?: Date;
}

const DAY_MS = 86_400_000;

/**
 * A corrupt or shape-invalid thesis file ABORTS the tick (default posture:
 * do nothing) rather than silently falling back to an older thesis. Only a
 * genuinely absent file returns null.
 */
function loadThesisFile(ymd: string, kind: ThesisKind): Thesis | null {
  const file = thesisPath(ymd, kind);
  let raw: Thesis | null;
  try {
    raw = readJsonIfExists<Thesis>(file);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    appendAudit({ kind: 'error', data: { stage: 'thesis_load', file, message } });
    throw new Error(`malformed thesis file ${file}: ${message}`);
  }
  if (!raw) return null;
  if (
    !Array.isArray(raw.entries) ||
    typeof raw.expiresAt !== 'string' ||
    typeof raw.generatedAt !== 'string'
  ) {
    appendAudit({ kind: 'error', data: { stage: 'thesis_load', file } });
    throw new Error(`malformed thesis file ${file}: invalid shape`);
  }
  return raw;
}

function loadUnexpiredThesis(ymd: string, now: Date, kind: ThesisKind): Thesis | null {
  const raw = loadThesisFile(ymd, kind);
  if (!raw) return null;
  const expires = new Date(raw.expiresAt).getTime();
  if (!Number.isFinite(expires) || expires <= now.getTime()) return null;
  return raw;
}

/**
 * Deployment consumed today = entry orders only, identified by the
 * client_order_id tag set at placement. Canceled entries count at their
 * filled portion. Side is deliberately NOT the discriminator: short entries
 * are sells and must consume the budget; buy-side covers must not.
 */
/**
 * Split quotes into fresh vs stale relative to the tick clock. A quote with a
 * missing or unparseable timestamp is stale by definition (fail closed).
 */
export function partitionFreshQuotes(
  quotes: QuoteSnapshot[],
  nowMs: number,
  maxAgeSec: number,
): { fresh: QuoteSnapshot[]; stale: number } {
  const maxAgeMs = maxAgeSec * 1000;
  const fresh: QuoteSnapshot[] = [];
  let stale = 0;
  for (const q of quotes) {
    const asOfMs = Date.parse(q.asOf);
    if (Number.isFinite(asOfMs) && nowMs - asOfMs <= maxAgeMs && nowMs - asOfMs >= -maxAgeMs) {
      fresh.push(q);
    } else {
      stale++;
    }
  }
  return { fresh, stale };
}

export function seedDeployedTodayUsd(todayOrders: { clientOrderId?: string; status: string; qty: number; filledQty?: number; limitPrice: number }[]): number {
  return todayOrders
    .filter((o) => o.clientOrderId?.startsWith('entry-'))
    .reduce(
      (sum, o) => sum + (o.status === 'canceled' ? (o.filledQty ?? 0) : o.qty) * o.limitPrice,
      0,
    );
}

/**
 * Clamp an entry limit to the thesis band and round to whole cents toward
 * the passive side (floor for buys, ceil for sells) so the price stays
 * inside the band and Alpaca never sees sub-penny precision.
 */
export function entryLimitPrice(
  direction: 'long' | 'short',
  quote: { bid: number; ask: number },
  band: { low: number; high: number },
  aggressiveness = 1,
): number {
  // aggressiveness 1 = marketable (take the far side, clamped to the band) —
  // the historical behavior. <1 rests inside the spread by that fraction.
  const a = Math.max(0, Math.min(1, aggressiveness));
  if (direction === 'long') {
    const target = a >= 1 ? quote.ask : quote.bid + a * (quote.ask - quote.bid);
    return Math.floor(Math.min(target, band.high) * 100) / 100;
  }
  const target = a >= 1 ? quote.bid : quote.ask - a * (quote.ask - quote.bid);
  return Math.ceil(Math.max(target, band.low) * 100) / 100;
}

/**
 * Unrealized loss on a position as a positive percentage (a gain is negative),
 * marked conservatively at the exit-side quote (long -> bid, short -> ask).
 * avgEntryPrice <= 0 -> 0 (no basis to measure against). Pure.
 */
export function positionLossPct(
  position: { side: 'long' | 'short'; avgEntryPrice: number },
  quote: { bid: number; ask: number },
): number {
  if (!(position.avgEntryPrice > 0)) return 0;
  const isLong = position.side === 'long';
  const mark = isLong ? quote.bid : quote.ask;
  return (
    (isLong
      ? (position.avgEntryPrice - mark) / position.avgEntryPrice
      : (mark - position.avgEntryPrice) / position.avgEntryPrice) * 100
  );
}

/**
 * Live short-borrow gate — ports the backtest's checkShortable (an easy-to-borrow
 * membership test) to the live executor. A short may proceed only on a name the
 * broker reports as shortable, and — under strict mode — easy-to-borrow. A
 * missing asset lookup (null) fails CLOSED: never short a name whose borrow
 * availability could not be confirmed. Alpaca exposes no per-name borrow rate,
 * so easy-to-borrow is the live proxy for the backtest's 0.3%/yr borrow model.
 */
export function shortEligibility(
  info: { shortable: boolean; easyToBorrow: boolean } | null,
  requireEasyToBorrow: boolean,
): { ok: boolean; reason: string } {
  if (!info) return { ok: false, reason: 'shortability unknown' };
  if (!info.shortable) return { ok: false, reason: 'not shortable' };
  if (requireEasyToBorrow && !info.easyToBorrow) return { ok: false, reason: 'not easy to borrow' };
  return { ok: true, reason: '' };
}

export async function runTick(deps: TickDeps = {}): Promise<void> {
  const now = deps.now ?? new Date();
  const cfg = deps.cfg ?? loadConfig();

  const session = currentSession(now);
  if (!sessionEnabled(session, cfg)) {
    appendAudit({
      kind: 'tick',
      data: { stage: 'session_gate', session, action: 'skip', reason: 'session closed or disabled' },
    });
    return;
  }

  if (!deps.llm && !process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not set; add it to .env');
  }
  const broker = deps.broker ?? new AlpacaBroker(cfg);
  const md =
    deps.marketData ?? new AlpacaMarketData(process.env, globalThis.fetch, undefined, cfg.data_feed);

  let halt = readHaltState();
  const [account, initialOpenOrders, dailyPl, todayOrders] = await Promise.all([
    broker.getAccount(),
    broker.getOpenOrders(),
    broker.getDailyPl(),
    broker.getTodayOrders(),
  ]);

  if (!halt.halted && dailyPl <= -((account.equity * cfg.daily_loss_halt_pct) / 100)) {
    halt = writeHalt('daily loss halt', now);
    appendAudit({ kind: 'halt', data: { reason: 'daily loss halt', dailyPl, equity: account.equity } });
  }

  // Book-level overlays (P2, flag-off by default -> throttle 1, no freeze) and
  // the session-calibrated pre-trade gate (SIP-only; flat on IEX). The peak
  // high-water mark is only read/written when the throttle is enabled, so the
  // flag-off path writes no new artifact.
  const ddThrottle = cfg.risk_overlay.drawdown_throttle.enabled
    ? drawdownThrottle(account.equity, updatePeakEquity(account.equity, now), cfg.risk_overlay.drawdown_throttle)
    : 1;
  const gate = sessionGate(session, cfg);

  let riskOffFreeze = false;
  if (cfg.risk_overlay.risk_off.enabled) {
    try {
      const [spyQuotes, spyBarsMap] = await Promise.all([
        md.getLatestQuotes(['SPY']),
        md.getDailyBars(['SPY'], 3),
      ]);
      const spyQuote = spyQuotes[0];
      const spyBars = spyBarsMap.get('SPY') ?? [];
      const ref = spyBars.length >= 2 ? spyBars[spyBars.length - 2]!.c : spyBars[spyBars.length - 1]?.c;
      if (spyQuote && ref && ref > 0) {
        const dropPct = (((spyQuote.bid + spyQuote.ask) / 2 - ref) / ref) * 100;
        riskOffFreeze = riskOffTriggered(dropPct, cfg.risk_overlay.risk_off);
        if (riskOffFreeze) {
          appendAudit({ kind: 'tick', data: { stage: 'risk_off', session, dropPct: Math.round(dropPct * 100) / 100 } });
        }
      }
    } catch {
      // SPY fetch failure -> no freeze (overlay fails open; core risk gates still apply).
    }
  }

  const todayYmd = nowET(now).ymd;
  const yesterdayYmd = nowET(new Date(now.getTime() - DAY_MS)).ymd;
  // The regular session trades its own same-morning thesis; pre/after-market
  // trade the evening off-hours thesis (today, else yesterday's carry-over).
  const thesisKind: ThesisKind = session === 'rth' ? 'rth' : 'offhours';
  const extendedHours = session !== 'rth';
  const thesis =
    thesisKind === 'rth'
      ? loadUnexpiredThesis(todayYmd, now, 'rth')
      : (loadUnexpiredThesis(todayYmd, now, 'offhours') ??
        loadUnexpiredThesis(yesterdayYmd, now, 'offhours'));
  if (!thesis) {
    appendAudit({ kind: 'tick', data: { stage: 'no_thesis', session, thesisKind, action: 'skip' } });
    return;
  }

  let deployedTodayUsd = seedDeployedTodayUsd(todayOrders);

  // Quotes for thesis tickers plus every open position, so invalidation
  // monitoring covers positions whose thesis entry has since expired.
  const tickers = [
    ...new Set([
      ...thesis.entries.map((e) => e.ticker.toUpperCase()),
      ...account.positions.map((p) => p.ticker.toUpperCase()),
    ]),
  ];
  const [quotes, allNews] = await Promise.all([
    tickers.length > 0 ? md.getLatestQuotes(tickers) : Promise.resolve([] as QuoteSnapshot[]),
    tickers.length > 0 ? md.getNews(50, tickers) : Promise.resolve([] as NewsItem[]),
  ]);
  // Staleness guard (fail closed): drop any quote older than max_quote_age_sec
  // relative to the tick clock. Dropped quotes fall through the existing "no
  // quote" skip, so the executor never trades on a stale book — this is what
  // makes the free IEX feed SAFE to run in the deep off-hours it cannot see.
  const { fresh, stale } = partitionFreshQuotes(quotes, now.getTime(), gate.maxQuoteAgeSec);
  if (stale > 0) {
    appendAudit({
      kind: 'tick',
      data: { stage: 'stale_quotes', session, dropped: stale, feed: cfg.data_feed },
    });
  }
  const quoteByTicker = new Map(fresh.map((q) => [q.ticker.toUpperCase(), q]));
  const generatedAtMs = new Date(thesis.generatedAt).getTime();
  const freshNews = allNews.filter((n) => new Date(n.created_at).getTime() > generatedAtMs);
  const headlinesFor = (ticker: string): NewsItem[] =>
    freshNews.filter((n) => n.symbols.some((s) => s.toUpperCase() === ticker.toUpperCase()));

  const openOrders = [...initialOpenOrders];
  const riskContext = (): RiskContext => ({
    config: cfg,
    account,
    openOrders,
    deployedTodayUsd,
    dailyPl,
    halted: halt.halted,
    riskOffFreeze,
  });

  const summary = {
    stage: 'tick_summary',
    session,
    thesisDate: thesis.date,
    halted: halt.halted,
    dailyPl,
    exitsPlaced: 0,
    entriesPlaced: 0,
    rejected: 0,
    skips: [] as { ticker: string; reason: string }[],
    deployedTodayUsd,
  };
  const skip = (ticker: string, reason: string): void => {
    summary.skips.push({ ticker, reason });
    appendAudit({ kind: 'tick', data: { stage: 'skip', ticker, reason } });
  };

  // Exit entries: active thesis first, then the most recent thesis file
  // (expiry ignored) so positions opened on an expired thesis stay monitored.
  const exitEntryFor = (ticker: string) => {
    const active = thesis.entries.find((e) => e.ticker.toUpperCase() === ticker);
    if (active) return active;
    // A held position may have been opened under either thesis kind (e.g. an
    // RTH entry now monitored after-hours), so search both.
    for (const ymd of [todayYmd, yesterdayYmd]) {
      for (const kind of ['offhours', 'rth'] as const) {
        const past = loadThesisFile(ymd, kind);
        const entry = past?.entries.find((e) => e.ticker.toUpperCase() === ticker);
        if (entry) return entry;
      }
    }
    return undefined;
  };

  // Exits first: closing risk takes precedence over opening it.
  for (const position of account.positions) {
    const ticker = position.ticker.toUpperCase();
    const entry = exitEntryFor(ticker);
    const quote = quoteByTicker.get(ticker);
    // The hard per-position stop applies to EVERY open position — a loss limit
    // is risk management, not a judgment call. A position with no thesis entry
    // (e.g. a seeded starter basket) is still stop-protected; it just cannot be
    // judged (no invalidation conditions), so only the deterministic stop runs.
    if (!quote) {
      if (entry) {
        skip(ticker, 'no quote for exit check');
        // Operator visibility: an exit-worthy position the market has gone
        // dark on (e.g. off-hours with no SIP print). Triggers re-evaluate on
        // the next tick that has a fresh quote.
        appendAudit({ kind: 'tick', data: { stage: 'exit_starved', ticker, session } });
      } else {
        appendAudit({
          kind: 'tick',
          data: { stage: 'orphan_position', ticker, note: 'no quote; stop-only monitoring' },
        });
      }
      continue;
    }
    const isLong = position.side === 'long';
    const mark = isLong ? quote.bid : quote.ask;
    let exitReasons: string[] | null = null;
    let trigger: string | undefined;
    if (cfg.exit_engine.enabled) {
      // Deterministic engine first (orphans run a stop-only plan — no thesis
      // horizon, no judge: today's protection exactly). The judge is a
      // qualitative overlay consulted only when the engine abstains.
      const plan = entry ? resolveExitPlan(entry, cfg) : resolveExitPlan(undefined, cfg);
      const peak = trackPositionPeak(ticker, position.side, mark, now.getTime());
      const decision = evaluateExit({
        direction: position.side,
        entryPrice: position.avgEntryPrice,
        entryTimeMs: peak.entryTimeMs,
        markPrice: mark,
        peakFavorablePrice: peak.peak,
        nowMs: now.getTime(),
        plan,
      });
      if (decision.exit) {
        exitReasons = [decision.reason ?? decision.trigger ?? 'exit'];
        trigger = decision.trigger;
      } else if (entry) {
        const judged = await judgeTick(
          cfg,
          { entry, quote, headlines: headlinesFor(ticker), position },
          deps.llm,
        );
        if (judged.exitPosition) {
          exitReasons = judged.reasons;
          trigger = 'judge';
        }
      } else {
        appendAudit({
          kind: 'tick',
          data: { stage: 'orphan_position', ticker, note: 'stop-only monitoring; no thesis entry to judge' },
        });
        continue;
      }
    } else {
      // Legacy path (exit_engine.enabled=false): static stop + judge,
      // byte-identical to the pre-engine executor. Kept for the paired
      // backtest counterfactual (trial exit-engine-v1).
      const lossPct = positionLossPct(position, quote);
      const stopHit = lossPct >= cfg.max_position_loss_pct;
      if (stopHit) {
        exitReasons = [
          `stop: unrealized loss ${lossPct.toFixed(1)}% >= max_position_loss_pct ${cfg.max_position_loss_pct}%`,
        ];
        trigger = 'hard_stop';
      } else if (entry) {
        const decision = await judgeTick(
          cfg,
          { entry, quote, headlines: headlinesFor(ticker), position },
          deps.llm,
        );
        if (decision.exitPosition) {
          exitReasons = decision.reasons;
          trigger = 'judge';
        }
      } else {
        appendAudit({
          kind: 'tick',
          data: { stage: 'orphan_position', ticker, note: 'stop-only monitoring; no thesis entry to judge' },
        });
        continue;
      }
    }
    if (!exitReasons) continue;
    appendAudit({
      kind: 'exit',
      data: { ticker, reasons: exitReasons, trigger, stop: trigger === 'hard_stop', orphan: !entry },
    });
    // Cancel any resting order for this ticker first — notably an RTH stop-loss
    // leg — so the exit doesn't race a still-live protective order.
    await broker.cancelOrdersFor(ticker);
    const order: ProposedOrder = {
      ticker: position.ticker,
      side: isLong ? 'sell' : 'buy',
      qty: Math.abs(position.qty),
      // marketable exit limit, cent-rounded toward the passive side
      limitPrice: isLong
        ? Math.floor(quote.bid * 100) / 100
        : Math.ceil(quote.ask * 100) / 100,
      intent: 'exit',
      reason: exitReasons.join('; ') || 'invalidation triggered',
      extendedHours,
    };
    appendAudit({ kind: 'proposed_order', data: order });
    const risk = riskCheck(order, riskContext());
    if (risk.allowed) {
      const placed = await broker.placeLimitOrder(order);
      openOrders.push(placed);
      appendAudit({ kind: 'order_placed', data: placed });
      summary.exitsPlaced++;
    } else {
      appendAudit({ kind: 'order_rejected', data: { order, reasons: risk.reasons } });
      summary.rejected++;
    }
  }

  // Trailing state hygiene: drop peak records for names no longer held. Gated
  // on the engine flag so the flag-off path writes no new artifact.
  if (cfg.exit_engine.enabled) {
    prunePositionPeaks(account.positions.map((p) => p.ticker.toUpperCase()));
  }

  // Entries-only timing blackout (feed-independent wall-clock gate). Exits
  // already ran above and are never subject to this. A blocked window skips
  // ALL new entries this tick, leaving open positions monitored.
  const entryMinutes = nowET(now).minutes;
  const entriesAllowedByTiming = entryTimingAllowed(session, entryMinutes, cfg);
  if (!entriesAllowedByTiming && thesis.entries.length > 0) {
    appendAudit({
      kind: 'tick',
      data: {
        stage: 'entry_blackout',
        session,
        minutes: entryMinutes,
        action: 'skip_entries',
        count: thesis.entries.length,
      },
    });
  }

  // Scheduled-event blackout (entries only, like the timing blackout above).
  // A thesis formed at 17:00 yesterday knows nothing about this morning's
  // print; the deterministic calendar keeps the executor from opening risk
  // into a known binary event. Exits above already ran ungated.
  const eventBlock = activeEventBlackout(nowET(now), cfg);
  if (eventBlock && entriesAllowedByTiming && thesis.entries.length > 0) {
    appendAudit({
      kind: 'tick',
      data: {
        stage: 'event_blackout',
        session,
        label: eventBlock.label,
        eventHm: eventBlock.hm,
        action: 'skip_entries',
        count: thesis.entries.length,
      },
    });
  }

  for (const entry of thesis.entries) {
    if (!entriesAllowedByTiming || eventBlock) break; // timing/event blackout: no new entries this tick
    const ticker = entry.ticker.toUpperCase();
    if (account.positions.some((p) => p.ticker.toUpperCase() === ticker)) {
      skip(ticker, 'position exists');
      continue;
    }
    if (openOrders.some((o) => o.ticker.toUpperCase() === ticker)) {
      skip(ticker, 'open order exists');
      continue;
    }
    const quote = quoteByTicker.get(ticker);
    if (!quote) {
      skip(ticker, 'no quote');
      continue;
    }
    const mid = (quote.ask + quote.bid) / 2;
    const spreadBps = mid > 0 ? ((quote.ask - quote.bid) / mid) * 10000 : Infinity;
    if (spreadBps > gate.maxSpreadBps) {
      skip(ticker, `spread ${Math.round(spreadBps)} bps exceeds ${Math.round(gate.maxSpreadBps)} bps gate`);
      continue;
    }
    if (quote.bidSize < gate.minTopSize || quote.askSize < gate.minTopSize) {
      skip(ticker, 'insufficient quote size');
      continue;
    }
    if (quote.last < entry.limitBand.low || quote.last > entry.limitBand.high) {
      skip(ticker, 'last price outside limit band');
      continue;
    }
    // Live short/borrow gate (ports backtest checkShortable). Runs before the
    // judge so an ineligible short never costs an LLM call. Fails closed.
    if (entry.direction === 'short' && cfg.execution.short_borrow_gate.enabled) {
      const assetInfo = await broker.getAsset(ticker);
      const elig = shortEligibility(assetInfo, cfg.execution.short_borrow_gate.require_easy_to_borrow);
      if (!elig.ok) {
        skip(ticker, elig.reason);
        continue;
      }
    }
    const decision = await judgeTick(cfg, { entry, quote, headlines: headlinesFor(ticker) }, deps.llm);
    if (!decision.proceed) {
      skip(ticker, `judge declined: ${decision.reasons.join('; ') || 'no reason given'}`);
      continue;
    }
    const limitPrice = entryLimitPrice(
      entry.direction,
      quote,
      entry.limitBand,
      cfg.execution.entry_aggressiveness,
    );
    // Down-only execution + book scalars on the notional (all default to 1):
    // cost scalar (live spread), drawdown throttle (book), then a participation
    // cap on qty vs displayed take-side size.
    const adjustedNotional =
      entry.targetNotionalUsd * costScalar(spreadBps, cfg.execution.cost_scalar) * ddThrottle;
    const takeSize = entry.direction === 'long' ? quote.askSize : quote.bidSize;
    const qty = participationQty(
      Math.floor(adjustedNotional / limitPrice),
      takeSize,
      cfg.execution.participation,
    );
    if (qty < 1) {
      skip(ticker, 'target notional below one share');
      continue;
    }
    // Regular-session entries carry a native broker stop-loss (Alpaca executes
    // stops in RTH but not extended hours). Long: stop below entry; short: above.
    // The leg uses the entry's RESOLVED hard stop so the resting broker stop and
    // the tick check agree (falls back to max_position_loss_pct when bare).
    const entryHardStopPct = resolveExitPlan(entry, cfg).hardStopPct;
    const stopLoss =
      session === 'rth'
        ? entry.direction === 'long'
          ? Math.round(limitPrice * (1 - entryHardStopPct / 100) * 100) / 100
          : Math.round(limitPrice * (1 + entryHardStopPct / 100) * 100) / 100
        : undefined;
    const order: ProposedOrder = {
      ticker: entry.ticker,
      side: entry.direction === 'long' ? 'buy' : 'sell',
      qty,
      limitPrice,
      intent: 'entry',
      reason: decision.reasons.join('; ') || 'thesis entry conditions hold',
      extendedHours,
      ...(stopLoss !== undefined ? { stopLoss } : {}),
    };
    appendAudit({ kind: 'proposed_order', data: order });
    const risk = riskCheck(order, riskContext());
    if (risk.allowed) {
      const placed = await broker.placeLimitOrder(order);
      openOrders.push(placed);
      // every entry consumes the daily budget, shorts included
      deployedTodayUsd += qty * limitPrice;
      appendAudit({ kind: 'order_placed', data: placed });
      summary.entriesPlaced++;
    } else {
      appendAudit({ kind: 'order_rejected', data: { order, reasons: risk.reasons } });
      summary.rejected++;
    }
  }

  summary.deployedTodayUsd = deployedTodayUsd;
  appendAudit({ kind: 'tick', data: summary });
}

const LOCK_STALE_MS = 10 * 60 * 1000;

/**
 * Cross-process mutual exclusion: a cron tick and an API-triggered tick must
 * never run concurrently (duplicate orders, daily-deploy races). Returns a
 * release function, or null when another live executor holds the lock.
 */
export function acquireTickLock(lockPath: string = path.join(OUT_DIR, 'executor.lock')): (() => void) | null {
  ensureOut();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      fs.closeSync(fd);
      return () => fs.rmSync(lockPath, { force: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      let stale = false;
      try {
        const holder = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as { pid?: number; at?: string };
        const age = Date.now() - new Date(holder.at ?? 0).getTime();
        if (age > LOCK_STALE_MS) stale = true;
        else if (holder.pid) {
          try {
            process.kill(holder.pid, 0);
          } catch {
            stale = true; // holder process is gone
          }
        }
      } catch {
        stale = true; // unreadable lock file
      }
      if (!stale) return null;
      fs.rmSync(lockPath, { force: true });
    }
  }
  return null;
}

export async function main(): Promise<void> {
  const release = acquireTickLock();
  if (!release) {
    appendAudit({
      kind: 'tick',
      data: { stage: 'lock_gate', action: 'skip', reason: 'another executor tick is running' },
    });
    return;
  }
  try {
    await runTick();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`executor tick failed: ${message}`);
    try {
      appendAudit({ kind: 'error', data: { stage: 'executor_tick', message } });
    } catch {
      // audit failure must not mask the original error
    }
    process.exitCode = 1;
  } finally {
    release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
