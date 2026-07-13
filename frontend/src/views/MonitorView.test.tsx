import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  auditFixture,
  candidatesFixture,
  configFixture,
  offhoursPlanFixture,
  positionsFixture,
  statusFixture,
  verdictsFixture,
} from '../test/fixtures';
import { setViewport } from '../test/viewport';
import type { AuditEvent } from '../types';
import { MonitorView } from './MonitorView';

const fixedNow = Date.parse('2026-07-13T12:00:00.000Z');

const props = {
  status: statusFixture,
  positions: positionsFixture,
  candidates: candidatesFixture,
  verdicts: verdictsFixture,
  activePlan: offhoursPlanFixture,
  audit: auditFixture,
  config: configFixture,
  now: fixedNow,
};

function definitionValue(label: string): HTMLElement {
  const value = screen.getByText(label, { selector: 'dt' }).nextElementSibling;
  if (!(value instanceof HTMLElement)) {
    throw new Error('Definition value missing for ' + label + '.');
  }
  return value;
}

function semanticDefinitionValue(label: string): HTMLElement {
  const value = definitionValue(label).querySelector('.semantic-text');
  if (!(value instanceof HTMLElement)) {
    throw new Error('Semantic definition value missing for ' + label + '.');
  }
  return value;
}

describe('MonitorView', () => {
  it('makes the candidate table dominant and links a selected row to detail', async () => {
    render(<MonitorView {...props} />);
    expect(screen.getByRole('table', { name: 'Candidate monitor' })).toBeVisible();
    expect(screen.getByRole('region', { name: 'Candidate detail' })).toHaveTextContent(
      'AMD',
    );

    await userEvent.click(screen.getByRole('row', { name: 'Inspect WBD' }));

    expect(screen.getByRole('region', { name: 'Candidate detail' })).toHaveTextContent(
      'No entry for WBD',
    );
    expect(screen.getByRole('region', { name: 'Candidate detail' })).toHaveTextContent(
      'Not recorded',
    );
  });

  it('uses clinical semantic tones for recorded candidate direction, outcome, and activity', () => {
    render(<MonitorView {...props} />);

    const candidateTable = screen.getByRole('table', { name: 'Candidate monitor' });
    const amd = within(candidateTable).getByRole('row', { name: 'Inspect AMD' });
    expect(within(amd).getByText('Long')).toHaveClass(
      'semantic-text',
      'semantic-text--positive',
    );
    expect(within(amd).getByText('Selected for the trading plan')).toHaveClass(
      'semantic-text',
      'semantic-text--positive',
    );
    const wbd = within(candidateTable).getByRole('row', { name: 'Inspect WBD' });
    expect(within(wbd).getByText(/Not selected —/)).toHaveClass(
      'semantic-text',
      'semantic-text--neutral',
    );

    const activity = screen.getByRole('table', { name: 'Recent activity' });
    expect(
      within(within(activity).getByText('Completed').closest('tr')!).getByText('Completed'),
    ).toHaveClass('semantic-text', 'semantic-text--positive');
    expect(
      within(within(activity).getByText('Rejected').closest('tr')!).getByText('Rejected'),
    ).toHaveClass('semantic-text', 'semantic-text--negative');
  });

  it('states unavailable account data without estimating it', () => {
    render(<MonitorView {...props} />);
    expect(screen.getByText('Daily deployment used')).toBeVisible();
    expect(screen.getByText('Daily deployment used').nextElementSibling).toHaveTextContent(
      'Not available from current API',
    );
  });

  it('renders configured risk limits as percentage points', () => {
    render(
      <MonitorView
        {...props}
        config={{ ...configFixture, max_daily_deploy_pct: 10 }}
      />,
    );

    const limit = definitionValue('Daily deployment limit');
    expect(limit).toHaveTextContent(/^10%$/);
    expect(limit).not.toHaveTextContent('1000%');
  });

  it('reports successful empty positions as zero and failed position reads as unavailable', () => {
    const { rerender } = render(
      <MonitorView {...props} positions={{ positions: [] }} />,
    );

    expect(screen.getByText('Open exposure').nextElementSibling).toHaveTextContent(/^\$0\.00$/);
    expect(screen.getByText('Open positions').nextElementSibling).toHaveTextContent(/^0$/);
    expect(screen.getByText('Open gain/loss').nextElementSibling).toHaveTextContent(/^\$0\.00$/);
    expect(semanticDefinitionValue('Open gain/loss')).toHaveClass(
      'semantic-text',
      'semantic-text--neutral',
    );

    rerender(
      <MonitorView
        {...props}
        positions={{ positions: [], error: 'Broker position read failed.' }}
      />,
    );

    expect(screen.getByText('Open exposure').nextElementSibling).toHaveTextContent(/^Not available$/);
    expect(screen.getByText('Open positions').nextElementSibling).toHaveTextContent(/^Not available$/);
    expect(screen.getByText('Open gain/loss').nextElementSibling).toHaveTextContent(/^Not available$/);
    expect(semanticDefinitionValue('Open gain/loss')).toHaveClass(
      'semantic-text',
      'semantic-text--neutral',
    );
  });

  it('uses signed semantic tones for positive and negative open gain/loss', () => {
    const { rerender } = render(<MonitorView {...props} />);

    expect(screen.getByText('Open gain/loss').nextElementSibling).toHaveTextContent(/^\+\$88\.00$/);
    expect(semanticDefinitionValue('Open gain/loss')).toHaveClass(
      'semantic-text',
      'semantic-text--positive',
    );
    expect(semanticDefinitionValue('Open gain/loss')).not.toHaveClass(
      'semantic-text--negative',
    );

    rerender(
      <MonitorView
        {...props}
        positions={{
          positions: positionsFixture.positions.map((position) => ({
            ...position,
            unrealizedPl: -88,
          })),
        }}
      />,
    );

    expect(screen.getByText('Open gain/loss').nextElementSibling).toHaveTextContent(/^-\$88\.00$/);
    expect(semanticDefinitionValue('Open gain/loss')).toHaveClass(
      'semantic-text',
      'semantic-text--negative',
    );
    expect(semanticDefinitionValue('Open gain/loss')).not.toHaveClass(
      'semantic-text--positive',
    );
  });

  it('does not aggregate any non-finite position value', () => {
    render(
      <MonitorView
        {...props}
        positions={{
          positions: [
            ...positionsFixture.positions,
            {
              ...positionsFixture.positions[0],
              ticker: 'WBD',
              marketValue: Number.NaN,
              unrealizedPl: Number.POSITIVE_INFINITY,
            },
          ],
        }}
      />,
    );

    expect(screen.getByText('Open positions').nextElementSibling).toHaveTextContent(/^2$/);
    expect(screen.getByText('Open exposure').nextElementSibling).toHaveTextContent(
      /^Not available$/,
    );
    expect(screen.getByText('Open gain/loss').nextElementSibling).toHaveTextContent(
      /^Not available$/,
    );
    expect(semanticDefinitionValue('Open gain/loss')).toHaveClass(
      'semantic-text',
      'semantic-text--neutral',
    );
  });

  it('only reports a clear risk halt when the API explicitly reports it', () => {
    const { rerender } = render(<MonitorView {...props} status={null} />);

    expect(screen.getByText('Risk halt').nextElementSibling).toHaveTextContent('Not available');
    expect(semanticDefinitionValue('Risk halt')).toHaveClass(
      'semantic-text',
      'semantic-text--neutral',
    );

    rerender(<MonitorView {...props} status={{ ...statusFixture, halt: null }} />);
    expect(screen.getByText('Risk halt').nextElementSibling).toHaveTextContent('Not available');
    expect(semanticDefinitionValue('Risk halt')).toHaveClass(
      'semantic-text',
      'semantic-text--neutral',
    );

    rerender(
      <MonitorView
        {...props}
        status={{
          ...statusFixture,
          halt: { halted: false, reason: '', at: '2026-07-13T12:00:00.000Z' },
        }}
      />,
    );
    expect(screen.getByText('Risk halt').nextElementSibling).toHaveTextContent('Clear');
    expect(semanticDefinitionValue('Risk halt')).toHaveClass(
      'semantic-text',
      'semantic-text--positive',
    );
  });

  it('states the closed-market execution consequence', () => {
    render(
      <MonitorView
        {...props}
        status={{ ...statusFixture, session: 'closed' }}
      />,
    );
    expect(screen.getByText(
      'The market is closed. An execution check will be recorded without submitting an order.',
    )).toBeVisible();
  });

  it('does not infer the next execution check from the last tick and config interval', () => {
    render(
      <MonitorView
        {...props}
        audit={[
          ...auditFixture,
          { ts: '2026-07-13T12:00:00.000Z', kind: 'tick', data: {} },
        ]}
      />,
    );

    expect(screen.getByText('Next execution check').nextElementSibling).toHaveTextContent(
      'Not available from current API',
    );
  });

  it('does not throw when the latest execution check has an invalid timestamp', () => {
    expect(() => render(
      <MonitorView
        {...props}
        audit={[
          ...auditFixture,
          { ts: 'not-a-timestamp', kind: 'tick', data: {} },
        ]}
      />,
    )).not.toThrow();

    expect(screen.getByText('Last execution check').nextElementSibling).toHaveTextContent(
      'Execution check recorded. Not recorded',
    );
  });

  it('uses the newest valid analysis timestamp ahead of invalid events', () => {
    const audit = [
      {
        ts: 'invalid-analysis-first',
        kind: 'thesis',
        data: { reason: 'Invalid analysis timestamp' },
      },
      {
        ts: '2026-07-13T12:20:00.000Z',
        kind: 'candidates',
        data: { reason: 'Older valid analysis' },
      },
      {
        ts: '2026-07-13T12:30:00.000Z',
        kind: 'thesis',
        data: { reason: 'Newest valid analysis' },
      },
    ] satisfies AuditEvent[];
    render(<MonitorView {...props} audit={audit} />);

    expect(screen.getByText('Latest analysis').nextElementSibling).toHaveTextContent(
      'Trading plan. Newest valid analysis. 08:30:00 ET',
    );
  });

  it('uses the newest valid execution timestamp ahead of invalid events', () => {
    const audit = [
      {
        ts: 'invalid-tick-first',
        kind: 'tick',
        data: { reason: 'Invalid execution timestamp' },
      },
      {
        ts: '2026-07-13T12:10:00.000Z',
        kind: 'tick',
        data: { reason: 'Older valid execution' },
      },
      {
        ts: '2026-07-13T12:40:00.000Z',
        kind: 'tick',
        data: { reason: 'Newest valid execution' },
      },
    ] satisfies AuditEvent[];
    render(<MonitorView {...props} audit={audit} />);

    expect(screen.getByText('Last execution check').nextElementSibling).toHaveTextContent(
      'Execution check. Newest valid execution. 08:40:00 ET',
    );
  });

  it('distinguishes active, expired, and missing trading plans', () => {
    const { rerender } = render(<MonitorView {...props} />);
    expect(screen.getByText('1 selected, 1 not selected.')).toBeVisible();
    rerender(
      <MonitorView
        {...props}
        activePlan={{ ...offhoursPlanFixture, expiresAt: '2020-01-01T00:00:00.000Z' }}
      />,
    );
    expect(screen.getByText(/The latest trading plan expired at/)).toBeVisible();
    rerender(
      <MonitorView
        {...props}
        now={Date.parse(offhoursPlanFixture.expiresAt)}
      />,
    );
    expect(screen.getByText(/The latest trading plan expired at/)).toBeVisible();
    rerender(
      <MonitorView
        {...props}
        activePlan={{ ...offhoursPlanFixture, expiresAt: 'not-a-timestamp' }}
      />,
    );
    expect(screen.getByText('Trading plan expiry was not recorded.')).toBeVisible();
    rerender(<MonitorView {...props} activePlan={null} />);
    expect(screen.getByText('No trading plan is available.')).toBeVisible();
  });

  it('sorts activity by parsed time, preserves invalid-time order, and expands raw unknown data', async () => {
    const audit = [
      {
        ts: 'invalid-first',
        kind: 'mystery_event',
        data: { status: 'skipped', detail: 'Payload remains inspectable.' },
      },
      { ts: '2026-07-13T12:10:00.000Z', kind: 'thesis', data: {} },
      { ts: 'invalid-second', kind: 'error', data: { message: 'Invalid-time event.' } },
      { ts: '2026-07-13T12:30:00.000Z', kind: 'tick', data: {} },
    ] satisfies AuditEvent[];
    render(<MonitorView {...props} audit={audit} />);

    const activityRows = within(screen.getByRole('table', { name: 'Recent activity' }))
      .getAllByRole('row')
      .slice(1);
    expect(activityRows).toHaveLength(4);
    expect(activityRows[0]).toHaveTextContent('Execution check');
    expect(activityRows[1]).toHaveTextContent('Trading plan');
    expect(activityRows[2]).toHaveTextContent('Unknown event');
    expect(activityRows[3]).toHaveTextContent('System error');

    const unknownRow = screen.getByText('Unknown event').closest('tr');
    expect(unknownRow).toHaveTextContent('Unknown');
    expect(unknownRow).not.toHaveTextContent('Skipped');
    expect(within(unknownRow!).getByText('Unknown')).toHaveClass(
      'semantic-text',
      'semantic-text--neutral',
    );
    await userEvent.click(unknownRow!);

    expect(screen.getByText('Raw kind')).toBeVisible();
    expect(screen.getByText('mystery_event')).toBeVisible();
    expect(screen.getByText(/"status": "skipped"/)).toBeVisible();
  });

  it('shows production executor skips with warning semantics', () => {
    render(
      <MonitorView
        {...props}
        audit={[{
          ts: '2026-07-13T12:30:00.000Z',
          kind: 'tick',
          data: {
            stage: 'session_gate',
            session: 'closed',
            action: 'skip',
            reason: 'session closed or disabled',
          },
        }]}
      />,
    );

    const activity = screen.getByRole('table', { name: 'Recent activity' });
    expect(within(activity).getByText('Skipped')).toHaveClass(
      'semantic-text',
      'semantic-text--warning',
    );
    expect(within(activity).getByText(
      'Execution check skipped. The market session is closed or disabled. No order was evaluated.',
    )).toBeVisible();
  });

  it('preserves or falls back from linked selection as candidate data refreshes', async () => {
    const wbdCandidates = {
      ...candidatesFixture,
      candidates: candidatesFixture.candidates.filter((item) => item.ticker === 'WBD'),
    };
    const wbdVerdicts = {
      ...verdictsFixture,
      verdicts: verdictsFixture.verdicts.filter((item) => item.ticker === 'WBD'),
    };
    const wbdPlan = {
      ...offhoursPlanFixture,
      entries: [],
      skipped: offhoursPlanFixture.skipped.filter((item) => item.ticker === 'WBD'),
    };
    const amdCandidates = {
      ...candidatesFixture,
      candidates: candidatesFixture.candidates.filter((item) => item.ticker === 'AMD'),
    };
    const amdVerdicts = {
      ...verdictsFixture,
      verdicts: verdictsFixture.verdicts.filter((item) => item.ticker === 'AMD'),
    };
    const amdPlan = {
      ...offhoursPlanFixture,
      skipped: [],
    };
    const { rerender } = render(<MonitorView {...props} />);

    await userEvent.click(screen.getByRole('row', { name: 'Inspect WBD' }));
    expect(screen.getByRole('region', { name: 'Candidate detail' })).toHaveTextContent('WBD');

    rerender(
      <MonitorView
        {...props}
        candidates={wbdCandidates}
        verdicts={wbdVerdicts}
        activePlan={wbdPlan}
      />,
    );
    expect(screen.getByRole('region', { name: 'Candidate detail' })).toHaveTextContent('WBD');

    rerender(
      <MonitorView
        {...props}
        candidates={amdCandidates}
        verdicts={amdVerdicts}
        activePlan={amdPlan}
      />,
    );
    await waitFor(() => {
      expect(screen.getByRole('region', { name: 'Candidate detail' })).toHaveTextContent('AMD');
    });

    rerender(
      <MonitorView
        {...props}
        candidates={null}
        verdicts={null}
        activePlan={null}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText('There is no candidate to inspect.')).toBeVisible();
    });
  });

  it('resets detail to Summary when the linked candidate changes', async () => {
    render(<MonitorView {...props} />);

    await userEvent.click(screen.getByRole('tab', { name: 'Evidence' }));
    expect(screen.getByRole('tab', { name: 'Evidence' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await userEvent.click(screen.getByRole('row', { name: 'Inspect WBD' }));

    expect(screen.getByRole('tab', { name: 'Summary' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('closes mobile detail without clearing the linked selection', async () => {
    setViewport(390, 844);
    render(<MonitorView {...props} />);

    await userEvent.click(screen.getByRole('row', { name: 'Inspect WBD' }));
    expect(screen.getByRole('region', { name: 'Candidate detail' })).toHaveTextContent('WBD');
    await userEvent.click(screen.getByRole('button', { name: 'Back to candidates' }));

    expect(screen.getByRole('row', { name: 'Inspect WBD' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('states when no candidate can be inspected', () => {
    render(
      <MonitorView
        {...props}
        candidates={null}
        verdicts={null}
        activePlan={null}
      />,
    );
    expect(screen.getByText('There is no candidate to inspect.')).toBeVisible();
  });

  it('uses no more than five default candidate columns', () => {
    render(<MonitorView {...props} />);
    expect(
      within(screen.getByRole('table', { name: 'Candidate monitor' }))
        .getAllByRole('columnheader'),
    ).toHaveLength(5);
  });

  it('states when required candidate agreement was not recorded', () => {
    render(<MonitorView {...props} config={null} />);

    expect(
      within(screen.getByRole('row', { name: 'Inspect AMD' })).getByText(
        '2 / Not recorded',
      ),
    ).toBeVisible();
  });
});
