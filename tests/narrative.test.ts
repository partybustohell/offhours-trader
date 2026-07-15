import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { callStructured } from '../src/agents/llm.js';
import { writeNarratives, type ComputedEntry } from '../src/agents/narrative.js';
import { ConfigSchema } from '../src/config.js';
import type { Verdict } from '../src/types.js';

vi.mock('../src/agents/llm.js', () => ({ callStructured: vi.fn() }));
const mock = callStructured as unknown as Mock;

const cfg = ConfigSchema.parse({});
const entry: ComputedEntry = {
  ticker: 'GS',
  direction: 'long',
  weightedConviction: 0.7,
  limitBand: { low: 97, high: 101 },
  targetNotionalUsd: 1000,
  invalidationConditions: ['computed condition'],
  horizon: 'days',
};
const verdicts: Verdict[] = [
  {
    analyst: 'fundamental',
    ticker: 'GS',
    direction: 'long',
    conviction: 0.8,
    horizon: 'days',
    evidence: ['beat'],
    invalidation_conditions: ['guidance walk-back'],
  },
];

beforeEach(() => mock.mockReset());

describe('writeNarratives exit emission', () => {
  it('passes through a sanitized structured exit block', async () => {
    mock.mockResolvedValueOnce({
      narratives: [
        {
          ticker: 'GS',
          narrative: 'A cohesive narrative.',
          invalidation_conditions: ['guidance walk-back'],
          exit: { invalidation_price: 95, target_price: 112, time_stop_hours: 48 },
        },
      ],
    });
    const out = await writeNarratives(cfg, [entry], verdicts);
    expect(out.get('GS')?.exit).toEqual({ invalidationPrice: 95, target: 112, timeStopHours: 48 });
  });

  it('drops wrong-side levels but keeps the narrative', async () => {
    mock.mockResolvedValueOnce({
      narratives: [
        {
          ticker: 'GS',
          narrative: 'A cohesive narrative.',
          invalidation_conditions: [],
          exit: { invalidation_price: 150, target_price: 90 }, // both wrong side for a long
        },
      ],
    });
    const out = await writeNarratives(cfg, [entry], verdicts);
    expect(out.get('GS')?.narrative).toBe('A cohesive narrative.');
    expect(out.get('GS')?.exit).toBeUndefined();
  });

  it('LLM failure falls back with no exit block', async () => {
    mock.mockRejectedValueOnce(new Error('api down'));
    const out = await writeNarratives(cfg, [entry], verdicts);
    expect(out.get('GS')?.exit).toBeUndefined();
    expect(out.get('GS')?.narrative).toContain('beat');
  });
});
