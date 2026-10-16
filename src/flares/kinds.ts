import { type BufferGeometry, Color, ConeGeometry, CylinderGeometry, Matrix4, SphereGeometry } from 'three';
import { mergeColored } from '../core/merge';

export type FlareType = 'parachute' | 'star' | 'smoke';

/** One kind of cartridge: what it does and what colour it burns (or smokes). */
export interface ShellKind {
  id: string;
  type: FlareType;
  label: string;
  /** Light or smoke colour (linear). */
  color: Color;
}

/** Cartridge size: a fat 26.5 mm signal cartridge, rim at y = 0, cap at y = length. */
export const SHELL = { radius: 0.0128, rim: 0.0146, length: 0.075 };

const kind = (type: FlareType, label: string, hex: number): ShellKind => ({ id: `${type}-${label}`, type, label, color: new Color(hex) });

/** Three rows in every locker: parachute illumination, signal stars, smoke. */
export const KINDS: ShellKind[] = [
  kind('parachute', 'white', 0xfff1dc),
  kind('parachute', 'red', 0xff3a2a),
  kind('parachute', 'green', 0x46ff62),
  kind('star', 'red', 0xff2a1c),
  kind('star', 'green', 0x38ff58),
  kind('star', 'gold', 0xffb02e),
  kind('smoke', 'orange', 0xff7a1a),
  kind('smoke', 'violet', 0xa66cff),
  kind('smoke', 'sky', 0x52c8ff),
];

export const kindById = (id: string): ShellKind => KINDS.find((k) => k.id === id)!;

const BRASS = 0xd4af37;

/**
 * Cartridge geometry (vertex-coloured, non-indexed), axis along +Y. The three
 * types read differently at a glance: parachute rounds are white with a domed
 * cap, stars are coloured with a pointed cap, smoke is dark slate with a flat
 * vented cap. `null` is a spent casing.
 */
export function shellGeometry(k: ShellKind | null): BufferGeometry {
  const L = SHELL.length;
  const r = SHELL.radius;
  const at = (y: number) => new Matrix4().makeTranslation(0, y, 0);
  const cyl = (rad: number, h: number, open = false) => new CylinderGeometry(rad, rad, h, 18, 1, open);
  const parts: { geometry: BufferGeometry; matrix: Matrix4; color: number | Color }[] = [
    { geometry: cyl(SHELL.rim, 0.003), matrix: at(0.0015), color: BRASS },
    { geometry: cyl(r * 1.002, 0.013), matrix: at(0.003 + 0.0065), color: BRASS },
  ];
  const bodyFrom = 0.016;
  if (!k) {
    // Fired: an empty, scorched tube.
    parts.push({ geometry: cyl(r, L - bodyFrom - 0.004, true), matrix: at(bodyFrom + (L - bodyFrom - 0.004) / 2), color: 0x3b3431 });
    parts.push({ geometry: cyl(r * 0.92, 0.002), matrix: at(bodyFrom + 0.004), color: 0x15110f });
    return mergeColored(parts);
  }
  const c = k.color;
  const capH = 0.012;
  const bodyLen = L - bodyFrom - capH;
  const bodyMid = bodyFrom + bodyLen / 2;
  const capAt = L - capH;
  const band = (y: number, color: number | Color, h = 0.007) => parts.push({ geometry: cyl(r * 1.004, h), matrix: at(y), color });
  switch (k.type) {
    case 'parachute': {
      parts.push({ geometry: cyl(r, bodyLen), matrix: at(bodyMid), color: 0xf2eee6 });
      band(capAt - 0.012, c);
      const dome = new SphereGeometry(r, 18, 8, 0, Math.PI * 2, 0, Math.PI / 2);
      parts.push({ geometry: dome, matrix: new Matrix4().makeTranslation(0, capAt, 0).multiply(new Matrix4().makeScale(1, capH / r, 1)), color: c });
      break;
    }
    case 'star': {
      parts.push({ geometry: cyl(r, bodyLen), matrix: at(bodyMid), color: c.clone().multiplyScalar(0.8) });
      band(capAt - 0.006, 0xf2eee6, 0.005);
      parts.push({ geometry: new ConeGeometry(r, capH + 0.004, 18), matrix: at(capAt + (capH + 0.004) / 2), color: c });
      break;
    }
    case 'smoke': {
      parts.push({ geometry: cyl(r, bodyLen), matrix: at(bodyMid), color: 0x3c4150 });
      band(bodyFrom + 0.008, c, 0.006);
      band(capAt - 0.01, c, 0.006);
      parts.push({ geometry: cyl(r, capH * 0.5), matrix: at(capAt + capH * 0.25), color: c });
      parts.push({ geometry: cyl(r * 0.42, 0.002), matrix: at(capAt + capH * 0.5 + 0.0008), color: 0x1d2028 });
      break;
    }
  }
  return mergeColored(parts);
}
