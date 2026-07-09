import { describe, expect, it } from 'vitest';
import { computeThesisEntries, thesisExpiry, rthThesisExpiry } from '../src/synthesis.js';
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
  it('normalizes over directional weight only; none-verdicts count toward quorum but never dilute', () => {
    // fundamental 1.0 and sentiment 1.0 agree long; bear 'none' counts toward
    // quorum but stays out of numerator AND denominator.
    // longScore = (1.0*0.8 + 1.0*0.9) / (1.0 + 1.0) = 1.7/2.0 = 0.85
    const verdicts = [
      v('fundamental', 'long', 0.8),
      v('sentiment', 'long', 0.9),
      v('bear', 'none', 0.7), // conviction on 'none' must not affect scores
    ];

    const { entries, skipped } = computeThesisEntries(verdicts, mi(100), account(100_000), cfg());
    expect(skipped).toEqual([]);
    expect(entries).toHaveLength(1);
    const e = entries[0]!;
    expect(e.direction).toBe('long');
    expect(e.weightedConviction).toBeCloseTo(0.85, 10);
    // min(2000, 100000*5%) = 2000; 2000 * 0.85 = 1700.00
    expect(e.targetNotionalUsd).toBeCloseTo(1700, 2);
  });

  it('opposing directional votes DO dilute: the bear vetoes through contrary verdicts', () => {
    // longs 1.0*0.8 + 1.0*0.9 = 1.7; bear short 1.2*0.85 = 1.02; directional
    // weight 3.2 -> longScore 0.53125, shortScore 0.31875 -> both >= 0.3.
    const { entries, skipped } = computeThesisEntries(
      [v('fundamental', 'long', 0.8), v('sentiment', 'long', 0.9), v('bear', 'short', 0.85)],
      mi(100),
      account(100_000),
      cfg(),
    );
    expect(entries).toEqual([]);
    expect(skipped).toEqual([{ ticker: 'NVDA', reason: 'disagreement' }]);
  });

  it('risk-parity sizing: high realized vol shrinks the position, low vol does not', () => {
    const three = [
      v('fundamental', 'long', 1),
      v('sentiment', 'long', 1),
      v('technical', 'long', 1),
    ];
    // Base notional min(2000, 100000*5%) = 2000; conviction 1.
    // High vol 0.80 vs target 0.40 -> scalar 0.5 -> 1000.
    const hi = new Map([['NVDA', { lastPrice: 100, avgDollarVolume20d: 1e9, realizedVolAnnualized: 0.8 }]]);
    const hiEntry = computeThesisEntries(three, hi, account(100_000), cfg()).entries[0]!;
    expect(hiEntry.targetNotionalUsd).toBeCloseTo(1000, 2);
    // Low vol 0.20 -> scalar capped at 1 (never lever up) -> full 2000.
    const lo = new Map([['NVDA', { lastPrice: 100, avgDollarVolume20d: 1e9, realizedVolAnnualized: 0.2 }]]);
    const loEntry = computeThesisEntries(three, lo, account(100_000), cfg()).entries[0]!;
    expect(loEntry.targetNotionalUsd).toBeCloseTo(2000, 2);
    // Missing vol -> no scaling.
    const none = computeThesisEntries(three, mi(100), account(100_000), cfg()).entries[0]!;
    expect(none.targetNotionalUsd).toBeCloseTo(2000, 2);
  });

  it('a single agreeing analyst cannot trade alone: agreement quorum', () => {
    // Lone long at 0.95 scores 0.95 (clears the threshold) but min_agreeing 2 blocks it.
    const { entries, skipped } = computeThesisEntries(
      [v('fundamental', 'long', 0.95), v('sentiment', 'none', 0.8), v('bear', 'none', 0.7)],
      mi(100),
      account(100_000),
      cfg(),
    );
    expect(entries).toEqual([]);
    expect(skipped).toEqual([{ ticker: 'NVDA', reason: 'agreement quorum' }]);
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
    // Directional weight: fundamental 1.0 + technical 0.8 = 1.8 ('none' excluded).
    // longScore = 0.9/1.8 = 0.5; shortScore = 0.8*0.9/1.8 = 0.4 -> min >= 0.3.
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
    // Directional weight 1.8: shortScore = 0.8*0.6/1.8 = 0.2666... < 0.3 -> no
    // disagreement; direction long with ONE agreeing analyst -> agreement quorum.
    const { skipped } = computeThesisEntries(
      [v('fundamental', 'long', 0.9), v('technical', 'short', 0.6), v('macro', 'none', 0)],
      mi(100),
      account(100_000),
      cfg(),
    );
    expect(skipped).toEqual([{ ticker: 'NVDA', reason: 'agreement quorum' }]);
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
    // Directional weight: bear 1.2 + technical 0.8 = 2.0 ('none' excluded).
    // shortScore = (1.2*0.9 + 0.8*0.8)/2.0 = 1.72/2.0 = 0.86 >= 0.65.
    const { entries } = computeThesisEntries(
      [v('bear', 'short', 0.9), v('technical', 'short', 0.8), v('macro', 'none', 0)],
      mi(100),
      account(100_000),
      cfg(),
    );
    const e = entries[0]!;
    expect(e.direction).toBe('short');
    expect(e.weightedConviction).toBeCloseTo(0.86, 10);
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
    // Directional weight: fundamental 1.0 + technical 0.8 = 1.8.
    // longScore = (0.777 + 0.8*0.888)/1.8 = 1.4874/1.8 = 0.8263333...;
    // 2000 * that = 1652.666... -> 1652.67
    const { entries } = computeThesisEntries(
      [v('fundamental', 'long', 0.777), v('technical', 'long', 0.888), v('bear', 'none', 0)],
      mi(100),
      account(100_000),
      cfg({ conviction_threshold: 0.5 }),
    );
    expect(entries[0]!.targetNotionalUsd).toBe(1652.67);
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

describe('rthThesisExpiry', () => {
  it('expires the same day at 16:00 ET (the close), summer EDT', () => {
    // 16:00 EDT (UTC-4) = 20:00Z.
    expect(rthThesisExpiry('2026-07-09')).toBe('2026-07-09T20:00:00.000Z');
  });

  it('expires the same day at 16:00 ET, winter EST', () => {
    // 16:00 EST (UTC-5) = 21:00Z.
    expect(rthThesisExpiry('2026-01-09')).toBe('2026-01-09T21:00:00.000Z');
  });
});
