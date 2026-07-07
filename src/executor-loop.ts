import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import type { ProposedOrder, QuoteSnapshot, Thesis } from './types.js';
import type { Config } from './config.js';
import { loadConfig } from './config.js';
import { currentSession, nowET, sessionEnabled } from './clock.js';
import { appendAudit } from './audit.js';
import { readJsonIfExists, thesisPath } from './paths.js';
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

function loadUnexpiredThesis(ymd: string, now: Date): Thesis | null {
  const raw = readJsonIfExists<Thesis>(thesisPath(ymd));
  if (!raw) return null;
  if (
    !Array.isArray(raw.entries) ||
    typeof raw.expiresAt !== 'string' ||
    typeof raw.generatedAt !== 'string'
  ) {
    // malformed thesis file: refuse to trade on it, log, keep looking
    appendAudit({ kind: 'error', data: { stage: 'thesis_load', file: thesisPath(ymd) } });
    return null;
  }
  const expires = new Date(raw.expiresAt).getTime();
  if (!Number.isFinite(expires) || expires <= now.getTime()) return null;
  return raw;
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
  const md = deps.marketData ?? new AlpacaMarketData();

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

  let deployedTodayUsd = todayOrders
    .filter((o) => o.side === 'buy' && o.status !== 'canceled')
    .reduce((sum, o) => sum + o.qty * o.limitPrice, 0);

  const tickers = thesis.entries.map((e) => e.ticker);
  const [quotes, allNews] = await Promise.all([
    tickers.length > 0 ? md.getLatestQuotes(tickers) : Promise.resolve([] as QuoteSnapshot[]),
    tickers.length > 0 ? md.getNews(50, tickers) : Promise.resolve([] as NewsItem[]),
  ]);
  const quoteByTicker = new Map(quotes.map((q) => [q.ticker.toUpperCase(), q]));
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

  // Exits first: closing risk takes precedence over opening it.
  for (const entry of thesis.entries) {
    const ticker = entry.ticker.toUpperCase();
    const position = account.positions.find((p) => p.ticker.toUpperCase() === ticker);
    if (!position) continue;
    const quote = quoteByTicker.get(ticker);
    if (!quote) {
      skip(ticker, 'no quote for exit check');
      continue;
    }
    const decision = await judgeTick(
      cfg,
      { entry, quote, headlines: headlinesFor(ticker), position },
      deps.llm,
    );
    if (!decision.exitPosition) continue;
    appendAudit({ kind: 'exit', data: { ticker, reasons: decision.reasons } });
    const isLong = position.side === 'long';
    const order: ProposedOrder = {
      ticker: entry.ticker,
      side: isLong ? 'sell' : 'buy',
      qty: Math.abs(position.qty),
      limitPrice: isLong ? quote.bid : quote.ask,
      intent: 'exit',
      reason: decision.reasons.join('; ') || 'invalidation triggered',
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
    const limitPrice =
      entry.direction === 'long'
        ? Math.min(quote.ask, entry.limitBand.high)
        : Math.max(quote.bid, entry.limitBand.low);
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
      // keep the in-tick deploy total consistent with getTodayOrders()
      if (order.side === 'buy') deployedTodayUsd += qty * limitPrice;
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

export async function main(): Promise<void> {
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
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
