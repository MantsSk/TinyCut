// Multi-track timeline: a magnetic main track, free overlay/audio tracks, caption tracks.
import {
  state, emit, commit, revert, findClip, findSeg, clipDur, clipEnd, repack, sortClips, overlaps,
  placeFree, insertIntoMain, makeClip, mediaMaxOut, moveSeg, projectDuration, newTrack,
  selectedIds, selectIds, toggleSelected,
} from './store.js';
import { seek, pause } from './preview.js';
import { esc, fmtShort, clamp } from './util.js';

export const HEAD = 176;
let root, playheadEl, snapEl;
let drag = null;
let fileDropHandler = null;
export const setFileDropHandler = fn => { fileDropHandler = fn; };

export function initTimeline(el) {
  root = el;
  root.addEventListener('pointerdown', onDown);
  root.addEventListener('click', onClick);
  root.addEventListener('dblclick', onDblClick);
  root.addEventListener('wheel', onWheel, { passive: false });
  root.addEventListener('dragover', onDragOver);
  root.addEventListener('dragleave', () => markDropRow(null));
  root.addEventListener('drop', onDrop);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('resize', renderTimeline);
}

export function timeAtX(clientX) {
  const r = root.getBoundingClientRect();
  return (clientX - r.left + root.scrollLeft - HEAD) / state.pps;
}

export const isDragging = () => !!drag?.started;

export function cancelDrag() {
  if (!drag) return false;
  const wasEdit = drag.started && drag.type !== 'scrub' && drag.type !== 'marquee';
  if (drag.type === 'marquee') { drag.box?.remove(); emit('sel'); }
  drag = null;
  if (wasEdit) revert();
  return true;
}

// ---------------------------------------------------------------- render

function rulerHTML(laneW) {
  const pps = state.pps;
  const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200];
  const step = steps.find(s => s * pps >= 80) || 1800;
  const minor = step / 5;
  let html = '';
  for (let t = 0; t * pps < laneW; t += step) {
    const x = t * pps;
    const label = step < 1 ? `${fmtShort(t)}.${Math.round((t % 1) * 10)}` : fmtShort(t);
    html += `<div class="tick major" style="left:${x}px"></div><span class="lbl" style="left:${x}px">${label}</span>`;
  }
  const minorBg = minor * pps >= 6
    ? `background-image:repeating-linear-gradient(to right,#3c4149 0 1px,transparent 1px ${minor * pps}px);background-size:100% 6px;background-repeat:no-repeat;background-position:0 100%;`
    : '';
  return `<div class="tl-row ruler"><div class="tl-head">${fmtShort(state.time)}</div>
    <div class="tl-lane ruler-lane" data-ruler="1" style="width:${laneW}px;${minorBg}">${html}</div></div>`;
}

function clipHTML(c, track) {
  const m = state.media[c.mediaId];
  const pps = state.pps;
  const kind = c.audioOnly ? 'audio' : (m?.kind || 'video');
  const sel = selIds.has(c.id);
  const dragging = drag?.started && (drag.id === c.id || drag.group?.some(g => g.id === c.id));
  let inner = '';
  if (m?.strip && !c.audioOnly) {
    inner += kind === 'image'
      ? `<div class="strip" style="background-image:url('${m.strip}');background-size:auto 100%"></div>`
      : `<div class="strip" style="background-image:url('${m.strip}');background-size:${m.duration * pps}px 100%;background-position:${-c.in * pps}px 0"></div>`;
  }
  if (m?.wave) {
    inner += `<div class="wave" style="background-image:url('${m.wave}');background-size:${m.duration * pps}px 100%;background-position:${-c.in * pps}px 0"></div>`;
  }
  const name = m ? `${c.audioOnly ? '♪ ' : ''}${m.name}` : 'Missing media';
  if ((c.fadeIn > 0 || c.fadeOut > 0) && m?.has_audio) {
    const w = clipDur(c) * pps;
    const fi = Math.min(w, (c.fadeIn || 0) * pps), fo = Math.min(w, (c.fadeOut || 0) * pps);
    inner += `<svg class="fades" width="${w}" height="100%" viewBox="0 0 ${w} 10" preserveAspectRatio="none"><path d="M0 10 L${fi} 0 L${w - fo} 0 L${w} 10" /></svg>`;
  }
  return `<div class="clip ${kind}${sel ? ' sel' : ''}${dragging ? ' dragging' : ''}${track.muted ? ' muted' : ''}" data-id="${c.id}"
    style="left:${c.start * pps}px;width:${Math.max(3, clipDur(c) * pps)}px" title="${esc(name)}">
    ${inner}<span class="label">${esc(name)}</span>
    <div class="handle l"></div><div class="handle r"></div></div>`;
}

function segHTML(s) {
  const pps = state.pps;
  const sel = selIds.has(s.id);
  const dragging = drag?.started && (drag.id === s.id || drag.group?.some(g => g.id === s.id));
  const text = s.words.map(w => w.text).join(' ');
  return `<div class="seg${sel ? ' sel' : ''}${dragging ? ' dragging' : ''}" data-id="${s.id}"
    style="left:${s.start * pps}px;width:${Math.max(3, (s.end - s.start) * pps)}px" title="${esc(text)}">
    ${esc(text)}<div class="handle l"></div><div class="handle r"></div></div>`;
}

let selIds = new Set();  // snapshot of the selection for one render

export function renderTimeline() {
  const p = state.project;
  if (!p || !root) return;
  selIds = selectedIds();
  const pps = state.pps;
  const D = projectDuration();
  const laneW = Math.max(root.clientWidth - HEAD, (D + 30) * pps);
  const selTrack = state.sel?.kind === 'track' ? state.sel.id : state.sel?.kind === 'ctrack' ? state.sel.id : null;

  let html = `<div class="tl-inner" style="width:${HEAD + laneW}px">`;
  html += rulerHTML(laneW);
  for (const ct of p.captionTracks) {
    html += `<div class="tl-row caption" data-ctrack="${ct.id}">
      <div class="tl-head${selTrack === ct.id ? ' sel' : ''}">
        <span class="tname" title="Double-click to rename">💬 ${esc(ct.name)}</span>
        <button data-act="chide" title="Show / hide" class="${ct.hidden ? 'on' : ''}">${ct.hidden ? '◌' : '◉'}</button>
        <button data-act="cdup" title="Duplicate track">⧉</button>
        <button data-act="cdel" title="Delete track">✕</button>
      </div>
      <div class="tl-lane" style="width:${laneW}px">${ct.segments.map(segHTML).join('')}</div></div>`;
  }
  p.tracks.forEach((tr, i) => {
    html += `<div class="tl-row video${tr.main ? ' main' : ''}" data-track="${tr.id}">
      <div class="tl-head${selTrack === tr.id ? ' sel' : ''}">
        <span class="tname" title="Double-click to rename">${esc(tr.name)}</span>${tr.main ? '<span class="badge" title="Magnetic: clips snap together, drag to reorder">MAIN</span>' : ''}
        <button data-act="mute" title="Mute" class="${tr.muted ? 'on' : ''}">${tr.muted ? '🔇' : '🔊'}</button>
        <button data-act="hide" title="Hide video" class="${tr.hidden ? 'on' : ''}">${tr.hidden ? '◌' : '◉'}</button>
        ${i > 0 ? '<button data-act="up" title="Move layer up">▲</button>' : ''}
        ${i < p.tracks.length - 1 ? '<button data-act="down" title="Move layer down">▼</button>' : ''}
        ${tr.main ? '' : '<button data-act="del" title="Delete track">✕</button>'}
      </div>
      <div class="tl-lane" style="width:${laneW}px">${tr.clips.map(c => clipHTML(c, tr)).join('')}</div></div>`;
  });
  html += `<div class="tl-row tl-empty" data-newtrack="1"><div class="tl-head"></div>
    <div class="tl-lane" style="width:${laneW}px">${D ? 'Drop media here to add a new track' : 'Drop videos here, or press + on a clip in the Media panel'}</div></div>`;
  html += `<div class="playhead"></div><div class="snap-line hidden"></div></div>`;

  const sl = root.scrollLeft, st = root.scrollTop;
  root.innerHTML = html;
  root.scrollLeft = sl;
  root.scrollTop = st;
  playheadEl = root.querySelector('.playhead');
  snapEl = root.querySelector('.snap-line');
  updatePlayhead(state.time);
}

let lastHeadLabel = '';
export function updatePlayhead(t) {
  if (!playheadEl) return;
  const x = HEAD + t * state.pps;
  playheadEl.style.left = `${x}px`;
  const label = fmtShort(t);
  if (label !== lastHeadLabel) {
    lastHeadLabel = label;
    const h = root.querySelector('.ruler .tl-head');
    if (h) h.textContent = label;
  }
  if (state.playing && !drag) {
    const view = root.clientWidth;
    if (x > root.scrollLeft + view - 40) root.scrollLeft = x - HEAD - 40;
    else if (x < root.scrollLeft + HEAD) root.scrollLeft = Math.max(0, x - HEAD - 40);
  }
}

// ---------------------------------------------------------------- snapping

/** selfId: an id or a Set of ids whose edges shouldn't attract (the things being dragged). */
function snapPoints(selfId) {
  const skip = selfId instanceof Set ? selfId : new Set([selfId]);
  const pts = [0, state.time];
  for (const t of state.project.tracks) for (const c of t.clips) if (!skip.has(c.id)) pts.push(c.start, clipEnd(c));
  for (const t of state.project.captionTracks) for (const s of t.segments) if (!skip.has(s.id)) pts.push(s.start, s.end);
  return pts;
}

/** Snap a single time value. */
function snapT(t, selfId) {
  if (!state.snap) return t;
  let best = t, bd = 8 / state.pps;
  for (const p of snapPoints(selfId)) if (Math.abs(t - p) < bd) { bd = Math.abs(t - p); best = p; }
  showSnap(best !== t ? best : null);
  return best;
}

/** Snap a [start, start+dur] span by either edge. */
function snapSpan(start, dur, selfId) {
  if (!state.snap) return start;
  let best = start, bd = 8 / state.pps, line = null;
  for (const p of snapPoints(selfId)) {
    if (Math.abs(start - p) < bd) { bd = Math.abs(start - p); best = p; line = p; }
    if (Math.abs(start + dur - p) < bd) { bd = Math.abs(start + dur - p); best = p - dur; line = p; }
  }
  showSnap(line);
  return best;
}

let snapLineT = null;
function showSnap(t) { snapLineT = t; }
function drawSnap() {
  if (!snapEl) return;
  if (snapLineT == null || !drag?.started) { snapEl.classList.add('hidden'); return; }
  snapEl.classList.remove('hidden');
  snapEl.style.left = `${HEAD + snapLineT * state.pps}px`;
}

// ---------------------------------------------------------------- pointer editing

function onDown(e) {
  if (e.button !== 0 || e.target.closest('[data-act]')) return;
  const p = state.project;
  const head = e.target.closest('.tl-head');
  if (head) {
    const row = head.closest('.tl-row');
    if (row.dataset.track) state.sel = { kind: 'track', id: row.dataset.track };
    else if (row.dataset.ctrack) state.sel = { kind: 'ctrack', id: row.dataset.ctrack };
    emit('sel');
    return;
  }
  const clipEl = e.target.closest('.clip');
  const segEl = e.target.closest('.seg');
  const handle = e.target.closest('.handle');
  const base = { x0: e.clientX, y0: e.clientY, started: false };
  const additive = e.shiftKey || e.metaKey || e.ctrlKey;
  const itemEl = clipEl || segEl;
  if (itemEl && additive) {
    // Shift / ⌘ / Ctrl-click adds or removes one item.
    toggleSelected(itemEl.dataset.id);
    emit('sel');
    e.preventDefault();
    return;
  }
  // Grabbing (not trimming) an item of a multi-selection moves the whole group.
  const group = itemEl && !handle && selectedIds().has(itemEl.dataset.id) && selectedIds().size > 1;
  if (group && !(clipEl && findClip(clipEl.dataset.id)?.track.main)) {
    selectIds(selectedIds(), itemEl.dataset.id);
    drag = { ...base, type: 'group', id: itemEl.dataset.id, t0: timeAtX(e.clientX), group: groupSnapshot() };
    emit('sel');
    e.preventDefault();
    return;
  }
  if (clipEl) {
    const f = findClip(clipEl.dataset.id);
    if (!f) return;
    state.sel = { kind: 'clip', id: f.clip.id };
    drag = {
      ...base, kind: 'clip', id: f.clip.id, originTrack: f.track.id,
      type: handle ? 'trim' : 'move', side: handle?.classList.contains('l') ? 'l' : 'r',
      orig: { start: f.clip.start, in: f.clip.in, out: f.clip.out },
      grab: timeAtX(e.clientX) - f.clip.start,
    };
    emit('sel');
    e.preventDefault();
    return;
  }
  if (segEl) {
    const f = findSeg(segEl.dataset.id);
    if (!f) return;
    state.sel = { kind: 'seg', id: f.seg.id };
    drag = {
      ...base, kind: 'seg', id: f.seg.id,
      type: handle ? 'trim' : 'move', side: handle?.classList.contains('l') ? 'l' : 'r',
      orig: { start: f.seg.start, end: f.seg.end, words: JSON.parse(JSON.stringify(f.seg.words)) },
      grab: timeAtX(e.clientX) - f.seg.start,
    };
    emit('sel');
    e.preventDefault();
    return;
  }
  if (e.target.closest('[data-ruler]')) {
    if (state.playing) pause();
    drag = { ...base, type: 'scrub', started: true };
    seek(timeAtX(e.clientX));
    e.preventDefault();
  } else if (e.target.closest('.tl-lane')) {
    // Empty lane: click moves the playhead, drag draws a selection box (Shift adds to the selection).
    drag = { ...base, type: 'marquee', additive, keep: additive ? selectedIds() : new Set() };
    e.preventDefault();
  }
}

/** Where every selected clip / caption starts, for moving them together. Main-track clips stay put. */
function groupSnapshot() {
  const out = [];
  for (const id of selectedIds()) {
    const c = findClip(id);
    if (c && !c.track.main) out.push({ id, kind: 'clip', start: c.clip.start, dur: clipDur(c.clip) });
    const s = findSeg(id);
    if (s) out.push({ id, kind: 'seg', start: s.seg.start, dur: s.seg.end - s.seg.start, end: s.seg.end, words: JSON.parse(JSON.stringify(s.seg.words)) });
  }
  return out;
}

function moveGroup(e) {
  const lead = drag.group.find(g => g.id === drag.id) || drag.group[0];
  if (!lead) return;
  let dt = timeAtX(e.clientX) - drag.t0;
  dt = snapSpan(lead.start + dt, lead.dur, new Set(drag.group.map(g => g.id))) - lead.start;
  dt = Math.max(dt, -Math.min(...drag.group.map(g => g.start)));  // nothing before 0
  for (const g of drag.group) {
    if (g.kind === 'clip') {
      const f = findClip(g.id);
      if (f) f.clip.start = g.start + dt;
    } else {
      const f = findSeg(g.id);
      if (!f) continue;
      Object.assign(f.seg, { start: g.start, end: g.end, words: JSON.parse(JSON.stringify(g.words)) });
      moveSeg(f.seg, g.start + dt);
    }
  }
}

function finishGroup(d) {
  const moved = new Set(d.group.map(g => g.id));
  for (const g of d.group) {
    const f = g.kind === 'clip' && findClip(g.id);
    if (!f) continue;
    sortClips(f.track);
    // Landed on a clip that isn't part of the group: bump it to a free track, as a single move would.
    const hit = f.track.clips.some(o => !moved.has(o.id) && f.clip.start < clipEnd(o) - 1e-3 && clipEnd(f.clip) > o.start + 1e-3);
    if (hit) { f.track.clips.splice(f.track.clips.indexOf(f.clip), 1); placeFree(f.clip, f.track); }
  }
  for (const ct of state.project.captionTracks) ct.segments.sort((a, b) => a.start - b.start);
}

function updateMarquee(e) {
  const r = root.getBoundingClientRect();
  const x0 = Math.min(drag.x0, e.clientX), x1 = Math.max(drag.x0, e.clientX);
  const y0 = Math.min(drag.y0, e.clientY), y1 = Math.max(drag.y0, e.clientY);
  if (!drag.box) {
    drag.box = document.createElement('div');
    drag.box.className = 'marquee';
    root.querySelector('.tl-inner').appendChild(drag.box);
  }
  Object.assign(drag.box.style, {
    left: `${x0 - r.left + root.scrollLeft}px`, top: `${y0 - r.top + root.scrollTop}px`,
    width: `${x1 - x0}px`, height: `${y1 - y0}px`,
  });
  const hits = new Set(drag.keep);
  root.querySelectorAll('.clip, .seg').forEach(el => {
    const b = el.getBoundingClientRect();
    const inside = b.right > x0 && b.left < x1 && b.bottom > y0 && b.top < y1;
    if (inside) hits.add(el.dataset.id);
    el.classList.toggle('sel', hits.has(el.dataset.id));
  });
  drag.hits = hits;
}

function onMove(e) {
  if (!drag) return;
  if (drag.type === 'scrub') { seek(timeAtX(e.clientX)); return; }
  if (!drag.started) {
    if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 4) return;
    drag.started = true;
  }
  if (drag.type === 'marquee') { updateMarquee(e); return; }
  showSnap(null);
  if (drag.type === 'group') moveGroup(e);
  else if (drag.kind === 'clip') (drag.type === 'move' ? moveClip : trimClip)(e);
  else (drag.type === 'move' ? moveSegDrag : trimSegDrag)(e);
  emit('live');
  drawSnap();
}

function onUp() {
  if (!drag) return;
  const d = drag;
  drag = null;
  if (d.type === 'marquee') {
    d.box?.remove();
    if (d.started) selectIds(d.hits || d.keep);
    else {
      if (!d.additive) { state.sel = null; state.multi.clear(); }
      if (state.playing) pause();
      seek(timeAtX(d.x0));
    }
    emit('sel');
    return;
  }
  if (d.type === 'group' && !d.started) { selectIds([d.id]); emit('sel'); return; }  // plain click narrows to one
  if (d.type === 'scrub' || !d.started) { if (snapEl) snapEl.classList.add('hidden'); return; }
  const p = state.project;
  if (d.type === 'group') finishGroup(d);
  else if (d.kind === 'clip') {
    const f = findClip(d.id);
    if (f) {
      if (d.newTrack) {
        f.track.clips.splice(f.index, 1);
        repack(f.track);
        const media = state.media[f.clip.mediaId];
        const t = newTrack(media?.kind === 'audio' ? 'Audio' : undefined);
        if (media?.kind === 'audio') p.tracks.push(t); else p.tracks.unshift(t);
        t.clips.push(f.clip);
      } else if (!f.track.main && overlaps(f.track, f.clip)) {
        f.track.clips.splice(f.index, 1);
        placeFree(f.clip, f.track);
      }
      const origin = p.tracks.find(t => t.id === d.originTrack);
      if (origin && !origin.main && !origin.clips.length && !findClipIn(origin, d.id)) {
        p.tracks = p.tracks.filter(t => t !== origin);
      }
    }
  } else if (d.kind === 'seg') {
    const f = findSeg(d.id);
    if (f) f.ctrack.segments.sort((a, b) => a.start - b.start);
  }
  commit();
}
const findClipIn = (track, id) => track.clips.some(c => c.id === id);

function rowAt(e) {
  const el = document.elementFromPoint(e.clientX, e.clientY);
  return el?.closest('.tl-row') || null;
}

function moveClip(e) {
  const p = state.project;
  const f = findClip(drag.id);
  if (!f) return;
  const { clip } = f;
  let track = f.track;
  const row = rowAt(e);
  drag.newTrack = false;
  if (row?.dataset.track) {
    const target = p.tracks.find(t => t.id === row.dataset.track);
    if (target && target !== track) {
      track.clips.splice(track.clips.indexOf(clip), 1);
      repack(track);
      target.clips.push(clip);
      track = target;
    }
  } else if (row?.dataset.newtrack) {
    drag.newTrack = true;
  }
  const t = timeAtX(e.clientX);
  if (track.main) {
    // Magnetic insert: pick a slot by pointer position against packed neighbours.
    const others = track.clips.filter(c => c !== clip).sort((a, b) => a.start - b.start);
    let acc = 0, idx = others.length;
    for (let i = 0; i < others.length; i++) {
      const d = clipDur(others[i]);
      if (t < acc + d / 2) { idx = i; break; }
      acc += d;
    }
    others.splice(idx, 0, clip);
    let a = 0;
    for (const c of others) { c.start = a; a += clipDur(c); }
    track.clips = others;
  } else {
    clip.start = Math.max(0, snapSpan(Math.max(0, t - drag.grab), clipDur(clip), clip.id));
    sortClips(track);
  }
}

function trimClip(e) {
  const f = findClip(drag.id);
  if (!f) return;
  const { clip, track } = f;
  const m = state.media[clip.mediaId];
  const o = drag.orig;
  const dt = (e.clientX - drag.x0) / state.pps;
  const maxOut = m ? mediaMaxOut(m) : o.out;
  if (drag.side === 'r') {
    let out = clamp(o.out + dt, o.in + 0.1, maxOut);
    if (!track.main) {
      const end = snapT(o.start + (out - o.in), clip.id);
      out = clamp(o.in + (end - o.start), o.in + 0.1, maxOut);
    }
    clip.out = out;
  } else {
    let inn = clamp(o.in + dt, 0, o.out - 0.1);
    let start = o.start;
    if (!track.main) {
      start = o.start + (inn - o.in);
      if (start < 0) { inn -= start; start = 0; }
      const snapped = snapT(start, clip.id);
      inn = clamp(inn + (snapped - start), 0, o.out - 0.1);
      start = o.start + (inn - o.in);
    }
    clip.in = inn;
    clip.start = start;
  }
  repack(track);
}

function restoreSeg(seg) {
  seg.start = drag.orig.start;
  seg.end = drag.orig.end;
  seg.words = JSON.parse(JSON.stringify(drag.orig.words));
}

function moveSegDrag(e) {
  const p = state.project;
  const f = findSeg(drag.id);
  if (!f) return;
  const { seg } = f;
  const row = rowAt(e);
  if (row?.dataset.ctrack && row.dataset.ctrack !== f.ctrack.id) {
    const target = p.captionTracks.find(t => t.id === row.dataset.ctrack);
    if (target) {
      f.ctrack.segments.splice(f.ctrack.segments.indexOf(seg), 1);
      target.segments.push(seg);
    }
  }
  restoreSeg(seg);
  const dur = drag.orig.end - drag.orig.start;
  const start = Math.max(0, snapSpan(Math.max(0, timeAtX(e.clientX) - drag.grab), dur, seg.id));
  moveSeg(seg, start);
}

function trimSegDrag(e) {
  const f = findSeg(drag.id);
  if (!f) return;
  const { seg } = f;
  const o = drag.orig;
  const dt = (e.clientX - drag.x0) / state.pps;
  restoreSeg(seg);
  if (drag.side === 'r') moveSeg(seg, o.start, Math.max(o.start + 0.1, snapT(o.end + dt, seg.id)));
  else moveSeg(seg, clamp(snapT(o.start + dt, seg.id), 0, o.end - 0.1), o.end);
}

// ---------------------------------------------------------------- header buttons

function onClick(e) {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const p = state.project;
  const row = btn.closest('.tl-row');
  const tr = p.tracks.find(t => t.id === row.dataset.track);
  const ct = p.captionTracks.find(t => t.id === row.dataset.ctrack);
  const i = tr ? p.tracks.indexOf(tr) : -1;
  switch (btn.dataset.act) {
    case 'mute': tr.muted = !tr.muted; break;
    case 'hide': tr.hidden = !tr.hidden; break;
    case 'up': [p.tracks[i - 1], p.tracks[i]] = [p.tracks[i], p.tracks[i - 1]]; break;
    case 'down': [p.tracks[i + 1], p.tracks[i]] = [p.tracks[i], p.tracks[i + 1]]; break;
    case 'del':
      if (tr.clips.length && !confirm(`Delete "${tr.name}" and its ${tr.clips.length} clip(s)?`)) return;
      p.tracks = p.tracks.filter(t => t !== tr);
      break;
    case 'chide': ct.hidden = !ct.hidden; break;
    case 'cdup': {
      const copy = JSON.parse(JSON.stringify(ct));
      copy.id = Math.random().toString(36).slice(2, 10);
      copy.name = `${ct.name} copy`;
      copy.segments.forEach(s => { s.id = Math.random().toString(36).slice(2, 10); });
      p.captionTracks.splice(p.captionTracks.indexOf(ct), 0, copy);
      state.sel = { kind: 'ctrack', id: copy.id };
      break;
    }
    case 'cdel':
      if (ct.segments.length && !confirm(`Delete caption track "${ct.name}"?`)) return;
      p.captionTracks = p.captionTracks.filter(t => t !== ct);
      break;
  }
  commit();
}

function onDblClick(e) {
  const name = e.target.closest('.tname');
  if (!name) return;
  const row = name.closest('.tl-row');
  const p = state.project;
  const t = p.tracks.find(t => t.id === row.dataset.track) || p.captionTracks.find(t => t.id === row.dataset.ctrack);
  const v = prompt('Track name', t.name);
  if (v) { t.name = v; commit(); }
}

// ---------------------------------------------------------------- zoom

export function setZoom(pps, anchorClientX) {
  const r = root.getBoundingClientRect();
  const ax = anchorClientX ?? (r.left + HEAD + (root.clientWidth - HEAD) / 2);
  const t = timeAtX(ax);
  state.pps = clamp(pps, 2, 500);
  renderTimeline();
  root.scrollLeft = Math.max(0, t * state.pps - (ax - r.left - HEAD));
  emit('zoom');
}

export function zoomToFit() {
  const D = projectDuration() || 10;
  setZoom((root.clientWidth - HEAD - 40) / D);
  root.scrollLeft = 0;
}

function onWheel(e) {
  if (e.ctrlKey || e.metaKey) {
    e.preventDefault();
    setZoom(state.pps * Math.exp(-e.deltaY * 0.004), e.clientX);
  } else if (!e.shiftKey && Math.abs(e.deltaY) > Math.abs(e.deltaX) && root.scrollHeight <= root.clientHeight + 2) {
    // No vertical overflow: let the wheel scroll time.
    e.preventDefault();
    root.scrollLeft += e.deltaY;
  }
}

// ---------------------------------------------------------------- drop from media bin / OS

function markDropRow(row) {
  root.querySelectorAll('.drop-target').forEach(r => r.classList.remove('drop-target'));
  if (row) row.classList.add('drop-target');
}

function onDragOver(e) {
  const types = e.dataTransfer.types;
  if (!types.includes('application/x-tinycut-media') && !types.includes('Files')) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  markDropRow(e.target.closest('.tl-row:not(.ruler)'));
}

export function dropMedia(media, row, t) {
  const p = state.project;
  const clip = makeClip(media);
  const tr = row?.dataset.track ? p.tracks.find(x => x.id === row.dataset.track) : null;
  if (tr?.main && media.kind !== 'audio') {
    const others = tr.clips.slice().sort((a, b) => a.start - b.start);
    let acc = 0, idx = others.length;
    for (let i = 0; i < others.length; i++) {
      const d = clipDur(others[i]);
      if (t < acc + d / 2) { idx = i; break; }
      acc += d;
    }
    insertIntoMain(clip, idx);
  } else if (tr && !tr.main) {
    clip.start = Math.max(0, t);
    placeFree(clip, tr);
  } else if (!tr && !p.tracks.some(x => x.clips.length) && media.kind !== 'audio') {
    insertIntoMain(clip);
  } else {
    clip.start = Math.max(0, t);
    const nt = newTrack(media.kind === 'audio' ? 'Audio' : undefined);
    if (media.kind === 'audio' || tr?.main) p.tracks.push(nt); else p.tracks.unshift(nt);
    nt.clips.push(clip);
  }
  state.sel = { kind: 'clip', id: clip.id };
  commit();
}

async function onDrop(e) {
  e.preventDefault();
  const row = e.target.closest('.tl-row:not(.ruler)');
  markDropRow(null);
  const t = Math.max(0, timeAtX(e.clientX));
  const id = e.dataTransfer.getData('application/x-tinycut-media');
  if (id && state.media[id]) return dropMedia(state.media[id], row, t);
  if (e.dataTransfer.files?.length && fileDropHandler) {
    const rowInfo = row ? { dataset: { ...row.dataset } } : null;
    const items = await fileDropHandler([...e.dataTransfer.files]);
    let at = t;
    for (const m of items) {
      const r2 = rowInfo?.dataset.track ? root.querySelector(`[data-track="${rowInfo.dataset.track}"]`) : null;
      dropMedia(m, r2 || rowInfo, at);
      at += m.kind === 'image' ? 5 : m.duration;
    }
  }
}
