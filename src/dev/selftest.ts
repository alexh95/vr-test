import { Quaternion, Vector3 } from 'three';
import { setSetting, settings } from '../core/settings';
import { HELM } from '../skyboat/boat-model';
import { THROTTLE_MAX } from '../skyboat/skyboat';
import type { FlareGun } from '../flares/flares';
import { SINK, SLOW, TRIM } from '../glider/glider';
import { THERMALS } from '../glider/air';
import { WIND } from '../world/wind';
import { RX } from '../portals/portals';
import { measureLuma } from './snapshot';
import type { App } from '../app';
import type { Emu } from './emulator';
import { createDriver, type Driver } from './driver';

/**
 * Scripted playtest against the emulated headset: every feature is driven the
 * way a player would (move a controller, squeeze, flick, poke) and checked
 * through game state and events. Run with `?emulate&selftest` (all checks) or
 * `?emulate&selftest=grab-and-throw,teleport` (some).
 * Prints one JSON line per check: [selftest] {"name":…,"ok":…,"ms":…}
 */

export interface CheckResult {
  name: string;
  ok: boolean;
  ms: number;
  detail?: unknown;
  error?: string;
}

type Check = [name: string, fn: (d: Driver) => Promise<unknown>];

const expect = (cond: boolean, msg: string) => {
  if (!cond) throw new Error(msg);
};


// ---- archery helpers ----
const DECK_EYE = new Vector3(-6.5, 1.75, -0.5);

async function standOnDeck(d: Driver): Promise<void> {
  d.app.rig.position.set(DECK_EYE.x, 0.16, DECK_EYE.z);
  d.app.rig.rotation.y = 0;
  d.app.updateRig();
  d.setHeadWorld(DECK_EYE.clone(), 90, 0); // facing west, down the range
  await d.frames(3);
}

async function takeBow(d: Driver): Promise<void> {
  const bow = d.app.bow.prop;
  d.setGripWorld('left', bow.object.position.clone(), bow.object.quaternion.clone());
  await d.frames(4);
  d.press('left', 'squeeze', 1);
  await d.frames(4);
  expect(d.app.grab.held(d.app.input.left) === bow, 'bow not in the left hand');
}

/** Hold the bow out toward `aim`, grab the string with the right hand and draw `draw` m along `arrowDir`. */
async function drawBow(d: Driver, aim: Vector3, draw: number, arrowDir?: Vector3): Promise<void> {
  const head = d.head();
  const bowAim = head.clone().addScaledVector(aim.clone().sub(head).normalize(), 0.66).add(new Vector3(0, -0.15, 0));
  d.setAimWorld('left', bowAim, d.lookQuat(bowAim, aim));
  await d.seconds(0.25);
  const rest = d.app.bow.restWorld(new Vector3());
  const fwd = arrowDir ? arrowDir.clone().normalize() : aim.clone().sub(rest).normalize();
  const q = d.lookQuat(new Vector3(), fwd);
  d.setPinchWorld('right', rest.clone().addScaledVector(fwd, -0.145), q);
  await d.frames(5);
  d.press('right', 'squeeze', 1);
  await d.frames(3);
  expect(!!d.app.bow.drawHand, 'the string was not grabbed');
  const t0 = performance.now();
  for (;;) {
    const k = Math.min(1, (performance.now() - t0) / 450);
    d.setPinchWorld('right', rest.clone().addScaledVector(fwd, -(0.145 + draw * k)), q);
    if (k >= 1) break;
    await d.frames(1);
  }
  await d.seconds(0.25);
}

/** Fire a pooled arrow straight from `from` toward `to` (bypassing the bow). */
function shootDirect(d: Driver, from: Vector3, to: Vector3, speed: number): void {
  const a = d.app.arrows.nock();
  d.app.arrows.fire(a, from, to.clone().sub(from).normalize(), speed);
}

// ---- skyboat helpers ----
const PILOT_EYE = new Vector3(0, 1.6, 2.55); // boat frame

/** Move the boat out into open sky, clear of the pier and the island. */
function launchBoat(d: Driver): void {
  d.app.boat.placeAt(new Vector3(14, 6, 14), Math.PI);
}

/** Stand at the helm, facing the bow. */
async function boardBoat(d: Driver): Promise<void> {
  const boat = d.app.boat;
  const feet = boat.toWorld(new Vector3(0, 0, PILOT_EYE.z), new Vector3());
  d.app.rig.position.copy(feet);
  d.app.rig.rotation.y = boat.heading;
  d.app.updateRig();
  d.setHeadWorld(boat.toWorld(PILOT_EYE, new Vector3()), (boat.heading * 180) / Math.PI);
  // Hands down at the sides, away from the controls.
  for (const [side, x] of [['left', -0.25], ['right', 0.25]] as const) gripOnBoat(d, side, new Vector3(x, 0.85, 2.75));
  await d.frames(4);
  expect(boat.aboard, 'not aboard after stepping onto the deck');
}

/** Put a hand at a point given in the boat's frame (palm level). */
function gripOnBoat(d: Driver, side: 'left' | 'right', local: Vector3): void {
  const boat = d.app.boat;
  d.setGripWorld(side, boat.toWorld(local, new Vector3()), new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), boat.heading));
}

/** Move a hand along a path in the boat's frame over `s` seconds (the boat may be moving). */
async function sweepOnBoat(d: Driver, side: 'left' | 'right', path: (k: number) => Vector3, s: number): Promise<void> {
  const t0 = performance.now();
  for (;;) {
    const k = Math.min(1, (performance.now() - t0) / 1000 / s);
    gripOnBoat(d, side, path(k));
    await d.frames(1);
    if (k >= 1) return;
  }
}

/** Where the head is on the deck. */
const headOnBoat = (d: Driver) => d.app.boat.toLocal(d.head(), new Vector3());

// ---- flare helpers ----

/** Stand facing a flare locker, half a metre in front of it. */
async function standAtLocker(d: Driver, gun: FlareGun): Promise<Vector3> {
  const L = gun.home;
  const q = L.root.getWorldQuaternion(new Quaternion());
  const front = new Vector3(0, 0, 1).applyQuaternion(q).setY(0).normalize();
  const feet = L.root.getWorldPosition(new Vector3()).addScaledVector(front, 0.55);
  const yaw = Math.atan2(front.x, front.z) + Math.PI; // facing the locker
  d.app.rig.position.copy(feet);
  d.app.rig.rotation.y = yaw;
  d.app.updateRig();
  d.setHeadWorld(feet.clone().setY(feet.y + 1.6), (yaw * 180) / Math.PI, -35);
  await d.frames(4);
  return front.negate();
}

/** Take the pistol out of its case with the right hand and hold it out in front. */
async function takePistol(d: Driver, gun: FlareGun, fwd: Vector3): Promise<Vector3> {
  d.setGripWorld('right', gun.holsterWorld(new Vector3()), new Quaternion());
  await d.frames(3);
  d.press('right', 'squeeze', 1);
  await d.frames(3);
  expect(d.app.grab.held(d.app.input.right) === gun.prop, 'pistol not in hand');
  const at = d.head().addScaledVector(fwd, 0.35).add(new Vector3(0.12, -0.25, 0));
  d.setAimWorld('right', at, d.lookQuat(at, at.clone().add(fwd).add(new Vector3(0, 0.15, 0))));
  // Wait in time, not frames: the swing up from the case must leave the velocity window.
  await d.seconds(0.25);
  return at;
}

async function pressA(d: Driver): Promise<void> {
  d.press('right', 'a-button', 1);
  await d.frames(2);
  d.press('right', 'a-button', 0);
  await d.frames(6);
}

/** Left hand takes a cartridge of `kind` from the gun's locker and pushes it into the open breech. */
async function loadCartridge(d: Driver, gun: FlareGun, kind: string): Promise<void> {
  const slot = gun.home.slots.find((s) => s.kind.id === kind)!;
  d.setGripWorld('left', gun.home.slotWorld(slot, new Vector3()), new Quaternion());
  await d.frames(3);
  d.press('left', 'squeeze', 1);
  await d.frames(3);
  const held = d.app.grab.held(d.app.input.left);
  expect(!!held && held.id.startsWith('flare-cartridge'), `left hand holds ${held?.id ?? 'nothing'}`);
  // Move toward wherever the breech is now (the boat may be carrying both hands along).
  const offset = d.app.input.left.grip.position.clone().sub(gun.mouthWorld(new Vector3()));
  const t0 = performance.now();
  for (;;) {
    const k = Math.min(1, (performance.now() - t0) / 300);
    d.setGripWorld('left', gun.mouthWorld(new Vector3()).addScaledVector(offset, 1 - k), new Quaternion());
    await d.frames(1);
    if (k >= 1) break;
  }
  await d.frames(3);
  d.press('left', 'squeeze', 0);
  expect(gun.chamber?.id === kind, `chamber holds ${gun.chamber?.id ?? 'nothing'}`);
  expect(!d.app.grab.held(d.app.input.left), 'the cartridge stayed in the hand');
}

async function pullTrigger(d: Driver): Promise<void> {
  d.press('right', 'trigger', 1);
  await d.frames(3);
  d.press('right', 'trigger', 0);
  await d.frames(3);
}

// ---- glider helpers ----

/** Toggles in hand at head height minus `left`/`right` m (0.2: hands up, no brake; 0.8: fully down). */
function setToggles(d: Driver, left: number, right: number): void {
  const head = d.head();
  const yaw = d.app.input.headYaw();
  const side = new Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
  const fwd = new Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
  const q = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), yaw).multiply(d.qx(-17));
  d.setGripWorld('left', head.clone().addScaledVector(side, -0.25).addScaledVector(fwd, 0.2).setY(head.y - left), q);
  d.setGripWorld('right', head.clone().addScaledVector(side, 0.25).addScaledVector(fwd, 0.2).setY(head.y - right), q);
}

/** Stand at a rack, take both toggles off its hooks and let the wing rise. */
async function takeGlider(d: Driver, rackIndex = 0): Promise<void> {
  const app = d.app;
  const rack = app.glider.racks[rackIndex];
  const yaw = rack.root.rotation.y;
  app.rig.position.copy(rack.stand);
  app.rig.rotation.y = yaw;
  app.updateRig();
  d.setHeadWorld(rack.stand.clone().setY(rack.stand.y + 1.65), (yaw * 180) / Math.PI, -10);
  const q = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), yaw).multiply(d.qx(-17));
  d.setGripWorld('left', rack.hook(0).clone(), q);
  d.setGripWorld('right', rack.hook(1).clone(), q);
  await d.frames(4);
  d.press('left', 'squeeze', 1);
  d.press('right', 'squeeze', 1);
  await d.frames(3);
  expect(app.glider.state === 'ground', `taking the toggles left the glider ${app.glider.state}`);
  expect(app.glider.holding.size === 2, `holding ${app.glider.holding.size} toggles`);
  setToggles(d, 0.2, 0.2);
  await d.seconds(1.3);
}

/** Wearing the wing: be carried out over the void at `at` facing `yaw`, and fly. */
async function flyFrom(d: Driver, at: Vector3, yaw: number): Promise<void> {
  const app = d.app;
  app.locomotion.turn(yaw - app.input.headYaw());
  app.glider.heading = yaw;
  const head = d.head();
  app.rig.position.add(at.clone().sub(head));
  app.updateRig();
  setToggles(d, 0.2, 0.2);
  await d.waitFor(() => app.glider.state === 'flying', 3, 'the launch');
}

const DEG2 = 180 / Math.PI;

// ---- portal helpers ----

/** A portal's facing (unit, horizontal): out of its front. */
const portalFront = (yaw: number) => new Vector3(Math.sin(yaw), 0, Math.cos(yaw));

const CHECKS: Check[] = [
  [
    'session',
    async (d) => {
      const info = d.app.xr.info!;
      expect(info.referenceSpace === 'local-floor', `reference space ${info.referenceSpace}`);
      const h = d.head();
      expect(Math.abs(h.y - 1.6) < 0.05, `head height ${h.y.toFixed(2)}`);
      expect(d.app.input.right.profiles.length > 0, 'no input profiles');
      return { referenceSpace: info.referenceSpace, profiles: d.app.input.right.profiles };
    },
  ],
  [
    'hand-pose-follows-buttons',
    async (d) => {
      d.press('right', 'trigger', 1);
      d.press('right', 'squeeze', 1);
      await d.frames(20);
      const closed = { ...d.app.handModels.right.curls };
      d.press('right', 'trigger', 0);
      d.press('right', 'squeeze', 0);
      await d.frames(20);
      const open = { ...d.app.handModels.right.curls };
      expect(closed.index > 0.8 && closed.middle > 0.8, `fist not closed: ${JSON.stringify(closed)}`);
      expect(open.index < 0.35 && open.middle < 0.35, `hand not open: ${JSON.stringify(open)}`);
      expect(d.app.handModels.right.root.visible && d.app.handModels.left.root.visible, 'hands not visible');
      return { closedIndex: +closed.index.toFixed(2), openIndex: +open.index.toFixed(2) };
    },
  ],
  [
    'grab-and-throw',
    async (d) => {
      const ball = d.app.physics.props.find((p) => p.id === 'ball-0')!;
      const start = ball.object.position.clone();
      d.setGripWorld('right', start.clone(), new Quaternion());
      await d.frames(4);
      d.press('right', 'squeeze', 1);
      await d.frames(4);
      expect(d.app.grab.held(d.app.input.right) === ball, `holding ${d.app.grab.held(d.app.input.right)?.id ?? 'nothing'}`);
      // Lift it, pause, then a quick overhand-ish throw toward -Z, letting go mid-swing.
      const wind = d.head().add(new Vector3(0.15, -0.2, 0.05));
      await d.sweepGrip('right', start, wind, 0.35, new Quaternion());
      await d.seconds(0.15);
      const throws = d.count('throw');
      await d.sweepGrip('right', wind, wind.clone().add(new Vector3(0, 0.25, -0.75)), 0.14, new Quaternion(), () => d.press('right', 'squeeze', 0));
      await d.frames(3);
      expect(d.count('throw') > throws, `no throw event (release ${JSON.stringify(d.last('release'))})`);
      const speed = (d.last('throw') as { speed: number }).speed;
      const from = ball.object.position.clone();
      await d.seconds(1.2);
      const moved = ball.object.position.distanceTo(from);
      expect(moved > 2, `ball only moved ${moved.toFixed(2)} m after release at ${speed} m/s`);
      return { speed, moved: +moved.toFixed(2) };
    },
  ],
  [
    'teleport',
    async (d) => {
      const before = d.app.rig.position.clone();
      d.setAimWorld('right', d.head().add(new Vector3(0.2, -0.35, -0.3)), d.qx(-20));
      await d.frames(3);
      d.emu.stick('right', 0, -1);
      await d.frames(15);
      const t = d.app.locomotion.target;
      expect(t.valid, 'arc has no valid landing');
      const landing = t.point.clone();
      d.emu.stick('right', 0, 0);
      await d.frames(25);
      const moved = d.app.rig.position.distanceTo(before);
      expect(moved > 1, `rig moved ${moved.toFixed(2)} m`);
      const h2 = d.head();
      expect(Math.hypot(h2.x - landing.x, h2.z - landing.z) < 0.05, 'head not over landing point');
      return { landing: landing.toArray().map((v) => +v.toFixed(2)), moved: +moved.toFixed(2) };
    },
  ],
  [
    'teleport-rejects-abyss',
    async (d) => {
      // Aim off the island's open south edge (the east rim has the pier): no landing.
      d.app.rig.position.set(-1, 0, 7.3);
      d.app.rig.rotation.y = Math.PI; // face +Z
      d.app.updateRig();
      d.setHeadWorld(new Vector3(-1, 1.6, 7.3), 180);
      await d.frames(3);
      const hp = d.head();
      d.setAimWorld('right', hp.clone().add(new Vector3(-0.15, -0.3, 0.3)), d.lookQuat(hp, hp.clone().add(new Vector3(0, 1.5, 10))));
      d.emu.stick('right', 0, -1);
      await d.frames(15);
      const valid = d.app.locomotion.target.valid;
      const teleports = d.count('teleport');
      d.emu.stick('right', 0, 0);
      await d.frames(20);
      expect(!valid, 'arc found a landing over the abyss');
      expect(d.count('teleport') === teleports, 'teleported into the void');
      return { valid };
    },
  ],
  [
    'snap-turn',
    async (d) => {
      const yaw0 = d.app.rig.rotation.y;
      const h0 = d.head();
      d.emu.stick('right', 1, 0);
      await d.frames(4);
      d.emu.stick('right', 0, 0);
      await d.frames(4);
      const deg = ((d.app.rig.rotation.y - yaw0) * 180) / Math.PI;
      expect(Math.abs(deg + 45) < 0.5, `turned ${deg.toFixed(1)}°`);
      expect(d.head().distanceTo(h0) < 0.01, 'head moved during turn');
      return { degrees: +deg.toFixed(1) };
    },
  ],
  [
    'smooth-turn',
    async (d) => {
      setSetting('turn', 'smooth');
      try {
        const y0 = d.app.rig.rotation.y;
        const h0 = d.head();
        d.emu.stick('right', 1, 0);
        await d.seconds(0.5);
        d.emu.stick('right', 0, 0);
        await d.frames(3);
        const deg = ((d.app.rig.rotation.y - y0) * 180) / Math.PI;
        expect(deg < -30 && deg > -90, `turned ${deg.toFixed(1)}° in 0.5 s`);
        expect(d.head().distanceTo(h0) < 0.01, 'head drifted while turning');
        return { degrees: +deg.toFixed(1) };
      } finally {
        setSetting('turn', 'snap45');
      }
    },
  ],
  [
    'left-stick-teleport',
    async (d) => {
      setSetting('leftStick', 'teleport');
      try {
        const r0 = d.app.rig.position.clone();
        d.setAimWorld('left', d.head().add(new Vector3(-0.2, -0.35, -0.3)), d.qx(-20));
        await d.seconds(0.15);
        d.emu.stick('left', 0, -1);
        await d.frames(12);
        expect(d.app.locomotion.target.valid, 'left arc has no landing');
        d.emu.stick('left', 0, 0);
        await d.frames(25);
        const moved = d.app.rig.position.distanceTo(r0);
        expect(moved > 1, `moved ${moved.toFixed(2)} m`);
        return { moved: +moved.toFixed(2) };
      } finally {
        setSetting('leftStick', 'move');
      }
    },
  ],
  [
    'tracked-hands',
    async (d) => {
      // Articulated hand tracking (not on the Frame, but the same build runs on headsets that have it).
      d.emu.device.primaryInputMode = 'hand';
      try {
        await d.seconds(0.4);
        const l = d.app.input.left;
        expect(l.hasJoints && l.jointsValid, 'no joint data');
        expect(d.app.handModels.left.jointDriven, 'hand model not joint-driven');
        const rh = d.emu.device.hands.right!;
        rh.poseId = 'pinch';
        rh.updatePinchValue(1);
        await d.seconds(0.3);
        expect(d.app.input.right.trigger.pressed, 'pinch did not press the trigger');
        return { profiles: l.profiles.slice(0, 2) };
      } finally {
        d.emu.device.primaryInputMode = 'controller';
        await d.seconds(0.3);
      }
    },
  ],
  [
    'smooth-walk',
    async (d) => {
      const h0 = d.head();
      d.emu.stick('left', 0, -1);
      await d.seconds(0.6);
      d.emu.stick('left', 0, 0);
      await d.frames(3);
      const h1 = d.head();
      const dist = h1.distanceTo(h0);
      expect(dist > 0.6 && h1.z < h0.z, `walked ${dist.toFixed(2)} m (z ${h0.z.toFixed(2)} → ${h1.z.toFixed(2)})`);
      return { walked: +dist.toFixed(2) };
    },
  ],
  [
    'gravity-gloves',
    async (d) => {
      const orb = d.app.physics.props.find((p) => p.id.startsWith('orb-') && p.spawnPos.y > 3)!;
      const aimPos = d.head().add(new Vector3(0.18, -0.3, -0.25));
      d.setAimWorld('right', aimPos, d.lookQuat(aimPos, orb.object.position));
      // Wait in time, not frames: the hand jump must leave the velocity window at any frame rate.
      await d.seconds(0.2);
      expect(d.app.gloves.target(d.app.input.right) === orb, `glove target ${d.app.gloves.target(d.app.input.right)?.id ?? 'none'}`);
      d.press('right', 'squeeze', 1);
      await d.seconds(0.12);
      expect(d.app.gloves.phase(d.app.input.right) === 'locked', `phase ${d.app.gloves.phase(d.app.input.right)}`);
      // Flick: snap the hand back toward the head and up, then hold still with grip closed.
      const g0 = d.app.input.right.grip.position.clone();
      const q0 = d.app.input.right.grip.quaternion.clone();
      const toHead = d.head().sub(g0).setY(0).normalize().multiplyScalar(0.22);
      await d.sweepGrip('right', g0, g0.clone().add(toHead).add(new Vector3(0, 0.12, 0)), 0.09, q0);
      expect(d.count('glove-pull') > 0, 'no pull');
      await d.waitFor(() => d.app.grab.held(d.app.input.right) === orb, 3, `orb to arrive (orb at ${orb.object.position.toArray().map((v) => v.toFixed(2))}, hand at ${d.app.input.right.grip.position.toArray().map((v) => v.toFixed(2))})`);
      return { orb: orb.id, flightMs: (d.last('glove-catch') as { ms: number })?.ms };
    },
  ],
  [
    'brush-paint',
    async (d) => {
      const brush = d.app.brushes.brushes[0];
      d.setGripWorld('right', brush.object.position.clone(), d.qx(-60));
      await d.frames(4);
      d.press('right', 'squeeze', 1);
      await d.frames(4);
      expect(d.app.grab.held(d.app.input.right) === brush, 'brush not in hand');
      const pot = d.app.brushes.pots[2];
      const colors = d.count('paint-color');
      // Grip pitched -60° + the brush's -30° = pointing straight down: tip is 0.135 m below the grip.
      const above = pot.pos.clone().add(new Vector3(0, 0.2, 0));
      const into = pot.pos.clone().add(new Vector3(0, 0.135 - 0.012, 0));
      await d.sweepGrip('right', above, into, 0.25, d.qx(-60));
      await d.frames(4);
      expect(d.count('paint-color') > colors, 'dipping did not change colour');
      const c = d.head().add(new Vector3(0, -0.25, -0.45));
      d.setGripWorld('right', c, new Quaternion());
      await d.frames(3);
      d.press('right', 'trigger', 0.8);
      const t0 = performance.now();
      while (performance.now() - t0 < 900) {
        const a = ((performance.now() - t0) / 900) * Math.PI * 2;
        d.setGripWorld('right', c.clone().add(new Vector3(Math.cos(a) * 0.2, Math.sin(a) * 0.2, 0)), new Quaternion());
        await d.frames(1);
      }
      d.press('right', 'trigger', 0);
      await d.frames(3);
      const ev = d.last('stroke-end') as { points: number; length: number } | undefined;
      expect(!!ev && ev.points > 20, `stroke ${JSON.stringify(ev)}`);
      return ev;
    },
  ],
  [
    'marimba-finger',
    async (d) => {
      const bar = d.app.marimba.bars[5];
      const top = bar.mesh.getWorldPosition(new Vector3()).add(new Vector3(0, 0.013, 0));
      d.setGripWorld('right', top.clone().add(new Vector3(0, 0.3, 0)), new Quaternion());
      const tipOff = await d.fingertipOffset('right');
      const notes = d.app.marimba.notesPlayed;
      const start = top.clone().sub(tipOff).add(new Vector3(0, 0.06, 0));
      d.setGripWorld('right', start, new Quaternion());
      await d.frames(4);
      await d.sweepGrip('right', start, start.clone().add(new Vector3(0, -0.08, 0)), 0.05, new Quaternion());
      await d.frames(3);
      expect(d.app.marimba.notesPlayed > notes, 'no note');
      return d.last('note');
    },
  ],
  [
    'marimba-ball',
    async (d) => {
      const ball = d.app.physics.props.find((p) => p.id === 'ball-1')!;
      const bar = d.app.marimba.bars[8];
      const notes = d.app.marimba.notesPlayed;
      d.app.physics.place(ball, bar.mesh.getWorldPosition(new Vector3()).add(new Vector3(0, 0.5, 0)), new Quaternion());
      ball.body.setLinvel({ x: 0, y: -1, z: 0 }, true);
      await d.waitFor(() => d.app.marimba.notesPlayed > notes, 2, 'ball to hit the bar');
      return d.last('note');
    },
  ],
  [
    'firework-from-hand',
    async (d) => {
      const rocket = d.app.fireworks.rockets[0];
      d.setGripWorld('right', rocket.object.position.clone(), d.qx(90));
      await d.frames(4);
      d.press('right', 'squeeze', 1);
      await d.frames(4);
      expect(d.app.grab.held(d.app.input.right) === rocket, 'rocket not in hand');
      const launches = d.count('rocket-launch');
      const bursts = d.count('rocket-burst');
      const lit = d.count('rocket-lit');
      d.setGripWorld('right', d.head().add(new Vector3(0.25, -0.2, -0.3)), d.qx(90));
      await d.frames(4);
      d.press('right', 'trigger', 1);
      await d.frames(3);
      expect(d.count('rocket-lit') > lit, 'fuse not lit');
      await d.waitFor(() => d.count('rocket-launch') > launches, 2.5, 'launch');
      expect(d.app.grab.held(d.app.input.right) === null, 'rocket still in hand after launch');
      await d.waitFor(() => d.count('rocket-burst') > bursts, 4, 'burst');
      d.press('right', 'trigger', 0);
      d.press('right', 'squeeze', 0);
      return d.last('rocket-burst');
    },
  ],
  [
    'console-button-ray',
    async (d) => {
      const before = d.app.tod.name;
      const target = d.app.console.buttonWorld('sky', new Vector3());
      const from = target.clone().add(new Vector3(0, 0.35, 0)).add(new Vector3().subVectors(d.head(), target).setY(0).normalize().multiplyScalar(0.4));
      d.setAimWorld('right', from, d.lookQuat(from, target));
      await d.frames(4);
      d.press('right', 'trigger', 1);
      await d.frames(3);
      d.press('right', 'trigger', 0);
      await d.frames(2);
      const after = d.app.tod.name;
      expect(after !== before, `time of day still ${after}`);
      while (d.app.tod.name !== 'sunset') d.app.tod.next();
      return { from: before, to: after };
    },
  ],
  [
    'console-button-poke',
    async (d) => {
      const presses = d.count('button');
      const cap = d.app.console.buttonWorld('reset', new Vector3());
      d.setGripWorld('right', cap.clone().add(new Vector3(0, 0.3, 0)), new Quaternion());
      const tipOff = await d.fingertipOffset('right');
      const start = cap.clone().sub(tipOff).add(new Vector3(0, 0.06, 0));
      await d.sweepGrip('right', start, start.clone().add(new Vector3(0, -0.075, 0)), 0.25, new Quaternion());
      await d.frames(4);
      expect(d.count('button') > presses, 'button did not fire');
      return d.last('button');
    },
  ],
  [
    'gravity-lever',
    async (d) => {
      const knob = d.app.console.knobWorld(new Vector3());
      d.setGripWorld('right', knob, new Quaternion());
      await d.frames(4);
      d.press('right', 'squeeze', 1);
      await d.frames(3);
      const toPlayer = new Vector3().subVectors(d.head(), knob).setY(0).normalize();
      await d.sweepGrip('right', knob, knob.clone().addScaledVector(toPlayer, 0.26).add(new Vector3(0, -0.1, 0)), 0.4, new Quaternion());
      await d.frames(4);
      expect(!d.app.physics.gravityOn, 'gravity still on after pulling the lever');
      // Things float.
      const ball = d.app.physics.props.find((p) => p.id === 'ball-2')!;
      const y0 = ball.object.position.y;
      await d.seconds(0.8);
      const lift = ball.object.position.y - y0;
      const k2 = d.app.input.right.grip.position.clone();
      await d.sweepGrip('right', k2, knob.clone().addScaledVector(toPlayer, -0.12).add(new Vector3(0, 0.05, 0)), 0.4, new Quaternion());
      await d.frames(4);
      expect(d.app.physics.gravityOn, 'gravity did not come back');
      d.press('right', 'squeeze', 0);
      expect(lift > 0.05, `ball didn't float (lift ${lift.toFixed(3)} m)`);
      return { toggles: d.count('lever'), floatLift: +lift.toFixed(2) };
    },
  ],
  [
    'bow-draw-and-hit',
    async (d) => {
      await standOnDeck(d);
      await takeBow(d);
      const near = d.app.range.targets.find((t) => t.id === 'near')!;
      const hits = d.count('target-hit');
      const renders = d.app.bow.scope.renders;
      await drawBow(d, near.group.position.clone(), 0.6);
      expect(d.app.bow.draw > 0.55, `draw only ${d.app.bow.draw.toFixed(2)} m`);
      expect(d.app.bow.scope.renders > renders + 5, 'scope view is not being rendered');
      d.press('right', 'squeeze', 0);
      await d.frames(2);
      const shot = d.last('arrow-shot') as { speed: number };
      expect(!!shot && shot.speed > 65, `arrow speed ${shot?.speed}`);
      await d.waitFor(() => d.count('target-hit') > hits, 2, 'the arrow to hit the 12 m target');
      const hit = d.last('target-hit') as { id: string; points: number };
      expect(hit.id === 'near', `hit ${hit.id}`);
      const stuck = d.app.arrows.arrows.some((a) => a.state === 'stuck' && a.mesh.parent === near.group);
      expect(stuck, 'arrow did not stick in the target');
      return { speed: shot.speed, points: hit.points };
    },
  ],
  [
    'scope-zeroed-35m',
    async (d) => {
      // Put the red dot on a point 35 m away; the full-draw arrow should land within a hand's width of it.
      await standOnDeck(d);
      await takeBow(d);
      const P = new Vector3(-41.3, 1.2, -0.9);
      // First draw: aim the arrow straight at P, then see where the scope axis points and correct by that error.
      await drawBow(d, P, 0.62);
      const S = d.app.bow.scope.lens.getWorldPosition(new Vector3());
      const axis = d.app.bow.scope.axis(new Vector3());
      const want = P.clone().sub(S).normalize();
      const shotDir = new Vector3(0, 0, -1).transformDirection(d.app.bow.group.matrixWorld);
      const newDir = shotDir.clone().applyQuaternion(new Quaternion().setFromUnitVectors(axis, want));
      // Let down without shooting (tiny draw), then draw again with the dot on P.
      d.setPinchWorld('right', d.app.bow.restWorld(new Vector3()).addScaledVector(shotDir, -0.16), d.lookQuat(new Vector3(), shotDir));
      await d.frames(3);
      d.press('right', 'squeeze', 0);
      await d.seconds(0.3);
      await drawBow(d, P, 0.62, newDir);
      const axis2 = d.app.bow.scope.axis(new Vector3());
      const S2 = d.app.bow.scope.lens.getWorldPosition(new Vector3());
      const aimErr = (axis2.angleTo(P.clone().sub(S2).normalize()) * 180) / Math.PI;
      // Follow the arrow through the vertical plane at P.
      const planeN = P.clone().sub(S2).setY(0).normalize();
      let crossing: Vector3 | null = null;
      let prev: Vector3 | null = null;
      d.press('right', 'squeeze', 0);
      const t0 = performance.now();
      while (!crossing && performance.now() - t0 < 2500) {
        await d.frames(1);
        const a = d.app.arrows.arrows.find((x) => x.state === 'flying');
        if (!a) continue;
        const tip = a.pos.clone().addScaledVector(a.vel.clone().normalize(), 0.8);
        const side = tip.clone().sub(P).dot(planeN);
        if (prev && side >= 0) {
          const ps = prev.clone().sub(P).dot(planeN);
          crossing = prev.clone().lerp(tip, -ps / (side - ps));
        }
        prev = tip;
      }
      expect(!!crossing, 'arrow never reached 35 m');
      const miss = crossing!.clone().sub(P);
      const vertical = miss.y;
      const lateral = Math.hypot(miss.x, miss.z);
      expect(Math.abs(vertical) < 0.25 && lateral < 0.25, `landed ${vertical.toFixed(2)} m vertical, ${lateral.toFixed(2)} m lateral from the dot (aim error ${aimErr.toFixed(2)} deg)`);
      return { verticalMiss: +vertical.toFixed(3), lateralMiss: +lateral.toFixed(3), aimErrDeg: +aimErr.toFixed(2) };
    },
  ],
  [
    'moving-targets-move',
    async (d) => {
      const movers = d.app.range.targets.filter((t) => t.moving);
      const before = movers.map((t) => t.group.position.clone());
      await d.seconds(0.6);
      const moved = movers.map((t, i) => +t.group.position.distanceTo(before[i]).toFixed(2));
      expect(movers.length >= 3 && moved.every((m) => m > 0.05), `moved ${JSON.stringify(moved)}`);
      return { moved: Object.fromEntries(movers.map((t, i) => [t.id, moved[i]])) };
    },
  ],
  [
    'balloon-pop',
    async (d) => {
      const b = d.app.range.balloons.find((x) => x.alive && x.pos.y > -2 && x.pos.y < 12);
      expect(!!b, 'no balloon in reach');
      const from = DECK_EYE.clone();
      const speed = 60;
      const dist = b!.pos.distanceTo(from);
      const t = dist / speed;
      // Lead the rising balloon and hold over for the drop.
      const aim = b!.pos.clone().add(new Vector3(0, b!.speed * t + 0.5 * 9.81 * t * t, 0));
      const pops = d.count('balloon-pop');
      shootDirect(d, from, aim, speed);
      await d.waitFor(() => d.count('balloon-pop') > pops, 2, 'the balloon to pop');
      return { distance: +dist.toFixed(1) };
    },
  ],
  [
    'arrow-knocks-can',
    async (d) => {
      const can = d.app.physics.props.find((p) => p.id === 'can-9')!; // the top of the pyramid
      const start = can.object.position.clone();
      shootDirect(d, start.clone().add(new Vector3(0.3, 0.05, 4.0)), start, 55);
      await d.seconds(1.0);
      const moved = can.object.position.distanceTo(start);
      expect(moved > 0.3, `can moved ${moved.toFixed(2)} m`);
      return { moved: +moved.toFixed(2) };
    },
  ],
  [
    'bow-docks-on-rack',
    async (d) => {
      await standOnDeck(d);
      await takeBow(d);
      const rack = d.app.range.rackPos.clone();
      d.setGripWorld('left', rack.clone().add(new Vector3(0.1, 0.05, 0)), d.app.range.rackQuat.clone());
      await d.frames(4);
      d.press('left', 'squeeze', 0);
      await d.seconds(0.5);
      const p = d.app.bow.prop;
      const dist = p.object.position.distanceTo(rack);
      expect(!p.heldBy && dist < 0.01, `bow is ${dist.toFixed(2)} m from the rack`);
      return { dist: +dist.toFixed(3) };
    },
  ],
  [
    'laser-dot-on-target',
    async (d) => {
      setSetting('laser', true);
      await standOnDeck(d);
      await takeBow(d);
      const near = d.app.range.targets.find((t) => t.id === 'near')!;
      // Hold the bow up at the target, no draw: the laser shows where it points.
      const head = d.head();
      const aim = near.group.position.clone();
      const bowAt = head.clone().addScaledVector(aim.clone().sub(head).normalize(), 0.62).add(new Vector3(0, -0.12, 0));
      d.setAimWorld('left', bowAt, d.lookQuat(bowAt, aim));
      await d.seconds(0.6);
      const L = d.app.bow.laser;
      expect(L.level > 0.95, `laser level ${L.level.toFixed(2)}`);
      expect(L.hit.kind === 'target' && L.hit.id === 'near', `laser lands on ${L.hit.kind} ${L.hit.id}`);
      expect(L.dot.visible && L.beam.visible, 'dot or beam hidden');
      const local = L.hit.point.clone().applyMatrix4(near.inv);
      const off = Math.hypot(local.x, local.y);
      expect(off < near.radius, `dot ${off.toFixed(2)} m from the centre, off the face`);
      // The beam crosses the scope's line of sight at the zero distance (35 m).
      const lens = d.app.bow.scope.lens.getWorldPosition(new Vector3());
      const zeroPoint = lens.clone().addScaledVector(d.app.bow.scope.axis(new Vector3()), 35);
      const onBeam = L.origin.clone().addScaledVector(L.dir, zeroPoint.distanceTo(L.origin));
      expect(onBeam.distanceTo(zeroPoint) < 0.06, `beam misses the scope's zero point by ${onBeam.distanceTo(zeroPoint).toFixed(3)} m`);
      // Y on the bow hand (left) switches it off, and on again.
      d.press('left', 'y-button', 1);
      await d.frames(3);
      d.press('left', 'y-button', 0);
      await d.seconds(0.6);
      expect(!settings.laser && L.level === 0 && !L.beam.visible, `laser still on (level ${L.level.toFixed(2)})`);
      d.press('left', 'y-button', 1);
      await d.frames(3);
      d.press('left', 'y-button', 0);
      await d.seconds(0.4);
      expect(settings.laser && L.level > 0.9, 'laser did not come back on');
      return { distance: +L.hit.distance.toFixed(2), offCentre: +off.toFixed(3), zeroMiss: +onBeam.distanceTo(zeroPoint).toFixed(3) };
    },
  ],
  [
    'skyboat-throttle-flies',
    async (d) => {
      const boat = d.app.boat;
      await boardBoat(d);
      // Right hand on the throttle knob, push it forward to the stop.
      const knob0 = boat.throttleKnobLocal(new Vector3(), 0);
      const full = boat.throttleKnobLocal(new Vector3(), THROTTLE_MAX);
      gripOnBoat(d, 'right', knob0);
      await d.frames(3);
      d.press('right', 'squeeze', 1);
      await d.frames(3);
      expect(boat.controlOf(d.app.input.right) === 'throttle', `right hand on ${boat.controlOf(d.app.input.right)}`);
      await sweepOnBoat(d, 'right', (k) => knob0.clone().lerp(full, k), 0.35);
      expect(boat.throttle > 0.9, `throttle at ${boat.throttle.toFixed(2)}`);
      const start = boat.pos.clone();
      const eye0 = headOnBoat(d);
      await d.seconds(2);
      const moved = boat.pos.distanceTo(start);
      const eye1 = headOnBoat(d);
      // Back to neutral and let go: the detent holds it at zero.
      await sweepOnBoat(d, 'right', (k) => full.clone().lerp(knob0, k), 0.3);
      d.press('right', 'squeeze', 0);
      await d.frames(3);
      expect(moved > 3, `boat moved only ${moved.toFixed(2)} m`);
      expect(boat.pos.z > start.z + 3, 'boat did not go toward its bow');
      expect(eye1.distanceTo(eye0) < 0.03, `the player slid ${eye1.distanceTo(eye0).toFixed(3)} m on the deck`);
      expect(boat.aboard, 'fell off the boat');
      expect(boat.throttle === 0, `throttle left at ${boat.throttle.toFixed(2)}`);
      return { moved: +moved.toFixed(2), speed: +boat.speed.toFixed(2), slide: +eye1.distanceTo(eye0).toFixed(4) };
    },
  ],
  [
    'skyboat-helm-turns',
    async (d) => {
      const boat = d.app.boat;
      launchBoat(d);
      await boardBoat(d);
      const h0 = boat.heading;
      const yaw0 = d.app.rig.rotation.y;
      // Right hand on the rim at 3 o'clock; turn the wheel up and over to the left (counter-clockwise).
      gripOnBoat(d, 'right', boat.wheelRimLocal(0, new Vector3()));
      await d.frames(3);
      d.press('right', 'squeeze', 1);
      await d.frames(3);
      expect(boat.controlOf(d.app.input.right) === 'wheel', `right hand on ${boat.controlOf(d.app.input.right)}`);
      await sweepOnBoat(d, 'right', (k) => boat.wheelRimLocal(k * 2.2, new Vector3()), 0.6);
      expect(boat.wheel > 2, `wheel at ${((boat.wheel * 180) / Math.PI).toFixed(0)}°`);
      const eye0 = headOnBoat(d);
      await d.seconds(1.5);
      const turned = boat.heading - h0;
      const eye1 = headOnBoat(d);
      d.press('right', 'squeeze', 0);
      await d.seconds(1.5);
      expect(turned > 0.12, `turned ${((turned * 180) / Math.PI).toFixed(1)}° (left)`);
      expect(Math.abs(d.app.rig.rotation.y - yaw0 - (boat.heading - h0)) < 0.01, 'the player did not turn with the boat');
      expect(eye1.distanceTo(eye0) < 0.03, `the player slid ${eye1.distanceTo(eye0).toFixed(3)} m while turning`);
      expect(Math.abs(boat.wheel) < 0.4, `wheel did not self-centre (${boat.wheel.toFixed(2)} rad)`);
      return { turnedDeg: +((turned * 180) / Math.PI).toFixed(1) };
    },
  ],
  [
    'skyboat-lift-climbs',
    async (d) => {
      const boat = d.app.boat;
      launchBoat(d);
      await boardBoat(d);
      const grip0 = boat.liftGripLocal(new Vector3(), 0);
      gripOnBoat(d, 'left', grip0);
      await d.frames(3);
      d.press('left', 'squeeze', 1);
      await d.frames(3);
      expect(boat.controlOf(d.app.input.left) === 'lift', `left hand on ${boat.controlOf(d.app.input.left)}`);
      const y0 = boat.pos.y;
      const eye0 = headOnBoat(d);
      await sweepOnBoat(d, 'left', (k) => grip0.clone().setY(grip0.y + 0.13 * k), 0.25);
      await d.seconds(1.5);
      const climbed = boat.pos.y - y0;
      const eye1 = headOnBoat(d);
      d.press('left', 'squeeze', 0);
      await d.seconds(1.5);
      expect(climbed > 1.5, `climbed only ${climbed.toFixed(2)} m`);
      expect(eye1.distanceTo(eye0) < 0.03, `the player slid ${eye1.distanceTo(eye0).toFixed(3)} m while climbing`);
      expect(Math.abs(boat.lift) < 0.05 && Math.abs(boat.climb) < 0.3, `handle did not spring back (lift ${boat.lift.toFixed(2)}, climb ${boat.climb.toFixed(2)})`);
      return { climbed: +climbed.toFixed(2), handle: +(HELM.liftTravel * 100).toFixed(0) };
    },
  ],
  [
    'skyboat-stops-at-cliff',
    async (d) => {
      const boat = d.app.boat;
      // Below the rim, bow first into the main island's rock face.
      boat.placeAt(new Vector3(17, -2.5, 4.5), Math.PI / 2);
      const bumps = d.count('boat-bump');
      boat.throttleAngle = THROTTLE_MAX;
      await d.seconds(3.5);
      boat.throttleAngle = 0;
      expect(d.count('boat-bump') > bumps, 'no bump');
      // Touching, not inside: no overlap now, and something solid within a hand's width ahead.
      const ahead = boat.clearance(new Vector3(-1, 0, 0), 1);
      expect(!boat.overlapping(), 'the hull is inside the rock');
      expect(ahead < 0.15, `stopped ${ahead.toFixed(2)} m short of anything`);
      expect(Math.abs(boat.speed) < 0.5, `still pushing on at ${boat.speed.toFixed(2)} m/s`);
      return { bowX: +(boat.pos.x - 3.2).toFixed(2), gap: +ahead.toFixed(3) };
    },
  ],
  [
    'skyboat-teleport-aboard-underway',
    async (d) => {
      const boat = d.app.boat;
      // Standing at the end of the pier as the boat goes by, slowly, a few metres out.
      boat.placeAt(new Vector3(15.6, 0.12, 2), Math.PI);
      boat.throttleAngle = THROTTLE_MAX * 0.25;
      boat.speed = 1.5;
      d.app.rig.position.set(11, 0.12, 0.9);
      d.app.rig.rotation.y = -Math.PI / 2;
      d.app.updateRig();
      d.setHeadWorld(new Vector3(11, 1.72, 0.9), -90);
      await d.frames(3);
      // Hold the stick forward and raise the aim until the arc lands on the deck.
      let target: Vector3 | null = null;
      d.emu.stick('right', 0, -1);
      for (let pitch = -40; pitch <= 10 && !target; pitch += 3) {
        const hp = d.head();
        d.setAimWorld('right', hp.clone().add(new Vector3(0.15, -0.35, 0.2)), new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), -Math.PI / 2).multiply(d.qx(pitch)));
        await d.frames(3);
        const t = d.app.locomotion.target;
        if (t.valid && t.platform === boat.root) target = boat.toLocal(t.point, new Vector3());
      }
      expect(!!target, 'never found a landing on the deck');
      d.emu.stick('right', 0, 0);
      await d.frames(30);
      boat.throttleAngle = 0;
      expect(boat.aboard, 'not aboard after the teleport');
      const eye = headOnBoat(d);
      const miss = Math.hypot(eye.x - target!.x, eye.z - target!.z);
      expect(miss < 0.06, `landed ${miss.toFixed(2)} m from the aimed spot on the moving deck`);
      return { miss: +miss.toFixed(3), landing: target!.toArray().map((v) => +v.toFixed(2)) };
    },
  ],
  [
    'flare-gun-reload-cycle',
    async (d) => {
      const gun = d.app.flares.guns[0];
      const fwd = await standAtLocker(d, gun);
      const at = await takePistol(d, gun, fwd);
      await pressA(d);
      expect(gun.open, 'A did not break it open');
      await loadCartridge(d, gun, 'parachute-white');
      // Snap it shut with a flick of the wrist (muzzle up, fast).
      const t0 = performance.now();
      for (;;) {
        const k = Math.min(1, (performance.now() - t0) / 70);
        d.setAimWorld('right', at, d.lookQuat(at, at.clone().add(fwd).add(new Vector3(0, 0.15 + k * 2.5, 0))));
        await d.frames(1);
        if (k >= 1) break;
      }
      await d.frames(4);
      expect(!gun.open, 'the flick did not close it');
      // One shot, straight up.
      d.setAimWorld('right', at, d.lookQuat(at, at.clone().addScaledVector(fwd, 0.3).add(new Vector3(0, 1, 0))));
      await d.frames(3);
      const fires = d.count('flare-fire');
      await pullTrigger(d);
      expect(d.count('flare-fire') === fires + 1, 'it did not fire');
      expect(d.app.flares.flights.active >= 1, 'nothing in the air');
      const dry = d.count('flare-dry');
      await pullTrigger(d);
      expect(d.count('flare-dry') === dry + 1 && d.count('flare-fire') === fires + 1, 'a second shot without reloading');
      // Breaking it open throws out the fired case.
      const ejects = d.count('flare-eject');
      await pressA(d);
      expect(gun.open && d.count('flare-eject') === ejects + 1 && !gun.chamber, 'the fired case was not ejected');
      // Back into its case.
      d.setGripWorld('right', gun.holsterWorld(new Vector3()), new Quaternion());
      await d.frames(3);
      d.press('right', 'squeeze', 0);
      await d.frames(3);
      expect(gun.docked && !gun.prop.object.visible && gun.home.dockedGun.visible, 'the pistol did not go back in its case');
      return { shots: gun.shots };
    },
  ],
  [
    'flare-parachute-lights-the-night',
    async (d) => {
      const app = d.app;
      app.tod.set('night', 0);
      try {
        await d.frames(3);
        const cam = { from: [-1.5, 3.2, 6.5] as [number, number, number], to: [-5.5, 0.2, 3.5] as [number, number, number], fov: 75 };
        const before = measureLuma(app, cam);
        const deploys = d.count('flare-deploy');
        app.flares.launch('parachute-white', new Vector3(0, 1.2, 1.2), new Vector3(0.1, 1, 0.05));
        await d.waitFor(() => d.count('flare-deploy') > deploys, 7, 'the parachute to open');
        await d.seconds(1);
        const flight = () => app.flares.flights.summary().find((f) => f.kind === 'parachute-white')!;
        const y0 = flight().y;
        const spot = app.flares.lights.spot.intensity;
        await d.seconds(1);
        const sink = y0 - flight().y;
        const after = measureLuma(app, cam);
        expect(y0 > 50, `it only got to ${y0} m`);
        expect(spot > 4000, `spotlight at ${spot.toFixed(0)}`);
        expect(sink > 1 && sink < 4, `sinking ${sink.toFixed(2)} m/s under the canopy`);
        expect(after > before * 1.5, `the island only went from ${before.toFixed(3)} to ${after.toFixed(3)} brightness`);
        return { height: y0, sink: +sink.toFixed(2), before: +before.toFixed(3), after: +after.toFixed(3) };
      } finally {
        app.tod.set('sunset', 0);
      }
    },
  ],
  [
    'flare-star-and-smoke',
    async (d) => {
      const app = d.app;
      app.flares.launch('star-red', new Vector3(0, 1.2, 1.2), new Vector3(0, 1, -0.6));
      await d.seconds(0.5);
      const point = Math.max(...app.flares.lights.points.map((p) => p.intensity));
      expect(point > 2000, `the star lights nothing (${point.toFixed(0)})`);
      const deploys = d.count('flare-deploy');
      app.flares.launch('smoke-violet', new Vector3(0, 1.2, 1.2), new Vector3(0.2, 1, 0));
      await d.waitFor(() => d.count('flare-deploy') > deploys, 6, 'the smoke charge to burst');
      await d.seconds(1.5);
      const smoke = app.flares.smoke.count;
      expect(smoke > 150, `only ${smoke} smoke puffs`);
      return { starLight: Math.round(point), smoke };
    },
  ],
  [
    'flare-gun-on-the-boat',
    async (d) => {
      const app = d.app;
      const boat = app.boat;
      const gun = app.flares.guns[1];
      launchBoat(d);
      boat.throttleAngle = THROTTLE_MAX * 0.5;
      await boardBoat(d);
      await d.seconds(1);
      expect(boat.speed > 1, 'the boat is not moving');
      // The deck locker works under way: take the pistol and a star, load, fire ahead.
      const fwd = await standAtLocker(d, gun);
      expect(boat.aboard, 'stepped off the boat');
      await takePistol(d, gun, fwd);
      await pressA(d);
      expect(gun.open, 'A did not break it open');
      await loadCartridge(d, gun, 'star-gold');
      await pressA(d);
      expect(!gun.open, 'A did not close it');
      const fires = d.count('flare-fire');
      await pullTrigger(d);
      expect(d.count('flare-fire') === fires + 1, 'it did not fire');
      const shot = d.last('flare-fire') as { id: string };
      expect(shot.id === 'boat-flare-gun', `fired ${shot.id}`);
      d.setGripWorld('right', gun.holsterWorld(new Vector3()), new Quaternion());
      await d.frames(3);
      d.press('right', 'squeeze', 0);
      await d.frames(3);
      boat.throttleAngle = 0;
      expect(gun.docked, 'the pistol did not go back in the deck locker');
      return { boatSpeed: +boat.speed.toFixed(2) };
    },
  ],
  [
    'glider-launch-from-plank',
    async (d) => {
      const app = d.app;
      const g = app.glider;
      await takeGlider(d, 0);
      // To the root of the plank, facing out along it; then walk off its end with the stick.
      const tip = app.scenery.plankTip;
      app.locomotion.turn(0 - app.input.headYaw());
      const head = d.head();
      app.rig.position.x += tip.x - head.x;
      app.rig.position.z += tip.z + 2.8 - head.z;
      app.rig.position.y = tip.y;
      app.updateRig();
      setToggles(d, 0.2, 0.2);
      await d.frames(3);
      expect(g.state === 'ground', `on the plank the glider is ${g.state}`);
      d.emu.stick('left', 0, -1);
      await d.waitFor(() => g.state === 'flying', 6, 'walking off the end of the plank');
      d.emu.stick('left', 0, 0);
      const launchZ = d.head().z;
      expect(launchZ < tip.z, `launched at z ${launchZ.toFixed(2)}, before the plank's end (${tip.z.toFixed(2)})`);
      await d.seconds(2.5);
      expect(g.airspeed > TRIM - 0.4, `airspeed only ${g.airspeed.toFixed(2)}`);
      // Trim sink, less whatever lift is about (the satellite's thermal reaches the plank).
      expect(Math.abs(g.vy - (g.lift - SINK)) < 0.35, `vertical speed ${g.vy.toFixed(2)} m/s with ${g.lift.toFixed(2)} m/s of lift`);
      // Flying: no teleport arc, and the stick doesn't walk you.
      const before = d.head();
      d.emu.stick('right', 0, -1);
      await d.frames(10);
      expect(!app.locomotion.teleportAiming, 'a teleport arc came up in flight');
      d.emu.stick('right', 0, 0);
      const flew = d.head().distanceTo(before);
      return { launchZ: +launchZ.toFixed(2), airspeed: +g.airspeed.toFixed(2), vy: +g.vy.toFixed(2), lift: +g.lift.toFixed(2), flew: +flew.toFixed(1) };
    },
  ],
  [
    'glider-steers-and-brakes',
    async (d) => {
      const g = d.app.glider;
      await takeGlider(d, 0);
      await flyFrom(d, new Vector3(0, 30, -45), 0);
      await d.seconds(1.5);
      let h0 = g.heading;
      setToggles(d, 0.85, 0.2);
      await d.seconds(1.5);
      const left = (g.heading - h0) * DEG2;
      expect(left > 40, `the left toggle turned ${left.toFixed(0)}° (want > 40° left)`);
      setToggles(d, 0.2, 0.85);
      await d.seconds(0.6);
      h0 = g.heading;
      await d.seconds(1.5);
      const right = (h0 - g.heading) * DEG2;
      expect(right > 40, `the right toggle turned ${right.toFixed(0)}° (want > 40° right)`);
      setToggles(d, 0.8, 0.8);
      await d.seconds(2);
      const slow = g.airspeed;
      expect(slow < SLOW + 0.3, `both toggles down: still ${slow.toFixed(2)} m/s`);
      setToggles(d, 0.2, 0.2);
      await d.seconds(2);
      expect(g.airspeed > TRIM - 0.3, `hands up: only ${g.airspeed.toFixed(2)} m/s`);
      return { leftDeg: Math.round(left), rightDeg: Math.round(right), slow: +slow.toFixed(2), trim: +g.airspeed.toFixed(2) };
    },
  ],
  [
    'glider-thermal-climbs',
    async (d) => {
      const g = d.app.glider;
      const t = THERMALS[0];
      await takeGlider(d, 0);
      await flyFrom(d, new Vector3(t.x + 5, 8, t.z), 0);
      // Circle tight to the left, around the core.
      setToggles(d, 0.85, 0.2);
      const y0 = d.head().y;
      await d.seconds(8);
      const climb = d.head().y - y0;
      expect(climb > 3, `circled 8 s in the ${t.name} thermal and climbed ${climb.toFixed(1)} m`);
      return { thermal: t.name, climb: +climb.toFixed(1), lift: +g.lift.toFixed(2) };
    },
  ],
  [
    'glider-ridge-lift',
    async (d) => {
      const g = d.app.glider;
      const main = g.air.ridges.find((r) => r.name === 'main-island')!;
      const wind = new Vector3(WIND.x, 0, WIND.z).normalize();
      // Just off the main island's windward rim, a little above its top, flying along the rim.
      const at = new Vector3(main.x, main.top + 2.5, main.z).addScaledVector(wind, -main.radius * 1.15);
      const best = g.air.sample(at).ridge;
      expect(best > SINK + 0.5, `ridge lift at the windward rim is only ${best.toFixed(2)} m/s`);
      const lee = g.air.sample(new Vector3(main.x, main.top + 2.5, main.z).addScaledVector(wind, main.radius * 1.15)).ridge;
      expect(lee === 0, `ridge lift on the lee side: ${lee.toFixed(2)} m/s`);
      await takeGlider(d, 0);
      await flyFrom(d, at, Math.atan2(-wind.z, wind.x));
      const y0 = d.head().y;
      await d.seconds(2);
      const climb = d.head().y - y0;
      expect(climb > 0.3, `along the ridge for 2 s: ${climb.toFixed(2)} m`);
      return { ridgeLift: +best.toFixed(2), climb: +climb.toFixed(2) };
    },
  ],
  [
    'glider-lands-and-packs',
    async (d) => {
      const app = d.app;
      const g = app.glider;
      const lands = d.count('glider-land');
      await takeGlider(d, 0);
      // Low over the south rim, heading north into the breeze: the lee side, where there's no
      // ridge lift (the windward rim would carry you right over the island).
      await flyFrom(d, new Vector3(0, 2.3, 13), 0);
      await d.waitFor(() => g.state !== 'flying', 8, 'touchdown');
      expect(g.state === 'landing', `after touchdown the glider is ${g.state}`);
      expect(d.count('glider-land') === lands + 1, 'no glider-land event');
      const at = d.head();
      expect(app.scenery.heightAt(at.x, at.z) !== null, 'touched down off the island');
      await d.waitFor(() => g.state === 'ground', 4, 'the run-out to end');
      // Let go of both toggles: it packs itself back onto its rack.
      d.press('left', 'squeeze', 0);
      d.press('right', 'squeeze', 0);
      await d.waitFor(() => g.state === 'idle', 3, 'the wing to pack away');
      const rack = g.racks[0];
      expect(rack.pack.visible && !rack.wing.visible, 'the wing is not back on its rack');
      const stow = d.last('glider-stow') as { reason: string };
      expect(stow.reason === 'let go', `packed away because of ${stow.reason}`);
      return { landedAt: at.toArray().map((v) => +v.toFixed(1)), flight: d.last('glider-land') };
    },
  ],
  [
    'glider-rescue',
    async (d) => {
      const app = d.app;
      const g = app.glider;
      const rescues = d.count('glider-rescue');
      await takeGlider(d, 1);
      // Far out over the clouds and nearly down to them: the next metres call the rescue.
      await flyFrom(d, new Vector3(40, -33.2, 30), 0);
      await d.waitFor(() => d.count('glider-rescue') > rescues, 6, 'the rescue');
      await d.waitFor(() => g.state === 'idle', 3, 'the blink home');
      await d.frames(3);
      const rack = g.racks[1];
      const head = d.head();
      const off = Math.hypot(head.x - rack.stand.x, head.z - rack.stand.z);
      expect(off < 0.5, `rescued to ${off.toFixed(2)} m from the perch rack`);
      expect(Math.abs(app.rig.position.y - rack.stand.y) < 0.05, 'not standing at the rack');
      expect(rack.pack.visible, 'the perch wing is not back on its rack');
      return { off: +off.toFixed(2) };
    },
  ],
  [
    'portal-walk-through',
    async (d) => {
      const app = d.app;
      const P = app.portals;
      const home = P.home;
      const front = portalFront(home.root.rotation.y);
      const feet = home.root.position.clone().addScaledVector(front, 1.5);
      app.rig.position.copy(feet).setY(home.root.position.y);
      app.rig.rotation.y = 0;
      app.updateRig();
      d.setHeadWorld(feet.clone().setY(feet.y + 1.6), Math.atan2(front.x, front.z) * DEG2);
      await d.frames(3);
      P.resetTracking();
      await d.frames(2);
      // Walk 3 m straight ahead in the room: through the opening.
      const dev = d.emu.device;
      const start = new Vector3(dev.position.x, dev.position.y, dev.position.z);
      const transits = P.transits;
      for (let i = 1; i <= 30; i++) {
        const p = start.clone().addScaledVector(front, -0.1 * i);
        dev.position.set(p.x, p.y, p.z);
        await d.frames(1);
      }
      await d.frames(2);
      expect(P.transits === transits + 1, `went through ${P.transits - transits} times`);
      const perch = P.perch;
      const head = d.head();
      const out = perch.side(head);
      expect(out > 1.2 && out < 1.8, `came out ${out.toFixed(2)} m in front of the perch portal`);
      const yaw = app.input.headYaw();
      const look = new Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
      const along = look.dot(portalFront(perch.root.rotation.y));
      expect(along > 0.99, `facing ${along.toFixed(2)} along the perch portal's front`);
      const ev = d.last('portal-transit') as { what: string; to: string };
      expect(ev.what === 'player' && ev.to === 'portal-perch', 'no transit event');
      return { out: +out.toFixed(2), facing: +along.toFixed(3) };
    },
  ],
  [
    'portal-stick-walk-through',
    async (d) => {
      const app = d.app;
      const P = app.portals;
      const home = P.home;
      const front = portalFront(home.root.rotation.y);
      const feet = home.root.position.clone().addScaledVector(front, 1.5);
      app.rig.position.copy(feet).setY(home.root.position.y);
      app.rig.rotation.y = 0;
      app.updateRig();
      d.setHeadWorld(feet.clone().setY(feet.y + 1.6), Math.atan2(front.x, front.z) * DEG2);
      await d.frames(3);
      P.resetTracking();
      await d.frames(2);
      // Walk at it with the stick: over the hoop's bottom, through the opening.
      const transits = P.transits;
      d.emu.stick('left', 0, -1);
      await d.waitFor(() => P.transits > transits, 3, 'walking through with the stick');
      await d.seconds(0.3);
      d.emu.stick('left', 0, 0);
      await d.frames(2);
      const perch = P.perch;
      const out = perch.side(d.head());
      expect(out > 0.1 && out < 2, `came out ${out.toFixed(2)} m in front of the perch portal`);
      const yaw = app.input.headYaw();
      const along = new Vector3(-Math.sin(yaw), 0, -Math.cos(yaw)).dot(portalFront(perch.root.rotation.y));
      expect(along > 0.99, `facing ${along.toFixed(2)} along the perch portal's front`);
      return { out: +out.toFixed(2) };
    },
  ],
  [
    'portal-teleport-through',
    async (d) => {
      const app = d.app;
      const P = app.portals;
      const home = P.home;
      const perch = P.perch;
      const front = portalFront(home.root.rotation.y);
      const feet = home.root.position.clone().addScaledVector(front, 3.5);
      app.rig.position.copy(feet).setY(home.root.position.y);
      app.rig.rotation.y = 0;
      app.updateRig();
      d.setHeadWorld(feet.clone().setY(feet.y + 1.6), Math.atan2(front.x, front.z) * DEG2);
      await d.frames(3);
      // Aim the arc into the opening: it carries on out of the perch portal and lands there.
      const centre = new Vector3().setFromMatrixPosition(home.world);
      const hand = d.head().addScaledVector(front, -0.3).add(new Vector3(0.15, -0.35, 0));
      d.setAimWorld('right', hand, d.lookQuat(hand, centre.clone().add(new Vector3(0, 0.3, 0))));
      await d.frames(3);
      d.emu.stick('right', 0, -1);
      await d.frames(10);
      const t = app.locomotion.target;
      expect(t.valid, 'the arc through the portal has no valid landing');
      const landing = t.point.clone();
      expect(landing.distanceTo(perch.root.position) < 12, `the arc landed ${landing.distanceTo(perch.root.position).toFixed(1)} m from the perch portal`);
      const yaw0 = app.rig.rotation.y;
      d.emu.stick('right', 0, 0);
      await d.frames(30);
      const head = d.head();
      expect(Math.hypot(head.x - landing.x, head.z - landing.z) < 0.05, 'head not over the landing point');
      const turn = perch.root.rotation.y + Math.PI - home.root.rotation.y;
      expect(Math.abs(app.rig.rotation.y - yaw0 - turn) < 1e-3, 'not turned the way the arc came out');
      const yaw = app.input.headYaw();
      const along = new Vector3(-Math.sin(yaw), 0, -Math.cos(yaw)).dot(portalFront(perch.root.rotation.y));
      expect(along > 0.99, `facing ${along.toFixed(2)} along the perch portal's front`);
      return { landing: landing.toArray().map((v) => +v.toFixed(2)) };
    },
  ],
  [
    'portal-view-renders',
    async (d) => {
      const app = d.app;
      const home = app.portals.home;
      const front = portalFront(home.root.rotation.y);
      const eye = home.root.position.clone().addScaledVector(front, 3).setY(home.root.position.y + 1.6);
      d.setHeadWorld(eye, Math.atan2(front.x, front.z) * DEG2);
      await d.frames(3);
      const r0 = home.renders;
      await d.frames(10);
      const facing = home.renders - r0;
      expect(facing >= 20, `${facing} views rendered in 10 frames looking at it (want both eyes, every frame)`);
      expect(home.fresh[0] && home.fresh[1], 'the eyes have no fresh view');
      // Turned away, it costs nothing.
      d.setHeadWorld(eye, Math.atan2(front.x, front.z) * DEG2 + 180);
      await d.frames(3);
      const r1 = home.renders;
      await d.frames(10);
      expect(home.renders === r1, `${home.renders - r1} views rendered looking away`);
      return { perFrame: facing / 10 };
    },
  ],
  [
    'portal-ball-through',
    async (d) => {
      const app = d.app;
      const P = app.portals;
      const home = P.home;
      const ball = app.physics.props.find((p) => p.id === 'ball-0')!;
      const front = portalFront(home.root.rotation.y);
      const centre = new Vector3().setFromMatrixPosition(home.world);
      app.physics.place(ball, centre.clone().addScaledVector(front, 1.2), new Quaternion());
      ball.body.setLinvel(front.clone().multiplyScalar(-4).setY(1), true);
      const transits = d.count('portal-transit');
      await d.waitFor(() => d.count('portal-transit') > transits, 3, 'the ball to go through');
      const ev = d.last('portal-transit') as { what: string; to: string };
      expect(ev.what === 'ball-0' && ev.to === 'portal-perch', `transit of ${ev.what} to ${ev.to}`);
      await d.frames(2);
      const perch = P.perch;
      const at = ball.currPos.clone();
      const out = perch.side(at);
      const v = ball.body.linvel();
      const away = new Vector3(v.x, 0, v.z).dot(portalFront(perch.root.rotation.y));
      expect(at.distanceTo(new Vector3().setFromMatrixPosition(perch.world)) < 3, 'the ball is not at the perch portal');
      expect(out > 0 && away > 2, `the ball isn't coming out of the perch portal (side ${out.toFixed(2)}, speed out ${away.toFixed(2)})`);
      return { out: +out.toFixed(2), speedOut: +away.toFixed(2) };
    },
  ],
  [
    'portal-arrow-through',
    async (d) => {
      const app = d.app;
      const P = app.portals;
      const home = P.home;
      const front = portalFront(home.root.rotation.y);
      const centre = new Vector3().setFromMatrixPosition(home.world);
      const transits = d.count('portal-transit');
      shootDirect(d, centre.clone().addScaledVector(front, 4).setY(centre.y + 0.1), centre.clone().addScaledVector(front, -4), 45);
      await d.waitFor(() => d.count('portal-transit') > transits, 2, 'the arrow to go through');
      const ev = d.last('portal-transit') as { what: string };
      expect(ev.what === 'arrow', `transit of ${ev.what}`);
      await d.frames(3);
      const arrow = app.arrows.arrows.find((a) => a.state === 'flying' || a.state === 'stuck');
      expect(!!arrow, 'the arrow is gone');
      const out = P.perch.side(arrow!.pos);
      expect(out > 0.5, `the arrow is ${out.toFixed(2)} m from the perch portal's front`);
      expect(Math.hypot(arrow!.pos.x - P.perch.root.position.x, arrow!.pos.z - P.perch.root.position.z) < 40, 'the arrow is not at the perch');
      return { out: +out.toFixed(1), state: arrow!.state, rx: RX };
    },
  ],
  [
    'wrist-menu',
    async (d) => {
      const hp = d.head();
      const palmPos = hp.clone().add(new Vector3(-0.05, -0.3, -0.32));
      const toHead = hp.clone().sub(palmPos).normalize();
      // The left palm is +X in grip space: turn it toward the eyes.
      d.setGripWorld('left', palmPos, new Quaternion().setFromUnitVectors(new Vector3(1, 0, 0), toHead));
      await d.frames(25);
      expect(d.app.wristMenu.visible, 'menu did not open');
      const m = d.app.wristMenu.mesh;
      m.updateMatrixWorld(true);
      const W = 0.2;
      const H = (0.2 * 520) / 640;
      const at = (cx: number, cy: number) => m.localToWorld(new Vector3((cx / 640 - 0.5) * W, (0.5 - cy / 520) * H, 0));
      // Point at the Info tab and pull the trigger.
      const target = at(540, 46);
      const from = target.clone().add(new Vector3(0.15, 0.05, 0.25));
      d.setAimWorld('right', from, d.lookQuat(from, target));
      await d.frames(4);
      d.press('right', 'trigger', 1);
      await d.frames(3);
      d.press('right', 'trigger', 0);
      await d.frames(3);
      expect(d.app.wristMenu.page === 'info', `ray click failed, page ${d.app.wristMenu.page}`);
      // Back to Settings by poking with the index finger.
      const back = at(395, 46);
      d.setGripWorld('right', back.clone().add(new Vector3(0, 0.25, 0.2)), new Quaternion());
      const tipOff = await d.fingertipOffset('right');
      const normal = new Vector3(0, 0, 1).applyQuaternion(m.getWorldQuaternion(new Quaternion()));
      const start = back.clone().addScaledVector(normal, 0.03).sub(tipOff);
      await d.sweepGrip('right', start, start.clone().addScaledVector(normal, -0.035), 0.2, new Quaternion());
      await d.frames(3);
      expect(d.app.wristMenu.page === 'settings', `poke failed, page ${d.app.wristMenu.page}`);
      return { opened: d.count('menu') };
    },
  ],
  [
    'giant-mode',
    async (d) => {
      const target = d.app.console.buttonWorld('giant', new Vector3());
      const from = target.clone().add(new Vector3(0, 0.35, 0)).add(new Vector3().subVectors(d.head(), target).setY(0).normalize().multiplyScalar(0.4));
      d.setAimWorld('right', from, d.lookQuat(from, target));
      await d.frames(4);
      const h0 = d.head();
      d.press('right', 'trigger', 1);
      await d.frames(3);
      d.press('right', 'trigger', 0);
      await d.waitFor(() => d.app.rigScale > 7.9, 6, 'growing');
      const h1 = d.head();
      expect(h1.y > 10, `head only at ${h1.y.toFixed(1)} m`);
      expect(Math.hypot(h1.x - h0.x, h1.z - h0.z) < 0.05, 'slid sideways while growing');
      d.app.setGiant(false);
      await d.waitFor(() => d.app.rigScale === 1, 6, 'shrinking');
      return { giantHeadY: +h1.y.toFixed(1) };
    },
  ],
  [
    'no-frame-errors',
    async (d) => {
      expect(d.app.errors.length === 0, d.app.errors.join('\n'));
      return { frames: d.app.frameCount };
    },
  ],
];

export const CHECK_NAMES = CHECKS.map((c) => c[0]);

export async function runSelfTest(app: App, emu: Emu, only: string[] | null = null): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const state = { done: false, passed: 0, failed: 0, results };
  (window as unknown as { __selftest: typeof state }).__selftest = state;
  const d = createDriver(app, emu);
  (window as unknown as { __driver: Driver }).__driver = d;

  await d.waitFor(() => app.inXR && app.input.left.connected && app.input.right.connected, 8, 'XR session + controllers');
  setSetting('turn', 'snap45');
  setSetting('leftStick', 'move');
  await d.frames(5);
  d.measureGripOffsets();

  for (const [name, fn] of CHECKS) {
    if (only && !only.includes(name)) continue;
    const t0 = performance.now();
    let r: CheckResult;
    try {
      await d.resetWorld();
      const detail = await fn(d);
      r = { name, ok: true, ms: Math.round(performance.now() - t0), detail };
      state.passed++;
    } catch (err) {
      r = { name, ok: false, ms: Math.round(performance.now() - t0), error: (err as Error).message };
      state.failed++;
    }
    results.push(r);
    console.log(`[selftest] ${JSON.stringify(r)}`);
  }
  await d.resetWorld();
  state.done = true;
  console.log(`[selftest] done: ${state.passed} passed, ${state.failed} failed`);
  return results;
}
