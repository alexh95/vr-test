import {
  BoxGeometry,
  BufferAttribute,
  CatmullRomCurve3,
  Color,
  CylinderGeometry,
  DoubleSide,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Quaternion,
  TorusGeometry,
  TubeGeometry,
  Vector3,
} from 'three';
import { bus } from '../core/events';
import { mergeColored } from '../core/merge';
import { clamp, smoothstep } from '../core/math';
import { settings } from '../core/settings';
import type { HandInput } from '../input/xr-input';
import { RAPIER, type Prop } from '../physics/physics';
import { bowCreak, bowTwang, uiTick } from '../audio/sfx';
import { ARROW_LEN, type Arrow } from './arrows';
import { Scope } from './scope';
import type { App } from '../app';

/**
 * Bow geometry, in the bow's own frame: origin at the centre of the grip, +Y up
 * the riser, -Z toward the target, +Z toward the archer.
 */
const REST_Y = 0.065; // arrow rest: just above the fist
const RISER_END = 0.26; // limbs attach here (±Y)
const TIP = new Vector3(0, 0.43, 0.145); // string groove, in a limb's pivot frame (top limb)
const BRACE_Z = TIP.z; // the string at rest: straight between the tips
const MAX_DRAW = 0.62; // m past brace
const MIN_SHOT = 0.1;
const V_MAX = 75; // m/s at full draw
const ZERO_DISTANCE = 35; // the red dot and the arrow meet here at full draw
const SCOPE_AT = new Vector3(0, 0.142, -0.13); // 7.7 cm above the arrow
const LIMB_BEND = 0.28; // rad at full draw
const NOCK_REACH = 0.15; // how close the draw hand must come to the string

const UP = new Vector3(0, 1, 0);
const _v = new Vector3();
const _v2 = new Vector3();
const _m = new Matrix4();
const _q = new Quaternion();
const _inv = new Matrix4();

/** Downward tilt of the scope axis so the dot is zeroed at ZERO_DISTANCE for a full-draw shot. */
function zeroAngle(): number {
  const t = ZERO_DISTANCE / V_MAX;
  const drop = 0.5 * 9.81 * t * t;
  return Math.atan((SCOPE_AT.y - REST_Y + drop) / ZERO_DISTANCE);
}

function limbGeometry(sign: 1 | -1) {
  const pts = [
    [0, 0, 0],
    [0, 0.1, 0.035],
    [0, 0.22, 0.09],
    [0, 0.33, 0.135],
    [0, 0.41, 0.15],
    [0, 0.45, 0.13],
  ].map(([x, y, z]) => new Vector3(x, y * sign, z));
  const geo = new TubeGeometry(new CatmullRomCurve3(pts), 24, 0.011, 6, false);
  geo.scale(2.0, 1, 0.75); // wide, thin limbs
  // White at the riser, sky blue toward the tips.
  const pos = geo.getAttribute('position');
  const col = new Float32Array(pos.count * 3);
  const a = new Color(0xf4f1ea);
  const b = new Color(0x58b8ff);
  const c = new Color();
  for (let i = 0; i < pos.count; i++) {
    c.copy(a).lerp(b, smoothstep(0.05, 0.42, Math.abs(pos.getY(i))));
    col.set([c.r, c.g, c.b], i * 3);
  }
  geo.setAttribute('color', new BufferAttribute(col, 3));
  return geo;
}

/**
 * A recurve bow with a 2x scope. One hand holds the grip (and aims), the other
 * pulls the string; while drawing, the bow turns to point from the draw hand
 * through the grip, so both arms set the aim like real archery.
 */
export class Bow {
  readonly prop: Prop;
  readonly group = new Group();
  readonly scope: Scope;
  private readonly scopeFrame = new Group();
  private readonly limbTop = new Group();
  private readonly limbBottom = new Group();
  private readonly strings: Mesh[];
  private readonly ghost: Mesh;
  private readonly riserMat: MeshStandardMaterial;
  drawHand: HandInput | null = null;
  private drawButton: 'squeeze' | 'trigger' = 'squeeze';
  private arrow: Arrow | null = null;
  /** Current draw length past brace (m). */
  draw = 0;
  private readonly pinch = new Vector3();
  private lastCreakDraw = 0;
  private wobble = 0; // string vibration after a shot
  private wobbleT = 0;
  private strainAt = 0;
  shots = 0;
  readonly zero = zeroAngle();

  constructor(private readonly app: App) {
    const g = this.group;
    g.name = 'bow';
    // ---- Riser: grip at the centre, body offset to +X so the centre line is a sight window ----
    const Bx = (w: number, h: number, d: number, x: number, y: number, z: number, color: number) => ({ geometry: new BoxGeometry(w, h, d), matrix: new Matrix4().makeTranslation(x, y, z), color });
    const riserGeo = mergeColored([
      // Leather grip in the fist, topping out just under the arrow shelf.
      { geometry: new CylinderGeometry(0.017, 0.019, 0.11, 12), matrix: new Matrix4().makeTranslation(0, -0.015, 0), color: 0x6b3f22 },
      Bx(0.052, 0.023, 0.046, 0.034, 0.0465, -0.004, 0xf2eee6), // shelf under the arrow
      Bx(0.02, 0.004, 0.022, 0, REST_Y - 0.006, 0.0, 0xd4af37), // arrow rest
      // Upper riser well to the side: the centre line above the shelf is a sight
      // window, so neither eye's view of the scope is blocked.
      Bx(0.022, 0.205, 0.045, 0.047, 0.16, -0.004, 0xf2eee6),
      Bx(0.026, 0.19, 0.045, 0.006, -0.165, -0.004, 0xf2eee6), // lower riser
      Bx(0.06, 0.035, 0.055, 0.026, RISER_END, 0.0, 0xd4af37), // limb pockets
      Bx(0.034, 0.035, 0.055, 0.004, -RISER_END, 0.0, 0xd4af37),
      Bx(0.012, 0.012, 0.125, 0.041, SCOPE_AT.y, -0.07, 0x2b2d42), // sight bar to the housing's side
    ]);
    this.riserMat = new MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.15, emissive: new Color(0) });
    const riser = new Mesh(riserGeo, this.riserMat);
    riser.castShadow = true;
    g.add(riser);

    // ---- Limbs on pivots at the riser ends, so they can bend when drawn ----
    const limbMat = new MeshStandardMaterial({ vertexColors: true, roughness: 0.35, metalness: 0.05, emissive: new Color(0x0a2a44) });
    this.limbTop.position.set(0, RISER_END, 0);
    this.limbBottom.position.set(0, -RISER_END, 0);
    this.limbTop.add(new Mesh(limbGeometry(1), limbMat));
    this.limbBottom.add(new Mesh(limbGeometry(-1), limbMat));
    for (const l of [this.limbTop, this.limbBottom]) (l.children[0] as Mesh).castShadow = true;
    g.add(this.limbTop, this.limbBottom);

    // ---- A faintly glowing string: two segments meeting at the nock ----
    const stringMat = new MeshBasicMaterial({ color: new Color(0xbff2ff).multiplyScalar(1.3), toneMapped: false });
    this.strings = [0, 1].map(() => {
      const m = new Mesh(new CylinderGeometry(0.0013, 0.0013, 1, 5), stringMat);
      m.frustumCulled = false;
      g.add(m);
      return m;
    });

    // ---- Scope on the sight bar: housing tube, gold rings, and the lens ----
    this.scopeFrame.position.copy(SCOPE_AT);
    this.scopeFrame.rotation.x = -this.zero;
    g.add(this.scopeFrame);
    const housing = new Mesh(new CylinderGeometry(0.034, 0.034, 0.07, 32, 1, true), new MeshStandardMaterial({ color: 0x15161c, roughness: 0.5, metalness: 0.6, side: DoubleSide }));
    housing.rotation.x = Math.PI / 2;
    const gold = new MeshStandardMaterial({ color: 0xd4af37, roughness: 0.3, metalness: 0.85 });
    const ringRear = new Mesh(new TorusGeometry(0.0345, 0.0042, 8, 32), gold);
    ringRear.position.z = 0.035;
    const ringFront = new Mesh(new TorusGeometry(0.0345, 0.0042, 8, 32), gold);
    ringFront.position.z = -0.035;
    this.scope = new Scope({ rear: 0.0305, front: 0.032, tube: 0.07, magnification: 2 }, settings.quality);
    this.scope.lens.position.z = 0.0345;
    housing.castShadow = true;
    this.scopeFrame.add(housing, ringRear, ringFront, this.scope.lens);

    // A translucent arrow that shows where to grab the string.
    this.ghost = new Mesh(new CylinderGeometry(0.004, 0.004, ARROW_LEN, 6), new MeshBasicMaterial({ color: 0x9fe3ff, transparent: true, opacity: 0.35, depthWrite: false }));
    this.ghost.geometry.rotateX(Math.PI / 2).translate(0, 0, -ARROW_LEN / 2);
    this.ghost.visible = false;
    g.add(this.ghost);

    app.scene.add(g);
    const range = app.range;
    this.prop = app.physics.addProp({
      id: 'bow',
      object: g,
      collider: RAPIER.ColliderDesc.cuboid(0.035, 0.62, 0.06).setTranslation(0, 0, 0.06),
      position: range.rackPos.clone(),
      quaternion: range.rackQuat.clone(),
      material: 'wood',
      radius: 0.09,
      density: 220,
      angularDamping: 1.0,
      behavior: {
        pullable: true,
        poseOverride: (hand, pos, quat) => this.pose(hand, pos, quat),
        onRelease: () => {
          this.cancel();
          if (this.prop.object.position.distanceTo(range.rackPos) < 0.45) this.dock();
        },
      },
    });
    this.prop.onHighlight = (level) => this.riserMat.emissive.setRGB(level * 0.35, level * 0.27, level * 0.1);
    this.dock();
    this.updateString(0);
  }

  get held(): HandInput | null {
    return this.prop.heldBy;
  }

  /** Back on its rack, held still (kinematic) until someone takes it. */
  dock(): void {
    const p = this.prop;
    if (p.heldBy) this.app.grab.forceRelease(p.heldBy);
    this.cancel();
    this.app.physics.setKinematic(p, true);
    this.app.physics.place(p, this.app.range.rackPos, this.app.range.rackQuat);
    p.object.position.copy(this.app.range.rackPos);
    p.object.quaternion.copy(this.app.range.rackQuat);
  }

  /** Where the hand pinches the string: just in front of the fist, toward the fingers. */
  private pinchPoint(h: HandInput, out: Vector3): Vector3 {
    return h.aim.forward(out).multiplyScalar(0.03).add(h.grip.position);
  }

  /** The bow's pose in the hand: the controller's aim frame, turned toward the arrow line while drawing. */
  private pose(hand: HandInput, pos: Vector3, quat: Quaternion): boolean {
    pos.copy(hand.grip.position);
    quat.copy(hand.aim.quaternion);
    if (this.drawHand) {
      const up = _v.copy(UP).applyQuaternion(quat);
      const rest = _v2.copy(pos).addScaledVector(up, REST_Y);
      const fwd = rest.sub(this.pinch);
      if (fwd.lengthSq() > 1e-6) {
        fwd.normalize();
        // Keep the archer's cant (roll) from the bow hand.
        const z = fwd.clone().negate();
        const y = up.clone().addScaledVector(z, -up.dot(z)).normalize();
        const x = new Vector3().crossVectors(y, z);
        _q.setFromRotationMatrix(_m.makeBasis(x, y, z));
        quat.slerp(_q, smoothstep(0.0, 0.08, this.drawEstimate(pos)));
      }
    }
    return true;
  }

  /** Draw length from the pinch point to the grip (before the bow's own pose is final). */
  private drawEstimate(grip: Vector3): number {
    return clamp(this.pinch.distanceTo(grip) - BRACE_Z, 0, MAX_DRAW);
  }

  /** Before grabbing runs: claim the draw hand if it's at the string, and start drawing. */
  preUpdate(claimed: Set<HandInput>): void {
    const bowHand = this.prop.heldBy;
    if (!bowHand || !this.app.inXR) {
      if (this.drawHand) this.cancel();
      this.ghost.visible = false;
      return;
    }
    const other = this.app.input.other(bowHand);
    if (!other.connected || !other.grip.valid) {
      this.cancel();
      this.ghost.visible = false;
      return;
    }
    this.pinchPoint(other, this.pinch);
    if (this.drawHand) {
      claimed.add(other);
      return;
    }
    // Near the string (last frame's bow pose is close enough for this)?
    const nock = this.group.localToWorld(_v.set(0, REST_Y, BRACE_Z));
    const near = !this.app.grab.held(other) && this.pinch.distanceTo(nock) < NOCK_REACH * this.app.rigScale;
    this.ghost.visible = near;
    if (!near) return;
    claimed.add(other);
    this.ghost.position.set(0, REST_Y, BRACE_Z);
    const button = other.squeeze.down ? 'squeeze' : other.trigger.down ? 'trigger' : null;
    if (button) {
      this.drawHand = other;
      this.drawButton = button;
      this.arrow = this.app.arrows.nock();
      this.ghost.visible = false;
      this.lastCreakDraw = 0;
      other.pulse(0.35, 25);
      uiTick(nock, 0.8);
      bus.emit('bow-nock', { hand: other.handedness });
    }
  }

  /** After grabbing: follow the draw, bend the limbs, place the arrow, fire on release. */
  update(dt: number): void {
    const h = this.drawHand;
    if (!h) {
      this.draw = 0;
      this.animateRelease(dt);
      return;
    }
    const bowHand = this.prop.heldBy;
    if (!bowHand) {
      this.cancel();
      return;
    }
    this.group.updateMatrixWorld(true);
    _inv.copy(this.group.matrixWorld).invert();
    const local = _v.copy(this.pinch).applyMatrix4(_inv);
    this.draw = clamp(local.z - BRACE_Z, 0, MAX_DRAW);
    const k = this.draw / MAX_DRAW;
    this.updateString(this.draw);

    // Arrow on the string, along the bow's forward axis through the rest.
    if (this.arrow) {
      const tail = this.group.localToWorld(_v.set(0, REST_Y, BRACE_Z + this.draw));
      const dir = _v2.set(0, 0, -1).transformDirection(this.group.matrixWorld);
      this.app.arrows.place(this.arrow, tail, dir);
    }

    // Tension you can feel and hear.
    const now = performance.now();
    if (Math.abs(this.draw - this.lastCreakDraw) > 0.035) {
      this.lastCreakDraw = this.draw;
      h.pulse(0.06 + 0.35 * k, 12);
      bowCreak(this.group.position, k);
    }
    if (k > 0.95 && now > this.strainAt) {
      this.strainAt = now + 140;
      h.pulse(0.12, 20);
      bowHand.pulse(0.08, 20);
    }

    const released = this.drawButton === 'squeeze' ? !h.squeeze.pressed : !h.trigger.pressed;
    if (released) {
      if (this.draw > MIN_SHOT) this.fire(bowHand, h);
      else this.cancel();
    }
  }

  private fire(bowHand: HandInput, drawHand: HandInput): void {
    const k = this.draw / MAX_DRAW;
    const speed = V_MAX * Math.pow(k, 0.9);
    const tail = this.group.localToWorld(new Vector3(0, REST_Y, BRACE_Z + this.draw));
    const dir = new Vector3(0, 0, -1).transformDirection(this.group.matrixWorld);
    if (this.arrow) this.app.arrows.fire(this.arrow, tail, dir, speed);
    this.arrow = null;
    this.drawHand = null;
    this.shots++;
    this.app.range.shot();
    bowHand.pulse(0.9, 70);
    drawHand.pulse(0.5, 30);
    bowTwang(this.group.position, k);
    this.wobble = 0.025 * k;
    this.wobbleT = 0;
    bus.emit('arrow-shot', { speed: +speed.toFixed(1), draw: +this.draw.toFixed(2), dir: dir.toArray().map((v) => +v.toFixed(3)) });
    this.draw = 0;
  }

  /** Let the string down without shooting. */
  cancel(): void {
    if (this.arrow) this.app.arrows.drop(this.arrow);
    this.arrow = null;
    this.drawHand = null;
    this.draw = 0;
    this.ghost.visible = false;
    this.updateString(0);
  }

  /** The string snaps forward and buzzes for a moment after a shot. */
  private animateRelease(dt: number): void {
    if (this.wobble <= 0) return;
    this.wobbleT += dt;
    const amp = this.wobble * Math.exp(-this.wobbleT * 18);
    if (amp < 0.0004) {
      this.wobble = 0;
      this.updateString(0);
      return;
    }
    this.updateString(Math.cos(this.wobbleT * 70) * amp);
  }

  /** Bend the limbs and lay the string between the tips and the nock. */
  private updateString(draw: number): void {
    const k = clamp(draw / MAX_DRAW, -0.2, 1);
    this.limbTop.rotation.x = k * LIMB_BEND;
    this.limbBottom.rotation.x = -k * LIMB_BEND;
    const top = _v.copy(TIP).applyEuler(this.limbTop.rotation).add(this.limbTop.position);
    const bottom = _v2.set(TIP.x, -TIP.y, TIP.z).applyEuler(this.limbBottom.rotation).add(this.limbBottom.position);
    const nock = new Vector3(0, REST_Y, BRACE_Z + draw);
    this.segment(this.strings[0], top, nock);
    this.segment(this.strings[1], nock, bottom);
  }

  private segment(m: Mesh, a: Vector3, b: Vector3): void {
    const d = new Vector3().subVectors(b, a);
    const len = d.length();
    m.position.copy(a).addScaledVector(d, 0.5);
    m.quaternion.setFromUnitVectors(UP, d.multiplyScalar(1 / Math.max(len, 1e-6)));
    m.scale.set(1, len, 1);
  }

  /** Render the scope view for this frame (only when someone could be looking through it). */
  renderScope(time: number): void {
    const app = this.app;
    const head = app.headPosition(_v);
    const near = head.distanceTo(this.group.position) < 2.2 * app.rigScale;
    if (!this.prop.heldBy && !near) {
      this.scope.uniforms.uActive.value = 0;
      return;
    }
    const fwd = app.inXR && app.input.head.valid ? app.input.head.forward(_v2) : null;
    this.scope.render(app, head, fwd, time);
  }

  /** World position of the nock at rest (for tests and hints). */
  nockWorld(out: Vector3): Vector3 {
    return this.group.localToWorld(out.set(0, REST_Y, BRACE_Z));
  }

  restWorld(out: Vector3): Vector3 {
    return this.group.localToWorld(out.set(0, REST_Y, 0));
  }
}
