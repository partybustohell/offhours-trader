// Backtest episode runner (5h protocol Phase B, one episode = one process).
//
// The driver (scripts/backtest.ts) spawns this script once per episode with
// cwd = backtest-out/<tag>/<day>/, because src/paths.ts computes OUT_DIR from
// process.cwd() AT IMPORT TIME: the production runTick reads thesis files,
// halt state, and audit paths from that OUT_DIR, so each episode gets its own
// isolated out/ tree simply by being its own process. The integration test
// runs runEpisode() in-process instead, after process.chdir + module reset.
//
// Episode semantics (5h plan):
//   - fresh SimLedger at $50k; thesis for day D assembled from the Phase A
//     prep file through the REAL computeThesisEntries -> writeNarratives ->
//     production merge (pipeline.ts entry assembly), expiry via the REAL
//     thesisExpiry, written via the REAL thesisPath.
//   - sim clock walks D 17:00 ET -> D+1 20:00 ET in 15-minute steps. Each
//     step: advance fills from completed SIP minute bars, then gate with the
//     REAL currentSession/sessionEnabled and call the REAL runTick with the
//     ledger injected as broker + marketdata facade and a canonical-caching
//     judge LLM client.
//   - episode boundary correction: at sim D+1 17:05 a synthetic EMPTY D+1
//     thesis (real thesisPath/thesisExpiry) is written, so day D's thesis
//     stops taking new entries exactly as in production while open positions
//     stay judge-monitored through the force-flatten (the executor's
//     expiry-ignoring yesterday-file lookup).
//   - --rth-thesis (args.rthThesis): simulate the SECOND production pipeline
//     (scripts/install-schedule.sh, 09:00 ET `pnpm pipeline rth`). At sim
//     D+1 09:00 a kind='rth' thesis for D+1 is assembled through the same
//     production entry-assembly path from the SAME cached day-D prep verdicts
//     and written to thesis-<D+1>-rth.json with the REAL rthThesisExpiry
//     (D+1 16:00 ET), so D+1 RTH ticks — which consume ONLY a kind='rth'
//     thesis (src/executor-loop.ts) — can place entries. Without this flag an
//     RTH-only config structurally places 0 orders (the parity-rth-iex
//     finding, docs/backtest-2026-01-01..07-01-REPORT.md R3.3).
//     INFORMATION-SET APPROXIMATION (documented in the report): production's
//     09:00 run re-runs the whole Phase A — fresh morning scans, nominations,
//     verdicts — and sees overnight news (D 17:00 -> D+1 09:00). Reusing the
//     D 17:00 verdict set keeps backtest LLM cost at zero but gives the
//     morning thesis only evening information (possibly different tickers
//     and convictions than production would pick). Daily-bar features and
//     regime are as-of-D closes, which IS the latest complete bar set at
//     D+1 09:00, so those inputs are exact. Fidelity gap: production RTH
//     entries carry a native broker stop-loss leg; the sim has no resting-stop
//     engine, so runTick's per-tick deterministic stop check stands in for it
//     (fires at most one 15-minute tick late).
//   - force-flatten at D+1 20:00; EpisodeResult (metrics.ts shape) written.
//
// The borrow hard gate (plan §4): short entries on non-easy_to_borrow
// symbols are removed from the thesis at write time and recorded as
// rejection reason 'not shortable' (reported like risk-gate rejections),
// since production placeLimitOrder does not gate borrow.
//
// Order placement passes through a facade that independently re-runs the
// REAL riskCheck (with deployedTodayUsd seeded by the REAL
// seedDeployedTodayUsd) and registers the approval with the ledger; the
// ledger aborts on any order placed without a passing approval, so a
// riskCheck divergence is an invariant violation, never a silent fill.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import type { AccountSnapshot, AuditEvent, ProposedOrder, Thesis, ThesisEntry } from '../src/types.js';
import { ConfigSchema, type Config } from '../src/config.js';
import { currentSession, sessionEnabled } from '../src/clock.js';
import { OUT_DIR, thesisPath, writeJsonAtomic } from '../src/paths.js';
import { clearHalt as clearHaltState, readHaltState } from '../src/state.js';
import { riskCheck, type RiskContext } from '../src/risk.js';
import { runTick, seedDeployedTodayUsd } from '../src/executor-loop.js';
import { computeThesisEntries, rthThesisExpiry, thesisExpiry } from '../src/synthesis.js';
import { realizedVolAnnualized } from '../src/candidates.js';
import { computeTickerFeatures, dailyReturns } from '../src/signals.js';
import { NEUTRAL_REGIME, computeRegime } from '../src/regime.js';
import { loadDailyBars } from '../src/backtest/data.js';
import { writeNarratives } from '../src/agents/narrative.js';
import type { LlmClient } from '../src/agents/llm.js';
import type { BrokerClient } from '../src/broker/client.js';
import type { NewsItem } from '../src/broker/marketdata.js';
import type { TickerMarketInfo } from '../src/candidates.js';
import type { AnalystNominations, CandidateFile, VerdictFile } from '../src/types.js';
import {
  etOffsetForDate,
  fetchMinuteDay,
  fetchQuotesWindow,
  fetchTradesWindow,
  loadNewsDay,
  loadUniverse,
  minutePath,
  quotesPath,
  readJson,
  tradesPath,
} from '../src/backtest/data.js';
import { etYmdOf } from '../src/backtest/fills.js';
import { SimLedger, type FillEvent, type HaltPolicy } from '../src/backtest/ledger.js';
import { judgeCanonicalKey, makeCachingClient } from '../src/backtest/llm-cache.js';
import type { EpisodeResult, EpisodeTrade } from '../src/backtest/metrics.js';
import type { StoredMinuteBar, StoredQuote, StoredTrade } from '../src/backtest/types.js';

const TICK_MS = 15 * 60_000;
const JUDGE_TOOL = 'submit_execution_decision';

// ---------- shared shapes (the driver imports these types) ----------

/** Per-model token usage observed by a tracking client wrapper. */
export type UsageByModel = Record<
  string,
  { calls: number; input_tokens: number; output_tokens: number }
>;

/** $/MTok price table keyed by model-name prefix (longest prefix wins). */
export type PriceTable = Record<string, { inputPerMtok: number; outputPerMtok: number }>;

/** Phase A artifact written by `backtest.ts precompute`, read here. */
export interface PrepFile {
  day: string;
  stratum: 'R' | 'H';
  scan: { gainers: number; losers: number; actives: number; news: number };
  nominations: { nominations: AnalystNominations[]; dropped: string[] };
  candidates: CandidateFile;
  verdicts: VerdictFile;
  marketInfo: Record<string, TickerMarketInfo>;
  usage: UsageByModel;
}

export interface EpisodeArgs {
  day: string; // thesis day D (YYYY-MM-DD)
  stratum: 'R' | 'H';
  prepFile: string;
  resultFile: string;
  /** Full Config object (validated with ConfigSchema); sweep cells override fields. */
  cfg: unknown;
  haltPolicy: HaltPolicy;
  equityStart?: number; // default 50_000
  cacheDir: string; // LLM disk-cache directory
  /** Disk-only market data (tests/CI): a missing store file is "no data", never a fetch. */
  offline?: boolean;
  /**
   * Sweep budget pass: canonical-cache misses are counted and the call fails
   * (judgeTick degrades to do-nothing); nothing is fetched or persisted.
   */
  countOnly?: boolean;
  /** Where countOnly writes { judgeMisses, otherMisses }. */
  budgetFile?: string;
  /** Optional price table for llmCostUsd; omitted -> cost reported as 0. */
  prices?: PriceTable;
  /**
   * Simulate the 09:00 ET morning pipeline (`pnpm pipeline rth`): at sim
   * D+1 09:00 write a kind='rth' D+1 thesis assembled from the same cached
   * day-D prep verdicts (information-set approximation — see the header
   * comment). Off by default; off-hours-thesis runs are unchanged without it.
   */
  rthThesis?: boolean;
}

export interface EpisodeOverrides {
  /** Test injection: replaces the real Anthropic client under the disk cache. */
  innerLlm?: LlmClient;
}

// ---------- usage tracking / cost ----------

export function trackUsage(inner: LlmClient, usage: UsageByModel): LlmClient {
  return {
    messages: {
      async create(params) {
        const response = await inner.messages.create(params);
        const u = (response as { usage?: { input_tokens?: unknown; output_tokens?: unknown } })
          .usage;
        const rec = (usage[params.model] ??= { calls: 0, input_tokens: 0, output_tokens: 0 });
        rec.calls += 1;
        rec.input_tokens += typeof u?.input_tokens === 'number' ? u.input_tokens : 0;
        rec.output_tokens += typeof u?.output_tokens === 'number' ? u.output_tokens : 0;
        return response;
      },
    },
  };
}

/** Cost of `usage` under `prices` (longest model-name prefix wins); no table -> 0. */
export function costUsd(usage: UsageByModel, prices: PriceTable | undefined): number {
  if (!prices) return 0;
  let total = 0;
  for (const [model, u] of Object.entries(usage)) {
    let best: { inputPerMtok: number; outputPerMtok: number } | undefined;
    let bestLen = -1;
    for (const [prefix, p] of Object.entries(prices)) {
      if (model.startsWith(prefix) && prefix.length > bestLen) {
        best = p;
        bestLen = prefix.length;
      }
    }
    if (!best) continue;
    total += (u.input_tokens / 1e6) * best.inputPerMtok + (u.output_tokens / 1e6) * best.outputPerMtok;
  }
  return total;
}

// ---------- count-only client (sweep fresh-call budget) ----------

function toolNameOf(params: { tool_choice?: unknown; tools?: unknown }): string {
  const choice = params.tool_choice as { type?: string; name?: string } | undefined;
  if (choice && choice.type === 'tool' && typeof choice.name === 'string') return choice.name;
  const first = (params.tools as { name?: string }[] | undefined)?.[0];
  return first && typeof first.name === 'string' ? first.name : '';
}

function countingMissClient(counts: { judge: number; other: number }): LlmClient {
  return {
    messages: {
      async create(params) {
        if (toolNameOf(params) === JUDGE_TOOL) counts.judge += 1;
        else counts.other += 1;
        // Not retryable by callStructured; makeCachingClient persists nothing
        // on a failed inner call, so the budget pass cannot poison the cache.
        throw new Error('count-only: this call would need a fresh LLM request');
      },
    },
  };
}

// ---------- audit tallies (runTick's own log is the source of truth) ----------

interface AuditTallies {
  events: AuditEvent[];
  judgeVetoes: number;
  rejectionsByReason: Record<string, number>;
  exitReasonsByTicker: Map<string, string[][]>;
}

function readAuditTallies(): AuditTallies {
  // appendAudit keys files by WALL-clock date, so read every audit file.
  let files: string[] = [];
  try {
    files = fs
      .readdirSync(OUT_DIR)
      .filter((f) => f.startsWith('audit-') && f.endsWith('.jsonl'))
      .sort();
  } catch {
    files = [];
  }
  const events: AuditEvent[] = [];
  for (const f of files) {
    const raw = fs.readFileSync(path.join(OUT_DIR, f), 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line) as AuditEvent);
      } catch {
        // malformed line: skip
      }
    }
  }
  let judgeVetoes = 0;
  const rejectionsByReason: Record<string, number> = {};
  const exitReasonsByTicker = new Map<string, string[][]>();
  for (const e of events) {
    const data = e.data as Record<string, unknown> | undefined;
    if (e.kind === 'tick' && data?.stage === 'skip' && typeof data.reason === 'string') {
      if (data.reason.startsWith('judge declined')) judgeVetoes += 1;
    }
    if (e.kind === 'order_rejected' && Array.isArray((data as { reasons?: unknown })?.reasons)) {
      for (const reason of (data as { reasons: unknown[] }).reasons) {
        if (typeof reason !== 'string') continue;
        rejectionsByReason[reason] = (rejectionsByReason[reason] ?? 0) + 1;
      }
    }
    if (e.kind === 'exit' && typeof data?.ticker === 'string') {
      const ticker = data.ticker.toUpperCase();
      const reasons = Array.isArray(data.reasons)
        ? (data.reasons as unknown[]).filter((r): r is string => typeof r === 'string')
        : [];
      const queue = exitReasonsByTicker.get(ticker) ?? [];
      queue.push(reasons);
      exitReasonsByTicker.set(ticker, queue);
    }
  }
  return { events, judgeVetoes, rejectionsByReason, exitReasonsByTicker };
}

// ---------- trade assembly ----------

interface OpenLot {
  qty: number;
  entryPrice: number;
  entryFees: number;
  side: 'long' | 'short';
  analystsAgreeing: string[];
}

function buildTrades(
  fills: readonly FillEvent[],
  flattenCloses: readonly { ticker: string; qty: number; price: number; grossRealizedUsd: number; feesUsd: number }[],
  verdicts: VerdictFile,
  exitReasonsByTicker: Map<string, string[][]>,
  borrowTotalUsd: number,
): EpisodeTrade[] {
  const agreeing = (ticker: string, side: 'long' | 'short'): string[] =>
    verdicts.verdicts
      .filter((v) => v.ticker.toUpperCase() === ticker && v.direction === side)
      .map((v) => v.analyst);
  const openLots = new Map<string, OpenLot>();
  const trades: EpisodeTrade[] = [];
  for (const fill of fills) {
    const ticker = fill.ticker.toUpperCase();
    if (fill.intent === 'entry') {
      const side: 'long' | 'short' = fill.side === 'buy' ? 'long' : 'short';
      openLots.set(ticker, {
        qty: fill.qty,
        entryPrice: fill.price,
        entryFees: fill.feesUsd,
        side,
        analystsAgreeing: agreeing(ticker, side),
      });
      continue;
    }
    const lot = openLots.get(ticker);
    const reasons = exitReasonsByTicker.get(ticker)?.shift() ?? [];
    trades.push({
      ticker,
      side: lot?.side ?? (fill.side === 'sell' ? 'long' : 'short'),
      qty: fill.qty,
      entryPrice: lot?.entryPrice ?? 0,
      exitPrice: fill.price,
      feesUsd: (lot?.entryFees ?? 0) + fill.feesUsd,
      borrowUsd: 0, // apportioned below
      pnlUsd: fill.realizedUsd,
      analystsAgreeing: lot?.analystsAgreeing ?? [],
      exitReason: reasons.length > 0 ? `judge exit: ${reasons.join('; ')}` : 'judge exit',
    });
    openLots.delete(ticker);
  }
  for (const close of flattenCloses) {
    const ticker = close.ticker.toUpperCase();
    const lot = openLots.get(ticker);
    trades.push({
      ticker,
      side: lot?.side ?? 'long',
      qty: close.qty,
      entryPrice: lot?.entryPrice ?? 0,
      exitPrice: close.price,
      feesUsd: (lot?.entryFees ?? 0) + close.feesUsd,
      borrowUsd: 0,
      pnlUsd: close.grossRealizedUsd,
      analystsAgreeing: lot?.analystsAgreeing ?? [],
      exitReason: 'force-flatten',
    });
    openLots.delete(ticker);
  }
  // Apportion the ledger's aggregate borrow accrual across short round trips
  // by entry notional (episodes span at most a few midnights; deterministic).
  if (borrowTotalUsd > 0) {
    const shorts = trades.filter((t) => t.side === 'short');
    const totalNotional = shorts.reduce((s, t) => s + t.qty * t.entryPrice, 0);
    for (const t of shorts) {
      t.borrowUsd =
        totalNotional > 0
          ? (borrowTotalUsd * (t.qty * t.entryPrice)) / totalNotional
          : borrowTotalUsd / shorts.length;
    }
  }
  return trades;
}

// ---------- market-data plumbing ----------

function latestQuoteAtOrBefore(rows: StoredQuote[], tMs: number): StoredQuote | undefined {
  let best: StoredQuote | undefined;
  let bestMs = -Infinity;
  for (const row of rows) {
    const ms = Date.parse(row.t);
    if (ms <= tMs && ms > bestMs) {
      best = row;
      bestMs = ms;
    }
  }
  return best;
}

function latestTradeAtOrBefore(rows: StoredTrade[], tMs: number): StoredTrade | undefined {
  let best: StoredTrade | undefined;
  let bestMs = -Infinity;
  for (const row of rows) {
    const ms = Date.parse(row.t);
    if (ms <= tMs && ms > bestMs) {
      best = row;
      bestMs = ms;
    }
  }
  return best;
}

function writeJsonFile(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

// ---------- the episode ----------

export async function runEpisode(
  args: EpisodeArgs,
  overrides: EpisodeOverrides = {},
): Promise<EpisodeResult> {
  const cfg: Config = ConfigSchema.parse(args.cfg);
  const day = args.day;
  const prep = readJson<PrepFile>(args.prepFile);
  if (!prep) throw new Error(`prep file missing: ${args.prepFile}`);

  // Episode clock: D 17:00 ET -> flatten at REAL thesisExpiry(D) = D+1 20:00 ET.
  const flattenIso = thesisExpiry(day);
  const flattenMs = Date.parse(flattenIso);
  const d1 = etYmdOf(flattenIso);
  const startMs = Date.parse(`${day}T17:00:00${etOffsetForDate(day)}`);
  const syntheticAtMs = Date.parse(`${d1}T17:05:00${etOffsetForDate(d1)}`);

  const universe = loadUniverse() ?? [];
  const etb = new Set(
    universe.filter((a) => a.easy_to_borrow).map((a) => a.symbol.toUpperCase()),
  );

  const ledger = new SimLedger({
    equityStart: args.equityStart ?? 50_000,
    easyToBorrow: etb,
    haltPolicy: args.haltPolicy,
  });
  ledger.setNow(new Date(startMs).toISOString());

  // LLM client: canonical judge cache, exact cache for everything else;
  // usage tracked on every response (hit or miss) so cost is deterministic.
  const episodeUsage: UsageByModel = {};
  const missCounts = { judge: 0, other: 0 };
  const inner: LlmClient =
    overrides.innerLlm ?? (args.countOnly ? countingMissClient(missCounts) : new Anthropic());
  const llm = trackUsage(
    makeCachingClient(inner, { canonical: judgeCanonicalKey }, args.cacheDir),
    episodeUsage,
  );

  // ---- thesis assembly: REAL production functions, production merge ----
  // Backfill realized vol from the cached IEX daily bars (prep files predate
  // the vol field). No LLM cost — vol is pure math over stored bars. This is
  // what production's marketInfoFor now computes inline.
  // As-of-D IEX daily bars (never future) drive vol, the P1-P3 signal features,
  // and the per-ticker return series for the whole-book portfolio pass — the
  // same inputs production's pipeline enriches, so signal toggles actually move
  // backtest results (docs/QUANT-TESTING-PLAN.md Stage 1).
  const asOfBars = (ticker: string) =>
    loadDailyBars('iex', ticker).filter((b) => b.t.slice(0, 10) <= day);
  const returnsByTicker = new Map<string, number[]>();
  const marketInfo = new Map<string, TickerMarketInfo>(
    Object.entries(prep.marketInfo).map(([k, v]) => {
      const ticker = k.toUpperCase();
      const bars = asOfBars(ticker);
      const closes = bars.map((b) => b.c);
      if (closes.length >= 2) returnsByTicker.set(ticker, dailyReturns(closes));
      const vol = v.realizedVolAnnualized ?? realizedVolAnnualized(closes.slice(-20));
      return [
        ticker,
        {
          ...v,
          ...(vol !== undefined ? { realizedVolAnnualized: vol } : {}),
          ...computeTickerFeatures(bars, cfg),
        },
      ];
    }),
  );
  // Market regime as-of D from SPY closes (neutral if SPY bars aren't cached).
  const spyCloses = asOfBars('SPY').map((b) => b.c);
  const regime = spyCloses.length > 1 ? computeRegime(spyCloses, cfg.regime) : NEUTRAL_REGIME;
  // Production entry assembly (pipeline.ts): computeThesisEntries at the
  // account of assembly time -> writeNarratives -> narrative merge -> borrow
  // hard gate. Shared by the evening off-hours thesis and (under --rth-thesis)
  // the simulated 09:00 morning thesis — production runs this same path twice
  // a day. Borrow-gate rejections are counted per assembly, so a non-ETB short
  // rejected by both theses counts twice (as production would reject it twice).
  const preRejections: Record<string, number> = {};
  const assembleEntries = async (
    account: AccountSnapshot,
  ): Promise<{
    entries: ThesisEntry[];
    skipped: { ticker: string; reason: string }[];
    computedCount: number;
  }> => {
    const computed = computeThesisEntries(
      prep.verdicts.verdicts,
      marketInfo,
      account,
      cfg,
      regime,
      returnsByTicker,
    );
    const narratives = await writeNarratives(cfg, computed.entries, prep.verdicts.verdicts, llm);
    // pipeline.ts entry assembly: narrative + invalidationConditions override
    // with fallback to the computed conditions.
    const merged: ThesisEntry[] = computed.entries.map((entry) => {
      const n = narratives.get(entry.ticker);
      return {
        ...entry,
        narrative: n?.narrative ?? '',
        invalidationConditions: n?.invalidationConditions ?? entry.invalidationConditions,
      };
    });
    // Borrow hard gate (plan §4): reject short entries on non-ETB symbols here,
    // reported like risk-gate rejections; they never reach the thesis file.
    const entries = merged.filter((entry) => {
      if (entry.direction === 'short' && !ledger.checkShortable(entry.ticker)) {
        preRejections['not shortable'] = (preRejections['not shortable'] ?? 0) + 1;
        return false;
      }
      return true;
    });
    return { entries, skipped: computed.skipped, computedCount: computed.entries.length };
  };

  const assembled = await assembleEntries(await ledger.getAccount());
  const abstained = assembled.computedCount === 0;
  const thesis: Thesis = {
    date: day,
    kind: 'offhours',
    generatedAt: new Date(startMs).toISOString(),
    expiresAt: flattenIso,
    entries: assembled.entries,
    skipped: assembled.skipped,
  };
  writeJsonAtomic(thesisPath(day), thesis);

  // ---- broker facade: REAL riskCheck re-verified at placement ----
  const broker: BrokerClient = {
    getAccount: () => ledger.getAccount(),
    getDailyPl: () => ledger.getDailyPl(),
    getOpenOrders: () => ledger.getOpenOrders(),
    getTodayOrders: () => ledger.getTodayOrders(),
    cancelOrdersFor: (t: string) => ledger.cancelOrdersFor(t),
    getAsset: (t: string) => ledger.getAsset(t),
    placeLimitOrder: async (o: ProposedOrder) => {
      const [acct, openOrders, todayOrders, dailyPl] = await Promise.all([
        ledger.getAccount(),
        ledger.getOpenOrders(),
        ledger.getTodayOrders(),
        ledger.getDailyPl(),
      ]);
      const ctx: RiskContext = {
        config: cfg,
        account: acct,
        openOrders,
        deployedTodayUsd: seedDeployedTodayUsd(todayOrders),
        dailyPl,
        halted: readHaltState().halted,
      };
      if (riskCheck(o, ctx).allowed) ledger.recordRiskApproval(o);
      // an unapproved order aborts inside the ledger (invariant violation)
      return ledger.placeLimitOrder(o);
    },
  };

  // ---- lazy market-data loaders (disk-first; offline never fetches) ----
  const minuteCache = new Map<string, StoredMinuteBar[]>();
  const minuteBars = async (symbol: string, ymd: string): Promise<StoredMinuteBar[]> => {
    const key = `${symbol}|${ymd}`;
    let rows = minuteCache.get(key);
    if (!rows) {
      rows =
        args.offline || args.countOnly
          ? (readJson<StoredMinuteBar[]>(minutePath(symbol, ymd)) ?? [])
          : await fetchMinuteDay(symbol, ymd);
      minuteCache.set(key, rows);
    }
    return rows;
  };
  // 'iex' = production parity (executor sees what live getLatestQuotes would);
  // 'sip' = consolidated-tape realism mode for strategy economics. Reported
  // runs must label which feed produced them.
  const quoteFeed = process.env.BACKTEST_QUOTE_FEED === 'sip' ? ('sip' as const) : ('iex' as const);
  const quotesWindow = async (symbol: string, tickIso: string): Promise<StoredQuote[]> =>
    args.offline || args.countOnly
      ? (readJson<StoredQuote[]>(quotesPath(symbol, tickIso, quoteFeed)) ?? [])
      : fetchQuotesWindow(symbol, tickIso, {}, quoteFeed);
  const tradesWindow = async (symbol: string, tickIso: string): Promise<StoredTrade[]> =>
    args.offline || args.countOnly
      ? (readJson<StoredTrade[]>(tradesPath(symbol, tickIso, quoteFeed)) ?? [])
      : fetchTradesWindow(symbol, tickIso, {}, quoteFeed);

  const newsPool: NewsItem[] = [...loadNewsDay(day), ...loadNewsDay(d1)].map((n) => ({
    headline: n.headline,
    summary: n.summary,
    symbols: n.symbols,
    created_at: n.created_at,
    source: n.source,
  }));

  const advanceFills = async (): Promise<void> => {
    const open = await ledger.getOpenOrders();
    if (open.length === 0) return;
    const barsByTicker = new Map<string, StoredMinuteBar[]>();
    for (const order of open) {
      const ymd = etYmdOf(order.submittedAt);
      const bars = await minuteBars(order.ticker.toUpperCase(), ymd);
      const prev = barsByTicker.get(order.ticker.toUpperCase()) ?? [];
      barsByTicker.set(order.ticker.toUpperCase(), prev.length > 0 ? [...prev, ...bars] : bars);
    }
    ledger.advance(barsByTicker);
  };

  // ---- tick loop ----
  let halts = 0;
  let prevHalted = readHaltState().halted;
  let syntheticWritten = false;
  // --rth-thesis: the production 09:00 ET morning pipeline writes the D+1
  // kind='rth' thesis the RTH executor consumes (see the header comment for
  // the information-set approximation this simulation makes).
  const rthGenMs = Date.parse(`${d1}T09:00:00${etOffsetForDate(d1)}`);
  let rthThesisWritten = args.rthThesis !== true; // true = nothing left to write
  // Quote/trade feed covers both theses' tickers plus positions/open orders.
  const feedTickers = new Set(thesis.entries.map((e) => e.ticker.toUpperCase()));

  for (let t = startMs; t < flattenMs; t += TICK_MS) {
    const nowIso = new Date(t).toISOString();
    // Episode boundary correction: production's ~17:05 pipeline writes the
    // D+1 thesis; the synthetic empty one stops NEW entries from D's thesis.
    if (!syntheticWritten && t >= syntheticAtMs) {
      const empty: Thesis = {
        date: d1,
        kind: 'offhours',
        generatedAt: new Date(syntheticAtMs).toISOString(),
        expiresAt: thesisExpiry(d1),
        entries: [],
        skipped: [],
      };
      writeJsonAtomic(thesisPath(d1), empty);
      syntheticWritten = true;
    }

    ledger.setNow(nowIso);
    // Fills advance every step (orders placed in extended hours can fill
    // during RTH); runTick below is gated to enabled sessions only.
    await advanceFills();

    // Simulated morning pipeline: assemble the D+1 kind='rth' thesis at the
    // first tick at/after 09:00 ET, from the SAME cached day-D verdicts, at
    // the CURRENT account (fills through 09:00 included, as production's
    // broker.getAccount() would see them). Runs before the session gate —
    // 09:00 is premarket, which may be disabled (the parity config).
    if (!rthThesisWritten && t >= rthGenMs) {
      const morning = await assembleEntries(await ledger.getAccount());
      const rth: Thesis = {
        date: d1,
        kind: 'rth',
        generatedAt: new Date(rthGenMs).toISOString(),
        expiresAt: rthThesisExpiry(d1),
        entries: morning.entries,
        skipped: morning.skipped,
      };
      writeJsonAtomic(thesisPath(d1, 'rth'), rth);
      for (const entry of morning.entries) feedTickers.add(entry.ticker.toUpperCase());
      rthThesisWritten = true;
    }

    const session = currentSession(new Date(t));
    if (!sessionEnabled(session, cfg)) continue;

    // Operator halt policy on the production state file (out/state.json).
    const halt0 = readHaltState();
    if (
      halt0.halted &&
      args.haltPolicy === 'auto-resume' &&
      halt0.at !== '' &&
      etYmdOf(nowIso) > etYmdOf(halt0.at)
    ) {
      clearHaltState(new Date(t));
    }
    const halt = readHaltState();
    if (halt.halted) ledger.writeHalt(halt.reason, halt.at || nowIso);
    else ledger.clearHalt();

    // Feed this tick's quotes/trades: latest historical row with ts <= tick.
    const acct = await ledger.getAccount();
    const open = await ledger.getOpenOrders();
    const tickers = new Set<string>([
      ...feedTickers,
      ...acct.positions.map((p) => p.ticker.toUpperCase()),
      ...open.map((o) => o.ticker.toUpperCase()),
    ]);
    const quotesBy = new Map<string, StoredQuote>();
    const lastBy = new Map<string, number>();
    for (const symbol of tickers) {
      const quote = latestQuoteAtOrBefore(await quotesWindow(symbol, nowIso), t);
      if (quote) quotesBy.set(symbol, quote);
      const trade = latestTradeAtOrBefore(await tradesWindow(symbol, nowIso), t);
      if (trade) lastBy.set(symbol, trade.p);
    }
    ledger.setMarketData(nowIso, quotesBy, lastBy);
    ledger.setNews(newsPool.filter((n) => Date.parse(n.created_at) <= t));

    await runTick({
      cfg,
      broker,
      marketData: ledger.asMarketData(),
      llm,
      now: new Date(t),
    });

    const after = readHaltState();
    if (after.halted && !prevHalted) halts += 1;
    prevHalted = after.halted;
  }

  // Final fill sweep just before order death (bars completing at 20:00 are
  // conservatively left unfilled: the ledger expires orders at exactly 20:00).
  ledger.setNow(new Date(flattenMs - 60_000).toISOString());
  await advanceFills();

  // Force-flatten at D+1 20:00: mark = last minute-bar close before 20:00
  // (D+1, else D), falling back to the ledger's carried mark.
  const held = (await ledger.getAccount()).positions;
  const marks = new Map<string, number>();
  for (const p of held) {
    const symbol = p.ticker.toUpperCase();
    let mark: number | undefined;
    for (const ymd of [d1, day]) {
      const bars = (await minuteBars(symbol, ymd))
        .filter((b) => Date.parse(b.t) < flattenMs)
        .sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
      const last = bars[bars.length - 1];
      if (last) {
        mark = last.c;
        break;
      }
    }
    if (mark === undefined && p.qty !== 0) mark = p.marketValue / p.qty;
    if (mark !== undefined) marks.set(symbol, mark);
  }
  const flattened = ledger.forceFlattenAt(flattenIso, marks);

  // ---- result assembly ----
  const tallies = readAuditTallies();
  const rejectionsByReason: Record<string, number> = { ...preRejections };
  for (const [reason, count] of Object.entries(tallies.rejectionsByReason)) {
    rejectionsByReason[reason] = (rejectionsByReason[reason] ?? 0) + count;
  }
  const trades = buildTrades(
    ledger.fills(),
    flattened.closes,
    prep.verdicts,
    tallies.exitReasonsByTicker,
    ledger.totals().borrowUsd,
  );
  const result: EpisodeResult = {
    day,
    stratum: args.stratum,
    regimeState: regime.state,
    trades,
    abstained,
    ordersPlaced: ledger.allOrders().length,
    ordersFilled: ledger.fills().length,
    rejectionsByReason,
    judgeVetoes: tallies.judgeVetoes,
    halts,
    danglingAtFlatten: flattened.closes.length,
    llmCostUsd: costUsd(prep.usage, args.prices) + costUsd(episodeUsage, args.prices),
  };

  if (args.countOnly) {
    if (args.budgetFile) {
      writeJsonFile(args.budgetFile, {
        judgeMisses: missCounts.judge,
        otherMisses: missCounts.other,
      });
    }
  } else {
    writeJsonFile(args.resultFile, result);
  }
  return result;
}

// ---------- child-process entry ----------

async function main(): Promise<void> {
  const argsFile = process.argv[2];
  if (!argsFile) {
    console.error('usage: tsx scripts/backtest-episode.ts <episode-args.json>');
    process.exit(1);
  }
  const args = JSON.parse(fs.readFileSync(argsFile, 'utf8')) as EpisodeArgs;
  const result = await runEpisode(args);
  console.error(
    `[episode ${args.day}] done: trades=${result.trades.length} placed=${result.ordersPlaced} ` +
      `filled=${result.ordersFilled} abstained=${result.abstained} dangling=${result.danglingAtFlatten}`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exit(1);
  });
}
