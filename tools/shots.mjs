// 視覺驗證：把各個畫面截圖存到 test-output/shots/。
// 自動化測試只能驗「邏輯對不對」，驗不了「畫面有沒有壞」，所以這支要人眼看。
//   node tools/shots.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { listen } from '../serve.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(ROOT, 'test-output', 'shots');
fs.mkdirSync(outDir, { recursive: true });

const { server, port } = await listen(0);
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof window.__game === 'function');
// 等素材載完再截圖，否則截到的是程式繪製的備援畫面
await page.waitForFunction(() => window.__assets && window.__assets().ready, null, { timeout: 15000 }).catch(() => {});

const shot = async (name) => {
  await page.waitForTimeout(180);
  await page.screenshot({ path: path.join(outDir, `${name}.png`) });
  console.log(`  ✓ ${name}.png`);
};

console.log('截圖中：');

// 0) 開場畫面
await shot('0-title');

// 0b) 作者的話
await page.evaluate(() => window.game_actions.credits());
await shot('0b-credits');

// 0c) 有存檔時的開場畫面（「繼續這場出擊」那張卡）
await page.evaluate(() => {
  window.game_actions.titleBack();
  window.game_actions.startRun();
  const g = window.__game();
  window.game_actions.goNode(g.map.nodes[g.currentNodeId].next[0]);
});
await page.waitForTimeout(350); // 等自動存檔
await page.evaluate(() => { window.__game().screen = 'title'; window.__debug.refreshTitleSave(); });
await shot('0c-title-with-save');

// 1) 大廳
await page.evaluate(() => window.game_actions.play());
await shot('1-hub');

// 2) 有碎片可花的大廳（驗證購買按鈕的啟用樣式）
await page.evaluate(() => {
  const m = window.__meta();
  m.cores = 500;
  window.game_actions.buy('hp');
});
await shot('2-hub-upgrades');

// 3) 關卡樹
await page.evaluate(() => {
  const el = document.getElementById('seedInput');
  if (el) el.value = 'screenshot-demo';
  window.game_actions.startSeed();
});
await shot('3-map');

// 4) 戰鬥中（走幾步讓單位散開、放個特效）
await page.evaluate(() => {
  const g = window.__game();
  const first = g.map.nodes[g.currentNodeId].next.find((id) => {
    const t = g.map.nodes[id].type;
    return t === 'battle' || t === 'elite';
  }) || g.map.nodes[g.currentNodeId].next[0];
  window.game_actions.goNode(first);
});
await page.evaluate(() => {
  const g = window.__game();
  if (g.screen !== 'battle') return;
  const mine = g.battle.units.filter((u) => u.alive && u.tm === 'p');
  mine.forEach((u, i) => { u.y = 3 - (i % 2); u.x = i + 1; });
  g.battle.actionMode = 'move';
  g.battle.selectedId = mine[0]?.id;
});
await shot('4-battle');

// 5) 攻擊模式：一名單位已出手（應該看到右上角橫槓），另一名還能打
await page.evaluate(() => {
  const g = window.__game();
  if (g.screen !== 'battle') return;
  const mine = g.battle.units.filter((u) => u.alive && u.tm === 'p');
  if (mine[1]) { mine[1].attacked = 1; mine[1].ap = Math.max(0, mine[1].ap - 1); }
  g.battle.actionMode = 'attack';
  g.battle.selectedId = mine[0]?.id;
  // 把一個敵人拉進射程，讓射程提示畫得出來
  const foe = g.battle.units.find((u) => u.alive && u.tm === 'e');
  if (foe && mine[0]) { foe.x = mine[0].x; foe.y = Math.max(0, mine[0].y - mine[0].rg); }
});
await shot('5-battle-attacked-marker');

// 5b) 損傷狀態：把場上單位的 HP 調到三個不同區間，確認素材真的會換
await page.evaluate(() => {
  const g = window.__game();
  if (g.screen !== 'battle') return;
  const all = g.battle.units.filter((u) => u.alive);
  // 依序做出 完好 > 66% / 受損 33-66% / 重創 < 33%
  const ratios = [1.0, 0.5, 0.2];
  all.forEach((u, i) => {
    u.hp = Math.max(1, Math.round(u.mhp * ratios[i % ratios.length]));
    u.attacked = 0;
  });
  g.battle.actionMode = 'move';
});
await shot('5b-damage-states');

// 6) 升級抽卡面板
await page.evaluate(() => {
  const g = window.__game();
  const u = g.squad[0];
  u.lv = 3;
  window.__debug.queueDraft(u.id, 'levelup');
});
await shot('6-draft');

// 6b) 通關結算：把敵人全部打掉，看勝利畫面
await page.evaluate(() => {
  const g = window.__game();
  if (g.pending.draft) window.game_actions.draft(g.pending.draft.cards[0].id);
  if (g.screen !== 'battle') return;
  const mine = g.battle.units.find((u) => u.alive && u.tm === 'p');
  const foes = g.battle.units.filter((u) => u.alive && u.tm === 'e');
  // 留最後一隻讓玩家的攻擊真的觸發勝利流程，其餘直接判死
  foes.slice(1).forEach((f) => { f.hp = 0; f.alive = 0; });
  const last = foes[0];
  if (last && mine) {
    last.hp = 1;
    last.x = mine.x;
    last.y = Math.max(0, mine.y - Math.min(mine.rg, mine.y));
    mine.attacked = 0;
    mine.ap = mine.map;
    g.battle.selectedId = mine.id;
    g.battle.actionMode = 'attack';
    window.__game().battle.phase = 'player';
    window.tapBoardForShot?.();
  }
});
await page.evaluate(() => {
  const g = window.__game();
  const last = g.battle?.units.find((u) => u.alive && u.tm === 'e');
  if (last) window.__debug.tapBoard(last.x, last.y);
});
await shot('6b-victory');

// 7) run 結算畫面
await page.evaluate(() => {
  g_unused: { /* noop */ }
  window.__debug.finishRun(false);
});
await shot('7-result');

// 8) 回到大廳
await page.evaluate(() => window.game_actions.toHub());
await shot('8-hub-after-run');

await browser.close();
server.close();

if (errors.length) {
  console.log('\n⚠ 有 console 錯誤：');
  for (const e of errors) console.log('   ' + e);
  process.exitCode = 1;
} else {
  console.log('\n✓ 無 console 錯誤，圖檔在 test-output/shots/');
}
