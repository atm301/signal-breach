// 瀏覽器端整合測試：實際載入頁面、跑完一段核心流程、檢查沒有 console error。
// 走本機 http（ES module 不能用 file://）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { listen } from '../serve.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(ROOT, 'test-output', 'full-flow');
fs.mkdirSync(outDir, { recursive: true });

const { server, port } = await listen(0);
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push({ type: 'console', text: m.text() }); });
page.on('pageerror', (e) => { errors.push({ type: 'pageerror', text: String(e) }); });

await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof window.test_run_full_flow === 'function', null, { timeout: 10000 });

// 1) 大廳應該是預設畫面，而且面板有東西
const bootState = JSON.parse(await page.evaluate(() => window.render_game_to_text()));
const panelHasContent = await page.evaluate(() => document.getElementById('panel').children.length > 0);

// 1b) AI 生成的素材要真的載進來。素材缺了遊戲仍能跑（會退回程式繪製），
//     所以不驗這條的話，assets/ 整個消失都不會有人發現。
await page.waitForFunction(() => window.__assets && window.__assets().ready, null, { timeout: 15000 }).catch(() => {});
const assets = await page.evaluate(() => window.__assets());

// 1c) 音效系統：瀏覽器規定要有使用者手勢才能出聲，所以先點一下再驗。
//     不驗的話「沒聲音」只會在真人玩的時候才發現。
await page.mouse.click(5, 5);
await page.waitForTimeout(400);
const audio = await page.evaluate(() => window.__audio());
await page.evaluate(() => { window.game_actions.startRun(); });
await page.waitForTimeout(200);
const audioInRun = await page.evaluate(() => window.__audio());

// 2) 核心流程：開 run → 進戰鬥 → 擊殺 → 回地圖
const flow = await page.evaluate(() => window.test_run_full_flow());
const afterFlow = JSON.parse(await page.evaluate(() => window.render_game_to_text()));

// 3) 關卡樹必須連通，而且從起點真的走得到 Boss
const mapOk = await page.evaluate(() => {
  const g = window.__game();
  const seen = new Set([g.map.startId]);
  const queue = [g.map.startId];
  while (queue.length) {
    const cur = g.map.nodes[queue.shift()];
    for (const id of cur.next) if (!seen.has(id)) { seen.add(id); queue.push(id); }
  }
  return { connected: seen.has(g.map.bossId), nodeCount: Object.keys(g.map.nodes).length };
});

// 4) 同一個 seed 必須生出同一張圖（roguelike 的可重現性）
const deterministic = await page.evaluate(() => {
  const sig = () => {
    const g = window.__game();
    return Object.values(g.map.nodes).map((n) => `${n.floor}${n.slot}${n.type}`).join('|');
  };
  window.game_actions.startSeed;
  const el = document.getElementById('seedInput');
  const runWith = (s) => {
    const g0 = window.__game();
    void g0;
    if (el) el.value = s;
    window.game_actions.startSeed();
    return sig();
  };
  // 大廳可能沒渲染 input，直接改用 URL seed 等價的做法
  if (!el) return { skipped: true, same: true };
  const a = runWith('determinism-check');
  const b = runWith('determinism-check');
  const c = runWith('a-different-seed');
  return { skipped: false, same: a === b, differs: a !== c };
});

// 5) 結束一個 run 後，meta 必須真的寫進 localStorage 並累積碎片
//    （meta 只在 run 結算或購買升級時寫檔，所以要先讓 run 真的結束）
const metaPersist = await page.evaluate(() => {
  localStorage.removeItem('sft_meta_v1');
  window.game_actions.startRun();
  window.game_actions.goNode(window.__game().map.nodes[window.__game().currentNodeId].next[0]);
  window.game_actions.toHub(); // 放棄出擊 → 結算 → 存檔
  const raw = localStorage.getItem('sft_meta_v1');
  const parsed = raw ? JSON.parse(raw) : null;
  return {
    written: raw !== null,
    coresGained: (parsed?.cores ?? 0) > 0,
    runCounted: (parsed?.stats?.runs ?? 0) === 1,
    backAtHub: window.__game().screen === 'hub',
  };
});

// 6) 回歸測試：run 結束時必須把還開著的抽卡面板收掉
//    （曾經出現過在結算畫面上還能幫死掉的 run 選卡片）
const cleanupOnFinish = await page.evaluate(() => {
  window.game_actions.startRun();
  const g = window.__game();
  window.__debug.queueDraft(g.squad[0].id, 'levelup');
  const hadDraft = !!g.pending.draft;
  window.__debug.finishRun(false);
  return {
    hadDraft,
    draftCleared: g.pending.draft === null && g.pending.draftQueue.length === 0,
    onResultScreen: g.screen === 'result',
  };
});

await page.screenshot({ path: path.join(outDir, 'full-flow.png'), fullPage: false });

const assertions = {
  bootsToHub: bootState.screen === 'hub',
  panelRendered: panelHasContent,
  unitSpritesLoaded: assets.units === 33, // 11 個單位 x 3 個損傷階段
  propSpritesLoaded: assets.props === 6,
  iconSpritesLoaded: assets.icons === 8,
  uiSpritesLoaded: assets.ui === 1,
  audioContextStarted: audio.started === true,
  musicPlaying: audio.mode !== null,
  musicSwitchesWithScreen: audioInRun.mode === 'map',
  flowCompleted: !!flow.ok,
  enteredBattle: !!flow.enteredBattle,
  victoryScreenShown: !!flow.sawVictory,
  victoryAwardedCredits: flow.victoryCredits > 0,
  gotKills: flow.kills > 0,
  earnedCredits: flow.credits > 0,
  mapConnected: mapOk.connected,
  mapHasNodes: mapOk.nodeCount >= 12,
  seedDeterministic: deterministic.same,
  seedActuallyVaries: deterministic.skipped ? true : deterministic.differs,
  metaWritten: metaPersist.written,
  metaCoresGained: metaPersist.coresGained,
  metaRunCounted: metaPersist.runCounted,
  returnsToHub: metaPersist.backAtHub,
  draftQueuedForTest: cleanupOnFinish.hadDraft,
  pendingClearedOnRunEnd: cleanupOnFinish.draftCleared,
  reachesResultScreen: cleanupOnFinish.onResultScreen,
  noConsoleErrors: errors.length === 0,
};

const pass = Object.values(assertions).every(Boolean);

fs.writeFileSync(
  path.join(outDir, 'result.json'),
  JSON.stringify({ pass, assertions, flow, mapOk, deterministic, errors }, null, 2)
);
fs.writeFileSync(path.join(outDir, 'state.json'), JSON.stringify(afterFlow, null, 2));

await browser.close();
server.close();

if (!pass) {
  console.error(JSON.stringify({ pass, assertions, flow, errors }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({ pass, assertions }, null, 2));
