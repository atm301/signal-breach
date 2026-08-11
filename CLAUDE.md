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
npm test               # Playwright 整合測試（35 項斷言 + console error 檢查）
npm run check          # sim + test + audio + tactics 一起跑
npm run check:tactics  # 戰術層 52 項：相剋／側背／區間／詞條／編隊／修整／上色
npm run shots          # 各畫面截圖到 test-output/shots/，要人眼看
npm run assets         # 重切素材表 + 重做 OG 圖
npm run assets:review  # 素材接觸表（深色底），檢查去背與損傷遞進
npm run check:audio    # 量各 BGM 段落實際輸出的 RMS，抓「有播但聽不到」
npm run check:pacing   # 量真實牆鐘時間與操作次數，抓「玩起來拖」
node tools/look-sheet.mjs   # 6 套外觀 x 3 屬性 x 3 損傷並排，人眼看變化夠不夠
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
  audio.js          Web Audio 即時合成的音效與 5 首 BGM。零音檔
  save.js           出擊存檔（跟 meta 分開：meta 是跨局進度，這裡是這一場打到哪）
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

- **智慧點擊**：點敵人就打、點空地就走、點自己人就換選。沒有移動／攻擊模式。
  移動範圍與可攻擊目標同時顯示。攻擊完（或走到沒 AP）會自動跳下一個單位。
  這是量出來的：切模式佔 13% 的點擊、選單位佔 25%，六成點擊不是決策而是操作稅。
- **AP 只用來移動。攻擊每回合限一次，且需保留 1 AP。**
  這條是刻意的，理由寫在 BALANCE.md 第 1 節。拿掉它戰鬥會退化成 2 回合互砍。
- **掩體**對距離 >= 2 的攻擊減傷 1。近戰不受掩體影響。
- **傷害是乘算鏈**：`(ATK − 掩體) × 相剋 × 側背 × 詞條`，再依穩定性展開成區間。
  全部集中在 `damageBreakdown()` 一個函式裡，而且它會把每一項都回傳 ——
  戰鬥預測卡靠這個把「為什麼是這個數字」攤給玩家看。
  **新增任何傷害修正都要走這裡並加進回傳值**，不然玩家看不到就等於學不會。
- **朝向是真的狀態**（`u.faceX` / `u.faceY`），不是視覺。移動與攻擊都會更新它，
  被攻擊會轉頭面向攻擊者（所以繞後的優勢用一次就沒了）。
  `render.js` 的 `facingOf()` **必須讀這兩個欄位**，畫出來的方向要跟判定用的是同一個。
- **每次出擊的三名幹員是現抽的**：5 名候補選 3，數值有浮動、固定一正一負詞條。
  `createGame` 一定會先自動選好前三名，所以模擬器與測試不經過選人畫面也拿得到合法小隊；
  互動選人只是改寫 `pending.recruit.picked`。
- **外觀走獨立亂數流 `lookRng`**。skin / look 不准抽在遊戲 `rng` 上 ——
  加一套素材就會把整條隨機序列往後推，平衡數字跟著失真但完全看不出原因。
- 畫面狀態機：`title` → `hub` → `map` → `battle` → `victory` → `map` ...，另有 `credits` / `event` / `shop` / `supply` / `result`。
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
5. 我方新外觀還要加進 `PLAYER_TEMPLATES` 的 `skins` 陣列才會被抽到

（`npm test` 的素材張數斷言已改成跟 `assets/manifest.json` 對數，不用再手動改。）

### 我方幹員的三個外觀軸

| 軸 | 怎麼來 | 影響 |
|---|---|---|
| skin | `PLAYER_TEMPLATES[].skins`，`lookRng` 抽 | 換整張素材（先鋒 A / 先鋒 B） |
| 屬性配色 | `assets.js` 的 `EL_TINT`，逐像素只換「青藍發光」 | 動能琥珀 / 電磁青藍 / 裝甲青綠 |
| 識別標記 | `render.js` 的 `drawIdentityMark`，由 `u.look` 決定 | 陣營環左側 1-4 段短弧 |

⚠️ **屬性配色不要用 `ctx.filter = 'hue-rotate()'`。** 那會把重創狀態的橘色火花一起轉成洋紅
（那是「這隻快死了」的通用訊號），而且 CSS hue-rotate 是矩陣近似，琥珀會轉成青綠。
現在的做法是逐像素判斷 `isCyanGlow()` 再換色，一個組合只算一次並快取。

⚠️ **識別標記畫在陣營環上，不要貼到素材身上。** 每套 skin 的肩膀位置都不一樣，
貼圖對不準會看起來像 bug；畫在環上永遠不會蓋到素材。

⚠️ codex 生圖吃 ChatGPT Plus 的 rate limit，不是固定張數。`codex/data/quota.json` 設 20/天，
同一週別再跑別的重活。

⚠️ `codex/images/` 是大張原始表（約 13MB），**不要刪**，重新切圖或改輸出尺寸都靠它。

## 存檔

兩份 localStorage，用途不同，不要搞混：

| key | 內容 | 什麼時候清 |
|---|---|---|
| `sft_meta_v1` | 跨局永久進度：核心碎片、升級、統計 | 只有玩家按「重置所有進度」 |
| `sft_run_v1` | 這一場出擊的完整狀態 | run 結束、放棄、開新出擊 |
| `sft_audio_v1` | 音樂／音效開關 | 不清 |

⚠️ **`newRun()` 裡絕對不能呼叫 `clearRun()`。** 開機時會叫一次 `newRun()` 當佔位，
在那裡清檔等於每次重新載入頁面都把存檔刪掉。清檔只放在真正「開新出擊」的 action 裡。

⚠️ 存檔存了 **RNG 的內部位置**（不只是 seed）。只存 seed 的話，讀檔後所有後續隨機會重跑一次，
地圖一樣但敵人配置全變 —— 那不是存檔，是重生。

## 常見改動怎麼下手

| 想做的事 | 改哪裡 |
|---|---|
| 調難度、改數值 | `src/data.js` 的 `TUNE`，然後跑 `npm run sim` |
| 加新敵人 | `src/data.js` 的 `ENEMY_ARCHETYPES`（記得設 `tier` 和 `w`） |
| 加新卡片 | `src/data.js` 的 `CARDS` + `src/engine.js` 的 `applyCard` |
| 加新事件 | `src/data.js` 的 `EVENTS`。效果型別看 `engine.js` 的 `applyEffects` |
| 加新永久升級 | `src/data.js` 的 `META_UPGRADES` + `engine.js` 的 `rollOperative` / `createGame` |
| 加新詞條 | `src/data.js` 的 `TRAITS`。純數值型寫 `stat(u)`；行為型要在 `damageBreakdown` 加分支並回報進 `traitMods` |
| 改相剋 / 側背倍率 | `src/data.js` 的 `TUNE`，然後**一定要重跑 `npm run sim:max`**（乘數會連動總傷害曲線） |
| 加戰後修整項目 | `src/engine.js` 的 `REPAIRS`。`scope: 'squad'` 記在 `pending.victory.bought`，`'unit'` 記在 `u.rep` |
| 改敵方 AI | `src/engine.js` 的 `bestTarget` / `bestMove` / `actEnemy` |
| 改畫面 | `src/render.js`（canvas）或 `src/ui.js`（面板） |
| 改損傷階段門檻 | `src/assets.js` 的 `damageState`（目前 66% / 33%） |
| 改音樂／音效 | `src/audio.js`。`SFX` 是音效配方表，`TRACKS` 是 5 首曲子，`MODES` 是段落強度 |
| 改作者的話 | `src/data.js` 的 `CREDITS` / `CREDITS_META` |
| 改存檔格式 | `src/save.js`。改結構要同步升 `VERSION`，舊存檔會自動作廢 |
| 改單位朝向 | `src/engine.js` 的 `faceToward`（機制）。`render.js` 的 `facingOf` 只是把它畫出來，不要在那裡自己算 |
| 改敵方回合速度 | `src/main.js` 的 `AI_MOVE_MS` / `AI_ATTACK_MS`，然後跑 `npm run check:pacing` |
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

⚠️ **`window.advanceTime()` 只跑 `update` + `draw`（canvas），不會重建 DOM 面板。**
面板是 `ui.render` 在真正的 requestAnimationFrame 裡重建的，所以測試改完 state 之後
要讀面板 HTML 一律先 `page.waitForFunction(() => document.querySelector('...'))`。
不等就會偶發讀到上一幀 —— 這個坑在 `check-tactics` 已經踩過三次（編隊面板、預測表、勝利面板）。

⚠️ 打死人會冒出升級抽卡，**抽卡沒選完棋盤是鎖住的**（`tapBoard` 回「請先完成升級抽卡」）。
測試裡連續操作棋盤前要先把 `pending.draft` 清掉。

---

## 已知待辦

- 地板與棋盤背景還是程式畫的漸層，沒有接素材（刻意的：換掉會傷害格線可讀性，優先度低）
- `index.html` 裡的網址是 `tactics.atmarketing.tw` 佔位，部署前要確認
- 手機觸控可用但未針對小螢幕重新排版面板（`.forecast` 目標表就是為了補手機沒有 hover 而做的）
- 單位移動仍是瞬移，沒有補間；出手演出只有原地前撲／後座／後仰（刻意：一場才 4 回合，切鏡頭會把節奏吃光）
- 作者的話的文案是 AI 代筆的初稿，等作者本人改
- BGM 是程序合成的環境音，沒有記憶點強的主旋律
- 敵人沒有隨機詞條，只有我方幹員有（刻意：敵人長太多樣會拖慢判讀）
- 真正的零件疊層 paper-doll 沒做。俯視角下配件必須貼合 3D 造型，每套 skin 的肩膀位置不同，
  要做的話得走「一張 sheet 含所有零件 + 每槽固定錨點 + 損傷用共用貼花疊層」
- 一場 12 層是否該縮到 10 層還沒定案（實測：10 層是 5.2 場戰鬥，12 層是 6.0 場，
  最高通關率 51.7%，不需要重調平衡）

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
