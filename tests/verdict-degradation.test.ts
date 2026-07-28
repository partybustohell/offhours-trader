import { describe, expect, it } from 'vitest';
import { callStructured, type LlmClient } from '../src/agents/llm.js';
import { runVerdicts } from '../src/agents/verdicts.js';
import { ConfigSchema } from '../src/config.js';
import type { CandidateFile } from '../src/types.js';

const cfg = ConfigSchema.parse({ mode: 'paper' });

function clientReturning(input: unknown, stopReason = 'tool_use'): LlmClient {
  return {
    messages: {
      create: async () =>
        ({
          stop_reason: stopReason,
          content: [{ type: 'tool_use', id: 't1', name: 'x', input }],
        }) as never,
    },
  };
}

describe('callStructured truncation guard', () => {
  it('throws on stop_reason max_tokens instead of returning a silent partial', async () => {
    await expect(
      callStructured(
        { model: 'm', system: 's', user: 'u', toolName: 'x', toolSchema: {} },
        clientReturning({}, 'max_tokens'),
      ),
    ).rejects.toThrow(/truncated at max_tokens/);
  });
});

describe('runVerdicts degradation accounting', () => {
  const candidates: CandidateFile = {
    date: '2026-07-27',
    candidates: [
      { ticker: 'AAA', nominatedBy: [], lastPrice: 100, avgDollarVolume20d: 60_000_000 },
      { ticker: 'BBB', nominatedBy: [], lastPrice: 50, avgDollarVolume20d: 60_000_000 },
    ],
    rejected: [],
  };

  it('an analyst returning zero verdicts for a non-empty set counts as DROPPED', async () => {
    // Every analyst returns an empty verdicts array (the truncation-shaped
    // failure observed live 2026-07-27 21:05): all five must land in
    // droppedAnalysts so quorum math and the degraded-refresh carryover see it.
    const out = await runVerdicts(
      cfg,
      candidates,
      { barsBySymbol: {}, newsBySymbol: {} },
      clientReturning({ verdicts: [] }),
    );
    expect(out.verdicts).toEqual([]);
    expect(out.droppedAnalysts).toHaveLength(5);
  });

  it('valid verdicts still flow through', async () => {
    const out = await runVerdicts(
      cfg,
      candidates,
      { barsBySymbol: {}, newsBySymbol: {} },
      clientReturning({
        verdicts: [
          {
            ticker: 'AAA',
            direction: 'long',
            conviction: 0.7,
            horizon: 'days',
            evidence: ['beat'],
            invalidation_conditions: ['closes below 90'],
          },
          {
            ticker: 'BBB',
            direction: 'none',
            conviction: 0.6,
            horizon: 'days',
            evidence: [],
            invalidation_conditions: [],
          },
        ],
      }),
    );
    expect(out.droppedAnalysts).toEqual([]);
    expect(out.verdicts).toHaveLength(10); // 2 tickers x 5 analysts
  });
});
