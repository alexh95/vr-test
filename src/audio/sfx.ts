import type { Vector3 } from 'three';
import { audio } from './audio';

// Synthesized sound effects. Each recipe allocates one spatial voice and
// schedules oscillators/noise into it. Kept deliberately small: a few partials
// and envelopes go a long way once HRTF puts them in space.

function env(g: GainNode, t: number, peak: number, attack: number, decay: number): void {
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
}

function tone(dest: AudioNode, t: number, type: OscillatorType, freq: number, peak: number, attack: number, decay: number, endFreq?: number): OscillatorNode {
  const ctx = audio.ctx!;
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (endFreq) o.frequency.exponentialRampToValueAtTime(endFreq, t + attack + decay);
  const g = ctx.createGain();
  env(g, t, peak, attack, decay);
  o.connect(g).connect(dest);
  o.start(t);
  o.stop(t + attack + decay + 0.05);
  return o;
}

function noiseBurst(dest: AudioNode, t: number, filter: BiquadFilterType, freq: number, q: number, peak: number, attack: number, decay: number, endFreq?: number): void {
  const ctx = audio.ctx!;
  const src = audio.noiseSource(t, 1);
  const f = ctx.createBiquadFilter();
  f.type = filter;
  f.frequency.setValueAtTime(freq, t);
  if (endFreq) f.frequency.exponentialRampToValueAtTime(endFreq, t + attack + decay);
  f.Q.value = q;
  const g = ctx.createGain();
  env(g, t, peak, attack, decay);
  src.connect(f).connect(g).connect(dest);
  src.stop(t + attack + decay + 0.05);
}

/** Marimba bar: tuned fundamental, 4th and 10th partials, plus a mallet click. */
export function marimba(at: Vector3, freq: number, vel: number): void {
  const decay = Math.min(2.4, Math.max(0.5, 1.7 * Math.sqrt(262 / freq)));
  const v = audio.voice({ at, life: decay + 0.1, wet: 0.3, gain: 0.5 * (0.2 + 0.8 * vel) });
  if (!v) return;
  const t = v.t0;
  tone(v.input, t, 'sine', freq, 1, 0.003, decay);
  tone(v.input, t, 'sine', freq * 3.98, 0.32 * vel, 0.002, decay * 0.16);
  tone(v.input, t, 'sine', freq * 9.9, 0.12 * vel * vel, 0.001, decay * 0.05);
  noiseBurst(v.input, t, 'bandpass', 2400 + vel * 1600, 1.4, 0.22 * vel, 0.001, 0.025);
}

export type ImpactMaterial = 'wood' | 'rubber' | 'tin' | 'stone' | 'glass';

/** Collision sound scaled by impact strength 0..1. */
export function impact(at: Vector3, material: ImpactMaterial, strength: number): void {
  const s = Math.min(1, Math.max(0.05, strength));
  const r = 0.9 + Math.random() * 0.2;
  switch (material) {
    case 'wood': {
      const v = audio.voice({ at, life: 0.15, wet: 0.08, gain: 0.55 * s });
      if (!v) return;
      tone(v.input, v.t0, 'sine', 820 * r, 1, 0.001, 0.07);
      tone(v.input, v.t0, 'triangle', 1640 * r, 0.3, 0.001, 0.03);
      noiseBurst(v.input, v.t0, 'bandpass', 1900 * r, 1.5, 0.5, 0.001, 0.02);
      break;
    }
    case 'rubber': {
      const v = audio.voice({ at, life: 0.2, wet: 0.05, gain: 0.6 * s });
      if (!v) return;
      tone(v.input, v.t0, 'triangle', 230 * r, 1, 0.002, 0.12, 140 * r);
      noiseBurst(v.input, v.t0, 'lowpass', 900, 0.7, 0.25, 0.001, 0.03);
      break;
    }
    case 'tin': {
      const v = audio.voice({ at, life: 0.5, wet: 0.15, gain: 0.35 * s });
      if (!v) return;
      const f = 480 * r;
      tone(v.input, v.t0, 'sine', f, 1, 0.001, 0.38);
      tone(v.input, v.t0, 'sine', f * 2.76, 0.6, 0.001, 0.26);
      tone(v.input, v.t0, 'sine', f * 5.4, 0.35, 0.001, 0.16);
      tone(v.input, v.t0, 'sine', f * 8.93, 0.2, 0.001, 0.1);
      noiseBurst(v.input, v.t0, 'highpass', 3000, 0.7, 0.4, 0.001, 0.015);
      break;
    }
    case 'stone': {
      const v = audio.voice({ at, life: 0.3, wet: 0.1, gain: 0.7 * s });
      if (!v) return;
      tone(v.input, v.t0, 'sine', 110 * r, 1, 0.002, 0.16, 70);
      noiseBurst(v.input, v.t0, 'lowpass', 700, 0.7, 0.5, 0.002, 0.08);
      break;
    }
    case 'glass': {
      const v = audio.voice({ at, life: 1.3, wet: 0.35, gain: 0.25 * s });
      if (!v) return;
      const f = 1250 * r;
      tone(v.input, v.t0, 'sine', f, 1, 0.001, 1.1);
      tone(v.input, v.t0, 'sine', f * 2.01, 0.4, 0.001, 0.6);
      tone(v.input, v.t0, 'sine', f * 3.03, 0.2, 0.001, 0.3);
      break;
    }
  }
}

/** Short UI tick (head-locked when `at` is omitted). */
export function uiTick(at?: Vector3, pitch = 1): void {
  const v = audio.voice({ at, life: 0.06, gain: 0.25 });
  if (!v) return;
  tone(v.input, v.t0, 'square', 1800 * pitch, 0.25, 0.001, 0.025);
  tone(v.input, v.t0, 'sine', 900 * pitch, 0.5, 0.001, 0.03);
}

/** Chunky physical button click. */
export function buttonClick(at: Vector3, down: boolean): void {
  const v = audio.voice({ at, life: 0.1, wet: 0.05, gain: 0.5 });
  if (!v) return;
  tone(v.input, v.t0, 'sine', down ? 190 : 260, 0.8, 0.001, 0.05, down ? 120 : 180);
  noiseBurst(v.input, v.t0, 'bandpass', down ? 1400 : 2200, 1.2, 0.6, 0.001, 0.025);
}

export function leverClunk(at: Vector3): void {
  const v = audio.voice({ at, life: 0.35, wet: 0.12, gain: 0.7 });
  if (!v) return;
  tone(v.input, v.t0, 'sine', 140, 1, 0.002, 0.18, 80);
  noiseBurst(v.input, v.t0, 'lowpass', 1600, 0.8, 0.6, 0.002, 0.06);
  tone(v.input, v.t0 + 0.07, 'triangle', 620, 0.25, 0.001, 0.08);
}

export function whoosh(at: Vector3 | null, up = true, gain = 0.35, dur = 0.3): void {
  const v = audio.voice({ at, life: dur + 0.05, gain });
  if (!v) return;
  noiseBurst(v.input, v.t0, 'bandpass', up ? 350 : 1800, 1.1, 1, dur * 0.4, dur * 0.6, up ? 1900 : 300);
}

export function gloveLock(at: Vector3): void {
  const v = audio.voice({ at, life: 0.12, gain: 0.3 });
  if (!v) return;
  tone(v.input, v.t0, 'sine', 880, 0.8, 0.002, 0.07, 1320);
  tone(v.input, v.t0 + 0.04, 'sine', 1760, 0.3, 0.002, 0.05);
}

export function gloveCatch(at: Vector3): void {
  const v = audio.voice({ at, life: 0.18, gain: 0.45 });
  if (!v) return;
  noiseBurst(v.input, v.t0, 'bandpass', 2600, 2, 0.8, 0.002, 0.05, 900);
  tone(v.input, v.t0, 'sine', 640, 0.7, 0.002, 0.1, 210);
}

export function teleportSound(at: Vector3 | null): void {
  whoosh(at, true, 0.28, 0.26);
  const v = audio.voice({ at, life: 0.3, gain: 0.12, wet: 0.2 });
  if (!v) return;
  tone(v.input, v.t0 + 0.12, 'sine', 1320, 0.5, 0.005, 0.18);
}

/** Continuous fuse hiss; returns a function that stops it. */
export function fuseHiss(at: Vector3, seconds: number): ((p: Vector3) => void) | null {
  const v = audio.voice({ at, life: seconds + 0.1, gain: 0.25 });
  if (!v) return null;
  const ctx = audio.ctx!;
  const src = audio.noiseSource(v.t0, 1);
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 3500;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, v.t0);
  g.gain.exponentialRampToValueAtTime(1, v.t0 + 0.05);
  g.gain.setValueAtTime(1, v.t0 + seconds - 0.05);
  g.gain.exponentialRampToValueAtTime(0.0001, v.t0 + seconds);
  // Sputter: a fast random-ish LFO on the gain.
  const lfo = ctx.createOscillator();
  lfo.type = 'square';
  lfo.frequency.value = 23;
  const lfoGain = ctx.createGain();
  lfoGain.gain.value = 0.35;
  lfo.connect(lfoGain).connect(g.gain);
  lfo.start(v.t0);
  lfo.stop(v.t0 + seconds);
  src.connect(hp).connect(g).connect(v.input);
  src.stop(v.t0 + seconds + 0.02);
  return (p: Vector3) => v.setPosition(p);
}

/** Rising whistle that follows a rocket; returns a position updater. */
export function rocketWhistle(at: Vector3, seconds: number): ((p: Vector3) => void) | null {
  const v = audio.voice({ at, life: seconds + 0.1, gain: 0.3, ref: 3 });
  if (!v) return null;
  const ctx = audio.ctx!;
  const o = ctx.createOscillator();
  o.type = 'sine';
  o.frequency.setValueAtTime(700, v.t0);
  o.frequency.exponentialRampToValueAtTime(2300, v.t0 + seconds);
  const vib = ctx.createOscillator();
  vib.frequency.value = 13;
  const vibGain = ctx.createGain();
  vibGain.gain.value = 35;
  vib.connect(vibGain).connect(o.frequency);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, v.t0);
  g.gain.exponentialRampToValueAtTime(0.5, v.t0 + 0.1);
  g.gain.setValueAtTime(0.5, v.t0 + seconds * 0.8);
  g.gain.exponentialRampToValueAtTime(0.0001, v.t0 + seconds);
  o.connect(g).connect(v.input);
  o.start(v.t0);
  vib.start(v.t0);
  o.stop(v.t0 + seconds + 0.02);
  vib.stop(v.t0 + seconds + 0.02);
  noiseBurst(v.input, v.t0, 'lowpass', 1200, 0.5, 0.6, 0.02, seconds * 0.9);
  return (p: Vector3) => v.setPosition(p);
}

/** Firework burst. The boom arrives late from far away: sound travels at 343 m/s. */
export function burst(at: Vector3, distance: number, crackle: boolean): void {
  const delay = distance / 343;
  const v = audio.voice({ at, life: 2.6, wet: 0.6, gain: 1.0, ref: 18, delay });
  if (!v) return;
  const t = v.t0;
  tone(v.input, t, 'sine', 75, 1, 0.004, 0.7, 32);
  noiseBurst(v.input, t, 'lowpass', 2600, 0.7, 1, 0.003, 1.4, 160);
  if (crackle) {
    const ctx = audio.ctx!;
    for (let i = 0; i < 26; i++) {
      const ct = t + 0.35 + Math.random() * 1.3;
      const src = audio.noiseSource(ct, 1);
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value = 2500 + Math.random() * 4000;
      f.Q.value = 3;
      const g = ctx.createGain();
      env(g, ct, 0.18 + Math.random() * 0.3, 0.001, 0.02 + Math.random() * 0.03);
      src.connect(f).connect(g).connect(v.input);
      src.stop(ct + 0.08);
    }
  }
}

/** A soft sparkle chime (paint colour picked, orb touched, …). */
export function sparkle(at: Vector3, pitch = 1): void {
  const v = audio.voice({ at, life: 0.9, wet: 0.4, gain: 0.18 });
  if (!v) return;
  const base = 1568 * pitch;
  tone(v.input, v.t0, 'sine', base, 0.8, 0.002, 0.6);
  tone(v.input, v.t0 + 0.06, 'sine', base * 1.5, 0.5, 0.002, 0.5);
  tone(v.input, v.t0 + 0.12, 'sine', base * 2, 0.35, 0.002, 0.45);
}

/** Respawn "poof". */
export function poof(at: Vector3): void {
  const v = audio.voice({ at, life: 0.4, gain: 0.3, wet: 0.2 });
  if (!v) return;
  noiseBurst(v.input, v.t0, 'bandpass', 600, 0.9, 0.9, 0.01, 0.3, 2400);
}

/** Deep magical swell for gravity / scale changes (head-locked). */
export function swell(up: boolean): void {
  const v = audio.voice({ life: 1.8, gain: 0.3, wet: 0.5 });
  if (!v) return;
  const f0 = up ? 110 : 220;
  const f1 = up ? 220 : 110;
  tone(v.input, v.t0, 'sine', f0, 0.8, 0.4, 1.3, f1);
  tone(v.input, v.t0, 'triangle', f0 * 1.5, 0.3, 0.4, 1.3, f1 * 1.5);
  noiseBurst(v.input, v.t0, 'bandpass', up ? 400 : 2000, 1, 0.3, 0.5, 1.2, up ? 2000 : 400);
}
