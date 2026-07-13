import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { setViewport } from '../../test/viewport';
import { MasterDetail } from './MasterDetail';

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
    await userEvent.click(screen.getByRole('button', { name: 'Back to candidates' }));
    expect(onClose).toHaveBeenCalledOnce();
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
