// Backtest driver (plan T6, 5h episode protocol). Subcommands:
//
//   sample --seed N            calendar + SIP daily bars -> dispersion scores
//                              -> two-strata episode sample -> sample.json
//   precompute [--limit N] [--concurrency 8]
//                              Phase A per episode in pre-committed priority
//                              order: day-D scans -> REAL runNominations ->
//                              REAL buildCandidates -> REAL runVerdicts, all
//                              via the exact-caching client wrapping a real
//                              Anthropic client -> backtest-out/prep/<day>.json
//   run --tag T [--halt-policy auto-resume|stay-halted] [--concurrency 4]
//       [--prices file] [--offline]
//                              Phase B: one CHILD PROCESS per episode with
//                              cwd = backtest-out/T/<day>/ (src/paths.ts
//                              computes OUT_DIR from process.cwd() at import
//                              time, so the REAL runTick reads/writes thesis,
//                              state, and audit files inside the episode dir)
//   sweep --tag T [--concurrency 4] [--offline]
//                              18 cells {conviction_threshold x bear weight},
//                              Phase B only from prep files with the canonical
//                              judge cache; prints the fresh-call budget FIRST
//                              (canonical-cache judge misses + probe arm 2)
//                              and applies the pre-registered 0.55 threshold
//                              floor if it exceeds 300
//   report --tag T [--tbill 0.043]
//                              aggregate episode-result.json files ->
//                              metrics.renderReport -> backtest-out/T/REPORT.md
import 'dotenv/config';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { loadConfig, type Config } from '../src/config.js';
import { alphaTrialCount, loadTrialRegistry } from '../src/trial-registry.js';
import { buildCandidates } from '../src/candidates.js';
import { runNominations, type Scans } from '../src/agents/nominate.js';
import { runVerdicts, type DailyBar } from '../src/agents/verdicts.js';
import type { LlmClient } from '../src/agents/llm.js';
import type { NewsItem } from '../src/broker/marketdata.js';
import type { VerdictFile } from '../src/types.js';
import {
  DATA_DIR,
  WINDOW,
  loadCalendar,
  loadDailyBars,
  loadUniverse,
  readJson,
} from '../src/backtest/data.js';
import {
  dispersionScoreFrom,
  marketInfoFor,
  mostActivesFrom,
  moversFrom,
  newsFor,
  sampleEpisodes,
  uncappedNewsFor,
} from '../src/backtest/scans.js';
import { LLM_CACHE_DIR, makeCachingClient } from '../src/backtest/llm-cache.js';
import {
  computeAll,
  episodeNetUsd,
  renderReport,
  signalAttribution,
  walkForward,
  type EpisodeResult,
  type ReportMeta,
} from '../src/backtest/metrics.js';
import type { SampleFile, StoredDailyBar } from '../src/backtest/types.js';
import {
  trackUsage,
  type EpisodeArgs,
  type PrepFile,
  type PriceTable,
  type UsageByModel,
} from './backtest-episode.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TSX_BIN = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
const EPISODE_SCRIPT = path.join(REPO_ROOT, 'scripts', 'backtest-episode.ts');
const BARS_LOOKBACK = 25; // production getDailyBars(symbols, limit = 25)
const EQUITY_START = 50_000;
const SWEEP_THRESHOLDS = [0.45, 0.5, 0.55, 0.6, 0.65, 0.7];
const SWEEP_BEAR_WEIGHTS = [0.8, 1.2, 1.6];
const SWEEP_BUDGET_LIMIT = 300;
const SWEEP_THRESHOLD_FLOOR = 0.55;

/** backtest-out root; overridable for tests (mirrors DATA_DIR's env override). */
export const outRoot = (): string =>
  process.env.BACKTEST_OUT_DIR ?? path.join(REPO_ROOT, 'backtest-out');
export const samplePath = (): string => path.join(DATA_DIR, 'sample.json');
const prepPath = (day: string): string => path.join(outRoot(), 'prep', `${day}.json`);
const tagDir = (tag: string): string => path.join(outRoot(), tag);

const log = (msg: string): void =>
  console.log(`[backtest ${new Date().toISOString().slice(11, 19)}] ${msg}`);

// ---------- tiny CLI helpers ----------

function flagValue(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const hasFlag = (name: string): boolean => process.argv.includes(`--${name}`);

function numFlag(name: string): number | undefined {
  const raw = flagValue(name);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`--${name} must be a number, got ${raw}`);
  return n;
}

function writeJsonFile(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

const fileExists = (file: string): boolean => {
  try {
    return fs.statSync(file).size > 2;
  } catch {
    return false;
  }
};

async function mapPool<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async (): Promise<void> => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i]!);
      }
    },
  );
  await Promise.all(workers);
  return out;
}

// ---------- shared data shaping ----------

function loadSipBarsMap(): Map<string, StoredDailyBar[]> {
  const universe = loadUniverse();
  if (!universe) throw new Error('backtest-data/universe.json missing — run scripts/backtest-fetch.ts');
  const out = new Map<string, StoredDailyBar[]>();
  for (const asset of universe) {
    const bars = loadDailyBars('sip', asset.symbol);
    if (bars.length > 0) out.set(asset.symbol, bars);
  }
  return out;
}

/** Last 25 IEX daily bars as of day D (production getDailyBars lookback). */
function iexBarsUpTo(symbol: string, day: string): DailyBar[] {
  return loadDailyBars('iex', symbol)
    .filter((b) => b.t.slice(0, 10) <= day)
    .sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0))
    .slice(-BARS_LOOKBACK);
}

/** Mirror of pipeline.ts groupNewsBySymbol (uppercase symbol matching). */
function groupNewsBySymbol(news: NewsItem[], tickers: string[]): Record<string, NewsItem[]> {
  const wanted = new Set(tickers.map((t) => t.toUpperCase()));
  const out: Record<string, NewsItem[]> = {};
  for (const item of news) {
    for (const symbol of item.symbols) {
      const key = symbol.toUpperCase();
      if (!wanted.has(key)) continue;
      (out[key] ??= []).push(item);
    }
  }
  return out;
}

function loadSample(): SampleFile {
  const sample = readJson<SampleFile>(samplePath());
  if (!sample) throw new Error(`sample file missing: ${samplePath()} — run 'backtest.ts sample --seed N'`);
  return sample;
}

// ---------- sample ----------

export async function sampleCommand(seed: number): Promise<SampleFile> {
  const cal = loadCalendar();
  if (!cal) throw new Error('backtest-data/calendar.json missing — run scripts/backtest-fetch.ts calendar');
  const tradingDays = cal
    .map((d) => d.date)
    .filter((d) => d >= WINDOW.start && d <= WINDOW.end)
    .sort();
  log(`scoring dispersion for ${tradingDays.length} trading days`);
  const sipBars = loadSipBarsMap();
  const dispersionByDay = new Map<string, number>();
  for (const day of tradingDays) dispersionByDay.set(day, dispersionScoreFrom(sipBars, day));
  const sample = sampleEpisodes(tradingDays, dispersionByDay, seed);
  writeJsonFile(samplePath(), sample);
  console.log(`\nsample (seed ${seed}) — pre-committed drop-priority order:`);
  console.log('idx  day         stratum  priority  dispersion');
  sample.episodes.forEach((e, i) => {
    console.log(
      `${String(i).padStart(3)}  ${e.day}  ${e.stratum.padEnd(7)}  ${String(e.priority).padStart(8)}  ${String(e.dispersionScore).padStart(10)}`,
    );
  });
  log(`wrote ${samplePath()} (${sample.episodes.length} episodes)`);
  return sample;
}

// ---------- precompute (Phase A) ----------

export async function precomputeCommand(limit?: number, concurrency = 8): Promise<void> {
  const sample = loadSample();
  const cfg = loadConfig();
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set; add it to .env');
  const inner: LlmClient = new Anthropic();
  const episodes = sample.episodes.slice(0, limit ?? sample.episodes.length);
  log(`Phase A for ${episodes.length} episodes (concurrency ${concurrency})`);
  const sipBars = loadSipBarsMap();

  await mapPool(episodes, concurrency, async (episode) => {
    const file = prepPath(episode.day);
    if (fileExists(file)) {
      log(`prep ${episode.day}: exists, skipped`);
      return;
    }
    const usage: UsageByModel = {};
    const client = trackUsage(makeCachingClient(inner, 'exact'), usage);
    const day = episode.day;

    // Day-D scans, production shapes (floors live only in buildCandidates).
    const movers = moversFrom(sipBars, day);
    const mostActives = mostActivesFrom(sipBars, day);
    const news = newsFor(day);
    const moverSymbols = [
      ...new Set([...movers.gainers, ...movers.losers].map((m) => m.symbol.toUpperCase())),
    ];
    const moverBars: Record<string, DailyBar[]> = {};
    for (const symbol of moverSymbols) {
      const bars = iexBarsUpTo(symbol, day);
      if (bars.length > 0) moverBars[symbol] = bars;
    }
    const scans: Scans = { movers, mostActives, news, barsBySymbol: moverBars };

    const round1 = await runNominations(cfg, scans, client);
    const nominated = [
      ...new Set(round1.nominations.flatMap((an) => an.nominations.map((n) => n.ticker.toUpperCase()))),
    ];
    const marketInfo = marketInfoFor(nominated, day);
    const candidateFile = buildCandidates(round1.nominations, marketInfo, cfg, day);

    let verdictFile: VerdictFile = { date: day, verdicts: [], droppedAnalysts: [] };
    if (candidateFile.candidates.length > 0) {
      const tickers = candidateFile.candidates.map((c) => c.ticker.toUpperCase());
      const barsBySymbol: Record<string, DailyBar[]> = {};
      for (const ticker of tickers) barsBySymbol[ticker] = iexBarsUpTo(ticker, day);
      // Uncapped (D-1 17:00, D 17:00] news, grouped per ticker (plan §2).
      const newsBySymbol = groupNewsBySymbol(uncappedNewsFor(day), tickers);
      verdictFile = await runVerdicts(cfg, candidateFile, { barsBySymbol, newsBySymbol }, client);
    }

    const prep: PrepFile = {
      day,
      stratum: episode.stratum,
      scan: {
        gainers: movers.gainers.length,
        losers: movers.losers.length,
        actives: mostActives.length,
        news: news.length,
      },
      nominations: round1,
      candidates: candidateFile,
      verdicts: verdictFile,
      marketInfo: Object.fromEntries(marketInfo),
      usage,
    };
    writeJsonFile(file, prep);
    log(
      `prep ${day} (${episode.stratum}): ${candidateFile.candidates.length} candidates, ` +
        `${verdictFile.verdicts.length} verdicts`,
    );
  });
  log('Phase A done');
}

// ---------- run (Phase B, child process per episode) ----------

function spawnEpisode(argsFile: string, cwd: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(TSX_BIN, [EPISODE_SCRIPT, argsFile], {
      cwd,
      env: process.env,
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });
}

interface PhaseBOpts {
  baseDir: string; // per-episode dirs created under here
  cfg: Config;
  haltPolicy: 'auto-resume' | 'stay-halted';
  concurrency: number;
  offline: boolean;
  prices?: PriceTable;
  countOnly?: boolean;
  skipExisting?: boolean;
}

async function runPhaseB(
  episodes: { day: string; stratum: 'R' | 'H' }[],
  opts: PhaseBOpts,
): Promise<{ completed: string[]; failed: string[] }> {
  const completed: string[] = [];
  const failed: string[] = [];
  await mapPool(episodes, opts.concurrency, async (episode) => {
    const episodeDir = path.join(opts.baseDir, episode.day);
    const resultFile = path.join(episodeDir, 'episode-result.json');
    if (opts.skipExisting && fileExists(resultFile)) {
      completed.push(episode.day);
      return;
    }
    fs.mkdirSync(episodeDir, { recursive: true });
    const args: EpisodeArgs = {
      day: episode.day,
      stratum: episode.stratum,
      prepFile: prepPath(episode.day),
      resultFile,
      cfg: opts.cfg,
      haltPolicy: opts.haltPolicy,
      equityStart: EQUITY_START,
      cacheDir: LLM_CACHE_DIR,
      offline: opts.offline,
      countOnly: opts.countOnly,
      budgetFile: opts.countOnly ? path.join(episodeDir, 'budget.json') : undefined,
      prices: opts.prices,
    };
    const argsFile = path.join(episodeDir, 'episode-args.json');
    writeJsonFile(argsFile, args);
    const code = await spawnEpisode(argsFile, episodeDir);
    if (code === 0) completed.push(episode.day);
    else {
      failed.push(episode.day);
      log(`episode ${episode.day} FAILED (exit ${code})`);
    }
  });
  return { completed, failed };
}

export async function runCommand(
  tag: string,
  haltPolicy: 'auto-resume' | 'stay-halted',
  concurrency = 4,
  offline = false,
  prices?: PriceTable,
): Promise<void> {
  const sample = loadSample();
  const cfg = loadConfig();
  const episodes = sample.episodes.filter((e) => fileExists(prepPath(e.day)));
  if (episodes.length === 0) throw new Error('no prep files found — run precompute first');
  log(`Phase B '${tag}' (${haltPolicy}): ${episodes.length} episodes, concurrency ${concurrency}`);
  const { completed, failed } = await runPhaseB(episodes, {
    baseDir: tagDir(tag),
    cfg,
    haltPolicy,
    concurrency,
    offline,
    prices,
    skipExisting: true,
  });
  writeJsonFile(path.join(tagDir(tag), 'run-summary.json'), {
    tag,
    haltPolicy,
    completed: completed.sort(),
    failed: failed.sort(),
  });
  log(`Phase B done: ${completed.length} completed, ${failed.length} failed`);
  if (failed.length > 0) process.exitCode = 1;
}

// ---------- sweep ----------

interface SweepCell {
  id: string;
  threshold: number;
  bearWeight: number;
  /** Optional deep config override, e.g. to enable one signal (signal-toggle cells). */
  patch?: (c: Config) => Config;
}

function sweepCells(): SweepCell[] {
  const cells: SweepCell[] = [];
  for (const threshold of SWEEP_THRESHOLDS) {
    for (const bearWeight of SWEEP_BEAR_WEIGHTS) {
      cells.push({
        id: `t${Math.round(threshold * 100)}-b${Math.round(bearWeight * 10)}`,
        threshold,
        bearWeight,
      });
    }
  }
  return cells;
}

/**
 * Enablers for the signal-toggle sweep: one config patch per ALPHA signal that
 * turns exactly that signal on (the disprove funnel of docs/QUANT-TESTING-PLAN.md).
 * Signals never enter the LLM prompt, so on/off cells share byte-identical cached
 * LLM inputs — the difference is a clean same-inputs counterfactual.
 */
export const SIGNAL_ENABLERS: { flag: string; patch: (c: Config) => Config }[] = [
  { flag: 'signals.anti_chase', patch: (c) => ({ ...c, signals: { ...c.signals, anti_chase: { ...c.signals.anti_chase, enabled: true } } }) },
  { flag: 'signals.amihud', patch: (c) => ({ ...c, signals: { ...c.signals, amihud: { ...c.signals.amihud, enabled: true } } }) },
  { flag: 'signals.dispersion', patch: (c) => ({ ...c, signals: { ...c.signals, dispersion: { ...c.signals.dispersion, enabled: true, k: c.signals.dispersion.k || 1 } } }) },
  { flag: 'signals.trend_gate', patch: (c) => ({ ...c, signals: { ...c.signals, trend_gate: { ...c.signals.trend_gate, enabled: true } } }) },
  { flag: 'signals.gap', patch: (c) => ({ ...c, signals: { ...c.signals, gap: { ...c.signals.gap, enabled: true } } }) },
  { flag: 'signals.low_vol', patch: (c) => ({ ...c, signals: { ...c.signals, low_vol: { prefer_low_vol: true } } }) },
  { flag: 'regime.trend', patch: (c) => ({ ...c, regime: { ...c.regime, trend: { ...c.regime.trend, enabled: true } } }) },
  { flag: 'regime.vol', patch: (c) => ({ ...c, regime: { ...c.regime, vol: { ...c.regime.vol, enabled: true } } }) },
  { flag: 'regime.gross', patch: (c) => ({ ...c, regime: { ...c.regime, gross: { ...c.regime.gross, enabled: true } } }) },
  { flag: 'portfolio.target_vol', patch: (c) => ({ ...c, portfolio: { ...c.portfolio, target_vol: { ...c.portfolio.target_vol, enabled: true } } }) },
  { flag: 'portfolio.inverse_vol', patch: (c) => ({ ...c, portfolio: { ...c.portfolio, sizing_mode: 'inverse_vol' } }) },
  { flag: 'execution.cost_scalar', patch: (c) => ({ ...c, execution: { ...c.execution, cost_scalar: { ...c.execution.cost_scalar, enabled: true } } }) },
  { flag: 'execution.participation', patch: (c) => ({ ...c, execution: { ...c.execution, participation: { ...c.execution.participation, enabled: true } } }) },
];

/** Baseline (all off) + one cell per signal enabler, at the shipped threshold/bear. */
export function signalToggleCells(threshold = 0.55, bearWeight = 1.2): SweepCell[] {
  return [
    { id: 'baseline', threshold, bearWeight },
    ...SIGNAL_ENABLERS.map((e) => ({ id: `sig-${e.flag}`, threshold, bearWeight, patch: e.patch })),
  ];
}

export function cellConfig(cfg: Config, cell: SweepCell): Config {
  const base: Config = {
    ...cfg,
    conviction_threshold: cell.threshold,
    agent_weights: { ...cfg.agent_weights, bear: cell.bearWeight },
  };
  return cell.patch ? cell.patch(base) : base;
}

export function collectEpisodeResults(dir: string): EpisodeResult[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n));
  } catch {
    return [];
  }
  const out: EpisodeResult[] = [];
  for (const name of names.sort()) {
    const result = readJson<EpisodeResult>(path.join(dir, name, 'episode-result.json'));
    if (result) out.push(result);
  }
  return out;
}

/** Unique (day, ticker) pairs the tagged run actually traded (probe arm 2 input). */
function tradedPairCount(tag: string): number {
  const pairs = new Set<string>();
  for (const episode of collectEpisodeResults(tagDir(tag))) {
    for (const trade of episode.trades) pairs.add(`${episode.day}|${trade.ticker}`);
  }
  return pairs.size;
}

export async function sweepCommand(
  tag: string,
  concurrency = 4,
  offline = false,
  mode: 'threshold' | 'signals' = 'threshold',
  budgetOnly = false,
): Promise<void> {
  const sample = loadSample();
  const cfg = loadConfig();
  const episodes = sample.episodes.filter((e) => fileExists(prepPath(e.day)));
  if (episodes.length === 0) throw new Error('no prep files found — run precompute first');
  // 'signals' mode: baseline vs one-signal-on cells (disprove funnel). Signals
  // aren't in the LLM prompt, so all cells share the cached LLM calls -> the
  // fresh-call budget stays ~baseline regardless of cell count.
  let cells = mode === 'signals' ? signalToggleCells() : sweepCells();

  // Fresh-call budget FIRST: canonical judge-cache misses per cell (count-only
  // pass; nothing fetched, nothing persisted) plus probe arm 2 (2 calls per
  // traded pair from the tagged headline run).
  log(`sweep budget pass: ${cells.length} cells x ${episodes.length} episodes`);
  const judgeMissesByCell = new Map<string, number>();
  let otherMisses = 0;
  for (const cell of cells) {
    const baseDir = path.join(tagDir(tag), 'sweep-budget', cell.id);
    await runPhaseB(episodes, {
      baseDir,
      cfg: cellConfig(cfg, cell),
      haltPolicy: 'auto-resume',
      concurrency,
      offline,
      countOnly: true,
    });
    let judge = 0;
    for (const episode of episodes) {
      const budget = readJson<{ judgeMisses: number; otherMisses: number }>(
        path.join(baseDir, episode.day, 'budget.json'),
      );
      judge += budget?.judgeMisses ?? 0;
      otherMisses += budget?.otherMisses ?? 0;
    }
    judgeMissesByCell.set(cell.id, judge);
  }
  const arm2Calls = 2 * tradedPairCount(tag);
  const judgeTotal = (list: SweepCell[]): number =>
    list.reduce((s, c) => s + (judgeMissesByCell.get(c.id) ?? 0), 0);
  let budgetTotal = judgeTotal(cells) + arm2Calls;
  console.log(
    `\nFRESH-CALL BUDGET: judge-cache misses ${judgeTotal(cells)} across ${cells.length} cells ` +
      `+ probe arm 2 ${arm2Calls} (2 x traded pairs) = ${budgetTotal} (limit ${SWEEP_BUDGET_LIMIT}; ` +
      `non-judge misses ${otherMisses} reported, not budgeted)`,
  );
  if (budgetTotal > SWEEP_BUDGET_LIMIT && mode === 'threshold') {
    cells = cells.filter((c) => c.threshold >= SWEEP_THRESHOLD_FLOOR);
    budgetTotal = judgeTotal(cells) + arm2Calls;
    console.log(
      `budget over ${SWEEP_BUDGET_LIMIT}: threshold floor raised to ${SWEEP_THRESHOLD_FLOOR} ` +
        `(pre-registered rule) -> ${cells.length} cells, budget ${budgetTotal}`,
    );
    if (budgetTotal > SWEEP_BUDGET_LIMIT) {
      console.error('budget still exceeds the limit after the pre-registered floor — aborting sweep');
      process.exitCode = 1;
      return;
    }
  }
  // Signal mode shares cached LLM inputs across cells, so fresh calls should be
  // ~baseline; if they aren't, abort rather than make unbudgeted live API calls.
  if (budgetTotal > SWEEP_BUDGET_LIMIT && mode === 'signals') {
    console.error(
      `signal-sweep fresh-call budget ${budgetTotal} exceeds ${SWEEP_BUDGET_LIMIT} — aborting to avoid ` +
        `unbudgeted live API calls. Populate the cache (run the baseline config first) or cut episodes.`,
    );
    process.exitCode = 1;
    return;
  }
  if (budgetOnly) {
    log(`budget-only: stopping before the priced run (fresh calls = ${budgetTotal}).`);
    return;
  }

  // Real pass: Phase B per cell through the shared canonical judge cache.
  const rows: {
    cell: string;
    threshold: number;
    bearWeight: number;
    episodes: number;
    abstained: number;
    ordersPlaced: number;
    ordersFilled: number;
    fillRate: number | null;
    trades: number;
    netPnlTotalUsd: number;
    judgeMissBudget: number;
  }[] = [];
  for (const cell of cells) {
    const baseDir = path.join(tagDir(tag), 'sweep', cell.id);
    log(`sweep cell ${cell.id} (threshold ${cell.threshold}, bear ${cell.bearWeight})`);
    const { failed } = await runPhaseB(episodes, {
      baseDir,
      cfg: cellConfig(cfg, cell),
      haltPolicy: 'auto-resume',
      concurrency,
      offline,
      skipExisting: true,
    });
    if (failed.length > 0) log(`cell ${cell.id}: ${failed.length} failed episodes`);
    const results = collectEpisodeResults(baseDir);
    const placed = results.reduce((s, r) => s + r.ordersPlaced, 0);
    const filled = results.reduce((s, r) => s + r.ordersFilled, 0);
    rows.push({
      cell: cell.id,
      threshold: cell.threshold,
      bearWeight: cell.bearWeight,
      episodes: results.length,
      abstained: results.filter((r) => r.abstained).length,
      ordersPlaced: placed,
      ordersFilled: filled,
      fillRate: placed > 0 ? filled / placed : null,
      trades: results.reduce((s, r) => s + r.trades.length, 0),
      netPnlTotalUsd: results.reduce((s, r) => s + episodeNetUsd(r), 0),
      judgeMissBudget: judgeMissesByCell.get(cell.id) ?? 0,
    });
  }
  writeJsonFile(path.join(tagDir(tag), 'sweep-results.json'), rows);
  console.log('\ncell      thr   bear  eps  abst  placed  filled  fillRate  trades  netPnl');
  for (const r of rows) {
    console.log(
      `${r.cell.padEnd(8)}  ${r.threshold.toFixed(2)}  ${r.bearWeight.toFixed(1)}   ${String(r.episodes).padStart(3)}  ${String(r.abstained).padStart(4)}  ${String(r.ordersPlaced).padStart(6)}  ${String(r.ordersFilled).padStart(6)}  ${r.fillRate === null ? '     n/a' : (100 * r.fillRate).toFixed(1).padStart(7) + '%'}  ${String(r.trades).padStart(6)}  ${r.netPnlTotalUsd.toFixed(2).padStart(8)}`,
    );
  }
  log('sweep done');
}

// ---------- report ----------

export function writeReport(tag: string, opts: { tbillAnnualRate?: number } = {}): string {
  const dir = tagDir(tag);
  const episodes = collectEpisodeResults(dir);
  if (episodes.length === 0) throw new Error(`no episode-result.json files under ${dir}`);
  const sample = readJson<SampleFile>(samplePath());
  const summary = readJson<{ completed: string[]; failed: string[]; haltPolicy: string }>(
    path.join(dir, 'run-summary.json'),
  );
  const sweep = readJson<
    { cell: string; threshold: number; bearWeight: number; episodes: number; abstained: number; ordersPlaced: number; ordersFilled: number; fillRate: number | null; trades: number; netPnlTotalUsd: number }[]
  >(path.join(dir, 'sweep-results.json'));

  const nR = episodes.filter((e) => e.stratum === 'R').length;
  const nH = episodes.filter((e) => e.stratum === 'H').length;
  const plannedR = sample?.episodes.filter((e) => e.stratum === 'R').length ?? null;
  const plannedH = sample?.episodes.filter((e) => e.stratum === 'H').length ?? null;
  const meta: ReportMeta = {
    tag,
    generatedAt: new Date().toISOString(),
    window: { start: WINDOW.start, end: WINDOW.end },
    minTradesForEconomicClaim: loadConfig().min_trades_for_economic_claim,
    nTrials: alphaTrialCount(loadTrialRegistry()),
    sampleNote:
      plannedR === null
        ? `${nR} R + ${nH} H episodes present (sample.json not found)`
        : `${nR}/${plannedR} R + ${nH}/${plannedH} H episodes present (pre-registered drop rule: first 24 R + first 16 H of the persisted priority order)`,
    mechanicalNote: summary
      ? `${summary.completed.length} episodes completed, ${summary.failed.length} failed (halt policy ${summary.haltPolicy}); invariant violations abort an episode, so every completed episode carries zero violations${summary.failed.length > 0 ? ` — FAILED: ${summary.failed.join(', ')}` : ''}`
      : `${episodes.length} episode results aggregated; run-summary.json not found`,
    sensitivityNote: sweep
      ? [
          '| cell | threshold | bear | episodes | abstained | placed | filled | fill rate | trades | net P&L |',
          '|---|---|---|---|---|---|---|---|---|---|',
          ...sweep.map(
            (r) =>
              `| ${r.cell} | ${r.threshold} | ${r.bearWeight} | ${r.episodes} | ${r.abstained} | ${r.ordersPlaced} | ${r.ordersFilled} | ${r.fillRate === null ? 'n/a' : (100 * r.fillRate).toFixed(1) + '%'} | ${r.trades} | $${r.netPnlTotalUsd.toFixed(2)} |`,
          ),
          '',
          '_Descriptive only (no walk-forward at this n): abstention/fill-rate vs threshold on shared cached verdicts._',
        ].join('\n')
      : undefined,
  };
  const hDays = sample?.episodes.filter((e) => e.stratum === 'H').map((e) => e.day);
  const bundle = computeAll(episodes, { tbillAnnualRate: opts.tbillAnnualRate }, hDays);
  const reportFile = path.join(dir, 'REPORT.md');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(reportFile, renderReport(bundle, meta));
  return reportFile;
}

// ---------- entry ----------

function loadPrices(): PriceTable | undefined {
  const file = flagValue('prices');
  if (!file) return undefined;
  const prices = readJson<PriceTable>(path.resolve(file));
  if (!prices) throw new Error(`price table not readable: ${file}`);
  return prices;
}

/** Print per-signal marginal attribution from a `sweep --signals` run. */
export function attributionsCommand(tag: string): void {
  const sweepRoot = path.join(tagDir(tag), 'sweep');
  const baseline = collectEpisodeResults(path.join(sweepRoot, 'baseline'));
  if (baseline.length === 0) {
    throw new Error(`no baseline episodes under ${sweepRoot}/baseline — run: backtest.ts sweep --tag ${tag} --signals`);
  }
  const cellIds = fs.readdirSync(sweepRoot).filter((d) => d.startsWith('sig-')).sort();
  console.log(`\nSignal attribution — tag ${tag} (paired vs baseline over ${baseline.length} episodes; KILL if CI straddles 0)`);
  console.log('| signal | pairs | mean marginal $/ep | 95% CI | verdict |');
  console.log('|---|---|---|---|---|');
  for (const cellId of cellIds) {
    const flag = cellId.replace(/^sig-/, '');
    const a = signalAttribution(flag, baseline, collectEpisodeResults(path.join(sweepRoot, cellId)));
    const ci = a.bootstrap ? `[$${a.bootstrap.low.toFixed(2)}, $${a.bootstrap.high.toFixed(2)}]` : 'n/a';
    const verdict = !a.bootstrap
      ? 'no data'
      : a.bootstrap.low > 0
        ? 'favorable → soak candidate'
        : a.bootstrap.high < 0
          ? 'unfavorable → KILL'
          : 'CI straddles 0 → KILL';
    console.log(`| ${flag} | ${a.nPairs} | $${a.meanMarginalUsd.toFixed(2)} | ${ci} | ${verdict} |`);
  }
}

/** Print sequential K-fold walk-forward headline economics for a tagged run. */
export function walkForwardCommand(tag: string, k: number, tbill?: number): void {
  const episodes = collectEpisodeResults(tagDir(tag));
  if (episodes.length === 0) throw new Error(`no episode results under ${tagDir(tag)}`);
  const folds = walkForward(episodes, k, { tbillAnnualRate: tbill });
  console.log(`\nWalk-forward — tag ${tag}, ${folds.length} sequential fold(s), headline stratum R:`);
  for (const f of folds) {
    const e = f.economics;
    console.log(
      `  fold ${f.fold} (${f.days[0]}..${f.days[f.days.length - 1]}, n=${e.nEpisodes}): ` +
        `net/ep $${e.netPnlMeanUsd.toFixed(2)}, total $${e.netPnlTotalUsd.toFixed(2)}`,
    );
  }
  console.log('_Descriptive only — a signal that works in one fold and not others is regime luck._');
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  if (cmd === 'sample') {
    const seed = numFlag('seed');
    if (seed === undefined) throw new Error('usage: backtest.ts sample --seed N');
    await sampleCommand(seed);
    return;
  }
  if (cmd === 'precompute') {
    await precomputeCommand(numFlag('limit'), numFlag('concurrency') ?? 8);
    return;
  }
  if (cmd === 'run') {
    const tag = flagValue('tag');
    if (!tag) throw new Error('usage: backtest.ts run --tag T [--halt-policy auto-resume|stay-halted]');
    const haltPolicy = flagValue('halt-policy') ?? 'auto-resume';
    if (haltPolicy !== 'auto-resume' && haltPolicy !== 'stay-halted') {
      throw new Error(`invalid --halt-policy ${haltPolicy}`);
    }
    await runCommand(tag, haltPolicy, numFlag('concurrency') ?? 4, hasFlag('offline'), loadPrices());
    return;
  }
  if (cmd === 'sweep') {
    const tag = flagValue('tag');
    if (!tag) throw new Error('usage: backtest.ts sweep --tag T');
    await sweepCommand(
      tag,
      numFlag('concurrency') ?? 4,
      hasFlag('offline'),
      hasFlag('signals') ? 'signals' : 'threshold',
      hasFlag('budget-only'),
    );
    return;
  }
  if (cmd === 'report') {
    const tag = flagValue('tag');
    if (!tag) throw new Error('usage: backtest.ts report --tag T [--tbill 0.043]');
    const file = writeReport(tag, { tbillAnnualRate: numFlag('tbill') });
    log(`wrote ${file}`);
    return;
  }
  if (cmd === 'attributions') {
    const tag = flagValue('tag');
    if (!tag) throw new Error('usage: backtest.ts attributions --tag T (run `sweep --tag T --signals` first)');
    attributionsCommand(tag);
    return;
  }
  if (cmd === 'walkforward') {
    const tag = flagValue('tag');
    if (!tag) throw new Error('usage: backtest.ts walkforward --tag T [--k 3] [--tbill 0.043]');
    walkForwardCommand(tag, numFlag('k') ?? 3, numFlag('tbill'));
    return;
  }
  console.error('usage: tsx scripts/backtest.ts <sample|precompute|run|sweep|report|attributions|walkforward> [flags]');
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exit(1);
  });
}
