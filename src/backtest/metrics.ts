// Metrics and REPORT.md generation for the 5-hour episode backtest.
// Everything in this module is pure and deterministic: no I/O, no wall clock,
// no randomness beyond the seeded mulberry32 bootstrap. Economic reporting
// follows the 5h protocol rules: the headline is stratum R only; H economics
// are separately labeled; a design-weighted full-window estimate (H censused
// at weight 20/124, complement from R at 104/124) is computed on request.
import { ANALYSTS, type AnalystName } from '../types.js';

// ---------- episode-result contract (written by the driver, read here) ----------

export interface EpisodeTrade {
  ticker: string;
  side: 'long' | 'short';
  qty: number;
  entryPrice: number;
  exitPrice: number;
  feesUsd: number;
  borrowUsd: number;
  /**
   * Signed price P&L of the round trip (long: qty*(exit-entry); short:
   * qty*(entry-exit)), GROSS of fees and borrow. Net trade P&L is derived
   * here as pnlUsd - feesUsd - borrowUsd; every economic number in this
   * module uses the net figure.
   */
  pnlUsd: number;
  analystsAgreeing: string[];
  exitReason: string;
}

export interface EpisodeResult {
  day: string; // YYYY-MM-DD (thesis day D)
  stratum: 'R' | 'H';
  trades: EpisodeTrade[];
  abstained: boolean; // empty thesis for day D
  ordersPlaced: number;
  ordersFilled: number;
  rejectionsByReason: Record<string, number>;
  judgeVetoes: number;
  halts: number;
  danglingAtFlatten: number; // open positions force-flattened at D+1 20:00
  llmCostUsd: number;
}

export const tradeNetUsd = (t: EpisodeTrade): number => t.pnlUsd - t.feesUsd - t.borrowUsd;
export const episodeNetUsd = (e: EpisodeResult): number =>
  e.trades.reduce((sum, t) => sum + tradeNetUsd(t), 0);

// ---------- deterministic primitives ----------

/** mulberry32 PRNG: 32-bit state, uniform floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const DEFAULT_BOOTSTRAP_DRAWS = 10_000;
export const DEFAULT_BOOTSTRAP_SEED = 20260708;

export interface BootstrapCi {
  low: number;
  high: number;
  level: number;
  draws: number;
  seed: number;
}

/**
 * Seeded episode-resampling bootstrap CI on the MEAN of `values`.
 * Consumption order is fixed (draw-major, index-minor) so a given seed
 * always yields the same interval. Percentiles are empirical:
 * low = sorted[floor(draws*alpha)], high = sorted[ceil(draws*(1-alpha))-1].
 */
export function bootstrapCi(
  values: readonly number[],
  draws: number = DEFAULT_BOOTSTRAP_DRAWS,
  seed: number = DEFAULT_BOOTSTRAP_SEED,
  level = 0.95,
): BootstrapCi {
  if (values.length === 0) throw new Error('bootstrapCi requires at least one value');
  const rand = mulberry32(seed);
  const n = values.length;
  const means = new Array<number>(draws);
  for (let d = 0; d < draws; d++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += values[Math.floor(rand() * n)]!;
    means[d] = sum / n;
  }
  means.sort((a, b) => a - b);
  const alpha = (1 - level) / 2;
  const lowIdx = Math.min(draws - 1, Math.floor(draws * alpha));
  const highIdx = Math.max(0, Math.ceil(draws * (1 - alpha)) - 1);
  return { low: means[lowIdx]!, high: means[highIdx]!, level, draws, seed };
}

export interface WilsonInterval {
  k: number;
  n: number;
  p: number;
  low: number;
  high: number;
}

/** Wilson score interval for a binomial proportion (default z=1.96, 95%). n=0 -> [0,1]. */
export function wilson(k: number, n: number, z = 1.96): WilsonInterval {
  if (n === 0) return { k, n, p: 0, low: 0, high: 1 };
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { k, n, p, low: Math.max(0, center - half), high: Math.min(1, center + half) };
}

/** T-bill carry on `equityUsd` at annual `rate` (decimal) over `days` (ACT/365). */
export function tbillPerEpisodeUsd(rate: number, equityUsd: number, days: number): number {
  return (equityUsd * rate * days) / 365;
}

// ---------- multiple-testing discipline (deflated Sharpe) ----------
// Bailey & López de Prado. Every Sharpe here is PER-OBSERVATION (not
// annualized). The point: when many strategy variants are tried, the best
// observed Sharpe is inflated by selection; the deflated Sharpe ratio (DSR)
// is the probability the TRUE Sharpe exceeds the multiple-testing benchmark,
// correcting for non-normal returns (skew, kurtosis) and the trial count.
// Pure math — no IO, no clock.

export const EULER_MASCHERONI = 0.5772156649015329;

/** Standard normal CDF (Zelen & Severo, A&S 26.2.17; |error| < 7.5e-8). */
export function normalCdf(z: number): number {
  const b1 = 0.319381530;
  const b2 = -0.356563782;
  const b3 = 1.781477937;
  const b4 = -1.821255978;
  const b5 = 1.330274429;
  const p = 0.2316419;
  const c = 0.3989422804014327; // 1/sqrt(2*pi)
  const az = Math.abs(z);
  const t = 1 / (1 + p * az);
  const poly = ((((b5 * t + b4) * t + b3) * t + b2) * t + b1) * t;
  const tail = c * Math.exp(-(az * az) / 2) * poly;
  return z >= 0 ? 1 - tail : tail;
}

/** Inverse standard normal CDF (Acklam's rational approximation; |error| ~1e-9). */
export function normalInv(pp: number): number {
  if (!(pp > 0 && pp < 1)) throw new Error(`normalInv domain is (0,1): ${pp}`);
  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2,
    -3.066479806614716e1, 2.506628277459239e0,
  ];
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1,
    -1.328068155288572e1,
  ];
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838e0, -2.549732539343734e0,
    4.374664141464968e0, 2.938163982698783e0,
  ];
  const d = [
    7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996e0, 3.754408661907416e0,
  ];
  const plow = 0.02425;
  const phigh = 1 - plow;
  if (pp < plow) {
    const q = Math.sqrt(-2 * Math.log(pp));
    return (
      (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
      ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1)
    );
  }
  if (pp <= phigh) {
    const q = pp - 0.5;
    const r = q * q;
    return (
      ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) /
      (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1)
    );
  }
  const q = Math.sqrt(-2 * Math.log(1 - pp));
  return -(
    (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
    ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1)
  );
}

/**
 * Expected maximum per-observation Sharpe from `nTrials` independent trials,
 * each with Sharpe std `sharpeStd` (the multiple-testing benchmark SR*).
 * nTrials = 1 -> 0 (no selection inflation). Uses the Gumbel/extreme-value
 * approximation from López de Prado's DSR.
 */
export function expectedMaxSharpe(nTrials: number, sharpeStd = 1): number {
  if (!Number.isInteger(nTrials) || nTrials < 1) {
    throw new Error(`nTrials must be a positive integer: ${nTrials}`);
  }
  if (nTrials === 1) return 0;
  const g = EULER_MASCHERONI;
  const z1 = normalInv(1 - 1 / nTrials);
  const z2 = normalInv(1 - 1 / (nTrials * Math.E));
  return sharpeStd * ((1 - g) * z1 + g * z2);
}

/**
 * Probabilistic Sharpe ratio: P(true SR > benchmarkSR) given an observed
 * per-observation Sharpe over `nObs` returns with `skew` and `kurt` (kurt is
 * the full fourth moment; 3 is Gaussian).
 */
export function probabilisticSharpe(
  observedSR: number,
  benchmarkSR: number,
  nObs: number,
  skew = 0,
  kurt = 3,
): number {
  if (!Number.isInteger(nObs) || nObs < 2) throw new Error(`nObs must be an integer >= 2: ${nObs}`);
  const denom = Math.sqrt(1 - skew * observedSR + ((kurt - 1) / 4) * observedSR * observedSR);
  return normalCdf(((observedSR - benchmarkSR) * Math.sqrt(nObs - 1)) / denom);
}

/**
 * Deflated Sharpe ratio: the probabilistic Sharpe against the expected-maximum
 * benchmark for `nTrials` variants tried. Higher nTrials -> higher benchmark
 * -> lower DSR. Feed it the honest trial count from docs/TRIAL-REGISTRY.md.
 */
export function deflatedSharpe(
  observedSR: number,
  nTrials: number,
  skew: number,
  kurt: number,
  nObs: number,
  sharpeStd = 1,
): number {
  return probabilisticSharpe(observedSR, expectedMaxSharpe(nTrials, sharpeStd), nObs, skew, kurt);
}

// ---------- economics ----------

export const DEFAULT_EPISODE_EQUITY_USD = 50_000;
/** D 17:00 -> D+1 20:00 is 27 hours of tied-up capital. */
export const DEFAULT_EPISODE_DAYS = 1.125;

export interface EconomicsOpts {
  draws?: number;
  seed?: number;
  level?: number;
  /** Annualized 3-month T-bill yield as a decimal; omit -> comparison not computed. */
  tbillAnnualRate?: number;
  equityUsd?: number;
  episodeDays?: number;
}

export interface StratumEconomics {
  stratum: 'R' | 'H';
  label: string;
  nEpisodes: number;
  nTrades: number;
  grossPnlTotalUsd: number;
  feesTotalUsd: number;
  borrowTotalUsd: number;
  netPnlTotalUsd: number;
  netPnlMeanUsd: number;
  /** Bootstrap 95% CI on mean per-episode net P&L; null when nEpisodes = 0. */
  bootstrap: BootstrapCi | null;
  perEpisodeNetUsd: number[]; // input order
  comparison: {
    tbillAnnualRate: number | null;
    equityUsd: number;
    episodeDays: number;
    tbillPerEpisodeUsd: number | null;
    llmCostTotalUsd: number;
    llmCostMeanUsd: number;
  };
}

function economicsFor(
  episodes: readonly EpisodeResult[],
  stratum: 'R' | 'H',
  label: string,
  opts: EconomicsOpts = {},
): StratumEconomics {
  const eps = episodes.filter((e) => e.stratum === stratum);
  const trades = eps.flatMap((e) => e.trades);
  const perEpisodeNetUsd = eps.map(episodeNetUsd);
  const netPnlTotalUsd = perEpisodeNetUsd.reduce((a, b) => a + b, 0);
  const equityUsd = opts.equityUsd ?? DEFAULT_EPISODE_EQUITY_USD;
  const episodeDays = opts.episodeDays ?? DEFAULT_EPISODE_DAYS;
  const rate = opts.tbillAnnualRate ?? null;
  const llmCostTotalUsd = eps.reduce((sum, e) => sum + e.llmCostUsd, 0);
  return {
    stratum,
    label,
    nEpisodes: eps.length,
    nTrades: trades.length,
    grossPnlTotalUsd: trades.reduce((s, t) => s + t.pnlUsd, 0),
    feesTotalUsd: trades.reduce((s, t) => s + t.feesUsd, 0),
    borrowTotalUsd: trades.reduce((s, t) => s + t.borrowUsd, 0),
    netPnlTotalUsd,
    netPnlMeanUsd: eps.length > 0 ? netPnlTotalUsd / eps.length : 0,
    bootstrap:
      eps.length > 0
        ? bootstrapCi(perEpisodeNetUsd, opts.draws, opts.seed, opts.level)
        : null,
    perEpisodeNetUsd,
    comparison: {
      tbillAnnualRate: rate,
      equityUsd,
      episodeDays,
      tbillPerEpisodeUsd: rate === null ? null : tbillPerEpisodeUsd(rate, equityUsd, episodeDays),
      llmCostTotalUsd,
      llmCostMeanUsd: eps.length > 0 ? llmCostTotalUsd / eps.length : 0,
    },
  };
}

export const HEADLINE_LABEL =
  'stratum R (uniform random trading days) — the headline economic number';
export const H_LABEL =
  'conditional on top-16% cross-sectional-dispersion days (deterministic selection)';

/** Headline economics from stratum R ONLY (5h protocol economic reporting rule). */
export function headlineEconomics(
  episodes: readonly EpisodeResult[],
  opts: EconomicsOpts = {},
): StratumEconomics {
  return economicsFor(episodes, 'R', HEADLINE_LABEL, opts);
}

/** H-stratum economics, separately labeled; never pooled into the headline. */
export function hEconomics(
  episodes: readonly EpisodeResult[],
  opts: EconomicsOpts = {},
): StratumEconomics {
  return economicsFor(episodes, 'H', H_LABEL, opts);
}

// ---------- design-weighted full-window estimate ----------

export const H_STRATUM_SIZE = 20;
export const WINDOW_TRADING_DAYS = 124;

export interface DesignWeightedEstimate {
  weightH: number; // 20/124
  weightRComplement: number; // 104/124
  nH: number;
  nR: number;
  meanHUsd: number;
  meanRUsd: number;
  /** null when either stratum contributed zero episodes. */
  estimatePerEpisodeUsd: number | null;
  note: string;
}

/**
 * Design-weighted stratified estimate of mean per-episode net P&L over the
 * full 124-day window: the H stratum is censused (weight 20/124) and the
 * complement is estimated from R draws outside the H-stratum day set
 * (weight 104/124). `hStratumDays` is the full top-20 dispersion day set;
 * when omitted it defaults to the days of the H episodes present (equivalent
 * whenever all 20 H episodes ran, since H excludes days already drawn in R
 * by construction).
 */
export function designWeightedEstimate(
  episodes: readonly EpisodeResult[],
  hStratumDays?: readonly string[],
): DesignWeightedEstimate {
  const h = episodes.filter((e) => e.stratum === 'H');
  const hDaySet = new Set(hStratumDays ?? h.map((e) => e.day));
  const r = episodes.filter((e) => e.stratum === 'R' && !hDaySet.has(e.day));
  const meanOf = (eps: EpisodeResult[]): number =>
    eps.length > 0 ? eps.reduce((s, e) => s + episodeNetUsd(e), 0) / eps.length : 0;
  const weightH = H_STRATUM_SIZE / WINDOW_TRADING_DAYS;
  const weightRComplement = (WINDOW_TRADING_DAYS - H_STRATUM_SIZE) / WINDOW_TRADING_DAYS;
  const meanHUsd = meanOf(h);
  const meanRUsd = meanOf(r);
  return {
    weightH,
    weightRComplement,
    nH: h.length,
    nR: r.length,
    meanHUsd,
    meanRUsd,
    estimatePerEpisodeUsd:
      h.length > 0 && r.length > 0 ? weightH * meanHUsd + weightRComplement * meanRUsd : null,
    note: `H stratum censused (weight ${H_STRATUM_SIZE}/${WINDOW_TRADING_DAYS}); complement estimated from R draws outside the H day set (weight ${WINDOW_TRADING_DAYS - H_STRATUM_SIZE}/${WINDOW_TRADING_DAYS}). Design-weighted, not a pooled sample.`,
  };
}

// ---------- behavior ----------

export interface BehaviorTally {
  nEpisodes: number;
  abstained: number;
  ordersPlaced: number;
  ordersFilled: number;
  /** ordersFilled / ordersPlaced; null when nothing was placed. */
  fillRate: number | null;
  rejectionsByReason: Record<string, number>;
  judgeVetoes: number;
  halts: number;
  danglingAtFlatten: number;
  episodesWithDangling: number;
}

export interface BehaviorReport {
  /** Abstention rate with Wilson 95% interval, from stratum R ONLY. */
  abstention: WilsonInterval;
  r: BehaviorTally;
  h: BehaviorTally;
  combined: BehaviorTally;
}

function tally(eps: readonly EpisodeResult[]): BehaviorTally {
  const rejectionsByReason: Record<string, number> = {};
  for (const e of eps) {
    for (const [reason, count] of Object.entries(e.rejectionsByReason)) {
      rejectionsByReason[reason] = (rejectionsByReason[reason] ?? 0) + count;
    }
  }
  const ordersPlaced = eps.reduce((s, e) => s + e.ordersPlaced, 0);
  const ordersFilled = eps.reduce((s, e) => s + e.ordersFilled, 0);
  return {
    nEpisodes: eps.length,
    abstained: eps.filter((e) => e.abstained).length,
    ordersPlaced,
    ordersFilled,
    fillRate: ordersPlaced > 0 ? ordersFilled / ordersPlaced : null,
    rejectionsByReason,
    judgeVetoes: eps.reduce((s, e) => s + e.judgeVetoes, 0),
    halts: eps.reduce((s, e) => s + e.halts, 0),
    danglingAtFlatten: eps.reduce((s, e) => s + e.danglingAtFlatten, 0),
    episodesWithDangling: eps.filter((e) => e.danglingAtFlatten > 0).length,
  };
}

export function behavior(episodes: readonly EpisodeResult[]): BehaviorReport {
  const rEps = episodes.filter((e) => e.stratum === 'R');
  const hEps = episodes.filter((e) => e.stratum === 'H');
  return {
    abstention: wilson(rEps.filter((e) => e.abstained).length, rEps.length),
    r: tally(rEps),
    h: tally(hEps),
    combined: tally(episodes),
  };
}

// ---------- attribution ----------

export const ATTRIBUTION_MIN_N = 30;
export const INSUFFICIENT_N_NOTE = 'insufficient n — see per-trade log';

export interface AttributionRow {
  analyst: AnalystName;
  /** true for the bear row: computed only over short trades. */
  shortsOnly: boolean;
  k: number; // wins (net trade P&L > 0)
  n: number; // trades this analyst agreed on (shorts only for bear)
  winRate: number | null;
  wilson: WilsonInterval | null;
  /** n < 30: no weight guidance is emitted for this subgroup. */
  suppressed: boolean;
  note: string;
}

export interface AttributionReport {
  rows: AttributionRow[];
  totalTrades: number;
}

export function attribution(episodes: readonly EpisodeResult[]): AttributionReport {
  const trades = episodes.flatMap((e) => e.trades);
  const rows = ANALYSTS.map((analyst): AttributionRow => {
    const shortsOnly = analyst === 'bear';
    const eligible = trades.filter(
      (t) => (!shortsOnly || t.side === 'short') && t.analystsAgreeing.includes(analyst),
    );
    const n = eligible.length;
    const k = eligible.filter((t) => tradeNetUsd(t) > 0).length;
    const suppressed = n < ATTRIBUTION_MIN_N;
    return {
      analyst,
      shortsOnly,
      k,
      n,
      winRate: n > 0 ? k / n : null,
      wilson: n > 0 ? wilson(k, n) : null,
      suppressed,
      note: suppressed ? INSUFFICIENT_N_NOTE : '',
    };
  });
  return { rows, totalTrades: trades.length };
}

// ---------- bundle ----------

export interface MetricsBundle {
  headline: StratumEconomics;
  hEconomics: StratumEconomics;
  designWeighted: DesignWeightedEstimate;
  behavior: BehaviorReport;
  attribution: AttributionReport;
  episodes: EpisodeResult[];
}

export function computeAll(
  episodes: readonly EpisodeResult[],
  opts: EconomicsOpts = {},
  hStratumDays?: readonly string[],
): MetricsBundle {
  return {
    headline: headlineEconomics(episodes, opts),
    hEconomics: hEconomics(episodes, opts),
    designWeighted: designWeightedEstimate(episodes, hStratumDays),
    behavior: behavior(episodes),
    attribution: attribution(episodes),
    episodes: [...episodes],
  };
}

// ---------- REPORT.md ----------

export const VALIDITY_KEYS = [
  'leakage',
  'feeds',
  'fills',
  'splits',
  'survivorship',
  'borrow',
  'judge-cache',
  'tick-cadence',
  'costs',
] as const;
export type ValidityKey = (typeof VALIDITY_KEYS)[number];

const VALIDITY_TITLES: Record<ValidityKey, string> = {
  leakage: 'Leakage — cutoff verification + masked/unmasked probe results, with power statement',
  feeds: 'Feed choices — SIP for fills/screeners, IEX for marketInfo parity (incl. the ~40x min_avg_dollar_volume production finding)',
  fills: 'Fill-model assumptions — strict limit cross, 20x per-session volume guard, no partials; optimistic vs real extended-hours execution',
  splits: 'Split exclusions — raw adjustment basis; excluded symbol-spans and forced flattenings',
  survivorship: 'Survivorship — current-active asset list as universe proxy',
  borrow: 'Borrow — easy_to_borrow point-in-time proxy; hard not-shortable gate; 0.3%/yr ETB accrual',
  'judge-cache': 'Judge-cache canonicalization — sizing/band-invariance approximation; fresh-call counts',
  'tick-cadence': 'Tick-cadence parity — 15-minute driver steps vs production launchd cadence',
  costs: 'Cost actuals — LLM token spend for this run; projected live operating cost/day',
};

export const VALIDITY_PLACEHOLDER = '_TBD — supplied by the driver/probe at report time._';

export interface ReportMeta {
  tag?: string;
  generatedAt?: string;
  window?: { start: string; end: string };
  /** Which sampling/drop rule applied (full 30R/20H vs pre-registered 24R/16H drop). */
  sampleNote?: string;
  /** Mechanical claim: invariant-violation count across all episode ticks. */
  mechanicalNote?: string;
  /** Descriptive sweep deliverable (abstention/fill-rate vs threshold curves). */
  sensitivityNote?: string;
  /**
   * Multiple-testing governance: when set and the headline stratum has fewer
   * than this many trades, the economic bar refuses a PASS/FAIL verdict and
   * prints "INSUFFICIENT N" instead. Omit -> no gate (legacy behavior).
   */
  minTradesForEconomicClaim?: number;
  validity?: Partial<Record<ValidityKey, string>>;
}

const usd = (x: number): string => `${x < 0 ? '-' : ''}$${Math.abs(x).toFixed(2)}`;
const pct = (x: number): string => `${(100 * x).toFixed(1)}%`;
const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

function mdTable(headers: string[], rows: string[][]): string {
  const line = (cells: string[]): string => `| ${cells.map(cell).join(' | ')} |`;
  return [line(headers), `|${headers.map(() => '---').join('|')}|`, ...rows.map(line)].join('\n');
}

function economicsSection(e: StratumEconomics): string {
  const ci = e.bootstrap
    ? `[${usd(e.bootstrap.low)}, ${usd(e.bootstrap.high)}] (bootstrap ${e.bootstrap.draws} draws, seed ${e.bootstrap.seed}, ${pct(e.bootstrap.level)} level, episode resampling)`
    : 'n/a (no episodes)';
  return mdTable(
    ['metric', 'value'],
    [
      ['episodes', String(e.nEpisodes)],
      ['trades', String(e.nTrades)],
      ['gross price P&L (total)', usd(e.grossPnlTotalUsd)],
      ['fees (total)', usd(e.feesTotalUsd)],
      ['borrow (total)', usd(e.borrowTotalUsd)],
      ['net P&L (total)', usd(e.netPnlTotalUsd)],
      ['net P&L (mean/episode)', usd(e.netPnlMeanUsd)],
      ['95% CI on mean/episode net P&L', ci],
      ['LLM cost (total / mean per episode)', `${usd(e.comparison.llmCostTotalUsd)} / ${usd(e.comparison.llmCostMeanUsd)}`],
    ],
  );
}

function economicsBar(e: StratumEconomics, minTradesForClaim?: number): string {
  const c = e.comparison;
  if (e.nEpisodes === 0) return 'NOT EVALUATED — no episodes in stratum R.';
  if (minTradesForClaim !== undefined && e.nTrades < minTradesForClaim) {
    return [
      `**INSUFFICIENT N — no economic verdict.** ${e.nTrades} trades < min_trades_for_economic_claim ${minTradesForClaim}.`,
      `At this n the bootstrap CI above, not a point PASS/FAIL, is the claim; a handful of trades cannot clear a deflated-Sharpe hurdle. Accumulate trades (paper soak) before any economic claim.`,
      `- mean/episode net P&L (fees + borrow included): ${usd(e.netPnlMeanUsd)}; mean/episode LLM cost: ${usd(c.llmCostMeanUsd)}.`,
    ].join('\n');
  }
  const lines: string[] = [];
  if (c.tbillPerEpisodeUsd === null) {
    lines.push(
      `- T-bill carry: NOT PROVIDED (pass \`tbillAnnualRate\`); bar not evaluated.`,
      `- mean/episode net P&L: ${usd(e.netPnlMeanUsd)}; mean/episode LLM cost: ${usd(c.llmCostMeanUsd)}.`,
    );
    return lines.join('\n');
  }
  const bar = c.tbillPerEpisodeUsd + c.llmCostMeanUsd;
  const passes = e.netPnlMeanUsd > bar;
  lines.push(
    `- mean/episode net P&L (fees + borrow included): ${usd(e.netPnlMeanUsd)}`,
    `- T-bill carry per episode (${pct(c.tbillAnnualRate ?? 0)} annual on ${usd(c.equityUsd)} over ${c.episodeDays} days, ACT/365): ${usd(c.tbillPerEpisodeUsd)}`,
    `- LLM cost per episode (measured): ${usd(c.llmCostMeanUsd)}`,
    `- bar = T-bill + LLM = ${usd(bar)}`,
    ``,
    `**Economic bar: ${passes ? 'PASSES' : 'FAILS'}** (point estimate; see CI above — at this n the interval, not the point, is the claim).`,
  );
  return lines.join('\n');
}

function behaviorSection(b: BehaviorReport): string {
  const abst = b.abstention;
  const rateRow = (t: BehaviorTally): string =>
    t.fillRate === null ? 'n/a' : pct(t.fillRate);
  const reasons = [
    ...new Set([
      ...Object.keys(b.r.rejectionsByReason),
      ...Object.keys(b.h.rejectionsByReason),
    ]),
  ].sort();
  const rejectionTable =
    reasons.length === 0
      ? '_No risk-gate rejections recorded._'
      : mdTable(
          ['rejection reason', 'R', 'H', 'total'],
          reasons.map((reason) => [
            reason,
            String(b.r.rejectionsByReason[reason] ?? 0),
            String(b.h.rejectionsByReason[reason] ?? 0),
            String(b.combined.rejectionsByReason[reason] ?? 0),
          ]),
        );
  return [
    `Abstention rate (stratum R only, n=${abst.n}): **${pct(abst.p)}** (${abst.k}/${abst.n}), Wilson 95% [${pct(abst.low)}, ${pct(abst.high)}]. H-stratum abstentions are reported below but never enter this rate.`,
    '',
    mdTable(
      ['metric', 'R', 'H', 'combined'],
      [
        ['episodes', String(b.r.nEpisodes), String(b.h.nEpisodes), String(b.combined.nEpisodes)],
        ['abstained episodes', String(b.r.abstained), String(b.h.abstained), String(b.combined.abstained)],
        ['orders placed', String(b.r.ordersPlaced), String(b.h.ordersPlaced), String(b.combined.ordersPlaced)],
        ['orders filled', String(b.r.ordersFilled), String(b.h.ordersFilled), String(b.combined.ordersFilled)],
        ['fill rate', rateRow(b.r), rateRow(b.h), rateRow(b.combined)],
        ['judge vetoes', String(b.r.judgeVetoes), String(b.h.judgeVetoes), String(b.combined.judgeVetoes)],
        ['halts', String(b.r.halts), String(b.h.halts), String(b.combined.halts)],
        ['dangling at flatten (positions)', String(b.r.danglingAtFlatten), String(b.h.danglingAtFlatten), String(b.combined.danglingAtFlatten)],
        ['episodes with dangling', String(b.r.episodesWithDangling), String(b.h.episodesWithDangling), String(b.combined.episodesWithDangling)],
      ],
    ),
    '',
    '### Risk-gate rejections by reason',
    '',
    rejectionTable,
    '',
    '_Dangling-at-flatten counts are a lower bound on the v1 multi-day orphan-position question (episodes force-flatten at D+1 20:00)._',
  ].join('\n');
}

function attributionSection(a: AttributionReport, episodes: readonly EpisodeResult[]): string {
  const rows = a.rows.map((r) => [
    r.shortsOnly ? `${r.analyst} (shorts only)` : r.analyst,
    `${r.k}/${r.n}`,
    r.winRate === null ? 'n/a' : pct(r.winRate),
    r.wilson ? `[${pct(r.wilson.low)}, ${pct(r.wilson.high)}]` : 'n/a',
    r.suppressed ? r.note : 'eligible for weight guidance via sweep only',
  ]);
  const tradeRows = episodes.flatMap((e) =>
    e.trades.map((t) => [
      e.day,
      e.stratum,
      t.ticker,
      t.side,
      String(t.qty),
      t.entryPrice.toFixed(2),
      t.exitPrice.toFixed(2),
      usd(t.feesUsd),
      usd(t.borrowUsd),
      usd(tradeNetUsd(t)),
      t.analystsAgreeing.join(', '),
      t.exitReason,
    ]),
  );
  return [
    'Win = net trade P&L (after fees and borrow) > 0. Trades pool both strata: H days are over-represented by design, so these are NOT population win rates. No weight guidance is emitted for any subgroup with n < 30.',
    '',
    mdTable(['analyst', 'wins k/n', 'win rate', 'Wilson 95%', 'guidance'], rows),
    '',
    '### Per-trade log',
    '',
    tradeRows.length === 0
      ? '_No trades._'
      : mdTable(
          ['day', 'stratum', 'ticker', 'side', 'qty', 'entry', 'exit', 'fees', 'borrow', 'net P&L', 'analysts agreeing', 'exit reason'],
          tradeRows,
        ),
  ].join('\n');
}

/** Render REPORT.md (structure per full plan §6, adapted to the 5h episode protocol). */
export function renderReport(all: MetricsBundle, meta: ReportMeta = {}): string {
  const dw = all.designWeighted;
  const metaLines = [
    meta.tag ? `- run tag: \`${meta.tag}\`` : null,
    meta.generatedAt ? `- generated: ${meta.generatedAt}` : null,
    meta.window ? `- window: ${meta.window.start} → ${meta.window.end} (${WINDOW_TRADING_DAYS} trading days)` : null,
    meta.sampleNote ? `- sampling rule applied: ${meta.sampleNote}` : null,
  ].filter((l): l is string => l !== null);

  const sections = [
    '# Backtest REPORT — 5-hour episode protocol',
    '',
    ...(metaLines.length > 0 ? [...metaLines, ''] : []),
    '## Read this first — fill realism',
    '',
    'All fills are simulated (strict limit cross against SIP minute bars with a 20x per-session volume guard, no partial fills). Even with the real consolidated tape, results are **optimistic relative to real extended-hours execution**. Every economic number below inherits this caveat.',
    '',
    '“Does it work” is three separate claims: (1) **mechanical** — zero invariant violations across all episode ticks; (2) **behavioral** — nonzero but controlled trade rate; (3) **economic** — the bar in §1.1, on shipped defaults. Anything less is reported as “does not work at defaults.”',
    '',
    `- Mechanical: ${meta.mechanicalNote ?? VALIDITY_PLACEHOLDER}`,
    '',
    '## 1. Headline — stratum R economics (defaults, untuned)',
    '',
    `Label: ${all.headline.label}. Per-episode net P&L on fresh $${DEFAULT_EPISODE_EQUITY_USD.toLocaleString('en-US')} capital; strata are never pooled.`,
    '',
    economicsSection(all.headline),
    '',
    '### 1.1 Economic bar',
    '',
    economicsBar(all.headline, meta.minTradesForEconomicClaim),
    '',
    '## 2. H-stratum economics',
    '',
    `Label: **${all.hEconomics.label}**. H is an upper bound on activity; the direction of its P&L bias is unknown and regime-dependent — never claimed as conservative or favorable. Not pooled with the headline.`,
    '',
    economicsSection(all.hEconomics),
    '',
    '## 3. Design-weighted full-window estimate',
    '',
    dw.estimatePerEpisodeUsd === null
      ? '_Not computable: one stratum contributed zero episodes._'
      : mdTable(
          ['component', 'weight', 'n', 'mean/episode net P&L'],
          [
            ['H stratum (censused)', `${H_STRATUM_SIZE}/${WINDOW_TRADING_DAYS}`, String(dw.nH), usd(dw.meanHUsd)],
            ['R complement', `${WINDOW_TRADING_DAYS - H_STRATUM_SIZE}/${WINDOW_TRADING_DAYS}`, String(dw.nR), usd(dw.meanRUsd)],
            ['**design-weighted estimate**', '1', '—', usd(dw.estimatePerEpisodeUsd)],
          ],
        ),
    '',
    `_${dw.note}_`,
    '',
    '## 4. Behavior',
    '',
    behaviorSection(all.behavior),
    '',
    '## 5. Attribution',
    '',
    attributionSection(all.attribution, all.episodes),
    '',
    '## 6. Sensitivity (descriptive sweep)',
    '',
    meta.sensitivityNote ??
      '_TBD — abstention-rate and fill-rate vs threshold curves from the 18-cell sweep (descriptive only; no walk-forward at this n)._',
    '',
    '## 7. Validity appendix',
    '',
    ...VALIDITY_KEYS.flatMap((key) => [
      `### ${VALIDITY_TITLES[key]}`,
      '',
      meta.validity?.[key] ?? VALIDITY_PLACEHOLDER,
      '',
    ]),
  ];
  return sections.join('\n');
}
