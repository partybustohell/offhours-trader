// Portfolio construction (P2) — pure math. Shrinkage covariance, whole-book
// ex-ante vol targeting (a down-only scalar), and conviction-tilted inverse-vol
// basket weights. No IO/clock. Covariance is of DAILY returns; vols annualize
// with sqrt(252).

const TRADING_DAYS = 252;

/** Sample covariance matrix of asset return series. `returns[i]` is asset i. */
export function sampleCovariance(returns: number[][]): number[][] {
  const k = returns.length;
  if (k === 0) return [];
  const n = returns[0]!.length;
  const means = returns.map((r) => r.reduce((s, x) => s + x, 0) / (r.length || 1));
  const cov = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  for (let i = 0; i < k; i++) {
    for (let j = i; j < k; j++) {
      let acc = 0;
      const len = Math.min(returns[i]!.length, returns[j]!.length);
      for (let t = 0; t < len; t++) acc += (returns[i]![t]! - means[i]!) * (returns[j]![t]! - means[j]!);
      const c = len > 1 ? acc / (len - 1) : 0;
      cov[i]![j] = c;
      cov[j]![i] = c;
    }
  }
  void n;
  return cov;
}

/** Constant-correlation target: keep variances, set every correlation to the mean. */
export function constantCorrelationTarget(cov: number[][]): number[][] {
  const k = cov.length;
  const sd = cov.map((row, i) => Math.sqrt(Math.max(0, row[i]!)));
  let sum = 0;
  let cnt = 0;
  for (let i = 0; i < k; i++)
    for (let j = i + 1; j < k; j++) {
      const denom = sd[i]! * sd[j]!;
      if (denom > 0) {
        sum += cov[i]![j]! / denom;
        cnt++;
      }
    }
  const rbar = cnt > 0 ? sum / cnt : 0;
  const out = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  for (let i = 0; i < k; i++)
    for (let j = 0; j < k; j++) out[i]![j] = i === j ? cov[i]![i]! : rbar * sd[i]! * sd[j]!;
  return out;
}

/** Shrink the sample covariance toward a target at intensity δ∈[0,1]. */
export function shrinkageCovariance(
  returns: number[][],
  method: 'constant_corr' | 'single_factor' | 'none',
  delta = 0.3,
): number[][] {
  const sample = sampleCovariance(returns);
  if (method === 'none' || sample.length === 0) return sample;
  // single_factor is approximated by the constant-correlation target here
  // (both pull off-diagonals toward a common structure); kept as one path.
  const target = constantCorrelationTarget(sample);
  const d = Math.min(1, Math.max(0, delta));
  return sample.map((row, i) => row.map((v, j) => (1 - d) * v + d * target[i]![j]!));
}

/** Annualized portfolio vol for dollar weights against a daily-return covariance. */
export function annualizedPortfolioVol(weightsUsd: number[], cov: number[][], equity: number): number {
  if (equity <= 0 || cov.length === 0) return 0;
  const w = weightsUsd.map((x) => x / equity);
  let variance = 0;
  for (let i = 0; i < w.length; i++)
    for (let j = 0; j < w.length; j++) variance += w[i]! * w[j]! * (cov[i]?.[j] ?? 0);
  return Math.sqrt(Math.max(0, variance) * TRADING_DAYS);
}

/**
 * Whole-book vol-target scalar (down-only): min(1, targetVol / bookVol).
 * targetVolPct and the result are decimals-of-100 (e.g. 20 = 20% annualized).
 * bookVol 0 -> no scaling.
 */
export function portfolioVolScalar(
  weightsUsd: number[],
  cov: number[][],
  targetVolPct: number,
  equity: number,
): number {
  const bookVol = annualizedPortfolioVol(weightsUsd, cov, equity) * 100; // to %
  if (bookVol <= 0) return 1;
  return Math.min(1, targetVolPct / bookVol);
}

/**
 * Conviction-tilted inverse-vol weights (sum to 1): w_i ∝ conviction_i / sigma_i.
 * Missing/zero sigma falls back to the median sigma so it is neither favored nor
 * dropped. Returns equal weights if everything degenerates.
 */
export function inverseVolWeights(sigmas: (number | undefined)[], convictions: number[]): number[] {
  const known = sigmas.filter((s): s is number => s !== undefined && s > 0).sort((a, b) => a - b);
  const medianSigma = known.length > 0 ? known[Math.floor(known.length / 2)]! : 1;
  const raw = convictions.map((c, i) => {
    const s = sigmas[i];
    const sig = s !== undefined && s > 0 ? s : medianSigma;
    return c / sig;
  });
  const total = raw.reduce((a, x) => a + x, 0);
  if (total <= 0) return convictions.map(() => 1 / convictions.length);
  return raw.map((x) => x / total);
}
