# Signal Breach 訊號突破

5x5 網格的科幻回合制戰棋 Roguelike。純前端、零執行期依賴、可靜態部署。

---

## 動手前先讀這段

**這個專案的規則邏輯全部在 `src/engine.js`，而且它刻意不碰任何 DOM。**
因為 `tools/simulate.mjs` 會在 node 裡直接 import 它，用機器人跑幾百場來驗平衡。
一旦在 engine 裡寫了 `document` / `window` / `Audio`，模擬器就掛了，
你也就失去唯一能證明「遊戲還好玩」的工具。

特效與音效的做法：engine 只往 `g.fxQueue` / `g.sfxQueue` 丟事件，
由 `src/main.js` 每一幀取走並播放。**不要在 engine 裡直接播東西。**

---

## 指令

```bash
npm run dev            # 本機開發 http://localhost:5178（ES module 不能用 file://）
npm run sim            # 玩法評估器，跑 300 場，輸出勝率／深度分佈／回合長度
npm run sim:max        # 模擬永久升級點滿的老玩家
npm run sim:long       # 跑 2000 場，數字比較穩
npm test               # Playwright 整合測試（27 項斷言 + console error 檢查）
npm run check          # sim + test 一起跑
npm run shots          # 各畫面截圖到 test-output/shots/，要人眼看
npm run assets         # 重切素材表 + 重做 OG 圖
npm run assets:review  # 素材接觸表（深色底），檢查去背與損傷遞進
```

**改完任何數值都要跑 `npm run sim`。** 它會在指標跑出區間時 exit 1。
目標區間與最新實測數字都在 [BALANCE.md](BALANCE.md)。

---

## 檔案結構

```
index.html          外殼（含 GA4 + Meta Pixel + OG tags），面板由 ui.js 填
styles.css          全站樣式
src/
  rng.js            seeded RNG。每個 run 由 seed 完全決定（可分享／每日挑戰／可重現測試）
  data.js           ★ 所有可調數值。改平衡只動這裡
  mapgen.js         隨機分岔關卡樹生成 + 連通性驗證
  engine.js         ★ 純邏輯：戰鬥、AI、run 狀態機、事件／商店／補給。零 DOM
  meta.js           localStorage 跨 run 永久進度
  audio.js          Web Audio 即時合成的音效與 BGM。零音檔
  assets.js         AI 素材載入 + 損傷階段判定。缺圖時優雅降級
  render.js         canvas 繪製（戰鬥棋盤 + 關卡樹）。只讀 state，不改
  ui.js             DOM 面板。重建 innerHTML + 事件委派，靠 signature 比對避免每幀重繪
  main.js           組裝：輸入、音效、主迴圈、meta 存檔、測試掛鉤
assets/             ★ 上線用的素材（WebP + manifest）。切圖產物，不要手動編輯
codex/              素材原始檔：prompt、風格指南、生成的大張素材表
tools/
  simulate.mjs      ★ 玩法評估器
  slice-sheets.mjs  把素材表切成單張帶 alpha 的 WebP
  make-og.mjs       OG 分享圖（AI 底圖 + 程式疊字）
  asset-contact-sheet.mjs  素材接觸表，人眼檢查用
  shots.mjs         視覺驗證截圖
tests/
  full-flow-test.mjs  Playwright 整合測試
scripts/
  codex-generate.mjs  codex 生圖 wrapper（來自 codex-image skill）
serve.mjs           零依賴靜態伺服器（開發 + 測試共用）
```

---

## 遊戲規則（改動前務必理解）

- **AP 只用來移動。攻擊每回合限一次，且需保留 1 AP。**
  這條是刻意的，理由寫在 BALANCE.md 第 1 節。拿掉它戰鬥會退化成 2 回合互砍。
- **掩體**對距離 >= 2 的攻擊減傷 1。近戰不受掩體影響。
- 肅清全部敵人後會停在**通關結算畫面**（`screen === 'victory'`），按「繼續推進」才回地圖。
  加新畫面時記得同步教會 `tools/simulate.mjs` 的機器人，否則模擬器會卡住。
- 一個 run = 12 層（F0 登陸點 → F11 頭目），中間走分岔路線。
- 戰鬥中陣亡的隊員，**戰後以 35% Max HP 歸隊**；全隊同時倒下才算 run 結束。
- Run 結束（含中途放棄）都會結算核心碎片並寫進 localStorage。

---

## 素材流程（AI 生圖）

視覺全部是 gpt-image-1 透過 codex CLI 生的，走「一張大表 → 程式切圖」而不是一張一張生。
風格與配色規範在 [codex/style-guide.md](codex/style-guide.md)。

```
codex/data/items.json      每張素材表的 prompt + 列數欄數 + 每格對應的檔名
        ↓  node scripts/codex-generate.mjs item <id>        約 90 到 125 秒／張
codex/images/items/*.png   大張素材表（純洋紅背景，3x3 或 2x3）
        ↓  npm run assets
assets/units/*.webp        33 張單位（11 個單位 x 完好／受損／重創）
assets/props/*.webp        6 張道具（掩體三階段、登陸點、碎片、補給箱）
assets/icons/*.webp        8 個關卡節點圖示徽章
assets/ui/*.webp           面板底板（slice:false 的整張圖，不切格）
assets/manifest.json       載入器只會請求這份清單上的檔案
```

### 為什麼一定要「一張大表再切」

1. **這是做損傷狀態的唯一正解。** AI 分次生成同一個角色必然漂移（配色偏掉、輪廓抖動），
   但單次生成內能鎖住角色特徵。所以同一列的完好／受損／重創**必須在同一次生成裡**。
2. 省配額。6 次生成產出 39 張素材。

### 三個踩過的坑

| 坑 | 症狀 | 解法 |
|---|---|---|
| 固定網格硬切 | 素材貼到格線邊緣被切掉手腳 | 投影找分隔溝，在預期分界線附近取投影最小處當切線 |
| 每格各自裁緊 | **單位被打之後反而變大**（受傷版剪影較小被放大） | 整張表共用一個裁切框尺寸 |
| 洋紅去背用線性 alpha | 深色底上看得到淡淡的方形殘留 | 模型的背景不是精確 #FF00FF，上端要直接歸零 + 清掉 alpha < 40 |
| **直接覆寫 alpha** | **所有素材鑲一圈不透明黑框**，深色底看不出來，單位一旋轉就露餡 | 共用框四周是畫布原本就透明的 rgba(0,0,0,0)，而 magentaness(0,0,0)=0 會被判成純素材。必須 `alpha = min(既有alpha, 去背alpha)`。切圖器現在會自動驗四角透明度 |

### 加新單位的步驟

1. `codex/data/items.json` 加一張新表（或在既有表加一列），寫好 `rows` / `cols` / `cells`
2. `node scripts/codex-generate.mjs item <id>`
3. `npm run assets` 切圖
4. `npm run assets:review` **用眼睛看接觸表**，確認去背乾淨、同列尺寸一致、損傷遞進看得出來
5. `npm test` 的 `unitSpritesLoaded` 斷言寫死了張數，加素材要同步改

⚠️ codex 生圖吃 ChatGPT Plus 的 rate limit，不是固定張數。`codex/data/quota.json` 設 20/天，
同一週別再跑別的重活。

⚠️ `codex/images/` 是大張原始表（約 13MB），**不要刪**，重新切圖或改輸出尺寸都靠它。

## 常見改動怎麼下手

| 想做的事 | 改哪裡 |
|---|---|
| 調難度、改數值 | `src/data.js` 的 `TUNE`，然後跑 `npm run sim` |
| 加新敵人 | `src/data.js` 的 `ENEMY_ARCHETYPES`（記得設 `tier` 和 `w`） |
| 加新卡片 | `src/data.js` 的 `CARDS` + `src/engine.js` 的 `applyCard` |
| 加新事件 | `src/data.js` 的 `EVENTS`。效果型別看 `engine.js` 的 `applyEffects` |
| 加新永久升級 | `src/data.js` 的 `META_UPGRADES` + `engine.js` 的 `buildSquad` / `createGame` |
| 改敵方 AI | `src/engine.js` 的 `bestTarget` / `bestMove` / `actEnemy` |
| 改畫面 | `src/render.js`（canvas）或 `src/ui.js`（面板） |
| 改損傷階段門檻 | `src/assets.js` 的 `damageState`（目前 66% / 33%） |
| 改音樂／音效 | `src/audio.js`。`SFX` 是音效配方表，`MODES` 是四種 BGM 段落 |
| 改單位朝向 | `src/render.js` 的 `facingOf` |
| 換素材風格 | `codex/style-guide.md` 的 code block，然後全部重生 |

**加了新的節點類型或新畫面時，記得同步更新 `tools/simulate.mjs` 的機器人**，
否則模擬器會卡住（模擬器會回報「卡住的場次」）。

---

## 測試掛鉤

`src/main.js` 尾端掛在 window 上，供 Playwright 與手動除錯使用：

- `window.render_game_to_text()` — 整個遊戲狀態的 JSON
- `window.__game()` / `window.__meta()` — 直接拿到 state
- `window.game_actions.*` — 所有 UI 動作（`startRun` / `goNode` / `toHub` ...）
- `window.__debug.queueDraft(unitId)` / `window.__debug.finishRun(won)` — 把遊戲擺到特定狀態
- `window.__audio()` / `window.__assets()` — 音效與素材載入狀態
- `window.test_run_full_flow()` — 跑完一段核心流程

---

## 已知待辦

- 地板與棋盤背景還是程式畫的漸層，沒有接素材（刻意的：換掉會傷害格線可讀性，優先度低）
- `index.html` 裡的網址是 `tactics.atmarketing.tw` 佔位，部署前要確認
- 手機觸控可用但未針對小螢幕重新排版面板
- 尚未做戰鬥動畫（單位移動是瞬移，沒有補間）
- BGM 是程序合成的環境音，沒有記憶點強的主旋律

---

## 部署

純靜態，整個資料夾丟上去就能跑（需要 http，不能 file://）。

```bash
# Linode
scp -i ~/.ssh/linode_key -r index.html styles.css src assets \
  root@atmarketing.tw:/var/www/atmarketing.tw/htdocs/tactics/

# itch.io：把 index.html / styles.css / src / assets 打包成 zip 上傳，勾選「在瀏覽器中執行」
```

不需要 build。上線需要的檔案是 `index.html` / `styles.css` / `src/` / `assets/`，
`codex/` 與 `tools/` 是製作端的東西，不用上傳（但要留在版控裡）。

`node_modules` 與 `test-output` 已在 `.gitignore`。
