const crypto = require('crypto');
const { eq, and } = require('drizzle-orm');
const { shares, shareTextures } = require('./schema');

const SHEET_KEYS = ['booklet.outside', 'booklet.inside', 'traycard.outside', 'traycard.inside', 'disc.label'];
const TEXTURE_KEYS = [...SHEET_KEYS, 'poster'];
const ID_RE = /^[A-Za-z0-9_-]{10,40}$/;
const MAX_FILE = 1.5 * 1024 * 1024;
const MAX_TOTAL = 5 * 1024 * 1024;

function sniff(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

function parseScene(raw) {
  let scene = raw;
  if (typeof raw === 'string') {
    try {
      scene = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!scene || typeof scene !== 'object') return null;
  return { trayColor: scene.trayColor === 'black' ? 'black' : 'clear' };
}

function collectTextures(files) {
  const byKey = new Map();
  for (const file of files || []) {
    if (!TEXTURE_KEYS.includes(file.fieldname)) continue;
    byKey.set(file.fieldname, file);
  }
  return byKey;
}

async function createShare(db, { title, scene, files }) {
  const parsed = parseScene(scene);
  if (!parsed) throw Object.assign(new Error('Invalid scene'), { status: 400 });

  const byKey = collectTextures(files);
  for (const key of SHEET_KEYS) {
    if (!byKey.has(key)) throw Object.assign(new Error(`Missing ${key}`), { status: 400 });
  }

  let total = 0;
  const rows = [];
  for (const [key, file] of byKey) {
    if (file.size > MAX_FILE) throw Object.assign(new Error(`${key} is larger than 1.5 MB`), { status: 413 });
    total += file.size;
    const mime = sniff(file.buffer);
    if (!mime) throw Object.assign(new Error(`${key} must be a WebP or JPEG`), { status: 415 });
    rows.push({ key, mime, data: file.buffer });
  }
  if (total > MAX_TOTAL) throw Object.assign(new Error('Share is larger than 5 MB'), { status: 413 });

  const id = crypto.randomBytes(12).toString('base64url');
  const deleteToken = crypto.randomBytes(18).toString('base64url');
  await db.transaction(async (tx) => {
    await tx.insert(shares).values({
      id,
      title: String(title || '').slice(0, 80),
      scene: parsed,
      deleteTokenHash: hashToken(deleteToken),
    });
    await tx.insert(shareTextures).values(rows.map((r) => ({ shareId: id, ...r })));
  });
  return { id, deleteToken };
}

async function getShare(db, id) {
  if (!ID_RE.test(id)) return null;
  const [row] = await db.select({ id: shares.id, title: shares.title, scene: shares.scene }).from(shares).where(eq(shares.id, id));
  return row || null;
}

async function getTexture(db, id, key) {
  if (!ID_RE.test(id) || !TEXTURE_KEYS.includes(key)) return null;
  const [row] = await db
    .select({ mime: shareTextures.mime, data: shareTextures.data })
    .from(shareTextures)
    .where(and(eq(shareTextures.shareId, id), eq(shareTextures.key, key)));
  return row || null;
}

async function deleteShare(db, id, token) {
  if (!ID_RE.test(id) || !token) return false;
  const [row] = await db.select({ deleteTokenHash: shares.deleteTokenHash }).from(shares).where(eq(shares.id, id));
  if (!row) return false;
  const a = Buffer.from(row.deleteTokenHash, 'hex');
  const b = Buffer.from(hashToken(token), 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  await db.delete(shares).where(eq(shares.id, id));
  return true;
}

module.exports = { SHEET_KEYS, TEXTURE_KEYS, ID_RE, createShare, getShare, getTexture, deleteShare };
