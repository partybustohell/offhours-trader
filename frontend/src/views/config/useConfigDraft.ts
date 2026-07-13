import { useCallback, useEffect, useReducer } from 'react';
import type { ApiResult } from '../../api';
import type { Config } from '../../types';
import {
  configDraftReducer,
  createConfigDraftState,
  toConfigPayload,
  validateConfigDraft,
  type ConfigDraft,
  type ConfigDraftFieldErrors,
  type ConfigDraftPhase,
} from './configDraft';

export interface ConfigDraftController {
  draft: ConfigDraft | null;
  phase: ConfigDraftPhase;
  serverUpdateAvailable: boolean;
  message: string | null;
  fieldErrors: ConfigDraftFieldErrors;
  validationAttempt: number;
  patch(change: Partial<ConfigDraft>): void;
  discard(): void;
  save(): Promise<void>;
}

function hasFieldErrors(errors: ConfigDraftFieldErrors): boolean {
  return Object.keys(errors).length > 0;
}

function backendFailureMessage(error: string): string {
  const trimmed = error.trim();
  const cause = trimmed === ''
    ? 'The server rejected the configuration.'
    : /[.!?]$/.test(trimmed)
      ? trimmed
      : trimmed + '.';
  return 'Configuration was not saved. '
    + cause
    + ' Review the values and try again.';
}

export function useConfigDraft(
  config: Config | null,
  onSave: (next: Config) => Promise<ApiResult<Config>>,
): ConfigDraftController {
  const [state, dispatch] = useReducer(
    configDraftReducer,
    config,
    createConfigDraftState,
  );

  useEffect(() => {
    if (config) dispatch({ type: 'serverReceived', config });
  }, [config]);

  const save = useCallback(async () => {
    if (!state.draft || !state.baseline) return;

    const fieldErrors = validateConfigDraft(state.draft);
    if (hasFieldErrors(fieldErrors)) {
      dispatch({ type: 'validationFailed', errors: fieldErrors });
      return;
    }

    const payload = toConfigPayload(
      state.draft,
      state.incoming ?? state.baseline,
    );
    dispatch({ type: 'saveStarted' });
    const result = await onSave(payload);
    if (result.ok) {
      dispatch({ type: 'saveSucceeded', config: result.data });
    } else {
      dispatch({
        type: 'saveFailed',
        message: backendFailureMessage(result.error),
      });
    }
  }, [onSave, state.baseline, state.draft, state.incoming]);

  return {
    draft: state.draft,
    phase: state.phase,
    serverUpdateAvailable: state.incoming !== null,
    message: state.message,
    fieldErrors: state.fieldErrors,
    validationAttempt: state.validationAttempt,
    patch(change) {
      dispatch({ type: 'patch', patch: change });
    },
    discard() {
      dispatch({ type: 'discard' });
    },
    save,
  };
}
