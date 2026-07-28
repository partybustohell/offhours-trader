import { describe, expect, it } from 'vitest';
import {
  entryLimitPrice,
  exitLimitPrice,
  fetchPerSymbolNews,
  partitionFreshQuotes,
  peakEligibleMark,
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

describe('fetchPerSymbolNews (judge/exit headline coverage)', () => {
  const item = (headline: string, created_at = '2026-07-28T12:00:00Z') => ({
    headline,
    summary: '',
    symbols: ['X'],
    created_at,
    source: 'test',
  });

  it('fans out per symbol, dedupes shared stories, degrades failed symbols to empty', async () => {
    const md = {
      getNews: async (_limit: number, symbols?: string[]) => {
        const t = symbols?.[0];
        if (t === 'BAD') throw new Error('news api down');
        if (t === 'AAPL') return [item('a1'), item('shared')];
        return [item('shared'), item('n1')];
      },
    };
    const { items, failed } = await fetchPerSymbolNews(md, ['AAPL', 'NVDA', 'BAD']);
    expect(failed).toEqual(['BAD']);
    // the cross-listed story appears once; per-symbol coverage is preserved
    expect(items.map((i) => i.headline)).toEqual(['a1', 'shared', 'n1']);
  });

  it('an empty ticker list makes no calls', async () => {
    let calls = 0;
    const md = { getNews: async () => (calls++, []) };
    const { items } = await fetchPerSymbolNews(md, []);
    expect(items).toEqual([]);
    expect(calls).toBe(0);
  });
});

describe('exitLimitPrice — passive-first exits', () => {
  it('aggressiveness 1 reproduces the historical marketable exit exactly', () => {
    // sell (closing long): floor(bid); buy (covering short): ceil(ask)
    expect(exitLimitPrice('sell', { bid: 100.089, ask: 100.2 }, 1)).toBe(100.08);
    expect(exitLimitPrice('sell', { bid: 100.089, ask: 100.2 })).toBe(100.08); // default
    expect(exitLimitPrice('buy', { bid: 100, ask: 100.111 }, 1)).toBe(100.12);
  });

  it('aggressiveness < 1 rests inside the spread, rounded toward the passive side', () => {
    // sell mid: 100.13 - 0.5*(0.13) = 100.065 -> ceil -> 100.07 (higher = more passive)
    expect(exitLimitPrice('sell', { bid: 100, ask: 100.13 }, 0.5)).toBe(100.07);
    // buy mid: 100 + 0.5*(0.13) = 100.065 -> floor -> 100.06 (lower = more passive)
    expect(exitLimitPrice('buy', { bid: 100, ask: 100.13 }, 0.5)).toBe(100.06);
  });

  it('aggressiveness 0 is fully passive at the far side', () => {
    expect(exitLimitPrice('sell', { bid: 100, ask: 100.13 }, 0)).toBe(100.13);
    expect(exitLimitPrice('buy', { bid: 100, ask: 100.13 }, 0)).toBe(100);
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

  it('drops a crossed book (bid > ask, both sides present) as junk data', () => {
    const crossed = { ...q('2026-07-09T21:29:30Z'), bid: 10.05, ask: 10.0 };
    const r = partitionFreshQuotes([crossed], now, 120);
    expect(r.fresh).toHaveLength(0);
    expect(r.crossed).toBe(1);
    expect(r.stale).toBe(0);
  });

  it('keeps locked (bid == ask) and one-sided books — valid market states', () => {
    const locked = { ...q('2026-07-09T21:29:30Z'), bid: 10.0, ask: 10.0 };
    const oneSided = { ...q('2026-07-09T21:29:30Z'), bid: 10.0, ask: 0 };
    const r = partitionFreshQuotes([locked, oneSided], now, 120);
    expect(r.fresh).toHaveLength(2);
    expect(r.crossed).toBe(0);
  });
});

describe('peakEligibleMark (trailing-peak data-quality gate)', () => {
  const quote = { bid: 100, ask: 100.1, bidSize: 50, askSize: 500 };

  it('returns the side mark when the gate is off (minTopSize 0)', () => {
    expect(peakEligibleMark(quote, 'long', 0)).toBe(100);
    expect(peakEligibleMark(quote, 'short', 0)).toBe(100.1);
  });

  it('returns 0 when the displayed size behind the mark is below the floor', () => {
    // long marks at the bid: bidSize 50 < 100 -> not peak-eligible
    expect(peakEligibleMark(quote, 'long', 100)).toBe(0);
    // short marks at the ask: askSize 500 >= 100 -> eligible
    expect(peakEligibleMark(quote, 'short', 100)).toBe(100.1);
  });

  it('a zero-size mark side is never peak-eligible under a positive floor', () => {
    expect(peakEligibleMark({ bid: 100, ask: 100.1, bidSize: 0, askSize: 500 }, 'long', 1)).toBe(0);
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
