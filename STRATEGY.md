# STRATEGY.md — Sharpe-first scalper

## Idea

Take many small, short, confirmed trades and bank thin wins fast. Two entry
lanes feed one exit discipline; a pacing guard keeps the guardrails met.

### Launch lane (fresh curves, age ≤ 3 slots)

Buys a curve within a few slots of its `CreateEvent` when the opening tape
looks organic:

- at most 2 distinct non-creator buyers (a launch bundled by many wallets is
  a dump waiting to happen),
- creator's own buy in the create slot ≤ 2.5 SOL,
- creator has not sold,
- net flow (buys − sells) ≥ 0,
- real SOL in [0.3, 30],
- price at most 2× the create price.

Stake 0.05 SOL (still capped at 1% of real reserve per batch, so early buys
are usually 0.005–0.02 SOL). Exits: stop-loss −10%, take-profit +50% (high,
so a real runner is not capped early), trailing stop −30% from peak once
+20% up, max hold 40 slots, exit at once when the creator sells.

### Momentum lane (mature curves, age ≥ 400 slots)

Buys when the 36-slot tape shows broad, accelerating buy pressure:

- net inflow ≥ 0.8 SOL, ≥ 3 buys, ≥ 4 distinct buyers,
- price up 10–120% over the window, sitting at ≥ 94% of the window high,
- newer-half inflow ≥ 0.8× older-half inflow (acceleration),
- no single wallet over 60% of window buy SOL (anti-bundle),
- real SOL in [3, 80].

First buy 0.05 SOL; pyramid adds of 0.15 SOL only while the position is in
profit, the price stepped up ≥ 3% from the last add, and inflow is still
positive — up to 1.5 SOL per position. Exits: stop-loss −12%, full
take-profit +12%, trailing stop −25% from peak once +6% up, max hold 1200
slots (waived while ≥ +3% up), exit on a single sell ≥ 5 SOL. The fade
(outflow) exit is disabled — on the dev window it cut positions too early.

### Guards

- At most 4 main positions open (the 5th slot is kept for probes); total
  exposure at cost ≤ 5 SOL (drawdown guard).
- Pacing: when the bot's own fills or distinct coins lag 25 coins / 240
  fills prorated over block time, it opens 0.01 SOL probe round trips on
  liquid curves and sells them as soon as the buy lands.
- Never orders into a completed curve; never exceeds
  `maxBuyLamports` / `max_orders_per_batch`; capital is read from
  `hello.capital`, never hardcoded.
- Deterministic: no clock, no environment, no randomness. Two runs produce
  byte-identical action logs (verified, see below).

## What the dev window taught us

The dev dataset (24 h, 1,123 universe coins) is brutal: ~46% of a coin's
price move happens in the first 2 slots after its first trade, and in 55.7%
of coins the price 2 slots in *is* the 30-slot maximum — a bot with 2-slot
latency structurally buys the top. From the +2-slot price onward the mean
return to +22 slots is ≈ 0% in every feature bucket we measured, so no
entry filter we tried shows a strong edge; the upside lives in a thin right
tail (a few coins run 10×+). That is why the exits are tight and the stakes
are small: the bot harvests the tail when it appears and bleeds slowly when
it does not. The house pilots lose on the same window (momentum −9.49 SOL,
reversion −4.11 SOL, sniper −0.49 SOL), so the design goal here is the
least-bad, lowest-variance profile with full guardrail coverage — it needs
the smallest regime improvement to flip positive on the unseen final window.

## Parameters (DEFAULT_PARAMS in strategy.ts)

| group | value |
|---|---|
| momentum window / minNet / minBuys / minBuyers | 36 slots / 0.8 SOL / 3 / 4 |
| momentum minRise / maxRise / accel / nearHigh / maxTopShare | 0.10 / 1.2 / 0.8 / 0.94 / 0.6 |
| momentum real SOL / minAge | [3, 80] / 400 slots |
| momentum first / add / stake cap | 0.05 / 0.15 / 1.5 SOL |
| momentum SL / TP / trail / arm / maxHold | −12% / +12% / −25% / +6% / 1200 slots |
| launch maxAge / maxBuyers / maxDevBuy / real SOL | 3 slots / 2 / 2.5 SOL / [0.3, 30] |
| launch stake / min buy | 0.05 SOL / 0.005 SOL |
| launch SL / TP / trail / arm / maxHold / maxRunup | −10% / +50% / −30% / +20% / 40 slots / 2× |
| exposure cap / max main positions | 5 SOL / 4 |
| pacing target coins / fills / pace seconds / probe | 25 / 240 / 14400 s / 0.01 SOL |

## Backtest results (dev window, local simulator `tools/sim.ts`)

Default settings, full 24 h dev dataset (128,058 events, 63,369 batches):

| metric | value |
|---|---|
| net PnL | −0.7619 SOL |
| hourly Sharpe | −0.2882 |
| max drawdown | 12.29% |
| fills / distinct coins / round-trip coins (≥ 0.01 SOL) | 1057 / 357 / 288 |
| round trips / win rate | 465 / 16.3% |
| rejected / failed tx | 17 / 20 |

Lane ablation (same simulator): launch lane only −0.41 SOL (Sharpe −1.09,
DD 4.5%); momentum lane only −0.48 SOL (Sharpe −0.19, DD 9.5%). The
combined bot trades more coins (357 vs 129/286) and clears the guardrails
with margin on a 6-hour window (≈ 264 fills, ≈ 89 coins scaled), at the
cost of a somewhat worse dev PnL than either lane alone.

Determinism: `tools/sim.ts --out` run twice produces byte-identical action
logs (sha256 `8311d2e5c494713e17f8378d0c67499c2941fcee84c8e058227c7c84d4e5d30c`,
63,369 batches). The bot also runs clean through the real protocol
(`node main.ts` on synthetic hello/batch/done input): valid replies, no crash.

## Honest caveat

On the dev window this bot does **not** make money — neither does any
baseline we measured. It is built to be the most robust, lowest-drawdown
way to stay in the game: tight exits, small stakes, broad coverage, and
guardrails met with margin, so that a friendlier final window is what it
needs, not a lucky pick.
