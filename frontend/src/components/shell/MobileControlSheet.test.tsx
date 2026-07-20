import { createRef } from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { createInitialOperatorState } from '../../app/operatorState';
import { MobileControlSheet } from './MobileControlSheet';

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}

function renderSheet(
  onClose = vi.fn(),
  onAction = vi.fn().mockResolvedValue(undefined),
) {
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
        onAction={onAction}
        onClose={onClose}
      />
    </>,
  );
  return { triggerRef, onClose, onAction };
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

  it('keeps focus inside the outer sheet while a confirmed halt is pending', async () => {
    const user = userEvent.setup();
    const deferred = createDeferred();
    const onAction = vi.fn(() => deferred.promise);
    renderSheet(vi.fn(), onAction);
    const sheet = screen.getByRole('dialog', { name: 'Trading controls' });
    const close = screen.getByRole('button', { name: 'Close' });
    await waitFor(() => expect(close).toHaveFocus());

    await user.click(screen.getByRole('button', { name: 'Halt trading' }));
    await user.click(screen.getByRole('button', { name: 'Confirm halt trading' }));

    expect(onAction).toHaveBeenCalledWith('halt');
    expect(screen.queryByRole('dialog', { name: 'Halt trading?' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Halt trading in progress' })).toBeDisabled();
    expect(sheet).toContainElement(document.activeElement as HTMLElement);
    expect(close).toHaveFocus();

    await act(async () => {
      await Promise.resolve();
    });
    expect(sheet).toContainElement(document.activeElement as HTMLElement);
    expect(close).toHaveFocus();

    await act(async () => deferred.resolve());
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Halt trading' })).toHaveFocus();
    });
  });
});
