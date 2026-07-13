import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { setViewport } from '../../test/viewport';
import { DataTable, type DataColumn } from './DataTable';
import { MasterDetail } from './MasterDetail';

interface CandidateRow {
  symbol: string;
}

const candidateRows: CandidateRow[] = [{ symbol: 'AMD' }];
const candidateColumns: DataColumn<CandidateRow>[] = [
  { id: 'symbol', header: 'Symbol', cell: (row) => row.symbol },
];

describe('MasterDetail', () => {
  it('labels the mobile detail screen and closes it', async () => {
    const onClose = vi.fn();
    render(
      <MasterDetail
        master={<div>Candidate rows</div>}
        detail={<div>AMD decision</div>}
        detailOpen
        detailLabel="AMD candidate detail"
        onDetailClose={onClose}
      />,
    );

    expect(screen.getByRole('group', { name: 'AMD candidate detail' })).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Back to list' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('focuses a named Back control after keyboard row selection and restores the row on close', async () => {
    setViewport(390, 844);
    const user = userEvent.setup();

    function Harness() {
      const [detailOpen, setDetailOpen] = useState(false);
      const [selectedKey, setSelectedKey] = useState<string | null>(null);
      return (
        <MasterDetail
          master={
            <DataTable
              ariaLabel="Candidate monitor"
              rows={candidateRows}
              columns={candidateColumns}
              rowKey={(row) => row.symbol}
              rowLabel={(row) => 'Inspect ' + row.symbol + ' candidate'}
              emptyMessage="No candidates were recorded."
              selectedKey={selectedKey}
              onSelect={(row) => {
                setSelectedKey(row.symbol);
                setDetailOpen(true);
              }}
            />
          }
          detail={<div>AMD decision</div>}
          detailOpen={detailOpen}
          detailLabel="AMD candidate detail"
          backLabel="Back to candidates"
          onDetailClose={() => setDetailOpen(false)}
        />
      );
    }

    render(<Harness />);
    const row = screen.getByRole('row', { name: 'Inspect AMD candidate' });
    row.focus();
    await user.keyboard('{Enter}');

    const back = screen.getByRole('button', { name: 'Back to candidates' });
    expect(back).toHaveFocus();
    await user.click(back);

    expect(screen.getByRole('row', { name: 'Inspect AMD candidate' })).toHaveFocus();
  });

  it.each([
    { withSelected: true, expected: 'Selected fallback' },
    { withSelected: false, expected: 'First fallback' },
  ])(
    'uses $expected when the retained mobile source disconnects',
    async ({ withSelected, expected }) => {
      setViewport(390, 844);
      const user = userEvent.setup();

      function Harness() {
        const [detailOpen, setDetailOpen] = useState(false);
        const [sourcePresent, setSourcePresent] = useState(true);
        return (
          <MasterDetail
            master={
              <>
                {sourcePresent ? (
                  <button
                    type="button"
                    onClick={() => {
                      setSourcePresent(false);
                      setDetailOpen(true);
                    }}
                  >
                    Open detail
                  </button>
                ) : null}
                <button type="button">First fallback</button>
                {withSelected ? (
                  <div role="row" tabIndex={0} aria-selected="true">
                    Selected fallback
                  </div>
                ) : null}
              </>
            }
            detail={<div>Decision detail</div>}
            detailOpen={detailOpen}
            detailLabel="Decision detail"
            onDetailClose={() => setDetailOpen(false)}
          />
        );
      }

      render(<Harness />);
      await user.click(screen.getByRole('button', { name: 'Open detail' }));
      const back = screen.getByRole('button', { name: 'Back to list' });
      expect(back).toHaveFocus();
      await user.click(back);

      expect(screen.getByText(expected)).toHaveFocus();
    },
  );

  it('does not move focus across detail transitions at 900px', () => {
    setViewport(900, 700);
    const { rerender } = render(
      <MasterDetail
        master={<button type="button">Candidate rows</button>}
        detail={<div>AMD decision</div>}
        detailOpen={false}
        detailLabel="AMD candidate detail"
        onDetailClose={vi.fn()}
      />,
    );
    const masterControl = screen.getByRole('button', { name: 'Candidate rows' });
    masterControl.focus();

    rerender(
      <MasterDetail
        master={<button type="button">Candidate rows</button>}
        detail={<div>AMD decision</div>}
        detailOpen
        detailLabel="AMD candidate detail"
        onDetailClose={vi.fn()}
      />,
    );
    expect(masterControl).toHaveFocus();

    const back = screen.getByRole('button', { name: 'Back to list' });
    back.focus();
    rerender(
      <MasterDetail
        master={<button type="button">Candidate rows</button>}
        detail={<div>AMD decision</div>}
        detailOpen={false}
        detailLabel="AMD candidate detail"
        onDetailClose={vi.fn()}
      />,
    );
    expect(back).toHaveFocus();
  });

  it('hides the inactive screen from accessibility and focus below 900px', () => {
    setViewport(390, 844);
    const { container, rerender } = render(
      <MasterDetail
        master={<button type="button">Candidate rows</button>}
        detail={<button type="button">AMD decision</button>}
        detailOpen={false}
        detailLabel="AMD candidate detail"
        onDetailClose={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Candidate rows' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'AMD decision' })).not.toBeInTheDocument();
    expect(container.querySelector('.master-detail__detail')).toHaveAttribute('hidden');

    rerender(
      <MasterDetail
        master={<button type="button">Candidate rows</button>}
        detail={<button type="button">AMD decision</button>}
        detailOpen
        detailLabel="AMD candidate detail"
        onDetailClose={vi.fn()}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Candidate rows' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'AMD decision' })).toBeVisible();
    expect(container.querySelector('.master-detail__master')).toHaveAttribute('hidden');
    expect(container.querySelector('.master-detail__detail')).not.toHaveAttribute('hidden');
  });

  it('keeps master and detail visible at 900px and wider', () => {
    setViewport(900, 700);
    const { rerender } = render(
      <MasterDetail
        master={<button type="button">Candidate rows</button>}
        detail={<button type="button">AMD decision</button>}
        detailOpen={false}
        detailLabel="AMD candidate detail"
        onDetailClose={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Candidate rows' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'AMD decision' })).toBeVisible();

    rerender(
      <MasterDetail
        master={<button type="button">Candidate rows</button>}
        detail={<button type="button">AMD decision</button>}
        detailOpen
        detailLabel="AMD candidate detail"
        onDetailClose={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Candidate rows' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'AMD decision' })).toBeVisible();
  });
});
