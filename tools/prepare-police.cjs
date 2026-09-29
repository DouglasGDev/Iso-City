const fs = require('node:fs');
const path = require('node:path');
const { PNG } = require('pngjs');
const root = path.resolve(__dirname, '../assets/sprites/Characters');
const files = fs.readdirSync(root).filter((name) => /^char_a_(idle|walk)_/.test(name));
for (const file of files) {
  const image = PNG.sync.read(fs.readFileSync(path.join(root, file)));
  const front = /_(SE|SW)_/.test(file);
  const right = /_(NE|SE)_/.test(file);
  const pixel = (x, y, rgb) => {
    const i = (y * image.width + x) * 4;
    if (image.data[i + 3] < 50) return;
    for (let c = 0; c < 3; c++) image.data[i + c] = rgb[c];
  };
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const i = (y * image.width + x) * 4;
      if (image.data[i + 3] < 50) continue;
      const light = (image.data[i] + image.data[i + 1] + image.data[i + 2]) / 3;
      if (y >= 9 && y < 20) {
        const hands = y >= 16 && (right ? x < 9 : x > 14);
        if (!hands) pixel(x, y, [20 + light * 0.08, 38 + light * 0.11, 64 + light * 0.14]);
      } else if (y >= 20) pixel(x, y, [16 + light * 0.07, 24 + light * 0.1, 38 + light * 0.12]);
      else if (y <= 5) pixel(x, y, [20 + light * 0.05, 38 + light * 0.07, 63 + light * 0.1]);
      if (y === 19) pixel(x, y, [22, 24, 27]);
    }
  }
  const chest = right ? 13 : 10;
  if (front) {
    pixel(chest, 11, [249, 212, 96]);
    pixel(chest, 12, [223, 176, 54]);
    pixel(chest + (right ? -3 : 3), 13, [150, 175, 186]);
  } else {
    for (let x = 10; x <= 14; x++) pixel(x, 11, [172, 190, 202]);
  }
  pixel(right ? 13 : 10, 5, [242, 200, 77]);
  pixel(chest, 19, [170, 176, 165]);
  fs.writeFileSync(path.join(root, file.replace('char_a_', 'char_police_')), PNG.sync.write(image));
}
console.log(`Prepared ${files.length} police sprites with navy uniform, cap, badge and duty belt`);
