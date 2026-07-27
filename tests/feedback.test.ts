import { describe, expect, it } from 'vitest';
import { analystStats, fitCalibration, pairRoundTrips, proposeWeights, type RoundTrip } from '../src/feedback.js';
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
