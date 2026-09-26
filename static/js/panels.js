// Left panel (media bin, captions) and right panel (inspector).
import {
  state, emit, commit, findClip, findSeg, clipDur, repack, addMediaToTimeline, setAspect, ASPECTS,
  currentCaptionTrack, newCaptionTrack, applyPreset, regroup, setSegText, addTextCaption, timelineWords,
  splitAt, deleteSelection, projectDuration, extractAudio, addAudioAt, selectedIds,
} from './store.js';
import { PRESETS, FONTS, resolveStyle, drawSegment, groupWords, toSRT, POSITIONS } from './captions.js';
import { seek, play, pause } from './preview.js';
import { $, $$, esc, fmtTime, fmtShort, toast, modal, closeModal, native } from './util.js';

// ================================================================ media bin

export function renderMediaTab() {
  const el = $('#tab-media');
  const items = Object.values(state.media);
  el.innerHTML = `
    <div class="dropzone" id="dz"><b>Import media</b><br><span class="small">Click or drop videos, audio or images</span>
      <input type="file" id="fileIn" multiple accept="video/*,audio/*,image/*" hidden></div>
    <button class="rec-btn${recorder ? ' recording' : ''}" id="recBtn" title="Records your mic while the timeline plays, then drops it on an audio track">${recorder ? '■ Stop recording' : '🎙 Record voiceover at playhead'}</button>
    <div id="uploads"></div>
    <div class="media-grid">${items.map(m => `
      <div class="media-item" draggable="true" data-id="${m.id}" title="${esc(m.name)} — drag onto the timeline or press +">
        <div class="thumb" style="${m.thumb ? `background-image:url('${m.thumb}')` : ''}">${m.kind === 'audio' ? '♪' : ''}</div>
        <span class="dur">${m.kind === 'image' ? 'IMG' : fmtShort(m.duration)}</span>
        <button class="add" data-add="${m.id}" title="Add to timeline">+</button>
        <button class="del" data-del="${m.id}" title="Remove from project">✕</button>
        <div class="meta">${esc(m.name)}</div>
      </div>`).join('')}
    </div>
    ${items.length ? '' : '<p class="note">Tip: drop a few clips in, then drag them around on the MAIN track to reorder. Press <span class="kbd">S</span> to split at the playhead.</p>'}`;

  $('#recBtn').onclick = toggleRecording;
  const dz = $('#dz'), input = $('#fileIn');
  dz.onclick = () => input.click();
  input.onchange = async () => { const items = await uploadFiles([...input.files]); items.forEach(addMediaToTimeline); input.value = ''; };
  dz.ondragover = e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); dz.classList.add('over'); } };
  dz.ondragleave = () => dz.classList.remove('over');
  dz.ondrop = async e => {
    e.preventDefault(); dz.classList.remove('over');
    await uploadFiles([...e.dataTransfer.files]);
  };
  $$('.media-item', el).forEach(item => {
    item.ondragstart = e => {
      e.dataTransfer.setData('application/x-tinycut-media', item.dataset.id);
      e.dataTransfer.effectAllowed = 'copy';
    };
    item.ondblclick = () => addMediaToTimeline(state.media[item.dataset.id]);
  });
  $$('[data-add]', el).forEach(b => { b.onclick = e => { e.stopPropagation(); addMediaToTimeline(state.media[b.dataset.add]); }; });
  $$('[data-del]', el).forEach(b => { b.onclick = e => { e.stopPropagation(); removeMedia(b.dataset.del); }; });
}

function uploadOne(file, row) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const fd = new FormData();
    fd.append('file', file);
    xhr.open('POST', `/api/media?project=${state.project.id}`);
    xhr.upload.onprogress = e => { if (e.lengthComputable) row.querySelector('i').style.width = `${(e.loaded / e.total) * 90}%`; };
    xhr.upload.onload = () => { row.querySelector('span').textContent = `Processing ${file.name}…`; };
    xhr.onload = () => {
      if (xhr.status === 200) resolve(JSON.parse(xhr.responseText));
      else reject(new Error(JSON.parse(xhr.responseText || '{}').detail || `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error('Upload failed'));
    xhr.send(fd);
  });
}

export async function uploadFiles(files) {
  const out = [];
  const box = $('#uploads');
  for (const f of files) {
    const row = document.createElement('div');
    row.className = 'uploading';
    row.innerHTML = `<span>Uploading ${esc(f.name)}…</span><div class="bar"><i></i></div>`;
    box?.appendChild(row);
    try {
      const m = await uploadOne(f, row);
      state.media[m.id] = m;
      out.push(m);
    } catch (err) {
      toast(`${f.name}: ${err.message}`, 5000);
    }
    row.remove();
  }
  renderMediaTab();
  return out;
}

// ---------------------------------------------------------------- voiceover

let recorder = null;
async function toggleRecording() {
  if (recorder) { recorder.stop(); return; }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch (err) {
    toast(`Microphone unavailable: ${err.message}`, 5000);
    return;
  }
  const startAt = state.time;
  const chunks = [];
  const mime = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'].find(m => MediaRecorder.isTypeSupported(m)) || '';
  recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
  recorder.onstop = async () => {
    stream.getTracks().forEach(t => t.stop());
    recorder = null;
    pause();
    renderMediaTab();
    const type = chunks[0]?.type || 'audio/webm';
    const ext = type.includes('mp4') ? 'm4a' : 'webm';
    const n = Object.values(state.media).filter(m => m.name.startsWith('Voiceover')).length + 1;
    const file = new File(chunks, `Voiceover ${n}.${ext}`, { type });
    const [m] = await uploadFiles([file]);
    if (m) { addAudioAt(m, startAt); toast('Voiceover added to the timeline.'); }
  };
  recorder.start(250);
  // Play the timeline so you can narrate over it (muted tracks stay muted; use headphones to avoid echo).
  if (projectDuration() > state.time + 0.1) play();
  renderMediaTab();
}

async function removeMedia(id) {
  const used = state.project.tracks.some(t => t.clips.some(c => c.mediaId === id));
  if (used && !confirm('This media is used on the timeline. Remove it and its clips from this project?')) return;
  await fetch(`/api/media/${id}?project=${state.project.id}`, { method: 'DELETE' });
  delete state.media[id];
  for (const t of state.project.tracks) { t.clips = t.clips.filter(c => c.mediaId !== id); repack(t); }
  renderMediaTab();
  commit();
}

// ================================================================ captions tab

const LANGS = [['auto', 'Auto-detect'], ['en', 'English'], ['lt', 'Lithuanian'], ['de', 'German'], ['fr', 'French'], ['es', 'Spanish'],
  ['it', 'Italian'], ['pt', 'Portuguese'], ['nl', 'Dutch'], ['pl', 'Polish'], ['uk', 'Ukrainian'], ['ru', 'Russian'], ['lv', 'Latvian'],
  ['et', 'Estonian'], ['sv', 'Swedish'], ['ja', 'Japanese'], ['ko', 'Korean'], ['zh', 'Chinese']];

export function renderCaptionsTab() {
  const el = $('#tab-captions');
  const ct = currentCaptionTrack();
  const activePreset = ct ? ct.style.preset : state.captionPreset;
  el.innerHTML = `
    <div class="section-title">Auto captions</div>
    <div class="row"><label>Language</label><select id="lang">${LANGS.map(([v, n]) => `<option value="${v}"${v === state.language ? ' selected' : ''}>${n}</option>`).join('')}</select></div>
    <button class="big-btn" id="genCaps">✨ Generate captions from timeline</button>
    <div class="note" id="capStatus">Transcribes the speech on your timeline locally with Whisper, word by word. Creates a new caption track, so you can stack several differently styled subtitle tracks.</div>

    <div class="section-title">Style</div>
    <div class="note">${ct ? `Click a style to apply it to <b>${esc(ct.name)}</b>.` : 'Pick a style for the next caption track.'}</div>
    <div class="preset-grid">${Object.entries(PRESETS).map(([k, p]) => `
      <div class="preset${k === activePreset ? ' active' : ''}" data-preset="${k}"><canvas width="320" height="200"></canvas><div class="name">${p.label}</div></div>`).join('')}
    </div>

    <div class="section-title">Caption tracks</div>
    <div class="btn-row">
      <button id="addText">＋ Text caption</button>
      <button id="newTrack">＋ Empty track</button>
      <button id="srt"${ct ? '' : ' disabled'}>⤓ Export .srt</button>
    </div>`;

  $('#lang').onchange = e => { state.language = e.target.value; };
  $('#genCaps').onclick = generateCaptions;
  $('#addText').onclick = () => addTextCaption();
  $('#newTrack').onclick = () => { const t = newCaptionTrack(); state.sel = { kind: 'ctrack', id: t.id }; commit(); };
  $('#srt').onclick = () => {
    const t = currentCaptionTrack();
    if (!t) return;
    const name = `${state.project.name || 'captions'} - ${t.name}.srt`;
    if (native()) { native().save_text(name, toSRT(t)); return; }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([toSRT(t)], { type: 'text/plain' }));
    a.download = name;
    a.click();
  };
  $$('.preset', el).forEach(card => {
    card.onclick = () => {
      const key = card.dataset.preset;
      state.captionPreset = key;
      const t = currentCaptionTrack();
      if (t) { applyPreset(t, key); commit(); } else renderCaptionsTab();
    };
  });
}

// Animated style previews.
const SAMPLE = { id: 'sample', start: 0, end: 2.4, words: [
  { t0: 0, t1: 0.45, text: 'This' }, { t0: 0.5, t1: 0.9, text: 'looks' }, { t0: 0.95, t1: 1.5, text: 'really' }, { t0: 1.55, t1: 2.3, text: 'good' }] };
function animatePresets(now) {
  requestAnimationFrame(animatePresets);
  const tab = $('#tab-captions');
  if (!tab || tab.classList.contains('hidden')) return;
  const t = (now / 1000) % 2.8;
  for (const card of tab.querySelectorAll('.preset')) {
    const c = card.querySelector('canvas');
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, c.width, c.height);
    const S = resolveStyle({ preset: card.dataset.preset });
    S.size *= 2.2; S.position = 'middle'; S.offset = 0;
    if (t < SAMPLE.end) drawSegment(ctx, c.width, c.height, SAMPLE, S, t);
  }
}
requestAnimationFrame(animatePresets);

async function generateCaptions() {
  const btn = $('#genCaps'), status = $('#capStatus');
  const ids = [...new Set(state.project.tracks.filter(t => !t.muted)
    .flatMap(t => t.clips.map(c => c.mediaId)).filter(id => state.media[id]?.has_audio))];
  if (!ids.length) { toast('Add a clip with audio to the timeline first.'); return; }
  btn.disabled = true;
  const transcripts = {};
  try {
    for (let i = 0; i < ids.length; i++) {
      const m = state.media[ids[i]];
      status.textContent = `Transcribing “${m.name}” (${i + 1}/${ids.length})… first run of a long clip can take a moment.`;
      let r = await fetch(`/api/media/${m.id}/transcribe?language=${state.language}`, { method: 'POST' });
      if (r.status === 409) {
        // First run: no speech model on this machine yet.
        if (!(await downloadModel())) { status.textContent = 'Captions need the speech model. Click Generate to try again.'; return; }
        status.textContent = `Transcribing “${m.name}” (${i + 1}/${ids.length})… the very first run takes a few extra seconds.`;
        r = await fetch(`/api/media/${m.id}/transcribe?language=${state.language}`, { method: 'POST' });
      }
      const data = await r.json();
      if (!r.ok) throw new Error(data.detail || 'Transcription failed');
      transcripts[m.id] = data.words;
    }
    const words = timelineWords(transcripts);
    if (!words.length) { status.textContent = 'No speech found in the clips on your timeline.'; return; }
    const ct = newCaptionTrack(state.captionPreset, `Captions ${state.project.captionTracks.length + 1}`);
    ct.segments = groupWords(words, ct.style.maxWords);
    state.sel = { kind: 'ctrack', id: ct.id };
    commit();
    toast(`Added ${ct.segments.length} captions (${words.length} words).`);
  } catch (err) {
    status.textContent = `⚠️ ${err.message}`;
  } finally {
    btn.disabled = false;
  }
}

/** Ask which Whisper model to fetch, download it with progress. Resolves true when ready. */
function downloadModel() {
  return new Promise(resolve => {
    const card = modal(`
      <h3>Download the speech model</h3>
      <p class="dim">Captions are transcribed on this computer. It needs a one-time download of a speech model — pick one:</p>
      <div class="btn-row">
        <button class="primary" data-model="small">Accurate · ~490 MB</button>
        <button data-model="base">Fast · ~150 MB</button>
      </div>
      <div id="mProg" class="hidden"><p id="mText" class="dim">Starting…</p><div class="bar"><i id="mBar"></i></div></div>
      <div class="btn-row" style="justify-content:flex-end;margin-top:14px"><button id="mCancel">Not now</button></div>`);
    let done = false;
    const finish = ok => { if (done) return; done = true; closeModal(); resolve(ok); };
    card.querySelector('#mCancel').onclick = () => finish(false);
    card.querySelectorAll('[data-model]').forEach(b => {
      b.onclick = async () => {
        card.querySelectorAll('[data-model]').forEach(x => { x.disabled = true; });
        card.querySelector('#mProg').classList.remove('hidden');
        await fetch(`/api/model/download?name=${b.dataset.model}`, { method: 'POST' });
        while (!done) {
          const s = await (await fetch('/api/model/download')).json();
          if (s.status === 'done') { finish(true); return; }
          if (s.status === 'error') {
            card.querySelector('#mText').textContent = `Download failed: ${s.error}`;
            card.querySelectorAll('[data-model]').forEach(x => { x.disabled = false; });
            return;
          }
          const f = s.total ? s.done / s.total : 0;
          card.querySelector('#mBar').style.width = `${Math.round(f * 100)}%`;
          card.querySelector('#mText').textContent = `Downloading… ${Math.round(s.done / 1e6)} / ${Math.round(s.total / 1e6)} MB`;
          await new Promise(r => setTimeout(r, 400));
        }
      };
    });
  });
}

// ================================================================ inspector

const fmtByKey = {};
const MOD = /Mac/.test(navigator.platform) ? '⌘' : 'Ctrl+';
const MODKEY = MOD === '⌘' ? '⌘' : 'Ctrl';
const slider = (label, key, min, max, step, value, fmt = v => (+v).toFixed(2)) => (fmtByKey[key] = fmt, `
  <div class="row"><label>${label}</label><input type="range" data-k="${key}" min="${min}" max="${max}" step="${step}" value="${value}">
  <span class="val" data-v="${key}">${fmt(value)}</span></div>`);
const pct = v => `${Math.round(v * 100)}%`;

export function renderInspector() {
  const el = $('#inspector');
  const sel = state.sel;
  const ids = selectedIds();
  if (ids.size > 1) return multiInspector(el, ids);
  if (sel?.kind === 'clip') {
    const f = findClip(sel.id);
    if (f) return clipInspector(el, f);
  }
  if (sel?.kind === 'seg' || sel?.kind === 'ctrack') {
    const ct = currentCaptionTrack();
    if (ct) return captionInspector(el, ct, sel.kind === 'seg' ? findSeg(sel.id)?.seg : null);
  }
  if (sel?.kind === 'track') {
    const t = state.project.tracks.find(t => t.id === sel.id);
    if (t) return trackInspector(el, t);
  }
  projectInspector(el);
}

function multiInspector(el, ids) {
  const clips = [...ids].filter(id => findClip(id)).length;
  const caps = ids.size - clips;
  const parts = [clips && `${clips} clip${clips > 1 ? 's' : ''}`, caps && `${caps} caption${caps > 1 ? 's' : ''}`].filter(Boolean);
  el.innerHTML = `
    <div class="insp-title">${ids.size} items selected</div>
    <div class="insp-sub">${parts.join(' · ')}</div>
    <div class="btn-row">
      <button id="mSplit" title="Split the selected items at the playhead (S)">✂ Split at playhead</button>
      <button id="mDel" class="danger" title="Delete (⌫)">🗑 Delete</button>
    </div>
    <p class="note">Drag any of them to move them together (clips on the MAIN track keep their place).
      Shift/${MODKEY}-click adds or removes one, drag on an empty part of the timeline to box-select, ${MOD}A selects everything.</p>`;
  $('#mSplit', el).onclick = () => { if (!splitAt()) toast('Put the playhead over a selected item to split it.'); };
  $('#mDel', el).onclick = deleteSelection;
}

function bindInputs(el, apply) {
  $$('[data-k]', el).forEach(inp => {
    const read = () => (inp.type === 'checkbox' ? inp.checked : inp.type === 'range' || inp.type === 'number' ? parseFloat(inp.value) : inp.value);
    inp.addEventListener('input', () => {
      apply(inp.dataset.k, read(), false);
      const v = el.querySelector(`[data-v="${inp.dataset.k}"]`);
      if (v) v.textContent = (fmtByKey[inp.dataset.k] || String)(read());
      emit('live');
    });
    inp.addEventListener('change', () => { apply(inp.dataset.k, read(), true); commit(); });
  });
}

function clipInspector(el, { clip, track }) {
  const m = state.media[clip.mediaId] || { name: 'Missing', kind: 'video' };
  const visual = m.kind !== 'audio';
  el.innerHTML = `
    <div class="insp-title">${m.kind === 'audio' || clip.audioOnly ? '♪ Audio clip' : m.kind === 'image' ? '🖼 Image clip' : '🎬 Video clip'}</div>
    <div class="insp-sub">${esc(m.name)} · on ${esc(track.name)}</div>
    <div class="row"><label>Timeline</label><span class="dim">${fmtTime(clip.start)} → ${fmtTime(clip.start + clipDur(clip))}</span></div>
    <div class="row"><label>Source</label><span class="dim">${fmtTime(clip.in)} → ${fmtTime(clip.out)}</span></div>
    <div class="row"><label>Length</label><span class="dim">${clipDur(clip).toFixed(2)}s</span></div>
    ${m.has_audio ? `<div class="section-title">Audio</div>
      ${slider('Volume', 'volume', 0, 2, 0.01, clip.volume ?? 1, pct)}
      ${slider('Fade in', 'fadeIn', 0, Math.min(10, clipDur(clip) / 2), 0.05, clip.fadeIn || 0, v => `${(+v).toFixed(1)}s`)}
      ${slider('Fade out', 'fadeOut', 0, Math.min(10, clipDur(clip) / 2), 0.05, clip.fadeOut || 0, v => `${(+v).toFixed(1)}s`)}
      <div class="btn-row">
        <button id="muteClip">${(clip.volume ?? 1) > 0 ? '🔇 Mute clip' : '🔊 Unmute clip'}</button>
        ${m.kind === 'video' && !clip.audioOnly ? '<button id="extractBtn" title="Move this clip\'s sound to its own audio clip">♪ Extract audio</button>' : ''}
      </div>
      ${(clip.volume ?? 1) > 1 ? '<div class="note">Preview plays at max 100%; the boost is applied on export.</div>' : ''}` : ''}
    ${visual && !clip.audioOnly ? `<div class="section-title">Transform</div>
      ${slider('Scale', 'scale', 0.1, 3, 0.01, clip.scale ?? 1, pct)}
      ${slider('Position X', 'x', -1, 1, 0.005, clip.x ?? 0, pct)}
      ${slider('Position Y', 'y', -1, 1, 0.005, clip.y ?? 0, pct)}
      ${slider('Opacity', 'opacity', 0, 1, 0.01, clip.opacity ?? 1, pct)}
      <div class="btn-row"><button id="fillBtn">Fill frame</button><button id="pipBtn">Picture-in-picture</button><button id="resetBtn">Reset</button></div>` : ''}
    <div class="section-title">Edit</div>
    <div class="btn-row"><button id="splitIns">✂ Split at playhead</button><button id="delIns" class="danger">Delete</button></div>`;
  bindInputs(el, (k, v) => { clip[k] = v; });
  const set = patch => { Object.assign(clip, patch); commit(); };
  $('#resetBtn', el)?.addEventListener('click', () => set({ scale: 1, x: 0, y: 0, opacity: 1 }));
  $('#pipBtn', el)?.addEventListener('click', () => set({ scale: 0.35, x: 0.3, y: -0.28 }));
  $('#fillBtn', el)?.addEventListener('click', () => {
    const S = state.project.settings;
    const sw = m.width || S.width, sh = m.height || S.height;
    const contain = Math.min(S.width / sw, S.height / sh), cover = Math.max(S.width / sw, S.height / sh);
    set({ scale: +(cover / contain).toFixed(3), x: 0, y: 0 });
  });
  $('#muteClip', el)?.addEventListener('click', () => set({ volume: (clip.volume ?? 1) > 0 ? 0 : 1 }));
  $('#extractBtn', el)?.addEventListener('click', () => extractAudio(clip.id));
  $('#splitIns', el).onclick = () => { if (!splitAt()) toast('Move the playhead over this clip to split it.'); };
  $('#delIns', el).onclick = deleteSelection;
}

function captionInspector(el, ct, seg) {
  const S = resolveStyle(ct.style);
  const opts = (list, cur) => list.map(([v, n]) => `<option value="${v}"${v === cur ? ' selected' : ''}>${n}</option>`).join('');
  const t = state.time;
  el.innerHTML = `
    <div class="insp-title">💬 ${esc(ct.name)}</div>
    <div class="insp-sub">${ct.segments.length} captions · each caption track has its own style</div>
    ${seg ? `<div class="section-title">Selected caption</div>
      <textarea id="segText" rows="2">${esc(seg.words.map(w => w.text).join(' '))}</textarea>
      <div class="row"><label>Start / end</label>
        <input type="number" id="segStart" step="0.05" min="0" value="${seg.start.toFixed(2)}">
        <input type="number" id="segEnd" step="0.05" min="0" value="${seg.end.toFixed(2)}"></div>
      <div class="btn-row"><button id="segSplit">✂ Split at playhead</button><button id="segDel" class="danger">Delete caption</button></div>` : ''}
    <div class="section-title">Style</div>
    <div class="row"><label>Preset</label><select data-k="preset">${opts(Object.entries(PRESETS).map(([k, p]) => [k, p.label]), S.preset)}</select></div>
    <div class="row"><label>Font</label><select data-k="font">${opts(FONTS.map(f => [f, f]), S.font)}</select></div>
    ${slider('Size', 'size', 0.4, 3, 0.05, S.size)}
    <div class="row"><label>Position</label><div class="segmented">${POSITIONS.map(p => `<button data-pos="${p}" class="${S.position === p ? 'active' : ''}">${p}</button>`).join('')}</div></div>
    ${slider('Nudge', 'offset', -0.2, 0.2, 0.005, S.offset || 0, v => `${v > 0 ? '+' : ''}${Math.round(v * 100)}%`)}
    <div class="row"><label>Text / accent</label><input type="color" data-k="color" value="${S.color}"><input type="color" data-k="accent" value="${S.accent}"></div>
    <div class="row"><label>Display</label><select data-k="mode">${opts([['block', 'Whole caption'], ['word', 'One word at a time'], ['reveal', 'Word-by-word reveal']], S.mode)}</select></div>
    <div class="row"><label>Highlight</label><select data-k="highlight">${opts([['none', 'None'], ['color', 'Active word color'], ['box', 'Active word box'], ['dim', 'Dim others'], ['cycle', 'Cycle colors']], S.highlight)}</select></div>
    <div class="row"><label>Animation</label><select data-k="anim">${opts([['none', 'None'], ['fade', 'Fade in'], ['pop', 'Pop'], ['slide', 'Slide up']], S.anim)}</select></div>
    <div class="row"><label>Word pop</label><input type="checkbox" data-k="wordPop"${S.wordPop ? ' checked' : ''}>
      <label style="flex:0 0 auto">UPPERCASE</label><input type="checkbox" data-k="uppercase"${S.uppercase ? ' checked' : ''}></div>
    ${slider('Outline', 'stroke', 0, 0.3, 0.01, S.stroke)}
    ${slider('Shadow', 'shadow', 0, 1, 0.05, S.shadow)}
    <div class="row"><label>Background</label><select data-k="box">${opts([['none', 'None'], ['full', 'Box'], ['line', 'Per line']], S.box)}</select><input type="color" data-k="boxColor" value="${S.boxColor}"></div>
    ${S.box !== 'none' ? slider('Bg opacity', 'boxOpacity', 0, 1, 0.01, S.boxOpacity) : ''}
    ${slider('Words / caption', 'maxWords', 1, 12, 1, S.maxWords, v => v)}
    <div class="section-title">Captions <span class="dim" style="text-transform:none;letter-spacing:0">— click a time to jump</span></div>
    <div class="seg-list">${ct.segments.map(s => `
      <div class="seg-row${seg?.id === s.id ? ' sel' : ''}${t >= s.start && t < s.end ? ' active' : ''}" data-seg="${s.id}">
        <span class="ts">${fmtShort(s.start)}.${String(Math.floor((s.start % 1) * 10))}</span>
        <input value="${esc(s.words.map(w => w.text).join(' '))}"></div>`).join('')}
    </div>`;

  bindInputs(el, (k, v, final) => {
    if (k === 'preset') { if (final) applyPreset(ct, v); return; }
    ct.style[k] = v;
    if (k === 'maxWords' && final) regroup(ct);
    if (k === 'uppercase' && v) ct.style.lowercase = false;
  });
  $$('[data-pos]', el).forEach(b => { b.onclick = () => { ct.style.position = b.dataset.pos; ct.style.offset = 0; commit(); }; });
  if (seg) {
    $('#segText', el).oninput = e => { setSegText(seg, e.target.value); emit('live'); };
    $('#segText', el).onchange = () => commit();
    const setTimes = () => {
      const s = Math.max(0, parseFloat($('#segStart', el).value) || 0);
      const e = Math.max(s + 0.1, parseFloat($('#segEnd', el).value) || s + 1);
      const os = seg.start, k = (e - s) / Math.max(1e-6, seg.end - seg.start);
      for (const w of seg.words) { w.t0 = s + (w.t0 - os) * k; w.t1 = s + (w.t1 - os) * k; }
      seg.start = s; seg.end = e;
      commit();
    };
    $('#segStart', el).onchange = setTimes;
    $('#segEnd', el).onchange = setTimes;
    $('#segSplit', el).onclick = () => { if (!splitAt()) toast('Move the playhead inside this caption to split it.'); };
    $('#segDel', el).onclick = deleteSelection;
  }
  $$('.seg-row', el).forEach(row => {
    const s = ct.segments.find(x => x.id === row.dataset.seg);
    row.querySelector('.ts').onclick = () => { state.sel = { kind: 'seg', id: s.id }; seek(s.start + 0.01); emit('sel'); };
    const inp = row.querySelector('input');
    inp.oninput = () => { setSegText(s, inp.value); emit('live'); };
    inp.onchange = () => commit();
    inp.onkeydown = e => { if (e.key === 'Enter') inp.blur(); };
  });
  // Keep the selected caption in view.
  const selRow = el.querySelector('.seg-row.sel'), list = el.querySelector('.seg-list');
  if (selRow && list) list.scrollTop = selRow.offsetTop - list.offsetTop - list.clientHeight / 2;
}

function trackInspector(el, t) {
  el.innerHTML = `
    <div class="insp-title">${t.main ? 'Main track' : 'Track'}</div>
    <div class="insp-sub">${t.clips.length} clip(s)${t.main ? ' · magnetic: clips stay packed, drag to reorder' : ' · free placement, layered over tracks below'}</div>
    <div class="row"><label>Name</label><input type="text" data-k="name" value="${esc(t.name)}"></div>
    <div class="row"><label>Muted</label><input type="checkbox" data-k="muted"${t.muted ? ' checked' : ''}></div>
    <div class="row"><label>Hidden</label><input type="checkbox" data-k="hidden"${t.hidden ? ' checked' : ''}></div>
    ${t.main ? '' : '<div class="btn-row"><button id="delTrack" class="danger">Delete track</button></div>'}`;
  bindInputs(el, (k, v) => { t[k] = v; });
  $('#delTrack', el)?.addEventListener('click', deleteSelection);
}

function projectInspector(el) {
  const p = state.project;
  const S = p.settings;
  const D = projectDuration();
  el.innerHTML = `
    <div class="insp-title">Project</div>
    <div class="insp-sub">${S.width}×${S.height} · ${S.fps} fps · ${fmtTime(D)}</div>
    <div class="section-title">Canvas</div>
    <div class="aspects">${Object.keys(ASPECTS).map(a => {
      const [w, h] = ASPECTS[a]; const k = 22 / Math.max(w, h);
      return `<button data-aspect="${a}" class="${S.aspect === a ? 'active' : ''}"><i style="width:${w * k}px;height:${h * k}px"></i>${a}</button>`;
    }).join('')}</div>
    <div class="row" style="margin-top:10px"><label>Resolution</label><select id="res">${[720, 1080, 1440, 2160].map(r => `<option value="${r}"${(S.res || 1080) === r ? ' selected' : ''}>${r}p</option>`).join('')}</select></div>
    <div class="row"><label>Frame rate</label><select id="fps">${[24, 25, 30, 50, 60].map(r => `<option${S.fps === r ? ' selected' : ''}>${r}</option>`).join('')}</select></div>
    <div class="section-title">Shortcuts</div>
    <div class="shortcuts">
      <span class="kbd">Space</span><span>Play / pause</span>
      <span class="kbd">S</span><span>Split at playhead</span>
      <span class="kbd">⌫</span><span>Delete selection</span>
      <span class="kbd">${MOD}A</span><span>Select all clips &amp; captions</span>
      <span class="kbd">⇧ / ${MODKEY} click</span><span>Add to / remove from selection</span>
      <span class="kbd">drag empty lane</span><span>Box-select</span>
      <span class="kbd">T</span><span>Add text caption</span>
      <span class="kbd">← →</span><span>Step one frame (⇧ = 1s)</span>
      <span class="kbd">${MOD}Z</span><span>Undo (⇧${MOD}Z redo)</span>
      <span class="kbd">${MOD} + scroll</span><span>Zoom timeline</span>
      <span class="kbd">+ / −</span><span>Zoom in / out</span>
    </div>
    <p class="note" style="margin-top:14px">Select a clip to set volume, scale and position (e.g. picture-in-picture on an overlay track). Select a caption to edit its text and style.</p>`;
  $$('[data-aspect]', el).forEach(b => { b.onclick = () => { setAspect(b.dataset.aspect); commit(); }; });
  $('#res', el).onchange = e => { setAspect(S.aspect, +e.target.value); commit(); };
  $('#fps', el).onchange = e => { S.fps = +e.target.value; commit(); };
}
