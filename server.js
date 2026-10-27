require('dotenv').config();

const path = require('path');
const fs = require('fs/promises');
const express = require('express');
const multer = require('multer');
const { connect } = require('./db');
const { createShare, getShare, getTexture, deleteShare, ID_RE } = require('./db/shares');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const app = express();
app.disable('x-powered-by');

const vendor = (mount, dir) =>
  app.use(mount, express.static(path.join(__dirname, 'node_modules', dir), { maxAge: '7d' }));
vendor('/vendor/three', 'three');
vendor('/vendor/jspdf', 'jspdf/dist');
vendor('/vendor/pdfjs', 'pdfjs-dist/build');
vendor('/vendor/fflate', 'fflate/esm');

app.use(express.static(PUBLIC_DIR));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1.5 * 1024 * 1024, files: 8 },
});

let db = null;
const needDb = (req, res, next) => {
  if (!db) return res.status(503).json({ error: 'Sharing is not configured. Set DATABASE_URL and restart.' });
  next();
};

app.get('/api/shares/status', (req, res) => res.json({ enabled: !!db }));

app.post('/api/shares', needDb, upload.any(), async (req, res, next) => {
  try {
    const created = await createShare(db, { title: req.body.title, scene: req.body.scene, files: req.files });
    res.status(201).json({
      id: created.id,
      url: `/s/${created.id}`,
      deleteToken: created.deleteToken,
    });
  } catch (err) {
    next(err);
  }
});

app.get('/api/shares/:id', needDb, async (req, res, next) => {
  try {
    const share = await getShare(db, req.params.id);
    if (!share) return res.status(404).json({ error: 'Share not found' });
    res.json(share);
  } catch (err) {
    next(err);
  }
});

app.get('/api/shares/:id/textures/:key', needDb, async (req, res, next) => {
  try {
    const row = await getTexture(db, req.params.id, req.params.key);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.set({
      'Content-Type': row.mime,
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Content-Length': String(row.data.length),
    });
    res.end(row.data);
  } catch (err) {
    next(err);
  }
});

app.delete('/api/shares/:id', needDb, express.json(), async (req, res, next) => {
  try {
    const token = req.get('x-delete-token') || req.body?.token;
    const ok = await deleteShare(db, req.params.id, token);
    if (!ok) return res.status(404).json({ error: 'Share not found' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

app.get('/s/:id', async (req, res) => {
  if (!ID_RE.test(req.params.id)) return res.redirect(302, '/');
  const html = await fs.readFile(path.join(PUBLIC_DIR, 'share.html'), 'utf8');
  const share = db ? await getShare(db, req.params.id) : null;
  const title = share?.title ? `${share.title} — Jewel Case` : 'Jewel Case';
  const origin = `${req.protocol}://${req.get('host')}`;
  const og = share ? `${origin}/api/shares/${share.id}/textures/poster` : '';
  res.type('html').send(
    html
      .replaceAll('{{TITLE}}', escapeHtml(title))
      .replaceAll('{{OG_IMAGE}}', escapeHtml(og))
      .replaceAll('{{SHARE_ID}}', escapeHtml(req.params.id)),
  );
});

// Old project links from when projects were stored on the server.
app.get('/p/:id', (req, res) => res.redirect(302, '/'));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const msg = err.code === 'LIMIT_FILE_SIZE' ? 'A texture is larger than 1.5 MB' : err.message;
    return res.status(413).json({ error: msg });
  }
  if (err.status) return res.status(err.status).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'Server error' });
});

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

(async () => {
  try {
    db = await connect();
    if (db) console.log('Neon connected — 3D sharing is on');
    else console.log('DATABASE_URL is not set — 3D sharing is off');
  } catch (err) {
    console.warn('Database unavailable, 3D sharing is off:', err.message);
  }
  app.listen(PORT, () => console.log(`Jewel case builder running at http://localhost:${PORT}`));
})();
