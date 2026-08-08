# Signal Breach 視覺風格指南

風格方向：**硬派軍事寫實科幻**（XCOM 2 / Into the Breach / Mechabellum 路線）。

底下第一個 code block 會被 `scripts/codex-generate.mjs` 自動抓出來，
接在每一張圖的 prompt 後面，所以它只放「全域美術方向」，
版面與構圖（幾列幾欄、長寬比）寫在各自的 entry prompt 裡。

```
Style: grounded military science-fiction, rendered as clean game-ready asset art. Strict top-down orthographic view seen from directly overhead with no perspective distortion and no vanishing point. Matte tactical armour made of brushed gunmetal, carbon-fibre panels and worn steel, with visible panel lines, rivets, scuffs and dirt weathering. Muted desaturated palette built on gunmetal grey #3A4750 and worn steel #6B7B8C; emissive accents are small and restrained, never flooding the form. Single cool key light from directly above with soft contact ambient occlusion, no rim glow bloom, no lens flare. Crisp readable silhouette with hard clean edges, high contrast against the background, sharp focus everywhere, no motion blur, no depth of field, no painterly brush texture. Background MUST be one flat uniform pure magenta #FF00FF field with absolutely nothing else on it: no gradient, no vignette, no grid lines, no panel borders, no drop shadow or cast shadow falling onto the magenta, no glow bleeding onto the magenta. Every subject must be fully separated from every other subject by clear empty magenta space. No text, no letters, no numbers, no labels, no captions, no watermark, no signature, no logo, no frame.
```

## 為什麼是這些規則

| 規則 | 原因 |
|---|---|
| 純洋紅 `#FF00FF` 背景 | 透過 codex CLI 沒辦法傳 `background: transparent` 參數，gpt-image-1 的透明成功率約 90%，剩下 10% 會毀掉整張。純洋紅去背是確定性的，且邊緣銳利。洋紅不會出現在軍事寫實的配色裡，不會誤刪到素材 |
| 不能有陰影落在背景上 | 陰影是半透明灰，去背時會留下髒邊 |
| 嚴格俯視、無透視 | 5x5 格子上單位會四處移動，斜角視圖在移動時透視會錯亂 |
| 發光要克制 | 螢幕上只有 66 到 130px，大面積發光會糊成一團光斑，剪影就沒了 |
| 主體之間要有空白 | 切圖器靠偵測非背景像素的邊界框來裁切，主體黏在一起會被判成同一塊 |
| 不要有文字 | gpt-image-1 的中文字只有 70-90% 正確率，而且切圖後也用不到 |

## 陣營配色

| 陣營 | 主色 | 用在哪 |
|---|---|---|
| 我方 | `#5DB6FF` 冷藍 | 面罩縫隙、肩部條紋、指示燈 |
| 敵方 | `#FF8678` 暖紅 | 光學感測器、腰側條紋、排氣口 |
| 頭目 | `#FF5F7A` 濃紅 | 同上，但面積略大以示階級 |

## 損傷三階段

| 狀態 | 觸發 | 視覺 |
|---|---|---|
| 完好 intact | HP > 66% | 裝甲完整、發光穩定 |
| 受損 damaged | HP 33-66% | 裝甲凹陷焦黑、肩甲裂開、細微冒煙 |
| 重創 critical | HP < 33% | 結構破裂、骨架外露、線路扯斷、火花與熾熱裂縫 |

同一列必須是**同一個單位**，只有損傷程度不同：裝甲設計、配色、裝備、剪影全部一致。
這是把三個狀態塞進同一次生成的理由 —— 分次生成必然漂移。
