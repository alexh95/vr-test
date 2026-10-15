import {
  CircleGeometry,
  Color,
  HalfFloatType,
  Matrix3,
  Matrix4,
  Mesh,
  PerspectiveCamera,
  ShaderMaterial,
  Vector3,
  WebGLRenderTarget,
} from 'three';
import type { App } from '../app';

/** Objects on this layer are seen by the player's eyes but not by the scope camera (the lens itself). */
export const EYES_ONLY_LAYER = 3;

const vertex = /* glsl */ `
varying vec3 vLocal;
void main() {
  vLocal = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const fragment = /* glsl */ `
uniform sampler2D uMap;
uniform float uTanFov;
uniform float uMag;
uniform float uRear;
uniform float uFront;
uniform float uTube;
uniform float uDotR;
uniform float uActive;
uniform float uTime;
uniform mat4 uLensInv;
uniform mat3 uLensRot;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uSunDir;
uniform vec3 uDotColor;
varying vec3 vLocal;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}

void main() {
  // This eye, in the lens frame (lens plane z = 0, scope looks down -z, eye at +z).
  vec3 eye = (uLensInv * vec4(cameraPosition, 1.0)).xyz;
  vec3 p = vLocal;
  vec3 v = p - eye;
  vec3 vd = normalize(v);
  // The view direction as a tangent. Sampling by direction (not by position on the
  // glass) puts the image at infinity: it doesn't swim as your head moves, and each
  // eye gets its own correct view.
  vec2 t = v.xy / max(-v.z, 1e-4);

  // Tube vignetting: the ray must also clear the front aperture, uTube ahead of the
  // lens. Off-axis eyes get the dark crescent of a real scope's shadow.
  vec2 q = p.xy + t * uTube;
  float rN = length(p.xy) / uRear;
  float rear = 1.0 - smoothstep(0.93, 1.0, rN);
  float front = 1.0 - smoothstep(uFront * 0.84, uFront, length(q));
  float shadow = rear * front * step(0.0, -v.z);

  // Magnified scene: a ray at angle t off the axis sees the world at t / M.
  vec2 tw = t / uMag;
  float rn = length(tw) / uTanFov;
  vec2 twd = tw * (1.0 + 0.07 * rn * rn);
  float ca = 0.004 + 0.02 * rn * rn;
  vec2 uvG = 0.5 + 0.5 * twd / uTanFov;
  vec2 uvR = 0.5 + 0.5 * twd * (1.0 + ca) / uTanFov;
  vec2 uvB = 0.5 + 0.5 * twd * (1.0 - ca) / uTanFov;
  vec3 img = vec3(texture2D(uMap, uvR).r, texture2D(uMap, uvG).g, texture2D(uMap, uvB).b);
  img *= vec3(0.93, 0.97, 0.955) * mix(1.0, 0.7, clamp(rn * rn, 0.0, 1.0));
  img *= uActive;

  // Dust and smudges belong to the glass, not to the picture.
  float dust = smoothstep(0.8, 0.93, vnoise(p.xy * 900.0)) * 0.5 + smoothstep(0.9, 0.97, vnoise(p.xy * 2600.0 + 7.0));
  float smudge = smoothstep(0.55, 0.85, vnoise(p.xy * 120.0 + 3.0)) * 0.12;
  img *= 1.0 - 0.3 * dust - smudge;

  // Illuminated red dot, on the optical axis at infinity: wherever your eye is, it marks
  // where the scope points. It's composited after tone mapping (below) so it stays a
  // saturated red instead of blooming to white like an HDR red would.
  float dd = length(t) / uDotR;
  float core = smoothstep(1.0, 0.55, dd) * shadow;
  float halo = exp(-dd * dd * 0.12) * 0.35 * shadow;
  float star = pow(max(0.0, 1.0 - min(abs(t.x), abs(t.y)) / (uDotR * 0.16)), 3.0) * exp(-dd * 0.35) * 0.18 * shadow;

  // Glass reflections: Fresnel sky, the sun glinting, and a coating sheen that slides as you move.
  float cosT = clamp(-vd.z, 0.0, 1.0);
  float fres = 0.03 + 0.97 * pow(1.0 - cosT, 5.0);
  vec3 r = normalize(uLensRot * reflect(vd, vec3(0.0, 0.0, 1.0)));
  vec3 sky = mix(uHorizon, uZenith, clamp(r.y * 1.4, 0.0, 1.0));
  float glint = pow(max(dot(r, uSunDir), 0.0), 80.0) * 4.0;
  float s = (p.x + p.y) / uRear * 0.7 + (t.x + t.y) * 7.0 + sin(uTime * 0.15) * 0.1;
  float band = exp(-s * s * 5.0);
  vec3 coat = (vec3(0.42, 0.22, 0.75) * 0.05 + vec3(0.18, 0.55, 0.32) * 0.025) * band;

  // A thin ring where light catches the edge of the glass.
  float ring = smoothstep(0.86, 0.95, rN) * (1.0 - smoothstep(0.95, 1.0, rN));
  vec3 rim = vec3(0.6, 0.45, 0.85) * ring * 0.1;

  vec3 col = img * shadow * (1.0 - fres) + (sky * 0.45 + glint) * fres + coat + rim;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  gl_FragColor.rgb = mix(gl_FragColor.rgb, uDotColor, clamp(core + star, 0.0, 1.0)) + uDotColor * halo * (1.0 - core);
  #include <colorspace_fragment>
}`;

export interface ScopeSpec {
  /** Rear lens radius (m). */
  rear: number;
  /** Front aperture radius (m). */
  front: number;
  /** Tube length between the apertures (m). */
  tube: number;
  magnification: number;
}

const _e = new Vector3();
const _s = new Vector3();
const _fwd = new Vector3();

/**
 * A magnifying sight with picture-in-picture rendering. A second camera at the
 * lens renders a narrow, magnified view into a texture once per frame (mono, at
 * a few hundred pixels: cheap); the lens shader turns that into what a real
 * scope looks like from wherever each eye is.
 */
export class Scope {
  readonly lens: Mesh;
  readonly camera: PerspectiveCamera;
  readonly target: WebGLRenderTarget;
  readonly uniforms = {
    uMap: { value: null as unknown as WebGLRenderTarget['texture'] },
    uTanFov: { value: 0.05 },
    uMag: { value: 2 },
    uRear: { value: 0.03 },
    uFront: { value: 0.032 },
    uTube: { value: 0.07 },
    uDotR: { value: 0.0032 },
    uActive: { value: 0 },
    uTime: { value: 0 },
    uLensInv: { value: new Matrix4() },
    uLensRot: { value: new Matrix3() },
    uZenith: { value: new Color() },
    uHorizon: { value: new Color() },
    uSunDir: { value: new Vector3(0, 1, 0) },
    uDotColor: { value: new Color(1, 0.02, 0.015) },
  };
  renders = 0;
  private readonly inv = new Matrix4();

  constructor(spec: ScopeSpec, quality: 'high' | 'low') {
    const size = quality === 'high' ? 512 : 384;
    this.target = new WebGLRenderTarget(size, size, { type: HalfFloatType, samples: quality === 'high' ? 4 : 0 });
    this.target.texture.name = 'scope-view';
    this.camera = new PerspectiveCamera(5, 1, 0.08, 1500);
    const u = this.uniforms;
    u.uMap.value = this.target.texture;
    u.uMag.value = spec.magnification;
    u.uRear.value = spec.rear;
    u.uFront.value = spec.front;
    u.uTube.value = spec.tube;
    this.lens = new Mesh(new CircleGeometry(spec.rear, 48), new ShaderMaterial({ vertexShader: vertex, fragmentShader: fragment, uniforms: u }));
    this.lens.name = 'scope-lens';
    this.lens.layers.set(EYES_ONLY_LAYER);
  }

  /** Night dims the dot (and keeps it from blooming out the view). */
  setLook(zenith: Color, horizon: Color, sunDir: Vector3, glow: number): void {
    this.uniforms.uZenith.value.copy(zenith);
    this.uniforms.uHorizon.value.copy(horizon);
    this.uniforms.uSunDir.value.copy(sunDir);
    // Display-space colour (after tone mapping): bright by day, dimmed at night.
    this.uniforms.uDotColor.value.setRGB(1, 0.02, 0.015).multiplyScalar(glow > 1.5 ? 0.7 : 1);
  }

  /**
   * Render the magnified view for an eye at `head` (world). Skipped when the lens
   * faces away from the player or is off to the side of their view.
   */
  render(app: App, head: Vector3, headForward: Vector3 | null, time: number): boolean {
    const u = this.uniforms;
    u.uTime.value = time;
    const lens = this.lens;
    lens.updateWorldMatrix(true, false);
    this.inv.copy(lens.matrixWorld).invert();
    u.uLensInv.value.copy(this.inv);
    u.uLensRot.value.setFromMatrix4(lens.matrixWorld);
    const e = _e.copy(head).applyMatrix4(this.inv);
    const lensPos = _s.setFromMatrixPosition(lens.matrixWorld);
    const toLens = lensPos.sub(head);
    const dist = toLens.length();
    const inView = !headForward || toLens.dot(headForward) > dist * 0.35;
    if (e.z < 0.03 || e.z > 2.5 || !inView) {
      u.uActive.value = 0;
      return false;
    }
    // Render just wide enough for what the lens can show from here (both eyes,
    // including IPD and some off-axis slack), so the texture is used efficiently.
    const off = Math.hypot(e.x, e.y);
    const tanHalf = Math.min(0.7, ((u.uRear.value + off + 0.04) / e.z / u.uMag.value) * 1.08);
    const cam = this.camera;
    cam.fov = (2 * Math.atan(tanHalf) * 180) / Math.PI;
    cam.updateProjectionMatrix();
    lens.matrixWorld.decompose(cam.position, cam.quaternion, _s);
    cam.updateMatrixWorld(true);
    u.uTanFov.value = tanHalf;

    // The Reflector pattern: render to our target from inside the XR frame.
    const r = app.renderer;
    const prevTarget = r.getRenderTarget();
    const xrEnabled = r.xr.enabled;
    const shadowAuto = r.shadowMap.autoUpdate;
    r.xr.enabled = false;
    r.shadowMap.autoUpdate = false; // reuse this frame's shadow map
    r.setRenderTarget(this.target);
    r.clear();
    r.render(app.scene, cam);
    r.setRenderTarget(prevTarget);
    r.xr.enabled = xrEnabled;
    r.shadowMap.autoUpdate = shadowAuto;
    u.uActive.value = 1;
    this.renders++;
    return true;
  }

  /** Optical axis direction (world). */
  axis(out: Vector3): Vector3 {
    return out.set(0, 0, -1).transformDirection(this.lens.matrixWorld);
  }

  get forward(): Vector3 {
    return this.axis(_fwd);
  }
}
