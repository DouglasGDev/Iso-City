// Run: node tools/check/check-save.cjs. Compile TS in memory; no generated files/native runtime.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');
const srcPath = (name) => path.join(root, 'src', name);
const cache = new Map();
const ui = { paused: false, mapOpen: false, shopOpen: false, departuresOpen: false, overlay: null, mapMarker: null, mapRoute: [] };
const stubs = {
  [srcPath('audio/SoundManager.ts')]: { sound: { play() {}, ambient() {}, weather() {}, setLoop() {}, stopLoops() {}, isUnlocked: true, unlock: async () => {} } },
  [srcPath('assets/AssetRegistry.ts')]: { spriteKeyForVehicle: () => '' },
  [srcPath('stores/useGameStore.ts')]: { useGameStore: {
    getState: () => ui, clearMapMarker() {}, refreshMapRoute() {}, showOverlay(kind) { ui.overlay = kind; },
    openShop() { ui.shopOpen = true; }, closeShop() { ui.shopOpen = false; },
    openDepartures() { ui.departuresOpen = true; }, closeDepartures() { ui.departuresOpen = false; },
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
const { SAVE_VERSION, isSaveGame, exploredPercent } = source('game/SaveGame.ts');
const input = source('game/InputState.ts');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('OK ' + name); }
  catch (error) { failed++; console.error('FAIL ' + name + '\n' + error.stack); }
}
function sets(e) {
  const explored = [], visited = [];
  for (let y = 0; y < e.height; y++) for (let x = 0; x < e.width; x++) {
    if (e.isExplored(x, y)) explored.push(`${x},${y}`);
    if (e.isVisited(x, y)) visited.push(`${x},${y}`);
  }
  return { explored, visited };
}
function wander(e, rng, steps) {
  let x = e.width / 2, y = e.height / 2;
  for (let i = 0; i < steps; i++) {
    x = Math.max(0.1, Math.min(e.width - 0.1, x + (rng() - 0.5) * 2));
    y = Math.max(0.1, Math.min(e.height - 0.1, y + (rng() - 0.5) * 2));
    e.update({ position: { x, y }, outdoors: true });
  }
}
const mulberry32 = (seed) => () => {
  seed |= 0; seed = seed + 0x6D2B79F5 | 0;
  let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
  return ((t ^ t >>> 14) >>> 0) / 4294967296;
};

test('serialize/restore round-trips every cell, counters and percent', () => {
  for (const [w, h, steps] of [[40, 30, 300], [7, 5, 40], [240, 240, 1500], [1, 1, 5]]) {
    const src = new ExplorationSystem(w, h);
    wander(src, mulberry32(w * 131 + h), steps);
    const before = sets(src);
    const copy = new ExplorationSystem(w, h);
    assert.equal(copy.restore(src.serialize()), true, 'restore accepted');
    assert.deepEqual(sets(copy), before, `round-trip ${w}x${h}`);
    assert.equal(copy.exploredCount, src.exploredCount);
    assert.equal(copy.visitedCount, src.visitedCount);
    assert.equal(copy.percent, src.percent);
  }
});

test('restore rejects mismatched dimensions and leaves the grid untouched', () => {
  const src = new ExplorationSystem(20, 20);
  wander(src, mulberry32(7), 80);
  const payload = src.serialize();
  const wrong = new ExplorationSystem(30, 20);
  assert.equal(wrong.restore(payload), false);
  assert.equal(wrong.exploredCount, 0);
  // Corrupted / truncated payloads must not throw and simply reveal nothing beyond what parses.
  assert.doesNotThrow(() => new ExplorationSystem(20, 20).restore('20x20:garbage'));
  assert.doesNotThrow(() => new ExplorationSystem(20, 20).restore(''));
});

test('run-length keeps a fresh map tiny and a full map bounded', () => {
  const empty = new ExplorationSystem(240, 240);
  assert.ok(empty.serialize().length < 32, 'empty map encodes short');
  const full = new ExplorationSystem(60, 60);
  for (let y = 0; y < 60; y++) for (let x = 0; x < 60; x++) full.update({ position: { x: x + 0.5, y: y + 0.5 }, outdoors: true });
  const restored = new ExplorationSystem(60, 60);
  assert.equal(restored.restore(full.serialize()), true);
  assert.equal(restored.percent, 100);
});

test('exploredPercent matches the live system after restore', () => {
  const src = new ExplorationSystem(50, 40);
  wander(src, mulberry32(99), 500);
  assert.ok(Math.abs(exploredPercent(src.serialize()) - src.percent) < 1e-9);
});

function game() {
  input.resetInputState();
  Object.assign(ui, { paused: false, mapOpen: false, overlay: null, mapMarker: null, mapRoute: [] });
  const g = new (source('game/GameState.ts').GameState)();
  g.police.update = () => {}; g.trafficSystem.update = () => {}; g.npcSystem.update = () => {};
  return g;
}

test('snapshot -> applySave onto a fresh world restores player, arsenal, clock and map', () => {
  const src = game();
  // Drive real state into the source game.
  src.player.x = src.map.roadNodes[10].x; src.player.y = src.map.roadNodes[10].y;
  src.exploration.update({ position: src.player, outdoors: true });
  src.weapons.acquire('pistol'); src.weapons.acquire('smg');
  src.weapons.equipped = 'smg'; src.weapons.ammo.smg.loaded = 11; src.weapons.ammo.pistol.reserve = 5;
  src.player.money = 1234; src.player.health = 61; src.player.wantedLevel = 3; src.player.stamina = 0.4;
  src.dayNight.t = 0.72; src.time = 908;

  const save = src.snapshot();
  assert.equal(save.version, SAVE_VERSION);
  assert.equal(isSaveGame(save), true);

  const next = game();
  assert.notEqual(next.exploration, src.exploration);
  next.applySave(save);

  assert.equal(next.player.money, 1234);
  assert.equal(next.player.health, 61);
  assert.equal(next.player.wantedLevel, 3);
  assert.ok(Math.abs(next.player.stamina - 0.4) < 1e-9);
  assert.equal(next.player.currentVehicleId, null);
  assert.ok(Math.hypot(next.player.x - src.player.x, next.player.y - src.player.y) < 1.5, 'placed near saved spot');
  assert.equal(next.dayNight.t, 0.72);
  assert.equal(next.time, 908);
  assert.equal(next.weapons.equipped, 'smg');
  assert.ok(next.weapons.owned.has('pistol') && next.weapons.owned.has('smg'));
  assert.equal(next.weapons.ammo.smg.loaded, 11);
  assert.equal(next.weapons.ammo.pistol.reserve, 5);
  assert.deepEqual(sets(next.exploration), sets(src.exploration));
});

test('applySave falls back when equipped weapon is not owned', () => {
  const src = game();
  const save = src.snapshot();
  save.weapons.equipped = 'sniper'; save.weapons.owned = ['unarmed', 'bat'];
  const next = game();
  next.applySave(save);
  assert.equal(next.weapons.equipped, 'unarmed');
});

test('isSaveGame rejects wrong version, missing ammo and junk', () => {
  const src = game();
  const good = src.snapshot();
  assert.equal(isSaveGame({ ...good, version: 999 }), false);
  const noAmmo = JSON.parse(JSON.stringify(good)); delete noAmmo.weapons.ammo.rifle;
  assert.equal(isSaveGame(noAmmo), false);
  assert.equal(isSaveGame(null), false);
  assert.equal(isSaveGame({}), false);
});

console.log(`Save checks: ${passed} passed, ${failed} failed.`);
if (failed) process.exitCode = 1;
