/**
 * 扩展包自包含：把还依赖 C:\Windows\Fonts 的字体也收进包内，并让代码**只认包内**。
 *
 * 原则（用户定）：每个扩展包的准则是「一切都在包中发生，不依赖外部素材或工具」。
 * 现在包里已有 字魂剑气手书 / AmezumiGothic / FZCuHeiSongS-B-GB，
 * 但 typo.py 的 CARD_FONT、SUB_FONT 与 bubble.py 的 FONT 还指向 C:\Windows\Fonts：
 *   CARD_FONT = Source Han Serif SC Heavy   → OFL 可分发，收进包内
 *   SUB_FONT  = msyhbd.ttc（微软雅黑）      → **授权上不能随包分发**，改用 Noto Sans SC Bold（OFL）
 *   bubble.FONT = msyhbd.ttc                → 同上
 * 机器路径保留为最后兜底（老机器仍可用），但**包内优先**，且缺失时给出可操作的报错。
 */
import { copyFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const WIN_FONTS = 'C:\\Windows\\Fonts'
const COPIES = [
  ['Source Han Serif SC Heavy (TrueType).ttf', 'Source Han Serif SC Heavy (TrueType).ttf'],
  ['Noto Sans SC Bold (TrueType).otf', 'Noto Sans SC Bold (TrueType).otf'],
]

const packs = [
  'examples/extensions/spongebob-koubo/workflow/kit/kit',
  path.join(process.env.APPDATA || '', 'todo-editor', 'data', 'skills', 'studio.spongebob-koubo', 'workflow', 'kit', 'kit'),
]

for (const pack of packs) {
  if (!existsSync(pack)) { console.log(`- 跳过（不存在）：${pack}`); continue }
  const fontsDir = path.join(path.dirname(pack), 'fonts')
  for (const [src, dest] of COPIES) {
    const s = path.join(WIN_FONTS, src)
    const d = path.join(fontsDir, dest)
    if (!existsSync(s)) { console.log(`  ⚠ 机器上没有 ${src}（跳过）`); continue }
    if (existsSync(d)) { console.log(`  - 已在包内 ${dest}`); continue }
    copyFileSync(s, d)
    console.log(`  ✓ 收录 ${dest}  ${(statSync(d).size / 1024 / 1024).toFixed(1)} MB`)
  }

  // typo.py：包内优先
  const typo = path.join(pack, 'typo.py')
  if (existsSync(typo)) {
    let t = readFileSync(typo, 'utf8')
    const before = t
    t = t.replace(
      /_HAN_SERIF = Path\(r"C:\\Windows\\Fonts\\Source Han Serif SC Heavy \(TrueType\)\.ttf"\)\nCARD_FONT = _HAN_SERIF if _HAN_SERIF\.exists\(\) else FONTS \/ "FZCuHeiSongS-B-GB\.ttf"\nSUB_FONT = Path\(r"C:\\Windows\\Fonts\\msyhbd\.ttc"\)/,
      `# 包内优先（自包含原则）：扩展包不依赖 C:\\Windows\\Fonts，机器路径只作兜底。\n`
      + `_HAN_SERIF_BUNDLED = FONTS / "Source Han Serif SC Heavy (TrueType).ttf"   # OFL，可随包分发\n`
      + `_HAN_SERIF_AMBIENT = Path(r"C:\\Windows\\Fonts\\Source Han Serif SC Heavy (TrueType).ttf")\n`
      + `CARD_FONT = (_HAN_SERIF_BUNDLED if _HAN_SERIF_BUNDLED.exists()\n`
      + `             else _HAN_SERIF_AMBIENT if _HAN_SERIF_AMBIENT.exists()\n`
      + `             else FONTS / "FZCuHeiSongS-B-GB.ttf")\n`
      + `# 字幕字体：微软雅黑（msyhbd.ttc）授权上不能随包分发，改用包内 Noto Sans SC Bold（OFL）。\n`
      + `_SUB_BUNDLED = FONTS / "Noto Sans SC Bold (TrueType).otf"\n`
      + `SUB_FONT = _SUB_BUNDLED if _SUB_BUNDLED.exists() else Path(r"C:\\Windows\\Fonts\\msyhbd.ttc")`,
    )
    if (t !== before) { writeFileSync(typo, t); console.log('  ✓ typo.py 已改为包内优先（CARD_FONT / SUB_FONT）') }
    else console.log('  - typo.py 无需改（或已改过）')
  }

  // bubble.py：包内优先
  const bubble = path.join(pack, 'bubble.py')
  if (existsSync(bubble)) {
    let b = readFileSync(bubble, 'utf8')
    const before = b
    b = b.replace(
      /FONT = Path\(r"C:\\Windows\\Fonts\\msyhbd\.ttc"\)/,
      `# 包内优先（自包含）：气泡文字不依赖系统字体；机器路径只作兜底。\n`
      + `_FONT_BUNDLED = Path(__file__).resolve().parent.parent / "fonts" / "Noto Sans SC Bold (TrueType).otf"\n`
      + `FONT = _FONT_BUNDLED if _FONT_BUNDLED.exists() else Path(r"C:\\Windows\\Fonts\\msyhbd.ttc")`,
    )
    if (b !== before) { writeFileSync(bubble, b); console.log('  ✓ bubble.py 已改为包内优先') }
    else console.log('  - bubble.py 无需改（或已改过）')
  }
}
