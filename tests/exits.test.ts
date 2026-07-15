import { describe, expect, it } from 'vitest';
import { evaluateExit, type ExitContext } from '../src/exits.js';

const base: ExitContext = {
  direction: 'long',
  entryPrice: 100,
  entryTimeMs: 0,
  markPrice: 100,
  peakFavorablePrice: 100,
  nowMs: 0,
  plan: { hardStopPct: 8 },
};

describe('evaluateExit: hard stop', () => {
  it('fires for a long at exactly the stop level', () => {
    const d = evaluateExit({ ...base, markPrice: 92 });
    expect(d.exit).toBe(true);
    expect(d.trigger).toBe('hard_stop');
  });

  it('does not fire a hair above the stop level', () => {
    expect(evaluateExit({ ...base, markPrice: 92.01 }).exit).toBe(false);
  });

  it('fires for a short when the mark rises to the stop level', () => {
    const d = evaluateExit({ ...base, direction: 'short', markPrice: 108, peakFavorablePrice: 100 });
    expect(d.exit).toBe(true);
    expect(d.trigger).toBe('hard_stop');
  });

  it('never fires on a zero entry price (no basis)', () => {
    expect(evaluateExit({ ...base, entryPrice: 0, markPrice: 1 }).exit).toBe(false);
  });

  it('short: does not fire a hair below the stop level', () => {
    expect(evaluateExit({ ...base, direction: 'short', markPrice: 107.99, peakFavorablePrice: 100 }).exit).toBe(false);
  });
});

describe('evaluateExit: invalidation price', () => {
  it('long exits when mark <= invalidation level', () => {
    const d = evaluateExit({
      ...base,
      plan: { hardStopPct: 50, invalidationPrice: 95 },
      markPrice: 95,
    });
    expect(d.exit).toBe(true);
    expect(d.trigger).toBe('invalidation_price');
  });

  it('long holds a hair above the invalidation level', () => {
    const d = evaluateExit({
      ...base,
      plan: { hardStopPct: 50, invalidationPrice: 95 },
      markPrice: 95.01,
    });
    expect(d.exit).toBe(false);
  });

  it('short exits when mark >= invalidation level', () => {
    const d = evaluateExit({
      ...base,
      direction: 'short',
      plan: { hardStopPct: 50, invalidationPrice: 105 },
      markPrice: 105,
    });
    expect(d.exit).toBe(true);
    expect(d.trigger).toBe('invalidation_price');
  });

  it('hard stop wins when both stop and invalidation are true', () => {
    const d = evaluateExit({
      ...base,
      plan: { hardStopPct: 8, invalidationPrice: 95 },
      markPrice: 92,
    });
    expect(d.trigger).toBe('hard_stop');
  });

  it('short holds a hair below the invalidation level', () => {
    const d = evaluateExit({
      ...base,
      direction: 'short',
      plan: { hardStopPct: 50, invalidationPrice: 105 },
      markPrice: 104.99,
    });
    expect(d.exit).toBe(false);
  });
});

describe('evaluateExit: target', () => {
  it('long take-profit at mark >= target', () => {
    const d = evaluateExit({ ...base, plan: { hardStopPct: 50, target: 110 }, markPrice: 110 });
    expect(d.exit).toBe(true);
    expect(d.trigger).toBe('target');
  });

  it('short take-profit at mark <= target', () => {
    const d = evaluateExit({
      ...base,
      direction: 'short',
      plan: { hardStopPct: 50, target: 90 },
      markPrice: 90,
    });
    expect(d.exit).toBe(true);
    expect(d.trigger).toBe('target');
  });

  it('invalidation outranks target when both are true', () => {
    const d = evaluateExit({
      ...base,
      plan: { hardStopPct: 50, invalidationPrice: 95, target: 94 },
      markPrice: 94,
    });
    expect(d.trigger).toBe('invalidation_price');
  });

  it('target outranks trail when both are true', () => {
    const d = evaluateExit({
      ...base,
      plan: { hardStopPct: 50, target: 103, trail: { activatePct: 5, trailPct: 2 } },
      peakFavorablePrice: 106,
      markPrice: 103.88, // satisfies target (>=103) and would satisfy trail retrace
    });
    expect(d.trigger).toBe('target');
  });
});

describe('evaluateExit: trail', () => {
  const trailPlan = { hardStopPct: 50, trail: { activatePct: 5, trailPct: 2 } };

  it('long: armed by peak gain, exits on retrace from the peak', () => {
    const d = evaluateExit({
      ...base,
      plan: trailPlan,
      peakFavorablePrice: 106, // +6% >= activate 5%
      markPrice: 103.88, // retrace (106-103.88)/106 = 2.0%
    });
    expect(d.exit).toBe(true);
    expect(d.trigger).toBe('trail');
  });

  it('long: armed but not yet retraced enough — holds', () => {
    const d = evaluateExit({
      ...base,
      plan: trailPlan,
      peakFavorablePrice: 106, // +6% >= activate 5%, armed
      markPrice: 105, // retrace (106-105)/106 = 0.94% < trailPct 2%
    });
    expect(d.exit).toBe(false);
  });

  it('long: not armed below the activation gain', () => {
    const d = evaluateExit({
      ...base,
      plan: trailPlan,
      peakFavorablePrice: 104, // +4% < 5%: never armed
      markPrice: 100,
    });
    expect(d.exit).toBe(false);
  });

  it('short: peak is the LOW; exits when mark retraces up from it', () => {
    const d = evaluateExit({
      ...base,
      direction: 'short',
      plan: trailPlan,
      peakFavorablePrice: 94, // 6% favorable move down
      markPrice: 95.88, // (95.88-94)/94 = 2.0% retrace
    });
    expect(d.exit).toBe(true);
    expect(d.trigger).toBe('trail');
  });

  it('short: not armed below the activation gain', () => {
    const d = evaluateExit({
      ...base, direction: 'short', plan: trailPlan,
      peakFavorablePrice: 97, // 3% favorable move < 5% activate
      markPrice: 96,
    });
    expect(d.exit).toBe(false);
  });
});

describe('evaluateExit: time stop', () => {
  it('fires once the holding period reaches the limit', () => {
    const d = evaluateExit({
      ...base,
      plan: { hardStopPct: 50, timeStopHours: 24 },
      nowMs: 24 * 3_600_000,
    });
    expect(d.exit).toBe(true);
    expect(d.trigger).toBe('time_stop');
  });

  it('does not fire one ms before the limit', () => {
    const d = evaluateExit({
      ...base,
      plan: { hardStopPct: 50, timeStopHours: 24 },
      nowMs: 24 * 3_600_000 - 1,
    });
    expect(d.exit).toBe(false);
  });

  it('bare plan (hard stop only) never time-stops', () => {
    expect(evaluateExit({ ...base, nowMs: 10_000 * 3_600_000 }).exit).toBe(false);
  });
});
