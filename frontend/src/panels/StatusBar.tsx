import type { Session, StatusResponse } from '../types';
import { fmtUsd } from '../api';

const SESSION_LABEL: Record<Session, string> = {
  premarket: 'Pre-market',
  rth: 'Regular hours',
  afterhours: 'After-hours',
  closed: 'Closed',
};

interface Props {
  status: StatusResponse | null;
  lastUpdated: Date | null;
  offline: boolean;
}

export default function StatusBar({ status, lastUpdated, offline }: Props) {
  const mode = status?.mode ?? null;
  const halt = status?.halt ?? null;
  const halted = halt?.halted === true;
  return (
    <div className="status-items">
      <span className="app-name">offhours-trader</span>
      <span className={`badge ${mode ? `mode-${mode}` : 'badge-gray'}`}>
        {mode ? mode.toUpperCase() : '—'}
      </span>
      <span className="status-item">
        <span className="status-label">session</span>
        {status?.session ? SESSION_LABEL[status.session] : '—'}
      </span>
      <span className="status-item">
        <span className="status-label">halt</span>
        {halted ? (
          <span className="halt-flag" title={halt?.reason || undefined}>
            HALTED{halt?.reason ? ` — ${halt.reason}` : ''}
          </span>
        ) : (
          'off'
        )}
      </span>
      <span className="status-item">
        <span className="status-label">equity</span>
        {fmtUsd(status?.equity)}
      </span>
      {status?.error ? <span className="status-error">{status.error}</span> : null}
      {offline ? <span className="status-error">server unreachable</span> : null}
      {lastUpdated ? (
        <span className="status-updated">
          updated {lastUpdated.toLocaleTimeString('en-US', { hour12: false })}
        </span>
      ) : null}
    </div>
  );
}
