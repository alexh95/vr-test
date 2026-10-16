import { BufferAttribute, BufferGeometry, Color, Group, Mesh, MeshLambertMaterial, Vector3 } from 'three';
import { fbm2, ringNoise, smoothstep, TAU } from '../core/math';

export interface IslandSpec {
  name: string;
  center: Vector3;
  radius: number;
  depth: number;
  seed: number;
  /** Fraction of the radius that stays flat (for stations). */
  flat?: number;
  /** Height variation of the outer grass ring (m). */
  bump?: number;
  /** How ragged the outline is (0..1). */
  ragged?: number;
  segments?: number;
  rings?: number;
  grass?: [number, number];
}

export interface Island {
  spec: IslandSpec;
  group: Group;
  /** Outline radius at an angle (radians, atan2(z, x) convention). */
  edge(theta: number): number;
  /** Ground height at a world (x, z), or null outside the island. */
  heightAt(x: number, z: number): number | null;
  /** Collider data for the walkable top, in world space. */
  topVertices: Float32Array;
  topIndices: Uint32Array;
  /** Collider data for the rock underside (the same surface that's drawn), in world space. */
  rockVertices: Float32Array;
  rockIndices: Uint32Array;
}

const grassMat = new MeshLambertMaterial({ vertexColors: true });
const rockMat = new MeshLambertMaterial({ vertexColors: true, flatShading: true });

const STRATA = [0x80604a, 0x94735a, 0x6c5244, 0xa18f7c, 0x5d4c44, 0x8c6c54].map((h) => new Color(h));
const SOIL = new Color(0x8b6a4a);
const MOSS = new Color(0x5f7f46);
const DEEP = new Color(0x463f4e);

export function buildIsland(spec: IslandSpec): Island {
  const M = spec.segments ?? 72;
  const NR = spec.rings ?? 10;
  const NU = 14;
  const R = spec.radius;
  const flatR = (spec.flat ?? 0.6) * R;
  const bump = spec.bump ?? 0.35;
  const ragged = spec.ragged ?? 0.25;
  const seed = spec.seed;
  const [g0, g1] = (spec.grass ?? [0x5d9a47, 0x86b85a]).map((h) => new Color(h));
  const c = new Color();

  const edge = (theta: number) => R * (1 - ragged * 0.5 + ragged * ringNoise(theta, seed, 2.2));
  const topY = (x: number, z: number, r: number, er: number) => {
    const outer = smoothstep(flatR, er * 0.97, r);
    const n = fbm2(x * 0.22 + seed * 3.7, z * 0.22 - seed * 1.3, 3) - 0.5;
    const lip = -0.28 * Math.pow(smoothstep(er * 0.9, er, r), 2);
    return n * bump * 2 * outer + lip;
  };

  // ---- Top (smooth grass) ----
  const topCount = 1 + NR * M;
  const tp = new Float32Array(topCount * 3);
  const tc = new Float32Array(topCount * 3);
  const setTopColor = (i: number, x: number, z: number, r: number, er: number) => {
    const n = fbm2(x * 0.35 + seed, z * 0.35 - seed, 3);
    c.copy(g0).lerp(g1, smoothstep(0.35, 0.7, n));
    const patch = fbm2(x * 1.3 - seed * 2, z * 1.3, 2);
    if (patch > 0.68) c.lerp(new Color(0x4a8139), 0.5);
    c.lerp(SOIL, smoothstep(er * 0.86, er * 0.99, r));
    tc.set([c.r, c.g, c.b], i * 3);
  };
  tp.set([0, topY(0, 0, 0, R), 0], 0);
  setTopColor(0, 0, 0, 0, R);
  for (let i = 1; i <= NR; i++) {
    for (let j = 0; j < M; j++) {
      const th = (j / M) * TAU;
      const er = edge(th);
      const r = er * (i / NR);
      const x = Math.cos(th) * r;
      const z = Math.sin(th) * r;
      const idx = 1 + (i - 1) * M + j;
      tp.set([x, topY(x, z, r, er), z], idx * 3);
      setTopColor(idx, x, z, r, er);
    }
  }
  const ti: number[] = [];
  for (let j = 0; j < M; j++) {
    const a = 1 + j;
    const b = 1 + ((j + 1) % M);
    ti.push(0, b, a);
  }
  for (let i = 1; i < NR; i++) {
    for (let j = 0; j < M; j++) {
      const a = 1 + (i - 1) * M + j;
      const b = 1 + (i - 1) * M + ((j + 1) % M);
      const d = 1 + i * M + j;
      const e = 1 + i * M + ((j + 1) % M);
      ti.push(a, b, d, b, e, d);
    }
  }
  const topGeo = new BufferGeometry();
  topGeo.setAttribute('position', new BufferAttribute(tp, 3));
  topGeo.setAttribute('color', new BufferAttribute(tc, 3));
  topGeo.setIndex(ti);
  topGeo.computeVertexNormals();

  // ---- Underside (faceted rock, hanging cone) ----
  const up: number[] = [];
  const uc: number[] = [];
  const ring = (k: number): Vector3[] => {
    const pts: Vector3[] = [];
    const t = k / NU;
    for (let j = 0; j < M; j++) {
      const th = (j / M) * TAU;
      const er = edge(th);
      if (k === 0) {
        const x = Math.cos(th) * er;
        const z = Math.sin(th) * er;
        pts.push(new Vector3(x, topY(x, z, er, er), z));
        continue;
      }
      const jag = fbm2(Math.cos(th) * 3 + k * 0.7 + seed, Math.sin(th) * 3 - k * 0.4, 3);
      const rr = er * Math.pow(1 - t, 1.25) * (0.86 + 0.32 * jag) + (k === 1 ? er * 0.06 : 0);
      const y = -spec.depth * Math.pow(t, 0.9) - 0.25 - (jag - 0.5) * spec.depth * 0.06;
      pts.push(new Vector3(Math.cos(th) * rr, y, Math.sin(th) * rr));
    }
    return pts;
  };
  const rings: Vector3[][] = [];
  for (let k = 0; k < NU; k++) rings.push(ring(k));
  const tip = new Vector3(0, -spec.depth * 1.05 - 0.25, 0);
  const rockColor = (p: Vector3, k: number) => {
    const layer = Math.floor(((-p.y + fbm2(p.x * 0.4, p.z * 0.4, 2) * 1.2) / Math.max(0.6, spec.depth / 9)) % STRATA.length);
    c.copy(STRATA[(layer + STRATA.length) % STRATA.length]);
    if (k <= 1) c.lerp(MOSS, k === 0 ? 0.65 : 0.35);
    c.lerp(DEEP, smoothstep(0.3, 1.0, -p.y / spec.depth));
    return c;
  };
  const tri = (a: Vector3, b: Vector3, d: Vector3, k: number) => {
    up.push(a.x, a.y, a.z, b.x, b.y, b.z, d.x, d.y, d.z);
    const centroid = new Vector3().add(a).add(b).add(d).multiplyScalar(1 / 3);
    const col = rockColor(centroid, k);
    for (let n = 0; n < 3; n++) uc.push(col.r, col.g, col.b);
  };
  for (let k = 0; k < NU - 1; k++) {
    const r0 = rings[k];
    const r1 = rings[k + 1];
    for (let j = 0; j < M; j++) {
      const j1 = (j + 1) % M;
      tri(r0[j], r0[j1], r1[j], k);
      tri(r0[j1], r1[j1], r1[j], k);
    }
  }
  const last = rings[NU - 1];
  for (let j = 0; j < M; j++) tri(last[j], last[(j + 1) % M], tip, NU);
  const rockGeo = new BufferGeometry();
  rockGeo.setAttribute('position', new BufferAttribute(new Float32Array(up), 3));
  rockGeo.setAttribute('color', new BufferAttribute(new Float32Array(uc), 3));
  rockGeo.computeVertexNormals();

  const group = new Group();
  group.name = spec.name;
  group.position.copy(spec.center);
  const top = new Mesh(topGeo, grassMat);
  top.receiveShadow = true;
  top.name = `${spec.name}-top`;
  const rock = new Mesh(rockGeo, rockMat);
  rock.name = `${spec.name}-rock`;
  rock.receiveShadow = true;
  group.add(top, rock);

  // World-space collider for the walkable top.
  const topVertices = new Float32Array(tp.length);
  for (let i = 0; i < tp.length; i += 3) {
    topVertices[i] = tp[i] + spec.center.x;
    topVertices[i + 1] = tp[i + 1] + spec.center.y;
    topVertices[i + 2] = tp[i + 2] + spec.center.z;
  }
  const topIndices = new Uint32Array(ti);

  // World-space collider for the rock underside: ring 0 is the rim, so it meets the top.
  const cx = spec.center.x;
  const cy = spec.center.y;
  const cz = spec.center.z;
  const rockVertices = new Float32Array((NU * M + 1) * 3);
  rings.forEach((r, k) => r.forEach((p, j) => rockVertices.set([p.x + cx, p.y + cy, p.z + cz], (k * M + j) * 3)));
  rockVertices.set([tip.x + cx, tip.y + cy, tip.z + cz], NU * M * 3);
  const ri: number[] = [];
  for (let k = 0; k < NU - 1; k++) {
    for (let j = 0; j < M; j++) {
      const j1 = (j + 1) % M;
      ri.push(k * M + j, k * M + j1, (k + 1) * M + j, k * M + j1, (k + 1) * M + j1, (k + 1) * M + j);
    }
  }
  for (let j = 0; j < M; j++) ri.push((NU - 1) * M + j, (NU - 1) * M + ((j + 1) % M), NU * M);
  const rockIndices = new Uint32Array(ri);

  const heightAt = (x: number, z: number) => {
    const lx = x - spec.center.x;
    const lz = z - spec.center.z;
    const r = Math.hypot(lx, lz);
    let th = Math.atan2(lz, lx);
    if (th < 0) th += TAU;
    const er = edge(th);
    if (r > er) return null;
    return spec.center.y + topY(lx, lz, r, er);
  };

  return {
    spec,
    group,
    edge: (theta) => edge(theta < 0 ? theta + TAU : theta),
    heightAt,
    topVertices,
    topIndices,
    rockVertices,
    rockIndices,
  };
}
