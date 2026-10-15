import { AdditiveBlending, BufferAttribute, BufferGeometry, Color, DynamicDrawUsage, Points, ShaderMaterial, Vector3, Vector4, type WebGLRenderer } from 'three';

const vertex = /* glsl */ `
attribute float aSize;
attribute float aAlpha;
attribute vec3 color;
uniform float uViewportHeight;
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float px = aSize * projectionMatrix[1][1] * uViewportHeight * 0.5 / max(-mv.z, 0.05);
  gl_PointSize = clamp(px, 0.0, 160.0);
  // Very small particles fade instead of shimmering as sub-pixel dots.
  vAlpha = aAlpha * clamp(px / 1.5, 0.0, 1.0);
  vColor = color;
}`;

const fragment = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  float a = smoothstep(1.0, 0.0, d);
  a *= a;
  float core = smoothstep(0.35, 0.0, d);
  vec3 col = vColor * a + vec3(core * 0.6) * a;
  gl_FragColor = vec4(col * vAlpha, 1.0);
  #include <colorspace_fragment>
}`;

export interface EmitOptions {
  position: Vector3;
  velocity?: Vector3;
  color: Color;
  /** Colour at end of life (defaults to `color`). */
  colorEnd?: Color;
  size: number; // metres
  sizeEnd?: number;
  life: number; // seconds
  drag?: number; // 1/s
  gravity?: number; // multiplier on -9.81
  alpha?: number;
  /** Random flicker amount 0..1 (glitter). */
  flicker?: number;
}

const _v4 = new Vector4();

/** One additive point cloud for every spark, ember and glint in the scene. */
export class Particles {
  readonly points: Points;
  private readonly capacity: number;
  private count = 0;
  private readonly pos: Float32Array;
  private readonly col: Float32Array;
  private readonly size: Float32Array;
  private readonly alpha: Float32Array;
  private readonly vel: Float32Array;
  private readonly life: Float32Array;
  private readonly maxLife: Float32Array;
  private readonly drag: Float32Array;
  private readonly grav: Float32Array;
  private readonly s0: Float32Array;
  private readonly s1: Float32Array;
  private readonly a0: Float32Array;
  private readonly c0: Float32Array;
  private readonly c1: Float32Array;
  private readonly flick: Float32Array;
  private readonly geo: BufferGeometry;
  private readonly uniforms = { uViewportHeight: { value: 1000 } };
  gravityScale = 1;

  constructor(capacity: number) {
    this.capacity = capacity;
    const f = (n: number) => new Float32Array(capacity * n);
    this.pos = f(3);
    this.col = f(3);
    this.size = f(1);
    this.alpha = f(1);
    this.vel = f(3);
    this.life = f(1);
    this.maxLife = f(1);
    this.drag = f(1);
    this.grav = f(1);
    this.s0 = f(1);
    this.s1 = f(1);
    this.a0 = f(1);
    this.c0 = f(3);
    this.c1 = f(3);
    this.flick = f(1);
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(this.pos, 3).setUsage(DynamicDrawUsage));
    geo.setAttribute('color', new BufferAttribute(this.col, 3).setUsage(DynamicDrawUsage));
    geo.setAttribute('aSize', new BufferAttribute(this.size, 1).setUsage(DynamicDrawUsage));
    geo.setAttribute('aAlpha', new BufferAttribute(this.alpha, 1).setUsage(DynamicDrawUsage));
    geo.setDrawRange(0, 0);
    this.geo = geo;
    const mat = new ShaderMaterial({
      vertexShader: vertex,
      fragmentShader: fragment,
      uniforms: this.uniforms,
      blending: AdditiveBlending,
      depthWrite: false,
      transparent: true,
    });
    this.points = new Points(geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 10;
    this.points.name = 'particles';
    this.points.onBeforeRender = (renderer: WebGLRenderer) => {
      renderer.getCurrentViewport(_v4);
      this.uniforms.uViewportHeight.value = _v4.w > 0 ? _v4.w : renderer.domElement.height;
    };
  }

  get active(): number {
    return this.count;
  }

  emit(o: EmitOptions): void {
    let i: number;
    if (this.count < this.capacity) i = this.count++;
    else i = Math.floor(Math.random() * this.capacity); // recycle a random one when full
    const v = o.velocity;
    this.pos.set([o.position.x, o.position.y, o.position.z], i * 3);
    this.vel.set(v ? [v.x, v.y, v.z] : [0, 0, 0], i * 3);
    this.c0.set([o.color.r, o.color.g, o.color.b], i * 3);
    const ce = o.colorEnd ?? o.color;
    this.c1.set([ce.r, ce.g, ce.b], i * 3);
    this.life[i] = 0;
    this.maxLife[i] = o.life;
    this.drag[i] = o.drag ?? 0;
    this.grav[i] = o.gravity ?? 0;
    this.s0[i] = o.size;
    this.s1[i] = o.sizeEnd ?? o.size * 0.3;
    this.a0[i] = o.alpha ?? 1;
    this.flick[i] = o.flicker ?? 0;
  }

  /** A spherical burst of `n` particles. */
  burst(at: Vector3, n: number, speed: number, color: Color, opts: Partial<EmitOptions> = {}): void {
    const vel = new Vector3();
    for (let k = 0; k < n; k++) {
      // Uniform direction on a sphere.
      const u = Math.random() * 2 - 1;
      const th = Math.random() * Math.PI * 2;
      const r = Math.sqrt(1 - u * u);
      vel.set(r * Math.cos(th), u, r * Math.sin(th)).multiplyScalar(speed * (0.75 + Math.random() * 0.35));
      this.emit({ position: at, velocity: vel, color, size: 0.02, life: 0.6, ...opts });
    }
  }

  update(dt: number): void {
    const g = -9.81 * this.gravityScale;
    let i = 0;
    while (i < this.count) {
      const life = (this.life[i] += dt);
      const max = this.maxLife[i];
      if (life >= max) {
        this.kill(i);
        continue;
      }
      const t = life / max;
      const i3 = i * 3;
      const dk = Math.max(0, 1 - this.drag[i] * dt);
      this.vel[i3] *= dk;
      this.vel[i3 + 1] = this.vel[i3 + 1] * dk + g * this.grav[i] * dt;
      this.vel[i3 + 2] *= dk;
      this.pos[i3] += this.vel[i3] * dt;
      this.pos[i3 + 1] += this.vel[i3 + 1] * dt;
      this.pos[i3 + 2] += this.vel[i3 + 2] * dt;
      this.col[i3] = this.c0[i3] + (this.c1[i3] - this.c0[i3]) * t;
      this.col[i3 + 1] = this.c0[i3 + 1] + (this.c1[i3 + 1] - this.c0[i3 + 1]) * t;
      this.col[i3 + 2] = this.c0[i3 + 2] + (this.c1[i3 + 2] - this.c0[i3 + 2]) * t;
      this.size[i] = this.s0[i] + (this.s1[i] - this.s0[i]) * t;
      const fade = t < 0.1 ? t / 0.1 : 1 - (t - 0.1) / 0.9;
      const fl = this.flick[i] > 0 ? 1 - this.flick[i] * (Math.random() < 0.5 ? 1 : 0) : 1;
      this.alpha[i] = this.a0[i] * fade * fl;
      i++;
    }
    this.geo.setDrawRange(0, this.count);
    for (const name of ['position', 'color', 'aSize', 'aAlpha']) {
      const a = this.geo.getAttribute(name) as BufferAttribute;
      a.clearUpdateRanges();
      a.addUpdateRange(0, this.count * a.itemSize);
      a.needsUpdate = true;
    }
  }

  private kill(i: number): void {
    const last = --this.count;
    if (i === last) return;
    const copy = (arr: Float32Array, n: number) => arr.copyWithin(i * n, last * n, last * n + n);
    copy(this.pos, 3);
    copy(this.col, 3);
    copy(this.vel, 3);
    copy(this.c0, 3);
    copy(this.c1, 3);
    copy(this.size, 1);
    copy(this.alpha, 1);
    copy(this.life, 1);
    copy(this.maxLife, 1);
    copy(this.drag, 1);
    copy(this.grav, 1);
    copy(this.s0, 1);
    copy(this.s1, 1);
    copy(this.a0, 1);
    copy(this.flick, 1);
  }

  clear(): void {
    this.count = 0;
    this.geo.setDrawRange(0, 0);
  }
}
