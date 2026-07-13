import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { backtestFixture } from '../test/fixtures';
import { BacktestView } from './BacktestView';

describe('BacktestView', () => {
  it('shows only API-backed metadata and values', () => {
    render(<BacktestView backtest={backtestFixture} />);
    expect(screen.getByText('july-sweep')).toBeVisible();
    expect(screen.getByRole('img', { name: 'Net P&L by confidence threshold' })).toBeVisible();
    expect(screen.queryByText(/50 episodes/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/starting capital/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/statistically/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/SIP/i)).not.toBeInTheDocument();
  });

  it('reaches the sweep and trade log through tabs', async () => {
    render(<BacktestView backtest={backtestFixture} />);
    await userEvent.click(screen.getByRole('tab', { name: 'Sweep' }));
    expect(screen.getByRole('table', { name: 'Backtest sweep' })).toBeVisible();
    await userEvent.click(screen.getByRole('tab', { name: 'Trade log' }));
    expect(screen.getByRole('table', { name: 'Backtest trade log' })).toBeVisible();
  });

  it('states when no backtest result is available', () => {
    render(<BacktestView backtest={{ available: false }} />);
    expect(screen.getByText('No backtest result is available.')).toBeVisible();
  });

  it('scales chart points by their returned thresholds and labels every point', () => {
    render(
      <BacktestView
        backtest={{
          ...backtestFixture,
          cells: [
            { ...backtestFixture.cells![0], cell: 'low', threshold: 0.6, netPnlUsd: 10 },
            { ...backtestFixture.cells![0], cell: 'middle', threshold: 0.7, netPnlUsd: 20 },
            { ...backtestFixture.cells![0], cell: 'high', threshold: 0.9, netPnlUsd: -5 },
          ],
        }}
      />,
    );

    const chart = screen.getByRole('img', { name: 'Net P&L by confidence threshold' });
    const points = [...chart.querySelectorAll('circle')];
    const x = points.map((point) => Number(point.getAttribute('cx')));
    expect((x[1] - x[0]) / (x[2] - x[0])).toBeCloseTo(1 / 3, 5);
    expect(points.map((point) => point.querySelector('title')?.textContent)).toEqual([
      '60%: $10.00',
      '70%: $20.00',
      '90%: -$5.00',
    ]);
  });

  it('centers chart points when no threshold range exists', () => {
    const { rerender } = render(
      <BacktestView
        backtest={{
          ...backtestFixture,
          cells: [{ ...backtestFixture.cells![0], threshold: 0.7 }],
        }}
      />,
    );
    expect(
      screen
        .getByRole('img', { name: 'Net P&L by confidence threshold' })
        .querySelector('circle'),
    ).toHaveAttribute('cx', '360');

    rerender(
      <BacktestView
        backtest={{
          ...backtestFixture,
          cells: [
            { ...backtestFixture.cells![0], cell: 'first', threshold: 0.7 },
            { ...backtestFixture.cells![0], cell: 'second', threshold: 0.7 },
          ],
        }}
      />,
    );
    const points = screen
      .getByRole('img', { name: 'Net P&L by confidence threshold' })
      .querySelectorAll('circle');
    expect([...points].map((point) => point.getAttribute('cx'))).toEqual(['360', '360']);
  });

  it('keeps configured duplicate thresholds as unconnected accessible points', () => {
    render(
      <BacktestView
        backtest={{
          ...backtestFixture,
          cells: [
            {
              ...backtestFixture.cells![0],
              cell: 'bear-light',
              threshold: 0.7,
              bearWeight: 0.8,
              netPnlUsd: 10,
            },
            {
              ...backtestFixture.cells![0],
              cell: 'bear-heavy',
              threshold: 0.7,
              bearWeight: 1.6,
              netPnlUsd: -5,
            },
          ],
        }}
      />,
    );

    const chart = screen.getByRole('img', {
      name: 'Net P&L by confidence threshold',
    });
    const points = [...chart.querySelectorAll('circle')];
    expect(points).toHaveLength(2);
    expect(points[0]).toHaveAttribute('cx', points[1].getAttribute('cx'));
    expect(chart.querySelector('polyline')).not.toBeInTheDocument();
    expect(screen.getByText(/points are unconnected because other sweep parameters may differ/i))
      .toBeVisible();

    const pointList = screen.getByRole('list', {
      name: 'Backtest chart point values',
    });
    const values = within(pointList).getAllByRole('listitem');
    expect(values).toHaveLength(2);
    expect(values[0]).toHaveTextContent('bear-light');
    expect(values[0]).toHaveTextContent('70%');
    expect(values[0]).toHaveTextContent('0.8');
    expect(values[0]).toHaveTextContent('+$10.00');
    expect(values[1]).toHaveTextContent('bear-heavy');
    expect(values[1]).toHaveTextContent('1.6');
    expect(values[1]).toHaveTextContent('-$5.00');

    expect(points[0]).toHaveAttribute(
      'aria-label',
      'Cell bear-light; Confidence 70%; Bear weight 0.8; Net P&L +$10.00',
    );
    expect(points[0]).toHaveAttribute('tabindex', '0');
    const describedBy = points[0].getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)).toBe(values[0]);
    points[0].focus();
    expect(points[0]).toHaveFocus();
  });

  it('shows Bear weight and keeps unavailable net values out of the chart', async () => {
    render(
      <BacktestView
        backtest={{
          ...backtestFixture,
          cells: [
            {
              ...backtestFixture.cells![0],
              cell: 'modern-bear',
              bear: undefined,
              bearWeight: 1.2,
            },
            {
              ...backtestFixture.cells![0],
              cell: 'net-missing',
              bear: undefined,
              bearWeight: undefined,
              netPnlUsd: null,
            },
          ],
        }}
      />,
    );

    const chart = screen.getByRole('img', {
      name: 'Net P&L by confidence threshold',
    });
    expect(chart.querySelectorAll('circle')).toHaveLength(1);
    expect(screen.queryByText('net-missing')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: 'Sweep' }));
    const table = screen.getByRole('table', { name: 'Backtest sweep' });
    expect(within(table).getByRole('columnheader', { name: 'Bear weight' })).toBeVisible();
    const modernRow = within(table).getByText('modern-bear').closest('tr');
    expect(modernRow).not.toBeNull();
    expect(within(modernRow!).getByText('1.2')).toBeVisible();
    const missingRow = within(table).getByText('net-missing').closest('tr');
    expect(missingRow).not.toBeNull();
    expect(within(missingRow!).getByText('Not recorded')).toBeVisible();
    expect(within(missingRow!).getByText('Not available')).toBeVisible();
  });

  it('distinguishes returned cells without recorded net P&L from no cells', async () => {
    render(
      <BacktestView
        backtest={{
          ...backtestFixture,
          cells: [
            {
              ...backtestFixture.cells![0],
              cell: 'net-missing',
              netPnlUsd: null,
            },
          ],
        }}
      />,
    );

    expect(
      screen.getByText('No cells with recorded net P&L were returned.'),
    ).toBeVisible();
    expect(
      screen.queryByText('No threshold cells were returned.'),
    ).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: 'Sweep' }));
    const table = screen.getByRole('table', { name: 'Backtest sweep' });
    const returnedRow = within(table).getByText('net-missing').closest('tr');
    expect(returnedRow).not.toBeNull();
    expect(within(returnedRow!).getByText('Not available')).toBeVisible();
  });

  it('uses signed semantic P&L text only for finite nonzero values', async () => {
    render(
      <BacktestView
        backtest={{
          ...backtestFixture,
          cells: [
            { ...backtestFixture.cells![0], cell: 'positive', netPnlUsd: 11 },
            { ...backtestFixture.cells![0], cell: 'negative', netPnlUsd: -12 },
            { ...backtestFixture.cells![0], cell: 'zero', netPnlUsd: 0 },
            { ...backtestFixture.cells![0], cell: 'unknown', netPnlUsd: Number.NaN },
          ],
        }}
      />,
    );
    await userEvent.click(screen.getByRole('tab', { name: 'Sweep' }));

    const table = screen.getByRole('table', { name: 'Backtest sweep' });
    expect(within(table).getByText('+$11.00')).toHaveClass('semantic-text--positive');
    expect(within(table).getByText('-$12.00')).toHaveClass('semantic-text--negative');
    const zero = within(table).getByText('$0.00');
    expect(zero).not.toHaveClass('semantic-text--positive');
    expect(zero).not.toHaveClass('semantic-text--negative');
    expect(zero).toHaveClass('semantic-text', 'semantic-text--neutral');
    const unknown = within(table).getByText('Not available');
    expect(unknown).not.toHaveClass('semantic-text--positive');
    expect(unknown).not.toHaveClass('semantic-text--negative');
    expect(unknown).toHaveClass('semantic-text', 'semantic-text--neutral');
  });

  it('uses recorded-value fallbacks and keeps identical trade rows', async () => {
    const blankTrade = {
      ...backtestFixture.trades![0],
      stratum: ' ',
      ticker: '',
      side: '',
      pnlUsd: 7,
      exitReason: '   ',
    };
    render(
      <BacktestView
        backtest={{
          ...backtestFixture,
          tag: ' ',
          tradeLogCell: '',
          trades: [blankTrade, { ...blankTrade }],
        }}
      />,
    );
    expect(screen.getByText('Not recorded')).toBeVisible();
    await userEvent.click(screen.getByRole('tab', { name: 'Trade log' }));

    expect(screen.getByText('Trade-log cell: Not recorded')).toBeVisible();
    const table = screen.getByRole('table', { name: 'Backtest trade log' });
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(3);
    for (const row of rows.slice(1)) {
      expect(within(row).getAllByText('Not recorded')).toHaveLength(4);
      expect(within(row).getByText('+$7.00')).toHaveClass('semantic-text--positive');
    }
  });

  it('states when no threshold cells and no trades are returned', async () => {
    render(<BacktestView backtest={{ ...backtestFixture, cells: [], trades: [] }} />);
    expect(screen.getByText('No threshold cells were returned.')).toBeVisible();

    await userEvent.click(screen.getByRole('tab', { name: 'Sweep' }));
    expect(screen.getByText('No threshold cells were returned.')).toBeVisible();

    await userEvent.click(screen.getByRole('tab', { name: 'Trade log' }));
    expect(screen.getByText('No trades were returned for the selected cell.')).toBeVisible();
  });
});
