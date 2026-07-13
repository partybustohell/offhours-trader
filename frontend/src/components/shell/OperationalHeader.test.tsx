import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createInitialOperatorState } from '../../app/operatorState';
import { ROUTES } from '../../router';
import { OperationalHeader } from './OperationalHeader';

describe('OperationalHeader', () => {
  it('shows clinical operational state, halt detail, and routine controls', () => {
    const base = createInitialOperatorState();
    render(
      <OperationalHeader
        state={{
          mode: 'paper',
          session: 'closed',
          broker: 'missing-credentials',
          dataFeed: 'iex',
          halt: {
            halted: true,
            reason: 'manual halt',
            at: '2026-07-12T14:00:00.000Z',
          },
          polling: {
            ...base.polling,
            initialLoading: false,
            stale: true,
            lastFullSuccessAt: 1,
          },
        }}
        routes={ROUTES}
        activeView="overview"
        actionStates={base.actions}
        onNavigate={vi.fn()}
        onAction={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(screen.getByText('Broker credentials missing')).toBeVisible();
    expect(screen.getByText(/Halted — manual halt/)).toBeVisible();
    expect(screen.getByText(/Stale/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Resume trading' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Controls' })).toBeVisible();
  });

  it('does not duplicate action result announcements owned by AppShell', () => {
    const base = createInitialOperatorState();
    render(
      <OperationalHeader
        state={{
          mode: 'paper',
          session: 'afterhours',
          broker: 'connected',
          dataFeed: 'iex',
          halt: null,
          polling: {
            ...base.polling,
            initialLoading: false,
            stale: false,
            lastFullSuccessAt: Date.now(),
          },
        }}
        routes={ROUTES}
        activeView="overview"
        actionStates={{
          ...base.actions,
          executionCheck: {
            phase: 'error',
            message: 'Execution check failed.',
            completedAt: 1,
          },
        }}
        onNavigate={vi.fn()}
        onAction={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('does not claim risk is clear before halt state is recorded', () => {
    const base = createInitialOperatorState();
    render(
      <OperationalHeader
        state={{
          mode: null,
          session: null,
          broker: 'checking',
          dataFeed: null,
          halt: null,
          polling: base.polling,
        }}
        routes={ROUTES}
        activeView="overview"
        actionStates={base.actions}
        onNavigate={vi.fn()}
        onAction={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(screen.getByText('Risk state unknown')).toBeVisible();
    expect(screen.queryByText('Risk clear')).not.toBeInTheDocument();
  });
});
