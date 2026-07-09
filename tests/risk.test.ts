import { describe, expect, it } from 'vitest';
import { ConfigSchema } from '../src/config.js';
import { riskCheck, type RiskContext } from '../src/risk.js';
import type { BrokerOrder, Position, ProposedOrder } from '../src/types.js';

// Defaults from ConfigSchema.parse({}):
//   max_order_notional_usd 2000, max_position_pct 5, max_daily_deploy_pct 10,
//   daily_loss_halt_pct 3. With equity 100000: position cap 5000,
//   daily deploy cap 10000, kill-switch threshold -3000.
function makeCtx(overrides: Partial<RiskContext> = {}): RiskContext {
  return {
    config: ConfigSchema.parse({}),
    account: { equity: 100_000, cash: 100_000, positions: [] },
    openOrders: [],
    deployedTodayUsd: 0,
    dailyPl: 0,
    halted: false,
    ...overrides,
  };
}

function makeOrder(overrides: Partial<ProposedOrder> = {}): ProposedOrder {
  return {
    ticker: 'AAPL',
    side: 'buy',
    qty: 10,
    limitPrice: 100,
    intent: 'entry',
    reason: 'test',
    extendedHours: true,
    ...overrides,
  };
}

function makePosition(overrides: Partial<Position> = {}): Position {
  return {
    ticker: 'AAPL',
    qty: 30,
    avgEntryPrice: 100,
    marketValue: 3000,
    unrealizedPl: 0,
    side: 'long',
    ...overrides,
  };
}

function makeOpenOrder(overrides: Partial<BrokerOrder> = {}): BrokerOrder {
  return {
    id: 'o1',
    ticker: 'AAPL',
    side: 'buy',
    qty: 5,
    limitPrice: 100,
    status: 'new',
    submittedAt: '2026-07-07T12:00:00Z',
    ...overrides,
  };
}

describe('riskCheck', () => {
  it('allows a plain valid entry', () => {
    const d = riskCheck(makeOrder(), makeCtx());
    expect(d).toEqual({ allowed: true, reasons: [] });
  });

  describe('rule 1: halt', () => {
    it('rejects entries while halted', () => {
      const d = riskCheck(makeOrder(), makeCtx({ halted: true }));
      expect(d.allowed).toBe(false);
      expect(d.reasons).toContain('trading halted');
    });

    it('allows exits while halted', () => {
      const d = riskCheck(
        makeOrder({ intent: 'exit', side: 'sell' }),
        makeCtx({ halted: true }),
      );
      expect(d).toEqual({ allowed: true, reasons: [] });
    });
  });

  describe('rule 2: daily-loss kill switch', () => {
    it('trips on exact boundary equality (dailyPl === -equity*pct/100)', () => {
      const d = riskCheck(makeOrder(), makeCtx({ dailyPl: -3000 }));
      expect(d.allowed).toBe(false);
      expect(d.reasons).toContain('daily loss halt');
    });

    it('allows entries one cent above the threshold', () => {
      const d = riskCheck(makeOrder(), makeCtx({ dailyPl: -2999.99 }));
      expect(d).toEqual({ allowed: true, reasons: [] });
    });

    it('allows exits while kill switch is tripped', () => {
      const d = riskCheck(
        makeOrder({ intent: 'exit', side: 'sell' }),
        makeCtx({ dailyPl: -5000 }),
      );
      expect(d).toEqual({ allowed: true, reasons: [] });
    });
  });

  describe('rule 3: limit price validity', () => {
    for (const limitPrice of [0, -1, NaN, Infinity]) {
      it(`rejects limit price ${limitPrice}`, () => {
        const d = riskCheck(makeOrder({ limitPrice }), makeCtx());
        expect(d.allowed).toBe(false);
        expect(d.reasons).toContain('invalid limit price');
      });
    }
  });

  describe('rule 4: qty validity', () => {
    for (const qty of [0, -3, 2.5]) {
      it(`rejects qty ${qty}`, () => {
        const d = riskCheck(makeOrder({ qty }), makeCtx());
        expect(d.allowed).toBe(false);
        expect(d.reasons).toContain('invalid qty');
      });
    }
  });

  describe('rule 5: exclude list', () => {
    it('rejects excluded ticker, lowercase config vs uppercase order', () => {
      const ctx = makeCtx({ config: ConfigSchema.parse({ universe: { exclude: ['tsla'] } }) });
      const d = riskCheck(makeOrder({ ticker: 'TSLA' }), ctx);
      expect(d.allowed).toBe(false);
      expect(d.reasons).toContain('excluded ticker');
    });

    it('rejects excluded ticker, uppercase config vs lowercase order', () => {
      const ctx = makeCtx({ config: ConfigSchema.parse({ universe: { exclude: ['NVDA'] } }) });
      const d = riskCheck(makeOrder({ ticker: 'nvda' }), ctx);
      expect(d.allowed).toBe(false);
      expect(d.reasons).toContain('excluded ticker');
    });

    it('does not apply to exits: closing an excluded-ticker position is allowed', () => {
      const ctx = makeCtx({ config: ConfigSchema.parse({ universe: { exclude: ['NVDA'] } }) });
      const d = riskCheck(makeOrder({ ticker: 'NVDA', side: 'sell', intent: 'exit' }), ctx);
      expect(d).toEqual({ allowed: true, reasons: [] });
    });
  });

  describe('rule 6: max order notional (entries only)', () => {
    it('allows notional exactly at max_order_notional_usd', () => {
      const d = riskCheck(makeOrder({ qty: 100, limitPrice: 20 }), makeCtx()); // 2000
      expect(d).toEqual({ allowed: true, reasons: [] });
    });

    it('rejects notional one cent over', () => {
      const d = riskCheck(makeOrder({ qty: 1, limitPrice: 2000.01 }), makeCtx());
      expect(d.allowed).toBe(false);
      expect(d.reasons).toContain('exceeds max order notional');
    });

    it('does not apply to exits', () => {
      const d = riskCheck(
        makeOrder({ intent: 'exit', side: 'sell', qty: 50, limitPrice: 100 }), // 5000
        makeCtx(),
      );
      expect(d).toEqual({ allowed: true, reasons: [] });
    });
  });

  describe('rule 7: max position size (entries only)', () => {
    it('allows existing |marketValue| + notional exactly at equity*max_position_pct/100', () => {
      const ctx = makeCtx({
        account: { equity: 100_000, cash: 50_000, positions: [makePosition({ marketValue: 3000 })] },
      });
      const d = riskCheck(makeOrder({ qty: 100, limitPrice: 20 }), ctx); // 3000 + 2000 = 5000 cap
      expect(d).toEqual({ allowed: true, reasons: [] });
    });

    it('rejects one cent over the position cap', () => {
      const ctx = makeCtx({
        account: {
          equity: 100_000,
          cash: 50_000,
          positions: [makePosition({ marketValue: 3000.01 })],
        },
      });
      const d = riskCheck(makeOrder({ qty: 100, limitPrice: 20 }), ctx);
      expect(d.allowed).toBe(false);
      expect(d.reasons).toContain('exceeds max position size');
    });

    it('uses absolute market value for short positions', () => {
      const ctx = makeCtx({
        account: {
          equity: 100_000,
          cash: 50_000,
          positions: [makePosition({ qty: -35, marketValue: -3500, side: 'short' })],
        },
      });
      const d = riskCheck(makeOrder({ qty: 100, limitPrice: 20 }), ctx); // 3500 + 2000 > 5000
      expect(d.allowed).toBe(false);
      expect(d.reasons).toContain('exceeds max position size');
    });

    it('does not apply to exits', () => {
      const ctx = makeCtx({
        account: {
          equity: 100_000,
          cash: 50_000,
          positions: [makePosition({ marketValue: 6000, qty: 60 })],
        },
      });
      const d = riskCheck(
        makeOrder({ intent: 'exit', side: 'sell', qty: 60, limitPrice: 100 }),
        ctx,
      );
      expect(d).toEqual({ allowed: true, reasons: [] });
    });
  });

  describe('rule 8: max daily deployment (entries only)', () => {
    it('allows deployedTodayUsd + notional exactly at equity*max_daily_deploy_pct/100', () => {
      const ctx = makeCtx({ deployedTodayUsd: 8000 });
      const d = riskCheck(makeOrder({ qty: 100, limitPrice: 20 }), ctx); // 8000 + 2000 = 10000 cap
      expect(d).toEqual({ allowed: true, reasons: [] });
    });

    it('rejects one cent over the daily deploy cap', () => {
      const ctx = makeCtx({ deployedTodayUsd: 8000.01 });
      const d = riskCheck(makeOrder({ qty: 100, limitPrice: 20 }), ctx);
      expect(d.allowed).toBe(false);
      expect(d.reasons).toContain('exceeds max daily deployment');
    });

    it('does not apply to exits', () => {
      const ctx = makeCtx({ deployedTodayUsd: 9999 });
      const d = riskCheck(makeOrder({ intent: 'exit', side: 'sell' }), ctx);
      expect(d).toEqual({ allowed: true, reasons: [] });
    });
  });

  describe('rule 9: duplicate open order', () => {
    it('rejects when an open order exists for the same ticker+side', () => {
      const ctx = makeCtx({ openOrders: [makeOpenOrder({ ticker: 'AAPL', side: 'buy' })] });
      const d = riskCheck(makeOrder({ ticker: 'AAPL', side: 'buy' }), ctx);
      expect(d.allowed).toBe(false);
      expect(d.reasons).toContain('duplicate open order');
    });

    it('passes same ticker, other side', () => {
      const ctx = makeCtx({ openOrders: [makeOpenOrder({ ticker: 'AAPL', side: 'buy' })] });
      const d = riskCheck(
        makeOrder({ ticker: 'AAPL', side: 'sell', intent: 'exit' }),
        ctx,
      );
      expect(d).toEqual({ allowed: true, reasons: [] });
    });

    it('passes same side, other ticker', () => {
      const ctx = makeCtx({ openOrders: [makeOpenOrder({ ticker: 'MSFT', side: 'buy' })] });
      const d = riskCheck(makeOrder({ ticker: 'AAPL', side: 'buy' }), ctx);
      expect(d).toEqual({ allowed: true, reasons: [] });
    });
  });

  describe('rule 10/11: cross-day gross and net exposure caps (entries only)', () => {
    // Defaults at equity 100k: gross cap 15% = 15000, net cap 12% = 12000.
    it('rejects an entry that pushes gross book over the cap', () => {
      const ctx = makeCtx({
        account: { equity: 100_000, cash: 0, positions: [makePosition({ ticker: 'MSFT', marketValue: 14_000, qty: 140 })] },
      });
      const d = riskCheck(makeOrder({ ticker: 'AAPL', qty: 100, limitPrice: 20 }), ctx); // +2000 -> 16000
      expect(d.allowed).toBe(false);
      expect(d.reasons).toContain('exceeds max gross exposure');
    });

    it('rejects an entry that pushes signed net over the cap', () => {
      const ctx = makeCtx({
        account: { equity: 100_000, cash: 0, positions: [makePosition({ ticker: 'MSFT', marketValue: 11_000, qty: 110 })] },
      });
      const d = riskCheck(makeOrder({ ticker: 'AAPL', side: 'buy', qty: 100, limitPrice: 20 }), ctx); // net 13000 > 12000
      expect(d.allowed).toBe(false);
      expect(d.reasons).toContain('exceeds max net exposure');
      expect(d.reasons).not.toContain('exceeds max gross exposure'); // 13000 < 15000 gross
    });

    it('nets a hedged book down: a long + a short offsets net but not gross', () => {
      const ctx = makeCtx({
        account: {
          equity: 100_000,
          cash: 0,
          positions: [
            makePosition({ ticker: 'MSFT', marketValue: 7000, qty: 70, side: 'long' }),
            makePosition({ ticker: 'GOOG', marketValue: -7000, qty: -70, side: 'short' }),
          ],
        },
      });
      // gross 14000 + 2000 = 16000 > 15000 -> gross breach; net 0 + 2000 fine.
      const d = riskCheck(makeOrder({ ticker: 'AAPL', qty: 100, limitPrice: 20 }), ctx);
      expect(d.reasons).toContain('exceeds max gross exposure');
      expect(d.reasons).not.toContain('exceeds max net exposure');
    });

    it('counts resting ENTRY orders toward gross but ignores resting exits', () => {
      const base = { equity: 100_000, cash: 0, positions: [makePosition({ ticker: 'MSFT', marketValue: 12_000, qty: 120 })] };
      // resting entry order (tagged) for a third ticker: 12000 + 1500 + 2000 = 15500 > 15000.
      const withEntry = makeCtx({
        account: base,
        openOrders: [makeOpenOrder({ ticker: 'XYZ', side: 'buy', qty: 75, limitPrice: 20, clientOrderId: 'entry-xyz' })],
      });
      expect(riskCheck(makeOrder({ ticker: 'AAPL', qty: 100, limitPrice: 20 }), withEntry).reasons).toContain(
        'exceeds max gross exposure',
      );
      // an EXIT-tagged resting order does not add exposure: 12000 + 0 + 2000 = 14000 < 15000.
      const withExit = makeCtx({
        account: base,
        openOrders: [makeOpenOrder({ ticker: 'XYZ', side: 'sell', qty: 250, limitPrice: 20, clientOrderId: 'exit-xyz' })],
      });
      expect(riskCheck(makeOrder({ ticker: 'AAPL', qty: 100, limitPrice: 20 }), withExit).reasons).not.toContain(
        'exceeds max gross exposure',
      );
    });

    it('never blocks exits, even with the book far over the caps', () => {
      const ctx = makeCtx({
        account: { equity: 100_000, cash: 0, positions: [makePosition({ ticker: 'MSFT', marketValue: 30_000, qty: 300 })] },
      });
      const d = riskCheck(
        makeOrder({ ticker: 'MSFT', side: 'sell', intent: 'exit', qty: 300, limitPrice: 100 }),
        ctx,
      );
      expect(d).toEqual({ allowed: true, reasons: [] });
    });
  });

  describe('reason accumulation', () => {
    it('collects all simultaneous violations without short-circuiting', () => {
      const ctx = makeCtx({
        config: ConfigSchema.parse({ universe: { exclude: ['AAPL'] } }),
        halted: true,
        dailyPl: -3000,
        openOrders: [makeOpenOrder({ ticker: 'AAPL', side: 'buy' })],
      });
      const d = riskCheck(makeOrder({ qty: 0, limitPrice: NaN }), ctx);
      expect(d.allowed).toBe(false);
      expect(d.reasons).toEqual(
        expect.arrayContaining([
          'trading halted',
          'daily loss halt',
          'invalid limit price',
          'invalid qty',
          'excluded ticker',
          'duplicate open order',
        ]),
      );
      expect(d.reasons).toHaveLength(6);
    });

    it('accumulates all three entry-cap violations at once', () => {
      const ctx = makeCtx({
        account: {
          equity: 100_000,
          cash: 50_000,
          positions: [makePosition({ marketValue: 4000, qty: 40 })],
        },
        deployedTodayUsd: 9500,
      });
      const d = riskCheck(makeOrder({ qty: 3, limitPrice: 1000 }), ctx); // notional 3000
      expect(d.allowed).toBe(false);
      expect(d.reasons).toEqual(
        expect.arrayContaining([
          'exceeds max order notional',
          'exceeds max position size',
          'exceeds max daily deployment',
        ]),
      );
      expect(d.reasons).toHaveLength(3);
    });
  });
});
