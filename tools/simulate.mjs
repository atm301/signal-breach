// 玩法評估器：在 node 裡用機器人跑完整的 run，統計勝率、深度分佈、回合長度。
//
// 「單元測試全綠但遊戲根本不好玩」是 AI 輔助開發最典型的失敗模式。
// 這支腳本就是用來擋那個的：改完任何數值都要跑一次，看指標有沒有跑出區間。
//
//   node tools/simulate.mjs                 預設 300 場、meta 全零
//   node tools/simulate.mjs --runs=1000     跑更多場
//   node tools/simulate.mjs --meta=max      模擬永久升級點滿的老玩家
//   node tools/simulate.mjs --verbose       逐場輸出

import {
  createGame, enterNode, availableNodes, aliveOf, squadAlive,
  attackUnit, moveUnit, endPlayerTurn, runEnemyPhase, reachableTiles,
  damageOf, damageBreakdown, faceToward, dist, key, pickDraftCard, chooseEventOption, closeEvent,
  buyShopItem, leaveShop, chooseSupply, closeSupply, closeVictory,
  repairOptions, buyRepair, setFocus,
  skillsOf, skillState, validSkillTiles, castSkill,
} from '../src/engine.js';
import { META_UPGRADES, TUNE, FLOORS } from '../src/data.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------- 參數

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  })
);

const RUNS = Number(args.runs ?? 300);
const VERBOSE = !!args.verbose;
const META_MODE = args.meta ?? 'none';

// --drop=a,b 會把這幾個永久升級歸零。
// 用來量「單一升級到底貢獻幾個百分點」——
// 三個新升級一起加下去把通關率從 47% 推到 79%，不拆開量就只能亂猜是誰的問題。
const DROP = String(args.drop ?? '').split(',').filter(Boolean);
const DEPTH = Number(args.depth ?? 0); // 威脅等級：驗證階梯是不是單調變難

function metaFor(mode) {
  const lvl = (u) => {
    if (DROP.includes(u.id)) return 0;
    if (mode === 'max') return u.max;
    if (mode === 'mid') return Math.ceil(u.max / 2);
    return 0;
  };
  if (mode !== 'max' && mode !== 'mid') return { upgrades: {} };
  return { upgrades: Object.fromEntries(META_UPGRADES.map((u) => [u.id, lvl(u)])) };
}

// ---------------------------------------------------------------- 機器人玩家
// 刻意寫成「一個普通玩家會做的合理選擇」，不是最佳解。
// 太強的機器人會讓數值看起來比實際好玩時容易。

function hpRatio(g) {
  const alive = squadAlive(g);
  if (!alive.length) return 0;
  return alive.reduce((s, u) => s + u.hp / u.mhp, 0) / alive.length;
}

// 假設站在 (x,y) 面向目標會打出多少（含相剋與側背）。借位後一定要還原。
function projected(g, u, target, x, y) {
  const ox = u.x; const oy = u.y; const ofx = u.faceX; const ofy = u.faceY;
  u.x = x; u.y = y;
  faceToward(u, target.x, target.y);
  const b = damageBreakdown(g, u, target);
  u.x = ox; u.y = oy; u.faceX = ofx; u.faceY = ofy;
  return b;
}

function bestPlayerMove(g, u, foes) {
  const tiles = reachableTiles(g, u);
  if (!tiles.length) return null;
  let best = null;

  for (const tile of tiles) {
    const remaining = u.ap - tile.cost;
    let minDist = Infinity;
    let bestDmg = 0;
    let canKill = false;
    for (const f of foes) {
      const d = dist(tile.x, tile.y, f.x, f.y);
      if (d < minDist) minDist = d;
      if (d <= u.rg && remaining >= 1) {
        const b = projected(g, u, f, tile.x, tile.y);
        if (b.mid > bestDmg) bestDmg = b.mid;
        if (b.min >= f.hp) canKill = true; // 只認保證擊殺，不賭浮動
      }
    }
    const canShoot = minDist <= u.rg && remaining >= 1;

    let score = 0;
    if (canKill) score += 160;
    // 繞到相剋／側背吃得到加成的位置，值得多走幾步
    if (canShoot) score += 90 + remaining * 5 + bestDmg * 4;
    score -= minDist * 4;
    if (g.battle.cover.has(key(tile.x, tile.y))) score += u.rg >= 2 ? 12 : 5;
    if (u.rg >= 2 && minDist <= 1) score -= 14; // 狙擊不想被貼身

    if (!best || score > best.score) best = { ...tile, score };
  }
  return best;
}

// 一次呼叫做一個動作（移動或攻擊）。攻擊每回合限一次，所以打完這個單位就結束了。
// 技能決策。bot 不必打得高明，但一定要「會用」——
// 不用的話量到的是一個沒有技能系統的遊戲，那份平衡報告等於在描述別款遊戲。
function botSkill(g, u) {
  const foes = aliveOf(g, 'e');
  const mates = aliveOf(g, 'p');
  for (const id of skillsOf(u)) {
    const st = skillState(g, u, id);
    if (!st.ok) continue;
    const tiles = validSkillTiles(g, u, id);
    if (!tiles.length) continue;

    if (id === 'patch') {
      // 只在有人真的傷得重的時候補，不然浪費一次冷卻
      const hurt = mates.filter((m) => m.hp <= m.mhp * 0.55)
        .filter((m) => tiles.some((t) => t.x === m.x && t.y === m.y))
        .sort((a, b) => a.hp / a.mhp - b.hp / b.mhp)[0];
      if (hurt) { castSkill(g, u, id, hurt.x, hurt.y); return true; }
      continue;
    }
    if (id === 'shockwave') {
      // 至少要打到兩隻才划算，只打一隻不如normal攻擊
      const hit = foes.filter((f) => dist(u.x, u.y, f.x, f.y) <= 1).length;
      if (hit >= 2) { castSkill(g, u, id, u.x, u.y); return true; }
      continue;
    }
    if (id === 'jam') {
      // 優先干擾打得最痛的那一隻
      const t = foes.filter((f) => tiles.some((p) => p.x === f.x && p.y === f.y))
        .sort((a, b) => b.atk - a.atk)[0];
      if (t) { castSkill(g, u, id, t.x, t.y); return true; }
      continue;
    }
    if (id === 'mark') {
      // 標記血最多的那隻：標記是為了幫全隊打掉硬目標
      const t = foes.filter((f) => tiles.some((p) => p.x === f.x && p.y === f.y))
        .filter((f) => !(f.st?.marked > 0))
        .sort((a, b) => b.hp - a.hp)[0];
      if (t) { castSkill(g, u, id, t.x, t.y); return true; }
      continue;
    }
    if (id === 'charge') {
      // 打不到人的時候才衝：衝了等於一次移動加一次強化攻擊
      const reachable = foes.some((f) => dist(u.x, u.y, f.x, f.y) <= u.rg);
      if (reachable) continue;
      const t = foes.filter((f) => tiles.some((p) => p.x === f.x && p.y === f.y))
        .sort((a, b) => a.hp - b.hp)[0];
      if (t) { castSkill(g, u, id, t.x, t.y); return true; }
      continue;
    }
    // blink：只在完全搆不到、而且傳送過去就能打的時候用
    if (id === 'blink') {
      if (foes.some((f) => dist(u.x, u.y, f.x, f.y) <= u.rg)) continue;
      const spot = tiles
        .filter((p) => foes.some((f) => dist(p.x, p.y, f.x, f.y) <= u.rg))
        .sort((a, b) => a.x - b.x)[0];
      if (spot) { castSkill(g, u, id, spot.x, spot.y); return true; }
    }
  }
  return false;
}

function botActUnit(g, u) {
  const foes = aliveOf(g, 'e');
  if (!foes.length || u.ap <= 0) return false;

  if (botSkill(g, u)) return true;
  if (u.attacked) return false;

  const inRange = foes.filter((f) => dist(u.x, u.y, f.x, f.y) <= u.rg);
  if (inRange.length) {
    // 優先順序：保證擊殺 > 有機會擊殺 > 打得最痛的（相剋與側背都算進去了）
    const scored = inRange.map((f) => ({ f, b: damageBreakdown(g, u, f) }));
    const sure = scored.filter((s) => s.b.min >= s.f.hp);
    const maybe = scored.filter((s) => s.b.max >= s.f.hp);
    const pool = sure.length ? sure : maybe.length ? maybe : scored;
    const target = pool.sort((a, b) => b.b.mid - a.b.mid)[0].f;
    attackUnit(g, u, target);
    return true;
  }

  const move = bestPlayerMove(g, u, foes);
  if (move && move.cost <= u.ap) {
    moveUnit(g, u, move.x, move.y);
    return true;
  }
  return false;
}

function botDraft(g) {
  const d = g.pending.draft;
  if (!d) return;
  // ⚠️ ATK 必須排第一。
  //
  // 這裡原本把 ul / sp2 / sp / cool / ap / rg 全部排在 atk 前面，理由是
  // 「技能樹開得越快手段越多」。實測那個直覺錯得離譜：
  // 光是把 atk 提到第一順位，永久升級點滿的通關率就從 48.2% 跳到 97.2%。
  //
  // 原因是攻擊每回合只有一次，所以 ATK 直接就是這一回合的輸出上限；
  // 而技能點、射程、冷卻都只是「更多選擇」，換不到等量的傷害。
  //
  // 這個 bug 還連帶製造了一個假結論：因為 bot 老是挑爛卡，
  // 「情報網（4 選 1）」看起來會讓通關率掉 16 個百分點 —— 選項變多只是讓它更常挑錯。
  // 修好之後那個懲罰就消失了（97.2% vs 95.3%，在雜訊內）。
  //
  // 教訓：bot 可以不高明，但不能在「唯一最重要的決策」上系統性地做錯，
  // 否則整份平衡報告都是在描述另一款遊戲。
  const priority = ['atk', 'ul', 'ap', 'sp2', 'sp', 'cool', 'rg', 'stab', 'mhp'];
  const sorted = d.cards.slice().sort((a, b) => priority.indexOf(a.id) - priority.indexOf(b.id));
  pickDraftCard(g, sorted[0].id);
}

function botChooseNode(g) {
  const open = availableNodes(g);
  if (!open.length) return false;
  const hurt = hpRatio(g) < 0.6;

  const weight = (n) => {
    if (n.type === 'boss') return 100;
    if (n.type === 'supply') return hurt ? 90 : 40;
    if (n.type === 'shop') return g.credits >= 60 ? 60 : 25;
    if (n.type === 'event') return 45;
    if (n.type === 'elite') return hurt ? 10 : 55; // 有血才敢吃精英
    return 50;
  };
  const best = open.reduce((a, b) => (weight(b) > weight(a) ? b : a));
  return enterNode(g, best.id);
}

function botEvent(g) {
  const ev = g.pending.event;
  if (!ev) return;
  if (ev.resolved) { closeEvent(g); return; }
  const hurt = hpRatio(g) < 0.6;
  // 受傷就找回血的選項，否則挑第一個負擔得起的
  let index = ev.opts.findIndex((o) => {
    const heals = (o.fx || []).some((f) => f.t === 'heal' || f.t === 'healFull' || f.t === 'healPct');
    return hurt && heals && (!o.cost || g.credits >= o.cost);
  });
  if (index < 0) index = ev.opts.findIndex((o) => !o.cost || g.credits >= o.cost);
  if (index < 0) index = ev.opts.length - 1;
  chooseEventOption(g, index);
}

function botShop(g) {
  const shop = g.pending.shop;
  if (!shop) return;
  let bought = true;
  let guard = 0;
  while (bought && guard++ < 8) {
    bought = false;
    const affordable = shop.items
      .map((it, i) => ({ it, i }))
      .filter(({ it }) => !it.sold && it.price <= g.credits)
      .sort((a, b) => a.it.price - b.it.price);
    if (affordable.length) {
      buyShopItem(g, affordable[0].i);
      bought = true;
    }
  }
  leaveShop(g);
}

// 戰後修整。bot 的花錢順序要接近一個「還算會玩」的玩家，
// 否則模擬出來的通關率是沒人達得到的地板值：
// 命懸一線先補血 → 有餘裕再把錢投在最弱的那個人身上。
function botRepair(g) {
  let guard = 0;
  while (guard++ < 10) {
    const opts = repairOptions(g).filter((o) => o.ok);
    if (!opts.length) break;

    const hurt = hpRatio(g) < 0.6;
    const patch = opts.find((o) => o.id === 'patch');
    if (hurt && patch) { buyRepair(g, 'patch'); continue; }

    // 沒受重傷就把錢存下來，只在明顯有剩的時候投資
    const spare = g.credits - 60;
    const invest = ['gun', 'servo', 'calibrate']
      .map((id) => opts.find((o) => o.id === id))
      .find((o) => o && o.cost <= spare);
    if (invest) {
      // 投資投在最弱的隊員身上（ATK 最低），focusUnit 讀的是 focusId
      const weakest = g.squad.filter((u) => u.alive).sort((a, b) => a.atk - b.atk)[0];
      if (weakest) setFocus(g, weakest.id);
      buyRepair(g, invest.id);
      continue;
    }
    if (patch) { buyRepair(g, 'patch'); continue; }
    break;
  }
}

function botSupply(g) {
  const sup = g.pending.supply;
  if (!sup) return;
  if (sup.resolved) { closeSupply(g); return; }
  chooseSupply(g, hpRatio(g) < 0.7 ? 'heal' : 'card');
}

function botBattle(g) {
  const b = g.battle;
  if (!b) return;
  if (b.phase === 'ai') { runEnemyPhase(g); return; }
  if (b.phase !== 'player') return;

  let guard = 0;
  while (g.battle?.phase === 'player' && guard++ < 24) {
    if (g.pending.draft) { botDraft(g); continue; }
    const mine = aliveOf(g, 'p').filter((u) => u.ap > 0 && !u.attacked);
    if (!mine.length) break;
    let acted = false;
    for (const u of mine) {
      if (botActUnit(g, u)) acted = true;
      if (g.battle?.phase !== 'player') break;
    }
    if (!acted) break;
  }
  if (g.battle?.phase === 'player') endPlayerTurn(g);
}

// ---------------------------------------------------------------- 跑一場

function playRun(seed, meta) {
  const g = createGame({ seed, meta, depth: DEPTH });
  let guard = 0;

  while (g.screen !== 'result' && guard++ < 600) {
    if (g.pending.draft) { botDraft(g); continue; }
    switch (g.screen) {
      case 'map': if (!botChooseNode(g)) return { ...summarize(g), stuck: true }; break;
      case 'battle': botBattle(g); break;
      case 'victory': botRepair(g); closeVictory(g); break;
      case 'event': botEvent(g); break;
      case 'shop': botShop(g); break;
      case 'supply': botSupply(g); break;
      default: return { ...summarize(g), stuck: true };
    }
  }
  return { ...summarize(g), stuck: g.screen !== 'result' };
}

function summarize(g) {
  const r = g.result;
  return {
    won: !!r?.won,
    depth: r?.depth ?? g.stats.depth,
    kills: r?.kills ?? g.stats.kills,
    battles: r?.battles ?? g.stats.battles,
    turns: r?.turns ?? g.stats.turns,
    cores: r?.cores ?? 0,
    credits: g.credits,
    levels: g.squad.map((u) => u.lv),
    unlocks: g.squad.map((u) => Object.keys(u.ul).length),
    skillUses: g.stats.skillUses ?? 0,
  };
}

// ---------------------------------------------------------------- 統計

const pct = (n, d) => (d ? ((n / d) * 100).toFixed(1) : '0.0');
const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);

function median(arr) {
  if (!arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function histogram(values, max) {
  const counts = new Array(max + 1).fill(0);
  for (const v of values) counts[Math.min(max, Math.max(0, v))]++;
  return counts;
}

function bar(n, total, width = 28) {
  const filled = total ? Math.round((n / total) * width) : 0;
  return '█'.repeat(filled).padEnd(width, '·');
}

// ---------------------------------------------------------------- 主程式

const meta = metaFor(META_MODE);
// 給 tools/advice.mjs 重用。
// 刻意共用同一份 bot：兩份實作一定會漂移，那樣算出來的攻略是在講另一個遊戲。
export { playRun, metaFor };

// 被 import 的時候不要跑 300 場統計
const RUN_AS_MAIN = process.argv[1]
  && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (!RUN_AS_MAIN) {
  // 匯出用途，主程式整段跳過
} else {

const results = [];
const t0 = Date.now();

for (let i = 0; i < RUNS; i++) {
  const res = playRun(`sim-${META_MODE}-${i}`, meta);
  results.push(res);
  if (VERBOSE) {
    console.log(`#${String(i).padStart(4)} ${res.won ? 'WIN ' : 'LOSE'} F${res.depth} kills=${res.kills} turns=${res.turns} lv=${res.levels.join('/')}`);
  }
}

const elapsed = Date.now() - t0;
const wins = results.filter((r) => r.won).length;
const stuck = results.filter((r) => r.stuck).length;
const depths = results.map((r) => r.depth);
const turnsPerBattle = results.filter((r) => r.battles > 0).map((r) => r.turns / r.battles);

console.log('');
console.log('═══════════════════════════════════════════════════════');
console.log(`  玩法評估報告   場次 ${RUNS}   meta=${META_MODE}   耗時 ${elapsed}ms`);
console.log('═══════════════════════════════════════════════════════');
console.log(`  通關率          ${pct(wins, RUNS)}%   (${wins}/${RUNS})`);
console.log(`  平均抵達層數    ${avg(depths).toFixed(2)} / ${FLOORS - 1}`);
console.log(`  中位數層數      ${median(depths)}`);
console.log(`  平均擊殺        ${avg(results.map((r) => r.kills)).toFixed(1)}`);
console.log(`  平均戰鬥場次    ${avg(results.map((r) => r.battles)).toFixed(1)}`);
console.log(`  每場平均回合    ${avg(turnsPerBattle).toFixed(2)}  (上限 ${TUNE.TURN_LIMIT})`);
console.log(`  平均碎片收入    ${avg(results.map((r) => r.cores)).toFixed(1)}`);
console.log(`  結束時等級      ${avg(results.flatMap((r) => r.levels)).toFixed(2)}`);
console.log(`  技能樹解鎖數    ${avg(results.flatMap((r) => r.unlocks)).toFixed(2)} / 5`);
console.log(`  技能發動次數    ${avg(results.map((r) => r.skillUses)).toFixed(1)} /場`);
if (stuck) console.log(`  ⚠ 卡住的場次     ${stuck}  （流程有 bug，必須先修）`);
console.log('───────────────────────────────────────────────────────');
console.log('  死亡 / 結束層數分佈');

const hist = histogram(depths, FLOORS - 1);
hist.forEach((n, floor) => {
  if (n === 0 && floor > 0 && floor < FLOORS - 1 && hist.slice(floor).every((v) => v === 0)) return;
  const tag = floor === FLOORS - 1 ? 'BOSS' : `F${floor}`;
  console.log(`  ${tag.padStart(5)} ${bar(n, RUNS)} ${String(n).padStart(4)}  ${pct(n, RUNS)}%`);
});
console.log('═══════════════════════════════════════════════════════');

// 健康檢查：這些是「遊戲壞掉」的訊號，不是「難度偏好」
const problems = [];
if (stuck > 0) problems.push(`有 ${stuck} 場流程卡住`);
if (avg(turnsPerBattle) > TUNE.TURN_LIMIT * 0.8) problems.push('平均回合數逼近上限，戰鬥拖太久');
if (avg(turnsPerBattle) < 2) problems.push('平均回合數低於 2，戰鬥瞬間結束沒有決策空間');
if (hist[1] / RUNS > 0.25) problems.push('超過 25% 在第一層就結束，開場太難');
if (wins / RUNS > 0.85) problems.push('通關率超過 85%，缺乏挑戰');
// meta=none 是「第一次玩、零永久升級」的狀態，通關率本來就該接近 0。
// 但升到頂還是通不了關，就代表最終關卡設計壞了。
if (META_MODE === 'max' && wins / RUNS < 0.2) problems.push('永久升級點滿仍打不過，Boss 或後期曲線過硬');
if (META_MODE === 'max' && wins / RUNS > 0.7) problems.push('永久升級點滿後過於輕鬆');
if (META_MODE === 'none' && avg(depths) < 3) problems.push('新玩家平均活不過 3 層，開局太勸退');

if (problems.length) {
  console.log('  ⚠ 需要處理：');
  for (const p of problems) console.log(`     - ${p}`);
  console.log('═══════════════════════════════════════════════════════');
  process.exitCode = 1;
} else {
  console.log('  ✓ 沒有偵測到結構性問題');
  console.log('═══════════════════════════════════════════════════════');
}

} // RUN_AS_MAIN
