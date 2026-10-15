import { BufferAttribute, BufferGeometry, LineBasicMaterial, LineLoop, Vector3, type Group } from 'three';

/**
 * Draws the room-scale boundary (SteamVR chaperone) on the virtual floor when
 * the runtime exposes 'bounded-floor', so you can see where you can walk for real.
 */
export class PlayArea {
  private line: LineLoop | null = null;
  private pending: XRBoundedReferenceSpace | null = null;

  constructor(private readonly rig: Group) {}

  /** Call when a session starts. */
  setSpace(space: XRBoundedReferenceSpace | null): void {
    this.clear();
    this.pending = space;
  }

  /** Resolve the bounds into the app's reference space on the first frame we can. */
  update(frame: XRFrame, refSpace: XRReferenceSpace): void {
    const space = this.pending;
    if (!space) return;
    const pose = frame.getPose(space, refSpace);
    if (!pose) return;
    this.pending = null;
    const m = pose.transform.matrix;
    const pts: number[] = [];
    for (const p of space.boundsGeometry) {
      const v = new Vector3(p.x, 0.012, p.z);
      // Apply the bounded→local-floor transform (column-major).
      const x = m[0] * v.x + m[4] * v.y + m[8] * v.z + m[12];
      const y = m[1] * v.x + m[5] * v.y + m[9] * v.z + m[13];
      const z = m[2] * v.x + m[6] * v.y + m[10] * v.z + m[14];
      pts.push(x, y, z);
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(pts), 3));
    this.line = new LineLoop(g, new LineBasicMaterial({ color: 0x7fe8ff, transparent: true, opacity: 0.35, toneMapped: false }));
    this.line.name = 'play-area';
    this.line.frustumCulled = false;
    this.rig.add(this.line);
  }

  get points(): number {
    return this.line ? this.line.geometry.getAttribute('position').count : 0;
  }

  clear(): void {
    this.pending = null;
    if (this.line) {
      this.line.removeFromParent();
      this.line.geometry.dispose();
      this.line = null;
    }
  }
}
