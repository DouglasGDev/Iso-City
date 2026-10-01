// Run: node tools/check/check-wildlife.cjs. In-memory TS checking/runtime; writes no generated files.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');
const src = (name) => path.join(root, 'src', name);
let passed = 0;
function test(name, fn) { fn(); passed++; console.log('OK ' + name); }

// Only these roots are checked: transient GameState/other-agent edits cannot mask wildlife errors.
test('isolated strict typecheck: model, system and native Skia/Reanimated props', () => {
  const program = ts.createProgram([
    src('entities/Animal.ts'), src('systems/WildlifeSystem.ts'), src('render/AnimalSprite.tsx'),
  ], { strict: true, noImplicitReturns: true, noFallthroughCasesInSwitch: true, noEmit: true,
    target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true, skipLibCheck: true, types: ['react'] });
  const errors = ts.getPreEmitDiagnostics(program);
  assert.equal(errors.length, 0, ts.formatDiagnosticsWithColorAndContext(errors, {
    getCanonicalFileName: (file) => file, getCurrentDirectory: () => root, getNewLine: () => '\n',
  }));
});

// Minimal recording Skia implementation: inspect ORIGINAL geometry without a native runtime.
class RecordedPath {
  commands = [];
  addRect(rect) { this.commands.push(['rect', rect.x, rect.y, rect.width, rect.height]); return this; }
  moveTo(x, y) { this.commands.push(['move', x, y]); return this; }
  lineTo(x, y) { this.commands.push(['line', x, y]); return this; }
  close() { this.commands.push(['close']); return this; }
}
const stubs = {
  react: { useMemo: (fn) => fn() },
  'react-native-reanimated': { useDerivedValue: (fn) => ({ get value() { return fn(); } }) },
  '@shopify/react-native-skia': { Group: 'Group', Path: 'Path', Skia: {
    Path: { Make: () => new RecordedPath() }, XYWHRect: (x, y, width, height) => ({ x, y, width, height }),
  } },
};
const cache = new Map();
function load(filename) {
  if (!path.extname(filename)) filename += '.ts';
  if (cache.has(filename)) return cache.get(filename).exports;
  const result = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    fileName: filename, reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
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
const model = load(src('entities/Animal.ts'));
const { createAnimal, damage, animalVisualState, animalSpritePose, animalDeathPose, isAnimalVisible,
  ANIMAL_CORPSE_SECONDS } = model;
const { WildlifeSystem, WILDLIFE_COUNT, WILDLIFE_RESPAWN_ATTEMPTS, WILDLIFE_RESPAWN_DISTANCE,
  isWildlifePositionSafe, isWildlifePathSafe, WILDLIFE_UPDATE_LIMIT, WILDLIFE_LOCAL_RADIUS,
  WILDLIFE_LOCAL_TARGET, WILDLIFE_RESTOCK_SECONDS, WILDLIFE_HOME_DISTANCE } = load(src('systems/WildlifeSystem.ts'));
const copy = (value) => JSON.parse(JSON.stringify(value));
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function fixture(size = 160, kind = 'grass', biome = 'forest') {
  const boxes = [];
  let queries = 0;
  // Relevo plano por padrão; level() levanta um talude para as cercas de montanha.
  const levels = new Int16Array(size * size);
  const levelAt = (x, y) => ((y < 0 || y >= size || x < 0 || x >= size) ? 0 : levels[y * size + x]);
  const map = {
    data: { tilesW: size, tilesH: size, tiles: Array.from({ length: size * size }, () => ({ kind, biome })) },
    worldW: size, worldH: size,
    queryNearby(x, y, radius) {
      queries++;
      return boxes.filter((box) => box.x <= x + radius && box.x + box.width >= x - radius
        && box.y <= y + radius && box.y + box.height >= y - radius);
    },
    canClimb(fromX, fromY, toX, toY) {
      const up = levelAt(Math.floor(toX), Math.floor(toY)) - levelAt(Math.floor(fromX), Math.floor(fromY));
      return up <= 1 && -up <= 3;
    },
  };
  return { map, boxes, tile(x, y, patch) { Object.assign(map.data.tiles[y * size + x], patch); },
    level(x, y, value) { levels[y * size + x] = value; },
    queries: () => queries, resetQueries() { queries = 0; } };
}
function single(species = 'rabbit') {
  const world = fixture();
  const system = new WildlifeSystem();
  const animal = createAnimal(0, species, 60, 60, 31);
  system.animals.push(animal);
  return { ...world, system, animal, context: { map: world.map, player: { x: 80, y: 60 } } };
}

// Independent footprint oracle: deliberately not the system's safety predicate.
function assertHabitat(map, animal) {
  const r = animal.radius;
  assert.ok(animal.x >= r && animal.x + r < map.worldW && animal.y >= r && animal.y + r < map.worldH);
  for (let y = Math.floor(animal.y - r); y <= Math.floor(animal.y + r); y++) {
    for (let x = Math.floor(animal.x - r); x <= Math.floor(animal.x + r); x++) {
      const tile = map.data.tiles[y * map.data.tilesW + x];
      assert.ok(['forest', 'countryside', 'pinewood', 'savanna'].includes(tile.biome), tile.biome);
      assert.ok(['grass', 'dirt'].includes(tile.kind), tile.kind);
    }
  }
  for (const box of map.queryNearby(animal.x, animal.y, r)) {
    assert.ok(animal.x + r < box.x || animal.x - r > box.x + box.width
      || animal.y + r < box.y || animal.y - r > box.y + box.height, 'static overlap');
  }
}

/** Corridor oracle: a roaming animal may be anywhere DRY and open, even downtown. */
function assertPathable(map, animal) {
  const r = animal.radius;
  assert.ok(animal.x >= r && animal.x + r < map.worldW && animal.y >= r && animal.y + r < map.worldH);
  for (let y = Math.floor(animal.y - r); y <= Math.floor(animal.y + r); y++) {
    for (let x = Math.floor(animal.x - r); x <= Math.floor(animal.x + r); x++) {
      assert.notEqual(map.data.tiles[y * map.data.tilesW + x].kind, 'water');
    }
  }
}

test('seeded generation: 224 mixed original animals, independent of Math.random; stable array', () => {
  const { map } = fixture();
  const a = new WildlifeSystem(), b = new WildlifeSystem(), c = new WildlifeSystem();
  const list = a.animals;
  const original = Math.random;
  try {
    Math.random = () => { throw new Error('unseeded wildlife RNG'); };
    a.init(map, 91); b.init(map, 91); c.init(map, 92);
    assert.equal(a.animals, list);
    assert.equal(a.animals.length, WILDLIFE_COUNT);
    assert.deepEqual(a.animals, b.animals);
    assert.notDeepEqual(a.animals, c.animals);
    assert.equal(WILDLIFE_COUNT, 224);
    assert.equal(a.animals.filter((animal) => animal.species === 'rabbit').length, 96);
    assert.equal(a.animals.filter((animal) => animal.species === 'deer').length, 64);
    assert.equal(a.animals.filter((animal) => animal.species === 'fox').length, 32);
    assert.equal(a.animals.filter((animal) => animal.species === 'boar').length, 32);
    const initial = copy(a.animals);
    a.init(map, 91); assert.deepEqual(a.animals, initial);
    for (const animal of a.animals) {
      assert.equal(animal.kind, 'animal'); assert.equal(animal.dead, false);
      assert.ok(animal.health > 0 && animal.radius > 0);
      assertHabitat(map, animal);
      for (const other of a.animals) if (other !== animal) assert.ok(distance(animal, other) > animal.radius + other.radius);
    }
    const context = { map, player: { x: 75, y: 75 } };
    for (let i = 0; i < 120; i++) { a.update(1 / 30, context); b.update(1 / 30, context); }
    assert.deepEqual(a.animals, b.animals);
  } finally { Math.random = original; }
});

test('real generated map seeds: safe forests AND countryside, never roads, bridges, water or buildings', () => {
  const { generateCity } = load(src('data/maps/city.ts'));
  const { Map: WorldMap } = load(src('world/Map.ts'));
  for (const seed of [20260909, 17, 90210]) {
    const map = new WorldMap(generateCity(seed));
    const system = new WildlifeSystem(); system.init(map, seed);
    assert.equal(system.animals.length, WILDLIFE_COUNT);
    const biomes = new Set();
    for (const animal of system.animals) {
      assertHabitat(map, animal);
      biomes.add(map.data.tiles[Math.floor(animal.y) * map.data.tilesW + Math.floor(animal.x)].biome);
      assert.ok(distance(animal, map.data.playerSpawn) > 8);
    }
    assert.deepEqual([...biomes].sort(), ['countryside', 'forest', 'pinewood', 'savanna']);
    for (const animal of system.animals) {
      const biome = map.data.tiles[Math.floor(animal.y) * map.data.tilesW + Math.floor(animal.x)].biome;
      assert.ok(model.ANIMAL_HABITATS[animal.species].includes(biome));
    }
  }
});

test('bounded empty/urban/road/water/building-covered initialization and footprint edges', () => {
  for (const [kind, biome] of [['grass', 'park'], ['grass', 'residential'], ['road', 'forest'],
    ['water', 'forest'], ['concrete', 'countryside'], ['dirt', 'beach']]) {
    const { map } = fixture(16, kind, biome);
    const system = new WildlifeSystem(); system.init(map, 4); assert.equal(system.animals.length, 0);
  }
  const { map, boxes, tile } = fixture(16);
  tile(8, 8, { kind: 'water' });
  assert.equal(isWildlifePositionSafe(map, 7.9, 8.5, 0.3), false);
  assert.equal(isWildlifePositionSafe(map, -0.01, 3, 0.1), false);
  assert.equal(isWildlifePositionSafe(map, NaN, 3, 0.1), false);
  boxes.push({ x: 0, y: 0, width: 16, height: 16 });
  const system = new WildlifeSystem(); system.init(map, 1); assert.equal(system.animals.length, 0);
  system.init(fixture(0).map, 1); assert.equal(system.animals.length, 0);
});

for (const species of ['rabbit', 'deer', 'fox', 'boar']) test(`${species}: proximity/shot/vehicle flight, four headings, and eventual calm`, () => {
  for (const [dx, dy, direction] of [[-2, 0, 'SE'], [2, 0, 'NW'], [0, -2, 'SW'], [0, 2, 'NE']]) {
    const { system, animal, context, map } = single(species);
    context.player = { x: animal.x + dx, y: animal.y + dy };
    const before = distance(animal, context.player);
    system.update(0.1, context);
    assert.equal(animal.state, 'fleeing'); assert.equal(animal.dir, direction);
    assert.ok(distance(animal, context.player) > before);
    assert.ok(animal.speed > 3); assertHabitat(map, animal);
  }
  const { system, animal, context } = single(species);
  context.noise = { x: 58, y: 60, radius: 18 };
  system.update(0.1, context);
  assert.equal(animal.state, 'fleeing'); assert.ok(animal.x > 60);
  delete context.noise;
  for (let i = 0; i < 40; i++) { context.player = { x: animal.x, y: animal.y + 20 }; system.update(0.1, context); }
  assert.notEqual(animal.state, 'fleeing'); assert.equal(animal.fleeTimer, 0);
  context.vehicles = [{ x: animal.x - 2, y: animal.y, speed: 3, altitude: 0 }];
  system.update(0.1, context); assert.equal(animal.state, 'fleeing');
});

test('predação silenciosa: o arco da fauna manda, de costas só sente quem encosta', () => {
  // De frente e longe: para, vira a cabeça para o risco e observa — ainda não corre.
  const { system, animal, context } = single('deer');
  Object.assign(animal, { dir: 'NE', state: 'idle', speed: 0, decisionTimer: 5 });
  context.player = { x: animal.x + 2, y: animal.y - 6 };
  system.update(0.1, context);
  assert.equal(animal.state, 'idle'); assert.equal(animal.fleeTimer, 0);
  assert.equal(animal.dir, 'SE', 'não olhou para quem vê');
  assert.equal(animal.speed, 0);

  // Mesma distância, agora às costas: sem raio-x, o bicho segue a vida dele.
  const costas = single('deer');
  Object.assign(costas.animal, { dir: 'NE', state: 'idle', speed: 0, decisionTimer: 5 });
  costas.context.player = { x: costas.animal.x - 2, y: costas.animal.y + 6 };
  costas.system.update(0.1, costas.context);
  assert.equal(costas.animal.state, 'idle'); assert.equal(costas.animal.dir, 'NE');

  // De tão perto não precisa ver: o chão tremendo dos quatro lados é susto.
  costas.context.player = { x: costas.animal.x, y: costas.animal.y + 2.5 };
  costas.system.update(0.1, costas.context);
  assert.equal(costas.animal.state, 'fleeing');

  // A noite encurta a vista da fauna, como encurta a da polícia.
  const noite = single('deer');
  Object.assign(noite.animal, { dir: 'NE', state: 'idle', speed: 0, decisionTimer: 5 });
  noite.context.player = { x: noite.animal.x + 2, y: noite.animal.y - 6 };
  noite.context.night = true;
  noite.system.update(0.1, noite.context);
  assert.equal(noite.animal.dir, 'NE', 'de noite a 6 tiles ainda é longe demais');

  // Ver mais perto, depois de já ter desconfiado, é fuga declarada.
  Object.assign(animal, { dir: 'NE' });
  context.player = { x: animal.x + 1, y: animal.y - 2 };
  system.update(0.1, context);
  assert.equal(animal.state, 'fleeing'); assert.ok(animal.fleeTimer > 0);
});

test('wandering alternates pauses/steps; calls are throttled, local and optional', () => {
  const { system, animal, context, map } = single();
  const calls = [];
  context.onCall = (a, call) => calls.push([a, call]);
  context.player = { x: 70, y: 60 };
  const states = new Set(); const points = new Set();
  animal.callTimer = 0;
  for (let i = 0; i < 1000; i++) {
    system.update(0.05, context); states.add(animal.state); points.add(animal.x + ',' + animal.y);
    assertHabitat(map, animal);
  }
  assert.ok(states.has('idle') && states.has('walking')); assert.ok(points.size > 10);
  assert.ok(calls.length >= 1 && calls.length < 8);
  animal.callTimer = 0; context.player = { x: animal.x - 1, y: animal.y };
  system.update(0.1, context); assert.equal(calls.at(-1)[1], 'alarm');
  const count = calls.length;
  for (let i = 0; i < 20; i++) system.update(0.05, context);
  assert.equal(calls.length, count);
});

test('voz fiel à cena: invisível não conversa, susto fura a tela e não vira coro', () => {
  const { system, animal, context } = single('deer');
  const calls = [];
  context.onCall = (a, c) => calls.push(c);
  context.isVisible = () => false;
  context.player = { x: animal.x + 8, y: animal.y };
  for (let i = 0; i < 400; i++) system.update(0.05, context);
  assert.equal(calls.length, 0, 'bicho do outro lado da tela conversando com o player');

  // O susto é a única voz autorizada a atravessar a beirada: quem o produziu chegou por trás.
  Object.assign(animal, { state: 'idle', fleeTimer: 0, speed: 0, callTimer: 0 });
  context.player = { x: animal.x - 1, y: animal.y };
  system.update(0.1, context);
  assert.deepEqual(calls, ['alarm'], 'o alarme não chegou ao ouvido');

  // E não vira coro: o segundo animal assustado na mesma varredura espera a janela do alarme.
  const b = createAnimal(1, 'boar', 84, 60, 77);
  system.animals.push(b);
  context.player = { x: b.x - 1, y: b.y };
  for (let i = 0; i < 4; i++) system.update(0.05, context);
  assert.equal(calls.length, 1, 'dois sustos em 0,2s viraram coro de uivo');

  // De volta ao campo de visão, a conversa ociosa continua existindo.
  context.isVisible = () => true;
  Object.assign(animal, { state: 'idle', fleeTimer: 0, speed: 0, callTimer: 0 });
  context.player = { x: animal.x + 10, y: animal.y };
  for (let i = 0; i < 80; i++) system.update(0.05, context);
  assert.ok(calls.includes('idle'), 'a conversa ociosa morreu junto com o filtro de tela');
});

test('far animals freeze ALL state, RNG, animation and collision work even with noise; 32 is inclusive', () => {
  const { system, animal, context, resetQueries, queries } = single();
  Object.assign(animal, { state: 'walking', speed: 1, decisionTimer: 0 });
  context.player = { x: animal.x + 32.001, y: animal.y };
  context.noise = [{ x: animal.x, y: animal.y, radius: 200 }];
  const before = copy(animal); resetQueries();
  for (let i = 0; i < 100; i++) system.update(0.2, context);
  assert.deepEqual(animal, before); assert.equal(queries(), 0);
  const visual = animalVisualState(animal, 0);
  assert.equal(animalSpritePose(visual, 100).frame, animalSpritePose(visual, 0).frame);
  context.player.x = animal.x + 32;
  system.update(0.1, context); assert.equal(animal.state, 'fleeing');
  assert.ok(queries() > 0);
});

test('fences and water stop a swept body; roads and city ground are corridors it may cross', () => {
  for (const barrier of ['fence', 'water', 'road', 'city']) {
    const { system, animal, context, map, boxes, tile } = single('deer');
    animal.x = 59.5;
    const wall = barrier === 'fence' || barrier === 'water';
    if (barrier === 'fence') boxes.push({ x: 61, y: 0, width: 0.015, height: map.worldH });
    else for (let y = 0; y < map.worldH; y++) tile(61, y,
      barrier === 'city' ? { biome: 'residential' } : { kind: barrier });
    for (let i = 0; i < 160; i++) {
      context.player = { x: animal.x - 2, y: animal.y };
      system.update(i % 5 === 0 ? 10 : 0.1, context);
      if (wall) {
        assert.ok(animal.x + animal.radius < 61, barrier);
        assertHabitat(map, animal);
      } else assertPathable(map, animal);
    }
    if (!wall) assert.ok(animal.x - animal.radius > 61, `${barrier} não foi atravessada`);
  }
});

test('relevo íngreme é parede: a fauna contorna o talude em vez de escalar ou despencar', () => {
  for (const [name, wall] of [['subida', [0, 6]], ['descida', [6, 0]]]) {
    const { system, animal, context, map, level } = single('deer');
    animal.x = 59.5;
    for (let y = 0; y < map.worldH; y++) {
      for (let x = 0; x < map.worldW; x++) level(x, y, x < 61 ? wall[0] : wall[1]);
    }
    for (let i = 0; i < 160; i++) {
      context.player = { x: animal.x - 2, y: animal.y };
      system.update(i % 5 === 0 ? 10 : 0.1, context);
      assert.ok(animal.x < 61, `${name}: o animal escalou ou despencou do talude`);
      assertHabitat(map, animal);
    }
  }
});

test('a chased animal leaves its quadra, crosses the avenue and walks itself back to the reserve', () => {
  const world = fixture(96);
  for (let y = 30; y < 60; y++) for (let x = 0; x < 96; x++) world.tile(x, y, { biome: 'residential' });
  for (let y = 40; y < 42; y++) for (let x = 0; x < 96; x++) world.tile(x, y, { kind: 'road' });
  const system = new WildlifeSystem();
  const animal = createAnimal(0, 'rabbit', 24, 24, 11);
  system.animals.push(animal);
  assert.equal(animal.homeX, 24); assert.equal(animal.homeY, 24);
  const context = { map: world.map, player: { x: 24, y: 22 } };
  for (let i = 0; i < 60; i++) {
    context.player = { x: animal.x, y: animal.y - 2 };
    system.update(0.1, context);
    assertPathable(world.map, animal);
  }
  assert.ok(animal.y > 42, `a corrida parou em y=${animal.y}`);
  assert.equal(isWildlifePositionSafe(world.map, animal.x, animal.y, animal.radius), false,
    'a fuga deve ter levado o bicho para fora do habitat');
  assert.equal(isWildlifePathSafe(world.map, animal.x, animal.y, animal.radius), true);
  for (let i = 0; i < 900; i++) {
    context.player = { x: animal.x + 20, y: animal.y };
    system.update(0.1, context);
    assertPathable(world.map, animal);
  }
  assert.ok(animal.y < 28, `não voltou para a mata: y=${animal.y}`);
  assert.ok(isWildlifePositionSafe(world.map, animal.x, animal.y, animal.radius));
  assert.ok(Math.hypot(animal.x - animal.homeX, animal.y - animal.homeY) <= WILDLIFE_HOME_DISTANCE);
});

test('ground vehicles block motion; distant, parked and airborne vehicles do not cause false flight', () => {
  const { system, animal, context, map } = single();
  context.vehicles = [{ x: 61, y: 60, speed: 0, radius: 0.4 }];
  Object.assign(animal, { state: 'walking', moveX: 1, moveY: 0, decisionTimer: 10 });
  for (let i = 0; i < 40; i++) {
    system.update(0.1, context); assert.notEqual(animal.state, 'fleeing'); assertHabitat(map, animal);
    assert.ok(Math.abs(animal.x - 61) > animal.radius + 0.4 || Math.abs(animal.y - 60) > animal.radius + 0.4);
  }
  context.vehicles = [{ x: animal.x, y: animal.y, speed: 4, altitude: 1 }, { x: 120, y: 120, speed: 4 }];
  system.update(0.1, context); assert.notEqual(animal.state, 'fleeing');
});

test('all fleet slots affect flight, swept collision and spawn rejection regardless of array order', () => {
  for (const index of [127, 128, 159]) {
    const { system, animal, context, map } = single();
    const vehicles = Array.from({ length: 160 }, () => ({ x: 150, y: 150, speed: 0, radius: 0.4 }));
    const vehicle = vehicles[index];
    Object.assign(vehicle, { x: 58, y: 60, speed: 3 });
    context.vehicles = vehicles;
    system.update(0.1, context);
    assert.equal(animal.state, 'fleeing', `flight slot ${index}`);
    Object.assign(animal, { x: 60, y: 60, state: 'walking', fleeTimer: 0, moveX: 1, moveY: 0, decisionTimer: 100 });
    Object.assign(vehicle, { x: 61, y: 60, speed: 0 });
    for (let step = 0; step < 40; step++) {
      system.update(0.1, context);
      assert.ok(Math.abs(animal.x - 61) > animal.radius + 0.4 || Math.abs(animal.y - 60) > animal.radius + 0.4, `collision slot ${index}`);
    }
    Object.assign(vehicle, { x: 100.5, y: 100.5, radius: 1 });
    const buckets = [{ x: 100.5, y: 100.5, biome: 'forest', ground: [{ x: 100.5, y: 100.5 }], trails: [] }];
    assert.equal(system.pickSpawn(map, 'rabbit', undefined, 0, 12, animal, undefined, vehicles, buckets), null, `spawn slot ${index}`);
    vehicle.altitude = 1;
    assert.ok(system.pickSpawn(map, 'rabbit', undefined, 0, 12, animal, undefined, vehicles, buckets));
  }
});

test('vehicle broadphase scans distant fleet once per tick and includes intersecting wide footprints', () => {
  const { system, animal, context } = single();
  let reads = 0;
  context.vehicles = Array.from({ length: 160 }, () => ({ get x() { reads++; return 1000; }, y: 1000 }));
  for (let i = 1; i < WILDLIFE_UPDATE_LIMIT; i++) system.animals.push(createAnimal(i, 'rabbit', 60 + i * 0.02, 60));
  system.update(0.1, context);
  assert.equal(reads, 160);
  context.vehicles = [{ x: 125, y: 60, speed: 0, dir: 'NE', def: { footprintW: 140, footprintH: 10 } }];
  Object.assign(animal, { x: 60, y: 60, state: 'walking', moveX: 1, moveY: 0, decisionTimer: 100 });
  system.update(0.1, context);
  assert.equal(animal.x, 60); assert.equal(animal.y, 60);
});

test('damage is idempotent, keeps corpse for 16s, notifies once even far, and rejects invalid inputs', () => {
  const { system, animal, context } = single();
  const before = copy(animal);
  for (const amount of [0, -1, NaN, Infinity]) assert.equal(damage(animal, amount), false);
  assert.deepEqual(animal, before);
  assert.equal(damage(animal, 5), false); assert.equal(animal.health, 15); assert.equal(animal.state, 'fleeing');
  assert.equal(system.damage(animal, 100), true);
  assert.equal(animal.dead, true); assert.equal(animal.health, 0); assert.equal(animal.deathTimer, 0);
  context.player = { x: 150, y: 150 };
  let deaths = 0, changes = 0;
  context.onDeath = (dead) => { deaths++; assert.equal(damage(dead, 999), false); };
  context.onStructChange = () => changes++;
  for (const dt of [0, -1, NaN, Infinity]) system.update(dt, context);
  assert.equal(deaths, 0); assert.equal(animal.deathTimer, 0);
  system.update(7, context);
  assert.equal(deaths, 1); assert.equal(changes, 1); assert.equal(animal.deathTimer, 7);
  const dead = copy(animal); assert.equal(damage(animal, 10), false); assert.deepEqual(animal, dead);
  system.update(8.99, context); assert.ok(isAnimalVisible(animal));
  system.update(0.02, context); assert.equal(animal.deathTimer, ANIMAL_CORPSE_SECONDS);
  assert.equal(isAnimalVisible(animal), false);
  system.update(99, context); assert.equal(deaths, 1); assert.equal(changes, 1);
});

test('offscreen replacement preserves slots/ids, resets life, obeys camera veto and bounded retry budget', () => {
  const { map, resetQueries, queries } = fixture();
  const system = new WildlifeSystem(); system.init(map, 402);
  const list = system.animals, slots = [...list];
  let deaths = 0, changes = 0, visibilityChecks = 0;
  const context = { map, player: { x: 80, y: 80 }, onDeath: () => deaths++, onStructChange: () => changes++,
    isVisible: () => { visibilityChecks++; return true; } };
  for (const animal of list) damage(animal, 999);
  resetQueries(); system.update(16, context);
  assert.equal(deaths, WILDLIFE_COUNT); assert.equal(changes, 1); assert.ok(list.every((a) => a.dead));
  assert.ok(visibilityChecks <= WILDLIFE_RESPAWN_ATTEMPTS); assert.equal(queries(), 0);
  // Entire world in camera: repeated failures are bounded, never an unsafe fallback.
  for (let i = 0; i < 20; i++) {
    visibilityChecks = 0; system.update(0.1, context);
    assert.ok(visibilityChecks <= WILDLIFE_RESPAWN_ATTEMPTS); assert.ok(list.every((a) => a.dead));
  }
  // No camera contract: conservative fallback must keep every replacement outside simulation.
  delete context.isVisible;
  for (let i = 0; i < 3000 && list.some((a) => a.dead); i++) {
    const aliveBefore = list.filter((a) => !a.dead).length;
    resetQueries(); system.update(0.1, context);
    assert.ok(list.filter((a) => !a.dead).length - aliveBefore <= 1);
    assert.ok(queries() <= WILDLIFE_RESPAWN_ATTEMPTS);
  }
  assert.equal(list, system.animals); assert.equal(list.length, WILDLIFE_COUNT); assert.ok(list.every((a) => !a.dead));
  list.forEach((animal, i) => {
    assert.equal(animal, slots[i]); assert.equal(animal.id, i); assert.equal(animal.generation, 1);
    assert.equal(animal.deathTimer, -1); assert.equal(animal.deathNotified, false);
    assert.ok(animal.health > 0);
    assert.ok(distance(animal, context.player) > WILDLIFE_RESPAWN_DISTANCE); assertHabitat(map, animal);
  });
  assert.equal(deaths, WILDLIFE_COUNT); assert.equal(changes, WILDLIFE_COUNT + 1);
  damage(list[0], 999); system.update(0.1, context); assert.equal(deaths, WILDLIFE_COUNT + 1);
});

test('revalidation refuses changed habitats, close spawns and invalid player positions without unbounded work', () => {
  const { map, resetQueries, queries } = fixture(30);
  const system = new WildlifeSystem(); system.init(map, 16);
  const animal = system.animals[0]; damage(animal, 999);
  const context = { map, player: { x: 15, y: 15 } };
  system.update(17, context); assert.equal(animal.dead, true); // No point can be 48 tiles away.
  context.player = { x: NaN, y: 15 }; const before = copy(system.animals);
  system.update(0.1, context); assert.deepEqual(system.animals, before);
  context.player = { x: 100, y: 100 };
  for (const tile of map.data.tiles) tile.kind = 'water';
  resetQueries(); system.update(0.1, context);
  assert.equal(animal.dead, true); assert.equal(queries(), 0);
});

test('crowded habitat caps expensive updates at 48 and prioritizes the nearest slots', () => {
  const { map, queries, resetQueries } = fixture();
  const system = new WildlifeSystem(), player = { x: 60, y: 60 };
  for (let i = 0; i < WILDLIFE_COUNT; i++) {
    const animal = createAnimal(i, 'fox', 70 + i * 0.04, 60);
    Object.assign(animal, { state: 'walking', decisionTimer: 100, moveX: 0, moveY: 1 });
    system.animals.push(animal);
  }
  resetQueries(); system.update(0.1, { map, player });
  assert.equal(system.animals.filter((a) => a.animTime > 0).length, WILDLIFE_UPDATE_LIMIT);
  assert.ok(system.animals.slice(0, WILDLIFE_UPDATE_LIMIT).every((a) => a.animTime > 0));
  assert.ok(queries() <= WILDLIFE_UPDATE_LIMIT * 5);
});

test('local restocking improves encounters without visible teleports, healing, erased bodies or bursts', () => {
  const { map, resetQueries, queries } = fixture();
  const { FogSystem } = load(src('systems/FogSystem.ts'));
  const fog = new FogSystem(), player = { x: 80, y: 80 };
  const view = fog.view({ camera: { ...player, zoom: 0.95 }, viewW: 1920, viewH: 1080 });
  const visible = (x, y) => fog.intersects(view, (x - y) * 64 - 45, (x + y) * 32 - 65, 90, 90);
  const system = new WildlifeSystem(); system.init(map, 91);
  const slots = [...system.animals];
  // A depleted destination, all healthy donors initially in a remote habitat.
  slots.forEach((a, i) => { a.x = 115 + i % 14 * 3; a.y = 115 + Math.floor(i / 14) * 2; });
  slots[0].health--; // A wounded, distant idle animal is not disposable.
  Object.assign(slots[1], { state: 'fleeing', fleeTimer: 3 });
  damage(slots[2], 999);
  const observed = { x: slots[3].x, y: slots[3].y };
  let deaths = 0, replacements = 0, lastReplacement = -100;
  const context = { map, player, onDeath: () => deaths++, isVisible: (x, y) => visible(x, y) || distance({ x, y }, observed) < 0.5 };
  for (let tick = 0; tick < 1200; tick++) {
    const before = copy(slots);
    resetQueries(); system.update(0.1, context);
    const changed = slots.filter((a, i) => a.generation !== before[i].generation);
    assert.ok(changed.length <= 1);
    assert.ok(queries() <= WILDLIFE_UPDATE_LIMIT * 3 * 5 + WILDLIFE_RESPAWN_ATTEMPTS);
    if (tick < 159) { assert.equal(slots[2].dead, true); assert.equal(slots[2].generation, 0); }
    for (const animal of changed) {
      const source = before[animal.id];
      if (!source.dead) { assert.ok(distance(source, player) > WILDLIFE_RESPAWN_DISTANCE); assert.equal(context.isVisible(source.x, source.y), false); }
      assert.equal(context.isVisible(animal.x, animal.y), false, 'destination must be fully hidden even at minimum zoom');
      assert.ok(distance(animal, player) <= WILDLIFE_LOCAL_RADIUS
        || (source.dead && distance(animal, player) > WILDLIFE_RESPAWN_DISTANCE), 'only expired corpses may refill globally');
      assert.ok(distance(animal, player) > 8);
      assert.ok((tick - lastReplacement) * 0.1 >= WILDLIFE_RESTOCK_SECONDS - 1e-8);
      assert.equal(animal, system.animals[animal.id]); assertHabitat(map, animal);
      lastReplacement = tick; replacements++;
    }
  }
  const local = slots.filter((a) => !a.dead && distance(a, player) <= WILDLIFE_LOCAL_RADIUS).length;
  assert.ok(local >= WILDLIFE_LOCAL_TARGET - 4, `insufficient local recovery: ${local}`);
  assert.ok(replacements >= 20 && replacements < 70, `bounded replenishment: ${replacements}`);
  assert.equal(deaths, 1);
  for (const i of [0, 1, 3]) { assert.equal(slots[i].generation, 0); }
  assert.equal(slots[0].health, model.ANIMAL_STATS[slots[0].species].health - 1);
  console.log(`  Local recovery: 0 -> ${local}, ${replacements} hidden replacements / 120s`);
});

test('visible donors and missing camera contract cannot relocate live slots', () => {
  for (const isVisible of [undefined, () => true]) {
    const { map } = fixture(); const system = new WildlifeSystem(); system.init(map, 17);
    const before = system.animals.map((a) => a.generation);
    for (let i = 0; i < 400; i++) system.update(0.1, { map, player: { x: 0, y: 0 }, isVisible });
    assert.deepEqual(system.animals.map((a) => a.generation), before);
  }
});

test('habitat/trail stratification bounds memory and concentrates original clusters near paths', () => {
  const { generateCity } = load(src('data/maps/city.ts'));
  const { Map: WorldMap } = load(src('world/Map.ts'));
  const map = new WorldMap(generateCity()); const system = new WildlifeSystem(); system.init(map, 17);
  const samples = system.habitats.reduce((n, b) => n + b.ground.length + b.trails.length, 0);
  assert.ok(samples < 4096);
  const stride = map.data.tilesW;
  const onTrail = system.animals.filter((a) => map.data.tiles[Math.floor(a.y) * stride + Math.floor(a.x)].key === 'tile_ground_dirt');
  assert.ok(onTrail.length > WILDLIFE_COUNT * 0.45, `trails: ${onTrail.length}`);
  const paired = system.animals.filter((a) => system.animals.some((b) => a !== b && a.species === b.species && distance(a, b) < 8));
  assert.ok(paired.length > WILDLIFE_COUNT * 0.6, `clustered: ${paired.length}`);
});

test('non-graphic fall/fade, mirrored directions and snapshot animation never mutate models', () => {
  const animal = createAnimal(1, 'deer', 5, 5);
  const before = copy(animal);
  const visual = animalVisualState(animal, 10);
  assert.equal(animalDeathPose(false, 100).alpha, 1);
  assert.equal(animalDeathPose(true, -1).scaleY, 1);
  const settled = animalDeathPose(true, 0.65);
  assert.equal(settled.scaleY, 0.38); assert.equal(settled.alpha, 1);
  assert.equal(animalDeathPose(true, 14.5).alpha, 0.5);
  assert.equal(animalDeathPose(true, 16).alpha, 0);
  assert.equal(animalDeathPose(true, 99).alpha, 0);
  for (const [dir, mirror, away] of [['SE', 1, false], ['SW', -1, false], ['NE', 1, true], ['NW', -1, true]]) {
    const pose = animalSpritePose({ ...visual, dir }, 10);
    assert.equal(pose.mirror, mirror); assert.equal(pose.away, away); assert.equal(pose.frame, 0);
  }
  const moving = { ...visual, state: 'walking', speed: 0.8 };
  const frames = [0, 1 / 7, 2 / 7, 3 / 7].map((animTime) => animalSpritePose({ ...moving, animTime }, 10).frame);
  assert.deepEqual(frames, [1, 2, 3, 4]);
  assert.notEqual(animalSpritePose({ ...moving, animTime: 0.1 }, 10).frame,
    animalSpritePose({ ...moving, state: 'fleeing', animTime: 0.1 }, 10).frame);
  const dead = { ...moving, dead: true, deathTimer: 0, sampledAt: 10 };
  assert.deepEqual(animalSpritePose(dead, 1000), animalSpritePose(dead, 10.2));
  assert.deepEqual(animal, before);
});

test('Skia sprite: 9 cached paths, integer original art, different views/gaits and shared-value publication', () => {
  const { AnimalSprite } = load(src('render/AnimalSprite.tsx'));
  function expand(element) {
    if (!element) return [];
    if (Array.isArray(element)) return element.flatMap(expand);
    if (typeof element.type === 'function') return expand(element.type(element.props));
    return [element, ...expand(element.props?.children)];
  }
  const value = (v) => v && 'value' in v ? v.value : v;
  for (const species of ['rabbit', 'deer', 'fox', 'boar']) {
    const animal = createAnimal(0, species, 3, 5);
    const visual = { value: animalVisualState(animal, 0) }, position = { value: { x: 3, y: 5, h: 0 } }, clock = { value: 0 };
    const tree = expand(AnimalSprite({ animal, visual, position, clock }));
    const paths = tree.filter((element) => element.type === 'Path');
    assert.equal(paths.length, 9);
    assert.equal(tree[0].props.antiAlias, false);
    assert.deepEqual(value(tree[0].props.transform), [{ translateX: -128 }, { translateY: 256 }]);
    position.value = { x: 4, y: 5, h: 0 };
    assert.deepEqual(value(tree[0].props.transform), [{ translateX: -64 }, { translateY: 288 }]);
    // O chão elevado só mexe o Y da tela: um tile e meio acima é 96 px para cima, X intacto.
    position.value = { x: 4, y: 5, h: 1.5 };
    assert.deepEqual(value(tree[0].props.transform), [{ translateX: -64 }, { translateY: 192 }]);
    position.value = { x: 4, y: 5, h: 0 };
    const posePaths = (dir, state, animTime) => {
      visual.value = { ...visual.value, dir, state, animTime, speed: 1 };
      return paths.slice(1).map((p) => value(p.props.path));
    };
    const front = posePaths('SE', 'idle', 0);
    assert.deepEqual(posePaths('SW', 'idle', 0), front, 'left is a geometric mirror, not extra assets');
    assert.notDeepEqual(posePaths('NE', 'idle', 0), front, 'back view must not be only a mirror');
    assert.notDeepEqual(posePaths('SE', 'walking', 0), posePaths('SE', 'walking', 2 / 7));
    for (const dir of ['SE', 'NE']) for (const time of [0, 1 / 7, 2 / 7, 3 / 7]) {
      for (const sprite of posePaths(dir, 'walking', time)) for (const [op, ...coords] of sprite.commands) {
        assert.ok(coords.every(Number.isInteger), `${species}: fractional pixel contour`);
        if (op === 'rect') assert.ok(coords[2] > 0 && coords[3] > 0);
      }
    }
    const second = expand(AnimalSprite({ animal, visual, position, clock })).filter((e) => e.type === 'Path');
    assert.equal(value(paths[1].props.path), value(second[1].props.path), 'geometry shared across animals');
    visual.value = { ...visual.value, dead: true, deathTimer: 16 };
    assert.equal(value(tree[0].props.opacity), 0);
  }
});
console.log(`Wildlife checks: ${passed} passed. No generated files or native runtime required.`);
