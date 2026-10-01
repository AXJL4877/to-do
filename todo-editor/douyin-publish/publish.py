"""抖音发布辅助。按文字找控件，不绑某台手机的分辨率或混淆 ID。发布按钮由你自己点。"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import time
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DUMP_DIR = ROOT / "dumps"
CONFIG = ROOT / "config.json"
PHONE_DIR = "/sdcard/DCIM/DouyinPublish"
CAMERA_DIR = "/sdcard/DCIM/Camera"
PKG = "com.ss.android.ugc.aweme"
SERIAL = os.environ.get("ANDROID_SERIAL", "").strip()
def resolve_adb() -> str:
    found = shutil.which("adb")
    if found:
        return found
    home = Path.home()
    cands = [
        home / "AppData/Local/Microsoft/WinGet/Links/adb.exe",
        home
        / "AppData/Local/Microsoft/WinGet/Packages/Google.PlatformTools_Microsoft.Winget.Source_8wekyb3d8bbwe/platform-tools/adb.exe",
        home / "AppData/Local/Android/Sdk/platform-tools/adb.exe",
        Path(r"D:/Program Files/Lenovo/FusionEngine/LEmu/adb.exe"),
    ]
    # any newer WinGet package folder
    pkg = home / "AppData/Local/Microsoft/WinGet/Packages"
    if pkg.is_dir():
        cands.extend(sorted(pkg.glob("Google.PlatformTools*/platform-tools/adb.exe"), reverse=True))
    for p in cands:
        if Path(p).is_file():
            return str(p)
    return "adb"


ADB = resolve_adb()


def adb(*args: str, check: bool = True, timeout: float = 8) -> subprocess.CompletedProcess:
    if not Path(ADB).is_file() and shutil.which(ADB) is None:
        raise FileNotFoundError(
            "找不到 adb。请安装：winget install Google.PlatformTools --force"
        )
    prefix = ["-s", SERIAL] if SERIAL else []
    return subprocess.run(
        [ADB, *prefix, *args],
        check=check,
        capture_output=True,
        text=True,
        timeout=timeout,
    )


def load_config() -> dict:
    if not CONFIG.is_file():
        return {}
    try:
        return json.loads(CONFIG.read_text(encoding="utf-8"))
    except Exception:
        return {}


def list_phones() -> list[dict]:
    rows = []
    try:
        out = adb("devices", "-l", check=False, timeout=5)
    except FileNotFoundError as e:
        raise
    except subprocess.TimeoutExpired:
        return rows
    text = (out.stdout or "") + ("\n" + out.stderr if out.stderr else "")
    for line in text.splitlines():
        if not line.strip() or line.lower().startswith("list of devices"):
            continue
        parts = line.split()
        if len(parts) < 2:
            continue
        serial, state = parts[0], parts[1]
        if serial == "*":
            continue
        meta = {}
        for p in parts[2:]:
            if ":" in p:
                k, v = p.split(":", 1)
                meta[k] = v
        rows.append({"serial": serial, "state": state, "model": meta.get("model", ""), "product": meta.get("product", "")})
    return rows


def pick_serial() -> str:
    global SERIAL
    phones = list_phones()
    ready = [p for p in phones if p["state"] == "device"]
    if SERIAL:
        return SERIAL
    if len(ready) == 1:
        SERIAL = ready[0]["serial"]
        return SERIAL
    if not ready:
        sys.exit("没有已授权的手机。请打开 USB 调试并点允许。")
    print("多台手机，请指定一台：")
    for p in ready:
        print(f"  {p['serial']}  {p['model'] or p['product']}")
    sys.exit("用法: set ANDROID_SERIAL=序列号  再运行，或 python publish.py -s 序列号 fill")


def dump_screen(label: str = "now") -> Path:
    pick_serial()
    DUMP_DIR.mkdir(exist_ok=True)
    png = DUMP_DIR / f"{label}.png"
    xml = DUMP_DIR / f"{label}.xml"
    raw = subprocess.run(
        [ADB, "-s", SERIAL, "exec-out", "screencap", "-p"],
        check=True,
        capture_output=True,
        timeout=20,
    )
    png.write_bytes(raw.stdout)
    adb("shell", "uiautomator", "dump", "/sdcard/uidump.xml", timeout=20)
    adb("pull", "/sdcard/uidump.xml", str(xml), timeout=15)
    return xml


def parse_nodes(xml_path: Path) -> list[dict]:
    root = ET.parse(xml_path).getroot()
    nodes = []
    for n in root.iter("node"):
        text = n.attrib.get("text", "")
        desc = n.attrib.get("content-desc", "")
        rid = n.attrib.get("resource-id", "")
        clickable = n.attrib.get("clickable") == "true"
        if not (text or desc or (clickable and rid)):
            continue
        nodes.append(
            {
                "text": text,
                "desc": desc,
                "id": rid.split("/")[-1] if rid else "",
                "clickable": clickable,
                "class": n.attrib.get("class", "").split(".")[-1],
                "bounds": n.attrib.get("bounds", ""),
            }
        )
    return nodes


def print_nodes(nodes: list[dict]) -> None:
    for i, n in enumerate(nodes):
        mark = "TAP" if n["clickable"] else "   "
        bits = [x for x in (n["text"], n["desc"], n["id"]) if x]
        print(f"{i:3} {mark} {n['bounds']:20} {' | '.join(bits)}")


def scan_media(names: tuple[str, ...] = ("video.mp4", "cover.png", "cover-4x3.png")) -> None:
    adb("shell", "cmd", "media", "volume", "scan", "external_primary", check=False)
    for name in names:
        path = f"{CAMERA_DIR}/{name}"
        adb(
            "shell",
            "am",
            "broadcast",
            "-a",
            "android.intent.action.MEDIA_SCANNER_SCAN_FILE",
            "-d",
            f"file://{path}",
            check=False,
        )


def beside(base: Path, names: tuple[str, ...]) -> Path | None:
    if not base:
        return None
    folder = base if base.is_dir() else base.parent
    for n in names:
        p = folder / n
        if p.is_file():
            return p
    return None


def push_media() -> dict:
    """Push video and/or images to phone album. Images-only assets are allowed."""
    pick_serial()
    cfg = load_config()
    video = Path(cfg.get("video") or "")
    cover = Path(cfg.get("cover") or "")
    land = Path(cfg.get("coverLandscape") or "")
    avatar = Path(cfg.get("avatar") or "")
    background = Path(cfg.get("background") or "")

    # Anchor on whichever path exists; then ALWAYS re-resolve siblings from that
    # same folder so stale config (avatar from another asset) cannot mix in.
    anchor = next(
        (p for p in (video, cover, land, avatar, background) if p.is_file()),
        Path(),
    )
    if anchor.is_file():
        folder = anchor.parent
        video = beside(folder, ("video.mp4", "video.webm", "video.mov")) or (
            video if video.is_file() and video.parent == folder else Path()
        )
        cover = beside(folder, ("cover-3x4.png", "cover-3x4.jpg", "cover-3x4.webp", "cover.png")) or Path()
        land = beside(folder, ("cover-4x3.png", "cover-4x3.jpg", "cover-4x3.webp")) or Path()
        avatar = beside(folder, ("avatar.png", "avatar.jpg", "avatar.jpeg", "avatar.webp")) or Path()
        background = (
            beside(
                folder,
                (
                    "background.png",
                    "background.jpg",
                    "background.jpeg",
                    "background.webp",
                    "profile-bg.png",
                    "profile-bg.jpg",
                ),
            )
            or Path()
        )

    has_video = video.is_file()
    stamp = time.strftime("%Y%m%d_%H%M%S")
    image_jobs: list[tuple[Path, str]] = []
    if cover.is_file():
        image_jobs.append((cover, "cover.png"))
    if land.is_file():
        image_jobs.append((land, "cover-4x3.png"))
    if avatar.is_file():
        image_jobs.append((avatar, "avatar.png"))
    if background.is_file():
        image_jobs.append((background, "background.png"))

    # 其他资产：config.others 或同夹 other/ + 非固定文件名
    other_paths: list[Path] = []
    for raw in cfg.get("others") or []:
        p = Path(raw)
        if p.is_file():
            other_paths.append(p)
    if anchor.is_file():
        folder = anchor.parent
        for p in (folder / "other").glob("*") if (folder / "other").is_dir() else []:
            if p.is_file() and p.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp", ".gif", ".mp4", ".webm", ".mov"}:
                other_paths.append(p)
        for p in folder.iterdir():
            if not p.is_file():
                continue
            if p.name.lower() in {
                "video.mp4",
                "video.webm",
                "video.mov",
                "cover-3x4.png",
                "cover-3x4.jpg",
                "cover-3x4.webp",
                "cover.png",
                "cover-4x3.png",
                "cover-4x3.jpg",
                "cover-4x3.webp",
                "avatar.png",
                "avatar.jpg",
                "avatar.jpeg",
                "avatar.webp",
                "background.png",
                "background.jpg",
                "background.jpeg",
                "background.webp",
                "profile-bg.png",
                "profile-bg.jpg",
                "meta.json",
                "readme.txt",
            }:
                continue
            if p.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp", ".gif", ".mp4", ".webm", ".mov"}:
                other_paths.append(p)
    seen_other: set[str] = set()
    for i, p in enumerate(other_paths):
        key = str(p.resolve()).lower()
        if key in seen_other:
            continue
        seen_other.add(key)
        dest = f"other_{stamp}_{i}_{p.name}"
        image_jobs.append((p, dest))

    if not has_video and not image_jobs:
        return {"ok": False, "error": "没有可发送的视频或图片。请先在资产库点选一条资产。"}

    adb("shell", "mkdir", "-p", PHONE_DIR)
    adb("shell", "mkdir", "-p", CAMERA_DIR)
    pushed: list[str] = []
    scan_names: list[str] = []

    if has_video:
        adb("push", str(video), f"{PHONE_DIR}/video{video.suffix}", timeout=90)
        adb("push", str(video), f"{CAMERA_DIR}/video.mp4", timeout=90)
        pushed.append(f"video:{video.name}")
        scan_names.append("video.mp4")

    for src, dest_name in image_jobs:
        # 带时间戳，避免相册吞掉同名覆盖
        if dest_name in {"cover.png", "avatar.png", "background.png", "cover-4x3.png"}:
            stem, ext = dest_name.rsplit(".", 1)
            dest_name = f"{stem}_{stamp}.{ext}"
        adb("push", str(src), f"{PHONE_DIR}/{dest_name}", timeout=30)
        adb("push", str(src), f"{CAMERA_DIR}/{dest_name}", timeout=30)
        pushed.append(f"image:{dest_name}")
        scan_names.append(dest_name)

    scan_media(tuple(scan_names) if scan_names else ("cover.png",))
    mode = "video+images" if has_video and image_jobs else ("video" if has_video else "images")
    return {"ok": True, "serial": SERIAL, "mode": mode, "pushed": pushed}


def connect_u2():
    import uiautomator2 as u2

    pick_serial()
    return u2.connect(SERIAL)


def first_edit(d, *hints):
    for h in hints:
        el = d(textContains=h)
        if el.exists:
            return el
    el = d(className="android.widget.EditText")
    return el if el.exists else None


def guess_page(nodes: list[dict]) -> str:
    blob = " ".join(f"{n['text']} {n['desc']}" for n in nodes)
    if "发作品" in blob and ("添加作品描述" in blob or "添加标题" in blob or "作品描述" in blob):
        return "publish"
    if "剪辑" in blob and "下一步" in blob and "发作品" not in blob:
        return "effects"
    if "下一步" in blob and ("所有照片" in blob or "视频" in blob):
        return "pick"
    if "保存" in blob and ("封面" in blob or "相册" in blob) and "拍摄" not in blob:
        return "cover"
    if "相册" in blob and ("拍摄" in blob or "分段拍" in blob or "选择音乐" in blob):
        return "shoot"
    if "发作品" in blob:
        return "publish"
    return "other"


def tap(d, *labels, timeout: float = 4.0):
    """按文字或无障碍描述点控件。永不点「发作品」「发布」。"""
    end = time.time() + timeout
    while time.time() < end:
        for lab in labels:
            if lab in {"发作品", "发布"}:
                continue
            for kwargs in ({"text": lab}, {"description": lab}, {"descriptionContains": lab}):
                el = d(**kwargs)
                if el.exists:
                    el.click()
                    return lab
        time.sleep(0.25)
    return None


def dismiss_perm(d) -> None:
    for lab in ("始终允许", "仅在使用中允许", "仅在使用该应用时允许", "允许访问", "同意", "允许"):
        if d(text=lab).exists:
            d(text=lab).click()
            time.sleep(0.4)
            return


def page_kind(d) -> str:
    if d(text="发作品").exists or d(description="发作品").exists:
        return "publish"
    if d(text="剪辑").exists or d(text="滤镜").exists:
        return "effects"
    if d(text="所有照片").exists or d(descriptionContains="未选中").exists:
        return "pick"
    if d(text="相册").exists and (d(descriptionContains="拍摄").exists or d(text="分段拍").exists):
        return "shoot"
    if d(text="保存").exists and (d(textContains="封面").exists):
        return "cover"
    if d(text="下一步").exists:
        return "effects"
    return "other"


def click_next_until_publish(d, steps: list) -> dict:
    for _ in range(8):
        dismiss_perm(d)
        kind = page_kind(d)
        if kind == "publish":
            return {"ok": True, "serial": SERIAL, "page": "publish", "steps": steps}
        if not tap(d, "下一步", timeout=3):
            break
        steps.append("下一步")
        time.sleep(1.4)
    kind = page_kind(d)
    if kind == "publish":
        return {"ok": True, "serial": SERIAL, "page": "publish", "steps": steps}
    return {"ok": False, "error": f"停在{kind}，没到发布页", "steps": steps, "serial": SERIAL, "page": kind}


def open_shoot() -> None:
    adb(
        "shell",
        "am",
        "start",
        "-a",
        "android.intent.action.VIEW",
        "-d",
        "snssdk1128://openRecord",
        check=False,
        timeout=12,
    )
    time.sleep(1.6)


def wait_kind(d, kinds: set[str], timeout: float = 12) -> str:
    end = time.time() + timeout
    last = "other"
    while time.time() < end:
        dismiss_perm(d)
        last = page_kind(d)
        if last in kinds:
            return last
        time.sleep(0.35)
    return last


def pick_imported_video(d) -> bool:
    """点相册最左上角成片，预览里再点「选择」。"""
    dismiss_perm(d)
    if d(text="选择").exists and (d(text="返回").exists or d(description="返回").exists):
        if d(text="返回").exists:
            d(text="返回").click()
        else:
            d(description="返回").click()
        time.sleep(0.9)
    xml = ""
    end = time.time() + 10
    while time.time() < end:
        xml = d.dump_hierarchy()
        if "点按两次" in xml:
            break
        time.sleep(0.4)
    first = None
    try:
        root = ET.fromstring(xml)
    except ET.ParseError:
        root = None
    if root is not None:
        for n in root.iter("node"):
            if "点按两次" not in (n.attrib.get("content-desc") or ""):
                continue
            m = re.search(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", n.attrib.get("bounds") or "")
            if m:
                first = tuple(map(int, m.groups()))
                break
    if not first:
        return False
    d.click(first[0] + (first[2] - first[0]) // 3, (first[1] + first[3]) // 2)
    time.sleep(1.1)
    if d(text="选择").exists:
        d(text="选择").click()
        time.sleep(0.5)
    return True


def open_publish() -> dict:
    """拍摄页 → 相册 → 左上成片 → 选择 → 音乐特效下一步 → 编辑页。不点发作品。"""
    pick_serial()
    d = connect_u2()
    steps = []
    dismiss_perm(d)
    kind = page_kind(d)
    if kind == "publish":
        return {"ok": True, "serial": SERIAL, "page": "publish", "steps": ["已在编辑页"]}
    if kind == "effects":
        steps.append("音乐特效页")
        return click_next_until_publish(d, steps)

    if kind != "pick":
        if kind != "shoot":
            open_shoot()
            steps.append("打开拍摄页")
        kind = wait_kind(d, {"shoot", "pick", "effects", "publish"}, 14)
        if kind not in {"pick", "effects", "publish"}:
            if not tap(d, "相册", timeout=10):
                return {"ok": False, "error": "拍摄页找不到「相册」", "steps": steps, "serial": SERIAL, "page": kind}
            steps.append("点相册")
            kind = wait_kind(d, {"pick", "effects", "publish"}, 14)
            if kind not in {"pick", "effects", "publish"}:
                return {
                    "ok": False,
                    "error": "点了相册但还停在拍摄页",
                    "steps": steps,
                    "serial": SERIAL,
                    "page": kind,
                }

    if kind == "pick" or d(text="所有照片").exists:
        if not pick_imported_video(d):
            return {"ok": False, "error": "没选中最左上角成片", "steps": steps, "serial": SERIAL, "page": kind}
        steps.append("选左上成片")
        kind = wait_kind(d, {"effects", "publish", "pick"}, 10)

    if page_kind(d) == "shoot":
        return {"ok": False, "error": "还停在拍摄页，没有进相册", "steps": steps, "serial": SERIAL, "page": "shoot"}
    return click_next_until_publish(d, steps)


def stage_publish() -> dict:
    cfg = load_config()
    video = Path(cfg.get("video") or "")
    pushed = push_media()
    if not pushed.get("ok"):
        return pushed
    if not video.is_file():
        return {
            "ok": True,
            "serial": pushed.get("serial"),
            "mode": "images-only",
            "pushed": True,
            "steps": pushed.get("pushed") or [],
            "note": "已推图片到相册。无视频时不能走「发布」选片流程，请在手机相册里手动用图。",
        }
    opened = open_publish()
    opened["pushed"] = True
    opened["push"] = pushed
    return opened


def fill_publish() -> dict:
    cfg = load_config()
    title = cfg.get("title") or "今日盘中涨幅TOP50"
    tags = " ".join(f"#{t}" for t in cfg.get("tags") or [])
    body = f"{cfg.get('caption', '').strip()}\n{tags}".strip()
    d = connect_u2()
    title_el = first_edit(d, "添加标题")
    cap_el = first_edit(d, "添加作品描述")
    if cap_el is None and title_el is None:
        return {"ok": False, "error": "当前页找不到标题/描述输入框，请先停在抖音发布页"}
    if title_el is not None and cap_el is not None and title_el.info["bounds"] != cap_el.info["bounds"]:
        title_el.click()
        time.sleep(0.25)
        title_el.set_text(title)
        cap_el.click()
        time.sleep(0.25)
        cap_el.set_text(body)
        mode = "split"
    else:
        box = cap_el or title_el
        box.click()
        time.sleep(0.25)
        box.set_text(f"{title}\n{body}")
        mode = "single"
    if d(text="#今日涨幅榜").exists:
        d(text="#今日涨幅榜").click()
    return {"ok": True, "serial": SERIAL, "mode": mode}


def emit(obj: dict) -> None:
    print(json.dumps(obj, ensure_ascii=False))


def api_phones() -> dict:
    """列出 USB 设备。默认不查抖音进程（省时间）；需要时传 check_douyin=1。"""
    global SERIAL
    check_dy = os.environ.get("TODO_DOUYIN_CHECK_PID", "").strip() in ("1", "true", "yes")
    try:
        listed = list_phones()
    except FileNotFoundError as e:
        return {"ok": False, "phones": [], "error": str(e), "draft": load_config(), "adb": ADB}
    phones = []
    for p in listed:
        row = {**p, "douyin": False, "page": p["state"]}
        if check_dy and p["state"] == "device":
            SERIAL = p["serial"]
            try:
                row["douyin"] = bool(adb("shell", "pidof", PKG, check=False, timeout=1.5).stdout.strip())
            except (subprocess.TimeoutExpired, Exception):
                row["douyin"] = False
        phones.append(row)
    return {"ok": True, "phones": phones, "draft": load_config(), "adb": ADB}


def api_inspect(serial: str) -> dict:
    global SERIAL
    SERIAL = serial
    label = "".join(c if c.isalnum() else "_" for c in serial)[:24]
    xml = dump_screen(label)
    nodes = parse_nodes(xml)
    page = guess_page(nodes)
    shot = f"/desk-dumps/{label}.png"
    return {"ok": True, "serial": serial, "page": page, "shot": shot, "nodes": nodes[:40]}


def api_save_draft(data: dict) -> dict:
    cur = load_config()
    for k in ("title", "caption", "tags", "video", "cover", "coverLandscape", "avatar", "background", "others"):
        if k in data:
            cur[k] = data[k]
    CONFIG.write_text(json.dumps(cur, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return {"ok": True, "draft": cur}


def cmd_dump(label: str) -> None:
    xml = dump_screen(label)
    print_nodes(parse_nodes(xml))
    print(f"\n设备: {SERIAL}")
    print(f"截图: {DUMP_DIR / f'{label}.png'}")
    print(f"控件: {xml}")


def cmd_status() -> None:
    global SERIAL
    phones = list_phones()
    if not phones:
        print("adb 未看到手机")
        return
    for p in phones:
        print(f"{p['serial']}\t{p['state']}\t{p['model'] or p['product']}")
    ready = [p for p in phones if p["state"] == "device"]
    if not ready:
        return
    if SERIAL:
        pick = SERIAL
    elif len(ready) == 1:
        pick = ready[0]["serial"]
    else:
        print("多台已授权，填字/推送时请加 -s 序列号")
        return
    SERIAL = pick
    focus = adb("shell", "dumpsys", "window").stdout
    for line in focus.splitlines():
        if "mCurrentFocus" in line:
            print(line.strip())
    pkg = adb("shell", "pidof", PKG, check=False).stdout.strip()
    print("抖音:", pkg or "未运行")


def main() -> None:
    global SERIAL
    args = sys.argv[1:]
    if args and args[0] == "-s":
        if len(args) < 2:
            sys.exit("缺少序列号")
        SERIAL = args[1]
        args = args[2:]
    if not args or args[0] in {"-h", "--help"}:
        print("用法:")
        print("  python publish.py status")
        print("  python publish.py -s 序列号 dump|push|fill")
        print("  python publish.py dump [名字]")
        print("  python publish.py push          # 推视频和/或图片到相册（可无视频）")
        print("  python publish.py fill")
        print("  python publish.py json phones|inspect|push|fill|open|stage|draft")
        return
    cmd = args[0]
    if cmd == "status":
        cmd_status()
    elif cmd == "dump":
        cmd_dump(args[1] if len(args) > 1 else "now")
    elif cmd == "push":
        r = push_media()
        if not r.get("ok"):
            sys.exit(r.get("error", "push failed"))
        print("已推到", SERIAL, PHONE_DIR, "和", CAMERA_DIR)
    elif cmd == "fill":
        r = fill_publish()
        if not r.get("ok"):
            sys.exit(r.get("error", "fill failed"))
        print(f"已填到 {SERIAL}。请检查后自己点「发作品」。")
    elif cmd == "json":
        sub = args[1] if len(args) > 1 else "phones"
        if sub == "phones":
            emit(api_phones())
        elif sub == "inspect":
            emit(api_inspect(args[2] if len(args) > 2 else pick_serial()))
        elif sub == "push":
            if len(args) > 2 and not str(args[2]).startswith("-"):
                SERIAL = args[2]
            emit(push_media())
        elif sub == "fill":
            if len(args) > 2 and not str(args[2]).startswith("-"):
                SERIAL = args[2]
            emit(fill_publish())
        elif sub == "open":
            if len(args) > 2 and not str(args[2]).startswith("-"):
                SERIAL = args[2]
            emit(open_publish())
        elif sub == "stage":
            if len(args) > 2 and not str(args[2]).startswith("-"):
                SERIAL = args[2]
            emit(stage_publish())
        elif sub == "draft":
            raw = sys.stdin.read() or "{}"
            emit(api_save_draft(json.loads(raw)))
        else:
            emit({"ok": False, "error": f"未知 json 命令: {sub}"})
    else:
        sys.exit(f"未知命令: {cmd}")


if __name__ == "__main__":
    main()
