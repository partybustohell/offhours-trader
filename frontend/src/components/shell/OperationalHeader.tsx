import { useEffect, useRef, useState } from 'react';
import type {
  ActionState,
  OperatorAction,
  PollingState,
} from '../../app/operatorState';
import { formatEtTimestamp, formatRefreshAge } from '../../presentation/format';
import type { RouteItem, ViewId } from '../../router';
import type { Config, HaltState, Mode, Session } from '../../types';
import { ActionControl } from '../workspace/ActionControl';
import { SemanticText } from '../workspace/SemanticText';
import { MobileControlSheet } from './MobileControlSheet';
import { WorkspaceTabs } from './WorkspaceTabs';

export type BrokerState =
  | 'checking'
  | 'connected'
  | 'missing-credentials'
  | 'stale'
  | 'unavailable';

export interface OperationalState {
  mode: Mode | null;
  session: Session | null;
  broker: BrokerState;
  dataFeed: Config['data_feed'] | null;
  halt: HaltState | null;
  polling: PollingState;
}

export interface OperationalHeaderProps {
  state: OperationalState;
  routes: readonly RouteItem[];
  activeView: ViewId;
  actionStates: Record<OperatorAction, ActionState>;
  onNavigate(view: ViewId): void;
  onAction(action: OperatorAction): Promise<void>;
}

function brokerText(state: BrokerState): string {
  if (state === 'checking') return 'Checking broker';
  if (state === 'connected') return 'Broker connected';
  if (state === 'missing-credentials') return 'Broker credentials missing';
  if (state === 'stale') return 'Broker data stale';
  return 'Broker unavailable';
}

function modeText(mode: Mode | null): string {
  if (mode === 'dry-run') return 'Dry run';
  if (mode === 'paper') return 'Paper';
  if (mode === 'live') return 'Live';
  return 'Mode unknown';
}

function sessionText(session: Session | null): string {
  if (session === 'premarket') return 'Premarket';
  if (session === 'rth') return 'Regular session';
  if (session === 'afterhours') return 'After-hours';
  if (session === 'closed') return 'Market closed';
  return 'Session unknown';
}

function hasResourceProblem(polling: PollingState): boolean {
  return Object.values(polling.resources).some((resource) => resource.state !== 'fresh');
}

export function OperationalHeader({
  state,
  routes,
  activeView,
  actionStates,
  onNavigate,
  onAction,
}: OperationalHeaderProps) {
  const [now, setNow] = useState(Date.now());
  const [controlsOpen, setControlsOpen] = useState(false);
  const controlsButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const halted = state.halt?.halted === true;
  const refreshText = formatRefreshAge(state.polling.lastFullSuccessAt, now);
  const resourceProblem = !state.polling.initialLoading && hasResourceProblem(state.polling);
  const refreshState = state.polling.initialLoading
    ? 'Checking data'
    : state.polling.connectivity === 'offline'
      ? 'Offline — ' + refreshText
      : resourceProblem
        ? 'Stale — ' + refreshText
        : 'Updated ' + refreshText;
  const etClock = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(now)) + ' ET';
  const navigate = (view: ViewId) => {
    setControlsOpen(false);
    onNavigate(view);
  };

  return (
    <header className="operational-header">
      <div className="operational-header__primary">
        <a
          className="product-name"
          href="#/overview"
          onClick={(event) => {
            event.preventDefault();
            navigate('overview');
          }}
        >
          Offhours
        </a>
        <WorkspaceTabs routes={routes} activeView={activeView} onNavigate={navigate} />
        <button
          className="mobile-controls-trigger"
          ref={controlsButton}
          type="button"
          aria-expanded={controlsOpen}
          onClick={() => setControlsOpen(true)}
        >
          Controls
        </button>
      </div>
      <div className="operational-header__state" aria-label="Operational state">
        <span>{modeText(state.mode)}</span>
        <SemanticText tone={state.session === 'closed' ? 'warning' : 'neutral'}>
          {sessionText(state.session)}
        </SemanticText>
        <SemanticText tone={
          state.broker === 'connected'
            ? 'positive'
            : state.broker === 'unavailable'
              ? 'negative'
              : state.broker === 'missing-credentials' || state.broker === 'stale'
                ? 'warning'
                : 'neutral'
        }>
          {brokerText(state.broker)}
        </SemanticText>
        <span>{state.dataFeed ? state.dataFeed.toUpperCase() + ' feed' : 'Feed unknown'}</span>
        <SemanticText tone={
          state.polling.connectivity === 'offline'
            ? 'negative'
            : resourceProblem || state.polling.initialLoading
              ? 'warning'
              : 'positive'
        }>
          {refreshState}
        </SemanticText>
        <SemanticText tone={
          state.halt === null
            ? 'neutral'
            : halted
              ? 'negative'
              : 'positive'
        }>
          {state.halt === null
            ? 'Risk state unknown'
            : halted
              ? 'Halted — ' + (state.halt.reason || 'Reason not recorded')
                + (state.halt.at ? ', ' + formatEtTimestamp(state.halt.at) : '')
              : 'Risk clear'}
        </SemanticText>
        <time>{etClock}</time>
      </div>
      <div className="operational-header__actions">
        <ActionControl
          action="analysis"
          label="Run analysis"
          state={actionStates.analysis}
          showResult={false}
          onInvoke={onAction}
        />
        <ActionControl
          action="executionCheck"
          label="Check execution now"
          state={actionStates.executionCheck}
          showResult={false}
          onInvoke={onAction}
        />
        <ActionControl
          action={halted ? 'resume' : 'halt'}
          label={halted ? 'Resume trading' : 'Halt trading'}
          state={halted ? actionStates.resume : actionStates.halt}
          tone={halted ? 'routine' : 'danger'}
          confirmation={halted ? undefined : {
            title: 'Halt trading?',
            body: 'New entries will remain blocked until trading is resumed.',
            confirmLabel: 'Halt trading',
          }}
          showResult={false}
          onInvoke={onAction}
        />
      </div>
      <MobileControlSheet
        open={controlsOpen}
        triggerRef={controlsButton}
        mode={state.mode}
        session={state.session}
        broker={state.broker}
        halted={halted}
        refreshText={refreshText}
        actions={actionStates}
        onAction={onAction}
        onClose={() => setControlsOpen(false)}
      />
    </header>
  );
}
