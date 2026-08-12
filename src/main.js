// 組裝層：canvas、輸入、音效、meta 存檔、畫面狀態機。
// 遊戲規則一律不寫在這裡，全部在 engine.js。

import { FLOORS } from './data.js';
import {
  createGame, enterNode, tapBoard, setActionMode, endPlayerTurn, stepEnemy,
  selectUnit, spendSkillPoint, pickDraftCard, chooseEventOption, closeEvent,
  buyShopItem, leaveShop, chooseSupply, closeSupply, setFocus, finishRun,
  serializeState, log, queueDraft, closeVictory,
  openRecruit, toggleRecruit, confirmRecruit, buyRepair,
} from './engine.js';
import { loadMeta, saveMeta, buyUpgrade, recordRun, resetMeta } from './meta.js';
import { loadAssets, assetCount } from './assets.js';
import {
  ensureAudio, playSfx, setMusicMode, toggleMusic, toggleSfx, audioState,
  currentTrack, shuffleTrack,
} from './audio.js';
import { saveRun, loadRun, peekRun, clearRun } from './save.js';
import { renderBattle, renderMap, renderIdle, renderTitle, pickBoardTile, pickMapNode } from './render.js';
import { createUI, hudHtml } from './ui.js';
import { dailySeed } from './rng.js';

// 敵方回合的節奏。實測固定 380ms 讓玩家每場乾等 2.3 秒，而且大部分時間只是在看走位。
// 改成依行動類型給不同時間：純走位快帶過，開火才留時間看清楚。
//
// ⚠️ 攻擊那一拍不要再往下砍了。第一版砍到 260ms，整個敵方回合只剩 390ms ——
// 三隻敵人移動加開火全擠在 0.4 秒內，玩家的感受是「敵人根本沒攻擊，血怎麼少了」。
// 傷害數字活 900ms，但打擊演出（beam 140ms + 受擊 240ms）會互相蓋掉。
// 420ms 讓每一次開火有自己的節拍，一場多花約 1.7 秒，換回「看得懂發生什麼事」。
const AI_MOVE_MS = 120;
const AI_ATTACK_MS = 420;

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const panelRoot = document.getElementById('panel');
const hudRoot = document.getElementById('hud');

let meta = loadMeta();
let g = null;
let fxList = [];
let hoverNodeId = null;
let hoverTile = null;
let aiAcc = 0;
let resultRecorded = false;
let lastFrame = performance.now();
let aiDelay = AI_ATTACK_MS;

// ---------------------------------------------------------------- 音樂段落

// 依目前畫面決定 BGM 的強度。Boss 戰另外拉高。
function musicModeFor(game) {
  if (!game) return 'hub';
  if (game.screen === 'battle' || game.screen === 'victory') {
    return game.battle?.nodeType === 'boss' ? 'boss' : 'battle';
  }
  if (game.screen === 'title' || game.screen === 'credits' || game.screen === 'hub') return 'hub';
  if (game.screen === 'result') return 'result';
  return 'map';
}

// 瀏覽器規定要有使用者手勢才能出聲，所以第一次互動時解鎖 AudioContext
function unlockAudio() {
  ensureAudio();
  setMusicMode(musicModeFor(g));
}
for (const ev of ['pointerdown', 'keydown', 'touchstart']) {
  window.addEventListener(ev, unlockAudio, { once: true });
}

// ---------------------------------------------------------------- run 生命週期

// ⚠️ 這裡刻意不呼叫 clearRun()。
// 開機時也會叫一次 newRun() 當佔位（讓 g 不是 null），
// 如果在這裡清檔，等於每次重新載入頁面都會把存檔刪掉，讀檔永遠讀不到。
// 清檔放在真正「開新出擊」的 action 裡。
function newRun(seed) {
  g = createGame({ seed, meta });
  fxList = [];
  aiAcc = 0;
  resultRecorded = false;
  lastSaveSig = '';
  refreshTitleSave();
  ui.invalidate();
}

function toHub(abandon = false) {
  if (abandon && g && !['hub', 'result', 'title', 'credits'].includes(g.screen)) {
    finishRun(g, false); // 中途放棄仍然結算碎片，避免「打不過就重整頁面」變成最優解
    commitResult();
  }
  if (!g) newRun();
  clearRun();
  refreshTitleSave();
  // 編隊還沒確認就放棄回基地的話，pending.recruit 會留著把大廳整個蓋住 ——
  // 玩家會發現自己買不了永久升級，而且完全看不出原因。
  g.pending.recruit = null;
  g.screen = 'hub';
  ui.invalidate();
}

function commitResult() {
  if (!g?.result || resultRecorded) return;
  resultRecorded = true;
  recordRun(meta, g.result);
  saveMeta(meta);
  clearRun(); // run 結束了，存檔沒有意義
  refreshTitleSave();
}

// ---------------------------------------------------------------- 存檔

let titleSave = null;
let lastSaveSig = '';

function refreshTitleSave() {
  titleSave = peekRun();
  ui.invalidate();
}

// 只在「狀態真的推進了」的時候寫檔，不要每一幀都寫
function autoSave() {
  if (!g || ['title', 'credits', 'hub', 'result'].includes(g.screen)) return;
  const sig = `${g.screen}|${g.currentNodeId}|${g.battle?.turn ?? 0}|${g.battle?.phase ?? '-'}|${g.squad.map((u) => u.hp).join(',')}`;
  if (sig === lastSaveSig) return;
  lastSaveSig = sig;
  saveRun(g);
}

// ---------------------------------------------------------------- 動作表（UI 與快捷鍵共用）

const actions = {
  music() { toggleMusic(); ui.invalidate(); },
  sfx() { toggleSfx(); playSfx('click'); ui.invalidate(); },
  shuffle() { shuffleTrack(); ui.invalidate(); },
  toHub() { toHub(true); },

  // 開場畫面
  play() {
    if (!g) newRun();
    g.screen = 'hub';
    ui.invalidate();
  },
  credits() { g.screen = 'credits'; ui.invalidate(); },
  titleBack() { g.screen = 'title'; refreshTitleSave(); },
  resumeRun() {
    const loaded = loadRun(meta);
    if (!loaded) { refreshTitleSave(); return; }
    g = loaded;
    fxList = [];
    aiAcc = 0;
    resultRecorded = false;
    lastSaveSig = '';
    playSfx('ui', 700);
    ui.invalidate();
  },
  deleteSave() {
    if (!window.confirm('確定要刪除這筆出擊存檔嗎？這場的進度會消失。')) return;
    clearRun();
    refreshTitleSave();
  },

  // 開新出擊才清掉舊存檔。
  // openRecruit 只掛在這三個「明確開新局」的動作上，不放進 newRun ——
  // newRun 也被開機佔位與 toHub 呼叫，放進去會讓一進大廳就跳出編隊畫面。
  startRun() { clearRun(); newRun(); openRecruit(g); },
  startDaily() { clearRun(); newRun(dailySeed()); openRecruit(g); },
  startSeed() {
    const input = document.getElementById('seedInput');
    const value = (input?.value || '').trim();
    clearRun();
    newRun(value || undefined);
    openRecruit(g);
  },

  buy(id) {
    const res = buyUpgrade(meta, id);
    if (res.ok) { saveMeta(meta); playSfx('ui', 700); }
    ui.invalidate();
  },
  resetMeta() {
    if (!window.confirm('確定要清除所有永久進度嗎？這個動作無法復原。')) return;
    meta = resetMeta();
    ui.invalidate();
  },

  goNode(id) { enterNode(g, id); },
  focus(id) { setFocus(g, id); },
  select(id) { selectUnit(g, id); },

  mode(m) { setActionMode(g, m); },
  endturn() { if (endPlayerTurn(g)) { aiAcc = 0; aiDelay = AI_MOVE_MS; } },
  tree(unitId, lv) {
    const res = spendSkillPoint(g, unitId, Number(lv));
    if (!res.ok) log(g, res.reason, true);
  },
  draft(cardId) { pickDraftCard(g, cardId); },

  event(index) {
    const res = chooseEventOption(g, Number(index));
    if (!res.ok) log(g, res.reason, true);
  },
  eventClose() { closeEvent(g); },

  shop(index) {
    const res = buyShopItem(g, Number(index));
    if (!res.ok) log(g, res.reason, true);
  },
  shopLeave() { leaveShop(g); },

  supply(id) {
    const res = chooseSupply(g, id);
    if (!res.ok) log(g, res.reason, true);
  },
  supplyClose() { closeSupply(g); },
  victoryClose() { closeVictory(g); },

  recruit(id) {
    const res = toggleRecruit(g, id);
    if (!res.ok && res.reason) log(g, res.reason, true);
    else playSfx('ui', 620);
  },
  recruitGo() {
    const res = confirmRecruit(g);
    if (!res.ok) { log(g, res.reason, true); return; }
    playSfx('node');
  },
  repair(id) {
    const res = buyRepair(g, id);
    if (!res.ok) log(g, res.reason, true);
  },
};

const ui = createUI(panelRoot, actions);

// ---------------------------------------------------------------- 輸入

function canvasSize() {
  return canvas.getBoundingClientRect().width;
}

function localPoint(ev) {
  const r = canvas.getBoundingClientRect();
  return { x: ev.clientX - r.left, y: ev.clientY - r.top };
}

canvas.addEventListener('click', (ev) => {
  if (!g) return;
  const p = localPoint(ev);
  const size = canvasSize();

  if (g.screen === 'map') {
    const id = pickMapNode(g, size, p.x, p.y);
    if (id) { playSfx('node'); enterNode(g, id); }
    return;
  }
  if (g.screen === 'battle') {
    const tile = pickBoardTile(size, p.x, p.y);
    if (!tile) return;
    const res = tapBoard(g, tile.x, tile.y);
    if (!res.ok && res.reason) log(g, res.reason);
  }
});

canvas.addEventListener('mousemove', (ev) => {
  if (!g) { hoverNodeId = null; hoverTile = null; return; }
  const p = localPoint(ev);
  if (g.screen === 'map') {
    hoverNodeId = pickMapNode(g, canvasSize(), p.x, p.y);
    hoverTile = null;
    return;
  }
  hoverNodeId = null;
  hoverTile = g.screen === 'battle' ? pickBoardTile(canvasSize(), p.x, p.y) : null;
});
canvas.addEventListener('mouseleave', () => { hoverNodeId = null; hoverTile = null; });

document.addEventListener('keydown', (ev) => {
  if (!g) return;
  if (ev.target instanceof HTMLInputElement) return;
  const k = ev.key.toLowerCase();
  if (k === 'e' || k === ' ') { ev.preventDefault(); actions.endturn(); }
  if (k === 's') actions.sfx();
  if (k === 'b') actions.music();
  if (k === 'f') {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => {});
    else document.exitFullscreen().catch(() => {});
  }
  // 1..4 直接選抽卡
  if (g.pending.draft && /^[1-4]$/.test(k)) {
    const card = g.pending.draft.cards[Number(k) - 1];
    if (card) pickDraftCard(g, card.id);
  }
  // Tab 在我方單位之間循環
  if (k === 'tab' && g.screen === 'battle' && g.battle?.phase === 'player') {
    ev.preventDefault();
    const mine = g.battle.units.filter((u) => u.alive && u.tm === 'p');
    if (mine.length) {
      const idx = mine.findIndex((u) => u.id === g.battle.selectedId);
      selectUnit(g, mine[(idx + 1) % mine.length].id);
    }
  }
});

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const size = Math.max(360, Math.floor(rect.width));
  canvas.width = size * dpr;
  canvas.height = size * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', resizeCanvas);
document.addEventListener('fullscreenchange', resizeCanvas);

// ---------------------------------------------------------------- 主迴圈

function drainQueues() {
  for (const f of g.fxQueue) {
    const fx = { ...f, maxLife: f.life };
    // 同一格上還沒消失的傷害數字，往上讓一排。
    // 兩隻敵人打同一個人的時候，數字會疊在完全同一個位置變成一團看不懂的東西。
    if (fx.type === 'damage') {
      fx.stack = fxList.filter((o) => o.type === 'damage' && o.x === fx.x && o.y === fx.y).length;
    }
    fxList.push(fx);
  }
  g.fxQueue.length = 0;
  for (const s of g.sfxQueue) playSfx(s.kind, s.freq);
  g.sfxQueue.length = 0;
  if (fxList.length > 96) fxList.splice(0, fxList.length - 96);
}

function update(dt) {
  drainQueues();

  for (const u of g.battle?.units ?? []) {
    if (u.hurtMs > 0) u.hurtMs = Math.max(0, u.hurtMs - dt);
    if (u.fireMs > 0) u.fireMs = Math.max(0, u.fireMs - dt);
  }
  for (let i = fxList.length - 1; i >= 0; i--) {
    fxList[i].life -= dt;
    if (fxList[i].life <= 0) fxList.splice(i, 1);
  }

  if (g.battle?.phase === 'ai') {
    aiAcc += dt;
    if (aiAcc >= aiDelay) {
      aiAcc = 0;
      const r = stepEnemy(g);
      aiDelay = r && r.attacked ? AI_ATTACK_MS : AI_MOVE_MS;
    }
  }

  if (g.screen === 'result') commitResult();
}

function draw(time) {
  const size = canvasSize();
  if (g.screen === 'title' || g.screen === 'credits') {
    renderTitle(ctx, size, time, { mode: g.screen, audioStarted: audioState().started });
  } else if ((g.screen === 'battle' || g.screen === 'victory') && g.battle) renderBattle(ctx, g, size, time, fxList, hoverTile);
  else if (g.screen === 'hub') renderIdle(ctx, g, size, '作戰基地');
  else if (g.screen === 'result') renderIdle(ctx, g, size, g.result?.won ? '出擊成功' : '出擊失敗');
  else renderMap(ctx, g, size, time, hoverNodeId);
}

function frame(now) {
  const dt = Math.min(100, Math.max(0, now - lastFrame));
  lastFrame = now;
  update(dt);
  draw(now);
  setMusicMode(musicModeFor(g));
  autoSave();
  ui.render(g, meta, {
    ...audioState(),
    track: currentTrack()?.name ?? null,
    save: g.screen === 'title' ? titleSave : null,
  });
  hudRoot.innerHTML = hudHtml(g);
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------- 啟動

const params = new URLSearchParams(location.search);
const urlSeed = params.get('seed');
const wantDaily = params.get('daily') === '1';

if (urlSeed) { clearRun(); newRun(urlSeed); }
else if (wantDaily) { clearRun(); newRun(dailySeed()); }
else { newRun(); g.screen = 'title'; refreshTitleSave(); }

resizeCanvas();
requestAnimationFrame(frame);

// 素材非同步載入，不擋開場。載完之前 render.js 走程式繪製的備援路徑。
loadAssets().then(() => ui.invalidate());

// ---------------------------------------------------------------- 測試掛鉤（Playwright / 手動除錯）

window.render_game_to_text = () => JSON.stringify(serializeState(g));
window.advanceTime = (ms) => { update(Math.max(0, Number(ms) || 0)); draw(performance.now()); };
window.game_actions = actions;
window.__game = () => g;
window.__meta = () => meta;
// 給截圖工具與手動除錯用，方便直接把遊戲擺到某個狀態
window.__debug = {
  queueDraft: (unitId, source = 'levelup') => queueDraft(g, unitId, source),
  finishRun: (won) => finishRun(g, won),
  tapBoard: (x, y) => tapBoard(g, x, y),
  setMusicMode: (m) => setMusicMode(m),
  refreshTitleSave: () => refreshTitleSave(),
  selectUnit: (id) => selectUnit(g, id),
  setActionMode: (m) => setActionMode(g, m),
  playSfx: (k, f) => playSfx(k, f),
  invalidateUi: () => ui.invalidate(),
};
window.__assets = () => assetCount();
window.__audio = () => audioState();

// 一鍵驗證：跑完一整段核心流程（開 run → 進戰鬥 → 打贏 → 回地圖）
window.test_run_full_flow = () => {
  newRun('playwright-fixture');
  const firstNode = g.map.nodes[g.currentNodeId].next[0];
  enterNode(g, firstNode);
  const enteredBattle = g.screen === 'battle';

  let guard = 0;
  // 直接把敵人打到剩 1 HP 再由我方擊殺，確保經驗與抽卡流程被觸發
  while (g.screen === 'battle' && guard++ < 200) {
    const b = g.battle;
    if (g.pending.draft) { pickDraftCard(g, g.pending.draft.cards[0].id); continue; }
    if (b.phase === 'ai') { stepEnemy(g); continue; }
    if (b.phase !== 'player') break;

    const mine = b.units.filter((u) => u.alive && u.tm === 'p');
    const foes = b.units.filter((u) => u.alive && u.tm === 'e');
    if (!mine.length || !foes.length) break;

    let acted = false;
    for (const u of mine) {
      while (u.ap > 0) {
        const foe = foes.find((f) => f.alive);
        if (!foe) break;
        foe.hp = Math.min(foe.hp, 1); // 縮短測試時間，不影響流程正確性
        foe.x = u.x;
        foe.y = Math.max(0, u.y - Math.min(u.rg, u.y));
        selectUnit(g, u.id);
        setActionMode(g, 'attack');
        const res = tapBoard(g, foe.x, foe.y);
        if (!res.ok) break;
        acted = true;
      }
    }
    if (!acted) endPlayerTurn(g);
  }

  // 肅清後應該停在通關結算畫面，按下「繼續推進」才回地圖
  const sawVictory = g.screen === 'victory' && !!g.pending.victory;
  const victoryCredits = g.pending.victory?.credits ?? 0;
  if (sawVictory) closeVictory(g);

  const state = serializeState(g);
  return {
    ok: enteredBattle && g.stats.kills > 0 && sawVictory && (g.screen === 'map' || g.screen === 'result'),
    enteredBattle,
    sawVictory,
    victoryCredits,
    kills: g.stats.kills,
    credits: g.credits,
    screen: g.screen,
    floors: FLOORS,
    squadLevels: state.squad.map((u) => u.level),
  };
};
