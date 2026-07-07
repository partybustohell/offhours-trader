import { describe, expect, it } from 'vitest';
import { entryLimitPrice, seedDeployedTodayUsd } from '../src/executor-loop.js';

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
