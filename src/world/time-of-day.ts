import { Color, DirectionalLight, FogExp2, HemisphereLight, Object3D, Vector3 } from 'three';
import { smoothstep } from '../core/math';
import type { Sky } from './sky';

export type TimeName = 'sunset' | 'night' | 'day';

interface Preset {
  zenith: Color;
  horizon: Color;
  under: Color;
  sunDir: Vector3; // direction of the key light (sun or moon)
  skySunDir: Vector3; // where the sun disc is drawn
  sunColor: Color; // disc colour in the sky shader
  keyColor: Color;
  keyIntensity: number;
  hemiSky: Color;
  hemiGround: Color;
  hemiIntensity: number;
  fog: Color;
  fogDensity: number;
  stars: number;
  aurora: number;
  moon: number;
  cloudLit: Color;
  cloudShade: Color;
  glow: number; // emissive multiplier for crystals, orbs, …
  night: number;
}

const c = (hex: number) => new Color(hex);
const dir = (x: number, y: number, z: number) => new Vector3(x, y, z).normalize();

const PRESETS: Record<TimeName, Preset> = {
  sunset: {
    zenith: c(0x1b2556),
    horizon: c(0xff9457),
    under: c(0xb98393),
    // The key light sits higher than the visible sun so trees don't shade the whole play area.
    sunDir: dir(0.3, 0.62, -1),
    skySunDir: dir(0.3, 0.07, -1),
    sunColor: c(0xffa65c),
    keyColor: c(0xffb070),
    keyIntensity: 2.6,
    hemiSky: c(0x8d97d6),
    hemiGround: c(0x6b4636),
    hemiIntensity: 1.0,
    fog: c(0xd8957c),
    fogDensity: 0.0065,
    stars: 0.18,
    aurora: 0,
    moon: 0,
    cloudLit: c(0xffc9a8),
    cloudShade: c(0x8a6584),
    glow: 0.9,
    night: 0.25,
  },
  night: {
    zenith: c(0x03060f),
    horizon: c(0x16284a),
    under: c(0x0f1830),
    sunDir: dir(-0.45, 0.6, -0.65),
    skySunDir: dir(0.3, -0.4, -1),
    sunColor: c(0x000000),
    keyColor: c(0x8fa8ff),
    keyIntensity: 0.75,
    hemiSky: c(0x3a4f8c),
    hemiGround: c(0x141626),
    hemiIntensity: 0.7,
    fog: c(0x13203a),
    fogDensity: 0.0055,
    stars: 1,
    aurora: 1,
    moon: 1,
    cloudLit: c(0x3f4e7c),
    cloudShade: c(0x10162a),
    glow: 2.4,
    night: 1,
  },
  day: {
    zenith: c(0x2c66d1),
    horizon: c(0xaed6ff),
    under: c(0xdde8f4),
    sunDir: dir(0.35, 0.85, -0.4),
    skySunDir: dir(0.35, 0.85, -0.4),
    sunColor: c(0xfff1d6),
    keyColor: c(0xfff3e2),
    keyIntensity: 3.0,
    hemiSky: c(0xc3e2ff),
    hemiGround: c(0x7b6a4e),
    hemiIntensity: 1.2,
    fog: c(0xcfe2f4),
    fogDensity: 0.0042,
    stars: 0,
    aurora: 0,
    moon: 0,
    cloudLit: c(0xffffff),
    cloudShade: c(0xb3c3d8),
    glow: 0.45,
    night: 0,
  },
};

export const TIME_ORDER: TimeName[] = ['sunset', 'night', 'day'];

function clonePreset(p: Preset): Preset {
  const out = {} as Record<string, unknown>;
  for (const [k, v] of Object.entries(p)) out[k] = typeof v === 'number' ? v : (v as Color | Vector3).clone();
  return out as unknown as Preset;
}

function mixPreset(a: Preset, b: Preset, t: number, out: Preset): void {
  for (const k of Object.keys(out) as (keyof Preset)[]) {
    const va = a[k];
    const vb = b[k];
    if (typeof va === 'number') (out[k] as number) = va + ((vb as number) - va) * t;
    else if (va instanceof Color) (out[k] as Color).lerpColors(va, vb as Color, t);
    else (out[k] as Vector3).lerpVectors(va as Vector3, vb as Vector3, t).normalize();
  }
}

/** Owns the lights and fog and blends every look-related value between presets. */
export class TimeOfDay {
  name: TimeName;
  readonly hemi: HemisphereLight;
  readonly key: DirectionalLight;
  readonly fog: FogExp2;
  readonly current: Preset;
  private from: Preset;
  private to: Preset;
  private t = 1;
  private duration = 3.5;
  private readonly listeners = new Set<(p: Readonly<Preset>) => void>();

  constructor(
    private readonly sky: Sky,
    initial: TimeName,
    shadowTarget: Object3D,
  ) {
    this.name = initial;
    this.current = clonePreset(PRESETS[initial]);
    this.from = PRESETS[initial];
    this.to = PRESETS[initial];
    this.hemi = new HemisphereLight(0xffffff, 0x444444, 1);
    this.key = new DirectionalLight(0xffffff, 2);
    this.key.target = shadowTarget;
    this.fog = new FogExp2(0xffffff, 0.005);
    this.apply();
  }

  /** Fade to a preset over `seconds`. */
  set(name: TimeName, seconds = 3.5): void {
    if (name === this.name && this.t >= 1) return;
    this.from = clonePreset(this.current);
    this.to = PRESETS[name];
    this.name = name;
    this.t = seconds <= 0 ? 1 : 0;
    this.duration = Math.max(seconds, 0.001);
    if (seconds <= 0) {
      mixPreset(this.from, this.to, 1, this.current);
      this.apply();
    }
  }

  next(): TimeName {
    const i = TIME_ORDER.indexOf(this.name);
    const n = TIME_ORDER[(i + 1) % TIME_ORDER.length];
    this.set(n);
    return n;
  }

  onChange(fn: (p: Readonly<Preset>) => void): void {
    this.listeners.add(fn);
    fn(this.current);
  }

  get night(): number {
    return this.current.night;
  }

  get glow(): number {
    return this.current.glow;
  }

  update(dt: number): void {
    if (this.t >= 1) return;
    this.t = Math.min(1, this.t + dt / this.duration);
    mixPreset(this.from, this.to, smoothstep(0, 1, this.t), this.current);
    this.apply();
  }

  private apply(): void {
    const p = this.current;
    const u = this.sky.uniforms;
    u.uZenith.value.copy(p.zenith);
    u.uHorizon.value.copy(p.horizon);
    u.uUnder.value.copy(p.under);
    u.uSunDir.value.copy(p.skySunDir);
    u.uSunColor.value.copy(p.sunColor);
    u.uStars.value = p.stars;
    u.uAurora.value = p.aurora;
    u.uMoon.value = p.moon;
    u.uMoonDir.value.copy(p.sunDir);
    this.hemi.color.copy(p.hemiSky);
    this.hemi.groundColor.copy(p.hemiGround);
    this.hemi.intensity = p.hemiIntensity;
    this.key.color.copy(p.keyColor);
    this.key.intensity = p.keyIntensity;
    this.key.position.copy(this.key.target.position).addScaledVector(p.sunDir, 40);
    this.fog.color.copy(p.fog);
    this.fog.density = p.fogDensity;
    this.listeners.forEach((l) => l(p));
  }
}

export type { Preset };
