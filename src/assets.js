// 素材載入層。所有 AI 生成的圖都從這裡進來。
//
// 設計上有兩個要求：
//
// 1. 缺圖必須優雅降級。素材是後來才加的，render.js 原本的程式繪製要留著當備援，
//    這樣沒有 assets/ 目錄時遊戲照樣能跑、測試也不會紅。
//
// 2. 只請求 manifest 上有的檔案。瀏覽器抓不到圖會在 console 噴 404 error，
//    而 Playwright 測試有一條 noConsoleErrors 斷言 —— 缺圖不該用測試失敗來報告。

const BASE = 'assets';

const state = {
  ready: false,
  manifest: null,
  units: new Map(),
  props: new Map(),
  icons: new Map(),
  ui: new Map(),
  badges: new Map(),
};

function loadImage(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null); // 單張失敗不該拖垮整批
    img.src = url;
  });
}

export async function loadAssets() {
  try {
    const res = await fetch(`${BASE}/manifest.json`, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`manifest ${res.status}`);
    state.manifest = await res.json();
  } catch {
    state.ready = true; // 沒有 manifest 就整批跳過，全部走程式繪製
    return state;
  }

  const ext = state.manifest.ext ?? 'png';
  const jobs = [];
  for (const group of ['units', 'props', 'icons', 'ui', 'badges']) {
    for (const name of state.manifest[group] ?? []) {
      jobs.push(loadImage(`${BASE}/${group}/${name}.${ext}`).then((img) => img && state[group].set(name, img)));
    }
  }
  await Promise.all(jobs);
  state.ready = true;
  return state;
}

// HP 比例對應到損傷階段。門檻與 BALANCE.md 記載的一致。
export function damageState(unit) {
  const ratio = unit.hp / Math.max(1, unit.mhp);
  if (ratio > 0.66) return 'intact';
  if (ratio > 0.33) return 'damaged';
  return 'critical';
}

// 底圖：skin 讓同一個原型可以有多套外觀（隨機幹員用），沒有 skin 就退回 key。
// 分開兩個欄位是刻意的：key 是玩法身分（誰是狙擊），skin 只是長相，
// 混在一起的話換張圖就會動到平衡與 AI 判斷。
function baseSprite(unit) {
  const base = unit.skin || unit.key;
  const dmg = damageState(unit);
  return state.units.get(`${base}-${dmg}`)
    // 該階段缺圖時退到完好版，再不行退回原型，總比沒有好
    ?? state.units.get(`${base}-intact`)
    ?? state.units.get(`${unit.key}-${dmg}`)
    ?? state.units.get(`${unit.key}-intact`)
    ?? null;
}

// 屬性配色。素材身上的青藍色發光條帶要換成屬性色。
//
// 第一版用 ctx.filter = 'hue-rotate()' 整張旋轉，兩個問題：
//   1. 重創狀態的橘色火花被一起轉成洋紅 —— 那是「這隻快死了」的通用訊號，不能動
//   2. CSS hue-rotate 是矩陣近似不是真的 HSL 旋轉，動能想要的琥珀色轉出來是青綠
// 所以改成逐像素、只挑「明顯偏青藍」的像素換色，其他一律不碰。
// 一個組合只算一次並快取，256x256 的成本可以忽略。
const EL_TINT = {
  kinetic: [255, 200, 90], // 琥珀
  emp: null, // 素材本來就是青藍，不用動
  armor: [110, 230, 150], // 青綠
};

const lookCache = new Map();

// 判斷這個像素是不是「青藍色發光」：藍綠明顯高於紅，而且夠亮。
// 槍鐵灰是去飽和的（r≈g≈b）所以不會中，橘色火花 r 最大也不會中。
function isCyanGlow(r, g, b) {
  return b > r + 40 && g > r + 20 && (b + g) / 2 > 90;
}

function composedSprite(unit, base) {
  const tint = EL_TINT[unit.el];
  if (!tint) return base;
  const key = `${unit.skin || unit.key}|${damageState(unit)}|${unit.el}`;
  const hit = lookCache.get(key);
  if (hit) return hit;

  // node 測試環境沒有 document，直接回底圖
  if (typeof document === 'undefined') return base;
  const c = document.createElement('canvas');
  c.width = base.width;
  c.height = base.height;
  const cx = c.getContext('2d', { willReadFrequently: true });
  if (!cx) return base;
  cx.drawImage(base, 0, 0);

  try {
    const img = cx.getImageData(0, 0, c.width, c.height);
    const p = img.data;
    const [tr, tg, tb] = tint;
    for (let i = 0; i < p.length; i += 4) {
      if (p[i + 3] < 8) continue;
      const r = p[i]; const g = p[i + 1]; const b = p[i + 2];
      if (!isCyanGlow(r, g, b)) continue;
      // 保留原本的明暗（發光有強弱），只換色相
      const lum = (b + g) / 2 / 255;
      p[i] = Math.min(255, Math.round(tr * lum));
      p[i + 1] = Math.min(255, Math.round(tg * lum));
      p[i + 2] = Math.min(255, Math.round(tb * lum));
    }
    cx.putImageData(img, 0, 0);
  } catch {
    return base; // 跨來源污染之類的，退回底圖就好
  }

  lookCache.set(key, c);
  return c;
}

// 拿不到就回 null，呼叫端負責降級
export function unitSprite(unit) {
  if (!unit?.key) return null;
  const base = baseSprite(unit);
  if (!base) return null;
  // 只有我方幹員做個體化。敵人維持統一外觀是刻意的：
  // 玩家要在半秒內判斷「那隻是什麼、打不打得動」，敵人長太多樣只會拖慢判讀。
  if (unit.tm !== 'p') return base;
  return composedSprite(unit, base);
}

export function uiSprite(name) {
  return state.ui.get(name) ?? null;
}

export function badgeSprite(id) {
  return state.badges.get(id) ?? null;
}

// 徽章圖的網址。徽章畫廊是 HTML 面板不是畫布，用 <img> 比較省事，
// 灰階也能直接交給 CSS filter 做 —— 一份素材兩種狀態，不必生兩套圖。
export function badgeSrc(id) {
  const ext = state.manifest?.ext ?? 'webp';
  return `${BASE}/badges/${id}.${ext}`;
}

export function propSprite(name) {
  return state.props.get(name) ?? null;
}

// 掩體有完好與受損兩種，依格子座標決定用哪一種，
// 讓同一場戰鬥的掩體看起來有變化但每次重繪都一樣（不會閃爍）。
export function coverSprite(x, y) {
  const variants = ['cover-intact', 'cover-damaged'];
  const pick = variants[(x * 7 + y * 13) % variants.length];
  return propSprite(pick) ?? propSprite('cover-intact');
}

// 關卡節點圖示。node type 直接對應檔名。
export function nodeIcon(type) {
  return state.icons.get(`icon-${type}`) ?? null;
}

// 給 DOM 面板用的 data URL，這樣清單裡也能顯示同一組圖示
const dataUrlCache = new Map();
export function nodeIconUrl(type) {
  const key = `icon-${type}`;
  if (dataUrlCache.has(key)) return dataUrlCache.get(key);
  const img = state.icons.get(key);
  if (!img) return null;
  const ext = state.manifest?.ext ?? 'webp';
  const url = `${BASE}/icons/${key}.${ext}`;
  dataUrlCache.set(key, url);
  return url;
}

export function assetsReady() {
  return state.ready;
}

// ready 一定要一起回傳。只看 units > 0 會在還在載的時候就判定完成，
// 測試會拿到「載到一半」的數字而偶發失敗。
export function assetCount() {
  return {
    ready: state.ready,
    units: state.units.size,
    props: state.props.size,
    icons: state.icons.size,
    ui: state.ui.size,
  };
}
