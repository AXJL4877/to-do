/*! JIZURA 0.10.1 | Copyright (c) 2026 hakoniwa | MIT | see licenses/JIZURA.txt
 * Upstream fc16bfe43ea4a6c25a21f1caf04d17326de14f00; local changes: private factory, stack motion strength.
 * Full-frame renderer/remote font loaders are not called by the adapter. */
export function createJizura() {

// Upstream src/01_util.js
/* ============================================================
   JIZURA — util: math, easing, deterministic randomness, colour
   ============================================================ */
'use strict';
const J = {};

J.clamp = (x, a = 0, b = 1) => (x < a ? a : x > b ? b : x);
J.lerp = (a, b, t) => a + (b - a) * t;
J.inv = (a, b, x) => (b === a ? 0 : (x - a) / (b - a));
J.smooth = (a, b, x) => { const t = J.clamp(J.inv(a, b, x)); return t * t * (3 - 2 * t); };
J.TAU = Math.PI * 2;
J.DEG = Math.PI / 180;

J.E = {
  lin: x => J.clamp(x),
  inQuad: x => { x = J.clamp(x); return x * x; },
  outQuad: x => { x = J.clamp(x); return 1 - (1 - x) * (1 - x); },
  inCubic: x => { x = J.clamp(x); return x * x * x; },
  outCubic: x => { x = J.clamp(x); return 1 - Math.pow(1 - x, 3); },
  inOutCubic: x => { x = J.clamp(x); return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; },
  outExpo: x => { x = J.clamp(x); return x >= 1 ? 1 : 1 - Math.pow(2, -10 * x); },
  inExpo: x => { x = J.clamp(x); return x <= 0 ? 0 : Math.pow(2, 10 * x - 10); },
  inOutExpo: x => { x = J.clamp(x); if (x <= 0 || x >= 1) return x; return x < 0.5 ? Math.pow(2, 20 * x - 10) / 2 : (2 - Math.pow(2, -20 * x + 10)) / 2; },
  outBack: (x, s = 1.9) => { x = J.clamp(x); const c = s + 1; return 1 + c * Math.pow(x - 1, 3) + s * Math.pow(x - 1, 2); },
  outElastic: x => { x = J.clamp(x); if (x === 0 || x === 1) return x; return Math.pow(2, -10 * x) * Math.sin((x * 10 - 0.75) * (J.TAU / 3)) + 1; },
  inOutSine: x => { x = J.clamp(x); return -(Math.cos(Math.PI * x) - 1) / 2; },
};

/* ---- deterministic hashing: numbers only on the hot path ---- */
const _sidCache = new Map();
J.sid = s => {                       // string -> uint32 (cached)
  let v = _sidCache.get(s);
  if (v !== undefined) return v;
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  v = h >>> 0; _sidCache.set(s, v); return v;
};
J.h = function (a, b, c, d, e) {      // up to 5 numeric keys -> uint32
  let h = 0x9e3779b9 ^ (a | 0);
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = (h + Math.imul((b | 0) + 0x632be5ab, 0xc2b2ae35)) | 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h = (h + Math.imul((c | 0) + 0x5bd1e995, 0x27d4eb2f)) | 0;
  h = Math.imul(h ^ (h >>> 15), 0x165667b1);
  h = (h + Math.imul((d | 0) + 0x1b873593, 0x85ebca6b)) | 0;
  h = Math.imul(h ^ (h >>> 16), 0x27d4eb2f);
  h = (h + Math.imul((e | 0) + 0x68e31da4, 0x9e3779b1)) | 0;
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15;
  return h >>> 0;
};
J.r = (a, b, c, d, e) => J.h(a, b, c, d, e) / 4294967296;          // 0..1
J.rs = (a, b, c, d, e) => J.r(a, b, c, d, e) * 2 - 1;               // -1..1
J.rr = (lo, hi, a, b, c, d, e) => lo + (hi - lo) * J.r(a, b, c, d, e);
J.pick = (arr, a, b, c, d) => arr[Math.floor(J.r(a, b, c, d) * arr.length) % arr.length];

J.rng = seed => {                    // mulberry32 stream
  let s = seed >>> 0;
  const f = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  f.range = (lo, hi) => lo + (hi - lo) * f();
  f.int = (lo, hi) => Math.floor(lo + (hi - lo + 1) * f());
  f.pick = arr => arr[Math.floor(f() * arr.length) % arr.length];
  f.chance = p => f() < p;
  f.wpick = list => {               // [{w, v}] or [[v,w]]
    let tot = 0; for (const it of list) tot += Array.isArray(it) ? it[1] : it.w;
    let x = f() * tot;
    for (const it of list) { const w = Array.isArray(it) ? it[1] : it.w; if ((x -= w) <= 0) return Array.isArray(it) ? it[0] : it.v; }
    const last = list[list.length - 1]; return Array.isArray(last) ? last[0] : last.v;
  };
  return f;
};

/* smooth 1D value noise (for drift / wiggle) */
J.noise1 = (x, seed = 0) => {
  const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f);
  return J.lerp(J.rs(seed, i), J.rs(seed, i + 1), u);
};

/* ---- colour ---- */
J.hex = h => {
  h = String(h || '#000').replace('#', '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  const n = parseInt(h.slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
J.rgba = (h, a = 1) => { const [r, g, b] = J.hex(h); return `rgba(${r},${g},${b},${a})`; };
J.mix = (h1, h2, t) => {
  const a = J.hex(h1), b = J.hex(h2);
  const c = a.map((v, i) => Math.round(J.lerp(v, b[i], t)));
  return '#' + c.map(v => v.toString(16).padStart(2, '0')).join('');
};
J.lum = h => { const [r, g, b] = J.hex(h); return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; };
J.toHex = (r, g, b) => '#' + [r, g, b].map(v => Math.round(J.clamp(v, 0, 255)).toString(16).padStart(2, '0')).join('').toUpperCase();
J.hsl = (h, s, l) => {                 // h 0..360, s/l 0..1 -> hex
  h = ((h % 360) + 360) % 360 / 360;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const f = t => { t = (t + 1) % 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; };
  return J.toHex(f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255);
};
J.toHsl = hex => {
  const [r, g, b] = J.hex(hex).map(v => v / 255);
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
  if (mx === mn) return [0, 0, l];
  const d = mx - mn, s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  const h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
};
J.contrast = (a, b) => {               // WCAG contrast ratio
  const L = h => { const c = J.hex(h).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  const x = L(a), y = L(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
J.fitContrast = (hex, bg, min = 3) => {  // nudge lightness away from the background until it reads
  if (J.contrast(hex, bg) >= min) return hex.toUpperCase();
  let [h, s, l] = J.toHsl(hex);
  const dark = J.lum(bg) < 0.5;
  for (let i = 0; i < 24; i++) {
    l = dark ? Math.min(0.96, l + 0.035) : Math.max(0.04, l - 0.035);
    const c = J.hsl(h, s, l);
    if (J.contrast(c, bg) >= min) return c;
  }
  return dark ? '#FFFFFF' : '#111111';
};
/* random accent + chromatic ghost pair that works on the given background */
J.GHOST_PAIRS = [['#16F4D4', '#F5A50C'], ['#FF2A2A', '#2AA8FF'], ['#FF2BD6', '#2BFF88'], ['#FFE600', '#7B2BFF'], ['#FF6A00', '#00C2B8'],
  ['#FF6FAE', '#B6FF3B'], ['#00E0FF', '#FF3D6E'], ['#C8FF00', '#FF00A8'], ['#4D6BFF', '#FFB000'], ['#FF4B2B', '#2BD9FF']];
J.randomPalette = (bg, rnd = Math.random) => {
  const dark = J.lum(bg) < 0.5;
  let a, b, mode;
  if (rnd() < 0.4) {
    mode = 'curated';
    [a, b] = J.GHOST_PAIRS[Math.floor(rnd() * J.GHOST_PAIRS.length)];
    if (rnd() < 0.5) [a, b] = [b, a];
    if (!dark) { a = J.hsl(J.toHsl(a)[0], 0.95, 0.47); b = J.hsl(J.toHsl(b)[0], 0.95, 0.47); }
  } else {
    mode = 'harmony';
    const h = rnd() * 360, gap = [180, 165, 150, 135][Math.floor(rnd() * 4)] * (rnd() < 0.5 ? 1 : -1);
    const s = 0.82 + rnd() * 0.18, l = dark ? 0.52 + rnd() * 0.1 : 0.44 + rnd() * 0.08;
    a = J.hsl(h, s, l); b = J.hsl(h + gap, s, l);
  }
  // accent: one of the pair, or the hue between them, made readable on the background
  const r = rnd();
  const ha = J.toHsl(a)[0], hb = J.toHsl(b)[0];
  let acc = r < 0.35 ? a : r < 0.6 ? b : J.hsl((ha + hb) / 2 + (rnd() < 0.5 ? 0 : 180), 0.9, dark ? 0.6 : 0.45);
  acc = J.fitContrast(acc, bg, 3);
  return { accent: acc, ghostA: a, ghostB: b, mode };
};

/* ---- script classes for Japanese text ---- */
J.isKanji = c => /[㐀-鿿豈-﫿々〆ヶ]/.test(c);
J.isHira = c => /[ぁ-ゟ]/.test(c);
J.isKata = c => /[゠-ヿㇰ-ㇿｦ-ﾟ]/.test(c);
J.isSmallKana = c => 'ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ'.includes(c);
J.isPunct = c => /[、。，．,.!?！？…‥・「」『』（）()【】〈〉《》〔〕［］\[\]'"“”‘’ー〜～:：;；\-—―]/.test(c);
J.isLatin = c => /[A-Za-z0-9]/.test(c);
J.VERT_ROTATE = 'ー〜～…‥―—-()（）「」『』【】〈〉《》〔〕[]［］→←:：;；=＝';

/* ---- kana → romaji (for annotation labels; kanji left out) ---- */
(() => {
  const base = { あ: 'a', い: 'i', う: 'u', え: 'e', お: 'o', か: 'ka', き: 'ki', く: 'ku', け: 'ke', こ: 'ko', さ: 'sa', し: 'shi', す: 'su', せ: 'se', そ: 'so', た: 'ta', ち: 'chi', つ: 'tsu', て: 'te', と: 'to', な: 'na', に: 'ni', ぬ: 'nu', ね: 'ne', の: 'no', は: 'ha', ひ: 'hi', ふ: 'fu', へ: 'he', ほ: 'ho', ま: 'ma', み: 'mi', む: 'mu', め: 'me', も: 'mo', や: 'ya', ゆ: 'yu', よ: 'yo', ら: 'ra', り: 'ri', る: 'ru', れ: 're', ろ: 'ro', わ: 'wa', を: 'wo', ん: 'n', が: 'ga', ぎ: 'gi', ぐ: 'gu', げ: 'ge', ご: 'go', ざ: 'za', じ: 'ji', ず: 'zu', ぜ: 'ze', ぞ: 'zo', だ: 'da', ぢ: 'ji', づ: 'zu', で: 'de', ど: 'do', ば: 'ba', び: 'bi', ぶ: 'bu', べ: 'be', ぼ: 'bo', ぱ: 'pa', ぴ: 'pi', ぷ: 'pu', ぺ: 'pe', ぽ: 'po', ぁ: 'a', ぃ: 'i', ぅ: 'u', ぇ: 'e', ぉ: 'o', ゔ: 'vu' };
  const yo = { ゃ: 'ya', ゅ: 'yu', ょ: 'yo' };
  J.romaji = s => {
    let out = '', i = 0;
    const toH = c => (J.isKata(c) && c !== 'ー' ? String.fromCharCode(c.charCodeAt(0) - 0x60) : c);
    const arr = [...s].map(toH);
    while (i < arr.length) {
      const c = arr[i], n = arr[i + 1];
      if (c === 'っ') { const nx = base[n] || ''; out += nx ? nx[0] : ''; i++; continue; }
      if (c === 'ー') { out += out.slice(-1); i++; continue; }
      if (n && yo[n] && base[c]) { const b = base[c]; out += (b.length > 1 && (b.endsWith('i')) ? b.slice(0, -1) : b) + (b === 'shi' || b === 'chi' || b === 'ji' ? yo[n].slice(1) : yo[n]); i += 2; continue; }
      if (base[c]) out += base[c]; else if (/[A-Za-z0-9 ]/.test(c)) out += c; else return null;
      i++;
    }
    return out;
  };
})();

J.fmtTime = (t, fps) => {
  t = Math.max(0, t);
  const m = Math.floor(t / 60), s = Math.floor(t % 60), f = Math.floor((t % 1) * (fps || 100));
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}${fps ? ':' + String(f).padStart(2, '0') : '.' + String(f).padStart(2, '0')}`;
};


// Upstream src/02_fonts.js
/* ============================================================
   JIZURA — fonts: catalogue, loading, glyph decomposition
   ============================================================ */
(() => {
'use strict';

const JP_SANS_FB = '"Noto Sans JP","Noto Sans CJK JP","Hiragino Sans","Yu Gothic","Meiryo",sans-serif';
const JP_SERIF_FB = '"Noto Serif JP","Noto Serif CJK JP","Hiragino Mincho ProN","Yu Mincho",serif';

/* role catalogue: key -> {label, family, weight, kind} */
J.FONTS = {
  gothic_black:  { label: 'Noto Sans JP Black',        family: '"Noto Sans JP"', weight: 900, kind: 'gothic', fb: JP_SANS_FB, gf: 'Noto+Sans+JP:wght@300;500;700;900' },
  gothic_bold:   { label: 'Noto Sans JP Bold',         family: '"Noto Sans JP"', weight: 700, kind: 'gothic', fb: JP_SANS_FB, gf: 'Noto+Sans+JP:wght@300;500;700;900' },
  gothic_med:    { label: 'Noto Sans JP Medium',       family: '"Noto Sans JP"', weight: 500, kind: 'gothic', fb: JP_SANS_FB, gf: 'Noto+Sans+JP:wght@300;500;700;900' },
  gothic_light:  { label: 'Noto Sans JP Light',        family: '"Noto Sans JP"', weight: 300, kind: 'gothic', fb: JP_SANS_FB, gf: 'Noto+Sans+JP:wght@300;500;700;900' },
  dela:          { label: 'Dela Gothic One',           family: '"Dela Gothic One"', weight: 400, kind: 'display', fb: JP_SANS_FB, gf: 'Dela+Gothic+One' },
  zenkaku:       { label: 'Zen Kaku Gothic New Black', family: '"Zen Kaku Gothic New"', weight: 900, kind: 'gothic', fb: JP_SANS_FB, gf: 'Zen+Kaku+Gothic+New:wght@900' },
  mincho_black:  { label: 'Zen Old Mincho Black',      family: '"Zen Old Mincho"', weight: 900, kind: 'mincho', fb: JP_SERIF_FB, gf: 'Zen+Old+Mincho:wght@900' },
  mincho_bold:   { label: 'Noto Serif JP Bold',        family: '"Noto Serif JP"', weight: 700, kind: 'mincho', fb: JP_SERIF_FB, gf: 'Noto+Serif+JP:wght@300;500;700' },
  mincho:        { label: 'Noto Serif JP Medium',      family: '"Noto Serif JP"', weight: 500, kind: 'mincho', fb: JP_SERIF_FB, gf: 'Noto+Serif+JP:wght@300;500;700' },
  mincho_light:  { label: 'Noto Serif JP Light',       family: '"Noto Serif JP"', weight: 300, kind: 'mincho', fb: JP_SERIF_FB, gf: 'Noto+Serif+JP:wght@300;500;700' },
  tokumin:       { label: 'Kaisei Tokumin',            family: '"Kaisei Tokumin"', weight: 800, kind: 'mincho', fb: JP_SERIF_FB, gf: 'Kaisei+Tokumin:wght@800' },
  round:         { label: 'M PLUS Rounded 1c',         family: '"M PLUS Rounded 1c"', weight: 800, kind: 'round', fb: JP_SANS_FB, gf: 'M+PLUS+Rounded+1c:wght@800' },
  pop:           { label: 'Mochiy Pop One',            family: '"Mochiy Pop One"', weight: 400, kind: 'display', fb: JP_SANS_FB, gf: 'Mochiy+Pop+One' },
  dot:           { label: 'DotGothic16',               family: '"DotGothic16"', weight: 400, kind: 'pixel', fb: JP_SANS_FB, gf: 'DotGothic16' },
  brush:         { label: 'Yuji Syuku',                family: '"Yuji Syuku"', weight: 400, kind: 'brush', fb: JP_SERIF_FB, gf: 'Yuji+Syuku' },
  mono:          { label: 'IBM Plex Mono',             family: '"IBM Plex Mono"', weight: 500, kind: 'mono', fb: '"IBM Plex Sans JP",' + JP_SANS_FB, gf: 'IBM+Plex+Mono:wght@500;600' },
  reggae:        { label: 'Reggae One',                family: '"Reggae One"', weight: 400, kind: 'display', fb: JP_SANS_FB, gf: 'Reggae+One' },
  rampart:       { label: 'Rampart One',               family: '"Rampart One"', weight: 400, kind: 'display', fb: JP_SANS_FB, gf: 'Rampart+One' },
  potta:         { label: 'Potta One',                 family: '"Potta One"', weight: 400, kind: 'brush', fb: JP_SANS_FB, gf: 'Potta+One' },
  kiwi:          { label: 'Kiwi Maru',                 family: '"Kiwi Maru"', weight: 500, kind: 'round', fb: JP_SANS_FB, gf: 'Kiwi+Maru:wght@500' },
  klee:          { label: 'Klee One',                  family: '"Klee One"', weight: 600, kind: 'hand', fb: JP_SERIF_FB, gf: 'Klee+One:wght@600' },
  shippori:      { label: 'Shippori Mincho B1',        family: '"Shippori Mincho B1"', weight: 800, kind: 'mincho', fb: JP_SERIF_FB, gf: 'Shippori+Mincho+B1:wght@800' },
  sansui:        { label: 'IBM Plex Sans JP',          family: '"IBM Plex Sans JP"', weight: 500, kind: 'gothic', fb: JP_SANS_FB, gf: 'IBM+Plex+Sans+JP:wght@400;500;700' },
};
J.GOOGLE_FONTS_URL = 'https://fonts.googleapis.com/css2?family=Dela+Gothic+One&family=Noto+Sans+JP:wght@300;500;700;900&family=Noto+Serif+JP:wght@300;500;700&family=Zen+Kaku+Gothic+New:wght@900&family=Zen+Old+Mincho:wght@900&family=Kaisei+Tokumin:wght@800&family=M+PLUS+Rounded+1c:wght@800&family=Mochiy+Pop+One&family=DotGothic16&family=Yuji+Syuku&family=IBM+Plex+Mono:wght@500;600&family=IBM+Plex+Sans+JP:wght@400;500;700&display=swap';

/* user fonts (local family names or uploaded files) */
J.addUserFont = (key, label, family, weight = 400, kind = 'custom') => {
  J.FONTS[key] = { label, family: `"${family.replace(/"/g, '')}"`, weight, kind, fb: JP_SANS_FB, user: true };
  J.glyphs.clear();
};
/* only plain keys / family names ever reach the page (project files are untrusted input) */
J.SAFE_FONT_KEY = /^user_[A-Za-z0-9_-]{1,80}$/;
J.safeFamily = s => String(s || '').replace(/[^\w\- ]/g, '_').slice(0, 80);
J.loadFontFile = async (file) => {
  const buf = await file.arrayBuffer();
  const fam = 'UF_' + file.name.replace(/\.[^.]+$/, '').replace(/[^\w]/g, '_').slice(0, 60);
  const ff = new FontFace(fam, buf);
  await ff.load(); document.fonts.add(ff);
  const key = 'user_' + fam, label = file.name.replace(/\.[^.]+$/, '').slice(0, 80);
  J.addUserFont(key, label, fam, 400, 'custom');
  J.FONTS[key].loaded = true;
  if (J.saveFontData) J.saveFontData(key, buf);        // kept in this browser, so a reload keeps the face
  return { key, label, family: fam, weight: 400 };
};
/* uploaded faces of a project: register them from this browser's copy; returns the labels that are not available */
J.restoreUserFonts = async (list) => {
  const missing = [];
  for (const uf of list || []) {
    const f = J.FONTS[uf.key];
    if (f && f.loaded) continue;
    let ok = false;
    try {
      const buf = J.loadFontData ? await J.loadFontData(uf.key) : null;
      if (buf) { const ff = new FontFace(J.safeFamily(uf.family), buf); await ff.load(); document.fonts.add(ff); ok = true; }
    } catch (e) { ok = false; }
    if (ok && J.FONTS[uf.key]) { J.FONTS[uf.key].loaded = true; J.glyphs.clear(); J.metrics.clear(); }
    else missing.push(uf.label || uf.family || uf.key);
  }
  return missing;
};
/* uploaded faces the plan draws with but this page does not have */
J.missingUserFonts = (keys) => (keys || []).filter(k => J.FONTS[k] && J.FONTS[k].user && !J.FONTS[k].loaded).map(k => J.FONTS[k].label);

J.fontCSS = (key, px) => {
  const f = J.faceOf ? J.faceOf(key) : (J.FONTS[key] || J.FONTS.gothic_bold);   // per-language face (02b_lang.js)
  return `${f.weight} ${px.toFixed(2)}px ${f.family},${f.fb}`;
};

/* Google Fonts stylesheets are attached lazily, one family at a time, only for the faces a plan actually uses —
   adding faces to the catalogue therefore costs nothing until a style or setting picks them */
const cssJobs = new Map();
function attachFamily(spec) {
  if (!spec || typeof document === 'undefined' || !document.head) return Promise.resolve();
  if (cssJobs.has(spec)) return cssJobs.get(spec);
  const job = new Promise(res => {
    const l = document.createElement('link');
    l.rel = 'stylesheet'; l.href = 'https://fonts.googleapis.com/css2?family=' + spec + '&display=swap';
    const done = () => res(); l.onload = done; l.onerror = done; setTimeout(done, 5000);
    document.head.appendChild(l);
  });
  cssJobs.set(spec, job);
  return job;
}
/* font keys a plan draws with: style roles, per-cut font params, mono for HUD */
J.fontsOfPlan = (plan) => {
  const set = new Set(['mono']);
  if (!plan) return [...set];
  for (const r of Object.values(plan.style.fonts || {})) for (const k of r) set.add(k);
  for (const c of plan.cuts || []) for (const v of Object.values(c.params || {})) {
    if (typeof v === 'string' && J.FONTS[v]) set.add(v);
    else if (Array.isArray(v)) v.forEach(x => { if (typeof x === 'string' && J.FONTS[x]) set.add(x); });
  }
  const out = [...set].filter(k => J.FONTS[k]);
  if ((plan.cuts || []).some(c => c.weightGrow)) out.push('@var');     // 太さ: the variable Noto Sans / Serif JP
  return out;
};
/* make sure the glyphs we need are loaded (Google Fonts are unicode-range split). keys = null → every catalogue face */
J.ensureFonts = async (text, keys) => {
  if (!document.fonts || !document.fonts.load) return;
  const uniq = [...new Set([...text])].join('') || 'あ';
  if (keys && keys.includes('@var')) {
    await Promise.all(['Noto+Sans+JP:wght@100..900', 'Noto+Serif+JP:wght@200..900'].map(attachFamily));
    await Promise.all(['100 64px "Noto Sans JP"', '900 64px "Noto Sans JP"', '200 64px "Noto Serif JP"', '900 64px "Noto Serif JP"'].map(f => document.fonts.load(f, uniq).catch(() => null)));
  }
  const list = (keys || Object.keys(J.FONTS)).filter(k => J.FONTS[k]);
  // faces in the current lyric language (+ its fallback sans / serif), each with the weight it is drawn at
  const faces = list.map(k => (J.faceOf ? J.faceOf(k) : J.FONTS[k]));
  if (J.langBaseFaces) for (const b of J.langBaseFaces(list)) faces.push({ family: '"' + b.family + '"', weight: b.weight, gf: b.gf });
  await Promise.all([...new Set(faces.map(f => f.gf).filter(Boolean))].map(attachFamily));
  const jobs = [], seen = new Set();
  for (const f of faces) {
    const spec = `${f.weight} 64px ${f.family}`;
    if (seen.has(spec)) continue; seen.add(spec);
    jobs.push(document.fonts.load(spec, uniq).catch(() => null));
  }
  await Promise.all(jobs);
  if (document.fonts.ready) await document.fonts.ready;
  J.glyphs.clear();
  J.metrics.clear();
};

/* ---------- metrics (advance widths) ---------- */
const _mc = document.createElement('canvas').getContext('2d');
J.metrics = {
  m: new Map(),
  clear() { this.m.clear(); },
  adv(fontKey, ch) {               // advance in em
    const k = fontKey + '\u0000' + ch;
    let v = this.m.get(k);
    if (v === undefined) {
      _mc.font = J.fontCSS(fontKey, 100);
      v = _mc.measureText(ch).width / 100;
      if (!(v > 0)) v = ch === ' ' ? 0.3 : 1;
      this.m.set(k, v);
    }
    return v;
  },
};

/* ---------- glyph decomposition (raster connected components) ----------
   A glyph is rasterised once per (font, char, resolution bucket); its alpha
   mask is split into connected pieces (strokes / radicals / dots) so that
   each can be flown, shattered or dropped independently. Works with any
   font the browser can render, including local and uploaded ones.        */
class GlyphCache {
  constructor() { this.map = new Map(); this.tint = new Map(); this.count = 0; this.maxRes = 512; }
  clear() { this.map.clear(); this.tint.clear(); }
  bucket(px) { let r = 64; while (r < px && r < this.maxRes) r *= 2; return r; }
  get(fontKey, ch, px) {
    const res = this.bucket(px);
    const key = fontKey + '|' + ch + '|' + res;
    let g = this.map.get(key);
    if (!g) { g = decompose(fontKey, ch, res); this.map.set(key, g); if (this.map.size > 1800) this.evict(); }
    return g;
  }
  evict() { let n = 0; for (const k of this.map.keys()) { this.map.delete(k); if (++n > 600) break; } this.tint.clear(); }
  sprite(piece, color) {              // tinted copy of a white piece sprite
    if (color === '#ffffff' || color === '#fff') return piece.cv;
    let m = this.tint.get(piece.id);
    if (!m) { m = new Map(); this.tint.set(piece.id, m); }
    let c = m.get(color);
    if (!c) {
      c = document.createElement('canvas'); c.width = piece.cv.width; c.height = piece.cv.height;
      const x = c.getContext('2d'); x.drawImage(piece.cv, 0, 0); x.globalCompositeOperation = 'source-in'; x.fillStyle = color; x.fillRect(0, 0, c.width, c.height);
      m.set(color, c);
    }
    return c;
  }
}
J.glyphs = new GlyphCache();
let _pid = 0;

function decompose(fontKey, ch, res) {
  const S = Math.ceil(res * 1.45), half = S / 2;
  const cv = document.createElement('canvas'); cv.width = S; cv.height = S;
  const x = cv.getContext('2d', { willReadFrequently: true });
  x.font = J.fontCSS(fontKey, res); x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillStyle = '#fff';
  x.fillText(ch, half, half);
  const img = x.getImageData(0, 0, S, S).data;
  const N = S * S, A = new Uint8Array(N);
  for (let i = 0; i < N; i++) A[i] = img[i * 4 + 3];
  const L = new Int32Array(N), TH = 60;
  const stack = new Int32Array(N);
  let nl = 0; const boxes = [];
  for (let i = 0; i < N; i++) {
    if (A[i] < TH || L[i]) continue;
    nl++; let sp = 0; stack[sp++] = i; L[i] = nl;
    let x0 = S, y0 = S, x1 = 0, y1 = 0, area = 0;
    while (sp) {
      const p = stack[--sp], px = p % S, py = (p / S) | 0; area++;
      if (px < x0) x0 = px; if (px > x1) x1 = px; if (py < y0) y0 = py; if (py > y1) y1 = py;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = py + dy; if (yy < 0 || yy >= S) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = px + dx; if (xx < 0 || xx >= S) continue;
          const q = yy * S + xx;
          if (!L[q] && A[q] >= TH) { L[q] = nl; stack[sp++] = q; }
        }
      }
    }
    boxes[nl] = { x0, y0, x1, y1, area };
  }
  // attach anti-aliased fringe pixels to neighbouring labels (two dilation passes)
  for (let pass = 0; pass < 2; pass++) {
    const L2 = L.slice();
    for (let p = 0; p < N; p++) {
      if (L[p] || !A[p]) continue;
      const px = p % S, py = (p / S) | 0;
      let lab = 0;
      if (px > 0 && L[p - 1]) lab = L[p - 1]; else if (px < S - 1 && L[p + 1]) lab = L[p + 1];
      else if (py > 0 && L[p - S]) lab = L[p - S]; else if (py < S - 1 && L[p + S]) lab = L[p + S];
      if (lab) { L2[p] = lab; const b = boxes[lab]; if (px < b.x0) b.x0 = px; if (px > b.x1) b.x1 = px; if (py < b.y0) b.y0 = py; if (py > b.y1) b.y1 = py; }
    }
    L.set(L2);
  }
  // merge specks into nearest bigger piece
  const minA = res * res * 0.0012;
  const remap = new Int32Array(nl + 1);
  for (let l = 1; l <= nl; l++) remap[l] = l;
  for (let l = 1; l <= nl; l++) {
    const b = boxes[l]; if (b.area >= minA) continue;
    let best = 0, bd = 1e9; const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
    for (let m = 1; m <= nl; m++) {
      if (m === l || boxes[m].area < minA) continue;
      const o = boxes[m]; const dx = Math.max(o.x0 - cx, 0, cx - o.x1), dy = Math.max(o.y0 - cy, 0, cy - o.y1);
      const d = dx * dx + dy * dy; if (d < bd) { bd = d; best = m; }
    }
    if (best) { remap[l] = best; const o = boxes[best]; o.x0 = Math.min(o.x0, b.x0); o.y0 = Math.min(o.y0, b.y0); o.x1 = Math.max(o.x1, b.x1); o.y1 = Math.max(o.y1, b.y1); }
  }
  const pieces = [];
  for (let l = 1; l <= nl; l++) {
    if (remap[l] !== l) continue;
    const b = boxes[l]; const w = b.x1 - b.x0 + 1, h = b.y1 - b.y0 + 1;
    const pc = document.createElement('canvas'); pc.width = w; pc.height = h;
    const px = pc.getContext('2d'); const id = px.createImageData(w, h); const d = id.data;
    for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
      const p = (b.y0 + yy) * S + (b.x0 + xx);
      if (remap[L[p]] === l && L[p]) { const o = (yy * w + xx) * 4; d[o] = d[o + 1] = d[o + 2] = 255; d[o + 3] = A[p]; }
    }
    px.putImageData(id, 0, 0);
    pieces.push({
      id: ++_pid, cv: pc, res,
      // centre & size in em units, relative to glyph centre
      cx: ((b.x0 + b.x1 + 1) / 2 - half) / res, cy: ((b.y0 + b.y1 + 1) / 2 - half) / res,
      w: w / res, h: h / res, area: b.area / (res * res),
      frags: null,
    });
  }
  pieces.sort((a, b) => b.area - a.area);
  return { ch, res, pieces };
}

/* split a piece into up to 3 convex fragments (for shatter) — local em coords around piece centre */
J.fragments = (pc, seed) => {
  if (pc.frags) return pc.frags;
  const w = pc.w, h = pc.h;
  let polys = [[[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]]];
  const cuts = Math.max(pc.w, pc.h) > 0.42 ? 2 : Math.max(pc.w, pc.h) > 0.2 ? 1 : 0;
  for (let c = 0; c < cuts; c++) {
    const next = [];
    for (const poly of polys) {
      const ang = (w > h ? Math.PI / 2 : 0) + J.rs(seed, pc.id, c) * 0.5;
      const nx = Math.cos(ang), ny = Math.sin(ang);
      const cx = poly.reduce((s, p) => s + p[0], 0) / poly.length, cy = poly.reduce((s, p) => s + p[1], 0) / poly.length;
      const off = J.rs(seed, pc.id, c, 7) * 0.12 * Math.max(w, h);
      const d0 = nx * cx + ny * cy + off;
      next.push(clipHalf(poly, nx, ny, d0, 1), clipHalf(poly, nx, ny, d0, -1));
    }
    polys = next.filter(p => p.length >= 3);
  }
  pc.frags = polys.map(p => {
    const cx = p.reduce((s, q) => s + q[0], 0) / p.length, cy = p.reduce((s, q) => s + q[1], 0) / p.length;
    return { poly: p, cx, cy };
  });
  return pc.frags;
};
function clipHalf(poly, nx, ny, d0, sgn) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const da = sgn * (nx * a[0] + ny * a[1] - d0), db = sgn * (nx * b[0] + ny * b[1] - d0);
    if (da >= 0) out.push(a);
    if ((da >= 0) !== (db >= 0)) { const t = da / (da - db); out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]); }
  }
  return out;
}
})();


// Upstream src/02b_lang.js
/* ============================================================
   JIZURA — lyric language: auto-detection + per-language faces
   The styles are designed around Japanese fonts. For Chinese
   (Traditional / Simplified) and Korean lyrics every font key is
   drawn with a face that has the glyphs, chosen to keep the same
   character (gothic → sans, mincho → serif, pop → rounded, …).
   project.lang: 'auto' | 'ja' | 'zh-Hant' | 'zh-Hans' | 'ko'
   ============================================================ */
(() => {
'use strict';

J.LANGS = ['auto', 'ja', 'zh-Hant', 'zh-Hans', 'ko', 'en'];
J.LANG_LABEL = { auto: '自動判定', ja: '日本語', 'zh-Hant': '繁體中文', 'zh-Hans': '简体中文', ko: '한국어', en: 'English' };

/* characters that differ between Traditional and Simplified Chinese (same order in both strings) */
const TC = '們個說這會對時來還後過國開關與為從問間見長東車門愛聽學讓話號發點無現體經電實樣聲變離氣夢給覺當歡陽戀邊頭淚誰歲遠嗎萬難寫應讀憶樂麼麗傷將總結終紅綠線顏風飛鳥謝語請認識熱燈願獨夠紀帶滿靜輕別腦臉懷謊錯顆陣場讚淺溫記憑護壞歸媽隨銀聞態虛遙';
const SC = '们个说这会对时来还后过国开关与为从问间见长东车门爱听学让话号发点无现体经电实样声变离气梦给觉当欢阳恋边头泪谁岁远吗万难写应读忆乐么丽伤将总结终红绿线颜风飞鸟谢语请认识热灯愿独够纪带满静轻别脑脸怀谎错颗阵场赞浅温记凭护坏归妈随银闻态虚遥';
const TCSET = new Set([...TC]), SCSET = new Set([...SC]);
// a few of the "Simplified" forms are also Japanese shinjitai (会 対 来 …) — kana decides Japanese first, so that is harmless

/* which language are these lyrics in? (almost only Latin letters → en (English / romaji), kana → ja, hangul → ko,
   Han only → Traditional / Simplified by the distinctive forms, Traditional when there are none) */
J.detectLang = (text) => {
  let kana = 0, hangul = 0, han = 0, tc = 0, sc = 0, latin = 0;
  for (const c of String(text || '')) {
    const u = c.codePointAt(0);
    if ((u >= 0x41 && u <= 0x5a) || (u >= 0x61 && u <= 0x7a) || (u >= 0xc0 && u <= 0x24f && u !== 0xd7 && u !== 0xf7) || (u >= 0xff21 && u <= 0xff5a && (u <= 0xff3a || u >= 0xff41))) latin++;
    else if ((u >= 0x3041 && u <= 0x30ff && u !== 0x30fb && u !== 0x30fc) || (u >= 0xff66 && u <= 0xff9d)) kana++;
    else if ((u >= 0xac00 && u <= 0xd7a3) || (u >= 0x1100 && u <= 0x11ff) || (u >= 0x3130 && u <= 0x318f)) hangul++;
    else if ((u >= 0x4e00 && u <= 0x9fff) || (u >= 0x3400 && u <= 0x4dbf) || (u >= 0x20000 && u <= 0x2ffff)) {
      han++;
      if (TCSET.has(c)) tc++;
      if (SCSET.has(c)) sc++;
    }
  }
  // a CJK character carries about as much as a short word — weigh it ×3 against single Latin letters
  const cjk = kana + hangul + han;
  if (latin >= 6 && latin >= (latin + cjk * 3) * 0.9) return 'en';
  if (hangul >= 2 && hangul > kana) return 'ko';
  if (kana >= 2 || (kana > 0 && kana >= han * 0.03)) return 'ja';
  // Han without kana is Chinese even when no distinctive form appears (the shared forms render fine in the TC faces)
  if (han >= 2) return sc > tc ? 'zh-Hans' : 'zh-Hant';
  return 'ja';
};
/* project → the language actually used */
J.resolveLang = (project) => {
  const l = project && project.lang;
  if (l && l !== 'auto' && J.LANG_LABEL[l]) return l;
  return J.detectLang(((project && project.lyrics) || '') + ' ' + ((project && project.title) || ''));
};

/* per-language faces: key → [family, weight, Google Fonts spec]; keys left out keep their Japanese face
   (with the language's fallback in front of the Japanese one, so missing glyphs never land in a Japanese face) */
const F = (family, weight, gf) => ({ family, weight, gf });
const NSTC = 'Noto+Sans+TC:wght@300;500;700;900', NSRTC = 'Noto+Serif+TC:wght@300;500;700;800;900';
const NSSC = 'Noto+Sans+SC:wght@300;500;700;900', NSRSC = 'Noto+Serif+SC:wght@300;500;700;800;900';
const NSKR = 'Noto+Sans+KR:wght@300;500;700;900', NSRKR = 'Noto+Serif+KR:wght@300;500;700;800;900';
J.LANG_FACES = {
  'zh-Hant': {
    sans: F('Noto Sans TC', 500, NSTC), serif: F('Noto Serif TC', 500, NSRTC),
    fbSans: '"Noto Sans TC","Noto Sans CJK TC","PingFang TC","Microsoft JhengHei"', fbSerif: '"Noto Serif TC","Noto Serif CJK TC","PMingLiU"',
    map: {
      gothic_black: F('Noto Sans TC', 900, NSTC), gothic_bold: F('Noto Sans TC', 700, NSTC), gothic_med: F('Noto Sans TC', 500, NSTC),
      gothic_light: F('Noto Sans TC', 300, NSTC), zenkaku: F('Noto Sans TC', 900, NSTC), sansui: F('Noto Sans TC', 500, NSTC),
      mincho_black: F('Noto Serif TC', 900, NSRTC), mincho_bold: F('Noto Serif TC', 700, NSRTC), mincho: F('Noto Serif TC', 500, NSRTC),
      mincho_light: F('Noto Serif TC', 300, NSRTC), tokumin: F('Noto Serif TC', 800, NSRTC), shippori: F('Noto Serif TC', 800, NSRTC),
      dela: F('WDXL Lubrifont TC', 400, 'WDXL+Lubrifont+TC'), round: F('Chiron GoRound TC', 800, 'Chiron+GoRound+TC:wght@800'),
      pop: F('Huninn', 400, 'Huninn'), kiwi: F('Huninn', 400, 'Huninn'),
      klee: F('LXGW WenKai TC', 700, 'LXGW+WenKai+TC:wght@700'), brush: F('LXGW WenKai TC', 700, 'LXGW+WenKai+TC:wght@700'),
      reggae: F('LXGW Marker Gothic', 400, 'LXGW+Marker+Gothic'), rampart: F('LXGW Marker Gothic', 400, 'LXGW+Marker+Gothic'), potta: F('LXGW Marker Gothic', 400, 'LXGW+Marker+Gothic'),
    },
  },
  'zh-Hans': {
    sans: F('Noto Sans SC', 500, NSSC), serif: F('Noto Serif SC', 500, NSRSC),
    fbSans: '"Noto Sans SC","Noto Sans CJK SC","PingFang SC","Microsoft YaHei"', fbSerif: '"Noto Serif SC","Noto Serif CJK SC","SimSun"',
    map: {
      gothic_black: F('Noto Sans SC', 900, NSSC), gothic_bold: F('Noto Sans SC', 700, NSSC), gothic_med: F('Noto Sans SC', 500, NSSC),
      gothic_light: F('Noto Sans SC', 300, NSSC), zenkaku: F('Noto Sans SC', 900, NSSC), sansui: F('Noto Sans SC', 500, NSSC),
      mincho_black: F('Noto Serif SC', 900, NSRSC), mincho_bold: F('Noto Serif SC', 700, NSRSC), mincho: F('Noto Serif SC', 500, NSRSC),
      mincho_light: F('Noto Serif SC', 300, NSRSC), tokumin: F('Noto Serif SC', 800, NSRSC), shippori: F('Noto Serif SC', 800, NSRSC),
      dela: F('ZCOOL QingKe HuangYou', 400, 'ZCOOL+QingKe+HuangYou'), round: F('ZCOOL KuaiLe', 400, 'ZCOOL+KuaiLe'),
      pop: F('ZCOOL KuaiLe', 400, 'ZCOOL+KuaiLe'), kiwi: F('ZCOOL KuaiLe', 400, 'ZCOOL+KuaiLe'),
      klee: F('ZCOOL XiaoWei', 400, 'ZCOOL+XiaoWei'), brush: F('Ma Shan Zheng', 400, 'Ma+Shan+Zheng'),
      reggae: F('ZCOOL QingKe HuangYou', 400, 'ZCOOL+QingKe+HuangYou'), rampart: F('ZCOOL QingKe HuangYou', 400, 'ZCOOL+QingKe+HuangYou'), potta: F('Ma Shan Zheng', 400, 'Ma+Shan+Zheng'),
    },
  },
  ko: {
    sans: F('Noto Sans KR', 500, NSKR), serif: F('Noto Serif KR', 500, NSRKR),
    fbSans: '"Noto Sans KR","Noto Sans CJK KR","Apple SD Gothic Neo","Malgun Gothic"', fbSerif: '"Noto Serif KR","Noto Serif CJK KR","AppleMyungjo","Batang"',
    map: {
      gothic_black: F('Noto Sans KR', 900, NSKR), gothic_bold: F('Noto Sans KR', 700, NSKR), gothic_med: F('Noto Sans KR', 500, NSKR),
      gothic_light: F('Noto Sans KR', 300, NSKR), zenkaku: F('Noto Sans KR', 900, NSKR), sansui: F('IBM Plex Sans KR', 500, 'IBM+Plex+Sans+KR:wght@500'),
      mincho_black: F('Noto Serif KR', 900, NSRKR), mincho_bold: F('Noto Serif KR', 700, NSRKR), mincho: F('Noto Serif KR', 500, NSRKR),
      mincho_light: F('Noto Serif KR', 300, NSRKR), tokumin: F('Noto Serif KR', 800, NSRKR), shippori: F('Noto Serif KR', 800, NSRKR),
      dela: F('Black Han Sans', 400, 'Black+Han+Sans'), round: F('Jua', 400, 'Jua'),
      pop: F('Do Hyeon', 400, 'Do+Hyeon'), kiwi: F('Gowun Dodum', 400, 'Gowun+Dodum'),
      klee: F('Gowun Batang', 700, 'Gowun+Batang:wght@700'), brush: F('Nanum Brush Script', 400, 'Nanum+Brush+Script'),
      reggae: F('Black Han Sans', 400, 'Black+Han+Sans'), rampart: F('Black Han Sans', 400, 'Black+Han+Sans'), potta: F('Nanum Brush Script', 400, 'Nanum+Brush+Script'),
    },
  },
};

/* the language fonts are drawn in right now (set by the planner / renderer from plan.lang) */
J.lang = 'ja';
J.setLang = (l) => {
  l = J.LANG_FACES[l] || l === 'en' ? l : 'ja';               // en: the styles' own faces (they all have Latin glyphs)
  if (l === J.lang) return;
  J.lang = l;
  if (J.glyphs) J.glyphs.clear();
  if (J.metrics) J.metrics.clear();
};
/* random characters for scrambles, rain, slot reels, sign boards… — in the lyric's own writing system, so Chinese,
   Korean or English lyrics don't get Japanese katakana around them (issue #16). Japanese keeps the original sets. */
const ZH_T = '的一是不了人我在有他這中大來上國個到說們為子和你地出道也時年得就那要下以生會自著去之過家學對可她裡後小麼心多天而能好都然沒日於起還發成事只作當想看文無開手十用主行方又如前所本見經頭面公同三已老從動兩長知民樣現分將外但身些與高意進把法此實回二理美點月明其種聲全工己話兒者向情部正名定女問力機給等幾很最間新什打便位因重被走電四第門相次東海口使西再平真聽世氣信北少關愛夢光影空夜星雨淚戀花風';
const ZH_S = '的一是不了人我在有他这中大来上国个到说们为子和你地出道也时年得就那要下以生会自着去之过家学对可她里后小么心多天而能好都然没日于起还发成事只作当想看文无开手十用主行方又如前所本见经头面公同三已老从动两长知民样现分将外但身些与高意进把法此实回二理美点月明其种声全工己话儿者向情部正名定女问力机给等几很最间新什打便位因重被走电四第门相次东海口使西再平真听世气信北少关爱梦光影空夜星雨泪恋花风';
const KO = '가나다라마바사아자차카타파하거너더러머버서어저처커터퍼허고노도로모보소오조초코토포호구누두루무부수우주추쿠투푸후그느드르므브스으즈츠크트프흐기니디리미비시이지치키티피히사랑별빛마음노래하늘바람꿈눈물너나우리';
const EN_U = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', EN_L = 'abcdefghijklmnopqrstuvwxyz', DIG = '0123456789', SYM = '＃＊＋＝／＜＞※◇◆□△○';
J.POOLS = {
  ja: { kana: 'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン', hira: 'あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをん',
    half: 'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ0123456789', reel: '夢光影空夜星雨涙心恋声花月風愛嘘罪色音海アイウエオカキクケコサシスセソ0123456789',
    scramble: 'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン愛哀夢嘘声光影空夜星雨涙心恋罪神嘘壊叫虚★◆▲●■※＃＄％＆01234567ABCDEFGHJKLMNPQRSTUVWXYZ',
    signs: 'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン＃＊＋＝／＜＞※◇◆□△○01' },
  'zh-Hant': { kana: ZH_T, hira: ZH_T, half: ZH_T.slice(0, 60) + DIG, reel: ZH_T.slice(-40) + DIG, scramble: ZH_T + '★◆▲●■※＃＄％＆' + DIG, signs: ZH_T.slice(0, 60) + SYM + '01' },
  'zh-Hans': { kana: ZH_S, hira: ZH_S, half: ZH_S.slice(0, 60) + DIG, reel: ZH_S.slice(-40) + DIG, scramble: ZH_S + '★◆▲●■※＃＄％＆' + DIG, signs: ZH_S.slice(0, 60) + SYM + '01' },
  ko: { kana: KO, hira: KO, half: KO.slice(0, 60) + DIG, reel: KO.slice(-30) + DIG, scramble: KO + '★◆▲●■※＃＄％＆' + DIG, signs: KO.slice(0, 60) + SYM + '01' },
  en: { kana: EN_U, hira: EN_L, half: '0123456789ABCDEF', reel: EN_U + DIG, scramble: EN_U + EN_L + '★◆▲●■#$%&' + DIG, signs: EN_U + '#*+=/<>' + '01' },
};
J.pool = (kind) => { const P = J.POOLS[J.lang] || J.POOLS.ja; return P[kind] || J.POOLS.ja[kind]; };
const SERIF_KINDS = { mincho: 1, brush: 1, hand: 1 };
const faceCache = new Map();
/* the face a font key is drawn with in the current language: {family (quoted), weight, fb, gf, label, name (family, for captions)} */
J.faceOf = (key) => {
  const f = J.FONTS[key] || J.FONTS.gothic_bold;
  const L = J.LANG_FACES[J.lang];
  if (!L || f.user) return f;                               // Japanese: the catalogue face itself (fontCSS runs per draw — no allocation)
  const ck = J.lang + '|' + key; let r = faceCache.get(ck);
  if (r) return r;
  const m = L.map[key], fb = (SERIF_KINDS[f.kind] ? L.fbSerif : L.fbSans) + ',' + f.fb;
  r = !m ? { family: f.family, weight: f.weight, fb, gf: f.gf, label: f.label, name: f.label, kind: f.kind }
    : { family: '"' + m.family + '"', weight: m.weight, fb, gf: m.gf, label: m.family + (m.weight !== 400 ? ' ' + m.weight : ''), name: m.family, kind: f.kind };
  faceCache.set(ck, r);
  return r;
};
/* extra faces to load for the current language (the fallback sans / serif that covers glyphs the mapped faces lack) */
J.langBaseFaces = (keys) => {
  const L = J.LANG_FACES[J.lang]; if (!L) return [];
  const out = [L.sans];
  if ((keys || []).some(k => J.FONTS[k] && SERIF_KINDS[J.FONTS[k].kind])) out.push(L.serif);
  return out;
};
/* segmenter locale for chunking */
J.segLocale = () => (J.lang === 'zh-Hant' ? 'zh-Hant' : J.lang === 'zh-Hans' ? 'zh-Hans' : J.lang === 'ko' ? 'ko' : J.lang === 'en' ? 'en' : 'ja');
})();


// Upstream src/03_text.js
/* ============================================================
   JIZURA — text items: layout + drawing (whole glyphs or pieces)
   ============================================================ */
(() => {
'use strict';

J.PID = Object.freeze({ dx: 0, dy: 0, rot: 0, s: 1, st: 1, sdir: 0, a: 1 });
J.PT = (dx = 0, dy = 0, rot = 0, s = 1, st = 1, sdir = 0, a = 1) => ({ dx, dy, rot, s, st, sdir, a });

/* ---------- 文字整列 (typeset): set per plan by the planner / renderer (J.setTypeset) ----------
   kana set a little tighter, particles smaller and the first character larger, Latin a little larger with a
   small gap to Japanese. Only the size / advance of each glyph changes, so every layout keeps working. */
J.TYPESET = false;
J.setTypeset = on => { J.TYPESET = !!on; };
const HIRA = /[ぁ-ゟ]/, KATA = /[゠-ヿㇰ-ㇿ]/, KANJI = /[㐀-鿿豈-﫿々〆]/, LATIN = /[A-Za-z0-9]/;
const PARTICLES = 'はがをにでとのへも';
const cls = ch => (!ch ? '' : LATIN.test(ch) ? 'L' : KANJI.test(ch) ? 'K' : KATA.test(ch) ? 'T' : HIRA.test(ch) ? 'H' : /\s/.test(ch) ? 'S' : 'P');
function isParticle(arr, i) {
  const ch = arr[i], prev = arr[i - 1], next = arr[i + 1];
  if (!prev || PARTICLES.indexOf(ch) < 0 || prev === 'っ' || prev === 'ッ' || prev === 'ー') return false;
  if (ch === 'を') return true;
  const cp = cls(prev), cn = cls(next);
  const nextOK = !next || cn === 'K' || cn === 'T' || cn === 'L' || cn === 'S' || cn === 'P';
  return nextOK && cp !== 'S' && cp !== 'P' && !(cp === 'H' && cn === 'H');
}
/* per character: f = size factor, gap = extra space before it (in em) */
J.typesetLine = (arr) => {
  const out = arr.map(() => ({ f: 1, gap: 0, adv: 1 }));
  if (!J.TYPESET) return out;
  const content = arr.filter(c => !/\s/.test(c)).length;
  let first = true;
  arr.forEach((ch, i) => {
    const c = cls(ch), o = out[i];
    if (c === 'S') return;
    if (c === 'H' || c === 'T') o.adv = J.isSmallKana(ch) ? 0.86 : ch === 'ー' ? 0.94 : 0.9;       // kana: set tighter
    if (c === 'L') o.f = 1.08;
    if ((c === 'H' || c === 'T') && content >= 3 && isParticle(arr, i)) o.f = 0.78;
    if (first && content >= 3 && (c === 'K' || c === 'H' || c === 'T')) o.f = 1.18;               // 頭の字を大きく
    first = false;
    const pc = i > 0 ? cls(arr[i - 1]) : '';
    if (i > 0 && pc !== 'S' && ((c === 'L') !== (pc === 'L')) && pc && pc !== 'P' && c !== 'P') o.gap = 0.2;   // 英字と日本語の間
  });
  return out;
};

/* layout: glyph centres relative to the item origin, in unscaled item space */
J.layoutText = (it) => {
  const text = String(it.text ?? '');
  const size = it.size, track = it.track || 0, sx = it.sx || 1, sy = it.sy || 1;
  const lines = text.split('\n');
  const out = [];
  const vertical = !!it.vertical;
  const lead = (it.lead || 1.3) * size;
  let gi = 0;
  if (!vertical) {
    const sets = lines.map(line => { const arr = [...line]; return { arr, ts: J.typesetLine(arr) }; });
    const widths = sets.map(({ arr, ts }) => {
      let w = 0;
      arr.forEach((ch, i) => { w += (J.metrics.adv(it.font, ch) * ts[i].adv * ts[i].f + ts[i].gap) * size + (i < arr.length - 1 ? track * size : 0); });
      return w;
    });
    const maxW = Math.max(1, ...widths);
    sets.forEach(({ arr, ts }, li) => {
      let x = it.align === 'left' ? 0 : it.align === 'right' ? -widths[li] : -widths[li] / 2;
      const y = (li - (lines.length - 1) / 2) * lead;
      arr.forEach((ch, ci) => {
        const t = ts[ci], a = J.metrics.adv(it.font, ch) * size * t.adv * t.f;
        x += t.gap * size;
        // smaller / larger glyphs keep the line's baseline
        out.push({ ch, i: gi++, li, ci, n: arr.length, x: x + a / 2, y: y + (1 - t.f) * size * 0.36, w: a, h: size * t.f, r90: false, vx: 0, vy: 0, fs: t.f });
        x += a + track * size;
      });
    });
    out.W = maxW; out.H = lines.length * lead - (lead - size);
  } else {
    const sets = lines.map(line => { const arr = [...line]; return { arr, ts: J.typesetLine(arr) }; });
    const heights = sets.map(({ arr, ts }) => arr.reduce((h, ch, i) => h + (vAdv(it.font, ch, size) * ts[i].adv * ts[i].f + ts[i].gap * size) + track * size, 0) - track * size);
    const maxH = Math.max(1, ...heights);
    sets.forEach(({ arr, ts }, li) => {
      let y = it.align === 'left' ? 0 : -heights[li] / 2;         // 'left' == top-aligned for vertical
      const x = -(li - (lines.length - 1) / 2) * lead;
      arr.forEach((ch, ci) => {
        const t = ts[ci], a = vAdv(it.font, ch, size) * t.adv * t.f;
        y += t.gap * size;
        const r90 = J.VERT_ROTATE.includes(ch) || /[A-Za-z0-9]/.test(ch);
        let vx = 0, vy = 0;
        if (J.isSmallKana(ch)) { vx = 0.11 * size; vy = -0.11 * size; }
        if ('、。，．'.includes(ch)) { vx = 0.3 * size; vy = -0.3 * size; }
        out.push({ ch, i: gi++, li, ci, n: arr.length, x, y: y + a / 2, w: size * t.f, h: a, r90, vx, vy, fs: t.f });
        y += a + track * size;
      });
    });
    out.W = lines.length * lead - (lead - size); out.H = maxH;
  }
  out.N = gi;
  return out;
};
function vAdv(font, ch, size) { return /[A-Za-z0-9]/.test(ch) ? J.metrics.adv(font, ch) * size : size; }

/* Blurred / glowing items are drawn ONCE into an offscreen layer and the blur / glow is applied to the whole
   layer — a filter or shadowBlur on every glyph (× 3 chromatic passes) is very slow on canvas. */
let layerCv = null;
function drawItemLayered(env, it) {
  const ctx = env.ctx;
  const lay = it._lay || (it._lay = J.layoutText(it));
  const size = it.size, sx = it.sx || 1, sy = it.sy || 1;
  // item-local bounds of every glyph including per-glyph offsets
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (const g of lay) {
    const c = it.charFn ? it.charFn(g.i, g, lay.N) : null;
    if (c && c.hide) continue;
    const s = c && c.s != null ? Math.abs(c.s) : 1, gw = g.w * sx * s * (c && c.sx ? Math.abs(c.sx) : 1), gh = g.h * sy * s * (c && c.sy ? Math.abs(c.sy) : 1);
    const r = Math.max(gw, gh) * (c && c.rot ? 0.75 : 0.55);
    const gx = g.x * sx + g.vx * sx + (c ? c.dx || 0 : 0), gy = g.y * sy + g.vy * sy + (c ? c.dy || 0 : 0);
    x0 = Math.min(x0, gx - r); x1 = Math.max(x1, gx + r); y0 = Math.min(y0, gy - r); y1 = Math.max(y1, gy + r);
  }
  if (x0 > x1) return null;
  const sh = it.shadow, ex = it.extrude;
  const pad = (it.blur || 0) * 2.6 + size * 0.12 + (it.stroke || 0) + (sh ? (sh.blur || 0) * 1.3 + Math.abs(sh.dx || 0) + Math.abs(sh.dy || 0) : 0) + (ex ? Math.abs(ex.dx || 0) + Math.abs(ex.dy || 0) : 0);
  x0 -= pad; y0 -= pad; x1 += pad; y1 += pad;
  const T = ctx.getTransform(), k = Math.max(0.05, Math.hypot(T.a, T.b));
  const ow = Math.ceil((x1 - x0) * k), oh = Math.ceil((y1 - y0) * k);
  if (ow < 2 || oh < 2 || ow * oh > ctx.canvas.width * ctx.canvas.height * 1.6) return undefined;   // fall back to the direct path
  if (!layerCv) layerCv = document.createElement('canvas');
  if (layerCv.width < ow || layerCv.height < oh) { layerCv.width = Math.max(ow, layerCv.width); layerCv.height = Math.max(oh, layerCv.height); }
  const L = layerCv.getContext('2d');
  L.setTransform(1, 0, 0, 1, 0, 0); L.globalAlpha = 1; L.globalCompositeOperation = 'source-over'; L.filter = 'none';
  L.clearRect(0, 0, ow, oh);
  L.setTransform(k, 0, 0, k, -x0 * k, -y0 * k);
  const inner = Object.assign({}, it, { x: 0, y: 0, rot: 0, skew: 0, blur: 0, shadow: null, blend: null });
  const bb = J.drawItem(Object.assign({}, env, { ctx: L, inLayer: true, scale: k }), inner);
  ctx.save();
  ctx.translate(it.x, it.y);
  if (it.rot) ctx.rotate(it.rot * J.DEG);
  if (it.skew) ctx.transform(1, 0, Math.tan(it.skew * J.DEG), 1, 0, 0);
  if (it.blend) ctx.globalCompositeOperation = it.blend;
  if (it.blur > 0.4) ctx.filter = `blur(${(it.blur * env.scale).toFixed(1)}px)`;
  if (sh && env.pass === 'main') {
    ctx.shadowColor = sh.color || 'rgba(0,0,0,0.6)'; ctx.shadowBlur = (sh.blur || 0) * env.scale;
    ctx.shadowOffsetX = (sh.dx || 0) * env.scale; ctx.shadowOffsetY = (sh.dy || 0) * env.scale;
  }
  ctx.drawImage(layerCv, 0, 0, ow, oh, x0, y0, ow / k, oh / k);
  ctx.restore();
  if (!bb) return null;
  return Object.assign({}, bb, { x0: bb.x0 + it.x, x1: bb.x1 + it.x, y0: bb.y0 + it.y, y1: bb.y1 + it.y, cx: it.x, cy: it.y });
}

/* draw one text item. env = {ctx, pass, passColor, scale}. Returns design-space bbox + glyph boxes. */
/* 飾りの数字・時刻を出さない: decorative copy that is only a number (No.01, #03, 128) or a time (00:12.34, REC 1:05).
   Anything that also appears in the lyric of the cut is lyric, and stays. */
const CJK = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/;
J.decoTextKind = (t) => {
  t = String(t || '').trim();
  if (!t || !/\d/.test(t) || CJK.test(t)) return null;
  if (/\d{1,2}[:：]\d{2}/.test(t) && /^[A-Za-z]{0,4}[\s.#]*[\d:：.;'"\s\/\-–—+]+[A-Za-z]{0,3}$/.test(t)) return 'time';
  if ((t.match(/[A-Za-z]/g) || []).length <= 5 && /^[A-Za-z#№.\s\d\/\-–—+×x%:,'°]+$/.test(t)) return 'no';
  return null;
};
J.hideDecoText = (env, text) => {
  const fx = env.fx || {};
  if (!fx.hideNo && !fx.hideTime) return false;
  const k = J.decoTextKind(text);
  if (!k || !(k === 'no' ? fx.hideNo : fx.hideTime)) return false;
  const lyr = env.cut ? String(env.cut.lineText || env.cut.text || '') : '';
  return !lyr.includes(String(text).trim());
};
J.drawItem = (env, it) => {
  const ctx = env.ctx;
  const ghostPass = env.pass !== 'main';
  if (ghostPass && it.ghost === false) return null;
  if (!it.text || it.size <= 0.5) return null;
  if (J.hideDecoText(env, it.text)) return null;
  if (!env.inLayer && !env.glyphLog && !env.hideText && env.allowFilter && !it.pieceFn && ((it.blur || 0) > 0.4 || (it.shadow && !ghostPass && (it.shadow.blur || 0) * (env.scale || 1) > 6))) {
    const r = drawItemLayered(env, it);
    if (r !== undefined) return r;
  }
  const lay = it._lay || J.layoutText(it);
  const size = it.size, sx = it.sx || 1, sy = it.sy || 1;
  const baseAlpha = (it.alpha ?? 1) * (ghostPass ? (it.ghostAlpha ?? 1) : 1);
  if (baseAlpha <= 0.002) return null;
  const col = ghostPass ? env.passColor : (it.color || '#fff');
  const sCol = ghostPass ? env.passColor : (it.strokeColor || it.color || '#fff');
  const fill = it.fill !== false;
  ctx.save();
  ctx.translate(it.x, it.y);
  if (it.rot) ctx.rotate(it.rot * J.DEG);
  if (it.skew) ctx.transform(1, 0, Math.tan(it.skew * J.DEG), 1, 0, 0);
  if (it.blend) ctx.globalCompositeOperation = it.blend;
  if (it.blur > 0.4 && env.allowFilter) ctx.filter = `blur(${(it.blur * env.scale).toFixed(1)}px)`;
  // 太さ (統一感): the lyric grows from a hairline to heavy on a variable face (Noto Sans / Serif JP)
  const wg = env.cut && env.cut.weightGrow && !it.noWeight ? J.weightNow(env) : 0;
  ctx.font = wg ? J.varFontCSS(it.font, size, wg) : J.fontCSS(it.font, size);
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  let grad = null;
  if (!ghostPass && it.gradient && fill) {
    // gradient coordinates live in each glyph's local space (the fill happens after the per-glyph translate)
    grad = ctx.createLinearGradient(0, -size * 0.5, 0, size * 0.5);
    if (it.gradient.length === 2) { grad.addColorStop(0, it.gradient[0]); grad.addColorStop(1, it.gradient[1]); }
    else it.gradient.forEach(([o, c]) => grad.addColorStop(o, c));      // [[offset, colour], ...] for hard splits
  }
  if (!ghostPass && it.pattern && fill && !grad) grad = J.textPattern(ctx, it.pattern, it.patternColor || it.color || '#fff', it.patternBg, size, env.scale || 1);
  const fillA = it.fillAlpha ?? 1;
  const shadow = !ghostPass && it.shadow;
  if (shadow) {
    const k = env.scale || 1;
    ctx.shadowColor = shadow.color || 'rgba(0,0,0,0.6)'; ctx.shadowBlur = env.allowFilter === false ? 0 : (shadow.blur || 0) * k;
    ctx.shadowOffsetX = (shadow.dx || 0) * k; ctx.shadowOffsetY = (shadow.dy || 0) * k;
  }
  const ext = !ghostPass && it.extrude && it.extrude.n > 0 ? it.extrude : null;
  const dash = it.dash != null && it.dash < 1 ? it.dash : null;
  const boxes = [];
  const pxScale = size * Math.max(sx, sy) * (env.scale || 1);
  for (const g of lay) {
    if (g.ch === ' ' || g.ch === '　') continue;
    const c = it.charFn ? it.charFn(g.i, g, lay.N) : null;
    if (c && c.hide) continue;
    const a = baseAlpha * (c && c.a != null ? c.a : 1);
    if (a <= 0.002) continue;
    const ch = (c && c.ch) || g.ch;
    const cs = (c && c.s != null ? c.s : 1) * (g.fs || 1);
    const gx = g.x * sx + g.vx * sx + (c ? c.dx || 0 : 0);
    const gy = g.y * sy + g.vy * sy + (c ? c.dy || 0 : 0);
    const crot = (c ? c.rot || 0 : 0) + (g.r90 ? 90 : 0);
    const csx = sx * cs * (c && c.sx ? c.sx : 1), csy = sy * cs * (c && c.sy ? c.sy : 1);
    const gcol = (!ghostPass && c && c.color) || col;
    boxes.push({ x: gx, y: gy, w: g.w * sx * cs / (g.fs || 1), h: g.h * sy * cs / (g.fs || 1) });
    // モーフ: record where each glyph ends up (device space) / leave the glyphs out while the morph draws them
    if (env.glyphLog && !ghostPass) {
      ctx.save(); ctx.translate(gx, gy); if (crot) ctx.rotate(crot * J.DEG); if (csx !== 1 || csy !== 1) ctx.scale(csx, csy);
      const T = ctx.getTransform(); ctx.restore();
      env.glyphLog.push({ ch, m: [T.a, T.b, T.c, T.d, T.e, T.f], font: ctx.font, px: size, color: typeof gcol === 'string' ? gcol : (it.color || '#fff'), a: a * (fill ? fillA : 1),
        stroke: it.stroke > 0 ? it.stroke : 0, strokeColor: typeof sCol === 'string' ? sCol : null, fill: fill && !(c && c.outline) });
    }
    if (env.hideText) continue;
    // ---- piece mode ----
    if (it.pieceFn && fill && !(c && c.ch) && !it.gradient && dash == null && !(c && (c.clipY || c.clipX || c.outline))) {
      if (drawPieces(env, it, g, ch, gx, gy, crot, csx, csy, gcol, a, pxScale * cs)) continue;
    }
    ctx.save();
    ctx.translate(gx, gy);
    if (crot) ctx.rotate(crot * J.DEG);
    if (c && c.skew) ctx.transform(1, 0, Math.tan(c.skew * J.DEG), 1, 0, 0);
    if (csx !== 1 || csy !== 1) ctx.scale(csx, csy);
    if (c && (c.clipY || c.clipX)) {           // per-glyph mask, in fractions of the glyph box (centre = 0)
      const cy = c.clipY || [-0.7, 0.7], cx = c.clipX || [-0.7, 0.7];
      ctx.beginPath(); ctx.rect(cx[0] * g.w, cy[0] * g.h, (cx[1] - cx[0]) * g.w, (cy[1] - cy[0]) * g.h); ctx.clip();
    }
    if (c && c.blur > 0.4 && env.allowFilter) ctx.filter = `blur(${(c.blur * env.scale).toFixed(1)}px)`;
    ctx.globalAlpha = a;
    const outlineOnly = c && c.outline;
    if (ext && !outlineOnly) {
      ctx.fillStyle = ext.color || '#000';
      const ea = ext.a ?? 1;
      for (let k = ext.n; k >= 1; k--) { ctx.globalAlpha = a * ea * (ext.fade ? 1 - (k - 1) / ext.n * 0.85 : 1); ctx.fillText(ch, ext.dx * k / ext.n / csx, ext.dy * k / ext.n / csy); }
      ctx.globalAlpha = a;
    }
    if (fill && !outlineOnly && fillA > 0.002 && dash == null) { ctx.globalAlpha = a * fillA; ctx.fillStyle = grad || gcol; ctx.fillText(ch, 0, 0); ctx.globalAlpha = a; }
    if (it.stroke > 0 || outlineOnly || dash != null) {
      if (shadow && fill) { ctx.shadowColor = 'rgba(0,0,0,0)'; }
      ctx.lineJoin = 'round'; ctx.miterLimit = 2;
      ctx.lineWidth = (it.stroke > 0 ? it.stroke : Math.max(1, size * 0.02)) / Math.sqrt(Math.abs(csx * csy));
      ctx.strokeStyle = (!ghostPass && c && c.color) || sCol;
      if (dash != null) { const L = size * 3.2; ctx.setLineDash([Math.max(0.01, L * dash), L]); ctx.lineDashOffset = 0; }
      else if (it.strokeDash) ctx.setLineDash(it.strokeDash);
      ctx.strokeText(ch, 0, 0);
      ctx.setLineDash([]);
      if (fill && !outlineOnly && (it.strokeUnder || (dash != null && fillA > 0.002))) { ctx.globalAlpha = a * (dash != null ? fillA : 1); ctx.fillStyle = grad || gcol; ctx.fillText(ch, 0, 0); }
    }
    ctx.restore();
  }
  ctx.restore();
  // bbox in design space (rotation ignored except translate)
  if (!boxes.length) return null;
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (const b of boxes) { x0 = Math.min(x0, b.x - b.w / 2); x1 = Math.max(x1, b.x + b.w / 2); y0 = Math.min(y0, b.y - b.h / 2); y1 = Math.max(y1, b.y + b.h / 2); }
  return { x0: it.x + x0, y0: it.y + y0, x1: it.x + x1, y1: it.y + y1, boxes, cx: it.x, cy: it.y };
};

/* 太さ: growth 0..1 of the current cut (never exactly 0, so it also means "on"); eased, over the first half of the cut */
J.weightNow = (env) => {
  const span = Math.max(0.5, Math.min(1.4, env.cut.dur * 0.5));
  const k = J.clamp(((env.ltb ?? env.lt) || 0) / span);
  return 1e-3 + (1 - Math.pow(1 - k, 3)) * (1 - 1e-3);
};
J.varFontCSS = (key, px, e) => {
  const f = J.FONTS[key] || {}, serif = f.kind === 'mincho';
  const w = Math.round(serif ? 200 + e * 700 : 100 + e * 800);
  return `${w} ${px.toFixed(2)}px ${serif ? '"Noto Serif JP"' : '"Noto Sans JP"'},${f.fb || 'sans-serif'}`;
};

/* returns true if pieces were drawn (i.e. not at rest) */
function drawPieces(env, it, g, ch, gx, gy, crot, sx, sy, col, alpha, px) {
  const glyph = J.glyphs.get(it.font, ch, px);
  const list = it.shatter ? fragList(glyph, it.seed || 1) : glyph.pieces;
  if (!list.length) return false;
  const size = it.size;
  const res = glyph.res;
  const pts = new Array(list.length);
  let moving = false;
  const cr = Math.cos(crot * J.DEG), sr = Math.sin(crot * J.DEG);
  for (let j = 0; j < list.length; j++) {
    const p = list[j];
    const ex = p.cx * size * sx, ey = p.cy * size * sy;          // piece centre offset (em->px, scaled)
    const ox = gx + ex * cr - ey * sr, oy = gy + ex * sr + ey * cr;
    const t = it.pieceFn(g.i, j, p, ox, oy, g);
    pts[j] = t;
    if (t !== J.PID && t !== null) moving = true;
    if (t === null) moving = true;
    pts[j] = { t, ox, oy };
  }
  if (!moving) return false;
  const ctx = env.ctx;
  for (let j = 0; j < list.length; j++) {
    const { t, ox, oy } = pts[j];
    if (!t || t.a <= 0.003) continue;
    const p = list[j];
    const spr = J.glyphs.sprite(p.src || p, col);
    ctx.save();
    ctx.translate(ox + t.dx, oy + t.dy);
    if (t.st !== 1) { const d = t.sdir * J.DEG; ctx.rotate(d); ctx.scale(t.st, 1 / Math.sqrt(t.st)); ctx.rotate(-d); }
    ctx.rotate((crot + t.rot) * J.DEG);
    const k = size / res * t.s;
    ctx.scale(sx * k, sy * k);
    ctx.globalAlpha = alpha * t.a;
    if (p.poly) {
      // fragment: clip to polygon (coords in em around fragment centre) then draw parent sprite
      const src = p.src;
      ctx.beginPath();
      p.poly.forEach((q, qi) => { const X = (q[0] - p.fx) * res, Y = (q[1] - p.fy) * res; qi ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y); });
      ctx.closePath(); ctx.clip();
      ctx.drawImage(spr, -p.fx * res - src.w * res / 2, -p.fy * res - src.h * res / 2);
    } else {
      ctx.drawImage(spr, -spr.width / 2, -spr.height / 2);
    }
    ctx.restore();
  }
  return true;
}

function fragList(glyph, seed) {
  if (glyph.frags) return glyph.frags;
  const out = [];
  for (const p of glyph.pieces) {
    const fr = J.fragments(p, seed);
    if (fr.length <= 1) { out.push(p); continue; }
    for (const f of fr) out.push({ src: p, poly: f.poly, fx: f.cx, fy: f.cy, cx: p.cx + f.cx, cy: p.cy + f.cy, w: p.w, h: p.h, area: p.area / fr.length, id: p.id * 8 + out.length });
  }
  glyph.frags = out;
  return out;
}

/* fill patterns for text: 'dots' | 'stripes' | 'hatch' | 'grid' | 'lines' — cell size follows the text size */
const patCache = new Map();
J.textPattern = (ctx, kind, color, bg, size, scale) => {
  const cell = Math.max(3, Math.round(size * (kind === 'dots' ? 0.075 : 0.06))), px = Math.max(2, Math.round(cell * scale));
  const key = kind + color + (bg || '') + px;
  let cv = patCache.get(key);
  if (!cv) {
    cv = document.createElement('canvas'); cv.width = cv.height = px;
    const x = cv.getContext('2d');
    if (bg) { x.fillStyle = bg; x.fillRect(0, 0, px, px); }
    x.fillStyle = color; x.strokeStyle = color;
    if (kind === 'dots') { x.beginPath(); x.arc(px / 2, px / 2, px * 0.34, 0, J.TAU); x.fill(); }
    else if (kind === 'stripes') { x.lineWidth = px * 0.38; x.beginPath(); x.moveTo(-px, px * 2); x.lineTo(px * 2, -px); x.moveTo(-px, px); x.lineTo(px, -px); x.moveTo(0, px * 2); x.lineTo(px * 2, 0); x.stroke(); }
    else if (kind === 'hatch') { x.lineWidth = Math.max(1, px * 0.16); x.beginPath(); x.moveTo(0, 0); x.lineTo(px, px); x.moveTo(px, 0); x.lineTo(0, px); x.stroke(); }
    else if (kind === 'grid') { x.fillRect(0, 0, px, Math.max(1, px * 0.18)); x.fillRect(0, 0, Math.max(1, px * 0.18), px); }
    else { x.fillRect(0, 0, px, Math.max(1, px * 0.45)); }                          // 'lines'
    if (patCache.size > 80) patCache.clear();
    patCache.set(key, cv);
  }
  const pat = ctx.createPattern(cv, 'repeat');
  try { if (pat.setTransform && scale !== 1) pat.setTransform(new DOMMatrix().scale(1 / scale)); } catch (e) {}
  return pat;
};

/* measure an item's laid-out size in design px (after sx/sy) */
J.measure = (it) => { const l = J.layoutText(it); return { w: l.W * (it.sx || 1), h: l.H * (it.sy || 1), lay: l }; };

/* size that makes text fit a box */
J.fitSize = (text, font, maxW, maxH, opt = {}) => {
  const probe = Object.assign({ text, font, size: 100, track: 0 }, opt);
  const m = J.measure(probe);
  const k = Math.min(maxW / Math.max(1, m.w), maxH / Math.max(1, m.h));
  return 100 * k;
};
})();


// Upstream src/04_styles.js
/* ============================================================
   JIZURA — style packs (palettes, type roles, texture, tendencies)
   Each pack = a set of colour schemes the cuts can swap between,
   font roles, texture, ghost (chromatic) colours and recipe biases.
   ============================================================ */
(() => {
'use strict';

/* scheme: bg, fg, sub, accent, accent2, ink (sticker/box colour), dim (bg text), ghostA, ghostB, grad */
J.STYLES = {
  noir: {
    name: 'ノワール・クロマ', desc: '黒地・白文字・シアン/琥珀の色ズレ',
    schemes: [
      { bg: '#060607', fg: '#F5EEEA', sub: '#BDB6B2', accent: '#F5A50C', accent2: '#16F4D4', ink: '#F5EEEA', dim: '#2A2A2E', ghostA: '#F5A50C', ghostB: '#16F4D4' },
      { bg: '#F2EDE8', fg: '#0B0B0C', sub: '#4A4644', accent: '#E0600C', accent2: '#0FAE98', ink: '#0B0B0C', dim: '#D9D2CC', ghostA: '#F5A50C', ghostB: '#16C4B4', swap: true },
    ],
    fonts: { display: ['gothic_black', 'dela', 'zenkaku'], serif: ['mincho_light', 'mincho'], body: ['gothic_med'], mono: ['mono'] },
    texture: { grain: 0.9, paper: 0, scan: 0 }, ghost: 1.0,
    bias: { layout: { vcols: 2, condensed: 2, marquee: 1.6, tile: 1.4, center: 1.2 }, enter: { assemble: 2.2, slice: 1.8, stretch: 1.4 }, exit: { explode: 1.8, fall: 1.2, drift: 1.4 } },
    decor: { rings: 0.8, hud: 0.4, slash: 0.6 }, hud: false,
  },
  crimson: {
    name: 'クリムゾン・シグナル', desc: '深紅地・白と黒の二段組み・データ破損',
    schemes: [
      { bg: '#C8103F', fg: '#FFFFFF', sub: '#FFD9E2', accent: '#140509', accent2: '#39F2C8', ink: '#140509', dim: '#B00D37', ghostA: '#FFFFFF', ghostB: '#39F2C8' },
      { bg: '#FF6F98', fg: '#FFFFFF', sub: '#FFE3EB', accent: '#1A0710', accent2: '#39F2C8', ink: '#1A0710', dim: '#F25C87', ghostA: '#FFFFFF', ghostB: '#1A0710' },
      { bg: '#150509', fg: '#FF3D6E', sub: '#FF9DB6', accent: '#FFFFFF', accent2: '#39F2C8', ink: '#FF3D6E', dim: '#2A0B14', ghostA: '#FF3D6E', ghostB: '#39F2C8' },
    ],
    fonts: { display: ['gothic_black', 'zenkaku'], serif: ['mincho'], body: ['gothic_med', 'sansui'], mono: ['mono'] },
    texture: { grain: 0.6, paper: 0, scan: 0.4 }, ghost: 0.8,
    bias: { layout: { huge: 2, marquee: 1.6, scatter: 1.5, stack: 1.3, type: 1.3 }, enter: { scramble: 1.6, slice: 1.6, type: 1.3 }, exit: { glitch: 2, slice: 1.6 } },
    decor: { hud: 1, arrows: 0.8, rings: 0.8 }, hud: true, glitchBoost: 1.4,
  },
  caution: {
    name: 'コーション', desc: '黄色地・赤と青のアクセント・計器UI',
    schemes: [
      { bg: '#F4D21F', fg: '#141414', sub: '#3A3510', accent: '#E0231C', accent2: '#1F3FD8', ink: '#141414', dim: '#E6C413', ghostA: '#E0231C', ghostB: '#1F3FD8' },
      { bg: '#E0231C', fg: '#F4D21F', sub: '#FFE9A0', accent: '#141414', accent2: '#FFFFFF', ink: '#141414', dim: '#C81E17', ghostA: '#141414', ghostB: '#F4D21F' },
      { bg: '#18181A', fg: '#F4D21F', sub: '#DDD6B0', accent: '#E0231C', accent2: '#FFFFFF', ink: '#F4D21F', dim: '#26262A', ghostA: '#E0231C', ghostB: '#1F3FD8' },
    ],
    fonts: { display: ['mincho_black', 'gothic_black'], serif: ['mincho_black', 'mincho_bold'], body: ['gothic_bold'], mono: ['mono'] },
    texture: { grain: 0.5, paper: 0.25, scan: 0 }, ghost: 0.55,
    bias: { layout: { ring: 2.2, mixed: 2, circle: 1.4, gloss: 1.2 }, enter: { pop: 1.6, spin: 1.5, wipe: 1.2 }, exit: { scatter: 1.5, shrink: 1.2 } },
    decor: { hud: 1, rings: 1, arrows: 1, counter: 0.8, barcode: 0.8 }, hud: true,
  },
  magenta: {
    name: 'ポップ・マゼンタ', desc: 'ショッキングピンク×白・太丸ゴシック・引き出し線',
    schemes: [
      { bg: '#FF0A8C', fg: '#FFFFFF', sub: '#FFD2EA', accent: '#FFFFFF', accent2: '#2B2BD9', ink: '#FFFFFF', dim: '#F0077F', ghostA: '#FF8CC8', ghostB: '#2B2BD9' },
      { bg: '#FFFFFF', fg: '#FF0A8C', sub: '#FF6DB6', accent: '#2B2BD9', accent2: '#FF0A8C', ink: '#FF0A8C', dim: '#FFE4F2', ghostA: '#2B2BD9', ghostB: '#FF8CC8' },
      { bg: '#2B2BD9', fg: '#FFFFFF', sub: '#C9C9FF', accent: '#FF0A8C', accent2: '#FFFFFF', ink: '#FFFFFF', dim: '#2424C4', ghostA: '#FF0A8C', ghostB: '#FFFFFF' },
    ],
    fonts: { display: ['round', 'pop', 'gothic_black'], serif: ['mincho_bold'], body: ['round', 'gothic_bold'], mono: ['mono'] },
    texture: { grain: 0.3, paper: 0, scan: 0 }, ghost: 0.35,
    bias: { layout: { wave: 2.2, gloss: 1.6, huge: 1.6, pill: 1.4, scatter: 1.2 }, enter: { pop: 2, drop: 1.6, spin: 1.3, blur: 1.2 }, exit: { scatter: 1.6, shrink: 1.4, blur: 1.2 } },
    decor: { leaders: 1, counter: 1, sparks: 0.8, shapes: 0.6 }, hud: false,
  },
  paper: {
    name: 'ペーパー・インク', desc: '紙の質感・藍とマゼンタ・明朝の残像',
    schemes: [
      { bg: '#ECE9E3', fg: '#1B2350', sub: '#4D5270', accent: '#C2185B', accent2: '#111111', ink: '#111111', dim: '#DAD6CE', ghostA: '#C2185B', ghostB: '#1B2350', paper: true },
      { bg: '#151515', fg: '#F0EDE7', sub: '#B8B4AC', accent: '#C2185B', accent2: '#1B2350', ink: '#F0EDE7', dim: '#232323', ghostA: '#C2185B', ghostB: '#3A4690', paper: true },
      { bg: '#C2185B', fg: '#FFFFFF', sub: '#F6C6D8', accent: '#1B2350', accent2: '#111111', ink: '#1B2350', dim: '#B5154F', ghostA: '#1B2350', ghostB: '#FFFFFF', paper: true },
      { bg: '#1B2350', fg: '#F0EDE7', sub: '#AEB2CC', accent: '#C2185B', accent2: '#FFFFFF', ink: '#F0EDE7', dim: '#1F2858', ghostA: '#C2185B', ghostB: '#FFFFFF', paper: true },
    ],
    fonts: { display: ['mincho_black', 'tokumin'], serif: ['mincho_black', 'mincho_bold'], body: ['mincho'], mono: ['mono'] },
    texture: { grain: 0.7, paper: 1, scan: 0 }, ghost: 0.5,
    bias: { layout: { stack: 2.2, mixed: 1.8, huge: 1.6, vcols: 1.4, circle: 1.2 }, enter: { wipe: 1.6, stretch: 1.4, blur: 1.2, slice: 1.2 }, exit: { drift: 1.6, wipe: 1.4 } },
    decor: { bars: 1, blobs: 0.8, shapes: 0.6, waveform: 0.4 }, hud: false,
  },
  hud: {
    name: 'ダークHUD', desc: '炭色地・細線フレーム・橙の差し色・日食',
    schemes: [
      { bg: '#131315', fg: '#EFEDEA', sub: '#8E8B88', accent: '#F25A2B', accent2: '#FFFFFF', ink: '#EFEDEA', dim: '#1E1E21', ghostA: '#F25A2B', ghostB: '#7FD7FF' },
      { bg: '#0B0B0C', fg: '#FFFFFF', sub: '#9A9796', accent: '#F25A2B', accent2: '#FFFFFF', ink: '#F25A2B', dim: '#18181A', ghostA: '#F25A2B', ghostB: '#FFFFFF' },
    ],
    fonts: { display: ['gothic_black', 'zenkaku'], serif: ['mincho_bold', 'mincho_light'], body: ['gothic_med'], mono: ['mono'] },
    texture: { grain: 1, paper: 0, scan: 0.2 }, ghost: 0.6,
    bias: { layout: { circle: 2, ring: 1.6, vcols: 1.4, center: 1.2, gloss: 1 }, enter: { blur: 1.6, type: 1.4, assemble: 1.3 }, exit: { blur: 1.4, drift: 1.4, explode: 1.2 } },
    decor: { hud: 1, rings: 1, arrows: 1, grid: 0.8, slash: 0.6 }, hud: true, glow: 1.4,
  },
  mint: {
    name: 'ミント・ターミナル', desc: '黒×青緑×ライム・ラベル貼り・スリットスキャン',
    schemes: [
      { bg: '#0A0E0D', fg: '#E6FFF5', sub: '#7FB9A8', accent: '#9CFF3A', accent2: '#2E8C74', ink: '#E6FFF5', dim: '#142420', ghostA: '#FF3B6B', ghostB: '#2EE6C8' },
      { bg: '#3FAE93', fg: '#0A0E0D', sub: '#123A31', accent: '#FFFFFF', accent2: '#9CFF3A', ink: '#0A0E0D', dim: '#39A087', ghostA: '#FFFFFF', ghostB: '#0A0E0D' },
      { bg: '#F2F2EE', fg: '#0A0E0D', sub: '#40504B', accent: '#2E8C74', accent2: '#9CFF3A', ink: '#0A0E0D', dim: '#E2E4DE', ghostA: '#2E8C74', ghostB: '#9CFF3A' },
    ],
    fonts: { display: ['gothic_black', 'dela'], serif: ['mincho'], body: ['gothic_med', 'sansui'], mono: ['mono', 'dot'] },
    texture: { grain: 0.8, paper: 0, scan: 0.6 }, ghost: 0.9,
    bias: { layout: { labels: 2.4, tile: 1.6, marquee: 1.4, type: 1.4, diag: 1.2 }, enter: { scramble: 1.8, type: 1.6, flicker: 1.4 }, exit: { glitch: 1.6, slice: 1.4 } },
    decor: { hud: 1, grid: 0.8, barcode: 0.8, sparks: 0.5 }, hud: true,
  },
  specimen: {
    name: 'スペシメン', desc: '墨色地・明朝・辞書の注釈と引き出し線',
    schemes: [
      { bg: '#1B1A1C', fg: '#F2F0EC', sub: '#A19E99', accent: '#F2F0EC', accent2: '#C8B98C', ink: '#F2F0EC', dim: '#2A292C', ghostA: '#6E6A66', ghostB: '#C8B98C' },
      { bg: '#F2F0EC', fg: '#1B1A1C', sub: '#5E5B57', accent: '#1B1A1C', accent2: '#8A7A4E', ink: '#1B1A1C', dim: '#E3E0DA', ghostA: '#B9B4AD', ghostB: '#8A7A4E' },
    ],
    fonts: { display: ['mincho_bold', 'mincho_black'], serif: ['mincho', 'mincho_light'], body: ['mincho'], mono: ['mono'] },
    texture: { grain: 0.6, paper: 0.3, scan: 0 }, ghost: 0.25,
    bias: { layout: { gloss: 2.6, vcols: 1.8, mixed: 1.4, center: 1.2, tile: 1 }, enter: { type: 1.8, blur: 1.6, wipe: 1.2 }, exit: { blur: 1.6, drift: 1.2, wipe: 1.2 } },
    decor: { leaders: 1, slash: 0.8, rings: 0.4 }, hud: false,
  },
  transit: {
    name: 'トランジット', desc: 'オリーブ×黄色・矢印と標識・網点',
    schemes: [
      { bg: '#5B582B', fg: '#FFFFFF', sub: '#E6E2BC', accent: '#E8C21A', accent2: '#1A1A1A', ink: '#E8C21A', dim: '#67633A', ghostA: '#E8C21A', ghostB: '#1A1A1A' },
      { bg: '#1A1A1A', fg: '#FFFFFF', sub: '#B8B5A0', accent: '#E8C21A', accent2: '#FFFFFF', ink: '#E8C21A', dim: '#242424', ghostA: '#E8C21A', ghostB: '#7C7A55' },
      { bg: '#9C9A94', fg: '#FFFFFF', sub: '#F0EEE6', accent: '#E8C21A', accent2: '#1A1A1A', ink: '#1A1A1A', dim: '#A6A49E', ghostA: '#E8C21A', ghostB: '#1A1A1A' },
    ],
    fonts: { display: ['zenkaku', 'gothic_black'], serif: ['mincho_bold'], body: ['gothic_bold'], mono: ['mono'] },
    texture: { grain: 0.8, paper: 0.2, scan: 0 }, ghost: 0.5,
    bias: { layout: { mixed: 2, scatter: 1.6, diag: 1.4, huge: 1.2 }, enter: { spin: 1.6, drop: 1.4, pop: 1.2, stretch: 1.2 }, exit: { scatter: 1.4, stretch: 1.4 } },
    decor: { arrows: 1.4, shapes: 1, counter: 0.8, rings: 0.6 }, hud: false,
  },
  blueprint: {
    name: 'ブループリント', desc: '鮮青×白×黒・図形コラージュ・斜め帯',
    schemes: [
      { bg: '#1B1BE8', fg: '#FFFFFF', sub: '#C7C7FF', accent: '#000000', accent2: '#FFFFFF', ink: '#000000', dim: '#2323F0', ghostA: '#000000', ghostB: '#8C8CFF' },
      { bg: '#000000', fg: '#FFFFFF', sub: '#9A9AFF', accent: '#1B1BE8', accent2: '#FFFFFF', ink: '#1B1BE8', dim: '#0A0A30', ghostA: '#1B1BE8', ghostB: '#FFFFFF' },
      { bg: '#FFFFFF', fg: '#1B1BE8', sub: '#5A5AF0', accent: '#000000', accent2: '#1B1BE8', ink: '#1B1BE8', dim: '#EDEDFF', ghostA: '#000000', ghostB: '#8C8CFF' },
    ],
    fonts: { display: ['dela', 'gothic_black'], serif: ['mincho_bold'], body: ['gothic_bold'], mono: ['mono', 'dot'] },
    texture: { grain: 0.4, paper: 0, scan: 0 }, ghost: 0.6,
    bias: { layout: { diag: 2.2, labels: 1.4, huge: 1.4, condensed: 1.2 }, enter: { wipe: 1.6, slice: 1.6, stretch: 1.3 }, exit: { wipe: 1.6, slice: 1.4, glitch: 1.2 } },
    decor: { shapes: 1.4, stripes: 1, slash: 1, grid: 0.6 }, hud: false,
  },
  rouge: {
    name: 'ルージュ・グラデ', desc: '明るいグレー地・赤のグラデーション・カプセル',
    schemes: [
      { bg: '#E4E2E0', fg: '#141414', sub: '#6B6866', accent: '#D40F1C', accent2: '#141414', ink: '#141414', dim: '#D8D6D4', ghostA: '#D40F1C', ghostB: '#6B6866', grad: ['#E3141F', '#4A0005'] },
      { bg: '#140405', fg: '#FFFFFF', sub: '#C98A8E', accent: '#E3141F', accent2: '#FFFFFF', ink: '#E3141F', dim: '#220A0C', ghostA: '#E3141F', ghostB: '#FFFFFF', grad: ['#FF4A52', '#6A0008'] },
    ],
    fonts: { display: ['gothic_black', 'dela'], serif: ['mincho_black'], body: ['gothic_med'], mono: ['mono'] },
    texture: { grain: 0.4, paper: 0, scan: 0 }, ghost: 0.4,
    bias: { layout: { huge: 2.2, pill: 2, mixed: 1.4, labels: 1.2, center: 1.2 }, enter: { zoom: 1.6, wipe: 1.4, pop: 1.2 }, exit: { shrink: 1.6, wipe: 1.2 } },
    decor: { hud: 0.8, leaders: 0.8, stripes: 0.6 }, hud: true, useGrad: true,
  },
  mono: {
    name: 'モノ・RGB', desc: '灰色の空間・白い明朝・強いRGB分離・座標の円',
    schemes: [
      { bg: '#3B3D41', fg: '#FFFFFF', sub: '#B9BBBF', accent: '#FFFFFF', accent2: '#FFE34D', ink: '#1A1B1D', dim: '#45474C', ghostA: '#FF2A2A', ghostB: '#2AA8FF' },
      { bg: '#141517', fg: '#FFFFFF', sub: '#9EA0A4', accent: '#FFE34D', accent2: '#FFFFFF', ink: '#FFFFFF', dim: '#1E1F22', ghostA: '#FF2A2A', ghostB: '#2AFF7A' },
    ],
    fonts: { display: ['mincho_black', 'mincho_bold'], serif: ['mincho_bold'], body: ['mincho'], mono: ['mono'] },
    texture: { grain: 0.9, paper: 0, scan: 0.3 }, ghost: 1.3,
    bias: { layout: { circle: 1.8, ring: 1.6, pill: 1.4, tile: 1.4, vcols: 1.3 }, enter: { assemble: 1.4, blur: 1.4, zoom: 1.3 }, exit: { explode: 1.4, glitch: 1.4, blur: 1.2 } },
    decor: { rings: 1.4, hud: 0.6, dots: 1 }, hud: false,
  },
};
J.STYLE_ORDER = ['noir', 'crimson', 'caution', 'magenta', 'paper', 'hud', 'mint', 'specimen', 'transit', 'blueprint', 'rouge', 'mono'];

/* resolve style + user colour/font overrides into an effective style */
J.resolveStyle = (project) => {
  const base = J.STYLES[project.style] || J.STYLES.noir;
  const st = JSON.parse(JSON.stringify(base));
  const ov = project.colors || {};
  // base colours (background / text) replace the main scheme only
  if (ov.enabled) st.schemes[0] = Object.assign({}, st.schemes[0], pickDefined(ov, ['bg', 'fg', 'sub']));
  // accent + chromatic ghost colours apply to every scheme; accent is re-lit per background for contrast
  if (ov.accentOn) {
    st.schemes = st.schemes.map(s => {
      const o = Object.assign({}, s);
      if (ov.accent) { o.accent = J.fitContrast(ov.accent, s.bg, 2.4); if (s.ink === s.accent) o.ink = o.accent; }
      // ghosts only need to stay visible against this scheme's background
      if (ov.ghostA) o.ghostA = J.fitContrast(ov.ghostA, s.bg, 1.35);
      if (ov.ghostB) o.ghostB = J.fitContrast(ov.ghostB, s.bg, 1.35);
      if (ov.accent && s.grad) o.grad = [J.fitContrast(ov.accent, s.bg, 2.4), J.mix(ov.accent, '#000000', 0.7)];
      return o;
    });
  }
  const fo = project.fonts || {};
  for (const role of ['display', 'serif', 'body']) if (fo[role] && J.FONTS[fo[role]]) st.fonts[role] = [fo[role]];
  if (J.keyMode(project)) keyStyle(st);
  return st;
};
/* ---- 合成用の背景（グリーンバック / ブラックバック） ----
   Every scheme becomes white-on-black (so every part behaves as on a dark background), textures go away,
   and the renderer turns the finished frame monochrome and — for green — screens it onto pure green.
   Black stays the "empty" colour, so a keyer (green) or a screen / luma blend (black) gives the same result. */
J.KEY_BG = { green: '#00FF00', black: '#000000' };
J.keyMode = project => (project && J.KEY_BG[project.keyBg] ? project.keyBg : null);
function keyStyle(st) {
  st.schemes = st.schemes.map(s => {
    const o = { bg: '#000000', fg: '#FFFFFF', sub: '#D2D2D2', accent: '#FFFFFF', accent2: '#BDBDBD', ink: '#FFFFFF', dim: '#1E1E1E', ghostA: '#9A9A9A', ghostB: '#5E5E5E' };
    if (s.grad) o.grad = ['#FFFFFF', '#A8A8A8'];
    return o;
  });
  st.texture = { grain: 0, paper: 0, scan: 0 };
  st.key = true;
}
function pickDefined(o, keys) { const r = {}; for (const k of keys) if (o[k]) r[k] = o[k]; return r; }
})();


// Upstream src/05_anim.js
/* ============================================================
   JIZURA — motion recipes: entrances / holds / exits
   Each recipe mutates a text item: it.size/sx/alpha/blur/clip/bands,
   and pushes per-glyph (charFns) or per-piece (pieceFns) functions.
   ============================================================ */
(() => {
'use strict';
const E = J.E;


/* bands helper: horizontal slices covering the item's vertical extent */
J.itemBands = (env, it, n, dxFn) => {
  const m = it._m || (it._m = J.measure(it));
  const h = Math.max(m.h, it.size) * 1.25 + 20, y0 = it.y - h / 2;
  const cuts = [0];
  for (let i = 1; i < n; i++) cuts.push(J.r(it.seed | 0, n, i, 3));
  cuts.push(1); cuts.sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < cuts.length - 1; i++) out.push([y0 + cuts[i] * h, y0 + cuts[i + 1] * h, dxFn(i, cuts.length - 1)]);
  return out;
};

/* vertical slices covering the item's horizontal extent: [[x0, x1, dy], ...] */
J.itemVBands = (env, it, n, dyFn) => {
  const m = it._m || (it._m = J.measure(it));
  const w = Math.max(m.w, it.size) * 1.1 + 20;
  const x0 = it.align === 'left' ? it.x - 10 : it.align === 'right' ? it.x - w + 10 : it.x - w / 2;
  const out = [];
  for (let i = 0; i < n; i++) out.push([x0 + i * w / n, x0 + (i + 1) * w / n + 0.5, dyFn(i, n)]);
  return out;
};
/* the item's bounding box in design space (before rotation) */
J.itemBox = (it) => {
  const m = it._m || (it._m = J.measure(it));
  const x0 = it.vertical ? it.x - m.w / 2 : it.align === 'left' ? it.x : it.align === 'right' ? it.x - m.w : it.x - m.w / 2;
  const y0 = it.vertical && it.align === 'left' ? it.y : it.y - m.h / 2;
  return { x0, y0, x1: x0 + m.w, y1: y0 + m.h, w: m.w, h: m.h, cx: x0 + m.w / 2, cy: y0 + m.h / 2 };
};

/* ---------------- ENTRANCES ---------------- */
J.ENTER = {
  cut: { name: 'カット', apply() {} },

  assemble: {
    name: '分解→集合', pieces: true,
    apply(env, it, p, ctx) {
      const dur = ctx.inDur, lt = env.lt - (it.delay || 0);
      const spread = it.size * 3.2 * (0.6 + env.fx.motion * 0.7), seed = it.seed | 0;
      it.pieceFns.push((ci, pj, pc, ox, oy) => {
        const d = J.r(seed, ci, pj, 1) * dur * 0.45;
        const x = (lt - d) / (dur * 0.62);
        if (x < 0) return null;
        const e = E.outExpo(x), k = 1 - e;
        if (k <= 0.0005) return J.PID;
        const ang = J.r(seed, ci, pj, 2) * J.TAU;
        const dist = spread * (0.35 + 0.65 * J.r(seed, ci, pj, 3));
        const sp = (e - E.outExpo(x - 1 / (env.fps * dur * 0.62))) * dist;
        return J.PT(Math.cos(ang) * dist * k, Math.sin(ang) * dist * k, J.rs(seed, ci, pj, 4) * 190 * k,
          1 + (J.lerp(0.4, 2.1, J.r(seed, ci, pj, 5)) - 1) * k, 1 + Math.min(2.0, sp * 0.02), ang / J.DEG, 1);
      });
    },
  },

  slice: {
    name: 'スライス',
    apply(env, it, p) {
      const W = env.W;
      it.bands = J.itemBands(env, it, 7, (i) => (1 - E.outExpo(p * 1.2 - 0.05 * i)) * (i % 2 ? 1 : -1) * W * 0.9);
    },
  },

  type: {
    name: 'タイプ', cursor: true,
    apply(env, it, p, ctx) {
      const n = (it._m || (it._m = J.measure(it))).lay.N;
      const k = Math.floor(p * (n + 0.999));
      it.charFns.push((i) => (i >= k ? { hide: true } : null));
      it.cursorAt = p < 1 ? k : -1;
    },
  },

  pop: {
    name: 'ポップ',
    apply(env, it, p) {
      const seed = it.seed | 0;
      it.charFns.push((i, g, n) => {
        const d = n > 1 ? (i / (n - 1)) * 0.45 : 0;
        const q = J.clamp((p - d) / 0.55);
        if (q <= 0) return { hide: true };
        return { s: E.outBack(q, 2.6), rot: (1 - E.outCubic(q)) * J.rs(seed, i, 9) * 28 };
      });
    },
  },

  drop: {
    name: '落下',
    apply(env, it, p) {
      const size = it.size, seed = it.seed | 0;
      it.charFns.push((i, g, n) => {
        const d = n > 1 ? (J.r(seed, i, 4) * 0.5) : 0;
        const q = J.clamp((p - d) / 0.5);
        if (q <= 0) return { hide: true };
        const b = bounce(q);
        return { dy: -(1 - b) * size * 2.4, sy: 1 + (1 - q) * 0.5, sx: 1 - (1 - q) * 0.2 };
      });
    },
  },

  stretch: {
    name: '伸縮',
    apply(env, it, p) {
      const e = E.outExpo(p);
      it.sx = (it.sx || 1) * J.lerp(4.2, 1, e);
      it.streak = { n: 4, dx: it.size * 0.55 * (1 - e), a: 0.3 * (1 - e) };
    },
  },

  wipe: {
    name: 'ワイプ', bar: true,
    apply(env, it, p) {
      const e = E.inOutExpo(p);
      const m = it._m || (it._m = J.measure(it));
      const x0 = it.x - m.w / 2 - it.size * 0.2, x1 = it.x + m.w / 2 + it.size * 0.2;
      const dir = (it.seed | 0) % 2 ? 1 : -1;
      const edge = dir > 0 ? J.lerp(x0, x1, e) : J.lerp(x1, x0, e);
      it.clip = dir > 0 ? [x0 - 4000, edge] : [edge, x1 + 4000];
      it.wipeBar = p < 1 ? { x: edge, h: m.h * 1.3 + it.size * 0.2 } : null;
    },
  },

  blur: {
    name: 'ブラー',
    apply(env, it, p) {
      const e = E.outCubic(p);
      it.blur = (it.blur || 0) + (1 - e) * 26;
      it.alpha = (it.alpha ?? 1) * Math.pow(e, 0.7);
      it.size *= 1 + 0.18 * (1 - e);
      it.spacing = (1 - e);
      const tr = it.track || 0; it.track = tr + (1 - e) * 0.5;
    },
  },

  spin: {
    name: '回転',
    apply(env, it, p) {
      const seed = it.seed | 0;
      it.charFns.push((i, g, n) => {
        const d = n > 1 ? (i / (n - 1)) * 0.4 : 0;
        const q = J.clamp((p - d) / 0.6);
        if (q <= 0) return { hide: true };
        const e = E.outExpo(q);
        return { rot: (1 - e) * (J.r(seed, i) > 0.5 ? 1 : -1) * 200, s: J.lerp(0.15, 1, e), a: Math.min(1, q * 3) };
      });
    },
  },

  flicker: {
    name: '点滅',
    apply(env, it, p) {
      const seed = it.seed | 0, step = env.step;
      it.charFns.push((i) => (p >= 1 ? null : (J.r(seed, step, i) < p * 1.25 ? null : { hide: true })));
    },
  },

  scramble: {
    name: 'スクランブル',
    apply(env, it, p) {
      const seed = it.seed | 0, step = env.step;
      it.charFns.push((i, g, n) => {
        const settle = 0.25 + 0.75 * (n > 1 ? i / (n - 1) : 1);
        if (p >= settle) return null;
        if (p < settle * 0.25 && J.r(seed, i, step, 2) < 0.5) return { hide: true };
        const ch = J.pool('scramble')[Math.floor(J.r(seed, i, step) * J.pool('scramble').length)];
        return { ch, a: 0.85 };
      });
    },
  },

  zoom: {
    name: 'ズーム',
    apply(env, it, p) {
      const e = E.outExpo(p);
      it.size *= J.lerp(1.7, 1, e);
      it.blur = (it.blur || 0) + (1 - e) * 14;
      it.alpha = (it.alpha ?? 1) * Math.min(1, p * 4);
    },
  },
};
function bounce(x) {
  const n1 = 7.5625, d1 = 2.75;
  if (x < 1 / d1) return n1 * x * x;
  if (x < 2 / d1) return n1 * (x -= 1.5 / d1) * x + 0.75;
  if (x < 2.5 / d1) return n1 * (x -= 2.25 / d1) * x + 0.9375;
  return n1 * (x -= 2.625 / d1) * x + 0.984375;
}

/* ---------------- HOLDS (whole cut; amplitude eased in) ---------------- */
J.HOLD = {
  still: { name: '静止', apply() {} },
  jitter: {
    name: 'ジッター',
    apply(env, it, amt) {
      const seed = it.seed | 0, step = env.step, a = it.size * 0.025 * amt * env.fx.motion;
      if (a < 0.2) return;
      it.charFns.push((i) => ({ dx: J.rs(seed, step, i, 1) * a, dy: J.rs(seed, step, i, 2) * a, rot: J.rs(seed, step, i, 3) * 4 * amt }));
    },
  },
  drift: {
    name: 'ドリフト',
    apply(env, it, amt, ctx) {
      const u = env.lt / Math.max(0.3, ctx.dur);
      const dir = (it.seed | 0) % 2 ? 1 : -1;
      it.x += dir * (u - 0.5) * env.W * 0.035 * env.fx.motion;
      it.size *= 1 + 0.05 * u * env.fx.motion;
    },
  },
  breathe: {
    name: '呼吸',
    apply(env, it, amt) {
      it.size *= 1 + 0.035 * Math.sin(env.lt * J.TAU * 0.9) * amt;
      it.track = (it.track || 0) + 0.03 * Math.sin(env.lt * J.TAU * 0.6) * amt;
    },
  },
  wave: {
    name: 'ウェーブ',
    apply(env, it, amt) {
      const size = it.size, t = env.lt;
      it.charFns.push((i) => ({ dy: Math.sin(t * 7 + i * 0.75) * size * 0.07 * amt, rot: Math.cos(t * 7 + i * 0.75) * 5 * amt }));
    },
  },
  glitchtick: {
    name: 'グリッチ',
    apply(env, it, amt) {
      const seed = it.seed | 0, step = env.step;
      if (J.r(seed, step, 77) < 0.22 * env.fx.glitch * amt + 0.02) {
        it.bands = J.itemBands(env, it, 6, (i) => (J.r(seed, step, i, 5) < 0.6 ? J.rs(seed, step, i, 6) * it.size * 0.35 : 0));
      }
    },
  },
};

/* ---------------- EXITS ---------------- */
J.EXIT = {
  cut: { name: 'カット', apply() {} },

  explode: {
    name: '爆散', pieces: true, shatter: true,
    apply(env, it, p, ctx) {
      const seed = it.seed | 0, dur = ctx.outDur, lt = env.lt - (ctx.dur - ctx.outDur);
      const spread = Math.max(env.W, env.H) * 0.9 * (0.5 + env.fx.motion * 0.6);
      it.shatter = true;
      it.pieceFns.push((ci, pj, pc, ox, oy) => {
        const d = J.r(seed, ci, pj, 11) * dur * 0.3;
        const x = (lt - d) / (dur * 0.7);
        if (x <= 0) return J.PID;
        if (x >= 1) return null;
        const e = E.inCubic(x);
        const ang = Math.atan2(oy + 0.01, ox + 0.01) + J.rs(seed, ci, pj, 12) * 1.1;
        const dist = spread * (0.35 + 0.65 * J.r(seed, ci, pj, 13));
        const sp = (e - E.inCubic(x - 1 / (env.fps * dur * 0.7))) * dist;
        return J.PT(Math.cos(ang) * dist * e, Math.sin(ang) * dist * e, J.rs(seed, ci, pj, 14) * 260 * e, 1 + J.rs(seed, ci, pj, 15) * 0.6 * e,
          1 + Math.min(2.4, sp * 0.012), ang / J.DEG, 1 - x * x * x);
      });
    },
  },

  fall: {
    name: '崩落', pieces: true, shatter: true,
    apply(env, it, p, ctx) {
      const seed = it.seed | 0, lt = env.lt - (ctx.dur - ctx.outDur), g = env.H * 5.5;
      it.shatter = true;
      it.charFns.push(() => null);
      it.pieceFns.push((ci, pj) => {
        const x = lt - J.r(seed, ci, pj, 21) * ctx.outDur * 0.4;
        if (x <= 0) {
          const tr = lt > -0.25 ? 1 : 0;           // tremble just before collapse
          return tr ? J.PT(J.rs(seed, env.step, ci, pj) * it.size * 0.012, 0) : J.PID;
        }
        const v = g * x;
        return J.PT(J.rs(seed, ci, pj, 22) * env.W * 0.03 * x, 0.5 * g * x * x, J.rs(seed, ci, pj, 23) * 200 * x, 1, 1 + Math.min(2.2, v * 0.0012), 90, 1);
      });
    },
  },

  drift: {
    name: '霧散', pieces: true, shatter: true,
    apply(env, it, p, ctx) {
      const seed = it.seed | 0, dur = ctx.outDur, lt = env.lt - (ctx.dur - ctx.outDur), dist0 = it.size * 1.6;
      it.shatter = true;
      it.pieceFns.push((ci, pj) => {
        const x = (lt - J.r(seed, ci, pj, 31) * dur * 0.3) / (dur * 0.7);
        if (x <= 0) return J.PID;
        if (x >= 1) return null;
        const e = E.inQuad(x), ang = J.r(seed, ci, pj, 32) * J.TAU, dd = dist0 * (0.3 + 0.7 * J.r(seed, ci, pj, 33));
        return J.PT(Math.cos(ang) * dd * e, Math.sin(ang) * dd * e - it.size * 0.3 * e, J.rs(seed, ci, pj, 34) * 80 * e, 1 - 0.35 * e, 1 + e * 0.8, ang / J.DEG, 1 - e * e);
      });
    },
  },

  slice: {
    name: 'スライス退場',
    apply(env, it, p) {
      const e = E.inExpo(p);
      it.bands = J.itemBands(env, it, 7, (i) => e * (i % 2 ? -1 : 1) * env.W * 1.1 * (0.6 + 0.4 * J.r(it.seed | 0, i, 41)));
    },
  },

  wipe: {
    name: 'ワイプ退場', bar: true,
    apply(env, it, p) {
      const e = E.inOutExpo(p);
      const m = it._m || (it._m = J.measure(it));
      const x0 = it.x - m.w / 2 - it.size * 0.2, x1 = it.x + m.w / 2 + it.size * 0.2;
      const edge = J.lerp(x0, x1, e);
      it.clip = [edge, x1 + 4000];
      it.wipeBar = p > 0 && p < 1 ? { x: edge, h: m.h * 1.3 + it.size * 0.2 } : null;
    },
  },

  shrink: {
    name: '収縮',
    apply(env, it, p) {
      const e = E.inCubic(p);
      it.size *= 1 - e * 0.96;
      it.alpha = (it.alpha ?? 1) * (1 - e * e);
      it.track = (it.track || 0) - e * 0.2;
    },
  },

  blur: {
    name: 'ブラー退場',
    apply(env, it, p) {
      const e = E.inQuad(p);
      it.blur = (it.blur || 0) + e * 30;
      it.alpha = (it.alpha ?? 1) * (1 - e);
      it.size *= 1 + e * 0.2;
    },
  },

  stretch: {
    name: '伸縮退場',
    apply(env, it, p) {
      const e = E.inExpo(p);
      it.sx = (it.sx || 1) * J.lerp(1, 6, e);
      it.sy = (it.sy || 1) * J.lerp(1, 0.6, e);
      it.alpha = (it.alpha ?? 1) * (1 - J.smooth(0.7, 1, p));
      it.streak = { n: 3, dx: -it.size * 0.8 * e, a: 0.25 * e };
    },
  },

  scatter: {
    name: '飛散',
    apply(env, it, p) {
      const seed = it.seed | 0, W = env.W;
      it.charFns.push((i, g, n) => {
        const d = J.r(seed, i, 51) * 0.35;
        const q = J.clamp((p - d) / 0.65); if (q <= 0) return null;
        const e = E.inCubic(q), ang = J.r(seed, i, 52) * J.TAU;
        return { dx: Math.cos(ang) * W * 0.7 * e, dy: Math.sin(ang) * W * 0.45 * e, rot: J.rs(seed, i, 53) * 540 * e, s: 1 + e * 0.8, a: 1 - q * q };
      });
    },
  },

  glitch: {
    name: 'グリッチ退場',
    apply(env, it, p) {
      const seed = it.seed | 0, step = env.step;
      const amp = it.size * (0.3 + p * 2.2);
      it.bands = J.itemBands(env, it, 9, (i) => (J.r(seed, step, i, 61) < 0.75 ? J.rs(seed, step, i, 62) * amp : 0));
      if (p > 0.55) it.alpha = (it.alpha ?? 1) * (J.r(seed, step, 63) < 0.5 ? 0.15 : 1) * (1 - J.smooth(0.8, 1, p));
    },
  },
};

/* combine glyph / piece functions */
J.combineChar = (fns) => {
  if (!fns.length) return null;
  if (fns.length === 1) return fns[0];
  return (i, g, n) => {
    let o = null;
    for (const f of fns) {
      const r = f(i, g, n); if (!r) continue;
      if (r.hide) return r;
      if (!o) o = { dx: 0, dy: 0, rot: 0, s: 1, a: 1 };
      o.dx += r.dx || 0; o.dy += r.dy || 0; o.rot += r.rot || 0;
      if (r.s != null) o.s *= r.s; if (r.a != null) o.a *= r.a;
      if (r.sx) o.sx = (o.sx || 1) * r.sx; if (r.sy) o.sy = (o.sy || 1) * r.sy;
      if (r.ch) o.ch = r.ch; if (r.color) o.color = r.color;
      if (r.skew) o.skew = (o.skew || 0) + r.skew;
      if (r.blur) o.blur = (o.blur || 0) + r.blur;
      if (r.outline) o.outline = true;
      if (r.clipX) o.clipX = o.clipX ? [Math.max(o.clipX[0], r.clipX[0]), Math.min(o.clipX[1], r.clipX[1])] : r.clipX;
      if (r.clipY) o.clipY = o.clipY ? [Math.max(o.clipY[0], r.clipY[0]), Math.min(o.clipY[1], r.clipY[1])] : r.clipY;
    }
    return o;
  };
};
J.combinePiece = (fns) => {
  if (!fns.length) return null;
  if (fns.length === 1) return fns[0];
  return (ci, pj, pc, ox, oy, g) => {
    let o = null;
    for (const f of fns) {
      const r = f(ci, pj, pc, ox, oy, g);
      if (r === null) return null;
      if (r === J.PID) continue;
      if (!o) o = J.PT();
      o.dx += r.dx; o.dy += r.dy; o.rot += r.rot; o.s *= r.s; o.a *= r.a;
      if (r.st > o.st) { o.st = r.st; o.sdir = r.sdir; }
    }
    return o || J.PID;
  };
};
})();


// Upstream src/05b_registry.js
/* ============================================================
   JIZURA — registries for the newer expression groups + a single
   registration helper used by every expression pack (src/11p_*.js)

   group    registry      order array          picked per
   layout   J.LAYOUTS     J.LAYOUT_ORDER       cut
   enter    J.ENTER       J.ENTER_ORDER        cut
   hold     J.HOLD        J.HOLD_ORDER         cut
   exit     J.EXIT        J.EXIT_ORDER         cut
   decor    J.DECOR       J.DECOR_ORDER        cut (0..n)
   treat    J.TREAT       J.TREAT_ORDER        cut   text treatment (outline, extrude, marker…)
   bg       J.BG          J.BG_ORDER           line  full-screen background graphic
   cam      J.CAMERA      J.CAMERA_ORDER       cut   camera move over the cut
   fx       J.FXE         J.FXE_ORDER          event post-processing / transition effect
   trans    J.TRANS       J.TRANS_ORDER        cut   how this cut takes over from the previous one (both frames composited)

   Common optional fields on every entry:
     name  (Japanese label, required)   tags  (mood keys it suits: glitch calm pop graphic editorial emotional)
     w     (base pick weight, default 1)  pack (set by J.register)
   ============================================================ */
(() => {
'use strict';

J.TREAT = { none: { name: 'なし', apply() {} } };
J.TREAT_ORDER = ['none'];
J.BG = { none: { name: '無地', draw() {} } };
J.BG_ORDER = ['none'];
J.CAMERA = {
  push: { name: 'ゆっくり寄る', tags: ['calm', 'editorial', 'emotional', 'graphic', 'pop', 'glitch'], w: 5,
    get: (env) => ({ s: 1 + 0.03 * (env.fx.motion ?? 0.7) * J.clamp(env.lt / Math.max(0.3, env.cut.dur)) }) },
};
J.CAMERA_ORDER = ['push'];
// post / transition effects. Entries without draw() are handled by the renderer's built-in branch.
J.FXE = {
  slice:  { name: 'スライスグリッチ', builtin: true },
  block:  { name: 'ブロックグリッチ', builtin: true },
  invert: { name: '反転', builtin: true },
  flash:  { name: 'フラッシュ', builtin: true },
  zoom:   { name: 'ズームブラー', builtin: true },
  mosaic: { name: 'モザイク', builtin: true },
  shake:  { name: '揺れ', builtin: true },
  chroma: { name: '色ズレの跳ね', builtin: true },
};
J.FXE_ORDER = ['chroma', 'shake', 'slice', 'block', 'invert', 'flash', 'zoom', 'mosaic'];
// cut-to-cut transitions: draw(ctx, A, B, p, info) composites the previous cut (A) and this cut (B) in device pixels
J.TRANS = {};
J.TRANS_ORDER = [];

const GROUPS = {
  layout: ['LAYOUTS', 'LAYOUT_ORDER'], enter: ['ENTER', 'ENTER_ORDER'], hold: ['HOLD', 'HOLD_ORDER'], exit: ['EXIT', 'EXIT_ORDER'],
  decor: ['DECOR', 'DECOR_ORDER'], treat: ['TREAT', 'TREAT_ORDER'], bg: ['BG', 'BG_ORDER'], cam: ['CAMERA', 'CAMERA_ORDER'], fx: ['FXE', 'FXE_ORDER'], trans: ['TRANS', 'TRANS_ORDER'],
};
J.GROUP_KEYS = Object.keys(GROUPS);
J.registry = g => J[GROUPS[g][0]];
J.order = g => J[GROUPS[g][1]];

/* J.register('layout', 'myKey', { name: '…', … }, 'packName') */
J.register = (group, key, def, pack) => {
  const G = GROUPS[group];
  if (!G) throw new Error('unknown group ' + group);
  if (!def || !def.name) throw new Error(`${group}.${key}: name is required`);
  const reg = J[G[0]], order = J[G[1]];
  if (reg[key] && reg[key].pack !== pack) console.warn(`JIZURA: ${group}.${key} is being replaced`);
  def.pack = pack || def.pack || 'core';
  reg[key] = def;
  if (!def.special && !order.includes(key)) order.push(key);
  return def;
};
J.registerAll = (group, defs, pack) => { for (const k of Object.keys(defs)) J.register(group, k, defs[k], pack); };

/* items whose tags include a mood key (used by おまかせ) */
J.taggedWith = (group, mood) => J.order(group).filter(k => { const d = J.registry(group)[k]; return d && d.tags && d.tags.includes(mood); });
})();


// Upstream src/06_layouts.js
/* ============================================================
   JIZURA — layouts (how a chunk of lyric is composed on screen)
   plan(rng, cut, st)  -> params stored in the cut (also exported to AE)
   render(env)         -> draws; returns bbox of the main text for decor
   ============================================================ */
(() => {
'use strict';
const E = J.E;

/* ---------- main-item pipeline: enter / hold / exit + draw ---------- */
J.mainDraw = (env, it) => {
  const cut = env.cut;
  it.seed = it.seed != null ? it.seed : J.h(cut.seed, (it.mi | 0) + 1, 7);
  it.charFns = []; it.pieceFns = [];
  const stagger = cut.stagger || 0;
  it.delay = (it.mi | 0) * stagger;
  const ctx = { dur: cut.dur, inDur: cut.inDur, outDur: cut.outDur };
  const lt0 = env.lt;
  const ltI = lt0 - it.delay;
  const pIn = J.clamp(ltI / Math.max(0.01, cut.inDur));
  const outStart = cut.dur - cut.outDur;
  const pOut = cut.outDur > 0 ? J.clamp((lt0 - outStart) / cut.outDur) : 0;
  const en = J.ENTER[it.enter || cut.enter] || J.ENTER.cut;
  const ex = J.EXIT[it.exit || cut.exit] || J.EXIT.cut;
  const ho = J.HOLD[it.hold || cut.hold] || J.HOLD.still;
  // text treatment (outline, extrude, marker...) — layouts that paint their own plates opt out with it.plain
  if (cut.treat && !it.plain && J.TREAT && J.TREAT[cut.treat]) { try { J.TREAT[cut.treat].apply(env, it, cut.treatP || {}); } catch (e) { console.warn('treat', cut.treat, e); } }
  if (ltI < 0 && en === J.ENTER.cut) return null;
  if (en !== J.ENTER.cut && (pIn < 1 || en.pieces)) { env.lt = ltI; en.apply(env, it, pIn, ctx); env.lt = lt0; }
  if (ltI < 0 && !en.pieces) return null;
  const amt = J.clamp((ltI - cut.inDur * 0.85) / 0.25) * (1 - pOut);
  if (amt > 0 && !it.noHold) ho.apply(env, it, amt, ctx);
  if (pOut > 0 && ex !== J.EXIT.cut) ex.apply(env, it, pOut, ctx);
  it.charFn = J.combineChar(it.charFns);
  it.pieceFn = J.combinePiece(it.pieceFns);
  return J.drawFx(env, it);
};

/* draw an item honouring bands / clip / streak / echo / wipe-bar / cursor / treatment hooks */
J.drawFx = (env, it) => {
  const ctx = env.ctx;
  let bb = null;
  const draw = () => {
    if (it.streak && it.streak.a > 0.01) {
      for (let k = it.streak.n; k >= 1; k--) {
        const c = Object.assign({}, it, { x: it.x + it.streak.dx * k, y: it.y + (it.streak.dy || 0) * k, alpha: (it.alpha ?? 1) * it.streak.a * (1 - k / (it.streak.n + 1)), pieceFn: null, streak: null, echo: null, pre: null, post: null, shadow: null, extrude: null });
        J.drawItem(env, c);
      }
    }
    if (it.echo && it.echo.n > 0) {            // stepped copies behind the item (outline or tinted)
      const E0 = it.echo;
      for (let k = E0.n; k >= 1; k--) {
        const c = Object.assign({}, it, { x: it.x + (E0.dx || 0) * k, y: it.y + (E0.dy || 0) * k, size: it.size * Math.pow(E0.scale || 1, k), rot: (it.rot || 0) + (E0.rot || 0) * k,
          alpha: (it.alpha ?? 1) * (E0.a ?? 0.5) * Math.pow(E0.decay ?? 0.7, k - 1), pieceFn: null, streak: null, echo: null, pre: null, post: null, shadow: null, extrude: null, pattern: null, gradient: null,
          color: E0.color || it.color, _lay: null, _m: null });
        if (E0.outline) Object.assign(c, { fill: false, stroke: Math.max(1, it.size * 0.012), strokeColor: E0.color || it.color });
        J.drawItem(env, c);
      }
    }
    const r = J.drawItem(env, it); if (r) bb = r;
  };
  if (it.pre) { try { it.pre(env, it); } catch (e) { console.warn(e); } }
  if (it.clip) { ctx.save(); ctx.beginPath(); ctx.rect(it.clip[0], -env.H, it.clip[1] - it.clip[0], env.H * 3); ctx.clip(); }
  if (it.clipY) { ctx.save(); ctx.beginPath(); ctx.rect(-env.W, it.clipY[0], env.W * 3, it.clipY[1] - it.clipY[0]); ctx.clip(); }
  if (it.clipFn) { ctx.save(); ctx.beginPath(); it.clipFn(ctx, env, it); ctx.clip(); }
  if (it.vbands) {
    for (const [x0, x1, dy] of it.vbands) {
      ctx.save(); ctx.beginPath(); ctx.rect(x0, -env.H * 2, x1 - x0, env.H * 5); ctx.clip(); ctx.translate(0, dy); draw(); ctx.restore();
    }
  } else if (it.bands) {
    for (const [y0, y1, dx] of it.bands) {
      ctx.save(); ctx.beginPath(); ctx.rect(-env.W * 2, y0, env.W * 5, y1 - y0); ctx.clip(); ctx.translate(dx, 0); draw(); ctx.restore();
    }
    // outside of the band range
    const lo = it.bands[0][0], hi = it.bands[it.bands.length - 1][1];
    ctx.save(); ctx.beginPath(); ctx.rect(-env.W * 2, -env.H * 3, env.W * 5, lo + env.H * 3); ctx.rect(-env.W * 2, hi, env.W * 5, env.H * 4); ctx.clip(); draw(); ctx.restore();
  } else draw();
  if (it.clipFn) ctx.restore();
  if (it.clipY) ctx.restore();
  if (it.clip) ctx.restore();
  if (it.post) { try { it.post(env, it, bb); } catch (e) { console.warn(e); } }
  if (it.wipeBar) env.rect(it.wipeBar.x - Math.max(4, it.size * 0.035), it.y - it.wipeBar.h / 2, Math.max(8, it.size * 0.07), it.wipeBar.h, env.sc.accent, 1, false);
  if (it.cursorAt != null && it.cursorAt >= 0) {
    const m = it._m || J.measure(it);
    const blink = it.cursorAt >= m.lay.N ? (env.step % 2 === 0) : true;
    if (blink) {
      let x;
      if (bb && bb.boxes.length) { const last = bb.boxes[bb.boxes.length - 1]; x = it.x + last.x + last.w / 2 + it.size * 0.08; }
      else x = it.align === 'left' ? it.x : it.x - m.w / 2;
      env.rect(x, it.y - it.size * 0.45, it.size * 0.5, it.size * 0.9, env.sc.accent, 1);
    }
  }
  return bb;
};

const unionBB = (a, b) => !a ? b : !b ? a : { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1), boxes: [], cx: (Math.min(a.x0, b.x0) + Math.max(a.x1, b.x1)) / 2, cy: (Math.min(a.y0, b.y0) + Math.max(a.y1, b.y1)) / 2 };

/* Latin text: break between words only, into as few balanced lines as fit (never more lines than words) */
const splitWords = (text, maxPer) => {
  const ws = text.trim().split(/\s+/), n = ws.length;
  const total = ws.reduce((a, w) => a + [...w].length, 0) + n - 1;
  const nLines = Math.min(n, Math.ceil(total / maxPer));
  if (nLines <= 1) return ws.join(' ');
  // balanced split: minimise the squared difference to the ideal line length
  const len = (a, b) => ws.slice(a, b).reduce((s, w) => s + [...w].length, 0) + (b - a - 1);
  const ideal = total / nLines, memo = new Map();
  const best = (i, l) => {
    if (l === 1) { const d = len(i, n) - ideal; return { c: d * d, cuts: [] }; }
    const key = i + "," + l; if (memo.has(key)) return memo.get(key);
    let r = { c: Infinity, cuts: [] };
    for (let j = i + 1; j <= n - l + 1; j++) { const d = len(i, j) - ideal, sub = best(j, l - 1), c = d * d + sub.c; if (c < r.c) r = { c, cuts: [j, ...sub.cuts] }; }
    memo.set(key, r); return r;
  };
  const cuts = [0, ...best(0, nLines).cuts, n], out = [];
  for (let k = 0; k < cuts.length - 1; k++) out.push(ws.slice(cuts[k], cuts[k + 1]).join(' '));
  return out.join('\n');
};
/* split long text into balanced lines, preferring script boundaries */
J.splitLines = (text, maxPer) => {
  const arr = [...text];
  if (arr.length <= maxPer) return text;
  if (J.isLatinText && J.isLatinText(text)) return /\s/.test(text.trim()) ? splitWords(text, maxPer) : text;   // one word stays whole
  const nLines = Math.ceil(arr.length / maxPer);
  const per = arr.length / nLines;
  const out = []; let start = 0;
  for (let l = 1; l < nLines; l++) {
    let target = Math.round(per * l), best = target, bestScore = -1;
    for (let k = Math.max(start + 1, target - 3); k <= Math.min(arr.length - 1, target + 3); k++) {
      const a = arr[k - 1], b = arr[k];
      let s = 3 - Math.abs(k - target);
      if (J.isHira(a) && !J.isHira(b)) s += 3;
      if (J.isPunct(a) || a === ' ' || a === '　') s += 5;
      if (J.isSmallKana(b) || 'ーっ、。'.includes(b)) s -= 6;
      if (s > bestScore) { bestScore = s; best = k; }
    }
    out.push(arr.slice(start, best).join('').trim()); start = best;
  }
  out.push(arr.slice(start).join('').trim());
  return out.join('\n');
};

const glyphCount = t => [...t.replace(/\s/g, '')].length;
const fontsOf = (st, roles) => { const f = roles.flatMap(r => st.fonts[r] || []).filter(k => J.FONTS[k]); return f.length ? f : (st.fonts.display || ['gothic_black']); };
J.glyphCount = glyphCount; J.fontsOf = fontsOf; J.unionBB = unionBB;
J.centerBB = (env, bb) => bb || { x0: env.W * 0.35, x1: env.W * 0.65, y0: env.H * 0.4, y1: env.H * 0.6, cx: env.W / 2, cy: env.H / 2, boxes: [] };

J.LAYOUTS = {
  /* ------------------------------------------------ */
  center: {
    name: '中央', fits: n => true,
    plan: (rng, cut, st) => ({ font: rng.pick(fontsOf(st, rng.chance(0.7) ? ['display'] : ['serif'])), sx: rng.pick([1, 1, 1, 1.25, 1.45, 0.78]), track: rng.range(0.02, 0.14), sub: rng.chance(0.45), under: rng.chance(0.3), accent: rng.chance(0.18), ox: rng.range(-0.05, 0.05), oy: rng.range(-0.06, 0.06) }),
    render(env) {
      const { W, H, sc } = env, P = env.cut.params, text = J.splitLines(env.cut.text, W < H ? 5 : 11);
      const size = Math.min(J.fitSize(text, P.font, W * 0.84, H * 0.5, { sx: P.sx, track: P.track, lead: 1.2 }), H * 0.33);
      const bb = J.mainDraw(env, { text, font: P.font, size, x: W / 2 + P.ox * W, y: H / 2 + P.oy * H, sx: P.sx, track: P.track, lead: 1.2, color: P.accent ? sc.accent : sc.fg });
      if (bb && P.sub && env.cut.lineText !== env.cut.text) {
        env.draw({ text: env.cut.lineText, font: env.st.fonts.body[0], size: J.clamp(H * 0.026, 16, 34), x: W / 2 + P.ox * W, y: bb.y1 + H * 0.07, track: 0.22, color: sc.sub, alpha: E.outCubic(env.pIn), ghost: false });
      }
      if (bb && P.under) {
        const e = E.outExpo(env.pIn * 1.2 - 0.2), o = E.inCubic(env.pOut);
        if (e > 0 && o < 1) env.line([[J.lerp(bb.x0, bb.x1, o), bb.y1 + size * 0.14], [J.lerp(bb.x0, bb.x1, e), bb.y1 + size * 0.14]], sc.accent, Math.max(2, size * 0.03), 1);
      }
      return bb;
    },
  },

  /* ------------------------------------------------ */
  mixed: {
    name: '大小ミックス', fits: n => n >= 2 && n <= 16,
    plan: (rng, cut, st) => ({ fontBig: rng.pick(fontsOf(st, ['display', 'serif'])), fontSmall: rng.pick(fontsOf(st, ['serif', 'body'])), mode: rng.pick(['line', 'stair', 'line', 'wave']), rotAmp: rng.range(2, 10), smallK: rng.range(0.42, 0.6), accentIdx: rng.int(0, 20) }),
    render(env) {
      const { W, H, sc } = env, P = env.cut.params;
      const chars = [...env.cut.text.replace(/\s+/g, '')];
      const n = chars.length;
      const rows = n > 9 ? 2 : 1;
      const perRow = Math.ceil(n / rows);
      const items = chars.map((ch, i) => {
        let k = J.isKanji(ch) ? 1 : J.isKata(ch) ? 0.88 : J.isLatin(ch) ? 0.8 : J.isPunct(ch) ? 0.42 : P.smallK + J.r(env.cut.seed, i, 3) * 0.14;
        if (J.isSmallKana(ch)) k *= 0.8;
        const font = (J.isKanji(ch) || J.isKata(ch)) ? P.fontBig : (J.r(env.cut.seed, i, 4) < 0.55 ? P.fontSmall : P.fontBig);
        return { ch, k, font, w: J.metrics.adv(font, ch) * k * 0.96 };
      });
      let bbAll = null;
      for (let r = 0; r < rows; r++) {
        const row = items.slice(r * perRow, (r + 1) * perRow);
        const sumW = row.reduce((s, c) => s + c.w, 0);
        const base = Math.min(W * 0.86 / sumW, H * (rows > 1 ? 0.3 : 0.4));
        let x = W / 2 - sumW * base / 2;
        const baseline = H / 2 + base * 0.38 + (r - (rows - 1) / 2) * base * 1.05;
        row.forEach((c, j) => {
          const i = r * perRow + j;
          const size = c.k * base;
          let y = baseline - size / 2 + J.rs(env.cut.seed, i, 5) * base * 0.06;
          if (P.mode === 'stair') y += (j - (row.length - 1) / 2) * base * 0.12;
          if (P.mode === 'wave') y += Math.sin(j * 1.1) * base * 0.1;
          const it = { text: c.ch, font: c.font, size, x: x + c.w * base / 2, y, rot: J.rs(env.cut.seed, i, 6) * P.rotAmp, color: (i === P.accentIdx % n && !J.isKanji(c.ch)) ? sc.accent : sc.fg, mi: i };
          bbAll = unionBB(bbAll, J.mainDraw(env, it));
          x += c.w * base;
        });
      }
      return bbAll;
    },
  },

  /* ------------------------------------------------ */
  vcols: {
    name: '縦書き', fits: n => n <= 18,
    plan: (rng, cut, st) => {
      const n = glyphCount(cut.text);
      const variant = n <= 5 ? rng.pick(['repeat', 'repeat', 'split']) : n <= 9 ? rng.pick(['split', 'repeat']) : 'split';
      return { variant, cols: n <= 4 ? rng.pick([3, 5, 5]) : 3, font: rng.pick(fontsOf(st, ['serif', 'serif', 'display'])), side: rng.pick(['same', 'outline', 'dim']), perCol: rng.int(3, 6) };
    },
    render(env) {
      const { W, H, sc } = env, P = env.cut.params, text = env.cut.text.replace(/\s+/g, '');
      const n = glyphCount(text);
      if (P.variant === 'repeat' && n <= 9) {
        const cols = P.cols;
        const size = Math.min(H * 0.8 / (n * 1.04), W * 0.86 / (cols * 1.75));
        let bb = null; const mid = (cols - 1) / 2;
        for (let i = 0; i < cols; i++) {
          const side = i !== Math.round(mid);
          const it = { text, font: P.font, size, x: W / 2 + (i - mid) * size * 1.75, y: H / 2, vertical: true, track: 0.04, color: sc.fg, mi: Math.abs(i - mid) * 2 };
          if (side && P.side === 'outline') { it.fill = false; it.stroke = Math.max(1.2, size * 0.012); }
          if (side && P.side === 'dim') it.alpha = 0.38;
          const r = J.mainDraw(env, it); if (!side) bb = r;
        }
        return bb;
      }
      const per = Math.max(2, Math.min(P.perCol + 1, Math.ceil(n / Math.ceil(n / 7))));
      const colsArr = []; const arr = [...text];
      for (let i = 0; i < arr.length; i += per) colsArr.push(arr.slice(i, i + per).join(''));
      const t2 = colsArr.join('\n');
      const size = Math.min(H * 0.78 / (per * 1.03), W * 0.8 / (colsArr.length * 1.4));
      const colH = per * size * 1.03;
      return J.mainDraw(env, { text: t2, font: P.font, size, x: W / 2, y: H / 2 - colH / 2, vertical: true, lead: 1.4, align: 'left', track: 0.03, color: sc.fg });
    },
  },

  /* ------------------------------------------------ */
  marquee: {
    name: '流れる帯', fits: n => n <= 12,
    plan: (rng, cut, st) => ({ rows: rng.pick([2, 4, 4, 2]), rowStyle: rng.pick(['outline', 'dim', 'box']), speed: rng.range(0.5, 1.2), font: rng.pick(fontsOf(st, ['display'])), sx: rng.pick([1.25, 1.45, 1.6]) }),
    render(env) {
      const { W, H, sc } = env, P = env.cut.params, text = env.cut.text;
      const size = Math.min(J.fitSize(text, P.font, W * 0.84, H * 0.3, { sx: P.sx, track: 0.05 }), H * 0.3);
      const rs = size * 0.42, lb = env.ltb;
      const unit = text + '　';
      const period = J.measure({ text: unit, font: P.font, size: rs, sx: P.sx, track: 0.05 }).w + rs * 0.05;
      const reps = Math.ceil((W * 2.4) / period) + 1;
      const ys = P.rows === 2 ? [-1, 1] : [-2, -1, 1, 2];
      ys.forEach((k, r) => {
        const y = H / 2 + Math.sign(k) * (size * 0.5 + rs * 0.95) + (Math.abs(k) - 1) * Math.sign(k) * rs * 1.25;
        const a = J.clamp((lb - Math.abs(k) * 0.05) / 0.12);
        if (a <= 0) return;
        const dir = r % 2 ? 1 : -1;
        const off = ((lb * P.speed * W * 0.22 * dir + r * period * 0.37) % period + period) % period - period / 2;
        const row = { text: unit.repeat(reps), font: P.font, size: rs, sx: P.sx, track: 0.05, x: W / 2 + off, y, ghost: false, alpha: a };
        if (P.rowStyle === 'outline') Object.assign(row, { fill: false, stroke: Math.max(1.2, rs * 0.02), strokeColor: sc.fg, alpha: a * 0.9 });
        else if (P.rowStyle === 'dim') Object.assign(row, { color: sc.sub, alpha: a * 0.35 });
        else { env.rect(-10, y - rs * 0.62, W + 20, rs * 1.24, sc.ink, a, false); Object.assign(row, { color: sc.bg }); }
        env.draw(row);
      });
      return J.mainDraw(env, { text, font: P.font, size, x: W / 2, y: H / 2, sx: P.sx, track: 0.05, color: sc.fg });
    },
  },

  /* ------------------------------------------------ */
  tile: {
    name: '敷き詰め', fits: n => n <= 12,
    plan: (rng, cut, st) => ({ unit: rng.pick(['chunk', 'line', 'chunk']), knock: rng.pick(['stroke', 'box']), flicker: rng.chance(0.6), font: rng.pick(fontsOf(st, ['display'])), tileFont: rng.pick(fontsOf(st, ['serif', 'body', 'display'])), rowsN: rng.pick([12, 14, 16, 18]) }),
    render(env) {
      const { W, H, sc } = env, P = env.cut.params, text = env.cut.text, lb = env.ltb;
      const unitText = (P.unit === 'line' ? env.cut.lineText : text) + '　';
      const rowH = H / P.rowsN, ts = rowH * 0.72;
      const period = J.measure({ text: unitText, font: P.tileFont, size: ts, track: 0.02 }).w;
      const reps = Math.ceil(W * 1.6 / period) + 2;
      for (let r = 0; r <= P.rowsN; r++) {
        const ap = J.r(env.cut.seed, r, 91) * env.cut.inDur * 1.6;
        if (lb < ap) continue;
        if (P.flicker && J.r(env.cut.seed, env.step, r, 92) < 0.16) continue;
        const dir = r % 2 ? 1 : -1;
        const off = (((r % 2) * period * 0.5 + lb * 26 * dir) % period + period) % period;
        env.draw({ text: unitText.repeat(reps), font: P.tileFont, size: ts, track: 0.02, align: 'left', x: -period + off - period * 0.5, y: (r + 0.5) * rowH, color: sc.sub, alpha: 0.42 * J.clamp((lb - ap) / 0.1), ghost: false });
      }
      const mt = W < H ? J.splitLines(text, 5) : text;
      const size = Math.min(J.fitSize(mt, P.font, W * 0.8, H * 0.34, { track: 0.04, lead: 1.15 }), H * 0.3);
      const it = { text: mt, font: P.font, size, x: W / 2, y: H / 2, track: 0.04, lead: 1.15, color: sc.fg };
      if (P.knock === 'box') {
        const m = J.measure(it); const e = E.outExpo(env.pIn * 1.4);
        env.rect(W / 2 - (m.w / 2 + size * 0.35) * e, H / 2 - m.h / 2 - size * 0.28, (m.w + size * 0.7) * e, m.h + size * 0.56, sc.bg, 1, false);
      } else {
        J.mainDraw(env, Object.assign({}, it, { fill: false, stroke: size * 0.16, strokeColor: sc.bg, ghost: false }));
      }
      return J.mainDraw(env, it);
    },
  },

  /* ------------------------------------------------ */
  scatter: {
    name: '散らし', fits: n => n >= 2 && n <= 14,
    plan: (rng, cut, st) => ({ font: rng.pick(fontsOf(st, ['display'])), fontB: rng.pick(fontsOf(st, ['serif', 'display'])), extras: rng.chance(0.65) }),
    render(env) {
      const { W, H, sc } = env, P = env.cut.params, s = env.cut.seed;
      const chars = [...env.cut.text.replace(/\s+/g, '')], n = chars.length;
      if (P.extras) {
        for (let k = 0; k < 9; k++) {
          const ap = J.r(s, k, 81) * env.cut.dur * 0.5;
          if (env.ltb < ap) continue;
          const top = J.r(s, k, 82) < 0.5;
          env.draw({ text: env.cut.text, font: env.st.fonts.body[0], size: J.rr(H * 0.022, H * 0.045, s, k, 83), x: J.rr(W * 0.08, W * 0.92, s, k, 84), y: top ? J.rr(H * 0.08, H * 0.26, s, k, 85) : J.rr(H * 0.74, H * 0.92, s, k, 85), rot: J.rs(s, k, 86) * 18, color: sc.sub, alpha: 0.75, ghost: false });
        }
      }
      const base = Math.min(H * 0.3, W * 0.9 / n * 1.15);
      let bb = null;
      chars.forEach((ch, i) => {
        const x = W * (0.1 + 0.8 * (i + 0.5) / n) + J.rs(s, i, 71) * W * 0.035;
        const y = H / 2 + J.rs(s, i, 72) * H * 0.18;
        const k = 0.62 + J.r(s, i, 73) * 0.85 * (J.isKanji(ch) ? 1 : 0.7);
        bb = unionBB(bb, J.mainDraw(env, { text: ch, font: i % 3 === 1 ? P.fontB : P.font, size: base * k, x, y, rot: J.rs(s, i, 74) * 24, color: J.r(s, i, 75) < 0.15 ? sc.accent : sc.fg, mi: i }));
      });
      return bb;
    },
  },

  /* ------------------------------------------------ */
  ring: {
    name: '円環', fits: n => n >= 2 && n <= 16,
    plan: (rng, cut, st) => ({ orient: rng.pick(['tangent', 'tangent', 'upright']), center: rng.pick(['word', 'disc', 'word', 'none']), speed: rng.range(4, 12) * rng.pick([1, -1]), R: rng.range(0.28, 0.35), font: rng.pick(fontsOf(st, ['display', 'serif'])), fontC: rng.pick(fontsOf(st, ['display', 'serif'])) }),
    render(env) {
      const { W, H, sc } = env, P = env.cut.params, text = env.cut.text.replace(/\s+/g, '');
      const R = Math.min(H * P.R, W * 0.4), cx = W / 2, cy = H / 2, lb = env.ltb;
      const n = glyphCount(text);
      const unit = [...(text + '・')];
      const sizeRing = Math.min(H * 0.07, J.TAU * R / ((n + 1) * 1.25));
      const cnt = Math.max(unit.length, Math.min(44, Math.floor(J.TAU * R / (sizeRing * 1.2))));
      env.circle(cx, cy, R * 0.86, null, sc.sub, 1.2, 0.55, false);
      env.circle(cx, cy, R * 1.15, null, sc.sub, 1.2, 0.35, false);
      let bb = null;
      if (P.center === 'disc') {
        const e = E.outBack(J.clamp(env.lt / (env.cut.inDur * 0.9)), 1.6) * (1 - E.inCubic(env.pOut));
        env.circle(cx, cy, R * 0.72 * e, sc.accent, null, 0, 1, true);
        const size = J.fitSize(text, P.fontC, R * 1.15, R * 0.8);
        bb = J.mainDraw(env, { text, font: P.fontC, size: Math.min(size, H * 0.2), x: cx, y: cy, color: sc.bg, mi: 0 });
      } else if (P.center === 'word') {
        const size = J.fitSize(text, P.fontC, R * 1.3, R * 0.85);
        bb = J.mainDraw(env, { text, font: P.fontC, size: Math.min(size, H * 0.22), x: cx, y: cy, color: sc.fg, mi: 0 });
      }
      for (let i = 0; i < cnt; i++) {
        const ch = unit[i % unit.length];
        const ang = i / cnt * 360 + lb * P.speed - 90;
        const r = ang * J.DEG;
        const it = { text: ch, font: P.font, size: sizeRing, x: cx + Math.cos(r) * R, y: cy + Math.sin(r) * R, rot: P.orient === 'tangent' ? ang + 90 : 0, color: ch === '・' ? sc.accent : sc.fg, mi: i * 0.25, noHold: true };
        const b = J.mainDraw(env, it);
        if (!bb) bb = unionBB(bb, b);
      }
      return bb || { x0: cx - R, x1: cx + R, y0: cy - R, y1: cy + R, cx, cy, boxes: [] };
    },
  },

  /* ------------------------------------------------ */
  wave: {
    name: '波の軌跡', fits: n => n >= 2 && n <= 16,
    plan: (rng, cut, st) => ({ amp: rng.range(0.08, 0.17), freq: rng.range(0.8, 1.6), trail: rng.pick([5, 7, 9]), font: rng.pick(fontsOf(st, ['display'])), travel: rng.range(0.25, 0.5) * rng.pick([1, -1]) }),
    render(env) {
      const { W, H, sc } = env, P = env.cut.params, text = env.cut.text.replace(/\s+/g, '');
      const chars = [...text], n = chars.length;
      const size = Math.min(H * 0.2, W * 0.72 / n);
      const du = size * 1.05 / W, lb = env.ltb, u0 = 0.5 - (env.lt / env.cut.dur - 0.5) * P.travel;
      const path = u => [W * u, H / 2 + H * P.amp * Math.sin(J.TAU * P.freq * u + lb * 1.3)];
      const angAt = u => { const a = path(u - 0.002), b = path(u + 0.002); return Math.atan2(b[1] - a[1], b[0] - a[0]) / J.DEG; };
      let bb = null;
      for (let k = P.trail; k >= 1; k--) {
        chars.forEach((ch, i) => {
          const u = u0 + (i - (n - 1) / 2) * du + k * du * 0.2 * Math.sign(P.travel);
          const [x, y] = path(u);
          env.draw({ text: ch, font: P.font, size: size * (1 - k * 0.035), x, y, rot: angAt(u), color: sc.sub, alpha: 0.5 * (1 - k / (P.trail + 1)) * E.outCubic(env.pIn), ghost: false });
        });
      }
      chars.forEach((ch, i) => {
        const u = u0 + (i - (n - 1) / 2) * du; const [x, y] = path(u);
        bb = unionBB(bb, J.mainDraw(env, { text: ch, font: P.font, size, x, y, rot: angAt(u), color: sc.fg, mi: i * 0.5 }));
      });
      return bb;
    },
  },

  /* ------------------------------------------------ */
  huge: {
    name: '画面突き抜け', fits: n => n <= 8,
    plan: (rng, cut, st) => ({ font: rng.pick(fontsOf(st, ['display'])), grad: !!st.useGrad && rng.chance(0.75), dir: rng.pick([1, -1]), label: rng.chance(0.8) }),
    render(env) {
      const { W, H, sc } = env, P = env.cut.params, text0 = env.cut.text.replace(/\s+/g, '');
      const n = glyphCount(text0);
      const text = n >= 5 ? J.splitLines(text0, Math.ceil(n / 2)) : text0;
      const lines = text.split('\n').length;
      const size = lines > 1 ? Math.min(H * 0.56, W * 1.2 / (Math.ceil(n / 2) * 0.98)) : Math.min(H * 0.98, W * 1.3 / (n * 0.96));
      const u = env.lt / env.cut.dur;
      const bb = J.mainDraw(env, { text, font: P.font, size, x: W / 2 + (0.5 - u) * W * 0.16 * P.dir, y: H / 2 + H * 0.02, lead: 0.98, track: -0.02, color: sc.fg, gradient: P.grad && sc.grad ? sc.grad : null });
      if (P.label) {
        const ls = J.clamp(H * 0.028, 16, 30);
        const a = E.outCubic(J.clamp((env.lt - env.cut.inDur * 0.5) / 0.2)) * (1 - env.pOut);
        const lt = J.measure({ text: env.cut.text, font: env.st.fonts.body[0], size: ls, track: 0.12 });
        env.rect(W * 0.05, H * 0.86 - ls, lt.w + ls * 1.4, ls * 2, sc.ink, a, false);
        env.draw({ text: env.cut.text, font: env.st.fonts.body[0], size: ls, track: 0.12, align: 'left', x: W * 0.05 + ls * 0.7, y: H * 0.86, color: sc.bg, alpha: a, ghost: false });
      }
      return bb;
    },
  },

  /* ------------------------------------------------ */
  labels: {
    name: 'ラベル貼り', fits: n => n >= 1 && n <= 16,
    plan: (rng, cut, st) => ({ variant: rng.pick(['radial', 'rows', 'scatter']), unit: glyphCount(cut.text) <= 6 ? 'char' : rng.pick(['char', 'word']), center: rng.pick(['orb', 'word', 'none']), font: rng.pick(fontsOf(st, ['display', 'body'])), fontC: rng.pick(fontsOf(st, ['display'])) }),
    render(env) {
      const { W, H, sc } = env, P = env.cut.params, s = env.cut.seed, lb = env.ltb;
      const text = env.cut.text.replace(/\s+/g, '');
      let units = P.unit === 'char' ? [...text].filter(c => !J.isPunct(c)) : (env.cut.words && env.cut.words.length ? env.cut.words : [text]);
      if (!units.length) units = [text];
      const out = 1 - E.inCubic(env.pOut);
      const drawLabel = (u, x, y, rot, fs, q, i) => {
        if (q <= 0) return;
        const m = J.measure({ text: u, font: P.font, size: fs, track: 0.04 });
        const w = m.w + fs * 0.7, h = fs * 1.36;
        const ctx = env.ctx; ctx.save(); ctx.translate(x, y); ctx.rotate(rot * J.DEG); ctx.scale(q, q);
        env.rect(-w / 2, -h / 2, w, h, sc.ink, 1);
        env.draw({ text: u, font: P.font, size: fs, track: 0.04, x: 0, y: 0, color: sc.bg, ghost: false });
        ctx.restore();
      };
      let bb = null;
      if (P.variant === 'radial') {
        const m = Math.max(units.length, 10), R = Math.min(H * 0.3, W * 0.36), fs = Math.min(H * 0.062, W * 0.052);
        if (P.center === 'orb') { const e = E.outBack(J.clamp(env.lt / 0.35), 1.4) * out; env.circle(W / 2, H / 2, R * 0.52 * e, sc.accent, null, 0, 1, true); }
        for (let i = 0; i < m; i++) {
          const ang = i / m * 360 + lb * 7 - 90;
          const q = E.outBack(J.clamp((env.lt - i * 0.025) / 0.22), 2) * out;
          drawLabel(units[i % units.length], W / 2 + Math.cos(ang * J.DEG) * R, H / 2 + Math.sin(ang * J.DEG) * R, ang, fs, q, i);
        }
        if (P.center === 'word') bb = J.mainDraw(env, { text, font: P.fontC, size: Math.min(J.fitSize(text, P.fontC, R * 1.1, R * 0.7), H * 0.18), x: W / 2, y: H / 2, color: sc.fg });
        return bb || { x0: W / 2 - R, x1: W / 2 + R, y0: H / 2 - R, y1: H / 2 + R, cx: W / 2, cy: H / 2, boxes: [] };
      }
      if (P.variant === 'rows') {
        const k = units.length, fs = Math.min(H * 0.1, H * 0.7 / (k * 1.5));
        units.forEach((u, i) => {
          const q = E.outBack(J.clamp((env.lt - i * 0.05) / 0.22), 2) * out;
          drawLabel(u, W / 2 + J.rs(s, i, 5) * W * 0.12, H / 2 + (i - (k - 1) / 2) * fs * 1.55, J.rs(s, i, 6) * 4, fs, q, i);
        });
        return { x0: W * 0.3, x1: W * 0.7, y0: H / 2 - k * fs * 0.8, y1: H / 2 + k * fs * 0.8, cx: W / 2, cy: H / 2, boxes: [] };
      }
      const fs = H * 0.085;
      units.forEach((u, i) => {
        const q = E.outBack(J.clamp((env.lt - i * 0.05) / 0.22), 2) * out;
        drawLabel(u, W * (0.15 + 0.7 * ((i + 0.5) / units.length)) + J.rs(s, i, 7) * W * 0.04, H / 2 + J.rs(s, i, 8) * H * 0.25, J.rs(s, i, 9) * 22, fs * (0.8 + J.r(s, i, 10) * 0.5), q, i);
      });
      return { x0: W * 0.15, x1: W * 0.85, y0: H * 0.3, y1: H * 0.7, cx: W / 2, cy: H / 2, boxes: [] };
    },
  },

  /* ------------------------------------------------ */
  condensed: {
    name: '縦長圧縮', fits: n => n <= 10,
    plan: (rng, cut, st) => { const n = glyphCount(cut.text); return { count: n <= 4 ? rng.pick([3, 2, 1]) : n <= 7 ? rng.pick([2, 1]) : 1, sx: rng.range(0.42, 0.58), sy: rng.range(1.1, 1.3), font: rng.pick(fontsOf(st, ['display', 'body'])) }; },
    render(env) {
      const { W, H, sc } = env, P = env.cut.params, text = env.cut.text.replace(/\s+/g, '');
      const slot = W * 0.92 / P.count;
      const size = Math.min(J.fitSize(text, P.font, slot * 0.94, H * 0.8, { sx: P.sx, sy: P.sy, track: 0.04 }), H * 0.62);
      let bb = null; const order = [1, 0, 2, 3];
      for (let i = 0; i < P.count; i++) {
        const r = J.mainDraw(env, { text, font: P.font, size, sx: P.sx, sy: P.sy, track: 0.04, x: W / 2 + (i - (P.count - 1) / 2) * slot, y: H / 2, color: sc.fg, mi: P.count > 1 ? order[i] * 2 : 0 });
        bb = unionBB(bb, r);
      }
      return bb;
    },
  },

  /* ------------------------------------------------ */
  gloss: {
    name: '注釈', fits: n => n <= 12,
    plan: (rng, cut, st) => ({ font: rng.pick(fontsOf(st, ['serif', 'display'])), side: rng.pick(['right', 'left']), bgText: rng.chance(0.6), vertNote: rng.chance(0.45) }),
    render(env) {
      const { W, H, sc } = env, P = env.cut.params, text = env.cut.text, lb = env.ltb;
      if (P.bgText) {
        for (let r = 0; r < 3; r++) {
          const bs = H * 0.3;
          env.draw({ text: (text.replace(/\s+/g, '') + '').repeat(6), font: P.font, size: bs, x: W / 2 + ((lb * 20 * (r % 2 ? 1 : -1)) % (bs * 2)), y: H * (0.18 + r * 0.32), color: sc.dim, alpha: 1, ghost: false });
        }
      }
      const right = P.side === 'right';
      const size = Math.min(J.fitSize(text, P.font, W * 0.5, H * 0.3, { track: 0.03 }), H * 0.24);
      const bb = J.mainDraw(env, { text, font: P.font, size, x: right ? W * 0.4 : W * 0.6, y: H * 0.54, track: 0.03, color: sc.fg });
      if (!bb) return bb;
      const e = E.outExpo(J.clamp((env.lt - env.cut.inDur * 0.4) / 0.45)) * (1 - E.inCubic(env.pOut));
      if (e <= 0) return bb;
      const ax = right ? bb.x1 + size * 0.1 : bb.x0 - size * 0.1, ay = bb.y0 + size * 0.2;
      const nx = right ? Math.min(W * 0.9, bb.x1 + W * 0.1) : Math.max(W * 0.1, bb.x0 - W * 0.1), ny = Math.max(H * 0.12, bb.y0 - H * 0.12);
      const mx = J.lerp(ax, nx, 0.45);
      const pts = [[ax, ay], [mx, ay], [nx, ny]];
      env.polyPartial(pts, e, sc.sub, 1.3, 1, false);
      env.circle(ax, ay, 4, sc.accent, null, 0, e, false);
      const note = env.cut.note || J.romaji(text.replace(/\s+/g, '')) || env.cut.lineText;
      const ns = J.clamp(H * 0.024, 14, 26), body = env.st.fonts.body[0], serif = env.st.fonts.serif[0];
      const al = right ? 'left' : 'right';
      env.draw({ text: '【' + text.replace(/\s+/g, '') + '】', font: serif, size: ns * 1.2, align: al, x: nx, y: ny - ns * 1.2, color: sc.fg, alpha: e, ghost: false });
      if (P.vertNote) env.draw({ text: env.cut.lineText, font: serif, size: ns, vertical: true, align: 'left', x: nx + (right ? ns : -ns), y: ny + ns * 0.8, color: sc.sub, alpha: e, ghost: false });
      else env.draw({ text: note, font: body, size: ns, align: al, x: nx, y: ny + ns * 0.4, track: 0.08, color: sc.sub, alpha: e, ghost: false });
      env.draw({ text: 'No.' + String((env.cut.line | 0) + 1).padStart(2, '0'), font: env.st.fonts.mono[0] || 'mono', size: ns * 0.8, align: al, x: nx, y: ny + ns * 2, color: sc.accent, alpha: e, ghost: false });
      return bb;
    },
  },

  /* ------------------------------------------------ */
  type: {
    name: 'タイプ', fits: n => n <= 28,
    plan: (rng, cut, st) => ({ font: rng.pick(fontsOf(st, ['body', 'serif', 'mono'])), align: rng.pick(['left', 'center']), prompt: rng.chance(0.6) }),
    render(env) {
      const { W, H, sc } = env, P = env.cut.params;
      const text = J.splitLines(env.cut.text, 14);
      const size = Math.min(H * 0.11, J.fitSize(text, P.font, W * 0.74, H * 0.36, { track: 0.06, lead: 1.35 }));
      const left = P.align === 'left';
      const x = left ? W * 0.13 : W / 2;
      if (P.prompt) env.draw({ text: '>', font: env.st.fonts.mono[0] || 'mono', size: size * 0.8, x: (left ? x : x - J.measure({ text, font: P.font, size, track: 0.06 }).w / 2) - size * 0.9, y: H / 2 - (text.split('\n').length - 1) * size * 0.67, color: sc.accent, ghost: false });
      const bb = J.mainDraw(env, { text, font: P.font, size, x, y: H / 2, align: left ? 'left' : 'center', track: 0.06, lead: 1.35, color: sc.fg, enter: env.cut.enter === 'cut' ? 'type' : undefined });
      const ms = J.clamp(H * 0.02, 12, 20);
      env.draw({ text: `LINE ${String((env.cut.line | 0) + 1).padStart(2, '0')} ─ ${J.fmtTime(env.t)}`, font: env.st.fonts.mono[0] || 'mono', size: ms, align: 'left', x: W * 0.13, y: H * 0.8, color: sc.sub, alpha: 0.8, ghost: false });
      return bb;
    },
  },

  /* ------------------------------------------------ */
  diag: {
    name: '斜め帯', fits: n => n <= 14,
    plan: (rng, cut, st) => ({ ang: rng.range(10, 22) * rng.pick([1, -1]), band: rng.pick(['accent', 'ink']), second: rng.chance(0.7), font: rng.pick(fontsOf(st, ['display'])) }),
    render(env) {
      const { W, H, sc } = env, P = env.cut.params, text = env.cut.text, lb = env.ltb, ctx = env.ctx;
      const bandCol = P.band === 'accent' ? sc.accent : sc.ink;
      const txtCol = J.lum(bandCol) > 0.5 ? (J.lum(sc.bg) < 0.5 ? sc.bg : '#111111') : (J.lum(sc.fg) > 0.5 ? sc.fg : '#FFFFFF');
      const size = Math.min(J.fitSize(text, P.font, W * 0.72, H * 0.24, { track: 0.05 }), H * 0.2);
      const bh = size * 1.6;
      const e = E.outExpo(J.clamp(env.lt / (env.cut.inDur * 0.8))) * (1 - E.inExpo(env.pOut));
      ctx.save(); ctx.translate(W / 2, H / 2); ctx.rotate(-P.ang * J.DEG);
      env.rect(-W * 1.2, -bh / 2 * e, W * 2.4, bh * e, bandCol, 1);
      if (P.second) {
        const y2 = bh * 0.95, h2 = bh * 0.32;
        env.rect(-W * 1.2, y2 - h2 / 2, W * 2.4 * e, h2, sc.fg, 0.9, false);
        const unit = env.cut.lineText + '　／　';
        const period = J.measure({ text: unit, font: env.st.fonts.body[0], size: h2 * 0.55, track: 0.1 }).w;
        env.draw({ text: unit.repeat(Math.ceil(W * 3 / period)), font: env.st.fonts.body[0], size: h2 * 0.55, track: 0.1, x: -((lb * 120) % period), y: y2, color: sc.bg, ghost: false, alpha: e });
      }
      ctx.restore();
      return J.mainDraw(env, { text, font: P.font, size, x: W / 2, y: H / 2, rot: -P.ang, track: 0.05, color: txtCol });
    },
  },

  /* ------------------------------------------------ */
  circle: {
    name: '円窓', fits: n => n <= 10,
    plan: (rng, cut, st) => ({ variant: rng.pick(['disc', 'eclipse', 'ring']), vertical: glyphCount(cut.text) <= 4 && rng.chance(0.5), font: rng.pick(fontsOf(st, ['display', 'serif'])), off: rng.range(-0.12, 0.12) }),
    render(env) {
      const { W, H, sc } = env, P = env.cut.params, text = env.cut.text.replace(/\s+/g, ''), ctx = env.ctx;
      const cx = W / 2 + P.off * W, cy = H / 2;
      const out = 1 - E.inCubic(env.pOut);
      if (P.variant === 'eclipse') {
        const size = Math.min(J.fitSize(text, P.font, W * 0.82, H * 0.46, { track: 0.02 }), H * 0.36);
        const bb = J.mainDraw(env, { text: J.splitLines(text, 6), font: P.font, size, x: W / 2, y: H / 2, lead: 1.05, color: sc.fg });
        const R = H * 0.19, u = env.lt / env.cut.dur;
        const ex = W / 2 + J.lerp(-0.08, 0.08, u) * W, ey = H / 2 + H * 0.12;
        if (env.pass === 'main') {
          ctx.save(); ctx.shadowColor = J.rgba(sc.fg, 0.9); ctx.shadowBlur = 38 * env.scale;
          env.circle(ex, ey, R * 1.01 * out, null, sc.fg, 3, 0.9, false); ctx.restore();
          env.circle(ex, ey, R * out, J.mix(sc.bg, '#000000', 0.35), null, 0, 1, false);
        }
        return bb;
      }
      const R = Math.min(H * 0.3, W * 0.4);
      const e = E.outBack(J.clamp(env.lt / (env.cut.inDur * 0.9)), 1.5) * out;
      if (P.variant === 'disc') env.circle(cx, cy, R * e, sc.accent, null, 0, 1, true);
      else env.arc(cx, cy, R, -90, -90 + 360 * E.outExpo(J.clamp(env.lt / (env.cut.inDur * 1.3))) * out, sc.fg, 3, 1);
      const size = P.vertical ? Math.min(J.fitSize(text, P.font, R * 1.1, R * 1.35, { vertical: true }), R * 0.9) : Math.min(J.fitSize(text, P.font, R * 1.45, R * 0.9), R * 0.8);
      return J.mainDraw(env, { text, font: P.font, size, x: cx, y: cy, vertical: P.vertical, color: P.variant === 'disc' ? sc.bg : sc.fg });
    },
  },

  /* ------------------------------------------------ */
  stack: {
    name: '残像スタック', fits: n => n <= 12,
    plan: (rng, cut, st) => ({ copies: rng.pick([3, 4, 5]), dir: rng.pick([1, -1]), style: rng.pick(['fade', 'outline', 'fade']), font: rng.pick(fontsOf(st, ['display', 'serif'])), gap: rng.range(0.82, 1.02), xs: rng.range(-0.04, 0.04) }),
    render(env) {
      const { W, H, sc } = env, P = env.cut.params, text = env.cut.text;
      const size = Math.min(J.fitSize(text, P.font, W * 0.8, H * 0.22, { track: 0.03 }), H * 0.19);
      const step = size * P.gap, n = P.copies;
      const y0 = H / 2 - P.dir * (n - 1) * step / 2;
      let bb = null;
      for (let k = n - 1; k >= 0; k--) {
        const it = { text, font: P.font, size, x: W / 2 + P.xs * W * k, y: y0 + P.dir * k * step, track: 0.03, color: sc.fg, mi: k * 1.2 };
        if (k > 0) { if (P.style === 'outline') Object.assign(it, { fill: false, stroke: Math.max(1.2, size * 0.014), alpha: 0.85 }); else it.alpha = 0.6 * Math.pow(0.58, k - 1); }
        const r = J.mainDraw(env, it); if (k === 0) bb = r;
      }
      return bb;
    },
  },

  /* ------------------------------------------------ */
  pill: {
    name: 'カプセル', fits: n => n <= 14,
    plan: (rng, cut, st) => ({ grad: !!st.useGrad || rng.chance(0.35), font: rng.pick(fontsOf(st, ['display', 'body'])), smalls: rng.chance(0.75) }),
    render(env) {
      const { W, H, sc } = env, P = env.cut.params, text = env.cut.text, ctx = env.ctx;
      const size = Math.min(J.fitSize(text, P.font, W * 0.62, H * 0.2, { track: 0.04 }), H * 0.17);
      const m = J.measure({ text, font: P.font, size, track: 0.04 });
      const w = m.w + size * 1.3, h = size * 1.6;
      const e = E.outExpo(J.clamp(env.lt / (env.cut.inDur * 0.9))) * (1 - E.inExpo(env.pOut));
      const fillC = P.grad && sc.grad ? sc.grad : [sc.accent, sc.accent];
      const ww = Math.max(h, w * e);
      if (env.pass === 'main') {
        const g = ctx.createLinearGradient(W / 2 - ww / 2, 0, W / 2 + ww / 2, 0); g.addColorStop(0, fillC[0]); g.addColorStop(1, fillC[1]);
        env.rrect(W / 2 - ww / 2, H / 2 - h / 2, ww, h, h / 2, g, 1, true);
      } else env.rrect(W / 2 - ww / 2, H / 2 - h / 2, ww, h, h / 2, sc.accent, 1, true);
      const tc = J.lum(fillC[0]) > 0.55 ? '#111111' : '#FFFFFF';
      ctx.save(); ctx.beginPath(); ctx.rect(W / 2 - ww / 2, 0, ww, H); ctx.clip();
      const bb = J.mainDraw(env, { text, font: P.font, size, x: W / 2, y: H / 2, track: 0.04, color: tc });
      ctx.restore();
      if (P.smalls) {
        const labs = [J.romaji(text.replace(/\s+/g, '')) || 'LYRIC', 'No.' + String((env.cut.line | 0) + 1).padStart(2, '0'), J.fmtTime(env.cut.start)];
        const fs = J.clamp(H * 0.022, 13, 24);
        labs.forEach((l, i) => {
          const q = E.outBack(J.clamp((env.lt - 0.15 - i * 0.06) / 0.25), 2) * (1 - env.pOut);
          if (q <= 0) return;
          const mm = J.measure({ text: l, font: env.st.fonts.body[0], size: fs, track: 0.1 });
          const px = W / 2 + (i === 0 ? -w * 0.3 : i === 1 ? w * 0.42 : w * 0.1), py = H / 2 + (i === 1 ? -h * 0.95 : h * 0.95);
          env.rrect(px - (mm.w / 2 + fs * 0.8) * q, py - fs * 0.85, (mm.w + fs * 1.6) * q, fs * 1.7, fs * 0.85, null, 1, false, sc.fg, 1.3);
          env.draw({ text: l, font: env.st.fonts.body[0], size: fs, track: 0.1, x: px, y: py, color: sc.fg, alpha: q, ghost: false });
        });
      }
      return bb;
    },
  },

  /* ------------------------------------------------ special: title card */
  title: {
    name: 'タイトル', special: true, fits: () => false,
    plan: (rng, cut, st) => ({ font: rng.pick(fontsOf(st, ['display', 'serif'])) }),
    render(env) {
      const { W, H, sc } = env, P = env.cut.params;
      const size = Math.min(J.fitSize(env.cut.text, P.font, W * 0.7, H * 0.2, { track: 0.08 }), H * 0.16);
      const bb = J.mainDraw(env, { text: env.cut.text, font: P.font, size, x: W / 2, y: H / 2, track: 0.08, color: sc.fg });
      if (env.cut.note) env.draw({ text: env.cut.note, font: env.st.fonts.body[0], size: J.clamp(H * 0.03, 16, 32), x: W / 2, y: H / 2 + size * 0.95, track: 0.3, color: sc.sub, alpha: E.outCubic(J.clamp((env.lt - 0.3) / 0.4)) * (1 - env.pOut), ghost: false });
      return bb;
    },
  },

  /* ------------------------------------------------ special: interlude */
  interlude: {
    name: '間奏', special: true, fits: () => false,
    plan: (rng) => ({ variant: rng.pick(['counter', 'rings']) }),
    render(env) {
      const { W, H, sc } = env, P = env.cut.params, lb = env.ltb;
      const fs = J.clamp(H * 0.022, 12, 22);
      if (P.variant === 'quiet') {                        // [間奏]: nothing but the song title on long interludes
        if (P.showTitle && P.titleText) {
          const a = J.clamp(env.lt / 0.8) * J.clamp((env.cut.dur - env.lt) / 0.8);
          env.draw({ text: P.titleText, font: env.st.fonts.body[0], size: fs * 1.1, x: W / 2, y: H * 0.88, track: 0.3, color: sc.sub, alpha: a, ghost: false });
        }
        return { x0: W * 0.3, x1: W * 0.7, y0: H * 0.3, y1: H * 0.7, cx: W / 2, cy: H / 2, boxes: [] };
      }
      if (P.variant === 'counter') {
        const remain = Math.max(0, env.cut.dur - env.lt);
        env.draw({ text: remain.toFixed(1), font: env.st.fonts.display[0], size: H * 0.36, x: W / 2, y: H / 2, color: sc.fg, alpha: 0.9 });
      }
      for (let k = 0; k < 3; k++) env.circle(W / 2, H / 2, H * (0.2 + k * 0.1) * (1 + 0.04 * Math.sin(lb * 2 + k)), null, sc.sub, 1.2, 0.5, false);
      env.draw({ text: env.cut.text || '— interlude —', font: env.st.fonts.body[0], size: fs, x: W / 2, y: H * 0.82, track: 0.4, color: sc.sub, ghost: false });
      return { x0: W * 0.35, x1: W * 0.65, y0: H * 0.3, y1: H * 0.7, cx: W / 2, cy: H / 2, boxes: [] };
    },
  },
};
J.LAYOUT_ORDER = ['center', 'mixed', 'vcols', 'marquee', 'tile', 'scatter', 'ring', 'wave', 'huge', 'labels', 'condensed', 'gloss', 'type', 'diag', 'circle', 'stack', 'pill'];
J.ENTER_ORDER = ['cut', 'assemble', 'slice', 'type', 'pop', 'drop', 'stretch', 'wipe', 'blur', 'spin', 'flicker', 'scramble', 'zoom'];
J.HOLD_ORDER = ['still', 'jitter', 'drift', 'breathe', 'wave', 'glitchtick'];
J.EXIT_ORDER = ['cut', 'explode', 'fall', 'drift', 'slice', 'wipe', 'shrink', 'blur', 'stretch', 'scatter', 'glitch'];
})();


// Upstream src/07_decor.js
/* ============================================================
   JIZURA — decor (graphic elements around / behind the lyric) + HUD
   ============================================================ */
(() => {
'use strict';
const E = J.E;
const center = (env, bb) => bb || { x0: env.W * 0.35, x1: env.W * 0.65, y0: env.H * 0.4, y1: env.H * 0.6, cx: env.W / 2, cy: env.H / 2 };
const monoF = env => (env.st.fonts.mono && env.st.fonts.mono[0]) || 'mono';
const inOut = env => E.outCubic(J.clamp(env.lt / 0.3)) * (1 - E.inCubic(env.pOut));

J.DECOR = {
  /* ---------------- back layer ---------------- */
  grid: {
    name: 'グリッド', layer: 'back',
    draw(env, bb, P) {
      const { W, H, sc } = env, g = H / (P.n || 8), a = 0.12 * inOut(env);
      if (a <= 0) return;
      const pts = [];
      for (let x = (W / 2) % g; x < W; x += g) env.line([[x, 0], [x, H]], sc.sub, 1, a, false);
      for (let y = (H / 2) % g; y < H; y += g) env.line([[0, y], [W, y]], sc.sub, 1, a, false);
    },
  },
  stripes: {
    name: 'ストライプ', layer: 'back',
    draw(env, bb, P) {
      const { W, H, sc, ctx } = env, e = inOut(env);
      if (e <= 0) return;
      ctx.save(); ctx.translate(P.corner ? W * 0.85 : W * 0.15, P.corner ? H * 0.15 : H * 0.85); ctx.rotate(-35 * J.DEG);
      const w = H * 0.04;
      for (let i = -6; i <= 6; i++) env.rect(i * w * 2 - w / 2 + (env.ltb * 40) % (w * 2), -H * 0.18 * e, w, H * 0.36 * e, P.accent ? sc.accent : sc.dim, 0.9, false);
      ctx.restore();
    },
  },
  blobs: {
    name: 'インクの染み', layer: 'back',
    draw(env, bb, P) {
      const { W, H, sc, ctx } = env, s = P.seed;
      const e = E.outBack(J.clamp(env.lt / 0.35), 1.2) * (1 - E.inCubic(env.pOut));
      if (e <= 0) return;
      for (let k = 0; k < (P.n || 2); k++) {
        const cx = J.rr(W * 0.12, W * 0.88, s, k, 1), cy = J.rr(H * 0.15, H * 0.85, s, k, 2), R = J.rr(H * 0.06, H * 0.16, s, k, 3) * e;
        const m = 14, pts = [];
        for (let i = 0; i < m; i++) {
          const a = i / m * J.TAU, r = R * (0.72 + 0.5 * J.r(s, k, i, 4) + 0.08 * Math.sin(env.ltb * 3 + i));
          pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
        }
        env.blob(pts, k % 2 ? sc.accent : (sc.accent2 || sc.accent), 0.95, true);
      }
    },
  },
  bars: {
    name: '荒い帯', layer: 'back',
    draw(env, bb, P) {
      const { W, H, sc } = env, s = P.seed, n = P.n || 3;
      for (let k = 0; k < n; k++) {
        const e = E.outExpo(J.clamp((env.lt - k * 0.05) / 0.3)) * (1 - E.inExpo(env.pOut));
        if (e <= 0) continue;
        const y = H * (J.r(s, k, 11) < 0.5 ? J.rr(0.1, 0.27, s, k, 1) : J.rr(0.73, 0.9, s, k, 1)), h = H * J.rr(0.03, 0.08, s, k, 2), fromL = J.r(s, k, 3) < 0.5;
        const w = W * J.rr(0.35, 0.75, s, k, 4) * e;
        const x0 = fromL ? -10 : W + 10 - w;
        const pts = [];
        const m = 10;
        for (let i = 0; i <= m; i++) pts.push([x0 + w * i / m, y - h / 2 + J.rs(s, k, i, 5) * h * 0.08]);
        pts.push([x0 + w + J.rs(s, k, 6) * h * 0.4, y + h * 0.1]);
        for (let i = m; i >= 0; i--) pts.push([x0 + w * i / m, y + h / 2 + J.rs(s, k, i, 7) * h * 0.08]);
        env.poly(pts, k === 0 ? sc.accent : sc.ink, 0.92, true);
      }
    },
  },
  shapes: {
    name: '図形', layer: 'back',
    draw(env, bb, P) {
      const { W, H, sc, ctx } = env, s = P.seed, n = P.n || 5;
      for (let k = 0; k < n; k++) {
        const q = E.outBack(J.clamp((env.lt - J.r(s, k, 9) * 0.3) / 0.25), 1.8) * (1 - E.inCubic(env.pOut));
        if (q <= 0) continue;
        const type = ['circle', 'square', 'tri', 'halftone', 'halftone', 'ring', 'ring'][Math.floor(J.r(s, k, 1) * 7)];
        const top = J.r(s, k, 4) < 0.5;
        const x = J.rr(W * 0.05, W * 0.95, s, k, 2) + env.ltb * J.rs(s, k, 3) * 30, y = (top ? J.rr(H * 0.06, H * 0.24, s, k, 10) : J.rr(H * 0.76, H * 0.94, s, k, 10)) + env.ltb * J.rs(s, k, 5) * 20;
        const r = J.rr(H * 0.018, H * 0.06, s, k, 6) * q, rot = (J.r(s, k, 7) * 360 + env.ltb * J.rs(s, k, 8) * 60) * J.DEG;
        const col = [sc.accent, sc.accent2 || sc.fg, sc.ink, sc.fg][k % 4];
        ctx.save(); ctx.translate(x, y); ctx.rotate(rot);
        if (type === 'circle') env.circle(0, 0, r, col, null, 0, 1, true);
        else if (type === 'ring') env.circle(0, 0, r, null, col, Math.max(2, r * 0.12), 1, true);
        else if (type === 'square') env.rect(-r, -r, r * 2, r * 2, col, 1, true);
        else if (type === 'tri') env.poly([[0, -r], [r * 0.9, r * 0.6], [-r * 0.9, r * 0.6]], col, 1, true);
        else if (type === 'cross') { env.rect(-r, -r * 0.18, r * 2, r * 0.36, col, 1, true); env.rect(-r * 0.18, -r, r * 0.36, r * 2, col, 1, true); }
        else { const d = r / 3.2; for (let i = -3; i <= 3; i++) for (let j = -3; j <= 3; j++) { const rr = d * 0.45 * (1 - (Math.abs(i) + Math.abs(j)) / 8); if (rr > 0.5) env.circle(i * d, j * d, rr, col, null, 0, 1, true); } }
        ctx.restore();
      }
    },
  },
  counter: {
    name: '大きな数字', layer: 'back',
    draw(env, bb, P) {
      const { W, H, sc } = env;
      const a = inOut(env); if (a <= 0) return;
      const num = P.mode === 'count' ? String(Math.floor(J.lerp(P.from, P.to, E.outCubic(J.clamp(env.lt / (env.cut.dur * 0.8)))))) : String((env.cut.index | 0) + 1).padStart(2, '0');
      env.draw({ text: num, font: env.st.fonts.display[0], size: H * 0.5, x: P.right ? W * 0.86 : W * 0.14, y: H * (P.low ? 0.72 : 0.3), color: P.accent ? sc.accent : sc.dim, alpha: a * (P.accent ? 0.9 : 1), ghost: false });
    },
  },

  /* ---------------- front layer ---------------- */
  brackets: {
    name: '枠マーク', layer: 'front',
    draw(env, bb, P) {
      bb = center(env, bb); const { sc } = env;
      const e = E.outExpo(J.clamp(env.lt / 0.35)) * (1 - E.inCubic(env.pOut)); if (e <= 0) return;
      const pad = 18 + (bb.y1 - bb.y0) * 0.12;
      const x0 = bb.x0 - pad, x1 = bb.x1 + pad, y0 = bb.y0 - pad, y1 = bb.y1 + pad;
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      const X0 = J.lerp(cx, x0, e), X1 = J.lerp(cx, x1, e), Y0 = J.lerp(cy, y0, e), Y1 = J.lerp(cy, y1, e);
      const L = Math.min(x1 - x0, y1 - y0) * 0.16 + 8, c = P.accent ? sc.accent : sc.fg, w = 2.2;
      env.line([[X0, Y0 + L], [X0, Y0], [X0 + L, Y0]], c, w, 1);
      env.line([[X1 - L, Y0], [X1, Y0], [X1, Y0 + L]], c, w, 1);
      env.line([[X0, Y1 - L], [X0, Y1], [X0 + L, Y1]], c, w, 1);
      env.line([[X1 - L, Y1], [X1, Y1], [X1, Y1 - L]], c, w, 1);
    },
  },
  rings: {
    name: '座標の円', layer: 'front',
    draw(env, bb, P) {
      bb = center(env, bb); const { W, H, sc } = env, s = P.seed;
      const e = E.outExpo(J.clamp(env.lt / 0.5)) * (1 - E.inCubic(env.pOut)); if (e <= 0) return;
      const cx = (bb.x0 + bb.x1) / 2, cy = (bb.y0 + bb.y1) / 2;
      const R0 = Math.max(bb.x1 - bb.x0, bb.y1 - bb.y0) * 0.55 + H * 0.05;
      for (let k = 0; k < (P.n || 2); k++) {
        const R = R0 * (1 + k * 0.28 + J.r(s, k, 1) * 0.1), a0 = J.r(s, k, 2) * 360 + env.ltb * (k % 2 ? -14 : 10);
        env.arc(cx, cy, R, a0, a0 + 360 * e * (0.55 + 0.45 * J.r(s, k, 3)), sc.fg, 1.2, 0.7, false);
        const pa = (a0 + 40) * J.DEG, px = cx + Math.cos(pa) * R, py = cy + Math.sin(pa) * R;
        env.circle(px, py, 4, sc.accent, null, 0, 1, false);
        env.draw({ text: `X${Math.round(px)} Y${Math.round(py)}`, font: monoF(env), size: J.clamp(H * 0.015, 10, 18), align: 'left', x: px + 10, y: py - 12, color: sc.sub, alpha: e, ghost: false });
      }
    },
  },
  dots: {
    name: 'ドットの輪', layer: 'front',
    draw(env, bb, P) {
      bb = center(env, bb); const { H, sc } = env;
      const e = inOut(env); if (e <= 0) return;
      const cx = (bb.x0 + bb.x1) / 2, cy = (bb.y0 + bb.y1) / 2, R = Math.max(bb.x1 - bb.x0, bb.y1 - bb.y0) * 0.62 + H * 0.04;
      const m = 36;
      for (let i = 0; i < m * e; i++) { const a = (i / m * 360 + env.ltb * 20) * J.DEG; env.circle(cx + Math.cos(a) * R, cy + Math.sin(a) * R, i % 6 === 0 ? 4 : 2.2, i % 6 === 0 ? sc.accent : sc.fg, null, 0, 0.85, false); }
    },
  },
  arrows: {
    name: '矢印', layer: 'front',
    draw(env, bb, P) {
      bb = center(env, bb); const { W, H, sc } = env;
      const e = E.outExpo(J.clamp(env.lt / 0.4)) * (1 - E.inCubic(env.pOut)); if (e <= 0) return;
      const cy = (bb.y0 + bb.y1) / 2, s = J.clamp(H * 0.03, 14, 40), gap = s * 0.9;
      for (const side of [-1, 1]) {
        const xEdge = side < 0 ? bb.x0 - s * 1.2 : bb.x1 + s * 1.2;
        for (let i = 0; i < 3; i++) {
          const on = (env.step + i) % 3 !== 0;
          const x = xEdge + side * (i * gap + (1 - e) * W * 0.2);
          const d = -side;                                   // chevrons point toward text
          env.line([[x - d * s * 0.35, cy - s * 0.5], [x + d * s * 0.35, cy], [x - d * s * 0.35, cy + s * 0.5]], i === 0 ? sc.accent : sc.fg, Math.max(2, s * 0.14), on ? 1 : 0.3, false);
        }
      }
      if (P.big) {
        const x = P.right ? W * 0.9 : W * 0.1, y = H * (P.low ? 0.82 : 0.2), L = H * 0.1 * e;
        const dx = P.right ? -1 : 1, dy = P.low ? -1 : 1;
        env.line([[x, y], [x + dx * L, y + dy * L]], sc.fg, Math.max(3, H * 0.008), 1, true);
        env.line([[x + dx * L * 0.45, y + dy * L], [x + dx * L, y + dy * L], [x + dx * L, y + dy * L * 0.55]], sc.fg, Math.max(3, H * 0.008), 1, true);
      }
    },
  },
  slash: {
    name: 'スラッシュ', layer: 'front',
    draw(env, bb, P) {
      const { W, H, sc } = env, s = P.seed;
      for (let k = 0; k < (P.n || 1); k++) {
        const e = E.outExpo(J.clamp((env.lt - k * 0.06) / 0.35)); if (e <= 0) continue;
        const ang = J.rr(-70, -20, s, k, 1) * J.DEG, cx = J.rr(W * 0.3, W * 0.7, s, k, 2), cy = J.rr(H * 0.3, H * 0.7, s, k, 3), L = Math.hypot(W, H);
        const x0 = cx - Math.cos(ang) * L / 2, y0 = cy - Math.sin(ang) * L / 2;
        const t0 = env.pOut > 0 ? E.inCubic(env.pOut) : 0;
        env.line([[x0 + Math.cos(ang) * L * t0, y0 + Math.sin(ang) * L * t0], [x0 + Math.cos(ang) * L * e, y0 + Math.sin(ang) * L * e]], k ? sc.accent : sc.fg, k ? 2 : 1.4, 0.9, true);
      }
    },
  },
  sparks: {
    name: 'スパーク', layer: 'front',
    draw(env, bb, P) {
      const { W, H, sc } = env, s = P.seed;
      for (let k = 0; k < (P.n || 6); k++) {
        const q = E.outBack(J.clamp((env.lt - J.r(s, k, 1) * 0.4) / 0.2), 2) * (1 - E.inCubic(env.pOut)); if (q <= 0) continue;
        const x = J.rr(W * 0.05, W * 0.95, s, k, 2), y = J.rr(H * 0.08, H * 0.92, s, k, 3), r = J.rr(H * 0.015, H * 0.04, s, k, 4) * q;
        const rot = env.ltb * J.rs(s, k, 5) * 3 + J.r(s, k, 6) * 3, arms = J.r(s, k, 7) < 0.5 ? 3 : 4;
        for (let a = 0; a < arms; a++) { const an = rot + a * Math.PI / arms; env.line([[x - Math.cos(an) * r, y - Math.sin(an) * r], [x + Math.cos(an) * r, y + Math.sin(an) * r]], k % 3 === 0 ? sc.accent : sc.fg, Math.max(1.5, r * 0.14), 1, true); }
      }
    },
  },
  leaders: {
    name: '引き出し線', layer: 'front',
    draw(env, bb, P) {
      bb = center(env, bb); const { W, H, sc } = env, s = P.seed;
      const e = E.outExpo(J.clamp((env.lt - 0.1) / 0.45)) * (1 - E.inCubic(env.pOut)); if (e <= 0) return;
      const labels = [J.romaji(env.cut.text.replace(/\s+/g, '')) || env.cut.lineText, 'No.' + String((env.cut.line | 0) + 1).padStart(2, '0') + ' / ' + J.fmtTime(env.cut.start), env.cut.note || '─'];
      const fs = J.clamp(H * 0.018, 11, 20);
      const anchors = [[bb.x1, bb.y0], [bb.x0, bb.y1], [bb.x1, bb.y1]];
      for (let k = 0; k < 2; k++) {
        const [ax, ay] = anchors[k];
        const tx = J.clamp(ax + (k === 1 ? -1 : 1) * W * J.rr(0.06, 0.14, s, k, 1), W * 0.06, W * 0.94), ty = J.clamp(ay + (k === 0 ? -1 : 1) * H * J.rr(0.08, 0.16, s, k, 2), H * 0.08, H * 0.92);
        env.polyPartial([[ax, ay], [tx, ty], [tx + (k === 1 ? -1 : 1) * W * 0.05, ty]], e, sc.sub, 1.2, 1, false);
        env.circle(ax, ay, 3.5, sc.accent, null, 0, e, false);
        env.draw({ text: labels[k], font: k === 0 ? env.st.fonts.body[0] : monoF(env), size: fs, align: k === 1 ? 'right' : 'left', x: tx + (k === 1 ? -1 : 1) * W * 0.055, y: ty - fs * 0.9, track: 0.06, color: sc.fg, alpha: e, ghost: false });
      }
    },
  },
  waveform: {
    name: '波形', layer: 'front',
    draw(env, bb, P) {
      const { W, H, sc } = env; const e = inOut(env); if (e <= 0) return;
      const y = H * (P.low ? 0.86 : 0.14), n = 120, pts = [];
      const en = env.energy != null ? env.energy : 0.5;
      for (let i = 0; i <= n; i++) {
        const u = i / n, x = J.lerp(W * 0.18, W * 0.82, u);
        const env2 = Math.sin(u * Math.PI);
        const amp = H * 0.035 * env2 * (0.35 + en) * (0.5 + 0.5 * J.noise1(u * 18 + env.t * 9, P.seed));
        pts.push([x, y + (i % 2 ? amp : -amp)]);
      }
      env.polyPartial(pts, e, sc.fg, 1.4, 0.9, false);
    },
  },
  barcode: {
    name: 'バーコード', layer: 'front',
    draw(env, bb, P) {
      const { W, H, sc } = env, s = P.seed; const e = inOut(env); if (e <= 0) return;
      const x0 = P.right ? W * 0.84 : W * 0.06, y0 = P.low ? H * 0.84 : H * 0.07, h = H * 0.05;
      let x = x0;
      for (let i = 0; i < 34; i++) { const w = 1 + Math.floor(J.r(s, i, 1) * 3.2); if (J.r(s, i, 2) < 0.62) env.rect(x, y0, w * e, h, sc.fg, 0.9, false); x += w + 1.5; }
      env.draw({ text: String(J.h(s, 5) % 1e9).padStart(9, '0'), font: monoF(env), size: J.clamp(H * 0.014, 9, 16), align: 'left', x: x0, y: y0 + h + 12, color: sc.fg, alpha: e * 0.9, ghost: false, track: 0.2 });
    },
  },
};
J.DECOR_ORDER = ['brackets', 'rings', 'dots', 'arrows', 'slash', 'sparks', 'leaders', 'waveform', 'barcode', 'grid', 'stripes', 'blobs', 'bars', 'shapes', 'counter'];

/* global HUD overlay (frame, title, timecode, rec, counter) */
J.drawHUD = (env, plan) => {
  const { W, H, sc, ctx } = env;
  const m = Math.round(H * 0.045), L = H * 0.035, c = sc.sub, fs = J.clamp(H * 0.016, 10, 18), mono = monoF(env);
  const lw = 1.4;
  env.line([[m, m + L], [m, m], [m + L, m]], c, lw, 0.9, false);
  env.line([[W - m - L, m], [W - m, m], [W - m, m + L]], c, lw, 0.9, false);
  env.line([[m, H - m - L], [m, H - m], [m + L, H - m]], c, lw, 0.9, false);
  env.line([[W - m - L, H - m], [W - m, H - m], [W - m, H - m - L]], c, lw, 0.9, false);
  const title = (plan.title || 'UNTITLED') + (plan.artist ? ' / ' + plan.artist : '');
  env.draw({ text: title, font: env.st.fonts.body[0], size: fs, align: 'left', x: m + L * 0.6, y: m + L * 0.9, color: c, track: 0.12, ghost: false });
  const rec = env.step % 4 < 2;
  if (rec) env.circle(W - m - L * 2.6, m + L * 0.9, fs * 0.32, sc.accent, null, 0, 1, false);
  env.draw({ text: 'REC', font: mono, size: fs, align: 'left', x: W - m - L * 2.2, y: m + L * 0.9, color: c, ghost: false, track: 0.1 });
  env.draw({ text: J.fmtTime(env.t, plan.fps), font: mono, size: fs, align: 'left', x: m + L * 0.6, y: H - m - L * 0.9, color: c, ghost: false, track: 0.1 });
  const li = env.cut ? (env.cut.line | 0) + 1 : 0;
  env.draw({ text: `LYRIC ${String(li).padStart(2, '0')}/${String(plan.lines.length).padStart(2, '0')}`, font: mono, size: fs, align: 'right', x: W - m - L * 0.6, y: H - m - L * 0.9, color: c, ghost: false, track: 0.1 });
  const u = plan.duration > 0 ? J.clamp(env.t / plan.duration) : 0;
  env.line([[W * 0.3, H - m - L * 0.9], [W * 0.7, H - m - L * 0.9]], c, 1, 0.35, false);
  env.line([[W * 0.3, H - m - L * 0.9], [J.lerp(W * 0.3, W * 0.7, u), H - m - L * 0.9]], sc.accent, 2, 0.9, false);
};
})();


// Upstream src/08_planner.js
/* ============================================================
   JIZURA — planner: lyrics -> lines -> chunks -> timed cuts + events
   ============================================================ */
(() => {
'use strict';

J.SAMPLE_LYRICS = `夜明けの色を/覚えてる
ほどけた声が遠くで鳴った
ねえ、まだ間に合うかな
*透明*なままじゃ終われない!`;

J.defaultProject = () => ({
  version: 1,
  timingOrder: 2,                 // lyric lines keep their written order around LRC-tagged lines (v0.10)
  themeId: null,                  // おまかせのテーマ (J.THEMES key) — only おまかせ reads it
  title: '', artist: '',
  lyrics: J.SAMPLE_LYRICS,
  style: 'noir', mood: null,
  extra: false,                   // random picks may use the parts added after the first version (追加分)
  wa: true,                       // …and the 和風 motifs (提灯・障子・家紋…) — applied after 'extra'
  horror: false,                  // parts sets (independent of 'extra'): ホラー (also enables the ホラー mood)
  typo: true,                     // 文字PV系 typographic parts
  kinetic: true,                  // キネティック parts
  lang: 'auto',                   // 歌詞の言語: 'auto' | 'ja' | 'zh-Hant' | 'zh-Hans' | 'ko' — picks the faces each font key is drawn with
  keyBg: 'off',                   // 合成用の背景: 'off' | 'green' (グリーンバック) | 'black' (ブラックバック)
  unify: false,                   // 統一感: part palettes, repeats shown the same way, キメ, モーフ, 太さ
  typeset: false,                 // 文字整列: kana tracking, small particles / big first character, Latin sizing, 0.2 s lead, restraint
  centerDir: 'tb',                // 中央を空ける on tall frames: 'tb' = top / bottom, 'lr' = left / right
  centerFree: false,              // 中央を空ける: lay the cuts out in side bands (left / right or top / bottom) around a character
  seed: 20260922,
  aspect: '16:9', res: 1080, fps: 24,
  fx: { motion: 0.7, glitch: 0.55, chroma: 0.7, decor: 0.5, density: 0.55, texture: 0.6, flash: true, onTwos: true, koma: 12, hud: 'auto', bgSwitch: 0.35, hideNo: false, hideTime: false },
  enabled: Object.fromEntries(J.GROUP_KEYS.map(g => [g, Object.fromEntries(J.order(g).map(k => [k, true]))])),
  timing: { bpm: 0, offset: 0.4, snap: true, tail: 0.9, lineTimes: {}, lineScale: 1 },
  overrides: {},
  locks: { tech: {}, params: {} },   // groups and values Randomize / Shuffle must not change (UI side only)
  colors: { enabled: false },
  fonts: {},
});

/* the original (After Effects-implemented) sets, captured before any expression pack registers */
J.CORE_ORDER = { layout: J.LAYOUT_ORDER.slice(), enter: J.ENTER_ORDER.slice(), exit: J.EXIT_ORDER.slice(), hold: J.HOLD_ORDER.slice(), decor: J.DECOR_ORDER.slice() };

/* animation step length: 'koma' = drawings per second on a 24fps timebase (12 = on twos, 8 = on threes, 0 = every output frame) */
J.komaOf = fx => (fx.koma != null ? +fx.koma : (fx.onTwos === false ? 0 : 12));
J.stepDur = (fx, fps) => { const k = J.komaOf(fx); return k > 0 ? 1 / k : 1 / (fps || 24); };

/* ---------------- lyric parsing ---------------- */
J.parseLyrics = (raw) => {
  const lines = []; const meta = {};
  let pendingGap = false;
  const rows = String(raw || '').replace(/\r/g, '').split('\n');
  for (let ri = 0; ri < rows.length; ri++) {
    const s0 = rows[ri].trim();
    if (!s0) { if (lines.length) pendingGap = true; continue; }
    if (s0.startsWith('#')) continue;
    const mm = s0.match(/^\[(ti|ar|al|by|offset):(.*)\]$/i);
    if (mm) { meta[mm[1].toLowerCase()] = mm[2].trim(); continue; }
    let s = s0; const times = [];
    let m;
    while ((m = s.match(/^\[(\d+):(\d+(?:[.:]\d+)?)\]/))) { times.push(+m[1] * 60 + parseFloat(m[2].replace(':', '.'))); s = s.slice(m[0].length); }
    s = s.trim();
    // 間奏: [間奏] / [間奏 8] (8 seconds) — also [interlude] [inst] [间奏] [간주]; no lyrics, only background and decorations
    const im = s.match(/^\[\s*(間奏|间奏|interlude|instrumental|inst|간주)(?:\s*[:：]?\s*(\d+(?:\.\d+)?)\s*(?:s|sec|秒|초)?)?\s*\]$/i);
    if (im) {
      const base = { text: '', interlude: true, secs: im[2] ? parseFloat(im[2]) : null, note: null, impact: false, emph: [], manual: null, gapBefore: pendingGap, src: ri };
      pendingGap = false;
      if (times.length) times.forEach(t => lines.push(Object.assign({}, base, { lrc: t })));
      else lines.push(Object.assign({}, base, { lrc: null }));
      continue;
    }
    let note = null;
    const bar = s.indexOf('|');
    if (bar >= 0) { note = s.slice(bar + 1).trim() || null; s = s.slice(0, bar).trim(); }
    let impact = false;
    if (/[!！]$/.test(s) && s.length > 1 && /!$/.test(s)) { impact = true; s = s.slice(0, -1).trim(); }
    const emph = [];
    s = s.replace(/\*([^*]+)\*/g, (_, w) => { emph.push(w); return w; });
    let manual = null;
    if (s.includes('/')) {
      manual = s.split('/').map(x => x.trim()).filter(Boolean);
      const latin = manual.some(x => /[A-Za-z]/.test(x));
      s = manual.join(latin ? ' ' : '');
    }
    if (!s) continue;
    const base = { text: s, note, impact, emph, manual, gapBefore: pendingGap, src: ri };
    pendingGap = false;
    if (times.length) times.forEach(t => lines.push(Object.assign({}, base, { lrc: t })));
    else lines.push(Object.assign({}, base, { lrc: null }));
  }
  // LRC: order by time. A line without a tag (an interlude, a line added by hand) stays right after the line it
  // follows in the text — it used to be moved to the very end.
  if (lines.some(l => l.lrc != null)) {
    let key = -1, k = 0;
    lines.forEach(l => { if (l.lrc != null) { key = l.lrc; k = 0; l._key = l.lrc; } else l._key = key + 1e-6 * ++k; });
    lines.sort((a, b) => a._key - b._key);
    lines.forEach(l => { delete l._key; });
  }
  return { lines, meta };
};
/* the order the lyric lines had before v0.10 (untagged lines last) — used once to move saved per-line settings of old projects */
J.parseOrderV1 = (raw) => {
  const p = J.parseLyrics(raw), lines = p.lines.slice();
  if (!lines.some(l => l.lrc != null) || lines.every(l => l.lrc != null)) return null;
  const byRow = lines.map((l, i) => ({ l, i }));
  const old = byRow.slice().sort((a, b) => ((a.l.lrc ?? 1e9) - (b.l.lrc ?? 1e9)) || (a.l.src - b.l.src));
  return old.map(x => x.i);          // old index -> new index
};

/* ---------------- chunking (bunsetsu-ish) ---------------- */
const segmenters = {};   // one per lyric language (J.segLocale: ja / zh-Hant / zh-Hans / ko)
const segmenterOf = () => {
  if (typeof Intl === 'undefined' || !Intl.Segmenter) return null;
  const loc = J.segLocale ? J.segLocale() : 'ja';
  if (!(loc in segmenters)) { try { segmenters[loc] = new Intl.Segmenter(loc, { granularity: 'word' }); } catch (e) { segmenters[loc] = null; } }
  return segmenters[loc];
};
const segType = s => {
  if (/^\s+$/.test(s)) return 'S';
  if ([...s].every(c => J.isPunct(c))) return 'P';
  if ([...s].some(c => J.isKanji(c))) return 'K';
  if ([...s].every(c => J.isHira(c) || c === 'ー')) return 'H';
  if ([...s].every(c => J.isKata(c) || c === 'ー')) return 'T';
  if (/[A-Za-z0-9]/.test(s)) return 'L';
  return 'O';
};
J.segments = (text) => {
  const segmenter = segmenterOf();
  if (segmenter) return [...segmenter.segment(text)].map(x => x.segment);
  const out = []; let cur = '', ct = '';
  for (const c of text) {
    const t = segType(c);
    if (cur && t !== ct && !(ct === 'K' && t === 'H')) { out.push(cur); cur = ''; }
    cur += c; ct = t;
  }
  if (cur) out.push(cur);
  return out;
};
/* Latin / Hangul helpers: words are joined with a space, except right after a dash (never- + ending → never-ending) */
const WORDCH = /[A-Za-z\u00c0-\u024f0-9\uac00-\ud7af\u1100-\u11ff\u3130-\u318f]/;
J.isWordLike = t => /^[A-Za-z\u00c0-\u024f0-9\uac00-\ud7af'’.,!?‐–—-]+$/.test(t) && WORDCH.test(t);
J.joinWords = arr => {
  const latin = /[A-Za-z]/.test(arr.join('')), HG = /[\uac00-\ud7af]/;
  return arr.reduce((acc, w, i) => {
    if (!i) return w;
    if (/[-‐–—]$/.test(acc)) return acc + w;
    return acc + (latin || (HG.test([...acc].pop()) && HG.test([...w][0])) ? ' ' : '') + w;
  }, '');
};
/* mostly Latin letters (English, Indonesian, Vietnamese … lyrics) */
J.isLatinText = t => { const s = String(t || '').replace(/\s/g, ''); if (!s) return false; const n = (s.match(/[A-Za-z\u00c0-\u024f\u1e00-\u1eff]/g) || []).length; return n / [...s].length >= 0.6; };

J.chunkText = (text) => {
  const segs = J.segments(text);
  const chunks = []; let cur = null;
  const close = () => { if (cur && cur.s.trim()) chunks.push(cur.s.trim()); cur = null; };
  for (const sg of segs) {
    const t = segType(sg);
    if (t === 'S') { close(); continue; }
    if (t === 'P') { if (cur) cur.s += sg; else if (chunks.length) chunks[chunks.length - 1] += sg; else cur = { s: sg, k: 'P', hasH: false }; continue; }
    if (!cur) { cur = { s: sg, k: t, hasH: t === 'H' }; continue; }
    if (t === 'H') {
      const len = [...sg].length;
      if (len <= 3 || (cur.k !== 'H' && !cur.hasH) || (cur.k === 'H' && [...cur.s].length + len <= 4)) { cur.s += sg; cur.hasH = true; continue; }
      close(); cur = { s: sg, k: 'H', hasH: true }; continue;
    }
    if (t === 'K' && cur.k === 'K' && !cur.hasH && [...(cur.s + sg)].length <= 6) { cur.s += sg; continue; }
    if (t === 'T' && cur.k === 'T') { cur.s += sg; continue; }
    if (t === 'L' && cur.k === 'L') { cur.s += sg; continue; }
    close(); cur = { s: sg, k: t, hasH: t === 'H' };
  }
  close();
  // split very long chunks, merge lonely single kana
  const out = [];
  for (const c of chunks) {
    const n = [...c].length;
    if (n > 10 && J.isWordLike(c)) {
      // one long Latin / Hangul word: never cut inside it — only after its dashes (never-ending → never- / ending)
      const parts = c.split(/(?<=[-‐–—])(?=\S)/);
      if (parts.length > 1) parts.forEach(x => out.push(x)); else out.push(c);
    } else if (n > 10) { J.splitLines(c, Math.ceil(n / Math.ceil(n / 8))).split('\n').forEach(x => out.push(x)); }
    else out.push(c);
  }
  for (let i = out.length - 1; i > 0; i--) {
    if ([...out[i]].length === 1 && !J.isKanji(out[i])) { out[i - 1] += (WORDCH.test([...out[i - 1]].pop()) && WORDCH.test(out[i]) && !/[-‐–—]$/.test(out[i - 1]) ? ' ' : '') + out[i]; out.splice(i, 1); }
  }
  return out.length ? out : [text];
};

/* English lyrics: cut by short phrases, not word by word (a Japanese chunk holds about as much as 2–3 English words) */
J.phraseChunks = (words) => {
  const out = []; let cur = [], letters = 0;
  const flush = () => { if (cur.length) out.push(J.joinWords(cur)); cur = []; letters = 0; };
  for (const w of words) {
    const n = (w.match(/[A-Za-z\u00c0-\u024f0-9]/g) || []).length;
    cur.push(w); letters += n;
    if (letters >= 9 || cur.length >= 3 || /[,.;:!?]$/.test(w)) flush();
  }
  flush();
  // a lone short word at the end joins the previous phrase
  if (out.length >= 2 && out[out.length - 1].replace(/[^A-Za-z]/g, '').length <= 4) { const last = out.pop(); out[out.length - 1] = J.joinWords([out[out.length - 1], last]); }
  return out.length ? out : words;
};

/* ---------------- timing ---------------- */
J.computeTiming = (project, parsed, audio) => {
  const T = project.timing || {};
  const lines = parsed.lines;
  const beat = T.bpm > 0 ? 60 / T.bpm : 0;
  // fixed times: a hand-set time (typed, tapped, dragged) wins over the LRC tag; the rest is estimated
  const fixed = lines.map((l, i) => {
    const man = T.lineTimes && T.lineTimes[i] != null ? +T.lineTimes[i] : null;
    if (man != null && isFinite(man)) return Math.max(0, man);
    return l.lrc != null && isFinite(l.lrc) ? l.lrc : null;
  });
  // a fixed time may not go back past an earlier one (the saved value itself is left alone)
  let lastFix = -Infinity;
  for (let i = 0; i < fixed.length; i++) if (fixed[i] != null) { if (fixed[i] < lastFix + 0.05) fixed[i] = lastFix + 0.05; lastFix = fixed[i]; }
  const natural = i => {         // estimated length of line i
    const n = [...lines[i].text].length, L = lines[i];
    let d = L.interlude ? (L.secs > 0 ? L.secs : 4) : J.clamp(0.8 + n * 0.17, 1.3, 5.2) * (T.lineScale || 1);
    if (beat && !(L.interlude && L.secs > 0)) d = Math.max(2, Math.round(d / beat)) * beat;
    return d;
  };
  const gapOf = i => (i > 0 && i < lines.length && lines[i].gapBefore ? (beat ? beat * 2 : 0.8) : 0);
  const starts = new Array(lines.length);
  let i = 0, t = T.offset ?? 0.4;
  if (fixed.length && fixed[0] != null) t = fixed[0];
  while (i < lines.length) {
    if (fixed[i] != null) { starts[i] = fixed[i]; t = fixed[i]; i++; continue; }
    // a run of estimated lines [i, j) between the previous start and the next fixed time (if any)
    let j = i; while (j < lines.length && fixed[j] == null) j++;
    if (i === 0 && j < lines.length && t >= fixed[j]) t = 0;
    const from = i > 0 ? starts[i - 1] : t;
    // chained the same way as before (so plans without fixed times stay exactly the same)
    for (let k = i; k < j; k++) starts[k] = k > 0 ? starts[k - 1] + natural(k - 1) + gapOf(k) : t;
    if (j < lines.length) {
      // they must all start before the next fixed time: squeeze them into the room there is
      const room = fixed[j] - from, need = starts[j - 1] + natural(j - 1) + gapOf(j) - from;
      if (need > room) {
        const f = room > 0 ? room / need : 0;
        for (let k = i; k < j; k++) starts[k] = from + (starts[k] - from) * f;
      }
    }
    i = j;
  }
  const ends = starts.map((s, i) => {
    if (i < starts.length - 1) return Math.max(s + 0.35, starts[i + 1]);
    const n = [...lines[i].text].length, L = lines[i];
    let d = L.interlude ? (L.secs > 0 ? L.secs : 4) : J.clamp(0.8 + n * 0.17, 1.5, 5.2) * (T.lineScale || 1);
    if (beat && !(L.interlude && L.secs > 0)) d = Math.max(2, Math.round(d / beat)) * beat;
    return s + d;
  });
  let duration = (ends.length ? ends[ends.length - 1] : 3) + (T.tail ?? 0.9);
  if (audio && audio.duration && T.useAudioLength !== false) duration = Math.max(audio.duration, ends.length ? ends[ends.length - 1] + 0.2 : 1);
  return { starts, ends, duration };
};

/* ---------------- planning ---------------- */
const wkey = (obj, k, d = 1) => (obj && obj[k] != null ? obj[k] : d);

function cutTechOf(ov, k) {
  const t = (ov.cutTech && (ov.cutTech[k] || ov.cutTech[String(k)])) || {};
  const fromLay = ov.cutLayouts && (ov.cutLayouts[k] || ov.cutLayouts[String(k)]);
  return fromLay && !t.layout ? Object.assign({}, t, { layout: fromLay }) : t;
}

J.plan = (project, audio) => {
  const st = J.resolveStyle(project);
  const fx = Object.assign({}, J.defaultProject().fx, project.fx || {});
  const parsed = J.parseLyrics(project.lyrics);
  const title = project.title || parsed.meta.ti || '';
  const artist = project.artist || parsed.meta.ar || '';
  const tm = J.computeTiming(project, parsed, audio);
  // 文字整列: the lyrics appear 0.2 s before the voice (reading ahead feels in time)
  if (project.typeset) {
    const LEAD = 0.2;
    tm.starts = tm.starts.map(t => Math.max(0, t - LEAD));
    tm.ends = tm.ends.map((t, i) => Math.max(tm.starts[i] + 0.3, t - LEAD));
  }
  const [W, H] = J.designSize(project.aspect);
  // enabled map: anything not explicitly switched off is on (new pack entries appear enabled in old projects);
  // then the 追加分 / 和風 switches decide what random picks may use (a per-line override still works)
  const en = {};
  for (const g of J.GROUP_KEYS) { en[g] = {}; const src = (project.enabled || {})[g] || {}; for (const k of J.order(g)) en[g][k] = src[k] !== false && (!J.randomOk || J.randomOk(project, g, k)); }
  // 中央を空ける (キャラクター用): every cut is laid out in a side band — left / right on wide frames, top / bottom on tall
  // ones — alternating line by line; the centre keeps only the full-frame background and screen effects
  const zones = project.centerFree ? J.sideZones(W, H, project.centerDir) : null;
  // the lyric of every cut is split in two: the first half in band 0 (left / top), the second in band 1 (right / bottom)
  const zoneOf = () => (zones ? Object.assign({}, zones[0]) : null);
  if (zones && en.bg) en.bg.bigChar = false;               // the one background that draws the lyric itself (big, centred)
  const plan = {
    version: 1, generator: 'JIZURA', appVersion: '@VERSION@', title, artist, W, H, fps: project.fps || 24,
    duration: tm.duration, styleKey: project.style, style: st, fx, seed: project.seed,
    lines: [], cuts: [], events: [], beats: audio && audio.beats ? audio.beats.slice() : [],
    hud: fx.hud === 'on' ? true : fx.hud === 'off' ? false : !!st.hud,
    keyBg: J.keyMode ? J.keyMode(project) : null,   // 'green' | 'black' | null — 合成用の背景
    centerFree: !!zones, zones,
    typeset: !!project.typeset, unify: !!project.unify,
    lang: J.resolveLang ? J.resolveLang(project) : 'ja',   // 歌詞の言語 (auto → detected)
  };
  if (J.setLang) J.setLang(plan.lang);                     // chunking + measuring below use this language
  if (J.setTypeset) J.setTypeset(plan.typeset);
  const beats = plan.beats;
  const snap = (t) => {
    if (!beats.length || !(project.timing && project.timing.snap)) return t;
    let lo = 0, hi = beats.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (beats[mid] < t) lo = mid + 1; else hi = mid; }
    let best = t, bd = 0.13;
    for (const k of [lo - 1, lo]) if (k >= 0 && k < beats.length && Math.abs(beats[k] - t) < bd) { bd = Math.abs(beats[k] - t); best = beats[k]; }
    return best;
  };
  const history = [], bgHistory = [], fxHistory = [];
  let schemeIdx = 0;
  const nSchemes = st.schemes.length;
  const addEvent = (t, type, amp, dur) => plan.events.push({ t, type, amp, dur });
  const evOwner = new WeakMap(); Object.defineProperty(plan, 'evOwner', { value: evOwner });

  // title card
  const firstStart = tm.starts.length ? tm.starts[0] : 0;
  if (title && firstStart >= 1.1) {
    const rng = J.rng(J.h(project.seed, 999));
    plan.cuts.push(makeCut({ text: title, note: artist, lineText: title, line: -1, start: 0.1, end: firstStart - 0.04, layout: 'title', enter: rng.pick(['blur', 'type', 'wipe', 'assemble']), exit: rng.pick(['blur', 'drift', 'wipe']), hold: 'still', params: J.LAYOUTS.title.plan(rng, {}, st), decor: [], scheme: 0, seed: J.h(project.seed, 999, 1) }));
  }

  // 統一感: sections, repeated lines, キメ lines and the per-section palettes (see makeUnify below)
  const U = plan.unify ? makeUnify(parsed.lines, { st, en, fx, history, lang: plan.lang, seed: project.seed }) : null;
  parsed.lines.forEach((ln, li) => {
    const s = tm.starts[li], e = tm.ends[li];
    const ov = (project.overrides || {})[li] || {};
    const lineSeed = ov.lock && ov.lockedSeed != null ? ov.lockedSeed : J.h(project.seed, li + 1, ov.seed | 0);
    const rng = J.rng(lineSeed);
    if (ln.interlude) {                                    // [間奏]: background, decorations and screen effects only
      plan.lines.push({ index: li, src: ln.src, lrc: ln.lrc, text: '', interlude: true, secs: ln.secs, start: s, end: e, visEnd: e, note: null, impact: false, emph: [], chunks: [], seed: lineSeed });
      const bg = ov.bg && J.BG[ov.bg] ? ov.bg : pickBg(rng, st, en, fx, bgHistory); bgHistory.push(bg);
      const dur = e - s, showTitle = dur >= 6 && !!(title || artist);
      plan.cuts.push(makeCut({ text: '', lineText: '', line: li, start: s, end: e, layout: 'interlude', enter: 'blur', exit: 'blur', hold: 'still', inDur: 0.4, outDur: 0.4,
        params: { variant: 'quiet', showTitle, titleText: showTitle ? [title, artist].filter(Boolean).join('  /  ') : '' }, decor: Array.isArray(ov.decor) ? ov.decor.filter(id => J.DECOR[id]).map(id => decorParams(rng, id)) : pickDecor(rng, st, en, Object.assign({}, fx, { decor: Math.max(0.6, fx.decor) }), 'interlude', history),
        scheme: schemeIdx, seed: J.h(lineSeed, 405), bg, bgP: J.BG[bg] && J.BG[bg].plan ? J.BG[bg].plan(rng, st) : {}, cam: 'push', camP: {} }));
      if (en.fx == null || en.fx.chroma !== false) addEvent(s, 'chroma', 1 + fx.chroma, 0.25);
      for (let t = s + 1.2; t < e - 0.8; t += J.clamp(dur / 4, 1.6, 3.2)) {          // a few effect accents so a long interlude keeps moving
        const pick = pickFx(rng, st, en, fx, false, fxHistory, 'mid');
        if (pick) { const D2 = J.FXE[pick]; addEvent(t, pick, (D2.amp || 1) * 0.6, (D2.dur || 3) / 24); fxHistory.push(pick); }
      }
      return;
    }
    const n = [...ln.text.replace(/\s+/g, '')].length;
    const visEnd = Math.min(e, s + Math.max(3.6, n * 0.5 + 1.2));
    const D = visEnd - s;
    plan.lines.push({ index: li, src: ln.src, lrc: ln.lrc, text: ln.text, start: s, end: e, visEnd, note: ln.note, impact: ln.impact, emph: ln.emph, chunks: null, seed: lineSeed });
    const chunks = ln.manual || (plan.lang === 'en' ? J.phraseChunks(J.chunkText(ln.text)) : J.chunkText(ln.text));
    plan.lines[li].chunks = chunks;
    const L = J.lerp(1.3, 0.5, fx.density);
    let nC = Math.round(D / L);
    const maxC = chunks.length + (chunks.length >= 2 && D > 2.0 ? 1 : 0);
    nC = J.clamp(nC, 1, Math.max(1, maxC));
    const ovAny = Object.keys(ov).some(k2 => !['lock', 'lockedSeed', 'seed', 'cutTech', 'cutLayouts', 'cutQuiet', 'cutTime'].includes(k2));
    const kime = !!(U && U.kime.has(li) && !ov.cuts);
    if (ov.single || kime) nC = 1;
    if (zones) nC = Math.max(1, Math.min(nC, Math.floor(chunks.length / 2)));   // 中央を空ける: each cut is split in two, so keep ≥ 2 words per cut
    // カット数の指定 (per line): exactly that many cuts — chunks are split further when the line has fewer
    const fixedN = ov.cuts > 0 ? Math.min(12, ov.cuts | 0) : 0;
    let chunks2 = chunks;
    if (fixedN) { nC = fixedN; chunks2 = splitToCount(chunks, fixedN); }
    // groups of chunks
    let groups;
    const nG = Math.min(nC, chunks2.length);
    if (nG <= 1) groups = [ln.text];
    else groups = partition(chunks2, nG).map(g => J.joinWords(g));
    const recap = !fixedN && nC > groups.length && groups.length >= 2;
    let units = groups.map(g => ({ text: g, w: [...g].length + 1.6 }));
    if (recap) units.push({ text: ln.text, w: (units.reduce((a, u) => a + u.w, 0) / units.length) * 1.25, recap: true });
    // a locked line keeps its own cuts too (the cut count would otherwise follow the 細かさ slider or おまかせ)
    if (ov.lock && Array.isArray(ov.lockedCuts) && ov.lockedCuts.length && ov.lockedCuts.every(c => c && typeof c.utext === 'string' && ln.text.includes(c.utext.trim())))
      units = ov.lockedCuts.map(c => ({ text: c.utext, w: [...c.utext].length + 1.6, recap: !!c.recap }));
    const tot = units.reduce((a, u) => a + u.w, 0);
    // ロック: a locked line keeps exactly what it showed when it was locked (layouts, motion, decorations, colours,
    // accents) — rerolling other lines changes the shared "recently used" state, so the seed alone is not enough
    const lockSpecs = ov.lock && Array.isArray(ov.lockedCuts) && ov.lockedCuts.length === units.length
      && ov.lockedCuts.every((c, k2) => c && c.utext === units[k2].text && J.LAYOUTS[c.layout]) ? ov.lockedCuts : null;
    let acc = s; const bounds = [s];
    units.forEach((u, k) => { acc += D * u.w / tot; bounds.push(k === units.length - 1 ? visEnd : acc); });
    for (let k = 1; k < bounds.length - 1; k++) bounds[k] = J.clamp(snap(bounds[k]), bounds[k - 1] + 0.22, bounds[k + 1] - 0.22);
    // カットの開始時刻 (詳細モード): seconds from the line start, set by hand or by tapping — kept in order, 0.22 s apart
    if (ov.cutTime && typeof ov.cutTime === 'object') {
      const nb = bounds.length - 1;
      for (let k = 1; k < nb; k++) { const d = +ov.cutTime[k]; if (ov.cutTime[k] != null && isFinite(d)) bounds[k] = J.clamp(s + d, s + 0.22 * k, visEnd - 0.22 * (nb - k)); }
      for (let k = 1; k < nb; k++) if (bounds[k] < bounds[k - 1] + 0.22) bounds[k] = bounds[k - 1] + 0.22;
      for (let k = nb - 1; k >= 1; k--) if (bounds[k] > bounds[k + 1] - 0.22) bounds[k] = bounds[k + 1] - 0.22;
    }
    // scheme per line
    if (nSchemes > 1 && li > 0 && (U ? U.sectionStart(li) && rng.chance(0.25 + fx.bgSwitch) : rng.chance(fx.bgSwitch * (ln.impact ? 1.8 : 1)))) schemeIdx = (schemeIdx + 1 + rng.int(0, nSchemes - 2)) % nSchemes;
    const emphLine = ln.impact || ln.emph.length > 0;
    // background graphic: chosen per line, occasionally re-rolled per cut
    let lineBg = ov.bg && J.BG[ov.bg] ? ov.bg : pickBg(rng, st, en, fx, bgHistory);
    bgHistory.push(lineBg);
    let lineBgP = J.BG[lineBg] && J.BG[lineBg].plan ? J.BG[lineBg].plan(rng, st) : {};
    units.forEach((u, k) => {
      const cs = bounds[k], ce = bounds[k + 1], dur = ce - cs;
      const halves = zones ? splitHalf(u.text, plan.lang) : null;               // 中央を空ける: 「花が」｜「咲いた」
      const txt = halves ? halves[0] : u.text;
      const nn = Math.max(...(halves || [u.text]).map(t => [...t.replace(/\s+/g, '')].length));
      const emph = kime || ln.impact && (k === 0 || u.recap) || ln.emph.some(w => u.text.includes(w));
      const Z = zoneOf(li), LW = Z ? Z.w : W, LH = Z ? Z.h : H;       // the frame this cut is laid out in
      const UU = U && !ovAny ? U : null;                              // per-line settings always win over 統一感
      const tech = cutTechOf(ov, k);                                  // このカットだけの指定
      let layout = ov.layout && J.LAYOUTS[ov.layout] ? ov.layout : pickLayout(rng, st, en, nn, dur, history, emph, u.recap, LH > LW);
      if (UU) layout = UU.layout(li, layout, { nn, dur, emph, kime, rng, portrait: LH > LW, recap: u.recap });
      let enter = ov.enter && J.ENTER[ov.enter] ? ov.enter : pickEnter(rng, st, en, layout, dur, history, emph, nn);
      let exit = ov.exit && J.EXIT[ov.exit] ? ov.exit : pickExit(rng, st, en, layout, dur, k === units.length - 1, history);
      let hold = ov.hold && J.HOLD[ov.hold] ? ov.hold : pickHold(rng, en, fx, history);
      let weightGrow = false;
      if (UU) {
        enter = UU.enter(li, enter, { layout, dur, emph, kime, rng, nn });
        exit = UU.exit(li, exit, { layout, dur, kime, rng });
        hold = UU.hold(li, hold, { kime, rng });
        weightGrow = UU.weightGrow({ kime, nn, rng, dur });
        if (weightGrow) enter = UU.softEnter(enter, rng);
      }
      const durs = (en2, ex2) => {
        let a = J.clamp(dur * 0.36, 0.12, 0.6);
        if (en2 === 'type') a = J.clamp(nn * 0.055 + 0.1, 0.15, dur * 0.65);
        if (en2 === 'assemble') a = J.clamp(dur * 0.45, 0.22, 0.75);
        if (J.ENTER[en2] && J.ENTER[en2].inDur) a = J.ENTER[en2].inDur(dur, nn);
        if (en2 === 'cut') a = 0.12;
        let b = ex2 === 'cut' ? 0 : J.clamp(dur * 0.3, 0.14, 0.55);
        if (['explode', 'fall', 'drift'].includes(ex2)) b = J.clamp(dur * 0.38, 0.25, 0.7);
        if (J.EXIT[ex2] && J.EXIT[ex2].outDur) b = J.EXIT[ex2].outDur(dur, nn);
        if (a + b > dur * 0.92) { const f = dur * 0.92 / (a + b); a *= f; b *= f; }
        return [a, b];
      };
      let [inDur, outDur] = durs(enter, exit);
      let sch = schemeIdx;
      if (!U && nSchemes > 1 && k > 0 && rng.chance(0.12 * fx.bgSwitch)) sch = (schemeIdx + 1) % nSchemes;
      let LD = J.LAYOUTS[layout];
      let params = LD.plan(rng, { text: txt, n: nn, W: LW, H: LH, dur }, st);
      let decor = Array.isArray(ov.decor) ? ov.decor.filter(id => J.DECOR[id]).map(id => decorParams(rng, id)) : pickDecor(rng, st, en, fx, layout, history);
      let treat = ov.treat && J.TREAT[ov.treat] ? ov.treat : pickTreat(rng, st, en, fx, LD, emph, history);
      if (UU) { decor = UU.decor(li, decor, { layout, kime, rng }); treat = UU.treat(li, treat, { kime, rng, LD }); }
      let treatP = J.TREAT[treat].plan ? J.TREAT[treat].plan(rng, st) : {};
      if (!ov.bg && k > 0 && !U && rng.chance(0.18 * fx.bgSwitch + 0.04)) { lineBg = pickBg(rng, st, en, fx, bgHistory); lineBgP = J.BG[lineBg].plan ? J.BG[lineBg].plan(rng, st) : {}; }
      let bg = LD.busy && !(J.BG[lineBg] && J.BG[lineBg].subtle) ? 'none' : lineBg;
      let cam = ov.cam && J.CAMERA[ov.cam] ? ov.cam : pickCam(rng, st, en, fx, LD, emph, history);
      if (UU) cam = UU.cam(li, cam, { kime, emph, rng });
      let camP = J.CAMERA[cam].plan ? J.CAMERA[cam].plan(rng, st) : {};
      let cutSeed = J.h(lineSeed, k, 17);
      // 統一感: a line that comes back (サビ etc.) is shown exactly as the first time
      const again = UU ? UU.again(li, k, txt) : null;
      if (again) {
        ({ layout, enter, exit, hold, params, decor, treat, treatP, cam, camP, weightGrow } = again);
        sch = again.scheme; cutSeed = again.seed; LD = J.LAYOUTS[layout];
        if (again.bg && again.bg !== 'none') { bg = again.bg; lineBgP = again.bgP; lineBg = bg; }
        [inDur, outDur] = durs(enter, exit);
      }
      const LS = lockSpecs ? lockSpecs[k] : null;
      if (LS) {
        ({ layout, enter, exit, hold, params, decor, treat, treatP, cam, camP } = LS);
        if (!J.ENTER[enter]) enter = 'blur'; if (!J.EXIT[exit]) exit = 'blur'; if (!J.HOLD[hold]) hold = 'still';
        if (!J.TREAT[treat]) { treat = 'none'; treatP = {}; } if (!J.CAMERA[cam]) { cam = 'push'; camP = {}; }
        decor = (decor || []).filter(d => J.DECOR[d.id]);
        weightGrow = !!LS.weightGrow; sch = LS.scheme | 0; cutSeed = LS.seed; LD = J.LAYOUTS[layout];
        bg = LS.bg && J.BG[LS.bg] ? LS.bg : 'none'; if (bg !== 'none') { lineBg = bg; lineBgP = LS.bgP || {}; }
        inDur = LS.inDur; outDur = LS.outDur;
      }
      // このカットだけの指定: applied on top of the draw with its own random stream, so changing one cut never
      // shifts the other cuts (history below keeps what was drawn, as if nothing had been changed here)
      const drawn = { layout, enter, exit, hold, treat, cam, decor: decor.map(d => d.id) };
      let techBgP = null;
      if (tech.layout && J.LAYOUTS[tech.layout] && !J.LAYOUTS[tech.layout].special) {
        layout = tech.layout; LD = J.LAYOUTS[layout];
        try { params = LD.plan(J.rng(J.h(lineSeed, k, 91)), { text: txt, n: nn, W: LW, H: LH, dur }, st); } catch (e) {}
      }
      if (tech.enter && J.ENTER[tech.enter]) enter = tech.enter;
      if (tech.exit && J.EXIT[tech.exit]) exit = tech.exit;
      if (tech.hold && J.HOLD[tech.hold]) hold = tech.hold;
      if (tech.decor !== undefined) {
        if (!tech.decor || tech.decor === 'none' || !J.DECOR[tech.decor]) decor = [];
        else decor = [decorParams(J.rng(J.h(lineSeed, k, 92)), tech.decor)];
      }
      if (tech.treat && J.TREAT[tech.treat]) {
        treat = tech.treat;
        treatP = J.TREAT[treat].plan ? J.TREAT[treat].plan(J.rng(J.h(lineSeed, k, 93)), st) : {};
      }
      if (tech.bg && J.BG[tech.bg]) {
        bg = tech.bg;
        techBgP = J.BG[bg].plan ? J.BG[bg].plan(J.rng(J.h(lineSeed, k, 94)), st) : {};
      }
      if (tech.cam && J.CAMERA[tech.cam]) {
        cam = tech.cam;
        camP = J.CAMERA[cam].plan ? J.CAMERA[cam].plan(J.rng(J.h(lineSeed, k, 95)), st) : {};
      }
      if (tech.enter || tech.exit) {               // keep the (locked) durations unless the motions changed
        const [i2, o2] = durs(enter, exit);
        if (tech.enter && J.ENTER[tech.enter]) inDur = i2;
        if (tech.exit && J.EXIT[tech.exit]) outDur = o2;
      }
      // cut-to-cut transition (replaces the previous cut's exit and this cut's entrance)
      const prevCut = plan.cuts[plan.cuts.length - 1];
      let trans = null, transP = {}, transDur = 0, morph = null;
      const joinSaved = { enter, inDur, prevExit: prevCut && prevCut.exit, prevOut: prevCut && prevCut.outDur };
      // a locked line keeps its own exit: the next (unlocked) line may not replace it with a transition / morph
      const prevLockedOther = prevCut && prevCut.line !== li && !LS && ((project.overrides || {})[prevCut.line] || {}).lock;
      const canTrans = prevCut && Math.abs(prevCut.end - cs) < 0.06 && prevCut.layout !== 'interlude' && dur > 0.5 && !prevLockedOther;
      // 統一感: モーフ — the next part of the same line grows out of this one (shared characters glide, the rest melts)
      if (LS) {                                       // locked: the same join as before, when the cuts still touch
        if (canTrans && LS.morph) { morph = { dur: LS.morph.dur }; prevCut.exit = 'cut'; prevCut.outDur = 0; }
        else if (canTrans && LS.trans && J.TRANS[LS.trans]) { trans = LS.trans; transP = LS.transP || {}; transDur = LS.transDur; prevCut.exit = 'cut'; prevCut.outDur = 0; }
      } else if (canTrans && UU && k > 0 && !kime && (again ? again.morph : rng.chance(u.recap ? 0.85 : 0.4))) {
        morph = { dur: J.clamp(dur * 0.45, 0.28, 0.6) };
        enter = 'cut'; inDur = 0.12; prevCut.exit = 'cut'; prevCut.outDur = 0;
      } else if (canTrans && again && !ov.trans) {    // 統一感: a repeated line joins its cuts the same way as the first time
        if (again.trans && J.TRANS[again.trans]) {
          trans = again.trans; transP = again.transP || {}; transDur = again.transDur;
          enter = 'cut'; inDur = 0.12; prevCut.exit = 'cut'; prevCut.outDur = 0;
        }
      } else if (canTrans) {
        trans = ov.trans && J.TRANS[ov.trans] ? ov.trans : pickTrans(rng, st, en, fx, emph, history);
        if (trans && UU) trans = UU.trans(li, trans, { rng });
        if (trans) {
          const TD = J.TRANS[trans];
          transDur = J.clamp(TD.dur || 0.35, 0.12, Math.min(0.6, dur * 0.45));
          transP = TD.plan ? TD.plan(rng, st) : {};
          enter = 'cut'; inDur = 0.12;
          prevCut.exit = 'cut'; prevCut.outDur = 0;
        }
      }
      drawn.trans = trans;
      if (tech.trans === 'none') {                  // このカットだけ「つなぎなし」: undo the join
        if (trans || morph) { enter = joinSaved.enter; inDur = joinSaved.inDur; if (prevCut) { prevCut.exit = joinSaved.prevExit; prevCut.outDur = joinSaved.prevOut; } }
        trans = null; transP = {}; transDur = 0; morph = null;
      } else if (tech.trans && J.TRANS[tech.trans] && canTrans) {
        morph = null;
        trans = tech.trans;
        const TD = J.TRANS[trans];
        transDur = J.clamp(TD.dur || 0.35, 0.12, Math.min(0.6, dur * 0.45));
        transP = TD.plan ? TD.plan(J.rng(J.h(lineSeed, k, 96)), st) : {};
      }
      if (trans && canTrans) {
        enter = 'cut'; inDur = 0.12;
        prevCut.exit = 'cut'; prevCut.outDur = 0;
      }
      const cut = makeCut({ text: txt, lineText: ln.text, note: ln.note, line: li, start: cs, end: ce, layout, enter, exit, hold, inDur, outDur, params, decor, scheme: sch, seed: cutSeed, emph, recap: !!u.recap, words: J.chunkText(txt), stagger: rng.range(0.025, 0.06),
        treat, treatP, bg, bgP: techBgP || (bg === lineBg ? lineBgP : {}), cam, camP, trans, transP, transDur, zone: Z, utext: u.text });
      if (kime || (LS && LS.kime)) cut.kime = true;
      if (weightGrow) cut.weightGrow = true;
      if (morph) cut.morph = morph;
      if (UU) UU.remember(li, k, txt, cut);
      if (zones) splitCut(cut, halves, zones, st, dur, LS);
      // 文字整列: effects don't pile up — one decoration, no text treatment on top of it
      if (plan.typeset) { cut.decor = cut.decor.slice(0, 1); if (cut.decor.length && cut.treat !== 'none') { cut.treat = 'none'; cut.treatP = {}; } }
      plan.cuts.push(cut);
      const evMark = plan.events.length;
      // history = what the draw gave (with the usual join), so a per-cut pick never shifts the later cuts
      const hist = { layout, enter, exit, hold, treat, cam, trans, decor: decor.map(d => d.id) };
      for (const g of Object.keys(hist)) if (tech[g] !== undefined && drawn[g] !== undefined) hist[g] = g === 'enter' && drawn.trans ? 'cut' : drawn[g];
      history.push(hist);
      // events at cut start
      // events at cut start — durations are on a 24fps timebase so every output rate looks the same
      const g = fx.glitch * (st.glitchBoost || 1);
      const fxOn = k2 => en.fx == null || en.fx[k2] !== false;
      const F = 1 / 24;
      if (fxOn('chroma')) addEvent(cs, 'chroma', 1.4 + rng.range(0, 2) * fx.chroma + (emph ? 2.5 : 0), 0.25);
      if (fxOn('slice') && rng.chance(g * 0.5 + (emph ? 0.3 : 0))) addEvent(cs, 'slice', 0.6 + rng.range(0, 0.8) * g + (emph ? 0.5 : 0), rng.pick([2, 3, 4]) * F);
      if (fxOn('block') && rng.chance(g * 0.22)) addEvent(cs + rng.range(0, 0.05), 'block', 0.5 + g, rng.pick([2, 4]) * F);
      if (fxOn('shake') && (emph || rng.chance(fx.motion * 0.18))) addEvent(cs, 'shake', (emph ? 1 : 0.5) * fx.motion, 0.3);
      if (fxOn('flash') && fx.flash && (ln.impact && k === 0 || kime)) addEvent(cs, 'flash', 1, 3 * F);
      if (kime) {                                  // キメ: a hard accent where the line lands
        if (fxOn('zoom')) addEvent(cs, 'zoom', 1.1, 0.25);
        if (fxOn('shake')) addEvent(cs + 0.04, 'shake', 1.1 * Math.max(0.5, fx.motion), 0.35);
      }
      if (fxOn('invert') && rng.chance(0.035 * g)) addEvent(cs, 'invert', 1, 2 * F);
      if (fxOn('zoom') && (emph && rng.chance(0.6) || rng.chance(0.06 * fx.motion))) addEvent(cs, 'zoom', 0.7 + 0.5 * fx.motion, 0.22);
      if (fxOn('mosaic') && rng.chance(0.04 * g)) addEvent(cs, 'mosaic', 1, 3 * F);
      if (fxOn('slice') && dur > 0.8 && rng.chance(g * 0.4)) addEvent(cs + rng.range(0.35, 0.8) * dur, 'slice', 0.4 + g * 0.4, 2 * F);
      // the newer effect library: at most one per cut boundary (plus rare mid-cut accents)
      if (plan.cuts.length > 1 || k > 0 || li > 0) {
        const pick = pickFx(rng, st, en, fx, emph, fxHistory, 'edge');
        if (pick) { const D2 = J.FXE[pick]; const d = (D2.dur || 4) * F; addEvent(cs - (D2.pre ? D2.pre * F : 0), pick, (D2.amp || 1) * (0.7 + 0.5 * g + (emph ? 0.3 : 0)), d); fxHistory.push(pick); }
      }
      if (dur > 1.1) { const pick = pickFx(rng, st, en, fx, emph, fxHistory, 'mid'); if (pick) { const D2 = J.FXE[pick]; addEvent(cs + rng.range(0.4, 0.75) * dur, pick, (D2.amp || 1) * (0.5 + 0.4 * g), (D2.dur || 3) * F); } }
      if (LS && Array.isArray(LS.events)) { plan.events.splice(evMark); for (const e of LS.events) plan.events.push({ t: cs + e.dt, type: e.type, amp: e.amp, dur: e.dur }); }
      // 文字整列: at most one screen effect per cut besides the colour split (the キメ line keeps its accents)
      if (plan.typeset && !cut.kime && !LS) {
        const mine = plan.events.splice(evMark);
        let extra = 0;
        for (const e of mine) if (e.type === 'chroma' || e.type === 'shake' && emph || extra++ < 1) plan.events.push(e);
      }
      for (let q = evMark; q < plan.events.length; q++) evOwner.set(plan.events[q], cut);   // which cut each accent came from (for ロック)
    });
    // interlude in long gaps
    const nextStart = li < parsed.lines.length - 1 ? tm.starts[li + 1] : null;
    if (nextStart != null && nextStart - visEnd > 1.3 && !parsed.lines[li + 1].interlude) {
      const r2 = J.rng(J.h(lineSeed, 404));
      plan.cuts.push(makeCut({ text: title || '', lineText: '', line: li, start: visEnd, end: nextStart, layout: 'interlude', enter: 'blur', exit: 'blur', hold: 'still', inDur: 0.3, outDur: 0.3, params: J.LAYOUTS.interlude.plan(r2), decor: pickDecor(r2, st, en, Object.assign({}, fx, { decor: 1 }), 'interlude'), scheme: schemeIdx, seed: J.h(lineSeed, 405) }));
    }
  });
  plan.cuts.sort((a, b) => a.start - b.start);
  plan.cuts.forEach((c, i) => {
    c.index = i;
    if (!zones || c.zone) return;
    if (c.layout === 'interlude') { c.params = Object.assign({}, c.params, { showTitle: false }); return; }   // no lyric: the whole frame
    c.zone = zoneOf(c.line);
  });
  plan.events.sort((a, b) => a.t - b.t);
  plan.energy = audio && audio.energy ? audio.energy : null;
  plan.energyRate = audio && audio.energyRate ? audio.energyRate : 0;
  return plan;
};

/* ---------- 統一感 (unify): the conventions of a hand-made lyric video ----------
   · each part (a block between blank lines) keeps a small palette of layouts / motions / camera / decorations,
     so the part reads as one idea; a new part may bring a new palette and colour scheme
   · a line that comes back (サビ) is shown exactly as it was the first time
   · directional moves alternate (left ↔ right, up ↔ down), strong moves are kept for the lines that matter
   · キメ: lines ending in ! — or, when none is marked, the first line of a part that repeats — get one big cut
   · モーフ between the parts of a line, and 太さ (thin → bold) now and then */
const DIR_PAIRS = { enter: [['slideL', 'slideR'], ['riseMask', 'dropMask'], ['trackIn', 'trackOut'], ['flipX', 'flipY']],
  exit: [['slideOutL', 'slideOutR'], ['sinkMask', 'riseOut'], ['flipOutX', 'flipOutY']],
  cam: [['panL', 'panR'], ['tiltUp', 'tiltDown'], ['dollyIn', 'pullOut']] };
const STRONG = { enter: ['bounceBig', 'whip', 'spin', 'slingshot', 'crumple', 'stamp', 'zoom', 'glitchIn', 'scramble', 'spiralIn', 'rollIn', 'shuffle', 'windBlown', 'matrixRain', 'stopMotion', 'splitFlap'],
  cam: ['earthquake', 'shakeHard', 'crashZoom', 'barrelRoll', 'whipIn', 'snapPan', 'vertigo', 'roll', 'spiralIn', 'jelly', 'bounce', 'beatPunch', 'stepZoom'] };
const KIME = { layout: ['huge', 'huge', 'huge', 'columnsBig', 'columnsBig', 'halftoneBig', 'center'], enter: ['stamp', 'zoom', 'bounceBig', 'overexpose', 'slingshot', 'blur'],
  exit: ['zoomThrough', 'blur', 'shrink', 'zoomFar'], hold: ['still', 'pulse', 'heartbeat'], cam: ['beatPunch', 'crashZoom', 'dollyIn', 'push'] };
const SOFT_ENTER = ['blur', 'fadeStagger', 'trackIn', 'blurStagger', 'cut'];
function makeUnify(lines, C) {
  const { st, en, fx, history } = C;
  const norm = t => String(t || '').replace(/[\s、。，．,.!！?？…・「」『』（）()"'“”‘’~〜ー―-]/g, '');
  // sections
  const sec = [], starts = new Set([0]);
  let si = 0;
  lines.forEach((ln, i) => { if (i > 0 && (ln.gapBefore || ln.interlude || lines[i - 1].interlude)) { si++; starts.add(i); } sec.push(si); });
  // repeats
  const first = new Map(), repeatOf = [], count = new Map();
  lines.forEach((ln, i) => { const k = norm(ln.text); if (ln.interlude || k.length < 2) { repeatOf.push(null); return; } count.set(k, (count.get(k) || 0) + 1); if (first.has(k)) repeatOf.push(first.get(k)); else { first.set(k, i); repeatOf.push(null); } });
  // キメ
  const kime = new Set();
  lines.forEach((ln, i) => { if (ln.impact && !ln.interlude) kime.add(i); });
  if (!kime.size) lines.forEach((ln, i) => { if (starts.has(i) && !ln.interlude && (count.get(norm(ln.text)) || 0) >= 2) kime.add(i); });
  const ok = (g, k) => !!(k && en[g] && en[g][k] !== false && (g === 'layout' ? J.LAYOUTS[k] : g === 'enter' ? J.ENTER[k] : g === 'exit' ? J.EXIT[k] : g === 'hold' ? J.HOLD[k] : g === 'cam' ? J.CAMERA[k] : g === 'treat' ? J.TREAT[k] : g === 'trans' ? J.TRANS[k] : null));
  const pals = new Map(), last = new Map();
  const pal = i => { const s2 = sec[i]; if (!pals.has(s2)) pals.set(s2, { layout: [], enter: [], exit: [], hold: [], cam: [], decor: [], treat: [], trans: [] }); return pals.get(s2); };
  // keep up to max distinct picks per part; once full, mostly reuse them
  const sticky = (i, g, v, max, rng, fits = () => true, reuse = 0.85) => {
    const P = pal(i)[g];
    if (P.length >= max && rng.chance(reuse)) { const pool = P.filter(k => ok(g, k) && fits(k)); if (pool.length) return rng.pick(pool); }
    if (!P.includes(v) && P.length < max) P.push(v);
    return v;
  };
  // alternate directions within a part
  const alternate = (i, g, v) => {
    const key = sec[i] + ':' + g, prev = last.get(key);
    for (const pr of DIR_PAIRS[g] || []) {
      const j = pr.indexOf(v);
      if (j >= 0 && prev && pr.includes(prev)) { const w = pr[1 - pr.indexOf(prev)]; if (ok(g, w)) v = w; }
    }
    last.set(key, v);
    return v;
  };
  const strongRun = new Map();                 // was the previous cut of this part strong?
  const calm = (i, g, v, emph, repick, rng) => {
    const key = sec[i] + ':' + g;
    if (!emph && STRONG[g] && STRONG[g].includes(v) && (strongRun.get(key) || rng.chance(0.55))) {
      for (let t = 0; t < 4; t++) { const w = repick(); if (!STRONG[g].includes(w)) { v = w; break; } }
    }
    strongRun.set(key, !!(STRONG[g] && STRONG[g].includes(v)));
    return v;
  };
  const kimePick = (g, v, rng, fits = () => true) => { const pool = KIME[g].filter(k => ok(g, k) && fits(k)); return pool.length ? rng.pick(pool) : v; };
  const specs = new Map();
  return {
    kime,
    sectionStart: i => starts.has(i),
    layout(i, v, o) {
      const fits = k => J.LAYOUTS[k] && J.LAYOUTS[k].fits(o.nn) && (!o.portrait || J.LAYOUTS[k].portrait !== 0);
      if (o.kime) return kimePick('layout', v, o.rng, k => J.LAYOUTS[k].fits(o.nn));
      return sticky(i, 'layout', v, 3, o.rng, fits, 0.9);
    },
    enter(i, v, o) {
      if (o.kime) return kimePick('enter', v, o.rng);
      v = sticky(i, 'enter', v, 2, o.rng);
      v = calm(i, 'enter', v, o.emph, () => pickEnter(o.rng, st, en, o.layout, o.dur, history, false, o.nn), o.rng);
      return alternate(i, 'enter', v);
    },
    exit(i, v, o) { if (o.kime) return kimePick('exit', v, o.rng); return alternate(i, 'exit', sticky(i, 'exit', v, 2, o.rng)); },
    hold(i, v, o) { if (o.kime) return kimePick('hold', v, o.rng); return sticky(i, 'hold', v, 1, o.rng); },
    cam(i, v, o) {
      if (o.kime) return kimePick('cam', v, o.rng);
      v = sticky(i, 'cam', v, 2, o.rng);
      v = calm(i, 'cam', v, o.emph, () => pickCam(o.rng, st, en, fx, J.LAYOUTS.center, false, history), o.rng);
      return alternate(i, 'cam', v);
    },
    decor(i, list, o) {
      if (o.kime) return [];
      const P = pal(i).decor;
      if (P.length >= 2 && o.rng.chance(0.8)) { const id = o.rng.pick(P); return J.DECOR[id] ? [decorParams(o.rng, id)] : list; }
      for (const d of list) if (!P.includes(d.id) && P.length < 2) P.push(d.id);
      return list;
    },
    treat(i, v, o) { if (o.kime) return 'none'; return sticky(i, 'treat', v, 1, o.rng, () => true, 0.75); },
    trans(i, v, o) { return sticky(i, 'trans', v, 2, o.rng); },
    weightGrow(o) { if (!/^(ja|en)$/.test(C.lang || 'ja') || o.nn > 16 || o.dur < 0.7) return false; return o.rng.chance(o.kime ? 0.45 : 0.14); },
    softEnter(v, rng) { const pool = SOFT_ENTER.filter(k => ok('enter', k)); return pool.length ? rng.pick(pool) : v; },
    again(i, k, txt) { const f = repeatOf[i]; if (f == null) return null; const sp = (specs.get(f) || [])[k]; return sp && sp.text === txt ? sp : null; },
    remember(i, k, txt, cut) {
      if (!specs.has(i)) specs.set(i, []);
      specs.get(i)[k] = { text: txt, layout: cut.layout, enter: cut.enter, exit: cut.exit, hold: cut.hold, params: cut.params, decor: cut.decor, treat: cut.treat, treatP: cut.treatP,
        cam: cut.cam, camP: cut.camP, scheme: cut.scheme, seed: cut.seed, bg: cut.bg, bgP: cut.bgP, weightGrow: !!cut.weightGrow, morph: !!cut.morph,
        trans: cut.trans || null, transP: cut.transP, transDur: cut.transDur };
    },
  };
}

/* 中央を空ける: one scene, the lyric split in two — 「花が」 in the left (top) band, 「咲いた」 in the right (bottom) one.
   Both halves use the same layout, motion, decorations and camera (the same random draws), so it reads as one picture
   with the centre left for the character; the second half follows a beat later. */
function splitHalf(text, lang) {
  const t = String(text || '').trim();
  const n = [...t.replace(/\s+/g, '')].length;
  // between words, as near the middle as possible (「花が」｜「咲いた」, "Good night," | "see you tomorrow")
  const words = (lang === 'en' ? J.phraseChunks(J.chunkText(t)) : J.chunkText(t)).map(w => String(w));
  if (words.length >= 2) {
    const L = w => [...w.replace(/\s+/g, '')].length, total = words.reduce((a2, w) => a2 + L(w), 0);
    let acc = 0, best = 1, bd = 1e9;
    for (let k = 1; k < words.length; k++) { acc += L(words[k - 1]); const d = Math.abs(acc - total / 2); if (d < bd) { bd = d; best = k; } }
    const sep = /[A-Za-z]/.test(t) ? ' ' : '';
    return [words.slice(0, best).join(sep).trim(), words.slice(best).join(sep).trim()];
  }
  // one word: short ones (and single English words) stand on both sides; longer ones split near the middle
  if (n <= 3 || /^[A-Za-z0-9'’-]+$/.test(t)) return [t, t];
  const two = splitToCount([t], 2);
  if (two.length < 2) return [t, t];
  let a = two[0].trim(), b = two.slice(1).join('').trim();
  // a half never starts with a particle, punctuation or a small kana: 「夜明けの色を」｜「覚えてる」, not 「…色」｜「を…」
  for (let g = 0; g < 3 && b.length > 1 && HEAD_BAD.test(b[0]); g++) { a += b[0]; b = b.slice(1); }
  return [a, b];
}
const HEAD_BAD = /[、。，．,.!?！？…・ーっッゃゅょャュョぁぃぅぇぉァィゥェォをがはにでとのへもやよね」』）)]/;
function splitCut(cut, halves, zones, st, dur, LS) {
  const LD = J.LAYOUTS[cut.layout], seed = J.h(cut.seed, 23);
  const planFor = (text, z) => LD.plan(J.rng(seed), { text, n: [...text.replace(/\s+/g, '')].length, W: z.w, H: z.h, dur }, st);
  cut.text = halves[0]; cut.lineText = halves[0]; cut.words = J.chunkText(halves[0]); cut.zone = Object.assign({}, zones[0]);
  cut.params = LS && LS.params && LS.twinParams ? LS.params : planFor(halves[0], zones[0]);   // a locked line keeps its own
  const delay = Math.min(0.12, dur * 0.08);
  const twin = Object.assign({}, cut, { text: halves[1], lineText: halves[1], words: J.chunkText(halves[1]), zone: Object.assign({}, zones[1]), params: LS && LS.twinParams ? LS.twinParams : planFor(halves[1], zones[1]),
    start: cut.start + delay, bg: 'none', bgP: {}, companion: true, trans: null, transP: {}, transDur: 0, morph: cut.morph });
  twin.dur = twin.end - twin.start;
  delete twin.companion_; cut.companion = twin;
}

/* ロック: what a line shows, so it can be kept as it is (stored in project.overrides[line].lockedCuts) */
J.lineSnapshot = (plan, li) => {
  const cuts = plan.cuts.filter(c => c.line === li && c.utext != null);
  if (!cuts.length) return null;
  const S = JSON.parse(JSON.stringify(cuts.map(c => ({ utext: c.utext, layout: c.layout, enter: c.enter, exit: c.exit, hold: c.hold, inDur: c.inDur, outDur: c.outDur,
    params: c.params, decor: c.decor, treat: c.treat, treatP: c.treatP, bg: c.bg, bgP: c.bgP, cam: c.cam, camP: c.camP, scheme: c.scheme, seed: c.seed,
    trans: c.trans, transP: c.transP, transDur: c.transDur, morph: c.morph || null, weightGrow: !!c.weightGrow, kime: !!c.kime, recap: !!c.recap, twinParams: c.companion ? c.companion.params : null, events: [] }))));
  // each accent belongs to the cut it plays in (the ones just before a cut start belong to that cut)
  for (const e of plan.events) {
    // an accent belongs to the cut that made it — also one that plays after the line ends (an exit accent)
    const own = plan.evOwner && plan.evOwner.get(e);
    if (own) { const k = cuts.indexOf(own); if (k >= 0) S[k].events.push({ dt: +(e.t - cuts[k].start).toFixed(4), type: e.type, amp: e.amp, dur: e.dur }); continue; }
    let k = -1;
    // [start − 0.25, next start − 0.25): an accent just before the following cut belongs to that cut
    for (let j = 0; j < cuts.length; j++) { const until = j < cuts.length - 1 ? cuts[j + 1].start - 0.25 : cuts[j].end - 0.3; if (e.t >= cuts[j].start - 0.25 && e.t < until) k = j; }
    if (k >= 0) S[k].events.push({ dt: +(e.t - cuts[k].start).toFixed(4), type: e.type, amp: e.amp, dur: e.dur });
  }
  return S;
};

/* side bands for 中央を空ける: [a, b] in design pixels. Wide frames: left / right thirds (a little narrower on 21:9);
   tall frames: top / bottom; square-ish frames count as wide. */
J.sideZones = (W, H, dir) => {
  if (H > W * 1.1 && dir === 'lr') { const w = Math.round(W * 0.34); return [{ x: 0, y: 0, w, h: H, side: 'left' }, { x: W - w, y: 0, w, h: H, side: 'right' }]; }   // 縦長で左右に分ける
  if (H > W * 1.1) { const h = Math.round(H * 0.33); return [{ x: 0, y: 0, w: W, h, side: 'top' }, { x: 0, y: H - h, w: W, h, side: 'bottom' }]; }
  const w = Math.round(W * (W / H > 2 ? 0.3 : 0.36));
  return [{ x: 0, y: 0, w, h: H, side: 'left' }, { x: W - w, y: 0, w, h: H, side: 'right' }];
};

function makeCut(o) {
  const c = Object.assign({ hold: 'still', inDur: 0.3, outDur: 0.25, stagger: 0.04, decor: [], params: {}, scheme: 0, emph: false, words: [], note: null, treat: 'none', treatP: {}, bg: 'none', bgP: {}, cam: 'push', camP: {} }, o);
  c.dur = c.end - c.start;
  return c;
}
/* split chunks until there are at least n pieces (longest first: words for Latin text, characters otherwise) */
function splitToCount(chunks, n) {
  const out = chunks.slice();
  let guard = 0;
  while (out.length < n && guard++ < 64) {
    let bi = -1, bl = 1;
    out.forEach((c, i) => { const l = /\s/.test(c.trim()) ? c.trim().split(/\s+/).length : [...c].length; if (l > bl) { bl = l; bi = i; } });
    if (bi < 0) break;
    const c = out[bi].trim();
    let a, b;
    if (/\s/.test(c)) { const w = c.split(/\s+/), h = Math.ceil(w.length / 2); a = w.slice(0, h).join(' '); b = w.slice(h).join(' '); }
    else {
      // at a word boundary nearest the middle when there is one (夜明け|の), else between characters
      const ch = [...c], segs = J.segments ? J.segments(c) : [];
      let cut = Math.ceil(ch.length / 2);
      if (segs.length > 1) { let acc = 0, best = -1, bd = 1e9; for (let k = 0; k < segs.length - 1; k++) { acc += [...segs[k]].length; const d = Math.abs(acc - ch.length / 2); if (d < bd) { bd = d; best = acc; } } if (best > 0) cut = best; }
      a = ch.slice(0, cut).join(''); b = ch.slice(cut).join('');
    }
    out.splice(bi, 1, a, b);
  }
  return out;
}
function partition(chunks, k) {
  const lens = chunks.map(c => [...c].length + 1);
  const tot = lens.reduce((a, b) => a + b, 0), target = tot / k;
  const groups = []; let cur = [], acc = 0, remainingGroups = k;
  chunks.forEach((c, i) => {
    const remainingChunks = chunks.length - i;
    if (cur.length && (acc + lens[i] / 2 > target || remainingChunks < remainingGroups) && groups.length < k - 1) { groups.push(cur); cur = []; acc = 0; remainingGroups--; }
    cur.push(c); acc += lens[i];
  });
  if (cur.length) groups.push(cur);
  return groups;
}
function novelty(history, key, val) {
  let w = 1;
  for (let i = history.length - 1, d = 0; i >= 0 && d < 6; i--, d++) if (history[i][key] === val) w *= d < 2 ? 0.2 : 0.6;
  return w;
}
const PORTRAIT_W = { vcols: 1.9, condensed: 1.3, huge: 1.3, center: 1.2, stack: 1.1, mixed: 0.7, marquee: 0.6, wave: 0.6, diag: 0.8, type: 0.8, gloss: 0.5 };
function pickLayout(rng, st, en, n, dur, history, emph, recap, portrait) {
  const cands = [];
  for (const k of J.LAYOUT_ORDER) {
    const L = J.LAYOUTS[k];
    if (!en.layout[k] || !L.fits(n)) continue;
    let w = wkey(st.bias.layout, k, L.w ?? 1) * novelty(history, 'layout', k);
    if (portrait) w *= L.portrait != null ? L.portrait : wkey(PORTRAIT_W, k, 1);
    if (emph && L.emph) w *= L.emph;
    if (emph && ['huge', 'center', 'tile', 'marquee', 'condensed'].includes(k)) w *= 2;
    if (recap && ['center', 'stack', 'marquee', 'tile', 'mixed', 'type', 'gloss'].includes(k)) w *= 1.8;
    if (dur < 0.5 && ['wave', 'ring', 'labels', 'gloss', 'type', 'tile'].includes(k)) w *= 0.3;
    if (dur < 0.5 && ['center', 'huge', 'condensed', 'vcols'].includes(k)) w *= 1.4;
    cands.push([k, w]);
  }
  if (!cands.length) return 'center';
  return rng.wpick(cands);
}
const LAYOUT_ENTER = {
  type: { type: 4, scramble: 1.5 }, ring: { pop: 2, spin: 2, cut: 1, assemble: 0.4, slice: 0.2, wipe: 0.2 }, labels: { cut: 3, pop: 1 },
  wave: { pop: 1.5, drop: 1.5, blur: 1, slice: 0.3 }, tile: { assemble: 1.3, slice: 1.4, zoom: 1.4 }, huge: { zoom: 1.5, wipe: 1.5, slice: 1.4, stretch: 1.3, type: 0.2 },
  mixed: { pop: 1.6, drop: 1.6, spin: 1.3 }, scatter: { pop: 1.5, spin: 1.5, drop: 1.2, assemble: 1.3 }, vcols: { assemble: 1.8, type: 1.2 }, pill: { wipe: 1.8, type: 1.2 },
};
function pickEnter(rng, st, en, layout, dur, history, emph, n) {
  const cands = [];
  for (const k of J.ENTER_ORDER) {
    if (!en.enter[k]) continue;
    const D = J.ENTER[k]; if (!D) continue;
    const LD = J.LAYOUTS[layout] || {};
    let w = wkey(st.bias.enter, k, D.w ?? 1) * novelty(history, 'enter', k) * wkey(LAYOUT_ENTER[layout] || LD.enterBias, k, 1);
    if (D.minDur && dur < D.minDur) w *= 0.15;
    if (D.maxChars && n > D.maxChars) w *= 0.2;
    if (k === 'cut') w *= 0.5;
    if (dur < 0.45 && ['type', 'assemble', 'drop', 'spin', 'pop', 'flicker'].includes(k)) w *= 0.25;
    if (dur < 0.45 && ['cut', 'slice', 'zoom', 'stretch'].includes(k)) w *= 1.8;
    if (k === 'type' && n > 18) w *= 0.3;
    if (emph && ['zoom', 'assemble', 'slice'].includes(k)) w *= 1.8;
    cands.push([k, w]);
  }
  return cands.length ? rng.wpick(cands) : 'cut';
}
function pickExit(rng, st, en, layout, dur, lastOfLine, history) {
  const cands = [];
  for (const k of J.EXIT_ORDER) {
    if (!en.exit[k]) continue;
    const D = J.EXIT[k]; if (!D) continue;
    let w = wkey(st.bias.exit, k, D.w ?? 1) * novelty(history, 'exit', k);
    if (D.minDur && dur < D.minDur) w *= 0.15;
    if (k === 'cut') w *= dur < 0.6 ? 4 : lastOfLine ? 1.2 : 2.2;
    if (dur < 0.6 && k !== 'cut') w *= 0.4;
    if (['labels', 'ring', 'tile'].includes(layout) && ['explode', 'fall', 'drift'].includes(k)) w *= 0.3;
    cands.push([k, w]);
  }
  return cands.length ? rng.wpick(cands) : 'cut';
}
const HOLD_W = { still: 1, jitter: 1.2, drift: 1, breathe: 0.7, wave: 0.4, glitchtick: 0.9 };
function pickHold(rng, en, fx, history) {
  const cands = J.HOLD_ORDER.filter(k => en.hold[k] !== false && J.HOLD[k]).map(k => {
    const D = J.HOLD[k];
    let w = HOLD_W[k] != null ? HOLD_W[k] : (D.w ?? 0.8);
    if (k === 'jitter' || (D.tags && D.tags.includes('glitch'))) w *= 0.4 + fx.motion;
    if (k === 'glitchtick') w *= fx.glitch;
    return [k, w * novelty(history, 'hold', k)];
  });
  return cands.length ? rng.wpick(cands) : 'still';
}
function decorParams(rng, k) {
  return { id: k, seed: rng.int(1, 1e9), n: rng.int(1, 3) + (k === 'shapes' ? 3 : 0) + (k === 'sparks' ? 4 : 0), right: rng.chance(0.5), low: rng.chance(0.5), accent: rng.chance(0.4), corner: rng.chance(0.5), big: rng.chance(0.4), mode: rng.pick(['count', 'index']), from: rng.int(0, 20), to: rng.int(30, 999), v: rng.int(0, 5), r: rng() };
}
function pickDecor(rng, st, en, fx, layout, history = []) {
  const count = Math.round(fx.decor * 2.8 * rng.range(0.45, 1.15));
  const recent = new Set(history.slice(-2).flatMap(h => h.decor || []));
  const LD = J.LAYOUTS[layout] || {};
  const cands = J.DECOR_ORDER.filter(k => en.decor[k] && J.DECOR[k] && !(LD.busy && J.DECOR[k].layer === 'back' && !J.DECOR[k].subtle))
    .map(k => [k, wkey(st.decor, k, J.DECOR[k].w != null ? J.DECOR[k].w * 0.5 : 0.35) * (recent.has(k) ? 0.35 : 1)]);
  const out = [];
  for (let i = 0; i < count && cands.length; i++) {
    const k = rng.wpick(cands);
    cands.splice(cands.findIndex(c => c[0] === k), 1);
    out.push(decorParams(rng, k));
  }
  return out;
}
// text treatment: plain most of the time; the "decor" slider raises how often a treatment is used
function pickTreat(rng, st, en, fx, LD, emph, history) {
  if (LD.treat === false) return 'none';
  if (!rng.chance(0.18 + 0.42 * (fx.decor ?? 0.5) + (emph ? 0.15 : 0))) return 'none';
  const cands = J.TREAT_ORDER.filter(k => k !== 'none' && en.treat && en.treat[k] !== false && J.TREAT[k] && (LD.treat !== 'safe' || J.TREAT[k].safe))
    .map(k => [k, wkey(st.bias && st.bias.treat, k, J.TREAT[k].w ?? 1) * novelty(history, 'treat', k)]);
  return cands.length ? rng.wpick(cands) : 'none';
}
function pickBg(rng, st, en, fx, bgHist) {
  if (!rng.chance(0.2 + 0.35 * (fx.decor ?? 0.5) + 0.2 * (fx.bgSwitch ?? 0.35))) return 'none';
  const last = bgHist.slice(-3);
  const cands = J.BG_ORDER.filter(k => k !== 'none' && en.bg && en.bg[k] !== false && J.BG[k])
    .map(k => [k, wkey(st.bias && st.bias.bg, k, J.BG[k].w ?? 1) * (last.includes(k) ? 0.25 : 1)]);
  return cands.length ? rng.wpick(cands) : 'none';
}
function pickCam(rng, st, en, fx, LD, emph, history) {
  const cands = J.CAMERA_ORDER.filter(k => en.cam && en.cam[k] !== false && J.CAMERA[k]).map(k => {
    const D = J.CAMERA[k];
    let w = wkey(st.bias && st.bias.cam, k, D.w ?? 1) * novelty(history, 'cam', k);
    if (D.strong) w *= 0.25 + 0.9 * (fx.motion ?? 0.7) + (emph ? 0.6 : 0);
    if (LD.cam === false && k !== 'push') w *= 0.05;
    return [k, w];
  });
  return cands.length ? rng.wpick(cands) : 'push';
}
function pickTrans(rng, st, en, fx, emph, history) {
  if (!J.TRANS_ORDER.length) return null;
  if (!rng.chance(0.1 + 0.22 * (fx.motion ?? 0.7) + (emph ? 0.08 : 0))) return null;
  const cands = J.TRANS_ORDER.filter(k => en.trans && en.trans[k] !== false && J.TRANS[k])
    .map(k => [k, wkey(st.bias && st.bias.trans, k, J.TRANS[k].w ?? 1) * novelty(history, 'trans', k)]);
  return cands.length ? rng.wpick(cands) : null;
}
// kind 'edge' = transition at a cut boundary, 'mid' = accent in the middle of a cut
function pickFx(rng, st, en, fx, emph, fxHist, kind) {
  const g = fx.glitch ?? 0.55;
  const p = kind === 'edge' ? 0.12 + 0.38 * g + 0.12 * (fx.motion ?? 0.7) + (emph ? 0.15 : 0) : 0.05 + 0.2 * g;
  if (!rng.chance(p)) return null;
  const last = fxHist.slice(-3);
  const cands = J.FXE_ORDER.filter(k => { const D = J.FXE[k]; return D && !D.builtin && en.fx && en.fx[k] !== false && (kind === 'edge' ? D.edge !== false : D.mid); })
    .map(k => { const D = J.FXE[k]; let w = wkey(st.bias && st.bias.fx, k, D.w ?? 1) * (last.includes(k) ? 0.2 : 1); if (D.glitchy) w *= 0.3 + g * 1.4; return [k, w]; });
  return cands.length ? rng.wpick(cands) : null;
}

/* one-cut (or two-cut, for transitions) plan used by the 手法 tab thumbnails */
J.previewPlan = (project, group, key) => {
  const enUI = typeof document !== 'undefined' && document.documentElement && document.documentElement.lang === 'en';
  const st = J.resolveStyle(project);
  const fx = Object.assign({}, J.defaultProject().fx, project.fx || {}, {
    glitch: group === 'fx' ? 0.85 : 0,
    chroma: group === 'fx' ? 0.9 : 0.22,
    flash: false, hud: 'off', texture: 0.3, bgSwitch: 0, motion: 0.75,
    decor: group === 'decor' ? 1 : 0,
  });
  const [W, H] = J.designSize(project.aspect || '16:9');
  const rng = J.rng(J.h(J.sid(String(group) + ':' + String(key)), 11, 22));
  let text = enUI ? 'Lyric' : '字面';
  if (group === 'layout') {
    const L0 = J.LAYOUTS[key];
    const n2 = [...text.replace(/\s+/g, '')].length;
    if (L0 && L0.fits && !L0.fits(n2)) text = enUI ? 'color of dawn' : '夜明けの色を';
    if (L0 && L0.fits && !L0.fits([...text.replace(/\s+/g, '')].length)) text = enUI ? 'I remember the color of dawn' : '夜明けの色を覚えてる';
  }
  const nn = [...text.replace(/\s+/g, '')].length;
  const dur = 2.4;
  let layout = group === 'layout' ? key : 'center';
  if (!J.LAYOUTS[layout] || J.LAYOUTS[layout].special) layout = 'center';
  let enter = group === 'enter' ? key : 'cut';
  let exit = group === 'exit' ? key : 'cut';
  let hold = group === 'hold' ? key : 'still';
  if (!J.ENTER[enter]) enter = 'cut';
  if (!J.EXIT[exit]) exit = 'cut';
  if (!J.HOLD[hold]) hold = 'still';
  if (group === 'layout' || group === 'decor' || group === 'treat' || group === 'bg') {
    if (enter === 'cut' && J.ENTER.pop) enter = 'pop';
    if (hold === 'still' && J.HOLD.breathe) hold = 'breathe';
    else if (hold === 'still' && J.HOLD.drift) hold = 'drift';
  }
  const LD = J.LAYOUTS[layout];
  let params = {};
  try { params = LD.plan(rng, { text, n: nn, W, H, dur }, st) || {}; } catch (e) { params = {}; }
  let inDur = enter === 'cut' ? 0.12 : 0.5;
  if (J.ENTER[enter] && J.ENTER[enter].inDur) try { inDur = J.ENTER[enter].inDur(dur, nn); } catch (e) {}
  let outDur = exit === 'cut' ? 0 : 0.5;
  if (J.EXIT[exit] && J.EXIT[exit].outDur) try { outDur = J.EXIT[exit].outDur(dur, nn); } catch (e) {}
  if (inDur + outDur > dur * 0.85) { const f = dur * 0.85 / Math.max(0.2, inDur + outDur); inDur *= f; outDur *= f; }
  const decor = (group === 'decor' && J.DECOR[key]) ? [decorParams(rng, key)] : [];
  let treat = group === 'treat' ? key : 'none';
  if (!J.TREAT[treat]) treat = 'none';
  const treatP = (J.TREAT[treat] && J.TREAT[treat].plan) ? (J.TREAT[treat].plan(rng, st) || {}) : {};
  let bg = group === 'bg' ? key : 'none';
  if (!J.BG[bg]) bg = 'none';
  const bgP = (J.BG[bg] && J.BG[bg].plan) ? (J.BG[bg].plan(rng, st) || {}) : {};
  let cam = group === 'cam' ? key : 'push';
  if (!J.CAMERA[cam]) cam = 'push';
  const camP = (J.CAMERA[cam] && J.CAMERA[cam].plan) ? (J.CAMERA[cam].plan(rng, st) || {}) : {};
  const events = [];
  if (group === 'fx' && J.FXE[key]) {
    const D2 = J.FXE[key];
    events.push({ t: 0.04, type: key, amp: (D2.amp || 1.15) * 1.2, dur: ((D2.dur || 6) / 24) });
  }
  const cuts = [];
  if (group === 'trans' && J.TRANS[key]) {
    const TD = J.TRANS[key];
    const transDur = J.clamp(TD.dur || 0.35, 0.18, 0.7);
    const transP = TD.plan ? (TD.plan(rng, st) || {}) : {};
    const tA = enUI ? 'BEFORE' : '前のカット';
    const tB = enUI ? 'AFTER' : '字面';
    let pA = {}, pB = {};
    try { pA = J.LAYOUTS.center.plan(rng, { text: tA, n: [...tA].length, W, H, dur: 1.2 }, st) || {}; } catch (e) {}
    try { pB = J.LAYOUTS.center.plan(rng, { text: tB, n: [...tB].length, W, H, dur: 1.2 }, st) || {}; } catch (e) {}
    cuts.push(makeCut({ text: tA, lineText: tA, line: 0, start: 0, end: 1.2, layout: 'center', enter: 'cut', exit: 'cut', hold: 'still', inDur: 0.12, outDur: 0, params: pA, decor: [], scheme: 0, seed: 1, words: J.chunkText(tA) }));
    cuts.push(makeCut({ text: tB, lineText: tB, line: 1, start: 1.2, end: 2.4, layout: 'center', enter: 'cut', exit: 'cut', hold: 'still', inDur: 0.12, outDur: 0, params: pB, decor: [], scheme: Math.min(1, st.schemes.length - 1), seed: 2, words: J.chunkText(tB), trans: key, transP, transDur }));
  } else {
    cuts.push(makeCut({
      text, lineText: text, line: 0, start: 0, end: dur, layout, enter, exit, hold, inDur, outDur,
      params, decor, scheme: 0, seed: J.h(J.sid(String(key)), 9), words: J.chunkText(text),
      treat, treatP, bg, bgP, cam, camP, stagger: 0.04,
    }));
  }
  cuts.forEach((c, i) => { c.index = i; });
  return {
    version: 1, generator: 'JIZURA-preview', title: '', artist: '', W, H, fps: 24,
    duration: cuts[cuts.length - 1].end, styleKey: project.style, style: st, fx,
    lines: [], cuts, events, beats: [], hud: false, keyBg: null,
  };
};

J.designSize = (aspect) => {
  if (aspect === '9:16') return [1080, 1920];
  if (aspect === '1:1') return [1440, 1440];
  if (aspect === '4:5') return [1440, 1800];
  if (aspect === '21:9') return [2520, 1080];
  if (aspect === '4:3') return [1440, 1080];
  if (aspect === '3:4') return [1080, 1440];
  return [1920, 1080];
};
J.outputSize = (project) => {
  const [W, H] = J.designSize(project.aspect);
  const k = (project.res || 1080) / Math.min(W, H);
  return [Math.round(W * k / 2) * 2, Math.round(H * k / 2) * 2];
};
})();


// Upstream src/09_render.js
/* ============================================================
   JIZURA — frame renderer: background, chroma passes, HUD, post FX
   ============================================================ */
(() => {
'use strict';
const E = J.E;

const mk = (w, h) => { const c = document.createElement('canvas'); c.width = Math.max(1, w | 0); c.height = Math.max(1, h | 0); return c; };

J.cutAt = (plan, t) => {
  const cs = plan.cuts; let lo = 0, hi = cs.length - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (cs[m].start <= t) { ans = m; lo = m + 1; } else hi = m - 1; }
  if (ans < 0) return null;
  const c = cs[ans];
  return t < c.end ? c : null;
};

class Renderer {
  constructor() {
    this.scratch = mk(2, 2); this.small = mk(2, 2); this.tiny = mk(2, 2);
    this.grain = [];
    for (let k = 0; k < 4; k++) {
      const g = mk(256, 256), x = g.getContext('2d'), id = x.createImageData(256, 256);
      for (let i = 0; i < id.data.length; i += 4) { const v = Math.random() * 255; id.data[i] = id.data[i + 1] = id.data[i + 2] = v; id.data[i + 3] = 255; }
      x.putImageData(id, 0, 0); this.grain.push(g);
    }
    const sl = mk(1, 4), sx = sl.getContext('2d'); sx.fillStyle = '#fff'; sx.fillRect(0, 0, 1, 4); sx.fillStyle = '#000'; sx.fillRect(0, 3, 1, 1);
    this.scan = sl;
    this.paperCache = new Map();
    this.filterOK = (() => { try { const c = mk(4, 4).getContext('2d'); c.filter = 'blur(2px)'; return c.filter === 'blur(2px)'; } catch (e) { return false; } })();
  }

  paper(W, H) {
    const key = W + 'x' + H;
    let p = this.paperCache.get(key);
    if (p) return p;
    const w = Math.round(W / 2), h = Math.round(H / 2);
    p = mk(w, h); const x = p.getContext('2d');
    x.fillStyle = '#fff'; x.fillRect(0, 0, w, h);
    const lo = mk(Math.ceil(w / 24), Math.ceil(h / 24)), lx = lo.getContext('2d'), ld = lx.createImageData(lo.width, lo.height);
    for (let i = 0; i < ld.data.length; i += 4) { const v = 225 + Math.random() * 30; ld.data[i] = v; ld.data[i + 1] = v - 2; ld.data[i + 2] = v - 6; ld.data[i + 3] = 255; }
    lx.putImageData(ld, 0, 0);
    x.imageSmoothingEnabled = true; x.globalAlpha = 0.9; x.drawImage(lo, 0, 0, w, h); x.globalAlpha = 1;
    const id = x.getImageData(0, 0, w, h);
    for (let i = 0; i < id.data.length; i += 4) { const n = (Math.random() - 0.5) * 22; id.data[i] += n; id.data[i + 1] += n; id.data[i + 2] += n; }
    x.putImageData(id, 0, 0);
    x.strokeStyle = 'rgba(120,110,100,0.18)'; x.lineWidth = 0.7;
    for (let i = 0; i < 900; i++) { const X = Math.random() * w, Y = Math.random() * h, a = Math.random() * J.TAU, L = 4 + Math.random() * 14; x.beginPath(); x.moveTo(X, Y); x.quadraticCurveTo(X + Math.cos(a + 0.5) * L / 2, Y + Math.sin(a + 0.5) * L / 2, X + Math.cos(a) * L, Y + Math.sin(a) * L); x.stroke(); }
    x.fillStyle = 'rgba(60,50,40,0.25)';
    for (let i = 0; i < 1400; i++) { x.fillRect(Math.random() * w, Math.random() * h, Math.random() * 1.6, Math.random() * 1.6); }
    this.paperCache.set(key, p);
    return p;
  }

  ensure(c, w, h) { if (c.width !== w || c.height !== h) { c.width = w; c.height = h; } return c; }

  /* main entry: draw frame at time t into ctx (canvas px = design * scale) */
  frame(ctx, plan, t, opt = {}) {
    const W = plan.W, H = plan.H, scale = opt.scale || 1;
    const cw = ctx.canvas.width, ch = ctx.canvas.height;
    const fx = plan.fx, st = plan.style, fps = plan.fps;
    // motion is quantised to 'koma' drawings per second (24fps timebase); random flicker runs on a <=24Hz clock
    const stepDur = J.stepDur(fx, fps);
    const clock = J.komaOf(fx) > 0 ? stepDur : 1 / 24;
    const tq = Math.floor(t / stepDur + 1e-6) * stepDur;
    const mainCut = J.cutAt(plan, tq);
    const sc = st.schemes[mainCut ? mainCut.scheme % st.schemes.length : 0] || st.schemes[0];
    const allowFilter = this.filterOK && !opt.fast;
    if (J.setLang) J.setLang(plan.lang || 'ja');           // faces follow the plan's lyric language
    if (J.setTypeset) J.setTypeset(plan.typeset);          // 文字整列
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1; ctx.filter = 'none';
    ctx.clearRect(0, 0, cw, ch);
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    // ---------- background ----------
    const key = plan.keyBg && J.KEY_BG && J.KEY_BG[plan.keyBg] ? plan.keyBg : null;   // 合成用: white-on-black, finished in keyFinish()
    if (key && !opt.transparent) { ctx.fillStyle = '#000000'; ctx.fillRect(0, 0, W, H); }
    else if (!opt.transparent) {
      ctx.fillStyle = sc.bg; ctx.fillRect(0, 0, W, H);
      const g = ctx.createRadialGradient(W / 2, H * 0.45, 0, W / 2, H / 2, Math.hypot(W, H) * 0.6);
      const lift = J.lum(sc.bg) < 0.5 ? 'rgba(255,255,255,0.045)' : 'rgba(255,255,255,0.10)';
      g.addColorStop(0, lift); g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
      const paperAmt = (sc.paper ? 1 : st.texture.paper || 0) * (fx.texture ?? 0.6);
      if (paperAmt > 0.02) {
        ctx.globalCompositeOperation = J.lum(sc.bg) < 0.4 ? 'screen' : 'multiply';
        ctx.globalAlpha = J.lum(sc.bg) < 0.4 ? paperAmt * 0.06 : paperAmt * 0.85;
        if (J.lum(sc.bg) < 0.4) ctx.filter = 'invert(1)';
        ctx.drawImage(this.paper(W, H), 0, 0, W, H);
        ctx.filter = 'none'; ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
      }
    }
    // ---------- camera & chroma amounts ----------
    const u = H / 1080;
    const events = plan.events;
    let spike = 0, shake = 0, beatPulse = 0;
    for (let i = 0; i < events.length; i++) {
      const ev = events[i]; if (ev.t > t) break; const dt = (t - ev.t) * 24;
      if (dt > 14) continue;
      if (ev.type === 'chroma') spike += ev.amp * Math.pow(0.55, dt);
      else if (ev.type === 'shake') shake += ev.amp * Math.pow(0.62, dt);
    }
    if (plan.beats && plan.beats.length) {
      const b = prevBeat(plan.beats, t);
      if (b != null && t - b < 0.25) beatPulse = 0.9 * Math.exp(-(t - b) * 16);
    }
    const chroma = (fx.chroma ?? 0.7) * (st.ghost ?? 1) * (1 + spike + beatPulse);
    const step = Math.floor(tq / clock + 1e-6);
    const beatInfo = plan.beats && plan.beats.length ? beatAt(plan.beats, tq) : null;
    const energy = plan.energy ? plan.energy[Math.min(plan.energy.length - 1, Math.max(0, Math.floor(t * plan.energyRate)))] : null;
    // ---------- background graphic (per line) ----------
    // 透過PNG 前景／後景 (opt.layer): 'back' = background graphic + the decorations behind the lyrics, 'front' = the rest
    const layer = opt.transparent ? opt.layer || null : null;
    if ((!opt.transparent || layer === 'back') && !key && mainCut && mainCut.bg && mainCut.bg !== 'none' && J.BG[mainCut.bg]) {
      const env = this.makeEnv(ctx, plan, mainCut, sc, { pass: 'main', t: tq, lt: tq - mainCut.start, ltb: tq - mainCut.start, step, scale, allowFilter, energy, beat: beatInfo, bgOnly: true });
      ctx.save();
      try { J.BG[mainCut.bg].draw(env, mainCut.bgP || {}); } catch (e) { console.warn('bg', mainCut.bg, e); }
      ctx.restore();
      ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; ctx.filter = 'none';
    }
    const shx = J.rs(step, 71) * shake * 16 * u, shy = J.rs(step, 72) * shake * 11 * u;
    // ---------- content passes ----------
    const passes = [
      { pass: 'B', lag: 1.6 / 24, off: [-3.4 * chroma * u, -1.3 * chroma * u] },
      { pass: 'A', lag: 0.8 / 24, off: [3.2 * chroma * u, 1.9 * chroma * u] },
      { pass: 'main', lag: 0, off: [0, 0] },
    ];
    const ghostOn = (fx.chroma ?? 0.7) > 0.02 && (st.ghost ?? 1) > 0.02 && !opt.noGhost;
    // モーフ (統一感): during the first moments of a morph cut its lyric is drawn by drawMorph (glyphs glide / melt)
    const MC = !opt.noTrans && !opt.glyphLog && mainCut && mainCut.morph && mainCut.index > 0 ? mainCut : null;
    const mPrev = MC ? plan.cuts[MC.index - 1] : null, mlt = MC ? tq - MC.start : 0;
    const morphOn = !!(MC && mPrev && mlt < MC.morph.dur && Math.abs(mPrev.end - MC.start) < 0.06);
    let mainBB = null, mainEnv = null;
    // camera blur (focus pulls etc.) is applied ONCE to the whole content layer — a blur filter on every
    // individual draw call is extremely slow when a layout draws many text rows
    let layerBlur = 0, LX = null;
    if (allowFilter && mainCut && J.CAMERA[mainCut.cam] && mainCut.cam !== 'push') {
      try {
        const e0 = this.makeEnv(ctx, plan, mainCut, sc, { pass: 'main', t: tq, lt: tq - mainCut.start, ltb: tq - mainCut.start, step, scale, allowFilter, energy, beat: beatInfo });
        const c0 = J.CAMERA[mainCut.cam].get(e0, mainCut.camP || {});
        if (c0 && c0.blur > 0.4) layerBlur = c0.blur;
      } catch (e) {}
      if (layerBlur) {
        const L = this.ensure(this.camLayer || (this.camLayer = mk(2, 2)), cw, ch);
        LX = L.getContext('2d'); LX.setTransform(1, 0, 0, 1, 0, 0); LX.globalAlpha = 1; LX.globalCompositeOperation = 'source-over'; LX.filter = 'none';
        LX.clearRect(0, 0, cw, ch); LX.setTransform(scale, 0, 0, scale, 0, 0);
      }
    }
    for (const P of passes) {
      if (P.pass !== 'main' && !ghostOn) continue;
      const tp = Math.max(0, tq - P.lag);
      const cut0 = P.lag ? J.cutAt(plan, tp) : mainCut;
      if (!cut0) continue;
      if (morphOn && cut0 !== mainCut) continue;
      // 中央を空ける: the cut in its band, and its companion (echo / whole line / decorations) in the other band
      for (const cut of plan.centerFree && cut0.companion ? [cut0, cut0.companion] : [cut0]) {
      const csc = st.schemes[cut.scheme % st.schemes.length] || st.schemes[0];
      const lt = tp - cut.start;
      const X = LX || ctx;
      const Z = plan.centerFree && cut.zone ? cut.zone : null;
      const env = this.makeEnv(X, plan, cut, csc, {
        pass: P.pass, passColor: P.pass === 'A' ? csc.ghostA : P.pass === 'B' ? csc.ghostB : null,
        t: tp, lt, ltb: lt + P.lag, step: Math.floor(tp / clock + 1e-6), scale, allowFilter, energy, beat: beatInfo, layer, zone: Z,
        hideText: morphOn, glyphLog: P.pass === 'main' ? opt.glyphLog || null : null,
      });
      X.save();
      // 中央を空ける: the cut (text, decorations, its camera) is drawn in its band and clipped to it
      if (Z) { X.beginPath(); X.rect(Z.x, Z.y, Z.w, Z.h); X.clip(); X.translate(Z.x, Z.y); }
      const W = env.W, H = env.H;
      // camera move for this cut (default: slow push-in)
      let cam = null;
      const CD = J.CAMERA[cut.cam] || J.CAMERA.push;
      try { cam = CD.get(env, cut.camP || {}); } catch (e) { cam = null; }
      cam = cam || {};
      const cs = cam.s ?? 1;
      X.translate(W / 2 + shx + P.off[0] + (cam.x || 0), H / 2 + shy + P.off[1] + (cam.y || 0));
      if (cam.rot) X.rotate(cam.rot * J.DEG);
      if (cam.skx) X.transform(1, 0, Math.tan(cam.skx * J.DEG), 1, 0, 0);
      X.scale(cs * (cam.sx ?? 1), cs * (cam.sy ?? 1)); X.translate(-W / 2, -H / 2);
      if (P.pass !== 'main') X.globalCompositeOperation = J.lum(csc.bg) > 0.55 ? 'multiply' : 'source-over';
      this.drawCut(env);
      X.restore();
      if (P.pass === 'main' && cut === cut0) { mainEnv = env; }
      }
    }
    if (LX) {
      ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
      ctx.filter = `blur(${(layerBlur * scale).toFixed(1)}px)`; ctx.drawImage(LX.canvas, 0, 0); ctx.restore();
    }
    if (morphOn && layer !== 'back') {
      const L = this.morphLogs(plan, mPrev, MC, cw, ch, scale, opt);
      const k = J.clamp(mlt / MC.morph.dur), e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      this.drawMorph(ctx, L, e, allowFilter);
    }
    // ---------- cut-to-cut transition: composite the previous cut's resting frame with this one ----------
    if (!opt.noTrans && mainCut && mainCut.trans && J.TRANS[mainCut.trans] && mainCut.index > 0) {
      const lt = tq - mainCut.start, dur = mainCut.transDur || 0.35;
      const prev = plan.cuts[mainCut.index - 1];
      if (lt < dur && prev && Math.abs(prev.end - mainCut.start) < 0.06) {
        const A = this.ensure(this.transA || (this.transA = mk(2, 2)), cw, ch), B = this.ensure(this.transB || (this.transB = mk(2, 2)), cw, ch);
        const bx = B.getContext('2d'); bx.setTransform(1, 0, 0, 1, 0, 0); bx.globalCompositeOperation = 'copy'; bx.drawImage(ctx.canvas, 0, 0); bx.globalCompositeOperation = 'source-over';
        this.frame(A.getContext('2d'), plan, Math.max(prev.start, prev.end - 1e-3), Object.assign({}, opt, { noTrans: true, noPost: true, noHud: true }));
        const psc = st.schemes[prev.scheme % st.schemes.length] || st.schemes[0];
        ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; ctx.filter = 'none';
        try { J.TRANS[mainCut.trans].draw(ctx, A, B, J.clamp(lt / dur), { cw, ch, sc, scPrev: psc, st, P: mainCut.transP || {}, step, t, scale, allowFilter, seed: mainCut.seed | 0, tmp: (w, h) => this.ensure(this.transC || (this.transC = mk(2, 2)), w, h) }); }
        catch (e) { console.warn('trans', mainCut.trans, e); }
        ctx.restore();
      }
    }
    // ---------- HUD ----------
    if (plan.hud && !opt.noHud && layer !== 'back') {
      const env = this.makeEnv(ctx, plan, mainCut, sc, { pass: 'main', t: tq, lt: 0, ltb: 0, step, scale, allowFilter, energy, beat: beatInfo });
      J.drawHUD(env, plan);
    }
    ctx.restore();
    // ---------- post ----------
    if (!opt.noPost) this.post(ctx, plan, t, tq, step, sc, scale, opt, allowFilter);
    if (key && !opt.noPost) this.keyFinish(ctx, key, opt);
  }

  /* 合成用の背景: make the finished frame monochrome (white text + effects only) and put it on the key colour.
     black: as rendered (black = empty).  green: screened onto #00FF00, so black → green, white stays white and
     the soft greys (ghosts, glow, fades) turn into partial transparency when keyed — the same result as
     screen-blending the black version. */
  keyFinish(ctx, key, opt) {
    const cw = ctx.canvas.width, ch = ctx.canvas.height;
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.filter = 'none';
    if (opt.transparent) {
      // keep the alpha: desaturate through a copy
      const S = this.ensure(this.scratch, cw, ch), sx = S.getContext('2d');
      sx.setTransform(1, 0, 0, 1, 0, 0); sx.globalAlpha = 1; sx.globalCompositeOperation = 'copy';
      if (this.filterOK) { sx.filter = 'grayscale(1)'; sx.drawImage(ctx.canvas, 0, 0); sx.filter = 'none'; }
      else {
        sx.drawImage(ctx.canvas, 0, 0); sx.globalCompositeOperation = 'saturation'; sx.fillStyle = '#808080'; sx.fillRect(0, 0, cw, ch);
        sx.globalCompositeOperation = 'destination-in'; sx.drawImage(ctx.canvas, 0, 0);
      }
      sx.globalCompositeOperation = 'source-over';
      ctx.globalCompositeOperation = 'copy'; ctx.drawImage(S, 0, 0);
    } else {
      // opaque frame: the 'saturation' blend with any grey keeps luminosity and drops colour
      ctx.globalCompositeOperation = 'saturation'; ctx.fillStyle = '#808080'; ctx.fillRect(0, 0, cw, ch);
      if (key === 'green') { ctx.globalCompositeOperation = 'screen'; ctx.fillStyle = J.KEY_BG.green; ctx.fillRect(0, 0, cw, ch); }
    }
    ctx.restore();
  }

  /* モーフ: where every glyph of the previous cut rests at its end, and where this cut's glyphs land (cached) */
  morphLogs(plan, A, B, cw, ch, scale, opt) {
    if (!this.morphCache || this.morphCache.plan !== plan) this.morphCache = { plan, map: new Map() };
    const key = A.index + ':' + B.index + ':' + cw + 'x' + ch + ':' + scale.toFixed(4), M = this.morphCache.map;
    if (M.has(key)) return M.get(key);
    const cv = this.ensure(this.morphCv || (this.morphCv = mk(2, 2)), cw, ch), x = cv.getContext('2d');
    const o2 = { scale, noPost: true, noHud: true, noTrans: true, noGhost: true, transparent: opt.transparent, fast: true };
    const la = [], lb = [];
    this.frame(x, plan, Math.max(A.start, A.end - 1e-3), Object.assign({}, o2, { glyphLog: la }));
    this.frame(x, plan, B.start + B.morph.dur + 1e-3, Object.assign({}, o2, { glyphLog: lb }));
    const r = { A: la, B: lb };
    M.set(key, r); if (M.size > 24) M.delete(M.keys().next().value);
    return r;
  }
  drawMorph(ctx, L, e, allowFilter) {
    const used = new Array(L.A.length).fill(false), pairs = [];
    for (const g of L.B) {
      let j = -1;
      for (let q = 0; q < L.A.length; q++) if (!used[q] && L.A[q].ch === g.ch) { j = q; break; }
      if (j >= 0) used[j] = true;
      pairs.push([j >= 0 ? L.A[j] : null, g]);
    }
    const det = m => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
    const put = (g, col, alpha, blur) => {
      if (alpha <= 0.01) return;
      ctx.globalAlpha = Math.min(1, alpha);
      ctx.filter = allowFilter && blur > 0.4 ? `blur(${blur.toFixed(1)}px)` : 'none';
      ctx.font = g.font; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      if (g.fill) { ctx.fillStyle = col; ctx.fillText(g.ch, 0, 0); }
      if (g.stroke > 0) { ctx.lineJoin = 'round'; ctx.lineWidth = g.stroke; ctx.strokeStyle = g.strokeColor || col; ctx.strokeText(g.ch, 0, 0); }
    };
    ctx.save();
    // the rest of the old line melts away (drips, swells, blurs)…
    L.A.forEach((a, q) => {
      if (used[q]) return;
      ctx.setTransform(a.m[0], a.m[1], a.m[2], a.m[3], a.m[4], a.m[5]);
      ctx.translate(0, e * a.px * 0.45); ctx.scale(1 + e * 0.12, 1 + e * 0.6);
      put(a, a.color, a.a * Math.pow(1 - e, 1.4), e * a.px * 0.14 * det(a.m));
    });
    // …shared characters glide to their new place, new ones condense out of a blur
    for (const [a, b] of pairs) {
      if (a) {
        const m = a.m.map((v, i) => v + (b.m[i] - v) * e);
        ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
        const k = (a.px / b.px) + (1 - a.px / b.px) * e; ctx.scale(k, k);
        put(b, /^#[0-9a-f]{3,8}$/i.test(a.color) && /^#[0-9a-f]{3,8}$/i.test(b.color) ? J.mix(a.color, b.color, e) : (e < 0.5 ? a.color : b.color), a.a + (b.a - a.a) * e, 0);
      } else {
        const k = 1 - e;
        ctx.setTransform(b.m[0], b.m[1], b.m[2], b.m[3], b.m[4], b.m[5]);
        ctx.translate(0, -k * b.px * 0.3); ctx.scale(1 + k * 0.1, 1 + k * 0.4);
        put(b, b.color, b.a * e, k * b.px * 0.14 * det(b.m));
      }
    }
    ctx.restore();
  }
  makeEnv(ctx, plan, cut, sc, o) {
    const W = o.zone ? o.zone.w : plan.W, H = o.zone ? o.zone.h : plan.H;   // 中央を空ける: a cut lives in its side band
    const env = Object.assign({ ctx, W, H, sc, st: plan.style, fx: plan.fx, fps: plan.fps, cut, plan }, o);
    if (cut) {
      env.pIn = J.clamp(o.lt / Math.max(0.01, cut.inDur));
      env.pOut = cut.outDur > 0 ? J.clamp((o.lt - (cut.dur - cut.outDur)) / cut.outDur) : 0;
    } else { env.pIn = 1; env.pOut = 0; }
    const ghost = env.pass !== 'main';
    const colOf = (c, g) => (ghost ? (g === false ? null : env.passColor) : c);
    env.draw = it => J.drawItem(env, it);
    env.rect = (x, y, w, h, c, a = 1, g = true) => { const col = colOf(c, g); if (!col || a <= 0) return; ctx.globalAlpha = a; ctx.fillStyle = col; ctx.fillRect(x, y, w, h); ctx.globalAlpha = 1; };
    env.line = (pts, c, lw = 1, a = 1, g = true) => {
      const col = colOf(c, g); if (!col || a <= 0 || pts.length < 2) return;
      ctx.globalAlpha = a; ctx.strokeStyle = col; ctx.lineWidth = lw; ctx.lineJoin = 'miter'; ctx.lineCap = 'butt';
      ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]); ctx.stroke(); ctx.globalAlpha = 1;
    };
    env.polyPartial = (pts, e, c, lw = 1, a = 1, g = true) => {
      if (e <= 0) return;
      let L = 0; const seg = [];
      for (let i = 1; i < pts.length; i++) { const d = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); seg.push(d); L += d; }
      let rem = L * J.clamp(e); const out = [pts[0]];
      for (let i = 1; i < pts.length && rem > 0; i++) {
        const d = seg[i - 1];
        if (rem >= d) { out.push(pts[i]); rem -= d; }
        else { const k = rem / d; out.push([J.lerp(pts[i - 1][0], pts[i][0], k), J.lerp(pts[i - 1][1], pts[i][1], k)]); rem = 0; }
      }
      env.line(out, c, lw, a, g);
    };
    env.circle = (cx, cy, r, fill, stroke, lw = 1, a = 1, g = true) => {
      if (r <= 0 || a <= 0) return;
      const f = fill ? colOf(fill, g) : null, s = stroke ? colOf(stroke, g) : null;
      if (!f && !s) return;
      ctx.globalAlpha = a; ctx.beginPath(); ctx.arc(cx, cy, r, 0, J.TAU);
      if (f) { ctx.fillStyle = f; ctx.fill(); }
      if (s) { ctx.strokeStyle = s; ctx.lineWidth = lw; ctx.stroke(); }
      ctx.globalAlpha = 1;
    };
    env.arc = (cx, cy, r, a0, a1, c, lw = 1, a = 1, g = true) => {
      const col = colOf(c, g); if (!col || a <= 0 || r <= 0) return;
      ctx.globalAlpha = a; ctx.strokeStyle = col; ctx.lineWidth = lw; ctx.beginPath(); ctx.arc(cx, cy, r, a0 * J.DEG, a1 * J.DEG); ctx.stroke(); ctx.globalAlpha = 1;
    };
    env.rrect = (x, y, w, h, r, fill, a = 1, g = true, stroke, lw = 1) => {
      if (a <= 0 || w <= 0 || h <= 0) return;
      const f = fill ? (ghost ? colOf(fill, g) : fill) : null, s = stroke ? colOf(stroke, g) : null;
      if (!f && !s) return;
      r = Math.min(r, w / 2, h / 2);
      ctx.globalAlpha = a; ctx.beginPath();
      ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
      if (f) { ctx.fillStyle = f; ctx.fill(); }
      if (s) { ctx.strokeStyle = s; ctx.lineWidth = lw; ctx.stroke(); }
      ctx.globalAlpha = 1;
    };
    env.poly = (pts, c, a = 1, g = true) => {
      const col = colOf(c, g); if (!col || a <= 0) return;
      ctx.globalAlpha = a; ctx.fillStyle = col; ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]))); ctx.closePath(); ctx.fill(); ctx.globalAlpha = 1;
    };
    env.blob = (pts, c, a = 1, g = true) => {
      const col = colOf(c, g); if (!col || a <= 0) return;
      ctx.globalAlpha = a; ctx.fillStyle = col; ctx.beginPath();
      const n = pts.length, mid = (i) => [(pts[i % n][0] + pts[(i + 1) % n][0]) / 2, (pts[i % n][1] + pts[(i + 1) % n][1]) / 2];
      const m0 = mid(0); ctx.moveTo(m0[0], m0[1]);
      for (let i = 1; i <= n; i++) { const p = pts[i % n], m = mid(i); ctx.quadraticCurveTo(p[0], p[1], m[0], m[1]); }
      ctx.closePath(); ctx.fill(); ctx.globalAlpha = 1;
    };
    return env;
  }

  drawCut(env) {
    const cut = env.cut, L = J.LAYOUTS[cut.layout] || J.LAYOUTS.center;
    const decor = cut.decor || [];
    if (env.layer !== 'front') for (const d of decor) { const D = J.DECOR[d.id]; if (D && D.layer === 'back') try { D.draw(env, null, d); } catch (e) { console.warn(e); } }
    if (env.layer === 'back') return null;                // 後景だけ: the lyrics and the front decorations go to the other layer
    let bb = null;
    try { bb = L.render(env); } catch (e) { console.warn('layout', cut.layout, e); }
    for (const d of decor) { const D = J.DECOR[d.id]; if (D && D.layer === 'front') try { D.draw(env, bb, d); } catch (e) { console.warn(e); } }
    return bb;
  }

  /* 透過PNG: screen effects are written for an opaque frame (they paint the background colour, wash the whole frame,
     or redraw a shifted copy over it). In transparent mode each effect is fenced:
       - a full-frame opaque fill (background colour, black/white frame…) clears instead — it hid everything anyway
       - afterwards, alpha is limited to where content was (before the effect) plus where the effect drew the
         content again (shifted / scaled / mirrored copies of the scratch copy), so washes, flashes and strobes
         tint the lyrics and the graphics but never turn the empty background opaque                            */
  alphaGuard(ctx, S, sc) {
    const cw = ctx.canvas.width, ch = ctx.canvas.height, R = this;
    const P = this.ensure(this.guardP || (this.guardP = mk(2, 2)), cw, ch), px = P.getContext('2d');
    const M = this.ensure(this.guardM || (this.guardM = mk(2, 2)), cw, ch), mx = M.getContext('2d');
    let cleared = false, bgN = null;
    const content = img => img === S;                  // the scratch copy of the frame (temp canvases may carry an opaque background)
    const own = ['fillRect', 'drawImage'];
    return {
      begin() {
        cleared = false;
        const fs0 = ctx.fillStyle; ctx.fillStyle = sc.bg; bgN = ctx.fillStyle; ctx.fillStyle = fs0;   // the background colour, normalised
        px.setTransform(1, 0, 0, 1, 0, 0); px.globalAlpha = 1; px.globalCompositeOperation = 'copy'; px.filter = 'none'; px.drawImage(ctx.canvas, 0, 0);
        mx.setTransform(1, 0, 0, 1, 0, 0); mx.globalAlpha = 1; mx.globalCompositeOperation = 'source-over'; mx.filter = 'none'; mx.clearRect(0, 0, cw, ch);
        const proto = Object.getPrototypeOf(ctx);
        ctx.fillRect = function (x, y, w, h) {
          const T = this.getTransform(), full = this.globalCompositeOperation === 'source-over' && this.globalAlpha >= 0.999 && typeof this.fillStyle === 'string' &&
            /^#[0-9a-f]{6}$/i.test(this.fillStyle) && T.b === 0 && T.c === 0 && T.e + x * T.a <= 1 && T.f + y * T.d <= 1 && T.e + (x + w) * T.a >= cw - 1 && T.f + (y + h) * T.d >= ch - 1;
          if (full) { cleared = true; mx.clearRect(0, 0, cw, ch); return proto.clearRect.call(this, x, y, w, h); }
          if (this.globalCompositeOperation === 'source-over' && typeof this.fillStyle === 'string' && /^#[0-9a-f]{6}$/i.test(this.fillStyle) && this.globalAlpha >= 0.999 && this.fillStyle === bgN) return proto.clearRect.call(this, x, y, w, h);
          return proto.fillRect.call(this, x, y, w, h);
        };
        ctx.drawImage = function (img, ...a) {
          if (content(img)) { mx.setTransform(this.getTransform()); mx.globalAlpha = this.globalAlpha; proto.drawImage.call(mx, img, ...a); }
          return proto.drawImage.call(this, img, ...a);
        };
      },
      end() {
        for (const k of own) delete ctx[k];
        mx.setTransform(1, 0, 0, 1, 0, 0); mx.globalAlpha = 1;
        if (!cleared) { mx.globalCompositeOperation = 'source-over'; mx.drawImage(P, 0, 0); }
        ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.filter = 'none';
        ctx.globalCompositeOperation = 'destination-in'; ctx.drawImage(M, 0, 0);
        ctx.restore();
      },
    };
  }

  post(ctx, plan, t, tq, step, sc, scale, opt, allowFilter) {
    const cw = ctx.canvas.width, ch = ctx.canvas.height;
    const fx = plan.fx, st = plan.style;
    const active = plan.events.filter(ev => t >= ev.t && t < ev.t + Math.max(ev.dur, 1 / plan.fps));
    const needScratch = active.some(ev => ['slice', 'block', 'zoom', 'mosaic'].includes(ev.type) || (J.FXE[ev.type] && J.FXE[ev.type].scratch)) || (!opt.fast && (st.glow || 0) > 0);
    const S = needScratch ? this.ensure(this.scratch, cw, ch) : null;
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
    const copy = () => { const sx = S.getContext('2d'); sx.globalCompositeOperation = 'copy'; sx.drawImage(ctx.canvas, 0, 0); sx.globalCompositeOperation = 'source-over'; };
    const clock24 = Math.floor(t * 24);           // glitch randomness changes at most 24 times a second at any output fps
    const guard = opt.transparent ? this.alphaGuard(ctx, S, sc) : null;   // 透過: effects must not fill the empty background
    for (const ev of active) {
      // progress clamped to 0..1 (an event shorter than one output frame is still shown for that frame — k would pass 1)
      const k0 = (t - ev.t) / Math.max(ev.dur, 1e-3), k = Number.isFinite(k0) ? J.clamp(k0, 0, 1) : 0;
      const st2 = clock24;
      const D = J.FXE[ev.type];
      if (guard) guard.begin();
      if (D && D.draw) {
        if (D.scratch) copy();
        try {
          D.draw(ctx, ev, k, { cw, ch, S, sc, st: plan.style, step: st2, t, scale, renderer: this, allowFilter, opt, transparent: !!opt.transparent, tmp: (w, h) => this.ensure(this.tiny, w, h), tmp2: (w, h) => this.ensure(this.small2 || (this.small2 = mk(2, 2)), w, h) });
        } catch (e) { console.warn('fx', ev.type, e); }
        ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; ctx.filter = 'none'; ctx.imageSmoothingEnabled = true;
        if (guard) guard.end();
        continue;
      }
      if (ev.type === 'slice') {
        copy();
        const n = 6 + (J.h(st2, 3) % 7);
        let y = 0;
        for (let i = 0; i < n && y < ch; i++) {
          const h = Math.max(2, ch * J.rr(0.01, 0.12, st2, i, 1));
          const dx = (J.r(st2, i, 2) < 0.55 ? J.rs(st2, i, 3) * cw * 0.06 * ev.amp : 0);
          if (dx) ctx.drawImage(S, 0, y, cw, h, dx, y, cw, h);
          y += h + ch * J.rr(0, 0.08, st2, i, 4);
        }
      } else if (ev.type === 'block') {
        copy();
        for (let i = 0; i < 9; i++) {
          const w = cw * J.rr(0.05, 0.3, st2, i, 5), h = ch * J.rr(0.01, 0.07, st2, i, 6);
          const x = J.r(st2, i, 7) * (cw - w), y = J.r(st2, i, 8) * (ch - h);
          const sx = J.clamp(x + J.rs(st2, i, 9) * cw * 0.08, 0, cw - w), sy = J.clamp(y + J.rs(st2, i, 10) * ch * 0.04, 0, ch - h);
          ctx.drawImage(S, sx, sy, w, h, x, y, w, h);
          if (J.r(st2, i, 11) < 0.35) { ctx.globalCompositeOperation = 'difference'; ctx.fillStyle = J.r(st2, i, 12) < 0.5 ? sc.ghostA : sc.ghostB; ctx.fillRect(x, y, w, h); ctx.globalCompositeOperation = 'source-over'; }
        }
      } else if (ev.type === 'invert') {
        ctx.globalCompositeOperation = 'difference'; ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, cw, ch); ctx.globalCompositeOperation = 'source-over';
      } else if (ev.type === 'flash') {
        ctx.globalAlpha = Math.pow(1 - k, 1.5) * 0.92; ctx.fillStyle = J.lum(sc.bg) < 0.5 ? sc.fg : '#ffffff'; ctx.fillRect(0, 0, cw, ch); ctx.globalAlpha = 1;
      } else if (ev.type === 'zoom') {
        copy();
        const a = ev.amp * (1 - k);
        for (let i = 1; i <= 6; i++) {
          const s = 1 + i * 0.022 * a; ctx.globalAlpha = 0.2 * (1 - i / 7) * Math.min(1, a * 1.3);
          ctx.drawImage(S, cw / 2 - cw * s / 2, ch / 2 - ch * s / 2, cw * s, ch * s);
        }
        ctx.globalAlpha = 1;
      } else if (ev.type === 'mosaic') {
        copy();
        const T = this.ensure(this.tiny, Math.max(8, Math.round(cw / 42)), Math.max(8, Math.round(ch / 42))), tx = T.getContext('2d');
        tx.imageSmoothingEnabled = true; tx.drawImage(S, 0, 0, T.width, T.height);
        ctx.imageSmoothingEnabled = false; ctx.globalAlpha = 0.85 * (1 - k); ctx.drawImage(T, 0, 0, cw, ch); ctx.globalAlpha = 1; ctx.imageSmoothingEnabled = true;
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
      if (guard) guard.end();
    }
    // bloom
    const glow = (st.glow || 0.6) * 0.5 * (fx.texture ?? 0.6);
    if (!opt.fast && allowFilter && glow > 0.05 && !opt.transparent) {
      const sw = Math.round(cw / 4), sh = Math.round(ch / 4);
      const Sm = this.ensure(this.small, sw, sh), sx = Sm.getContext('2d');
      sx.filter = `blur(${Math.max(2, Math.round(sw / 160))}px)`; sx.globalCompositeOperation = 'copy'; sx.drawImage(ctx.canvas, 0, 0, sw, sh); sx.filter = 'none'; sx.globalCompositeOperation = 'source-over';
      ctx.globalCompositeOperation = 'screen'; ctx.globalAlpha = glow * 0.55; ctx.drawImage(Sm, 0, 0, cw, ch); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    }
    if (!opt.transparent && !plan.keyBg) {
      // scanlines
      const scan = (st.texture.scan || 0) * (fx.texture ?? 0.6);
      if (scan > 0.03) {
        const pat = ctx.createPattern(this.scan, 'repeat');
        const k = Math.max(1, Math.round(ch / 540));
        ctx.save(); ctx.scale(k, k); ctx.globalCompositeOperation = 'multiply'; ctx.globalAlpha = scan * 0.28; ctx.fillStyle = pat; ctx.fillRect(0, 0, cw / k, ch / k); ctx.restore();
      }
      // grain
      const gr = (st.texture.grain || 0) * (fx.texture ?? 0.6);
      if (gr > 0.02) {
        const img = this.grain[((step % 4) + 4) % 4];
        const pat = ctx.createPattern(img, 'repeat');
        const k = Math.max(1, ch / 1080);
        const ox = J.r(step, 1) * 256, oy = J.r(step, 2) * 256;
        ctx.save(); ctx.scale(k, k); ctx.translate(-ox, -oy);
        ctx.fillStyle = pat;
        ctx.globalCompositeOperation = 'overlay'; ctx.globalAlpha = gr * 0.2; ctx.fillRect(0, 0, cw / k + 256, ch / k + 256);
        ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = gr * 0.035; ctx.fillRect(0, 0, cw / k + 256, ch / k + 256);
        ctx.restore();
      }
      // vignette
      const vg = ctx.createRadialGradient(cw / 2, ch / 2, Math.min(cw, ch) * 0.35, cw / 2, ch / 2, Math.hypot(cw, ch) * 0.62);
      vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, `rgba(0,0,0,${0.28 * (fx.texture ?? 0.6)})`);
      ctx.fillStyle = vg; ctx.fillRect(0, 0, cw, ch);
    }
    ctx.restore();
  }
}
/* beat context at time t: time since the previous beat, beat length and index */
function beatAt(beats, t) {
  let lo = 0, hi = beats.length - 1, i = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (beats[m] <= t) { i = m; lo = m + 1; } else hi = m - 1; }
  if (i < 0) return null;
  const len = i + 1 < beats.length ? beats[i + 1] - beats[i] : (i > 0 ? beats[i] - beats[i - 1] : 0.5);
  return { since: t - beats[i], len: Math.max(0.2, len), index: i };
}
function prevBeat(beats, t) {
  let lo = 0, hi = beats.length - 1, ans = null;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (beats[m] <= t) { ans = beats[m]; lo = m + 1; } else hi = m - 1; }
  return ans;
}
J.Renderer = Renderer;
})();


// Upstream src/11p_kinetic1.js
/* JIZURA pack: kinetic (1) — kinetic typography layouts: word-timed stacks, turns, swaps, dives and flows */
(() => {
'use strict';
const E = J.E;
const P = 'kinetic';
const DEG = J.DEG, TAU = J.TAU, clamp = J.clamp, lerp = J.lerp;
const reg = (key, def) => J.register('layout', key, Object.assign(def, { set: 'kinetic' }), P);

/* ---------------------------------------------------------------- helpers */
const U = env => Math.min(env.W, env.H);
const isPort = env => env.H > env.W * 1.08;
const strip = t => String(t || '').replace(/\s+/g, '');
const hasLatin = t => /[A-Za-z]/.test(String(t || ''));
const flat = t => (hasLatin(t) ? String(t || '').trim().replace(/\s+/g, ' ') : strip(t));
const gcount = t => [...strip(t)].length;
const fontsOf = (st, roles) => J.fontsOf(st, roles);
const bodyF = env => (env.st.fonts.body && env.st.fonts.body[0]) || 'gothic_med';
const monoF = env => (env.st.fonts.mono && env.st.fonts.mono[0]) || 'mono';
const tout = env => 1 - E.inCubic(env.pOut);
const meas = (text, font, size, o) => J.measure(Object.assign({ text, font, size }, o || {}));
const em = (text, font, o) => meas(text, font, 100, o).w / 100;
const box = (x0, y0, x1, y1) => ({ x0, y0, x1, y1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, boxes: [] });
const UB = (a, b) => J.unionBB(a, b);
/* motion index that makes J.mainDraw start this item's entrance at local time t */
const miAt = (env, t) => Math.max(0, t) / Math.max(0.005, env.cut.stagger || 0.04);
const rotV = (x, y, a) => { const c = Math.cos(a * DEG), s = Math.sin(a * DEG); return [x * c - y * s, x * s + y * c]; };
// damped spring 1 → 0 (overshoots through 0), t in seconds
const sprg = (t, k = 7, f = 18) => (t <= 0 ? 1 : Math.exp(-k * t) * Math.cos(f * t));
const bellK = k => Math.sin(Math.PI * clamp(k));
/* text colour that reads on a plate colour */
const onCol = (sc, fill) => {
  let best = null, bv = 0;
  for (const c of [sc.bg, sc.fg, sc.ink, sc.accent, sc.sub]) { if (!c || c === fill) continue; const k = J.contrast(c, fill); if (k > bv) { bv = k; best = c; } }
  return bv >= 2.6 ? best : (J.lum(fill) > 0.5 ? '#111111' : '#FFFFFF');
};
// accent that reads on the background (else fg)
const accOn = (sc) => (J.contrast(sc.accent, sc.bg) >= 1.7 ? sc.accent : sc.fg);

/* ---- word units: the cut's word chunks, merged / split to a usable count ---- */
const unitCache = new Map();
function splitUnit(s) {
  const t = String(s).trim();
  if (/\s/.test(t)) {                                   // latin phrase: at the space nearest the middle
    const mid = t.length / 2; let bi = -1, bd = 1e9;
    for (let i = 0; i < t.length; i++) if (t[i] === ' ' && Math.abs(i - mid) < bd) { bd = Math.abs(i - mid); bi = i; }
    return [t.slice(0, bi).trim(), t.slice(bi + 1).trim()];
  }
  const n = [...t].length;
  const parts = J.splitLines(t, Math.ceil(n / 2)).split('\n');
  return parts.length >= 2 ? [parts[0], parts.slice(1).join('')] : [t];
}
function unitsOf(cut, maxU = 6, minU = 1) {
  const text = String(cut.text || '');
  const key = text + '\u0002' + (cut.words || []).join('\u0001') + '\u0002' + maxU + ':' + minU;
  let w = unitCache.get(key);
  if (w) return w;
  const lat = hasLatin(text);
  w = (cut.words && cut.words.length ? cut.words : (J.chunkText ? J.chunkText(text) : text.split(/\s+/))).map(s => String(s).trim()).filter(Boolean);
  if (strip(w.join('')) !== strip(text)) w = J.chunkText ? J.chunkText(text).map(s => String(s).trim()).filter(Boolean) : [text.trim()];
  if (!w.length) w = [text.trim() || '…'];
  while (w.length > maxU) {                             // merge the shortest neighbouring pair
    let bi = 0, bv = 1e9;
    for (let i = 0; i < w.length - 1; i++) { const v = gcount(w[i]) + gcount(w[i + 1]); if (v < bv) { bv = v; bi = i; } }
    w.splice(bi, 2, w[bi] + (lat ? ' ' : '') + w[bi + 1]);
  }
  for (let g = 0; g < 8 && w.length < minU; g++) {      // split the longest splittable unit
    let bi = -1, bv = 1;
    w.forEach((s, i) => { const n = gcount(s), ok = /\s/.test(s) || (!hasLatin(s) && n >= 2); if (ok && n > bv) { bv = n; bi = i; } });
    if (bi < 0) break;
    const parts = splitUnit(w[bi]);
    if (parts.length < 2 || !parts[0] || !parts[1]) break;
    w.splice(bi, 1, parts[0], parts[1]);
  }
  if (unitCache.size > 400) unitCache.clear();
  unitCache.set(key, w);
  return w;
}

/* ---- word clock: onset time of each unit inside the cut (locked to beats when they fall close) ---- */
const clockCache = new WeakMap();
function onsets(env, n, o = {}) {
  const c = env.cut;
  let m = clockCache.get(c);
  if (!m) { m = new Map(); clockCache.set(c, m); }
  const frac = o.frac || 0.5, gap = o.gap || 0.38, t0 = o.t0 || 0;
  const key = n + ':' + frac + ':' + gap + ':' + t0;
  let v = m.get(key);
  if (v) return v;
  const dur = c.dur, last = Math.max(0, Math.min(dur * frac, (n - 1) * gap));
  v = [];
  for (let i = 0; i < n; i++) v.push(t0 + (n > 1 ? last * i / (n - 1) : 0));
  const beats = (env.plan && env.plan.beats) || [];
  if (beats.length && n > 1) {
    const pick = []; let prev = t0;
    for (const b of beats) {
      const r = b - c.start;
      if (r <= t0 + 0.12) continue;
      if (r > dur * 0.72) break;
      if (r - prev >= 0.2) { pick.push(r); prev = r; }
      if (pick.length >= n - 1) break;
    }
    if (pick.length >= n - 1 && pick[n - 2] <= Math.max(last * 1.35, dur * 0.55)) v = [t0].concat(pick);
  }
  m.set(key, v);
  return v;
}
// index of the latest unit whose onset has passed (-1 before the first)
const curIdx = (ts, t) => { let k = -1; for (let i = 0; i < ts.length; i++) if (t >= ts[i]) k = i; return k; };

/* ---- flow units into balanced lines that fit a box; positions are unit centres relative to the box centre ---- */
function partitions(n, L) {
  const out = [];
  const rec = (start, left, acc) => {
    if (left === 1) { out.push(acc.concat([[start, n]])); return; }
    for (let e = start + 1; e <= n - left + 1; e++) rec(e, left - 1, acc.concat([[start, e]]));
  };
  if (L >= 1 && L <= n) rec(0, L, []);
  return out;
}
function flowUnits(units, font, maxW, maxH, o = {}) {
  const lat = units.some(hasLatin), sp = o.sp != null ? o.sp : (lat ? 0.32 : 0.08), lead = o.lead || 1.22, track = o.track || 0;
  const ws = units.map(t => em(t, font, { track }));
  const n = units.length;
  let best = null;
  for (let L = 1; L <= Math.min(n, o.maxLines || 4); L++) {
    let bp = null, bw = 1e9;
    for (const pt of partitions(n, L).slice(0, 80)) {
      const lw = pt.map(([a, b]) => { let w = 0; for (let i = a; i < b; i++) w += ws[i] + (i > a ? sp : 0); return w; });
      const mw = Math.max(...lw);
      if (mw < bw) { bw = mw; bp = { pt, lw }; }
    }
    if (!bp) continue;
    const size = Math.min(maxW / bw, maxH / (L * lead - (lead - 1)), o.maxSize || 1e9);
    if (!best || size > best.size * (o.lineBonus || 1.1)) best = { size, L, pt: bp.pt, lw: bp.lw };
  }
  const size = best.size, pos = new Array(n);
  best.pt.forEach(([a, b], li) => {
    const y = (li - (best.L - 1) / 2) * lead * size;
    let x = -best.lw[li] * size / 2;
    for (let i = a; i < b; i++) { const w = ws[i] * size; pos[i] = { x: x + w / 2, y, w, li }; x += w + sp * size; }
  });
  return { size, pos, L: best.L, w: Math.max(...best.lw) * size, h: (best.L * lead - (lead - 1)) * size, ws };
}

/* ---------------------------------------------------------------- layouts */

/* ================================================================== 1 knSlamStack — 積み上げ */
reg('knSlamStack', {
  name: '積み上げ', tags: ['pop', 'graphic'], w: 1.1, ae: 'justified', fits: n => n >= 2 && n <= 18,
  enterBias: { cut: 3, blur: 0.7, pop: 0.8, slice: 0.3, wipe: 0.4 },
  plan(rng, cut, st) {
    return { font: rng.pick(fontsOf(st, ['display'])), align: rng.pick(['center', 'center', 'left', 'right']), from: rng.pick(['scale', 'scale', 'drop', 'side']),
      acc: rng.int(0, 5), tilt: rng.chance(0.35) ? rng.range(2, 4) * rng.pick([1, -1]) : 0, rule: rng.chance(0.55) };
  },
  render(env) {
    const { W, H, sc } = env, c = env.cut, Pm = c.params, lt = env.lt, u = U(env);
    const units = unitsOf(c, isPort(env) ? 6 : 5, 2), n = units.length;
    const ts = onsets(env, n, { frac: 0.42, gap: 0.32 });
    const ms = units.map(t => em(t, Pm.font, { track: 0.02 }));
    const maxW = W * (Pm.tilt ? 0.8 : 0.86), Hb = H * (isPort(env) ? 0.66 : 0.8), cap = Math.min(H * 0.34, W * 0.44), gap = 0.08;
    const lay = k => {
      let w = maxW, sizes = [];
      for (let q = 0; q < 5; q++) {
        sizes = ms.slice(0, k).map(m => Math.min(w / m, cap));
        const lo = Math.min(...sizes) * 2.2;                // keep the size contrast readable
        sizes = sizes.map(s => Math.min(s, lo));
        const S = sizes.reduce((a, b) => a + b, 0) + gap * sizes[0] * (k - 1);
        if (S <= Hb) break;
        w *= Hb / S;
      }
      const g = gap * sizes[0], tot = sizes.reduce((a, b) => a + b, 0) + g * (k - 1);
      let y = -tot / 2; const ys = [];
      sizes.forEach(s => { ys.push(y + s / 2); y += s + g; });
      const sw = Math.max(...sizes.map((s, i) => s * ms[i]));
      return { sizes, ys, sw };
    };
    const k = curIdx(ts, lt) + 1;
    if (k <= 0) return null;
    const A = lay(k), B = k > 1 ? lay(k - 1) : A;
    const e = E.outExpo(clamp((lt - ts[k - 1]) / 0.34));
    const sw = lerp(B.sw, A.sw, e), cx = W / 2, cy = H / 2;
    const al = Pm.align, out = tout(env);
    let bb = null;
    for (let i = 0; i < k; i++) {
      const fresh = i === k - 1;
      let size = fresh ? A.sizes[i] : lerp(B.sizes[i], A.sizes[i], e);
      let y = fresh ? A.ys[i] : lerp(B.ys[i], A.ys[i], e);
      let x = al === 'left' ? -sw / 2 : al === 'right' ? sw / 2 : 0, rot = 0, alpha = 1;
      const q = (lt - ts[i]) / 0.24;
      if (q < 1) {
        const f = 1 - E.outExpo(clamp(q));
        if (Pm.from === 'scale') { size *= 1 + 1.6 * f * (env.fx.motion ?? 1); alpha = clamp(q * 5); rot = f * 8 * (i % 2 ? 1 : -1) * (env.fx.motion ?? 1); }
        else if (Pm.from === 'drop') { y -= H * 0.7 * Math.pow(1 - clamp(q), 2) * (env.fx.motion ?? 1); }
        else { x += (i % 2 ? 1 : -1) * W * 0.9 * f * (env.fx.motion ?? 1); }
      }
      // impact: the rest of the stack takes a knock when a new line lands
      const land = lt - ts[k - 1] - 0.12;
      if (!fresh && k > 1 && land > 0) y += A.sizes[k - 1] * 0.07 * (env.fx.motion ?? 1) * sprg(land, 9, 26) * (land < 0.6 ? 1 : 0);
      let px = cx + x, py = cy + y;
      if (Pm.tilt) { const r = rotV(x, y, Pm.tilt); px = cx + r[0]; py = cy + r[1]; rot += Pm.tilt; }
      const it = { text: units[i], font: Pm.font, size, x: px, y: py, align: al === 'left' ? 'left' : al === 'right' ? 'right' : 'center', track: 0.02,
        rot, alpha, color: n > 1 && i === Pm.acc % n ? accOn(sc) : sc.fg, mi: miAt(env, ts[i]) };
      const r = J.mainDraw(env, it);
      bb = UB(bb, r);
      if (Pm.rule && r && !Pm.tilt && i < k - 1) {
        const lw = Math.max(1.5, u * 0.003), gy = py + size * 0.5 + (A.sizes[0] * gap) * 0.5;
        const w0 = al === 'left' ? cx - sw / 2 : al === 'right' ? cx + sw / 2 - sw : cx - sw / 2;
        const re = E.outExpo(clamp((lt - ts[i + 1] - 0.05) / 0.35)) * out;
        if (re > 0) env.line([[w0, gy], [w0 + sw * re, gy]], sc.sub, lw, 0.8, false);
      }
    }
    return bb;
  },
}, P);

/* ================================================================== 2 knQuarterTurn — 直角ターン */
reg('knQuarterTurn', {
  name: '直角ターン', tags: ['pop', 'graphic', 'editorial'], w: 0.9, ae: 'sideways', portrait: 0.9, fits: n => n >= 2 && n <= 16,
  enterBias: { cut: 3, pop: 0.8, blur: 0.8, slice: 0.2, wipe: 0.3 },
  plan(rng, cut, st) {
    return { font: rng.pick(fontsOf(st, ['display', 'serif'])), sgn: rng.pick([1, -1]), end: 'all', acc: rng.int(0, 3), joint: rng.chance(0.6) };
  },
  render(env) {
    const { W, H, sc } = env, c = env.cut, Pm = c.params, lt = env.lt, u = U(env);
    const units = unitsOf(c, 4, 2), n = units.length;
    const ts = onsets(env, n, { frac: 0.46, gap: 0.5 });
    // chain in em units: word i runs along direction a_i, turning 90° at each joint (staircase: turns alternate)
    const L = units.map(t => em(t, Pm.font, { track: 0.03 }));
    const lastAdv = units.map(t => { const ch = [...t.trim()].pop() || '字'; return J.metrics.adv(Pm.font, ch); });
    const ch = [];
    let sx0 = 0, sy0 = 0, a = 0;
    for (let i = 0; i < n; i++) {
      if (i > 0) {
        const pd = rotV(1, 0, a), na = a + 90 * Pm.sgn * (i % 2 ? 1 : -1), nd = rotV(1, 0, na);
        const pe = ch[i - 1];
        sx0 = pe.ex - pd[0] * lastAdv[i - 1] * 0.5 + nd[0] * 0.62; sy0 = pe.ey - pd[1] * lastAdv[i - 1] * 0.5 + nd[1] * 0.62;
        a = na;
      }
      const d = rotV(1, 0, a);
      ch.push({ a, cx: sx0 + d[0] * L[i] / 2, cy: sy0 + d[1] * L[i] / 2, ex: sx0 + d[0] * L[i], ey: sy0 + d[1] * L[i] });
    }
    // camera per word: rotate so that the word reads level, centre it, zoom to fit
    const zW = i => Math.min(W * 0.76 / L[i], H * 0.3, W * 0.42);
    const cams = ch.map((g, i) => ({ r: -g.a, x: g.cx, y: g.cy, z: zW(i) }));
    // overview: everything at once, first word level
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    ch.forEach((g, i) => { const hw = L[i] / 2, hh = 0.55, v = Math.abs(g.a % 180) > 45; const w2 = v ? hh : hw, h2 = v ? hw : hh; x0 = Math.min(x0, g.cx - w2); x1 = Math.max(x1, g.cx + w2); y0 = Math.min(y0, g.cy - h2); y1 = Math.max(y1, g.cy + h2); });
    const ov = { r: 0, x: (x0 + x1) / 2, y: (y0 + y1) / 2, z: Math.min(W * 0.84 / (x1 - x0), H * 0.78 / (y1 - y0), H * 0.3) };
    const k = curIdx(ts, lt);
    if (k < 0) return null;
    const tOv = Math.min(ts[n - 1] + 0.62, Math.max(ts[n - 1] + 0.3, c.dur - c.outDur - 0.55)), useOv = Pm.end !== 'last';
    let A = cams[Math.max(0, k - 1)], B = cams[k], e = k > 0 ? E.inOutCubic(clamp((lt - ts[k]) / 0.36)) : 1;
    if (useOv && lt >= tOv) { A = cams[n - 1]; B = ov; e = E.inOutCubic(clamp((lt - tOv) / 0.5)); }
    const dip = 1 - 0.22 * bellK(e) * (A === B ? 0 : 1);
    const cam = { r: lerp(A.r, B.r, e), x: lerp(A.x, B.x, e), y: lerp(A.y, B.y, e), z: Math.exp(lerp(Math.log(A.z), Math.log(B.z), e)) * dip };
    let bb = null;
    const out = tout(env);
    for (let i = 0; i <= k; i++) {
      const g = ch[i];
      const [dx, dy] = rotV(g.cx - cam.x, g.cy - cam.y, cam.r);
      const q = clamp((lt - ts[i]) / 0.22), pop = i === 0 ? 1 : lerp(0.3, 1, E.outBack(q, 2.2));
      const it = { text: units[i], font: Pm.font, size: cam.z * pop, x: W / 2 + dx * cam.z, y: H / 2 + dy * cam.z, rot: g.a + cam.r, track: 0.03,
        color: i === Pm.acc % n ? accOn(sc) : sc.fg, mi: miAt(env, ts[i]), alpha: i === 0 ? 1 : clamp(q * 4) };
      bb = UB(bb, J.mainDraw(env, it));
      // joint marks: a small accent square where the line turns
      if (Pm.joint && i > 0) {
        const pg = ch[i - 1], pd = rotV(1, 0, pg.a);
        const jx = pg.ex + pd[0] * 0.35, jy = pg.ey + pd[1] * 0.35;
        const [ex, ey] = rotV(jx - cam.x, jy - cam.y, cam.r);
        const s = cam.z * 0.16 * E.outBack(clamp(q * 1.3), 2) * out;
        if (s > 0.5) { const ctx = env.ctx; ctx.save(); ctx.translate(W / 2 + ex * cam.z, H / 2 + ey * cam.z); ctx.rotate((cam.r + 45) * DEG); env.rect(-s / 2, -s / 2, s, s, sc.accent, 1, false); ctx.restore(); }
      }
    }
    if (bb && u) return bb;
    return box(W * 0.3, H * 0.4, W * 0.7, H * 0.6);
  },
}, P);

/* ================================================================== 3 knSwapCenter — 入れ替わり */
reg('knSwapCenter', {
  name: '入れ替わり', tags: ['pop', 'graphic', 'glitch'], w: 1, ae: 'slotMachine', fits: n => n >= 2 && n <= 18,
  enterBias: { cut: 3, pop: 0.7, blur: 0.8, slice: 0.3, wipe: 0.3 },
  plan(rng, cut, st) {
    return { font: rng.pick(fontsOf(st, ['display'])), fontL: rng.pick(fontsOf(st, ['display', 'serif'])), mode: rng.pick(['roll', 'punch', 'slide', 'roll']), ticks: rng.chance(0.7), acc: rng.chance(0.5) };
  },
  render(env) {
    const { W, H, sc } = env, c = env.cut, Pm = c.params, lt = env.lt, u = U(env), port = isPort(env);
    const units = unitsOf(c, 6, 2), n = units.length;
    const ts = onsets(env, n, { frac: 0.4, gap: 0.36 });
    const big = units.map(t => Math.min(J.fitSize(t, Pm.font, W * 0.8, H * 0.4, { track: 0.02 }), H * 0.34, W * 0.6));
    const F = flowUnits(units, Pm.fontL, W * 0.84, H * (port ? 0.46 : 0.34), { maxSize: H * (port ? 0.13 : 0.2), track: 0.03 });
    let tR = ts[n - 1] + 0.5;
    const lim = c.dur - c.outDur - 0.4;
    if (tR > lim) tR = Math.max(ts[n - 1] + 0.18, lim);
    const k = curIdx(ts, lt);
    if (k < 0) return null;
    const cx = W / 2, cy = H / 2, out = tout(env);
    let bb = null;
    const accC = accOn(sc);
    if (lt < tR) {
      const e = k > 0 ? E.outExpo(clamp((lt - ts[k]) / 0.26)) : 1;
      const draw = (i, q, old) => {
        const s0 = big[i]; let x = cx, y = cy, size = s0, sy = 1, alpha = 1;
        if (Pm.mode === 'roll') { const d = s0 * 1.05 * (old ? -q : (1 - q)); y += d; sy = old ? 1 - q : q; }
        else if (Pm.mode === 'punch') { size = s0 * (old ? lerp(1, 0.45, q) : lerp(1.9, 1, q)); alpha = old ? 1 - q : clamp(q * 3); }
        else { x += (old ? -q : 1 - E.outBack(q, 1.3)) * W * 0.7; alpha = old ? 1 - q * q : 1; }
        if (sy < 0.02 || alpha < 0.01) return;
        const it = { text: units[i], font: Pm.font, size, x, y, sy, track: 0.02, alpha, color: Pm.acc && i % 2 ? accC : sc.fg, mi: miAt(env, ts[i]), noHold: old };
        bb = UB(bb, J.mainDraw(env, it));
      };
      if (k > 0 && e < 1) draw(k - 1, e, true);
      draw(k, e, false);
      if (Pm.ticks && n > 1) {
        const tw = u * 0.035, th = Math.max(3, u * 0.006), gx = tw * 1.5, y = Math.min(H * 0.9, cy + big[k] * 0.5 + u * 0.08);
        for (let i = 0; i < n; i++) {
          const x = cx + (i - (n - 1) / 2) * gx - tw / 2, on = i <= k;
          env.rect(x, y, tw, th, on ? accC : sc.sub, (on ? 1 : 0.4) * out * clamp(lt / 0.2), false);
        }
      }
      return bb;
    }
    // resolve: every word flies to its place in the full line
    for (let i = 0; i < n; i++) {
      const last = i === n - 1, q = E.outExpo(clamp((lt - tR - (last ? 0 : 0.05 + i * 0.035)) / 0.42));
      const p = F.pos[i], size = last ? lerp(big[i], F.size, q) : F.size * lerp(0.3, 1, q);
      const it = { text: units[i], font: last ? (q > 0.5 ? Pm.fontL : Pm.font) : Pm.fontL, size, x: lerp(cx, cx + p.x, q), y: lerp(cy, cy + p.y, q), track: last ? lerp(0.02, 0.03, q) : 0.03,
        alpha: last ? 1 : clamp(q * 2.5), color: Pm.acc && i % 2 ? accC : sc.fg, mi: last ? miAt(env, ts[i]) : miAt(env, tR) };
      bb = UB(bb, J.mainDraw(env, it));
    }
    return bb;
  },
}, P);

/* ================================================================== 4 knZoomDive — 文字へ潜る */
reg('knZoomDive', {
  name: '文字へ潜る', tags: ['pop', 'emotional', 'graphic'], w: 0.9, ae: 'zoomRepeat', fits: n => n >= 2 && n <= 16,
  enterBias: { cut: 3, blur: 0.8, pop: 0.5, slice: 0.2, wipe: 0.2 },
  plan(rng, cut, st) {
    return { font: rng.pick(fontsOf(st, ['display', 'serif'])), cap: rng.chance(0.75), acc: rng.chance(0.5) };
  },
  render(env) {
    const { W, H, sc } = env, c = env.cut, Pm = c.params, lt = env.lt, u = U(env);
    const units = unitsOf(c, 5, 2), n = units.length;
    const ts = onsets(env, n, { frac: 0.5, gap: 0.55 });
    const k = curIdx(ts, lt);
    if (k < 0) return null;
    const size = i => Math.min(J.fitSize(units[i], Pm.font, W * 0.78, H * 0.4, { track: 0.02 }), H * 0.34, W * 0.6);
    // focus glyph: the first kanji (else the middle glyph), as an offset from the word centre in em
    const focus = i => {
      const lay = J.layoutText({ text: units[i], font: Pm.font, size: 1, track: 0.02 });
      const gs = lay.filter(g => g.ch.trim());
      const g = gs.find(q => J.isKanji(q.ch)) || gs[Math.floor(gs.length / 2)] || { x: 0, y: 0 };
      return [g.x, g.y];
    };
    const cx = W / 2, cy = H / 2, accC = accOn(sc);
    let bb = null;
    const T = 0.42;
    // the previous word blows up around its focus glyph: the camera dives through the letter
    if (k > 0) {
      const e = clamp((lt - ts[k]) / T);
      if (e < 1) {
        const i = k - 1, s0 = size(i), [fx, fy] = focus(i);
        const px = lerp(cx + fx * s0, cx, E.inOutCubic(e)), py = lerp(cy + fy * s0, cy, E.inOutCubic(e));
        const s = Math.exp(Math.pow(e, 1.6) * Math.log(36));
        const it = { text: units[i], font: Pm.font, size: s0 * s, x: px - fx * s0 * s, y: py - fy * s0 * s, track: 0.02, alpha: 1 - J.smooth(0.55, 1, e), color: Pm.acc && i % 2 ? accC : sc.fg, mi: miAt(env, ts[i]), noHold: true };
        J.mainDraw(env, it);
      }
    }
    const s1 = size(k), q = k > 0 ? E.outExpo(clamp((lt - ts[k] - T * 0.35) / 0.45)) : 1;
    if (q > 0.001) {
      const it = { text: units[k], font: Pm.font, size: s1 * lerp(0.03, 1, q), x: cx, y: cy, track: 0.02, alpha: clamp(q * 3), color: Pm.acc && k % 2 ? accC : sc.fg, mi: miAt(env, ts[k]) };
      bb = J.mainDraw(env, it);
    }
    // the whole line as a caption once the last word has settled
    if (Pm.cap && n > 1 && k === n - 1 && bb) {
      const a = E.outCubic(clamp((lt - ts[k] - 0.55) / 0.35)) * tout(env);
      if (a > 0.01) {
        const t = flat(c.text), fs = Math.min(J.clamp(u * 0.034, 14, 40), J.fitSize(t, bodyF(env), W * 0.8, H * 0.1, { track: 0.18 }));
        env.draw({ text: t, font: bodyF(env), size: fs, track: 0.18, x: cx, y: Math.min(H * 0.92, bb.y1 + fs * 1.6), color: sc.sub, alpha: a, ghost: false });
        const lw = Math.max(1, u * 0.002), w = J.measure({ text: t, font: bodyF(env), size: fs, track: 0.18 }).w * a;
        env.line([[cx - w / 2, Math.min(H * 0.92, bb.y1 + fs * 1.6) - fs * 1.1], [cx + w / 2, Math.min(H * 0.92, bb.y1 + fs * 1.6) - fs * 1.1]], sc.sub, lw, 0.6, false);
      }
    }
    return bb || box(W * 0.3, H * 0.4, W * 0.7, H * 0.6);
  },
}, P);

/* ================================================================== 5 knFlowSnap — 流れて整列 */
reg('knFlowSnap', {
  name: '流れて整列', tags: ['graphic', 'pop', 'editorial'], w: 0.9, ae: 'gridCells', fits: n => n >= 3 && n <= 16,
  enterBias: { cut: 3, blur: 0.6, pop: 0.6, slice: 0.2, wipe: 0.2 },
  plan(rng, cut, st) {
    return { font: rng.pick(fontsOf(st, ['display', 'body'])), amp: rng.range(0.1, 0.16), lam: rng.range(0.45, 0.7), grid: rng.pick(['cells', 'cells', 'rules']), acc: rng.int(0, 15) };
  },
  render(env) {
    const { W, H, sc } = env, c = env.cut, Pm = c.params, lt = env.lt, u = U(env), port = isPort(env);
    const lat = hasLatin(c.text), t0 = flat(c.text), chars = [...t0], n = chars.length;
    // final arrangement: a glyph grid (Japanese) or balanced lines (latin)
    let ft, trk;
    if (lat) { ft = J.splitLines(t0, port ? 10 : 18); trk = 0.02; }
    else {
      const m = [...t0].length, c0 = Math.max(2, Math.min(port ? 4 : 6, Math.ceil(Math.sqrt(m * (port ? 0.7 : 1.6))))), cols = Math.ceil(m / Math.ceil(m / c0));
      const rows = []; for (let i = 0; i < m; i += cols) rows.push(chars.slice(i, i + cols).join(''));
      ft = rows.join('\n'); trk = 0.3;
    }
    const lead = lat ? 1.25 : 1.3;
    const fsz = Math.min(J.fitSize(ft, Pm.font, W * 0.8, H * (port ? 0.5 : 0.62), { track: trk, lead }), H * 0.2);
    const lay = J.layoutText({ text: ft, font: Pm.font, size: fsz, track: trk, lead, align: lat ? 'center' : 'left' });
    const mm = { w: lay.W, h: lay.H }, ox = W / 2 - (lat ? 0 : mm.w / 2), oy = H / 2;
    const gl = lay.filter(g => g.ch !== '\n');
    // snap time: about 40% into the cut
    const tS = clamp(c.dur * 0.42, 0.45, 1.5);
    const advs = gl.map((g, i) => J.metrics.adv(Pm.font, g.ch) * 1.08 + (i > 0 && g.li !== gl[i - 1].li ? 0.35 : 0)), totA = advs.reduce((a, b) => a + b, 0);
    const fs = Math.min(H * 0.15, W * 0.95 / Math.max(4, totA)), offs = [];
    advs.reduce((a, b, i) => { offs[i] = (a + b / 2) * fs; return a + b; }, 0);
    // the train rushes in from the right edge, brakes towards the centre, then snaps
    const Xs = W / 2 - totA * fs / 2, X0 = W + fs * 0.8;
    const A = Math.min(H * Pm.amp, W * 0.16), lam = W * Pm.lam * (port ? 1.7 : 1);
    const flowAt = (i, t) => {
      const x = lerp(X0, Xs, E.outCubic(clamp(t / tS))) + (offs[i] || 0), y = cy0(x, t);
      const sl = (cy0(x + 2, t) - cy0(x - 2, t)) / 4;
      return [x, y, Math.atan(sl) / DEG];
    };
    function cy0(x, t) { return H / 2 + A * Math.sin(x / lam * TAU + t * 3.2); }
    const tf = Math.min(lt, tS);
    let bb = null;
    const out = tout(env), accC = accOn(sc);
    gl.forEach((g, i) => {
      if (g.ch === ' ' || g.ch === '　') return;
      const [fx, fy, fr] = flowAt(i, tf);
      const q = E.outExpo(clamp((lt - tS - i * 0.018) / 0.3));
      const x = lerp(fx, ox + g.x, q), y = lerp(fy, oy + g.y, q), rot = fr * (1 - q), size = lerp(fs, fsz * (g.fs || 1), q);
      if (x > W + size && q <= 0) return;
      const it = { text: g.ch, font: Pm.font, size, x, y, rot, color: !lat && i === Pm.acc % n ? accC : sc.fg, mi: i * 0.3 };
      bb = UB(bb, J.mainDraw(env, it));
    });
    // grid lines draw in with the snap
    const ge = E.outExpo(clamp((lt - tS - 0.08) / 0.5)) * out;
    if (ge > 0.01) {
      const lw = Math.max(1, u * 0.0016);
      if (!lat && Pm.grid === 'cells') {
        const cell = fsz * (1 + trk), rows = ft.split('\n').length, cols = Math.max(...ft.split('\n').map(r => [...r].length));
        const gx0 = ox - fsz * trk / 2, gy0 = oy - mm.h / 2 - (cell - fsz) / 2 - (fsz * lead - cell) / 2;
        const rh = fsz * lead;
        for (let r = 0; r <= rows; r++) { const y = gy0 + r * rh; env.line([[gx0, y], [gx0 + cols * cell * ge, y]], sc.sub, lw, 0.55, false); }
        for (let q2 = 0; q2 <= cols; q2++) { const x = gx0 + q2 * cell; env.line([[x, gy0], [x, gy0 + rows * rh * ge]], sc.sub, lw, 0.55, false); }
      } else {
        const lines = ft.split('\n'), rh = fsz * lead;
        lines.forEach((ln, li) => {
          const w = J.measure({ text: ln, font: Pm.font, size: fsz, track: trk }).w, y = oy + (li - (lines.length - 1) / 2) * rh + fsz * 0.62;
          const x0 = lat ? W / 2 - w / 2 : ox;
          env.line([[x0, y], [x0 + w * ge, y]], sc.sub, lw * 1.5, 0.7, false);
        });
      }
    }
    // the path the line flowed along, fading after the snap
    const pa = (1 - clamp((lt - tS) / 0.25)) * clamp(lt / 0.15) * 0.35;
    if (pa > 0.01) {
      const pts = []; for (let x = -20; x <= W + 20; x += W / 48) pts.push([x, cy0(x, tf)]);
      env.line(pts, sc.sub, Math.max(1, u * 0.0015), pa, false);
    }
    return bb;
  },
}, P);

/* ================================================================== 6 knSeesaw — シーソー */
reg('knSeesaw', {
  name: 'シーソー', tags: ['pop', 'graphic'], w: 0.8, ae: 'bounceLine', portrait: 0.4, fits: n => n >= 2 && n <= 14,
  enterBias: { cut: 3, pop: 0.6, blur: 0.5, slice: 0.2, wipe: 0.2 },
  plan(rng, cut, st) {
    return { font: rng.pick(fontsOf(st, ['display'])), order: rng.pick(['lr', 'lr', 'out']), acc: rng.chance(0.5), fulc: rng.pick(['tri', 'tri', 'round']) };
  },
  render(env) {
    const { W, H, sc, ctx } = env, c = env.cut, Pm = c.params, lt = env.lt, u = U(env), port = isPort(env);
    const units = unitsOf(c, 6, 2), n = units.length;
    const F = flowUnits(units, Pm.font, W * 0.78, H * 0.2, { maxLines: 1, maxSize: H * 0.17, track: 0.03, sp: hasLatin(c.text) ? 0.4 : 0.22 });
    const size = F.size, th = Math.max(4, size * 0.1), half = F.w / 2 + size * 0.6;
    const px = W / 2, py = H * (port ? 0.55 : 0.6);
    // landing order: left to right, or from the middle outwards
    const ord = units.map((_, i) => i);
    if (Pm.order === 'out') ord.sort((a, b) => Math.abs(F.pos[a].x) - Math.abs(F.pos[b].x));
    const ts0 = onsets(env, n, { frac: 0.45, gap: 0.4 }), fall = 0.24;
    const tl = new Array(n); ord.forEach((i, r) => { tl[i] = ts0[r] + fall; });
    const mass = units.map(t => gcount(t));
    const M = mass.reduce((a, b) => a + b, 0);
    // plank angle: each landing pulls it towards the torque of what has landed; balanced when all are on
    const targ = [0];
    let tq = 0;
    ord.forEach((i, r) => { tq += mass[i] * F.pos[i].x; targ.push(r === n - 1 ? 0 : clamp(tq / (M * half) * 30, -11, 11)); });
    let th0 = 0;
    for (let r = 0; r < n; r++) {
      const t0 = ts0[r] + fall; if (lt < t0) break;
      th0 = targ[r + 1] + (targ[r] - targ[r + 1]) * sprg(lt - t0, 3.6, 10);
    }
    const ang = th0;
    const e = E.outExpo(clamp(lt / 0.35)), out = tout(env);
    const plateC = sc.sub, accC = accOn(sc);
    // fulcrum + plank
    const fh = size * 0.62;
    if (Pm.fulc === 'tri') env.poly([[px, py + th / 2], [px - fh * 0.62 * e, py + th / 2 + fh * e], [px + fh * 0.62 * e, py + th / 2 + fh * e]], accC, out, false);
    else env.circle(px, py + th / 2 + fh * 0.45, fh * 0.45 * e, accC, null, 0, out, false);
    ctx.save(); ctx.translate(px, py); ctx.rotate(ang * DEG);
    env.rect(-half * e, -th / 2, half * 2 * e, th, plateC, 0.9 * out, false);
    ctx.restore();
    let bb = null;
    const cr = Math.cos(ang * DEG), sr = Math.sin(ang * DEG);
    for (let i = 0; i < n; i++) {
      const t0 = tl[i] - fall;
      if (lt < t0) continue;
      const p = F.pos[i], v = -th / 2 - size * 0.54;
      let x = px + p.x * cr - v * sr, y = py + p.x * sr + v * cr, rot = ang, sy = 1, sx = 1;
      const d = lt - tl[i];
      if (d < 0) { const k = -d / fall; y -= H * 0.55 * k * k; rot = ang * (1 - k); }
      else { const q = Math.exp(-d * 11) * 0.22; sy = 1 - q; sx = 1 + q * 0.6; x += sr * size * q * 0.5; y += cr * size * q * 0.5; }
      const it = { text: units[i], font: Pm.font, size, x, y, rot, sx, sy, track: 0.03, color: Pm.acc && mass[i] === Math.max(...mass) ? accC : sc.fg, mi: miAt(env, t0) };
      bb = UB(bb, J.mainDraw(env, it));
    }
    return bb;
  },
}, P);

/* ================================================================== 7 knTypeSlam — タイプ→スラム */
reg('knTypeSlam', {
  name: 'タイプ→スラム', tags: ['pop', 'graphic', 'editorial'], w: 1, ae: 'type', fits: n => n >= 2 && n <= 24,
  enterBias: { cut: 3, blur: 0.5, pop: 0.5, slice: 0.2, wipe: 0.3 },
  plan(rng, cut, st) {
    return { font: rng.pick(fontsOf(st, ['display'])), key: rng.pick(['long', 'long', 'last']), side: rng.pick(['below', 'below', 'above']), burst: rng.chance(0.7) };
  },
  render(env) {
    const { W, H, sc, ctx } = env, c = env.cut, Pm = c.params, lt = env.lt, u = U(env), port = isPort(env);
    const t0 = flat(c.text);
    const units = unitsOf(c, 6, 1);
    let ki = units.length - 1;
    if (Pm.key === 'long') { let bv = -1; units.forEach((t, i) => { const v = gcount(t) + (/[一-鿿]/.test(t) ? 0.5 : 0); if (v > bv) { bv = v; ki = i; } }); }
    const key = units[ki];
    const tf = monoF(env);
    const ts = Math.min(J.fitSize(t0, tf, W * 0.86, H * 0.08, { track: 0.06 }), u * 0.065);
    const tm = J.measure({ text: t0, font: tf, size: ts, track: 0.06 });
    const ks = Math.min(J.fitSize(key, Pm.font, W * 0.84, H * (port ? 0.3 : 0.44), { track: 0.01 }), H * 0.34, W * 0.5);
    const above = Pm.side === 'above';
    const ky = H / 2 + (above ? ts * 1.2 : -ts * 1.2), ty = above ? ky - ks * 0.62 - ts * 1.5 : ky + ks * 0.62 + ts * 1.5;
    const nG = [...t0].length;
    const tType = clamp(nG * 0.045, 0.25, Math.min(1.1, c.dur * 0.4)), tS = tType + 0.14;
    const x0 = W / 2 - tm.w / 2;
    // typed line: revealed glyph by glyph (clip), cursor riding at the end
    const k = Math.floor(clamp(lt / tType) * nG + 1e-6);
    const pre = [...t0].slice(0, k).join('');
    const wk = k >= nG ? tm.w + ts : J.measure({ text: pre, font: tf, size: ts, track: 0.06 }).w + (k > 0 ? ts * 0.06 : 0);
    const imp = lt - tS - 0.1;
    const shake = imp > 0 ? Math.exp(-imp * 10) * ts * 0.35 : 0;
    const itT = { text: t0, font: tf, size: ts, x: x0 + J.rs(c.seed, env.step, 3) * shake, y: ty + J.rs(c.seed, env.step, 4) * shake, align: 'left', track: 0.06, color: sc.fg, mi: 0 };
    if (k < nG) itT.clip = [x0 - ts, x0 + wk];
    let bb = J.mainDraw(env, itT);
    const out = tout(env), accC = accOn(sc);
    if (k < nG || env.step % 2 === 0) { if (lt < tS + 0.6) env.rect(x0 + wk + ts * 0.1, ty - ts * 0.5, ts * 0.55, ts, accC, out, false); }
    // key word slams in
    if (lt >= tS) {
      const q = clamp((lt - tS) / 0.16), f = 1 - E.inQuad(q);
      const land = lt - tS - 0.16;
      const sq = land > 0 ? Math.exp(-land * 12) * 0.12 : 0;
      const it = { text: key, font: Pm.font, size: ks * (1 + 2.4 * f), x: W / 2, y: ky, sx: 1 + sq * 0.5, sy: 1 - sq, track: 0.01, alpha: clamp(q * 4), color: sc.fg, mi: miAt(env, tS) };
      bb = UB(bb, J.mainDraw(env, it));
      if (Pm.burst && land > 0 && land < 0.5) {
        const a = 1 - land / 0.5, R0 = ks * 0.9, lw = Math.max(2, u * 0.004);
        const mK = J.measure({ text: key, font: Pm.font, size: ks, track: 0.01 });
        for (let j = 0; j < 10; j++) {
          const an = (j / 10) * TAU + J.r(c.seed, j, 5) * 0.4, r0 = Math.max(mK.w, mK.h) * 0.55 + R0 * 0.15 + land * u * 0.25, r1 = r0 + u * 0.05 * a;
          const sx = 1, syy = mK.h / Math.max(mK.w, mK.h) + 0.35;
          env.line([[W / 2 + Math.cos(an) * r0 * sx, ky + Math.sin(an) * r0 * syy], [W / 2 + Math.cos(an) * r1 * sx, ky + Math.sin(an) * r1 * syy]], accC, lw, a * out, false);
        }
      }
      // mark the key word inside the typed line
      const idx = t0.indexOf(key.trim());
      if (idx >= 0 && land > 0) {
        const a0 = J.measure({ text: t0.slice(0, idx) || ' ', font: tf, size: ts, track: 0.06 }).w * (idx ? 1 : 0) + (idx ? ts * 0.06 : 0);
        const kw = J.measure({ text: key.trim(), font: tf, size: ts, track: 0.06 }).w;
        const e2 = E.outExpo(clamp(land / 0.3)) * out;
        env.rect(x0 + a0, ty + ts * 0.62, kw * e2, Math.max(2, ts * 0.12), accC, 1, false);
      }
    }
    return bb;
  },
}, P);

/* ================================================================== 8 knRhythmCuts — 語のカット割り */
const SHOTS = ['huge', 'vert', 'small', 'crop', 'band', 'tilt'];
reg('knRhythmCuts', {
  name: '語のカット割り', tags: ['pop', 'graphic', 'glitch'], w: 0.9, ae: 'panels', fits: n => n >= 2 && n <= 18,
  enterBias: { cut: 3.5, pop: 0.4, blur: 0.4, slice: 0.2, wipe: 0.2 },
  plan(rng, cut, st) {
    const sh = SHOTS.slice(); for (let i = sh.length - 1; i > 0; i--) { const j = rng.int(0, i); const t = sh[i]; sh[i] = sh[j]; sh[j] = t; }
    return { font: rng.pick(fontsOf(st, ['display'])), fontB: rng.pick(fontsOf(st, ['display', 'serif'])), shots: sh, side: rng.pick([1, -1]), fin: rng.pick(['center', 'center', 'left']) };
  },
  render(env) {
    const { W, H, sc, ctx } = env, c = env.cut, Pm = c.params, lt = env.lt, u = U(env), port = isPort(env);
    const units = unitsOf(c, 5, 2), n = units.length;
    const ts = onsets(env, n, { frac: 0.5, gap: 0.46 });
    let tF = Math.min(ts[n - 1] + 0.55, c.dur - c.outDur - 0.45);
    tF = Math.max(tF, ts[n - 1] + 0.28);
    const k = curIdx(ts, lt);
    if (k < 0) return null;
    const out = tout(env), accC = accOn(sc);
    if (lt < tF) {
      const t = units[k], shot = (Pm.shots || SHOTS)[k % 6], dt = lt - ts[k];
      const punch = 1 + 0.1 * Math.exp(-dt * 14);
      const it = { text: t, font: Pm.font, x: W / 2, y: H / 2, color: sc.fg, track: 0.02, mi: miAt(env, ts[k]) };
      const vtxt = hasLatin(t) ? t : strip(t);
      if (shot === 'huge') it.size = Math.min(J.fitSize(t, Pm.font, W * 0.82, H * 0.6, { track: 0.02 }), H * 0.54);
      else if (shot === 'vert' && !hasLatin(t)) {
        Object.assign(it, { text: vtxt, vertical: true, x: W / 2 + Pm.side * W * (port ? 0.18 : 0.22) });
        it.size = Math.min(J.fitSize(vtxt, Pm.font, W * 0.4, H * 0.8, { vertical: true, track: 0.02 }), W * (port ? 0.34 : 0.26));
      } else if (shot === 'small' || shot === 'vert') {
        it.size = Math.min(J.fitSize(t, Pm.fontB, W * 0.4, H * 0.12, { track: 0.12 }), H * 0.1); it.font = Pm.fontB; it.track = 0.12;
        const m = J.measure(it), pw = m.w / 2 + it.size * 0.8, ph = m.h / 2 + it.size * 0.6, L = it.size * 0.6, lw = Math.max(2, u * 0.003);
        const e = E.outExpo(clamp(dt / 0.2));
        [[-1, -1], [1, -1], [1, 1], [-1, 1]].forEach(([a, b]) => { const cx = W / 2 + a * pw * (1.3 - 0.3 * e), cy = H / 2 + b * ph * (1.3 - 0.3 * e); env.line([[cx - a * L, cy], [cx, cy], [cx, cy - b * L]], accC, lw, out, false); });
      } else if (shot === 'crop') {
        it.size = Math.min(J.fitSize(t, Pm.font, W * 1.02, H * 0.7, { track: 0.0 }), H * 0.66); it.align = 'left'; it.track = 0;
        const m = J.measure(it); it.x = W * 0.97 - m.w; it.y = H / 2 + H * 0.04;
      } else if (shot === 'band') {
        it.size = Math.min(J.fitSize(t, Pm.font, W * 0.8, H * 0.24, { track: 0.06 }), H * 0.22); it.track = 0.06;
        const bh = it.size * 1.55, e = E.outExpo(clamp(dt / 0.18));
        env.rect(0, H / 2 - bh / 2 * e, W, bh * e, sc.ink, out, false);
        it.color = onCol(sc, sc.ink); it.plain = true;
      } else {
        it.size = Math.min(J.fitSize(t, Pm.font, W * 0.72, H * 0.4, { track: 0.02 }), H * 0.34); it.rot = -8 * Pm.side; it.color = accC;
      }
      it.size *= punch;
      return J.mainDraw(env, it);
    }
    // final shot: the whole line, clean
    const F = flowUnits(units, Pm.fontB, W * 0.84, H * (port ? 0.42 : 0.34), { maxSize: H * 0.16, track: 0.04 });
    const left = Pm.fin === 'left', ox = left ? W * 0.08 + F.w / 2 : W / 2;
    const dt = lt - tF, punch = 1 + 0.06 * Math.exp(-dt * 14);
    let bb = null;
    units.forEach((t, i) => {
      const p = F.pos[i];
      bb = UB(bb, J.mainDraw(env, { text: t, font: Pm.fontB, size: F.size * punch, x: ox + p.x * punch, y: H / 2 + p.y * punch, track: 0.04, color: sc.fg, mi: miAt(env, tF + i * 0.03) }));
    });
    if (bb) {
      const e = E.outExpo(clamp(dt / 0.35)) * out, lw = Math.max(2, u * 0.004);
      env.rect(left ? W * 0.08 : W / 2 - F.w / 2, bb.y1 + F.size * 0.25, F.w * e, lw, accC, 1, false);
    }
    return bb;
  },
}, P);

/* ================================================================== 9 knPathRide — ループ軌道 */
const pathCache = new Map();
function loopPath(W, H, xT, yL, R, side) {
  const key = [W, H, xT | 0, yL | 0, R | 0, side].join(':');
  let P0 = pathCache.get(key);
  if (P0) return P0;
  const pts = [[-W * 0.9, yL], [xT, yL]];
  const N = 72;
  // a full loop tangent to the line at (xT, yL): up and back over the top (side 1) or under it (side -1)
  for (let i = 1; i <= N; i++) { const a = i / N * TAU; pts.push([xT + Math.sin(a) * R, yL - side * (1 - Math.cos(a)) * R]); }
  pts.push([W * 2.2, yL]);
  const L = [0];
  for (let i = 1; i < pts.length; i++) L.push(L[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  P0 = { pts, L, tot: L[L.length - 1], sT: L[1], sL: L[1] + 0 };
  if (pathCache.size > 60) pathCache.clear();
  pathCache.set(key, P0);
  return P0;
}
function pathAt(P0, s) {
  const { pts, L } = P0;
  s = clamp(s, 0, P0.tot - 0.01);
  let lo = 0, hi = L.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (L[m] <= s) lo = m; else hi = m; }
  const a = pts[lo], b = pts[hi], k = (s - L[lo]) / Math.max(1e-6, L[hi] - L[lo]);
  return [lerp(a[0], b[0], k), lerp(a[1], b[1], k), Math.atan2(b[1] - a[1], b[0] - a[0]) / DEG];
}
reg('knPathRide', {
  name: 'ループ軌道', tags: ['pop', 'graphic'], w: 0.8, ae: 'wave', portrait: 0.4, fits: n => n >= 2 && n <= 14,
  enterBias: { cut: 3, blur: 0.6, pop: 0.3, slice: 0.2, wipe: 0.2 },
  plan(rng, cut, st) {
    return { font: rng.pick(fontsOf(st, ['display'])), side: rng.pick([1, 1, -1]), rail: rng.pick(['dash', 'line', 'dots']), acc: rng.chance(0.5) };
  },
  render(env) {
    const { W, H, sc } = env, c = env.cut, Pm = c.params, lt = env.lt, u = U(env), port = isPort(env);
    const t0 = flat(c.text), chars = [...t0];
    const size = Math.min(J.fitSize(t0, Pm.font, W * (port ? 0.86 : 0.72), H * 0.2, { track: 0.04 }), H * 0.17);
    const adv = chars.map(ch => J.metrics.adv(Pm.font, ch) * size * 1.04), Lt = adv.reduce((a, b) => a + b, 0);
    const offs = []; adv.reduce((a, b, i) => { offs[i] = a + b / 2; return a + b; }, 0);
    const R = clamp(Lt / TAU * 1.15, size * 1.5, Math.min(H * 0.28, W * 0.3)), side = Pm.side;
    const yL = H / 2 + side * R * (port ? 0.5 : 0.6);
    const xT = Math.max(W * 0.06 + R * 0.2, W / 2 - Lt / 2 - size * 0.4);
    const P0 = loopPath(W, H, xT, yL, R, side);
    const sEnd = P0.sT + TAU * R + (W / 2 + Lt / 2 - xT), sStart = P0.sT - (xT + W * 0.05);
    const T = clamp(c.dur * 0.55, 0.7, 1.8);
    const q = clamp(lt / T);
    let sHead = lerp(sStart, sEnd, 1 - Math.pow(1 - q, 2.6));
    sHead += E.inCubic(env.pOut) * W * 1.3;
    const out = tout(env), accC = accOn(sc);
    // the rail
    const ra = E.outCubic(clamp(lt / 0.3)) * out * (1 - 0.6 * J.smooth(T, T + 0.5, lt));
    if (ra > 0.01) {
      const lw = Math.max(1.2, u * 0.0022), pts = P0.pts.filter(p => p[0] > -W * 0.1 && p[0] < W * 1.1);
      if (Pm.rail === 'dots') { for (let i = 0; i < pts.length; i += 3) env.circle(pts[i][0], pts[i][1], lw * 1.3, sc.sub, null, 0, ra * 0.7, false); }
      else {
        const ctx = env.ctx; if (Pm.rail === 'dash') ctx.setLineDash([lw * 5, lw * 4]);
        env.line(pts, sc.sub, lw, ra * 0.85, false); ctx.setLineDash([]);
      }
    }
    let bb = null;
    chars.forEach((ch, i) => {
      if (ch === ' ') return;
      const sg = sHead - (Lt - offs[i]);
      const [x, y, a] = pathAt(P0, sg);
      if (x < -size || x > W + size) return;
      const it = { text: ch, font: Pm.font, size, x, y: y - side * 0, rot: a, color: Pm.acc && i === chars.length - 1 ? accC : sc.fg, mi: i * 0.2 };
      bb = UB(bb, J.mainDraw(env, it));
    });
    return bb || box(W * 0.3, H * 0.4, W * 0.7, H * 0.6);
  },
}, P);

/* ================================================================== 10 knGearWords — 歯車 */
reg('knGearWords', {
  name: '歯車', tags: ['pop', 'graphic'], w: 0.7, ae: 'circleWords', treat: 'safe', fits: n => n >= 2 && n <= 16,
  enterBias: { cut: 3, pop: 0.5, blur: 0.4, slice: 0.1, wipe: 0.1 },
  plan(rng, cut, st) {
    return { font: rng.pick(fontsOf(st, ['display'])), dir: rng.pick([1, -1]), fillMode: rng.pick(['alt', 'alt', 'ink', 'ring']) };
  },
  render(env) {
    const { W, H, sc } = env, c = env.cut, Pm = c.params, lt = env.lt, u = U(env), port = isPort(env);
    const units = unitsOf(c, port ? 4 : 5, Math.min(port ? 4 : 5, Math.max(2, Math.ceil(gcount(c.text) / 4)))), n = units.length;
    const ts = onsets(env, n, { frac: 0.45, gap: 0.42 });
    const txt = units.map(t => (!hasLatin(t) && gcount(t) > 3 ? J.splitLines(strip(t), Math.ceil(gcount(t) / 2)) : t));
    const rs0 = txt.map(t => { const m = meas(t, Pm.font, 1, { track: 0.02, lead: 1.05 }); return Math.hypot(m.w, m.h) / 2 * 1.12 + 0.18; });
    const med = rs0.slice().sort((a, b) => a - b)[Math.floor(n / 2)];
    const rs = rs0.map(r => clamp(r, med * 0.75, med * 1.3)), tk = rs0.map((r, i) => Math.min(1, rs[i] / r));
    // gears touch along a row (landscape) or a zigzag column (portrait)
    const gap = 0.1;
    let tot = rs.reduce((a, b) => a + b * 2, 0) + gap * (n - 1);
    const mr = Math.max(...rs);
    const k = port ? Math.min(H * 0.84 / tot, W * 0.62 / (mr * 2)) : Math.min(W * 0.9 / tot, H * 0.6 / (mr * 2), H * 0.22 / 0.7);
    const cs = [];
    let acc = -tot / 2;
    rs.forEach((r, i) => { acc += r; const z = port ? (i % 2 ? 1 : -1) * mr * 0.32 : (i % 2 ? 1 : -1) * mr * 0.12; cs.push(port ? [W / 2 + z * k, H / 2 + acc * k] : [W / 2 + acc * k, H / 2 + z * k]); acc += r + gap; });
    const out = tout(env);
    let bb = null;
    for (let i = 0; i < n; i++) {
      if (lt < ts[i]) continue;
      // every arrival turns the whole train one full turn (neighbours counter-rotate, the new gear rolls in)
      let ang = 0;
      for (let j = i; j < n; j++) { if (lt >= ts[j]) ang += 360 * (1 - E.inOutCubic(clamp((lt - ts[j]) / 0.62))) * (j === i ? 1 : rs[j] / rs[i] * 0.35); }
      ang *= (i % 2 ? -1 : 1) * Pm.dir;
      const pop = E.outBack(clamp((lt - ts[i]) / 0.3), 1.8), r = rs[i] * k * pop * out;
      const [cx, cy] = cs[i];
      const fill = Pm.fillMode === 'ink' ? sc.ink : Pm.fillMode === 'ring' ? null : (i % 2 ? sc.accent : sc.ink);
      const rimC = fill || accOn(sc);
      if (r > 1) {
        const nt = Math.max(10, Math.round(TAU * rs[i] * 6)), th = r * 0.12, pts = [];
        for (let t = 0; t < nt; t++) {
          const a0 = (t / nt * 360 + ang) * DEG, w = TAU / nt;
          pts.push([cx + Math.cos(a0 - w * 0.25) * r, cy + Math.sin(a0 - w * 0.25) * r], [cx + Math.cos(a0 - w * 0.15) * (r + th), cy + Math.sin(a0 - w * 0.15) * (r + th)],
            [cx + Math.cos(a0 + w * 0.15) * (r + th), cy + Math.sin(a0 + w * 0.15) * (r + th)], [cx + Math.cos(a0 + w * 0.25) * r, cy + Math.sin(a0 + w * 0.25) * r]);
        }
        env.poly(pts, rimC, 1, false);
        if (fill) env.circle(cx, cy, r * 0.96, fill, null, 0, 1, false);
        else env.circle(cx, cy, r * 0.93, sc.bg, null, 0, 1, false);
        env.circle(cx, cy, r * 0.86, null, fill ? onCol(sc, fill) : rimC, Math.max(1, r * 0.02), 0.35, false);
      }
      const tc = fill ? onCol(sc, fill) : sc.fg;
      const it = { text: txt[i], font: Pm.font, size: k * pop * tk[i], x: cx, y: cy, rot: ang, lead: 1.05, track: 0.02, color: tc, mi: miAt(env, ts[i]) };
      bb = UB(bb, J.mainDraw(env, it));
    }
    return bb;
  },
}, P);

/* ================================================================== 11 knCollide — 正面衝突 */
reg('knCollide', {
  name: '正面衝突', tags: ['pop', 'graphic', 'glitch'], w: 0.9, ae: 'splitHalves', fits: n => n >= 2 && n <= 16,
  enterBias: { cut: 3.5, pop: 0.3, blur: 0.4, slice: 0.2, wipe: 0.2 },
  plan(rng, cut, st) {
    return { font: rng.pick(fontsOf(st, ['display'])), acc: rng.pick(['A', 'B', 'none']), spark: rng.chance(0.8), at: rng.range(0.28, 0.36) };
  },
  render(env) {
    const { W, H, sc } = env, c = env.cut, Pm = c.params, lt = env.lt, u = U(env), port = isPort(env);
    const all = unitsOf(c, 8, 2), lat = hasLatin(c.text);
    // two halves by glyph count
    let best = 1, bd = 1e9, tot = all.reduce((a, t) => a + gcount(t), 0), acc = 0;
    for (let i = 1; i < all.length; i++) { acc += gcount(all[i - 1]); const d = Math.abs(acc - tot / 2); if (d < bd) { bd = d; best = i; } }
    const A = all.slice(0, best).join(lat ? ' ' : ''), B = all.slice(best).join(lat ? ' ' : '');
    const tC = clamp(c.dur * Pm.at * 0.65, 0.25, 0.55), d = lt - tC;
    const accC = accOn(sc), out = tout(env);
    let size, pa, pb, axis;
    if (!port) {
      const g = lat ? 0.35 : 0.14, full = A + (lat ? ' ' : '') + B;
      size = Math.min(J.fitSize(full, Pm.font, W * 0.86, H * 0.3, { track: 0.02 }), H * 0.24);
      const wa = em(A, Pm.font, { track: 0.02 }) * size, wb = em(B, Pm.font, { track: 0.02 }) * size, x0 = W / 2 - (wa + wb + g * size) / 2;
      pa = [x0 + wa / 2, H / 2]; pb = [x0 + wa + g * size + wb / 2, H / 2]; axis = 0;
    } else {
      size = Math.min(J.fitSize(A, Pm.font, W * 0.86, H * 0.2, { track: 0.02 }), J.fitSize(B, Pm.font, W * 0.86, H * 0.2, { track: 0.02 }), W * 0.3);
      pa = [W / 2, H / 2 - size * 0.62]; pb = [W / 2, H / 2 + size * 0.62]; axis = 1;
    }
    // each half starts just outside the frame and accelerates into the other
    const D = axis ? Math.max(pa[1], H - pb[1]) + size * 0.7 : Math.max(pa[0] + em(A, Pm.font, { track: 0.02 }) * size / 2, W - pb[0] + em(B, Pm.font, { track: 0.02 }) * size / 2) + size * 0.2;
    let offA, sqA = 1;
    if (d < 0) { const q = clamp(lt / tC); offA = -D * (1 - Math.pow(q, 1.6)); }
    else { offA = -size * 0.28 * Math.exp(-d * 6) * Math.sin(d * 15); sqA = 1 - 0.22 * Math.exp(-d * 14); }
    const jit = d > 0 ? Math.exp(-d * 9) * size * 0.05 : 0;
    const mk = (t, p, sgn, col) => {
      const o = offA * sgn;
      const it = { text: t, font: Pm.font, size, x: p[0] + (axis ? 0 : o) + J.rs(c.seed, env.step, sgn, 1) * jit, y: p[1] + (axis ? o : 0) + J.rs(c.seed, env.step, sgn, 2) * jit, track: 0.02, color: col, mi: 0 };
      if (axis) it.sy = sqA; else it.sx = sqA;
      return J.mainDraw(env, it);
    };
    let bb = mk(A, pa, 1, Pm.acc === 'A' ? accC : sc.fg);
    bb = UB(bb, mk(B, pb, -1, Pm.acc === 'B' ? accC : sc.fg));
    // speed lines behind both halves while they fly; sparks at the contact point
    const lw = Math.max(1.5, u * 0.0028);
    if (d < 0 && lt > 0.02) {
      const q = clamp(lt / tC), a = 0.7 * q * out;
      for (let j = 0; j < 5; j++) {
        const f = (j - 2) / 2.2 * size * 0.42, len = size * (1.2 + J.r(c.seed, j, 7) * 1.6);
        if (!axis) {
          const xa = pa[0] + offA - em(A, Pm.font) * size / 2 - size * 0.2, xb = pb[0] - offA + em(B, Pm.font) * size / 2 + size * 0.2;
          env.line([[xa - len, pa[1] + f], [xa, pa[1] + f]], sc.sub, lw, a, false); env.line([[xb, pb[1] - f], [xb + len, pb[1] - f]], sc.sub, lw, a, false);
        } else {
          const ya = pa[1] + offA - size * 0.7, yb = pb[1] - offA + size * 0.7;
          env.line([[pa[0] + f * 1.6, ya - len], [pa[0] + f * 1.6, ya]], sc.sub, lw, a, false); env.line([[pb[0] - f * 1.6, yb], [pb[0] - f * 1.6, yb + len]], sc.sub, lw, a, false);
        }
      }
    }
    if (Pm.spark && d > 0 && d < 0.45) {
      const a = (1 - d / 0.45) * out, cx = axis ? W / 2 : (pa[0] + em(A, Pm.font) * size / 2 + pb[0] - em(B, Pm.font) * size / 2) / 2, cy = axis ? H / 2 : H / 2;
      for (let j = 0; j < 12; j++) {
        const an = (j / 12 + J.r(c.seed, j, 9) * 0.05) * TAU, r0 = size * (0.25 + d * 2.2), r1 = r0 + size * 0.5 * a;
        env.line([[cx + Math.cos(an) * r0, cy + Math.sin(an) * r0], [cx + Math.cos(an) * r1, cy + Math.sin(an) * r1]], accC, lw * 1.4, a, false);
      }
    }
    return bb;
  },
}, P);

/* ================================================================== 12 knTumble — 箱転がし */
reg('knTumble', {
  name: '箱転がし', tags: ['pop', 'graphic'], w: 0.8, ae: 'dominoes', fits: n => n >= 2 && n <= 16,
  enterBias: { cut: 3.5, pop: 0.3, blur: 0.4, slice: 0.1, wipe: 0.1 },
  plan(rng, cut, st) {
    return { font: rng.pick(fontsOf(st, ['display'])), box: rng.pick(['plate', 'frame', 'none']), acc: rng.int(0, 5), floor: rng.chance(0.7) };
  },
  render(env) {
    const { W, H, sc, ctx } = env, c = env.cut, Pm = c.params, lt = env.lt, u = U(env), port = isPort(env);
    const units = unitsOf(c, 5, 2), n = units.length;
    const F = flowUnits(units, Pm.font, W * 0.82, H * (port ? 0.4 : 0.3), { maxSize: H * 0.2, track: 0.02, sp: hasLatin(c.text) ? 0.5 : 0.3, lead: 1.6 });
    const size = F.size, pad = size * 0.14, h = size + pad * 2;
    const ts = onsets(env, n, { frac: 0.42, gap: 0.36 });
    const T = 0.5, out = tout(env), accC = accOn(sc);
    let bb = null;
    const lw = Math.max(1.5, u * 0.0025);
    for (let i = 0; i < n; i++) {
      const p = F.pos[i], w = p.w + pad * 2, base = H / 2 + p.y + h / 2, xF = W / 2 + p.x - w / 2;
      if (Pm.floor && (i === 0 || F.pos[i - 1].li !== p.li)) {
        const row = F.pos.filter(q => q.li === p.li), x0 = W / 2 + row[0].x - row[0].w / 2 - pad * 3, x1 = W / 2 + row[row.length - 1].x + row[row.length - 1].w / 2 + pad * 3;
        const e = E.outExpo(clamp(lt / 0.4)) * out;
        env.line([[x1 - (x1 - x0) * e, base + lw], [x1, base + lw]], sc.sub, lw, 0.8, false);
      }
      if (lt < ts[i]) continue;
      // rolls in from the right over its bottom-left edge: quarter turns, footprint alternating w / h
      const m = Math.min(3, Math.max(1, Math.ceil((W - xF) / (2 * (w + h))))), steps = 4 * m;
      const Tm = T * (0.7 + 0.3 * m), q = clamp((lt - ts[i]) / Tm) * steps, j = Math.min(steps - 1, Math.floor(q)), f = q >= steps ? 1 : q - j;
      let xL = xF + m * 2 * (w + h);
      for (let s2 = 0; s2 < j; s2++) xL -= s2 % 2 ? w : h;
      const fw = j % 2 ? h : w, fh = j % 2 ? w : h, ph = -90 * E.inOutSine(f);
      const [dx, dy] = rotV(fw / 2, -fh / 2, ph);
      const cx = xL + dx, cy = base + dy, rot = -90 * j + ph;
      const done = q >= steps, land = done ? lt - ts[i] - Tm : -1;
      const sq = land >= 0 ? Math.exp(-land * 14) * 0.1 : 0;
      if (Pm.box !== 'none') {
        ctx.save(); ctx.translate(cx, cy + sq * h * 0.5); ctx.rotate(rot * DEG); ctx.scale(1 + sq * 0.5, 1 - sq);
        if (Pm.box === 'plate') env.rect(-w / 2, -h / 2, w, h, i === Pm.acc % n ? accC : sc.ink, out, false);
        else env.rrect(-w / 2, -h / 2, w, h, 2, null, out, false, sc.fg, lw);
        ctx.restore();
      }
      const plate = Pm.box === 'plate';
      const it = { text: units[i], font: Pm.font, size, x: cx, y: cy + sq * h * 0.5, rot, sx: 1 + sq * 0.5, sy: 1 - sq, track: 0.02,
        color: plate ? onCol(sc, i === Pm.acc % n ? accC : sc.ink) : (i === Pm.acc % n ? accC : sc.fg), plain: plate, mi: miAt(env, ts[i]), noHold: !done };
      bb = UB(bb, J.mainDraw(env, it));
    }
    return bb;
  },
}, P);

/* ================================================================== 13 knReflow — 縦から横へ */
reg('knReflow', {
  name: '縦から横へ', tags: ['editorial', 'graphic', 'emotional'], w: 0.9, ae: 'halfVertical', fits: n => n >= 2 && n <= 16,
  enterBias: { cut: 2.5, blur: 1, pop: 0.4, slice: 0.2, wipe: 0.3 },
  plan(rng, cut, st) {
    const port = cut.H > cut.W * 1.08, lat = /[A-Za-z]/.test(cut.text);
    return { font: rng.pick(fontsOf(st, ['serif', 'display'])), dir: !lat && port && rng.chance(0.5) ? 'h2v' : 'v2h', swirl: rng.pick([1, -1]), at: rng.range(0.36, 0.46) };
  },
  render(env) {
    const { W, H, sc } = env, c = env.cut, Pm = c.params, lt = env.lt, u = U(env), port = isPort(env);
    const lat = hasLatin(c.text), t0 = lat ? flat(c.text) : strip(c.text), chars = [...t0], n = chars.length;
    const vCols = n <= (port ? 7 : 5) ? 1 : n <= 12 ? 2 : 3, per = Math.ceil(n / vCols);
    const vt = []; for (let i = 0; i < n; i += per) vt.push(chars.slice(i, i + per).join(''));
    const vtext = vt.join('\n'), htext = J.splitLines(t0, lat ? (port ? 13 : 20) : (port ? 7 : 14));
    const sv = Math.min(J.fitSize(vtext, Pm.font, W * 0.5, H * 0.8, { vertical: true, lead: 1.3, track: 0.04 }), W * 0.3);
    const sh = Math.min(J.fitSize(htext, Pm.font, W * 0.84, H * 0.4, { lead: 1.25, track: 0.04 }), H * 0.24);
    const LV = J.layoutText({ text: vtext, font: Pm.font, size: sv, vertical: true, lead: 1.3, track: 0.04 }).filter(g => g.ch.trim());
    const LH = J.layoutText({ text: htext, font: Pm.font, size: sh, lead: 1.25, track: 0.04 }).filter(g => g.ch.trim());
    const A = Pm.dir === 'h2v' ? LH : LV, B = Pm.dir === 'h2v' ? LV : LH, sA = Pm.dir === 'h2v' ? sh : sv, sB = Pm.dir === 'h2v' ? sv : sh;
    const tR = clamp(c.dur * Pm.at, 0.5, 1.5), m = Math.min(A.length, B.length);
    let bb = null;
    for (let i = 0; i < m; i++) {
      const a = A[i], b = B[i];
      const q = E.inOutCubic(clamp((lt - tR - i * Math.min(0.05, 0.5 / m)) / 0.5));
      const ax = W / 2 + a.x + a.vx, ay = H / 2 + a.y + a.vy, bx = W / 2 + b.x + b.vx, by = H / 2 + b.y + b.vy;
      // along an arc that bulges sideways: the glyphs swirl from one setting to the other
      const mx = (ax + bx) / 2, my = (ay + by) / 2, dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy) || 1, k = Pm.swirl * 0.35 * (i % 2 ? 1 : 0.6);
      const cx = mx - dy / L * L * k, cy = my + dx / L * L * k;
      const x = (1 - q) * (1 - q) * ax + 2 * (1 - q) * q * cx + q * q * bx, y = (1 - q) * (1 - q) * ay + 2 * (1 - q) * q * cy + q * q * by;
      const r0 = a.r90 ? 90 : 0, r1 = b.r90 ? 90 : 0;
      const it = { text: a.ch, font: Pm.font, size: lerp(sA * (a.fs || 1), sB * (b.fs || 1), q), x, y, rot: lerp(r0, r1, q) + Pm.swirl * 180 * bellK(q) * 0.25, color: sc.fg, mi: i * 0.4 };
      bb = UB(bb, J.mainDraw(env, it));
    }
    return bb;
  },
}, P);

/* ================================================================== 14 knPadGrid — パッド */
reg('knPadGrid', {
  name: 'パッド', tags: ['pop', 'graphic', 'glitch'], w: 0.8, ae: 'gridCells', fits: n => n >= 2 && n <= 18,
  enterBias: { cut: 3, pop: 0.8, blur: 0.4, slice: 0.2, wipe: 0.2 },
  plan(rng, cut, st) {
    return { font: rng.pick(fontsOf(st, ['display'])), round: rng.chance(0.5), flash: rng.pick(['accent', 'accent', 'ink']), beat: rng.chance(0.7) };
  },
  render(env) {
    const { W, H, sc } = env, c = env.cut, Pm = c.params, lt = env.lt, u = U(env), port = isPort(env);
    const units = unitsOf(c, 6, Math.min(6, Math.max(2, Math.ceil(gcount(c.text) / 4)))), n = units.length;
    const cols = port ? (n <= 3 ? 1 : 2) : (n <= 3 ? n : n === 4 ? 2 : 3), rows = Math.ceil(n / cols);
    const gw = W * (port ? 0.84 : 0.86), gh = H * (port ? 0.62 : 0.72), g = u * 0.02;
    const cw = (gw - g * (cols - 1)) / cols, chh = Math.min((gh - g * (rows - 1)) / rows, cw * (port ? 0.8 : 0.75));
    const x0 = W / 2 - gw / 2, y0 = H / 2 - (chh * rows + g * (rows - 1)) / 2;
    const ts = onsets(env, n, { frac: 0.45, gap: 0.34 });
    const out = tout(env), flashC = Pm.flash === 'ink' ? sc.ink : accOn(sc), lw = Math.max(1.5, u * 0.003);
    let bb = null;
    const sizes = units.map(t => Math.min(J.fitSize(t, Pm.font, cw * 0.8, chh * 0.62, { track: 0.02 }), chh * 0.5));
    const sz = Math.min(...sizes) * 1.25;
    for (let i = 0; i < cols * rows; i++) {
      const r = Math.floor(i / cols), q = i % cols;
      const x = x0 + q * (cw + g), y = y0 + r * (chh + g);
      const e = E.outBack(clamp((lt - i * 0.04) / 0.3), 1.4) * out;
      if (e <= 0.01) continue;
      const ix = x + cw / 2 * (1 - e), iy = y + chh / 2 * (1 - e);
      env.rrect(ix, iy, cw * e, chh * e, Pm.round ? chh * 0.12 : 0, null, 1, false, sc.sub, lw);
      if (i >= n || lt < ts[i]) continue;
      // hit: the pad flashes full, then decays to a faint glow; beats re-trigger one pad at a time
      let fl = Math.exp(-(lt - ts[i]) * 6);
      if (Pm.beat && env.beat && lt > ts[n - 1] + 0.4 && env.beat.index % n === i) fl = Math.max(fl, 0.55 * Math.exp(-env.beat.since * 7));
      const pf = 0.1 + 0.9 * fl;
      env.rrect(x + lw, y + lw, cw - lw * 2, chh - lw * 2, Pm.round ? chh * 0.12 : 0, flashC, pf * out, false);
      const tc = pf > 0.5 ? onCol(sc, flashC) : sc.fg;
      const it = { text: units[i], font: Pm.font, size: Math.min(sizes[i], sz) * (1 + 0.12 * Math.exp(-(lt - ts[i]) * 12)), x: x + cw / 2, y: y + chh / 2, track: 0.02, color: tc, mi: miAt(env, ts[i]) };
      bb = UB(bb, J.mainDraw(env, it));
    }
    return bb;
  },
}, P);

})();


// Upstream src/11p_typo1.js
/* JIZURA pack: typo (part 1) — 文字PV typography layouts: key glyphs, crossings, rules, grids, scale contrast, crops, annotation */
(() => {
'use strict';
const E = J.E;
const P = 'typo';
const SET = 'typo';
const reg = (key, def) => J.register('layout', key, Object.assign({ set: SET }, def), P);

/* ------------------------------------------------------------------ helpers */
const clean = t => String(t || '').replace(/\s+/g, '');
/* glyph slots keeping single word gaps (latin lyrics) */
const slotsOf = t => [...String(t || '').trim().replace(/[\s　]+/g, ' ')];
const isSp = c => c === ' ' || c === '　';
const fontsOf = (st, roles) => J.fontsOf(st, roles);
const monoF = env => (env.st.fonts.mono && env.st.fonts.mono[0]) || 'mono';
const bodyF = env => (env.st.fonts.body && env.st.fonts.body[0]) || 'gothic_med';
const inE = (env, d = 0.35, delay = 0) => E.outExpo(J.clamp((env.lt - delay) / d));
const outK = env => 1 - E.inCubic(env.pOut);
const pad2 = n => String(n).padStart(2, '0');
const hair = env => Math.max(1, Math.min(env.W, env.H) * 0.0014);
const bbRect = (x0, y0, x1, y1) => ({ x0, y0, x1, y1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, boxes: [] });
const U = J.unionBB;
const romaOf = t => { const c = clean(t); if (!/[ぁ-ヿ]/.test(c)) return null; const r = J.romaji(c); return r ? r.toUpperCase() : null; };
/* J.splitLines, but never leave a line of punctuation only */
const splitL = (t, per) => {
  const ls = J.splitLines(t, Math.max(1, per)).split('\n');
  const out = [];
  for (const l of ls) { if (out.length && [...l].every(c => J.isPunct(c) || c === ' ')) out[out.length - 1] += l; else out.push(l); }
  return out.join('\n');
};
/* main-text lines for a width budget: portrait → short lines */
const mainLines = (text, W, H, perL = 11, perP = 5) => {
  const t = String(text || '').trim(), n = J.glyphCount(t);
  const per = W < H ? perP : perL;
  if (n <= per) return t;
  return splitL(t, Math.ceil(n / Math.ceil(n / per)));
};
/* glyph centres of a laid-out text item (design space, before rotation) */
const glyphPts = (it) => {
  const lay = J.layoutText(it), sx = it.sx || 1, sy = it.sy || 1, out = [];
  for (const g of lay) { if (isSp(g.ch)) continue; out.push({ ch: g.ch, x: it.x + g.x * sx, y: it.y + g.y * sy, w: g.w * sx, h: g.h * sy, li: g.li, ci: g.ci, i: out.length }); }
  return out;
};
/* index of the "key" glyph: first kanji of the longest kanji run, else the first plain glyph */
const keyIndex = (arr, mode) => {
  const ok = c => c && !isSp(c) && !J.isPunct(c) && !J.isSmallKana(c);
  if (mode === 'mid') {
    const mid = Math.floor((arr.length - 1) / 2);
    for (let d = 0; d < arr.length; d++) { if (ok(arr[mid + d])) return mid + d; if (ok(arr[mid - d])) return mid - d; }
  }
  let best = -1, bl = 0;
  for (let i = 0; i < arr.length; i++) {
    if (!J.isKanji(arr[i])) continue;
    let j = i; while (j < arr.length && J.isKanji(arr[j])) j++;
    if (j - i > bl) { bl = j - i; best = i; }
    i = j;
  }
  if (best >= 0) return best;
  for (let i = 0; i < arr.length; i++) if (ok(arr[i])) return i;
  return 0;
};
/* best-contrast scheme colour for text on a plate */
const onCol = (sc, fill) => {
  let best = null, bv = 0;
  for (const c of [sc.bg, sc.fg, sc.ink, sc.accent, sc.sub]) { if (!c || c === fill) continue; const k = J.contrast(c, fill); if (k > bv) { bv = k; best = c; } }
  return bv >= 2.4 ? best : (J.lum(fill) > 0.5 ? '#111111' : '#FFFFFF');
};
const plateCol = (sc, pref) => { for (const c of pref) if (c && J.contrast(c, sc.bg) >= 1.6) return c; return sc.fg; };
const accentOn = (sc) => (J.contrast(sc.accent, sc.bg) >= 1.8 ? sc.accent : sc.fg);
/* small annotation label (main pass only) */
const label = (env, text, x, y, o = {}) => env.draw(Object.assign({ text: String(text), font: o.font || monoF(env), size: o.size || J.clamp(Math.min(env.W, env.H) * 0.018, 11, 22), x, y, align: o.align || 'left', track: o.track ?? 0.12, color: o.color || env.sc.sub, alpha: o.alpha ?? 1, ghost: false }, o.extra || {}));
const isLatinT = t => /[A-Za-z]/.test(t) && !/[\u3040-\u30ff\u3400-\u9fff\uff00-\uffef]/.test(t);
const labelSize = env => J.clamp(Math.min(env.W, env.H) * 0.018, 11, 22);

/* ================================================================== 1 tyKeySplit — 大字挟み */
reg('tyKeySplit', {
  name: '大字挟み', tags: ['editorial', 'graphic', 'emotional'], ae: 'mixed', w: 1.1, emph: 1.4, fits: n => n >= 2 && n <= 16,
  plan(rng, cut, st) {
    return { font: rng.pick(fontsOf(st, ['display', 'serif'])), fs: rng.pick(fontsOf(st, ['serif', 'body', 'display'])), mode: rng.pick(['kanji', 'kanji', 'mid']), big: rng.pick(['fill', 'fill', 'accent', 'outline']), rule: rng.chance(0.75) };
  },
  render(env) {
    const { W, H, sc } = env, cut = env.cut, Pm = cut.params, lt = env.lt, M = Math.min(W, H);
    const port = W < H;
    const arr = slotsOf(cut.text);
    let ki = keyIndex(arr, Pm.mode), key = arr[ki] || '?';
    let before = arr.slice(0, ki).join('').trim(), after = arr.slice(ki + 1).join('').trim();
    if (isLatinT(cut.text)) {             // latin: the longest word is the key
      const ws = String(cut.text).trim().split(/\s+/);
      let wi = 0; ws.forEach((w, i) => { if (w.length > ws[wi].length) wi = i; });
      key = ws[wi]; before = ws.slice(0, wi).join(' '); after = ws.slice(wi + 1).join(' ');
      ki = ws.slice(0, wi).join(' ').length + (wi ? 1 : 0);
    }
    let bigS = port ? Math.min(W * 0.66, H * 0.36) : Math.min(H * 0.64, W * 0.34);
    bigS = Math.min(bigS, J.fitSize(key, Pm.font, port ? W * 0.84 : W * 0.5, 1e6));
    const bw = J.measure({ text: key, font: Pm.font, size: bigS }).w;
    const gap = bigS * 0.12;
    const per = port ? 6 : 5;
    const bt = before ? splitL(before, per) : '', at = after ? splitL(after, per) : '';
    const o = { track: 0.04, lead: 1.2 };
    let ss;
    if (port) {
      const avail = (H * 0.86 - bigS) / 2 - gap;
      ss = Math.min(bt ? J.fitSize(bt, Pm.fs, W * 0.84, avail, o) : 1e9, at ? J.fitSize(at, Pm.fs, W * 0.84, avail, o) : 1e9, bigS * 0.3);
    } else {
      const side = (W * 0.9 - bw - gap * 2) / ((bt ? 1 : 0) + (at ? 1 : 0) || 1);
      ss = Math.min(bt ? J.fitSize(bt, Pm.fs, side, bigS * 0.62, o) : 1e9, at ? J.fitSize(at, Pm.fs, side, bigS * 0.62, o) : 1e9, bigS * 0.3);
    }
    const mB = bt ? J.measure(Object.assign({ text: bt, font: Pm.fs, size: ss }, o)) : { w: 0, h: 0 };
    const mA = at ? J.measure(Object.assign({ text: at, font: Pm.fs, size: ss }, o)) : { w: 0, h: 0 };
    let bx, by, itB = null, itA = null;
    const bigTop = () => by - bigS * 0.46, bigBot = () => by + bigS * 0.46;
    if (!port) {
      const tot = (bt ? mB.w + gap : 0) + bw + (at ? mA.w + gap : 0);
      const x0 = W / 2 - tot / 2;
      bx = x0 + (bt ? mB.w + gap : 0) + bw / 2; by = H / 2;
      if (bt) itB = Object.assign({ text: bt, font: Pm.fs, size: ss, align: 'right', x: bx - bw / 2 - gap, y: bigTop() + mB.h / 2, color: sc.fg, mi: 0 }, o);
      if (at) itA = Object.assign({ text: at, font: Pm.fs, size: ss, align: 'left', x: bx + bw / 2 + gap, y: bigBot() - mA.h / 2, color: sc.fg, mi: 4 }, o);
    } else {
      const tot = (bt ? mB.h + gap : 0) + bigS + (at ? mA.h + gap : 0);
      const y0 = H / 2 - tot / 2;
      bx = W / 2; by = y0 + (bt ? mB.h + gap : 0) + bigS / 2;
      const L = W / 2 - Math.max(bw, mB.w, mA.w) / 2, R = W / 2 + Math.max(bw, mB.w, mA.w) / 2;
      if (bt) itB = Object.assign({ text: bt, font: Pm.fs, size: ss, align: 'left', x: Math.max(W * 0.08, Math.min(L, bx - bw / 2)), y: by - bigS / 2 - gap - mB.h / 2, color: sc.fg, mi: 0 }, o);
      if (at) itA = Object.assign({ text: at, font: Pm.fs, size: ss, align: 'right', x: Math.min(W * 0.92, Math.max(R, bx + bw / 2)), y: by + bigS / 2 + gap + mA.h / 2, color: sc.fg, mi: 4 }, o);
    }
    const out = outK(env), lw = hair(env);
    // hairlines linking the small blocks to the key glyph
    if (Pm.rule) {
      const e = E.outCubic(J.clamp((lt - 0.2) / 0.6)) * out;
      if (e > 0 && itB) {
        const y = port ? itB.y + mB.h / 2 + gap * 0.5 : itB.y + mB.h / 2 + ss * 0.35;
        const xa = port ? itB.x : itB.x - mB.w, xb = port ? itB.x + Math.max(mB.w, bw) : bx + bw * 0.5;
        env.line([[xa, y], [J.lerp(xa, xb, e), y]], sc.sub, lw, 0.7, false);
      }
      if (e > 0 && itA) {
        const y = port ? itA.y - mA.h / 2 - gap * 0.5 : itA.y - mA.h / 2 - ss * 0.35;
        const xb = port ? itA.x : itA.x + mA.w, xa = port ? itA.x - Math.max(mA.w, bw) : bx - bw * 0.5;
        env.line([[xb, y], [J.lerp(xb, xa, e), y]], sc.sub, lw, 0.7, false);
      }
    }
    const big = { text: key, font: Pm.font, size: bigS, x: bx, y: by, color: Pm.big === 'accent' ? accentOn(sc) : sc.fg, mi: 2 };
    if (Pm.big === 'outline') Object.assign(big, { fill: false, stroke: Math.max(1.5, bigS * 0.014), strokeColor: sc.fg });
    let bb = J.mainDraw(env, big);
    if (itB) bb = U(bb, J.mainDraw(env, itB));
    if (itA) bb = U(bb, J.mainDraw(env, itA));
    const la = E.outCubic(J.clamp((lt - 0.3) / 0.3)) * out;
    const nG = arr.filter(c => !isSp(c)).length, kiG = arr.slice(0, ki).filter(c => !isSp(c)).length;
    if (la > 0) label(env, `${pad2(kiG + 1)} / ${pad2(nG)}`, port ? bx - bw / 2 : bx - bw / 2, by + bigS * 0.56, { alpha: la, size: labelSize(env) * 0.9 });
    return bb;
  },
});

/* ================================================================== 2 tyCropGiant — 見切れ大文字 */
reg('tyCropGiant', {
  name: '見切れ大文字', tags: ['graphic', 'editorial', 'pop'], ae: 'huge', w: 1, fits: n => n >= 1 && n <= 14,
  plan(rng, cut, st) {
    return { font: rng.pick(fontsOf(st, ['display'])), fm: rng.pick(fontsOf(st, ['display', 'serif'])), edge: rng.pick(['a', 'b']), style: rng.pick(['dim', 'dim', 'outline']), dir: rng.pick([1, -1]) };
  },
  render(env) {
    const { W, H, sc } = env, cut = env.cut, Pm = cut.params, lt = env.lt;
    const port = W < H, txt = String(cut.text).trim();
    const u = J.clamp(lt / Math.max(0.5, cut.dur));
    const inG = E.outCubic(J.clamp(lt / 0.8)), outG = E.inCubic(env.pOut);
    const lowEdge = Pm.edge === 'a';        // landscape: bottom edge / portrait: right edge
    // the giant copy, cropped by the frame edge
    const gi = { text: port ? clean(txt) : txt, font: Pm.font, ghost: false, alpha: 1 };
    if (!port) {
      const G = H * 0.66;
      Object.assign(gi, { size: G, x: W / 2 + (0.5 - u) * W * 0.14 * Pm.dir, y: (lowEdge ? H + G * 0.03 : -G * 0.03) + (lowEdge ? 1 : -1) * ((1 - inG) + outG) * G * 0.45 });
    } else {
      const G = W * 0.62;
      Object.assign(gi, { size: G, vertical: true, x: (lowEdge ? W + G * 0.03 : -G * 0.03) + (lowEdge ? 1 : -1) * ((1 - inG) + outG) * G * 0.45, y: H / 2 + (0.5 - u) * H * 0.1 * Pm.dir });
    }
    if (Pm.style === 'outline') Object.assign(gi, { fill: false, stroke: Math.max(1.4, gi.size * 0.006), strokeColor: sc.sub, color: sc.sub, alpha: 0.65 });
    else gi.color = J.mix(sc.bg, sc.fg, 0.16);
    env.draw(gi);
    // the readable lyric on the free side
    const mt = mainLines(txt, W, H, 10, 6);
    const o = { lead: 1.18, track: 0.03 };
    let it;
    if (!port) {
      const size = Math.min(J.fitSize(mt, Pm.fm, W * 0.74, H * 0.34, o), H * 0.19);
      it = Object.assign({ text: mt, font: Pm.fm, size, align: 'left', x: W * 0.08, y: lowEdge ? H * 0.38 : H * 0.62, color: sc.fg }, o);
    } else {
      const size = Math.min(J.fitSize(mt, Pm.fm, W * 0.58, H * 0.5, o), W * 0.2);
      it = Object.assign({ text: mt, font: Pm.fm, size, align: lowEdge ? 'left' : 'right', x: lowEdge ? W * 0.08 : W * 0.92, y: H / 2, color: sc.fg }, o);
    }
    const bb = J.mainDraw(env, it);
    const m = J.measure(it);
    const la = E.outCubic(J.clamp((lt - 0.2) / 0.35)) * outK(env), ls = labelSize(env);
    if (la > 0) {
      const ty = it.y - m.h / 2 - ls * 1.6;
      const x0 = it.align === 'right' ? it.x - m.w : it.x;
      label(env, `No.${pad2((cut.line | 0) + 1)}`, x0, ty, { alpha: la, color: accentOn(sc) });
      env.line([[x0 + ls * 4, ty], [x0 + ls * 4 + Math.min(m.w, W * 0.3) * E.outExpo(J.clamp((lt - 0.25) / 0.5)), ty]], sc.sub, hair(env), 0.7 * la, false);
    }
    return bb;
  },
});

/* ================================================================== 3 tyCross — 十字組 */
reg('tyCross', {
  name: '十字組', tags: ['graphic', 'editorial'], ae: 'vcols', w: 0.9, fits: n => n >= 3 && n <= 11,
  plan(rng, cut, st) {
    return { font: rng.pick(fontsOf(st, ['display', 'serif'])), mode: rng.pick(['kanji', 'mid', 'mid']), rules: rng.chance(0.8), key: rng.pick(['accent', 'accent', 'fg']) };
  },
  render(env) {
    const { W, H, sc } = env, cut = env.cut, Pm = cut.params, lt = env.lt, M = Math.min(W, H);
    const arr = slotsOf(cut.text), n = arr.length;
    if (!n) return null;
    const ki = keyIndex(arr, Pm.mode), tr = 0.08;
    const A = arr.slice(0, ki).join('').trim(), K = arr[ki], B = arr.slice(ki + 1).join('').trim();
    const w100 = s => (s ? J.measure({ text: s, font: Pm.font, size: 100, track: tr }).w : 0);
    const h100 = s => (s ? J.measure({ text: s, font: Pm.font, size: 100, track: tr, vertical: true }).h : 0);
    const kw = w100(K), g100 = 100 * tr + 6;
    const Lx = (A ? w100(A) + g100 : 0) + kw / 2, Rx = (B ? w100(B) + g100 : 0) + kw / 2;
    const Ty = (A ? h100(A) + g100 : 0) + 50, By = (B ? h100(B) + g100 : 0) + 50;
    const size = Math.min(W * 0.86 / ((Lx + Rx) / 100), H * 0.86 / ((Ty + By) / 100), M * 0.2);
    const k = size / 100;
    const cx = W / 2 - (Rx - Lx) * k / 2, cy = H / 2 - (By - Ty) * k / 2;
    const out = outK(env), lw = hair(env);
    if (Pm.rules) {
      const e = E.outExpo(J.clamp((lt - 0.1) / 0.7)) * out;
      if (e > 0) {
        env.line([[cx - W * e, cy], [cx + W * e, cy]], sc.sub, lw, 0.28, false);
        env.line([[cx, cy - H * e], [cx, cy + H * e]], sc.sub, lw, 0.28, false);
        env.circle(cx, cy, size * 0.78 * (0.6 + 0.4 * e), null, sc.sub, lw, 0.5 * e, false);
      }
    }
    const g = size * tr + 6 * k;
    const base = { font: Pm.font, size, track: tr, color: sc.fg };
    let bb = null;
    if (A) bb = U(bb, J.mainDraw(env, Object.assign({}, base, { text: A, align: 'right', x: cx - kw * k / 2 - g, y: cy, mi: 0 })));
    const kb = J.mainDraw(env, Object.assign({}, base, { text: K, x: cx, y: cy, color: Pm.key === 'accent' ? accentOn(sc) : sc.fg, mi: 1 }));
    bb = U(bb, kb);
    if (B) bb = U(bb, J.mainDraw(env, Object.assign({}, base, { text: B, align: 'left', x: cx + kw * k / 2 + g, y: cy, mi: 2 })));
    if (A) { const h = h100(A) * k; bb = U(bb, J.mainDraw(env, Object.assign({}, base, { text: A, vertical: true, x: cx, y: cy - size / 2 - g - h / 2, mi: 3 }))); }
    if (B) { const h = h100(B) * k; bb = U(bb, J.mainDraw(env, Object.assign({}, base, { text: B, vertical: true, x: cx, y: cy + size / 2 + g + h / 2, mi: 4 }))); }
    const la = E.outCubic(J.clamp((lt - 0.35) / 0.3)) * out;
    if (la > 0) label(env, `${pad2(ki + 1)}×${pad2(ki + 1)}`, cx + size * 0.62, cy - size * 0.62, { alpha: la, size: labelSize(env) * 0.9 });
    return bb;
  },
});

/* ================================================================== 4 tyBandHide — 帯隠れ */
reg('tyBandHide', {
  name: '帯隠れ', tags: ['graphic', 'pop', 'editorial'], ae: 'diag', w: 1, fits: n => n >= 1 && n <= 14,
  plan(rng, cut, st) {
    return { font: rng.pick(fontsOf(st, ['display'])), band: rng.pick(['ink', 'accent', 'fg']), pos: rng.pick(['low', 'low', 'high']), speed: rng.range(40, 90), dir: rng.pick([1, -1]), k: rng.range(0.3, 0.38) };
  },
  render(env) {
    const { W, H, sc, ctx } = env, cut = env.cut, Pm = cut.params, lt = env.lt;
    const txt = String(cut.text).trim();
    const mt = mainLines(txt, W, H, 10, 5), L = mt.split('\n').length, lead = 1.32;
    const size = Math.min(J.fitSize(mt, Pm.font, W * 0.8, H * 0.66, { lead, track: 0.02 }), H * 0.3);
    const bb = J.mainDraw(env, { text: mt, font: Pm.font, size, x: W / 2, y: H / 2, lead, track: 0.02, color: sc.fg });
    const bandC = plateCol(sc, Pm.band === 'accent' ? [sc.accent, sc.ink, sc.fg] : Pm.band === 'ink' ? [sc.ink, sc.accent, sc.fg] : [sc.fg, sc.accent]);
    const tc = onCol(sc, bandC);
    const unit = String(cut.lineText || txt).replace(/\s+/g, ' ').trim() + '　／　';
    const out = 1 - E.inExpo(env.pOut);
    for (let li = 0; li < L; li++) {
      const e = E.outExpo(J.clamp((lt - 0.12 - li * 0.08) / 0.5)) * out;
      if (e <= 0) continue;
      const yl = H / 2 + (li - (L - 1) / 2) * size * lead;
      const h = size * (Pm.k + 0.08);
      const y0 = Pm.pos === 'low' ? yl + size * (0.5 - Pm.k) : yl - size * 0.58;
      const d = (li % 2 ? -1 : 1) * Pm.dir;
      const bw = (W + 20) * e, x0 = d > 0 ? -10 : W + 10 - bw;
      env.rect(x0, y0, bw, h, bandC, 1, false);
      if (env.pass === 'main') {
        const fs = h * 0.44;
        const per = J.measure({ text: unit, font: bodyF(env), size: fs, track: 0.12 }).w;
        if (per > 1) {
          ctx.save(); ctx.beginPath(); ctx.rect(x0, y0, bw, h); ctx.clip();
          const off = ((env.ltb * Pm.speed * d) % per + per) % per;
          env.draw({ text: unit.repeat(Math.min(40, Math.ceil(W * 2 / per) + 2)), font: bodyF(env), size: fs, track: 0.12, align: 'left', x: -per + off, y: y0 + h / 2, color: tc, ghost: false });
          ctx.restore();
        }
      }
    }
    return bb;
  },
});

/* ================================================================== 5 tyRuby — ルビ振り */
reg('tyRuby', {
  name: 'ルビ振り', tags: ['editorial', 'calm', 'emotional'], ae: 'gloss', w: 1, fits: n => n >= 1 && n <= 14,
  plan(rng, cut, st) {
    return { font: rng.pick(fontsOf(st, ['serif', 'display'])), idx: rng.chance(0.7), up: rng.chance(0.5) };
  },
  render(env) {
    const { W, H, sc } = env, cut = env.cut, Pm = cut.params, lt = env.lt;
    const txt = String(cut.text).trim();
    const mt = mainLines(txt, W, H, 9, 5);
    const o = { track: 0.16, lead: 2.0 };
    const size = Math.min(J.fitSize(mt, Pm.font, W * 0.84, H * 0.62, o), H * 0.2, W * 0.24);
    const it = Object.assign({ text: mt, font: Pm.font, size, x: W / 2, y: H / 2 + size * 0.1, color: sc.fg }, o);
    const bb = J.mainDraw(env, it);
    const gl = glyphPts(it), out = outK(env), mono = monoF(env), lw = hair(env);
    const rs = Math.max(10, size * 0.3);
    gl.forEach((g, i) => {
      const a = E.outCubic(J.clamp((lt - 0.18 - i * 0.045) / 0.3)) * out;
      if (a <= 0) return;
      const ry = g.y - size * 0.74;
      let rt = J.isHira(g.ch) || J.isKata(g.ch) ? J.romaji(g.ch) : null;
      if (rt === '') rt = null;
      if (rt) {
        const w0 = J.measure({ text: rt, font: mono, size: rs, track: 0.02 }).w;
        const fs = w0 > g.w * 1.05 ? rs * g.w * 1.05 / w0 : rs;
        env.draw({ text: Pm.up ? rt.toUpperCase() : rt, font: mono, size: fs, track: 0.02, x: g.x, y: ry + (1 - a) * rs * 0.5, color: sc.sub, alpha: a, ghost: false });
      } else if (J.isKanji(g.ch)) {
        const w = g.w * 0.5 * a;
        env.line([[g.x - w, ry + rs * 0.2], [g.x - w, ry - rs * 0.15], [g.x + w, ry - rs * 0.15], [g.x + w, ry + rs * 0.2]], accentOn(sc), Math.max(1.2, lw * 1.2), a, false);
      }
      if (Pm.idx) {
        const iy = g.y + size * 0.72;
        env.line([[g.x, iy - rs * 0.55], [g.x, iy - rs * 0.2]], sc.sub, lw, 0.6 * a, false);
        env.draw({ text: pad2(i + 1), font: mono, size: rs * 0.72, x: g.x, y: iy + rs * 0.12, color: sc.sub, alpha: 0.75 * a, ghost: false });
      }
    });
    return bb;
  },
});

/* ================================================================== 6 tyBaseline — 罫線組 */
reg('tyBaseline', {
  name: '罫線組', tags: ['editorial', 'calm', 'graphic'], ae: 'type', w: 1.1, fits: n => n >= 2 && n <= 18,
  plan(rng, cut, st) {
    return { font: rng.pick(fontsOf(st, ['serif', 'display', 'body'])), nl: rng.pick([2, 3, 3]), key: rng.chance(0.8), right: rng.chance(0.5) };
  },
  render(env) {
    const { W, H, sc } = env, cut = env.cut, Pm = cut.params, lt = env.lt;
    const port = W < H, txt = String(cut.text).trim(), nG = J.glyphCount(txt);
    const per = port ? 4 : Math.max(4, Math.ceil(nG / Pm.nl));
    let lines = (nG <= 4 ? txt : splitL(txt, per)).split('\n').slice(0, 6);
    if (isLatinT(txt)) { const ws = txt.split(/\s+/); lines = groupLines(ws.map((w, i) => (i ? ' ' : '') + w), Math.min(ws.length, port ? 4 : Pm.nl)); }
    const L = lines.length, leadK = 1.62;
    let size = Math.min(H * 0.7 / (L * leadK), port ? W * 0.17 : H * 0.16);
    for (const l of lines) size = Math.min(size, J.fitSize(l, Pm.font, port ? W * 0.76 : W * 0.74, 1e6, { track: 0.04 }));
    const x0 = port ? W * 0.16 : W * 0.14, mx = W * 0.06, out = outK(env), lw = hair(env), mono = monoF(env), ls = labelSize(env);
    // key glyph (for the accent mark on its baseline)
    const all = lines.join(''), arr = [...all];
    const ki = keyIndex(arr, 'kanji');
    let kEnd = ki; while (kEnd + 1 < arr.length && J.isKanji(arr[kEnd + 1]) && J.isKanji(arr[ki])) kEnd++;
    let acc = 0, bb = null;
    lines.forEach((ln, li) => {
      const y = H / 2 + (li - (L - 1) / 2) * size * leadK;
      const yb = y + size * 0.6;
      const e = E.outExpo(J.clamp((lt - li * 0.1) / 0.6)) * out;
      if (e > 0) {
        env.line([[mx, yb], [J.lerp(mx, W - mx, e), yb]], sc.sub, lw, 0.55, false);
        label(env, pad2(li + 1), mx, y + size * 0.2, { alpha: e, size: ls * 0.9, font: mono });
        if (Pm.right) label(env, `${J.glyphCount(ln)}`, W - mx, y + size * 0.2, { alpha: e * 0.8, size: ls * 0.9, align: 'right' });
      }
      const it = { text: ln, font: Pm.font, size, align: 'left', x: x0, y, track: 0.04, color: sc.fg, mi: li * 4 };
      bb = U(bb, J.mainDraw(env, it));
      const n = [...ln].length;
      if (Pm.key && ki >= acc && ki < acc + n && e > 0) {
        const gp = glyphPts(it).filter(g => true);
        const idx0 = [...ln].slice(0, ki - acc).filter(c => !isSp(c)).length, idx1 = Math.min(gp.length - 1, idx0 + Math.min(kEnd, acc + n - 1) - ki);
        if (gp[idx0]) {
          const a0 = gp[idx0].x - gp[idx0].w / 2, a1 = gp[idx1].x + gp[idx1].w / 2;
          const q = E.outExpo(J.clamp((lt - 0.35 - li * 0.1) / 0.45)) * out;
          env.rect(a0, yb - Math.max(2, size * 0.035), (a1 - a0) * q, Math.max(3, size * 0.07), accentOn(sc), 1, false);
        }
      }
      acc += n;
    });
    return bb;
  },
});

/* ================================================================== 7 tyScaleSteps — 級数上げ */
reg('tyScaleSteps', {
  name: '級数上げ', tags: ['graphic', 'editorial', 'pop'], ae: 'mixed', w: 1, fits: n => n >= 2 && n <= 16,
  plan(rng, cut, st) {
    return { font: rng.pick(fontsOf(st, ['display', 'serif'])), dir: rng.pick(['up', 'up', 'down']), labels: rng.chance(0.8), ratio: rng.range(2.0, 2.8) };
  },
  render(env) {
    const { W, H, sc } = env, cut = env.cut, Pm = cut.params, lt = env.lt, M = Math.min(W, H);
    const port = W < H, txt = String(cut.text).trim();
    let units = (cut.words || []).map(w => String(w).trim()).filter(Boolean);
    const chars = slotsOf(txt).filter(c => !isSp(c));
    if (units.length < 2 || units.length > 7) {
      if (chars.length <= 7) units = chars;
      else { const k = Math.min(5, Math.ceil(chars.length / 3)); units = splitL(txt, Math.ceil(chars.length / k)).split('\n'); }
    }
    const k = units.length;
    const f = units.map((u, i) => { const t = k > 1 ? i / (k - 1) : 1; return Math.pow(Pm.ratio, Pm.dir === 'up' ? t : 1 - t); });
    const fmax = Math.max(...f);
    const tr = 0.02, out = outK(env), lw = hair(env), ls = labelSize(env);
    const wOf = (u, s) => J.measure({ text: u, font: Pm.font, size: s, track: tr }).w;
    let bb = null;
    const items = [];
    if (!port) {
      const gapK = 0.16, latin = isLatinT(txt) && units.length > 1 && units.length < chars.length;
      let tot = 0; units.forEach((u, i) => { tot += wOf(u, 100 * f[i]) + (i ? 100 * gapK * f[i] * (latin ? 1.6 : 0.6) : 0); });
      const base = Math.min(W * 0.86 / tot * 100, H * 0.52 / fmax);
      let x = W / 2 - tot * base / 100 / 2;
      const yb = H / 2 + base * fmax * 0.36;
      units.forEach((u, i) => {
        const s = base * f[i];
        if (i) x += s * gapK * (latin ? 1.6 : 0.6);
        items.push({ text: u, font: Pm.font, size: s, align: 'left', x, y: yb - s * 0.46, track: tr, color: sc.fg, mi: i * 2, _w: wOf(u, s), _yb: yb });
        x += wOf(u, s);
      });
      const e = E.outExpo(J.clamp((lt - 0.05) / 0.7)) * out;
      const xa = items[0].x, xb = x;
      if (e > 0) env.line([[xa, yb + base * 0.08], [J.lerp(xa, xb, e), yb + base * 0.08]], sc.sub, lw, 0.6, false);
    } else {
      let tot = 0; units.forEach((u, i) => { tot += 100 * f[i] * 1.12; });
      let base = H * 0.78 / tot * 100;
      units.forEach((u, i) => { base = Math.min(base, W * 0.8 / Math.max(0.01, wOf(u, 100 * f[i]) / 100)); });
      base = Math.min(base, W * 0.5 / fmax);
      let y = H / 2 - tot * base / 100 / 2;
      units.forEach((u, i) => {
        const s = base * f[i];
        items.push({ text: u, font: Pm.font, size: s, align: 'left', x: W * 0.1, y: y + s * 0.56, track: tr, color: sc.fg, mi: i * 2, _w: wOf(u, s), _yb: y + s * 1.06 });
        y += s * 1.12;
      });
    }
    items.forEach((it, i) => {
      const w = it._w, yb = it._yb;
      delete it._w; delete it._yb;
      bb = U(bb, J.mainDraw(env, it));
      if (Pm.labels) {
        const a = E.outCubic(J.clamp((lt - 0.25 - i * 0.07) / 0.3)) * out;
        if (a > 0) {
          const pt = Math.round(it.size / (M / 1080) * 0.75);
          if (!port) label(env, `${pt}pt`, it.x, yb + ls * 1.3, { alpha: a, size: ls * 0.85 });
          else label(env, `${pt}pt`, it.x + w + ls * 0.8, yb - ls * 0.6, { alpha: a, size: ls * 0.85 });
        }
      }
    });
    return bb;
  },
});

/* ================================================================== 8 tyJustify — 幅揃え */
const groupLines = (units, L) => {
  const lens = units.map(u => J.glyphCount(u)), tot = lens.reduce((a, b) => a + b, 0), out = [];
  let cur = '', cl = 0, acc = 0;
  units.forEach((u, i) => {
    cur += u; cl += lens[i]; acc += lens[i];
    const target = tot * (out.length + 1) / L;
    if (out.length < L - 1 && acc >= target - lens[i] * 0.4 && i < units.length - 1) { out.push(cur.trim()); cur = ''; cl = 0; }
  });
  if (cur.trim()) out.push(cur.trim());
  return out;
};
reg('tyJustify', {
  name: '幅揃え', tags: ['graphic', 'pop', 'editorial'], ae: 'stack', w: 1.1, fits: n => n >= 3 && n <= 16,
  plan(rng, cut, st) {
    return { font: rng.pick(fontsOf(st, ['display'])), rules: rng.chance(0.7), acc: rng.int(0, 3), align: rng.pick(['center', 'left']) };
  },
  render(env) {
    const { W, H, sc } = env, cut = env.cut, Pm = cut.params, lt = env.lt;
    const port = W < H, txt = String(cut.text).trim(), n = J.glyphCount(txt);
    let L = n <= 5 ? 2 : n <= 10 ? 3 : 4;
    let units = (cut.words || []).map(w => String(w)).filter(w => w.trim());
    if (isLatinT(txt)) units = txt.split(/\s+/).map((w, i) => (i ? ' ' : '') + w);
    else {
      if (units.length < 2) units = (J.segments(txt) || []).filter(w => w.trim());
      if (units.length < 2) units = [...txt];
    }
    L = Math.min(L, units.length);
    let lines = groupLines(units, L);
    for (let i = 1; i < lines.length; i++) { while (lines[i] && J.isPunct([...lines[i]][0])) { const c = [...lines[i]][0]; lines[i - 1] += c; lines[i] = lines[i].slice(c.length).trim(); } }
    lines = lines.filter(Boolean);
    if (lines.length < 2 && !isLatinT(txt)) lines = splitL(txt, Math.ceil(n / 2)).split('\n');
    const Wb = port ? W * 0.84 : Math.min(W * 0.62, H * 1.15);
    const tr = 0.01, gapK = 0.1;
    let sizes = lines.map(l => Math.min(J.fitSize(l, Pm.font, Wb, 1e6, { track: tr }), H * 0.36));
    let tot = sizes.reduce((a, s) => a + s * (1 + gapK), 0) - sizes[sizes.length - 1] * gapK;
    const k = Math.min(1, H * 0.84 / tot);
    sizes = sizes.map(s => s * k); tot *= k;
    const x0 = W / 2 - Wb * k / 2, out = outK(env), lw = hair(env);
    let y = H / 2 - tot / 2, bb = null;
    const accI = Pm.acc % lines.length;
    lines.forEach((l, li) => {
      const s = sizes[li];
      const it = { text: l, font: Pm.font, size: s, x: Pm.align === 'left' ? x0 : W / 2, align: Pm.align === 'left' ? 'left' : 'center', y: y + s / 2, track: tr, color: li === accI && lines.length > 2 ? accentOn(sc) : sc.fg, mi: li * 3 };
      bb = U(bb, J.mainDraw(env, it));
      if (Pm.rules && li < lines.length - 1) {
        const e = E.outExpo(J.clamp((lt - 0.15 - li * 0.08) / 0.6)) * out;
        const ry = y + s + s * gapK * k * 0.5;
        if (e > 0) env.line([[W / 2 - Wb * k / 2 * e, ry], [W / 2 + Wb * k / 2 * e, ry]], sc.sub, lw, 0.55, false);
      }
      y += s * (1 + gapK);
    });
    return bb;
  },
});

/* ================================================================== 9 tyIndexTable — 一覧表 */
reg('tyIndexTable', {
  name: '一覧表', tags: ['editorial', 'graphic', 'calm'], ae: 'gloss', w: 0.8, portrait: 1.3, fits: n => n >= 2 && n <= 9,
  plan(rng, cut, st) {
    return { font: rng.pick(fontsOf(st, ['display', 'serif'])), info: rng.pick(['roma', 'roma', 'code']), head: rng.chance(0.8) };
  },
  render(env) {
    const { W, H, sc, ctx } = env, cut = env.cut, Pm = cut.params, lt = env.lt, M = Math.min(W, H);
    const port = W < H;
    const chars = [...clean(cut.text)], n = chars.length;
    if (!n) return null;
    const rowH = Math.min(H * 0.78 / n, M * 0.2), gs = rowH * 0.86;
    const Wt = port ? W * 0.84 : Math.min(W * 0.56, H * 1.0);
    const x0 = W / 2 - Wt / 2, x1 = W / 2 + Wt / 2, xg = x0 + Wt * 0.24;
    const top = H / 2 - n * rowH / 2;
    const out = outK(env), lw = hair(env), mono = monoF(env);
    const fs = J.clamp(rowH * 0.3, 11, 34);
    const e0 = E.outExpo(J.clamp(lt / 0.6)) * out;
    if (e0 > 0) {
      env.line([[x0, top], [J.lerp(x0, x1, e0), top]], sc.fg, lw * 2, 0.9, false);
      env.line([[x0, top + n * rowH], [J.lerp(x0, x1, e0), top + n * rowH]], sc.fg, lw * 2, 0.9, false);
      if (Pm.head) {
        label(env, 'No.', x0, top - fs * 0.9, { alpha: e0, size: fs * 0.8 });
        label(env, Pm.info === 'code' ? 'CODE' : 'READING', x1, top - fs * 0.9, { alpha: e0, size: fs * 0.8, align: 'right' });
      }
    }
    let bb = null;
    chars.forEach((ch, i) => {
      const y = top + (i + 0.5) * rowH;
      bb = U(bb, J.mainDraw(env, { text: ch, font: Pm.font, size: gs, x: xg, y, color: sc.fg, mi: i }));
      const a = E.outCubic(J.clamp((lt - 0.12 - i * 0.06) / 0.3)) * out;
      if (a <= 0) return;
      label(env, pad2(i + 1), x0, y, { alpha: a, size: fs, color: i === 0 ? accentOn(sc) : sc.sub });
      let info = null;
      if (Pm.info !== 'code' && (J.isHira(ch) || J.isKata(ch))) { const r = J.romaji(ch); if (r) info = r.toUpperCase(); }
      if (!info) info = 'U+' + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0');
      const iw = J.measure({ text: info, font: mono, size: fs, track: 0.12 }).w;
      label(env, info, x1, y, { alpha: a, size: fs, align: 'right' });
      const la = xg + gs * 0.72, lb = x1 - iw - fs * 0.8;
      if (lb > la && env.pass === 'main') {
        ctx.save(); ctx.setLineDash([Math.max(2, lw * 2), Math.max(5, fs * 0.5)]);
        env.line([[la, y + fs * 0.2], [J.lerp(la, lb, a), y + fs * 0.2]], sc.sub, Math.max(2, lw * 2), a, false);
        ctx.restore();
      }
      if (i < n - 1) env.line([[x0, top + (i + 1) * rowH], [x1, top + (i + 1) * rowH]], sc.sub, lw, 0.22 * a, false);
    });
    return bb;
  },
});

/* ================================================================== 10 tySplitType — 断ち割り */
reg('tySplitType', {
  name: '断ち割り', tags: ['graphic', 'glitch', 'pop'], ae: 'center', w: 1, fits: n => n >= 1 && n <= 14,
  plan(rng, cut, st) {
    return { font: rng.pick(fontsOf(st, ['display'])), off: rng.range(0.08, 0.15) * rng.pick([1, -1]), cutY: rng.pick([0.02, -0.06, 0.08]), cap: rng.chance(0.75) };
  },
  render(env) {
    const { W, H, sc, ctx } = env, cut = env.cut, Pm = cut.params, lt = env.lt;
    const txt = String(cut.text).trim();
    const mt = mainLines(txt, W, H, 11, 5), L = mt.split('\n').length, lead = 1.16;
    const size = Math.min(J.fitSize(mt, Pm.font, W * 0.76, H * 0.56, { lead, track: 0.03 }), H * 0.3);
    const e = E.outExpo(J.clamp((lt - 0.12) / 0.7));
    const d = size * Pm.off * e, gy = size * 0.05 * e;
    const base = { text: mt, font: Pm.font, size, y: H / 2, lead, track: 0.03, color: sc.fg, mi: 0 };
    const ys = []; for (let li = 0; li < L; li++) ys.push(H / 2 + (li - (L - 1) / 2) * size * lead + size * Pm.cutY);
    const part = (top) => {
      ctx.save(); ctx.beginPath();
      ys.forEach((yc, li) => {
        const a = yc - size * lead / 2, b = yc + size * lead / 2;
        if (top) ctx.rect(-W, li ? a : -H, W * 3, yc - (li ? a : -H)); else ctx.rect(-W, yc, W * 3, (li < L - 1 ? b : H * 2) - yc);
      });
      ctx.clip();
      const r = J.mainDraw(env, Object.assign({}, base, { x: W / 2 + (top ? d : -d), y: H / 2 + (top ? -gy : gy) }));
      ctx.restore();
      return r;
    };
    const bb = U(part(true), part(false));
    const out = outK(env), lw = hair(env);
    if (e * out > 0.01) {
      ys.forEach((yc, li) => {
        const q = E.outExpo(J.clamp((lt - 0.2 - li * 0.08) / 0.6)) * out;
        env.line([[W * 0.04, yc], [J.lerp(W * 0.04, W * 0.96, q), yc]], accentOn(sc), Math.max(1.2, lw * 1.2), 0.9, false);
      });
      if (Pm.cap) {
        const ls = labelSize(env) * 0.85, cap = (romaOf(txt) || String(cut.lineText || txt)).slice(0, 48);
        label(env, cap, W * 0.96, ys[ys.length - 1] + ls * 0.9, { align: 'right', alpha: out * E.outCubic(J.clamp((lt - 0.4) / 0.3)), size: ls, track: 0.2 });
      }
    }
    return bb;
  },
});

/* ================================================================== 11 tyErode — 削り反復 */
reg('tyErode', {
  name: '削り反復', tags: ['emotional', 'editorial', 'calm'], ae: 'stack', w: 0.9, portrait: 0.6, fits: n => n >= 3 && n <= 12,
  plan(rng, cut, st) {
    return { font: rng.pick(fontsOf(st, ['serif', 'display'])), mode: rng.pick(['grow', 'grow', 'erode']), idx: rng.chance(0.7) };
  },
  render(env) {
    const { W, H, sc } = env, cut = env.cut, Pm = cut.params, lt = env.lt;
    const arr = slotsOf(cut.text), nS = arr.length;
    const R = Math.min(5, Math.max(2, arr.filter(c => !isSp(c)).length));
    const lens = [];
    for (let r = 0; r < R; r++) { const l = Math.max(1, Math.round(nS * (r + 1) / R)); if (!lens.includes(l)) lens.push(l); }
    if (Pm.mode === 'erode') lens.reverse();
    const rows = lens.map(l => arr.slice(0, l).join('').trim()).filter(Boolean);
    const Rn = rows.length, full = arr.join(''), leadK = 1.34;
    const size = Math.min(J.fitSize(full, Pm.font, W * 0.74, 1e6, { track: 0.04 }), H * 0.8 / (Rn * leadK), H * 0.16);
    const fw = J.measure({ text: full, font: Pm.font, size, track: 0.04 }).w;
    const x0 = W / 2 - fw / 2, out = outK(env), mainR = Pm.mode === 'erode' ? 0 : Rn - 1;
    let bb = null;
    rows.forEach((t, r) => {
      const y = H / 2 + (r - (Rn - 1) / 2) * size * leadK;
      const it = { text: t, font: Pm.font, size, align: 'left', x: x0, y, track: 0.04 };
      const tIn = r * 0.11;
      if (r === mainR) bb = J.mainDraw(env, Object.assign(it, { color: sc.fg, mi: r * 2.5 }));
      else {
        const dist = Math.abs(r - mainR) / Math.max(1, Rn - 1);
        const a = J.clamp((lt - tIn) / 0.12) * out * (0.75 - 0.45 * dist);
        if (a > 0) env.draw(Object.assign(it, { color: sc.sub, alpha: a, ghost: false }));
      }
      if (Pm.idx) {
        const a = J.clamp((lt - tIn) / 0.12) * out;
        if (a > 0) label(env, pad2(J.glyphCount(t)), x0 + fw + size * 0.5, y, { alpha: a * 0.85, size: Math.min(labelSize(env), size * 0.4), color: r === mainR ? accentOn(sc) : sc.sub });
      }
    });
    return bb;
  },
});

/* ================================================================== 12 tyVRuler — 縦目盛り */
reg('tyVRuler', {
  name: '縦目盛り', tags: ['editorial', 'calm', 'graphic'], ae: 'vcols', w: 0.9, portrait: 1.3, fits: n => n >= 1 && n <= 12,
  plan(rng, cut, st) {
    return { font: rng.pick(fontsOf(st, ['serif', 'display'])), side: rng.pick([1, -1]), lab: rng.pick(['time', 'time', 'roma']) };
  },
  render(env) {
    const { W, H, sc } = env, cut = env.cut, Pm = cut.params, lt = env.lt;
    const txt = String(cut.text).trim().replace(/[\s　]+/g, '　');
    const tr = 0.14;
    const size = Math.min(J.fitSize(txt, Pm.font, W * 0.3, H * 0.78, { vertical: true, track: tr }), W * 0.2, H * 0.2);
    const cx = W / 2 - Pm.side * size * 0.9;
    const it = { text: txt, font: Pm.font, size, x: cx, y: H / 2, vertical: true, track: tr, color: sc.fg };
    const bb = J.mainDraw(env, it);
    const gl = glyphPts(it);
    if (!gl.length) return bb;
    const out = outK(env), lw = hair(env), mono = monoF(env);
    const rx = cx + Pm.side * size * 0.85;
    const y0 = gl[0].y - size * 0.7, y1 = gl[gl.length - 1].y + size * 0.7;
    const e = E.outExpo(J.clamp(lt / 0.7)) * out;
    if (e <= 0) return bb;
    env.line([[rx, y0], [rx, J.lerp(y0, y1, e)]], sc.sub, lw, 0.8, false);
    const fs = J.clamp(size * 0.2, 10, 24), n = gl.length;
    const rom = Pm.lab === 'roma';
    gl.forEach((g, i) => {
      const a = E.outCubic(J.clamp((lt - 0.1 - i * 0.05) / 0.25)) * out;
      if (a <= 0) return;
      env.line([[rx, g.y], [rx + Pm.side * size * 0.3, g.y]], sc.sub, lw, 0.9 * a, false);
      if (i < n - 1) { const ym = (g.y + gl[i + 1].y) / 2; env.line([[rx, ym], [rx + Pm.side * size * 0.14, ym]], sc.sub, lw, 0.5 * a, false); }
      let t = null;
      if (rom && (J.isHira(g.ch) || J.isKata(g.ch))) t = (J.romaji(g.ch) || '').toUpperCase() || null;
      if (!t) t = J.fmtTime(cut.start + cut.dur * i / n);
      label(env, t, rx + Pm.side * size * 0.45, g.y, { alpha: a, size: fs, align: Pm.side > 0 ? 'left' : 'right' });
    });
    // playhead
    const u = J.clamp(lt / Math.max(0.3, cut.dur * 0.92));
    const py = J.lerp(gl[0].y, gl[n - 1].y, u), ts = fs * 0.7, ac = accentOn(sc);
    env.poly([[rx - Pm.side * 2, py], [rx - Pm.side * (ts * 1.4), py - ts], [rx - Pm.side * (ts * 1.4), py + ts]], ac, e, false);
    return bb;
  },
});

/* ================================================================== 13 tyFullTrack — 全幅字送り */
reg('tyFullTrack', {
  name: '全幅字送り', tags: ['editorial', 'calm', 'graphic'], ae: 'center', w: 1, fits: n => n >= 3 && n <= 14,
  plan(rng, cut, st) {
    return { font: rng.pick(fontsOf(st, ['display', 'serif', 'body'])), caps: rng.chance(0.8), rule: rng.chance(0.75) };
  },
  render(env) {
    const { W, H, sc } = env, cut = env.cut, Pm = cut.params, lt = env.lt;
    const port = W < H;
    const s = slotsOf(cut.text), k = s.length;
    const m0 = port ? H * 0.08 : W * 0.06;
    const size = port ? Math.min(W * 0.24, ((port ? H : W) - m0 * 2) / k * 0.8, H * 0.11) : Math.min(H * 0.2, (W - m0 * 2) / k * 0.8);
    const m = m0 + size * 0.5;
    const span = (port ? H : W) - m * 2;
    const out = outK(env), lw = hair(env);
    let bb = null, gi = 0;
    s.forEach((ch, i) => {
      if (isSp(ch)) return;
      const u = k > 1 ? i / (k - 1) : 0.5;
      const x = port ? W / 2 : m + span * u, y = port ? m + span * u : H / 2;
      bb = U(bb, J.mainDraw(env, { text: ch, font: Pm.font, size, x, y, color: sc.fg, mi: gi++ }));
    });
    const e = E.outExpo(J.clamp((lt - 0.05) / 0.8)) * out;
    if (e > 0) {
      if (Pm.rule) {
        if (!port) { const y = H / 2 + size * 0.68; env.line([[W / 2 - span / 2 * e, y], [W / 2 + span / 2 * e, y]], sc.sub, lw, 0.6, false); }
        else { const x = W / 2 + size * 0.7; env.line([[x, H / 2 - span / 2 * e], [x, H / 2 + span / 2 * e]], sc.sub, lw, 0.6, false); }
      }
      if (Pm.caps) {
        const ls = labelSize(env);
        const cap = String(cut.lineText || cut.text).replace(/\s+/g, ' ').trim().slice(0, 40);
        if (!port) {
          label(env, cap, m, H / 2 - size * 0.62 - ls, { alpha: e * 0.9, size: ls, font: bodyF(env), track: 0.14 });
          label(env, `No.${pad2((cut.line | 0) + 1)}  ${J.fmtTime(cut.start)}`, W - m, H / 2 - size * 0.62 - ls, { alpha: e * 0.9, size: ls, align: 'right' });
        } else {
          label(env, `No.${pad2((cut.line | 0) + 1)}`, W / 2 - size * 0.7, m - size * 0.9, { alpha: e * 0.9, size: ls, align: 'right' });
          label(env, J.fmtTime(cut.start), W / 2 + size * 0.7, H - m + size * 0.9, { alpha: e * 0.9, size: ls });
        }
      }
    }
    return bb;
  },
});

/* ================================================================== 14 tyStatCount — 字数表示 */
reg('tyStatCount', {
  name: '字数表示', tags: ['editorial', 'graphic'], ae: 'type', w: 0.8, fits: n => n >= 1 && n <= 16,
  plan(rng, cut, st) {
    return { font: rng.pick(fontsOf(st, ['display', 'serif'])), nf: rng.pick(fontsOf(st, ['display', 'mono'])), acc: rng.chance(0.5) };
  },
  render(env) {
    const { W, H, sc } = env, cut = env.cut, Pm = cut.params, lt = env.lt;
    const port = W < H, txt = String(cut.text).trim(), nG = J.glyphCount(txt);
    const mt = mainLines(txt, W, H, 8, 5), o = { lead: 1.2, track: 0.03 };
    const out = outK(env), lw = hair(env), ls = labelSize(env);
    const latin = !/[^\x00-\x7f]/.test(txt);
    const cnt = Math.round(nG * E.outCubic(J.clamp((lt - 0.1) / 0.9)));
    const e = E.outExpo(J.clamp((lt - 0.05) / 0.7)) * out;
    let it, nx, ny, ns;
    if (!port) {
      const size = Math.min(J.fitSize(mt, Pm.font, W * 0.5, H * 0.54, o), H * 0.2);
      it = Object.assign({ text: mt, font: Pm.font, size, align: 'left', x: W * 0.08, y: H / 2, color: sc.fg }, o);
      const rx = W * 0.65;
      if (e > 0) env.line([[rx, H / 2 - H * 0.22 * e], [rx, H / 2 + H * 0.22 * e]], sc.sub, lw, 0.7, false);
      nx = rx + W * 0.04; ny = H / 2 - H * 0.05; ns = H * 0.26;
    } else {
      const size = Math.min(J.fitSize(mt, Pm.font, W * 0.84, H * 0.42, o), W * 0.18);
      it = Object.assign({ text: mt, font: Pm.font, size, align: 'left', x: W * 0.08, y: H * 0.36, color: sc.fg }, o);
      const ry = H * 0.62;
      if (e > 0) env.line([[W * 0.08, ry], [W * 0.08 + W * 0.84 * e, ry]], sc.sub, lw, 0.7, false);
      nx = W * 0.08; ny = ry + H * 0.1; ns = W * 0.3;
    }
    const bb = J.mainDraw(env, it);
    ns = Math.min(ns, (W * 0.93 - nx) / Math.max(0.3, J.measure({ text: '00', font: Pm.nf, size: 1 }).w));
    if (e > 0) {
      env.draw({ text: pad2(cnt), font: Pm.nf, size: ns, align: 'left', x: nx, y: ny, color: Pm.acc ? accentOn(sc) : sc.fg, alpha: e, ghost: false });
      const y2 = ny + ns * 0.62;
      label(env, latin ? 'CHARACTERS' : '文字 / CHARACTERS', nx, y2, { alpha: e, size: ls, font: latin ? monoF(env) : bodyF(env) });
      label(env, `LINE ${pad2((cut.line | 0) + 1)}  ─  ${J.fmtTime(cut.start)}`, nx, y2 + ls * 1.8, { alpha: e * 0.8, size: ls * 0.85 });
    }
    return bb;
  },
});

/* ================================================================== 15 tyMargin — 余白 */
reg('tyMargin', {
  name: '余白', tags: ['calm', 'editorial', 'emotional'], ae: 'center', w: 0.8, emph: 0.4, fits: n => n >= 1 && n <= 18,
  plan(rng, cut, st) {
    return { font: rng.pick(fontsOf(st, ['serif', 'body', 'display'])), pos: rng.pick(['bl', 'bl', 'tr', 'br', 'lc']), mark: rng.chance(0.7) };
  },
  render(env) {
    const { W, H, sc } = env, cut = env.cut, Pm = cut.params, lt = env.lt, M = Math.min(W, H);
    const port = W < H, txt = String(cut.text).trim();
    const mt = J.glyphCount(txt) > (port ? 9 : 14) ? splitL(txt, port ? 8 : 12) : txt;
    const size = Math.min(M * 0.068, J.fitSize(mt, Pm.font, W * 0.66, H * 0.22, { track: 0.1, lead: 1.4 }));
    const right = Pm.pos === 'tr' || Pm.pos === 'br';
    const y = Pm.pos === 'tr' ? H * 0.2 : Pm.pos === 'lc' ? H * 0.5 : H * 0.8;
    const x = right ? W * 0.92 : W * 0.08;
    const it = { text: mt, font: Pm.font, size, x, y, align: right ? 'right' : 'left', track: 0.1, lead: 1.4, color: sc.fg };
    const bb = J.mainDraw(env, it);
    const m = J.measure(it), out = outK(env), lw = hair(env), ls = labelSize(env) * 0.9;
    const e = E.outExpo(J.clamp((lt - 0.2) / 0.9)) * out;
    if (e > 0) {
      const tx0 = right ? x - m.w : x, tx1 = right ? x : x + m.w;
      const ly = y - m.h / 2 - ls * 1.4;
      label(env, `${pad2((cut.line | 0) + 1)}  —  ${J.fmtTime(cut.start)}`, right ? x : x, ly, { alpha: e * 0.9, size: ls, align: right ? 'right' : 'left' });
      const a0 = right ? tx0 - size * 0.8 : tx1 + size * 0.8, a1 = right ? W * 0.08 : W * 0.92;
      if ((a1 - a0) * (right ? -1 : 1) > W * 0.05) {
        const yl = y + (J.glyphCount(mt) > 0 ? 0 : 0);
        env.line([[a0, yl], [J.lerp(a0, a1, e), yl]], sc.sub, lw, 0.6, false);
        if (Pm.mark) { const q = size * 0.16; env.rect(J.lerp(a0, a1, e) - q / 2, yl - q / 2, q, q, accentOn(sc), e, false); }
      }
      const rom = romaOf(txt);
      if (rom) label(env, rom, right ? x : x, y + m.h / 2 + ls * 1.3, { alpha: e * 0.75, size: ls * 0.9, align: right ? 'right' : 'left', track: 0.3 });
    }
    return bb;
  },
});

/* ================================================================== 16 tyRotBlock — 回転ブロック */
reg('tyRotBlock', {
  name: '回転ブロック', tags: ['graphic', 'pop', 'editorial'], ae: 'sideways', w: 1, fits: n => n >= 4 && n <= 16,
  plan(rng, cut, st) {
    return { font: rng.pick(fontsOf(st, ['display'])), fb: rng.pick(fontsOf(st, ['display', 'serif'])), rot: rng.pick([-90, -90, 90]), accent: rng.chance(0.5), rule: rng.chance(0.8) };
  },
  render(env) {
    const { W, H, sc } = env, cut = env.cut, Pm = cut.params, lt = env.lt;
    const port = W < H;
    const arr = slotsOf(cut.text), n = arr.length;
    const ws = (cut.words || []).map(String);
    let cutAt = Math.max(1, Math.round(n * 0.36));
    if (ws.length >= 2) { const l0 = [...ws[0].trim()].length; if (l0 >= 1 && l0 <= Math.ceil(n * 0.55)) cutAt = l0; }
    while (cutAt < n - 1 && (J.isSmallKana(arr[cutAt]) || J.isPunct(arr[cutAt]))) cutAt++;
    let A = arr.slice(0, cutAt).join('').trim() || arr[0], B = arr.slice(cutAt).join('').trim() || arr[n - 1];
    let labelA = false;
    if (isLatinT(cut.text)) {             // latin: split at a word gap; one word → the rotated block is a small line label
      const t = String(cut.text).trim(), sp = t.indexOf(' ');
      if (sp > 0) { A = t.slice(0, sp); B = t.slice(sp + 1).trim(); }
      else { A = `LINE ${pad2((cut.line | 0) + 1)}`; B = t; labelA = true; }
    }
    const Hb = port ? H * 0.44 : H * 0.62;
    const wA100 = J.measure({ text: A, font: Pm.font, size: 100, track: 0.02 }).w;
    const sizeA = Math.min(Hb / wA100 * 100, port ? W * 0.3 : W * 0.24, labelA ? Math.min(W, H) * 0.06 : 1e9);
    const gap = sizeA * 0.28;
    const Wb = (port ? W * 0.86 : Math.min(W * 0.84, Hb * 2.4)) - sizeA - gap;
    let best = null;
    const nB = J.glyphCount(B);
    for (let Lc = 1; Lc <= 3; Lc++) {
      if (Lc > nB) break;
      let bt = Lc === 1 ? B : splitL(B, Math.ceil(nB / Lc));
      if (Lc > 1 && isLatinT(B)) { const ws = B.split(/\s+/); if (ws.length < Lc) break; bt = groupLines(ws.map((w, i) => (i ? ' ' : '') + w), Lc).join('\n'); }
      const s = Math.min(J.fitSize(bt, Pm.fb, Wb, Hb, { lead: 1.08, track: 0.02 }), Hb * 0.6);
      if (!best || s > best.s * 1.05) best = { bt, s };
    }
    const mB = J.measure({ text: best.bt, font: Pm.fb, size: best.s, lead: 1.08, track: 0.02 });
    const wA = wA100 * sizeA / 100;
    const tot = sizeA + gap + mB.w;
    const xA = W / 2 - tot / 2 + sizeA / 2, xB = xA + sizeA / 2 + gap;
    const out = outK(env), lw = hair(env);
    const bh = Math.max(wA, mB.h);
    if (Pm.rule) {
      const e = E.outExpo(J.clamp((lt - 0.1) / 0.6)) * out;
      if (e > 0) env.line([[xA + sizeA / 2 + gap / 2, H / 2 - bh / 2 * e], [xA + sizeA / 2 + gap / 2, H / 2 + bh / 2 * e]], sc.sub, lw, 0.7, false);
    }
    const itA = { text: A, font: Pm.font, size: sizeA, x: xA, y: H / 2, rot: Pm.rot, track: 0.02, color: Pm.accent ? accentOn(sc) : sc.fg, mi: 0 };
    if (labelA) env.draw(Object.assign(itA, { font: monoF(env), color: sc.sub, alpha: E.outCubic(J.clamp(lt / 0.4)) * out, ghost: false }));
    else J.mainDraw(env, itA);
    J.mainDraw(env, { text: best.bt, font: Pm.fb, size: best.s, x: xB, y: H / 2, align: 'left', lead: 1.08, track: 0.02, color: sc.fg, mi: 3 });
    return bbRect(xA - sizeA / 2, H / 2 - bh / 2, xB + mB.w, H / 2 + bh / 2);
  },
});

/* ================================================================== 17 tySquare — 方形組 */
reg('tySquare', {
  name: '方形組', tags: ['graphic', 'editorial', 'pop'], ae: 'gridCells', w: 1, fits: n => n >= 3 && n <= 16,
  plan(rng, cut, st) {
    return { font: rng.pick(fontsOf(st, ['display', 'serif'])), order: rng.pick(['yoko', 'yoko', 'tate']), frame: rng.chance(0.75), acc: rng.chance(0.7) };
  },
  render(env) {
    const { W, H, sc } = env, cut = env.cut, Pm = cut.params, lt = env.lt, M = Math.min(W, H);
    const chars = [...clean(cut.text)], n = chars.length;
    if (!n) return null;
    const tate = Pm.order === 'tate';
    const a = Math.ceil(Math.sqrt(n)), b = Math.ceil(n / a);
    const cols = tate ? b : a, rows = tate ? a : b;
    const cell = Math.min(W * 0.78 / cols, H * 0.74 / rows, M * 0.3);
    const x0 = W / 2 - cols * cell / 2, y0 = H / 2 - rows * cell / 2;
    const ki = keyIndex(chars, 'kanji');
    const out = outK(env), lw = hair(env), ls = labelSize(env);
    let bb = null;
    const pos = i => (tate ? [cols - 1 - Math.floor(i / rows), i % rows] : [i % cols, Math.floor(i / cols)]);
    for (let i = 0; i < cols * rows; i++) {
      const [c, r] = pos(i), x = x0 + (c + 0.5) * cell, y = y0 + (r + 0.5) * cell;
      if (i < n) bb = U(bb, J.mainDraw(env, { text: chars[i], font: Pm.font, size: cell * 0.9, x, y, vertical: tate, color: Pm.acc && i === ki ? accentOn(sc) : sc.fg, mi: i }));
      else {
        const q = E.outBack(J.clamp((lt - 0.2 - i * 0.03) / 0.3), 2) * out, s = cell * 0.08;
        if (q > 0) { env.line([[x - s * q, y], [x + s * q, y]], sc.sub, lw, 0.8, false); env.line([[x, y - s * q], [x, y + s * q]], sc.sub, lw, 0.8, false); }
      }
    }
    if (Pm.frame) {
      const e = E.outExpo(J.clamp((lt - 0.05) / 0.7)) * out;
      if (e > 0) {
        const xa = x0, xb = x0 + cols * cell, g = cell * 0.12;
        env.line([[xa, y0 - g], [J.lerp(xa, xb, e), y0 - g]], sc.fg, Math.max(2, lw * 2.4), 0.9, false);
        env.line([[xb, y0 + rows * cell + g], [J.lerp(xb, xa, e), y0 + rows * cell + g]], sc.sub, lw, 0.8, false);
        label(env, `${cols}×${rows}`, xb, y0 + rows * cell + g + ls * 1.1, { align: 'right', alpha: e, size: ls * 0.9 });
        label(env, tate ? '縦組' : 'YOKO', xa, y0 + rows * cell + g + ls * 1.1, { alpha: e * 0.8, size: ls * 0.9, font: tate ? bodyF(env) : monoF(env) });
      }
    }
    return bb;
  },
});

/* ================================================================== 18 tyLineFocus — 行中強調 */
reg('tyLineFocus', {
  name: '行中強調', tags: ['editorial', 'emotional', 'calm'], ae: 'center', w: 1, fits: n => n >= 1 && n <= 16,
  plan(rng, cut, st) {
    return { font: rng.pick(fontsOf(st, ['serif', 'display', 'body'])), mark: rng.pick(['bar', 'bar', 'dot', 'box']) };
  },
  render(env) {
    const { W, H, sc } = env, cut = env.cut, Pm = cut.params, lt = env.lt, M = Math.min(W, H);
    const port = W < H;
    const cutT = String(cut.text).trim();
    let line = String(cut.lineText || cutT).trim();
    if (J.glyphCount(line) > 36) line = cutT;
    const nsI = (s, end) => [...s].slice(0, end).filter(c => !/\s/.test(c)).length;
    let s0, s1, same = false;
    const at = line.indexOf(cutT);
    if (at < 0 || line === cutT) {
      line = cutT; same = true;
      const arr = [...line];
      let ki = keyIndex(arr, 'kanji');
      let ke = ki;
      if (J.isKanji(arr[ki])) while (ke + 1 < arr.length && J.isKanji(arr[ke + 1])) ke++;
      else { while (ke + 1 < arr.length && ke - ki < 2 && !isSp(arr[ke + 1]) && !J.isPunct(arr[ke + 1])) ke++; }
      if (isLatinT(line)) {
        const re = /\S+/g; let m, best = null;
        while ((m = re.exec(line))) if (!best || m[0].length > best[0].length) best = m;
        if (best) { ki = [...line.slice(0, best.index)].length; ke = ki + [...best[0]].length - 1; }
      }
      s0 = nsI(line, ki); s1 = nsI(line, ke + 1);
    } else {
      const pre = [...line.slice(0, at)].length;
      s0 = nsI(line, pre); s1 = s0 + J.glyphCount(cutT);
    }
    const nAll = J.glyphCount(line);
    const mt = nAll > (port ? 7 : 12) ? splitL(line, Math.ceil(nAll / Math.ceil(nAll / (port ? 6 : 11)))) : line;
    const o = { lead: 1.7, track: 0.08 };
    const size = Math.min(J.fitSize(mt, Pm.font, W * 0.82, H * 0.56, o), M * 0.12);
    const it = Object.assign({ text: mt, font: Pm.font, size, x: W / 2, y: H / 2 }, o);
    const gl = glyphPts(it), out = outK(env), ac = accentOn(sc);
    const dimA = E.outCubic(J.clamp(lt / 0.3)) * out;
    let bb = null, j = 0;
    const spanBy = new Map();
    gl.forEach((g, i) => {
      if (i >= s0 && i < s1) {
        bb = U(bb, J.mainDraw(env, { text: g.ch, font: Pm.font, size, x: g.x, y: g.y, color: sc.fg, mi: j++ }));
        const L = spanBy.get(g.li) || { a: 1e9, b: -1e9, g: [] }; L.a = Math.min(L.a, g.x - g.w / 2); L.b = Math.max(L.b, g.x + g.w / 2); L.g.push(g); spanBy.set(g.li, L);
      } else if (dimA > 0) env.draw({ text: g.ch, font: Pm.font, size, x: g.x, y: g.y, color: same ? sc.fg : sc.sub, alpha: dimA * (same ? 0.5 : 0.42), ghost: false });
    });
    let k = 0;
    for (const L of spanBy.values()) {
      const q = E.outExpo(J.clamp((lt - 0.25 - k * 0.1) / 0.5)) * out; k++;
      if (q <= 0) continue;
      const y = L.g[0].y;
      if (Pm.mark === 'bar') env.rect(L.a, y + size * 0.62, (L.b - L.a) * q, Math.max(3, size * 0.07), ac, 1, false);
      else if (Pm.mark === 'dot') L.g.forEach(g => env.circle(g.x, g.y - size * 0.72, size * 0.07 * q, ac, null, 0, 1, false));
      else env.rrect(L.a - size * 0.14, y - size * 0.64, (L.b - L.a + size * 0.28), size * 1.28, 0, null, q, false, ac, Math.max(1.5, size * 0.03));
    }
    return bb || bbRect(W * 0.3, H * 0.4, W * 0.7, H * 0.6);
  },
});

})();

return J;
}
