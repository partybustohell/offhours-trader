import { describe, expect, it } from 'vitest';
import { desiredProtectiveStop, planStopAction } from '../src/trailing-stop.js';
import type { ExitPlan } from '../src/types.js';

const trailPlan: ExitPlan = {
  hardStopPct: 8,
  trail: { activatePct: 5, trailPct: 4, floorAtEntry: true },
};

const longBase = { side: 'long' as const, entryPrice: 100, peak: 0, plan: trailPlan };

describe('desiredProtectiveStop: long', () => {
  it('unarmed: hard stop at entry minus hardStopPct', () => {
    expect(desiredProtectiveStop({ ...longBase, peak: 104.9 })).toBe(92);
  });

  it('no trail in plan: hard stop regardless of peak', () => {
    expect(desiredProtectiveStop({ ...longBase, plan: { hardStopPct: 8 }, peak: 130 })).toBe(92);
  });

  it('no peak data (0): hard stop only', () => {
    expect(desiredProtectiveStop({ ...longBase, peak: 0 })).toBe(92);
  });

  it('armed at exactly the activation gain: trail floor from the peak', () => {
    // peak 105 -> max(breakeven 100, 105 * 0.96 = 100.8) = 100.8
    expect(desiredProtectiveStop({ ...longBase, peak: 105 })).toBe(100.8);
  });

  it('armed with a deep peak: trails the high-water mark', () => {
    expect(desiredProtectiveStop({ ...longBase, peak: 120 })).toBe(115.2);
  });

  it('breakeven floor dominates a wide trail', () => {
    const widePlan: ExitPlan = {
      hardStopPct: 8,
      trail: { activatePct: 5, trailPct: 8, floorAtEntry: true },
    };
    // peak 105: 105 * 0.92 = 96.6 < entry -> ratchet to breakeven 100
    expect(desiredProtectiveStop({ ...longBase, plan: widePlan, peak: 105 })).toBe(100);
  });

  it('without floorAtEntry a wide trail may sit below entry (never below hard stop)', () => {
    const widePlan: ExitPlan = {
      hardStopPct: 8,
      trail: { activatePct: 5, trailPct: 8 },
    };
    expect(desiredProtectiveStop({ ...longBase, plan: widePlan, peak: 105 })).toBe(96.6);
  });

  it('rounds to cents', () => {
    // peak 105.1234 * 0.96 = 100.918464 -> 100.92
    expect(desiredProtectiveStop({ ...longBase, peak: 105.1234 })).toBe(100.92);
  });
});

describe('desiredProtectiveStop: short', () => {
  const shortBase = { side: 'short' as const, entryPrice: 100, peak: 0, plan: trailPlan };

  it('unarmed: hard stop at entry plus hardStopPct', () => {
    expect(desiredProtectiveStop({ ...shortBase, peak: 95.1 })).toBe(108);
  });

  it('armed: trail floor above the low-water mark, floored at breakeven', () => {
    // trough 95 -> min(breakeven 100, 95 * 1.04 = 98.8) = 98.8
    expect(desiredProtectiveStop({ ...shortBase, peak: 95 })).toBe(98.8);
  });

  it('deep trough trails down with the move', () => {
    expect(desiredProtectiveStop({ ...shortBase, peak: 80 })).toBe(83.2);
  });

  it('breakeven floor dominates a wide trail on shorts', () => {
    const widePlan: ExitPlan = {
      hardStopPct: 8,
      trail: { activatePct: 5, trailPct: 8, floorAtEntry: true },
    };
    // trough 95 * 1.08 = 102.6 > entry -> ratchet to breakeven 100
    expect(desiredProtectiveStop({ ...shortBase, plan: widePlan, peak: 95 })).toBe(100);
  });
});

describe('planStopAction', () => {
  const armed = { ...longBase, peak: 120, qty: 18 }; // desired 115.2

  it('no resting stop: place at the desired level', () => {
    expect(planStopAction(armed)).toEqual({ action: 'place', stopPrice: 115.2, qty: 18 });
  });

  it('resting stop below the desired level: replace upward', () => {
    expect(
      planStopAction({ ...armed, existing: { id: 'abc', stopPrice: 92, qty: 18 } }),
    ).toEqual({ action: 'replace', cancelId: 'abc', stopPrice: 115.2, qty: 18 });
  });

  it('resting stop already tighter: never loosen', () => {
    expect(
      planStopAction({ ...armed, existing: { id: 'abc', stopPrice: 116, qty: 18 } }),
    ).toEqual({ action: 'none' });
  });

  it('sub-cent improvement: no churn', () => {
    expect(
      planStopAction({ ...armed, existing: { id: 'abc', stopPrice: 115.195, qty: 18 } }),
    ).toEqual({ action: 'none' });
  });

  it('qty drift: replace to re-cover the position without loosening the level', () => {
    expect(
      planStopAction({ ...armed, existing: { id: 'abc', stopPrice: 116, qty: 10 } }),
    ).toEqual({ action: 'replace', cancelId: 'abc', stopPrice: 116, qty: 18 });
  });

  it('short: replace moves the stop DOWN as the trough deepens', () => {
    const shortCtx = {
      side: 'short' as const,
      entryPrice: 100,
      peak: 80,
      qty: 4,
      plan: trailPlan,
      existing: { id: 's1', stopPrice: 98.8, qty: 4 },
    };
    expect(planStopAction(shortCtx)).toEqual({
      action: 'replace',
      cancelId: 's1',
      stopPrice: 83.2,
      qty: 4,
    });
  });

  it('zero qty or entry: no action', () => {
    expect(planStopAction({ ...armed, qty: 0 })).toEqual({ action: 'none' });
    expect(planStopAction({ ...armed, entryPrice: 0 })).toEqual({ action: 'none' });
  });
});

describe('desiredProtectiveStop: two-tier breakeven arming', () => {
  const tierPlan: ExitPlan = {
    hardStopPct: 8,
    trail: { activatePct: 5, trailPct: 4, floorAtEntry: true, breakevenAtPct: 1 },
  };
  const base = { side: 'long' as const, entryPrice: 100, plan: tierPlan };

  it('long: peak +1% ratchets the stop to breakeven', () => {
    expect(desiredProtectiveStop({ ...base, peak: 101 })).toBe(100);
  });

  it('long: peak +4.9% stays at breakeven (HWM trail not yet armed)', () => {
    expect(desiredProtectiveStop({ ...base, peak: 104.9 })).toBe(100);
  });

  it('long: peak +0.9% keeps the hard stop', () => {
    expect(desiredProtectiveStop({ ...base, peak: 100.9 })).toBe(92);
  });

  it('long: peak +5% switches to the HWM trail above breakeven', () => {
    expect(desiredProtectiveStop({ ...base, peak: 105 })).toBe(100.8);
  });

  it('short: trough -1% ratchets the buy stop to breakeven', () => {
    expect(
      desiredProtectiveStop({ side: 'short', entryPrice: 100, plan: tierPlan, peak: 99 }),
    ).toBe(100);
  });

  it('short: trough -0.9% keeps the hard stop', () => {
    expect(
      desiredProtectiveStop({ side: 'short', entryPrice: 100, plan: tierPlan, peak: 99.1 }),
    ).toBe(108);
  });
});
