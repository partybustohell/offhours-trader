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

  it('chunks the round at verdict_chunk_size candidates per call, self-contained prompts', async () => {
    const chunkCfg = ConfigSchema.parse({ mode: 'paper', universe: { verdict_chunk_size: 2 } });
    const five: CandidateFile = {
      date: '2026-07-28',
      candidates: ['AAA', 'BBB', 'CCC', 'DDD', 'EEE'].map((t) => ({
        ticker: t,
        nominatedBy: [],
        lastPrice: 100,
        avgDollarVolume20d: 60_000_000,
      })),
      rejected: [],
    };
    const calls: { tickers: string[]; maxTokens: number }[] = [];
    const client: LlmClient = {
      messages: {
        create: async (params) => {
          const user = String((params.messages[0] as { content: unknown }).content);
          const m = /Candidate set \(\d+ tickers\): ([A-Z, ]+)/.exec(user);
          const tickers = m ? m[1]!.split(', ') : [];
          calls.push({ tickers, maxTokens: params.max_tokens });
          // Chunk prompts must be self-contained: only the chunk's tickers appear.
          for (const t of five.candidates.map((c) => c.ticker)) {
            if (!tickers.includes(t)) expect(user).not.toContain(`"ticker":"${t}"`);
          }
          return {
            stop_reason: 'tool_use',
            content: [
              {
                type: 'tool_use',
                id: 't1',
                name: 'submit_verdicts',
                input: {
                  verdicts: tickers.map((ticker) => ({
                    ticker,
                    direction: 'none',
                    conviction: 0.5,
                    horizon: 'days',
                    evidence: [],
                    invalidation_conditions: [],
                  })),
                },
              },
            ],
          } as never;
        },
      },
    };
    const out = await runVerdicts(chunkCfg, five, { barsBySymbol: {}, newsBySymbol: {} }, client);
    // 5 candidates / chunk 2 -> 3 chunks per analyst, 5 analysts = 15 calls.
    expect(calls).toHaveLength(15);
    expect(calls.every((c) => c.tickers.length <= 2)).toBe(true);
    // Per-chunk output budget: max(4000, 2*900) = 4000 — far under the cap.
    expect(calls.every((c) => c.maxTokens === 4000)).toBe(true);
    expect(out.droppedAnalysts).toEqual([]);
    expect(out.verdicts).toHaveLength(25); // 5 tickers x 5 analysts
  });

  it('a partially failed analyst keeps successful-chunk verdicts but counts as dropped', async () => {
    const chunkCfg = ConfigSchema.parse({ mode: 'paper', universe: { verdict_chunk_size: 1 } });
    const client: LlmClient = {
      messages: {
        create: async (params) => {
          const user = String((params.messages[0] as { content: unknown }).content);
          if (user.includes('Candidate set (1 tickers): BBB')) {
            throw Object.assign(new Error('boom'), { status: 400 });
          }
          return {
            stop_reason: 'tool_use',
            content: [
              {
                type: 'tool_use',
                id: 't1',
                name: 'submit_verdicts',
                input: {
                  verdicts: [
                    {
                      ticker: 'AAA',
                      direction: 'long',
                      conviction: 0.7,
                      horizon: 'days',
                      evidence: ['beat'],
                      invalidation_conditions: ['closes below 90'],
                    },
                  ],
                },
              },
            ],
          } as never;
        },
      },
    };
    const out = await runVerdicts(chunkCfg, candidates, { barsBySymbol: {}, newsBySymbol: {} }, client);
    // AAA chunk succeeded for every analyst; BBB chunk failed for every analyst.
    expect(out.verdicts).toHaveLength(5);
    expect(out.verdicts.every((v) => v.ticker === 'AAA')).toBe(true);
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
