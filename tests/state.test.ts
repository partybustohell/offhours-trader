import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// paths.ts resolves OUT_DIR from process.cwd() at import time, so each test
// chdirs into a fresh temp dir and re-imports the module graph.
let state: typeof import('../src/state.js');
let dir: string;
const originalCwd = process.cwd();

const stateFile = () => path.join(dir, 'out', 'state.json');

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offhours-state-'));
  process.chdir(dir);
  vi.resetModules();
  state = await import('../src/state.js');
});

afterEach(() => {
  process.chdir(originalCwd);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('readHaltState', () => {
  it('defaults to not halted when the file is missing', () => {
    expect(state.readHaltState()).toEqual({ halted: false, reason: '', at: '' });
  });

  it('defaults to not halted when the file is corrupt', () => {
    fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
    fs.writeFileSync(stateFile(), '{{{ not json');
    expect(state.readHaltState()).toEqual({ halted: false, reason: '', at: '' });
  });

  it('defaults to not halted when the file has the wrong shape', () => {
    fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
    fs.writeFileSync(stateFile(), JSON.stringify({ halted: 'yes' }));
    expect(state.readHaltState()).toEqual({ halted: false, reason: '', at: '' });
  });
});

describe('peak equity high-water mark', () => {
  it('reads 0 when never recorded', () => {
    expect(state.readPeakEquity()).toBe(0);
  });

  it('raises the peak only when a higher equity arrives', () => {
    expect(state.updatePeakEquity(50_000)).toBe(50_000);
    expect(state.updatePeakEquity(60_000)).toBe(60_000);
    expect(state.updatePeakEquity(55_000)).toBe(60_000); // does not lower the peak
    expect(state.readPeakEquity()).toBe(60_000);
  });

  it('survives a halt write (separate file)', () => {
    state.updatePeakEquity(70_000);
    state.writeHalt('daily loss halt');
    expect(state.readPeakEquity()).toBe(70_000);
  });
});

describe('halt round-trip', () => {
  it('writeHalt persists and readHaltState returns it', () => {
    const at = new Date('2026-07-06T20:30:00Z');
    state.writeHalt('daily loss halt', at);
    expect(state.readHaltState()).toEqual({
      halted: true,
      reason: 'daily loss halt',
      at: '2026-07-06T20:30:00.000Z',
    });
  });

  it('clearHalt resumes trading', () => {
    state.writeHalt('manual halt');
    expect(state.readHaltState().halted).toBe(true);
    state.clearHalt(new Date('2026-07-06T21:00:00Z'));
    const s = state.readHaltState();
    expect(s.halted).toBe(false);
    expect(s.reason).toBe('');
    expect(s.at).toBe('2026-07-06T21:00:00.000Z');
  });
});
