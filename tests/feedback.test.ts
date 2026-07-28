import { describe, expect, it } from 'vitest';
import {
  analystStats,
  attributeExitTriggers,
  fitCalibration,
  nearestDecision,
  pairRoundTrips,
  postExitFollowthrough,
  proposeWeights,
  scoreJudgeVeto,
  shortfallBps,
  type DecisionRecord,
  type ExitEvent,
  type RoundTrip,
} from '../src/feedback.js';
import type { FillActivity } from '../src/broker/client.js';
import type { Verdict } from '../src/types.js';

let seq = 0;
function fill(
  ticker: string,
  side: FillActivity['side'],
  qty: number,
  price: number,
  at: string,
): FillActivity {
  return { id: `f${++seq}`, transactionTime: at, ticker, side, qty, price };
}

describe('pairRoundTrips', () => {
  it('pairs a simple long round trip', () => {
    const trips = pairRoundTrips([
      fill('GS', 'buy', 10, 100, '2026-07-01T14:00:00Z'),
      fill('GS', 'sell', 10, 110, '2026-07-02T15:00:00Z'),
    ]);
    expect(trips).toHaveLength(1);
    expect(trips[0]).toMatchObject({
      ticker: 'GS',
      direction: 'long',
      qty: 10,
      entryAvgPrice: 100,
      exitAvgPrice: 110,
      returnPct: 10,
      realizedPnlUsd: 100,
    });
  });

  it('pairs a short round trip (sell_short then cover)', () => {
    const trips = pairRoundTrips([
      fill('FSLR', 'sell_short', 5, 50, '2026-07-01T14:00:00Z'),
      fill('FSLR', 'buy', 5, 45, '2026-07-01T18:00:00Z'),
    ]);
    expect(trips).toHaveLength(1);
    expect(trips[0]).toMatchObject({ direction: 'short', returnPct: 10, realizedPnlUsd: 25 });
  });

  it('averages partial exits into one trip', () => {
    const trips = pairRoundTrips([
      fill('NVDA', 'buy', 10, 100, '2026-07-01T14:00:00Z'),
      fill('NVDA', 'sell', 4, 110, '2026-07-01T15:00:00Z'),
      fill('NVDA', 'sell', 6, 105, '2026-07-01T16:00:00Z'),
    ]);
    expect(trips).toHaveLength(1);
    expect(trips[0]).toMatchObject({ qty: 10, exitAvgPrice: 107, returnPct: 7, realizedPnlUsd: 70 });
  });

  it('a flip closes the old trip and opens a new one at the flip price', () => {
    const trips = pairRoundTrips([
      fill('X', 'buy', 10, 100, '2026-07-01T14:00:00Z'),
      fill('X', 'sell', 15, 110, '2026-07-01T15:00:00Z'), // closes 10 long, opens 5 short
      fill('X', 'buy', 5, 99, '2026-07-01T16:00:00Z'),
    ]);
    expect(trips).toHaveLength(2);
    expect(trips[0]).toMatchObject({ direction: 'long', qty: 10, returnPct: 10 });
    expect(trips[1]).toMatchObject({ direction: 'short', qty: 5, entryAvgPrice: 110, exitAvgPrice: 99 });
  });

  it('drops still-open positions and garbage fills', () => {
    expect(
      pairRoundTrips([
        fill('OPEN', 'buy', 10, 100, '2026-07-01T14:00:00Z'),
        fill('BAD', 'buy', 0, 100, '2026-07-01T14:00:00Z'),
        fill('BAD2', 'buy', 5, 0, '2026-07-01T14:00:00Z'),
      ]),
    ).toEqual([]);
  });
});

describe('fitCalibration (pool-adjacent-violators)', () => {
  it('pools violations into a monotone table', () => {
    const table = fitCalibration([
      { score: 0.5, win: false },
      { score: 0.55, win: true },
      { score: 0.6, win: false }, // violates: pooled with 0.55
      { score: 0.65, win: true },
      { score: 0.7, win: true },
    ]);
    for (let i = 1; i < table.length; i++) {
      expect(table[i]!.prob).toBeGreaterThanOrEqual(table[i - 1]!.prob);
      expect(table[i]!.score).toBeGreaterThan(table[i - 1]!.score);
    }
    expect(table[0]).toEqual({ score: 0.5, prob: 0 });
    expect(table[1]).toEqual({ score: 0.575, prob: 0.5 });
  });

  it('empty in, empty out', () => {
    expect(fitCalibration([])).toEqual([]);
  });
});

describe('attributeExitTriggers + postExitFollowthrough + scoreJudgeVeto', () => {
  const trip: RoundTrip = {
    ticker: 'GS',
    direction: 'long',
    qty: 10,
    entryAvgPrice: 100,
    exitAvgPrice: 105,
    openedAt: '2026-07-20T14:00:00Z',
    closedAt: '2026-07-21T15:00:00Z',
    returnPct: 5,
    realizedPnlUsd: 50,
  };

  it('attributes the nearest same-ticker exit event before the fill', () => {
    const events: ExitEvent[] = [
      { tsMs: Date.parse('2026-07-21T14:59:30Z'), ticker: 'GS', trigger: 'trail' },
      { tsMs: Date.parse('2026-07-20T14:30:00Z'), ticker: 'GS', trigger: 'judge' }, // day before — outside window
      { tsMs: Date.parse('2026-07-21T14:59:45Z'), ticker: 'XOM', trigger: 'hard_stop' }, // other ticker
    ];
    expect(attributeExitTriggers([trip], events)).toEqual(['trail']);
  });

  it("attributes 'native_stop_fill' when no executor exit event matches (broker-side GTC stop)", () => {
    expect(attributeExitTriggers([trip], [])).toEqual(['native_stop_fill']);
  });

  it('signs follow-through so positive = money left on the table', () => {
    // Long exited at 105; price kept rising to 110 (d1) and 112 (d3): positive.
    expect(postExitFollowthrough(trip, [110, 111, 112])).toEqual({
      d1: 4.7619,
      d3: 6.6667,
    });
    // Short exited at 105; price rising is the exit DODGING loss: negative.
    expect(postExitFollowthrough({ direction: 'short', exitAvgPrice: 105 }, [110])).toEqual({
      d1: -4.7619,
    });
    expect(postExitFollowthrough(trip, [])).toEqual({});
  });

  it('scores a judge veto from the decline-day close, direction-aware', () => {
    const closes = [
      { ymd: '2026-07-20', c: 100 },
      { ymd: '2026-07-21', c: 103 },
      { ymd: '2026-07-22', c: 104 },
      { ymd: '2026-07-23', c: 106 },
    ];
    // Vetoed long that would have won: positive forgone.
    expect(scoreJudgeVeto({ ticker: 'GS', ymd: '2026-07-20', direction: 'long' }, closes)).toEqual({
      forgone1d: 3,
      forgone3d: 6,
    });
    // Vetoed short on the same tape: the veto saved money (negative forgone).
    expect(
      scoreJudgeVeto({ ticker: 'GS', ymd: '2026-07-20', direction: 'short' }, closes),
    ).toEqual({ forgone1d: -3, forgone3d: -6 });
    expect(scoreJudgeVeto({ ticker: 'GS', ymd: '2026-08-01', direction: 'long' }, closes)).toEqual({});
  });
});

describe('analystStats + proposeWeights', () => {
  const trip = (returnPct: number): RoundTrip => ({
    ticker: 'GS',
    direction: 'long',
    qty: 10,
    entryAvgPrice: 100,
    exitAvgPrice: 100 + returnPct,
    openedAt: '2026-07-01T14:00:00Z',
    closedAt: '2026-07-02T14:00:00Z',
    returnPct,
    realizedPnlUsd: returnPct * 10,
  });
  const verdict = (analyst: Verdict['analyst'], direction: Verdict['direction']): Verdict => ({
    analyst,
    ticker: 'GS',
    direction,
    conviction: 0.6,
    horizon: 'days',
    evidence: [],
    invalidation_conditions: [],
  });

  it('aligned verdicts hit on wins; contrary verdicts hit on losses; none excluded', () => {
    const stats = analystStats([
      { trip: trip(5), verdicts: [verdict('fundamental', 'long'), verdict('bear', 'short'), verdict('macro', 'none')] },
      { trip: trip(-5), verdicts: [verdict('fundamental', 'long'), verdict('bear', 'short')] },
    ]);
    expect(stats.fundamental).toEqual({ n: 2, hits: 1, hitRate: 0.5 });
    expect(stats.bear).toEqual({ n: 2, hits: 1, hitRate: 0.5 });
    expect(stats.macro.n).toBe(0);
  });

  it('proposeWeights keeps sub-sample analysts at current weight and clamps the adjustment', () => {
    const stats = analystStats([]);
    stats.fundamental = { n: 12, hits: 9, hitRate: 0.75 }; // adj 1.5 (clamped)
    stats.bear = { n: 12, hits: 3, hitRate: 0.25 }; // adj 0.5 (clamped)
    stats.technical = { n: 4, hits: 4, hitRate: 1 }; // below min sample
    const current = { fundamental: 1, technical: 0.8, macro: 0.6, sentiment: 1, bear: 1.2 };
    const proposed = proposeWeights(stats, current, 10);
    expect(proposed.fundamental).toBe(1.5);
    expect(proposed.bear).toBe(0.6);
    expect(proposed.technical).toBe(0.8); // untouched
    expect(proposed.macro).toBe(0.6); // n=0 untouched
  });
});

describe('shortfallBps (implementation shortfall)', () => {
  it('positive = cost vs the decision mid, direction-aware', () => {
    // buy filled ABOVE mid costs; 100 -> 100.10 = +10 bps
    expect(shortfallBps('buy', 100, 100.1)).toBeCloseTo(10, 5);
    // sell filled BELOW mid costs; 100 -> 99.90 = +10 bps
    expect(shortfallBps('sell', 100, 99.9)).toBeCloseTo(10, 5);
    // price improvement is negative
    expect(shortfallBps('buy', 100, 99.95)).toBeCloseTo(-5, 5);
  });

  it('unusable prices yield undefined, never a fake zero', () => {
    expect(shortfallBps('buy', 0, 100)).toBeUndefined();
    expect(shortfallBps('sell', 100, 0)).toBeUndefined();
  });
});

describe('nearestDecision (fill -> proposed_order join)', () => {
  const d = (tsMs: number, over: Partial<DecisionRecord> = {}): DecisionRecord => ({
    tsMs,
    ticker: 'NVDA',
    side: 'buy',
    intent: 'entry',
    session: 'premarket',
    decisionMid: 100,
    ...over,
  });

  it('picks the latest same-ticker same-side decision at or before the fill', () => {
    const decisions = [d(1000), d(5000), d(9000, { decisionMid: 101 })];
    const hit = nearestDecision({ tsMs: 10_000, ticker: 'NVDA', side: 'buy' }, decisions);
    expect(hit?.decisionMid).toBe(101);
  });

  it('a re-proposal (escalated passive exit) wins by recency', () => {
    const decisions = [
      d(1000, { side: 'sell', intent: 'exit', decisionMid: 100.05 }), // passive attempt
      d(901_000, { side: 'sell', intent: 'exit', decisionMid: 100.0 }), // escalation, 15 min later
    ];
    const hit = nearestDecision({ tsMs: 902_000, ticker: 'NVDA', side: 'sell' }, decisions);
    expect(hit?.decisionMid).toBe(100.0);
  });

  it('ignores wrong ticker, wrong side, decisions after the fill, and stale decisions', () => {
    const decisions = [
      d(1000, { ticker: 'AMD' }),
      d(1000, { side: 'sell' }),
      d(200_000), // after the fill (beyond 60s tolerance)
      d(-9 * 3_600_000), // older than the 8h window
    ];
    expect(nearestDecision({ tsMs: 100_000, ticker: 'NVDA', side: 'buy' }, decisions)).toBeUndefined();
  });

  it('tolerates small clock skew: a decision up to 60s after the fill still matches', () => {
    const decisions = [d(100_030)];
    expect(nearestDecision({ tsMs: 100_000, ticker: 'NVDA', side: 'buy' }, decisions)).toBeDefined();
  });
});
