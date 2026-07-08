import { describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { ConfigSchema } from '../src/config.js';
import { ANALYST_SYSTEM, VERDICT_INSTRUCTIONS } from '../src/agents/prompts.js';
import type { LlmClient } from '../src/agents/llm.js';
import {
  arm1,
  arm2,
  cutoffIntrudes,
  cutoffNote,
  maskNumerics,
  maskVerdictUser,
  pairTrips,
  POSITIVE_CONTROLS,
  runProbeArm,
  wilson95,
  type ClassifierResult,
  type ProbeDeps,
  type ProbePair,
} from '../src/backtest/probe.js';

// All LLM traffic goes through an injected fake client; nothing touches the
// network. The fake serves verdict calls (submit_verdicts) with a canned
// verdict whose conviction depends on whether the input was masked, and
// classifier calls with a canned per-ticker ClassifierResult.

const cfg = ConfigSchema.parse({});

interface Recorded {
  toolName: string;
  system: unknown;
  model: string;
  user: string;
}

function fakeClient(
  classify: (ticker: string) => ClassifierResult,
  recorded: Recorded[] = [],
): LlmClient {
  return {
    messages: {
      create: async (params) => {
        const tool = params.tools?.[0] as { name: string } | undefined;
        const toolName = tool?.name ?? '';
        const user =
          typeof params.messages[0]?.content === 'string' ? params.messages[0].content : '';
        recorded.push({ toolName, system: params.system, model: params.model, user });

        let input: unknown;
        if (toolName === 'submit_verdicts') {
          const ticker = /tickers\): ([A-Z][A-Z0-9.]*)/.exec(user)?.[1] ?? 'UNK';
          const masked = user.includes('X.XX');
          input = {
            verdicts: [
              {
                ticker,
                direction: 'long',
                conviction: masked ? 0.4 : 0.8,
                horizon: 'days',
                evidence: [masked ? 'masked-run evidence' : 'unmasked-run evidence'],
                invalidation_conditions: ['level breaks'],
              },
            ],
          };
        } else {
          const ticker = /^Ticker: ([A-Z][A-Z0-9.]*)/.exec(user)?.[1] ?? 'UNK';
          input = classify(ticker);
        }
        return {
          content: [{ type: 'tool_use', id: 'probe-test', name: toolName, input }],
        } as unknown as Anthropic.Messages.Message;
      },
    },
  };
}

const aaplPair: ProbePair = {
  day: '2026-03-04',
  ticker: 'AAPL',
  data: {
    lastPrice: 232.5,
    avgDollarVolume20d: 9_500_000_000,
    nominatedBy: [{ analyst: 'sentiment', reason: 'product event coverage' }],
    bars: [
      { t: '2026-03-03T05:00:00Z', o: 230.1, h: 233.4, l: 229.2, c: 231.9, v: 48_000_000 },
      { t: '2026-03-04T05:00:00Z', o: 231.5, h: 233.9, l: 230.8, c: 232.5, v: 51_000_000 },
    ],
    news: [
      {
        headline: 'Apple unveils new product line at spring event',
        summary: 'Pricing starts higher than the prior generation.',
        symbols: ['AAPL'],
        created_at: '2026-03-04T14:00:00Z',
        source: 'wire',
      },
    ],
  },
};

const msftPair: ProbePair = {
  day: '2026-02-10',
  ticker: 'MSFT',
  data: {
    lastPrice: 512.25,
    avgDollarVolume20d: 8_000_000_000,
    bars: [{ t: '2026-02-10T05:00:00Z', o: 508.0, h: 514.2, l: 506.5, c: 512.25, v: 22_000_000 }],
    news: [],
  },
};

const noTrip: ClassifierResult = { references_unstated_outcomes: false, conviction_divergence: 0 };
const trip: ClassifierResult = { references_unstated_outcomes: true, conviction_divergence: 0 };

describe('maskNumerics', () => {
  it('masks prices, percents, and volumes; preserves tickers and dates', () => {
    const input =
      'NVDA closed at 949.50, up 9.3% on volume 52,300,000 on 2024-05-22 (created_at 2024-05-22T20:05:00Z)';
    expect(maskNumerics(input)).toBe(
      'NVDA closed at X.XX, up X.XX% on volume X.XX on 2024-05-22 (created_at 2024-05-22T20:05:00Z)',
    );
  });

  it('preserves identifier-embedded digits (JSON keys) while masking values', () => {
    expect(maskNumerics('"pctChange1d":2.5,"avgDollarVolume20d":9500000000')).toBe(
      '"pctChange1d":X.XX,"avgDollarVolume20d":X.XX',
    );
  });

  it('masks negative and decimal JSON values', () => {
    expect(maskNumerics('"pctChange5d":-4.25,"lastClose":100')).toBe(
      '"pctChange5d":X.XX,"lastClose":X.XX',
    );
  });

  it('preserves ISO timestamps with offsets', () => {
    expect(maskNumerics('at 2026-03-04T14:00:00-05:00 price 12')).toBe(
      'at 2026-03-04T14:00:00-05:00 price X.XX',
    );
  });

  it('leaves numeric-free text unchanged', () => {
    expect(maskNumerics('AAPL guidance walked back')).toBe('AAPL guidance walked back');
  });
});

describe('maskVerdictUser', () => {
  it('keeps the production instructions intact and masks only the data section', () => {
    const user = [VERDICT_INSTRUCTIONS, 'Candidate set (1 tickers): AAPL', '{"lastPrice":232.5}'].join(
      '\n\n',
    );
    const masked = maskVerdictUser(user);
    expect(masked.startsWith(VERDICT_INSTRUCTIONS)).toBe(true);
    expect(masked).toContain('conviction: 0 to 1'); // instruction numerals untouched
    expect(masked).toContain('Candidate set (X.XX tickers): AAPL');
    expect(masked).toContain('{"lastPrice":X.XX}');
    expect(masked).not.toContain('232.5');
  });
});

describe('pairTrips decision table', () => {
  it.each<[boolean, number, boolean]>([
    [false, 0, false],
    [true, 0, true],
    [false, 0.31, true],
    [false, 0.3, false], // strictly greater than 0.3
    [true, 0.9, true],
    [false, 1, true],
  ])('references=%s divergence=%s -> %s', (references, divergence, expected) => {
    expect(
      pairTrips({ references_unstated_outcomes: references, conviction_divergence: divergence }),
    ).toBe(expected);
  });
});

describe('wilson95 binomial CI', () => {
  it('matches the published Wilson interval for 8/10', () => {
    const [lo, hi] = wilson95(8, 10);
    expect(lo).toBeCloseTo(0.4902, 3);
    expect(hi).toBeCloseTo(0.9433, 3);
  });

  it('clamps at 0 for 0/10 and gives the known upper bound', () => {
    const [lo, hi] = wilson95(0, 10);
    expect(lo).toBe(0);
    expect(hi).toBeCloseTo(0.2775, 3);
  });

  it('clamps at 1 for 10/10 (mirror of 0/10)', () => {
    const [lo, hi] = wilson95(10, 10);
    expect(lo).toBeCloseTo(1 - 0.2775, 3);
    expect(hi).toBe(1);
  });

  it('returns the vacuous interval for n=0', () => {
    expect(wilson95(0, 0)).toEqual([0, 1]);
  });
});

describe('arm runs against an injected fake client (no network)', () => {
  it('arm2: clean classifier output -> no trip, correct shape', async () => {
    const deps: ProbeDeps = { cfg, client: fakeClient(() => noTrip) };
    const result = await arm2([msftPair], deps);
    expect(result.arm).toBe('arm2');
    expect(result.n).toBe(1);
    expect(result.tripped).toBe(0);
    expect(result.rate).toBe(0);
    expect(result.binomial95).toEqual(wilson95(0, 1));
    expect(result.powerless).toBe(false); // power inherited from arm1's controls
    expect(result.errors).toBe(0);
    expect(result.controls).toEqual([]);
    expect(result.pairs[0]).toMatchObject({ ticker: 'MSFT', control: false, tripped: false });
  });

  it('arm1: mixed candidate trips with all controls tripping', async () => {
    const controlTickers = new Set(POSITIVE_CONTROLS.map((c) => c.ticker));
    const deps: ProbeDeps = {
      cfg,
      client: fakeClient((ticker) => (controlTickers.has(ticker) || ticker === 'AAPL' ? trip : noTrip)),
    };
    const result = await arm1([aaplPair, msftPair], POSITIVE_CONTROLS, deps);
    expect(result.arm).toBe('arm1');
    expect(result.n).toBe(2);
    expect(result.tripped).toBe(1);
    expect(result.rate).toBe(0.5);
    expect(result.binomial95).toEqual(wilson95(1, 2));
    expect(result.powerless).toBe(false);
    expect(result.controls).toHaveLength(3);
    expect(result.controls.every((c) => c.tripped && c.control)).toBe(true);
    expect(result.pairs.map((p) => [p.ticker, p.tripped])).toEqual([
      ['AAPL', true],
      ['MSFT', false],
    ]);
  });

  it('powerless flag: any control failing to trip sets powerless=true', async () => {
    const deps: ProbeDeps = {
      cfg,
      // SPY control comes back clean; NVDA/TSLA trip.
      client: fakeClient((ticker) => (ticker === 'SPY' ? noTrip : trip)),
    };
    const result = await arm1([aaplPair], POSITIVE_CONTROLS, deps);
    expect(result.powerless).toBe(true);
    expect(result.controls.filter((c) => !c.tripped).map((c) => c.ticker)).toEqual(['SPY']);
    // candidate pairs are still measured; power is reported separately
    expect(result.n).toBe(1);
    expect(result.tripped).toBe(1);
  });

  it('a divergence-only trip crosses the 0.3 threshold', async () => {
    const deps: ProbeDeps = {
      cfg,
      client: fakeClient(() => ({ references_unstated_outcomes: false, conviction_divergence: 0.4 })),
    };
    const result = await arm2([msftPair], deps);
    expect(result.tripped).toBe(1);
    expect(result.pairs[0]!.classifier.conviction_divergence).toBe(0.4);
  });

  it('garbage classifier output is sanitized to a non-trip', async () => {
    const deps: ProbeDeps = {
      cfg,
      client: fakeClient(
        () =>
          ({
            references_unstated_outcomes: 'yes',
            conviction_divergence: 'enormous',
          }) as unknown as ClassifierResult,
      ),
    };
    const result = await arm2([msftPair], deps);
    expect(result.tripped).toBe(0);
    expect(result.pairs[0]!.classifier).toEqual({
      references_unstated_outcomes: false,
      conviction_divergence: 0,
    });
  });

  it('runs the REAL captured verdict prompt twice (masked + unmasked) plus one classifier call', async () => {
    const recorded: Recorded[] = [];
    const deps: ProbeDeps = { cfg, client: fakeClient(() => noTrip, recorded) };
    await arm2([aaplPair], deps);

    // exactly 3 calls on the injected client: 2 verdicts + 1 classifier
    expect(recorded).toHaveLength(3);
    const verdictCalls = recorded.filter((r) => r.toolName === 'submit_verdicts');
    const classifierCalls = recorded.filter((r) => r.toolName === 'submit_probe_classification');
    expect(verdictCalls).toHaveLength(2);
    expect(classifierCalls).toHaveLength(1);

    // both verdict calls carry the production analyst system + model
    for (const call of verdictCalls) {
      expect(call.system).toBe(ANALYST_SYSTEM.sentiment); // default probe analyst
      expect(call.model).toBe(cfg.model.analysts);
      expect(call.user.startsWith(VERDICT_INSTRUCTIONS)).toBe(true);
      expect(call.user).toContain('tickers): AAPL'); // single-candidate set
    }

    const unmasked = verdictCalls.find((c) => c.user.includes('"lastPrice":232.5'));
    const masked = verdictCalls.find((c) => c.user.includes('"lastPrice":X.XX'));
    expect(unmasked).toBeDefined();
    expect(masked).toBeDefined();
    expect(masked!.user).not.toContain('232.5');
    // ticker and news timestamp survive masking
    expect(masked!.user).toContain('AAPL');
    expect(masked!.user).toContain('2026-03-04T14:00:00Z');

    // the classifier saw both verdict outputs (conviction 0.4 masked, 0.8 unmasked)
    const cls = classifierCalls[0]!;
    expect(cls.user).toContain('Ticker: AAPL');
    expect(cls.user).toContain('"conviction":0.4');
    expect(cls.user).toContain('"conviction":0.8');
  });

  it('a failing pair is excluded from n and counted as an error; a failing control means powerless', async () => {
    const failFor = (ticker: string): LlmClient => ({
      messages: {
        create: async (params) => {
          const user =
            typeof params.messages[0]?.content === 'string' ? params.messages[0].content : '';
          if (user.includes(ticker)) throw new Error('simulated hard failure');
          const tool = params.tools?.[0] as { name: string } | undefined;
          const input =
            tool?.name === 'submit_verdicts'
              ? {
                  verdicts: [
                    {
                      ticker: /tickers\): ([A-Z][A-Z0-9.]*)/.exec(user)?.[1] ?? 'UNK',
                      direction: 'none',
                      conviction: 0.5,
                      horizon: 'days',
                      evidence: [],
                      invalidation_conditions: [],
                    },
                  ],
                }
              : trip;
          return {
            content: [{ type: 'tool_use', id: 't', name: tool?.name ?? '', input }],
          } as unknown as Anthropic.Messages.Message;
        },
      },
    });

    // candidate pair fails -> excluded from n, errors counted
    const r1 = await runProbeArm('arm1', [aaplPair, msftPair], [], {
      cfg,
      client: failFor('MSFT'),
    });
    expect(r1.n).toBe(1);
    expect(r1.errors).toBe(1);
    expect(r1.pairs.find((p) => p.ticker === 'MSFT')!.error).toContain('simulated hard failure');
    expect(r1.powerless).toBe(false); // no controls provided in this arm run

    // control pair fails -> power not demonstrated
    const r2 = await runProbeArm('arm1', [], POSITIVE_CONTROLS, { cfg, client: failFor('NVDA') });
    expect(r2.powerless).toBe(true);
    expect(r2.errors).toBe(1);
  });
});

describe('POSITIVE_CONTROLS fixture', () => {
  it('is exactly the three famous pre-cutoff event days with usable data', () => {
    expect(POSITIVE_CONTROLS.map((c) => c.ticker)).toEqual(['NVDA', 'SPY', 'TSLA']);
    for (const c of POSITIVE_CONTROLS) {
      expect(c.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(c.day < '2025-01-01').toBe(true); // pre-cutoff for every model in use
      expect(c.data.bars.length).toBeGreaterThan(0);
      expect(c.data.news.length).toBeGreaterThan(0);
      expect(c.data.lastPrice).toBeGreaterThan(0);
      expect(c.data.avgDollarVolume20d).toBeGreaterThan(0);
    }
  });
});

describe('cutoff verification note', () => {
  it('cutoffIntrudes: any in-window day on/before the cutoff', () => {
    expect(cutoffIntrudes('2026-01-31', '2026-01-01')).toBe(true);
    expect(cutoffIntrudes('2026-01-01', '2026-01-01')).toBe(true); // on the boundary
    expect(cutoffIntrudes('2025-12-31', '2026-01-01')).toBe(false);
  });

  it('lists deduplicated models and never guesses unverified cutoffs', () => {
    const note = cutoffNote(cfg); // analysts and executor share a model id
    expect(note.models).toEqual([cfg.model.analysts, cfg.model.synthesizer]);
    expect(note.cutoffs).toEqual([
      { model: cfg.model.analysts, cutoff: null, intrudes: null },
      { model: cfg.model.synthesizer, cutoff: null, intrudes: null },
    ]);

    const verified = cutoffNote(cfg, {
      [cfg.model.analysts]: '2025-11-30',
      [cfg.model.synthesizer]: '2026-02-01',
    });
    expect(verified.cutoffs).toEqual([
      { model: cfg.model.analysts, cutoff: '2025-11-30', intrudes: false },
      { model: cfg.model.synthesizer, cutoff: '2026-02-01', intrudes: true },
    ]);
  });
});
