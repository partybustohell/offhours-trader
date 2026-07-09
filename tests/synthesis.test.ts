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

describe('computeThesisEntries — priority ordering, floor, and name cap', () => {
  // Three long verdicts per ticker (F/S/T): directional weight 2.8, so the
  // score equals the shared conviction; quorum 3 and min_agreeing 2 are met.
  const longs = (ticker: string, conviction: number): Verdict[] => [
    v('fundamental', 'long', conviction, [], ticker),
    v('sentiment', 'long', conviction, [], ticker),
    v('technical', 'long', conviction, [], ticker),
  ];
  const multiMi = (
    rows: Record<string, { price: number; vol?: number }>,
  ): Map<string, TickerMarketInfo> => {
    const m = new Map<string, TickerMarketInfo>();
    for (const [ticker, { price, vol }] of Object.entries(rows)) {
      m.set(ticker, {
        lastPrice: price,
        avgDollarVolume20d: 1e9,
        ...(vol !== undefined ? { realizedVolAnnualized: vol } : {}),
      });
    }
    return m;
  };
  const flat = multiMi({ AAA: { price: 100 }, BBB: { price: 100 }, CCC: { price: 100 } });
  const t50 = { conviction_threshold: 0.5 };

  it('orders entries by weightedConviction desc regardless of input order', () => {
    // fed BBB(0.6), AAA(0.9), CCC(0.75) — sorted output must be AAA, CCC, BBB.
    const verdicts = [...longs('BBB', 0.6), ...longs('AAA', 0.9), ...longs('CCC', 0.75)];
    const { entries } = computeThesisEntries(verdicts, flat, account(100_000), cfg(t50));
    expect(entries.map((e) => e.ticker)).toEqual(['AAA', 'CCC', 'BBB']);
    expect(entries[0]!.weightedConviction).toBeCloseTo(0.9, 10);
  });

  it('conviction_per_risk divides conviction by realized vol', () => {
    // per-risk: BBB 0.6/0.2=3.0 > CCC 0.75/0.5=1.5 > AAA 0.9/0.9=1.0
    const verdicts = [...longs('AAA', 0.9), ...longs('BBB', 0.6), ...longs('CCC', 0.75)];
    const { entries } = computeThesisEntries(
      verdicts,
      multiMi({ AAA: { price: 100, vol: 0.9 }, BBB: { price: 100, vol: 0.2 }, CCC: { price: 100, vol: 0.5 } }),
      account(100_000),
      cfg({ ...t50, deploy_priority: 'conviction_per_risk' }),
    );
    expect(entries.map((e) => e.ticker)).toEqual(['BBB', 'CCC', 'AAA']);
  });

  it('breaks conviction ties deterministically by ticker', () => {
    const verdicts = [...longs('ZZZ', 0.8), ...longs('AAA', 0.8), ...longs('MMM', 0.8)];
    const { entries } = computeThesisEntries(
      verdicts,
      multiMi({ AAA: { price: 100 }, MMM: { price: 100 }, ZZZ: { price: 100 } }),
      account(100_000),
      cfg(t50),
    );
    expect(entries.map((e) => e.ticker)).toEqual(['AAA', 'MMM', 'ZZZ']);
  });

  it('drops entries below the min-position floor with the canonical reason', () => {
    // base 2000: AAA 1800, CCC 1500 kept; BBB 1200 < 1400 floor -> dropped.
    const verdicts = [...longs('AAA', 0.9), ...longs('BBB', 0.6), ...longs('CCC', 0.75)];
    const { entries, skipped } = computeThesisEntries(
      verdicts,
      flat,
      account(100_000),
      cfg({ ...t50, min_position_notional_usd: 1400 }),
    );
    expect(entries.map((e) => e.ticker)).toEqual(['AAA', 'CCC']);
    expect(skipped).toContainEqual({ ticker: 'BBB', reason: 'below min position' });
  });

  it('caps the entry count to max_open_names, keeping the top-conviction names', () => {
    const verdicts = [...longs('AAA', 0.9), ...longs('BBB', 0.6), ...longs('CCC', 0.75)];
    const { entries, skipped } = computeThesisEntries(
      verdicts,
      flat,
      account(100_000),
      cfg({ ...t50, max_open_names: 2 }),
    );
    expect(entries.map((e) => e.ticker)).toEqual(['AAA', 'CCC']);
    expect(skipped).toContainEqual({ ticker: 'BBB', reason: 'over max_open_names' });
  });

  it('attaches leave-one-out sizing attribution when a signal shrinks the size', () => {
    const regime = { longScalar: 0.5, shortScalar: 1, volScalar: 1, thresholdBump: 0, state: 'trend:hostile' };
    const { entries } = computeThesisEntries(longs('AAA', 0.9), multiMi({ AAA: { price: 100 } }), account(100_000), cfg(t50), regime);
    const e = entries[0]!;
    expect(e.sizing).toBeDefined();
    expect(e.sizing!.scalars.regime_dir).toBeCloseTo(0.5, 10);
    expect(e.sizing!.product).toBeCloseTo(0.5, 10);
    expect(e.sizing!.leaveOneOut.regime_dir).toBeCloseTo(1, 10); // remove it -> full size
    expect(e.targetNotionalUsd).toBeCloseTo(900, 2); // 2000 * 0.9 * volScalar 1 * 0.5
  });

  it('omits sizing attribution when no signal fires (flag-off default)', () => {
    const { entries } = computeThesisEntries(longs('AAA', 0.9), multiMi({ AAA: { price: 100 } }), account(100_000), cfg(t50));
    expect(entries[0]!.sizing).toBeUndefined();
  });
});

describe('computeThesisEntries — P1–P3 signals (opt-in, down-only / gate)', () => {
  const longs3 = (c: number, ticker = 'NVDA'): Verdict[] => [
    v('fundamental', 'long', c, [], ticker),
    v('sentiment', 'long', c, [], ticker),
    v('technical', 'long', c, [], ticker),
  ];
  const shorts3 = (c: number, ticker = 'NVDA'): Verdict[] => [
    v('bear', 'short', c, [], ticker),
    v('sentiment', 'short', c, [], ticker),
    v('technical', 'short', c, [], ticker),
  ];
  const miWith = (fields: Partial<TickerMarketInfo>, ticker = 'NVDA'): Map<string, TickerMarketInfo> =>
    new Map([[ticker, { lastPrice: 100, avgDollarVolume20d: 1e9, ...fields }]]);
  const t50 = { conviction_threshold: 0.5 };

  it('baseline (all signals off): NVDA 0.9 -> 2000*0.9 = 1800', () => {
    const e = computeThesisEntries(longs3(0.9), miWith({}), account(100_000), cfg(t50)).entries[0]!;
    expect(e.targetNotionalUsd).toBe(1800);
  });

  it('anti-chase haircut halves size when the name ran up in the trade direction', () => {
    const c = cfg({ ...t50, signals: { anti_chase: { enabled: true, run_threshold_pct: 10, haircut: 0.5 } } });
    const e = computeThesisEntries(longs3(0.9), miWith({ recentReturnPct: 20 }), account(100_000), c).entries[0]!;
    expect(e.targetNotionalUsd).toBe(900); // 1800 * 0.5
  });

  it('anti-chase does not fire when the run is below threshold or opposite the trade', () => {
    const c = cfg({ ...t50, signals: { anti_chase: { enabled: true, run_threshold_pct: 10, haircut: 0.5 } } });
    const below = computeThesisEntries(longs3(0.9), miWith({ recentReturnPct: 5 }), account(100_000), c).entries[0]!;
    expect(below.targetNotionalUsd).toBe(1800);
    const opposite = computeThesisEntries(longs3(0.9), miWith({ recentReturnPct: -20 }), account(100_000), c).entries[0]!;
    expect(opposite.targetNotionalUsd).toBe(1800);
  });

  it('the multiplicative floor bounds stacked down-only scalars', () => {
    // anti-chase 0.5 * amihud 0.5 = 0.25 (> floor 0.2) -> 1800*0.25 = 450.
    const c = cfg({
      ...t50,
      signal_scalar_floor: 0.2,
      signals: {
        anti_chase: { enabled: true, run_threshold_pct: 10, haircut: 0.5 },
        amihud: { enabled: true, max_amihud: 1, size_haircut: 0.5 },
      },
    });
    const e = computeThesisEntries(longs3(0.9), miWith({ recentReturnPct: 20, amihudIlliquidity: 5 }), account(100_000), c).entries[0]!;
    expect(e.targetNotionalUsd).toBe(450);
    // With a haircut of 0.1 each, product 0.01 would floor to 0.2 -> 360.
    const c2 = cfg({
      ...t50,
      signal_scalar_floor: 0.2,
      signals: {
        anti_chase: { enabled: true, run_threshold_pct: 10, haircut: 0.1 },
        amihud: { enabled: true, max_amihud: 1, size_haircut: 0.1 },
      },
    });
    const e2 = computeThesisEntries(longs3(0.9), miWith({ recentReturnPct: 20, amihudIlliquidity: 5 }), account(100_000), c2).entries[0]!;
    expect(e2.targetNotionalUsd).toBe(360); // 1800 * 0.2
  });

  it('trend gate blocks a short into a strong uptrend', () => {
    const c = cfg({ ...t50, signals: { trend_gate: { enabled: true, contra_block: true, min_pct_of_52w_high: 0.75 } } });
    const { entries, skipped } = computeThesisEntries(
      shorts3(0.9),
      miWith({ momentumPct: 30, pctOf52wHigh: 0.95 }),
      account(100_000),
      c,
    );
    expect(entries).toEqual([]);
    expect(skipped).toContainEqual({ ticker: 'NVDA', reason: 'trend gate' });
  });

  it('gap gate blocks a long fading a big gap-down on volume', () => {
    const c = cfg({ ...t50, signals: { gap: { enabled: true, contra_gate: true, min_gap_pct: 3, min_rel_volume: 2 } } });
    const { entries, skipped } = computeThesisEntries(
      longs3(0.9),
      miWith({ gapPct: -5, gapRelVolume: 3 }),
      account(100_000),
      c,
    );
    expect(entries).toEqual([]);
    expect(skipped).toContainEqual({ ticker: 'NVDA', reason: 'gap gate' });
  });

  it('regime direction scalar shrinks long size; volScalar shrinks all', () => {
    const regime = { longScalar: 0.4, shortScalar: 1, volScalar: 0.5, thresholdBump: 0, state: 'test' };
    const e = computeThesisEntries(longs3(0.9), miWith({}), account(100_000), cfg(t50), regime).entries[0]!;
    // 1800 * (0.4 * 0.5) = 360
    expect(e.targetNotionalUsd).toBe(360);
  });

  it('regime threshold bump raises the bar and can skip an otherwise-passing entry', () => {
    const regime = { longScalar: 1, shortScalar: 1, volScalar: 1, thresholdBump: 0.2, state: 'hostile' };
    // conviction 0.6 clears 0.5 but not 0.5 + 0.2 = 0.7.
    const { entries, skipped } = computeThesisEntries(longs3(0.6), miWith({}), account(100_000), cfg(t50), regime);
    expect(entries).toEqual([]);
    expect(skipped).toContainEqual({ ticker: 'NVDA', reason: 'below threshold' });
  });

  it('calibration remaps the conviction used for the threshold and sizing', () => {
    // map 0.9 -> 0.5; threshold 0.5 passes; size uses 0.5 -> 2000*0.5 = 1000.
    const c = cfg({
      conviction_threshold: 0.5,
      calibration: { enabled: true, table: [{ score: 0, prob: 0 }, { score: 0.9, prob: 0.5 }, { score: 1, prob: 0.6 }] },
    });
    const e = computeThesisEntries(longs3(0.9), miWith({}), account(100_000), c).entries[0]!;
    expect(e.weightedConviction).toBeCloseTo(0.5, 10);
    expect(e.targetNotionalUsd).toBe(1000);
  });

  it('portfolio target-vol scalar shrinks the whole book (down-only)', () => {
    // Volatile returns + a tight 1% book-vol target so the scalar binds even at
    // this small position size (a single 1.8%-of-equity name has low book vol).
    const returns = new Map([['NVDA', Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? 0.05 : -0.05))]]);
    const c = cfg({ ...t50, portfolio: { target_vol: { enabled: true, pct: 1 } } });
    const e = computeThesisEntries(longs3(0.9), miWith({}), account(100_000), c, undefined, returns).entries[0]!;
    expect(e.targetNotionalUsd).toBeLessThan(1800);
    expect(e.targetNotionalUsd).toBeGreaterThan(0);
  });

  it('portfolio cov_lookback_days is honored (shorter calm window -> less shrink)', () => {
    // 60 wild days then 20 calm days. A 20-day window sees only the calm tail
    // (low book vol -> larger size); a 70-day window includes the wild stretch.
    const series = [
      ...Array.from({ length: 60 }, (_, i) => (i % 2 === 0 ? 0.05 : -0.05)),
      ...Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? 0.005 : -0.005)),
    ];
    const returns = new Map<string, number[]>([['NVDA', series]]);
    const c20 = cfg({ ...t50, portfolio: { target_vol: { enabled: true, pct: 1 }, cov_lookback_days: 20 } });
    const c70 = cfg({ ...t50, portfolio: { target_vol: { enabled: true, pct: 1 }, cov_lookback_days: 70 } });
    const e20 = computeThesisEntries(longs3(0.9), miWith({}), account(100_000), c20, undefined, returns).entries[0]!;
    const e70 = computeThesisEntries(longs3(0.9), miWith({}), account(100_000), c70, undefined, returns).entries[0]!;
    expect(e20.targetNotionalUsd).toBeGreaterThan(e70.targetNotionalUsd);
  });

  it('portfolio inverse-vol reallocates the budget toward the lower-vol name', () => {
    // Two equal-conviction names; CALM has tiny returns, WILD has large ones.
    const verdicts = [...longs3(0.9, 'CALM'), ...longs3(0.9, 'WILD')];
    const info = new Map<string, TickerMarketInfo>([
      ['CALM', { lastPrice: 100, avgDollarVolume20d: 1e9 }],
      ['WILD', { lastPrice: 100, avgDollarVolume20d: 1e9 }],
    ]);
    // Vols close enough that both stay above the min-position floor after the
    // reallocation (CALM ~1% daily, WILD ~3% daily).
    const returns = new Map<string, number[]>([
      ['CALM', Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? 0.01 : -0.01))],
      ['WILD', Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? 0.03 : -0.03))],
    ]);
    const c = cfg({ ...t50, portfolio: { sizing_mode: 'inverse_vol' } });
    const { entries } = computeThesisEntries(verdicts, info, account(100_000), c, undefined, returns);
    const calm = entries.find((e) => e.ticker === 'CALM')!;
    const wild = entries.find((e) => e.ticker === 'WILD')!;
    expect(calm.targetNotionalUsd).toBeGreaterThan(wild.targetNotionalUsd);
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
