// In-memory simulated broker ledger for the backtest (full plan §4; 5h
// protocol episode semantics). Implements the production BrokerClient
// interface plus a marketdata facade ({getLatestQuotes, getNews}) shaped
// like AlpacaMarketData as runTick consumes it, so the REAL runTick /
// seedDeployedTodayUsd / riskCheck run unmodified against it.
//
// IO-free by construction: the driver owns all fetching and supplies market
// data per tick via setMarketData()/setNews(); sim time only moves through
// setNow(). Money-relevant behavior is deterministic:
//   - equity = cash + sum(position qty * mark), marks carry forward when a
//     tick brings no fresh data for a ticker; a fill marks at the fill price.
//   - getDailyPl() = marked equity - equity at the most recent 16:00 ET
//     close (the production last_equity analogue), re-baselined every time
//     sim time crosses 16:00 ET — this drives the kill switch per tick.
//   - getTodayOrders() = orders submitted since ET midnight of the current
//     sim day, computed with the production startOfTodayEtIso, so the real
//     seedDeployedTodayUsd inherits exact counting rules (clientOrderIds
//     carry the production 'entry-'/'exit-' prefixes). Documented
//     consequence: the deployment budget resets at ET midnight between a
//     thesis's after-hours and premarket sessions, as in production.
//   - advance() applies fills.ts tryFill to working orders using only bars
//     already complete at sim now (barOpen + 60s <= now — no lookahead) and
//     expires unfilled orders at 20:00 ET of their submission day.
//   - shorts are signed negative qty; ETB borrow accrues once per ET
//     midnight crossed at 0.3%/yr on the marked short value. Borrow
//     availability is NOT gated at placement (production placeLimitOrder
//     does not gate borrow); the driver calls checkShortable() before the
//     risk gate and records failures as rejection 'not shortable'.
//
// Aborting invariants (throw, never warn): order placed without a prior
// passed-riskCheck record (driver registers approvals via
// recordRiskApproval), entry placed while halted, non-integer qty, non-
// finite/non-positive limit, cash/position double-entry drift > 1 cent.
//
// Halt state is in-memory (production's out/state.json is the driver's
// concern) with the 5h plan's operator policies: 'auto-resume' clears the
// halt on the first read on a later ET calendar day (episodes tick only on
// trading days, so calendar-day compare = next-trading-day semantics);
// 'stay-halted' persists to the window end.
import type {
  AccountSnapshot,
  BrokerOrder,
  HaltState,
  Position,
  ProposedOrder,
  QuoteSnapshot,
} from '../types.js';
import type { BrokerClient } from '../broker/client.js';
import { startOfTodayEtIso } from '../broker/client.js';
import type { AlpacaMarketData, NewsItem } from '../broker/marketdata.js';
import type { StoredMinuteBar, StoredQuote } from './types.js';
import { etOffsetForDate } from './data.js';
import { borrowAccrual, etYmdOf, orderExpiryIso, sellFeesUsd, tryFill } from './fills.js';

const DAY_MS = 86_400_000;
const DRIFT_TOLERANCE_USD = 0.01;

export type HaltPolicy = 'auto-resume' | 'stay-halted';

export interface SimLedgerOptions {
  equityStart?: number; // default 50_000
  easyToBorrow: Set<string>;
  haltPolicy: HaltPolicy;
}

export interface SimOrder extends BrokerOrder {
  status: 'new' | 'filled' | 'expired' | 'canceled';
  intent: 'entry' | 'exit';
  expiresAt: string;
  filledAt?: string;
  feesUsd?: number;
}

export interface FillEvent {
  orderId: string;
  clientOrderId: string;
  ticker: string;
  side: 'buy' | 'sell';
  intent: 'entry' | 'exit';
  qty: number;
  price: number;
  atIso: string;
  feesUsd: number;
  /** Realized P&L on any closed portion, gross of fees (0 on pure opens). */
  realizedUsd: number;
}

export interface FlattenClose {
  ticker: string;
  side: 'buy' | 'sell';
  qty: number;
  price: number;
  grossRealizedUsd: number;
  feesUsd: number;
}

export interface FlattenResult {
  label: 'force-flatten';
  atIso: string;
  netRealizedUsd: number;
  closes: FlattenClose[];
}

interface SimPosition {
  qty: number; // signed: negative = short
  avgEntryPrice: number;
}

export class SimLedger implements BrokerClient {
  private readonly equityStart: number;
  private readonly etb: Set<string>;
  private readonly haltPolicy: HaltPolicy;

  private nowIso: string | null = null;
  private cash: number;
  private readonly positions = new Map<string, SimPosition>();
  private readonly marks = new Map<string, number>();
  private readonly orders: SimOrder[] = [];
  private readonly approvals: ProposedOrder[] = [];
  private readonly fillLog: FillEvent[] = [];
  private currentQuotes = new Map<string, StoredQuote>();
  private currentLasts = new Map<string, number>();
  private news: NewsItem[] = [];
  private halt: HaltState = { halted: false, reason: '', at: '' };
  private closeBaselineEquity: number;
  private realizedTotal = 0;
  private feesTotal = 0;
  private borrowTotal = 0;
  private seq = 0;

  constructor(opts: SimLedgerOptions) {
    this.equityStart = opts.equityStart ?? 50_000;
    this.etb = new Set([...opts.easyToBorrow].map((s) => s.toUpperCase()));
    this.haltPolicy = opts.haltPolicy;
    this.cash = this.equityStart;
    this.closeBaselineEquity = this.equityStart;
  }

  // ---------- sim clock ----------

  /**
   * Advance the sim clock. Crossing 16:00 ET re-baselines getDailyPl();
   * each ET midnight crossed accrues one day of borrow on open shorts;
   * working orders past 20:00 ET of their submission day expire. Boundary
   * events between the old and new instants are processed in time order.
   */
  setNow(iso: string): void {
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) throw new Error(`invalid sim time: ${iso}`);
    if (this.nowIso !== null) {
      const prevMs = Date.parse(this.nowIso);
      if (ms < prevMs) {
        throw new Error(`sim clock moved backwards: ${this.nowIso} -> ${iso}`);
      }
      this.processBoundaries(prevMs, ms);
    }
    this.nowIso = new Date(ms).toISOString();
    this.sweepExpired();
  }

  nowOrThrow(): string {
    if (this.nowIso === null) throw new Error('SimLedger: setNow() must be called before use');
    return this.nowIso;
  }

  private processBoundaries(prevMs: number, nextMs: number): void {
    if (nextMs <= prevMs) return;
    const events: { ms: number; kind: 'midnight' | 'close' }[] = [];
    // Iterate ET calendar days spanned, on a UTC-noon anchor (DST-safe).
    let cursor = Date.parse(`${etYmdOf(new Date(prevMs).toISOString())}T12:00:00Z`);
    const end = Date.parse(`${etYmdOf(new Date(nextMs).toISOString())}T12:00:00Z`);
    for (; cursor <= end; cursor += DAY_MS) {
      const ymd = new Date(cursor).toISOString().slice(0, 10);
      // production helper resolves the ET-midnight instant, DST-safe
      const midnightMs = Date.parse(startOfTodayEtIso(new Date(`${ymd}T17:00:00Z`)));
      const closeMs = Date.parse(`${ymd}T16:00:00${etOffsetForDate(ymd)}`);
      if (midnightMs > prevMs && midnightMs <= nextMs) events.push({ ms: midnightMs, kind: 'midnight' });
      if (closeMs > prevMs && closeMs <= nextMs) events.push({ ms: closeMs, kind: 'close' });
    }
    events.sort((a, b) => a.ms - b.ms);
    for (const event of events) {
      if (event.kind === 'midnight') this.accrueDailyBorrow();
      else this.closeBaselineEquity = this.equityUsd();
    }
  }

  private accrueDailyBorrow(): void {
    for (const [ticker, pos] of this.positions) {
      if (pos.qty >= 0) continue;
      const mark = this.marks.get(ticker) ?? pos.avgEntryPrice;
      const cost = borrowAccrual(Math.abs(pos.qty * mark), 1);
      this.cash -= cost;
      this.borrowTotal += cost;
    }
    this.assertConsistent();
  }

  private sweepExpired(): void {
    if (this.nowIso === null) return;
    const nowMs = Date.parse(this.nowIso);
    for (const order of this.orders) {
      if (order.status === 'new' && Date.parse(order.expiresAt) <= nowMs) {
        order.status = 'expired';
      }
    }
  }

  // ---------- market data supplied by the driver ----------

  /**
   * Install this tick's quote/last-trade snapshot (latest historical IEX
   * quote/trade with timestamp <= tick, per plan §4). Replaces the previous
   * tick's snapshot entirely: a ticker with no quote in this tick's window
   * is simply absent, and production's dead-book gates skip it. Marks
   * update to the last trade when present, else the quote mid; otherwise
   * the prior mark carries forward.
   */
  setMarketData(
    tickIso: string,
    quotesByTicker: ReadonlyMap<string, StoredQuote>,
    lastByTicker: ReadonlyMap<string, number>,
  ): void {
    void tickIso; // documentation of intent; quotes carry their own asOf
    this.currentQuotes = new Map();
    this.currentLasts = new Map();
    for (const [ticker, quote] of quotesByTicker) {
      this.currentQuotes.set(ticker.toUpperCase(), quote);
    }
    for (const [ticker, price] of lastByTicker) {
      if (Number.isFinite(price) && price > 0) this.currentLasts.set(ticker.toUpperCase(), price);
    }
    const tickers = new Set([...this.currentQuotes.keys(), ...this.currentLasts.keys()]);
    for (const ticker of tickers) {
      const last = this.currentLasts.get(ticker);
      if (last !== undefined) {
        this.marks.set(ticker, last);
        continue;
      }
      const quote = this.currentQuotes.get(ticker);
      if (quote && quote.bp > 0 && quote.ap > 0) this.marks.set(ticker, (quote.bp + quote.ap) / 2);
    }
  }

  setNews(items: NewsItem[]): void {
    this.news = [...items];
  }

  /** AlpacaMarketData-shaped facade for injection into runTick. */
  asMarketData(): AlpacaMarketData {
    return this as unknown as AlpacaMarketData;
  }

  async getLatestQuotes(tickers: string[]): Promise<QuoteSnapshot[]> {
    const out: QuoteSnapshot[] = [];
    for (const raw of tickers) {
      const ticker = raw.toUpperCase();
      const quote = this.currentQuotes.get(ticker);
      if (!quote) continue; // production omits symbols without a quote
      out.push({
        ticker,
        bid: quote.bp,
        ask: quote.ap,
        bidSize: quote.bs,
        askSize: quote.as,
        // missing trade -> last 0, which fails the executor band check
        last: this.currentLasts.get(ticker) ?? 0,
        asOf: quote.t,
      });
    }
    return out;
  }

  async getNews(limit = 50, symbols?: string[]): Promise<NewsItem[]> {
    const wanted = symbols?.map((s) => s.toUpperCase());
    const filtered =
      wanted && wanted.length > 0
        ? this.news.filter((n) => n.symbols.some((s) => wanted.includes(s.toUpperCase())))
        : [...this.news];
    return filtered
      .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0))
      .slice(0, limit);
  }

  // ---------- BrokerClient ----------

  async getAccount(): Promise<AccountSnapshot> {
    const positions: Position[] = [...this.positions.entries()].map(([ticker, pos]) => {
      const mark = this.marks.get(ticker) ?? pos.avgEntryPrice;
      return {
        ticker,
        qty: pos.qty,
        avgEntryPrice: pos.avgEntryPrice,
        marketValue: pos.qty * mark,
        unrealizedPl: (mark - pos.avgEntryPrice) * pos.qty,
        side: pos.qty < 0 ? 'short' : 'long',
      };
    });
    return { equity: this.equityUsd(), cash: this.cash, positions };
  }

  /** Marked equity minus equity at the most recent 16:00 ET close. */
  async getDailyPl(): Promise<number> {
    return this.equityUsd() - this.closeBaselineEquity;
  }

  async getOpenOrders(): Promise<BrokerOrder[]> {
    this.sweepExpired();
    return this.orders.filter((o) => o.status === 'new').map((o) => this.toBrokerOrder(o));
  }

  /** Orders submitted since ET midnight of the current sim day. */
  async getTodayOrders(): Promise<BrokerOrder[]> {
    this.sweepExpired();
    const boundaryMs = Date.parse(startOfTodayEtIso(new Date(this.nowOrThrow())));
    return this.orders
      .filter((o) => Date.parse(o.submittedAt) >= boundaryMs)
      .map((o) => this.toBrokerOrder(o));
  }

  async placeLimitOrder(o: ProposedOrder): Promise<BrokerOrder> {
    const now = this.nowOrThrow();
    if (!Number.isInteger(o.qty) || o.qty < 1) {
      throw new Error(`invariant violation: non-integer or sub-1 qty ${o.qty} for ${o.ticker}`);
    }
    if (!Number.isFinite(o.limitPrice) || o.limitPrice <= 0) {
      throw new Error(
        `invariant violation: non-finite or non-positive limit ${o.limitPrice} for ${o.ticker}`,
      );
    }
    if (o.intent === 'entry' && this.readHalt().halted) {
      throw new Error(`invariant violation: entry order for ${o.ticker} placed while halted`);
    }
    const approvalIdx = this.approvals.findIndex(
      (a) =>
        a.ticker.toUpperCase() === o.ticker.toUpperCase() &&
        a.side === o.side &&
        a.qty === o.qty &&
        a.limitPrice === o.limitPrice &&
        a.intent === o.intent,
    );
    if (approvalIdx < 0) {
      throw new Error(
        `invariant violation: order without a prior passed riskCheck: ${o.intent} ${o.side} ${o.qty} ${o.ticker} @ ${o.limitPrice}`,
      );
    }
    this.approvals.splice(approvalIdx, 1);
    this.seq++;
    const order: SimOrder = {
      id: `sim-${this.seq}`,
      ticker: o.ticker.toUpperCase(),
      side: o.side,
      qty: o.qty,
      limitPrice: o.limitPrice,
      status: 'new',
      submittedAt: now,
      clientOrderId: `${o.intent}-sim-${this.seq}`,
      filledQty: 0,
      intent: o.intent,
      expiresAt: orderExpiryIso(now),
    };
    this.orders.push(order);
    return this.toBrokerOrder(order);
  }

  // ---------- driver hooks ----------

  /**
   * The driver records each order that passed the REAL riskCheck before the
   * ledger will accept its placement; placing (and therefore filling) any
   * order without a matching record is an aborting invariant violation.
   */
  recordRiskApproval(o: ProposedOrder): void {
    this.approvals.push({ ...o });
  }

  /**
   * Borrow-availability probe. The driver calls this before riskCheck for
   * short entries and records failures as rejection reason 'not shortable';
   * placeLimitOrder itself does not gate borrow (production parity).
   */
  checkShortable(ticker: string): boolean {
    return this.etb.has(ticker.toUpperCase());
  }

  /**
   * Apply fills to working orders as of sim now, considering only bars that
   * are complete (barOpen + 60s <= now): a 15-minute tick can never see a
   * fill from a bar still in the future or in progress. Returns the fills
   * applied, in order-placement order.
   */
  advance(barsByTicker: ReadonlyMap<string, StoredMinuteBar[]>): FillEvent[] {
    const nowMs = Date.parse(this.nowOrThrow());
    const events: FillEvent[] = [];
    for (const order of this.orders) {
      if (order.status !== 'new') continue;
      const bars = barsByTicker.get(order.ticker) ?? [];
      const completed = bars.filter((b) => Date.parse(b.t) + 60_000 <= nowMs);
      const outcome = tryFill(
        { side: order.side, qty: order.qty, limitPrice: order.limitPrice },
        completed,
        order.submittedAt,
      );
      if (!outcome) continue;
      events.push(this.applyFill(order, outcome.atIso, outcome.feesUsd));
    }
    this.sweepExpired();
    return events;
  }

  /**
   * Close every open position at the supplied marks (episode boundary,
   * labeled 'force-flatten'), cancel any still-working orders, and return
   * realized P&L. Sell-side closes pay trade-date-keyed fees; buy-side
   * covers do not. Throws if a held ticker has no usable mark.
   */
  forceFlattenAt(
    iso: string,
    marks: ReadonlyMap<string, number> | Record<string, number>,
  ): FlattenResult {
    this.setNow(iso);
    const markOf = (ticker: string): number | undefined => {
      if (marks instanceof Map) return marks.get(ticker) ?? marks.get(ticker.toUpperCase());
      const rec = marks as Record<string, number>;
      return rec[ticker] ?? rec[ticker.toUpperCase()];
    };
    const closes: FlattenClose[] = [];
    for (const [ticker, pos] of [...this.positions.entries()]) {
      const price = markOf(ticker);
      if (price === undefined || !Number.isFinite(price) || price <= 0) {
        throw new Error(`force-flatten: no usable mark for held position ${ticker}`);
      }
      const side: 'buy' | 'sell' = pos.qty > 0 ? 'sell' : 'buy';
      const shares = Math.abs(pos.qty);
      const feesUsd = side === 'sell' ? sellFeesUsd(shares, price, etYmdOf(iso)) : 0;
      const grossRealizedUsd = (price - pos.avgEntryPrice) * pos.qty;
      this.cash += pos.qty * price - feesUsd;
      this.realizedTotal += grossRealizedUsd;
      this.feesTotal += feesUsd;
      this.marks.set(ticker, price);
      this.positions.delete(ticker);
      closes.push({ ticker, side, qty: shares, price, grossRealizedUsd, feesUsd });
    }
    for (const order of this.orders) {
      if (order.status === 'new') order.status = 'canceled';
    }
    this.assertConsistent();
    const netRealizedUsd = closes.reduce((s, c) => s + c.grossRealizedUsd - c.feesUsd, 0);
    return { label: 'force-flatten', atIso: this.nowOrThrow(), netRealizedUsd, closes };
  }

  // ---------- halt state (in-memory, policy-aware) ----------

  writeHalt(reason: string, atIso?: string): HaltState {
    this.halt = { halted: true, reason, at: atIso ?? this.nowOrThrow() };
    return { ...this.halt };
  }

  clearHalt(): HaltState {
    this.halt = { halted: false, reason: '', at: this.nowIso ?? '' };
    return { ...this.halt };
  }

  readHalt(): HaltState {
    if (
      this.halt.halted &&
      this.haltPolicy === 'auto-resume' &&
      this.nowIso !== null &&
      etYmdOf(this.nowIso) > etYmdOf(this.halt.at)
    ) {
      this.halt = { halted: false, reason: '', at: this.nowIso };
    }
    return { ...this.halt };
  }

  // ---------- inspection ----------

  equityUsd(): number {
    let markValue = 0;
    for (const [ticker, pos] of this.positions) {
      markValue += pos.qty * (this.marks.get(ticker) ?? pos.avgEntryPrice);
    }
    return this.cash + markValue;
  }

  cashUsd(): number {
    return this.cash;
  }

  fills(): readonly FillEvent[] {
    return this.fillLog;
  }

  allOrders(): BrokerOrder[] {
    return this.orders.map((o) => this.toBrokerOrder(o));
  }

  totals(): { feesUsd: number; borrowUsd: number; realizedGrossUsd: number } {
    return {
      feesUsd: this.feesTotal,
      borrowUsd: this.borrowTotal,
      realizedGrossUsd: this.realizedTotal,
    };
  }

  /**
   * Double-entry reconciliation, checked after every money movement:
   *   cash + open cost basis == equityStart + realized - fees - borrow
   * Drift beyond one cent aborts the run — a wrong ledger must never
   * produce a plausible-looking report.
   */
  assertConsistent(): void {
    const basis = [...this.positions.values()].reduce((s, p) => s + p.qty * p.avgEntryPrice, 0);
    const expected = this.equityStart + this.realizedTotal - this.feesTotal - this.borrowTotal;
    const drift = Math.abs(this.cash + basis - expected);
    if (drift > DRIFT_TOLERANCE_USD + 1e-9) {
      throw new Error(
        `invariant violation: cash/position accounting drift $${drift.toFixed(6)}`,
      );
    }
  }

  // ---------- internals ----------

  private applyFill(order: SimOrder, atIso: string, feesUsd: number): FillEvent {
    const ticker = order.ticker;
    const price = order.limitPrice;
    const pos = this.positions.get(ticker) ?? { qty: 0, avgEntryPrice: 0 };
    const delta = order.side === 'buy' ? order.qty : -order.qty;
    let realizedUsd = 0;

    if (pos.qty === 0 || Math.sign(pos.qty) === Math.sign(delta)) {
      const newQty = pos.qty + delta;
      const newAvg =
        (Math.abs(pos.qty) * pos.avgEntryPrice + Math.abs(delta) * price) / Math.abs(newQty);
      this.positions.set(ticker, { qty: newQty, avgEntryPrice: newAvg });
    } else {
      const closedShares = Math.min(Math.abs(pos.qty), Math.abs(delta));
      realizedUsd = (price - pos.avgEntryPrice) * closedShares * Math.sign(pos.qty);
      const newQty = pos.qty + delta;
      if (newQty === 0) this.positions.delete(ticker);
      else if (Math.sign(newQty) === Math.sign(pos.qty)) {
        this.positions.set(ticker, { qty: newQty, avgEntryPrice: pos.avgEntryPrice });
      } else {
        // flip through zero: remainder opens a fresh position at the fill price
        this.positions.set(ticker, { qty: newQty, avgEntryPrice: price });
      }
    }

    this.cash += (order.side === 'buy' ? -1 : 1) * order.qty * price - feesUsd;
    this.realizedTotal += realizedUsd;
    this.feesTotal += feesUsd;
    this.marks.set(ticker, price); // the fill is the freshest trade we know of

    order.status = 'filled';
    order.filledQty = order.qty;
    order.filledAt = atIso;
    order.feesUsd = feesUsd;
    this.assertConsistent();

    const event: FillEvent = {
      orderId: order.id,
      clientOrderId: order.clientOrderId ?? '',
      ticker,
      side: order.side,
      intent: order.intent,
      qty: order.qty,
      price,
      atIso,
      feesUsd,
      realizedUsd,
    };
    this.fillLog.push(event);
    return event;
  }

  private toBrokerOrder(o: SimOrder): BrokerOrder {
    return {
      id: o.id,
      ticker: o.ticker,
      side: o.side,
      qty: o.qty,
      limitPrice: o.limitPrice,
      status: o.status,
      submittedAt: o.submittedAt,
      clientOrderId: o.clientOrderId,
      filledQty: o.filledQty,
    };
  }
}
