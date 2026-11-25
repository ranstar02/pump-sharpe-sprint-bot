// Local backtest simulator for the pump.fun replay bot.
//
// A dependency-free re-implementation of the replay market model: constant
// product bonding curves with protocol + creator fees, per-order tx fees,
// 2-slot latency, slippage checks, and seeded failed transactions. It feeds
// the bot exactly the hello/batch/done stream the real harness would (via
// BotState), then reports net PnL, hourly Sharpe, max drawdown, round trips,
// fills and reject reasons. The bot never imports this file.
//
// Usage:
//   node tools/sim.ts [kit-dir] [--params '{"takeProfit":0.15}'] [--out log.jsonl]
//   node tools/sim.ts --help
//
// Determinism: the failed-tx draw is a keyed splitmix64 over (seed, seq, index),
// so a run with the same params always produces the same action log.

import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { BotState, type Batch, type Bot, type Fill, type Hello, type Mark, type Order } from '../vendor/makefun-bot.ts';
import { createScalper, DEFAULT_PARAMS, type ScalperParams } from '../strategy.ts';

const BPS = 10_000n;
const MASK = (1n << 64n) - 1n;
const SPLITMIX_GAMMA = 0x9e3779b97f4a7c15n;
const FAIL_TAG = 0x6661696c65642d74n; // 'failed-t'
const FAIL_KEY_TAG = 0x6661696c2d6b6579n; // 'fail-key'

/** splitmix64 finalizer. */
function mix64(z0: bigint): bigint {
  let z = z0 & MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK;
  return z ^ (z >> 31n);
}

function keyedU64(seed: bigint, ...parts: bigint[]): bigint {
  let h = mix64((seed + SPLITMIX_GAMMA) & MASK);
  for (const part of parts) h = mix64((h ^ (part & MASK)) + SPLITMIX_GAMMA);
  return h;
}

const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;
const feeOf = (amount: bigint, bps: bigint): bigint => ceilDiv(amount * bps, BPS);

interface CurveReserves {
  vq: bigint;
  vt: bigint;
  rq: bigint;
  rt: bigint;
}

interface FeeSchedule {
  protocol: bigint;
  creator: bigint;
}

/** Tokens out when spending q quote (net of curve fees) on curve s. */
function tokensForQuote(q: bigint, s: CurveReserves): bigint {
  if (q <= 1n) return 0n;
  return ((q - 1n) * s.vt) / (s.vq + q - 1n);
}

/** Quote in needed to buy exactly t tokens on curve s. */
function quoteForTokens(t: bigint, s: CurveReserves): bigint {
  return (t * s.vq) / (s.vt - t) + 1n;
}

/** Quote out when selling t tokens on curve s. */
function quoteForSale(t: bigint, s: CurveReserves): bigint {
  return (t * s.vq) / (s.vt + t);
}

function buyExactIn(spend: bigint, s: CurveReserves, fees: FeeSchedule): { quoteIn: bigint; tokens: bigint; paid: bigint } {
  const net = (spend * BPS) / (BPS + fees.protocol + fees.creator);
  const protocolFee = feeOf(net, fees.protocol);
  const creatorFee = feeOf(net, fees.creator);
  const over = net + protocolFee + creatorFee > spend ? net + protocolFee + creatorFee - spend : 0n;
  const quoteIn = net - over;
  const tokens = tokensForQuote(quoteIn, s);
  if (tokens > s.rt) {
    const capped = s.rt;
    if (capped === 0n) return { quoteIn: 0n, tokens: 0n, paid: 0n };
    const q = quoteForTokens(capped, s);
    return { quoteIn: q, tokens: capped, paid: q + feeOf(q, fees.protocol) + feeOf(q, fees.creator) };
  }
  return { quoteIn, tokens, paid: quoteIn + protocolFee + creatorFee };
}

function sellExact(t: bigint, s: CurveReserves, fees: FeeSchedule): { quoteOut: bigint; proceeds: bigint } {
  const q = quoteForSale(t, s);
  return { quoteOut: q, proceeds: q - feeOf(q, fees.protocol) - feeOf(q, fees.creator) };
}

interface MintRuntime {
  state: CurveReserves;
  stateSlot: number;
  lastTrade: any | null;
  lastTradeSlot: number;
  complete: boolean;
  /** Offset from our own fills (bot trades move reserves). */
  offQuote: bigint;
  offTokens: bigint;
}

interface PendingOrder {
  order: Order;
  seq: number;
  index: number;
  decidedSlot: number;
  fillSlot: number;
  reject: string | null;
  decision: CurveReserves | null;
}

export interface SimMetrics {
  netPnlSol: number;
  sharpeHourly: number;
  maxDrawdown: number;
  fills: number;
  distinctMints: number;
  roundTripCoins: number;
  trips: number;
  winningTrips: number;
  rejected: number;
  failed: number;
  rejectReasons: Record<string, number>;
  hourlyReturns: number[];
}

interface LoadedDataset {
  events: any[];
  endSlot: number;
  batches: { slot: number; events: any[] }[];
}

export function loadDataset(kitDir: string): LoadedDataset {
  const kitJson = JSON.parse(readFileSync(`${kitDir}/kit.json`, 'utf8'));
  const manifest = JSON.parse(readFileSync(`${kitDir}/dataset/manifest.json`, 'utf8'));
  const { modulus, residue } = manifest.universe.sample as { modulus: number; residue: number };
  const excluded = new Set<string>(manifest.excluded_mints ?? []);
  const parts = ['part-00000', 'part-00001', 'part-00002'];
  const members = new Set<string>();
  const events: any[] = [];
  for (const part of parts) {
    const raw = gunzipSync(readFileSync(`${kitDir}/dataset/events/${part}.ndjson.gz`)).toString('utf8');
    for (const line of raw.split('\n')) {
      if (line.length === 0) continue;
      const e = JSON.parse(line);
      if (e.event === 'CreateEvent' && !members.has(e.mint)) {
        const h = BigInt('0x' + createHash('sha256').update(e.mint, 'utf8').digest('hex'));
        if (
          e.quote_mint === '11111111111111111111111111111111' &&
          !e.is_mayhem_mode &&
          !e.is_cashback_enabled &&
          !excluded.has(e.mint) &&
          h % BigInt(modulus) === BigInt(residue)
        ) {
          members.add(e.mint);
        }
      }
      if (members.has(e.mint)) events.push(e);
    }
  }
  const batches: { slot: number; events: any[] }[] = [];
  for (const e of events) {
    const tail = batches[batches.length - 1];
    if (tail !== undefined && tail.slot === e.slot) tail.events.push(e);
    else batches.push({ slot: e.slot, events: [e] });
  }
  return { events, endSlot: manifest.window?.end_slot ?? events[events.length - 1].slot, batches };
}

export function devSeed(compSlug: string, datasetSha: string): string {
  const h = createHash('sha256').update(`agent-fun/seed/v1\0${compSlug}\0dev\0${datasetSha}`).digest('hex');
  return BigInt(`0x${h.slice(0, 16)}`).toString();
}

export function makeHello(seed: string, kitDir: string): Hello {
  void kitDir;
  return {
    type: 'hello',
    protocol: 'agent-fun/replay/v2',
    seed,
    universe: {
      program: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
      quote: 'SOL',
      mayhem: 'excluded',
      exclude_cashback: true,
      sample: { hash: 'sha256', modulus: 16, residue: 15 },
    },
    capital: { lamports: '10000000000' },
    caps: { max_open_positions: 5, max_order_bps_of_real_reserve: 100, max_orders_per_batch: 16, shorts: false, leverage: false },
    latency_slots: 2,
    fees: { protocol_bps_fallback: 95, creator_bps_fallback: 30, base_fee_lamports: '5000', priority_fee_lamports: '100000', failed_tx_bps: 200 },
  };
}

export function simulate(ds: LoadedDataset, hello: Hello, bot: Bot, actionLog?: string[]): SimMetrics {
  const failKey = keyedU64(BigInt(hello.seed), FAIL_KEY_TAG);
  const txFee = BigInt(hello.fees.base_fee_lamports) + BigInt(hello.fees.priority_fee_lamports);
  const latency = hello.latency_slots;
  const caps = hello.caps;
  const mints = new Map<string, MintRuntime>();
  const pending: PendingOrder[] = [];
  const usedIds = new Set<string>();
  const positions = new Map<string, { tokens: bigint; cost: bigint }>();
  const startCash = BigInt(hello.capital.lamports);
  let cash = startCash;
  let undelivered: Fill[] = [];
  let seq = 0;
  let closeCounter = 0;
  const spentByMint = new Map<string, bigint>();
  let spentSeq = -1;
  let fills = 0;
  let rejected = 0;
  let failed = 0;
  const rejectReasons: Record<string, number> = {};
  const filledMints = new Set<string>();
  const boughtSol = new Map<string, bigint>();
  const roundTripCoins = new Set<string>();
  let trips = 0;
  let winningTrips = 0;
  let peak = startCash;
  let maxDd = 0;
  const hourlyEquity: { hour: number; equity: bigint }[] = [];
  let lastHour = -1;

  const tripPnl = new Map<string, bigint>();
  const bumpTrip = (mint: string, d: bigint): void => {
    tripPnl.set(mint, (tripPnl.get(mint) ?? 0n) + d);
  };
  const closeTrip = (mint: string): void => {
    trips++;
    const pnl = tripPnl.get(mint) ?? 0n;
    if (pnl > 0n) winningTrips++;
    tripPnl.delete(mint);
    const spent = boughtSol.get(mint) ?? 0n;
    if (spent >= 10_000_000n) roundTripCoins.add(mint);
  };

  const reservesOf = (m: MintRuntime): CurveReserves => {
    // Apply the bot's own offset, clamped so real reserves never go negative.
    let num = 1n;
    let den = 1n;
    if (m.offTokens > m.state.rt) {
      num = m.state.rt;
      den = m.offTokens;
    }
    if (m.offQuote < 0n && m.state.rq * den < num * -m.offQuote) {
      num = m.state.rq;
      den = -m.offQuote;
    }
    const scale = (x: bigint): bigint => (num === den ? x : x >= 0n ? (x * num) / den : -((-x * num) / den));
    const q = scale(m.offQuote);
    const t = scale(m.offTokens);
    return { vq: m.state.vq + q, rq: m.state.rq + q, vt: m.state.vt - t, rt: m.state.rt - t };
  };

  const feesFor = (landing: any | null): FeeSchedule =>
    landing !== null && BigInt(landing.fee_basis_points) > 0n
      ? { protocol: BigInt(landing.fee_basis_points), creator: BigInt(landing.creator_fee_basis_points) }
      : { protocol: BigInt(hello.fees.protocol_bps_fallback), creator: BigInt(hello.fees.creator_bps_fallback) };

  const applyImpact = (m: MintRuntime, isBuy: boolean, q: bigint, t: bigint) => {
    if (isBuy) {
      m.offQuote += q;
      m.offTokens += t;
    } else {
      m.offQuote -= q;
      m.offTokens -= t;
    }
  };

  const closeQuote = (m: MintRuntime, tokens: bigint): { q: bigint; proceeds: bigint; net: bigint; abandon: boolean } => {
    const bps = feesFor(m.lastTrade);
    const s = reservesOf(m);
    const raw = sellExact(tokens, s, bps);
    const q = raw.quoteOut > s.rq ? s.rq : raw.quoteOut;
    const proceeds = q - feeOf(q, bps.protocol) - feeOf(q, bps.creator);
    const net = proceeds - txFee;
    return { q, proceeds, net, abandon: net <= 0n };
  };

  const equityNow = (): bigint => {
    let e = cash;
    for (const [mint, p] of positions) {
      const c = closeQuote(mints.get(mint)!, p.tokens);
      if (!c.abandon) e += c.net;
    }
    return e;
  };

  const pushEquity = (e: bigint, hour: number) => {
    if (e > peak) peak = e;
    const dd = Number(peak - e) / Number(peak);
    if (dd > maxDd) maxDd = dd;
    if (hour !== lastHour) {
      hourlyEquity.push({ hour, equity: e });
      lastHour = hour;
    }
  };

  const emitFill = (p: PendingOrder, status: Fill['status'], reason: string | null, quote: bigint, tokens: bigint): void => {
    if (status === 'rejected') {
      rejected++;
      rejectReasons[reason!] = (rejectReasons[reason!] ?? 0) + 1;
    }
    if (status === 'failed') failed++;
    if (status === 'filled') {
      fills++;
      filledMints.add(p.order.mint);
    }
    undelivered.push({
      client_id: p.order.client_id,
      mint: p.order.mint,
      side: p.order.side,
      status,
      reason: reason as Fill['reason'],
      decided_slot: p.decidedSlot,
      slot: p.fillSlot,
      quote_lamports: quote.toString(),
      token_amount: tokens.toString(),
      fee_lamports: '0',
      tx_fee_lamports: status === 'rejected' ? '0' : txFee.toString(),
      fee_fallback: false,
    });
  };

  const openCount = (): number => {
    let n = 0;
    for (const p of positions.values()) if (p.tokens > 0n) n++;
    return n;
  };

  const isFailedTx = (p: PendingOrder): boolean =>
    keyedU64(failKey, FAIL_TAG, BigInt(p.seq), BigInt(p.index)) % 10_000n < BigInt(hello.fees.failed_tx_bps);

  const resolve = (p: PendingOrder): void => {
    if (p.reject !== null) return emitFill(p, 'rejected', p.reject, 0n, 0n);
    const m = mints.get(p.order.mint)!;
    if (m.complete) return emitFill(p, 'rejected', 'token_complete', 0n, 0n);
    const landing = m.lastTradeSlot === p.fillSlot ? m.lastTrade : null;
    const bps = feesFor(landing);
    const slip = BigInt(p.order.max_slippage_bps);
    const decision = p.decision!;
    const s = reservesOf(m);
    if (p.order.side === 'sell') {
      const pos = positions.get(p.order.mint);
      const t = BigInt(p.order.token_amount);
      if (pos === undefined || pos.tokens < t) return emitFill(p, 'rejected', 'insufficient_tokens', 0n, 0n);
      const sq = sellExact(t, s, bps);
      if (sq.quoteOut > s.rq) return emitFill(p, 'rejected', 'max_order_size', 0n, 0n);
      if (sq.proceeds <= 0n) return emitFill(p, 'rejected', 'zero_amount', 0n, 0n);
      const expected = sellExact(t, decision, bps).proceeds;
      if (sq.proceeds * BPS < expected * (BPS - slip)) return emitFill(p, 'rejected', 'max_slippage', 0n, 0n);
      if (cash < txFee) return emitFill(p, 'rejected', 'insufficient_cash', 0n, 0n);
      if (isFailedTx(p)) {
        cash -= txFee;
        bumpTrip(p.order.mint, -txFee);
        return emitFill(p, 'failed', null, 0n, 0n);
      }
      cash += sq.proceeds - txFee;
      bumpTrip(p.order.mint, sq.proceeds - txFee);
      const removed = pos.tokens === t ? pos.cost : (pos.cost * t) / pos.tokens;
      pos.tokens -= t;
      pos.cost -= removed;
      applyImpact(m, false, sq.quoteOut, t);
      if (pos.tokens === 0n) {
        positions.delete(p.order.mint);
        closeTrip(p.order.mint);
      }
      return emitFill(p, 'filled', null, sq.proceeds, t);
    }
    // buy
    const spend = BigInt(p.order.quote_lamports);
    const held = positions.get(p.order.mint);
    if ((held === undefined || held.tokens === 0n) && openCount() >= caps.max_open_positions) {
      return emitFill(p, 'rejected', 'max_open_positions', 0n, 0n);
    }
    if (spentSeq !== p.seq) {
      spentSeq = p.seq;
      spentByMint.clear();
    }
    const total = (spentByMint.get(p.order.mint) ?? 0n) + spend;
    if (total * BPS > decision.rq * BigInt(caps.max_order_bps_of_real_reserve)) {
      return emitFill(p, 'rejected', 'max_order_size', 0n, 0n);
    }
    spentByMint.set(p.order.mint, total);
    const bq = buyExactIn(spend, s, bps);
    if (bq.tokens === 0n) return emitFill(p, 'rejected', 'zero_amount', 0n, 0n);
    const expected = buyExactIn(spend, decision, bps).tokens;
    if (bq.tokens * BPS < expected * (BPS - slip)) return emitFill(p, 'rejected', 'max_slippage', 0n, 0n);
    if (cash < spend + txFee) return emitFill(p, 'rejected', 'insufficient_cash', 0n, 0n);
    if (isFailedTx(p)) {
      cash -= txFee;
      bumpTrip(p.order.mint, -txFee);
      return emitFill(p, 'failed', null, 0n, 0n);
    }
    cash -= bq.paid + txFee;
    bumpTrip(p.order.mint, -(bq.paid + txFee));
    boughtSol.set(p.order.mint, (boughtSol.get(p.order.mint) ?? 0n) + bq.paid);
    let pos = held;
    if (pos === undefined) {
      pos = { tokens: 0n, cost: 0n };
      positions.set(p.order.mint, pos);
    }
    pos.tokens += bq.tokens;
    pos.cost += bq.paid;
    applyImpact(m, true, bq.quoteIn, bq.tokens);
    return emitFill(p, 'filled', null, bq.paid, bq.tokens);
  };

  const forceClose = (mint: string, why: string, slot: number): void => {
    const pos = positions.get(mint)!;
    const m = mints.get(mint)!;
    const c = closeQuote(m, pos.tokens);
    const n = closeCounter++;
    const kind = c.abandon ? 'writeoff' : why;
    if (!c.abandon) {
      cash += c.net;
      bumpTrip(mint, c.net);
      applyImpact(m, false, c.q, pos.tokens);
    }
    undelivered.push({
      client_id: `_${kind}_${n}`,
      mint,
      side: 'sell',
      status: 'filled',
      reason: null,
      decided_slot: slot,
      slot,
      quote_lamports: c.abandon ? '0' : c.proceeds.toString(),
      token_amount: pos.tokens.toString(),
      fee_lamports: '0',
      tx_fee_lamports: c.abandon ? '0' : txFee.toString(),
      fee_fallback: false,
    });
    positions.delete(mint);
    closeTrip(mint);
  };

  const account = () => ({
    cash_lamports: cash.toString(),
    positions: [...positions.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([mint, p]) => ({ mint, token_amount: p.tokens.toString(), cost_lamports: p.cost.toString() })),
  });

  const marks = (): Mark[] => {
    const want = new Set<string>(positions.keys());
    for (const p of pending) if (mints.has(p.order.mint)) want.add(p.order.mint);
    return [...want].sort().map((mint) => {
      const m = mints.get(mint)!;
      const s = reservesOf(m);
      return {
        mint,
        slot: m.stateSlot,
        virtual_token_reserves: s.vt.toString(),
        virtual_quote_reserves: s.vq.toString(),
        real_token_reserves: s.rt.toString(),
        real_quote_reserves: s.rq.toString(),
      };
    });
  };

  const state = new BotState(hello);
  bot.onHello?.(state);
  for (const b of ds.batches) {
    const slot = b.slot;
    while (pending.length > 0 && pending[0]!.fillSlot < slot) resolve(pending.shift()!);
    const completed: string[] = [];
    let hour = lastHour;
    for (const e of b.events) {
      if (e.block_time !== null && e.block_time !== undefined) hour = Math.floor(e.block_time / 3600);
      if (e.event === 'CreateEvent') {
        mints.set(e.mint, {
          state: { vq: BigInt(e.virtual_quote_reserves), vt: BigInt(e.virtual_token_reserves), rq: 0n, rt: BigInt(e.real_token_reserves) },
          stateSlot: slot,
          lastTrade: null,
          lastTradeSlot: -1,
          complete: false,
          offQuote: 0n,
          offTokens: 0n,
        });
      } else if (e.event === 'TradeEvent') {
        const m = mints.get(e.mint)!;
        m.state = { vq: BigInt(e.virtual_quote_reserves), vt: BigInt(e.virtual_token_reserves), rq: BigInt(e.real_quote_reserves), rt: BigInt(e.real_token_reserves) };
        m.stateSlot = slot;
        m.lastTrade = e;
        m.lastTradeSlot = slot;
      } else {
        mints.get(e.mint)!.complete = true;
        completed.push(e.mint);
      }
    }
    for (const mint of completed) if (positions.has(mint)) forceClose(mint, 'complete', slot);
    while (pending.length > 0 && pending[0]!.fillSlot === slot) resolve(pending.shift()!);
    const batch: Batch = { type: 'batch', seq, slot, events: b.events, marks: marks(), fills: undelivered, account: account() };
    undelivered = [];
    pushEquity(equityNow(), hour);
    state.applyBatch(batch);
    const orders = state.toOrders(bot.onBatch(state, batch) as unknown);
    if (actionLog !== undefined) actionLog.push(JSON.stringify({ seq, slot, orders }));
    state.recordOrders(orders);
    orders.forEach((order, index) => {
      let reject: string | null = null;
      const amount = order.side === 'buy' ? order.quote_lamports : order.token_amount;
      if (index >= caps.max_orders_per_batch) reject = 'max_orders_per_batch';
      else if (usedIds.has(order.client_id)) reject = 'duplicate_client_id';
      else if (amount === '0') reject = 'zero_amount';
      else if (!mints.has(order.mint)) reject = 'not_in_universe';
      usedIds.add(order.client_id);
      const m = mints.get(order.mint);
      pending.push({ order, seq, index, decidedSlot: slot, fillSlot: slot + latency, reject, decision: m ? reservesOf(m) : null });
    });
    seq++;
  }
  while (pending.length > 0) {
    const p = pending.shift()!;
    if (p.fillSlot > ds.endSlot) emitFill(p, 'rejected', 'after_end', 0n, 0n);
    else resolve(p);
  }
  for (const mint of [...positions.keys()].sort()) forceClose(mint, 'flatten', ds.endSlot);
  pushEquity(cash, lastHour);

  // Hourly Sharpe from the hourly equity samples.
  const hourlyReturns: number[] = [];
  for (let i = 1; i < hourlyEquity.length; i++) {
    const prev = Number(hourlyEquity[i - 1]!.equity);
    const cur = Number(hourlyEquity[i]!.equity);
    if (prev > 0) hourlyReturns.push((cur - prev) / prev);
  }
  let sharpe = 0;
  if (hourlyReturns.length >= 2) {
    const mean = hourlyReturns.reduce((a, b) => a + b, 0) / hourlyReturns.length;
    const variance = hourlyReturns.reduce((a, r) => a + (r - mean) * (r - mean), 0) / (hourlyReturns.length - 1);
    const std = Math.sqrt(variance);
    sharpe = std > 0 ? mean / std : 0;
  }
  // Winning trips are not tracked per-trip in this sim (positions close via
  // force-close too); report trips and round-trip coins instead.
  return {
    netPnlSol: Number(cash - startCash) / 1e9,
    sharpeHourly: sharpe,
    maxDrawdown: maxDd,
    fills,
    distinctMints: filledMints.size,
    roundTripCoins: roundTripCoins.size,
    trips,
    winningTrips,
    rejected,
    failed,
    rejectReasons,
    hourlyReturns,
  };
}

// ---------------------------------------------------------------- CLI

function printMetrics(tag: string, r: SimMetrics): void {
  console.log(
    `${tag} netPnL ${r.netPnlSol.toFixed(4)} SOL sharpe/h ${r.sharpeHourly.toFixed(4)} ` +
      `maxDD ${(r.maxDrawdown * 100).toFixed(2)}% fills ${r.fills} coins ${r.distinctMints} ` +
      `roundTripCoins ${r.roundTripCoins} trips ${r.trips} winRate ${r.trips > 0 ? ((r.winningTrips / r.trips) * 100).toFixed(1) : '0'}% ` +
      `rejected ${r.rejected} failed ${r.failed} hours ${r.hourlyReturns.length}`,
  );
  if (Object.keys(r.rejectReasons).length > 0) console.log(`  rejects: ${JSON.stringify(r.rejectReasons)}`);
}

const args = process.argv.slice(2);
const isMain = new URL(import.meta.url).pathname === process.argv[1];
if (!isMain) {
  // Imported as a library (e.g. by tools/sweep.ts): skip the CLI below.
} else {
if (args.includes('--help')) {
  console.log('usage: node tools/sim.ts [kit-dir] [--params \'{...}\'] [--out log.jsonl]');
  process.exit(0);
}
const paramsIdx = args.indexOf('--params');
const outIdx = args.indexOf('--out');
const valueIdx = new Set<number>([paramsIdx + 1, outIdx + 1].filter((i) => i > 0));
const positional = args.filter((a, i) => !a.startsWith('--') && !valueIdx.has(i));
const kitDir =
  positional[0] ??
  '/home/hatch/workspace/makefun/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/kit/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532-kit';
const overrides: Partial<ScalperParams> = paramsIdx >= 0 ? JSON.parse(args[paramsIdx + 1]!) : {};
const outPath = outIdx >= 0 ? args[outIdx + 1]! : undefined;

const ds = loadDataset(kitDir);
console.log(`dataset: ${ds.events.length} events, ${ds.batches.length} batches, endSlot ${ds.endSlot}`);
const kitJson = JSON.parse(readFileSync(`${kitDir}/kit.json`, 'utf8'));
const seed = devSeed('u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532', kitJson.dataset_sha256);
const hello = makeHello(seed, kitDir);
const params: ScalperParams = { ...DEFAULT_PARAMS, ...overrides };
const actionLog: string[] | undefined = outPath !== undefined ? [] : undefined;
const result = simulate(ds, hello, createScalper(params), actionLog);
printMetrics('default', result);
if (outPath !== undefined && actionLog !== undefined) {
  writeFileSync(outPath, actionLog.join('\n') + '\n');
  console.log(`action log: ${actionLog.length} batches -> ${outPath}`);
}
} // end isMain
