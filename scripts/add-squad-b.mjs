// 一次性腳本：把「我方小隊素材表 B」加進 codex/data/items.json。
//
// 幹員現在是隨機生成的，三個原型各只有一張圖 = 每次出擊看起來都一樣。
// 變體 B 保留每個原型的剪影線索（先鋒厚肩甲、狙擊長槍管、工兵背包工具臂），
// 只換裝甲樣式與配件 —— 玩家還是一眼看得出誰是誰，但畫面不再重複。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, 'codex', 'data', 'items.json');
const data = JSON.parse(fs.readFileSync(FILE, 'utf-8'));

const ID = 'sheet-player-squad-b';
if (data.items.some((i) => i.id === ID)) {
  console.log('已存在，不重複加入');
  process.exit(0);
}

const prompt = [
  'A square 1:1 game asset sheet containing exactly 9 top-down military science-fiction infantry tokens,',
  'laid out in a clean 3 by 3 grid: 3 rows and 3 columns, with equal generous flat magenta gaps between every subject.',
  'No subject may touch, overlap or cast anything onto another.',
  'All 9 subjects are drawn at exactly the same scale, each one centred in its own invisible cell,',
  'each with a compact footprint that would fit inside a circle.',
  'Every figure is seen from STRAIGHT OVERHEAD: you see the top of the helmet, the tops of the shoulders',
  'and the weapon foreshortened flat against the body.',
  'Within each row the armour design, the colour scheme, the equipment and the silhouette are IDENTICAL',
  '- it is the exact same soldier three times - and ONLY the battle damage changes across the columns.',
  'Column 1 (left) = pristine, undamaged, fully intact armour.',
  'Column 2 (middle) = moderately damaged: armour plates dented and scorched black, one shoulder plate cracked open, a thin wisp of smoke.',
  'Column 3 (right) = critically damaged: armour shattered open, internal structural frame exposed,',
  'torn cabling hanging loose, sparks and glowing orange hot fractures.',
  'ROW 1 is a VANGUARD BREACHER assault trooper: bulky heavy frontline exosuit with a rounded riot-shield plate',
  'bolted onto the left shoulder, very thick angular pauldrons, a stubby drum-fed shotgun held across the chest,',
  'a wide horizontal cyan-blue glowing visor band across the helmet and cyan-blue trim on the shield plate.',
  'ROW 2 is a SNIPER SPOTTER marksman: slim lightweight low-profile recon suit,',
  'a long-barrelled precision rifle with a folded bipod extending forward past the head,',
  'a flat rectangular sensor plate mounted on the back instead of a cloak, and twin small cyan-blue glowing optic lenses.',
  'ROW 3 is an ENGINEER DRONE-HANDLER support trooper: medium-weight suit with a bulky cylindrical backpack canister',
  'and a folded launch rail, a compact submachine gun in one hand and a heavy clamp manipulator on the other side,',
  'a ring of small cyan-blue indicator lights around the canister.',
].join(' ');

data.items.push({
  id: ID,
  name: '我方小隊素材表 B（隨機幹員變體）',
  rows: 3,
  cols: 3,
  cells: [
    ['vanguardB-intact', 'vanguardB-damaged', 'vanguardB-critical'],
    ['sniperB-intact', 'sniperB-damaged', 'sniperB-critical'],
    ['engineerB-intact', 'engineerB-damaged', 'engineerB-critical'],
  ],
  prompt,
});

fs.writeFileSync(FILE, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
console.log(`已加入 ${ID}`);
