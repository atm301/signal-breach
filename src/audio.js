// 音效與背景音樂，全部用 Web Audio 即時合成。
//
// 刻意不用音檔：一首兩分鐘的 BGM 就要 2 到 3 MB，是整個遊戲素材的三倍，
// 而且會有授權問題。程序合成是 0 bytes、無限長、不重複，也沒有版權疑慮。
//
// 音樂引擎用的是標準的 lookahead scheduler（"A Tale of Two Clocks" 那套）：
// setInterval 只負責「往前排程」，實際發聲時間交給 AudioContext 的高精度時鐘，
// 直接用 setTimeout 觸發會因為主執行緒卡頓而抖動。

const STORAGE_KEY = 'sft_audio_v1';
const MUSIC_GAIN = 0.30;
const SFX_GAIN = 0.55;

const state = {
  ctx: null,
  master: null,
  musicBus: null,
  sfxBus: null,
  musicOn: true,
  sfxOn: true,
  mode: null,
  timer: null,
  nextNoteTime: 0,
  step: 0,
  bar: 0,
  noiseBuffer: null,
  musicAnalyser: null,
  track: null,
  drone: null,
};

// ---------------------------------------------------------------- 設定持久化

function loadPrefs() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const p = JSON.parse(raw);
    if (typeof p.music === 'boolean') state.musicOn = p.music;
    if (typeof p.sfx === 'boolean') state.sfxOn = p.sfx;
  } catch { /* 無痕模式或壞資料，用預設值 */ }
}

function savePrefs() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ music: state.musicOn, sfx: state.sfxOn }));
  } catch { /* 存不了就算了，不影響遊玩 */ }
}

loadPrefs();

// ---------------------------------------------------------------- 初始化

// 瀏覽器規定 AudioContext 必須在使用者手勢之後才能出聲，
// 所以任何點擊或按鍵都會先呼叫這個。
export function ensureAudio() {
  if (state.ctx) {
    if (state.ctx.state === 'suspended') state.ctx.resume().catch(() => {});
    return state.ctx;
  }
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;

  const ctx = new AC();
  state.ctx = ctx;

  state.master = ctx.createGain();
  state.master.gain.value = 0.9;
  state.master.connect(ctx.destination);

  state.musicBus = ctx.createGain();
  state.musicBus.gain.value = state.musicOn ? MUSIC_GAIN : 0;
  state.musicBus.connect(state.master);

  // 掛一個分析器在音樂匯流排上，讓測試可以真的量到「有沒有出聲」。
  // 只檢查 state.mode !== null 是不夠的 —— 沒有 AudioContext 時 mode 一樣會被設定，
  // 之前就是這樣讓「開場沒有 BGM」躲過測試的。
  state.musicAnalyser = ctx.createAnalyser();
  state.musicAnalyser.fftSize = 2048;
  state.musicBus.connect(state.musicAnalyser);

  state.sfxBus = ctx.createGain();
  state.sfxBus.gain.value = state.sfxOn ? SFX_GAIN : 0;
  state.sfxBus.connect(state.master);

  // 白噪音緩衝，打擊樂與爆炸音用
  const len = Math.floor(ctx.sampleRate * 1.2);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  state.noiseBuffer = buf;

  if (state.mode) startMusic(state.mode);
  return ctx;
}

// ---------------------------------------------------------------- 合成零件

function tone(opts) {
  const ctx = state.ctx;
  if (!ctx) return;
  const {
    freq, type = 'sine', dur = 0.12, gain = 0.3, attack = 0.006,
    slideTo = null, detune = 0, bus = state.sfxBus, filter = null, delay = 0,
  } = opts;

  const t0 = ctx.currentTime + delay;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.detune.value = detune;
  osc.frequency.setValueAtTime(freq, t0);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), t0 + dur);

  let node = osc;
  if (filter) {
    const f = ctx.createBiquadFilter();
    f.type = filter.type || 'lowpass';
    f.frequency.setValueAtTime(filter.freq ?? 1200, t0);
    if (filter.to) f.frequency.exponentialRampToValueAtTime(Math.max(40, filter.to), t0 + dur);
    f.Q.value = filter.q ?? 1;
    node.connect(f);
    node = f;
  }

  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  node.connect(g);
  g.connect(bus);

  osc.start(t0);
  osc.stop(t0 + dur + 0.03);
}

function noise(opts) {
  const ctx = state.ctx;
  if (!ctx || !state.noiseBuffer) return;
  const { dur = 0.1, gain = 0.2, hp = 200, lp = 6000, bus = state.sfxBus, delay = 0 } = opts;
  const t0 = ctx.currentTime + delay;

  const src = ctx.createBufferSource();
  src.buffer = state.noiseBuffer;
  const hpf = ctx.createBiquadFilter();
  hpf.type = 'highpass';
  hpf.frequency.value = hp;
  const lpf = ctx.createBiquadFilter();
  lpf.type = 'lowpass';
  lpf.frequency.value = lp;
  const g = ctx.createGain();

  g.gain.setValueAtTime(gain, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

  src.connect(hpf); hpf.connect(lpf); lpf.connect(g); g.connect(bus);
  src.start(t0);
  src.stop(t0 + dur + 0.02);
}

// ---------------------------------------------------------------- 音效

const SFX = {
  // 介面
  click: () => { tone({ freq: 660, type: 'square', dur: 0.05, gain: 0.13, filter: { freq: 2600 } }); },
  hover: () => { tone({ freq: 880, type: 'sine', dur: 0.04, gain: 0.05 }); },
  deny: () => {
    tone({ freq: 200, type: 'square', dur: 0.09, gain: 0.16 });
    tone({ freq: 150, type: 'square', dur: 0.11, gain: 0.14, delay: 0.07 });
  },
  ui: (f) => { tone({ freq: f || 620, type: 'sine', dur: 0.1, gain: 0.16, slideTo: (f || 620) * 1.12 }); },
  coin: () => {
    tone({ freq: 880, type: 'triangle', dur: 0.07, gain: 0.16 });
    tone({ freq: 1320, type: 'triangle', dur: 0.1, gain: 0.14, delay: 0.06 });
  },
  node: () => {
    tone({ freq: 420, type: 'sine', dur: 0.1, gain: 0.16, slideTo: 700 });
    noise({ dur: 0.12, gain: 0.05, hp: 1800, lp: 7000, delay: 0.02 });
  },

  // 戰鬥
  move: () => {
    tone({ freq: 240, type: 'triangle', dur: 0.08, gain: 0.11, slideTo: 300 });
    noise({ dur: 0.09, gain: 0.05, hp: 400, lp: 2200 });
  },
  fire: (f) => {
    const base = f || 520;
    tone({ freq: base, type: 'sawtooth', dur: 0.1, gain: 0.2, slideTo: base * 0.45, filter: { freq: 3200, to: 700 } });
    noise({ dur: 0.07, gain: 0.13, hp: 900, lp: 8000 });
  },
  hit: (f) => {
    tone({ freq: f || 310, type: 'square', dur: 0.08, gain: 0.15, slideTo: (f || 310) * 0.55 });
    noise({ dur: 0.06, gain: 0.1, hp: 300, lp: 3200 });
  },
  kill: () => {
    tone({ freq: 180, type: 'triangle', dur: 0.3, gain: 0.22, slideTo: 55 });
    noise({ dur: 0.34, gain: 0.2, hp: 120, lp: 2400 });
  },
  level: () => {
    [523, 659, 784, 1047].forEach((f, i) => {
      tone({ freq: f, type: 'triangle', dur: 0.18, gain: 0.15, delay: i * 0.07 });
    });
  },

  // 結算
  victory: () => {
    [523, 659, 784, 1047, 1319].forEach((f, i) => {
      tone({ freq: f, type: 'triangle', dur: 0.5, gain: 0.16, delay: i * 0.1 });
      tone({ freq: f / 2, type: 'sine', dur: 0.6, gain: 0.1, delay: i * 0.1 });
    });
    noise({ dur: 0.5, gain: 0.05, hp: 2000, lp: 9000, delay: 0.4 });
  },
  defeat: () => {
    [392, 330, 262, 196].forEach((f, i) => {
      tone({ freq: f, type: 'sawtooth', dur: 0.55, gain: 0.14, delay: i * 0.16, filter: { freq: 900, to: 250 } });
    });
    noise({ dur: 1.0, gain: 0.07, hp: 80, lp: 700, delay: 0.2 });
  },
};

export function playSfx(kind, freq) {
  if (!state.sfxOn) return;
  const ctx = ensureAudio();
  if (!ctx) return;
  try {
    (SFX[kind] || SFX.click)(freq);
  } catch { /* 音效失敗不該影響遊玩 */ }
}

// ---------------------------------------------------------------- 背景音樂

// 五首曲子，開始播放時隨機挑一首，進戰鬥時再重挑一次，
// 所以同一場遊戲不會一直聽到同一段旋律。
//
// 每首只差在「和弦走向 + 音階 + 音色」，共用同一套排程器，
// 這樣加新曲子只要往這個陣列多推一筆。
const TRACKS = [
  {
    id: 'silent-orbit',
    name: '靜默軌道',
    roots: [45, 41, 38, 43], // Am - F - Dm - G
    scale: [0, 3, 5, 7, 10], // 小調五聲
    padWave: 'sawtooth',
    arpWave: 'square',
    tone: 1.0,
  },
  {
    id: 'rusted-deck',
    name: '鏽蝕甲板',
    roots: [38, 43, 40, 45], // Dm - G - Em - Am，多利安味
    scale: [0, 2, 3, 5, 7, 9],
    padWave: 'triangle',
    arpWave: 'triangle',
    tone: 1.15,
  },
  {
    id: 'deep-alarm',
    name: '深層警報',
    roots: [40, 41, 36, 40], // Em - F - C - Em，弗里吉安，最陰
    scale: [0, 1, 3, 5, 7, 8],
    padWave: 'sawtooth',
    arpWave: 'sawtooth',
    tone: 0.85,
  },
  {
    id: 'cooling-loop',
    name: '冷卻循環',
    roots: [36, 43, 41, 39], // Cm - G - F - D#，最平靜
    scale: [0, 3, 5, 7, 10],
    padWave: 'sine',
    arpWave: 'sine',
    tone: 1.25,
  },
  {
    id: 'breach-protocol',
    name: '突破協議',
    roots: [45, 40, 41, 44], // Am - Em - F - G#，和聲小調，最緊繃
    scale: [0, 3, 5, 8, 11],
    padWave: 'square',
    arpWave: 'square',
    tone: 0.95,
  },
];

const MODES = {
  hub: { bpm: 64, pad: 0.9, drone: 0.9, bass: 0.35, arp: 0.16, hat: 0, kick: 0, cutoff: 700 },
  map: { bpm: 76, pad: 0.95, drone: 0.85, bass: 0.6, arp: 0.24, hat: 0, kick: 0, cutoff: 900 },
  battle: { bpm: 98, pad: 0.85, drone: 0.7, bass: 0.9, arp: 0.4, hat: 0.55, kick: 0.7, cutoff: 1250 },
  boss: { bpm: 110, pad: 1.0, drone: 0.8, bass: 1.0, arp: 0.5, hat: 0.75, kick: 0.9, cutoff: 1650 },
  result: { bpm: 62, pad: 0.8, drone: 0.9, bass: 0.3, arp: 0.1, hat: 0, kick: 0, cutoff: 640 },
};

const midiToFreq = (m) => 440 * 2 ** ((m - 69) / 12);

const LOOKAHEAD_S = 0.15; // 往前排程多久
const TICK_MS = 30; // 排程器檢查間隔

// ---------------------------------------------------------------- 持續低鳴
//
// 一個從頭到尾不停的低頻墊底。
// 沒有它的話，pad 每小節才鋪一次，量出來只有 20% 到 46% 的時間有聲音，
// 中間的空拍會讓人以為 BGM 根本沒在播。

function ensureDrone() {
  const ctx = state.ctx;
  if (!ctx || state.drone) return;

  const gain = ctx.createGain();
  gain.gain.value = 0;
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 420;
  filter.Q.value = 0.7;
  filter.connect(gain);
  gain.connect(state.musicBus);

  const oscs = [-5, 5].map((detune) => {
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.detune.value = detune;
    o.frequency.value = midiToFreq(33);
    o.connect(filter);
    o.start();
    return o;
  });

  state.drone = { oscs, gain, filter };
}

function setDrone(root, cfg) {
  const d = state.drone;
  const ctx = state.ctx;
  if (!d || !ctx) return;
  const t = ctx.currentTime;
  for (const o of d.oscs) o.frequency.setTargetAtTime(midiToFreq(root - 12), t, 0.35);
  d.filter.frequency.setTargetAtTime(cfg.cutoff * 0.55, t, 0.5);
  d.gain.gain.setTargetAtTime(0.05 * cfg.drone, t, 0.4);
}

function stopDrone() {
  const d = state.drone;
  if (!d || !state.ctx) return;
  d.gain.gain.setTargetAtTime(0, state.ctx.currentTime, 0.2);
}

// ---------------------------------------------------------------- 排程

function scheduleStep(step, time, cfg) {
  const ctx = state.ctx;
  const bus = state.musicBus;
  const track = state.track;
  const root = track.roots[Math.floor(step / 16) % track.roots.length];
  const inBar = step % 16;
  const beat = 60 / cfg.bpm;

  // 每小節換和弦時鋪一次 pad
  if (inBar === 0 && cfg.pad > 0) {
    setDrone(root, cfg);

    const dur = beat * 4.3;
    for (const [semi, det] of [[0, -8], [0, 8], [12, 5], [7, -5], [15, 3]]) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      const f = ctx.createBiquadFilter();
      osc.type = track.padWave;
      osc.detune.value = det;
      osc.frequency.value = midiToFreq(root + semi);
      f.type = 'lowpass';
      f.frequency.setValueAtTime(cfg.cutoff * 0.6 * track.tone, time);
      f.frequency.linearRampToValueAtTime(cfg.cutoff * track.tone, time + dur * 0.5);
      f.frequency.linearRampToValueAtTime(cfg.cutoff * 0.55 * track.tone, time + dur);
      f.Q.value = 2.5;

      // 撐住整個小節再放掉。原本 30% 就開始衰減，導致小節後半幾乎沒聲音。
      const peak = 0.085 * cfg.pad;
      g.gain.setValueAtTime(0.0001, time);
      g.gain.linearRampToValueAtTime(peak, time + dur * 0.22);
      g.gain.setValueAtTime(peak, time + dur * 0.72);
      g.gain.linearRampToValueAtTime(0.0001, time + dur);

      osc.connect(f); f.connect(g); g.connect(bus);
      osc.start(time);
      osc.stop(time + dur + 0.05);
    }
  }

  // 低音：每小節第 1 與第 3 拍
  if (cfg.bass > 0 && (inBar === 0 || inBar === 8)) {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(midiToFreq(root - 12), time);
    g.gain.setValueAtTime(0.0001, time);
    g.gain.exponentialRampToValueAtTime(0.2 * cfg.bass, time + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, time + beat * 1.8);
    osc.connect(g); g.connect(bus);
    osc.start(time);
    osc.stop(time + beat * 1.9);
  }

  // 琶音：稀疏、隨機，避免聽出循環
  if (cfg.arp > 0 && Math.random() < cfg.arp) {
    const semi = track.scale[Math.floor(Math.random() * track.scale.length)];
    const oct = Math.random() < 0.35 ? 24 : 12;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = track.arpWave;
    osc.frequency.value = midiToFreq(root + semi + oct);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 2800 * track.tone;
    g.gain.setValueAtTime(0.0001, time);
    g.gain.exponentialRampToValueAtTime(0.055, time + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, time + beat * 0.5);
    osc.connect(f); f.connect(g); g.connect(bus);
    osc.start(time);
    osc.stop(time + beat * 0.6);
  }

  // 打擊
  if (cfg.kick > 0 && (inBar === 0 || inBar === 8)) {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(120, time);
    osc.frequency.exponentialRampToValueAtTime(42, time + 0.12);
    g.gain.setValueAtTime(0.26 * cfg.kick, time);
    g.gain.exponentialRampToValueAtTime(0.0001, time + 0.18);
    osc.connect(g); g.connect(bus);
    osc.start(time);
    osc.stop(time + 0.22);
  }
  if (cfg.hat > 0 && inBar % 4 === 2) {
    const src = ctx.createBufferSource();
    src.buffer = state.noiseBuffer;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 7000;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.05 * cfg.hat, time);
    g.gain.exponentialRampToValueAtTime(0.0001, time + 0.05);
    src.connect(hp); hp.connect(g); g.connect(bus);
    src.start(time);
    src.stop(time + 0.07);
  }
}

function scheduler() {
  const ctx = state.ctx;
  if (!ctx || !state.mode) return;
  const cfg = MODES[state.mode] || MODES.map;
  const stepDur = (60 / cfg.bpm) / 4; // 十六分音符

  while (state.nextNoteTime < ctx.currentTime + LOOKAHEAD_S) {
    try {
      scheduleStep(state.step, state.nextNoteTime, cfg);
    } catch { /* 單一音符失敗不該讓整首停掉 */ }
    state.nextNoteTime += stepDur;
    state.step = (state.step + 1) % (16 * state.track.roots.length);
  }
}

// ---------------------------------------------------------------- 曲目

function pickTrack(exceptId) {
  const pool = TRACKS.filter((t) => t.id !== exceptId);
  return pool[Math.floor(Math.random() * pool.length)] || TRACKS[0];
}

export function currentTrack() {
  return state.track ? { id: state.track.id, name: state.track.name } : null;
}

// 換一首（玩家可以手動跳過，戰鬥開始時也會自動換）
export function shuffleTrack() {
  state.track = pickTrack(state.track?.id);
  state.step = 0;
  return currentTrack();
}

export function startMusic(mode) {
  state.mode = mode;
  if (!state.track) state.track = pickTrack();
  const ctx = state.ctx;
  if (!ctx) return; // 還沒有使用者手勢，ensureAudio 之後會自動接手
  ensureDrone();
  if (state.timer) return;
  state.nextNoteTime = ctx.currentTime + 0.1;
  state.timer = setInterval(scheduler, TICK_MS);
}

export function stopMusic() {
  if (state.timer) { clearInterval(state.timer); state.timer = null; }
  stopDrone();
  state.mode = null;
}

// 切換段落。同一個 mode 重複呼叫不會重啟，避免每幀重設。
// 進戰鬥時順便換一首，讓每場仗聽起來不一樣。
export function setMusicMode(mode) {
  if (state.mode === mode) return;
  const enteringFight = (mode === 'battle' || mode === 'boss') && state.mode !== 'battle' && state.mode !== 'boss';
  const wasRunning = !!state.timer;
  state.mode = mode;
  if (enteringFight) shuffleTrack();
  if (!wasRunning) startMusic(mode);
}

// ---------------------------------------------------------------- 開關

export function toggleMusic() {
  state.musicOn = !state.musicOn;
  savePrefs();
  if (state.musicBus && state.ctx) {
    const t = state.ctx.currentTime;
    state.musicBus.gain.cancelScheduledValues(t);
    state.musicBus.gain.setTargetAtTime(state.musicOn ? MUSIC_GAIN : 0, t, 0.15);
  }
  if (state.musicOn) ensureAudio();
  return state.musicOn;
}

export function toggleSfx() {
  state.sfxOn = !state.sfxOn;
  savePrefs();
  if (state.sfxBus && state.ctx) state.sfxBus.gain.value = state.sfxOn ? SFX_GAIN : 0;
  if (state.sfxOn) ensureAudio();
  return state.sfxOn;
}

// 音樂匯流排目前的 RMS 音量（0 到 1）。測試靠這個判斷「真的有沒有在出聲」。
export function musicLevel() {
  const a = state.musicAnalyser;
  if (!a) return 0;
  const buf = new Float32Array(a.fftSize);
  a.getFloatTimeDomainData(buf);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  return Math.sqrt(sum / buf.length);
}

export function audioState() {
  return {
    music: state.musicOn,
    sfx: state.sfxOn,
    started: !!state.ctx,
    running: state.ctx?.state === 'running',
    scheduling: !!state.timer,
    mode: state.mode,
    track: state.track ? state.track.name : null,
    level: musicLevel(),
  };
}
