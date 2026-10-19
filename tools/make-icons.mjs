/* ==========================================================================
   生成 PWA 图标（无第三方依赖，node tools/make-icons.mjs）
   --------------------------------------------------------------------------
   图标设计：深色底 + E6 六色 3×2 色块阵列（黑 / 白 / 黄 / 红 / 蓝 / 绿），
   和工具箱本身「六色」的主题一致，也不依赖字体渲染。

   产出（assets/icons/）：
     icon-192.png               192×192  any
     icon-512.png               512×512  any
     icon-maskable-512.png      512×512  maskable（内容收在中央安全区）
     apple-touch-icon-180.png   180×180  iOS 主屏
   ========================================================================== */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '../assets/icons');

/* ---- 最小 PNG 编码（8bit RGBA，无滤波） ---- */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(size, pixels) {
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(pixels.buffer, pixels.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---- 画图标 ---- */
const BG = [15, 23, 42, 255]; // #0f172a，和页面暗色底一致
const TILES = [
  [0x00, 0x00, 0x00, 255], // 黑
  [0xff, 0xff, 0xff, 255], // 白
  [0xff, 0xe6, 0x00, 255], // 黄
  [0xe8, 0x33, 0x2a, 255], // 红
  [0x1b, 0x57, 0xc4, 255], // 蓝
  [0x1f, 0x9d, 0x55, 255], // 绿
];

function drawIcon(size, padRatio, gapRatio) {
  const px = new Uint8Array(size * size * 4);
  const put = (x, y, rgba) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    px[i] = rgba[0];
    px[i + 1] = rgba[1];
    px[i + 2] = rgba[2];
    px[i + 3] = rgba[3];
  };
  const fillRect = (x0, y0, w, h, rgba) => {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) put(x, y, rgba);
  };

  // 底
  fillRect(0, 0, size, size, BG);

  // 3×2 色块：整体收进中央，maskable 用更大的 pad 保证安全区
  const pad = Math.round(size * padRatio);
  const inner = size - pad * 2;
  const gap = Math.round(inner * gapRatio);
  const tileW = Math.floor((inner - gap * 2) / 3);
  const tileH = Math.floor((inner - gap) / 2);
  const radius = Math.max(2, Math.round(Math.min(tileW, tileH) * 0.18));

  for (let r = 0; r < 2; r++) {
    for (let c = 0; c < 3; c++) {
      const index = r * 3 + c;
      const color = TILES[index];
      const x0 = pad + c * (tileW + gap);
      const y0 = pad + r * (tileH + gap);
      // 圆角色块：先铺矩形，再把四角削圆
      fillRect(x0, y0, tileW, tileH, color);
      for (let y = 0; y < radius; y++) {
        for (let x = 0; x < radius; x++) {
          const dx = radius - x - 0.5;
          const dy = radius - y - 0.5;
          if (dx * dx + dy * dy > radius * radius) {
            put(x0 + x, y0 + y, BG);
            put(x0 + tileW - 1 - x, y0 + y, BG);
            put(x0 + x, y0 + tileH - 1 - y, BG);
            put(x0 + tileW - 1 - x, y0 + tileH - 1 - y, BG);
          }
        }
      }
    }
  }
  return px;
}

mkdirSync(outDir, { recursive: true });
const jobs = [
  ['icon-192.png', 192, 0.12, 0.06],
  ['icon-512.png', 512, 0.12, 0.06],
  ['icon-maskable-512.png', 512, 0.22, 0.05],
  ['apple-touch-icon-180.png', 180, 0.12, 0.06],
];

for (const [name, size, pad, gap] of jobs) {
  const png = encodePng(size, drawIcon(size, pad, gap));
  writeFileSync(resolve(outDir, name), png);
  console.log(name.padEnd(26), size + '×' + size, png.length + ' B');
}
