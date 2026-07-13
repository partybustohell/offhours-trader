import { createRef } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { createInitialOperatorState } from '../../app/operatorState';
import { MobileControlSheet } from './MobileControlSheet';

function renderSheet(onClose = vi.fn()) {
  const triggerRef = createRef<HTMLButtonElement>();
  const actions = createInitialOperatorState().actions;
  render(
    <>
      <button ref={triggerRef}>Open controls</button>
      <MobileControlSheet
        open
        triggerRef={triggerRef}
        mode="paper"
        session="closed"
        broker="missing-credentials"
        halted={false}
        refreshText="12s ago"
        actions={actions}
        onAction={vi.fn().mockResolvedValue(undefined)}
        onClose={onClose}
      />
    </>,
  );
  return { triggerRef, onClose };
}

describe('MobileControlSheet', () => {
  it('exposes every operational control and traps focus in both directions', async () => {
    const user = userEvent.setup();
    renderSheet();

    expect(screen.getByRole('dialog', { name: 'Trading controls' })).toBeVisible();
    expect(screen.getByText('Paper')).toBeVisible();
    expect(screen.getByText('Market closed')).toBeVisible();
    expect(screen.getByText('Broker credentials missing')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Run analysis' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Check execution now' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Halt trading' })).toBeVisible();

    const close = screen.getByRole('button', { name: 'Close' });
    await waitFor(() => expect(close).toHaveFocus());
    await user.tab({ shift: true });
    expect(screen.getByRole('button', { name: 'Halt trading' })).toHaveFocus();
    await user.tab();
    expect(close).toHaveFocus();
  });

  it('closes on Escape and returns focus to the trigger', async () => {
    const user = userEvent.setup();
    const { onClose } = renderSheet();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus());

    await user.keyboard('{Escape}');

    expect(onClose).toHaveBeenCalledOnce();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Open controls' })).toHaveFocus();
    });
  });

  it('returns focus after the explicit close control', async () => {
    const user = userEvent.setup();
    const { onClose } = renderSheet();
    const close = screen.getByRole('button', { name: 'Close' });
    await waitFor(() => expect(close).toHaveFocus());

    await user.click(close);

    expect(onClose).toHaveBeenCalledOnce();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Open controls' })).toHaveFocus();
    });
  });

  it('lets the nested halt confirmation own focus and Escape without closing the sheet', async () => {
    const user = userEvent.setup();
    const { onClose } = renderSheet();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus());

    const halt = screen.getByRole('button', { name: 'Halt trading' });
    await user.click(halt);
    expect(screen.getByRole('dialog', { name: 'Halt trading?' })).toBeVisible();
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    const confirm = screen.getByRole('button', { name: 'Confirm halt trading' });
    expect(cancel).toHaveFocus();

    await user.tab({ shift: true });
    expect(confirm).toHaveFocus();
    await user.tab();
    expect(cancel).toHaveFocus();
    await user.keyboard('{Escape}');

    expect(screen.queryByRole('dialog', { name: 'Halt trading?' })).not.toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Trading controls' })).toBeVisible();
    expect(onClose).not.toHaveBeenCalled();
    expect(halt).toHaveFocus();
  });
});
