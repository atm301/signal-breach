// 出擊存檔。跟 meta.js 分開：meta 是「跨局的永久進度」，這裡是「這一場打到哪」。
//
// Roguelike 一場要打 20 到 40 分鐘，沒有中途存檔的話關掉分頁就全沒了。
// 存的是整個 run 狀態，包含 RNG 的內部位置 —— 只記 seed 會讓讀檔後
// 後面所有的隨機重新來過（同一張地圖但敵人配置全變），那不是存檔，是重生。

import { makeRng, hashSeed } from './rng.js';

const KEY = 'sft_run_v1';
const VERSION = 1;

function storage() {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null; // 無痕模式
  }
}

// ---------------------------------------------------------------- 寫

export function serializeRun(g) {
  if (!g || g.screen === 'hub' || g.screen === 'title' || g.screen === 'result') return null;

  return {
    version: VERSION,
    savedAt: Date.now(),
    seed: g.seed,
    seedLabel: g.seedLabel,
    rngState: g.rng.getState(),
    // map 的 nodes 是純資料，但 floors 裡是同一批物件的參考，
    // 存的時候只留 nodes + 索引，讀回來再把 floors 重建起來。
    map: {
      nodes: g.map.nodes,
      startId: g.map.startId,
      bossId: g.map.bossId,
    },
    currentNodeId: g.currentNodeId,
    squad: g.squad,
    credits: g.credits,
    stats: g.stats,
    flags: g.flags,
    screen: g.screen,
    focusId: g.focusId,
    // Set 不能直接進 JSON
    battle: g.battle ? { ...g.battle, cover: [...g.battle.cover] } : null,
    pending: {
      draft: g.pending.draft,
      draftQueue: g.pending.draftQueue,
      event: g.pending.event,
      shop: g.pending.shop,
      supply: g.pending.supply,
      victory: g.pending.victory,
    },
    log: g.log.slice(-40),
  };
}

export function saveRun(g) {
  const s = storage();
  if (!s) return false;
  const data = serializeRun(g);
  try {
    if (!data) { s.removeItem(KEY); return false; }
    s.setItem(KEY, JSON.stringify(data));
    return true;
  } catch {
    return false; // 容量滿了之類的，不該讓遊戲當掉
  }
}

export function clearRun() {
  const s = storage();
  if (!s) return;
  try { s.removeItem(KEY); } catch { /* 忽略 */ }
}

// ---------------------------------------------------------------- 讀

// 只讀摘要，給開場畫面顯示「繼續出擊」用，不還原整場
export function peekRun() {
  const s = storage();
  if (!s) return null;
  try {
    const raw = s.getItem(KEY);
    if (!raw) return null;
    const d = JSON.parse(raw);
    if (d.version !== VERSION) return null;
    return {
      seedLabel: d.seedLabel,
      floor: d.map?.nodes?.[d.currentNodeId]?.floor ?? d.stats?.depth ?? 0,
      depth: d.stats?.depth ?? 0,
      kills: d.stats?.kills ?? 0,
      screen: d.screen,
      savedAt: d.savedAt,
      squad: (d.squad || []).map((u) => ({ n: u.n, hp: u.hp, mhp: u.mhp, lv: u.lv })),
    };
  } catch {
    return null;
  }
}

export function loadRun(meta) {
  const s = storage();
  if (!s) return null;
  let d;
  try {
    const raw = s.getItem(KEY);
    if (!raw) return null;
    d = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!d || d.version !== VERSION) return null;

  try {
    const rng = makeRng(hashSeed(d.seed));
    rng.setState(d.rngState);

    // 重建 floors：nodes 是真相來源，floors 只是同一批物件依層數分組的檢視
    const nodes = d.map.nodes;
    const floors = [];
    for (const node of Object.values(nodes)) {
      if (!floors[node.floor]) floors[node.floor] = [];
      floors[node.floor].push(node);
    }
    for (const row of floors) if (row) row.sort((a, b) => a.slot - b.slot);

    const g = {
      seed: d.seed,
      seedLabel: d.seedLabel,
      rng,
      meta,
      map: { floors, nodes, startId: d.map.startId, bossId: d.map.bossId },
      currentNodeId: d.currentNodeId,
      squad: d.squad,
      credits: d.credits,
      stats: d.stats,
      flags: d.flags,
      screen: d.screen,
      battle: d.battle ? { ...d.battle, cover: new Set(d.battle.cover) } : null,
      pending: {
        draft: d.pending?.draft ?? null,
        draftQueue: d.pending?.draftQueue ?? [],
        event: d.pending?.event ?? null,
        shop: d.pending?.shop ?? null,
        supply: d.pending?.supply ?? null,
        victory: d.pending?.victory ?? null,
      },
      result: null,
      focusId: d.focusId,
      log: d.log ?? [],
      fxQueue: [],
      sfxQueue: [],
    };

    // battle.units 裡的我方單位必須和 squad 是同一批物件，
    // 否則戰鬥中掉的血不會反映到隊伍上，讀檔後會出現兩套血量。
    if (g.battle) {
      const byId = new Map(g.squad.map((u) => [u.id, u]));
      g.battle.units = g.battle.units.map((u) => (u.tm === 'p' && byId.has(u.id) ? byId.get(u.id) : u));
      // 存檔時 squad 與 battle.units 是分開序列化的，以 battle 裡的座標為準
      for (const u of d.battle.units) {
        if (u.tm !== 'p') continue;
        const live = byId.get(u.id);
        if (live) Object.assign(live, u);
      }
    }

    return g;
  } catch {
    clearRun();
    return null;
  }
}

export { KEY as RUN_STORAGE_KEY };
