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

export function evaluateExit(ctx: ExitContext): ExitDecision {
  const { direction, entryPrice, markPrice, plan } = ctx;
  const isLong = direction === 'long';

  // 1. hard_stop — risk first.
  if (entryPrice > 0) {
    const lossPct =
      ((isLong ? entryPrice - markPrice : markPrice - entryPrice) / entryPrice) * 100;
    if (lossPct >= plan.hardStopPct) {
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

  return { exit: false };
}
