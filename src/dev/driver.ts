import { Matrix4, Quaternion, Vector3 } from 'three';
import { SPAWN } from '../config';
import { bus, type EventName } from '../core/events';
import { DEG } from '../core/math';
import type { App } from '../app';
import type { Emu, EmuButton } from './emulator';

export type Side = 'left' | 'right';

/**
 * Drives the emulated headset in *world* coordinates (the emulator itself
 * works in tracking space), waits on real frames, and reads events.
 * Used by the self-test, and exposed as `window.__driver` with ?emulate
 * for poking at the app from a console or an agent.
 */
export function createDriver(app: App, emu: Emu) {
  const waiters: { n: number; resolve: () => void }[] = [];
  const prevOnFrame = app.onFrame;
  app.onFrame = (dt) => {
    prevOnFrame?.(dt);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (--waiters[i].n <= 0) {
        waiters[i].resolve();
        waiters.splice(i, 1);
      }
    }
  };
  const gripOffset = { left: new Matrix4(), right: new Matrix4() };

  const d = {
    app,
    emu,
    frames: (n: number) => new Promise<void>((resolve) => waiters.push({ n, resolve })),
    async seconds(s: number) {
      const t0 = performance.now();
      while (performance.now() - t0 < s * 1000) await d.frames(1);
    },
    async waitFor(pred: () => boolean, timeoutS: number, what: string) {
      const t0 = performance.now();
      while (!pred()) {
        if (performance.now() - t0 > timeoutS * 1000) throw new Error(`timed out waiting for ${what}`);
        await d.frames(1);
      }
    },
    count: (e: EventName) => bus.count(e),
    last: (e: EventName) => [...bus.recent].reverse().find((x) => x.name === e)?.data,

    /** Grip pose relative to aim pose, per controller (tracking space). */
    measureGripOffsets() {
      for (const side of ['left', 'right'] as Side[]) {
        const h = app.input[side];
        gripOffset[side].copy(h.aimRef).invert().multiply(h.gripRef);
      }
    },
    rigInv: () => app.rig.matrixWorld.clone().invert(),
    setAimWorld(side: Side, pos: Vector3, quat: Quaternion) {
      const m = new Matrix4().compose(pos, quat, new Vector3(1, 1, 1)).premultiply(d.rigInv());
      const p = new Vector3();
      const q = new Quaternion();
      m.decompose(p, q, new Vector3());
      const c = emu.device.controllers[side]!;
      c.position.set(p.x, p.y, p.z);
      c.quaternion.set(q.x, q.y, q.z, q.w);
    },
    /** Put the grip (palm centre) at a world pose. */
    setGripWorld(side: Side, pos: Vector3, quat: Quaternion) {
      const aim = new Matrix4().compose(pos, quat, new Vector3(1, 1, 1)).multiply(gripOffset[side].clone().invert());
      const p = new Vector3();
      const q = new Quaternion();
      aim.decompose(p, q, new Vector3());
      d.setAimWorld(side, p, q);
    },
    /**
     * Place a hand so its string-pinch point (grip + 3 cm along the aim ray, see Bow)
     * lands on `pinch`, with the controller's aim frame at `aimQuat`.
     */
    setPinchWorld(side: Side, pinch: Vector3, aimQuat: Quaternion) {
      const offT = new Vector3().setFromMatrixPosition(gripOffset[side]);
      const aimFwd = new Vector3(0, 0, -1).applyQuaternion(aimQuat);
      const gripPos = pinch.clone().addScaledVector(aimFwd, -0.03);
      d.setAimWorld(side, gripPos.sub(offT.applyQuaternion(aimQuat)), aimQuat);
    },
    setHeadWorld(pos: Vector3, yawDeg = 0, pitchDeg = 0) {
      const q = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), yawDeg * DEG).multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), pitchDeg * DEG));
      const m = new Matrix4().compose(pos, q, new Vector3(1, 1, 1)).premultiply(d.rigInv());
      const p = new Vector3();
      const qq = new Quaternion();
      m.decompose(p, qq, new Vector3());
      emu.device.position.set(p.x, p.y, p.z);
      emu.device.quaternion.set(qq.x, qq.y, qq.z, qq.w);
    },
    press(side: Side, b: EmuButton, v: number) {
      emu.press(side, b, v);
      emu.touch(side, b, v > 0);
    },
    lookQuat: (from: Vector3, to: Vector3) => new Quaternion().setFromRotationMatrix(new Matrix4().lookAt(from, to, new Vector3(0, 1, 0))),
    qx: (deg: number) => new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), deg * DEG),
    head: () => app.headPosition(new Vector3()),
    /** Move the grip from a to b over `s` seconds at real frame rate; `onLast` runs on the final pose. */
    async sweepGrip(side: Side, a: Vector3, b: Vector3, s: number, quat: Quaternion, onLast?: () => void) {
      const t0 = performance.now();
      for (;;) {
        const t = Math.min(1, (performance.now() - t0) / 1000 / s);
        d.setGripWorld(side, a.clone().lerp(b, t), quat);
        if (t >= 1) {
          onLast?.();
          await d.frames(1);
          return;
        }
        await d.frames(1);
      }
    },
    /** Fingertip position relative to the grip for the current (open) hand pose. */
    async fingertipOffset(side: Side): Promise<Vector3> {
      await d.frames(18);
      return app.handModels[side].indexTip(new Vector3()).sub(app.input[side].grip.position);
    },
    restHands() {
      const hp = d.head();
      d.setGripWorld('left', hp.clone().add(new Vector3(-0.2, -0.45, -0.3)), new Quaternion());
      d.setGripWorld('right', hp.clone().add(new Vector3(0.2, -0.45, -0.3)), new Quaternion());
    },
    releaseButtons() {
      for (const side of ['left', 'right'] as Side[]) {
        const btns: EmuButton[] = side === 'left' ? ['trigger', 'squeeze', 'x-button', 'y-button', 'thumbstick'] : ['trigger', 'squeeze', 'a-button', 'b-button', 'thumbstick'];
        for (const b of btns) d.press(side, b, 0);
        emu.stick(side, 0, 0);
      }
    },
    /** Everything back to the start: spawn point, normal size, gravity on, toys home. */
    async resetWorld() {
      d.releaseButtons();
      await d.frames(2);
      app.grab.releaseAll();
      if (app.giant) app.setGiant(false);
      await d.waitFor(() => app.rigScale === 1, 6, 'scale back to 1');
      app.rig.position.set(SPAWN.x, SPAWN.y + app.floorOffset, SPAWN.z);
      app.rig.rotation.y = SPAWN.yaw;
      app.updateRig();
      app.resetToys();
      d.setHeadWorld(new Vector3(SPAWN.x, 1.6, SPAWN.z));
      d.restHands();
      await d.frames(8);
    },
  };
  return d;
}

export type Driver = ReturnType<typeof createDriver>;
