// Deterministic, thesis-grounded exit engine (guardrail; spec
// docs/superpowers/specs/2026-07-11-exit-discipline-design.md). Pure module:
// no I/O, no clock, no LLM. The executor and the backtest episode runner both
// call evaluateExit so live and sim share one implementation. Priority order
// is risk-first and fixed: hard_stop > invalidation_price > target > trail >
// time_stop — the first trigger that fires wins (all-or-nothing exits).
import type { ExitPlan } from './types.js';

export type ExitTrigger = 'hard_stop' | 'invalidation_price' | 'target' | 'trail' | 'time_stop';

export interface ExitContext {
  direction: 'long' | 'short';
  entryPrice: number; // broker avg_entry_price
  entryTimeMs: number; // first tick that observed the position (conservative)
  markPrice: number; // exit-side quote: long -> bid, short -> ask
  peakFavorablePrice: number; // high-water (long) / low-water (short) since entry
  nowMs: number;
  plan: ExitPlan; // resolved (post-fallback) plan
}

export interface ExitDecision {
  exit: boolean;
  reason?: string;
  trigger?: ExitTrigger;
}

// Float tolerance for computed-percentage comparisons (division introduces
// IEEE754 noise, e.g. (95.88-94)/94*100 = 1.9999999999999951, not 2). Applied
// only to ratios derived via division; integer-ms and direct-price
// comparisons below are exact and don't need it.
const EPS = 1e-9;

export function evaluateExit(ctx: ExitContext): ExitDecision {
  const { direction, entryPrice, markPrice, plan } = ctx;
  const isLong = direction === 'long';

  // 1. hard_stop — risk first.
  if (entryPrice > 0) {
    const lossPct =
      ((isLong ? entryPrice - markPrice : markPrice - entryPrice) / entryPrice) * 100;
    if (lossPct >= plan.hardStopPct - EPS) {
      return {
        exit: true,
        trigger: 'hard_stop',
        reason: `hard_stop: unrealized loss ${lossPct.toFixed(1)}% >= ${plan.hardStopPct}%`,
      };
    }
  }

  // 2. invalidation_price — the thesis is dead at this level.
  if (plan.invalidationPrice !== undefined) {
    const dead = isLong ? markPrice <= plan.invalidationPrice : markPrice >= plan.invalidationPrice;
    if (dead) {
      return {
        exit: true,
        trigger: 'invalidation_price',
        reason: `invalidation_price: mark ${markPrice} ${isLong ? '<=' : '>='} ${plan.invalidationPrice}`,
      };
    }
  }

  // 3. target — pre-committed take-profit.
  if (plan.target !== undefined) {
    const hit = isLong ? markPrice >= plan.target : markPrice <= plan.target;
    if (hit) {
      return {
        exit: true,
        trigger: 'target',
        reason: `target: mark ${markPrice} ${isLong ? '>=' : '<='} ${plan.target}`,
      };
    }
  }

  // 4. trail — armed once the favorable move reached activatePct, then exits
  // when the mark retraces trailPct from the favorable peak (long: high; short: low).
  if (plan.trail && entryPrice > 0 && ctx.peakFavorablePrice > 0) {
    const gainPct =
      ((isLong ? ctx.peakFavorablePrice - entryPrice : entryPrice - ctx.peakFavorablePrice) /
        entryPrice) *
      100;
    if (gainPct >= plan.trail.activatePct - EPS) {
      const retracePct =
        ((isLong ? ctx.peakFavorablePrice - markPrice : markPrice - ctx.peakFavorablePrice) /
          ctx.peakFavorablePrice) *
        100;
      if (retracePct >= plan.trail.trailPct - EPS) {
        return {
          exit: true,
          trigger: 'trail',
          reason: `trail: retrace ${retracePct.toFixed(1)}% from peak ${ctx.peakFavorablePrice} >= ${plan.trail.trailPct}%`,
        };
      }
    }
  }

  // 5. time_stop — entry-relative horizon (replaces the blind boundary flatten).
  if (
    plan.timeStopHours !== undefined &&
    ctx.nowMs - ctx.entryTimeMs >= plan.timeStopHours * 3_600_000
  ) {
    const heldH = (ctx.nowMs - ctx.entryTimeMs) / 3_600_000;
    return {
      exit: true,
      trigger: 'time_stop',
      reason: `time_stop: held ${heldH.toFixed(1)}h >= ${plan.timeStopHours}h`,
    };
  }

  return { exit: false };
}
