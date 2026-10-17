import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  DynamicDrawUsage,
  Group,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshLambertMaterial,
  MeshStandardMaterial,
  Quaternion,
  TorusGeometry,
  Vector3,
} from 'three';
import { smoothstep } from '../core/math';
import { mergeColored } from '../core/merge';

/** A wing's colours. */
export interface WingPalette {
  base: number;
  accent: number;
  tip: number;
  lines: number;
  toggle: number;
}

/** Projected span, and how high the canopy's crown sits above the carabiners (m). */
export const SPAN = 7.6;
export const CANOPY_H = 6.3;
const CHORD = 2.3;
/** Half-angle of the canopy's arc (its tips curve down toward you). */
const ARC = 0.78;
const R = SPAN / 2 / Math.sin(ARC);
/** The quarter-chord line sits this far ahead of the pilot (-Z is forward). */
const QC_Z = -0.55;
const CELLS = 32;
/** Span segments per cell (cells bulge between ribs). */
const PER_CELL = 3;
const CELL_VERTS = PER_CELL + 1;
const NS = CELLS * CELL_VERTS;
/** Chord samples per surface, leading edge to trailing edge. */
const NC = 12;
/** Profile points per span station: upper surface TE→LE, then lower LE→TE. */
const K = 2 * NC - 1;
/** How far a fully pulled brake drags the trailing edge down (m). */
const BRAKE_DROOP = 0.7;

/** Riser tops (A..D) and the brake pulley, right side; the left mirrors x. Harness frame, m. */
const RISER_TOPS = [
  new Vector3(0.27, 0.5, -0.035),
  new Vector3(0.275, 0.5, -0.012),
  new Vector3(0.28, 0.5, 0.012),
  new Vector3(0.285, 0.5, 0.035),
];
export const PULLEY = new Vector3(0.285, 0.46, 0.05);
const CARABINER = new Vector3(0.2, 0, 0.02);
/** Line attachment ribs on each half (counted from the left tip) and their chord rows. */
const LINE_RIBS = [2, 4, 6, 8, 10, 12, 14];
const LINE_GROUPS = [[0, 1], [2, 3], [4, 5, 6]];
const ROWS = [0.08, 0.32, 0.58, 0.82];
const BRAKE_RIBS = [5, 7, 9, 11, 13];

const chordAt = (s: number) => CHORD * Math.sqrt(1 - 0.72 * s * s);
/** NACA-style half thickness per unit chord, closed trailing edge. */
const thick = (c: number) => 5 * 0.16 * (0.2969 * Math.sqrt(c) - 0.126 * c - 0.3516 * c * c + 0.2843 * c ** 3 - 0.1036 * c ** 4);
const camber = (c: number) => 0.045 * 4 * c * (1 - c);

const _v = new Vector3();
const _w = new Vector3();
const _m = new Matrix4();

/** A toggle (brake handle): a loop of webbing and a padded grip. Origin at the grip's centre. */
export function toggleModel(color: number): Mesh {
  const geo = mergeColored([
    { geometry: new CylinderGeometry(0.017, 0.017, 0.1, 10), matrix: new Matrix4().makeRotationZ(Math.PI / 2), color },
    { geometry: new TorusGeometry(0.05, 0.007, 6, 16, Math.PI), matrix: new Matrix4().makeTranslation(0, 0.004, 0), color: 0x2b2d42 },
    { geometry: new CylinderGeometry(0.006, 0.006, 0.05, 6), matrix: new Matrix4().makeTranslation(0, 0.075, 0), color: 0xe8e2d6 },
  ]);
  const m = new Mesh(geo, new MeshStandardMaterial({ vertexColors: true, roughness: 0.7 }));
  m.name = 'glider-toggle';
  return m;
}

/**
 * A paraglider: the canopy (cells, airfoil, an arc that curves its tips down),
 * its lines cascading to four risers a side, and the brake lines to the toggles.
 * The canopy deforms with the brakes; the lines are rebuilt every frame.
 */
export class Wing {
  /** At the carabiners, -Z forward: turns with the wing's heading but stays upright, like you. */
  readonly root = new Group();
  /** At the riser tops: the canopy banks into turns and pitches about here. */
  readonly pivot = new Group();
  readonly canopy: Mesh;
  readonly lines: LineSegments;
  readonly toggles: [Mesh, Mesh];
  private readonly rest: Float32Array;
  private readonly brakeW: Float32Array;
  private readonly te: Float32Array;
  private readonly material: MeshLambertMaterial;
  private lastBrakes = [-1, -1];

  constructor(readonly palette: WingPalette) {
    this.root.name = 'paraglider';
    const pos = new Float32Array(NS * K * 3);
    const col = new Float32Array(NS * K * 3);
    this.brakeW = new Float32Array(NS * K * 2);
    this.te = new Float32Array(NS * K);
    const base = new Color(palette.base);
    const accent = new Color(palette.accent);
    const tip = new Color(palette.tip);
    const c = new Color();
    const cs: number[] = [];
    for (let i = 0; i < NC; i++) cs.push((1 - Math.cos((Math.PI * i) / (NC - 1))) / 2);
    for (let cell = 0; cell < CELLS; cell++) {
      // Mirrored pattern from the tips in: tip colour, a stripe, base, a stripe, base, a light centre.
      const k = Math.min(cell, CELLS - 1 - cell);
      const cellColor = k <= 1 ? tip : k === 2 || k === 7 || k >= 13 ? accent : base;
      for (let u = 0; u < CELL_VERTS; u++) {
        const j = cell * CELL_VERTS + u;
        const s = -1 + (2 * (cell + u / PER_CELL)) / CELLS;
        const puff = Math.sin((Math.PI * u) / PER_CELL);
        const theta = s * ARC;
        const ax = R * Math.sin(theta);
        const ay = CANOPY_H - R * (1 - Math.cos(theta));
        const ux = Math.sin(theta);
        const uy = Math.cos(theta);
        const chord = chordAt(s);
        const ts = Math.sqrt(Math.max(0, 1 - s ** 10));
        for (let kk = 0; kk < K; kk++) {
          const upper = kk < NC;
          const cc = upper ? cs[NC - 1 - kk] : cs[kk - NC + 1];
          const off = upper ? camber(cc) + thick(cc) * ts + 0.012 * puff * ts : camber(cc) - thick(cc) * ts - 0.005 * puff * ts;
          const y = off * chord;
          const z = QC_Z + (cc - 0.25) * chord;
          const vi = j * K + kk;
          pos[vi * 3] = ax + ux * y;
          pos[vi * 3 + 1] = ay + uy * y;
          pos[vi * 3 + 2] = z;
          // Brakes pull the outer two thirds of each half's trailing edge down.
          const droop = smoothstep(0.45, 1, cc) ** 1.6;
          this.brakeW[vi * 2] = droop * smoothstep(0.1, 0.7, -s);
          this.brakeW[vi * 2 + 1] = droop * smoothstep(0.1, 0.7, s);
          this.te[vi] = droop;
          c.copy(cellColor);
          if (!upper) c.multiplyScalar(cc < 0.06 ? 0.35 : 0.8); // the intakes read dark from below
          col[vi * 3] = c.r;
          col[vi * 3 + 1] = c.g;
          col[vi * 3 + 2] = c.b;
        }
      }
    }
    this.rest = pos.slice();
    const index: number[] = [];
    for (let cell = 0; cell < CELLS; cell++) {
      for (let u = 0; u < PER_CELL; u++) {
        const j = cell * CELL_VERTS + u;
        for (let kk = 0; kk < K - 1; kk++) {
          const a = j * K + kk;
          const b = (j + 1) * K + kk;
          index.push(a, b, b + 1, a, b + 1, a + 1);
        }
      }
    }
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(pos, 3).setUsage(DynamicDrawUsage));
    geo.setAttribute('color', new BufferAttribute(col, 3));
    geo.setIndex(index);
    geo.computeVertexNormals();
    // Sunlight comes through the fabric: it glows in its own colours, seen from below too.
    this.material = new MeshLambertMaterial({ vertexColors: true, side: DoubleSide, emissive: new Color(0xffffff), emissiveIntensity: 0.45 });
    this.material.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n  totalEmissiveRadiance *= vColor.rgb;');
    };
    this.canopy = new Mesh(geo, this.material);
    this.canopy.name = 'glider-canopy';
    this.canopy.frustumCulled = false;
    this.canopy.castShadow = true;
    this.pivot.position.y = RISER_TOPS[0].y;
    this.canopy.position.y = -RISER_TOPS[0].y;
    this.pivot.add(this.canopy);
    this.root.add(this.pivot);

    // Risers (webbing straps from each carabiner to the four riser tops) and carabiners.
    const parts = [];
    for (const sx of [-1, 1]) {
      const cb = CARABINER.clone().setX(CARABINER.x * sx);
      // Two straps a side (front A+B, rear C+D) read better beside your head than four.
      for (const [i, j] of [[0, 1], [2, 3]]) {
        const t = RISER_TOPS[i].clone().add(RISER_TOPS[j]).multiplyScalar(0.5).setX(((RISER_TOPS[i].x + RISER_TOPS[j].x) / 2) * sx);
        const d = t.clone().sub(cb);
        const m = new Matrix4().compose(cb.clone().add(t).multiplyScalar(0.5), new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), d.clone().normalize()), new Vector3(1, 1, 1));
        parts.push({ geometry: new BoxGeometry(0.018, d.length(), 0.003), matrix: m, color: new Color(palette.tip).multiplyScalar(0.55) });
      }
      parts.push({ geometry: new TorusGeometry(0.03, 0.006, 6, 14), matrix: new Matrix4().makeTranslation(cb.x, cb.y - 0.02, cb.z), color: 0xc9ccd1 });
      const pulley = PULLEY.clone().setX(PULLEY.x * sx);
      parts.push({ geometry: new CylinderGeometry(0.012, 0.012, 0.012, 8), matrix: new Matrix4().makeRotationZ(Math.PI / 2).setPosition(pulley), color: 0xc9ccd1 });
    }
    const risers = new Mesh(mergeColored(parts), new MeshStandardMaterial({ vertexColors: true, roughness: 0.8 }));
    risers.name = 'glider-risers';
    this.root.add(risers);

    // Lines: rebuilt in world space each frame (they run to the toggles in your hands).
    const lineCount = 2 * (LINE_RIBS.length * ROWS.length + LINE_GROUPS.length * ROWS.length + BRAKE_RIBS.length + 2);
    const lg = new BufferGeometry();
    lg.setAttribute('position', new BufferAttribute(new Float32Array(lineCount * 6), 3).setUsage(DynamicDrawUsage));
    this.lines = new LineSegments(lg, new LineBasicMaterial({ color: palette.lines, transparent: true, opacity: 0.6 }));
    this.lines.name = 'glider-lines';
    this.lines.frustumCulled = false;
    this.toggles = [toggleModel(palette.toggle), toggleModel(palette.toggle)];
    this.toggles[0].name = 'glider-toggle-left';
    this.toggles[1].name = 'glider-toggle-right';
  }

  /** How translucent the fabric looks (sunlight through it): 0 at night. */
  setDaylight(k: number): void {
    this.material.emissiveIntensity = 0.08 + 0.4 * k;
  }

  /** Pull the trailing edge down by the brakes (0..1 each). */
  setBrakes(left: number, right: number): void {
    if (Math.abs(left - this.lastBrakes[0]) < 0.004 && Math.abs(right - this.lastBrakes[1]) < 0.004) return;
    this.lastBrakes = [left, right];
    const pos = this.canopy.geometry.getAttribute('position') as BufferAttribute;
    const a = pos.array as Float32Array;
    const r = this.rest;
    for (let j = 0; j < NS; j++) {
      for (let kk = 0; kk < K; kk++) {
        const vi = j * K + kk;
        const d = (this.brakeW[vi * 2] * left + this.brakeW[vi * 2 + 1] * right) * BRAKE_DROOP;
        const i3 = vi * 3;
        if (d === 0) {
          a[i3] = r[i3];
          a[i3 + 1] = r[i3 + 1];
          a[i3 + 2] = r[i3 + 2];
          continue;
        }
        // Down along the section's own "up" (the arc's normal), and a little forward.
        const s = -1 + (2 * Math.floor(j / CELL_VERTS) + (2 * (j % CELL_VERTS)) / PER_CELL) / CELLS;
        const th = s * ARC;
        a[i3] = r[i3] - Math.sin(th) * d;
        a[i3 + 1] = r[i3 + 1] - Math.cos(th) * d;
        a[i3 + 2] = r[i3 + 2] - 0.2 * d;
      }
    }
    pos.needsUpdate = true;
    this.canopy.geometry.computeVertexNormals();
  }

  /** A canopy vertex (rib `rib` from the left tip, lower surface at chord `c`), world space. */
  private ribPoint(rib: number, c: number, out: Vector3): Vector3 {
    const cell = Math.min(CELLS - 1, rib);
    const j = rib >= CELLS ? (CELLS - 1) * CELL_VERTS + PER_CELL : cell * CELL_VERTS;
    // Lower surface: indices NC-1 (leading edge) .. K-1 (trailing edge).
    const kk = Math.round(NC - 1 + c * (NC - 1));
    const a = (this.canopy.geometry.getAttribute('position') as BufferAttribute).array as Float32Array;
    const i3 = (j * K + Math.min(K - 1, kk)) * 3;
    return out.set(a[i3], a[i3 + 1], a[i3 + 2]).applyMatrix4(this.canopy.matrixWorld);
  }

  /**
   * Rebuild the lines for the canopy where it is now and the toggles where they are.
   * Call after the root's world matrix and the toggles are up to date.
   */
  updateLines(): void {
    const arr = (this.lines.geometry.getAttribute('position') as BufferAttribute).array as Float32Array;
    let n = 0;
    const seg = (a: Vector3, b: Vector3) => {
      arr[n++] = a.x;
      arr[n++] = a.y;
      arr[n++] = a.z;
      arr[n++] = b.x;
      arr[n++] = b.y;
      arr[n++] = b.z;
    };
    const world = this.root.matrixWorld;
    const attach = new Vector3();
    const junction = new Vector3();
    const top = new Vector3();
    const centroid = new Vector3();
    for (const side of [0, 1]) {
      const sx = side ? 1 : -1;
      const ribOf = (r: number) => (side ? CELLS - r : r);
      for (let row = 0; row < ROWS.length; row++) {
        top.copy(RISER_TOPS[row]).setX(RISER_TOPS[row].x * sx).applyMatrix4(world);
        for (const group of LINE_GROUPS) {
          centroid.set(0, 0, 0);
          for (const gi of group) centroid.add(this.ribPoint(ribOf(LINE_RIBS[gi]), ROWS[row], attach));
          centroid.multiplyScalar(1 / group.length);
          junction.lerpVectors(centroid, top, 0.42);
          for (const gi of group) seg(this.ribPoint(ribOf(LINE_RIBS[gi]), ROWS[row], attach), junction);
          seg(junction, top);
        }
      }
      // Brake lines: trailing edge → cascade → pulley on the rear riser → toggle.
      const pulley = _w.copy(PULLEY).setX(PULLEY.x * sx).applyMatrix4(world);
      centroid.set(0, 0, 0);
      for (const r of BRAKE_RIBS) centroid.add(this.ribPoint(ribOf(r), 1, attach));
      centroid.multiplyScalar(1 / BRAKE_RIBS.length);
      junction.lerpVectors(centroid, pulley, 0.4);
      for (const r of BRAKE_RIBS) seg(this.ribPoint(ribOf(r), 1, attach), junction);
      seg(junction, pulley);
      const grip = this.toggles[side].getWorldPosition(_v);
      grip.y += 0.09; // the line ties on at the top of the loop
      seg(pulley, grip);
    }
    (this.lines.geometry.getAttribute('position') as BufferAttribute).needsUpdate = true;
  }

  /** Where a dangling toggle hangs: just under its pulley (world). */
  pulleyWorld(side: 0 | 1, out: Vector3): Vector3 {
    return out.copy(PULLEY).setX(PULLEY.x * (side ? 1 : -1)).applyMatrix4(this.root.matrixWorld);
  }

  set visible(v: boolean) {
    this.root.visible = this.lines.visible = v;
  }

  get visible(): boolean {
    return this.root.visible;
  }
}

/** Canopy-frame helper for tests: the crown's world position. */
export function crownWorld(w: Wing, out: Vector3): Vector3 {
  return out.set(0, CANOPY_H, QC_Z).applyMatrix4(_m.copy(w.canopy.matrixWorld));
}
