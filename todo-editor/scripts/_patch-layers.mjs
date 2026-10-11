/**
 * layers_export.py 三处修改（同时打到「已安装的包」与「仓库里的 examples 包」）：
 *   1) 场景元素记住自己的 enter_at（绝对秒→ms）
 *   2) _stitch_boards 按 enter_at 错开进场（原来无条件 =start，把渐进出现拍平了）
 *   3) 泡泡遮罩层挂上包内 bubble_wipe.wav（宿主会落到独立音轨）
 * 锚点不命中即硬失败。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const targets = [
  path.join(process.env.APPDATA || '', 'todo-editor', 'data', 'skills', 'studio.spongebob-koubo', 'workflow', 'kit', 'kit', 'layers_export.py'),
  'examples/extensions/spongebob-koubo/workflow/kit/kit/layers_export.py',
]

const EDITS = [
  {
    name: 'stitch-stagger',
    old: `            el["startMs"] = start
            el["durationMs"] = dur`,
    new: `            # 元素按**口播时刻**错开进场（原管线 _starts/enter_at 的语义）。
            # 这里以前无条件写 el["startMs"] = start，把每层的进场时刻拍平成"同时出现"——
            # 于是时间轴上看不到"元素一个接一个出现"，观感与原成片不一致。
            rel = int(el.get("enterAtMs") or 0) - start
            rel = max(0, min(rel, max(0, dur - 200)))
            el["startMs"] = start + rel
            el["durationMs"] = max(200, end - el["startMs"])`,
  },
  {
    name: 'remember-enter-at',
    old: `                    el = _cut_layer(name, meta["box"], dest, f"{stem_base}_e{li}_{name}"[:48], enter_frames, fx)
                    if el:
                        elements.append(el)`,
    new: `                    el = _cut_layer(name, meta["box"], dest, f"{stem_base}_e{li}_{name}"[:48], enter_frames, fx)
                    if el:
                        # 记住这一层的口播进场时刻，_stitch_boards 会把它落成绝对起点
                        ea = raw.get("enter_at")
                        if ea is not None:
                            try:
                                el["enterAtMs"] = int(round(float(ea) * 1000))
                            except (TypeError, ValueError):
                                pass
                        elements.append(el)`,
  },
  {
    name: 'wipe-sfx',
    old: `                if wipe:
                    wipe["startMs"] = start_ms
                    wipe["durationMs"] = 2000
                    elements.append(wipe)`,
    new: `                if wipe:
                    wipe["startMs"] = start_ms
                    wipe["durationMs"] = 2000
                    # 泡泡遮罩的音效：从**包内**素材复制进 layers/ 并挂到该元素上；
                    # 宿主 bindLayerBoards 会把它收进产物目录并落到独立音轨。
                    try:
                        _fx = Path(__file__).resolve().parent.parent / "assets" / "fx" / "bubble_wipe.wav"
                        if _fx.is_file():
                            _dst = dest / "bubble_wipe.wav"
                            if not _dst.exists():
                                import shutil as _shutil
                                _shutil.copyfile(_fx, _dst)
                            wipe["sfx"] = "bubble_wipe.wav"
                        else:
                            print("wipe sfx missing in pack:", _fx, flush=True)
                    except Exception as _e:
                        print("wipe sfx skip", _e, flush=True)
                    elements.append(wipe)`,
  },
]

for (const file of targets) {
  if (!existsSync(file)) { console.log(`- 跳过（不存在）：${file}`); continue }
  let t = readFileSync(file, 'utf8')
  if (t.includes('enterAtMs')) { console.log(`- 已改过：${path.basename(path.dirname(path.dirname(file)))}`); continue }
  let ok = true
  for (const e of EDITS) {
    if (!t.includes(e.old)) { console.error(`✗ ${file} :: 锚点未命中 [${e.name}]`); ok = false; break }
    t = t.replace(e.old, e.new)
    console.log(`  ✓ ${e.name}`)
  }
  if (ok) { writeFileSync(file, t); console.log(`✓ 已写入 ${file}`) }
}
