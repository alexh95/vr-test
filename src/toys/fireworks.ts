import {
  BoxGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  Group,
  Matrix4,
  Mesh,
  MeshLambertMaterial,
  MeshStandardMaterial,
  PointLight,
  Quaternion,
  Vector3,
} from 'three';
import { flags } from '../config';
import { bus } from '../core/events';
import { DEG } from '../core/math';
import type { HandInput } from '../input/xr-input';
import { RAPIER, type Prop } from '../physics/physics';
import { faceToward, LAYOUT } from '../world/layout';
import { burst as burstSound, fuseHiss, rocketWhistle } from '../audio/sfx';
import { makeLabel } from '../ui/text';
import { mergeColored, mergeStatic } from '../core/merge';
import type { App } from '../app';

type BurstKind = 'peony' | 'chrysanthemum' | 'ring' | 'willow' | 'crackle' | 'heart';
const KINDS: BurstKind[] = ['peony', 'chrysanthemum', 'ring', 'willow', 'crackle', 'heart'];
const PALETTE = [0xff4d6d, 0xffd166, 0x06d6a0, 0x4cc9ff, 0xb388ff, 0xff8fab, 0xffffff, 0x9ef01a];

interface Flight {
  mesh: Group;
  prop: Prop | null;
  pos: Vector3;
  vel: Vector3;
  dir: Vector3;
  age: number;
  burnTime: number;
  fuse: number; // seconds of fuse left before thrust (0 = flying)
  kind: BurstKind;
  color: Color;
  whistle: ((p: Vector3) => void) | null;
  hiss: ((p: Vector3) => void) | null;
  held: HandInput | null;
}

const _v = new Vector3();
const UP = new Vector3(0, 1, 0);

/** Bottle rockets from the crate, plus a grand finale. */
export class Fireworks {
  readonly rockets: Prop[] = [];
  private readonly flights: Flight[] = [];
  private readonly lit = new Map<Prop, Flight>();
  private readonly respawnAt = new Map<Prop, number>();
  private readonly flash: PointLight | null;
  private flashLevel = 0;
  private readonly crate = new Group();
  private finaleQueue: number[] = [];
  bursts = 0;

  constructor(private readonly app: App) {
    this.flash = flags.quality === 'high' ? new PointLight(0xffffff, 0, 0, 2) : null;
    if (this.flash) app.scene.add(this.flash);
    this.buildCrate();
  }

  private buildCrate(): void {
    const g = this.crate;
    g.name = 'firework-crate';
    g.position.copy(LAYOUT.fireworks);
    faceToward(g);
    this.app.scene.add(g);
    const wood = new MeshLambertMaterial({ color: 0x9c6b3c });
    const dark = new MeshLambertMaterial({ color: 0x5e3b20 });
    const h = 0.42;
    const add = (size: [number, number, number], pos: [number, number, number], mat = wood) => {
      const m = new Mesh(new BoxGeometry(...size), mat);
      m.position.set(...pos);
      m.castShadow = m.receiveShadow = true;
      g.add(m);
      g.updateMatrixWorld(true);
      this.app.physics.addStatic(
        RAPIER.ColliderDesc.cuboid(size[0] / 2, size[1] / 2, size[2] / 2),
        { material: 'wood' },
        m.getWorldPosition(new Vector3()),
        m.getWorldQuaternion(new Quaternion()),
      );
    };
    add([0.62, 0.03, 0.4], [0, h - 0.18, 0], dark); // inner floor
    add([0.62, h, 0.03], [0, h / 2, 0.2]);
    add([0.62, h, 0.03], [0, h / 2, -0.2]);
    add([0.03, h, 0.4], [0.31, h / 2, 0]);
    add([0.03, h, 0.4], [-0.31, h / 2, 0]);
    const label = makeLabel(['Fireworks', 'grab one · trigger lights it · aim up'], {
      width: 0.62,
      aspect: 0.2,
      px: 768,
      background: 'rgba(25,20,35,0.8)',
      font: '600 40px system-ui, sans-serif',
      color: '#ffe9c7',
    });
    label.position.set(0, h + 0.3, -0.21);
    g.add(label);
    mergeStatic(g);
    g.updateMatrixWorld(true);

    for (let i = 0; i < 6; i++) {
      const col = new Color(PALETTE[i % PALETTE.length]);
      const mesh = this.rocketMesh(col);
      this.app.scene.add(mesh);
      const lx = -0.2 + (i % 3) * 0.2;
      const lz = i < 3 ? -0.08 : 0.08;
      const pos = g.localToWorld(new Vector3(lx, h - 0.165 + 0.16, lz));
      const p = this.app.physics.addProp({
        id: `rocket-${i}`,
        object: mesh,
        collider: RAPIER.ColliderDesc.cylinder(0.14, 0.024).setTranslation(0, 0.02, 0),
        position: pos,
        material: 'wood',
        radius: 0.13,
        density: 250,
        angularDamping: 0.8,
        behavior: {
          // Held like a torch: nose along the grip's -Z axis, body in the fist.
          gripOffset: new Matrix4().makeTranslation(0, 0, 0.06).multiply(new Matrix4().makeRotationX(-90 * DEG)),
          pullable: true,
          whileHeld: (hand) => {
            if (hand.trigger.down && !this.lit.has(p)) this.light(p, hand);
          },
        },
      });
      const body = mesh.getObjectByName('body') as Mesh;
      const bm = body.material as MeshStandardMaterial;
      const base = bm.emissive.clone();
      p.onHighlight = (level) => bm.emissive.copy(base).lerp(new Color(0xffd27a), level * 0.5);
      p.object.userData.color = col;
      this.rockets.push(p);
    }
  }

  /** One draw call per rocket: parts merged with vertex colours. */
  private rocketMesh(color: Color): Group {
    const g = new Group();
    g.name = 'rocket';
    const T = (x: number, y: number, z: number, ry = 0) => new Matrix4().makeRotationY(ry).setPosition(x, y, z);
    const geo = mergeColored([
      { geometry: new CylinderGeometry(0.022, 0.022, 0.2, 12), matrix: T(0, 0.03, 0), color },
      { geometry: new CylinderGeometry(0.0225, 0.0225, 0.025, 12), matrix: T(0, 0.07, 0), color: 0xf2f2f2 },
      { geometry: new ConeGeometry(0.024, 0.06, 12), matrix: T(0, 0.16, 0), color: 0xf2f2f2 },
      { geometry: new BoxGeometry(0.075, 0.05, 0.004), matrix: T(0, -0.06, 0), color: 0x2b2d42 },
      { geometry: new BoxGeometry(0.075, 0.05, 0.004), matrix: T(0, -0.06, 0, Math.PI / 2), color: 0x2b2d42 },
      { geometry: new CylinderGeometry(0.002, 0.002, 0.03, 4), matrix: T(0, -0.085, 0), color: 0x333333 },
    ]);
    const body = new Mesh(geo, new MeshStandardMaterial({ vertexColors: true, roughness: 0.6 }));
    body.name = 'body';
    body.castShadow = true;
    g.add(body);
    return g;
  }

  /** Light the fuse of a prop rocket. */
  private light(p: Prop, hand: HandInput | null): void {
    const f: Flight = {
      mesh: p.object as Group,
      prop: p,
      pos: p.object.position.clone(),
      vel: new Vector3(),
      dir: new Vector3(0, 1, 0).applyQuaternion(p.object.quaternion),
      age: 0,
      burnTime: 1.15 + Math.random() * 0.35,
      fuse: 0.85,
      kind: KINDS[Math.floor(Math.random() * KINDS.length)],
      color: (p.object.userData.color as Color) ?? new Color(PALETTE[0]),
      whistle: null,
      hiss: fuseHiss(this.fuseWorld(p.object as Group, new Vector3()), 0.85),
      held: hand,
    };
    this.lit.set(p, f);
    hand?.pulse(0.3, 40);
    bus.emit('rocket-lit', { id: p.id, kind: f.kind });
  }

  private fuseWorld(mesh: Group, out: Vector3): Vector3 {
    return out.set(0, -0.1, 0).applyQuaternion(mesh.quaternion).add(mesh.position);
  }

  /** Big finish: rockets from all around the island rim. */
  finale(): void {
    const now = performance.now();
    for (let i = 0; i < 10; i++) this.finaleQueue.push(now + i * 380 + Math.random() * 150);
  }

  private launchFinaleRocket(): void {
    const ang = Math.random() * Math.PI * 2;
    const r = 6 + Math.random() * 2;
    const ground = this.app.scenery.heightAt(Math.cos(ang) * r, Math.sin(ang) * r) ?? 0;
    const mesh = this.rocketMesh(new Color(PALETTE[Math.floor(Math.random() * PALETTE.length)]));
    const pos = new Vector3(Math.cos(ang) * r, ground + 0.2, Math.sin(ang) * r);
    mesh.position.copy(pos);
    this.app.scene.add(mesh);
    const dir = new Vector3((Math.random() - 0.5) * 0.25, 1, (Math.random() - 0.5) * 0.25).normalize();
    const f: Flight = {
      mesh,
      prop: null,
      pos,
      vel: dir.clone().multiplyScalar(4),
      dir,
      age: 0,
      burnTime: 1.4 + Math.random() * 0.5,
      fuse: 0,
      kind: KINDS[Math.floor(Math.random() * KINDS.length)],
      color: new Color(PALETTE[Math.floor(Math.random() * PALETTE.length)]),
      whistle: rocketWhistle(pos, 1.6),
      hiss: null,
      held: null,
    };
    this.flights.push(f);
  }

  update(dt: number): void {
    const now = performance.now();
    while (this.finaleQueue.length && this.finaleQueue[0] <= now) {
      this.finaleQueue.shift();
      this.launchFinaleRocket();
    }

    // Burning fuses (held or lying around).
    for (const [p, f] of this.lit) {
      f.fuse -= dt;
      const fw = this.fuseWorld(p.object as Group, new Vector3());
      f.hiss?.(fw);
      for (let i = 0; i < 3; i++) {
        this.app.fx.emit({
          position: fw,
          velocity: new Vector3((Math.random() - 0.5) * 1.2, (Math.random() - 0.3) * 1.2, (Math.random() - 0.5) * 1.2),
          color: new Color(0xffc46b),
          colorEnd: new Color(0xff5a1f),
          size: 0.01,
          life: 0.25 + Math.random() * 0.2,
          gravity: 0.6,
          drag: 1.5,
        });
      }
      if (p.heldBy) p.heldBy.pulse(0.12 + Math.random() * 0.1, 18);
      if (f.fuse <= 0) {
        this.lit.delete(p);
        this.takeOff(p, f);
      }
    }

    for (let i = this.flights.length - 1; i >= 0; i--) {
      const f = this.flights[i];
      f.age += dt;
      const thrusting = f.age < f.burnTime;
      if (thrusting) f.vel.addScaledVector(f.dir, 26 * dt);
      f.vel.y -= 9.81 * dt * (this.app.physics.gravityOn ? 1 : 0.15);
      f.vel.multiplyScalar(1 - 0.35 * dt);
      // Nose follows velocity, with a little wobble.
      const sp = f.vel.length();
      if (sp > 0.5) f.dir.lerp(_v.copy(f.vel).multiplyScalar(1 / sp), Math.min(1, dt * 6)).normalize();
      f.dir.x += (Math.random() - 0.5) * 0.02;
      f.dir.z += (Math.random() - 0.5) * 0.02;
      f.dir.normalize();
      const next = _v.copy(f.pos).addScaledVector(f.vel, dt);
      const seg = next.clone().sub(f.pos);
      const segLen = seg.length();
      let hitGround = false;
      if (segLen > 1e-4) {
        const hit = this.app.physics.castWalkable(f.pos, seg.multiplyScalar(1 / segLen), segLen);
        if (hit && f.age > 0.15) hitGround = true;
      }
      f.pos.copy(next);
      f.mesh.position.copy(f.pos);
      f.mesh.quaternion.setFromUnitVectors(UP, f.dir);
      f.whistle?.(f.pos);
      if (thrusting) {
        for (let k = 0; k < 2; k++) {
          this.app.fx.emit({
            position: f.pos.clone().addScaledVector(f.dir, -0.1),
            velocity: f.dir.clone().multiplyScalar(-2 - Math.random() * 2).add(new Vector3((Math.random() - 0.5), (Math.random() - 0.5), (Math.random() - 0.5)).multiplyScalar(0.6)),
            color: new Color(0xffd27a).multiplyScalar(2),
            colorEnd: new Color(0xff4d00),
            size: 0.09,
            sizeEnd: 0.015,
            life: 0.5 + Math.random() * 0.3,
            drag: 2,
            gravity: 0.3,
          });
        }
      }
      if ((f.age > f.burnTime && f.vel.y < 2) || f.age > 3.2 || hitGround) {
        this.explode(f);
        this.flights.splice(i, 1);
      }
    }

    // Rockets come back to the crate a few seconds after they burst.
    for (const [p, at] of this.respawnAt) {
      if (now >= at) {
        this.respawnAt.delete(p);
        p.parked = false;
        p.manual = false;
        p.object.visible = true;
        p.collider.setEnabled(true);
        this.app.physics.respawn(p);
      }
    }

    if (this.flash) {
      this.flashLevel *= Math.exp(-dt * 7);
      this.flash.intensity = this.flashLevel;
    }
  }

  private takeOff(p: Prop, f: Flight): void {
    const hand = p.heldBy;
    if (hand) {
      this.app.grab.forceRelease(hand);
      hand.pulse(1, 90);
      f.vel.copy(hand.velocity);
    } else {
      const lv = p.body.linvel();
      f.vel.set(lv.x, lv.y, lv.z);
    }
    f.pos.copy(p.object.position);
    f.dir.set(0, 1, 0).applyQuaternion(p.object.quaternion).normalize();
    f.vel.addScaledVector(f.dir, 5);
    // The prop leaves physics while it flies.
    p.manual = true;
    p.parked = true;
    p.collider.setEnabled(false);
    p.body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, false);
    f.whistle = rocketWhistle(f.pos, f.burnTime + 0.4);
    this.flights.push(f);
    bus.emit('rocket-launch', { id: p.id, kind: f.kind, fromHand: !!hand });
  }

  private explode(f: Flight): void {
    const at = f.pos.clone();
    const head = this.app.headPosition(new Vector3());
    const distance = at.distanceTo(head);
    const fx = this.app.fx;
    // Particles are glowing balls of light seen from 20-40 m: big and over-bright (additive, HDR).
    const c = f.color.clone().multiplyScalar(2.6);
    const c2 = new Color(PALETTE[Math.floor(Math.random() * PALETTE.length)]).multiplyScalar(2.4);
    const gravity = this.app.physics.gravityOn ? 1 : 0.1;
    switch (f.kind) {
      case 'peony':
        fx.burst(at, 170, 9, c, { size: 0.55, sizeEnd: 0.12, life: 1.6, drag: 1.6, gravity: 0.35 * gravity });
        fx.burst(at, 50, 4, c2, { size: 0.45, sizeEnd: 0.1, life: 1.2, drag: 1.8, gravity: 0.3 * gravity });
        break;
      case 'chrysanthemum':
        fx.burst(at, 200, 10, c, { colorEnd: new Color(0xffb347).multiplyScalar(2), size: 0.5, sizeEnd: 0.08, life: 2.1, drag: 1.4, gravity: 0.45 * gravity });
        break;
      case 'ring': {
        const axis = new Vector3(Math.random() - 0.5, Math.random() * 0.5 + 0.5, Math.random() - 0.5).normalize();
        const tangent = new Vector3(1, 0, 0).cross(axis).normalize();
        for (let i = 0; i < 110; i++) {
          const ang = (i / 110) * Math.PI * 2;
          const dir = tangent.clone().applyAxisAngle(axis, ang);
          fx.emit({ position: at, velocity: dir.multiplyScalar(8.5), color: c, size: 0.55, sizeEnd: 0.1, life: 1.6, drag: 1.5, gravity: 0.3 * gravity });
        }
        fx.burst(at, 30, 2.5, c2, { size: 0.4, life: 1.0, drag: 2 });
        break;
      }
      case 'willow':
        fx.burst(at, 160, 7, new Color(0xffc86b).multiplyScalar(2.4), { colorEnd: new Color(0x8a4b00), size: 0.42, sizeEnd: 0.14, life: 3.3, drag: 1.1, gravity: 0.7 * gravity });
        break;
      case 'crackle':
        fx.burst(at, 140, 8, new Color(0xffffff).multiplyScalar(2.5), { colorEnd: c, size: 0.42, life: 1.9, drag: 1.5, gravity: 0.4 * gravity, flicker: 0.8 });
        break;
      case 'heart': {
        // A heart that faces you.
        const toHead = head.clone().sub(at).setY(0).normalize();
        const right = new Vector3(0, 1, 0).cross(toHead).normalize();
        const pink = new Color(0xff4d8d).multiplyScalar(2.6);
        for (let i = 0; i < 140; i++) {
          const t = (i / 140) * Math.PI * 2;
          const x = 16 * Math.pow(Math.sin(t), 3);
          const y = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
          const dir = right.clone().multiplyScalar(x / 16).add(new Vector3(0, y / 16, 0));
          fx.emit({ position: at, velocity: dir.multiplyScalar(7.5), color: pink, size: 0.55, sizeEnd: 0.14, life: 1.8, drag: 1.2, gravity: 0.12 * gravity });
        }
        break;
      }
    }
    if (this.flash) {
      this.flash.position.copy(at);
      this.flash.color.copy(c);
      this.flashLevel = 2600;
    }
    burstSound(at, distance, f.kind === 'crackle' || f.kind === 'chrysanthemum');
    f.mesh.visible = false;
    if (f.prop) {
      this.respawnAt.set(f.prop, performance.now() + 2500);
    } else {
      f.mesh.removeFromParent();
    }
    this.bursts++;
    bus.emit('rocket-burst', { kind: f.kind, height: +at.y.toFixed(1), distance: +distance.toFixed(1) });
  }

  /** Put every crate rocket back (reset button). */
  reset(): void {
    for (const p of this.rockets) {
      if (this.lit.has(p)) {
        this.lit.delete(p);
      }
      if (p.parked || this.flights.some((f) => f.prop === p)) continue;
      if (p.heldBy) this.app.grab.forceRelease(p.heldBy);
      this.app.physics.respawn(p);
    }
  }

  get flying(): number {
    return this.flights.length;
  }
}
