/**
 * ensure-stops — guarantee every long position has one resting GTC protective stop.
 *
 * Native OTO stop legs placed with the entry inherit time_in_force='day', so they
 * expire at the close and leave positions unprotected the next session. This script
 * replaces any day-TIF (or missing) stop with a good-till-canceled stop at the same
 * trigger, so protection persists across sessions until the position is closed.
 *
 * Idempotent: re-running when a correct GTC stop already rests is a no-op.
 *
 *   npx tsx scripts/ensure-stops.ts            # dry run — prints the plan
 *   npx tsx scripts/ensure-stops.ts --apply    # cancel day stops, place GTC stops
 *
 * Honors config.mode: paper -> paper-api + ALPACA_PAPER_*, live -> api + ALPACA_LIVE_*.
 */
import 'dotenv/config';
import { loadConfig } from '../src/config.js';

interface AlpacaOrder {
  id: string;
  symbol: string;
  side: string;
  qty: string;
  type?: string | null;
  stop_price?: string | null;
  time_in_force?: string | null;
  status: string;
}
interface AlpacaPosition {
  symbol: string;
  qty: string;
  avg_entry_price: string;
  side: string;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
const sleep = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));

void (async () => {
  const cfg = loadConfig();
  if (cfg.mode === 'dry-run') {
    console.log('mode=dry-run — no broker account to protect. Nothing to do.');
    return;
  }
  const live = cfg.mode === 'live';
  const key = live ? process.env.ALPACA_LIVE_KEY : process.env.ALPACA_PAPER_KEY;
  const secret = live ? process.env.ALPACA_LIVE_SECRET : process.env.ALPACA_PAPER_SECRET;
  const base = live ? 'https://api.alpaca.markets' : 'https://paper-api.alpaca.markets';
  if (!key || !secret) throw new Error(`missing Alpaca keys for mode ${cfg.mode}`);
  const H = { 'APCA-API-KEY-ID': key, 'APCA-API-SECRET-KEY': secret };
  const apply = process.argv.includes('--apply');
  const stopPct = cfg.max_position_loss_pct / 100;

  const jget = async <T>(p: string): Promise<T> => {
    const r = await fetch(base + p, { headers: H });
    if (!r.ok) throw new Error(`GET ${p} -> ${r.status} ${await r.text()}`);
    return r.json() as Promise<T>;
  };

  const positions = await jget<AlpacaPosition[]>('/v2/positions');
  const openOrders = await jget<AlpacaOrder[]>('/v2/orders?status=open&nested=true');
  const longs = positions.filter((p) => p.side !== 'short' && Number(p.qty) > 0);

  console.log(`mode=${cfg.mode}  base=${base}`);
  console.log(
    `long positions: ${longs.length}   open orders: ${openOrders.length}   hard stop: ${cfg.max_position_loss_pct}%`,
  );
  console.log(apply ? '\n=== APPLY ===' : '\n=== DRY RUN (pass --apply to execute) ===');

  let changed = 0;
  for (const p of longs) {
    const qty = Math.floor(Number(p.qty));
    const sellStops = openOrders.filter(
      (o) => o.symbol === p.symbol && o.side === 'sell' && (o.type ?? '').includes('stop'),
    );
    // Preserve an existing trigger if one is resting; otherwise derive from avg entry.
    const existingPrices = sellStops
      .map((o) => (o.stop_price == null ? NaN : Number(o.stop_price)))
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => b - a);
    const preserved = existingPrices[0];
    const desired = round2(
      preserved !== undefined ? preserved : Number(p.avg_entry_price) * (1 - stopPct),
    );

    const alreadyGtc = sellStops.find(
      (o) =>
        o.time_in_force === 'gtc' &&
        Number(o.stop_price) === desired &&
        Math.floor(Number(o.qty)) === qty,
    );
    if (alreadyGtc) {
      console.log(`${p.symbol.padEnd(5)} OK    GTC stop resting @ ${desired} (qty ${qty})`);
      continue;
    }

    changed++;
    const replacing = sellStops.map((o) => `${o.time_in_force}:${o.id.slice(0, 8)}`).join(', ');
    console.log(
      `${p.symbol.padEnd(5)} SET   GTC stop @ ${desired} (qty ${qty})` +
        (replacing ? `  replacing [${replacing}]` : '  (no existing stop)'),
    );
    if (!apply) continue;

    for (const o of sellStops) {
      const r = await fetch(`${base}/v2/orders/${o.id}`, { method: 'DELETE', headers: H });
      if (!r.ok && r.status !== 404 && r.status !== 422) {
        console.log(`        cancel ${o.id.slice(0, 8)} -> ${r.status} ${await r.text()}`);
      }
    }
    if (sellStops.length) await sleep(800); // let held qty release before re-placing

    let placed = false;
    for (let attempt = 0; attempt < 5 && !placed; attempt++) {
      const r = await fetch(`${base}/v2/orders`, {
        method: 'POST',
        headers: { ...H, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol: p.symbol,
          side: 'sell',
          type: 'stop',
          qty: String(qty),
          stop_price: String(desired),
          time_in_force: 'gtc',
        }),
      });
      if (r.ok) {
        const placedOrder = (await r.json()) as AlpacaOrder;
        console.log(`        placed GTC stop ${placedOrder.id.slice(0, 8)} @ ${desired}`);
        placed = true;
      } else {
        const body = await r.text();
        const heldRace = r.status === 403 && /insufficient|held/i.test(body);
        if (heldRace && attempt < 4) {
          await sleep(700);
          continue;
        }
        console.log(`        place FAILED -> ${r.status} ${body}`);
        break;
      }
    }
  }

  console.log(
    changed === 0
      ? '\nAll long positions already have resting GTC stops. No changes.'
      : `\n${apply ? 'Applied' : 'Would change'} ${changed} position(s).`,
  );
})();
