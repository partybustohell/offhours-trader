import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { auditFixture, ordersFixture, positionsFixture } from '../test/fixtures';
import { setViewport } from '../test/viewport';
import type { BrokerOrder, Position } from '../types';
import { PositionsView } from './PositionsView';

const fixedNow = new Date('2026-07-12T18:00:00.000Z');

describe('PositionsView', () => {
  it('uses tabs instead of vertically stacked cards', async () => {
    render(
      <PositionsView
        positions={positionsFixture}
        orders={ordersFixture}
        audit={auditFixture}
        now={fixedNow}
      />,
    );

    expect(screen.getByRole('tab', { name: 'Positions' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.queryByRole('table', { name: 'Orders' })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: 'Orders' }));
    const orders = screen.getByRole('table', { name: 'Orders' });
    expect(orders).toBeVisible();
    expect(within(orders).getByText('Filled')).toBeVisible();

    await userEvent.click(screen.getByRole('tab', { name: 'Risk rejections' }));
    const rejections = screen.getByRole('table', { name: 'Risk rejections' });
    expect(rejections).toBeVisible();
    expect(within(rejections).getByText('Spread exceeded 40 bps.')).toBeVisible();
  });

  it('uses the three exact empty states', async () => {
    render(
      <PositionsView
        positions={{ positions: [] }}
        orders={{ orders: [] }}
        audit={[]}
        now={fixedNow}
      />,
    );

    expect(screen.getByText('No open positions.')).toBeVisible();
    await userEvent.click(screen.getByRole('tab', { name: 'Orders' }));
    expect(screen.getByText('No orders were submitted today.')).toBeVisible();
    await userEvent.click(screen.getByRole('tab', { name: 'Risk rejections' }));
    expect(
      screen.getByText('No orders were rejected by the risk checks today.'),
    ).toBeVisible();
  });

  it('does not describe failed broker reads as empty account state', async () => {
    render(
      <PositionsView
        positions={{ positions: [], error: 'Broker credentials are missing.' }}
        orders={{ orders: [], error: 'Broker credentials are missing.' }}
        audit={[]}
        now={fixedNow}
      />,
    );

    expect(screen.getByText(/Position data is unavailable/)).toBeVisible();
    expect(screen.queryByText('No open positions.')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: 'Orders' }));
    expect(screen.getByText(/Order data is unavailable/)).toBeVisible();
    expect(
      screen.queryByText('No orders were submitted today.'),
    ).not.toBeInTheDocument();
  });

  it('shows only orders submitted on the current ET day and excludes invalid dates', async () => {
    render(
      <PositionsView
        positions={positionsFixture}
        orders={{
          orders: [
            ordersFixture.orders[0],
            {
              ...ordersFixture.orders[0],
              id: 'old-order',
              ticker: 'OLD',
              submittedAt: '2026-07-11T23:59:00.000Z',
            },
            {
              ...ordersFixture.orders[0],
              id: 'invalid-order',
              ticker: 'INVALID',
              submittedAt: 'not-a-timestamp',
            },
          ],
        }}
        audit={auditFixture}
        now={fixedNow}
      />,
    );

    await userEvent.click(screen.getByRole('tab', { name: 'Orders' }));
    const table = screen.getByRole('table', { name: 'Orders' });
    expect(within(table).getByText('AMD')).toBeVisible();
    expect(within(table).queryByText('OLD')).not.toBeInTheDocument();
    expect(within(table).queryByText('INVALID')).not.toBeInTheDocument();
  });

  it('uses the ET date rather than the UTC date across midnight', async () => {
    render(
      <PositionsView
        positions={positionsFixture}
        orders={{
          orders: [
            {
              ...ordersFixture.orders[0],
              id: 'same-et-day',
              ticker: 'SAME',
              submittedAt: '2026-07-12T00:15:00.000Z',
            },
            {
              ...ordersFixture.orders[0],
              id: 'next-et-day',
              ticker: 'NEXT',
              submittedAt: '2026-07-12T04:15:00.000Z',
            },
          ],
        }}
        audit={[]}
        now={new Date('2026-07-12T00:30:00.000Z')}
      />,
    );

    await userEvent.click(screen.getByRole('tab', { name: 'Orders' }));
    const table = screen.getByRole('table', { name: 'Orders' });
    expect(within(table).getByText('SAME')).toBeVisible();
    expect(within(table).queryByText('NEXT')).not.toBeInTheDocument();
  });

  it('renders production-shaped risk rejections from the current ET day', async () => {
    render(
      <PositionsView
        positions={positionsFixture}
        orders={ordersFixture}
        audit={[
          {
            ts: '2026-07-12T14:15:00.000Z',
            kind: 'order_rejected',
            data: {
              order: { ticker: 'AMD', side: 'buy', qty: 20, limitPrice: 172.4 },
              reasons: ['trading halted', '', 'exceeds max position size'],
            },
          },
          {
            ts: '2026-07-11T14:15:00.000Z',
            kind: 'order_rejected',
            data: {
              order: { ticker: 'OLD', side: 'buy', qty: 10, limitPrice: 10 },
              reasons: ['quote was stale'],
            },
          },
        ]}
        now={fixedNow}
      />,
    );

    await userEvent.click(screen.getByRole('tab', { name: 'Risk rejections' }));
    const table = screen.getByRole('table', { name: 'Risk rejections' });
    expect(within(table).getByText('AMD')).toBeVisible();
    expect(
      within(table).getByText('Trading halted. Exceeds max position size.'),
    ).toBeVisible();
    expect(within(table).queryByText('OLD')).not.toBeInTheDocument();
  });

  it('pairs position direction and signed gain or loss with semantic text classes', () => {
    const positions: Position[] = [
      positionsFixture.positions[0],
      {
        ...positionsFixture.positions[0],
        ticker: 'WBD',
        side: 'short',
        unrealizedPl: -12,
      },
      {
        ...positionsFixture.positions[0],
        ticker: 'ZERO',
        unrealizedPl: 0,
      },
      {
        ...positionsFixture.positions[0],
        ticker: 'UNKNOWN',
        unrealizedPl: Number.NaN,
      },
    ];

    render(
      <PositionsView
        positions={{ positions }}
        orders={ordersFixture}
        audit={auditFixture}
        now={fixedNow}
      />,
    );

    const longRow = screen.getByRole('row', { name: 'Inspect AMD position' });
    expect(within(longRow).getByText('Long')).toHaveClass('semantic-text--positive');
    expect(within(longRow).getByText('+$88.00')).toHaveClass(
      'semantic-text--positive',
    );

    const shortRow = screen.getByRole('row', { name: 'Inspect WBD position' });
    expect(within(shortRow).getByText('Short')).toHaveClass(
      'semantic-text--negative',
    );
    expect(within(shortRow).getByText('-$12.00')).toHaveClass(
      'semantic-text--negative',
    );

    const zero = within(
      screen.getByRole('row', { name: 'Inspect ZERO position' }),
    ).getByText('$0.00');
    expect(zero).not.toHaveClass('semantic-text--positive');
    expect(zero).not.toHaveClass('semantic-text--negative');

    const unknown = within(
      screen.getByRole('row', { name: 'Inspect UNKNOWN position' }),
    ).getByText('Not available');
    expect(unknown).not.toHaveClass('semantic-text--positive');
    expect(unknown).not.toHaveClass('semantic-text--negative');
  });

  it('uses ordinary status text with semantic classes and keeps raw status in detail', async () => {
    const orders: BrokerOrder[] = [
      ordersFixture.orders[0],
      {
        ...ordersFixture.orders[0],
        id: 'order-completed',
        ticker: 'DONE',
        status: 'completed',
      },
      {
        ...ordersFixture.orders[0],
        id: 'order-rejected',
        ticker: 'NOPE',
        status: 'rejected',
      },
      {
        ...ordersFixture.orders[0],
        id: 'order-pending',
        ticker: 'WAIT',
        status: 'pending_new',
        clientOrderId: '   ',
      },
      {
        ...ordersFixture.orders[0],
        id: 'order-accepted',
        ticker: 'READY',
        status: 'accepted',
      },
      {
        ...ordersFixture.orders[0],
        id: 'order-closed',
        ticker: 'CLOSED',
        status: 'canceled',
      },
      {
        ...ordersFixture.orders[0],
        id: 'order-unknown',
        ticker: 'UNKNOWN',
        status: 'mystery_state',
      },
    ];

    render(
      <PositionsView
        positions={positionsFixture}
        orders={{ orders }}
        audit={auditFixture}
        now={fixedNow}
      />,
    );

    await userEvent.click(screen.getByRole('tab', { name: 'Orders' }));

    expect(
      within(screen.getByRole('row', { name: 'Inspect order order-1' })).getByText(
        'Filled',
      ),
    ).toHaveClass('semantic-text--positive');
    expect(
      within(
        screen.getByRole('row', { name: 'Inspect order order-completed' }),
      ).getByText('Completed'),
    ).toHaveClass('semantic-text--positive');
    expect(
      within(
        screen.getByRole('row', { name: 'Inspect order order-rejected' }),
      ).getByText('Rejected'),
    ).toHaveClass('semantic-text--negative');

    const pendingRow = screen.getByRole('row', {
      name: 'Inspect order order-pending',
    });
    expect(within(pendingRow).getByText('Pending new')).toHaveClass(
      'semantic-text--warning',
    );

    expect(
      within(
        screen.getByRole('row', { name: 'Inspect order order-accepted' }),
      ).getByText('Accepted'),
    ).toHaveClass('semantic-text--warning');
    expect(
      within(
        screen.getByRole('row', { name: 'Inspect order order-closed' }),
      ).getByText('Canceled'),
    ).toHaveClass('semantic-text--warning');

    const unknownStatus = within(
      screen.getByRole('row', { name: 'Inspect order order-unknown' }),
    ).getByText('Mystery state');
    expect(unknownStatus).not.toHaveClass('semantic-text--positive');
    expect(unknownStatus).not.toHaveClass('semantic-text--negative');
    expect(unknownStatus).not.toHaveClass('semantic-text--warning');
    await userEvent.click(pendingRow);

    const detail = screen.getByRole('group', {
      name: 'Position and order detail',
    });
    expect(within(detail).getByText('Raw broker status').nextElementSibling).toHaveTextContent(
      /^pending_new$/,
    );
    expect(within(detail).getByText('Client order ID').nextElementSibling).toHaveTextContent(
      /^Not recorded$/,
    );
  });

  it('shows every order field and truthful missing values when mobile hides the master', async () => {
    setViewport(390, 844);
    const user = userEvent.setup();
    const order: BrokerOrder = {
      id: 'detail-order',
      ticker: 'WBD',
      side: 'sell',
      qty: Number.NaN,
      type: '   ',
      limitPrice: Number.NaN,
      stopPrice: Number.POSITIVE_INFINITY,
      timeInForce: '',
      status: 'pending_replace',
      submittedAt: '2026-07-12T14:05:00.000Z',
      clientOrderId: '   ',
    };

    render(
      <PositionsView
        positions={positionsFixture}
        orders={{ orders: [order] }}
        audit={auditFixture}
        now={fixedNow}
      />,
    );

    await user.click(screen.getByRole('tab', { name: 'Orders' }));
    const table = screen.getByRole('table', { name: 'Orders' });
    await user.click(screen.getByRole('row', { name: 'Inspect order detail-order' }));

    expect(table).not.toBeVisible();
    const detail = screen.getByRole('group', {
      name: 'Position and order detail',
    });
    expect(detail).toBeVisible();
    const expectedFields = [
      ['Symbol', 'WBD'],
      ['Side', 'Sell'],
      ['Quantity', 'Not available'],
      ['Type', 'Not recorded'],
      ['Time in force', 'Not recorded'],
      ['Order ID', 'detail-order'],
      ['Client order ID', 'Not recorded'],
      ['Status', 'Pending replace'],
      ['Raw broker status', 'pending_replace'],
      ['Submitted', '10:05:00 ET'],
      ['Limit price', 'Not available'],
      ['Stop price', 'Not available'],
      ['Filled quantity', 'Not available'],
    ] as const;
    for (const [label, value] of expectedFields) {
      expect(within(detail).getByText(label).nextElementSibling).toHaveTextContent(
        new RegExp('^' + value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'),
      );
    }
  });

  it('falls back to the first order when a position ticker collides with another order ID', async () => {
    render(
      <PositionsView
        positions={{
          positions: [
            { ...positionsFixture.positions[0], ticker: 'shared-id' },
          ],
        }}
        orders={{
          orders: [
            { ...ordersFixture.orders[0], id: 'first-order', ticker: 'FIRST' },
            { ...ordersFixture.orders[0], id: 'shared-id', ticker: 'SECOND' },
          ],
        }}
        audit={auditFixture}
        now={fixedNow}
      />,
    );

    await userEvent.click(screen.getByRole('tab', { name: 'Orders' }));
    const first = screen.getByRole('row', { name: 'Inspect order first-order' });
    const colliding = screen.getByRole('row', { name: 'Inspect order shared-id' });
    await waitFor(() => expect(first).toHaveAttribute('aria-selected', 'true'));
    expect(colliding).toHaveAttribute('aria-selected', 'false');
    const detail = screen.getByRole('group', {
      name: 'Position and order detail',
    });
    expect(within(detail).getByText('Symbol').nextElementSibling).toHaveTextContent(
      /^FIRST$/,
    );
  });

  it('shows the full selected position and rejection records', async () => {
    render(
      <PositionsView
        positions={positionsFixture}
        orders={ordersFixture}
        audit={auditFixture}
        now={fixedNow}
      />,
    );

    await userEvent.click(
      screen.getByRole('row', { name: 'Inspect AMD position' }),
    );
    const detail = screen.getByRole('group', {
      name: 'Position and order detail',
    });
    expect(within(detail).getByText('Average entry').nextElementSibling).toHaveTextContent(
      /^\$168\.00$/,
    );
    expect(within(detail).getByText('Market value').nextElementSibling).toHaveTextContent(
      /^\$3,448\.00$/,
    );

    await userEvent.click(screen.getByRole('tab', { name: 'Risk rejections' }));
    await userEvent.click(
      screen.getByRole('row', { name: 'Inspect WBD rejection' }),
    );
    expect(within(detail).getByText('Spread exceeded 40 bps.')).toBeVisible();
    expect(within(detail).getByText(/"kind": "order_rejected"/)).toBeVisible();
  });

  it.each([
    {
      tab: 'Positions',
      row: 'Inspect AMD position',
      back: 'Back to positions',
    },
    {
      tab: 'Orders',
      row: 'Inspect order order-1',
      back: 'Back to orders',
    },
    {
      tab: 'Risk rejections',
      row: 'Inspect WBD rejection',
      back: 'Back to risk rejections',
    },
  ])(
    'uses "$back" and restores mobile focus for the $tab tab',
    async ({ tab, row, back }) => {
      setViewport(390, 844);
      const user = userEvent.setup();
      render(
        <PositionsView
          positions={positionsFixture}
          orders={ordersFixture}
          audit={auditFixture}
          now={fixedNow}
        />,
      );

      if (tab !== 'Positions') {
        await user.click(screen.getByRole('tab', { name: tab }));
      }
      const sourceRow = screen.getByRole('row', { name: row });
      sourceRow.focus();
      await user.keyboard('{Enter}');

      const backButton = screen.getByRole('button', { name: back });
      expect(backButton).toHaveFocus();
      await user.click(backButton);
      expect(screen.getByRole('row', { name: row })).toHaveFocus();
    },
  );
});
