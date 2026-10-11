"""CUDA frame compositor (PyTorch). Falls back to None when CUDA is unavailable.

Hot path: keep a float RGB canvas on GPU, upload RGBA sprites once, alpha-blit,
download once per frame for ffmpeg. Scale/rotate stay on CPU (cached there).
"""
from __future__ import annotations

import os

import numpy as np

from .imaging import W, H, vignette

_CANVAS = None


def available():
    if os.environ.get("KOUBO_CPU", "").strip() in ("1", "true", "yes"):
        return False
    try:
        import torch

        return bool(torch.cuda.is_available())
    except Exception:
        return False


def get_canvas(w=W, h=H):
    """Process-wide canvas; recreate if size changes."""
    global _CANVAS
    if not available():
        return None
    if _CANVAS is None or _CANVAS.w != w or _CANVAS.h != h:
        _CANVAS = Canvas(w, h)
    return _CANVAS


class Canvas:
    def __init__(self, w=W, h=H):
        import torch

        self.torch = torch
        self.device = torch.device("cuda")
        self.w, self.h = w, h
        self.buf = torch.zeros((h, w, 3), device=self.device, dtype=torch.float32)
        self._rgba = {}
        self._plates = {}
        self._vig = {}
        self._grain = {}

    def clear(self, rgb=(0.0, 0.0, 0.0)):
        for i, c in enumerate(rgb):
            self.buf[:, :, i] = float(c)

    def set_rgb(self, arr):
        t = self.torch.as_tensor(np.ascontiguousarray(arr), device=self.device)
        self.buf = t.to(dtype=self.torch.float32)

    def camera(self, plate, u, zoom=0.0, pan=(0.0, 0.0), centre=(0.5, 0.5)):
        """Virtual push-in camera; writes into self.buf (same math as imaging.camera)."""
        F = self.torch.nn.functional
        key = id(plate)
        tex = self._plates.get(key)
        if tex is None or tex.shape[0] != plate.shape[0] or tex.shape[1] != plate.shape[1]:
            tex = self.torch.as_tensor(
                np.ascontiguousarray(plate), device=self.device
            ).to(dtype=self.torch.float32)
            self._plates[key] = tex
        ph, pw = tex.shape[:2]
        m = 1.0 + float(zoom) * float(u)
        cw = pw * min(1.0, 1.0 / m)
        ch = ph * min(1.0, 1.0 / m)
        cx = pw * (centre[0] + pan[0] * (u - 0.5))
        cy = ph * (centre[1] + pan[1] * (u - 0.5))
        x0 = int(round(min(max(cx - cw / 2, 0), pw - cw)))
        y0 = int(round(min(max(cy - ch / 2, 0), ph - ch)))
        wi, hi = int(round(cw)), int(round(ch))
        crop = tex[y0 : y0 + hi, x0 : x0 + wi]
        if crop.shape[0] == self.h and crop.shape[1] == self.w:
            self.buf = crop.clone()
            return
        nchw = crop.permute(2, 0, 1).unsqueeze(0)
        nchw = F.interpolate(nchw, size=(self.h, self.w), mode="bilinear", align_corners=False)
        self.buf = nchw.squeeze(0).permute(1, 2, 0)

    def _tex_rgba(self, src):
        key = id(src)
        t = self._rgba.get(key)
        if t is None or t.shape[0] != src.shape[0] or t.shape[1] != src.shape[1]:
            t = self.torch.as_tensor(
                np.ascontiguousarray(src), device=self.device
            ).to(dtype=self.torch.float32)
            self._rgba[key] = t
            if len(self._rgba) > 384:
                # ponytail: drop whole cache if it grows; sprites are few per film
                self._rgba.clear()
                self._rgba[key] = t
        return t

    def blit(self, src, x, y, opacity=1.0):
        if opacity <= 0.001:
            return
        sh, sw = src.shape[:2]
        x, y = int(round(x)), int(round(y))
        x0, y0 = max(0, x), max(0, y)
        x1, y1 = min(self.w, x + sw), min(self.h, y + sh)
        if x0 >= x1 or y0 >= y1:
            return
        tex = self._tex_rgba(src)
        patch = tex[y0 - y : y0 - y + (y1 - y0), x0 - x : x0 - x + (x1 - x0)]
        sa = patch[:, :, 3:4] * (float(opacity) / 255.0)
        if float(sa.max()) <= 0:
            return
        region = self.buf[y0:y1, x0:x1]
        self.buf[y0:y1, x0:x1] = patch[:, :, :3] * sa + region * (1.0 - sa)

    def mul(self, weight):
        """Multiply RGB by a scalar or HxW / HxWx1 mask (numpy or tensor)."""
        if np.isscalar(weight):
            self.buf *= float(weight)
            return
        t = weight
        if not self.torch.is_tensor(t):
            t = self.torch.as_tensor(np.ascontiguousarray(weight), device=self.device)
        t = t.to(dtype=self.torch.float32)
        if t.ndim == 2:
            t = t[:, :, None]
        self.buf *= t

    def download(self):
        return self.buf.clamp(0, 255).to(dtype=self.torch.uint8).cpu().numpy()

    def grade_grain(self, vig=0.10, amount=2.0, frame_no=0):
        vkey = round(float(vig), 3)
        mask = self._vig.get(vkey)
        if mask is None:
            v = vignette(vig)
            mask = self.torch.as_tensor(v, device=self.device)
            self._vig[vkey] = mask
        self.buf = (self.buf * mask).clamp(0, 255)
        if amount <= 0:
            return
        gkey = frame_no % 8
        noise = self._grain.get(gkey)
        if noise is None:
            rng = np.random.default_rng(1000 + gkey)
            noise = self.torch.as_tensor(
                (rng.normal(0, 1, (self.h, self.w, 1)) * amount).astype(np.float32),
                device=self.device,
            )
            self._grain[gkey] = noise
        self.buf = (self.buf + noise).clamp(0, 255)
