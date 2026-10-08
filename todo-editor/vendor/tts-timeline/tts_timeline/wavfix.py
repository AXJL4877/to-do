"""修补流式 TTS 写出的 WAV 头（RIFF/data 常为 0xFFFFFFFF）。"""
from __future__ import annotations

import struct
from pathlib import Path


def fix_wav_header(path: Path | str) -> bool:
    """若检测到无效/流式 RIFF 尺寸，按实际文件长度回写。返回是否修改。"""
    p = Path(path)
    data = bytearray(p.read_bytes())
    if len(data) < 44 or data[0:4] != b"RIFF" or data[8:12] != b"WAVE":
        return False

    # 找 data chunk
    pos = 12
    data_pos = None
    while pos + 8 <= len(data):
        chunk_id = bytes(data[pos : pos + 4])
        chunk_size = struct.unpack_from("<I", data, pos + 4)[0]
        if chunk_id == b"data":
            data_pos = pos
            break
        # 偶数字节对齐
        nxt = pos + 8 + chunk_size
        if chunk_size % 2:
            nxt += 1
        if nxt <= pos:
            break
        pos = nxt

    if data_pos is None:
        return False

    old_riff = struct.unpack_from("<I", data, 4)[0]
    old_data = struct.unpack_from("<I", data, data_pos + 4)[0]
    pcm_len = len(data) - (data_pos + 8)
    new_riff = len(data) - 8
    new_data = pcm_len

    # 仅在明显错误时修补（全 F / 超大 / 与文件不符）
    bad = (
        old_riff == 0xFFFFFFFF
        or old_data == 0xFFFFFFFF
        or old_riff > len(data)
        or old_data > pcm_len + 1
        or abs(old_data - pcm_len) > 1
    )
    if not bad:
        return False

    struct.pack_into("<I", data, 4, new_riff)
    struct.pack_into("<I", data, data_pos + 4, new_data)
    p.write_bytes(data)
    return True
