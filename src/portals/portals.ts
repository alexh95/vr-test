import {
  type Camera,
  CatmullRomCurve3,
  Color,
  CylinderGeometry,
  DoubleSide,
  Group,
  Matrix4,
  Mesh,
  MeshLambertMaterial,
  MeshStandardMaterial,
  OctahedronGeometry,
  PerspectiveCamera,
  Plane,
  Quaternion,
  ShaderMaterial,
  SRGBColorSpace,
  type Texture,
  TubeGeometry,
  Vector2,
  Vector3,
  Vector4,
  WebGLRenderTarget,
} from 'three';
import { bus } from '../core/events';
import { clamp, smoothstep } from '../core/math';
import { mergeColored } from '../core/merge';
import { settings } from '../core/settings';
import { RAPIER } from '../physics/physics';
import { portalHum, portalWhoosh, type PortalHum } from '../audio/sfx';
import { audio } from '../audio/audio';
import { LAYOUT, PERCH_FACING, PERCH_PORTAL } from '../world/layout';
import type { App } from '../app';

/** The opening: an ellipse this wide and tall (half-axes), its centre this high above the plinth. */
export const RX = 0.68;
export const RY = 1.15;
const PLINTH = 0.14;
const CY = PLINTH + 1.32;
/** The stone hoop around the opening (centre-line half-axes and tube radius). */
const HOOP_RX = RX + 0.07;
const HOOP_RY = RY + 0.07;
const HOOP_TUBE = 0.075;
/** Beyond this distance a portal shows a swirl instead of rendering its live view. */
const VIEW_RANGE = 45;
/** View slots: the two eyes, the desktop camera, and one spare (snapshots). */
const SLOTS = 4;
/** The clip plane stays at least this far in front of a view camera (a head right at the opening). */
const MIN_CLIP = 0.06;
/** In a view through a portal, small things smaller than this (radius over distance) are left out: a few pixels at most. */
const DETAIL_ANGLE = 0.005;
/** Closer than this, the view through gets its own sun shadows (one extra shadow pass a frame). */
const SHADOW_RANGE = 12;

const ROT_PI = new Matrix4().makeRotationY(Math.PI);
const _a = new Vector3();
const _b = new Vector3();
const _c = new Vector3();
const _p = new Vector3();
const _q = new Quaternion();
const _s = new Vector3();
const _m = new Matrix4();
const _sub = new Matrix4();
const _plane = new Plane();
const _clip = new Vector4();
const _oq = new Vector4();
const _v4 = new Vector4();
const _corner = new Vector3();
const _size = new Vector2();

const vertex = /* glsl */ `
varying vec2 vLocal;
void main() {
  vLocal = position.xy;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const fragment = /* glsl */ `
uniform sampler2D uMap;
uniform vec4 uViewport;
uniform float uActive;
uniform float uTime;
uniform vec3 uTint;
varying vec2 vLocal;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}

/** Scene light to what the display shows: the same tone mapping and encoding as everything else. */
vec3 toDisplay(vec3 c) {
  #ifdef TONE_MAPPING
  c = toneMapping(c);
  #endif
  return linearToOutputTexel(vec4(c, 1.0)).rgb;
}

void main() {
  float r = clamp(length(vLocal), 0.0, 1.0);
  vec3 glow = uTint * pow(smoothstep(0.78, 1.0, r), 2.0) * 1.6;
  if (uActive > 0.5) {
    // The other side, looked up by where this pixel is on screen; a faint ripple near the rim.
    // It was drawn tone mapped and encoded, exactly as the screen is: it goes out as it is.
    vec2 uv = (gl_FragCoord.xy - uViewport.xy) / uViewport.zw;
    vec2 wob = vec2(sin(uTime * 2.1 + vLocal.y * 11.0), cos(uTime * 1.7 + vLocal.x * 9.0)) * 0.002 * smoothstep(0.75, 1.0, r);
    vec3 view = texture2D(uMap, uv + wob).rgb;
    // The rim's glow is screened over it (both are display colours by now).
    vec3 g = toDisplay(glow) * 0.85;
    gl_FragColor = vec4(1.0 - (1.0 - view) * (1.0 - g), 1.0);
  } else {
    // Too far to see through: a slow swirl.
    float a = atan(vLocal.y, vLocal.x);
    float n = noise(vec2(a * 2.0 + uTime * 0.35 + r * 5.0, r * 6.0 - uTime * 0.5));
    vec3 swirl = mix(uTint * 0.25, uTint * 1.4, n) * (0.55 + 0.45 * r);
    gl_FragColor = vec4(toDisplay(swirl + glow), 1.0);
  }
}`;

/** Where a crossing carries things: the portal entered, and the move and turn to its twin. */
export interface Crossing {
  portal: Portal;
  m: Matrix4;
  q: Quaternion;
}

export class Portal {
  /** On the ground at the plinth's centre; +Z is the front. */
  readonly root = new Group();
  readonly surface: Mesh;
  readonly material: ShaderMaterial;
  readonly shards: Group;
  partner!: Portal;
  /** The opening's frame (centre of the ellipse), world, and its inverse. */
  readonly world = new Matrix4();
  readonly inverse = new Matrix4();
  readonly rts: (WebGLRenderTarget | null)[] = new Array(SLOTS).fill(null);
  readonly fresh: boolean[] = new Array(SLOTS).fill(false);
  readonly uniforms = {
    uMap: { value: null as Texture | null },
    uViewport: { value: new Vector4(0, 0, 1, 1) },
    uActive: { value: 0 },
    uTime: { value: 0 },
    uTint: { value: new Color() },
  };
  renders = 0;
  hum: PortalHum | null = null;

  constructor(
    readonly id: string,
    at: Vector3,
    yaw: number,
    tint: number,
  ) {
    this.root.name = id;
    this.root.position.copy(at);
    this.root.rotation.y = yaw;
    this.uniforms.uTint.value.setHex(tint);
    // The surface is a shallow elliptical prism: its caps are the window, and when
    // your eyes come right up to it, it deepens away from you so they never see past.
    const geo = new CylinderGeometry(1, 1, 1, 64, 1, false).rotateX(Math.PI / 2);
    this.material = new ShaderMaterial({ vertexShader: vertex, fragmentShader: fragment, uniforms: this.uniforms, side: DoubleSide });
    this.surface = new Mesh(geo, this.material);
    this.surface.name = `${id}-surface`;
    this.surface.position.set(0, CY, 0);
    this.surface.scale.set(RX, RY, 0.004);
    this.root.add(this.surface);

    // Frame: a pale stone hoop with a gold inner ring, on a round plinth; crystal shards drift around it.
    const ring = (rx: number, ry: number, tube: number) =>
      new TubeGeometry(
        new CatmullRomCurve3(
          Array.from({ length: 48 }, (_, i) => new Vector3(Math.cos((i / 48) * Math.PI * 2) * rx, Math.sin((i / 48) * Math.PI * 2) * ry, 0)),
          true,
        ),
        96,
        tube,
        10,
        true,
      );
    const frame = new Mesh(
      mergeColored([
        { geometry: ring(HOOP_RX, HOOP_RY, HOOP_TUBE), matrix: new Matrix4().makeTranslation(0, CY, 0), color: 0xdcd6cc },
        { geometry: ring(RX + 0.005, RY + 0.005, 0.022), matrix: new Matrix4().makeTranslation(0, CY, 0), color: 0xd4af37 },
        { geometry: new CylinderGeometry(1.05, 1.15, PLINTH, 40), matrix: new Matrix4().makeTranslation(0, PLINTH / 2, 0), color: 0xbdb5aa },
        { geometry: new CylinderGeometry(0.62, 0.7, 0.08, 32), matrix: new Matrix4().makeTranslation(0, PLINTH + 0.04, 0), color: 0xcfc8be },
      ]),
      new MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.15 }),
    );
    frame.name = `${id}-frame`;
    frame.castShadow = frame.receiveShadow = true;
    this.root.add(frame);
    const shardParts = [];
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2 + 0.3;
      const m = new Matrix4().compose(
        new Vector3(Math.cos(a) * (RX + 0.32), Math.sin(a) * (RY + 0.3), (i % 2 ? 1 : -1) * 0.12),
        new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), a),
        new Vector3(0.05, 0.13, 0.05),
      );
      shardParts.push({ geometry: new OctahedronGeometry(1, 0), matrix: m, color: new Color(tint).lerp(new Color(0xffffff), 0.35) });
    }
    this.shards = new Group();
    this.shards.position.y = CY;
    const shardMesh = new Mesh(mergeColored(shardParts), new MeshLambertMaterial({ vertexColors: true, emissive: new Color(tint).multiplyScalar(0.6) }));
    this.shards.add(shardMesh);
    this.root.add(this.shards);
    this.updateMatrices();
  }

  updateMatrices(): void {
    this.root.updateMatrixWorld(true);
    this.world.copy(this.root.matrixWorld).multiply(_m.makeTranslation(0, CY, 0));
    this.inverse.copy(this.world).invert();
  }

  /** Signed distance of a world point from the opening's plane (positive = in front). */
  side(p: Vector3): number {
    return _c.copy(p).applyMatrix4(this.inverse).z;
  }
}

/**
 * Two see-through portals: one on the main island, its twin on the perch, a high
 * island 100 m away. Each shows a live view of the other side, rendered for each
 * eye from a camera standing at the twin; walk through and you're there, no fade.
 * Balls, arrows and flares go through too.
 */
export class Portals {
  readonly list: Portal[] = [];
  private readonly views: PerspectiveCamera[] = [];
  private readonly prevHead = new Vector3();
  private hasPrev = false;
  /** The camera the spare slot is rendered for (snapshots). */
  private spareCamera: Camera | null = null;
  private readonly crossing: Crossing;
  /** Times the player has gone through. */
  transits = 0;
  /** Called when the player goes through, with the turn it gave them (a glider in flight turns too). */
  onPlayerTransit: ((c: Crossing, yaw: number) => void) | null = null;
  /** The twin whose surroundings the sun's shadow map covers right now (null: the player's own). */
  private shadowArea: Portal | null = null;
  private readonly keyAt = new Vector3();
  private readonly keyTarget = new Vector3();

  constructor(private readonly app: App) {
    const home = new Portal('portal-home', LAYOUT.portal.clone(), Math.atan2(LAYOUT.spawn.x - LAYOUT.portal.x, LAYOUT.spawn.z - LAYOUT.portal.z), 0x4cf0ff);
    home.root.position.y = app.scenery.heightAt(home.root.position.x, home.root.position.z) ?? 0;
    const awayAt = PERCH_PORTAL.clone();
    awayAt.y = app.scenery.heightAt(awayAt.x, awayAt.z) ?? PERCH_PORTAL.y;
    const away = new Portal('portal-perch', awayAt, PERCH_FACING, 0xb98cff);
    home.partner = away;
    away.partner = home;
    this.crossing = { portal: home, m: new Matrix4(), q: new Quaternion() };
    for (const p of [home, away]) {
      p.updateMatrices();
      app.scene.add(p.root);
      this.list.push(p);
      // The plinth is solid ground and the hoop is solid stone; the opening lets everything through.
      app.physics.addStatic(RAPIER.ColliderDesc.cylinder(PLINTH / 2, 1.1), { walkable: true, material: 'stone' }, p.root.position.clone().setY(p.root.position.y + PLINTH / 2));
      const n = 28;
      for (let i = 0; i < n; i++) {
        const a0 = (i / n) * Math.PI * 2;
        const a1 = ((i + 1) / n) * Math.PI * 2;
        const e0 = new Vector3(Math.cos(a0) * HOOP_RX, Math.sin(a0) * HOOP_RY, 0).applyMatrix4(p.world);
        const e1 = new Vector3(Math.cos(a1) * HOOP_RX, Math.sin(a1) * HOOP_RY, 0).applyMatrix4(p.world);
        const mid = e0.clone().add(e1).multiplyScalar(0.5);
        const dir = e1.clone().sub(e0);
        const rot = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), dir.clone().normalize());
        // You step over its bottom when you walk through (with the stick too).
        app.physics.addStatic(RAPIER.ColliderDesc.capsule(dir.length() / 2, HOOP_TUBE), { walkable: false, material: 'stone', stepOver: true }, mid, rot);
      }
      p.surface.onBeforeRender = (renderer, _scene, camera) => {
        let slot = renderer.xr.isPresenting ? (renderer.xr.getCamera().cameras as Camera[]).indexOf(camera) : -1;
        if (slot < 0) slot = camera === this.spareCamera ? 3 : camera === app.desktopCamera ? 2 : -1;
        this.bind(p, slot, renderer);
      };
    }
    for (let i = 0; i < SLOTS; i++) {
      const c = new PerspectiveCamera();
      c.matrixAutoUpdate = false;
      c.matrixWorldAutoUpdate = false;
      this.views.push(c);
    }
  }

  get home(): Portal {
    return this.list[0];
  }

  get perch(): Portal {
    return this.list[1];
  }

  /** What carries things entering `p` to the matching place at its twin (a turn and a move). */
  transfer(p: Portal, out: Matrix4): Matrix4 {
    return out.multiplyMatrices(p.partner.world, ROT_PI).multiply(p.inverse);
  }

  /** The portal whose opening the segment a→b passes through, if any. */
  crossed(a: Vector3, b: Vector3): Portal | null {
    for (const p of this.list) {
      const la = _a.copy(a).applyMatrix4(p.inverse);
      const lb = _b.copy(b).applyMatrix4(p.inverse);
      if (la.z > 0 === lb.z > 0) continue;
      const t = la.z / (la.z - lb.z);
      const x = la.x + (lb.x - la.x) * t;
      const y = la.y + (lb.y - la.y) * t;
      if ((x / RX) ** 2 + (y / RY) ** 2 < 1) return p;
    }
    return null;
  }

  /**
   * If a→b goes through an opening: how to carry things across (apply `m` to points,
   * `q` to directions). The result is reused: use it before the next call.
   */
  through(a: Vector3, b: Vector3): Crossing | null {
    const p = this.crossed(a, b);
    if (!p) return null;
    const c = this.crossing;
    c.portal = p;
    this.transfer(p, c.m).decompose(_p, c.q, _s);
    return c;
  }

  /** After each physics step: props that went through come out of the twin, still moving. */
  afterStep(): void {
    const physics = this.app.physics;
    for (const prop of physics.props) {
      if (prop.parked || prop.heldBy) continue;
      const c = this.through(prop.prevPos, prop.currPos);
      if (!c) continue;
      const pos = _p.copy(prop.currPos).applyMatrix4(c.m);
      const quat = _q.copy(prop.currQuat).premultiply(c.q);
      const lv = prop.body.linvel();
      const av = prop.body.angvel();
      physics.place(prop, pos, quat);
      prop.body.setLinvel(_b.set(lv.x, lv.y, lv.z).applyQuaternion(c.q), true);
      prop.body.setAngvel(_b.set(av.x, av.y, av.z).applyQuaternion(c.q), true);
      bus.emit('portal-transit', { what: prop.id, to: c.portal.partner.id });
    }
  }

  /**
   * After everything that moves the player: if your head went through an opening,
   * the rig is carried to the twin. Returns true if it moved.
   */
  update(dt: number): boolean {
    const app = this.app;
    const head = app.headPosition(new Vector3());
    let moved = false;
    if (app.inXR && this.hasPrev && head.distanceTo(this.prevHead) < 2) {
      const c = this.through(this.prevHead, head);
      if (c) {
        const p = c.portal;
        const rig = app.rig;
        const yaw = p.partner.root.rotation.y + Math.PI - p.root.rotation.y;
        rig.position.applyMatrix4(c.m);
        rig.rotation.y += yaw;
        app.updateRig();
        app.headPosition(head);
        this.transits++;
        moved = true;
        portalWhoosh(head);
        for (const h of app.input.hands) h.pulse(0.35, 40);
        this.onPlayerTransit?.(c, yaw);
        bus.emit('portal-transit', { what: 'player', to: p.partner.id });
      }
    }
    this.prevHead.copy(head);
    this.hasPrev = app.inXR;

    // Shards drift; the surface deepens away from you when you're right at the opening; a hum nearby.
    for (const p of this.list) {
      p.uniforms.uTime.value += dt;
      p.shards.rotation.z += dt * 0.15;
      const local = _c.copy(head).applyMatrix4(p.inverse);
      const near = (local.x / (RX + 0.3)) ** 2 + (local.y / (RY + 0.3)) ** 2;
      const close = smoothstep(0.7, 0.05, Math.abs(local.z)) * smoothstep(1.4, 1.0, near);
      const depth = 0.004 + 0.32 * close;
      p.surface.scale.z = depth;
      p.surface.position.z = -Math.sign(local.z || 1) * depth * 0.5;
      if (!p.hum && audio.ready) p.hum = portalHum();
      const centre = _b.setFromMatrixPosition(p.world);
      p.hum?.update(centre, clamp(1 - head.distanceTo(centre) / 12, 0, 1));
    }
    return moved;
  }

  /** Forget where the head was (after a teleport or a session change). */
  resetTracking(): void {
    this.hasPrev = false;
  }

  /** Right before the frame is drawn: render each visible portal's view for the cameras about to draw. */
  render(): void {
    for (const p of this.list) p.fresh.fill(false);
    const app = this.app;
    const r = app.renderer;
    // One scene-graph update for every view this frame (each pass skips its own).
    app.scene.updateMatrixWorld();
    if (app.inXR) {
      const cams = r.xr.getCamera().cameras;
      // The eyes' matrices are already this frame's (set by the XR manager): don't recompute them.
      for (let i = 0; i < Math.min(2, cams.length); i++) this.renderFor(cams[i], cams[i].viewport, i, false);
    } else {
      r.getDrawingBufferSize(_size);
      this.renderFor(app.desktopCamera, _v4.set(0, 0, _size.x, _size.y), 2, false);
    }
    this.restoreShadows();
  }

  /** Point the sun's shadow map back at the player (the main pass renders it again). */
  private restoreShadows(): void {
    if (!this.shadowArea) return;
    const key = this.app.tod.key;
    key.position.copy(this.keyAt);
    key.target.position.copy(this.keyTarget);
    key.updateMatrixWorld();
    key.target.updateMatrixWorld();
    this.app.renderer.shadowMap.needsUpdate = true;
    this.shadowArea = null;
  }

  /**
   * Render the views for one camera with this viewport (in its target's pixels). Slot
   * 3 is for any other camera (snapshots); `refresh` brings its matrices up to date.
   */
  renderFor(eye: Camera, viewport: Vector4, slot = 3, refresh = true): void {
    if (slot === 3) this.spareCamera = eye;
    const app = this.app;
    const r = app.renderer;
    const scene = app.scene;
    if (refresh) {
      scene.updateMatrixWorld();
      eye.updateMatrixWorld();
    } else if (eye === app.desktopCamera) eye.updateMatrixWorld();
    const eyePos = _p.setFromMatrixPosition(eye.matrixWorld);
    const scale = settings.quality === 'high' ? 0.75 : 0.5;
    for (const p of this.list) {
      if (_a.setFromMatrixPosition(p.world).distanceTo(eyePos) > VIEW_RANGE) continue;
      // Where on screen is the opening? Render only that rectangle.
      const rect = this.screenRect(p, eye, viewport);
      if (!rect) continue;
      const side = p.side(eyePos) >= 0 ? 1 : -1;
      const q = p.partner;
      const view = this.views[slot];
      view.matrixWorld.multiplyMatrices(this.transfer(p, _m), eye.matrixWorld);
      view.matrixWorldInverse.copy(view.matrixWorld).invert();
      view.projectionMatrix.copy((eye as PerspectiveCamera).projectionMatrix);
      view.layers.mask = eye.layers.mask;
      // Clip everything between that camera and the twin's opening (an oblique near plane).
      _plane.setFromNormalAndCoplanarPoint(_b.set(0, 0, side).transformDirection(q.world), _corner.setFromMatrixPosition(q.world));
      _plane.applyMatrix4(view.matrixWorldInverse);
      // A head right at the opening: keep the plane a little in front of the camera.
      _plane.constant = Math.min(_plane.constant, -MIN_CLIP);
      _clip.set(_plane.normal.x, _plane.normal.y, _plane.normal.z, _plane.constant);
      const e = view.projectionMatrix.elements;
      _oq.set((Math.sign(_clip.x) + e[8]) / e[0], (Math.sign(_clip.y) + e[9]) / e[5], -1, (1 + e[10]) / e[14]);
      _clip.multiplyScalar(2 / _clip.dot(_oq));
      e[2] = _clip.x;
      e[6] = _clip.y;
      e[10] = _clip.z + 1;
      e[14] = _clip.w;

      const w = Math.max(1, Math.round(viewport.z * scale));
      const h = Math.max(1, Math.round(viewport.w * scale));
      let rt = p.rts[slot];
      if (!rt) {
        // Drawn exactly as the eyes' own framebuffer is (tone mapped, sRGB): every material
        // then uses the same shader variant in both passes. A plain (linear) target made three
        // switch programs on every draw, which cost more than the drawing.
        rt = new WebGLRenderTarget(w, h);
        rt.texture.colorSpace = SRGBColorSpace;
        (rt as WebGLRenderTarget & { isXRRenderTarget: boolean }).isXRRenderTarget = true;
        p.rts[slot] = rt;
      } else if (rt.width !== w || rt.height !== h) rt.setSize(w, h);
      // Only the opening's rectangle is drawn, and the frustum shrinks to it, so nothing
      // outside it costs a draw call. Snapped to whole pixels, with a pixel to spare.
      const px0 = Math.max(0, Math.floor(rect.x * scale) - 1);
      const py0 = Math.max(0, Math.floor(rect.y * scale) - 1);
      const px1 = Math.min(w, Math.ceil((rect.x + rect.z) * scale) + 1);
      const py1 = Math.min(h, Math.ceil((rect.y + rect.w) * scale) + 1);
      if (px1 <= px0 || py1 <= py0) continue;
      const x0 = (px0 / w) * 2 - 1;
      const x1 = (px1 / w) * 2 - 1;
      const y0 = (py0 / h) * 2 - 1;
      const y1 = (py1 / h) * 2 - 1;
      _sub.set(2 / (x1 - x0), 0, 0, -(x1 + x0) / (x1 - x0), 0, 2 / (y1 - y0), 0, -(y1 + y0) / (y1 - y0), 0, 0, 1, 0, 0, 0, 0, 1);
      view.projectionMatrix.premultiply(_sub);
      view.projectionMatrixInverse.copy(view.projectionMatrix).invert();
      rt.viewport.set(px0, py0, px1 - px0, py1 - py0);
      rt.scissor.copy(rt.viewport);
      rt.scissorTest = true;

      // Up close, shadows over there too: the sun's shadow map moves to the view for this pass.
      const key = app.tod.key;
      if (r.shadowMap.enabled && key.castShadow && this.shadowArea !== q && _a.distanceTo(eyePos) < SHADOW_RANGE) {
        if (!this.shadowArea) {
          this.keyAt.copy(key.position);
          this.keyTarget.copy(key.target.position);
        }
        app.tod.follow(_corner.setFromMatrixPosition(view.matrixWorld).setY(q.root.position.y));
        key.updateMatrixWorld();
        key.target.updateMatrixWorld();
        r.shadowMap.needsUpdate = true;
        this.shadowArea = q;
      }

      // The Reflector pattern: draw into our target from inside the frame, then put everything back.
      const prevTarget = r.getRenderTarget();
      const xrEnabled = r.xr.enabled;
      const shadowAuto = r.shadowMap.autoUpdate;
      const worldAuto = scene.matrixWorldAutoUpdate;
      const sky = app.sky.mesh;
      const skyAt = _c.copy(sky.position);
      r.xr.enabled = false;
      r.shadowMap.autoUpdate = false;
      scene.matrixWorldAutoUpdate = false;
      for (const o of this.list) o.surface.visible = false;
      // Far-off small things are a pixel or two in this view: leave them out (each one is a draw call).
      app.detail.hide(_corner.setFromMatrixPosition(view.matrixWorld), DETAIL_ANGLE, app.time);
      sky.position.setFromMatrixPosition(view.matrixWorld);
      sky.updateMatrixWorld();
      r.setRenderTarget(rt);
      r.clear();
      r.render(scene, view);
      r.setRenderTarget(prevTarget);
      for (const o of this.list) o.surface.visible = true;
      app.detail.restore();
      sky.position.copy(skyAt);
      sky.updateMatrixWorld();
      scene.matrixWorldAutoUpdate = worldAuto;
      r.xr.enabled = xrEnabled;
      r.shadowMap.autoUpdate = shadowAuto;
      p.fresh[slot] = true;
      p.renders++;
    }
    if (refresh) this.restoreShadows();
  }

  /** The opening's bounding rectangle on screen (x, y, w, h in viewport-relative pixels), or null if it's off screen. */
  private screenRect(p: Portal, eye: Camera, viewport: Vector4): Vector4 | null {
    const cam = eye as PerspectiveCamera;
    let minX = 1;
    let minY = 1;
    let maxX = -1;
    let maxY = -1;
    let behind = false;
    let ahead = 0;
    for (const [x, y, z] of [
      [-1, -1, -0.35],
      [1, -1, -0.35],
      [-1, 1, -0.35],
      [1, 1, -0.35],
      [-1, -1, 0.35],
      [1, -1, 0.35],
      [-1, 1, 0.35],
      [1, 1, 0.35],
    ]) {
      _corner.set(x * (RX + 0.1), y * (RY + 0.1), z).applyMatrix4(p.world).applyMatrix4(cam.matrixWorldInverse);
      if (_corner.z > -0.02) {
        behind = true;
        continue;
      }
      ahead++;
      _corner.applyMatrix4(cam.projectionMatrix);
      minX = Math.min(minX, _corner.x);
      minY = Math.min(minY, _corner.y);
      maxX = Math.max(maxX, _corner.x);
      maxY = Math.max(maxY, _corner.y);
    }
    // All of it behind you: nothing to draw. Some of it level with your eyes: you're at the opening, draw the lot.
    if (!ahead) return null;
    if (behind) return new Vector4(0, 0, viewport.z, viewport.w);
    minX = Math.max(-1, minX);
    minY = Math.max(-1, minY);
    maxX = Math.min(1, maxX);
    maxY = Math.min(1, maxY);
    if (maxX <= minX || maxY <= minY) return null;
    return new Vector4(((minX + 1) / 2) * viewport.z, ((minY + 1) / 2) * viewport.w, ((maxX - minX) / 2) * viewport.z, ((maxY - minY) / 2) * viewport.w);
  }

  /** Done rendering for the spare camera (a snapshot): it's an ordinary camera again. */
  releaseSpare(): void {
    this.spareCamera = null;
  }

  /** Per draw: show this slot's view, if it was rendered this frame. */
  private bind(p: Portal, slot: number, renderer: App['renderer']): void {
    const rt = slot >= 0 ? p.rts[slot] : null;
    const ok = !!rt && p.fresh[slot];
    p.uniforms.uActive.value = ok ? 1 : 0;
    if (ok) p.uniforms.uMap.value = rt.texture;
    renderer.getCurrentViewport(p.uniforms.uViewport.value);
    // Each eye draws the same material with its own view: upload every time.
    p.material.uniformsNeedUpdate = true;
  }
}
