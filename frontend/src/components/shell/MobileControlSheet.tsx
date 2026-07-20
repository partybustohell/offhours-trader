import { useEffect, useRef, type RefObject } from 'react';
import type { ActionState, OperatorAction } from '../../app/operatorState';
import type { Mode, Session } from '../../types';
import { ActionControl } from '../workspace/ActionControl';
import type { BrokerState } from './OperationalHeader';

export interface MobileControlSheetProps {
  open: boolean;
  triggerRef: RefObject<HTMLButtonElement | null>;
  mode: Mode | null;
  session: Session | null;
  broker: BrokerState;
  halted: boolean;
  refreshText: string;
  actions: Record<OperatorAction, ActionState>;
  onAction(action: OperatorAction): Promise<void>;
  onClose(): void;
}

function focusable(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(
    'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), '
      + 'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )].filter((element) => element.getAttribute('aria-hidden') !== 'true');
}

function sessionText(session: Session | null): string {
  if (session === 'premarket') return 'Premarket';
  if (session === 'rth') return 'Regular session';
  if (session === 'afterhours') return 'After-hours';
  if (session === 'closed') return 'Market closed';
  return 'Session unknown';
}

function modeText(mode: Mode | null): string {
  if (mode === 'dry-run') return 'Dry run';
  if (mode === 'paper') return 'Paper';
  if (mode === 'live') return 'Live';
  return 'Mode unknown';
}

function brokerText(broker: BrokerState): string {
  if (broker === 'checking') return 'Checking broker';
  if (broker === 'connected') return 'Broker connected';
  if (broker === 'missing-credentials') return 'Broker credentials missing';
  if (broker === 'stale') return 'Broker data stale';
  return 'Broker unavailable';
}

export function MobileControlSheet({
  open,
  triggerRef,
  mode,
  session,
  broker,
  halted,
  refreshText,
  actions,
  onAction,
  onClose,
}: MobileControlSheetProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => {
      const panel = panelRef.current;
      if (panel) focusable(panel)[0]?.focus();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [open]);

  if (!open) return null;

  const close = () => {
    onClose();
    window.setTimeout(() => triggerRef.current?.focus(), 0);
  };

  return (
    <div
      className="control-sheet"
      role="dialog"
      aria-modal="true"
      aria-labelledby="control-sheet-title"
      ref={panelRef}
      onKeyDown={(event) => {
        if (event.defaultPrevented) return;
        const target = event.target;
        if (target instanceof Element && target.closest('.confirmation')) return;
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          close();
          return;
        }
        if (event.key !== 'Tab') return;
        const items = focusable(event.currentTarget);
        if (items.length === 0) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }}
    >
      <div className="control-sheet__surface">
        <header>
          <h2 id="control-sheet-title">Trading controls</h2>
          <button ref={closeButtonRef} type="button" onClick={close}>Close</button>
        </header>
        <dl className="definition-rows">
          <div><dt>Mode</dt><dd>{modeText(mode)}</dd></div>
          <div><dt>Session</dt><dd>{sessionText(session)}</dd></div>
          <div><dt>Broker</dt><dd>{brokerText(broker)}</dd></div>
          <div><dt>Refresh</dt><dd>{refreshText}</dd></div>
        </dl>
        <div className="control-sheet__actions">
          <ActionControl
            action="analysis"
            label="Run analysis"
            state={actions.analysis}
            showResult={false}
            onInvoke={onAction}
          />
          <ActionControl
            action="executionCheck"
            label="Check execution now"
            state={actions.executionCheck}
            showResult={false}
            onInvoke={onAction}
          />
          <ActionControl
            action={halted ? 'resume' : 'halt'}
            label={halted ? 'Resume trading' : 'Halt trading'}
            state={halted ? actions.resume : actions.halt}
            tone={halted ? 'routine' : 'danger'}
            confirmation={halted ? undefined : {
              title: 'Halt trading?',
              body: 'New entries will remain blocked until trading is resumed.',
              confirmLabel: 'Halt trading',
            }}
            confirmationPendingFocusRef={closeButtonRef}
            showResult={false}
            onInvoke={onAction}
          />
        </div>
      </div>
    </div>
  );
}
