import { deflateSync } from 'node:zlib';

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

export function encodePng(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
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

/**
 * Draws the Miyu icon. `inset` is a fraction of the canvas used as padding
 * (used by Android adaptive foregrounds).
 */
export function makeIconRgba(size, { inset = 0, background = true } = {}) {
  const scale = 4;
  const S = size * scale;
  const px = Buffer.alloc(S * S * 4);
  const pad = inset * S;
  const box = S - pad * 2;
  const radius = box * 0.23;

  const bg = roundRect(pad, pad, box, box, radius);
  const bubbleW = box * 0.56;
  const bubbleH = box * 0.40;
  const bubbleX = pad + (box - bubbleW) / 2;
  const bubbleY = pad + box * 0.28;
  const bubble = roundRect(bubbleX, bubbleY, bubbleW, bubbleH, bubbleH * 0.30);

  const tail = (x, y) => {
    // Triangle tail pointing down-left from the bubble.
    const ax = bubbleX + bubbleW * 0.22;
    const ay = bubbleY + bubbleH - 1;
    const bx = bubbleX + bubbleW * 0.06;
    const by = bubbleY + bubbleH + box * 0.13;
    const cx = bubbleX + bubbleW * 0.46;
    const cy = bubbleY + bubbleH - 1;
    const d1 = (x - bx) * (ay - by) - (ax - bx) * (y - by);
    const d2 = (x - cx) * (ay - cy) - (ax - cx) * (y - cy);
    const d3 = (x - ax) * (by - ay) - (bx - ax) * (y - ay);
    const neg = d1 < 0 || d2 < 0 || d3 < 0;
    const pos = d1 > 0 || d2 > 0 || d3 > 0;
    return !(neg && pos);
  };

  const dotR = bubbleH * 0.085;
  const dots = [0.30, 0.50, 0.70].map(t => ({
    x: bubbleX + bubbleW * t,
    y: bubbleY + bubbleH * 0.52,
  }));

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      let r = 0, g = 0, b = 0, a = 0;
      if (background && bg(x, y)) {
        const t = (y - pad) / box;
        r = Math.round(7 + 3 * (1 - t));
        g = Math.round(193 - 18 * t);
        b = Math.round(96 - 16 * t);
        a = 255;
      }
      const inBubble = bubble(x, y) || tail(x, y);
      if (inBubble) {
        r = 255; g = 255; b = 255; a = 255;
      }
      for (const d of dots) {
        const dx = x - d.x;
        const dy = y - d.y;
        if (dx * dx + dy * dy <= dotR * dotR) {
          r = 7; g = 193; b = 96; a = 255;
        }
      }
      px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
    }
  }

  // Box-filter downsample for smooth edges.
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < scale; sy++) {
        for (let sx = 0; sx < scale; sx++) {
          const i = ((y * scale + sy) * S + (x * scale + sx)) * 4;
          const alpha = px[i + 3] / 255;
          r += px[i] * alpha;
          g += px[i + 1] * alpha;
          b += px[i + 2] * alpha;
          a += px[i + 3];
        }
      }
      const n = scale * scale;
      const o = (y * size + x) * 4;
      const alpha = a / n / 255;
      out[o] = alpha ? Math.round(r / n / alpha) : 0;
      out[o + 1] = alpha ? Math.round(g / n / alpha) : 0;
      out[o + 2] = alpha ? Math.round(b / n / alpha) : 0;
      out[o + 3] = Math.round(a / n);
    }
  }
  return out;
}

export function makeIcon(size, opts) {
  return encodePng(size, size, makeIconRgba(size, opts));
}

export const ICON_SIZES = [16, 24, 32, 48, 64, 96, 128, 180, 192, 256, 384, 512];

/**
 * Builds a multi-resolution Windows ICO. Each entry stores a PNG payload,
 * which Windows Vista and later (and electron-builder) accept.
 */
export function makeIco(sizes = [16, 24, 32, 48, 64, 128, 256]) {
  const images = sizes.map((size) => ({ size, data: makeIcon(size) }));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const dir = Buffer.alloc(images.length * 16);
  let offset = 6 + images.length * 16;
  images.forEach((img, i) => {
    const o = i * 16;
    dir[o] = img.size >= 256 ? 0 : img.size;
    dir[o + 1] = img.size >= 256 ? 0 : img.size;
    dir[o + 2] = 0;
    dir[o + 3] = 0;
    dir.writeUInt16LE(1, o + 4);
    dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(img.data.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += img.data.length;
  });
  return Buffer.concat([header, dir, ...images.map((img) => img.data)]);
}
