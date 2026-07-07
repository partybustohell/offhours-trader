import path from 'node:path';
import fs from 'node:fs';

export const OUT_DIR = path.resolve(process.cwd(), 'out');

export function ensureOut(): void {
  fs.mkdirSync(OUT_DIR, { recursive: true });
}

export const candidatesPath = (ymd: string) => path.join(OUT_DIR, `candidates-${ymd}.json`);
export const verdictsPath = (ymd: string) => path.join(OUT_DIR, `verdicts-${ymd}.json`);
export const thesisPath = (ymd: string) => path.join(OUT_DIR, `thesis-${ymd}.json`);
export const auditPath = (ymd: string) => path.join(OUT_DIR, `audit-${ymd}.jsonl`);
export const statePath = () => path.join(OUT_DIR, 'state.json');

export function writeJsonAtomic(file: string, data: unknown): void {
  ensureOut();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

export function readJsonIfExists<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}
