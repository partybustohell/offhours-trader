import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ProposedOrder, QuoteSnapshot, Thesis } from './types.js';
import type { Config } from './config.js';
import { loadConfig } from './config.js';
import { currentSession, nowET, sessionEnabled } from './clock.js';
import { appendAudit } from './audit.js';
import { ensureOut, OUT_DIR, readJsonIfExists, thesisPath } from './paths.js';
import { readHaltState, writeHalt } from './state.js';
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
function loadThesisFile(ymd: string): Thesis | null {
  let raw: Thesis | null;
  try {
    raw = readJsonIfExists<Thesis>(thesisPath(ymd));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    appendAudit({ kind: 'error', data: { stage: 'thesis_load', file: thesisPath(ymd), message } });
    throw new Error(`malformed thesis file ${thesisPath(ymd)}: ${message}`);
  }
  if (!raw) return null;
  if (
    !Array.isArray(raw.entries) ||
    typeof raw.expiresAt !== 'string' ||
    typeof raw.generatedAt !== 'string'
  ) {
    appendAudit({ kind: 'error', data: { stage: 'thesis_load', file: thesisPath(ymd) } });
    throw new Error(`malformed thesis file ${thesisPath(ymd)}: invalid shape`);
  }
  return raw;
}

function loadUnexpiredThesis(ymd: string, now: Date): Thesis | null {
  const raw = loadThesisFile(ymd);
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
): number {
  return direction === 'long'
    ? Math.floor(Math.min(quote.ask, band.high) * 100) / 100
    : Math.ceil(Math.max(quote.bid, band.low) * 100) / 100;
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

  const todayYmd = nowET(now).ymd;
  const yesterdayYmd = nowET(new Date(now.getTime() - DAY_MS)).ymd;
  const thesis = loadUnexpiredThesis(todayYmd, now) ?? loadUnexpiredThesis(yesterdayYmd, now);
  if (!thesis) {
    appendAudit({ kind: 'tick', data: { stage: 'no_thesis', session, action: 'skip' } });
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
  const { fresh, stale } = partitionFreshQuotes(quotes, now.getTime(), cfg.max_quote_age_sec);
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
    for (const ymd of [todayYmd, yesterdayYmd]) {
      const past = loadThesisFile(ymd);
      const entry = past?.entries.find((e) => e.ticker.toUpperCase() === ticker);
      if (entry) return entry;
    }
    return undefined;
  };

  // Exits first: closing risk takes precedence over opening it.
  for (const position of account.positions) {
    const ticker = position.ticker.toUpperCase();
    const entry = exitEntryFor(ticker);
    if (!entry) {
      appendAudit({
        kind: 'tick',
        data: { stage: 'orphan_position', ticker, note: 'no thesis entry found; not monitored' },
      });
      continue;
    }
    const quote = quoteByTicker.get(ticker);
    if (!quote) {
      skip(ticker, 'no quote for exit check');
      continue;
    }
    const isLong = position.side === 'long';
    // Deterministic per-position stop, evaluated BEFORE the judge: a hard
    // loss limit is risk management, not a judgment call. A stopped position
    // skips the LLM entirely.
    const mark = isLong ? quote.bid : quote.ask;
    const lossPct =
      position.avgEntryPrice > 0
        ? (isLong
            ? (position.avgEntryPrice - mark) / position.avgEntryPrice
            : (mark - position.avgEntryPrice) / position.avgEntryPrice) * 100
        : 0;
    const stopHit = lossPct >= cfg.max_position_loss_pct;

    let exitReasons: string[] | null = null;
    if (stopHit) {
      exitReasons = [
        `stop: unrealized loss ${lossPct.toFixed(1)}% >= max_position_loss_pct ${cfg.max_position_loss_pct}%`,
      ];
    } else {
      const decision = await judgeTick(
        cfg,
        { entry, quote, headlines: headlinesFor(ticker), position },
        deps.llm,
      );
      if (decision.exitPosition) exitReasons = decision.reasons;
    }
    if (!exitReasons) continue;
    appendAudit({ kind: 'exit', data: { ticker, reasons: exitReasons, stop: stopHit } });
    const order: ProposedOrder = {
      ticker: entry.ticker,
      side: isLong ? 'sell' : 'buy',
      qty: Math.abs(position.qty),
      // marketable exit limit, cent-rounded toward the passive side
      limitPrice: isLong
        ? Math.floor(quote.bid * 100) / 100
        : Math.ceil(quote.ask * 100) / 100,
      intent: 'exit',
      reason: exitReasons.join('; ') || 'invalidation triggered',
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

  for (const entry of thesis.entries) {
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
    if (spreadBps > cfg.max_spread_bps) {
      skip(ticker, `spread ${Math.round(spreadBps)} bps exceeds max_spread_bps`);
      continue;
    }
    if (quote.bidSize < 1 || quote.askSize < 1) {
      skip(ticker, 'insufficient quote size');
      continue;
    }
    if (quote.last < entry.limitBand.low || quote.last > entry.limitBand.high) {
      skip(ticker, 'last price outside limit band');
      continue;
    }
    const decision = await judgeTick(cfg, { entry, quote, headlines: headlinesFor(ticker) }, deps.llm);
    if (!decision.proceed) {
      skip(ticker, `judge declined: ${decision.reasons.join('; ') || 'no reason given'}`);
      continue;
    }
    const limitPrice = entryLimitPrice(entry.direction, quote, entry.limitBand);
    const qty = Math.floor(entry.targetNotionalUsd / limitPrice);
    if (qty < 1) {
      skip(ticker, 'target notional below one share');
      continue;
    }
    const order: ProposedOrder = {
      ticker: entry.ticker,
      side: entry.direction === 'long' ? 'buy' : 'sell',
      qty,
      limitPrice,
      intent: 'entry',
      reason: decision.reasons.join('; ') || 'thesis entry conditions hold',
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
