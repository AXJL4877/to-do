# 配音技能包协议 v1（`builtin.tts-voice`）

口播文案 → 配音 wav + 逐字时间戳。走 `tts` 管线：没有渲染端（`skill.json` 里没有 `runtime`），宿主只调用 TTS_timeline。产出供 [`builtin.voice-subtitle`](../voice-subtitle/PROTOCOL.md) 生成字幕。

## 1. 调用

```json
{
  "kind": "skill",
  "skillId": "builtin.tts-voice",
  "prompt": "复利靠的不是高收益，而是时间。\n越早开始，越轻松。",
  "params": { "voice": "clone", "cloneId": "S_xxxxxxxx" },
  "autoTimeline": true
}
```

- `prompt` 必填，最多 5000 字。换行保留（分段有助于 TTS 断句），其余空白压成一个空格；纯标点会被拒绝。

CLI：`npm run skill -- start --skill builtin.tts-voice --prompt "……" --set voice=clone --set cloneId=S_xxxxxxxx`

## 2. 可调参数

| 分组 | id | 类型 | 取值 | 默认 | 说明 |
|---|---|---|---|---|---|
| 音色 | `voice` | select | `mizai` `clone` | mizai | 咪仔 / 克隆音 |
| 音色 | `cloneId` | text | `^S_[A-Za-z0-9_-]{2,60}$`，最多 64 字 | 空 | 仅 `voice=clone` 时显示并校验；火山声音复刻得到的音色 ID |

音色映射（宿主传给 TTS_timeline 的 `--speaker` / `--resource-id`）：

| voice | speaker | resource-id |
|---|---|---|
| `mizai` | `zh_female_mizai_uranus_bigtts` | `seed-tts-2.0` |
| `clone` | `cloneId` | `seed-icl-2.0` |

两种都开逐字时间戳，字幕靠它对时。编辑器记住上次选的音色和克隆 ID（本机 localStorage）。

`text` 是 `todo-skill-pack/1` 新增的参数类型：`{ id, type: "text", group, label, hint?, when?, default, pattern, maxLength (1~200), placeholder? }`。值须为字符串，去首尾空白后截到 `maxLength`；参数可见时（满足 `when`）必须匹配 `pattern`。

## 3. 执行

只调用内嵌 `todo-editor/vendor/tts-timeline/run.py synth --text-file … --out <它的 outputs>\todo_<jobId> --speaker … --resource-id …`（可用环境变量 `TTS_TIMELINE_ROOT` 覆盖）。产物拷成 `<jobId>_voice.wav` / `<jobId>_timing.json` 后只删这一个作业目录。密钥由内嵌 `vendor/mishi/.env`（火山）读取，宿主不自带 TTS 客户端。

重试时两个文件都在就不重新合成（不重复扣费）。

## 4. 输出清单

| 字段 | 说明 |
|---|---|
| `audio` | 配音 wav 的 URL，任务的 `resultKind` 为 `audio` |
| `duration` | 配音时长（秒） |
| `narration` | `{ text, duration, speaker, audio, timing }`；`timing` 为 TTS_timeline 原样的句 / 短语 / 字三级时间戳 |

## 5. 进时间轴

配音 wav 进媒体库 AI 文件夹。勾选「自动入轨」或点任务卡上的「+」时，放到播放头处的空闲音频轨。之后可以随意拖动、裁剪。

字幕不在配音面板里做：在时间轴选中配音片段（可多选），右键「烧录字幕」，见字幕协议第 5 节。文件名 `<jobId>_voice.wav` 就是片段和配音任务之间的对应关系，不要改。
