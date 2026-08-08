// 純邏輯遊戲引擎：不碰 document / window / Audio。
// 這是刻意的 —— tools/simulate.mjs 直接在 node 裡 import 這個檔案跑幾百場來驗平衡。
// 特效與音效只是「往佇列丟一筆事件」，由渲染層決定怎麼播。

import {
  GRID, FLOORS, TUNE, ROLES, PLAYER_TEMPLATES, ENEMY_ARCHETYPES, BOSSES,
  TREE, PASS, CARDS, CARD_BY_ID, COVER_PATTERNS, EVENTS, SHOP_SERVICES,
  RARITY, coresEarned,
} from './data.js';
import { makeRng, hashSeed, readableSeed } from './rng.js';
import { generateValidMap } from './mapgen.js';

// ---------------------------------------------------------------- 小工具

export const key = (x, y) => `${x},${y}`;
export const dist = (x1, y1, x2, y2) => Math.abs(x1 - x2) + Math.abs(y1 - y2);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

let uidCounter = 0;
const uid = () => `u${(uidCounter++).toString(36)}`;

function emit(g, queue, payload) {
  const q = g[queue];
  q.push(payload);
  if (q.length > 64) q.splice(0, q.length - 64); // 模擬器不會消費佇列，這裡自己封頂
}
const fx = (g, payload) => emit(g, 'fxQueue', payload);
const sfx = (g, kind, freq) => emit(g, 'sfxQueue', { kind, freq });

export function log(g, text, important = false) {
  g.log.push({ text, important });
  if (g.log.length > 200) g.log.shift();
}

// ---------------------------------------------------------------- 建立 run

function metaLevel(meta, id) {
  return meta?.upgrades?.[id] ?? 0;
}

function buildSquad(meta) {
  const hpBonus = metaLevel(meta, 'hp') * 2;
  const atkBonus = metaLevel(meta, 'atk') * 1;
  const apBonus = metaLevel(meta, 'ap') >= 1 ? 1 : 0;

  return PLAYER_TEMPLATES
    .map((t) => ({
      id: uid(),
      tm: 'p',
      key: t.key,
      r: t.r,
      n: t.n,
      mhp: t.hp + hpBonus,
      hp: t.hp + hpBonus,
      atk: t.atk + atkBonus,
      rg: t.rg,
      map: clamp(t.ap + apBonus, 1, TUNE.AP_CAP),
      ap: 0,
      lv: 1,
      xp: 0,
      sp: 0,
      path: null,
      pass: [],
      ul: {},
      alive: 1,
      attacked: 0,
      x: 0,
      y: 0,
      hurtMs: 0,
      fireMs: 0,
    }));
}

export function createGame({ seed, meta = { upgrades: {} } } = {}) {
  const seedInput = seed ?? Math.floor(Math.random() * 1e9);
  const rng = makeRng(hashSeed(seedInput));
  const labelRng = makeRng(hashSeed(`${seedInput}-label`));

  const g = {
    seed: String(seedInput),
    seedLabel: readableSeed(labelRng),
    rng,
    meta,
    map: generateValidMap(rng),
    currentNodeId: null,
    squad: buildSquad(meta),
    credits: metaLevel(meta, 'credits') * 25,
    stats: { depth: 0, kills: 0, eliteKills: 0, battles: 0, turns: 0 },
    flags: {
      weaken: 0,
      reviveLeft: metaLevel(meta, 'revive') >= 1 ? 1 : 0,
      seenEvents: [],
    },
    screen: 'map',
    battle: null,
    pending: { draft: null, draftQueue: [], event: null, shop: null, supply: null, victory: null },
    result: null,
    focusId: null,
    log: [],
    fxQueue: [],
    sfxQueue: [],
  };

  g.focusId = g.squad[0]?.id ?? null;
  g.currentNodeId = g.map.startId;
  g.map.nodes[g.map.startId].visited = true;
  log(g, `登陸完成。種子 ${g.seedLabel}`, true);

  // 老兵編制：全隊起始 Lv.2，各給一次抽卡
  if (metaLevel(meta, 'veteran') >= 1) {
    for (const u of g.squad) {
      u.lv = 2;
      u.mhp += TUNE.LEVEL_HP_GAIN;
      u.hp += TUNE.LEVEL_HP_GAIN;
      queueDraft(g, u.id, 'levelup');
    }
    log(g, '老兵編制生效：全隊以 Lv.2 出擊。', true);
  }

  log(g, '選擇一條推進路線。');
  return g;
}

// 從目前節點可以走到哪幾個節點
export function availableNodes(g) {
  if (!g.currentNodeId) return [];
  return g.map.nodes[g.currentNodeId].next.map((id) => g.map.nodes[id]);
}

export function squadAlive(g) {
  return g.squad.filter((u) => u.alive);
}

export function focusUnit(g) {
  return g.squad.find((u) => u.id === g.focusId) || g.squad[0] || null;
}

export function setFocus(g, id) {
  if (g.squad.some((u) => u.id === id)) g.focusId = id;
}

// ---------------------------------------------------------------- 進入節點

export function enterNode(g, nodeId) {
  if (g.screen !== 'map') return false;
  const allowed = availableNodes(g).some((n) => n.id === nodeId);
  if (!allowed) return false;

  const node = g.map.nodes[nodeId];
  g.currentNodeId = nodeId;
  node.visited = true;
  g.stats.depth = Math.max(g.stats.depth, node.floor);

  switch (node.type) {
    case 'battle':
    case 'elite':
    case 'boss':
      startBattle(g, node);
      break;
    case 'event':
      openEvent(g, node);
      break;
    case 'shop':
      openShop(g);
      break;
    case 'supply':
      openSupply(g);
      break;
    default:
      g.screen = 'map';
  }
  return true;
}

// ---------------------------------------------------------------- 戰鬥生成

function coverFor(g) {
  const pattern = g.rng.pick(COVER_PATTERNS);
  let tiles = pattern.tiles.map((t) => {
    const [x, y] = t.split(',').map(Number);
    return { x, y };
  });
  if (g.rng.chance(0.5)) tiles = tiles.map((t) => ({ x: GRID - 1 - t.x, y: t.y }));
  if (g.rng.chance(0.35)) tiles = tiles.map((t) => ({ x: t.y, y: t.x }));
  return new Set(tiles.map((t) => key(t.x, t.y)));
}

function enemyCount(g, node) {
  const f = node.floor;
  let base;
  if (f <= 4) base = 2;
  else if (f <= 8) base = g.rng.range(2, 3);
  else base = 3;
  if (node.type === 'elite') base += 1;
  if (node.type === 'boss') base = 3;
  return Math.min(4, base); // 5x5 的場地放不下更多，也會讓走位失去意義
}

function scaleFor(node) {
  const floorScale = 1 + (node.floor - 1) * TUNE.ENEMY_SCALE_PER_FLOOR;
  if (node.type === 'elite') return floorScale * TUNE.ELITE_SCALE;
  if (node.type === 'boss') return floorScale * TUNE.BOSS_SCALE;
  return floorScale;
}

function makeEnemy(g, archetype, scale, index) {
  const spawns = [[4, 0], [2, 0], [3, 1], [1, 0], [3, 0], [1, 1]];
  const [x, y] = spawns[index] || [index % GRID, 0];
  const hp = Math.max(3, Math.round(archetype.hp * scale * (1 - g.flags.weaken)));
  return {
    id: uid(),
    tm: 'e',
    key: archetype.key,
    r: archetype.r,
    n: archetype.n,
    boss: archetype.boss ? 1 : 0,
    mhp: hp,
    hp,
    atk: Math.max(1, Math.round(archetype.atk * (1 + (scale - 1) * TUNE.ENEMY_ATK_SCALE))),
    rg: archetype.rg,
    map: archetype.ap,
    ap: archetype.ap,
    lv: 1,
    pass: [],
    alive: 1,
    attacked: 0,
    x,
    y,
    hurtMs: 0,
    fireMs: 0,
  };
}

function rollEnemies(g, node) {
  const scale = scaleFor(node);
  const count = enemyCount(g, node);
  const out = [];

  if (node.type === 'boss') {
    out.push(makeEnemy(g, g.rng.pick(BOSSES), scale, 0));
    const adds = ENEMY_ARCHETYPES.filter((a) => a.tier === 1);
    for (let i = 1; i < count; i++) out.push(makeEnemy(g, g.rng.pick(adds), scale * 0.8, i));
    return out;
  }

  const maxTier = node.floor >= 4 || node.type === 'elite' ? 2 : 1;
  const pool = ENEMY_ARCHETYPES.filter((a) => a.tier <= maxTier);
  for (let i = 0; i < count; i++) out.push(makeEnemy(g, g.rng.weighted(pool), scale, i));
  return out;
}

export function startBattle(g, node) {
  const alive = squadAlive(g);
  alive.forEach((u, i) => {
    u.x = i;
    u.y = GRID - 1;
    u.ap = u.map;
    u.attacked = 0;
  });

  g.battle = {
    nodeId: node.id,
    nodeType: node.type,
    floor: node.floor,
    cover: coverFor(g),
    units: [...alive, ...rollEnemies(g, node)],
    turn: 1,
    phase: 'player',
    actionMode: 'move',
    selectedId: alive[0]?.id ?? null,
    aiQueue: [],
    downed: [],
  };
  g.flags.weaken = 0; // 一次性 debuff，用掉就清
  g.screen = 'battle';
  g.stats.battles++;
  g.stats.turns++; // 第 1 回合也要算，否則統計出來的戰鬥長度會少一回合

  const label = node.type === 'boss' ? '頭目戰' : node.type === 'elite' ? '精英交戰' : '交火';
  log(g, `第 ${node.floor} 層 ${label} 開始。`, true);
}

// ---------------------------------------------------------------- 戰鬥查詢

export const battleUnits = (g) => g.battle?.units ?? [];
export const aliveOf = (g, team) => battleUnits(g).filter((u) => u.alive && u.tm === team);
export const unitAt = (g, x, y) => battleUnits(g).find((u) => u.alive && u.x === x && u.y === y) || null;
export const unitById = (g, id) => battleUnits(g).find((u) => u.id === id) || null;

export function reachableTiles(g, u) {
  const out = [];
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      if (x === u.x && y === u.y) continue;
      if (unitAt(g, x, y)) continue;
      const cost = dist(u.x, u.y, x, y);
      if (cost <= u.ap) out.push({ x, y, cost });
    }
  }
  return out;
}

export function damageOf(g, attacker, target, d) {
  const bonusMelee = d === 1 && attacker.pass.includes(PASS.A3) ? 1 : 0;
  const bonusRanged = d >= 2 && attacker.pass.includes(PASS.R5) ? 1 : 0;
  let reduction = 0;
  if (d >= 2 && g.battle.cover.has(key(target.x, target.y)) && !attacker.pass.includes(PASS.A5)) {
    reduction = TUNE.COVER + (target.pass.includes(PASS.R4) ? 1 : 0);
  }
  return Math.max(1, attacker.atk + bonusMelee + bonusRanged - reduction);
}

// ---------------------------------------------------------------- 戰鬥行動

export function selectUnit(g, id) {
  const u = unitById(g, id);
  if (u && u.tm === 'p' && u.alive) g.battle.selectedId = id;
}

export function setActionMode(g, mode) {
  if (g.battle?.phase === 'player') g.battle.actionMode = mode;
}

export function moveUnit(g, u, x, y) {
  if (!u.alive || u.ap <= 0) return { ok: false, reason: 'AP 不足' };
  if (x < 0 || y < 0 || x >= GRID || y >= GRID) return { ok: false, reason: '超出戰場' };
  if (unitAt(g, x, y)) return { ok: false, reason: '格子已被佔用' };
  const cost = dist(u.x, u.y, x, y);
  if (cost < 1 || cost > u.ap) return { ok: false, reason: `移動距離需在 1 到 ${u.ap} 之間` };

  u.x = x;
  u.y = y;
  u.ap -= cost;
  fx(g, { type: 'pulse', x, y, color: u.tm === 'p' ? '#5db6ff' : '#ff8678', life: 220, size: 1 });
  sfx(g, 'move');
  return { ok: true, cost };
}

export function attackUnit(g, attacker, target) {
  if (!attacker.alive || !target.alive) return { ok: false, reason: '單位已陣亡' };
  if (attacker.ap < 1) return { ok: false, reason: 'AP 不足' };
  if (attacker.attacked >= TUNE.ATTACKS_PER_TURN) return { ok: false, reason: '本回合已經攻擊過了' };
  const d = dist(attacker.x, attacker.y, target.x, target.y);
  if (d > attacker.rg) return { ok: false, reason: '超出射程' };

  attacker.ap -= 1;
  attacker.attacked = (attacker.attacked || 0) + 1;
  attacker.fireMs = 160;
  const dmg = damageOf(g, attacker, target, d);
  target.hp -= dmg;
  target.hurtMs = 240;

  fx(g, {
    type: 'beam',
    from: { x: attacker.x, y: attacker.y },
    to: { x: target.x, y: target.y },
    color: attacker.tm === 'p' ? '#7cd6ff' : '#ffad9b',
    life: 140,
  });
  fx(g, { type: 'impact', x: target.x, y: target.y, color: '#fff2b7', life: 200, size: 1.2 });
  sfx(g, 'fire', attacker.rg >= 2 ? 780 : 430);
  sfx(g, 'hit', 320);
  log(g, `${attacker.n} 攻擊 ${target.n}，造成 ${dmg} 點傷害。`);

  let killed = false;
  if (target.hp <= 0) {
    target.hp = 0;
    // 緊急醫療：每 run 一次，把我方單位從 0 拉回 1 HP
    if (target.tm === 'p' && g.flags.reviveLeft > 0) {
      g.flags.reviveLeft = 0;
      target.hp = 1;
      log(g, `緊急醫療啟動，${target.n} 以 1 HP 撐住。`, true);
      fx(g, { type: 'pulse', x: target.x, y: target.y, color: '#8fffad', life: 400, size: 2 });
      sfx(g, 'level', 620);
    } else {
      target.alive = 0;
      killed = true;
      fx(g, {
        type: 'burst', x: target.x, y: target.y,
        color: target.tm === 'p' ? '#6ebeff' : '#ff8b7d', life: 320, size: 1.6,
      });
      sfx(g, 'kill', 180);
      log(g, `${target.n} 被擊破。`, true);
      if (target.tm === 'e') onEnemyKilled(g, attacker, target);
      else g.battle.downed.push(target.id);
    }
  }

  checkBattleEnd(g);
  return { ok: true, dmg, killed };
}

// 玩家點擊棋盤格的統一入口
export function tapBoard(g, x, y) {
  const b = g.battle;
  if (!b || b.phase !== 'player') return { ok: false, reason: '目前不是我方回合' };
  if (g.pending.draft) return { ok: false, reason: '請先完成升級抽卡' };

  const clicked = unitAt(g, x, y);
  if (clicked && clicked.tm === 'p' && clicked.alive) {
    b.selectedId = clicked.id;
    return { ok: true, action: 'select' };
  }

  const sel = unitById(g, b.selectedId);
  if (!sel || !sel.alive) return { ok: false, reason: '請先選擇我方單位' };

  if (b.actionMode === 'move') return moveUnit(g, sel, x, y);
  if (!clicked || clicked.tm !== 'e') return { ok: false, reason: '攻擊模式請點擊敵人' };
  return attackUnit(g, sel, clicked);
}

// ---------------------------------------------------------------- 經驗與升級

export function xpToNext(lv) {
  return TUNE.XP_BASE + (lv - 1) * TUNE.XP_STEP;
}

function grantXp(g, unit, amount) {
  if (!unit.alive || unit.tm !== 'p' || amount <= 0) return;
  unit.xp += amount;
  while (unit.xp >= xpToNext(unit.lv)) {
    unit.xp -= xpToNext(unit.lv);
    unit.lv++;
    // 每級固定 +1 Max HP：卡片是隨機的，生存力不能完全靠運氣
    unit.mhp += TUNE.LEVEL_HP_GAIN;
    unit.hp += TUNE.LEVEL_HP_GAIN;
    fx(g, { type: 'pulse', x: unit.x, y: unit.y, color: '#8fffad', life: 320, size: 1.7 });
    sfx(g, 'level', 560);
    log(g, `${unit.n} 升到 Lv.${unit.lv}`, true);
    queueDraft(g, unit.id);
  }
}

function onEnemyKilled(g, killer, victim) {
  g.stats.kills++;
  if (g.battle.nodeType === 'elite' || victim.boss) g.stats.eliteKills++;
  if (killer.tm !== 'p') return;
  grantXp(g, killer, TUNE.KILL_XP);
  // 隊友分潤，避免整個 run 只有一個單位在長
  const assist = Math.round(TUNE.KILL_XP * TUNE.ASSIST_XP_PCT);
  for (const mate of aliveOf(g, 'p')) {
    if (mate.id !== killer.id) grantXp(g, mate, assist);
  }
}

// ---------------------------------------------------------------- 抽卡

function draftSize(g) {
  return TUNE.DRAFT_SIZE + (metaLevel(g.meta, 'draft') >= 1 ? 1 : 0);
}

function cardPoolFor(g, u) {
  return CARDS.filter((c) => {
    if (c.id === 'rg') return u.rg < TUNE.RG_CAP;
    if (c.id === 'ap') return u.map < TUNE.AP_CAP;
    if (c.id === 'pa' || c.id === 'pr') return !u.path && u.lv >= 2;
    if (c.id === 'ul') return !!nextTreeNode(u);
    return true;
  });
}

export function queueDraft(g, unitId, source = 'levelup') {
  const u = g.squad.find((v) => v.id === unitId);
  if (!u) return;
  const pool = cardPoolFor(g, u);
  if (!pool.length) return;
  const cards = g.rng.weightedDraw(pool, draftSize(g));
  g.pending.draftQueue.push({ unitId, cards, source });
  if (!g.pending.draft) openNextDraft(g);
}

function openNextDraft(g) {
  const next = g.pending.draftQueue.shift();
  g.pending.draft = next ?? null;
}

export function pickDraftCard(g, cardId) {
  const draft = g.pending.draft;
  if (!draft) return false;
  const u = g.squad.find((v) => v.id === draft.unitId);
  if (!u) return false;
  if (!draft.cards.some((c) => c.id === cardId)) return false;

  applyCard(g, u, cardId);
  log(g, `${u.n} 選擇了「${CARD_BY_ID[cardId]?.n ?? cardId}」`, true);
  sfx(g, 'ui', 620);
  if (u.alive && g.battle) {
    fx(g, { type: 'pulse', x: u.x, y: u.y, color: '#8fffad', life: 240, size: 1.3 });
  }
  g.pending.draft = null;
  openNextDraft(g);
  return true;
}

export function applyCard(g, u, id) {
  switch (id) {
    case 'atk': u.atk += 1; break;
    case 'mhp': u.mhp += 2; u.hp = Math.min(u.mhp, u.hp + 2); break;
    case 'rg': u.rg = Math.min(TUNE.RG_CAP, u.rg + 1); break;
    case 'ap':
      u.map = Math.min(TUNE.AP_CAP, u.map + 1);
      u.ap = Math.min(u.map, u.ap + 1);
      break;
    case 'sp': u.sp += 1; break;
    case 'pa': if (!u.path) { u.path = 'ASSAULT'; unlockNode(g, u, 2); } break;
    case 'pr': if (!u.path) { u.path = 'RECON'; unlockNode(g, u, 2); } break;
    case 'ul': { const n = nextTreeNode(u); if (n) unlockNode(g, u, n.lv); break; }
    default: break;
  }
}

// ---------------------------------------------------------------- 技能樹

export function nextTreeNode(u) {
  if (!u.path) return null;
  return TREE[u.path].find((n) => !u.ul[n.lv] && u.lv >= n.lv) || null;
}

function applyPassiveImmediate(g, u, id) {
  if (id === PASS.A2 || id === PASS.R3) {
    u.map = Math.min(TUNE.AP_CAP, u.map + 1);
    u.ap = Math.min(u.map, u.ap + 1);
  }
  if (id === PASS.R2) u.rg = Math.min(TUNE.RG_CAP, u.rg + 1);
  if (id === PASS.A4) { u.mhp += 3; u.hp = Math.min(u.mhp, u.hp + 3); }
}

export function unlockNode(g, u, lv) {
  if (!u.path) return false;
  const node = TREE[u.path].find((n) => n.lv === lv);
  if (!node || u.ul[lv]) return false;
  u.ul[lv] = 1;
  if (!u.pass.includes(node.id)) u.pass.push(node.id);
  applyPassiveImmediate(g, u, node.id);
  return true;
}

// 玩家在技能樹面板花技能點解鎖
export function spendSkillPoint(g, unitId, lv) {
  const u = g.squad.find((v) => v.id === unitId);
  if (!u) return { ok: false, reason: '找不到單位' };
  if (!u.path) return { ok: false, reason: '尚未選擇路線' };
  if (u.sp <= 0) return { ok: false, reason: '技能點不足' };
  if (u.ul[lv]) return { ok: false, reason: '此節點已解鎖' };
  if (u.lv < lv) return { ok: false, reason: `需要 Lv.${lv}` };
  const node = TREE[u.path].find((n) => n.lv === lv);
  if (!node) return { ok: false, reason: '節點不存在' };

  u.sp -= 1;
  unlockNode(g, u, lv);
  sfx(g, 'ui', 680);
  log(g, `${u.n} 解鎖「${node.n}」`, true);
  return { ok: true };
}

// ---------------------------------------------------------------- 回合流程

export function endPlayerTurn(g) {
  const b = g.battle;
  if (!b || b.phase !== 'player') return false;
  if (g.pending.draft) return false;
  b.phase = 'ai';
  b.selectedId = null;
  b.aiQueue = aliveOf(g, 'e').map((u) => u.id);
  return true;
}

function bestTarget(g, u, targets) {
  let best = null;
  for (const t of targets) {
    const d = dist(u.x, u.y, t.x, t.y);
    const inRange = d <= u.rg ? 0 : 1;
    // 越低血、越近、越打得到，分數越低（取最小）
    const score = inRange * 100 + d * 2 + (t.hp / Math.max(1, t.mhp)) * 6;
    if (!best || score < best.score) best = { t, score };
  }
  return best?.t ?? null;
}

function bestMove(g, u, targets) {
  const pref = ROLES[u.r]?.pref ?? 'rush';
  const tiles = reachableTiles(g, u);
  if (!tiles.length) return null;

  let best = null;
  for (const tile of tiles) {
    const remaining = u.ap - tile.cost;
    let minDist = Infinity;
    let weakest = Infinity;
    for (const t of targets) {
      const d = dist(tile.x, tile.y, t.x, t.y);
      if (d < minDist) minDist = d;
      if (d <= u.rg) weakest = Math.min(weakest, t.hp);
    }
    const canShoot = minDist <= u.rg && remaining >= 1;

    let score = 0;
    if (canShoot) score += 100 + remaining * 6;
    score -= minDist * 4;
    if (g.battle.cover.has(key(tile.x, tile.y))) score += pref === 'range' ? 10 : 4;
    if (pref === 'range' && minDist <= 1) score -= 18; // 狙擊/砲兵不想被貼身
    if (pref === 'flank' && Number.isFinite(weakest)) score += 8; // 無人機專咬殘血
    score += g.rng.next() * 3; // 一點抖動，避免每場都走同一格

    if (!best || score > best.score) best = { ...tile, score };
  }
  return best;
}

// 一個敵方單位的完整行動：先走位，再打一發（攻擊每回合限一次）
function actEnemy(g, u) {
  let living = aliveOf(g, 'p');
  if (!living.length) return;

  let target = bestTarget(g, u, living);
  const canShootFromHere = target && dist(u.x, u.y, target.x, target.y) <= u.rg;

  if (!canShootFromHere && u.ap > 0) {
    const move = bestMove(g, u, living);
    if (move && move.cost <= u.ap) moveUnit(g, u, move.x, move.y);
    living = aliveOf(g, 'p');
    target = bestTarget(g, u, living);
  }

  if (target && u.alive && !u.attacked && u.ap >= 1 && dist(u.x, u.y, target.x, target.y) <= u.rg) {
    attackUnit(g, u, target);
  }
  u.ap = 0; // 一回合只行動一次
}

// 執行「一個敵方單位的完整行動」。回傳 true 代表還有敵人沒動完。
export function stepEnemy(g) {
  const b = g.battle;
  if (!b || b.phase !== 'ai') return false;

  if (!aliveOf(g, 'p').length) { checkBattleEnd(g); return false; }

  const id = b.aiQueue.shift();
  if (!id) { beginPlayerTurn(g); return false; }

  const u = unitById(g, id);
  if (u && u.alive) actEnemy(g, u);

  if (b.phase !== 'ai') return false;
  if (!b.aiQueue.length) { beginPlayerTurn(g); return false; }
  return true;
}

// 模擬器與測試用：把整個敵方回合一次跑完
export function runEnemyPhase(g) {
  let guard = 0;
  while (g.battle?.phase === 'ai' && guard++ < 40) stepEnemy(g);
}

function beginPlayerTurn(g) {
  const b = g.battle;
  b.turn++;
  g.stats.turns++;

  // 回合上限：防止龜縮打消耗，也擋掉雙方互相搆不到造成的死局
  if (b.turn > TUNE.TURN_LIMIT) {
    log(g, `超過 ${TUNE.TURN_LIMIT} 回合仍未肅清，撤退訊號發出。`, true);
    b.phase = 'lose';
    onBattleLose(g);
    return;
  }

  b.phase = 'player';
  b.actionMode = 'move';
  for (const u of battleUnits(g)) {
    if (!u.alive) continue;
    u.ap = u.map;
    u.attacked = 0;
  }
  b.selectedId = aliveOf(g, 'p')[0]?.id ?? null;
  if (b.turn === TUNE.TURN_LIMIT - 5) log(g, `警告：剩下 5 個回合就會被迫撤退。`, true);
  log(g, `第 ${b.turn} 回合，我方行動。`, true);
}

function checkBattleEnd(g) {
  const b = g.battle;
  if (!b || b.phase === 'win' || b.phase === 'lose') return;
  if (!aliveOf(g, 'p').length) { b.phase = 'lose'; onBattleLose(g); return; }
  if (!aliveOf(g, 'e').length) { b.phase = 'win'; onBattleWin(g); }
}

// ---------------------------------------------------------------- 戰鬥結算

function creditsForNode(g, node) {
  if (node.type === 'boss') return 120;
  if (node.type === 'elite') return 45 + node.floor * 3;
  return 18 + node.floor * 2;
}

function onBattleWin(g) {
  const node = g.map.nodes[g.battle.nodeId];
  const gain = creditsForNode(g, node);
  g.credits += gain;

  // 戰後自動修復一小段，補給節點負責大回復
  const healPct = node.type === 'elite' ? TUNE.WIN_HEAL_PCT * 1.5 : TUNE.WIN_HEAL_PCT;
  const healed = [];
  for (const u of aliveOf(g, 'p')) {
    const before = u.hp;
    u.hp = Math.min(u.mhp, u.hp + Math.max(1, Math.round(u.mhp * healPct)));
    if (u.hp > before) healed.push({ name: u.n, amount: u.hp - before, hp: u.hp, mhp: u.mhp });
  }

  // 陣亡隊員以 35% Max HP 歸隊：失誤要有代價，但不該一次失誤就直接崩盤
  const recovered = [];
  for (const id of g.battle.downed) {
    const u = g.squad.find((v) => v.id === id);
    if (!u) continue;
    u.alive = 1;
    u.hp = Math.max(1, Math.round(u.mhp * 0.35));
    recovered.push({ name: u.n, hp: u.hp });
    log(g, `${u.n} 被拖回運輸艦，以 ${u.hp} HP 歸隊。`);
  }

  // 停在勝利畫面，不要直接彈回地圖。
  // 「打倒最後一個敵人」是一場戰鬥的高潮，沒有結算畫面等於把那個瞬間吃掉。
  g.pending.victory = {
    nodeType: node.type,
    floor: node.floor,
    credits: gain,
    turns: g.battle.turn,
    kills: g.battle.units.filter((u) => u.tm === 'e' && !u.alive).length,
    healed,
    recovered,
    eliteReward: node.type === 'elite',
    isBoss: node.type === 'boss',
  };
  g.screen = 'victory';
  sfx(g, 'victory');
  log(g, `敵人已肅清，取得 ${gain} 信用點。`, true);
}

// 玩家按下「繼續推進」之後才真正離開戰場
export function closeVictory(g) {
  const v = g.pending.victory;
  if (!v) return false;
  g.pending.victory = null;

  if (v.eliteReward) {
    const target = focusUnit(g);
    if (target) {
      queueDraft(g, target.id, 'elite');
      log(g, `精英目標清除，${target.n} 獲得一次改裝機會。`, true);
    }
  }

  if (v.isBoss) {
    finishRun(g, true);
    return true;
  }

  g.battle = null;
  g.screen = 'map';
  return true;
}

function onBattleLose(g) {
  log(g, '全隊失去戰鬥能力。', true);
  sfx(g, 'defeat');
  finishRun(g, false);
}

export function finishRun(g, won) {
  const cores = coresEarned({
    depth: g.stats.depth,
    kills: g.stats.kills,
    eliteKills: g.stats.eliteKills,
    won,
  });
  g.result = {
    won,
    cores,
    depth: g.stats.depth,
    kills: g.stats.kills,
    eliteKills: g.stats.eliteKills,
    battles: g.stats.battles,
    turns: g.stats.turns,
    seedLabel: g.seedLabel,
    seed: g.seed,
  };
  g.battle = null;
  // run 已經結束，任何還開著的抽卡／事件／商店面板都要收掉，
  // 否則玩家會在結算畫面上幫一個死掉的 run 選卡片。
  g.pending.draft = null;
  g.pending.draftQueue = [];
  g.pending.event = null;
  g.pending.shop = null;
  g.pending.supply = null;
  g.pending.victory = null;
  g.screen = 'result';
  log(g, won ? `任務完成，取得 ${cores} 核心碎片。` : `任務失敗，回收 ${cores} 核心碎片。`, true);
}

// ---------------------------------------------------------------- 效果套用（事件 / 商店 / 補給共用）

function randomLivingUnit(g) {
  const alive = squadAlive(g);
  return alive.length ? g.rng.pick(alive) : null;
}

export function applyEffects(g, effects) {
  for (const e of effects) {
    switch (e.t) {
      case 'heal':
        for (const u of squadAlive(g)) u.hp = Math.min(u.mhp, u.hp + e.v);
        log(g, `全隊回復 ${e.v} HP。`);
        break;
      case 'healPct':
        for (const u of squadAlive(g)) u.hp = Math.min(u.mhp, u.hp + Math.round(u.mhp * e.v));
        log(g, `全隊回復 ${Math.round(e.v * 100)}% Max HP。`);
        break;
      case 'healFull':
        for (const u of squadAlive(g)) u.hp = u.mhp;
        log(g, '全隊回復至滿血。');
        break;
      case 'damage':
        for (const u of squadAlive(g)) u.hp = Math.max(1, u.hp - e.v);
        log(g, `全隊損失 ${e.v} HP。`, true);
        break;
      case 'credits':
        g.credits = Math.max(0, g.credits + e.v);
        log(g, `信用點 ${e.v >= 0 ? '+' : ''}${e.v}。`);
        break;
      case 'creditsPct': {
        const delta = Math.round(g.credits * e.v);
        g.credits = Math.max(0, g.credits + delta);
        log(g, `信用點 ${delta >= 0 ? '+' : ''}${delta}。`, true);
        break;
      }
      case 'sp': {
        for (let i = 0; i < e.v; i++) {
          const u = randomLivingUnit(g);
          if (u) { u.sp += 1; log(g, `${u.n} 獲得 1 點技能點。`); }
        }
        break;
      }
      case 'buffAtk': {
        const u = randomLivingUnit(g);
        if (u) { u.atk = Math.max(1, u.atk + e.v); log(g, `${u.n} ATK ${e.v >= 0 ? '+' : ''}${e.v}。`); }
        break;
      }
      case 'buffHp': {
        const u = randomLivingUnit(g);
        if (u) {
          u.mhp = Math.max(3, u.mhp + e.v);
          u.hp = Math.min(u.mhp, Math.max(1, u.hp + Math.max(0, e.v)));
          log(g, `${u.n} Max HP ${e.v >= 0 ? '+' : ''}${e.v}。`);
        }
        break;
      }
      case 'buffAllHp':
        for (const u of g.squad) { u.mhp += e.v; u.hp = Math.min(u.mhp, u.hp + Math.max(0, e.v)); }
        log(g, `全隊 Max HP +${e.v}。`);
        break;
      case 'weaken':
        g.flags.weaken = e.v;
        log(g, `已入侵敵方補給，下場戰鬥敵人 HP -${Math.round(e.v * 100)}%。`, true);
        break;
      case 'card': {
        const u = focusUnit(g);
        if (u) {
          const pool = cardPoolFor(g, u).filter((c) => !e.rarity || c.r === e.rarity);
          const usable = pool.length ? pool : cardPoolFor(g, u);
          if (usable.length) {
            const card = g.rng.weighted(usable);
            applyCard(g, u, card.id);
            log(g, `${u.n} 取得「${card.n}」。`, true);
          }
        }
        break;
      }
      default:
        break;
    }
  }
}

// ---------------------------------------------------------------- 事件節點

function openEvent(g, node) {
  const unseen = EVENTS.filter((e) => !g.flags.seenEvents.includes(e.id));
  const pool = unseen.length ? unseen : EVENTS;
  const chosen = g.rng.pick(pool);
  g.flags.seenEvents.push(chosen.id);
  g.pending.event = { ...chosen, floor: node.floor, resolved: null };
  g.screen = 'event';
  log(g, `訊號節點：${chosen.n}`, true);
}

export function chooseEventOption(g, index) {
  const ev = g.pending.event;
  if (!ev || ev.resolved !== null) return { ok: false, reason: '沒有待處理的事件' };
  const opt = ev.opts[index];
  if (!opt) return { ok: false, reason: '選項不存在' };
  if (opt.cost && g.credits < opt.cost) return { ok: false, reason: '信用點不足' };

  if (opt.cost) { g.credits -= opt.cost; log(g, `支付 ${opt.cost} 信用點。`); }

  let outcomeText = '';
  if (opt.risk) {
    const success = g.rng.chance(opt.risk.p);
    applyEffects(g, success ? opt.risk.ok : opt.risk.bad);
    outcomeText = success ? '結果：順利。' : '結果：出了問題。';
  } else {
    applyEffects(g, opt.fx ?? []);
    outcomeText = '結果：完成。';
  }

  ev.resolved = { index, text: outcomeText };
  sfx(g, 'ui', 560);
  return { ok: true, text: outcomeText };
}

export function closeEvent(g) {
  g.pending.event = null;
  g.screen = 'map';
}

// ---------------------------------------------------------------- 商店節點

function shopPrice(g, base) {
  const discount = metaLevel(g.meta, 'shop') * 0.1;
  return Math.max(5, Math.round(base * (1 - discount)));
}

function openShop(g) {
  const target = focusUnit(g);
  const cardPool = target ? cardPoolFor(g, target) : CARDS;
  const cards = g.rng.weightedDraw(cardPool, Math.min(3, cardPool.length)).map((c) => ({
    kind: 'card',
    id: c.id,
    n: c.n,
    d: c.d,
    r: c.r,
    price: shopPrice(g, c.price),
    sold: false,
  }));
  const services = g.rng.shuffle(SHOP_SERVICES).slice(0, 2).map((s) => ({
    kind: 'service',
    id: s.id,
    n: s.n,
    d: s.d,
    r: RARITY.COMMON,
    price: shopPrice(g, s.price),
    fx: s.fx,
    sold: false,
  }));
  g.pending.shop = { items: g.rng.shuffle([...cards, ...services]) };
  g.screen = 'shop';
  log(g, '接上黑市終端。', true);
}

export function buyShopItem(g, index) {
  const shop = g.pending.shop;
  if (!shop) return { ok: false, reason: '不在商店中' };
  const item = shop.items[index];
  if (!item) return { ok: false, reason: '商品不存在' };
  if (item.sold) return { ok: false, reason: '已售出' };
  if (g.credits < item.price) return { ok: false, reason: '信用點不足' };

  g.credits -= item.price;
  item.sold = true;

  if (item.kind === 'card') {
    const u = focusUnit(g);
    if (u) { applyCard(g, u, item.id); log(g, `${u.n} 安裝了「${item.n}」。`, true); }
  } else {
    applyEffects(g, item.fx);
    log(g, `購買了「${item.n}」。`, true);
  }
  sfx(g, 'ui', 700);
  return { ok: true };
}

export function leaveShop(g) {
  g.pending.shop = null;
  g.screen = 'map';
}

// ---------------------------------------------------------------- 補給節點

function openSupply(g) {
  g.pending.supply = {
    options: [
      { id: 'heal', n: '野戰治療', d: '全隊回復 40% Max HP', fx: [{ t: 'healPct', v: 0.4 }] },
      { id: 'card', n: '軍械改裝', d: `為 ${focusUnit(g)?.n ?? '隊員'} 進行一次改裝抽卡`, fx: null },
      { id: 'credits', n: '變賣物資', d: '獲得 60 信用點', fx: [{ t: 'credits', v: 60 }] },
    ],
    resolved: false,
  };
  g.screen = 'supply';
  log(g, '抵達補給點。', true);
}

export function chooseSupply(g, id) {
  const sup = g.pending.supply;
  if (!sup || sup.resolved) return { ok: false, reason: '沒有待處理的補給' };
  const opt = sup.options.find((o) => o.id === id);
  if (!opt) return { ok: false, reason: '選項不存在' };

  if (opt.id === 'card') {
    const u = focusUnit(g);
    if (u) queueDraft(g, u.id, 'supply');
  } else {
    applyEffects(g, opt.fx);
  }
  sup.resolved = true;
  sfx(g, 'ui', 600);
  return { ok: true };
}

export function closeSupply(g) {
  g.pending.supply = null;
  g.screen = 'map';
}

// ---------------------------------------------------------------- 序列化（Playwright / 除錯用）

export function serializeState(g) {
  const unitView = (u) => ({
    id: u.id, name: u.n, role: u.r, team: u.tm,
    x: u.x, y: u.y, hp: u.hp, maxHp: u.mhp, ap: u.ap, maxAp: u.map,
    atk: u.atk, range: u.rg, level: u.lv, xp: u.xp, xpToNext: xpToNext(u.lv),
    skillPoints: u.sp, path: u.path, passives: u.pass, alive: !!u.alive,
  });

  return {
    coordinateSystem: 'origin top-left, x right, y down, 0-index',
    seed: g.seed,
    seedLabel: g.seedLabel,
    screen: g.screen,
    credits: g.credits,
    stats: g.stats,
    currentNode: g.currentNodeId,
    currentFloor: g.map.nodes[g.currentNodeId]?.floor ?? 0,
    availableNodes: availableNodes(g).map((n) => ({ id: n.id, floor: n.floor, type: n.type })),
    squad: g.squad.map(unitView),
    battle: g.battle
      ? {
          floor: g.battle.floor,
          nodeType: g.battle.nodeType,
          turn: g.battle.turn,
          phase: g.battle.phase,
          actionMode: g.battle.actionMode,
          selectedId: g.battle.selectedId,
          coverTiles: [...g.battle.cover],
          playerUnits: aliveOf(g, 'p').map(unitView),
          enemyUnits: aliveOf(g, 'e').map(unitView),
        }
      : null,
    pendingDraft: g.pending.draft
      ? { unitId: g.pending.draft.unitId, source: g.pending.draft.source, cards: g.pending.draft.cards.map((c) => ({ id: c.id, rarity: c.r })) }
      : null,
    pendingEvent: g.pending.event ? { id: g.pending.event.id, resolved: !!g.pending.event.resolved } : null,
    pendingShop: g.pending.shop ? { items: g.pending.shop.items.map((i) => ({ id: i.id, kind: i.kind, price: i.price, sold: i.sold })) } : null,
    pendingSupply: g.pending.supply ? { resolved: g.pending.supply.resolved } : null,
    pendingVictory: g.pending.victory ? { nodeType: g.pending.victory.nodeType, credits: g.pending.victory.credits, isBoss: g.pending.victory.isBoss } : null,
    result: g.result,
    logs: g.log.slice(-8).map((l) => l.text),
  };
}

export { FLOORS, GRID, TUNE };
