// Run: node tools/check/check-exploration.cjs. Compile TS in memory; no generated files/native runtime.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');
const srcPath = (name) => path.join(root, 'src', name);
const cache = new Map();
const ui = { paused: false, mapOpen: false, shopOpen: false, overlay: null, mapMarker: null, mapRoute: [] };
const stubs = {
  [srcPath('audio/SoundManager.ts')]: { sound: { play() {}, ambient() {}, weather() {}, setLoop() {}, stopLoops() {} } },
  [srcPath('assets/AssetRegistry.ts')]: { spriteKeyForVehicle: () => '' },
  [srcPath('stores/useGameStore.ts')]: { useGameStore: {
    getState: () => ui, clearMapMarker() {}, refreshMapRoute() {}, showOverlay(kind) { ui.overlay = kind; },
    openShop() { ui.shopOpen = true; }, closeShop() { ui.shopOpen = false; },
  } },
};
function load(filename) {
  if (!path.extname(filename)) filename += '.ts';
  if (Object.hasOwn(stubs, filename)) return stubs[filename];
  if (cache.has(filename)) return cache.get(filename).exports;
  const result = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    fileName: filename, reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, strict: true, esModuleInterop: true },
  });
  assert.deepEqual(result.diagnostics, [], filename);
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.paths = Module._nodeModulePaths(path.dirname(filename));
  mod.require = (name) => name.startsWith('.') ? load(path.resolve(path.dirname(filename), name)) : require(name);
  cache.set(filename, mod);
  mod._compile(result.outputText, filename);
  return mod.exports;
}
const source = (name) => load(srcPath(name));
const { ExplorationSystem } = source('systems/ExplorationSystem.ts');
const update = (e, x, y, outdoors = true) => e.update({ position: { x, y }, outdoors });
const key = (x, y) => `${x},${y}`;
const cell = (point) => [Math.floor(point.x), Math.floor(point.y)];
let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('OK ' + name); }
  catch (error) { failed++; console.error('FAIL ' + name + '\n' + error.stack); }
}
function snapshot(e) {
  const explored = [], visited = [];
  for (let y = 0; y < e.height; y++) for (let x = 0; x < e.width; x++) {
    if (e.isExplored(x, y)) explored.push(key(x, y));
    if (e.isVisited(x, y)) visited.push(key(x, y));
  }
  assert.equal(e.exploredCount, explored.length);
  assert.equal(e.visitedCount, visited.length);
  const known = new Set(explored);
  assert.ok(visited.every((p) => known.has(p)), 'visited must be a subset of explored');
  assert.equal(e.percent, e.width * e.height ? explored.length / (e.width * e.height) * 100 : 0);
  assert.ok(e.percent >= 0 && e.percent <= 100);
  assert.ok(Number.isInteger(e.version) && e.version >= 0);
  return { explored, visited, version: e.version };
}
// Independent exhaustive oracle, used only in tests: union of radius-eight tile-center discs.
function expected(width, height, visits) {
  const explored = [], visited = [];
  const physical = new Set(visits.map(([x, y]) => key(x, y)));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (visits.some(([tx, ty]) => Math.hypot((x + 0.5) - (tx + 0.5), (y + 0.5) - (ty + 0.5)) <= 8)) explored.push(key(x, y));
    if (physical.has(key(x, y))) visited.push(key(x, y));
  }
  return { explored, visited };
}
function assertVisits(e, visits) {
  const { version, ...actual } = snapshot(e);
  assert.deepEqual(actual, expected(e.width, e.height, visits));
}
function assertRetained(before, after) {
  for (const field of ['explored', 'visited']) {
    const kept = new Set(after[field]);
    assert.ok(before[field].every((p) => kept.has(p)), field + ' regressed');
  }
  assert.ok(after.version >= before.version);
}

test('empty grids, dimensions and private byte storage', () => {
  const e = new ExplorationSystem(31, 17);
  assert.equal(e.width, 31); assert.equal(e.height, 17);
  assert.ok(e.tiles instanceof Uint8Array); assert.equal(e.tiles.length, 31 * 17);
  assert.deepEqual(snapshot(e), { explored: [], visited: [], version: 0 });
  for (const [w, h] of [[0, 0], [0, 4], [4, 0]]) {
    const empty = new ExplorationSystem(w, h);
    assert.equal(update(empty, 0, 0), false); assert.equal(empty.percent, 0);
  }
  for (const [w, h] of [[-1, 4], [4, -1], [1.5, 2], [NaN, 2], [2, Infinity]]) {
    assert.throws(() => new ExplorationSystem(w, h), RangeError);
  }
});

test('radius eight at every edge/corner, tile-centered fractions and non-square maps', () => {
  for (const [w, h] of [[37, 23], [23, 37], [3, 1], [1, 3], [1, 1]]) {
    for (const [tx, ty] of [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1],
      [Math.floor(w / 2), Math.floor(h / 2)], [0, Math.floor(h / 2)], [Math.floor(w / 2), h - 1]]) {
      for (const fraction of [0, 0.01, 0.5, 0.999]) {
        const e = new ExplorationSystem(w, h);
        assert.equal(update(e, tx + fraction, ty + fraction), true);
        assertVisits(e, [[tx, ty]]); assert.equal(e.version, 1);
        assert.ok(e.tiles.every((n) => n === 0 || n === 1 || n === 2));
      }
    }
  }
  const e = new ExplorationSystem(40, 40);
  update(e, 20.9, 20.1);
  assert.equal(e.exploredCount, 197);
  assert.equal(e.isExplored(28, 20), true); assert.equal(e.isExplored(28, 21), false);
  assert.equal(e.isVisited(21, 20), false);
});

test('same-tile frames and revisits do not reveal again or increment version', () => {
  const e = new ExplorationSystem(40, 40);
  update(e, 20.1, 20.1);
  const initial = snapshot(e);
  for (let i = 0; i < 1000; i++) assert.equal(update(e, 20 + (i % 10) / 10, 20.9), false);
  assert.deepEqual(snapshot(e), initial);
  update(e, 21.5, 20.5);
  const moved = snapshot(e);
  assert.equal(update(e, 20.5, 20.5), false);
  e.breakTrail();
  assert.equal(update(e, 20.5, 20.5), false);
  assert.deepEqual(snapshot(e), moved);
  assertVisits(e, [[20, 20], [21, 20]]);
});

test('short fast and diagonal movement marks only sampled physical cells, once per update', () => {
  const cases = [
    [[10.5, 10.5], [13.5, 10.5], [[10, 10], [11, 10], [12, 10], [13, 10]]],
    [[10.5, 10.5], [12.5, 12.5], [[10, 10], [11, 11], [12, 12]]],
    [[10.5, 10.5], [12.5, 11.5], [[10, 10], [11, 10], [11, 11], [12, 11]]],
    [[13.5, 10.5], [10.5, 10.5], [[13, 10], [12, 10], [11, 10], [10, 10]]],
  ];
  for (const [from, to, visits] of cases) {
    const e = new ExplorationSystem(40, 30);
    update(e, ...from); assert.equal(update(e, ...to), true);
    assertVisits(e, visits); assert.equal(e.version, 2);
  }
  const e = new ExplorationSystem(40, 30);
  const position = { x: 10.1, y: 10.5 };
  e.update({ position, outdoors: true });
  position.x = 10.9;
  assert.equal(e.update({ position, outdoors: true }), false);
  position.x = 13.8; // Under three world units from the latest same-cell sample.
  assert.equal(e.update({ position, outdoors: true }), true);
  assertVisits(e, [[10, 10], [11, 10], [12, 10], [13, 10]]);
});

test('teleports over three world units never reveal or visit a connecting corridor', () => {
  const e = new ExplorationSystem(80, 30);
  update(e, 10.5, 15.5); update(e, 65.5, 15.5);
  assertVisits(e, [[10, 15], [65, 15]]);
  assert.equal(e.isExplored(35, 15), false);
  for (const end of [13.501, 13.99]) {
    const near = new ExplorationSystem(40, 30);
    update(near, 10.5, 10.5); update(near, end, 10.5);
    assertVisits(near, [[10, 10], [13, 10]]);
  }
});

test('interior coordinates and explicit breaks clear sampling without forgetting discoveries', () => {
  for (const interrupt of [(e) => e.breakTrail(), (e) => assert.equal(update(e, 5, 6.7, false), false)]) {
    const e = new ExplorationSystem(50, 40);
    update(e, 25.5, 20.5);
    const before = snapshot(e);
    interrupt(e); assert.deepEqual(snapshot(e), before);
    update(e, 27.5, 20.5);
    assertVisits(e, [[25, 20], [27, 20]]);
    assert.equal(e.isVisited(26, 20), false); assert.equal(e.isExplored(5, 6), false);
  }
});

test('invalid positions are rejected, clear sampling and cannot wrap row indices', () => {
  const invalid = [[-0.01, 10], [10, -0.01], [40, 10], [10, 30], [Infinity, 10],
    [10, -Infinity], [NaN, 10], [10, NaN], [Number.MAX_VALUE, 0], [0, Number.MAX_VALUE]];
  for (const point of invalid) {
    const e = new ExplorationSystem(40, 30);
    update(e, 10.5, 10.5); const before = snapshot(e);
    assert.equal(update(e, ...point), false); assert.deepEqual(snapshot(e), before);
    update(e, 12.5, 10.5); assertVisits(e, [[10, 10], [12, 10]]);
    assert.equal(e.isExplored(...point), false); assert.equal(e.isVisited(...point), false);
  }
  const e = new ExplorationSystem(40, 30);
  update(e, 0.5, 11.5); update(e, 39.5, 9.5);
  for (const point of [[40, 10], [-1, 10], [0.5, 11], [0, 11.5]]) {
    assert.equal(e.isVisited(...point), false); assert.equal(e.isExplored(...point), false);
  }
});

test('counts and versions are monotonic, including visited-only changes at 100 percent', () => {
  const e = new ExplorationSystem(6, 4);
  let before = snapshot(e);
  for (let y = 0; y < e.height; y++) for (let x = 0; x < e.width; x++) {
    const changed = update(e, x + 0.5, y + 0.5);
    const after = snapshot(e);
    assertRetained(before, after);
    assert.equal(after.version, before.version + Number(changed));
    assert.equal(e.percent, 100);
    before = after;
  }
  assert.equal(e.visitedCount, 24);
  assert.equal(update(e, 0.5, 0.5), false); assert.deepEqual(snapshot(e), before);
  for (let i = 0; i < 30; i++) {
    const changed = update(e, (i * 13 % 60) / 10, (i * 7 % 40) / 10, i % 5 !== 0);
    assert.equal(changed, false); assert.deepEqual(snapshot(e), before);
  }
});

test('work is bounded by reveal radius, not map area; stationary frames skip tile access', () => {
  const e = new ExplorationSystem(4096, 1024);
  let accesses = 0;
  e.tiles = new Proxy(e.tiles, { get(target, prop) {
    if (typeof prop === 'string' && /^\d+$/.test(prop)) accesses++;
    return Reflect.get(target, prop, target);
  } });
  update(e, 100.5, 100.5);
  assert.ok(accesses <= 300, `initial tile reads: ${accesses}`);
  accesses = 0;
  for (let i = 0; i < 1000; i++) { update(e, 100.1, 100.9); void e.percent; void e.exploredCount; void e.visitedCount; }
  assert.equal(accesses, 0);
  update(e, 103, 100.9);
  assert.ok(accesses <= 1200, `moving tile reads: ${accesses}`);
});

const { GameState, resetGame, getGame } = source('game/GameState.ts');
const input = source('game/InputState.ts');
const { createVehicle } = source('entities/Vehicle.ts');
const { VEHICLE_DEFS } = source('data/vehicles.ts');
function game() {
  input.resetInputState();
  Object.assign(ui, { paused: false, mapOpen: false, overlay: null, mapMarker: null, mapRoute: [] });
  const g = new GameState();
  // Keep actual movement, collision, interior and respawn code; remove unrelated AI interference.
  g.police.update = () => {};
  g.trafficSystem.update = () => {};
  g.npcSystem.update = () => {};
  g.npcs = []; g.vehicles = [];
  g.rnd = () => 0.5;
  return g;
}
function unknownSidewalk(g) {
  const point = g.map.sidewalkNodes.find((p) => !g.exploration.isExplored(...cell(p)));
  assert.ok(point, 'unknown sidewalk fixture');
  return point;
}
function countBreaks(e) {
  let count = 0;
  const original = e.breakTrail.bind(e);
  e.breakTrail = () => { count++; original(); };
  return () => count;
}

test('GameState initializes from map dimensions at its corrected outdoor spawn', () => {
  const g = game();
  assert.equal(g.exploration.width, g.map.data.tilesW);
  assert.equal(g.exploration.height, g.map.data.tilesH);
  assertVisits(g.exploration, [cell(g.player)]);
  assert.equal(g.exploration.version, 1);
  g.update(0); assertVisits(g.exploration, [cell(g.player)]);
  assert.equal(g.exploration.version, 1);
});

test('GameState pause, map and overlays block discovery; camera and queries never reveal', () => {
  const g = game();
  const before = snapshot(g.exploration);
  const target = unknownSidewalk(g);
  Object.assign(g.player, target);
  for (const [owner, field, value] of [[g, 'paused', true], [ui, 'paused', true], [ui, 'mapOpen', true],
    [ui, 'overlay', 'wasted'], [ui, 'overlay', 'busted']]) {
    const original = owner[field]; owner[field] = value;
    g.camera.x = target.x; g.camera.y = target.y;
    g.update(0.5);
    assert.deepEqual(snapshot(g.exploration), before);
    owner[field] = original;
  }
  g.update(0);
  assert.ok(g.exploration.isVisited(...cell(g.player)));
  assert.ok(g.exploration.version > before.version);
});

test('GameState samples after final player separation', () => {
  const g = game(); const target = unknownSidewalk(g);
  const original = g.separate.bind(g);
  g.separate = (player) => { original(player); Object.assign(player, target); };
  g.update(0);
  assert.ok(g.exploration.isVisited(...cell(target)));
});

for (const vehicleKey of ['sedan', 'helicopter']) test(`GameState ${vehicleKey} tracks real world coordinates and continuous movement`, () => {
  const g = game();
  const start = g.map.roadNodes.find((p) => p.x > 12 && p.y > 12 && p.x < g.map.worldW - 25
    && !g.exploration.isExplored(...cell(p)) && Array.from({ length: 22 }, (_, i) => i).every((i) =>
      g.map.tileKindAt(p.x + i, p.y) === 'road'
      && !g.collision.overlapsAny({ x: p.x + i, y: p.y, radius: 1 }, g.map.queryNearby(p.x + i, p.y, 2))));
  assert.ok(start, 'clear straight road fixture');
  const vehicle = createVehicle(9999, VEHICLE_DEFS[vehicleKey], 'red', start.x, start.y, 'SE');
  g.vehicles = [vehicle];
  g.vehicleSystem.enterVehicle(g.player, vehicle);
  g.camera.x = 0; g.camera.y = 0;
  g.update(0);
  assert.equal(g.player.x, vehicle.x); assert.equal(g.player.y, vehicle.y);
  assert.ok(g.exploration.isVisited(...cell(vehicle)));
  input.setVehicleControl('accel', true);
  if (vehicleKey === 'helicopter') input.setJoystickInput(2, 1, 1); // World +X, not screen-space +X.
  for (let tick = 0; tick < 20; tick++) {
    const before = g.exploration.version;
    g.update(0.1);
    assert.equal(g.player.x, vehicle.x); assert.equal(g.player.y, vehicle.y);
    assert.ok(g.exploration.isVisited(...cell(vehicle)));
    assert.ok(g.exploration.version >= before && g.exploration.version <= before + 1);
  }
  assert.ok(vehicle.x > start.x + 2, 'vehicle actually moved');
  assert.equal(vehicle.y, start.y);
  for (let x = Math.floor(start.x); x <= Math.floor(vehicle.x); x++) assert.ok(g.exploration.isVisited(x, Math.floor(start.y)), `trail hole ${x}`);
  if (vehicleKey === 'helicopter') assert.ok(vehicle.altitude > 0);
  input.resetInputState();
});

test('GameState room entry/exit records the outdoor door, never room-local positions', () => {
  const g = game(); const e = g.exploration; const breaks = countBreaks(e);
  const entrance = g.interiors.entrances.find((p) => !e.isExplored(...cell(p)) && Math.hypot(p.x - 5, p.y - 6) > 25);
  assert.ok(entrance); assert.equal(e.isExplored(5, 6), false);
  Object.assign(g.player, { x: entrance.x, y: entrance.y });
  input.queueInteract(); g.update(0);
  assert.ok(g.interiors.active); assert.equal(breaks(), 1);
  assert.ok(e.isVisited(...cell(entrance))); assert.equal(e.isExplored(...cell(g.player)), false);
  const inside = snapshot(e);
  input.setJoystickInput(-1, 0, 1);
  for (let i = 0; i < 10; i++) g.update(0.1);
  assert.deepEqual(snapshot(e), inside);
  input.resetInputState();
  const breaksBeforeExit = breaks();
  Object.assign(g.player, g.interiors.active.exit);
  input.queueInteract(); g.update(0);
  assert.equal(g.interiors.active, null);
  assert.equal(g.player.x, entrance.x); assert.equal(g.player.y, entrance.y);
  assert.equal(breaks(), breaksBeforeExit + 1, 'exit explicitly breaks the trail');
  assert.deepEqual(snapshot(e), inside);
  Object.assign(g.player, unknownSidewalk(g)); g.update(0);
  assert.ok(e.isVisited(...cell(g.player))); assert.ok(e.version > inside.version);
});

for (const kind of ['wasted', 'busted']) test(`GameState ${kind} respawn retains progress and breaks the trail`, () => {
  const g = game(); const e = g.exploration;
  Object.assign(g.player, unknownSidewalk(g)); g.update(0);
  const before = snapshot(e); const breaks = countBreaks(e);
  if (kind === 'wasted') {
    g.player.health = 0;
    g.update(0);
    assert.equal(g.player.state, 'dead');
    assert.equal(ui.overlay, null);
    for (let i = 0; i < 60; i++) g.update(1 / 60);
  } else g.bust();
  assert.equal(g.exploration, e); assert.equal(ui.overlay, kind);
  // Preso de verdade: a pena começa dentro da cela, e o que existe lá fora é a porta da esquadra.
  assert.equal(g.interiors.active?.kind ?? null, kind === 'busted' ? 'jail' : null);
  assert.equal(breaks(), kind === 'busted' ? 2 : 1, 'entrar na cadeia soma a ruptura da sala');
  const outdoor = kind === 'busted' ? g.interiors.jailEntrance : g.player;
  assert.ok(e.isVisited(...cell(outdoor)));
  const after = snapshot(e); assertRetained(before, after);
  assertVisits(e, [...before.visited.map((p) => p.split(',').map(Number)), cell(outdoor)]);
  assert.ok(after.version <= before.version + 1);
  Object.assign(g.player, unknownSidewalk(g)); g.update(0.5);
  assert.deepEqual(snapshot(e), after, 'respawn overlay blocks further exploration');
});

test('GameState respawn from indoors never discovers local coordinates', () => {
  const g = game(); const entrance = g.interiors.entrances[0];
  Object.assign(g.player, { x: entrance.x, y: entrance.y });
  input.queueInteract(); g.update(0);
  assert.ok(g.interiors.active);
  const before = snapshot(g.exploration);
  const local = cell(g.player); assert.equal(g.exploration.isExplored(...local), false);
  g.waste();
  assert.equal(g.interiors.active, null);
  assertRetained(before, snapshot(g.exploration));
  assertVisits(g.exploration, [...before.visited.map((p) => p.split(',').map(Number)), cell(g.player)]);
});

test('new GameState and resetGame create independent session-only discoveries', () => {
  const old = game(); const remote = unknownSidewalk(old);
  update(old.exploration, remote.x, remote.y);
  const oldState = snapshot(old.exploration);
  const next = game();
  assert.notEqual(next.exploration, old.exploration);
  assert.equal(next.exploration.isExplored(...cell(remote)), false);
  assertVisits(next.exploration, [cell(next.player)]);
  const first = resetGame(); update(first.exploration, remote.x, remote.y);
  const firstState = snapshot(first.exploration);
  const second = resetGame();
  assert.equal(getGame(), second); assert.notEqual(first.exploration, second.exploration);
  assert.equal(second.exploration.isExplored(...cell(remote)), false);
  assertVisits(second.exploration, [cell(second.player)]);
  assert.deepEqual(snapshot(first.exploration), firstState);
  assert.deepEqual(snapshot(old.exploration), oldState);
});

console.log(`Exploration checks: ${passed} passed, ${failed} failed.`);
if (failed) process.exitCode = 1;
