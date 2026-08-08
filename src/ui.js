// DOM 面板層。用「重建 innerHTML + 事件委派」的方式，
// 所以重繪不會弄丟 handler；靠 signature 比對避免每一幀都重建。

import { TREE, META_UPGRADES, NODE_TYPES, FLOORS } from './data.js';
import { availableNodes, squadAlive, xpToNext, unitById } from './engine.js';
import { upgradeList } from './meta.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const btn = (act, label, opts = {}) => {
  const dis = opts.disabled ? ' disabled' : '';
  const cls = opts.cls ? ` class="${opts.cls}"` : '';
  return `<button type="button" data-act="${esc(act)}"${cls}${dis}>${esc(label)}</button>`;
};

export function createUI(root, actions) {
  // 單一委派：面板重建幾百次也不用重綁
  root.addEventListener('click', (ev) => {
    const el = ev.target.closest('[data-act]');
    if (!el || el.disabled) return;
    const [name, ...args] = el.dataset.act.split(':');
    const fn = actions[name];
    if (fn) fn(...args);
  });

  let lastSig = '';

  const signature = (g, meta) => [
    g.screen,
    g.credits,
    meta.cores,
    Object.entries(meta.upgrades).map(([k, v]) => `${k}${v}`).join(''),
    g.focusId,
    g.currentNodeId,
    g.log.length,
    g.squad.map((u) => `${u.hp}/${u.mhp}|${u.ap}|${u.attacked}|${u.lv}|${u.sp}|${u.atk}|${u.rg}|${u.path}|${Object.keys(u.ul).join('')}|${u.alive}`).join(';'),
    g.battle ? `${g.battle.turn}|${g.battle.phase}|${g.battle.actionMode}|${g.battle.selectedId}|${g.battle.units.filter((u) => u.alive).length}` : '-',
    g.pending.draft ? `d${g.pending.draft.unitId}${g.pending.draft.cards.map((c) => c.id).join('')}` : '-',
    g.pending.event ? `e${g.pending.event.id}${g.pending.event.resolved ? 'r' : ''}` : '-',
    g.pending.shop ? `s${g.pending.shop.items.map((i) => (i.sold ? 1 : 0)).join('')}` : '-',
    g.pending.supply ? `p${g.pending.supply.resolved ? 1 : 0}` : '-',
    g.result ? 'R' : '-',
  ].join('~');

  return {
    render(g, meta, opts = {}) {
      const sig = signature(g, meta) + (opts.force ? Math.random() : '');
      if (sig === lastSig) return;
      lastSig = sig;
      root.innerHTML = panelHtml(g, meta, opts);
    },
    invalidate() { lastSig = ''; },
  };
}

// ---------------------------------------------------------------- 面板組裝

function panelHtml(g, meta, opts) {
  const parts = [topBar(g, meta, opts)];

  switch (g.screen) {
    case 'hub': parts.push(hubPanel(g, meta)); break;
    case 'map': parts.push(mapPanel(g)); break;
    case 'battle': parts.push(battlePanel(g)); break;
    case 'event': parts.push(eventPanel(g)); break;
    case 'shop': parts.push(shopPanel(g)); break;
    case 'supply': parts.push(supplyPanel(g)); break;
    case 'result': parts.push(resultPanel(g, meta)); break;
    default: break;
  }

  if (g.pending.draft) parts.push(draftPanel(g));
  if (g.screen !== 'hub' && g.screen !== 'result') {
    parts.push(squadPanel(g));
    parts.push(treePanel(g));
  }
  parts.push(logPanel(g));
  return parts.join('');
}

function topBar(g, meta, opts) {
  const audioLabel = opts.audioOn ? '音效 開' : '音效 關';
  const inRun = g.screen !== 'hub';
  return `
    <div class="topbar">
      <div class="stat"><span>核心碎片</span><b>${meta.cores}</b></div>
      <div class="stat"><span>信用點</span><b>${inRun ? g.credits : '-'}</b></div>
      <div class="stat"><span>層數</span><b>${inRun ? `${g.stats.depth}/${FLOORS - 1}` : '-'}</b></div>
      <div class="stat"><span>種子</span><b class="seed">${esc(g.seedLabel)}</b></div>
    </div>
    <div class="row2">
      ${btn('audio', audioLabel)}
      ${btn('toHub', '放棄並返回基地', { disabled: !inRun })}
    </div>`;
}

// ---------------------------------------------------------------- 大廳

function hubPanel(g, meta) {
  const list = upgradeList(meta).map((u) => {
    const label = u.maxed ? '已滿階' : `${u.cost} 碎片`;
    const canBuy = !u.maxed && meta.cores >= u.cost;
    return `
      <div class="item">
        <div class="item-head">
          <b>${esc(u.n)}</b>
          <span class="tag">${u.level}/${u.max}</span>
        </div>
        <div class="item-body">${esc(u.d)}</div>
        ${btn(`buy:${u.id}`, label, { disabled: !canBuy })}
      </div>`;
  }).join('');

  const s = meta.stats;
  return `
    <section>
      <h2>作戰基地</h2>
      <p class="hint">每次出擊都會重新生成關卡樹與敵人配置。陣亡不會清空核心碎片，永久升級會留下來。</p>
      <div class="row2">
        ${btn('startRun', '開始新出擊')}
        ${btn('startDaily', '每日挑戰')}
      </div>
      <div class="seedrow">
        <input id="seedInput" type="text" placeholder="輸入種子（可選）" maxlength="24" autocomplete="off">
        ${btn('startSeed', '用這個種子出擊')}
      </div>
    </section>
    <section>
      <h2>戰績</h2>
      <div class="statgrid">
        <div><span>出擊次數</span><b>${s.runs}</b></div>
        <div><span>通關次數</span><b>${s.wins}</b></div>
        <div><span>最深層數</span><b>${s.bestDepth}</b></div>
        <div><span>累計擊殺</span><b>${s.totalKills}</b></div>
      </div>
    </section>
    <section>
      <h2>永久升級</h2>
      <div class="list">${list}</div>
      ${btn('resetMeta', '重置所有進度', { cls: 'danger' })}
    </section>`;
}

// ---------------------------------------------------------------- 地圖

function mapPanel(g) {
  const open = availableNodes(g);
  const options = open.map((n) => {
    const t = NODE_TYPES[n.type];
    return `
      <div class="item">
        <div class="item-head"><b>${t.icon} ${esc(t.n)}</b><span class="tag">F${n.floor}</span></div>
        <div class="item-body">${esc(nodeHint(n.type))}</div>
        ${btn(`goNode:${n.id}`, '前往')}
      </div>`;
  }).join('');

  return `
    <section>
      <h2>推進路線</h2>
      <p class="hint">點畫面上發亮的節點，或用下面的按鈕。路線一旦選定就無法回頭。</p>
      <div class="list">${options || '<div class="item">沒有可前進的節點。</div>'}</div>
    </section>`;
}

function nodeHint(type) {
  return {
    battle: '標準交火，清空敵人後取得信用點。',
    elite: '敵人更多也更硬，勝利後額外獲得一次改裝抽卡。',
    event: '文字選擇，可能是補給也可能是陷阱。',
    supply: '三選一：回血、改裝抽卡或換信用點。',
    shop: '用信用點購買改裝與服務。',
    boss: '最終目標。擊破即通關本次出擊。',
  }[type] || '';
}

// ---------------------------------------------------------------- 戰鬥

function battlePanel(g) {
  const b = g.battle;
  const isPlayer = b.phase === 'player' && !g.pending.draft;
  const sel = unitById(g, b.selectedId);

  return `
    <section>
      <h2>指令</h2>
      <div class="row3">
        ${btn('mode:move', '移動 (M)', { disabled: !isPlayer, cls: b.actionMode === 'move' ? 'on' : '' })}
        ${btn('mode:attack', '攻擊 (A)', { disabled: !isPlayer, cls: b.actionMode === 'attack' ? 'on' : '' })}
        ${btn('endturn', '結束回合 (E)', { disabled: !isPlayer })}
      </div>
      <p class="hint">
        ${sel ? `目前選定：${esc(sel.n)}（AP ${sel.ap}/${sel.map}${sel.attacked ? '，本回合已攻擊' : ''}）` : '點擊我方單位選定'}<br>
        AP 用來移動，<b>攻擊每回合限一次</b>且需保留 1 AP。單位右上角有橫槓 = 已出手。<br>
        快捷鍵 M / A / E，Tab 切換單位，F 全螢幕
      </p>
    </section>`;
}

function draftPanel(g) {
  const d = g.pending.draft;
  const u = g.squad.find((v) => v.id === d.unitId);
  const source = { levelup: '升級', elite: '精英獎勵', supply: '補給改裝' }[d.source] || '改裝';
  const cards = d.cards.map((c) => `
    <div class="item card-${rarityClass(c.r)}">
      <div class="item-head"><b>${esc(c.n)}</b><span class="tag">${esc(c.r)}</span></div>
      <div class="item-body">${esc(c.d)}</div>
      ${btn(`draft:${c.id}`, '選擇')}
    </div>`).join('');

  return `
    <section class="highlight">
      <h2>${esc(source)}改裝 — ${esc(u?.n ?? '隊員')}</h2>
      <p class="hint">選一張，其餘捨棄。</p>
      <div class="list">${cards}</div>
    </section>`;
}

function rarityClass(r) {
  return { 普通: 'common', 稀有: 'rare', 史詩: 'epic' }[r] || 'common';
}

// ---------------------------------------------------------------- 事件 / 商店 / 補給

function eventPanel(g) {
  const ev = g.pending.event;
  if (ev.resolved) {
    return `
      <section class="highlight">
        <h2>${esc(ev.n)}</h2>
        <p class="hint">${esc(ev.resolved.text)}</p>
        ${btn('eventClose', '繼續推進')}
      </section>`;
  }
  const opts = ev.opts.map((o, i) => {
    const affordable = !o.cost || g.credits >= o.cost;
    const risk = o.risk ? `<span class="tag">成功率 ${Math.round(o.risk.p * 100)}%</span>` : '';
    return `
      <div class="item">
        <div class="item-body">${esc(o.d)} ${risk}</div>
        ${btn(`event:${i}`, '選擇', { disabled: !affordable })}
      </div>`;
  }).join('');

  return `
    <section class="highlight">
      <h2>${esc(ev.n)}</h2>
      <p class="hint">${esc(ev.d)}</p>
      <div class="list">${opts}</div>
    </section>`;
}

function shopPanel(g) {
  const items = g.pending.shop.items.map((it, i) => `
    <div class="item card-${rarityClass(it.r)}${it.sold ? ' sold' : ''}">
      <div class="item-head"><b>${esc(it.n)}</b><span class="tag">${it.price} CR</span></div>
      <div class="item-body">${esc(it.d)}</div>
      ${btn(`shop:${i}`, it.sold ? '已售出' : '購買', { disabled: it.sold || g.credits < it.price })}
    </div>`).join('');

  const focus = g.squad.find((u) => u.id === g.focusId);
  return `
    <section class="highlight">
      <h2>黑市</h2>
      <p class="hint">改裝類商品會裝在目前選定的隊員身上：<b>${esc(focus?.n ?? '未選')}</b>（在下方小隊清單切換）。</p>
      <div class="list">${items}</div>
      ${btn('shopLeave', '離開黑市')}
    </section>`;
}

function supplyPanel(g) {
  const sup = g.pending.supply;
  if (sup.resolved) {
    return `
      <section class="highlight">
        <h2>補給完成</h2>
        ${btn('supplyClose', '繼續推進')}
      </section>`;
  }
  const opts = sup.options.map((o) => `
    <div class="item">
      <div class="item-head"><b>${esc(o.n)}</b></div>
      <div class="item-body">${esc(o.d)}</div>
      ${btn(`supply:${o.id}`, '選擇')}
    </div>`).join('');

  return `
    <section class="highlight">
      <h2>補給點</h2>
      <p class="hint">三選一。</p>
      <div class="list">${opts}</div>
    </section>`;
}

// ---------------------------------------------------------------- 結算

function resultPanel(g, meta) {
  const r = g.result;
  return `
    <section class="highlight${r.won ? '' : ' fail'}">
      <h2>${r.won ? '出擊成功' : '出擊失敗'}</h2>
      <div class="statgrid">
        <div><span>抵達層數</span><b>${r.depth}</b></div>
        <div><span>擊殺</span><b>${r.kills}</b></div>
        <div><span>精英擊殺</span><b>${r.eliteKills}</b></div>
        <div><span>戰鬥場次</span><b>${r.battles}</b></div>
        <div><span>總回合</span><b>${r.turns}</b></div>
        <div><span>取得碎片</span><b>+${r.cores}</b></div>
      </div>
      <p class="hint">種子 <b>${esc(r.seedLabel)}</b>（原始值 ${esc(r.seed)}）。目前碎片存量 ${meta.cores}。</p>
      <div class="row2">
        ${btn('toHub', '返回基地')}
        ${btn('startRun', '立刻再來一次')}
      </div>
    </section>`;
}

// ---------------------------------------------------------------- 小隊與技能樹

function squadPanel(g) {
  const rows = g.squad.map((u) => {
    const inBattle = g.battle ? unitById(g, u.id) : null;
    const dead = !u.alive;
    const focus = u.id === g.focusId ? ' sel' : '';
    const pos = inBattle && u.alive ? `(${u.x + 1},${u.y + 1}) ` : '';
    const fired = inBattle && u.attacked ? '<span class="tag">已出手</span>' : '';
    return `
      <div class="item${focus}${dead ? ' down' : ''}" data-act="focus:${u.id}">
        <div class="item-head">
          <b>${esc(u.n)}</b>
          <span class="tag">Lv.${u.lv}${u.path ? ` ${u.path === 'ASSAULT' ? '強襲' : '偵察'}` : ''}</span>
        </div>
        <div class="item-body">
          ${pos}HP ${u.hp}/${u.mhp} ｜ AP ${u.ap}/${u.map} ${fired}<br>
          ATK ${u.atk} ｜ RG ${u.rg} ｜ SP ${u.sp}<br>
          XP ${u.xp}/${xpToNext(u.lv)}
        </div>
      </div>`;
  }).join('');

  return `<section><h2>小隊（點選切換改裝目標）</h2><div class="list">${rows}</div></section>`;
}

function treePanel(g) {
  const u = g.squad.find((v) => v.id === g.focusId);
  if (!u) return '<section><h2>技能樹</h2><div class="item">尚未選定隊員。</div></section>';
  if (!u.path) {
    return `<section><h2>技能樹 — ${esc(u.n)}</h2><div class="item">尚未選定路線。透過升級抽卡取得「路線」卡片才會開啟。</div></section>`;
  }

  const rows = TREE[u.path].map((n) => {
    const unlocked = !!u.ul[n.lv];
    const canBuy = !unlocked && u.lv >= n.lv && u.sp > 0;
    return `
      <div class="item${unlocked ? ' done' : ''}">
        <div class="item-head"><b>${esc(n.n)}</b><span class="tag">Lv.${n.lv}</span></div>
        <div class="item-body">${esc(n.d)}</div>
        ${btn(`tree:${u.id}:${n.lv}`, unlocked ? '已解鎖' : `解鎖（1 SP）`, { disabled: !canBuy })}
      </div>`;
  }).join('');

  return `<section><h2>技能樹 — ${esc(u.n)}（SP ${u.sp}）</h2><div class="list">${rows}</div></section>`;
}

function logPanel(g) {
  const text = g.log.slice(-14).map((l) => `${l.important ? '*' : '-'} ${l.text}`).join('\n');
  return `<section><h2>戰鬥記錄</h2><pre class="log">${esc(text)}</pre></section>`;
}

// 給 main.js 用來畫 canvas 下方的 HUD
export function hudHtml(g) {
  if (g.screen === 'battle' && g.battle) {
    const b = g.battle;
    const alive = squadAlive(g).length;
    return `
      <div>層數 <b>F${b.floor}</b></div>
      <div>回合 <b>${b.turn}</b></div>
      <div>狀態 <b>${b.phase === 'player' ? '我方' : b.phase === 'ai' ? '敵方' : '結算'}</b></div>
      <div>存活 <b>${alive}/${g.squad.length}</b></div>`;
  }
  return `
    <div>層數 <b>${g.stats.depth}/${FLOORS - 1}</b></div>
    <div>信用點 <b>${g.screen === 'hub' ? '-' : g.credits}</b></div>
    <div>擊殺 <b>${g.stats.kills}</b></div>
    <div>戰鬥 <b>${g.stats.battles}</b></div>`;
}

export { META_UPGRADES };
