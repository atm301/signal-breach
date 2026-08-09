// 可重現的亂數來源。Roguelike 的每一次 run 都由一個 seed 完全決定，
// 這讓「分享 seed」「每日挑戰」「模擬器重跑同一場」三件事都能成立。

export function hashSeed(input) {
  const s = String(input ?? '');
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

// mulberry32：短、快、分佈夠好，適合遊戲用途
export function makeRng(seed) {
  let a = (typeof seed === 'number' ? seed : hashSeed(seed)) >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  return {
    next,
    // 內部狀態的存讀。存檔要能從「這一場已經抽到一半」的地方接回去，
    // 只記 seed 是不夠的 —— 那會讓讀檔後的後續隨機全部重跑一次。
    getState: () => a >>> 0,
    setState: (v) => { a = v >>> 0; },
    // [0, n)
    int: (n) => Math.floor(next() * n),
    // [min, max] 含頭含尾
    range: (min, max) => min + Math.floor(next() * (max - min + 1)),
    chance: (p) => next() < p,
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    shuffle: (arr) => {
      const out = arr.slice();
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    },
    // 依 weightKey 加權抽一個
    weighted: (arr, weightKey = 'w') => {
      const total = arr.reduce((s, it) => s + Math.max(0, it[weightKey] ?? 1), 0);
      if (total <= 0) return arr[0];
      let r = next() * total;
      for (const it of arr) {
        r -= Math.max(0, it[weightKey] ?? 1);
        if (r <= 0) return it;
      }
      return arr[arr.length - 1];
    },
    // 不重複抽 n 個（加權）
    weightedDraw: (arr, n, weightKey = 'w') => {
      let pool = arr.slice();
      const out = [];
      while (out.length < n && pool.length) {
        const total = pool.reduce((s, it) => s + Math.max(0, it[weightKey] ?? 1), 0);
        let r = next() * total;
        let chosen = pool[pool.length - 1];
        for (const it of pool) {
          r -= Math.max(0, it[weightKey] ?? 1);
          if (r <= 0) { chosen = it; break; }
        }
        out.push(chosen);
        pool = pool.filter((v) => v !== chosen);
      }
      return out;
    },
  };
}

// 每日挑戰用：同一天全世界同一個 seed
export function dailySeed(date = new Date()) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `daily-${y}${m}${d}`;
}

// 給玩家看的短碼，方便口頭分享
export function readableSeed(rng) {
  const A = 'ACDEFGHJKLMNPQRTUVWXY3479';
  let s = '';
  for (let i = 0; i < 6; i++) s += A[rng.int(A.length)];
  return s;
}
