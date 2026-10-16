import { BufferAttribute, BufferGeometry, CanvasTexture, Color, CustomBlending, DoubleSide, Mesh, OneFactor, OneMinusSrcAlphaFactor, ShaderMaterial, Sprite, SpriteMaterial, SRGBColorSpace, Vector3 } from 'three';
import { EYES_ONLY_LAYER } from './scope';
import type { App } from '../app';

const SEGMENTS = 40;
const MAX_RANGE = 180; // m
const FADE = 14; // m: e-folding length of the visible beam, like a laser in thin haze
const HALF_WIDTH = 0.0022; // m at the emitter
const MIN_ANGLE = 0.0016; // rad: never thinner than a few headset pixels

const vertex = /* glsl */ `
uniform vec3 uStart;
uniform vec3 uEnd;
attribute float aAlong;
attribute float aSide;
varying float vSide;
varying float vDist;
varying float vThin;
void main() {
  vec3 axis = uEnd - uStart;
  float len = length(axis);
  vec3 dir = axis / max(len, 1e-5);
  vec3 p = uStart + axis * aAlong;
  // A ribbon that always faces this eye.
  vec3 toCam = cameraPosition - p;
  float camDist = length(toCam);
  vec3 side = cross(dir, toCam / max(camDist, 1e-5));
  float sl = length(side);
  side = sl > 1e-4 ? side / sl : vec3(0.0, 1.0, 0.0);
  float w = max(${HALF_WIDTH}, camDist * ${MIN_ANGLE});
  vThin = ${HALF_WIDTH} / w; // widened far away to stay visible, so dimmed to match
  vSide = aSide;
  vDist = aAlong * len;
  gl_Position = projectionMatrix * viewMatrix * vec4(p + side * aSide * w, 1.0);
}`;

const fragment = /* glsl */ `
uniform vec3 uColor;
uniform float uLevel;
uniform float uLength;
uniform float uHit;
uniform float uTime;
varying float vSide;
varying float vDist;
varying float vThin;
void main() {
  float x = abs(vSide);
  float core = exp(-x * x * 5.0);
  float glow = exp(-x * x * 1.5) * 0.4;
  // Brightest at the emitter, fading out into the air.
  float fade = exp(-vDist / ${FADE.toFixed(1)});
  // Dust drifting through the beam.
  float motes = 0.78 + 0.22 * sin(vDist * 23.0 - uTime * 2.3) * sin(vDist * 7.3 + uTime * 1.1);
  float start = smoothstep(0.0, 0.02, vDist);
  float end = mix(1.0 - smoothstep(uLength * 0.6, uLength, vDist), 1.0, uHit);
  float a = (core + glow) * fade * motes * start * end * uLevel * mix(0.3, 1.0, vThin);
  // Premultiplied: the beam adds red light and also covers a little of what's behind,
  // so it still reads against a bright sunset sky (pure additive red would vanish there).
  gl_FragColor = vec4(uColor * a, a * 0.85);
}`;

function dotTexture(): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  // Drawn with (ONE, ONE_MINUS_SRC_ALPHA): solid red core that covers the surface, a halo that mostly adds light.
  // The halo's colour is darker than its coverage would suggest, so it glows rather than paints.
  grad.addColorStop(0, 'rgba(255,240,235,1)');
  grad.addColorStop(0.14, 'rgba(255,60,60,1)');
  grad.addColorStop(0.26, 'rgba(200,10,20,0.6)');
  grad.addColorStop(0.5, 'rgba(90,0,8,0.12)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}

export type LaserHitKind = 'none' | 'target' | 'balloon' | 'world';

const _end = new Vector3();
const _head = new Vector3();
const _toEye = new Vector3();

/**
 * The bow's laser sight: a thin red beam, bright at the bow and fading into the
 * air within a few tens of metres, and a dot wherever it lands. The beam is for
 * the eyes only; the dot is real, so the scope sees it too.
 */
export class BowLaser {
  readonly beam: Mesh;
  readonly dot: Sprite;
  /** 0..1: fades in when the bow is in hand and the laser is on. */
  level = 0;
  readonly hit = { kind: 'none' as LaserHitKind, id: '', distance: 0, point: new Vector3() };
  /** This frame's beam (world). */
  readonly origin = new Vector3();
  readonly dir = new Vector3();
  private readonly uniforms = {
    uStart: { value: new Vector3() },
    uEnd: { value: new Vector3() },
    uColor: { value: new Color(1, 0.09, 0.12) },
    uLevel: { value: 0 },
    uLength: { value: 1 },
    uHit: { value: 0 },
    uTime: { value: 0 },
  };

  constructor(private readonly app: App) {
    const n = SEGMENTS + 1;
    const along = new Float32Array(n * 2);
    const side = new Float32Array(n * 2);
    const pos = new Float32Array(n * 2 * 3); // unused by the shader, but three wants positions
    for (let i = 0; i < n; i++) {
      // Denser near the bow, where the width changes fastest.
      const a = Math.pow(i / SEGMENTS, 2.2);
      along.set([a, a], i * 2);
      side.set([-1, 1], i * 2);
    }
    const index: number[] = [];
    for (let i = 0; i < SEGMENTS; i++) {
      const k = i * 2;
      index.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
    }
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(pos, 3));
    geo.setAttribute('aAlong', new BufferAttribute(along, 1));
    geo.setAttribute('aSide', new BufferAttribute(side, 1));
    geo.setIndex(index);
    this.beam = new Mesh(
      geo,
      new ShaderMaterial({
        vertexShader: vertex,
        fragmentShader: fragment,
        uniforms: this.uniforms,
        transparent: true,
        depthWrite: false,
        blending: CustomBlending,
        blendSrc: OneFactor,
        blendDst: OneMinusSrcAlphaFactor,
        side: DoubleSide,
      }),
    );
    this.beam.name = 'laser-beam';
    this.beam.frustumCulled = false;
    this.beam.visible = false;
    this.beam.renderOrder = 6;
    this.beam.layers.set(EYES_ONLY_LAYER);

    this.dot = new Sprite(
      new SpriteMaterial({ map: dotTexture(), blending: CustomBlending, blendSrc: OneFactor, blendDst: OneMinusSrcAlphaFactor, depthWrite: false, transparent: true, toneMapped: false, fog: false }),
    );
    this.dot.name = 'laser-dot';
    this.dot.visible = false;
    this.dot.renderOrder = 7;
    app.scene.add(this.beam, this.dot);
  }

  /** Aim the beam from `origin` along `dir` (world). `on` fades it in or out. */
  update(dt: number, on: boolean, origin: Vector3, dir: Vector3, time: number): void {
    this.level = on ? Math.min(1, this.level + dt / 0.25) : Math.max(0, this.level - dt / 0.35);
    this.origin.copy(origin);
    this.dir.copy(dir);
    const show = this.level > 0.001;
    this.beam.visible = show;
    this.dot.visible = false;
    this.hit.kind = 'none';
    this.hit.id = '';
    if (!show) return;

    // What does it land on? Targets and balloons (analytic), then the world and loose props.
    let dist = MAX_RANGE;
    const far = _end.copy(origin).addScaledVector(dir, MAX_RANGE);
    const rh = this.app.range.raycast(origin, far);
    if (rh) {
      dist = rh.t * MAX_RANGE;
      this.hit.kind = rh.kind;
      this.hit.id = rh.kind === 'target' ? rh.target!.id : rh.balloon!.id;
    }
    const wh = this.app.physics.castSolid(origin, dir, dist, true);
    if (wh && wh.dist < dist) {
      dist = wh.dist;
      this.hit.kind = 'world';
      this.hit.id = this.app.physics.propByCollider.get(wh.collider.handle)?.id ?? 'scenery';
    }
    this.hit.distance = dist;
    this.hit.point.copy(origin).addScaledVector(dir, dist);

    const u = this.uniforms;
    u.uStart.value.copy(origin);
    u.uEnd.value.copy(this.hit.point);
    u.uLength.value = dist;
    u.uHit.value = this.hit.kind === 'none' ? 0 : 1;
    u.uLevel.value = this.level;
    u.uTime.value = time;

    if (this.hit.kind !== 'none') {
      // A constant apparent size, pulled a touch toward the viewer so the surface doesn't clip it.
      const head = this.app.headPosition(_head);
      const toEye = _toEye.subVectors(head, this.hit.point);
      const eyeDist = toEye.length();
      this.dot.position.copy(this.hit.point).addScaledVector(toEye.multiplyScalar(1 / Math.max(eyeDist, 1e-4)), Math.min(0.04, eyeDist * 0.004));
      this.dot.scale.setScalar(Math.max(0.012, eyeDist * 0.011));
      // (ONE, ONE_MINUS_SRC_ALPHA) blending: fade both the light and the coverage.
      this.dot.material.color.setScalar(this.level);
      this.dot.material.opacity = this.level;
      this.dot.visible = true;
    }
  }
}
