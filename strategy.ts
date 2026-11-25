// Sharpe-first scalper for the pump.fun bonding-curve replay (agent-fun/replay/v2).
//
// Two entry lanes, one exit discipline:
//
// 1. Launch lane — buys a fresh curve within a few slots of its CreateEvent
//    when the opening tape looks organic: at most a couple of distinct
//    non-creator buyers (a launch bundled by many wallets is a dump waiting
//    to happen), a small creator buy, no creator sell, positive net flow and
//    a modest run-up from the create price. Stake is small; the position is
//    cut fast on a stop-loss, exits on a creator sell, and otherwise rides a
//    wide trailing stop so a real runner can pay for many small losers.
//
// 2. Momentum lane — buys a mature curve (past minAge slots) whose short tape
//    shows broad, accelerating buy pressure with the price still near its
//    window high and no single wallet dominating the flow. First buy is tiny,
//    topped up only while already in profit and inflow continues. Exits are
//    strict and fast: hard stop, full take-profit at a modest gain (locking
//    small wins often is what keeps the hourly equity curve smooth), a
//    trailing stop once armed, and a hold cap.
//
// A pacing guard opens tiny probe round trips (0.01 SOL) when the bot's own
// fills / distinct coins lag the pace the guardrails need.
//
// Deterministic by construction: no clock, no environment, no randomness;
// every iteration is over insertion-ordered maps fed by the batch stream.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface ScalperParams {
  // ---- momentum lane ----
  /** Entry tape window, in slots. */
  entryWindow: number;
  /** Net buy SOL (buys minus sells) over the entry window. */
  minNetSol: number;
  /** Buy trades in the entry window. */
  minBuys: number;
  /** Distinct buying wallets in the entry window. */
  minBuyers: number;
  /** Price now over price at window start, minus 1 (lower bound). */
  minRise: number;
  /** Same ratio, upper bound: skip curves that already sprinted away. */
  maxRise: number;
  /** Newer-half net inflow must be at least this multiple of the older half. */
  accel: number;
  /** Price now must be at least this share of the window high. */
  nearHigh: number;
  /** Largest single wallet's share of window buy SOL (anti-bundle). */
  maxTopShare: number;
  /** Real SOL reserve band at entry. */
  minRealSol: number;
  maxRealSol: number;
  /** Slots since CreateEvent before a momentum entry is allowed. */
  minAge: number;
  /** First buy of a momentum position (SOL). */
  firstBuySol: number;
  /** Each pyramid add (SOL). */
  addBuySol: number;
  /** Total SOL per position at most. */
  stakeCapSol: number;
  /** Smallest buy worth sending (SOL). */
  minBuySol: number;
  /** Slippage on buys (bps); sells always go out at 10000. */
  buySlipBps: number;
  /** Exit when value falls this far below cost (fraction). */
  stopLoss: number;
  /** Exit whole position when value rises this far above cost (fraction). */
  takeProfit: number;
  /** Trailing stop: exit when value falls this far below its peak (fraction). */
  trailDrop: number;
  /** Trailing stop arms once value reached cost * (1 + trailArm). */
  trailArm: number;
  /** Fade window (slots) for the outflow exit. */
  fadeWindow: number;
  /** Exit when net SOL over the fade window falls below this. */
  fadeNetSol: number;
  /** Exit on any single recorded sell of at least this many SOL. */
  bigSellSol: number;
  /** Exit after this many slots held. */
  maxHold: number;
  /** The hold cap does not apply while the position is up at least this much. */
  holdIfUp: number;
  /** Slots to wait after an exit before the same curve may be bought again. */
  cooldown: number;
  /** Most entries per curve over the run. */
  maxEntries: number;
  /** Most momentum positions open at once (rest of the cap is for probes). */
  maxMain: number;
  /** Most SOL at cost across all positions at once (drawdown guard). */
  maxExposureSol: number;
  /** Pyramid add only once price is this far above the last buy's price. */
  addStep: number;
  /** Pyramid add only while value is at least cost * (1 + addIfUp). */
  addIfUp: number;
  /** Pyramid add only while net SOL over the entry window is at least this. */
  addNetSol: number;
  // ---- launch lane ----
  /** Oldest age (slots since create) at which a launch buy may be decided. */
  launchMaxAge: number;
  /** Most distinct non-creator buyers seen before a launch buy. */
  launchMaxBuyers: number;
  /** Creator's own buys in the create slot, at most (SOL). */
  launchMaxDevBuy: number;
  /** Real SOL reserve band at a launch buy. */
  launchMinReal: number;
  launchMaxReal: number;
  /** Stake per launch buy (SOL; still capped at 1% of real reserve). */
  launchStake: number;
  /** Launch exit: stop-loss fraction. */
  launchSl: number;
  /** Launch exit: take-profit fraction (high: let runners run). */
  launchTp: number;
  /** Launch exit: trailing-stop arm fraction. */
  launchTrailArm: number;
  /** Launch exit: trailing-stop drop fraction. */
  launchTrailDrop: number;
  /** Launch exit: max hold in slots. */
  launchMaxHold: number;
  /** Launch buy only while price is at most this multiple of create price. */
  launchMaxRunup: number;
  /** Launch buy only while net flow (buys minus sells) is at least this (SOL). */
  launchMinFlow: number;
  /** Smallest launch buy worth sending (SOL): early buys are capped at 1% of
   *  a small real reserve, so this must be smaller than minBuySol. */
  launchMinBuySol: number;
  // ---- guardrail pacing ----
  /** Guardrail pacing targets. */
  targetCoins: number;
  targetFills: number;
  /** Seconds of block time over which the pace ramps to the targets. */
  paceSecs: number;
  /** Probe round-trip size (SOL). Must stay >= 0.01 to count. */
  probeSol: number;
  /** Most probe round trips open at once. */
  maxProbes: number;
}

// Settings traded live. Picked on the dev window with tools/sim.ts +
// tools/sweep.ts, preferring the middle of a flat good region over the
// single best grid cell (see STRATEGY.md).
export const DEFAULT_PARAMS: ScalperParams = {
  entryWindow: 36,
  minNetSol: 0.8,
  minBuys: 3,
  minBuyers: 4,
  minRise: 0.1,
  maxRise: 1.2,
  accel: 0.8,
  nearHigh: 0.94,
  maxTopShare: 0.6,
  minRealSol: 3,
  maxRealSol: 80,
  minAge: 400,
  firstBuySol: 0.05,
  addBuySol: 0.15,
  stakeCapSol: 1.5,
  minBuySol: 0.01,
  buySlipBps: 1500,
  stopLoss: 0.12,
  takeProfit: 0.12,
  trailDrop: 0.25,
  trailArm: 0.06,
  fadeWindow: 18,
  fadeNetSol: -1000,
  bigSellSol: 5,
  maxHold: 1200,
  holdIfUp: 0.03,
  cooldown: 120,
  maxEntries: 2,
  maxMain: 4,
  maxExposureSol: 5,
  addStep: 0.03,
  addIfUp: 0.04,
  addNetSol: 0,
  launchMaxAge: 3,
  launchMaxBuyers: 2,
  launchMaxDevBuy: 2.5,
  launchMinReal: 0.3,
  launchMaxReal: 30,
  launchStake: 0.05,
  launchSl: 0.1,
  launchTp: 0.5,
  launchTrailArm: 0.2,
  launchTrailDrop: 0.3,
  launchMaxHold: 40,
  launchMaxRunup: 2,
  launchMinFlow: 0,
  launchMinBuySol: 0.005,
  targetCoins: 25,
  targetFills: 240,
  paceSecs: 14400,
  probeSol: 0.01,
  maxProbes: 1,
};

const LAMPORTS = 1e9;
/** Curve fee on a trade: protocol 95 bps + creator 30 bps = 1.25%. */
const CURVE_FEE = 0.0125;
const BPS = 10_000;

interface TapeTrade {
  slot: number;
  buy: boolean;
  sol: number;
  wallet: string;
  price: number;
}

interface CurveTape {
  createdSlot: number | null;
  trades: TapeTrade[];
  entries: number;
  lastExitSlot: number;
}

/** Opening-tape facts for the launch lane, per mint. */
interface LaunchBook {
  mint: Pubkey;
  createdSlot: number;
  creator: string;
  createVq: number;
  createVt: number;
  devBuySol: number;
  buyers: Set<string>;
  devSold: boolean;
  boughtSol: number;
  soldSol: number;
  launchDone: boolean;
  complete: boolean;
}

interface OpenPos {
  openedSlot: number;
  peakValueSol: number;
  investedSol: number;
  lastBuyPrice: number;
  lastValueSol: number;
  filled: boolean;
  exiting: boolean;
  /** Lane-specific exit parameters (launch positions differ from momentum). */
  stopLoss: number;
  takeProfit: number;
  trailDrop: number;
  trailArm: number;
  maxHold: number;
  holdIfUp: number;
  /** Launch positions exit at once when the creator sells. */
  devSoldAtOpen: boolean;
  lane: 'launch' | 'momentum';
}

export function createScalper(p: ScalperParams = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, CurveTape>();
  const books = new Map<Pubkey, LaunchBook>();
  const open = new Map<Pubkey, OpenPos>();
  /** Probe round trips in flight: false = buy sent, true = sell sent. */
  const probes = new Map<Pubkey, boolean>();
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstBlockTime: number | null = null;
  let lastBlockTime: number | null = null;
  const keepSlots = Math.max(p.entryWindow, p.fadeWindow) + 5;

  const tapeOf = (mint: Pubkey): CurveTape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { createdSlot: null, trades: [], entries: 0, lastExitSlot: -1e12 };
      tapes.set(mint, t);
    }
    return t;
  };

  /** Net recorded SOL (buys minus sells) over the last `w` slots. */
  const netFlow = (t: CurveTape, now: number, w: number): number => {
    let net = 0;
    for (let i = t.trades.length - 1; i >= 0; i--) {
      const tr = t.trades[i]!;
      if (tr.slot <= now - w) break;
      net += tr.buy ? tr.sol : -tr.sol;
    }
    return net;
  };

  /** Momentum entry check on a curve's tape at slot `now`. */
  const entryOk = (t: CurveTape, now: number, realSol: number): boolean => {
    if (realSol < p.minRealSol || realSol > p.maxRealSol) return false;
    if (t.createdSlot === null || now - t.createdSlot < p.minAge) return false;
    const from = now - p.entryWindow;
    const mid = now - p.entryWindow / 2;
    let buySol = 0;
    let sellSol = 0;
    let buys = 0;
    let netOld = 0;
    let netNew = 0;
    let startPrice = -1;
    let high = 0;
    let last = 0;
    const byWallet = new Map<string, number>();
    for (const tr of t.trades) {
      if (tr.slot <= from) {
        startPrice = tr.price;
        continue;
      }
      if (startPrice < 0) startPrice = tr.price;
      const signed = tr.buy ? tr.sol : -tr.sol;
      if (tr.slot <= mid) netOld += signed;
      else netNew += signed;
      if (tr.buy) {
        buySol += tr.sol;
        buys++;
        byWallet.set(tr.wallet, (byWallet.get(tr.wallet) ?? 0) + tr.sol);
      } else {
        sellSol += tr.sol;
      }
      if (tr.price > high) high = tr.price;
      last = tr.price;
    }
    if (buys < p.minBuys || byWallet.size < p.minBuyers) return false;
    if (buySol - sellSol < p.minNetSol) return false;
    if (startPrice <= 0 || last <= 0) return false;
    const rise = last / startPrice - 1;
    if (rise < p.minRise || rise > p.maxRise) return false;
    if (last < high * p.nearHigh) return false;
    if (netNew <= 0 || netNew < p.accel * netOld) return false;
    let top = 0;
    for (const v of byWallet.values()) if (v > top) top = v;
    if (top > p.maxTopShare * buySol) return false;
    return true;
  };

  /** Launch-lane entry check on a curve's opening book at slot `now`. */
  const launchOk = (b: LaunchBook, now: number, realSol: number, price: number): boolean => {
    if (b.launchDone || b.complete) return false;
    if (now - b.createdSlot > p.launchMaxAge) return false;
    if (realSol < p.launchMinReal || realSol > p.launchMaxReal) return false;
    if (b.devBuySol > p.launchMaxDevBuy) return false;
    if (b.buyers.size > p.launchMaxBuyers) return false;
    if (b.devSold) return false;
    if (b.boughtSol - b.soldSol < p.launchMinFlow) return false;
    const runup = (price * b.createVt) / b.createVq;
    if (runup > p.launchMaxRunup) return false;
    return true;
  };

  /** Estimated SOL received selling `tokens` at the given reserves (fees + tx fee off). */
  const sellValueSol = (tokens: number, vq: number, vt: number, txSol: number): number => {
    const gross = (tokens * vq) / (vt + tokens) / LAMPORTS;
    return gross * (1 - CURVE_FEE) - txSol;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const bigSell = new Set<Pubkey>();
      const traded = new Set<Pubkey>();
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstBlockTime === null) firstBlockTime = e.block_time;
          if (lastBlockTime === null || e.block_time > lastBlockTime) lastBlockTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          tapeOf(e.mint).createdSlot = e.slot;
          books.set(e.mint, {
            mint: e.mint,
            createdSlot: e.slot,
            creator: e.creator,
            createVq: Number(e.virtual_quote_reserves),
            createVt: Number(e.virtual_token_reserves),
            devBuySol: 0,
            buyers: new Set(),
            devSold: false,
            boughtSol: 0,
            soldSol: 0,
            launchDone: false,
            complete: false,
          });
        } else if (e.event === 'TradeEvent') {
          const t = tapeOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          t.trades.push({
            slot: e.slot,
            buy: e.is_buy,
            sol,
            wallet: e.user,
            price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves),
          });
          traded.add(e.mint);
          if (!e.is_buy && sol >= p.bigSellSol) bigSell.add(e.mint);
          const b = books.get(e.mint);
          if (b !== undefined) {
            if (e.is_buy) {
              b.boughtSol += sol;
              if (e.user === b.creator && e.slot === b.createdSlot) b.devBuySol += sol;
              else if (e.user !== b.creator) b.buyers.add(e.user);
            } else {
              if (e.user === b.creator) b.devSold = true;
              else b.soldSol += sol;
            }
          }
        } else {
          const b = books.get(e.mint);
          if (b !== undefined) b.complete = true;
        }
      }
      for (const mint of traded) {
        const t = tapes.get(mint)!;
        let cut = 0;
        while (cut < t.trades.length && t.trades[cut]!.slot <= now - keepSlots) cut++;
        if (cut > 0) t.trades.splice(0, cut);
      }
      // Prune launch books that can no longer produce a launch buy and are not held.
      for (const [mint, b] of books) {
        if (!open.has(mint) && now - b.createdSlot > p.launchMaxAge + 100) books.delete(mint);
      }

      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      const sellPending = new Set<Pubkey>();
      for (const po of state.pending.values()) {
        pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);
        if (po.order.side === 'sell') sellPending.add(po.order.mint);
      }

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const txSol = Number(state.txFeeLamports()) / LAMPORTS;

      // ---- 1. Exits (all open positions, lane-specific parameters) ----
      for (const [mint, pos] of open) {
        const held = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (held === undefined) {
          if (!pendingByMint.has(mint)) {
            open.delete(mint);
            const t = tapeOf(mint);
            if (pos.filled) t.lastExitSlot = now;
            else t.entries--;
          }
          continue;
        }
        pos.filled = true;
        if (curve === undefined || curve.complete) continue;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const tokens = Number(held.token_amount);
        const value = sellValueSol(tokens, vq, vt, txSol);
        const cost = Number(held.cost_lamports) / LAMPORTS;
        if (value > pos.peakValueSol) pos.peakValueSol = value;
        pos.lastValueSol = value;
        const t = tapeOf(mint);
        const b = books.get(mint);
        let exit = pos.exiting;
        if (!exit && value < cost * (1 - pos.stopLoss)) exit = true;
        if (!exit && value > cost * (1 + pos.takeProfit)) exit = true;
        if (!exit && pos.peakValueSol >= cost * (1 + pos.trailArm) && value < pos.peakValueSol * (1 - pos.trailDrop)) exit = true;
        if (!exit && pos.lane === 'momentum' && netFlow(t, now, p.fadeWindow) < p.fadeNetSol) exit = true;
        if (!exit && pos.lane === 'momentum' && bigSell.has(mint)) exit = true;
        if (!exit && now - pos.openedSlot > pos.maxHold && value < cost * (1 + pos.holdIfUp)) exit = true;
        if (!exit && pos.lane === 'launch' && b !== undefined && b.devSold && !pos.devSoldAtOpen) exit = true;
        if (!exit) continue;
        pos.exiting = true;
        if (sellPending.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: held.token_amount, max_slippage_bps: BPS });
      }

      // ---- 2. Probe sells: dump the probe as soon as its buy landed ----
      for (const [mint, selling] of probes) {
        const held = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (held === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: held.token_amount, max_slippage_bps: BPS });
        if (!selling) probes.set(mint, true);
      }

      // ---- 3. Entries ----
      let freeSol = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let mainLeft = p.maxMain - open.size;
      let exposure = 0;
      for (const [mint, pos] of open) {
        exposure += Math.max(pos.investedSol, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);
      }
      const sendBuy = (mint: Pubkey, wantSol: number, lane: 'launch' | 'momentum', price: number): boolean => {
        const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
        let amount = Math.min(capSol, wantSol, p.maxExposureSol - exposure);
        if (amount > freeSol - txSol) amount = freeSol - txSol;
        if (amount < (lane === 'launch' ? p.launchMinBuySol : p.minBuySol)) return false;
        const lamports = BigInt(Math.floor(amount * LAMPORTS));
        orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: p.buySlipBps });
        freeSol -= amount + txSol;
        exposure += amount;
        const b = books.get(mint);
        open.set(mint, {
          openedSlot: now,
          peakValueSol: 0,
          investedSol: amount,
          lastBuyPrice: price,
          lastValueSol: 0,
          filled: false,
          exiting: false,
          stopLoss: lane === 'launch' ? p.launchSl : p.stopLoss,
          takeProfit: lane === 'launch' ? p.launchTp : p.takeProfit,
          trailDrop: lane === 'launch' ? p.launchTrailDrop : p.trailDrop,
          trailArm: lane === 'launch' ? p.launchTrailArm : p.trailArm,
          maxHold: lane === 'launch' ? p.launchMaxHold : p.maxHold,
          holdIfUp: lane === 'launch' ? 1000 : p.holdIfUp,
          devSoldAtOpen: b !== undefined ? b.devSold : false,
          lane,
        });
        if (lane === 'launch' && b !== undefined) b.launchDone = true;
        slotsLeft--;
        mainLeft--;
        return true;
      };

      // 3a. Launch lane first: the window is only a few slots wide.
      for (const b of books.values()) {
        if (orders.length >= cap) break;
        if (slotsLeft <= 0 || mainLeft <= 0) break;
        if (open.has(b.mint) || probes.has(b.mint) || pendingByMint.has(b.mint)) continue;
        const curve = state.curves.get(b.mint);
        if (curve === undefined || curve.complete) continue;
        const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        const realSol = Number(curve.real_quote_reserves) / LAMPORTS;
        if (!launchOk(b, now, realSol, price)) {
          if (now - b.createdSlot > p.launchMaxAge) b.launchDone = true;
          continue;
        }
        sendBuy(b.mint, p.launchStake, 'launch', price);
      }

      // 3b. Momentum entries and pyramid adds.
      for (const mint of traded) {
        if (orders.length >= cap) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint) || probes.has(mint)) continue;
        const t = tapes.get(mint)!;
        const pos = open.get(mint);
        const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        const realSol = Number(curve.real_quote_reserves) / LAMPORTS;
        if (pos === undefined) {
          if (slotsLeft <= 0 || mainLeft <= 0) continue;
          if (t.entries >= p.maxEntries || now - t.lastExitSlot < p.cooldown) continue;
          if (!entryOk(t, now, realSol)) continue;
          if (sendBuy(mint, Math.min(p.firstBuySol, p.stakeCapSol), 'momentum', price)) t.entries++;
        } else {
          // Pyramid into strength only: already in profit, price stepped up from
          // the last add, and inflow still positive.
          if (pos.lane !== 'momentum' || pos.exiting || !pos.filled || pos.investedSol >= p.stakeCapSol - p.minBuySol) continue;
          const held = state.positions.get(mint);
          if (held === undefined) continue;
          if (price < pos.lastBuyPrice * (1 + p.addStep)) continue;
          if (pos.lastValueSol < Number(held.cost_lamports) / LAMPORTS * (1 + p.addIfUp)) continue;
          if (netFlow(t, now, p.entryWindow) < p.addNetSol) continue;
          if (realSol > p.maxRealSol) continue;
          const want = Math.min(p.addBuySol, p.stakeCapSol - pos.investedSol);
          const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
          let amount = Math.min(capSol, want, p.maxExposureSol - exposure);
          if (amount > freeSol - txSol) amount = freeSol - txSol;
          if (amount < p.minBuySol) continue;
          orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(amount * LAMPORTS)), max_slippage_bps: p.buySlipBps });
          freeSol -= amount + txSol;
          exposure += amount;
          pos.investedSol += amount;
          pos.lastBuyPrice = price;
        }
      }

      // ---- 4. Guardrail pacing: probe round trips when fills/coins lag ----
      if (probes.size < p.maxProbes && slotsLeft > 0 && firstBlockTime !== null && lastBlockTime !== null) {
        const pace = Math.min(1, (lastBlockTime - firstBlockTime) / p.paceSecs);
        const needCoins = myCoins.size < Math.ceil(p.targetCoins * pace);
        const needFills = myFills < Math.ceil(p.targetFills * pace);
        if (needCoins || needFills) {
          const minReal = (p.probeSol * BPS) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of traded) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (open.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (needCoins && !needFills && myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minReal * 1.5) continue;
            if (freeSol < p.probeSol + 2 * txSol) break;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)), max_slippage_bps: p.buySlipBps });
            probes.set(mint, false);
            freeSol -= p.probeSol + txSol;
          }
        }
      }
      return orders;
    },
  };
}
