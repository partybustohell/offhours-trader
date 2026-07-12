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

export interface OperatorSnapshot {
  status: StatusResponse | null;
  candidates: CandidateFile | null;
  thesis: Thesis | null;
  thesisRth: Thesis | null;
  verdicts: VerdictFile | null;
  positions: PositionsResponse;
  orders: OrdersResponse;
  audit: AuditEvent[];
  config: Config | null;
  backtest: BacktestResponse | null;
}

export type ResourceKey = keyof OperatorSnapshot;

export type ResourceResult<K extends ResourceKey> =
  | { ok: true; value: OperatorSnapshot[K] }
  | { ok: false; error: string };

export type PollResults = {
  [K in ResourceKey]: ResourceResult<K>;
};

export interface ResourceHealth {
  state: 'never' | 'fresh' | 'stale' | 'error';
  lastSuccessAt: number | null;
  error: string | null;
}

export interface PollingState {
  initialLoading: boolean;
  refreshing: boolean;
  connectivity: 'unknown' | 'online' | 'offline';
  stale: boolean;
  lastAttemptAt: number | null;
  lastFullSuccessAt: number | null;
  resources: Record<ResourceKey, ResourceHealth>;
}

export type OperatorAction = 'analysis' | 'executionCheck' | 'halt' | 'resume';

export type ActionState =
  | { phase: 'idle' }
  | { phase: 'pending'; startedAt: number }
  | { phase: 'success'; message: string; completedAt: number }
  | { phase: 'error'; message: string; completedAt: number };

export interface OperatorState {
  data: OperatorSnapshot;
  polling: PollingState;
  actions: Record<OperatorAction, ActionState>;
}

const resourceKeys: ResourceKey[] = [
  'status',
  'candidates',
  'thesis',
  'thesisRth',
  'verdicts',
  'positions',
  'orders',
  'audit',
  'config',
  'backtest',
];

function health(): ResourceHealth {
  return { state: 'never', lastSuccessAt: null, error: null };
}

function hasLastKnownGoodData(state: OperatorState, key: ResourceKey): boolean {
  if (state.polling.resources[key].lastSuccessAt !== null) return true;
  switch (key) {
    case 'positions':
      return state.data.positions.positions.length > 0 || state.data.positions.error !== undefined;
    case 'orders':
      return state.data.orders.orders.length > 0 || state.data.orders.error !== undefined;
    case 'audit':
      return state.data.audit.length > 0;
    default:
      return state.data[key] !== null;
  }
}

export function createInitialOperatorState(): OperatorState {
  return {
    data: {
      status: null,
      candidates: null,
      thesis: null,
      thesisRth: null,
      verdicts: null,
      positions: { positions: [] },
      orders: { orders: [] },
      audit: [],
      config: null,
      backtest: null,
    },
    polling: {
      initialLoading: true,
      refreshing: false,
      connectivity: 'unknown',
      stale: false,
      lastAttemptAt: null,
      lastFullSuccessAt: null,
      resources: Object.fromEntries(resourceKeys.map((key) => [key, health()])) as Record<
        ResourceKey,
        ResourceHealth
      >,
    },
    actions: {
      analysis: { phase: 'idle' },
      executionCheck: { phase: 'idle' },
      halt: { phase: 'idle' },
      resume: { phase: 'idle' },
    },
  };
}

export function markRefreshing(state: OperatorState, at: number): OperatorState {
  return {
    ...state,
    polling: { ...state.polling, refreshing: true, lastAttemptAt: at },
  };
}

export function applyPoll(
  state: OperatorState,
  results: PollResults,
  at: number,
): OperatorState {
  const data = { ...state.data };
  const resources = { ...state.polling.resources };
  let fulfilled = 0;

  for (const key of resourceKeys) {
    const result = results[key];
    if (result.ok) {
      fulfilled += 1;
      data[key] = result.value as never;
      resources[key] = { state: 'fresh', lastSuccessAt: at, error: null };
    } else {
      const previous = resources[key];
      resources[key] = {
        state: hasLastKnownGoodData(state, key) ? 'stale' : 'error',
        lastSuccessAt: previous.lastSuccessAt,
        error: result.error,
      };
    }
  }

  const allSucceeded = fulfilled === resourceKeys.length;
  return {
    ...state,
    data,
    polling: {
      initialLoading: false,
      refreshing: false,
      connectivity: fulfilled === 0 ? 'offline' : 'online',
      stale: !allSucceeded,
      lastAttemptAt: at,
      lastFullSuccessAt: allSucceeded ? at : state.polling.lastFullSuccessAt,
      resources,
    },
  };
}

export function setActionState(
  state: OperatorState,
  action: OperatorAction,
  next: ActionState,
): OperatorState {
  return { ...state, actions: { ...state.actions, [action]: next } };
}
