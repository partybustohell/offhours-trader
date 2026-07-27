import { describe, expect, it } from 'vitest';
import { earningsWithin, isReportPast, parseNasdaqRows, ymdRange, type EarningsByDate } from '../src/broker/earnings.js';

describe('parseNasdaqRows', () => {
  it('maps the Nasdaq shape and normalizes report timing', () => {
    const rows = parseNasdaqRows({
      data: {
        rows: [
          { symbol: 'msft', name: 'Microsoft Corporation', time: 'time-after-hours' },
          { symbol: 'KO', name: 'Coca-Cola', time: 'time-pre-market' },
          { symbol: 'XYZ', name: 'Mystery Co', time: 'time-not-supplied' },
        ],
      },
    });
    expect(rows).toEqual([
      { symbol: 'MSFT', name: 'Microsoft Corporation', time: 'post' },
      { symbol: 'KO', name: 'Coca-Cola', time: 'pre' },
      { symbol: 'XYZ', name: 'Mystery Co', time: 'unknown' },
    ]);
  });

  it('drops malformed rows and unknown shapes without throwing', () => {
    expect(parseNasdaqRows(null)).toEqual([]);
    expect(parseNasdaqRows({ data: { rows: 'nope' } })).toEqual([]);
    expect(
      parseNasdaqRows({ data: { rows: [{ symbol: 42 }, { symbol: 'not a ticker!!' }, {}] } }),
    ).toEqual([]);
  });
});

describe('earningsWithin', () => {
  const days: EarningsByDate = {
    '2026-07-27': [{ symbol: 'AAA', name: 'A', time: 'post' }],
    '2026-07-29': [{ symbol: 'BBB', name: 'B', time: 'pre' }],
  };
  const ymds = ['2026-07-27', '2026-07-28', '2026-07-29'];

  it('finds a report inside the window', () => {
    expect(earningsWithin(days, 'aaa', ymds, 2)).toEqual({ ymd: '2026-07-27', time: 'post' });
    expect(earningsWithin(days, 'BBB', ymds, 2)).toEqual({ ymd: '2026-07-29', time: 'pre' });
  });

  it('respects the day bound and fails open on absent dates', () => {
    expect(earningsWithin(days, 'BBB', ymds, 1)).toBeNull(); // reports on day 2, window is 1
    expect(earningsWithin(days, 'CCC', ymds, 2)).toBeNull(); // never reports
    expect(earningsWithin({}, 'AAA', ymds, 2)).toBeNull(); // degraded calendar -> admit
  });
});

describe('isReportPast (post-print reaction entries must not be blocked)', () => {
  const today = '2026-07-27';

  it('future days always block; past days never do', () => {
    expect(isReportPast({ ymd: '2026-07-28', time: 'pre' }, today, 1200)).toBe(false);
    expect(isReportPast({ ymd: '2026-07-26', time: 'unknown' }, today, 0)).toBe(true);
  });

  it("today's post-close print is past from 16:30 ET, not before", () => {
    expect(isReportPast({ ymd: today, time: 'post' }, today, 989)).toBe(false); // 16:29
    expect(isReportPast({ ymd: today, time: 'post' }, today, 990)).toBe(true); // 16:30
    expect(isReportPast({ ymd: today, time: 'post' }, today, 540)).toBe(false); // 09:00 premarket: still ahead
  });

  it("today's pre-open print is past from the open; unknown timing blocks all day", () => {
    expect(isReportPast({ ymd: today, time: 'pre' }, today, 569)).toBe(false);
    expect(isReportPast({ ymd: today, time: 'pre' }, today, 570)).toBe(true);
    expect(isReportPast({ ymd: today, time: 'unknown' }, today, 1199)).toBe(false);
  });
});

describe('ymdRange', () => {
  it('produces ET calendar dates from today forward', () => {
    // 2026-07-27T23:30Z = 19:30 ET on the 27th (EDT) — the UTC date has
    // already rolled to the 28th; ET must not.
    const range = ymdRange(new Date('2026-07-27T23:30:00Z'), 2);
    expect(range).toEqual(['2026-07-27', '2026-07-28', '2026-07-29']);
  });
});
