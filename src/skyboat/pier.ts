import { BoxGeometry, CylinderGeometry, Group, Mesh, MeshBasicMaterial, MeshLambertMaterial, MeshStandardMaterial, SphereGeometry, Vector3 } from 'three';
import { RAPIER, type Physics } from '../physics/physics';
import { mergeStatic } from '../core/merge';
import { makeLabel } from '../ui/text';
import { DOCK } from '../world/layout';

/**
 * A plank pier from the east rim of the main island out over the drop. The
 * skyboat moors across its end (see DOCK in layout.ts).
 */
export function buildPier(physics: Physics): { group: Group; lamp: MeshBasicMaterial } {
  const g = new Group();
  g.name = 'pier';
  const { x0, x1, z, width } = DOCK.pier;
  const PIER_TOP = DOCK.top;
  const len = x1 - x0;
  const wood = new MeshLambertMaterial({ color: 0x9a6b43 });
  const dark = new MeshLambertMaterial({ color: 0x6b4429 });
  const half = width / 2;

  // Deck planks with a little gap between boards.
  const boards = Math.round(len / 0.22);
  for (let i = 0; i < boards; i++) {
    const b = new Mesh(new BoxGeometry(len / boards - 0.012, 0.06, width), i % 3 === 1 ? dark : wood);
    b.position.set(x0 + (i + 0.5) * (len / boards), PIER_TOP - 0.03, z);
    b.castShadow = b.receiveShadow = true;
    g.add(b);
  }
  // Stringers under the boards, pilings, and diagonal struts down to the rock.
  for (const s of [-1, 1]) {
    const str = new Mesh(new BoxGeometry(len, 0.1, 0.08), dark);
    str.position.set(x0 + len / 2, PIER_TOP - 0.11, z + s * (half - 0.08));
    g.add(str);
  }
  for (let x = x0 + 0.3; x <= x1 - 0.05; x += 1.15) {
    for (const s of [-1, 1]) {
      const over = x > 8.9; // past the island's rim the pilings hang down into the void
      const bottom = over ? -1.6 : -0.2;
      const top = 0.95;
      const p = new Mesh(new BoxGeometry(0.1, top - bottom, 0.1), dark);
      p.position.set(x, (top + bottom) / 2, z + s * (half - 0.05));
      p.castShadow = true;
      g.add(p);
      const cap = new Mesh(new BoxGeometry(0.13, 0.03, 0.13), wood);
      cap.position.set(x, top + 0.015, z + s * (half - 0.05));
      g.add(cap);
    }
  }
  // Handrails along both sides; the end stays open for boarding.
  for (const s of [-1, 1]) {
    const rail = new Mesh(new BoxGeometry(len - 0.2, 0.05, 0.07), wood);
    rail.position.set(x0 + len / 2 - 0.1, 0.92, z + s * (half - 0.05));
    rail.castShadow = true;
    g.add(rail);
  }
  // Strut from under the far end back to the rock face.
  const strut = new Mesh(new BoxGeometry(0.09, 0.09, 3.2), dark);
  strut.rotation.y = Math.PI / 2;
  strut.rotation.z = 0.42;
  strut.position.set(x1 - 1.35, -0.75, z);
  g.add(strut);

  // A lantern on the end post, and a sign at the root.
  const lampMat = new MeshBasicMaterial({ color: 0xffd27a });
  const lantern = new Mesh(new SphereGeometry(0.07, 12, 8), lampMat);
  lantern.position.set(x1 - 0.15, 1.12, z - half + 0.05);
  const hook = new Mesh(new CylinderGeometry(0.012, 0.012, 0.2, 6), dark);
  hook.position.set(x1 - 0.15, 1.04, z - half + 0.05);
  const cage = new Mesh(new CylinderGeometry(0.085, 0.085, 0.16, 6, 1, true), new MeshStandardMaterial({ color: 0x2b2d42, metalness: 0.6, roughness: 0.4, wireframe: true }));
  cage.position.copy(lantern.position);
  g.add(hook, lantern, cage);

  const signPost = new Mesh(new BoxGeometry(0.08, 1.5, 0.08), dark);
  signPost.position.set(x0 + 0.25, 0.75, z - half - 0.25);
  g.add(signPost);
  const sign = makeLabel(
    ['SKYLARK · sky boat', 'board through the gate at the end', 'WHEEL: steer · grab the rim', 'RIGHT LEVER: throttle', 'LEFT HANDLE: pull up / push down', 'console RESET brings her home'],
    { width: 0.78, aspect: 0.62, px: 768, background: 'rgba(42,29,22,0.94)', font: '600 40px system-ui, sans-serif', color: '#ffe9c9' },
  );
  sign.position.set(x0 + 0.25, 1.32, z - half - 0.2);
  sign.rotation.y = -Math.PI / 2 + 0.5; // toward someone walking out from the island
  g.add(sign);

  physics.addStatic(RAPIER.ColliderDesc.cuboid(len / 2, 0.04, half), { walkable: true, material: 'wood' }, new Vector3(x0 + len / 2, PIER_TOP - 0.04, z));
  // Same shadow flags everywhere, so the merge makes one draw call per material.
  g.traverse((o) => {
    if ((o as Mesh).isMesh && o !== lantern && o !== sign) o.castShadow = o.receiveShadow = true;
  });
  mergeStatic(g, (o) => o === lantern || o === sign);
  return { group: g, lamp: lampMat };
}
