// T8 — LLM hindsight-leakage probe (full plan §0; 5h plan "leakage machinery").
//
// Two arms, each over (day, ticker, data) pairs:
//   arm1: randomly sampled candidate pairs + hardcoded positive controls
//   arm2: every pair the backtest actually traded (coverage must be 100%;
//         its power statement comes from arm1's positive controls)
//
// Each pair runs the REAL single-candidate verdict prompt — captured verbatim
// from the production runVerdicts via a capture-only client, so the prompt
// shape cannot drift from production — twice: once unmasked, once with
// price/percent numerics in the data section replaced by 'X.XX' (the verdict
// instructions are left untouched; tickers and dates are preserved). A cheap
// structured classifier call over the two verdict outputs answers
// {references_unstated_outcomes, conviction_divergence}; the pair trips iff
// references_unstated_outcomes OR conviction_divergence > 0.3.
//
// Positive controls are famous pre-cutoff event days that MUST trip; if any
// fails to trip the arm is reported powerless (a null result then bounds
// nothing). The Wilson interval helper is deliberately duplicated here rather
// than imported from metrics, to avoid cross-module coupling.
import type { AnalystName, CandidateFile } from '../types.js';
import type { Config } from '../config.js';
import { callStructured, type LlmClient, type StructuredCallOpts } from '../agents/llm.js';
import { runVerdicts, type DailyBar, type VerdictData } from '../agents/verdicts.js';
import { ANALYST_SYSTEM, VERDICT_INSTRUCTIONS } from '../agents/prompts.js';
import type { NewsItem } from '../agents/nominate.js';
import { WINDOW } from './data.js';

// ---------- shapes ----------

export interface ProbePairData {
  lastPrice: number;
  avgDollarVolume20d: number;
  nominatedBy?: { analyst: AnalystName; reason: string }[];
  bars: DailyBar[];
  news: NewsItem[];
}

export interface ProbePair {
  day: string; // YYYY-MM-DD
  ticker: string;
  data: ProbePairData;
}

export interface ClassifierResult {
  references_unstated_outcomes: boolean;
  conviction_divergence: number; // 0..1
}

export interface PairResult {
  day: string;
  ticker: string;
  control: boolean;
  tripped: boolean;
  classifier: ClassifierResult;
  /** Raw verdict tool outputs, kept for the report's validity appendix. */
  verdicts?: { masked: unknown; unmasked: unknown };
  /** Set when the pair could not be evaluated; excluded from n/rate. */
  error?: string;
}

export interface ArmResult {
  arm: 'arm1' | 'arm2';
  n: number; // completed non-control pairs
  tripped: number;
  rate: number;
  binomial95: [number, number];
  powerless: boolean;
  errors: number;
  pairs: PairResult[];
  controls: PairResult[];
}

export interface ProbeDeps {
  cfg: Config;
  client: LlmClient;
  /** Analyst persona whose verdict prompt is probed. Default 'sentiment'. */
  analyst?: AnalystName;
  /** Model for the classifier call. Default cfg.model.executor. */
  classifierModel?: string;
  concurrency?: number; // default 4
  log?: (msg: string) => void;
}

// ---------- masking ----------

// Dates and ISO timestamps are preserved verbatim (they identify the trading
// day, which the model legitimately knows); everything else numeric becomes
// 'X.XX'. A number preceded by a letter/digit/dot is part of an identifier
// (e.g. the JSON key "pctChange1d") and is left alone.
const DATE_PART = String.raw`\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?`;
const NUMBER_PART = String.raw`-?\d+(?:,\d{3})*(?:\.\d+)?`;
const MASK_RE = new RegExp(`(${DATE_PART})|(?<![A-Za-z0-9.])${NUMBER_PART}`, 'g');

/** Replace price/percent numerics with 'X.XX'; keep tickers and dates. */
export function maskNumerics(text: string): string {
  return text.replace(MASK_RE, (match, date: string | undefined) =>
    date !== undefined ? match : 'X.XX',
  );
}

/**
 * Mask only the data section of a captured verdict user prompt: the
 * production VERDICT_INSTRUCTIONS prefix is left intact so both variants ask
 * exactly the same question of exactly the same prompt.
 */
export function maskVerdictUser(user: string): string {
  const prefix = `${VERDICT_INSTRUCTIONS}\n\n`;
  return user.startsWith(prefix)
    ? prefix + maskNumerics(user.slice(prefix.length))
    : maskNumerics(user);
}

// ---------- detection ----------

/** A pair trips iff the masked verdict references unstated outcomes, or the two runs' convictions diverge by more than 0.3. */
export function pairTrips(c: ClassifierResult): boolean {
  return c.references_unstated_outcomes || c.conviction_divergence > 0.3;
}

// ---------- binomial CI (local by design; see header) ----------

/** Wilson score 95% interval for k successes out of n. n=0 -> [0, 1]. */
export function wilson95(k: number, n: number): [number, number] {
  if (n === 0) return [0, 1];
  const z = 1.959963984540054;
  const z2 = z * z;
  const p = k / n;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z / denom) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  // At k=0 the lower bound is algebraically exactly 0, and at k=n the upper
  // bound exactly 1; pin them so FP rounding cannot leak (e.g. 0.999...9).
  const lo = k === 0 ? 0 : Math.max(0, center - half);
  const hi = k === n ? 1 : Math.min(1, center + half);
  return [lo, hi];
}

// ---------- real verdict prompt, captured from production code ----------

/**
 * Runs the REAL runVerdicts against a capture-only client and returns the
 * exact StructuredCallOpts production would send for this analyst and this
 * single-candidate set (model, system, user, tool name/schema, max tokens).
 * No prompt text is mirrored in this module.
 */
async function captureVerdictOpts(
  cfg: Config,
  pair: ProbePair,
  analyst: AnalystName,
): Promise<StructuredCallOpts> {
  const ticker = pair.ticker.toUpperCase();
  const candidateFile: CandidateFile = {
    date: pair.day,
    candidates: [
      {
        ticker,
        nominatedBy: pair.data.nominatedBy ?? [],
        lastPrice: pair.data.lastPrice,
        avgDollarVolume20d: pair.data.avgDollarVolume20d,
      },
    ],
    rejected: [],
  };
  const data: VerdictData = {
    barsBySymbol: { [ticker]: pair.data.bars },
    newsBySymbol: { [ticker]: pair.data.news },
  };

  let captured: StructuredCallOpts | undefined;
  const capture: LlmClient = {
    messages: {
      create: async (params) => {
        if (captured === undefined && params.system === ANALYST_SYSTEM[analyst]) {
          const first = params.messages[0];
          const tool = params.tools?.[0] as
            | { name: string; input_schema: Record<string, unknown> }
            | undefined;
          if (typeof first?.content === 'string' && tool !== undefined) {
            captured = {
              model: params.model,
              system: params.system,
              user: first.content,
              toolName: tool.name,
              toolSchema: tool.input_schema,
              maxTokens: params.max_tokens,
            };
          }
        }
        // Not retryable by callStructured, so this settles immediately.
        throw new Error('probe capture client: capture only');
      },
    },
  };
  await runVerdicts(cfg, candidateFile, data, capture);
  if (captured === undefined) {
    throw new Error(`probe: failed to capture verdict prompt for ${ticker} ${pair.day}`);
  }
  return captured;
}

// ---------- classifier ----------

const CLASSIFIER_TOOL = 'submit_probe_classification';

const CLASSIFIER_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    references_unstated_outcomes: {
      type: 'boolean',
      description:
        'true if verdict A cites specific prices, price levels, percentage moves, or concrete event outcomes that cannot have come from its masked input',
    },
    conviction_divergence: {
      type: 'number',
      minimum: 0,
      maximum: 1,
      description: 'absolute difference between the two verdicts conviction values',
    },
  },
  required: ['references_unstated_outcomes', 'conviction_divergence'],
  additionalProperties: false,
};

const CLASSIFIER_SYSTEM = `You evaluate two structured trading verdicts produced for the same ticker by the same analyst prompt. Verdict A came from an input whose price and percentage numerics were masked (every such numeric replaced with X.XX); verdict B came from the identical input unmasked. Judge strictly from the verdict texts provided; do not use any outside knowledge of the ticker.`;

function sanitizeClassifier(raw: unknown): ClassifierResult {
  const rec = (raw ?? {}) as Record<string, unknown>;
  const d =
    typeof rec.conviction_divergence === 'number'
      ? rec.conviction_divergence
      : Number(rec.conviction_divergence);
  return {
    references_unstated_outcomes: rec.references_unstated_outcomes === true,
    conviction_divergence: Number.isFinite(d) ? Math.min(1, Math.max(0, d)) : 0,
  };
}

async function classifyPair(
  deps: ProbeDeps,
  ticker: string,
  maskedOut: unknown,
  unmaskedOut: unknown,
): Promise<ClassifierResult> {
  const user = [
    `Ticker: ${ticker.toUpperCase()}`,
    'Verdict A (from masked input), JSON:',
    JSON.stringify(maskedOut),
    'Verdict B (from unmasked input), JSON:',
    JSON.stringify(unmaskedOut),
    'Report through the tool:',
    '- references_unstated_outcomes: true if verdict A states specific prices, price levels, percentage moves, or concrete event outcomes. Its input had every such numeric masked to X.XX, so any specific figure or outcome it cites was supplied from memory, not the data.',
    "- conviction_divergence: the absolute difference between the two verdicts' conviction values (use 0 if either conviction is missing).",
  ].join('\n\n');

  const raw = await callStructured<unknown>(
    {
      model: deps.classifierModel ?? deps.cfg.model.executor,
      system: CLASSIFIER_SYSTEM,
      user,
      toolName: CLASSIFIER_TOOL,
      toolSchema: CLASSIFIER_SCHEMA,
      maxTokens: 500,
    },
    deps.client,
  );
  return sanitizeClassifier(raw);
}

// ---------- per-pair run ----------

async function runPair(pair: ProbePair, control: boolean, deps: ProbeDeps): Promise<PairResult> {
  const ticker = pair.ticker.toUpperCase();
  try {
    const analyst = deps.analyst ?? 'sentiment';
    const opts = await captureVerdictOpts(deps.cfg, pair, analyst);
    const unmasked = await callStructured<unknown>(opts, deps.client);
    const masked = await callStructured<unknown>(
      { ...opts, user: maskVerdictUser(opts.user) },
      deps.client,
    );
    const classifier = await classifyPair(deps, ticker, masked, unmasked);
    const tripped = pairTrips(classifier);
    deps.log?.(
      `probe ${control ? 'control' : 'pair'} ${ticker} ${pair.day}: ${tripped ? 'TRIPPED' : 'clean'}`,
    );
    return {
      day: pair.day,
      ticker,
      control,
      tripped,
      classifier,
      verdicts: { masked, unmasked },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    deps.log?.(`probe ${control ? 'control' : 'pair'} ${ticker} ${pair.day}: ERROR ${msg}`);
    return {
      day: pair.day,
      ticker,
      control,
      tripped: false,
      classifier: { references_unstated_outcomes: false, conviction_divergence: 0 },
      error: msg,
    };
  }
}

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

// ---------- arms ----------

/**
 * Core arm runner. Rate/CI cover completed non-control pairs only; errored
 * pairs are excluded from n and counted in `errors` (the report must treat
 * errors as incomplete coverage, never as clean pairs). powerless is true iff
 * any provided control fails to trip (an errored control counts as a failed
 * control — power was not demonstrated).
 */
export async function runProbeArm(
  arm: 'arm1' | 'arm2',
  pairs: ProbePair[],
  controls: ProbePair[],
  deps: ProbeDeps,
): Promise<ArmResult> {
  const limit = deps.concurrency ?? 4;
  const controlResults = await mapPool(controls, limit, (p) => runPair(p, true, deps));
  const pairResults = await mapPool(pairs, limit, (p) => runPair(p, false, deps));
  const completed = pairResults.filter((r) => r.error === undefined);
  const tripped = completed.filter((r) => r.tripped).length;
  const n = completed.length;
  return {
    arm,
    n,
    tripped,
    rate: n === 0 ? 0 : tripped / n,
    binomial95: wilson95(tripped, n),
    powerless: controlResults.some((r) => !r.tripped),
    errors: [...controlResults, ...pairResults].filter((r) => r.error !== undefined).length,
    pairs: pairResults,
    controls: controlResults,
  };
}

/** Arm 1: sampled candidate pairs + positive controls (no run dependency). */
export async function arm1(
  candidatePairs: ProbePair[],
  controls: ProbePair[],
  deps: ProbeDeps,
): Promise<ArmResult> {
  return runProbeArm('arm1', candidatePairs, controls, deps);
}

/**
 * Arm 2: every (date, ticker) pair the backtest actually traded. Runs no
 * controls of its own; powerless is therefore always false here and the
 * arm's power statement is inherited from arm1's positive controls (the
 * report may only assert the leakage bound if both arms completed).
 */
export async function arm2(tradedPairs: ProbePair[], deps: ProbeDeps): Promise<ArmResult> {
  return runProbeArm('arm2', tradedPairs, [], deps);
}

// ---------- positive controls ----------

// Three famous pre-cutoff event days. Every model in use knows what happened
// next on these days; if the probe cannot detect leakage HERE, it has no
// power anywhere. Prices are approximate (the masked variant hides them
// anyway); days and headlines identify the events.
export const POSITIVE_CONTROLS: ProbePair[] = [
  {
    // NVDA Q1 FY2025 earnings after the close 2024-05-22; next session the
    // stock surged ~9% and first closed above $1,000 (pre-split).
    day: '2024-05-22',
    ticker: 'NVDA',
    data: {
      lastPrice: 949.5,
      avgDollarVolume20d: 35_000_000_000,
      nominatedBy: [{ analyst: 'fundamental', reason: 'fiscal Q1 earnings due after the close' }],
      bars: [
        { t: '2024-05-15T04:00:00Z', o: 903.2, h: 924.9, l: 900.4, c: 921.4, v: 42_000_000 },
        { t: '2024-05-16T04:00:00Z', o: 922.3, h: 944.7, l: 916.5, c: 943.6, v: 39_000_000 },
        { t: '2024-05-17T04:00:00Z', o: 942.1, h: 949.2, l: 923.6, c: 924.8, v: 35_000_000 },
        { t: '2024-05-20T04:00:00Z', o: 928.4, h: 949.9, l: 926.2, c: 947.8, v: 34_000_000 },
        { t: '2024-05-21T04:00:00Z', o: 946.1, h: 954.0, l: 938.4, c: 953.9, v: 36_000_000 },
        { t: '2024-05-22T04:00:00Z', o: 950.0, h: 962.1, l: 940.9, c: 949.5, v: 52_000_000 },
      ],
      news: [
        {
          headline: 'Nvidia set to report fiscal first-quarter results after the close',
          summary:
            'Investors brace for the AI bellwether earnings report and its data-center revenue guidance.',
          symbols: ['NVDA'],
          created_at: '2024-05-22T13:30:00Z',
          source: 'newswire',
        },
        {
          headline: 'Options market implies an outsized move in Nvidia shares on earnings',
          summary: 'Derivatives pricing points to a large post-earnings swing in either direction.',
          symbols: ['NVDA'],
          created_at: '2024-05-22T15:45:00Z',
          source: 'newswire',
        },
      ],
    },
  },
  {
    // Friday 2024-08-02: weak July payrolls after the BOJ hike; the next
    // session (Monday 2024-08-05) was the global yen-carry-unwind crash.
    day: '2024-08-02',
    ticker: 'SPY',
    data: {
      lastPrice: 532.9,
      avgDollarVolume20d: 40_000_000_000,
      nominatedBy: [{ analyst: 'macro', reason: 'payrolls miss plus yen carry stress' }],
      bars: [
        { t: '2024-07-29T04:00:00Z', o: 544.6, h: 546.4, l: 542.3, c: 544.8, v: 45_000_000 },
        { t: '2024-07-30T04:00:00Z', o: 545.3, h: 546.1, l: 539.5, c: 542.0, v: 52_000_000 },
        { t: '2024-07-31T04:00:00Z', o: 546.0, h: 553.4, l: 545.2, c: 550.8, v: 63_000_000 },
        { t: '2024-08-01T04:00:00Z', o: 552.6, h: 554.9, l: 539.4, c: 543.0, v: 76_000_000 },
        { t: '2024-08-02T04:00:00Z', o: 537.9, h: 538.2, l: 528.6, c: 532.9, v: 91_000_000 },
      ],
      news: [
        {
          headline: 'July payrolls come in far below expectations as unemployment rate rises',
          summary: 'The jobs report stokes fears the economy is slowing faster than forecast.',
          symbols: ['SPY'],
          created_at: '2024-08-02T12:45:00Z',
          source: 'newswire',
        },
        {
          headline: 'Bank of Japan rate hike squeezes yen-funded carry trades',
          summary: 'A stronger yen pressures investors who borrowed cheaply in Japan to buy risk assets.',
          symbols: ['SPY'],
          created_at: '2024-08-01T09:00:00Z',
          source: 'newswire',
        },
      ],
    },
  },
  {
    // TSLA Q1 2024 earnings after the close 2024-04-23; despite a big miss
    // the stock popped ~12% the next session on the cheaper-models timeline.
    day: '2024-04-23',
    ticker: 'TSLA',
    data: {
      lastPrice: 144.68,
      avgDollarVolume20d: 15_000_000_000,
      nominatedBy: [{ analyst: 'fundamental', reason: 'Q1 earnings due after the bell' }],
      bars: [
        { t: '2024-04-16T04:00:00Z', o: 156.7, h: 158.2, l: 153.8, c: 157.1, v: 98_000_000 },
        { t: '2024-04-17T04:00:00Z', o: 157.6, h: 158.3, l: 153.9, c: 155.4, v: 82_000_000 },
        { t: '2024-04-18T04:00:00Z', o: 151.3, h: 152.2, l: 148.7, c: 149.9, v: 96_000_000 },
        { t: '2024-04-19T04:00:00Z', o: 148.9, h: 150.9, l: 146.2, c: 147.0, v: 87_000_000 },
        { t: '2024-04-22T04:00:00Z', o: 140.6, h: 144.4, l: 138.8, c: 142.0, v: 108_000_000 },
        { t: '2024-04-23T04:00:00Z', o: 143.3, h: 147.3, l: 141.1, c: 144.68, v: 124_000_000 },
      ],
      news: [
        {
          headline: 'Tesla to report first-quarter earnings after the bell',
          summary: 'Analysts expect a steep decline in deliveries and margins versus last year.',
          symbols: ['TSLA'],
          created_at: '2024-04-23T12:00:00Z',
          source: 'newswire',
        },
        {
          headline: 'Tesla cuts prices across major markets ahead of results',
          summary: 'Another round of price cuts deepens concern about demand and margins.',
          symbols: ['TSLA'],
          created_at: '2024-04-22T08:30:00Z',
          source: 'newswire',
        },
      ],
    },
  },
];

// ---------- cutoff verification note (full plan §0) ----------

/** True iff any in-window trading day falls on or before the cutoff. */
export function cutoffIntrudes(cutoffYmd: string, windowStartYmd: string = WINDOW.start): boolean {
  return windowStartYmd <= cutoffYmd;
}

export interface CutoffNote {
  models: string[];
  window: { start: string; end: string };
  cutoffs: { model: string; cutoff: string | null; intrudes: boolean | null }[];
  headlineRule: string;
}

/**
 * Records the models in use and, for each, its published knowledge cutoff
 * (supplied by the operator after verification against vendor docs — this
 * module does not guess cutoffs) plus whether that cutoff intrudes on the
 * backtest window. cutoff null = not yet verified.
 */
export function cutoffNote(cfg: Config, verifiedCutoffs: Record<string, string> = {}): CutoffNote {
  const models = [...new Set([cfg.model.analysts, cfg.model.synthesizer, cfg.model.executor])];
  return {
    models,
    window: { start: WINDOW.start, end: WINDOW.end },
    cutoffs: models.map((model) => {
      const cutoff = verifiedCutoffs[model] ?? null;
      return { model, cutoff, intrudes: cutoff === null ? null : cutoffIntrudes(cutoff) };
    }),
    headlineRule:
      'if any in-window trading day falls on or before any used model cutoff, the headline result becomes a fresh-start run over the strictly post-cutoff sub-window; the full-window run is reported second, labeled leakage-contaminated',
  };
}
