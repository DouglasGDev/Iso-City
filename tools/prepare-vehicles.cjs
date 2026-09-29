// Run: node tools/prepare-vehicles.cjs
// First extraction: node tools/prepare-vehicles.cjs --extract-source [absolute ZIP path]
// Requires only pngjs (already installed) and unzip for optional extraction.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { PNG } = require('pngjs');

const root = path.resolve(__dirname, '..');
const sourceDir = path.join(root, 'assets/vehicle-source');
const spritesDir = path.join(root, 'assets/sprites');
const archiveSha256 = 'b478cf692d936e2cfda2368f8d24505841508907adc343f1068a6b2ea457d3fd';
const directions = ['NE', 'NW', 'SE', 'SW'];
// Compared all 16 Sedan 4 views with the named Taxi/Police PNGs, including
// windshield/rear window, hood, wheel baseline and body slope. Do not use
// sequential indices: the other views include cardinal headings and slopes.
const hatchbackIndices = { NE: '003', NW: '001', SE: '008', SW: '007' };
const variants = [
  { id: 'taxi', color: 'yellow', baseKey: 'veh_taxi', width: 60,
    entry: (dir) => `PNG/Taxi/taxi_${dir}.png` },
  { id: 'ambulance', color: '', baseKey: 'veh_ambulance', width: 64,
    entry: (dir) => `PNG/Ambulance/ambulance_${dir}.png` },
  { id: 'hatchback', color: 'blue', baseKey: 'veh_hatchback', width: 56,
    entry: (dir) => `PNG/Civilian/Blue/Sedan 4/carBlue5_${hatchbackIndices[dir]}.png` },
  { id: 'police_compact', color: '', baseKey: 'veh_police_compact', width: 58,
    entry: (dir) => `PNG/Police/police_${dir}.png` },
];
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const entries = ['License.txt', ...variants.flatMap((variant) => directions.map(variant.entry))];

if (process.argv.includes('--extract-source')) {
  const option = process.argv.indexOf('--extract-source');
  const archive = process.argv[option + 1] || path.join(root, 'tools/tmp/kenney_isometric-vehicles.zip');
  if (sha256(fs.readFileSync(archive)) !== archiveSha256) throw new Error('Unexpected Kenney ZIP SHA-256');
  // Whitelist only; never extract archive-controlled paths or run archive code.
  for (const entry of entries) {
    const data = execFileSync('unzip', ['-p', archive, entry], { maxBuffer: 2 * 1024 * 1024 });
    if (entry.endsWith('.png')) PNG.sync.read(data);
    else if (!data.toString().includes('Creative Commons Zero, CC0')) throw new Error('Expected original CC0 license');
    const target = path.join(sourceDir, entry === 'License.txt' ? 'LICENSE.txt' : entry);
    if (fs.existsSync(target)) {
      if (!fs.readFileSync(target).equals(data)) throw new Error(`Refusing to replace modified source: ${target}`);
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data, { flag: 'wx' });
  }
}

const license = fs.readFileSync(path.join(sourceDir, 'LICENSE.txt'));
if (!license.toString().includes('Creative Commons Zero, CC0')) throw new Error('Missing original CC0 license');
const metadata = {
  schemaVersion: 1,
  pack: 'Isometric Vehicles (Kenney Isometric Tiles Vehicles)',
  author: 'Kenney Vleugels / Kenney',
  license: 'CC0-1.0',
  licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
  scope: 'Only the 16 derived PNGs listed here and their retained source PNGs. No license claim is made for the pre-existing vehicle fleet.',
  sourceUrl: 'https://kenney.nl/assets/isometric-tiles-vehicles',
  mirrorUrl: 'https://opengameart.org/content/isometric-vehicles-1',
  archive: {
    name: 'kenney_isometric-vehicles.zip',
    url: 'https://kenney.nl/media/pages/assets/isometric-tiles-vehicles/34c07c3393-1677695121/kenney_isometric-vehicles.zip',
    sha256: archiveSha256,
  },
  originalLicense: { archiveEntry: 'License.txt', file: 'assets/vehicle-source/LICENSE.txt', sha256: sha256(license) },
  preparation: {
    script: 'tools/prepare-vehicles.cjs',
    command: 'node tools/prepare-vehicles.cjs',
    pngjsVersion: require('pngjs/package.json').version,
    sampling: 'nearest-neighbor',
    padding: 2,
    alignment: 'bottom-center; common canvas and uniform scale per variant; integer pixel rounding',
    modifications: 'Transparent padding and proportional resizing only. No recoloring, cropping, rotation or mirroring.',
  },
  directionValidation: {
    gameToNamedSource: { NE: 'NE', NW: 'NW', SE: 'SE', SW: 'SW' },
    hatchbackIndices,
    method: 'Visual comparison of all 16 carBlue5 indices against named taxi and police views: windshield/rear window, hood, wheel baseline and body slope. Selected level isometric diagonals, not cardinal or sloped views.',
  },
  derivatives: [],
};

fs.mkdirSync(path.join(spritesDir, 'Vehicles'), { recursive: true });
for (const variant of variants) {
  const originals = directions.map((direction) => {
    const entry = variant.entry(direction);
    const data = fs.readFileSync(path.join(sourceDir, entry));
    return { direction, entry, data, image: PNG.sync.read(data) };
  });
  const padding = metadata.preparation.padding;
  const scale = (variant.width - padding * 2) / Math.max(...originals.map(({ image }) => image.width));
  const height = Math.max(...originals.map(({ image }) => Math.round(image.height * scale))) + padding * 2;
  for (const { direction, entry, data, image } of originals) {
    const width = Math.round(image.width * scale);
    const scaledHeight = Math.round(image.height * scale);
    const xOffset = Math.floor((variant.width - width) / 2);
    const yOffset = height - padding - scaledHeight;
    const output = new PNG({ width: variant.width, height });
    output.data.fill(0);
    for (let y = 0; y < scaledHeight; y++) {
      const sy = Math.min(image.height - 1, Math.floor((y + 0.5) * image.height / scaledHeight));
      for (let x = 0; x < width; x++) {
        const sx = Math.min(image.width - 1, Math.floor((x + 0.5) * image.width / width));
        const from = (sy * image.width + sx) * 4;
        const to = ((y + yOffset) * output.width + x + xOffset) * 4;
        image.data.copy(output.data, to, from, from + 4);
      }
    }
    const assetKey = `Vehicles/${variant.baseKey}${variant.color ? '_' + variant.color : ''}_${direction}.png`;
    const encoded = PNG.sync.write(output);
    fs.writeFileSync(path.join(spritesDir, assetKey), encoded);
    metadata.derivatives.push({
      variant: variant.id, color: variant.color, direction, assetKey,
      source: { archiveEntry: entry, file: `assets/vehicle-source/${entry}`, sha256: sha256(data), width: image.width, height: image.height },
      output: { file: `assets/sprites/${assetKey}`, sha256: sha256(encoded), width: output.width, height: output.height },
      transform: { scale, scaledWidth: width, scaledHeight, xOffset, yOffset },
    });
    console.log(`${assetKey}: ${output.width}x${output.height}`);
  }
}
fs.writeFileSync(path.join(sourceDir, 'source.json'), JSON.stringify(metadata, null, 2) + '\n');
console.log('Prepared 16 CC0 vehicle sprites; run tools/generate-manifest.js separately.');
