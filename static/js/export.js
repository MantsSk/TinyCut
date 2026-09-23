// Export: render caption frames with the preview renderer, then let ffmpeg composite everything.
import { state, projectDuration } from './store.js';
import { drawCaptions, captionKeyTimes, loadFonts } from './captions.js';
import { pause } from './preview.js';
import { modal, closeModal, esc, fmtTime } from './util.js';

const toBlob = canvas => new Promise(r => canvas.toBlob(r, 'image/png'));

export async function exportVideo() {
  pause();
  const p = state.project;
  const D = projectDuration();
  if (D <= 0) { modal('<h3>Nothing to export</h3><p class="dim">Add some clips to the timeline first.</p><button id="mClose">OK</button>').querySelector('#mClose').onclick = closeModal; return; }
  const { width: W, height: H, fps } = p.settings;
  let cancelled = false;
  const card = modal(`
    <h3>Exporting “${esc(p.name)}”</h3>
    <div class="dim small">${W}×${H} · ${fps} fps · ${fmtTime(D)}</div>
    <p id="xStage">Preparing…</p>
    <div class="bar"><i id="xBar"></i></div>
    <div class="btn-row" style="justify-content:flex-end;margin-top:14px"><button id="xCancel">Close</button></div>`);
  const stage = card.querySelector('#xStage'), bar = card.querySelector('#xBar');
  card.querySelector('#xCancel').onclick = () => { cancelled = true; closeModal(); };
  const setBar = f => { bar.style.width = `${Math.round(f * 100)}%`; };

  try {
    // 1) Caption layer as PNG "states" + durations.
    const tracks = p.captionTracks.filter(t => !t.hidden && t.segments.length);
    const form = new FormData();
    const manifest = [];
    if (tracks.length) {
      await loadFonts(tracks.map(t => t.style));
      const canvas = document.createElement('canvas');
      canvas.width = W; canvas.height = H;
      const ctx = canvas.getContext('2d');
      const keys = captionKeyTimes(tracks, fps, D);
      let files = 0, blank = null, prevSig = null;
      for (let i = 0; i < keys.length; i++) {
        if (cancelled) return;
        const a = keys[i], b = i + 1 < keys.length ? keys[i + 1] : D;
        if (b - a < 1e-4) continue;
        ctx.clearRect(0, 0, W, H);
        const sig = drawCaptions(ctx, W, H, tracks, a + 1e-4);
        if (sig === prevSig && manifest.length) { manifest[manifest.length - 1].dur += b - a; continue; }
        prevSig = sig;
        let idx;
        if (!sig) {
          if (blank == null) { blank = files++; form.append(`f${blank}`, await toBlob(canvas), 'blank.png'); }
          idx = blank;
        } else {
          idx = files++;
          form.append(`f${idx}`, await toBlob(canvas), `c${idx}.png`);
        }
        manifest.push({ file: idx, dur: b - a });
        if (i % 8 === 0) { stage.textContent = `Rendering captions… ${i}/${keys.length}`; setBar(0.25 * i / keys.length); await new Promise(r => setTimeout(r)); }
      }
    }
    form.append('project', JSON.stringify(p));
    form.append('captions', JSON.stringify(manifest));

    // 2) Upload + start ffmpeg.
    stage.textContent = 'Sending to renderer…';
    const { job } = await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/export');
      xhr.upload.onprogress = e => { if (e.lengthComputable) setBar(0.25 + 0.05 * e.loaded / e.total); };
      xhr.onload = () => (xhr.status === 200 ? resolve(JSON.parse(xhr.responseText)) : reject(new Error(JSON.parse(xhr.responseText || '{}').detail || `HTTP ${xhr.status}`)));
      xhr.onerror = () => reject(new Error('Network error'));
      xhr.send(form);
    });

    // 3) Poll.
    while (!cancelled) {
      await new Promise(r => setTimeout(r, 500));
      const s = await (await fetch(`/api/export/${job}`)).json();
      if (s.status === 'error') throw new Error(`ffmpeg failed:\n${s.error}`);
      setBar(0.3 + 0.7 * s.progress);
      stage.textContent = `Rendering video… ${Math.round(s.progress * 100)}%`;
      if (s.status === 'done') {
        card.innerHTML = `
          <h3>✅ Export ready</h3>
          <video src="${s.url}" controls autoplay muted></video>
          <div class="dim small">Saved to data/exports/${esc(s.file)}</div>
          <div class="btn-row" style="justify-content:flex-end;margin-top:14px">
            <button id="xClose">Close</button><a href="${s.url}" download><button class="primary">Download MP4</button></a></div>`;
        card.querySelector('#xClose').onclick = closeModal;
        return;
      }
    }
  } catch (err) {
    if (cancelled) return;
    card.innerHTML = `<h3>Export failed</h3><pre>${esc(err.message)}</pre>
      <div class="btn-row" style="justify-content:flex-end"><button id="xClose">Close</button></div>`;
    card.querySelector('#xClose').onclick = closeModal;
  }
}
