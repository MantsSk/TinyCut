import {
  state, on, emit, commit, undo, redo, canUndo, canRedo, resetHistory, defaultProject, projectDuration,
  splitAt, deleteSelection, addTextCaption, newTrack, validateSel, selectAll,
} from './store.js';
import { createProject, showProjects } from './projects.js';
import { initPreview, onFrame, togglePlay, seek, pause, refreshPlayback, warmPreviews } from './preview.js';
import { loadProjectAudio } from './audio.js';
import { initTimeline, renderTimeline, updatePlayhead, setZoom, zoomToFit, setFileDropHandler, cancelDrag, isDragging } from './timeline.js';
import { renderMediaTab, renderCaptionsTab, renderInspector, uploadFiles } from './panels.js';
import { exportVideo } from './export.js';
import { FONTS } from './captions.js';
import { $, $$, fmtTime, toast } from './util.js';

// Zoom slider is logarithmic: 0 → 2 px/s, 100 → 500 px/s.
const ppsToSlider = pps => Math.round(100 * Math.log(pps / 2) / Math.log(250));
const sliderToPps = v => 2 * Math.pow(250, v / 100);

async function boot() {
  // The open project, or a first one on a fresh install.
  const project = (await fetch('/api/project').then(r => r.json())) || (await createProject(defaultProject().name));
  const media = await fetch(`/api/media?project=${project.id}`).then(r => r.json());
  state.media = Object.fromEntries(media.map(m => [m.id, m]));
  state.project = project;
  // Drop clips whose media vanished.
  for (const t of state.project.tracks) t.clips = t.clips.filter(c => state.media[c.mediaId]);
  resetHistory();
  // Canvas text doesn't trigger web-font loading (notably in WebKit), so load caption fonts up front.
  if (document.fonts) FONTS.forEach(f => [400, 500, 700, 800, 900].forEach(w => document.fonts.load(`${w} 40px "${f}"`).catch(() => {})));

  initPreview($('#preview'));
  initTimeline($('#timeline'));
  setFileDropHandler(uploadFiles);
  renderMediaTab();
  renderCaptionsTab();
  renderTimeline();
  renderInspector();
  syncTopbar();
  if (projectDuration() > 0) requestAnimationFrame(zoomToFit);

  loadProjectAudio();
  warmPreviews();
  on(kind => {
    if (kind === 'all') { loadProjectAudio(); warmPreviews(); refreshPlayback(); }
    if (kind === 'all' || kind === 'sel' || kind === 'live') renderTimeline();
    if (kind === 'all' || kind === 'sel') { renderInspector(); renderCaptionsTab(); }
    if (kind === 'all') syncTopbar();
    if (kind === 'play') $('#playBtn').textContent = state.playing ? '❚❚' : '▶';
    if (kind === 'zoom') $('#zoom').value = ppsToSlider(state.pps);
  });

  let lastSec = -1;
  onFrame(t => {
    updatePlayhead(t);
    $('#timeNow').textContent = fmtTime(t);
    // Keep the caption list's "now playing" marker fresh without a full re-render.
    const sec = Math.floor(t * 4);
    if (sec !== lastSec) {
      lastSec = sec;
      $$('.seg-row').forEach(r => {
        const seg = state.project.captionTracks.flatMap(c => c.segments).find(s => s.id === r.dataset.seg);
        r.classList.toggle('active', !!seg && t >= seg.start && t < seg.end);
      });
    }
  });

  bindUI();
}

function syncTopbar() {
  const name = $('#projectName');
  if (document.activeElement !== name) name.value = state.project.name;
  $('#undoBtn').disabled = !canUndo();
  $('#redoBtn').disabled = !canRedo();
  $('#timeTotal').textContent = fmtTime(projectDuration());
}

function bindUI() {
  $('#projectsBtn').onclick = showProjects;
  $('#projectName').onchange = e => { state.project.name = e.target.value || 'My video'; commit(); };
  $('#undoBtn').onclick = undo;
  $('#redoBtn').onclick = redo;
  $('#exportBtn').onclick = exportVideo;
  $('#playBtn').onclick = togglePlay;
  $('#splitBtn').onclick = () => { if (!splitAt()) toast('Put the playhead over a clip to split it.'); };
  $('#deleteBtn').onclick = deleteSelection;
  $('#addTrackBtn').onclick = () => { const t = newTrack(); state.project.tracks.unshift(t); state.sel = { kind: 'track', id: t.id }; commit(); };
  $('#addTextBtn').onclick = () => addTextCaption();
  $('#snapChk').onchange = e => { state.snap = e.target.checked; };
  $('#zoom').value = ppsToSlider(state.pps);
  $('#zoom').oninput = e => setZoom(sliderToPps(+e.target.value));
  $('#zoomIn').onclick = () => setZoom(state.pps * 1.4);
  $('#zoomOut').onclick = () => setZoom(state.pps / 1.4);
  $('#zoomFit').onclick = zoomToFit;
  $('#modal').onclick = e => { if (e.target.id === 'modal') { /* keep open on backdrop during export */ } };

  $$('.tabs button').forEach(b => {
    b.onclick = () => {
      $$('.tabs button').forEach(x => x.classList.toggle('active', x === b));
      $('#tab-media').classList.toggle('hidden', b.dataset.tab !== 'media');
      $('#tab-captions').classList.toggle('hidden', b.dataset.tab !== 'captions');
    };
  });

  // Resizable timeline height.
  const wrap = $('.timeline-wrap');
  const grip = document.createElement('div');
  grip.className = 'tl-resize';
  wrap.appendChild(grip);
  grip.onpointerdown = e => {
    e.preventDefault();
    const move = ev => {
      const h = Math.max(140, Math.min(window.innerHeight - 250, window.innerHeight - ev.clientY));
      document.body.style.setProperty('--tl-h', `${h}px`);
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); renderTimeline(); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // Stop the browser from opening files dropped outside drop zones.
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', e => e.preventDefault());

  window.addEventListener('keydown', e => {
    const tag = e.target.tagName;
    const typing = tag === 'TEXTAREA' || (tag === 'INPUT' && !['range', 'checkbox', 'color'].includes(e.target.type)) || tag === 'SELECT';
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === 'Escape') {
      if (cancelDrag()) return;
      if (typing) { e.target.blur(); return; }
      state.sel = null; state.multi.clear(); emit('sel'); return;
    }
    // ⌘A / Ctrl+A: select text in a field, otherwise every clip and caption on the timeline.
    // (In the macOS app the page must handle it: pywebview's native select-all is bypassed.)
    if (mod && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      if (typing) e.target.select?.();
      else { selectAll(); emit('sel'); }
      return;
    }
    if (typing) return;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (isDragging()) return; e.shiftKey ? redo() : undo(); return; }
    if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
    if (mod && e.key.toLowerCase() === 'e') { e.preventDefault(); exportVideo(); return; }
    if (mod) return;
    const frame = 1 / state.project.settings.fps;
    switch (e.key) {
      case ' ': e.preventDefault(); togglePlay(); break;
      case 's': case 'S': splitAt(); break;
      case 'Delete': case 'Backspace': e.preventDefault(); deleteSelection(); break;
      case 't': case 'T': addTextCaption(); break;
      case 'ArrowLeft': e.preventDefault(); pause(); seek(state.time - (e.shiftKey ? 1 : frame)); break;
      case 'ArrowRight': e.preventDefault(); pause(); seek(state.time + (e.shiftKey ? 1 : frame)); break;
      case 'Home': seek(0); break;
      case 'End': seek(projectDuration()); break;
      case '+': case '=': setZoom(state.pps * 1.4); break;
      case '-': case '_': setZoom(state.pps / 1.4); break;
    }
  });
}

boot().catch(err => {
  console.error(err);
  document.body.innerHTML = `<pre style="padding:20px;color:#f88">Failed to start TinyCutOpus:\n${err.stack || err}</pre>`;
});
