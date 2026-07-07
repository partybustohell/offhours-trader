import { describe, expect, it } from 'vitest';
import { computeThesisEntries, thesisExpiry } from '../src/synthesis.js';
import type { TickerMarketInfo } from '../src/candidates.js';
import { ConfigSchema, type Config } from '../src/config.js';
import type { AccountSnapshot, AnalystName, Direction, Verdict } from '../src/types.js';

function cfg(overrides: Record<string, unknown> = {}): Config {
  return ConfigSchema.parse(overrides);
}

function v(
  analyst: AnalystName,
  direction: Direction,
  conviction: number,
  invalidation_conditions: string[] = [],
  ticker = 'NVDA',
): Verdict {
  return { analyst, ticker, direction, conviction, horizon: 'days', evidence: [], invalidation_conditions };
}

function account(equity: number): AccountSnapshot {
  return { equity, cash: equity, positions: [] };
}

function mi(lastPrice: number, ticker = 'NVDA'): Map<string, TickerMarketInfo> {
  return new Map([[ticker, { lastPrice, avgDollarVolume20d: 1_000_000_000 }]]);
}

describe('computeThesisEntries', () => {
  it('normalizes by responding weights; none-verdicts count toward quorum but not scores', () => {
    // Default weights: fundamental 1.0, sentiment 1.0, bear 1.2 -> responding sum 3.2.
    // longScore = (1.0*0.8 + 1.0*0.9) / 3.2 = 1.7/3.2 = 0.53125
    const verdicts = [
      v('fundamental', 'long', 0.8),
      v('sentiment', 'long', 0.9),
      v('bear', 'none', 0.7), // conviction on 'none' must not affect scores
    ];

    // Quorum of 3 is met (the 'none' verdict counts) but 0.53125 < default 0.65 threshold.
    const below = computeThesisEntries(verdicts, mi(100), account(100_000), cfg());
    expect(below.entries).toEqual([]);
    expect(below.skipped).toEqual([{ ticker: 'NVDA', reason: 'below threshold' }]);

    const { entries, skipped } = computeThesisEntries(
      verdicts,
      mi(100),
      account(100_000),
      cfg({ conviction_threshold: 0.5 }),
    );
    expect(skipped).toEqual([]);
    expect(entries).toHaveLength(1);
    const e = entries[0]!;
    expect(e.direction).toBe('long');
    expect(e.weightedConviction).toBeCloseTo(0.53125, 10);
    // min(2000, 100000*5%) = 2000; 2000 * 0.53125 = 1062.50
    expect(e.targetNotionalUsd).toBeCloseTo(1062.5, 2);
  });

  it('skips tickers with fewer verdicts than quorum', () => {
    const { entries, skipped } = computeThesisEntries(
      [v('fundamental', 'long', 0.9), v('sentiment', 'long', 0.9)],
      mi(100),
      account(100_000),
      cfg(), // quorum 3
    );
    expect(entries).toEqual([]);
    expect(skipped).toEqual([{ ticker: 'NVDA', reason: 'quorum' }]);
  });

  it('skips on disagreement when both scores are >= 0.3 (boundary included)', () => {
    // Weights: fundamental 1.0, technical 0.8, macro 0.6 -> sum 2.4.
    // longScore = 0.9/2.4 = 0.375; shortScore = 0.8*0.9/2.4 = 0.3 -> min >= 0.3.
    const { entries, skipped } = computeThesisEntries(
      [v('fundamental', 'long', 0.9), v('technical', 'short', 0.9), v('macro', 'none', 0)],
      mi(100),
      account(100_000),
      cfg(),
    );
    expect(entries).toEqual([]);
    expect(skipped).toEqual([{ ticker: 'NVDA', reason: 'disagreement' }]);
  });

  it('does not flag disagreement when the minority score is below 0.3', () => {
    // shortScore = 0.8*0.85/2.4 = 0.2833... < 0.3 -> no disagreement;
    // longScore = 0.9/2.4 = 0.375 < 0.65 -> below threshold.
    const { skipped } = computeThesisEntries(
      [v('fundamental', 'long', 0.9), v('technical', 'short', 0.85), v('macro', 'none', 0)],
      mi(100),
      account(100_000),
      cfg(),
    );
    expect(skipped).toEqual([{ ticker: 'NVDA', reason: 'below threshold' }]);
  });

  it('computes the long limit band from max_drop_pct below and max_chase_pct above', () => {
    const { entries } = computeThesisEntries(
      [v('fundamental', 'long', 1), v('sentiment', 'long', 1), v('technical', 'long', 1)],
      mi(100),
      account(100_000),
      cfg(), // max_drop_pct 3, max_chase_pct 1
    );
    const e = entries[0]!;
    expect(e.weightedConviction).toBeCloseTo(1, 10);
    expect(e.limitBand.low).toBeCloseTo(97, 10);
    expect(e.limitBand.high).toBeCloseTo(101, 10);
  });

  it('mirrors the band for shorts: max_chase_pct below, max_drop_pct above', () => {
    // Weights: bear 1.2, technical 0.8, macro 0.6 -> sum 2.6.
    // shortScore = (1.2*0.9 + 0.8*0.8)/2.6 = 1.72/2.6 = 0.66153... >= 0.65.
    const { entries } = computeThesisEntries(
      [v('bear', 'short', 0.9), v('technical', 'short', 0.8), v('macro', 'none', 0)],
      mi(100),
      account(100_000),
      cfg(),
    );
    const e = entries[0]!;
    expect(e.direction).toBe('short');
    expect(e.weightedConviction).toBeCloseTo(1.72 / 2.6, 10);
    expect(e.limitBand.low).toBeCloseTo(99, 10);
    expect(e.limitBand.high).toBeCloseTo(103, 10);
  });

  it('caps sizing by equity-based position limit when smaller than max order notional', () => {
    const full = [v('fundamental', 'long', 1), v('sentiment', 'long', 1), v('technical', 'long', 1)];
    // equity 20k: 5% = 1000 < 2000 -> base 1000; conviction 1 -> 1000.
    const small = computeThesisEntries(full, mi(100), account(20_000), cfg());
    expect(small.entries[0]!.targetNotionalUsd).toBe(1000);
    // equity 1M: 5% = 50000 -> base capped at max_order_notional_usd 2000.
    const large = computeThesisEntries(full, mi(100), account(1_000_000), cfg());
    expect(large.entries[0]!.targetNotionalUsd).toBe(2000);
  });

  it('rounds targetNotionalUsd to cents', () => {
    // sum 3.2; longScore = (0.777 + 0.888)/3.2 = 0.5203125; 2000 * that = 1040.625 -> 1040.63
    const { entries } = computeThesisEntries(
      [v('fundamental', 'long', 0.777), v('sentiment', 'long', 0.888), v('bear', 'none', 0)],
      mi(100),
      account(100_000),
      cfg({ conviction_threshold: 0.5 }),
    );
    expect(entries[0]!.targetNotionalUsd).toBe(1040.63);
  });

  it('skips with no market data even when conviction passes', () => {
    const { entries, skipped } = computeThesisEntries(
      [v('fundamental', 'long', 1), v('sentiment', 'long', 1), v('technical', 'long', 1)],
      new Map(),
      account(100_000),
      cfg(),
    );
    expect(entries).toEqual([]);
    expect(skipped).toEqual([{ ticker: 'NVDA', reason: 'no market data' }]);
  });

  it('unions invalidation conditions only from direction-agreeing verdicts', () => {
    const { entries } = computeThesisEntries(
      [
        v('fundamental', 'long', 0.9, ['A', 'B']),
        v('sentiment', 'long', 0.9, ['B', 'C']),
        v('bear', 'short', 0.2, ['D']), // shortScore 0.075 -> not disagreement
      ],
      mi(100),
      account(100_000),
      cfg({ conviction_threshold: 0.5 }),
    );
    expect(entries[0]!.invalidationConditions).toEqual(['A', 'B', 'C']);
  });
});

describe('thesisExpiry', () => {
  it('summer Friday expires Monday 20:00 EDT (UTC-4)', () => {
    // 2026-07-10 is a Friday; next weekday is Mon 2026-07-13.
    expect(thesisExpiry('2026-07-10')).toBe('2026-07-14T00:00:00.000Z');
  });

  it('winter Friday expires Monday 20:00 EST (UTC-5)', () => {
    // 2026-01-09 is a Friday; next weekday is Mon 2026-01-12.
    expect(thesisExpiry('2026-01-09')).toBe('2026-01-13T01:00:00.000Z');
  });

  it('midweek date expires the next calendar day at 20:00 ET', () => {
    // 2026-07-07 is a Tuesday -> Wed 2026-07-08 20:00 EDT.
    expect(thesisExpiry('2026-07-07')).toBe('2026-07-09T00:00:00.000Z');
  });
});
