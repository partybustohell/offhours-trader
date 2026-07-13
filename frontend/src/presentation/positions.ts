import type { AuditEvent } from '../types';
import { formatEtTimestamp, sentenceCase } from './format';

export interface RiskRejectionRow {
  id: string;
  symbol: string;
  reason: string;
  timestamp: string;
  raw: AuditEvent;
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

export function buildRiskRejections(
  events: readonly AuditEvent[],
  now = new Date(),
): RiskRejectionRow[] {
  const today = etDate(now);
  return events.flatMap((event, index): RiskRejectionRow[] => {
    if (event.kind !== 'order_rejected' || etDate(new Date(event.ts)) !== today) return [];
    const data = typeof event.data === 'object' && event.data !== null
      ? event.data as Record<string, unknown>
      : {};
    return [{
      id: event.ts + ':' + index,
      symbol: typeof data.ticker === 'string' ? data.ticker : 'Not recorded',
      reason: typeof data.reason === 'string' ? data.reason : 'Reason not recorded.',
      timestamp: formatEtTimestamp(event.ts),
      raw: event,
    }];
  });
}
