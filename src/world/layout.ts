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
};

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
