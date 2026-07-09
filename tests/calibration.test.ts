import { describe, expect, it } from 'vitest';
import { applyCalibration, calibratedConviction, type CalibrationPoint } from '../src/calibration.js';
import { ConfigSchema, type Config } from '../src/config.js';

// Monotone table used across interpolation/clamp cases.
const TABLE: CalibrationPoint[] = [
  { score: 0, prob: 0.1 },
  { score: 0.5, prob: 0.4 },
  { score: 1, prob: 0.9 },
];

describe('applyCalibration', () => {
  describe('empty table -> identity', () => {
    it.each([0, 0.25, 0.5, 0.73, 1, -5, 100])('returns score %f unchanged', (score) => {
      expect(applyCalibration(score, [])).toBeCloseTo(score, 12);
    });
  });

  describe('monotone table', () => {
    it('interpolates linearly at a midpoint (0.25 -> 0.25)', () => {
      // t = 0.25/0.5 = 0.5 across [0.1, 0.4] -> 0.1 + 0.5*0.3 = 0.25
      expect(applyCalibration(0.25, TABLE)).toBeCloseTo(0.25, 10);
    });

    it('interpolates linearly in the upper segment (0.75 -> 0.65)', () => {
      // t = 0.25/0.5 = 0.5 across [0.4, 0.9] -> 0.4 + 0.5*0.5 = 0.65
      expect(applyCalibration(0.75, TABLE)).toBeCloseTo(0.65, 10);
    });

    it('interpolates at an off-center point in the lower segment (0.1 -> 0.16)', () => {
      // t = 0.1/0.5 = 0.2 across [0.1, 0.4] -> 0.1 + 0.2*0.3 = 0.16
      expect(applyCalibration(0.1, TABLE)).toBeCloseTo(0.16, 10);
    });

    it.each([
      [0, 0.1],
      [0.5, 0.4],
      [1, 0.9],
    ])('returns the breakpoint prob at breakpoint score %f -> %f', (score, prob) => {
      expect(applyCalibration(score, TABLE)).toBeCloseTo(prob, 12);
    });

    it.each([-1, -0.001, -100])('clamps below the first breakpoint (%f -> 0.1)', (score) => {
      expect(applyCalibration(score, TABLE)).toBeCloseTo(0.1, 12);
    });

    it.each([1.0001, 2, 1000])('clamps above the last breakpoint (%f -> 0.9)', (score) => {
      expect(applyCalibration(score, TABLE)).toBeCloseTo(0.9, 12);
    });
  });

  describe('unsorted input', () => {
    const unsorted: CalibrationPoint[] = [
      { score: 1, prob: 0.9 },
      { score: 0, prob: 0.1 },
      { score: 0.5, prob: 0.4 },
    ];

    it('sorts internally and interpolates the midpoint (0.25 -> 0.25)', () => {
      expect(applyCalibration(0.25, unsorted)).toBeCloseTo(0.25, 10);
    });

    it('sorts internally and clamps below the first breakpoint', () => {
      expect(applyCalibration(-3, unsorted)).toBeCloseTo(0.1, 12);
    });

    it('sorts internally and clamps above the last breakpoint', () => {
      expect(applyCalibration(5, unsorted)).toBeCloseTo(0.9, 12);
    });

    it('does not mutate the caller table', () => {
      const before = unsorted.map((p) => ({ ...p }));
      applyCalibration(0.25, unsorted);
      expect(unsorted).toEqual(before);
    });
  });
});

describe('calibratedConviction', () => {
  const baseCal: Config['calibration'] = ConfigSchema.parse({}).calibration;

  it('default config (enabled false, empty table) -> identity', () => {
    expect(baseCal.enabled).toBe(false);
    expect(baseCal.table).toEqual([]);
    for (const score of [0.2, 0.5, 0.87]) {
      expect(calibratedConviction(score, baseCal)).toBeCloseTo(score, 12);
    }
  });

  it('enabled true but empty table -> still identity', () => {
    const cal: Config['calibration'] = { ...baseCal, enabled: true, table: [] };
    for (const score of [0.2, 0.5, 0.87]) {
      expect(calibratedConviction(score, cal)).toBeCloseTo(score, 12);
    }
  });

  it('enabled true with a table -> applies the map', () => {
    const cal: Config['calibration'] = { ...baseCal, enabled: true, table: TABLE };
    expect(calibratedConviction(0.25, cal)).toBeCloseTo(0.25, 10);
    expect(calibratedConviction(0.5, cal)).toBeCloseTo(0.4, 12);
    expect(calibratedConviction(-2, cal)).toBeCloseTo(0.1, 12);
    expect(calibratedConviction(2, cal)).toBeCloseTo(0.9, 12);
  });

  it('enabled false with a table -> identity (ignores the map)', () => {
    const cal: Config['calibration'] = { ...baseCal, enabled: false, table: TABLE };
    expect(calibratedConviction(0.25, cal)).toBeCloseTo(0.25, 10);
    expect(calibratedConviction(0.5, cal)).toBeCloseTo(0.5, 12);
  });

  it('clamps the calibrated conviction to [0,1] so it can never inflate a position', () => {
    // Defense-in-depth: even a mis-fit table with prob>1 must not exceed 1.
    const bad: Config['calibration'] = { ...baseCal, enabled: true, table: [{ score: 0, prob: 0.5 }, { score: 0.9, prob: 1.5 }] };
    expect(calibratedConviction(0.9, bad)).toBe(1);
    expect(calibratedConviction(1.0, bad)).toBe(1);
  });
});

describe('ConfigSchema rejects an out-of-range calibration prob', () => {
  it('rejects prob above 1 and below 0, accepts a valid [0,1] prob', () => {
    expect(() => ConfigSchema.parse({ calibration: { table: [{ score: 0.9, prob: 1.3 }] } })).toThrow();
    expect(() => ConfigSchema.parse({ calibration: { table: [{ score: 0.9, prob: -0.1 }] } })).toThrow();
    expect(() => ConfigSchema.parse({ calibration: { table: [{ score: 0.9, prob: 0.7 }] } })).not.toThrow();
  });
});
