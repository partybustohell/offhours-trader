import { describe, expect, it } from 'vitest';
import {
  entryLimitPrice,
  partitionFreshQuotes,
  seedDeployedTodayUsd,
} from '../src/executor-loop.js';
import type { QuoteSnapshot } from '../src/types.js';

describe('partitionFreshQuotes (staleness guard)', () => {
  const now = Date.parse('2026-07-09T21:30:00Z');
  const q = (asOf: string): QuoteSnapshot => ({
    ticker: 'X',
    bid: 10,
    ask: 10.02,
    bidSize: 1,
    askSize: 1,
    last: 10.01,
    asOf,
  });

  it('keeps a quote within the age window', () => {
    const r = partitionFreshQuotes([q('2026-07-09T21:29:00Z')], now, 120); // 60s old
    expect(r.fresh).toHaveLength(1);
    expect(r.stale).toBe(0);
  });

  it('drops a quote older than the window (the IEX deep-off-hours case)', () => {
    const r = partitionFreshQuotes([q('2026-07-09T17:00:00Z')], now, 120); // hours old
    expect(r.fresh).toHaveLength(0);
    expect(r.stale).toBe(1);
  });

  it('treats a missing/empty timestamp as stale — never forged fresh', () => {
    expect(partitionFreshQuotes([q('')], now, 120).stale).toBe(1);
    expect(partitionFreshQuotes([q('not-a-date')], now, 120).stale).toBe(1);
  });

  it('drops a future-dated quote beyond tolerance', () => {
    const r = partitionFreshQuotes([q('2026-07-09T22:00:00Z')], now, 120); // 30min ahead
    expect(r.stale).toBe(1);
  });
});

describe('seedDeployedTodayUsd', () => {
  const order = (over: Partial<Parameters<typeof seedDeployedTodayUsd>[0][number]>) => ({
    clientOrderId: 'entry-abc',
    status: 'accepted',
    qty: 10,
    filledQty: 0,
    limitPrice: 100,
    ...over,
  });

  it('counts short entries (sell side) toward the daily budget', () => {
    expect(seedDeployedTodayUsd([order({})])).toBe(1000);
  });

  it('ignores exit orders, including buy-side short covers', () => {
    expect(seedDeployedTodayUsd([order({ clientOrderId: 'exit-abc' })])).toBe(0);
  });

  it('ignores orders without our client_order_id tag', () => {
    expect(seedDeployedTodayUsd([order({ clientOrderId: undefined })])).toBe(0);
  });

  it('counts canceled entries at their filled portion', () => {
    expect(seedDeployedTodayUsd([order({ status: 'canceled', filledQty: 4 })])).toBe(400);
    expect(seedDeployedTodayUsd([order({ status: 'canceled', filledQty: 0 })])).toBe(0);
  });

  it('sums across mixed orders', () => {
    expect(
      seedDeployedTodayUsd([
        order({}), // 1000
        order({ status: 'canceled', filledQty: 2 }), // 200
        order({ clientOrderId: 'exit-x' }), // 0
      ]),
    ).toBe(1200);
  });
});

describe('entryLimitPrice', () => {
  const band = { low: 97, high: 101 };

  it('long: min(ask, band.high), floored to cents', () => {
    expect(entryLimitPrice('long', { bid: 99, ask: 100.129 }, band)).toBe(100.12);
    expect(entryLimitPrice('long', { bid: 99, ask: 105 }, band)).toBe(101);
  });

  it('short: max(bid, band.low), ceiled to cents', () => {
    expect(entryLimitPrice('short', { bid: 99.991, ask: 100.2 }, band)).toBe(100);
    expect(entryLimitPrice('short', { bid: 90, ask: 100.2 }, band)).toBe(97);
  });

  it('rounding never crosses the band edge', () => {
    // band.high with sub-penny precision: floor keeps the buy at or below it
    const b = { low: 97.111, high: 101.999 };
    expect(entryLimitPrice('long', { bid: 99, ask: 200 }, b)).toBeLessThanOrEqual(b.high);
    expect(entryLimitPrice('short', { bid: 0.5, ask: 100 }, b)).toBeGreaterThanOrEqual(b.low);
  });
});
