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

  if (cfg.universe.exclude.some((t) => t.toUpperCase() === ticker)) {
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

  if (ctx.openOrders.some((o) => o.ticker.toUpperCase() === ticker && o.side === order.side)) {
    reasons.push('duplicate open order');
  }

  return { allowed: reasons.length === 0, reasons };
}
