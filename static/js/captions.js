// Caption styles + the one canvas renderer used for BOTH live preview and export,
// so what you see is exactly what gets burned into the video.

export const FONTS = ['Inter', 'Montserrat', 'Poppins', 'Anton', 'Bangers', 'Bebas Neue', 'Permanent Marker', 'Space Mono', 'Georgia', 'Arial'];

// mode:      block = whole caption visible · word = one word at a time · reveal = words appear as spoken
// highlight: none | color (active word in accent) | box (accent pill behind word) | dim (others faded) | cycle
// box:       none | full (one box behind all lines) | line (a pill per line)
// anim:      none | fade | pop | slide   (caption entrance)
const BASE = {
  mode: 'block', font: 'Inter', weight: 700, size: 1, color: '#FFFFFF', accent: '#FFE600',
  highlight: 'none', stroke: 0, strokeColor: '#000000', box: 'none', boxColor: '#000000', boxOpacity: 0.6,
  anim: 'fade', wordPop: false, uppercase: false, lowercase: false, italic: false, rotate: 0,
  shadow: 0.4, glow: 0, maxWords: 5, position: 'bottom', offset: 0,
};

const DEFS = {
  karaoke:    { label: 'Karaoke', font: 'Montserrat', weight: 900, size: 1.15, accent: '#FFE600', highlight: 'color', stroke: 0.18, anim: 'pop', wordPop: true, uppercase: true, maxWords: 3, shadow: 0.5 },
  boxed:      { label: 'Highlight box', font: 'Poppins', weight: 800, size: 1.05, accent: '#7C3AED', highlight: 'box', anim: 'pop', wordPop: true, maxWords: 4, shadow: 0.6 },
  oneword:    { label: 'One word', mode: 'word', font: 'Anton', weight: 400, size: 2.1, accent: '#FFE600', highlight: 'cycle', stroke: 0.1, anim: 'pop', uppercase: true, maxWords: 4, position: 'middle', shadow: 0.6 },
  classic:    { label: 'Classic', font: 'Inter', weight: 600, size: 0.9, box: 'full', boxOpacity: 0.62, anim: 'fade', maxWords: 8, shadow: 0 },
  bubble:     { label: 'Bubble', font: 'Poppins', weight: 700, size: 0.95, color: '#111111', accent: '#111111', box: 'line', boxColor: '#FFFFFF', boxOpacity: 1, anim: 'pop', maxWords: 6, shadow: 0 },
  neon:       { label: 'Neon', font: 'Poppins', weight: 700, size: 1.05, color: '#5EEBFF', accent: '#FF4FD8', highlight: 'color', glow: 1, anim: 'fade', maxWords: 5, shadow: 0 },
  comic:      { label: 'Comic', font: 'Bangers', weight: 400, size: 1.4, color: '#FFD60A', accent: '#FFFFFF', highlight: 'color', stroke: 0.16, anim: 'pop', wordPop: true, rotate: -3, uppercase: true, maxWords: 3, shadow: 0.7 },
  typewriter: { label: 'Typewriter', mode: 'reveal', font: 'Space Mono', weight: 700, size: 0.85, box: 'full', boxColor: '#111111', boxOpacity: 0.85, anim: 'none', maxWords: 8, shadow: 0 },
  minimal:    { label: 'Minimal', font: 'Inter', weight: 500, size: 0.85, highlight: 'dim', anim: 'slide', lowercase: true, maxWords: 6, shadow: 0.7 },
  marker:     { label: 'Marker', font: 'Permanent Marker', weight: 400, size: 1.1, color: '#FFFFFF', accent: '#FF5C7A', highlight: 'color', stroke: 0.12, anim: 'pop', wordPop: true, maxWords: 4, shadow: 0.5, rotate: 2 },
};

export const PRESETS = Object.fromEntries(Object.entries(DEFS).map(([key, d]) => {
  const full = { ...BASE, ...d };
  return [key, { ...full, defaults: () => { const { label, ...rest } = full; return rest; } }];
}));

export const resolveStyle = style => ({ ...BASE, ...PRESETS[style.preset], ...style });

const INTRO = 0.2;   // seconds of caption entrance animation
const POP = 0.14;    // seconds of active-word pop
const CYCLE = ['#FFFFFF', null, '#4ADE80'];  // null → accent

const easeOutBack = p => { const c = 1.9; return 1 + (c + 1) * Math.pow(p - 1, 3) + c * Math.pow(p - 1, 2); };
const easeOut = p => 1 - Math.pow(1 - p, 3);
const clamp01 = x => Math.max(0, Math.min(1, x));

export function fontString(S, px) {
  return `${S.italic ? 'italic ' : ''}${S.weight} ${Math.round(px)}px "${S.font}", "Inter", sans-serif`;
}

export async function loadFonts(styles) {
  if (!document.fonts) return;
  await Promise.all(styles.map(s => {
    const S = resolveStyle(s);
    return document.fonts.load(fontString(S, 40)).catch(() => {});
  }));
}

function activeIndex(words, t) {
  let ai = -1;
  for (let i = 0; i < words.length; i++) if (words[i].t0 <= t + 1e-4) ai = i;
  return ai;
}

function transformText(S, text) {
  return S.uppercase ? text.toUpperCase() : S.lowercase ? text.toLowerCase() : text;
}

function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, h / 2, w / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function hexA(hex, a) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/**
 * Draw every visible caption track at time t. Returns a signature string that is
 * identical whenever the drawn image would be identical (used to dedupe export frames),
 * or '' when nothing was drawn.
 */
export function drawCaptions(ctx, W, H, tracks, t) {
  let sig = '';
  // Bottom of the list draws first so the top caption track ends up on top.
  for (let i = tracks.length - 1; i >= 0; i--) {
    const tr = tracks[i];
    if (tr.hidden) continue;
    const seg = tr.segments.find(s => t >= s.start && t < s.end);
    if (!seg || !seg.words.length) continue;
    sig += drawSegment(ctx, W, H, seg, resolveStyle(tr.style), t) + '|';
  }
  return sig;
}

/**
 * Per-format text sizing. Portrait (TikTok/Reels/Shorts) gets bigger text sized off the
 * width; landscape gets classic subtitle proportions sized off the height.
 */
const FORMATS = {
  portrait:  { font: 0.074, ref: 'W', maxLines: 3 },
  square:    { font: 0.064, ref: 'W', maxLines: 3 },
  landscape: { font: 0.054, ref: 'H', maxLines: 2 },
};
export function formatOf(W, H) {
  const ar = W / H;
  return ar < 0.8 ? 'portrait' : ar > 1.25 ? 'landscape' : 'square';
}

// Placement: text spans 84% of the width; the block's top edge sits at 9% (top), its
// bottom edge at 91% (bottom), or it is centred (middle), never closer than 4% to an edge.
export const POSITIONS = ['top', 'middle', 'bottom'];
const LINE_WIDTH = 0.84, EDGE = 0.09, SAFE = 0.04;

function layoutLines(ctx, S, words, px, maxW) {
  ctx.font = fontString(S, px);
  const space = ctx.measureText(' ').width;
  const widths = words.map(w => ctx.measureText(w.text).width);
  const lines = [];
  let cur = [], curW = 0;
  words.forEach((w, k) => {
    const add = (cur.length ? space : 0) + widths[k];
    if (cur.length && curW + add > maxW) { lines.push({ items: cur, w: curW }); cur = []; curW = 0; }
    cur.push({ ...w, w: widths[k] });
    curW += (cur.length > 1 ? space : 0) + widths[k];
  });
  if (cur.length) lines.push({ items: cur, w: curW });
  return { lines, space, widest: Math.max(...widths) };
}

export function drawSegment(ctx, W, H, seg, S, t) {
  const F = FORMATS[formatOf(W, H)];
  const ai = activeIndex(seg.words, t);
  const aiC = Math.max(ai, 0);
  let words = seg.words.map((w, i) => ({ ...w, i, text: transformText(S, w.text) }));
  if (S.mode === 'word') words = [words[aiC]];

  // Layout: wrap within the format's line width; shrink if a word is too wide
  // or the caption needs more lines than the format allows.
  const maxW = W * LINE_WIDTH;
  let px = (F.ref === 'W' ? W : H) * F.font * S.size;
  let L = layoutLines(ctx, S, words, px, maxW);
  for (let k = 0; k < 6 && (L.widest > maxW || (S.mode !== 'word' && L.lines.length > F.maxLines)); k++) {
    px *= L.widest > maxW ? Math.max(0.5, maxW / L.widest) : 0.88;
    L = layoutLines(ctx, S, words, px, maxW);
  }
  const { lines, space } = L;

  const lh = px * 1.22;
  const blockH = lines.length * lh;
  const blockW = Math.max(...lines.map(l => l.w));
  const pad = px * 0.32;
  let blockTop = S.position === 'top' ? H * EDGE
    : S.position === 'middle' ? (H - blockH) / 2
    : H * (1 - EDGE) - blockH;
  blockTop += (S.offset || 0) * H;
  blockTop = Math.max(H * SAFE + pad, Math.min(H - blockH - H * SAFE - pad, blockTop));
  const cy = blockTop + blockH / 2;
  const cx = W / 2;

  // Entrance animation (per segment, or per word in "word" mode).
  const introStart = S.mode === 'word' ? seg.words[aiC].t0 : seg.start;
  const pIntro = S.anim === 'none' ? 1 : clamp01((t - Math.max(introStart, seg.start)) / INTRO);
  let alpha = 1, scale = 1, dy = 0;
  if (pIntro < 1) {
    if (S.anim === 'fade') alpha = easeOut(pIntro);
    if (S.anim === 'pop') { scale = 0.6 + 0.4 * easeOutBack(pIntro); alpha = clamp01(pIntro * 3); }
    if (S.anim === 'slide') { dy = (1 - easeOut(pIntro)) * px * 0.6; alpha = easeOut(pIntro); }
  }
  const pWord = (S.wordPop && ai >= 0) ? clamp01((t - seg.words[ai].t0) / POP) : 1;
  const revealN = S.mode === 'reveal' ? ai + 1 : words.length;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(cx, cy + dy);
  if (S.rotate) ctx.rotate(S.rotate * Math.PI / 180);
  ctx.scale(scale, scale);
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;

  const top = -blockH / 2;
  if (S.box === 'full' && S.boxOpacity > 0) {
    ctx.fillStyle = hexA(S.boxColor, S.boxOpacity);
    roundRect(ctx, -blockW / 2 - pad * 1.3, top - pad * 0.7, blockW + pad * 2.6, blockH + pad * 1.4, px * 0.28);
    ctx.fill();
  }

  lines.forEach((line, li) => {
    const ly = top + lh * (li + 0.5);
    let x = -line.w / 2;
    if (S.box === 'line' && S.boxOpacity > 0) {
      ctx.fillStyle = hexA(S.boxColor, S.boxOpacity);
      roundRect(ctx, x - pad, ly - lh / 2 + px * 0.02, line.w + pad * 2, lh - px * 0.04, px * 0.3);
      ctx.fill();
    }
    for (const w of line.items) {
      const isActive = w.i === ai;
      if (S.mode !== 'reveal' || w.i < revealN) drawWord(ctx, S, w, x, ly, px, isActive, isActive ? pWord : 1);
      x += w.w + space;
    }
  });
  ctx.restore();

  return `${seg.id}:${S.mode === 'word' ? aiC : ai}:${revealN}:${pIntro.toFixed(3)}:${pWord.toFixed(3)}`;
}

function drawWord(ctx, S, w, x, y, px, active, pPop) {
  let color = S.color;
  if (S.highlight === 'color' && active) color = S.accent;
  if (S.highlight === 'cycle') color = CYCLE[w.i % 3] ?? S.accent;
  const dim = S.highlight === 'dim' && !active;

  ctx.save();
  const cxw = x + w.w / 2;
  ctx.translate(cxw, y);
  if (active && S.wordPop) {
    const s = 1 + 0.14 * easeOutBack(pPop) - 0.02;
    ctx.scale(s, s);
  }
  if (dim) ctx.globalAlpha *= 0.5;
  ctx.font = fontString(S, px);

  if (S.highlight === 'box' && active) {
    const padX = px * 0.18, h = px * 1.18;
    ctx.save();
    ctx.shadowColor = 'transparent';
    ctx.fillStyle = S.accent;
    const k = S.wordPop ? 0.85 + 0.15 * easeOut(pPop) : 1;
    ctx.scale(k, k);
    roundRect(ctx, -w.w / 2 - padX, -h / 2, w.w + padX * 2, h, px * 0.22);
    ctx.fill();
    ctx.restore();
  }

  const tx = -w.w / 2;
  if (S.shadow > 0) {
    ctx.shadowColor = 'rgba(0,0,0,0.65)';
    ctx.shadowBlur = px * 0.25 * S.shadow;
    ctx.shadowOffsetY = px * 0.06 * S.shadow;
  }
  if (S.stroke > 0) {
    ctx.lineWidth = px * S.stroke;
    ctx.strokeStyle = S.strokeColor;
    ctx.strokeText(w.text, tx, 0);
    ctx.shadowColor = 'transparent';
  }
  if (S.glow > 0) {
    ctx.shadowColor = color;
    ctx.shadowBlur = px * 0.5 * S.glow;
    ctx.shadowOffsetY = 0;
    ctx.fillStyle = color;
    ctx.fillText(w.text, tx, 0);
  }
  ctx.fillStyle = color;
  ctx.fillText(w.text, tx, 0);
  ctx.restore();
}

/** Every time at which the caption image may change (for export). */
export function captionKeyTimes(tracks, fps, D) {
  const set = new Set([0]);
  const add = x => { if (x >= 0 && x < D) set.add(Math.round(x * 1000) / 1000); };
  const step = 1 / fps;
  for (const tr of tracks) {
    if (tr.hidden) continue;
    const S = resolveStyle(tr.style);
    for (const seg of tr.segments) {
      add(seg.start); add(seg.end);
      const animWords = S.wordPop || (S.mode === 'word' && S.anim !== 'none');
      if (S.anim !== 'none') for (let k = 1; k * step <= INTRO + step; k++) add(seg.start + k * step);
      for (const w of seg.words) {
        add(w.t0);
        if (animWords) for (let k = 1; k * step <= POP + step; k++) add(w.t0 + k * step);
      }
    }
  }
  return [...set].sort((a, b) => a - b);
}

/** Group timed words into caption segments. */
export function groupWords(words, maxWords = 4, maxChars = 34) {
  const segs = [];
  let cur = [];
  const flush = () => {
    if (!cur.length) return;
    segs.push({ id: Math.random().toString(36).slice(2, 10), start: cur[0].t0, end: cur[cur.length - 1].t1, words: cur.map(w => ({ ...w })) });
    cur = [];
  };
  for (const w of words) {
    const prev = cur[cur.length - 1];
    const chars = cur.reduce((n, x) => n + x.text.length + 1, 0) + w.text.length;
    if (prev && (cur.length >= maxWords || w.t0 - prev.t1 > 0.6 || /[.!?…]$/.test(prev.text) || chars > maxChars)) flush();
    cur.push(w);
  }
  flush();
  // Close tiny gaps so captions don't flicker, and give short ones a minimum duration.
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i], next = segs[i + 1];
    const limit = next ? next.start : Infinity;
    s.end = Math.min(limit, Math.max(s.end + 0.25, s.start + 0.5));
    if (next && next.start - s.end < 0.35) s.end = next.start;
  }
  return segs;
}

export function toSRT(track) {
  const ts = t => {
    const ms = Math.round(t * 1000);
    const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
  };
  return track.segments.map((s, i) => `${i + 1}\n${ts(s.start)} --> ${ts(s.end)}\n${s.words.map(w => w.text).join(' ')}\n`).join('\n');
}
