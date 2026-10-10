// 生成验证用的一张小 PNG（纯 Node，不依赖任何库）
import fs from 'node:fs';
import zlib from 'node:zlib';

const CRC = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const cr = Buffer.alloc(4); cr.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, cr]);
};

export function png(w, h, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8bit / truecolor RGB
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    const o = y * (1 + w * 3); raw[o] = 0;
    for (let x = 0; x < w; x++) {
      raw[o + 1 + x * 3] = (rgb[0] + x * 3) & 255;
      raw[o + 2 + x * 3] = (rgb[1] + y * 2) & 255;
      raw[o + 3 + x * 3] = rgb[2];
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

if (process.argv[1].endsWith('make-test-png.mjs')) {
  const dir = 'scripts/tmpimg';
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(`${dir}/测试形象.png`, png(96, 96, [90, 140, 220]));
  fs.writeFileSync(`${dir}/拖进来的.png`, png(64, 48, [200, 110, 60]));
  fs.writeFileSync(`${dir}/粘贴的.png`, png(48, 64, [120, 180, 90]));
  for (const f of fs.readdirSync(dir)) console.log(f, fs.statSync(`${dir}/${f}`).size, 'B');
}
