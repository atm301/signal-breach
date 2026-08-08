// 把 codex 生的素材表切成一張一張帶 alpha 的 WebP。
//
//   node tools/slice-sheets.mjs
//   node tools/slice-sheets.mjs --size=384   輸出更大張
//
// 做法上有三個刻意的選擇：
//
// 1. 不用固定網格硬切。模型的格線對齊不會完美，硬切會截到手腳
//    （實測工兵那一列的邊界框寬度剛好等於格寬 = 已經貼邊）。
//    改成把內容投影到 x / y 軸找出真正的「背景分隔溝」，用溝的中線當切線；
//    投影法失敗時才退回標稱網格。
//
// 2. 整張表共用同一個裁切框尺寸，不是每格各自裁緊。
//    每格各自縮放會讓「受傷版剪影較小 → 被放大 → 單位被打之後反而變大」。
//    共用框同時保留模型畫出來的單位相對大小（重裝兵本來就該比無人機大）。
//
// 3. 背景用純洋紅 #FF00FF 去背，不賭模型輸出透明。
//    透過 codex CLI 沒辦法傳 background:transparent 參數，
//    gpt-image-1 的透明成功率約 90%，剩下 10% 會毀掉整張表。
//
// 去背同時做 despill（去洋紅溢色）：邊緣抗鋸齒像素會混到背景色，
// 不處理的話每個素材都會鑲一圈粉紅邊。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHEET_DIR = path.join(ROOT, 'codex', 'images');
const OUT_ROOT = path.join(ROOT, 'assets');

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  })
);
const OUT_SIZE = Number(args.size ?? 256);
const EXT = 'webp'; // 帶 alpha 的 WebP，同畫質約為 PNG 的三分之一大小

// 素材表清單直接讀 items.json，rows / cols / cells 是同一份真相來源
function loadSheets() {
  const items = JSON.parse(fs.readFileSync(path.join(ROOT, 'codex', 'data', 'items.json'), 'utf-8')).items;
  return items
    .filter((it) => it.image && fs.existsSync(path.join(SHEET_DIR, it.image)))
    .map((it) => ({
      id: it.id,
      file: path.join(SHEET_DIR, it.image),
      rows: it.rows,
      cols: it.cols,
      cells: it.cells,
      outDir: it.id === 'sheet-terrain' ? 'props' : 'units',
    }));
}

// ---------------------------------------------------------------- 瀏覽器端的切圖核心

// 這段字串會被丟進 page.evaluate 執行。用 playwright 是因為專案已經有這個依賴，
// 不需要為了讀寫 PNG 再裝 sharp（原生編譯）或 pngjs。
async function sliceInPage(page, dataUrl, rows, cols, outSize) {
  return page.evaluate(async ({ dataUrl, rows, cols, outSize }) => {
    const img = new Image();
    img.src = dataUrl;
    await img.decode();

    const W = img.naturalWidth;
    const H = img.naturalHeight;
    const src = document.createElement('canvas');
    src.width = W;
    src.height = H;
    const sctx = src.getContext('2d', { willReadFrequently: true });
    sctx.drawImage(img, 0, 0);
    const data = sctx.getImageData(0, 0, W, H).data;

    // 洋紅程度：純 #FF00FF 是 255，完全不含洋紅是 <= 0。
    // 青色(90,180,255) 與暖紅(255,134,120) 都算出負值，不會被誤判成背景。
    const magentaness = (r, g, b) => Math.min(r, b) - g;
    const DEADZONE = 30; // 低於這個值視為純素材，避免輕微偏色被打成半透明
    const SOLID_BG = 200; // 高於這個值一律當成背景

    // 模型畫出來的背景不是精確的 #FF00FF，會有輕微偏色（例如 #F707F5）。
    // 純線性換算會讓那些像素留下 alpha 15-20 的淡矩形，在深色底上看得出來，
    // 所以上端直接歸零，並把殘餘的微透明也清掉。
    const alphaOf = (m) => {
      if (m <= DEADZONE) return 255;
      if (m >= SOLID_BG) return 0;
      const a = Math.round((255 * (SOLID_BG - m)) / (SOLID_BG - DEADZONE));
      return a < 40 ? 0 : a;
    };

    // 先建內容遮罩，之後投影與邊界框都靠它
    const isContent = new Uint8Array(W * H);
    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
      isContent[p] = alphaOf(magentaness(data[i], data[i + 1], data[i + 2])) > 24 ? 1 : 0;
    }

    // 找切線：把內容投影到某一軸，然後在每條「預期分界線」附近搜尋投影最小的位置。
    //
    // 不用「找出剛好 n 段連續區塊」那種寫法，因為煙霧會跨列：
    // 下一列冒的煙飄進上一列的範圍，兩列就被連成一塊，判定直接失敗。
    // 在預期位置附近找最小值則永遠切得出 n-1 條線，而且會自動貼到最空的地方。
    const findCuts = (axis, n, len, other) => {
      const proj = new Int32Array(len);
      for (let a = 0; a < len; a++) {
        let sum = 0;
        for (let b = 0; b < other; b++) {
          sum += axis === 'x' ? isContent[b * W + a] : isContent[a * W + b];
        }
        proj[a] = sum;
      }

      const step = len / n;
      const cuts = [0];
      let worst = 0; // 最擠的那條切線上還有多少內容像素，用來判斷切得乾不乾淨
      for (let i = 1; i < n; i++) {
        const center = i * step;
        const half = Math.round(step * 0.35);
        const lo = Math.max(1, Math.round(center - half));
        const hi = Math.min(len - 1, Math.round(center + half));
        let bestPos = Math.round(center);
        let bestVal = Infinity;
        for (let a = lo; a <= hi; a++) {
          // 同分時偏好靠近預期位置，避免切線亂飄
          const val = proj[a] * 1000 + Math.abs(a - center);
          if (val < bestVal) { bestVal = val; bestPos = a; }
        }
        worst = Math.max(worst, proj[bestPos]);
        cuts.push(bestPos);
      }
      cuts.push(len);
      return { cuts, worst };
    };

    const xSplit = findCuts('x', cols, W, H);
    const ySplit = findCuts('y', rows, H, W);
    const xCuts = xSplit.cuts;
    const yCuts = ySplit.cuts;
    // worst = 切線上殘留的內容像素數。0 代表完全切在空隙上；大於幾十就代表真的切到東西了
    const method = `切線殘留 x=${xSplit.worst} y=${ySplit.worst}`;
    const dirty = Math.max(xSplit.worst, ySplit.worst) > 40;

    // 第一輪：只量每一格的邊界框，還不裁圖
    const boxes = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x0 = xCuts[c];
        const y0 = yCuts[r];
        const x1 = xCuts[c + 1];
        const y1 = yCuts[r + 1];
        let minX = x1;
        let minY = y1;
        let maxX = x0;
        let maxY = y0;
        let hits = 0;
        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) {
            if (!isContent[y * W + x]) continue;
            hits++;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
        boxes.push(hits < 200
          ? { row: r, col: c, empty: true, hits }
          : { row: r, col: c, empty: false, hits, minX, minY, w: maxX - minX + 1, h: maxY - minY + 1 });
      }
    }

    // 整張表共用一個框：取所有邊界框最長邊 + 邊距。
    // 這是「單位被打之後不能變大」與「單位之間相對大小要保留」的關鍵。
    const filled = boxes.filter((b) => !b.empty);
    const maxSide = filled.length ? Math.max(...filled.map((b) => Math.max(b.w, b.h))) : 1;
    const box = Math.round(maxSide * 1.12);

    const results = [];
    for (const b of boxes) {
      if (b.empty) { results.push({ ...b }); continue; }
      const { minX, minY, w: bw, h: bh } = b;

      // 用共用框把素材置中裁出來
      const tmp = document.createElement('canvas');
      tmp.width = box;
      tmp.height = box;
      const tctx = tmp.getContext('2d', { willReadFrequently: true });
      tctx.drawImage(src, minX, minY, bw, bh, (box - bw) / 2, (box - bh) / 2, bw, bh);

      // 去背 + despill
      const idata = tctx.getImageData(0, 0, box, box);
      const p = idata.data;
      for (let i = 0; i < p.length; i += 4) {
        const m = magentaness(p[i], p[i + 1], p[i + 2]);
        p[i + 3] = alphaOf(m);
        if (m > 0) {
          // 把溢到素材上的洋紅拉回綠色通道的水準，消掉粉紅鑲邊
          p[i] = Math.max(0, p[i] - m * 0.9);
          p[i + 2] = Math.max(0, p[i + 2] - m * 0.9);
        }
      }
      tctx.putImageData(idata, 0, 0);

      // 縮到輸出尺寸
      const out = document.createElement('canvas');
      out.width = outSize;
      out.height = outSize;
      const octx = out.getContext('2d');
      octx.imageSmoothingEnabled = true;
      octx.imageSmoothingQuality = 'high';
      octx.drawImage(tmp, 0, 0, outSize, outSize);

      results.push({
        row: b.row,
        col: b.col,
        empty: false,
        hits: b.hits,
        box: { x: minX, y: minY, w: bw, h: bh },
        share: box,
        // WebP 帶 alpha，同畫質下大約是 PNG 的三分之一大小。
        // 33 張素材差距是 2.3MB vs 0.8MB，對首次載入有感。
        dataUrl: out.toDataURL('image/webp', 0.92),
      });
    }
    return { W, H, method, dirty, box, results };
  }, { dataUrl, rows, cols, outSize });
}

// ---------------------------------------------------------------- 主流程

const sheets = loadSheets();
if (!sheets.length) {
  console.error('找不到任何已生成的素材表。先跑 node scripts/codex-generate.mjs item <id>');
  process.exit(1);
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.setContent('<!doctype html><body></body>');

let written = 0;
const problems = [];

for (const sheet of sheets) {
  const buf = fs.readFileSync(sheet.file);
  const dataUrl = `data:image/png;base64,${buf.toString('base64')}`;
  const { W, H, method, dirty, box, results } = await sliceInPage(page, dataUrl, sheet.rows, sheet.cols, OUT_SIZE);

  const outDir = path.join(OUT_ROOT, sheet.outDir);
  fs.mkdirSync(outDir, { recursive: true });

  console.log(`\n${sheet.id}  ${W}x${H}  →  ${sheet.rows}x${sheet.cols}  ${method}  共用框 ${box}px`);
  if (dirty) {
    problems.push(`${sheet.id} 切線上殘留內容（${method}），主體之間空隙不夠，素材可能被切邊`);
  }
  for (const cell of results) {
    const name = sheet.cells?.[cell.row]?.[cell.col];
    if (!name) continue;
    if (cell.empty) {
      console.log(`  ✗ ${name.padEnd(22)} 這格幾乎是空的（hits=${cell.hits}），素材表可能沒照版面生`);
      problems.push(`${sheet.id} / ${name} 空格`);
      continue;
    }
    const out = path.join(outDir, `${name}.${EXT}`);
    fs.writeFileSync(out, Buffer.from(cell.dataUrl.split(',')[1], 'base64'));
    written++;
    const fill = ((cell.hits / (cell.box.w * cell.box.h)) * 100).toFixed(0);
    console.log(`  ✓ ${name.padEnd(22)} bbox ${String(cell.box.w).padStart(4)}x${String(cell.box.h).padStart(4)}  填充 ${fill}%`);
  }
}

await browser.close();

// 產 manifest：載入器只會去要「manifest 上有的檔案」。
// 不這樣做的話，缺圖會在瀏覽器 console 噴 404，Playwright 測試的
// noConsoleErrors 斷言就會紅，等於用測試失敗來報告一件本來該優雅降級的事。
const manifest = { size: OUT_SIZE, ext: EXT, units: [], props: [] };
for (const dir of ['units', 'props']) {
  const full = path.join(OUT_ROOT, dir);
  if (!fs.existsSync(full)) continue;
  manifest[dir] = fs.readdirSync(full)
    .filter((f) => f.endsWith(`.${EXT}`))
    .map((f) => f.slice(0, -(EXT.length + 1)))
    .sort();
}
fs.writeFileSync(path.join(OUT_ROOT, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`\n共輸出 ${written} 張 ${OUT_SIZE}x${OUT_SIZE} ${EXT.toUpperCase()} 到 assets/`);
console.log(`manifest：units ${manifest.units.length} 張、props ${manifest.props.length} 張`);
if (problems.length) {
  console.log('\n⚠ 需要處理：');
  for (const p of problems) console.log(`   - ${p}`);
  process.exitCode = 1;
}
