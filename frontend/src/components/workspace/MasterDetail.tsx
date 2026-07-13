import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

const mobileDetailBreakpoint = 900;
const focusableSelector = [
  'button:not(:disabled)',
  'a[href]',
  'input:not(:disabled)',
  'select:not(:disabled)',
  'textarea:not(:disabled)',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function fallbackFocusTarget(master: HTMLElement): HTMLElement | null {
  const selected = master.querySelector<HTMLElement>('[aria-selected="true"]');
  if (selected && selected.matches(focusableSelector)) return selected;
  return master.querySelector<HTMLElement>(focusableSelector);
}

export interface MasterDetailProps {
  master: ReactNode;
  detail: ReactNode;
  detailOpen: boolean;
  detailLabel: string;
  backLabel?: string;
  onDetailClose(): void;
}

export function MasterDetail({
  master,
  detail,
  detailOpen,
  detailLabel,
  backLabel = 'Back to list',
  onDetailClose,
}: MasterDetailProps) {
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const masterRef = useRef<HTMLDivElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const previousDetailOpenRef = useRef(detailOpen);

  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const mobile = viewportWidth < mobileDetailBreakpoint;

  useLayoutEffect(() => {
    const wasOpen = previousDetailOpenRef.current;
    previousDetailOpenRef.current = detailOpen;
    if (!mobile || wasOpen === detailOpen) return;

    if (detailOpen) {
      backRef.current?.focus();
      return;
    }

    const master = masterRef.current;
    if (!master) return;
    const retained = returnFocusRef.current;
    const target =
      retained && retained.isConnected && master.contains(retained)
        ? retained
        : fallbackFocusTarget(master);
    target?.focus();
    returnFocusRef.current = null;
  }, [detailOpen, mobile]);

  return (
    <div className="master-detail" data-detail-open={detailOpen}>
      <div
        ref={masterRef}
        className="master-detail__master"
        hidden={mobile && detailOpen}
        onFocusCapture={(event) => {
          if (mobile && !detailOpen && event.target instanceof HTMLElement) {
            returnFocusRef.current = event.target;
          }
        }}
      >
        {master}
      </div>
      <div
        className="master-detail__detail"
        role="group"
        aria-label={detailLabel}
        aria-hidden={detailOpen ? false : undefined}
        hidden={mobile && !detailOpen}
      >
        <button
          ref={backRef}
          className="master-detail__back"
          type="button"
          onClick={onDetailClose}
        >
          {backLabel}
        </button>
        {detail}
      </div>
    </div>
  );
}
