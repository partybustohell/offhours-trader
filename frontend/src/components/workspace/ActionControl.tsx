import { useEffect, useRef, useState } from 'react';
import type { ActionState, OperatorAction } from '../../app/operatorState';

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
  onInvoke(action: OperatorAction): Promise<void>;
}

export function ActionControl({
  action,
  label,
  state,
  tone = 'routine',
  confirmation,
  disabled = false,
  onInvoke,
}: ActionControlProps) {
  const [confirming, setConfirming] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const pending = state.phase === 'pending';

  useEffect(() => {
    if (confirming) cancelRef.current?.focus();
  }, [confirming]);

  const restoreTriggerFocus = () => {
    window.setTimeout(() => triggerRef.current?.focus(), 0);
  };

  const close = () => {
    setConfirming(false);
    restoreTriggerFocus();
  };

  const invoke = async () => {
    if (confirming) close();
    await onInvoke(action);
  };

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
      {state.phase === 'success' ? (
        <div className="action-control__result is-success" role="status" aria-live="polite">
          {state.message}
        </div>
      ) : null}
      {state.phase === 'error' ? (
        <div className="action-control__result is-error" role="alert" aria-live="assertive">
          {state.message}
        </div>
      ) : null}
    </div>
  );
}
