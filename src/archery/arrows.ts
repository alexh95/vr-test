import { BoxGeometry, type BufferGeometry, Color, ConeGeometry, CylinderGeometry, Matrix4, Mesh, MeshStandardMaterial, Quaternion, Vector3 } from 'three';
import { bus } from '../core/events';
import { mergeColored } from '../core/merge';
import { RAPIER } from '../physics/physics';
import { arrowWhoosh, impact } from '../audio/sfx';
import type { App } from '../app';

/** Nock (the arrow's local origin) to tip, along -Z. */
export const ARROW_LEN = 0.8;
const ARROW_MASS = 0.025; // kg, for knocking props around
const MAX_ARROWS = 40;
const STUCK_LIFETIME = 60; // s

export type ArrowState = 'idle' | 'nocked' | 'flying' | 'falling' | 'stuck';

export interface Arrow {
  mesh: Mesh;
  state: ArrowState;
  /** Nock (tail) position in world space. */
  pos: Vector3;
  vel: Vector3;
  age: number;
  from: Vector3;
  whoosh: ((p: Vector3) => void) | null;
}

const FWD = new Vector3(0, 0, -1);
const _dir = new Vector3();
const _tip0 = new Vector3();
const _tip1 = new Vector3();
const _seg = new Vector3();
const _q = new Quaternion();

function arrowGeometry() {
  const along = (z: number) => new Matrix4().makeRotationX(Math.PI / 2).setPosition(0, 0, z);
  const shaftLen = ARROW_LEN - 0.05;
  const parts: { geometry: BufferGeometry; matrix: Matrix4; color: number }[] = [
    { geometry: new CylinderGeometry(0.0042, 0.0042, shaftLen, 6), matrix: along(-shaftLen / 2 - 0.004), color: 0xe9dcc4 },
    { geometry: new ConeGeometry(0.0085, 0.05, 8), matrix: new Matrix4().makeRotationX(-Math.PI / 2).setPosition(0, 0, -(ARROW_LEN - 0.025)), color: 0xd4af37 },
    { geometry: new CylinderGeometry(0.0052, 0.0052, 0.018, 6), matrix: along(-0.004), color: 0x2b2d42 },
  ];
  // Three vanes, 120° apart; the white one is the cock feather.
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    const m = new Matrix4()
      .makeRotationZ(a)
      .multiply(new Matrix4().makeTranslation(0, 0.0105, -0.07));
    parts.push({ geometry: new BoxGeometry(0.0012, 0.013, 0.085), matrix: m, color: i === 0 ? 0xf7f3ea : 0x4cc9f0 });
  }
  return mergeColored(parts);
}

/** Every arrow in the world: nocked on the bow, in flight, or stuck in something. */
export class ArrowSystem {
  readonly arrows: Arrow[] = [];
  flying = 0;

  constructor(private readonly app: App) {
    const geo = arrowGeometry();
    const mat = new MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.1, emissive: new Color(0x0c1a26) });
    for (let i = 0; i < MAX_ARROWS; i++) {
      const mesh = new Mesh(geo, mat);
      mesh.name = 'arrow';
      mesh.castShadow = true;
      mesh.visible = false;
      mesh.frustumCulled = false;
      app.scene.add(mesh);
      this.arrows.push({ mesh, state: 'idle', pos: new Vector3(), vel: new Vector3(), age: 0, from: new Vector3(), whoosh: null });
    }
  }

  /** A free arrow, recycling the oldest stuck one if all are in use. */
  private take(): Arrow {
    let a = this.arrows.find((x) => x.state === 'idle');
    if (!a) {
      a = this.arrows.filter((x) => x.state === 'stuck' || x.state === 'falling').sort((p, q) => q.age - p.age)[0] ?? this.arrows[0];
      this.release(a);
    }
    return a;
  }

  private release(a: Arrow): void {
    a.state = 'idle';
    a.mesh.visible = false;
    a.whoosh = null;
    if (a.mesh.parent !== this.app.scene) this.app.scene.add(a.mesh);
  }

  /** A new arrow for the bow to hold on the string. */
  nock(): Arrow {
    const a = this.take();
    a.state = 'nocked';
    a.age = 0;
    a.mesh.visible = true;
    return a;
  }

  /** Put an arrow's nock at `tail`, pointing along `dir`. */
  place(a: Arrow, tail: Vector3, dir: Vector3): void {
    a.pos.copy(tail);
    a.mesh.position.copy(tail);
    a.mesh.quaternion.setFromUnitVectors(FWD, _dir.copy(dir).normalize());
  }

  /** Let go of a nocked arrow without shooting it. */
  drop(a: Arrow): void {
    if (a.state === 'nocked') this.release(a);
  }

  fire(a: Arrow, tail: Vector3, dir: Vector3, speed: number): void {
    this.place(a, tail, dir);
    a.state = 'flying';
    a.age = 0;
    a.from.copy(tail);
    a.vel.copy(dir).normalize().multiplyScalar(speed);
    a.whoosh = arrowWhoosh(tail, 0.9);
  }

  update(dt: number): void {
    const physics = this.app.physics;
    const g = physics.gravityOn ? 9.81 : 0;
    this.flying = 0;
    for (const a of this.arrows) {
      if (a.state === 'idle' || a.state === 'nocked') continue;
      a.age += dt;
      if (a.state === 'stuck') {
        if (a.age > STUCK_LIFETIME) this.release(a);
        continue;
      }
      if (a.state === 'flying') this.flying++;
      if (a.age > 9 || a.pos.y < -80) {
        this.release(a);
        continue;
      }
      // Integrate: gravity, a little drag; the arrow points where it's going.
      const speed0 = a.vel.length();
      _dir.copy(a.vel).multiplyScalar(1 / Math.max(speed0, 1e-6));
      _tip0.copy(a.pos).addScaledVector(_dir, ARROW_LEN);
      a.vel.y -= g * dt;
      a.vel.multiplyScalar(1 - (a.state === 'flying' ? 0.006 : 0.3) * dt);
      const next = new Vector3().copy(a.pos).addScaledVector(a.vel, dt);
      const speed = a.vel.length();
      const dir1 = new Vector3().copy(a.vel).multiplyScalar(1 / Math.max(speed, 1e-6));
      _tip1.copy(next).addScaledVector(dir1, ARROW_LEN);
      _seg.subVectors(_tip1, _tip0);
      const len = _seg.length();

      // Through a portal: out of its twin, still flying (this frame's remaining flight is free).
      const crossing = this.app.portals.through(_tip0, _tip1);
      if (crossing) {
        next.applyMatrix4(crossing.m);
        a.vel.applyQuaternion(crossing.q);
        dir1.applyQuaternion(crossing.q);
        a.from.applyMatrix4(crossing.m);
        a.pos.copy(next);
        a.mesh.position.copy(next);
        a.mesh.quaternion.setFromUnitVectors(FWD, dir1);
        a.whoosh?.(next);
        bus.emit('portal-transit', { what: 'arrow', to: crossing.portal.partner.id });
        continue;
      }

      // What does the tip pass through this frame? Targets/balloons analytically, the world via Rapier.
      const rangeHit = a.state === 'flying' ? this.app.range.raycast(_tip0, _tip1) : null;
      let worldT = Infinity;
      let worldCollider: RAPIER.Collider | null = null;
      if (len > 1e-5) {
        // World geometry (the moving skyboat included) and free props; never the bow or hands.
        const hit = physics.castSolid(_tip0, _seg.clone().multiplyScalar(1 / len), len, a.state === 'flying');
        if (hit) {
          worldT = hit.dist / len;
          worldCollider = hit.collider;
        }
      }

      if (rangeHit && rangeHit.t <= worldT) {
        const distance = rangeHit.point.distanceTo(a.from);
        if (rangeHit.kind === 'balloon') {
          this.app.range.pop(rangeHit.balloon!, distance);
        } else {
          const t = rangeHit.target!;
          this.stick(a, rangeHit.point, dir1, 0.07);
          t.group.attach(a.mesh);
          this.app.range.scoreHit(t, rangeHit.point, distance);
          bus.emit('arrow-hit', { what: t.id, distance: +distance.toFixed(1) });
          continue;
        }
      } else if (worldCollider) {
        const point = new Vector3().copy(_tip0).addScaledVector(_seg, worldT);
        const prop = physics.propByCollider.get(worldCollider.handle);
        if (prop && !prop.heldBy) {
          // Knock it: the arrow's momentum goes into the prop, and the arrow tumbles away.
          const p = dir1.clone().multiplyScalar(speed * ARROW_MASS);
          prop.body.applyImpulseAtPoint(p, point, true);
          impact(point, prop.material, Math.min(1, speed / 40));
          a.state = 'falling';
          a.vel.multiplyScalar(-0.08).add(new Vector3((Math.random() - 0.5) * 1.5, 1.2, (Math.random() - 0.5) * 1.5));
          a.age = Math.max(a.age, 6.5);
          bus.emit('arrow-hit', { what: prop.id, distance: +point.distanceTo(a.from).toFixed(1) });
          continue;
        }
        const info = physics.staticInfo.get(worldCollider.handle);
        this.stick(a, point, dir1, a.state === 'flying' ? 0.06 : 0.01);
        // Stuck in something that moves (the skyboat): ride along with it.
        info?.platform?.attach(a.mesh);
        impact(point, info?.material ?? 'wood', Math.min(1, speed / 50));
        if (a.state === 'flying') bus.emit('arrow-hit', { what: info?.walkable ? 'ground' : 'scenery', distance: +point.distanceTo(a.from).toFixed(1) });
        continue;
      }

      a.pos.copy(next);
      a.mesh.position.copy(next);
      if (a.state === 'flying') {
        a.mesh.quaternion.setFromUnitVectors(FWD, dir1);
        a.whoosh?.(next);
        if (a.age < 0.5) {
          this.app.fx.emit({ position: next, color: new Color(0x9fe3ff), size: 0.018, sizeEnd: 0.004, life: 0.25, alpha: 0.6 });
        }
      } else {
        // Tumbling after a deflection.
        _q.setFromAxisAngle(new Vector3(1, 0, 0), dt * 9);
        a.mesh.quaternion.multiply(_q);
      }
    }
  }

  /** Embed the arrow so its tip sits `depth` past the hit point. */
  private stick(a: Arrow, point: Vector3, dir: Vector3, depth: number): void {
    a.state = 'stuck';
    a.age = 0;
    a.whoosh = null;
    const tail = new Vector3().copy(point).addScaledVector(dir, depth - ARROW_LEN);
    this.place(a, tail, dir);
  }

  /** Remove every arrow (reset). */
  clear(): void {
    for (const a of this.arrows) if (a.state !== 'nocked') this.release(a);
  }

  get stuck(): number {
    return this.arrows.filter((a) => a.state === 'stuck').length;
  }
}
