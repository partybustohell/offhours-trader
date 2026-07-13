import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  AuditEvent,
  BacktestResponse,
  CandidateFile,
  Config,
  OrdersResponse,
  PositionsResponse,
  StatusResponse,
  Thesis,
  VerdictFile,
} from './types';
import {
  fetchAudit,
  fetchBacktest,
  fetchCandidates,
  fetchConfig,
  fetchOrders,
  fetchPositions,
  fetchStatus,
  fetchThesis,
  fetchVerdicts,
  fmtCompactUsd,
  isMissingKeysError,
  postAction,
} from './api';
import { useHashView, type ViewId } from './router';
import Overview from './views/Overview';
import ThesisView from './views/ThesisView';
import PositionsView from './views/PositionsView';
import BacktestView from './views/BacktestView';
import ConfigView from './views/ConfigView';
import AuditView from './views/AuditView';

const POLL_MS = 10_000;

export interface AppData {
  status: StatusResponse | null;
  candidates: CandidateFile | null;
  thesis: Thesis | null; // off-hours
  thesisRth: Thesis | null;
  verdicts: VerdictFile | null;
  positions: PositionsResponse;
  orders: OrdersResponse;
  audit: AuditEvent[];
  config: Config | null;
  backtest: BacktestResponse | null;
  offline: boolean;
  lastUpdated: Date | null;
}

const NAV: { id: ViewId; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'thesis', label: 'Thesis' },
  { id: 'positions', label: 'Positions' },
  { id: 'backtest', label: 'Backtest' },
  { id: 'config', label: 'Config' },
  { id: 'audit', label: 'Audit' },
];

const SESSION_LABEL: Record<string, string> = {
  premarket: 'Pre-market',
  rth: 'Regular',
  afterhours: 'After-hours',
  closed: 'Closed',
};

export default function App() {
  const [view, go] = useHashView();
  const [d, setD] = useState<AppData>({
    status: null,
    candidates: null,
    thesis: null,
    thesisRth: null,
    verdicts: null,
    positions: { positions: [] },
    orders: { orders: [] },
    audit: [],
    config: null,
    backtest: null,
    offline: false,
    lastUpdated: null,
  });

  const refresh = useCallback(async () => {
    const [st, ca, th, thr, ve, po, or, au, cf, bt] = await Promise.allSettled([
      fetchStatus(),
      fetchCandidates(),
      fetchThesis('offhours'),
      fetchThesis('rth'),
      fetchVerdicts(),
      fetchPositions(),
      fetchOrders(),
      fetchAudit(150),
      fetchConfig(),
      fetchBacktest(),
    ]);
    setD((prev) => ({
      status: st.status === 'fulfilled' ? st.value : prev.status,
      candidates: ca.status === 'fulfilled' ? ca.value : prev.candidates,
      thesis: th.status === 'fulfilled' ? th.value : prev.thesis,
      thesisRth: thr.status === 'fulfilled' ? thr.value : prev.thesisRth,
      verdicts: ve.status === 'fulfilled' ? ve.value : prev.verdicts,
      positions: po.status === 'fulfilled' ? po.value : prev.positions,
      orders: or.status === 'fulfilled' ? or.value : prev.orders,
      audit: au.status === 'fulfilled' ? au.value : prev.audit,
      config: cf.status === 'fulfilled' ? cf.value : prev.config,
      backtest: bt.status === 'fulfilled' ? bt.value : prev.backtest,
      offline: st.status === 'rejected',
      lastUpdated: new Date(),
    }));
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  const halted = d.status?.halt?.halted === true;
  const activeThesis =
    d.status?.session === 'rth' ? (d.thesisRth ?? d.thesis) : (d.thesis ?? d.thesisRth);
  const counts: Partial<Record<ViewId, number>> = {
    positions: d.positions.positions.length,
    thesis: activeThesis?.entries.length ?? 0,
  };

  return (
    <div className="app">
      <NavRail view={view} go={go} config={d.config} counts={counts} />
      <div className="stage">
        <Telemetry data={d} onAction={refresh} halted={halted} />
        <main className="view" key={view}>
          {view === 'overview' && <Overview d={d} go={go} activeThesis={activeThesis} />}
          {view === 'thesis' && <ThesisView d={d} />}
          {view === 'positions' && (
            <PositionsView positions={d.positions} orders={d.orders} audit={d.audit} />
          )}
          {view === 'backtest' && <BacktestView backtest={d.backtest} />}
          {view === 'config' && <ConfigView d={d} onSaved={refresh} />}
          {view === 'audit' && <AuditView events={d.audit} />}
        </main>
      </div>
    </div>
  );
}

function NavRail({
  view,
  go,
  config,
  counts,
}: {
  view: ViewId;
  go: (v: ViewId) => void;
  config: Config | null;
  counts: Partial<Record<ViewId, number>>;
}) {
  return (
    <nav className="rail">
      <div className="rail-brand">
        <div className="rail-mark">
          <span className="glyph" />
          offhours
        </div>
        <div className="rail-sub">instrument · v1</div>
      </div>
      <div className="rail-nav">
        {NAV.map((n, i) => (
          <button
            key={n.id}
            className={`rail-link${view === n.id ? ' active' : ''}`}
            onClick={() => go(n.id)}
          >
            <span className="idx">{String(i + 1).padStart(2, '0')}</span>
            {n.label}
            {counts[n.id] ? <span className="rail-badge">{counts[n.id]}</span> : null}
          </button>
        ))}
      </div>
      <div className="rail-foot">
        <div className="row">
          <span>mode</span>
          <b>{config?.mode ?? '—'}</b>
        </div>
        <div className="row">
          <span>feed</span>
          <b>{config?.data_feed ?? '—'}</b>
        </div>
        <div className="row">
          <span>threshold</span>
          <b>{config ? config.conviction_threshold.toFixed(2) : '—'}</b>
        </div>
      </div>
    </nav>
  );
}

function Telemetry({
  data,
  onAction,
  halted,
}: {
  data: AppData;
  onAction: () => void;
  halted: boolean;
}) {
  const [clock, setClock] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    const tick = () =>
      setClock(
        new Date().toLocaleTimeString('en-US', {
          hour12: false,
          timeZone: 'America/New_York',
        }) + ' ET',
      );
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, []);

  // Countdown to the next executor tick: the interval from config, anchored to
  // the most recent tick in the audit so it tracks the real launchd cadence.
  const intervalMin = data.config?.executor_interval_min ?? 15;
  const lastTickMs = useMemo(() => {
    let m = 0;
    for (const e of data.audit) {
      if (e.kind === 'tick') {
        const t = Date.parse(e.ts);
        if (Number.isFinite(t) && t > m) m = t;
      }
    }
    return m || null;
  }, [data.audit]);
  const [nextTick, setNextTick] = useState('—');
  useEffect(() => {
    const upd = () => {
      if (!lastTickMs) return setNextTick('—');
      const intervalMs = intervalMin * 60_000;
      const now = Date.now();
      const next = lastTickMs + Math.ceil(Math.max(1, now - lastTickMs) / intervalMs) * intervalMs;
      const rem = Math.max(0, next - now);
      const mm = Math.floor(rem / 60_000);
      const ss = Math.floor((rem % 60_000) / 1000);
      setNextTick(`${mm}:${String(ss).padStart(2, '0')}`);
    };
    upd();
    const t = setInterval(upd, 1000);
    return () => clearInterval(t);
  }, [lastTickMs, intervalMin]);

  const st = data.status;
  const mode = st?.mode ?? 'paper';
  const equity = st?.equity;
  const keyless = st?.error && isMissingKeysError(st.error);

  const act = async (
    path: '/api/pipeline/run' | '/api/executor/tick' | '/api/halt' | '/api/resume',
    label: string,
  ) => {
    if (path === '/api/halt' && !window.confirm('Halt all trading until manually resumed?')) return;
    setBusy(label);
    await postAction(path);
    await onAction();
    setBusy(null);
  };

  return (
    <header className="telemetry">
      <div className="tel-cell">
        <span className="label">Mode</span>
        <span className="tel-val">
          <span className={`badge ${mode}`}>{mode}</span>
        </span>
      </div>
      <div className="tel-cell">
        <span className="label">Session</span>
        <span className="tel-val">
          <span className="live-dot" />
          {SESSION_LABEL[st?.session ?? 'closed'] ?? '—'}
        </span>
      </div>
      <div className="tel-cell">
        <span className="label">Equity</span>
        <span className="tel-val">{keyless ? '—' : fmtCompactUsd(equity)}</span>
      </div>
      <div className="tel-cell">
        <span className="label">Halt</span>
        <span className="tel-val" style={{ color: halted ? 'var(--red)' : 'var(--muted)' }}>
          {halted ? 'HALTED' : 'clear'}
        </span>
      </div>
      <div className="tel-cell">
        <span className="label">Next tick</span>
        <span className="tel-val tel-countdown" title={`executor runs every ${intervalMin} min`}>
          {nextTick}
        </span>
      </div>
      <div className="tel-cell tel-spacer">
        <span className="label">Local</span>
        <span className="tel-clock">{clock}</span>
      </div>
      <div className="tel-actions">
        <button className="btn" disabled={!!busy} onClick={() => void act('/api/pipeline/run', 'p')}>
          {busy === 'p' ? '…' : 'Pipeline'}
        </button>
        <button className="btn" disabled={!!busy} onClick={() => void act('/api/executor/tick', 't')}>
          {busy === 't' ? '…' : 'Tick'}
        </button>
        {halted ? (
          <button
            className="btn primary"
            disabled={!!busy}
            onClick={() => void act('/api/resume', 'r')}
          >
            Resume
          </button>
        ) : (
          <button className="btn danger" disabled={!!busy} onClick={() => void act('/api/halt', 'h')}>
            Halt
          </button>
        )}
      </div>
    </header>
  );
}
