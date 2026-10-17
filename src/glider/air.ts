import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  DynamicDrawUsage,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshLambertMaterial,
  Points,
  Quaternion,
  ShaderMaterial,
  Vector2,
  Vector3,
  Vector4,
} from 'three';
import { smoothstep } from '../core/math';
import type { Island } from '../world/island';
import { WIND } from '../world/wind';

export interface Thermal {
  name: string;
  x: number;
  z: number;
  /** Core radius (m): lift falls off smoothly beyond it. */
  radius: number;
  /** Climb in the core (m/s). */
  strength: number;
  /** It rises off the cloud sea and tops out here. */
  top: number;
}

/**
 * Rising air off the islands' sunny sides and over the open sky between them: circle in
 * one to climb. Their edges stay clear of the main island, so landing there is easy.
 */
export const THERMALS: Thermal[] = [
  { name: 'satellite', x: 16, z: -17, radius: 12, strength: 3.0, top: 40 },
  { name: 'west-isle', x: -25, z: -21, radius: 13, strength: 3.2, top: 46 },
  { name: 'south', x: 2, z: 30, radius: 12, strength: 2.8, top: 36 },
  { name: 'east', x: 30, z: 10, radius: 11, strength: 2.8, top: 34 },
  { name: 'midway', x: -14, z: -50, radius: 11, strength: 3.0, top: 40 },
  { name: 'perch', x: -16, z: -94, radius: 11, strength: 3.0, top: 48 },
  { name: 'north-east', x: 36, z: -64, radius: 12, strength: 3.0, top: 46 },
  { name: 'far-west', x: -56, z: 22, radius: 12, strength: 3.0, top: 50 },
  { name: 'far-east', x: 60, z: 28, radius: 11, strength: 2.8, top: 36 },
  { name: 'far-south', x: 18, z: 54, radius: 12, strength: 3.0, top: 40 },
];
const BASE = -40;

/** The breeze rising over an island's windward rim. */
export interface Ridge {
  name: string;
  x: number;
  z: number;
  /** The island's top (m). */
  top: number;
  radius: number;
  /** Lift at the best spot (m/s). */
  strength: number;
}

/** Which way the breeze blows (horizontal unit vector). */
const WIND_DIR = new Vector2(WIND.x, WIND.z).normalize();

/** Every island big enough to push the breeze up over its windward rim makes a ridge to soar. */
export function ridgesOf(islands: Island[]): Ridge[] {
  return islands
    .filter((i) => i.spec.radius >= 3)
    .map((i) => ({ name: i.spec.name, x: i.spec.center.x, z: i.spec.center.z, top: i.spec.center.y, radius: i.spec.radius, strength: 1.3 + 0.08 * i.spec.radius }));
}

export function thermalLift(t: Thermal, p: Vector3): number {
  const d2 = ((p.x - t.x) ** 2 + (p.z - t.z) ** 2) / (t.radius * t.radius);
  if (d2 > 6) return 0;
  return t.strength * Math.exp(-1.4 * d2) * smoothstep(t.top, t.top - 10, p.y) * smoothstep(BASE, BASE + 8, p.y);
}

/**
 * Ridge lift: strongest just off the windward rim, from a little below the top to well
 * above it, fading round the sides of the island and higher up. Nothing on the lee side.
 */
export function ridgeLift(r: Ridge, p: Vector3): number {
  const dx = p.x - r.x;
  const dz = p.z - r.z;
  const dist = Math.hypot(dx, dz);
  if (dist > r.radius * 3 || dist < 1e-3) return 0;
  const upwind = -(dx * WIND_DIR.x + dz * WIND_DIR.y) / dist;
  const side = smoothstep(-0.05, 0.7, upwind);
  if (side <= 0) return 0;
  // The air rises along the rim and out beyond it; over the top it's already flowing level,
  // so the band fades fast inward (you can still land on the island) and slowly outward.
  const off = dist - 1.05 * r.radius;
  const band = Math.exp(-((off / ((off < 0 ? 0.25 : 0.7) * r.radius)) ** 2));
  const height = smoothstep(r.top - 8, r.top - 1, p.y) * smoothstep(r.top + 2 * r.radius, r.top + 0.4 * r.radius, p.y);
  return r.strength * side * band * height;
}

const thermalColumnVertex = /* glsl */ `
attribute vec3 aCol;
attribute vec2 aSpan;
varying float vAround;
varying float vY;
varying float vH;
varying float vRim;
varying float vFade;
void main() {
  vec3 p = vec3(aCol.x + position.x * aCol.z, mix(aSpan.x, aSpan.y, position.y), aCol.y + position.z * aCol.z);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  vAround = uv.x;
  vY = p.y;
  vH = position.y;
  vec3 n = normalize((viewMatrix * vec4(position.x, 0.0, position.z, 0.0)).xyz);
  vRim = 1.0 - abs(dot(n, normalize(-mv.xyz)));
  float d = length(mv.xyz);
  vFade = (1.0 - smoothstep(120.0, 250.0, d)) * smoothstep(2.0, 7.0, d);
}`;

const thermalColumnFragment = /* glsl */ `
uniform float uTime;
uniform float uLevel;
uniform vec3 uColor;
varying float vAround;
varying float vY;
varying float vH;
varying float vRim;
varying float vFade;
void main() {
  // Streaks winding up the column, with brighter pulses rising at about the air's speed.
  float s = fract(vAround * 5.0 - vY / 36.0 + uTime * 0.03);
  float streak = smoothstep(0.0, 0.04, s) * smoothstep(0.12, 0.04, s);
  float pulse = fract(vY / 14.0 - uTime * 0.2);
  float a = streak * (0.35 + 0.65 * smoothstep(0.0, 0.5, pulse) * smoothstep(1.0, 0.5, pulse));
  a *= smoothstep(0.0, 0.25, vH) * smoothstep(1.0, 0.8, vH) * (0.15 + 0.85 * vRim * vRim) * vFade * uLevel;
  gl_FragColor = vec4(uColor, a);
}`;

const pointsHead = /* glsl */ `
uniform float uTime;
uniform float uSize;
uniform vec4 uViewport;
attribute vec3 aSeed;
varying float vAlpha;
`;

const pointsTail = /* glsl */ `
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float d = -mv.z;
  // Gone far away (the fog) and right in front of your eyes (flying through them).
  alpha *= smoothstep(0.6, 2.5, d) * (1.0 - smoothstep(110.0, 220.0, d));
  vAlpha = alpha;
  gl_PointSize = clamp(uSize * projectionMatrix[1][1] * uViewport.w * 0.5 / d, 1.5, 40.0);
}`;

/** Dust spiralling up each thermal. */
const thermalMoteVertex = /* glsl */ `${pointsHead}
attribute vec3 aCol;
attribute vec3 aSpan;
void main() {
  float height = aSpan.y - aSpan.x;
  float y = mod(aSeed.z * height + uTime * aSpan.z * (0.7 + 0.6 * fract(aSeed.x * 7.13)), height);
  float ang = aSeed.x * 6.2832 + uTime * 0.3 * (0.5 + aSeed.y);
  float r = aCol.z * sqrt(aSeed.y);
  vec3 p = vec3(aCol.x + cos(ang) * r, aSpan.x + y, aCol.y + sin(ang) * r);
  float h = y / height;
  float alpha = smoothstep(0.0, 0.12, h) * smoothstep(1.0, 0.82, h);
${pointsTail}`;

/** Dust carried by the breeze, lifting over each island's windward rim. */
const ridgeMoteVertex = /* glsl */ `${pointsHead}
uniform vec3 uWind;
attribute vec4 aRidge;
void main() {
  vec2 w = uWind.xy;
  vec2 across = vec2(-w.y, w.x);
  float R = aRidge.z;
  float L = 2.8 * R + 8.0;
  float t = fract(aSeed.x + uTime * (1.4 + aSeed.z) / L);
  float lateral = (aSeed.y - 0.5) * 2.4 * R;
  float onIsland = 1.0 - smoothstep(0.65, 1.05, abs(lateral) / R);
  vec2 xz = aRidge.xy - w * (1.9 * R + 4.0) + across * lateral + w * (t * L);
  // Level upwind; it rises as it reaches the rim, and is carried over the top.
  float rim = (0.9 * R + 4.0) / L;
  float rise = smoothstep(rim - 0.3, rim + 0.15, t) * (0.8 * R + 3.0) * (0.6 + 0.4 * fract(aSeed.y * 9.13)) * onIsland;
  vec3 p = vec3(xz.x, aRidge.w - 5.0 + fract(aSeed.x * 13.7) * 5.0 + rise, xz.y);
  float alpha = smoothstep(0.0, 0.12, t) * smoothstep(1.0, 0.72, t) * (0.35 + 0.65 * onIsland);
${pointsTail}`;

const moteFragment = /* glsl */ `
uniform vec3 uColor;
uniform float uLevel;
varying float vAlpha;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  gl_FragColor = vec4(uColor, smoothstep(0.5, 0.1, length(d)) * vAlpha * uLevel);
}`;

const THERMAL_MOTES = 200;
const RIDGE_MOTES = 110;

const _parts = { thermal: 0, ridge: 0 };
const _up = new Vector3(0, 1, 0);
const _fwd = new Vector3(0, 0, -1);

/**
 * The rising air the glider can use, and how you see it: thermals (columns of faint
 * streaks winding upward, dust spiralling up, birds circling at the top) and ridge lift
 * (dust carried up over each island's windward rim).
 */
export class Air {
  readonly root = new Group();
  readonly ridges: Ridge[];
  private readonly materials: ShaderMaterial[] = [];
  private readonly birds: InstancedMesh;
  private readonly birdState: { t: Thermal; r: number; w: number; y: number; phase: number }[] = [];

  constructor(islands: Island[]) {
    this.root.name = 'air';
    this.ridges = ridgesOf(islands);
    this.root.add(this.columns(), this.thermalMotes(), this.ridgeMotes());
    for (const t of THERMALS) {
      for (let i = 0; i < 3; i++) {
        this.birdState.push({ t, r: 5 + Math.random() * 4, w: (0.32 + Math.random() * 0.14) * (i % 2 ? 1 : -1), y: t.top - 4 - i * 3.5 - Math.random() * 2, phase: Math.random() * 6.28 });
      }
    }
    this.birds = this.birdFlock();
    this.root.add(this.birds);
  }

  /** Vertical air speed at a point (m/s, up is positive), split into thermal and ridge lift. The result is reused. */
  sample(p: Vector3): { thermal: number; ridge: number } {
    _parts.thermal = 0;
    _parts.ridge = 0;
    for (const t of THERMALS) _parts.thermal += thermalLift(t, p);
    for (const r of this.ridges) _parts.ridge += ridgeLift(r, p);
    return _parts;
  }

  lift(p: Vector3): number {
    const s = this.sample(p);
    return s.thermal + s.ridge;
  }

  /** Animate; `daylight` 0..1 (dimmer at night). */
  update(time: number, daylight: number): void {
    const level = 0.45 + 0.55 * daylight;
    for (const m of this.materials) {
      m.uniforms.uTime.value = time;
      m.uniforms.uLevel.value = level * (m.userData.level as number);
    }
    const p = new Vector3();
    const q = new Quaternion();
    const roll = new Quaternion();
    const s = new Vector3(1.6, 1.6, 1.6);
    const m = new Matrix4();
    this.birdState.forEach((b, i) => {
      const a = b.phase + time * b.w;
      p.set(b.t.x + Math.cos(a) * b.r, b.y + Math.sin(time * 0.3 + b.phase) * 0.6, b.t.z + Math.sin(a) * b.r);
      // Flying along the circle (tangent), banked into it.
      const yaw = Math.atan2(Math.sin(a) * Math.sign(b.w), Math.cos(a) * -Math.sign(b.w));
      q.setFromAxisAngle(_up, yaw);
      roll.setFromAxisAngle(_fwd, 0.45 * Math.sign(b.w));
      q.multiply(roll);
      m.compose(p, q, s);
      this.birds.setMatrixAt(i, m);
    });
    this.birds.instanceMatrix.needsUpdate = true;
  }

  private material(vertexShader: string, fragmentShader: string, level: number, extra: Record<string, { value: unknown }> = {}): ShaderMaterial {
    const m = new ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        uTime: { value: 0 },
        uLevel: { value: level },
        uColor: { value: new Color(1, 0.95, 0.84) },
        uSize: { value: 0.14 },
        uViewport: { value: new Vector4(0, 0, 1, 1) },
        ...extra,
      },
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    m.userData.level = level;
    this.materials.push(m);
    return m;
  }

  /** One mesh for every thermal's column: open cylinders, placed in the vertex shader. */
  private columns(): Mesh {
    const unit = new CylinderGeometry(1, 1, 1, 28, 1, true).translate(0, 0.5, 0);
    const n = unit.getAttribute('position').count;
    const pos = new Float32Array(THERMALS.length * n * 3);
    const uv = new Float32Array(THERMALS.length * n * 2);
    const col = new Float32Array(THERMALS.length * n * 3);
    const span = new Float32Array(THERMALS.length * n * 2);
    const index: number[] = [];
    const ui = unit.getIndex()!;
    THERMALS.forEach((t, k) => {
      pos.set(unit.getAttribute('position').array as Float32Array, k * n * 3);
      uv.set(unit.getAttribute('uv').array as Float32Array, k * n * 2);
      for (let i = 0; i < n; i++) {
        col.set([t.x, t.z, t.radius * 0.85], (k * n + i) * 3);
        span.set([BASE + 6, t.top], (k * n + i) * 2);
      }
      for (let i = 0; i < ui.count; i++) index.push(ui.getX(i) + k * n);
    });
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(pos, 3));
    geo.setAttribute('uv', new BufferAttribute(uv, 2));
    geo.setAttribute('aCol', new BufferAttribute(col, 3));
    geo.setAttribute('aSpan', new BufferAttribute(span, 2));
    geo.setIndex(index);
    const mat = this.material(thermalColumnVertex, thermalColumnFragment, 0.055);
    mat.side = DoubleSide;
    const mesh = new Mesh(geo, mat);
    mesh.name = 'thermal-columns';
    mesh.frustumCulled = false;
    mesh.renderOrder = 3;
    return mesh;
  }

  private points(name: string, count: number, attrs: Record<string, [Float32Array, number]>, vertexShader: string, level: number, extra: Record<string, { value: unknown }> = {}): Points {
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(new Float32Array(count * 3), 3));
    const seeds = new Float32Array(count * 3);
    for (let i = 0; i < seeds.length; i++) seeds[i] = Math.random();
    geo.setAttribute('aSeed', new BufferAttribute(seeds, 3));
    for (const [k, [a, size]] of Object.entries(attrs)) geo.setAttribute(k, new BufferAttribute(a, size));
    const mat = this.material(vertexShader, moteFragment, level, extra);
    const pts = new Points(geo, mat);
    pts.name = name;
    pts.frustumCulled = false;
    pts.onBeforeRender = (renderer) => {
      renderer.getCurrentViewport(mat.uniforms.uViewport.value);
      mat.uniformsNeedUpdate = true;
    };
    return pts;
  }

  private thermalMotes(): Points {
    const n = THERMALS.length * THERMAL_MOTES;
    const col = new Float32Array(n * 3);
    const span = new Float32Array(n * 3);
    THERMALS.forEach((t, k) => {
      for (let i = 0; i < THERMAL_MOTES; i++) {
        col.set([t.x, t.z, t.radius * 1.1], (k * THERMAL_MOTES + i) * 3);
        span.set([BASE, t.top, t.strength], (k * THERMAL_MOTES + i) * 3);
      }
    });
    return this.points('thermal-motes', n, { aCol: [col, 3], aSpan: [span, 3] }, thermalMoteVertex, 0.5);
  }

  private ridgeMotes(): Points {
    const n = this.ridges.length * RIDGE_MOTES;
    const ridge = new Float32Array(n * 4);
    this.ridges.forEach((r, k) => {
      for (let i = 0; i < RIDGE_MOTES; i++) ridge.set([r.x, r.z, r.radius, r.top], (k * RIDGE_MOTES + i) * 4);
    });
    return this.points('ridge-motes', n, { aRidge: [ridge, 4] }, ridgeMoteVertex, 0.45, { uWind: { value: new Vector3(WIND_DIR.x, WIND_DIR.y, 0) } });
  }

  /** Soaring birds, about 2 m across: gull wings (an "M" head on) and a slim body. */
  private birdFlock(): InstancedMesh {
    const tris: number[] = [];
    for (const sx of [1, -1]) {
      const rootL = [0, 0, -0.08];
      const rootT = [0, 0, 0.1];
      const elbowL = [sx * 0.32, 0.07, -0.05];
      const elbowT = [sx * 0.32, 0.07, 0.06];
      const tip = [sx * 0.68, -0.02, 0.08];
      tris.push(...rootL, ...elbowL, ...rootT, ...rootT, ...elbowL, ...elbowT, ...elbowL, ...tip, ...elbowT);
    }
    tris.push(0, 0.02, -0.32, -0.06, 0, 0.18, 0.06, 0, 0.18, 0, 0.02, -0.32, 0, 0.05, 0, -0.06, 0, 0.18);
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(new Float32Array(tris), 3));
    geo.computeVertexNormals();
    const birds = new InstancedMesh(geo, new MeshLambertMaterial({ color: 0x3a312c, side: DoubleSide }), this.birdState.length);
    birds.instanceMatrix.setUsage(DynamicDrawUsage);
    birds.frustumCulled = false;
    birds.name = 'thermal-birds';
    return birds;
  }
}
