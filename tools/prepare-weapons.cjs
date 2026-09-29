const fs = require('node:fs');
const path = require('node:path');
const { PNG } = require('pngjs');

const root = path.resolve(__dirname, '..');
const source = path.join(root, 'assets/weapon-source');
const output = path.join(root, 'assets/sprites/Weapons');
const directions = { NE: 'SW', NW: 'SE', SE: 'NW', SW: 'NE' };
// D has a rifle stock/magazine; G has a broad shotgun barrel/fore-end.
// E is the long-barreled precision blaster, J the heavy revolver frame, N the slim machine pistol.
const models = { pistol: 'K', smg: 'I', rifle: 'D', shotgun: 'G', sniper: 'E', revolver: 'J', micro: 'N' };

// Optional, selective extraction. Never unpack archive-controlled paths or URLs.
// The local ZIP is CC0; keep the original License.txt and provenance JSON intact.
if (process.argv.includes('--extract-source')) {
  const { execFileSync } = require('node:child_process');
  const archive = path.join(root, 'tools/tmp/kenney_blasterKit.zip');
  const entries = ['License.txt'];
  for (const letter of Object.values(models)) {
    entries.push(`Models/GLTF format/blaster${letter}.glb`, `Side/blaster${letter}.png`);
    for (const dir of Object.keys(directions)) entries.push(`Isometric/blaster${letter}_${dir}.png`);
  }
  for (const entry of entries) {
    const target = path.resolve(source, entry);
    if (!target.startsWith(source + path.sep)) throw new Error('Invalid source path');
    if (fs.existsSync(target)) continue;
    const data = execFileSync('unzip', ['-p', archive, entry], { maxBuffer: 2 * 1024 * 1024 });
    if (entry.endsWith('.png')) PNG.sync.read(data);
    else if (entry.endsWith('.glb') && data.toString('ascii', 0, 4) !== 'glTF') throw new Error('Invalid GLB');
    else if (entry === 'License.txt' && !data.toString().includes('Creative Commons Zero')) throw new Error('Expected CC0');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data, { flag: 'wx' });
  }
}

function cropAndTint(file) {
  const image = PNG.sync.read(fs.readFileSync(file));
  let left = image.width, top = image.height, right = 0, bottom = 0;
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      if (image.data[(y * image.width + x) * 4 + 3] > 8) {
        left = Math.min(left, x); right = Math.max(right, x);
        top = Math.min(top, y); bottom = Math.max(bottom, y);
      }
    }
  }
  const out = new PNG({ width: right - left + 1, height: bottom - top + 1 });
  PNG.bitblt(image, out, left, top, out.width, out.height, 0, 0);
  for (let i = 0; i < out.data.length; i += 4) {
    const r = out.data[i], g = out.data[i + 1], b = out.data[i + 2];
    const accent = Math.max(r, g, b) - Math.min(r, g, b) > 48;
    const light = r * 0.2126 + g * 0.7152 + b * 0.0722;
    const shade = accent ? 34 + light * 0.25 : 24 + light * 0.62;
    out.data[i] = shade;
    out.data[i + 1] = shade + 5;
    out.data[i + 2] = shade + 10;
  }
  return out;
}

fs.mkdirSync(output, { recursive: true });
for (const [id, letter] of Object.entries(models)) {
  for (const [direction, sourceDirection] of Object.entries(directions)) {
    const image = cropAndTint(path.join(source, `Isometric/blaster${letter}_${sourceDirection}.png`));
    fs.writeFileSync(path.join(output, `${id}_${direction}.png`), PNG.sync.write(image));
    console.log(`${id}_${direction}: ${image.width}x${image.height}`);
  }
  const icon = cropAndTint(path.join(source, `Side/blaster${letter}.png`));
  fs.writeFileSync(path.join(output, `${id}_icon.png`), PNG.sync.write(icon));
}

// Original tapered wooden bat, analytic capsule rasterization (4x antialiasing).
// No third-party texture or firearm model; the runtime swing uses matching vectors.
function makeBat(dx, dy) {
  const length = Math.hypot(dx, dy);
  const ux = dx / length, uy = dy / length;
  const width = Math.ceil(Math.abs(dx)) + 16, height = Math.ceil(Math.abs(dy)) + 16;
  const startX = 8 - Math.min(0, dx), startY = 8 - Math.min(0, dy);
  const out = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let count = 0, red = 0, green = 0, blue = 0;
      for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
        const px = x + (sx + 0.5) / 4 - startX, py = y + (sy + 0.5) / 4 - startY;
        const along = px * ux + py * uy;
        const t = Math.max(0, Math.min(1, along / length));
        const across = -px * uy + py * ux;
        const radius = t < 0.045 ? 2.8 : t < 0.3 ? 1.6 : 1.6 + Math.min(1, (t - 0.3) / 0.5) * 3.3;
        const distance = Math.hypot(across, along < 0 ? along : along > length ? along - length : 0);
        if (distance > radius) continue;
        const grip = t > 0.05 && t < 0.28;
        const edge = distance / radius > 0.82;
        const shade = edge ? -35 : -across / radius * 19 + Math.sin(along * 0.6) * 3;
        red += (grip ? 77 : 185) + shade;
        green += (grip ? 59 : 133) + shade;
        blue += (grip ? 43 : 79) + shade;
        count++;
      }
      if (!count) continue;
      const i = (y * width + x) * 4;
      out.data[i] = red / count;
      out.data[i + 1] = green / count;
      out.data[i + 2] = blue / count;
      out.data[i + 3] = Math.round(count / 16 * 255);
    }
  }
  return out;
}
for (const [direction, angle] of Object.entries({ SE: 0, SW: Math.PI / 2, NW: Math.PI, NE: -Math.PI / 2 })) {
  const x = Math.cos(angle), y = Math.sin(angle);
  const image = makeBat((x - y) * 48, (x + y) * 24 - 8);
  fs.writeFileSync(path.join(output, `bat_${direction}.png`), PNG.sync.write(image));
}
fs.writeFileSync(path.join(output, 'bat_icon.png'), PNG.sync.write(makeBat(64, 0)));
console.log('bat: original wood sprites generated; asset manifest intentionally not changed');
