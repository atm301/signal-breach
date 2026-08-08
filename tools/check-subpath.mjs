// 模擬 GitHub Pages 的子路徑情境：atm301.github.io/signal-breach/
// 這是靜態站上 Pages 最常見的死法 —— 本機根目錄跑得好好的，一放子路徑就整個白畫面。

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const ROOT = 'C:/myclaude/sci-fi-tactics-prototype';
const PREFIX = '/signal-breach';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  let rel = decodeURIComponent(url.pathname);
  if (!rel.startsWith(PREFIX)) { res.writeHead(404).end('outside prefix'); return; }
  rel = rel.slice(PREFIX.length) || '/';
  if (rel === '/' || rel.endsWith('/')) rel += 'index.html';
  const file = path.join(ROOT, rel);
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
});

const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
const failed = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
page.on('requestfailed', (r) => failed.push(`${r.url()} ${r.failure()?.errorText}`));
page.on('response', (r) => { if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`); });

const target = `http://127.0.0.1:${port}${PREFIX}/`;
await page.goto(target, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof window.__assets === 'function', null, { timeout: 10000 }).catch(() => {});
await page.waitForFunction(() => window.__assets && window.__assets().ready, null, { timeout: 15000 }).catch(() => {});

const assets = await page.evaluate(() => (window.__assets ? window.__assets() : null));
const screen = await page.evaluate(() => (window.__game ? window.__game().screen : null));

// 真的玩一步：開一場 run 並進第一個節點，確認不是只有首頁載得起來
const played = await page.evaluate(() => {
  try {
    window.game_actions.startRun();
    const g = window.__game();
    window.game_actions.goNode(g.map.nodes[g.currentNodeId].next[0]);
    return { screen: g.screen, units: g.battle ? g.battle.units.length : 0 };
  } catch (e) { return { error: String(e) }; }
});

await page.screenshot({ path: 'C:/myclaude/sci-fi-tactics-prototype/test-output/shots/subpath-check.png' });
await browser.close();
server.close();

// 忽略外部追蹤碼（本機環境本來就連不出去）
const external = (u) => /googletagmanager|facebook|google-analytics/.test(u);
const realFails = failed.filter((f) => !external(f));
const realErrors = errors.filter((e) => !external(e));

const ok = assets && assets.units === 33 && assets.props === 6 && screen === 'hub'
  && played.screen === 'battle' && realFails.length === 0 && realErrors.length === 0;

console.log(`網址        ${target}`);
console.log(`開場畫面    ${screen}`);
console.log(`素材        units=${assets?.units} props=${assets?.props}`);
console.log(`實際遊玩    進入戰鬥=${played.screen === 'battle'} 場上單位=${played.units}`);
console.log(`失敗請求    ${realFails.length ? realFails.join('\n            ') : '無'}`);
console.log(`console錯誤 ${realErrors.length ? realErrors.join('\n            ') : '無'}`);
console.log(`\n子路徑相容：${ok ? '✅ 通過' : '❌ 有問題'}`);
process.exitCode = ok ? 0 : 1;
