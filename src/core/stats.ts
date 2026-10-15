import type { WebGLRenderer } from 'three';

/** Frame timing and render counters, smoothed for display. */
export class Stats {
  fps = 0;
  frameMs = 0;
  calls = 0;
  triangles = 0;
  /** Worst frame in the last second (ms). */
  worstMs = 0;
  private acc = 0;
  private frames = 0;
  private worst = 0;

  tick(dtSeconds: number, renderer: WebGLRenderer): void {
    const ms = dtSeconds * 1000;
    this.frameMs += (ms - this.frameMs) * 0.08;
    this.worst = Math.max(this.worst, ms);
    this.acc += dtSeconds;
    this.frames++;
    if (this.acc >= 1) {
      this.fps = this.frames / this.acc;
      this.worstMs = this.worst;
      this.acc = 0;
      this.frames = 0;
      this.worst = 0;
    }
    this.calls = renderer.info.render.calls;
    this.triangles = renderer.info.render.triangles;
  }
}
