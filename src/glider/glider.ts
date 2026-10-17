import { Color, Matrix4, Quaternion, Vector3 } from 'three';
import { bus } from '../core/events';
import { clamp, damp, DEG, smoothstep } from '../core/math';
import { settings } from '../core/settings';
import type { HandInput } from '../input/xr-input';
import { audio } from '../audio/audio';
import { canopyCollapse, canopyOpen, gliderWind, uiTick, vario, type GliderWind, type Vario } from '../audio/sfx';
import { LAYOUT, PERCH_FACING, PERCH_RACK } from '../world/layout';
import { WIND } from '../world/wind';
import type { Crossing } from '../portals/portals';
import { Rack } from './rack';
import { Air } from './air';
import { PULLEY, type Wing } from './wing';
import type { App } from '../app';

/**
 * Airspeed with hands up, and with both brakes fully down (m/s). Slower than a real wing
 * (about 10 m/s): the islands are small, and there's time to look around and line things up.
 */
export const TRIM = 6;
export const SLOW = 3.6;
/** Turn rate with one brake fully down. */
export const MAX_TURN = 60 * DEG;
/** Sink rate at trim (m/s): an 8:1 glide. */
export const SINK = 0.75;
/** How quickly the wing answers the brakes (1/s): turning, and speeding up or slowing down. */
const TURN_RESPONSE = 6;
const SPEED_RESPONSE = 2.4;
const SINK_RESPONSE = 2.4;
/** Below this you're in the clouds: blink back to the rack. */
const RESCUE_Y = -36;
/** The carabiners hang this far below your eyes (the riser tops end up just above them). */
const HARNESS_DROP = 0.4;
/** Hands this far below your eyes: no brake; this much further down: full brake. */
const BRAKE_ZERO = 0.25;
const BRAKE_TRAVEL = 0.42;
/** Reach for a toggle (m from the palm). */
const REACH = 0.15;

export type GliderState = 'idle' | 'ground' | 'flying' | 'landing' | 'rescue';

const Y = new Vector3(0, 1, 0);
const X = new Vector3(1, 0, 0);
const NEG_Z = new Vector3(0, 0, -1);
const DOWN = new Vector3(0, -1, 0);
const _h = new Vector3();
const _o = new Vector3();
const _d = new Vector3();
const _n = new Vector3();
const _v = new Vector3();
const _q = new Quaternion();
const _q2 = new Quaternion();
const _m = new Matrix4();
const _bx = new Vector3();
const _by = new Vector3();
const _bz = new Vector3();

/**
 * A paraglider. Take both toggles off a rack and the wing rises over your head;
 * walk off an edge and you're flying. Pull a toggle down to turn that way, both to
 * slow down; circle in a thermal to climb. Land on any island; let go of the toggles
 * on the ground and the wing packs itself back onto its rack.
 */
export class Glider {
  readonly racks: Rack[] = [];
  /** Thermals and ridge lift, and the dust, streaks and birds that show where they are. */
  readonly air: Air;
  state: GliderState = 'idle';
  /** The rack the wing in use came from. */
  rack: Rack | null = null;
  /** Which toggle each hand holds: 0 the left brake, 1 the right. */
  readonly holding = new Map<HandInput, 0 | 1>();
  readonly brakes: [number, number] = [0, 0];
  /** Where the wing points (yaw, radians; 0 = -Z). */
  heading = 0;
  airspeed = 0;
  /** Vertical speed (m/s, up is positive) and the lift in it. */
  vy = 0;
  lift = 0;
  turnRate = 0;
  flightTime = 0;
  flightDistance = 0;
  launches = 0;
  landings = 0;
  private bank = 0;
  private surge = 0;
  /** 0: lying behind you on the ground, 1: overhead. */
  private inflate = 0;
  private overVoid = 0;
  private empty = 0;
  private bumpAt = 0;
  private time = 0;
  private wasInLift = false;
  private readonly runout = new Vector3();
  private readonly harness = new Vector3();
  private hasHarness = false;
  /** Toggles nobody holds swing under their pulleys (wing frame). */
  private readonly dangle = [new Vector3(), new Vector3()];
  private wind: GliderWind | null = null;
  private vario: Vario | null = null;

  constructor(private readonly app: App) {
    this.addRack('glider-home', LAYOUT.glider.clone(), 0, { base: 0xf46a25, accent: 0xfdf6ec, tip: 0x1b9aaa, lines: 0xf2e8d8, toggle: 0xf46a25 });
    this.addRack('glider-perch', PERCH_RACK.clone(), PERCH_FACING + Math.PI, { base: 0x7b4fd6, accent: 0xffd23f, tip: 0xfdf6ec, lines: 0xece6ff, toggle: 0xffd23f });
    this.air = new Air(app.scenery.islands);
    app.scene.add(this.air.root);
  }

  private addRack(id: string, at: Vector3, yaw: number, palette: ConstructorParameters<typeof Rack>[3]): Rack {
    at.y = this.app.scenery.heightAt(at.x, at.z) ?? at.y;
    const rack = new Rack(id, at, yaw, palette, this.app.physics);
    this.app.scene.add(rack.root, rack.wing.root, rack.wing.lines, ...rack.wing.toggles);
    this.racks.push(rack);
    this.hangToggles(rack);
    return rack;
  }

  get wing(): Wing | null {
    return this.rack?.wing ?? null;
  }

  /** Wearing the wing (on the ground or in the air). */
  get harnessed(): boolean {
    return this.state !== 'idle';
  }

  get flying(): boolean {
    return this.state === 'flying' || this.state === 'rescue';
  }

  /** The hand holding a toggle, if any. */
  handOn(side: 0 | 1): HandInput | null {
    for (const [h, s] of this.holding) if (s === side) return h;
    return null;
  }

  /** Where a toggle is now (world). */
  toggleWorld(side: 0 | 1, out: Vector3): Vector3 {
    const rack = this.rack;
    if (!rack) return out.set(0, 0, 0);
    return rack.wing.toggles[side].getWorldPosition(out);
  }

  // ------------------------------------------------------------------ frame start

  /** Fly (and carry the player) with last frame's brakes. Returns true if the rig moved. */
  update(dt: number): boolean {
    this.time += dt;
    for (const r of this.racks) r.update(this.time);
    const app = this.app;
    if (this.state === 'idle') return false;
    if (!app.inXR) {
      this.stow('session');
      return false;
    }
    if (this.state === 'ground') return this.onGround(dt);
    if (this.state === 'landing') return this.runOut(dt);
    return this.fly(dt);
  }

  private onGround(dt: number): boolean {
    const app = this.app;
    this.inflate = Math.min(1, this.inflate + dt / 1.1);
    // The wing follows where you face.
    this.heading += wrap(app.input.headYaw() - this.heading) * damp(2.2, dt);
    this.airspeed = 0;
    this.vy = 0;
    this.turnRate = 0;
    // Walked off the edge (the wing has to be up)?
    this.overVoid = this.groundUnder(1.0) ? 0 : this.overVoid + dt;
    if (this.overVoid > 0.3 && this.inflate > 0.6) this.launch();
    // Let go of both toggles: it packs itself away.
    this.empty = this.holding.size ? 0 : this.empty + dt;
    if (this.empty > 0.8) this.stow('let go');
    return false;
  }

  /** Walkable ground under your head, no more than `below` m under your feet. */
  private groundUnder(below: number) {
    const app = this.app;
    const head = app.headPosition(_h);
    const foot = app.rig.position.y - app.floorOffset * app.rigScale;
    const hit = app.physics.castWalkable(_o.set(head.x, foot + 0.6, head.z), DOWN, 0.6 + below, true);
    return hit && hit.walkable && hit.normal.y > 0.6 ? hit : null;
  }

  private launch(): void {
    const app = this.app;
    this.state = 'flying';
    this.airspeed = 0.8 * TRIM;
    this.vy = 0;
    this.flightTime = 0;
    this.flightDistance = 0;
    this.launches++;
    for (const h of app.input.hands) h.pulse(0.5, 90);
    const head = app.headPosition(_h);
    bus.emit('glider-launch', { rack: this.rack?.id, height: +head.y.toFixed(1) });
  }

  private fly(dt: number): boolean {
    const app = this.app;
    const physics = app.physics;
    const [bL, bR] = this.brakes;
    const b = (bL + bR) / 2;
    const target = TRIM - (TRIM - SLOW) * b ** 1.1;
    this.surge = target - this.airspeed;
    this.airspeed += this.surge * damp(SPEED_RESPONSE, dt);
    // A little toggle already turns you (the curve is steeper near the middle).
    const d = bL - bR;
    this.turnRate += (Math.sign(d) * Math.abs(d) ** 0.85 * MAX_TURN - this.turnRate) * damp(TURN_RESPONSE, dt);
    // Sink: least with a touch of brake, more in a turn, and with both toggles all the way
    // down a steep (but gentle) way down to land.
    const deep = smoothstep(0.75, 1, b);
    const turning = Math.abs(this.turnRate) / MAX_TURN;
    const sink = SINK - 0.15 * Math.sin(Math.PI * Math.min(b / 0.7, 1)) + 0.45 * turning * turning + 1.4 * deep;
    const head = app.headPosition(_h);
    const air = this.air.sample(head);
    const thermal = air.thermal;
    this.lift = air.thermal + air.ridge;
    this.vy += (this.lift - sink - this.vy) * damp(SINK_RESPONSE, dt);
    // A bump on the way into rising air.
    const inLift = this.lift > 0.8;
    if (inLift && !this.wasInLift) for (const h of app.input.hands) h.pulse(0.35, 60);
    this.wasInLift = inLift;

    const dh = this.turnRate * dt;
    this.heading += dh;
    const fx = -Math.sin(this.heading);
    const fz = -Math.cos(this.heading);
    // The breeze drifts you, except where a thermal draws the air in and up: there you can
    // circle in place. (Ridge lift is the breeze itself, so it drifts you as usual.)
    const drift = 1 - 0.8 * clamp(thermal / 2, 0, 1);
    let dx = (fx * this.airspeed + WIND.x * drift) * dt;
    let dz = (fz * this.airspeed + WIND.z * drift) * dt;
    const dy = this.vy * dt;
    // Cliffs, trees, rocks, the boat: slide along them instead of through.
    const len = Math.hypot(dx, dz);
    if (len > 1e-6) {
      _d.set(dx / len, 0, dz / len);
      for (const below of [0, 0.9]) {
        const hit = physics.castWalkable(_o.set(head.x, head.y - below, head.z), _d, len + 0.35);
        if (!hit || (hit.walkable && hit.normal.y > 0.6)) continue;
        _n.set(hit.normal.x, 0, hit.normal.z);
        if (_n.lengthSq() < 1e-6) continue;
        _n.normalize();
        const into = dx * _n.x + dz * _n.z;
        if (into < 0) {
          dx -= into * _n.x;
          dz -= into * _n.z;
          if (this.time - this.bumpAt > 0.4) {
            this.bumpAt = this.time;
            for (const h of app.input.hands) h.pulse(0.6, 50);
          }
        }
      }
    }
    // Turn about your head, then move.
    if (dh !== 0) app.locomotion.turn(dh);
    const rig = app.rig;
    rig.position.x += dx;
    rig.position.z += dz;
    rig.position.y += dy;
    app.updateRig();
    this.flightTime += dt;
    this.flightDistance += Math.hypot(dx, dz);
    if (settings.vignette) app.locomotion.requestVignette(clamp(turning, 0, 1) * 0.4);

    // Feet on walkable ground: touch down.
    const foot = rig.position.y - app.floorOffset * app.rigScale;
    const ground = this.groundUnder(0.12);
    if (ground && this.vy < 0.5 && ground.point.y > foot - 0.12) {
      rig.position.y += ground.point.y - foot;
      app.updateRig();
      this.touchDown(fx, fz);
    } else if (foot < RESCUE_Y && this.state === 'flying') this.rescue();
    return true;
  }

  private touchDown(fx: number, fz: number): void {
    const app = this.app;
    this.state = 'landing';
    this.landings++;
    this.runout.set(fx * this.airspeed + WIND.x, 0, fz * this.airspeed + WIND.z);
    for (const h of app.input.hands) h.pulse(0.7, 70);
    const at = app.headPosition(_h);
    canopyCollapse(at);
    bus.emit('glider-land', { at: [+at.x.toFixed(1), +at.y.toFixed(1), +at.z.toFixed(1)], time: +this.flightTime.toFixed(1), distance: +this.flightDistance.toFixed(1) });
  }

  /** A few running steps after touchdown, then you're standing (still harnessed). */
  private runOut(dt: number): boolean {
    const app = this.app;
    const rig = app.rig;
    this.inflate = Math.max(0.35, this.inflate - dt / 1.2);
    this.turnRate *= 1 - damp(4, dt);
    this.runout.multiplyScalar(Math.exp(-3.2 * dt));
    let moved = false;
    const speed = this.runout.length();
    if (speed > 0.05) {
      const head = app.headPosition(_h);
      const foot = rig.position.y - app.floorOffset * app.rigScale;
      const nx = head.x + this.runout.x * dt;
      const nz = head.z + this.runout.z * dt;
      // Something in the way (a tree, a station): stop short of it.
      _d.copy(this.runout).normalize();
      const blocked = app.physics.castSolid(_o.copy(head).setY(head.y - 0.6), _d, speed * dt + 0.35, false);
      const hit = blocked ? null : app.physics.castWalkable(_o.set(nx, foot + 0.6, nz), DOWN, 1.6, true);
      if (hit && hit.walkable && hit.point.y - foot < 0.45) {
        rig.position.x += nx - head.x;
        rig.position.z += nz - head.z;
        rig.position.y += (hit.point.y - foot) * damp(18, dt);
        app.updateRig();
        moved = true;
      } else this.runout.set(0, 0, 0); // the edge: stop
    }
    if (speed < 0.3) {
      this.state = 'ground';
      this.overVoid = 0;
      this.airspeed = 0;
    }
    return moved;
  }

  /** Too low: blink back to the rack the wing came from. */
  private rescue(): void {
    const app = this.app;
    this.state = 'rescue';
    const rack = this.rack ?? this.racks[0];
    bus.emit('glider-rescue', { rack: rack.id });
    app.locomotion.blink(() => {
      this.stow('rescue');
      const rig = app.rig;
      const head = app.headPosition(_h);
      rig.position.x += rack.stand.x - head.x;
      rig.position.z += rack.stand.z - head.z;
      rig.position.y = rack.stand.y + app.floorOffset * app.rigScale;
      app.updateRig();
      app.portals.resetTracking();
    });
  }

  // ------------------------------------------------------------------ hands

  /** Read the hands: take toggles, let go of them, brakes from how far down they are. */
  controls(claimed: Set<HandInput>): void {
    const app = this.app;
    for (const [h, side] of [...this.holding]) {
      if (h.squeeze.pressed && h.grip.valid) continue;
      this.holding.delete(h);
      // It springs back up under its pulley.
      const w = this.wing;
      if (w) w.root.worldToLocal(this.dangle[side].copy(h.grip.position));
    }
    for (const h of app.input.hands) {
      if (!h.grip.valid || !h.squeeze.down || claimed.has(h) || this.holding.has(h) || app.grab.held(h) || app.bow.drawHand === h) continue;
      if (this.state === 'idle') {
        if (app.giant) continue;
        let best: [Rack, 0 | 1] | null = null;
        let bestD = REACH;
        for (const rack of this.racks) {
          for (const side of [0, 1] as const) {
            const d = rack.hook(side).distanceTo(h.grip.position);
            if (d < bestD) {
              bestD = d;
              best = [rack, side];
            }
          }
        }
        if (best) this.take(best[0], h, best[1]);
      } else if (this.state !== 'rescue') {
        for (const side of [0, 1] as const) {
          if (this.handOn(side)) continue;
          if (this.toggleWorld(side, _v).distanceTo(h.grip.position) < REACH * 1.4) {
            this.holding.set(h, side);
            h.pulse(0.3, 25);
            uiTick(h.grip.position, 0.6);
            break;
          }
        }
      }
    }
    // Brakes: how far below your eyes each toggle is pulled.
    const eyeY = app.headPosition(_h).y;
    for (const side of [0, 1] as const) {
      const h = this.handOn(side);
      this.brakes[side] = h ? clamp((eyeY - BRAKE_ZERO - h.grip.position.y) / (BRAKE_TRAVEL * app.rigScale), 0, 1) : 0;
    }
    for (const h of this.holding.keys()) claimed.add(h);
  }

  private take(rack: Rack, h: HandInput, side: 0 | 1): void {
    const app = this.app;
    this.rack = rack;
    this.state = 'ground';
    this.inflate = 0;
    this.empty = 0;
    this.overVoid = 0;
    this.hasHarness = false;
    this.heading = app.input.headYaw();
    this.holding.set(h, side);
    rack.setPacked(false);
    rack.wing.visible = true;
    // The other toggle starts where it hung, and swings up under its pulley.
    this.placeWing(0);
    for (const s of [0, 1] as const) rack.wing.root.worldToLocal(this.dangle[s].copy(rack.hook(s)));
    canopyOpen(rack.hook(side));
    h.pulse(0.5, 40);
    bus.emit('glider-take', { rack: rack.id, hand: h.handedness });
  }

  /** Pack the wing back onto its rack (let go on the ground, a teleport, a rescue, a reset). */
  stow(reason = 'stow'): void {
    const rack = this.rack;
    this.holding.clear();
    this.brakes[0] = this.brakes[1] = 0;
    const was = this.state;
    this.state = 'idle';
    this.turnRate = 0;
    this.airspeed = 0;
    this.vy = 0;
    this.lift = 0;
    this.inflate = 0;
    this.wind?.update(0, false);
    this.vario?.update(0, false);
    if (!rack) return;
    rack.wing.visible = false;
    rack.wing.setBrakes(0, 0);
    rack.setPacked(true);
    this.hangToggles(rack);
    if (was !== 'idle') {
      this.app.fx.burst(rack.pack.getWorldPosition(_v), 16, 0.7, new Color(0xfff1c9), { size: 0.03, sizeEnd: 0.005, life: 0.8, drag: 2 });
      bus.emit('glider-stow', { rack: rack.id, reason });
    }
  }

  /** The toggles back on their hooks. */
  private hangToggles(rack: Rack): void {
    const q = rack.root.getWorldQuaternion(_q);
    for (const side of [0, 1] as const) {
      const t = rack.wing.toggles[side];
      t.position.copy(rack.hook(side));
      t.quaternion.copy(q);
      t.updateMatrixWorld();
    }
  }

  /** The player went through a portal: the wing turns with them. */
  portalTransit(c: Crossing, yaw: number): void {
    if (this.state === 'idle') return;
    this.heading += yaw;
    this.runout.applyQuaternion(c.q);
    this.hasHarness = false;
  }

  /** Everything back (reset button): the wing goes home, and so do you if you were flying. */
  reset(): void {
    if (this.flying || this.state === 'landing') this.rescue();
    else this.stow('reset');
  }

  /** Session over: let go of everything. */
  releaseControls(): void {
    this.stow('session');
  }

  // ------------------------------------------------------------------ late: visuals and sound

  /** After everything moved: the wing over your head, its lines to the toggles in your hands. */
  lateUpdate(dt: number): void {
    this.air.update(this.app.time, 1 - this.app.tod.night);
    if (this.state === 'idle') {
      this.wind?.update(0, false);
      this.vario?.update(0, false);
      return;
    }
    this.placeWing(dt);
    const w = this.wing!;
    w.setBrakes(this.brakes[0], this.brakes[1]);
    for (const side of [0, 1] as const) {
      const t = w.toggles[side];
      const h = this.handOn(side);
      if (h) {
        // In the fist: the grip runs through it, the loop points up toward the line.
        _bx.set(0, 0, -1).applyQuaternion(h.grip.quaternion);
        orientToggle(t, h.grip.position, _bx);
      } else {
        // Hanging under its pulley, swinging back there if you just let go.
        const rest = _v.copy(PULLEY).setX(PULLEY.x * (side ? 1 : -1));
        rest.y -= 0.16;
        this.dangle[side].lerp(rest, damp(5, dt));
        const at = w.root.localToWorld(_o.copy(this.dangle[side]));
        _bx.set(1, 0, 0).applyQuaternion(w.root.quaternion);
        orientToggle(t, at, _bx);
      }
    }
    w.updateLines();

    // Sound: the wind past you, and the vario's beeps in rising air.
    if (audio.ready) {
      this.wind ??= gliderWind();
      this.vario ??= vario();
    }
    this.wind?.update(this.airspeed / TRIM, this.flying || this.state === 'landing');
    this.vario?.update(this.vy, this.flying);
  }

  /** Put the wing over the harness: heading, bank into turns, pitch while it rises or settles. */
  private placeWing(dt: number): void {
    const w = this.wing;
    if (!w) return;
    const app = this.app;
    const head = app.headPosition(_h);
    _v.set(head.x, head.y - HARNESS_DROP * app.rigScale, head.z);
    if (!this.hasHarness || this.flying || dt === 0) this.harness.copy(_v);
    else this.harness.lerp(_v, damp(14, dt));
    this.hasHarness = true;
    this.bank += (-this.turnRate * 0.6 - this.bank) * damp(6, dt || 1);
    const ease = this.inflate * this.inflate * (3 - 2 * this.inflate);
    const pitch = (1 - ease) * 1.75 - clamp(this.surge * 0.025, -0.12, 0.12);
    w.root.position.copy(this.harness);
    w.root.scale.setScalar(app.rigScale);
    w.root.quaternion.setFromAxisAngle(Y, this.heading);
    w.pivot.quaternion.setFromAxisAngle(NEG_Z, this.bank).multiply(_q2.setFromAxisAngle(X, pitch));
    w.root.updateMatrixWorld(true);
  }
}

/** Angle difference wrapped into (-π, π]. */
function wrap(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

/** Toggle at `at`, its grip along `along`, its loop (local +Y) as close to up as it can be. */
function orientToggle(t: Wing['toggles'][0], at: Vector3, along: Vector3): void {
  _bx.copy(along).normalize();
  _by.copy(Y).addScaledVector(_bx, -_bx.dot(Y));
  if (_by.lengthSq() < 1e-6) _by.set(0, 0, 1);
  _by.normalize();
  _bz.crossVectors(_bx, _by);
  _m.makeBasis(_bx, _by, _bz);
  t.quaternion.setFromRotationMatrix(_m);
  t.position.copy(at);
  t.updateMatrixWorld();
}
