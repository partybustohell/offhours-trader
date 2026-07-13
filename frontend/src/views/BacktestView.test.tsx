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
    const unknown = within(table).getByText('Not available');
    expect(unknown).not.toHaveClass('semantic-text--positive');
    expect(unknown).not.toHaveClass('semantic-text--negative');
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

  it('states when returned cells and trades are empty', async () => {
    render(<BacktestView backtest={{ ...backtestFixture, cells: [], trades: [] }} />);
    expect(screen.getByText('No threshold cells were returned.')).toBeVisible();

    await userEvent.click(screen.getByRole('tab', { name: 'Sweep' }));
    expect(screen.getByText('No threshold cells were returned.')).toBeVisible();

    await userEvent.click(screen.getByRole('tab', { name: 'Trade log' }));
    expect(screen.getByText('No trades were returned for the selected cell.')).toBeVisible();
  });
});
