// 量各個 BGM 段落實際輸出的音量。
//
//   node tools/check-audio.mjs
//
// 為什麼需要這支：「有沒有播放」跟「聽不聽得到」是兩件事。
// 之前開場的 BGM 技術上有在跑，但音量低到根本聽不見，
// 而測試只檢查 mode !== null 所以完全沒抓到。
// 這支直接在 musicBus 上掛 analyser 量 RMS，用數字說話。

import { chromium } from 'playwright';
import { listen } from '../serve.mjs';

const SAMPLE_MS = 5000; // 每個段落量多久（pad 每小節才鋪一次，要夠長才抓得到）
const TICK_MS = 60;

const { server, port } = await listen(0);
const browser = await chromium.launch({
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage();
await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof window.__audio === 'function', null, { timeout: 15000 });

// 解鎖 AudioContext
await page.mouse.click(5, 5);
await page.waitForTimeout(500);

const boot = await page.evaluate(() => window.__audio());
console.log(`AudioContext  started=${boot.started} running=${boot.running} scheduling=${boot.scheduling} mode=${boot.mode}`);
console.log('');

async function sample(mode) {
  await page.evaluate((m) => window.__debug.setMusicMode(m), mode);
  await page.waitForTimeout(250);
  const stats = await page.evaluate(async ({ ms, tick }) => {
    const levels = [];
    const t0 = performance.now();
    while (performance.now() - t0 < ms) {
      levels.push(window.__audio().level);
      await new Promise((r) => setTimeout(r, tick));
    }
    const peak = Math.max(...levels);
    const mean = levels.reduce((a, b) => a + b, 0) / levels.length;
    const audible = levels.filter((l) => l > 0.004).length / levels.length;
    return { peak, mean, audible };
  }, { ms: SAMPLE_MS, tick: TICK_MS });
  return stats;
}

const dbfs = (v) => (v <= 0 ? '-inf' : (20 * Math.log10(v)).toFixed(1));

const rows = [];
for (const mode of ['hub', 'map', 'battle', 'boss', 'result']) {
  const s = await sample(mode);
  rows.push({ mode, ...s });
  console.log(
    `${mode.padEnd(8)} peak ${s.peak.toFixed(4)} (${dbfs(s.peak).padStart(6)} dB)`
    + `   mean ${s.mean.toFixed(4)}   有聲時間 ${(s.audible * 100).toFixed(0)}%`
  );
}

// 音效拿來當對照組：BGM 應該明顯比音效小聲，但不能小到聽不見
await page.evaluate(() => window.__debug.setMusicMode('hub'));
const sfxPeak = await page.evaluate(async () => {
  const AudioSt = () => window.__audio();
  void AudioSt;
  let peak = 0;
  window.__debug.playSfx('fire');
  const t0 = performance.now();
  while (performance.now() - t0 < 400) {
    peak = Math.max(peak, window.__debug.sfxLevel ? window.__debug.sfxLevel() : 0);
    await new Promise((r) => setTimeout(r, 10));
  }
  return peak;
});

await browser.close();
server.close();

console.log('');
const problems = [];
for (const r of rows) {
  // 低於 -46 dB 在有音效與環境噪音的情況下等於聽不到
  if (r.peak < 0.012) problems.push(`${r.mode} 的峰值只有 ${dbfs(r.peak)} dB，實際上聽不見`);
  if (r.audible < 0.85) problems.push(`${r.mode} 只有 ${(r.audible * 100).toFixed(0)}% 的時間有聲音，空拍太長`);
  if (r.peak > 0.35) problems.push(`${r.mode} 峰值 ${dbfs(r.peak)} dB 太大聲，會蓋掉音效`);
}
void sfxPeak;

if (problems.length) {
  console.log('⚠ 需要處理：');
  for (const p of problems) console.log(`   - ${p}`);
  process.exitCode = 1;
} else {
  console.log('✓ 每個段落都在可聽範圍內');
}
