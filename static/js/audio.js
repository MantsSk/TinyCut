// Timeline audio for the editor preview, played through Web Audio.
//
// Sound is NOT played by the <video> elements: in WebKit (the macOS app) starting a media element
// that has an audio track freezes its picture for ~170 ms while audio output spins up, which
// happened at every cut. Instead each clip's sound is decoded once (from a small mono WAV the
// server prepares) and scheduled sample-accurately; the AudioContext clock also drives the playhead.
import { state, clipEnd } from './store.js';

let ctx = null;
const buffers = new Map();   // mediaId -> AudioBuffer | Promise (loading)
let sources = [];
let anchor = null;           // { ctxTime, t }: timeline time t is heard at ctx.currentTime == ctxTime

function context() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    try { ctx = new AC({ sampleRate: 24000, latencyHint: 'playback' }); } catch { ctx = new AC(); }
  }
  return ctx;
}

/** Start decoding a media item's sound in the background (no-op if already loaded/loading). */
export function loadAudio(media) {
  if (!media?.has_audio || buffers.has(media.id)) return;
  const job = fetch(`/api/media/${media.id}/preview-audio`)
    .then(r => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(r.status))))
    .then(data => context().decodeAudioData(data))
    .then(buf => {
      buffers.set(media.id, buf);
      if (state.playing) restartAudio(timelineTime());  // it arrived mid-playback: bring it in
    })
    .catch(() => buffers.delete(media.id));
  buffers.set(media.id, job);
}

export function loadProjectAudio() {
  for (const tr of state.project.tracks) for (const c of tr.clips) loadAudio(state.media[c.mediaId]);
}

/** Current timeline time according to the audio clock, or null when audio isn't running. */
export function timelineTime() {
  if (!anchor || !ctx || ctx.state !== 'running') return null;
  return anchor.t + Math.max(0, ctx.currentTime - anchor.ctxTime);
}

export function stopAudio() {
  for (const s of sources) { try { s.stop(); } catch { /* already stopped */ } }
  sources = [];
  anchor = null;
}

/** (Re)schedule every audible clip from timeline time t onwards. */
export function restartAudio(t) {
  stopAudio();
  const c = context();
  if (c.state === 'suspended') c.resume();
  const lead = 0.06;  // schedule slightly ahead so the first samples aren't late
  anchor = { ctxTime: c.currentTime + lead, t };
  for (const track of state.project.tracks) {
    if (track.muted) continue;
    for (const clip of track.clips) {
      const buf = buffers.get(clip.mediaId);
      const vol = clip.volume ?? 1;
      if (!(buf instanceof AudioBuffer) || vol <= 0 || clipEnd(clip) <= t) continue;
      const dur = clip.out - clip.in;
      const skip = Math.max(0, t - clip.start);             // part of the clip already behind us
      const when = anchor.ctxTime + Math.max(0, clip.start - t);
      const offset = clip.in + skip;
      if (offset >= buf.duration) continue;

      const gain = c.createGain();
      const g = gain.gain;
      const fi = Math.min(clip.fadeIn || 0, dur), fo = Math.min(clip.fadeOut || 0, dur);
      const level = lt => vol * Math.min(1, fi > 0 ? lt / fi : 1, fo > 0 ? (dur - lt) / fo : 1);
      g.setValueAtTime(Math.max(0, level(skip)), when);
      if (fi > skip) g.linearRampToValueAtTime(vol, when + (fi - skip));
      if (fo > 0) {
        const foStart = dur - fo;
        if (foStart > skip) g.setValueAtTime(vol, when + (foStart - skip));
        g.linearRampToValueAtTime(0, when + (dur - skip));
      }
      const src = c.createBufferSource();
      src.buffer = buf;
      src.connect(gain).connect(c.destination);
      src.start(when, offset, Math.max(0, dur - skip));
      sources.push(src);
    }
  }
}
