import { sheetInfo, sheetSize } from './spec.js';

const PDF_DPI = 300;
const MAX_SIDE = 8000;

let pdfjsPromise;
function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import('/vendor/pdfjs/pdf.min.mjs').then((pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';
      return pdfjs;
    });
  }
  return pdfjsPromise;
}

const canvasToBlob = (canvas, type, quality) =>
  new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Encode failed'))), type, quality));

function loadImageFromBlob(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('That file could not be read as an image'));
    };
    img.src = url;
  });
}

/**
 * Turn a user file (JPG/PNG/WebP/PDF) into an uploadable image blob.
 * PDFs are rasterised at 300 DPI and also report their physical page size.
 */
export async function prepareFile(file) {
  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
  if (isPdf) {
    const pdfjs = await loadPdfjs();
    const task = pdfjs.getDocument({ data: await file.arrayBuffer() });
    const doc = await task.promise;
    const page = await doc.getPage(1);
    const unit = page.getViewport({ scale: 1 });
    let scale = PDF_DPI / 72;
    scale = Math.min(scale, MAX_SIDE / Math.max(unit.width, unit.height));
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, canvas, viewport }).promise;
    const blob = await canvasToBlob(canvas, 'image/jpeg', 0.93);
    const pageCount = doc.numPages;
    task.destroy();
    return {
      blob,
      name: file.name.replace(/\.pdf$/i, '.jpg'),
      width: canvas.width,
      height: canvas.height,
      inches: { w: unit.width / 72, h: unit.height / 72 },
      pageCount,
    };
  }
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) {
    throw new Error('Use a JPG, PNG, WebP or PDF file');
  }
  const img = await loadImageFromBlob(file);
  return { blob: file, name: file.name, width: img.naturalWidth, height: img.naturalHeight, inches: null };
}

/**
 * Work out how a finished sheet maps onto our layout. Accepts art at bleed size, trim size,
 * or the full Disc Makers template page (art centred with margins around it).
 */
export function fitSheetUpload(sheetKey, prepared) {
  const { part } = sheetInfo(sheetKey);
  const bleed = sheetSize(part);
  const tpl = part.templatePage;
  const candidates = [
    { kind: 'bleed', w: bleed.w, h: bleed.h },
    { kind: 'trim', w: part.trimW, h: part.trimH },
    { kind: 'template', w: tpl.w, h: tpl.h },
  ];
  const uniq = candidates.filter((c, i) => candidates.findIndex((d) => Math.abs(d.w - c.w) < 1e-3 && Math.abs(d.h - c.h) < 1e-3) === i);

  let match = null;
  if (prepared.inches) {
    match = uniq.find((c) => Math.abs(c.w - prepared.inches.w) < 0.08 && Math.abs(c.h - prepared.inches.h) < 0.08);
  }
  if (!match) {
    const aspect = prepared.width / prepared.height;
    const byAspect = uniq.filter((c) => Math.abs(c.w / c.h - aspect) / aspect < 0.015);
    if (byAspect.length === 1) match = byAspect[0];
    else if (byAspect.length > 1) {
      // Same aspect (e.g. a square disc): guess by pixel width at 300 DPI.
      const inchesAt300 = prepared.width / 300;
      match = byAspect.reduce((best, c) => (Math.abs(c.w - inchesAt300) < Math.abs(best.w - inchesAt300) ? c : best));
      if (match.kind === 'template' && Math.abs(match.w - inchesAt300) / match.w > 0.05) match = byAspect[0];
    }
  }

  if (match?.kind === 'bleed') {
    return { target: 'bleed', crop: { x: 0, y: 0, w: 1, h: 1 }, note: 'Matched bleed size.' };
  }
  if (match?.kind === 'trim') {
    return {
      target: 'trim',
      crop: { x: 0, y: 0, w: 1, h: 1 },
      note: part.bleed ? 'Artwork is trim size (no bleed) — extend backgrounds or expect thin white edges.' : 'Matched trim size.',
    };
  }
  if (match?.kind === 'template') {
    const cw = bleed.w / tpl.w;
    const ch = bleed.h / tpl.h;
    return {
      target: 'bleed',
      crop: { x: (1 - cw) / 2, y: (1 - ch) / 2, w: cw, h: ch },
      note: `Detected a full ${part.code} template page — cropped to the bleed box.`,
    };
  }
  // Unknown proportions: centre-crop to the bleed aspect.
  const want = bleed.w / bleed.h;
  const have = prepared.width / prepared.height;
  const crop = have > want ? { x: (1 - want / have) / 2, y: 0, w: want / have, h: 1 } : { x: 0, y: (1 - have / want) / 2, w: 1, h: have / want };
  return {
    target: 'bleed',
    crop,
    note: `Proportions didn't match the ${part.code} template (${bleed.w.toFixed(3)}" × ${bleed.h.toFixed(3)}" with bleed); centre-cropped to fit.`,
    warn: true,
  };
}
