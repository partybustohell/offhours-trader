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
});
