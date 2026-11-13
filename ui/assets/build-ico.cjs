// 把 assets/icon-N.png 打包成多尺寸 .ico（Vista+ 的 PNG 条目）。
const fs = require('fs');
const path = require('path');
const dir = __dirname;
const sizes = [16, 24, 32, 48, 64, 128, 256];
const pngs = sizes.map(s => fs.readFileSync(path.join(dir, `icon-${s}.png`)));
const header = Buffer.alloc(6 + 16 * sizes.length);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
sizes.forEach((s, i) => {
  const at = 6 + i * 16;
  header.writeUInt8(s >= 256 ? 0 : s, at);
  header.writeUInt8(s >= 256 ? 0 : s, at + 1);
  header.writeUInt8(0, at + 2);
  header.writeUInt8(0, at + 3);
  header.writeUInt16LE(1, at + 4);
  header.writeUInt16LE(32, at + 6);
  header.writeUInt32LE(pngs[i].length, at + 8);
  header.writeUInt32LE(offset, at + 12);
  offset += pngs[i].length;
});
const out = Buffer.concat([header, ...pngs]);
fs.writeFileSync(path.join(dir, 'icon.ico'), out);
console.log(JSON.stringify({ icoBytes: out.length, sizes }));
