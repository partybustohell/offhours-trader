import { useCallback, useEffect, useState } from 'react';
import type {
  AuditEvent,
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
  fetchCandidates,
  fetchConfig,
  fetchOrders,
  fetchPositions,
  fetchStatus,
  fetchThesis,
  fetchVerdicts,
} from './api';
import StatusBar from './panels/StatusBar';
import ActionsBar from './panels/ActionsBar';
import CandidatesPanel from './panels/CandidatesPanel';
import ThesisPanel from './panels/ThesisPanel';
import VerdictsPanel from './panels/VerdictsPanel';
import PositionsOrders from './panels/PositionsOrders';
import AuditFeed from './panels/AuditFeed';
import ConfigEditor from './panels/ConfigEditor';

const POLL_MS = 10_000;

export default function App() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [candidates, setCandidates] = useState<CandidateFile | null>(null);
  const [thesis, setThesis] = useState<Thesis | null>(null);
  const [verdicts, setVerdicts] = useState<VerdictFile | null>(null);
  const [positions, setPositions] = useState<PositionsResponse>({ positions: [] });
  const [orders, setOrders] = useState<OrdersResponse>({ orders: [] });
  const [audit, setAudit] = useState<AuditEvent[]>([]);
  const [config, setConfig] = useState<Config | null>(null);
  const [offline, setOffline] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const refresh = useCallback(async () => {
    const [st, ca, th, ve, po, or, au, cf] = await Promise.allSettled([
      fetchStatus(),
      fetchCandidates(),
      fetchThesis(),
      fetchVerdicts(),
      fetchPositions(),
      fetchOrders(),
      fetchAudit(100),
      fetchConfig(),
    ]);
    setOffline(st.status === 'rejected');
    if (st.status === 'fulfilled') setStatus(st.value);
    if (ca.status === 'fulfilled') setCandidates(ca.value);
    if (th.status === 'fulfilled') setThesis(th.value);
    if (ve.status === 'fulfilled') setVerdicts(ve.value);
    if (po.status === 'fulfilled') setPositions(po.value);
    if (or.status === 'fulfilled') setOrders(or.value);
    if (au.status === 'fulfilled') setAudit(au.value);
    if (cf.status === 'fulfilled') setConfig(cf.value);
    setLastUpdated(new Date());
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  return (
    <div className="app">
      <header className="statusbar">
        <StatusBar status={status} lastUpdated={lastUpdated} offline={offline} />
        <ActionsBar halted={status?.halt?.halted === true} onRefresh={refresh} />
      </header>
      <main className="grid">
        <ThesisPanel thesis={thesis} />
        <CandidatesPanel data={candidates} />
        <VerdictsPanel data={verdicts} />
        <PositionsOrders
          positions={positions.positions}
          positionsError={positions.error}
          orders={orders.orders}
          ordersError={orders.error}
          audit={audit}
        />
        <AuditFeed events={audit} />
        <ConfigEditor config={config} onSaved={refresh} />
      </main>
    </div>
  );
}
