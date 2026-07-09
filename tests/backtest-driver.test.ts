// Integration test for the backtest driver's Phase B (plan T6): three
// synthetic episodes with canned prep files, canned/seeded LLM cache entries,
// and synthetic minute-bar/quote fixtures in a temp DATA_DIR (via the
// BACKTEST_DATA_DIR env override in src/backtest/data.ts).
//
// Episodes run IN-PROCESS through the real episode runner
// (scripts/backtest-episode.ts runEpisode): src/paths.ts computes OUT_DIR
// from process.cwd() at import time, so each run chdirs into its episode
// directory and re-imports the module graph via vi.resetModules() — the same
// isolation the driver gets from one child process per episode.
//
// Covered:
//   - deterministic episode-result.json: a full replay from the disk caches
//     alone (inner LLM client throws) reproduces the identical result
//   - the 5h-plan episode-boundary correction: an unfilled D entry whose band
//     is crossed at D+1 18:30 places no order after the D+1 17:15 tick, while
//     an open position whose invalidation triggers at D+1 18:30 still
//     produces a judge exit
//   - one full no-trade (abstained) episode
//   - riskCheck rejection recorded ('exceeds max daily deployment') plus the
//     borrow hard gate ('not shortable')
//   - report aggregation through the driver's writeReport
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import type { LlmClient } from '../src/agents/llm.js';
import type { Verdict } from '../src/types.js';
import type { EpisodeArgs, PrepFile, PriceTable } from '../scripts/backtest-episode.js';
import type { EpisodeResult } from '../src/backtest/metrics.js';
import type {
  StoredMinuteBar,
  StoredQuote,
  StoredTrade,
  UniverseAsset,
} from '../src/backtest/types.js';

// Env overrides MUST be set before any project module that reads them is
// evaluated; everything below is imported dynamically for that reason.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'backtest-driver-'));
const DATA_DIR = path.join(ROOT, 'data');
const OUT_ROOT = path.join(ROOT, 'backtest-out');
const CACHE_DIR = path.join(ROOT, 'llm-cache');
const PREP_DIR = path.join(ROOT, 'prep');
process.env.BACKTEST_DATA_DIR = DATA_DIR;
process.env.BACKTEST_OUT_DIR = OUT_ROOT;
const ORIGINAL_CWD = process.cwd();

const data = await import('../src/backtest/data.js');
const { ConfigSchema } = await import('../src/config.js');

// Stop lifted to 50% so the existing fixtures exercise the JUDGE exit path;
// a dedicated test below drives the deterministic stop at the default 8%.
const CFG = ConfigSchema.parse({ max_position_loss_pct: 50 });
const ANALYSTS = ['fundamental', 'technical', 'macro', 'sentiment', 'bear'] as const;
const PRICES: PriceTable = { '': { inputPerMtok: 1, outputPerMtok: 2 } };

// All test days are EDT (after 2026-03-08).
const iso = (ymd: string, hms: string): string => new Date(`${ymd}T${hms}-04:00`).toISOString();

const EP1 = { day: '2026-03-16', next: '2026-03-17' }; // Mon -> Tue
const EP2 = { day: '2026-03-17', next: '2026-03-18' };
const EP3 = { day: '2026-03-18', next: '2026-03-19' };

// ---------- fixture helpers ----------

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

function verdictsFor(ticker: string, direction: 'long' | 'short', conviction: number): Verdict[] {
  return ANALYSTS.map((analyst) => ({
    analyst,
    ticker,
    direction,
    conviction,
    horizon: 'days' as const,
    evidence: [`${analyst} evidence ${ticker}`],
    invalidation_conditions: [`${ticker} invalidation`],
  }));
}

function writePrep(
  day: string,
  stratum: 'R' | 'H',
  verdicts: Verdict[],
  marketInfo: Record<string, { lastPrice: number; avgDollarVolume20d: number }>,
): string {
  const prep: PrepFile = {
    day,
    stratum,
    scan: { gainers: 0, losers: 0, actives: 0, news: 0 },
    nominations: { nominations: [], dropped: [] },
    candidates: { date: day, candidates: [], rejected: [] },
    verdicts: { date: day, verdicts, droppedAnalysts: [] },
    marketInfo,
    usage: { 'stub-model': { calls: 2, input_tokens: 1000, output_tokens: 500 } },
  };
  const file = path.join(PREP_DIR, `${day}.json`);
  writeJson(file, prep);
  return file;
}

/** All session-enabled 15-min tick instants of an episode (D afterhours, D+1 premarket, D+1 afterhours). */
function enabledTicks(day: string, next: string): string[] {
  const out: string[] = [];
  const push = (ymd: string, fromMin: number, toMin: number): void => {
    for (let m = fromMin; m <= toMin; m += 15) {
      const h = String(Math.floor(m / 60)).padStart(2, '0');
      const mm = String(m % 60).padStart(2, '0');
      out.push(iso(ymd, `${h}:${mm}:00`));
    }
  };
  push(day, 17 * 60, 19 * 60 + 45);
  push(next, 4 * 60, 9 * 60 + 15);
  push(next, 16 * 60, 19 * 60 + 45);
  return out;
}

function writeQuote(symbol: string, tickIso: string, bp: number, ap: number): void {
  const rows: StoredQuote[] = [{ t: tickIso, bp, bs: 5, ap, as: 5 }];
  writeJson(data.quotesPath(symbol, tickIso), rows);
}

function writeTrade(symbol: string, tickIso: string, p: number): void {
  const rows: StoredTrade[] = [{ t: tickIso, p, s: 100 }];
  writeJson(data.tradesPath(symbol, tickIso), rows);
}

function writeMinuteBars(symbol: string, ymd: string, bars: StoredMinuteBar[]): void {
  writeJson(data.minutePath(symbol, ymd), bars);
}

// ---------- LLM stubs ----------

function toolMessage(name: string, input: unknown): Anthropic.Messages.Message {
  return {
    content: [{ type: 'tool_use', id: 'stub', name, input }],
    usage: { input_tokens: 100, output_tokens: 50 },
  } as unknown as Anthropic.Messages.Message;
}

interface JudgeDecision {
  proceed: boolean;
  exitPosition: boolean;
  reasons: string[];
}

function makeStub(opts: {
  narratives: { ticker: string; narrative: string; invalidation_conditions: string[] }[] | 'throw';
  judge?: (ticker: string, asOf: string) => JudgeDecision;
}): LlmClient {
  return {
    messages: {
      async create(params) {
        const choice = params.tool_choice as { type?: string; name?: string } | undefined;
        const tool = choice?.type === 'tool' ? (choice.name ?? '') : '';
        if (tool === 'submit_narratives') {
          if (opts.narratives === 'throw') throw new Error('synthesizer unavailable (stub)');
          return toolMessage(tool, { narratives: opts.narratives });
        }
        if (tool === 'submit_execution_decision') {
          const first = params.messages[0];
          const parts = String(first?.content ?? '').split('\n\n');
          const entry = JSON.parse(parts[2] ?? 'null') as { ticker?: string };
          const quote = JSON.parse(parts[4] ?? 'null') as { asOf?: string };
          const decide =
            opts.judge ??
            ((): JudgeDecision => ({ proceed: true, exitPosition: false, reasons: ['hold'] }));
          return toolMessage(tool, decide(entry.ticker ?? '', quote.asOf ?? ''));
        }
        throw new Error(`stub: unexpected tool ${tool}`);
      },
    },
  };
}

function throwingClient(counter: { calls: number }): LlmClient {
  return {
    messages: {
      async create() {
        counter.calls += 1;
        throw new Error('fresh LLM call attempted during cache-only replay');
      },
    },
  };
}

// ---------- in-process episode execution (chdir + module reset) ----------

async function runInProcess(
  episodeDir: string,
  args: EpisodeArgs,
  inner: LlmClient,
): Promise<EpisodeResult> {
  fs.mkdirSync(episodeDir, { recursive: true });
  process.chdir(episodeDir);
  vi.resetModules();
  try {
    const mod = await import('../scripts/backtest-episode.js');
    return await mod.runEpisode(args, { innerLlm: inner });
  } finally {
    process.chdir(ORIGINAL_CWD);
  }
}

function episodeArgs(
  day: string,
  stratum: 'R' | 'H',
  prepFile: string,
  episodeDir: string,
  cfgOverride?: ReturnType<typeof ConfigSchema.parse>,
): EpisodeArgs {
  return {
    day,
    stratum,
    prepFile,
    resultFile: path.join(episodeDir, 'episode-result.json'),
    cfg: cfgOverride ?? CFG,
    haltPolicy: 'auto-resume',
    equityStart: 50_000,
    cacheDir: CACHE_DIR,
    offline: true,
    prices: PRICES,
  };
}

interface AuditLine {
  kind: string;
  data: Record<string, unknown>;
}

function readAudit(episodeDir: string): AuditLine[] {
  const outDir = path.join(episodeDir, 'out');
  const files = fs
    .readdirSync(outDir)
    .filter((f) => f.startsWith('audit-') && f.endsWith('.jsonl'))
    .sort();
  const events: AuditLine[] = [];
  for (const f of files) {
    for (const line of fs.readFileSync(path.join(outDir, f), 'utf8').split('\n')) {
      if (line.trim()) events.push(JSON.parse(line) as AuditLine);
    }
  }
  return events;
}

// ---------- shared fixtures ----------

const universe: UniverseAsset[] = [
  'LONGA',
  'BANDB',
  'NOPE',
  'ENTA',
  'ENTB',
  'ENTC',
  'SHRT',
].map((symbol) => ({
  symbol,
  name: symbol,
  exchange: 'NASDAQ',
  tradable: true,
  shortable: symbol !== 'SHRT',
  easy_to_borrow: symbol !== 'SHRT', // SHRT trips the borrow hard gate
}));
writeJson(data.universePath(), universe);

// Episode 1 (H): LONGA long entry fills on D, judge exit at D+1 18:30;
// BANDB long entry stays outside its band until D+1 18:30 (boundary test).
const prep1 = writePrep(
  EP1.day,
  'H',
  [...verdictsFor('LONGA', 'long', 0.8), ...verdictsFor('BANDB', 'long', 0.7)],
  {
    LONGA: { lastPrice: 50, avgDollarVolume20d: 1e9 },
    BANDB: { lastPrice: 200, avgDollarVolume20d: 1e9 },
  },
);
const EXIT_TICK = iso(EP1.next, '18:30:00');
for (const tick of enabledTicks(EP1.day, EP1.next)) {
  const late = tick >= EXIT_TICK;
  writeQuote('LONGA', tick, late ? 45.0 : 49.95, late ? 45.1 : 50.05);
  writeTrade('LONGA', tick, late ? 45.02 : 50.0);
  // BANDB last 210 is outside its band [194, 202] until D+1 18:30, then 200
  // (inside) — by which time only the synthetic empty D+1 thesis can act.
  writeQuote('BANDB', tick, 209.9, 210.1);
  writeTrade('BANDB', tick, late ? 200.0 : 210.0);
}
writeMinuteBars('LONGA', EP1.day, [
  { t: iso(EP1.day, '17:01:00'), o: 50, h: 50.2, l: 49.9, c: 50, v: 1000 },
  { t: iso(EP1.day, '17:02:00'), o: 50, h: 50.2, l: 49.9, c: 50, v: 1000 },
  { t: iso(EP1.day, '17:03:00'), o: 50, h: 50.2, l: 49.9, c: 50, v: 1000 },
]);
writeMinuteBars('LONGA', EP1.next, [
  { t: iso(EP1.next, '18:31:00'), o: 45, h: 45.5, l: 44.8, c: 45.2, v: 1000 },
  { t: iso(EP1.next, '18:32:00'), o: 45, h: 45.5, l: 44.8, c: 45.2, v: 1000 },
]);

// Episode 2 (R): full no-trade — conviction 0.5 stays below the 0.65 default.
const prep2 = writePrep(EP2.day, 'R', verdictsFor('NOPE', 'long', 0.5), {
  NOPE: { lastPrice: 100, avgDollarVolume20d: 1e9 },
});

// Episode 3 (R): three max-conviction longs -> third rejected by the REAL
// riskCheck daily-deploy cap; SHRT short filtered by the borrow hard gate.
const prep3 = writePrep(
  EP3.day,
  'R',
  [
    ...verdictsFor('ENTA', 'long', 1.0),
    ...verdictsFor('ENTB', 'long', 1.0),
    ...verdictsFor('ENTC', 'long', 1.0),
    ...verdictsFor('SHRT', 'short', 1.0),
  ],
  {
    ENTA: { lastPrice: 100, avgDollarVolume20d: 1e9 },
    ENTB: { lastPrice: 100, avgDollarVolume20d: 1e9 },
    ENTC: { lastPrice: 100, avgDollarVolume20d: 1e9 },
    SHRT: { lastPrice: 100, avgDollarVolume20d: 1e9 },
  },
);
// Quotes only at the first tick: the rejection happens exactly once, and the
// ET-midnight deploy reset cannot re-place ENTC on D+1 (no quote -> skip).
const EP3_TICK1 = iso(EP3.day, '17:00:00');
for (const symbol of ['ENTA', 'ENTB', 'ENTC']) {
  writeQuote(symbol, EP3_TICK1, 99.95, 100.05);
  writeTrade(symbol, EP3_TICK1, 100.0);
}
for (const symbol of ['ENTA', 'ENTB']) {
  writeMinuteBars(symbol, EP3.day, [
    { t: iso(EP3.day, '17:01:00'), o: 100, h: 100.1, l: 99.5, c: 99.5, v: 1000 },
    { t: iso(EP3.day, '17:02:00'), o: 100, h: 100.1, l: 99.5, c: 99.5, v: 1000 },
  ]);
}

const DIR1 = path.join(OUT_ROOT, 'itest', EP1.day);
const DIR1_REPLAY = path.join(OUT_ROOT, 'itest-replay', EP1.day);
const DIR2 = path.join(OUT_ROOT, 'itest', EP2.day);
const DIR3 = path.join(OUT_ROOT, 'itest', EP3.day);

const ep1Stub = (): LlmClient =>
  makeStub({
    narratives: [
      {
        ticker: 'LONGA',
        narrative: 'Long LONGA narrative.',
        invalidation_conditions: ['LONGA breaks 47 (merged)'],
      },
      {
        ticker: 'BANDB',
        narrative: 'Long BANDB narrative.',
        invalidation_conditions: ['BANDB merged condition'],
      },
    ],
    judge: (ticker, asOf) =>
      ticker === 'LONGA' && asOf === EXIT_TICK
        ? { proceed: false, exitPosition: true, reasons: ['LONGA invalidation triggered'] }
        : { proceed: true, exitPosition: false, reasons: ['hold'] },
  });

afterAll(() => {
  process.chdir(ORIGINAL_CWD);
  fs.rmSync(ROOT, { recursive: true, force: true });
});

// ---------- tests (sequential; episode 1 seeds the cache its replay uses) ----------

let result1: EpisodeResult;

describe('episode 1: fills, judge exit, and the D+1 17:05 episode boundary', () => {
  it('runs the production tick sequence and produces the expected round trip', async () => {
    result1 = await runInProcess(DIR1, episodeArgs(EP1.day, 'H', prep1, DIR1), ep1Stub());

    expect(result1.day).toBe(EP1.day);
    expect(result1.stratum).toBe('H');
    expect(result1.abstained).toBe(false);
    expect(result1.ordersPlaced).toBe(2); // LONGA entry + LONGA exit
    expect(result1.ordersFilled).toBe(2);
    expect(result1.rejectionsByReason).toEqual({});
    expect(result1.judgeVetoes).toBe(0);
    expect(result1.halts).toBe(0);
    expect(result1.danglingAtFlatten).toBe(0);

    expect(result1.trades).toHaveLength(1);
    const trade = result1.trades[0]!;
    expect(trade.ticker).toBe('LONGA');
    expect(trade.side).toBe('long');
    // qty = floor(targetNotional 1600 / limit 50.05) = 31
    expect(trade.qty).toBe(31);
    expect(trade.entryPrice).toBe(50.05);
    expect(trade.exitPrice).toBe(45);
    expect(trade.pnlUsd).toBeCloseTo(31 * (45 - 50.05), 8);
    expect(trade.feesUsd).toBeCloseTo(31 * 0.000195, 10); // TAF only (pre-2026-04-06)
    expect(trade.borrowUsd).toBe(0);
    expect(trade.exitReason).toBe('judge exit: LONGA invalidation triggered');
    expect(trade.analystsAgreeing).toEqual([...ANALYSTS]);

    // prep cost (0.002 at the test price table) plus episode judge/narrative tokens
    expect(result1.llmCostUsd).toBeGreaterThan(0.002);

    // result file matches the returned result
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(DIR1, 'episode-result.json'), 'utf8'),
    ) as EpisodeResult;
    expect(onDisk).toEqual(result1);
  });

  it('deterministic stop fires before the judge when loss exceeds max_position_loss_pct', async () => {
    // Same LONGA setup (entry 50.05, exit tape at 45 = -10.1%) but with the
    // default 8% stop: the stop must exit, bypassing the judge, so the exit
    // reason is the stop string, not the judge's invalidation text.
    const stopDir = path.join(ROOT, 'ep1-stop');
    fs.mkdirSync(stopDir, { recursive: true });
    const stopCfg = ConfigSchema.parse({ max_position_loss_pct: 8 });
    const res = await runInProcess(
      stopDir,
      episodeArgs(EP1.day, 'H', prep1, stopDir, stopCfg),
      ep1Stub(),
    );
    expect(res.trades).toHaveLength(1);
    expect(res.trades[0]!.exitReason).toContain('stop: unrealized loss');
    expect(res.trades[0]!.exitReason).toContain('max_position_loss_pct 8%');
  });

  it('applies the production narrative merge and writes both thesis files', () => {
    const thesis = JSON.parse(
      fs.readFileSync(path.join(DIR1, 'out', `thesis-${EP1.day}.json`), 'utf8'),
    ) as { entries: { ticker: string; narrative: string; invalidationConditions: string[] }[] };
    expect(thesis.entries.map((e) => e.ticker)).toEqual(['LONGA', 'BANDB']);
    expect(thesis.entries[0]!.narrative).toBe('Long LONGA narrative.');
    // synthesizer's merged list OVERRIDES the computed invalidation conditions
    expect(thesis.entries[0]!.invalidationConditions).toEqual(['LONGA breaks 47 (merged)']);

    const synthetic = JSON.parse(
      fs.readFileSync(path.join(DIR1, 'out', `thesis-${EP1.next}.json`), 'utf8'),
    ) as { entries: unknown[]; generatedAt: string; date: string };
    expect(synthetic.date).toBe(EP1.next);
    expect(synthetic.entries).toEqual([]);
    expect(synthetic.generatedAt).toBe(iso(EP1.next, '17:05:00'));
  });

  it('boundary: no D-thesis entry after D+1 17:15, judge exit still fires at 18:30', () => {
    const events = readAudit(DIR1);

    // BANDB's entry was live (band-gated) before the boundary...
    expect(
      events.some(
        (e) =>
          e.kind === 'tick' &&
          e.data.stage === 'skip' &&
          e.data.ticker === 'BANDB' &&
          e.data.reason === 'last price outside limit band',
      ),
    ).toBe(true);
    // ...but its band crossing at D+1 18:30 never becomes an order.
    expect(events.some((e) => e.kind === 'proposed_order' && e.data.ticker === 'BANDB')).toBe(
      false,
    );

    // From the first tick governed by the synthetic D+1 thesis onward, no
    // entry order is ever proposed; the judge exit for the held position is.
    const boundaryIdx = events.findIndex(
      (e) => e.kind === 'tick' && e.data.stage === 'tick_summary' && e.data.thesisDate === EP1.next,
    );
    expect(boundaryIdx).toBeGreaterThan(-1);
    const afterBoundary = events.slice(boundaryIdx);
    expect(
      afterBoundary.some((e) => e.kind === 'proposed_order' && e.data.intent === 'entry'),
    ).toBe(false);
    expect(afterBoundary.some((e) => e.kind === 'exit' && e.data.ticker === 'LONGA')).toBe(true);
    expect(
      afterBoundary.some((e) => e.kind === 'proposed_order' && e.data.intent === 'exit'),
    ).toBe(true);
  });

  it('replays deterministically from the disk caches alone (zero fresh LLM calls)', async () => {
    const counter = { calls: 0 };
    const args = episodeArgs(EP1.day, 'H', prep1, DIR1_REPLAY);
    const replay = await runInProcess(DIR1_REPLAY, args, throwingClient(counter));
    expect(counter.calls).toBe(0);
    expect(replay).toEqual(result1);
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(DIR1_REPLAY, 'episode-result.json'), 'utf8'),
    ) as EpisodeResult;
    expect(onDisk).toEqual(result1);
  });
});

describe('episode 2: full no-trade episode', () => {
  it('abstains below the conviction threshold and never touches the LLM', async () => {
    const counter = { calls: 0 };
    const result = await runInProcess(
      DIR2,
      episodeArgs(EP2.day, 'R', prep2, DIR2),
      throwingClient(counter),
    );
    expect(counter.calls).toBe(0); // no entries -> no narrative call, no judge calls
    expect(result.abstained).toBe(true);
    expect(result.trades).toEqual([]);
    expect(result.ordersPlaced).toBe(0);
    expect(result.ordersFilled).toBe(0);
    expect(result.rejectionsByReason).toEqual({});
    expect(result.judgeVetoes).toBe(0);
    expect(result.halts).toBe(0);
    expect(result.danglingAtFlatten).toBe(0);
    // prep-only cost: 1000 in + 500 out tokens at $1/$2 per MTok
    expect(result.llmCostUsd).toBeCloseTo(0.002, 12);

    const thesis = JSON.parse(
      fs.readFileSync(path.join(DIR2, 'out', `thesis-${EP2.day}.json`), 'utf8'),
    ) as { entries: unknown[]; skipped: { ticker: string; reason: string }[] };
    expect(thesis.entries).toEqual([]);
    expect(thesis.skipped).toEqual([{ ticker: 'NOPE', reason: 'below threshold' }]);
    // the boundary correction still writes the synthetic D+1 thesis
    expect(fs.existsSync(path.join(DIR2, 'out', `thesis-${EP2.next}.json`))).toBe(true);
  });
});

describe('episode 3: risk-gate rejection and the borrow hard gate', () => {
  it('records the daily-deploy rejection and the not-shortable rejection', async () => {
    const result = await runInProcess(
      DIR3,
      episodeArgs(EP3.day, 'R', prep3, DIR3),
      makeStub({ narratives: 'throw' }), // exercises the production fallback merge path
    );

    // Third entry: 2 x $1900.95 already deployed + $1900.95 > 10% of $50k.
    expect(result.rejectionsByReason).toEqual({
      'exceeds max daily deployment': 1,
      'not shortable': 1,
    });
    expect(result.ordersPlaced).toBe(2);
    expect(result.ordersFilled).toBe(2);
    expect(result.abstained).toBe(false);
    expect(result.danglingAtFlatten).toBe(2); // ENTA + ENTB force-flattened

    expect(result.trades).toHaveLength(2);
    for (const trade of result.trades) {
      expect(['ENTA', 'ENTB']).toContain(trade.ticker);
      expect(trade.side).toBe('long');
      expect(trade.qty).toBe(19); // floor(2000 / 100.05)
      expect(trade.entryPrice).toBe(100.05);
      expect(trade.exitPrice).toBe(99.5); // last minute-bar close before 20:00
      expect(trade.pnlUsd).toBeCloseTo(19 * (99.5 - 100.05), 8);
      expect(trade.feesUsd).toBeCloseTo(19 * 0.000195, 10);
      expect(trade.exitReason).toBe('force-flatten');
      expect(trade.analystsAgreeing).toEqual([...ANALYSTS]);
    }

    // Borrow gate removed SHRT before the thesis was written; narrative
    // fallback kept the computed invalidation conditions.
    const thesis = JSON.parse(
      fs.readFileSync(path.join(DIR3, 'out', `thesis-${EP3.day}.json`), 'utf8'),
    ) as { entries: { ticker: string; narrative: string; invalidationConditions: string[] }[] };
    expect(thesis.entries.map((e) => e.ticker)).toEqual(['ENTA', 'ENTB', 'ENTC']);
    expect(thesis.entries[0]!.invalidationConditions).toEqual(['ENTA invalidation']);
    expect(thesis.entries[0]!.narrative).toContain('evidence ENTA');
  });
});

describe('report aggregation (driver writeReport)', () => {
  it('renders REPORT.md over the three episode results', async () => {
    vi.resetModules();
    const driver = await import('../scripts/backtest.js');
    const reportFile = driver.writeReport('itest', { tbillAnnualRate: 0.04 });
    const report = fs.readFileSync(reportFile, 'utf8');
    expect(report).toContain('# Backtest REPORT — 5-hour episode protocol');
    // abstention from stratum R only: 1 of 2 R episodes abstained
    expect(report).toContain('Abstention rate (stratum R only, n=2): **50.0%** (1/2)');
    expect(report).toContain('force-flatten');
    expect(report).toContain('not shortable');
    // Governance gate: with min_trades_for_economic_claim (config default 50)
    // and only a handful of trades, the report refuses an economic PASS/FAIL
    // verdict rather than over-claiming from small n.
    expect(report).toContain('INSUFFICIENT N — no economic verdict');
    expect(report).not.toContain('**Economic bar: PASSES**');
  });
});
