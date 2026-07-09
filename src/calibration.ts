// Monotone conviction calibration (P3) — maps a raw conviction score to a
// calibrated win-probability via a piecewise-linear table. Ships as IDENTITY
// (empty table); a fitted table is only valid after >=50 OOS closed trades
// (governance gate, enforced by the caller). Pure math.
import type { Config } from './config.js';

export interface CalibrationPoint {
  score: number;
  prob: number;
}

/**
 * Piecewise-linear interpolation of `score` over a sorted (score,prob) table.
 * Empty table -> identity (returns score). Outside the table range, clamps to
 * the nearest endpoint's prob. The table SHOULD be monotone; this does not
 * enforce it (fitting does).
 */
export function applyCalibration(score: number, table: CalibrationPoint[]): number {
  if (table.length === 0) return score;
  const pts = [...table].sort((a, b) => a.score - b.score);
  if (score <= pts[0]!.score) return pts[0]!.prob;
  const lastPt = pts[pts.length - 1]!;
  if (score >= lastPt.score) return lastPt.prob;
  for (let i = 1; i < pts.length; i++) {
    const hi = pts[i]!;
    const lo = pts[i - 1]!;
    if (score <= hi.score) {
      const span = hi.score - lo.score;
      const t = span > 0 ? (score - lo.score) / span : 0;
      return lo.prob + t * (hi.prob - lo.prob);
    }
  }
  return lastPt.prob;
}

/**
 * Resolve the calibration map for a conviction score. Identity unless enabled
 * AND a table is present (the >=min_trades gate is the caller's responsibility;
 * an empty table is the safe default that ships).
 */
export function calibratedConviction(score: number, cfg: Config['calibration']): number {
  if (!cfg.enabled || cfg.table.length === 0) return score;
  // Clamp to [0,1] as defense-in-depth: a calibrated conviction must never
  // exceed 1 (it would inflate a position past the per-position cap).
  return Math.max(0, Math.min(1, applyCalibration(score, cfg.table)));
}
