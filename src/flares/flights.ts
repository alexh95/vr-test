import {
  AdditiveBlending,
  BufferGeometry,
  CanvasTexture,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  type Object3D,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  Vector3,
} from 'three';
import { bus } from '../core/events';
import { clamp } from '../core/math';
import { chutePop, flareHiss, smokePop, type LoopSound } from '../audio/sfx';
import { WIND } from '../world/wind';
import type { ShellKind } from './kinds';
import type { LightEmitter } from './lights';
import type { SmokeSystem } from './smoke';
import type { App } from '../app';

export { WIND };

type Phase = 'flight' | 'chute' | 'ground' | 'spent';

/** How each type flies and burns. Light is in candela (inverse-square falloff). */
const SPEC = {
  parachute: { speed: 62, terminal: 36, deployAfter: 1.4, deployBy: 4.8, descent: 2.1, burn: 38, light: 12000 },
  star: { speed: 56, terminal: 26, deployAfter: 0, deployBy: 0, descent: 0, burn: 7, light: 5500 },
  smoke: { speed: 50, terminal: 30, deployAfter: 1.1, deployBy: 3.6, descent: 3.4, burn: 20, light: 0 },
};
const LINE = 1.6; // parachute cords: candle hangs this far below the canopy
const MAX_FLIGHTS = 10;

function glowTexture(size: number, falloff: number): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const img = g.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const r = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) / (size / 2);
      const v = r >= 1 ? 0 : Math.pow(1 - r, falloff) * (1 - r * r);
      const i = (y * size + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
      img.data[i + 3] = Math.round(255 * clamp(v, 0, 1));
    }
  }
  g.putImageData(img, 0, 0);
  return new CanvasTexture(c);
}

const coreTex = glowTexture(64, 2.2);
const haloTex = glowTexture(128, 2.2);
const canopyGeo = new SphereGeometry(0.62, 18, 6, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.55, 1);
const cordGeo = (() => {
  const pts: number[] = [];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    pts.push(Math.cos(a) * 0.6, 0, Math.sin(a) * 0.6, 0, -LINE, 0);
  }
  return new BufferGeometry().setAttribute('position', new Float32BufferAttribute(pts, 3));
})();
const cordMat = new LineBasicMaterial({ color: 0x9a8f80 });

const _v = new Vector3();
const _v2 = new Vector3();
const _n = new Vector3();
const _seg = new Vector3();
const _head = new Vector3();
const WHITE = new Color(1, 1, 1);

class Flight {
  phase: Phase = 'flight';
  readonly pos = new Vector3();
  readonly vel = new Vector3();
  /** Where the burning part is (under the canopy, or the pellet itself). */
  readonly light = new Vector3();
  age = 0;
  burn = 0;
  lit = 0;
  ignited = false;
  readonly emitter: LightEmitter;
  readonly core: Sprite;
  readonly halo: Sprite;
  chute: Group | null = null;
  canopyMat: MeshBasicMaterial | null = null;
  hiss: LoopSound | null = null;
  smokeAcc = 0;
  sparkAcc = 0;
  /** Distance flown since the last trail puff. */
  trailAcc = 0;
  swing = Math.random() * Math.PI * 2;
  readonly seed = Math.random() * 100;
  platform: Object3D | null = null;
  readonly local = new Vector3();
  spentFor = 0;

  constructor(readonly kind: ShellKind) {
    const lightColor = kind.id === 'parachute-white' ? new Color(1, 0.93, 0.82) : kind.color.clone();
    this.emitter = { pos: new Vector3(), color: lightColor, intensity: 0, overhead: false };
    this.core = new Sprite(new SpriteMaterial({ map: coreTex, blending: AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false, fog: false }));
    this.halo = new Sprite(new SpriteMaterial({ map: haloTex, blending: AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false, fog: false }));
    this.core.renderOrder = 12;
    this.halo.renderOrder = 11;
    this.core.visible = this.halo.visible = false;
  }

  get spec() {
    return SPEC[this.kind.type];
  }
}

/** Every flare in the air (or burning on the ground): flight, parachutes, light, smoke and sound. */
export class Flights {
  readonly list: Flight[] = [];
  readonly emitters: LightEmitter[] = [];
  launched = 0;

  constructor(
    private readonly app: App,
    private readonly smoke: SmokeSystem,
  ) {}

  get active(): number {
    return this.list.length;
  }

  launch(kind: ShellKind, from: Vector3, dir: Vector3, inherit: Vector3 | null): void {
    if (this.list.length >= MAX_FLIGHTS) this.remove(this.list[0]);
    const f = new Flight(kind);
    f.pos.copy(from);
    f.light.copy(from);
    f.vel.copy(dir).normalize().multiplyScalar(f.spec.speed);
    if (inherit) f.vel.add(inherit);
    this.app.scene.add(f.core, f.halo);
    if (kind.type === 'star') this.ignite(f, f.spec.burn);
    this.list.push(f);
    this.launched++;
  }

  private ignite(f: Flight, seconds: number): void {
    f.ignited = true;
    f.burn = seconds;
    f.hiss = flareHiss(f.light, seconds + 1.5, f.kind.type === 'smoke' ? 0.35 : 0.55, f.kind.type === 'smoke');
  }

  private deploy(f: Flight): void {
    f.phase = 'chute';
    const g = new Group();
    g.name = 'flare-chute';
    const smoke = f.kind.type === 'smoke';
    f.canopyMat = new MeshBasicMaterial({ color: smoke ? f.kind.color.clone().multiplyScalar(0.6) : WHITE.clone(), side: DoubleSide, fog: true });
    g.add(new Mesh(canopyGeo, f.canopyMat), new LineSegments(cordGeo, cordMat));
    if (smoke) g.scale.setScalar(0.55);
    // The canopy opens above the round, which then hangs on its cords.
    g.position.copy(f.pos).y += LINE * g.scale.y;
    f.pos.copy(g.position);
    this.app.scene.add(g);
    f.chute = g;
    const distance = f.pos.distanceTo(this.app.headPosition(_head));
    chutePop(f.pos, distance);
    if (smoke) this.smokeBurst(f, f.light);
    this.ignite(f, f.spec.burn);
    bus.emit('flare-deploy', { kind: f.kind.id, height: +f.pos.y.toFixed(1) });
  }

  private smokeBurst(f: Flight, at: Vector3): void {
    smokePop(at, at.distanceTo(this.app.headPosition(_head)));
    for (let i = 0; i < 26; i++) {
      const d = _v.set(Math.random() - 0.5, Math.random() - 0.35, Math.random() - 0.5).normalize();
      this.smoke.emit({
        pos: at.clone().addScaledVector(d, Math.random() * 1.2),
        vel: d.clone().multiplyScalar(2 + Math.random() * 3),
        color: f.kind.color,
        size: 1.4,
        sizeEnd: 6 + Math.random() * 2,
        life: 22,
        alpha: 0.8,
        rise: 0.15,
      });
    }
  }

  update(dt: number): void {
    const physics = this.app.physics;
    const g = physics.gravityOn ? 9.81 : 0;
    const head = this.app.headPosition(_head);
    this.emitters.length = 0;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const f = this.list[i];
      f.age += dt;
      const spec = f.spec;
      if (f.phase === 'flight') {
        // Ballistic with quadratic drag (terminal speed `terminal`).
        const k = 9.81 / (spec.terminal * spec.terminal);
        const sp = f.vel.length();
        f.vel.multiplyScalar(1 / (1 + k * sp * dt));
        f.vel.y -= g * dt;
        this.move(f, dt);
        if (f.kind.type !== 'star' && f.phase === 'flight' && ((f.age > spec.deployAfter && f.vel.y < 4) || f.age > spec.deployBy)) this.deploy(f);
        f.light.copy(f.pos);
      } else if (f.phase === 'chute') {
        // Under the canopy: sink slowly and drift with the wind, swinging on the cords.
        const target = _v.set(WIND.x * 0.9, -spec.descent * (physics.gravityOn ? 1 : 0), WIND.z * 0.9);
        f.vel.lerp(target, 1 - Math.exp(-1.8 * dt));
        this.move(f, dt);
        f.swing += dt * ((Math.PI * 2) / 3.4);
        const c = f.chute!;
        c.position.copy(f.pos);
        c.rotation.set(Math.sin(f.swing) * 0.17, f.seed, Math.sin(f.swing * 0.83 + f.seed) * 0.11);
        c.updateMatrixWorld(true);
        c.localToWorld(f.light.set(0, -LINE, 0));
      } else if (f.phase === 'ground') {
        if (f.platform) f.platform.localToWorld(f.pos.copy(f.local));
        f.light.copy(f.pos).y += 0.12;
      } else {
        // Spent: the dead canopy keeps sinking for a while.
        if (f.chute) {
          f.vel.lerp(_v.set(WIND.x, -spec.descent * 1.4, WIND.z), 1 - Math.exp(-dt));
          f.pos.addScaledVector(f.vel, dt);
          f.chute.position.copy(f.pos);
        }
        f.spentFor += dt;
      }

      // Burning.
      if (f.ignited && f.phase !== 'spent') {
        f.burn -= dt;
        f.lit = Math.min(1, f.lit + dt / 0.3);
        if (f.burn <= 0) {
          f.phase = 'spent';
          f.hiss?.stop();
          f.hiss = null;
          bus.emit('flare-out', { kind: f.kind.id });
        }
      } else if (f.phase === 'spent') f.lit = Math.max(0, f.lit - dt / 1.2);
      f.hiss?.move(f.light);

      this.effects(f, dt, head);
      this.visuals(f, head);
      if (f.lit > 0.01 && spec.light > 0) {
        const t = f.age + f.seed;
        const flicker = 0.84 + 0.1 * Math.sin(t * 31) + 0.06 * Math.sin(t * 17.3 + 2) - (Math.random() < 0.08 ? 0.12 : 0);
        const boost = f.kind.id === 'parachute-white' ? 1 : 1.6; // saturated colours carry less light
        f.emitter.intensity = spec.light * boost * f.lit * flicker;
        f.emitter.pos.copy(f.light);
        f.emitter.overhead = f.phase === 'chute' || (f.phase === 'spent' && !!f.chute);
        this.emitters.push(f.emitter);
      }
      const gone = f.pos.y < -44 || (f.phase === 'spent' && (f.spentFor > (f.chute ? 25 : 1.5) || f.lit <= 0 && !f.chute)) || f.age > 120;
      if (gone) this.remove(f);
    }
  }

  /** Advance one flight by its velocity, stopping at whatever it hits. */
  private move(f: Flight, dt: number): void {
    const from = f.phase === 'chute' ? f.light : f.pos;
    _seg.copy(f.vel).multiplyScalar(dt);
    const len = _seg.length();
    if (len < 1e-6) return;
    // Stars pop balloons on the way.
    if (f.kind.type === 'star' && f.phase === 'flight') {
      const rh = this.app.range.raycast(f.pos, _v.copy(f.pos).add(_seg));
      if (rh?.kind === 'balloon') this.app.range.pop(rh.balloon!, rh.point.distanceTo(this.app.headPosition(_head)));
    }
    // Through a portal: out of its twin, still flying.
    if (f.phase === 'flight') {
      const end = _v.copy(f.pos).add(_seg);
      const crossing = this.app.portals.through(f.pos, end);
      if (crossing) {
        f.pos.copy(end).applyMatrix4(crossing.m);
        f.vel.applyQuaternion(crossing.q);
        f.trailAcc = 0;
        bus.emit('portal-transit', { what: `flare-${f.kind.id}`, to: crossing.portal.partner.id });
        return;
      }
    }
    const hit = f.age > 0.06 ? this.app.physics.castWalkable(from, _n.copy(_seg).multiplyScalar(1 / len), len) : null;
    if (!hit) {
      f.pos.add(_seg);
      return;
    }
    const at = hit.point;
    if (f.phase === 'flight' && f.kind.type === 'star' && f.vel.length() > 6) {
      // Skip off and keep burning.
      f.pos.copy(at).addScaledVector(hit.normal, 0.03);
      f.vel.reflect(hit.normal).multiplyScalar(0.35);
      return;
    }
    this.land(f, at, hit.platform);
  }

  private land(f: Flight, at: Vector3, platform: Object3D | null): void {
    const wasChute = f.phase === 'chute';
    f.phase = 'ground';
    f.pos.copy(at);
    f.vel.set(0, 0, 0);
    f.platform = platform;
    if (platform) platform.worldToLocal(f.local.copy(at));
    if (f.chute) {
      f.chute.removeFromParent();
      f.chute = null;
    }
    if (!f.ignited) {
      if (f.kind.type === 'smoke') this.smokeBurst(f, at);
      this.ignite(f, f.kind.type === 'parachute' ? f.spec.burn * 0.6 : f.spec.burn);
    }
    bus.emit('flare-land', { kind: f.kind.id, underChute: wasChute });
  }

  private effects(f: Flight, dt: number, head: Vector3): void {
    const fx = this.app.fx;
    const type = f.kind.type;
    const near = f.light.distanceTo(head) < 70;
    f.smokeAcc += dt;
    f.sparkAcc += dt;
    if (f.phase === 'flight') {
      f.smokeAcc = 0; // the pouring/plume timers start when it deploys or lands
      // The trail is laid by distance flown, so it's a continuous line at any speed.
      f.trailAcc += f.vel.length() * dt;
      // Many faint puffs close together read as one continuous streak.
      const spacing = 0.4;
      let n = 0;
      while (f.trailAcc > spacing && n++ < 60) {
        f.trailAcc -= spacing;
        const at = _v2.copy(f.pos).addScaledVector(f.vel, -f.trailAcc / Math.max(f.vel.length(), 1e-3));
        if (type === 'smoke') this.smoke.emit({ pos: at, color: f.kind.color, size: 0.6, sizeEnd: 3.2, life: 12, alpha: 0.45, rise: 0.1 });
        else this.smoke.emit({ pos: at, color: WHITE, size: 0.45, sizeEnd: type === 'parachute' ? 2.2 : 1.4, life: type === 'parachute' ? 6 : 4, alpha: type === 'parachute' ? 0.2 : 0.13, rise: 0.2 });
      }
      if (type !== 'smoke') {
        if (near) {
          const sparks = type === 'star' ? 3 : 1;
          for (let k = 0; k < sparks; k++) {
            fx.emit({
              position: f.pos,
              velocity: _v.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(1.6).addScaledVector(f.vel, -0.04),
              color: (type === 'star' ? f.kind.color : new Color(1, 0.6, 0.2)).clone().multiplyScalar(2.4),
              colorEnd: new Color(0.4, 0.1, 0),
              size: 0.12,
              sizeEnd: 0.02,
              life: 0.5 + Math.random() * 0.4,
              drag: 2,
              gravity: 0.4,
            });
          }
        }
      }
      return;
    }
    if (f.phase === 'spent') return;
    if (type === 'smoke') {
      // Pouring smoke under the drogue (a colour pillar), or from the canister on the ground.
      while (f.smokeAcc > 0.05) {
        f.smokeAcc -= 0.05;
        this.smoke.emit({
          pos: f.light,
          vel: _v.set((Math.random() - 0.5) * 0.6, f.phase === 'ground' ? 0.8 : -0.4, (Math.random() - 0.5) * 0.6),
          color: f.kind.color,
          size: 0.8,
          sizeEnd: 4.8,
          life: 18,
          alpha: 0.85,
          rise: f.phase === 'ground' ? 0.5 : 0.2,
        });
      }
      return;
    }
    // A burning flare: a plume of bright white smoke, and drips of molten sparks.
    while (f.smokeAcc > 0.16) {
      f.smokeAcc -= 0.16;
      this.smoke.emit({ pos: f.light, vel: _v.set(0, 0.5, 0), color: WHITE, size: 0.35, sizeEnd: 3, life: 8, alpha: 0.45, rise: 0.55 });
    }
    if (near && f.sparkAcc > 0.03) {
      f.sparkAcc = 0;
      fx.emit({
        position: f.light,
        velocity: _v.set((Math.random() - 0.5) * 0.8, -0.5 - Math.random(), (Math.random() - 0.5) * 0.8),
        color: f.emitter.color.clone().multiplyScalar(2.5),
        colorEnd: new Color(0.5, 0.15, 0),
        size: 0.16,
        sizeEnd: 0.03,
        life: 1.1,
        drag: 0.8,
        gravity: 0.6,
      });
    }
  }

  private visuals(f: Flight, head: Vector3): void {
    const d = f.light.distanceTo(head);
    const light = f.spec.light > 0;
    const level = f.lit;
    // Unlit rounds in flight still show a small hot pellet.
    const shown = light ? Math.max(level, f.phase === 'flight' ? 0.35 : 0) : f.phase === 'flight' ? 0.25 : 0;
    f.core.visible = f.halo.visible = shown > 0.01;
    if (!f.core.visible) return;
    const color = f.emitter.color;
    f.core.position.copy(f.light);
    f.core.scale.setScalar(Math.max(0.3, d * 0.0065) * (0.6 + 0.4 * shown));
    f.core.material.color.copy(color).lerp(WHITE, 0.55).multiplyScalar(shown);
    // A glow in the haze around it: bigger and more visible at night.
    const night = this.app.tod.night;
    f.halo.position.copy(f.light);
    f.halo.scale.setScalar((4 + d * 0.09) * (light ? 1 : 0.4) * (0.4 + 0.6 * shown));
    f.halo.material.color.copy(color).multiplyScalar(shown * (light ? 0.18 + 0.42 * night : 0.08));
    if (f.canopyMat && f.kind.type === 'parachute') f.canopyMat.color.copy(color).lerp(WHITE, 0.6).multiplyScalar(0.25 + 0.75 * level);
  }

  private remove(f: Flight): void {
    const i = this.list.indexOf(f);
    if (i >= 0) this.list.splice(i, 1);
    f.hiss?.stop();
    f.core.removeFromParent();
    f.halo.removeFromParent();
    f.core.material.dispose();
    f.halo.material.dispose();
    f.chute?.removeFromParent();
    f.canopyMat?.dispose();
  }

  clear(): void {
    while (this.list.length) this.remove(this.list[0]);
    this.emitters.length = 0;
  }

  /** For tests and the probe. */
  summary(): { kind: string; phase: Phase; y: number; light: number }[] {
    return this.list.map((f) => ({ kind: f.kind.id, phase: f.phase, y: +f.light.y.toFixed(1), light: Math.round(f.emitter.intensity * (f.lit > 0.01 ? 1 : 0)) }));
  }
}
