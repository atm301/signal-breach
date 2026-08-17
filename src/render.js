// Canvas 繪製層。只讀 game state，不改它。
// 戰鬥棋盤與關卡樹共用同一張 canvas，由 g.screen 決定畫哪一個。

import { GRID, FLOORS, NODE_TYPES, ELEMENTS, CONDITION_BY_ID } from './data.js';
import {
  key, dist, reachableTiles, aliveOf, unitById, availableNodes, damageBreakdown,
  validSkillTiles,
 rangeOf,} from './engine.js';
import { unitSprite, coverSprite, nodeIcon, uiSprite } from './assets.js';

const PAD = 56;
export const FONT = '"Noto Sans TC","PingFang TC","Microsoft JhengHei",sans-serif';

const NODE_STYLE = {
  start: { fill: '#2f4c5c', ring: '#8fb6c9', ink: '#dff0f8' },
  battle: { fill: '#37505f', ring: '#7fa8bd', ink: '#e2f0f7' },
  elite: { fill: '#5c2f38', ring: '#ff8678', ink: '#ffd8d2' },
  event: { fill: '#3d4a63', ring: '#8fa4d8', ink: '#e2e8ff' },
  supply: { fill: '#2f5c45', ring: '#71d993', ink: '#d9ffe6' },
  shop: { fill: '#5c4f2f', ring: '#ffd980', ink: '#fff3d4' },
  boss: { fill: '#6b2436', ring: '#ff5f7a', ink: '#ffe0e6' },
};

// ---------------------------------------------------------------- 關卡樹

function mapLayout(size) {
  const padX = size * 0.11;
  const padY = size * 0.075;
  const rowH = (size - padY * 2) / (FLOORS - 1);
  return { padX, padY, rowH, width: size - padX * 2 };
}

export function mapNodePos(size, node) {
  const { padX, padY, rowH, width } = mapLayout(size);
  return {
    x: padX + node.pos * width,
    y: size - padY - node.floor * rowH, // 起點在下、Boss 在上
    r: Math.max(13, size * 0.026), // 圖示徽章需要比純文字大一點才看得清
  };
}

export function renderMap(ctx, g, size, time, hoverId = null) {
  ctx.clearRect(0, 0, size, size);
  const grad = ctx.createLinearGradient(0, 0, size, size);
  grad.addColorStop(0, '#10202a');
  grad.addColorStop(1, '#0b151c');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);

  const openIds = new Set(availableNodes(g).map((n) => n.id));
  const all = Object.values(g.map.nodes);

  // 連線
  ctx.lineWidth = 2;
  for (const node of all) {
    const a = mapNodePos(size, node);
    for (const id of node.next) {
      const b = mapNodePos(size, g.map.nodes[id]);
      const live = node.id === g.currentNodeId && openIds.has(id);
      ctx.strokeStyle = live ? 'rgba(113,217,147,.85)' : node.visited ? 'rgba(140,170,190,.35)' : 'rgba(90,120,140,.22)';
      ctx.lineWidth = live ? 3 : 2;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
  }

  // 節點
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const node of all) {
    const p = mapNodePos(size, node);
    const style = NODE_STYLE[node.type] || NODE_STYLE.battle;
    const isOpen = openIds.has(node.id);
    const isCurrent = node.id === g.currentNodeId;
    const isHover = node.id === hoverId;

    if (isOpen) {
      const pulse = 1 + Math.sin(time / 320) * 0.14;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r * (1.55 * pulse), 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(113,217,147,.55)';
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    ctx.save();
    ctx.globalAlpha = node.visited || isOpen ? 1 : 0.42;

    const icon = nodeIcon(node.type);
    if (icon) {
      // 圖示本身就是圓形徽章，直接畫上去，不用再墊底色
      const d = p.r * 2.2 * (isHover && isOpen ? 1.12 : 1);
      ctx.drawImage(icon, p.x - d / 2, p.y - d / 2, d, d);
    } else {
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r * (isHover && isOpen ? 1.15 : 1), 0, Math.PI * 2);
      ctx.fillStyle = style.fill;
      ctx.fill();
      ctx.strokeStyle = style.ring;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = style.ink;
      ctx.font = `${Math.round(p.r * 1.05)}px ${FONT}`;
      ctx.fillText(NODE_TYPES[node.type].icon, p.x, p.y + 1);
    }

    // 目前所在位置：外圈再套一層白環，跟其他節點區分開
    if (isCurrent) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r * 1.28, 0, Math.PI * 2);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 3;
      ctx.stroke();
    }
    ctx.restore();
  }

  // 層數刻度
  const { padX, padY, rowH } = mapLayout(size);
  ctx.fillStyle = 'rgba(137,160,174,.75)';
  ctx.font = `11px ${FONT}`;
  ctx.textAlign = 'right';
  for (let f = 0; f < FLOORS; f++) {
    const y = size - padY - f * rowH;
    ctx.fillText(f === FLOORS - 1 ? 'BOSS' : `F${f}`, padX - 12, y);
  }

  ctx.textAlign = 'start';
  ctx.textBaseline = 'alphabetic';
  drawBanner(ctx, size, `推進路線 | 已達第 ${g.stats.depth} 層 | 信用點 ${g.credits} | 種子 ${g.seedLabel}`);
}

export function pickMapNode(g, size, px, py) {
  let best = null;
  for (const node of Object.values(g.map.nodes)) {
    const p = mapNodePos(size, node);
    const d = Math.hypot(px - p.x, py - p.y);
    if (d <= p.r * 1.8 && (!best || d < best.d)) best = { id: node.id, d };
  }
  return best?.id ?? null;
}

// ---------------------------------------------------------------- 戰鬥棋盤

export function renderBattle(ctx, g, size, time, fxList, hoverTile, intents = []) {
  const board = size - PAD * 2;
  const cell = board / GRID;

  ctx.clearRect(0, 0, size, size);
  const grad = ctx.createLinearGradient(0, 0, size, size);
  grad.addColorStop(0, '#0f1b22');
  grad.addColorStop(1, '#182833');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);

  drawGrid(ctx, cell);
  drawCover(ctx, g, cell);
  drawHighlights(ctx, g, cell);
  drawIntents(ctx, g, cell, time, intents);
  drawUnits(ctx, g, cell, time);
  drawFx(ctx, fxList, cell);
  drawForecast(ctx, g, cell, hoverTile);

  const b = g.battle;
  const typeLabel = b.nodeType === 'boss' ? '頭目戰' : b.nodeType === 'elite' ? '精英交戰' : '交火';
  const cond = CONDITION_BY_ID[b.cond];
  const condText = cond && !cond.plain ? ` | ⚠ ${cond.n}` : '';
  drawBanner(ctx, size, `F${b.floor} ${typeLabel} | 第 ${b.turn} 回合 | ${b.phase === 'player' ? '我方行動' : b.phase === 'ai' ? '敵方行動' : ''}${condText}`, !!condText);

  if (b.phase === 'win') drawToast(ctx, size, b.nodeType === 'boss' ? '頭目擊破' : '區域肅清', '#a8f5c0');
  else if (g.pending.draft) drawToast(ctx, size, '升級改裝中');
  else if (b.phase === 'lose') drawToast(ctx, size, '全隊失去戰鬥能力', '#ffb3c0');
}

function drawGrid(ctx, cell) {
  ctx.strokeStyle = '#3c5b6c';
  ctx.lineWidth = 1;
  for (let i = 0; i <= GRID; i++) {
    const p = PAD + i * cell;
    ctx.beginPath(); ctx.moveTo(PAD, p); ctx.lineTo(PAD + GRID * cell, p); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(p, PAD); ctx.lineTo(p, PAD + GRID * cell); ctx.stroke();
  }
  ctx.fillStyle = '#90a9b8';
  ctx.font = `12px ${FONT}`;
  for (let i = 0; i < GRID; i++) {
    ctx.fillText(String(i + 1), PAD - 18, PAD + i * cell + cell * 0.56);
    ctx.fillText(String(i + 1), PAD + i * cell + cell * 0.44, PAD - 12);
  }
}

function drawCover(ctx, g, cell) {
  ctx.font = `12px ${FONT}`;
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      if (!g.battle.cover.has(key(x, y))) continue;
      const px = PAD + x * cell;
      const py = PAD + y * cell;
      const sprite = coverSprite(x, y);

      if (sprite) {
        // 底下鋪一層半透明色塊，讓玩家一眼看得出「這格是掩體」而不只是裝飾物
        ctx.fillStyle = 'rgba(95,122,141,.16)';
        ctx.fillRect(px + 3, py + 3, cell - 6, cell - 6);
        const s = cell * 0.92;
        ctx.drawImage(sprite, px + (cell - s) / 2, py + (cell - s) / 2, s, s);
      } else {
        ctx.fillStyle = 'rgba(95,122,141,.42)';
        ctx.fillRect(px + 5, py + 5, cell - 10, cell - 10);
        ctx.strokeStyle = '#7a98aa';
        ctx.lineWidth = 1;
        ctx.strokeRect(px + 5, py + 5, cell - 10, cell - 10);
      }

      ctx.fillStyle = '#dbe7ee';
      ctx.fillText('C', px + cell - 16, py + 16);
    }
  }
}

function drawHighlights(ctx, g, cell) {
  const b = g.battle;
  if (b.phase !== 'player') return;
  const u = unitById(g, b.selectedId);
  if (!u || u.tm !== 'p' || !u.alive) return;

  ctx.strokeStyle = '#71d993';
  ctx.lineWidth = 3;
  ctx.strokeRect(PAD + u.x * cell + 4, PAD + u.y * cell + 4, cell - 8, cell - 8);

  // 技能已就緒：只畫技能的合法目標，把平常的移動/攻擊提示收掉。
  // 兩套同時畫的話玩家分不出「這格是走過去還是放技能」——
  // 而這是全遊戲唯一一次進入模式，畫面必須明確告訴他現在在做什麼。
  if (b.armedSkill && b.armedSkill.unitId === u.id) {
    const tiles = validSkillTiles(g, u, b.armedSkill.id);
    const t = (performance.now?.() ?? Date.now()) / 400;
    const pulse = 0.18 + Math.sin(t) * 0.08;
    for (const p of tiles) {
      const px = PAD + p.x * cell;
      const py = PAD + p.y * cell;
      ctx.fillStyle = `rgba(255,217,128,${pulse})`;
      ctx.fillRect(px + 5, py + 5, cell - 10, cell - 10);
      ctx.strokeStyle = '#ffd980';
      ctx.lineWidth = 2.5;
      ctx.setLineDash([cell * 0.12, cell * 0.08]);
      ctx.strokeRect(px + 5, py + 5, cell - 10, cell - 10);
      ctx.setLineDash([]);
    }
    return;
  }

  // 移動範圍與可攻擊目標「同時」顯示。
  // 原本要切模式才看得到另一半，等於逼玩家為了看資訊多按一次。
  ctx.fillStyle = 'rgba(113,217,147,.16)';
  for (const t of reachableTiles(g, u)) {
    ctx.fillRect(PAD + t.x * cell + 8, PAD + t.y * cell + 8, cell - 16, cell - 16);
  }

  if (u.attacked < 1 && u.ap >= 1) {
    for (const e of aliveOf(g, 'e')) {
      if (dist(u.x, u.y, e.x, e.y) > rangeOf(g, u)) continue;
      const px = PAD + e.x * cell;
      const py = PAD + e.y * cell;
      ctx.fillStyle = 'rgba(255,134,120,.24)';
      ctx.fillRect(px + 6, py + 6, cell - 12, cell - 12);
      ctx.strokeStyle = 'rgba(255,134,120,.9)';
      ctx.lineWidth = 2;
      ctx.strokeRect(px + 6, py + 6, cell - 12, cell - 12);
    }
  }
}

// 單位朝向：直接讀引擎裡的 faceX / faceY。
//
// ⚠️ 這裡以前是「自己算出面向最近的敵人」，那只是視覺。
// 現在側背攻擊是真的機制，畫出來的方向必須跟判定用的方向是同一個，
// 否則玩家會看著背對自己的敵人卻吃不到背擊加成，完全無法學習。
//
// 素材是「面朝畫面下方」畫的，所以旋轉量 = 朝向角度 - PI/2。
function facingOf(u) {
  const fx = u.faceX ?? 0;
  const fy = u.faceY ?? (u.tm === 'p' ? -1 : 1);
  return Math.atan2(fy, fx) - Math.PI / 2;
}

function drawUnits(ctx, g, cell, time) {
  ctx.font = `12px ${FONT}`;
  for (const u of g.battle.units) {
    if (!u.alive) continue;
    const cx = PAD + u.x * cell + cell * 0.5;
    const cy = PAD + u.y * cell + cell * 0.5;
    const r = cell * (u.boss ? 0.33 : 0.28);
    const tw = time / 1000;
    const pulse = 1 + Math.sin(tw * 3 + u.x * 0.9 + u.y * 0.6) * 0.04;
    const hurt = u.hurtMs > 0;
    const recoil = u.fireMs > 0 ? Math.sin((u.fireMs / 160) * Math.PI) * 0.1 : 0;
    // 出手演出分兩種：近戰往前撲、遠程往後座。
    // 這一格的位移只有 0.14 格，聖火降魔錄那種「切到動畫畫面」的排場放在
    // 5x5 棋盤上會拖垮節奏（每場才 4 回合），所以改成原地演出 —— 保留衝擊感，不偷走時間。
    const lunge = u.rg <= 1 ? recoil * cell * 1.4 : -recoil * cell * 0.9;
    // 受擊往後仰：faceToward 已經把被打的人轉向攻擊者，所以往後 = 朝向的反方向
    const knock = hurt ? Math.sin((u.hurtMs / 240) * Math.PI) * cell * 0.09 : 0;
    const team = u.tm === 'p' ? '#5db6ff' : u.boss ? '#ff5f7a' : '#ff8678';
    const glow = u.tm === 'p' ? 'rgba(93,182,255,.35)' : 'rgba(255,134,120,.35)';

    // 有 AI 素材就畫素材，沒有就回到原本的幾何繪製。
    // outerR 是所有機能性 UI（陣營環、AP 環、血條、已出手標記）的定位基準，
    // 兩種畫法共用同一組座標，才不會有一套 UI 對得上、另一套跑掉。
    const sprite = unitSprite(u);
    const outerR = sprite ? cell * (u.boss ? 0.40 : 0.36) : r * 1.12;

    if (sprite) {
      // 底盤：讓單位看起來站在格子上，而不是浮在格線上方
      ctx.save();
      ctx.shadowBlur = 16 + (hurt ? 12 : 0) + (u.boss ? 10 : 0);
      ctx.shadowColor = glow;
      ctx.beginPath();
      ctx.arc(cx, cy, outerR, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(9,17,23,.60)';
      ctx.fill();
      ctx.restore();

      // 陣營環是玩家分辨敵我的唯一線索，要夠粗夠亮，不能被別的 UI 蓋掉
      ctx.beginPath();
      ctx.arc(cx, cy, outerR, 0, Math.PI * 2);
      ctx.strokeStyle = hurt ? '#ffd6cf' : team;
      ctx.lineWidth = u.boss ? 4 : 3;
      ctx.stroke();

      drawIdentityMark(ctx, u, cx, cy, outerR, team);
      drawActingRing(ctx, g, u, cx, cy, outerR, cell, time);

      const s = outerR * 2 * (1 + pulse * 0.012);
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(facingOf(u));
      // 旋轉後 +Y 就是朝向的正前方，所以往前撲是正的、後座與後仰是負的
      ctx.translate(0, lunge - knock);
      ctx.drawImage(sprite, -s / 2, -s / 2, s, s);
      if (hurt) {
        // 受擊閃光：同一張圖用 lighter 疊上去提亮，不必另開 canvas 做 tint
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = 0.38;
        ctx.drawImage(sprite, -s / 2, -s / 2, s, s);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
      }
      ctx.restore();
    } else {
      ctx.save();
      ctx.shadowBlur = 18 + (hurt ? 14 : 0) + (u.boss ? 10 : 0);
      ctx.shadowColor = glow;
      ctx.beginPath();
      ctx.arc(cx, cy, r * (1.04 + pulse * 0.02), 0, Math.PI * 2);
      ctx.fillStyle = hurt ? '#ffd2cc' : team;
      ctx.fill();
      ctx.restore();

      ctx.beginPath();
      ctx.arc(cx, cy, r * (0.88 + pulse * 0.01), 0, Math.PI * 2);
      ctx.fillStyle = hurt ? '#2c1512' : '#0f1a21';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(cx, cy, r * 0.88, Math.PI * 0.25 + recoil, Math.PI * 1.25 + recoil);
      ctx.strokeStyle = hurt ? '#ffd6cf' : team;
      ctx.lineWidth = 3;
      ctx.stroke();

      drawRoleGlyph(ctx, u, cx, cy, r, tw);
    }

    // AP 用點狀指示，不用圓環。
    // 環會和陣營環擠在一起、而且綠色比陣營色搶眼，實測會讓玩家分不出敵我。
    // AP 只有 1 到 4 點，點狀本來就比弧長好讀。
    const pipR = Math.max(2.5, cell * 0.028);
    const pipGap = pipR * 2.7;
    const pipY = cy - outerR - pipR * 2.2;
    const pipStart = cx - ((u.map - 1) * pipGap) / 2;
    for (let i = 0; i < u.map; i++) {
      ctx.beginPath();
      ctx.arc(pipStart + i * pipGap, pipY, pipR, 0, Math.PI * 2);
      ctx.fillStyle = i < u.ap ? 'rgba(113,217,147,.98)' : 'rgba(35,54,69,.9)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(15,26,33,.9)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // 本回合已攻擊過的標記。攻擊每回合限一次，玩家一定要一眼看得出來誰還沒出手。
    if (u.attacked) {
      const mr = cell * 0.085;
      const mx = cx + outerR * 0.78;
      const my = cy - outerR * 0.78;
      ctx.beginPath();
      ctx.arc(mx, my, mr, 0, Math.PI * 2);
      ctx.fillStyle = '#0f1a21';
      ctx.fill();
      ctx.strokeStyle = '#ffd980';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(mx - mr * 0.5, my);
      ctx.lineTo(mx + mr * 0.5, my);
      ctx.stroke();
    }

    // 屬性徽章。相剋是三系循環，玩家必須在「選誰打誰」的當下就看得到雙方屬性，
    // 不然只能靠記憶回想哪隻是電磁 —— 那不叫戰略，那叫背書。
    const el = ELEMENTS[u.el];
    if (el) {
      const er = cell * 0.095;
      const ex = cx - outerR * 0.82;
      const ey = cy - outerR * 0.78;
      ctx.beginPath();
      ctx.arc(ex, ey, er, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(9,17,23,.92)';
      ctx.fill();
      ctx.strokeStyle = el.color;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = el.color;
      ctx.font = `800 ${Math.round(er * 1.35)}px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(el.short, ex, ey + er * 0.06);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
    }

    // 狀態標記。畫在代幣正下方、血條上面 ——
    // 標定與干擾都會直接改變「這回合該打誰」，看不到就等於技能沒放。
    const sts = Object.entries(u.st ?? {}).filter(([, n]) => n > 0);
    if (sts.length) {
      const sw = cell * 0.13;
      let sx = cx - ((sts.length - 1) * sw * 1.25) / 2;
      const sy = cy + outerR * 0.98;
      for (const [id, turns] of sts) {
        ctx.beginPath();
        ctx.arc(sx, sy, sw * 0.5, 0, Math.PI * 2);
        ctx.fillStyle = id === 'stunned' ? '#8fa4d8' : '#ffd980';
        ctx.fill();
        ctx.strokeStyle = 'rgba(9,17,23,.9)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.fillStyle = '#0f1a21';
        ctx.font = `800 ${Math.round(sw * 0.72)}px ${FONT}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(id === 'stunned' ? '干' : '標', sx, sy + sw * 0.03);
        // 剩餘回合寫在右上角，玩家要能數
        ctx.font = `800 ${Math.round(sw * 0.55)}px ${FONT}`;
        ctx.fillStyle = '#dfe9f0';
        ctx.strokeStyle = 'rgba(9,17,23,.9)';
        ctx.lineWidth = 2.5;
        ctx.strokeText(String(turns), sx + sw * 0.52, sy - sw * 0.42);
        ctx.fillText(String(turns), sx + sw * 0.52, sy - sw * 0.42);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        sx += sw * 1.25;
      }
    }

    // 血條
    const barW = outerR * 1.7;
    const barY = cy + outerR * 1.14;
    ctx.fillStyle = '#233645';
    ctx.fillRect(cx - barW / 2, barY, barW, 6);
    ctx.fillStyle = u.hp / u.mhp > 0.4 ? '#44d3b2' : '#ff6f7d';
    ctx.fillRect(cx - barW / 2, barY, barW * (u.hp / Math.max(1, u.mhp)), 6);

    // AP 數字已經被上面的點狀指示取代，這裡不再重複標
  }
}

// 個人識別標記：在陣營環下緣畫 1-4 段短弧，段數與粗細由 u.look 決定。
//
// 隨機幹員之後，場上可能同時有兩個「先鋒」——同樣的原型、同樣的素材，
// 玩家分不出誰是誰。名字在面板上，但棋盤上沒有。
//
// 刻意畫在環上而不是貼在素材身上：貼圖要對齊 3D 造型，
// 每套 skin 的肩膀位置都不一樣，對不準就會看起來像 bug；
// 畫在環上永遠不會蓋到素材，而且跟血條、AP 點一樣是「機能性 UI」的一部分。
// 位置固定在左側（不跟著朝向轉），這樣它才是穩定的身分標記而不是方向指示。
// 上緣是 AP 點、下緣是血條、右上角是「已出手」、左上角是屬性徽章 ——
// 正左方是這個代幣上唯一還空著的地方。
function drawIdentityMark(ctx, u, cx, cy, outerR, team) {
  if (u.tm !== 'p' || u.look == null) return;
  const segs = 1 + (u.look % 4); // 1-4 段
  const wide = (u.look >> 3) % 2 === 0; // 兩種粗細
  const span = wide ? 0.20 : 0.12;
  const gap = 0.08;
  const total = segs * span + (segs - 1) * gap;
  let a = Math.PI - total / 2; // 從正左方往上下對稱展開

  ctx.save();
  ctx.strokeStyle = team;
  ctx.lineWidth = 5;
  ctx.lineCap = 'butt';
  for (let i = 0; i < segs; i++) {
    ctx.beginPath();
    ctx.arc(cx, cy, outerR + 3.5, a, a + span);
    ctx.stroke();
    a += span + gap;
  }
  ctx.restore();
}

// 正在行動的敵人：外圈再加一道會轉的虛線環 + 頭頂箭頭。
//
// 整個敵方回合只有 0.4 秒，三隻敵人動完，玩家原本只看到血條變短 ——
// 看不出是誰打的、從哪個方向來的，等於沒有回饋。
// 這個環的成本是零時間（不拖慢節奏），但把「匿名的一團」變成「那一隻在動」。
function drawActingRing(ctx, g, u, cx, cy, outerR, cell, time) {
  if (g.battle?.phase !== 'ai' || g.battle.actingId !== u.id) return;
  const r = outerR + 7;
  ctx.save();
  ctx.strokeStyle = '#ffd980';
  ctx.lineWidth = 2.5;
  ctx.setLineDash([r * 0.42, r * 0.34]);
  ctx.lineDashOffset = -(time / 12) % 1000;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);

  // 頭頂倒三角。虛線環在小螢幕上可能不夠搶眼，箭頭是保險。
  // 高度要清掉上緣那排 AP 點（畫在 cy - outerR - pipR*2.2），不然會疊在一起看不出是什麼。
  const ay = cy - outerR - cell * 0.135;
  const aw = Math.max(5, outerR * 0.22);
  ctx.beginPath();
  ctx.moveTo(cx - aw, ay - aw);
  ctx.lineTo(cx + aw, ay - aw);
  ctx.lineTo(cx, ay);
  ctx.closePath();
  ctx.fillStyle = '#ffd980';
  ctx.fill();
  ctx.restore();
}

// 給 tools/look-sheet.mjs 用：同一份繪製邏輯，避免對照表畫的跟棋盤不一樣
export const drawIdentityMarkForTest = drawIdentityMark;

function drawRoleGlyph(ctx, u, cx, cy, r, tw) {
  const ink = 'rgba(220,235,245,.9)';
  if (u.r === 'S' || u.r === 'A') {
    // 遠程：三角準星 + 掃描弧
    ctx.beginPath();
    ctx.moveTo(cx - r * 0.5, cy + r * 0.35);
    ctx.lineTo(cx, cy - r * 0.45);
    ctx.lineTo(cx + r * 0.5, cy + r * 0.35);
    ctx.closePath();
    ctx.fillStyle = ink;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.22, 0, Math.PI * 2);
    ctx.fillStyle = '#0c161d';
    ctx.fill();
    ctx.strokeStyle = 'rgba(220,250,255,.65)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.52, tw * 2.2, tw * 2.2 + Math.PI * 0.85);
    ctx.stroke();
  } else if (u.r === 'D') {
    // 無人機：四葉旋翼
    ctx.strokeStyle = 'rgba(220,250,255,.7)';
    ctx.lineWidth = 2;
    for (let i = 0; i < 4; i++) {
      const a = tw * 6 + (i * Math.PI) / 2;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(a) * r * 0.55, cy + Math.sin(a) * r * 0.55);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.2, 0, Math.PI * 2);
    ctx.fillStyle = ink;
    ctx.fill();
  } else {
    // 近戰／重裝：胸甲
    ctx.strokeStyle = 'rgba(220,250,255,.55)';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.62, tw * 1.8, tw * 1.8 + Math.PI * 0.7);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx - r * 0.45, cy - r * 0.15);
    ctx.lineTo(cx - r * 0.2, cy - r * 0.45);
    ctx.lineTo(cx + r * 0.2, cy - r * 0.45);
    ctx.lineTo(cx + r * 0.45, cy - r * 0.15);
    ctx.lineTo(cx + r * 0.2, cy + r * 0.35);
    ctx.lineTo(cx - r * 0.2, cy + r * 0.35);
    ctx.closePath();
    ctx.fillStyle = ink;
    ctx.fill();
    ctx.fillStyle = '#0c161d';
    ctx.fillRect(cx - r * 0.12, cy - r * 0.2, r * 0.24, r * 0.35);
  }
}

function drawFx(ctx, fxList, cell) {
  for (const f of fxList) {
    const t = Math.max(0, Math.min(1, f.life / (f.maxLife || 1)));
    if (f.type === 'beam') {
      const x1 = PAD + f.from.x * cell + cell * 0.5;
      const y1 = PAD + f.from.y * cell + cell * 0.5;
      const x2 = PAD + f.to.x * cell + cell * 0.5;
      const y2 = PAD + f.to.y * cell + cell * 0.5;
      ctx.save();
      ctx.globalAlpha = t;
      ctx.strokeStyle = f.color;
      ctx.lineWidth = 4 * t + 1;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      ctx.restore();
    } else if (f.type === 'damage') {
      // 傷害數字：這是「戰略性」唯一的回饋管道。
      // 玩家要能一眼看出「這下打 13 是因為背擊 + 剋」，
      // 不然相剋跟側背都只是後台數字，學不會就等於不存在。
      const cx = PAD + f.x * cell + cell * 0.5;
      const big = Math.round(cell * (f.crit ? 0.34 : 0.27));
      // 最上排的傷害數字會往上飄出棋盤、被頂端橫幅蓋掉。
      // 夾住上緣，寧可讓它停在原地也不能讓玩家看不到自己打了多少。
      const cy = Math.max(
        38 + big * 0.6,
        PAD + f.y * cell + cell * 0.5 - cell * 0.34 - (1 - t) * cell * 0.5
          - (f.stack || 0) * big * 0.95, // 同格已有數字就往上讓，避免疊成一團
      );
      ctx.save();
      // 前 15% 淡入、最後 30% 淡出，中間全不透明，才讀得完
      ctx.globalAlpha = Math.min(1, (1 - t) * 6.5, t * 3.3);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `900 ${big}px ${FONT}`;
      ctx.lineWidth = Math.max(3, big * 0.22);
      ctx.lineJoin = 'round';
      ctx.strokeStyle = 'rgba(6,12,16,.92)';
      const label = `-${f.value}`;
      ctx.strokeText(label, cx, cy);
      ctx.fillStyle = f.color || '#fff2d8';
      ctx.fillText(label, cx, cy);
      if (f.tags && f.tags.length) {
        const small = Math.round(cell * 0.135);
        ctx.font = `700 ${small}px ${FONT}`;
        ctx.lineWidth = Math.max(2.5, small * 0.3);
        const tagY = cy + big * 0.66;
        ctx.strokeText(f.tags.join(' '), cx, tagY);
        ctx.fillStyle = '#ffd980';
        ctx.fillText(f.tags.join(' '), cx, tagY);
      }
      ctx.restore();
    } else {
      const cx = PAD + f.x * cell + cell * 0.5;
      const cy = PAD + f.y * cell + cell * 0.5;
      const scale = (f.type === 'burst' ? 2.2 : 1.4) * (1 - t) + 0.35;
      ctx.save();
      ctx.globalAlpha = t;
      ctx.strokeStyle = f.color;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(cx, cy, cell * 0.18 * (f.size || 1) + cell * 0.24 * scale, 0, Math.PI * 2);
      ctx.stroke();
      if (f.type === 'burst') {
        ctx.fillStyle = 'rgba(255,245,220,.2)';
        ctx.beginPath();
        ctx.arc(cx, cy, cell * 0.07 * (f.size || 1) + cell * 0.14 * scale, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
  }
}

// 戰鬥預測卡：滑過敵人時，把這一擊的完整算式攤開來。
//
// 火焰之紋章那套「切到全螢幕戰鬥動畫」在這裡行不通 —— 一場只有 4 回合，
// 每次切鏡頭 2 秒就等於把節奏砍半。所以改走 Into the Breach 的路：
// 資訊在出手「之前」就全部給你，動畫只留 350ms 原地演出。
// 相剋和側背這種乘算機制，玩家看不到算式就學不會，學不會就等於沒有戰略。
function drawForecast(ctx, g, cell, hoverTile) {
  const b = g.battle;
  if (!hoverTile || !b || b.phase !== 'player') return;
  const me = unitById(g, b.selectedId);
  if (!me || !me.alive || me.tm !== 'p') return;
  const foe = b.units.find((u) => u.alive && u.tm === 'e' && u.x === hoverTile.x && u.y === hoverTile.y);
  if (!foe) return;

  const f = damageBreakdown(g, me, foe);
  const inRange = f.dist <= rangeOf(g, me);
  const blocked = me.attacked >= 1 || me.ap < 1;

  const rows = [];
  if (f.elem !== 1) rows.push({ t: `${f.elem > 1 ? '屬性剋制' : '屬性被抗'} ×${f.elem}`, c: f.elem > 1 ? '#8fffad' : '#ff9d9d' });
  if (f.flankLabel) rows.push({ t: `${f.flankLabel} ×${f.flank}`, c: '#ffd980' });
  if (f.cover) rows.push({ t: `目標有掩體 −${f.cover}`, c: '#9fb8c8' });
  rows.push({
    t: `穩定性 ${me.stab ?? 60}｜目標 HP ${foe.hp}`,
    c: '#9fb8c8',
  });

  const head = !inRange ? `射程外（距離 ${f.dist} / 射程 ${rangeOf(g, me)}）`
    : blocked ? '本回合已出手'
    : f.min === f.max ? `${f.min} 傷害` : `${f.min} – ${f.max} 傷害`;
  const verdict = !inRange || blocked ? null
    : f.guaranteedKill ? { t: '必殺', c: '#a8f5c0' }
    : f.possibleKill ? { t: '可能擊殺', c: '#ffd980' }
    : null;

  const padX = cell * 0.16;
  const headSize = Math.round(cell * 0.185);
  const rowSize = Math.round(cell * 0.135);
  const lineH = rowSize * 1.5;
  const h = padX * 1.6 + headSize + rows.length * lineH;

  ctx.save();
  ctx.font = `800 ${headSize}px ${FONT}`;
  // 標題與擊殺判定同一行，寬度要「量」不能猜 —— 猜了就會像第一版那樣把「可」字壓掉
  const verdictFont = `800 ${Math.round(rowSize * 1.15)}px ${FONT}`;
  let verdictW = 0;
  if (verdict) {
    ctx.font = verdictFont;
    verdictW = ctx.measureText(verdict.t).width + padX;
    ctx.font = `800 ${headSize}px ${FONT}`;
  }
  let w = ctx.measureText(head).width + verdictW;
  ctx.font = `600 ${rowSize}px ${FONT}`;
  for (const r of rows) w = Math.max(w, ctx.measureText(r.t).width);
  w += padX * 2;

  // 卡片位置：上 → 下 → 右 → 左依序試。
  // 條件不只是「畫得下」，還要「不蓋住目標，也不蓋住自己的攻擊單位」——
  // 第一版只做上下翻轉，結果目標在最上排時卡片翻下來正好蓋掉攻擊者，
  // 玩家看得到算式卻看不到誰在打。
  const cardW = w;
  const boardEnd = PAD + GRID * cell;
  const gap = cell * 0.12;
  const cx = PAD + foe.x * cell + cell * 0.5;
  const cyc = PAD + foe.y * cell + cell * 0.5;
  const clampX = (v) => Math.max(4, Math.min(boardEnd + PAD - cardW - 4, v));
  const clampY = (v) => Math.max(4, Math.min(boardEnd + PAD - h - 4, v));
  const hits = (c, u) => {
    const ox = PAD + u.x * cell; const oy = PAD + u.y * cell;
    return c.x < ox + cell && c.x + cardW > ox && c.y < oy + cell && c.y + h > oy;
  };
  // 蓋掉目標或攻擊者是重罪（那兩格正是玩家在比較的東西），蓋到別的單位只是小扣分
  const cost = (c) => b.units.reduce((s, u) => {
    if (!u.alive || !hits(c, u)) return s;
    return s + (u.id === foe.id || u.id === me.id ? 100 : 1);
  }, 0);

  const candidates = [
    { x: clampX(cx - cardW / 2), y: PAD + foe.y * cell - h - gap },
    { x: clampX(cx - cardW / 2), y: PAD + (foe.y + 1) * cell + gap },
    { x: PAD + (foe.x + 1) * cell + gap, y: clampY(cyc - h / 2) },
    { x: PAD + foe.x * cell - cardW - gap, y: clampY(cyc - h / 2) },
  ].filter((c) => c.x >= 4 && c.y >= 4
    && c.x + cardW <= boardEnd + PAD - 4 && c.y + h <= boardEnd + PAD - 4);

  let pick = { x: clampX(cx - cardW / 2), y: clampY(cyc - h / 2) };
  let bestCost = Infinity;
  for (const c of candidates) {
    const s = cost(c);
    if (s < bestCost) { bestCost = s; pick = c; }
    if (s === 0) break;
  }
  const x = pick.x;
  const y = pick.y;

  ctx.shadowBlur = 18;
  ctx.shadowColor = 'rgba(0,0,0,.55)';
  roundRect(ctx, x, y, w, h, 8);
  ctx.fillStyle = 'rgba(10,20,27,.94)';
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = inRange && !blocked ? '#5db6ff' : '#5d6f7c';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  ctx.font = `800 ${headSize}px ${FONT}`;
  ctx.fillStyle = inRange && !blocked ? '#fff2d8' : '#8fa3b0';
  ctx.fillText(head, x + padX, y + padX * 0.8);
  if (verdict) {
    ctx.textAlign = 'right';
    ctx.font = verdictFont;
    ctx.fillStyle = verdict.c;
    ctx.fillText(verdict.t, x + w - padX, y + padX * 0.8 + headSize * 0.18);
    ctx.textAlign = 'left';
  }
  ctx.font = `600 ${rowSize}px ${FONT}`;
  rows.forEach((r, i) => {
    ctx.fillStyle = r.c;
    ctx.fillText(r.t, x + padX, y + padX * 0.8 + headSize + i * lineH + lineH * 0.12);
  });
  ctx.restore();
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// 把畫布座標換成棋盤格；點在棋盤外回傳 null
export function pickBoardTile(size, px, py) {
  const board = size - PAD * 2;
  if (px < PAD || py < PAD || px > PAD + board || py > PAD + board) return null;
  const cell = board / GRID;
  const x = Math.floor((px - PAD) / cell);
  const y = Math.floor((py - PAD) / cell);
  if (x < 0 || y < 0 || x >= GRID || y >= GRID) return null;
  return { x, y };
}

// ---------------------------------------------------------------- 共用零件

function drawBanner(ctx, size, text, warn = false) {
  // 高度與位置要留給棋盤上方的座標標籤（畫在 y = PAD - 12），不然會疊在一起
  ctx.fillStyle = warn ? 'rgba(46,26,16,.9)' : 'rgba(14,26,34,.86)';
  ctx.fillRect(PAD * 0.4, 4, size - PAD * 0.8, 28);
  ctx.fillStyle = warn ? '#ffd6ad' : '#dce9f0';
  ctx.font = `13px ${FONT}`;
  ctx.textAlign = 'start';
  ctx.fillText(text, PAD * 0.4 + 12, 23);
}

function drawToast(ctx, size, text, color) {
  ctx.fillStyle = 'rgba(0,0,0,.55)';
  ctx.fillRect(0, size * 0.42, size, 56);
  ctx.fillStyle = color || '#fff2d4';
  ctx.font = `bold 30px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.fillText(text, size / 2, size * 0.42 + 38);
  ctx.textAlign = 'start';
}

// 開場畫面與作者的話：用 key art 當底，疊暗幕與標題
export function renderTitle(ctx, size, time, opts = {}) {
  const art = uiSprite('title-bg');
  ctx.clearRect(0, 0, size, size);

  if (art) {
    ctx.drawImage(art, 0, 0, size, size);
  } else {
    const grad = ctx.createRadialGradient(size * 0.5, size * 0.4, 10, size * 0.5, size * 0.5, size * 0.8);
    grad.addColorStop(0, '#1d3242');
    grad.addColorStop(1, '#0b151c');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
  }

  // 暗幕：上下重、中間輕，讓標題有地方站
  const scrim = ctx.createLinearGradient(0, 0, 0, size);
  scrim.addColorStop(0, 'rgba(12,21,28,.92)');
  scrim.addColorStop(0.42, 'rgba(12,21,28,.35)');
  scrim.addColorStop(0.78, 'rgba(12,21,28,.72)');
  scrim.addColorStop(1, 'rgba(12,21,28,.96)');
  ctx.fillStyle = scrim;
  ctx.fillRect(0, 0, size, size);

  ctx.textAlign = 'center';

  if (opts.mode === 'credits') {
    ctx.fillStyle = 'rgba(213,228,235,.95)';
    ctx.font = `bold ${Math.round(size * 0.058)}px ${FONT}`;
    ctx.fillText('作者的話', size / 2, size * 0.5);
    ctx.fillStyle = 'rgba(137,160,174,.9)';
    ctx.font = `${Math.round(size * 0.02)}px ${FONT}`;
    ctx.fillText('AUTHOR NOTE', size / 2, size * 0.55);
    ctx.textAlign = 'start';
    return;
  }

  // 標題
  const pulse = 0.5 + Math.sin(time / 900) * 0.5;
  ctx.fillStyle = 'rgba(113,217,147,.9)';
  ctx.font = `bold ${Math.round(size * 0.019)}px ${FONT}`;
  ctx.fillText('T U R N - B A S E D   T A C T I C S', size / 2, size * 0.30);

  ctx.save();
  ctx.shadowBlur = 30;
  ctx.shadowColor = 'rgba(93,182,255,.5)';
  ctx.fillStyle = '#ffffff';
  ctx.font = `800 ${Math.round(size * 0.105)}px ${FONT}`;
  ctx.fillText('SIGNAL', size / 2, size * 0.42);
  ctx.fillText('BREACH', size / 2, size * 0.53);
  ctx.restore();

  ctx.fillStyle = '#5db6ff';
  ctx.font = `bold ${Math.round(size * 0.042)}px ${FONT}`;
  ctx.fillText('訊 號 突 破', size / 2, size * 0.615);

  ctx.strokeStyle = 'rgba(93,182,255,.7)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(size * 0.36, size * 0.655);
  ctx.lineTo(size * 0.64, size * 0.655);
  ctx.stroke();

  ctx.fillStyle = 'rgba(168,191,204,.9)';
  ctx.font = `${Math.round(size * 0.022)}px ${FONT}`;
  ctx.fillText('5x5 科幻回合制戰棋 Roguelike', size / 2, size * 0.70);

  if (!opts.audioStarted) {
    ctx.fillStyle = `rgba(255,217,128,${0.45 + pulse * 0.5})`;
    ctx.font = `${Math.round(size * 0.021)}px ${FONT}`;
    ctx.fillText('點擊任意處以啟動音效與音樂', size / 2, size * 0.90);
  }

  ctx.textAlign = 'start';
}

// 空畫面（大廳與結算時 canvas 不畫棋盤）
// 大廳與結算畫面。
//
// 這三個畫面（作戰基地 / 出擊成功 / 出擊失敗）原本是一塊漸層加一行字 ——
// 而玩家每一局至少會看到兩次。三張各自的底圖，讓「回到基地」跟
// 「這一局結束了」在視覺上是不同的兩件事，而不是同一個空盒子換字。
export function renderIdle(ctx, g, size, title, mood = 'hub') {
  ctx.clearRect(0, 0, size, size);

  const art = uiSprite(mood === 'win' ? 'idle-win' : mood === 'lose' ? 'idle-lose' : 'idle-hangar');
  if (art) {
    ctx.drawImage(art, 0, 0, size, size);
  } else {
    const grad = ctx.createRadialGradient(size * 0.5, size * 0.35, 10, size * 0.5, size * 0.5, size * 0.75);
    grad.addColorStop(0, '#1d3242');
    grad.addColorStop(1, '#0b151c');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
  }

  // 中央壓一層徑向暗幕再放字。撤離那張中間是亮天空，
  // 沒有這層的話白字直接消失在雲裡。
  const scrim = ctx.createRadialGradient(size * 0.5, size * 0.48, size * 0.05, size * 0.5, size * 0.48, size * 0.55);
  scrim.addColorStop(0, 'rgba(8,14,19,.82)');
  scrim.addColorStop(0.55, 'rgba(8,14,19,.55)');
  scrim.addColorStop(1, 'rgba(8,14,19,0)');
  ctx.fillStyle = scrim;
  ctx.fillRect(0, 0, size, size);

  ctx.textAlign = 'center';
  ctx.fillStyle = mood === 'win' ? '#bff0cf' : mood === 'lose' ? '#f5c3ca' : 'rgba(224,238,245,.95)';
  ctx.font = `bold ${Math.round(size * 0.058)}px ${FONT}`;
  ctx.fillText(title, size / 2, size * 0.48);

  const sub = mood === 'win' ? '任務完成，返航中'
    : mood === 'lose' ? '訊號中斷'
      : '待命中';
  ctx.fillStyle = 'rgba(190,210,222,.6)';
  ctx.font = `${Math.round(size * 0.024)}px ${FONT}`;
  ctx.fillText(sub, size / 2, size * 0.48 + Math.round(size * 0.05));
  ctx.textAlign = 'start';
}


// 敵方意圖：這一回合每隻敵人打算走去哪、打誰、打多重。
//
// 這是整個遊戲最重要的一層資訊。沒有它，戰棋就退化成「動完看誰運氣好」；
// 有了它，每一步都是在回答「我要不要用這一格換那一刀」。
function drawIntents(ctx, g, cell, time, intents) {
  if (!intents?.length || g.battle?.phase !== 'player') return;
  // 只有「這一擊會打死人」才閃。
  //
  // 原本移動框與攻擊線都跟著呼吸，結果是整個棋盤一直在動 ——
  // 而畫面上會動的東西會一直搶注意力，代表玩家沒辦法用「有東西在閃」
  // 判斷任何事情。閃爍要留給唯一真正緊急的狀況，其餘一律靜態顯示。
  const alarm = 0.72 + Math.sin(time / 300) * 0.28;

  for (const it of intents) {
    const u = unitById(g, it.unitId);
    if (!u?.alive) continue;
    const from = { x: PAD + u.x * cell + cell * 0.5, y: PAD + u.y * cell + cell * 0.5 };

    // 要移動：虛線到目的地，終點一個空心方框
    if (it.move) {
      const to = { x: PAD + it.move.x * cell + cell * 0.5, y: PAD + it.move.y * cell + cell * 0.5 };
      ctx.save();
      ctx.strokeStyle = 'rgba(255,180,120,.46)'; // 靜態：走位只是資訊，不是警報
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 5]);
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.strokeRect(to.x - cell * 0.30, to.y - cell * 0.30, cell * 0.6, cell * 0.6);
      ctx.restore();
      from.x = to.x; from.y = to.y; // 攻擊線從「移動之後的位置」畫起才誠實
    }

    if (it.kind !== 'attack') continue;
    const t = unitById(g, it.targetId);
    if (!t?.alive) continue;
    const to = { x: PAD + t.x * cell + cell * 0.5, y: PAD + t.y * cell + cell * 0.5 };

    // 會被打死的話整條線變紅加粗 —— 那是玩家最需要一眼看到的事
    ctx.save();
    // 致命線會閃，非致命線靜止。這樣「有東西在閃」就等於「有人要死了」。
    ctx.strokeStyle = it.kills ? `rgba(255,70,90,${alarm})` : 'rgba(255,150,115,.72)';
    ctx.lineWidth = it.kills ? 4 : 2.5;
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();

    const label = it.min === it.max ? `${it.min}` : `${it.min}-${it.max}`;
    const fs = Math.round(cell * 0.15);
    ctx.font = `800 ${fs}px ${FONT}`;
    const w = ctx.measureText(label).width + fs * 1.1;
    const bx = Math.max(4, Math.min(PAD * 2 + GRID * cell - w - 4, to.x - w / 2));
    // 最下排的目標，預告框會掉出棋盤 —— 掉出去就翻到單位上方。
    const below = to.y + cell * 0.30;
    const by = below + fs * 1.5 > PAD + GRID * cell ? to.y - cell * 0.30 - fs * 1.5 : below;
    ctx.fillStyle = it.kills ? 'rgba(150,15,30,.95)' : 'rgba(60,30,20,.88)';
    roundRect(ctx, bx, by, w, fs * 1.5, 4);
    ctx.fill();
    ctx.strokeStyle = it.kills ? '#ff4d6a' : 'rgba(255,160,130,.7)';
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.fillStyle = it.kills ? '#ffd7dd' : '#ffd2c0';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, to.x, by + fs * 0.78);
    ctx.textAlign = 'start';
    ctx.textBaseline = 'alphabetic';
    ctx.restore();
  }
}
