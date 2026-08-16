// 跨 run 的永久進度。唯一會碰 localStorage 的檔案，storage 可注入方便測試。

import { META_UPGRADES, META_BY_ID, MAX_DEPTH } from './data.js';
import { newlyEarned } from './badges.js';

const STORAGE_KEY = 'sft_meta_v1';

export function emptyMeta() {
  return {
    version: 1,
    cores: 0,
    upgrades: {},
    stats: { runs: 0, wins: 0, bestDepth: 0, totalKills: 0, totalCores: 0, totalDrafts: 0 },
    // 已解鎖的徽章：{ id: ISO 時間 }。存時間而不是 true，
    // 之後想做「最近解鎖」都不必再改存檔格式。
    badges: {},
    // 每條準則各通關幾次。全準則資格與專精認證都要它，
    // 而且它比「掃一遍 badges」可靠 —— 徽章可以被補發，計數不會。
    doctrineWins: {},
    // 已解鎖到第幾級威脅（通關才會 +1）與「現在要打第幾級」。
    // 這兩個一定要分開存：合成一個的話，玩家挑回低威脅練功就等於把解鎖進度洗掉。
    depthMax: 0,
    depth: 0,
    // 教學預設開著：全新玩家的 runs 是 0。
    // 老玩家的舊存檔沒有這個欄位，由 tutorial.js 的 tutorialOf() 依 runs 補上，
    // 所以已經玩過的人不會突然被塞一堆提示。
    tutorial: { on: true, seen: {} },
  };
}

function safeStorage(storage) {
  if (storage) return storage;
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null; // 無痕模式或被封鎖時直接走記憶體
  }
}

export function loadMeta(storage) {
  const s = safeStorage(storage);
  if (!s) return emptyMeta();
  try {
    const raw = s.getItem(STORAGE_KEY);
    if (!raw) return emptyMeta();
    const parsed = JSON.parse(raw);
    const base = emptyMeta();
    return {
      ...base,
      ...parsed,
      upgrades: { ...base.upgrades, ...(parsed.upgrades || {}) },
      stats: { ...base.stats, ...(parsed.stats || {}) },
      badges: { ...(parsed.badges || {}) },
      doctrineWins: { ...(parsed.doctrineWins || {}) },
      depthMax: Math.max(0, Math.min(MAX_DEPTH, parsed.depthMax ?? 0)),
      depth: Math.max(0, Math.min(MAX_DEPTH, parsed.depth ?? 0)),
      // 舊存檔沒有 tutorial 欄位時留成 undefined，讓 tutorialOf() 依 runs 決定 ——
      // 在這裡直接填 base 的 { on: true } 會害老玩家讀檔後被塞滿提示
      tutorial: parsed.tutorial,
    };
  } catch {
    return emptyMeta();
  }
}

export function saveMeta(meta, storage) {
  const s = safeStorage(storage);
  if (!s) return false;
  try {
    s.setItem(STORAGE_KEY, JSON.stringify(meta));
    return true;
  } catch {
    return false;
  }
}

export function upgradeLevel(meta, id) {
  return meta.upgrades[id] ?? 0;
}

// 回傳下一階的價格；已滿階回傳 null
export function upgradeCost(meta, id) {
  const def = META_BY_ID[id];
  if (!def) return null;
  const lv = upgradeLevel(meta, id);
  if (lv >= def.max) return null;
  return def.costs[lv];
}

export function buyUpgrade(meta, id) {
  const def = META_BY_ID[id];
  if (!def) return { ok: false, reason: '升級不存在' };
  const cost = upgradeCost(meta, id);
  if (cost === null) return { ok: false, reason: '已達最高階' };
  if (meta.cores < cost) return { ok: false, reason: '核心碎片不足' };

  meta.cores -= cost;
  meta.upgrades[id] = upgradeLevel(meta, id) + 1;
  return { ok: true, level: meta.upgrades[id], spent: cost };
}

// run 結束時呼叫：入帳 + 更新統計
export function recordRun(meta, result) {
  meta.cores += result.cores;
  meta.stats.runs += 1;
  if (result.won) meta.stats.wins += 1;
  meta.stats.bestDepth = Math.max(meta.stats.bestDepth, result.depth);
  meta.stats.totalKills += result.kills;
  meta.stats.totalCores += result.cores;
  meta.stats.totalDrafts = (meta.stats.totalDrafts ?? 0) + (result.drafts ?? 0);
  if (result.won && result.doctrine) {
    meta.doctrineWins = meta.doctrineWins ?? {};
    meta.doctrineWins[result.doctrine] = (meta.doctrineWins[result.doctrine] ?? 0) + 1;
  }

  // 徽章要在上面所有累計都寫完之後才算 —— 「百次擊破」看的是
  // 含這一局在內的總擊破，先算的話會少一局，玩家會覺得徽章壞掉。
  meta.badges = meta.badges ?? {};
  const fresh = newlyEarned(meta, result);
  const now = new Date().toISOString();
  for (const id of fresh) meta.badges[id] = now;
  result.newBadges = fresh;
  // 只有真的通關才解鎖下一級。打到一半陣亡不算 —— 不然「進去送死」就是解鎖捷徑。
  if (result.won) {
    const lv = result.depthLv ?? 0;
    if (lv >= (meta.depthMax ?? 0)) meta.depthMax = Math.min(MAX_DEPTH, lv + 1);
  }
  return meta;
}

export function upgradeList(meta) {
  return META_UPGRADES.map((u) => ({
    ...u,
    level: upgradeLevel(meta, u.id),
    cost: upgradeCost(meta, u.id),
    maxed: upgradeLevel(meta, u.id) >= u.max,
  }));
}

export function resetMeta(storage) {
  const s = safeStorage(storage);
  if (s) { try { s.removeItem(STORAGE_KEY); } catch { /* 忽略 */ } }
  return emptyMeta();
}

// 選擇威脅等級。超過已解鎖的就夾回去，UI 壞掉也不會讓人跳級。
export function setDepth(meta, lv) {
  meta.depth = Math.max(0, Math.min(meta.depthMax ?? 0, lv | 0));
  return meta.depth;
}

export { STORAGE_KEY };
