import { type BufferGeometry, BoxGeometry, CircleGeometry, CylinderGeometry, Group, Matrix4, Mesh, MeshStandardMaterial, TorusGeometry, Vector3 } from 'three';
import { mergeColored } from '../core/merge';
import { DEG } from '../core/math';
import { SHELL, shellGeometry } from './kinds';

/**
 * The flare pistol, in its own frame: origin at the centre of the handle (where
 * the palm is), barrel along -Z, +Y up. It's a break-action: the barrel pivots
 * on a hinge at the front of the frame, muzzle down, to expose the chamber.
 */
export const GUN = {
  boreY: 0.075,
  barrelR: 0.0185,
  breechZ: -0.005,
  muzzleZ: -0.185,
  hinge: new Vector3(0, 0.05, -0.092),
  openAngle: 40 * DEG,
  rake: 35 * DEG, // handle slant, matched to how a controller sits in the fist
};

export interface GunModel {
  root: Group;
  /** Pivots at GUN.hinge: rotation.x < 0 opens it (muzzle down, breech up). */
  barrel: Group;
  trigger: Group;
  /** The cartridge in the chamber, seen when the gun is open. */
  chamberShell: Mesh;
  /** In the barrel group's frame. */
  muzzleLocal: Vector3;
  mouthLocal: Vector3;
}

const ORANGE = 0xff6a2a;
const DARK = 0x2a2c33;
const BRASS = 0xd4af37;

const material = new MeshStandardMaterial({ vertexColors: true, roughness: 0.42, metalness: 0.12 });
const shellMaterial = new MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.2 });

export function buildGunModel(): GunModel {
  const root = new Group();
  root.name = 'flare-gun';
  const T = (x: number, y: number, z: number) => new Matrix4().makeTranslation(x, y, z);
  const handleRot = new Matrix4().makeRotationX(-GUN.rake);
  const along = (d: number) => new Vector3(0, Math.cos(GUN.rake), -Math.sin(GUN.rake)).multiplyScalar(d);
  const onHandle = (d: number) => {
    const p = along(d);
    return T(p.x, p.y, p.z).multiply(handleRot);
  };
  const frame: { geometry: BufferGeometry; matrix: Matrix4; color: number }[] = [
    // Standing breech behind the barrel, with a brass face the barrel closes against.
    { geometry: new BoxGeometry(0.036, 0.056, 0.03), matrix: T(0, 0.074, 0.01), color: ORANGE },
    { geometry: new BoxGeometry(0.03, 0.044, 0.002), matrix: T(0, GUN.boreY, -0.0045), color: BRASS },
    // Action bar under the barrel, ending in the hinge knuckle.
    { geometry: new BoxGeometry(0.03, 0.013, 0.09), matrix: T(0, 0.0515, -0.05), color: ORANGE },
    { geometry: new CylinderGeometry(0.009, 0.009, 0.036, 14), matrix: T(GUN.hinge.x, GUN.hinge.y, GUN.hinge.z).multiply(new Matrix4().makeRotationZ(Math.PI / 2)), color: BRASS },
    // Hammer and top latch.
    { geometry: new BoxGeometry(0.012, 0.024, 0.012), matrix: T(0, 0.106, 0.021).multiply(new Matrix4().makeRotationX(0.45)), color: DARK },
    { geometry: new BoxGeometry(0.012, 0.006, 0.026), matrix: T(0, 0.104, -0.001), color: DARK },
    // Handle: an oval grip raked back, dark panels on the sides, a butt cap.
    { geometry: new CylinderGeometry(0.019, 0.0175, 0.11, 16).scale(0.78, 1, 1.12), matrix: onHandle(0), color: ORANGE },
    { geometry: new CylinderGeometry(0.019, 0.0175, 0.075, 16).scale(0.86, 1, 0.98), matrix: onHandle(-0.008), color: DARK },
    { geometry: new CylinderGeometry(0.0158, 0.0158, 0.006, 16).scale(0.8, 1, 1.1), matrix: onHandle(-0.056), color: DARK },
    // Trigger guard: the lower half of a ring, in the gun's mid plane.
    { geometry: new TorusGeometry(0.021, 0.0032, 6, 18, Math.PI).rotateZ(Math.PI).rotateY(Math.PI / 2), matrix: T(0, 0.046, -0.069), color: ORANGE },
  ];
  const frameMesh = new Mesh(mergeColored(frame), material);
  frameMesh.castShadow = true;
  root.add(frameMesh);

  // Trigger blade on its own pivot.
  const trigger = new Group();
  trigger.position.set(0, 0.046, -0.06);
  const blade = new Mesh(mergeColored([{ geometry: new BoxGeometry(0.006, 0.02, 0.006), matrix: T(0, -0.01, 0).multiply(new Matrix4().makeRotationX(-0.25)), color: DARK }]), material);
  trigger.add(blade);
  root.add(trigger);

  // Barrel: parts placed in gun coordinates, offset into the hinge's frame.
  const barrel = new Group();
  barrel.position.copy(GUN.hinge);
  const h = GUN.hinge;
  const B = (x: number, y: number, z: number) => T(x - h.x, y - h.y, z - h.z);
  const len = GUN.breechZ - GUN.muzzleZ;
  const midZ = (GUN.breechZ + GUN.muzzleZ) / 2;
  const alongZ = new Matrix4().makeRotationX(Math.PI / 2);
  const barrelMesh = new Mesh(
    mergeColored([
      { geometry: new CylinderGeometry(GUN.barrelR, GUN.barrelR, len, 22), matrix: B(0, GUN.boreY, midZ).multiply(alongZ), color: DARK },
      { geometry: new CylinderGeometry(GUN.barrelR + 0.0012, GUN.barrelR + 0.0012, 0.012, 22), matrix: B(0, GUN.boreY, GUN.muzzleZ + 0.008).multiply(alongZ), color: ORANGE },
      { geometry: new CylinderGeometry(GUN.barrelR + 0.0012, GUN.barrelR + 0.0012, 0.008, 22), matrix: B(0, GUN.boreY, GUN.breechZ - 0.006).multiply(alongZ), color: BRASS },
      // The dark bore at both ends.
      { geometry: new CircleGeometry(SHELL.rim * 0.95, 20), matrix: B(0, GUN.boreY, GUN.muzzleZ - 0.0002).multiply(new Matrix4().makeRotationY(Math.PI)), color: 0x0a0a0c },
      { geometry: new CircleGeometry(SHELL.rim * 0.95, 20), matrix: B(0, GUN.boreY, GUN.breechZ + 0.0002), color: 0x0a0a0c },
      // Forend lug under the barrel, ahead of the hinge.
      { geometry: new BoxGeometry(0.022, 0.016, 0.05), matrix: B(0, 0.052, -0.125), color: ORANGE },
    ]),
    material,
  );
  barrelMesh.castShadow = true;
  barrel.add(barrelMesh);
  // A cartridge sits rim-first at the breech, pointing down the barrel.
  const chamberShell = new Mesh(shellGeometry(null), shellMaterial);
  chamberShell.rotation.x = -Math.PI / 2;
  chamberShell.position.set(0 - h.x, GUN.boreY - h.y, GUN.breechZ + 0.0015 - h.z);
  chamberShell.visible = false;
  barrel.add(chamberShell);
  root.add(barrel);

  return {
    root,
    barrel,
    trigger,
    chamberShell,
    muzzleLocal: new Vector3(0 - h.x, GUN.boreY - h.y, GUN.muzzleZ - 0.01 - h.z),
    mouthLocal: new Vector3(0 - h.x, GUN.boreY - h.y, GUN.breechZ - h.z),
  };
}

export { shellMaterial };
