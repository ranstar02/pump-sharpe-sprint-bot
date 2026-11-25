// Parameter sweep for the scalper: loads the dev dataset once, runs each
// override set through the local simulator, prints a table sorted by net PnL.
//
//   node tools/sweep.ts
//
// Edit COMBOS below to explore. Each run reuses the loaded dataset.

import { readFileSync } from 'node:fs';
import { loadDataset, simulate, makeHello, devSeed, type SimMetrics } from './sim.ts';
import { createScalper, DEFAULT_PARAMS, type ScalperParams } from '../strategy.ts';

const KIT =
  '/home/hatch/workspace/makefun/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/kit/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532-kit';

const COMBOS: { tag: string; over: Partial<ScalperParams> }[] = [
  { tag: 'base', over: {} },
  { tag: 'no-probes', over: { maxProbes: 0 } },
  { tag: 'no-fade', over: { fadeNetSol: -1000 } },
  { tag: 'no-fade+no-probes', over: { fadeNetSol: -1000, maxProbes: 0 } },
  { tag: 'tp25', over: { takeProfit: 0.25 } },
  { tag: 'tp25+no-fade', over: { takeProfit: 0.25, fadeNetSol: -1000 } },
  { tag: 'tp-off', over: { takeProfit: 1000 } },
  { tag: 'tp-off+no-fade', over: { takeProfit: 1000, fadeNetSol: -1000 } },
  { tag: 'sl08', over: { stopLoss: 0.08 } },
  { tag: 'sl20', over: { stopLoss: 0.2 } },
  { tag: 'sl20+tp25', over: { stopLoss: 0.2, takeProfit: 0.25 } },
  { tag: 'hold300', over: { maxHold: 300 } },
  { tag: 'hold-off', over: { maxHold: 100000 } },
  { tag: 'rise10', over: { minRise: 0.1 } },
  { tag: 'rise10+no-fade', over: { minRise: 0.1, fadeNetSol: -1000 } },
  { tag: 'trail15', over: { trailDrop: 0.15 } },
  { tag: 'net2', over: { minNetSol: 2 } },
  { tag: 'net2+rise10', over: { minNetSol: 2, minRise: 0.1 } },
  { tag: 'age100', over: { minAge: 100 } },
  { tag: 'age1000', over: { minAge: 1000 } },
  { tag: 'win60', over: { entryWindow: 60 } },
  { tag: 'win60+no-fade', over: { entryWindow: 60, fadeNetSol: -1000 } },
];

const ds = loadDataset(KIT);
const kitJson = JSON.parse(readFileSync(`${KIT}/kit.json`, 'utf8'));
const seed = devSeed('u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532', kitJson.dataset_sha256);
const hello = makeHello(seed, KIT);

const rows: { tag: string; r: SimMetrics }[] = [];
for (const c of COMBOS) {
  const params = { ...DEFAULT_PARAMS, ...c.over };
  const r = simulate(ds, hello, createScalper(params));
  rows.push({ tag: c.tag, r });
  console.log(
    `${c.tag.padEnd(20)} pnl ${r.netPnlSol.toFixed(3)} sharpe ${r.sharpeHourly.toFixed(3)} ` +
      `dd ${(r.maxDrawdown * 100).toFixed(1)}% fills ${r.fills} coins ${r.distinctMints} ` +
      `rt ${r.roundTripCoins} trips ${r.trips} win ${(r.trips ? ((r.winningTrips / r.trips) * 100).toFixed(0) : '0')}%`,
  );
}
rows.sort((a, b) => b.r.netPnlSol - a.r.netPnlSol);
console.log('\nbest by PnL: ' + rows.slice(0, 5).map((x) => `${x.tag}(${x.r.netPnlSol.toFixed(2)})`).join(', '));
const bySharpe = [...rows].sort((a, b) => b.r.sharpeHourly - a.r.sharpeHourly);
console.log('best by Sharpe: ' + bySharpe.slice(0, 5).map((x) => `${x.tag}(${x.r.sharpeHourly.toFixed(2)})`).join(', '));
