// 教學提示。純邏輯，不碰 DOM —— 跟 engine 一樣的規矩，這樣模擬器與測試不受影響。
//
// 刻意不做「開場一次講完」的教學。那種做法有兩個問題：
//   1. 玩家在還沒看過棋盤的時候讀規則，讀完就忘
//   2. 它會擋在遊戲前面，第二次玩的人只想快點跳過
//
// 改成「情境提示」：每一條都綁一個遊戲狀態，該用到的時候才跳出來，
// 看過一次就不再出現。玩家是在需要那個知識的當下學到它。
//
// 每條提示要回答的是「我現在該做什麼」，不是「這個系統的完整規則」。
// 完整規則放在提示裡的一兩句就好，講不完的就讓玩家自己在面板上看。

import { ELEMENTS, TUNE } from './data.js';
import { skillsOf, skillState, flankOf, dist } from './engine.js';

// 條件用 g / meta 判斷。回傳 true 就代表「現在正是講這件事的時候」。
//
// 順序就是優先順序：同一幀有多條成立時，只顯示排在前面的那一條。
// 排序原則是「玩家現在最可能卡住的事」優先。
export const TIPS = [
  // 提示要講面板沒講的東西。
  // 下面那塊編隊面板已經寫了「隨機生成、一正一負、選滿 3 人」，
  // 教學卡再抄一次就等於沒有教學 —— 它該回答的是「那我到底要怎麼選」。
  {
    id: 'recruit',
    t: '這五個人，怎麼挑三個',
    b: [
      '屬性要混。整隊同屬性碰到剋你的敵人會整場打不動，至少帶兩種。',
      '穩定性決定傷害飄不飄：狙擊期望值高但常常打歪，先鋒穩得多。想要穩就別全隊都飄。',
      '負面詞條不是「比較弱」，是「要換個用法」—— 遲緩的當定點砲台，獨行的單獨繞後。',
    ],
    when: (g) => !!g.pending.recruit,
  },
  {
    id: 'smartclick',
    t: 'AP 是走路用的，不是傷害倍率',
    b: [
      '攻擊每回合只有一次，而且要留 1 AP。所以 AP 高不等於打得多，是「選擇打誰的自由度更大」。',
      '點敵人就打、點空地就走，不用先切模式。出手完會自動跳到下一個還能動的單位。',
      '走完再打，或先打再走位躲掩體，是完全不同的兩種回合 —— 順序自己決定。',
    ],
    when: (g) => g.screen === 'battle' && g.battle?.phase === 'player' && g.battle.turn === 1,
  },
  {
    id: 'elements',
    t: '屬性相剋是三系循環',
    b: [
      '動能 → 電磁 → 裝甲 → 動能。剋制方傷害 ×1.35，被剋只有 ×0.7。',
      '每個單位左上角的徽章就是它的屬性，棋盤上一眼看得出來。',
      '「誰該打誰」比「誰血最少」重要 —— 用對屬性等於白賺一半傷害。',
    ],
    // 場上真的存在一組剋制關係時才講，不然只是背書
    // 第 3 回合才講。前三條提示如果全部擠在第一回合，玩家要連按三次「知道了」
    // 才碰得到棋盤 —— 那就變回「開場一次講完」了，只是換個包裝。
    // 用回合數錯開，每回合最多學一件事。
    when: (g) => g.screen === 'battle' && g.battle?.phase === 'player' && g.battle.turn >= 3
      && g.battle.units.some((a) => a.alive && a.tm === 'p'
        && g.battle.units.some((b) => b.alive && b.tm === 'e'
          && ELEMENTS[a.el]?.beats === b.el)),
  },
  {
    id: 'forecast',
    t: '出手前先看預測',
    b: [
      '選一個單位，面板下方會列出射程內的所有目標與傷害區間。',
      '滑鼠移到敵人身上，棋盤也會跳出同一份算式：相剋、側背、掩體、能不能一擊擊殺。',
      '傷害是區間不是固定值，區間寬度由「穩定性」決定 —— 穩定性越高打得越準。',
    ],
    when: (g) => {
      if (g.screen !== 'battle' || g.battle?.phase !== 'player' || g.battle.turn < 2) return false;
      const sel = g.battle.units.find((u) => u.id === g.battle.selectedId);
      if (!sel?.alive) return false;
      return g.battle.units.some((e) => e.alive && e.tm === 'e'
        && dist(sel.x, sel.y, e.x, e.y) <= sel.rg);
    },
  },
  {
    id: 'skill',
    t: '每個角色都有自己的主動技能',
    b: [
      '面板上的「主動技能」按一下會進入瞄準模式，棋盤上合法目標會亮起黃框，再點目標發動。',
      '技能吃冷卻（CD）也吃 AP，按鈕上直接寫著還要等幾回合。按 Esc 或再按一次可以取消。',
      '路線綁原型：先鋒會突進、狙擊會標定、工兵會補血。升到 Lv5 還會開第二個技能。',
    ],
    when: (g) => {
      if (g.screen !== 'battle' || g.battle?.phase !== 'player') return false;
      const sel = g.battle.units.find((u) => u.id === g.battle.selectedId);
      if (!sel?.alive) return false;
      return skillsOf(sel).some((id) => skillState(g, sel, id).ok);
    },
  },
  {
    id: 'flank',
    t: '繞到背後再打',
    b: [
      `背擊 ×${TUNE.FLANK_BACK}、側擊 ×${TUNE.FLANK_SIDE}。單位面朝哪邊，畫面上就是朝哪邊。`,
      '被打的人會立刻轉頭面向攻擊者 —— 繞後的優勢用一次就沒了，不能站在原地一直吃。',
      '所以先讓一個人吸引注意力，再讓另一個從後面切進去，才是這遊戲的核心操作。',
    ],
    when: (g) => {
      if (g.screen !== 'battle' || g.battle?.phase !== 'player') return false;
      return g.battle.units.some((u) => u.alive && u.tm === 'p'
        && g.battle.units.some((e) => e.alive && e.tm === 'e'
          && dist(u.x, u.y, e.x, e.y) <= u.rg && flankOf(u, e).label === '背擊'));
    },
  },
  {
    id: 'enemyturn',
    t: '看得出來是哪一隻在動',
    b: [
      '敵方回合時，正在行動的那一隻身上會有黃色虛線環與頭頂箭頭。',
      '傷害數字會浮在被打的人頭上，旁邊的小字寫著這一下為什麼是這個數字。',
    ],
    when: (g) => g.screen === 'battle' && g.battle?.phase === 'ai',
  },
  {
    id: 'draft',
    t: '升級改裝',
    b: [
      '升級時抽三張選一張。精英獎勵與補給的改裝還可以自己挑要給誰。',
      '換人不會重抽卡片 —— 每個人的三張是各自固定的，慢慢想沒關係。',
    ],
    when: (g) => !!g.pending.draft,
  },
  {
    id: 'repair',
    t: '戰後修整：現在補血還是留著變強',
    b: [
      '打贏之後可以花信用點修整。緊急修復每場只能買一次，錢有限，這是真的取捨。',
      '針對個人的項目會套用到小隊面板裡目前選定的那名幹員。',
    ],
    when: (g) => g.screen === 'victory' && !g.pending.victory?.isBoss,
  },
  {
    id: 'tree',
    t: '技能樹可以規劃',
    b: [
      '五階節點一次全部看得見，可以先想好要往哪個方向長。',
      '有技能點（SP）時才解得開，所以不必急著把點數花掉。',
    ],
    when: (g) => g.squad.some((u) => u.sp > 0),
  },
];

export const TIP_BY_ID = Object.fromEntries(TIPS.map((t) => [t.id, t]));

export function emptyTutorial(firstTime = true) {
  return { on: firstTime, seen: {} };
}

// 讀 meta 上的教學狀態，缺欄位就補（舊存檔相容）
export function tutorialOf(meta) {
  if (!meta.tutorial) meta.tutorial = emptyTutorial((meta.stats?.runs ?? 0) === 0);
  if (!meta.tutorial.seen) meta.tutorial.seen = {};
  return meta.tutorial;
}

// 現在該顯示哪一條。沒有就回 null。
export function nextTip(g, meta) {
  if (!g || !meta) return null;
  const t = tutorialOf(meta);
  if (!t.on) return null;
  if (g.screen === 'title' || g.screen === 'credits') return null;
  return TIPS.find((tip) => !t.seen[tip.id] && tip.when(g)) ?? null;
}

export function markSeen(meta, id) {
  const t = tutorialOf(meta);
  if (!TIP_BY_ID[id]) return false;
  t.seen[id] = 1;
  return true;
}

export function setTutorial(meta, on) {
  tutorialOf(meta).on = !!on;
  return meta.tutorial.on;
}

// 重看一次：清掉已讀記錄並打開。給「我想再看一遍」用。
export function resetTutorial(meta) {
  meta.tutorial = emptyTutorial(true);
  return meta.tutorial;
}

export function tutorialProgress(meta) {
  const t = tutorialOf(meta);
  return { on: t.on, seen: Object.keys(t.seen).length, total: TIPS.length };
}
