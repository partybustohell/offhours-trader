import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

export const OUT_DIR = path.resolve(process.cwd(), 'out');

export function ensureOut(): void {
  fs.mkdirSync(OUT_DIR, { recursive: true });
}

export const candidatesPath = (ymd: string) => path.join(OUT_DIR, `candidates-${ymd}.json`);
export const verdictsPath = (ymd: string) => path.join(OUT_DIR, `verdicts-${ymd}.json`);
// Off-hours keeps the bare name (backward compatible); RTH is suffixed so the
// morning and evening theses coexist for the same date.
export const thesisPath = (ymd: string, kind: 'offhours' | 'rth' = 'offhours') =>
  path.join(OUT_DIR, kind === 'rth' ? `thesis-${ymd}-rth.json` : `thesis-${ymd}.json`);
export const auditPath = (ymd: string) => path.join(OUT_DIR, `audit-${ymd}.jsonl`);
export const statePath = () => path.join(OUT_DIR, 'state.json');
/** High-water-mark equity for the drawdown throttle (separate file so the halt
 *  state write never clobbers it). */
export const peakPath = () => path.join(OUT_DIR, 'peak.json');
/** Per-position favorable-peak state for the exit engine's trailing stop
 *  (ticker -> { side, entryTimeMs, peak }); cleared as positions close. */
export const peaksPath = () => path.join(OUT_DIR, 'position-peaks.json');

export function writeJsonAtomic(file: string, data: unknown): void {
  ensureOut();
  // unique tmp path per write: concurrent writers must never share an inode
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/**
 * null means the file does not exist. A file that exists but cannot be
 * parsed THROWS — callers that can safely default must catch explicitly;
 * money-adjacent callers must abort rather than treat corruption as absence.
 */
export function readJsonIfExists<T>(file: string): T | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  return JSON.parse(raw) as T;
}
