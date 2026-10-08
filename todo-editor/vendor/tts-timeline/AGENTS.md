# TTS_timeline — Agent 硬锁

> 工具根目录：`d:\video_Tools\TTS_timeline`  
> 标准：对齐 `d:\video_Tools\MODULE_STANDARD.md`  
> 配音密钥仍只在 `d:\Desktop\密匙\.env`（经密匙调用，禁止复制 Key）。

## 定位

配音 + 多级时间戳。本模块是**独立工具**；`audio.wav` / `timing.json` 写在**本模块** `outputs/<作业>/`，禁止写进文稿模块或其它工具目录。

## 唯一入口

```bat
python d:\video_Tools\TTS_timeline\run.py synth --text-file d:\video_Tools\文稿模块\outputs\马太效应.md --out d:\video_Tools\TTS_timeline\outputs\马太效应
python d:\video_Tools\TTS_timeline\run.py synth --text "旁白" --out d:\video_Tools\TTS_timeline\outputs\<作业>
python d:\video_Tools\TTS_timeline\run.py clean
```

stdout：**仅一行 JSON**（`ok` / `audio` / `timing` / `duration` …）。

## 硬锁

1. **禁止**在业务项目新建 TTS / 时间戳脚本或 HTTP 客户端。
2. **`--out` 必须在本模块 `outputs/` 下**；产物：`audio.wav` + `timing.json`。
3. 成功后**不**删除同级其它作业；`clean` 才清空 `outputs/`。
4. 特殊字符（如 `*`）经 sanitize + 火山 markdown 过滤，勿绕过本入口直调密匙若需要三级 timing。
5. timing.json 必须含 **sentences / phrases / chars** 三级。

## 烟测

```bat
python d:\video_Tools\TTS_timeline\run.py synth --text "你好。" --out d:\video_Tools\TTS_timeline\outputs\_smoke
python d:\video_Tools\TTS_timeline\run.py clean
```
