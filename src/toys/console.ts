import {
  BoxGeometry,
  Color,
  CylinderGeometry,
  ExtrudeGeometry,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  MeshStandardMaterial,
  Quaternion,
  Ray,
  Shape,
  Sphere,
  SphereGeometry,
  Vector3,
} from 'three';
import { tuning } from '../config';
import { bus } from '../core/events';
import { clamp, damp, DEG } from '../core/math';
import type { HandInput } from '../input/xr-input';
import { RAPIER } from '../physics/physics';
import { faceToward, LAYOUT } from '../world/layout';
import { buttonClick, leverClunk, uiTick } from '../audio/sfx';
import { makeLabel } from '../ui/text';
import { mergeStatic } from '../core/merge';
import type { App } from '../app';

interface PushButton {
  id: string;
  label: string;
  group: Group; // origin on the panel surface, +Y = panel normal
  cap: Mesh;
  capMat: MeshStandardMaterial;
  baseColor: Color;
  depth: number;
  pressed: boolean;
  action: () => void;
  inv: Matrix4;
  lastFire: number;
}

const TRAVEL = 0.014;
const CAP_R = 0.042;
const CAP_H = 0.026;
const DESK_FRONT_Z = 0.21;
const DESK_FRONT_Y = 0.78;
const DESK_BACK_Z = -0.25;
const DESK_BACK_Y = 1.0;
const PANEL_TILT = Math.atan2(DESK_BACK_Y - DESK_FRONT_Y, DESK_FRONT_Z - DESK_BACK_Z);
const LEVER_MAX = 38 * DEG;

const _v = new Vector3();
const _ray = new Ray();
const _sphere = new Sphere();

/** A slanted control desk: big chunky buttons and the gravity lever. */
export class ControlConsole {
  readonly group = new Group();
  readonly buttons: PushButton[] = [];
  private readonly panel = new Group();
  private readonly leverPivot = new Group();
  private readonly knob: Mesh;
  private leverAngle = -LEVER_MAX;
  private leverHand: HandInput | null = null;
  private readonly lamp: Mesh;
  private readonly hingeInv = new Matrix4();
  zeroG = false;

  constructor(private readonly app: App, actions: { reset(): void; finale(): void; sky(): void; giant(): void }) {
    const g = this.group;
    g.name = 'console';
    g.position.copy(LAYOUT.console);
    faceToward(g);
    app.scene.add(g);

    const body = new MeshLambertMaterial({ color: 0x3d4251 });
    const trim = new MeshStandardMaterial({ color: 0xb08d57, roughness: 0.35, metalness: 0.7 });
    // Slanted desk: side profile in (z, y), extruded across the width.
    const profile = new Shape();
    profile.moveTo(DESK_FRONT_Z, 0);
    profile.lineTo(DESK_FRONT_Z, DESK_FRONT_Y);
    profile.lineTo(DESK_BACK_Z, DESK_BACK_Y);
    profile.lineTo(DESK_BACK_Z, 0);
    profile.closePath();
    const deskGeo = new ExtrudeGeometry(profile, { depth: 1.25, bevelEnabled: false });
    deskGeo.rotateY(-Math.PI / 2);
    deskGeo.translate(0.625, 0, 0);
    const desk = new Mesh(deskGeo, body);
    desk.castShadow = desk.receiveShadow = true;
    g.add(desk);
    // Top panel lies on the slope.
    const panelZ = -0.02;
    this.panel.position.set(0, DESK_FRONT_Y + (DESK_FRONT_Z - panelZ) * Math.tan(PANEL_TILT), panelZ);
    this.panel.rotation.x = PANEL_TILT;
    g.add(this.panel);
    const top = new Mesh(new BoxGeometry(1.3, 0.04, 0.5), body);
    top.position.y = -0.02;
    top.castShadow = top.receiveShadow = true;
    this.panel.add(top);
    const edge = new Mesh(new BoxGeometry(1.32, 0.012, 0.012), trim);
    edge.position.set(0, 0.002, 0.25);
    this.panel.add(edge);
    g.updateMatrixWorld(true);
    app.physics.addStatic(
      RAPIER.ColliderDesc.cuboid(0.625, DESK_FRONT_Y / 2, (DESK_FRONT_Z - DESK_BACK_Z) / 2),
      { material: 'stone' },
      g.localToWorld(new Vector3(0, DESK_FRONT_Y / 2, (DESK_FRONT_Z + DESK_BACK_Z) / 2)),
      g.getWorldQuaternion(new Quaternion()),
    );
    app.physics.addStatic(RAPIER.ColliderDesc.cuboid(0.65, 0.02, 0.25), { material: 'stone' }, top.getWorldPosition(new Vector3()), top.getWorldQuaternion(new Quaternion()));

    const title = makeLabel(['SKY CONTROL'], { width: 0.5, aspect: 0.14, px: 512, background: null, font: '800 50px system-ui, sans-serif', color: '#ffd9a0' });
    title.position.set(-0.12, 0.004, -0.19);
    title.rotation.x = -Math.PI / 2;
    this.panel.add(title);

    const defs: [string, string, number, () => void][] = [
      ['reset', 'RESET', 0xe63946, actions.reset],
      ['finale', 'FINALE', 0xff9f1c, actions.finale],
      ['sky', 'SKY', 0x4cc9f0, actions.sky],
      ['giant', 'GIANT', 0x80ed99, actions.giant],
    ];
    defs.forEach(([id, label, color, action], i) => {
      const bg = new Group();
      bg.name = `button-${id}`;
      bg.position.set(-0.47 + i * 0.235, 0, 0.02);
      this.panel.add(bg);
      const housing = new Mesh(new CylinderGeometry(CAP_R + 0.014, CAP_R + 0.018, 0.02, 24), trim);
      housing.position.y = 0.006;
      housing.castShadow = true;
      bg.add(housing);
      const capMat = new MeshStandardMaterial({ color, roughness: 0.35, emissive: new Color(color).multiplyScalar(0.25) });
      const cap = new Mesh(new CylinderGeometry(CAP_R, CAP_R * 1.02, CAP_H, 28), capMat);
      cap.position.y = 0.016 + CAP_H / 2;
      cap.castShadow = true;
      bg.add(cap);
      const plate = makeLabel([label], { width: 0.13, aspect: 0.3, px: 256, background: 'rgba(15,12,22,0.85)', font: '800 46px system-ui, sans-serif', color: '#fff' });
      plate.position.set(0, 0.002, 0.1);
      plate.rotation.x = -Math.PI / 2;
      bg.add(plate);
      this.buttons.push({ id, label, group: bg, cap, capMat, baseColor: new Color(color), depth: 0, pressed: false, action, inv: new Matrix4(), lastFire: 0 });
    });

    // Gravity lever on the right of the panel.
    this.leverPivot.position.set(0.5, 0.03, 0.02);
    this.panel.add(this.leverPivot);
    const hinge = new Mesh(new CylinderGeometry(0.03, 0.03, 0.12, 16), trim);
    hinge.rotation.z = Math.PI / 2;
    this.panel.add(hinge);
    hinge.position.copy(this.leverPivot.position);
    const rod = new Mesh(new CylinderGeometry(0.011, 0.013, 0.26, 10), trim);
    rod.position.y = 0.13;
    rod.castShadow = true;
    this.leverPivot.add(rod);
    this.knob = new Mesh(new SphereGeometry(0.036, 20, 14), new MeshStandardMaterial({ color: 0x1d1d1f, roughness: 0.3 }));
    this.knob.position.y = 0.27;
    this.knob.castShadow = true;
    this.leverPivot.add(this.knob);
    this.lamp = new Mesh(new SphereGeometry(0.02, 14, 10), new MeshBasicMaterial({ color: 0x5dff8a, toneMapped: false }));
    this.lamp.position.set(0.5, 0.012, -0.17);
    this.panel.add(this.lamp);
    const leverLabel = makeLabel(['GRAVITY', 'pull toward you'], { width: 0.16, aspect: 0.42, px: 256, background: 'rgba(15,12,22,0.85)', font: '800 38px system-ui, sans-serif', color: '#fff' });
    leverLabel.position.set(0.5, 0.002, 0.17);
    leverLabel.rotation.x = -Math.PI / 2;
    this.panel.add(leverLabel);
    this.leverPivot.rotation.x = this.leverAngle;

    const live = new Set<object>([...this.buttons.map((b) => b.cap), this.leverPivot, this.lamp]);
    mergeStatic(g, (o) => live.has(o));
    g.updateMatrixWorld(true);
    for (const b of this.buttons) b.inv.copy(b.group.matrixWorld).invert();
    // The hinge frame: the panel frame moved to the pivot (the pivot's own rotation is the lever angle).
    this.hingeInv.copy(new Matrix4().multiplyMatrices(this.panel.matrixWorld, new Matrix4().makeTranslation(this.leverPivot.position.x, this.leverPivot.position.y, this.leverPivot.position.z))).invert();
  }

  /** World position of the lever knob. */
  knobWorld(out: Vector3): Vector3 {
    return this.knob.getWorldPosition(out);
  }

  buttonWorld(id: string, out: Vector3): Vector3 {
    const b = this.buttons.find((x) => x.id === id)!;
    return b.cap.getWorldPosition(out);
  }

  /**
   * Claims hands that grab the lever this frame (so the grab system ignores them).
   */
  update(dt: number, claimed: Set<HandInput>): void {
    const hands = this.app.input.hands;
    // ---- Lever ----
    const knob = this.knobWorld(new Vector3());
    if (!this.leverHand) {
      for (const h of hands) {
        if (!h.grip.valid || !h.squeeze.down || this.app.grab.held(h)) continue;
        if (h.grip.position.distanceTo(knob) < 0.09 * this.app.rigScale) {
          this.leverHand = h;
          h.pulse(0.4, 25);
          uiTick(knob, 0.7);
          break;
        }
      }
    }
    if (this.leverHand) {
      const h = this.leverHand;
      claimed.add(h);
      if (!h.squeeze.pressed || !h.grip.valid) {
        this.leverHand = null;
      } else {
        // Angle of the hand around the hinge (rotation about the panel's X axis).
        const local = _v.copy(h.grip.position).applyMatrix4(this.hingeInv);
        const angle = clamp(Math.atan2(local.z, local.y), -LEVER_MAX, LEVER_MAX);
        const prevTick = Math.floor(this.leverAngle / (6 * DEG));
        this.leverAngle = angle;
        if (Math.floor(angle / (6 * DEG)) !== prevTick) h.pulse(0.12, 12);
      }
    } else {
      // Spring to whichever end matches the state.
      const rest = this.zeroG ? LEVER_MAX : -LEVER_MAX;
      this.leverAngle += (rest - this.leverAngle) * damp(10, dt);
    }
    this.leverPivot.rotation.x = this.leverAngle;
    const want = this.zeroG ? this.leverAngle > -10 * DEG : this.leverAngle > 18 * DEG;
    if (want !== this.zeroG) this.setZeroG(want, this.leverHand);

    // ---- Buttons: poke with a fingertip, punch with a fist, or point + trigger ----
    const pokers: { pos: Vector3; r: number; hand: HandInput }[] = [];
    for (const h of hands) {
      if (!h.grip.valid) continue;
      pokers.push({ pos: this.app.handModel(h).indexTip(new Vector3()), r: 0.009 * this.app.rigScale, hand: h });
      pokers.push({ pos: h.grip.position.clone(), r: 0.035 * this.app.rigScale, hand: h });
    }
    for (const b of this.buttons) {
      let depth = 0;
      let who: HandInput | null = null;
      for (const p of pokers) {
        const l = _v.copy(p.pos).applyMatrix4(b.inv);
        if (Math.hypot(l.x, l.z) > CAP_R + p.r * 0.5) continue;
        const capTop = 0.016 + CAP_H;
        const d = capTop + p.r - l.y;
        if (d > 0 && l.y > -0.05) {
          if (d > depth) {
            depth = Math.min(d, TRAVEL);
            who = p.hand;
          }
        }
      }
      b.depth += (depth - b.depth) * damp(depth > b.depth ? 60 : 18, dt);
      b.cap.position.y = 0.016 + CAP_H / 2 - b.depth;
      if (!b.pressed && b.depth > tuning.pokeDepth) this.fire(b, who);
      else if (b.pressed && b.depth < 0.004) {
        b.pressed = false;
        buttonClick(b.cap.getWorldPosition(new Vector3()), false);
      }
    }
    // Ray + trigger.
    for (const h of hands) {
      if (!h.aim.valid || !h.trigger.down || this.app.grab.held(h) || claimed.has(h)) continue;
      _ray.set(h.aim.position, h.aim.forward(new Vector3()));
      for (const b of this.buttons) {
        _sphere.set(b.cap.getWorldPosition(new Vector3()), CAP_R * 1.3);
        if (_ray.intersectsSphere(_sphere) && _ray.origin.distanceTo(_sphere.center) < 3 * this.app.rigScale) {
          b.depth = TRAVEL;
          this.fire(b, h);
          break;
        }
      }
    }
    for (const b of this.buttons) {
      const glow = b.pressed ? 0.9 : 0.25 + 0.08 * Math.sin(performance.now() / 400 + b.group.position.x * 10);
      b.capMat.emissive.copy(b.baseColor).multiplyScalar(glow);
    }
  }

  private fire(b: PushButton, hand: HandInput | null): void {
    b.pressed = true;
    const now = performance.now();
    const at = b.cap.getWorldPosition(new Vector3());
    buttonClick(at, true);
    hand?.pulse(0.7, 35);
    if (now - b.lastFire < 350) return;
    b.lastFire = now;
    bus.emit('button', { id: b.id });
    b.action();
  }

  setZeroG(on: boolean, hand: HandInput | null = null): void {
    if (on === this.zeroG) return;
    this.zeroG = on;
    const knob = this.knobWorld(new Vector3());
    leverClunk(knob);
    hand?.pulse(0.9, 60);
    (this.lamp.material as MeshBasicMaterial).color.setHex(on ? 0xc77dff : 0x5dff8a);
    this.app.setGravity(!on);
    bus.emit('lever', { zeroG: on });
  }
}
