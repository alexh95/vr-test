/**
 * Emulator-only: keep frames coming when the page is hidden.
 *
 * Browsers pause requestAnimationFrame for hidden pages, which stalls the
 * emulated headset (IWER drives its frame loop with rAF). An agent running the
 * self-test often has the page in a background pane, so we route rAF through
 * one queue that is flushed by the real rAF while visible and by a worker
 * ticking at 72 Hz while hidden. Worker timers aren't throttled like page timers.
 * Never installed for real headsets: their frame loop comes from the XR runtime.
 */
export function installHiddenFrameClock(hz = 72): void {
  const nativeRAF = window.requestAnimationFrame.bind(window);
  const pending = new Map<number, FrameRequestCallback>();
  let nextId = 1;
  let nativeScheduled = false;

  const flush = (t: number) => {
    nativeScheduled = false;
    if (pending.size === 0) return;
    const callbacks = [...pending.values()];
    pending.clear();
    for (const cb of callbacks) {
      try {
        cb(t);
      } catch (err) {
        console.error(err);
      }
    }
  };

  const src = `setInterval(() => postMessage(0), ${Math.round(1000 / hz)});`;
  const worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
  worker.onmessage = () => {
    if (document.visibilityState !== 'visible') flush(performance.now());
  };

  window.requestAnimationFrame = (cb: FrameRequestCallback): number => {
    const id = nextId++;
    pending.set(id, cb);
    if (!nativeScheduled && document.visibilityState === 'visible') {
      nativeScheduled = true;
      nativeRAF(flush);
    }
    return id;
  };
  window.cancelAnimationFrame = (id: number): void => {
    pending.delete(id);
  };
}
