import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
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
});
