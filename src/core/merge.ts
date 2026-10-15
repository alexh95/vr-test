import { BufferAttribute, BufferGeometry, Color, Material, Matrix4, Mesh, Object3D } from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * Bake every static, untextured mesh under `root` into one mesh per material
 * (and shadow setting). Draw calls matter in VR: everything is drawn once per
 * eye. Animated or textured meshes, instanced/skinned meshes and anything
 * `keep` returns true for (or that has a kept ancestor) are left alone.
 * Returns how many meshes were folded away.
 */
export function mergeStatic(root: Object3D, keep: (o: Object3D) => boolean = () => false): number {
  root.updateMatrixWorld(true);
  const inv = new Matrix4().copy(root.matrixWorld).invert();
  const buckets = new Map<string, { mat: Material; cast: boolean; recv: boolean; geos: BufferGeometry[] }>();
  const folded: Mesh[] = [];
  root.traverse((o) => {
    const m = o as Mesh;
    if (!m.isMesh || (m as { isInstancedMesh?: boolean }).isInstancedMesh || (m as { isSkinnedMesh?: boolean }).isSkinnedMesh) return;
    for (let p: Object3D | null = o; p && p !== root; p = p.parent) if (keep(p)) return;
    if (Array.isArray(m.material)) return;
    const mat = m.material as Material & { map?: unknown; transparent: boolean; vertexColors: boolean };
    if (mat.map || mat.transparent) return;
    const g = (m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone()) as BufferGeometry;
    const keepAttrs = mat.vertexColors ? ['position', 'normal', 'color'] : ['position', 'normal'];
    for (const name of Object.keys(g.attributes)) if (!keepAttrs.includes(name)) g.deleteAttribute(name);
    g.applyMatrix4(new Matrix4().multiplyMatrices(inv, m.matrixWorld));
    const key = `${mat.uuid}|${m.castShadow}|${m.receiveShadow}`;
    let b = buckets.get(key);
    if (!b) buckets.set(key, (b = { mat, cast: m.castShadow, recv: m.receiveShadow, geos: [] }));
    b.geos.push(g);
    folded.push(m);
  });
  for (const m of folded) m.removeFromParent();
  for (const b of buckets.values()) {
    const merged = mergeGeometries(b.geos, false);
    if (!merged) continue;
    const mesh = new Mesh(merged, b.mat);
    mesh.castShadow = b.cast;
    mesh.receiveShadow = b.recv;
    mesh.name = `${root.name || 'static'}-merged`;
    root.add(mesh);
  }
  return folded.length - buckets.size;
}

/** Merge parts into one geometry, painting each part a flat vertex colour. */
export function mergeColored(parts: { geometry: BufferGeometry; matrix: Matrix4; color: number | Color }[]): BufferGeometry {
  const geos = parts.map(({ geometry, matrix, color }) => {
    const g = (geometry.index ? geometry.toNonIndexed() : geometry.clone()) as BufferGeometry;
    for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
    g.applyMatrix4(matrix);
    const c = color instanceof Color ? color : new Color(color);
    const n = g.getAttribute('position').count;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
    g.setAttribute('color', new BufferAttribute(col, 3));
    return g;
  });
  return mergeGeometries(geos, false)!;
}
