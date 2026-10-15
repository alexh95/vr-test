import { BufferAttribute, BufferGeometry, Color, Line, LineBasicMaterial, Vector3 } from 'three';
import { tuning } from '../config';
import { bus } from '../core/events';
import { clamp, DEG } from '../core/math';
import type { HandInput } from '../input/xr-input';
import type { Prop } from '../physics/physics';
import { gloveCatch, gloveLock, whoosh } from '../audio/sfx';
import type { App } from '../app';

type Phase = 'idle' | 'locked' | 'pulling';

interface GloveState {
  phase: Phase;
  target: Prop | null;
  since: number;
  beam: Line;
  beamPos: Float32Array;
}

const _v = new Vector3();
const _v2 = new Vector3();
const _dir = new Vector3();
const _head = new Vector3();
const GLOW_IDLE = 0x58e6ff;
const GLOW_AIM = 0xffd166;
const GLOW_LOCK = 0xff8a3d;

/**
 * Gravity gloves (a nod to Half-Life: Alyx): point at something, hold grip to
 * lock on, flick your wrist back and it arcs into your hand. The launch is a
 * ballistic solve so the object lands where your hand is.
 */
export class GravityGloves {
  private readonly states = new Map<HandInput, GloveState>();
  private readonly beamColor = new Color(GLOW_LOCK);

  constructor(private readonly app: App) {
    for (const hand of app.input.hands) {
      const pos = new Float32Array(2 * 3);
      const geo = new BufferGeometry();
      geo.setAttribute('position', new BufferAttribute(pos, 3));
      const beam = new Line(geo, new LineBasicMaterial({ color: this.beamColor, transparent: true, opacity: 0.65, toneMapped: false }));
      beam.frustumCulled = false;
      beam.visible = false;
      beam.name = `${hand.handedness}-glove-beam`;
      app.scene.add(beam);
      this.states.set(hand, { phase: 'idle', target: null, since: 0, beam, beamPos: pos });
    }
  }

  phase(hand: HandInput): Phase {
    return this.states.get(hand)!.phase;
  }

  target(hand: HandInput): Prop | null {
    return this.states.get(hand)!.target;
  }

  /** Best pullable prop in a cone around the aim ray, if any. */
  scan(hand: HandInput): Prop | null {
    const origin = hand.aim.position;
    const fwd = hand.aim.forward(_dir);
    const coneRad = tuning.gloveConeDegrees * DEG;
    const maxD = tuning.gloveMaxDistance * this.app.rigScale;
    let best: Prop | null = null;
    let bestScore = -Infinity;
    for (const p of this.app.physics.props) {
      if (p.parked || p.heldBy || p.manual || !p.behavior.pullable) continue;
      _v.subVectors(p.object.position, origin);
      const d = _v.length();
      if (d < 0.6 * this.app.rigScale || d > maxD) continue;
      const cos = _v.dot(fwd) / d;
      // The cone is measured to the object's silhouette, not its centre.
      const slack = Math.atan2(p.radius, d);
      if (Math.acos(clamp(cos, -1, 1)) - slack > coneRad) continue;
      const score = cos * 4 - d * 0.02;
      if (score > bestScore && this.app.physics.clearLine(origin, p.object.position)) {
        best = p;
        bestScore = score;
      }
    }
    return best;
  }

  update(dt: number, busyHands: Set<HandInput>): void {
    const grab = this.app.grab;
    const now = performance.now();
    this.app.headPosition(_head);
    for (const hand of this.app.input.hands) {
      const s = this.states.get(hand)!;
      const model = this.app.handModel(hand);
      s.beam.visible = false;
      if (!hand.connected || !hand.aim.valid) continue;

      if (s.phase === 'pulling') {
        const p = s.target;
        const age = (now - s.since) / 1000;
        if (!p || p.parked || p.heldBy || age > 2.2) {
          this.reset(s);
        } else if (hand.squeeze.pressed && !grab.held(hand)) {
          const d = p.object.position.distanceTo(hand.grip.position);
          if (d < (0.32 + p.radius) * this.app.rigScale) {
            grab.grab(hand, p);
            hand.pulse(0.8, 45);
            gloveCatch(p.object.position);
            bus.emit('glove-catch', { hand: hand.handedness, id: p.id, ms: Math.round(now - s.since) });
            this.reset(s);
          }
        }
        model.setGlow(GLOW_LOCK, 1.2);
        continue;
      }

      if (grab.held(hand) || busyHands.has(hand)) {
        if (s.phase === 'locked') this.reset(s);
        model.setGlow(GLOW_IDLE, 0.6);
        continue;
      }

      if (s.phase === 'idle') {
        const t = grab.hover(hand) ? null : this.scan(hand);
        s.target = t;
        if (t) {
          grab.highlight(t, 0.55 + 0.25 * Math.sin(now / 90));
          model.setGlow(GLOW_AIM, 1);
          // Lock on as the grip goes down (nothing within reach to grab directly).
          if (hand.squeeze.down) {
            s.phase = 'locked';
            s.since = now;
            hand.pulse(0.25, 20);
            gloveLock(hand.grip.position);
            bus.emit('glove-lock', { hand: hand.handedness, id: t.id });
          }
        } else model.setGlow(GLOW_IDLE, 0.6);
      }

      if (s.phase === 'locked') {
        const p = s.target;
        if (!p || p.parked || p.heldBy || !hand.squeeze.pressed) {
          this.reset(s);
          continue;
        }
        grab.highlight(p, 1);
        model.setGlow(GLOW_LOCK, 1.3);
        // Beam from hand to target.
        s.beamPos.set([hand.aim.position.x, hand.aim.position.y, hand.aim.position.z, p.object.position.x, p.object.position.y, p.object.position.z]);
        (s.beam.geometry.getAttribute('position') as BufferAttribute).needsUpdate = true;
        s.beam.visible = true;
        // Flick: hand moving toward the head or upward fast, or a sharp wrist snap.
        _v.subVectors(_head, hand.grip.position).setY(0).normalize();
        const toward = hand.velocity.dot(_v) / this.app.rigScale;
        const up = hand.velocity.y / this.app.rigScale;
        const snap = hand.angularVelocity.length();
        // Only after the lock has settled, so the grab motion itself can't count as a flick.
        const settled = now - s.since > 90;
        if (settled && (toward > tuning.gloveFlickSpeed || up > tuning.gloveFlickSpeed * 1.15 || (snap > 9 && toward + up > 0.4))) {
          this.launch(hand, s, p);
        }
        // Gentle haptic hum while locked.
        if (Math.floor(now / 120) !== Math.floor((now - dt * 1000) / 120)) hand.pulse(0.06, 12);
      }
    }
  }

  /** Solve a ballistic arc that arrives at the hand in time T. */
  private launch(hand: HandInput, s: GloveState, p: Prop): void {
    const target = _v.copy(hand.grip.position).add(_v2.set(0, 0.12 * this.app.rigScale, 0));
    const from = p.object.position;
    const dist = from.distanceTo(target);
    const T = clamp(0.38 + (dist / this.app.rigScale) * 0.035, 0.45, 1.05);
    // Normal flight physics for the trip (hovering orbs have no gravity and heavy damping).
    p.behavior.onPull?.();
    p.body.setLinearDamping(0.02);
    const gy = this.app.physics.gravityOn ? -9.81 * p.body.gravityScale() : 0;
    const vel = new Vector3().subVectors(target, from).multiplyScalar(1 / T);
    vel.y -= 0.5 * gy * T;
    p.body.wakeUp();
    p.body.setLinvel(vel, true);
    p.body.setAngvel({ x: (Math.random() - 0.5) * 4, y: (Math.random() - 0.5) * 4, z: (Math.random() - 0.5) * 4 }, true);
    s.phase = 'pulling';
    s.since = performance.now();
    hand.pulse(0.6, 35);
    whoosh(from, false, 0.4, 0.4);
    bus.emit('glove-pull', { hand: hand.handedness, id: p.id, dist: +dist.toFixed(2), T: +T.toFixed(2) });
    this.app.fx.burst(from, 14, 1.2, new Color(GLOW_LOCK), { size: 0.025, life: 0.45, drag: 2 });
  }

  private reset(s: GloveState): void {
    s.phase = 'idle';
    s.target = null;
    s.beam.visible = false;
  }
}
