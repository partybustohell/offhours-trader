import { describe, expect, it } from 'vitest';
import { presentAuditEvent } from './audit';

describe('presentAuditEvent', () => {
  it('renders unknown kinds as unknown without relabeling them', () => {
    const event = presentAuditEvent({
      ts: '2026-07-12T14:00:00.000Z',
      kind: 'broker_heartbeat',
      data: { ok: true },
    });
    expect(event).toMatchObject({
      activity: 'Unknown event',
      stage: 'System',
      status: 'unknown',
      knownKind: false,
      rawKind: 'broker_heartbeat',
    });
  });

  it('keeps unknown kinds unknown when their data reports a skipped status', () => {
    const event = presentAuditEvent({
      ts: '2026-07-12T14:00:00.000Z',
      kind: 'broker_heartbeat',
      data: { status: 'skipped' },
    });
    expect(event.status).toBe('unknown');
  });

  it('keeps unknown kinds unknown when their data uses an executor skip action', () => {
    const event = presentAuditEvent({
      ts: '2026-07-12T14:00:00.000Z',
      kind: 'broker_heartbeat',
      data: { stage: 'session_gate', action: 'skip' },
    });
    expect(event.status).toBe('unknown');
  });

  it('states a closed-session execution skip clinically', () => {
    const event = presentAuditEvent({
      ts: '2026-07-12T14:00:00.000Z',
      kind: 'tick',
      data: { status: 'skipped', reason: 'market session is closed' },
    });
    expect(event.description).toBe(
      'Execution check skipped. The market session is closed. No order was evaluated.',
    );
  });

  it('classifies exact production executor skip shapes as skipped', () => {
    for (const data of [
      {
        stage: 'session_gate',
        session: 'closed',
        action: 'skip',
        reason: 'session closed or disabled',
      },
      { stage: 'no_thesis', session: 'rth', thesisKind: 'rth', action: 'skip' },
      {
        stage: 'lock_gate',
        action: 'skip',
        reason: 'another executor tick is running',
      },
      {
        stage: 'entry_blackout',
        session: 'rth',
        minutes: 570,
        action: 'skip_entries',
        count: 2,
      },
      { stage: 'skip', ticker: 'AMD', reason: 'position exists' },
    ]) {
      const event = presentAuditEvent({
        ts: '2026-07-12T14:00:00.000Z',
        kind: 'tick',
        data,
      });
      expect(event.status).toBe('skipped');
    }
  });

  it('describes production executor skip shapes without overstating execution', () => {
    const sessionGate = presentAuditEvent({
      ts: '2026-07-12T14:00:00.000Z',
      kind: 'tick',
      data: {
        stage: 'session_gate',
        session: 'closed',
        action: 'skip',
        reason: 'session closed or disabled',
      },
    });
    expect(sessionGate.description).toBe(
      'Execution check skipped. The market session is closed or disabled. No order was evaluated.',
    );

    const noPlan = presentAuditEvent({
      ts: '2026-07-12T14:00:00.000Z',
      kind: 'tick',
      data: { stage: 'no_thesis', session: 'rth', thesisKind: 'rth', action: 'skip' },
    });
    expect(noPlan.description).toBe(
      'Execution check skipped. No active trading plan was available. No order was evaluated.',
    );

    const locked = presentAuditEvent({
      ts: '2026-07-12T14:00:00.000Z',
      kind: 'tick',
      data: {
        stage: 'lock_gate',
        action: 'skip',
        reason: 'another executor tick is running',
      },
    });
    expect(locked.description).toBe(
      'Execution check skipped. Another execution check was already running. No order was evaluated.',
    );

    const entryBlackout = presentAuditEvent({
      ts: '2026-07-12T14:00:00.000Z',
      kind: 'tick',
      data: {
        stage: 'entry_blackout',
        session: 'rth',
        minutes: 570,
        action: 'skip_entries',
        count: 2,
      },
    });
    expect(entryBlackout.description).toBe(
      'New entries skipped. The configured entry window was closed. Existing positions remained eligible for evaluation.',
    );

    const tickerSkip = presentAuditEvent({
      ts: '2026-07-12T14:00:00.000Z',
      kind: 'tick',
      data: { stage: 'skip', ticker: 'AMD', reason: 'position exists' },
    });
    expect(tickerSkip.description).toBe(
      'Symbol check skipped for AMD. Position exists. No order was proposed for this check.',
    );
  });
});
