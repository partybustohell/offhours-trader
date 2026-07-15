import { describe, expect, it } from 'vitest';
import {
  evaluateExit,
  mergedExitPlan,
  resolveExitPlan,
  sanitizeExitPlan,
  type ExitContext,
} from '../src/exits.js';
import { ConfigSchema } from '../src/config.js';

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

const cfg = ConfigSchema.parse({});

describe('resolveExitPlan', () => {
  it('orphan (no entry): stop-only at the config hard stop, no time stop', () => {
    expect(resolveExitPlan(undefined, cfg)).toEqual({ hardStopPct: 8 });
  });

  it('bare long entry: hard stop + days-horizon time stop (strict superset of today)', () => {
    expect(resolveExitPlan({ direction: 'long' }, cfg)).toEqual({
      hardStopPct: 8,
      timeStopHours: 30,
    });
  });

  it('weeks horizon uses the weeks fallback', () => {
    expect(resolveExitPlan({ direction: 'long', horizon: 'weeks' }, cfg).timeStopHours).toBe(120);
  });

  it('short_hard_stop_pct tightens shorts only', () => {
    const c = ConfigSchema.parse({ exit_engine: { short_hard_stop_pct: 5 } });
    expect(resolveExitPlan({ direction: 'short' }, c).hardStopPct).toBe(5);
    expect(resolveExitPlan({ direction: 'long' }, c).hardStopPct).toBe(8);
  });

  it('entry-carried exit fields override the fallbacks', () => {
    const plan = resolveExitPlan(
      { direction: 'long', exit: { hardStopPct: 4, target: 120, timeStopHours: 10 } },
      cfg,
    );
    expect(plan).toEqual({ hardStopPct: 4, target: 120, timeStopHours: 10 });
  });
});

describe('sanitizeExitPlan (LLM output validation)', () => {
  const band = { low: 97, high: 101 }; // long entry band around ~100

  it('maps snake_case fields and keeps well-formed values', () => {
    expect(
      sanitizeExitPlan(
        {
          hard_stop_pct: 6,
          invalidation_price: 95,
          target_price: 112,
          trail: { activate_pct: 5, trail_pct: 2 },
          time_stop_hours: 48,
        },
        'long',
        band,
      ),
    ).toEqual({
      hardStopPct: 6,
      invalidationPrice: 95,
      target: 112,
      trail: { activatePct: 5, trailPct: 2 },
      timeStopHours: 48,
    });
  });

  it('drops a long invalidation level that is not below the band', () => {
    expect(sanitizeExitPlan({ invalidation_price: 99 }, 'long', band)).toEqual({});
  });

  it('drops a long target that is not above the band', () => {
    expect(sanitizeExitPlan({ target_price: 100 }, 'long', band)).toEqual({});
  });

  it('short: invalidation must sit above the band, target below', () => {
    expect(
      sanitizeExitPlan({ invalidation_price: 105, target_price: 90 }, 'short', band),
    ).toEqual({ invalidationPrice: 105, target: 90 });
    expect(sanitizeExitPlan({ invalidation_price: 90, target_price: 105 }, 'short', band)).toEqual(
      {},
    );
  });

  it('drops non-finite, non-positive, and absurd values', () => {
    expect(
      sanitizeExitPlan(
        { hard_stop_pct: 80, invalidation_price: -5, target_price: NaN, time_stop_hours: 100000 },
        'long',
        band,
      ),
    ).toEqual({});
  });

  it('drops a trail missing either field', () => {
    expect(sanitizeExitPlan({ trail: { activate_pct: 5 } }, 'long', band)).toEqual({});
  });

  it('non-object input yields an empty plan', () => {
    expect(sanitizeExitPlan(null, 'long', band)).toEqual({});
    expect(sanitizeExitPlan('x', 'long', band)).toEqual({});
  });
});

describe('mergedExitPlan', () => {
  it('overlays sanitized LLM fields onto the deterministic fallback', () => {
    const merged = mergedExitPlan(
      { direction: 'long', horizon: 'days' },
      { invalidationPrice: 95 },
      cfg,
    );
    expect(merged).toEqual({ hardStopPct: 8, timeStopHours: 30, invalidationPrice: 95 });
  });
});
