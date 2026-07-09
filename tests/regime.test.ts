import { describe, expect, it } from 'vitest';
import {
  NEUTRAL_REGIME,
  computeRegime,
  percentileRank,
  rollingRealizedVol,
} from '../src/regime.js';
import { realizedVolAnnualized } from '../src/candidates.js';
import { ConfigSchema, type Config } from '../src/config.js';

// cfg = ConfigSchema.parse({}).regime with sub-flag overrides. Schema mins
// force sma_long_days/ma_days >= 20 and vol.percentile_window_days >= 60, so
// fixtures are moderate (not the 3-5 day windows the prompt suggested) but
// still hand-verifiable.
function regime(overrides: Record<string, unknown>): Config['regime'] {
  return ConfigSchema.parse({ regime: overrides }).regime;
}

// Build a positive close series from a base and a list of log returns, so vol
// fixtures are exact (Math.exp) rather than rounded literals. Length = rets+1.
function fromReturns(base: number, rets: number[]): number[] {
  const out = [base];
  for (const r of rets) out.push(out[out.length - 1]! * Math.exp(r));
  return out;
}

// Linear ramp of n closes starting at `start`, step `step`.
function ramp(start: number, step: number, n: number): number[] {
  return Array.from({ length: n }, (_, i) => start + i * step);
}

describe('NEUTRAL_REGIME', () => {
  it('is all-1 scalars, no bump, neutral state', () => {
    expect(NEUTRAL_REGIME).toEqual({
      longScalar: 1,
      shortScalar: 1,
      volScalar: 1,
      thresholdBump: 0,
      state: 'neutral',
    });
  });
});

describe('percentileRank', () => {
  it('returns 0.5 for fewer than 2 points', () => {
    expect(percentileRank([])).toBe(0.5);
    expect(percentileRank([42])).toBe(0.5);
  });

  it('is the fraction strictly below the last value', () => {
    // last=3, {1,2} below of 2 others -> 2/2
    expect(percentileRank([1, 2, 3])).toBe(1);
    // last=1, none below -> 0/2
    expect(percentileRank([3, 2, 1])).toBe(0);
    // last=2, {1} below of 2 others -> 1/2
    expect(percentileRank([1, 3, 2])).toBe(0.5);
    // last=50, 4 below of 4 others -> 1
    expect(percentileRank([10, 20, 30, 40, 50])).toBe(1);
    // last=4, {1,2,3} below of 4 others -> 3/4
    expect(percentileRank([5, 1, 2, 3, 4])).toBe(0.75);
  });

  it('counts STRICTLY below, so ties with the last value do not count', () => {
    // last=2, the other 2 is not < 2 -> 0/1
    expect(percentileRank([2, 2])).toBe(0);
    // last=2, {1} below; the earlier 2 is a tie -> 1/2
    expect(percentileRank([1, 2, 2])).toBe(0.5);
  });
});

describe('rollingRealizedVol', () => {
  // 12 positive closes; every 8-close window yields a defined vol.
  const closes = [100, 101, 99, 102, 98, 103, 97, 104, 96, 105, 95, 106];
  const LB = 7; // window = LB+1 = 8 closes, the minimum realizedVolAnnualized needs

  it('emits one vol per trailing day: length = min(N - lookback, pctWindow + 1)', () => {
    // N - lookback = 12 - 7 = 5 is the saturation ceiling.
    expect(rollingRealizedVol(closes, LB, 2)).toHaveLength(3); // min(5, 3)
    expect(rollingRealizedVol(closes, LB, 3)).toHaveLength(4); // min(5, 4)
    expect(rollingRealizedVol(closes, LB, 4)).toHaveLength(5); // min(5, 5)
    expect(rollingRealizedVol(closes, LB, 100)).toHaveLength(5); // saturated at 5
  });

  it('widening the percentile window is monotonic non-decreasing in length', () => {
    const lengths = [1, 2, 3, 4, 5, 50].map((w) => rollingRealizedVol(closes, LB, w).length);
    for (let i = 1; i < lengths.length; i++) {
      expect(lengths[i]!).toBeGreaterThanOrEqual(lengths[i - 1]!);
    }
    // Ceiling is data-bound (N - lookback), independent of how wide the window grows.
    expect(lengths.at(-1)).toBe(closes.length - LB);
  });

  it('the last value is the vol of the final lookback+1 closes, regardless of window', () => {
    const expectedLast = realizedVolAnnualized(closes.slice(-(LB + 1)));
    for (const w of [2, 4, 100]) {
      const out = rollingRealizedVol(closes, LB, w);
      expect(out.at(-1)).toBe(expectedLast);
    }
  });

  it('each value equals realizedVolAnnualized over the exact trailing window', () => {
    const pctWindow = 100; // fully saturated
    const out = rollingRealizedVol(closes, LB, pctWindow);
    const firstEnd = Math.max(LB + 1, closes.length - pctWindow);
    const expected: number[] = [];
    for (let end = firstEnd; end <= closes.length; end++) {
      expected.push(realizedVolAnnualized(closes.slice(end - LB - 1, end))!);
    }
    expect(out).toEqual(expected);
  });

  it('returns [] when the window is too short to compute any vol (lookback < 7)', () => {
    // window = 6 closes < 8 -> realizedVolAnnualized undefined for every slice
    expect(rollingRealizedVol(closes, 5, 100)).toEqual([]);
  });

  it('returns [] when there are fewer than lookback+1 closes', () => {
    expect(rollingRealizedVol([], LB, 60)).toEqual([]);
    expect(rollingRealizedVol(closes.slice(0, 7), LB, 60)).toEqual([]);
  });
});

describe('computeRegime', () => {
  it('is inert (NEUTRAL) when every sub-signal is disabled (defaults)', () => {
    const cfg = ConfigSchema.parse({}).regime;
    expect(computeRegime(ramp(100, 1, 30), cfg)).toEqual(NEUTRAL_REGIME);
  });

  describe('trend sub-signal', () => {
    const trendCfg = regime({
      trend: {
        enabled: true,
        sma_long_days: 20,
        benign_long_scalar: 1.0,
        benign_short_scalar: 0.6,
        hostile_long_scalar: 0.4,
        hostile_short_scalar: 1.0,
        threshold_bump: 0.1,
      },
    });

    it('benign when the index is above its long SMA: shrinks shorts, no bump', () => {
      // ascending 100..119, last 119 > mean 109.5
      const r = computeRegime(ramp(100, 1, 20), trendCfg);
      expect(r.longScalar).toBe(1.0);
      expect(r.shortScalar).toBe(0.6);
      expect(r.volScalar).toBe(1);
      expect(r.thresholdBump).toBe(0);
      expect(r.state).toBe('trend:benign');
    });

    it('hostile when the index is below its long SMA: shrinks longs and bumps threshold', () => {
      // descending 119..100, last 100 < mean 109.5
      const r = computeRegime(ramp(119, -1, 20), trendCfg);
      expect(r.longScalar).toBe(0.4);
      expect(r.shortScalar).toBe(1.0);
      expect(r.volScalar).toBe(1);
      expect(r.thresholdBump).toBe(0.1);
      expect(r.state).toBe('trend:hostile');
    });

    it('is inert when there are too few closes to form the SMA', () => {
      // only 10 closes, sma_long_days=20 -> SMA undefined -> branch no-op
      expect(computeRegime(ramp(100, 1, 10), trendCfg)).toEqual(NEUTRAL_REGIME);
    });
  });

  describe('vol sub-signal', () => {
    // lookback=7 + N=10 closes -> exactly 3 rolling vols (N-7 binds under the
    // schema-min percentile_window_days of 60). Single-spike window vol = 6*|ret|.
    const volCfg = regime({
      vol: {
        enabled: true,
        lookback_days: 7,
        percentile_window_days: 60,
        elevated_pctile: 0.5,
        stressed_pctile: 0.95,
        elevated_scalar: 0.6,
        stressed_scalar: 0.3,
      },
    });

    it('stressed band (pctile 1.0): spike only in the final window', () => {
      // rolling vols [0, 0, 0.9] -> last strictly above both -> pctile 1.0
      const closes = fromReturns(100, [0, 0, 0, 0, 0, 0, 0, 0, -0.15]);
      expect(percentileRank(rollingRealizedVol(closes, 7, 60))).toBe(1);
      const r = computeRegime(closes, volCfg);
      expect(r.volScalar).toBe(0.3); // stressed_scalar
      expect(r.longScalar).toBe(1);
      expect(r.shortScalar).toBe(1);
      expect(r.state).toBe('vol:stressed');
    });

    it('elevated band (pctile 0.5): final window vol sits in the middle', () => {
      // rolling vols ~[0.6, 1.428, 1.2] -> last above one, below one -> pctile 0.5
      const closes = fromReturns(100, [0, -0.1, 0, 0, 0, 0, 0, 0.2, 0]);
      expect(percentileRank(rollingRealizedVol(closes, 7, 60))).toBe(0.5);
      const r = computeRegime(closes, volCfg);
      expect(r.volScalar).toBe(0.6); // elevated_scalar
      expect(r.state).toBe('vol:elevated');
    });

    it('normal band (pctile 0): final window is the calmest -> no vol haircut', () => {
      // rolling vols ~[1.428, 0.6, 0] -> last below both -> pctile 0
      const closes = fromReturns(100, [0.2, -0.1, 0, 0, 0, 0, 0, 0, 0]);
      expect(percentileRank(rollingRealizedVol(closes, 7, 60))).toBe(0);
      const r = computeRegime(closes, volCfg);
      expect(r.volScalar).toBe(1);
      expect(r.state).toBe('vol:normal');
    });

    it('is inert when the vol series has fewer than 2 points', () => {
      // 8 closes -> 1 window -> series length 1 -> branch no-op
      const closes = fromReturns(100, [0.01, -0.01, 0.02, -0.02, 0.01, -0.01, 0.03]);
      expect(computeRegime(closes, volCfg)).toEqual(NEUTRAL_REGIME);
    });
  });

  describe('gross sub-signal', () => {
    const grossCfg = regime({
      gross: { enabled: true, ma_days: 20, risk_off_scalar: 0.5 },
    });

    it('risk-off when the index is below its MA: shrinks both sides equally', () => {
      // descending, last 100 < mean 109.5
      const r = computeRegime(ramp(119, -1, 20), grossCfg);
      expect(r.longScalar).toBe(0.5);
      expect(r.shortScalar).toBe(0.5);
      expect(r.volScalar).toBe(1);
      expect(r.thresholdBump).toBe(0);
      expect(r.state).toBe('gross:risk_off');
    });

    it('is inert (neutral) when the index is at or above its MA', () => {
      // ascending, last 119 >= mean 109.5 -> not risk-off, nothing pushed
      expect(computeRegime(ramp(100, 1, 20), grossCfg)).toEqual(NEUTRAL_REGIME);
    });
  });

  describe('multiple sub-signals stack multiplicatively', () => {
    it('trend hostile x gross risk_off multiplies the scalars', () => {
      const cfg = regime({
        trend: {
          enabled: true,
          sma_long_days: 20,
          hostile_long_scalar: 0.4,
          hostile_short_scalar: 1.0,
          threshold_bump: 0.1,
        },
        gross: { enabled: true, ma_days: 20, risk_off_scalar: 0.5 },
      });
      const r = computeRegime(ramp(119, -1, 20), cfg);
      expect(r.longScalar).toBeCloseTo(0.4 * 0.5, 12); // 0.2
      expect(r.shortScalar).toBeCloseTo(1.0 * 0.5, 12); // 0.5
      expect(r.volScalar).toBe(1);
      expect(r.thresholdBump).toBe(0.1);
      expect(r.state).toBe('trend:hostile,gross:risk_off');
    });

    it('trend x vol x gross all fire together on one crafted series', () => {
      // 26 flat closes then a 10% drop: only the final vol window sees the drop
      // (pctile 1.0 -> stressed); SMA(last 20)=99.5 > 90 -> hostile + risk_off.
      const closes = [...Array(26).fill(100), 90];
      const cfg = regime({
        trend: {
          enabled: true,
          sma_long_days: 20,
          hostile_long_scalar: 0.4,
          hostile_short_scalar: 1.0,
          threshold_bump: 0.1,
        },
        vol: {
          enabled: true,
          lookback_days: 7,
          percentile_window_days: 60,
          elevated_pctile: 0.5,
          stressed_pctile: 0.95,
          elevated_scalar: 0.6,
          stressed_scalar: 0.3,
        },
        gross: { enabled: true, ma_days: 20, risk_off_scalar: 0.5 },
      });
      const r = computeRegime(closes, cfg);
      expect(r.longScalar).toBeCloseTo(0.4 * 0.5, 12); // trend*gross = 0.2
      expect(r.shortScalar).toBeCloseTo(1.0 * 0.5, 12); // 0.5
      expect(r.volScalar).toBe(0.3); // stressed
      expect(r.thresholdBump).toBe(0.1);
      expect(r.state).toBe('trend:hostile,vol:stressed,gross:risk_off');
    });
  });
});
