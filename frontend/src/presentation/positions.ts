import type { AuditEvent } from '../types';
import { formatEtTimestamp, sentenceCase } from './format';

export interface RiskRejectionRow {
  id: string;
  symbol: string;
  reason: string;
  timestamp: string;
  raw: AuditEvent;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function etDate(value: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(value);
}

export function humanizeBrokerStatus(raw: string): string {
  return sentenceCase(raw);
}

function clinicalReason(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const reason = sentenceCase(value);
  return /[.!?…]$/.test(reason) ? reason : reason + '.';
}

function rejectionReason(data: Record<string, unknown>): string {
  const reasons = Array.isArray(data.reasons)
    ? data.reasons.flatMap((reason) => {
        const presented = clinicalReason(reason);
        return presented ? [presented] : [];
      })
    : [];
  if (reasons.length > 0) return reasons.join(' ');
  return clinicalReason(data.reason) ?? 'Reason not recorded.';
}

export function buildRiskRejections(
  events: readonly AuditEvent[],
  now = new Date(),
): RiskRejectionRow[] {
  const today = etDate(now);
  return events.flatMap((event, index): RiskRejectionRow[] => {
    if (event.kind !== 'order_rejected') return [];
    const timestamp = new Date(event.ts);
    if (!Number.isFinite(timestamp.getTime()) || etDate(timestamp) !== today) return [];
    const data = isRecord(event.data) ? event.data : {};
    const order = isRecord(data.order) ? data.order : data;
    const ticker = typeof order.ticker === 'string' ? order.ticker.trim() : '';
    return [{
      id: event.ts + ':' + index,
      symbol: ticker || 'Not recorded',
      reason: rejectionReason(data),
      timestamp: formatEtTimestamp(event.ts),
      raw: event,
    }];
  });
}
