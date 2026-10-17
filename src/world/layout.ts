import { Vector3, type Object3D } from 'three';
import { SPAWN } from '../config';

/** Where every station sits on the main island. The player spawns facing -Z (the sunset). */
export const LAYOUT = {
  spawn: new Vector3(SPAWN.x, 0, SPAWN.z),
  table: new Vector3(-1.85, 0, -0.95),
  marimba: new Vector3(1.9, 0, -0.95),
  fireworks: new Vector3(3.15, 0, 1.75),
  console: new Vector3(1.75, 0, 3.75),
  brush: new Vector3(-2.95, 0, 1.85),
  cans: new Vector3(-3.7, 0, -4.9),
  sign: new Vector3(-0.95, 0, -0.25),
  pillar: new Vector3(-7.1, 0, 2.4),
  /** Archery deck on the west rim; you shoot toward -X (west), out over the clouds. */
  range: new Vector3(-6.9, 0, -0.5),
  /** Root of the skyboat pier on the east rim. */
  dock: new Vector3(7.2, 0, 0.9),
  /** The signal-flare locker, beside the way out to the pier. */
  flares: new Vector3(5.95, 0, 2.6),
  /** The home portal, south-west of spawn, facing it. */
  portal: new Vector3(-3.4, 0, 5.0),
  /** The glider rack at the root of the plank. */
  glider: new Vector3(0.95, 0, -7.25),
};

/**
 * The perch: a high far island (far-7 in scenery.ts), 100 m out and 22 m up. The
 * twin portal stands just behind its centre, facing the main island, and a glider
 * rack waits at its rim: step through, and glide home.
 */
export const PERCH = new Vector3(-30, 22, -95);
const towardMain = new Vector3(-PERCH.x, 0, -PERCH.z).normalize();
/** Facing (rotation about +Y) that points a +Z front at the main island. */
export const PERCH_FACING = Math.atan2(towardMain.x, towardMain.z);
export const PERCH_PORTAL = PERCH.clone().addScaledVector(towardMain, -1.4);
/** The perch's glider rack: toward the rim, a step to the side of the way from the portal. */
export const PERCH_RACK = PERCH.clone().addScaledVector(towardMain, 3.4).addScaledVector(new Vector3(towardMain.z, 0, -towardMain.x), 1.4);

/** True near the perch's portal or rack: keep trees off them. */
export function nearPerchFeature(x: number, z: number): boolean {
  return Math.hypot(x - PERCH_PORTAL.x, z - PERCH_PORTAL.z) < 3.8 || Math.hypot(x - PERCH_RACK.x, z - PERCH_RACK.z) < 3.4;
}

/**
 * The pier runs east off the rim; the skyboat moors across its end, bow to the
 * south (open sky), with its starboard gate against the pier.
 */
export const DOCK = {
  pier: { x0: 6.7, x1: 11.4, z: 0.9, width: 1.5 },
  /** Pier planks and the moored boat's deck are level. */
  top: 0.12,
  boat: new Vector3(12.8, 0.12, 1.8),
  heading: Math.PI,
};

/** True on the pier's approach: keep it clear of trees and rocks. */
export function inDockLane(x: number, z: number): boolean {
  return x > 5.2 && Math.abs(z - DOCK.pier.z) < 1.9;
}

/** Eye position of someone standing on the archery deck's shooting line. */
export const SHOOTER = new Vector3(-6.5, 1.75, -0.5);

/** True inside the archery lane (west of the deck): keep it clear of trees, rocks and clouds. */
export function inRangeLane(x: number, y: number, z: number): boolean {
  if (x > -4.8) return false;
  const halfAngle = Math.atan2(Math.abs(z - SHOOTER.z), SHOOTER.x - x);
  return (halfAngle < 0.62 || Math.abs(z - SHOOTER.z) < 3.8) && y > -16;
}

/** Rotate `obj` about Y so its local +Z faces `target` (the player stands on the +Z side). */
export function faceToward(obj: Object3D, target: Vector3 = LAYOUT.spawn): void {
  obj.rotation.y = Math.atan2(target.x - obj.position.x, target.z - obj.position.z);
}

/** True if (x, z) is too close to a station to put scenery there. */
export function nearStation(x: number, z: number, margin = 1.7): boolean {
  for (const p of Object.values(LAYOUT)) {
    if (Math.hypot(p.x - x, p.z - z) < margin) return true;
  }
  return false;
}
