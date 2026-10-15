import { BoxGeometry, CanvasTexture, Group, LinearFilter, Mesh, MeshBasicMaterial, MeshLambertMaterial, PlaneGeometry, SRGBColorSpace } from 'three';
import { faceToward, LAYOUT } from '../world/layout';
import { roundRect } from './text';

/** A wooden signpost near spawn with the controls. */
export function buildSign(): Group {
  const g = new Group();
  g.name = 'welcome-sign';
  g.position.copy(LAYOUT.sign);
  faceToward(g);
  g.rotation.y += 0.35; // angle it toward where you first look
  const wood = new MeshLambertMaterial({ color: 0x7a5233 });
  const post = new Mesh(new BoxGeometry(0.07, 1.3, 0.07), wood);
  post.position.set(0, 0.65, -0.06);
  post.castShadow = true;
  g.add(post);
  const board = new Mesh(new BoxGeometry(0.66, 0.5, 0.03), new MeshLambertMaterial({ color: 0xa47148 }));
  board.position.set(0, 1.35, 0);
  board.rotation.x = -0.12;
  board.castShadow = true;
  g.add(board);

  const W = 1024;
  const H = 776;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const c = canvas.getContext('2d')!;
  c.fillStyle = '#2a1d16';
  roundRect(c, 0, 0, W, H, 40);
  c.fill();
  c.fillStyle = '#ffd9a0';
  c.font = '800 74px system-ui, sans-serif';
  c.textAlign = 'center';
  c.fillText('Welcome to Skyreach', W / 2, 100);
  const rows: [string, string][] = [
    ['GRIP', 'grab · throw · point far + flick = pull'],
    ['TRIGGER', 'use what you hold'],
    ['R STICK', 'push to teleport · tilt to turn'],
    ['L STICK', 'walk'],
    ['L PALM', 'look at it for the menu'],
  ];
  c.textAlign = 'left';
  rows.forEach(([k, v], i) => {
    const y = 210 + i * 104;
    c.fillStyle = '#ffb35c';
    c.font = '800 46px system-ui, sans-serif';
    c.fillText(k, 60, y);
    c.fillStyle = '#f4efe6';
    c.font = '500 44px system-ui, sans-serif';
    c.fillText(v, 320, y, W - 360);
  });
  c.fillStyle = 'rgba(244,239,230,0.65)';
  c.font = 'italic 500 36px system-ui, sans-serif';
  c.textAlign = 'center';
  c.fillText('try the plank ahead… if you dare', W / 2, H - 50);
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  tex.minFilter = LinearFilter;
  tex.anisotropy = 4;
  const face = new Mesh(new PlaneGeometry(0.62, 0.62 * (H / W)), new MeshBasicMaterial({ map: tex, toneMapped: false }));
  face.position.set(0, 1.35, 0.017);
  face.rotation.x = -0.12;
  g.add(face);
  return g;
}
