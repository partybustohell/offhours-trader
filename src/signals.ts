// Deterministic quant signals — pure functions, no IO/clock. Each SCALAR
// returns a number in (0, 1]: 1 when its signal is disabled or does not fire,
// so stacking disabled signals is a no-op. Each GATE returns true = block.
// Nothing here is a directional vote and nothing is shown to the LLM; these
// only shrink size, veto entries, or rank — see the design spec.
import type { Config } from './config.js';

export type Direction = 'long' | 'short';

// ---------- feature extractors (from daily bars / closes) ----------

/** Simple daily returns from a close series (length n-1). */
export function dailyReturns(closes: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const prev = closes[i - 1]!;
    if (prev > 0) out.push((closes[i]! - prev) / prev);
  }
  return out;
}

/** Signed % return over the last `lookbackDays` closes. undefined if too few. */
export function recentReturnPct(closes: number[], lookbackDays: number): number | undefined {
  const c = closes.filter((x) => x > 0);
  if (c.length < lookbackDays + 1) return undefined;
  const last = c[c.length - 1]!;
  const prior = c[c.length - 1 - lookbackDays]!;
  return prior > 0 ? ((last - prior) / prior) * 100 : undefined;
}

/**
 * Amihud illiquidity over the last `windowDays`: mean(|daily return| /
 * dollar-volume) scaled by 1e6. Higher = more price impact per dollar. undefined
 * if too few points. `closes` and `volumes` must be aligned and same length.
 */
export function amihudIlliquidity(
  closes: number[],
  volumes: number[],
  windowDays: number,
): number | undefined {
  if (closes.length !== volumes.length || closes.length < windowDays + 1) return undefined;
  const c = closes.slice(-(windowDays + 1));
  const v = volumes.slice(-(windowDays + 1));
  const ratios: number[] = [];
  for (let i = 1; i < c.length; i++) {
    const prev = c[i - 1]!;
    const dollarVol = c[i]! * v[i]!;
    if (prev <= 0 || dollarVol <= 0) continue;
    ratios.push(Math.abs((c[i]! - prev) / prev) / dollarVol);
  }
  if (ratios.length === 0) return undefined;
  return (ratios.reduce((s, r) => s + r, 0) / ratios.length) * 1e6;
}

/** 12-1 style momentum: return from `lookbackDays` ago to `skipDays` ago (%). */
export function momentumPct(
  closes: number[],
  lookbackDays: number,
  skipDays: number,
): number | undefined {
  const c = closes.filter((x) => x > 0);
  if (c.length < lookbackDays + 1) return undefined;
  const end = c[c.length - 1 - skipDays];
  const start = c[c.length - 1 - lookbackDays];
  if (end === undefined || start === undefined || start <= 0) return undefined;
  return ((end - start) / start) * 100;
}

/** Last close as a fraction of the max close over the last `windowDays`. */
export function pctOf52wHigh(closes: number[], windowDays: number): number | undefined {
  const c = closes.filter((x) => x > 0).slice(-windowDays);
  if (c.length < 2) return undefined;
  const high = Math.max(...c);
  const last = c[c.length - 1]!;
  return high > 0 ? last / high : undefined;
}

export interface GapSignature {
  gapPct: number; // (lastOpen - prevClose) / prevClose * 100
  relVolume: number; // lastVolume / mean(prior volumes)
}
/** Overnight gap % and relative volume from the most recent daily bar. */
export function gapSignature(
  opens: number[],
  closes: number[],
  volumes: number[],
  window = 20,
): GapSignature | undefined {
  const n = closes.length;
  if (n < 2 || opens.length !== n || volumes.length !== n) return undefined;
  const prevClose = closes[n - 2]!;
  const lastOpen = opens[n - 1]!;
  if (prevClose <= 0) return undefined;
  const priorVols = volumes.slice(Math.max(0, n - 1 - window), n - 1).filter((x) => x > 0);
  const avgVol = priorVols.length > 0 ? priorVols.reduce((s, x) => s + x, 0) / priorVols.length : 0;
  return {
    gapPct: ((lastOpen - prevClose) / prevClose) * 100,
    relVolume: avgVol > 0 ? volumes[n - 1]! / avgVol : 0,
  };
}

// ---------- down-only size scalars (return <= 1; 1 when off / no signal) ----------

/** Sample standard deviation; 0 for <2 points. */
export function stddev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
  const varc = xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(varc);
}

/** True when the name already ran hard in the trade direction (buying strength
 *  / shorting weakness). Drives both the haircut and the band-tighten. */
export function isChasing(
  recentRetPct: number | undefined,
  direction: Direction,
  cfg: Config['signals']['anti_chase'],
): boolean {
  if (!cfg.enabled || recentRetPct === undefined) return false;
  return direction === 'long'
    ? recentRetPct >= cfg.run_threshold_pct
    : recentRetPct <= -cfg.run_threshold_pct;
}

/** Anti-chase: haircut when the name already ran hard in the trade direction. */
export function antiChaseHaircut(
  recentRetPct: number | undefined,
  direction: Direction,
  cfg: Config['signals']['anti_chase'],
): number {
  return isChasing(recentRetPct, direction, cfg) ? cfg.haircut : 1;
}

/** Amihud haircut: shrink illiquid names. max_amihud 0 -> no-op. */
export function amihudHaircut(
  amihud: number | undefined,
  cfg: Config['signals']['amihud'],
): number {
  if (!cfg.enabled || amihud === undefined || cfg.max_amihud <= 0) return 1;
  return amihud > cfg.max_amihud ? cfg.size_haircut : 1;
}

/** Ensemble-dispersion haircut: shrink when agreeing analysts disagree in strength. */
export function dispersionScalar(
  convictions: number[],
  cfg: Config['signals']['dispersion'],
): number {
  if (!cfg.enabled || cfg.k <= 0 || convictions.length < 2) return 1;
  return Math.max(cfg.floor, 1 - cfg.k * stddev(convictions));
}

/** Spread-cost haircut (executor-time): shrink size as the live spread widens. */
export function costScalar(spreadBps: number, cfg: Config['execution']['cost_scalar']): number {
  if (!cfg.enabled || cfg.max_roundtrip_cost_bps <= 0) return 1;
  return Math.max(cfg.floor, Math.min(1, 1 - spreadBps / cfg.max_roundtrip_cost_bps));
}

/**
 * Combine down-only scalars: product, floored so stacking can't collapse the
 * book. The floor bounds only the passed (new-signal) scalars — callers keep
 * the existing volScalar separate so legacy risk-parity sizing is unchanged.
 */
export function combineScalars(scalars: number[], floor: number): number {
  const product = scalars.reduce((a, s) => a * s, 1);
  return Math.max(floor, product);
}

export interface ScalarAttribution {
  /** Each named signal's applied scalar (<= 1). */
  applied: Record<string, number>;
  /** combineScalars over ALL named scalars (floored). */
  product: number;
  /** combineScalars over all EXCEPT the named one (floored) — the size the
   *  position would have had with that one signal removed. */
  leaveOneOut: Record<string, number>;
}

/**
 * Leave-one-out attribution of a floored product of down-only scalars.
 * `leaveOneOut[name]` is RECOMPUTED over the reduced set, never divided out:
 * the floor makes the product non-additive, so dividing a scalar back out would
 * read a false 0 for a floor-bound signal. The marginal shrink attributable to
 * a signal is `leaveOneOut[name] - product` (>= 0). Pure.
 */
export function attributeScalars(named: Record<string, number>, floor: number): ScalarAttribution {
  const names = Object.keys(named);
  const product = combineScalars(
    names.map((n) => named[n]!),
    floor,
  );
  const leaveOneOut: Record<string, number> = {};
  for (const n of names) {
    leaveOneOut[n] = combineScalars(
      names.filter((m) => m !== n).map((m) => named[m]!),
      floor,
    );
  }
  return { applied: { ...named }, product, leaveOneOut };
}

// ---------- gates (return true = block the entry) ----------

/** 12-1 / 52wk-high counter-trend veto: block entries that fight a strong trend. */
export function trendContraBlock(
  momentum: number | undefined,
  pctHigh: number | undefined,
  direction: Direction,
  cfg: Config['signals']['trend_gate'],
): boolean {
  if (!cfg.enabled || !cfg.contra_block || momentum === undefined || pctHigh === undefined) {
    return false;
  }
  const strongUp = momentum > 0 && pctHigh >= cfg.min_pct_of_52w_high;
  const strongDown = momentum < 0 && pctHigh <= 1 - cfg.min_pct_of_52w_high;
  // Block a short into a strong uptrend and a long into a strong downtrend.
  return (direction === 'short' && strongUp) || (direction === 'long' && strongDown);
}

/** Catalyst-gap continuation: block an entry that fades a big gap on volume. */
export function gapContraBlock(
  gap: GapSignature | undefined,
  direction: Direction,
  cfg: Config['signals']['gap'],
): boolean {
  if (!cfg.enabled || !cfg.contra_gate || gap === undefined) return false;
  const bigOnVolume = Math.abs(gap.gapPct) >= cfg.min_gap_pct && gap.relVolume >= cfg.min_rel_volume;
  if (!bigOnVolume) return false;
  // Fading = long after a big gap DOWN, or short after a big gap UP.
  return (direction === 'long' && gap.gapPct <= -cfg.min_gap_pct) ||
    (direction === 'short' && gap.gapPct >= cfg.min_gap_pct);
}

// ---------- book-level live overlays (executor tick) ----------

/**
 * Drawdown throttle (down-only): 1 at the high-water mark, falling linearly to
 * `minThrottle` as drawdown reaches `floorPct`. peak<=0 or no drawdown -> 1.
 */
export function drawdownThrottle(
  equity: number,
  peak: number,
  cfg: Config['risk_overlay']['drawdown_throttle'],
): number {
  if (!cfg.enabled || peak <= 0 || cfg.floor_pct <= 0) return 1;
  const ddPct = Math.max(0, ((peak - equity) / peak) * 100);
  if (ddPct <= 0) return 1;
  return Math.max(cfg.min_throttle, Math.min(1, 1 - ddPct / cfg.floor_pct));
}

/** Risk-off freeze: true when the index has dropped past the threshold today. */
export function riskOffTriggered(
  indexDropPct: number | undefined,
  cfg: Config['risk_overlay']['risk_off'],
): boolean {
  if (!cfg.enabled || indexDropPct === undefined) return false;
  return indexDropPct <= -cfg.spy_drop_pct;
}

// ---------- execution: participation cap ----------

/**
 * Cap child order qty to a fraction of the displayed top-of-book size on the
 * take side, bounding worst-case impact. Returns the notional-implied qty when
 * disabled or when displayed size is unknown (<=0).
 */
export function participationQty(
  notionalQty: number,
  displayedSize: number,
  cfg: Config['execution']['participation'],
): number {
  if (!cfg.enabled || displayedSize <= 0) return notionalQty;
  const cap = Math.floor(cfg.max_top_size_fraction * displayedSize);
  return Math.max(0, Math.min(notionalQty, cap));
}
