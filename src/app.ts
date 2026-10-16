import { Color, Material, Mesh, Object3D, PerspectiveCamera, Quaternion, Scene, Group, Vector3, type WebGLRenderer } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { flags, SPAWN } from './config';
import { bus } from './core/events';
import { clamp, damp } from './core/math';
import { createRenderer } from './core/renderer';
import { settings } from './core/settings';
import { Stats } from './core/stats';
import { XRSessionManager } from './core/xr-session';
import { XRInput, type HandInput } from './input/xr-input';
import { Physics } from './physics/physics';
import { Sky } from './world/sky';
import { TimeOfDay, type TimeName } from './world/time-of-day';
import { Clouds } from './world/clouds';
import { buildScenery, type Scenery } from './world/scenery';
import { Fireflies } from './world/fireflies';
import { PlayArea } from './world/play-area';
import { audio } from './audio/audio';
import { Ambience } from './audio/ambience';
import { swell } from './audio/sfx';
import { createHandMaterial, HandModel } from './hands/hand-model';
import { Particles } from './fx/particles';
import { GrabSystem } from './interact/grab';
import { GravityGloves } from './interact/gloves';
import { Locomotion } from './interact/locomotion';
import { Toys } from './toys/toys';
import { Brushes } from './toys/brush';
import { Marimba } from './toys/marimba';
import { Fireworks } from './toys/fireworks';
import { ControlConsole } from './toys/console';
import { WristMenu } from './ui/wrist-menu';
import { buildSign } from './ui/sign';
import { inRangeLane } from './world/layout';
import { TargetRange } from './archery/targets';
import { ArrowSystem } from './archery/arrows';
import { Bow } from './archery/bow';
import { EYES_ONLY_LAYER } from './archery/scope';
import { SkyBoat } from './skyboat/skyboat';

const GIANT_SCALE = 8;
const _follow = new Vector3();

export class App {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  /** Player root: tracking space is placed in the world through this. */
  readonly rig = new Group();
  /** The XR camera (child of the rig). */
  // Near/far as tight as the scene allows: depth precision at 30-60 m (the targets)
  // depends on far/near, and the sky is drawn at the far plane anyway.
  readonly xrCamera = new PerspectiveCamera(70, 1, 0.05, 1500);
  /** Free camera for the desktop preview. */
  readonly desktopCamera = new PerspectiveCamera(60, 1, 0.05, 1500);
  readonly input = new XRInput();
  readonly xr: XRSessionManager;
  readonly stats = new Stats();
  readonly rigQuat = new Quaternion();
  physics!: Physics;
  sky!: Sky;
  tod!: TimeOfDay;
  clouds!: Clouds;
  scenery!: Scenery;
  fireflies!: Fireflies;
  playArea!: PlayArea;
  fx!: Particles;
  handModels!: { left: HandModel; right: HandModel };
  grab!: GrabSystem;
  gloves!: GravityGloves;
  locomotion!: Locomotion;
  toys!: Toys;
  brushes!: Brushes;
  marimba!: Marimba;
  fireworks!: Fireworks;
  console!: ControlConsole;
  wristMenu!: WristMenu;
  range!: TargetRange;
  arrows!: ArrowSystem;
  bow!: Bow;
  boat!: SkyBoat;
  readonly ambience = new Ambience();
  private orbit!: OrbitControls;
  private readonly shadowTarget = new Object3D();
  rigScale = 1;
  private scaleTarget = 1;
  /** Extra height when the runtime only offers 'local' (eye-level origin). */
  floorOffset = 0;
  time = 0;
  frameCount = 0;
  private last = performance.now();
  readonly errors: string[] = [];
  /** Called once per frame after everything updated (tests hook in here). */
  onFrame: ((dt: number) => void) | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = createRenderer(canvas, settings.quality);
    this.xr = new XRSessionManager(this.renderer);
  }

  get inXR(): boolean {
    return this.renderer.xr.isPresenting;
  }

  get camera(): PerspectiveCamera {
    return this.inXR ? this.xrCamera : this.desktopCamera;
  }

  get giant(): boolean {
    return this.scaleTarget > 1;
  }

  handModel(h: HandInput): HandModel {
    return h.handedness === 'left' ? this.handModels.left : this.handModels.right;
  }

  async init(): Promise<void> {
    this.physics = await Physics.create();
    const scene = this.scene;
    scene.name = 'skyreach';
    const quality = settings.quality;

    // Sky, light, fog.
    this.sky = new Sky();
    scene.add(this.sky.mesh, this.shadowTarget);
    const initial = (['sunset', 'night', 'day'].includes(flags.time) ? flags.time : 'sunset') as TimeName;
    this.tod = new TimeOfDay(this.sky, initial, this.shadowTarget);
    scene.add(this.tod.hemi, this.tod.key);
    scene.fog = this.tod.fog;
    this.configureShadows();

    this.clouds = new Clouds(quality, inRangeLane);
    scene.add(this.clouds.sea, this.clouds.puffs);
    this.scenery = buildScenery(this.physics, quality);
    scene.add(this.scenery.root);
    this.fireflies = new Fireflies(quality === 'high' ? 260 : 120);
    scene.add(this.fireflies.points);
    scene.add(buildSign());

    // Player.
    this.rig.name = 'rig';
    this.rig.position.set(SPAWN.x, SPAWN.y, SPAWN.z);
    this.rig.rotation.y = SPAWN.yaw;
    this.rig.add(this.xrCamera);
    scene.add(this.rig, this.desktopCamera);
    // The scope lens is drawn for the eyes only, never into the scope's own view.
    this.xrCamera.layers.enable(EYES_ONLY_LAYER);
    this.desktopCamera.layers.enable(EYES_ONLY_LAYER);
    this.playArea = new PlayArea(this.rig);

    this.fx = new Particles(quality === 'high' ? 6000 : 3000);
    scene.add(this.fx.points);

    const handMat = createHandMaterial();
    this.handModels = { left: new HandModel('left', handMat), right: new HandModel('right', handMat) };
    scene.add(this.handModels.left.root, this.handModels.right.root);

    // Interaction and toys.
    this.grab = new GrabSystem(this);
    this.gloves = new GravityGloves(this);
    this.locomotion = new Locomotion(this);
    this.toys = new Toys(this);
    this.brushes = new Brushes(this);
    this.marimba = new Marimba(this);
    this.fireworks = new Fireworks(this);
    this.console = new ControlConsole(this, {
      reset: () => this.resetToys(),
      finale: () => this.fireworks.finale(),
      sky: () => {
        const name = this.tod.next();
        bus.emit('time-of-day', { name });
      },
      giant: () => this.setGiant(!this.giant),
    });
    this.wristMenu = new WristMenu(this);
    this.range = new TargetRange(this);
    this.arrows = new ArrowSystem(this);
    this.bow = new Bow(this);
    this.boat = new SkyBoat(this);
    this.physics.beforeStep = (_dt, ahead) => {
      this.grab.beforeStep();
      this.boat.beforeStep(ahead);
    };

    this.tod.onChange((p) => {
      this.clouds.applyPreset(p);
      this.scenery.crystalMaterial.color.setScalar(p.glow);
      this.toys.setGlow(p.glow);
      this.range.setGlow(p.glow);
      this.boat.setGlow(p.glow);
      this.bow.scope.setLook(p.zenith, p.horizon, p.skySunDir, p.glow);
      this.ambience.setMood(p.night);
    });

    // Desktop preview camera.
    this.desktopCamera.position.set(6.8, 4.2, 10.5);
    this.orbit = new OrbitControls(this.desktopCamera, this.renderer.domElement);
    this.orbit.target.set(0, 0.9, -0.6);
    this.orbit.enableDamping = true;
    this.orbit.maxDistance = 70;
    this.orbit.maxPolarAngle = Math.PI * 0.62;
    this.orbit.update();

    this.xr.onStart = (_s, info) => {
      this.floorOffset = info.referenceSpace === 'local' ? 1.6 : 0;
      this.rig.position.y = SPAWN.y + this.floorOffset;
      this.playArea.setSpace(info.boundedSpace);
      this.ambience.start();
      audio.setMusic(settings.music);
    };
    this.xr.onEnd = () => {
      this.bow.cancel();
      this.boat.releaseControls();
      this.grab.releaseAll();
      this.input.clear();
      this.locomotion.reset();
      this.playArea.clear();
      this.handModels.left.root.visible = this.handModels.right.root.visible = false;
      this.resize();
    };

    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  private configureShadows(): void {
    const key = this.tod.key;
    key.castShadow = settings.quality === 'high';
    key.shadow.mapSize.set(2048, 2048);
    const cam = key.shadow.camera;
    cam.left = -11;
    cam.right = 11;
    cam.top = 11;
    cam.bottom = -11;
    cam.near = 5;
    cam.far = 90;
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.03;
  }

  resize(): void {
    if (this.inXR) {
      // IWER (the emulator) sizes the canvas from the window: keep it in sync.
      if (flags.emulate) {
        const c = this.renderer.domElement;
        if (window.innerWidth > 0 && (c.width !== window.innerWidth || c.height !== window.innerHeight)) {
          c.width = window.innerWidth;
          c.height = window.innerHeight;
        }
      }
      return;
    }
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.desktopCamera.aspect = w / Math.max(h, 1);
    this.desktopCamera.updateProjectionMatrix();
  }

  start(): void {
    this.renderer.setAnimationLoop((t, frame) => this.frame(t, frame));
  }

  async enterVR(): Promise<void> {
    await audio.unlock();
    await this.xr.start();
  }

  private frame(_t: number, xrFrame?: XRFrame): void {
    const now = performance.now();
    const dt = Math.min((now - this.last) / 1000, 0.1);
    this.last = now;
    this.time += dt;
    this.frameCount++;
    try {
      this.update(dt, xrFrame);
    } catch (err) {
      this.report(err);
    }
    this.renderer.render(this.scene, this.camera);
    this.stats.tick(dt, this.renderer);
  }

  private update(dt: number, xrFrame?: XRFrame): void {
    const inXR = this.inXR;
    if (inXR && xrFrame) {
      if (flags.emulate && this.renderer.domElement.width === 0) this.resize();
      const ref = this.renderer.xr.getReferenceSpace();
      if (ref) {
        this.input.update(xrFrame, ref);
        this.playArea.update(xrFrame, ref);
      }
      const info = this.xr.info;
      const layer = xrFrame.session.renderState.baseLayer;
      if (info && layer && !info.framebuffer) info.framebuffer = { width: layer.framebufferWidth, height: layer.framebufferHeight };
    }
    this.updateScale(dt);
    this.updateRig();
    // The skyboat flies first and carries you, so everything below sees hands where they are.
    if (this.boat.update(dt)) this.updateRig();

    const busy = new Set<HandInput>();
    const claimed = new Set<HandInput>();
    if (inXR) {
      this.wristMenu.update(dt);
      if (this.wristMenu.engaged) busy.add(this.input.right);
      if (this.locomotion.update(dt, busy)) this.updateRig();
      this.console.update(dt, claimed);
      this.boat.controls(claimed);
      this.bow.preUpdate(claimed);
      for (const h of claimed) busy.add(h);
      this.grab.update(dt, claimed);
      this.gloves.update(dt, busy);
    }
    this.bow.update(dt);
    this.range.update(dt, this.time);
    this.arrows.update(dt);
    this.brushes.update(this.time);
    this.marimba.update(dt);
    this.fireworks.update(dt);
    this.toys.update(this.time);

    this.physics.step(dt);
    this.physics.syncVisuals();
    this.grab.placeVisuals();
    this.grab.flushHighlights();

    for (const h of this.input.hands) {
      const holding = !!this.grab.held(h) || claimed.has(h);
      this.handModel(h).update(h, h.grip.matrix, this.rigScale, holding, dt, settings.jointHands);
    }

    this.fx.update(dt);
    // Shadows follow the player: the boat can take you far from the island.
    if (inXR) this.tod.follow(this.headPosition(_follow).setY(this.rig.position.y - this.floorOffset * this.rigScale));
    else this.tod.follow(this.orbit.target);
    this.tod.update(dt);
    this.fireflies.update(this.time, this.tod.night);
    this.sky.update(this.camera, this.time);
    this.clouds.update(this.time, this.camera);
    this.ambience.update();
    if (!inXR) this.orbit.update();
    audio.updateListener(this.camera);
    // Last: the bow and the player's head are where they'll be drawn this frame.
    this.bow.lateUpdate(dt, this.time);
    this.onFrame?.(dt);
  }

  private report(err: unknown): void {
    const msg = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
    if (this.errors.includes(msg)) return;
    this.errors.push(msg);
    if (this.errors.length > 20) this.errors.shift();
    console.error('[skyreach] frame error:', err);
  }

  /** Recompose world-space poses after the rig moved. */
  updateRig(): void {
    this.rig.scale.setScalar(this.rigScale);
    this.rig.updateMatrixWorld(true);
    this.rig.getWorldQuaternion(this.rigQuat);
    if (this.inXR) {
      this.renderer.xr.updateCamera(this.xrCamera);
      this.input.updateWorld(this.rig.matrixWorld, this.rigQuat, this.rigScale);
    }
  }

  /** Head position in world space (desktop: camera position). */
  headPosition(out: Vector3): Vector3 {
    if (this.inXR && this.input.head.valid) return out.copy(this.input.head.position);
    return this.camera.getWorldPosition(out);
  }

  // ---- World actions (console buttons, wrist menu, tests) ----

  setGravity(on: boolean): void {
    this.physics.setGravity(on);
    this.fx.gravityScale = on ? 1 : 0.08;
    swell(!on);
    bus.emit('gravity', { on });
  }

  setGiant(on: boolean): void {
    this.scaleTarget = on ? GIANT_SCALE : 1;
    swell(on);
    bus.emit('scale', { giant: on, scale: this.scaleTarget });
  }

  /** Grow/shrink smoothly around the head so you don't slide sideways. */
  private updateScale(dt: number): void {
    if (this.rigScale === this.scaleTarget) return;
    const head = this.headPosition(new Vector3());
    let s = this.rigScale + (this.scaleTarget - this.rigScale) * damp(1.6, dt);
    if (Math.abs(s - this.scaleTarget) < 0.01 * this.scaleTarget) s = this.scaleTarget;
    s = clamp(s, 1, GIANT_SCALE);
    // Keep the head's xz fixed while the rig scales about its origin.
    const rel = head.sub(this.rig.position);
    const k = s / this.rigScale;
    this.rig.position.x -= rel.x * (k - 1);
    this.rig.position.z -= rel.z * (k - 1);
    this.rigScale = s;
  }

  resetToys(): void {
    this.toys.reset();
    this.fireworks.reset();
    for (const p of [...this.brushes.brushes, ...this.marimba.mallets]) {
      if (p.heldBy) this.grab.forceRelease(p.heldBy);
      this.physics.respawn(p);
    }
    if (this.console.zeroG) this.console.setZeroG(false);
    this.bow.dock();
    this.arrows.clear();
    this.range.resetScore();
    this.boat.reset();
  }

  applyQuality(): void {
    const high = settings.quality === 'high';
    this.renderer.shadowMap.enabled = high;
    this.tod.key.castShadow = high;
    this.scene.traverse((o) => {
      const m = (o as Mesh).material as Material | Material[] | undefined;
      if (!m) return;
      for (const mat of Array.isArray(m) ? m : [m]) mat.needsUpdate = true;
    });
    if (!this.inXR) {
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, high ? 2 : 1.25));
      this.renderer.xr.setFramebufferScaleFactor(high ? 1.0 : 0.85);
      this.resize();
    }
  }

  applyMusic(): void {
    audio.setMusic(settings.music);
  }

  /** Background colour for the page behind the canvas (matches the horizon). */
  horizonColor(): Color {
    return this.tod.current.horizon;
  }
}
