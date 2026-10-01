/**
 * 注入到网页里的框选 / 智能框拾取器。
 * executeJavaScript 后返回 Promise<{ x, y, width, height, label } | null>
 * 坐标为视口 CSS 像素（与 capturePage 的 DIP 矩形一致）。
 */
function buildPickerScript(mode) {
  const m = mode === 'region' ? 'region' : 'smart'
  return `(() => {
  const MODE = ${JSON.stringify(m)};
  if (window.__todoPickerActive) return Promise.resolve(null);
  window.__todoPickerActive = true;

  return new Promise((resolve) => {
    const ROOT_ID = '__todo_shot_picker__';
    document.getElementById(ROOT_ID)?.remove();

    const root = document.createElement('div');
    root.id = ROOT_ID;
    root.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483646;pointer-events:none;font-family:system-ui,sans-serif;';

    const dim = document.createElement('div');
    dim.style.cssText = 'position:absolute;inset:0;background:rgba(20,16,12,.28);pointer-events:auto;cursor:crosshair;';

    const tip = document.createElement('div');
    tip.style.cssText = 'position:fixed;left:50%;top:12px;transform:translateX(-50%);z-index:2;pointer-events:none;padding:6px 12px;border-radius:999px;background:rgba(42,36,28,.92);color:#F5F2EC;font-size:12px;white-space:nowrap;box-shadow:0 4px 16px rgba(0,0,0,.25);';
    tip.textContent = MODE === 'smart'
      ? '点击高亮框截取 · 拖拽可自选区域 · Esc 取消'
      : '拖拽框选区域 · Esc 取消';

    const boxLayer = document.createElement('div');
    boxLayer.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:hidden;';

    const march = document.createElement('div');
    march.style.cssText = 'position:absolute;border:2px solid #C45C26;box-shadow:0 0 0 9999px rgba(20,16,12,.35);display:none;pointer-events:none;';

    root.appendChild(dim);
    root.appendChild(boxLayer);
    root.appendChild(march);
    root.appendChild(tip);
    document.documentElement.appendChild(root);

    const clean = (result) => {
      window.__todoPickerActive = false;
      window.removeEventListener('keydown', onKey, true);
      root.remove();
      resolve(result);
    };

    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        clean(null);
      }
    };
    window.addEventListener('keydown', onKey, true);

    function clampRect(x, y, w, h) {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let x0 = Math.max(0, Math.min(x, vw));
      let y0 = Math.max(0, Math.min(y, vh));
      let x1 = Math.max(0, Math.min(x + w, vw));
      let y1 = Math.max(0, Math.min(y + h, vh));
      const width = Math.round(x1 - x0);
      const height = Math.round(y1 - y0);
      if (width < 8 || height < 8) return null;
      return { x: Math.round(x0), y: Math.round(y0), width, height };
    }

    function finish(rect, label) {
      if (!rect) return;
      clean({ ...rect, label: label || '区域' });
    }

    // ── 拖拽框选（两种模式都支持）────────────────────────────
    let drag = null;
    dim.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      // 智能模式下点到候选框由候选层处理；这里只处理空白拖拽
      if (MODE === 'smart' && e.target !== dim) return;
      e.preventDefault();
      drag = { x0: e.clientX, y0: e.clientY };
      march.style.display = 'block';
      march.style.left = drag.x0 + 'px';
      march.style.top = drag.y0 + 'px';
      march.style.width = '0px';
      march.style.height = '0px';
      dim.setPointerCapture(e.pointerId);
    });
    dim.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const x = Math.min(drag.x0, e.clientX);
      const y = Math.min(drag.y0, e.clientY);
      const w = Math.abs(e.clientX - drag.x0);
      const h = Math.abs(e.clientY - drag.y0);
      march.style.left = x + 'px';
      march.style.top = y + 'px';
      march.style.width = w + 'px';
      march.style.height = h + 'px';
    });
    dim.addEventListener('pointerup', (e) => {
      if (!drag) return;
      const x = Math.min(drag.x0, e.clientX);
      const y = Math.min(drag.y0, e.clientY);
      const w = Math.abs(e.clientX - drag.x0);
      const h = Math.abs(e.clientY - drag.y0);
      drag = null;
      try { dim.releasePointerCapture(e.pointerId); } catch {}
      const rect = clampRect(x, y, w, h);
      if (rect) finish(rect, '框选');
      else march.style.display = 'none';
    });

    if (MODE !== 'smart') return;

    // ── 智能识别内容框 ───────────────────────────────────────
    function visibleInViewport(r) {
      const vw = window.innerWidth, vh = window.innerHeight;
      const x0 = Math.max(0, r.left);
      const y0 = Math.max(0, r.top);
      const x1 = Math.min(vw, r.right);
      const y1 = Math.min(vh, r.bottom);
      const vis = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
      const area = Math.max(1, r.width * r.height);
      return vis / area >= 0.45 && (x1 - x0) >= 40 && (y1 - y0) >= 40;
    }

    function styleScore(el) {
      let s = 0;
      try {
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return -1;
        if (cs.boxShadow && cs.boxShadow !== 'none') s += 18;
        if (cs.borderRadius && parseFloat(cs.borderRadius) >= 4) s += 6;
        const bw = ['Top', 'Right', 'Bottom', 'Left'].some((side) => parseFloat(cs['border' + side + 'Width']) > 0);
        if (bw) s += 8;
        if (cs.backgroundImage && cs.backgroundImage !== 'none') s += 22;
        const bg = cs.backgroundColor;
        if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') s += 4;
      } catch { return -1; }
      return s;
    }

    function labelOf(el) {
      const tag = el.tagName.toLowerCase();
      if (tag === 'img' || tag === 'picture') return '图片';
      if (tag === 'video') return '视频';
      if (tag === 'figure') return '插图';
      if (tag === 'article') return '文章';
      if (tag === 'main' || el.getAttribute('role') === 'main') return '主内容';
      const cls = String(el.className || '');
      if (/card|Card|poster|cover|thumb|gallery|product|feed|tile/i.test(cls)) return '卡片';
      if (tag === 'section') return '区块';
      if (tag === 'aside') return '侧栏';
      return '内容框';
    }

    function collect() {
      const vw = window.innerWidth, vh = window.innerHeight;
      const minA = 48 * 48;
      const maxA = vw * vh * 0.9;
      const sel = [
        'img', 'picture', 'video', 'figure', 'article', 'main', 'section', 'aside',
        '[role="main"]', '[role="img"]', '[role="article"]',
        '[class*="card" i]', '[class*="Card"]', '[class*="poster" i]', '[class*="cover" i]',
        '[class*="thumb" i]', '[class*="gallery" i]', '[class*="product" i]', '[class*="tile" i]',
        '[class*="feed" i]', '[class*="item" i]', '[class*="media" i]', '[class*="shot" i]',
      ].join(',');

      const seen = new Set();
      const raw = [];
      const pushEl = (el, bonus) => {
        if (!el || el === document.body || el === document.documentElement) return;
        if (seen.has(el)) return;
        seen.add(el);
        if (ROOT_ID && (el.id === ROOT_ID || el.closest?.('#' + ROOT_ID))) return;
        const st = styleScore(el);
        if (st < 0) return;
        const r = el.getBoundingClientRect();
        if (!visibleInViewport(r)) return;
        const area = r.width * r.height;
        if (area < minA || area > maxA) return;
        // 几乎铺满视口的通常是页面壳，丢掉
        if (r.width > vw * 0.96 && r.height > vh * 0.85) return;
        let score = st + bonus;
        const tag = el.tagName.toLowerCase();
        if (tag === 'img' || tag === 'picture' || tag === 'video') score += 40;
        if (tag === 'figure' || tag === 'article') score += 20;
        // 偏好接近内容比例、不要又细又长的条
        const ar = r.width / Math.max(1, r.height);
        if (ar > 0.35 && ar < 4.5) score += 10;
        if (area > 120 * 120) score += 8;
        raw.push({
          el,
          x: r.left, y: r.top, width: r.width, height: r.height,
          score, label: labelOf(el),
        });
      };

      try {
        document.querySelectorAll(sel).forEach((el) => pushEl(el, 12));
      } catch {}

      // 补充：有明显盒子外观的通用元素
      const walk = document.body ? document.body.querySelectorAll('div,li,a,button') : [];
      for (const el of walk) {
        if (seen.has(el)) continue;
        if (walk.length > 2500 && Math.random() > 0.35) continue; // 超大页抽样
        const st = styleScore(el);
        if (st < 12) continue;
        pushEl(el, 0);
      }

      // 非极大抑制：重叠高的只留高分
      raw.sort((a, b) => b.score - a.score);
      const kept = [];
      const iou = (a, b) => {
        const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y);
        const x1 = Math.min(a.x + a.width, b.x + b.width);
        const y1 = Math.min(a.y + a.height, b.y + b.height);
        const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
        const u = a.width * a.height + b.width * b.height - inter;
        return u <= 0 ? 0 : inter / u;
      };
      for (const c of raw) {
        if (kept.some((k) => iou(k, c) > 0.62)) continue;
        // 也丢掉几乎被更大框完全包住且分数更低的
        if (kept.some((k) => {
          const contain = c.x >= k.x - 2 && c.y >= k.y - 2
            && c.x + c.width <= k.x + k.width + 2
            && c.y + c.height <= k.y + k.height + 2;
          return contain && k.score >= c.score;
        })) continue;
        kept.push(c);
        if (kept.length >= 36) break;
      }
      return kept;
    }

    const candidates = collect();
    tip.textContent = candidates.length
      ? ('识别到 ' + candidates.length + ' 个内容框 · 点击截取 · 拖拽可自选 · Esc 取消')
      : '未识别到明显内容框 · 请拖拽框选 · Esc 取消';

    for (const c of candidates) {
      const pad = 2;
      const hit = document.createElement('div');
      hit.style.cssText = [
        'position:absolute',
        'left:' + (c.x - pad) + 'px',
        'top:' + (c.y - pad) + 'px',
        'width:' + (c.width + pad * 2) + 'px',
        'height:' + (c.height + pad * 2) + 'px',
        'border:2px solid rgba(37,99,235,.75)',
        'border-radius:4px',
        'box-shadow:inset 0 0 0 1px rgba(255,255,255,.35)',
        'pointer-events:auto',
        'cursor:pointer',
        'background:transparent',
      ].join(';');
      hit.title = c.label + ' · 点击截取';
      const badge = document.createElement('span');
      badge.textContent = c.label;
      badge.style.cssText = 'position:absolute;left:0;top:0;transform:translateY(-100%);padding:1px 6px;font-size:10px;background:#2563EB;color:#fff;border-radius:4px 4px 0 0;pointer-events:none;';
      hit.appendChild(badge);
      hit.addEventListener('pointerenter', () => {
        hit.style.borderColor = '#C45C26';
        hit.style.background = 'rgba(196,92,38,.12)';
        badge.style.background = '#C45C26';
      });
      hit.addEventListener('pointerleave', () => {
        hit.style.borderColor = 'rgba(37,99,235,.75)';
        hit.style.background = 'transparent';
        badge.style.background = '#2563EB';
      });
      hit.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const rect = clampRect(c.x - pad, c.y - pad, c.width + pad * 2, c.height + pad * 2);
        finish(rect, c.label);
      });
      boxLayer.appendChild(hit);
    }
  });
})()`
}

module.exports = { buildPickerScript }
