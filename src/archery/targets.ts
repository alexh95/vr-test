import {
  BoxGeometry,
  BufferGeometry,
  CanvasTexture,
  CircleGeometry,
  Color,
  CylinderGeometry,
  DodecahedronGeometry,
  DoubleSide,
  Group,
  IcosahedronGeometry,
  Line,
  LineBasicMaterial,
  LinearFilter,
  Material,
  Matrix4,
  Mesh,
  MeshLambertMaterial,
  MeshStandardMaterial,
  OctahedronGeometry,
  PlaneGeometry,
  Quaternion,
  RingGeometry,
  Shape,
  ShapeGeometry,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
  Vector3,
} from 'three';
import { bus } from '../core/events';
import { rng, TAU } from '../core/math';
import { RAPIER } from '../physics/physics';
import { LAYOUT, SHOOTER } from '../world/layout';
import { balloonPop, sparkle, thock } from '../audio/sfx';
import { makeLabel, roundRect } from '../ui/text';
import { mergeStatic } from '../core/merge';
import type { App } from '../app';

/** A round target. The face is the local XY disc at z = 0, facing +Z (toward the deck). */
export interface RangeTarget {
  id: string;
  group: Group;
  radius: number;
  /** Score multiplier (moving targets are worth more). */
  mult: number;
  moving: boolean;
  inv: Matrix4;
  update?(time: number): void;
}

export interface Balloon {
  id: string;
  mesh: Group;
  pos: Vector3;
  radius: number;
  color: Color;
  alive: boolean;
  respawnAt: number;
  speed: number;
  phase: number;
  base: Vector3;
}

export interface RangeHit {
  kind: 'target' | 'balloon';
  /** Fraction along the tested segment. */
  t: number;
  point: Vector3;
  target?: RangeTarget;
  balloon?: Balloon;
}

/** Ring score by distance from the centre (fraction of the radius). */
export function ringScore(frac: number): { ring: number; points: number } {
  const ring = frac < 0.2 ? 0 : frac < 0.4 ? 1 : frac < 0.6 ? 2 : frac < 0.8 ? 3 : 4;
  return { ring, points: [10, 8, 6, 4, 2][ring] };
}

const RING_COLORS = ['#ffd166', '#ff7a6b', '#3d4f9f', '#7ec8f2', '#f7f3ea'];
const BEST_KEY = 'skyreach.range.best';

const _a = new Vector3();
const _b = new Vector3();
const _v = new Vector3();

function bullseyeTexture(): CanvasTexture {
  const S = 512;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d')!;
  const R = S / 2;
  // Outer to inner: cloud white, sky blue, twilight indigo, sunset coral, sun gold.
  for (let i = 4; i >= 0; i--) {
    g.beginPath();
    g.arc(R, R, R * (i + 1) * 0.2 - 1, 0, TAU);
    g.fillStyle = RING_COLORS[i];
    g.fill();
    g.lineWidth = 3;
    g.strokeStyle = 'rgba(30,24,40,0.55)';
    g.stroke();
  }
  // Soft clouds in the outer ring, sun rays in the centre.
  const r = rng(12);
  g.globalAlpha = 0.22;
  for (let i = 0; i < 18; i++) {
    const a = r() * TAU;
    const d = R * (0.86 + r() * 0.08);
    g.beginPath();
    g.arc(R + Math.cos(a) * d, R + Math.sin(a) * d, R * (0.04 + r() * 0.04), 0, TAU);
    g.fillStyle = '#ffffff';
    g.fill();
  }
  g.globalAlpha = 0.35;
  g.strokeStyle = '#fff2c4';
  g.lineWidth = 4;
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * TAU;
    g.beginPath();
    g.moveTo(R + Math.cos(a) * R * 0.08, R + Math.sin(a) * R * 0.08);
    g.lineTo(R + Math.cos(a) * R * 0.17, R + Math.sin(a) * R * 0.17);
    g.stroke();
  }
  g.globalAlpha = 1;
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/**
 * The Sky Range: a deck on the island's west rim and targets floating out over
 * the clouds, some anchored on rocks, some carried by balloons, a cloud and a kite.
 */
export class TargetRange {
  readonly root = new Group();
  readonly deck = new Group();
  readonly targets: RangeTarget[] = [];
  readonly balloons: Balloon[] = [];
  /** Where the bow sits on its rack (world). */
  readonly rackPos = new Vector3();
  readonly rackQuat = new Quaternion();
  score = 0;
  best = 0;
  shots = 0;
  hits = 0;
  last = '';
  private readonly faceMat: MeshStandardMaterial;
  private readonly woodMat = new MeshLambertMaterial({ color: 0x8a6440 });
  private readonly board: { canvas: HTMLCanvasElement; tex: CanvasTexture };
  private readonly popups: { sprite: Sprite; canvas: HTMLCanvasElement; tex: CanvasTexture; age: number; life: number; from: Vector3; rise: number }[] = [];
  private nextPopup = 0;
  private time = 0;

  constructor(private readonly app: App) {
    this.root.name = 'sky-range';
    app.scene.add(this.root);
    try {
      this.best = Number(localStorage.getItem(BEST_KEY) ?? 0) || 0;
    } catch {
      this.best = 0;
    }
    const tex = bullseyeTexture();
    this.faceMat = new MeshStandardMaterial({ map: tex, emissiveMap: tex, emissive: new Color(0xffffff), emissiveIntensity: 0.15, roughness: 0.75 });
    this.board = this.buildDeck();
    this.buildTargets();
    this.buildBalloons();
    for (let i = 0; i < 6; i++) this.popups.push(this.makePopup());
    this.drawBoard();
  }

  // ---------------------------------------------------------------- building

  private buildDeck(): { canvas: HTMLCanvasElement; tex: CanvasTexture } {
    const d = this.deck;
    d.name = 'range-deck';
    d.position.copy(LAYOUT.range);
    d.rotation.y = Math.PI / 2; // local -Z points west, down the range
    this.root.add(d);
    const plank = new MeshLambertMaterial({ color: 0xb08860 });
    const dark = new MeshLambertMaterial({ color: 0x6e4a2e });
    const gold = new MeshStandardMaterial({ color: 0xd4af37, roughness: 0.35, metalness: 0.8 });
    const physics = this.app.physics;
    const box = (size: [number, number, number], pos: [number, number, number], mat: Material = plank, collide = true, walkable = false) => {
      const m = new Mesh(new BoxGeometry(...size), mat);
      m.position.set(...pos);
      m.castShadow = m.receiveShadow = true;
      d.add(m);
      if (collide) {
        d.updateMatrixWorld(true);
        physics.addStatic(
          RAPIER.ColliderDesc.cuboid(size[0] / 2, size[1] / 2, size[2] / 2),
          { walkable, material: 'wood' },
          m.getWorldPosition(new Vector3()),
          m.getWorldQuaternion(new Quaternion()),
        );
      }
      return m;
    };
    // Platform (walkable), with plank seams.
    box([2.1, 0.08, 2.7], [0, 0.12, -0.25], plank, true, true);
    for (let i = -4; i <= 4; i++) box([0.012, 0.081, 2.7], [i * 0.23, 0.121, -0.25], dark, false);
    for (const [x, z] of [[-0.95, -1.5], [0.95, -1.5], [-0.95, 1.0], [0.95, 1.0]]) box([0.1, 0.5, 0.1], [x, -0.12, z], dark, false);
    // Front rail, waist high; arrows aimed too low stick in it.
    box([2.1, 0.07, 0.07], [0, 1.0, -1.56], dark);
    for (const x of [-1.0, 1.0]) box([0.07, 0.95, 0.07], [x, 0.6, -1.56], dark);
    // A painted shooting line.
    const line = new Mesh(new PlaneGeometry(2.0, 0.05), new MeshLambertMaterial({ color: 0xf2e8d0 }));
    line.rotation.x = -Math.PI / 2;
    line.position.set(0, 0.162, 0.1);
    d.add(line);

    // Bow rack on the shooter's right: a post with a gold cradle.
    box([0.07, 1.25, 0.07], [0.82, 0.74, 0.55], dark);
    box([0.06, 0.04, 0.2], [0.82, 1.3, 0.55], gold, false);
    d.updateMatrixWorld(true);
    // The bow hangs upright in the cradle, facing down the range.
    this.rackPos.copy(d.localToWorld(new Vector3(0.82, 1.26, 0.55)));
    this.rackQuat.copy(d.getWorldQuaternion(new Quaternion()));

    // Instructions on the rack post.
    const tip = makeLabel(['SKY RANGE', 'grab the bow by its grip · grab the string with your other hand', 'draw back to your cheek · let go · red dot zeroed at 35 m', 'B / Y on the bow hand: laser sight on or off'], {
      width: 0.6,
      aspect: 0.38,
      px: 1024,
      background: 'rgba(25,20,35,0.85)',
      font: '600 40px system-ui, sans-serif',
      color: '#ffe9c7',
    });
    tip.position.set(0.82, 1.62, 0.6);
    tip.rotation.y = -0.5;
    d.add(tip);

    // Scoreboard on the shooter's left.
    const canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = 560;
    const tex = new CanvasTexture(canvas);
    tex.colorSpace = SRGBColorSpace;
    tex.minFilter = LinearFilter;
    tex.anisotropy = 4;
    const boardMesh = new Mesh(new PlaneGeometry(0.9, 0.49), new MeshStandardMaterial({ map: tex, emissiveMap: tex, emissive: new Color(0xffffff), emissiveIntensity: 0.35 }));
    boardMesh.position.set(-0.98, 1.55, -0.9);
    boardMesh.rotation.y = 0.75;
    d.add(boardMesh);
    box([0.06, 1.35, 0.06], [-1.02, 0.78, -0.95], dark, false);
    mergeStatic(d, (o) => o === boardMesh || o === tip || o === line);
    return { canvas, tex };
  }

  /**
   * A target face (disc + wooden backing), facing +Z. Nothing in the backing overlaps the
   * face: a rim ring around it, an open side wall and a back cap 6 cm behind. A coplanar
   * backing a few millimetres behind the face z-fights at 30-60 m (depth precision).
   */
  private face(radius: number): Group {
    const g = new Group();
    const disc = new Mesh(new CircleGeometry(radius, 48), this.faceMat);
    const outer = radius * 1.06;
    const rim = new Mesh(new RingGeometry(radius, outer, 48), this.woodMat);
    const wall = new Mesh(new CylinderGeometry(outer, outer, 0.06, 40, 1, true), this.woodMat);
    wall.rotation.x = Math.PI / 2;
    wall.position.z = -0.03;
    const back = new Mesh(new CircleGeometry(outer, 40), this.woodMat);
    back.rotation.y = Math.PI;
    back.position.z = -0.06;
    disc.castShadow = wall.castShadow = back.castShadow = true;
    g.add(disc, rim, wall, back);
    return g;
  }

  /** A floating chunk of island rock (with a grassy top) that arrows stick into. */
  private floatingRock(at: Vector3, size: number, seed: number): Group {
    const g = new Group();
    const r = rng(seed);
    const rockMat = new MeshLambertMaterial({ color: 0x8b7766, flatShading: true });
    const rock = new Mesh(new DodecahedronGeometry(size, 1), rockMat);
    rock.scale.set(1.25, 0.8, 1.1);
    rock.rotation.set(r() * 3, r() * 3, r() * 3);
    const grass = new Mesh(new CylinderGeometry(size * 1.05, size * 0.9, size * 0.25, 9), new MeshLambertMaterial({ color: 0x6aa84f, flatShading: true }));
    grass.position.y = size * 0.55;
    const crystal = new Mesh(new OctahedronGeometry(size * 0.25, 0), new MeshStandardMaterial({ color: 0x7fe8ff, emissive: 0x2bb8ff, emissiveIntensity: 1.2 }));
    crystal.position.y = -size * 1.0;
    crystal.scale.set(0.6, 1.8, 0.6);
    g.add(rock, grass, crystal);
    g.position.copy(at);
    this.root.add(g);
    this.app.physics.addStatic(RAPIER.ColliderDesc.ball(size * 0.95), { material: 'stone' }, at.clone());
    return g;
  }

  private addTarget(id: string, group: Group, radius: number, mult: number, update?: (time: number) => void): RangeTarget {
    group.name = `target-${id}`;
    this.root.add(group);
    const t: RangeTarget = { id, group, radius, mult, moving: !!update, inv: new Matrix4(), update };
    this.targets.push(t);
    this.refresh(t);
    return t;
  }

  private refresh(t: RangeTarget): void {
    t.group.lookAt(SHOOTER);
    t.group.updateMatrixWorld(true);
    t.inv.copy(t.group.matrixWorld).invert();
  }

  private buildTargets(): void {
    const dark = new MeshLambertMaterial({ color: 0x6e4a2e });
    // ---- Static: on floating rocks at 12, 24 and 45 m, and one standing on the west isle ----
    const statics: [string, Vector3, number, number][] = [
      ['near', new Vector3(-18.5, 1.9, -1.6), 0.5, 11],
      ['mid', new Vector3(-30.5, 4.3, 3.8), 0.6, 12],
      ['far', new Vector3(-50.5, 8.2, -7.5), 0.9, 13],
    ];
    for (const [id, at, radius, seed] of statics) {
      // The rock sits low and a little behind the target, so its grassy top never
      // rises into the line of sight from the deck to the bottom of the face.
      const size = radius * 1.2 + 0.3;
      const gap = 0.55; // clear air between the face's lower edge and the grass
      const away = new Vector3().subVectors(at, SHOOTER).setY(0).normalize();
      const rockAt = at.clone().addScaledVector(away, size * 0.35).add(new Vector3(0, -radius - gap - size * 0.675, 0));
      this.floatingRock(rockAt, size, seed);
      const g = new Group();
      g.position.copy(at);
      const f = this.face(radius);
      const postLen = radius + gap + 0.15;
      const post = new Mesh(new BoxGeometry(0.08, postLen, 0.08), dark);
      post.position.set(0, -postLen / 2, -0.09);
      g.add(f, post);
      this.addTarget(id, g, radius, 1);
    }
    // On the west isle: a target on a wooden easel.
    {
      const isle = this.app.scenery.islands.find((i) => i.spec.name === 'west-isle')!;
      const x = -22.6;
      const z = -15.6;
      const ground = isle.heightAt(x, z) ?? isle.spec.center.y;
      const g = new Group();
      g.position.set(x, ground + 1.35, z);
      const f = this.face(0.55);
      for (const sx of [-0.4, 0.4]) {
        const leg = new Mesh(new BoxGeometry(0.07, 1.7, 0.07), dark);
        leg.position.set(sx, -0.55, -0.12);
        leg.rotation.z = sx > 0 ? -0.08 : 0.08;
        g.add(leg);
      }
      g.add(f);
      this.addTarget('isle', g, 0.55, 1);
    }

    // ---- Moving: carried by balloons, sailing side to side ----
    {
      const g = new Group();
      const f = this.face(0.6);
      g.add(f);
      const colors = [0xff8fab, 0x9ad0ff, 0xffe066];
      for (let i = 0; i < 3; i++) {
        const b = this.balloonMesh(new Color(colors[i]), 0.42);
        const off = new Vector3((i - 1) * 0.55, 1.75 + (i === 1 ? 0.25 : 0), 0);
        b.position.copy(off);
        g.add(b);
        const string = new Line(new BufferGeometry().setFromPoints([new Vector3(0, 0.62, 0), off.clone().add(new Vector3(0, -0.5, 0))]), new LineBasicMaterial({ color: 0xf5f0e6 }));
        g.add(string);
      }
      const base = new Vector3(-36.5, 6.2, -2);
      this.addTarget('balloons', g, 0.6, 2, (time) => {
        g.position.set(base.x, base.y + Math.sin(time * 0.9) * 0.5, base.z + Math.sin((time * TAU) / 11) * 7);
      });
    }
    // ---- Moving: a cloud that orbits a crystal pylon ----
    {
      const pylonAt = new Vector3(-42, 2.5, 10.5);
      this.floatingRock(pylonAt, 1.4, 21);
      const g = new Group();
      const f = this.face(0.6);
      const cloud = new Group();
      const puffMat = new MeshLambertMaterial({ color: 0xffffff, emissive: new Color(0x8a7090) });
      for (const [x, y, z, s] of [[0, -0.95, 0, 0.55], [-0.5, -0.85, 0.05, 0.4], [0.5, -0.9, -0.05, 0.42], [0.2, -0.65, 0.2, 0.3], [-0.25, -1.05, -0.2, 0.35]]) {
        const p = new Mesh(new IcosahedronGeometry(1, 1), puffMat);
        p.position.set(x, y, z);
        p.scale.setScalar(s);
        cloud.add(p);
      }
      g.add(f, cloud);
      this.addTarget('orbiter', g, 0.6, 2, (time) => {
        const a = (time * TAU) / 15;
        g.position.set(pylonAt.x + Math.cos(a) * 5.5, pylonAt.y + 2.6 + Math.sin(a * 2) * 0.4, pylonAt.z + Math.sin(a) * 5.5);
      });
    }
    // ---- Moving: a kite looping a figure-eight, far and high ----
    {
      const g = new Group();
      const sail = new Shape();
      sail.moveTo(0, 1.35);
      sail.lineTo(1.0, 0.1);
      sail.lineTo(0, -1.15);
      sail.lineTo(-1.0, 0.1);
      sail.closePath();
      const kite = new Mesh(new ShapeGeometry(sail), new MeshStandardMaterial({ color: 0x4cc9f0, emissive: 0x13405a, side: DoubleSide, roughness: 0.6 }));
      kite.position.z = -0.1; // well behind the target's back cap (6 cm), so the two never fight
      const spar = new Mesh(new BoxGeometry(0.03, 2.5, 0.03), dark);
      spar.position.set(0, 0.1, -0.125);
      const f = this.face(0.75);
      g.add(kite, spar, f);
      const tail: Mesh[] = [];
      for (let i = 0; i < 6; i++) {
        const bow = new Mesh(new PlaneGeometry(0.28, 0.12), new MeshStandardMaterial({ color: i % 2 ? 0xffd166 : 0xff7a6b, side: DoubleSide }));
        g.add(bow);
        tail.push(bow);
      }
      const center = new Vector3(-62, 15, 1.5);
      this.addTarget('kite', g, 0.75, 3, (time) => {
        const w = (time * TAU) / 13;
        g.position.set(center.x, center.y + Math.sin(2 * w) * 3.5, center.z + Math.sin(w) * 9);
        tail.forEach((b, i) => b.position.set(Math.sin(time * 3 + i * 0.9) * 0.15 * i, -1.25 - i * 0.32, -0.12));
      });
    }
    // Make the static targets' wooden parts one draw call where possible.
    for (const t of this.targets) if (!t.moving) mergeStatic(t.group, (o) => (o as Mesh).material === this.faceMat);
  }

  private balloonMesh(color: Color, radius: number): Group {
    const g = new Group();
    const mat = new MeshStandardMaterial({ color, roughness: 0.28, metalness: 0, emissive: color.clone().multiplyScalar(0.18) });
    const ball = new Mesh(new SphereGeometry(radius, 20, 14), mat);
    ball.scale.set(1, 1.15, 1);
    const knot = new Mesh(new CylinderGeometry(0.02, 0.05, 0.07, 8), mat);
    knot.position.y = -radius * 1.15 - 0.02;
    ball.castShadow = true;
    g.add(ball, knot);
    return g;
  }

  private buildBalloons(): void {
    const r = rng(31);
    const colors = [0xff4d6d, 0xffd166, 0x06d6a0, 0x4cc9f0, 0xb388ff, 0xff8fab, 0xffffff, 0x9ef01a];
    for (let i = 0; i < 9; i++) {
      const color = new Color(colors[i % colors.length]);
      const mesh = this.balloonMesh(color, 0.3);
      const string = new Line(new BufferGeometry().setFromPoints([new Vector3(0, -0.38, 0), new Vector3(0.05, -1.2, 0.02)]), new LineBasicMaterial({ color: 0xf5f0e6 }));
      mesh.add(string);
      this.root.add(mesh);
      const base = new Vector3(-15 - r() * 22, 0, -11 + r() * 21);
      const b: Balloon = { id: `balloon-${i}`, mesh, pos: new Vector3(base.x, -10 + r() * 28, base.z), radius: 0.32, color, alive: true, respawnAt: 0, speed: 0.55 + r() * 0.6, phase: r() * TAU, base };
      this.balloons.push(b);
    }
  }

  private makePopup() {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 160;
    const tex = new CanvasTexture(canvas);
    tex.colorSpace = SRGBColorSpace;
    const sprite = new Sprite(new SpriteMaterial({ map: tex, transparent: true, depthTest: false, toneMapped: false }));
    sprite.renderOrder = 30;
    sprite.visible = false;
    this.root.add(sprite);
    return { sprite, canvas, tex, age: 0, life: 1.6, from: new Vector3(), rise: 1 };
  }

  // ---------------------------------------------------------------- play

  /**
   * First thing the segment a→b passes through: a target face (from the front)
   * or a balloon. Analytic, so moving targets need no physics bodies.
   */
  raycast(a: Vector3, b: Vector3): RangeHit | null {
    let best: RangeHit | null = null;
    for (const t of this.targets) {
      const la = _a.copy(a).applyMatrix4(t.inv);
      const lb = _b.copy(b).applyMatrix4(t.inv);
      if (la.z < 0 || lb.z > 0) continue; // must cross the face plane from the front
      const k = la.z / (la.z - lb.z);
      const x = la.x + (lb.x - la.x) * k;
      const y = la.y + (lb.y - la.y) * k;
      if (x * x + y * y > t.radius * t.radius) continue;
      if (!best || k < best.t) best = { kind: 'target', t: k, point: new Vector3().lerpVectors(a, b, k), target: t };
    }
    const d = _v.subVectors(b, a);
    const len2 = d.lengthSq();
    for (const bl of this.balloons) {
      if (!bl.alive) continue;
      // Segment vs sphere.
      const f = _a.subVectors(a, bl.pos);
      const bq = f.dot(d);
      const c = f.lengthSq() - bl.radius * bl.radius;
      const disc = bq * bq - len2 * c;
      if (disc < 0) continue;
      const k = (-bq - Math.sqrt(disc)) / len2;
      if (k < 0 || k > 1) continue;
      if (!best || k < best.t) best = { kind: 'balloon', t: k, point: new Vector3().copy(a).addScaledVector(d, k), balloon: bl };
    }
    return best;
  }

  /** Score a hit on a target face. Returns the points. */
  scoreHit(t: RangeTarget, worldPoint: Vector3, distance: number): number {
    const local = _a.copy(worldPoint).applyMatrix4(t.inv);
    const frac = Math.hypot(local.x, local.y) / t.radius;
    const { ring, points } = ringScore(frac);
    const total = points * t.mult;
    this.score += total;
    this.hits++;
    const bull = ring === 0;
    this.last = `${bull ? 'Bullseye' : `${points} ring`} +${total} at ${Math.round(distance)} m${t.moving ? ' (moving)' : ''}`;
    this.saveBest();
    this.drawBoard();
    thock(worldPoint, distance, bull ? 1.2 : 1);
    const color = new Color(RING_COLORS[ring]);
    this.app.fx.burst(worldPoint, bull ? 50 : 24, bull ? 3 : 2, color.multiplyScalar(2), { size: 0.04 + distance * 0.002, life: 0.6, drag: 2.5, gravity: 0.2 });
    if (bull) sparkle(worldPoint, 1.2);
    this.popup(bull ? `BULLSEYE +${total}` : `+${total}`, worldPoint, distance, bull ? '#ffd166' : '#ffffff');
    bus.emit('target-hit', { id: t.id, ring, points: total, distance: +distance.toFixed(1), moving: t.moving });
    return total;
  }

  pop(b: Balloon, distance: number): void {
    if (!b.alive) return;
    b.alive = false;
    b.mesh.visible = false;
    b.respawnAt = this.time + 2.5;
    this.score += 5;
    this.hits++;
    this.last = `Balloon +5 at ${Math.round(distance)} m`;
    this.saveBest();
    this.drawBoard();
    balloonPop(b.pos, distance);
    const c = b.color.clone().multiplyScalar(1.6);
    this.app.fx.burst(b.pos, 40, 3.5, c, { size: 0.05 + distance * 0.0015, life: 0.9, drag: 2, gravity: 0.6, flicker: 0.4 });
    this.popup('POP +5', b.pos, distance, '#ffffff');
    bus.emit('balloon-pop', { id: b.id, distance: +distance.toFixed(1) });
  }

  /** A shot was fired (for accuracy stats). */
  shot(): void {
    this.shots++;
    this.drawBoard();
  }

  private saveBest(): void {
    if (this.score <= this.best) return;
    this.best = this.score;
    try {
      localStorage.setItem(BEST_KEY, String(this.best));
    } catch {
      // Storage can be blocked; the best score then lasts for this visit.
    }
  }

  private popup(text: string, at: Vector3, distance: number, color: string): void {
    const p = this.popups[this.nextPopup++ % this.popups.length];
    const g = p.canvas.getContext('2d')!;
    g.clearRect(0, 0, p.canvas.width, p.canvas.height);
    g.font = '800 92px system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineWidth = 12;
    g.strokeStyle = 'rgba(20,14,30,0.85)';
    g.strokeText(text, 256, 80, 500);
    g.fillStyle = color;
    g.fillText(text, 256, 80, 500);
    p.tex.needsUpdate = true;
    const s = Math.max(0.6, distance * 0.045);
    p.sprite.scale.set(s, s * (160 / 512), 1);
    p.from.copy(at).add(new Vector3(0, s * 0.4, 0));
    p.rise = s * 0.8;
    p.age = 0;
    p.sprite.visible = true;
  }

  private drawBoard(): void {
    const c = this.board.canvas;
    const g = c.getContext('2d')!;
    g.clearRect(0, 0, c.width, c.height);
    g.fillStyle = '#20182c';
    roundRect(g, 0, 0, c.width, c.height, 36);
    g.fill();
    g.strokeStyle = '#d4af37';
    g.lineWidth = 8;
    roundRect(g, 6, 6, c.width - 12, c.height - 12, 32);
    g.stroke();
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    g.fillStyle = '#ffd9a0';
    g.font = '800 70px system-ui, sans-serif';
    g.fillText('SKY RANGE', 50, 82);
    g.fillStyle = '#f4efe6';
    g.font = '700 86px system-ui, sans-serif';
    g.fillText(`${this.score}`, 50, 210);
    const scoreWidth = g.measureText(`${this.score}`).width;
    g.font = '600 40px system-ui, sans-serif';
    g.fillStyle = '#c9bfb0';
    g.fillText('score', 50 + scoreWidth + 20, 222);
    g.fillStyle = '#ffd166';
    g.font = '700 46px system-ui, sans-serif';
    g.fillText(`best ${this.best}`, 640, 210);
    g.fillStyle = '#f4efe6';
    g.font = '500 40px system-ui, sans-serif';
    const acc = this.shots ? Math.round((100 * this.hits) / this.shots) : 0;
    g.fillText(`arrows ${this.shots} · hits ${this.hits} · ${acc}%`, 50, 320, c.width - 100);
    g.fillStyle = '#9fe3ff';
    g.fillText(this.last || 'moving targets score double (kite ×3)', 50, 410, c.width - 100);
    g.fillStyle = '#8f8598';
    g.font = 'italic 500 32px system-ui, sans-serif';
    g.fillText('rings 10 · 8 · 6 · 4 · 2 · balloons 5', 50, 495, c.width - 100);
    this.board.tex.needsUpdate = true;
  }

  /** Start a fresh round (the best score stays). */
  resetScore(): void {
    this.score = 0;
    this.shots = 0;
    this.hits = 0;
    this.last = '';
    this.drawBoard();
  }

  setGlow(glow: number): void {
    this.faceMat.emissiveIntensity = 0.12 + Math.max(0, glow - 0.5) * 0.18;
  }

  update(dt: number, time: number): void {
    this.time = time;
    for (const t of this.targets) {
      if (!t.update) continue;
      t.update(time);
      this.refresh(t);
    }
    for (const b of this.balloons) {
      if (!b.alive) {
        if (time >= b.respawnAt) {
          b.alive = true;
          b.mesh.visible = true;
          b.pos.set(b.base.x, -12, b.base.z);
        }
        continue;
      }
      b.pos.y += b.speed * dt;
      b.pos.x = b.base.x + Math.sin(time * 0.5 + b.phase) * 0.8;
      b.pos.z = b.base.z + Math.cos(time * 0.37 + b.phase) * 0.8;
      if (b.pos.y > 22) b.pos.y = -12;
      b.mesh.position.copy(b.pos);
      b.mesh.rotation.z = Math.sin(time * 0.8 + b.phase) * 0.12;
    }
    for (const p of this.popups) {
      if (!p.sprite.visible) continue;
      p.age += dt;
      const k = p.age / p.life;
      if (k >= 1) {
        p.sprite.visible = false;
        continue;
      }
      p.sprite.position.copy(p.from).y += p.rise * Math.sqrt(k);
      (p.sprite.material as SpriteMaterial).opacity = k < 0.7 ? 1 : 1 - (k - 0.7) / 0.3;
    }
  }
}
