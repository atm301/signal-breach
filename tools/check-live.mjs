// 對「已經上線的網址」跑一次真實瀏覽器驗證。
//
//   node tools/check-live.mjs https://atm301.github.io/signal-breach/
//
// 部署完只 curl 首頁回 200 是不夠的：ES module 的 MIME 錯、WebP 沒送對、
// 子路徑解析錯、素材 404，這些首頁都還是 200。要用瀏覽器實際跑一遍才算數。

import { chromium } from 'playwright';

const target = process.argv[2];
if (!target) {
  console.error('用法：node tools/check-live.mjs <網址>');
  process.exit(1);
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

const errors = [];
const bad = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
page.on('requestfailed', (r) => bad.push(`FAIL ${r.url()}`));
page.on('response', (r) => { if (r.status() >= 400) bad.push(`${r.status()} ${r.url()}`); });

await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 45000 });
await page.waitForFunction(() => typeof window.__assets === 'function', null, { timeout: 20000 }).catch(() => {});
await page.waitForFunction(() => window.__assets && window.__assets().ready, null, { timeout: 30000 }).catch(() => {});

const assets = await page.evaluate(() => (window.__assets ? window.__assets() : null));
const screen = await page.evaluate(() => (window.__game ? window.__game().screen : null));

// 真的玩一步：開 run、進第一個節點、確認戰鬥起得來
const played = await page.evaluate(() => {
  try {
    window.game_actions.play();
    window.game_actions.startRun();
    const g = window.__game();
    window.game_actions.goNode(g.map.nodes[g.currentNodeId].next[0]);
    return { screen: g.screen, units: g.battle ? g.battle.units.length : 0, floors: Object.keys(g.map.nodes).length };
  } catch (e) { return { error: String(e) }; }
});

// OG 圖與 meta 是分享預覽的命脈，要確認抓得到
const meta = await page.evaluate(() => ({
  title: document.title,
  canonical: document.querySelector('link[rel=canonical]')?.href ?? null,
  ogImage: document.querySelector('meta[property="og:image"]')?.content ?? null,
}));
// 用瀏覽器正常的圖片載入路徑驗，不要用 apiRequestContext。
// 後者走另一條網路堆疊，在某些環境會 ECONNRESET 而誤報成「OG 圖掛了」。
const ogOk = meta.ogImage ? await page.evaluate((url) => new Promise((resolve) => {
  const img = new Image();
  img.onload = () => resolve({ ok: img.naturalWidth > 0, w: img.naturalWidth, h: img.naturalHeight });
  img.onerror = () => resolve({ ok: false, w: 0, h: 0 });
  img.src = url;
}), meta.ogImage) : { ok: false, w: 0, h: 0 };

await browser.close();

// 本機環境連不出去的外部追蹤碼不算數
const external = (s) => /googletagmanager|facebook|google-analytics|doubleclick/.test(s);
const realBad = bad.filter((b) => !external(b));
const realErrors = errors.filter((e) => !external(e));

const checks = {
  頁面載入: screen !== null,
  開場為標題畫面: screen === 'title',
  單位素材33: assets?.units === 33,
  圖示素材8: assets?.icons === 8,
  UI素材2: assets?.ui === 2,
  道具素材6: assets?.props === 6,
  能開始出擊: played.screen === 'battle',
  關卡樹完整: played.floors >= 12,
  OG圖可存取: ogOk.ok === true,
  無失敗請求: realBad.length === 0,
  無console錯誤: realErrors.length === 0,
};

console.log(`\n網址        ${target}`);
console.log(`標題        ${meta.title}`);
console.log(`canonical   ${meta.canonical}`);
console.log(`OG 圖       ${meta.ogImage}  → ${ogOk.ok ? `載入成功 ${ogOk.w}x${ogOk.h}` : '載入失敗'}`);
console.log(`素材        units=${assets?.units} props=${assets?.props}`);
console.log(`實際遊玩    畫面=${played.screen} 場上單位=${played.units} 節點數=${played.floors}`);
if (realBad.length) console.log(`失敗請求    ${realBad.join('\n            ')}`);
if (realErrors.length) console.log(`console錯誤 ${realErrors.join('\n            ')}`);

console.log('');
for (const [k, v] of Object.entries(checks)) console.log(`  ${v ? '✅' : '❌'} ${k}`);
const ok = Object.values(checks).every(Boolean);
console.log(`\n${ok ? '✅ 線上版驗證通過' : '❌ 線上版有問題'}`);
process.exitCode = ok ? 0 : 1;
