// 把「隨機幹員長什麼樣」一次全部畫出來，用眼睛看變化夠不夠。
//
//   node tools/look-sheet.mjs
//
// 素材變體 x 屬性配色 x 識別標記三個軸疊起來到底有沒有效果，
// 只有並排看才判斷得出來 —— 一次看一隻永遠覺得「好像有差」。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { listen } from '../serve.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(ROOT, 'test-output', 'looks');
fs.mkdirSync(outDir, { recursive: true });

const { server, port } = await listen(0);
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1180, height: 900 } });
await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__assets && window.__assets().ready, null, { timeout: 15000 });

const png = await page.evaluate(async () => {
  const assets = await import('./src/assets.js');
  const render = await import('./src/render.js');
  const { ELEMENTS } = await import('./src/data.js');

  const SKINS = [
    ['vanguard', '先鋒 A'], ['vanguardB', '先鋒 B'],
    ['sniper', '狙擊 A'], ['sniperB', '狙擊 B'],
    ['engineer', '工兵 A'], ['engineerB', '工兵 B'],
  ];
  const ELS = Object.keys(ELEMENTS);
  const DMG = [
    ['intact', 1.0], ['damaged', 0.5], ['critical', 0.2],
  ];

  const cell = 108;
  const cols = ELS.length * DMG.length;
  const rows = SKINS.length;
  const padL = 96; const padT = 56;
  const c = document.createElement('canvas');
  c.width = padL + cols * cell + 16;
  c.height = padT + rows * cell + 16;
  const cx = c.getContext('2d');
  cx.fillStyle = '#0e1a22';
  cx.fillRect(0, 0, c.width, c.height);
  cx.font = '13px sans-serif';
  cx.textBaseline = 'middle';

  // 欄標題：屬性 x 損傷
  ELS.forEach((el, ei) => {
    cx.fillStyle = ELEMENTS[el].color;
    cx.textAlign = 'center';
    cx.fillText(ELEMENTS[el].n, padL + (ei * DMG.length + DMG.length / 2) * cell, 18);
    DMG.forEach(([d], di) => {
      cx.fillStyle = '#8fa3b0';
      cx.font = '11px sans-serif';
      cx.fillText(d, padL + (ei * DMG.length + di + 0.5) * cell, 38);
      cx.font = '13px sans-serif';
    });
  });

  for (let r = 0; r < rows; r++) {
    const [skin, label] = SKINS[r];
    cx.fillStyle = '#dfe9f0';
    cx.textAlign = 'right';
    cx.fillText(label, padL - 12, padT + (r + 0.5) * cell);

    for (let ei = 0; ei < ELS.length; ei++) {
      for (let di = 0; di < DMG.length; di++) {
        const [, ratio] = DMG[di];
        const unit = {
          key: skin.replace(/B$/, ''),
          skin,
          tm: 'p',
          el: ELS[ei],
          hp: Math.round(20 * ratio),
          mhp: 20,
          // 每一格給不同的識別標記，順便看標記本身的變化
          look: r * 7 + ei * 3 + di,
          x: 0,
          y: 0,
          faceX: 0,
          faceY: 1,
          boss: 0,
          map: 3,
          ap: 3,
        };
        const img = assets.unitSprite(unit);
        const ox = padL + (ei * DMG.length + di) * cell;
        const oy = padT + r * cell;
        const s = cell * 0.86;
        // 陣營環 + 識別標記，跟棋盤上一樣
        const ccx = ox + cell / 2; const ccy = oy + cell / 2;
        const outerR = s * 0.44;
        cx.beginPath();
        cx.arc(ccx, ccy, outerR, 0, Math.PI * 2);
        cx.fillStyle = 'rgba(9,17,23,.6)';
        cx.fill();
        cx.strokeStyle = '#5db6ff';
        cx.lineWidth = 3;
        cx.stroke();
        if (img) cx.drawImage(img, ccx - s / 2, ccy - s / 2, s, s);
        render.drawIdentityMarkForTest(cx, unit, ccx, ccy, outerR, '#5db6ff');
      }
    }
  }
  return c.toDataURL('image/png').split(',')[1];
});

fs.writeFileSync(path.join(outDir, 'looks.png'), Buffer.from(png, 'base64'));
await browser.close();
server.close();
console.log(`已輸出 ${path.join(outDir, 'looks.png')}`);
