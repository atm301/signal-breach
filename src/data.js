// 所有可調數值集中在這裡。改平衡只動這個檔案，不要散在邏輯裡。
// 每次改完請跑 `npm run sim` 確認勝率仍落在目標區間（見 BALANCE.md）。

export const GRID = 5;
export const FLOORS = 12; // 含起點層與 Boss 層

export const TUNE = {
  KILL_XP: 80,
  ASSIST_XP_PCT: 0.35, // 擊殺者拿全額，其他存活隊友拿這個比例，避免單一單位吃光經驗
  XP_BASE: 70,
  XP_STEP: 15,
  LEVEL_HP_GAIN: 2, // 每升一級自動加的 Max HP。卡片是隨機的，生存力不能完全靠運氣
  COVER: 1, // 掩體對遠程（距離 >= 2）的減傷
  AP_CAP: 4,
  RG_CAP: 4,
  // 核心規則：AP 只用來移動，攻擊每回合限一次（仍需 1 AP）。
  // 沒有這條的話 AP 會直接等於傷害倍率，戰鬥會在 2 回合內結束、走位完全沒意義。
  ATTACKS_PER_TURN: 1,
  ENEMY_SCALE_PER_FLOOR: 0.13, // HP 的每層成長
  ENEMY_ATK_SCALE: 0.45, // ATK 只吃 HP 成長的一部分，否則後期會變成互相一擊必殺
  // 每場勝利回復的 Max HP 比例。沒有這個的話 12 層純消耗戰必定被磨死，
  // 補給節點的出現率不足以撐住整條路線。
  WIN_HEAL_PCT: 0.25,
  ELITE_SCALE: 1.25,
  BOSS_SCALE: 1.15,
  DRAFT_SIZE: 3,
  TURN_LIMIT: 30, // 超過就強制撤退（判定為戰敗），避免龜縮與死局

  // ── 戰術深度 ──────────────────────────────────────────
  // 相剋：三系循環。剋制方吃滿，被剋方打折。
  // 這是把「打最脆的」變成「誰該打誰」的最低成本做法。
  ELEMENT_STRONG: 1.35,
  ELEMENT_WEAK: 0.7,
  // 側背：位置從「距離」升級成「角度」。朝向本來就已經在畫了，只是沒有機制意義。
  FLANK_SIDE: 1.25,
  FLANK_BACK: 1.45,
  // 傷害浮動：純亂數只是雜訊，配上「穩定性」才變成可以取捨的資源。
  // 浮動幅度 = BASE_SPREAD x (1 - stab/100)
  BASE_SPREAD: 0.45,
  // 相剋與側背讓玩家的期望傷害大幅上升（最高 1.35 x 1.45 = 1.96 倍），
  // 敵人血量要跟上，否則戰鬥會縮回 3 回合以下、通關率飆到 76%。
  ENEMY_HP_MULT: 1.63,
  // 「戰鬥要夠長」跟「戰鬥要夠痛」是兩件事，需要兩個旋鈕。
  // 只有血量的話：拉高會同時拉長戰鬥與壓垮新手，永遠只能二選一。
  ENEMY_ATK_MULT: 0.78,

  // ── 隨機幹員 ──────────────────────────────────────────
  RECRUIT_POOL: 5, // 每次出擊抽這麼多名候補
  SQUAD_SIZE: 3, // 從候補裡選這麼多人上場
  ROLL_HP: 3, // 數值抖動幅度（±）
  ROLL_STAB: 12,
  AUGMENT_STEP: 0.25, // 永久升級「詞條強化」每階把正面詞條放大這麼多
};

// ---------------------------------------------------------------- 屬性相剋

// 三系循環：動能 → 電磁 → 裝甲 → 動能
export const ELEMENTS = {
  kinetic: { n: '動能', short: '動', beats: 'emp', color: '#ffd980' },
  emp: { n: '電磁', short: '電', beats: 'armor', color: '#8fa4d8' },
  armor: { n: '裝甲', short: '甲', beats: 'kinetic', color: '#71d993' },
};

export const ELEMENT_KEYS = Object.keys(ELEMENTS);

// 攻擊方對防守方的相剋倍率
export function elementMultiplier(atkEl, defEl) {
  if (!atkEl || !defEl || atkEl === defEl) return 1;
  if (ELEMENTS[atkEl]?.beats === defEl) return TUNE.ELEMENT_STRONG;
  if (ELEMENTS[defEl]?.beats === atkEl) return TUNE.ELEMENT_WEAK;
  return 1;
}

// ---------------------------------------------------------------- 角色

// r = role code，pref 決定敵方 AI 的走位偏好
export const ROLES = {
  V: { label: '先鋒', pref: 'rush' },
  S: { label: '狙擊', pref: 'range' },
  D: { label: '無人機', pref: 'flank' },
  A: { label: '砲兵', pref: 'range' },
  B: { label: '重裝', pref: 'rush' },
  E: { label: '工兵', pref: 'flank' },
};

// 固定三人小隊。曾經把工兵設計成永久升級解鎖，但模擬顯示
// 「2 人 → 3 人」等於行動經濟直接 +50%，會讓通關率從 0% 直接跳到 52%，
// 整個難度曲線被一項升級綁架。永久升級應該給的是深度，不是行動次數。
// stab（穩定性 0-100）刻意做出差異：狙擊期望值高但很不穩，重裝穩定但平庸。
// 這樣「穩定性」才是可以取捨的資源，而不是一視同仁的雜訊。
// skins = 同一個原型的可用外觀。key 是玩法身分，skin 只是長相，
// 兩者分開才不會「換一張圖就動到平衡」。
// path 直接綁在原型上：先鋒→強襲、狙擊→偵察、工兵→支援。
// 這樣「每個角色會有不同技能」才成立，也不會出現「沒抽到路線卡整棵樹鎖住」。
export const PLAYER_TEMPLATES = [
  { key: 'vanguard', r: 'V', n: '先鋒', hp: 18, atk: 5, rg: 1, ap: 3, el: 'kinetic', stab: 72, path: 'ASSAULT', skins: ['vanguard', 'vanguardB'] },
  { key: 'sniper', r: 'S', n: '狙擊', hp: 14, atk: 5, rg: 2, ap: 2, el: 'emp', stab: 38, path: 'RECON', skins: ['sniper', 'sniperB'] },
  { key: 'engineer', r: 'E', n: '工兵', hp: 16, atk: 4, rg: 2, ap: 3, el: 'armor', stab: 60, path: 'SUPPORT', skins: ['engineer', 'engineerB'] },
];

export const PATH_NAMES = { ASSAULT: '強襲', RECON: '偵察', SUPPORT: '支援' };

// ---------------------------------------------------------------- 詞條
//
// 每名幹員固定一正一負。
//
// 負面詞條的設計準則是「逼你改變用法」，不是「單純比較弱」——
// 這是《最後的咒語》隨機英雄好玩的原因：-1 AP 的傢伙你會把他當定點砲台，
// 不會拿去繞後；手抖的狙擊手你會讓他打大目標而不是收殘血。
// 如果負面詞條只是數值扣一點，玩家的最佳解永遠是「重開直到抽到好的」。
//
// 每個詞條的「強度」寫在 v，不要寫死在 stat() 或 damageBreakdown 裡。
// 因為永久升級「詞條強化」會把正面詞條的 v 放大，強度必須是資料而不是常數。
// 放大後的值在生成當下就算好存進 u.trv，之後所有地方一律讀 u.trv ——
// 這樣「誰負責套用倍率」只有一個地方，不會出現有的效果吃到倍率、有的沒吃到。
//
// int: true 代表這是整數數值（HP / ATK / 射程 / AP），放大後要進位。
// stat(u, v) 在生成當下改數值；沒有 stat 的就是行為型，由對應的 hook 讀 u.trv。
export const TRAITS = {
  // ── 正面：數值型 ──
  veteran: { n: '老兵', good: 1, v: 4, int: 1, d: (v) => `Max HP +${v}`, stat: (u, v) => { u.mhp += v; } },
  marksman: { n: '神槍手', good: 1, v: 1, int: 1, d: (v) => `ATK +${v}`, stat: (u, v) => { u.atk += v; } },
  steady: { n: '冷靜', good: 1, v: 18, int: 1, d: (v) => `穩定性 +${v}（傷害更集中）`, stat: (u, v) => { u.stab += v; } },
  swift: { n: '迅捷', good: 1, v: 1, int: 1, d: (v) => `Max AP +${v}`, stat: (u, v) => { u.ap += v; } },
  scout: { n: '前哨', good: 1, v: 1, int: 1, d: (v) => `射程 +${v}`, stat: (u, v) => { u.rg += v; } },

  // ── 正面：出手時 ──
  flanker: { n: '側翼專家', good: 1, v: 0.2, d: (v) => `側擊與背擊的加成再 +${pct(v)}` },
  breacher: { n: '破障', good: 1, v: 1, d: () => '無視目標的掩體' },
  finisher: { n: '收割者', good: 1, v: 0.25, d: (v) => `對 HP 低於一半的目標 +${pct(v)}` },
  hunter: { n: '專精獵手', good: 1, v: 0.15, d: (v) => `屬性剋制時再 +${pct(v)}` },
  precise: { n: '精算', good: 1, v: 0.5, d: (v) => `傷害下限往上收 ${pct(v)}（不會打出低標）` },

  // ── 正面：挨打時 ──
  alert: { n: '警覺', good: 1, v: 0.2, d: (v) => `被側擊或背擊時減傷 ${pct(v)}` },
  entrench: { n: '堅守', good: 1, v: 1, int: 1, d: (v) => `自己站掩體時再減傷 ${v}` },

  // ── 正面：回合與擊殺 ──
  regen: { n: '自我修復', good: 1, v: 1, int: 1, d: (v) => `每回合開始回復 ${v} HP` },
  executioner: { n: '冷血', good: 1, v: 1, int: 1, d: (v) => `擊殺後立刻回復 ${v} AP` },
  scavenger: { n: '拾荒者', good: 1, v: 8, int: 1, d: (v) => `每次擊殺 +${v} 信用點` },
  quicklearn: { n: '快速學習', good: 1, v: 0.3, d: (v) => `獲得的經驗值 +${pct(v)}` },

  // ── 負面：數值型 ──
  oldwound: { n: '舊傷', good: 0, v: 4, int: 1, d: (v) => `Max HP −${v}`, stat: (u, v) => { u.mhp -= v; } },
  worn: { n: '損耗', good: 0, v: 1, int: 1, d: (v) => `ATK −${v}`, stat: (u, v) => { u.atk -= v; } },
  jittery: { n: '手抖', good: 0, v: 22, int: 1, d: (v) => `穩定性 −${v}（傷害更飄）`, stat: (u, v) => { u.stab -= v; } },
  sluggish: { n: '遲緩', good: 0, v: 1, int: 1, d: (v) => `Max AP −${v}`, stat: (u, v) => { u.ap -= v; } },
  nearsighted: { n: '近視', good: 0, v: 1, int: 1, d: (v) => `射程 −${v}`, stat: (u, v) => { u.rg -= v; } },

  // ── 負面：出手時 ──
  hesitant: { n: '猶豫', good: 0, v: 0.2, d: (v) => `對滿血目標 −${pct(v)}` },
  unreliable: { n: '故障頻傳', good: 0, v: 0.5, d: (v) => `傷害上限往下收 ${pct(v)}（打不出高標）` },
  panicky: { n: '恐慌', good: 0, v: 0.2, d: (v) => `自己 HP 低於一半時 −${pct(v)}` },
  loner: { n: '獨行', good: 0, v: 0.15, d: (v) => `身邊有隊友時 −${pct(v)}` },
  coward: { n: '畏縮', good: 0, v: 0.15, d: (v) => `被敵人貼身時 −${pct(v)}` },

  // ── 負面：挨打時 ──
  skittish: { n: '怯戰', good: 0, v: 0.2, d: (v) => `被側擊或背擊時額外多吃 ${pct(v)}` },
  exposed: { n: '暴露', good: 0, v: 1, d: () => '自己站掩體也沒有減傷' },
  brittle: { n: '脆弱', good: 0, v: 0.2, d: (v) => `被屬性剋制時額外多吃 ${pct(v)}` },

  // ── 負面：回合與成長 ──
  bleeding: { n: '內傷', good: 0, v: 1, int: 1, d: (v) => `每回合開始扣 ${v} HP（不會因此陣亡）` },
  dull: { n: '遲鈍', good: 0, v: 0.3, d: (v) => `獲得的經驗值 −${pct(v)}` },
  costly: { n: '揮霍', good: 0, v: 0.5, d: (v) => `對他做戰後修整貴 ${pct(v)}` },
};

function pct(v) { return `${Math.round(v * 100)}%`; }

// 詞條的實際強度。放大過的值存在 u.trv，沒有就退回基準值。
export const traitV = (u, id) => u?.trv?.[id] ?? TRAITS[id]?.v ?? 0;
export const hasTrait = (u, id) => !!u?.tr?.includes(id);

export const GOOD_TRAITS = Object.keys(TRAITS).filter((k) => TRAITS[k].good);
export const BAD_TRAITS = Object.keys(TRAITS).filter((k) => !TRAITS[k].good);

// 呼號。名字是玩家記住一名幹員的方式 ——「狙擊」記不住，「狙擊・鴉」記得住。
export const CALLSIGNS = [
  '鴉', '鐵砧', '長夜', '灰隼', '斷弦', '北斗', '銹釘', '雪盲', '子夜', '鋼齒',
  '流火', '暗潮', '無名', '空號', '磷火', '短刀', '殘響', '白噪', '鏽刃', '零度',
];

// 敵方原型。tier 決定出現在哪些節點：1=雜兵 2=中階
export const ENEMY_ARCHETYPES = [
  { key: 'grunt', r: 'V', n: '突擊兵', hp: 11, atk: 3, rg: 1, ap: 3, tier: 1, w: 40, el: 'kinetic', stab: 65 },
  { key: 'marksman', r: 'S', n: '射手', hp: 9, atk: 3, rg: 2, ap: 2, tier: 1, w: 32, el: 'emp', stab: 55 },
  { key: 'drone', r: 'D', n: '獵殺無人機', hp: 7, atk: 2, rg: 1, ap: 4, tier: 1, w: 22, el: 'emp', stab: 40 },
  { key: 'artillery', r: 'A', n: '迫擊砲組', hp: 10, atk: 4, rg: 3, ap: 1, tier: 2, w: 18, el: 'kinetic', stab: 35 },
  { key: 'brute', r: 'B', n: '重裝兵', hp: 20, atk: 5, rg: 1, ap: 2, tier: 2, w: 16, el: 'armor', stab: 78 },
];

export const BOSSES = [
  { key: 'commander', r: 'B', n: '指揮先鋒', hp: 40, atk: 7, rg: 1, ap: 3, boss: 1, el: 'armor', stab: 80 },
  { key: 'warden', r: 'A', n: '要塞守衛', hp: 36, atk: 6, rg: 3, ap: 2, boss: 1, el: 'kinetic', stab: 70 },
  { key: 'hunter', r: 'S', n: '首席獵手', hp: 34, atk: 6, rg: 3, ap: 3, boss: 1, el: 'emp', stab: 50 },
];

// ---------------------------------------------------------------- 技能樹

export const PASS = {
  A2: 'A2', A3: 'A3', A4: 'A4', A5: 'A5',
  R2: 'R2', R3: 'R3', R4: 'R4', R5: 'R5',
  S2: 'S2', S4: 'S4', S6: 'S6',
};

// ---------------------------------------------------------------- 主動技能
//
// 為什麼用「冷卻回合」而不是魔力值：
//
// 1. 代幣上已經沒有位置了。屬性徽章、AP 點、已出手標記、血條、識別標記
//    全都擠在同一個 66-130px 的圓上，再加一條魔力條會把剪影糊掉。
// 2. 魔力要配一整套「怎麼回、去哪補」的系統；冷卻不用，它自己就講完了。
// 3. 一場戰鬥平均 4.2 回合。CD3 的技能一場最多放兩次 ——
//    那本來就是「什麼時候放」的決策，不會變成每回合按同一顆。
//    XCOM 的技能冷卻落在 2 到 4 回合，正是同一個理由。
//
// 花費規則（對齊《最後的咒語》「每個攻擊技能至少 1 AP」）：
//   - 攻擊型技能收 1 AP：它取代你這回合的攻擊，就是一次更好的攻擊
//   - 輔助型收 2 AP：它是「多出來的一次行動」，不佔攻擊次數
//
// 為什麼輔助型要貴一倍：行動經濟是這遊戲最強的槓桿（見 BALANCE.md 決策 2，
// 「2 人變 3 人」讓通關率從 0% 跳到 52%）。輔助技能等於每隔幾回合多一次行動，
// 第一版統一收 1 AP，meta=max 通關率直接從 52.5% 衝到 84.1%。
// 收 2 AP 之後「放技能」要拿走位去換，那才是取捨。
//
// target：enemy = 敵人所在格、ally = 我方所在格（含自己）、empty = 空格
export const SKILLS = {
  charge: {
    n: '突進斬',
    d: '衝到目標旁並攻擊，傷害 ×1.3',
    cd: 3,
    ap: 1,
    range: 3,
    target: 'enemy',
    attack: 1,
    mult: 1.2,
  },
  shockwave: {
    n: '震波',
    d: '對所有相鄰敵人造成 75% 傷害',
    cd: 4,
    ap: 1,
    range: 1,
    target: 'self',
    attack: 1,
    mult: 0.6,
  },
  mark: {
    n: '標定',
    d: '標記目標 2 回合，全隊對它傷害 +25%',
    cd: 3,
    ap: 2,
    range: 3,
    target: 'enemy',
    attack: 0,
    turns: 2,
    v: 0.25,
  },
  blink: {
    n: '相位轉移',
    d: '傳送到 3 格內的空格，不耗移動力',
    cd: 3,
    ap: 2,
    range: 3,
    target: 'empty',
    attack: 0,
  },
  patch: {
    n: '應急修補',
    d: '治療一名隊友 25% Max HP',
    cd: 4,
    ap: 2,
    range: 2,
    target: 'ally',
    attack: 0,
    v: 0.25,
  },
  jam: {
    n: '電磁干擾',
    d: '造成 60% 傷害，並使目標下回合無法攻擊',
    cd: 5,
    ap: 1,
    range: 2,
    target: 'enemy',
    attack: 1,
    mult: 0.6,
    turns: 1,
  },
};

// 狀態效果。存成 { id: 剩餘回合 }，每個我方回合開始時遞減。
export const STATUS = {
  marked: { n: '標定', d: '受到的傷害 +30%', bad: 1 },
  stunned: { n: '干擾', d: '無法攻擊', bad: 1 },
};

// 技能樹：三條路線各 5 階，被動與主動交錯。
//
// 路線直接綁原型（先鋒→強襲、狙擊→偵察、工兵→支援），不再靠抽卡開通。
// 這樣「每個角色會有不同技能」才成立，也解掉「沒抽到路線卡整棵樹鎖住」——
// 那種鎖法讓運氣差的一局連系統都摸不到。
//
// 五階一次全部看得見（《最後的咒語》的做法）：玩家可以先規劃 build，
// 而不是每次升級才發現下一個節點是什麼。
//
// free: 1 = 出場就送。第一版把主動技能放在 Lv3、要花技能點才開，
// 結果新玩家整場平均只解鎖 1.25 / 5 個節點 —— 招牌功能對他們是隱形的。
// 現在每個人一上場就帶著自己路線的招牌技能，技能樹的角色變成「延伸升級」。
export const TREE = {
  ASSAULT: [
    { lv: 2, id: 'charge', skill: 'charge', free: 1 },
    { lv: 3, id: PASS.A2, n: '過載驅動', d: 'Max AP +1' },
    { lv: 4, id: PASS.A4, n: '強化裝甲', d: 'Max HP +3' },
    { lv: 5, id: 'shockwave', skill: 'shockwave' },
    { lv: 6, id: PASS.A5, n: '破障協定', d: '攻擊無視掩體' },
  ],
  RECON: [
    { lv: 2, id: 'mark', skill: 'mark', free: 1 },
    { lv: 3, id: PASS.R2, n: '目標鎖定', d: 'Range +1' },
    { lv: 4, id: PASS.R4, n: '匿蹤披覆', d: '站掩體時再減傷 1' },
    { lv: 5, id: 'blink', skill: 'blink' },
    { lv: 6, id: PASS.R5, n: '獵標系統', d: '遠程傷害 +1' },
  ],
  SUPPORT: [
    { lv: 2, id: 'patch', skill: 'patch', free: 1 },
    { lv: 3, id: PASS.S2, n: '維修協定', d: '每回合開始，相鄰隊友 +1 HP' },
    { lv: 4, id: PASS.S4, n: '護盾投射', d: '相鄰隊友受到的傷害 −1' },
    { lv: 5, id: 'jam', skill: 'jam' },
    { lv: 6, id: PASS.S6, n: '超載充能', d: '自己所有技能冷卻 −1' },
  ],
};

// 節點的顯示名稱與說明：主動技能的文字寫在 SKILLS，這裡統一取出來
export function treeNodeInfo(node) {
  if (!node.skill) return { n: node.n, d: node.d, skill: null };
  const s = SKILLS[node.skill];
  return { n: s.n, d: `${s.d}（冷卻 ${s.cd} 回合・${s.ap} AP${s.attack ? '・算攻擊' : ''}）`, skill: node.skill };
}

// ---------------------------------------------------------------- 卡池

export const RARITY = { COMMON: '普通', RARE: '稀有', EPIC: '史詩' };

export const CARDS = [
  { id: 'atk', w: 70, r: RARITY.COMMON, n: '火力校正', d: 'ATK +1', price: 45 },
  { id: 'mhp', w: 70, r: RARITY.COMMON, n: '裝甲升級', d: 'Max HP +2 並回復 2', price: 45 },
  { id: 'rg', w: 25, r: RARITY.RARE, n: '感測擴域', d: `Range +1（上限 ${TUNE.RG_CAP}）`, price: 85 },
  { id: 'ap', w: 25, r: RARITY.RARE, n: '反應爐擴充', d: `Max AP +1（上限 ${TUNE.AP_CAP}）並回復 1`, price: 85 },
  { id: 'sp', w: 25, r: RARITY.RARE, n: '戰術資料包', d: '技能點 +1', price: 80 },
  { id: 'ul', w: 22, r: RARITY.RARE, n: '免費節點解鎖', d: '直接解鎖下一個技能樹節點', price: 90 },
  // 路線改成綁原型之後，原本的兩張「路線」卡沒有意義了。
  // 換成兩張跟主動技能有關的稀有卡，讓技能系統也有卡片可以強化。
  { id: 'stab', w: 22, r: RARITY.RARE, n: '陀螺穩定器', d: '穩定性 +12（傷害更集中）', price: 80 },
  { id: 'cool', w: 8, r: RARITY.EPIC, n: '散熱超載', d: '所有技能冷卻 −1（最低 1）', price: 140 },
  { id: 'sp2', w: 6, r: RARITY.EPIC, n: '深度簡報', d: '技能點 +2', price: 150 },

  // ── 會改變玩法的卡 ──────────────────────────────────────
  // 上面九張全是數值卡：抽到什麼都只是「變強一點」，不會變成
  // 「這局我要換個打法」。下面這些每一張都改寫一條規則，
  // 而且各自掛在不同的 hook 上，所以會互相組合出不同玩法。
  { id: 'riposte', w: 16, r: RARITY.RARE, n: '反擊模組', d: '被近戰攻擊後自動還擊（60% 傷害）', price: 95, mod: 1 },
  { id: 'guard', w: 16, r: RARITY.RARE, n: '協防裝置', d: '相鄰隊友受到的傷害 −2，改由自己承受 1', price: 95, mod: 1 },
  { id: 'chain', w: 14, r: RARITY.RARE, n: '連鎖擊發', d: '擊破敵人後，立刻對相鄰目標追打一次（70% 傷害）', price: 100, mod: 1 },
  { id: 'ambush', w: 12, r: RARITY.RARE, n: '伏擊姿態', d: '自己站在掩體上時，攻擊 +30%', price: 100, mod: 1 },
  { id: 'adapt', w: 8, r: RARITY.EPIC, n: '適應塗層', d: '每場戰鬥開始時，屬性自動改成剋制場上最多敵人的那一系', price: 155, mod: 1 },
  { id: 'momentum', w: 8, r: RARITY.EPIC, n: '蓄能', d: '整個回合沒有攻擊，下一次攻擊 +60%', price: 155, mod: 1 },
];

export const CARD_BY_ID = Object.fromEntries(CARDS.map((c) => [c.id, c]));

// ---------------------------------------------------------------- 威脅等級
//
// 通關之後的問題是「我贏了，然後呢」。原本打倒 Boss 跟死在 F3 走同一條路。
// 每通關一次解鎖下一級，修正累積疊加，玩家自己選要不要挑戰。
//
// ⚠️ 梯子要有一根單調遞增的骨幹（hpMult），其他修正疊在上面當風味。
// 共用同一個 hpMult 的話會出現「高一階反而比較簡單」。
// 威脅等級：通關之後才存在的那一層。
//
// ⚠️ 這裡的 hpMult 是整條階梯的骨幹，必須單調遞增。
// 只靠「抽卡少一張、狀況必定出現」這種風味修正做不出難度階梯 ——
// 實測過：那些修正的效果會被隨機性吃掉，第 2 級反而比第 1 級好打。
//
// 增幅刻意做得比同引擎的另一款小：Signal Breach 的基礎難度本來就高，
// 同樣的倍率乘上去會直接把上面幾級變成 0% 的裝飾品。
export const DEPTHS = [
  { lv: 0, n: '標準', d: '沒有額外修正。', bonus: 1.0 },
  { lv: 1, n: '威脅 I', bonus: 1.15, hpMult: 1.04, d: '敵人 HP +4%。' },
  {
    lv: 2, n: '威脅 II', bonus: 1.3, hpMult: 1.08, pool: 4, draftSize: 2,
    d: '敵人 HP +8%。徵召名單少一人，升級抽卡只給兩張。',
  },
  {
    lv: 3, n: '威脅 III', bonus: 1.5, hpMult: 1.12, pool: 4, draftSize: 2, alwaysCond: 1,
    d: '敵人 HP +12%。每一場都必定有戰場狀況。',
  },
  {
    lv: 4, n: '威脅 IV', bonus: 1.75, hpMult: 1.16, pool: 4, draftSize: 2, alwaysCond: 1, atkMult: 1.06,
    d: '敵人 HP +16%、ATK +6%。',
  },
  {
    lv: 5, n: '威脅 V', bonus: 2.0, hpMult: 1.20, pool: 4, draftSize: 2, alwaysCond: 1,
    atkMult: 1.06, healPct: 0.15, bossCond: 1,
    d: '敵人 HP +20%、ATK +6%。戰後自動修復砍半，頭目戰必定帶狀況。',
  },
];

export const MAX_DEPTH = DEPTHS.length - 1;
export const depthOf = (lv) => DEPTHS[Math.max(0, Math.min(MAX_DEPTH, lv | 0))];


// ---------------------------------------------------------------- 戰場狀況
//
// 每一層抽一個。同一批敵人在不同狀況下是完全不同的問題 ——
// 這比做新敵人便宜太多，而且逼玩家每場重新想。
//
// 三個約束：開打前就看得到、不能有「純粹更難」的、不能讓玩家無法應對。
export const CONDITIONS = [
  { id: 'clear', n: '無異常', d: '沒有特殊狀況。', w: 45, plain: 1 },
  {
    id: 'jam', n: '電子干擾', w: 14,
    d: '雙方射程 −1（最低 1）。遠程失去距離優勢，貼身成為主戰場。',
    onStart: (g) => { for (const u of g.battle.units) u.rg = Math.max(1, u.rg - 1); },
  },
  {
    id: 'deadline', n: '撤離倒數', w: 12, turnLimit: 12,
    d: '回合上限縮短為 12。拖不起，必須主動壓上去。',
  },
  {
    id: 'debris', n: '殘骸密佈', w: 12, extraCover: 1,
    d: '掩體加倍。遠程更安全，但也更難把人逼出來。',
  },
  {
    id: 'surge', n: '敵方增援', w: 12, surgeTurn: 3,
    d: '第 3 回合會有一名敵方增援進場。速戰速決，或準備接第二波。',
  },
  {
    id: 'unstable', n: '大氣擾動', w: 10, spreadMult: 2,
    d: '雙方傷害浮動加倍。穩定性高的單位這一場特別值錢。',
  },
  {
    id: 'overclock', n: '反應爐超載', w: 10,
    d: '雙方 Max AP +1。走位空間變大，繞背與集火都更容易。',
    onStart: (g) => {
      for (const u of g.battle.units) { u.map = Math.min(TUNE.AP_CAP, u.map + 1); u.ap = u.map; }
    },
  },
];
export const CONDITION_BY_ID = Object.fromEntries(CONDITIONS.map((c) => [c.id, c]));

// ---------------------------------------------------------------- 掩體佈局

export const COVER_PATTERNS = [
  { n: '四角', tiles: ['1,1', '3,1', '1,3', '3,3'] },
  { n: '十字', tiles: ['2,0', '2,1', '2,2', '2,3', '2,4'] },
  { n: '雙線', tiles: ['0,1', '2,1', '4,1', '0,3', '2,3', '4,3'] },
  { n: '對角', tiles: ['0,0', '1,1', '2,2', '3,3', '4,4'] },
  { n: '雙牆', tiles: ['1,1', '2,1', '3,1', '1,3', '2,3', '3,3'] },
  { n: '散佈', tiles: ['0,2', '2,0', '2,2', '2,4', '4,2'] },
  { n: '走廊', tiles: ['1,0', '1,2', '3,2', '3,4'] },
  { n: '堡壘', tiles: ['0,1', '1,1', '3,1', '4,1', '1,3', '2,3', '3,3'] },
  { n: '疏散', tiles: ['0,0', '4,0', '2,2', '0,4', '4,4'] },
];

// ---------------------------------------------------------------- 節點

// icon 刻意用中文字與粗符號：⚔ / ☠ 這類字符在節點的小尺寸下筆畫太細，辨識不出來
export const NODE_TYPES = {
  battle: { n: '交火', icon: '戰', w: 55 },
  elite: { n: '精英', icon: '精', w: 12 },
  event: { n: '訊號', icon: '？', w: 15 },
  supply: { n: '補給', icon: '補', w: 12 },
  shop: { n: '黑市', icon: '市', w: 6 },
  boss: { n: '頭目', icon: '★', w: 0 },
  start: { n: '登陸點', icon: '▲', w: 0 },
};

// ---------------------------------------------------------------- 事件
// 效果全部作用在「全隊」或「隨機單位」，避免需要額外的選單去指定目標。

export const EVENTS = [
  {
    id: 'derelict_pod',
    n: '廢棄補給艙',
    d: '一具沒有標記的補給艙卡在岩縫裡，艙門的封條被人動過。',
    opts: [
      { d: '拆開醫療包（全隊回復 6 HP）', fx: [{ t: 'heal', v: 6 }] },
      { d: '拆下值錢的零件（+45 信用點）', fx: [{ t: 'credits', v: 45 }] },
      {
        d: '強行破解主鎖（有風險）',
        risk: { p: 0.55, ok: [{ t: 'card', rarity: RARITY.RARE }], bad: [{ t: 'damage', v: 4 }] },
      },
    ],
  },
  {
    id: 'mil_terminal',
    n: '軍用終端機',
    d: '終端機還在跑舊政權的系統，電池撐不了多久。',
    opts: [
      { d: '下載戰術資料（隨機一名隊員 +1 技能點）', fx: [{ t: 'sp', v: 1 }] },
      { d: '賣掉存取權（+70 信用點）', fx: [{ t: 'credits', v: 70 }] },
      { d: '入侵敵方補給（下場戰鬥敵人 HP -15%）', fx: [{ t: 'weaken', v: 0.15 }] },
    ],
  },
  {
    id: 'smuggler',
    n: '走私販',
    d: '一個穿著三層外套的人從陰影裡走出來，行李箱打開一半。',
    opts: [
      { d: '買一張稀有改裝（-50 信用點）', cost: 50, fx: [{ t: 'card', rarity: RARITY.RARE }] },
      { d: '買醫療補給（-30 信用點，全隊回 8 HP）', cost: 30, fx: [{ t: 'heal', v: 8 }] },
      { d: '轉身就走', fx: [] },
    ],
  },
  {
    id: 'signal_anomaly',
    n: '訊號異常',
    d: '一段來源不明的訊號正在改寫你隊員的神經植入物。',
    opts: [
      { d: '讓它跑完（隨機一名隊員 ATK +2、Max HP -3）', fx: [{ t: 'buffAtk', v: 2 }, { t: 'buffHp', v: -3 }] },
      { d: '反向注入（隨機一名隊員 Max HP +5、ATK -1）', fx: [{ t: 'buffHp', v: 5 }, { t: 'buffAtk', v: -1 }] },
      { d: '切斷連線（+25 信用點）', fx: [{ t: 'credits', v: 25 }] },
    ],
  },
  {
    id: 'crashed_transport',
    n: '墜毀運輸艦',
    d: '船體還在冒煙，貨艙的鎖已經燒斷了。',
    opts: [
      { d: '搜刮裝甲板（全隊 Max HP +2 並回滿）', fx: [{ t: 'buffAllHp', v: 2 }, { t: 'healFull' }] },
      { d: '搜刮資料核心（隨機隊員共 +2 技能點）', fx: [{ t: 'sp', v: 2 }] },
      {
        d: '拆卸反應爐（賭一把）',
        risk: { p: 0.5, ok: [{ t: 'credits', v: 120 }], bad: [{ t: 'creditsPct', v: -0.5 }] },
      },
    ],
  },
  {
    id: 'old_comrade',
    n: '舊識',
    d: '一個你以為早就陣亡的人，蹲在補給箱後面朝你揮手。',
    opts: [
      { d: '請他歸隊（-80 信用點，全隊回滿並 +1 技能點）', cost: 80, fx: [{ t: 'healFull' }, { t: 'sp', v: 1 }] },
      { d: '給他一份補給就好（+40 信用點的情報）', fx: [{ t: 'credits', v: 40 }] },
    ],
  },
  {
    id: 'minefield',
    n: '未清除的雷區',
    d: '感測器顯示前方有壓力式地雷，繞路要多花半天。',
    opts: [
      { d: '繞路（安全，+20 信用點的沿途拾荒）', fx: [{ t: 'credits', v: 20 }] },
      {
        d: '直接穿過（快，但有風險）',
        risk: { p: 0.6, ok: [{ t: 'credits', v: 90 }], bad: [{ t: 'damage', v: 5 }] },
      },
    ],
  },
];

// ---------------------------------------------------------------- 商店

export const SHOP_SERVICES = [
  { id: 'heal', n: '野戰醫療', d: '全隊回復 8 HP', price: 55, fx: [{ t: 'heal', v: 8 }] },
  { id: 'sp', n: '教官指導', d: '隨機一名隊員 +1 技能點', price: 75, fx: [{ t: 'sp', v: 1 }] },
  { id: 'armor', n: '裝甲翻新', d: '全隊 Max HP +2 並回復 2', price: 95, fx: [{ t: 'buffAllHp', v: 2 }, { t: 'heal', v: 2 }] },
];

// ---------------------------------------------------------------- Meta 永久升級

export const META_UPGRADES = [
  { id: 'hp', n: '裝甲儲備', d: '全隊起始 Max HP +2', max: 4, costs: [20, 35, 55, 80] },
  { id: 'atk', n: '火力校準', d: '全隊起始 ATK +1', max: 2, costs: [30, 70] },
  { id: 'ap', n: '反應爐預熱', d: '全隊起始 Max AP +1', max: 1, costs: [90] },
  { id: 'credits', n: '補給合約', d: '每 run 起始信用點 +25', max: 3, costs: [25, 45, 70] },
  { id: 'draft', n: '情報網', d: '升級抽卡改為 4 選 1', max: 1, costs: [120] },
  { id: 'revive', n: '緊急醫療', d: '每 run 一次，隊員陣亡時以 1 HP 復活', max: 1, costs: [150] },
  { id: 'veteran', n: '老兵編制', d: '全隊起始 Lv.2，並立即各獲得一次改裝抽卡', max: 1, costs: [200] },
  { id: 'shop', n: '黑市門路', d: '商店與走私販價格每階 -10%', max: 2, costs: [40, 80] },
  // ── 詞條相關（買了之後編隊畫面才會變好看） ──
  // ⚠️ 這三個是超加成的：雙專長給兩個正面、強化把兩個都放大、篩選再拿掉負面，
  // 三者相乘。第一版（篩選 x2 / 強化 +40% x2 / 雙專長）把 meta=max 從 53% 推到 79%，
  // 各自量到只有 +4.6 / +2.5 / +9.8，加起來卻是 +25.6。動任何一個都要三個一起重量。
  { id: 'screening', n: '幹員篩選', d: '候補名單裡有 1 名「沒有負面詞條」的幹員', max: 1, costs: [140] },
  { id: 'augment', n: '詞條強化', d: '所有正面詞條的效果每階 +25%（負面不變）', max: 2, costs: [130, 220] },
  { id: 'dualperk', n: '雙專長', d: '每名幹員多帶一個正面詞條', max: 1, costs: [300] },
];

export const META_BY_ID = Object.fromEntries(META_UPGRADES.map((u) => [u.id, u]));

// run 結束時把成績換成永久貨幣（核心碎片）
export function coresEarned({ depth, kills, eliteKills, won }) {
  return Math.max(1, Math.round(depth * 3 + kills * 1 + eliteKills * 5 + (won ? 40 : 0)));
}

// ---------------------------------------------------------------- 作者的話
// 這段是要給玩家讀的，不是註解。改文案直接動這裡。

export const CREDITS = [
  {
    h: null,
    p: [
      '我不是遊戲開發者。我是做行銷的。',
      '這個東西是 2026 年 8 月初，我用 Claude Code 花幾天做出來的。一開始只是想試試看「AI 到底能不能做遊戲」，結果做著做著就變成一個真的能玩完的 Roguelike。',
    ],
  },
  {
    h: '最有價值的一件事',
    p: [
      '不是 AI 幫我寫了幾千行程式，是它幫我寫了一個自動試玩機器人。',
      '那支程式會在背景跑幾千場完整的遊戲，然後告訴我：你的戰鬥平均只有 1.9 回合就結束，走位完全沒有意義。',
      '我自己玩不出這個結論。玩三場只會覺得「好像有點快」。',
      '後來那條「AP 只能移動、攻擊每回合限一次」的規則，就是被那份報告逼出來的。改完之後戰鬥變成 4 到 6 回合，掩體跟站位才開始有價值。',
    ],
  },
  {
    h: 'AI 做不到的部分',
    p: [
      '美術是 AI 生的，音樂是程式即時合成的，一個音檔都沒有。',
      '但有一個 bug 藏了整整一天：所有單位都鑲了一圈不透明的黑框。因為底色是深藍、貼在深色棋盤上，看起來就是正常的。測試全綠，我也看過截圖，沒人發現。',
      '直到我讓單位轉向面對敵人，那圈黑框跟著旋轉，才變成明顯的黑色方塊。',
      'AI 可以驗證程式對不對，驗證不了看起來對不對。這件事到現在還是要靠人眼。',
    ],
  },
  {
    h: '關於難度',
    p: [
      '第一次玩你大概會死在第 5 到 8 層。那是設計好的。',
      '模擬器說新玩家平均走到第 7.8 層，27% 的人會摸到頭目但打不過。死掉不是你的問題，是永久升級還沒開始給你力量。',
      '多打幾場。',
    ],
  },
];

export const CREDITS_META = {
  author: '何佳勳',
  handle: '@chia.hsun301',
  org: '圭話行銷 ATMarketing',
  site: 'atmarketing.tw',
  repo: 'github.com/atm301/signal-breach',
  builtWith: ['Claude Code（程式與平衡）', 'gpt-image-1（美術）', 'Web Audio（音樂與音效）'],
};
