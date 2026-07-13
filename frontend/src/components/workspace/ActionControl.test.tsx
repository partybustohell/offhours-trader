import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ActionControl } from './ActionControl';

function renderHaltControl(onInvoke = vi.fn().mockResolvedValue(undefined)) {
  render(
    <ActionControl
      action="halt"
      label="Halt trading"
      state={{ phase: 'idle' }}
      tone="danger"
      confirmation={{
        title: 'Halt trading?',
        body: 'New entries will remain blocked until trading is resumed.',
        confirmLabel: 'Halt trading',
      }}
      onInvoke={onInvoke}
    />,
  );
  return { onInvoke, trigger: screen.getByRole('button', { name: 'Halt trading' }) };
}

describe('ActionControl', () => {
  it('requires explicit confirmation before halting', async () => {
    const { onInvoke, trigger } = renderHaltControl();

    await userEvent.click(trigger);
    expect(screen.getByRole('dialog', { name: 'Halt trading?' })).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onInvoke).not.toHaveBeenCalled();

    await userEvent.click(trigger);
    await userEvent.click(screen.getByRole('button', { name: 'Confirm halt trading' }));
    expect(onInvoke).toHaveBeenCalledWith('halt');
  });

  it('moves initial focus into the modal and wraps Tab in both directions', async () => {
    const user = userEvent.setup();
    const { trigger } = renderHaltControl();
    await user.click(trigger);

    const cancel = screen.getByRole('button', { name: 'Cancel' });
    const confirm = screen.getByRole('button', { name: 'Confirm halt trading' });
    expect(cancel).toHaveFocus();

    await user.tab({ shift: true });
    expect(confirm).toHaveFocus();

    await user.tab();
    expect(cancel).toHaveFocus();
  });

  it('closes on Escape and restores focus to the trigger', async () => {
    const user = userEvent.setup();
    const { onInvoke, trigger } = renderHaltControl();
    await user.click(trigger);
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();

    await user.keyboard('{Escape}');

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(onInvoke).not.toHaveBeenCalled();
  });

  it('restores focus to the trigger after Cancel', async () => {
    const user = userEvent.setup();
    const { trigger } = renderHaltControl();
    await user.click(trigger);

    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('restores focus to the trigger after Confirm', async () => {
    const user = userEvent.setup();
    const { onInvoke, trigger } = renderHaltControl();
    await user.click(trigger);

    await user.click(screen.getByRole('button', { name: 'Confirm halt trading' }));

    await waitFor(() => expect(onInvoke).toHaveBeenCalledWith('halt'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('announces an execution failure without implying that an order was placed', () => {
    render(
      <ActionControl
        action="executionCheck"
        label="Check execution now"
        state={{
          phase: 'error',
          message:
            'Execution check failed. Broker did not respond. Order submission could not be confirmed. Check broker activity before retrying.',
          completedAt: 1,
        }}
        onInvoke={vi.fn()}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Order submission could not be confirmed.',
    );
  });

  it('shows a pending label and disables the control', () => {
    render(
      <ActionControl
        action="analysis"
        label="Run analysis"
        state={{ phase: 'pending', startedAt: 1 }}
        onInvoke={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Run analysis in progress' })).toBeDisabled();
  });

  it('announces a successful action without implying an order result', () => {
    render(
      <ActionControl
        action="analysis"
        label="Run analysis"
        state={{ phase: 'success', message: 'Analysis started.', completedAt: 1 }}
        onInvoke={vi.fn()}
      />,
    );

    expect(screen.getByRole('status')).toHaveTextContent('Analysis started.');
  });
});
