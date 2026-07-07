import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// paths.ts resolves OUT_DIR from process.cwd() at import time, so each test
// chdirs into a fresh temp dir and re-imports the module graph.
let audit: typeof import('../src/audit.js');
let dir: string;
const originalCwd = process.cwd();

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offhours-audit-'));
  process.chdir(dir);
  vi.resetModules();
  audit = await import('../src/audit.js');
});

afterEach(() => {
  process.chdir(originalCwd);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('appendAudit', () => {
  it('stamps ts and writes one JSON line to the ET-dated file', () => {
    // 01:00Z Jan 6 is 20:00 ET Jan 5 — file must use the ET date
    const at = new Date('2026-01-06T01:00:00Z');
    const stamped = audit.appendAudit({ kind: 'tick', data: { note: 'x' } }, at);
    expect(stamped.ts).toBe('2026-01-06T01:00:00.000Z');

    const file = path.join(dir, 'out', 'audit-2026-01-05.jsonl');
    expect(fs.existsSync(file)).toBe(true);
    const lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({
      ts: '2026-01-06T01:00:00.000Z',
      kind: 'tick',
      data: { note: 'x' },
    });
  });
});

describe('readAuditTail', () => {
  it('returns [] when the file does not exist', () => {
    expect(audit.readAuditTail(100, '2026-01-05')).toEqual([]);
  });

  it('returns events newest first and honors the limit', () => {
    const ymd = '2026-07-06';
    audit.appendAudit({ kind: 'tick', data: 1 }, new Date('2026-07-06T12:00:00Z'));
    audit.appendAudit({ kind: 'thesis', data: 2 }, new Date('2026-07-06T13:00:00Z'));
    audit.appendAudit({ kind: 'halt', data: 3 }, new Date('2026-07-06T14:00:00Z'));

    const all = audit.readAuditTail(100, ymd);
    expect(all.map((e) => e.kind)).toEqual(['halt', 'thesis', 'tick']);

    const tail = audit.readAuditTail(2, ymd);
    expect(tail.map((e) => e.data)).toEqual([3, 2]);
  });

  it('skips malformed lines and keeps valid ones', () => {
    const ymd = '2026-07-06';
    audit.appendAudit({ kind: 'tick', data: 1 }, new Date('2026-07-06T12:00:00Z'));
    const file = path.join(dir, 'out', `audit-${ymd}.jsonl`);
    fs.appendFileSync(file, 'not json at all\n');
    fs.appendFileSync(file, '{"truncated": \n');
    fs.appendFileSync(file, '"a bare json string"\n');
    audit.appendAudit({ kind: 'error', data: 2 }, new Date('2026-07-06T13:00:00Z'));

    const events = audit.readAuditTail(100, ymd);
    expect(events.map((e) => e.kind)).toEqual(['error', 'tick']);
  });
});
