import { type BufferGeometry, BoxGeometry, CylinderGeometry, Group, Matrix4, Mesh, MeshLambertMaterial, MeshStandardMaterial, Object3D, Quaternion, Vector3 } from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RAPIER, type Physics } from '../physics/physics';
import { mergeStatic } from '../core/merge';
import { makeLabel } from '../ui/text';
import { KINDS, SHELL, shellGeometry, type ShellKind } from './kinds';
import { buildGunModel, shellMaterial } from './gun-model';

const TILT = 0.38; // the case top leans toward you
const W = 0.6;
const D = 0.34;
const REFILL = 2; // seconds before a taken cartridge is replaced

export interface LockerOptions {
  name: string;
  /** The scene, or the skyboat's root (the locker then rides along). */
  parent: Object3D;
  /** Floor point under the locker, in the parent's frame. */
  position: Vector3;
  /** Rotation about +Y in the parent's frame; the locker's front (+Z) faces you. */
  yaw: number;
  /** Height of the case top above the floor. */
  height: number;
  /** For a locker on the boat: its colliders ride on this body. */
  body?: RAPIER.RigidBody;
  platform?: Object3D;
}

export interface Slot {
  kind: ShellKind;
  /** Middle of the part of the cartridge that sticks up (case-top frame). */
  grab: Vector3;
  base: Vector3;
  full: boolean;
  refillAt: number;
}

/**
 * An open case of signal flares: the pistol lies in its cut-out and nine
 * cartridges stand in three rows (parachute, star, smoke), three colours each.
 * Cartridges are dispensed, not stored as physics props: take one and it's
 * replaced a couple of seconds later.
 */
export class FlareLocker {
  readonly root = new Group();
  /** The tilted case top: slot and holster coordinates live here. */
  readonly top = new Group();
  readonly slots: Slot[] = [];
  /** Where the docked pistol's origin sits (case-top frame). */
  readonly holster = new Object3D();
  readonly dockedGun: Group;
  private readonly shellMesh: Mesh;
  private readonly geos = new Map<string, BufferGeometry>();
  private time = 0;

  constructor(physics: Physics, o: LockerOptions) {
    const root = this.root;
    root.name = o.name;
    root.position.copy(o.position);
    root.rotation.y = o.yaw;
    o.parent.add(root);
    const wood = new MeshLambertMaterial({ color: 0x7a4a2c });
    const dark = new MeshLambertMaterial({ color: 0x2b2d42 });
    const brass = new MeshStandardMaterial({ color: 0xd4af37, roughness: 0.3, metalness: 0.85 });
    const box = (size: [number, number, number], at: [number, number, number], mat: MeshLambertMaterial | MeshStandardMaterial, parent: Object3D = root) => {
      const m = new Mesh(new BoxGeometry(...size), mat);
      m.position.set(...at);
      m.castShadow = m.receiveShadow = true;
      parent.add(m);
      return m;
    };

    // Stand: a post on the island, a little cabinet on the boat.
    const standH = o.height - 0.07;
    if (o.body) box([0.3, standH, 0.2], [0, standH / 2, -0.02], wood);
    else {
      box([0.09, standH, 0.09], [0, standH / 2, -0.04], wood);
      box([0.36, 0.04, 0.3], [0, 0.02, -0.04], wood);
    }

    // The case, tilted toward you; its top surface is y = 0 in `top`.
    this.top.position.set(0, o.height, 0);
    this.top.rotation.x = TILT;
    root.add(this.top);
    const t = this.top;
    box([W, 0.1, D], [0, -0.05, 0], wood, t);
    box([W - 0.02, 0.006, D - 0.02], [0, -0.001, 0], dark, t); // foam, standing 2 mm proud of the case
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) box([0.03, 0.104, 0.03], [sx * (W / 2 - 0.012), -0.05, sz * (D / 2 - 0.012)], brass, t);
    // Lid, hinged at the back and standing open, with the instructions inside.
    const lid = new Group();
    lid.position.set(0, 0, -D / 2);
    lid.rotation.x = -(Math.PI / 2 + 0.22);
    t.add(lid);
    box([W, 0.014, D], [0, 0.007, D / 2], wood, lid);
    const card = makeLabel(
      [
        'SIGNAL FLARES',
        'A / X on the pistol: break it open',
        'push a cartridge into the breech',
        'flick it up (or A / X) to close · trigger fires',
        'parachute: slow & bright · star: fast · smoke: colour',
      ],
      { width: W - 0.06, aspect: 0.5, px: 1024, background: 'rgba(28,20,14,0.95)', font: '600 46px system-ui, sans-serif', color: '#ffe9c9' },
    );
    card.rotation.x = Math.PI / 2;
    card.position.set(0, -0.001, D / 2);
    lid.add(card);

    // Cartridges: three rows by type (parachute nearest you), three colours across.
    const rows = ['parachute', 'star', 'smoke'];
    const rowZ = [0.085, 0.01, -0.065];
    const colX = [0.04, 0.105, 0.17];
    for (const k of KINDS) {
      const row = rows.indexOf(k.type);
      const col = KINDS.filter((q) => q.type === k.type).indexOf(k);
      const x = colX[col];
      const z = rowZ[row];
      const base = new Vector3(x, -0.04, z);
      this.slots.push({ kind: k, base, grab: new Vector3(x, -0.04 + SHELL.length * 0.78, z), full: true, refillAt: 0 });
      // A dark hole in the foam under each one.
      const hole = new Mesh(new CylinderGeometry(SHELL.rim * 1.15, SHELL.rim * 1.15, 0.002, 18), dark);
      hole.position.set(x, 0.0028, z);
      t.add(hole);
    }
    // Row names, back to front, spaced to match the rows (0.075 m apart).
    const rowLabel = makeLabel(['SMOKE', 'STAR', 'PARACHUTE'], {
      width: 0.09,
      aspect: 2.6,
      px: 256,
      background: null,
      font: '800 32px system-ui, sans-serif',
      color: '#ffe9c9',
      lineHeight: Math.round((0.075 / (0.09 * 2.6)) * 256 * 2.6),
    });
    rowLabel.rotation.x = -Math.PI / 2;
    rowLabel.position.set(0.245, 0.004, rowZ[1]);
    t.add(rowLabel);
    this.shellMesh = new Mesh(undefined, shellMaterial);
    this.shellMesh.name = 'locker-cartridges';
    this.shellMesh.castShadow = true;
    t.add(this.shellMesh);

    // The pistol lies on its side in the left half: barrel to the left, grip toward you.
    this.holster.position.set(-0.095, 0.02, 0.05);
    this.holster.quaternion.setFromRotationMatrix(new Matrix4().makeBasis(new Vector3(0, -1, 0), new Vector3(0, 0, -1), new Vector3(1, 0, 0)));
    t.add(this.holster);
    this.dockedGun = buildGunModel().root;
    this.dockedGun.name = 'docked-flare-gun';
    this.holster.add(this.dockedGun);

    // Colliders: the stand and the case, in the parent's frame (world, or the boat's).
    root.updateMatrix();
    t.updateMatrix();
    const inParent = (local: Matrix4) => {
      const m = new Matrix4().multiplyMatrices(root.matrix, local);
      const p = new Vector3();
      const q = new Quaternion();
      m.decompose(p, q, new Vector3());
      return { p, q };
    };
    const add = (desc: RAPIER.ColliderDesc, local: Matrix4) => {
      const { p, q } = inParent(local);
      physics.addStatic(desc, { material: 'wood', platform: o.platform }, p, q, o.body);
    };
    add(RAPIER.ColliderDesc.cuboid(o.body ? 0.15 : 0.05, standH / 2, o.body ? 0.1 : 0.05), new Matrix4().makeTranslation(0, standH / 2, o.body ? -0.02 : -0.04));
    add(RAPIER.ColliderDesc.cuboid(W / 2, 0.05, D / 2), new Matrix4().multiplyMatrices(t.matrix, new Matrix4().makeTranslation(0, -0.05, 0)));

    const live = new Set<Object3D>([this.shellMesh, this.dockedGun, card, rowLabel]);
    mergeStatic(root, (x) => live.has(x));
    this.rebuild();
  }

  /** World position of a point given in the case-top frame. */
  topToWorld(local: Vector3, out: Vector3): Vector3 {
    return this.top.localToWorld(out.copy(local));
  }

  slotWorld(s: Slot, out: Vector3): Vector3 {
    return this.topToWorld(s.grab, out);
  }

  /** World pose of a cartridge standing in a slot (its rim at the bottom). */
  slotPose(s: Slot, pos: Vector3, quat: Quaternion): void {
    this.topToWorld(s.base, pos);
    this.top.getWorldQuaternion(quat);
  }

  holsterPose(pos: Vector3, quat: Quaternion): void {
    this.holster.getWorldPosition(pos);
    this.holster.getWorldQuaternion(quat);
  }

  /** The nearest full slot within `reach` of a world point. */
  nearestSlot(p: Vector3, reach: number): Slot | null {
    let best: Slot | null = null;
    let bestD = reach;
    const w = new Vector3();
    for (const s of this.slots) {
      if (!s.full) continue;
      const d = this.slotWorld(s, w).distanceTo(p);
      if (d < bestD) {
        best = s;
        bestD = d;
      }
    }
    return best;
  }

  take(s: Slot): void {
    s.full = false;
    s.refillAt = this.time + REFILL;
    this.rebuild();
  }

  update(dt: number): void {
    this.time += dt;
    let changed = false;
    for (const s of this.slots) {
      if (!s.full && this.time >= s.refillAt) {
        s.full = true;
        changed = true;
      }
    }
    if (changed) this.rebuild();
  }

  refillAll(): void {
    for (const s of this.slots) s.full = true;
    this.rebuild();
  }

  /** One mesh for every cartridge standing in the case (rebuilt when one is taken or replaced). */
  private rebuild(): void {
    const parts: BufferGeometry[] = [];
    for (const s of this.slots) {
      if (!s.full) continue;
      let g = this.geos.get(s.kind.id);
      if (!g) this.geos.set(s.kind.id, (g = shellGeometry(s.kind)));
      parts.push(g.clone().translate(s.base.x, s.base.y, s.base.z));
    }
    const old = this.shellMesh.geometry;
    this.shellMesh.geometry = parts.length ? mergeGeometries(parts)! : new BoxGeometry(0, 0, 0);
    this.shellMesh.visible = parts.length > 0;
    for (const p of parts) p.dispose();
    old?.dispose();
  }
}
