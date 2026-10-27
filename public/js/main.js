import { PARTS, PANELS, SHEETS, sheetInfo, sheetSize, panelRect, bleedEdges, SWAP_GROUPS, FONTS } from './spec.js';
import { store, makeText } from './store.js';
import { renderSheet, onAssetLoaded, imageDpi, sheetImageDpi, safetyWarnings, whenImagesReady } from './render.js';
import { prepareFile, fitSheetUpload } from './upload.js';
import { Preview3D, PANEL_VIEWS, PRESETS } from './preview3d.js';
import { exportPdf, exportPngs, download, slug } from './export.js';
import { buildBundle, readBundle, isZip } from './bundle.js';
import { assetUrl, requestPersistence } from './assets.js';
import { publishShare } from './publish.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function h(tag, props = {}, ...kids) {
  const node = document.createElement(tag);
  let value;
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'value') value = v;
    else if (k === 'class') node.className = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k in node && typeof v !== 'string') node[k] = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) node.append(kid.nodeType ? kid : String(kid));
  if (value !== undefined) node.value = value;
  return node;
}

const MAIN_PANEL = {
  'booklet.outside': 'bk_front',
  'booklet.inside': 'bk_inside_front',
  'traycard.outside': 'tc_back',
  'traycard.inside': 'tc_inside',
  'disc.label': 'disc_label',
};
const SHEET_TABS = [
  ['booklet.outside', 'Booklet · Outside'],
  ['booklet.inside', 'Booklet · Inside'],
  ['traycard.outside', 'Tray · Outside'],
  ['traycard.inside', 'Tray · Inside'],
  ['disc.label', 'Disc'],
];
const SWATCHES = ['#ffffff', '#151515', '#f1ede4', '#ff4a1c', '#f2c14e', '#2f5d50', '#1d3fbb', '#d7c4e8'];
const ACCENT = '#ff4a1c';

const ui = {
  sheetKey: 'booklet.outside',
  panelId: 'bk_front',
  textId: null,
  guides: true,
  hits: [],
  drag: null,
  hoverPanel: null,
  view: { ppi: 50, dpr: 1 },
};

const canvas = $('#sheetCanvas');
const thumbs = {};
let dragPanel = null;

// ---------- small helpers ----------

let toastTimer;
function toast(msg, { error = false, ms = 3500 } = {}) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('error', error);
  t.hidden = false;
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(() => (t.hidden = true), ms);
}

const live = (mutate) => store.update(mutate, { history: false });
const commit = () => store.commit();

const IMAGE_ACCEPT = 'image/jpeg,image/png,image/webp,application/pdf,.pdf';

function pickFile(onFile, accept = IMAGE_ACCEPT) {
  const input = $('#fileInput');
  input.value = '';
  input.accept = accept;
  input.onchange = () => input.files[0] && onFile(input.files[0]);
  input.click();
}

const fileFromDrop = (e) => [...(e.dataTransfer?.files || [])][0];
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
const fmtIn = (v) => `${(+v.toFixed(3)).toString()}"`;
const swapGroupOf = (id) => Object.values(SWAP_GROUPS).find((g) => g.includes(id));

// ---------- navigation ----------

function buildNav() {
  const nav = $('#partsNav');
  nav.innerHTML = '';
  for (const [partKey, part] of Object.entries(PARTS)) {
    const sec = h('div', { class: 'part' }, h('div', { class: 'part-head' }, h('b', {}, part.name), h('small', {}, part.code)));
    for (const [sheetKey, sheet] of Object.entries(part.sheets)) {
      const key = `${partKey}.${sheetKey}`;
      const label = h(
          'div',
          { class: 'sheet-label', dataset: { sheet: key }, title: 'Drop a finished sheet here' },
          h('span', {}, partKey === 'disc' ? 'Label' : `${sheet.name} (${sheet.uploadLabel})`),
          h(
            'button',
            {
              class: 'btn ghost small',
              title: `Upload a finished ${partKey === 'disc' ? 'disc label' : `${part.name.toLowerCase()} ${sheet.name.toLowerCase()}`}`,
              onclick: () => pickFile((f) => uploadSheet(key, f)),
            },
            '↑ Upload',
          ),
        );
      acceptSheetDrop(label, () => key);
      sec.append(label);
      for (const p of sheet.panels) {
        const thumb = h('canvas', { width: 40, height: 40 });
        thumbs[p.id] = thumb;
        const group = swapGroupOf(p.id);
        const item = h(
          'button',
          {
            class: 'panel-item',
            dataset: { panel: p.id },
            draggable: group ? 'true' : null,
            title: group ? 'Click to edit · drag onto another booklet panel to swap' : 'Click to edit · drop an image here',
            onclick: () => selectPanel(p.id),
          },
          h('span', { class: `thumb${part.round ? ' round' : ''}` }, thumb),
          h('span', { class: 'name' }, p.name),
          p.page ? h('span', { class: 'page' }, `p${p.page}`) : null,
        );
        item.addEventListener('dragstart', (e) => {
          dragPanel = p.id;
          e.dataTransfer.setData('text/plain', p.id);
          e.dataTransfer.effectAllowed = 'move';
        });
        item.addEventListener('dragend', () => {
          dragPanel = null;
          $$('.panel-item.drop-target').forEach((n) => n.classList.remove('drop-target'));
        });
        item.addEventListener('dragover', (e) => {
          const canSwap = dragPanel && dragPanel !== p.id && swapGroupOf(dragPanel) === group && group;
          if (canSwap || (!dragPanel && hasFiles(e))) {
            e.preventDefault();
            item.classList.add('drop-target');
          }
        });
        item.addEventListener('dragleave', () => item.classList.remove('drop-target'));
        item.addEventListener('drop', (e) => {
          e.preventDefault();
          item.classList.remove('drop-target');
          if (dragPanel) swapPanels(dragPanel, p.id);
          else if (fileFromDrop(e)) uploadPanelImage(p.id, fileFromDrop(e));
        });
        sec.append(item);
      }
    }
    nav.append(sec);
  }
  nav.append(
    h(
      'p',
      { class: 'nav-tip' },
      'Drag booklet panels onto each other to swap artwork. Drop images straight onto a panel here or on the sheet.',
    ),
  );
}

function swapPanels(a, b) {
  store.update((p) => {
    [p.panels[a], p.panels[b]] = [p.panels[b], p.panels[a]];
  });
  toast(`Swapped ${PANELS[a].name} ↔ ${PANELS[b].name}`);
  renderInspector();
}

function buildTabs() {
  const tabs = $('#sheetTabs');
  tabs.innerHTML = '';
  for (const [key, label] of SHEET_TABS) {
    tabs.append(h('button', { role: 'tab', dataset: { sheet: key }, onclick: () => selectSheet(key) }, label));
  }
}

function selectSheet(key) {
  if (key === ui.sheetKey) return;
  const current = PANELS[ui.panelId];
  selectPanel(current.sheetId === key ? ui.panelId : MAIN_PANEL[key]);
}

function selectPanel(id, { textId = null } = {}) {
  ui.panelId = id;
  ui.textId = textId;
  const key = PANELS[id].sheetId;
  if (key !== ui.sheetKey) {
    ui.sheetKey = key;
    layoutSheet();
  }
  updateSheetBar();
  $$('.panel-item').forEach((n) => n.classList.toggle('active', n.dataset.panel === id));
  renderInspector();
  scheduleSheetRender();
  updatePreviewEdit();
}

// ---------- sheet bar ----------

function updateSheetBar() {
  const info = sheetInfo(ui.sheetKey);
  const sd = store.sheet(ui.sheetKey);
  $$('#sheetTabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.sheet === ui.sheetKey)));
  $('#sheetBg').value = sd.bg || '#ffffff';
  $('#sheetUploadBtn').textContent =
    info.partKey === 'disc' ? 'Upload finished disc label' : `Upload finished ${info.sheet.name.toLowerCase()} (${info.sheet.uploadLabel})`;

  const notice = $('#sheetNotice');
  if (sd.image) {
    const dpi = sheetImageDpi(ui.sheetKey, sd.image);
    const low = dpi && dpi < 250;
    notice.hidden = false;
    notice.className = `sheet-notice${sd.image.warn || low ? ' warn' : ''}`;
    notice.replaceChildren(
      h(
        'span',
        { class: 'grow' },
        `Using uploaded artwork. ${sd.image.note || ''} ${dpi ? `≈${dpi} DPI${low ? ' — low for print, 300 recommended.' : '.'}` : ''} Panel edits draw on top of it.`,
      ),
      h('button', { class: 'btn small', onclick: () => pickFile((f) => uploadSheet(ui.sheetKey, f)) }, 'Replace'),
      h(
        'button',
        {
          class: 'btn small danger',
          onclick: () => {
            store.update((p) => {
              p.sheets[ui.sheetKey].image = null;
            });
            updateSheetBar();
          },
        },
        'Remove',
      ),
    );
  } else {
    notice.hidden = true;
  }

  const { part, sheet } = info;
  const size = sheetSize(part);
  $('#sheetMeta').textContent =
    `${part.code} ${part.name} · ${sheet.name} · trim ${fmtIn(part.trimW)} × ${fmtIn(part.trimH)}` +
    (part.bleed ? ` · with bleed ${fmtIn(size.w)} × ${fmtIn(size.h)}` : '') +
    ` · ${Math.round(size.w * 300)} × ${Math.round(size.h * 300)} px @ 300 DPI`;

  $$('.sheet-label').forEach((n) => {
    const has = !!store.sheet(n.dataset.sheet)?.image;
    n.querySelector('span').classList.toggle('uploaded', has);
    n.querySelector('span').title = has ? 'Uses uploaded artwork' : '';
  });
}

// ---------- sheet canvas ----------

function layoutSheet() {
  const stage = $('#sheetStage');
  const { part } = sheetInfo(ui.sheetKey);
  const size = sheetSize(part);
  const availW = Math.max(60, stage.clientWidth - 14);
  const availH = Math.max(60, stage.clientHeight - 18);
  const scale = Math.min(availW / size.w, availH / size.h);
  const cssW = Math.floor(size.w * scale);
  const cssH = Math.floor(size.h * scale);
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  ui.view = { ppi: canvas.width / size.w, dpr };
  drawSheet();
}

let sheetFrame = 0;
function scheduleSheetRender() {
  if (sheetFrame) return;
  sheetFrame = requestAnimationFrame(() => {
    sheetFrame = 0;
    drawSheet();
  });
}

function drawSheet() {
  const ctx = canvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const hits = [];
  const { ppi, dpr } = ui.view;
  renderSheet(ctx, store.project, ui.sheetKey, { ppi, guides: ui.guides, hits, dpr });
  ui.hits = hits;

  const { part } = sheetInfo(ui.sheetKey);
  const px = (b) => [b.x * ppi, b.y * ppi, b.w * ppi, b.h * ppi];
  ctx.save();
  const hover = hits.find((x) => x.type === 'panel' && x.panelId === ui.hoverPanel && x.panelId !== ui.panelId);
  if (hover) {
    ctx.strokeStyle = 'rgba(18,18,18,0.6)';
    ctx.lineWidth = 1.5 * dpr;
    ctx.setLineDash([4 * dpr, 3 * dpr]);
    ctx.strokeRect(...px(hover.box));
  }
  const sel = hits.find((x) => x.type === 'panel' && x.panelId === ui.panelId);
  if (sel) {
    ctx.setLineDash([]);
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 2.5 * dpr;
    if (part.round) {
      ctx.beginPath();
      ctx.arc((part.trimW / 2) * ppi, (part.trimH / 2) * ppi, (part.printOuter / 2) * ppi + dpr, 0, Math.PI * 2);
      ctx.stroke();
    } else {
      ctx.strokeRect(...px(sel.box));
    }
  }
  const selText = hits.find((x) => x.type === 'text' && x.textId === ui.textId);
  if (selText) {
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 1.5 * dpr;
    ctx.setLineDash([5 * dpr, 3 * dpr]);
    const pad = 3 * dpr;
    const [x, y, w, hh] = px(selText.box);
    ctx.strokeRect(x - pad, y - pad, w + 2 * pad, hh + 2 * pad);
  }
  if (ui.drag?.snap) {
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 1 * dpr;
    ctx.setLineDash([]);
    const r = panelRect(ui.drag.panelId);
    if (ui.drag.snap.x) {
      ctx.beginPath();
      ctx.moveTo((r.x + r.w / 2) * ppi, r.y * ppi);
      ctx.lineTo((r.x + r.w / 2) * ppi, (r.y + r.h) * ppi);
      ctx.stroke();
    }
    if (ui.drag.snap.y) {
      ctx.beginPath();
      ctx.moveTo(r.x * ppi, (r.y + r.h / 2) * ppi);
      ctx.lineTo((r.x + r.w) * ppi, (r.y + r.h / 2) * ppi);
      ctx.stroke();
    }
  }
  ctx.restore();
  updateSafetyWarnings();
}

function toInches(e) {
  const r = canvas.getBoundingClientRect();
  const size = sheetSize(sheetInfo(ui.sheetKey).part);
  return { x: ((e.clientX - r.left) / r.width) * size.w, y: ((e.clientY - r.top) / r.height) * size.h };
}

function hitTest(pt) {
  const inBox = (b, pad = 0) => pt.x >= b.x - pad && pt.x <= b.x + b.w + pad && pt.y >= b.y - pad && pt.y <= b.y + b.h + pad;
  const texts = ui.hits.filter((x) => x.type === 'text');
  for (let i = texts.length - 1; i >= 0; i--) if (inBox(texts[i].box, 0.03)) return texts[i];
  const panels = ui.hits.filter((x) => x.type === 'panel');
  return panels.find((x) => inBox(x.box)) || panels.find((x) => inBox(x.bleedBox)) || null;
}

const findText = (project, panelId, textId) => project.panels[panelId].texts.find((t) => t.id === textId);

canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  const pt = toInches(e);
  const hit = hitTest(pt);
  if (!hit) return;
  try {
    canvas.setPointerCapture(e.pointerId);
  } catch {
    // Synthetic or already-released pointers can't be captured; dragging still works inside the canvas.
  }
  if (hit.type === 'text') {
    if (hit.panelId !== ui.panelId) selectPanel(hit.panelId, { textId: hit.textId });
    else setActiveText(hit.textId);
    const t = findText(store.project, hit.panelId, hit.textId);
    ui.drag = { kind: 'text', panelId: hit.panelId, textId: hit.textId, start: pt, orig: { x: t.x, y: t.y }, rect: panelRect(hit.panelId) };
  } else {
    if (hit.panelId !== ui.panelId) selectPanel(hit.panelId);
    else if (ui.textId) setActiveText(null);
    const img = store.panel(hit.panelId).image;
    if (img) {
      ui.drag = {
        kind: 'image',
        panelId: hit.panelId,
        start: pt,
        orig: { dx: img.dx || 0, dy: img.dy || 0 },
        rect: panelRect(hit.panelId, { bleed: true }),
      };
    }
  }
  scheduleSheetRender();
});

canvas.addEventListener('pointermove', (e) => {
  const pt = toInches(e);
  const d = ui.drag;
  if (!d) {
    const hit = hitTest(pt);
    const id = hit?.panelId || null;
    canvas.style.cursor = hit?.type === 'text' || (hit && store.panel(hit.panelId).image && hit.panelId === ui.panelId) ? 'move' : hit ? 'pointer' : 'default';
    if (id !== ui.hoverPanel) {
      ui.hoverPanel = id;
      scheduleSheetRender();
    }
    return;
  }
  const dx = pt.x - d.start.x;
  const dy = pt.y - d.start.y;
  if (!d.moved && Math.hypot(dx, dy) < 0.02) return;
  d.moved = true;
  if (d.kind === 'text') {
    let x = d.orig.x + dx / d.rect.w;
    let y = d.orig.y + dy / d.rect.h;
    d.snap = {};
    const tol = 0.012 * (4.75 / Math.max(d.rect.w, 0.5));
    if (!e.shiftKey && Math.abs(x - 0.5) < Math.min(tol, 0.05)) {
      x = 0.5;
      d.snap.x = true;
    }
    if (!e.shiftKey && Math.abs(y - 0.5) < 0.012) {
      y = 0.5;
      d.snap.y = true;
    }
    live((p) => {
      const t = findText(p, d.panelId, d.textId);
      t.x = Math.min(1.2, Math.max(-0.2, x));
      t.y = Math.min(1.2, Math.max(-0.2, y));
    });
  } else {
    live((p) => {
      const img = p.panels[d.panelId].image;
      img.dx = d.orig.dx + dx / d.rect.w;
      img.dy = d.orig.dy + dy / d.rect.h;
    });
  }
});

function endDrag() {
  const d = ui.drag;
  ui.drag = null;
  if (d?.moved) {
    commit();
    renderInspector();
  }
  scheduleSheetRender();
}
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);
canvas.addEventListener('pointerleave', () => {
  if (!ui.drag && ui.hoverPanel) {
    ui.hoverPanel = null;
    scheduleSheetRender();
  }
});

let wheelCommit;
canvas.addEventListener(
  'wheel',
  (e) => {
    if (!(e.ctrlKey || e.metaKey || e.altKey)) return;
    const img = store.panel(ui.panelId).image;
    if (!img) return;
    e.preventDefault();
    live((p) => {
      const im = p.panels[ui.panelId].image;
      im.scale = Math.min(6, Math.max(0.1, (im.scale || 1) * Math.exp(-e.deltaY * 0.004)));
    });
    clearTimeout(wheelCommit);
    wheelCommit = setTimeout(() => {
      commit();
      renderInspector();
    }, 300);
  },
  { passive: false },
);

const stage = $('#sheetStage');
stage.addEventListener('dragover', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  stage.classList.add('dragover');
  const hit = hitTest(toInches(e));
  const id = hit?.panelId || null;
  if (id !== ui.hoverPanel) {
    ui.hoverPanel = id;
    scheduleSheetRender();
  }
});
stage.addEventListener('dragleave', () => stage.classList.remove('dragover'));
stage.addEventListener('drop', (e) => {
  e.preventDefault();
  stage.classList.remove('dragover');
  const file = fileFromDrop(e);
  if (file && isZip(file)) return openBundle(file);
  const hit = hitTest(toInches(e));
  if (file && hit) uploadPanelImage(hit.panelId, file);
});

new ResizeObserver(() => layoutSheet()).observe(stage);

// ---------- uploads ----------

async function uploadPanelImage(panelId, file) {
  if (isZip(file)) return openBundle(file);
  toast('Adding image…', { ms: 0 });
  try {
    const prep = await prepareFile(file);
    const url = await store.addImage(prep.blob);
    await whenImagesReady([url]);
    store.update((p) => {
      const prev = p.panels[panelId].image;
      p.panels[panelId].image = { src: url, w: prep.width, h: prep.height, fit: prev?.fit || 'cover', scale: 1, dx: 0, dy: 0, rot: 0 };
    });
    if (ui.panelId !== panelId) selectPanel(panelId);
    else renderInspector();
    const dpi = imageDpi(panelId, store.panel(panelId).image);
    const pages = prep.pageCount > 1 ? ` Only page 1 of ${prep.pageCount} was used.` : '';
    toast(
      dpi && dpi < 250
        ? `Placed on ${PANELS[panelId].name}, but it prints at ≈${dpi} DPI — 300 recommended.${pages}`
        : `Placed on ${PANELS[panelId].name}.${pages}`,
      { error: !!(dpi && dpi < 250) },
    );
  } catch (err) {
    toast(err.message || 'Upload failed', { error: true });
  }
}

async function uploadSheet(key, file) {
  if (isZip(file)) return openBundle(file);
  toast('Processing artwork…', { ms: 0 });
  try {
    const prep = await prepareFile(file);
    const fit = fitSheetUpload(key, prep);
    const url = await store.addImage(prep.blob);
    await whenImagesReady([url]);
    const info = sheetInfo(key);
    store.update((p) => {
      p.sheets[key].image = { src: url, w: prep.width, h: prep.height, crop: fit.crop, target: fit.target, note: fit.note, warn: !!fit.warn };
      for (const panel of info.sheet.panels) p.panels[panel.id] = { bg: null, image: null, texts: [] };
    });
    selectPanel(PANELS[ui.panelId].sheetId === key ? ui.panelId : MAIN_PANEL[key]);
    const pages = prep.pageCount > 1 ? ` Only page 1 of ${prep.pageCount} was used — upload the other side separately.` : '';
    toast(`${fit.note} Panel content on this sheet was cleared (Undo to restore).${pages}`, { ms: 7000, error: !!fit.warn });
  } catch (err) {
    toast(err.message || 'Upload failed', { error: true });
  }
}

function acceptSheetDrop(node, getKey) {
  node.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    node.classList.add('drop-target');
  });
  node.addEventListener('dragleave', () => node.classList.remove('drop-target'));
  node.addEventListener('drop', (e) => {
    e.preventDefault();
    node.classList.remove('drop-target');
    const f = fileFromDrop(e);
    if (f) uploadSheet(getKey(), f);
  });
}

$('#sheetUploadBtn').addEventListener('click', () => pickFile((f) => uploadSheet(ui.sheetKey, f)));
acceptSheetDrop($('#sheetUploadBtn'), () => ui.sheetKey);

// ---------- inspector ----------

function slider(label, { min, max, step, value, format, onInput }) {
  const out = h('output', {}, format(value));
  const input = h('input', {
    type: 'range',
    min,
    max,
    step,
    value: String(value),
    oninput: (e) => {
      const v = parseFloat(e.target.value);
      out.textContent = format(v);
      onInput(v);
    },
    onchange: commit,
  });
  return h('label', { class: 'slider' }, h('span', {}, label), input, out);
}

function seg(options) {
  return h(
    'div',
    { class: 'seg' },
    options.map(([label, on, onClick, title]) => h('button', { type: 'button', class: on ? 'on' : '', title, onclick: onClick }, label)),
  );
}

function setActiveText(textId) {
  ui.textId = textId;
  $$('.text-card').forEach((c) => c.classList.toggle('active', c.dataset.text === textId));
  scheduleSheetRender();
}

function updateSafetyWarnings() {
  const bad = new Set(safetyWarnings(ui.hits, ui.panelId));
  $$('[data-warn]').forEach((n) => (n.hidden = !bad.has(n.dataset.warn)));
}

function renderInspector() {
  const root = $('#inspector');
  const id = ui.panelId;
  const spec = PANELS[id];
  const data = store.panel(id);
  const sheetHasArt = !!store.sheet(spec.sheetId)?.image;
  const scrollTop = root.scrollTop;
  root.replaceChildren(headSection(spec, sheetHasArt), bgSection(id, data, sheetHasArt), imageSection(id, data), textSection(id, data));
  root.scrollTop = scrollTop;
  updateSafetyWarnings();
}

function headSection(spec, sheetHasArt) {
  const { part } = spec;
  const edges = bleedEdges(spec.id);
  const dims = part.round
    ? `120 mm disc · print area 24–116 mm · ${fmtIn(part.trimW)} square artboard`
    : `${fmtIn(spec.w)} × ${fmtIn(part.trimH)} trim${edges.length ? ` · bleed ${edges.join(', ')}` : ''}`;
  return h(
    'div',
    { class: 'insp-head' },
    h('div', { class: 'eyebrow' }, `${part.name} · ${spec.sheet.name}${spec.page ? ` · page ${spec.page} of 6` : ''}`),
    h('h2', {}, spec.name),
    h('div', { class: 'dims' }, dims),
    spec.id === 'bk_extra_out' || spec.id === 'bk_extra_in'
      ? h('p', { class: 'note' }, 'This panel is 1/8" narrower so it can fold inside the booklet without buckling.')
      : null,
    spec.spine ? h('p', { class: 'note' }, 'Spines are only 1/4" deep. Keep type around 7–10 pt and rotated.') : null,
    spec.id === 'tc_inside'
      ? h('p', { class: 'note' }, 'Shows through a clear tray. The disc covers the circle; the grey strip is visible through the spine.')
      : null,
    sheetHasArt ? h('p', { class: 'note' }, 'This sheet uses uploaded artwork. Anything added here draws on top of it.') : null,
  );
}

function bgSection(id, data, sheetHasArt) {
  return h(
    'section',
    { class: 'insp-sec' },
    h('h3', {}, 'Background'),
    h(
      'div',
      { class: 'row' },
      h('input', {
        type: 'color',
        value: data.bg || '#ffffff',
        title: 'Panel colour',
        oninput: (e) => live((p) => (p.panels[id].bg = e.target.value)),
        onchange: () => {
          commit();
          renderInspector();
        },
      }),
      h(
        'div',
        { class: 'swatches' },
        SWATCHES.map((c) =>
          h('button', {
            type: 'button',
            class: 'swatch',
            title: c,
            style: `background:${c}`,
            onclick: () => {
              store.update((p) => (p.panels[id].bg = c));
              renderInspector();
            },
          }),
        ),
      ),
      h(
        'button',
        {
          type: 'button',
          class: 'btn small ghost',
          disabled: !data.bg,
          onclick: () => {
            store.update((p) => (p.panels[id].bg = null));
            renderInspector();
          },
        },
        'None',
      ),
    ),
    !data.bg ? h('p', { class: 'note' }, `Transparent — shows the ${sheetHasArt ? 'uploaded sheet artwork' : 'sheet paper colour'}.`) : null,
  );
}

function imageSection(id, data) {
  const box = panelRect(id, { bleed: true });
  const ideal = `${Math.round(box.w * 300)} × ${Math.round(box.h * 300)} px`;
  const sec = h('section', { class: 'insp-sec' }, h('h3', {}, 'Image'));
  const dropHandlers = (node) => {
    node.addEventListener('dragover', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      node.classList.add('dragover');
    });
    node.addEventListener('dragleave', () => node.classList.remove('dragover'));
    node.addEventListener('drop', (e) => {
      e.preventDefault();
      node.classList.remove('dragover');
      const f = fileFromDrop(e);
      if (f) uploadPanelImage(id, f);
    });
    return node;
  };

  if (!data.image) {
    sec.append(
      dropHandlers(
        h(
          'div',
          { class: 'dropzone', role: 'button', tabindex: '0', onclick: () => pickFile((f) => uploadPanelImage(id, f)) },
          h('b', {}, 'Add image'),
          h('span', {}, 'Drop a JPG, PNG, WebP or PDF, or click to browse.'),
          h('span', { class: 'note' }, `Ideal: ${ideal} (300 DPI incl. bleed)`),
        ),
      ),
    );
    return sec;
  }

  const img = data.image;
  const upd = (fn) => live((p) => fn(p.panels[id].image));
  const dpi = imageDpi(id, img);
  sec.append(
    dropHandlers(
      h(
        'div',
        { class: 'img-row' },
        h('img', { src: assetUrl(img.src), alt: '' }),
        h(
          'div',
          {},
          h(
            'div',
            { class: 'row' },
            h('button', { type: 'button', class: 'btn small', onclick: () => pickFile((f) => uploadPanelImage(id, f)) }, 'Replace'),
            h(
              'button',
              {
                type: 'button',
                class: 'btn small danger',
                onclick: () => {
                  store.update((p) => (p.panels[id].image = null));
                  renderInspector();
                },
              },
              'Remove',
            ),
          ),
          h('div', { class: 'note' }, `${img.w} × ${img.h} px`),
        ),
      ),
    ),
    h(
      'div',
      { class: 'row' },
      h('span', { class: 'field-label' }, 'Fit'),
      seg([
        ['Cover', img.fit !== 'contain', () => setFit('cover'), 'Fill the panel, cropping edges'],
        ['Contain', img.fit === 'contain', () => setFit('contain'), 'Show the whole image'],
      ]),
      h(
        'button',
        {
          type: 'button',
          class: 'btn small ghost',
          title: 'Rotate 90°',
          onclick: () => {
            store.update((p) => (p.panels[id].image.rot = ((p.panels[id].image.rot || 0) + 90) % 360));
            renderInspector();
          },
        },
        '↻ 90°',
      ),
      h(
        'button',
        {
          type: 'button',
          class: 'btn small ghost',
          onclick: () => {
            store.update((p) => Object.assign(p.panels[id].image, { scale: 1, dx: 0, dy: 0 }));
            renderInspector();
          },
        },
        'Reset',
      ),
    ),
    slider('Zoom', { min: 0.1, max: 4, step: 0.01, value: img.scale || 1, format: (v) => `${Math.round(v * 100)}%`, onInput: (v) => upd((im) => (im.scale = v)) }),
    slider('X', { min: -1, max: 1, step: 0.001, value: img.dx || 0, format: (v) => v.toFixed(2), onInput: (v) => upd((im) => (im.dx = v)) }),
    slider('Y', { min: -1, max: 1, step: 0.001, value: img.dy || 0, format: (v) => v.toFixed(2), onInput: (v) => upd((im) => (im.dy = v)) }),
    dpi
      ? h(
          'p',
          { class: `note ${dpi < 200 ? 'warn' : dpi < 280 ? '' : 'ok'}` },
          dpi < 200 ? `≈${dpi} DPI — will look soft in print. Use a larger image (${ideal}).` : `≈${dpi} DPI at this size.`,
        )
      : null,
    h('p', { class: 'note' }, 'Drag the image on the sheet to reposition. Ctrl/⌥ + scroll to zoom.'),
  );
  function setFit(fit) {
    store.update((p) => Object.assign(p.panels[id].image, { fit, scale: 1, dx: 0, dy: 0 }));
    renderInspector();
  }
  return sec;
}

function textSection(id, data) {
  const add = () => {
    const spec = PANELS[id];
    const n = data.texts.length;
    const t = makeText(
      spec.spine
        ? { text: 'BAND NAME — ALBUM', size: 8, rotation: spec.spine }
        : { text: 'New text', size: spec.part.round ? 14 : 18, y: Math.min(0.85, 0.5 + n * 0.08) },
    );
    store.update((p) => p.panels[id].texts.push(t));
    ui.textId = t.id;
    renderInspector();
    const ta = $(`.text-card[data-text="${t.id}"] textarea`);
    ta?.focus();
    ta?.select();
  };
  return h(
    'section',
    { class: 'insp-sec' },
    h('h3', {}, 'Text', h('button', { type: 'button', class: 'btn small', onclick: add }, '+ Add text')),
    data.texts.length ? data.texts.map((t) => textCard(id, t)) : h('p', { class: 'empty' }, 'No text on this panel yet.'),
  );
}

function textCard(id, t) {
  const get = (p) => findText(p, id, t.id);
  const set = (fn) => live((p) => fn(get(p)));
  const setNow = (fn) => {
    store.update((p) => fn(get(p)));
    renderInspector();
  };
  return h(
    'div',
    {
      class: `text-card${t.id === ui.textId ? ' active' : ''}`,
      dataset: { text: t.id },
      onfocusin: () => ui.textId !== t.id && setActiveText(t.id),
      onpointerdown: () => ui.textId !== t.id && setActiveText(t.id),
    },
    h('textarea', { rows: 2, value: t.text, spellcheck: true, oninput: (e) => set((x) => (x.text = e.target.value)), onchange: commit }),
    h(
      'div',
      { class: 'row' },
      h(
        'select',
        { title: 'Font', value: t.font, onchange: (e) => setNow((x) => (x.font = e.target.value)) },
        FONTS.map((f) => h('option', { value: f, style: `font-family:"${f}"` }, f)),
      ),
      h('input', {
        type: 'number',
        class: 'num',
        min: 3,
        max: 300,
        step: 0.5,
        value: String(t.size),
        title: 'Size in points',
        oninput: (e) => {
          const v = parseFloat(e.target.value);
          if (v > 0) set((x) => (x.size = v));
        },
        onchange: commit,
      }),
      h('span', { class: 'field-label', style: 'min-width:0' }, 'pt'),
      h('input', { type: 'color', value: t.color, title: 'Colour', oninput: (e) => set((x) => (x.color = e.target.value)), onchange: commit }),
    ),
    h(
      'div',
      { class: 'row' },
      seg([
        ['B', t.weight >= 700, () => setNow((x) => (x.weight = x.weight >= 700 ? 400 : 700)), 'Bold'],
        ['I', t.italic, () => setNow((x) => (x.italic = !x.italic)), 'Italic'],
      ]),
      seg([
        ['L', t.align === 'left', () => setNow((x) => (x.align = 'left')), 'Align left'],
        ['C', t.align === 'center', () => setNow((x) => (x.align = 'center')), 'Align centre'],
        ['R', t.align === 'right', () => setNow((x) => (x.align = 'right')), 'Align right'],
      ]),
      h(
        'select',
        { title: 'Rotation', value: String(t.rotation || 0), onchange: (e) => setNow((x) => (x.rotation = Number(e.target.value))) },
        [
          ['0', '0°'],
          ['90', '90° ↓'],
          ['-90', '−90° ↑'],
          ['180', '180°'],
        ].map(([v, l]) => h('option', { value: v }, l)),
      ),
    ),
    slider('X', { min: -0.1, max: 1.1, step: 0.001, value: t.x, format: (v) => `${Math.round(v * 100)}%`, onInput: (v) => set((x) => (x.x = v)) }),
    slider('Y', { min: -0.1, max: 1.1, step: 0.001, value: t.y, format: (v) => `${Math.round(v * 100)}%`, onInput: (v) => set((x) => (x.y = v)) }),
    slider('Tracking', {
      min: -0.1,
      max: 0.6,
      step: 0.005,
      value: t.letterSpacing || 0,
      format: (v) => v.toFixed(2),
      onInput: (v) => set((x) => (x.letterSpacing = v)),
    }),
    slider('Leading', { min: 0.7, max: 2.5, step: 0.05, value: t.lineHeight || 1.15, format: (v) => v.toFixed(2), onInput: (v) => set((x) => (x.lineHeight = v)) }),
    h('p', { class: 'note warn', dataset: { warn: t.id }, hidden: true }, 'Crosses the safety line — it may get trimmed or hidden.'),
    h(
      'div',
      { class: 'row end' },
      h('button', { type: 'button', class: 'btn small ghost', onclick: () => setNow((x) => Object.assign(x, { x: 0.5, y: 0.5 })) }, 'Centre'),
      h(
        'button',
        {
          type: 'button',
          class: 'btn small ghost',
          onclick: () => {
            const { id: _omit, ...rest } = t;
            const copy = makeText({ ...rest, y: Math.min(1, t.y + 0.08) });
            store.update((p) => p.panels[id].texts.push(copy));
            ui.textId = copy.id;
            renderInspector();
          },
        },
        'Duplicate',
      ),
      h(
        'button',
        {
          type: 'button',
          class: 'btn small ghost danger',
          onclick: () => {
            store.update((p) => (p.panels[id].texts = p.panels[id].texts.filter((x) => x.id !== t.id)));
            if (ui.textId === t.id) ui.textId = null;
            renderInspector();
          },
        },
        'Delete',
      ),
    ),
  );
}

// ---------- 3D preview ----------

const preview = new Preview3D($('#glCanvas'), { onPick: (id) => selectPanel(id) });
preview.setActive(false);

const previewEl = $('#preview');
const previewOpen = () => !previewEl.hidden;
let previewOpener = null;

function openPreview() {
  if (previewOpen()) return;
  previewOpener = document.activeElement;
  previewEl.hidden = false;
  preview.setActive(true);
  schedule3D(true);
  if ($('#followSel').checked) preview.applyView(PANEL_VIEWS[ui.panelId]);
  $('#previewCloseBtn').focus();
}

function closePreview() {
  if (!previewOpen()) return;
  preview.setActive(false);
  previewEl.hidden = true;
  previewOpener?.focus?.();
}

function updatePreviewEdit() {
  const btn = $('#previewEditBtn');
  if (btn && ui.panelId) btn.textContent = `Edit ${PANELS[ui.panelId].name} →`;
}

$('#previewBtn').addEventListener('click', openPreview);
$('#previewCloseBtn').addEventListener('click', closePreview);
$('#previewEditBtn').addEventListener('click', closePreview);

function syncPreviewControls(s) {
  $('#lidRange').value = String(Math.round(s.lid * 100));
  $('#foldRange').value = String(Math.round(s.fold * 100));
  $('#bookletOut').checked = s.bookletOut > 0.5;
  $('#flipBooklet').checked = s.flip > 0.5;
  $('#discOut').checked = s.discOut > 0.5;
}
preview.addEventListener('state', (e) => syncPreviewControls(e.detail));

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
$('#trayColor').addEventListener('change', (e) => {
  store.update((p) => (p.trayColor = e.target.value));
  preview.setTrayColor(e.target.value);
});
$('#autoRotate').addEventListener('change', (e) => preview.setAutoRotate(e.target.checked));

const shareDialog = $('#shareDialog');
$('#share3dBtn').addEventListener('click', async () => {
  $('#shareTitleInput').value = store.project.name || '';
  $('#shareForm').hidden = false;
  $('#shareResult').hidden = true;
  $('#shareCopyBtn').hidden = true;
  $('#shareOpenBtn').hidden = true;
  $('#sharePublishBtn').hidden = false;
  $('#shareProgress').textContent = '';
  const status = await fetch('/api/shares/status').then((r) => r.json()).catch(() => ({ enabled: false }));
  if (!status.enabled) {
    $('#shareProgress').textContent = 'Sharing is off until DATABASE_URL is set.';
    $('#sharePublishBtn').hidden = true;
  }
  shareDialog.showModal();
});
$('#shareCloseBtn').addEventListener('click', () => shareDialog.close());
$('#sharePublishBtn').addEventListener('click', async () => {
  const btn = $('#sharePublishBtn');
  btn.disabled = true;
  $('#shareProgress').textContent = 'Rendering textures…';
  try {
    preview.updateTextures(store.project, true);
    const { url } = await publishShare({
      title: $('#shareTitleInput').value.trim() || store.project.name,
      trayColor: store.project.trayColor,
      preview,
    });
    $('#shareForm').hidden = true;
    $('#shareResult').hidden = false;
    $('#shareUrl').value = url;
    $('#shareCopyBtn').hidden = false;
    $('#shareOpenBtn').hidden = false;
    btn.hidden = true;
    $('#shareProgress').textContent = 'Published.';
    $('#shareUrl').select();
  } catch (err) {
    $('#shareProgress').textContent = err.message || 'Could not publish';
  } finally {
    btn.disabled = false;
  }
});
$('#shareCopyBtn').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('#shareUrl').value);
    toast('Link copied.');
  } catch {
    $('#shareUrl').select();
  }
});
$('#shareOpenBtn').addEventListener('click', () => window.open($('#shareUrl').value, '_blank', 'noopener'));

$('#mockupBtn').addEventListener('click', async () => {
  const blob = await (await fetch(preview.snapshot())).blob();
  download(blob, `${(store.project.name || 'jewel-case').replace(/[^\w-]+/g, '-')}_mockup.png`);
});

let pending3d = null;
let force3d = false;
function schedule3D(force = false) {
  force3d ||= force;
  clearTimeout(pending3d);
  pending3d = setTimeout(() => {
    preview.updateTextures(store.project, force3d);
    force3d = false;
    updateThumbs();
  }, 140);
}

function updateThumbs() {
  for (const s of SHEETS) {
    const src = preview.canvases[s.key];
    if (!src || src.width < 8) continue;
    const ppi = src.width / sheetSize(s.part).w;
    for (const p of s.sheet.panels) {
      const thumb = thumbs[p.id];
      if (!thumb) continue;
      const r = panelRect(p.id);
      const k = Math.min(40 / r.w, 40 / r.h);
      const tw = Math.max(3, Math.round(r.w * k));
      const th = Math.max(3, Math.round(r.h * k));
      thumb.width = tw * 2;
      thumb.height = th * 2;
      thumb.style.width = `${tw}px`;
      thumb.style.height = `${th}px`;
      thumb.getContext('2d').drawImage(src, r.x * ppi, r.y * ppi, r.w * ppi, r.h * ppi, 0, 0, tw * 2, th * 2);
    }
  }
}

// ---------- top bar, sheet tools, keyboard ----------

$('#guidesToggle').addEventListener('change', (e) => {
  ui.guides = e.target.checked;
  scheduleSheetRender();
});
$('#sheetBg').addEventListener('input', (e) => live((p) => (p.sheets[ui.sheetKey].bg = e.target.value)));
$('#sheetBg').addEventListener('change', commit);

$('#projectName').addEventListener('input', (e) => live((p) => (p.name = e.target.value)));
$('#projectName').addEventListener('change', commit);

$('#undoBtn').addEventListener('click', () => store.undo());
$('#redoBtn').addEventListener('click', () => store.redo());
$('#newBtn').addEventListener('click', async () => {
  if (!confirm('Start a new project? The current one is erased from this browser — use “Save .zip” first to keep it.')) return;
  await store.reset();
  selectPanel('bk_front');
  preview.applyView(PRESETS.closed);
});
// ---------- project bundles (.zip) ----------

$('#saveZipBtn').addEventListener('click', async () => {
  const btn = $('#saveZipBtn');
  btn.disabled = true;
  toast('Packing project…', { ms: 0 });
  try {
    const previewPng = await (await fetch(preview.snapshot({ width: 1200 }))).blob();
    const zip = await buildBundle(store.project, { previewPng });
    const name = `${slug(store.project.name)}.jewelcase.zip`;
    download(zip, name);
    toast(`Saved ${name} (${(zip.size / 1e6).toFixed(1)} MB). Open it in any browser with “Open .zip”.`, { ms: 6000 });
  } catch (err) {
    toast(err.message || 'Could not build the zip', { error: true });
  } finally {
    btn.disabled = false;
  }
});

$('#openZipBtn').addEventListener('click', () => pickFile(openBundle, '.zip,application/zip'));

async function openBundle(file) {
  if (!confirm(`Open ${file.name}? It replaces the project currently in this browser — use “Save .zip” first to keep it.`)) return;
  toast('Opening project…', { ms: 0 });
  try {
    const { project, assets, missing } = await readBundle(file);
    await store.importProject(project, assets, { onProgress: (msg) => toast(msg, { ms: 0 }) });
    selectPanel('bk_front');
    preview.applyView(PRESETS.closed);
    const title = store.project.name ? `“${store.project.name}”` : file.name;
    toast(
      missing.length
        ? `Opened ${title}, but ${missing.length} image(s) were missing from the zip and were left empty.`
        : `Opened ${title}.`,
      { error: missing.length > 0, ms: 6000 },
    );
  } catch (err) {
    toast(err.message || 'Could not open that zip', { error: true });
  }
}

// Dropping a project zip anywhere opens it; element-level handlers route zips here too.
document.addEventListener('dragover', (e) => hasFiles(e) && e.preventDefault());
document.addEventListener('drop', (e) => {
  if (e.defaultPrevented) return;
  e.preventDefault();
  const f = fileFromDrop(e);
  if (f && isZip(f)) openBundle(f);
});

let nudgeCommit;
document.addEventListener('keydown', (e) => {
  const inField = e.target.closest?.('input, textarea, select, [contenteditable]');
  const mod = e.metaKey || e.ctrlKey;
  if ($('#shareDialog').open) return;
  if (previewOpen()) {
    if (e.key === 'Escape' || (e.key === '3' && !inField)) {
      e.preventDefault();
      closePreview();
    }
    return;
  }
  if (e.key === '3' && !inField && !mod && !$('#exportDialog').open) {
    e.preventDefault();
    openPreview();
    return;
  }
  if (mod && !inField && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    e.shiftKey ? store.redo() : store.undo();
    return;
  }
  if (mod && !inField && e.key.toLowerCase() === 'y') {
    e.preventDefault();
    store.redo();
    return;
  }
  if (inField || mod || !ui.textId) return;
  const id = ui.panelId;
  const textId = ui.textId;
  if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    store.update((p) => (p.panels[id].texts = p.panels[id].texts.filter((x) => x.id !== textId)));
    ui.textId = null;
    renderInspector();
    return;
  }
  const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  if (arrows[e.key]) {
    e.preventDefault();
    const stepIn = e.shiftKey ? 0.1 : 0.02;
    const r = panelRect(id);
    const [ax, ay] = arrows[e.key];
    live((p) => {
      const t = findText(p, id, textId);
      if (!t) return;
      t.x += (ax * stepIn) / r.w;
      t.y += (ay * stepIn) / r.h;
    });
    clearTimeout(nudgeCommit);
    nudgeCommit = setTimeout(() => {
      commit();
      renderInspector();
    }, 400);
  }
});

// ---------- export dialog ----------

const dialog = $('#exportDialog');
$('#exportSheets').append(
  ...SHEETS.map((s) =>
    h('label', { class: 'chk' }, h('input', { type: 'checkbox', name: 'sheet', value: s.key, checked: true }), `${s.part.name} · ${s.sheet.name}`),
  ),
);
$('#exportBtn').addEventListener('click', () => {
  $('#exportProgress').textContent = '';
  dialog.showModal();
});

async function runExport(kind) {
  const form = $('#exportForm');
  const keys = $$('input[name="sheet"]:checked', form).map((n) => n.value);
  if (!keys.length) {
    $('#exportProgress').textContent = 'Pick at least one sheet.';
    return;
  }
  const opts = {
    pageSize: form.pageSize.value,
    guides: form.guides.checked,
    onProgress: (msg) => ($('#exportProgress').textContent = msg),
  };
  const buttons = [$('#exportPdfBtn'), $('#exportPngBtn')];
  buttons.forEach((b) => (b.disabled = true));
  try {
    if (kind === 'pdf') await exportPdf(store.project, keys, opts);
    else await exportPngs(store.project, keys, opts);
    $('#exportProgress').textContent = 'Done.';
  } catch (err) {
    console.error(err);
    $('#exportProgress').textContent = `Export failed: ${err.message}`;
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
}
$('#exportPdfBtn').addEventListener('click', () => runExport('pdf'));
$('#exportPngBtn').addEventListener('click', () => runExport('png'));

// ---------- store wiring ----------

const STATUS_TEXT = {
  unsaved: 'Not saved yet',
  pending: 'Unsaved changes…',
  saving: 'Saving…',
  saved: 'Saved in this browser',
  error: 'Not saved',
};
store.addEventListener('status', (e) => {
  const el = $('#saveStatus');
  el.dataset.status = e.detail.status;
  el.textContent = e.detail.status === 'error' ? `Not saved: ${e.detail.message}` : STATUS_TEXT[e.detail.status];
  el.title = 'Your work is kept only in this browser. Use “Save .zip” to back it up or move it to another computer.';
});
store.addEventListener('history', () => {
  $('#undoBtn').disabled = !store.undoStack.length;
  $('#redoBtn').disabled = !store.redoStack.length;
});
store.addEventListener('change', (e) => {
  scheduleSheetRender();
  schedule3D();
  if (e.detail?.replaced) {
    $('#projectName').value = store.project.name || '';
    $('#trayColor').value = store.project.trayColor || 'clear';
    preview.setTrayColor(store.project.trayColor || 'clear');
    if (ui.textId && !store.project.panels[ui.panelId].texts.some((t) => t.id === ui.textId)) ui.textId = null;
    renderInspector();
    updateSheetBar();
  }
});

onAssetLoaded(() => {
  scheduleSheetRender();
  schedule3D(true);
  updateSheetBar();
  if (!$('#inspector').contains(document.activeElement)) renderInspector();
});

window.addEventListener('beforeunload', (e) => {
  if (store.status === 'pending' || store.status === 'saving') {
    store.save();
    e.preventDefault();
  }
});

// ---------- boot ----------

async function init() {
  buildNav();
  buildTabs();
  try {
    const lost = await store.restoreDraft();
    if (lost.length) toast(`${lost.length} image(s) were no longer in this browser's storage and were removed.`, { error: true, ms: 7000 });
  } catch (err) {
    toast(`Browser storage is unavailable (${err.message}). Work will be lost on reload — use “Save .zip”.`, { error: true, ms: 9000 });
  }
  requestPersistence();
  $('#projectName').value = store.project.name || '';
  $('#trayColor').value = store.project.trayColor || 'clear';
  preview.setTrayColor(store.project.trayColor || 'clear');
  selectPanel('bk_front');
  layoutSheet();
  schedule3D(true);
  preview.applyView(PRESETS.closed);
}

init();
