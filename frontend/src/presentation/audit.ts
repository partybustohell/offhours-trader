import { KNOWN_AUDIT_KINDS, type AuditEvent, type KnownAuditKind } from '../types';
import { formatEtTimestamp, sentenceCase } from './format';

export type ActivityStatus =
  | 'completed'
  | 'skipped'
  | 'rejected'
  | 'failed'
  | 'halted'
  | 'pending'
  | 'unknown';

export interface PresentedAuditEvent {
  id: string;
  timestamp: string;
  activity: string;
  stage: string;
  status: ActivityStatus;
  description: string;
  fields: readonly { key: string; label: string; value: string }[];
  rawJson: string;
  rawKind: string;
  knownKind: boolean;
}

const activity: Record<KnownAuditKind, [string, string]> = {
  nomination: ['Nomination', 'Analysis'],
  candidates: ['Candidate selection', 'Analysis'],
  verdict: ['Analyst review', 'Analysis'],
  thesis: ['Trading plan', 'Analysis'],
  tick: ['Execution check', 'Execution'],
  proposed_order: ['Order review', 'Execution'],
  order_placed: ['Order submitted', 'Broker'],
  order_rejected: ['Order rejected', 'Risk checks'],
  exit: ['Position exit', 'Execution'],
  counterfactual: ['Sizing analysis', 'Analysis'],
  halt: ['Trading halted', 'Controls'],
  resume: ['Trading resumed', 'Controls'],
  error: ['System error', 'System'],
};

function objectData(data: unknown): Record<string, unknown> {
  return typeof data === 'object' && data !== null && !Array.isArray(data)
    ? data as Record<string, unknown>
    : {};
}

function classify(kind: string, data: Record<string, unknown>): ActivityStatus {
  if (!KNOWN_AUDIT_KINDS.includes(kind as KnownAuditKind)) return 'unknown';
  if (kind === 'error') return 'failed';
  if (kind === 'order_rejected') return 'rejected';
  if (kind === 'halt') return 'halted';
  if (kind === 'proposed_order') return 'pending';
  if (data.status === 'skipped' || data.skipped === true) return 'skipped';
  return 'completed';
}

function completeSentence(value: string): string {
  const text = sentenceCase(value);
  return /[.!?]$/.test(text) ? text : text + '.';
}

function describe(kind: string, data: Record<string, unknown>): string {
  if (
    kind === 'tick' &&
    (data.status === 'skipped' || data.skipped === true) &&
    typeof data.reason === 'string' &&
    /closed/i.test(data.reason)
  ) {
    return 'Execution check skipped. The market session is closed. No order was evaluated.';
  }
  const reason = typeof data.reason === 'string' ? data.reason : null;
  const message = typeof data.message === 'string' ? data.message : null;
  const name = KNOWN_AUDIT_KINDS.includes(kind as KnownAuditKind)
    ? activity[kind as KnownAuditKind][0]
    : 'Unknown event';
  if (reason) return name + '. ' + completeSentence(reason);
  if (message) return name + '. ' + completeSentence(message);
  return name + ' recorded.';
}

export function presentAuditEvent(event: AuditEvent, index = 0): PresentedAuditEvent {
  const data = objectData(event.data);
  const knownKind = KNOWN_AUDIT_KINDS.includes(event.kind as KnownAuditKind);
  const [name, stage] = knownKind ? activity[event.kind as KnownAuditKind] : ['Unknown event', 'System'];
  return {
    id: event.ts + ':' + event.kind + ':' + index,
    timestamp: formatEtTimestamp(event.ts),
    activity: name,
    stage,
    status: classify(event.kind, data),
    description: describe(event.kind, data),
    fields: Object.entries(data).map(([label, value]) => ({
      key: label,
      label: sentenceCase(label),
      value: typeof value === 'string' ? value : JSON.stringify(value) ?? 'Not recorded',
    })),
    rawJson: JSON.stringify(event, null, 2),
    rawKind: event.kind,
    knownKind,
  };
}
