import { type Mesh, type Object3D, Vector3 } from 'three';

const _s = new Vector3();
const _p = new Vector3();

/**
 * Small-object culling. Every visible mesh is a draw call, and seen from far away (the
 * perch, the boat, a glider, a portal's view) most of the island's toys, labels and
 * station parts are a pixel or two. Before a pass, hide the small meshes whose radius over
 * distance is under a threshold; after it, put them back.
 */
export class DetailCuller {
  private items: { o: Mesh; r: number }[] = [];
  private collectedAt = -Infinity;
  private readonly hidden: Object3D[] = [];

  constructor(private readonly root: Object3D) {}

  /** Hide the small meshes that would look smaller than `angle` (radius / distance, radians) from `eye`. */
  hide(eye: Vector3, angle: number, time: number): void {
    // Things come and go (props, flares): look again every few seconds.
    if (time - this.collectedAt > 5 || time < this.collectedAt) this.collect(time);
    for (const it of this.items) {
      if (!it.o.visible) continue;
      _p.setFromMatrixPosition(it.o.matrixWorld);
      if (it.r < _p.distanceTo(eye) * angle) {
        it.o.visible = false;
        this.hidden.push(it.o);
      }
    }
  }

  /** Put back what `hide` took away. */
  restore(): void {
    for (const o of this.hidden) o.visible = true;
    this.hidden.length = 0;
  }

  get count(): number {
    return this.items.length;
  }

  private collect(time: number): void {
    this.collectedAt = time;
    this.items = [];
    this.root.traverse((o) => {
      const m = o as Mesh;
      // Ordinary meshes only: instanced meshes are many things at once, and anything that
      // opts out of frustum culling (overlays, the sky, fast movers) knows better.
      if (!m.isMesh || (m as Mesh & { isInstancedMesh?: boolean }).isInstancedMesh || !m.frustumCulled) return;
      const g = m.geometry;
      if (!g.boundingSphere) g.computeBoundingSphere();
      m.getWorldScale(_s);
      const r = g.boundingSphere!.radius * Math.max(_s.x, _s.y, _s.z);
      if (r < 0.8) this.items.push({ o: m, r });
    });
  }
}
