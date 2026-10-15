import {
  BoxGeometry,
  Color,
  CylinderGeometry,
  Group,
  Matrix4,
  Mesh,
  MeshLambertMaterial,
  MeshStandardMaterial,
  Quaternion,
  SphereGeometry,
  Vector3,
} from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { bus } from '../core/events';
import { clamp, damp, DEG } from '../core/math';
import type { HandInput } from '../input/xr-input';
import { RAPIER, type Prop } from '../physics/physics';
import { faceToward, LAYOUT } from '../world/layout';
import { marimba as marimbaSound } from '../audio/sfx';
import { midi } from '../audio/ambience';
import { makeLabel } from '../ui/text';
import { mergeStatic } from '../core/merge';
import type { App } from '../app';

// C major pentatonic over two-plus octaves: nothing you play can sound wrong.
const NOTES = [60, 62, 64, 67, 69, 72, 74, 76, 79, 81, 84, 86];
const BAR_TOP = 0.86;
const BAR_T = 0.026;
const HEAD_R = 0.024;
const MALLET_HEAD = new Vector3(0, 0, -0.29);

interface Bar {
  index: number;
  mesh: Mesh;
  mat: MeshStandardMaterial;
  color: Color;
  x: number; // local centre
  halfW: number;
  halfL: number;
  glow: number;
  dip: number;
  lastHit: number;
}

interface Striker {
  id: string;
  hand: HandInput | null;
  radius: number;
  prev: Vector3;
  has: boolean;
  /** Bar index the striker is currently resting in (no retrigger until it leaves). */
  inBar: number;
}

const _inv = new Matrix4();
const _local = new Vector3();
const _prevLocal = new Vector3();

export class Marimba {
  readonly group = new Group();
  readonly bars: Bar[] = [];
  readonly mallets: Prop[] = [];
  private readonly strikers = new Map<string, Striker>();
  notesPlayed = 0;

  constructor(private readonly app: App) {
    const g = this.group;
    g.name = 'marimba';
    g.position.copy(LAYOUT.marimba);
    faceToward(g);
    app.scene.add(g);
    this.build();
    const bars = new Set<object>(this.bars.map((b) => b.mesh));
    mergeStatic(g, (o) => bars.has(o));
    g.updateMatrixWorld(true);
    _inv.copy(g.matrixWorld).invert();
  }

  private build(): void {
    const g = this.group;
    const frameMat = new MeshLambertMaterial({ color: 0x5b3a26 });
    const tubeMat = new MeshStandardMaterial({ color: 0xc9a227, roughness: 0.3, metalness: 0.75 });
    const spacing = 0.06;
    const n = NOTES.length;
    const width = (n - 1) * spacing;
    // Frame rails + legs.
    for (const z of [-0.2, 0.2]) {
      const rail = new Mesh(new BoxGeometry(width + 0.12, 0.035, 0.035), frameMat);
      rail.position.set(0, BAR_TOP - BAR_T - 0.02, z);
      rail.castShadow = true;
      g.add(rail);
    }
    for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const leg = new Mesh(new BoxGeometry(0.04, BAR_TOP - 0.05, 0.04), frameMat);
      leg.position.set((x * (width + 0.08)) / 2, (BAR_TOP - 0.05) / 2, z * 0.2);
      leg.castShadow = true;
      g.add(leg);
    }
    for (let i = 0; i < n; i++) {
      const x = -width / 2 + i * spacing;
      const len = 0.42 - (0.18 * i) / (n - 1);
      const color = new Color().setHSL(0.02 + (i / n) * 0.75, 0.55, 0.42);
      const wood = new Color(0x8a4b2a).lerp(color, 0.35);
      const mat = new MeshStandardMaterial({ color: wood, roughness: 0.5, emissive: new Color(0) });
      const bar = new Mesh(new RoundedBoxGeometry(0.05, BAR_T, len, 2, 0.006), mat);
      bar.position.set(x, BAR_TOP - BAR_T / 2, 0);
      bar.castShadow = bar.receiveShadow = true;
      g.add(bar);
      const tubeLen = 0.12 + (0.34 * (n - 1 - i)) / (n - 1);
      const tube = new Mesh(new CylinderGeometry(0.018, 0.018, tubeLen, 10), tubeMat);
      tube.position.set(x, BAR_TOP - BAR_T - 0.05 - tubeLen / 2, 0);
      g.add(tube);
      const b: Bar = { index: i, mesh: bar, mat, color, x, halfW: 0.025, halfL: len / 2, glow: 0, dip: 0, lastHit: 0 };
      this.bars.push(b);
      // Physical bar: balls bounce off it, and hard hits play the note.
      g.updateMatrixWorld(true);
      this.app.physics.addStatic(
        RAPIER.ColliderDesc.cuboid(0.025, BAR_T / 2, len / 2),
        {
          material: 'wood',
          onHit: (_p, strength) => {
            if (strength > 0.06) this.strike(b, clamp(strength * 1.5, 0.15, 1), null);
          },
        },
        bar.getWorldPosition(new Vector3()),
        bar.getWorldQuaternion(new Quaternion()),
      );
    }
    const label = makeLabel(['Marimba', 'grab a mallet, or tap with a finger'], {
      width: 0.5,
      aspect: 0.2,
      px: 640,
      background: 'rgba(25,20,35,0.78)',
      font: '600 36px system-ui, sans-serif',
      color: '#ffe9c7',
    });
    label.position.set(0, BAR_TOP + 0.32, -0.28);
    g.add(label);

    // A rack at the low end with two mallets in it.
    const shelfX = -width / 2 - 0.15;
    const rack = new Group();
    rack.position.set(shelfX, BAR_TOP - 0.01, 0);
    g.add(rack);
    const rackParts: [number, number, number, number, number, number][] = [
      // w, h, d, x, y, z (local to the rack)
      [0.15, 0.02, 0.36, 0, 0, 0],
      [0.012, 0.03, 0.36, -0.069, 0.025, 0],
      [0.012, 0.03, 0.36, 0.069, 0.025, 0],
      [0.008, 0.022, 0.36, 0, 0.021, 0],
    ];
    for (const [w, h, dpt, x, y, z] of rackParts) {
      const m = new Mesh(new BoxGeometry(w, h, dpt), frameMat);
      m.position.set(x, y, z);
      m.castShadow = true;
      rack.add(m);
      g.updateMatrixWorld(true);
      this.app.physics.addStatic(RAPIER.ColliderDesc.cuboid(w / 2, h / 2, dpt / 2), { material: 'wood' }, m.getWorldPosition(new Vector3()), m.getWorldQuaternion(new Quaternion()));
    }
    const headMat = new MeshStandardMaterial({ color: 0xf5e6c8, roughness: 0.9 });
    for (let i = 0; i < 2; i++) {
      const m = new Group();
      m.name = `mallet-${i}`;
      const stick = new Mesh(new CylinderGeometry(0.006, 0.007, 0.32, 8), new MeshLambertMaterial({ color: 0xd8b98a }));
      stick.rotation.x = Math.PI / 2;
      stick.position.z = -0.13;
      const head = new Mesh(new SphereGeometry(HEAD_R, 14, 10), headMat.clone());
      head.position.copy(MALLET_HEAD);
      stick.castShadow = head.castShadow = true;
      m.add(stick, head);
      this.app.scene.add(m);
      // Handle end toward the player, head away, lying in its slot.
      const pos = g.localToWorld(new Vector3(shelfX + (i === 0 ? -0.035 : 0.035), BAR_TOP + 0.03, 0.16));
      const q = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), g.rotation.y);
      const p = this.app.physics.addProp({
        id: `mallet-${i}`,
        object: m,
        // Boxes don't roll off racks the way capsules do.
        collider: RAPIER.ColliderDesc.cuboid(0.009, 0.009, 0.14).setTranslation(0, 0, -0.13),
        position: pos,
        quaternion: q,
        material: 'wood',
        radius: 0.16,
        density: 350,
        angularDamping: 1.2,
        behavior: { gripOffset: new Matrix4().makeRotationX(-35 * DEG), pullable: true },
      });
      this.app.physics.addCollider(p, RAPIER.ColliderDesc.ball(HEAD_R).setTranslation(MALLET_HEAD.x, MALLET_HEAD.y, MALLET_HEAD.z).setDensity(200));
      const hm = head.material as MeshStandardMaterial;
      p.onHighlight = (level) => hm.emissive.setRGB(level * 0.4, level * 0.3, level * 0.1);
      this.mallets.push(p);
    }
  }

  private strike(b: Bar, vel: number, hand: HandInput | null): void {
    const now = performance.now();
    if (now - b.lastHit < 45) return;
    b.lastHit = now;
    b.glow = 0.4 + vel * 0.8;
    b.dip = 0.004 + vel * 0.004;
    const at = b.mesh.getWorldPosition(new Vector3());
    marimbaSound(at, midi(NOTES[b.index]), vel);
    hand?.pulse(0.25 + vel * 0.55, 22);
    this.notesPlayed++;
    const up = new Vector3(0, 1, 0);
    for (let i = 0; i < 4 + vel * 8; i++) {
      this.app.fx.emit({
        position: at.clone().add(new Vector3((Math.random() - 0.5) * 0.04, 0.02, (Math.random() - 0.5) * b.halfL)),
        velocity: up.clone().multiplyScalar(0.25 + Math.random() * 0.4).add(new Vector3((Math.random() - 0.5) * 0.15, 0, (Math.random() - 0.5) * 0.15)),
        color: b.color.clone().offsetHSL(0, 0.3, 0.25),
        size: 0.012,
        sizeEnd: 0.002,
        life: 0.9,
        drag: 1.2,
      });
    }
    bus.emit('note', { index: b.index, midi: NOTES[b.index], vel: +vel.toFixed(2) });
  }

  /** Collect strikers: mallet heads in hands, and fingertips of empty hands. */
  private gatherStrikers(): { id: string; pos: Vector3; hand: HandInput | null; radius: number }[] {
    const out: { id: string; pos: Vector3; hand: HandInput | null; radius: number }[] = [];
    for (const m of this.mallets) {
      if (m.parked) continue;
      const head = MALLET_HEAD.clone().applyQuaternion(m.object.quaternion).add(m.object.position);
      out.push({ id: m.id, pos: head, hand: m.heldBy, radius: HEAD_R });
    }
    for (const hand of this.app.input.hands) {
      if (!hand.grip.valid || this.app.grab.held(hand)) continue;
      const tip = this.app.handModel(hand).indexTip(new Vector3());
      out.push({ id: `${hand.handedness}-finger`, pos: tip, hand, radius: 0.009 * this.app.rigScale });
    }
    return out;
  }

  update(dt: number): void {
    const seen = new Set<string>();
    for (const s of this.gatherStrikers()) {
      seen.add(s.id);
      let st = this.strikers.get(s.id);
      if (!st) {
        st = { id: s.id, hand: s.hand, radius: s.radius, prev: s.pos.clone(), has: false, inBar: -1 };
        this.strikers.set(s.id, st);
      }
      st.hand = s.hand;
      _local.copy(s.pos).applyMatrix4(_inv);
      if (st.has) {
        _prevLocal.copy(st.prev).applyMatrix4(_inv);
        const vy = (_local.y - _prevLocal.y) / Math.max(dt, 1e-3);
        const top = BAR_TOP + s.radius;
        let hitBar = -1;
        for (const b of this.bars) {
          if (Math.abs(_local.x - b.x) > b.halfW + s.radius * 0.5 || Math.abs(_local.z) > b.halfL + s.radius * 0.5) continue;
          if (_local.y <= top + 0.004 && _local.y > BAR_TOP - BAR_T - s.radius) {
            hitBar = b.index;
            if (st.inBar !== b.index && vy < -0.15 && _prevLocal.y > top - 0.012) {
              this.strike(b, clamp(-vy / 2.6, 0.12, 1), st.hand);
            }
            break;
          }
        }
        // Leave the bar before it can retrigger.
        if (hitBar === -1 && _local.y > top + 0.008) st.inBar = -1;
        else if (hitBar !== -1) st.inBar = hitBar;
      }
      st.prev.copy(s.pos);
      st.has = true;
    }
    for (const [id, st] of this.strikers) if (!seen.has(id)) st.has = false;

    // Bar glow and spring.
    const k = damp(5, dt);
    for (const b of this.bars) {
      if (b.glow > 0.001) {
        b.glow -= b.glow * k;
        b.mat.emissive.copy(b.color).multiplyScalar(b.glow * 1.4);
      } else if (b.glow !== 0) {
        b.glow = 0;
        b.mat.emissive.setRGB(0, 0, 0);
      }
      b.dip -= b.dip * damp(30, dt);
      b.mesh.position.y = BAR_TOP - BAR_T / 2 - b.dip;
    }
  }
}
