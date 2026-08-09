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
  for (const group of ['units', 'props', 'icons', 'ui']) {
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

// 拿不到就回 null，呼叫端負責降級
export function unitSprite(unit) {
  if (!unit?.key) return null;
  const exact = state.units.get(`${unit.key}-${damageState(unit)}`);
  if (exact) return exact;
  // 該階段缺圖時退到完好版，總比沒有好
  return state.units.get(`${unit.key}-intact`) ?? null;
}

export function uiSprite(name) {
  return state.ui.get(name) ?? null;
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
