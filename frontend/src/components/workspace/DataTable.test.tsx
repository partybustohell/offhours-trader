import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { DataTable, type DataColumn } from './DataTable';

interface Row {
  symbol: string;
  price: number;
}

const columns: DataColumn<Row>[] = [
  { id: 'symbol', header: 'Symbol', cell: (row) => row.symbol },
  {
    id: 'price',
    header: 'Price',
    cell: (row) => row.price.toFixed(2),
    align: 'right',
    mobilePriority: 'secondary',
  },
];

describe('DataTable', () => {
  it('uses real headers and supports keyboard row selection', async () => {
    const onSelect = vi.fn();
    render(
      <DataTable
        ariaLabel="Candidate monitor"
        rows={[{ symbol: 'AMD', price: 172.4 }]}
        columns={columns}
        rowKey={(row) => row.symbol}
        rowLabel={(row) => 'Inspect ' + row.symbol}
        emptyMessage="No candidates were recorded."
        onSelect={onSelect}
      />,
    );

    expect(screen.getByRole('columnheader', { name: 'Symbol' })).toBeVisible();
    expect(screen.getByRole('table', { name: 'Candidate monitor' })).toBeVisible();
    const row = screen.getByRole('row', { name: /Inspect AMD/ });
    row.focus();
    await userEvent.keyboard('{Enter}');
    expect(onSelect).toHaveBeenCalledWith({ symbol: 'AMD', price: 172.4 });
  });

  it('renders one explicit empty row', () => {
    render(
      <DataTable
        ariaLabel="Candidate monitor"
        rows={[]}
        columns={columns}
        rowKey={(row) => row.symbol}
        emptyMessage="No candidates were recorded."
      />,
    );
    expect(screen.getByText('No candidates were recorded.')).toBeVisible();
  });

  it('exposes expanded state and a full-width detail row', async () => {
    const onToggleExpanded = vi.fn();
    render(
      <DataTable
        ariaLabel="Orders"
        rows={[{ symbol: 'AMD', price: 172.4 }]}
        columns={columns}
        rowKey={(row) => row.symbol}
        rowLabel={(row) => 'Inspect ' + row.symbol + ' order'}
        emptyMessage="No orders were submitted today."
        expandedKey="AMD"
        onToggleExpanded={onToggleExpanded}
        renderExpanded={(row) => <pre>{row.symbol + ' raw'}</pre>}
      />,
    );
    const row = screen.getByRole('row', { name: 'Inspect AMD order' });
    expect(row).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('AMD raw')).toBeVisible();
    await userEvent.click(row);
    expect(onToggleExpanded).toHaveBeenCalledWith({ symbol: 'AMD', price: 172.4 });
  });
});
