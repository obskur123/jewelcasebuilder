import { zipSync, unzipSync, strToU8, strFromU8 } from '/vendor/fflate/browser.js';
import { PARTS } from './spec.js';
import { assetBlob } from './assets.js';

// Bundle layout:
//   project.json   { format, version, exportedAt, templates, project }
//   assets/*       every image the project references (src = "assets/<file>")
//   preview.png    3D mockup, for humans browsing the zip
export const BUNDLE_FORMAT = 'jewelcase-builder';
export const BUNDLE_VERSION = 1;

const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

function imageRefs(project) {
  const refs = [];
  for (const s of Object.values(project.sheets || {})) if (s?.image?.src) refs.push(s.image);
  for (const p of Object.values(project.panels || {})) if (p?.image?.src) refs.push(p.image);
  return refs;
}

export const isZip = (file) => /\.zip$/i.test(file.name) || /zip/.test(file.type);

export async function buildBundle(project, { previewPng = null } = {}) {
  const copy = structuredClone(project);
  delete copy.id;
  delete copy.createdAt;
  delete copy.updatedAt;

  const files = {};
  const paths = new Map();
  for (const ref of imageRefs(copy)) {
    if (!paths.has(ref.src)) {
      const blob = assetBlob(ref.src);
      if (!blob) throw new Error(`Image ${ref.src} is missing from this browser`);
      const base = ref.src.replace(/[^\w.-]/g, '_') || `image-${paths.size}.jpg`;
      let path = `assets/${base}`;
      for (let n = 2; files[path]; n++) path = `assets/${n}-${base}`;
      // Images are already compressed; storing them avoids burning CPU for ~0% gain.
      files[path] = [new Uint8Array(await blob.arrayBuffer()), { level: 0 }];
      paths.set(ref.src, path);
    }
    ref.src = paths.get(ref.src);
  }

  const manifest = {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    exportedAt: new Date().toISOString(),
    templates: Object.fromEntries(Object.entries(PARTS).map(([k, p]) => [k, p.code])),
    project: copy,
  };
  files['project.json'] = strToU8(JSON.stringify(manifest, null, 2));
  if (previewPng) files['preview.png'] = [new Uint8Array(await previewPng.arrayBuffer()), { level: 0 }];
  return new Blob([zipSync(files)], { type: 'application/zip' });
}

/**
 * Parse a bundle. Returns the project (image srcs still pointing at "assets/…"),
 * the image blobs keyed by that path, and any referenced images that were missing.
 */
export async function readBundle(file) {
  let entries;
  try {
    entries = unzipSync(new Uint8Array(await file.arrayBuffer()));
  } catch {
    throw new Error('That file is not a valid .zip');
  }
  // Tolerate zips that were unpacked and re-zipped with a wrapping folder.
  const manifestPath = Object.keys(entries)
    .filter((p) => !p.startsWith('__MACOSX/'))
    .find((p) => p === 'project.json' || p.endsWith('/project.json'));
  if (!manifestPath) throw new Error('No project.json found in this zip');
  const root = manifestPath.slice(0, -'project.json'.length);

  let manifest;
  try {
    manifest = JSON.parse(strFromU8(entries[manifestPath]));
  } catch {
    throw new Error('project.json is not valid JSON');
  }
  if (manifest.format !== BUNDLE_FORMAT) throw new Error('This zip was not made by Jewel Case Builder');
  if (manifest.version > BUNDLE_VERSION) throw new Error('This project was saved by a newer version of the builder');
  const project = manifest.project;
  if (!project || typeof project.panels !== 'object') throw new Error('project.json has no project data');

  const assets = new Map();
  const missing = [];
  for (const ref of imageRefs(project)) {
    if (assets.has(ref.src)) continue;
    const bytes = entries[root + ref.src];
    const ext = ref.src.split('.').pop().toLowerCase();
    if (!bytes || !MIME[ext]) {
      missing.push(ref.src);
      continue;
    }
    assets.set(ref.src, new Blob([bytes], { type: MIME[ext] }));
  }
  return { project, assets, missing };
}
