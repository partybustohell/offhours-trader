import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ExitPlan, ProposedOrder, QuoteSnapshot, Thesis, ThesisEntry, ThesisKind } from './types.js';
import type { Config } from './config.js';
import { loadConfig } from './config.js';
import { currentSession, nowET, sessionEnabled } from './clock.js';
import { activeEventBlackout, entryTimingAllowed, sessionGate } from './session-risk.js';
import { costScalar, drawdownThrottle, participationQty, riskOffTriggered } from './signals.js';
import { appendAudit } from './audit.js';
import { evaluateExit, resolveExitPlan } from './exits.js';
import { desiredProtectiveStop, planStopAction } from './trailing-stop.js';
import { ensureOut, OUT_DIR, readJsonIfExists, thesisPath } from './paths.js';
import { prunePositionPeaks, readHaltState, setTargetScaledOut, setTrailPending, trackPositionPeak, updatePeakEquity, writeHalt } from './state.js';
import { riskCheck, type RiskContext } from './risk.js';
import type { BrokerClient } from './broker/client.js';
import { AlpacaBroker } from './broker/client.js';
import { AlpacaMarketData, type NewsItem } from './broker/marketdata.js';
import { earningsWithin, isReportPast, loadEarningsCalendar, ymdRange, type EarningsByDate } from './broker/earnings.js';
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

// Thesis files are date-keyed, so validity must be decided by EXPIRY, not by
// how far back the filename sits: a Friday evening thesis expires Monday
// 20:00 ET and must still be found on Monday premarket (previously the lookup
// stopped at yesterday, silently skipping the whole tick — including exit
// monitoring — every Monday premarket and after any holiday or pipeline
// outage). 7 days covers weekends + holiday clusters; expired files are
// rejected by loadUnexpiredThesis regardless.
const THESIS_LOOKBACK_DAYS = 7;

export function findLatestUnexpiredThesis(now: Date, kind: ThesisKind): Thesis | null {
  for (let back = 0; back <= THESIS_LOOKBACK_DAYS; back++) {
    const ymd = nowET(new Date(now.getTime() - back * DAY_MS)).ymd;
    const thesis = loadUnexpiredThesis(ymd, now, kind);
    if (thesis) return thesis;
  }
  return null;
}

// How far back exitEntryFor searches for the thesis entry a HELD position was
// opened under. Must exceed the longest horizon time-stop (weeks = 120h ≈ 5
// trading days) plus weekend/holiday slack, or entry-carried invalidation /
// target / time-stop levels silently degrade to orphan stop-only handling.
const EXIT_ENTRY_LOOKBACK_DAYS = 14;

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

  // Own-earnings guard data (execution.earnings_guard): scheduled reports for
  // [today .. today+block_days_ahead]. Disk-cached with a 12h TTL so most
  // ticks never touch the network; a degraded fetch fails OPEN (entries admit,
  // audited) like the risk_off SPY fetch — core risk gates still apply.
  let earningsDays: EarningsByDate = {};
  let earningsYmds: string[] = [];
  if (cfg.execution.earnings_guard.enabled) {
    earningsYmds = ymdRange(now, cfg.execution.earnings_guard.block_days_ahead);
    const calendar = await loadEarningsCalendar(cfg.execution.earnings_guard.block_days_ahead, now);
    earningsDays = calendar.days;
    if (calendar.degraded.length > 0) {
      appendAudit({
        kind: 'tick',
        data: {
          stage: 'earnings_calendar_degraded',
          dates: calendar.degraded,
          note: 'own-earnings guard fails open for those dates',
        },
      });
    }
  }

  // The regular session trades its own same-morning thesis; pre/after-market
  // trade the newest unexpired evening thesis (Friday's carries to Monday).
  const thesisKind: ThesisKind = session === 'rth' ? 'rth' : 'offhours';
  const extendedHours = session !== 'rth';
  const thesis = findLatestUnexpiredThesis(now, thesisKind);
  if (!thesis) {
    // No tradable thesis means no ENTRIES — but open positions must stay
    // monitored. Exits, the hard stop, and the stop ratchet all run below;
    // only the entry loop is starved (activeEntries is empty).
    appendAudit({
      kind: 'tick',
      data: { stage: 'no_thesis', session, thesisKind, action: 'exits_only' },
    });
  }
  const activeEntries = thesis?.entries ?? [];

  let deployedTodayUsd = seedDeployedTodayUsd(todayOrders);

  // Re-entry cooldown source: any exit-intent order today, or any FILLED stop
  // (the ratchet's GTC stop or an OTO entry leg — matched by type because legs
  // carry broker-generated client ids). Derived from broker order history each
  // tick, so it is stateless and crash-safe.
  const exitedTodayTickers = new Set(
    todayOrders
      .filter(
        (o) =>
          o.clientOrderId?.startsWith('exit-') ||
          ((o.type === 'stop' || o.type === 'stop_limit') && (o.filledQty ?? 0) > 0),
      )
      .map((o) => o.ticker.toUpperCase()),
  );

  // Quotes for thesis tickers plus every open position, so invalidation
  // monitoring covers positions whose thesis entry has since expired.
  const tickers = [
    ...new Set([
      ...activeEntries.map((e) => e.ticker.toUpperCase()),
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
  // Headlines are cut per consumer: entries use the ACTIVE thesis's generation
  // time; exit judging uses the generation time of the thesis the position was
  // actually opened under (which may be days older — see exitEntryFor).
  const headlinesFor = (ticker: string, sinceMs: number): NewsItem[] =>
    allNews.filter(
      (n) =>
        new Date(n.created_at).getTime() > sinceMs &&
        n.symbols.some((s) => s.toUpperCase() === ticker.toUpperCase()),
    );
  const activeThesisGeneratedMs = thesis ? new Date(thesis.generatedAt).getTime() : now.getTime();

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
    thesisDate: thesis?.date ?? null,
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

  // Exit entries: active thesis first, then walk back through recent thesis
  // files (expiry ignored — a held position keeps its committed exit plan for
  // as long as it is held, up to the lookback) so entry-carried invalidation /
  // target / time-stop levels survive past two calendar days and a 'weeks'
  // horizon time stop can actually fire. A held position may have been opened
  // under either thesis kind (e.g. an RTH entry now monitored after-hours), so
  // both are searched. A corrupt PAST file is skipped (audited inside
  // loadThesisFile): exit monitoring degrades to stop-only rather than dying
  // on history — only the ACTIVE thesis load keeps the abort-the-tick posture.
  const thesisFileMemo = new Map<string, Thesis | null>();
  const loadPastThesis = (ymd: string, kind: ThesisKind): Thesis | null => {
    const key = `${ymd}|${kind}`;
    const hit = thesisFileMemo.get(key);
    if (hit !== undefined) return hit;
    let past: Thesis | null;
    try {
      past = loadThesisFile(ymd, kind);
    } catch {
      past = null;
    }
    thesisFileMemo.set(key, past);
    return past;
  };
  const exitEntryFor = (
    ticker: string,
  ): { entry: ThesisEntry; generatedAtMs: number } | undefined => {
    const active = thesis?.entries.find((e) => e.ticker.toUpperCase() === ticker);
    if (thesis && active) {
      return { entry: active, generatedAtMs: new Date(thesis.generatedAt).getTime() };
    }
    for (let back = 0; back <= EXIT_ENTRY_LOOKBACK_DAYS; back++) {
      const ymd = nowET(new Date(now.getTime() - back * DAY_MS)).ymd;
      for (const kind of ['offhours', 'rth'] as const) {
        const past = loadPastThesis(ymd, kind);
        const entry = past?.entries.find((e) => e.ticker.toUpperCase() === ticker);
        if (past && entry) {
          return { entry, generatedAtMs: new Date(past.generatedAt).getTime() };
        }
      }
    }
    return undefined;
  };

  // Tickers whose exit order was placed this tick: the ratchet below must not
  // re-arm a protective stop underneath a live exit (double-fill risk).
  const exitOrderedTickers = new Set<string>();

  // Exits first: closing risk takes precedence over opening it.
  for (const position of account.positions) {
    const ticker = position.ticker.toUpperCase();
    const resolved = exitEntryFor(ticker);
    const entry = resolved?.entry;
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
    // Scale-out: fraction of the position this exit covers (1 = full; only a
    // scale-out target trigger sets < 1).
    let exitFraction = 1;
    // Plan + peak from the engine path, reused below to attach a protective
    // OCO leg to RTH exit orders. Left undefined on the legacy path so it
    // stays byte-identical to the pre-engine executor.
    let stopPlan: ExitPlan | undefined;
    let stopPeak: number | undefined;
    if (cfg.exit_engine.enabled) {
      // Deterministic engine first (orphans run a stop-only plan — no thesis
      // horizon, no judge: today's protection exactly). The judge is a
      // qualitative overlay consulted only when the engine abstains.
      const plan = entry ? resolveExitPlan(entry, cfg) : resolveExitPlan(undefined, cfg);
      const peak = trackPositionPeak(ticker, position.side, mark, now.getTime());
      stopPlan = plan;
      stopPeak = peak.peak;
      let decision = evaluateExit({
        direction: position.side,
        entryPrice: position.avgEntryPrice,
        entryTimeMs: peak.entryTimeMs,
        markPrice: mark,
        peakFavorablePrice: peak.peak,
        nowMs: now.getTime(),
        plan,
        ...(peak.targetScaledOut ? { targetAlreadyScaled: true } : {}),
      });
      // Trail-family debounce (trail retrace + breakeven floor share the
      // 'trail' trigger): require the trigger on confirm_ticks consecutive
      // ticks, counting only ticks whose exit-side displayed size clears
      // min_exit_top_size — one thin off-hours bid flicker must not liquidate
      // a position into itself. hard_stop / invalidation_price / target /
      // time_stop pass through undebounced (risk exits stay immediate).
      // Defaults (1 tick, size 0) reproduce today's behavior exactly.
      if (decision.exit && decision.trigger === 'trail') {
        const dbg = cfg.exit_engine.trail_debounce;
        const exitSideSize = isLong ? quote.bidSize : quote.askSize;
        const sizeOk = dbg.min_exit_top_size <= 0 || exitSideSize >= dbg.min_exit_top_size;
        const count = sizeOk ? (peak.trailPendingCount ?? 0) + 1 : (peak.trailPendingCount ?? 0);
        if (!sizeOk || count < dbg.confirm_ticks) {
          setTrailPending(ticker, count);
          appendAudit({
            kind: 'tick',
            data: {
              stage: 'trail_pending',
              ticker,
              count,
              confirmTicks: dbg.confirm_ticks,
              exitSideSize,
              sizeOk,
              reason: decision.reason,
            },
          });
          decision = { exit: false };
        }
      } else if ((peak.trailPendingCount ?? 0) > 0) {
        // trigger lapsed (or a higher-priority trigger fired): reset the count
        setTrailPending(ticker, 0);
      }
      if (decision.exit) {
        exitReasons = [decision.reason ?? decision.trigger ?? 'exit'];
        trigger = decision.trigger;
        exitFraction = decision.fraction ?? 1;
      } else if (entry && resolved) {
        const judged = await judgeTick(
          cfg,
          { entry, quote, headlines: headlinesFor(ticker, resolved.generatedAtMs), position },
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
      } else if (entry && resolved) {
        const decision = await judgeTick(
          cfg,
          { entry, quote, headlines: headlinesFor(ticker, resolved.generatedAtMs), position },
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
    // Scale-out sizing: a fractional target exit covers part of the position;
    // whole-share flooring can round a tiny position up to a full exit.
    const absQty = Math.abs(position.qty);
    const exitQty =
      exitFraction < 1 ? Math.min(absQty, Math.max(1, Math.floor(absQty * exitFraction))) : absQty;
    const isFullExit = exitQty >= absQty;
    appendAudit({
      kind: 'exit',
      data: {
        ticker,
        reasons: exitReasons,
        trigger,
        stop: trigger === 'hard_stop',
        orphan: !entry,
        ...(isFullExit ? {} : { fraction: exitFraction, qty: exitQty, of: absQty }),
      },
    });
    // Cancel any resting order for this ticker first — notably an RTH stop-loss
    // leg — so the exit doesn't race a still-live protective order.
    await broker.cancelOrdersFor(ticker);
    // Drop the canceled orders from the local view too, or riskCheck rejects
    // the exit as a "duplicate open order" against a stop that no longer exists.
    for (let i = openOrders.length - 1; i >= 0; i--) {
      if (openOrders[i]!.ticker.toUpperCase() === ticker) openOrders.splice(i, 1);
    }
    // marketable exit limit, cent-rounded toward the passive side
    const exitLimit = isLong
      ? Math.floor(quote.bid * 100) / 100
      : Math.ceil(quote.ask * 100) / 100;
    // RTH exits pair the limit with a protective stop (Alpaca OCO) so an
    // unfilled exit limit never leaves the position stop-less until the next
    // tick. Only attached when the stop is still strictly on the protective
    // side of the limit: a triggered hard-stop/trail exit has already crossed
    // its level (a stop there would be instantly invalid), so in practice
    // judge- and target-triggered exits gain the leg. Engine path only;
    // extended-hours stops do not execute, so off-hours exits stay plain.
    let protectiveStop: number | undefined;
    if (session === 'rth' && stopPlan !== undefined && stopPeak !== undefined) {
      const level = desiredProtectiveStop({
        side: position.side,
        entryPrice: position.avgEntryPrice,
        peak: stopPeak,
        plan: stopPlan,
      });
      if (isLong ? level < exitLimit : level > exitLimit) protectiveStop = level;
    }
    const order: ProposedOrder = {
      ticker: position.ticker,
      side: isLong ? 'sell' : 'buy',
      qty: exitQty,
      limitPrice: exitLimit,
      intent: 'exit',
      reason: exitReasons.join('; ') || 'invalidation triggered',
      extendedHours,
      ...(protectiveStop !== undefined ? { protectiveStop } : {}),
    };
    appendAudit({ kind: 'proposed_order', data: order });
    const risk = riskCheck(order, riskContext());
    if (risk.allowed) {
      let placed;
      try {
        placed = await broker.placeLimitOrder(order);
      } catch (err) {
        if (order.protectiveStop === undefined) throw err;
        // OCO rejected (e.g. leg validation): a plain exit beats no exit.
        // Downgrade to exactly what the pre-OCO executor placed and audit.
        appendAudit({
          kind: 'error',
          data: {
            stage: 'oco_exit_fallback',
            ticker,
            message: err instanceof Error ? err.message : String(err),
          },
        });
        const plain: ProposedOrder = { ...order };
        delete plain.protectiveStop;
        placed = await broker.placeLimitOrder(plain);
      }
      openOrders.push(placed);
      appendAudit({ kind: 'order_placed', data: placed });
      summary.exitsPlaced++;
      exitOrderedTickers.add(ticker);
      // A placed partial target exit arms the once-only marker: the target
      // trigger stays silent for the remainder from the next tick on. The
      // remainder is re-covered by the stop ratchet next tick (qty drift).
      if (!isFullExit) setTargetScaledOut(ticker);
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

  // Held-position earnings visibility: a position reporting within 1 day is
  // the largest single overnight-gap exposure on the book. Audit only — exits
  // are never forced here (exit-path changes go through the paired-backtest
  // discipline); the entries-only guard below keeps NEW risk out.
  if (cfg.execution.earnings_guard.enabled) {
    for (const position of account.positions) {
      const ticker = position.ticker.toUpperCase();
      const report = earningsWithin(earningsDays, ticker, earningsYmds, 1);
      if (report && !isReportPast(report, earningsYmds[0]!, nowET(now).minutes)) {
        appendAudit({
          kind: 'tick',
          data: {
            stage: 'earnings_warning',
            ticker,
            reportYmd: report.ymd,
            time: report.time,
            note: 'held position reports within 1 day; operator visibility only',
          },
        });
      }
    }
  }

  // Native protective-stop ratchet: converge each position's resting GTC stop
  // toward the trail floor (hard stop until armed, then breakeven / peak
  // trail). Runs AFTER exits — a risk-rejected exit falls through to here and
  // gets re-protected; a placed exit is skipped above via exitOrderedTickers.
  if (cfg.exit_engine.enabled && cfg.exit_engine.native_stop_ratchet.enabled) {
    for (const position of account.positions) {
      const ticker = position.ticker.toUpperCase();
      if (exitOrderedTickers.has(ticker)) continue;
      const quote = quoteByTicker.get(ticker);
      if (!quote) continue; // no fresh mark; the GTC stop already resting still protects
      const isLong = position.side === 'long';
      const mark = isLong ? quote.bid : quote.ask;
      const entry = exitEntryFor(ticker)?.entry;
      const plan = entry ? resolveExitPlan(entry, cfg) : resolveExitPlan(undefined, cfg);
      // Idempotent within the tick: the exit loop already ratcheted the peak.
      const peak = trackPositionPeak(ticker, position.side, mark, now.getTime());
      const exitSide = isLong ? 'sell' : 'buy';
      const resting = openOrders.find(
        (o) =>
          o.ticker.toUpperCase() === ticker &&
          o.type === 'stop' &&
          o.side === exitSide &&
          o.stopPrice !== undefined &&
          (o.status === 'new' || o.status === 'accepted' || o.status === 'held'),
      );
      const action = planStopAction({
        side: position.side,
        qty: Math.abs(position.qty),
        entryPrice: position.avgEntryPrice,
        peak: peak.peak,
        plan,
        ...(resting
          ? { existing: { id: resting.id, stopPrice: resting.stopPrice!, qty: resting.qty } }
          : {}),
      });
      if (action.action === 'none') continue;
      try {
        if (action.action === 'replace') await broker.cancelOrder(action.cancelId);
        const placedStop = await broker.placeStopOrder({
          ticker: position.ticker,
          side: exitSide,
          qty: action.qty,
          stopPrice: action.stopPrice,
        });
        appendAudit({
          kind: 'stop_ratchet',
          data: {
            ticker,
            action: action.action,
            from: resting?.stopPrice,
            to: action.stopPrice,
            qty: action.qty,
            peak: peak.peak,
            orderId: placedStop.id,
          },
        });
      } catch (err) {
        // Cancel/replace race (stop filled between fetch and cancel) or a
        // rejected placement: audit and reconverge next tick.
        appendAudit({
          kind: 'error',
          data: {
            stage: 'stop_ratchet',
            ticker,
            message: err instanceof Error ? err.message : String(err),
          },
        });
      }
    }
  }

  // Entries-only timing blackout (feed-independent wall-clock gate). Exits
  // already ran above and are never subject to this. A blocked window skips
  // ALL new entries this tick, leaving open positions monitored.
  const entryMinutes = nowET(now).minutes;
  const entriesAllowedByTiming = entryTimingAllowed(session, entryMinutes, cfg);
  if (!entriesAllowedByTiming && activeEntries.length > 0) {
    appendAudit({
      kind: 'tick',
      data: {
        stage: 'entry_blackout',
        session,
        minutes: entryMinutes,
        action: 'skip_entries',
        count: activeEntries.length,
      },
    });
  }

  // Scheduled-event blackout (entries only, like the timing blackout above).
  // A thesis formed at 17:00 yesterday knows nothing about this morning's
  // print; the deterministic calendar keeps the executor from opening risk
  // into a known binary event. Exits above already ran ungated.
  const eventBlock = activeEventBlackout(nowET(now), cfg);
  if (eventBlock && entriesAllowedByTiming && activeEntries.length > 0) {
    appendAudit({
      kind: 'tick',
      data: {
        stage: 'event_blackout',
        session,
        label: eventBlock.label,
        eventHm: eventBlock.hm,
        action: 'skip_entries',
        count: activeEntries.length,
      },
    });
  }

  for (const entry of activeEntries) {
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
    // Stop-out cooldown: a name exited or stopped today is done for the day —
    // the band + judge alone would happily re-buy it 15 minutes after a stop.
    if (
      cfg.entry_cooldown_after_exit &&
      (exitedTodayTickers.has(ticker) || exitOrderedTickers.has(ticker))
    ) {
      skip(ticker, 're-entry cooldown: exited today');
      continue;
    }
    // Own-earnings guard (entries only): never OPEN into a scheduled report.
    // A print that is already OUT does not block — the post-print reaction
    // entry is the registered catalyst play, not binary-event risk.
    if (cfg.execution.earnings_guard.enabled) {
      const report = earningsWithin(
        earningsDays,
        ticker,
        earningsYmds,
        cfg.execution.earnings_guard.block_days_ahead,
      );
      if (report && !isReportPast(report, earningsYmds[0]!, nowET(now).minutes)) {
        skip(ticker, `own-earnings guard: reports ${report.ymd} (${report.time})`);
        continue;
      }
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
    const decision = await judgeTick(
      cfg,
      { entry, quote, headlines: headlinesFor(ticker, activeThesisGeneratedMs) },
      deps.llm,
    );
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
