import { PerspectiveCamera, SRGBColorSpace, Vector3, Vector4, WebGLRenderTarget, type Camera } from 'three';
import type { App } from '../app';
import { EYES_ONLY_LAYER } from '../archery/scope';

export interface SnapshotOptions {
  width?: number;
  height?: number;
  fov?: number;
  /** Use this camera instead of the player's eyes. */
  camera?: Camera;
  /** Or place a camera here, looking at `to` (world coordinates). */
  from?: [number, number, number];
  to?: [number, number, number];
}

/**
 * Render the player's view (or a given camera) offscreen and POST it to the dev
 * server, which writes .snapshots/<name>.png. Works with the page hidden.
 */
function snapshotCamera(app: App, o: SnapshotOptions, width: number, height: number): Camera {
  let cam = o.camera;
  if (!cam) {
    // Same near/far as the player's eyes, so depth precision (z-fighting) matches the headset.
    const pc = new PerspectiveCamera(o.fov ?? 80, width / height, app.xrCamera.near, app.xrCamera.far);
    pc.layers.enable(EYES_ONLY_LAYER); // see what the eyes see, including the scope lens
    if (o.from) {
      pc.position.set(...o.from);
      pc.lookAt(new Vector3(...(o.to ?? [0, 1, 0])));
    } else if (app.inXR && app.input.head.valid) {
      app.input.head.matrix.decompose(pc.position, pc.quaternion, pc.scale);
      pc.scale.set(1, 1, 1);
    } else {
      app.camera.getWorldPosition(pc.position);
      app.camera.getWorldQuaternion(pc.quaternion);
    }
    pc.updateMatrixWorld(true);
    cam = pc;
  }
  return cam;
}

/** Render offscreen (tone mapped, sRGB, like the headset) and read the pixels back, top row first. */
function renderPixels(app: App, cam: Camera, W: number, H: number): Uint8Array {
  const rt = new WebGLRenderTarget(W, H);
  rt.texture.colorSpace = SRGBColorSpace;
  (rt as WebGLRenderTarget & { isXRRenderTarget: boolean }).isXRRenderTarget = true;
  // For an XR-flagged target the shaders already encode sRGB, as they do for the headset's
  // RGBA8 layer. Left to itself, three would store an sRGB texture as SRGB8_ALPHA8 and the
  // hardware would encode it a second time (linear 0.5 grey read back as 223, not 188).
  rt.texture.internalFormat = 'RGBA8';
  const r = app.renderer;
  // The portals render their live views for this camera first.
  app.portals.renderFor(cam, new Vector4(0, 0, W, H));
  // The sky is drawn around the eye, as in the headset (and the portals' views). Left
  // where the player is, it has no position at all when the page has no size: the
  // emulated eyes then have empty viewports and the XR camera is NaN.
  const sky = app.sky.mesh;
  const skyAt = sky.position.clone();
  sky.position.setFromMatrixPosition(cam.matrixWorld);
  sky.updateMatrixWorld();
  const xrEnabled = r.xr.enabled;
  const prevTarget = r.getRenderTarget();
  r.xr.enabled = false;
  r.setRenderTarget(rt);
  r.clear();
  r.render(app.scene, cam);
  r.setRenderTarget(prevTarget);
  r.xr.enabled = xrEnabled;
  sky.position.copy(skyAt);
  sky.updateMatrixWorld();
  app.portals.releaseSpare();
  const px = new Uint8Array(W * H * 4);
  r.readRenderTargetPixels(rt, 0, 0, W, H, px);
  rt.dispose();
  return px;
}

/**
 * Average brightness (0..1, Rec. 709 luma of the displayed colour) of a view:
 * lets a test check that something actually lit the scene up.
 */
export function measureLuma(app: App, o: SnapshotOptions = {}): number {
  const W = o.width ?? 192;
  const H = o.height ?? 108;
  const cam = snapshotCamera(app, o, W, H);
  if (cam instanceof PerspectiveCamera) {
    cam.aspect = W / H;
    cam.updateProjectionMatrix();
  }
  const px = renderPixels(app, cam, W, H);
  let sum = 0;
  for (let i = 0; i < px.length; i += 4) sum += 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
  return sum / (W * H * 255);
}

export async function snapshot(app: App, name: string, o: SnapshotOptions = {}): Promise<string> {
  const width = o.width ?? 1280;
  const height = o.height ?? 720;
  const cam = snapshotCamera(app, o, width, height);
  // Supersample 2x. (MSAA used to fail to resolve here, INVALID_OPERATION: three gives an
  // XR-flagged target's multisample buffer RGBA8 storage, which didn't match the sRGB texture.
  // With RGBA8 storage it resolves now, but supersampling smooths shading too, not just edges.)
  const ss = 2;
  const W = width * ss;
  const H = height * ss;
  if (cam instanceof PerspectiveCamera) {
    cam.aspect = width / height;
    cam.updateProjectionMatrix();
  }
  const px = renderPixels(app, cam, W, H);

  const big = document.createElement('canvas');
  big.width = W;
  big.height = H;
  const bctx = big.getContext('2d')!;
  const img = bctx.createImageData(W, H);
  // Flip rows: GL origin is bottom-left.
  for (let y = 0; y < H; y++) img.data.set(px.subarray((H - 1 - y) * W * 4, (H - y) * W * 4), y * W * 4);
  bctx.putImageData(img, 0, 0);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(big, 0, 0, width, height);
  const blob = await new Promise<Blob>((res) => canvas.toBlob((b) => res(b!), 'image/png'));
  const resp = await fetch(`/__snapshot?name=${encodeURIComponent(name)}`, { method: 'POST', body: blob });
  const json = (await resp.json()) as { file: string };
  return json.file;
}
