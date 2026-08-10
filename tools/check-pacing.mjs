// 節奏量測：一場出擊到底花多少「真實時間」，以及要按多少下。
//
//   node tools/check-pacing.mjs
//
// 模擬器（simulate.mjs）量的是回合數，那是設計指標。
// 但玩家說「慢」通常指的是兩件模擬器量不到的事：
//   1. 牆上時鐘時間 —— 尤其是敵方回合乾等的那幾秒
//   2. 操作次數 —— 每個動作要點幾下才做得完
// 這支在真的瀏覽器裡跑真的主迴圈，兩個都量。

import { chromium } from 'playwright';
import { listen } from '../serve.mjs';

const SEEDED = true;
void SEEDED;
const BATTLES = Number((process.argv.find((a) => a.startsWith('--battles=')) || '').split('=')[1] || 5);

const { server, port } = await listen(0);
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader'] });
const page = await browser.newPage();
await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof window.__game === 'function', null, { timeout: 15000 });
await page.waitForFunction(() => window.__assets && window.__assets().ready, null, { timeout: 20000 }).catch(() => {});

const result = await page.evaluate(async (battles) => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const G = () => window.__game();
  const A = window.game_actions;
  const D = window.__debug;

  const stats = {
    battles: 0,
    turns: 0,
    playerMs: 0,
    aiMs: 0,
    otherScreenMs: 0,
    clicks: { select: 0, mode: 0, target: 0, endTurn: 0, screen: 0 },
    aiUnitsActed: 0,
  };

  // 一個真人在目前的介面下，做一個動作要按幾下
  // 智慧點擊之後不需要切模式，選單位也只有在自動選擇沒幫上忙時才要按
  function countAction(g, unit) {
    if (g.battle.selectedId !== unit.id) stats.clicks.select++;
    stats.clicks.target++;
  }

  // 固定種子，這樣改動前後的數字才可以比
  A.play();
  const el = document.getElementById('seedInput');
  if (el) { el.value = 'pacing-bench'; A.startSeed(); } else { A.startRun(); }

  const t0 = performance.now();

  let guard = 0;
  const deadline = performance.now() + 90000;
  while (stats.battles < battles && guard++ < 2000 && performance.now() < deadline) {
    const g = G();

    if (g.pending.draft) { A.draft(g.pending.draft.cards[0].id); continue; }

    if (g.screen === 'map') {
      const open = g.map.nodes[g.currentNodeId].next;
      // 優先挑戰鬥節點，才量得到戰鬥節奏
      const fight = open.find((id) => ['battle', 'elite'].includes(g.map.nodes[id].type)) || open[0];
      const s = performance.now();
      stats.clicks.screen++;
      A.goNode(fight);
      stats.otherScreenMs += performance.now() - s;
      continue;
    }

    if (g.screen === 'victory') { stats.clicks.screen++; A.victoryClose(); stats.battles++; continue; }
    if (g.screen === 'event') {
      stats.clicks.screen += 2;
      if (!g.pending.event.resolved) A.event(0); else A.eventClose();
      continue;
    }
    if (g.screen === 'shop') { stats.clicks.screen++; A.shopLeave(); continue; }
    if (g.screen === 'supply') {
      stats.clicks.screen += 2;
      if (!g.pending.supply.resolved) A.supply('heal'); else A.supplyClose();
      continue;
    }
    if (g.screen === 'result') break;

    if (g.screen !== 'battle') break;

    const b = g.battle;

    if (b.phase === 'player') {
      const s = performance.now();
      let acted = true;
      let inner = 0;
      while (acted && inner++ < 30) {
        acted = false;
        const mine = b.units.filter((u) => u.alive && u.tm === 'p' && u.ap > 0 && !u.attacked);
        for (const u of mine) {
          const foes = b.units.filter((v) => v.alive && v.tm === 'e');
          if (!foes.length) break;
          const dist = (a, c) => Math.abs(a.x - c.x) + Math.abs(a.y - c.y);
          const inRange = foes.filter((f) => dist(u, f) <= u.rg);
          if (inRange.length) {
            countAction(g, u);
            D.selectUnit(u.id);
            const r = D.tapBoard(inRange[0].x, inRange[0].y);
            if (!r || !r.ok) { u.attacked = 1; u.ap = 0; } else acted = true;
          } else {
            // 往最近的敵人靠
            const target = foes.reduce((p, c) => (dist(u, c) < dist(u, p) ? c : p));
            const step = Math.min(u.ap - 1, dist(u, target) - u.rg);
            if (step > 0) {
              let nx = u.x; let ny = u.y;
              for (let i = 0; i < step; i++) {
                if (ny !== target.y) ny += ny < target.y ? 1 : -1;
                else if (nx !== target.x) nx += nx < target.x ? 1 : -1;
              }
              if (!b.units.some((v) => v.alive && v.x === nx && v.y === ny)) {
                countAction(g, u);
                D.selectUnit(u.id);
                const r2 = D.tapBoard(nx, ny);
                if (!r2 || !r2.ok) u.ap = 0; else acted = true;
              }
            }
          }
          if (G().screen !== 'battle') break;
        }
        if (G().screen !== 'battle') break;
      }
      stats.playerMs += performance.now() - s;
      if (G().screen === 'battle' && G().battle.phase === 'player') {
        stats.clicks.endTurn++;
        stats.turns++;
        A.endturn();
      }
      continue;
    }

    if (b.phase === 'ai') {
      // 敵方回合是真的等，主迴圈每 AI_STEP_MS 才動一個單位
      const s = performance.now();
      const before = b.aiQueue.length;
      stats.aiUnitsActed += before;
      let waited = 0;
      while (G().screen === 'battle' && G().battle.phase === 'ai' && waited < 15000) {
        await sleep(30);
        waited = performance.now() - s;
      }
      stats.aiMs += performance.now() - s;
      continue;
    }

    await sleep(20);
  }

  stats.totalMs = performance.now() - t0;
  return stats;
}, BATTLES);

await browser.close();
server.close();

const sec = (ms) => (ms / 1000).toFixed(1);
const c = result.clicks;
const totalClicks = c.select + c.mode + c.target + c.endTurn + c.screen;

console.log('');
console.log('═══════════════════════════════════════════════════════');
console.log(`  節奏量測   ${result.battles} 場戰鬥、${result.turns} 個我方回合`);
console.log('═══════════════════════════════════════════════════════');
console.log(`  總耗時          ${sec(result.totalMs)} 秒（不含真人思考時間）`);
console.log(`    我方回合      ${sec(result.playerMs)} 秒  ${((result.playerMs / result.totalMs) * 100).toFixed(0)}%`);
console.log(`    敵方回合      ${sec(result.aiMs)} 秒  ${((result.aiMs / result.totalMs) * 100).toFixed(0)}%  ← 玩家只能乾等`);
console.log(`    其他畫面      ${sec(result.otherScreenMs)} 秒`);
console.log('───────────────────────────────────────────────────────');
console.log(`  敵方等待/場    ${sec(result.aiMs / Math.max(1, result.battles))} 秒`);
console.log(`  敵方等待/回合  ${sec(result.aiMs / Math.max(1, result.turns))} 秒`);
console.log(`  敵方行動次數   ${result.aiUnitsActed}`);
console.log('───────────────────────────────────────────────────────');
console.log(`  總點擊數       ${totalClicks} 下`);
console.log(`    選單位        ${c.select}`);

console.log(`    點目標        ${c.target}`);
console.log(`    結束回合      ${c.endTurn}`);
console.log(`    其他畫面      ${c.screen}`);
console.log(`  每回合點擊     ${(totalClicks / Math.max(1, result.turns)).toFixed(1)} 下`);
console.log('═══════════════════════════════════════════════════════');
