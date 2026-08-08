#!/usr/bin/env node
// codex-generate.mjs
// 透過 codex CLI 生圖，自動：
//   1. 套用統一風格 base prompt
//   2. 移動生成的圖片到設定集目錄
//   3. 更新 quota.json 配額追蹤
//   4. 更新對應 JSON（characters/scenes/items）的 image + generated_at
//
// 用法：
//   node scripts/codex-generate.mjs character summon-chenan-25
//   node scripts/codex-generate.mjs scene summon-luzhou-4f-3f-room
//   node scripts/codex-generate.mjs item shared-rur13-iron-box
//
// 額度檢查：
//   每天上限 8 張·超過會拒絕執行（避免觸發 ChatGPT 冷卻）

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const CODEX_BIN = path.join(os.homedir(), 'bin', 'codex.exe');
const DATA_DIR = path.join(ROOT, 'codex', 'data');
const IMG_DIR = path.join(ROOT, 'codex', 'images');
const STYLE_GUIDE = path.join(ROOT, 'codex', 'style-guide.md');

// 讀 style-guide.md 抽出 STYLE_BASE 段·若不存在用 fallback
const DEFAULT_STYLE_BASE = `Style: Studio Ghibli x Blade Runner 2049 hybrid, hand-painted watercolor texture, cinematic anime composition, melancholic atmosphere, soft warm-cool color palette (deep navy + warm amber + muted teal), high facial detail, consistent character design, no text in image, no watermark, no signature, square aspect ratio 1:1.`;

function loadStyleBase() {
  if (!fs.existsSync(STYLE_GUIDE)) return DEFAULT_STYLE_BASE;
  const guide = fs.readFileSync(STYLE_GUIDE, 'utf-8');
  // 找 ```...``` 的第一個 code block 當 STYLE_BASE
  const m = guide.match(/```\s*\n([\s\S]+?)\n```/);
  if (m && m[1].trim()) return m[1].trim().replace(/\n+/g, ' ');
  return DEFAULT_STYLE_BASE;
}
const STYLE_BASE = loadStyleBase();

const args = process.argv.slice(2);
const [kind, id] = args;

if (!kind || !id) {
  console.error('用法：node scripts/codex-generate.mjs <character|scene|item> <id>');
  console.error('例：node scripts/codex-generate.mjs character summon-chenan-25');
  process.exit(1);
}

const validKinds = ['character', 'scene', 'item', 'panel', 'cover'];
if (!validKinds.includes(kind)) {
  console.error(`kind 必須是: ${validKinds.join(' / ')}`);
  process.exit(1);
}

// === 1. 讀資料 ===
const dataFile = path.join(DATA_DIR, kind === 'character' ? 'characters.json' : kind === 'scene' ? 'scenes.json' : kind === 'item' ? 'items.json' : kind === 'cover' ? 'covers.json' : 'comics.json');
const data = JSON.parse(fs.readFileSync(dataFile, 'utf-8'));

let entry;
let isComic = false;
if (kind === 'character') {
  // 容忍多種 schema：list / characters / summon+apocalypse 都掃
  const all = [
    ...(data.list || []),
    ...(data.characters || []),
    ...(data.summon || []),
    ...(data.apocalypse || []),
  ];
  entry = all.find(c => c.id === id);
} else if (kind === 'scene') {
  entry = data.scenes.find(s => s.id === id);
} else if (kind === 'item') {
  entry = data.items.find(i => i.id === id);
} else if (kind === 'cover') {
  entry = data.covers.find(c => c.id === id);
} else if (kind === 'panel') {
  isComic = true;
  for (const key of Object.keys(data)) {
    if (key === '_meta') continue;
    const found = data[key].panels.find(p => p.id === id);
    if (found) { entry = found; entry._chapter_key = key; break; }
  }
}

if (!entry) {
  console.error(`找不到 id: ${id} (in ${dataFile})`);
  process.exit(1);
}

if (entry.image && fs.existsSync(path.join(ROOT, 'codex', 'images', entry.image))) {
  console.error(`⚠️  ${id} 已經生過：${entry.image}`);
  console.error('要重生請先刪掉舊圖：rm codex/images/' + entry.image);
  process.exit(1);
}

// === 2. 配額檢查 ===
const quotaFile = path.join(DATA_DIR, 'quota.json');
const quota = JSON.parse(fs.readFileSync(quotaFile, 'utf-8'));
// 本地時區日期（避開 UTC 跨日延遲）
const _now = new Date();
const today = `${_now.getFullYear()}-${String(_now.getMonth()+1).padStart(2,'0')}-${String(_now.getDate()).padStart(2,'0')}`;

// 跨日重置
if (quota.today.date !== today) {
  if (quota.today.generated > 0) {
    quota.history.push({ ...quota.today });
  }
  quota.today = {
    date: today,
    generated: 0,
    limit: quota._meta.daily_limit,
    sessions: []
  };
}

if (quota.today.generated >= quota.today.limit) {
  console.error(`❌ 今日額度已滿：${quota.today.generated}/${quota.today.limit}`);
  console.error('明天再試，或編輯 codex/data/quota.json 提高 daily_limit');
  process.exit(1);
}

// 最小間隔檢查
const lastSession = quota.today.sessions[quota.today.sessions.length - 1];
if (lastSession) {
  const elapsed = (Date.now() - new Date(lastSession.timestamp).getTime()) / 1000;
  const minInterval = quota._meta.min_interval_seconds;
  if (elapsed < minInterval) {
    const wait = Math.ceil(minInterval - elapsed);
    console.error(`⏳ 上次生成才 ${elapsed.toFixed(0)} 秒，請等 ${wait} 秒（避免冷卻）`);
    process.exit(1);
  }
}

// === 3. 組 prompt ===
let subdir, filename, styleSuffix;
if (isComic) {
  subdir = path.join('comics', entry._chapter_key);
  filename = `${id}.png`;
  styleSuffix = data._meta.style_override || STYLE_BASE;
} else {
  subdir = kind === 'character' ? 'chars' : kind === 'scene' ? 'scenes' : kind === 'cover' ? 'covers' : 'items';
  filename = `${id}.png`;
  styleSuffix = STYLE_BASE;
}
const targetPath = path.join(IMG_DIR, subdir, filename);
fs.mkdirSync(path.dirname(targetPath), { recursive: true });

const fullPrompt = `${entry.prompt}. ${styleSuffix}`;

console.log(`\n📸 生成中：${kind} / ${id}`);
console.log(`Prompt: ${entry.prompt.slice(0, 100)}...`);
console.log(`今日額度：${quota.today.generated + 1}/${quota.today.limit}`);
console.log('');

// === 4. 呼叫 codex（捕捉 stdout 以檢測失敗訊息）===
const workdir = path.join(ROOT, 'codex', 'images', subdir);
const codexCmd = `"${CODEX_BIN}" exec -s workspace-write --skip-git-repo-check --cd "${workdir}" "Directly call the image_gen tool now to generate this image. Do NOT use the imagegen skill or any PowerShell-based workflow — just call image_gen directly. Image description: ${fullPrompt.replace(/"/g, '\\"')}"`;

const startTime = Date.now();
let codexOut = '';
try {
  // 同時 capture stdout + stderr，並 echo 出來
  codexOut = execSync(codexCmd + ' 2>&1', { cwd: workdir, encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024, shell: true });
  process.stdout.write(codexOut);
} catch (e) {
  console.error('❌ codex 執行失敗', e.message);
  process.exit(1);
}
const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

// 檢測 codex 是否報告失敗（沒實際生圖）
const failPatterns = [
  /image generation request failed/i,
  /No image was created/i,
  /failed to generate/i,
  /generation failed/i,
  /content policy/i,
  /unable to (?:generate|create)/i,
  /windows sandbox.*spawn setup/i,
  /exec error/i,
];
const failedReport = failPatterns.find(p => p.test(codexOut));
if (failedReport) {
  console.error(`\n❌ codex 回報生圖失敗（match: ${failedReport}）— 不搬舊圖`);
  console.error('可能原因：1) ChatGPT 內容過濾 2) 額度暫時冷卻 3) image_tool 服務錯誤 4) sandbox spawn 失敗');
  process.exit(2);  // exit 2 = 可 retry
}

// === 5. 找這次 session 的圖（mtime > startTime 嚴格驗證）===
const codexImgRoot = path.join(os.homedir(), '.codex', 'generated_images');
const sessions = fs.readdirSync(codexImgRoot)
  .map(s => ({ s, t: fs.statSync(path.join(codexImgRoot, s)).mtimeMs }))
  .filter(x => x.t >= startTime)  // 只看這次 wrapper 啟動後新建的 session
  .sort((a, b) => b.t - a.t);

if (!sessions.length) {
  console.error(`❌ 在 ${new Date(startTime).toISOString()} 之後沒有新 session — codex 沒實際生圖`);
  process.exit(2);
}

const latestSession = sessions[0].s;
const sessionDir = path.join(codexImgRoot, latestSession);
const pngFiles = fs.readdirSync(sessionDir).filter(f => f.endsWith('.png'));

if (!pngFiles.length) {
  console.error(`❌ 新 session ${latestSession} 沒有 .png — codex 沒生圖`);
  process.exit(2);
}

const sourcePath = path.join(sessionDir, pngFiles[0]);
fs.copyFileSync(sourcePath, targetPath);
const imageRelPath = `${subdir.replace(/\\/g, '/')}/${filename}`;
console.log(`\n✅ 已存：codex/images/${imageRelPath}`);

// === 6. 更新對應 JSON ===
entry.image = imageRelPath;
entry.generated_at = new Date().toISOString();
if (isComic) delete entry._chapter_key;
fs.writeFileSync(dataFile, JSON.stringify(data, null, 2), 'utf-8');
console.log(`✅ 更新：${path.basename(dataFile)}`);

// === 7. 更新 quota ===
quota.today.generated += 1;
quota.today.sessions.push({
  id,
  kind,
  timestamp: new Date().toISOString(),
  elapsed_seconds: parseFloat(elapsed),
  codex_session: latestSession,
  image: imageRelPath
});
fs.writeFileSync(quotaFile, JSON.stringify(quota, null, 2), 'utf-8');
console.log(`✅ 額度：${quota.today.generated}/${quota.today.limit}（耗時 ${elapsed}s）`);
console.log('');
