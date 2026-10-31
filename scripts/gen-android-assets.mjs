/* 生成 Android 启动图标、通知小图标与基础颜色资源 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePng, makeIcon, makeIconRgba } from './icon-lib.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const res = resolve(root, 'android/app/src/main/res');
const DENSITIES = [
  ['mdpi', 1],
  ['hdpi', 1.5],
  ['xhdpi', 2],
  ['xxhdpi', 3],
  ['xxxhdpi', 4],
];

function clamp01(n) { return Math.max(0, Math.min(1, n)); }

function makeRoundIcon(size) {
  const rgba = makeIconRgba(size);
  const c = (size - 1) / 2;
  const r = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c);
      const edge = clamp01(r + 0.5 - d);
      const i = (y * size + x) * 4 + 3;
      rgba[i] = Math.round(rgba[i] * edge);
    }
  }
  return encodePng(size, size, rgba);
}

function roundRect(x, y, w, h, r) {
  const x2 = x + w;
  const y2 = y + h;
  return (px, py) => {
    if (px < x || px > x2 || py < y || py > y2) return false;
    if (px >= x + r && px <= x2 - r) return true;
    if (py >= y + r && py <= y2 - r) return true;
    const cx = px < x + r ? x + r : x2 - r;
    const cy = py < y + r ? y + r : y2 - r;
    const dx = px - cx;
    const dy = py - cy;
    return dx * dx + dy * dy <= r * r;
  };
}

/* 纯白小图标：Android 会把通知栏图标按 alpha 渲染成单色 */
function makeNotificationGlyph(size) {
  const scale = 4;
  const S = size * scale;
  const px = Buffer.alloc(S * S * 4);
  const pad = S * 0.06;
  const box = S - pad * 2;
  const bw = box * 0.64;
  const bh = box * 0.46;
  const bx = pad + (box - bw) / 2;
  const by = pad + box * 0.24;
  const bubble = roundRect(bx, by, bw, bh, bh * 0.30);

  const ax = bx + bw * 0.24;
  const ay = by + bh - 1;
  const tx = bx + bw * 0.07;
  const ty = by + bh + box * 0.14;
  const cx = bx + bw * 0.46;
  const cy = by + bh - 1;
  const tail = (x, y) => {
    const d1 = (x - tx) * (ay - ty) - (ax - tx) * (y - ty);
    const d2 = (x - cx) * (ay - cy) - (ax - cx) * (y - cy);
    const d3 = (x - ax) * (ty - ay) - (tx - ax) * (y - ay);
    const neg = d1 < 0 || d2 < 0 || d3 < 0;
    const pos = d1 > 0 || d2 > 0 || d3 > 0;
    return !(neg && pos);
  };

  const dotR = bh * 0.10;
  const dots = [0.30, 0.50, 0.70].map((t) => ({ x: bx + bw * t, y: by + bh * 0.52 }));

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      let a = 0;
      if (bubble(x, y) || tail(x, y)) a = 255;
      for (const d of dots) {
        const dx = x - d.x;
        const dy = y - d.y;
        if (dx * dx + dy * dy <= dotR * dotR) a = 0;
      }
      px[i] = 255;
      px[i + 1] = 255;
      px[i + 2] = 255;
      px[i + 3] = a;
    }
  }

  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let a = 0;
      for (let sy = 0; sy < scale; sy++) {
        for (let sx = 0; sx < scale; sx++) {
          a += px[((y * scale + sy) * S + (x * scale + sx)) * 4 + 3];
        }
      }
      const o = (y * size + x) * 4;
      out[o] = 255;
      out[o + 1] = 255;
      out[o + 2] = 255;
      out[o + 3] = Math.round(a / (scale * scale));
    }
  }
  return encodePng(size, size, out);
}

for (const [name, scale] of DENSITIES) {
  const mipmap = resolve(res, `mipmap-${name}`);
  const drawable = resolve(res, `drawable-${name}`);
  mkdirSync(mipmap, { recursive: true });
  mkdirSync(drawable, { recursive: true });
  writeFileSync(resolve(mipmap, 'ic_launcher.png'), makeIcon(Math.round(48 * scale)));
  writeFileSync(resolve(mipmap, 'ic_launcher_round.png'), makeRoundIcon(Math.round(48 * scale)));
  writeFileSync(
    resolve(mipmap, 'ic_launcher_foreground.png'),
    makeIcon(Math.round(108 * scale), { inset: 0.06, background: false })
  );
  writeFileSync(resolve(drawable, 'ic_stat_miyu.png'), makeNotificationGlyph(Math.round(24 * scale)));
}

mkdirSync(resolve(res, 'drawable'), { recursive: true });
writeFileSync(resolve(res, 'drawable/ic_stat_miyu.png'), makeNotificationGlyph(48));

writeFileSync(
  resolve(res, 'values/ic_launcher_background.xml'),
  '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#07C160</color>\n</resources>\n'
);

writeFileSync(
  resolve(res, 'values/colors.xml'),
  '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="colorPrimary">#07C160</color>\n    <color name="colorPrimaryDark">#06AD56</color>\n    <color name="colorAccent">#07C160</color>\n    <color name="miyu_background">#EDEDED</color>\n</resources>\n'
);

/* 应用商店 / GitHub Release 用图 */
writeFileSync(resolve(root, 'android/playstore-icon.png'), makeIcon(512));

console.log('android icons written');
