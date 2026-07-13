import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type Dispatch, type SetStateAction } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { ActionState } from '../../app/operatorState';
import { ActionControl } from './ActionControl';

function createDeferred() {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((fulfill, fail) => {
    resolve = fulfill;
    reject = fail;
  });
  return { promise, resolve, reject };
}

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

  it('waits for local and parent pending state to clear before restoring focus', async () => {
    const user = userEvent.setup();
    const deferred = createDeferred();
    let setActionState: Dispatch<SetStateAction<ActionState>> = () => undefined;
    const onInvoke = vi.fn(async () => {
      setActionState({ phase: 'pending', startedAt: 1 });
      await deferred.promise;
    });

    function Harness() {
      const [state, setState] = useState<ActionState>({ phase: 'idle' });
      setActionState = setState;
      return (
        <ActionControl
          action="halt"
          label="Halt trading"
          state={state}
          tone="danger"
          confirmation={{
            title: 'Halt trading?',
            body: 'New entries will remain blocked until trading is resumed.',
            confirmLabel: 'Halt trading',
          }}
          onInvoke={onInvoke}
        />
      );
    }

    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Halt trading' });
    await user.click(trigger);
    const focusSpy = vi.spyOn(trigger, 'focus');

    await user.click(screen.getByRole('button', { name: 'Confirm halt trading' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toBeDisabled();
    expect(focusSpy).not.toHaveBeenCalled();

    await act(async () => deferred.resolve());
    expect(trigger).toBeDisabled();
    expect(focusSpy).not.toHaveBeenCalled();

    act(() => setActionState({ phase: 'success', message: 'Trading halted.', completedAt: 2 }));
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(focusSpy).toHaveBeenCalledOnce();
  });

  it('prevents same-tick duplicate routine invokes', async () => {
    const deferred = createDeferred();
    const onInvoke = vi.fn(() => deferred.promise);
    render(
      <ActionControl
        action="analysis"
        label="Run analysis"
        state={{ phase: 'idle' }}
        onInvoke={onInvoke}
      />,
    );
    const trigger = screen.getByRole('button', { name: 'Run analysis' });

    act(() => {
      trigger.click();
      trigger.click();
    });

    expect(onInvoke).toHaveBeenCalledOnce();
    expect(trigger).toBeDisabled();
    await act(async () => deferred.resolve());
  });

  it('prevents same-tick duplicate confirmed invokes', async () => {
    const user = userEvent.setup();
    const deferred = createDeferred();
    const { onInvoke, trigger } = renderHaltControl(
      vi.fn(() => deferred.promise),
    );
    await user.click(trigger);
    const confirm = screen.getByRole('button', { name: 'Confirm halt trading' });

    act(() => {
      confirm.click();
      confirm.click();
    });

    expect(onInvoke).toHaveBeenCalledOnce();
    expect(trigger).toBeDisabled();
    await act(async () => deferred.resolve());
  });

  it('catches a rejected invoke, reports it, restores focus, and allows retry', async () => {
    const user = userEvent.setup();
    const onInvoke = vi
      .fn()
      .mockRejectedValueOnce(new Error('Service unavailable.'))
      .mockResolvedValueOnce(undefined);
    render(
      <ActionControl
        action="analysis"
        label="Run analysis"
        state={{ phase: 'idle' }}
        onInvoke={onInvoke}
      />,
    );
    const trigger = screen.getByRole('button', { name: 'Run analysis' });

    await user.click(trigger);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Run analysis failed. Service unavailable.',
    );
    expect(trigger).toBeEnabled();
    expect(trigger).toHaveFocus();

    await user.click(trigger);
    await waitFor(() => expect(onInvoke).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('uses conservative wording when an execution check invoke rejects', async () => {
    const user = userEvent.setup();
    render(
      <ActionControl
        action="executionCheck"
        label="Check execution now"
        state={{ phase: 'idle' }}
        onInvoke={vi.fn().mockRejectedValue(new Error('Broker did not respond.'))}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Check execution now' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Execution check failed. Broker did not respond. Order submission could not be confirmed. Check broker activity before retrying.',
    );
  });

  it('overrides stale external pending after a caught rejection and allows guarded retry', async () => {
    const user = userEvent.setup();
    const first = createDeferred();
    const retry = createDeferred();
    let invocation = 0;
    let setActionState: Dispatch<SetStateAction<ActionState>> = () => undefined;
    const onInvoke = vi.fn(async () => {
      setActionState({ phase: 'pending', startedAt: 1 });
      invocation += 1;
      await (invocation === 1 ? first.promise : retry.promise);
    });

    function Harness() {
      const [state, setState] = useState<ActionState>({ phase: 'idle' });
      setActionState = setState;
      return (
        <ActionControl
          action="executionCheck"
          label="Check execution now"
          state={state}
          onInvoke={onInvoke}
        />
      );
    }

    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Check execution now' });
    await user.click(trigger);
    expect(trigger).toBeDisabled();

    await act(async () => first.reject(new Error('Broker did not respond.')));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Execution check failed. Broker did not respond. Order submission could not be confirmed. Check broker activity before retrying.',
    );
    expect(trigger).toBeEnabled();
    expect(trigger).toHaveFocus();

    act(() => {
      trigger.click();
      trigger.click();
    });
    expect(onInvoke).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(trigger).toBeDisabled();

    act(() =>
      setActionState({
        phase: 'success',
        message: 'Execution check completed.',
        completedAt: 2,
      }),
    );
    await act(async () => retry.resolve());
    await waitFor(() => expect(trigger).toBeEnabled());
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
