"""文案认字 + ASR 对时 + 气口切窗 → ASS（关键词加粗放大变色）→ 默认叠画面硬烧。

对时模型（对齐 Hypit SemanticTake 思路）：
- 旁白脚本 = 唯一认字源；ASR 只提供声学时间证据
- 镜/Take 内做确定性编辑距离对齐；禁止整片比例拉伸当主路径
- 未匹配字在左右已测邻字之间做连续加权插值（不发明孤立点时间）
- 气口窗内用仿射映射保留相对时序，禁止等权重铺抹掉 DP 结果
- 统一时钟：ASR 音轨须与成片等长；多镜先 A/V pad 再 concat，优先分镜 stitch

其它：
- 长气口留白；关键词用 ASS 局部样式轮换强调
- 默认 band=0 叠原画面；用户要字幕条再 --band 96
- 可选顶部章节条（--chapters）：画幅向上加高，进度随片长走动
"""
from __future__ import annotations

import json
import os
import re
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

SUB_BAND_H = 0  # 默认叠在原画面上；用户要字幕条时再 --band 96
MAX_CHARS = 18
MIN_CHARS = 4
STORY_MAX_CHARS = 20  # 分镜句比字幕略宽，但仍切开长句以免音画不同步
PAUSE_GAP = 0.25  # 检测用
HOLD_SILENCE = 0.35  # 长气口才留白
FILL_GAP = 0.28  # 仅短于此的缝才把上一条字幕接到下一条
TAIL_PAD = 0.12  # 句末多挂一点，盖住尾音
MIN_CHAR_SEC = 0.15
MIN_CUE_SEC = 0.75
# 得意黑 Smiley Sans（斜体，短视频字幕更耐看）；可用 SUB_FONT_FILE / --font 覆盖
FONT = "Smiley Sans Oblique"
FONT_FILE = Path(os.environ.get(
    "SUB_FONT_FILE",
    str(Path.home() / r"AppData\Local\Microsoft\Windows\Fonts\SmileySans-Oblique.otf"),
))
if not FONT_FILE.exists():
    # 回退：本机其他常见好看中文字体
    for cand, name in (
        (Path(r"C:\Windows\Fonts\Source Han Serif SC Heavy (TrueType).ttf"), "Source Han Serif SC Heavy"),
        (Path(r"C:\Windows\Fonts\STKAITI.TTF"), "STKaiti"),
        (Path(r"C:\Windows\Fonts\MiSans-Regular.otf"), "MiSans"),
    ):
        if cand.exists():
            FONT_FILE = cand
            FONT = name
            break
FONTS_DIR = FONT_FILE.parent if FONT_FILE.exists() else Path(os.environ.get("WINDIR", r"C:\Windows")) / "Fonts"
BOARD_BG = "0x0b241c"
MAX_KEYWORDS_PER_CUE = 2
FONT_SIZE = 0  # 0=按宽度自动：≥1080→40，否则 36
KW_SIZE_BOOST = None  # None=用 KEYWORD_STYLES 里各自的 d；整数=统一放大
MARGIN_V = None  # None：band>0 用 band/4；band=0 用 OVERLAY_MARGIN_V
OUTLINE = 2
PRIMARY_COLOUR = "&H00FFFFFF"  # ASS AABBGGRR 白
NO_KEYWORDS = False
ENCODE_CRF = 16
# 字幕条与画面交界羽化高度（px）；0=硬边。band=0 时自动不用
FEATHER_H = 32
OVERLAY_MARGIN_V = 36  # 叠画面默认底边距
AUDIO_LONGER_EPS = 0.05  # 音轨比成片长超过该秒数则裁齐
# 顶部章节进度条：启用 chapters 时**向上加高画幅**（不叠在画面上），底边进度随片长走动
# 黑板粉笔风：分隔线 + 大号章名；ASS \1c=BBGGRR；\1a=AA（00不透）
CHAPTER_BAR_H = 52
CHAPTER_FONT_SIZE = 22  # 章名默认更大更清晰；0=按段宽自动
CHAPTER_IDLE_COLOUR = "&HC8D0C4"  # 未激活：浅粉笔灰
CHAPTER_ACTIVE_COLOUR = "&HECF8FD"  # 激活：粉笔亮 #fdf8ec
CHAPTER_BAR_COLOUR = "&H1C240B"  # 加高区墨绿（近 #0b241c）
CHAPTER_BAR_ALPHA = "&H00&"
CHAPTER_DIV_COLOUR = "&HB8C8B0"  # 粉笔分隔线
CHAPTER_DIV_ALPHA = "&H40&"
CHAPTER_ACTIVE_UNDER = "&HECF8FD"
CHAPTER_PROGRESS_COLOUR = "&HECF8FD"  # 粉笔亮进度
CHAPTER_PROGRESS_ALPHA = "&H30&"
CHAPTER_TIP_COLOUR = "&HECF8FD"
CHAPTER_LABEL_OUTLINE = "&H0B1A08"
CHAPTER_LABEL_OUTLINE_A = "&H40&"
CHAPTER_DIV_PAD = 8  # 分隔线上下留白


@dataclass
class ChapterPlan:
    """顶部章节进度条（默认不启用；烧录显式传入才画）。

    进度填充随片长 0→100% 连续走动；章名可固定 current，或用 ranges 按时切换高亮。
    """

    titles: list[str]
    current: int = 0
    ranges: list[tuple[float, float]] | None = None


@dataclass
class BurnOptions:
    """烧录外观与切句细节；未填字段用模块默认。"""

    band_h: int | None = None
    bg: str | None = None
    font_size: int | None = None
    kw_size_boost: int | None = None
    max_keywords: int | None = None
    max_chars: int | None = None
    margin_v: int | None = None
    outline: int | None = None
    primary_colour: str | None = None
    no_keywords: bool | None = None
    hold_silence: float | None = None
    fill_gap: float | None = None
    pause_gap: float | None = None
    encode_crf: int | None = None
    feather_h: int | None = None
    chapter_bar_h: int | None = None
    chapter_font_size: int | None = None


def apply_options(opt: BurnOptions | None) -> None:
    """把 BurnOptions / CLI 写进模块全局（影响本进程后续烧录）。"""
    if not opt:
        return
    global SUB_BAND_H, BOARD_BG, FONT_SIZE, KW_SIZE_BOOST, MAX_KEYWORDS_PER_CUE
    global MAX_CHARS, MARGIN_V, OUTLINE, PRIMARY_COLOUR, NO_KEYWORDS
    global HOLD_SILENCE, FILL_GAP, PAUSE_GAP, ENCODE_CRF, FEATHER_H
    global CHAPTER_BAR_H, CHAPTER_FONT_SIZE
    if opt.band_h is not None:
        SUB_BAND_H = int(opt.band_h)
    if opt.bg is not None:
        BOARD_BG = str(opt.bg)
    if opt.font_size is not None:
        FONT_SIZE = int(opt.font_size)
    if opt.kw_size_boost is not None:
        KW_SIZE_BOOST = int(opt.kw_size_boost)
    if opt.max_keywords is not None:
        MAX_KEYWORDS_PER_CUE = max(0, int(opt.max_keywords))
    if opt.max_chars is not None:
        MAX_CHARS = max(4, int(opt.max_chars))
    if opt.margin_v is not None:
        MARGIN_V = int(opt.margin_v)
    if opt.outline is not None:
        OUTLINE = max(0, int(opt.outline))
    if opt.primary_colour is not None:
        PRIMARY_COLOUR = str(opt.primary_colour)
    if opt.feather_h is not None:
        FEATHER_H = max(0, int(opt.feather_h))
    if opt.no_keywords is not None:
        NO_KEYWORDS = bool(opt.no_keywords)
    if opt.hold_silence is not None:
        HOLD_SILENCE = float(opt.hold_silence)
    if opt.fill_gap is not None:
        FILL_GAP = float(opt.fill_gap)
    if opt.pause_gap is not None:
        PAUSE_GAP = float(opt.pause_gap)
    if opt.encode_crf is not None:
        ENCODE_CRF = int(opt.encode_crf)
    if opt.chapter_bar_h is not None:
        CHAPTER_BAR_H = max(0, int(opt.chapter_bar_h))
    if opt.chapter_font_size is not None:
        CHAPTER_FONT_SIZE = max(0, int(opt.chapter_font_size))


def set_font(font_file: Path | str, font_name: str | None = None) -> None:
    """指定烧录字体文件；font_name 写入 ASS Fontname（缺省用文件名去后缀）。"""
    global FONT, FONT_FILE, FONTS_DIR
    path = Path(font_file)
    if not path.is_file():
        raise FileNotFoundError(f"字体不存在: {path}")
    FONT_FILE = path
    FONTS_DIR = path.parent
    if font_name:
        FONT = font_name
    else:
        # 常见注册名：minecraft.ttf → Minecraft；带中文前缀的像素包用 Minecraft AE Pixel
        stem = path.stem
        low = stem.lower()
        if low == "minecraft":
            FONT = "Minecraft"
        elif "minecraft" in low and ("中英" in stem or "ae" in low or "pixel" in low or "苦力怕" in stem):
            FONT = "Minecraft AE Pixel"
        else:
            FONT = stem
    print(f"  subtitle: font={FONT} file={FONT_FILE}")

# 软切点（仅助词尾巴）；不要放「都/还/就」等，否则会切成「谁都|能」
SOFT_AFTER = set("的了着过呢吧啊呀嘛么")

# ASS PrimaryColour 为 &HAABBGGRR&；轮换粉笔强调色
KEYWORD_STYLES = (
    {"c": "00E5FF", "d": 14},  # 粉笔黄
    {"c": "5C6CFF", "d": 16},  # 浅红
    {"c": "7CF5A0", "d": 12},  # 薄荷绿
    {"c": "FFB060", "d": 14},  # 天蓝
    {"c": "80D0FF", "d": 15},  # 浅橙
)

# 默认词表（财经/短视频常用）；项目词用 --keywords / SUB_KEYWORDS_FILE / SUB_EXTRA_KEYWORDS 追加
_DEFAULT_KEYWORDS = {
    "公开信息", "因果链", "认知差", "定义问题", "证据分级", "统一口径",
    "主动找反证", "版本复盘", "研究闭环", "可持续优势", "正式披露",
    "增长质量", "竞争优势", "利润暴增", "毛利率", "应收账款",
    "一次性收益", "替代解释", "暂不下结论", "不确定性",
    "超卖共振", "金叉", "死叉", "低吸点", "仓位",
    "事实", "希望", "反证", "信仰", "假设", "验证", "口径",
    "证据", "风险", "估值", "利润", "现金", "收入", "并表",
    "补贴", "因果", "复盘", "约束", "散户", "机构", "消息",
    "判断", "结论", "来源", "间接", "保守", "源头", "分级",
    "问题", "材料", "方法", "堆料", "披露", "访谈", "推断",
    "开源模型", "MiniMaxH3", "MiniMax", "ComfyUI", "GitHub",
    "注意力经济", "工具链", "战略合作", "视觉中国", "腾讯云",
    "支付宝", "TokenPay", "海光K100", "国产算力", "生态话语权",
    "框架协议", "企业服务", "收费功能", "支付通道", "智能体",
    "基础设施", "训练数据", "素材库", "云资源", "财务数据",
    "公关稿", "蹭热点", "播放量", "工作流", "创作者",
    "B站", "开源", "算力", "插件", "教程", "热度", "业绩",
    "财报", "利润", "落地", "生态", "合作", "A股",
    "豆包工作", "火山引擎", "天龙集团", "麦田能源", "利好出尽",
    "办公入口", "空中楼阁", "字节概念", "AI办公", "年化收入",
    "40亿美元", "商业化", "平台化", "36氪", "财联社",
    "豆包", "TRAE", "扣子", "飞书", "字节",
    "商业航天", "可回收火箭", "价值投资", "主题炒作", "华源证券",
    "评论区", "等数据", "先上车",
    "航天航空", "科创五十", "创业板", "沪指", "深成指",
    "半导体材料", "产能供应", "算力指数", "半导体指数", "半导体",
    "新能源车", "长单", "上证",
    "看涨吞没", "看跌吞没", "上吊线", "锤子线", "十字星", "大阳线", "大阴线",
    "上影线", "下影线", "阳线", "阴线", "影线", "实体", "成交量", "K线",
    "阻力支撑转换", "支撑位", "阻力位", "放量突破", "缩量突破", "创新药",
    "药明康德", "反身性", "市场先生", "格雷厄姆", "CRO",
    "锚定效应", "成本价", "历史高点", "回本", "空仓", "估值", "薇语录",
    "均线粘合", "五日均线", "二十日均线", "六十日均线", "金叉", "死叉",
    "均线", "江恩", "算力", "滞后性",
    "追高", "定投", "预承诺", "回本", "满仓", "再平衡", "风口",
    "GPT-6", "Astra", "AGI", "OpenAI", "OSWorld", "英伟达", "Hugging Face",
    "算力", "芯片", "纳指", "道指",
    "并购", "重组", "破产", "清算", "融资", "IPO", "估值", "市值", "市盈率",
    "股权", "注册资本", "固定资产", "折旧", "无形资产", "摊销", "负债", "抵押",
    "降准", "利率", "汇率", "货币政策", "碳中和", "ESG",
}
KEYWORDS = sorted(_DEFAULT_KEYWORDS, key=len, reverse=True)
_AUTO_KW = re.compile(r"[A-Za-z][A-Za-z0-9]{1,}|\d+[万条步倍%]?|[零一二三四五六七八九十百千万]+[万条步倍]")


def set_keywords(extra: list[str] | None = None, *, replace: bool = False) -> None:
    """合并/替换关键词表（长词优先）。"""
    global KEYWORDS
    base = set() if replace else set(_DEFAULT_KEYWORDS)
    for w in extra or []:
        w = (w or "").strip()
        if w:
            base.add(w)
    KEYWORDS = sorted(base, key=len, reverse=True)


def load_keywords_file(path: Path) -> list[str]:
    """每行一个词；# 开头忽略。"""
    out: list[str] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        s = line.strip()
        if not s or s.startswith("#"):
            continue
        out.append(s)
    return out

_model = None


@dataclass
class Cue:
    text: str
    start: float
    end: float
    keywords: list[str] = field(default_factory=list)
    style_idx: int = 0


def _run(cmd: list[str], check: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(
        cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", check=check
    )


def ffprobe_duration(path: Path) -> float:
    r = _run(
        ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_format", str(path)]
    )
    return float(json.loads(r.stdout)["format"]["duration"])


def ensure_audio_matches_video(audio: Path, video: Path, work: Path) -> Path:
    """ASR/对时用音轨必须与成片画面同长、同轴。

    常见坑：
    1) 旁白母带比成片长 → 尾条字幕轴漂到画面之后；
    2) 成片音轨 DTS/PTS 乱跳，直接 -vn 抽出会「解开」成更长的 PCM（例如画面 273s、抽出 274s），
       越到结尾越「跟不上」。

    策略：成片有音轨时，用 aresample=async 按视频时长重拉；否则把传入音轨裁到视频时长。
    """
    v_dur = max(ffprobe_duration(video), 0.1)
    has_a = False
    try:
        r = _run(
            [
                "ffprobe", "-v", "quiet", "-select_streams", "a:0",
                "-show_entries", "stream=index", "-of", "csv=p=0", str(video),
            ]
        )
        has_a = bool((r.stdout or "").strip())
    except Exception:
        has_a = False

    out = work / f"_asr_audio_{v_dur:.3f}s.wav"
    if has_a:
        a_dur = ffprobe_duration(audio) if audio.exists() else v_dur
        if abs(a_dur - v_dur) > AUDIO_LONGER_EPS:
            print(
                f"  subtitle: WARN audio/video duration mismatch "
                f"(audio≈{a_dur:.3f}s video={v_dur:.3f}s) → re-pull from video w/ async",
                flush=True,
            )
        else:
            print(f"  subtitle: ASR audio from video ({v_dur:.3f}s, aresample=async)", flush=True)
        _run(
            [
                "ffmpeg", "-y",
                "-i", str(video),
                "-vn",
                "-af", "aresample=async=1:first_pts=0",
                "-t", f"{v_dur:.3f}",
                "-ac", "1", "-ar", "16000",
                "-c:a", "pcm_s16le",
                str(out),
            ]
        )
        return out

    a_dur = ffprobe_duration(audio)
    if a_dur <= v_dur + AUDIO_LONGER_EPS:
        return audio
    print(
        f"  subtitle: WARN audio longer than video "
        f"({a_dur:.3f}s > {v_dur:.3f}s) → trim for ASR/timing",
        flush=True,
    )
    _run(
        [
            "ffmpeg", "-y",
            "-i", str(audio),
            "-af", f"atrim=duration={v_dur:.3f},asetpts=PTS-STARTPTS",
            "-ac", "1", "-ar", "16000",
            "-c:a", "pcm_s16le",
            str(out),
        ]
    )
    return out


def probe_wh(video: Path) -> tuple[int, int]:
    r = _run(
        [
            "ffprobe", "-v", "quiet", "-select_streams", "v:0",
            "-show_entries", "stream=width,height", "-of", "json", str(video),
        ]
    )
    st = json.loads(r.stdout)["streams"][0]
    return int(st["width"]), int(st["height"])


def content_chars(text: str) -> str:
    """去掉空白与所有标点，只留汉字/字母/数字。"""
    return re.sub(r"[^\u4e00-\u9fffA-Za-z0-9]", "", text or "")


def _repair_keyword_splits(chunks: list[str], max_chars: int) -> list[str]:
    """若切点落在关键词中间，合并相邻条（略放宽 max_chars）。"""
    if len(chunks) < 2:
        return chunks
    kws = [kw for kw in KEYWORDS if len(kw) >= 2]
    out = [chunks[0]]
    for c in chunks[1:]:
        left = out[-1]
        merged = left + c
        boundary = len(left)
        straddles = False
        for kw in kws:
            start = 0
            while True:
                j = merged.find(kw, start)
                if j < 0:
                    break
                if j < boundary < j + len(kw):
                    straddles = True
                    break
                start = j + 1
            if straddles:
                break
        if straddles and len(merged) <= max_chars + max(4, min(8, len(c))):
            out[-1] = merged
        else:
            out.append(c)
    return out


def split_subs(text: str, max_chars: int | None = None) -> list[str]:
    """文案优先：先按句读切，再软切超长段；上屏无标点。"""
    if max_chars is None:
        max_chars = MAX_CHARS
    t = re.sub(r"\s+", "", text or "")
    if not t:
        return []
    # 1) 强标点 → 句
    rough = re.split(r"(?<=[。！？；!?;])", t)
    units: list[str] = []
    for part in rough:
        part = part.strip()
        if not part:
            continue
        # 2) 逗号等弱标点
        bits = re.split(r"(?<=[，、,:])", part)
        for bit in bits:
            body = content_chars(bit)
            if body:
                units.append(body)

    # 3) 超长段按软切点拆，禁止硬切双字词中部（尽量）
    chunks: list[str] = []
    for u in units:
        chunks.extend(_soft_split(u, max_chars))

    # 4) 过短残片并回相邻
    chunks = _merge_short(chunks, MIN_CHARS, max_chars)
    # 5) 关键词跨条则合并
    return _repair_keyword_splits(chunks, max_chars)


def split_story_sents(text: str, max_chars: int = STORY_MAX_CHARS) -> list[str]:
    """保留标点的口播切句。句号必切；超长再按逗号/助词切开。"""
    t = re.sub(r"\s+", "", text or "")
    if not t:
        return []
    rough = [p.strip() for p in re.split(r"(?<=[。！？；!?;])", t) if p.strip()]
    chunks: list[str] = []
    for part in rough:
        chunks.extend(_split_long_story(part, max_chars))
    return _merge_short_story(chunks, MIN_CHARS, max_chars) or [t]


def _split_long_story(text: str, max_chars: int) -> list[str]:
    if len(content_chars(text)) <= max_chars:
        return [text] if text else []
    bits = [b for b in re.split(r"(?<=[，、,])", text) if b]
    groups: list[str] = []
    buf = ""
    if len(bits) > 1:
        for b in bits:
            trial = buf + b
            if buf and len(content_chars(trial)) > max_chars:
                groups.append(buf)
                buf = b
            else:
                buf = trial
        if buf:
            groups.append(buf)
    else:
        groups = [text]
    out: list[str] = []
    for g in groups:
        if len(content_chars(g)) > max_chars:
            out.extend(_soft_split_keep_punct(g, max_chars))
        else:
            out.append(g)
    return out


def _soft_split_keep_punct(text: str, max_chars: int) -> list[str]:
    body = content_chars(text)
    cuts = _soft_split(body, max_chars)
    if len(cuts) <= 1:
        return [text] if text else []
    out: list[str] = []
    ti = 0
    for ci, chunk in enumerate(cuts):
        need = len(chunk)
        got = 0
        start = ti
        while ti < len(text) and got < need:
            if content_chars(text[ti]):
                got += 1
            ti += 1
        if ci < len(cuts) - 1:
            while ti < len(text) and not content_chars(text[ti]):
                ti += 1
        else:
            ti = len(text)
        piece = text[start:ti]
        if piece:
            out.append(piece)
    return out


def _merge_short_story(chunks: list[str], min_chars: int, max_chars: int) -> list[str]:
    if not chunks:
        return []
    merged: list[str] = []
    for c in chunks:
        n = len(content_chars(c))
        prev_n = len(content_chars(merged[-1])) if merged else 0
        prev_hard = bool(merged) and merged[-1][-1:] in "。！？；!?;"
        if merged and (not prev_hard) and n < 8 and prev_n + n <= max_chars + 8:
            merged[-1] = merged[-1] + c
        elif merged and (not prev_hard) and prev_n < 8 and prev_n + n <= max_chars + 8:
            merged[-1] = merged[-1] + c
        else:
            merged.append(c)
    return merged


def sentence_timestamps(
    narration: str,
    audio: Path,
    work_dir: Path,
) -> list[dict]:
    """用现有音轨 ASR 给每句打时间戳，不改语音。写入 work_dir/sentences.json。"""
    sents = split_story_sents(narration)
    duration = ffprobe_duration(audio)
    try:
        timeline = asr_char_timeline(audio, work_dir)
    except Exception:
        timeline = []
    silences = detect_silences(audio, work_dir)
    bodies = [content_chars(s) for s in sents]
    full = "".join(bodies)
    times = align_chars_to_times_smart(full, timeline, duration, silences)
    idx = 0
    out: list[dict] = []
    for sent, body in zip(sents, bodies):
        n = len(body)
        if n <= 0:
            continue
        seg = times[idx : idx + n]
        start = _snap_start_to_speech(float(seg[0][0]), silences)
        end = min(duration, float(seg[-1][1]))
        if end <= start:
            end = min(duration, start + max(0.4, n * MIN_CHAR_SEC))
        out.append({
            "text": sent,
            "startMs": int(round(start * 1000)),
            "endMs": int(round(end * 1000)),
        })
        idx += n
    for i in range(1, len(out)):
        if out[i]["startMs"] < out[i - 1]["endMs"]:
            out[i]["startMs"] = out[i - 1]["endMs"]
        if out[i]["endMs"] <= out[i]["startMs"]:
            out[i]["endMs"] = out[i]["startMs"] + 400
    if out:
        last_cap = int(round(duration * 1000))
        if out[-1]["endMs"] > last_cap:
            out[-1]["endMs"] = last_cap
    dest = work_dir / "sentences.json"
    dest.write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return out


def _soft_split(text: str, max_chars: int) -> list[str]:
    if len(text) <= max_chars:
        return [text] if text else []
    out: list[str] = []
    i = 0
    n = len(text)
    while i < n:
        remain = n - i
        if remain <= max_chars:
            out.append(text[i:])
            break
        window = text[i : i + max_chars]
        cut = -1
        # 优先助词后；其次在窗口中后段找「是/在/和/与/而/但」之后
        for j in range(len(window) - 1, MIN_CHARS - 1, -1):
            if window[j] in SOFT_AFTER:
                cut = j + 1
                break
        if cut < 0:
            for j in range(len(window) - 1, max(MIN_CHARS, max_chars // 2) - 1, -1):
                if window[j] in "是在和与而但":
                    cut = j + 1
                    break
        if cut < 0:
            cut = max_chars
        cut = _nudge_cut_off_keywords(text[i : i + max_chars + 12], cut)
        if cut < MIN_CHARS:
            cut = max_chars
        # 避免留下过短尾巴
        if remain - cut < MIN_CHARS and remain <= max_chars + MIN_CHARS:
            out.append(text[i:])
            break
        out.append(text[i : i + cut])
        i += cut
    return [c for c in out if c]


def _nudge_cut_off_keywords(span: str, cut: int) -> int:
    """切点落在关键词中间则挪到词前；词前太短则挪到词后。"""
    extra = ("第一", "第二", "第三", "第四", "第五", "核心", "并表", "时点")
    if cut <= 0 or cut >= len(span):
        return cut
    for kw in list(KEYWORDS) + list(extra):
        if len(kw) < 2:
            continue
        p = 0
        while True:
            j = span.find(kw, p)
            if j < 0:
                break
            if j < cut < j + len(kw):
                before = j
                after = j + len(kw)
                if before >= MIN_CHARS:
                    return before
                if after <= len(span):
                    return after
                return before if before > 0 else after
            p = j + 1
    return cut


def _merge_short(chunks: list[str], min_chars: int, max_chars: int) -> list[str]:
    if not chunks:
        return []
    merged: list[str] = []
    for c in chunks:
        if merged and len(c) < min_chars and len(merged[-1]) + len(c) <= max_chars + 2:
            merged[-1] = merged[-1] + c
        elif merged and len(merged[-1]) < min_chars and len(merged[-1]) + len(c) <= max_chars + 2:
            merged[-1] = merged[-1] + c
        else:
            merged.append(c)
    return merged


def get_model():
    global _model
    if _model is None:
        from faster_whisper import WhisperModel

        name = os.environ.get("WHISPER_MODEL", "").strip() or "small"
        _model = WhisperModel(name, device="cpu", compute_type="int8")
    return _model


def asr_char_timeline(audio: Path, cache_dir: Path) -> list[tuple[str, float, float]]:
    """每个 ASR 字的 (char, start, end)。

    默认关闭 Whisper VAD（VAD 常吃掉句尾气音/末字，导致末字幕漂移、尾句像没烧上）。
    需要 VAD 时设环境变量 SUB_ASR_VAD=1。缓存 _asr_v3_*.json。
    """
    use_vad = os.environ.get("SUB_ASR_VAD", "0").strip().lower() in ("1", "true", "yes")
    cache = cache_dir / f"_asr_v3_{audio.stem}{'_vad' if use_vad else ''}.json"
    if cache.is_file() and cache.stat().st_mtime >= audio.stat().st_mtime:
        raw = json.loads(cache.read_text(encoding="utf-8"))
        items = raw.get("items", raw)
        out: list[tuple[str, float, float]] = []
        for x in items:
            if len(x) >= 3:
                out.append((str(x[0]), float(x[1]), float(x[2])))
            elif len(x) == 2:
                out.append(("·", float(x[0]), float(x[1])))
        return out

    model = get_model()
    kwargs = dict(language="zh", word_timestamps=True, vad_filter=use_vad)
    if use_vad:
        # 即便开 VAD，也给首尾多留一点，减少吃字
        kwargs["vad_parameters"] = dict(
            min_silence_duration_ms=400,
            speech_pad_ms=400,
        )
    segments, _info = model.transcribe(str(audio), **kwargs)
    timeline: list[tuple[str, float, float]] = []
    for seg in segments:
        for w in seg.words or []:
            token = content_chars(w.word or "")
            if not token:
                continue
            n = len(token)
            span = max(w.end - w.start, 0.04)
            step = span / n
            for i, ch in enumerate(token):
                timeline.append((ch, w.start + i * step, w.start + (i + 1) * step))
    cache.write_text(
        json.dumps(
            {"v": 3, "vad": use_vad, "items": [[c, a, b] for c, a, b in timeline]},
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    if timeline:
        print(
            f"  subtitle: ASR chars={len(timeline)} "
            f"span={timeline[0][1]:.2f}→{timeline[-1][2]:.2f}s vad={use_vad}"
        )
    return timeline


def detect_silences(audio: Path, cache_dir: Path) -> list[tuple[float, float]]:
    cache = cache_dir / f"_sil_{audio.stem}.json"
    if cache.is_file() and cache.stat().st_mtime >= audio.stat().st_mtime:
        return [tuple(x) for x in json.loads(cache.read_text(encoding="utf-8"))]

    proc = _run(
        [
            "ffmpeg", "-hide_banner", "-i", str(audio),
            "-af", f"silencedetect=noise=-30dB:d={PAUSE_GAP}",
            "-f", "null", "-",
        ],
        check=False,
    )
    starts: list[float] = []
    ends: list[float] = []
    for line in (proc.stderr or "").splitlines():
        if "silence_start:" in line:
            starts.append(float(line.split("silence_start:")[1].strip()))
        elif "silence_end:" in line:
            ends.append(float(line.split("silence_end:")[1].split("|")[0].strip()))
    silences = list(zip(starts, ends[: len(starts)]))
    cache.write_text(json.dumps(silences), encoding="utf-8")
    return silences


def _proportional_times(n_chars: int, clip_dur: float) -> list[tuple[float, float]]:
    """无任何声学证据时的最后手段（整段均分）。有 ASR 时禁止走这里当主路径。"""
    if n_chars <= 0:
        return []
    step = clip_dur / n_chars
    return [(i * step, (i + 1) * step) for i in range(n_chars)]


def _proportional_map_to_asr(
    n_chars: int, asr: list[tuple[str, float, float]], clip_dur: float
) -> list[tuple[float, float]]:
    """遗留：旁白字数与 ASR 字数按比例拉伸（后半段易漂移）。仅 char_times_for_text 无旁白时用。"""
    if n_chars <= 0:
        return []
    if not asr:
        return _proportional_times(n_chars, clip_dur)
    L = len(asr)
    out: list[tuple[float, float]] = []
    for i in range(n_chars):
        i0 = int(i / n_chars * L)
        i1 = max(i0 + 1, int((i + 1) / n_chars * L))
        i0 = min(i0, L - 1)
        i1 = min(max(i1, i0 + 1), L)
        out.append((asr[i0][1], asr[i1 - 1][2]))
    return out


def _fill_gaps_between_neighbors(
    times: list[tuple[float, float] | None],
    clip_dur: float,
) -> list[tuple[float, float]]:
    """Hypit 式：缺失字在左右已测邻界之间连续加权插值，不发明孤立点时间。"""
    n = len(times)
    if n == 0:
        return []
    if all(t is None for t in times):
        step = max(0.02, clip_dur / n)
        return [(i * step, min(clip_dur, (i + 1) * step)) for i in range(n)]

    # 前缀无锚：从 0 铺到第一个锚点起点
    if times[0] is None:
        first = next(i for i, t in enumerate(times) if t is not None)
        t0 = 0.0
        t1 = float(times[first][0])  # type: ignore[index]
        for k in range(first):
            a = t0 + (t1 - t0) * k / first
            b = t0 + (t1 - t0) * (k + 1) / first
            times[k] = (a, max(a + 0.02, b))

    # 后缀无锚：从末锚终点铺到片尾
    if times[-1] is None:
        last = next(i for i in range(n - 1, -1, -1) if times[i] is not None)
        t0 = float(times[last][1])  # type: ignore[index]
        t1 = clip_dur
        gap = n - 1 - last
        for j, k in enumerate(range(last + 1, n)):
            a = t0 + (t1 - t0) * j / gap
            b = t0 + (t1 - t0) * (j + 1) / gap
            times[k] = (a, max(a + 0.02, b))

    i = 0
    while i < n:
        if times[i] is not None:
            i += 1
            continue
        left = i - 1
        right = i
        while right < n and times[right] is None:
            right += 1
        t_left = float(times[left][1])  # type: ignore[index]
        t_right = float(times[right][0])  # type: ignore[index]
        if t_right < t_left + 0.02:
            t_right = min(clip_dur, t_left + 0.02 * (right - left))
        holes = right - i
        for j, k in enumerate(range(i, right)):
            a = t_left + (t_right - t_left) * (j + 1) / (holes + 1)
            b = t_left + (t_right - t_left) * (j + 2) / (holes + 1)
            if j == holes - 1:
                b = t_right
            times[k] = (a, max(a + 0.02, b))
        i = right

    out: list[tuple[float, float]] = []
    prev_end = 0.0
    for a, b in times:  # type: ignore[misc]
        a = max(float(a), prev_end)
        b = max(float(b), a + 0.02)
        b = min(b, clip_dur)
        if a >= clip_dur:
            a = max(0.0, clip_dur - 0.04)
            b = clip_dur
        out.append((a, b))
        prev_end = a
    return out


def align_chars_to_times(
    narr: str,
    asr: list[tuple[str, float, float]],
    clip_dur: float,
) -> list[tuple[float, float]]:
    """旁白字 ↔ ASR 字做编辑距离对齐，再取时间。弱匹配也保留 DP+邻域插值，不回退比例拉伸。"""
    narr_chars = list(narr or "")
    n = len(narr_chars)
    if n <= 0:
        return []
    if not asr:
        return _proportional_times(n, clip_dur)
    # 窗内占位「·」：无真实字符，仅用该窗时间范围做邻域插值锚
    if all(c == "·" for c, _, _ in asr):
        w0, w1 = float(asr[0][1]), float(asr[-1][2])
        span = max(0.2, w1 - w0)
        return [
            (w0 + span * i / n, w0 + span * (i + 1) / n)
            for i in range(n)
        ]

    m = len(asr)
    asr_chars = [c for c, _, _ in asr]
    # DP：match 0 / mismatch 2 / indel 1
    dp = [[0] * (m + 1) for _ in range(n + 1)]
    bt = [[0] * (m + 1) for _ in range(n + 1)]  # 0 diag, 1 up(del narr), 2 left(ins asr)
    for i in range(1, n + 1):
        dp[i][0] = i
        bt[i][0] = 1
    for j in range(1, m + 1):
        dp[0][j] = j
        bt[0][j] = 2
    for i in range(1, n + 1):
        nc = narr_chars[i - 1]
        dpi = dp[i]
        dpim = dp[i - 1]
        bti = bt[i]
        for j in range(1, m + 1):
            cost = 0 if nc == asr_chars[j - 1] else 2
            diag = dpim[j - 1] + cost
            up = dpim[j] + 1
            left = dpi[j - 1] + 1
            if diag <= up and diag <= left:
                dpi[j] = diag
                bti[j] = 0
            elif up <= left:
                dpi[j] = up
                bti[j] = 1
            else:
                dpi[j] = left
                bti[j] = 2

    mapping = [-1] * n
    i, j = n, m
    while i > 0 or j > 0:
        if i > 0 and j > 0 and bt[i][j] == 0:
            mapping[i - 1] = j - 1
            i -= 1
            j -= 1
        elif i > 0 and (j == 0 or bt[i][j] == 1):
            i -= 1
        else:
            j -= 1

    times: list[tuple[float, float] | None] = [None] * n
    matched = 0
    for idx, aj in enumerate(mapping):
        if aj >= 0:
            times[idx] = (asr[aj][1], asr[aj][2])
            matched += 1

    ratio = matched / n if n else 0.0
    print(f"  subtitle: align match={matched}/{n} ({ratio:.0%})")
    if ratio < 0.35 and n > 20:
        print("  subtitle: align weak → keep DP + neighbor interpolate (no proportional)")
    return _fill_gaps_between_neighbors(times, clip_dur)


def _fit_times_into_window(
    times: list[tuple[float, float]], w0: float, w1: float
) -> list[tuple[float, float]]:
    """把已测字时序仿射压进语音窗，保留相对间距；禁止等权重铺抹掉 DP。"""
    if not times:
        return times
    w1 = max(w0 + 0.05, w1)
    src0 = times[0][0]
    src1 = times[-1][1]
    src_span = src1 - src0
    dst_span = w1 - w0
    if src_span < 0.05:
        # 测量几乎塌成一点：仅在窗内邻域插值
        n = len(times)
        return [
            (w0 + dst_span * i / n, w0 + dst_span * (i + 1) / n)
            for i in range(n)
        ]
    scale = dst_span / src_span
    out: list[tuple[float, float]] = []
    for a, b in times:
        na = w0 + (a - src0) * scale
        nb = w0 + (b - src0) * scale
        out.append((na, max(na + 0.02, nb)))
    # 钉死端点，避免浮点缝
    out[0] = (w0, max(w0 + 0.02, out[0][1]))
    out[-1] = (min(out[-1][0], w1 - 0.02), w1)
    # 单调
    prev = w0
    fixed: list[tuple[float, float]] = []
    for a, b in out:
        a = max(a, prev)
        b = max(b, a + 0.02)
        b = min(b, w1)
        fixed.append((a, b))
        prev = a
    fixed[-1] = (fixed[-1][0], w1)
    return fixed


def _split_text_by_weights(text: str, weights: list[int]) -> list[str]:
    n = len(text)
    if not weights:
        return [text] if text else []
    if len(weights) == 1:
        return [text]
    total = sum(max(1, w) for w in weights) or 1
    cuts: list[int] = []
    acc = 0
    for w in weights[:-1]:
        acc += max(1, w)
        cuts.append(min(n, max(cuts[-1] + 1 if cuts else 1, int(round(n * acc / total)))))
    pieces: list[str] = []
    prev = 0
    for c in cuts + [n]:
        c = max(prev, min(n, c))
        pieces.append(text[prev:c])
        prev = c
    # 空段并回
    fixed: list[str] = []
    for p in pieces:
        if not p and fixed:
            continue
        if not p:
            fixed.append("")
        else:
            fixed.append(p)
    while len(fixed) < len(weights):
        fixed.append("")
    return fixed[: len(weights)]


def _assign_asr_to_windows(
    asr: list[tuple[str, float, float]], wins: list[tuple[float, float]]
) -> list[list[tuple[str, float, float]]]:
    buckets: list[list[tuple[str, float, float]]] = [[] for _ in wins]
    if not wins:
        return buckets
    for item in asr:
        mid = (item[1] + item[2]) * 0.5
        best_i, best_d = 0, 1e9
        for i, (a, b) in enumerate(wins):
            if a - 0.08 <= mid <= b + 0.08:
                buckets[i].append(item)
                break
            d = 0.0 if a <= mid <= b else min(abs(mid - a), abs(mid - b))
            if d < best_d:
                best_d, best_i = d, i
        else:
            buckets[best_i].append(item)
    return buckets


def anchor_tail_times(
    times: list[tuple[float, float]],
    clip_dur: float,
    asr: list[tuple[str, float, float]] | None = None,
) -> list[tuple[float, float]]:
    """强制末尾盖到音轨尾：ASR/VAD 常提早结束，尾句会对不齐或像没烧上。"""
    if not times:
        return times
    asr_end = float(asr[-1][2]) if asr else clip_dur
    target = min(clip_dur, max(asr_end + TAIL_PAD, clip_dur - 0.04))
    if target <= 0.1:
        return times
    last_end = times[-1][1]
    if last_end >= target - 0.12:
        a, _b = times[-1]
        times[-1] = (min(a, target - 0.05), target)
        return times
    # 重铺最后 K 字到 target
    k = min(len(times), max(10, len(times) // 10))
    i0 = len(times) - k
    t0 = times[i0][0]
    # 若起点已经太靠后，从更早一点拉开
    if target - t0 < k * 0.05:
        t0 = max(0.0, target - max(0.8, k * MIN_CHAR_SEC))
    span = max(0.35, target - t0)
    for j, i in enumerate(range(i0, len(times))):
        a = t0 + span * j / k
        b = t0 + span * (j + 1) / k
        times[i] = (a, min(target, max(b, a + 0.02)))
    times[-1] = (times[-1][0], target)
    print(f"  subtitle: tail anchor {last_end:.2f}s → {target:.2f}s (last {k} chars)")
    return times


def align_chars_to_times_smart(
    narr: str,
    asr: list[tuple[str, float, float]],
    clip_dur: float,
    silences: list[tuple[float, float]] | None = None,
) -> list[tuple[float, float]]:
    """按气口语音窗分段 DP（Take 内对齐），仿射压窗，再尾锚到音轨结束。"""
    narr = narr or ""
    silences = silences or []
    if not narr:
        return []
    wins = speech_windows(clip_dur, silences)
    # 合并过碎窗口
    merged: list[tuple[float, float]] = []
    for a, b in wins:
        if merged and a - merged[-1][1] < 0.2 and (b - merged[-1][0]) < 12:
            merged[-1] = (merged[-1][0], b)
        else:
            merged.append((a, b))
    wins = merged or [(0.0, clip_dur)]

    use_windows = len(wins) >= 2 and len(narr) >= 48 and len(asr) >= 40
    if not use_windows:
        times = align_chars_to_times(narr, asr, clip_dur)
        return anchor_tail_times(times, clip_dur, asr)

    buckets = _assign_asr_to_windows(asr, wins)
    weights = []
    for i, bucket in enumerate(buckets):
        if bucket:
            weights.append(len(bucket))
        else:
            weights.append(max(1, int(round((wins[i][1] - wins[i][0]) * 8))))
    pieces = _split_text_by_weights(narr, weights)
    times: list[tuple[float, float]] = []
    print(f"  subtitle: windowed align wins={len(wins)}")
    for piece, bucket, (w0, w1) in zip(pieces, buckets, wins):
        if not piece:
            continue
        local_asr = bucket if bucket else [("·", w0, w1)]
        local = align_chars_to_times(piece, local_asr, clip_dur)
        # 仿射压进语音窗，保留 DP 相对时序（不再等权重铺满）
        local = _fit_times_into_window(local, w0, min(w1, clip_dur))
        times.extend(local)
    # 字数校正（权重取整误差）：邻域插值补齐，禁止堆在片尾点时间
    if len(times) < len(narr):
        pad_n = len(narr) - len(times)
        sparse: list[tuple[float, float] | None] = list(times) + [None] * pad_n
        times = _fill_gaps_between_neighbors(sparse, clip_dur)
    elif len(times) > len(narr):
        times = times[: len(narr)]
    return anchor_tail_times(times, clip_dur, asr)


def char_times_for_text(
    n_chars: int, timeline: list, clip_dur: float
) -> list[tuple[float, float]]:
    """兼容旧调用：无旁白字符串时只能比例映射。"""
    if timeline and isinstance(timeline[0], (list, tuple)) and len(timeline[0]) >= 3:
        asr = [(str(x[0]), float(x[1]), float(x[2])) for x in timeline]
        # 无文本：比例
        return _proportional_map_to_asr(n_chars, asr, clip_dur)
    if timeline and isinstance(timeline[0], (list, tuple)) and len(timeline[0]) == 2:
        asr = [("·", float(x[0]), float(x[1])) for x in timeline]
        return _proportional_map_to_asr(n_chars, asr, clip_dur)
    return _proportional_times(n_chars, clip_dur)


def speech_windows(dur: float, silences: list[tuple[float, float]]) -> list[tuple[float, float]]:
    gaps = sorted((a, b) for a, b in silences if b - a >= PAUSE_GAP)
    wins: list[tuple[float, float]] = []
    t = 0.0
    for s0, s1 in gaps:
        if s0 - t >= 0.12:
            wins.append((t, s0))
        t = max(t, s1)
    if dur - t >= 0.12:
        wins.append((t, dur))
    return wins or [(0.0, dur)]


def _long_silences(silences: list[tuple[float, float]]) -> list[tuple[float, float]]:
    return sorted((a, b) for a, b in silences if b - a >= HOLD_SILENCE)


def _snap_start_to_speech(
    t: float, silences: list[tuple[float, float]], min_sil: float = 0.15
) -> float:
    """落在静音里则推到开声，避免气口抢先出字。"""
    for s0, s1 in sorted(silences):
        if s1 - s0 < min_sil:
            continue
        if s0 - 0.03 <= t < s1:
            return s1
    return t


def align_chunks(
    text: str,
    timeline: list[tuple[float, float]],
    clip_dur: float,
    silences: list[tuple[float, float]] | None = None,
) -> list[tuple[float, float, str]]:
    """文案切条 + ASR 对时；下一句不得早于上一句说完；短缝才接字。"""
    silences = silences or []
    segments = split_subs(text)
    if not segments:
        return []
    full = "".join(segments)
    if timeline and len(timeline[0]) >= 3:
        asr_items = [(str(x[0]), float(x[1]), float(x[2])) for x in timeline]
    elif timeline and len(timeline[0]) == 2:
        asr_items = [("·", float(x[0]), float(x[1])) for x in timeline]
    else:
        asr_items = []
    times = align_chars_to_times_smart(full, asr_items, clip_dur, silences)
    long_sil = _long_silences(silences)

    raw: list[list] = []  # start, asr_end, display_end, text
    idx = 0
    for seg in segments:
        n = len(seg)
        if n <= 0:
            continue
        seg_t = times[idx : idx + n]
        if not seg_t:
            break
        start = float(seg_t[0][0])
        asr_end = float(seg_t[-1][1])
        start = _snap_start_to_speech(start, silences)
        asr_end = max(asr_end, start + max(MIN_CUE_SEC * 0.6, n * MIN_CHAR_SEC * 0.85))
        asr_end = min(asr_end, clip_dur)
        body = content_chars(seg)
        raw.append([start, asr_end, asr_end, body])
        idx += n

    # 下一句起点不得早于上一句 ASR 结束（连贯句不抢戏）
    for i in range(1, len(raw)):
        prev_asr_end = raw[i - 1][1]
        if raw[i][0] < prev_asr_end + 0.04:
            raw[i][0] = prev_asr_end + 0.04
        raw[i][0] = _snap_start_to_speech(raw[i][0], silences)
        if raw[i][1] <= raw[i][0]:
            raw[i][1] = min(clip_dur, raw[i][0] + MIN_CUE_SEC)

    # 显示结束：默认 asr_end + 尾音；仅短缝且无长气口才接到下一句
    for i in range(len(raw)):
        start, asr_end, _, body = raw[i]
        if not body:
            continue
        display_end = min(clip_dur, asr_end + TAIL_PAD)
        if i + 1 < len(raw):
            next_start = raw[i + 1][0]
            gap = next_start - asr_end
            has_long_breath = any(start < s0 < next_start for s0, _ in long_sil)
            if (not has_long_breath) and 0 < gap <= FILL_GAP:
                display_end = max(display_end, next_start - 0.04)
            elif has_long_breath:
                for s0, _s1 in long_sil:
                    if asr_end - 0.05 <= s0 < next_start:
                        display_end = min(display_end, max(asr_end, s0))
                        break
            # 绝不盖住下一句起点
            display_end = min(display_end, next_start - 0.03)
        else:
            # 末条：必须盖到音轨尾，禁止被中途静音裁掉（尾句「烧不进去」主因）
            display_end = min(clip_dur, max(asr_end + TAIL_PAD, clip_dur - 0.04))
        if display_end <= start:
            display_end = min(clip_dur, start + 0.25)
        raw[i][2] = display_end

    out: list[tuple[float, float, str]] = []
    for start, _asr_end, display_end, body in raw:
        if body and display_end > start + 0.08:
            out.append((start, display_end, body))
    return out


def ass_timestamp(t: float) -> str:
    if t < 0:
        t = 0.0
    h = int(t // 3600)
    m = int((t % 3600) // 60)
    s = t - h * 3600 - m * 60
    return f"{h}:{m:02d}:{s:05.2f}"


def pick_keywords(text: str, max_n: int | None = None) -> list[str]:
    """从词表贪心取最长命中；每条最多 max_n 个。无命中不强行拆句末字（避免强调词乱变）。"""
    if max_n is None:
        max_n = MAX_KEYWORDS_PER_CUE
    if max_n <= 0:
        return []
    hits: list[str] = []
    covered = [False] * len(text)

    def _take(kw: str, i: int) -> bool:
        if any(covered[i : i + len(kw)]):
            return False
        hits.append(kw)
        for j in range(i, i + len(kw)):
            covered[j] = True
        return True

    for kw in KEYWORDS:
        if len(hits) >= max_n:
            return hits
        start = 0
        while True:
            i = text.find(kw, start)
            if i < 0:
                break
            if _take(kw, i):
                break
            start = i + 1
    if len(hits) < max_n:
        for m in _AUTO_KW.finditer(text):
            if len(hits) >= max_n:
                break
            if len(m.group(0)) >= 2:
                _take(m.group(0), m.start())
    return hits


def style_ass_line(text: str, keywords: list[str], style_idx: int, base_fs: int) -> str:
    """把关键词包进 ASS 覆盖标签：加粗 + 放大 + 变色。"""
    body = text.replace("{", "(").replace("}", ")")
    if not keywords:
        return body
    st = KEYWORD_STYLES[style_idx % len(KEYWORD_STYLES)]
    boost = st["d"] if KW_SIZE_BOOST is None else int(KW_SIZE_BOOST)
    open_tag = f"{{\\b1\\fs{base_fs + boost}\\c&H{st['c']}&\\bord{OUTLINE}}}"
    close_tag = "{\\r}"
    # 按出现顺序替换，避免破坏已插入的标签
    spans: list[tuple[int, int, str]] = []
    used = [False] * len(body)
    for kw in sorted(keywords, key=len, reverse=True):
        i = 0
        while i <= len(body) - len(kw):
            if body[i : i + len(kw)] == kw and not any(used[i : i + len(kw)]):
                spans.append((i, i + len(kw), kw))
                for j in range(i, i + len(kw)):
                    used[j] = True
                break
            i += 1
    spans.sort(key=lambda x: x[0])
    out: list[str] = []
    cursor = 0
    for a, b, kw in spans:
        out.append(body[cursor:a])
        out.append(f"{open_tag}{kw}{close_tag}")
        cursor = b
    out.append(body[cursor:])
    return "".join(out)


def parse_chapters(
    titles: str | list[str] | None = None,
    current: int = 0,
    path: Path | None = None,
) -> ChapterPlan | None:
    """解析章节：逗号串 / 列表 / JSON 文件。

    JSON 支持：
      ["前言","结尾"]
      {"titles":[...],"current":0}
      {"chapters":[{"title":"前言","start":0,"end":12}, ...]}
    """
    if path is not None:
        raw = json.loads(Path(path).read_text(encoding="utf-8"))
        if isinstance(raw, list) and raw and isinstance(raw[0], str):
            return ChapterPlan(titles=[str(x).strip() for x in raw if str(x).strip()], current=int(current))
        if isinstance(raw, dict):
            if "chapters" in raw and isinstance(raw["chapters"], list):
                chs = raw["chapters"]
                ts: list[str] = []
                rs: list[tuple[float, float]] = []
                for c in chs:
                    if isinstance(c, dict):
                        t = str(c.get("title") or c.get("name") or "").strip()
                        if not t:
                            continue
                        ts.append(t)
                        rs.append((float(c.get("start", 0)), float(c.get("end", 0))))
                    else:
                        ts.append(str(c).strip())
                if not ts:
                    return None
                if len(rs) == len(ts) and any(b > a for a, b in rs):
                    return ChapterPlan(titles=ts, ranges=rs, current=int(raw.get("current", 0)))
                return ChapterPlan(titles=ts, current=int(raw.get("current", current)))
            ts2 = [str(x).strip() for x in (raw.get("titles") or []) if str(x).strip()]
            if ts2:
                return ChapterPlan(titles=ts2, current=int(raw.get("current", current)))
        return None
    if titles is None:
        return None
    if isinstance(titles, str):
        ts3 = [x.strip() for x in re.split(r"[,，|/]", titles) if x.strip()]
    else:
        ts3 = [str(x).strip() for x in titles if str(x).strip()]
    if not ts3:
        return None
    cur = max(0, min(int(current), len(ts3) - 1))
    return ChapterPlan(titles=ts3, current=cur)


def _chapter_windows(plan: ChapterPlan, duration: float) -> list[tuple[float, float, int]]:
    dur = max(duration, 0.1)
    if plan.ranges and len(plan.ranges) == len(plan.titles):
        out: list[tuple[float, float, int]] = []
        for i, (a, b) in enumerate(plan.ranges):
            a2 = max(0.0, float(a))
            b2 = float(b) if b and b > a2 else dur
            b2 = min(dur, max(a2 + 0.05, b2))
            out.append((a2, b2, i))
        return out or [(0.0, dur, plan.current)]
    idx = max(0, min(plan.current, len(plan.titles) - 1))
    return [(0.0, dur, idx)]


def _chapter_seg_layout(
    plan: ChapterPlan,
    width: int,
    duration: float,
) -> list[tuple[int, int, float]]:
    """每段 (x0, x1, seg_w)。有 ranges 时按时长比例占宽，避免等分错位。"""
    titles = [t for t in plan.titles if t]
    n = len(titles)
    dur = max(float(duration), 0.1)
    if plan.ranges and len(plan.ranges) == n:
        spans = []
        for a, b in plan.ranges:
            a2 = max(0.0, float(a))
            b2 = float(b) if b and b > a2 else dur
            spans.append(max(0.05, min(dur, b2) - a2))
        total = sum(spans) or 1.0
        xs: list[tuple[int, int, float]] = []
        acc = 0.0
        for i, sp in enumerate(spans):
            x0 = int(round(acc / total * width))
            acc += sp
            x1 = width if i == n - 1 else int(round(acc / total * width))
            xs.append((x0, max(x0 + 1, x1), float(x1 - x0)))
        return xs
    seg = width / n
    return [(int(i * seg), int((i + 1) * seg) if i < n - 1 else width, seg) for i in range(n)]


def _fit_chapter_label(text: str, max_chars: int) -> str:
    t = text.replace("{", "(").replace("}", ")")
    if max_chars <= 1 or len(t) <= max_chars:
        return t
    return t[: max(1, max_chars - 1)] + "…"


def chapter_ass_events(
    plan: ChapterPlan,
    width: int,
    duration: float,
    bar_h: int | None = None,
) -> list[str]:
    """顶部加高区：章名 + 粉笔风分隔线 + 底边进度随片长走动。

    段宽按 ranges 时长比例（有 ranges 时）；无尖端细线。
    """
    titles = [t for t in plan.titles if t]
    if not titles or width < 80:
        return []
    h = CHAPTER_BAR_H if bar_h is None else max(0, int(bar_h))
    if h <= 0:
        return []
    dur = max(float(duration), 0.1)
    dur_ms = max(1, int(round(dur * 1000)))
    segs = _chapter_seg_layout(plan, width, dur)
    fill_h = max(5, min(8, h // 6))
    y_mid = (h - fill_h) // 2
    a0, b0 = ass_timestamp(0.0), ass_timestamp(dur)
    lines: list[str] = []

    # 1) 加高区实底（黑板）
    lines.append(
        f"Dialogue: 5,{a0},{b0},ChapterBar,,0,0,0,,"
        f"{{\\an7\\pos(0,0)\\p1\\1c{CHAPTER_BAR_COLOUR}\\1a{CHAPTER_BAR_ALPHA}"
        f"\\bord0\\shad0}}"
        f"m 0 0 l {width} 0 {width} {h} 0 {h}{{\\p0}}\n"
    )
    # 2) 章节分隔线（粉笔细竖线，符合板书分段）
    div_pad = max(4, min(CHAPTER_DIV_PAD, h // 4))
    div_h = max(8, h - fill_h - div_pad * 2)
    for i in range(1, len(segs)):
        x = segs[i][0]
        lines.append(
            f"Dialogue: 7,{a0},{b0},ChapterBar,,0,0,0,,"
            f"{{\\an7\\pos({x},{div_pad})\\p1\\1c{CHAPTER_DIV_COLOUR}"
            f"\\1a{CHAPTER_DIV_ALPHA}\\bord0\\shad0}}"
            f"m 0 0 l 2 0 2 {div_h} 0 {div_h}{{\\p0}}\n"
        )
    # 3) 底边进度：随片长从左展到右
    y_fill = h - fill_h
    lines.append(
        f"Dialogue: 6,{a0},{b0},ChapterBar,,0,0,0,,"
        f"{{\\an7\\pos(0,{y_fill})\\p1\\1c{CHAPTER_PROGRESS_COLOUR}"
        f"\\1a{CHAPTER_PROGRESS_ALPHA}\\bord0\\shad0"
        f"\\clip(0,{y_fill},0,{h})\\t(0,{dur_ms},\\clip(0,{y_fill},{width},{h}))}}"
        f"m 0 0 l {width} 0 {width} {fill_h} 0 {fill_h}{{\\p0}}\n"
    )
    # 4) 章名（大号、描边；当前章加粗高亮）
    for t0, t1, active in _chapter_windows(plan, dur):
        if t1 <= t0:
            continue
        a, b = ass_timestamp(t0), ass_timestamp(t1)
        for i, title in enumerate(titles):
            x0, x1, seg_w = segs[i]
            if CHAPTER_FONT_SIZE and CHAPTER_FONT_SIZE > 0:
                fs = int(CHAPTER_FONT_SIZE)
            else:
                fs = max(16, min(26, int(seg_w / 2.8)))
            max_chars = max(2, int(seg_w / max(fs * 0.52, 7)))
            label = _fit_chapter_label(title, max_chars)
            cx = (x0 + x1) // 2
            if i == active:
                col, bold = CHAPTER_ACTIVE_COLOUR, 1
            else:
                col, bold = CHAPTER_IDLE_COLOUR, 0
            lines.append(
                f"Dialogue: 10,{a},{b},ChapterLabel,,0,0,0,,"
                f"{{\\an5\\pos({cx},{y_mid})\\fs{fs}\\b{bold}\\1c{col}"
                f"\\bord2\\3c{CHAPTER_LABEL_OUTLINE}\\3a{CHAPTER_LABEL_OUTLINE_A}"
                f"\\shad0}}{label}\n"
            )
    return lines



def write_ass(
    cues: list[Cue],
    dest: Path,
    width: int,
    height: int,
    band_h: int = SUB_BAND_H,
    font_size: int | None = None,
    chapters: ChapterPlan | None = None,
    duration: float | None = None,
    top_h: int = 0,
) -> Path:
    margin_v = MARGIN_V if MARGIN_V is not None else (
        OVERLAY_MARGIN_V if band_h <= 0 else max(10, band_h // 4)
    )
    if font_size is not None and font_size > 0:
        fs = int(font_size)
    elif FONT_SIZE and FONT_SIZE > 0:
        fs = int(FONT_SIZE)
    else:
        fs = 40 if width >= 1080 else 36
    header = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {width}
PlayResY: {height}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,{FONT},{fs},{PRIMARY_COLOUR},&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,{OUTLINE},0,2,48,48,{margin_v},1
Style: ChapterBar,{FONT},16,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1
Style: ChapterLabel,{FONT},18,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,0,0,5,0,0,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    lines = [header]
    top = max(0, int(top_h))
    if chapters and chapters.titles and top > 0:
        dur = float(duration) if duration and duration > 0 else (
            max((c.end for c in cues), default=1.0)
        )
        ch_lines = chapter_ass_events(chapters, width, dur, bar_h=top)
        lines.extend(ch_lines)
        if ch_lines:
            print(
                f"  subtitle: chapter top-pad n={len(chapters.titles)} "
                f"current={chapters.current} h={top}"
            )
    for i, cue in enumerate(cues):
        if NO_KEYWORDS or MAX_KEYWORDS_PER_CUE <= 0:
            kws: list[str] = []
        else:
            kws = cue.keywords or pick_keywords(cue.text, MAX_KEYWORDS_PER_CUE)
        body = style_ass_line(cue.text, kws, cue.style_idx if cue.keywords else i, fs)
        lines.append(
            f"Dialogue: 0,{ass_timestamp(cue.start)},{ass_timestamp(cue.end)},Default,,0,0,0,,{body}\n"
        )
    dest.write_text("".join(lines), encoding="utf-8-sig")
    print(f"  subtitle: style font={FONT} size={fs} outline={OUTLINE} margin_v={margin_v}")
    return dest


def _bg_rgb(bg: str) -> tuple[int, int, int]:
    s = str(bg).strip().lower().replace("0x", "").lstrip("#")
    if len(s) != 6:
        return (11, 26, 43)  # fallback #0B1A2B
    v = int(s, 16)
    return (v >> 16) & 255, (v >> 8) & 255, v & 255


def pad_and_burn(
    video: Path,
    ass: Path,
    out: Path,
    band_h: int = SUB_BAND_H,
    bg: str = BOARD_BG,
    feather_h: int | None = None,
    top_h: int = 0,
) -> Path:
    """硬烧 ASS。band_h=底部字幕带；top_h=顶部章节加高（画面上移，进度条在加高区）。"""
    w, h = probe_wh(video)
    band_h = max(0, int(band_h))
    top_h = max(0, int(top_h))
    new_h = h + band_h + top_h
    feather = FEATHER_H if feather_h is None else max(0, int(feather_h))
    if band_h <= 0:
        feather = 0
    else:
        feather = min(feather, h // 2, band_h)
    text = ass.read_text(encoding="utf-8-sig")
    text = re.sub(r"PlayResY:\s*\d+", f"PlayResY: {new_h}", text)
    text = re.sub(r"PlayResX:\s*\d+", f"PlayResX: {w}", text)
    ass_pad = ass.with_name(ass.stem + f".{w}x{new_h}.ass")
    ass_pad.write_text(text, encoding="utf-8-sig")
    ass_esc = ass_pad.resolve().as_posix().replace(":", "\\:")
    fonts_esc = FONTS_DIR.resolve().as_posix().replace(":", "\\:")
    r, g, b = _bg_rgb(bg)
    v_dur = max(ffprobe_duration(video), 0.1)

    def _encode(vf: str | None = None, fc: str | None = None) -> None:
        cmd = ["ffmpeg", "-y", "-i", str(video)]
        if fc:
            cmd += ["-filter_complex", fc, "-map", "[vout]", "-map", "0:a?"]
        else:
            cmd += ["-vf", vf or "null"]
        cmd += [
            "-c:a", "copy",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", str(ENCODE_CRF), "-preset", "medium",
            "-shortest",
            "-t", f"{v_dur:.3f}",
            str(out),
        ]
        _run(cmd)

    # 无加高：字幕直接叠画面
    if top_h <= 0 and band_h <= 0:
        _encode(vf=f"ass='{ass_esc}:fontsdir={fonts_esc}'")
        return out

    # pad：画面放到 (0, top_h)；上方 top / 下方 band 为加高区
    # ffmpeg pad=W:H:X:Y:color → 输入放在输出画布的 (X,Y)
    pad_filter = f"pad={w}:{new_h}:0:{top_h}:{bg}"

    if band_h > 0 and feather > 0:
        # 羽化在「画面底」与「底部字幕带」交界：全局 y = top_h + h - feather
        y0 = top_h + h - feather
        color_d = v_dur + 0.05
        fc = (
            f"[0:v]{pad_filter}[padded];"
            f"color=c={bg}:s={w}x{feather}:d={color_d:.3f},format=rgba,"
            f"geq=r='{r}':g='{g}':b='{b}':a='255*(Y+1)/H'[grad];"
            f"[padded][grad]overlay=0:{y0}:format=auto:shortest=1[base];"
            f"[base]ass='{ass_esc}:fontsdir={fonts_esc}'[vout]"
        )
        print(f"  subtitle: feather={feather}px at y={y0} top={top_h} band={band_h}", flush=True)
        _encode(fc=fc)
    else:
        if top_h > 0:
            print(f"  subtitle: top-pad={top_h}px band={band_h}px", flush=True)
        _encode(vf=f"{pad_filter},ass='{ass_esc}:fontsdir={fonts_esc}'")
    return out


def build_cues(
    narration: str,
    audio: Path,
    work_dir: Path,
) -> list[Cue]:
    duration = ffprobe_duration(audio)
    try:
        timeline = asr_char_timeline(audio, work_dir)
    except Exception as e:
        print(f"  subtitle: ASR fail ({e.__class__.__name__}), uniform timing")
        timeline = []
    silences = detect_silences(audio, work_dir)
    print(f"  subtitle: silences={len(silences)}")
    events = align_chunks(narration, timeline, duration, silences)
    cues: list[Cue] = []
    for i, (a, b, t) in enumerate(events):
        kws = [] if (NO_KEYWORDS or MAX_KEYWORDS_PER_CUE <= 0) else pick_keywords(t)
        cues.append(Cue(text=t, start=a, end=b, keywords=kws, style_idx=i))
    return cues


def make_shot_subtitles(
    narration: str,
    audio: Path,
    video: Path,
    out_video: Path,
    work_dir: Path | None = None,
    band_h: int | None = None,
    bg: str | None = None,
    font_size: int | None = None,
    options: BurnOptions | None = None,
    chapters: ChapterPlan | None = None,
) -> tuple[Path, list[Cue]]:
    if options:
        apply_options(options)
    work = work_dir or out_video.parent
    work.mkdir(parents=True, exist_ok=True)
    band = SUB_BAND_H if band_h is None else int(band_h)
    color = BOARD_BG if bg is None else bg
    fs = font_size if font_size is not None else (FONT_SIZE or None)
    # 硬锁：ASR 音轨不得长于成片，否则尾段字幕轴会漂在画面之后（越到结尾越「跟不上」）
    audio = ensure_audio_matches_video(audio, video, work)
    cues = build_cues(narration, audio, work)
    w, h = probe_wh(video)
    v_dur = ffprobe_duration(video)
    # 有章节 → 向上加高画幅做进度条（不叠画面）；高度=CHAPTER_BAR_H
    top = CHAPTER_BAR_H if (chapters and chapters.titles and CHAPTER_BAR_H > 0) else 0
    ass = work / "subtitles.ass"
    write_ass(
        cues, ass, w, h + band + top, band, font_size=fs,
        chapters=chapters, duration=v_dur, top_h=top,
    )
    (work / "subtitles.json").write_text(
        json.dumps(
            [
                {
                    "text": c.text,
                    "start": c.start,
                    "end": c.end,
                    "keywords": c.keywords,
                    "style_idx": c.style_idx,
                }
                for c in cues
            ],
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    if chapters and chapters.titles:
        (work / "chapters.json").write_text(
            json.dumps(
                {
                    "titles": chapters.titles,
                    "current": chapters.current,
                    "ranges": chapters.ranges,
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )
    n_kw = sum(1 for c in cues if c.keywords)
    parts = []
    if top > 0:
        parts.append(f"top-pad +{top}px")
    if band <= 0:
        parts.append("subs overlay")
    else:
        parts.append(f"bottom-band +{band}px")
    print(f"  subtitle: {len(cues)} cues, {n_kw} with keywords, {', '.join(parts)}…")
    pad_and_burn(video, ass, out_video, band, color, feather_h=FEATHER_H, top_h=top)
    return out_video, cues


if __name__ == "__main__":
    import argparse

    ap = argparse.ArgumentParser(
        description="文案认字 + ASR 对时 + 气口切窗 → ASS 关键词强调 → 底部加高字幕带硬烧"
    )
    ap.add_argument("narration", type=Path, help="旁白文本文件（.txt/.md），正文即字幕来源")
    ap.add_argument("audio", type=Path, help="口播音轨（mp3/wav）")
    ap.add_argument("video", type=Path, help="待烧字幕的视频（无字幕或已有画面）")
    ap.add_argument("-o", "--out", type=Path, required=True, help="输出成片路径")
    ap.add_argument("--work-dir", type=Path, default=None, help="中间产物目录（默认=输出同目录）")
    ap.add_argument(
        "--band",
        type=int,
        default=None,
        help=f"底部字幕带高度 px（默认 {SUB_BAND_H}=叠画面；要加字幕条再传 96）",
    )
    ap.add_argument("--bg", default=None, help=f"加高底色，如 0x0b241c（默认 {BOARD_BG}）")
    ap.add_argument("--feather", type=int, default=None, help=f"字幕条与画面交界羽化高度 px（默认 {FEATHER_H}；0=硬边）")
    ap.add_argument("--font", type=Path, default=None, help="字体文件 .ttf/.otf；或环境变量 SUB_FONT_FILE")
    ap.add_argument("--font-name", default=None, help="ASS Fontname（与系统注册名一致）")
    ap.add_argument("--font-size", type=int, default=None, help="正文字号；默认按宽度自动 40/36")
    ap.add_argument("--kw-boost", type=int, default=None, help="关键词相对正文统一放大字号（默认用配色表各自的 d）")
    ap.add_argument("--max-kw", type=int, default=None, help=f"每条最多强调几个词（默认 {MAX_KEYWORDS_PER_CUE}）")
    ap.add_argument("--max-chars", type=int, default=None, help=f"单条字幕最大字数（默认 {MAX_CHARS}）")
    ap.add_argument(
        "--margin-v",
        type=int,
        default=None,
        help=f"ASS 垂直边距；默认 band>0 用 band/4，band=0 用 {OVERLAY_MARGIN_V}",
    )
    ap.add_argument("--outline", type=int, default=None, help=f"描边宽度（默认 {OUTLINE}）")
    ap.add_argument("--primary-colour", default=None, help='ASS 主色，如 &H00FFFFFF（白）')
    ap.add_argument("--no-keywords", action="store_true", help="关闭关键词强调")
    ap.add_argument("--hold-silence", type=float, default=None, help=f"长气口阈值秒（默认 {HOLD_SILENCE}）")
    ap.add_argument("--fill-gap", type=float, default=None, help=f"短缝接字阈值秒（默认 {FILL_GAP}）")
    ap.add_argument("--pause-gap", type=float, default=None, help=f"静音检测最小秒（默认 {PAUSE_GAP}）")
    ap.add_argument("--crf", type=int, default=None, help=f"x264 CRF（默认 {ENCODE_CRF}）")
    ap.add_argument("--keywords", type=Path, default=None, help="额外关键词文件（每行一词）")
    ap.add_argument("--extra-keywords", default="", help="逗号分隔额外关键词")
    ap.add_argument("--replace-keywords", action="store_true", help="只用给定词表，不用内置默认")
    ap.add_argument(
        "--chapters",
        default=None,
        help='顶部章节条，逗号分隔，如 "前言,了解大脑,元认知,结尾"',
    )
    ap.add_argument(
        "--chapter-index",
        type=int,
        default=0,
        help="当前高亮章节下标（0 起；分镜单片烧录用）",
    )
    ap.add_argument(
        "--chapters-file",
        type=Path,
        default=None,
        help="章节 JSON：titles+current，或 chapters[{title,start,end}]",
    )
    ap.add_argument(
        "--chapter-bar",
        type=int,
        default=None,
        help=f"章节顶条高度=向上加高 px（默认 {CHAPTER_BAR_H}；启用 chapters 时生效）",
    )
    ap.add_argument(
        "--chapter-font-size",
        type=int,
        default=None,
        help="章节标签字号；默认按段宽自动",
    )
    args = ap.parse_args()

    font_path = args.font or (
        Path(os.environ["SUB_FONT_FILE"]) if os.environ.get("SUB_FONT_FILE") else None
    )
    if font_path:
        set_font(font_path, args.font_name)

    extras: list[str] = []
    kw_file = args.keywords or (
        Path(os.environ["SUB_KEYWORDS_FILE"]) if os.environ.get("SUB_KEYWORDS_FILE") else None
    )
    if kw_file:
        extras.extend(load_keywords_file(kw_file))
    raw_extra = args.extra_keywords or os.environ.get("SUB_EXTRA_KEYWORDS", "")
    extras.extend(x.strip() for x in raw_extra.split(",") if x.strip())
    if extras or args.replace_keywords:
        set_keywords(extras, replace=args.replace_keywords)

    opt = BurnOptions(
        band_h=args.band,
        bg=args.bg,
        font_size=args.font_size,
        kw_size_boost=args.kw_boost,
        max_keywords=args.max_kw,
        max_chars=args.max_chars,
        margin_v=args.margin_v,
        outline=args.outline,
        primary_colour=args.primary_colour,
        no_keywords=True if args.no_keywords else None,
        hold_silence=args.hold_silence,
        fill_gap=args.fill_gap,
        pause_gap=args.pause_gap,
        encode_crf=args.crf,
        feather_h=args.feather,
        chapter_bar_h=args.chapter_bar,
        chapter_font_size=args.chapter_font_size,
    )
    apply_options(opt)

    chapter_plan = None
    if args.chapters_file:
        chapter_plan = parse_chapters(path=args.chapters_file, current=args.chapter_index)
    elif args.chapters:
        chapter_plan = parse_chapters(titles=args.chapters, current=args.chapter_index)

    text = args.narration.read_text(encoding="utf-8").strip()
    out, _cues = make_shot_subtitles(
        text,
        args.audio,
        args.video,
        args.out,
        work_dir=args.work_dir,
        band_h=args.band,
        bg=args.bg,
        font_size=args.font_size,
        chapters=chapter_plan,
    )
    print(f"OUT={out.resolve()}")
