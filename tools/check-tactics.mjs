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

// ---------------------------------------------------------------- 隨機幹員

const { TRAITS, PLAYER_TEMPLATES } = await import('../src/data.js');

// 7) 每名幹員固定一正一負，而且數值不能被抖到荒謬區間
const pools = Array.from({ length: 40 }, (_, i) => createGame({ seed: `roll-${i}` }));
const everyone = pools.flatMap((p) => p.recruits);
check('recruitPoolSize', pools.every((p) => p.recruits.length === TUNE.RECRUIT_POOL));
check('squadDefaultsFilled', pools.every((p) => p.squad.length === TUNE.SQUAD_SIZE));
check('squadIsSubsetOfRecruits',
  pools.every((p) => p.squad.every((u) => p.recruits.includes(u))),
  '小隊必須跟候補是同一批物件，否則選人與戰鬥會變成兩套數值');
check('everyoneHasOneGoodOneBad', everyone.every((u) => (
  u.tr.length === 2 && TRAITS[u.tr[0]]?.good === 1 && TRAITS[u.tr[1]]?.good === 0
)));
check('statsStayInSaneRange', everyone.every((u) => (
  u.mhp >= 6 && u.mhp <= 40 && u.atk >= 2 && u.atk <= 9
  && u.rg >= 1 && u.rg <= TUNE.RG_CAP && u.stab >= 5 && u.stab <= 98
  && u.map >= 2 && u.map <= TUNE.AP_CAP
)), JSON.stringify(everyone.map((u) => [u.mhp, u.atk, u.rg, u.stab, u.map])
  .filter(([hp, atk, rg, st, ap]) => hp < 6 || hp > 40 || atk < 2 || atk > 9
    || rg < 1 || st < 5 || ap < 2).slice(0, 3)));
check('recruitsAreActuallyRandom',
  new Set(everyone.map((u) => `${u.n}|${u.mhp}|${u.stab}|${u.tr.join()}`)).size > everyone.length * 0.6,
  '同樣的人重複太多次就不叫隨機');
check('poolCoversAllElements',
  pools.every((p) => new Set(p.recruits.map((u) => u.el)).size === PLAYER_TEMPLATES.length),
  '候補一定要涵蓋三系，否則相剋系統可能整場失效');
check('sameSeedSameRecruits',
  JSON.stringify(createGame({ seed: 'fixed' }).recruits.map((u) => [u.n, u.mhp, u.tr]))
  === JSON.stringify(createGame({ seed: 'fixed' }).recruits.map((u) => [u.n, u.mhp, u.tr])));

// 8) 行為詞條要真的改傷害，不能只是顯示用的字
const withTrait = (base, tr) => ({ ...base, tr });
const backAtk = { x: 2, y: 3, atk: 6, stab: 100, el: 'kinetic', pass: [], tm: 'p', rg: 1, tr: [] };
const backTgt = { x: 2, y: 2, atk: 6, hp: 20, mhp: 20, stab: 60, el: 'kinetic', pass: [], tm: 'e', faceX: 0, faceY: -1, tr: [] };
const plain = damageBreakdown(g, backAtk, backTgt);
check('traitFlankerRaisesFlank',
  damageBreakdown(g, withTrait(backAtk, ['flanker', 'worn']), backTgt).flank > plain.flank);
check('traitSkittishRaisesIncoming',
  damageBreakdown(g, backAtk, withTrait(backTgt, ['veteran', 'skittish'])).mid > plain.mid);
check('traitFinisherOnlyOnWounded', (() => {
  const fin = withTrait(backAtk, ['finisher', 'worn']);
  const full = damageBreakdown(g, fin, { ...backTgt, hp: 20, mhp: 20 });
  const hurt = damageBreakdown(g, fin, { ...backTgt, hp: 8, mhp: 20 });
  return hurt.mid > full.mid && full.mid === plain.mid;
})());
check('traitHesitantOnlyOnFullHp', (() => {
  const hes = withTrait(backAtk, ['veteran', 'hesitant']);
  const full = damageBreakdown(g, hes, { ...backTgt, hp: 20, mhp: 20 });
  const hurt = damageBreakdown(g, hes, { ...backTgt, hp: 8, mhp: 20 });
  return full.mid < plain.mid && hurt.mid === plain.mid;
})());
check('traitModsReported',
  damageBreakdown(g, withTrait(backAtk, ['flanker', 'worn']), backTgt).traitMods.length > 0);

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

// 開新出擊 → 應該先跳出編隊畫面，而且在確認之前不能走地圖
await page.evaluate(() => {
  window.game_actions.play();
  window.game_actions.startRun();
});
// 面板是在下一個 animation frame 才重繪的，這裡不等就會讀到上一幀的舊 HTML
await page.waitForFunction(() => document.getElementById('panel').innerText.includes('編隊出擊'),
  null, { timeout: 5000 }).catch(() => {});
// 截圖要在確認編隊之前拍，確認之後這個畫面就沒了
await page.screenshot({ path: path.join(outDir, 'recruit.png') });

const recruitUi = await page.evaluate(() => {
  const gg = window.__game();
  const panel = document.getElementById('panel').innerText;
  const first = gg.recruits[0].id;
  const wasPicked = gg.pending.recruit.picked.includes(first);
  window.game_actions.recruit(first); // 切換一次
  const toggled = gg.pending.recruit.picked.includes(first) !== wasPicked;
  // 人數不足時確認應該被擋下來
  const blocked = gg.pending.recruit.picked.length !== 3
    ? (window.game_actions.recruitGo(), !!window.__game().pending.recruit)
    : true;
  window.game_actions.recruit(first); // 還原
  const okBefore = !!gg.pending.recruit;
  window.game_actions.recruitGo();
  return {
    shown: panel.includes('編隊出擊'),
    listsAllRecruits: gg.recruits.every((u) => panel.includes(u.n)),
    showsTraits: panel.includes('＋') && panel.includes('－'),
    toggled,
    blocked,
    okBefore,
    cleared: !window.__game().pending.recruit,
    squadMatches: window.__game().squad.length === 3,
  };
});
check('recruitScreenShown', recruitUi.shown, JSON.stringify(recruitUi));
check('recruitListsPool', recruitUi.listsAllRecruits);
check('recruitShowsTraits', recruitUi.showsTraits);
check('recruitToggles', recruitUi.toggled);
check('recruitBlocksIncompleteSquad', recruitUi.blocked, '人數不足時不該讓玩家出擊');
check('recruitConfirmClears', recruitUi.cleared && recruitUi.squadMatches);

// 開一場戰鬥。地圖是隨機分岔，往前走到第一個 battle 節點為止。
const setup = await page.evaluate(() => {
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

  // 戰後修整：把敵人全部清掉逼出勝利畫面，然後真的買一次
  const repair = await page.evaluate(() => {
    const gg = window.__game();
    // 上一步打死人就會冒出升級抽卡，抽卡沒選完棋盤是鎖住的（tapBoard 會回「請先完成升級抽卡」）
    let guard = 0;
    while (gg.pending.draft && guard++ < 6) {
      window.game_actions.draft(gg.pending.draft.cards[0].id);
    }
    // 勝利判定藏在 attackUnit 裡，直接把敵人 alive 設 0 不會觸發結算。
    // 所以留最後一隻 1 HP 貼在我方旁邊，走正常的攻擊流程收掉。
    const foes = gg.battle.units.filter((u) => u.tm === 'e');
    const last = foes[0];
    for (const u of foes) if (u !== last) { u.hp = 0; u.alive = 0; }
    const me = gg.battle.units.find((u) => u.alive && u.tm === 'p');
    me.hp = Math.max(1, Math.floor(me.mhp * 0.4)); // 受傷才有東西可以修
    me.ap = me.map; me.attacked = 0;
    last.alive = 1; last.hp = 1;
    // 相鄰空格：不能站到隊友身上，否則那一下 tapBoard 會變成「改選隊友」而不是攻擊
    const taken = new Set(gg.battle.units.filter((u) => u.alive && u !== last).map((u) => `${u.x},${u.y}`));
    const spot = [[0, -1], [0, 1], [-1, 0], [1, 0]]
      .map(([dx, dy]) => ({ x: me.x + dx, y: me.y + dy }))
      .find((p) => p.x >= 0 && p.x < 5 && p.y >= 0 && p.y < 5 && !taken.has(`${p.x},${p.y}`));
    if (!spot) return { reached: false, screen: 'no-free-tile' };
    last.x = spot.x; last.y = spot.y;
    gg.battle.selectedId = me.id;
    const tap = window.__debug.tapBoard(last.x, last.y);
    if (gg.screen !== 'victory') {
      return { reached: false, screen: gg.screen, hp: last.hp, tap, me: [me.x, me.y, me.rg, me.ap], spot };
    }

    gg.credits = 500;
    const before = {
      credits: gg.credits,
      hp: gg.squad.map((u) => u.hp),
      atk: window.__game().squad.find((u) => u.id === gg.focusId)?.atk,
    };
    const r1 = window.game_actions.repair('patch');
    const healed = gg.squad.some((u, i) => u.hp > before.hp[i]);
    const spent = gg.credits < before.credits;
    // 全隊修復每場限一次，第二次必須被擋
    const opts = window.__engineRepairOptions ? null : null;
    window.game_actions.repair('patch');
    const secondBlocked = gg.credits === before.credits - 45;
    window.game_actions.repair('gun');
    const focus = gg.squad.find((u) => u.id === gg.focusId);
    return {
      reached: true, healed, spent, secondBlocked,
      atkRaised: focus.atk > before.atk,
      creditsLeft: gg.credits, r1, opts,
    };
  });
  check('victoryAfterClear', repair.reached, JSON.stringify(repair));
  check('repairHeals', repair.healed, JSON.stringify(repair));
  check('repairSpendsCredits', repair.spent, JSON.stringify(repair));
  check('repairPatchCappedPerBattle', repair.secondBlocked,
    `緊急修復每場只能買一次，否則消耗戰可以用錢買掉：${JSON.stringify(repair)}`);
  check('repairUpgradesAtk', repair.atkRaised, JSON.stringify(repair));

  // 買完之後勝利面板必須還看得見 ——
  // 面板是整塊重建的，只要有入場動畫，每買一次就會從透明重播一次。
  // 重建發生在下一個 animation frame，所以先等 DOM 真的出現再量。
  await page.waitForFunction(() => !!document.querySelector('.highlight.victory'),
    null, { timeout: 5000 }).catch(() => {});
  const victoryStillVisible = await page.evaluate(() => {
    const el = [...document.querySelectorAll('.highlight.victory')][0];
    if (!el) return { found: false };
    const s = getComputedStyle(el);
    const box = el.getBoundingClientRect();
    return { found: true, opacity: Number(s.opacity), h: box.height, anim: s.animationName };
  });
  check('victoryPanelStaysVisibleAfterPurchase',
    victoryStillVisible.found && victoryStillVisible.opacity === 1
    && victoryStillVisible.h > 40 && victoryStillVisible.anim === 'none',
    JSON.stringify(victoryStillVisible));
  await page.screenshot({ path: path.join(outDir, 'repair.png') });
}

check('noConsoleErrors', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();
server.close();

const pass = fail.length === 0;
console.log(JSON.stringify({ pass, assertions: A, failures: fail }, null, 2));
console.log(`\n截圖：${outDir}`);
process.exit(pass ? 0 : 1);
