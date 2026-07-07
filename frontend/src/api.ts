import type {
  AuditEvent,
  AuditKind,
  BrokerOrder,
  CandidateFile,
  Config,
  HaltState,
  Mode,
  OrdersResponse,
  Position,
  PositionsResponse,
  Session,
  StatusResponse,
  Thesis,
  VerdictFile,
} from './types';

const MODES: Mode[] = ['dry-run', 'paper', 'live'];
const SESSIONS: Session[] = ['premarket', 'rth', 'afterhours', 'closed'];
const AUDIT_KINDS: AuditKind[] = [
  'nomination', 'candidates', 'verdict', 'thesis', 'tick', 'proposed_order',
  'order_placed', 'order_rejected', 'exit', 'halt', 'resume', 'error',
];

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`);
  return res.json();
}

function normalizeHalt(o: Record<string, unknown>): HaltState | null {
  const h = isObj(o.halt) ? o.halt : isObj(o.halted) ? o.halted : isObj(o.haltState) ? o.haltState : null;
  if (h) {
    return {
      halted: h.halted === true,
      reason: typeof h.reason === 'string' ? h.reason : '',
      at: typeof h.at === 'string' ? h.at : '',
    };
  }
  if (o.halted === true) return { halted: true, reason: '', at: '' };
  return null;
}

export async function fetchStatus(): Promise<StatusResponse> {
  const raw = await getJson('/api/status');
  const o = isObj(raw) ? raw : {};
  return {
    mode: MODES.includes(o.mode as Mode) ? (o.mode as Mode) : null,
    session: SESSIONS.includes(o.session as Session) ? (o.session as Session) : null,
    halt: normalizeHalt(o),
    equity:
      typeof o.equity === 'number'
        ? o.equity
        : isObj(o.account) && typeof o.account.equity === 'number'
          ? o.account.equity
          : null,
    error: typeof o.error === 'string' ? o.error : undefined,
  };
}

export async function fetchCandidates(): Promise<CandidateFile | null> {
  const raw = await getJson('/api/candidates');
  if (!isObj(raw) || !Array.isArray(raw.candidates)) return null;
  return {
    date: typeof raw.date === 'string' ? raw.date : '',
    candidates: raw.candidates as CandidateFile['candidates'],
    rejected: Array.isArray(raw.rejected) ? (raw.rejected as CandidateFile['rejected']) : [],
  };
}

export async function fetchThesis(): Promise<Thesis | null> {
  const raw = await getJson('/api/thesis');
  if (!isObj(raw) || !Array.isArray(raw.entries)) return null;
  return {
    date: typeof raw.date === 'string' ? raw.date : '',
    generatedAt: typeof raw.generatedAt === 'string' ? raw.generatedAt : '',
    expiresAt: typeof raw.expiresAt === 'string' ? raw.expiresAt : '',
    entries: raw.entries as Thesis['entries'],
    skipped: Array.isArray(raw.skipped) ? (raw.skipped as Thesis['skipped']) : [],
  };
}

export async function fetchVerdicts(): Promise<VerdictFile | null> {
  const raw = await getJson('/api/verdicts');
  if (!isObj(raw) || !Array.isArray(raw.verdicts)) return null;
  return {
    date: typeof raw.date === 'string' ? raw.date : '',
    verdicts: raw.verdicts as VerdictFile['verdicts'],
    droppedAnalysts: Array.isArray(raw.droppedAnalysts)
      ? (raw.droppedAnalysts as VerdictFile['droppedAnalysts'])
      : [],
  };
}

export async function fetchPositions(): Promise<PositionsResponse> {
  const raw = await getJson('/api/positions');
  if (Array.isArray(raw)) return { positions: raw as Position[] };
  if (isObj(raw)) {
    const list = Array.isArray(raw.items) ? raw.items : raw.positions;
    return {
      positions: Array.isArray(list) ? (list as Position[]) : [],
      error: typeof raw.error === 'string' ? raw.error : undefined,
    };
  }
  return { positions: [] };
}

export async function fetchOrders(): Promise<OrdersResponse> {
  const raw = await getJson('/api/orders');
  if (Array.isArray(raw)) return { orders: raw as BrokerOrder[] };
  if (isObj(raw)) {
    const list = Array.isArray(raw.items) ? raw.items : raw.orders;
    return {
      orders: Array.isArray(list) ? (list as BrokerOrder[]) : [],
      error: typeof raw.error === 'string' ? raw.error : undefined,
    };
  }
  return { orders: [] };
}

export async function fetchAudit(limit = 100): Promise<AuditEvent[]> {
  const raw = await getJson(`/api/audit?limit=${limit}`);
  const arr = Array.isArray(raw)
    ? raw
    : isObj(raw) && Array.isArray(raw.items)
      ? raw.items
      : isObj(raw) && Array.isArray(raw.events)
        ? raw.events
        : [];
  const events: AuditEvent[] = [];
  for (const e of arr) {
    if (!isObj(e)) continue;
    events.push({
      ts: typeof e.ts === 'string' ? e.ts : '',
      kind: AUDIT_KINDS.includes(e.kind as AuditKind) ? (e.kind as AuditKind) : 'tick',
      data: e.data,
    });
  }
  return events;
}

export async function fetchConfig(): Promise<Config | null> {
  const raw = await getJson('/api/config');
  const o = isObj(raw) && isObj(raw.config) ? raw.config : raw;
  if (!isObj(o) || typeof o.mode !== 'string') return null;
  return o as unknown as Config;
}

export async function putConfig(next: unknown): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch('/api/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(next),
    });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    const o = isObj(body) ? body : {};
    if (!res.ok) {
      return { ok: false, error: typeof o.error === 'string' ? o.error : `HTTP ${res.status}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function postAction(
  path: '/api/pipeline/run' | '/api/executor/tick' | '/api/halt' | '/api/resume',
): Promise<{ ok: boolean; message?: string }> {
  try {
    const res = await fetch(path, { method: 'POST' });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    const o = isObj(body) ? body : {};
    if (!res.ok) {
      return { ok: false, message: typeof o.error === 'string' ? o.error : `HTTP ${res.status}` };
    }
    return { ok: true, message: typeof o.message === 'string' ? o.message : undefined };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

export function fmtUsd(n: number | null | undefined): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

export function fmtCompactUsd(n: number | null | undefined): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return fmtUsd(n);
}

export function fmtClock(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  return new Date(t).toLocaleTimeString('en-US', { hour12: false });
}
