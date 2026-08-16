// 「多流派」到底有沒有真的變多？
//
//   node tools/check-builds.mjs [每條路的場次]
//
// ⚠️ 對照組不能用「不選準則」：選準則已經是必經步驟，
// 不選的話 enterNode 會擋住，整場卡在第 0 層 —— 量到的會是一堆空 run。
// 所以對照組改成「一直走同一條準則」，問的問題也更準：
//   換準則會看到新東西，還是換湯不換藥？
//
// 單一準則內的組合數會低於聯集，這是預期的（卡池被偏向了 = 識別度）。
// 要看的是聯集有沒有明顯大於「單一準則跑一樣多場」。
import { META_UPGRADES } from '../src/data.js';
import { playRun } from './simulate.mjs';

const META = { upgrades: Object.fromEntries(META_UPGRADES.map((u) => [u.id, Math.ceil(u.max / 2)])) };
const N = Number(process.argv[2] ?? 250);
const DOCS = ['blitz', 'phalanx', 'overwatch', 'resonance'];

// 簽章要同時含等級分佈與拿到的改玩法卡。
// 只看等級的話，兩局各拿到完全不同的六張卡也會被算成同一種 ——
// 第一版就是這樣寫的，量出「0.97x 沒變多」這種一定是錯的結論。
const sig = (r) => [...r.levels].sort((a, b) => b - a).join('/') + '|' + [...(r.modIds ?? [])].sort().join(',');

const solo = new Set();
for (let i = 0; i < N * DOCS.length; i++) solo.add(sig(playRun(`solo-${i}`, META, DOCS[0])));

const union = new Set();
const per = {};
for (const d of DOCS) {
  const s = new Set();
  for (let i = 0; i < N; i++) { const k = sig(playRun(`x-${d}-${i}`, META, d)); s.add(k); union.add(k); }
  per[d] = s.size;
}

console.log(`每條路各 ${N} 場、對照組（只走 ${DOCS[0]}）${N * DOCS.length} 場 —— 場次相同才比得了`);
console.log('單一準則內  ', DOCS.map((d) => `${d}=${per[d]}`).join('  '));
console.log(`對照組      ${solo.size} 種`);
console.log(`四條路聯集  ${union.size} 種   ${(union.size / solo.size).toFixed(2)}x`);
console.log(union.size / solo.size < 1.5
  ? '⚠ 聯集沒有明顯大於單走一條 —— 準則之間長得太像'
  : '✓ 換準則真的會看到不一樣的東西');
