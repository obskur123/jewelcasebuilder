import { PANELS, SHEETS } from './spec.js';
import { putAsset, saveDraft, loadDraft, unsavedAssetsIn } from './assets.js';

const HISTORY_LIMIT = 100;
const SAVE_DELAY = 500;

let uid = 0;
export const newTextId = () => `t${Date.now().toString(36)}${(uid++).toString(36)}`;

export function makeText(overrides = {}) {
  return {
    id: newTextId(),
    text: 'Text',
    font: 'Inter',
    size: 18,
    color: '#111111',
    weight: 700,
    italic: false,
    align: 'center',
    x: 0.5,
    y: 0.5,
    rotation: 0,
    letterSpacing: 0,
    lineHeight: 1.15,
    ...overrides,
  };
}

function emptyPanel() {
  return { bg: null, image: null, texts: [] };
}

export function defaultProject() {
  const panels = {};
  for (const id of Object.keys(PANELS)) panels[id] = emptyPanel();
  const sheets = {};
  for (const s of SHEETS) sheets[s.key] = { bg: '#ffffff', image: null };

  panels.bk_front.bg = '#151515';
  panels.bk_front.texts = [
    makeText({ text: 'BAND NAME', font: 'Archivo Black', size: 30, color: '#f4efe4', y: 0.18 }),
    makeText({ text: 'Album Title', font: 'Special Elite', size: 16, weight: 400, color: '#ff4a2a', y: 0.86 }),
  ];
  panels.bk_back.texts = [
    makeText({ text: 'Thank you for listening.', font: 'Special Elite', size: 11, weight: 400, y: 0.5 }),
  ];
  panels.bk_inside_back.texts = [
    makeText({
      text: 'LYRICS & CREDITS\n\nWritten and performed by Band Name\nRecorded at Your Studio',
      font: 'Space Mono',
      size: 9,
      weight: 400,
      y: 0.5,
    }),
  ];
  panels.tc_back.texts = [
    makeText({
      text: '1. First Song\n2. Second Song\n3. Third Song\n4. Fourth Song\n5. Fifth Song',
      font: 'Space Mono',
      size: 12,
      weight: 400,
      align: 'left',
      x: 0.32,
      y: 0.45,
    }),
    makeText({ text: '© 2026 Band Name', font: 'Inter', size: 7, weight: 400, y: 0.92 }),
  ];
  panels.tc_spine_l.texts = [
    makeText({ text: 'BAND NAME — ALBUM TITLE', font: 'Inter', size: 9, rotation: -90 }),
  ];
  panels.tc_spine_r.texts = [
    makeText({ text: 'BAND NAME — ALBUM TITLE', font: 'Inter', size: 9, rotation: 90 }),
  ];
  panels.disc_label.bg = '#ece6d6';
  panels.disc_label.texts = [
    makeText({ text: 'BAND NAME', font: 'Archivo Black', size: 22, y: 0.27 }),
    makeText({ text: 'Album Title', font: 'Special Elite', size: 12, weight: 400, color: '#c8321a', y: 0.75 }),
  ];

  return { version: 1, name: '', sheets, panels };
}

// Fill in anything missing so older/partial projects stay valid.
function normalize(project) {
  const base = defaultProject();
  const out = { ...base, ...project, sheets: { ...base.sheets }, panels: { ...base.panels } };
  for (const key of Object.keys(base.sheets)) {
    if (project.sheets?.[key]) out.sheets[key] = { ...base.sheets[key], ...project.sheets[key] };
  }
  for (const id of Object.keys(base.panels)) {
    if (project.panels?.[id]) out.panels[id] = { ...emptyPanel(), ...project.panels[id] };
  }
  return out;
}

const clone = (v) => structuredClone(v);

function imageHolders(project) {
  return [...Object.values(project.sheets), ...Object.values(project.panels)].filter((x) => x.image);
}

class Store extends EventTarget {
  constructor() {
    super();
    this.project = defaultProject();
    this.undoStack = [];
    this.redoStack = [];
    this.saveTimer = null;
    this.saving = null;
    this.status = 'unsaved';
    this.lastCommitted = JSON.stringify(this.project);
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  setStatus(status, message) {
    this.status = status;
    this.emit('status', { status, message });
  }

  // Apply a mutation. Live edits (slider drags) pass history:false and call commit() when done.
  update(mutator, { history = true } = {}) {
    mutator(this.project);
    this.emit('change');
    if (history) this.commit();
  }

  commit() {
    const snapshot = JSON.stringify(this.project);
    if (snapshot === this.lastCommitted) return;
    this.undoStack.push(this.lastCommitted);
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack = [];
    this.lastCommitted = snapshot;
    this.emit('history');
    this.scheduleSave();
  }

  undo() {
    if (!this.undoStack.length) return;
    this.redoStack.push(this.lastCommitted);
    this.lastCommitted = this.undoStack.pop();
    this.project = JSON.parse(this.lastCommitted);
    this.emit('change', { replaced: true });
    this.emit('history');
    this.scheduleSave();
  }

  redo() {
    if (!this.redoStack.length) return;
    this.undoStack.push(this.lastCommitted);
    this.lastCommitted = this.redoStack.pop();
    this.project = JSON.parse(this.lastCommitted);
    this.emit('change', { replaced: true });
    this.emit('history');
    this.scheduleSave();
  }

  replace(project, status = 'saved') {
    this.project = normalize(project);
    this.undoStack = [];
    this.redoStack = [];
    this.lastCommitted = JSON.stringify(this.project);
    this.setStatus(status);
    this.emit('change', { replaced: true });
    this.emit('history');
  }

  /** Restore the draft kept in this browser. Returns the names of images that were lost, if any. */
  async restoreDraft() {
    const draft = await loadDraft();
    if (!draft) return [];
    const missing = new Set(draft.missing);
    for (const holder of imageHolders(draft.project)) if (missing.has(holder.image.src)) holder.image = null;
    this.replace(draft.project);
    return draft.missing;
  }

  async reset() {
    clearTimeout(this.saveTimer);
    this.replace(defaultProject(), 'unsaved');
    await this.save();
  }

  scheduleSave() {
    clearTimeout(this.saveTimer);
    this.setStatus('pending');
    this.saveTimer = setTimeout(() => this.save(), SAVE_DELAY);
  }

  async save() {
    clearTimeout(this.saveTimer);
    if (this.saving) {
      await this.saving;
    }
    this.saving = (async () => {
      try {
        this.setStatus('saving');
        await saveDraft(this.project);
        if (unsavedAssetsIn(this.project).length) throw new Error('browser storage is full — use Save .zip');
        this.setStatus('saved');
      } catch (err) {
        this.setStatus('error', err.message || 'browser storage is unavailable — use Save .zip');
      } finally {
        this.saving = null;
      }
    })();
    return this.saving;
  }

  /** Keep an image in this browser; returns the reference to put in `image.src`. */
  addImage(blob) {
    return putAsset(blob);
  }

  /** Replace the working project with one read from a .zip. */
  async importProject(project, assets, { onProgress } = {}) {
    const body = normalize(project);
    delete body.id;
    const names = new Map();
    let i = 0;
    for (const [path, blob] of assets) {
      onProgress?.(`Reading images ${++i}/${assets.size}…`);
      names.set(path, await putAsset(blob));
    }
    for (const holder of imageHolders(body)) {
      const name = names.get(holder.image.src);
      if (name) holder.image.src = name;
      else holder.image = null;
    }
    clearTimeout(this.saveTimer);
    this.replace(body, 'pending');
    await this.save();
  }

  panel(id) {
    return this.project.panels[id];
  }

  sheet(key) {
    return this.project.sheets[key];
  }

  snapshotPanel(id) {
    return clone(this.project.panels[id]);
  }
}

export { Store };
export const store = new Store();
