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

describe('evaluateExit: scale-out at target', () => {
  const plan = { hardStopPct: 8, target: 110, scaleOut: { targetFraction: 0.5 } };

  it('first target hit exits the configured fraction', () => {
    const d = evaluateExit({ ...base, markPrice: 110, peakFavorablePrice: 110, plan });
    expect(d.exit).toBe(true);
    expect(d.trigger).toBe('target');
    expect(d.fraction).toBe(0.5);
    expect(d.reason).toContain('scale-out 50%');
  });

  it('after the scale-out, the target stays silent and lower triggers still run', () => {
    // Target still exceeded but already scaled: no target exit...
    const silent = evaluateExit({
      ...base,
      markPrice: 110,
      peakFavorablePrice: 112,
      plan,
      targetAlreadyScaled: true,
    });
    expect(silent.exit).toBe(false);
    // ...while the trail on the remainder still fires normally.
    const trailing = evaluateExit({
      ...base,
      markPrice: 106,
      peakFavorablePrice: 112,
      plan: { ...plan, trail: { activatePct: 5, trailPct: 4 } },
      targetAlreadyScaled: true,
    });
    expect(trailing.exit).toBe(true);
    expect(trailing.trigger).toBe('trail');
  });

  it('without scaleOut the target remains a full exit with no fraction', () => {
    const d = evaluateExit({
      ...base,
      markPrice: 110,
      peakFavorablePrice: 110,
      plan: { hardStopPct: 8, target: 110 },
    });
    expect(d.exit).toBe(true);
    expect(d.fraction).toBeUndefined();
  });

  it('hard stop outranks the scale-out target and stays a full exit', () => {
    const d = evaluateExit({ ...base, markPrice: 92, plan });
    expect(d.trigger).toBe('hard_stop');
    expect(d.fraction).toBeUndefined();
  });
});

describe('resolveExitPlan: scale-out flag', () => {
  it('attaches scaleOut only when the config flag is on', () => {
    const off = ConfigSchema.parse({});
    expect(resolveExitPlan({ direction: 'long' }, off).scaleOut).toBeUndefined();
    expect(resolveExitPlan(undefined, off).scaleOut).toBeUndefined();
    const on = ConfigSchema.parse({
      exit_engine: { scale_out: { enabled: true, target_fraction: 0.4 } },
    });
    expect(resolveExitPlan({ direction: 'long' }, on).scaleOut).toEqual({ targetFraction: 0.4 });
    expect(resolveExitPlan(undefined, on).scaleOut).toEqual({ targetFraction: 0.4 });
  });
});

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

  it('max_position_loss_pct remains the hard ceiling on any resolved stop', () => {
    const c = ConfigSchema.parse({ exit_engine: { hard_stop_pct: 12 } }); // looser than the 8% legacy cap
    expect(resolveExitPlan(undefined, c).hardStopPct).toBe(8);
    expect(resolveExitPlan({ direction: 'long', exit: { hardStopPct: 20, timeStopHours: 10 } }, c).hardStopPct).toBe(8);
    expect(resolveExitPlan({ direction: 'long', exit: { hardStopPct: 4, timeStopHours: 10 } }, c).hardStopPct).toBe(4);
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

  it('LLM hard stop can tighten but never loosen past max_position_loss_pct', () => {
    expect(mergedExitPlan({ direction: 'long', horizon: 'days' }, { hardStopPct: 20 }, cfg).hardStopPct).toBe(8);
    expect(mergedExitPlan({ direction: 'long', horizon: 'days' }, { hardStopPct: 4 }, cfg).hardStopPct).toBe(4);
  });

  it('composes with sanitizeExitPlan output the way the pipeline does', () => {
    const raw = {
      hard_stop_pct: 30, // valid to sanitize (<=50) but above the 8% cap -> clamped at merge
      invalidation_price: 96,
      target_price: 130,
      trail: { activate_pct: 6, trail_pct: 2 },
      time_stop_hours: 72,
      junk_field: 'ignored',
    };
    const llm = sanitizeExitPlan(raw, 'long', { low: 97, high: 101 });
    const merged = mergedExitPlan({ direction: 'long', horizon: 'days' }, llm, cfg);
    expect(merged).toEqual({
      hardStopPct: 8, // clamped to max_position_loss_pct
      invalidationPrice: 96,
      target: 130,
      trail: { activatePct: 6, trailPct: 2 },
      timeStopHours: 72,
    });
  });
});

describe('resolveExitPlan: config-default trail', () => {
  const trailCfg = ConfigSchema.parse({
    exit_engine: { trail: { activate_pct: 5, trail_pct: 4, breakeven_floor: true } },
  });

  it('orphan gets the config trail (stop + trail, still no time stop)', () => {
    expect(resolveExitPlan(undefined, trailCfg)).toEqual({
      hardStopPct: 8,
      trail: { activatePct: 5, trailPct: 4, floorAtEntry: true },
    });
  });

  it('bare entry gets the config trail plus the horizon time stop', () => {
    expect(resolveExitPlan({ direction: 'long' }, trailCfg)).toEqual({
      hardStopPct: 8,
      trail: { activatePct: 5, trailPct: 4, floorAtEntry: true },
      timeStopHours: 30,
    });
  });

  it('entry-carried trail beats the config default', () => {
    const plan = resolveExitPlan(
      { direction: 'long', exit: { hardStopPct: 8, trail: { activatePct: 6, trailPct: 2 } } },
      trailCfg,
    );
    expect(plan.trail).toEqual({ activatePct: 6, trailPct: 2 });
  });

  it('breakeven_floor defaults to true and false maps through', () => {
    const c = ConfigSchema.parse({
      exit_engine: { trail: { activate_pct: 5, trail_pct: 4, breakeven_floor: false } },
    });
    expect(resolveExitPlan(undefined, c).trail).toEqual({
      activatePct: 5,
      trailPct: 4,
      floorAtEntry: false,
    });
    const d = ConfigSchema.parse({ exit_engine: { trail: { activate_pct: 5, trail_pct: 4 } } });
    expect(resolveExitPlan(undefined, d).trail).toEqual({
      activatePct: 5,
      trailPct: 4,
      floorAtEntry: true,
    });
  });

  it('absent config trail leaves plans trail-free (legacy no-regression)', () => {
    expect(resolveExitPlan(undefined, cfg).trail).toBeUndefined();
  });
});

describe('evaluateExit: trail breakeven floor', () => {
  // trailPct wider than the activation gain: the plain peak-retrace test alone
  // would let an armed winner round-trip back through entry (retrace 5.3% < 8%).
  const floorPlan = {
    hardStopPct: 50,
    trail: { activatePct: 5, trailPct: 8, floorAtEntry: true },
  };

  it('long: armed, mark back at entry exits on the floor before the retrace test', () => {
    const d = evaluateExit({
      ...base,
      plan: floorPlan,
      peakFavorablePrice: 105.5, // +5.5% >= 5: armed
      markPrice: 100, // retrace 5.21% < trailPct 8 — only the floor catches this
    });
    expect(d.exit).toBe(true);
    expect(d.trigger).toBe('trail');
    expect(d.reason).toContain('breakeven');
  });

  it('long: without floorAtEntry the same retrace holds (legacy semantics)', () => {
    const d = evaluateExit({
      ...base,
      plan: { hardStopPct: 50, trail: { activatePct: 5, trailPct: 8 } },
      peakFavorablePrice: 105.5,
      markPrice: 100,
    });
    expect(d.exit).toBe(false);
  });

  it('long: floor stays dark until armed', () => {
    const d = evaluateExit({
      ...base,
      plan: floorPlan,
      peakFavorablePrice: 104.9, // +4.9% < 5: not armed
      markPrice: 99.9,
    });
    expect(d.exit).toBe(false);
  });

  it('long: armed and above entry with shallow retrace still holds', () => {
    const d = evaluateExit({
      ...base,
      plan: floorPlan,
      peakFavorablePrice: 106,
      markPrice: 102, // retrace 3.77% < 8, mark > entry
    });
    expect(d.exit).toBe(false);
  });

  it('short: armed, mark back at entry exits on the floor', () => {
    const d = evaluateExit({
      ...base,
      direction: 'short',
      plan: floorPlan,
      peakFavorablePrice: 94.5, // favorable low: +5.5% gain, armed
      markPrice: 100.05, // retrace 5.87% < 8 — only the floor catches this
    });
    expect(d.exit).toBe(true);
    expect(d.trigger).toBe('trail');
    expect(d.reason).toContain('breakeven');
  });
});

describe('evaluateExit: two-tier breakeven arming (breakevenAtPct)', () => {
  // Policy v2: breakeven floor arms at +1% peak gain; the HWM trail still
  // arms at +5%. Between the tiers only the breakeven floor is live.
  const tierPlan = {
    hardStopPct: 8,
    trail: { activatePct: 5, trailPct: 4, floorAtEntry: true, breakevenAtPct: 1 },
  };

  it('long: peaked +1.5%, mark back at entry exits on the breakeven floor', () => {
    const d = evaluateExit({
      ...base,
      plan: tierPlan,
      peakFavorablePrice: 101.5,
      markPrice: 100,
    });
    expect(d.exit).toBe(true);
    expect(d.trigger).toBe('trail');
    expect(d.reason).toContain('breakeven');
  });

  it('long: peaked only +0.9%, mark at entry holds (not armed)', () => {
    const d = evaluateExit({
      ...base,
      plan: tierPlan,
      peakFavorablePrice: 100.9,
      markPrice: 100,
    });
    expect(d.exit).toBe(false);
  });

  it('long: peaked +1.5% and above entry holds — no HWM trail below the +5% tier', () => {
    // retrace from 101.5 to 100.01 is 1.47%... would not trip trailPct anyway;
    // use a big retrace that WOULD trip trailPct to prove the trail is dark:
    const d = evaluateExit({
      ...base,
      plan: { hardStopPct: 50, trail: { activatePct: 5, trailPct: 1, breakevenAtPct: 1 } },
      peakFavorablePrice: 103, // +3%: breakeven armed, trail NOT armed
      markPrice: 100.5, // retrace 2.4% >= trailPct 1 — but trail tier not armed
    });
    expect(d.exit).toBe(false);
  });

  it('short: trough at -1.5%, mark back at entry exits on the breakeven floor', () => {
    const d = evaluateExit({
      ...base,
      direction: 'short',
      plan: tierPlan,
      peakFavorablePrice: 98.5,
      markPrice: 100,
    });
    expect(d.exit).toBe(true);
    expect(d.trigger).toBe('trail');
    expect(d.reason).toContain('breakeven');
  });

  it('resolveExitPlan maps config breakeven_at_pct through to the plan', () => {
    const c = ConfigSchema.parse({
      exit_engine: {
        trail: { activate_pct: 5, trail_pct: 4, breakeven_at_pct: 1 },
      },
    });
    expect(resolveExitPlan(undefined, c).trail).toEqual({
      activatePct: 5,
      trailPct: 4,
      floorAtEntry: true,
      breakevenAtPct: 1,
    });
  });
});
