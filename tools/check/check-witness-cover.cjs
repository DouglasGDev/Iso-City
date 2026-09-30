// Run: node tools/check/check-witness-cover.cjs
// Real geometry, entities and orchestration; only native audio/assets/UI storage are stubbed.
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');
const source = (name) => path.join(root, 'src', name + '.ts');
const program = ts.createProgram(['systems/WitnessSystem', 'systems/CoverSystem', 'systems/WeaponSystem', 'game/GameState'].map(source), {
  target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, moduleResolution: ts.ModuleResolutionKind.Node10,
  strict: true, esModuleInterop: true, skipLibCheck: true, noEmit: true, jsx: ts.JsxEmit.ReactJSX,
});
const diagnostics = ts.getPreEmitDiagnostics(program);
if (diagnostics.length) {
  console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCurrentDirectory: () => root, getCanonicalFileName: (f) => f, getNewLine: () => '\n',
  }));
  process.exit(1);
}
require.extensions['.ts'] = (module, filename) => {
  const { outputText } = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, esModuleInterop: true }, fileName: filename,
  });
  module._compile(outputText, filename);
};
const ui = { paused: false, mapOpen: false, shopOpen: false, overlay: null, mapMarker: null, mapRoute: [] };
for (const [name, exports] of [
  ['audio/SoundManager', { sound: { play() {}, setLoop() {}, ambient() {}, weather() {}, stopLoops() {} } }],
  ['assets/AssetRegistry', { spriteKeyForVehicle: () => '' }],
  ['stores/useGameStore', { useGameStore: { getState: () => ui, showOverlay: (kind) => { ui.overlay = kind; }, clearMapMarker() {}, refreshMapRoute() {}, openShop() { ui.shopOpen = true; }, closeShop() { ui.shopOpen = false; } } }],
]) {
  const filename = source(name);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}
const load = (name) => require(source(name));
const { CoverSystem } = load('systems/CoverSystem');
const { WitnessSystem } = load('systems/WitnessSystem');
const { WeaponSystem } = load('systems/WeaponSystem');
const { WantedSystem } = load('systems/WantedSystem');
const { PoliceSystem } = load('systems/PoliceSystem');
const { TrafficSystem } = load('systems/TrafficSystem');
const { InteriorSystem } = load('systems/InteriorSystem');
const { GameState } = load('game/GameState');
const { Map: WorldMap } = load('world/Map');
const { createNPC } = load('entities/NPC');
const { createPlayer } = load('entities/Player');
const { createVehicle } = load('entities/Vehicle');
const { VEHICLE_DEFS } = load('data/vehicles');
const input = load('game/InputState');
let passed = 0, failed = 0;
const armPistol = (w) => { w.acquire('pistol'); w.equipped = 'pistol'; return w; };
function test(name, fn) {
  input.resetInputState();
  try { fn(); passed++; console.log('OK ' + name); }
  catch (error) { failed++; process.exitCode = 1; console.error('FAIL ' + name, error); }
}
function near(actual, expected, eps = 1e-8) { assert.ok(Math.abs(actual - expected) <= eps, `${actual} != ${expected}`); }
function map(colliders = [], buildings = [], props = []) {
  const W = 80;
  return new WorldMap({ tilesW: W, tilesH: W, worldW: W, worldH: W,
    heights: new Float32Array(W * W),
    tiles: Array.from({ length: W * W }, (_, i) => {
      const y = Math.floor(i / W);
      return y === 30 || y === 31 ? { kind: 'road', key: '', lane: y === 30 ? 'NW' : 'SE', biome: 'residential' }
        : { kind: 'concrete', key: '', biome: 'residential' };
    }), buildings, props, vehicles: [], npcSpawns: [], playerSpawn: { x: 10, y: 29.5 },
  }, colliders);
}
const box = (x, y, width, height, patch = {}) => ({ x, y, width, height, type: 'BUILDING', ...patch });
const point = (x, y = 10, z = 1.4) => ({ x, y, z });
const vehicle = (id, type = 'sedan', x = 15, y = 10, dir = 'SE') => createVehicle(id, VEHICLE_DEFS[type], '', x, y, dir);
function fixture(colliders = []) {
  const reports = [], starts = [];
  const ctx = { map: map(colliders), vehicles: [], npcs: [], player: createPlayer(10, 10),
    onReport: (incident) => reports.push(incident), onCallStart: () => starts.push(true) };
  return { ctx, witnesses: new WitnessSystem(), reports, starts };
}
function witness(f, id = 3, x = 14, y = 10, kind = 'civ') {
  const n = createNPC(id, 'a', x, y, kind, () => 0.5);
  f.ctx.npcs.push(n);
  return n;
}
const incident = (x = 10, y = 10, severity = 1) => ({ x, y, severity });
function advance(f, seconds, dt = 0.05) {
  for (let elapsed = 0; elapsed < seconds - 1e-9; elapsed += dt) f.witnesses.update(Math.min(dt, seconds - elapsed), f.ctx);
}

// These expected intersections are analytic segment fractions, not calls to another geometry helper.
test('3D slabs include parallel/vertical rays, reverse direction, endpoints and inside origins', () => {
  const ctx = { map: map([box(14, 9, 2, 2, { coverHeight: 2 })]), vehicles: [] };
  const hit = (a, b) => CoverSystem.firstHit(a, b, ctx);
  near(hit(point(10, 10, 1), point(20, 10, 1)).t, 0.4);
  near(hit(point(20, 10, 1), point(10, 10, 1)).t, 0.4);
  near(hit(point(15, 10, 4), point(15, 10, 0)).t, 0.5);
  assert.equal(hit(point(10, 12, 1), point(20, 12, 1)), null);
  assert.equal(hit(point(10, 10, 2.01), point(20, 10, 2.01)), null);
  assert.equal(hit(point(10, 10, -0.1), point(20, 10, -0.1)), null);
  assert.equal(hit(point(15, 10, 1), point(15, 10, 1)).t, 0);
  assert.equal(hit(point(15, 10, 3), point(15, 10, 3)), null);
  assert.equal(hit(point(10, 10, 1), point(14, 10, 1)).t, 1);
  near(hit(point(10, 9, 2), point(20, 9, 2)).t, 0.4);
});

test('slab intersection clips against the entire 3D segment, not only the entry height', () => {
  const ctx = { map: map([box(14, 9, 2, 2, { coverHeight: 0.95 })]), vehicles: [] };
  const a = point(10, 10, 2), b = point(20, 10, 0);
  near(CoverSystem.firstHit(a, b, ctx).t, 0.525);
  near(CoverSystem.firstHit(b, a, ctx).t, 0.4);
  assert.equal(CoverSystem.firstHit(point(10, 10, 4), point(20, 10, 1), ctx), null);
});

test('default wall height is eight, default fence height .95, explicit non-cover is transparent', () => {
  for (const [collider, height] of [[box(14, 9, 2, 2), 8], [box(14, 9, 2, 2, { type: 'FENCE' }), 0.95]]) {
    const ctx = { map: map([collider]), vehicles: [] };
    assert.ok(CoverSystem.firstHit(point(10, 10, height), point(20, 10, height), ctx));
    assert.equal(CoverSystem.firstHit(point(10, 10, height + 0.01), point(20, 10, height + 0.01), ctx), null);
  }
  const ctx = { map: map([box(14, 9, 2, 2, { coverHeight: 0 })]), vehicles: [] };
  assert.equal(CoverSystem.firstHit(point(10, 10, 0.1), point(20, 10, 0.1), ctx), null);
});

test('real prop mapping distinguishes solid fences, wire and low objects', () => {
  for (const [key, blocked] of [['prop_fence_wood', true], ['prop_fence_wire', false], ['prop_trashcan', true]]) {
    const prop = key.includes('trashcan') ? { key, x: 15, y: 10 }
      : { key, x: 15, y: 10, collider: box(14.9, 9, 0.2, 2) };
    const ctx = { map: map([], [], [prop]), vehicles: [] };
    assert.equal(!!CoverSystem.firstHit(point(10, 10, 0.8), point(20, 10, 0.8), ctx), blocked, key);
    assert.equal(CoverSystem.firstHit(point(10), point(20), ctx), null);
  }
});

test('nearest cover wins independently of array order across actual spatial-grid cells', () => {
  const close = box(17, 9, 0.1, 2), far = box(24, 9, 1, 2);
  for (const walls of [[far, close], [close, far]]) {
    const ctx = { map: map(walls), vehicles: [vehicle(1, 'van', 27)] };
    const hit = CoverSystem.firstHit(point(5), point(35), ctx);
    assert.equal(hit.collider, close); near(hit.t, 0.4);
    ctx.vehicles.push(vehicle(2, 'van', 12));
    assert.equal(CoverSystem.firstHit(point(5), point(35), ctx).vehicle.id, 2);
  }
});

test('sedans and vans provide distinct 1.05/1.9 height cover, ignored vehicles do not block', () => {
  for (const [type, height] of [['sedan', 1.05], ['van', 1.9]]) {
    const v = vehicle(42, type), ctx = { map: map(), vehicles: [v] };
    assert.equal(CoverSystem.firstHit(point(10, 10, height), point(20, 10, height), ctx).vehicle, v);
    assert.equal(CoverSystem.firstHit(point(10, 10, height + 0.01), point(20, 10, height + 0.01), ctx), null);
    assert.equal(CoverSystem.firstHit(point(10, 10, 0.8), point(20, 10, 0.8), ctx, 42), null);
    assert.ok(CoverSystem.firstHit(point(10, 10, 0.8), point(20, 10, 0.8), ctx, 99));
    v.altitude = 1;
    assert.equal(CoverSystem.firstHit(point(10, 10, 0.8), point(20, 10, 0.8), ctx), null);
  }
});

test('vehicle cover rotates with all four orientations, exposing the narrow side', () => {
  for (const dir of ['SE', 'NW', 'SW', 'NE']) {
    const v = vehicle(1, 'sedan', 15, 10, dir), ctx = { map: map(), vehicles: [v] };
    const alongX = dir === 'SE' || dir === 'NW';
    near(CoverSystem.firstHit(point(10, 10, 0.8), point(20, 10, 0.8), ctx).t, alongX ? 0.4525 : 0.4675);
    assert.equal(!!CoverSystem.firstHit(point(10, 10.4, 0.8), point(20, 10.4, 0.8), ctx), !alongX, dir);
  }
});

test('weapon reverse/forward cycling wraps and cannot bypass cooldown or complete a cancelled reload', () => {
  const w = new WeaponSystem();
  for (const id of ['pistol', 'smg', 'rifle', 'shotgun']) w.acquire(id);
  for (const expected of ['bat', 'shotgun', 'rifle', 'smg', 'pistol', 'unarmed']) assert.equal(w.cycle(-1), expected);
  for (const expected of ['pistol', 'smg', 'rifle', 'shotgun', 'bat', 'unarmed']) assert.equal(w.cycle(1), expected);
  w.cycle(1);
  const f = fixture();
  const ctx = { ...f.ctx, wanted: new WantedSystem(), pickups: { spawnDrop() {}, spawnWeaponDrop() {} }, onStructChange() {}, shake() {}, rng: () => 0.5 };
  assert.ok(w.tryFire(ctx)); assert.ok(w.reload(ctx));
  const ammo = { ...w.ammo.pistol };
  w.cycle(-1); w.cycle(1);
  assert.equal(w.reloadLeft, 0); assert.equal(w.tryFire(ctx), false);
  w.update(4); assert.deepEqual(w.ammo.pistol, ammo);
});

test('isolated shots cannot report or create wanted even after the full call delay', () => {
  const f = fixture(), w = armPistol(new WeaponSystem()), wanted = new WantedSystem();
  const ctx = { ...f.ctx, wanted, pickups: { spawnDrop() {}, spawnWeaponDrop() {} }, onStructChange() {}, shake() {}, rng: () => 0.5,
    onCrime: (event) => f.witnesses.observe(event, f.ctx) };
  assert.ok(w.tryFire(ctx)); advance(f, 10);
  assert.equal(f.witnesses.calls.length, 0); assert.deepEqual(f.reports, []);
  assert.equal(f.ctx.player.wantedLevel, 0);
});

test('civilian hearing reaches twenty tiles, but only sight within sixteen can start a report', () => {
  for (const distance of [15.99, 16.01, 19.99, 20.01]) {
    const f = fixture(), n = witness(f, 3, 10 + distance);
    f.witnesses.observe(incident(), f.ctx);
    assert.equal(n.state === 'fleeing', distance < 20, String(distance));
    assert.equal(f.witnesses.calls.length, distance < 16 ? 1 : 0);
    advance(f, 3.5);
    assert.equal(f.reports.length, distance < 16 ? 1 : 0);
  }
});

test('hearing through walls may cause fleeing but never reveals the shooter to police', () => {
  for (const kind of ['civ', 'cop']) {
    const f = fixture([box(12, 0, 0.1, 80)]), n = witness(f, 3, 14, 10, kind);
    f.witnesses.observe(incident(), f.ctx); advance(f, 4);
    assert.equal(f.witnesses.calls.length, 0); assert.equal(f.reports.length, 0);
    if (kind === 'civ') assert.equal(n.state, 'fleeing');
  }
});

test('civilian starts calling near .7s and reports near 2.8s, not instantly', () => {
  const f = fixture(), n = witness(f);
  f.witnesses.observe(incident(), f.ctx);
  assert.equal(f.reports.length, 0); assert.equal(n.callingPolice, false);
  advance(f, 0.69); assert.equal(n.callingPolice, false); assert.equal(f.starts.length, 0);
  advance(f, 0.02); assert.equal(n.callingPolice, true); assert.equal(f.starts.length, 1);
  advance(f, 2.07); assert.equal(f.reports.length, 0);
  advance(f, 0.04);
  assert.deepEqual(f.reports, [incident()]); assert.equal(n.callingPolice, false);
  assert.equal(f.witnesses.calls.length, 0); assert.equal(f.starts.length, 1);
});

test('police radio reports at .45s with LOS, including occupied patrol vehicles', () => {
  for (const occupied of [false, true]) {
    const f = fixture(), n = witness(f, 3, 14, 10, 'cop');
    if (occupied) {
      const v = vehicle(42, 'swat', 14);
      v.occupied = true; f.ctx.vehicles.push(v); n.inVehicle = true; n.vehicleId = v.id;
    }
    f.witnesses.observe(incident(), f.ctx);
    assert.equal(f.witnesses.calls.length, 1);
    advance(f, 0.44); assert.equal(f.reports.length, 0);
    advance(f, 0.02); assert.deepEqual(f.reports, [incident()]);
    assert.equal(n.callingPolice, false); assert.equal(f.starts.length, 0);
  }
});

test('police radio is cancelled if the officer dies or is knocked down before transmission', () => {
  for (const knocked of [false, true]) {
    const f = fixture(), n = witness(f, 3, 14, 10, 'cop');
    f.witnesses.observe(incident(), f.ctx); advance(f, 0.2);
    assert.equal(f.witnesses.calls.length, 1);
    if (knocked) { n.state = 'knocked'; n.downTimer = 10; }
    else { n.dead = true; n.health = 0; n.state = 'dead'; }
    advance(f, 1);
    assert.equal(f.reports.length, 0); assert.equal(f.witnesses.calls.length, 0);
  }
});

test('incapacitated/dead witnesses and civilian vehicle occupants cannot begin calls', () => {
  for (const patch of [{ dead: true }, { health: 0 }, { state: 'knocked' }, { inVehicle: true }]) {
    const f = fixture(), n = witness(f);
    Object.assign(n, patch);
    f.witnesses.observe(incident(), f.ctx); advance(f, 4);
    assert.equal(f.witnesses.calls.length, 0); assert.equal(f.reports.length, 0);
    assert.equal(n.callingPolice, false);
  }
});

test('death, knockdown, removal or entering a car cancels a pending civilian call', () => {
  for (const reason of ['dead', 'zero-health', 'knocked', 'removed', 'car']) {
    const f = fixture(), n = witness(f);
    f.witnesses.observe(incident(), f.ctx); advance(f, 0.8);
    assert.equal(n.callingPolice, true);
    if (reason === 'dead') n.dead = true;
    if (reason === 'zero-health') n.health = 0;
    if (reason === 'knocked') { n.state = 'knocked'; n.downTimer = 10; }
    if (reason === 'removed') f.ctx.npcs.length = 0;
    if (reason === 'car') n.inVehicle = true;
    advance(f, 4);
    assert.equal(f.witnesses.calls.length, 0, reason); assert.equal(f.reports.length, 0, reason);
    if (reason !== 'removed') assert.equal(n.callingPolice, false, reason);
  }
});

test('an actual fatal shot cancels its victim call rather than letting a dead witness report', () => {
  const f = fixture(), n = witness(f), w = armPistol(new WeaponSystem());
  f.witnesses.observe(incident(), f.ctx); advance(f, 0.8);
  n.health = 1;
  const ctx = { ...f.ctx, wanted: new WantedSystem(), pickups: { spawnDrop() {}, spawnWeaponDrop() {} }, onStructChange() {}, shake() {}, rng: () => 0.5,
    onCrime: (event) => f.witnesses.observe(event, f.ctx) };
  assert.ok(w.tryFire(ctx)); assert.equal(n.dead, true);
  advance(f, 4); assert.equal(f.reports.length, 0); assert.equal(n.callingPolice, false);
});

test('repeated gunshots do not restart the delay, duplicate a caller, or flood reports', () => {
  const f = fixture();
  for (let i = 0; i < 12; i++) witness(f, i + 3, 14, 9 + i * 0.1);
  for (let i = 0; i < 20; i++) {
    f.witnesses.observe(incident(10, 10, i === 10 ? 3 : 1), f.ctx);
    assert.ok(f.witnesses.calls.length <= 6);
    assert.equal(new Set(f.witnesses.calls.map((c) => c.npcId)).size, f.witnesses.calls.length);
    advance(f, 0.1);
  }
  assert.equal(f.reports.length, 0);
  advance(f, 1.4);
  assert.deepEqual(f.reports, [incident(10, 10, 3)]);
  assert.equal(f.witnesses.calls.length, 0);
  assert.ok(f.ctx.npcs.every((n) => !n.callingPolice));
  for (let i = 0; i < 10; i++) { f.witnesses.observe(incident(), f.ctx); advance(f, 0.1); }
  assert.equal(f.reports.length, 1);
  advance(f, 5); f.witnesses.observe(incident(11, 10, 2), f.ctx); advance(f, 3.5);
  assert.deepEqual(f.reports, [incident(10, 10, 3), incident(11, 10, 2)]);
});

test('radio and civilian calls for one incident deliver exactly one report', () => {
  for (const radioFirst of [false, true]) {
    const f = fixture();
    if (radioFirst) witness(f, 4, 14, 10, 'cop');
    witness(f, 3);
    if (!radioFirst) witness(f, 4, 14, 10, 'cop');
    f.witnesses.observe(incident(), f.ctx); advance(f, 4);
    assert.deepEqual(f.reports, [incident()]); assert.equal(f.witnesses.calls.length, 0);
    assert.ok(f.ctx.npcs.every((n) => !n.callingPolice));
  }
});

test('a new audible but occluded shot cannot move a pending report to the hidden shooter', () => {
  const f = fixture([box(18, 0, 0.1, 80)]);
  witness(f);
  f.witnesses.observe(incident(), f.ctx); advance(f, 0.8);
  Object.assign(f.ctx.player, { x: 20, y: 10, crouching: true });
  f.witnesses.observe(incident(20, 10, 3), f.ctx);
  advance(f, 3);
  assert.deepEqual(f.reports, [incident()]);
});

test('pending reports snapshot observed positions and never read hidden player coordinates', () => {
  const f = fixture(); witness(f);
  const observed = incident();
  f.witnesses.observe(observed, f.ctx); observed.x = 70;
  for (const key of ['x', 'y']) Object.defineProperty(f.ctx.player, key, { get() { throw new Error('hidden player position read'); } });
  advance(f, 4);
  assert.deepEqual(f.reports, [incident()]);
});

test('crouching in open remains observable, cover hides and an exposed flank stays visible', () => {
  for (const scenario of ['open', 'covered', 'flank', 'van']) {
    const f = fixture(scenario === 'covered' || scenario === 'flank' ? [box(10.5, 9.7, 0.3, 0.6, { type: 'PROP', coverHeight: 0.95 })] : []);
    f.ctx.player.crouching = true;
    witness(f, 3, scenario === 'flank' ? 7 : 16);
    if (scenario === 'van') f.ctx.vehicles.push(vehicle(42, 'van', 13));
    f.witnesses.observe(incident(), f.ctx); advance(f, 4);
    assert.equal(f.reports.length, scenario === 'open' || scenario === 'flank' ? 1 : 0, scenario);
  }
});

test('zero/invalid dt cannot start/complete calls or advance report cooldown', () => {
  const f = fixture(), n = witness(f);
  f.witnesses.observe(incident(), f.ctx); advance(f, 0.69);
  const before = JSON.stringify([f.witnesses.calls, f.reports, f.starts]);
  for (const dt of [0, -1, NaN, Infinity]) f.witnesses.update(dt, f.ctx);
  assert.equal(JSON.stringify([f.witnesses.calls, f.reports, f.starts]), before);
  assert.equal(n.callingPolice, false);
  advance(f, 3); assert.equal(f.reports.length, 1);
  for (let i = 0; i < 100; i++) f.witnesses.update(0, f.ctx);
  f.witnesses.observe(incident(), f.ctx); assert.equal(f.witnesses.calls.length, 0);
});

test('reset clears pending calls and flags, suppresses stale reports and permits a fresh incident', () => {
  const f = fixture(), n = witness(f);
  f.witnesses.observe(incident(), f.ctx); advance(f, 0.8);
  assert.equal(n.callingPolice, true);
  f.witnesses.reset(f.ctx.npcs);
  assert.equal(n.callingPolice, false); assert.equal(f.witnesses.calls.length, 0);
  advance(f, 4); assert.equal(f.reports.length, 0);
  f.witnesses.observe(incident(11), f.ctx); advance(f, 3.5);
  assert.deepEqual(f.reports, [incident(11)]);
  f.witnesses.reset(f.ctx.npcs); f.witnesses.observe(incident(12), f.ctx); advance(f, 3.5);
  assert.deepEqual(f.reports, [incident(11), incident(12)]);
});

// Real GameState methods and all simulation systems remain active. Replace only scenario data.
function gameFixture(withWitness = true) {
  Object.assign(ui, { paused: false, mapOpen: false, overlay: null, mapMarker: null });
  const game = new GameState();
  game.map = map([], [{ key: 'bld_house_small_a', tag: 'house_small', x: 14, y: 29, footprintW: 3, footprintH: 4 }]);
  game.interiors = new InteriorSystem(game.map);
  assert.equal(game.interiors.entrances.length, 1);
  const door = game.interiors.entrances[0];
  game.player = createPlayer(door.x, door.y);
  game.player.facingAngle = -Math.PI / 2; // Shoot away from the witness.
  game.npcs = withWitness ? [createNPC(3, 'a', door.x + 4, door.y, 'civ', () => 0.5)] : [];
  game.vehicles = [];
  game.pickups.items.length = 0;
  game.wildlife.animals.length = 0;
  // Keep traffic updates real, but do not seed ambient cars/recruit our pedestrian as a driver.
  game.trafficSystem = new TrafficSystem(game.collision);
  game.police = new PoliceSystem(); game.police.init(game.policeContext());
  game.witnesses = new WitnessSystem();
  return game;
}
function gameAdvance(game, seconds) {
  for (let elapsed = 0; elapsed < seconds - 1e-9; elapsed += 0.05) game.update(Math.min(0.05, seconds - elapsed));
}
function shoot(game) {
  game.weapons.acquire('pistol');
  game.weapons.equipped = 'pistol';
  const loaded = game.weapons.ammo.pistol.loaded;
  input.queueAttack(); game.update(0.05);
  assert.equal(game.weapons.ammo.pistol.loaded, loaded - 1, 'fixture must fire a real shot');
}

test('GameState isolated outdoor gunfire never raises wanted', () => {
  const game = gameFixture(false); shoot(game); gameAdvance(game, 5);
  assert.equal(game.player.wantedLevel, 0); assert.equal(game.police.searchArea, null);
  assert.equal(game.witnesses.calls.length, 0);
});

test('GameState pending exterior call completes after real interior entry at the original incident', () => {
  const game = gameFixture(), reported = { x: game.player.x, y: game.player.y };
  shoot(game); gameAdvance(game, 0.75);
  assert.equal(game.player.wantedLevel, 0); assert.equal(game.npcs[0].callingPolice, true);
  input.queueInteract(); game.update(0.05);
  assert.ok(game.interiors.active); assert.notEqual(game.player.x, reported.x);
  gameAdvance(game, 3);
  assert.ok(game.player.wantedLevel > 0);
  assert.equal(game.police.playerVisible, false);
  near(game.police.searchArea.x, reported.x); near(game.police.searchArea.y, reported.y);
  assert.equal(game.player.health, 100); assert.equal(game.witnesses.calls.length, 0);
});

test('GameState indoor shots cannot recruit exterior witnesses from local room coordinates', () => {
  const game = gameFixture();
  input.queueInteract(); game.update(0.05); assert.ok(game.interiors.active);
  // An exterior civilian happens to share room-local coordinates; these are different spaces.
  game.npcs[0].x = game.player.x + 2; game.npcs[0].y = game.player.y;
  shoot(game); gameAdvance(game, 4);
  assert.equal(game.witnesses.calls.length, 0); assert.equal(game.player.wantedLevel, 0);
  assert.equal(game.police.searchArea, null);
});

test('GameState pause/map/overlay and dt zero leave pending witness calls frozen', () => {
  const game = gameFixture(); shoot(game); gameAdvance(game, 0.2);
  assert.ok(game.witnesses.calls.length > 0);
  const before = JSON.stringify(game.witnesses.calls);
  for (const key of ['paused', 'mapOpen', 'overlay']) {
    ui[key] = key === 'overlay' ? 'wasted' : true;
    game.update(10); ui[key] = key === 'overlay' ? null : false;
    assert.equal(JSON.stringify(game.witnesses.calls), before, key);
  }
  game.update(0); assert.equal(JSON.stringify(game.witnesses.calls), before);
  assert.equal(game.player.wantedLevel, 0);
  gameAdvance(game, 3.5); assert.ok(game.player.wantedLevel > 0);
});

test('GameState round reset cancels in-flight calls and never re-alerts from stale incidents', () => {
  const game = gameFixture(); shoot(game); gameAdvance(game, 0.75);
  assert.equal(game.npcs[0].callingPolice, true);
  game.finishRound('wasted', 100, 'hospital');
  assert.equal(game.witnesses.calls.length, 0); assert.equal(game.npcs[0].callingPolice, false);
  assert.equal(game.player.wantedLevel, 0); assert.equal(game.police.searchArea, null);
  ui.overlay = null; gameAdvance(game, 4);
  assert.equal(game.player.wantedLevel, 0); assert.equal(game.police.searchArea, null);
});

console.log(`Witness/cover checks: ${passed} passed, ${failed} failed`);
