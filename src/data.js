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
  ENEMY_HP_MULT: 1.23,

  // ── 隨機幹員 ──────────────────────────────────────────
  RECRUIT_POOL: 5, // 每次出擊抽這麼多名候補
  SQUAD_SIZE: 3, // 從候補裡選這麼多人上場
  ROLL_HP: 3, // 數值抖動幅度（±）
  ROLL_STAB: 12,
  FLANKER_BONUS: 0.2, // 「側翼專家」在側背時額外加的倍率
  SKITTISH_PENALTY: 0.2, // 「怯戰」被側背時額外吃的倍率
  FINISHER_BONUS: 0.25, // 「收割者」對殘血目標的加成
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
export const PLAYER_TEMPLATES = [
  { key: 'vanguard', r: 'V', n: '先鋒', hp: 18, atk: 5, rg: 1, ap: 3, el: 'kinetic', stab: 72, skins: ['vanguard', 'vanguardB'] },
  { key: 'sniper', r: 'S', n: '狙擊', hp: 14, atk: 5, rg: 2, ap: 2, el: 'emp', stab: 38, skins: ['sniper', 'sniperB'] },
  { key: 'engineer', r: 'E', n: '工兵', hp: 16, atk: 4, rg: 2, ap: 3, el: 'armor', stab: 60, skins: ['engineer', 'engineerB'] },
];

// ---------------------------------------------------------------- 詞條
//
// 每名幹員固定一正一負。
//
// 負面詞條的設計準則是「逼你改變用法」，不是「單純比較弱」——
// 這是《最後的咒語》隨機英雄好玩的原因：-1 AP 的傢伙你會把他當定點砲台，
// 不會拿去繞後；手抖的狙擊手你會讓他打大目標而不是收殘血。
// 如果負面詞條只是數值扣一點，玩家的最佳解永遠是「重開直到抽到好的」。
//
// stat(u) 在生成當下改數值；behave 的詞條由 damageBreakdown 直接讀 u.tr。
export const TRAITS = {
  // ── 正面 ──
  veteran: { n: '老兵', d: 'Max HP +4', good: 1, stat: (u) => { u.mhp += 4; } },
  marksman: { n: '神槍手', d: 'ATK +1', good: 1, stat: (u) => { u.atk += 1; } },
  steady: { n: '冷靜', d: '穩定性 +18（傷害更集中）', good: 1, stat: (u) => { u.stab += 18; } },
  swift: { n: '迅捷', d: 'Max AP +1', good: 1, stat: (u) => { u.ap += 1; } },
  scout: { n: '前哨', d: '射程 +1', good: 1, stat: (u) => { u.rg += 1; } },
  flanker: { n: '側翼專家', d: '側擊與背擊的加成再 +20%', good: 1 },
  breacher: { n: '破障', d: '無視目標的掩體', good: 1 },
  finisher: { n: '收割者', d: '對 HP 低於一半的目標 +25%', good: 1 },

  // ── 負面 ──
  oldwound: { n: '舊傷', d: 'Max HP −4', good: 0, stat: (u) => { u.mhp -= 4; } },
  worn: { n: '損耗', d: 'ATK −1', good: 0, stat: (u) => { u.atk -= 1; } },
  jittery: { n: '手抖', d: '穩定性 −22（傷害更飄）', good: 0, stat: (u) => { u.stab -= 22; } },
  sluggish: { n: '遲緩', d: 'Max AP −1', good: 0, stat: (u) => { u.ap -= 1; } },
  nearsighted: { n: '近視', d: '射程 −1', good: 0, stat: (u) => { u.rg -= 1; } },
  skittish: { n: '怯戰', d: '被側擊或背擊時額外多吃 20%', good: 0 },
  exposed: { n: '暴露', d: '自己站掩體也沒有減傷', good: 0 },
  hesitant: { n: '猶豫', d: '對滿血目標 −20%', good: 0 },
};

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
};

export const TREE = {
  ASSAULT: [
    { lv: 2, id: PASS.A2, n: '過載驅動', d: 'Max AP +1' },
    { lv: 3, id: PASS.A3, n: '震盪刃', d: '近戰傷害 +1' },
    { lv: 4, id: PASS.A4, n: '強化裝甲', d: 'Max HP +3' },
    { lv: 5, id: PASS.A5, n: '破障協定', d: '攻擊無視掩體' },
  ],
  RECON: [
    { lv: 2, id: PASS.R2, n: '目標鎖定', d: 'Range +1' },
    { lv: 3, id: PASS.R3, n: '機動模組', d: 'Max AP +1' },
    { lv: 4, id: PASS.R4, n: '匿蹤披覆', d: '站掩體時再減傷 1' },
    { lv: 5, id: PASS.R5, n: '獵標系統', d: '遠程傷害 +1' },
  ],
};

// ---------------------------------------------------------------- 卡池

export const RARITY = { COMMON: '普通', RARE: '稀有', EPIC: '史詩' };

export const CARDS = [
  { id: 'atk', w: 70, r: RARITY.COMMON, n: '火力校正', d: 'ATK +1', price: 45 },
  { id: 'mhp', w: 70, r: RARITY.COMMON, n: '裝甲升級', d: 'Max HP +2 並回復 2', price: 45 },
  { id: 'rg', w: 25, r: RARITY.RARE, n: '感測擴域', d: `Range +1（上限 ${TUNE.RG_CAP}）`, price: 85 },
  { id: 'ap', w: 25, r: RARITY.RARE, n: '反應爐擴充', d: `Max AP +1（上限 ${TUNE.AP_CAP}）並回復 1`, price: 85 },
  { id: 'sp', w: 25, r: RARITY.RARE, n: '戰術資料包', d: '技能點 +1', price: 80 },
  { id: 'ul', w: 22, r: RARITY.RARE, n: '免費節點解鎖', d: '直接解鎖下一個技能樹節點', price: 90 },
  { id: 'pa', w: 6, r: RARITY.EPIC, n: '路線：強襲', d: '選定強襲路線並解鎖 Lv2 節點', price: 130 },
  { id: 'pr', w: 6, r: RARITY.EPIC, n: '路線：偵察', d: '選定偵察路線並解鎖 Lv2 節點', price: 130 },
];

export const CARD_BY_ID = Object.fromEntries(CARDS.map((c) => [c.id, c]));

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
