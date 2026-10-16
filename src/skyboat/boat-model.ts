import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  CylinderGeometry,
  DoubleSide,
  Group,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  MeshStandardMaterial,
  OctahedronGeometry,
  PlaneGeometry,
  Quaternion,
  RepeatWrapping,
  Shape,
  ShapeGeometry,
  SphereGeometry,
  SRGBColorSpace,
  TorusGeometry,
  Vector3,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { mergeColored } from '../core/merge';
import { smoothstep } from '../core/math';
import { makeLabel } from '../ui/text';

/**
 * The skyboat, in its own frame: deck surface at y = 0, bow toward -Z, stern +Z,
 * starboard +X. Everything here is geometry; ./skyboat.ts brings it to life.
 */
export const HULL = {
  length: 6.4,
  /** Half-beam (m) at a point along the hull, t = 0 at the bow to 1 at the stern. */
  halfBeam(t: number): number {
    const fore = 1.3 * Math.pow(Math.sin(Math.min(1, t * 1.75) * (Math.PI / 2)), 0.75);
    return t > 0.78 ? fore - (t - 0.78) * 1.25 : fore;
  },
  /** Keel depth below the deck. */
  depth(t: number): number {
    return 0.55 + 0.5 * smoothstep(0, 0.4, t) - 0.22 * smoothstep(0.75, 1, t);
  },
  /** Height of the hull side above the deck (it rises toward the bow). */
  bulwark(t: number): number {
    return 0.22 + 0.32 * Math.pow(1 - t, 2.2);
  },
  zAt(t: number): number {
    return -HULL.length / 2 + t * HULL.length;
  },
  tAt(z: number): number {
    return (z + HULL.length / 2) / HULL.length;
  },
};

/** The boarding gate: a gap in the starboard rail and a notch in the bulwark (hull fractions). */
export const GATE = { t0: 0.545, t1: 0.735 };

/** Bulwark height on one side; at the starboard gate it dips to the deck. */
export function bulwarkAt(t: number, side: number): number {
  const h = HULL.bulwark(t);
  if (side < 0) return h;
  const notch = smoothstep(GATE.t0 - 0.022, GATE.t0, t) * (1 - smoothstep(GATE.t1, GATE.t1 + 0.022, t));
  return h + (0.012 - h) * notch;
}

/** Where the controls are (boat frame). The pilot stands at z ≈ 2.55, facing the bow. */
export const HELM = {
  wheelCenter: new Vector3(0, 1.0, 1.95),
  wheelRadius: 0.34,
  /** Throttle lever (starboard, right hand): pivot of the rod. */
  throttlePivot: new Vector3(0.56, 0.9, 2.25),
  leverLength: 0.27,
  /** Lift handle (port, left hand): it slides up and down a post on this pedestal. */
  liftBase: new Vector3(-0.56, 0.9, 2.25),
  liftRest: 0.26,
  liftTravel: 0.12,
  gauge: new Vector3(0, 1.48, 1.57),
  binnacleZ: 1.6,
  pilotSpot: new Vector3(0, 0, 2.55),
};

/** The envelope (balloon) ellipsoid. */
export const ENVELOPE = { center: new Vector3(0, 4.35, -0.1), radii: new Vector3(1.85, 1.45, 3.5) };

export interface BoatParts {
  root: Group;
  wheel: Group;
  throttle: Group;
  liftHandle: Group;
  propeller: Mesh;
  gaugeCanvas: HTMLCanvasElement;
  gaugeTexture: CanvasTexture;
  lampMaterial: MeshBasicMaterial;
  crystalMaterial: MeshBasicMaterial;
  pennant: Mesh;
  /** Things that move or glow (kept out of the static merge). */
  live: Set<object>;
}

function plankTexture(): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 256;
  const g = c.getContext('2d')!;
  const plank = 64;
  for (let i = 0; i < 4; i++) {
    const shade = [0xc89f74, 0xbf956a, 0xcaa47a, 0xb98f64][i];
    g.fillStyle = `#${shade.toString(16)}`;
    g.fillRect(i * plank, 0, plank, 256);
    g.fillStyle = 'rgba(70,45,25,0.55)';
    g.fillRect(i * plank, 0, 3, 256);
    // Butt joints and nail heads.
    const joint = (i * 97) % 256;
    g.fillRect(i * plank, joint, plank, 3);
    g.fillStyle = 'rgba(50,35,25,0.6)';
    for (const y of [joint + 9, joint - 9]) {
      g.beginPath();
      g.arc(i * plank + 12, (y + 256) % 256, 2.2, 0, Math.PI * 2);
      g.arc(i * plank + plank - 12, (y + 256) % 256, 2.2, 0, Math.PI * 2);
      g.fill();
    }
  }
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.wrapS = t.wrapT = RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

const STATIONS = 40;
const LOWER = 9; // points on the rounded bottom, from the deck line to the keel

/** One side's profile at hull fraction t: from the bulwark top down to the keel. */
function profile(t: number, side: number): { p: Vector3; band: number }[] {
  const b = HULL.halfBeam(t);
  const d = HULL.depth(t);
  const top = bulwarkAt(t, side);
  const z = HULL.zAt(t);
  const pts: { p: Vector3; band: number }[] = [];
  pts.push({ p: new Vector3(b * side, top, z), band: 0 });
  pts.push({ p: new Vector3(b * side, top * 0.45, z), band: 1 });
  pts.push({ p: new Vector3(b * side, 0, z), band: 1 });
  for (let k = 1; k <= LOWER; k++) {
    const th = (k / LOWER) * (Math.PI / 2);
    pts.push({ p: new Vector3(b * Math.cos(th) * side, -d * Math.pow(Math.sin(th), 0.9), z), band: 2 + (k % 2) });
  }
  return pts;
}

/** Lofted hull: stations along the length, each a bulwark plus a rounded bottom. */
function hullGeometry(): BufferGeometry {
  const colors = [new Color(0xe9dcc4), new Color(0x58b8ff), new Color(0x7a4a2c), new Color(0x6a3f25)];
  const pos: number[] = [];
  const col: number[] = [];
  const put = (v: { p: Vector3; band: number }) => {
    pos.push(v.p.x, v.p.y, v.p.z);
    const c = colors[v.band];
    col.push(c.r, c.g, c.b);
  };
  const transomCenter = { p: new Vector3(0, HULL.bulwark(1) * 0.4, HULL.zAt(1)), band: 3 };
  for (const side of [1, -1]) {
    const stations: { p: Vector3; band: number }[][] = [];
    for (let i = 0; i <= STATIONS; i++) stations.push(profile(i / STATIONS, side));
    for (let i = 0; i < STATIONS; i++) {
      const s0 = stations[i];
      const s1 = stations[i + 1];
      for (let k = 0; k < s0.length - 1; k++) {
        // Counter-clockwise seen from outside this side.
        const quad = side > 0 ? [s0[k], s1[k], s0[k + 1], s0[k + 1], s1[k], s1[k + 1]] : [s0[k], s0[k + 1], s1[k], s0[k + 1], s1[k + 1], s1[k]];
        quad.forEach(put);
      }
    }
    // Transom: fan this side's stern profile around a point on the centre line.
    const st = stations[STATIONS];
    for (let k = 0; k < st.length - 1; k++) (side > 0 ? [transomCenter, st[k + 1], st[k]] : [transomCenter, st[k], st[k + 1]]).forEach(put);
  }
  // Close the top of the transom between the two bulwark tops.
  [transomCenter, profile(1, 1)[0], profile(1, -1)[0]].forEach(put);
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('color', new BufferAttribute(new Float32Array(col), 3));
  g.computeVertexNormals();
  return g;
}

/** Points for the walkable hull collider: everything at or below the deck. */
export function hullBelowDeckPoints(): Float32Array {
  const out: number[] = [];
  for (let i = 0; i <= 16; i++) {
    for (const side of [1, -1]) {
      for (const v of profile(i / 16, side)) if (v.p.y <= 1e-6) out.push(v.p.x, v.p.y, v.p.z);
    }
  }
  return new Float32Array(out);
}

/** Points for the boat's own collision volume when it flies: the hull up to its rail tops. */
export function hullSweepPoints(): Float32Array {
  const out: number[] = [];
  for (let i = 0; i <= 16; i++) {
    const t = i / 16;
    for (const side of [1, -1]) {
      for (const v of profile(t, side)) if (v.p.y <= 1e-6) out.push(v.p.x, v.p.y, v.p.z);
      out.push(HULL.halfBeam(t) * side, Math.max(HULL.bulwark(t), 0.95), HULL.zAt(t));
    }
  }
  return new Float32Array(out);
}

/** Points on the envelope ellipsoid, for its collider. */
export function envelopePoints(): Float32Array {
  const g = new SphereGeometry(1, 16, 10);
  const p = g.getAttribute('position');
  const out = new Float32Array(p.count * 3);
  const { center: c, radii: r } = ENVELOPE;
  for (let i = 0; i < p.count; i++) out.set([c.x + p.getX(i) * r.x, c.y + p.getY(i) * r.y, c.z + p.getZ(i) * r.z], i * 3);
  g.dispose();
  return out;
}

function deckOutline(): Shape {
  const s = new Shape();
  const N = 48;
  // Shape coordinates are (x, -z): ShapeGeometry is rotated onto the XZ plane below.
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const x = HULL.halfBeam(t) - 0.02;
    if (i === 0) s.moveTo(x, -HULL.zAt(t));
    else s.lineTo(x, -HULL.zAt(t));
  }
  for (let i = N; i >= 0; i--) {
    const t = i / N;
    s.lineTo(-(HULL.halfBeam(t) - 0.02), -HULL.zAt(t));
  }
  s.closePath();
  return s;
}

function flat(points: [number, number][]): ShapeGeometry {
  const s = new Shape();
  points.forEach(([x, y], i) => (i ? s.lineTo(x, y) : s.moveTo(x, y)));
  s.closePath();
  return new ShapeGeometry(s);
}

export function buildBoat(): BoatParts {
  const root = new Group();
  root.name = 'skyboat';
  const live = new Set<object>();
  const wood = new MeshLambertMaterial({ color: 0x8a5a36 });
  const woodDark = new MeshLambertMaterial({ color: 0x5e3b22 });
  const brass = new MeshStandardMaterial({ color: 0xd4af37, roughness: 0.3, metalness: 0.85 });
  const up = new Vector3(0, 1, 0);

  // ---- Hull and deck ----
  const hull = new Mesh(hullGeometry(), new MeshLambertMaterial({ vertexColors: true, side: DoubleSide }));
  hull.castShadow = hull.receiveShadow = true;
  hull.name = 'hull';
  const planks = plankTexture();
  planks.repeat.set(1 / 0.72, 1 / 1.8);
  const deck = new Mesh(new ShapeGeometry(deckOutline(), 2), new MeshLambertMaterial({ map: planks }));
  deck.rotation.x = -Math.PI / 2;
  deck.position.y = 0.002;
  deck.receiveShadow = true;
  deck.name = 'deck';
  root.add(hull, deck);

  // ---- Rails: gold trim on the bulwark tops, posts and a waist-high rail ----
  const parts: { geometry: BufferGeometry; matrix: Matrix4; color: number }[] = [];
  const seg = (a: Vector3, b: Vector3, r: number, color: number) => {
    const d = new Vector3().subVectors(b, a);
    const len = d.length();
    const m = new Matrix4().compose(a.clone().addScaledVector(d, 0.5), new Quaternion().setFromUnitVectors(up, d.normalize()), new Vector3(1, 1, 1));
    parts.push({ geometry: new CylinderGeometry(r, r, len, 6), matrix: m, color });
  };
  const RAIL_Y = 0.92;
  for (const side of [1, -1]) {
    // Gold trim follows the bulwark top, including the dip at the gate.
    let prev: Vector3 | null = null;
    for (let i = 0; i <= 40; i++) {
      const t = 0.06 + (i / 40) * 0.94;
      const p = new Vector3((HULL.halfBeam(t) - 0.01) * side, bulwarkAt(t, side) + 0.01, HULL.zAt(t));
      if (prev) seg(prev, p, 0.018, 0xd4af37);
      prev = p;
    }
    // Waist rail and posts; the starboard rail stops at the gate posts.
    const ts: number[] = [];
    for (let i = 0; i <= 12; i++) ts.push(0.1 + (i / 12) * 0.9);
    const stops = side > 0 ? [...ts.filter((t) => t < GATE.t0 - 0.03 || t > GATE.t1 + 0.03), GATE.t0, GATE.t1].sort((a, b) => a - b) : ts;
    let prevRail: Vector3 | null = null;
    let prevT = 0;
    stops.forEach((t, i) => {
      const x = (HULL.halfBeam(t) - 0.04) * side;
      const z = HULL.zAt(t);
      const rail = new Vector3(x, RAIL_Y, z);
      const gatePost = side > 0 && (t === GATE.t0 || t === GATE.t1);
      if (prevRail && !(side > 0 && prevT === GATE.t0 && t === GATE.t1)) seg(prevRail, rail, 0.018, 0x8a5a36);
      if (gatePost || i % 2 === 0) seg(new Vector3(x, bulwarkAt(t, side), z), rail, gatePost ? 0.026 : 0.016, gatePost ? 0x8a5a36 : 0x6e4a2e);
      prevRail = rail;
      prevT = t;
    });
  }
  // Stern rail across the transom.
  const sb = HULL.halfBeam(1) - 0.04;
  seg(new Vector3(-sb, RAIL_Y, HULL.zAt(1)), new Vector3(sb, RAIL_Y, HULL.zAt(1)), 0.018, 0x8a5a36);
  for (const x of [-sb, -sb / 3, sb / 3, sb]) seg(new Vector3(x, HULL.bulwark(1), HULL.zAt(1)), new Vector3(x, RAIL_Y, HULL.zAt(1)), 0.016, 0x6e4a2e);
  for (const t of [GATE.t0, GATE.t1]) {
    parts.push({ geometry: new SphereGeometry(0.035, 10, 8), matrix: new Matrix4().makeTranslation(HULL.halfBeam(t) - 0.04, RAIL_Y + 0.02, HULL.zAt(t)), color: 0xd4af37 });
  }
  // Flagpole at the bow, which also carries the bow lantern.
  const poleZ = HULL.zAt(0.07);
  seg(new Vector3(0, HULL.bulwark(0.07) - 0.05, poleZ), new Vector3(0, 1.78, poleZ), 0.02, 0x5e3b22);
  seg(new Vector3(0, 1.1, poleZ), new Vector3(0, 1.1, poleZ - 0.12), 0.01, 0x2b2d42);
  const rails = new Mesh(mergeColored(parts), new MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.3 }));
  rails.castShadow = true;
  root.add(rails);

  // ---- Helm: binnacle, wheel, levers, gauge ----
  const bz = HELM.binnacleZ;
  const binnacle = new Mesh(new BoxGeometry(0.26, 1.28, 0.26), wood);
  binnacle.position.set(0, 0.64, bz);
  binnacle.castShadow = true;
  const binCap = new Mesh(new BoxGeometry(0.3, 0.04, 0.3), brass);
  binCap.position.set(0, 1.29, bz);
  const axleLen = HELM.wheelCenter.z - (bz + 0.13);
  const axle = new Mesh(new CylinderGeometry(0.025, 0.025, axleLen, 10), brass);
  axle.rotation.x = Math.PI / 2;
  axle.position.set(0, HELM.wheelCenter.y, bz + 0.13 + axleLen / 2);
  root.add(binnacle, binCap, axle);

  const wheel = new Group();
  wheel.name = 'helm-wheel';
  wheel.position.copy(HELM.wheelCenter);
  const wheelParts: { geometry: BufferGeometry; matrix: Matrix4; color: number }[] = [];
  wheelParts.push({ geometry: new TorusGeometry(HELM.wheelRadius, 0.022, 10, 48), matrix: new Matrix4(), color: 0x8a5a36 });
  wheelParts.push({ geometry: new TorusGeometry(HELM.wheelRadius * 0.45, 0.014, 8, 28), matrix: new Matrix4(), color: 0xd4af37 });
  wheelParts.push({ geometry: new CylinderGeometry(0.06, 0.06, 0.08, 16), matrix: new Matrix4().makeRotationX(Math.PI / 2), color: 0xd4af37 });
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + Math.PI / 2; // spoke 0 points up: the king spoke
    const dir = new Vector3(Math.cos(a), Math.sin(a), 0);
    const spoke = new Matrix4().compose(dir.clone().multiplyScalar(0.2), new Quaternion().setFromUnitVectors(up, dir), new Vector3(1, 1, 1));
    wheelParts.push({ geometry: new CylinderGeometry(0.012, 0.016, 0.4, 8), matrix: spoke, color: 0x7a4a2c });
    const handle = new Matrix4().compose(dir.clone().multiplyScalar(HELM.wheelRadius + 0.075), new Quaternion().setFromUnitVectors(up, dir), new Vector3(1, 1, 1));
    wheelParts.push({ geometry: new CylinderGeometry(0.017, 0.012, 0.13, 10), matrix: handle, color: i === 0 ? 0xd4af37 : 0x6b3f22 });
  }
  const wheelMesh = new Mesh(mergeColored(wheelParts), new MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.2 }));
  wheelMesh.castShadow = true;
  wheel.add(wheelMesh);
  root.add(wheel);
  live.add(wheel);

  const pedestal = (at: Vector3, label: string[], color: string) => {
    const ped = new Mesh(new BoxGeometry(0.18, at.y - 0.02, 0.3), wood);
    ped.position.set(at.x, (at.y - 0.02) / 2, at.z);
    ped.castShadow = true;
    const cap = new Mesh(new BoxGeometry(0.2, 0.03, 0.32), brass);
    cap.position.set(at.x, at.y - 0.01, at.z);
    const plate = makeLabel(label, { width: 0.16, aspect: 0.55, px: 256, background: 'rgba(28,20,14,0.92)', font: '800 34px system-ui, sans-serif', color });
    plate.position.set(at.x, at.y - 0.16, at.z + 0.152);
    root.add(ped, cap, plate);
  };

  // Throttle: a lever on a pivot (rotate .rotation.x; negative = pushed forward).
  pedestal(HELM.throttlePivot, ['THROTTLE', 'push: ahead', 'pull: astern'], '#ffb3a8');
  const throttle = new Group();
  throttle.name = 'throttle';
  throttle.position.copy(HELM.throttlePivot);
  const slot = new Mesh(new BoxGeometry(0.03, 0.012, 0.24), new MeshLambertMaterial({ color: 0x1b1410 }));
  slot.position.set(HELM.throttlePivot.x, HELM.throttlePivot.y + 0.008, HELM.throttlePivot.z);
  root.add(slot);
  const controlMat = new MeshStandardMaterial({ vertexColors: true, roughness: 0.35, metalness: 0.45 });
  const lever = new Mesh(
    mergeColored([
      { geometry: new CylinderGeometry(0.011, 0.014, HELM.leverLength, 10), matrix: new Matrix4().makeTranslation(0, HELM.leverLength / 2, 0), color: 0xd4af37 },
      { geometry: new SphereGeometry(0.036, 18, 12), matrix: new Matrix4().makeTranslation(0, HELM.leverLength, 0), color: 0xe63946 },
    ]),
    controlMat,
  );
  lever.castShadow = true;
  throttle.add(lever);
  root.add(throttle);
  live.add(throttle);

  // Lift: a T-handle that slides up and down a post (move .position.y).
  pedestal(HELM.liftBase, ['LIFT', 'pull up: climb', 'push down: sink'], '#9fe3ff');
  const postH = HELM.liftRest + HELM.liftTravel + 0.06;
  const post = new Mesh(new CylinderGeometry(0.014, 0.014, postH, 10), brass);
  post.position.set(HELM.liftBase.x, HELM.liftBase.y + postH / 2, HELM.liftBase.z - 0.07);
  const postTop = new Mesh(new SphereGeometry(0.022, 10, 8), brass);
  postTop.position.set(HELM.liftBase.x, HELM.liftBase.y + postH, HELM.liftBase.z - 0.07);
  root.add(post, postTop);
  const liftHandle = new Group();
  liftHandle.name = 'lift-handle';
  liftHandle.position.set(HELM.liftBase.x, HELM.liftBase.y + HELM.liftRest, HELM.liftBase.z);
  const handle = new Mesh(
    mergeColored([
      { geometry: new CylinderGeometry(0.024, 0.024, 0.05, 12), matrix: new Matrix4().makeTranslation(0, 0, -0.07), color: 0xd4af37 },
      { geometry: new BoxGeometry(0.02, 0.02, 0.07), matrix: new Matrix4().makeTranslation(0, 0, -0.035), color: 0xd4af37 },
      { geometry: new CylinderGeometry(0.019, 0.019, 0.13, 12), matrix: new Matrix4().makeRotationX(Math.PI / 2).setPosition(0, 0, 0.03), color: 0x4cc9f0 },
    ]),
    controlMat,
  );
  handle.castShadow = true;
  liftHandle.add(handle);
  root.add(liftHandle);
  live.add(liftHandle);

  // Gauge face on the binnacle: altitude, speed, heading.
  const gaugeCanvas = document.createElement('canvas');
  gaugeCanvas.width = 512;
  gaugeCanvas.height = 256;
  const gaugeTexture = new CanvasTexture(gaugeCanvas);
  gaugeTexture.colorSpace = SRGBColorSpace;
  const gaugeBox = new Mesh(new BoxGeometry(0.38, 0.19, 0.04), woodDark);
  gaugeBox.position.copy(HELM.gauge);
  gaugeBox.rotation.x = -0.62;
  // The face is the boat's child, not the box's: the box gets folded into the static merge.
  const gauge = new Mesh(new PlaneGeometry(0.35, 0.175), new MeshBasicMaterial({ map: gaugeTexture, toneMapped: false }));
  gauge.rotation.x = gaugeBox.rotation.x;
  gauge.position.copy(HELM.gauge).add(new Vector3(0, 0, 0.0205).applyEuler(gauge.rotation));
  gauge.name = 'gauge';
  const neck = new Mesh(new BoxGeometry(0.08, 0.16, 0.08), woodDark);
  neck.position.set(0, 1.36, bz - 0.02);
  root.add(gaugeBox, gauge, neck);
  live.add(gauge);

  // ---- Envelope: a striped balloon on rigging ----
  const env = new SphereGeometry(1, 48, 24).toNonIndexed();
  const ep = env.getAttribute('position');
  const ec = new Float32Array(ep.count * 3);
  const stripes = [new Color(0xff8a73), new Color(0xfff1d6), new Color(0x58b8ff), new Color(0xfff1d6)];
  for (let f = 0; f < ep.count; f += 3) {
    // Gores: colour each face by its angle around the long axis (Y here, Z once rotated).
    const cx = ep.getX(f) + ep.getX(f + 1) + ep.getX(f + 2);
    const cz = ep.getZ(f) + ep.getZ(f + 1) + ep.getZ(f + 2);
    const c = stripes[Math.floor(((Math.atan2(cz, cx) + Math.PI) / (Math.PI * 2)) * 12) % stripes.length];
    for (let k = 0; k < 3; k++) ec.set([c.r, c.g, c.b], (f + k) * 3);
  }
  env.setAttribute('color', new BufferAttribute(ec, 3));
  env.rotateX(Math.PI / 2); // poles at the bow and stern
  const envelope = new Mesh(env, new MeshLambertMaterial({ vertexColors: true }));
  envelope.scale.copy(ENVELOPE.radii);
  envelope.position.copy(ENVELOPE.center);
  envelope.castShadow = true;
  envelope.name = 'envelope';
  root.add(envelope);
  // Four tail fins: shape x runs aft along the envelope, shape y outward from its axis.
  const finGeo = flat([
    [0, 0],
    [1.5, 0],
    [1.75, 1.05],
    [1.15, 1.05],
  ]);
  const finMat = new MeshLambertMaterial({ color: 0xfff1d6, side: DoubleSide });
  for (let i = 0; i < 4; i++) {
    const holder = new Group();
    holder.position.set(ENVELOPE.center.x, ENVELOPE.center.y, ENVELOPE.center.z + 2.1);
    holder.rotation.z = (i / 4) * Math.PI * 2;
    const f = new Mesh(finGeo, finMat);
    f.rotation.y = -Math.PI / 2;
    f.position.y = 0.55;
    holder.add(f);
    root.add(holder);
  }
  // Rigging: ropes from the envelope's waist to the rails.
  const ropes: number[] = [];
  for (const side of [1, -1]) {
    for (const t of [0.22, 0.42, 0.82]) {
      const z = HULL.zAt(t);
      const ex = ENVELOPE.radii.x * Math.sqrt(Math.max(0, 1 - Math.pow((z - ENVELOPE.center.z) / ENVELOPE.radii.z, 2))) * 0.9 * side;
      ropes.push(ex, ENVELOPE.center.y - 0.25, z, (HULL.halfBeam(t) - 0.04) * side, RAIL_Y, z);
    }
  }
  const ropeGeo = new BufferGeometry();
  ropeGeo.setAttribute('position', new BufferAttribute(new Float32Array(ropes), 3));
  root.add(new LineSegments(ropeGeo, new LineBasicMaterial({ color: 0xd9c9a8 })));

  // ---- Stern: crystal engine and propeller ----
  const sternZ = HULL.zAt(1);
  const engine = new Mesh(new CylinderGeometry(0.2, 0.24, 0.45, 16), brass);
  engine.rotation.x = Math.PI / 2;
  engine.position.set(0, 0.2, sternZ + 0.2);
  const crystalMaterial = new MeshBasicMaterial({ color: new Color(0x6ff7ff) });
  const crystal = new Mesh(new OctahedronGeometry(0.11, 0), crystalMaterial);
  crystal.scale.set(0.8, 1.6, 0.8);
  crystal.position.set(0, 0.55, sternZ + 0.2);
  live.add(crystal);
  const propeller = new Mesh(
    mergeColored(
      [0, 1, 2].map((i) => ({
        geometry: new BoxGeometry(0.09, 0.62, 0.02),
        matrix: new Matrix4().makeRotationZ((i / 3) * Math.PI * 2).multiply(new Matrix4().makeTranslation(0, 0.3, 0).multiply(new Matrix4().makeRotationY(0.5))),
        color: 0xe9dcc4,
      })),
    ),
    new MeshStandardMaterial({ vertexColors: true, roughness: 0.4 }),
  );
  propeller.position.set(0, 0.2, sternZ + 0.47);
  propeller.castShadow = true;
  live.add(propeller);
  const name = makeLabel(['SKYLARK'], { width: 0.9, aspect: 0.2, px: 512, background: null, font: '800 70px Georgia, serif', color: '#fff1d6' });
  name.position.set(0, -0.52, sternZ + 0.006);
  root.add(engine, crystal, propeller, name);

  // ---- Bow: bowsprit, pennant, lanterns ----
  const bowZ = HULL.zAt(0);
  const sprit = new Mesh(new CylinderGeometry(0.03, 0.045, 1.4, 8), woodDark);
  sprit.rotation.x = Math.PI / 2 - 0.35;
  sprit.position.set(0, 0.62, bowZ - 0.45);
  root.add(sprit);
  // The pennant streams aft from the top of the flagpole.
  const pennant = new Mesh(
    flat([
      [0, 0],
      [0.95, 0.08],
      [0, 0.17],
    ]),
    new MeshLambertMaterial({ color: 0xff4d6d, side: DoubleSide }),
  );
  pennant.rotation.y = -Math.PI / 2;
  pennant.position.set(0, 1.58, poleZ);
  live.add(pennant);
  root.add(pennant);
  const lampSpots: [number, number, number][] = [
    [0, 1.04, poleZ - 0.14],
    [sb, 0.99, sternZ],
    [-sb, 0.99, sternZ],
  ];
  const lampMaterial = new MeshBasicMaterial({ color: new Color(0xffd27a) });
  const lamps = new Mesh(mergeGeometries(lampSpots.map(([x, y, z]) => new SphereGeometry(0.055, 12, 8).translate(x, y, z)))!, lampMaterial);
  lamps.name = 'lanterns';
  live.add(lamps);
  root.add(lamps);
  const cageMat = new MeshStandardMaterial({ color: 0x2b2d42, metalness: 0.6, roughness: 0.4, wireframe: true });
  for (const [x, y, z] of lampSpots) {
    const cage = new Mesh(new CylinderGeometry(0.07, 0.07, 0.13, 6, 1, true), cageMat);
    cage.position.set(x, y, z);
    root.add(cage);
  }

  return { root, wheel, throttle, liftHandle, propeller, gaugeCanvas, gaugeTexture, lampMaterial, crystalMaterial, pennant, live };
}
