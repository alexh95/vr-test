import { AmbientLight, type Color, Object3D, PointLight, SpotLight, Vector3, type Scene } from 'three';
import { clamp, DEG, smoothstep } from '../core/math';

/** Something burning that should light the world this frame. */
export interface LightEmitter {
  pos: Vector3;
  color: Color;
  /** Luminous intensity (three's physical units: candela, inverse-square falloff). */
  intensity: number;
  /** Hanging high under a parachute: the shadow-casting spotlight goes to the brightest of these. */
  overhead: boolean;
}

const POINTS = 3;
const _feet = new Vector3();

/**
 * A fixed pool of lights handed to the brightest flares each frame. The number
 * of lights never changes (only their intensities), so materials never need to
 * recompile when a flare appears; lights nobody uses sit at zero.
 *
 * - One spotlight pointing straight down from a parachute flare casts shadows
 *   (trees, the boat and you swing as the flare sways). Its shadow map only
 *   renders while it's in use.
 * - Three point lights for the rest (stars, flares burning on the ground).
 * - A faint ambient term for light scattered by the haze around you.
 */
export class FlareLights {
  readonly spot: SpotLight;
  readonly points: PointLight[] = [];
  readonly ambient = new AmbientLight(0x000000, 1);
  private readonly target = new Object3D();
  /** The brightest emitters, for things that light themselves (the cloud sea). */
  readonly strongest: LightEmitter[] = [];
  private readonly ranked: LightEmitter[] = [];

  constructor(scene: Scene, shadows: boolean) {
    this.spot = new SpotLight(0xffffff, 0, 0, 62 * DEG, 0.55, 2);
    this.spot.name = 'flare-spot';
    this.spot.target = this.target;
    this.spot.castShadow = shadows;
    const sh = this.spot.shadow;
    sh.mapSize.set(2048, 2048);
    sh.camera.near = 1;
    sh.camera.far = 320;
    sh.bias = -0.0006;
    sh.normalBias = 0.04;
    sh.autoUpdate = false;
    sh.needsUpdate = true; // render it once so the map exists before the first flare
    scene.add(this.spot, this.target, this.ambient);
    for (let i = 0; i < POINTS; i++) {
      const p = new PointLight(0xffffff, 0, 0, 2);
      p.name = `flare-point-${i}`;
      scene.add(p);
      this.points.push(p);
    }
  }

  assign(emitters: readonly LightEmitter[], eye: Vector3): void {
    const spot = this.spot;
    let overhead: LightEmitter | null = null;
    for (const e of emitters) if (e.overhead && (!overhead || e.intensity > overhead.intensity)) overhead = e;
    if (overhead) {
      const p = overhead.pos;
      spot.position.copy(p);
      // Straight down when it's overhead; leaning toward you when it's far off to
      // the side, so wherever you are, the flare lights (and shadows) your surroundings.
      const feet = _feet.set(eye.x, eye.y - 1.5, eye.z);
      const h = Math.max(5, p.y - feet.y);
      const lean = smoothstep(0.4, 1.3, Math.hypot(p.x - feet.x, p.z - feet.z) / h);
      this.target.position.set(p.x, p.y - 40, p.z).lerp(feet, lean);
      spot.color.copy(overhead.color);
      spot.intensity = overhead.intensity;
      spot.shadow.autoUpdate = spot.castShadow;
      // Perspective depth precision falls off with distance: keep the near plane
      // as far out as the flare's reach allows, and scale the bias with it, or
      // anything shorter than a few metres stops casting a shadow from 80 m up.
      const reach = h + (p.distanceTo(feet) - h) * lean;
      const cam = spot.shadow.camera;
      const near = clamp(reach * 0.33, 1.5, 26);
      if (Math.abs(cam.near - near) > 0.25) {
        cam.near = near;
        cam.updateProjectionMatrix();
      }
      spot.shadow.bias = -0.03 / reach;
    } else {
      spot.intensity = 0;
      spot.shadow.autoUpdate = false;
    }

    // The rest by how much light they throw around the player.
    const ranked = this.ranked;
    ranked.length = 0;
    for (const e of emitters) if (e !== overhead) ranked.push(e);
    const score = (e: LightEmitter) => e.intensity / (e.pos.distanceToSquared(eye) + 400);
    ranked.sort((a, b) => score(b) - score(a));
    for (let i = 0; i < POINTS; i++) {
      const p = this.points[i];
      const e = ranked[i];
      if (e) {
        p.position.copy(e.pos);
        p.color.copy(e.color);
        p.intensity = e.intensity;
      } else p.intensity = 0;
    }

    // Light scattered back by the haze and the clouds: a faint lift in the flare's colour.
    const amb = this.ambient.color.setRGB(0, 0, 0);
    for (const e of emitters) {
      const k = Math.min(0.12, (e.intensity * 0.01) / (e.pos.distanceToSquared(eye) + 1500));
      amb.r += e.color.r * k;
      amb.g += e.color.g * k;
      amb.b += e.color.b * k;
    }
    amb.r = Math.min(amb.r, 0.22);
    amb.g = Math.min(amb.g, 0.22);
    amb.b = Math.min(amb.b, 0.22);

    const strongest = this.strongest;
    strongest.length = 0;
    strongest.push(...emitters);
    strongest.sort((a, b) => b.intensity - a.intensity);
    strongest.length = Math.min(strongest.length, 2);
  }

  /** Everything off (reset). */
  clear(): void {
    this.assign([], new Vector3());
  }
}
