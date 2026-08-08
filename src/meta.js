// 跨 run 的永久進度。唯一會碰 localStorage 的檔案，storage 可注入方便測試。

import { META_UPGRADES, META_BY_ID } from './data.js';

const STORAGE_KEY = 'sft_meta_v1';

export function emptyMeta() {
  return {
    version: 1,
    cores: 0,
    upgrades: {},
    stats: { runs: 0, wins: 0, bestDepth: 0, totalKills: 0, totalCores: 0 },
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

export { STORAGE_KEY };
