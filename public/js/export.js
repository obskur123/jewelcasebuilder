import { SHEETS, sheetSize } from './spec.js';
import { renderSheetToCanvas, sheetImageSources, whenImagesReady, fontsReadyFor } from './render.js';

const EXPORT_PPI = 300;

export const slug = (s) =>
  (s || 'jewel-case')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'jewel-case';

export function sheetFileName(project, s) {
  return `${slug(project.name)}_${s.part.code}_${s.sheetKey}`;
}

async function prepare(project, keys) {
  await fontsReadyFor(project);
  await whenImagesReady(keys.flatMap((k) => sheetImageSources(project, k)));
}

export function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

const toBlob = (canvas, type, q) => new Promise((resolve) => canvas.toBlob(resolve, type, q));

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Insert a pHYs chunk right after IHDR so the PNG carries its print resolution.
async function withDpi(blob, dpi) {
  const src = new Uint8Array(await blob.arrayBuffer());
  const ppm = Math.round(dpi / 0.0254);
  const chunk = new Uint8Array(21);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, 9);
  chunk.set([0x70, 0x48, 0x59, 0x73], 4);
  view.setUint32(8, ppm);
  view.setUint32(12, ppm);
  chunk[16] = 1;
  view.setUint32(17, crc32(chunk.subarray(4, 17)));
  const ihdrEnd = 8 + 25;
  return new Blob([src.subarray(0, ihdrEnd), chunk, src.subarray(ihdrEnd)], { type: 'image/png' });
}

// Place a bleed-size render centred on the Disc Makers template page.
function onTemplatePage(canvas, part) {
  const page = part.templatePage;
  const size = sheetSize(part);
  const out = document.createElement('canvas');
  out.width = Math.round(page.w * EXPORT_PPI);
  out.height = Math.round(page.h * EXPORT_PPI);
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(canvas, Math.round(((page.w - size.w) / 2) * EXPORT_PPI), Math.round(((page.h - size.h) / 2) * EXPORT_PPI));
  return out;
}

function renderForExport(project, s, { guides }) {
  const canvas = renderSheetToCanvas(project, s.key, { ppi: EXPORT_PPI, guides, dpr: guides ? EXPORT_PPI / 96 : 1 });
  return canvas;
}

export async function exportPdf(project, keys, { pageSize = 'bleed', guides = false, onProgress } = {}) {
  await prepare(project, keys);
  const { jsPDF } = window.jspdf;
  let doc = null;
  for (const [i, key] of keys.entries()) {
    const s = SHEETS.find((x) => x.key === key);
    onProgress?.(`Rendering ${s.part.name} ${s.sheet.name} (${i + 1}/${keys.length})…`);
    await new Promise((r) => setTimeout(r, 0));
    let canvas = renderForExport(project, s, { guides });
    const dims = pageSize === 'template' ? s.part.templatePage : sheetSize(s.part);
    if (pageSize === 'template') canvas = onTemplatePage(canvas, s.part);
    const orientation = dims.w >= dims.h ? 'landscape' : 'portrait';
    if (!doc) doc = new jsPDF({ unit: 'in', format: [dims.w, dims.h], orientation, compress: true });
    else doc.addPage([dims.w, dims.h], orientation);
    doc.addImage(canvas.toDataURL('image/jpeg', 0.95), 'JPEG', 0, 0, dims.w, dims.h, undefined, 'FAST');
  }
  if (!doc) return;
  doc.setProperties({ title: project.name || 'Jewel case artwork', creator: 'Jewel Case Builder' });
  onProgress?.('Saving PDF…');
  download(doc.output('blob'), `${slug(project.name)}_print${guides ? '_proof' : ''}.pdf`);
}

export async function exportPngs(project, keys, { pageSize = 'bleed', guides = false, onProgress } = {}) {
  await prepare(project, keys);
  for (const [i, key] of keys.entries()) {
    const s = SHEETS.find((x) => x.key === key);
    onProgress?.(`Rendering ${s.part.name} ${s.sheet.name} (${i + 1}/${keys.length})…`);
    await new Promise((r) => setTimeout(r, 0));
    let canvas = renderForExport(project, s, { guides });
    if (pageSize === 'template') canvas = onTemplatePage(canvas, s.part);
    const png = await withDpi(await toBlob(canvas, 'image/png'), EXPORT_PPI);
    download(png, `${sheetFileName(project, s)}${guides ? '_proof' : ''}.png`);
    await new Promise((r) => setTimeout(r, 350));
  }
}
