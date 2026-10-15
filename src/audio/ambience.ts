import { audio } from './audio';

/**
 * Wind plus a slow generative pad in C major pentatonic, so anything played on
 * the marimba sits in key. Runs on the music bus, which the wrist menu mutes.
 */
export class Ambience {
  private started = false;
  private windGain: GainNode | null = null;
  private nextChord = 0;
  private chordIndex = 0;
  private nextBell = 0;
  private padLevel = 1;

  // Cmaj9, Am7(add11), Fmaj7#11-ish, G6sus: all pentatonic-friendly.
  private readonly chords = [
    [48, 55, 64, 71, 74],
    [45, 52, 60, 67, 74],
    [41, 48, 57, 64, 67],
    [43, 50, 59, 64, 69],
  ];
  private readonly bellNotes = [72, 74, 76, 79, 81, 84, 86, 88];

  start(): void {
    const ctx = audio.ctx;
    const bus = audio.musicInput;
    if (this.started || !ctx || !bus) return;
    this.started = true;

    // Wind: band-passed noise with two slow LFOs for gusts.
    const src = audio.noiseSource(ctx.currentTime, 0.5);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 420;
    bp.Q.value = 0.55;
    const g = ctx.createGain();
    g.gain.value = 0.05;
    this.windGain = g;
    const lfo1 = ctx.createOscillator();
    lfo1.frequency.value = 0.07;
    const l1 = ctx.createGain();
    l1.gain.value = 220;
    lfo1.connect(l1).connect(bp.frequency);
    const lfo2 = ctx.createOscillator();
    lfo2.frequency.value = 0.113;
    const l2 = ctx.createGain();
    l2.gain.value = 0.025;
    lfo2.connect(l2).connect(g.gain);
    lfo1.start();
    lfo2.start();
    src.connect(bp).connect(g).connect(bus);

    this.nextChord = ctx.currentTime + 0.5;
    this.nextBell = ctx.currentTime + 4;
  }

  /** Night is calmer: less wind, softer pad. */
  setMood(night: number): void {
    const ctx = audio.ctx;
    if (!ctx || !this.windGain) return;
    this.windGain.gain.setTargetAtTime(0.05 * (1 - 0.6 * night), ctx.currentTime, 1.5);
    this.padLevel = 1 - 0.3 * night;
  }

  update(): void {
    const ctx = audio.ctx;
    const bus = audio.musicInput;
    if (!this.started || !ctx || !bus || !audio.musicEnabled) return;
    const now = ctx.currentTime;
    if (now + 0.2 >= this.nextChord) {
      this.playChord(this.chords[this.chordIndex], this.nextChord, 10);
      this.chordIndex = (this.chordIndex + 1) % this.chords.length;
      this.nextChord += 9;
    }
    if (now >= this.nextBell) {
      const n = this.bellNotes[Math.floor(Math.random() * this.bellNotes.length)];
      this.bell(midi(n), now + 0.05);
      this.nextBell = now + 2.5 + Math.random() * 5;
    }
  }

  private playChord(notes: number[], t: number, dur: number): void {
    const ctx = audio.ctx!;
    const bus = audio.musicInput!;
    const verb = audio.reverbInput!;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 900;
    lp.Q.value = 0.3;
    const g = ctx.createGain();
    const level = 0.022 * this.padLevel;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(level, t + 3);
    g.gain.setValueAtTime(level, t + dur - 3.5);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    lp.connect(g);
    g.connect(bus);
    const send = ctx.createGain();
    send.gain.value = 0.6;
    g.connect(send).connect(verb);
    for (const n of notes) {
      for (const detune of [-7, 6]) {
        const o = ctx.createOscillator();
        o.type = 'triangle';
        o.frequency.value = midi(n);
        o.detune.value = detune;
        o.connect(lp);
        o.start(t);
        o.stop(t + dur + 0.1);
      }
    }
    window.setTimeout(() => {
      g.disconnect();
      send.disconnect();
    }, (t - ctx.currentTime + dur + 0.5) * 1000);
  }

  private bell(freq: number, t: number): void {
    const ctx = audio.ctx!;
    const bus = audio.musicInput!;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.018 * this.padLevel, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 2.5);
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = freq;
    const o2 = ctx.createOscillator();
    o2.type = 'sine';
    o2.frequency.value = freq * 3;
    const g2 = ctx.createGain();
    g2.gain.value = 0.2;
    o.connect(g);
    o2.connect(g2).connect(g);
    g.connect(bus);
    const send = ctx.createGain();
    send.gain.value = 1;
    g.connect(send).connect(audio.reverbInput!);
    o.start(t);
    o2.start(t);
    o.stop(t + 2.6);
    o2.stop(t + 2.6);
    window.setTimeout(() => {
      g.disconnect();
      send.disconnect();
    }, 3200);
  }
}

export function midi(n: number): number {
  return 440 * Math.pow(2, (n - 69) / 12);
}
