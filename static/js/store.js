// App state, undo/redo, persistence and all timeline-editing operations.
import { uid, clamp } from './util.js';
import { PRESETS, groupWords } from './captions.js';

export const ASPECTS = {
  '16:9': [1920, 1080],
  '9:16': [1080, 1920],
  '1:1': [1080, 1080],
  '4:5': [1080, 1350],
};

export const state = {
  project: null,
  media: {},          // id -> media item from the server
  sel: null,          // {kind:'clip'|'seg'|'ctrack'|'track', id}
  time: 0,
  playing: false,
  pps: 60,            // timeline pixels per second
  snap: true,
  captionPreset: 'karaoke',
  language: 'auto',
};

// ---------------------------------------------------------------- events
const listeners = new Set();
export const on = fn => listeners.add(fn);
// kind: 'all' (structure changed), 'live' (dragging / slider), 'sel', 'time', 'media'
export const emit = (kind = 'all') => listeners.forEach(fn => fn(kind));

// ---------------------------------------------------------------- history
let past = [], future = [], current = null, saveTimer = null;

export function resetHistory() {
  past = []; future = [];
  current = JSON.stringify(state.project);
}

export function commit() {
  const snap = JSON.stringify(state.project);
  if (snap === current) { emit('all'); return; }
  past.push(current);
  if (past.length > 200) past.shift();
  current = snap;
  future = [];
  scheduleSave();
  emit('all');
}

/** Throw away uncommitted live edits (e.g. Escape during a drag). */
export function revert() {
  state.project = JSON.parse(current);
  emit('all');
}

export function undo() {
  if (!past.length) return;
  future.push(current);
  current = past.pop();
  state.project = JSON.parse(current);
  validateSel();
  scheduleSave();
  emit('all');
}

export function redo() {
  if (!future.length) return;
  past.push(current);
  current = future.pop();
  state.project = JSON.parse(current);
  validateSel();
  scheduleSave();
  emit('all');
}
export const canUndo = () => past.length > 0;
export const canRedo = () => future.length > 0;

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fetch('/api/project', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: current });
  }, 400);
}

// ---------------------------------------------------------------- model helpers

export function defaultProject() {
  return {
    name: 'My video',
    settings: { aspect: '16:9', res: 1080, width: 1920, height: 1080, fps: 30 },
    tracks: [{ id: uid(), name: 'Main', main: true, clips: [] }],
    captionTracks: [],
  };
}

export const clipDur = c => c.out - c.in;
export const clipEnd = c => c.start + clipDur(c);

export function projectDuration(p = state.project) {
  let d = 0;
  for (const t of p.tracks) for (const c of t.clips) d = Math.max(d, clipEnd(c));
  for (const t of p.captionTracks) for (const s of t.segments) d = Math.max(d, s.end);
  return d;
}

export function mainTrack() {
  return state.project.tracks.find(t => t.main);
}

export function findClip(id) {
  for (const track of state.project.tracks) {
    const i = track.clips.findIndex(c => c.id === id);
    if (i >= 0) return { track, clip: track.clips[i], index: i };
  }
  return null;
}

export function findSeg(id) {
  for (const ctrack of state.project.captionTracks) {
    const seg = ctrack.segments.find(s => s.id === id);
    if (seg) return { ctrack, seg };
  }
  return null;
}

export function mediaMaxOut(media) {
  return media.kind === 'image' ? 3600 : media.duration;
}

/** Main track is magnetic: clips are always packed end-to-end from 0. */
export function repack(track) {
  if (!track?.main) return;
  track.clips.sort((a, b) => a.start - b.start);
  let t = 0;
  for (const c of track.clips) { c.start = t; t += clipDur(c); }
}

export function sortClips(track) {
  track.clips.sort((a, b) => a.start - b.start);
}

export function overlaps(track, clip, start = clip.start) {
  const end = start + clipDur(clip);
  return track.clips.some(o => o !== clip && o.id !== clip.id && start < clipEnd(o) - 1e-3 && end > o.start + 1e-3);
}

export function newTrack(name) {
  const n = state.project.tracks.filter(t => !t.main).length + 1;
  return { id: uid(), name: name || `Track ${n + 1}`, clips: [] };
}

/** Put a clip on a free (non-main) track; if it collides, spawn a new track above. */
export function placeFree(clip, track) {
  if (!overlaps(track, clip)) {
    track.clips.push(clip);
    sortClips(track);
    return track;
  }
  const tracks = state.project.tracks;
  const t = newTrack();
  tracks.splice(tracks.indexOf(track), 0, t);
  t.clips.push(clip);
  return t;
}

export function insertIntoMain(clip, index) {
  const main = mainTrack();
  main.clips.sort((a, b) => a.start - b.start);
  index = index ?? main.clips.length;
  main.clips.splice(index, 0, clip);
  let t = 0;
  for (const c of main.clips) { c.start = t; t += clipDur(c); }
}

export function makeClip(media, start = 0) {
  const dur = media.kind === 'image' ? 5 : media.duration;
  return { id: uid(), mediaId: media.id, start, in: 0, out: dur, volume: 1, scale: 1, x: 0, y: 0, opacity: 1 };
}

/** Double-click / "+" in the media bin. */
export function addMediaToTimeline(media) {
  const p = state.project;
  const firstClip = p.tracks.every(t => t.clips.length === 0);
  if (firstClip && media.kind === 'video' && media.width && media.height) {
    const r = media.width / media.height;
    const aspect = r < 0.7 ? '9:16' : r < 0.9 ? '4:5' : r < 1.2 ? '1:1' : '16:9';
    setAspect(aspect);
  }
  const clip = makeClip(media);
  if (media.kind === 'audio') {
    // Audio goes to a track under the main track.
    let t = p.tracks.find(t => !t.main && t.clips.every(c => state.media[c.mediaId]?.kind === 'audio') && p.tracks.indexOf(t) > p.tracks.indexOf(mainTrack()));
    if (!t) { t = { id: uid(), name: 'Audio', clips: [] }; p.tracks.push(t); }
    clip.start = t.clips.reduce((m, c) => Math.max(m, clipEnd(c)), 0);
    t.clips.push(clip);
  } else {
    insertIntoMain(clip);
  }
  state.sel = { kind: 'clip', id: clip.id };
  commit();
}

/** CapCut-style "Extract audio": move a video's sound to its own clip on an audio track. */
export function extractAudio(clipId) {
  const f = findClip(clipId);
  if (!f) return;
  const p = state.project;
  const a = { ...f.clip, id: uid(), audioOnly: true, scale: 1, x: 0, y: 0, opacity: 1 };
  f.clip.volume = 0;
  const below = p.tracks.slice(p.tracks.indexOf(mainTrack()) + 1).find(t => !overlaps(t, a));
  let t = below;
  if (!t) { t = { id: uid(), name: 'Audio', clips: [] }; p.tracks.push(t); }
  t.clips.push(a);
  sortClips(t);
  state.sel = { kind: 'clip', id: a.id };
  commit();
}

/** Place an uploaded recording on an audio track at time t. */
export function addAudioAt(media, t) {
  const p = state.project;
  const clip = { ...makeClip(media, t) };
  const below = p.tracks.slice(p.tracks.indexOf(mainTrack()) + 1).find(tr => !overlaps(tr, clip));
  let tr = below;
  if (!tr) { tr = { id: uid(), name: 'Voiceover', clips: [] }; p.tracks.push(tr); }
  tr.clips.push(clip);
  sortClips(tr);
  state.sel = { kind: 'clip', id: clip.id };
  commit();
}

export function setAspect(aspect, res = state.project.settings.res || 1080) {
  const s = state.project.settings;
  const [w, h] = ASPECTS[aspect];
  const k = res / 1080;
  s.aspect = aspect;
  s.res = res;
  s.width = Math.round(w * k / 2) * 2;
  s.height = Math.round(h * k / 2) * 2;
}

export function splitAt(t = state.time) {
  let targets = [];
  const sel = state.sel;
  if (sel?.kind === 'clip') {
    const f = findClip(sel.id);
    if (f && t > f.clip.start + 0.05 && t < clipEnd(f.clip) - 0.05) targets.push(f);
  } else if (sel?.kind === 'seg') {
    const f = findSeg(sel.id);
    if (f && t > f.seg.start + 0.05 && t < f.seg.end - 0.05) return splitSeg(f, t);
  }
  if (!targets.length) {
    // Nothing selected under playhead: split the main-track clip.
    const main = mainTrack();
    const c = main.clips.find(c => t > c.start + 0.05 && t < clipEnd(c) - 0.05);
    if (c) targets.push({ track: main, clip: c });
  }
  if (!targets.length) return false;
  for (const { track, clip } of targets) {
    const cut = clip.in + (t - clip.start);
    const b = { ...clip, id: uid(), start: t, in: cut };
    clip.out = cut;
    track.clips.splice(track.clips.indexOf(clip) + 1, 0, b);
    state.sel = { kind: 'clip', id: b.id };
  }
  commit();
  return true;
}

function splitSeg({ ctrack, seg }, t) {
  const b = { id: uid(), start: t, end: seg.end, words: seg.words.filter(w => w.t0 >= t) };
  seg.words = seg.words.filter(w => w.t0 < t);
  seg.end = t;
  if (!b.words.length) b.words = [{ t0: t, t1: b.end, text: '…' }];
  if (!seg.words.length) seg.words = [{ t0: seg.start, t1: t, text: '…' }];
  ctrack.segments.splice(ctrack.segments.indexOf(seg) + 1, 0, b);
  state.sel = { kind: 'seg', id: b.id };
  commit();
  return true;
}

export function deleteSelection() {
  const sel = state.sel;
  if (!sel) return;
  const p = state.project;
  if (sel.kind === 'clip') {
    const f = findClip(sel.id);
    if (!f) return;
    f.track.clips.splice(f.index, 1);
    repack(f.track);
    if (!f.track.main && !f.track.clips.length) p.tracks.splice(p.tracks.indexOf(f.track), 1);
  } else if (sel.kind === 'seg') {
    const f = findSeg(sel.id);
    if (!f) return;
    f.ctrack.segments.splice(f.ctrack.segments.indexOf(f.seg), 1);
  } else if (sel.kind === 'ctrack') {
    p.captionTracks = p.captionTracks.filter(t => t.id !== sel.id);
  } else if (sel.kind === 'track') {
    const t = p.tracks.find(t => t.id === sel.id);
    if (!t || t.main) return;
    p.tracks = p.tracks.filter(x => x !== t);
  }
  state.sel = null;
  commit();
}

export function validateSel() {
  const s = state.sel;
  if (!s) return;
  const ok = s.kind === 'clip' ? findClip(s.id)
    : s.kind === 'seg' ? findSeg(s.id)
    : s.kind === 'ctrack' ? state.project.captionTracks.find(t => t.id === s.id)
    : state.project.tracks.find(t => t.id === s.id);
  if (!ok) state.sel = null;
}

// ---------------------------------------------------------------- captions

/** The caption track the user is "working on": selected one, else the first. */
export function currentCaptionTrack() {
  const s = state.sel;
  if (s?.kind === 'ctrack') return state.project.captionTracks.find(t => t.id === s.id);
  if (s?.kind === 'seg') return findSeg(s.id)?.ctrack;
  return state.project.captionTracks[0] || null;
}

export function newCaptionTrack(preset = state.captionPreset, name) {
  const n = state.project.captionTracks.length + 1;
  const t = { id: uid(), name: name || `Captions ${n}`, hidden: false, style: { preset, ...PRESETS[preset].defaults() }, segments: [] };
  state.project.captionTracks.unshift(t);
  return t;
}

export function applyPreset(ctrack, preset) {
  const oldMax = ctrack.style.maxWords;
  ctrack.style = { preset, ...PRESETS[preset].defaults() };
  if (ctrack.style.maxWords !== oldMax) regroup(ctrack);
}

export function regroup(ctrack) {
  const words = ctrack.segments.flatMap(s => s.words).sort((a, b) => a.t0 - b.t0);
  ctrack.segments = groupWords(words, ctrack.style.maxWords);
}

export function setSegText(seg, text) {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) { seg.words = []; return; }
  if (tokens.length === seg.words.length) {
    seg.words.forEach((w, i) => { w.text = tokens[i]; });
    return;
  }
  // Word count changed: spread the words evenly over the segment.
  const span = (seg.end - seg.start) / tokens.length;
  seg.words = tokens.map((text, i) => ({ t0: seg.start + i * span, t1: seg.start + (i + 1) * span, text }));
}

export function addTextCaption(t = state.time, text = 'Your text here') {
  let ct = currentCaptionTrack() || newCaptionTrack();
  const seg = { id: uid(), start: t, end: t + 2, words: [] };
  setSegText(seg, text);
  ct.segments.push(seg);
  ct.segments.sort((a, b) => a.start - b.start);
  state.sel = { kind: 'seg', id: seg.id };
  commit();
  return seg;
}

export function moveSeg(seg, start, end = start + (seg.end - seg.start)) {
  const os = seg.start, oe = seg.end;
  const k = (end - start) / Math.max(1e-6, oe - os);
  for (const w of seg.words) {
    w.t0 = start + (w.t0 - os) * k;
    w.t1 = start + (w.t1 - os) * k;
  }
  seg.start = start;
  seg.end = end;
}

/** Map cached per-media transcripts onto the timeline through the clips. */
export function timelineWords(transcripts) {
  const words = [];
  for (const track of state.project.tracks) {
    if (track.muted) continue;
    for (const c of track.clips) {
      const ws = transcripts[c.mediaId];
      if (!ws || (c.volume ?? 1) <= 0) continue;
      for (const w of ws) {
        const mid = (w.t0 + w.t1) / 2;
        if (mid < c.in || mid >= c.out) continue;
        words.push({
          t0: c.start + clamp(w.t0, c.in, c.out) - c.in,
          t1: c.start + clamp(w.t1, c.in, c.out) - c.in,
          text: w.text,
        });
      }
    }
  }
  return words.sort((a, b) => a.t0 - b.t0);
}
