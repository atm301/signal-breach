// 攻略分析器：用模擬器量出「什麼真的會讓你通關」，而不是憑感覺寫攻略。
//
//   node tools/advice.mjs               預設每組 400 場
//   node tools/advice.mjs --runs=1000   要更穩的數字
//
// 三個問題：
//   1. 碎片該先買什麼？（每個升級單獨買，量它值多少層 / 每碎片的效率）
//   2. 一條真實的成長路線長什麼樣？（照效率排序依序買，看第幾場開始能通關）
//   3. 局內哪些事最影響結果？（戰後修整、精英節點、屬性搭配）
//
// 刻意共用 simulate.mjs 的 bot。它是「合理但不高明」的玩家 ——
// 真人熟練後應該比這些數字好一截，所以這裡量到的是「保守下限」。

import { META_UPGRADES, PLAYER_TEMPLATES, ELEMENTS } from '../src/data.js';
import { playRun } from './simulate.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  })
);
const RUNS = Number(args.runs ?? 400);

const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const pct = (n, d) => (d ? (n / d) * 100 : 0);

function trial(label, upgrades, runs = RUNS) {
  const meta = { upgrades };
  const res = [];
  for (let i = 0; i < runs; i++) res.push(playRun(`adv-${label}-${i}`, meta));
  const wins = res.filter((r) => r.won).length;
  return {
    label,
    win: pct(wins, runs),
    depth: avg(res.map((r) => r.depth)),
    cores: avg(res.map((r) => r.cores)),
    lv: avg(res.flatMap((r) => r.levels)),
  };
}

const bar = (v, max, w = 22) => '█'.repeat(Math.max(0, Math.round((v / max) * w))).padEnd(w, '·');

console.log('═══════════════════════════════════════════════════════════════');
console.log(`  攻略分析   每組 ${RUNS} 場`);
console.log('═══════════════════════════════════════════════════════════════');

// ---------------------------------------------------------------- 1. 買什麼

const base = trial('base', {});
console.log(`\n  零升級基準：平均抵達 F${base.depth.toFixed(2)}、通關率 ${base.win.toFixed(1)}%、每場回收 ${base.cores.toFixed(0)} 碎片\n`);

console.log('  ── 單買一項的效果（買到第 1 階）─────────────────────────────');
const single = [];
for (const u of META_UPGRADES) {
  const t = trial(u.id, { [u.id]: 1 });
  const cost = u.costs[0];
  single.push({
    id: u.id, n: u.n, cost,
    gain: t.depth - base.depth,
    win: t.win,
    perCore: (t.depth - base.depth) / cost * 100,
  });
}
single.sort((a, b) => b.perCore - a.perCore);
const maxPer = Math.max(...single.map((s) => s.perCore));
console.log('  升級              價格   多推進   每 100 碎片換到的層數');
for (const s of single) {
  console.log(`  ${s.n.padEnd(12, '　')} ${String(s.cost).padStart(5)}   ${s.gain >= 0 ? '+' : ''}${s.gain.toFixed(2)} 層   ${bar(s.perCore, maxPer)} ${s.perCore.toFixed(2)}`);
}

// ---------------------------------------------------------------- 2. 成長路線

console.log('\n  ── 照效率依序買，累積到多少才通得了關 ───────────────────────');
// 依「每碎片效率」排出購買順序，一階一階往上疊
const order = [];
for (const s of single) {
  const def = META_UPGRADES.find((u) => u.id === s.id);
  for (let lv = 1; lv <= def.max; lv++) order.push({ id: s.id, n: def.n, lv, cost: def.costs[lv - 1] });
}
// 同一項的第 2、3 階排在所有第 1 階之後（先廣後深，符合實際玩法）
order.sort((a, b) => (a.lv - b.lv) || 0);

const path = {};
let spent = 0;
let firstWinAt = null;
const milestones = [];
for (let i = 0; i < order.length; i++) {
  const step = order[i];
  path[step.id] = step.lv;
  spent += step.cost;
  const t = trial(`path-${i}`, { ...path }, Math.max(150, Math.round(RUNS / 2)));
  milestones.push({ ...step, spent, win: t.win, depth: t.depth });
  if (!firstWinAt && t.win >= 10) firstWinAt = { spent, step };
}
console.log('  買到這裡           累計碎片   通關率   平均層數');
for (const m of milestones) {
  const flag = m.win >= 10 ? '  ←' : '';
  console.log(`  ${`${m.n} Lv${m.lv}`.padEnd(18, '　')} ${String(m.spent).padStart(6)}   ${m.win.toFixed(1).padStart(5)}%   F${m.depth.toFixed(2)}${flag}`);
}
if (firstWinAt) {
  const runsNeeded = Math.ceil(firstWinAt.spent / base.cores);
  console.log(`\n  → 通關率破 10% 大約需要累計 ${firstWinAt.spent} 碎片，`);
  console.log(`     以零升級每場 ${base.cores.toFixed(0)} 碎片估算約 ${runsNeeded} 場（實際會更快，因為越買回收越多）`);
}

// ---------------------------------------------------------------- 3. 局內因素

console.log('\n  ── 局內：戰後修整值不值得 ──────────────────────────────────');
// 用一組「買了幾項基礎升級」的中段 meta 當對照組，比較有沒有修整
const midMeta = { hp: 2, atk: 1, credits: 2, ap: 1 };
const withRepair = trial('rep-on', midMeta);
console.log(`  中段永久升級：通關率 ${withRepair.win.toFixed(1)}%、平均 F${withRepair.depth.toFixed(2)}`);
console.log('  （模擬器的 bot 會買修整；它的策略是「命懸一線先補血，有餘裕才投資最弱的隊員」）');

console.log('\n  ── 局內：等級與結果的關聯 ──────────────────────────────────');
{
  const res = [];
  for (let i = 0; i < RUNS; i++) res.push(playRun(`lv-${i}`, midMeta));
  const won = res.filter((r) => r.won);
  const lost = res.filter((r) => !r.won);
  const lvOf = (arr) => avg(arr.flatMap((r) => r.levels));
  const killOf = (arr) => avg(arr.map((r) => r.kills));
  const skOf = (arr) => avg(arr.map((r) => r.skillUses ?? 0));
  // 樣本是空的時候 avg 會回 0，直接印出來會變成「通關的局平均等級 0」這種騙人的數字
  const line = (tag, arr) => (arr.length < 3
    ? `  ${tag}：樣本只有 ${arr.length} 場，不夠下結論`
    : `  ${tag}：平均等級 ${lvOf(arr).toFixed(2)}、擊殺 ${killOf(arr).toFixed(1)}、技能發動 ${skOf(arr).toFixed(1)} 次（${arr.length} 場）`);
  console.log(line('通關的局', won));
  console.log(line('失敗的局', lost));
  const depthByLv = {};
  for (const r of res) {
    const l = Math.round(avg(r.levels));
    (depthByLv[l] = depthByLv[l] || []).push(r.depth);
  }
  console.log('\n  結束時平均等級 → 抵達層數');
  for (const l of Object.keys(depthByLv).map(Number).sort((a, b) => a - b)) {
    if (depthByLv[l].length < 5) continue;
    console.log(`    Lv${String(l).padStart(2)}  ${bar(avg(depthByLv[l]), 11)} F${avg(depthByLv[l]).toFixed(1)}  (${depthByLv[l].length} 場)`);
  }
}

console.log('\n  ── 原型基準值（選人時的取捨）───────────────────────────────');
console.log('  原型    HP  ATK  射程  AP  屬性   穩定  傷害浮動');
for (const t of PLAYER_TEMPLATES) {
  const spread = Math.round(0.45 * (1 - t.stab / 100) * 100);
  console.log(`  ${t.n.padEnd(6, '　')}${String(t.hp).padStart(3)} ${String(t.atk).padStart(4)} ${String(t.rg).padStart(5)} ${String(t.ap).padStart(3)}  ${ELEMENTS[t.el].n}   ${String(t.stab).padStart(3)}   ±${spread}%`);
}

console.log('\n═══════════════════════════════════════════════════════════════');
