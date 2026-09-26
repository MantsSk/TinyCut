// Projects: create, open, duplicate and delete. Each project has its own timeline and media bin.
import { state, defaultProject, flushSave } from './store.js';
import { pause } from './preview.js';
import { modal, closeModal, esc, fmtShort, toast } from './util.js';

const json = (url, opts) => fetch(url, opts).then(r => (r.ok ? r.json() : Promise.reject(new Error(r.statusText))));

export function createProject(name) {
  return json('/api/projects', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(defaultProject(name)),
  });
}

/** Switching reloads the page, so every module starts clean for the other project. */
async function switchTo(action) {
  pause();
  await flushSave();
  await action();
  location.reload();
}

function ago(ts) {
  const s = Date.now() / 1000 - ts;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(ts * 1000).toLocaleDateString();
}

export async function showProjects() {
  await flushSave();  // so the open project's card is up to date
  const { current, projects } = await json('/api/projects');
  const card = modal(`
    <div class="proj-head"><h3>Projects</h3><button id="pClose" class="icon-btn" title="Close">✕</button></div>
    <div class="proj-new">
      <input id="pName" spellcheck="false" value="My video ${projects.length + 1}" title="Name for the new project">
      <button id="pCreate" class="primary">＋ New project</button>
    </div>
    <div class="proj-list">${projects.map(p => `
      <div class="proj${p.id === current ? ' current' : ''}" data-id="${p.id}" title="${p.id === current ? 'Open now' : 'Open this project'}">
        <div class="proj-thumb" style="${p.thumb ? `background-image:url('${p.thumb}')` : ''}"></div>
        <div class="proj-info"><b>${esc(p.name)}</b>
          <span class="dim small">${p.id === current ? 'Open now · ' : ''}${p.aspect || ''} · ${fmtShort(p.duration)} · edited ${ago(p.updated)}</span></div>
        <button data-act="dup" class="icon-btn" title="Duplicate">⧉</button>
        <button data-act="del" class="icon-btn danger" title="Delete">✕</button>
      </div>`).join('')}
    </div>`);

  card.querySelector('#pClose').onclick = closeModal;
  const name = card.querySelector('#pName');
  const create = () => switchTo(() => createProject(name.value.trim() || 'My video'));
  card.querySelector('#pCreate').onclick = create;
  name.onkeydown = e => { if (e.key === 'Enter') create(); };

  card.querySelectorAll('.proj').forEach(row => {
    const { id } = row.dataset;
    const p = projects.find(x => x.id === id);
    row.onclick = e => {
      if (e.target.closest('[data-act]')) return;
      if (id === current) closeModal();
      else switchTo(() => json(`/api/projects/${id}/open`, { method: 'POST' }));
    };
    row.querySelector('[data-act=dup]').onclick = async () => {
      await json(`/api/projects/${id}/duplicate`, { method: 'POST' });
      showProjects();
    };
    row.querySelector('[data-act=del]').onclick = async () => {
      if (!confirm(`Delete "${p.name}"? Its timeline and any media only it uses are removed. Exported videos are kept.`)) return;
      await json(`/api/projects/${id}`, { method: 'DELETE' });
      if (id === state.project.id) location.reload();  // opens the most recent remaining project
      else { toast(`Deleted "${p.name}".`); showProjects(); }
    };
  });
}
