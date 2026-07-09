import { describe, expect, it } from 'vitest';
import { etOffsetForDate } from '../src/backtest/data.js';
import {
  TAF_CAP_USD,
  barSession,
  borrowAccrual,
  orderExpiryIso,
  sellFeesUsd,
  tryFill,
  type FillOrderSpec,
} from '../src/backtest/fills.js';
import type { StoredMinuteBar } from '../src/backtest/types.js';

// Fill-simulation unit tests (plan T4): strict cross vs touch, the 60s
// bar-open discipline, the session-scoped volume guard, order death at
// 20:00 ET, the date-keyed 2026 fee schedule, and borrow accrual. All bars
// are synthetic; nothing touches the network or disk beyond imports.

const D = '2026-03-10'; // Tuesday, EDT (DST began 2026-03-08)
const D1 = '2026-03-11';
const MAY = '2026-05-12'; // Tuesday, SEC-fee regime

const iso = (ymd: string, hms: string): string =>
  new Date(`${ymd}T${hms}${etOffsetForDate(ymd)}`).toISOString();

const bar = (ymd: string, hms: string, over: Partial<StoredMinuteBar> = {}): StoredMinuteBar => ({
  t: iso(ymd, hms),
  o: 100,
  h: 100,
  l: 100,
  c: 100,
  v: 1_000_000,
  ...over,
});

const buy = (qty: number, limitPrice: number): FillOrderSpec => ({ side: 'buy', qty, limitPrice });
const sell = (qty: number, limitPrice: number): FillOrderSpec => ({ side: 'sell', qty, limitPrice });

describe('cross vs touch', () => {
  it('BUY: a bar touching the limit exactly (low == L) does not fill', () => {
    expect(tryFill(buy(5, 100), [bar(D, '17:05:00', { l: 100 })], iso(D, '17:00:00'))).toBeNull();
  });

  it('BUY: a strict cross (low < L) fills at the crossing bar open, price = L, no fees', () => {
    const out = tryFill(buy(5, 100), [bar(D, '17:05:00', { l: 99.99 })], iso(D, '17:00:00'));
    expect(out).toEqual({ filled: true, atIso: iso(D, '17:05:00'), feesUsd: 0 });
  });

  it('SELL mirrored: high == L no fill; high > L fills with sell-side fees', () => {
    expect(tryFill(sell(5, 100), [bar(D, '17:05:00', { h: 100 })], iso(D, '17:00:00'))).toBeNull();
    const out = tryFill(sell(5, 100), [bar(D, '17:05:00', { h: 100.01 })], iso(D, '17:00:00'));
    expect(out?.atIso).toBe(iso(D, '17:05:00'));
    // March 2026: TAF only, 5 * $0.000195
    expect(out?.feesUsd).toBeCloseTo(0.000975, 12);
  });

  it('accepts unsorted bars and fills at the earliest eligible crossing bar', () => {
    const bars = [
      bar(D, '17:20:00', { l: 99 }),
      bar(D, '17:05:00', { l: 99 }),
      bar(D, '17:10:00', { l: 99 }),
    ];
    const out = tryFill(buy(5, 100), bars, iso(D, '17:00:00'));
    expect(out?.atIso).toBe(iso(D, '17:05:00'));
  });
});

describe('60s bar-open discipline (bars are timestamped at OPEN)', () => {
  it('a bar opening at the placement instant is not after placement', () => {
    expect(tryFill(buy(5, 100), [bar(D, '17:00:00', { l: 99 })], iso(D, '17:00:00'))).toBeNull();
  });

  it('a bar opening exactly placement+60s is after placement', () => {
    const out = tryFill(buy(5, 100), [bar(D, '17:01:00', { l: 99 })], iso(D, '17:00:00'));
    expect(out?.atIso).toBe(iso(D, '17:01:00'));
  });

  it('an order placed mid-bar cannot fill on the partially elapsed bar', () => {
    // placed 17:00:30 -> the 17:01:00 bar opened only 30s later: ineligible
    expect(tryFill(buy(5, 100), [bar(D, '17:01:00', { l: 99 })], iso(D, '17:00:30'))).toBeNull();
    // 17:01:30 is exactly +60s: eligible
    const out = tryFill(buy(5, 100), [bar(D, '17:01:30', { l: 99 })], iso(D, '17:00:30'));
    expect(out?.atIso).toBe(iso(D, '17:01:30'));
  });
});

describe('session-scoped volume guard (20x qty within the crossing bar session)', () => {
  // qty 10 -> the crossing bar's session must accumulate >= 200 shares
  const placed = iso(D, '15:40:00'); // RTH

  it('RTH volume does not satisfy an after-hours crossing bar', () => {
    const bars = [
      bar(D, '15:45:00', { l: 101, h: 102, v: 10_000 }), // RTH, no cross
      bar(D, '16:05:00', { l: 99, v: 150 }), // AH cross, AH cum 150 < 200
      bar(D, '16:10:00', { l: 99, v: 60 }), // AH cross, AH cum 210 >= 200
    ];
    const out = tryFill(buy(10, 100), bars, placed);
    expect(out?.atIso).toBe(iso(D, '16:10:00'));
  });

  it('a crossing bar in the same session as prior volume fills immediately', () => {
    const bars = [
      bar(D, '15:45:00', { l: 101, h: 102, v: 10_000 }), // RTH volume
      bar(D, '15:50:00', { l: 99, v: 50 }), // RTH cross, RTH cum 10_050
    ];
    const out = tryFill(buy(10, 100), bars, placed);
    expect(out?.atIso).toBe(iso(D, '15:50:00'));
  });

  it('a single crossing bar carrying exactly 20x qty fills; one share less never fills', () => {
    const at = iso(D, '17:00:00');
    expect(tryFill(buy(10, 100), [bar(D, '17:05:00', { l: 99, v: 200 })], at)?.atIso).toBe(
      iso(D, '17:05:00'),
    );
    expect(tryFill(buy(10, 100), [bar(D, '17:05:00', { l: 99, v: 199 })], at)).toBeNull();
  });

  it('sessions come from production currentSession on the bar open', () => {
    expect(barSession(iso(D, '07:30:00'))).toBe('premarket');
    expect(barSession(iso(D, '10:00:00'))).toBe('rth');
    expect(barSession(iso(D, '16:05:00'))).toBe('afterhours');
    expect(barSession(iso(D, '20:30:00'))).toBe('closed');
  });
});

describe('order lifetime: placement -> 20:00 ET of the submission day', () => {
  it('a crossing bar opening at 20:00 ET is past the order death', () => {
    expect(tryFill(buy(5, 100), [bar(D, '20:00:00', { l: 99 })], iso(D, '19:00:00'))).toBeNull();
  });

  it('the 19:59 bar still fills', () => {
    const out = tryFill(buy(5, 100), [bar(D, '19:59:00', { l: 99 })], iso(D, '19:00:00'));
    expect(out?.atIso).toBe(iso(D, '19:59:00'));
  });

  it('next-day bars never fill a previous-day order', () => {
    expect(tryFill(buy(5, 100), [bar(D1, '04:05:00', { l: 99 })], iso(D, '19:00:00'))).toBeNull();
  });

  it('a premarket order carries through RTH into after-hours', () => {
    const out = tryFill(buy(5, 100), [bar(D, '17:30:00', { l: 99 })], iso(D, '07:00:00'));
    expect(out?.atIso).toBe(iso(D, '17:30:00'));
  });

  it('orderExpiryIso resolves 20:00 ET on both EDT and EST dates', () => {
    expect(orderExpiryIso(iso(D, '19:00:00'))).toBe('2026-03-11T00:00:00.000Z'); // EDT
    expect(orderExpiryIso(iso('2026-01-15', '19:00:00'))).toBe('2026-01-16T01:00:00.000Z'); // EST
  });
});

describe('fee schedule, trade-date-keyed (March vs May 2026)', () => {
  it('March: TAF only', () => {
    expect(sellFeesUsd(1000, 50, '2026-03-10')).toBeCloseTo(0.195, 12);
  });

  it('May: TAF + SEC $20.60 per $1M notional', () => {
    // 1000 * 0.000195 + (50_000 / 1_000_000) * 20.60 = 0.195 + 1.03
    expect(sellFeesUsd(1000, 50, '2026-05-12')).toBeCloseTo(1.225, 12);
  });

  it('regime boundary: 2026-04-03 has no SEC fee, 2026-04-06 does', () => {
    expect(sellFeesUsd(1000, 50, '2026-04-03')).toBeCloseTo(0.195, 12);
    expect(sellFeesUsd(1000, 50, '2026-04-06')).toBeCloseTo(1.225, 12);
  });

  it('TAF caps at $9.79 per trade', () => {
    // 60_000 * 0.000195 = 11.70 -> capped
    expect(sellFeesUsd(60_000, 1, '2026-03-10')).toBeCloseTo(TAF_CAP_USD, 12);
  });

  it('a sell fill in May carries SEC fees keyed to the fill date', () => {
    const out = tryFill(
      sell(1000, 50),
      [bar(MAY, '17:05:00', { h: 50.5, v: 100_000 })],
      iso(MAY, '17:00:00'),
    );
    expect(out?.feesUsd).toBeCloseTo(1.225, 12);
  });
});

describe('borrow accrual (0.3%/yr default, ACT/365)', () => {
  it('one day on $10k short value', () => {
    expect(borrowAccrual(10_000, 1)).toBeCloseTo((10_000 * 0.003) / 365, 12);
  });

  it('uses absolute market value (short marks are negative)', () => {
    expect(borrowAccrual(-10_000, 1)).toBeCloseTo(borrowAccrual(10_000, 1), 12);
  });

  it('scales with days and an explicit rate', () => {
    expect(borrowAccrual(10_000, 2, 0.01)).toBeCloseTo((10_000 * 0.01 * 2) / 365, 12);
  });
});

describe('order shape invariants', () => {
  const bars = [bar(D, '17:05:00', { l: 99 })];
  it.each([
    ['fractional qty', { side: 'buy', qty: 1.5, limitPrice: 100 }],
    ['zero qty', { side: 'buy', qty: 0, limitPrice: 100 }],
    ['NaN limit', { side: 'buy', qty: 1, limitPrice: Number.NaN }],
    ['negative limit', { side: 'buy', qty: 1, limitPrice: -1 }],
    ['zero limit', { side: 'buy', qty: 1, limitPrice: 0 }],
  ] as [string, FillOrderSpec][])('%s throws', (_name, order) => {
    expect(() => tryFill(order, bars, iso(D, '17:00:00'))).toThrow(/invariant/);
  });
});

describe('marketable vs passive fills', () => {
  const placed = iso(D, '17:00:00');
  const buyP = (qty: number, limitPrice: number): FillOrderSpec => ({ side: 'buy', qty, limitPrice, marketable: false });
  const sellP = (qty: number, limitPrice: number): FillOrderSpec => ({ side: 'sell', qty, limitPrice, marketable: false });

  it('marketable (default) fills on a touch-through the passive order rejects', () => {
    const touch = [bar(D, '17:05:00', { l: 99.99 })]; // one cent through the 100 limit
    expect(tryFill(buy(5, 100), touch, placed)?.atIso).toBe(iso(D, '17:05:00')); // marketable fills
    expect(tryFill(buyP(5, 100), touch, placed)).toBeNull(); // passive needs a full tick through
  });

  it('passive fills once the market trades a full tick through', () => {
    expect(tryFill(buyP(5, 100), [bar(D, '17:05:00', { l: 99.98 })], placed)?.atIso).toBe(iso(D, '17:05:00'));
  });

  it('mirrors for passive sells: a tick above the limit is required', () => {
    expect(tryFill(sellP(5, 100), [bar(D, '17:05:00', { h: 100.01 })], placed)).toBeNull();
    expect(tryFill(sellP(5, 100), [bar(D, '17:05:00', { h: 100.02 })], placed)?.atIso).toBe(iso(D, '17:05:00'));
  });

  it('passive demands the heavier volume guard (40x vs 20x)', () => {
    // qty 10: marketable needs 200 shares, passive needs 400.
    const at399 = [bar(D, '17:05:00', { l: 99.98, v: 399 })];
    expect(tryFill(buy(10, 100), [bar(D, '17:05:00', { l: 99.98, v: 200 })], placed)?.atIso).toBe(iso(D, '17:05:00'));
    expect(tryFill(buyP(10, 100), at399, placed)).toBeNull(); // 399 < 400
    expect(tryFill(buyP(10, 100), [bar(D, '17:05:00', { l: 99.98, v: 400 })], placed)?.atIso).toBe(iso(D, '17:05:00'));
  });
});
