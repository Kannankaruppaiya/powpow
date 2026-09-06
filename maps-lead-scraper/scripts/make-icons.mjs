/**
 * Generates the extension icons (a map pin over a spreadsheet row) as PNGs.
 *
 * Chrome only accepts raster icons, and the repo has no image toolchain, so
 * this rasterises the shape by hand and encodes the PNG with node:zlib.
 * Run with: node scripts/make-icons.mjs
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'icons');
const SIZES = [16, 32, 48, 128];

const BRAND = [11, 87, 208]; // #0b57d0
const ACCENT = [255, 255, 255];

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  // 10-12: compression, filter, interlace — all zero.

  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0; // filter type "None"
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Signed distance style coverage sampling: every pixel is sampled on a 3x3
 * sub-grid so the pin keeps smooth edges even at 16px.
 */
function render(size) {
  const px = Buffer.alloc(size * size * 4);
  const S = 3;

  // Geometry in unit space (0..1), then scaled.
  const pin = { cx: 0.5, cy: 0.4, r: 0.29, tipY: 0.95 };
  const hole = 0.115;

  const inPin = (x, y) => {
    const dx = x - pin.cx;
    const dy = y - pin.cy;
    if (dx * dx + dy * dy <= pin.r * pin.r) return true;
    // Tapered tail from the circle down to the point.
    if (y < pin.cy || y > pin.tipY) return false;
    const t = (y - pin.cy) / (pin.tipY - pin.cy);
    const halfWidth = pin.r * (1 - t) * 0.92;
    return Math.abs(dx) <= halfWidth;
  };

  const inHole = (x, y) => {
    const dx = x - pin.cx;
    const dy = y - pin.cy;
    return dx * dx + dy * dy <= hole * hole;
  };

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let solid = 0;
      let cut = 0;
      for (let sy = 0; sy < S; sy += 1) {
        for (let sx = 0; sx < S; sx += 1) {
          const u = (x + (sx + 0.5) / S) / size;
          const v = (y + (sy + 0.5) / S) / size;
          if (inPin(u, v)) {
            solid += 1;
            if (inHole(u, v)) cut += 1;
          }
        }
      }
      const total = S * S;
      const alpha = solid / total;
      if (alpha === 0) continue;

      const holeRatio = solid ? cut / solid : 0;
      const colour = [
        Math.round(BRAND[0] * (1 - holeRatio) + ACCENT[0] * holeRatio),
        Math.round(BRAND[1] * (1 - holeRatio) + ACCENT[1] * holeRatio),
        Math.round(BRAND[2] * (1 - holeRatio) + ACCENT[2] * holeRatio),
      ];

      const i = (y * size + x) * 4;
      px[i] = colour[0];
      px[i + 1] = colour[1];
      px[i + 2] = colour[2];
      px[i + 3] = Math.round(alpha * 255);
    }
  }
  return px;
}

mkdirSync(OUT_DIR, { recursive: true });
for (const size of SIZES) {
  const file = join(OUT_DIR, `icon${size}.png`);
  writeFileSync(file, encodePng(size, render(size)));
  console.log(`wrote ${file}`);
}
