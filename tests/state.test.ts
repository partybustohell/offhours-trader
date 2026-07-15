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

describe('position peaks (exit-engine trailing state)', () => {
  it('first observation creates the record with entryTimeMs = now', () => {
    const rec = state.trackPositionPeak('FSLR', 'short', 222.1, 1000);
    expect(rec).toEqual({ side: 'short', entryTimeMs: 1000, peak: 222.1 });
  });

  it('long peak ratchets up and never down', () => {
    state.trackPositionPeak('GS', 'long', 100, 1000);
    expect(state.trackPositionPeak('GS', 'long', 106, 2000).peak).toBe(106);
    const rec = state.trackPositionPeak('GS', 'long', 103, 3000);
    expect(rec.peak).toBe(106);
    expect(rec.entryTimeMs).toBe(1000); // first-seen time is stable
  });

  it('short peak ratchets DOWN (favorable low-water mark)', () => {
    state.trackPositionPeak('FSLR', 'short', 222, 1000);
    expect(state.trackPositionPeak('FSLR', 'short', 218, 2000).peak).toBe(218);
    expect(state.trackPositionPeak('FSLR', 'short', 220, 3000).peak).toBe(218);
  });

  it('a side flip resets the record (re-opened name starts fresh)', () => {
    state.trackPositionPeak('GS', 'long', 100, 1000);
    const rec = state.trackPositionPeak('GS', 'short', 98, 5000);
    expect(rec).toEqual({ side: 'short', entryTimeMs: 5000, peak: 98 });
  });

  it('prunePositionPeaks clears closed positions only', () => {
    state.trackPositionPeak('GS', 'long', 100, 1000);
    state.trackPositionPeak('FSLR', 'short', 222, 1000);
    state.prunePositionPeaks(['GS']);
    expect(state.trackPositionPeak('GS', 'long', 99, 2000).entryTimeMs).toBe(1000);
    // FSLR was pruned: re-observation starts a fresh record
    expect(state.trackPositionPeak('FSLR', 'short', 222, 9000).entryTimeMs).toBe(9000);
  });

  it('a corrupt peaks file degrades to empty state, never throws', () => {
    fs.mkdirSync(path.join(dir, 'out'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'out', 'position-peaks.json'), '{{{');
    expect(state.trackPositionPeak('GS', 'long', 100, 1000).peak).toBe(100);
  });

  it('a zero or NaN mark never corrupts a short peak (no ratchet-to-zero fixed point)', () => {
    state.trackPositionPeak('FSLR', 'short', 222, 1000);
    expect(state.trackPositionPeak('FSLR', 'short', 0, 2000).peak).toBe(222);
    expect(state.trackPositionPeak('FSLR', 'short', NaN, 3000).peak).toBe(222);
    expect(state.trackPositionPeak('FSLR', 'short', 218, 4000).peak).toBe(218);
  });

  it('a bad first observation returns a transient un-armed record and persists nothing', () => {
    const rec = state.trackPositionPeak('GS', 'long', 0, 1000);
    expect(rec).toEqual({ side: 'long', entryTimeMs: 1000, peak: 0 });
    // nothing was persisted: a later good mark starts the durable record fresh
    expect(state.trackPositionPeak('GS', 'long', 100, 2000)).toEqual({ side: 'long', entryTimeMs: 2000, peak: 100 });
  });

  it('prune-all (flat account) clears every record without error', () => {
    state.trackPositionPeak('GS', 'long', 100, 1000);
    state.trackPositionPeak('FSLR', 'short', 222, 1000);
    state.prunePositionPeaks([]);
    expect(state.trackPositionPeak('GS', 'long', 99, 5000).entryTimeMs).toBe(5000);
  });

  it('prune with no peaks file is a no-op', () => {
    expect(() => state.prunePositionPeaks(['GS'])).not.toThrow();
  });
});
