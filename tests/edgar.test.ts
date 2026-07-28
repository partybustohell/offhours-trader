import { describe, expect, it } from 'vitest';
import {
  filingDocUrl,
  parseCikMap,
  pickLatestFiling,
  pickPressReleaseDoc,
  type RecentFilings,
} from '../src/broker/edgar.js';

describe('parseCikMap', () => {
  it('maps company_tickers.json rows to uppercase ticker -> zero-padded CIK', () => {
    const map = parseCikMap({
      '0': { cik_str: 320193, ticker: 'aapl', title: 'Apple Inc.' },
      '1': { cik_str: 1045810, ticker: 'NVDA', title: 'NVIDIA CORP' },
    });
    expect(map).toEqual({ AAPL: '0000320193', NVDA: '0001045810' });
  });

  it('drops malformed rows and unknown shapes without throwing', () => {
    expect(parseCikMap(null)).toEqual({});
    expect(parseCikMap('nope')).toEqual({});
    expect(parseCikMap({ '0': { cik_str: 'not-a-number', ticker: 'X' }, '1': {} })).toEqual({});
  });
});

describe('pickLatestFiling', () => {
  const recent: RecentFilings = {
    form: ['4', '8-K', '10-Q', '8-K'],
    filingDate: ['2026-07-28', '2026-07-27', '2026-07-20', '2026-07-15'],
    accessionNumber: ['a-1', 'a-2', 'a-3', 'a-4'],
    primaryDocument: ['form4.xml', 'body.htm', 'q.htm', 'old.htm'],
  };

  it('returns the newest in-window 8-K, skipping other forms', () => {
    expect(pickLatestFiling(recent, ['8-K', '8-K/A'], '2026-07-26')).toEqual({
      form: '8-K',
      filed: '2026-07-27',
      accession: 'a-2',
      primaryDocument: 'body.htm',
    });
  });

  it('stops at the lookback boundary — an old 8-K is not a catalyst', () => {
    expect(pickLatestFiling(recent, ['8-K'], '2026-07-28')).toBeNull();
  });

  it('tolerates missing or malformed column arrays', () => {
    expect(pickLatestFiling(undefined, ['8-K'], '2026-07-01')).toBeNull();
    expect(pickLatestFiling({ form: ['8-K'] }, ['8-K'], '2026-07-01')).toBeNull();
  });
});

describe('pickPressReleaseDoc', () => {
  it('prefers the EX-99 press-release exhibit over the 8-K body', () => {
    const items = [
      { name: 'body.htm' },
      { name: 'ex99_1pressrelease.htm' },
      { name: 'ex10-2agreement.htm' },
    ];
    expect(pickPressReleaseDoc(items, 'body.htm')).toBe('ex99_1pressrelease.htm');
  });

  it('falls back to the primary document when no exhibit matches', () => {
    expect(pickPressReleaseDoc([{ name: 'body.htm' }, { name: 'graphic.jpg' }], 'body.htm')).toBe(
      'body.htm',
    );
    expect(pickPressReleaseDoc([], 'body.htm')).toBe('body.htm');
    expect(pickPressReleaseDoc([{ name: 42 }], 'body.htm')).toBe('body.htm');
  });

  it('ignores an EX-99 that is not an html document (e.g. a graphic)', () => {
    expect(pickPressReleaseDoc([{ name: 'ex99_1chart.jpg' }], 'body.htm')).toBe('body.htm');
  });
});

describe('filingDocUrl', () => {
  it('builds the archives URL with unpadded CIK and dash-less accession', () => {
    expect(filingDocUrl('0001045810', '0001045810-26-000123', 'ex99_1.htm')).toBe(
      'https://www.sec.gov/Archives/edgar/data/1045810/000104581026000123/ex99_1.htm',
    );
  });
});
