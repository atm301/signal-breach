#!/bin/bash
# 智慧批次·自動掃所有 image=null 的項目並依序生圖
# 用法（在專案根目錄）：bash scripts/batch-pending.sh
# 退出碼：
#   0 = 全部都已生（沒有 pending）
#   2 = 部分失敗·還有 pending（給下次 retry 用）

set -e
cd "$(dirname "$0")/.."

# 列出所有 image=null 的項目（格式: kind\tid）
# 容忍缺檔（characters/scenes/items 任一不存在不報錯）
PENDING=$(node -e '
const fs = require("fs");
const path = require("path");
const tryRead = (rel) => {
  const p = path.resolve(rel);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf-8")) : null;
};
const list = [];

const c = tryRead("./codex/data/characters.json");
if (c) {
  const all = [...(c.summon || []), ...(c.apocalypse || []), ...(c.list || []), ...(c.characters || [])];
  all.forEach(x => { if (!x.image) list.push(["character", x.id]); });
}

const s = tryRead("./codex/data/scenes.json");
if (s) s.scenes?.forEach(x => { if (!x.image) list.push(["scene", x.id]); });

const i = tryRead("./codex/data/items.json");
if (i) i.items?.forEach(x => { if (!x.image) list.push(["item", x.id]); });

const v = tryRead("./codex/data/covers.json");
if (v) v.covers?.forEach(x => { if (!x.image) list.push(["cover", x.id]); });

const m = tryRead("./codex/data/comics.json");
if (m) Object.keys(m).filter(k => k !== "_meta").forEach(k => {
  m[k].panels?.forEach(p => { if (!p.image) list.push(["panel", p.id]); });
});

list.forEach(([k, id]) => console.log(k + "\t" + id));
')

if [ -z "$PENDING" ]; then
  echo "🎉 沒有 pending·全部都已生圖"
  exit 0
fi

COUNT=$(echo "$PENDING" | wc -l | tr -d ' ')
echo "📋 待生 $COUNT 項："
echo "$PENDING" | sed 's/^/   /'
echo ""

# 把 PENDING 寫進 temp file·避免 pipe subshell + stdin 被 node 吃光
TMP_LIST=$(mktemp)
echo "$PENDING" > "$TMP_LIST"

while IFS=$'\t' read -r kind id; do
  [ -z "$kind" ] && continue
  echo ""
  echo "========================================="
  echo "▶ 生成：$kind / $id · $(date +%H:%M:%S)"
  echo "========================================="
  if node scripts/codex-generate.mjs "$kind" "$id" < /dev/null; then
    echo "✅ 完成：$kind / $id · $(date +%H:%M:%S)"
  else
    echo "❌ 失敗：$kind / $id · $(date +%H:%M:%S)"
    echo "停止·留待下次 retry"
    rm -f "$TMP_LIST"
    exit 2
  fi
  sleep 35  # min_interval 30 秒 + 緩衝
done < "$TMP_LIST"
rm -f "$TMP_LIST"

# 重新檢查是否還有 pending
STILL_PENDING=$(node -e '
const fs = require("fs");
const tryRead = (p) => fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf-8")) : null;
let n = 0;
const c = tryRead("./codex/data/characters.json");
if (c) {
  const all = [...(c.summon || []), ...(c.apocalypse || []), ...(c.list || []), ...(c.characters || [])];
  n += all.filter(x => !x.image).length;
}
const s = tryRead("./codex/data/scenes.json");
if (s) n += (s.scenes || []).filter(x => !x.image).length;
const i = tryRead("./codex/data/items.json");
if (i) n += (i.items || []).filter(x => !x.image).length;
const v = tryRead("./codex/data/covers.json");
if (v) n += (v.covers || []).filter(x => !x.image).length;
const m = tryRead("./codex/data/comics.json");
if (m) Object.keys(m).filter(k => k !== "_meta").forEach(k => {
  n += (m[k].panels || []).filter(p => !p.image).length;
});
console.log(n);
')

echo ""
if [ "$STILL_PENDING" = "0" ]; then
  echo "🎉 全部已生圖完成"
  exit 0
else
  echo "⚠️  還剩 $STILL_PENDING 項·下次再試"
  exit 2
fi
