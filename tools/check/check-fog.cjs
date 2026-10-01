// Run: node tools/check/check-fog.cjs. TS/TSX is compiled in memory; no native runtime or generated files.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');
const srcPath = (name) => path.join(root, 'src', name);
const cache = new Map();
const spriteStore = Object.create(null);
const recordings = [];
let currentGame;
let hooks;
const jsx = (type, props, key) => ({ type, props: props || {}, key });
const stubs = {
  react: {
    memo: (component) => component,
    useState: (initial) => hooks.state(initial),
    useRef: (current) => hooks.ref(current),
    useMemo: (fn, deps) => hooks.memo(fn, deps),
    useEffect: (fn, deps) => hooks.effect(fn, deps),
    useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
  },
  'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
  'react-native-reanimated': { useDerivedValue: (get) => ({ get value() { return get(); } }) },
  '@shopify/react-native-skia': {
    Picture: 'Picture', Group: 'Group', Image: 'Image', Rect: 'Rect', RadialGradient: 'RadialGradient',
    Skia: {
      Path: { Make: () => ({ ovals: [], addOval(rect) { this.ovals.push(rect); } }) },
      XYWHRect: (x, y, width, height) => ({ x, y, width, height }),
      PictureRecorder() {
        const record = { draws: [], events: [], disposed: false };
        recordings.push(record);
        return {
          beginRecording(bounds) {
            record.bounds = bounds; record.events.push('begin');
            return {
              drawImage(image, x, y) { record.draws.push({ kind: 'image', image, x, y }); },
              road(data, tx, ty) { record.draws.push({ kind: 'road', data, tx, ty }); },
            };
          },
          finishRecordingAsPicture() {
            record.events.push('finish');
            record.picture = { record };
            return record.picture;
          },
          dispose() { assert.equal(record.disposed, false); record.disposed = true; record.events.push('dispose'); },
        };
      },
    },
  },
  [srcPath('assets/AssetManifest.ts')]: { ASSET_FILES: {} },
  [srcPath('assets/SpriteStore.ts')]: { spriteStore },
  [srcPath('game/GameState.ts')]: { getGame: () => currentGame },
  [srcPath('render/EntitySprite.tsx')]: { EntitySprite: 'EntitySprite' },
  [srcPath('render/RoadPainter.ts')]: { drawRoad: (canvas, ...args) => canvas.road(...args) },
};
const extraExports = {
  [srcPath('render/GroundLayer.tsx')]: '\nexport { bakeVisibleTiles, cameraCellKey };',
  [srcPath('render/SortedWorldLayer.tsx')]: '\nexport { buildStaticNodes, visibleItems, entityVisible };',
};
function resolve(filename) {
  for (const candidate of [filename, filename + '.ts', filename + '.tsx']) {
    if (Object.hasOwn(stubs, candidate) || (fs.existsSync(candidate) && fs.statSync(candidate).isFile())) return candidate;
  }
  throw Error('Cannot resolve ' + filename);
}
function load(filename) {
  filename = resolve(filename);
  if (Object.hasOwn(stubs, filename)) return stubs[filename];
  if (cache.has(filename)) return cache.get(filename).exports;
  const result = ts.transpileModule(fs.readFileSync(filename, 'utf8') + (extraExports[filename] || ''), {
    fileName: filename, reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX, strict: true, esModuleInterop: true },
  });
  assert.deepEqual(result.diagnostics, [], filename);
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.paths = Module._nodeModulePaths(path.dirname(filename));
  mod.require = (name) => name.startsWith('.') ? load(path.resolve(path.dirname(filename), name))
    : Object.hasOwn(stubs, name) ? stubs[name] : require(name);
  cache.set(filename, mod);
  mod._compile(result.outputText, filename);
  return mod.exports;
}
const source = (name) => load(srcPath(name));
const { FogSystem, FOG, fogRadii } = source('systems/FogSystem.ts');
const { GAME_CONFIG: C } = source('game/GameConfig.ts');
const { worldToScreen, screenToWorld } = source('world/IsoUtils.ts');
const { visibleWorldAabb } = source('world/Visibility.ts');
const registry = source('assets/AssetRegistry.ts');
const { BUILDING_GEOMETRY } = source('assets/BuildingGeometry.ts');
const ground = source('render/GroundLayer.tsx');
const sorted = source('render/SortedWorldLayer.tsx');
const { FogLayer } = source('render/FogLayer.tsx');
const { SnowSystem } = source('systems/SnowSystem.ts');
const fog = new FogSystem();
const viewports = [[320, 568], [390, 844], [844, 390], [768, 1024], [1366, 768], [1920, 1080], [2560, 1080]];
const zooms = [...new Set([C.ZOOM_MIN, C.ZOOM_DEFAULT, C.ZOOM_MAX])];
const contexts = viewports.flatMap(([viewW, viewH]) => zooms.map((zoom) => ({
  camera: { x: 79.25, y: 80.75, zoom }, viewW, viewH,
  // Neve sem neve: o bake acordou para o nível da nevasca, e o oracle usa o sistema real
  // em vez de um objeto inventado — se a API do chão mudar, este checo avisa sozinho.
  snow: new SnowSystem(),
})));
let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('OK ' + name); }
  catch (error) { failed++; console.error('FAIL ' + name + '\n' + error.stack); }
}
function near(actual, expected, tolerance = 1e-8) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
}
function label(ctx) { return `${ctx.viewW}x${ctx.viewH}@${ctx.camera.zoom}`; }
// Independent oracle: transform the expanded rectangle to the unit circle, then clamp its origin.
function intersects(view, x, y, width, height, padding = FOG.padding) {
  const left = (x - padding - view.x) / view.radiusX;
  const top = (y - padding - view.y) / view.radiusY;
  const right = (x + width + padding - view.x) / view.radiusX;
  const bottom = (y + height + padding - view.y) / view.radiusY;
  const nx = Math.min(right, Math.max(left, 0));
  const ny = Math.min(bottom, Math.max(top, 0));
  return nx * nx + ny * ny <= 1;
}
function tileRect(tx, ty) {
  const p = worldToScreen(tx, ty);
  return [p.x - 65, p.y - 2, 130, 68];
}
function tileRange(bounds, width, height) {
  return { x0: Math.max(0, Math.floor(bounds.minX - 1)), x1: Math.min(width - 1, Math.ceil(bounds.maxX + 1)),
    y0: Math.max(0, Math.floor(bounds.minY - 1)), y1: Math.min(height - 1, Math.ceil(bounds.maxY + 1)) };
}
function selectedTiles(ctx, width, height) {
  const view = fog.view(ctx); const selected = [];
  // Exhaustive map scan deliberately does not use worldBounds or production intersects.
  for (let ty = 0; ty < height; ty++) for (let tx = 0; tx < width; tx++) {
    if (intersects(view, ...tileRect(tx, ty))) selected.push(`${tx},${ty}`);
  }
  return selected;
}
function image(width, height) { return { width: () => width, height: () => height }; }
function tileGame(ctx, width = C.MAP_TILES_W, height = C.MAP_TILES_H) {
  const heights = new Float32Array(width * height);
  return { ...ctx, camera: { ...ctx.camera }, fog,
    // Chão plano de propósito: este oracle mede culling, não relevo (check-terrain cuida do relevo).
    map: { data: { tilesW: width, tilesH: height, buildings: [], props: [], heights,
      tiles: Array.from({ length: width * height }, (_, i) => ({ kind: i % 5 ? 'grass' : 'road',
        key: i % 7 ? 'tile_ground_grass' : 'missing-tile' })) }, heightAt: () => 0, heightSmoothAt: () => 0 },
  };
}
function drawnTiles(record) {
  return record.draws.map((draw) => {
    if (draw.kind === 'road') return `${draw.tx},${draw.ty}`;
    const p = screenToWorld(draw.x + 64, draw.y);
    assert.ok(Number.isInteger(p.x) && Number.isInteger(p.y));
    return `${p.x},${p.y}`;
  });
}
// Minimal persistent hooks and manual intervals: exercise real components without React/Skia or wall-clock timing.
function mount(Component, props) {
  const slots = []; const effects = []; const timers = new Map(); let cursor = 0; let nextTimer = 0;
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const runner = {
    state(initial) {
      const i = cursor++;
      if (!slots[i]) slots[i] = { value: typeof initial === 'function' ? initial() : initial };
      return [slots[i].value, (value) => { slots[i].value = typeof value === 'function' ? value(slots[i].value) : value; }];
    },
    ref(current) { const i = cursor++; return slots[i] ||= { current }; },
    memo(fn, deps) {
      const i = cursor++;
      if (!same(slots[i]?.deps, deps)) slots[i] = { value: fn(), deps };
      return slots[i].value;
    },
    effect(fn, deps) {
      const i = cursor++;
      if (!same(slots[i]?.deps, deps)) effects.push(() => {
        slots[i]?.cleanup?.(); slots[i] = { deps, cleanup: fn() };
      });
    },
  };
  function run(fn) {
    const previous = hooks; const set = global.setInterval; const clear = global.clearInterval;
    hooks = runner;
    global.setInterval = (callback, ms) => { timers.set(++nextTimer, { callback, ms }); return nextTimer; };
    global.clearInterval = (id) => timers.delete(id);
    try { return fn(); } finally { hooks = previous; global.setInterval = set; global.clearInterval = clear; }
  }
  return {
    timers,
    render() { return run(() => { cursor = 0; const tree = Component(props); effects.splice(0).forEach((fn) => fn()); return tree; }); },
    tick() { run(() => [...timers.values()].forEach(({ callback }) => callback())); },
    dispose() { run(() => slots.forEach((slot) => slot?.cleanup?.())); assert.equal(timers.size, 0); },
  };
}

test('projected centers and screen radii agree for phone/desktop, zoom and translated cameras', () => {
  for (const ctx of contexts) for (const [x, y] of [[0, 0], [-3.25, 8.5], [159.75, 160.25], [80, 80]]) {
    const camera = { ...ctx.camera, x, y }; const view = fog.view({ ...ctx, camera });
    near(view.x, (x - y) * 64); near(view.y, (x + y) * 32);
    const radius = fogRadii(ctx.viewW, ctx.viewH, camera.zoom);
    near(view.radiusX * camera.zoom, radius.x); near(view.radiusY * camera.zoom, radius.y);
    assert.ok(radius.x > 0 && radius.x < ctx.viewW / 2);
    assert.ok(radius.y > 0 && radius.y <= ctx.viewH * 0.6);
  }
});

test('FogLayer uses shared radii/stops, transparent center, opaque clamped perimeter and reactive zoom', () => {
  assert.equal(FOG.colors.length, FOG.positions.length);
  assert.equal(FOG.positions[0], 0); assert.equal(FOG.positions.at(-1), 1);
  const alpha = (color) => /^#[0-9a-f]{6}$/i.test(color) ? 1 : Number(color.match(/,\s*([\d.]+)\)$/)?.[1]);
  const alphas = FOG.colors.map(alpha);
  assert.equal(alphas[0], 0); assert.equal(alphas[1], 0); assert.equal(alphas.at(-1), 1);
  assert.equal(FOG.colors.at(-1), FOG.color);
  for (let i = 1; i < alphas.length; i++) {
    assert.ok(FOG.positions[i] > FOG.positions[i - 1]); assert.ok(alphas[i] >= alphas[i - 1]);
  }
  for (const ctx of contexts) {
    const camera = { value: { ...ctx.camera } };
    const tree = FogLayer({ width: ctx.viewW, height: ctx.viewH, camera });
    assert.equal(tree.type, 'Rect'); assert.equal(tree.props.width, ctx.viewW); assert.equal(tree.props.height, ctx.viewH);
    const gradient = tree.props.children;
    assert.equal(gradient.type, 'RadialGradient'); assert.equal(gradient.props.mode, 'clamp');
    assert.deepEqual(gradient.props.c, { x: 0, y: 0 }); assert.equal(gradient.props.r, 1);
    assert.equal(gradient.props.colors.value, FOG.colors); assert.equal(gradient.props.positions.value, FOG.positions);
    for (const zoom of zooms) {
      camera.value = { ...camera.value, zoom };
      const radius = fogRadii(ctx.viewW, ctx.viewH, zoom);
      assert.deepEqual(gradient.props.transform.value, [{ translateX: ctx.viewW / 2 }, { translateY: ctx.viewH / 2 },
        { scaleX: radius.x }, { scaleY: radius.y }]);
    }
  }
});

test('zero padding handles tangencies, ellipse corners, enclosing rectangles and tall roofs', () => {
  const view = { x: 17, y: -41, radiusX: 300, radiusY: 100 };
  const cases = [
    [317, -41, 0, 0, true], [-283, -41, 0, 0, true], [17, 59, 0, 0, true], [17, -141, 0, 0, true],
    [317.001, -41, 1, 1, false], [17, 59.001, 1, 1, false],
    [257, 39, 12, 12, false], // Inside ellipse AABB, outside ellipse itself.
    [197, 38, 10, 10, true], [197, 40, 10, 10, false],
    [-1000, -1000, 2000, 2000, true], [-400, -42, 850, 2, true],
  ];
  for (const [x, y, w, h, expected] of cases) assert.equal(fog.intersects(view, x, y, w, h, 0), expected);
  const baseY = view.y + view.radiusY + 200;
  assert.equal(fog.intersects(view, view.x, baseY, 0, 0, 0), false);
  assert.equal(fog.intersects(view, view.x - 45, baseY - 320, 90, 320, 0), true, 'roof enters while base remains outside');
  assert.equal(fog.intersects(view, view.x - 45, baseY, 90, 30, 0), false);
});

test('padded nearest-point math matches independent oracle and never drops zero-padding hits', () => {
  for (const ctx of contexts) {
    const v = fog.view(ctx);
    for (let i = 0; i < 240; i++) {
      const x = v.x + ((i * 73 % 401) / 100 - 2) * v.radiusX;
      const y = v.y + ((i * 137 % 397) / 100 - 2) * v.radiusY;
      const w = i * 19 % 301; const h = i * 47 % 601;
      for (const pad of [0, 13, FOG.padding]) assert.equal(fog.intersects(v, x, y, w, h, pad), intersects(v, x, y, w, h, pad));
      assert.equal(fog.intersects(v, x, y, w, h), fog.intersects(v, x, y, w, h, FOG.padding));
      if (intersects(v, x, y, w, h, 0)) assert.ok(fog.intersects(v, x, y, w, h));
    }
  }
});

test('inverse-isometric AABB contains ellipse and apron, including diagonal extrema', () => {
  for (const ctx of contexts) {
    const v = fog.view(ctx); const b = fog.worldBounds(v);
    near((b.minX + b.maxX) / 2, ctx.camera.x); near((b.minY + b.maxY) / 2, ctx.camera.y);
    const diagonal = Math.atan2(v.radiusY / 64, v.radiusX / 128);
    const angles = Array.from({ length: 360 }, (_, i) => i * Math.PI / 180).concat([diagonal, Math.PI - diagonal]);
    for (const a of angles) for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
      const p = screenToWorld(v.x + Math.cos(a) * v.radiusX + sx * FOG.padding,
        v.y + Math.sin(a) * v.radiusY + sy * FOG.padding);
      assert.ok(p.x >= b.minX - 1e-8 && p.x <= b.maxX + 1e-8 && p.y >= b.minY - 1e-8 && p.y <= b.maxY + 1e-8, label(ctx));
    }
    // A global-map bound would be complete but defeat candidate reduction.
    assert.ok(b.maxX - b.minX < 40 && b.maxY - b.minY < 40);
  }
});

test('tile candidate bounds are complete at all map edges, corners, diagonals and small maps', () => {
  let checked = 0;
  for (const ctx of contexts) for (const [width, height] of [[C.MAP_TILES_W, C.MAP_TILES_H], [11, 7]]) {
    const positions = [[0, 0], [width - 1, 0], [0, height - 1], [width - 1, height - 1],
      [width / 2, 0], [width / 2, height - 1], [0, height / 2], [width - 1, height / 2],
      [width / 2 + 0.249, height / 2 - 0.249], [-2, height / 2], [width + 2, height + 2]];
    for (const [x, y] of positions) {
      const c = { ...ctx, camera: { ...ctx.camera, x, y } };
      const range = tileRange(fog.worldBounds(fog.view(c)), width, height);
      for (const key of selectedTiles(c, width, height)) {
        const [tx, ty] = key.split(',').map(Number);
        assert.ok(tx >= range.x0 && tx <= range.x1 && ty >= range.y0 && ty <= range.y1, `${label(c)} missing ${key}`);
        checked++;
      }
    }
  }
  assert.ok(checked > 10000); console.log(`  Complete candidates: ${checked} selected tile cases`);
});

test('hidden apron covers maximum-speed camera travel, half-tile bake reuse and maximum shake', () => {
  const speed = Math.max(C.PLAYER_RUN_SPEED, C.VEHICLE_MAX_SPEED, C.HELI_MAX_SPEED);
  // Steady maximum-speed follow, scheduled cull intervals (not arbitrary JS stalls/teleports).
  // Camera shake is capped at 1.6 * 7 screen pixels in GameState.updateShake.
  for (const ctx of contexts) for (let direction = 0; direction < 16; direction++) {
    const a = direction * Math.PI / 8; const velocity = { x: Math.cos(a) * speed, y: Math.sin(a) * speed };
    for (const interval of [C.BAKE_INTERVAL_MS, C.ENTITY_CULL_MS]) {
      let old = { ...ctx, camera: { ...ctx.camera, x: 79.7501, y: 80.2499 } };
      const start = { ...old.camera }; let key = ground.cameraCellKey(old);
      for (let tick = 1; tick <= 6; tick++) {
        const t = tick * interval / 1000 - 1e-7;
        const next = { ...ctx, camera: { ...start, x: start.x + velocity.x * t, y: start.y + velocity.y * t } };
        const before = fog.view(old); const after = fog.view(next);
        for (let ray = 0; ray < 48; ray++) for (const sign of [-1, 1]) {
          const theta = ray * Math.PI / 24;
          const x = after.x + Math.cos(theta) * after.radiusX * (1 - 1e-10) + sign * 11.2 / ctx.camera.zoom;
          const y = after.y + Math.sin(theta) * after.radiusY * (1 - 1e-10) + sign * 6.72 / ctx.camera.zoom;
          assert.ok(fog.intersects(before, x, y, 0, 0), `${label(ctx)} lost apron at ${interval}ms, direction ${direction}`);
        }
        const nextKey = ground.cameraCellKey(next);
        if (interval === C.ENTITY_CULL_MS || nextKey !== key) { old = next; key = nextKey; }
      }
    }
  }
});

test('actual GroundLayer baker draws exactly selected tiles and roads, with fallback and recorder disposal', () => {
  const grass = image(128, 64); spriteStore[registry.tileKey('tile_ground_grass')] = grass;
  for (const ctx of contexts) for (const [x, y] of [[79.25, 80.75], [0, 0], [159, 159], [-2, 80]]) {
    const game = tileGame({ ...ctx, camera: { ...ctx.camera, x, y } });
    const picture = ground.bakeVisibleTiles(game); const record = picture.record;
    assert.deepEqual(record.events, ['begin', 'finish', 'dispose']);
    assert.deepEqual(drawnTiles(record), selectedTiles(game, C.MAP_TILES_W, C.MAP_TILES_H), label(game));
    assert.equal(new Set(drawnTiles(record)).size, record.draws.length);
    for (const draw of record.draws) if (draw.kind === 'image') assert.equal(draw.image, grass);
    const v = fog.view(game); const b = record.bounds;
    assert.ok(b.x <= v.x - v.radiusX - FOG.padding && b.y <= v.y - v.radiusY - FOG.padding);
    assert.ok(b.x + b.width >= v.x + v.radiusX + FOG.padding && b.y + b.height >= v.y + v.radiusY + FOG.padding);
  }
});

test('actual GroundLayer effect bakes once per camera cell, responds to zoom/resize and clears interval', () => {
  const game = tileGame(contexts[0]); const component = mount(ground.GroundLayer, { game });
  const before = recordings.length;
  try {
    assert.equal(component.render(), null); const tree = component.render();
    assert.equal(tree.type, 'Picture'); assert.equal(tree.props.picture, recordings.at(-1).picture);
    assert.equal(recordings.length, before + 1); assert.equal(component.timers.size, 1);
    assert.equal([...component.timers.values()][0].ms, C.BAKE_INTERVAL_MS);
    component.tick(); assert.equal(recordings.length, before + 1);
    game.camera.x += 1; component.tick(); assert.equal(recordings.length, before + 2);
    game.camera.zoom = C.ZOOM_MAX; component.tick(); assert.equal(recordings.length, before + 3);
    game.viewW += 20; component.tick(); assert.equal(recordings.length, before + 4);
    assert.equal(component.render().props.picture, recordings.at(-1).picture);
  } finally { component.dispose(); }
});

function entityGame() {
  const game = tileGame(contexts.find((ctx) => ctx.viewW === 1366 && ctx.camera.zoom === C.ZOOM_DEFAULT));
  const v = fog.view(game); const point = (sx, sy) => screenToWorld(v.x + sx, v.y + sy);
  const building = 'bld_office_tall_blue_a'; const geometry = BUILDING_GEOMETRY[building];
  spriteStore[registry.buildingKey(building)] = image(256, 224);
  spriteStore[registry.propKey('test-tall')] = image(64, 400);
  const baseY = v.radiusY + FOG.padding + 140;
  game.map.data.buildings = [
    { key: building, ...point(0, baseY), footprintW: 2, footprintH: 2 },
    { key: building, ...point(5000, 5000), footprintW: 2, footprintH: 2 },
  ];
  game.map.data.props = [{ key: 'test-tall', ...point(0, baseY) }, { key: 'test-tall', ...point(-5000, -5000) }];
  game.player = { ...point(5000, 5000), currentVehicleId: null };
  const npc = (p, patch = {}) => ({ ...p, dead: false, deathTimer: -1, inVehicle: false, kind: 'civ', char: 'a', anim: 'idle', dir: 'SE', frame: 0, ...patch });
  game.npcs = [npc(point(0, 0)), npc(point(5000, 5000)), npc(point(0, 0), { dead: true }),
    npc(point(0, 0), { inVehicle: true }), npc(point(0, 0), { char: 'missing' })];
  spriteStore[registry.characterKey('a', 'idle', 'SE', 0)] = image(24, 32);
  const vehicle = (id, p, type = 'car', patch = {}) => ({ id, ...p, def: { type, colors: ['red'], baseKey: `veh_${type}` }, color: 'red', dir: 'SE',
    animFrame: 1, altitude: 0, state: 'parked', ...patch });
  game.vehicles = [vehicle(41, point(0, 0)), vehicle(77, point(5000, 5000)),
    vehicle(99, point(0, v.radiusY + FOG.padding + 150), 'helicopter', { altitude: 5 }),
    vehicle(100, point(0, 0), 'car', { state: 'destroyed' }), vehicle(101, point(-5000, -5000))];
  for (const veh of game.vehicles) spriteStore[registry.spriteKeyForVehicle(veh.def, veh.color, veh.dir,
    veh.def.type === 'helicopter' ? 1 : 0)] = image(96, 64);
  game.wildlife = { animals: [] };
  game.destruction = { wrecks: [] };
  game.entityVersion = 0; game.subscribeEntityChange = () => () => {};
  currentGame = game;
  assert.ok(geometry.anchorY * 2 * 64 / geometry.span > FOG.padding + 140);
  return game;
}
function freezeSimulation(game) {
  for (const list of [game.npcs, game.vehicles, game.map.data.buildings, game.map.data.props]) {
    list.forEach(Object.freeze); Object.freeze(list);
  }
}

test('actual SortedWorldLayer keeps exact tall static bounds, lifted vehicles and offscreen player without mutating simulation', () => {
  const game = entityGame(); const view = fog.view(game); const b = game.map.data.buildings[0];
  const p = worldToScreen(b.x, b.y);
  assert.equal(fog.intersects(view, p.x, p.y, 0, 0), false, 'building base is outside even the apron');
  const nodes = sorted.buildStaticNodes(game); const building = nodes.find((n) => n.id === 'building:0');
  assert.equal(fog.intersects(view, building.sx - building.w / 2, building.sy - building.h, building.w, building.h, 0), true);
  const g = BUILDING_GEOMETRY[b.key]; const scale = b.footprintW * 64 / g.span;
  near(building.sx - building.w / 2, p.x - g.anchorX * scale);
  near(building.sy - building.h, p.y - g.anchorY * scale);
  const heli = game.vehicles[2];
  assert.equal(sorted.entityVisible(game, view, 'veh:2', heli.x, heli.y, 0), false);
  assert.equal(sorted.entityVisible(game, view, 'veh:2', heli.x, heli.y, heli.altitude * 38), true);
  const snapshot = JSON.stringify([game.npcs, game.vehicles, game.map.data]); freezeSimulation(game);
  const component = mount(sorted.SortedWorldLayer, { game });
  try {
    const tree = component.render(); assert.equal(tree.type, 'Group');
    const children = tree.props.children;
    assert.deepEqual(children.map((child) => child.key).sort(), ['building:0', 'npc:0', 'npc:2', 'player', 'prop:0', 'veh:0', 'veh:2'].sort());
    const actualBuilding = children.find((child) => child.key === 'building:0');
    const wrapper = actualBuilding.type(actualBuilding.props);
    const transparent = wrapper.type({ ...wrapper.props, focus: { value: { x: 0, y: 0, depth: 0, active: false } } });
    const sprite = transparent.props.children[0].props.children;
    assert.equal(sprite.type, 'Image'); near(sprite.props.x, p.x - g.anchorX * scale); near(sprite.props.y, p.y - g.anchorY * scale);
    assert.equal(transparent.props.children[0].props.invertClip, true);
    assert.equal(transparent.props.children[1].props.opacity, 0.16);
    const items = sorted.visibleItems(game, nodes);
    for (let i = 1; i < items.length; i++) assert.ok(items[i].depth >= items[i - 1].depth);
    assert.equal(children.at(-1).key, 'veh:2', 'airborne vehicle keeps elevated depth');
    assert.equal([...component.timers.values()][0].ms, C.ENTITY_CULL_MS);
    assert.equal(JSON.stringify([game.npcs, game.vehicles, game.map.data]), snapshot);
  } finally { component.dispose(); }
});

test('SortedWorldLayer always keeps current vehicle by ID, hides passenger player and reculls on timer', () => {
  const game = entityGame(); game.player.currentVehicleId = 77; freezeSimulation(game);
  const npcs = game.npcs; const vehicles = game.vehicles;
  const component = mount(sorted.SortedWorldLayer, { game });
  try {
    const keys = component.render().props.children.map((child) => child.key);
    assert.ok(keys.includes('veh:1')); assert.ok(!keys.includes('player')); assert.ok(!keys.includes('veh:4'));
    const next = screenToWorld(fog.view(game).x - 5000, fog.view(game).y - 5000);
    game.camera.x = next.x; game.camera.y = next.y;
    component.tick();
    const moved = component.render().props.children.map((child) => child.key);
    assert.ok(moved.includes('veh:1'), 'occupied vehicle cannot be culled');
    assert.ok(moved.includes('veh:4')); assert.ok(!moved.includes('npc:0')); assert.ok(!moved.includes('building:0'));
    assert.equal(game.npcs, npcs); assert.equal(game.vehicles, vehicles); assert.equal(npcs.length, 5); assert.equal(vehicles.length, 5);
  } finally { component.dispose(); }
});

test('wrecks join the depth-sorted pass and cull with the same envelope as the hull', () => {
  const game = entityGame();
  const v = fog.view(game);
  const scorch = { dir: 'SE', key: null, tilt: 0.1, shards: [], explodedAt: 3 };
  game.destruction.wrecks = [
    { ...scorch, ...screenToWorld(v.x + 5000, v.y + 5000) },
    { ...scorch, ...screenToWorld(v.x, v.y) },
  ];
  const items = sorted.visibleItems(game, sorted.buildStaticNodes(game));
  assert.deepEqual(items.filter((i) => i.wreck).map((i) => i.id), ['wreck:1'],
    'only the on-screen scorch is drawn');
  assert.ok(items.every((i, k) => !k || i.depth >= items[k - 1].depth), 'depth order kept');
});

test('day/rain/biome snapshots transition smoothly, pause safely and never expand the culling envelope', () => {
  const system = new FogSystem(), ctx = contexts[10], view = system.view(ctx);
  const snapshot = { value: system.snapshot };
  const gradient = FogLayer({ width: ctx.viewW, height: ctx.viewH, camera: { value: ctx.camera }, snapshot }).props.children;
  const original = JSON.stringify(snapshot.value);
  for (const dt of [0, -1, NaN, Infinity]) {
    assert.equal(system.update(dt, { timeOfDay: 0, rain: 1, biome: 'forest' }), snapshot.value);
  }
  const saved = snapshot.value;
  const colors = new Set();
  for (const biome of ['forest', 'countryside', 'beach', 'industrial', 'pinewood', 'savanna']) {
    for (const timeOfDay of [0, 0.27, 0.5, 0.8]) for (const rain of [0, 1]) {
      const before = system.snapshot.clarity;
      system.update(1 / 60, { timeOfDay, rain, biome });
      assert.ok(Math.abs(system.snapshot.clarity - before) < 0.005, 'no abrupt biome/weather change');
      for (let i = 0; i < 180; i++) snapshot.value = system.update(1 / 30, { timeOfDay, rain, biome });
      const s = snapshot.value;
      colors.add(s.color);
      assert.equal(gradient.props.colors.value, s.colors);
      assert.equal(gradient.props.positions.value, s.positions);
      assert.ok(s.clarity > 0.44 && s.clarity <= 0.601);
      assert.equal(s.colors.at(-1), s.color); assert.match(s.color, /^#[0-9a-f]{6}$/);
      assert.equal(s.positions.at(-1), 1);
      assert.ok(s.positions.every((v, i) => !i || v > s.positions[i - 1]));
      assert.deepEqual(system.view(ctx), view, 'weather cannot invalidate stationary ground bake');
    }
  }
  assert.ok(colors.size > 20, 'distinct environmental palettes');
  assert.equal(JSON.stringify(saved), original, 'old snapshots must not mutate');
  const clear = new FogSystem();
  assert.ok(clear.snapshot.clarity > 0.38 * 1.5, 'wider clear center than old gray fog');
  for (let i = 0; i < 100; i++) clear.update(0.1, { timeOfDay: NaN, rain: NaN, biome: 'pinewood' });
  assert.ok(clear.snapshot.positions.every(Number.isFinite));
});

const reductions = [];
test('actual tile draws are significantly below the old visibleWorldAabb(..., 1) enumeration', () => {
  for (const ctx of contexts) {
    const old = tileRange(visibleWorldAabb(ctx.camera, ctx.viewW, ctx.viewH, 1), C.MAP_TILES_W, C.MAP_TILES_H);
    const oldCount = (old.x1 - old.x0 + 1) * (old.y1 - old.y0 + 1);
    const newCount = ground.bakeVisibleTiles(tileGame(ctx)).record.draws.length;
    const reduction = 1 - newCount / oldCount;
    reductions.push({ label: label(ctx), oldCount, newCount, reduction });
    console.log(`  ${label(ctx)}: ${oldCount} -> ${newCount} tiles (${(reduction * 100).toFixed(1)}% fewer)`);
    assert.ok(reduction >= 0.30, `${label(ctx)} needs >=30% fewer tile draws, got ${(reduction * 100).toFixed(1)}%`);
  }
});

console.log(`Fog checks: ${passed} passed, ${failed} failed (${contexts.length} viewport/zoom combinations).`);
if (reductions.length) console.log(`Measured tile reduction: ${(Math.min(...reductions.map((r) => r.reduction)) * 100).toFixed(1)}%-${(Math.max(...reductions.map((r) => r.reduction)) * 100).toFixed(1)}%.`);
if (failed) { console.error('Failures may indicate implementation issues; assertions were not relaxed.'); process.exitCode = 1; }
