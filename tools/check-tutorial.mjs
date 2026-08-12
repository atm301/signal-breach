// 教學提示驗證。
//
// 教學的價值全在「時機」：講對時機的一句話勝過開場的十句。
// 所以這支驗的不是「有沒有文字」，是：
//   1. 每一條在該出現的狀態下真的會出現
//   2. 不該出現的時候不出現（尤其是老玩家）
//   3. 看過就不再跳、關掉就整個安靜、重看能復原
//   4. 面板上真的畫得出來、按了真的消失、關掉真的存進 localStorage
//
// 前三項在 node 裡驗（純邏輯），第四項要真的開瀏覽器。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { listen } from '../serve.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(ROOT, 'test-output', 'tutorial');
fs.mkdirSync(outDir, { recursive: true });

const A = {};
const fail = [];
const check = (name, ok, detail) => {
  A[name] = !!ok;
  if (!ok) fail.push(detail ? `${name}: ${detail}` : name);
};

// ---------------------------------------------------------------- 純邏輯層

const tut = await import('../src/tutorial.js');
const engine = await import('../src/engine.js');
const { TIPS, nextTip, markSeen, setTutorial, resetTutorial, tutorialProgress, emptyTutorial } = tut;
const { createGame, startBattle, endPlayerTurn } = engine;
const { emptyMeta } = await import('../src/meta.js');

const freshMeta = () => ({ ...emptyMeta(), tutorial: emptyTutorial(true) });

// 1) 每條提示都要有內容，而且 id 不能重複
check('tipsHaveContent', TIPS.every((t) => t.id && t.t && Array.isArray(t.b) && t.b.length > 0
  && typeof t.when === 'function'));
check('tipIdsUnique', new Set(TIPS.map((t) => t.id)).size === TIPS.length);
check('tipsNotTooMany', TIPS.length <= 12,
  `${TIPS.length} 條太多了，情境教學一多就變成另一種說明書`);

// 2) 開關與已讀狀態
{
  const meta = freshMeta();
  const g = createGame({ seed: 'tut' });
  g.pending.recruit = { picked: g.squad.map((u) => u.id) };
  const first = nextTip(g, meta);
  check('firstTipFires', first?.id === 'recruit', `編隊畫面應該跳 recruit，實際 ${first?.id}`);

  markSeen(meta, 'recruit');
  check('seenTipDoesNotRepeat', nextTip(g, meta)?.id !== 'recruit');

  // 要用「什麼都還沒看過」的 meta 驗關閉。
  // 沿用上面那個已經把 recruit 標成已讀的 meta 會讓這條變成空過 ——
  // 就算把 on 的守衛整個拔掉，也剛好沒有別的提示成立。
  const off = freshMeta();
  setTutorial(off, false);
  check('offMeansSilent', nextTip(g, off) === null, '關掉之後不該再有任何提示');

  setTutorial(meta, true);
  resetTutorial(meta);
  check('resetRestores', nextTip(g, meta)?.id === 'recruit' && tutorialProgress(meta).seen === 0);
}

// 3) 老玩家不該被塞提示。
//    這是「預設值」最容易出錯的地方：新玩家要開、老玩家要關，
//    而判斷依據是 meta 上有沒有 tutorial 欄位 + 打過幾場。
{
  const veteran = { ...emptyMeta(), stats: { ...emptyMeta().stats, runs: 12 } };
  delete veteran.tutorial; // 模擬舊存檔
  const g = createGame({ seed: 'tut2' });
  g.pending.recruit = { picked: [] };
  check('veteranDefaultsOff', nextTip(g, veteran) === null,
    `打過 12 場的舊存檔不該突然跳教學：${JSON.stringify(veteran.tutorial)}`);

  const rookie = { ...emptyMeta(), stats: { ...emptyMeta().stats, runs: 0 } };
  delete rookie.tutorial;
  check('rookieDefaultsOn', nextTip(g, rookie)?.id === 'recruit',
    '第一次玩的人應該預設開著教學');
}

// 4) 標題與作者的話畫面不該跳教學（那裡沒有東西可以教）
{
  const meta = freshMeta();
  const g = createGame({ seed: 'tut3' });
  g.pending.recruit = { picked: [] };
  for (const screen of ['title', 'credits']) {
    g.screen = screen;
    check(`noTipOn_${screen}`, nextTip(g, meta) === null);
  }
}

// 5) 每一條提示都要能被真的觸發到。
//    寫得出條件但永遠不成立的提示是最糟的：它看起來有做，其實玩家一輩子看不到。
{
  const reached = new Set();
  for (let seed = 0; seed < 40 && reached.size < TIPS.length; seed++) {
    const meta = freshMeta();
    const g = createGame({ seed: `reach-${seed}` });

    // 編隊
    g.pending.recruit = { picked: g.squad.map((u) => u.id) };
    let t = nextTip(g, meta); if (t) { reached.add(t.id); markSeen(meta, t.id); }
    g.pending.recruit = null;

    // 走到第一個戰鬥節點
    const node = Object.values(g.map.nodes).find((n) => n.type === 'battle');
    if (node) startBattle(g, node);

    // 戰鬥中：反覆推進並收集所有跳出來的提示
    for (let step = 0; step < 60 && g.battle && g.battle.phase !== 'lose'; step++) {
      t = nextTip(g, meta);
      if (t) { reached.add(t.id); markSeen(meta, t.id); continue; }
      // 沒有新提示就換一個選定單位，逼出 forecast / skill 這類跟「選誰」有關的條件
      const mine = g.battle.units.filter((u) => u.alive && u.tm === 'p');
      if (!mine.length) break;
      g.battle.selectedId = mine[step % mine.length].id;
      if (step % 7 === 6) {
        // endPlayerTurn 之後 phase 就是 'ai'，但 runEnemyPhase 是同步跑完的。
        // 真實遊戲裡這個階段會橫跨好幾幀（約 400ms），nextTip 每一幀都會被評估，
        // 所以要在「跑敵方階段之前」檢查，才量得到玩家真的看得到的狀態。
        endPlayerTurn(g);
        const mid = nextTip(g, meta);
        if (mid) { reached.add(mid.id); markSeen(meta, mid.id); }
        engine.runEnemyPhase(g);
      }
      // 手動製造背擊機會與技能點，確保 flank / tree 這兩條有機會成立
      if (step === 10) {
        const me = mine[0];
        const foe = g.battle.units.find((u) => u.alive && u.tm === 'e');
        if (foe) {
          foe.x = me.x; foe.y = Math.max(0, Math.min(4, me.y + 1));
          foe.faceX = 0; foe.faceY = -1;
          me.faceX = 0; me.faceY = 1;
        }
      }
      if (step === 20) mine[0].sp = 1;
    }

    // 抽卡 / 勝利修整這兩個狀態直接擺出來
    if (g.squad[0]) {
      engine.queueDraft(g, g.squad[0].id, 'levelup');
      t = nextTip(g, meta); if (t) { reached.add(t.id); markSeen(meta, t.id); }
      g.pending.draft = null; g.pending.draftQueue = [];
    }
    g.screen = 'victory';
    g.pending.victory = { isBoss: false, credits: 10, healed: [], recovered: [], floor: 1, kills: 1, turns: 3 };
    t = nextTip(g, meta); if (t) { reached.add(t.id); markSeen(meta, t.id); }
  }
  const missing = TIPS.map((t) => t.id).filter((id) => !reached.has(id));
  check('everyTipIsReachable', missing.length === 0,
    `這些提示的條件永遠不成立，玩家看不到：${missing.join()}`);
}

// 6) 節奏：同一個回合不該連續冒出好幾條。
//    前三條如果全擠在第一回合，玩家要連按三次「知道了」才碰得到棋盤 ——
//    那就變回「開場一次講完」了，只是換了個包裝。
{
  const meta = freshMeta();
  const g = createGame({ seed: 'pace' });
  const node = Object.values(g.map.nodes).find((n) => n.type === 'battle');
  check('paceFixtureReady', !!node, '找不到戰鬥節點，這條驗不到');
  if (node) {
    startBattle(g, node);
    const perTurn = {};
    for (let turn = 1; turn <= 4; turn++) {
      g.battle.turn = turn;
      g.battle.phase = 'player';
      perTurn[turn] = [];
      // 同一個回合內反覆問，把這回合會跳的全部收乾淨
      for (let i = 0; i < 6; i++) {
        const t = nextTip(g, meta);
        if (!t) break;
        perTurn[turn].push(t.id);
        markSeen(meta, t.id);
      }
    }
    const worst = Math.max(...Object.values(perTurn).map((a) => a.length));
    check('tipsPacedAcrossTurns', worst <= 1,
      `單一回合冒出 ${worst} 條提示：${JSON.stringify(perTurn)}`);
  }
}

// ---------------------------------------------------------------- 瀏覽器層

const { server, port } = await listen(0);
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof window.test_run_full_flow === 'function', null, { timeout: 10000 });

// 全新玩家：開新出擊應該立刻看到第一張教學卡
const shown = await page.evaluate(async () => {
  localStorage.removeItem('sft_meta_v1');
  localStorage.removeItem('sft_run_v1');
  return true;
});
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof window.test_run_full_flow === 'function', null, { timeout: 10000 });

await page.evaluate(() => { window.game_actions.play(); window.game_actions.startRun(); });
await page.waitForFunction(() => !!document.querySelector('.tip'), null, { timeout: 5000 }).catch(() => {});

const firstCard = await page.evaluate(async () => {
  const t = await import('./src/tutorial.js');
  const el = document.querySelector('.tip');
  const want = t.nextTip(window.__game(), window.__meta());
  return {
    exists: !!el,
    text: el?.innerText ?? '',
    hasOk: !!el?.querySelector('[data-act^="tipOk:"]'),
    hasOff: !!el?.querySelector('[data-act="tipOff"]'),
    // 真正的不變量：畫出來的就是 nextTip 決定的那一條，而且按鈕帶著同一個 id。
    // 用關鍵字比對文案太脆 —— 改一次文案就紅一次，而那不是壞掉。
    wantId: want?.id ?? null,
    wantTitle: want?.t ?? null,
    okId: el?.querySelector('[data-act^="tipOk:"]')?.dataset.act.split(':')[1] ?? null,
    titleShown: el?.querySelector('.tip-head b')?.innerText ?? null,
    bodyLines: el ? el.querySelectorAll('.tip-body li').length : 0,
    wantLines: want?.b.length ?? 0,
  };
});
check('tipCardRendersInBrowser', firstCard.exists && firstCard.hasOk && firstCard.hasOff,
  JSON.stringify(firstCard).slice(0, 200));
check('tipCardMatchesNextTip',
  firstCard.wantId && firstCard.okId === firstCard.wantId
  && firstCard.titleShown === firstCard.wantTitle
  && firstCard.bodyLines === firstCard.wantLines,
  `畫出來的卡片跟 nextTip 決定的不一致：${JSON.stringify(firstCard)}`);
await page.screenshot({ path: path.join(outDir, 'tip-recruit.png') });

// 按「知道了」→ 卡片要換掉或消失，而且要寫進 localStorage
const afterOk = await page.evaluate(async () => {
  const id = document.querySelector('.tip [data-act^="tipOk:"]').dataset.act.split(':')[1];
  document.querySelector('.tip [data-act^="tipOk:"]').click();
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const meta = JSON.parse(localStorage.getItem('sft_meta_v1') || '{}');
  const now = document.querySelector('.tip');
  return {
    dismissedId: id,
    persisted: !!meta.tutorial?.seen?.[id],
    sameTipGone: !now || !now.innerText.includes('編隊出擊'),
  };
});
check('tipOkPersists', afterOk.persisted, `按了知道了沒寫進 localStorage：${JSON.stringify(afterOk)}`);
check('tipOkDismisses', afterOk.sameTipGone, JSON.stringify(afterOk));

// 關閉教學 → 面板上不該再有任何教學卡，重新載入也要維持關閉
const afterOff = await page.evaluate(async () => {
  const btn = document.querySelector('[data-act="tipOff"]');
  if (btn) btn.click();
  else window.game_actions.tipOff();
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const meta = JSON.parse(localStorage.getItem('sft_meta_v1') || '{}');
  return { gone: !document.querySelector('.tip'), off: meta.tutorial?.on === false };
});
check('tipOffHidesCard', afterOff.gone, JSON.stringify(afterOff));
check('tipOffPersists', afterOff.off, JSON.stringify(afterOff));

await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof window.test_run_full_flow === 'function', null, { timeout: 10000 });
const afterReload = await page.evaluate(async () => {
  window.game_actions.play();
  window.game_actions.startRun();
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  return { hasTip: !!document.querySelector('.tip') };
});
check('tipStaysOffAfterReload', !afterReload.hasTip,
  '關掉教學重新載入又跳出來 = 設定沒存住');

// 大廳的開關要能重新打開，而且「重看一次」要復原
const hubToggle = await page.evaluate(async () => {
  window.game_actions.toHub();
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const before = document.querySelector('[data-act="tutorialToggle"]')?.innerText ?? '';
  window.game_actions.tutorialToggle();
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const after = document.querySelector('[data-act="tutorialToggle"]')?.innerText ?? '';
  window.game_actions.tutorialReset();
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const meta = JSON.parse(localStorage.getItem('sft_meta_v1') || '{}');
  return {
    before, after,
    on: meta.tutorial?.on === true,
    seenCleared: Object.keys(meta.tutorial?.seen ?? {}).length === 0,
  };
});
check('hubToggleExists', hubToggle.before.length > 0, JSON.stringify(hubToggle));
check('hubToggleFlips', hubToggle.before !== hubToggle.after, JSON.stringify(hubToggle));
check('hubResetRestores', hubToggle.on && hubToggle.seenCleared, JSON.stringify(hubToggle));

check('noConsoleErrors', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();
server.close();

const pass = fail.length === 0;
console.log(JSON.stringify({ pass, assertions: A, failures: fail }, null, 2));
console.log(`\n截圖：${outDir}`);
process.exit(pass ? 0 : 1);
