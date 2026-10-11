"""Asset library: import, key, split, validate.

Layout under kit/assets:

    raw/    what the image provider returned, untouched (QA runs here)
    cut/    keyed, trimmed sprites (what the renderer uses)
    backgrounds/

The split between raw and cut is what makes the cropped-generation check possible
at all: trimming crops a sprite to its ink, so every trimmed sprite touches all
four edges and the test is meaningless after that point.
"""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
from PIL import Image

from . import imaging as I

import os
KIT = Path(__file__).resolve().parent.parent
_ASSETS_ENV = os.environ.get("KOUBO_KIT_ASSETS", "").strip()
ASSETS = Path(_ASSETS_ENV) if _ASSETS_ENV else (KIT / "assets")
RAW = ASSETS / "raw"
CUT = ASSETS / "cut"
BG = ASSETS / "backgrounds"
MANIFEST = ASSETS / "manifest.json"

def _mishi_run():
    root = Path(os.environ.get("MISHI_ROOT") or "").expanduser()
    cand = root / "run.py"
    return cand if cand.is_file() else Path()
IMAGE_RUN = _mishi_run()
STYLE = (
    "Flat 2D television cartoon in the classic SpongeBob SquarePants drawing style, "
    "thick even black outlines, flat unshaded colors, simple shapes. "
)
CUTOUT = (
    "Isolated single subject, complete and fully inside the frame with clear empty margin on all four sides, "
    "on a pure flat white background (#FFFFFF), no scenery, no watermark, no signature, no logo, "
    "no caption or label beside the object."
)
# The default suffix above forbids text, to keep watermarks out. That also forbids
# the numbers printed ON an object, which is why a calendar kept coming back blank:
# day numerals are text. Objects that carry their own printing use this suffix.
CUTOUT_PRINTED = (
    "Isolated single subject, complete and fully inside the frame with clear empty margin on all four sides, "
    "on a pure flat white background (#FFFFFF), no scenery, no watermark, no signature, no logo. "
    "Any numbers or letters printed on the object itself are part of the drawing and must be clearly "
    "and correctly drawn, in solid black, at a readable size."
)

# height is the target on-screen height as a fraction of frame height; split marks
# a plate that holds several subjects and must be cut apart on its empty columns.
SPEC = {
    "crowd": {"raw": "crowd.png", "height": 0.30, "split": True, "kind": "character"},
    "lounge": {"raw": "lounge.png", "height": 0.46, "split": False, "kind": "character"},
    "grill": {"raw": "grill.png", "height": 0.48, "split": False, "kind": "character"},
    "cheer": {"raw": "cheer.png", "height": 0.50, "split": False, "kind": "character"},
    "tired": {"raw": "tired.png", "height": 0.48, "split": False, "kind": "character"},
    "pair": {"raw": "pair.png", "height": 0.42, "split": True, "kind": "character"},
    "piggy": {"raw": "piggy.png", "height": 0.42, "split": True, "kind": "character"},
    "hold": {"raw": "hold.png", "height": 0.46, "split": False, "kind": "character"},
    "push": {"raw": "push.png", "height": 0.50, "split": False, "kind": "character"},
    "krabs": {"raw": "krabs.png", "height": 0.41, "split": False, "kind": "character"},
    "squid": {"raw": "squid.png", "height": 0.48, "split": False, "kind": "character"},
    "noodles": {"raw": "noodles.png", "height": 0.52, "split": False, "kind": "character"},
    "ball": {"raw": "ball.png", "height": 0.36, "split": False, "kind": "prop"},
    "sb_point": {"raw": "sb_point.png", "height": 0.44, "split": False, "kind": "character"},
    "sb_sleep": {"raw": "sb_sleep.png", "height": 0.44, "split": False, "kind": "character"},
    "sb_worry": {"raw": "sb_worry.png", "height": 0.44, "split": False, "kind": "character"},
    "sb_run": {"raw": "sb_run.png", "height": 0.44, "split": False, "kind": "character"},
    "pat_stand": {"raw": "pat_stand.png", "height": 0.46, "split": False, "kind": "character"},
    "coinbag": {"raw": "prop_coinbag.png", "height": 0.32, "split": False, "kind": "prop"},
    "calendar": {"raw": "prop_calendar.png", "height": 0.30, "split": False, "kind": "prop"},
    "scale": {"raw": "prop_scale.png", "height": 0.30, "split": False, "kind": "prop"},
    "prop_piggy": {"raw": "prop_piggy.png", "height": 0.24, "split": False, "kind": "prop"},
    "prop_coins": {"raw": "prop_coins.png", "height": 0.26, "split": False, "kind": "prop"},
    "hourglass": {"raw": "hourglass.png", "height": 0.28, "split": False, "kind": "prop"},
    "chest": {"raw": "chest.png", "height": 0.28, "split": False, "kind": "prop"},
    "bill": {"raw": "bill.png", "height": 0.24, "split": False, "kind": "prop"},
    "plot_rise": {"raw": "plot_rise.png", "height": 0.30, "split": False, "kind": "prop"},
    "sb_walk": {"raw": "sb_walk.png", "height": 0.44, "split": False, "kind": "character"},
    "sb_think": {"raw": "sb_think.png", "height": 0.44, "split": False, "kind": "character"},
    "sb_coins": {"raw": "sb_coins.png", "height": 0.46, "split": False, "kind": "character"},
    "pat_sit": {"raw": "pat_sit.png", "height": 0.42, "split": False, "kind": "character"},
    "krabs_wave": {"raw": "krabs_wave.png", "height": 0.41, "split": False, "kind": "character"},
    "squid_sad": {"raw": "squid_sad.png", "height": 0.48, "split": False, "kind": "character"},
    "ladder": {"raw": "ladder.png", "height": 0.30, "split": False, "kind": "prop"},
    "prop_clock": {"raw": "prop_clock.png", "height": 0.26, "split": False, "kind": "prop"},
    "prop_sun": {"raw": "prop_sun.png", "height": 0.24, "split": False, "kind": "prop"},
    "prop_snow": {"raw": "prop_snow.png", "height": 0.26, "split": False, "kind": "prop"},
    "prop_bubble": {"raw": "prop_bubble.png", "height": 0.30, "split": False, "kind": "prop"},
    "bigclock": {"raw": "bigclock.png", "height": 0.30, "split": False, "kind": "prop"},
}

# Objects that carry their own printing. They must be generated with the
# printed-friendly prompt suffix, otherwise the "no text" clause that keeps
# watermarks out also erases the calendar's day numbers and the clock's numerals.
PRINTED = {"calendar", "bigclock", "prop_clock", "bill", "plot_rise"}

PROMPTS = {
    "sb_point": "SpongeBob SquarePants in white shirt, red tie, brown square pants and hat, standing and "
                "presenting something to his left with one open hand, other hand on hip, friendly smile.",
    "sb_sleep": "SpongeBob SquarePants in work uniform, standing exhausted with eyes closed, mouth open in a "
                "big yawn, one hand rubbing his eye.",
    "sb_worry": "SpongeBob SquarePants in work uniform, standing hunched and worried, both hands clasped in "
                "front of his chest.",
    "sb_run": "SpongeBob SquarePants in work uniform, walking to the right in side view, one arm swinging, "
              "cheerful expression.",
    "pat_stand": "Patrick Star, pink starfish, green flower shorts, standing upright with both arms open wide "
                 "in a cheerful welcoming pose. Not SpongeBob.",
    "coinbag": "A brown burlap money sack tied at the top with rope, overflowing with gold coins, one big gold "
               "coin leaning against it.",
    "calendar": "A tear-off wall calendar with white pages and a red header bar, on a small wooden stand.",
    "scale": "A simple brass balance scale with two shallow pans, one holding a stack of gold coins, the other "
             "a small hourglass.",
    "prop_piggy": "One pink ceramic piggy bank with a coin slot on its back, standing on four short legs.",
    "prop_coins": "Four stacks of gold coins side by side getting taller from left to right, plus three loose "
                  "coins in front.",
}

_raw_cache = {}
_cut_cache = {}


# ------------------------------------------------------------------ build ----

def empty_columns(sprite, min_gap=8):
    col = (sprite[:, :, 3] > 128).sum(axis=0)
    runs = []
    start = None
    for i, v in enumerate(col):
        if v == 0 and start is None:
            start = i
        elif v != 0 and start is not None:
            runs.append((start, i))
            start = None
    if start is not None:
        runs.append((start, len(col)))
    return [(a, b) for a, b in runs if b - a >= min_gap and a > 0 and b < len(col)]


def split_sprite(sprite):
    """Cut a multi-subject plate apart on columns that hold no ink at all.

    A relative "low ink" threshold is not usable: a raised arm or a held coin has
    only a few pixels in its column, so that rule slices limbs off characters.
    """
    bounds = [0]
    for a, b in empty_columns(sprite):
        bounds.append((a + b) // 2)
    bounds.append(sprite.shape[1])
    parts = []
    for i in range(len(bounds) - 1):
        piece = sprite[:, bounds[i] : bounds[i + 1]]
        ys, xs = np.where(piece[:, :, 3] > 24)
        if xs.size < 120:
            continue
        parts.append(piece[ys.min() : ys.max() + 1, xs.min() : xs.max() + 1])
    return parts


def build(force=False, verbose=True):
    """Key every raw generation into cut/, splitting the multi-subject plates."""
    CUT.mkdir(parents=True, exist_ok=True)
    manifest = {}
    for name, spec in SPEC.items():
        src = RAW / spec["raw"]
        if not src.exists():
            if verbose:
                print(f"  {name:12s} raw missing ({spec['raw']})")
            continue
        out_single = CUT / f"{name}.png"
        if force or not out_single.exists():
            keyed, report = I.remove_background(Image.open(src))
            parts = split_sprite(np.array(trim_rgba(keyed))) if spec["split"] else [np.array(trim_rgba(keyed))]
            for i, piece in enumerate(parts):
                target = CUT / (f"{name}.png" if len(parts) == 1 else f"{name}_{i}.png")
                Image.fromarray(piece).save(target)
            manifest[name] = {
                "kind": spec["kind"],
                "raw": spec["raw"],
                "height": spec["height"],
                "parts": len(parts),
                "printed": name in PRINTED,
                "qa": report,
            }
            if verbose:
                flag = "CROPPED" if report["cropped"] else ("ok" if report["bg_near_white"] else "dark-bg")
                print(f"  {name:12s} -> {len(parts)} part(s)  bg={report['bg_rgb']}  {flag}")
        elif name not in manifest:
            manifest[name] = {"kind": spec["kind"], "raw": spec["raw"], "height": spec["height"]}
    MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    if verbose:
        print("manifest:", MANIFEST)
    _cut_cache.clear()
    return manifest


def trim_rgba(im):
    """Crop to the alpha, not to getbbox().

    Pillow's getbbox() counts any non-zero pixel, so a sprite whose transparent
    area happens to be white never trims at all.
    """
    im = im.convert("RGBA")
    arr = np.array(im)
    ys, xs = np.where(arr[:, :, 3] > 8)
    if xs.size == 0:
        return im
    return im.crop((int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1))


def cut_names():
    """Every sprite the renderer can ask for, including split children."""
    if not CUT.exists():
        return []
    return sorted(p.stem for p in CUT.glob("*.png"))


def height_for(name):
    # 镜头专用素材：ch_=角色，pr_=道具（由 02/03 管线生成）
    # 单镜易显小：角色/道具默认略放大（验收：避免满屏空白只剩小贴纸）
    if name.startswith("ch_"):
        return 0.52
    if name.startswith("pr_"):
        return 0.40
    base = name.split("_")[0] if name.split("_")[-1].isdigit() else name
    spec = SPEC.get(name) or SPEC.get(base)
    if spec:
        return spec["height"]
    return 0.36


_manifest_cache = None


def manifest():
    global _manifest_cache
    if _manifest_cache is None:
        _manifest_cache = json.loads(MANIFEST.read_text(encoding="utf-8")) if MANIFEST.exists() else {}
    return _manifest_cache


def qa_of(name):
    base = name.split("_")[0] if name.split("_")[-1].isdigit() else name
    entry = manifest().get(base) or {}
    return entry.get("qa") or {}


def bleeds_bottom(name):
    """True when the source art was cut off by the frame's bottom edge.

    Such a sprite has to sit on the frame's bottom edge so the cut is hidden; if
    it is stood on the sand line instead, its flat cut edge hangs in mid-air.
    """
    edges = qa_of(name).get("subject_at_edge") or [False, False, False, False]
    return bool(edges[1])


def element(name):
    """Load a cut sprite, scaled to its slot height. None if it is not built yet."""
    if name in _cut_cache:
        return _cut_cache[name]
    path = CUT / f"{name}.png"
    if not path.exists():
        print("assets: missing", name)
        _cut_cache[name] = None
        return None
    sprite = np.array(I.fit_height(trim_rgba(Image.open(path)), int(I.H * height_for(name))))
    _cut_cache[name] = sprite
    return sprite


# -------------------------------------------------------------- generate ----

def _run(args, timeout=None):
    return subprocess.run([sys.executable, str(IMAGE_RUN), *args], capture_output=True, timeout=timeout)


VISION_CHECK = (
    "In one short sentence, say what is drawn in this cartoon cut-out and whether it looks like a "
    "complete, usable, self-contained object."
)


def blank_subject(im, min_ink=0.008, min_fill=0.90):
    """Catch a subject with nothing inside it: a blank page, an empty box.

    This is the reliable half of asset accuracy. A vision model was tried here
    first and proved unusable -- it called a blank calendar pad "a calendar with a
    grid of day squares" and rejected a perfectly good treasure chest.

    Two conditions together, because linework alone would reject a snowball: an
    empty drawing has no interior black AND fills its own bounding box like a
    sheet of paper. A round object fills about 0.78 of its box; a page fills 0.95+.
    """
    import cv2

    arr = np.array(im.convert("RGBA"))
    mask = arr[:, :, 3] > 128
    ys, xs = np.where(mask)
    if xs.size == 0:
        return True, 0.0, "empty"
    sub = arr[ys.min() : ys.max() + 1, xs.min() : xs.max() + 1]
    m = mask[ys.min() : ys.max() + 1, xs.min() : xs.max() + 1]
    fill = float(m.mean())
    k = max(3, int(min(sub.shape[:2]) * 0.06)) | 1
    inner = cv2.erode(m.astype(np.uint8), np.ones((k, k), np.uint8)) > 0
    if int(inner.sum()) < 200:
        return False, 1.0, "too thin to judge"
    luma = sub[:, :, :3].mean(axis=2)
    ratio = float(((luma < 90) & inner).sum() / inner.sum())
    blank = ratio < min_ink and fill > min_fill
    return blank, ratio, f"interior linework {ratio * 100:.2f}%, box fill {fill:.2f}"


def review(name, prompt, path, log=print):
    """Advisory vision note, recorded in the manifest. Never blocks a build.

    A wrong rejection costs a good element, and this model is not accurate enough
    to spend one on. It is surfaced for a human instead; blank_subject() is the
    check that actually decides.
    """
    from . import llm

    try:
        reply = llm.vision(VISION_CHECK, path, max_tokens=200)
    except Exception as exc:  # noqa: BLE001 - a review outage must not stop a build
        log(f"  {name}: vision unavailable ({exc})")
        return None
    note = " ".join(reply.split())[:200]
    log(f"  {name}: vision note - {note}")
    return {"note": note}


def generate(name, prompt, tries=3, wait=240, check_vision=False, printed=None):
    """Ask the provider for one element, validate it, retry if it came back bad.

    Two gates. The geometry gate rejects a subject that runs into the picture edge
    or a backdrop that is not a flat colour. The linework gate rejects a subject
    with nothing drawn inside it -- a blank page, an empty box. A vision note is
    recorded alongside, for a human to glance at.

    printed=True for an object that carries its own numbers or lettering (a
    calendar, a clock face, a chart). Default comes from assets.PRINTED. The
    ordinary prompt bans text so watermarks stay out, and that ban is what kept
    erasing the calendar's day grid.
    """
    RAW.mkdir(parents=True, exist_ok=True)
    if printed is None:
        printed = name in PRINTED
    job = f"kit_{name}_{int(time.time())}"
    full = STYLE + prompt + " " + (CUTOUT_PRINTED if printed else CUTOUT)
    for attempt in range(1, tries + 1):
        p = _run(["image", "--transparent", "--prompt", full, "--name", job, "--out", str(RAW / f"{name}.png"),
                  "--no-wait"])
        if p.returncode != 0:
            print(f"  {name}: submit failed {p.stdout[:120]!r}")
            continue
        deadline = time.time() + wait
        while time.time() < deadline:
            q = _run(["image", "--poll", job, "--out", str(RAW / f"{name}.png")])
            text = q.stdout.decode("utf-8", "replace")
            if '"completed"' in text:
                break
            if '"failed"' in text:
                print(f"  {name}: provider failed, retrying")
                break
            time.sleep(8)
        path = RAW / f"{name}.png"
        if not path.exists():
            continue
        keyed, report = I.remove_background(Image.open(path))
        if report["cropped"]:
            print(f"  {name}: attempt {attempt} rejected (subject runs into the frame edge)")
            continue
        if report["flat_bg"] is False and report["removed_px"] == 0:
            print(f"  {name}: attempt {attempt} rejected (backdrop is not a flat colour)")
            continue
        blank, ratio, detail = blank_subject(keyed)
        if blank:
            print(f"  {name}: attempt {attempt} rejected (nothing drawn inside the subject: {detail})")
            continue
        report["linework"] = round(ratio, 4)
        print(f"  {name}: attempt {attempt} accepted (bg={report['bg_rgb']}, {detail})")
        if check_vision:
            report["vision"] = review(name, prompt, path)
        return report
    print(f"  {name}: no acceptable generation after {tries} attempts")
    return None


def import_from(paths, verbose=True):
    """Copy existing raw generations into the library."""
    RAW.mkdir(parents=True, exist_ok=True)
    for src, dest in paths:
        src = Path(src)
        if src.exists():
            shutil.copyfile(src, RAW / dest)
            if verbose:
                print(f"  imported {dest}")
        elif verbose:
            print(f"  missing {src}")


def contact_sheet(dest, cols=8, cell=(300, 220)):
    """One labelled sheet of every cut sprite, so a human can spot a bad one.

    The automated gates catch geometry and emptiness. "This is clean and the wrong
    object" is not reliably detectable, so the pipeline hands that judgement to a
    person with one glance at one image instead of pretending to check it.
    """
    names = cut_names()
    rows = (len(names) + cols - 1) // cols
    sheet = np.zeros((cell[1] * (rows + 1), cell[0] * cols, 3), np.uint8)
    for i, name in enumerate(names):
        sprite = element(name)
        if sprite is None:
            continue
        bg = Image.new("RGB", (sprite.shape[1], sprite.shape[0]), (0, 0, 0))
        bg.paste(Image.fromarray(sprite), (0, 0), Image.fromarray(sprite))
        sc = min((cell[0] - 10) / bg.width, (cell[1] - 10) / bg.height, 1.0)
        bg = bg.resize((max(1, int(bg.width * sc)), max(1, int(bg.height * sc))))
        arr = np.array(bg)
        y = (i // cols) * cell[1] + (cell[1] - arr.shape[0]) // 2
        x = (i % cols) * cell[0] + (cell[0] - arr.shape[1]) // 2
        sheet[y : y + arr.shape[0], x : x + arr.shape[1]] = arr
    Image.fromarray(sheet).save(dest, quality=90)
    return dest
