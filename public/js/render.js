import { PANELS, sheetInfo, sheetSize, panelRect, safeRect } from './spec.js';
import { assetUrl } from './assets.js';

const GUIDE = {
  bleed: '#77a5cc',
  trim: '#e0619a',
  safety: '#86c79b',
  fold: '#e0619a',
};

// ---------- image + font loading ----------

const imageCache = new Map();
const listeners = new Set();
export const onAssetLoaded = (fn) => listeners.add(fn);
const notify = () => listeners.forEach((fn) => fn());

export function getImage(src) {
  if (!src) return null;
  let entry = imageCache.get(src);
  if (!entry) {
    const img = new Image();
    img.decoding = 'async';
    entry = { img, ready: false, error: false };
    img.onload = () => {
      entry.ready = true;
      notify();
    };
    img.onerror = () => {
      entry.error = true;
      notify();
    };
    img.src = assetUrl(src);
    imageCache.set(src, entry);
  }
  return entry.ready ? entry.img : null;
}

export function whenImagesReady(srcs) {
  return Promise.all(
    srcs.filter(Boolean).map(
      (src) =>
        new Promise((resolve) => {
          getImage(src);
          const entry = imageCache.get(src);
          if (entry.ready || entry.error) return resolve();
          entry.img.addEventListener('load', resolve, { once: true });
          entry.img.addEventListener('error', resolve, { once: true });
        }),
    ),
  );
}

const requestedFonts = new Set();
function fontString(t, sizeIn) {
  return `${t.italic ? 'italic ' : ''}${t.weight || 400} ${sizeIn}px "${t.font}", sans-serif`;
}
function ensureFont(t) {
  const key = `${t.italic ? 'i' : ''}${t.weight}|${t.font}`;
  if (requestedFonts.has(key) || !document.fonts) return;
  requestedFonts.add(key);
  document.fonts.load(fontString(t, 20)).then(notify, () => {});
}

export function sheetImageSources(project, sheetKey) {
  const info = sheetInfo(sheetKey);
  const srcs = [project.sheets[sheetKey]?.image?.src];
  for (const p of info.sheet.panels) srcs.push(project.panels[p.id]?.image?.src);
  return srcs.filter(Boolean);
}

export async function fontsReadyFor(project) {
  if (!document.fonts) return;
  const loads = [];
  for (const panel of Object.values(project.panels)) {
    for (const t of panel.texts || []) loads.push(document.fonts.load(fontString(t, 20)).catch(() => {}));
  }
  await Promise.all(loads);
}

// ---------- drawing ----------

function drawFitted(ctx, img, box, opts) {
  const rot = ((opts.rot || 0) % 360 + 360) % 360;
  const quarter = rot === 90 || rot === 270;
  const iw = quarter ? img.naturalHeight : img.naturalWidth;
  const ih = quarter ? img.naturalWidth : img.naturalHeight;
  const base = opts.fit === 'contain' ? Math.min(box.w / iw, box.h / ih) : Math.max(box.w / iw, box.h / ih);
  const s = base * (opts.scale || 1);
  const cx = box.x + box.w / 2 + (opts.dx || 0) * box.w;
  const cy = box.y + box.h / 2 + (opts.dy || 0) * box.h;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate((rot * Math.PI) / 180);
  const w = img.naturalWidth * s;
  const h = img.naturalHeight * s;
  ctx.drawImage(img, -w / 2, -h / 2, w, h);
  ctx.restore();
  return { printWidthIn: iw * s, pxWidth: iw };
}

// Effective print resolution of a panel image, in pixels per inch.
export function imageDpi(panelId, image) {
  const entry = imageCache.get(image?.src);
  if (!entry?.ready) return null;
  const box = panelRect(panelId, { bleed: true });
  const img = entry.img;
  const rot = ((image.rot || 0) % 360 + 360) % 360;
  const quarter = rot === 90 || rot === 270;
  const iw = quarter ? img.naturalHeight : img.naturalWidth;
  const ih = quarter ? img.naturalWidth : img.naturalHeight;
  const base = image.fit === 'contain' ? Math.min(box.w / iw, box.h / ih) : Math.max(box.w / iw, box.h / ih);
  return Math.round(1 / (base * (image.scale || 1)));
}

export function sheetImageDpi(sheetKey, image) {
  const entry = imageCache.get(image?.src);
  if (!entry?.ready) return null;
  const { part } = sheetInfo(sheetKey);
  const size = sheetSize(part);
  const targetW = image.target === 'trim' ? part.trimW : size.w;
  return Math.round((entry.img.naturalWidth * (image.crop?.w ?? 1)) / targetW);
}

// Text is laid out in device pixels (not inches) because tiny fractional font sizes render badly.
function drawText(ctx, t, rect, hits, panelId, ppi) {
  if (!t.text) return;
  ensureFont(t);
  const sizePx = (t.size / 72) * ppi;
  ctx.save();
  const ax = rect.x + t.x * rect.w;
  const ay = rect.y + t.y * rect.h;
  const angle = ((t.rotation || 0) * Math.PI) / 180;
  ctx.translate(ax, ay);
  ctx.rotate(angle);
  ctx.scale(1 / ppi, 1 / ppi);
  ctx.font = fontString(t, sizePx);
  ctx.fillStyle = t.color;
  ctx.textBaseline = 'middle';
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${(t.letterSpacing || 0) * sizePx}px`;
  const lines = String(t.text).split('\n');
  const lhPx = sizePx * (t.lineHeight || 1.15);
  const widthsPx = lines.map((l) => ctx.measureText(l).width);
  const bwPx = Math.max(1, ...widthsPx);
  const bhPx = lhPx * lines.length;
  lines.forEach((line, i) => {
    let x;
    if (t.align === 'left') x = -bwPx / 2;
    else if (t.align === 'right') x = bwPx / 2 - widthsPx[i];
    else x = -widthsPx[i] / 2;
    ctx.fillText(line, x, -bhPx / 2 + lhPx * (i + 0.5));
  });
  ctx.restore();
  const bw = bwPx / ppi;
  const bh = bhPx / ppi;

  if (hits) {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const pts = [
      [-bw / 2, -bh / 2],
      [bw / 2, -bh / 2],
      [bw / 2, bh / 2],
      [-bw / 2, bh / 2],
    ].map(([x, y]) => [ax + x * c - y * s, ay + x * s + y * c]);
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    hits.push({
      type: 'text',
      panelId,
      textId: t.id,
      box: { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) },
    });
  }
}

function drawGuides(ctx, info, size, ppi, dpr) {
  const { part, sheet } = info;
  const lw = (1.25 * dpr) / ppi;
  ctx.save();
  ctx.lineWidth = lw;

  if (part.round) {
    const c = size.w / 2;
    // Dim everything that will not print on the disc.
    ctx.fillStyle = 'rgba(245,243,238,0.82)';
    ctx.beginPath();
    ctx.rect(0, 0, size.w, size.h);
    ctx.arc(c, c, part.printOuter / 2, 0, Math.PI * 2, true);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(c, c, part.printInner / 2, 0, Math.PI * 2);
    ctx.fill();
    const circle = (d, color, dash) => {
      ctx.strokeStyle = color;
      ctx.setLineDash(dash ? [(6 * dpr) / ppi, (4 * dpr) / ppi] : []);
      ctx.beginPath();
      ctx.arc(c, c, d / 2, 0, Math.PI * 2);
      ctx.stroke();
    };
    circle(part.discD, GUIDE.bleed);
    circle(part.printOuter, GUIDE.trim);
    circle(part.safeOuter, GUIDE.safety, true);
    circle(part.mirrorBand, GUIDE.safety);
    circle(part.safeInner, GUIDE.safety, true);
    circle(part.printInner, GUIDE.trim);
    circle(part.hole, GUIDE.bleed);
    ctx.strokeStyle = GUIDE.bleed;
    ctx.setLineDash([]);
    ctx.strokeRect(lw / 2, lw / 2, size.w - lw, size.h - lw);
    ctx.restore();
    return;
  }

  const b = part.bleed;
  // Wash over the bleed so it reads as "will be trimmed off".
  ctx.fillStyle = 'rgba(245,243,238,0.55)';
  ctx.beginPath();
  ctx.rect(0, 0, size.w, size.h);
  ctx.rect(b, b, part.trimW, part.trimH);
  ctx.fill('evenodd');

  ctx.strokeStyle = GUIDE.bleed;
  ctx.strokeRect(lw / 2, lw / 2, size.w - lw, size.h - lw);
  ctx.strokeStyle = GUIDE.trim;
  ctx.strokeRect(b, b, part.trimW, part.trimH);

  ctx.setLineDash([(5 * dpr) / ppi, (4 * dpr) / ppi]);
  ctx.strokeStyle = GUIDE.fold;
  for (const f of sheet.folds) {
    ctx.beginPath();
    ctx.moveTo(b + f, 0);
    ctx.lineTo(b + f, size.h);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  ctx.strokeStyle = GUIDE.safety;
  for (const p of sheet.panels) {
    if (p.id === 'tc_inside') continue;
    const r = safeRect(p.id);
    ctx.strokeRect(r.x, r.y, r.w, r.h);
  }

  if (sheet.disc) {
    const d = sheet.disc;
    ctx.strokeStyle = GUIDE.safety;
    for (const r of [d.r, d.hub, d.hole]) {
      ctx.beginPath();
      ctx.arc(b + d.cx, b + d.cy, r, 0, Math.PI * 2);
      ctx.stroke();
    }
    const r = safeRect('tc_inside');
    ctx.strokeRect(r.x, r.y, r.w, r.h);
  }
  if (sheet.spineWindow) {
    ctx.fillStyle = 'rgba(120,120,120,0.16)';
    ctx.fillRect(b + sheet.spineWindow.x, b, sheet.spineWindow.w, part.trimH);
  }

  // Panel names, small and faint, so the sheet is self-explanatory.
  ctx.scale(1 / ppi, 1 / ppi);
  ctx.fillStyle = 'rgba(60,60,60,0.55)';
  ctx.font = `600 ${9 * dpr}px "Space Mono", monospace`;
  ctx.textBaseline = 'top';
  for (const p of sheet.panels) {
    const r = panelRect(p.id);
    if (r.w < 1) continue;
    const label = p.page ? `p${p.page} · ${p.name.toUpperCase()}` : p.name.toUpperCase();
    ctx.fillText(label, r.x * ppi + 6 * dpr, r.y * ppi + 5 * dpr);
  }
  ctx.restore();
}

/**
 * Draw one sheet (e.g. "booklet.outside") into ctx. Canvas pixels map to inches via ppi.
 * Returns hit regions (in inches) for interactive editing.
 */
export function renderSheet(ctx, project, sheetKey, { ppi, guides = false, hits = null, dpr = 1 } = {}) {
  const info = sheetInfo(sheetKey);
  const { part, sheet } = info;
  const size = sheetSize(part);
  const sheetData = project.sheets[sheetKey] || {};

  ctx.save();
  ctx.scale(ppi, ppi);
  ctx.fillStyle = sheetData.bg || '#ffffff';
  ctx.fillRect(0, 0, size.w, size.h);

  if (sheetData.image) {
    const img = getImage(sheetData.image.src);
    if (img) {
      const c = sheetData.image.crop || { x: 0, y: 0, w: 1, h: 1 };
      const dst =
        sheetData.image.target === 'trim'
          ? { x: part.bleed, y: part.bleed, w: part.trimW, h: part.trimH }
          : { x: 0, y: 0, w: size.w, h: size.h };
      ctx.drawImage(
        img,
        c.x * img.naturalWidth,
        c.y * img.naturalHeight,
        c.w * img.naturalWidth,
        c.h * img.naturalHeight,
        dst.x,
        dst.y,
        dst.w,
        dst.h,
      );
    }
  }

  for (const p of sheet.panels) {
    const data = project.panels[p.id];
    if (!data) continue;
    const box = panelRect(p.id, { bleed: true });
    const trim = panelRect(p.id);
    ctx.save();
    ctx.beginPath();
    ctx.rect(box.x, box.y, box.w, box.h);
    ctx.clip();
    if (data.bg) {
      ctx.fillStyle = data.bg;
      ctx.fillRect(box.x, box.y, box.w, box.h);
    }
    if (data.image) {
      const img = getImage(data.image.src);
      if (img) drawFitted(ctx, img, box, data.image);
    }
    for (const t of data.texts || []) drawText(ctx, t, trim, hits, p.id, ppi);
    ctx.restore();
    if (hits) hits.push({ type: 'panel', panelId: p.id, box: trim, bleedBox: box });
  }

  if (guides) drawGuides(ctx, info, size, ppi, dpr);
  ctx.restore();
  return hits;
}

// Text boxes that cross the safety line of their panel.
export function safetyWarnings(hits, panelId) {
  const r = safeRect(panelId);
  const p = PANELS[panelId];
  if (p.part.round) {
    const c = p.part.trimW / 2;
    return hits
      .filter((h) => h.type === 'text' && h.panelId === panelId)
      .filter((h) => {
        const corners = [
          [h.box.x, h.box.y],
          [h.box.x + h.box.w, h.box.y],
          [h.box.x, h.box.y + h.box.h],
          [h.box.x + h.box.w, h.box.y + h.box.h],
        ];
        return corners.some(([x, y]) => Math.hypot(x - c, y - c) > p.part.safeOuter / 2);
      })
      .map((h) => h.textId);
  }
  const eps = 0.005;
  return hits
    .filter((h) => h.type === 'text' && h.panelId === panelId)
    .filter(
      (h) =>
        h.box.x < r.x - eps || h.box.y < r.y - eps || h.box.x + h.box.w > r.x + r.w + eps || h.box.y + h.box.h > r.y + r.h + eps,
    )
    .map((h) => h.textId);
}

export function renderSheetToCanvas(project, sheetKey, { ppi, guides = false, canvas = document.createElement('canvas') } = {}) {
  const { part } = sheetInfo(sheetKey);
  const size = sheetSize(part);
  const w = Math.round(size.w * ppi);
  const h = Math.round(size.h * ppi);
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, h);
  renderSheet(ctx, project, sheetKey, { ppi: w / size.w, guides });
  return canvas;
}
