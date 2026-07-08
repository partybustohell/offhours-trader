import { describe, expect, it } from 'vitest';
import type { StoredDailyBar, StoredNewsItem } from '../src/backtest/types.js';
import {
  barsSummaryFrom,
  dispersionScoreFrom,
  marketInfoFrom,
  mostActivesFrom,
  moversFrom,
  mulberry32,
  newsFrom,
  sampleEpisodes,
  uncappedNewsFrom,
} from '../src/backtest/scans.js';

// Pure-function tests: hand-built fixtures only, no backtest-data/ store, no
// network. Bar timestamps follow the Alpaca convention (ET midnight open in
// UTC, so t.slice(0,10) is the calendar day).

const D = '2026-01-15'; // a Thursday; EST, so 17:00 ET = 22:00Z
const PREV = '2026-01-14';

function bar(day: string, c: number, v: number, partial: Partial<StoredDailyBar> = {}): StoredDailyBar {
  return { t: `${day}T05:00:00Z`, o: c, h: c + 1, l: c - 1, c, v, ...partial };
}

/** Two-bar series: prev close, then day-D close at `pct` percent change. */
function pair(prevClose: number, pct: number, v = 1_000_000): StoredDailyBar[] {
  const dayClose = Math.round(prevClose * (1 + pct / 100) * 100) / 100;
  return [bar(PREV, prevClose, v), bar(D, dayClose, v)];
}

function news(created_at: string, headline = `h-${created_at}`): StoredNewsItem {
  return { headline, summary: `s ${headline}`, symbols: ['AAPL'], created_at, source: 'src' };
}

// ---------- moversFrom ----------

describe('moversFrom', () => {
  it('computes day-over-day SIP close change with production Movers shape', () => {
    const bars = new Map<string, StoredDailyBar[]>([
      ['UP', pair(100, 10)],
      ['DOWN', pair(50, -4)],
      ['FLAT', pair(20, 0)],
    ]);
    const { gainers, losers } = moversFrom(bars, D);
    expect(gainers[0]).toEqual({ symbol: 'UP', percent_change: 10, price: 110 });
    expect(losers[0]).toEqual({ symbol: 'DOWN', percent_change: -4, price: 48 });
    expect(gainers.map((g) => g.symbol)).toEqual(['UP', 'FLAT', 'DOWN']);
    expect(losers.map((l) => l.symbol)).toEqual(['DOWN', 'FLAT', 'UP']);
  });

  it('caps at top 20 gainers and 20 losers over the whole universe', () => {
    const bars = new Map<string, StoredDailyBar[]>();
    for (let k = 1; k <= 25; k++) {
      bars.set(`G${String(k).padStart(2, '0')}`, pair(100, k));
      bars.set(`L${String(k).padStart(2, '0')}`, pair(100, -k));
    }
    const { gainers, losers } = moversFrom(bars, D);
    expect(gainers).toHaveLength(20);
    expect(losers).toHaveLength(20);
    expect(gainers[0]!.symbol).toBe('G25');
    expect(gainers[19]!.symbol).toBe('G06'); // +25..+6 kept, +5..+1 cut
    expect(losers[0]!.symbol).toBe('L25');
    expect(losers[19]!.symbol).toBe('L06');
  });

  it('applies no price or volume floors (penny stock on tiny volume ranks)', () => {
    const bars = new Map<string, StoredDailyBar[]>([
      ['PENNY', [bar(PREV, 0.25, 10), bar(D, 0.5, 10)]],
      ['BIG', pair(500, 3, 50_000_000)],
    ]);
    const { gainers } = moversFrom(bars, D);
    expect(gainers[0]).toEqual({ symbol: 'PENNY', percent_change: 100, price: 0.5 });
  });

  it('excludes symbols without a day-D bar, without a prior bar, or with a non-positive prior close', () => {
    const bars = new Map<string, StoredDailyBar[]>([
      ['NOBAR', [bar('2026-01-13', 100, 1000), bar(PREV, 105, 1000)]],
      ['ONLYD', [bar(D, 100, 1000)]],
      ['ZEROPREV', [bar(PREV, 0, 1000), bar(D, 5, 1000)]],
      ['OK', pair(100, 1)],
    ]);
    const { gainers, losers } = moversFrom(bars, D);
    expect(gainers.map((g) => g.symbol)).toEqual(['OK']);
    expect(losers.map((l) => l.symbol)).toEqual(['OK']);
  });

  it('ignores bars after D (as-of semantics)', () => {
    const bars = new Map<string, StoredDailyBar[]>([
      ['A', [...pair(100, 5), bar('2026-01-16', 1, 1)]],
    ]);
    expect(moversFrom(bars, D).gainers[0]).toEqual({ symbol: 'A', percent_change: 5, price: 105 });
  });

  it('breaks rounded-percent ties by symbol ascending', () => {
    const bars = new Map<string, StoredDailyBar[]>([
      // both round to +7.00; unrounded ZAAA (7.0041) > AZZZ (6.9963)
      ['ZAAA', [bar(PREV, 100, 1000), bar(D, 107.0041, 1000)]],
      ['AZZZ', [bar(PREV, 100, 1000), bar(D, 106.9963, 1000)]],
    ]);
    const { gainers } = moversFrom(bars, D);
    expect(gainers.map((g) => g.symbol)).toEqual(['AZZZ', 'ZAAA']);
    expect(gainers[0]!.percent_change).toBe(7);
    expect(gainers[1]!.percent_change).toBe(7);
  });
});

// ---------- mostActivesFrom ----------

describe('mostActivesFrom', () => {
  it('returns top 30 by day-D SIP share volume, {symbol, volume} shape, no floors', () => {
    const bars = new Map<string, StoredDailyBar[]>();
    for (let k = 1; k <= 35; k++) {
      bars.set(`S${String(k).padStart(2, '0')}`, [bar(D, 0.1, k * 100)]);
    }
    const actives = mostActivesFrom(bars, D);
    expect(actives).toHaveLength(30);
    expect(actives[0]).toEqual({ symbol: 'S35', volume: 3500 });
    expect(actives[29]).toEqual({ symbol: 'S06', volume: 600 });
    expect(Object.keys(actives[0]!).sort()).toEqual(['symbol', 'volume']);
  });

  it('excludes symbols without a day-D bar and breaks volume ties by symbol', () => {
    const bars = new Map<string, StoredDailyBar[]>([
      ['STALE', [bar(PREV, 10, 9_999_999)]],
      ['BBB', [bar(D, 10, 500)]],
      ['AAA', [bar(D, 10, 500)]],
    ]);
    expect(mostActivesFrom(bars, D)).toEqual([
      { symbol: 'AAA', volume: 500 },
      { symbol: 'BBB', volume: 500 },
    ]);
  });
});

// ---------- newsFrom ----------

describe('newsFrom', () => {
  it('caps at the 50 most recent items, newest first', () => {
    // 60 eligible items, minute-spaced before the cutoff
    const items: StoredNewsItem[] = [];
    for (let i = 0; i < 60; i++) {
      const minute = String(i).padStart(2, '0');
      items.push(news(`${D}T20:${minute}:00Z`, `item-${minute}`));
    }
    const out = newsFrom(items, D);
    expect(out).toHaveLength(50);
    expect(out[0]!.headline).toBe('item-59');
    expect(out[49]!.headline).toBe('item-10');
    const times = out.map((n) => Date.parse(n.created_at));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it('includes created_at exactly at D 17:00 ET and excludes one second after', () => {
    const items = [
      news(`${D}T22:00:00Z`, 'at-boundary'), // 17:00:00 EST exactly
      news(`${D}T22:00:01Z`, 'past-boundary'),
      news(`${D}T21:59:59Z`, 'before-boundary'),
    ];
    const out = newsFrom(items, D);
    expect(out.map((n) => n.headline)).toEqual(['at-boundary', 'before-boundary']);
  });

  it('uses the EDT offset after the March DST switch', () => {
    const dst = '2026-03-16'; // EDT: 17:00 ET = 21:00Z
    const out = newsFrom(
      [news(`${dst}T21:00:00Z`, 'edt-boundary'), news(`${dst}T21:00:01Z`, 'edt-past')],
      dst,
    );
    expect(out.map((n) => n.headline)).toEqual(['edt-boundary']);
  });

  it('maps to the production NewsItem shape and breaks timestamp ties by headline', () => {
    const t = `${D}T15:00:00Z`;
    const out = newsFrom([news(t, 'bbb'), news(t, 'aaa')], D);
    expect(out.map((n) => n.headline)).toEqual(['aaa', 'bbb']);
    expect(out[0]).toEqual({
      headline: 'aaa',
      summary: 's aaa',
      symbols: ['AAPL'],
      created_at: t,
      source: 'src',
    });
  });
});

// ---------- uncappedNewsFrom ----------

describe('uncappedNewsFrom', () => {
  it('returns the (D-1 17:00, D 17:00] ET slice: lower bound exclusive, upper inclusive', () => {
    const items = [
      news(`${PREV}T22:00:00Z`, 'at-lower'), // D-1 17:00 EST exactly -> excluded
      news(`${PREV}T22:00:01Z`, 'past-lower'), // included
      news(`${D}T22:00:00Z`, 'at-upper'), // D 17:00 EST exactly -> included
      news(`${D}T22:00:01Z`, 'past-upper'), // excluded
      news(`${PREV}T10:00:00Z`, 'old'), // excluded
    ];
    const out = uncappedNewsFrom(items, D);
    expect(out.map((n) => n.headline)).toEqual(['at-upper', 'past-lower']);
  });

  it('does not cap at 50', () => {
    const items: StoredNewsItem[] = [];
    for (let i = 0; i < 55; i++) {
      items.push(news(`${D}T12:${String(i).padStart(2, '0')}:00Z`, `n-${i}`));
    }
    expect(uncappedNewsFrom(items, D)).toHaveLength(55);
  });
});

// ---------- barsSummaryFrom ----------

describe('barsSummaryFrom', () => {
  function series(days: number, start: string): StoredDailyBar[] {
    // consecutive calendar dates from `start`
    const out: StoredDailyBar[] = [];
    const t0 = Date.parse(`${start}T00:00:00Z`);
    for (let i = 0; i < days; i++) {
      out.push(bar(new Date(t0 + i * 86_400_000).toISOString().slice(0, 10), 100, 1000));
    }
    return out;
  }

  it('renders the full deterministic template from a 30-bar fixture', () => {
    const bars = series(30, '2026-02-01'); // 2026-02-01 .. 2026-03-02, closes 100
    // last three closes 101, 102, 103 (3-day up streak); last volume doubles
    for (const [i, c] of [
      [27, 101],
      [28, 102],
      [29, 103],
    ] as const) {
      bars[i] = bar(bars[i]!.t.slice(0, 10), c, i === 29 ? 2000 : 1000);
    }
    expect(barsSummaryFrom(bars, 'ACME', '2026-03-02')).toBe(
      'ACME as of 2026-03-02: close 103 (25 bars). 5d +3%, 20d +3%. ' +
        '30-bar range 99-104; close at 80% of range. Volume 2x vs 20d avg. 3-day up streak.',
    );
  });

  it('degrades to n/a on short history and reports down streaks', () => {
    const bars = [bar('2026-01-12', 100, 500), bar('2026-01-13', 99, 500), bar(PREV, 98, 500)];
    expect(barsSummaryFrom(bars, 'SHRT', PREV)).toBe(
      'SHRT as of 2026-01-14: close 98 (3 bars). 5d n/a, 20d n/a. ' +
        '3-bar range 97-101; close at 25% of range. Volume 1x vs 20d avg. 2-day down streak.',
    );
  });

  it('ignores bars after D', () => {
    const bars = [bar('2026-01-12', 100, 500), bar('2026-01-13', 99, 500), bar(PREV, 98, 500)];
    const withFuture = [...bars, bar('2026-02-01', 500, 9_999_999)];
    expect(barsSummaryFrom(withFuture, 'SHRT', PREV)).toBe(barsSummaryFrom(bars, 'SHRT', PREV));
  });

  it('handles zero bars and flat closes', () => {
    expect(barsSummaryFrom([], 'NONE', D)).toBe('NONE as of 2026-01-15: no daily bars.');
    const flat = [bar('2026-01-13', 100, 500), bar(PREV, 100, 500), bar(D, 100, 500)];
    expect(barsSummaryFrom(flat, 'FLAT', D)).toContain('No close streak.');
  });
});

// ---------- marketInfoFrom ----------

describe('marketInfoFrom', () => {
  it('mirrors production math: lastPrice = last close, ADV = mean(c*v) over last 20 bars', () => {
    // 22 bars: the first two are huge and must fall outside the 20-bar slice
    const bars: StoredDailyBar[] = [
      bar('2025-12-01', 10_000, 10_000),
      bar('2025-12-02', 10_000, 10_000),
    ];
    const t0 = Date.parse('2025-12-03T00:00:00Z');
    for (let i = 0; i < 20; i++) {
      const day = new Date(t0 + i * 86_400_000).toISOString().slice(0, 10);
      bars.push(bar(day, 10, 100)); // c*v = 1000 each
    }
    const out = marketInfoFrom(new Map([['SYM', bars]]), '2026-01-15');
    expect(out.get('SYM')).toEqual({ lastPrice: 10, avgDollarVolume20d: 1000 });
  });

  it('averages over fewer than 20 bars when history is short', () => {
    const bars = [bar('2026-01-12', 10, 100), bar('2026-01-13', 20, 100)]; // 1000, 2000
    const out = marketInfoFrom(new Map([['SHRT', bars]]), D);
    expect(out.get('SHRT')).toEqual({ lastPrice: 20, avgDollarVolume20d: 1500 });
  });

  it('omits symbols with no bars as of D and ignores future bars', () => {
    const out = marketInfoFrom(
      new Map([
        ['EMPTY', []],
        ['FUTURE', [bar('2026-02-01', 10, 100)]],
        ['OK', [bar(PREV, 10, 100), bar('2026-02-01', 999, 999)]],
      ]),
      D,
    );
    expect(out.has('EMPTY')).toBe(false);
    expect(out.has('FUTURE')).toBe(false);
    expect(out.get('OK')).toEqual({ lastPrice: 10, avgDollarVolume20d: 1000 });
  });
});

// ---------- dispersionScoreFrom ----------

describe('dispersionScoreFrom', () => {
  it('counts symbols with |move| >= 5% and 20d ADV >= $20M only', () => {
    const bars = new Map<string, StoredDailyBar[]>([
      ['BIGUP', pair(100, 6, 250_000)], // ADV ~25.75M, +6% -> counts
      ['BIGDN', pair(100, -7, 250_000)], // ADV ~24.775M, |−7|% -> counts
      ['ATCUT', pair(100, 5, 250_000)], // exactly 5% -> counts (inclusive)
      ['THIN', pair(100, 6, 50_000)], // ADV ~5.15M -> volume fails
      ['QUIET', pair(100, 3, 2_500_000)], // ADV big, move small -> fails
      ['BELOW', pair(100, -4.9, 250_000)], // |move| < 5 -> fails
      ['NOBAR', [bar(PREV, 100, 250_000)]], // no day-D bar -> skipped
    ]);
    expect(dispersionScoreFrom(bars, D)).toBe(3);
  });

  it('is zero on an empty universe', () => {
    expect(dispersionScoreFrom(new Map(), D)).toBe(0);
  });
});

// ---------- mulberry32 + sampleEpisodes ----------

describe('mulberry32', () => {
  it('is deterministic per seed and emits values in [0, 1)', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const seqA = Array.from({ length: 10 }, () => a());
    const seqB = Array.from({ length: 10 }, () => b());
    expect(seqA).toEqual(seqB);
    for (const v of seqA) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
    const c = mulberry32(43);
    expect(Array.from({ length: 10 }, () => c())).not.toEqual(seqA);
  });
});

describe('sampleEpisodes', () => {
  // 124 synthetic trading days with a known dispersion ramp
  const tradingDays = Array.from({ length: 124 }, (_, i) => {
    const t0 = Date.parse('2026-01-02T00:00:00Z');
    return new Date(t0 + i * 86_400_000).toISOString().slice(0, 10);
  });
  const dispersionByDay = new Map(tradingDays.map((d, i) => [d, i])); // later days more dispersed

  it('is fully deterministic for a given seed and differs across seeds', () => {
    const a = sampleEpisodes(tradingDays, dispersionByDay, 7);
    const b = sampleEpisodes(tradingDays, dispersionByDay, 7);
    expect(a).toEqual(b);
    const c = sampleEpisodes(tradingDays, dispersionByDay, 8);
    expect(c.episodes.map((e) => e.day)).not.toEqual(a.episodes.map((e) => e.day));
  });

  it('draws 30 unique R days then the top 20 dispersion days not in R as H', () => {
    const sample = sampleEpisodes(tradingDays, dispersionByDay, 7);
    const r = sample.episodes.filter((e) => e.stratum === 'R');
    const h = sample.episodes.filter((e) => e.stratum === 'H');
    expect(r).toHaveLength(30);
    expect(h).toHaveLength(20);
    expect(new Set(sample.episodes.map((e) => e.day)).size).toBe(50);

    // H must be exactly the 20 highest-dispersion days outside R
    const rSet = new Set(r.map((e) => e.day));
    const expectedH = tradingDays
      .filter((d) => !rSet.has(d))
      .sort((a, b) => dispersionByDay.get(b)! - dispersionByDay.get(a)! || a.localeCompare(b))
      .slice(0, 20);
    expect(h.map((e) => e.day)).toEqual(expectedH);
    for (const e of sample.episodes) {
      expect(e.dispersionScore).toBe(dispersionByDay.get(e.day));
    }
  });

  it('persists within-stratum drop priority: R in draw order, H in dispersion rank', () => {
    const sample = sampleEpisodes(tradingDays, dispersionByDay, 7);
    const r = sample.episodes.filter((e) => e.stratum === 'R');
    const h = sample.episodes.filter((e) => e.stratum === 'H');
    expect(r.map((e) => e.priority)).toEqual(Array.from({ length: 30 }, (_, i) => i));
    expect(h.map((e) => e.priority)).toEqual(Array.from({ length: 20 }, (_, i) => i));
    // episodes array is R block (priority asc) then H block (priority asc)
    expect(sample.episodes.slice(0, 30)).toEqual(r);
    expect(sample.episodes.slice(30)).toEqual(h);
    // H block descends in dispersion
    const hScores = h.map((e) => e.dispersionScore);
    expect([...hScores].sort((a, b) => b - a)).toEqual(hScores);
    // drop rule (first 24 R + first 16 H) is a plain prefix within each stratum
    const kept = [...r.slice(0, 24), ...h.slice(0, 16)];
    expect(kept.every((e) => e.priority < (e.stratum === 'R' ? 24 : 16))).toBe(true);
  });

  it('records the seed and the plan window', () => {
    const sample = sampleEpisodes(tradingDays, dispersionByDay, 99);
    expect(sample.seed).toBe(99);
    expect(sample.window).toEqual({ start: '2026-01-01', end: '2026-07-01' });
  });

  it('handles fewer trading days than the R target', () => {
    const few = tradingDays.slice(0, 10);
    const sample = sampleEpisodes(few, dispersionByDay, 7);
    expect(sample.episodes.filter((e) => e.stratum === 'R')).toHaveLength(10);
    expect(sample.episodes.filter((e) => e.stratum === 'H')).toHaveLength(0);
  });
});
