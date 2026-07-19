#!/usr/bin/env node
// 一次性工具:零依賴產生 app/web/apple-touch-icon.png(180×180)。
// iOS 主畫面圖示不吃 SVG,只能給 PNG;這裡用 node:zlib 手組 PNG(靛藍底 + 白色翻開的書)。
// 想換好看的圖:任何 180×180 PNG 同名覆蓋即可,本腳本不會被 server 執行。
'use strict';
const zlib = require('node:zlib');
const fs = require('node:fs');
const path = require('node:path');

const SIZE = 180;
const BG = [0x4f, 0x46, 0xe5]; // 同 index.html --accent
const FG = [0xff, 0xff, 0xff];

// 白色「翻開的書」:左右兩頁,外緣往下斜,中間留書脊縫
function isBook(x, y) {
  const d = Math.abs(x - SIZE / 2);
  if (d < 4 || d > 52) return false;
  const top = 62 + 0.22 * d;
  const bottom = 112 + 0.22 * d;
  return y >= top && y <= bottom;
}

// 每條 scanline 前置 filter byte 0
const raw = Buffer.alloc(SIZE * (1 + SIZE * 3));
for (let y = 0; y < SIZE; y++) {
  const row = y * (1 + SIZE * 3);
  raw[row] = 0;
  for (let x = 0; x < SIZE; x++) {
    const [r, g, b] = isBook(x, y) ? FG : BG;
    const o = row + 1 + x * 3;
    raw[o] = r; raw[o + 1] = g; raw[o + 2] = b;
  }
}

const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
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

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;  // bit depth
ihdr[9] = 2;  // color type: RGB

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const out = path.join(__dirname, '..', 'web', 'apple-touch-icon.png');
fs.writeFileSync(out, png);
console.log(`wrote ${out} (${png.length} bytes)`);
