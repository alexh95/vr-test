import { AdditiveBlending, BufferAttribute, BufferGeometry, Points, ShaderMaterial, Vector4, type WebGLRenderer } from 'three';
import { rng, TAU } from '../core/math';

const vertex = /* glsl */ `
attribute vec4 aSeed; // phase, speed, radius, blinkRate
uniform float uTime;
uniform float uViewportHeight;
uniform float uNight;
varying float vGlow;
void main() {
  float t = uTime * aSeed.y;
  vec3 p = position + vec3(sin(t + aSeed.x) * aSeed.z, sin(t * 1.37 + aSeed.x * 2.0) * aSeed.z * 0.45, cos(t * 0.83 + aSeed.x * 3.0) * aSeed.z);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float blink = smoothstep(0.15, 0.9, sin(uTime * aSeed.w + aSeed.x * 7.0) * 0.5 + 0.5);
  vGlow = mix(0.25, 1.0, uNight) * mix(0.35, 1.0, blink * uNight + (1.0 - uNight) * 0.6);
  float size = mix(0.012, 0.03, uNight);
  gl_PointSize = clamp(size * projectionMatrix[1][1] * uViewportHeight * 0.5 / max(-mv.z, 0.05), 0.0, 40.0);
}`;

const fragment = /* glsl */ `
uniform float uNight;
varying float vGlow;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  float a = smoothstep(1.0, 0.0, d);
  vec3 day = vec3(1.0, 0.93, 0.8) * 0.35;
  vec3 night = vec3(0.85, 1.0, 0.45) * 1.6;
  vec3 col = mix(day, night, uNight) * a * a * vGlow;
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}`;

const _v4 = new Vector4();

/** Dust motes by day, blinking fireflies by night. Fully GPU-animated. */
export class Fireflies {
  readonly points: Points;
  private readonly uniforms = { uTime: { value: 0 }, uViewportHeight: { value: 1000 }, uNight: { value: 0 } };

  constructor(count: number) {
    const r = rng(99);
    const pos = new Float32Array(count * 3);
    const seed = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      const a = r() * TAU;
      const d = 1.5 + Math.sqrt(r()) * 8.5;
      pos.set([Math.cos(a) * d, 0.3 + r() * 2.6, Math.sin(a) * d], i * 3);
      seed.set([r() * TAU, 0.15 + r() * 0.35, 0.3 + r() * 0.9, 0.8 + r() * 2.2], i * 4);
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(pos, 3));
    g.setAttribute('aSeed', new BufferAttribute(seed, 4));
    this.points = new Points(
      g,
      new ShaderMaterial({ vertexShader: vertex, fragmentShader: fragment, uniforms: this.uniforms, blending: AdditiveBlending, depthWrite: false, transparent: true }),
    );
    this.points.frustumCulled = false;
    this.points.name = 'fireflies';
    this.points.onBeforeRender = (renderer: WebGLRenderer) => {
      renderer.getCurrentViewport(_v4);
      this.uniforms.uViewportHeight.value = _v4.w > 0 ? _v4.w : renderer.domElement.height;
    };
  }

  update(time: number, night: number): void {
    this.uniforms.uTime.value = time;
    this.uniforms.uNight.value = night;
  }
}
