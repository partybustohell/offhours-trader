import { describe, expect, it } from 'vitest';
import { ConfigSchema } from '../src/config.js';
import {
  dailyReturns,
  recentReturnPct,
  amihudIlliquidity,
  momentumPct,
  pctOf52wHigh,
  gapSignature,
  stddev,
  isChasing,
  antiChaseHaircut,
  amihudHaircut,
  dispersionScalar,
  costScalar,
  combineScalars,
  attributeScalars,
  trendContraBlock,
  gapContraBlock,
  drawdownThrottle,
  riskOffTriggered,
  participationQty,
  type GapSignature,
} from '../src/signals.js';

// Config sub-objects are built from the schema defaults and overridden per-test.
// All signals ship enabled:false, so `base` is the disabled/no-op form.
const cfg = ConfigSchema.parse({});
const antiChaseBase = cfg.signals.anti_chase; // enabled:false, run_threshold_pct:10, haircut:0.5
const amihudBase = cfg.signals.amihud; // enabled:false, max_amihud:0, size_haircut:0.5
const dispersionBase = cfg.signals.dispersion; // enabled:false, k:0, floor:0.6
const trendBase = cfg.signals.trend_gate; // enabled:false, min_pct_of_52w_high:0.75, contra_block:true
const gapBase = cfg.signals.gap; // enabled:false, min_gap_pct:3, min_rel_volume:2, contra_gate:true
const costBase = cfg.execution.cost_scalar; // enabled:false, floor:0.5, max_roundtrip_cost_bps:45
const participationBase = cfg.execution.participation; // enabled:false, max_top_size_fraction:0.25
const drawdownBase = cfg.risk_overlay.drawdown_throttle; // enabled:false, floor_pct:3, min_throttle:0.25
const riskOffBase = cfg.risk_overlay.risk_off; // enabled:false, spy_drop_pct:2

// ---------- feature extractors ----------

describe('dailyReturns', () => {
  it('computes simple returns of length n-1 for a clean series', () => {
    expect(dailyReturns([100, 110, 121])).toEqual([0.1, 0.1]);
  });

  it('captures negative returns with the right sign', () => {
    expect(dailyReturns([100, 90])).toEqual([-0.1]);
  });

  it('returns [] for series shorter than 2', () => {
    expect(dailyReturns([])).toEqual([]);
    expect(dailyReturns([100])).toEqual([]);
  });

  it('skips a step when the prior close is not positive (output not always n-1)', () => {
    // i=1 prev=0 -> skipped; i=2 prev=100 -> pushed. Only one return survives.
    expect(dailyReturns([0, 100, 110])).toEqual([0.1]);
  });
});

describe('recentReturnPct', () => {
  it('returns the signed % over the lookback window', () => {
    expect(recentReturnPct([100, 105, 110, 120], 3)).toBeCloseTo(20, 10);
  });

  it('is negative when price fell', () => {
    expect(recentReturnPct([100, 90], 1)).toBeCloseTo(-10, 10);
  });

  it('undefined when there are too few positive closes', () => {
    expect(recentReturnPct([100, 110], 5)).toBeUndefined();
  });

  it('filters non-positive closes before measuring', () => {
    // [0,100,110] -> [100,110]; lookback 1 -> (110-100)/100*100 = 10
    expect(recentReturnPct([0, 100, 110], 1)).toBeCloseTo(10, 10);
  });
});

describe('amihudIlliquidity', () => {
  it('computes mean(|ret|/dollarVol)*1e6 for a single step', () => {
    // |0.1| / (110*1000) * 1e6 = 100000/110000 = 0.909090...
    expect(amihudIlliquidity([100, 110], [1000, 1000], 1)).toBeCloseTo(0.909091, 5);
  });

  it('averages the ratios across the window', () => {
    // step1: 0.1/110000 ; step2: 0.1/99000 ; mean*1e6 = 0.959596
    expect(amihudIlliquidity([100, 110, 99], [1000, 1000, 1000], 2)).toBeCloseTo(0.959596, 5);
  });

  it('only uses the last windowDays+1 bars', () => {
    // slice(-2) drops the leading bars -> same as the single-step case
    expect(amihudIlliquidity([1, 2, 100, 110], [1, 1, 1000, 1000], 1)).toBeCloseTo(0.909091, 5);
  });

  it('undefined when closes and volumes lengths differ', () => {
    expect(amihudIlliquidity([100, 110], [1000], 1)).toBeUndefined();
  });

  it('undefined when there are too few bars for the window', () => {
    expect(amihudIlliquidity([100], [1000], 1)).toBeUndefined();
  });

  it('undefined when every step is skipped (no positive dollar volume)', () => {
    expect(amihudIlliquidity([100, 110], [1000, 0], 1)).toBeUndefined();
  });
});

describe('momentumPct', () => {
  it('measures return from lookback ago to skip ago (12-1 style)', () => {
    // c[len-1-1]=140 vs c[len-1-5]=100 -> 40%
    expect(momentumPct([100, 110, 120, 130, 140, 150], 5, 1)).toBeCloseTo(40, 10);
  });

  it('skip 0 measures all the way to the last bar', () => {
    expect(momentumPct([100, 110, 120, 130, 140, 150], 5, 0)).toBeCloseTo(50, 10);
  });

  it('is negative for a downtrend', () => {
    // end=c[4]=110, start=c[0]=150 -> (110-150)/150*100 = -26.6667
    expect(momentumPct([150, 140, 130, 120, 110, 100], 5, 1)).toBeCloseTo(-26.6667, 4);
  });

  it('undefined with too few closes for the lookback', () => {
    expect(momentumPct([100, 110, 120], 5, 1)).toBeUndefined();
  });

  it('undefined when skip runs the end index off the front of the series', () => {
    // c.length 2 passes lookback 1, but end index 2-1-5 = -4 -> undefined
    expect(momentumPct([100, 110], 1, 5)).toBeUndefined();
  });
});

describe('pctOf52wHigh', () => {
  it('last close as a fraction of the window high', () => {
    expect(pctOf52wHigh([100, 120, 90], 252)).toBeCloseTo(0.75, 10);
  });

  it('returns 1 at a new high', () => {
    expect(pctOf52wHigh([80, 100], 20)).toBeCloseTo(1, 10);
  });

  it('only considers the last windowDays closes', () => {
    // window 3 -> [100,120,90], the leading 1000 is excluded
    expect(pctOf52wHigh([1000, 100, 120, 90], 3)).toBeCloseTo(0.75, 10);
  });

  it('filters non-positive closes', () => {
    expect(pctOf52wHigh([0, 100, 120, 90], 20)).toBeCloseTo(0.75, 10);
  });

  it('undefined with fewer than 2 usable closes', () => {
    expect(pctOf52wHigh([100], 20)).toBeUndefined();
  });
});

describe('gapSignature', () => {
  it('computes gap up % and relative volume', () => {
    const g = gapSignature([100, 110], [100, 108], [1000, 2000]);
    expect(g).toBeDefined();
    expect(g!.gapPct).toBeCloseTo(10, 10);
    expect(g!.relVolume).toBeCloseTo(2, 10);
  });

  it('gap down is negative', () => {
    const g = gapSignature([100, 90], [100, 95], [1000, 3000]);
    expect(g!.gapPct).toBeCloseTo(-10, 10);
    expect(g!.relVolume).toBeCloseTo(3, 10);
  });

  it('respects the volume window when averaging prior volumes', () => {
    // window 2 -> priorVols = volumes[1..3) = [2000,3000], avg 2500, rel = 8000/2500 = 3.2
    const g = gapSignature([100, 100, 100, 120], [100, 100, 100, 110], [1000, 2000, 3000, 8000], 2);
    expect(g!.gapPct).toBeCloseTo(20, 10);
    expect(g!.relVolume).toBeCloseTo(3.2, 10);
  });

  it('relVolume is 0 when no positive prior volume exists', () => {
    const g = gapSignature([100, 110], [100, 108], [0, 2000]);
    expect(g!.gapPct).toBeCloseTo(10, 10);
    expect(g!.relVolume).toBe(0);
  });

  it('undefined with fewer than 2 bars', () => {
    expect(gapSignature([100], [100], [1000])).toBeUndefined();
  });

  it('undefined when the arrays are misaligned in length', () => {
    expect(gapSignature([100, 110], [100, 108], [1000])).toBeUndefined();
  });

  it('undefined when the prior close is non-positive', () => {
    expect(gapSignature([100, 110], [0, 108], [1000, 2000])).toBeUndefined();
  });
});

// ---------- down-only size scalars ----------

describe('stddev', () => {
  it('is 0 for fewer than 2 points', () => {
    expect(stddev([])).toBe(0);
    expect(stddev([5])).toBe(0);
  });

  it('is the sample (n-1) standard deviation', () => {
    expect(stddev([1, 2, 3, 4, 5])).toBeCloseTo(1.581139, 5);
    expect(stddev([2, 4])).toBeCloseTo(1.414214, 5);
  });

  it('is 0 when all values are equal', () => {
    expect(stddev([5, 5, 5])).toBe(0);
  });
});

describe('isChasing', () => {
  const on = { ...antiChaseBase, enabled: true };

  it('returns false when disabled (never fires)', () => {
    expect(isChasing(50, 'long', antiChaseBase)).toBe(false);
    expect(isChasing(-50, 'short', antiChaseBase)).toBe(false);
  });

  it('returns false when the recent return is undefined', () => {
    expect(isChasing(undefined, 'long', on)).toBe(false);
  });

  it('long fires when the name ran up past the threshold (inclusive)', () => {
    expect(isChasing(20, 'long', on)).toBe(true);
    expect(isChasing(10, 'long', on)).toBe(true); // boundary
    expect(isChasing(5, 'long', on)).toBe(false);
  });

  it('short fires when the name ran down past the threshold (inclusive)', () => {
    expect(isChasing(-20, 'short', on)).toBe(true);
    expect(isChasing(-10, 'short', on)).toBe(true); // boundary
    expect(isChasing(-5, 'short', on)).toBe(false);
  });

  it('a run in the opposite direction is not chasing', () => {
    expect(isChasing(20, 'short', on)).toBe(false); // ran up, but shorting
    expect(isChasing(-20, 'long', on)).toBe(false); // ran down, but buying
  });
});

describe('antiChaseHaircut', () => {
  const on = { ...antiChaseBase, enabled: true };

  it('returns exactly 1 when disabled', () => {
    expect(antiChaseHaircut(50, 'long', antiChaseBase)).toBe(1);
  });

  it('applies the haircut when chasing', () => {
    expect(antiChaseHaircut(20, 'long', on)).toBe(0.5);
  });

  it('returns 1 when not chasing', () => {
    expect(antiChaseHaircut(5, 'long', on)).toBe(1);
  });
});

describe('amihudHaircut', () => {
  it('returns exactly 1 when disabled', () => {
    expect(amihudHaircut(999, amihudBase)).toBe(1);
  });

  it('returns 1 even when enabled if max_amihud <= 0 (no-op threshold)', () => {
    expect(amihudHaircut(999, { ...amihudBase, enabled: true })).toBe(1);
  });

  it('returns 1 when the amihud value is undefined', () => {
    expect(amihudHaircut(undefined, { ...amihudBase, enabled: true, max_amihud: 1 })).toBe(1);
  });

  it('haircuts a name above the threshold, passes one at/below it', () => {
    const on = { ...amihudBase, enabled: true, max_amihud: 1 };
    expect(amihudHaircut(2, on)).toBe(0.5);
    expect(amihudHaircut(1, on)).toBe(1); // boundary, not strictly greater
    expect(amihudHaircut(0.5, on)).toBe(1);
  });
});

describe('dispersionScalar', () => {
  it('returns exactly 1 when disabled', () => {
    expect(dispersionScalar([0.5, 0.9], dispersionBase)).toBe(1);
  });

  it('returns 1 when enabled but k <= 0', () => {
    expect(dispersionScalar([0.5, 0.9], { ...dispersionBase, enabled: true })).toBe(1);
  });

  it('returns 1 with fewer than 2 convictions', () => {
    expect(dispersionScalar([0.5], { ...dispersionBase, enabled: true, k: 1 })).toBe(1);
  });

  it('shrinks by 1 - k*stddev when firing', () => {
    // stddev([0.5,0.9]) = 0.282843 ; 1 - 1*0.282843 = 0.717157
    expect(dispersionScalar([0.5, 0.9], { ...dispersionBase, enabled: true, k: 1 })).toBeCloseTo(
      0.717157,
      5,
    );
  });

  it('never drops below the floor', () => {
    // 1 - 10*0.282843 = -1.828 -> clamped to floor 0.6
    expect(dispersionScalar([0.5, 0.9], { ...dispersionBase, enabled: true, k: 10 })).toBe(0.6);
  });
});

describe('costScalar', () => {
  it('returns exactly 1 when disabled', () => {
    expect(costScalar(100, costBase)).toBe(1);
  });

  it('returns 1 when max_roundtrip_cost_bps <= 0', () => {
    expect(costScalar(10, { ...costBase, enabled: true, max_roundtrip_cost_bps: 0 })).toBe(1);
  });

  it('shrinks linearly as the spread widens', () => {
    // 1 - 9/45 = 0.8
    expect(costScalar(9, { ...costBase, enabled: true })).toBeCloseTo(0.8, 10);
  });

  it('caps at 1 for zero or negative (crossed) spreads', () => {
    expect(costScalar(0, { ...costBase, enabled: true })).toBe(1);
    expect(costScalar(-10, { ...costBase, enabled: true })).toBe(1);
  });

  it('never drops below the floor for a wide spread', () => {
    // 1 - 100/45 = -1.22 -> clamped to floor 0.5
    expect(costScalar(100, { ...costBase, enabled: true })).toBe(0.5);
  });
});

describe('combineScalars', () => {
  it('applies the floor when the product collapses', () => {
    expect(combineScalars([0.1, 0.1], 0.2)).toBe(0.2);
  });

  it('returns the product when it clears the floor', () => {
    expect(combineScalars([0.8, 0.5], 0.2)).toBeCloseTo(0.4, 10);
    expect(combineScalars([0.9], 0.2)).toBeCloseTo(0.9, 10);
  });

  it('an empty list is a no-op (product 1)', () => {
    expect(combineScalars([], 0.2)).toBe(1);
  });

  it('a floor of 0 lets the product through unclamped', () => {
    expect(combineScalars([0.1, 0.1], 0)).toBeCloseTo(0.01, 10);
  });
});

describe('attributeScalars (leave-one-out counterfactual)', () => {
  it('all-1 scalars: product 1 and every leave-one-out is 1', () => {
    const a = attributeScalars({ x: 1, y: 1, z: 1 }, 0.2);
    expect(a.product).toBe(1);
    expect(a.leaveOneOut).toEqual({ x: 1, y: 1, z: 1 });
  });

  it('attributes a single active signal: removing it restores full size', () => {
    // x=0.5 shrinks; y,z inactive. product 0.5; remove x -> 1; remove y or z -> 0.5.
    const a = attributeScalars({ x: 0.5, y: 1, z: 1 }, 0.2);
    expect(a.product).toBeCloseTo(0.5, 10);
    expect(a.leaveOneOut.x).toBeCloseTo(1, 10); // marginal shrink of x = 1 - 0.5
    expect(a.leaveOneOut.y).toBeCloseTo(0.5, 10);
    expect(a.leaveOneOut.z).toBeCloseTo(0.5, 10);
  });

  it('floor-bound: recomputes leave-one-out, never divides out (no false 0)', () => {
    // 0.5 * 0.3 = 0.15 -> floored to 0.2. Remove 0.5 -> max(0.2,0.3)=0.3;
    // remove 0.3 -> max(0.2,0.5)=0.5. Both attributed positively; neither reads 0.
    const a = attributeScalars({ p: 0.5, q: 0.3 }, 0.2);
    expect(a.product).toBeCloseTo(0.2, 10);
    expect(a.leaveOneOut.p).toBeCloseTo(0.3, 10);
    expect(a.leaveOneOut.q).toBeCloseTo(0.5, 10);
    // a naive divide-out would give p: 0.2/0.5=0.4 and q: 0.2/0.3=0.67 — wrong.
  });
});

// ---------- gates (true = block) ----------

describe('trendContraBlock', () => {
  const on = { ...trendBase, enabled: true };
  // strongUp: momentum>0 && pctHigh>=0.75 ; strongDown: momentum<0 && pctHigh<=0.25

  it('never blocks when disabled', () => {
    expect(trendContraBlock(20, 0.9, 'short', trendBase)).toBe(false);
  });

  it('never blocks when contra_block is off', () => {
    expect(trendContraBlock(20, 0.9, 'short', { ...on, contra_block: false })).toBe(false);
  });

  it('blocks a short into a strong uptrend', () => {
    expect(trendContraBlock(20, 0.9, 'short', on)).toBe(true);
    expect(trendContraBlock(1, 0.75, 'short', on)).toBe(true); // pctHigh boundary
  });

  it('does not block a long that goes with a strong uptrend', () => {
    expect(trendContraBlock(20, 0.9, 'long', on)).toBe(false);
  });

  it('blocks a long into a strong downtrend', () => {
    expect(trendContraBlock(-20, 0.2, 'long', on)).toBe(true);
    expect(trendContraBlock(-1, 0.25, 'long', on)).toBe(true); // pctHigh boundary (<= 1-0.75)
  });

  it('does not block a short that goes with a strong downtrend', () => {
    expect(trendContraBlock(-20, 0.2, 'short', on)).toBe(false);
  });

  it('does not block when the trend is not strong', () => {
    expect(trendContraBlock(20, 0.5, 'short', on)).toBe(false); // pctHigh below 0.75
    expect(trendContraBlock(-20, 0.5, 'long', on)).toBe(false); // pctHigh above 0.25
  });

  it('never blocks when momentum or pctHigh is undefined', () => {
    expect(trendContraBlock(undefined, 0.9, 'short', on)).toBe(false);
    expect(trendContraBlock(20, undefined, 'short', on)).toBe(false);
  });
});

describe('gapContraBlock', () => {
  const on = { ...gapBase, enabled: true };
  const g = (gapPct: number, relVolume: number): GapSignature => ({ gapPct, relVolume });

  it('never blocks when disabled', () => {
    expect(gapContraBlock(g(5, 3), 'short', gapBase)).toBe(false);
  });

  it('never blocks when contra_gate is off', () => {
    expect(gapContraBlock(g(5, 3), 'short', { ...on, contra_gate: false })).toBe(false);
  });

  it('never blocks when the gap is undefined', () => {
    expect(gapContraBlock(undefined, 'short', on)).toBe(false);
  });

  it('blocks a short fading a big gap up on volume', () => {
    expect(gapContraBlock(g(5, 3), 'short', on)).toBe(true);
    expect(gapContraBlock(g(3, 2), 'short', on)).toBe(true); // both boundaries inclusive
  });

  it('does not block a long that goes with a big gap up', () => {
    expect(gapContraBlock(g(5, 3), 'long', on)).toBe(false);
  });

  it('blocks a long fading a big gap down on volume', () => {
    expect(gapContraBlock(g(-5, 3), 'long', on)).toBe(true);
  });

  it('does not block a short that goes with a big gap down', () => {
    expect(gapContraBlock(g(-5, 3), 'short', on)).toBe(false);
  });

  it('does not block when the gap is too small', () => {
    expect(gapContraBlock(g(2, 5), 'short', on)).toBe(false);
  });

  it('does not block when relative volume is too low', () => {
    expect(gapContraBlock(g(5, 1), 'short', on)).toBe(false);
  });
});

// ---------- book-level live overlays ----------

describe('drawdownThrottle', () => {
  const on = { ...drawdownBase, enabled: true };

  it('returns exactly 1 when disabled', () => {
    expect(drawdownThrottle(50, 100, drawdownBase)).toBe(1);
  });

  it('returns 1 with no valid peak', () => {
    expect(drawdownThrottle(50, 0, on)).toBe(1);
    expect(drawdownThrottle(50, -10, on)).toBe(1);
  });

  it('returns 1 at or above the high-water mark', () => {
    expect(drawdownThrottle(100, 100, on)).toBe(1);
    expect(drawdownThrottle(110, 100, on)).toBe(1); // above peak -> ddPct clamped to 0
  });

  it('throttles linearly with drawdown', () => {
    // dd 1.5% of floor 3% -> 1 - 1.5/3 = 0.5
    expect(drawdownThrottle(98.5, 100, on)).toBeCloseTo(0.5, 10);
    // dd 1% -> 1 - 1/3 = 0.66667
    expect(drawdownThrottle(99, 100, on)).toBeCloseTo(0.66667, 5);
  });

  it('never drops below min_throttle', () => {
    // dd 10% -> 1 - 10/3 = -2.33 -> clamped to 0.25
    expect(drawdownThrottle(90, 100, on)).toBe(0.25);
  });
});

describe('riskOffTriggered', () => {
  const on = { ...riskOffBase, enabled: true };

  it('returns false when disabled', () => {
    expect(riskOffTriggered(-5, riskOffBase)).toBe(false);
  });

  it('returns false when the index drop is undefined', () => {
    expect(riskOffTriggered(undefined, on)).toBe(false);
  });

  it('fires when the index drop reaches the threshold (inclusive)', () => {
    expect(riskOffTriggered(-3, on)).toBe(true);
    expect(riskOffTriggered(-2, on)).toBe(true); // boundary
  });

  it('does not fire on a shallow drop or an up move', () => {
    expect(riskOffTriggered(-1, on)).toBe(false);
    expect(riskOffTriggered(5, on)).toBe(false);
  });
});

describe('participationQty', () => {
  const on = { ...participationBase, enabled: true };

  it('returns the notional qty unchanged when disabled', () => {
    expect(participationQty(1000, 500, participationBase)).toBe(1000);
  });

  it('returns the notional qty when displayed size is unknown (<=0)', () => {
    expect(participationQty(1000, 0, on)).toBe(1000);
  });

  it('caps qty at the floored fraction of displayed size', () => {
    // floor(0.25 * 1000) = 250
    expect(participationQty(1000, 1000, on)).toBe(250);
  });

  it('passes through a qty already under the cap', () => {
    expect(participationQty(100, 1000, on)).toBe(100);
  });

  it('floors the cap toward zero', () => {
    // floor(0.25 * 10) = floor(2.5) = 2
    expect(participationQty(100, 10, on)).toBe(2);
  });

  it('never returns a negative qty', () => {
    expect(participationQty(-5, 1000, on)).toBe(0);
  });
});
