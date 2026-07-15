// Deterministic, thesis-grounded exit engine (guardrail; spec
// docs/superpowers/specs/2026-07-11-exit-discipline-design.md). Pure module:
// no I/O, no clock, no LLM. The executor and the backtest episode runner both
// call evaluateExit so live and sim share one implementation. Priority order
// is risk-first and fixed: hard_stop > invalidation_price > target > trail >
// time_stop — the first trigger that fires wins (all-or-nothing exits).
import type { Config } from './config.js';
import type { ExitPlan, ThesisEntry } from './types.js';

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

/**
 * Resolve the enforceable plan for a position. undefined entry = orphan
 * position: stop-only at the config hard stop, exactly today's protection
 * (spec §7 locks orphans to stop-only). An entry present but bare degrades to
 * hard stop + horizon time-stop — a strict superset of today's protection.
 */
export function resolveExitPlan(
  entry: Pick<ThesisEntry, 'direction' | 'exit' | 'horizon'> | undefined,
  cfg: Config,
): ExitPlan {
  // Spec §4.2: max_position_loss_pct remains the hard floor — the engine may
  // tighten the stop below it, never loosen past it. Clamp every resolved
  // stop at the legacy cap regardless of source (config or entry-carried).
  const cap = cfg.max_position_loss_pct;
  const baseStop = cfg.exit_engine.hard_stop_pct ?? cap;
  if (!entry) return { hardStopPct: Math.min(baseStop, cap) };
  const hardDefault =
    entry.direction === 'short' ? (cfg.exit_engine.short_hard_stop_pct ?? baseStop) : baseStop;
  const e = entry.exit;
  return {
    hardStopPct: Math.min(e?.hardStopPct ?? hardDefault, cap),
    ...(e?.invalidationPrice !== undefined ? { invalidationPrice: e.invalidationPrice } : {}),
    ...(e?.target !== undefined ? { target: e.target } : {}),
    ...(e?.trail ? { trail: e.trail } : {}),
    timeStopHours: e?.timeStopHours ?? cfg.exit_engine.horizon_hours[entry.horizon ?? 'days'],
  };
}

// Sanity ceilings for LLM-emitted values: a stop or trail beyond 50% or a
// time stop beyond ~6 weeks is not a level, it's a hallucination — drop it and
// let the deterministic fallback cover the field.
const MAX_LLM_STOP_PCT = 50;
const MAX_LLM_TIME_STOP_HOURS = 1008; // 6 weeks

/**
 * Direction-aware validation of a raw LLM exit block (snake_case fields from
 * the narrative tool schema). Every field is independently validated against
 * the entry limit band; anything malformed or on the wrong side is DROPPED —
 * a wrong-side invalidation level would exit instantly at entry, so rejecting
 * is the fail-safe direction. Returns camelCase partial plan.
 */
export function sanitizeExitPlan(
  raw: unknown,
  direction: 'long' | 'short',
  band: { low: number; high: number },
): Partial<ExitPlan> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const r = raw as Record<string, unknown>;
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;
  const isLong = direction === 'long';
  const out: Partial<ExitPlan> = {};

  const hard = num(r.hard_stop_pct);
  if (hard !== undefined && hard <= MAX_LLM_STOP_PCT) out.hardStopPct = hard;

  const inval = num(r.invalidation_price);
  // Thesis-death level must sit on the LOSING side of every admissible entry.
  if (inval !== undefined && (isLong ? inval < band.low : inval > band.high)) {
    out.invalidationPrice = inval;
  }

  const target = num(r.target_price);
  if (target !== undefined && (isLong ? target > band.high : target < band.low)) {
    out.target = target;
  }

  const trailRaw =
    r.trail !== null && typeof r.trail === 'object' && !Array.isArray(r.trail)
      ? (r.trail as Record<string, unknown>)
      : undefined;
  const activatePct = num(trailRaw?.activate_pct);
  const trailPct = num(trailRaw?.trail_pct);
  if (activatePct !== undefined && trailPct !== undefined && trailPct <= MAX_LLM_STOP_PCT) {
    out.trail = { activatePct, trailPct };
  }

  const hours = num(r.time_stop_hours);
  if (hours !== undefined && hours <= MAX_LLM_TIME_STOP_HOURS) out.timeStopHours = hours;

  return out;
}

/**
 * Deterministic fallback filled first, then sanitized LLM fields on top.
 * Re-clamped after the overlay (spec §4.2): an LLM stop may tighten but never
 * loosen past max_position_loss_pct, so persisted thesis files never carry a
 * looser stop than the engine would enforce.
 */
export function mergedExitPlan(
  entry: Pick<ThesisEntry, 'direction' | 'horizon'>,
  llm: Partial<ExitPlan> | undefined,
  cfg: Config,
): ExitPlan {
  const merged = { ...resolveExitPlan(entry, cfg), ...(llm ?? {}) };
  return { ...merged, hardStopPct: Math.min(merged.hardStopPct, cfg.max_position_loss_pct) };
}
