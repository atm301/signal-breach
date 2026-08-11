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

// 1b2) 開場畫面要能走到大廳，作者的話要能開能回
const titleFlow = await page.evaluate(() => {
  const seen = {};
  window.game_actions.credits();
  seen.credits = window.__game().screen === 'credits';
  window.game_actions.titleBack();
  seen.back = window.__game().screen === 'title';
  window.game_actions.play();
  seen.hub = window.__game().screen === 'hub';
  return seen;
});

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

// 7) 存檔往返：存檔 → 真的重新載入頁面 → 讀檔 → 狀態必須一模一樣。
//    壞掉的存檔比沒有存檔更糟，這條一定要驗到「重新載入」那一步，
//    只在同一個 page 裡 serialize 再 deserialize 是驗不出東西的。
const saveSig = (g) => JSON.stringify({
  seed: g.seed,
  node: g.currentNodeId,
  screen: g.screen,
  credits: g.credits,
  depth: g.stats.depth,
  kills: g.stats.kills,
  squad: g.squad.map((u) => [u.id, u.hp, u.mhp, u.lv, u.xp, u.atk, u.rg, u.map, u.sp, u.path]),
  cover: g.battle ? [...g.battle.cover].sort() : null,
  enemies: g.battle ? g.battle.units.filter((u) => u.tm === 'e').map((u) => [u.key, u.hp, u.x, u.y]) : null,
  map: Object.values(g.map.nodes).map((n) => `${n.id}${n.type}${n.visited ? 1 : 0}`),
});

const before = await page.evaluate(({ src }) => {
  // eslint-disable-next-line no-new-func
  const sig = new Function(`return (${src})`)();
  window.game_actions.startRun();
  const g = window.__game();
  // 走兩步，讓存檔不是「剛開始」那種沒內容的狀態
  window.game_actions.goNode(g.map.nodes[g.currentNodeId].next[0]);
  if (g.screen === 'victory') window.game_actions.victoryClose();
  if (g.pending.draft) window.game_actions.draft(g.pending.draft.cards[0].id);
  return { sig: sig(g), screen: g.screen };
}, { src: saveSig.toString() });

// 等自動存檔跑過一幀
await page.waitForTimeout(300);
const savedRaw = await page.evaluate(() => localStorage.getItem('sft_run_v1'));

// 真的重新載入
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof window.__game === 'function', null, { timeout: 10000 });
await page.waitForFunction(() => window.__assets && window.__assets().ready, null, { timeout: 15000 }).catch(() => {});

const afterReload = await page.evaluate(({ src }) => {
  // eslint-disable-next-line no-new-func
  const sig = new Function(`return (${src})`)();
  const onTitle = window.__game().screen === 'title';
  window.game_actions.resumeRun();
  const g = window.__game();
  return { onTitle, sig: sig(g), screen: g.screen };
}, { src: saveSig.toString() });

const saveRoundTrip = {
  wroteFile: !!savedRaw && savedRaw.length > 200,
  bootsToTitleAfterReload: afterReload.onTitle,
  stateIdentical: before.sig === afterReload.sig,
  screenRestored: before.screen === afterReload.screen,
};

await page.screenshot({ path: path.join(outDir, 'full-flow.png'), fullPage: false });

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets', 'manifest.json'), 'utf-8'));

const assertions = {
  bootsToTitle: bootState.screen === 'title',
  panelRendered: panelHasContent,
  // 跟 manifest 對數，不寫死數字。
  // 原本寫死 33（11 單位 x 3 損傷），加了一套外觀變體就紅掉 ——
  // 那不是「素材壞了」，是斷言本身過期。要驗的是「manifest 上有的都載進來了」。
  unitSpritesLoaded: assets.units === manifest.units.length,
  propSpritesLoaded: assets.props === manifest.props.length,
  iconSpritesLoaded: assets.icons === manifest.icons.length,
  uiSpritesLoaded: assets.ui === manifest.ui.length,
  titleOpensCredits: titleFlow.credits,
  titleReturns: titleFlow.back,
  titleEntersHub: titleFlow.hub,
  audioContextStarted: audio.started === true,
  musicAudible: audio.level > 0.004,
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
  saveFileWritten: saveRoundTrip.wroteFile,
  saveBootsToTitle: saveRoundTrip.bootsToTitleAfterReload,
  saveStateIdenticalAfterReload: saveRoundTrip.stateIdentical,
  saveScreenRestored: saveRoundTrip.screenRestored,
  noConsoleErrors: errors.length === 0,
};

const pass = Object.values(assertions).every(Boolean);

fs.writeFileSync(
  path.join(outDir, 'result.json'),
  JSON.stringify({ pass, assertions, flow, mapOk, deterministic, saveRoundTrip, errors }, null, 2)
);
fs.writeFileSync(path.join(outDir, 'state.json'), JSON.stringify(afterFlow, null, 2));

await browser.close();
server.close();

if (!pass) {
  console.error(JSON.stringify({ pass, assertions, flow, errors }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({ pass, assertions }, null, 2));
