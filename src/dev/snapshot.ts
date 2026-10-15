import { PerspectiveCamera, SRGBColorSpace, Vector3, WebGLRenderTarget, type Camera } from 'three';
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
export async function snapshot(app: App, name: string, o: SnapshotOptions = {}): Promise<string> {
  const width = o.width ?? 1280;
  const height = o.height ?? 720;
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
  // Supersample 2x instead of MSAA: an XR-flagged render target with samples > 0
  // fails to resolve in WebGL (INVALID_OPERATION), and we need the XR flag for
  // tone mapping + sRGB output to match what the headset shows.
  const ss = 2;
  const W = width * ss;
  const H = height * ss;
  const rt = new WebGLRenderTarget(W, H);
  rt.texture.colorSpace = SRGBColorSpace;
  (rt as WebGLRenderTarget & { isXRRenderTarget: boolean }).isXRRenderTarget = true;
  if (cam instanceof PerspectiveCamera) {
    cam.aspect = width / height;
    cam.updateProjectionMatrix();
  }
  const r = app.renderer;
  const xrEnabled = r.xr.enabled;
  const prevTarget = r.getRenderTarget();
  r.xr.enabled = false;
  r.setRenderTarget(rt);
  r.clear();
  r.render(app.scene, cam);
  r.setRenderTarget(prevTarget);
  r.xr.enabled = xrEnabled;
  const px = new Uint8Array(W * H * 4);
  r.readRenderTargetPixels(rt, 0, 0, W, H, px);
  rt.dispose();

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
