import { useEffect, useRef, useState } from 'react';
import type { ActionState, OperatorAction } from '../../app/operatorState';

function punctuate(message: string): string {
  return /[.!?]$/.test(message) ? message : message + '.';
}

function rejectionMessage(
  action: OperatorAction,
  label: string,
  error: unknown,
): string {
  const raw = error instanceof Error
    ? error.message.trim()
    : typeof error === 'string'
      ? error.trim()
      : '';
  const detail = punctuate(raw || 'The action did not complete.');
  if (action === 'executionCheck') {
    return (
      'Execution check failed. ' +
      detail +
      ' Order submission could not be confirmed. Check broker activity before retrying.'
    );
  }
  return label + ' failed. ' + detail;
}

export interface ActionControlProps {
  action: OperatorAction;
  label: string;
  state: ActionState;
  tone?: 'routine' | 'danger';
  confirmation?: {
    title: string;
    body: string;
    confirmLabel: string;
  };
  disabled?: boolean;
  showResult?: boolean;
  onInvoke(action: OperatorAction): Promise<void>;
}

export function ActionControl({
  action,
  label,
  state,
  tone = 'routine',
  confirmation,
  disabled = false,
  showResult = true,
  onInvoke,
}: ActionControlProps) {
  const [confirming, setConfirming] = useState(false);
  const [localPending, setLocalPending] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [restoreFocus, setRestoreFocus] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const inFlightRef = useRef(false);
  const pending = localError === null && (state.phase === 'pending' || localPending);

  useEffect(() => {
    if (confirming) cancelRef.current?.focus();
  }, [confirming]);

  useEffect(() => {
    const trigger = triggerRef.current;
    if (!restoreFocus || pending || disabled || !trigger || trigger.disabled) return;
    trigger.focus();
    setRestoreFocus(false);
  }, [disabled, pending, restoreFocus]);

  const restoreTriggerFocus = () => {
    window.setTimeout(() => {
      const trigger = triggerRef.current;
      if (trigger && !trigger.disabled) trigger.focus();
    }, 0);
  };

  const close = () => {
    setConfirming(false);
    restoreTriggerFocus();
  };

  const invoke = async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setConfirming(false);
    setLocalPending(true);
    setLocalError(null);
    setRestoreFocus(false);
    try {
      await onInvoke(action);
    } catch (error) {
      setLocalError(rejectionMessage(action, label, error));
    } finally {
      inFlightRef.current = false;
      setLocalPending(false);
      setRestoreFocus(true);
    }
  };

  const errorMessage = localError ?? (state.phase === 'error' ? state.message : null);

  return (
    <div className={'action-control action-control--' + tone}>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled || pending}
        aria-label={pending ? label + ' in progress' : label}
        onClick={() => (confirmation ? setConfirming(true) : void invoke())}
      >
        {pending ? label + '…' : label}
      </button>
      {confirming && confirmation ? (
        <div
          className="confirmation"
          role="dialog"
          aria-modal="true"
          aria-labelledby={action + '-confirmation-title'}
          aria-describedby={action + '-confirmation-description'}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              close();
              return;
            }
            if (event.key === 'Tab') {
              event.preventDefault();
              const active = document.activeElement;
              const next = event.shiftKey
                ? active === cancelRef.current
                  ? confirmRef.current
                  : cancelRef.current
                : active === confirmRef.current
                  ? cancelRef.current
                  : confirmRef.current;
              next?.focus();
            }
          }}
        >
          <div className="confirmation__surface">
            <h2 id={action + '-confirmation-title'}>{confirmation.title}</h2>
            <p id={action + '-confirmation-description'}>{confirmation.body}</p>
            <div className="confirmation__actions">
              <button ref={cancelRef} type="button" onClick={close}>
                Cancel
              </button>
              <button
                ref={confirmRef}
                type="button"
                className="is-danger"
                aria-label={'Confirm ' + confirmation.confirmLabel.toLowerCase()}
                onClick={() => void invoke()}
              >
                {confirmation.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {showResult && state.phase === 'success' && localError === null ? (
        <div className="action-control__result is-success" role="status" aria-live="polite">
          {state.message}
        </div>
      ) : null}
      {showResult && errorMessage !== null ? (
        <div className="action-control__result is-error" role="alert" aria-live="assertive">
          {errorMessage}
        </div>
      ) : null}
    </div>
  );
}
