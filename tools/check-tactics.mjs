// 戰術深度驗證：相剋、側背、傷害區間、傷害數字、戰鬥預測。
//
// 這些機制全都是「乘算修正」，錯了不會壞掉，只會安靜地算出別的數字，
// 單元測試又證明不了玩家看不看得到。所以這支同時驗兩件事：
//   1. 數學層 —— 背擊真的比正面高、剋真的比中性高、穩定性真的收窄區間
//   2. 呈現層 —— 預測卡真的畫出來、傷害數字真的浮出來、面板真的列出目標
// 呈現層用「同一幀有沒有 hover 的畫面差異」來判定，不是看有沒有丟例外。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { listen } from '../serve.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(ROOT, 'test-output', 'tactics');
fs.mkdirSync(outDir, { recursive: true });

const A = {};
const fail = [];
const check = (name, ok, detail) => {
  A[name] = !!ok;
  if (!ok) fail.push(detail ? `${name}: ${detail}` : name);
};

// ---------------------------------------------------------------- 數學層

const { TUNE, ELEMENTS } = await import('../src/data.js');
const engine = await import('../src/engine.js');
const { createGame, damageBreakdown, faceToward, flankOf } = engine;
const { elementMultiplier } = await import('../src/data.js');

const g = createGame({ seed: 'tactics-check' });

// 假單位：只要有 damageBreakdown 讀得到的欄位就夠，不必跑完整戰鬥
const mk = (o) => ({
  x: 0, y: 0, atk: 6, hp: 20, stab: 60, el: 'kinetic', pass: [],
  faceX: 0, faceY: 1, tm: 'p', rg: 1, ...o,
});

// 1) 屬性循環必須是嚴格的三系剪刀石頭布，不能有互剋或自剋
const keys = Object.keys(ELEMENTS);
check('elementCycleClosed', keys.every((k) => keys.includes(ELEMENTS[k].beats)) && keys.length === 3);
check('elementNoSelfBeat', keys.every((k) => ELEMENTS[k].beats !== k));
check('elementStrongWeakOrdered',
  elementMultiplier('kinetic', 'emp') > 1
  && elementMultiplier('emp', 'kinetic') < 1
  && elementMultiplier('kinetic', 'kinetic') === 1,
  `kinetic→emp=${elementMultiplier('kinetic', 'emp')}`);

// 2) 同一組攻防，換角度就要換傷害：正面 < 側面 < 背面
const target = mk({ x: 2, y: 2, tm: 'e', faceX: 0, faceY: -1 }); // 面朝上
const front = damageBreakdown(g, mk({ x: 2, y: 1 }), target);    // 站在上方 = 正面
const side = damageBreakdown(g, mk({ x: 1, y: 2 }), target);     // 站在左方 = 側面
const back = damageBreakdown(g, mk({ x: 2, y: 3 }), target);     // 站在下方 = 背後
check('flankFrontNoBonus', front.flank === 1 && front.flankLabel === null);
check('flankSideBonus', side.flankLabel === '側擊' && side.flank === TUNE.FLANK_SIDE);
check('flankBackBonus', back.flankLabel === '背擊' && back.flank === TUNE.FLANK_BACK);
check('flankDamageOrdered', back.mid > side.mid && side.mid > front.mid,
  `front=${front.mid} side=${side.mid} back=${back.mid}`);

// 3) 相剋要真的把傷害推上去（同位置、只換屬性）
const neutral = damageBreakdown(g, mk({ x: 2, y: 1, el: 'kinetic' }), mk({ x: 2, y: 2, tm: 'e', el: 'kinetic' }));
const strong = damageBreakdown(g, mk({ x: 2, y: 1, el: 'kinetic' }), mk({ x: 2, y: 2, tm: 'e', el: 'emp' }));
const weak = damageBreakdown(g, mk({ x: 2, y: 1, el: 'kinetic' }), mk({ x: 2, y: 2, tm: 'e', el: 'armor' }));
check('elementDamageOrdered', strong.mid > neutral.mid && neutral.mid > weak.mid,
  `strong=${strong.mid} neutral=${neutral.mid} weak=${weak.mid}`);

// 4) 穩定性越高，區間越窄；100 應該完全不浮動
const loStab = damageBreakdown(g, mk({ x: 2, y: 1, stab: 20 }), mk({ x: 2, y: 2, tm: 'e' }));
const hiStab = damageBreakdown(g, mk({ x: 2, y: 1, stab: 90 }), mk({ x: 2, y: 2, tm: 'e' }));
const maxStab = damageBreakdown(g, mk({ x: 2, y: 1, stab: 100 }), mk({ x: 2, y: 2, tm: 'e' }));
check('stabilityNarrowsSpread', (loStab.max - loStab.min) > (hiStab.max - hiStab.min),
  `stab20=${loStab.min}-${loStab.max} stab90=${hiStab.min}-${hiStab.max}`);
check('stability100IsFixed', maxStab.min === maxStab.max, `${maxStab.min}-${maxStab.max}`);
check('rangeWellFormed', [front, side, back, loStab, hiStab].every((b) => b.min >= 1 && b.min <= b.mid && b.mid <= b.max));

// 5) 擊殺判定：min >= hp 才叫必殺，max >= hp 只是可能
const frail = mk({ x: 2, y: 2, tm: 'e', hp: 2 });
const tanky = mk({ x: 2, y: 2, tm: 'e', hp: 99 });
check('guaranteedKillFlag', damageBreakdown(g, mk({ x: 2, y: 1 }), frail).guaranteedKill === true);
check('noKillFlagOnTank', damageBreakdown(g, mk({ x: 2, y: 1 }), tanky).possibleKill === false);

// 6) faceToward 是單位向量
const fu = mk({ x: 0, y: 0 });
faceToward(fu, 3, 4);
check('faceTowardNormalized', Math.abs(Math.hypot(fu.faceX, fu.faceY) - 1) < 1e-9
  && Math.abs(fu.faceX - 0.6) < 1e-9 && Math.abs(fu.faceY - 0.8) < 1e-9);
check('flankOfSelfSafe', flankOf(mk({ x: 1, y: 1 }), mk({ x: 1, y: 1 })).mult === 1);

// ---------------------------------------------------------------- 呈現層

const { server, port } = await listen(0);
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof window.test_run_full_flow === 'function', null, { timeout: 10000 });
await page.waitForFunction(() => window.__assets && window.__assets().ready, null, { timeout: 15000 }).catch(() => {});

// 開一場戰鬥。地圖是隨機分岔，往前走到第一個 battle 節點為止。
const setup = await page.evaluate(() => {
  window.game_actions.play();
  window.game_actions.startRun();
  const hops = [];
  for (let i = 0; i < 6; i++) {
    const gg = window.__game();
    if (gg.screen === 'battle') break;
    const cur = gg.map.nodes[gg.currentNodeId];
    const next = (cur?.next || []).map((id) => gg.map.nodes[id]).filter(Boolean);
    const pick = next.find((n) => n.type === 'battle') || next[0];
    if (!pick) break;
    hops.push(pick.type);
    window.game_actions.goNode(pick.id);
    // 補給/事件節點會擋在中間，關掉才能繼續走
    if (window.__game().pending.supply) window.game_actions.supplyClose();
    if (window.__game().pending.event) window.game_actions.eventClose();
  }
  return { screen: window.__game().screen, hops };
});
const inBattle = setup.screen === 'battle';

// 把選定單位貼到最近的敵人旁邊（直接改座標，只為了驗畫面，不影響存檔）
const placed = await page.evaluate(() => {
  const gg = window.__game();
  if (gg.screen !== 'battle') return null;
  const me = gg.battle.units.find((u) => u.alive && u.tm === 'p');
  const foe = gg.battle.units.find((u) => u.alive && u.tm === 'e');
  if (!me || !foe) return null;
  // 站到敵人背後：驗證預測卡會不會顯示背擊
  foe.faceX = 0; foe.faceY = -1;
  const spot = { x: foe.x, y: Math.min(4, foe.y + 1) };
  const occupied = gg.battle.units.some((u) => u.alive && u.x === spot.x && u.y === spot.y);
  if (occupied) { spot.x = Math.max(0, foe.x - 1); spot.y = foe.y; }
  me.x = spot.x; me.y = spot.y;
  me.faceX = foe.x - me.x; me.faceY = foe.y - me.y;
  me.ap = me.map; me.attacked = 0;
  gg.battle.selectedId = me.id;
  window.advanceTime(16);
  return { me: { x: me.x, y: me.y, n: me.n }, foe: { x: foe.x, y: foe.y, n: foe.n, hp: foe.hp } };
});
check('battleReached', !!placed, `setup=${JSON.stringify(setup)} inBattle=${inBattle}`);

if (placed) {
  // 面板要列出射程內目標，而且帶著傷害區間
  const listHtml = await page.evaluate(() => document.querySelector('.forecast')?.innerText || '');
  check('forecastListRendered', /\d/.test(listHtml) && listHtml.includes('射程內目標'), JSON.stringify(listHtml.slice(0, 160)));
  check('forecastListShowsBackstab', listHtml.includes('背擊') || listHtml.includes('側擊'), JSON.stringify(listHtml.slice(0, 160)));

  // 預測卡：比較「沒 hover」跟「hover 在敵人身上」兩張畫面，必須不一樣
  const canvas = await page.$('canvas');
  const box = await canvas.boundingBox();
  const beforeShot = path.join(outDir, 'no-hover.png');
  await canvas.screenshot({ path: beforeShot });

  const px = await page.evaluate(({ fx, fy }) => {
    // 跟 render.js 同一組常數：PAD 56、5x5
    const rect = document.querySelector('canvas').getBoundingClientRect();
    const PAD = 56; const GRID = 5;
    const cell = (rect.width - PAD * 2) / GRID;
    return { x: PAD + fx * cell + cell * 0.5, y: PAD + fy * cell + cell * 0.5 };
  }, { fx: placed.foe.x, fy: placed.foe.y });

  await page.mouse.move(box.x + px.x, box.y + px.y);
  await page.evaluate(() => window.advanceTime(16));
  const afterShot = path.join(outDir, 'hover-forecast.png');
  await canvas.screenshot({ path: afterShot });

  const a = fs.readFileSync(beforeShot);
  const b = fs.readFileSync(afterShot);
  check('forecastCardChangesCanvas', a.length !== b.length || !a.equals(b),
    `no-hover=${a.length}B hover=${b.length}B`);

  // 傷害數字：打一拳，fx 佇列裡要有 damage 事件、而且畫面要跟打之前不同
  const dmgFx = await page.evaluate(() => {
    const gg = window.__game();
    const me = gg.battle.units.find((u) => u.id === gg.battle.selectedId);
    const foe = gg.battle.units.find((u) => u.alive && u.tm === 'e');
    const before = foe.hp;
    window.__debug.tapBoard(foe.x, foe.y);
    const ev = gg.fxQueue.find((f) => f.type === 'damage');
    const snap = ev ? { value: ev.value, tags: ev.tags, crit: ev.crit } : null;
    window.advanceTime(120);
    return { snap, before, dealt: before - foe.hp, attacker: me.n };
  });
  check('damageFxEmitted', !!dmgFx.snap && dmgFx.snap.value > 0, JSON.stringify(dmgFx));
  // 溢傷是正常的：打 11 但只剩 8 HP，扣血封頂在 0、數字仍顯示 11。
  // 所以正確的關係是「扣血 = min(傷害, 原本 HP)」，不是相等。
  check('damageFxMatchesHpLoss',
    dmgFx.snap && dmgFx.dealt === Math.min(dmgFx.snap.value, dmgFx.before),
    `fx=${dmgFx.snap?.value} hpLoss=${dmgFx.dealt} beforeHp=${dmgFx.before}`);
  check('damageFxTagged', !!dmgFx.snap && Array.isArray(dmgFx.snap.tags), JSON.stringify(dmgFx.snap?.tags));
  await page.screenshot({ path: path.join(outDir, 'damage-number.png') });
}

check('noConsoleErrors', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();
server.close();

const pass = fail.length === 0;
console.log(JSON.stringify({ pass, assertions: A, failures: fail }, null, 2));
console.log(`\n截圖：${outDir}`);
process.exit(pass ? 0 : 1);
