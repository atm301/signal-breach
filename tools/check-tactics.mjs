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
const fingerprint = (gm) => JSON.stringify(gm.recruits.map((u) => [u.n, u.mhp, u.stab, u.tr, u.skin, u.look]));
check('sameSeedSameRecruits', fingerprint(createGame({ seed: 'fixed' })) === fingerprint(createGame({ seed: 'fixed' })),
  '外觀也要含在內：讀檔後長相變了就等於換了一個人');
check('skinsGetUsed',
  new Set(everyone.map((u) => u.skin)).size >= PLAYER_TEMPLATES.length * 2,
  `每個原型都該有兩套外觀在流通：${[...new Set(everyone.map((u) => u.skin))].join()}`);
check('looksAreDistinct',
  new Set(everyone.map((u) => u.look)).size > everyone.length * 0.9,
  '個人識別標記幾乎不該撞號');

// 純美術的隨機不能吃掉遊戲亂數流。
// 吃掉的話「多加一套外觀」就會讓所有平衡數字失真，而且完全看不出原因。
check('cosmeticRngIsSeparate', (() => {
  const a = createGame({ seed: 'rng-isolation' });
  const b = createGame({ seed: 'rng-isolation' });
  // 抽掉外觀欄位之後，玩法相關的數值必須逐一相同
  const strip = (gm) => JSON.stringify(gm.recruits.map((u) => [u.key, u.mhp, u.atk, u.rg, u.stab, u.map, u.tr]));
  return strip(a) === strip(b) && a.map.nodes[a.map.startId].next.length === b.map.nodes[b.map.startId].next.length;
})());

// 8) 行為詞條要真的改傷害，不能只是顯示用的字。
//    詞條最容易出的錯是「寫了但沒有接上」—— 遊戲不會壞，只是那條字是騙人的。
//    所以每一個行為型詞條都要有一條斷言，而且要驗方向而不只是「有差」。
const withTrait = (base, tr, trv) => ({ ...base, tr, trv: trv ?? null });
const backAtk = { x: 2, y: 3, atk: 6, mhp: 20, hp: 20, stab: 100, el: 'kinetic', pass: [], tm: 'p', rg: 1, tr: [] };
const backTgt = { x: 2, y: 2, atk: 6, hp: 20, mhp: 20, stab: 60, el: 'kinetic', pass: [], tm: 'e', faceX: 0, faceY: -1, tr: [] };
const plain = damageBreakdown(g, backAtk, backTgt);
const empTgt = { ...backTgt, el: 'emp' }; // 動能剋電磁

check('traitFlankerRaisesFlank',
  damageBreakdown(g, withTrait(backAtk, ['flanker']), backTgt).flank > plain.flank);
check('traitSkittishRaisesIncoming',
  damageBreakdown(g, backAtk, withTrait(backTgt, ['skittish'])).mid > plain.mid);
check('traitAlertLowersIncoming',
  damageBreakdown(g, backAtk, withTrait(backTgt, ['alert'])).mid < plain.mid);
check('traitAlertNeverBelowOne',
  damageBreakdown(g, backAtk, withTrait(backTgt, ['alert'])).flank >= 1,
  '警覺只能抵銷側背加成，不該把倍率壓到 1 以下變成減傷');
check('traitFinisherOnlyOnWounded', (() => {
  const fin = withTrait(backAtk, ['finisher']);
  const full = damageBreakdown(g, fin, { ...backTgt, hp: 20, mhp: 20 });
  const hurt = damageBreakdown(g, fin, { ...backTgt, hp: 8, mhp: 20 });
  return hurt.mid > full.mid && full.mid === plain.mid;
})());
check('traitHesitantOnlyOnFullHp', (() => {
  const hes = withTrait(backAtk, ['hesitant']);
  const full = damageBreakdown(g, hes, { ...backTgt, hp: 20, mhp: 20 });
  const hurt = damageBreakdown(g, hes, { ...backTgt, hp: 8, mhp: 20 });
  return full.mid < plain.mid && hurt.mid === plain.mid;
})());
check('traitHunterOnlyWhenCountering', (() => {
  const h = withTrait(backAtk, ['hunter']);
  const neutral = damageBreakdown(g, h, backTgt);
  const counter = damageBreakdown(g, h, empTgt);
  return neutral.mid === plain.mid && counter.mid > damageBreakdown(g, backAtk, empTgt).mid;
})());
check('traitBrittleOnlyWhenCountered', (() => {
  const neutral = damageBreakdown(g, backAtk, withTrait(backTgt, ['brittle']));
  const countered = damageBreakdown(g, backAtk, withTrait(empTgt, ['brittle']));
  return neutral.mid === plain.mid && countered.mid > damageBreakdown(g, backAtk, empTgt).mid;
})());
check('traitPanickyOnlyWhenHurt', (() => {
  const p = withTrait(backAtk, ['panicky']);
  const healthy = damageBreakdown(g, p, backTgt);
  const wounded = damageBreakdown(g, { ...p, hp: 5 }, backTgt);
  return healthy.mid === plain.mid && wounded.mid < plain.mid;
})());
check('traitPreciseRaisesFloorOnly', (() => {
  const shaky = { ...backAtk, stab: 40 };
  const base = damageBreakdown(g, shaky, backTgt);
  const p = damageBreakdown(g, withTrait(shaky, ['precise']), backTgt);
  return p.min > base.min && p.max === base.max && p.mid === base.mid;
})(), '精算只收下緣，期望值與上限都不該動');
check('traitUnreliableLowersCeilingOnly', (() => {
  const shaky = { ...backAtk, stab: 40 };
  const base = damageBreakdown(g, shaky, backTgt);
  const u = damageBreakdown(g, withTrait(shaky, ['unreliable']), backTgt);
  return u.max < base.max && u.min === base.min;
})());
check('traitModsReported',
  damageBreakdown(g, withTrait(backAtk, ['flanker']), backTgt).traitMods.length > 0);
check('traitModsCarryPolarity', (() => {
  const mods = damageBreakdown(g, withTrait(backAtk, ['flanker']), withTrait(backTgt, ['skittish'])).traitMods;
  return mods.some((m) => m.good === 1) && mods.some((m) => m.good === 0);
})(), '預測卡要分得出這一項是好事還壞事');

// 9) 詞條強度必須讀 trv（永久升級「詞條強化」放大過的值），不是寫死的基準值
check('traitReadsBoostedValue', (() => {
  const weak = damageBreakdown(g, withTrait(backAtk, ['flanker'], { flanker: 0.2 }), backTgt);
  const strong = damageBreakdown(g, withTrait(backAtk, ['flanker'], { flanker: 0.6 }), backTgt);
  return strong.mid > weak.mid;
})(), '放大過的詞條沒有生效 = 詞條強化這個升級是假的');

// ---------------------------------------------------------------- 永久升級

const metaWith = (ups) => ({ upgrades: ups });
const poolsWith = (ups, n = 30) => Array.from({ length: n }, (_, i) => (
  createGame({ seed: `meta-${JSON.stringify(ups)}-${i}`, meta: metaWith(ups) }).recruits
)).flat();

// 幹員篩選：名單裡要真的出現「完全沒有負面」的人，而且數量剛好等於等級
const cleanCount = (list) => list.filter((u) => u.tr.every((id) => TRAITS[id].good)).length;
const noScreen = Array.from({ length: 30 }, (_, i) => createGame({ seed: `scr-${i}` }).recruits);
const withScreen = Array.from({ length: 30 }, (_, i) => (
  createGame({ seed: `scr-${i}`, meta: metaWith({ screening: 1 }) }).recruits
));
check('screeningOffMeansEveryoneHasFlaw',
  noScreen.every((list) => cleanCount(list) === 0),
  '沒買篩選就不該有人沒有負面詞條');
check('screeningGivesExactlyOneClean',
  withScreen.every((list) => cleanCount(list) === 1),
  `每份名單應該剛好 1 名無負面：${withScreen.map(cleanCount).join()}`);

// 雙專長：多一個正面，而且不會抽到重複的
const dual = poolsWith({ dualperk: 1 });
check('dualperkAddsSecondGood',
  dual.every((u) => u.tr.filter((id) => TRAITS[id].good).length === 2));
check('dualperkNoDuplicate',
  dual.every((u) => new Set(u.tr).size === u.tr.length),
  '兩個一樣的詞條只是數字變大，看起來像 bug');

// 詞條強化：正面放大、負面不動
const aug = poolsWith({ augment: 2 });
check('augmentBoostsGoodTraits',
  aug.some((u) => u.tr.some((id) => TRAITS[id].good && u.trv[id] > TRAITS[id].v)),
  '正面詞條的 trv 應該比基準值大');
check('augmentLeavesBadTraitsAlone',
  aug.every((u) => u.tr.every((id) => TRAITS[id].good || u.trv[id] === TRAITS[id].v)),
  '負面詞條不該被強化放大');
check('augmentSecondPerkUnboosted', (() => {
  // 雙專長 + 強化同時開：第二個正面必須維持基準值，否則三個升級會相乘失控
  const both = poolsWith({ augment: 2, dualperk: 1 }, 30);
  return both.every((u) => {
    const goods = u.tr.filter((id) => TRAITS[id].good);
    return goods.length < 2 || u.trv[goods[1]] === TRAITS[goods[1]].v;
  });
})(), '第二專長吃到強化的話，雙專長 x 強化 x 篩選會相乘（實測 +25.6 個百分點）');
check('augmentIntTraitsStayIntegers',
  aug.every((u) => u.tr.every((id) => !TRAITS[id].int || Number.isInteger(u.trv[id]))),
  'HP / ATK / 射程 / AP 這類整數數值放大後必須進位');

// 每個詞條都要能被抽到，而且說明文字要用實際生效的數值
const wide = poolsWith({ dualperk: 1 }, 400);
const seenTraits = new Set(wide.flatMap((u) => u.tr));
check('everyTraitIsReachable',
  Object.keys(TRAITS).every((id) => seenTraits.has(id)),
  `抽不到的詞條：${Object.keys(TRAITS).filter((id) => !seenTraits.has(id)).join() || '無'}`);
check('everyTraitHasDescription',
  Object.values(TRAITS).every((t) => typeof t.d === 'function' && t.d(t.v).length > 0));

// 回合／擊殺／經驗這幾個 hook 不在 damageBreakdown 裡，
// 純數學驗不到，要真的跑一場戰鬥才知道有沒有接上。
const { startBattle, endPlayerTurn, runEnemyPhase, attackUnit } = engine;

function battleFixture(traits, seed = 'hook') {
  const gm = createGame({ seed });
  const node = Object.values(gm.map.nodes).find((n) => n.type === 'battle')
    || { id: 'x', type: 'battle', floor: 1 };
  startBattle(gm, node);
  for (const u of gm.squad) { u.tr = [...traits]; u.trv = {}; for (const id of traits) u.trv[id] = TRAITS[id].v; }
  return gm;
}

check('traitRegenHealsAtTurnStart', (() => {
  const gm = battleFixture(['regen']);
  const me = gm.squad[0];
  me.hp = Math.max(1, me.mhp - 5);
  const before = me.hp;
  endPlayerTurn(gm);
  runEnemyPhase(gm);
  return me.alive ? me.hp > before || me.hp === me.mhp : true;
})());
check('traitBleedingNeverKills', (() => {
  const gm = battleFixture(['bleeding']);
  for (const u of gm.squad) u.hp = 1;
  for (let i = 0; i < 4 && gm.battle && gm.battle.phase !== 'lose'; i++) {
    endPlayerTurn(gm);
    runEnemyPhase(gm);
  }
  // 只驗「不是被內傷扣死的」：敵人打死不算
  return gm.squad.every((u) => !u.alive || u.hp >= 1);
})(), '內傷把人扣到 0 是最沒回饋的死法，必須留 1 HP');
check('traitScavengerPaysOnKill', (() => {
  const gm = battleFixture(['scavenger']);
  const me = gm.battle.units.find((u) => u.tm === 'p' && u.alive);
  const foe = gm.battle.units.find((u) => u.tm === 'e' && u.alive);
  foe.x = me.x; foe.y = me.y + (me.y < 4 ? 1 : -1);
  foe.hp = 1;
  me.ap = me.map; me.attacked = 0; me.rg = Math.max(me.rg, 1);
  const before = gm.credits;
  attackUnit(gm, me, foe);
  return gm.credits === before + TRAITS.scavenger.v;
})());
check('traitExecutionerRefundsAp', (() => {
  const gm = battleFixture(['executioner']);
  const me = gm.battle.units.find((u) => u.tm === 'p' && u.alive);
  const foe = gm.battle.units.find((u) => u.tm === 'e' && u.alive);
  foe.x = me.x; foe.y = me.y + (me.y < 4 ? 1 : -1);
  foe.hp = 1;
  me.ap = me.map; me.attacked = 0;
  attackUnit(gm, me, foe);
  // 攻擊扣 1 AP，冷血補回 1 → 應該還是滿的
  return me.ap === me.map;
})());
check('traitExecutionerStillCapsAttacks', (() => {
  const gm = battleFixture(['executioner']);
  const me = gm.battle.units.find((u) => u.tm === 'p' && u.alive);
  const foes = gm.battle.units.filter((u) => u.tm === 'e' && u.alive);
  if (foes.length < 2) return true;
  foes[0].x = me.x; foes[0].y = me.y + (me.y < 4 ? 1 : -1); foes[0].hp = 1;
  me.ap = me.map; me.attacked = 0;
  attackUnit(gm, me, foes[0]);
  foes[1].x = me.x; foes[1].y = me.y + (me.y < 4 ? 1 : -1); foes[1].hp = 1;
  const second = attackUnit(gm, me, foes[1]);
  return second.ok === false;
})(), '冷血只能回 AP，不能解除「每回合限攻擊一次」—— 那條是戰鬥節奏的地基');
check('traitXpMultipliersApply', (() => {
  const mk = (tr) => {
    const gm = battleFixture(tr);
    const me = gm.battle.units.find((u) => u.tm === 'p' && u.alive);
    const foe = gm.battle.units.find((u) => u.tm === 'e' && u.alive);
    foe.x = me.x; foe.y = me.y + (me.y < 4 ? 1 : -1); foe.hp = 1;
    me.ap = me.map; me.attacked = 0;
    attackUnit(gm, me, foe);
    return me.lv * 1000 + me.xp;
  };
  return mk(['quicklearn']) > mk(['veteran']) && mk(['dull']) < mk(['veteran']);
})());

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

// 編隊還沒確認就按「放棄並返回基地」，大廳必須是可用的。
// 之前 pending.recruit 會留著把升級清單整個蓋掉，玩家買不了東西又看不出原因。
const hubUsable = await page.evaluate(async () => {
  window.game_actions.startRun();
  await new Promise((r) => requestAnimationFrame(r));
  const inRecruit = !!window.__game().pending.recruit;
  window.game_actions.toHub();
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const panel = document.getElementById('panel').innerText;
  return {
    inRecruit,
    screen: window.__game().screen,
    cleared: !window.__game().pending.recruit,
    showsUpgrades: panel.includes('裝甲儲備') || panel.includes('永久升級') || panel.includes('核心碎片'),
    stillShowsRecruit: panel.includes('編隊出擊'),
  };
});
check('abandonToHubClearsRecruit', hubUsable.cleared && !hubUsable.stillShowsRecruit,
  JSON.stringify(hubUsable));
check('hubShowsUpgradesAfterAbandon', hubUsable.showsUpgrades, JSON.stringify(hubUsable));

// 第二道防線：就算 pending.recruit 因為別的路徑殘留下來，
// 大廳畫面也不該被編隊面板接管。上面那條只驗得到 toHub 有沒有清乾淨。
const hubGuard = await page.evaluate(async () => {
  const gg = window.__game();
  gg.pending.recruit = { picked: gg.squad.map((u) => u.id) };
  gg.screen = 'hub';
  window.__debug.invalidateUi?.();
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const panel = document.getElementById('panel').innerText;
  gg.pending.recruit = null;
  return { showsRecruit: panel.includes('編隊出擊'), showsHub: panel.includes('核心碎片') };
});
check('hubNeverTakenOverByRecruitPanel', !hubGuard.showsRecruit && hubGuard.showsHub,
  `大廳被編隊面板蓋掉：${JSON.stringify(hubGuard)}`);

// 回到編隊狀態給後面的測試用
await page.evaluate(() => window.game_actions.startRun());
await page.waitForFunction(() => document.getElementById('panel').innerText.includes('編隊出擊'),
  null, { timeout: 5000 }).catch(() => {});
await page.evaluate(() => window.game_actions.recruitGo());

// 屬性上色只能動「青藍色發光」，不准碰重創狀態的橘色火花。
// 第一版用 ctx.filter hue-rotate 整張轉，橘色火花變成洋紅 ——
// 那是「這隻快死了」的通用訊號，被染色等於把回饋弄壞。
const tintSafety = await page.evaluate(async () => {
  const assets = await import('./src/assets.js');
  const count = (img) => {
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const cx = c.getContext('2d', { willReadFrequently: true });
    cx.drawImage(img, 0, 0);
    const p = cx.getImageData(0, 0, c.width, c.height).data;
    let orange = 0; let magenta = 0; let tinted = 0;
    for (let i = 0; i < p.length; i += 4) {
      if (p[i + 3] < 8) continue;
      const r = p[i]; const g = p[i + 1]; const b = p[i + 2];
      if (r > 150 && g > 70 && g < r - 30 && b < g) orange++;
      if (r > 130 && b > 130 && g < r - 50 && g < b - 50) magenta++;
      if (r > 150 && g > 120 && b < 110) tinted++;
    }
    return { orange, magenta, tinted };
  };
  const mk = (el) => ({ key: 'vanguard', skin: 'vanguardB', tm: 'p', el, hp: 2, mhp: 20 });
  const plain = assets.unitSprite(mk('emp')); // emp 不上色 = 原圖
  const amber = assets.unitSprite(mk('kinetic'));
  // 綠色屬性拿來驗火花：青綠 [110,230,150] 不會被算成橘色，是乾淨的探針。
  // 用琥珀驗會誤判，因為琥珀本身就落在「橘色」的判定範圍裡。
  const green = assets.unitSprite(mk('armor'));
  return { plain: count(plain), amber: count(amber), green: count(green) };
});
check('tintKeepsDamageSparksOrange',
  tintSafety.green.orange >= tintSafety.plain.orange * 0.92,
  `橘色火花像素 原圖 ${tintSafety.plain.orange} → 青綠上色後 ${tintSafety.green.orange}（變少代表火花被染掉了）`);
check('tintDoesNotProduceMagenta',
  tintSafety.amber.magenta <= tintSafety.plain.magenta + 60
  && tintSafety.green.magenta <= tintSafety.plain.magenta + 60,
  `洋紅像素 原圖 ${tintSafety.plain.magenta} → 琥珀 ${tintSafety.amber.magenta} / 青綠 ${tintSafety.green.magenta}`);
check('tintActuallyChangesAccent',
  tintSafety.amber.tinted > tintSafety.plain.tinted,
  `琥珀像素 原圖 ${tintSafety.plain.tinted} → 上色後 ${tintSafety.amber.tinted}（沒變多代表上色根本沒生效）`);

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
  // 面板要列出射程內目標，而且帶著傷害區間。
  // advanceTime 只跑 update + draw（canvas），面板是 ui.render 在真正的 rAF 裡重建的，
  // 所以要等 DOM 出現再讀，否則會偶發讀到上一幀。
  await page.waitForFunction(() => !!document.querySelector('.forecast'), null, { timeout: 5000 }).catch(() => {});
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

// ---------------------------------------------------------------- 敵方回合看不看得懂
//
// 「敵人是不是不會攻擊？」—— 使用者問過這句。答案是會，但整個敵方回合只有 390ms，
// 三隻敵人移動加開火全擠完，畫面上又沒有任何東西標示是誰在動，
// 所以玩家的感受就是「什麼都沒發生，血怎麼少了」。
// 這一段驗的不是「引擎有沒有呼叫 attackUnit」，是「玩家有沒有機會看到」。
// 這段自己開一場乾淨的戰鬥，不沿用前面被測試改壞的狀態。
// 沿用的話有時候敵人早就被打光，敵方回合 110ms 就結束，斷言變成偶發紅字，
// 而那個紅字講的還是假原因（「不可讀」，其實是「沒有敵人」）。
const aiPhase = await page.evaluate(async () => {
  window.game_actions.toHub();
  window.game_actions.startRun();
  window.game_actions.recruitGo();
  for (let i = 0; i < 6; i++) {
    const gm = window.__game();
    if (gm.screen === 'battle') break;
    const cur = gm.map.nodes[gm.currentNodeId];
    const next = (cur?.next || []).map((id) => gm.map.nodes[id]).filter(Boolean);
    const pick = next.find((n) => n.type === 'battle') || next[0];
    if (!pick) break;
    window.game_actions.goNode(pick.id);
    if (window.__game().pending.supply) window.game_actions.supplyClose();
    if (window.__game().pending.event) window.game_actions.eventClose();
  }
  const gg = window.__game();
  if (gg.screen !== 'battle') return { skipped: true, screen: gg.screen };

  // 把敵人拉到貼身，保證這一回合一定有人開火
  const mine = gg.battle.units.filter((u) => u.alive && u.tm === 'p');
  const foes = gg.battle.units.filter((u) => u.alive && u.tm === 'e');
  if (!foes.length) return { skipped: true, reason: 'no-foes' };
  foes.forEach((f, i) => {
    const t = mine[i % mine.length];
    f.x = Math.max(0, Math.min(4, t.x + (i % 2 ? -1 : 1)));
    f.y = t.y;
  });

  const hpBefore = mine.reduce((s, u) => s + u.hp, 0);
  const logBefore = gg.log.length;
  let sawActingMark = false;
  const t0 = performance.now();
  window.game_actions.endturn();
  // 每一幀檢查有沒有標示出「正在行動的敵人」
  while (window.__game().battle?.phase === 'ai' && performance.now() - t0 < 15000) {
    if (window.__game().battle.actingId) sawActingMark = true;
    await new Promise((r) => requestAnimationFrame(r));
  }
  const ms = performance.now() - t0;
  const gg2 = window.__game();
  const dealt = hpBefore - gg2.battle.units.filter((u) => u.tm === 'p').reduce((s, u) => s + u.hp, 0);
  // 只數這一次敵方階段新增的攻擊，而且要是「敵人打我方」——
  // 數整份 log 的話會把玩家自己的攻擊算進去，變成永遠是綠的
  const foeNames = new Set(foes.map((f) => f.n));
  const attacks = gg2.log.slice(logBefore)
    .filter((l) => /攻擊.*造成/.test(l.text) && [...foeNames].some((n) => l.text.startsWith(n))).length;
  return {
    ms, dealt, attacks, sawActingMark, foes: foes.length,
    clearedAfter: !gg2.battle.actingId,
  };
});
// ⚠️ 先驗「這段真的跑到了」。
// 第一版把這整段放在修整測試之後，那時戰鬥早就結束、screen 是 victory，
// 於是每一條都靠 aiPhase.skipped 短路成綠燈 —— 我把實作拔掉它照樣全過。
// 空過的斷言比沒有斷言更危險，它會讓人相信一個沒被驗過的東西。
check('enemyPhaseProbeRan', !aiPhase.skipped,
  `這段必須在戰鬥中執行，否則所有敵方回合的斷言都是空的：${JSON.stringify(aiPhase)}`);
check('enemiesActuallyAttack', aiPhase.attacks > 0,
  `敵方回合沒有任何攻擊：${JSON.stringify(aiPhase)}`);
check('enemyAttacksDealDamage', aiPhase.dealt > 0, JSON.stringify(aiPhase));
check('enemyTurnIsReadable', aiPhase.ms >= 300,
  `敵方回合只有 ${Math.round(aiPhase.ms)}ms，玩家看不到發生什麼事`);
check('actingEnemyIsMarked', aiPhase.sawActingMark,
  '敵方階段沒有標示是哪一隻在行動，整個回合是匿名的');
check('actingMarkClearedAfterPhase', aiPhase.clearedAfter,
  '敵方階段結束後標記沒清掉，會留在畫面上');

// ---------------------------------------------------------------- 改裝對象
//
// 「升級改裝顯示的對象是不是都同一個？」—— 使用者問過。
// 顯示本身是對的，但精英獎勵與補給原本都直接發給 focusUnit，
// 而 focusUnit 預設是 squad[0]、玩家不去點小隊面板就永遠不會變 ——
// 整場出擊的獎勵全部靜靜地餵給同一個先鋒。
const draftTargeting = await page.evaluate(async () => {
  const eng = await import('./src/engine.js');
  const gm = window.__game();
  if (!gm.squad.length) return { skipped: true };

  // 1) 升級抽卡：誰升級就顯示誰
  const headers = [];
  for (const u of gm.squad) {
    gm.pending.draft = null; gm.pending.draftQueue = [];
    eng.queueDraft(gm, u.id, 'levelup');
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const h = [...document.querySelectorAll('#panel h2')].map((e) => e.textContent.trim())
      .find((t) => t.includes('改裝')) || '';
    headers.push({ want: u.n, header: h, ok: h.includes(u.n) });
  }

  // 2) 選擇型抽卡（精英/補給）：要能換人，而且換人不重抽
  gm.pending.draft = null; gm.pending.draftQueue = [];
  eng.queueChoiceDraft(gm, 'elite');
  const d = gm.pending.draft;
  const first = d?.unitId;
  const firstCards = d?.cards.map((c) => c.id).join();
  const other = d?.options?.find((o) => o.unitId !== first)?.unitId;
  eng.setDraftTarget(gm, other);
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const switchedHeader = [...document.querySelectorAll('#panel h2')].map((e) => e.textContent.trim())
    .find((t) => t.includes('改裝')) || '';
  const otherCards = gm.pending.draft.cards.map((c) => c.id).join();
  // 每個人要有自己獨立抽的一套。
  // 不能斷言「兩套一定不同」—— 牌庫只有幾張，兩個人抽到同樣三張是合法的，
  // 那樣寫會偶發紅字。要驗的是「切過去用的就是那個人預抽的那一套」。
  const usesOwnSet = gm.pending.draft.cards
    === d.options.find((o) => o.unitId === other)?.cards;
  // 換回來，卡片必須跟第一次一模一樣（不能重抽）
  eng.setDraftTarget(gm, first);
  const backCards = gm.pending.draft.cards.map((c) => c.id).join();
  const otherName = gm.squad.find((u) => u.id === other)?.n;

  // 3) 預設對象不能永遠是 squad[0]
  const defaults = [];
  for (let i = 0; i < 8; i++) {
    const test = eng.createGame({ seed: `draft-default-${i}` });
    test.squad[i % test.squad.length].lv = 5; // 讓最低等級的人不固定
    test.squad[(i + 1) % test.squad.length].lv = 3;
    const id = eng.queueChoiceDraft(test, 'elite');
    defaults.push(test.squad.findIndex((u) => u.id === id));
  }
  // 4) 每一種來源的標題都不能出現「改裝改裝」。
  //    supply 的標籤原本寫成「補給改裝」，接上模板後面的「改裝」就重複了。
  //    只驗 elite 的話抓不到，因為出問題的是另一個 source。
  const labels = {};
  for (const src of ['levelup', 'elite', 'supply']) {
    gm.pending.draft = null; gm.pending.draftQueue = [];
    if (src === 'levelup') eng.queueDraft(gm, gm.squad[0].id, 'levelup');
    else eng.queueChoiceDraft(gm, src);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    labels[src] = [...document.querySelectorAll('#panel h2')].map((e) => e.textContent.trim())
      .find((t) => t.includes('改裝')) || '';
  }

  gm.pending.draft = null; gm.pending.draftQueue = [];
  return {
    headers,
    labels,
    hasOptions: !!d?.options && d.options.length > 1,
    switchedName: otherName,
    switchedHeaderOk: !!otherName && switchedHeader.includes(otherName),
    cardsChangedOnSwitch: usesOwnSet,
    noRerollOnSwitchBack: firstCards === backCards,
    defaultSlots: defaults,
    label: switchedHeader,
  };
});

check('draftShowsCorrectUnit', draftTargeting.headers.every((h) => h.ok),
  `升級抽卡顯示錯人：${JSON.stringify(draftTargeting.headers)}`);
check('choiceDraftHasOptions', draftTargeting.hasOptions,
  '精英獎勵應該可以選對象');
check('choiceDraftSwitchesUnit', draftTargeting.switchedHeaderOk,
  `換對象之後標題沒跟著改：${JSON.stringify(draftTargeting)}`);
check('choiceDraftUsesOwnCardSet', draftTargeting.cardsChangedOnSwitch,
  '切換對象後用的不是那個人預抽的牌組');
check('choiceDraftNoReroll', draftTargeting.noRerollOnSwitchBack,
  '切回來卡片變了 = 玩家可以左右來回切到抽出想要的卡為止');
check('choiceDraftDefaultVaries', new Set(draftTargeting.defaultSlots).size > 1,
  `預設對象永遠落在同一個位置：${JSON.stringify(draftTargeting.defaultSlots)}`);
check('draftLabelNotDoubled',
  Object.values(draftTargeting.labels).every((t) => t && !/改裝改裝/.test(t)),
  `標題重複了：${JSON.stringify(draftTargeting.labels)}`);

check('noConsoleErrors', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();
server.close();

const pass = fail.length === 0;
console.log(JSON.stringify({ pass, assertions: A, failures: fail }, null, 2));
console.log(`\n截圖：${outDir}`);
process.exit(pass ? 0 : 1);
