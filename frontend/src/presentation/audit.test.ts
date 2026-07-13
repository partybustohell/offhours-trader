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
});
