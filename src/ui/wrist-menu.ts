import { CanvasTexture, LinearFilter, Mesh, MeshBasicMaterial, PlaneGeometry, Plane, Ray, RingGeometry, SRGBColorSpace, Vector3, Matrix4, Quaternion } from 'three';
import { bus } from '../core/events';
import { damp } from '../core/math';
import { setSetting, settings, type Settings } from '../core/settings';
import { uiTick } from '../audio/sfx';
import { roundRect } from './text';
import type { App } from '../app';

const W = 640;
const H = 520;
const PANEL_W = 0.2;
const PANEL_H = (PANEL_W * H) / W;

export type Page = 'settings' | 'info';

interface Hit {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

const _v = new Vector3();
const _n = new Vector3();
const _head = new Vector3();
const _m = new Matrix4();
const _inv = new Matrix4();
const _q = new Quaternion();
const _ray = new Ray();
const _plane = new Plane();

/**
 * Palm-up menu on the left hand. Poke it with your right index finger, or
 * point the right controller at it and pull the trigger.
 */
export class WristMenu {
  readonly mesh: Mesh;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly texture: CanvasTexture;
  private readonly cursor: Mesh;
  page: Page = 'settings';
  private hits: Hit[] = [];
  private hover: string | null = null;
  private opacity = 0;
  visible = false;
  private dirty = true;
  private pokeInside = false;
  private lastInfoDraw = 0;
  /** Right hand is interacting with the menu this frame (tools should ignore the trigger). */
  engaged = false;

  constructor(private readonly app: App) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = W;
    this.canvas.height = H;
    this.ctx = this.canvas.getContext('2d')!;
    this.texture = new CanvasTexture(this.canvas);
    this.texture.colorSpace = SRGBColorSpace;
    this.texture.minFilter = LinearFilter;
    this.texture.generateMipmaps = false;
    this.mesh = new Mesh(
      new PlaneGeometry(PANEL_W, PANEL_H),
      new MeshBasicMaterial({ map: this.texture, transparent: true, opacity: 0, toneMapped: false, depthWrite: false }),
    );
    this.mesh.name = 'wrist-menu';
    this.mesh.renderOrder = 20;
    this.mesh.visible = false;
    this.cursor = new Mesh(new RingGeometry(0.0035, 0.0055, 20), new MeshBasicMaterial({ color: 0xffffff, toneMapped: false, depthTest: false }));
    this.cursor.position.z = 0.001;
    this.cursor.renderOrder = 21;
    this.cursor.visible = false;
    this.mesh.add(this.cursor);
    app.scene.add(this.mesh);
    bus.on('setting', () => (this.dirty = true));
  }

  update(dt: number): void {
    const left = this.app.input.left;
    const right = this.app.input.right;
    this.engaged = false;
    const model = this.app.handModels.left;
    let want = false;
    if (left.grip.valid && this.app.inXR && !this.app.grab.held(left)) {
      const palm = _v;
      model.palm(palm, _n);
      this.app.headPosition(_head);
      const toHead = _head.clone().sub(palm);
      const dist = toHead.length();
      toHead.multiplyScalar(1 / dist);
      const facing = _n.dot(toHead);
      const threshold = this.visible ? 0.35 : 0.6;
      want = facing > threshold && dist < 0.75 * this.app.rigScale;
      if (want) {
        // Float in front of the palm, facing the eyes.
        const s = this.app.rigScale;
        const pos = palm.clone().addScaledVector(_n, 0.085 * s).add(new Vector3(0, 0.03 * s, 0));
        this.mesh.position.lerp(pos, this.visible ? damp(25, dt) : 1);
        // Matrix4.lookAt(eye, target) builds a basis whose +Z points from target to eye,
        // so the panel's front face (+Z) turns toward the head.
        _m.lookAt(_head, this.mesh.position, new Vector3(0, 1, 0));
        _q.setFromRotationMatrix(_m);
        this.mesh.quaternion.slerp(_q, this.visible ? damp(18, dt) : 1);
        this.mesh.scale.setScalar(s);
      }
    }
    if (want && !this.visible) {
      this.visible = true;
      this.dirty = true;
      bus.emit('menu', { open: true });
    } else if (!want && this.visible) {
      this.visible = false;
      this.pokeInside = false;
      bus.emit('menu', { open: false });
    }
    this.opacity += ((this.visible ? 1 : 0) - this.opacity) * damp(14, dt);
    (this.mesh.material as MeshBasicMaterial).opacity = this.opacity;
    this.mesh.visible = this.opacity > 0.02;
    if (!this.mesh.visible) return;

    // Interaction (right hand).
    let hoverId: string | null = null;
    this.cursor.visible = false;
    if (this.visible && right.grip.valid) {
      this.mesh.updateMatrixWorld(true);
      _inv.copy(this.mesh.matrixWorld).invert();
      // 1) Poke with the index fingertip.
      const tip = this.app.handModels.right.indexTip(new Vector3()).applyMatrix4(_inv);
      const inside = Math.abs(tip.x) < PANEL_W / 2 && Math.abs(tip.y) < PANEL_H / 2;
      if (inside && tip.z < 0.03 && tip.z > -0.04) {
        this.engaged = true;
        hoverId = this.hitAt(tip.x, tip.y);
        this.showCursor(tip.x, tip.y);
        if (!this.pokeInside && tip.z < 0.002) {
          this.pokeInside = true;
          if (hoverId) this.click(hoverId);
        }
      }
      if (this.pokeInside && (tip.z > 0.012 || !inside)) this.pokeInside = false;
      // 2) Point and pull the trigger.
      if (!hoverId && right.aim.valid && !this.app.grab.held(right)) {
        _ray.set(right.aim.position, right.aim.forward(new Vector3()));
        _plane.setFromNormalAndCoplanarPoint(new Vector3(0, 0, 1).applyQuaternion(this.mesh.quaternion), this.mesh.position);
        const hit = _ray.intersectPlane(_plane, new Vector3());
        if (hit && hit.distanceTo(right.aim.position) < 1.2 * this.app.rigScale) {
          const l = hit.applyMatrix4(_inv);
          if (Math.abs(l.x) < PANEL_W / 2 && Math.abs(l.y) < PANEL_H / 2) {
            this.engaged = true;
            hoverId = this.hitAt(l.x, l.y);
            this.showCursor(l.x, l.y);
            if (right.trigger.down && hoverId) this.click(hoverId);
          }
        }
      }
    }
    if (hoverId !== this.hover) {
      this.hover = hoverId;
      this.dirty = true;
      if (hoverId) right.pulse(0.08, 8);
    }
    const now = performance.now();
    if (this.page === 'info' && now - this.lastInfoDraw > 500) this.dirty = true;
    if (this.dirty) this.draw();
  }

  private showCursor(x: number, y: number): void {
    this.cursor.position.set(x, y, 0.001);
    this.cursor.visible = true;
  }

  private hitAt(x: number, y: number): string | null {
    const cx = (x / PANEL_W + 0.5) * W;
    const cy = (0.5 - y / PANEL_H) * H;
    for (const h of this.hits) if (cx >= h.x && cx <= h.x + h.w && cy >= h.y && cy <= h.y + h.h) return h.id;
    return null;
  }

  private click(id: string): void {
    const right = this.app.input.right;
    right.pulse(0.45, 22);
    uiTick(this.mesh.position, 1.2);
    const [kind, value] = id.split(':');
    switch (kind) {
      case 'page':
        this.page = value as Page;
        break;
      case 'turn':
        setSetting('turn', value as Settings['turn']);
        break;
      case 'stick':
        setSetting('leftStick', value as Settings['leftStick']);
        break;
      case 'vignette':
        setSetting('vignette', value === 'on');
        break;
      case 'quality':
        setSetting('quality', value as Settings['quality']);
        this.app.applyQuality();
        break;
      case 'music':
        setSetting('music', value === 'on');
        this.app.applyMusic();
        break;
      case 'fingers':
        setSetting('jointHands', value === 'joints');
        break;
      case 'laser':
        setSetting('laser', value === 'on');
        break;
      case 'action':
        if (value === 'recenter') this.app.locomotion.recenter();
        if (value === 'clear') this.app.brushes.clear();
        if (value === 'reset') this.app.resetToys();
        break;
    }
    this.dirty = true;
  }

  private draw(): void {
    this.dirty = false;
    const c = this.ctx;
    this.hits = [];
    c.clearRect(0, 0, W, H);
    c.fillStyle = 'rgba(18,16,30,0.9)';
    roundRect(c, 0, 0, W, H, 34);
    c.fill();
    c.strokeStyle = 'rgba(255,210,150,0.35)';
    c.lineWidth = 3;
    roundRect(c, 1.5, 1.5, W - 3, H - 3, 33);
    c.stroke();
    c.textBaseline = 'middle';
    c.fillStyle = '#ffd9a0';
    c.font = '800 38px system-ui, sans-serif';
    c.textAlign = 'left';
    c.fillText('Skyreach', 30, 46);
    this.button('page:settings', 'Settings', 330, 22, 130, 48, this.page === 'settings');
    this.button('page:info', 'Info', 470, 22, 140, 48, this.page === 'info');
    if (this.page === 'settings') this.drawSettings();
    else this.drawInfo();
    this.texture.needsUpdate = true;
  }

  private drawSettings(): void {
    const rows: [string, [string, string, boolean][]][] = [
      ['Turning', [['turn:snap45', 'Snap 45°', settings.turn === 'snap45'], ['turn:snap30', 'Snap 30°', settings.turn === 'snap30'], ['turn:smooth', 'Smooth', settings.turn === 'smooth']]],
      ['Left stick', [['stick:move', 'Walk', settings.leftStick === 'move'], ['stick:teleport', 'Teleport', settings.leftStick === 'teleport']]],
      ['Vignette', [['vignette:on', 'On', settings.vignette], ['vignette:off', 'Off', !settings.vignette]]],
      ['Quality', [['quality:high', 'High', settings.quality === 'high'], ['quality:low', 'Low', settings.quality === 'low']]],
      ['Music', [['music:on', 'On', settings.music], ['music:off', 'Off', !settings.music]]],
      ['Fingers', [['fingers:touch', 'Touch', !settings.jointHands], ['fingers:joints', 'Joints', settings.jointHands]]],
      ['Bow laser', [['laser:on', 'On', settings.laser], ['laser:off', 'Off', !settings.laser]]],
    ];
    const c = this.ctx;
    let y = 90;
    for (const [label, opts] of rows) {
      c.fillStyle = '#e9e1d4';
      c.font = '600 27px system-ui, sans-serif';
      c.textAlign = 'left';
      c.fillText(label, 30, y + 22);
      const total = 420;
      const w = total / opts.length - 8;
      opts.forEach(([id, text, on], i) => this.button(id, text, 196 + i * (w + 8), y, w, 42, on));
      y += 48;
    }
    y += 8;
    const actions: [string, string][] = [
      ['action:recenter', 'Recenter'],
      ['action:clear', 'Clear paint'],
      ['action:reset', 'Reset toys'],
    ];
    actions.forEach(([id, text], i) => this.button(id, text, 30 + i * 200, y, 186, 52, false, true));
  }

  private drawInfo(): void {
    this.lastInfoDraw = performance.now();
    const c = this.ctx;
    const a = this.app;
    const info = a.xr.info;
    const l = a.input.left;
    const r = a.input.right;
    const lines: string[] = [
      `${a.stats.fps.toFixed(0)} fps · ${a.stats.frameMs.toFixed(1)} ms · ${a.stats.calls} draws · ${(a.stats.triangles / 1000).toFixed(0)}k tris`,
      `framebuffer ${info?.framebuffer ? `${info.framebuffer.width}×${info.framebuffer.height}` : '?'} · rates ${info?.supportedFrameRates?.join('/') ?? 'n/a'}`,
      `space ${info?.referenceSpace ?? '-'} · bounds ${info?.boundedSpace ? 'yes' : 'no'} · hands ${info?.handTracking ? 'on' : 'off'}`,
      `L: ${l.profiles[0] ?? '—'}`,
      `R: ${r.profiles[0] ?? '—'}`,
      `haptics ${r.hapticsAvailable ? 'yes' : 'no'} · finger joints ${r.hasJoints ? (r.jointsValid ? 'live' : 'listed') : 'no'}`,
      `touch: trig ${r.trigger.touchSeen ? 'yes' : 'no'} · grip ${r.squeeze.touchSeen ? 'yes' : 'no'} · thumb ${r.a.touchSeen || r.b.touchSeen || r.stickClick.touchSeen || r.thumbrest.touchSeen ? 'yes' : 'no'}`,
      `velocity: ${r.nativeVelocity ? 'runtime' : 'estimated'} · physics ${a.physics.props.length} bodies`,
    ];
    c.textAlign = 'left';
    c.fillStyle = '#e9e1d4';
    c.font = '500 25px ui-monospace, Consolas, monospace';
    lines.forEach((t, i) => c.fillText(t, 30, 110 + i * 46, W - 60));
  }

  private button(id: string, text: string, x: number, y: number, w: number, h: number, on: boolean, action = false): void {
    const c = this.ctx;
    const hover = this.hover === id;
    c.fillStyle = on ? '#ffb35c' : hover ? 'rgba(255,255,255,0.22)' : action ? 'rgba(255,179,92,0.16)' : 'rgba(255,255,255,0.09)';
    roundRect(c, x, y, w, h, 14);
    c.fill();
    if (hover && !on) {
      c.strokeStyle = 'rgba(255,220,170,0.9)';
      c.lineWidth = 3;
      roundRect(c, x + 1.5, y + 1.5, w - 3, h - 3, 13);
      c.stroke();
    }
    c.fillStyle = on ? '#22172a' : '#f4efe6';
    c.font = `${on ? 700 : 600} 25px system-ui, sans-serif`;
    c.textAlign = 'center';
    c.fillText(text, x + w / 2, y + h / 2 + 1);
    this.hits.push({ id, x, y, w, h });
  }
}
