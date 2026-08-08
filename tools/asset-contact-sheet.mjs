// 把 assets/ 裡切好的素材排成一張接觸表，畫在遊戲的深色底上。
//
//   node tools/asset-contact-sheet.mjs
//
// 為什麼要這支：切圖器只能報「有沒有切到東西」，報不了「切得好不好看」。
// 貼邊被裁掉、粉紅鑲邊沒去乾淨、同一列尺寸不一致，這些都只有人眼看得出來。
// 深色底是關鍵 —— 白底看不出殘留的粉紅邊。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'test-output', 'shots', 'asset-contact-sheet.png');

const groups = [];
for (const dir of ['units', 'props']) {
  const full = path.join(ROOT, 'assets', dir);
  if (!fs.existsSync(full)) continue;
  const files = fs.readdirSync(full).filter((f) => f.endsWith('.webp')).sort();
  if (files.length) groups.push({ dir, files });
}

if (!groups.length) {
  console.error('assets/ 裡沒有東西。先跑 node tools/slice-sheets.mjs');
  process.exit(1);
}

const rows = [];
for (const g of groups) {
  // 同一個單位的三個狀態排成一列：<key>-intact / -damaged / -critical
  const byKey = new Map();
  for (const f of g.files) {
    const name = f.replace(/\.webp$/, '');
    const m = name.match(/^(.*)-(intact|damaged|critical|destroyed)$/);
    const key = m ? m[1] : name;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(name);
  }
  const order = ['intact', 'damaged', 'critical', 'destroyed'];
  for (const [key, names] of byKey) {
    names.sort((a, b) => {
      const ai = order.findIndex((s) => a.endsWith(s));
      const bi = order.findIndex((s) => b.endsWith(s));
      return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
    });
    rows.push({ dir: g.dir, key, names });
  }
}

const CELL = 150;
const LABEL_W = 150;
const width = LABEL_W + CELL * 4 + 40;
const height = 40 + rows.length * (CELL + 16);

const cells = rows.map((r) => ({
  key: r.key,
  items: r.names.map((n) => ({
    name: n,
    src: `data:image/webp;base64,${fs.readFileSync(path.join(ROOT, 'assets', r.dir, `${n}.webp`)).toString('base64')}`,
    state: n.replace(`${r.key}-`, ''),
  })),
}));

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  body { margin:0; background:#0c151c; font:13px "Noto Sans TC","Microsoft JhengHei",sans-serif; color:#d5e4eb; }
  table { border-collapse:collapse; margin:16px; }
  td { padding:6px; }
  .k { width:${LABEL_W}px; color:#71d993; font-weight:700; vertical-align:middle; }
  .cellwrap { width:${CELL}px; height:${CELL}px; position:relative;
              background:radial-gradient(circle at 50% 45%, #1b2c37 0%, #0f1a22 70%);
              border:1px solid #2f4958; border-radius:8px; }
  .cellwrap img { width:100%; height:100%; object-fit:contain; display:block; }
  .st { position:absolute; left:4px; bottom:2px; font-size:10px; color:#89a0ae; }
</style></head><body><table>
${cells.map((r) => `<tr><td class="k">${r.key}</td>${r.items.map((it) => `
  <td><div class="cellwrap"><img src="${it.src}"><span class="st">${it.state}</span></div></td>`).join('')}</tr>`).join('')}
</table></body></html>`;

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width, height } });
await page.setContent(html);
await page.waitForTimeout(400);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
await page.screenshot({ path: OUT, fullPage: true });
await browser.close();

console.log(`接觸表：${path.relative(ROOT, OUT)}（${rows.length} 列）`);
