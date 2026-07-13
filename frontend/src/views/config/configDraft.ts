import { ANALYSTS, type AnalystName, type Config } from '../../types';

export interface ConfigDraft {
  nominations_per_agent: string;
  max_candidates: string;
  min_price: string;
  min_avg_dollar_volume: string;
  exclude: string[];
  premarket: boolean;
  afterhours: boolean;
  regularhours: boolean;
  data_feed: 'iex' | 'sip';
  weights: Record<AnalystName, string>;
  conviction_threshold: string;
  quorum: string;
  min_agreeing: string;
  max_position_pct: string;
  max_daily_deploy_pct: string;
  max_order_notional_usd: string;
  max_spread_bps: string;
  max_chase_pct: string;
  max_drop_pct: string;
  target_vol_pct: string;
  max_position_loss_pct: string;
  max_quote_age_sec: string;
  daily_loss_halt_pct: string;
  executor_interval_min: string;
  thesis_run_time_et: string;
  model_analysts: string;
  model_synthesizer: string;
  model_executor: string;
}

const NUMERIC_DRAFT_FIELDS = [
  'nominations_per_agent',
  'max_candidates',
  'min_price',
  'min_avg_dollar_volume',
  'conviction_threshold',
  'quorum',
  'min_agreeing',
  'max_position_pct',
  'max_daily_deploy_pct',
  'max_order_notional_usd',
  'max_spread_bps',
  'max_chase_pct',
  'max_drop_pct',
  'target_vol_pct',
  'max_position_loss_pct',
  'max_quote_age_sec',
  'daily_loss_halt_pct',
  'executor_interval_min',
] as const satisfies readonly (keyof ConfigDraft)[];

export type ConfigDraftNumericField =
  | (typeof NUMERIC_DRAFT_FIELDS)[number]
  | `weights.${AnalystName}`;

export type ConfigDraftFieldErrors = Partial<
  Record<ConfigDraftNumericField, string>
>;

export type ConfigDraftPhase =
  | 'loading'
  | 'clean'
  | 'dirty'
  | 'saving'
  | 'saved'
  | 'error';

export interface ConfigDraftState {
  baseline: Config | null;
  draft: ConfigDraft | null;
  incoming: Config | null;
  phase: ConfigDraftPhase;
  message: string | null;
  fieldErrors: ConfigDraftFieldErrors;
  validationAttempt: number;
}

export type ConfigDraftAction =
  | { type: 'serverReceived'; config: Config }
  | { type: 'patch'; patch: Partial<ConfigDraft> }
  | { type: 'discard' }
  | { type: 'saveStarted' }
  | { type: 'saveSucceeded'; config: Config }
  | { type: 'saveFailed'; message: string }
  | { type: 'validationFailed'; errors: ConfigDraftFieldErrors };

export class ConfigDraftValidationError extends Error {
  readonly fieldErrors: ConfigDraftFieldErrors;

  constructor(fieldErrors: ConfigDraftFieldErrors) {
    super('Configuration contains invalid numeric values.');
    this.name = 'ConfigDraftValidationError';
    this.fieldErrors = fieldErrors;
  }
}

function equalConfig(a: Config | null, b: Config | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function isNumeric(value: string): boolean {
  if (value.trim() === '') return false;
  return Number.isFinite(Number(value));
}

function hasFieldErrors(errors: ConfigDraftFieldErrors): boolean {
  return Object.keys(errors).length > 0;
}

export function validateConfigDraft(
  draft: ConfigDraft,
): ConfigDraftFieldErrors {
  const errors: ConfigDraftFieldErrors = {};

  for (const field of NUMERIC_DRAFT_FIELDS) {
    if (!isNumeric(draft[field])) {
      errors[field] = 'Enter a numeric value.';
    }
  }
  for (const analyst of ANALYSTS) {
    if (!isNumeric(draft.weights[analyst])) {
      errors[`weights.${analyst}`] = 'Enter a numeric value.';
    }
  }

  return errors;
}

export function toConfigDraft(config: Config): ConfigDraft {
  return {
    nominations_per_agent: String(config.universe.nominations_per_agent),
    max_candidates: String(config.universe.max_candidates),
    min_price: String(config.universe.min_price),
    min_avg_dollar_volume: String(config.universe.min_avg_dollar_volume),
    exclude: [...config.universe.exclude],
    premarket: config.sessions.premarket,
    afterhours: config.sessions.afterhours,
    regularhours: config.sessions.regularhours,
    data_feed: config.data_feed,
    weights: {
      fundamental: String(config.agent_weights.fundamental),
      technical: String(config.agent_weights.technical),
      macro: String(config.agent_weights.macro),
      sentiment: String(config.agent_weights.sentiment),
      bear: String(config.agent_weights.bear),
    },
    conviction_threshold: String(config.conviction_threshold),
    quorum: String(config.quorum),
    min_agreeing: String(config.min_agreeing),
    max_position_pct: String(config.max_position_pct),
    max_daily_deploy_pct: String(config.max_daily_deploy_pct),
    max_order_notional_usd: String(config.max_order_notional_usd),
    max_spread_bps: String(config.max_spread_bps),
    max_chase_pct: String(config.max_chase_pct),
    max_drop_pct: String(config.max_drop_pct),
    target_vol_pct: String(config.target_vol_pct),
    max_position_loss_pct: String(config.max_position_loss_pct),
    max_quote_age_sec: String(config.max_quote_age_sec),
    daily_loss_halt_pct: String(config.daily_loss_halt_pct),
    executor_interval_min: String(config.executor_interval_min),
    thesis_run_time_et: config.thesis_run_time_et,
    model_analysts: config.model.analysts,
    model_synthesizer: config.model.synthesizer,
    model_executor: config.model.executor,
  };
}

export function toConfigPayload(
  draft: ConfigDraft,
  latestServer: Config,
): Config {
  const fieldErrors = validateConfigDraft(draft);
  if (hasFieldErrors(fieldErrors)) {
    throw new ConfigDraftValidationError(fieldErrors);
  }

  return {
    mode: latestServer.mode,
    live_trading_acknowledged: latestServer.live_trading_acknowledged,
    universe: {
      nominations_per_agent: Number(draft.nominations_per_agent),
      max_candidates: Number(draft.max_candidates),
      min_price: Number(draft.min_price),
      min_avg_dollar_volume: Number(draft.min_avg_dollar_volume),
      exclude: [...draft.exclude],
    },
    sessions: {
      premarket: draft.premarket,
      afterhours: draft.afterhours,
      regularhours: draft.regularhours,
    },
    agent_weights: {
      fundamental: Number(draft.weights.fundamental),
      technical: Number(draft.weights.technical),
      macro: Number(draft.weights.macro),
      sentiment: Number(draft.weights.sentiment),
      bear: Number(draft.weights.bear),
    },
    conviction_threshold: Number(draft.conviction_threshold),
    quorum: Number(draft.quorum),
    min_agreeing: Number(draft.min_agreeing),
    max_position_pct: Number(draft.max_position_pct),
    max_daily_deploy_pct: Number(draft.max_daily_deploy_pct),
    max_order_notional_usd: Number(draft.max_order_notional_usd),
    max_spread_bps: Number(draft.max_spread_bps),
    max_chase_pct: Number(draft.max_chase_pct),
    max_drop_pct: Number(draft.max_drop_pct),
    target_vol_pct: Number(draft.target_vol_pct),
    max_position_loss_pct: Number(draft.max_position_loss_pct),
    daily_loss_halt_pct: Number(draft.daily_loss_halt_pct),
    data_feed: draft.data_feed,
    max_quote_age_sec: Number(draft.max_quote_age_sec),
    executor_interval_min: Number(draft.executor_interval_min),
    thesis_run_time_et: draft.thesis_run_time_et,
    model: {
      analysts: draft.model_analysts,
      synthesizer: draft.model_synthesizer,
      executor: draft.model_executor,
    },
  };
}

export function createConfigDraftState(
  config: Config | null,
): ConfigDraftState {
  return {
    baseline: config,
    draft: config ? toConfigDraft(config) : null,
    incoming: null,
    phase: config ? 'clean' : 'loading',
    message: null,
    fieldErrors: {},
    validationAttempt: 0,
  };
}

export function configDraftReducer(
  state: ConfigDraftState,
  action: ConfigDraftAction,
): ConfigDraftState {
  if (action.type === 'serverReceived') {
    if (equalConfig(action.config, state.baseline)) {
      return state.incoming === null
        ? state
        : { ...state, incoming: null };
    }
    if (equalConfig(action.config, state.incoming)) return state;
    const protectedDraft =
      state.phase === 'dirty'
      || state.phase === 'saving'
      || state.phase === 'error';
    if (protectedDraft) return { ...state, incoming: action.config };
    return createConfigDraftState(action.config);
  }
  if (action.type === 'patch') {
    if (!state.draft) return state;
    const draft = { ...state.draft, ...action.patch };
    return {
      ...state,
      draft,
      phase: 'dirty',
      message: null,
      fieldErrors: hasFieldErrors(state.fieldErrors)
        ? validateConfigDraft(draft)
        : state.fieldErrors,
    };
  }
  if (action.type === 'discard') {
    return createConfigDraftState(state.incoming ?? state.baseline);
  }
  if (action.type === 'validationFailed') {
    return {
      ...state,
      phase: 'error',
      message: 'Configuration was not saved. Enter a numeric value for each highlighted field.',
      fieldErrors: action.errors,
      validationAttempt: state.validationAttempt + 1,
    };
  }
  if (action.type === 'saveStarted') {
    return { ...state, phase: 'saving', message: null, fieldErrors: {} };
  }
  if (action.type === 'saveSucceeded') {
    return {
      ...createConfigDraftState(action.config),
      phase: 'saved',
      message: 'Configuration saved.',
    };
  }
  return {
    ...state,
    phase: 'error',
    message: action.message,
    fieldErrors: {},
  };
}
