import type { Config } from './config.js';
import type {
  AccountSnapshot,
  BrokerOrder,
  ProposedOrder,
  RiskDecision,
} from './types.js';

export interface RiskContext {
  config: Config;
  account: AccountSnapshot;
  openOrders: BrokerOrder[];
  deployedTodayUsd: number;
  dailyPl: number;
  halted: boolean;
}

/**
 * Deterministic risk gate. Collects ALL failing reasons (no short-circuit).
 * Halt and daily-loss kill switch block entries only: exit orders reduce
 * risk and are always allowed through those rules. Notional/position/deploy
 * caps (rules 6-8) also apply to entries only.
 */
export function riskCheck(order: ProposedOrder, ctx: RiskContext): RiskDecision {
  const cfg = ctx.config;
  const account = ctx.account;
  const reasons: string[] = [];
  const isEntry = order.intent === 'entry';
  const ticker = order.ticker.toUpperCase();
  const notional = order.qty * order.limitPrice;

  if (isEntry && ctx.halted) {
    reasons.push('trading halted');
  }

  // Boundary equality trips: losing exactly the threshold halts entries.
  if (isEntry && ctx.dailyPl <= -((account.equity * cfg.daily_loss_halt_pct) / 100)) {
    reasons.push('daily loss halt');
  }

  if (!Number.isFinite(order.limitPrice) || order.limitPrice <= 0) {
    reasons.push('invalid limit price');
  }

  if (!Number.isInteger(order.qty) || order.qty < 1) {
    reasons.push('invalid qty');
  }

  // Entry-only: the exclude list must never block closing a position.
  if (isEntry && cfg.universe.exclude.some((t) => t.toUpperCase() === ticker)) {
    reasons.push('excluded ticker');
  }

  if (isEntry && notional > cfg.max_order_notional_usd) {
    reasons.push('exceeds max order notional');
  }

  if (isEntry) {
    const existing = account.positions.find((p) => p.ticker.toUpperCase() === ticker);
    const existingExposure = existing ? Math.abs(existing.marketValue) : 0;
    if (existingExposure + notional > (account.equity * cfg.max_position_pct) / 100) {
      reasons.push('exceeds max position size');
    }
    if (ctx.deployedTodayUsd + notional > (account.equity * cfg.max_daily_deploy_pct) / 100) {
      reasons.push('exceeds max daily deployment');
    }
  }

  // Cross-day exposure backstop (entries only): total book that can accumulate
  // across sessions, above the per-day deploy cap. Counts filled positions,
  // resting ENTRY orders (by client_order_id tag, so exits/covers don't add
  // exposure), and this order. Gross uses absolute value; net is signed
  // (long +, short -). Exits reduce risk and are always exempt.
  if (isEntry) {
    const signedNotional = order.side === 'buy' ? notional : -notional;
    const restingEntries = ctx.openOrders.filter((o) => o.clientOrderId?.startsWith('entry-'));
    // Count only the UNFILLED remainder: the filled portion of a partially-
    // filled resting entry already appears in the position marketValue below,
    // so the full order qty would double-count it and could prematurely block
    // a legitimate new entry. (Mirrors seedDeployedTodayUsd's filledQty logic.)
    const restingUnfilledUsd = (o: BrokerOrder): number =>
      (o.qty - (o.filledQty ?? 0)) * o.limitPrice;
    const restingEntryGross = restingEntries.reduce((sum, o) => sum + restingUnfilledUsd(o), 0);
    const restingEntryNet = restingEntries.reduce(
      (sum, o) => sum + (o.side === 'buy' ? 1 : -1) * restingUnfilledUsd(o),
      0,
    );
    const grossPositions = account.positions.reduce((sum, p) => sum + Math.abs(p.marketValue), 0);
    const netPositions = account.positions.reduce((sum, p) => sum + p.marketValue, 0);
    const gross = grossPositions + restingEntryGross + notional;
    const net = netPositions + restingEntryNet + signedNotional;
    if (gross > (account.equity * cfg.max_gross_exposure_pct) / 100) {
      reasons.push('exceeds max gross exposure');
    }
    if (Math.abs(net) > (account.equity * cfg.max_net_exposure_pct) / 100) {
      reasons.push('exceeds max net exposure');
    }
  }

  if (ctx.openOrders.some((o) => o.ticker.toUpperCase() === ticker && o.side === order.side)) {
    reasons.push('duplicate open order');
  }

  return { allowed: reasons.length === 0, reasons };
}
