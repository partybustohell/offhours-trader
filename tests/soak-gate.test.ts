import { describe, expect, it } from 'vitest';
import {
  bucketTrades,
  calibrationCadence,
  judgeRemovalVerdict,
  signalGateVerdict,
  type GateBuckets,
  type TripForGate,
} from '../src/soak-gate.js';

const trip = (ticker: string, openedAt: string, returnPct: number): TripForGate => ({
  ticker,
  openedAt,
  returnPct,
});

describe('bucketTrades', () => {
  it('splits by the shadow lookup and excludes unmatched trades', () => {
    const shadow = new Map([
      ['AAA|2026-08-01', true],
      ['BBB|2026-08-01', false],
    ]);
    const buckets = bucketTrades(
      [
        trip('AAA', '2026-08-01T14:00:00Z', -2),
        trip('BBB', '2026-08-01T14:00:00Z', 3),
        trip('CCC', '2026-08-01T14:00:00Z', 9), // no shadow record
      ],
      () => ['2026-08-01'],
      (ticker, ymds) => shadow.get(`${ticker}|${ymds[0]}`),
    );
    expect(buckets.flagged).toEqual([-2]);
    expect(buckets.unflagged).toEqual([3]);
    expect(buckets.unmatched).toBe(1);
  });
});

describe('signalGateVerdict (rules 2 and 3 as concretized)', () => {
  const buckets = (flagged: number[], unflagged: number[]): GateBuckets => ({
    flagged,
    unflagged,
    unmatched: 0,
  });

  it('WAITs below the sample floors', () => {
    expect(signalGateVerdict(buckets([-1], [1])).status).toBe('WAIT');
    // 50 total but flagged bucket below the 10-per-bucket floor
    expect(
      signalGateVerdict(buckets(Array(5).fill(-1), Array(45).fill(1))).status,
    ).toBe('WAIT');
  });

  it('ENABLEs when the flagged bucket underperforms with full sample', () => {
    const v = signalGateVerdict(buckets(Array(20).fill(-1.5), Array(30).fill(0.8)));
    expect(v.status).toBe('ENABLE');
    expect(v.flaggedMeanPct).toBe(-1.5);
    expect(v.unflaggedMeanPct).toBe(0.8);
  });

  it('KILLs when the flagged bucket outperforms (the signal would cut winners)', () => {
    expect(
      signalGateVerdict(buckets(Array(20).fill(2), Array(30).fill(0.5))).status,
    ).toBe('KILL');
  });
});

describe('calibrationCadence (rule 4)', () => {
  it('blocks below min trades regardless of cadence', () => {
    expect(calibrationCadence(null, '2026-10-01', 30, 50).eligible).toBe(false);
  });
  it('eligible when sample met and never applied', () => {
    expect(calibrationCadence(null, '2026-10-01', 60, 50).eligible).toBe(true);
  });
  it('enforces the 90-day cadence after an application', () => {
    const blocked = calibrationCadence('2026-09-01', '2026-10-01', 60, 50);
    expect(blocked.eligible).toBe(false);
    expect(blocked.nextAllowedYmd).toBe('2026-11-30');
    expect(calibrationCadence('2026-09-01', '2026-11-30', 60, 50).eligible).toBe(true);
  });
});

describe('judgeRemovalVerdict (rule 5)', () => {
  it('WAITs below 30 scored vetoes', () => {
    expect(judgeRemovalVerdict(10, 0.1).status).toBe('WAIT');
    expect(judgeRemovalVerdict(50, null).status).toBe('WAIT');
  });
  it('REMOVEs inside the ±0.5% no-value band (pre-committed)', () => {
    expect(judgeRemovalVerdict(30, 0.3).status).toBe('REMOVE');
    expect(judgeRemovalVerdict(40, -0.5).status).toBe('REMOVE');
  });
  it('KEEPs when vetoes dodge losses; REVIEWs when they veto winners', () => {
    expect(judgeRemovalVerdict(30, -2.1).status).toBe('KEEP');
    expect(judgeRemovalVerdict(30, 1.8).status).toBe('REVIEW');
  });
});
