// 組裝層：canvas、輸入、音效、meta 存檔、畫面狀態機。
// 遊戲規則一律不寫在這裡，全部在 engine.js。

import { FLOORS } from './data.js';
import {
  createGame, enterNode, tapBoard, setActionMode, endPlayerTurn, stepEnemy,
  selectUnit, spendSkillPoint, pickDraftCard, chooseEventOption, closeEvent,
  buyShopItem, leaveShop, chooseSupply, closeSupply, setFocus, finishRun,
  serializeState, log, queueDraft,
} from './engine.js';
import { loadMeta, saveMeta, buyUpgrade, recordRun, resetMeta } from './meta.js';
import { loadAssets, assetCount } from './assets.js';
import { renderBattle, renderMap, renderIdle, pickBoardTile, pickMapNode } from './render.js';
import { createUI, hudHtml } from './ui.js';
import { dailySeed } from './rng.js';

const AI_STEP_MS = 380;

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const panelRoot = document.getElementById('panel');
const hudRoot = document.getElementById('hud');

let meta = loadMeta();
let g = null;
let fxList = [];
let hoverNodeId = null;
let audioOn = true;
let audioCtx = null;
let aiAcc = 0;
let resultRecorded = false;
let lastFrame = performance.now();

// ---------------------------------------------------------------- 音效

function playSfx(kind, base) {
  if (!audioOn) return;
  try {
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      audioCtx = new AC();
    }
    const now = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    const preset = {
      move: { f: [base || 240, base || 280], d: 0.07, v: 0.02, t: 'triangle' },
      fire: { f: [base || 520, (base || 520) * 1.2], d: 0.09, v: 0.035, t: 'sawtooth' },
      hit: { f: [base || 310, (base || 310) * 0.7], d: 0.08, v: 0.028, t: 'square' },
      kill: { f: [base || 160, (base || 160) * 1.6], d: 0.22, v: 0.04, t: 'triangle' },
      level: { f: [base || 560, (base || 560) * 1.25, (base || 560) * 1.5], d: 0.26, v: 0.04, t: 'sine' },
      ui: { f: [base || 620, (base || 620) * 1.08], d: 0.1, v: 0.025, t: 'sine' },
    }[kind] || { f: [440], d: 0.08, v: 0.02, t: 'sine' };

    osc.type = preset.t;
    osc.frequency.setValueAtTime(preset.f[0], now);
    for (let i = 1; i < preset.f.length; i++) {
      osc.frequency.linearRampToValueAtTime(preset.f[i], now + (preset.d * i) / preset.f.length);
    }
    gain.gain.setValueAtTime(0.001, now);
    gain.gain.exponentialRampToValueAtTime(preset.v, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, now + preset.d);
    osc.start(now);
    osc.stop(now + preset.d + 0.02);
  } catch { /* 音效失敗不該影響遊戲 */ }
}

// ---------------------------------------------------------------- run 生命週期

function newRun(seed) {
  g = createGame({ seed, meta });
  fxList = [];
  aiAcc = 0;
  resultRecorded = false;
  ui.invalidate();
}

function toHub(abandon = false) {
  if (abandon && g && g.screen !== 'hub' && g.screen !== 'result') {
    finishRun(g, false); // 中途放棄仍然結算碎片，避免「打不過就重整頁面」變成最優解
    commitResult();
  }
  if (!g) newRun();
  g.screen = 'hub';
  ui.invalidate();
}

function commitResult() {
  if (!g?.result || resultRecorded) return;
  resultRecorded = true;
  recordRun(meta, g.result);
  saveMeta(meta);
}

// ---------------------------------------------------------------- 動作表（UI 與快捷鍵共用）

const actions = {
  audio() { audioOn = !audioOn; ui.invalidate(); },
  toHub() { toHub(true); },

  startRun() { newRun(); },
  startDaily() { newRun(dailySeed()); },
  startSeed() {
    const input = document.getElementById('seedInput');
    const value = (input?.value || '').trim();
    newRun(value || undefined);
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
  endturn() { if (endPlayerTurn(g)) aiAcc = 0; },
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
    if (id) enterNode(g, id);
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
  if (!g || g.screen !== 'map') { hoverNodeId = null; return; }
  const p = localPoint(ev);
  hoverNodeId = pickMapNode(g, canvasSize(), p.x, p.y);
});

document.addEventListener('keydown', (ev) => {
  if (!g) return;
  if (ev.target instanceof HTMLInputElement) return;
  const k = ev.key.toLowerCase();
  if (k === 'm') actions.mode('move');
  if (k === 'a') actions.mode('attack');
  if (k === 'e') actions.endturn();
  if (k === 's') actions.audio();
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
  for (const f of g.fxQueue) fxList.push({ ...f, maxLife: f.life });
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
    while (aiAcc >= AI_STEP_MS) {
      aiAcc -= AI_STEP_MS;
      stepEnemy(g);
      if (g.battle?.phase !== 'ai') break;
    }
  }

  if (g.screen === 'result') commitResult();
}

function draw(time) {
  const size = canvasSize();
  if (g.screen === 'battle' && g.battle) renderBattle(ctx, g, size, time, fxList);
  else if (g.screen === 'hub') renderIdle(ctx, g, size, '作戰基地');
  else if (g.screen === 'result') renderIdle(ctx, g, size, g.result?.won ? '出擊成功' : '出擊失敗');
  else renderMap(ctx, g, size, time, hoverNodeId);
}

function frame(now) {
  const dt = Math.min(100, Math.max(0, now - lastFrame));
  lastFrame = now;
  update(dt);
  draw(now);
  ui.render(g, meta, { audioOn });
  hudRoot.innerHTML = hudHtml(g);
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------- 啟動

const params = new URLSearchParams(location.search);
const urlSeed = params.get('seed');
const wantDaily = params.get('daily') === '1';

if (urlSeed) newRun(urlSeed);
else if (wantDaily) newRun(dailySeed());
else { newRun(); g.screen = 'hub'; }

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
};
window.__assets = () => assetCount();

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

  const state = serializeState(g);
  return {
    ok: enteredBattle && g.stats.kills > 0 && (g.screen === 'map' || g.screen === 'result'),
    enteredBattle,
    kills: g.stats.kills,
    credits: g.credits,
    screen: g.screen,
    floors: FLOORS,
    squadLevels: state.squad.map((u) => u.level),
  };
};
