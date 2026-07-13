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

  it('ignores clicks from native and custom interactive descendants', async () => {
    const onSelect = vi.fn();
    const onToggleExpanded = vi.fn();
    const onButtonClick = vi.fn();
    const interactiveColumns: DataColumn<Row>[] = [
      columns[0],
      {
        id: 'actions',
        header: 'Actions',
        cell: () => (
          <div>
            <button type="button" onClick={onButtonClick}>
              Native button
            </button>
            <a href="#details" onClick={(event) => event.preventDefault()}>
              Native link
            </a>
            <input aria-label="Native input" />
            <select aria-label="Native select">
              <option>Only option</option>
            </select>
            <textarea aria-label="Native textarea" />
            <details>
              <summary>Native summary</summary>
              Detail
            </details>
            <span role="button">Interactive role</span>
            <span tabIndex={0}>Tabindex control</span>
            <span contentEditable suppressContentEditableWarning>
              Editable control
            </span>
          </div>
        ),
      },
    ];

    render(
      <DataTable
        ariaLabel="Orders"
        rows={[{ symbol: 'AMD', price: 172.4 }]}
        columns={interactiveColumns}
        rowKey={(row) => row.symbol}
        rowLabel={(row) => 'Inspect ' + row.symbol + ' order'}
        emptyMessage="No orders were submitted today."
        onSelect={onSelect}
        onToggleExpanded={onToggleExpanded}
      />,
    );

    const controls = [
      screen.getByRole('button', { name: 'Native button' }),
      screen.getByRole('link', { name: 'Native link' }),
      screen.getByRole('textbox', { name: 'Native input' }),
      screen.getByRole('combobox', { name: 'Native select' }),
      screen.getByRole('textbox', { name: 'Native textarea' }),
      screen.getByText('Native summary'),
      screen.getByRole('button', { name: 'Interactive role' }),
      screen.getByText('Tabindex control'),
      screen.getByText('Editable control'),
    ];
    for (const control of controls) await userEvent.click(control);

    expect(onButtonClick).toHaveBeenCalledOnce();
    expect(onSelect).not.toHaveBeenCalled();
    expect(onToggleExpanded).not.toHaveBeenCalled();
  });

  it('ignores Enter and Space from an interactive descendant', async () => {
    const onSelect = vi.fn();
    const onToggleExpanded = vi.fn();
    const onButtonClick = vi.fn();
    const interactiveColumns: DataColumn<Row>[] = [
      columns[0],
      {
        id: 'action',
        header: 'Action',
        cell: () => (
          <button type="button" onClick={onButtonClick}>
            Inspect evidence
          </button>
        ),
      },
    ];

    render(
      <DataTable
        ariaLabel="Orders"
        rows={[{ symbol: 'AMD', price: 172.4 }]}
        columns={interactiveColumns}
        rowKey={(row) => row.symbol}
        rowLabel={(row) => 'Inspect ' + row.symbol + ' order'}
        emptyMessage="No orders were submitted today."
        onSelect={onSelect}
        onToggleExpanded={onToggleExpanded}
      />,
    );

    const button = screen.getByRole('button', { name: 'Inspect evidence' });
    button.focus();
    await userEvent.keyboard('{Enter}');
    await userEvent.keyboard(' ');

    expect(onSelect).not.toHaveBeenCalled();
    expect(onToggleExpanded).not.toHaveBeenCalled();
    expect(onButtonClick).toHaveBeenCalledTimes(2);
  });
});
