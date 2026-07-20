// Mirrors the backend contract in ../../src/types.ts and the config shape in
// ../../src/config.ts. Copied, not imported: the frontend is a separate package.

export type Mode = 'dry-run' | 'paper' | 'live';
export type Direction = 'long' | 'short' | 'none';
export type AnalystName = 'fundamental' | 'technical' | 'macro' | 'sentiment' | 'bear';
export const ANALYSTS: AnalystName[] = ['fundamental', 'technical', 'macro', 'sentiment', 'bear'];
export type Session = 'premarket' | 'rth' | 'afterhours' | 'closed';

export interface Candidate {
  ticker: string;
  nominatedBy: { analyst: AnalystName; reason: string }[];
  lastPrice: number;
  avgDollarVolume20d: number;
}
export interface CandidateFile {
  date: string;
  candidates: Candidate[];
  rejected: { ticker: string; reason: string }[];
}

export interface Verdict {
  analyst: AnalystName;
  ticker: string;
  direction: Direction;
  conviction: number;
  horizon: 'days' | 'weeks';
  evidence: string[];
  invalidation_conditions: string[];
}
export interface VerdictFile {
  date: string;
  verdicts: Verdict[];
  droppedAnalysts: AnalystName[];
}

export interface SizingAttribution {
  baseNotional: number;
  weightedConviction: number;
  volScalar: number;
  floor: number;
  scalars: Record<string, number>;
  product: number;
  leaveOneOut: Record<string, number>;
}

export interface ThesisEntry {
  ticker: string;
  direction: 'long' | 'short';
  weightedConviction: number;
  limitBand: { low: number; high: number };
  targetNotionalUsd: number;
  narrative: string;
  invalidationConditions: string[];
  sizing?: SizingAttribution;
}

export interface Thesis {
  date: string;
  kind: 'offhours' | 'rth';
  generatedAt: string;
  expiresAt: string;
  entries: ThesisEntry[];
  skipped: { ticker: string; reason: string }[];
  regime?: {
    state: string;
    longScalar: number;
    shortScalar: number;
    volScalar: number;
    thresholdBump: number;
  };
}

export interface Position {
  ticker: string;
  qty: number;
  avgEntryPrice: number;
  marketValue: number;
  unrealizedPl: number;
  side: 'long' | 'short';
}
export interface BrokerOrder {
  id: string;
  ticker: string;
  side: 'buy' | 'sell';
  qty: number;
  type?: string;
  limitPrice: number;
  stopPrice?: number;
  timeInForce?: string;
  status: string;
  submittedAt: string;
  clientOrderId?: string;
  filledQty?: number;
}

export interface HaltState {
  halted: boolean;
  reason: string;
  at: string;
}

export const KNOWN_AUDIT_KINDS = [
  'nomination',
  'candidates',
  'verdict',
  'thesis',
  'tick',
  'proposed_order',
  'order_placed',
  'order_rejected',
  'exit',
  'counterfactual',
  'halt',
  'resume',
  'error',
] as const;

export type KnownAuditKind = (typeof KNOWN_AUDIT_KINDS)[number];

// Retained temporarily for existing views; new code should use KnownAuditKind.
export type AuditKind = KnownAuditKind;

export interface AuditEvent {
  ts: string;
  kind: string;
  data: unknown;
}

export interface Config {
  mode: Mode;
  live_trading_acknowledged: boolean;
  universe: {
    nominations_per_agent: number;
    max_candidates: number;
    min_price: number;
    min_avg_dollar_volume: number;
    exclude: string[];
  };
  sessions: {
    premarket: boolean;
    afterhours: boolean;
    regularhours: boolean;
  };
  agent_weights: Record<AnalystName, number>;
  conviction_threshold: number;
  quorum: number;
  min_agreeing: number;
  max_position_pct: number;
  max_daily_deploy_pct: number;
  max_order_notional_usd: number;
  max_spread_bps: number;
  max_chase_pct: number;
  max_drop_pct: number;
  target_vol_pct: number;
  max_position_loss_pct: number;
  daily_loss_halt_pct: number;
  data_feed: 'iex' | 'sip';
  max_quote_age_sec: number;
  executor_interval_min: number;
  thesis_run_time_et: string;
  model: {
    analysts: string;
    synthesizer: string;
    executor: string;
  };
}

// Normalized shape of GET /api/status; nulls mean the server could not report
// the field (e.g. broker creds missing).
export interface StatusResponse {
  mode: Mode | null;
  session: Session | null;
  halt: HaltState | null;
  equity: number | null;
  error?: string;
}

export interface PositionsResponse {
  positions: Position[];
  error?: string;
}
export interface OrdersResponse {
  orders: BrokerOrder[];
  error?: string;
}

export interface BacktestCell {
  cell: string;
  threshold: number;
  bear?: number;
  bearWeight?: number;
  abstained: number;
  ordersPlaced: number;
  ordersFilled: number;
  trades: number;
  netPnlUsd: number | null;
}
export interface BacktestTrade {
  day: string;
  stratum: string;
  ticker: string;
  side: string;
  qty: number;
  entryPrice: number;
  exitPrice: number;
  pnlUsd: number;
  exitReason: string;
}
export interface BacktestResponse {
  available: boolean;
  tag?: string;
  generatedAt?: string | null;
  cells?: BacktestCell[];
  tradeLogCell?: string | null;
  trades?: BacktestTrade[];
}
