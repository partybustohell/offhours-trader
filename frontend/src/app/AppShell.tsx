import { useCallback, type ReactNode } from 'react';
import { isMissingKeysError, putConfig, type ApiResult } from '../api';
import {
  OperationalHeader,
  type BrokerState,
} from '../components/shell/OperationalHeader';
import { StatusMessage } from '../components/workspace/StatusMessage';
import { formatRefreshAge } from '../presentation/format';
import { ROUTES, useHashView } from '../router';
import type { Config } from '../types';
import { AuditView } from '../views/AuditView';
import { BacktestView } from '../views/BacktestView';
import { ConfigurationView } from '../views/ConfigurationView';
import { MonitorView } from '../views/MonitorView';
import { PositionsView } from '../views/PositionsView';
import { ResearchView } from '../views/ResearchView';
import type {
  ActionState,
  OperatorAction,
  OperatorSnapshot,
  PollingState,
  ResourceKey,
} from './operatorState';
import type { OperatorController } from './useOperatorController';
import { useOperatorController } from './useOperatorController';

function activePlanForSnapshot(data: OperatorSnapshot) {
  const session = data.status?.session;
  if (session === 'rth') {
    return data.thesisRth?.kind === 'rth' ? data.thesisRth : null;
  }
  if (session === 'premarket' || session === 'afterhours') {
    return data.thesis?.kind === 'offhours' ? data.thesis : null;
  }
  return null;
}

const resourceOrder: readonly { key: ResourceKey; label: string }[] = [
  { key: 'status', label: 'Account and broker status' },
  { key: 'candidates', label: 'Candidates' },
  { key: 'thesis', label: 'Off-hours trading plan' },
  { key: 'thesisRth', label: 'Regular-session trading plan' },
  { key: 'verdicts', label: 'Analyst views' },
  { key: 'positions', label: 'Positions' },
  { key: 'orders', label: 'Orders' },
  { key: 'audit', label: 'Audit' },
  { key: 'config', label: 'Configuration' },
  { key: 'backtest', label: 'Backtest' },
];

const brokerResources = ['status', 'positions', 'orders'] as const;

function embeddedBrokerErrors(
  data: OperatorSnapshot,
  polling: PollingState,
): string[] {
  const errors: (string | undefined)[] = [
    polling.resources.status.state === 'fresh' ? data.status?.error : undefined,
    polling.resources.positions.state === 'fresh' ? data.positions.error : undefined,
    polling.resources.orders.state === 'fresh' ? data.orders.error : undefined,
  ];
  return errors.filter((error): error is string => typeof error === 'string');
}

function deriveBrokerState(
  data: OperatorSnapshot,
  polling: PollingState,
): BrokerState {
  if (polling.initialLoading) return 'checking';

  const health = brokerResources.map((key) => polling.resources[key]);
  const currentHealthErrors = health.flatMap((resource) =>
    resource.error === null ? [] : [resource.error]
  );
  const embeddedErrors = embeddedBrokerErrors(data, polling);
  if ([...currentHealthErrors, ...embeddedErrors].some(isMissingKeysError)) {
    return 'missing-credentials';
  }
  if (health.some((resource) => resource.state === 'error') || embeddedErrors.length > 0) {
    return 'unavailable';
  }
  if (health.some((resource) => resource.state === 'stale')) return 'stale';
  if (health.some((resource) => resource.state !== 'fresh')) return 'unavailable';
  return data.status !== null && data.status.equity !== null ? 'connected' : 'unavailable';
}

function resourceHealthSummary(polling: PollingState, now: number): string | null {
  if (polling.initialLoading) return null;
  const stale: string[] = [];
  const unavailable: string[] = [];

  for (const resource of resourceOrder) {
    const health = polling.resources[resource.key];
    if (health.state === 'fresh') continue;
    if (health.state === 'stale' && health.lastSuccessAt !== null) {
      stale.push(
        resource.label + ' (last updated '
          + formatRefreshAge(health.lastSuccessAt, now) + ')',
      );
    } else {
      unavailable.push(resource.label + ' (no successful refresh)');
    }
  }

  if (stale.length === 0 && unavailable.length === 0) return null;
  const parts = [
    polling.connectivity === 'offline'
      ? 'Refresh failed. Data services are unavailable.'
      : 'Refresh incomplete.',
  ];
  if (stale.length > 0) parts.push('Stale: ' + stale.join('; ') + '.');
  if (unavailable.length > 0) {
    parts.push('Unavailable: ' + unavailable.join('; ') + '.');
  }
  parts.push(
    polling.lastFullSuccessAt === null
      ? 'No complete refresh has succeeded.'
      : 'Last complete refresh ' + formatRefreshAge(polling.lastFullSuccessAt, now) + '.',
  );
  return parts.join(' ');
}

const actionOrder: OperatorAction[] = ['analysis', 'executionCheck', 'halt', 'resume'];
const actionLabels: Record<OperatorAction, string> = {
  analysis: 'Analysis',
  executionCheck: 'Execution check',
  halt: 'Halt',
  resume: 'Resume',
};

interface ActionFeedback {
  phase: Exclude<ActionState['phase'], 'idle'>;
  message: string;
  at: number;
}

function latestActionFeedback(
  actions: Record<OperatorAction, ActionState>,
): ActionFeedback | null {
  let latest: ActionFeedback | null = null;
  for (const action of actionOrder) {
    const state = actions[action];
    if (state.phase === 'idle') continue;
    const feedback: ActionFeedback = state.phase === 'pending'
      ? {
          phase: 'pending',
          message: actionLabels[action] + ' in progress.',
          at: state.startedAt,
        }
      : {
          phase: state.phase,
          message: state.message,
          at: state.completedAt,
        };
    if (latest === null || feedback.at >= latest.at) latest = feedback;
  }
  return latest;
}

export interface AppShellViewProps {
  controller: OperatorController;
  saveConfig(next: Config): Promise<ApiResult<Config>>;
}

export function AppShellView({ controller, saveConfig }: AppShellViewProps) {
  const [view, navigate] = useHashView();
  const data = controller.data;
  const activePlan = activePlanForSnapshot(data);
  let route: ReactNode;

  if (view === 'overview') {
    route = (
      <MonitorView
        status={data.status}
        positions={data.positions}
        candidates={data.candidates}
        verdicts={data.verdicts}
        activePlan={activePlan}
        audit={data.audit}
        config={data.config}
      />
    );
  } else if (view === 'thesis') {
    route = (
      <ResearchView
        candidates={data.candidates}
        verdicts={data.verdicts}
        offhoursPlan={data.thesis}
        rthPlan={data.thesisRth}
        config={data.config}
      />
    );
  } else if (view === 'positions') {
    route = (
      <PositionsView
        positions={data.positions}
        orders={data.orders}
        audit={data.audit}
      />
    );
  } else if (view === 'backtest') {
    route = <BacktestView backtest={data.backtest} />;
  } else if (view === 'config') {
    route = <ConfigurationView config={data.config} onSave={saveConfig} />;
  } else {
    route = <AuditView events={data.audit} />;
  }

  const now = Date.now();
  const healthSummary = resourceHealthSummary(controller.polling, now);
  const actionFeedback = latestActionFeedback(controller.actions);

  return (
    <div className="app-shell">
      <OperationalHeader
        state={{
          mode: data.status?.mode ?? data.config?.mode ?? null,
          session: data.status?.session ?? null,
          broker: deriveBrokerState(data, controller.polling),
          dataFeed: data.config?.data_feed ?? null,
          halt: data.status?.halt ?? null,
          polling: controller.polling,
        }}
        routes={ROUTES}
        activeView={view}
        actionStates={controller.actions}
        onNavigate={navigate}
        onAction={controller.runAction}
      />
      <div className="app-shell__messages">
        {controller.polling.initialLoading ? (
          <StatusMessage
            tone="loading"
            announce={actionFeedback === null ? 'polite' : 'off'}
          >
            Loading operator data.
          </StatusMessage>
        ) : null}
        {healthSummary ? (
          <StatusMessage
            tone={controller.polling.connectivity === 'offline' ? 'error' : 'stale'}
            announce={controller.polling.connectivity === 'offline' ? 'assertive' : 'polite'}
          >
            {healthSummary}
          </StatusMessage>
        ) : null}
        {actionFeedback?.phase === 'error' ? (
          <StatusMessage tone="error" announce="assertive">
            {actionFeedback.message}
          </StatusMessage>
        ) : actionFeedback ? (
          <StatusMessage
            tone={actionFeedback.phase === 'success' ? 'success' : 'loading'}
            announce="polite"
          >
            {actionFeedback.message}
          </StatusMessage>
        ) : null}
      </div>
      <div className="app-shell__workspace">{route}</div>
    </div>
  );
}

export function AppShell() {
  const controller = useOperatorController();
  const refresh = controller.refresh;
  const saveConfig = useCallback(async (next: Config) => {
    const result = await putConfig(next);
    if (result.ok) await refresh();
    return result;
  }, [refresh]);
  return <AppShellView controller={controller} saveConfig={saveConfig} />;
}
