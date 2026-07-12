import type {
  AuditEvent,
  BacktestResponse,
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

export type ApiResult<T> =
  | { ok: true; data: T; message?: string }
  | { ok: false; error: string };

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

export async function fetchThesis(kind: 'offhours' | 'rth' = 'offhours'): Promise<Thesis | null> {
  const raw = await getJson('/api/thesis?kind=' + kind);
  if (!isObj(raw) || !Array.isArray(raw.entries)) return null;
  return {
    date: typeof raw.date === 'string' ? raw.date : '',
    kind: raw.kind === 'rth' ? 'rth' : 'offhours',
    generatedAt: typeof raw.generatedAt === 'string' ? raw.generatedAt : '',
    expiresAt: typeof raw.expiresAt === 'string' ? raw.expiresAt : '',
    entries: raw.entries as Thesis['entries'],
    skipped: Array.isArray(raw.skipped) ? raw.skipped as Thesis['skipped'] : [],
    regime: isObj(raw.regime) ? raw.regime as unknown as Thesis['regime'] : undefined,
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

/**
 * Broker credentials being absent is an expected local state, not an alert:
 * the setup instructions live in the README, so panels stay quiet about it.
 */
export function isMissingKeysError(message: string): boolean {
  return /requires ALPACA_\w+ and ALPACA_\w+ in \.env/.test(message);
}

export async function fetchAudit(limit = 100): Promise<AuditEvent[]> {
  const raw = await getJson('/api/audit?limit=' + limit);
  const arr = Array.isArray(raw)
    ? raw
    : isObj(raw) && Array.isArray(raw.items)
      ? raw.items
      : isObj(raw) && Array.isArray(raw.events)
        ? raw.events
        : [];
  return arr.flatMap((event): AuditEvent[] => {
    if (!isObj(event)) return [];
    return [{
      ts: typeof event.ts === 'string' ? event.ts : '',
      kind: typeof event.kind === 'string' ? event.kind : 'unknown',
      data: event.data,
    }];
  });
}

export async function fetchConfig(): Promise<Config | null> {
  const raw = await getJson('/api/config');
  const o = isObj(raw) && isObj(raw.config) ? raw.config : raw;
  if (!isObj(o) || typeof o.mode !== 'string') return null;
  return o as unknown as Config;
}

export async function putConfig(next: unknown): Promise<ApiResult<Config>> {
  try {
    const res = await fetch('/api/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(next),
    });
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const message = isObj(body) && typeof body.error === 'string'
        ? body.error
        : 'HTTP ' + res.status;
      return { ok: false, error: message };
    }
    if (!isObj(body) || typeof body.mode !== 'string') {
      return { ok: false, error: 'The server returned an invalid configuration.' };
    }
    return { ok: true, data: body as unknown as Config };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function postAction(
  path: '/api/pipeline/run' | '/api/executor/tick' | '/api/halt' | '/api/resume',
): Promise<ApiResult<unknown>> {
  try {
    const res = await fetch(path, { method: 'POST' });
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const message = isObj(body) && typeof body.error === 'string'
        ? body.error
        : 'HTTP ' + res.status;
      return { ok: false, error: message };
    }
    const message = isObj(body) && typeof body.message === 'string' ? body.message : undefined;
    return { ok: true, data: body, message };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
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

export async function fetchBacktest(): Promise<BacktestResponse> {
  const raw = await getJson('/api/backtest');
  if (isObj(raw) && typeof raw.available === 'boolean') return raw as unknown as BacktestResponse;
  return { available: false };
}
