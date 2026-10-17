import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  Group,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshLambertMaterial,
  MeshStandardMaterial,
  Quaternion,
  SphereGeometry,
  TorusGeometry,
  Vector3,
} from 'three';
import { mergeColored } from '../core/merge';
import { RAPIER, type Physics } from '../physics/physics';
import { makeLabel } from '../ui/text';
import { WIND } from '../world/wind';
import { Wing, type WingPalette } from './wing';

/** Where the toggles hang (rack frame, the user stands at +Z): left and right hooks. */
const HOOKS = [new Vector3(-0.24, 1.5, 0.02), new Vector3(0.24, 1.5, 0.02)];
const WOOD = 0x8a5a35;
const DARK = 0x5e3b22;

/**
 * A glider rack: a wooden frame with the wing's two toggles hanging from hooks, the
 * packed wing at its foot, a sign, and a windsock beside it showing the breeze.
 */
export class Rack {
  readonly root = new Group();
  readonly pack: Group;
  readonly wing: Wing;
  /** Where to stand to take the toggles (world, at the ground). */
  readonly stand = new Vector3();
  private readonly sock: Group;
  private readonly droop: LineSegments;
  private readonly hookWorld = [new Vector3(), new Vector3()];

  constructor(
    readonly id: string,
    at: Vector3,
    yaw: number,
    palette: WingPalette,
    physics: Physics,
  ) {
    this.root.name = id;
    this.root.position.copy(at);
    this.root.rotation.y = yaw;

    const posts = [];
    for (const sx of [-1, 1]) {
      posts.push({ geometry: new BoxGeometry(0.07, 1.75, 0.07), matrix: new Matrix4().makeTranslation(sx * 0.45, 0.875, 0), color: WOOD });
      posts.push({ geometry: new BoxGeometry(0.09, 0.05, 0.62), matrix: new Matrix4().makeTranslation(sx * 0.45, 0.025, 0), color: DARK });
    }
    posts.push({ geometry: new BoxGeometry(1.08, 0.07, 0.07), matrix: new Matrix4().makeTranslation(0, 1.7, 0), color: WOOD });
    posts.push({ geometry: new BoxGeometry(0.98, 0.04, 0.24), matrix: new Matrix4().makeTranslation(0, 0.42, -0.02), color: DARK });
    for (const h of HOOKS) {
      posts.push({ geometry: new TorusGeometry(0.028, 0.006, 6, 12, Math.PI * 1.4), matrix: new Matrix4().makeRotationY(Math.PI / 2).setPosition(h.x, 1.64, 0.02), color: 0xd4af37 });
      posts.push({ geometry: new CylinderGeometry(0.005, 0.005, 0.05, 6), matrix: new Matrix4().makeTranslation(h.x, 1.66, 0.02), color: 0xd4af37 });
    }
    const frame = new Mesh(mergeColored(posts), new MeshStandardMaterial({ vertexColors: true, roughness: 0.85 }));
    frame.name = `${id}-frame`;
    frame.castShadow = frame.receiveShadow = true;
    this.root.add(frame);

    // The packed wing: a fat stuff-sack in the wing's colours on the shelf.
    this.pack = new Group();
    const sack = new Mesh(
      mergeColored([
        { geometry: new SphereGeometry(1, 20, 14), matrix: new Matrix4().makeScale(0.36, 0.2, 0.15), color: palette.base },
        { geometry: new TorusGeometry(1, 0.06, 6, 24), matrix: new Matrix4().makeRotationY(Math.PI / 2).scale(new Vector3(0.21, 0.2, 0.16)).setPosition(0.12, 0, 0), color: palette.accent },
        { geometry: new TorusGeometry(1, 0.06, 6, 24), matrix: new Matrix4().makeRotationY(Math.PI / 2).scale(new Vector3(0.21, 0.2, 0.16)).setPosition(-0.12, 0, 0), color: palette.accent },
        { geometry: new SphereGeometry(1, 12, 8), matrix: new Matrix4().makeScale(0.14, 0.09, 0.1).setPosition(0.3, 0.02, 0), color: palette.tip },
      ]),
      new MeshLambertMaterial({ vertexColors: true }),
    );
    sack.castShadow = true;
    this.pack.add(sack);
    this.pack.position.set(0, 0.64, -0.02);
    this.root.add(this.pack);

    const sign = makeLabel(['PARAGLIDER', 'take both toggles · walk off the edge', 'one toggle down: turn that way', 'both down: slow · all the way: sink to land', 'let go on the ground to pack it away'], {
      width: 0.86,
      aspect: 0.42,
      px: 1024,
      background: 'rgba(28,20,14,0.92)',
      font: '600 40px system-ui, sans-serif',
      color: '#ffe9c9',
    });
    sign.position.set(0, 1.95, 0.01);
    this.root.add(sign);

    // Windsock on its own pole, off to one side.
    const pole = new Mesh(new CylinderGeometry(0.025, 0.035, 2.7, 8), new MeshStandardMaterial({ color: 0xd8d4cc, roughness: 0.6 }));
    pole.position.set(0.95, 1.35, -0.1);
    pole.castShadow = true;
    this.root.add(pole);
    this.sock = new Group();
    this.sock.position.set(0.95, 2.62, -0.1);
    const cone = new CylinderGeometry(0.15, 0.06, 0.85, 16, 5, true);
    cone.rotateX(-Math.PI / 2).translate(0, 0, -0.43); // its mouth at the pivot, blowing out along -Z
    const colors = new Float32Array(cone.getAttribute('position').count * 3);
    const p = cone.getAttribute('position');
    const red = new Color(0xe5383b);
    const white = new Color(0xf5f3ee);
    for (let i = 0; i < p.count; i++) {
      const band = Math.min(4, Math.floor((-p.getZ(i) / 0.85) * 5 + 0.001));
      const c = band % 2 ? white : red;
      colors.set([c.r, c.g, c.b], i * 3);
    }
    cone.setAttribute('color', new BufferAttribute(colors, 3));
    const sockMesh = new Mesh(cone, new MeshLambertMaterial({ vertexColors: true, side: DoubleSide }));
    sockMesh.castShadow = true;
    this.sock.add(sockMesh, new Mesh(new TorusGeometry(0.15, 0.008, 6, 20), new MeshStandardMaterial({ color: 0x9aa0a6 })));
    this.root.add(this.sock);

    // The brake lines droop from the hanging toggles down into the sack.
    const dg = new BufferGeometry();
    dg.setAttribute('position', new BufferAttribute(new Float32Array(4 * 6), 3));
    this.droop = new LineSegments(dg, new LineBasicMaterial({ color: palette.lines }));
    this.droop.frustumCulled = false;
    this.root.add(this.droop);
    const dp = dg.getAttribute('position') as BufferAttribute;
    HOOKS.forEach((h, i) => {
      const mid = new Vector3(h.x * 0.8, 1.05, 0.06);
      const sackTop = new Vector3(h.x * 0.4, 0.8, 0);
      const top = h.clone().setY(h.y + 0.09);
      dp.setXYZ(i * 4, top.x, top.y, top.z);
      dp.setXYZ(i * 4 + 1, mid.x, mid.y, mid.z);
      dp.setXYZ(i * 4 + 2, mid.x, mid.y, mid.z);
      dp.setXYZ(i * 4 + 3, sackTop.x, sackTop.y, sackTop.z);
    });

    this.root.updateMatrixWorld(true);
    this.stand.set(0, 0, 0.6).applyMatrix4(this.root.matrixWorld);
    for (let i = 0; i < 2; i++) this.hookWorld[i].copy(HOOKS[i]).applyMatrix4(this.root.matrixWorld);
    // Solid posts (arrows stick in them, balls bounce off).
    const q = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), yaw);
    for (const sx of [-1, 1]) {
      physics.addStatic(RAPIER.ColliderDesc.cuboid(0.035, 0.875, 0.035), { walkable: false, material: 'wood' }, new Vector3(sx * 0.45, 0.875, 0).applyMatrix4(this.root.matrixWorld), q);
    }
    physics.addStatic(RAPIER.ColliderDesc.cuboid(0.54, 0.035, 0.035), { walkable: false, material: 'wood' }, new Vector3(0, 1.7, 0).applyMatrix4(this.root.matrixWorld), q);

    this.wing = new Wing(palette);
    this.wing.visible = false;
  }

  /** The toggle's resting place on its hook (world): 0 left, 1 right. */
  hook(side: 0 | 1): Vector3 {
    return this.hookWorld[side];
  }

  /** The wing is out (flying) or home (packed on the rack). */
  setPacked(packed: boolean): void {
    this.pack.visible = packed;
    this.droop.visible = packed;
  }

  /** The sock streams downwind, lifting and swinging in the gusts. */
  update(time: number): void {
    const local = WIND.clone().applyQuaternion(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), -this.root.rotation.y));
    const gust = 0.5 + 0.5 * Math.sin(time * 0.7) * Math.sin(time * 1.9 + 1);
    this.sock.rotation.set(-0.5 + 0.35 * gust, Math.atan2(-local.x, -local.z) + 0.12 * Math.sin(time * 2.3), 0, 'YXZ');
  }
}
