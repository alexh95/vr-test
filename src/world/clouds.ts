import {
  CircleGeometry,
  Color,
  DynamicDrawUsage,
  IcosahedronGeometry,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshLambertMaterial,
  Quaternion,
  ShaderMaterial,
  Vector3,
  type Camera,
} from 'three';
import { rng, TAU } from '../core/math';
import type { Preset } from './time-of-day';

const seaVertex = /* glsl */ `
varying vec3 vWorld;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const seaFragment = /* glsl */ `
uniform vec3 uLit;
uniform vec3 uShade;
uniform vec3 uFog;
uniform vec3 uSunDir;
uniform float uTime;
uniform int uOctaves;
uniform vec3 uFlarePos[2];
uniform vec3 uFlareCol[2];
varying vec3 vWorld;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) {
    if (i >= uOctaves) break;
    s += a * noise(p);
    p = p * 2.07 + 13.1;
    a *= 0.5;
  }
  return s;
}

void main() {
  vec2 p = vWorld.xz * 0.011 + vec2(uTime * 0.0035, uTime * 0.0012);
  float n = fbm(p);
  float n2 = fbm(p * 2.3 - vec2(uTime * 0.006, 0.0));
  float dens = smoothstep(0.32, 0.72, n * 0.75 + n2 * 0.35);
  // Fake lighting: brighter on the sun side of each billow.
  float lit = clamp(0.55 + (n2 - n) * 2.2 + dot(normalize(vec3(uSunDir.x, 0.0, uSunDir.z) + 1e-4), normalize(vec3(n - 0.5, 0.3, n2 - 0.5))) * 0.25, 0.0, 1.0);
  vec3 col = mix(uShade, uLit, dens * lit + dens * 0.25);
  // Flares light the cloud tops below them (inverse square, facing up).
  for (int i = 0; i < 2; i++) {
    vec3 L = uFlarePos[i] - vWorld;
    float d2 = dot(L, L);
    col += uFlareCol[i] * (max(L.y, 0.0) * inversesqrt(d2 + 1e-3) / (d2 + 30.0)) * (0.3 + 0.7 * dens);
  }
  float dist = length(vWorld.xz - cameraPosition.xz);
  col = mix(col, uFog, smoothstep(120.0, 820.0, dist));
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/** An endless sea of clouds far below, plus puffy cloud clusters drifting around. */
export class Clouds {
  readonly sea: Mesh;
  readonly puffs: InstancedMesh;
  private readonly seaUniforms = {
    uLit: { value: new Color() },
    uShade: { value: new Color() },
    uFog: { value: new Color() },
    uSunDir: { value: new Vector3() },
    uTime: { value: 0 },
    uOctaves: { value: 5 },
    uFlarePos: { value: [new Vector3(), new Vector3()] },
    uFlareCol: { value: [new Vector3(), new Vector3()] },
  };
  private readonly puffMat: MeshLambertMaterial;
  private readonly base: { pos: Vector3; scale: Vector3; speed: number; phase: number }[] = [];
  private readonly m = new Matrix4();
  private readonly q = new Quaternion();
  private readonly s = new Vector3();
  private readonly p = new Vector3();

  /** `avoid(x, y, z)` keeps cluster centres out of a region (the archery lane). */
  constructor(quality: 'high' | 'low', avoid: (x: number, y: number, z: number) => boolean = () => false) {
    this.seaUniforms.uOctaves.value = quality === 'high' ? 5 : 3;
    const seaMat = new ShaderMaterial({
      vertexShader: seaVertex,
      fragmentShader: seaFragment,
      uniforms: this.seaUniforms,
      fog: false,
    });
    this.sea = new Mesh(new CircleGeometry(950, 64), seaMat);
    this.sea.rotation.x = -Math.PI / 2;
    this.sea.position.y = -42;
    this.sea.name = 'cloud-sea';
    this.sea.renderOrder = -900;

    this.puffMat = new MeshLambertMaterial({ color: 0xffffff, emissive: new Color(0x000000), flatShading: false });
    const geo = new IcosahedronGeometry(1, 2);
    const clusters = quality === 'high' ? 34 : 18;
    const perCluster = 5;
    this.puffs = new InstancedMesh(geo, this.puffMat, clusters * perCluster);
    this.puffs.instanceMatrix.setUsage(DynamicDrawUsage);
    this.puffs.name = 'cloud-puffs';
    const r = rng(77);
    for (let c = 0; c < clusters; c++) {
      // Rings of clusters around the islands, mostly below eye level.
      const ang = r() * TAU;
      const dist = 26 + r() * 120;
      const center = new Vector3(Math.cos(ang) * dist, -30 + r() * 34, Math.sin(ang) * dist);
      const size = 2.5 + r() * 5 * (dist / 80);
      if (avoid(center.x, center.y + size, center.z)) {
        center.y -= 24; // drop it below the lane instead of removing it
      }
      for (let k = 0; k < perCluster; k++) {
        const off = new Vector3((r() - 0.5) * size * 2.2, (r() - 0.3) * size * 0.5, (r() - 0.5) * size * 1.2);
        const s = size * (0.45 + r() * 0.55);
        this.base.push({ pos: center.clone().add(off), scale: new Vector3(s * 1.3, s * 0.75, s), speed: 0.15 + r() * 0.35, phase: r() * TAU });
      }
    }
    this.update(0);
  }

  applyPreset(p: Readonly<Preset>): void {
    this.seaUniforms.uLit.value.copy(p.cloudLit);
    this.seaUniforms.uShade.value.copy(p.cloudShade);
    this.seaUniforms.uFog.value.copy(p.under);
    this.seaUniforms.uSunDir.value.copy(p.skySunDir);
    this.puffMat.color.copy(p.cloudLit).multiplyScalar(0.85);
    this.puffMat.emissive.copy(p.cloudShade).multiplyScalar(0.55);
  }

  /** Up to two burning flares light the sea of clouds from above. */
  setFlares(flares: readonly { pos: Vector3; color: Color; intensity: number }[]): void {
    for (let i = 0; i < 2; i++) {
      const f = flares[i];
      const col = this.seaUniforms.uFlareCol.value[i];
      if (!f) {
        col.set(0, 0, 0);
        continue;
      }
      this.seaUniforms.uFlarePos.value[i].copy(f.pos);
      col.set(f.color.r, f.color.g, f.color.b).multiplyScalar(f.intensity * 0.2);
    }
  }

  update(time: number, camera?: Camera): void {
    this.seaUniforms.uTime.value = time;
    if (camera) {
      // Keep the sea centred under the player so its edge never shows.
      camera.getWorldPosition(this.p);
      this.sea.position.x = this.p.x;
      this.sea.position.z = this.p.z;
    }
    for (let i = 0; i < this.base.length; i++) {
      const b = this.base[i];
      // Slow drift around the island plus a gentle bob.
      const a = time * 0.004 * b.speed;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      this.p.set(b.pos.x * ca - b.pos.z * sa, b.pos.y + Math.sin(time * 0.2 * b.speed + b.phase) * 0.4, b.pos.x * sa + b.pos.z * ca);
      this.m.compose(this.p, this.q, this.s.copy(b.scale));
      this.puffs.setMatrixAt(i, this.m);
    }
    this.puffs.instanceMatrix.needsUpdate = true;
  }
}
