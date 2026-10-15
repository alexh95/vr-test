import {
  BoxGeometry,
  Color,
  CylinderGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  MeshStandardMaterial,
  Quaternion,
  SphereGeometry,
  Vector3,
} from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { RAPIER, type Prop } from '../physics/physics';
import { faceToward, LAYOUT } from '../world/layout';
import { poof } from '../audio/sfx';
import { mergeStatic } from '../core/merge';
import type { App } from '../app';

const HIGHLIGHT = new Color(0xffd27a);

const woodLight = new MeshLambertMaterial({ color: 0xb98a5a });
const woodDark = new MeshLambertMaterial({ color: 0x7a5233 });
const stone = new MeshLambertMaterial({ color: 0x9a9088, flatShading: true });

/** Give a lit material an emissive highlight driven by Prop.highlight. */
function litHighlight(p: Prop, mat: MeshStandardMaterial | MeshLambertMaterial): void {
  const base = mat.emissive.clone();
  p.onHighlight = (level) => mat.emissive.copy(base).lerp(HIGHLIGHT, Math.min(1, level) * 0.55);
}

/**
 * The physics toys: a table of balls and blocks, a tin-can pyramid to knock
 * down from across the island, and glowing orbs placed out of reach for the
 * gravity gloves.
 */
export class Toys {
  readonly props: Prop[] = [];
  readonly orbs: Prop[] = [];
  readonly balls: Prop[] = [];
  readonly cans: Prop[] = [];
  readonly floaters = new Set<Prop>();
  readonly root = new Group();
  private readonly orbMats = new Map<Prop, { mat: MeshBasicMaterial; base: Color }>();

  constructor(private readonly app: App) {
    this.root.name = 'toys';
    app.scene.add(this.root);
    this.buildTable();
    this.buildCans();
    this.buildOrbs();
    const dynamic = new Set(this.props.map((p) => p.object));
    mergeStatic(this.root, (o) => dynamic.has(o));
  }

  private addStaticBox(parent: Group, size: [number, number, number], pos: [number, number, number], mat = woodLight, walkable = false): Mesh {
    const mesh = new Mesh(new BoxGeometry(...size), mat);
    mesh.position.set(...pos);
    mesh.castShadow = mesh.receiveShadow = true;
    parent.add(mesh);
    parent.updateMatrixWorld(true);
    const wp = mesh.getWorldPosition(new Vector3());
    const wq = mesh.getWorldQuaternion(new Quaternion());
    this.app.physics.addStatic(RAPIER.ColliderDesc.cuboid(size[0] / 2, size[1] / 2, size[2] / 2), { walkable, material: mat === stone ? 'stone' : 'wood' }, wp, wq);
    return mesh;
  }

  private buildTable(): void {
    const t = new Group();
    t.name = 'toy-table';
    t.position.copy(LAYOUT.table);
    faceToward(t);
    this.root.add(t);
    const topY = 0.76;
    this.addStaticBox(t, [1.3, 0.05, 0.64], [0, topY, 0]);
    // Rim so balls don't roll straight off.
    this.addStaticBox(t, [1.3, 0.035, 0.02], [0, topY + 0.042, 0.31], woodDark);
    this.addStaticBox(t, [1.3, 0.035, 0.02], [0, topY + 0.042, -0.31], woodDark);
    this.addStaticBox(t, [0.02, 0.035, 0.6], [0.64, topY + 0.042, 0], woodDark);
    this.addStaticBox(t, [0.02, 0.035, 0.6], [-0.64, topY + 0.042, 0], woodDark);
    for (const [x, z] of [[-0.58, -0.26], [0.58, -0.26], [-0.58, 0.26], [0.58, 0.26]]) {
      const leg = new Mesh(new BoxGeometry(0.06, topY - 0.025, 0.06), woodDark);
      leg.position.set(x, (topY - 0.025) / 2, z);
      leg.castShadow = true;
      t.add(leg);
    }
    t.updateMatrixWorld(true);
    const surface = topY + 0.025;

    const ballColors = [0xff5d5d, 0xffd23f, 0x4dabf7, 0x69db7c, 0xc77dff];
    const ballSpots: [number, number][] = [[-0.48, -0.12], [-0.34, 0.1], [-0.52, 0.14], [-0.2, -0.1], [-0.36, -0.16]];
    ballSpots.forEach(([x, z], i) => {
      const r = 0.055;
      const mat = new MeshStandardMaterial({ color: ballColors[i], roughness: 0.45, metalness: 0 });
      const mesh = new Mesh(new SphereGeometry(r, 20, 14), mat);
      mesh.castShadow = true;
      this.root.add(mesh);
      const p = this.app.physics.addProp({
        id: `ball-${i}`,
        object: mesh,
        collider: RAPIER.ColliderDesc.ball(r),
        position: t.localToWorld(new Vector3(x, surface + r + 0.002, z)),
        material: 'rubber',
        radius: r,
        density: 220,
        restitution: 0.72,
        friction: 0.9,
        angularDamping: 0.6,
        behavior: { pullable: true },
      });
      litHighlight(p, mat);
      this.props.push(p);
      this.balls.push(p);
    });

    // A little 3-2-1 pyramid of toy blocks.
    const e = 0.075;
    const blockColors = [0xf4a261, 0x2a9d8f, 0xe76f51, 0x8ab17d, 0xe9c46a, 0x6d9dc5];
    let k = 0;
    const tq = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), t.rotation.y);
    for (let row = 0; row < 3; row++) {
      for (let i = 0; i < 3 - row; i++) {
        const x = 0.2 + (i - (2 - row) / 2) * (e + 0.004);
        const y = surface + e / 2 + row * (e + 0.0015) + 0.001;
        const mat = new MeshStandardMaterial({ color: blockColors[k % blockColors.length], roughness: 0.7 });
        const mesh = new Mesh(new RoundedBoxGeometry(e, e, e, 2, 0.008), mat);
        mesh.castShadow = mesh.receiveShadow = true;
        this.root.add(mesh);
        const p = this.app.physics.addProp({
          id: `block-${k}`,
          object: mesh,
          collider: RAPIER.ColliderDesc.roundCuboid(e / 2 - 0.006, e / 2 - 0.006, e / 2 - 0.006, 0.006),
          position: t.localToWorld(new Vector3(x, y, 0.02)),
          quaternion: tq.clone(),
          material: 'wood',
          radius: e * 0.75,
          density: 600,
          friction: 0.8,
          restitution: 0.1,
          behavior: { pullable: true },
        });
        litHighlight(p, mat);
        this.props.push(p);
        k++;
      }
    }
  }

  private buildCans(): void {
    const g = new Group();
    g.name = 'can-pyramid';
    g.position.copy(LAYOUT.cans);
    faceToward(g);
    this.root.add(g);
    const h = 0.95;
    this.addStaticBox(g, [1.0, h, 0.42], [0, h / 2, 0], stone);
    g.updateMatrixWorld(true);
    const r = 0.042;
    const ch = 0.12;
    const colors = [0xd64545, 0xe8e8e8, 0xf2b134, 0x3d8bd9];
    const geo = new CylinderGeometry(r, r, ch, 18);
    let k = 0;
    for (let row = 0; row < 4; row++) {
      for (let i = 0; i < 4 - row; i++) {
        const x = (i - (3 - row) / 2) * (2 * r + 0.006);
        const y = h + ch / 2 + row * (ch + 0.002) + 0.002;
        const mat = new MeshStandardMaterial({ color: colors[(k + row) % colors.length], roughness: 0.35, metalness: 0.35 });
        const mesh = new Mesh(geo, mat);
        mesh.castShadow = true;
        this.root.add(mesh);
        const p = this.app.physics.addProp({
          id: `can-${k}`,
          object: mesh,
          collider: RAPIER.ColliderDesc.cylinder(ch / 2, r),
          position: g.localToWorld(new Vector3(x, y, 0)),
          material: 'tin',
          radius: 0.07,
          density: 160,
          friction: 0.55,
          restitution: 0.2,
          behavior: { pullable: true },
        });
        litHighlight(p, mat);
        this.props.push(p);
        this.cans.push(p);
        k++;
      }
    }
    // A sign: "Throw from the table"
  }

  private buildOrbs(): void {
    const physics = this.app.physics;
    const sc = this.app.scenery;
    const plinth = (pos: Vector3, height: number) => {
      const m = new Mesh(new CylinderGeometry(0.11, 0.15, height, 8), stone);
      m.position.copy(pos).y += height / 2;
      m.castShadow = m.receiveShadow = true;
      this.root.add(m);
      physics.addStatic(RAPIER.ColliderDesc.cylinder(height / 2, 0.11), { material: 'stone' }, m.position.clone());
      return pos.clone().setY(pos.y + height);
    };
    const spots: { at: Vector3; float?: boolean }[] = [];
    for (const s of sc.stonePositions) {
      const h = sc.heightAt(s.x, s.z) ?? s.y;
      spots.push({ at: plinth(new Vector3(s.x, h, s.z), 0.3) });
    }
    const sat = sc.satelliteCenter;
    for (const [dx, dz] of [[0.9, 0.6], [-1.1, -0.4]]) {
      const x = sat.x + dx;
      const z = sat.z + dz;
      spots.push({ at: plinth(new Vector3(x, sc.heightAt(x, z) ?? sat.y, z), 0.45) });
    }
    // A stone pillar at the west rim with an orb on top.
    const pil = LAYOUT.pillar;
    const ph = sc.heightAt(pil.x, pil.z) ?? 0;
    const pillarH = 2.5;
    const pillar = new Mesh(new CylinderGeometry(0.3, 0.42, pillarH, 7), stone);
    pillar.position.set(pil.x, ph + pillarH / 2 - 0.05, pil.z);
    pillar.castShadow = pillar.receiveShadow = true;
    this.root.add(pillar);
    physics.addStatic(RAPIER.ColliderDesc.cylinder(pillarH / 2, 0.36), { material: 'stone' }, pillar.position.clone());
    spots.push({ at: new Vector3(pil.x, ph + pillarH - 0.05, pil.z) });
    // Two orbs hovering in the air: only the gloves can reach them.
    spots.push({ at: new Vector3(-1.4, 5.2, -6.2), float: true });
    spots.push({ at: new Vector3(4.6, 3.6, 4.2), float: true });

    const orbColors = [0x6ff7ff, 0xff8fe3, 0xb48cff, 0x7dffc0, 0xffe066, 0x9ad0ff, 0xff9f6e, 0xc0ff8a];
    spots.forEach((s, i) => {
      const r = 0.065;
      const base = new Color(orbColors[i % orbColors.length]);
      const mat = new MeshBasicMaterial({ color: base.clone() });
      const mesh = new Mesh(new SphereGeometry(r, 20, 14), mat);
      const halo = new Mesh(new SphereGeometry(r * 1.6, 16, 10), new MeshBasicMaterial({ color: base, transparent: true, opacity: 0.18, depthWrite: false }));
      mesh.add(halo);
      this.root.add(mesh);
      const p = physics.addProp({
        id: `orb-${i}`,
        object: mesh,
        collider: RAPIER.ColliderDesc.ball(r),
        position: s.at.clone().setY(s.at.y + r + 0.003),
        material: 'glass',
        radius: r,
        density: 400,
        restitution: 0.35,
        friction: 0.6,
        angularDamping: 0.8,
        behavior: {
          pullable: true,
          onGrab: () => this.land(p),
          onPull: () => this.land(p),
        },
      });
      this.orbMats.set(p, { mat, base });
      p.onHighlight = (level) => mat.color.copy(base).multiplyScalar(this.glow * (1 + level * 0.9));
      if (s.float) {
        this.floaters.add(p);
        p.body.setGravityScale(0, true);
        p.body.setLinearDamping(0.8);
      }
      this.props.push(p);
      this.orbs.push(p);
    });
    this.app.physics.onRespawn = (p) => {
      if (this.orbs.includes(p) && p.spawnPos.y > 3) {
        this.floaters.add(p);
        p.body.setGravityScale(0, true);
      }
    };
  }

  private glow = 1;

  /** A hovering orb becomes a normal object once you take it. */
  private land(p: Prop): void {
    if (!this.floaters.delete(p)) return;
    p.body.setGravityScale(1, true);
    p.body.setLinearDamping(this.app.physics.gravityOn ? 0.02 : 0.08);
  }

  /** Orbs glow brighter at night. */
  setGlow(glow: number): void {
    this.glow = Math.max(0.9, glow * 0.8);
    for (const [p, { mat, base }] of this.orbMats) mat.color.copy(base).multiplyScalar(this.glow * (1 + p.highlight * 0.9));
  }

  update(time: number): void {
    // Hovering orbs bob gently around their spawn point.
    for (const p of this.floaters) {
      if (p.heldBy || p.manual) continue;
      const pos = p.body.translation();
      const target = p.spawnPos;
      const bob = Math.sin(time * 1.3 + p.spawnPos.x) * 0.08;
      p.body.applyImpulse(
        { x: (target.x - pos.x) * 0.002, y: (target.y + bob - pos.y) * 0.004, z: (target.z - pos.z) * 0.002 },
        true,
      );
    }
  }

  /** Everything back where it started. */
  reset(): void {
    for (const p of this.props) {
      if (p.heldBy) this.app.grab.forceRelease(p.heldBy);
      this.app.physics.respawn(p);
      if (this.floaters.has(p) || (this.orbs.includes(p) && p.spawnPos.y > 3)) {
        this.floaters.add(p);
        p.body.setGravityScale(0, true);
      }
    }
    poof(LAYOUT.table.clone().setY(1));
    this.app.fx.burst(LAYOUT.table.clone().setY(1), 30, 1.5, new Color(0xffe7b0), { size: 0.03, life: 0.6, drag: 3 });
  }
}
