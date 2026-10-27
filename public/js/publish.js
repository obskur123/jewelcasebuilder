const SAVED_KEY = 'jcb:publishedShares';

const toBlob = (canvas, type, quality) =>
  new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode image'))), type, quality));

async function encodeCanvas(canvas) {
  const webp = await toBlob(canvas, 'image/webp', 0.82);
  return webp.type === 'image/webp' ? webp : toBlob(canvas, 'image/jpeg', 0.85);
}

async function blobToWebp(blob, quality = 0.8) {
  const bmp = await createImageBitmap(blob);
  const c = document.createElement('canvas');
  c.width = bmp.width;
  c.height = bmp.height;
  c.getContext('2d').drawImage(bmp, 0, 0);
  bmp.close?.();
  return encodeCanvas(c);
}

export function rememberedShares() {
  try {
    return JSON.parse(localStorage.getItem(SAVED_KEY) || '[]');
  } catch {
    return [];
  }
}

export function rememberShare(entry) {
  const list = [entry, ...rememberedShares().filter((s) => s.id !== entry.id)].slice(0, 20);
  localStorage.setItem(SAVED_KEY, JSON.stringify(list));
}

export function forgetShare(id) {
  localStorage.setItem(SAVED_KEY, JSON.stringify(rememberedShares().filter((s) => s.id !== id)));
}

export function deleteTokenFor(id) {
  return rememberedShares().find((s) => s.id === id)?.deleteToken || null;
}

export async function publishShare({ title, trayColor, preview }) {
  const body = new FormData();
  body.append('title', (title || '').slice(0, 80));
  body.append('scene', JSON.stringify({ trayColor: trayColor === 'black' ? 'black' : 'clear' }));
  for (const [key, canvas] of Object.entries(preview.canvases)) {
    const blob = await encodeCanvas(canvas);
    body.append(key, blob, `${key.replaceAll('.', '-')}.${blob.type.includes('webp') ? 'webp' : 'jpg'}`);
  }
  const posterPng = await (await fetch(preview.snapshot({ width: 1200 }))).blob();
  const poster = await blobToWebp(posterPng, 0.82);
  body.append('poster', poster, `poster.${poster.type.includes('webp') ? 'webp' : 'jpg'}`);

  const res = await fetch('/api/shares', { method: 'POST', body });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Could not publish');
  rememberShare({ id: data.id, title, deleteToken: data.deleteToken, createdAt: new Date().toISOString() });
  return { ...data, url: `${location.origin}${data.url}` };
}

export async function deletePublished(id, token) {
  const res = await fetch(`/api/shares/${id}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', 'X-Delete-Token': token },
    body: JSON.stringify({ token }),
  });
  if (!res.ok && res.status !== 204) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Could not delete');
  }
  forgetShare(id);
}
