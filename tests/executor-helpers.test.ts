import { describe, expect, it } from 'vitest';
import {
  entryLimitPrice,
  partitionFreshQuotes,
  positionLossPct,
  seedDeployedTodayUsd,
  shortEligibility,
} from '../src/executor-loop.js';
import type { QuoteSnapshot } from '../src/types.js';

describe('positionLossPct (universal hard-stop input)', () => {
  it('marks a long at the bid: down 10% is a +10% loss, up is negative', () => {
    expect(positionLossPct({ side: 'long', avgEntryPrice: 100 }, { bid: 90, ask: 90.1 })).toBeCloseTo(10, 10);
    expect(positionLossPct({ side: 'long', avgEntryPrice: 100 }, { bid: 110, ask: 110.1 })).toBeCloseTo(-10, 10);
  });
  it('marks a short at the ask: price up 8% is a +8% loss', () => {
    expect(positionLossPct({ side: 'short', avgEntryPrice: 100 }, { bid: 107.9, ask: 108 })).toBeCloseTo(8, 10);
    expect(positionLossPct({ side: 'short', avgEntryPrice: 100 }, { bid: 92, ask: 92.1 })).toBeCloseTo(-7.9, 10);
  });
  it('returns 0 when avgEntryPrice is non-positive (no basis)', () => {
    expect(positionLossPct({ side: 'long', avgEntryPrice: 0 }, { bid: 90, ask: 90.1 })).toBe(0);
    expect(positionLossPct({ side: 'long', avgEntryPrice: -5 }, { bid: 90, ask: 90.1 })).toBe(0);
  });
});

describe('entryLimitPrice — semi-passive aggressiveness', () => {
  const quote = { bid: 100, ask: 100.1 };
  const band = { low: 97, high: 101 };

  it('aggressiveness 1 (default) is marketable: take the far side, clamped, cent-rounded', () => {
    expect(entryLimitPrice('long', quote, band)).toBe(100.1); // min(ask, high)
    expect(entryLimitPrice('long', quote, band, 1)).toBe(100.1);
    expect(entryLimitPrice('short', quote, band)).toBe(100); // max(bid, low)
  });

  it('aggressiveness < 1 rests inside the spread by that fraction', () => {
    // long: bid + 0.5*(ask-bid) = 100.05 (floored)
    expect(entryLimitPrice('long', quote, band, 0.5)).toBe(100.05);
    // short: ask - 0.5*(ask-bid) = 100.05 (ceiled)
    expect(entryLimitPrice('short', quote, band, 0.5)).toBe(100.05);
    // long fully passive at the bid
    expect(entryLimitPrice('long', quote, band, 0)).toBe(100);
  });

  it('still clamps a passive price into the band', () => {
    expect(entryLimitPrice('long', quote, { low: 97, high: 100.03 }, 0.5)).toBe(100.03);
  });
});

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

describe('shortEligibility (live short/borrow gate, ports backtest checkShortable)', () => {
  it('allows a shortable, easy-to-borrow name under strict mode', () => {
    expect(shortEligibility({ shortable: true, easyToBorrow: true }, true)).toEqual({ ok: true, reason: '' });
  });

  it('blocks a name that is not shortable', () => {
    expect(shortEligibility({ shortable: false, easyToBorrow: false }, true)).toEqual({
      ok: false,
      reason: 'not shortable',
    });
  });

  it('blocks a shortable but hard-to-borrow name when easy-to-borrow is required', () => {
    expect(shortEligibility({ shortable: true, easyToBorrow: false }, true)).toEqual({
      ok: false,
      reason: 'not easy to borrow',
    });
  });

  it('allows a shortable but hard-to-borrow name when easy-to-borrow is not required', () => {
    expect(shortEligibility({ shortable: true, easyToBorrow: false }, false)).toEqual({ ok: true, reason: '' });
  });

  it('fails closed when the asset lookup returned nothing', () => {
    expect(shortEligibility(null, true)).toEqual({ ok: false, reason: 'shortability unknown' });
    expect(shortEligibility(null, false)).toEqual({ ok: false, reason: 'shortability unknown' });
  });
});
