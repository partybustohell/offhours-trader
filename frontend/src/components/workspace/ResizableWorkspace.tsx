import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';

export interface ColumnWidths {
  left: number;
  right: number;
}

export interface WorkspaceConstraints {
  left: readonly [220, 360];
  centerMin: number;
  right: readonly [300, 480];
}

export interface ResizableWorkspaceProps {
  storageKey: string;
  defaults: ColumnWidths;
  constraints: WorkspaceConstraints;
  left: ReactNode;
  center: ReactNode;
  right: ReactNode;
  bottom?: ReactNode;
  detailOpen?: boolean;
  detailLabel?: string;
  onDetailClose?(): void;
}

const dividerWidth = 1;
const mobileDetailBreakpoint = 900;
const wideWorkspaceMin = 1016;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function fitWidths(
  containerWidth: number,
  desired: ColumnWidths,
  constraints: WorkspaceConstraints,
): ColumnWidths {
  let left = clamp(desired.left, constraints.left[0], constraints.left[1]);
  let right = clamp(desired.right, constraints.right[0], constraints.right[1]);
  const sideBudget = containerWidth - constraints.centerMin - dividerWidth * 2;
  let excess = Math.max(0, left + right - sideBudget);
  const rightReduction = Math.min(excess, right - constraints.right[0]);
  right -= rightReduction;
  excess -= rightReduction;
  left -= Math.min(excess, left - constraints.left[0]);
  return { left, right };
}

function readStored(key: string, fallback: ColumnWidths): ColumnWidths {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? 'null') as {
      version?: unknown;
      left?: unknown;
      right?: unknown;
    } | null;
    if (
      parsed?.version === 1 &&
      typeof parsed.left === 'number' &&
      Number.isFinite(parsed.left) &&
      typeof parsed.right === 'number' &&
      Number.isFinite(parsed.right)
    ) {
      return { left: parsed.left, right: parsed.right };
    }
  } catch {
    return fallback;
  }
  return fallback;
}

export function ResizableWorkspace({
  storageKey,
  defaults,
  constraints,
  left,
  center,
  right,
  bottom,
  detailOpen = false,
  detailLabel = 'Detail',
  onDetailClose = () => undefined,
}: ResizableWorkspaceProps) {
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const [desired, setDesired] = useState(() => readStored(storageKey, defaults));
  const drag = useRef<{
    side: 'left' | 'right';
    startX: number;
    widths: ColumnWidths;
  } | null>(null);

  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const wide = viewportWidth >= wideWorkspaceMin;
  const mobile = viewportWidth < mobileDetailBreakpoint;
  const effective = useMemo(
    () => fitWidths(viewportWidth, desired, constraints),
    [constraints, desired, viewportWidth],
  );

  const persist = (next: ColumnWidths) => {
    setDesired(next);
    localStorage.setItem(storageKey, JSON.stringify({ version: 1, ...next }));
  };

  const resize = (side: 'left' | 'right', requested: number) => {
    const sideBudget = viewportWidth - constraints.centerMin - dividerWidth * 2;
    if (side === 'left') {
      const maximum = Math.min(constraints.left[1], sideBudget - effective.right);
      persist({ ...effective, left: clamp(requested, constraints.left[0], maximum) });
    } else {
      const maximum = Math.min(constraints.right[1], sideBudget - effective.left);
      persist({ ...effective, right: clamp(requested, constraints.right[0], maximum) });
    }
  };

  const beginDrag = (
    side: 'left' | 'right',
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { side, startX: event.clientX, widths: effective };
  };

  const moveDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const delta = event.clientX - drag.current.startX;
    const requested =
      drag.current.side === 'left'
        ? drag.current.widths.left + delta
        : drag.current.widths.right - delta;
    resize(drag.current.side, requested);
  };

  const reset = () => {
    setDesired(defaults);
    localStorage.removeItem(storageKey);
  };

  if (!wide) {
    return (
      <div
        className="resizable-workspace resizable-workspace--compact"
        data-layout="compact"
        data-detail-open={detailOpen}
        data-testid="resizable-workspace"
      >
        <div className="resizable-workspace__left" hidden={mobile && detailOpen}>
          {left}
        </div>
        <div className="resizable-workspace__center" hidden={mobile && detailOpen}>
          {center}
        </div>
        <div
          className="resizable-workspace__right"
          role="group"
          aria-label={detailLabel}
          hidden={mobile && !detailOpen}
        >
          <button
            className="resizable-workspace__back"
            type="button"
            onClick={onDetailClose}
          >
            Back to candidates
          </button>
          {right}
        </div>
        {bottom ? (
          <div className="resizable-workspace__bottom" hidden={mobile && detailOpen}>
            {bottom}
          </div>
        ) : null}
      </div>
    );
  }

  const style = {
    '--left-width': String(effective.left) + 'px',
    '--right-width': String(effective.right) + 'px',
  } as CSSProperties;

  const separator = (side: 'left' | 'right') => {
    const current = effective[side];
    const bounds = constraints[side];
    const direction = side === 'left' ? 1 : -1;
    const sideBudget = viewportWidth - constraints.centerMin - dividerWidth * 2;
    const maximum = Math.min(
      bounds[1],
      sideBudget - (side === 'left' ? effective.right : effective.left),
    );
    return (
      <div
        className={'resizable-workspace__separator is-' + side}
        role="separator"
        aria-label={
          side === 'left' ? 'Resize account pane' : 'Resize candidate detail pane'
        }
        aria-orientation="vertical"
        aria-valuemin={bounds[0]}
        aria-valuemax={maximum}
        aria-valuenow={current}
        tabIndex={0}
        onKeyDown={(event) => {
          let requested: number;
          if (event.key === 'ArrowLeft') requested = current - 10 * direction;
          else if (event.key === 'ArrowRight') requested = current + 10 * direction;
          else if (event.key === 'Home') requested = bounds[0];
          else if (event.key === 'End') requested = maximum;
          else return;
          event.preventDefault();
          resize(side, requested);
        }}
        onPointerDown={(event) => beginDrag(side, event)}
        onPointerMove={moveDrag}
        onPointerUp={() => {
          drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
        onDoubleClick={reset}
      />
    );
  };

  return (
    <div
      className="resizable-workspace"
      data-layout="wide"
      data-testid="resizable-workspace"
      style={style}
    >
      <div className="resizable-workspace__left">{left}</div>
      {separator('left')}
      <div className="resizable-workspace__center">{center}</div>
      {separator('right')}
      <div className="resizable-workspace__right">{right}</div>
      {bottom ? <div className="resizable-workspace__bottom">{bottom}</div> : null}
    </div>
  );
}
