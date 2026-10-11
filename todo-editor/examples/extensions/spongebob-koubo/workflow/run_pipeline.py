"""口播独立管线：试听 → LLM镜头设计(+重试) → 生图(+重试) → 渲染 → BGM → 硬验收 → 可选关机。

不依赖 Agent。示例：
  python run_pipeline.py --all
  python run_pipeline.py --all --script path\\口播.txt
  python run_pipeline.py --design --assets --render --bgm --accept --shutdown
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
py = sys.executable
sys.path.insert(0, str(ROOT))
import paths


def _run(cmd: list, *, check: bool = True) -> int:
    print("+", " ".join(str(c) for c in cmd), flush=True)
    p = subprocess.run(cmd)
    if check and p.returncode != 0:
        raise SystemExit(p.returncode)
    return p.returncode


def _run_with_retry(
    cmd: list,
    *,
    stage: str,
    retries: int,
    check: bool = True,
    retry_cmd: list | None = None,
) -> tuple[int, float]:
    """阶段级自动重试：小故障不卡死。retry_cmd：第 2 次起改跑的命令（如只补缺）。"""
    attempts = max(1, int(retries) + 1)
    t0 = time.time()
    rc = 1
    for i in range(attempts):
        print(f"[{stage}] attempt {i + 1}/{attempts}", flush=True)
        rc = _run(cmd if i == 0 or retry_cmd is None else retry_cmd, check=False)
        if rc == 0 or rc == 2:
            break
        if i + 1 < attempts:
            wait = min(30, 3 * (i + 1))
            print(f"[{stage}] rc={rc} retry in {wait}s", flush=True)
            time.sleep(wait)
    elapsed = time.time() - t0
    if check and rc != 0:
        raise SystemExit(rc)
    return rc, elapsed


def _maybe_copy_script(script: Path | None) -> None:
    if not script:
        return
    script = Path(script)
    if not script.is_file():
        raise SystemExit(f"口播不存在: {script}")
    paths.ensure()
    dest = paths.TTS_SCRIPT
    if script.resolve() != dest.resolve():
        shutil.copy2(script, dest)
        print("script →", dest)


def _write_timing(stages: dict, t0: float, *, end_to_end: bool = False) -> Path:
    paths.ensure()
    payload = {
        "total_sec": round(time.time() - t0, 3),
        "stages": stages,
        "ts": time.time(),
        "end_to_end": bool(end_to_end),
        "reconciled": False,
    }
    out = paths.RENDER_OUT / "pipeline_timing.json"
    out.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(
        "pipeline_timing",
        out,
        "total_sec",
        payload["total_sec"],
        "end_to_end",
        payload["end_to_end"],
        flush=True,
    )
    return out


def _guard_partial_run(args) -> None:
    """拦住"只重跑前半段"，因为它会让设计文档与已有产物**对不上**。

    真实踩到的坑（排查耗时用的）：对一份已经出过成片的目录单独跑 `--design`，
    `run_design` 会重新生成并**冻结** briefs，而 `kit_assets/cut` 与 `成片.mp4`/`layers/`
    还是上一版设计留下的。结果：
      · `pipeline_timing.json` 被这次"只有 design 阶段"的运行覆盖 → 各阶段耗时全丢
      · 设计里的资产名与磁盘上的 cut 对不上 → g1/g5 等门开始报"空层"
      · 而成片和分层明明还在，看起来却像坏了
    这类损坏**不可逆**（旧设计没留副本），只能整条重跑。

    所以：目录里已经有终态产物（成片/layers_manifest）时，拒绝只跑部分阶段；
    确实需要就显式加 `--allow-partial`（比如在一次性沙箱目录里做实验）。
    """
    if getattr(args, "allow_partial", False):
        return
    stages = [n for n, on in (
        ("clean", args.clean), ("tts", args.tts), ("design", args.design),
        ("assets", args.assets), ("render", args.render), ("bgm", args.bgm),
    ) if on]
    full = bool(args.all)
    if full or not stages:
        return
    out = paths.RENDER / "output"
    has_final = (out / "成片.mp4").is_file() or (out / "layers_manifest.json").is_file()
    has_design = (paths.DESIGN / "briefs_locked.json").is_file() or (paths.DESIGN / "plan.json").is_file()
    if has_final and has_design:
        print(
            "REFUSE: 这个工作目录已经有终态产物（成片/分层清单）和已冻结的设计。\n"
            f"  本次只请求了部分阶段：{stages}\n"
            "  只跑部分阶段会让「设计文档」与「磁盘上那批 cut/成片」不再对应，\n"
            "  并且会覆盖 pipeline_timing.json，且这种不一致不可逆。\n"
            "  想整条重跑：去掉阶段参数，直接用 --all --skip-clean\n"
            "  确实要在原地做部分实验：加 --allow-partial（后果自负，建议先备份该目录）\n",
            flush=True,
        )
        raise SystemExit(3)


def _final_product_ok() -> tuple[bool, str]:
    """成片是否真的产出了——这是"生成成功与否"的唯一判据，与质量门分开。"""
    film = paths.RENDER / "output" / "成片.mp4"
    if not film.is_file():
        return False, f"缺 {film}"
    size_mb = film.stat().st_size / 1048576
    if size_mb < 0.2:
        return False, f"成片过小 {size_mb:.2f}MB"
    return True, f"成片.mp4 {size_mb:.2f}MB"


def _write_gate_status(rc: int, final_ok: bool, final_detail: str) -> None:
    """把「产物成功」与「质量门结果」一起写下来，便于宿主/人区分这两件事。"""
    out = paths.RENDER / "output" / "gate_status.json"
    summary = paths.RENDER / "output" / "accept_gates" / "summary.json"
    gates_ok = None
    try:
        gates_ok = bool(json.loads(summary.read_text(encoding="utf-8")).get("ok"))
    except (OSError, ValueError):
        pass
    payload = {
        "product_ok": final_ok,
        "product": final_detail,
        "gates_ok": gates_ok,
        "gates_rc": rc,
        "note": "产物已产出即视为生成成功；质量门未过只作告警，不否决入轨",
        "ts": time.time(),
    }
    try:
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    except OSError as e:
        print(f"WARN: 写 gate_status 失败 {e}", flush=True)


def main():
    ap = argparse.ArgumentParser(description="海绵宝宝口播独立管线")
    ap.add_argument("--all", action="store_true", help="clean+tts+design+assets+render+bgm+accept+shutdown")
    ap.add_argument("--clean", action="store_true", help="清本片产物防串台")
    ap.add_argument("--tts", action="store_true")
    ap.add_argument("--design", action="store_true")
    ap.add_argument("--assets", action="store_true")
    ap.add_argument("--render", action="store_true")
    ap.add_argument("--bgm", action="store_true", help="按 bgm_plan 叠 BGM")
    ap.add_argument("--accept", action="store_true", help="硬验收门+基础验收")
    ap.add_argument("--script", type=Path, default=None, help="覆盖写入 01/口播.txt")
    ap.add_argument("--seed", type=int, default=None)
    ap.add_argument("--rules-only", action="store_true", help="镜头设计不用 LLM")
    ap.add_argument("--design-attempts", type=int, default=3)
    ap.add_argument("--stage-retries", type=int, default=2, help="每阶段失败额外重试次数")
    ap.add_argument("--skip-clean", action="store_true", help="--all 时跳过清理")
    ap.add_argument("--missing-only", action="store_true", help="素材只补缺")
    ap.add_argument("--shutdown", action="store_true", help="验收通过后关机")
    ap.add_argument("--no-shutdown", action="store_true", help="禁止关机")
    ap.add_argument(
        "--allow-partial",
        action="store_true",
        help="允许在已有终态产物的目录里只跑部分阶段（会破坏设计/产物一致性，仅限一次性沙箱）",
    )
    ap.add_argument("--shutdown-delay", type=int, default=90)
    args = ap.parse_args()

    if args.all:
        if not args.skip_clean:
            args.clean = True
        args.tts = True
        args.design = True
        args.assets = True
        args.render = True
        args.bgm = True
        args.accept = True
        if not args.no_shutdown:
            args.shutdown = True

    if not any(
        (args.clean, args.tts, args.design, args.assets, args.render, args.bgm, args.accept)
    ):
        args.render = True
        args.bgm = True

    _guard_partial_run(args)

    paths.ensure()
    _maybe_copy_script(args.script)
    t0 = time.time()
    stages: dict = {}

    if args.clean:
        # --all 开跑：设计/渲染/镜头图/stage/raw/日志全清；TTS 音频一并清以免串稿
        clean_cmd = [py, str(ROOT / "cleanup.py")]
        if args.all:
            clean_cmd.append("--wipe-tts")
        rc, sec = _run_with_retry(
            clean_cmd,
            stage="clean",
            retries=args.stage_retries,
        )
        stages["clean"] = {"sec": round(sec, 3), "rc": rc}

    if args.tts:
        rc, sec = _run_with_retry(
            [py, str(ROOT / "01_口播试听" / "run_tts.py")],
            stage="tts",
            retries=args.stage_retries,
        )
        stages["tts"] = {"sec": round(sec, 3), "rc": rc}

    def _design():
        cmd = [py, str(ROOT / "02_镜头设计" / "run_design.py")]
        if args.seed is not None:
            cmd.extend(["--seed", str(args.seed)])
        if args.rules_only:
            cmd.append("--rules-only")
        if args.design_attempts:
            cmd.extend(["--design-attempts", str(args.design_attempts)])
        return _run_with_retry(cmd, stage="design", retries=args.stage_retries)

    def _enrich_kinds():
        enrich = ROOT / "02_镜头设计" / "enrich_kinds.py"
        if enrich.is_file() and (
            (paths.DESIGN / "briefs_active.json").is_file()
            or paths.TTS_TIMING.is_file()
        ):
            _run([py, str(enrich)], check=False)

    def _freeze_briefs():
        freeze = ROOT / "02_镜头设计" / "freeze_briefs.py"
        if freeze.is_file() and (paths.DESIGN / "briefs_active.json").is_file():
            _run([py, str(freeze)])

    def _remap_cuts():
        remap = ROOT / "02_镜头设计" / "remap_cuts.py"
        if remap.is_file():
            _run([py, str(remap)], check=False)

    def _rebind(*, enrich: bool = False):
        """生图后禁止 enrich（会改 visual 并触发重写资产名 → 空层）。"""
        rebind = [py, str(ROOT / "02_镜头设计" / "run_design.py"), "--rebind"]
        if args.seed is not None:
            rebind.extend(["--seed", str(args.seed)])
        if enrich:
            _enrich_kinds()
        # 优先用锁文件覆盖 active，保证与生图清单同名
        lock = paths.DESIGN / "briefs_locked.json"
        active = paths.DESIGN / "briefs_active.json"
        if lock.is_file():
            active.write_text(lock.read_text(encoding="utf-8"), encoding="utf-8")
        _remap_cuts()
        return _run_with_retry(rebind, stage="rebind", retries=args.stage_retries)

    if args.design:
        rc, sec = _design()
        stages["design"] = {"sec": round(sec, 3), "rc": rc}
        if rc == 2:
            print("STOP: LLM 账户余额不足，不再重试、不再生图", flush=True)
            _write_timing(stages, t0)
            raise SystemExit(2)
        _enrich_kinds()
        _freeze_briefs()

    if args.assets:
        if not args.design and not (paths.DESIGN / "assets_brief.json").is_file():
            rc, sec = _design()
            stages["design"] = {"sec": round(sec, 3), "rc": rc}
            _enrich_kinds()
            _freeze_briefs()
        # 生图前再冻一次（确保 enrich 后的定稿）
        _freeze_briefs()
        asset_cmd = [py, str(ROOT / "03_素材生成" / "run_assets.py")]
        if args.missing_only:
            asset_cmd.append("--missing-only")
        # 生图步骤**默认只跑一次**：每个资产提交一次，失败的留给人工重试。
        # 原来这里是 args.stage_retries（默认 3）再配 --missing-only 重跑，
        # 与内层 12 次提交叠成"最多 48 单/资产"，卡住时能烧掉十几分钟 ✗
        # 要用自动重试就设 KOUBO_ASSET_STEP_RETRIES=2。
        asset_retries = max(0, int(os.environ.get("KOUBO_ASSET_STEP_RETRIES", "0") or "0"))
        rc, sec = _run_with_retry(
            asset_cmd, stage="assets", retries=asset_retries, check=False,
            retry_cmd=[py, str(ROOT / "03_素材生成" / "run_assets.py"), "--missing-only"],
        )
        stages["assets"] = {"sec": round(sec, 3), "rc": rc}
        if rc == 2:
            print("STOP: 生图账户余额不足，不再重试、不再渲染", flush=True)
            _write_timing(stages, t0)
            raise SystemExit(2)
        _rebind(enrich=False)
        if rc != 0:
            print("WARN: assets incomplete, continue to bind/render; accept will fail if needed")
    elif args.render and (paths.DESIGN / "briefs_active.json").is_file():
        _rebind(enrich=False)

    if args.render:
        rc, sec = _run_with_retry(
            [py, str(ROOT / "04_动画渲染" / "render_koubo.py")],
            stage="render",
            retries=args.stage_retries,
        )
        stages["render"] = {"sec": round(sec, 3), "rc": rc}

    if args.bgm:
        rc, sec = _run_with_retry(
            [py, str(ROOT / "04_动画渲染" / "mix_bgm.py")],
            stage="bgm",
            retries=args.stage_retries,
        )
        stages["bgm"] = {"sec": round(sec, 3), "rc": rc}

    if args.accept or args.design or args.assets or args.render or args.bgm:
        # 端到端墙钟的判据：**这一次跑齐了全部关键阶段**，而不是"没传 --skip-clean"。
        #
        # 原来要求 `not skip_clean`，但 skill.json 调包内管线时**固定带 --skip-clean**
        # （为了保留 TTS 与已生成素材、失败重试不重复计费）。于是这个标志在正式生成里
        # 永远是 False → g4 的 pipeline_end_to_end / no_reused / total_le_20min 三项**恒红**，
        # 而它们本来是想保证"计时覆盖了整条链"。
        # 现在按阶段覆盖+成功来判定，语义更强也更诚实：五个关键阶段都在且 rc=0。
        need_stages = ("tts", "design", "assets", "render", "bgm")
        covered = all(
            isinstance(stages.get(n), dict) and stages[n].get("rc") == 0 for n in need_stages
        )
        e2e = bool(args.all) and not bool(args.missing_only) and covered
        _write_timing(stages, t0, end_to_end=e2e)

    if args.accept:
        # 基础验收 + 七门硬验收
        accept_rc = _run([py, str(ROOT / "accept_run.py")], check=False)
        gate_cmd = [py, str(ROOT / "accept_gates" / "run_all.py")]
        if args.shutdown and not args.no_shutdown:
            gate_cmd.append("--shutdown")
            gate_cmd.extend(["--shutdown-delay", str(args.shutdown_delay)])
        else:
            gate_cmd.append("--no-shutdown")
        rc = _run(gate_cmd, check=False)
        if rc == 0:
            # 验收通过：丢掉 stage/raw/预览/中间音视频，只留成片+报告
            _run([py, str(ROOT / "cleanup.py"), "--tidy"], check=False)

        # ── 产物已生成 vs 质量门通过，是两件事 ─────────────────────────────
        # 以前这里 `raise SystemExit(rc)`：门失败 → 进程非 0 → **宿主判定整个生成失败，
        # 于是把已经做好的分层产物全部丢弃、时间轴上一片空白**。
        # 受影响的正是最需要产物的场景：短口播（g2/g4 按 ≥1000 字标定，短稿必然红）、
        # 以及"软继续"允许的个别素材缺失。片子明明做出来了却什么都不给，是最糟的失败模式。
        #
        # 现在：只要**成片存在**就算生成成功，把门的结果如实写进报告并大声警告；
        # 只有连成片都没有时才算失败。质量信号不隐藏，但不再否决产物交付。
        final_ok, final_detail = _final_product_ok()
        if rc != 0 and not final_ok:
            print(f"FAIL: 质量门未通过，且没有成片（{final_detail}）", flush=True)
            raise SystemExit(rc)
        if rc != 0:
            print(
                f"WARN: 质量门未通过（见 04_动画渲染/output/accept_gates/summary.json），"
                f"但成片已产出（{final_detail}）：按成功交付，产物照常入轨",
                flush=True,
            )
        _write_gate_status(rc, final_ok, final_detail)


if __name__ == "__main__":
    main()
