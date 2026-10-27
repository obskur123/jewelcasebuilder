// Everything lives in this browser: the working draft and its images are kept in IndexedDB,
// and images are referenced from the project by a content-hash name (e.g. "3f9a…c2.jpg").

const DB_NAME = 'jewelcase-builder';
const DB_VERSION = 1;
const DRAFT_KEY = 'current';
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

const blobs = new Map();
const urls = new Map();

let dbPromise;
function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        req.result.createObjectStore('drafts');
        req.result.createObjectStore('assets');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('Browser storage is unavailable'));
    });
    dbPromise.catch(() => (dbPromise = null));
  }
  return dbPromise;
}

async function tx(storeName, mode, fn) {
  const conn = await db();
  return new Promise((resolve, reject) => {
    const t = conn.transaction(storeName, mode);
    const result = fn(t.objectStore(storeName));
    t.oncomplete = () => resolve(result?.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Browser storage is full'));
  });
}

const refsOf = (project) =>
  [...Object.values(project?.sheets || {}), ...Object.values(project?.panels || {})]
    .map((x) => x?.image?.src)
    .filter(Boolean);

async function hashName(blob) {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  const hex = [...new Uint8Array(digest).slice(0, 12)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex}.${EXT[blob.type] || 'jpg'}`;
}

/** Store an image and return the name the project should reference. */
export async function putAsset(blob) {
  const name = await hashName(blob);
  if (!blobs.has(name)) {
    blobs.set(name, blob);
    urls.set(name, URL.createObjectURL(blob));
  }
  try {
    await tx('assets', 'readwrite', (s) => s.put(blob, name));
    unsavedAssets.delete(name);
  } catch {
    // Still usable this session; the draft save reports the problem.
    unsavedAssets.add(name);
  }
  return name;
}

const unsavedAssets = new Set();
/** Images the current project uses that could not be written to browser storage. */
export const unsavedAssetsIn = (project) => refsOf(project).filter((n) => unsavedAssets.has(n));

/** URL an <img> can load for a project image reference. */
export const assetUrl = (name) => urls.get(name) || name;

export const assetBlob = (name) => blobs.get(name) || null;

async function loadAssets(names) {
  const missing = [];
  for (const name of new Set(names)) {
    if (blobs.has(name)) continue;
    const blob = await tx('assets', 'readonly', (s) => s.get(name));
    if (!blob) {
      missing.push(name);
      continue;
    }
    blobs.set(name, blob);
    urls.set(name, URL.createObjectURL(blob));
  }
  return missing;
}

export async function saveDraft(project) {
  await tx('drafts', 'readwrite', (s) => s.put(project, DRAFT_KEY));
}

/** The saved draft with its images loaded, or null. Unreferenced images are deleted. */
export async function loadDraft() {
  const project = await tx('drafts', 'readonly', (s) => s.get(DRAFT_KEY));
  const keep = new Set(refsOf(project));
  const stored = await tx('assets', 'readonly', (s) => s.getAllKeys());
  const stale = stored.filter((k) => !keep.has(k));
  if (stale.length) await tx('assets', 'readwrite', (s) => stale.forEach((k) => s.delete(k)));
  if (!project) return null;
  return { project, missing: await loadAssets(keep) };
}

/** Ask the browser not to evict our storage under pressure. Best effort. */
export const requestPersistence = () => navigator.storage?.persist?.().catch(() => false);
