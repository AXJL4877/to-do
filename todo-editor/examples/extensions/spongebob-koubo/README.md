# 海绵宝宝口播 1.0.1

独立 ID：`studio.spongebob-koubo`。走生产成片管线：宿主分段、配音、分镜、生图；本包 `render.py` 把每个贴纸做成透明入场 WebM 和定格 PNG，入轨后可单独移动、缩放、旋转、改透明度。

## 安装

把 `deliverables/spongebob-koubo.todoext` 拖进 TO DO。安装不会开始生成，也不会改现有工程。需要本机 Python（Pillow）、FFmpeg。配音默认是成片同一条克隆音 `S_RksT6Z6g2`（声音复刻 2.0），不要选咪仔。生图仍用宿主已配置的服务。

## 和原管线的关系

原目录 `手绘风格/trial/koubo` 仍可 `python run_pipeline.py --all` 出整片。扩展不打包密钥、口播成片或 BGM。BGM 三段（Holding Court / 眠舸精卫降调 / Memories）留在原工程 `ref_bgm`，不放进安装包。

## 复现

```powershell
cd D:\Desktop\to_do\todo-editor
npm run extension:check -- examples/extensions/spongebob-koubo deliverables/spongebob-koubo-check.json deliverables/spongebob-koubo.todoext
```
