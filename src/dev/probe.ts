import { Vector3 } from 'three';
import { bus } from '../core/events';
import { settings } from '../core/settings';
import type { App } from '../app';
import type { Emu } from './emulator';
import type { SnapshotOptions } from './snapshot';

const r3 = (v: { x: number; y: number; z: number }) => [+v.x.toFixed(3), +v.y.toFixed(3), +v.z.toFixed(3)];

/**
 * `window.__vr`: a read-only window into the running app for tests, agents and
 * curious humans with a console open. Cheap: nothing runs until you call it.
 */
export function installProbe(app: App, emu: Emu | null): void {
  const probe = {
    version: '0.1.0',
    app,
    emu,
    bus,
    state() {
      const hand = (h: typeof app.input.left) => ({
        connected: h.connected,
        grip: r3(h.grip.position),
        held: app.grab.held(h)?.id ?? null,
        glove: app.gloves.phase(h),
        gloveTarget: app.gloves.target(h)?.id ?? null,
        trigger: +h.trigger.value.toFixed(2),
        squeeze: +h.squeeze.value.toFixed(2),
        profiles: h.profiles,
        haptics: h.hapticsAvailable,
        joints: h.jointsValid,
      });
      return {
        inXR: app.inXR,
        frame: app.frameCount,
        fps: +app.stats.fps.toFixed(1),
        frameMs: +app.stats.frameMs.toFixed(2),
        worstMs: +app.stats.worstMs.toFixed(1),
        calls: app.stats.calls,
        triangles: app.stats.triangles,
        rig: { pos: r3(app.rig.position), yawDeg: +((app.rig.rotation.y * 180) / Math.PI).toFixed(1), scale: +app.rigScale.toFixed(3) },
        head: r3(app.headPosition(new Vector3())),
        left: hand(app.input.left),
        right: hand(app.input.right),
        gravity: app.physics.gravityOn,
        giant: app.giant,
        timeOfDay: app.tod.name,
        menu: app.wristMenu.visible,
        paint: { strokes: app.brushes.strokes.length, points: app.brushes.pointCount },
        notes: app.marimba.notesPlayed,
        fireworks: { flying: app.fireworks.flying, bursts: app.fireworks.bursts },
        particles: app.fx.active,
        session: app.xr.info
          ? { ...app.xr.info, boundedSpace: !!app.xr.info.boundedSpace, playAreaPoints: app.playArea.points }
          : null,
        boat: {
          pos: r3(app.boat.pos),
          bearing: +app.boat.bearing.toFixed(1),
          speed: +app.boat.speed.toFixed(2),
          climb: +app.boat.climb.toFixed(2),
          throttle: +app.boat.throttle.toFixed(2),
          lift: +app.boat.lift.toFixed(2),
          wheelDeg: +((app.boat.wheel * 180) / Math.PI).toFixed(0),
          aboard: app.boat.aboard,
        },
        laser: { level: +app.bow.laser.level.toFixed(2), hit: app.bow.laser.hit.kind, id: app.bow.laser.hit.id, distance: +app.bow.laser.hit.distance.toFixed(1) },
        flares: {
          guns: app.flares.guns.map((g) => ({ id: g.prop.id, docked: g.docked, held: g.held?.handedness ?? null, open: g.open, chamber: g.chamber?.id ?? null, spent: g.spent, shots: g.shots })),
          inAir: app.flares.flights.summary(),
          smoke: app.flares.smoke.count,
          spot: Math.round(app.flares.lights.spot.intensity),
        },
        settings: { ...settings },
        counts: { ...bus.counts },
        errors: app.errors.length,
      };
    },
    events(n = 20) {
      return bus.recent.slice(-n).map((e) => ({ name: e.name, ...e.data }));
    },
    /** Dev server only: render the view to .snapshots/<name>.png. */
    async snapshot(name: string, opts: SnapshotOptions = {}) {
      const { snapshot } = await import('./snapshot');
      return snapshot(app, name, opts);
    },
    prop(id: string) {
      const p = app.physics.props.find((x) => x.id === id);
      if (!p) return null;
      const v = p.body.linvel();
      return { id, pos: r3(p.object.position), spawn: r3(p.spawnPos), vel: r3(v), held: p.heldBy?.handedness ?? null, parked: p.parked };
    },
  };
  (window as unknown as { __vr: typeof probe }).__vr = probe;
}
