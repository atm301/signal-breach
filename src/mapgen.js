// 隨機分岔關卡樹（Slay the Spire 風格）。
// 純函式：吃一個 rng，吐一張圖。同一個 seed 一定生出同一張圖。

import { FLOORS, NODE_TYPES } from './data.js';

const PICKABLE = ['battle', 'elite', 'event', 'supply', 'shop'];

function floorWidths(rng) {
  const widths = [1]; // 登陸點
  for (let f = 1; f < FLOORS - 1; f++) {
    // 中段稍微寬一點，讓路線選擇有意義；頭尾收窄
    const mid = f > 2 && f < FLOORS - 3;
    widths.push(mid ? rng.range(2, 3) : rng.range(2, 2 + (rng.chance(0.35) ? 1 : 0)));
  }
  widths.push(1); // Boss
  return widths;
}

function pickType(rng, floor, usedInFloor) {
  // 第一層永遠是普通戰鬥，確保新玩家有個安全的開場
  if (floor === 1) return 'battle';

  const candidates = PICKABLE.filter((t) => {
    if (t === 'elite' && floor < 3) return false; // 太早遇精英會直接勸退
    if (t === 'shop' && usedInFloor.has('shop')) return false; // 同層不出兩間商店
    if (t === 'shop' && floor < 2) return false;
    // Boss 前一層固定給補給，避免血量歸零硬上
    if (floor === FLOORS - 2 && t !== 'supply' && t !== 'shop') return false;
    return true;
  });

  if (!candidates.length) return 'battle';
  const weighted = candidates.map((t) => ({ t, w: NODE_TYPES[t].w }));
  return rng.weighted(weighted).t;
}

export function generateMap(rng) {
  const widths = floorWidths(rng);
  const floors = [];
  let idCounter = 0;

  for (let f = 0; f < widths.length; f++) {
    const used = new Set();
    const row = [];
    for (let i = 0; i < widths[f]; i++) {
      let type;
      if (f === 0) type = 'start';
      else if (f === widths.length - 1) type = 'boss';
      else type = pickType(rng, f, used);
      used.add(type);
      row.push({
        id: `n${idCounter++}`,
        floor: f,
        slot: i,
        pos: (i + 0.5) / widths[f], // 0..1 的水平位置，畫圖與連線都用它
        type,
        next: [],
        visited: false,
      });
    }
    floors.push(row);
  }

  // 連線：每個節點往上連 1 到 2 個位置相近的節點
  for (let f = 0; f < floors.length - 1; f++) {
    const cur = floors[f];
    const nxt = floors[f + 1];
    for (const node of cur) {
      const sorted = nxt.slice().sort((a, b) => Math.abs(a.pos - node.pos) - Math.abs(b.pos - node.pos));
      const links = nxt.length === 1 ? 1 : rng.chance(0.45) ? 2 : 1;
      node.next = sorted.slice(0, Math.min(links, nxt.length)).map((n) => n.id);
    }
    // 補洞：上一層若有節點沒人連得到，就從最接近的下層節點補一條線
    const reached = new Set(cur.flatMap((n) => n.next));
    for (const orphan of nxt) {
      if (reached.has(orphan.id)) continue;
      let best = cur[0];
      for (const n of cur) {
        if (Math.abs(n.pos - orphan.pos) < Math.abs(best.pos - orphan.pos)) best = n;
      }
      best.next.push(orphan.id);
    }
  }

  const nodes = Object.fromEntries(floors.flat().map((n) => [n.id, n]));
  return { floors, nodes, startId: floors[0][0].id, bossId: floors[floors.length - 1][0].id };
}

// 從起點是否真的走得到 Boss。生成後一定要驗，破圖比難關卡更傷玩家。
export function isConnected(map) {
  const seen = new Set([map.startId]);
  const queue = [map.startId];
  while (queue.length) {
    const cur = map.nodes[queue.shift()];
    for (const id of cur.next) {
      if (seen.has(id)) continue;
      seen.add(id);
      queue.push(id);
    }
  }
  return seen.has(map.bossId);
}

export function generateValidMap(rng, attempts = 8) {
  for (let i = 0; i < attempts; i++) {
    const map = generateMap(rng);
    if (isConnected(map)) return map;
  }
  // 理論上到不了這裡（補洞邏輯保證連通），留著當最後防線
  throw new Error('mapgen: 連續生成失敗，關卡圖不連通');
}
