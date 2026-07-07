import { describe, expect, it } from 'vitest';
import { buildCandidates, type TickerMarketInfo } from '../src/candidates.js';
import { ConfigSchema, type Config } from '../src/config.js';
import type { AnalystNominations } from '../src/types.js';

const DATE = '2026-07-07';

function cfg(overrides: Record<string, unknown> = {}): Config {
  return ConfigSchema.parse(overrides);
}

function noms(entries: [AnalystNominations['analyst'], string, string?][]): AnalystNominations[] {
  const byAnalyst = new Map<AnalystNominations['analyst'], AnalystNominations>();
  for (const [analyst, ticker, reason] of entries) {
    const an = byAnalyst.get(analyst) ?? { analyst, nominations: [] };
    an.nominations.push({ ticker, reason: reason ?? `${analyst} likes ${ticker}` });
    byAnalyst.set(analyst, an);
  }
  return [...byAnalyst.values()];
}

function info(entries: [string, number, number][]): Map<string, TickerMarketInfo> {
  return new Map(
    entries.map(([t, lastPrice, avgDollarVolume20d]) => [t, { lastPrice, avgDollarVolume20d }]),
  );
}

const LIQUID = 50_000_000; // above default min_avg_dollar_volume

describe('buildCandidates', () => {
  it('uppercases tickers and unions nominations across analysts', () => {
    const file = buildCandidates(
      noms([
        ['fundamental', 'nvda', 'cheap'],
        ['sentiment', 'NVDA', 'buzz'],
      ]),
      info([['NVDA', 100, LIQUID]]),
      cfg(),
      DATE,
    );
    expect(file.date).toBe(DATE);
    expect(file.candidates).toHaveLength(1);
    const c = file.candidates[0]!;
    expect(c.ticker).toBe('NVDA');
    expect(c.nominatedBy).toEqual([
      { analyst: 'fundamental', reason: 'cheap' },
      { analyst: 'sentiment', reason: 'buzz' },
    ]);
    expect(c.lastPrice).toBe(100);
    expect(c.avgDollarVolume20d).toBe(LIQUID);
    expect(file.rejected).toEqual([]);
  });

  it('rejects excluded tickers case-insensitively', () => {
    const file = buildCandidates(
      noms([['macro', 'tsla']]),
      info([['TSLA', 200, LIQUID]]),
      cfg({ universe: { exclude: ['tsLa'] } }),
      DATE,
    );
    expect(file.candidates).toEqual([]);
    expect(file.rejected).toEqual([{ ticker: 'TSLA', reason: 'on exclude list' }]);
  });

  it('rejects tickers with no market data', () => {
    const file = buildCandidates(noms([['bear', 'GHOST']]), info([]), cfg(), DATE);
    expect(file.candidates).toEqual([]);
    expect(file.rejected).toEqual([{ ticker: 'GHOST', reason: 'no market data' }]);
  });

  it('rejects tickers below min_price', () => {
    const file = buildCandidates(
      noms([['technical', 'PENY']]),
      info([['PENY', 4.99, LIQUID]]),
      cfg(),
      DATE,
    );
    expect(file.candidates).toEqual([]);
    expect(file.rejected).toEqual([{ ticker: 'PENY', reason: 'price below min_price' }]);
  });

  it('rejects tickers below min_avg_dollar_volume', () => {
    const file = buildCandidates(
      noms([['technical', 'THIN']]),
      info([['THIN', 50, 19_999_999]]),
      cfg(),
      DATE,
    );
    expect(file.candidates).toEqual([]);
    expect(file.rejected).toEqual([
      { ticker: 'THIN', reason: 'dollar volume below min_avg_dollar_volume' },
    ]);
  });

  it('keeps tickers exactly at the price and volume minimums', () => {
    const file = buildCandidates(
      noms([['fundamental', 'EDGE']]),
      info([['EDGE', 5, 20_000_000]]),
      cfg(),
      DATE,
    );
    expect(file.candidates.map((c) => c.ticker)).toEqual(['EDGE']);
    expect(file.rejected).toEqual([]);
  });

  it('ranks by nomination count then avg dollar volume and caps at max_candidates', () => {
    const file = buildCandidates(
      noms([
        ['fundamental', 'AAA'],
        ['sentiment', 'AAA'],
        ['fundamental', 'BBB'],
        ['technical', 'CCC'],
        ['macro', 'DDD'],
      ]),
      info([
        ['AAA', 10, 30_000_000], // 2 nominations -> first despite lowest volume
        ['BBB', 10, 90_000_000],
        ['CCC', 10, 60_000_000],
        ['DDD', 10, 40_000_000],
      ]),
      cfg({ universe: { max_candidates: 3 } }),
      DATE,
    );
    expect(file.candidates.map((c) => c.ticker)).toEqual(['AAA', 'BBB', 'CCC']);
    expect(file.rejected).toEqual([{ ticker: 'DDD', reason: 'over max_candidates cap' }]);
  });

  it('accumulates filter rejections alongside cap rejections', () => {
    const file = buildCandidates(
      noms([
        ['fundamental', 'GOOD'],
        ['fundamental', 'GHOST'],
        ['sentiment', 'PENY'],
      ]),
      info([
        ['GOOD', 100, LIQUID],
        ['PENY', 1, LIQUID],
      ]),
      cfg(),
      DATE,
    );
    expect(file.candidates.map((c) => c.ticker)).toEqual(['GOOD']);
    expect(file.rejected).toEqual([
      { ticker: 'GHOST', reason: 'no market data' },
      { ticker: 'PENY', reason: 'price below min_price' },
    ]);
  });
});
