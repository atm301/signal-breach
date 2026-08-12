// DOM 面板層。用「重建 innerHTML + 事件委派」的方式，
// 所以重繪不會弄丟 handler；靠 signature 比對避免每一幀都重建。

import {
  TREE, META_UPGRADES, NODE_TYPES, FLOORS, CREDITS, CREDITS_META, ELEMENTS, TUNE, TRAITS, traitV,
  SKILLS, PATH_NAMES, treeNodeInfo,
} from './data.js';
import {
  availableNodes, squadAlive, xpToNext, unitById, actableUnits, damageBreakdown, dist,
  repairOptions, skillsOf, skillState, skillCd,
} from './engine.js';
import { upgradeList } from './meta.js';
import { tutorialProgress } from './tutorial.js';
import { playSfx } from './audio.js';
import { nodeIconUrl } from './assets.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

// 屬性用有顏色的字，跟棋盤上的屬性徽章同色，兩邊才對得起來
const elTag = (u) => {
  const e = ELEMENTS[u.el];
  if (!e) return '屬性 —';
  return `<span style="color:${e.color}">◈ ${esc(e.n)}</span>`;
};
// 穩定性是抽象數字，直接換算成「傷害會飄多少」玩家才有感
const spreadPct = (u) => Math.round(TUNE.BASE_SPREAD * (1 - (u.stab ?? 60) / 100) * 100);

// 詞條標籤。正負用顏色分，玩家掃過名單時不必逐條讀字。
// 說明文字用 u.trv 裡「實際生效」的數值，不是基準值 ——
// 買了「詞條強化」卻看到沒變的說明，玩家會以為升級沒生效。
const traitDesc = (u, id) => {
  const t = TRAITS[id];
  return typeof t.d === 'function' ? t.d(traitV(u, id)) : t.d;
};
const traitTags = (u) => (u.tr ?? []).map((id) => {
  const t = TRAITS[id];
  if (!t) return '';
  return `<span class="trait ${t.good ? 'good' : 'bad'}" title="${esc(traitDesc(u, id))}">${t.good ? '＋' : '－'}${esc(t.n)}</span>`;
}).join('');

const btn = (act, label, opts = {}) => {
  const dis = opts.disabled ? ' disabled' : '';
  const cls = opts.cls ? ` class="${opts.cls}"` : '';
  return `<button type="button" data-act="${esc(act)}"${cls}${dis}>${esc(label)}</button>`;
};

export function createUI(root, actions) {
  // 單一委派：面板重建幾百次也不用重綁
  // 每個可點的東西都要有回饋音。actions 自己還會再疊語意音（購買成功、升級等），
  // 這裡只負責「你按到了」這件事。
  const CLICK_SFX = { goNode: 'node', music: 'ui', sfx: 'ui' };

  root.addEventListener('click', (ev) => {
    const el = ev.target.closest('[data-act]');
    if (!el || el.disabled) return;
    const [name, ...args] = el.dataset.act.split(':');
    playSfx(CLICK_SFX[name] || 'click');
    const fn = actions[name];
    if (fn) fn(...args);
  });

  root.addEventListener('pointerenter', (ev) => {
    const el = ev.target instanceof Element ? ev.target.closest('button[data-act]') : null;
    if (el && !el.disabled) playSfx('hover');
  }, true);

  let lastSig = '';

  const signature = (g, meta) => [
    g.screen,
    g.credits,
    meta.cores,
    Object.entries(meta.upgrades).map(([k, v]) => `${k}${v}`).join(''),
    g.focusId,
    g.currentNodeId,
    g.log.length,
    // stab / map / rep 也要進來：戰後修整買了「校準瞄具」只動 stab，
    // 少了它面板不會重畫，玩家會以為錢花掉但什麼都沒發生。
    g.squad.map((u) => `${u.hp}/${u.mhp}|${u.ap}/${u.map}|${u.attacked}|${u.lv}|${u.sp}|${u.atk}|${u.rg}|${u.stab}|${u.path}|${Object.keys(u.ul).join('')}|${JSON.stringify(u.rep ?? 0)}|${u.alive}`).join(';'),
    // 位置與朝向要進 signature：傷害預測表會因為誰站哪、面朝哪而整張改寫，
    // 只比 HP/AP 的話，敵人移動完預測值是舊的 —— 那比沒有預測更糟。
    // 冷卻、狀態、已就緒的技能也要進來：技能列的按鈕文字全靠它們算出來
    g.battle ? `${g.battle.turn}|${g.battle.phase}|${g.battle.selectedId}|${actableUnits(g).length}|${
      g.battle.armedSkill ? `${g.battle.armedSkill.unitId}${g.battle.armedSkill.id}` : '-'
    }|${
      g.battle.units.filter((u) => u.alive).map((u) => `${u.x},${u.y},${u.hp},${(u.faceX ?? 0).toFixed(1)},${(u.faceY ?? 0).toFixed(1)},${JSON.stringify(u.cd ?? 0)},${JSON.stringify(u.st ?? 0)}`).join('/')
    }` : '-',
    // unitId 要在裡面：換改裝對象時卡片與標題都會變，少了它按了沒反應
    g.pending.draft ? `d${g.pending.draft.unitId}${g.pending.draft.cards.map((c) => c.id).join('')}` : '-',
    g.pending.event ? `e${g.pending.event.id}${g.pending.event.resolved ? 'r' : ''}` : '-',
    g.pending.shop ? `s${g.pending.shop.items.map((i) => (i.sold ? 1 : 0)).join('')}` : '-',
    g.pending.supply ? `p${g.pending.supply.resolved ? 1 : 0}` : '-',
    g.pending.victory ? `v${g.pending.victory.credits}` : '-',
    g.pending.recruit ? `r${g.pending.recruit.picked.join(',')}` : '-',
    g.result ? 'R' : '-',
  ].join('~');

  return {
    render(g, meta, opts = {}) {
      // opts.tip 進 signature 是防禦性的：目前每個會換提示的路徑都有 invalidate()
      // 或本來就會改到 state，所以拔掉它現階段也不會壞。
      // 但「提示變了、面板沒重畫」是很難追的 bug，而這一行的成本是零。
      const sig = `${signature(g, meta)}~${opts.music}~${opts.sfx}~${opts.track}~${opts.save ? opts.save.savedAt : '-'}~${opts.tip?.id ?? '-'}${opts.force ? Math.random() : ''}`;
      if (sig === lastSig) return;
      lastSig = sig;
      root.innerHTML = panelHtml(g, meta, opts);
    },
    invalidate() { lastSig = ''; },
  };
}

// ---------------------------------------------------------------- 面板組裝

function panelHtml(g, meta, opts) {
  // 開場與作者的話不顯示 topBar：那上面全是「這一場出擊」的數字，這兩個畫面用不到
  if (g.screen === 'title') return titlePanel(meta, opts);
  if (g.screen === 'credits') return creditsPanel();

  const parts = [topBar(g, meta, opts)];

  // 教學提示排在最上面：它講的一定是「你現在正在看的這個畫面」。
  // 放在下面的話，玩家得先滑過整個面板才看得到說明，那就失去情境的意義了。
  if (opts.tip) parts.push(tipPanel(opts.tip));

  // 編隊還沒確認就不該看到地圖 —— 兩個都是「選擇」，同時出現只會讓玩家點錯。
  // 但只在地圖畫面接管：不加 screen 判斷的話，回到大廳時編隊面板會蓋掉升級清單。
  if (g.pending.recruit && g.screen === 'map') {
    parts.push(recruitPanel(g));
    parts.push(logPanel(g));
    return parts.join('');
  }

  switch (g.screen) {
    case 'hub': parts.push(hubPanel(g, meta)); break;
    case 'map': parts.push(mapPanel(g)); break;
    case 'battle': parts.push(battlePanel(g)); break;
    case 'victory': parts.push(victoryPanel(g)); break;
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

// 情境教學卡。每條只出現一次，看過就不再打擾。
function tipPanel(tip) {
  return `
    <section class="tip">
      <div class="tip-head"><span class="tip-badge">教學</span><b>${esc(tip.t)}</b></div>
      <ul class="tip-body">${tip.b.map((line) => `<li>${esc(line)}</li>`).join('')}</ul>
      <div class="row2">
        ${btn(`tipOk:${tip.id}`, '知道了', { cls: 'primary' })}
        ${btn('tipOff', '關閉教學提示')}
      </div>
    </section>`;
}

function topBar(g, meta, opts) {
  const inRun = g.screen !== 'hub';
  return `
    <div class="topbar">
      <div class="stat"><span>核心碎片</span><b>${meta.cores}</b></div>
      <div class="stat"><span>信用點</span><b>${inRun ? g.credits : '-'}</b></div>
      <div class="stat"><span>層數</span><b>${inRun ? `${g.stats.depth}/${FLOORS - 1}` : '-'}</b></div>
      <div class="stat"><span>種子</span><b class="seed">${esc(g.seedLabel)}</b></div>
    </div>
    <div class="row2">
      ${btn('music', opts.music ? '♪ 音樂 開' : '♪ 音樂 關', { cls: opts.music ? 'on' : '' })}
      ${btn('sfx', opts.sfx ? '♬ 音效 開' : '♬ 音效 關', { cls: opts.sfx ? 'on' : '' })}
    </div>
    <div class="row1">
      ${btn('toHub', '放棄並返回基地', { disabled: !inRun, cls: 'danger' })}
    </div>`;
}

// ---------------------------------------------------------------- 開場畫面

function relTime(ts) {
  if (!ts) return '';
  const min = Math.round((Date.now() - ts) / 60000);
  if (min < 1) return '剛剛';
  if (min < 60) return `${min} 分鐘前`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} 小時前`;
  return `${Math.round(hr / 24)} 天前`;
}

function titlePanel(meta, opts) {
  const save = opts.save;
  const s = meta.stats;

  const resume = save
    ? `
      <div class="item resume">
        <div class="item-head">
          <b>未完成的出擊</b>
          <span class="tag">${esc(relTime(save.savedAt))}</span>
        </div>
        <div class="item-body">
          第 ${save.floor} 層 ｜ 已擊殺 ${save.kills} ｜ 種子 ${esc(save.seedLabel)}<br>
          ${save.squad.map((u) => `${esc(u.n)} ${u.hp}/${u.mhp}`).join('　')}
        </div>
        ${btn('resumeRun', '繼續這場出擊', { cls: 'primary' })}
        ${btn('deleteSave', '刪除這筆存檔', { cls: 'danger' })}
      </div>`
    : '<p class="hint">目前沒有進行中的出擊。進度會在每次移動後自動存檔，關掉分頁也不會消失。</p>';

  const veteran = s.runs > 0
    ? `<div class="statgrid">
         <div><span>出擊次數</span><b>${s.runs}</b></div>
         <div><span>通關次數</span><b>${s.wins}</b></div>
         <div><span>最深層數</span><b>${s.bestDepth}</b></div>
       </div>`
    : '';

  return `
    <section class="title-hero">
      <div class="row1">${btn('play', s.runs > 0 ? '進入作戰基地' : '開始遊玩', { cls: 'primary big' })}</div>
      <div class="row2">
        ${btn('startDaily', '每日挑戰')}
        ${btn('credits', '作者的話')}
      </div>
      <div class="row2">
        ${btn('music', opts.music ? '♪ 音樂 開' : '♪ 音樂 關', { cls: opts.music ? 'on' : '' })}
        ${btn('sfx', opts.sfx ? '♬ 音效 開' : '♬ 音效 關', { cls: opts.sfx ? 'on' : '' })}
      </div>
      ${opts.track ? `<p class="hint nowplaying">♪ 現正播放：${esc(opts.track)}　${btn('shuffle', '換一首')}</p>` : ''}
    </section>
    <section>
      <h2>存檔</h2>
      ${resume}
    </section>
    ${veteran ? `<section><h2>戰績</h2>${veteran}<p class="hint">核心碎片 ${meta.cores}</p></section>` : ''}
    <section>
      <h2>怎麼玩</h2>
      <p class="hint">
        5x5 網格回合制戰棋。三人小隊，打穿 12 層隨機關卡。<br><br>
        <b>核心規則：AP 只用來移動，攻擊每回合限一次</b>，而且要留得出 1 點 AP。<br>
        站掩體可以擋掉 2 格以外的遠程傷害。<br><br>
        死了就從頭來，但賺到的核心碎片會留下來換永久升級。
      </p>
    </section>`;
}

// ---------------------------------------------------------------- 作者的話

function creditsPanel() {
  const body = CREDITS.map((block) => `
    ${block.h ? `<h3 class="credit-h">${esc(block.h)}</h3>` : ''}
    ${block.p.map((t) => `<p class="credit-p">${esc(t)}</p>`).join('')}
  `).join('');

  const m = CREDITS_META;
  return `
    <section>
      <div class="row1">${btn('titleBack', '← 回開場畫面')}</div>
    </section>
    <section class="credits">
      ${body}
      <div class="credit-sign">
        <b>${esc(m.author)}</b>　${esc(m.handle)}<br>
        ${esc(m.org)}<br>
        <a href="https://${m.site}" target="_blank" rel="noopener">${esc(m.site)}</a><br>
        <a href="https://${m.repo}" target="_blank" rel="noopener">${esc(m.repo)}</a>
      </div>
    </section>
    <section>
      <h2>用了什麼</h2>
      <div class="list">
        ${m.builtWith.map((t) => `<div class="item"><div class="item-body">${esc(t)}</div></div>`).join('')}
      </div>
    </section>`;
}

// ---------------------------------------------------------------- 大廳

function hubPanel(g, meta) {
  const tut = tutorialProgress(meta);
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
      <div class="row2">
        ${btn('tutorialToggle', tut.on ? `教學提示 開（${tut.seen}/${tut.total}）` : '教學提示 關', {
    cls: tut.on ? 'on' : '',
  })}
        ${btn('tutorialReset', '重看一次教學', { disabled: tut.seen === 0 })}
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
    const url = nodeIconUrl(n.type);
    const mark = url ? `<img class="node-icon" src="${url}" alt="">` : `${t.icon} `;
    return `
      <div class="item">
        <div class="item-head"><b>${mark}${esc(t.n)}</b><span class="tag">F${n.floor}</span></div>
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
  const pending = actableUnits(g).length;
  const allDone = isPlayer && pending === 0;

  return `
    <section>
      <h2>指令</h2>
      <div class="row1">
        ${btn('endturn', allDone ? '結束回合（全員已行動）' : `結束回合　空白鍵`, {
    disabled: !isPlayer,
    cls: allDone ? 'primary big' : '',
  })}
      </div>
      <p class="hint turnstate">
        ${isPlayer ? `還能行動：<b>${pending}</b> / ${squadAlive(g).length}` : (b.phase === 'ai' ? '敵方行動中' : '結算中')}
        ${sel ? `　｜　選定 ${esc(sel.n)} ${elTag(sel)}（AP ${sel.ap}/${sel.map}${sel.attacked ? '・已出手' : ''}）` : ''}
      </p>
      ${skillBar(g, sel, isPlayer)}
      ${forecastList(g, sel, isPlayer)}
      <p class="hint">
        <b>點敵人就打，點空地就走</b>，不用先切模式。攻擊完會自動跳到下一個單位。<br>
        AP 只用來移動，攻擊每回合限一次且需保留 1 AP。單位右上角有橫槓 = 已出手。<br>
        Tab 切換單位，空白鍵或 E 結束回合，F 全螢幕
      </p>
    </section>`;
}

// 出擊前的編隊。5 選 3。
//
// 這是整場出擊裡「資訊最完整、風險最低」的一次決策 ——
// 你看得到所有數值與詞條，還沒有任何損失。Roguelike 的第一個選擇就該長這樣：
// 不是賭運氣，是在五份已知的取捨裡選一組能互補的。
function recruitPanel(g) {
  const r = g.pending.recruit;
  if (!r) return '';
  const rows = g.recruits.map((u) => {
    const on = r.picked.includes(u.id);
    const idx = r.picked.indexOf(u.id);
    // 「幹員篩選」買來的無負面名額要標出來，不然玩家不會知道那 200 碎片換到了什麼
    const clean = (u.tr ?? []).every((id) => TRAITS[id]?.good);
    return `
      <div class="item recruit${on ? ' sel' : ''}" data-act="recruit:${u.id}">
        <div class="item-head">
          <b>${esc(u.n)}</b>
          ${clean ? '<span class="tag clean">無負面</span>' : ''}
          <span class="tag">${on ? `已編入 ${idx + 1}` : '候補'}</span>
        </div>
        <div class="item-body">
          HP ${u.mhp} ｜ ATK ${u.atk} ｜ RG ${u.rg} ｜ AP ${u.map}<br>
          ${elTag(u)} ｜ 穩定 ${u.stab}（傷害浮動 ±${spreadPct(u)}%）
          <div class="traits">${traitTags(u)}</div>
        </div>
      </div>`;
  }).join('');

  const n = r.picked.length;
  const els = new Set(r.picked.map((id) => g.recruits.find((u) => u.id === id)?.el).filter(Boolean));
  const warn = n === TUNE.SQUAD_SIZE && els.size < 2
    ? '<p class="hint warn">整隊同屬性：碰到剋你的敵人會整場打不動，建議至少混兩系。</p>'
    : '';

  return `
    <section class="highlight">
      <h2>✦ 編隊出擊</h2>
      <p class="hint">
        每次出擊的幹員都是隨機生成：數值有浮動，而且固定帶一個正面與一個負面詞條。<br>
        點名字加入或移除，選滿 <b>${TUNE.SQUAD_SIZE}</b> 人出發。屬性相剋是三系循環（動能→電磁→裝甲→動能）。
      </p>
      <div class="list">${rows}</div>
      ${warn}
      <div class="row1">
        ${btn('recruitGo', n === TUNE.SQUAD_SIZE ? '確認編隊，出擊' : `還要選 ${TUNE.SQUAD_SIZE - n} 人`, {
    disabled: n !== TUNE.SQUAD_SIZE, cls: 'primary big',
  })}
      </div>
    </section>`;
}

// 戰後修整。信用點的用途從「只能在商店花」變成「每場都要決定現在補血還是留著變強」。
function repairSection(g) {
  const opts = repairOptions(g);
  const rows = opts.map((o) => `
      <div class="item${o.ok ? '' : ' down'}">
        <div class="item-head">
          <b>${esc(o.n)}</b>
          <span class="tag">${o.surcharge ? '⚠ ' : ''}${o.cost} 點${o.max ? `・${o.used}/${o.max}` : ''}</span>
        </div>
        <div class="item-body">${esc(o.d)}　<span class="mut">→ ${esc(o.target)}</span></div>
        ${btn(`repair:${o.id}`, o.ok ? '購買' : (o.reason || '無法購買'), { disabled: !o.ok })}
      </div>`).join('');

  return `
    <section>
      <h2>戰後修整（信用點 ${g.credits}）</h2>
      <p class="hint">針對個人的項目會套用到小隊面板裡目前選定的幹員。</p>
      <div class="list">${rows}</div>
    </section>`;
}

// 選定單位的主動技能列。
//
// 冷卻剩幾回合要直接寫在按鈕上，不能只是變灰 ——
// 「還要 2 回合」跟「這場不能用了」對決策是完全不同的兩件事。
function skillBar(g, sel, isPlayer) {
  if (!sel) return '';
  const ids = skillsOf(sel);
  if (!ids.length) return '';
  const armed = g.battle?.armedSkill;

  const rows = ids.map((id) => {
    const s = SKILLS[id];
    const st = skillState(g, sel, id);
    const on = armed?.unitId === sel.id && armed.id === id;
    const label = st.left > 0 ? `${s.n}　冷卻 ${st.left}` : s.n;
    return `
      <div class="skill${st.ok ? '' : ' down'}${on ? ' armed' : ''}">
        <div class="skill-head">
          <b>${esc(s.n)}</b>
          <span class="tag">CD ${skillCd(sel, id)}・${s.ap} AP${s.attack ? '・算攻擊' : ''}</span>
        </div>
        <div class="item-body">${esc(s.d)}</div>
        ${btn(`skill:${sel.id}:${id}`, on ? '點棋盤指定目標（再按取消）' : (st.ok ? `使用 ${label}` : st.reason), {
    disabled: !isPlayer || (!st.ok && !on),
    cls: on ? 'primary' : '',
  })}
      </div>`;
  }).join('');

  return `<div class="skills">
      <div class="fc-head">主動技能（${esc(PATH_NAMES[sel.path] ?? '')}路線）</div>${rows}
    </div>`;
}

// 射程內目標的傷害預測表。
//
// canvas 上滑過敵人會跳預測卡，但手機沒有 hover —— 少了這張表，
// 手機玩家永遠看不到相剋和側背的算式，等於玩的是另一款沒有戰略的遊戲。
// 所以同一份資訊在面板再出一次，順便讓玩家可以「比較」而不只是「查詢」。
function forecastList(g, sel, isPlayer) {
  if (!isPlayer || !sel || !sel.alive) return '';
  const foes = g.battle.units
    .filter((u) => u.alive && u.tm === 'e' && dist(sel.x, sel.y, u.x, u.y) <= sel.rg)
    .map((u) => ({ u, f: damageBreakdown(g, sel, u) }))
    .sort((a, bb) => bb.f.mid - a.f.mid);
  if (!foes.length) return '';

  const blocked = sel.attacked >= 1 || sel.ap < 1;
  const rows = foes.map(({ u, f }) => {
    const tags = [
      f.elem > 1 ? '<b style="color:#8fffad">剋</b>' : f.elem < 1 ? '<b style="color:#ff9d9d">抗</b>' : '',
      f.flankLabel ? `<b style="color:#ffd980">${esc(f.flankLabel)}</b>` : '',
      f.cover ? `<span style="color:#9fb8c8">掩體−${f.cover}</span>` : '',
      f.guaranteedKill ? '<b style="color:#a8f5c0">必殺</b>' : f.possibleKill ? '<b style="color:#ffd980">可能擊殺</b>' : '',
    ].filter(Boolean).join(' ');
    const range = f.min === f.max ? `${f.min}` : `${f.min}–${f.max}`;
    return `<div class="fc-row"><span class="fc-n">${esc(u.n)} ${elTag(u)}</span>`
      + `<span class="fc-d">${range}</span>`
      + `<span class="fc-t">HP ${u.hp} ${tags}</span></div>`;
  }).join('');

  return `<div class="forecast${blocked ? ' dim' : ''}">
      <div class="fc-head">射程內目標${blocked ? '（本回合已出手）' : ''}</div>${rows}
    </div>`;
}

// 打倒最後一個敵人是一場戰鬥的高潮。直接彈回地圖等於把那個瞬間吃掉，
// 所以停在這裡讓玩家看清楚自己拿到了什麼。
function victoryPanel(g) {
  const v = g.pending.victory;
  if (!v) return '';
  const label = v.isBoss ? '頭目擊破' : v.nodeType === 'elite' ? '精英目標清除' : '區域肅清';

  const healRows = v.healed.length
    ? `<div class="item"><div class="item-head"><b>戰場修復</b></div><div class="item-body">${
        v.healed.map((h) => `${esc(h.name)} +${h.amount} HP（${h.hp}/${h.mhp}）`).join('<br>')
      }</div></div>`
    : '';

  const recoverRows = v.recovered.length
    ? `<div class="item"><div class="item-head"><b>傷員歸隊</b></div><div class="item-body">${
        v.recovered.map((r) => `${esc(r.name)} 以 ${r.hp} HP 歸隊`).join('<br>')
      }</div></div>`
    : '';

  const bonus = v.eliteReward
    ? '<p class="hint">精英獎勵：繼續之後會有一次額外改裝抽卡。</p>'
    : '';

  return `
    <section class="highlight victory">
      <h2>✦ ${esc(label)}</h2>
      <div class="statgrid">
        <div><span>層數</span><b>F${v.floor}</b></div>
        <div><span>擊殺</span><b>${v.kills}</b></div>
        <div><span>耗時</span><b>${v.turns} 回合</b></div>
      </div>
      <div class="reward">+${v.credits} 信用點</div>
      <div class="list">${healRows}${recoverRows}</div>
      ${bonus}
      ${btn('victoryClose', v.isBoss ? '完成出擊' : '繼續推進', { cls: 'primary' })}
    </section>
    ${v.isBoss ? '' : repairSection(g)}`;
}

function draftPanel(g) {
  const d = g.pending.draft;
  const u = g.squad.find((v) => v.id === d.unitId);
  // supply 原本寫成「補給改裝」，接上後面的「改裝」會變成「補給改裝改裝」
  const source = { levelup: '升級', elite: '精英獎勵', supply: '補給' }[d.source] || '';
  const cards = d.cards.map((c) => `
    <div class="item card-${rarityClass(c.r)}">
      <div class="item-head"><b>${esc(c.n)}</b><span class="tag">${esc(c.r)}</span></div>
      <div class="item-body">${esc(c.d)}</div>
      ${btn(`draft:${c.id}`, '選擇')}
    </div>`).join('');

  // 升級抽卡的對象是固定的（誰升級就是誰）；
  // 精英獎勵與補給則讓玩家挑人，所以會帶 options。
  const picker = d.options ? `
      <div class="draft-target">
        <span class="mut">改裝目標</span>
        ${d.options.map((o) => {
    const m = g.squad.find((v) => v.id === o.unitId);
    if (!m) return '';
    return btn(`draftTarget:${o.unitId}`, `${m.n} Lv.${m.lv}`, {
      cls: o.unitId === d.unitId ? 'on' : '',
    });
  }).join('')}
      </div>
      <p class="hint">換人不會重抽卡片，每個人的三張是各自固定的。</p>` : '';

  return `
    <section class="highlight">
      <h2>${esc(source)}改裝 — ${esc(u?.n ?? '隊員')}</h2>
      ${picker}
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
          <span class="tag">Lv.${u.lv}${u.path ? ` ${esc(PATH_NAMES[u.path] ?? u.path)}` : ''}</span>
        </div>
        <div class="item-body">
          ${pos}HP ${u.hp}/${u.mhp} ｜ AP ${u.ap}/${u.map} ${fired}<br>
          ATK ${u.atk} ｜ RG ${u.rg} ｜ SP ${u.sp}<br>
          ${elTag(u)} ｜ 穩定 ${u.stab ?? 60}（傷害浮動 ±${spreadPct(u)}%）<br>
          XP ${u.xp}/${xpToNext(u.lv)}
          <div class="traits">${traitTags(u)}</div>
        </div>
      </div>`;
  }).join('');

  return `<section><h2>小隊（點選切換改裝目標）</h2><div class="list">${rows}</div></section>`;
}

function treePanel(g) {
  const u = g.squad.find((v) => v.id === g.focusId);
  if (!u) return '<section><h2>技能樹</h2><div class="item">尚未選定隊員。</div></section>';
  if (!u.path) return `<section><h2>技能樹 — ${esc(u.n)}</h2><div class="item">這名幹員沒有路線。</div></section>`;

  // 五階一次全部列出來（包含還買不起的），玩家才能先規劃 build。
  // 這是《最後的咒語》的做法：看得到終點才有規劃可言。
  const rows = TREE[u.path].map((n) => {
    const info = treeNodeInfo(n);
    const unlocked = !!u.ul[n.lv];
    const levelOk = u.lv >= n.lv;
    const canBuy = !unlocked && levelOk && u.sp > 0;
    const why = unlocked ? '已解鎖'
      : !levelOk ? `需要 Lv.${n.lv}`
        : u.sp <= 0 ? '技能點不足' : '解鎖（1 SP）';
    return `
      <div class="item${unlocked ? ' done' : ''}${levelOk ? '' : ' down'}">
        <div class="item-head">
          <b>${info.skill ? '◆ ' : ''}${esc(info.n)}</b>
          <span class="tag">${info.skill ? '主動・' : '被動・'}Lv.${n.lv}</span>
        </div>
        <div class="item-body">${esc(info.d)}</div>
        ${btn(`tree:${u.id}:${n.lv}`, why, { disabled: !canBuy })}
      </div>`;
  }).join('');

  return `<section>
      <h2>技能樹 — ${esc(u.n)}（${esc(PATH_NAMES[u.path])}・SP ${u.sp}）</h2>
      <p class="hint">路線由原型決定：先鋒走強襲、狙擊走偵察、工兵走支援。◆ 是戰鬥中可以發動的主動技能。</p>
      <div class="list">${rows}</div>
    </section>`;
}

function logPanel(g) {
  const text = g.log.slice(-14).map((l) => `${l.important ? '*' : '-'} ${l.text}`).join('\n');
  return `<section><h2>戰鬥記錄</h2><pre class="log">${esc(text)}</pre></section>`;
}

// 給 main.js 用來畫 canvas 下方的 HUD
export function hudHtml(g) {
  // 開場與作者的話沒有「這一場」可言，那排戰局數據要收掉
  if (g.screen === 'title' || g.screen === 'credits') return '';
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
