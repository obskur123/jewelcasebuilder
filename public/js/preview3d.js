import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { PARTS, SHEETS, sheetSize, panelRect } from './spec.js';
import { renderSheetToCanvas } from './render.js';

const TEX_PPI = 170;
// Standard jewel case: 142 × 125 × 10.4 mm.
const CASE = { w: 142 / 25.4, h: 125 / 25.4, t: 10.4 / 25.4 };
const LID_T = 0.06;
const BACK_T = 0.04;
const TRAYCARD_Z = -CASE.t / 2 + BACK_T + 0.006;
const TRAY_Z = TRAYCARD_Z + 0.03;
const DISC_T = 1.2 / 25.4;
const LID_MAX_ANGLE = THREE.MathUtils.degToRad(165);

const BW = PARTS.booklet.trimH;
const XW = 4.625;
const TC = PARTS.traycard;
const TC_DISC = TC.sheets.inside.disc;
const DISC_CENTER_X = TC_DISC.cx - TC.trimW / 2;
const DISC_IN_Z = TRAY_Z + 0.02 + 0.06 + DISC_T / 2;

const BG = 0xe7e2d6;

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Could not load ${src}`));
    img.src = src;
  });
}

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const clamp01 = (v) => Math.min(1, Math.max(0, v));

export const PANEL_VIEWS = {
  bk_front: { state: { lid: 0, bookletOut: 0, fold: 0, flip: 0, discOut: 0, explode: 0 }, cam: 'front' },
  bk_back: { state: { lid: 1, bookletOut: 1, fold: 0, flip: 1, discOut: 0, explode: 0 }, cam: 'booklet' },
  bk_extra_out: { state: { lid: 1, bookletOut: 1, fold: 0.5, flip: 0, discOut: 0, explode: 0 }, cam: 'booklet' },
  bk_inside_front: { state: { lid: 1, bookletOut: 1, fold: 0.5, flip: 0, discOut: 0, explode: 0 }, cam: 'booklet' },
  bk_inside_back: { state: { lid: 1, bookletOut: 1, fold: 1, flip: 0, discOut: 0, explode: 0 }, cam: 'booklet' },
  bk_extra_in: { state: { lid: 1, bookletOut: 1, fold: 1, flip: 0, discOut: 0, explode: 0 }, cam: 'booklet' },
  tc_back: { state: { lid: 0, bookletOut: 0, fold: 0, flip: 0, discOut: 0, explode: 0 }, cam: 'back' },
  tc_spine_l: { state: { lid: 0, bookletOut: 0, fold: 0, flip: 0, discOut: 0, explode: 0 }, cam: 'spineL' },
  tc_spine_r: { state: { lid: 0, bookletOut: 0, fold: 0, flip: 0, discOut: 0, explode: 0 }, cam: 'spineR' },
  tc_inside: { state: { lid: 1, bookletOut: 0, fold: 0, flip: 0, discOut: 1, explode: 1 }, cam: 'tray' },
  disc_label: { state: { lid: 1, bookletOut: 0, fold: 0, flip: 0, discOut: 1, explode: 0 }, cam: 'disc' },
};

export const PRESETS = {
  closed: { state: { lid: 0, bookletOut: 0, fold: 0, flip: 0, discOut: 0, explode: 0 }, cam: 'iso' },
  back: PANEL_VIEWS.tc_back,
  open: { state: { lid: 1, bookletOut: 0, fold: 0, flip: 0, discOut: 0, explode: 0 }, cam: 'open' },
  booklet: PANEL_VIEWS.bk_inside_back,
  disc: PANEL_VIEWS.disc_label,
  exploded: { state: { lid: 1, bookletOut: 1, fold: 0, flip: 0, discOut: 1, explode: 1 }, cam: 'exploded' },
};

export class Preview3D extends EventTarget {
  constructor(canvas, { onPick } = {}) {
    super();
    this.canvas = canvas;
    this.onPick = onPick;
    this.state = { ...PRESETS.closed.state };
    this.target = { ...PRESETS.closed.state };
    this.signatures = {};
    this.pickables = [];
    this.camTween = null;
    this.needsRender = true;
    this.active = true;

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer = renderer;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(BG);
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environmentIntensity = 0.9;
    this.scene = scene;

    const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 200);
    camera.position.set(7, 3.2, 12);
    this.camera = camera;

    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = 3;
    controls.maxDistance = 45;
    controls.autoRotateSpeed = 1.2;
    controls.addEventListener('start', () => {
      this.camTween = null;
    });
    controls.addEventListener('change', () => {
      this.needsRender = true;
    });
    this.controls = controls;

    const key = new THREE.DirectionalLight(0xffffff, 1.5);
    key.position.set(5, 9, 8);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    Object.assign(key.shadow.camera, { left: -10, right: 10, top: 10, bottom: -10, near: 1, far: 40 });
    key.shadow.radius = 4;
    key.shadow.bias = -0.0005;
    scene.add(key);
    scene.add(new THREE.AmbientLight(0xffffff, 0.25));

    const floor = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), new THREE.ShadowMaterial({ opacity: 0.16 }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -CASE.h / 2 - 0.01;
    floor.receiveShadow = true;
    scene.add(floor);

    // Canvases get their final size up front: WebGL texture storage is allocated once on first upload.
    this.textures = {};
    this.canvases = {};
    for (const s of SHEETS) {
      const size = sheetSize(s.part);
      const c = document.createElement('canvas');
      c.width = Math.round(size.w * TEX_PPI);
      c.height = Math.round(size.h * TEX_PPI);
      this.canvases[s.key] = c;
      this.textures[s.key] = this.makeTexture(c);
    }
    this.discCanvas = document.createElement('canvas');
    const discPpi = this.canvases['disc.label'].width / PARTS.disc.trimW;
    this.discCanvas.width = this.discCanvas.height = Math.round(PARTS.disc.discD * discPpi);
    this.discTexture = this.makeTexture(this.discCanvas);

    this.buildCase();
    this.buildTraycard();
    this.buildDisc();
    this.buildBooklet();
    this.applyState();

    this.raycaster = new THREE.Raycaster();
    let down = null;
    canvas.addEventListener('pointerdown', (e) => {
      down = { x: e.clientX, y: e.clientY };
    });
    canvas.addEventListener('pointerup', (e) => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return;
      this.pick(e);
    });

    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
    this.resize();
    this.clock = new THREE.Clock();
    renderer.setAnimationLoop(() => this.tick());
  }

  makeTexture(canvas) {
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    return tex;
  }

  // A printed plane that samples rect (inches, sheet coords) from a sheet texture.
  printedPlane(sheetKey, rect, w, h, { back = false, panelId = null } = {}) {
    const geo = new THREE.PlaneGeometry(w, h);
    const { part } = SHEETS.find((s) => s.key === sheetKey);
    const size = sheetSize(part);
    const u0 = rect.x / size.w;
    const u1 = (rect.x + rect.w) / size.w;
    const vt = 1 - rect.y / size.h;
    const vb = 1 - (rect.y + rect.h) / size.h;
    const uv = geo.attributes.uv;
    for (let i = 0; i < uv.count; i++) {
      uv.setXY(i, u0 + uv.getX(i) * (u1 - u0), vb + uv.getY(i) * (vt - vb));
    }
    const mat = new THREE.MeshStandardMaterial({ map: this.textures[sheetKey], roughness: 0.82, metalness: 0, envMapIntensity: 0.55 });
    const mesh = new THREE.Mesh(geo, mat);
    if (back) mesh.rotation.y = Math.PI;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    if (panelId) {
      mesh.userData.panelId = panelId;
      this.pickables.push(mesh);
    }
    return mesh;
  }

  clearMaterial() {
    return new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      metalness: 0,
      roughness: 0.04,
      transmission: 1,
      thickness: 0.05,
      ior: 1.5,
      specularIntensity: 1,
      envMapIntensity: 1.3,
    });
  }

  addBox(parent, w, h, d, x, y, z, material, edges = true) {
    const geo = new THREE.BoxGeometry(w, h, d);
    const mesh = new THREE.Mesh(geo, material);
    mesh.position.set(x, y, z);
    parent.add(mesh);
    if (edges) {
      const line = new THREE.LineSegments(
        new THREE.EdgesGeometry(geo),
        new THREE.LineBasicMaterial({ color: 0x8e979c, transparent: true, opacity: 0.55 }),
      );
      line.position.copy(mesh.position);
      parent.add(line);
    }
    return mesh;
  }

  buildCase() {
    const g = new THREE.Group();
    this.caseGroup = g;
    this.scene.add(g);
    const clear = this.clearMaterial();
    const { w, h, t } = CASE;
    const wall = 0.04;
    const baseDepth = t - LID_T - 0.01;
    const baseZ = -t / 2 + baseDepth / 2;

    this.addBox(g, w, h, BACK_T, 0, 0, -t / 2 + BACK_T / 2, clear);
    this.addBox(g, wall, h, baseDepth, -w / 2 + wall / 2, 0, baseZ, clear);
    this.addBox(g, wall, h, baseDepth, w / 2 - wall / 2, 0, baseZ, clear);
    this.addBox(g, w, wall, baseDepth, 0, h / 2 - wall / 2, baseZ, clear);
    this.addBox(g, w, wall, baseDepth, 0, -h / 2 + wall / 2, baseZ, clear);

    this.trayClear = this.clearMaterial();
    this.trayBlack = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.35, metalness: 0.1 });
    this.tray = this.addBox(g, TC.trimW - 0.55, TC.trimH - 0.04, 0.03, 0, 0, TRAY_Z, this.trayClear, false);
    const hubGeo = new THREE.CylinderGeometry(0.6, 0.64, 0.08, 64);
    hubGeo.rotateX(Math.PI / 2);
    this.hub = new THREE.Mesh(hubGeo, this.trayClear);
    this.hub.position.set(DISC_CENTER_X, 0, TRAY_Z + 0.055);
    g.add(this.hub);

    // Lid pivots on the hinge (front-left edge).
    const lid = new THREE.Group();
    lid.position.set(-w / 2, 0, t / 2);
    g.add(lid);
    this.lid = lid;
    this.addBox(lid, w, h, LID_T, w / 2, 0, -LID_T / 2, clear);
    for (const sy of [-1, 1]) this.addBox(lid, w - 0.3, 0.05, 0.12, w / 2 + 0.1, sy * (h / 2 - 0.025), -LID_T - 0.06, clear);
  }

  buildTraycard() {
    const g = new THREE.Group();
    this.caseGroup.add(g);
    const out = 'traycard.outside';
    const ins = 'traycard.inside';
    const b = TC.bleed;
    const backW = 5.4;

    const back = this.printedPlane(out, panelRect('tc_back'), backW, TC.trimH, { back: true, panelId: 'tc_back' });
    back.position.z = TRAYCARD_Z;
    g.add(back);

    const insideRect = { x: b + 0.25, y: b, w: backW, h: TC.trimH };
    const inside = this.printedPlane(ins, insideRect, backW, TC.trimH, { panelId: 'tc_inside' });
    inside.position.z = TRAYCARD_Z + 0.002;
    g.add(inside);

    const spineDepth = 0.25;
    const spineL = this.printedPlane(out, panelRect('tc_spine_l'), spineDepth, TC.trimH, { panelId: 'tc_spine_l' });
    spineL.rotation.y = Math.PI / 2;
    spineL.position.set(backW / 2, 0, TRAYCARD_Z + spineDepth / 2);
    g.add(spineL);
    const spineR = this.printedPlane(out, panelRect('tc_spine_r'), spineDepth, TC.trimH, { panelId: 'tc_spine_r' });
    spineR.rotation.y = -Math.PI / 2;
    spineR.position.set(-backW / 2, 0, TRAYCARD_Z + spineDepth / 2);
    g.add(spineR);

    const paper = new THREE.MeshStandardMaterial({ color: 0xf4f2ee, roughness: 0.8, side: THREE.DoubleSide });
    for (const sx of [-1, 1]) {
      const inner = new THREE.Mesh(new THREE.PlaneGeometry(spineDepth, TC.trimH), paper);
      inner.rotation.y = Math.PI / 2;
      inner.position.set(sx * (backW / 2 - 0.002), 0, TRAYCARD_Z + spineDepth / 2);
      g.add(inner);
    }
  }

  buildDisc() {
    const d = PARTS.disc;
    const R = d.discD / 2;
    const r = d.hole / 2;
    const g = new THREE.Group();
    this.disc = g;
    this.scene.add(g);

    const top = new THREE.Mesh(
      new THREE.RingGeometry(r, R, 128, 1),
      new THREE.MeshStandardMaterial({ map: this.discTexture, roughness: 0.42, metalness: 0.05 }),
    );
    top.position.z = DISC_T / 2;
    top.userData.panelId = 'disc_label';
    top.castShadow = true;
    this.pickables.push(top);
    g.add(top);

    const bottom = new THREE.Mesh(
      new THREE.RingGeometry(r, R, 128, 1),
      new THREE.MeshPhysicalMaterial({
        color: 0xe8e8ea,
        metalness: 1,
        roughness: 0.12,
        iridescence: 1,
        iridescenceIOR: 1.7,
        iridescenceThicknessRange: [250, 650],
      }),
    );
    bottom.rotation.y = Math.PI;
    bottom.position.z = -DISC_T / 2;
    g.add(bottom);

    const rim = new THREE.MeshStandardMaterial({ color: 0xc9cdd1, metalness: 0.6, roughness: 0.3 });
    for (const [radius, side] of [
      [R, THREE.FrontSide],
      [r, THREE.BackSide],
    ]) {
      const edge = new THREE.CylinderGeometry(radius, radius, DISC_T, 128, 1, true);
      edge.rotateX(Math.PI / 2);
      const m = new THREE.Mesh(edge, rim.clone());
      m.material.side = side;
      g.add(m);
    }
  }

  buildBooklet() {
    const out = 'booklet.outside';
    const ins = 'booklet.inside';
    const g = new THREE.Group();
    this.booklet = g;
    this.scene.add(g);

    const face = (sheetKey, panelId, w, back) => this.printedPlane(sheetKey, panelRect(panelId), w, BW, { back, panelId });
    const gap = 0.0007;

    const backPanel = new THREE.Group();
    g.add(backPanel);
    const ib = face(ins, 'bk_inside_back', BW, false);
    ib.position.z = gap;
    const bc = face(out, 'bk_back', BW, true);
    bc.position.z = -gap;
    backPanel.add(ib, bc);

    this.frontPivot = new THREE.Group();
    this.frontPivot.position.set(-BW / 2, 0, 0.014);
    g.add(this.frontPivot);
    const ifc = face(ins, 'bk_inside_front', BW, false);
    ifc.position.set(-BW / 2, 0, gap);
    const fc = face(out, 'bk_front', BW, true);
    fc.position.set(-BW / 2, 0, -gap);
    this.frontPivot.add(ifc, fc);

    this.extraPivot = new THREE.Group();
    this.extraPivot.position.set(BW / 2, 0, 0.007);
    g.add(this.extraPivot);
    const xin = face(ins, 'bk_extra_in', XW, false);
    xin.position.set(XW / 2, 0, gap);
    const xout = face(out, 'bk_extra_out', XW, true);
    xout.position.set(XW / 2, 0, -gap);
    this.extraPivot.add(xin, xout);
  }

  // ---------- textures ----------

  updateTextures(project, force = false) {
    for (const s of SHEETS) {
      const sig = JSON.stringify([project.sheets[s.key], s.sheet.panels.map((p) => project.panels[p.id])]);
      if (!force && this.signatures[s.key] === sig) continue;
      this.signatures[s.key] = sig;
      const c = this.canvases[s.key];
      const [w0, h0] = [c.width, c.height];
      renderSheetToCanvas(project, s.key, { ppi: TEX_PPI, canvas: c });
      if (c.width !== w0 || c.height !== h0) this.textures[s.key].dispose();
      this.textures[s.key].needsUpdate = true;
      if (s.key === 'disc.label') this.composeDisc();
    }
    this.needsRender = true;
  }

  async applySheetImages(urls) {
    await Promise.all(
      SHEETS.map(async (s) => {
        const src = urls[s.key];
        if (!src) return;
        const img = await loadImage(src);
        const c = this.canvases[s.key];
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        this.textures[s.key].needsUpdate = true;
        if (s.key === 'disc.label') this.composeDisc();
      }),
    );
    this.needsRender = true;
  }

  composeDisc() {
    const d = PARTS.disc;
    const src = this.canvases['disc.label'];
    const ppi = src.width / d.trimW;
    const c = this.discCanvas;
    const size = c.width;
    const ctx = c.getContext('2d');
    const mid = size / 2;
    ctx.fillStyle = '#cfd3d7';
    ctx.fillRect(0, 0, size, size);
    ctx.save();
    ctx.beginPath();
    ctx.arc(mid, mid, (d.printOuter / 2) * ppi, 0, Math.PI * 2);
    ctx.arc(mid, mid, (d.printInner / 2) * ppi, 0, Math.PI * 2, true);
    ctx.clip();
    const off = ((d.trimW - d.discD) / 2) * ppi;
    ctx.drawImage(src, -off, -off);
    ctx.restore();
    ctx.fillStyle = 'rgba(225,230,233,1)';
    ctx.beginPath();
    ctx.arc(mid, mid, (d.printInner / 2) * ppi, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(150,155,160,0.6)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(mid, mid, (d.mirrorBand / 2) * ppi * 0.72, 0, Math.PI * 2);
    ctx.stroke();
    this.discTexture.needsUpdate = true;
  }

  setTrayColor(color) {
    const m = color === 'black' ? this.trayBlack : this.trayClear;
    this.tray.material = m;
    this.hub.material = m;
    this.needsRender = true;
  }

  // ---------- state + animation ----------

  setState(partial) {
    Object.assign(this.target, partial);
    this.dispatchEvent(new CustomEvent('state', { detail: { ...this.target } }));
    this.needsRender = true;
  }

  applyView(view) {
    if (!view) return;
    this.setState(view.state);
    this.flyTo(view.cam);
  }

  setAutoRotate(on) {
    this.controls.autoRotate = on;
  }

  bookletOutPose(s) {
    const center = new THREE.Vector3(0, 0.15, 2.4);
    const side = new THREE.Vector3(-3.6, 0.15, 2.0);
    return center.lerp(side, s.explode);
  }

  discOutPose(s) {
    const center = new THREE.Vector3(DISC_CENTER_X, 0.1, 1.9);
    const side = new THREE.Vector3(4.2, 0.1, 1.6);
    return center.lerp(side, s.explode);
  }

  applyState() {
    const s = this.state;
    this.lid.rotation.y = -ease(s.lid) * LID_MAX_ANGLE;
    this.lid.updateMatrixWorld(true);

    const f1 = ease(clamp01(s.fold * 2));
    const f2 = ease(clamp01(s.fold * 2 - 1));
    this.frontPivot.rotation.y = Math.PI * (1 - f1);
    this.extraPivot.rotation.y = -Math.PI * (1 - f2);

    // Booklet: blend between its seat under the lid and a floating pose in front of the case.
    const seat = new THREE.Object3D();
    seat.position.set(CASE.w / 2 + 0.06, 0, -LID_T - 0.03);
    this.lid.add(seat);
    seat.updateMatrixWorld(true);
    const inPos = new THREE.Vector3();
    const inQuat = new THREE.Quaternion();
    seat.matrixWorld.decompose(inPos, inQuat, new THREE.Vector3());
    this.lid.remove(seat);

    const t = ease(s.bookletOut);
    const outPos = this.bookletOutPose(s);
    const outQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), ease(s.flip) * Math.PI);
    this.booklet.position.lerpVectors(inPos, outPos, t);
    this.booklet.position.z += Math.sin(Math.PI * t) * 1.2;
    this.booklet.quaternion.slerpQuaternions(inQuat, outQuat, t);

    const dt = ease(s.discOut);
    const discIn = new THREE.Vector3(DISC_CENTER_X, 0, DISC_IN_Z);
    this.disc.position.lerpVectors(discIn, this.discOutPose(s), dt);
    this.disc.position.z += Math.sin(Math.PI * dt) * 0.8;
    this.disc.rotation.z = dt * s.explode * 0.6;
  }

  tick() {
    const dt = Math.min(this.clock.getDelta(), 0.05);
    let moving = false;
    const k = 1 - Math.exp(-dt * 5.5);
    for (const key of Object.keys(this.target)) {
      const diff = this.target[key] - this.state[key];
      if (Math.abs(diff) > 0.0005) {
        this.state[key] += diff * k;
        moving = true;
      } else if (this.state[key] !== this.target[key]) {
        this.state[key] = this.target[key];
        moving = true;
      }
    }
    if (moving) this.applyState();
    // Hidden: keep the model in sync, but leave camera moves pending until there's a real viewport to frame.
    if (!this.active) return;

    if (this.camTween) {
      const tw = this.camTween;
      tw.t = Math.min(1, tw.t + dt / tw.duration);
      const e = ease(tw.t);
      const goal = tw.goal();
      this.camera.position.lerpVectors(tw.fromPos, goal.pos, e);
      this.controls.target.lerpVectors(tw.fromTarget, goal.target, e);
      if (tw.t >= 1) this.camTween = null;
      moving = true;
    }

    const controlsChanged = this.controls.update(dt);
    if (moving || controlsChanged || this.needsRender || this.controls.autoRotate) {
      this.renderer.render(this.scene, this.camera);
      this.needsRender = false;
    }
  }

  fitDistance(width, height) {
    const vfov = THREE.MathUtils.degToRad(this.camera.fov);
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * this.camera.aspect);
    return Math.max(width / 2 / Math.tan(hfov / 2), height / 2 / Math.tan(vfov / 2)) * 1.18;
  }

  cameraGoal(name) {
    const s = this.target;
    const dir = (x, y, z) => new THREE.Vector3(x, y, z).normalize();
    let target = new THREE.Vector3();
    let direction = dir(0.45, 0.25, 1);
    let dist = this.fitDistance(CASE.w * 1.3, CASE.h * 1.3);
    switch (name) {
      case 'front':
        direction = dir(0.12, 0.08, 1);
        break;
      case 'back':
        direction = dir(-0.12, 0.1, -1);
        break;
      case 'spineL':
        direction = dir(1, 0.12, 0.2);
        dist = this.fitDistance(CASE.t * 4, CASE.h * 1.25);
        break;
      case 'spineR':
        direction = dir(-1, 0.12, 0.2);
        dist = this.fitDistance(CASE.t * 4, CASE.h * 1.25);
        break;
      case 'open':
        target = new THREE.Vector3(-2.6, 0, 0.4);
        direction = dir(0.1, 0.25, 1);
        dist = this.fitDistance(CASE.w * 2.3, CASE.h * 1.4);
        break;
      case 'tray':
        target = new THREE.Vector3(0.8, 0, 0.2);
        direction = dir(0.05, 0.1, 1);
        dist = this.fitDistance(CASE.w * 2.4, CASE.h * 1.4);
        break;
      case 'booklet': {
        // Horizontal extent of the booklet (local x) for closed, half-open and fully open states.
        const [min, max] = s.fold <= 0.01 ? [-BW / 2, BW / 2] : s.fold <= 0.5 ? [-1.5 * BW, BW / 2] : [-1.5 * BW, BW / 2 + XW];
        const spread = max - min;
        const mid = ((min + max) / 2) * (s.flip > 0.5 ? -1 : 1);
        target = this.bookletOutPose(s);
        target.x += mid;
        direction = dir(0.05, 0.12, 1);
        dist = this.fitDistance(spread, BW * 1.1);
        break;
      }
      case 'disc':
        target = this.discOutPose(s);
        direction = dir(0.1, 0.15, 1);
        dist = this.fitDistance(PARTS.disc.discD * 1.3, PARTS.disc.discD * 1.3);
        break;
      case 'exploded':
        target = new THREE.Vector3(-0.6, 0, 0.8);
        direction = dir(0.35, 0.35, 1);
        dist = this.fitDistance(CASE.w * 3.6, CASE.h * 1.6);
        break;
      default:
        break;
    }
    return { target, pos: target.clone().add(direction.multiplyScalar(dist)) };
  }

  flyTo(name, duration = 0.9) {
    this.camTween = {
      t: 0,
      duration,
      fromPos: this.camera.position.clone(),
      fromTarget: this.controls.target.clone(),
      goal: () => this.cameraGoal(name),
    };
  }

  pick(e) {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.intersectObjects(this.pickables, false)[0];
    if (hit && this.onPick) this.onPick(hit.object.userData.panelId);
  }

  resize() {
    const parent = this.canvas.parentElement;
    const w = parent.clientWidth;
    const h = parent.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.needsRender = true;
  }

  setActive(on) {
    this.active = on;
    if (!on) return;
    this.clock.getDelta();
    this.resize();
    this.needsRender = true;
  }

  /** PNG data URL of the current view. Pass `width` for a fixed-size image (works while hidden). */
  snapshot({ width } = {}) {
    const r = this.renderer;
    const prev = { size: r.getSize(new THREE.Vector2()), ratio: r.getPixelRatio(), aspect: this.camera.aspect };
    if (width) {
      const height = Math.round(width / (this.active ? prev.aspect : 4 / 3));
      r.setPixelRatio(1);
      r.setSize(width, height, false);
      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();
    }
    if (this.camTween) {
      const goal = this.camTween.goal();
      this.camera.position.copy(goal.pos);
      this.controls.target.copy(goal.target);
      this.camTween = null;
      this.controls.update();
    }
    r.render(this.scene, this.camera);
    const url = this.canvas.toDataURL('image/png');
    if (width) {
      r.setPixelRatio(prev.ratio);
      r.setSize(prev.size.x, prev.size.y, false);
      this.camera.aspect = prev.aspect;
      this.camera.updateProjectionMatrix();
      this.needsRender = true;
    }
    return url;
  }
}
