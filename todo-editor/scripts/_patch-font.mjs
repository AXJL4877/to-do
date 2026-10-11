/**
 * 把「字魂剑气手书」收进 TODO（扩展包内），并把字体解析顺序改成**包内优先**。
 *
 * 背景（用户指出的架构原则）：依赖不能东一块西一块。现在 typo.py 里
 *   _TITLE_ZIHUN = Path(r"D:\Desktop\TTF\字魂剑气手书(商用需授权).ttf")
 * 直接指向桌面——换台机器就丢字体。而 AmezumiGothic 本来就在包里却只是后备。
 *
 * 改法：包内 fonts/ 里放一份字魂，解析顺序 = 包内 → 机器路径（兜底） → 包内后备字体。
 * 这样：① 不依赖桌面目录 ② 老机器上仍能用（兜底不删） ③ 缺字仍由后备字体补（已有链式逻辑）。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const SRC = 'D:\\Desktop\\TTF\\字魂剑气手书(商用需授权).ttf'
const NAME = '字魂剑气手书(商用需授权).ttf'

const packs = [
  'examples/extensions/spongebob-koubo/workflow/kit/kit',
  path.join(process.env.APPDATA || '', 'todo-editor', 'data', 'skills', 'studio.spongebob-koubo', 'workflow', 'kit', 'kit'),
]

if (!existsSync(SRC)) { console.error(`✗ 找不到源字体：${SRC}`); process.exit(1) }
console.log(`源字体 ${(statSync(SRC).size / 1024 / 1024).toFixed(1)} MB`)

for (const pack of packs) {
  if (!existsSync(pack)) { console.log(`- 跳过（不存在）：${pack}`); continue }
  const fontsDir = path.join(path.dirname(pack), 'fonts')
  mkdirSync(fontsDir, { recursive: true })
  const dest = path.join(fontsDir, NAME)
  copyFileSync(SRC, dest)
  console.log(`✓ 已收进包内 ${dest}  ${(statSync(dest).size / 1024 / 1024).toFixed(1)} MB`)

  // 改 typo.py：包内优先
  const typo = path.join(pack, 'typo.py')
  if (!existsSync(typo)) { console.log(`  ⚠ 没有 typo.py：${typo}`); continue }
  let t = readFileSync(typo, 'utf8')
  const oldBlock = `# 字魂剑气手书：用户指定用于开场红字。机器上没装就退回包内 AmezumiGothic。
_TITLE_ZIHUN = Path(r"D:\\Desktop\\TTF\\字魂剑气手书(商用需授权).ttf")
_TITLE_AMEZUMI = FONTS / "AmezumiGothic.ttf"
_TITLE_PREFS = (_TITLE_ZIHUN, _TITLE_AMEZUMI)`
  const newBlock = `# 字魂剑气手书：用户指定用于开场红字。
# **包内优先**（依赖收进 TODO，不依赖桌面目录）；机器路径只作兜底，
# 这样换机器/别人拿到扩展包也能出同样的字，而老机器上依然可用。
_TITLE_ZIHUN_BUNDLED = FONTS / "字魂剑气手书(商用需授权).ttf"
_TITLE_ZIHUN_AMBIENT = Path(r"D:\\Desktop\\TTF\\字魂剑气手书(商用需授权).ttf")
_TITLE_AMEZUMI = FONTS / "AmezumiGothic.ttf"
_TITLE_PREFS = (_TITLE_ZIHUN_BUNDLED, _TITLE_ZIHUN_AMBIENT, _TITLE_AMEZUMI)`
  if (t.includes(oldBlock)) {
    t = t.replace(oldBlock, newBlock)
    writeFileSync(typo, t)
    console.log(`  ✓ ${typo} 已改成包内优先`)
  } else if (t.includes('_TITLE_ZIHUN_BUNDLED')) {
    console.log(`  - typo.py 已是包内优先`)
  } else {
    console.log(`  ⚠ typo.py 锚点未命中（可能已被改过），需要人工确认`)
  }
}
