import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  DynamicDrawUsage,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  MeshStandardMaterial,
  Quaternion,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
} from 'three';
import { bus } from '../core/events';
import { DEG } from '../core/math';
import type { HandInput } from '../input/xr-input';
import { RAPIER, type Prop } from '../physics/physics';
import { faceToward, LAYOUT } from '../world/layout';
import { sparkle } from '../audio/sfx';
import { makeLabel } from '../ui/text';
import { mergeColored, mergeStatic } from '../core/merge';
import type { App } from '../app';

const MAX_POINTS = 1600;
const MAX_TOTAL_POINTS = 60000;
const TIP = new Vector3(0, 0, -0.135);

const strokeVertex = /* glsl */ `
attribute vec3 color;
attribute float along;
attribute float side;
varying vec3 vColor;
varying float vAlong;
varying float vSide;
void main() {
  vColor = color;
  vAlong = along;
  vSide = side;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const strokeFragment = /* glsl */ `
uniform float uTime;
varying vec3 vColor;
varying float vAlong;
varying float vSide;
void main() {
  float pulse = 0.82 + 0.18 * sin(vAlong * 16.0 - uTime * 4.0);
  float core = 1.0 - abs(vSide);
  vec3 col = vColor * (0.55 + 0.75 * core) * pulse + vec3(0.25) * pow(core, 4.0);
  gl_FragColor = vec4(col * 1.35, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

class Stroke {
  readonly mesh: Mesh;
  private readonly pos: Float32Array;
  private readonly col: Float32Array;
  private readonly along: Float32Array;
  count = 0;
  length = 0;
  readonly last = new Vector3();
  readonly lastSide = new Vector3();

  constructor(material: ShaderMaterial) {
    const g = new BufferGeometry();
    this.pos = new Float32Array(MAX_POINTS * 2 * 3);
    this.col = new Float32Array(MAX_POINTS * 2 * 3);
    this.along = new Float32Array(MAX_POINTS * 2);
    const side = new Float32Array(MAX_POINTS * 2);
    for (let i = 0; i < MAX_POINTS; i++) {
      side[i * 2] = -1;
      side[i * 2 + 1] = 1;
    }
    const idx = new Uint16Array((MAX_POINTS - 1) * 6);
    for (let i = 0; i < MAX_POINTS - 1; i++) {
      const a = i * 2;
      idx.set([a, a + 1, a + 2, a + 1, a + 3, a + 2], i * 6);
    }
    g.setAttribute('position', new BufferAttribute(this.pos, 3).setUsage(DynamicDrawUsage));
    g.setAttribute('color', new BufferAttribute(this.col, 3).setUsage(DynamicDrawUsage));
    g.setAttribute('along', new BufferAttribute(this.along, 1).setUsage(DynamicDrawUsage));
    g.setAttribute('side', new BufferAttribute(side, 1));
    g.setIndex(new BufferAttribute(idx, 1));
    g.setDrawRange(0, 0);
    this.mesh = new Mesh(g, material);
    this.mesh.frustumCulled = false;
    this.mesh.name = 'stroke';
  }

  add(p: Vector3, sideDir: Vector3, width: number, color: Color): boolean {
    if (this.count >= MAX_POINTS) return false;
    if (this.count > 0) this.length += p.distanceTo(this.last);
    const i = this.count;
    const h = width / 2;
    this.pos.set([p.x - sideDir.x * h, p.y - sideDir.y * h, p.z - sideDir.z * h, p.x + sideDir.x * h, p.y + sideDir.y * h, p.z + sideDir.z * h], i * 6);
    this.col.set([color.r, color.g, color.b, color.r, color.g, color.b], i * 6);
    this.along[i * 2] = this.along[i * 2 + 1] = this.length;
    this.count++;
    this.last.copy(p);
    this.lastSide.copy(sideDir);
    const g = this.mesh.geometry;
    g.setDrawRange(0, Math.max(0, (this.count - 1) * 6));
    for (const name of ['position', 'color', 'along']) {
      const a = g.getAttribute(name) as BufferAttribute;
      a.clearUpdateRanges();
      a.addUpdateRange(i * 2 * a.itemSize, 2 * a.itemSize);
      a.needsUpdate = true;
    }
    return true;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
  }
}

export interface Pot {
  pos: Vector3; // top centre, world
  color: Color | 'rainbow';
  paint: Mesh;
}

/** Light painting: Tilt Brush in miniature. */
export class Brushes {
  readonly strokes: Stroke[] = [];
  readonly brushes: Prop[] = [];
  private readonly material: ShaderMaterial;
  private readonly root = new Group();
  readonly pots: Pot[] = [];
  private readonly colorOf = new Map<Prop, Color | 'rainbow'>();
  private readonly tipMat = new Map<Prop, MeshBasicMaterial>();
  private readonly active = new Map<HandInput, { stroke: Stroke; smooth: Vector3; hapticAt: number }>();
  private totalPoints = 0;
  private readonly tmpColor = new Color();
  readonly uniforms = { uTime: { value: 0 } };

  constructor(private readonly app: App) {
    this.material = new ShaderMaterial({
      vertexShader: strokeVertex,
      fragmentShader: strokeFragment,
      uniforms: this.uniforms,
      side: DoubleSide,
    });
    this.root.name = 'paint';
    app.scene.add(this.root);
    this.buildStand();
  }

  private buildStand(): void {
    const g = new Group();
    g.name = 'brush-stand';
    g.position.copy(LAYOUT.brush);
    faceToward(g);
    this.app.scene.add(g);
    const topY = 0.82;
    const wood = new MeshLambertMaterial({ color: 0x8c6a4f });
    const top = new Mesh(new BoxGeometry(0.95, 0.04, 0.42), wood);
    top.position.y = topY;
    top.castShadow = top.receiveShadow = true;
    g.add(top);
    const pedestal = new Mesh(new CylinderGeometry(0.08, 0.14, topY - 0.02, 8), wood);
    pedestal.position.y = (topY - 0.02) / 2;
    pedestal.castShadow = true;
    g.add(pedestal);
    g.updateMatrixWorld(true);
    this.app.physics.addStatic(
      RAPIER.ColliderDesc.cuboid(0.475, 0.02, 0.21),
      { material: 'wood' },
      top.getWorldPosition(new Vector3()),
      top.getWorldQuaternion(new Quaternion()),
    );

    // Paint pots along the back edge.
    const colors: (number | 'rainbow')[] = [0xff4d6d, 0xffa62b, 0xfff05a, 0x52ff9a, 0x4cc9ff, 0xb388ff, 'rainbow'];
    const potMat = new MeshStandardMaterial({ color: 0x3b3f4a, roughness: 0.4, metalness: 0.4, side: DoubleSide });
    colors.forEach((c, i) => {
      const x = -0.39 + i * 0.13;
      const pot = new Mesh(new CylinderGeometry(0.045, 0.045, 0.07, 16, 1, true), potMat);
      pot.position.set(x, topY + 0.02 + 0.035, -0.11);
      pot.castShadow = true;
      g.add(pot);
      const paintColor = c === 'rainbow' ? new Color(0xffffff) : new Color(c);
      const paint = new Mesh(new CylinderGeometry(0.043, 0.043, 0.05, 16), new MeshBasicMaterial({ color: paintColor, toneMapped: false }));
      paint.position.set(x, topY + 0.02 + 0.035 - 0.012, -0.11); // paint surface 1.2 cm below the rim
      g.add(paint);
      const surface = paint.position.clone().setY(paint.position.y + 0.025);
      this.pots.push({ pos: g.localToWorld(surface), color: c === 'rainbow' ? 'rainbow' : new Color(c), paint });
    });
    const label = makeLabel(['Light brushes', 'dip in a pot · trigger paints · B/Y undo'], {
      width: 0.62,
      aspect: 0.22,
      px: 768,
      background: 'rgba(25,20,35,0.78)',
      font: '600 44px system-ui, sans-serif',
      color: '#ffe9c7',
    });
    label.position.set(0, topY + 0.24, -0.2);
    label.rotation.x = -0.25;
    g.add(label);
    mergeStatic(g);

    // Two brushes resting in front of the pots.
    for (let i = 0; i < 2; i++) {
      const brush = this.makeBrushMesh();
      const pos = g.localToWorld(new Vector3(-0.15 + i * 0.3, topY + 0.04, 0.08));
      const q = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), g.rotation.y + Math.PI / 2);
      const startColor = new Color(i === 0 ? 0x4cc9ff : 0xff4d6d);
      const p = this.app.physics.addProp({
        id: `brush-${i}`,
        object: brush,
        // A box, not a capsule: round handles roll off tables.
        collider: RAPIER.ColliderDesc.cuboid(0.014, 0.014, 0.1).setTranslation(0, 0, -0.03),
        position: pos,
        quaternion: q,
        material: 'wood',
        radius: 0.09,
        density: 300,
        angularDamping: 1.5,
        behavior: {
          gripOffset: new Matrix4().makeRotationX(-30 * DEG),
          pullable: true,
          whileHeld: (hand, dt) => this.whileHeld(p, hand, dt),
          onRelease: (hand) => this.endStroke(hand),
        },
      });
      this.colorOf.set(p, startColor);
      const tip = brush.getObjectByName('tip') as Mesh;
      this.tipMat.set(p, tip.material as MeshBasicMaterial);
      (tip.material as MeshBasicMaterial).color.copy(startColor);
      const handleMat = (brush.getObjectByName('handle') as Mesh).material as MeshStandardMaterial;
      const base = handleMat.emissive.clone();
      p.onHighlight = (level) => handleMat.emissive.copy(base).lerp(new Color(0xffd27a), level * 0.5);
      this.app.scene.add(brush);
      this.brushes.push(p);
    }
  }

  /** Handle, ferrule and nib in one draw call; the glowing tip is separate (its colour changes). */
  private makeBrushMesh(): Group {
    const g = new Group();
    g.name = 'brush';
    const along = (z: number, flip = false) => new Matrix4().makeRotationX(flip ? -Math.PI / 2 : Math.PI / 2).setPosition(0, 0, z);
    const geo = mergeColored([
      { geometry: new CylinderGeometry(0.011, 0.014, 0.17, 10), matrix: along(-0.015), color: 0x2b2d42 },
      { geometry: new CylinderGeometry(0.0125, 0.0125, 0.018, 12), matrix: along(-0.1), color: 0xd4af37 },
      { geometry: new CylinderGeometry(0.002, 0.009, 0.026, 10), matrix: along(-0.12, true), color: 0xeeeeee },
    ]);
    const handle = new Mesh(geo, new MeshStandardMaterial({ vertexColors: true, roughness: 0.4, metalness: 0.3 }));
    handle.name = 'handle';
    handle.castShadow = true;
    const tip = new Mesh(new SphereGeometry(0.0075, 12, 8), new MeshBasicMaterial({ color: 0xffffff, toneMapped: false }));
    tip.name = 'tip';
    tip.position.copy(TIP);
    g.add(handle, tip);
    return g;
  }

  private tipWorld(p: Prop, out: Vector3): Vector3 {
    return out.copy(TIP).applyQuaternion(p.object.quaternion).add(p.object.position);
  }

  private whileHeld(p: Prop, hand: HandInput, dt: number): void {
    // The held prop's visual is placed after this runs; use the grab target via the object
    // pose computed this frame (GrabSystem.computeTarget ran just before).
    const tip = this.tipWorld(p, new Vector3());
    // Dip into a pot to load colour.
    for (const pot of this.pots) {
      const dx = tip.x - pot.pos.x;
      const dz = tip.z - pot.pos.z;
      if (dx * dx + dz * dz < 0.045 * 0.045 && tip.y < pot.pos.y + 0.02 && tip.y > pot.pos.y - 0.08) {
        if (this.colorOf.get(p) !== pot.color) {
          this.colorOf.set(p, pot.color);
          hand.pulse(0.35, 30);
          sparkle(tip, 1 + this.pots.indexOf(pot) * 0.08);
          this.app.fx.burst(tip, 12, 0.5, pot.color === 'rainbow' ? new Color(0xffffff) : pot.color, { size: 0.012, life: 0.4, drag: 4 });
          bus.emit('paint-color', { id: p.id, color: pot.color === 'rainbow' ? 'rainbow' : '#' + pot.color.getHexString() });
        }
      }
    }
    const c = this.colorOf.get(p)!;
    const tipMat = this.tipMat.get(p)!;
    const now = performance.now();
    if (c === 'rainbow') tipMat.color.setHSL((now / 2000) % 1, 0.9, 0.6);
    else tipMat.color.copy(c);

    // Undo the last stroke.
    if (hand.b.down) this.undo();

    const pressure = hand.trigger.value;
    let a = this.active.get(hand);
    if (pressure > 0.06) {
      if (!a) {
        const stroke = new Stroke(this.material);
        this.root.add(stroke.mesh);
        this.strokes.push(stroke);
        a = { stroke, smooth: tip.clone(), hapticAt: 0 };
        this.active.set(hand, a);
        bus.emit('stroke-start', { hand: hand.handedness });
      }
      a.smooth.lerp(tip, Math.min(1, dt * 40));
      const s = a.stroke;
      if (s.count === 0 || a.smooth.distanceTo(s.last) > 0.0035) {
        const side = new Vector3(1, 0, 0).applyQuaternion(p.object.quaternion).normalize();
        const width = 0.003 + 0.017 * pressure;
        const col = c === 'rainbow' ? this.tmpColor.setHSL((s.length * 0.45) % 1, 0.95, 0.55) : c;
        if (!s.add(a.smooth, side, width, col)) {
          this.endStroke(hand);
        } else {
          this.totalPoints++;
          if (s.length - a.hapticAt > 0.03) {
            a.hapticAt = s.length;
            hand.pulse(0.05 + pressure * 0.08, 10);
          }
        }
        this.enforceBudget();
      }
      // Glints off the nib while painting.
      if (Math.random() < 0.35) {
        this.app.fx.emit({
          position: tip,
          velocity: new Vector3((Math.random() - 0.5) * 0.2, Math.random() * 0.15, (Math.random() - 0.5) * 0.2),
          color: c === 'rainbow' ? this.tmpColor.clone() : c,
          size: 0.008,
          life: 0.5,
          drag: 2,
        });
      }
    } else if (a) {
      this.endStroke(hand);
    }
  }

  private endStroke(hand: HandInput): void {
    const a = this.active.get(hand);
    if (!a) return;
    this.active.delete(hand);
    if (a.stroke.count < 2) {
      this.removeStroke(a.stroke);
      return;
    }
    bus.emit('stroke-end', { hand: hand.handedness, points: a.stroke.count, length: +a.stroke.length.toFixed(2) });
  }

  private removeStroke(s: Stroke): void {
    const i = this.strokes.indexOf(s);
    if (i >= 0) this.strokes.splice(i, 1);
    this.totalPoints -= s.count;
    s.dispose();
  }

  private enforceBudget(): void {
    while (this.totalPoints > MAX_TOTAL_POINTS && this.strokes.length > 1) {
      const oldest = this.strokes[0];
      if ([...this.active.values()].some((a) => a.stroke === oldest)) break;
      this.removeStroke(oldest);
    }
  }

  undo(): void {
    for (let i = this.strokes.length - 1; i >= 0; i--) {
      const s = this.strokes[i];
      if ([...this.active.values()].some((a) => a.stroke === s)) continue;
      this.removeStroke(s);
      return;
    }
  }

  clear(): void {
    for (const s of [...this.strokes]) {
      if ([...this.active.values()].some((a) => a.stroke === s)) continue;
      this.removeStroke(s);
    }
  }

  get pointCount(): number {
    return this.totalPoints;
  }

  update(time: number): void {
    this.uniforms.uTime.value = time;
    // Rainbow pot shimmers.
    const rb = this.pots[this.pots.length - 1];
    (rb.paint.material as MeshBasicMaterial).color.setHSL((time * 0.15) % 1, 0.9, 0.6);
  }
}
