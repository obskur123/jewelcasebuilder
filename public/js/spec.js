// All measurements are in inches, taken from the Disc Makers CD600 / CDT100 / UD100 templates.
const MM = 1 / 25.4;

export const PARTS = {
  booklet: {
    name: '6 Page Folder',
    code: 'CD600',
    trimW: 14.125,
    trimH: 4.75,
    bleed: 0.125,
    safety: 0.125,
    templatePage: { w: 15.625, h: 6.25 },
    sheets: {
      outside: {
        name: 'Outside',
        uploadLabel: 'front',
        folds: [4.625, 9.375],
        panels: [
          { id: 'bk_extra_out', name: 'Extra Panel (folds in)', x: 0, w: 4.625, page: 3 },
          { id: 'bk_back', name: 'Back Cover', x: 4.625, w: 4.75, page: 6 },
          { id: 'bk_front', name: 'Front Cover', x: 9.375, w: 4.75, page: 1 },
        ],
      },
      inside: {
        name: 'Inside',
        uploadLabel: 'back',
        folds: [4.75, 9.5],
        panels: [
          { id: 'bk_inside_front', name: 'Inside Front Cover', x: 0, w: 4.75, page: 2 },
          { id: 'bk_inside_back', name: 'Inside Back Cover', x: 4.75, w: 4.75, page: 4 },
          { id: 'bk_extra_in', name: 'Extra Panel (inside)', x: 9.5, w: 4.625, page: 5 },
        ],
      },
    },
  },
  traycard: {
    name: 'Traycard',
    code: 'CDT100',
    trimW: 5.9,
    trimH: 4.625,
    bleed: 0.125,
    safety: 0.125,
    templatePage: { w: 7.41, h: 6.13 },
    sheets: {
      outside: {
        name: 'Outside',
        uploadLabel: 'front',
        folds: [0.25, 5.65],
        panels: [
          { id: 'tc_spine_l', name: 'Left Spine', x: 0, w: 0.25, safety: 0.05, spine: -90 },
          { id: 'tc_back', name: 'Back (Tracklist)', x: 0.25, w: 5.4 },
          { id: 'tc_spine_r', name: 'Right Spine', x: 5.65, w: 0.25, safety: 0.05, spine: 90 },
        ],
      },
      inside: {
        name: 'Inside',
        uploadLabel: 'back',
        folds: [0.25, 5.65],
        disc: { cx: 3.138, cy: 2.3125, r: 2.362, hub: 0.625, hole: 0.205 },
        spineWindow: { x: 0.25, w: 0.38 },
        panels: [{ id: 'tc_inside', name: 'Inside Tray', x: 0, w: 5.9 }],
      },
    },
  },
  disc: {
    name: 'Disc',
    code: 'UD100',
    trimW: 4.8,
    trimH: 4.8,
    bleed: 0,
    safety: 0,
    round: true,
    templatePage: { w: 7.3228, h: 7.3228 },
    discD: 120 * MM,
    printOuter: 116 * MM,
    printInner: 24 * MM,
    safeOuter: 112 * MM,
    safeInner: 30 * MM,
    mirrorBand: 46 * MM,
    hole: 15 * MM,
    sheets: {
      label: {
        name: 'Label',
        uploadLabel: 'label',
        folds: [],
        panels: [{ id: 'disc_label', name: 'Disc Label', x: 0, w: 4.8 }],
      },
    },
  },
};

export const SHEETS = [];
export const PANELS = {};
for (const [partKey, part] of Object.entries(PARTS)) {
  for (const [sheetKey, sheet] of Object.entries(part.sheets)) {
    const key = `${partKey}.${sheetKey}`;
    SHEETS.push({ key, partKey, sheetKey, part, sheet });
    for (const p of sheet.panels) PANELS[p.id] = { ...p, partKey, sheetKey, sheetId: key, part, sheet };
  }
}

export const sheetInfo = (key) => SHEETS.find((s) => s.key === key);

export function sheetSize(part) {
  return { w: part.trimW + 2 * part.bleed, h: part.trimH + 2 * part.bleed };
}

// Panel rectangle in sheet coordinates (origin = top-left of the bleed area).
export function panelRect(panelId, { bleed = false } = {}) {
  const p = PANELS[panelId];
  const { part } = p;
  const r = { x: part.bleed + p.x, y: part.bleed, w: p.w, h: part.trimH };
  if (!bleed) return r;
  const atLeft = p.x <= 1e-6;
  const atRight = Math.abs(p.x + p.w - part.trimW) < 1e-6;
  return {
    x: r.x - (atLeft ? part.bleed : 0),
    y: 0,
    w: r.w + (atLeft ? part.bleed : 0) + (atRight ? part.bleed : 0),
    h: part.trimH + 2 * part.bleed,
  };
}

export function safeRect(panelId) {
  const p = PANELS[panelId];
  const s = p.safety ?? p.part.safety;
  const r = panelRect(panelId);
  return { x: r.x + s, y: r.y + s, w: r.w - 2 * s, h: r.h - 2 * s };
}

export function bleedEdges(panelId) {
  const p = PANELS[panelId];
  if (!p.part.bleed) return [];
  const edges = ['top', 'bottom'];
  if (p.x <= 1e-6) edges.unshift('left');
  if (Math.abs(p.x + p.w - p.part.trimW) < 1e-6) edges.push('right');
  return edges;
}

export const SWAP_GROUPS = {
  booklet: ['bk_extra_out', 'bk_back', 'bk_front', 'bk_inside_front', 'bk_inside_back', 'bk_extra_in'],
};

export const FONTS = [
  'Inter',
  'Archivo Black',
  'Anton',
  'Bebas Neue',
  'Rubik Mono One',
  'Playfair Display',
  'IBM Plex Serif',
  'Space Mono',
  'Special Elite',
  'Permanent Marker',
  'Caveat',
  'UnifrakturMaguntia',
];
