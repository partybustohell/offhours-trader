import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { AuditEvent } from '../types';
import { AuditView } from './AuditView';

const events: AuditEvent[] = [
  {
    ts: '2026-07-12T14:00:00.000Z',
    kind: 'order_rejected',
    data: { ticker: 'AMD', reason: 'Quote was stale.' },
  },
  {
    ts: '2026-07-12T14:01:00.000Z',
    kind: 'broker_heartbeat',
    data: { ok: true },
  },
];

describe('AuditView', () => {
  it('keeps an unknown event visible and expands its raw kind and JSON', async () => {
    render(<AuditView events={events} />);

    const table = screen.getByRole('table', { name: 'Audit events' });
    expect(within(table).getByText('Unknown event')).toBeVisible();
    const row = screen.getByRole('row', { name: /Unknown event/ });
    await userEvent.click(row);

    expect(row).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('broker_heartbeat')).toBeVisible();
    expect(screen.getByText(/"ok": true/)).toBeVisible();
  });

  it('filters by status without dropping raw records', async () => {
    render(<AuditView events={events} />);

    await userEvent.selectOptions(
      screen.getByLabelText('Filter by status'),
      'rejected',
    );

    const table = screen.getByRole('table', { name: 'Audit events' });
    expect(within(table).getByText('Order rejected')).toBeVisible();
    expect(within(table).queryByText('Unknown event')).not.toBeInTheDocument();
  });

  it('orders parsed timestamps newest first with stable source-order ties', () => {
    render(
      <AuditView
        events={[
          {
            ts: '2026-07-12T14:00:00.000Z',
            kind: 'error',
            data: { message: 'First equal-time event.' },
          },
          {
            ts: '2026-07-12T14:01:00.000Z',
            kind: 'halt',
            data: { reason: 'Newest recorded event.' },
          },
          {
            ts: '2026-07-12T14:00:00.000Z',
            kind: 'order_rejected',
            data: { reason: 'Second equal-time event.' },
          },
          {
            ts: 'not-a-timestamp',
            kind: 'resume',
            data: {},
          },
        ]}
      />,
    );

    const rowNames = within(
      screen.getByRole('table', { name: 'Audit events' }),
    )
      .getAllByRole('row')
      .slice(1)
      .map((row) => row.getAttribute('aria-label'));

    expect(rowNames).toEqual([
      expect.stringContaining('Trading halted'),
      expect.stringContaining('System error'),
      expect.stringContaining('Order rejected'),
      expect.stringContaining('Trading resumed'),
    ]);
  });

  it('keeps the same content-expanded event through polling insertions', async () => {
    const { rerender } = render(<AuditView events={events} />);
    const rejectedRow = screen.getByRole('row', { name: /Order rejected/ });

    await userEvent.click(rejectedRow);
    expect(rejectedRow).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(/"ticker": "AMD"/)).toBeVisible();

    rerender(
      <AuditView
        events={[
          {
            ts: '2026-07-12T14:02:00.000Z',
            kind: 'resume',
            data: { reason: 'Polling inserted this event.' },
          },
          ...events,
        ]}
      />,
    );

    const survivingRow = screen
      .getAllByRole('row', { name: /Order rejected/ })
      .find((row) => row.hasAttribute('aria-expanded'));
    if (!survivingRow) throw new Error('Expandable order-rejected row missing.');
    expect(survivingRow).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(/"ticker": "AMD"/)).toBeVisible();
  });

  it('reconciles filters and expansion when polled events disappear', async () => {
    const { rerender } = render(<AuditView events={events} />);
    const activityFilter = screen.getByLabelText('Filter by activity');
    const statusFilter = screen.getByLabelText('Filter by status');

    await userEvent.selectOptions(activityFilter, 'Unknown event');
    await userEvent.selectOptions(statusFilter, 'unknown');
    const unknownRow = screen.getByRole('row', { name: /Unknown event/ });
    await userEvent.click(unknownRow);
    expect(unknownRow).toHaveAttribute('aria-expanded', 'true');

    rerender(<AuditView events={[events[0]]} />);

    await waitFor(() => {
      expect(activityFilter).toHaveValue('all');
      expect(statusFilter).toHaveValue('all');
    });
    expect(screen.queryByText('broker_heartbeat')).not.toBeInTheDocument();
    expect(screen.getByRole('row', { name: /Order rejected/ })).toHaveAttribute(
      'aria-expanded',
      'false',
    );

    rerender(<AuditView events={events} />);
    expect(screen.getByRole('row', { name: /Unknown event/ })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  it('distinguishes filtered-empty results from a globally empty audit', async () => {
    const { rerender } = render(<AuditView events={events} />);

    await userEvent.selectOptions(
      screen.getByLabelText('Filter by activity'),
      'Unknown event',
    );
    await userEvent.selectOptions(
      screen.getByLabelText('Filter by status'),
      'rejected',
    );

    expect(
      screen.getByText('No audit events match these filters.'),
    ).toBeVisible();
    expect(
      screen.queryByText('No audit events were recorded.'),
    ).not.toBeInTheDocument();

    rerender(<AuditView events={[]} />);

    expect(screen.getByText('No audit events were recorded.')).toBeVisible();
    expect(
      screen.queryByText('No audit events match these filters.'),
    ).not.toBeInTheDocument();
  });

  it('expands with Enter and collapses with Space using linked disclosure semantics', async () => {
    render(<AuditView events={events} />);
    const row = screen.getByRole('row', {
      name: /Unknown event; status Unknown; event kind broker_heartbeat/i,
    });

    expect(row).toHaveAttribute('aria-expanded', 'false');
    expect(row).not.toHaveAttribute('aria-controls');

    row.focus();
    await userEvent.keyboard('{Enter}');

    expect(row).toHaveAttribute('aria-expanded', 'true');
    const detailId = row.getAttribute('aria-controls');
    expect(detailId).toBeTruthy();
    expect(document.getElementById(detailId!)).toHaveClass(
      'data-table__expanded',
    );
    expect(screen.getByText(/"ok": true/)).toBeVisible();

    await userEvent.keyboard(' ');

    expect(row).toHaveAttribute('aria-expanded', 'false');
    expect(row).not.toHaveAttribute('aria-controls');
    expect(document.getElementById(detailId!)).not.toBeInTheDocument();
    expect(screen.queryByText(/"ok": true/)).not.toBeInTheDocument();
  });

  it('renders colliding normalized field labels with unique React keys', async () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    render(
      <AuditView
        events={[
          {
            ts: '2026-07-12T14:00:00.000Z',
            kind: 'broker_heartbeat',
            data: { client_id: 'snake', 'client-id': 'kebab' },
          },
        ]}
      />,
    );

    await userEvent.click(
      screen.getByRole('row', { name: /event kind broker_heartbeat/i }),
    );

    expect(screen.getAllByText('Client id')).toHaveLength(2);
    expect(screen.getByText('snake')).toBeVisible();
    expect(screen.getByText('kebab')).toBeVisible();
    expect(consoleError).not.toHaveBeenCalled();
  });
});
