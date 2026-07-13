import type {
  AuditEvent,
  BacktestResponse,
  CandidateFile,
  Config,
  OrdersResponse,
  PositionsResponse,
  StatusResponse,
  Thesis,
  VerdictFile,
} from '../types';

export const configFixture = {
  mode: 'paper',
  live_trading_acknowledged: false,
  universe: {
    nominations_per_agent: 3,
    max_candidates: 12,
    min_price: 5,
    min_avg_dollar_volume: 20_000_000,
    exclude: ['GME'],
  },
  sessions: { premarket: true, afterhours: true, regularhours: false },
  agent_weights: { fundamental: 1, technical: 1, macro: 1, sentiment: 1, bear: 1 },
  conviction_threshold: 0.7,
  quorum: 4,
  min_agreeing: 2,
  max_position_pct: 5,
  max_daily_deploy_pct: 10,
  max_order_notional_usd: 5_000,
  max_spread_bps: 40,
  max_chase_pct: 1,
  max_drop_pct: 3,
  target_vol_pct: 40,
  max_position_loss_pct: 8,
  daily_loss_halt_pct: 3,
  data_feed: 'iex',
  max_quote_age_sec: 30,
  executor_interval_min: 5,
  thesis_run_time_et: '16:15',
  model: { analysts: 'claude-sonnet', synthesizer: 'claude-sonnet', executor: 'rules' },
} satisfies Config;

export const statusFixture = {
  mode: 'paper',
  session: 'afterhours',
  halt: null,
  equity: 100_000,
} satisfies StatusResponse;

export const candidatesFixture = {
  date: '2026-07-12',
  candidates: [
    {
      ticker: 'AMD',
      nominatedBy: [{ analyst: 'technical', reason: 'Relative strength remained positive.' }],
      lastPrice: 172.4,
      avgDollarVolume20d: 1_200_000_000,
    },
    {
      ticker: 'WBD',
      nominatedBy: [{ analyst: 'fundamental', reason: 'Valuation screened below peers.' }],
      lastPrice: 11.2,
      avgDollarVolume20d: 90_000_000,
    },
  ],
  rejected: [{ ticker: 'GME', reason: 'Excluded by universe configuration.' }],
} satisfies CandidateFile;

export const verdictsFixture = {
  date: '2026-07-12',
  droppedAnalysts: [],
  verdicts: [
    {
      analyst: 'fundamental',
      ticker: 'AMD',
      direction: 'long',
      conviction: 0.78,
      horizon: 'weeks',
      evidence: ['Free cash flow remained positive.'],
      invalidation_conditions: ['Guidance is reduced.'],
    },
    {
      analyst: 'technical',
      ticker: 'AMD',
      direction: 'long',
      conviction: 0.82,
      horizon: 'days',
      evidence: ['Price held above the 20-day average.'],
      invalidation_conditions: ['Price closes below the 20-day average.'],
    },
    {
      analyst: 'fundamental',
      ticker: 'WBD',
      direction: 'long',
      conviction: 0.61,
      horizon: 'weeks',
      evidence: ['Valuation is below the sector median.'],
      invalidation_conditions: ['Leverage rises.'],
    },
    ...(['technical', 'macro', 'sentiment', 'bear'] as const).map((analyst) => ({
      analyst,
      ticker: 'WBD',
      direction: 'none' as const,
      conviction: 0.5,
      horizon: 'days' as const,
      evidence: ['No qualifying directional evidence was recorded.'],
      invalidation_conditions: [],
    })),
  ],
} satisfies VerdictFile;

export const offhoursPlanFixture = {
  date: '2026-07-12',
  kind: 'offhours',
  generatedAt: '2026-07-12T20:15:00.000Z',
  expiresAt: '2026-07-13T13:30:00.000Z',
  entries: [
    {
      ticker: 'AMD',
      direction: 'long',
      weightedConviction: 0.8,
      limitBand: { low: 170, high: 173 },
      targetNotionalUsd: 4_000,
      narrative: 'Two recorded analyst views supported a long position.',
      invalidationConditions: ['Price closes below 170.'],
    },
  ],
  skipped: [{ ticker: 'WBD', reason: '1 of 2 required analysts agreed.' }],
} satisfies Thesis;

export const rthPlanFixture = {
  ...offhoursPlanFixture,
  kind: 'rth',
  generatedAt: '2026-07-12T14:00:00.000Z',
  expiresAt: '2026-07-12T20:00:00.000Z',
} satisfies Thesis;

export const positionsFixture = {
  positions: [
    {
      ticker: 'AMD',
      qty: 20,
      avgEntryPrice: 168,
      marketValue: 3_448,
      unrealizedPl: 88,
      side: 'long',
    },
  ],
} satisfies PositionsResponse;

export const ordersFixture = {
  orders: [
    {
      id: 'order-1',
      ticker: 'AMD',
      side: 'buy',
      qty: 20,
      type: 'limit',
      limitPrice: 172.4,
      timeInForce: 'day',
      status: 'filled',
      submittedAt: '2026-07-12T14:05:00.000Z',
      clientOrderId: 'entry-amd-1',
      filledQty: 20,
    },
  ],
} satisfies OrdersResponse;

export const auditFixture = [
  {
    ts: '2026-07-12T20:15:00.000Z',
    kind: 'thesis',
    data: { entries: 1, skipped: 1 },
  },
  {
    ts: '2026-07-12T20:20:00.000Z',
    kind: 'order_rejected',
    data: { ticker: 'WBD', reason: 'Spread exceeded 40 bps.' },
  },
] satisfies AuditEvent[];

export const backtestFixture = {
  available: true,
  tag: 'july-sweep',
  generatedAt: '2026-07-12T12:00:00.000Z',
  tradeLogCell: 't070',
  cells: [
    {
      cell: 't070',
      threshold: 0.7,
      bear: 0.5,
      abstained: 3,
      ordersPlaced: 4,
      ordersFilled: 3,
      trades: 3,
      netPnlUsd: 125,
    },
  ],
  trades: [
    {
      day: '2026-07-10',
      stratum: 'base',
      ticker: 'AMD',
      side: 'buy',
      qty: 10,
      entryPrice: 168,
      exitPrice: 171,
      pnlUsd: 30,
      exitReason: 'target',
    },
  ],
} satisfies BacktestResponse;
