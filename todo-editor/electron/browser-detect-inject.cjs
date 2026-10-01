/**
 * 只做「识别内容框」：一次执行立刻返回候选矩形（视口 CSS 像素），不在页面里挂交互。
 * 交互选框改由浏览器外壳 overlay 完成，避免各站 CSP / 长 Promise 导致失败。
 */
function buildDetectScript() {
  return `(() => {
  try {
    const vw = window.innerWidth, vh = window.innerHeight;
    const minA = 48 * 48;
    const maxA = vw * vh * 0.9;
    const sel = [
      'img', 'picture', 'video', 'figure', 'article', 'main', 'section', 'aside',
      '[role="main"]', '[role="img"]', '[role="article"]',
      '[class*="card" i]', '[class*="Card"]', '[class*="poster" i]', '[class*="cover" i]',
      '[class*="thumb" i]', '[class*="gallery" i]', '[class*="product" i]', '[class*="tile" i]',
      '[class*="feed" i]', '[class*="item" i]', '[class*="media" i]',
    ].join(',');

    function visible(r) {
      const x0 = Math.max(0, r.left), y0 = Math.max(0, r.top);
      const x1 = Math.min(vw, r.right), y1 = Math.min(vh, r.bottom);
      const vis = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
      return vis / Math.max(1, r.width * r.height) >= 0.45 && (x1 - x0) >= 40 && (y1 - y0) >= 40;
    }
    function styleScore(el) {
      try {
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return -1;
        let s = 0;
        if (cs.boxShadow && cs.boxShadow !== 'none') s += 18;
        if (cs.borderRadius && parseFloat(cs.borderRadius) >= 4) s += 6;
        if (['Top','Right','Bottom','Left'].some((side) => parseFloat(cs['border' + side + 'Width']) > 0)) s += 8;
        if (cs.backgroundImage && cs.backgroundImage !== 'none') s += 22;
        return s;
      } catch { return -1; }
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
      return '内容框';
    }

    const seen = new Set();
    const raw = [];
    const push = (el, bonus) => {
      if (!el || seen.has(el) || el === document.body || el === document.documentElement) return;
      seen.add(el);
      const st = styleScore(el);
      if (st < 0) return;
      const r = el.getBoundingClientRect();
      if (!visible(r)) return;
      const area = r.width * r.height;
      if (area < minA || area > maxA) return;
      if (r.width > vw * 0.96 && r.height > vh * 0.85) return;
      let score = st + bonus;
      const tag = el.tagName.toLowerCase();
      if (tag === 'img' || tag === 'picture' || tag === 'video') score += 40;
      if (tag === 'figure' || tag === 'article') score += 20;
      const ar = r.width / Math.max(1, r.height);
      if (ar > 0.35 && ar < 4.5) score += 10;
      if (area > 120 * 120) score += 8;
      raw.push({
        x: Math.round(r.left), y: Math.round(r.top),
        width: Math.round(r.width), height: Math.round(r.height),
        score, label: labelOf(el),
      });
    };

    try { document.querySelectorAll(sel).forEach((el) => push(el, 12)); } catch {}
    const walk = document.body ? document.body.querySelectorAll('div,li,a') : [];
    let n = 0;
    for (const el of walk) {
      if (seen.has(el)) continue;
      if (walk.length > 2000 && (++n % 3)) continue;
      if (styleScore(el) < 12) continue;
      push(el, 0);
    }

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
      kept.push(c);
      if (kept.length >= 36) break;
    }
    return { ok: true, boxes: kept, vw, vh };
  } catch (e) {
    return { ok: false, boxes: [], error: String(e && e.message ? e.message : e) };
  }
})()`
}

module.exports = { buildDetectScript }
