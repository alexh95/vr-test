import { Color, Group, type MeshBasicMaterial, Quaternion, Vector3 } from 'three';
import { bus } from '../core/events';
import { clamp, damp, DEG } from '../core/math';
import { mergeStatic } from '../core/merge';
import { settings } from '../core/settings';
import type { HandInput } from '../input/xr-input';
import { RAPIER } from '../physics/physics';
import { audio } from '../audio/audio';
import { boatBump, engineLoop, engineStart, leverClunk, uiTick, wheelTick, type EngineLoop, type ImpactMaterial } from '../audio/sfx';
import { DOCK } from '../world/layout';
import { buildPier } from './pier';
import { buildBoat, bulwarkAt, envelopePoints, GATE, HELM, HULL, hullBelowDeckPoints, hullSweepPoints, type BoatParts } from './boat-model';
import type { App } from '../app';

const MAX_SPEED = 6; // m/s ahead at full throttle
const MAX_ASTERN = 2.4;
const MAX_CLIMB = 2.5; // m/s with the lift handle at its stop
const MAX_TURN = 18 * DEG; // rad/s with the wheel hard over
export const WHEEL_LOCK = 1.5 * Math.PI; // ±270°: one and a half turns lock to lock
export const THROTTLE_MAX = 35 * DEG;
const ALT_MIN = -30; // deck height limits; the cloud sea is at -42
const ALT_MAX = 60;
const RANGE = 230; // how far from the island centre she'll go
const REACH = 0.09; // grab distance for the controls (m, scaled with the player)
const SKIN = 0.03; // gap kept from whatever she bumps into

export type BoatControl = 'wheel' | 'throttle' | 'lift';

const Y = new Vector3(0, 1, 0);
const _l = new Vector3();
const _v = new Vector3();
const _v2 = new Vector3();
const _d = new Vector3();
const _n = new Vector3();
const _b = new Vector3();
const _q = new Quaternion();
const _q2 = new Quaternion();

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/**
 * A flying boat you pilot from the helm: the wheel sets the yaw rate, the lift
 * handle the climb rate, the throttle the speed. No pitch or roll: the deck
 * stays level, which keeps it comfortable.
 *
 * The boat moves at the start of each frame, before anything reads the hands,
 * and carries the player's rig with it; so the deck, your hands and whatever
 * you hold stay locked together. Collisions are swept against the static world
 * with the hull and envelope shapes: she stops (or slides) instead of passing
 * through islands.
 */
export class SkyBoat {
  readonly root: Group;
  readonly parts: BoatParts;
  readonly body: RAPIER.RigidBody;
  readonly colliders = new Set<number>();
  private readonly sweepShapes: RAPIER.Shape[];
  /** Deck centre (world) and heading (rad about +Y; the bow points along -Z at 0). */
  readonly pos = new Vector3();
  heading = 0;
  speed = 0;
  climb = 0;
  turnRate = 0;
  /** Helm wheel angle (rad): positive = turned left, counter-clockwise as the pilot sees it. */
  wheel = 0;
  /** Throttle lever angle (rad): positive = pushed forward. */
  throttleAngle = 0;
  /** Lift handle offset (m): positive = pulled up. */
  liftOffset = 0;
  aboard = false;
  bumps = 0;
  /** Resting on or scraping along the ground (an island top): friction slows her. */
  grounded = false;
  private readonly wheelHands = new Map<HandInput, number>();
  private throttleHand: HandInput | null = null;
  private throttleGrab = 0;
  private liftHand: HandInput | null = null;
  private liftGrab = 0;
  private wheelNotch = 0;
  private lastBump = 0;
  private running = false;
  private propSpin = 0;
  private engine: EngineLoop | null = null;
  private gaugeAt = 0;
  private gaugeText = '';
  /** Seconds with no controllers tracked (headset off, dashboard open). */
  private unmanned = 0;
  private time = 0;
  private glow = 1;
  private readonly pierLamp: MeshBasicMaterial;

  constructor(private readonly app: App) {
    this.parts = buildBoat();
    this.root = this.parts.root;
    mergeStatic(this.root, (o) => this.parts.live.has(o));
    app.scene.add(this.root);
    const pier = buildPier(app.physics);
    app.scene.add(pier.group);
    this.pierLamp = pier.lamp;

    this.pos.copy(DOCK.boat);
    this.heading = DOCK.heading;
    const physics = app.physics;
    this.body = physics.world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(this.pos.x, this.pos.y, this.pos.z).setRotation(this.quat(this.heading, _q)),
    );
    const add = (desc: RAPIER.ColliderDesc, walkable: boolean, material: ImpactMaterial, at?: Vector3, rot?: Quaternion) => {
      const c = physics.addStatic(desc, { walkable, material, platform: this.root }, at, rot, this.body);
      this.colliders.add(c.handle);
    };
    // The hull below the deck: its top face is the walkable deck.
    add(RAPIER.ColliderDesc.convexHull(hullBelowDeckPoints())!, true, 'wood');
    // Bulwarks: thin walls along the sides (open at the starboard gate) and across the transom.
    for (const side of [1, -1]) {
      const N = 14;
      for (let i = 0; i < N; i++) {
        const t0 = 0.04 + (i / N) * 0.96;
        const t1 = 0.04 + ((i + 1) / N) * 0.96;
        const tm = (t0 + t1) / 2;
        if (side > 0 && tm > GATE.t0 - 0.01 && tm < GATE.t1 + 0.01) continue;
        const ax = (HULL.halfBeam(t0) - 0.03) * side;
        const az = HULL.zAt(t0);
        const bx = (HULL.halfBeam(t1) - 0.03) * side;
        const bz = HULL.zAt(t1);
        const h = Math.max(0.05, Math.min(bulwarkAt(t0, side), bulwarkAt(t1, side)));
        const len = Math.hypot(bx - ax, bz - az);
        const yaw = Math.atan2(bx - ax, bz - az);
        add(RAPIER.ColliderDesc.cuboid(0.03, h / 2, len / 2), false, 'wood', new Vector3((ax + bx) / 2, h / 2, (az + bz) / 2), new Quaternion().setFromAxisAngle(Y, yaw));
      }
    }
    add(RAPIER.ColliderDesc.cuboid(HULL.halfBeam(1) - 0.03, HULL.bulwark(1) / 2, 0.03), false, 'wood', new Vector3(0, HULL.bulwark(1) / 2, HULL.zAt(1) - 0.03));
    // Binnacle, the two control pedestals, the engine, the envelope.
    add(RAPIER.ColliderDesc.cuboid(0.13, 0.64, 0.13), false, 'wood', new Vector3(0, 0.64, HELM.binnacleZ));
    for (const p of [HELM.throttlePivot, HELM.liftBase]) add(RAPIER.ColliderDesc.cuboid(0.09, p.y / 2, 0.15), false, 'wood', new Vector3(p.x, p.y / 2, p.z));
    add(RAPIER.ColliderDesc.cuboid(0.24, 0.24, 0.23), false, 'tin', new Vector3(0, 0.2, HULL.zAt(1) + 0.22));
    add(RAPIER.ColliderDesc.convexHull(envelopePoints())!, false, 'rubber');
    this.sweepShapes = [new RAPIER.ConvexPolyhedron(hullSweepPoints(), null), new RAPIER.ConvexPolyhedron(envelopePoints(), null)];

    this.syncRoot();
    this.syncControls();
    this.drawGauge();
  }

  // ------------------------------------------------------------------ frames

  get throttle(): number {
    return this.throttleAngle / THROTTLE_MAX;
  }

  get lift(): number {
    return this.liftOffset / HELM.liftTravel;
  }

  private quat(heading: number, out: Quaternion): Quaternion {
    return out.setFromAxisAngle(Y, heading);
  }

  /**
   * Start of the frame: fly with last frame's control settings and carry the
   * player along if they're aboard. Returns true if the rig moved.
   */
  update(dt: number): boolean {
    this.time += dt;
    const was = this.aboard;
    this.aboard = this.checkAboard();
    if (this.aboard !== was) bus.emit(this.aboard ? 'boat-board' : 'boat-leave', { at: this.pos.toArray().map((v) => +v.toFixed(2)) });
    // Controls nobody holds settle back: the wheel self-centres, the lift handle springs to neutral.
    if (this.wheelHands.size === 0) this.wheel *= 1 - damp(1.6, dt);
    if (!this.liftHand) this.liftOffset *= 1 - damp(9, dt);
    // Nobody at the helm (headset off, or the session ended): she eases to a stop
    // instead of sailing off to the edge of the sky without you.
    const { left, right } = this.app.input;
    this.unmanned = this.app.inXR && (left.connected || right.connected) ? 0 : this.unmanned + dt;
    if (this.unmanned > 1) this.throttleAngle = 0;
    const x0 = this.pos.x;
    const y0 = this.pos.y;
    const z0 = this.pos.z;
    const h0 = this.heading;
    for (let remaining = Math.min(dt, 0.1); remaining > 1e-6; ) {
      const h = Math.min(remaining, 1 / 60);
      this.integrate(h);
      remaining -= h;
    }
    this.syncRoot();
    this.syncControls();
    this.animate(dt);
    this.app.locomotion.extraVignette = this.aboard && settings.vignette ? clamp(Math.abs(this.turnRate) / MAX_TURN, 0, 1) * 0.45 : 0;
    if (!this.aboard) return false;
    const rig = this.app.rig;
    const moved = this.pos.x !== x0 || this.pos.y !== y0 || this.pos.z !== z0 || this.heading !== h0;
    if (moved) this.carry(x0, y0, z0, h0);
    // The deck is the only floor aboard: keep your feet exactly on it.
    const floor = this.pos.y + this.app.floorOffset * this.app.rigScale;
    const settle = Math.abs(rig.position.y - floor) > 1e-4;
    if (settle) rig.position.y = floor;
    return moved || settle;
  }

  /** Move the rig by the boat's motion since (x0, y0, z0, h0): a yaw about the boat and a translation. */
  private carry(x0: number, y0: number, z0: number, h0: number): void {
    const rig = this.app.rig;
    const a = this.heading - h0;
    const rx = rig.position.x - x0;
    const rz = rig.position.z - z0;
    const c = Math.cos(a);
    const s = Math.sin(a);
    rig.position.x = this.pos.x + rx * c + rz * s;
    rig.position.z = this.pos.z - rx * s + rz * c;
    rig.position.y += this.pos.y - y0;
    rig.rotation.y += a;
  }

  /**
   * Aboard = your head is over the deck and your feet are at deck level. Once
   * aboard you stay aboard until you clearly leave (teleport off, or walk well
   * away from her), so leaning over the side never drops you.
   */
  private checkAboard(): boolean {
    const app = this.app;
    // Out of VR there's no head to track: whoever was aboard stays aboard.
    if (!app.inXR) return this.aboard;
    const s = app.rigScale;
    const local = this.root.worldToLocal(app.headPosition(_l));
    const floor = app.rig.position.y - app.floorOffset * s;
    const margin = this.aboard ? 1.2 * s : 0;
    const t = HULL.tAt(local.z);
    const inside = t > -margin / HULL.length && t < 1 + margin / HULL.length && Math.abs(local.x) < HULL.halfBeam(clamp(t, 0, 1)) + margin;
    return inside && Math.abs(floor - this.pos.y) < (this.aboard ? 0.9 : 0.45) * s;
  }

  private integrate(h: number): void {
    const target = this.throttle >= 0 ? this.throttle * MAX_SPEED : this.throttle * MAX_ASTERN;
    this.speed += (target - this.speed) * damp(0.75, h);
    // Scraping over the grass: the keel drags.
    if (this.grounded) this.speed *= 1 - damp(2.5, h);
    this.grounded = false;
    // Climb eases off near the ceiling and the floor.
    let climb = this.lift * MAX_CLIMB;
    climb *= climb > 0 ? clamp((ALT_MAX - this.pos.y) / 6, 0, 1) : clamp((this.pos.y - ALT_MIN) / 6, 0, 1);
    this.climb += (climb - this.climb) * damp(2.2, h);
    this.turnRate += ((this.wheel / WHEEL_LOCK) * MAX_TURN - this.turnRate) * damp(2.0, h);

    // Yaw: refused if it would swing the hull into something (unless already stuck in it).
    const dYaw = this.turnRate * h;
    if (Math.abs(dYaw) > 1e-7) {
      if (this.overlaps(this.heading + dYaw) && !this.overlaps(this.heading)) {
        this.bump(Math.abs(this.turnRate) * 4, null);
        this.turnRate = 0;
      } else this.heading += dYaw;
    }

    // Translation: swept against the world, sliding along whatever it touches.
    const fx = -Math.sin(this.heading);
    const fz = -Math.cos(this.heading);
    const d = _d.set(fx * this.speed * h, this.climb * h, fz * this.speed * h);
    const nx = this.pos.x + d.x;
    const nz = this.pos.z + d.z;
    const r = Math.hypot(nx, nz);
    if (r > RANGE) {
      // The edge of the charted sky: no further out, but you can slide along it.
      const out = (d.x * nx + d.z * nz) / r;
      if (out > 0) {
        d.x -= (nx / r) * out;
        d.z -= (nz / r) * out;
      }
    }
    this.sweep(d);
  }

  private sweep(d: Vector3): void {
    const world = this.app.physics.world;
    const rot = this.quat(this.heading, _q);
    const flags = RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC | RAPIER.QueryFilterFlags.EXCLUDE_KINEMATIC;
    for (let iter = 0; iter < 3 && d.lengthSq() > 1e-12; iter++) {
      let best: RAPIER.ColliderShapeCastHit | null = null;
      for (const shape of this.sweepShapes) {
        const hit = world.castShape(this.pos, rot, d, shape, SKIN, 1, false, flags, undefined, undefined, this.body);
        if (hit && (!best || hit.time_of_impact < best.time_of_impact)) best = hit;
      }
      if (!best) {
        this.pos.add(d);
        return;
      }
      const toi = clamp(best.time_of_impact, 0, 1);
      this.pos.addScaledVector(d, toi);
      const n = _n.set(best.normal1.x, best.normal1.y, best.normal1.z);
      if (n.lengthSq() < 1e-8) return;
      n.normalize();
      if (n.y > 0.6) this.grounded = true;
      // Lose the velocity into the surface; keep what runs along it.
      const fx = -Math.sin(this.heading);
      const fz = -Math.cos(this.heading);
      const v = _v.set(fx * this.speed, this.climb, fz * this.speed);
      const into = -v.dot(n);
      if (into > 0) {
        v.addScaledVector(n, into);
        this.speed = v.x * fx + v.z * fz;
        this.climb = v.y;
        this.bump(into, best.witness1);
      }
      d.multiplyScalar(1 - toi);
      const dn = d.dot(n);
      if (dn < 0) d.addScaledVector(n, -dn);
    }
  }

  /** Is the boat inside anything right now? */
  overlapping(): boolean {
    return this.overlaps(this.heading);
  }

  /** How far she could move along `dir` (world, unit) before touching something, up to `max`. */
  clearance(dir: Vector3, max: number): number {
    const world = this.app.physics.world;
    const rot = this.quat(this.heading, _q2);
    const vel = _v2.copy(dir).multiplyScalar(max);
    const flags = RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC | RAPIER.QueryFilterFlags.EXCLUDE_KINEMATIC;
    let best = max;
    for (const shape of this.sweepShapes) {
      const hit = world.castShape(this.pos, rot, vel, shape, 0, 1, false, flags, undefined, undefined, this.body);
      if (hit) best = Math.min(best, hit.time_of_impact * max);
    }
    return best;
  }

  private overlaps(heading: number): boolean {
    const world = this.app.physics.world;
    const rot = this.quat(heading, _q2);
    const flags = RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC | RAPIER.QueryFilterFlags.EXCLUDE_KINEMATIC;
    for (const shape of this.sweepShapes) if (world.intersectionWithShape(this.pos, rot, shape, flags, undefined, undefined, this.body)) return true;
    return false;
  }

  private bump(speed: number, at: { x: number; y: number; z: number } | null): void {
    const now = performance.now();
    if (speed < 0.2 || now - this.lastBump < 350) return;
    this.lastBump = now;
    this.bumps++;
    const k = clamp(speed / 4, 0, 1);
    boatBump(at ? _b.set(at.x, at.y, at.z) : _b.copy(this.pos), k);
    if (this.aboard) for (const h of this.app.input.hands) h.pulse(0.3 + 0.6 * k, 60 + 90 * k);
    bus.emit('boat-bump', { speed: +speed.toFixed(2) });
  }

  /** Physics callback: lead the kinematic body to where the boat will be when this step is drawn. */
  beforeStep(ahead: number): void {
    const h = this.heading + this.turnRate * ahead;
    const s = this.speed * ahead;
    _v2.set(this.pos.x - Math.sin(this.heading) * s, this.pos.y + this.climb * ahead, this.pos.z - Math.cos(this.heading) * s);
    this.body.setNextKinematicTranslation(_v2);
    this.body.setNextKinematicRotation(this.quat(h, _q2));
  }

  private syncRoot(): void {
    this.root.position.copy(this.pos);
    this.root.rotation.set(0, this.heading, 0);
    this.root.updateMatrixWorld(true);
  }

  private syncControls(): void {
    this.parts.wheel.rotation.z = this.wheel;
    this.parts.throttle.rotation.x = -this.throttleAngle;
    this.parts.liftHandle.position.y = HELM.liftBase.y + HELM.liftRest + this.liftOffset;
  }

  // ------------------------------------------------------------------ the helm

  /** Which control (if any) this hand is working. */
  controlOf(h: HandInput): BoatControl | null {
    if (this.wheelHands.has(h)) return 'wheel';
    if (this.throttleHand === h) return 'throttle';
    if (this.liftHand === h) return 'lift';
    return null;
  }

  toLocal(world: Vector3, out: Vector3): Vector3 {
    return this.root.worldToLocal(out.copy(world));
  }

  toWorld(local: Vector3, out: Vector3): Vector3 {
    return this.root.localToWorld(out.copy(local));
  }

  /** Throttle knob centre (boat frame). */
  throttleKnobLocal(out: Vector3, angle = this.throttleAngle): Vector3 {
    const p = HELM.throttlePivot;
    return out.set(p.x, p.y + Math.cos(angle) * HELM.leverLength, p.z - Math.sin(angle) * HELM.leverLength);
  }

  /** Lift handle grip centre (boat frame). */
  liftGripLocal(out: Vector3, offset = this.liftOffset): Vector3 {
    const b = HELM.liftBase;
    return out.set(b.x, b.y + HELM.liftRest + offset, b.z + 0.03);
  }

  /** A point on the wheel rim at `angle` (0 = 3 o'clock as the pilot sees it, counter-clockwise), boat frame. */
  wheelRimLocal(angle: number, out: Vector3): Vector3 {
    const c = HELM.wheelCenter;
    return out.set(c.x + Math.cos(angle) * HELM.wheelRadius, c.y + Math.sin(angle) * HELM.wheelRadius, c.z);
  }

  private handAngle(local: Vector3): number {
    return Math.atan2(local.y - HELM.wheelCenter.y, local.x - HELM.wheelCenter.x);
  }

  private leverAngle(local: Vector3): number {
    const p = HELM.throttlePivot;
    return Math.atan2(-(local.z - p.z), Math.max(0.04, local.y - p.y));
  }

  /** Read the hands on the helm. Hands working a control are added to `claimed`. */
  controls(claimed: Set<HandInput>): void {
    const app = this.app;
    const s = app.rigScale;
    // Letting go.
    for (const h of [...this.wheelHands.keys()]) if (!h.squeeze.pressed || !h.grip.valid) this.wheelHands.delete(h);
    if (this.throttleHand && (!this.throttleHand.squeeze.pressed || !this.throttleHand.grip.valid)) {
      // Near the middle it drops into the neutral detent.
      if (Math.abs(this.throttleAngle) < 4 * DEG) {
        if (this.throttleAngle !== 0) leverClunk(this.toWorld(this.throttleKnobLocal(_v, 0), _v2));
        this.throttleAngle = 0;
      }
      this.throttleHand = null;
    }
    if (this.liftHand && (!this.liftHand.squeeze.pressed || !this.liftHand.grip.valid)) this.liftHand = null;

    // Taking hold: whichever control is nearest the hand.
    for (const h of app.input.hands) {
      if (!h.grip.valid || !h.squeeze.down || claimed.has(h) || this.controlOf(h) || app.grab.held(h) || app.bow.drawHand === h) continue;
      const local = this.toLocal(h.grip.position, _l);
      let best: BoatControl | null = null;
      let bestD = REACH * s;
      const wx = local.x - HELM.wheelCenter.x;
      const wy = local.y - HELM.wheelCenter.y;
      const wz = local.z - HELM.wheelCenter.z;
      // The rim and the handles: a band from 0.31 to 0.47 m out from the hub.
      const dWheel = Math.hypot(Math.max(0, Math.abs(Math.hypot(wx, wy) - 0.39) - 0.08), wz);
      if (dWheel < bestD) {
        best = 'wheel';
        bestD = dWheel;
      }
      const dThrottle = local.distanceTo(this.throttleKnobLocal(_v));
      if (dThrottle < bestD) {
        best = 'throttle';
        bestD = dThrottle;
      }
      const dLift = local.distanceTo(this.liftGripLocal(_v));
      if (dLift < bestD) best = 'lift';
      if (!best) continue;
      if (best === 'wheel') {
        this.wheelHands.set(h, this.handAngle(local));
        wheelTick(h.grip.position);
      } else if (best === 'throttle') {
        this.throttleHand = h;
        this.throttleGrab = this.throttleAngle - this.leverAngle(local);
        uiTick(h.grip.position, 0.7);
      } else {
        this.liftHand = h;
        this.liftGrab = this.liftOffset - (local.y - (HELM.liftBase.y + HELM.liftRest));
        uiTick(h.grip.position, 0.9);
      }
      h.pulse(0.4, 25);
      bus.emit('boat-grab', { control: best, hand: h.handedness });
    }

    // Working them.
    if (this.wheelHands.size) {
      let sum = 0;
      let n = 0;
      for (const [h, last] of this.wheelHands) {
        const local = this.toLocal(h.grip.position, _l);
        const a = this.handAngle(local);
        // Near the hub the angle is meaningless; that hand just holds on.
        if (Math.hypot(local.x - HELM.wheelCenter.x, local.y - HELM.wheelCenter.y) > 0.08) {
          sum += wrap(a - last);
          n++;
        }
        this.wheelHands.set(h, a);
      }
      if (n) {
        const before = this.wheel;
        this.wheel = clamp(this.wheel + sum / n, -WHEEL_LOCK, WHEEL_LOCK);
        // A ratchet notch every 15°, and a firm stop at the lock.
        const notch = Math.round(this.wheel / (15 * DEG));
        if (notch !== this.wheelNotch) {
          this.wheelNotch = notch;
          wheelTick(this.toWorld(HELM.wheelCenter, _v));
          for (const h of this.wheelHands.keys()) h.pulse(0.12, 10);
        }
        if (Math.abs(this.wheel) === WHEEL_LOCK && Math.abs(before) < WHEEL_LOCK) for (const h of this.wheelHands.keys()) h.pulse(0.6, 40);
      }
    }
    if (this.throttleHand) {
      const h = this.throttleHand;
      const before = this.throttleAngle;
      this.throttleAngle = clamp(this.leverAngle(this.toLocal(h.grip.position, _l)) + this.throttleGrab, -THROTTLE_MAX, THROTTLE_MAX);
      const step = 5 * DEG;
      if (Math.floor(before / step) !== Math.floor(this.throttleAngle / step)) h.pulse(0.1, 10);
      if (before * this.throttleAngle < 0) {
        h.pulse(0.35, 20); // through neutral
        uiTick(h.grip.position, 0.5);
      }
    }
    if (this.liftHand) {
      const h = this.liftHand;
      const before = this.liftOffset;
      const local = this.toLocal(h.grip.position, _l);
      this.liftOffset = clamp(local.y - (HELM.liftBase.y + HELM.liftRest) + this.liftGrab, -HELM.liftTravel, HELM.liftTravel);
      if (Math.floor(before / 0.03) !== Math.floor(this.liftOffset / 0.03)) h.pulse(0.08, 10);
    }
    this.syncControls();
    for (const h of this.wheelHands.keys()) claimed.add(h);
    if (this.throttleHand) claimed.add(this.throttleHand);
    if (this.liftHand) claimed.add(this.liftHand);
  }

  /** Let go of everything (session end, reset). */
  releaseControls(): void {
    this.wheelHands.clear();
    this.throttleHand = null;
    this.liftHand = null;
  }

  // ------------------------------------------------------------------ world actions

  /** Put the boat somewhere (tests, reset). With `carry`, the player comes along. */
  placeAt(pos: Vector3, heading: number, carry = false): void {
    const x0 = this.pos.x;
    const y0 = this.pos.y;
    const z0 = this.pos.z;
    const h0 = this.heading;
    this.pos.copy(pos);
    this.heading = heading;
    this.body.setTranslation(this.pos, true);
    this.body.setRotation(this.quat(heading, _q), true);
    this.syncRoot();
    if (carry) {
      this.carry(x0, y0, z0, h0);
      this.app.updateRig();
    }
  }

  /** Engine off, controls neutral, back at the pier; anyone aboard rides home with her. */
  reset(): void {
    this.releaseControls();
    this.throttleAngle = this.liftOffset = this.wheel = 0;
    this.speed = this.climb = this.turnRate = 0;
    this.syncControls();
    const aboard = this.checkAboard();
    // In VR, blink while she (and you) jump home; out of VR there's no blink to wait for.
    if (aboard && this.app.inXR) this.app.locomotion.blink(() => this.placeAt(DOCK.boat, DOCK.heading, true));
    else this.placeAt(DOCK.boat, DOCK.heading, aboard);
  }

  setGlow(glow: number): void {
    this.glow = glow;
    const lamp = new Color(0xffd27a).multiplyScalar(0.55 + 0.65 * glow);
    this.parts.lampMaterial.color.copy(lamp);
    this.pierLamp.color.copy(lamp);
  }

  // ------------------------------------------------------------------ looks and sounds

  private animate(dt: number): void {
    const p = this.parts;
    const load = clamp(Math.max(Math.abs(this.speed) / MAX_SPEED, (Math.abs(this.climb) / MAX_CLIMB) * 0.8, (Math.abs(this.turnRate) / MAX_TURN) * 0.5), 0, 1);
    const running = this.aboard || load > 0.02;
    if (running && !this.running && audio.ready) engineStart(this.enginePos(_v));
    this.running = running;
    const spin = running ? (8 + 34 * Math.abs(this.speed) / MAX_SPEED) * (this.speed < -0.05 ? -1 : 1) : 0;
    this.propSpin += (spin - this.propSpin) * damp(running ? 1.5 : 0.6, dt);
    p.propeller.rotation.z += this.propSpin * dt;
    const pulse = running ? 0.75 + 0.25 * Math.sin(this.time * (5 + 10 * load)) : 0.5;
    p.crystalMaterial.color.setRGB(0.44, 0.97, 1).multiplyScalar((0.6 + 0.6 * this.glow) * pulse * (0.7 + 0.6 * load));
    // The pennant streams aft and flutters faster in the wind.
    const wind = Math.min(1, Math.abs(this.speed) / MAX_SPEED);
    p.pennant.rotation.y = -Math.PI / 2 + Math.sin(this.time * (3 + 9 * wind)) * (0.3 - 0.2 * wind);
    p.pennant.rotation.x = Math.sin(this.time * (2.3 + 7 * wind) + 1) * 0.15;
    if (!this.engine && audio.ready) this.engine = engineLoop();
    this.engine?.update(this.enginePos(_v), load, running, this.aboard ? Math.min(1, wind + (Math.abs(this.climb) / MAX_CLIMB) * 0.4) : 0);
    if (this.time > this.gaugeAt) {
      this.gaugeAt = this.time + 0.15;
      this.drawGauge();
    }
  }

  private enginePos(out: Vector3): Vector3 {
    return this.root.localToWorld(out.set(0, 0.2, HULL.zAt(1) + 0.3));
  }

  /** Compass bearing in degrees: 0 = toward the sunset (-Z), 90 = +X. */
  get bearing(): number {
    return (((-this.heading * 180) / Math.PI) % 360 + 360) % 360;
  }

  private drawGauge(): void {
    const alt = Math.round(this.pos.y);
    const spd = Math.abs(this.speed) < 0.05 ? 0 : this.speed;
    const brg = Math.round(this.bearing) % 360;
    const climbing = this.climb > 0.15 ? 1 : this.climb < -0.15 ? -1 : 0;
    const text = `${alt}|${spd.toFixed(1)}|${brg}|${climbing}|${this.throttle.toFixed(2)}`;
    if (text === this.gaugeText) return;
    this.gaugeText = text;
    const c = this.parts.gaugeCanvas.getContext('2d')!;
    const W = 512;
    const H = 256;
    c.fillStyle = '#1b1410';
    c.fillRect(0, 0, W, H);
    c.strokeStyle = '#d4af37';
    c.lineWidth = 8;
    c.strokeRect(4, 4, W - 8, H - 8);
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    const col = (x: number, label: string, value: string, unit: string) => {
      c.fillStyle = '#d9c9a8';
      c.font = '700 30px system-ui, sans-serif';
      c.fillText(label, x, 46);
      c.fillStyle = '#fff1d6';
      c.font = '800 74px system-ui, sans-serif';
      c.fillText(value, x, 124);
      c.fillStyle = '#d9c9a8';
      c.font = '600 28px system-ui, sans-serif';
      c.fillText(unit, x, 182);
    };
    col(90, 'ALT', `${alt}`, 'm');
    col(256, 'SPEED', spd.toFixed(1), 'm/s');
    const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    col(422, 'HEADING', `${brg}°`, dirs[Math.round(brg / 45) % 8]);
    if (climbing) {
      // An up or down arrow under the altitude.
      c.fillStyle = climbing > 0 ? '#80ed99' : '#ffb35c';
      const base = climbing > 0 ? 230 : 204;
      c.beginPath();
      c.moveTo(68, base);
      c.lineTo(112, base);
      c.lineTo(90, base - climbing * 28);
      c.closePath();
      c.fill();
    }
    // Throttle bar under the speed: right of centre is ahead, left is astern.
    c.fillStyle = 'rgba(255,255,255,0.15)';
    c.fillRect(176, 214, 160, 14);
    c.fillStyle = this.throttle >= 0 ? '#ff8a73' : '#9fe3ff';
    const w = this.throttle * 80;
    c.fillRect(w >= 0 ? 256 : 256 + w, 214, Math.abs(w), 14);
    c.fillStyle = '#fff1d6';
    c.fillRect(255, 208, 2, 26);
    this.parts.gaugeTexture.needsUpdate = true;
  }
}
