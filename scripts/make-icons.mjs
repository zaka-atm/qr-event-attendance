// Genera los PNG de la PWA (192, 512 y 180 para iOS) a partir de la misma geometría que icon.svg,
// sin dependencias: rasteriza con supermuestreo y codifica el PNG con zlib.
// Uso: node scripts/make-icons.mjs
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const BG = [0x12, 0x11, 0x10], FG = [0xf4, 0xef, 0xe6], GREEN = [0x0e, 0x7a, 0x3e], WHITE = [255, 255, 255];

// Geometría en un lienzo de 512 (igual que icon.svg).
function colorAt(x, y) {
  // Marca de verificación (trazo grueso de dos segmentos)
  const seg = (ax, ay, bx, by, w) => {
    const dx = bx - ax, dy = by - ay;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(x - (ax + t * dx), y - (ay + t * dy)) <= w / 2;
  };
  if (seg(312, 342, 332, 362, 18) || seg(332, 362, 370, 322, 18)) return WHITE;
  if (Math.hypot(x - 341, y - 341) <= 62) return GREEN;
  // Tres marcos tipo "patrón de posición" de un QR (cuadrados huecos de 28 px de trazo)
  for (const [ox, oy] of [[126, 126], [296, 126], [126, 296]]) {
    const inOuter = x >= ox - 14 && x <= ox + 104 && y >= oy - 14 && y <= oy + 104;
    const inInner = x > ox + 14 && x < ox + 76 && y > oy + 14 && y < oy + 76;
    if (inOuter && !inInner) return FG;
  }
  return BG;
}

function render(size) {
  const SS = 4;
  const px = Buffer.alloc(size * size * 3);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      let r = 0, g = 0, b = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = colorAt(((i + (sx + 0.5) / SS) * 512) / size, ((j + (sy + 0.5) / SS) * 512) / size);
          r += c[0]; g += c[1]; b += c[2];
        }
      }
      const o = (j * size + i) * 3;
      px[o] = r / (SS * SS); px[o + 1] = g / (SS * SS); px[o + 2] = b / (SS * SS);
    }
  }
  return px;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size) {
  const px = render(size);
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) px.copy(raw, y * (size * 3 + 1) + 1, y * size * 3, (y + 1) * size * 3);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8 bits, RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const out = new URL("../web/checkin/icons/", import.meta.url);
for (const size of [192, 512, 180]) {
  writeFileSync(new URL(`icon-${size}.png`, out), png(size));
  console.log(`icon-${size}.png`);
}
