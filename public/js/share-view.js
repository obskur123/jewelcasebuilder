import { Preview3D, PRESETS } from './preview3d.js';
import { download } from './export.js';
import { deleteTokenFor, deletePublished } from './publish.js';

const $ = (sel) => document.querySelector(sel);

function toast(msg, { error = false, ms = 4000 } = {}) {
  const el = $('#toast');
  el.hidden = false;
  el.classList.toggle('error', error);
  el.textContent = msg;
  clearTimeout(toast.t);
  if (ms) toast.t = setTimeout(() => (el.hidden = true), ms);
}

const preview = new Preview3D($('#glCanvas'));

function syncControls(s) {
  $('#lidRange').value = String(Math.round(s.lid * 100));
  $('#foldRange').value = String(Math.round(s.fold * 100));
  $('#bookletOut').checked = s.bookletOut > 0.5;
  $('#flipBooklet').checked = s.flip > 0.5;
  $('#discOut').checked = s.discOut > 0.5;
}
preview.addEventListener('state', (e) => syncControls(e.detail));

$('#presets').addEventListener('click', (e) => {
  const name = e.target.closest('button')?.dataset.preset;
  if (name) preview.applyView(PRESETS[name]);
});
$('#lidRange').addEventListener('input', (e) => preview.setState({ lid: e.target.value / 100 }));
$('#foldRange').addEventListener('input', (e) => {
  const fold = e.target.value / 100;
  const out = fold > 0 || preview.target.bookletOut > 0.5;
  preview.setState({ fold, bookletOut: out ? 1 : 0, lid: out ? 1 : preview.target.lid, explode: out && preview.target.discOut > 0.5 ? 1 : 0 });
});
$('#bookletOut').addEventListener('change', (e) => {
  const out = e.target.checked;
  preview.setState({
    bookletOut: out ? 1 : 0,
    fold: out ? preview.target.fold : 0,
    flip: out ? preview.target.flip : 0,
    lid: out ? 1 : preview.target.lid,
    explode: out && preview.target.discOut > 0.5 ? 1 : 0,
  });
});
$('#flipBooklet').addEventListener('change', (e) => {
  const flip = e.target.checked ? 1 : 0;
  preview.setState({ flip, bookletOut: flip ? 1 : preview.target.bookletOut, lid: flip ? 1 : preview.target.lid });
});
$('#discOut').addEventListener('change', (e) => {
  const out = e.target.checked;
  preview.setState({ discOut: out ? 1 : 0, lid: out ? 1 : preview.target.lid, explode: out && preview.target.bookletOut > 0.5 ? 1 : 0 });
});
$('#trayColor').addEventListener('change', (e) => preview.setTrayColor(e.target.value));
$('#autoRotate').addEventListener('change', (e) => preview.setAutoRotate(e.target.checked));
$('#mockupBtn').addEventListener('click', async () => {
  const blob = await (await fetch(preview.snapshot())).blob();
  download(blob, `${($('#shareTitle').textContent || 'jewel-case').replace(/[^\w-]+/g, '-')}_mockup.png`);
});

async function init() {
  const id = $('#preview').dataset.shareId;
  const res = await fetch(`/api/shares/${id}`);
  if (!res.ok) {
    toast(res.status === 404 ? 'This share is gone.' : 'Could not load this share.', { error: true, ms: 0 });
    return;
  }
  const share = await res.json();
  $('#shareTitle').textContent = share.title || '';
  if (share.title) document.title = `${share.title} — Jewel Case`;
  preview.setTrayColor(share.scene?.trayColor || 'clear');
  $('#trayColor').value = share.scene?.trayColor || 'clear';
  await preview.applySheetImages({
    'booklet.outside': `/api/shares/${id}/textures/booklet.outside`,
    'booklet.inside': `/api/shares/${id}/textures/booklet.inside`,
    'traycard.outside': `/api/shares/${id}/textures/traycard.outside`,
    'traycard.inside': `/api/shares/${id}/textures/traycard.inside`,
    'disc.label': `/api/shares/${id}/textures/disc.label`,
  });
  preview.applyView(PRESETS.closed);

  const token = deleteTokenFor(id);
  if (token) {
    const btn = $('#deleteShareBtn');
    btn.hidden = false;
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this share? The link will stop working.')) return;
      try {
        await deletePublished(id, token);
        toast('Share deleted.');
        location.href = '/';
      } catch (err) {
        toast(err.message, { error: true });
      }
    });
  }
}

init().catch((err) => toast(err.message || 'Could not load this share.', { error: true, ms: 0 }));
