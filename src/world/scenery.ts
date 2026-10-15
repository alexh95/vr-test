import {
  BoxGeometry,
  Color,
  CylinderGeometry,
  DodecahedronGeometry,
  Group,
  IcosahedronGeometry,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  OctahedronGeometry,
  Quaternion,
  Vector3,
} from 'three';
import { RAPIER, type Physics } from '../physics/physics';
import { rng, TAU } from '../core/math';
import { buildIsland, type Island, type IslandSpec } from './island';
import { inRangeLane, nearStation } from './layout';
import { mergeStatic } from '../core/merge';

export interface Scenery {
  root: Group;
  main: Island;
  islands: Island[];
  crystalMaterial: MeshBasicMaterial;
  /** Ground height lookup across all islands (for decorations / locomotion fallbacks). */
  heightAt(x: number, z: number): number | null;
  /** Where the plank ends (for tests and the welcome sign). */
  plankTip: Vector3;
  satelliteCenter: Vector3;
  stonePositions: Vector3[];
}

const wood = new MeshLambertMaterial({ color: 0x9a6b43 });
const darkWood = new MeshLambertMaterial({ color: 0x6b4429 });

/** Distant and nearby islands, stepping stones, trees, rocks and glowing crystals. */
export function buildScenery(physics: Physics, quality: 'high' | 'low'): Scenery {
  const root = new Group();
  root.name = 'scenery';
  const islands: Island[] = [];

  const add = (spec: IslandSpec, walkable: boolean) => {
    const isl = buildIsland(spec);
    root.add(isl.group);
    islands.push(isl);
    if (walkable) {
      physics.addStatic(RAPIER.ColliderDesc.trimesh(isl.topVertices, isl.topIndices), { walkable: true, material: 'stone' });
    }
    // A coarse rock collider so things bounce off the underside instead of falling through it.
    const s = spec;
    physics.addStatic(
      RAPIER.ColliderDesc.cone(s.depth * 0.45, s.radius * 0.8),
      { walkable: false, material: 'stone' },
      new Vector3(s.center.x, s.center.y - s.depth * 0.45 - 0.35, s.center.z),
      new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI),
    );
    return isl;
  };

  const main = add({ name: 'main-island', center: new Vector3(0, 0, 0), radius: 9.2, depth: 15, seed: 1, flat: 0.68, bump: 0.32, ragged: 0.18 }, true);

  // Stepping stones toward the satellite island (front-right).
  const satelliteCenter = new Vector3(12.8, 1.1, -12.6);
  const stonePositions: Vector3[] = [];
  const startEdge = new Vector3(6.4, 0, -6.3);
  const satEdge = satelliteCenter.clone().add(new Vector3(-0.71, 0, 0.7).multiplyScalar(3.4));
  const n = 3;
  for (let i = 1; i <= n; i++) {
    const t = i / (n + 1);
    const p = startEdge.clone().lerp(satEdge, t);
    p.x += (i % 2 === 0 ? 0.5 : -0.4);
    p.y = 0.15 + t * 0.9;
    stonePositions.push(p);
    add({ name: `stone-${i}`, center: p, radius: 0.85, depth: 2.2, seed: 10 + i, flat: 0.75, bump: 0.05, ragged: 0.3, segments: 18, rings: 3, grass: [0x6c9b4a, 0x8cb95a] }, true);
  }
  add({ name: 'satellite', center: satelliteCenter, radius: 3.6, depth: 7, seed: 2, flat: 0.55, bump: 0.25, ragged: 0.3, segments: 48, rings: 6 }, true);

  // Big neighbours you can see but not reach (unless you're a giant).
  add({ name: 'west-isle', center: new Vector3(-24, -3.5, -19), radius: 5.2, depth: 9, seed: 3, flat: 0.4, bump: 0.6, ragged: 0.35, segments: 48, rings: 6 }, true);
  const far: [number, number, number, number, number][] = [
    [44, 9, -72, 8, 4],
    [-66, 16, 28, 10, 5],
    [70, -12, 34, 6.5, 6],
    [-30, 22, -95, 7, 7],
    [12, -18, 60, 9, 8],
  ];
  for (const [x, y, z, r, seed] of far) {
    add({ name: `far-${seed}`, center: new Vector3(x, y, z), radius: r, depth: r * 1.8, seed, flat: 0.3, bump: 1.2, ragged: 0.35, segments: 40, rings: 5 }, false);
  }

  const heightAt = (x: number, z: number) => {
    let best: number | null = null;
    for (const isl of islands) {
      const h = isl.heightAt(x, z);
      if (h !== null && (best === null || h > best)) best = h;
    }
    return best;
  };

  // ---- Trees ----
  const trunkGeo = new CylinderGeometry(0.07, 0.13, 1, 6);
  trunkGeo.translate(0, 0.5, 0);
  const leafGeo = new IcosahedronGeometry(1, quality === 'high' ? 1 : 0);
  const trees: { x: number; z: number; h: number; s: number; color: number }[] = [];
  const r = rng(4242);
  const treeColors = [0x4f8f3e, 0x5fa047, 0x3f7a3a, 0xf3a7c6, 0xe58fb3, 0x6aa84f];
  const placeOnIsland = (isl: Island, count: number, minFrac: number, maxFrac: number, avoid: (x: number, z: number) => boolean) => {
    let tries = 0;
    let placed = 0;
    while (placed < count && tries++ < count * 30) {
      const th = r() * TAU;
      const rad = isl.edge(th) * (minFrac + r() * (maxFrac - minFrac));
      const x = isl.spec.center.x + Math.cos(th) * rad;
      const z = isl.spec.center.z + Math.sin(th) * rad;
      if (avoid(x, z)) continue;
      if (trees.some((t) => Math.hypot(t.x - x, t.z - z) < 1.6)) continue;
      const h = isl.heightAt(x, z);
      if (h === null) continue;
      trees.push({ x, z: z, h, s: 0.8 + r() * 0.7, color: treeColors[Math.floor(r() * treeColors.length)] });
      placed++;
    }
  };
  // Keep the play space clear: nothing within ~5.6 m of the island centre, and leave the plank lane open.
  // Keep the sunset side (-Z) open: it's the view, and trees there would shade the play area.
  const mainAvoid = (x: number, z: number) =>
    Math.hypot(x, z) < 5.6 ||
    (z < -2.5 && Math.abs(x) < 6.5) ||
    (x > 3 && z < -3 && Math.abs(x + z) < 2.4) ||
    nearStation(x, z, 2.0) ||
    inRangeLane(x, 1, z);
  placeOnIsland(main, 9, 0.66, 0.9, mainAvoid);
  placeOnIsland(islands.find((i) => i.spec.name === 'satellite')!, 3, 0.3, 0.75, () => false);
  placeOnIsland(islands.find((i) => i.spec.name === 'west-isle')!, 5, 0.1, 0.8, () => false);
  for (const isl of islands.filter((i) => i.spec.name.startsWith('far-'))) placeOnIsland(isl, 4, 0.05, 0.7, () => false);

  const trunks = new InstancedMesh(trunkGeo, darkWood, trees.length);
  const leaves = new InstancedMesh(leafGeo, new MeshLambertMaterial({ color: 0xffffff, flatShading: true }), trees.length * 3);
  trunks.castShadow = leaves.castShadow = true;
  trunks.receiveShadow = leaves.receiveShadow = true;
  const m = new Matrix4();
  const q = new Quaternion();
  const col = new Color();
  trees.forEach((t, i) => {
    const height = 1.6 * t.s;
    m.compose(new Vector3(t.x, t.h - 0.05, t.z), q.identity(), new Vector3(t.s, height, t.s));
    trunks.setMatrixAt(i, m);
    for (let k = 0; k < 3; k++) {
      const ang = k * 2.1 + i;
      const off = new Vector3(Math.cos(ang) * 0.3 * t.s, height + (k === 0 ? 0.35 : 0.05) * t.s, Math.sin(ang) * 0.3 * t.s);
      const s = (k === 0 ? 0.85 : 0.62) * t.s;
      m.compose(new Vector3(t.x, t.h, t.z).add(off), q.setFromAxisAngle(new Vector3(0, 1, 0), ang), new Vector3(s, s * 0.85, s));
      leaves.setMatrixAt(i * 3 + k, m);
      leaves.setColorAt(i * 3 + k, col.setHex(t.color).offsetHSL(0, 0, (k - 1) * 0.04));
    }
  });
  trunks.name = 'tree-trunks';
  leaves.name = 'tree-leaves';
  root.add(trunks, leaves);
  for (const t of trees) {
    if (Math.hypot(t.x, t.z) > 40) continue;
    physics.addStatic(RAPIER.ColliderDesc.cylinder(0.8 * t.s, 0.12 * t.s), { material: 'wood' }, new Vector3(t.x, t.h + 0.8 * t.s, t.z));
  }

  // ---- Rocks ----
  const rockGeo = new DodecahedronGeometry(1, 0);
  const rockSpots: [number, number, number][] = [];
  for (let i = 0; i < 16; i++) {
    const th = r() * TAU;
    const rad = main.edge(th) * (0.72 + r() * 0.24);
    const x = Math.cos(th) * rad;
    const z = Math.sin(th) * rad;
    if (mainAvoid(x, z)) continue;
    rockSpots.push([x, z, 0.18 + r() * 0.35]);
  }
  const rocks = new InstancedMesh(rockGeo, new MeshLambertMaterial({ color: 0x8b8178, flatShading: true }), rockSpots.length);
  rockSpots.forEach(([x, z, s], i) => {
    const h = main.heightAt(x, z) ?? 0;
    const axis = new Vector3(r() - 0.5, r() - 0.5, r() - 0.5).normalize();
    m.compose(new Vector3(x, h + s * 0.35, z), q.setFromAxisAngle(axis, r() * TAU), new Vector3(s * 1.3, s, s * 1.1));
    rocks.setMatrixAt(i, m);
    physics.addStatic(RAPIER.ColliderDesc.ball(s * 0.95), { material: 'stone' }, new Vector3(x, h + s * 0.35, z));
  });
  rocks.castShadow = rocks.receiveShadow = true;
  rocks.name = 'rocks';
  root.add(rocks);

  // ---- Crystals (unlit, glow brighter at night) ----
  const crystalGeo = new OctahedronGeometry(1, 0);
  const crystalMaterial = new MeshBasicMaterial({ color: 0xffffff });
  const crystalSpots: { p: Vector3; s: Vector3; rot: Quaternion; color: number }[] = [];
  const crystalColors = [0x6ff7ff, 0xb48cff, 0xff8fe3, 0x7dffc0];
  for (const isl of islands) {
    if (isl.spec.name.startsWith('stone')) continue;
    const count = isl === main ? 26 : Math.round(isl.spec.radius * 1.5);
    for (let i = 0; i < count; i++) {
      const th = r() * TAU;
      const hanging = r() < 0.6;
      const er = isl.edge(th);
      const c = isl.spec.center;
      let p: Vector3;
      let rot: Quaternion;
      if (hanging) {
        // Stalactite crystals under the rim.
        const depthFrac = 0.08 + r() * 0.35;
        const rad = er * (0.85 - depthFrac * 0.8);
        p = new Vector3(c.x + Math.cos(th) * rad, c.y - isl.spec.depth * depthFrac - 0.4, c.z + Math.sin(th) * rad);
        rot = new Quaternion().setFromAxisAngle(new Vector3(Math.sin(th), 0, -Math.cos(th)), Math.PI + (r() - 0.5) * 0.6);
      } else {
        const rad = er * (0.8 + r() * 0.18);
        const x = c.x + Math.cos(th) * rad;
        const z = c.z + Math.sin(th) * rad;
        if (isl === main && mainAvoid(x, z)) continue;
        p = new Vector3(x, (isl.heightAt(x, z) ?? c.y) + 0.1, z);
        rot = new Quaternion().setFromAxisAngle(new Vector3(Math.sin(th), 0, -Math.cos(th)), (r() - 0.5) * 0.7);
      }
      const s = (isl === main ? 0.12 : 0.2) + r() * 0.22;
      crystalSpots.push({ p, s: new Vector3(s * 0.45, s * 1.8, s * 0.45), rot, color: crystalColors[Math.floor(r() * crystalColors.length)] });
    }
  }
  const crystals = new InstancedMesh(crystalGeo, crystalMaterial, crystalSpots.length);
  crystalSpots.forEach((cs, i) => {
    m.compose(cs.p, cs.rot, cs.s);
    crystals.setMatrixAt(i, m);
    crystals.setColorAt(i, col.setHex(cs.color));
  });
  crystals.name = 'crystals';
  root.add(crystals);

  // ---- The plank: walk out over a 40 m drop ----
  const plankDir = new Vector3(0, 0, -1);
  const th = Math.atan2(plankDir.z, plankDir.x);
  const edgeR = main.edge(th);
  const plankLen = 3.4;
  const plankStart = edgeR - 0.9;
  const plankCenter = plankDir.clone().multiplyScalar(plankStart + plankLen / 2);
  const plankY = 0.06;
  const plank = new Mesh(new BoxGeometry(0.38, 0.05, plankLen), wood);
  plank.position.set(plankCenter.x, plankY, plankCenter.z);
  plank.castShadow = plank.receiveShadow = true;
  plank.name = 'plank';
  root.add(plank);
  // Nails/boards detail: a darker strip and two support posts.
  for (const sx of [-0.24, 0.24]) {
    const post = new Mesh(new BoxGeometry(0.07, 0.5, 0.07), darkWood);
    post.position.set(plankCenter.x + sx, 0.1, -plankStart - 0.05);
    post.castShadow = true;
    root.add(post);
  }
  const strip = new Mesh(new BoxGeometry(0.4, 0.052, 0.06), darkWood);
  for (const zf of [0.2, 0.5, 0.8]) {
    const s = strip.clone();
    s.position.set(plankCenter.x, plankY + 0.002, -(plankStart + plankLen * zf));
    root.add(s);
  }
  physics.addStatic(RAPIER.ColliderDesc.cuboid(0.19, 0.025, plankLen / 2), { walkable: true, material: 'wood' }, new Vector3(plankCenter.x, plankY, plankCenter.z));
  const plankTip = new Vector3(plankCenter.x, plankY + 0.025, -(plankStart + plankLen - 0.2));

  // Every island top/underside and the plank pieces collapse into a handful of draw calls.
  mergeStatic(root);

  return {
    root,
    main,
    islands,
    crystalMaterial,
    heightAt,
    plankTip,
    satelliteCenter,
    stonePositions,
  };
}
