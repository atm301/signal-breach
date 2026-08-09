// 把 codex 生的 OG 底圖裁成 1200x630 並疊上標題。
//
//   node tools/make-og.mjs
//
// 走「AI 底圖 + 程式疊字」的混合作法：底圖 prompt 明寫 no text，
// 文字一律用瀏覽器排版疊上去。gpt-image-1 對中文字只有 70-90% 正確率，
// 品牌名與標語不能賭那 10%。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'codex', 'images', 'comics', 'og', 'og-signal-breach.png');
const OUT = path.join(ROOT, 'assets', 'og.jpg');

const W = 1200;
const H = 630;

if (!fs.existsSync(SRC)) {
  console.error(`找不到底圖：${path.relative(ROOT, SRC)}`);
  console.error('先跑 node scripts/codex-generate.mjs panel og-signal-breach');
  process.exit(1);
}

const b64 = fs.readFileSync(SRC).toString('base64');

// 底圖是 3:2（1536x1024），OG 要 1.905:1，所以維持寬度、上下各裁掉一條。
// 用 object-fit: cover 讓瀏覽器處理，比自己算裁切座標不容易錯。
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { width:${W}px; height:${H}px; overflow:hidden; background:#0c151c;
         font-family:"Noto Sans TC","Microsoft JhengHei","PingFang TC",sans-serif; }
  .stage { position:relative; width:${W}px; height:${H}px; }
  .bg { position:absolute; inset:0; width:100%; height:100%; object-fit:cover; object-position:center 46%; }
  /* 右側加一道暗幕，確保文字在任何底圖上都讀得到 */
  .scrim { position:absolute; inset:0;
           background:linear-gradient(100deg, rgba(12,21,28,0) 34%, rgba(12,21,28,.72) 58%, rgba(12,21,28,.94) 78%); }
  .copy { position:absolute; right:56px; top:50%; transform:translateY(-50%);
          width:520px; text-align:right; color:#d5e4eb; }
  .kicker { font-size:15px; letter-spacing:5px; color:#71d993; margin-bottom:14px; font-weight:700; }
  .title { font-size:74px; line-height:.98; font-weight:800; letter-spacing:1px; color:#fff;
           text-shadow:0 4px 26px rgba(0,0,0,.75); }
  .zh { font-size:34px; letter-spacing:9px; color:#5db6ff; margin-top:12px; font-weight:700; }
  .rule { width:110px; height:2px; background:#5db6ff; margin:22px 0 22px auto; opacity:.85; }
  .tag { font-size:17px; line-height:1.8; color:#a8bfcc; }
  .foot { margin-top:26px; font-size:14px; color:#7d94a2; letter-spacing:1px; }
</style></head><body>
  <div class="stage">
    <img class="bg" src="data:image/png;base64,${b64}">
    <div class="scrim"></div>
    <div class="copy">
      <div class="kicker">TURN-BASED TACTICS</div>
      <div class="title">SIGNAL<br>BREACH</div>
      <div class="zh">訊號突破</div>
      <div class="rule"></div>
      <div class="tag">5x5 科幻回合制戰棋 Roguelike<br>隨機路線、程序生成敵人、跨局永久升級</div>
      <div class="foot">atmarketing.tw</div>
    </div>
  </div>
</body></html>`;

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
await page.setContent(html);
await page.waitForTimeout(500);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
await page.screenshot({ path: OUT, type: 'jpeg', quality: 88, clip: { x: 0, y: 0, width: W, height: H } });
await browser.close();

const kb = (fs.statSync(OUT).size / 1024).toFixed(0);
console.log(`OG 圖：${path.relative(ROOT, OUT)}  ${W}x${H}  ${kb} KB`);

// 開場畫面的背景，重用同一張底圖轉成正方形 WebP（canvas 是 1:1）。
// 不用另外叫 codex 生一張，省一次配額而且視覺一致。
{
  const TITLE_OUT = path.join(ROOT, 'assets', 'ui', 'title-bg.webp');
  const b2 = chromium ? null : null;
  void b2;
  const browser2 = await chromium.launch({ headless: true });
  const page2 = await browser2.newPage({ viewport: { width: 900, height: 900 } });
  await page2.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>
    *{margin:0;padding:0}
    body{width:900px;height:900px;overflow:hidden;background:#0c151c}
    img{width:100%;height:100%;object-fit:cover;object-position:center 42%}
  </style></head><body><img src="data:image/png;base64,${b64}"></body></html>`);
  await page2.waitForTimeout(400);
  const buf = await page2.screenshot({ type: 'png', clip: { x: 0, y: 0, width: 900, height: 900 } });
  const webp = await page2.evaluate(async (b64png) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64png}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = 900; c.height = 900;
    c.getContext('2d').drawImage(img, 0, 0);
    return c.toDataURL('image/webp', 0.86);
  }, buf.toString('base64'));
  await browser2.close();
  fs.mkdirSync(path.dirname(TITLE_OUT), { recursive: true });
  fs.writeFileSync(TITLE_OUT, Buffer.from(webp.split(',')[1], 'base64'));
  console.log(`開場背景：${path.relative(ROOT, TITLE_OUT)}  900x900  ${(fs.statSync(TITLE_OUT).size / 1024).toFixed(0)} KB`);
}
