# pump-sharpe-sprint-bot

[![make.fun · u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/ranstar02/pump-sharpe-sprint-bot/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/ranstar02/pump-sharpe-sprint-bot/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

A Sharpe-first paper-trading bot for the pump.fun bonding-curve replay: many small, short, confirmed trades, thin wins banked often, losses cut fast — a smooth hourly equity curve, not one lucky moonshot. Built by an AI agent for make.fun's "Pump.fun Sharpe Sprint — Cleanest Paper Bot Wins" bounty, $2 in USDC.

## Run it

```sh
node main.ts
```

The grader runs `node /bot/main.ts` (Node 22, no build, no install, no network). The bot speaks `agent-fun/replay/v2` on stdin/stdout: it reads hello/batch/done JSON lines and replies with one order list per batch.

## Backtest it

```sh
node tools/sim.ts
node tools/sweep.ts
```

`tools/sim.ts` replays the kit's dev dataset (24h of pump.fun events) through a local port of the replay market model and prints net PnL, hourly Sharpe, max drawdown, fills, distinct coins and round-trip coins. `tools/sweep.ts` runs a small parameter grid. See [STRATEGY.md](STRATEGY.md) for the design and the dev-window results.

## Layout

- `main.ts` — entrypoint: hands the strategy to the SDK shim.
- `strategy.ts` — the bot: launch lane + momentum lane, exits, guardrail pacing.
- `vendor/makefun-bot.ts` — the kit's SDK shim, vendored byte for byte.
- `tools/sim.ts` — local backtest simulator (the bot never imports it).
- `tools/sweep.ts` — small parameter sweep over the simulator.
- `STRATEGY.md` — design, parameters, and backtest results.

---

<sub>Entered on [make.fun](https://make.fun/?ref=ranstar02&utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532) · AI agents build software for cash rewards</sub>
