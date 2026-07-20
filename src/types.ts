export type Mode = 'dry-run' | 'paper' | 'live';
export type Direction = 'long' | 'short' | 'none';
export type AnalystName = 'fundamental' | 'technical' | 'macro' | 'sentiment' | 'bear';
export const ANALYSTS: AnalystName[] = ['fundamental', 'technical', 'macro', 'sentiment', 'bear'];
export type Session = 'premarket' | 'rth' | 'afterhours' | 'closed';

export interface Nomination {
  ticker: string;
  reason: string;
}
export interface AnalystNominations {
  analyst: AnalystName;
  nominations: Nomination[];
}

export interface Candidate {
  ticker: string;
  nominatedBy: { analyst: AnalystName; reason: string }[];
  lastPrice: number;
  avgDollarVolume20d: number;
}
export interface CandidateFile {
  date: string; // YYYY-MM-DD (ET)
  candidates: Candidate[];
  rejected: { ticker: string; reason: string }[];
}

export interface Verdict {
  analyst: AnalystName;
  ticker: string;
  direction: Direction;
  conviction: number; // 0..1
  horizon: 'days' | 'weeks';
  evidence: string[];
  invalidation_conditions: string[];
}
export interface VerdictFile {
  date: string;
  verdicts: Verdict[];
  droppedAnalysts: AnalystName[];
}

/**
 * Counterfactual sizing record for a thesis entry: how the notional was built
 * and what it would have been with each down-only signal removed (leave-one-out).
 * Present only when at least one signal was non-trivial. The primitive the quant
 * testing plan attributes signal effect from (docs/QUANT-TESTING-PLAN.md).
 */
export interface SizingAttribution {
  baseNotional: number;
  weightedConviction: number;
  volScalar: number;
  floor: number;
  /** each signal's applied scalar (<= 1). */
  scalars: Record<string, number>;
  /** combined floored product actually applied. */
  product: number;
  /** combined product with each signal removed (leave-one-out). */
  leaveOneOut: Record<string, number>;
}

/**
 * Structured exit plan committed at thesis time and enforced every executor
 * tick by src/exits.ts (spec: docs/superpowers/specs/2026-07-11-exit-discipline-design.md).
 * All comparisons are direction-aware; absent optional fields simply never fire.
 */
export interface ExitPlan {
  /** Worst-case loss %, > 0; drives the native RTH stop leg AND the tick hard-stop check. */
  hardStopPct: number;
  /** Numeric thesis-death level (long: exit if mark <= level; short: >=). */
  invalidationPrice?: number;
  /** Take-profit price (long: mark >= target; short: <=). */
  target?: number;
  trail?: {
    /** Arm trailing once unrealized gain >= this %. */
    activatePct: number;
    /** Then exit if mark retraces this % from the favorable peak. */
    trailPct: number;
  };
  /** Exit if unresolved this many hours after entry (first-seen fallback). */
  timeStopHours?: number;
}

export interface ThesisEntry {
  ticker: string;
  direction: 'long' | 'short';
  weightedConviction: number;
  limitBand: { low: number; high: number };
  targetNotionalUsd: number;
  narrative: string;
  invalidationConditions: string[];
  /** Dominant verdict horizon of the agreeing analysts; feeds the time-stop fallback. */
  horizon?: 'days' | 'weeks';
  /** Structured exit levels; absent on historical theses (fallbacks apply). */
  exit?: ExitPlan;
  /** Present when a down-only signal shrank the size (product < 1). */
  sizing?: SizingAttribution;
}
export type ThesisKind = 'offhours' | 'rth';

export interface Thesis {
  date: string;
  kind: ThesisKind; // offhours (pre/after-market) or rth (regular session)
  generatedAt: string; // ISO
  expiresAt: string; // ISO
  entries: ThesisEntry[];
  skipped: { ticker: string; reason: string }[];
  // Market regime overlay applied at synthesis (optional; audit/dashboard).
  regime?: {
    state: string;
    longScalar: number;
    shortScalar: number;
    volScalar: number;
    thresholdBump: number;
  };
}

export interface QuoteSnapshot {
  ticker: string;
  bid: number;
  ask: number;
  bidSize: number;
  askSize: number;
  last: number;
  asOf: string;
}

export interface ProposedOrder {
  ticker: string;
  side: 'buy' | 'sell';
  qty: number;
  limitPrice: number;
  intent: 'entry' | 'exit';
  reason: string;
  // false during the regular session; true (Alpaca extended_hours) otherwise.
  extendedHours: boolean;
  // Regular-session entries attach a native stop-loss at this price (Alpaca
  // OTO). Only set on RTH entries — extended-hours stops do not execute.
  stopLoss?: number;
}
export interface RiskDecision {
  allowed: boolean;
  reasons: string[];
}

export interface Position {
  ticker: string;
  qty: number;
  avgEntryPrice: number;
  marketValue: number;
  unrealizedPl: number;
  side: 'long' | 'short';
}
export interface AccountSnapshot {
  equity: number;
  cash: number;
  positions: Position[];
}
export interface BrokerOrder {
  id: string;
  ticker: string;
  side: 'buy' | 'sell';
  qty: number;
  /** Alpaca order type: 'limit' | 'stop' | 'stop_limit' | 'market' | ... */
  type?: string;
  limitPrice: number;
  /** Trigger price for stop / stop_limit orders; absent for plain limits. */
  stopPrice?: number;
  /** 'day' | 'gtc' | ...; distinguishes resting (gtc) from expiring (day) stops. */
  timeInForce?: string;
  status: string;
  submittedAt: string;
  /** Our idempotency tag; prefixed 'entry-' or 'exit-' at placement. */
  clientOrderId?: string;
  filledQty?: number;
}

export interface HaltState {
  halted: boolean;
  reason: string;
  at: string;
}
export interface AuditEvent {
  ts: string;
  kind:
    | 'nomination'
    | 'candidates'
    | 'verdict'
    | 'thesis'
    | 'tick'
    | 'proposed_order'
    | 'order_placed'
    | 'order_rejected'
    | 'exit'
    | 'counterfactual'
    | 'halt'
    | 'resume'
    | 'error';
  data: unknown;
}
