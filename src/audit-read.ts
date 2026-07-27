// Read-side helper for the append-only audit log (out/audit-YYYY-MM-DD.jsonl).
// Consumers: the feedback report (exit-trigger attribution, judge-veto
// scoring) and the health report. Tolerant by design — a corrupt line or file
// is skipped, never thrown: reporting must not die on history.
import fs from 'node:fs';
import path from 'node:path';
import { OUT_DIR } from './paths.js';

export interface AuditLine {
  ts: string;
  kind: string;
  data: Record<string, unknown>;
}

const AUDIT_RE = /^audit-(\d{4}-\d{2}-\d{2})\.jsonl$/;

/** All audit events from files dated >= sinceYmd, oldest file first. */
export function readAuditEvents(sinceYmd: string, outDir: string = OUT_DIR): AuditLine[] {
  let files: string[];
  try {
    files = fs.readdirSync(outDir);
  } catch {
    return [];
  }
  const wanted = files
    .map((f) => ({ f, m: AUDIT_RE.exec(f) }))
    .filter((x): x is { f: string; m: RegExpExecArray } => x.m !== null && x.m[1]! >= sinceYmd)
    .sort((a, b) => a.m[1]!.localeCompare(b.m[1]!));

  const out: AuditLine[] = [];
  for (const { f } of wanted) {
    let raw: string;
    try {
      raw = fs.readFileSync(path.join(outDir, f), 'utf8');
    } catch {
      continue;
    }
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue;
      try {
        const parsed = JSON.parse(line) as AuditLine;
        if (typeof parsed.ts === 'string' && typeof parsed.kind === 'string') {
          out.push({ ts: parsed.ts, kind: parsed.kind, data: (parsed.data ?? {}) as Record<string, unknown> });
        }
      } catch {
        // corrupt line — skip
      }
    }
  }
  return out;
}
