import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiResult } from '../api';
import type {
  ActionState,
  OperatorAction,
  OperatorSnapshot,
  PollingState,
  ResourceHealth,
  ResourceKey,
} from './operatorState';
import { createInitialOperatorState } from './operatorState';
import type { OperatorController } from './useOperatorController';
import {
  auditFixture,
  backtestFixture,
  candidatesFixture,
  configFixture,
  offhoursPlanFixture,
  ordersFixture,
  positionsFixture,
  rthPlanFixture,
  statusFixture,
  verdictsFixture,
} from '../test/fixtures';
import type { Config } from '../types';
import { AppShellView } from './AppShell';

const NOW = Date.parse('2026-07-13T12:00:00.000Z');
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

const completeData: OperatorSnapshot = {
  status: statusFixture,
  candidates: candidatesFixture,
  thesis: offhoursPlanFixture,
  thesisRth: rthPlanFixture,
  verdicts: verdictsFixture,
  positions: positionsFixture,
  orders: ordersFixture,
  audit: auditFixture,
  config: configFixture,
  backtest: backtestFixture,
};

function freshResources(at = NOW): PollingState['resources'] {
  return Object.fromEntries(resourceKeys.map((key) => [
    key,
    { state: 'fresh', lastSuccessAt: at, error: null },
  ])) as PollingState['resources'];
}

function controller(overrides: {
  data?: Partial<OperatorSnapshot>;
  polling?: Partial<PollingState>;
  actions?: Partial<Record<OperatorAction, ActionState>>;
} = {}): OperatorController {
  const initial = createInitialOperatorState();
  return {
    ...initial,
    data: { ...completeData, ...overrides.data },
    polling: {
      ...initial.polling,
      initialLoading: false,
      connectivity: 'online',
      stale: false,
      lastAttemptAt: NOW,
      lastFullSuccessAt: NOW,
      resources: freshResources(),
      ...overrides.polling,
    },
    actions: { ...initial.actions, ...overrides.actions },
    refresh: vi.fn().mockResolvedValue(undefined),
    runAction: vi.fn().mockResolvedValue(undefined),
  };
}

function withResource(
  current: OperatorController,
  key: ResourceKey,
  health: ResourceHealth,
): OperatorController {
  return {
    ...current,
    polling: {
      ...current.polling,
      resources: { ...current.polling.resources, [key]: health },
    },
  };
}

function saveResult() {
  return vi.fn<(next: Config) => Promise<ApiResult<Config>>>()
    .mockImplementation(async (next) => ({ ok: true, data: next }));
}

function navigate(view: ResourceKey | 'overview'): void {
  act(() => {
    window.location.hash = '#/' + view;
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
}

describe('AppShellView', () => {
  beforeEach(() => {
    window.location.hash = '#/overview';
  });

  it('shows checking and loading before the first poll completes', () => {
    const initial = createInitialOperatorState();
    const loading: OperatorController = {
      ...initial,
      refresh: vi.fn().mockResolvedValue(undefined),
      runAction: vi.fn().mockResolvedValue(undefined),
    };

    render(<AppShellView controller={loading} saveConfig={saveResult()} />);

    expect(screen.getByText('Checking broker')).toBeVisible();
    expect(screen.getByText('Loading operator data.')).toBeVisible();
  });

  it('renders every preserved hash under the approved route labels with one main landmark', async () => {
    render(<AppShellView controller={controller()} saveConfig={saveResult()} />);

    expect(screen.getByRole('table', { name: 'Candidate monitor' })).toBeVisible();
    expect(screen.getAllByRole('main')).toHaveLength(1);

    navigate('thesis');
    expect(await screen.findByRole('table', { name: 'Research candidates' })).toBeVisible();
    expect(screen.getAllByRole('main')).toHaveLength(1);

    navigate('positions');
    expect(await screen.findByRole('table', { name: 'Open positions' })).toBeVisible();
    expect(screen.getAllByRole('main')).toHaveLength(1);

    navigate('backtest');
    expect(await screen.findByRole('img', { name: 'Net P&L by confidence threshold' }))
      .toBeVisible();
    expect(screen.getAllByRole('main')).toHaveLength(1);

    navigate('config');
    expect(await screen.findByRole('region', { name: 'Configuration' })).toBeVisible();
    expect(screen.getAllByRole('main')).toHaveLength(1);

    navigate('audit');
    expect(await screen.findByRole('table', { name: 'Audit events' })).toBeVisible();
    expect(screen.getAllByRole('main')).toHaveLength(1);

    const desktop = screen.getByRole('navigation', { name: 'Workspace routes' });
    expect(desktop).toHaveTextContent(
      'MonitorResearchPositionsBacktestConfigurationAudit',
    );
  });

  it.each([
    {
      name: 'regular session',
      data: {
        status: { ...statusFixture, session: 'rth' as const },
        thesis: offhoursPlanFixture,
        thesisRth: null,
      },
    },
    {
      name: 'after-hours session',
      data: {
        status: { ...statusFixture, session: 'afterhours' as const },
        thesis: null,
        thesisRth: rthPlanFixture,
      },
    },
    {
      name: 'closed session',
      data: {
        status: { ...statusFixture, session: 'closed' as const },
        thesis: offhoursPlanFixture,
        thesisRth: rthPlanFixture,
      },
    },
    {
      name: 'unknown session',
      data: {
        status: { ...statusFixture, session: null },
        thesis: offhoursPlanFixture,
        thesisRth: rthPlanFixture,
      },
    },
  ])('does not substitute an opposite-session plan during $name', ({ data }) => {
    render(
      <AppShellView
        controller={controller({ data })}
        saveConfig={saveResult()}
      />,
    );

    expect(screen.getByText('No trading plan is available.')).toBeVisible();
  });

  it('keeps the supported configuration save wired through the shell', async () => {
    const user = userEvent.setup();
    const save = saveResult();
    window.location.hash = '#/config';
    render(<AppShellView controller={controller()} saveConfig={save} />);
    const threshold = screen.getByLabelText('Confidence threshold');

    await user.clear(threshold);
    await user.type(threshold, '0.82');
    await user.click(screen.getByRole('button', { name: 'Save configuration' }));

    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(save.mock.calls[0][0].conviction_threshold).toBe(0.82);
  });

  it('lists candidate stale data with that resource own refresh age', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const base = controller({ polling: { stale: false, lastFullSuccessAt: NOW - 60_000 } });
    const stale = withResource(base, 'candidates', {
      state: 'stale',
      lastSuccessAt: NOW - 12_000,
      error: 'candidate refresh timed out',
    });

    render(<AppShellView controller={stale} saveConfig={saveResult()} />);

    expect(screen.getByText(
      'Refresh incomplete. Stale: Candidates (last updated 12s ago). Last complete refresh 1m ago.',
    )).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent('Refresh incomplete.');
    expect(screen.getByText('Stale — 1m ago')).toBeVisible();
  });

  it('lists mixed stale, error, and defensive never health in stable resource order', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    let mixed = controller({ polling: { stale: false, lastFullSuccessAt: null } });
    mixed = withResource(mixed, 'candidates', {
      state: 'stale',
      lastSuccessAt: NOW - 40_000,
      error: 'candidate timeout',
    });
    mixed = withResource(mixed, 'thesis', {
      state: 'error',
      lastSuccessAt: null,
      error: 'plan unavailable',
    });
    mixed = withResource(mixed, 'positions', {
      state: 'stale',
      lastSuccessAt: NOW - 5_000,
      error: 'position timeout',
    });
    mixed = withResource(mixed, 'orders', {
      state: 'error',
      lastSuccessAt: null,
      error: 'orders unavailable',
    });
    mixed = withResource(mixed, 'config', {
      state: 'never',
      lastSuccessAt: null,
      error: null,
    });

    render(<AppShellView controller={mixed} saveConfig={saveResult()} />);

    expect(screen.getByText(
      'Refresh incomplete. Stale: Candidates (last updated 40s ago); Positions (last updated 5s ago). '
      + 'Unavailable: Off-hours trading plan (no successful refresh); Orders (no successful refresh); '
      + 'Configuration (no successful refresh). No complete refresh has succeeded.',
    )).toBeVisible();
  });

  it('uses the offline prefix and names every unavailable resource in contract order', () => {
    const resources = Object.fromEntries(resourceKeys.map((key) => [
      key,
      { state: 'error', lastSuccessAt: null, error: 'offline' },
    ])) as PollingState['resources'];
    const offline = controller({
      polling: {
        connectivity: 'offline',
        stale: true,
        lastFullSuccessAt: null,
        resources,
      },
    });

    render(<AppShellView controller={offline} saveConfig={saveResult()} />);

    expect(screen.getByText(
      'Refresh failed. Data services are unavailable. Unavailable: '
      + 'Account and broker status (no successful refresh); Candidates (no successful refresh); '
      + 'Off-hours trading plan (no successful refresh); Regular-session trading plan (no successful refresh); '
      + 'Analyst views (no successful refresh); Positions (no successful refresh); Orders (no successful refresh); '
      + 'Audit (no successful refresh); Configuration (no successful refresh); Backtest (no successful refresh). '
      + 'No complete refresh has succeeded.',
    )).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Refresh failed. Data services are unavailable.',
    );
  });

  it('shows Broker connected only when all broker resources are fresh and error-free', () => {
    render(<AppShellView controller={controller()} saveConfig={saveResult()} />);

    expect(screen.getByText('Broker connected')).toBeVisible();
  });

  it('lets current production missing-key evidence dominate other broker health', () => {
    const missing = withResource(controller(), 'positions', {
      state: 'error',
      lastSuccessAt: null,
      error: 'paper mode requires ALPACA_PAPER_KEY and ALPACA_PAPER_SECRET in .env',
    });

    render(<AppShellView controller={missing} saveConfig={saveResult()} />);

    expect(screen.getByText('Broker credentials missing')).toBeVisible();
  });

  it.each<ResourceKey>(['status', 'positions', 'orders'])(
    'shows Broker data stale when the %s resource is stale',
    (resource) => {
      const stale = withResource(controller(), resource, {
      state: 'stale',
      lastSuccessAt: NOW - 10_000,
      error: 'broker timeout',
      });

      render(<AppShellView controller={stale} saveConfig={saveResult()} />);

      expect(screen.getByText('Broker data stale')).toBeVisible();
      expect(screen.queryByText('Broker connected')).not.toBeInTheDocument();
    },
  );

  it('shows Broker unavailable when a relevant resource has no successful data', () => {
    const unavailable = withResource(
      controller({ data: { status: null } }),
      'status',
      { state: 'error', lastSuccessAt: null, error: 'broker timeout' },
    );

    render(<AppShellView controller={unavailable} saveConfig={saveResult()} />);

    expect(screen.getByText('Broker unavailable')).toBeVisible();
  });

  it('shows Broker unavailable for a fresh non-credential embedded broker error', () => {
    const unavailable = controller({
      data: {
        positions: { positions: positionsFixture.positions, error: 'broker rejected request' },
      },
    });

    render(<AppShellView controller={unavailable} saveConfig={saveResult()} />);

    expect(screen.getByText('Broker unavailable')).toBeVisible();
  });

  it('shows Broker unavailable when fresh status has no account equity', () => {
    const unavailable = controller({
      data: { status: { ...statusFixture, equity: null } },
    });

    render(<AppShellView controller={unavailable} saveConfig={saveResult()} />);

    expect(screen.getByText('Broker unavailable')).toBeVisible();
  });

  it('keeps one conservative action alert across navigation and mobile sheet closure', async () => {
    const user = userEvent.setup();
    const message =
      'Execution check failed. Broker did not respond. '
      + 'Order submission could not be confirmed. Check broker activity before retrying.';
    const failed = controller({
      actions: {
        executionCheck: { phase: 'error', message, completedAt: NOW },
      },
    });
    render(<AppShellView controller={failed} saveConfig={saveResult()} />);

    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.getByRole('alert')).toHaveTextContent(message);
    expect(screen.queryByText('No order was submitted.')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Controls' }));
    expect(screen.getByRole('dialog', { name: 'Trading controls' })).toBeVisible();
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.getAllByRole('alert')).toHaveLength(1);

    navigate('positions');
    expect(await screen.findByRole('table', { name: 'Open positions' })).toBeVisible();
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.getByRole('alert')).toHaveTextContent(message);
  });

  it('keeps one polite global announcement for pending and successful actions', () => {
    const { rerender } = render(
      <AppShellView
        controller={controller({
          actions: {
            analysis: { phase: 'pending', startedAt: NOW },
          },
        })}
        saveConfig={saveResult()}
      />,
    );

    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getByRole('status')).toHaveTextContent('Analysis in progress.');

    rerender(
      <AppShellView
        controller={controller({
          actions: {
            analysis: {
              phase: 'success',
              message: 'Analysis started.',
              completedAt: NOW + 1,
            },
          },
        })}
        saveConfig={saveResult()}
      />,
    );

    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getByRole('status')).toHaveTextContent('Analysis started.');
  });
});
