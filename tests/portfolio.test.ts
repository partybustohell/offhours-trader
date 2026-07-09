import { describe, expect, it } from 'vitest';
import {
  annualizedPortfolioVol,
  constantCorrelationTarget,
  inverseVolWeights,
  portfolioVolScalar,
  sampleCovariance,
  shrinkageCovariance,
} from '../src/portfolio.js';

// Sample variance (n-1 denominator), computed independently of the source so it
// can cross-check the covariance diagonal.
function sampleVar(xs: number[]): number {
  const n = xs.length;
  if (n < 2) return 0;
  const mean = xs.reduce((s, x) => s + x, 0) / n;
  const acc = xs.reduce((s, x) => s + (x - mean) * (x - mean), 0);
  return acc / (n - 1);
}

const SQRT_252 = Math.sqrt(252);

describe('sampleCovariance', () => {
  // Two-asset hand case:
  //   A = [1,2,3,4]  mean 2.5  dev [-1.5,-0.5,0.5,1.5]
  //   B = [2,4,6,8]  mean 5    dev [-3,-1,1,3]
  //   Var(A) = (2.25+0.25+0.25+2.25)/3 = 5/3
  //   Var(B) = (9+1+1+9)/3          = 20/3
  //   Cov(A,B) = (4.5+0.5+0.5+4.5)/3 = 10/3
  const A = [1, 2, 3, 4];
  const B = [2, 4, 6, 8];
  const cov = sampleCovariance([A, B]);

  it('diagonal equals each asset sample variance', () => {
    expect(cov[0]![0]).toBeCloseTo(5 / 3, 10);
    expect(cov[1]![1]).toBeCloseTo(20 / 3, 10);
    // Cross-check against an independent variance implementation.
    expect(cov[0]![0]).toBeCloseTo(sampleVar(A), 10);
    expect(cov[1]![1]).toBeCloseTo(sampleVar(B), 10);
  });

  it('off-diagonal is the hand-computed covariance and is symmetric', () => {
    expect(cov[0]![1]).toBeCloseTo(10 / 3, 10);
    expect(cov[1]![0]).toBeCloseTo(10 / 3, 10);
    expect(cov[0]![1]).toBe(cov[1]![0]);
  });

  it('returns [] for empty input', () => {
    expect(sampleCovariance([])).toEqual([]);
  });
});

describe('constantCorrelationTarget', () => {
  // Build a covariance matrix directly with distinct correlations so the mean
  // correlation is not degenerate:
  //   sd = [2, 3, 4]
  //   corr(0,1)=0.5 -> 3,  corr(0,2)=0.25 -> 2,  corr(1,2)=0.75 -> 9
  //   rbar = (0.5+0.25+0.75)/3 = 0.5
  const cov = [
    [4, 3, 2],
    [3, 9, 9],
    [2, 9, 16],
  ];
  const target = constantCorrelationTarget(cov);
  const sd = [2, 3, 4];
  const rbar = 0.5;

  it('preserves the diagonal (variances)', () => {
    expect(target[0]![0]).toBeCloseTo(4, 10);
    expect(target[1]![1]).toBeCloseTo(9, 10);
    expect(target[2]![2]).toBeCloseTo(16, 10);
  });

  it('sets off-diagonals to rbar * sd_i * sd_j', () => {
    expect(target[0]![1]).toBeCloseTo(rbar * sd[0]! * sd[1]!, 10); // 3
    expect(target[0]![2]).toBeCloseTo(rbar * sd[0]! * sd[2]!, 10); // 4 (was 2)
    expect(target[1]![2]).toBeCloseTo(rbar * sd[1]! * sd[2]!, 10); // 6 (was 9)
  });

  it('is symmetric', () => {
    expect(target[1]![0]).toBe(target[0]![1]);
    expect(target[2]![0]).toBe(target[0]![2]);
    expect(target[2]![1]).toBe(target[1]![2]);
  });
});

describe('shrinkageCovariance', () => {
  // Three-asset return series (constant correlation must differ from sample, so
  // >=2 assets is not enough — a 2-asset target always equals its sample):
  //   0 = [1,2,3]  var 1  sd 1
  //   1 = [2,4,6]  var 4  sd 2
  //   2 = [1,3,2]  var 1  sd 1
  //   sample = [[1, 2, 0.5],[2, 4, 1],[0.5, 1, 1]]
  //   rbar = (1 + 0.5 + 0.5)/3 = 2/3
  //   target off-diags: (0,1)=4/3, (0,2)=2/3, (1,2)=4/3
  const returns = [
    [1, 2, 3],
    [2, 4, 6],
    [1, 3, 2],
  ];
  const sample = sampleCovariance(returns);
  const target = constantCorrelationTarget(sample);

  it('sanity: hand-computed sample and target', () => {
    expect(sample[0]![1]).toBeCloseTo(2, 10);
    expect(sample[0]![2]).toBeCloseTo(0.5, 10);
    expect(sample[1]![2]).toBeCloseTo(1, 10);
    expect(target[0]![1]).toBeCloseTo(4 / 3, 10);
    expect(target[0]![2]).toBeCloseTo(2 / 3, 10);
    expect(target[1]![2]).toBeCloseTo(4 / 3, 10);
  });

  it("method 'none' returns the sample covariance", () => {
    expect(shrinkageCovariance(returns, 'none', 0.3)).toEqual(sample);
  });

  it("'constant_corr' delta=0 returns the sample covariance", () => {
    const out = shrinkageCovariance(returns, 'constant_corr', 0);
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++) expect(out[i]![j]).toBeCloseTo(sample[i]![j]!, 10);
  });

  it("'constant_corr' delta=1 returns the target", () => {
    const out = shrinkageCovariance(returns, 'constant_corr', 1);
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++) expect(out[i]![j]).toBeCloseTo(target[i]![j]!, 10);
  });

  it("'constant_corr' delta=0.5 blends halfway (hand-checked off-diagonals)", () => {
    const out = shrinkageCovariance(returns, 'constant_corr', 0.5);
    // (0,1): 0.5*2   + 0.5*(4/3) = 5/3
    expect(out[0]![1]).toBeCloseTo(5 / 3, 10);
    // (0,2): 0.5*0.5 + 0.5*(2/3) = 7/12
    expect(out[0]![2]).toBeCloseTo(7 / 12, 10);
    // (1,2): 0.5*1   + 0.5*(4/3) = 7/6
    expect(out[1]![2]).toBeCloseTo(7 / 6, 10);
    // Diagonal preserved by the target, so blending leaves it unchanged.
    expect(out[0]![0]).toBeCloseTo(1, 10);
    expect(out[1]![1]).toBeCloseTo(4, 10);
    expect(out[2]![2]).toBeCloseTo(1, 10);
  });

  it("'single_factor' routes through the same constant-correlation target", () => {
    // The enum implies three behaviors; the source implements two.
    const sf = shrinkageCovariance(returns, 'single_factor', 0.5);
    const cc = shrinkageCovariance(returns, 'constant_corr', 0.5);
    expect(sf).toEqual(cc);
  });

  it('clamps delta into [0,1]', () => {
    const lo = shrinkageCovariance(returns, 'constant_corr', -1);
    const hi = shrinkageCovariance(returns, 'constant_corr', 2);
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++) {
        expect(lo[i]![j]).toBeCloseTo(sample[i]![j]!, 10); // clamped to 0
        expect(hi[i]![j]).toBeCloseTo(target[i]![j]!, 10); // clamped to 1
      }
  });
});

describe('annualizedPortfolioVol', () => {
  it('single asset: |w$/E| * sqrt(v) * sqrt(252)', () => {
    // w$=5000, E=100000 -> w=0.05; daily var v=0.0004 (sd 0.02)
    // vol = 0.05 * 0.02 * sqrt(252) = 0.0158745...
    const vol = annualizedPortfolioVol([5000], [[0.0004]], 100_000);
    expect(vol).toBeCloseTo(0.0158745, 6);
  });

  it('two assets: full quadratic form w^T Σ w', () => {
    // w=[0.05,0.05]; Σ=[[4e-4,1e-4],[1e-4,9e-4]]
    // variance = 0.0025*(4e-4 + 2*1e-4 + 9e-4) = 0.0025*15e-4 = 3.75e-6
    // vol = sqrt(3.75e-6 * 252) = sqrt(9.45e-4) = 0.0307409
    const vol = annualizedPortfolioVol(
      [5000, 5000],
      [
        [0.0004, 0.0001],
        [0.0001, 0.0009],
      ],
      100_000,
    );
    expect(vol).toBeCloseTo(0.0307409, 6);
  });

  it('returns 0 for non-positive equity', () => {
    expect(annualizedPortfolioVol([5000], [[0.0004]], 0)).toBe(0);
    expect(annualizedPortfolioVol([5000], [[0.0004]], -100)).toBe(0);
  });

  it('returns 0 for empty covariance', () => {
    expect(annualizedPortfolioVol([], [], 100_000)).toBe(0);
  });
});

describe('portfolioVolScalar', () => {
  const w = [5000];
  const cov = [[0.0004]]; // book vol = 0.0158745 -> 1.58745%

  it('returns 1 when book vol is 0 (zero covariance)', () => {
    expect(portfolioVolScalar(w, [[0]], 20, 100_000)).toBe(1);
  });

  it('returns 1 when book vol is 0 (empty covariance)', () => {
    expect(portfolioVolScalar(w, [], 20, 100_000)).toBe(1);
  });

  it('is down-only: caps at 1 when target exceeds book vol', () => {
    // target 5% > book 1.58745% -> min(1, 5/1.58745) = 1
    expect(portfolioVolScalar(w, cov, 5, 100_000)).toBe(1);
  });

  it('scales below 1 when book vol exceeds target', () => {
    // target 1% < book 1.58745% -> 1 / 1.58745 = 0.6299408
    const s = portfolioVolScalar(w, cov, 1, 100_000);
    expect(s).toBeLessThan(1);
    expect(s).toBeCloseTo(0.6299408, 6);
  });
});

describe('inverseVolWeights', () => {
  it('weights sum to 1', () => {
    const w = inverseVolWeights([1, 2, 3], [1, 1, 1]);
    expect(w.reduce((a, x) => a + x, 0)).toBeCloseTo(1, 12);
  });

  it('lower sigma gets more weight (equal convictions)', () => {
    // raw = [1/1, 1/2] = [1, 0.5]; total 1.5 -> [2/3, 1/3]
    const w = inverseVolWeights([1, 2], [1, 1]);
    expect(w[0]).toBeGreaterThan(w[1]!);
    expect(w[0]).toBeCloseTo(2 / 3, 10);
    expect(w[1]).toBeCloseTo(1 / 3, 10);
  });

  it('conviction tilts the weights', () => {
    // Same sigmas [1,2] as above, but conviction on the higher-sigma name flips
    // the ordering: raw = [1/1, 4/2] = [1, 2]; total 3 -> [1/3, 2/3]
    const w = inverseVolWeights([1, 2], [1, 4]);
    expect(w[1]).toBeGreaterThan(w[0]!);
    expect(w[0]).toBeCloseTo(1 / 3, 10);
    expect(w[1]).toBeCloseTo(2 / 3, 10);
  });

  it('undefined sigma falls back to the median sigma', () => {
    // known = [1,3]; median = known[floor(2/2)] = known[1] = 3 (upper-middle).
    // undefined index uses 3, matching index 2's sigma 3.
    // raw = [1/1, 1/3, 1/3]; total 5/3 -> [0.6, 0.2, 0.2]
    const w = inverseVolWeights([1, undefined, 3], [1, 1, 1]);
    expect(w[0]).toBeCloseTo(0.6, 10);
    expect(w[1]).toBeCloseTo(0.2, 10);
    expect(w[2]).toBeCloseTo(0.2, 10);
    expect(w[1]).toBeCloseTo(w[2]!, 10); // fallback sigma == neighbor's sigma
  });

  it('zero sigma falls back to the median sigma', () => {
    // known = [2,4]; median = known[1] = 4. Zero index uses 4.
    // raw = [1/2, 1/4, 1/4]; total 1 -> [0.5, 0.25, 0.25]
    const w = inverseVolWeights([2, 0, 4], [1, 1, 1]);
    expect(w[0]).toBeCloseTo(0.5, 10);
    expect(w[1]).toBeCloseTo(0.25, 10);
    expect(w[2]).toBeCloseTo(0.25, 10);
  });

  it('all-zero convictions -> equal weights', () => {
    const w = inverseVolWeights([1, 2, 4], [0, 0, 0]);
    expect(w).toHaveLength(3);
    for (const x of w) expect(x).toBeCloseTo(1 / 3, 10);
  });

  it('all sigmas undefined -> median falls back to 1', () => {
    // known = []; medianSigma = 1. raw = [1/1, 3/1] = [1,3]; total 4 -> [0.25,0.75]
    const w = inverseVolWeights([undefined, undefined], [1, 3]);
    expect(w[0]).toBeCloseTo(0.25, 10);
    expect(w[1]).toBeCloseTo(0.75, 10);
  });
});
