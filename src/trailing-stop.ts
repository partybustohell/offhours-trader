// Native protective-stop ratchet (pure planner; no I/O, no clock). Each tick
// the executor computes the DESIRED resting stop for every open position from
// the resolved exit plan and the persisted favorable peak, then converges the
// broker's simple GTC stop toward it: place when missing, replace when the
// level tightens or the position size drifted, never loosen. The resting stop
// is what survives an engine outage — the tick-evaluated trail in exits.ts
// exits at a marketable limit when the process is alive; this order protects
// the position when it is not.
import type { ExitPlan } from './types.js';

// Mirrors the EPS rationale in exits.ts: percentage comparisons divide.
const EPS = 1e-9;
// One cent: the minimum improvement worth a cancel/replace round-trip.
const MIN_IMPROVEMENT = 0.01;

const round2 = (p: number): number => Math.round(p * 100) / 100;

export interface RestingStop {
  id: string;
  stopPrice: number;
  qty: number;
}

export interface StopLevelContext {
  side: 'long' | 'short';
  entryPrice: number;
  /** Favorable extreme since entry (high for longs, low for shorts); 0 = none seen. */
  peak: number;
  plan: ExitPlan;
}

export interface StopContext extends StopLevelContext {
  /** Absolute position size the stop must cover. */
  qty: number;
  existing?: RestingStop;
}

export type StopAction =
  | { action: 'none' }
  | { action: 'place'; stopPrice: number; qty: number }
  | { action: 'replace'; cancelId: string; stopPrice: number; qty: number };

/**
 * The tightest justified protective level: the hard stop until the trail arms
 * (peak gain >= activatePct), then the trail floor — breakeven-ratcheted when
 * floorAtEntry — following the favorable peak. Cent-rounded like the entry
 * stop leg in executor-loop.
 */
export function desiredProtectiveStop(ctx: StopLevelContext): number {
  const { side, entryPrice, peak, plan } = ctx;
  const isLong = side === 'long';
  const base = isLong
    ? entryPrice * (1 - plan.hardStopPct / 100)
    : entryPrice * (1 + plan.hardStopPct / 100);
  const trail = plan.trail;
  if (!trail || peak <= 0 || entryPrice <= 0) return round2(base);
  const gainPct = ((isLong ? peak - entryPrice : entryPrice - peak) / entryPrice) * 100;
  if (gainPct < trail.activatePct - EPS) return round2(base);
  const trailLevel = isLong ? peak * (1 - trail.trailPct / 100) : peak * (1 + trail.trailPct / 100);
  const floor = trail.floorAtEntry
    ? isLong
      ? Math.max(entryPrice, trailLevel)
      : Math.min(entryPrice, trailLevel)
    : trailLevel;
  return round2(isLong ? Math.max(base, floor) : Math.min(base, floor));
}

/**
 * Converge the resting stop toward the desired level. Ratchet-only: the level
 * moves toward price (up for longs, down for shorts), never away — a qty
 * drift replaces at the tighter of (existing, desired) so re-covering the
 * position can never widen risk.
 */
export function planStopAction(ctx: StopContext): StopAction {
  if (ctx.qty <= 0 || ctx.entryPrice <= 0) return { action: 'none' };
  const isLong = ctx.side === 'long';
  const desired = desiredProtectiveStop(ctx);
  const existing = ctx.existing;
  if (!existing) return { action: 'place', stopPrice: desired, qty: ctx.qty };
  const tighter = isLong
    ? Math.max(desired, existing.stopPrice)
    : Math.min(desired, existing.stopPrice);
  if (existing.qty !== ctx.qty) {
    return { action: 'replace', cancelId: existing.id, stopPrice: tighter, qty: ctx.qty };
  }
  const improvement = isLong ? desired - existing.stopPrice : existing.stopPrice - desired;
  if (improvement >= MIN_IMPROVEMENT - EPS) {
    return { action: 'replace', cancelId: existing.id, stopPrice: desired, qty: ctx.qty };
  }
  return { action: 'none' };
}
