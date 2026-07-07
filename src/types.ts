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

export interface ThesisEntry {
  ticker: string;
  direction: 'long' | 'short';
  weightedConviction: number;
  limitBand: { low: number; high: number };
  targetNotionalUsd: number;
  narrative: string;
  invalidationConditions: string[];
}
export interface Thesis {
  date: string;
  generatedAt: string; // ISO
  expiresAt: string; // ISO
  entries: ThesisEntry[];
  skipped: { ticker: string; reason: string }[];
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
  limitPrice: number;
  status: string;
  submittedAt: string;
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
    | 'halt'
    | 'resume'
    | 'error';
  data: unknown;
}
