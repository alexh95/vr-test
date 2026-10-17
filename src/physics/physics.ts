import RAPIER from '@dimforge/rapier3d-compat';
import { Matrix4, Object3D, Quaternion, Vector3 } from 'three';
import { GRAVITY, MAX_SUBSTEPS, PHYSICS_DT } from '../config';
import { bus } from '../core/events';
import { impact, type ImpactMaterial } from '../audio/sfx';
import type { HandInput } from '../input/xr-input';

export { RAPIER };

/** Collision groups: (membership << 16) | filter. */
export const GROUP_STATIC = (0x0001 << 16) | 0xffff;
export const GROUP_PROP = (0x0002 << 16) | 0xffff;
export const GROUP_HAND = (0x0004 << 16) | 0x0002;

export interface PropBehavior {
  /** Where the object sits in the hand (object pose relative to grip). Free grab if absent. */
  gripOffset?: Matrix4;
  /** Gravity gloves can pull it. */
  pullable?: boolean;
  onGrab?(hand: HandInput): void;
  onRelease?(hand: HandInput): void;
  /** Gravity gloves launched it toward a hand. */
  onPull?(): void;
  /** Full control of the held pose (world). Return true to use it instead of grip × offset. */
  poseOverride?(hand: HandInput, outPos: Vector3, outQuat: Quaternion): boolean;
  /** Called every frame while held, after the object has been placed. */
  whileHeld?(hand: HandInput, dt: number): void;
}

export interface Prop {
  id: string;
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  object: Object3D;
  material: ImpactMaterial;
  /** Bounding radius used for grabbing and gloves. */
  radius: number;
  mass: number;
  spawnPos: Vector3;
  spawnQuat: Quaternion;
  prevPos: Vector3;
  prevQuat: Quaternion;
  currPos: Vector3;
  currQuat: Quaternion;
  heldBy: HandInput | null;
  /** Visual is driven by something else this frame (held, flying rocket, …). */
  manual: boolean;
  lastImpact: number;
  behavior: PropBehavior;
  /** Hidden and parked (e.g. a launched rocket waiting to respawn). */
  parked: boolean;
  /** Emissive highlight 0..1 (gravity-glove targeting), applied by the owner. */
  highlight: number;
  onHighlight?(level: number): void;
}

export interface StaticInfo {
  walkable: boolean;
  material: ImpactMaterial;
  /** Called when a prop hits this collider hard enough (e.g. a marimba bar). */
  onHit?(prop: Prop, strength: number): void;
  /** The collider rides on this moving object (the skyboat): convert hit points into its frame. */
  platform?: Object3D;
  /** Thin things you step through or over (the portal's hoop): checks for the ground under your feet ignore them. */
  stepOver?: boolean;
}

export interface PropOptions {
  id: string;
  object: Object3D;
  collider: RAPIER.ColliderDesc;
  position: Vector3;
  quaternion?: Quaternion;
  material: ImpactMaterial;
  radius: number;
  density?: number;
  friction?: number;
  restitution?: number;
  ccd?: boolean;
  angularDamping?: number;
  behavior?: PropBehavior;
}

const _v = new Vector3();

export class Physics {
  readonly world: RAPIER.World;
  private readonly events: RAPIER.EventQueue;
  readonly props: Prop[] = [];
  readonly propByCollider = new Map<number, Prop>();
  readonly staticInfo = new Map<number, StaticInfo>();
  private accumulator = 0;
  /** Interpolation factor between the last two physics states. */
  alpha = 0;
  gravityOn = true;
  steps = 0;
  /**
   * Callback run before each fixed step (kinematic targets). `ahead` is how far past
   * the current frame time this step's state will be shown: interpolated props are
   * drawn one step behind, so kinematic platforms lead by that much to line up.
   */
  beforeStep: ((dt: number, ahead: number) => void) | null = null;
  /** Callback run after each fixed step (props crossing portals). */
  afterStep: (() => void) | null = null;
  /** Called when a prop falls out of the world and respawns. */
  onRespawn: ((p: Prop) => void) | null = null;

  static async create(): Promise<Physics> {
    await RAPIER.init();
    return new Physics();
  }

  private constructor() {
    this.world = new RAPIER.World({ x: 0, y: GRAVITY, z: 0 });
    this.world.timestep = PHYSICS_DT;
    this.world.numSolverIterations = 6;
    this.events = new RAPIER.EventQueue(true);
  }

  /**
   * World geometry: walls, floors, islands. With `parent`, the collider rides on that
   * (kinematic) body, like the skyboat's deck, and position/quaternion are relative to it.
   */
  addStatic(desc: RAPIER.ColliderDesc, info: Partial<StaticInfo> = {}, position?: Vector3, quaternion?: Quaternion, parent?: RAPIER.RigidBody): RAPIER.Collider {
    if (position) desc.setTranslation(position.x, position.y, position.z);
    if (quaternion) desc.setRotation(quaternion);
    desc.setCollisionGroups(GROUP_STATIC);
    if (info.onHit) desc.setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(0.5);
    const c = this.world.createCollider(desc, parent);
    this.staticInfo.set(c.handle, { walkable: info.walkable ?? false, material: info.material ?? 'stone', onHit: info.onHit, platform: info.platform, stepOver: info.stepOver });
    return c;
  }

  addProp(o: PropOptions): Prop {
    const q = o.quaternion ?? new Quaternion();
    const bd = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(o.position.x, o.position.y, o.position.z)
      .setRotation(q)
      .setCcdEnabled(o.ccd ?? true)
      .setAngularDamping(o.angularDamping ?? 0.15)
      .setLinearDamping(0.02);
    const body = this.world.createRigidBody(bd);
    o.collider
      .setDensity(o.density ?? 500)
      .setFriction(o.friction ?? 0.7)
      .setRestitution(o.restitution ?? 0.2)
      .setCollisionGroups(GROUP_PROP)
      .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS);
    const collider = this.world.createCollider(o.collider, body);
    const mass = body.mass();
    // Above resting weight, so only real impacts make noise.
    collider.setContactForceEventThreshold(mass * -GRAVITY * 3 + 0.6);
    o.object.position.copy(o.position);
    o.object.quaternion.copy(q);
    const prop: Prop = {
      id: o.id,
      body,
      collider,
      object: o.object,
      material: o.material,
      radius: o.radius,
      mass,
      spawnPos: o.position.clone(),
      spawnQuat: q.clone(),
      prevPos: o.position.clone(),
      prevQuat: q.clone(),
      currPos: o.position.clone(),
      currQuat: q.clone(),
      heldBy: null,
      manual: false,
      lastImpact: 0,
      behavior: o.behavior ?? {},
      parked: false,
      highlight: 0,
    };
    this.props.push(prop);
    this.propByCollider.set(collider.handle, prop);
    return prop;
  }

  /** Extra collider on a prop's body (compound shapes). */
  addCollider(p: Prop, desc: RAPIER.ColliderDesc): RAPIER.Collider {
    desc.setCollisionGroups(GROUP_PROP).setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS);
    const c = this.world.createCollider(desc, p.body);
    c.setContactForceEventThreshold(p.mass * -GRAVITY * 3 + 0.6);
    this.propByCollider.set(c.handle, p);
    p.mass = p.body.mass();
    return c;
  }

  step(dt: number): number {
    this.accumulator += Math.min(dt, 0.1);
    let n = 0;
    while (this.accumulator >= PHYSICS_DT && n < MAX_SUBSTEPS) {
      for (const p of this.props) {
        p.prevPos.copy(p.currPos);
        p.prevQuat.copy(p.currQuat);
      }
      this.beforeStep?.(PHYSICS_DT, 2 * PHYSICS_DT - this.accumulator);
      this.world.step(this.events);
      this.drainEvents();
      for (const p of this.props) {
        const t = p.body.translation();
        const r = p.body.rotation();
        p.currPos.set(t.x, t.y, t.z);
        p.currQuat.set(r.x, r.y, r.z, r.w);
      }
      this.afterStep?.();
      this.accumulator -= PHYSICS_DT;
      n++;
      this.steps++;
    }
    if (n === MAX_SUBSTEPS) this.accumulator = 0; // we fell behind: drop time rather than spiral
    this.alpha = this.accumulator / PHYSICS_DT;
    this.checkBounds();
    return n;
  }

  /** Place every free prop's visual between the last two physics states. */
  syncVisuals(): void {
    for (const p of this.props) {
      if (p.manual || p.parked) continue;
      p.object.position.lerpVectors(p.prevPos, p.currPos, this.alpha);
      p.object.quaternion.slerpQuaternions(p.prevQuat, p.currQuat, this.alpha);
    }
  }

  private drainEvents(): void {
    const now = performance.now();
    this.events.drainContactForceEvents((e) => {
      const force = e.totalForceMagnitude();
      const a = this.propByCollider.get(e.collider1());
      const b = this.propByCollider.get(e.collider2());
      for (const [p, other] of [
        [a, e.collider2()],
        [b, e.collider1()],
      ] as const) {
        if (!p || p.parked) continue;
        // Approximate impact speed from impulse over one step.
        const speed = (force * PHYSICS_DT) / Math.max(p.mass, 0.01);
        const strength = Math.min(1, speed / 3.5);
        const st = this.staticInfo.get(other);
        if (st?.onHit && now - p.lastImpact > 70) st.onHit(p, strength);
        if (now - p.lastImpact < 80 || strength < 0.04) continue;
        p.lastImpact = now;
        impact(p.object.position, p.material, strength);
        if (p.heldBy) p.heldBy.pulse(0.15 + strength * 0.6, 25);
        bus.emit('impact', { id: p.id, strength });
      }
    });
    this.events.drainCollisionEvents(() => {});
  }

  /** Props that fall into the abyss come back home. */
  private checkBounds(): void {
    for (const p of this.props) {
      if (p.parked || p.heldBy) continue;
      if (p.currPos.y < -45 || p.currPos.lengthSq() > 400 * 400) this.respawn(p);
    }
  }

  respawn(p: Prop): void {
    p.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
    p.body.setTranslation(p.spawnPos, true);
    p.body.setRotation(p.spawnQuat, true);
    p.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    p.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    p.currPos.copy(p.spawnPos);
    p.prevPos.copy(p.spawnPos);
    p.currQuat.copy(p.spawnQuat);
    p.prevQuat.copy(p.spawnQuat);
    p.object.position.copy(p.spawnPos);
    p.object.quaternion.copy(p.spawnQuat);
    bus.emit('respawn', { id: p.id });
    this.onRespawn?.(p);
  }

  /** Make a prop follow a target pose (held). */
  setKinematic(p: Prop, on: boolean): void {
    p.body.setBodyType(on ? RAPIER.RigidBodyType.KinematicPositionBased : RAPIER.RigidBodyType.Dynamic, true);
  }

  /** Teleport a prop (no interpolation smear). */
  place(p: Prop, pos: Vector3, quat: Quaternion): void {
    p.body.setTranslation(pos, true);
    p.body.setRotation(quat, true);
    p.currPos.copy(pos);
    p.prevPos.copy(pos);
    p.currQuat.copy(quat);
    p.prevQuat.copy(quat);
  }

  setGravity(on: boolean): void {
    this.gravityOn = on;
    this.world.gravity = { x: 0, y: on ? GRAVITY : 0, z: 0 };
    for (const p of this.props) {
      if (p.parked || p.heldBy) continue;
      p.body.setLinearDamping(on ? 0.02 : 0.08);
      p.body.setAngularDamping(on ? 0.15 : 0.05);
      if (!on) {
        // A gentle nudge upward so everything visibly lifts off.
        const m = p.mass;
        p.body.applyImpulse({ x: (Math.random() - 0.5) * 0.25 * m, y: (0.35 + Math.random() * 0.45) * m, z: (Math.random() - 0.5) * 0.25 * m }, true);
        p.body.applyTorqueImpulse({ x: (Math.random() - 0.5) * 0.002, y: (Math.random() - 0.5) * 0.002, z: (Math.random() - 0.5) * 0.002 }, true);
      }
      p.body.wakeUp();
    }
  }

  /** World geometry (static or riding a moving platform), as opposed to props and hands. */
  readonly isWorld = (c: RAPIER.Collider): boolean => this.staticInfo.has(c.handle);

  /** World geometry that counts as ground under your feet (not the things you'd step over). */
  private readonly isGround = (c: RAPIER.Collider): boolean => {
    const info = this.staticInfo.get(c.handle);
    return !!info && !info.stepOver;
  };

  /**
   * Cast a ray against world geometry (islands, decks, the moving skyboat…). With `underfoot`
   * it's a check for the ground under you, which ignores things you'd step over.
   */
  castWalkable(origin: Vector3, dir: Vector3, maxDist: number, underfoot = false): { point: Vector3; normal: Vector3; dist: number; walkable: boolean; collider: number; platform: Object3D | null } | null {
    const ray = new RAPIER.Ray(origin, dir);
    const hit = this.world.castRayAndGetNormal(ray, maxDist, true, RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC, undefined, undefined, undefined, underfoot ? this.isGround : this.isWorld);
    if (!hit) return null;
    const info = this.staticInfo.get(hit.collider.handle);
    const point = _v.copy(dir).multiplyScalar(hit.timeOfImpact).add(origin).clone();
    return { point, normal: new Vector3(hit.normal.x, hit.normal.y, hit.normal.z), dist: hit.timeOfImpact, walkable: !!info?.walkable, collider: hit.collider.handle, platform: info?.platform ?? null };
  }

  /** First thing a ray hits that an arrow or a laser should stop at: world geometry or a free prop. */
  castSolid(origin: Vector3, dir: Vector3, maxDist: number, includeProps = true): { dist: number; collider: RAPIER.Collider } | null {
    const ray = new RAPIER.Ray(origin, dir);
    const hit = this.world.castRay(ray, maxDist, true, undefined, undefined, undefined, undefined, (c) => {
      if (this.isWorld(c)) return true;
      if (!includeProps) return false;
      const p = this.propByCollider.get(c.handle);
      return !!p && !p.heldBy && !p.parked;
    });
    return hit ? { dist: hit.timeOfImpact, collider: hit.collider } : null;
  }

  /** Line of sight between two points against static geometry. */
  clearLine(a: Vector3, b: Vector3): boolean {
    const d = _v.subVectors(b, a);
    const len = d.length();
    if (len < 1e-4) return true;
    d.multiplyScalar(1 / len);
    const ray = new RAPIER.Ray(a, d);
    const hit = this.world.castRay(ray, len - 0.05, true, RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC, undefined, undefined, undefined, this.isWorld);
    return !hit;
  }
}
