import { BackSide, Color, Mesh, ShaderMaterial, SphereGeometry, Vector3, type Camera } from 'three';

const vertex = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = (modelMatrix * vec4(position, 0.0)).xyz;
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww; // pin to the far plane
}`;

const fragment = /* glsl */ `
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uUnder;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uMoonDir;
uniform float uSunSize;
uniform float uStars;
uniform float uAurora;
uniform float uMoon;
uniform float uTime;
varying vec3 vDir;

float h12(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
float vn2(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(h12(i), h12(i + vec2(1, 0)), u.x), mix(h12(i + vec2(0, 1)), h12(i + vec2(1, 1)), u.x), u.y);
}

float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}

void main() {
  vec3 d = normalize(vDir);
  float h = d.y;
  float t = pow(clamp(h, 0.0, 1.0), 0.42);
  vec3 col = mix(uHorizon, uZenith, t);
  col = mix(col, uUnder, smoothstep(0.0, -0.22, h));

  // Sun: wide warm glow, tight halo, HDR disc (tone mapping rolls it off).
  float sd = max(dot(d, uSunDir), 0.0);
  col += uSunColor * (pow(sd, 5.0) * 0.22 + pow(sd, 60.0) * 0.55);
  col += uSunColor * smoothstep(1.0 - uSunSize, 1.0 - uSunSize * 0.55, sd) * 7.0;
  // Haze band at the horizon.
  col += uHorizon * 0.18 * exp(-abs(h) * 16.0);

  // Stars: hashed cells on a sphere, twinkling.
  if (uStars > 0.01 && h > -0.02) {
    vec3 p = d * 170.0;
    vec3 cell = floor(p);
    vec3 f = fract(p) - 0.5;
    float r = hash13(cell);
    float star = step(0.982, r) * smoothstep(0.18, 0.0, length(f));
    float tw = 0.65 + 0.35 * sin(uTime * (1.5 + r * 4.0) + r * 60.0);
    vec3 sc = mix(vec3(0.75, 0.82, 1.0), vec3(1.0, 0.86, 0.7), fract(r * 37.0));
    col += sc * star * tw * uStars * 2.2 * smoothstep(-0.02, 0.2, h);
  }

  // Aurora curtains: irregular rays from 1D noise, a wavy lower hem, fading out overhead.
  if (uAurora > 0.01 && h > 0.04) {
    float az = atan(d.x, d.z);
    float wave = sin(az * 3.0 + uTime * 0.05 + sin(az * 7.0 - uTime * 0.09) * 0.7);
    float hem = 0.1 + 0.06 * sin(az * 5.0 + uTime * 0.07);
    float elev = smoothstep(hem, hem + 0.18, h) * smoothstep(0.7, 0.32, h);
    float curtain = pow(0.5 + 0.5 * wave, 4.0) * elev;
    // Noise sampled around a circle: periodic in azimuth, so there's no seam where atan wraps.
    vec2 ring = vec2(cos(az), sin(az));
    float rays = 0.3 + 0.7 * (vn2(ring * 7.5 + vec2(uTime * 0.02, 0.0)) * 0.65 + vn2(ring * 20.5 - vec2(0.0, uTime * 0.015)) * 0.35);
    vec3 ac = mix(vec3(0.15, 1.0, 0.55), vec3(0.65, 0.25, 1.0), smoothstep(hem + 0.05, 0.6, h));
    col += ac * curtain * rays * uAurora * 0.65;
  }

  // Moon.
  float md = dot(d, uMoonDir);
  col += vec3(0.95, 0.96, 1.0) * smoothstep(0.99935, 0.99965, md) * uMoon * 2.0;
  col += vec3(0.45, 0.5, 0.7) * pow(max(md, 0.0), 180.0) * uMoon * 0.35;

  // Dither against banding in the long gradients.
  col += (hash13(vec3(gl_FragCoord.xy, uTime * 60.0)) - 0.5) / 180.0;
  gl_FragColor = vec4(max(col, 0.0), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export class Sky {
  readonly mesh: Mesh;
  readonly uniforms = {
    uZenith: { value: new Color() },
    uHorizon: { value: new Color() },
    uUnder: { value: new Color() },
    uSunDir: { value: new Vector3(0, 0.1, -1).normalize() },
    uSunColor: { value: new Color() },
    uMoonDir: { value: new Vector3(0, 0.5, 1).normalize() },
    uSunSize: { value: 0.0004 },
    uStars: { value: 0 },
    uAurora: { value: 0 },
    uMoon: { value: 0 },
    uTime: { value: 0 },
  };

  constructor() {
    const mat = new ShaderMaterial({
      vertexShader: vertex,
      fragmentShader: fragment,
      uniforms: this.uniforms,
      side: BackSide,
      depthWrite: false,
      fog: false,
    });
    this.mesh = new Mesh(new SphereGeometry(900, 48, 24), mat);
    this.mesh.name = 'sky';
    this.mesh.renderOrder = -1000;
    this.mesh.frustumCulled = false;
  }

  update(camera: Camera, time: number): void {
    camera.getWorldPosition(this.mesh.position);
    this.uniforms.uTime.value = time;
  }
}
