import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchAudit,
  fetchBacktest,
  fetchCandidates,
  fetchConfig,
  fetchOrders,
  fetchPositions,
  fetchStatus,
  fetchThesis,
  fetchVerdicts,
  postAction,
  type ApiResult,
} from '../api';
import {
  applyPoll,
  createInitialOperatorState,
  markRefreshing,
  setActionState,
  type OperatorAction,
  type OperatorState,
  type PollResults,
} from './operatorState';

export interface OperatorApi {
  poll(): Promise<PollResults>;
  action(action: OperatorAction): Promise<ApiResult<unknown>>;
}

export interface OperatorController extends OperatorState {
  refresh(): Promise<void>;
  runAction(action: OperatorAction): Promise<void>;
}

const paths: Record<OperatorAction, Parameters<typeof postAction>[0]> = {
  analysis: '/api/pipeline/run',
  executionCheck: '/api/executor/tick',
  halt: '/api/halt',
  resume: '/api/resume',
};

function errorText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

async function settlePoll(): Promise<PollResults> {
  const requests = {
    status: fetchStatus(),
    candidates: fetchCandidates(),
    thesis: fetchThesis('offhours'),
    thesisRth: fetchThesis('rth'),
    verdicts: fetchVerdicts(),
    positions: fetchPositions(),
    orders: fetchOrders(),
    audit: fetchAudit(200),
    config: fetchConfig(),
    backtest: fetchBacktest(),
  };
  const keys = Object.keys(requests) as (keyof typeof requests)[];
  const settled = await Promise.allSettled(keys.map((key) => requests[key]));
  return Object.fromEntries(settled.map((result, index) => {
    const key = keys[index];
    return [
      key,
      result.status === 'fulfilled'
        ? { ok: true, value: result.value }
        : { ok: false, error: errorText(result.reason) },
    ];
  })) as PollResults;
}

export const operatorApi: OperatorApi = {
  poll: settlePoll,
  action: (action) => postAction(paths[action]),
};

const labels: Record<OperatorAction, string> = {
  analysis: 'Analysis',
  executionCheck: 'Execution check',
  halt: 'Halt',
  resume: 'Resume',
};

const successMessages: Record<OperatorAction, string> = {
  analysis: 'Analysis started.',
  executionCheck: 'Execution check started.',
  halt: 'Trading halted.',
  resume: 'Trading resumed.',
};

function actionError(action: OperatorAction, error: string): string {
  const trimmed = error.trim();
  const cause = /[.!?]$/.test(trimmed) ? trimmed : trimmed + '.';
  const suffix = action === 'executionCheck'
    ? ' Order submission could not be confirmed. Check broker activity before retrying.'
    : '';
  return labels[action] + ' failed. ' + cause + suffix;
}

export function useOperatorController(
  api: OperatorApi = operatorApi,
  intervalMs = 10_000,
): OperatorController {
  const [state, setState] = useState(createInitialOperatorState);
  const activeRefresh = useRef<Promise<void> | null>(null);
  const mounted = useRef(true);

  const refresh = useCallback((): Promise<void> => {
    if (activeRefresh.current) return activeRefresh.current;
    setState((current) => markRefreshing(current, Date.now()));

    const request = (async () => {
      const results = await api.poll();
      if (mounted.current) setState((current) => applyPoll(current, results, Date.now()));
    })();
    let tracked: Promise<void>;
    tracked = request.finally(() => {
      if (activeRefresh.current === tracked) activeRefresh.current = null;
    });
    activeRefresh.current = tracked;
    return tracked;
  }, [api]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, intervalMs);
    return () => {
      mounted.current = false;
      window.clearInterval(timer);
    };
  }, [intervalMs, refresh]);

  const runAction = useCallback(async (action: OperatorAction) => {
    const startedAt = Date.now();
    setState((current) => setActionState(current, action, { phase: 'pending', startedAt }));
    const result = await api.action(action);
    if (!mounted.current) return;
    if (!result.ok) {
      setState((current) => setActionState(current, action, {
        phase: 'error',
        message: actionError(action, result.error),
        completedAt: Date.now(),
      }));
      return;
    }
    setState((current) => setActionState(current, action, {
      phase: 'success',
      message: successMessages[action],
      completedAt: Date.now(),
    }));
    const active = activeRefresh.current;
    if (active) {
      try {
        await active;
      } catch {
        // A failed active poll must not consume the mutation's trailing refresh.
      }
    }
    if (mounted.current) await refresh();
  }, [api, refresh]);

  return { ...state, refresh, runAction };
}
