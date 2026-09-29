const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

const files = process.argv.slice(2).length ? process.argv.slice(2) : [
  'tile_road_straight_SE_normal.png',
  'tile_road_straight_SW_normal.png',
  'tile_road_corner_N_normal.png', 'tile_road_corner_E_normal.png',
  'tile_road_corner_S_normal.png', 'tile_road_corner_W_normal.png',
  'tile_road_intersection_NE_normal.png', 'tile_road_intersection_NW_normal.png',
  'tile_road_intersection_SE_normal.png', 'tile_road_intersection_SW_normal.png',
  'tile_road_end_NE_normal.png', 'tile_road_end_NW_normal.png',
  'tile_road_end_SE_normal.png', 'tile_road_end_SW_normal.png',
  'tile_road_xsing_normal.png', 'tile_road_xsing_damaged.png',
  'tile_road_pelican_NE_normal.png',
  'tile_ground_asphalt.png', 'tile_ground_grass.png',
  'tile_road_bridge_ramp_NE_normal.png',
];

const base = path.join(__dirname, '..', 'assets', 'sprites', 'Roads and Grounds');
const SAMPLES = 4;

function isDark(r, g, b, a) {
  return a > 120 && r < 95 && g < 95 && b < 98 && (r + g + b) / 3 < 92;
}
function isGreen(r, g, b, a) { return a > 120 && g > r + 30 && g > b + 30; }

for (const f of files) {
  const p = path.join(base, f);
  if (!fs.existsSync(p)) { console.log(`MISSING ${f}`); continue; }
  const png = PNG.sync.read(fs.readFileSync(p));
  const { width: w, height: h } = png;
  const d = png.data;
  const cols = Math.ceil(w / SAMPLES), rows = Math.ceil(h / SAMPLES);
  const dark = Array.from({ length: rows }, () => Array(cols).fill(false));
  const darkCount = { n: 0, e: 0, s: 0, w: 0 };
  for (let gy = 0; gy < rows; gy++) for (let gx = 0; gx < cols; gx++) {
    let cnt = 0;
    for (let dy = 0; dy < SAMPLES; dy++) for (let dx = 0; dx < SAMPLES; dx++) {
      const x = gx * SAMPLES + dx, y = gy * SAMPLES + dy;
      if (x >= w || y >= h) continue;
      const i = (y * w + x) * 4;
      if (isDark(d[i], d[i + 1], d[i + 2], d[i + 3])) cnt++;
    }
    dark[gy][gx] = cnt >= SAMPLES * SAMPLES * 0.6;
  }
  // diamond vertices x positions at each row
  const vert = (r) => { const mid = r + 0.5; const half = (1 - Math.abs((mid - rows / 2) / (rows / 2))) * (cols / 2); return [cols / 2 - half, cols / 2 + half]; };
  for (let r = 0; r < rows; r++) {
    const [v0, v1] = vert(r);
    for (let c = Math.ceil(v0); c < v1; c++) {
      if (dark[r][c]) {
        if (c - v0 < 2) darkCount.w++;
        if (v1 - c < 2) darkCount.e++;
      }
    }
  }
  // north/south: check contact with diamond top/bottom vertices (2px zones)
  const nearV = (r, c) => {
    const [v0, v1] = vert(r);
    const half = (v1 - v0) / 2;
    return Math.abs(c - v0 - half) / Math.max(half, 1) < 0.3;
  };
  for (let r = 0; r < 2; r++) for (let c = 0; c < cols; c++) if (dark[r][c] && nearV(r, c)) darkCount.n++;
  for (let r = rows - 2; r < rows; r++) for (let c = 0; c < cols; c++) if (dark[r][c] && nearV(r, c)) darkCount.s++;

  const edges = ['n', 'e', 's', 'w'].filter((k) => darkCount[k] > 1).join('');
  console.log(`\n=== ${f}  touches: ${edges} ===`);
  for (let r = 0; r < rows; r++) {
    const [v0, v1] = vert(r);
    let line = '';
    for (let c = 0; c < cols; c++) {
      if (c < Math.floor(v0) || c >= Math.ceil(v1)) { line += ' '; continue; }
      const x = c * SAMPLES + 2, y = r * SAMPLES + 2;
      const i = (y * w + x) * 4;
      const a = d[i + 3], R = d[i], G = d[i + 1], B = d[i + 2];
      if (a < 60) line += ' ';
      else if (isGreen(R, G, B, a)) line += '.';
      else if (isDark(R, G, B, a)) line += '#';
      else line += 'o';
    }
    console.log(line);
  }
}