import fs from 'node:fs';
import type { AuditEvent } from './types.js';
import { auditPath, ensureOut } from './paths.js';
import { nowET } from './clock.js';

export function appendAudit(event: Omit<AuditEvent, 'ts'>, at: Date = new Date()): AuditEvent {
  ensureOut();
  const stamped: AuditEvent = { ts: at.toISOString(), kind: event.kind, data: event.data };
  fs.appendFileSync(auditPath(nowET(at).ymd), `${JSON.stringify(stamped)}\n`);
  return stamped;
}

export function readAuditTail(limit: number, ymd: string = nowET().ymd): AuditEvent[] {
  let raw: string;
  try {
    raw = fs.readFileSync(auditPath(ymd), 'utf8');
  } catch {
    return [];
  }
  const events: AuditEvent[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed !== null && typeof parsed === 'object' && 'kind' in parsed) {
        events.push(parsed as AuditEvent);
      }
    } catch {
      // malformed line: skip, do not fail the read
    }
  }
  return events.slice(-limit).reverse();
}
