import { Matrix4, Quaternion, Vector3 } from 'three';
import { tuning } from '../config';
import { bus } from '../core/events';
import { damp } from '../core/math';
import type { HandInput } from '../input/xr-input';
import { GROUP_HAND, RAPIER, type Prop } from '../physics/physics';
import { uiTick } from '../audio/sfx';
import type { App } from '../app';

interface HeldState {
  prop: Prop | null;
  /** Object pose relative to the (unscaled) grip. */
  offset: Matrix4;
  target: Matrix4;
  targetPos: Vector3;
  targetQuat: Quaternion;
  /** Nearest grabbable this frame (for the hover highlight). */
  hover: Prop | null;
  /** Kinematic sphere that lets a fast-moving empty hand swat things. */
  swatBody: RAPIER.RigidBody;
  swatCollider: RAPIER.Collider;
  swatOn: boolean;
  /** No swatting right after a release, or the hand would bat away what it just threw. */
  swatCooldownUntil: number;
  grabbedAt: number;
}

const _m = new Matrix4();
const _grip = new Matrix4();
const _v = new Vector3();
const _v2 = new Vector3();
const _s = new Vector3(1, 1, 1);
const _q = new Quaternion();

/**
 * Grab, hold and throw. Held props become kinematic and follow the hand; on
 * release they get the hand's velocity at the object's position (v + ω × r)
 * so flicks and spins carry through.
 */
export class GrabSystem {
  private readonly states = new Map<HandInput, HeldState>();
  private readonly highlights = new Map<Prop, number>();
  private readonly applied = new Map<Prop, number>();

  constructor(private readonly app: App) {
    for (const hand of app.input.hands) {
      const body = app.physics.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, -100, 0));
      const collider = app.physics.world.createCollider(RAPIER.ColliderDesc.ball(0.045).setCollisionGroups(GROUP_HAND).setFriction(0.8), body);
      collider.setEnabled(false);
      this.states.set(hand, {
        prop: null,
        offset: new Matrix4(),
        target: new Matrix4(),
        targetPos: new Vector3(),
        targetQuat: new Quaternion(),
        hover: null,
        swatBody: body,
        swatCollider: collider,
        swatOn: false,
        swatCooldownUntil: 0,
        grabbedAt: 0,
      });
    }
  }

  private st(hand: HandInput): HeldState {
    return this.states.get(hand)!;
  }

  held(hand: HandInput): Prop | null {
    return this.st(hand).prop;
  }

  hover(hand: HandInput): Prop | null {
    return this.st(hand).hover;
  }

  /** Request a highlight level for this frame (max wins). */
  highlight(p: Prop, level: number): void {
    this.highlights.set(p, Math.max(level, this.highlights.get(p) ?? 0));
  }

  /** The grip pose without rig scale (objects keep their real size in giant mode). */
  gripUnscaled(hand: HandInput, out: Matrix4): Matrix4 {
    return out.compose(hand.grip.position, hand.grip.quaternion, _s);
  }

  /** Find the closest grabbable prop near the hand. */
  findNearest(hand: HandInput): Prop | null {
    const reach = tuning.grabRadius * this.app.rigScale;
    let best: Prop | null = null;
    let bestD = Infinity;
    const g = hand.grip.position;
    for (const p of this.app.physics.props) {
      if (p.parked || p.manual && !p.heldBy) continue;
      const d = p.object.position.distanceTo(g) - p.radius;
      if (d < reach && d < bestD) {
        best = p;
        bestD = d;
      }
    }
    return best;
  }

  grab(hand: HandInput, p: Prop): void {
    const other = this.app.input.other(hand);
    if (p.heldBy && p.heldBy !== hand) this.release(other, true);
    const s = this.st(hand);
    if (s.prop) this.release(hand, true);
    s.prop = p;
    s.grabbedAt = performance.now();
    p.heldBy = hand;
    p.manual = true;
    this.app.physics.setKinematic(p, true);
    this.gripUnscaled(hand, _grip);
    if (p.behavior.gripOffset) {
      s.offset.copy(p.behavior.gripOffset);
      if (hand.handedness === 'left') mirrorOffset(s.offset);
    } else {
      _m.compose(p.object.position, p.object.quaternion, _s);
      s.offset.copy(_grip).invert().multiply(_m);
    }
    this.computeTarget(hand, s, 0);
    hand.pulse(0.4, 28);
    uiTick(p.object.position, 0.6);
    p.behavior.onGrab?.(hand);
    bus.emit('grab', { hand: hand.handedness, id: p.id });
  }

  release(hand: HandInput, silent = false): void {
    const s = this.st(hand);
    const p = s.prop;
    if (!p) return;
    s.prop = null;
    s.swatCooldownUntil = performance.now() + 450;
    p.heldBy = null;
    p.manual = false;
    this.app.physics.setKinematic(p, false);
    // Start the free body exactly where it was drawn.
    this.app.physics.place(p, s.targetPos, s.targetQuat);
    if (!silent) {
      const v = hand.pointVelocity(s.targetPos, _v).multiplyScalar(tuning.throwBoost);
      const speed = v.length();
      if (speed > tuning.maxThrowSpeed * this.app.rigScale) v.multiplyScalar((tuning.maxThrowSpeed * this.app.rigScale) / speed);
      p.body.setLinvel(v, true);
      p.body.setAngvel(_v2.copy(hand.angularVelocity).multiplyScalar(0.9), true);
      bus.emit('release', { hand: hand.handedness, id: p.id, speed: +speed.toFixed(2) });
      if (speed > 1.6) bus.emit('throw', { hand: hand.handedness, id: p.id, speed: +speed.toFixed(2) });
    }
    p.behavior.onRelease?.(hand);
  }

  /** Drop whatever this hand holds without throwing (e.g. a rocket that launched). */
  forceRelease(hand: HandInput): Prop | null {
    const p = this.st(hand).prop;
    this.release(hand, true);
    return p;
  }

  private computeTarget(hand: HandInput, s: HeldState, dt: number): void {
    const p = s.prop!;
    // Free grabs drift toward the palm so objects don't float a few cm off the hand.
    if (!p.behavior.gripOffset && dt > 0) {
      _v.setFromMatrixPosition(s.offset);
      const len = _v.length();
      const want = p.radius * 0.75 + 0.012;
      if (len > want) {
        _v.multiplyScalar((len + (want - len) * damp(8, dt)) / len);
        s.offset.setPosition(_v);
      }
    }
    this.gripUnscaled(hand, _grip);
    s.target.multiplyMatrices(_grip, s.offset);
    s.target.decompose(s.targetPos, s.targetQuat, _v2);
    // Place the visual now so tools running this frame see where they are.
    p.object.position.copy(s.targetPos);
    p.object.quaternion.copy(s.targetQuat);
  }

  /** `claimed` hands are busy with something else (e.g. the lever) and can't pick things up. */
  update(dt: number, claimed: Set<HandInput>): void {
    const input = this.app.input;
    for (const hand of input.hands) {
      const s = this.st(hand);
      s.hover = null;
      if (!hand.connected || !hand.grip.valid) continue;

      if (s.prop && !hand.squeeze.pressed) this.release(hand);

      if (!s.prop && !claimed.has(hand)) {
        const near = this.findNearest(hand);
        s.hover = near;
        if (near) this.highlight(near, 0.3);
        if (hand.squeeze.down && near) this.grab(hand, near);
      }
      if (s.prop) {
        this.computeTarget(hand, s, dt);
        s.prop.behavior.whileHeld?.(hand, dt);
      }

      // Swatting: enable the hand sphere only when moving fast with an empty hand,
      // so slow reaches for a grab don't shove things away.
      const speed = hand.velocity.length();
      const want = !s.prop && performance.now() > s.swatCooldownUntil && (s.swatOn ? speed > 0.9 : speed > 1.5);
      if (want !== s.swatOn) {
        s.swatOn = want;
        s.swatCollider.setEnabled(want);
        if (want) s.swatBody.setTranslation(hand.grip.position, true);
      }
    }
  }

  /** Physics callback before every fixed step. */
  beforeStep(): void {
    for (const [hand, s] of this.states) {
      if (s.prop) {
        s.prop.body.setNextKinematicTranslation(s.targetPos);
        s.prop.body.setNextKinematicRotation(s.targetQuat);
      }
      if (s.swatOn && hand.grip.valid) s.swatBody.setNextKinematicTranslation(hand.grip.position);
    }
  }

  /** Draw held props exactly at the hand (no interpolation lag). */
  placeVisuals(): void {
    for (const s of this.states.values()) {
      if (!s.prop) continue;
      s.prop.object.position.copy(s.targetPos);
      s.prop.object.quaternion.copy(s.targetQuat);
    }
  }

  /** Apply and reset the per-frame highlight requests. */
  flushHighlights(): void {
    for (const [p, level] of this.applied) {
      if (!this.highlights.has(p) && level !== 0) {
        p.highlight = 0;
        p.onHighlight?.(0);
        this.applied.set(p, 0);
      }
    }
    for (const [p, level] of this.highlights) {
      if (this.applied.get(p) !== level) {
        p.highlight = level;
        p.onHighlight?.(level);
        this.applied.set(p, level);
      }
    }
    this.highlights.clear();
  }

  releaseAll(): void {
    for (const hand of this.app.input.hands) this.release(hand, true);
  }
}

/** Tool grip offsets are authored for the right hand; mirror them across X for the left. */
function mirrorOffset(m: Matrix4): void {
  const flip = new Matrix4().makeScale(-1, 1, 1);
  m.premultiply(flip).multiply(flip);
  // The result is a proper rotation again (two reflections), so decompose stays valid.
  m.decompose(_v, _q, _v2);
  m.compose(_v, _q, _s);
}
