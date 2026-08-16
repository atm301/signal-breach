// 成就徽章。
//
// 設計原則：徽章不是獎勵，是**目標清單**。
// 所以未解鎖的也要看得見（灰階顯示）—— 玩家看到「零傷亡：整局沒有人倒下」
// 才會去想「原來可以這樣打」。只在達成後才出現的成就等於沒有成就，
// 它只是在事後恭喜你做了本來就會做的事。
//
// 四列各一個主題，也對應素材表的 4x4 版面：
//   1 起步   一定會拿到，用來教玩家「這個系統存在」
//   2 準則   一條一個，推玩家去試沒走過的路
//   3 精通   要跨很多局才拿得到，給長期目標
//   4 技巧   同一局內做到特定的事，最難，也最值得炫耀
//
// ⚠️ cond() 必須是純函式：只讀 meta 與 result，不改任何東西。
// 有副作用的話，重新計算徽章（例如補發舊存檔）就會把進度算兩次。

export const BADGES = [
  // ── 起步 ──────────────────────────────────────────────
  {
    id: 'first-blood', row: 1, n: '首次接敵', d: '完成第一場戰鬥。',
    cond: (m, r) => (r?.battles ?? 0) >= 1,
  },
  {
    id: 'first-clear', row: 1, n: '任務達成', d: '第一次打穿最後一層。',
    cond: (m, r) => !!r?.won,
  },
  {
    id: 'first-loss', row: 1, n: '首次折損', d: '第一次全隊失去戰鬥能力。',
    cond: (m, r) => !!r && !r.won,
  },
  {
    id: 'tinkerer', row: 1, n: '技師', d: '累積抽取 50 張改裝卡。',
    cond: (m) => (m.stats?.totalDrafts ?? 0) >= 50,
  },

  // ── 準則 ──────────────────────────────────────────────
  // 這四個是整組徽章裡最重要的：它們是唯一會讓玩家主動換打法的東西。
  {
    id: 'doc-blitz', row: 2, n: '閃擊勳章', d: '以閃擊準則通關一次。',
    cond: (m, r) => !!r?.won && r.doctrine === 'blitz',
  },
  {
    id: 'doc-phalanx', row: 2, n: '密集陣勳章', d: '以密集陣準則通關一次。',
    cond: (m, r) => !!r?.won && r.doctrine === 'phalanx',
  },
  {
    id: 'doc-overwatch', row: 2, n: '制高勳章', d: '以制高準則通關一次。',
    cond: (m, r) => !!r?.won && r.doctrine === 'overwatch',
  },
  {
    id: 'doc-resonance', row: 2, n: '解析勳章', d: '以解析準則通關一次。',
    cond: (m, r) => !!r?.won && r.doctrine === 'resonance',
  },

  // ── 精通 ──────────────────────────────────────────────
  {
    id: 'all-doctrines', row: 3, n: '全準則資格', d: '四條準則各通關至少一次。',
    cond: (m) => ['blitz', 'phalanx', 'overwatch', 'resonance']
      .every((d) => (m.doctrineWins?.[d] ?? 0) >= 1),
  },
  {
    id: 'devotion', row: 3, n: '專精認證', d: '用同一條準則通關 3 次。',
    cond: (m) => Object.values(m.doctrineWins ?? {}).some((n) => n >= 3),
  },
  {
    id: 'depth3', row: 3, n: '深入敵陣', d: '在威脅 III 以上通關。',
    cond: (m, r) => !!r?.won && (r.depthLv ?? 0) >= 3,
  },
  {
    id: 'depth5', row: 3, n: '最高威脅', d: '在威脅 V 通關。',
    cond: (m, r) => !!r?.won && (r.depthLv ?? 0) >= 5,
  },

  // ── 技巧 ──────────────────────────────────────────────
  {
    id: 'flawless', row: 4, n: '零傷亡', d: '整局沒有任何人倒下，並且通關。',
    cond: (m, r) => !!r?.won && (r.downed ?? 0) === 0,
  },
  {
    id: 'swift', row: 4, n: '速戰速決', d: '通關時平均每場戰鬥不超過 6 回合。',
    cond: (m, r) => !!r?.won && (r.battles ?? 0) > 0 && r.turns / r.battles <= 6,
  },
  {
    id: 'maxed', row: 4, n: '滿編部隊', d: '通關時三名幹員都達到 Lv8 以上。',
    cond: (m, r) => !!r?.won && (r.levels?.length ?? 0) > 0
      && Math.min(...r.levels) >= 8,
  },
  {
    id: 'centurion', row: 4, n: '百次擊破', d: '累積擊破 100 台敵方單位。',
    cond: (m) => (m.stats?.totalKills ?? 0) >= 100,
  },
];

export const BADGE_BY_ID = Object.fromEntries(BADGES.map((b) => [b.id, b]));

export const BADGE_COLS = 4;
export const BADGE_ROWS = Math.max(...BADGES.map((b) => b.row));

// 這一次結算「新拿到」哪些徽章。
//
// ⚠️ 純函式，不寫入 meta —— 呼叫端負責存。
// 寫在這裡的話，UI 想預覽「差一點就拿到」就會不小心真的發出去。
export function newlyEarned(meta, result) {
  const have = meta.badges ?? {};
  return BADGES.filter((b) => !have[b.id] && b.cond(meta, result)).map((b) => b.id);
}

// 給 UI：全部徽章 + 有沒有解鎖 + 解鎖時間
export function badgeList(meta) {
  const have = meta.badges ?? {};
  return BADGES.map((b) => ({ ...b, earned: !!have[b.id], at: have[b.id] ?? null }));
}

export const badgeCount = (meta) => Object.keys(meta.badges ?? {}).length;
