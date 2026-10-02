// Run: node tools/check/check-map-presentation.cjs
// Load real TS/TSX in memory. No emitted files, native runtime, browser, or production edits.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');
const srcPath = (name) => path.join(root, 'src', name);
const cache = new Map();
let currentGame;
let windowSize = { width: 390, height: 844 };
const ui = { gameGen: 0, mapMarker: null, mapRoute: [] };
const element = (type, props, key) => ({ type, props: props || {}, key: key == null ? null : String(key) });
const hooks = {
  useMemo: (fn) => fn(), useCallback: (fn) => fn, useRef: (value) => ({ current: value }),
  useState: (value) => [typeof value === 'function' ? value() : value, () => {}],
  // As telas de UI leem a store de navegação; aqui a snapshot é lida uma vez, sem assinatura.
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  useEffect() {}, // Inspect synchronous output, not timers or React lifecycle/native drawing.
};
function gesture() {
  const chain = new Proxy({}, { get: () => () => chain });
  return chain;
}
let imagesBaked = 0, dataDisposed = 0;
const stubs = {
  react: hooks,
  'react/jsx-runtime': { jsx: element, jsxs: element, Fragment: 'Fragment' },
  'react-native': {
    StyleSheet: { create: (styles) => styles, absoluteFill: {}, absoluteFillObject: {} },
    Text: 'Text', TouchableOpacity: 'TouchableOpacity', View: 'View', useWindowDimensions: () => windowSize,
  },
  '@shopify/react-native-skia': {
    Canvas: 'Canvas', Circle: 'Circle', Group: 'Group', Image: 'Image', Path: 'Path', Rect: 'Rect',
    AlphaType: { Unpremul: 'Unpremul' }, ColorType: { RGBA_8888: 'RGBA_8888' }, FilterMode: { Linear: 'Linear' },
    Skia: {
      Data: { fromBytes: (bytes) => ({ bytes, dispose() { dataDisposed++; } }) },
      Image: { MakeImage(info, data, rowBytes) {
        assert.equal(info.alphaType, 'Unpremul'); assert.equal(info.colorType, 'RGBA_8888');
        assert.equal(rowBytes, info.width * 4); assert.equal(data.bytes.length, rowBytes * info.height);
        imagesBaked++;
        return { ...info, pixels: data.bytes.slice() };
      } },
    },
  },
  'react-native-gesture-handler': {
    GestureDetector: 'GestureDetector',
    Gesture: { Pan: gesture, Pinch: gesture, Tap: gesture, Race: (...items) => items, Simultaneous: (...items) => items },
  },
  'react-native-safe-area-context': { useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) },
  [srcPath('game/GameState.ts')]: { getGame: () => currentGame },
  [srcPath('stores/useGameStore.ts')]: { useGameStore: (select) => select(ui) },
  [srcPath('audio/SoundManager.ts')]: { sound: { play() {} } },
  [srcPath('ui/useControlInsets.ts')]: { useControlInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) },
};
function load(filename) {
  if (!path.extname(filename)) filename = ['.ts', '.tsx'].map((ext) => filename + ext).find(fs.existsSync) || filename + '.ts';
  if (Object.hasOwn(stubs, filename)) return stubs[filename];
  if (cache.has(filename)) return cache.get(filename).exports;
  let text = fs.readFileSync(filename, 'utf8');
  // Expose the actual private component only to this in-memory module.
  if (filename === srcPath('ui/MiniMap.tsx')) text += '\nexport { MapCanvas as __testMapCanvas };\n';
  const result = ts.transpileModule(text, {
    fileName: filename, reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX, strict: true, esModuleInterop: true },
  });
  assert.deepEqual(result.diagnostics, [], filename);
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.paths = Module._nodeModulePaths(path.dirname(filename));
  mod.require = (name) => Object.hasOwn(stubs, name) ? stubs[name]
    : name.startsWith('.') ? load(path.resolve(path.dirname(filename), name)) : require(name);
  cache.set(filename, mod);
  mod._compile(result.outputText, filename);
  return mod.exports;
}
const source = (name) => load(srcPath(name));
const { isoMetrics, mapPoint, makeProjectors, mapPolygon, explorationPaths, radarPixels, MAP_COLORS: C } = source('world/MapPresentation.ts');
const { ExplorationSystem } = source('systems/ExplorationSystem.ts');
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('OK ' + name); }
  catch (error) { failed++; console.error('FAIL ' + name + '\n' + error.stack); }
}
function near(actual, expected, label = 'coordinate') {
  assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) <= 1e-8 * Math.max(1, Math.abs(expected)),
    `${label}: expected ${expected}, received ${actual}`);
}
function pointNear(actual, expected, label = 'point') {
  near(actual.x, expected.x, label + '.x'); near(actual.y, expected.y, label + '.y');
}
const visit = (e, x, y) => e.update({ position: { x, y }, outdoors: true });
function snapshot(e) {
  return { width: e.width, height: e.height, tiles: Array.from(e.tiles), version: e.version,
    explored: e.exploredCount, visited: e.visitedCount, percent: e.percent,
    previous: e.previous && { ...e.previous } };
}
// Independent M/L/Z parser; reject ignored commands, malformed numbers and trailing garbage.
function commands(value) {
  const number = '[-+]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:e[-+]?\\d+)?';
  const token = new RegExp(`([ML])\\s*(${number})\\s*,\\s*(${number})|Z`, 'gi');
  const out = [];
  let end = 0;
  for (const m of value.matchAll(token)) {
    assert.equal(value.slice(end, m.index).trim(), '', 'unparsed path content');
    out.push(m[1] ? { cmd: m[1].toUpperCase(), x: Number(m[2]), y: Number(m[3]) } : { cmd: 'Z' });
    end = m.index + m[0].length;
  }
  assert.equal(value.slice(end).trim(), '', 'unparsed path suffix');
  return out;
}
function polygons(value) {
  if (value === 'M0,0') return [];
  const out = [];
  let polygon = null;
  for (const p of commands(value)) {
    if (p.cmd === 'M') { assert.equal(polygon, null, 'unclosed polygon'); polygon = [p]; }
    else if (p.cmd === 'L') { assert.ok(polygon, 'line before move'); polygon.push(p); }
    else { assert.ok(polygon, 'close without polygon'); out.push(polygon); polygon = null; }
  }
  assert.equal(polygon, null, 'missing close');
  return out;
}
const inverseIso = (p, h) => ({ x: p.y + (p.x - h) / 2, y: p.y - (p.x - h) / 2 });
const viewports = [[390, 844], [844, 390], [1440, 900], [1920, 1080], [112, 112], [84, 84]];
const maps = [[240, 240], [160, 160], [73, 29], [29, 73], [1, 1]];

test('isoMetrics and mapPoint keep a 2:1 diamond with non-square dimensions', () => {
  for (const [w, h] of maps) {
    const metrics = isoMetrics(w, h);
    assert.deepEqual(metrics, { ox: h, imgW: w + h + 1, imgH: (w + h) / 2 + 1 });
    near((metrics.imgW - 1) / (metrics.imgH - 1), 2, 'unpadded diamond aspect');
    pointNear(mapPoint(0, 0, h), { x: h, y: 0 });
    pointNear(mapPoint(w, 0, h), { x: h + w, y: w / 2 });
    pointNear(mapPoint(w, h, h), { x: w, y: (w + h) / 2 });
    pointNear(mapPoint(0, h, h), { x: 0, y: h / 2 });
    const a = mapPoint(0.125, 0.75, h), b = mapPoint(1.125, 0.75, h), c = mapPoint(0.125, 1.75, h);
    pointNear({ x: b.x - a.x, y: b.y - a.y }, { x: 1, y: 0.5 });
    pointNear({ x: c.x - a.x, y: c.y - a.y }, { x: -1, y: 0.5 });
  }
});

test('projectors invert fractional world/screen positions across phones, desktops, zooms and pans', () => {
  for (const [mw, mh] of viewports) for (const [w, h] of maps) for (const pad of [0, 12]) {
    for (const zoom of [1, 2.2, 5, 6]) for (const [panX, panY] of [[0, 0], [71.25, -42.75], [-mw, mh]]) {
      const p = makeProjectors(mw, mh, pad, w, h, zoom, panX, panY);
      const fit = Math.min((mw - 2 * pad) / (w + h + 1), (mh - 2 * pad) / ((w + h) / 2 + 1));
      near(p.scale, fit * zoom, 'fit scale');
      for (const [x, y] of [[0, 0], [w, h], [w, 0], [0, h], [w * 0.317, h * 0.683], [-1.25, h + 2.75]]) {
        const actual = p.worldToScreen(x, y);
        pointNear(actual, { x: mw / 2 + panX + (x - y + h - (w + h + 1) / 2) * fit * zoom,
          y: mh / 2 + panY + ((x + y) / 2 - ((w + h) / 2 + 1) / 2) * fit * zoom }, 'independent projection');
        pointNear(p.screenToWorld(actual.x, actual.y), { x, y }, 'world round trip');
      }
      for (const [x, y] of [[0, 0], [mw, mh], [mw * 0.271, mh * 0.629], [-20.25, mh + 99.75]]) {
        const world = p.screenToWorld(x, y);
        pointNear(p.worldToScreen(world.x, world.y), { x, y }, 'screen round trip');
      }
    }
  }
});

test('overview contains the entire city and centering places any selected world point at viewport center', () => {
  for (const [mw, mh] of viewports) for (const [w, h] of maps) for (const pad of [0, 12]) {
    const p = makeProjectors(mw, mh, pad, w, h, 1, 0, 0);
    near(p.imgX + p.imgW * p.scale / 2, mw / 2, 'image centered horizontally');
    near(p.imgY + p.imgH * p.scale / 2, mh / 2, 'image centered vertically');
    assert.ok(p.imgX >= pad - 1e-8 && p.imgY >= pad - 1e-8);
    assert.ok(p.imgX + p.imgW * p.scale <= mw - pad + 1e-8);
    assert.ok(p.imgY + p.imgH * p.scale <= mh - pad + 1e-8);
    for (const [x, y] of [[0, 0], [w, 0], [w, h], [0, h], [w * 0.31, h * 0.67]]) {
      const s = p.worldToScreen(x, y);
      assert.ok(s.x >= pad - 1e-8 && s.x <= mw - pad + 1e-8 && s.y >= pad - 1e-8 && s.y <= mh - pad + 1e-8);
      for (const zoom of [1, 2.2, 5, 6]) {
        const centered = makeProjectors(mw, mh, pad, w, h, zoom, (mw / 2 - s.x) * zoom, (mh / 2 - s.y) * zoom);
        pointNear(centered.worldToScreen(x, y), { x: mw / 2, y: mh / 2 });
        pointNear(centered.screenToWorld(mw / 2, mh / 2), { x, y });
      }
    }
  }
});

test('mapPolygon corners, winding, area and shared edges agree with the isometric transform', () => {
  for (const h of [1, 29, 73, 160, 240]) for (const [x, y, w, height] of [[0, 0, 1, 1], [3, 7, 8, 1], [0.25, 2.75, 3.5, 4.25], [0, 0, 73, h]]) {
    const [points] = polygons(mapPolygon(x, y, w, height, h));
    assert.equal(points.length, 4);
    const corners = [[x, y], [x + w, y], [x + w, y + height], [x, y + height]];
    points.forEach((p, i) => { pointNear(p, mapPoint(...corners[i], h)); pointNear(inverseIso(p, h), { x: corners[i][0], y: corners[i][1] }); });
    const area = points.reduce((sum, p, i) => { const next = points[(i + 1) % 4]; return sum + p.x * next.y - next.x * p.y; }, 0) / 2;
    near(area, w * height, 'positive area (no crossed edges)');
    const [right] = polygons(mapPolygon(x + w, y, 1, height, h));
    pointNear(points[1], right[0]); pointNear(points[2], right[3]);
  }
});

function assertPathCells(e) {
  const paths = explorationPaths(e);
  for (const [field, query] of [['discovered', 'isExplored'], ['visited', 'isVisited']]) {
    const coverage = new Uint8Array(e.width * e.height);
    const runs = polygons(paths[field]);
    let expectedRuns = 0;
    for (let y = 0; y < e.height; y++) for (let x = 0; x < e.width; x++) {
      if (e[query](x, y) && (x === 0 || !e[query](x - 1, y))) expectedRuns++;
    }
    assert.equal(runs.length, expectedRuns, field + ' maximal row runs');
    for (const run of runs) {
      assert.equal(run.length, 4);
      const [a, b, c, d] = run.map((p) => inverseIso(p, e.height));
      for (const p of [a, b, c, d]) assert.ok(Number.isInteger(p.x) && Number.isInteger(p.y), 'integer cell boundaries');
      pointNear(c, { x: b.x, y: a.y + 1 }); pointNear(d, { x: a.x, y: a.y + 1 });
      assert.equal(b.y, a.y); assert.ok(b.x > a.x);
      assert.ok(a.x >= 0 && b.x <= e.width && a.y >= 0 && a.y < e.height);
      for (let x = a.x; x < b.x; x++) {
        const index = a.y * e.width + x;
        assert.equal(coverage[index], 0, `${field} overlapping cell ${x},${a.y}`);
        coverage[index] = 1;
      }
    }
    for (let y = 0; y < e.height; y++) for (let x = 0; x < e.width; x++) {
      assert.equal(coverage[y * e.width + x], Number(e[query](x, y)), `${field} hole/false cell ${x},${y}`);
    }
  }
  assert.deepEqual(explorationPaths(e), paths, 'stable repeated presentation');
}

test('exploration paths exactly cover empty/full/checkerboard/hollow/disconnected grids and edge runs', () => {
  const patterns = [
    ['00000', '00000'], ['22222', '22222'], ['12121', '20202', '12121'],
    ['22222', '20002', '20102', '20002', '22222'], ['200002', '001100', '200002'],
    ['00002'], ['2', '0', '1', '2'], [], ['', '', ''],
  ];
  let seed = 0x41c6;
  for (let i = 0; i < 12; i++) patterns.push(Array.from({ length: 3 + i }, () => Array.from({ length: 19 - i }, () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return String(seed % 3);
  }).join('')));
  for (const rows of patterns) {
    Object.freeze(rows);
    const query = (x, y) => {
      assert.ok(Number.isInteger(x) && Number.isInteger(y));
      assert.ok(x >= 0 && x < rows[0].length && y >= 0 && y < rows.length, 'query must stay in grid');
      return Number(rows[y][x]);
    };
    const e = Object.freeze({ width: rows[0]?.length || 0, height: rows.length, version: 17,
      isExplored: (x, y) => query(x, y) > 0, isVisited: (x, y) => query(x, y) === 2 });
    assertPathCells(e); assert.equal(e.version, 17);
  }
});

test('paths match real ExplorationSystem cells without changing bytes, counts, version or trail', () => {
  for (const [w, h] of [[37, 23], [23, 37], [1, 1], [0, 0], [0, 4], [4, 0]]) {
    const e = new ExplorationSystem(w, h);
    for (const p of [null, [0.5, 0.5], [w - 0.5, h - 0.5], [w / 2, h / 2], [w / 2 + 2, h / 2 + 1]]) {
      if (p) visit(e, ...p);
      const before = snapshot(e);
      assertPathCells(e);
      assert.deepEqual(snapshot(e), before, 'presentation must be read-only');
    }
  }
});

const biomeRgb = {
  downtown: [49, 66, 77], commercial: [62, 69, 72], market: [70, 72, 63], residential: [45, 72, 67],
  suburb: [45, 75, 63], park: [37, 77, 59], industrial: [67, 65, 67], docks: [42, 69, 81],
  forest: [30, 61, 50], countryside: [58, 75, 54], beach: [143, 130, 96],
  pinewood: [31, 73, 71], savanna: [119, 101, 57], desert: [131, 118, 92],
};
function mapData(w, h) {
  return { tilesW: w, tilesH: h, worldW: w, worldH: h, buildings: [], props: [], vehicles: [], npcSpawns: [],
    playerSpawn: { x: 0.5, y: 0.5 },
    tiles: Array.from({ length: w * h }, () => ({ kind: 'grass', biome: 'park', key: 'tile_ground_grass' })) };
}
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function assertRaster(data, colors) {
  freeze(data);
  const before = JSON.stringify(data), raster = radarPixels(data);
  const { width, height, pixels } = raster, w = data.tilesW, h = data.tilesH;
  assert.equal(width, (w + h + 1) * 3); assert.equal(height, Math.ceil(((w + h) / 2 + 1) * 3));
  assert.ok(pixels instanceof Uint8Array); assert.equal(pixels.length, width * height * 4);
  const samples = new Uint16Array(w * h);
  let outside = 0;
  for (let py = 0; py < height; py++) for (let px = 0; px < width; px++) {
    // Pixel centers transformed independently, without calling either production projector.
    const x = Math.floor((2 * py + px + 1.5 - 3 * h) / 6);
    const y = Math.floor((2 * py - px + 0.5 + 3 * h) / 6);
    const index = (py * width + px) * 4;
    let expected = [0, 0, 0, 0];
    if (x >= 0 && y >= 0 && x < w && y < h) {
      expected = [...colors[y * w + x], 255]; samples[y * w + x]++;
    } else outside++;
    assert.deepEqual(Array.from(pixels.subarray(index, index + 4)), expected, `raster ${px},${py}, cell ${x},${y}`);
  }
  assert.ok(outside > 0, 'transparent pixels outside city');
  assert.ok(samples.every((n) => n > 0), 'every world cell was sampled');
  const again = radarPixels(data);
  assert.notEqual(again.pixels, pixels); assert.deepEqual(again, raster);
  assert.equal(JSON.stringify(data), before);
}

test('raster colors sample roads, bridges, water, concrete, all biomes and south-anchored building footprints', () => {
  const data = mapData(13, 9), names = Object.keys(biomeRgb);
  data.tiles.forEach((t, i) => { t.biome = names[i % names.length]; });
  const colors = data.tiles.map((t) => biomeRgb[t.biome]);
  function tile(x, y, fields, rgb) { Object.assign(data.tiles[y * 13 + x], fields); colors[y * 13 + x] = rgb; }
  // footprintH is projected sprite metadata: both world axes use footprintW (south-point anchor).
  data.buildings = [{ x: 8.25, y: 6.75, footprintW: 2.5, footprintH: 1.25 },
    { x: 1, y: 1, footprintW: 3, footprintH: 1.5 }, { x: 14, y: 10, footprintW: 3, footprintH: 1.5 }];
  for (const [x0, y0, x1, y1] of [[5, 4, 9, 7], [0, 0, 1, 1], [11, 7, 13, 9]]) {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) colors[y * 13 + x] = [94, 111, 119];
  }
  tile(0, 2, { kind: 'road' }, [159, 174, 178]);
  tile(1, 2, { kind: 'road', secondary: true }, [118, 117, 94]);
  tile(2, 2, { kind: 'road', key: 'tile_road_dirt' }, [118, 117, 94]);
  tile(3, 2, { kind: 'road', bridge: true, secondary: true }, [172, 159, 123]);
  tile(4, 2, { kind: 'water' }, [28, 55, 75]);
  tile(5, 2, { kind: 'concrete' }, [67, 83, 91]);
  tile(6, 5, { kind: 'road' }, [159, 174, 178]); // Buildings may not cover roads/water.
  tile(7, 5, { kind: 'water' }, [28, 55, 75]);
  tile(8, 5, { kind: 'concrete' }, [94, 111, 119]);
  assertRaster(data, colors);
});

test('raster dimensions and exterior alpha also work for odd sums, thin and empty maps', () => {
  for (const [w, h] of [[9, 4], [4, 9], [1, 1], [1, 4], [4, 1], [0, 0], [0, 3], [3, 0]]) {
    const data = mapData(w, h);
    assertRaster(data, data.tiles.map(() => biomeRgb.park));
  }
});

const { __testMapCanvas: MapCanvas, MiniMap, FullMap } = source('ui/MiniMap.tsx');
const { InteriorPlan } = source('ui/InteriorPlan.tsx');
const { remainingRouteDistance } = source('world/Gps.ts');
const canvasProps = { mapW: 390, mapH: 844, zoom: 1, panX: 0, panY: 0, detailed: true };
function walk(tree, ancestors = [], out = []) {
  if (Array.isArray(tree)) tree.forEach((child) => walk(child, ancestors, out));
  else if (tree && typeof tree === 'object' && tree.props) {
    out.push({ node: tree, ancestors }); walk(tree.props.children, [...ancestors, tree], out);
  }
  return out;
}
function textOf(tree) {
  if (Array.isArray(tree)) return tree.map(textOf).join('');
  if (tree == null || typeof tree === 'boolean') return '';
  if (typeof tree !== 'object') return String(tree);
  return textOf(tree.props?.children);
}
function fixture(empty = false) {
  Object.assign(ui, { gameGen: ui.gameGen + 1, mapMarker: { x: 50.25, y: 30.75 },
    mapRoute: [{ x: 16.5, y: 17.5 }, { x: 40.5, y: 25.5 }, { x: 50.25, y: 30.75 }] });
  windowSize = { width: 390, height: 844 };
  const e = new ExplorationSystem(64, 40);
  if (!empty) visit(e, 16.5, 17.5);
  // Known markers sit on the radius edge: rounding instead of flooring is also wrong.
  const known = { x: 24.8, y: 17.9 }, unknown = { x: 25.1, y: 17.2 };
  const npc = (id, kind, p, extra = {}) => ({ id, kind, ...p, dead: false, inVehicle: false, ...extra });
  const car = (id, type, p, extra = {}) => ({ id, def: { type }, ...p, state: 'parked', ...extra });
  currentGame = {
    map: { data: mapData(64, 40), roadNodes: [], sidewalkNodes: [] }, exploration: e,
    player: { x: 16.5, y: 17.5, facingAngle: 0.37, currentVehicleId: null },
    npcs: [npc(1, 'civilian', known), npc(2, 'cop', known), npc(101, 'civilian', unknown), npc(102, 'cop', unknown),
      npc(201, 'civilian', known, { dead: true }), npc(202, 'cop', known, { inVehicle: true })],
    vehicles: [car(3, 'sedan', known), car(4, 'police', known), car(103, 'sedan', unknown), car(104, 'police', unknown),
      car(203, 'sedan', known, { state: 'destroyed' })],
    interiors: { active: null, street: null, entrances: [{ id: 6, ...known, kind: 'home' }, { id: 106, ...unknown, kind: 'home' }] },
    // GameState.worldPosition é um getter real: a cidade só enxerga o pé da porta.
    get worldPosition() { return this.interiors.active ? (this.interiors.street ?? this.interiors.active.entrance) : this.player; },
    crowd: { list: [] }, jail: { occupants: [], keysOnFloor: null },
    pickups: { items: [{ id: 5, ...known, kind: 'ammo', active: true }, { id: 105, ...unknown, kind: 'ammo', active: true }] },
    missions: { state: { phase: 'travel', target: { x: 47.75, y: 31.25 } } }, police: { searchArea: null },
    // O radar pergunta o que a polícia vê; o fixture devolve o que o teste quiser desenhar.
    visionCones: [], policeVisionCones() { return this.visionCones; },
  };
  for (const method of ['isExplored', 'isVisited']) {
    const original = e[method].bind(e);
    e[method] = (x, y) => {
      assert.ok(Number.isInteger(x) && Number.isInteger(y), `${method} requires integer CELL coordinates; UI supplied ${x},${y}`);
      return original(x, y);
    };
  }
  e.update = () => assert.fail('rendering must not update exploration');
  e.breakTrail = () => assert.fail('rendering must not alter exploration trail');
  return currentGame;
}
/** A porta fica no lote 36,27 da cidade; a sala tem 7×5 tiles do plano dela. */
const roomEntrance = { x: 36.4, y: 26.9, facing: 0 };
function roomShape() {
  return {
    kind: 'shop', label: 'Mercado do Bairro', entrance: roomEntrance,
    service: { x: 1.4, y: 4.2 }, exit: { x: 3.5, y: 0.2 },
    map: { worldW: 7, worldH: 5 },
    furniture: [{ id: 'shelf-a', kind: 'shelf', x: 0.6, y: 1.2, w: 1.4, d: 0.5, color: '#6b5f4a' },
      { id: 'counter-a', kind: 'counter', x: 0.8, y: 3.4, w: 1.6, d: 0.6, color: '#7a6c52' }],
  };
}
function readOnlyRender(render) {
  const before = snapshot(currentGame.exploration), entities = JSON.stringify(currentGame), state = JSON.stringify(ui);
  const tree = render();
  assert.deepEqual(snapshot(currentGame.exploration), before);
  assert.equal(JSON.stringify(currentGame), entities, 'rendering mutated game/entities');
  assert.equal(JSON.stringify(ui), state, 'rendering mutated GPS state');
  return walk(tree);
}
function projectFor(props) {
  return makeProjectors(props.mapW, props.mapH, 0, 64, 40, props.zoom, props.panX, props.panY).worldToScreen;
}
function markerCenter(node) {
  return node.type === 'Circle' ? { x: node.props.cx, y: node.props.cy }
    : { x: node.props.x + node.props.width / 2, y: node.props.y + node.props.height / 2 };
}
function unclipped(entry) {
  assert.ok(!entry.ancestors.some((parent) => parent.props.clip), 'navigation/marker must not be inside discovery clip');
}

for (const detailed of [true, false]) test(`MapCanvas ${detailed ? 'detailed map' : 'radar'} shows fractional known markers and hides unknown/ineligible markers`, () => {
  const game = fixture(), props = { ...canvasProps, detailed };
  const entries = readOnlyRender(() => MapCanvas(props)), byKey = new Map(entries.map(({ node }) => [node.key, node]));
  const shown = ['cop2', 'v3', 'v4', 'ammo5', ...(detailed ? ['n1', 'door6'] : [])];
  for (const key of shown) {
    const node = byKey.get(key); assert.ok(node, `${key} missing from discovered fractional cell`);
    pointNear(markerCenter(node), projectFor(props)(24.8, 17.9), key + ' uses exact world position');
  }
  for (const key of ['n101', 'cop102', 'v103', 'v104', 'ammo105', 'door106', 'n201', 'cop202', 'v203',
    ...(!detailed ? ['n1', 'door6'] : [])]) assert.ok(!byKey.has(key), key + ' must be hidden');
  const mask = explorationPaths(game.exploration);
  const image = entries.find(({ node }) => node.type === 'Image');
  assert.ok(image, 'real bakeRadar feeds Skia image');
  assert.ok(image.ancestors.some((n) => n.props.clip === mask.discovered), 'raster clipped to actual discoveries');
  // O rastro do já percorrido saiu do mapa de propósito: em verde por cima da tinta da
  // cidade ele lia como território conquistado e sujava o plano. O que continua desenhado é
  // a máscara de descoberta, que é o clip da imagem logo acima — e é por isso que esta
  // asserção é negativa: se aparecer um traçado com o caminho do `visited`, o rastro voltou.
  const trail = entries.find(({ node }) => node.type === 'Path' && node.props.path === mask.visited);
  assert.ok(!trail, 'o rastro verde do já percorrido voltou a ser pintado no mapa');
  assert.equal(imagesBaked, dataDisposed, 'temporary Skia data disposed');
});

for (const detailed of [true, false]) test(`MapCanvas ${detailed ? 'detailed map' : 'radar'} desenha o arco de visão dos oficiais, não um raio-x da HUD`, () => {
  const game = fixture();
  // Um oficial conhecido com a guarda alta, um conhecido desconfiado e um em célula não descoberta.
  game.visionCones = [
    { id: 2, x: 24.8, y: 17.9, axis: 0.4, half: 1.1, radius: 12, alert: 1 },
    { id: 3, x: 24.2, y: 17.4, axis: -1.2, half: 0.7, radius: 9, alert: 0.34 },
    { id: 9, x: 25.1, y: 17.2, axis: 0.2, half: 1, radius: 11, alert: 1 },
  ];
  const props = { ...canvasProps, detailed };
  const entries = readOnlyRender(() => MapCanvas(props)), project = projectFor(props);
  const cones = entries.filter(({ node }) => String(node.key ?? '').startsWith('cone'));
  assert.deepEqual(cones.map(({ node }) => node.key), ['cone2', 'cone3'], 'cone em célula não descoberta some do mapa');
  for (const { node, ancestors } of cones) {
    assert.ok(!ancestors.some((parent) => parent.props.clip), 'cone não pode sumir atrás do mask de descoberta');
    const wedges = (node.props.children || []).flat();
    assert.equal(wedges.length, 2, 'cada arco é um leque preenchido e contornado');
    assert.ok(wedges.every((w) => w.type === 'Path' && w.props.path.startsWith('M')));
    assert.ok(wedges[0].props.opacity <= 0.25 && wedges[0].props.opacity > 0, 'preenchimento translúcido');
    const segments = wedges[0].props.path.slice(1).replace(' Z', '').split(' L');
    const cone = game.visionCones.find((c) => `cone${c.id}` === node.key);
    const apex = segments[0].split(',').map(Number);
    // A ponta do arco é o ponto do mundo em axis+half, projetado — não um círculo na tela.
    const tip = segments[segments.length - 1].split(',').map(Number);
    const expectedApex = project(cone.x, cone.y);
    const expectedTip = project(cone.x + Math.cos(cone.axis + cone.half) * cone.radius,
      cone.y + Math.sin(cone.axis + cone.half) * cone.radius);
    for (const [i, axis] of ['x', 'y'].entries()) {
      assert.ok(Math.abs(apex[i] - expectedApex[axis]) < 0.01, 'o leque nasce no oficial');
      assert.ok(Math.abs(tip[i] - expectedTip[axis]) < 0.01, 'arco em coordenadas iso reais');
    }
    assert.equal(segments.length, 12, 'apex + 11 pontos do arco, em ângulo real do mundo');
    assert.equal(wedges[0].props.color, cone.alert >= 0.9 ? '#f47f89' : '#e6d07c', 'a cor conta a atenção do oficial');
  }
});

test('MapCanvas floors negative edge coordinates instead of truncating them into a known cell', () => {
  const game = fixture();
  const e = new ExplorationSystem(64, 40); visit(e, 0.5, 0.5); game.exploration = e;
  game.npcs = [{ id: 1, x: 0.01, y: 0.99, kind: 'civilian' }, { id: 2, x: -0.01, y: 0.99, kind: 'civilian' }];
  const entries = readOnlyRender(() => MapCanvas(canvasProps));
  assert.ok(entries.some(({ node }) => node.key === 'n1'));
  assert.ok(!entries.some(({ node }) => node.key === 'n2'), 'out-of-map fractional marker must remain hidden');
});

for (const detailed of [true, false]) test(`MapCanvas ${detailed ? 'map' : 'radar'} keeps GPS, destination and objective visible in a completely unknown city`, () => {
  const game = fixture(true), props = { ...canvasProps, detailed };
  const entries = readOnlyRender(() => MapCanvas(props)), project = projectFor(props);
  const route = entries.find(({ node }) => node.type === 'Path' && node.props.color === C.route && node.props.strokeCap === 'round');
  assert.ok(route, 'GPS route shown without exploration'); unclipped(route);
  const routePoints = commands(route.node.props.path);
  assert.equal(routePoints.length, ui.mapRoute.length);
  routePoints.forEach((p, i) => { assert.equal(p.cmd, i ? 'L' : 'M'); pointNear(p, project(ui.mapRoute[i].x, ui.mapRoute[i].y)); });
  const destinations = entries.filter(({ node }) => node.type === 'Circle' && node.props.color === C.destination);
  assert.ok(destinations.length >= 2, 'GPS destination shown');
  for (const entry of destinations) { unclipped(entry); pointNear(markerCenter(entry.node), project(ui.mapMarker.x, ui.mapMarker.y)); }
  const objective = entries.find(({ node }) => node.type === 'Path' && node.props.color === C.mission && node.props.style !== 'stroke');
  assert.ok(objective, 'mission objective shown'); unclipped(objective);
  const [diamond] = polygons(objective.node.props.path), s = project(game.missions.state.target.x, game.missions.state.target.y);
  assert.equal(diamond.length, 4);
  pointNear({ x: (diamond[0].x + diamond[2].x) / 2, y: (diamond[0].y + diamond[2].y) / 2 }, s);
  assert.ok(!entries.some(({ node }) => node.key && /^(n|cop|v|ammo|door)\d+$/.test(node.key)), 'no world markers revealed');
  assert.equal(game.exploration.version, 0); assert.equal(game.exploration.exploredCount, 0);
});

test('MapCanvas pan/zoom/read-only rerenders neither discover cells nor move marker world anchors', () => {
  const game = fixture();
  for (const [mapW, mapH] of [[390, 844], [1440, 900]]) for (const zoom of [1, 2.2, 6]) {
    const base = makeProjectors(mapW, mapH, 0, 64, 40, 1, 0, 0).worldToScreen(24.8, 17.9);
    const props = { mapW, mapH, zoom, panX: (mapW / 2 - base.x) * zoom + 13.25,
      panY: (mapH / 2 - base.y) * zoom - 7.75, detailed: true };
    const entries = readOnlyRender(() => MapCanvas(props));
    const marker = entries.find(({ node }) => node.key === 'n1'); assert.ok(marker);
    pointNear(markerCenter(marker.node), { x: mapW / 2 + 13.25, y: mapH / 2 - 7.75 });
  }
  assert.equal(game.exploration.version, 1);
});

test('MapCanvas e MiniMap: a sala é uma planta à parte, e o GPS continua na calçada', () => {
  const game = fixture(), room = roomShape();
  game.interiors.active = room;
  Object.assign(game.player, { x: 4.2, y: 3.6 });
  assert.equal(game.exploration.isExplored(36, 26), false);
  for (const detailed of [true, false]) {
    const entries = readOnlyRender(() => MapCanvas({ ...canvasProps, detailed }));
    const plan = entries.find(({ node }) => node.type === InteriorPlan);
    assert.ok(plan && plan.node.props.room === room, 'a sala entra como planta própria');
    assert.ok(!entries.some(({ node }) => node.type === 'Image'), 'a cidade não aparece recortada dentro da loja');
    assert.ok(!entries.some(({ node }) => node.key && /^(n|cop|v|ammo|door)\d+$/.test(node.key)),
      'nenhum marcador da cidade vaza para a planta');
  }
  for (const height of [390, 844]) {
    windowSize = { width: 390, height };
    const entries = readOnlyRender(() => MiniMap()), text = textOf(entries[0].node);
    assert.ok(text.includes('PLANO'), 'o rótulo do radar diz que é uma planta');
    const distance = remainingRouteDistance(ui.mapRoute, roomEntrance.x, roomEntrance.y).toFixed(0);
    assert.ok(text.includes(`GPS ${distance}m`), 'a distância sai do pé da porta, não do plano da sala');
  }
  // Sem nada para fazer na rua, o rodapé do radar apresenta a sala em que você está.
  Object.assign(ui, { mapMarker: null, mapRoute: [] });
  game.missions.state.phase = 'break';
  const text = textOf(readOnlyRender(() => MiniMap())[0].node);
  assert.ok(text.includes(room.label), 'sem destino o rodapé nomeia o interior');
  assert.ok(!text.includes('% explorado'), 'a planta não se faz de cidade');
});

test('A planta projeta o próprio plano da sala, nunca o lote em que a porta fica', () => {
  const game = fixture(), room = roomShape();
  game.interiors.active = room;
  Object.assign(game.player, { x: 4.2, y: 3.6, facingAngle: 0 });
  const props = { room, mapW: 390, mapH: 844, zoom: 1, panX: 0, panY: 0, detailed: true };
  const entries = readOnlyRender(() => InteriorPlan(props));
  const plan = makeProjectors(props.mapW, props.mapH, 8, room.map.worldW, room.map.worldH, 1, 0, 0);
  const arrow = entries.find(({ node }) => node.type === 'Group' && Array.isArray(node.props.transform)
    && node.props.transform.some((t) => t.rotate !== undefined));
  assert.ok(arrow, 'a seta do jogador é rotacionada no plano');
  const at = { x: arrow.node.props.transform[0].translateX, y: arrow.node.props.transform[1].translateY };
  pointNear(at, plan.worldToScreen(game.player.x, game.player.y), 'seta na coordenada da sala');
  const service = entries.find(({ node }) => node.type === 'Circle' && node.props.color === C.route);
  assert.ok(service, 'o balcão da sala está na planta');
  pointNear({ x: service.node.props.cx, y: service.node.props.cy }, plan.worldToScreen(room.service.x, room.service.y));
  // O defeito que esta planta corrige: desenhar a sala com as medidas da cidade. Os mesmos
  // 4,2 × 3,6 cairiam em outro canto do canvas — se caírem, a sala voltou a morar no mapa.
  const asCity = makeProjectors(props.mapW, props.mapH, 0, 64, 40, 1, 0, 0).worldToScreen(game.player.x, game.player.y);
  assert.ok(Math.hypot(at.x - asCity.x, at.y - asCity.y) > 20, 'a planta projeta nas coordenadas da cidade');
});

for (const known of [true, false]) test(`FullMap destination label uses floored cells for ${known ? 'a known' : 'an unknown'} fractional GPS marker`, () => {
  fixture(); ui.mapMarker = known ? { x: 24.8, y: 17.9 } : { x: 25.1, y: 17.2 };
  const entries = readOnlyRender(() => FullMap({ onClose() {} }));
  const text = textOf(entries[0].node);
  assert.ok(text.includes(known ? 'Área descoberta' : 'Área não explorada'), 'destination discovery label');
});

test('FullMap dentro de uma sala anuncia o plano, e o destino continua medido da calçada', () => {
  const game = fixture(), room = roomShape();
  game.interiors.active = room;
  Object.assign(game.player, { x: 4.2, y: 3.6 });
  game.map.data.tiles[26 * 64 + 36].biome = 'beach';
  game.map.data.tiles[3 * 64 + 4].biome = 'forest';
  const entries = readOnlyRender(() => FullMap({ onClose() {} })), text = textOf(entries[0].node);
  assert.ok(text.includes('ISO CITY / INTERIOR'), 'o cabeçalho diz que é interior');
  assert.ok(text.includes(`${room.label} · 7×5 tiles`), 'o cabeçalho descreve a planta da sala');
  assert.ok(!text.includes('Praia'), 'o bioma da rua não empresta o nome da sala');
  assert.ok(text.includes(`DESTINO MARCADO · ${Math.round(remainingRouteDistance(ui.mapRoute, roomEntrance.x, roomEntrance.y))}m`),
    'o destino continua medido do pé da porta');
});

test('new natural region labels are distinct and localized', () => {
  const { BIOME_LABEL } = source('world/MapPresentation.ts');
  assert.equal(BIOME_LABEL.pinewood, 'Pinhal');
  assert.equal(BIOME_LABEL.savanna, 'Savana');
  assert.equal(new Set(Object.values(biomeRgb).map(String)).size, Object.keys(biomeRgb).length);
});

console.log(`Map presentation checks: ${passed} passed, ${failed} failed.`);
if (failed) process.exitCode = 1;
