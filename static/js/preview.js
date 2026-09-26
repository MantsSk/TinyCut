// Real-time preview: composites all tracks + captions onto one canvas.
// Sound comes from audio.js (Web Audio); video elements here are always muted and follow its clock.
import { state, emit, projectDuration, clipEnd } from './store.js';
import { drawCaptions } from './captions.js';
import { restartAudio, stopAudio, timelineTime } from './audio.js';
import { clamp } from './util.js';

const els = new Map();   // clipId -> { el, mediaId }
let canvas, ctx, pool;
const clock = { t0: 0, wall0: 0 };  // fallback clock when audio isn't running
const frameHooks = [];
export const onFrame = fn => frameHooks.push(fn);

// Which codecs this web engine can decode. Linux's Qt WebEngine has no H.264/HEVC and Windows'
// WebView2 usually lacks HEVC; those clips are previewed from a VP9 copy the server makes.
const probe = document.createElement('video');
const CAN_PLAY = {
  h264: !!probe.canPlayType('video/mp4; codecs="avc1.42E01E"'),
  hevc: !!probe.canPlayType('video/mp4; codecs="hvc1.1.6.L93.B0"'),
  vp9: !!probe.canPlayType('video/webm; codecs="vp9"'),
  vp8: !!probe.canPlayType('video/webm; codecs="vp8"'),
  av1: !!probe.canPlayType('video/mp4; codecs="av01.0.05M.08"'),
};
export const canPlayH264 = CAN_PLAY.h264;
function videoUrl(media) {
  // media.play is either the original or an H.264 proxy (made at import for exotic formats).
  const codec = media.play.endsWith('/proxy.mp4') ? 'h264' : media.vcodec;
  return CAN_PLAY[codec] ? media.play : `/api/media/${media.id}/preview-webm`;
}

/** Have the server prepare preview copies ahead of playback for clips this engine can't decode. */
const warmed = new Set();
export function warmPreviews() {
  for (const tr of state.project.tracks) for (const c of tr.clips) {
    const m = state.media[c.mediaId];
    if (m?.kind !== 'video' || warmed.has(m.id)) continue;
    warmed.add(m.id);
    const url = videoUrl(m);
    if (url !== m.play) fetch(url, { method: 'HEAD' }).catch(() => {});
  }
}

export function initPreview(c) {
  canvas = c;
  ctx = c.getContext('2d');
  // Media elements must live in the document: detached <video>s get throttled decoding
  // (badly in WebKit, i.e. the macOS app). Keep them 2px, practically invisible, behind the UI.
  pool = document.createElement('div');
  pool.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;overflow:hidden;opacity:0.01;pointer-events:none;z-index:-1';
  document.body.appendChild(pool);
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
  restartAudio(state.time);
  emit('play');
}

export function pause() {
  state.playing = false;
  stopAudio();
  for (const { el } of els.values()) if (el.pause && !el.paused) el.pause();
  emit('play');
}

export const togglePlay = () => (state.playing ? pause() : play());

export function seek(t) {
  state.time = clamp(t, 0, Math.max(projectDuration(), 0));
  if (state.playing) {
    clock.t0 = state.time;
    clock.wall0 = performance.now();
    restartAudio(state.time);
  }
  emit('time');
}

/** Re-sync sound after the timeline was edited during playback. */
export function refreshPlayback() {
  if (state.playing) restartAudio(state.time);
}

/** Visual element for a clip (video or image); audio-only clips have none. */
function getEl(clip, media) {
  const e = els.get(clip.id);
  if (e && e.mediaId === media.id) return e.el;
  let el;
  if (media.kind === 'image') {
    el = new Image();
    el.src = media.play;
  } else {
    el = document.createElement('video');
    el.src = videoUrl(media);
    el.preload = 'auto';
    el.playsInline = true;
    el.muted = true;  // sound is played by audio.js
    el.style.cssText = 'width:2px;height:2px';
    pool.appendChild(el);
  }
  els.set(clip.id, { el, mediaId: media.id });
  return el;
}

function syncVideo(el, clip, t, now) {
  const target = clip.in + (t - clip.start);
  if (state.playing) {
    if (el.paused) {
      if (Math.abs(el.currentTime - target) > 0.05) el.currentTime = target;
      el.play().catch(() => {});
    } else if (Math.abs(el.currentTime - target) > 0.25 && !el.seeking && now - (el.__fixedAt || 0) > 1000) {
      // Resync a video that drifted; at most once a second so a slow decoder can't get stuck seeking.
      el.__fixedAt = now;
      el.currentTime = target;
    }
  } else {
    if (!el.paused) el.pause();
    if (!el.seeking && Math.abs(el.currentTime - target) > 0.02) el.currentTime = target;
  }
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
    // The audio clock is sample-accurate and never stalls; fall back to wall time without it.
    const at = timelineTime();
    if (at != null) { state.time = at; clock.t0 = at; clock.wall0 = now; }
    else state.time = clock.t0 + (now - clock.wall0) / 1000;
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
    if (track.hidden) continue;
    for (const clip of track.clips) {
      const media = state.media[clip.mediaId];
      if (!media || media.kind === 'audio' || clip.audioOnly) continue;
      if (t >= clip.start && t < clipEnd(clip)) {
        active.add(clip.id);
        const el = getEl(clip, media);
        if (media.kind === 'video') syncVideo(el, clip, t, now);
        drawClip(el, clip, media, W, H);
      } else if (media.kind === 'video' && clip.start > t && clip.start - t < 1.2) {
        // Pre-roll: park the next clip on its first frame so the cut is instant.
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
    for (const [id, { el }] of els) if (!alive.has(id)) { if (el.pause) el.pause(); el.removeAttribute('src'); el.remove(); els.delete(id); }
  }

  drawCaptions(ctx, W, H, p.captionTracks, t);
  for (const fn of frameHooks) fn(t);
}
