import {
  CanvasTexture,
  Color,
  DynamicDrawUsage,
  FogExp2,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  PlaneGeometry,
  ShaderMaterial,
  Vector3,
} from 'three';
import type { LightEmitter } from './lights';

const vertex = /* glsl */ `
attribute vec3 aPos;
attribute float aSize;
attribute float aRot;
attribute vec4 aColor;
attribute float aTile;
varying vec2 vUv;
varying vec4 vColor;
varying float vFogDepth;
void main() {
  // A quad that faces this eye, spun by its own angle.
  vec4 mv = viewMatrix * vec4(aPos, 1.0);
  float c = cos(aRot);
  float s = sin(aRot);
  mv.xy += vec2(c * position.x - s * position.y, s * position.x + c * position.y) * aSize;
  gl_Position = projectionMatrix * mv;
  vec2 tile = vec2(mod(aTile, 2.0), floor(aTile / 2.0)) * 0.5;
  vUv = tile + (position.xy + 0.5) * 0.5;
  vColor = aColor;
  vFogDepth = -mv.z;
}`;

const fragment = /* glsl */ `
uniform sampler2D uMap;
uniform vec3 fogColor;
uniform float fogDensity;
varying vec2 vUv;
varying vec4 vColor;
varying float vFogDepth;
void main() {
  float a = texture2D(uMap, vUv).r * vColor.a;
  if (a < 0.004) discard;
  float fog = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
  gl_FragColor = vec4(mix(vColor.rgb, fogColor, fog), a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/** Four soft, lumpy puffs in a 2×2 atlas (white; the red channel is coverage). */
function puffAtlas(): CanvasTexture {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d')!;
  g.fillStyle = '#000';
  g.fillRect(0, 0, S, S);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let t = 0; t < 4; t++) {
    const ox = (t % 2) * 128;
    const oy = Math.floor(t / 2) * 128;
    g.save();
    g.beginPath();
    g.rect(ox, oy, 128, 128);
    g.clip();
    g.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 26; i++) {
      const a = rnd() * Math.PI * 2;
      const d = Math.pow(rnd(), 0.7) * 30;
      const x = ox + 64 + Math.cos(a) * d;
      const y = oy + 64 + Math.sin(a) * d;
      const r = 16 + rnd() * 26;
      const grad = g.createRadialGradient(x, y, 0, x, y, r);
      const k = 0.1 + rnd() * 0.12;
      grad.addColorStop(0, `rgba(255,255,255,${k})`);
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grad;
      g.fillRect(ox, oy, 128, 128);
    }
    g.restore();
  }
  // Fade every tile to nothing at its edge so quads never show a border.
  const img = g.getImageData(0, 0, S, S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const lx = (x % 128) - 64;
      const ly = (y % 128) - 64;
      const r = Math.hypot(lx, ly) / 64;
      const fall = Math.max(0, 1 - r * r);
      const i = (y * S + x) * 4;
      const v = Math.min(255, img.data[i] * 1.6 * fall);
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return new CanvasTexture(c);
}

export interface SmokeEmit {
  pos: Vector3;
  vel?: Vector3;
  color: Color;
  size: number;
  sizeEnd: number;
  life: number;
  alpha?: number;
  /** Upward drift (m/s) on top of the wind: hot smoke rises. */
  rise?: number;
  /** How much the wind carries it (0..1). */
  windy?: number;
}

const _toCam = new Vector3();
const _c = new Color();

/**
 * Coloured smoke: camera-facing puffs (instanced quads, one draw call) that
 * grow, drift with the wind and fade. Each puff is lit on the CPU from the
 * scene's ambient light plus any burning flares, so smoke near a flare glows.
 */
export class SmokeSystem {
  readonly mesh: Mesh;
  private readonly cap: number;
  count = 0;
  private readonly pos: Float32Array;
  private readonly vel: Float32Array;
  private readonly base: Float32Array;
  private readonly s0: Float32Array;
  private readonly s1: Float32Array;
  private readonly age: Float32Array;
  private readonly life: Float32Array;
  private readonly a0: Float32Array;
  private readonly rot: Float32Array;
  private readonly spin: Float32Array;
  private readonly rise: Float32Array;
  private readonly windy: Float32Array;
  private readonly tile: Float32Array;
  private readonly order: number[] = [];
  private readonly depth: Float32Array;
  private readonly aPos: InstancedBufferAttribute;
  private readonly aSize: InstancedBufferAttribute;
  private readonly aRot: InstancedBufferAttribute;
  private readonly aColor: InstancedBufferAttribute;
  private readonly aTile: InstancedBufferAttribute;
  private readonly geo: InstancedBufferGeometry;
  private readonly uniforms = {
    uMap: { value: puffAtlas() },
    fogColor: { value: new Color() },
    fogDensity: { value: 0 },
  };

  constructor(capacity: number) {
    this.cap = capacity;
    const f = (n: number) => new Float32Array(capacity * n);
    this.pos = f(3);
    this.vel = f(3);
    this.base = f(3);
    this.s0 = f(1);
    this.s1 = f(1);
    this.age = f(1);
    this.life = f(1);
    this.a0 = f(1);
    this.rot = f(1);
    this.spin = f(1);
    this.rise = f(1);
    this.windy = f(1);
    this.tile = f(1);
    this.depth = f(1);
    const quad = new PlaneGeometry(1, 1);
    const geo = new InstancedBufferGeometry();
    geo.index = quad.index;
    geo.setAttribute('position', quad.getAttribute('position'));
    const attr = (n: number) => new InstancedBufferAttribute(new Float32Array(capacity * n), n).setUsage(DynamicDrawUsage);
    this.aPos = attr(3);
    this.aSize = attr(1);
    this.aRot = attr(1);
    this.aColor = attr(4);
    this.aTile = attr(1);
    geo.setAttribute('aPos', this.aPos);
    geo.setAttribute('aSize', this.aSize);
    geo.setAttribute('aRot', this.aRot);
    geo.setAttribute('aColor', this.aColor);
    geo.setAttribute('aTile', this.aTile);
    geo.instanceCount = 0;
    this.geo = geo;
    this.mesh = new Mesh(
      geo,
      new ShaderMaterial({ vertexShader: vertex, fragmentShader: fragment, uniforms: this.uniforms, transparent: true, depthWrite: false }),
    );
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 8;
    this.mesh.name = 'smoke';
  }

  emit(o: SmokeEmit): void {
    let i: number;
    if (this.count < this.cap) i = this.count++;
    else {
      // Full: replace the oldest-looking puff.
      i = 0;
      for (let k = 1; k < this.count; k++) if (this.age[k] / this.life[k] > this.age[i] / this.life[i]) i = k;
    }
    const v = o.vel;
    this.pos.set([o.pos.x, o.pos.y, o.pos.z], i * 3);
    this.vel.set(v ? [v.x, v.y, v.z] : [0, 0, 0], i * 3);
    this.base.set([o.color.r, o.color.g, o.color.b], i * 3);
    this.s0[i] = o.size;
    this.s1[i] = o.sizeEnd;
    this.age[i] = 0;
    this.life[i] = o.life * (0.85 + Math.random() * 0.3);
    this.a0[i] = o.alpha ?? 0.85;
    this.rot[i] = Math.random() * Math.PI * 2;
    this.spin[i] = (Math.random() - 0.5) * 0.35;
    this.rise[i] = o.rise ?? 0.25;
    this.windy[i] = o.windy ?? 1;
    this.tile[i] = Math.floor(Math.random() * 4);
  }

  /**
   * Move, light and sort the puffs (farthest first) for this frame.
   * `ambient` is the scene's light on smoke; `lights` are burning flares.
   */
  update(dt: number, wind: Vector3, ambient: Color, lights: readonly LightEmitter[], eye: Vector3, fog: FogExp2 | null): void {
    if (fog) {
      this.uniforms.fogColor.value.copy(fog.color);
      this.uniforms.fogDensity.value = fog.density;
    }
    let i = 0;
    while (i < this.count) {
      const age = (this.age[i] += dt);
      if (age >= this.life[i]) {
        this.kill(i);
        continue;
      }
      const i3 = i * 3;
      // Launch velocity dies away; the wind and buoyancy take over.
      const k = Math.exp(-dt * 1.6);
      this.vel[i3] *= k;
      this.vel[i3 + 1] *= k;
      this.vel[i3 + 2] *= k;
      const w = this.windy[i];
      this.pos[i3] += (this.vel[i3] + wind.x * w) * dt;
      this.pos[i3 + 1] += (this.vel[i3 + 1] + this.rise[i]) * dt;
      this.pos[i3 + 2] += (this.vel[i3 + 2] + wind.z * w) * dt;
      this.rot[i] += this.spin[i] * dt;
      this.depth[i] = _toCam.set(this.pos[i3] - eye.x, this.pos[i3 + 1] - eye.y, this.pos[i3 + 2] - eye.z).lengthSq();
      i++;
    }
    const n = this.count;
    const order = this.order;
    order.length = n;
    for (let j = 0; j < n; j++) order[j] = j;
    order.sort((a, b) => this.depth[b] - this.depth[a]);
    for (let j = 0; j < n; j++) {
      const p = order[j];
      const p3 = p * 3;
      const t = this.age[p] / this.life[p];
      // Billow in fast, then fade out slowly.
      const fade = Math.min(1, t / 0.08) * Math.pow(1 - t, 1.4);
      const x = this.pos[p3];
      const y = this.pos[p3 + 1];
      const z = this.pos[p3 + 2];
      // Ambient light plus every flare nearby (inverse square, softened).
      _c.copy(ambient);
      for (const L of lights) {
        const dx = L.pos.x - x;
        const dy = L.pos.y - y;
        const dz = L.pos.z - z;
        const e = (L.intensity * 0.0011) / (dx * dx + dy * dy + dz * dz + 6);
        _c.r += L.color.r * e;
        _c.g += L.color.g * e;
        _c.b += L.color.b * e;
      }
      const r = Math.min(1.4, this.base[p3] * _c.r);
      const g = Math.min(1.4, this.base[p3 + 1] * _c.g);
      const b = Math.min(1.4, this.base[p3 + 2] * _c.b);
      this.aPos.setXYZ(j, x, y, z);
      this.aSize.setX(j, this.s0[p] + (this.s1[p] - this.s0[p]) * Math.sqrt(t));
      this.aRot.setX(j, this.rot[p]);
      this.aColor.setXYZW(j, r, g, b, this.a0[p] * fade);
      this.aTile.setX(j, this.tile[p]);
    }
    this.geo.instanceCount = n;
    for (const a of [this.aPos, this.aSize, this.aRot, this.aColor, this.aTile]) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, n * a.itemSize);
      a.needsUpdate = true;
    }
  }

  private kill(i: number): void {
    const last = --this.count;
    if (i === last) return;
    for (const [arr, n] of [
      [this.pos, 3],
      [this.vel, 3],
      [this.base, 3],
      [this.s0, 1],
      [this.s1, 1],
      [this.age, 1],
      [this.life, 1],
      [this.a0, 1],
      [this.rot, 1],
      [this.spin, 1],
      [this.rise, 1],
      [this.windy, 1],
      [this.tile, 1],
    ] as const) {
      arr.copyWithin(i * n, last * n, last * n + n);
    }
  }

  clear(): void {
    this.count = 0;
    this.geo.instanceCount = 0;
  }
}
