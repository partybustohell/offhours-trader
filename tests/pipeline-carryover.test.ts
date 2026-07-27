import { describe, expect, it } from 'vitest';
import { carryoverEntries } from '../src/pipeline.js';
import type { ThesisEntry } from '../src/types.js';

const entry = (ticker: string, over: Partial<ThesisEntry> = {}): ThesisEntry => ({
  ticker,
  direction: 'long',
  weightedConviction: 0.6,
  limitBand: { low: 97, high: 103 },
  targetNotionalUsd: 1000,
  narrative: `${ticker} thesis`,
  invalidationConditions: [],
  horizon: 'days',
  exit: { hardStopPct: 8, timeStopHours: 30 },
  ...over,
});

describe('carryoverEntries (same-day thesis refresh safety)', () => {
  it('carries a held ticker the refresh dropped, keeping its exit plan', () => {
    const previous = [entry('AAA', { exit: { hardStopPct: 4, invalidationPrice: 90, timeStopHours: 30 } })];
    const carried = carryoverEntries(previous, [entry('BBB')], new Set(['AAA']));
    expect(carried).toHaveLength(1);
    expect(carried[0]!.ticker).toBe('AAA');
    expect(carried[0]!.exit?.invalidationPrice).toBe(90); // original plan intact
  });

  it('does not duplicate a ticker the refresh re-emitted', () => {
    expect(carryoverEntries([entry('AAA')], [entry('AAA')], new Set(['AAA']))).toEqual([]);
  });

  it('does not carry tickers that are neither held nor ordered', () => {
    expect(carryoverEntries([entry('AAA')], [], new Set())).toEqual([]);
  });

  it('matches case-insensitively', () => {
    expect(carryoverEntries([entry('aaa')], [], new Set(['AAA']))).toHaveLength(1);
  });
});
