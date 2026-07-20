import { useId, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';

const INTERACTIVE_DESCENDANT_SELECTOR = [
  'button',
  'a',
  'input',
  'select',
  'textarea',
  'summary',
  '[tabindex]',
  '[contenteditable]:not([contenteditable="false"])',
  '[role="button"]',
  '[role="checkbox"]',
  '[role="combobox"]',
  '[role="link"]',
  '[role="listbox"]',
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]',
  '[role="option"]',
  '[role="radio"]',
  '[role="scrollbar"]',
  '[role="searchbox"]',
  '[role="slider"]',
  '[role="spinbutton"]',
  '[role="switch"]',
  '[role="tab"]',
  '[role="textbox"]',
  '[role="treeitem"]',
].join(',');

function isInteractiveDescendant(
  row: HTMLTableRowElement,
  target: EventTarget | null,
) {
  if (!(target instanceof Element)) return false;
  const interactiveElement = target.closest(INTERACTIVE_DESCENDANT_SELECTOR);
  return (
    interactiveElement !== null &&
    interactiveElement !== row &&
    row.contains(interactiveElement)
  );
}

export interface DataColumn<Row> {
  id: string;
  header: ReactNode;
  cell(row: Row): ReactNode;
  align?: 'left' | 'right';
  mobilePriority?: 'essential' | 'secondary';
}

export interface DataTableProps<Row> {
  ariaLabel: string;
  rows: readonly Row[];
  columns: readonly DataColumn<Row>[];
  rowKey(row: Row): string;
  emptyMessage: string;
  selectedKey?: string | null;
  onSelect?(row: Row): void;
  rowLabel?(row: Row): string;
  expandedKey?: string | null;
  onToggleExpanded?(row: Row): void;
  renderExpanded?(row: Row): ReactNode;
}

export function DataTable<Row>({
  ariaLabel,
  rows,
  columns,
  rowKey,
  emptyMessage,
  selectedKey,
  onSelect,
  rowLabel,
  expandedKey,
  onToggleExpanded,
  renderExpanded,
}: DataTableProps<Row>) {
  const detailIdPrefix = 'data-table-' + useId().replace(/:/g, '');
  const activate = (row: Row) => {
    onSelect?.(row);
    onToggleExpanded?.(row);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTableRowElement>, row: Row) => {
    if (isInteractiveDescendant(event.currentTarget, event.target)) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      activate(row);
    }
  };

  const onClick = (event: MouseEvent<HTMLTableRowElement>, row: Row) => {
    if (!isInteractiveDescendant(event.currentTarget, event.target)) {
      activate(row);
    }
  };

  const interactive = Boolean(onSelect || onToggleExpanded);

  return (
    <div className="data-table-wrap">
      <table className="data-table" aria-label={ariaLabel}>
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.id}
                scope="col"
                className={column.align === 'right' ? 'is-numeric' : undefined}
                data-mobile-priority={column.mobilePriority ?? 'essential'}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr className="data-table__empty">
              <td colSpan={columns.length}>{emptyMessage}</td>
            </tr>
          ) : (
            rows.map((row, rowIndex) => {
              const key = rowKey(row);
              const selected = selectedKey === key;
              const expanded = expandedKey === key;
              const detailId = detailIdPrefix + '-detail-' + String(rowIndex);
              return [
                <tr
                  key={key}
                  className={selected ? 'is-selected' : undefined}
                  tabIndex={interactive ? 0 : undefined}
                  aria-label={rowLabel?.(row)}
                  aria-selected={onSelect ? selected : undefined}
                  aria-expanded={onToggleExpanded ? expanded : undefined}
                  aria-controls={
                    onToggleExpanded && expanded && renderExpanded
                      ? detailId
                      : undefined
                  }
                  onClick={interactive ? (event) => onClick(event, row) : undefined}
                  onKeyDown={
                    interactive ? (event) => onKeyDown(event, row) : undefined
                  }
                >
                  {columns.map((column) => (
                    <td
                      key={column.id}
                      className={
                        column.align === 'right' ? 'is-numeric' : undefined
                      }
                      data-mobile-priority={
                        column.mobilePriority ?? 'essential'
                      }
                    >
                      {column.cell(row)}
                    </td>
                  ))}
                </tr>,
                expanded && renderExpanded ? (
                  <tr
                    id={detailId}
                    className="data-table__expanded"
                    key={key + '-expanded'}
                  >
                    <td colSpan={columns.length}>{renderExpanded(row)}</td>
                  </tr>
                ) : null,
              ];
            })
          )}
        </tbody>
      </table>
    </div>
  );
}
