// Canvas 繪製層。只讀 game state，不改它。
// 戰鬥棋盤與關卡樹共用同一張 canvas，由 g.screen 決定畫哪一個。

import { GRID, FLOORS, NODE_TYPES } from './data.js';
import { key, dist, reachableTiles, aliveOf, unitById, availableNodes } from './engine.js';
import { unitSprite, coverSprite } from './assets.js';

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
    r: Math.max(11, size * 0.021),
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
    ctx.globalAlpha = node.visited || isOpen ? 1 : 0.45;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r * (isHover && isOpen ? 1.15 : 1), 0, Math.PI * 2);
    ctx.fillStyle = style.fill;
    ctx.fill();
    ctx.strokeStyle = isCurrent ? '#ffffff' : style.ring;
    ctx.lineWidth = isCurrent ? 3 : 2;
    ctx.stroke();

    ctx.fillStyle = style.ink;
    ctx.font = `${Math.round(p.r * 1.05)}px ${FONT}`;
    ctx.fillText(NODE_TYPES[node.type].icon, p.x, p.y + 1);
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

export function renderBattle(ctx, g, size, time, fxList) {
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
  drawUnits(ctx, g, cell, time);
  drawFx(ctx, fxList, cell);

  const b = g.battle;
  const typeLabel = b.nodeType === 'boss' ? '頭目戰' : b.nodeType === 'elite' ? '精英交戰' : '交火';
  drawBanner(ctx, size, `F${b.floor} ${typeLabel} | 第 ${b.turn} 回合 | ${b.phase === 'player' ? '我方行動' : b.phase === 'ai' ? '敵方行動' : ''}`);

  if (g.pending.draft) drawToast(ctx, size, '升級改裝中');
  else if (b.phase === 'lose') drawToast(ctx, size, '全隊失去戰鬥能力');
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

  if (b.actionMode === 'move') {
    ctx.fillStyle = 'rgba(113,217,147,.18)';
    for (const t of reachableTiles(g, u)) {
      ctx.fillRect(PAD + t.x * cell + 8, PAD + t.y * cell + 8, cell - 16, cell - 16);
    }
  } else if (!u.attacked) {
    ctx.fillStyle = 'rgba(255,134,120,.22)';
    for (const e of aliveOf(g, 'e')) {
      if (dist(u.x, u.y, e.x, e.y) <= u.rg) {
        ctx.fillRect(PAD + e.x * cell + 8, PAD + e.y * cell + 8, cell - 16, cell - 16);
      }
    }
  }
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

      const s = outerR * 2 * (1 + pulse * 0.012);
      ctx.save();
      ctx.translate(cx, cy + recoil * r * 0.5);
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

function drawBanner(ctx, size, text) {
  // 高度與位置要留給棋盤上方的座標標籤（畫在 y = PAD - 12），不然會疊在一起
  ctx.fillStyle = 'rgba(14,26,34,.86)';
  ctx.fillRect(PAD * 0.4, 4, size - PAD * 0.8, 28);
  ctx.fillStyle = '#dce9f0';
  ctx.font = `13px ${FONT}`;
  ctx.textAlign = 'start';
  ctx.fillText(text, PAD * 0.4 + 12, 23);
}

function drawToast(ctx, size, text) {
  ctx.fillStyle = 'rgba(0,0,0,.55)';
  ctx.fillRect(0, size * 0.42, size, 56);
  ctx.fillStyle = '#fff2d4';
  ctx.font = `bold 28px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.fillText(text, size / 2, size * 0.42 + 38);
  ctx.textAlign = 'start';
}

// 空畫面（大廳與結算時 canvas 不畫棋盤）
export function renderIdle(ctx, g, size, title) {
  ctx.clearRect(0, 0, size, size);
  const grad = ctx.createRadialGradient(size * 0.5, size * 0.35, 10, size * 0.5, size * 0.5, size * 0.75);
  grad.addColorStop(0, '#1d3242');
  grad.addColorStop(1, '#0b151c');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = 'rgba(213,228,235,.9)';
  ctx.font = `bold ${Math.round(size * 0.055)}px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.fillText(title, size / 2, size * 0.48);
  ctx.textAlign = 'start';
}
