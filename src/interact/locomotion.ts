import {
  AdditiveBlending,
  BackSide,
  Color,
  CylinderGeometry,
  DynamicDrawUsage,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  type Object3D,
  Quaternion,
  ShaderMaterial,
  SphereGeometry,
  TorusGeometry,
  Vector3,
} from 'three';
import { SPAWN, tuning } from '../config';
import { bus } from '../core/events';
import { clamp, damp, DEG } from '../core/math';
import { settings } from '../core/settings';
import type { HandInput } from '../input/xr-input';
import { teleportSound } from '../audio/sfx';
import type { App } from '../app';

const DOTS = 34;
const _v = new Vector3();
const _v2 = new Vector3();
const _dir = new Vector3();
const _m = new Matrix4();
const _q = new Quaternion();
const _s = new Vector3();

const overlayVertex = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const overlayFragment = /* glsl */ `
uniform float uVignette;
uniform float uFade;
varying vec3 vDir;
void main() {
  float c = -normalize(vDir).z;
  float v = smoothstep(0.93, 0.5, c) * uVignette;
  gl_FragColor = vec4(0.0, 0.0, 0.0, max(v, uFade));
}`;

/**
 * Teleport (arc + blink), snap/smooth turning around the head, and smooth
 * walking with ground following and a comfort vignette.
 */
export class Locomotion {
  private aimHand: HandInput | null = null;
  private arcValid = false;
  private readonly arcTarget = new Vector3();
  /** The moving platform (the skyboat) the arc landed on, if any. */
  private arcPlatform: Object3D | null = null;
  private readonly arcPoints: Vector3[] = [];
  /** The arc went through a portal: the first point past it (else -1), and the turn it gives you. */
  private arcBreak = -1;
  private arcTurn = 0;
  private readonly dots: InstancedMesh;
  private readonly ring: Mesh;
  private readonly beam: Mesh;
  private readonly overlay: Mesh;
  private readonly overlayUniforms = { uVignette: { value: 0 }, uFade: { value: 0 } };
  private turnArmed = true;
  private fade = 0;
  private fadeDir = 0;
  private pending: Vector3 | null = null;
  /** A pending landing on a moving platform is kept in its frame, so you land where you aimed. */
  private pendingPlatform: Object3D | null = null;
  /** A pending landing through a portal turns you the way the arc came out of it. */
  private pendingTurn = 0;
  private onFaded: (() => void) | null = null;
  private vignette = 0;
  private readonly validColor = new Color(0x9ff3ff);
  private readonly invalidColor = new Color(0xff6b5e);
  /** Ground height under the player while walking (smoothed). */
  moving = false;
  /** Comfort vignette requested by something else this frame (the skyboat or the glider turning). */
  private requested = 0;

  constructor(private readonly app: App) {
    const dotMat = new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, toneMapped: false });
    this.dots = new InstancedMesh(new SphereGeometry(0.018, 8, 6), dotMat, DOTS);
    this.dots.instanceMatrix.setUsage(DynamicDrawUsage);
    this.dots.frustumCulled = false;
    this.dots.visible = false;
    this.dots.name = 'teleport-arc';
    this.ring = new Mesh(new TorusGeometry(0.32, 0.018, 8, 40), new MeshBasicMaterial({ color: 0x9ff3ff, toneMapped: false }));
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.visible = false;
    this.ring.name = 'teleport-ring';
    this.beam = new Mesh(
      new CylinderGeometry(0.28, 0.3, 1.6, 24, 1, true),
      new MeshBasicMaterial({ color: 0x9ff3ff, transparent: true, opacity: 0.12, blending: AdditiveBlending, depthWrite: false, side: 2 }),
    );
    this.beam.geometry.translate(0, 0.8, 0);
    this.beam.visible = false;
    app.scene.add(this.dots, this.ring, this.beam);

    this.overlay = new Mesh(
      new SphereGeometry(0.16, 24, 16),
      new ShaderMaterial({
        vertexShader: overlayVertex,
        fragmentShader: overlayFragment,
        uniforms: this.overlayUniforms,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        side: BackSide,
      }),
    );
    this.overlay.renderOrder = 10000;
    this.overlay.frustumCulled = false;
    this.overlay.visible = false;
    this.overlay.name = 'comfort-overlay';
    app.xrCamera.add(this.overlay);

    for (let i = 0; i < 160; i++) this.arcPoints.push(new Vector3());
  }

  get teleportAiming(): HandInput | null {
    return this.aimHand;
  }

  get target(): { valid: boolean; point: Vector3; platform: Object3D | null } {
    return { valid: this.arcValid, point: this.arcTarget, platform: this.arcPlatform };
  }

  /** Ask for at least this much comfort vignette this frame (0..1). */
  requestVignette(v: number): void {
    this.requested = Math.max(this.requested, v);
  }

  /** Returns true if the rig moved this frame. Adds hands busy aiming to `busy`. */
  update(dt: number, busy: Set<HandInput>): boolean {
    const { left, right } = this.app.input;
    let moved = false;
    // In the air under the glider, the wing does the moving.
    if (this.app.glider.flying) {
      if (this.aimHand) {
        this.aimHand = null;
        this.hideArc();
      }
      this.moving = false;
      return this.comfort(dt, 0);
    }

    // ---- Teleport aim (right stick, or left stick in teleport mode) ----
    const wantsAim = (h: HandInput) => h.connected && h.stick.y < -0.65 && Math.abs(h.stick.x) < 0.75;
    const releasedAim = (h: HandInput) => !h.connected || h.stick.length() < 0.35;
    const candidates = settings.leftStick === 'teleport' ? [right, left] : [right];
    if (!this.aimHand) {
      for (const h of candidates) {
        if (wantsAim(h) && !this.app.grab.held(h)?.behavior.gripOffset) {
          this.aimHand = h;
          break;
        }
      }
    }
    if (this.aimHand) {
      const h = this.aimHand;
      busy.add(h);
      if (releasedAim(h)) {
        if (this.arcValid && h.connected) this.teleportTo(this.arcTarget.clone(), this.arcPlatform, this.arcTurn);
        this.aimHand = null;
        this.hideArc();
      } else this.computeArc(h);
    }

    // ---- Turning (right stick x) ----
    const sx = right.connected ? right.stick.x : 0;
    if (settings.turn === 'smooth') {
      if (Math.abs(sx) > 0.25 && this.aimHand !== right) {
        this.turn(-Math.sign(sx) * (Math.abs(sx) - 0.25) / 0.75 * tuning.smoothTurnSpeed * DEG * dt);
        moved = true;
      }
    } else if (this.aimHand !== right) {
      if (this.turnArmed && Math.abs(sx) > 0.7 && Math.abs(right.stick.y) < 0.6) {
        const deg = settings.turn === 'snap30' ? 30 : tuning.snapTurnDegrees;
        this.turn(-Math.sign(sx) * deg * DEG);
        this.turnArmed = false;
        moved = true;
        bus.emit('snap-turn', { deg: -Math.sign(sx) * deg });
      } else if (Math.abs(sx) < 0.3) this.turnArmed = true;
    }

    // ---- Smooth walking (left stick) ----
    let speedFactor = 0;
    if (settings.leftStick === 'move' && left.connected) {
      const st = left.stick;
      const mag = Math.min(1, st.length());
      if (mag > 0.15) {
        const k = (mag - 0.15) / 0.85 / mag;
        const yaw = this.app.input.headYaw();
        // Head-relative: stick forward (y < 0) = where you look, x = strafe.
        const fx = -Math.sin(yaw);
        const fz = -Math.cos(yaw);
        const rx = Math.cos(yaw);
        const rz = -Math.sin(yaw);
        const mx = (fx * -st.y + rx * st.x) * k;
        const mz = (fz * -st.y + rz * st.x) * k;
        if (this.walk(mx, mz, dt)) {
          moved = true;
          speedFactor = mag;
        }
      }
    }
    if (settings.turn === 'smooth' && Math.abs(sx) > 0.25) speedFactor = Math.max(speedFactor, Math.abs(sx) * 0.8);
    this.moving = speedFactor > 0;
    return this.comfort(dt, speedFactor) || moved;
  }

  /** The comfort vignette and the blink. Returns true while a blink is running (it may move you). */
  private comfort(dt: number, speedFactor: number): boolean {
    const vTarget = settings.vignette ? Math.max(clamp(speedFactor, 0, 1) * 0.85, this.requested) : 0;
    this.requested = 0;
    this.vignette += (vTarget - this.vignette) * damp(vTarget > this.vignette ? 12 : 5, dt);
    this.updateFade(dt);
    this.overlayUniforms.uVignette.value = this.vignette;
    this.overlayUniforms.uFade.value = this.fade;
    this.overlay.visible = this.app.inXR && (this.vignette > 0.01 || this.fade > 0.001);
    return this.fadeDir !== 0;
  }

  private updateFade(dt: number): void {
    if (this.fadeDir > 0) {
      this.fade = Math.min(1, this.fade + dt / 0.075);
      if (this.fade >= 1) {
        if (this.pending) {
          // The platform kept moving during the blink: land on the spot that was aimed at.
          this.applyTeleport(this.pendingPlatform ? this.pendingPlatform.localToWorld(this.pending) : this.pending, this.pendingTurn);
          this.pending = null;
          this.pendingPlatform = null;
          this.pendingTurn = 0;
        }
        this.onFaded?.();
        this.onFaded = null;
        this.fadeDir = -1;
      }
    } else if (this.fadeDir < 0) {
      this.fade = Math.max(0, this.fade - dt / 0.16);
      if (this.fade <= 0) this.fadeDir = 0;
    }
  }

  /** Blink to black, run `fn`, blink back. */
  blink(fn: () => void): void {
    this.onFaded = fn;
    this.fadeDir = 1;
  }

  /**
   * Move so that the head ends up above `ground` (on `platform`, if it's on something that
   * moves), turned by `turn` first (an arc that went through a portal).
   */
  teleportTo(ground: Vector3, platform: Object3D | null = null, turn = 0): void {
    // You can't teleport wearing a wing: it packs itself back onto its rack.
    if (this.app.glider.harnessed) this.app.glider.stow('teleport');
    this.pending = platform ? platform.worldToLocal(ground.clone()) : ground;
    this.pendingPlatform = platform;
    this.pendingTurn = turn;
    this.fadeDir = 1;
    teleportSound(null);
    bus.emit('teleport', { x: +ground.x.toFixed(2), y: +ground.y.toFixed(2), z: +ground.z.toFixed(2), ...(turn ? { portal: true } : {}) });
  }

  private applyTeleport(ground: Vector3, turn = 0): void {
    const rig = this.app.rig;
    // Through a portal: face the way you'd be facing had you walked through it.
    if (turn) this.turn(turn);
    const head = this.app.headPosition(_v);
    rig.position.x += ground.x - head.x;
    rig.position.z += ground.z - head.z;
    rig.position.y = ground.y + this.app.floorOffset * this.app.rigScale;
    this.app.updateRig();
    this.app.portals.resetTracking();
  }

  /** Back to the spawn point (wrist menu, falling off). */
  recenter(): void {
    // A wing goes back on its rack first.
    if (this.app.glider.harnessed) this.app.glider.stow('recenter');
    this.blink(() => {
      const rig = this.app.rig;
      rig.rotation.y = SPAWN.yaw;
      rig.position.set(SPAWN.x, SPAWN.y + this.app.floorOffset * this.app.rigScale, SPAWN.z);
      this.app.updateRig();
      const head = this.app.headPosition(_v);
      rig.position.x += SPAWN.x - head.x;
      rig.position.z += SPAWN.z - head.z;
      this.app.updateRig();
      this.app.portals.resetTracking();
    });
  }

  /** Rotate the rig about the head (so you turn in place). */
  turn(angle: number): void {
    const rig = this.app.rig;
    const head = this.app.headPosition(_v);
    const dx = rig.position.x - head.x;
    const dz = rig.position.z - head.z;
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    rig.position.x = head.x + dx * c + dz * s;
    rig.position.z = head.z - dx * s + dz * c;
    rig.rotation.y += angle;
    this.app.updateRig();
  }

  /** Walk the head by (mx, mz)·speed·dt if there's ground there. */
  private walk(mx: number, mz: number, dt: number): boolean {
    const scale = this.app.rigScale;
    const step = tuning.moveSpeed * scale * dt;
    const head = this.app.headPosition(_v);
    const nx = head.x + mx * step;
    const nz = head.z + mz * step;
    const rig = this.app.rig;
    const footY = rig.position.y - this.app.floorOffset * scale;
    const hit = this.app.physics.castWalkable(_v2.set(nx, footY + 0.6 * scale, nz), _dir.set(0, -1, 0), 1.6 * scale, true);
    // Wearing a wing you can walk right off the edge (and then you're flying).
    const offEdge = !hit && this.app.glider.harnessed;
    if (!offEdge && (!hit || !hit.walkable || hit.point.y - footY > 0.45 * scale)) return false;
    rig.position.x += nx - head.x;
    rig.position.z += nz - head.z;
    if (hit) rig.position.y += (hit.point.y + this.app.floorOffset * scale - rig.position.y) * damp(18, dt);
    this.app.updateRig();
    return true;
  }

  private computeArc(h: HandInput): void {
    const scale = this.app.rigScale;
    const p = _v.copy(h.aim.position);
    const vel = h.aim.forward(_dir).multiplyScalar(tuning.teleportSpeed * Math.sqrt(scale));
    const g = -9.81 * Math.sqrt(scale) * 0.9;
    const dt = 0.022;
    let n = 0;
    this.arcPoints[n++].copy(p);
    this.arcValid = false;
    this.arcPlatform = null;
    this.arcBreak = -1;
    this.arcTurn = 0;
    let hitPoint: Vector3 | null = null;
    for (let i = 0; i < 150 && n < this.arcPoints.length; i++) {
      const next = _v2.set(p.x + vel.x * dt, p.y + vel.y * dt + 0.5 * g * dt * dt, p.z + vel.z * dt);
      vel.y += g * dt;
      // Into a portal's opening: the arc carries on out of its twin (you see that part through the portal).
      const through = this.arcBreak < 0 ? this.app.portals.through(p, next) : null;
      if (through) {
        next.applyMatrix4(through.m);
        vel.applyQuaternion(through.q);
        this.arcTurn = through.portal.partner.root.rotation.y + Math.PI - through.portal.root.rotation.y;
        p.copy(next);
        this.arcBreak = n;
        this.arcPoints[n++].copy(p);
        continue;
      }
      const seg = new Vector3().subVectors(next, p);
      const len = seg.length();
      const hit = this.app.physics.castWalkable(p, seg.multiplyScalar(1 / len), len);
      if (hit) {
        this.arcPoints[n++].copy(hit.point);
        hitPoint = hit.point;
        this.arcValid = hit.walkable && hit.normal.y > tuning.teleportMaxNormalTilt;
        this.arcPlatform = hit.platform;
        break;
      }
      p.copy(next);
      this.arcPoints[n++].copy(p);
      if (p.y < -60) break;
    }
    // Lay the dots along the arc, flowing toward the target (none across the jump through a portal).
    const segLen = (i: number) => (i === this.arcBreak ? 0 : this.arcPoints[i].distanceTo(this.arcPoints[i - 1]));
    let total = 0;
    for (let i = 1; i < n; i++) total += segLen(i);
    const flow = (performance.now() / 1000) * 1.6;
    const color = this.arcValid ? this.validColor : this.invalidColor;
    (this.dots.material as MeshBasicMaterial).color.copy(color);
    for (let k = 0; k < DOTS; k++) {
      const frac = ((k + (flow % 1)) / DOTS) % 1;
      const along = frac * total;
      let acc = 0;
      let pos = this.arcPoints[0];
      for (let i = 1; i < n; i++) {
        const len = segLen(i);
        if (len > 0 && acc + len >= along) {
          pos = _v2.lerpVectors(this.arcPoints[i - 1], this.arcPoints[i], (along - acc) / len);
          break;
        }
        acc += len;
        pos = this.arcPoints[i];
      }
      const sc = (0.5 + 0.5 * Math.sin(frac * Math.PI)) * Math.sqrt(scale);
      _m.compose(pos, _q.identity(), _s.setScalar(sc));
      this.dots.setMatrixAt(k, _m);
    }
    this.dots.instanceMatrix.needsUpdate = true;
    this.dots.visible = true;
    if (hitPoint && this.arcValid) {
      this.arcTarget.copy(hitPoint);
      const pulse = 1 + 0.08 * Math.sin(performance.now() / 120);
      this.ring.position.copy(hitPoint).y += 0.02;
      this.ring.scale.setScalar(pulse * scale);
      this.beam.position.copy(hitPoint);
      this.beam.scale.setScalar(scale);
      this.ring.visible = this.beam.visible = true;
    } else {
      this.ring.visible = this.beam.visible = false;
    }
  }

  private hideArc(): void {
    this.dots.visible = this.ring.visible = this.beam.visible = false;
    this.arcValid = false;
    this.arcPlatform = null;
    this.arcBreak = -1;
    this.arcTurn = 0;
  }

  /** Cancel an in-progress aim (session end). */
  reset(): void {
    this.aimHand = null;
    this.hideArc();
    this.fade = 0;
    this.fadeDir = 0;
    this.pending = null;
    this.pendingPlatform = null;
    this.pendingTurn = 0;
    this.requested = 0;
    this.overlay.visible = false;
  }
}
