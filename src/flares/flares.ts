import { type BufferGeometry, Color, FogExp2, Mesh, Quaternion, Vector3 } from 'three';
import { bus } from '../core/events';
import { clamp, damp } from '../core/math';
import { settings } from '../core/settings';
import type { HandInput } from '../input/xr-input';
import { RAPIER, type Prop } from '../physics/physics';
import { cartridgeIn, dryClick, flareShot, gunBreak } from '../audio/sfx';
import { LAYOUT } from '../world/layout';
import { KINDS, SHELL, shellGeometry, type ShellKind } from './kinds';
import { buildGunModel, GUN, shellMaterial, type GunModel } from './gun-model';
import { FlareLocker } from './locker';
import { Flights, WIND } from './flights';
import { FlareLights, type LightEmitter } from './lights';
import { SmokeSystem } from './smoke';
import type { App } from '../app';

const REACH = 0.08; // taking a cartridge or the pistol from a locker (m, scaled with you)
const LOAD_REACH = 0.08; // cartridge to breech
const DOCK_REACH = 0.35; // let go of the pistol this close to its case and it goes back in
const POOL = 12;
const LOOSE_LIFE = 45; // s before a dropped cartridge tidies itself away
const SPENT_LIFE = 14;
const FLICK = 6.5; // rad/s of upward wrist flick that snaps the pistol shut

const X = new Vector3(1, 0, 0);
const _v = new Vector3();
const _v2 = new Vector3();
const _q = new Quaternion();
const _q2 = new Quaternion();

interface Cartridge {
  prop: Prop;
  mesh: Mesh;
  kind: ShellKind | null;
  active: boolean;
  bornAt: number;
}

/** A break-action flare pistol: one shot, then open it, reload, close it. */
export class FlareGun {
  readonly model: GunModel;
  readonly prop: Prop;
  private readonly extraCollider: RAPIER.Collider;
  open = false;
  private openT = 0;
  /** When it was last broken open (a flick right after that shouldn't snap it shut). */
  openedAt = -1;
  chamber: ShellKind | null = null;
  spent = false;
  private recoil = 0;
  docked = false;
  shots = 0;

  constructor(
    private readonly app: App,
    private readonly flares: Flares,
    readonly home: FlareLocker,
    id: string,
  ) {
    this.model = buildGunModel();
    app.scene.add(this.model.root);
    const pos = new Vector3();
    const quat = new Quaternion();
    home.holsterPose(pos, quat);
    this.prop = app.physics.addProp({
      id,
      object: this.model.root,
      collider: RAPIER.ColliderDesc.cuboid(0.02, 0.035, 0.1).setTranslation(0, 0.07, -0.085),
      position: pos,
      quaternion: quat,
      material: 'tin',
      radius: 0.09,
      density: 700,
      angularDamping: 0.6,
      behavior: {
        pullable: true,
        poseOverride: (hand, p, q) => {
          // Barrel along the controller's pointing ray, grip in the palm; recoil flips the muzzle up.
          p.copy(hand.grip.position);
          q.copy(hand.aim.quaternion).multiply(_q.setFromAxisAngle(X, 0.42 * this.recoil * this.recoil));
          return true;
        },
        onRelease: () => {
          if (this.prop.object.position.distanceTo(this.holsterWorld(_v)) < DOCK_REACH * this.app.rigScale) this.dock();
        },
      },
    });
    const handle = new Quaternion().setFromAxisAngle(X, -GUN.rake);
    this.extraCollider = app.physics.addCollider(this.prop, RAPIER.ColliderDesc.cuboid(0.016, 0.05, 0.022).setRotation(handle));
    this.dock();
  }

  get held(): HandInput | null {
    return this.prop.heldBy;
  }

  holsterWorld(out: Vector3): Vector3 {
    return this.home.holster.getWorldPosition(out);
  }

  /** Back in its case: the case shows it, the physics prop is parked. */
  dock(): void {
    const p = this.prop;
    if (p.heldBy) this.app.grab.forceRelease(p.heldBy);
    p.parked = true;
    p.manual = true;
    p.object.visible = false;
    p.collider.setEnabled(false);
    this.extraCollider.setEnabled(false);
    this.app.physics.setKinematic(p, true);
    this.open = false;
    this.openT = 0;
    this.recoil = 0;
    this.animate(0);
    this.home.dockedGun.visible = true;
    if (!this.docked) bus.emit('flare-dock', { id: p.id });
    this.docked = true;
  }

  /** Out of the case and into `hand`. */
  take(hand: HandInput): void {
    const p = this.prop;
    this.home.holsterPose(_v, _q2);
    p.parked = false;
    p.manual = false;
    p.object.visible = true;
    p.collider.setEnabled(true);
    this.extraCollider.setEnabled(true);
    this.app.physics.place(p, _v, _q2);
    p.object.position.copy(_v);
    p.object.quaternion.copy(_q2);
    this.home.dockedGun.visible = false;
    this.docked = false;
    this.app.grab.grab(hand, p);
    bus.emit('flare-take', { what: 'pistol', hand: hand.handedness });
  }

  /** World position of the breech mouth (where cartridges go in). */
  mouthWorld(out: Vector3): Vector3 {
    this.model.root.updateMatrixWorld(true);
    return this.model.barrel.localToWorld(out.copy(this.model.mouthLocal));
  }

  setOpen(open: boolean, hand: HandInput | null): void {
    if (open === this.open) return;
    this.open = open;
    if (open) this.openedAt = performance.now();
    const at = this.prop.object.position;
    gunBreak(at, open);
    hand?.pulse(0.35, 25);
    bus.emit(open ? 'flare-open' : 'flare-close', { loaded: !!this.chamber && !this.spent });
    if (open && this.chamber && this.spent) {
      // The ejector throws out a fired case (a live one stays put: pull it out by hand).
      this.chamber = null;
      this.spent = false;
      const mouth = this.mouthWorld(new Vector3());
      const back = new Vector3(0, 0, 1).applyQuaternion(this.prop.object.quaternion);
      const vel = back.multiplyScalar(1.4).add(new Vector3(0, 1.6, 0));
      if (hand) vel.add(hand.velocity);
      this.flares.spawnCartridge(null, mouth, this.model.chamberShell.getWorldQuaternion(new Quaternion()), vel);
      bus.emit('flare-eject', { id: this.prop.id });
    }
  }

  pull(hand: HandInput): void {
    if (this.open) return;
    if (!this.chamber || this.spent) {
      dryClick(this.prop.object.position);
      hand.pulse(0.12, 10);
      bus.emit('flare-dry', { id: this.prop.id });
      return;
    }
    const kind = this.chamber;
    this.spent = true;
    this.shots++;
    this.model.root.updateMatrixWorld(true);
    const muzzle = this.model.barrel.localToWorld(new Vector3().copy(this.model.muzzleLocal));
    const dir = new Vector3(0, 0, -1).transformDirection(this.model.root.matrixWorld);
    this.flares.fire(kind, muzzle, dir);
    this.recoil = 1;
    flareShot(muzzle);
    hand.pulse(1, 90);
    bus.emit('flare-fire', { kind: kind.id, id: this.prop.id, dir: dir.toArray().map((v) => +v.toFixed(3)) });
  }

  animate(dt: number): void {
    this.openT += ((this.open ? 1 : 0) - this.openT) * (dt > 0 ? damp(20, dt) : 1);
    this.recoil = Math.max(0, this.recoil - dt * 4.5);
    const m = this.model;
    m.barrel.rotation.x = -this.openT * GUN.openAngle;
    const h = this.prop.heldBy;
    m.trigger.rotation.x = h ? -h.trigger.value * 0.35 : 0;
    m.chamberShell.visible = this.openT > 0.15 && !!this.chamber;
  }

  showChamber(geos: (k: ShellKind | null) => BufferGeometry): void {
    if (this.chamber) this.model.chamberShell.geometry = geos(this.spent ? null : this.chamber);
  }
}

/**
 * Signal flares: two lockers (one by the pier, one on the skyboat's deck), each
 * with a pistol and nine kinds of cartridge; everything in the air; the smoke;
 * and the light it all throws on the world.
 */
export class Flares {
  readonly lockers: FlareLocker[] = [];
  readonly guns: FlareGun[] = [];
  readonly cartridges: Cartridge[] = [];
  readonly smoke: SmokeSystem;
  readonly lights: FlareLights;
  readonly flights: Flights;
  private readonly geos = new Map<string, BufferGeometry>();
  private readonly flash: LightEmitter = { pos: new Vector3(), color: new Color(1, 0.75, 0.45), intensity: 0, overhead: false };
  private readonly emitters: LightEmitter[] = [];
  private readonly smokeLight = new Color();
  private time = 0;

  constructor(private readonly app: App) {
    this.smoke = new SmokeSystem(settings.quality === 'high' ? 1800 : 900);
    app.scene.add(this.smoke.mesh);
    this.lights = new FlareLights(app.scene, true);
    this.flights = new Flights(app, this.smoke);

    // A locker by the pier on the island, and one bolted to the skyboat's deck.
    const at = LAYOUT.flares.clone();
    at.y = app.scenery.heightAt(at.x, at.z) ?? 0;
    const island = new FlareLocker(app.physics, {
      name: 'flare-locker',
      parent: app.scene,
      position: at,
      yaw: Math.atan2(LAYOUT.spawn.x - at.x, LAYOUT.spawn.z - at.z),
      height: 0.98,
    });
    const boat = new FlareLocker(app.physics, {
      name: 'boat-flare-locker',
      parent: app.boat.root,
      position: new Vector3(-0.92, 0, 1.15),
      yaw: Math.PI / 2,
      height: 0.86,
      body: app.boat.body,
      platform: app.boat.root,
    });
    this.lockers.push(island, boat);
    this.guns.push(new FlareGun(app, this, island, 'flare-gun'), new FlareGun(app, this, boat, 'boat-flare-gun'));

    for (let i = 0; i < POOL; i++) {
      const mesh = new Mesh(this.geometry(null), shellMaterial);
      mesh.castShadow = true;
      mesh.visible = false;
      app.scene.add(mesh);
      const prop = app.physics.addProp({
        id: `flare-cartridge-${i}`,
        object: mesh,
        collider: RAPIER.ColliderDesc.cylinder(SHELL.length / 2, SHELL.radius).setTranslation(0, SHELL.length / 2, 0),
        position: new Vector3(0, -300, 0),
        material: 'tin',
        radius: 0.04,
        density: 700,
        behavior: { pullable: true },
      });
      const c: Cartridge = { prop, mesh, kind: null, active: false, bornAt: 0 };
      this.cartridges.push(c);
      this.parkCartridge(c);
    }

    // Anything of ours that falls out of the world goes home instead of respawning.
    const prev = app.physics.onRespawn;
    app.physics.onRespawn = (p) => {
      prev?.(p);
      const c = this.cartridges.find((x) => x.prop === p);
      if (c) this.parkCartridge(c);
      const g = this.guns.find((x) => x.prop === p);
      if (g) g.dock();
    };
  }

  private geometry(k: ShellKind | null): BufferGeometry {
    const id = k?.id ?? 'spent';
    let g = this.geos.get(id);
    if (!g) this.geos.set(id, (g = shellGeometry(k)));
    return g;
  }

  spawnCartridge(kind: ShellKind | null, pos: Vector3, quat: Quaternion, vel?: Vector3): Cartridge {
    let c = this.cartridges.find((x) => !x.active);
    if (!c) {
      // All in use: recycle the oldest one nobody's holding.
      c = this.cartridges.filter((x) => !x.prop.heldBy).sort((a, b) => a.bornAt - b.bornAt)[0] ?? this.cartridges[0];
    }
    const p = c.prop;
    c.kind = kind;
    c.mesh.geometry = this.geometry(kind);
    c.mesh.visible = true;
    p.parked = false;
    p.manual = false;
    p.collider.setEnabled(true);
    this.app.physics.setKinematic(p, false);
    this.app.physics.place(p, pos, quat);
    p.object.position.copy(pos);
    p.object.quaternion.copy(quat);
    p.body.setLinvel(vel ?? { x: 0, y: 0, z: 0 }, true);
    p.body.setAngvel(vel ? { x: (Math.random() - 0.5) * 12, y: (Math.random() - 0.5) * 4, z: (Math.random() - 0.5) * 12 } : { x: 0, y: 0, z: 0 }, true);
    c.active = true;
    c.bornAt = this.time;
    return c;
  }

  private parkCartridge(c: Cartridge): void {
    const p = c.prop;
    if (p.heldBy) this.app.grab.forceRelease(p.heldBy);
    p.parked = true;
    p.manual = true;
    c.mesh.visible = false;
    p.collider.setEnabled(false);
    this.app.physics.setKinematic(p, true);
    c.active = false;
  }

  private heldCartridge(h: HandInput): Cartridge | null {
    const p = this.app.grab.held(h);
    return p ? (this.cartridges.find((c) => c.prop === p) ?? null) : null;
  }

  /**
   * Before the grab system: hands squeezing at a locker take the pistol or a
   * cartridge from it; a cartridge brought to an open, empty breech goes in;
   * a live cartridge can be pulled back out of an open breech.
   */
  preUpdate(claimed: Set<HandInput>): void {
    const app = this.app;
    const s = app.rigScale;
    for (const gun of this.guns) {
      const h = gun.held;
      if (!h || !gun.open) continue;
      const o = app.input.other(h);
      const mouth = gun.mouthWorld(_v);
      const c = this.heldCartridge(o);
      if (!gun.chamber && c?.kind) {
        const centre = c.prop.object.localToWorld(_v2.set(0, SHELL.length / 2, 0));
        if (centre.distanceTo(mouth) < LOAD_REACH * s) {
          gun.chamber = c.kind;
          gun.spent = false;
          gun.showChamber((k) => this.geometry(k));
          this.parkCartridge(c);
          cartridgeIn(mouth);
          o.pulse(0.4, 20);
          h.pulse(0.3, 20);
          bus.emit('flare-load', { kind: gun.chamber.id, id: gun.prop.id });
        }
      } else if (gun.chamber && !gun.spent && o.squeeze.down && !app.grab.held(o) && !claimed.has(o) && o.grip.valid && o.grip.position.distanceTo(mouth) < LOAD_REACH * s * 1.3) {
        // Pull a live cartridge back out (to swap it for another kind).
        const kind = gun.chamber;
        gun.chamber = null;
        const c2 = this.spawnCartridge(kind, mouth, gun.model.chamberShell.getWorldQuaternion(_q));
        app.grab.grab(o, c2.prop);
        bus.emit('flare-unload', { kind: kind.id });
      }
    }

    for (const h of app.input.hands) {
      if (!h.grip.valid || !h.squeeze.down || claimed.has(h) || app.grab.held(h)) continue;
      const reach = REACH * s;
      let bestD = Infinity;
      let act: (() => void) | null = null;
      for (const locker of this.lockers) {
        const gun = this.guns.find((g) => g.home === locker && g.docked);
        if (gun) {
          const d = gun.holsterWorld(_v).distanceTo(h.grip.position);
          if (d < reach * 1.6 && d < bestD) {
            bestD = d;
            act = () => gun.take(h);
          }
        }
        const slot = locker.nearestSlot(h.grip.position, reach);
        if (slot) {
          const d = locker.slotWorld(slot, _v).distanceTo(h.grip.position);
          if (d < bestD) {
            bestD = d;
            act = () => {
              locker.slotPose(slot, _v2, _q2);
              const c = this.spawnCartridge(slot.kind, _v2, _q2);
              locker.take(slot);
              app.grab.grab(h, c.prop);
              bus.emit('flare-take', { what: slot.kind.id, hand: h.handedness });
            };
          }
        }
      }
      act?.();
    }
  }

  /** After the grab system: the pistols' buttons, the flights, the lockers. */
  update(dt: number): void {
    this.time += dt;
    for (const gun of this.guns) {
      const h = gun.held;
      if (h) {
        if (h.a.down) gun.setOpen(!gun.open, h);
        else if (gun.open && performance.now() - gun.openedAt > 250 && h.angularVelocity.dot(_v.copy(X).applyQuaternion(gun.prop.object.quaternion)) > FLICK) gun.setOpen(false, h);
        if (h.trigger.down) gun.pull(h);
      }
      gun.animate(dt);
    }
    for (const l of this.lockers) l.update(dt);
    this.flights.update(dt);
    for (const c of this.cartridges) {
      if (c.active && !c.prop.heldBy && this.time - c.bornAt > (c.kind ? LOOSE_LIFE : SPENT_LIFE)) this.parkCartridge(c);
    }
    this.flash.intensity *= Math.exp(-dt * 30);
  }

  /** Launch a flare (the pistol calls this; tests can too). */
  fire(kind: ShellKind, from: Vector3, dir: Vector3): void {
    // Fired from the moving skyboat, it keeps the boat's speed.
    const boat = this.app.boat;
    const inherit = boat.aboard ? new Vector3(-Math.sin(boat.heading) * boat.speed, boat.climb, -Math.cos(boat.heading) * boat.speed) : null;
    this.flights.launch(kind, from, dir, inherit);
    // Muzzle flash: a burst of light, sparks and a puff of smoke.
    this.flash.pos.copy(from);
    this.flash.intensity = 900;
    this.app.fx.burst(from, 18, 3, new Color(1, 0.65, 0.3).multiplyScalar(2.2), { size: 0.05, sizeEnd: 0.01, life: 0.25, drag: 4 });
    for (let i = 0; i < 5; i++) {
      this.smoke.emit({ pos: from, vel: dir.clone().multiplyScalar(1 + Math.random() * 2), color: new Color(0.85, 0.85, 0.85), size: 0.08, sizeEnd: 0.6, life: 2.2, alpha: 0.5, rise: 0.15, windy: 0.4 });
    }
  }

  /** Last thing before drawing: give out the lights, light the clouds, light and sort the smoke. */
  lateUpdate(dt: number): void {
    const app = this.app;
    const eye = app.headPosition(_v2);
    const emitters = this.emitters;
    emitters.length = 0;
    emitters.push(...this.flights.emitters);
    if (this.flash.intensity > 5) emitters.push(this.flash);
    this.lights.assign(emitters, eye);
    app.clouds.setFlares(this.lights.strongest);
    // Smoke is lit by the sky (dim at night) plus the flares around it.
    const p = app.tod.current;
    const l = this.smokeLight;
    l.copy(p.hemiSky).multiplyScalar(p.hemiIntensity * 0.55);
    l.r += p.keyColor.r * p.keyIntensity * 0.22;
    l.g += p.keyColor.g * p.keyIntensity * 0.22;
    l.b += p.keyColor.b * p.keyIntensity * 0.22;
    l.add(this.lights.ambient.color);
    // Capped below 1 so coloured smoke stays saturated in daylight.
    l.r = clamp(l.r, 0, 0.9);
    l.g = clamp(l.g, 0, 0.9);
    l.b = clamp(l.b, 0, 0.9);
    if (this.smoke.count > 0) this.smoke.update(dt, WIND, l, emitters, eye, app.scene.fog instanceof FogExp2 ? app.scene.fog : null);
  }

  /** Everything home: pistols in their cases (empty), the sky clear, lockers full. */
  reset(): void {
    for (const g of this.guns) {
      g.chamber = null;
      g.spent = false;
      g.dock();
    }
    for (const c of this.cartridges) if (c.active) this.parkCartridge(c);
    for (const l of this.lockers) l.refillAll();
    this.flights.clear();
    this.smoke.clear();
    this.flash.intensity = 0;
    this.lights.clear();
    this.app.clouds.setFlares([]);
  }

  /** Test hook: fire a cartridge kind straight from a point. */
  launch(kindId: string, from: Vector3, dir: Vector3): void {
    this.fire(KINDS.find((k) => k.id === kindId)!, from, dir);
  }
}
