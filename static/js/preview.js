// Real-time preview: composites all tracks + captions onto one canvas.
import { state, emit, projectDuration, clipEnd } from './store.js';
import { drawCaptions } from './captions.js';
import { clamp } from './util.js';

const els = new Map();   // clipId -> { el, mediaId }
let canvas, ctx;
const clock = { t0: 0, wall0: 0 };
const frameHooks = [];
export const onFrame = fn => frameHooks.push(fn);

export function initPreview(c) {
  canvas = c;
  ctx = c.getContext('2d');
  resizePreview();
  requestAnimationFrame(loop);
}

export function resizePreview() {
  const { width: W, height: H } = state.project.settings;
  const s = Math.min(1, 1280 / Math.max(W, H));
  const w = Math.round(W * s), h = Math.round(H * s);
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
}

export function play() {
  const D = projectDuration();
  if (D <= 0) return;
  if (state.time >= D - 0.02) state.time = 0;
  state.playing = true;
  clock.t0 = state.time;
  clock.wall0 = performance.now();
  emit('play');
}

export function pause() {
  state.playing = false;
  for (const { el } of els.values()) if (el.pause && !el.paused) el.pause();
  emit('play');
}

export const togglePlay = () => (state.playing ? pause() : play());

export function seek(t) {
  state.time = clamp(t, 0, Math.max(projectDuration(), 0));
  if (state.playing) { clock.t0 = state.time; clock.wall0 = performance.now(); }
  emit('time');
}

function getEl(clip, media) {
  const e = els.get(clip.id);
  if (e && e.mediaId === media.id) return e.el;
  let el;
  if (media.kind === 'image') {
    el = new Image();
    el.src = media.play;
  } else {
    el = document.createElement(media.kind === 'audio' ? 'audio' : 'video');
    el.src = media.play;
    el.preload = 'auto';
    el.playsInline = true;
  }
  els.set(clip.id, { el, mediaId: media.id });
  return el;
}

function syncMedia(el, clip, track, t) {
  const target = clip.in + (t - clip.start);
  el.muted = !!track.muted;
  el.volume = clamp((clip.volume ?? 1) * fadeGain(clip, t - clip.start), 0, 1);
  if (state.playing) {
    if (el.paused) {
      if (Math.abs(el.currentTime - target) > 0.05) el.currentTime = target;
      el.play().catch(() => {});
    } else if (Math.abs(el.currentTime - target) > 0.3) {
      el.currentTime = target;
    }
  } else {
    if (!el.paused) el.pause();
    if (!el.seeking && Math.abs(el.currentTime - target) > 0.02) el.currentTime = target;
  }
}

/** Linear fade in/out multiplier at local clip time lt. */
export function fadeGain(clip, lt) {
  const dur = clip.out - clip.in;
  let g = 1;
  if (clip.fadeIn > 0) g = Math.min(g, lt / clip.fadeIn);
  if (clip.fadeOut > 0) g = Math.min(g, (dur - lt) / clip.fadeOut);
  return clamp(g, 0, 1);
}

function drawClip(el, clip, media, W, H) {
  let sw, sh;
  if (media.kind === 'image') {
    if (!el.complete || !el.naturalWidth) return;
    sw = el.naturalWidth; sh = el.naturalHeight;
  } else {
    if (el.readyState < 2 || !el.videoWidth) return;
    sw = el.videoWidth; sh = el.videoHeight;
  }
  const scale = clip.scale ?? 1;
  const k = Math.min(W / sw, H / sh) * scale;
  const dw = sw * k, dh = sh * k;
  const x = (W - dw) / 2 + (clip.x || 0) * W;
  const y = (H - dh) / 2 + (clip.y || 0) * H;
  ctx.globalAlpha = clip.opacity ?? 1;
  ctx.drawImage(el, x, y, dw, dh);
  ctx.globalAlpha = 1;
}

let lastGc = 0;
function loop(now) {
  requestAnimationFrame(loop);
  const p = state.project;
  if (!p) return;
  resizePreview();
  if (state.playing) {
    const D = projectDuration();
    state.time = clock.t0 + (now - clock.wall0) / 1000;
    if (state.time >= D) { state.time = D; pause(); }
  }
  const t = state.time;
  const W = canvas.width, H = canvas.height;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);

  const active = new Set();
  // tracks[0] is the top layer → draw from the end.
  for (let ti = p.tracks.length - 1; ti >= 0; ti--) {
    const track = p.tracks[ti];
    for (const clip of track.clips) {
      const media = state.media[clip.mediaId];
      if (!media) continue;
      const end = clipEnd(clip);
      if (t >= clip.start && t < end) {
        active.add(clip.id);
        const el = getEl(clip, media);
        if (media.kind !== 'image') syncMedia(el, clip, track, t);
        if (!track.hidden && !clip.audioOnly && media.kind !== 'audio') drawClip(el, clip, media, W, H);
      } else if (media.kind !== 'image' && clip.start > t && clip.start - t < 1.2) {
        // Pre-roll: have the next clip parked on its first frame.
        const el = getEl(clip, media);
        if (el.paused && !el.seeking && Math.abs(el.currentTime - clip.in) > 0.05) el.currentTime = clip.in;
      }
    }
  }
  for (const [id, { el }] of els) {
    if (!active.has(id) && el.pause && !el.paused) el.pause();
  }
  if (now - lastGc > 5000) {
    lastGc = now;
    const alive = new Set(p.tracks.flatMap(t => t.clips.map(c => c.id)));
    for (const [id, { el }] of els) if (!alive.has(id)) { if (el.pause) el.pause(); el.removeAttribute('src'); els.delete(id); }
  }

  drawCaptions(ctx, W, H, p.captionTracks, t);
  for (const fn of frameHooks) fn(t);
}
