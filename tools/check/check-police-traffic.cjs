// Run: node tools/check/check-police-traffic.cjs
// Real systems, Map graphs/collider grid and entities. Only native audio/assets are stubbed.
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');
const source = (name) => path.join(root, 'src', name);
const entries = ['PoliceSystem', 'WantedSystem', 'TrafficSystem', 'TrafficSignalSystem', 'NPCSystem'];
const program = ts.createProgram(entries.map((name) => source(`systems/${name}.ts`)), {
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
// In-memory compilation keeps this checker independent of GameState/UI and writes no build/config files.
require.extensions['.ts'] = (module, filename) => {
  const { outputText } = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    fileName: filename,
  });
  module._compile(outputText, filename);
};
const audio = [];
for (const [name, exports] of [
  ['audio/SoundManager.ts', { sound: { play: (...args) => audio.push(args), setLoop: (...args) => audio.push(args) } }],
  ['assets/AssetRegistry.ts', { spriteKeyForVehicle: () => '' }],
]) {
  const filename = source(name);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}
const load = (name) => require(source(name + '.ts'));
const { PoliceSystem } = load('systems/PoliceSystem');
const { createMemory } = load('systems/DetectionResponse');
const { WantedSystem } = load('systems/WantedSystem');
const { TrafficSystem } = load('systems/TrafficSystem');
const { TrafficSignalSystem } = load('systems/TrafficSignalSystem');
const { NPCSystem, pedestrianCrossingIntent } = load('systems/NPCSystem');
const { CollisionSystem } = load('systems/CollisionSystem');
const { HealthSystem } = load('systems/HealthSystem');
const { Map: WorldMap } = load('world/Map');
const { createNPC } = load('entities/NPC');
const { createVehicle } = load('entities/Vehicle');
const { createPlayer } = load('entities/Player');
const { VEHICLE_DEFS } = load('data/vehicles');
const { GAME_CONFIG } = load('game/GameConfig');
const { generateCity } = load('data/maps/city');
const { dirToAngle, deltaToDir } = load('world/IsoUtils');
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('OK ' + name); }
  catch (error) { failed++; process.exitCode = 1; console.error('FAIL ' + name, error); }
}
function near(a, b, eps = 1e-7) { assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`); }
function rng(seed = 42) { return new TrafficSystem(new CollisionSystem(), seed).mulberry32(seed); }
// NPCs sorteiam paciência, destino na calçada e fuga com Math.random. Sem fixar o gerador,
// o estresse de 15 minutos às vezes empaca um cruzamento por uma janela de 30s e às vezes não.
function withRng(seed, fn) {
  const realRandom = Math.random;
  let state = seed >>> 0;
  Math.random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  try { return fn(); } finally { Math.random = realRandom; }
}
function crossMap(buildings = [], colliders = []) {
  const W = 80;
  const tiles = Array.from({ length: W * W }, (_, i) => {
    const x = i % W, y = Math.floor(i / W);
    const h = y === 30 || y === 31, v = x === 30 || x === 31;
    if (!h && !v) return { kind: 'concrete', key: '' };
    return { kind: 'road', key: (h && (x === 29 || x === 32)) || (v && (y === 29 || y === 32)) ? 'pelican' : '',
      lane: h && v ? null : h ? (y === 30 ? 'NW' : 'SE') : x === 30 ? 'SW' : 'NE' };
  });
  return new WorldMap({ tilesW: W, tilesH: W, worldW: W, worldH: W, tiles, buildings,
    props: [], vehicles: [], npcSpawns: [], playerSpawn: { x: 24, y: 29.5 } }, colliders);
}
const navigation = () => ({ route: [], routeIndex: 0, refreshTimer: 0, goal: null, sweep: 0, wait: 0 });
const stationMap = () => crossMap([{ key: 'bld_policestation_test', x: 18, y: 27, footprintW: 3, footprintH: 4 }]);
function fixture(map = crossMap(), level = 2) {
  let vehicleId = 100, npcId = 200;
  const events = { changes: 0, busted: 0 };
  const ctx = { map, player: createPlayer(24, 29.5), vehicles: [], npcs: [],
    collision: new CollisionSystem(), health: new HealthSystem(), wanted: new WantedSystem(), time: 0,
    allocVehicleId: () => vehicleId++, allocNpcId: () => npcId++, rng: rng(),
    onStructChange: () => events.changes++, onBusted: () => events.busted++, shake() {} };
  const police = new PoliceSystem();
  police.init(ctx);
  ctx.wanted.raise(ctx.player, level);
  if (level > 0) police.report({ x: ctx.player.x, y: ctx.player.y });
  return { ctx, police, events };
}
// Tactical fixtures contain complete ownership/crew records, not replacement AI.
// Fleet initialization is tested separately on a real station landmark.
function registerCop(f, owner, x, y, inVehicle) {
  const n = createNPC(f.ctx.allocNpcId(), 'a', x, y, 'cop', f.ctx.rng);
  n.inVehicle = inVehicle; n.vehicleId = inVehicle ? owner.vehicleId : null;
  n.state = inVehicle ? 'idle' : 'chasing';
  f.ctx.npcs.push(n); owner.crew.push(n.id);
  f.police.cops.push({ ...navigation(), npcId: n.id, vehicleId: owner.vehicleId,
    shotCooldown: 0.8, armed: false, fireFlash: 0, aimAngle: 0,
    detection: createMemory(), response: 'ignore' });
  return n;
}
function cop(f, x, y) {
  const point = f.police.searchArea ?? { x: 24, y: 29.5 };
  unit(f, point.x, point.y + 8, 0, 'deployed');
  return registerCop(f, f.police.units.at(-1), x, y, false);
}
/**
 * As fixtures de ALCANCE e OBSTRUÇÃO pressupõem que o observador está olhando o alvo:
 * com cone de visão, quem está de costas não vê ninguém, então cada uma delas precisa
 * girar a cabeça antes de provar a regra que realmente está testando.
 */
function lookAt(observer, target) {
  observer.dir = deltaToDir(target.x - observer.x, target.y - observer.y);
  return observer;
}

function unit(f, x, y, seats = 2, mode = 'respond') {
  const v = createVehicle(f.ctx.allocVehicleId(), VEHICLE_DEFS.police, '', x, y, 'SE');
  v.state = mode === 'respond' || mode === 'patrol' ? 'driving' : 'parked';
  v.occupied = seats > 0; f.ctx.vehicles.push(v);
  const owner = { ...navigation(), vehicleId: v.id, crew: [], home: { x, y }, tier: 1,
    mode, stuckTimer: 0, ramCooldown: 0 };
  f.police.units.push(owner);
  for (let seat = 0; seat < seats; seat++) registerCop(f, owner, x, y, true);
  return v;
}
function tick(f, seconds, dt = 0.05) {
  for (let t = 0; t < seconds - 1e-8; t += dt) { f.ctx.time += dt; f.police.update(dt, f.ctx); }
}
function car(id, x, y = 31.5, dir = 'SE') {
  return createVehicle(id, VEHICLE_DEFS.sedan, 'blue', x, y, dir);
}
function trafficActor(system, vehicle, route, speed = 2.15) {
  vehicle.state = 'driving';
  const tv = { vehicle, driver: null, route, routeIndex: 0, state: 'driving', targetSpeed: speed,
    stuckTimer: 0, hornCooldown: 0, yieldWait: 0, yieldPass: false };
  system.traffic.push(tv);
  return tv;
}
const line = (x1, x2, y = 31.5) => Array.from({ length: Math.floor(x2 - x1) + 1 }, (_, i) => ({ x: x1 + i, y }));
// The stop-distance probes read the spatial grid, so prime it with the scenario's vehicles.
const signalStop = (system, tv, map, vehicles) => {
  system.syncGrids(vehicles, []);
  return system.signalStopDistance(tv, map);
};
// O ciclo completo só roda enquanto alguém pede passagem no eixo cruzado: um cruzamento
// vazio encurta para o verde do eixo principal. Para montar um cenário em vermelho é
// preciso manter essa demanda viva, exatamente como um motorista na fila faria.
function driveSignal(t, map, want, seconds = 30) {
  for (let i = 0; i < seconds / 0.05; i++) {
    const s = t.signals[0];
    if (want(s)) return s;
    t.signalSystem.request(s, 'SW');
    t.signalSystem.update(map, 0.05);
  }
  throw new Error('o semáforo nunca chegou ao estado pedido');
}
function walk(id, x, y, to) {
  const n = createNPC(id, 'b', x, y);
  n.state = 'walking'; n.path = [to]; n.pathIndex = 0;
  return n;
}

test('strict TypeScript check of all five systems (no UI dependency)', () => assert.equal(diagnostics.length, 0));
test('crime starts search, LOS acquires, loss freezes center and radius shrinks after 8s', () => {
  const f = fixture();
  const n = cop(f, 45, 29.5);
  f.police.update(0.05, f.ctx);
  assert.equal(f.police.playerVisible, false);
  near(f.police.searchArea.x, 24);
  assert.equal(f.police.searchArea.phase, 'search');
  lookAt(n, f.ctx.player); n.x = 28;
  f.police.update(0.05, f.ctx);
  assert.equal(f.police.playerVisible, true);
  assert.equal(f.police.searchArea.phase, 'pursuit');
  near(f.police.searchArea.radius, 4);
  near(f.police.unseenTimer, 0);
  f.ctx.concealed = true;
  const center = { x: f.police.searchArea.x, y: f.police.searchArea.y };
  f.ctx.player.x = 1; f.ctx.player.y = 2;
  tick(f, 8);
  const peak = f.police.searchArea.radius;
  assert.ok(peak > 4 && peak <= 18);
  near(f.police.unseenTimer, 8);
  tick(f, 2);
  assert.ok(f.police.searchArea.radius < peak && f.police.searchArea.radius > 4);
  tick(f, 30);
  assert.equal(f.police.playerVisible, false);
  assert.equal(f.police.searchArea.phase, 'search');
  near(f.police.searchArea.x, center.x); near(f.police.searchArea.y, center.y);
  near(f.police.searchArea.radius, 4);
  assert.ok(f.police.cops.some((c) => c.sweep > 0), 'officers sweep instead of camping the last point');
  // Even outside an interior, an expired search must not be recreated at the hidden player.
  f.ctx.concealed = false; f.ctx.player.x = 70; f.ctx.player.y = 70;
  tick(f, 2);
  near(f.police.searchArea.x, center.x); near(f.police.searchArea.y, center.y);
  near(f.police.searchArea.radius, 4);
});

test('init creates eight staffed station units: three patrols and five reserves, once only', () => {
  const f = fixture(stationMap(), 0);
  const station = f.ctx.map.landmark('police');
  assert.ok(station);
  assert.equal(f.police.units.length, 8);
  assert.equal(f.police.units.filter((u) => u.mode === 'patrol').length, 3);
  assert.equal(f.police.units.filter((u) => u.mode === 'standby').length, 5);
  for (const u of f.police.units) {
    const v = f.ctx.vehicles.find((v) => v.id === u.vehicleId);
    assert.ok(v && v.occupied && v.health > 0);
    assert.ok(Math.hypot(v.x - station.front.x, v.y - station.front.y) <= 12);
    near(u.home.x, v.x); near(u.home.y, v.y);
    assert.ok(u.crew.length >= 2);
    for (const id of u.crew) {
      const n = f.ctx.npcs.find((n) => n.id === id), c = f.police.cops.find((c) => c.npcId === id);
      assert.ok(n && c); assert.equal(n.kind, 'cop'); assert.equal(n.inVehicle, true);
      assert.equal(n.vehicleId, v.id); assert.equal(c.vehicleId, v.id);
      assert.equal(c.armed, false); assert.ok(Number.isFinite(c.shotCooldown + c.aimAngle + c.fireFlash));
      near(n.x, v.x); near(n.y, v.y);
    }
  }
  assert.equal(new Set(f.police.units.flatMap((u) => u.crew)).size, f.ctx.npcs.length);
  const before = JSON.stringify([f.police.units, f.police.cops, f.ctx.vehicles, f.ctx.npcs]);
  const changes = f.events.changes;
  f.police.init(f.ctx);
  assert.equal(JSON.stringify([f.police.units, f.police.cops, f.ctx.vehicles, f.ctx.npcs]), before);
  assert.equal(f.events.changes, changes);
  for (const v of f.ctx.vehicles) {
    assert.notEqual(f.ctx.map.tileKindAt(v.x, v.y), 'road', 'station reserves must not block travel lanes');
    assert.ok(f.ctx.map.roadNodes.some((p) => Math.hypot(p.x - v.x, p.y - v.y) <= 1.2),
      `unit ${v.id} lacks nearby road access at (${v.x}, ${v.y})`);
    assert.equal(f.ctx.collision.overlapsAny({ x: v.x, y: v.y, radius: 0.85 }, f.ctx.map.queryNearby(v.x, v.y, 2)), false);
    assert.equal(f.ctx.map.isWaterWorld(v.x, v.y), false);
  }
});

test('maps without a police station never manufacture reinforcement entities', () => {
  const f = fixture(crossMap(), 5);
  assert.equal(f.ctx.map.landmarksOf('police').length, 0);
  for (let i = 0; i < 5; i++) { f.police.report({ x: 20 + i, y: 29.5 }); tick(f, 10); }
  assert.equal(f.police.units.length, 0); assert.equal(f.police.cops.length, 0);
  assert.equal(f.ctx.vehicles.length, 0); assert.equal(f.ctx.npcs.length, 0);
  assert.equal(f.police.active, false);
});

test('patrols move without crime while staffed reserves remain at home', () => {
  const f = fixture(stationMap(), 0);
  const starts = f.police.units.map((u) => ({ u, mode: u.mode, v: f.ctx.vehicles.find((v) => v.id === u.vehicleId), ...u.home }));
  tick(f, 4);
  assert.ok(starts.filter((s) => s.mode === 'patrol').some((s) => Math.hypot(s.v.x - s.x, s.v.y - s.y) > 1));
  for (const s of starts.filter((s) => s.mode === 'standby')) {
    near(s.v.x, s.x); near(s.v.y, s.y); assert.equal(s.v.speed, 0); assert.equal(s.v.occupied, true);
  }
  assert.equal(f.police.searchArea, null); assert.equal(f.ctx.player.wantedLevel, 0);
});

test('patrol sight has finite range and ignores its own occupied vehicle', () => {
  for (const distance of [14.1, 14]) {
    const f = fixture();
    lookAt(unit(f, 24 + distance, 29.5), f.ctx.player);
    f.police.update(0.05, f.ctx);
    assert.equal(f.police.playerVisible, distance === 14);
  }
  // A 14 tiles, mas de costas: o arco manda, não a distância.
  const behind = fixture();
  const car = unit(behind, 38, 29.5);
  car.dir = deltaToDir(1, 0);
  behind.police.update(0.05, behind.ctx);
  assert.equal(behind.police.playerVisible, false, 'de costas a viatura não percebe o alvo');
});

test('reports dispatch existing station units toward the reported location, never the hidden player', () => {
  const f = fixture(stationMap(), 5);
  Object.assign(f.ctx.player, { x: 70, y: 70 });
  const report = { x: 45, y: 31.5 };
  f.police.report(report);
  report.x = 1;
  const vehicles = f.ctx.vehicles.slice(), npcs = f.ctx.npcs.slice();
  f.police.update(0.05, f.ctx);
  const responder = f.police.units.find((u) => u.mode === 'respond');
  assert.ok(responder);
  const v = f.ctx.vehicles.find((v) => v.id === responder.vehicleId);
  const start = { x: v.x, y: v.y };
  tick(f, 4);
  assert.equal(f.police.playerVisible, false);
  near(f.police.searchArea.x, 45); near(f.police.searchArea.y, 31.5);
  assert.ok(Math.hypot(v.x - start.x, v.y - start.y) > 0.5, 'dispatch must physically leave home');
  assert.equal(responder.goal.x, 45); assert.equal(responder.goal.y, 31.5);
  assert.ok(responder.route.some((p) => Math.hypot(p.x - 45, p.y - 31.5) < 1));
  // A frota de terra não fabrica reforço: nada que já existia muda de índice. Só aeronaves de
  // apoio aéreo (e a equipe delas, em nível 4+) podem ser acrescentadas ao mundo.
  assert.ok(f.ctx.vehicles.slice(vehicles.length).every((v) => v.def.type === 'helicopter'));
  assert.ok(f.ctx.npcs.slice(npcs.length).every((n) => n.kind === 'cop'));
  f.ctx.vehicles.slice(0, vehicles.length).forEach((v, i) => assert.equal(v, vehicles[i]));
  f.ctx.npcs.slice(0, npcs.length).forEach((n, i) => assert.equal(n, npcs[i]));
});

test('a nearby responding crew disembarks and uses firearms only at wanted level two or above', () => {
  for (const level of [1, 2, 4]) {
    const f = fixture(crossMap(), level);
    f.ctx.rng = () => 0.5;
    const v = unit(f, 20, 29.5);
    const crew = f.police.units[0].crew.slice();
    f.police.update(0.05, f.ctx);
    assert.equal(f.police.units[0].mode, 'deployed');
    for (const id of crew) {
      const n = f.ctx.npcs.find((n) => n.id === id), c = f.police.cops.find((c) => c.npcId === id);
      assert.equal(n.inVehicle, false); assert.equal(n.vehicleId, null);
      assert.equal(c.armed, level >= 2);
      assert.ok(Math.hypot(n.x - v.x, n.y - v.y) > GAME_CONFIG.NPC_RADIUS);
    }
    tick(f, 2);
    assert.equal(f.ctx.player.health < 100, level >= 2);
    assert.equal(f.police.cops.some((c) => c.armed), level >= 2);
    assert.deepEqual(f.police.units[0].crew, crew);
  }
});

test('actual collider grid blocks police sight across spatial cells', () => {
  const f = fixture(crossMap([{ key: 'test_wall', x: 17, y: 33, footprintW: 3, footprintH: 5 }]));
  Object.assign(f.ctx.player, { x: 20, y: 31.5 });
  const n = lookAt(cop(f, 10, 31.5), f.ctx.player);
  f.police.update(0.05, f.ctx);
  assert.equal(f.police.playerVisible, false);
  const center = { x: f.police.searchArea.x, y: f.police.searchArea.y };
  f.ctx.player.x = 22;
  f.police.update(0.05, f.ctx);
  near(f.police.searchArea.x, center.x); near(f.police.searchArea.y, center.y);
  lookAt(n, f.ctx.player); n.x = 21;
  f.police.update(0.05, f.ctx);
  assert.equal(f.police.playerVisible, true);
  near(f.police.searchArea.x, 22);
});

test('hidden exterior movement does not repath toward the live player', () => {
  const f = fixture();
  unit(f, 1, 31.5); cop(f, 4, 29.5);
  const foot = f.police.cops.at(-1);
  f.police.update(0.05, f.ctx);
  assert.equal(f.police.playerVisible, false);
  f.ctx.player.x = 70;
  tick(f, 1);
  near(f.police.searchArea.x, 24);
  near(f.police.units[0].goal.x, 24);
  near(foot.goal.x, 24);
  assert.ok(f.police.units[0].route.at(-1).x < 30);
});

test('concealed never reads local interior coordinates and retains only a reported exterior position', () => {
  const f = fixture();
  cop(f, 28, 29.5); unit(f, 20, 31.5);
  f.police.update(0.05, f.ctx);
  f.ctx.concealed = true;
  for (const key of ['x', 'y']) Object.defineProperty(f.ctx.player, key, { get() { throw new Error('interior coordinates read'); } });
  tick(f, 10);
  assert.equal(f.police.playerVisible, false);
  assert.equal(f.police.nearestPoliceDist, Infinity);
  assert.equal(f.events.busted, 0); assert.equal(f.ctx.player.health, 100);
  near(f.police.searchArea.x, 24); near(f.police.searchArea.y, 29.5);
});

test('wanted alone cannot locate an unseen player or fabricate a report', () => {
  const f = fixture(stationMap(), 0);
  Object.assign(f.ctx.player, { x: 70, y: 70 });
  f.ctx.wanted.raise(f.ctx.player, 5);
  tick(f, 2);
  assert.equal(f.police.playerVisible, false);
  assert.equal(f.police.searchArea, null); assert.equal(f.police.active, false);
});

test('existing foot officers beyond sight range walk toward the report', () => {
  const f = fixture();
  const n = cop(f, 55, 29.5);
  const start = n.x;
  tick(f, 4);
  assert.ok(n.x < start - 4, `officer only moved ${start - n.x}`);
  assert.equal(n.state, 'chasing');
  assert.equal(n.anim, 'walk');
  assert.ok(n.speed > 0);
});

test('level one arrests a stationary exposed player without punches, gunshots or damage', () => {
  const f = fixture(crossMap(), 1);
  cop(f, 24.4, 29.5);
  tick(f, GAME_CONFIG.ARREST_STAND_STILL_S - 0.1);
  assert.equal(f.events.busted, 0);
  tick(f, 0.2);
  assert.ok(f.events.busted > 0);
  assert.equal(f.ctx.player.health, 100); assert.equal(f.police.tracers.length, 0);
  assert.ok(f.police.cops.every((c) => !c.armed));
});

test('walls, interiors, movement and knockdown prevent level-one arrest', () => {
  for (const reason of ['wall', 'interior', 'moving', 'knocked']) {
    const colliders = reason === 'wall' ? [{ x: 24.2, y: 0, width: 0.05, height: 80, type: 'BUILDING' }] : [];
    const f = fixture(crossMap([], colliders), 1);
    const n = cop(f, 24.5, 29.5);
    if (reason === 'interior') f.ctx.concealed = true;
    if (reason === 'moving') f.ctx.player.vx = 1;
    if (reason === 'knocked') { n.state = 'knocked'; n.downTimer = 10; }
    tick(f, GAME_CONFIG.ARREST_STAND_STILL_S + 0.2);
    assert.equal(f.events.busted, 0, reason); assert.equal(f.ctx.player.health, 100, reason);
  }
});

test('open crouching is not invulnerable; a low cover barrier protects but an exposed flank does not', () => {
  const cover = { x: 22.7, y: 29.2, width: 0.3, height: 0.6, type: 'PROP', coverHeight: 0.95 };
  for (const scenario of ['open', 'covered', 'flank']) {
    const f = fixture(crossMap([], scenario === 'open' ? [] : [cover]));
    Object.assign(f.ctx.player, { x: 23.5, crouching: true });
    f.ctx.rng = () => 0.5;
    lookAt(cop(f, scenario === 'flank' ? 26 : 18, 29.5), f.ctx.player);
    // Shorter than the time needed to walk around the cover; long enough for a shot.
    tick(f, 0.85);
    assert.equal(f.ctx.player.health < 100, scenario !== 'covered', scenario);
    assert.equal(f.police.playerVisible, scenario !== 'covered', scenario);
  }
});

test('low cover can preserve eye contact yet stop a lower firearm ray', () => {
  const cover = { x: 22, y: 29.2, width: 0.2, height: 0.6, type: 'FENCE' };
  const f = fixture(crossMap([], [cover]));
  f.ctx.player.crouching = true; f.ctx.rng = () => 0.5;
  cop(f, 18, 29.5);
  tick(f, 0.9);
  assert.equal(f.police.playerVisible, true, 'the eyes can see over this cover');
  assert.ok(f.police.tracers.length > 0, 'must exercise a real shot, not merely suppress firing');
  assert.equal(f.ctx.player.health, 100);
  for (const tracer of f.police.tracers) { assert.equal(tracer.hit, true); near(tracer.x2, 22); }
});

test('walls, intervening vans and interiors block both police perception and gun damage', () => {
  for (const scenario of ['wall', 'van', 'interior']) {
    const f = fixture(crossMap([], scenario === 'wall' ? [{ x: 20, y: 0, width: 0.2, height: 80, type: 'BUILDING' }] : []));
    cop(f, 18, 29.5);
    if (scenario === 'van') f.ctx.vehicles.push(createVehicle(1, VEHICLE_DEFS.van, '', 21, 29.5, 'SE'));
    if (scenario === 'interior') f.ctx.concealed = true;
    tick(f, 0.85);
    assert.equal(f.police.playerVisible, false, scenario);
    assert.equal(f.ctx.player.health, 100, scenario); assert.equal(f.police.tracers.length, 0, scenario);
  }
});

test('reset recalls without removing/teleporting entities and never takes over a stolen patrol car', () => {
  const f = fixture();
  const n = cop(f, 26, 29.5), v = unit(f, 26, 31.5);
  tick(f, 1);
  const before = f.ctx.npcs.map((n) => ({ n, x: n.x, y: n.y }));
  const units = f.police.units.slice(), cops = f.police.cops.slice();
  f.ctx.player.currentVehicleId = v.id; v.occupied = true; v.state = 'driving'; v.speed = 2;
  f.ctx.player.arrestTimer = 1;
  f.police.reset();
  assert.equal(v.state, 'driving'); assert.equal(v.speed, 2); assert.equal(n.kind, 'cop');
  assert.equal(f.police.playerVisible, false); assert.equal(f.police.searchArea, null);
  assert.equal(f.police.nearestPoliceDist, Infinity); assert.equal(f.police.unseenTimer, 0);
  assert.equal(f.ctx.player.arrestTimer, 0); assert.equal(f.police.tracers.length, 0);
  assert.ok(f.police.cops.every((c) => !c.armed && c.fireFlash === 0));
  units.forEach((u, i) => assert.equal(f.police.units[i], u));
  cops.forEach((c, i) => assert.equal(f.police.cops[i], c));
  for (const p of before) { near(p.n.x, p.x); near(p.n.y, p.y); }
  f.ctx.wanted.clear(f.ctx.player);
  f.police.update(0.05, f.ctx);
  assert.equal(v.state, 'driving'); assert.equal(v.speed, 2);
});

test('repeated reports, deaths and resets keep fleet slots/IDs stable without touching civilians', () => {
  const f = fixture(stationMap(), 0);
  const civilian = createNPC(1, 'c', 24, 28), parked = car(1, 24, 35);
  f.ctx.npcs.push(civilian); f.ctx.vehicles.push(parked);
  const npcs = f.ctx.npcs.slice(), vehicles = f.ctx.vehicles.slice();
  const units = f.police.units.slice(), cops = f.police.cops.slice();
  const ids = npcs.map((n) => n.id), vehicleIds = vehicles.map((v) => v.id);
  const homes = units.map((u) => ({ ...u.home }));
  const civilianBefore = JSON.stringify(civilian), parkedBefore = JSON.stringify(parked);
  Object.assign(f.ctx.player, { x: 70, y: 70 });
  for (let round = 0; round < 40; round++) {
    f.ctx.wanted.raise(f.ctx.player, 5);
    f.police.report({ x: 40, y: 31.5 });
    tick(f, 0.2);
    for (const n of npcs) if (n !== civilian) { n.dead = true; n.state = 'dead'; n.health = 0; }
    for (const v of vehicles) if (v !== parked) { v.state = 'destroyed'; v.health = 0; }
    f.police.reset(); f.police.init(f.ctx);
    assert.equal(f.ctx.npcs.length, npcs.length); assert.equal(f.ctx.vehicles.length, vehicles.length);
    npcs.forEach((n, i) => assert.equal(f.ctx.npcs[i], n));
    vehicles.forEach((v, i) => assert.equal(f.ctx.vehicles[i], v));
    units.forEach((u, i) => assert.equal(f.police.units[i], u));
    cops.forEach((c, i) => assert.equal(f.police.cops[i], c));
    assert.deepEqual(f.ctx.npcs.map((n) => n.id), ids);
    assert.deepEqual(f.ctx.vehicles.map((v) => v.id), vehicleIds);
    assert.deepEqual(units.map((u) => u.home), homes);
  }
  assert.equal(JSON.stringify(civilian), civilianBefore); assert.equal(JSON.stringify(parked), parkedBefore);
  assert.equal(new Set(ids).size, npcs.length); assert.equal(new Set(vehicleIds).size, vehicles.length);
});

test('zero/invalid dt freezes police movement, fire, dispatch and arrest timers', () => {
  const f = fixture();
  cop(f, 28, 29.5);
  tick(f, 0.9);
  const snapshot = () => JSON.stringify([f.police.units, f.police.cops, f.police.searchArea,
    f.police.tracers, f.ctx.player, f.ctx.npcs, f.ctx.vehicles, f.events]);
  const before = snapshot();
  for (const dt of [0, -1, NaN, Infinity]) f.police.update(dt, f.ctx);
  assert.equal(snapshot(), before);
});

test('wanted decay uses visibility, renews sight grace, clamps fractional stars to zero', () => {
  const p = createPlayer(0, 0), w = new WantedSystem();
  assert.equal(GAME_CONFIG.WANTED_DECAY_S, 14);
  w.raise(p, 1.2);
  w.update(GAME_CONFIG.WANTED_DECAY_S - 1, p, false);
  w.update(10, p, true);
  w.update(2, p, false); near(p.wantedLevel, 1.2);
  w.update(GAME_CONFIG.WANTED_DECAY_S, p, false); near(p.wantedLevel, 0.2);
  w.update(GAME_CONFIG.WANTED_DECAY_S, p, false); assert.equal(p.wantedLevel, 0);
  w.raise(p, 0.25); w.update(NaN, p, false); near(p.wantedLevel, 0.25);
  w.update(GAME_CONFIG.WANTED_DECAY_S, p, false); assert.equal(p.wantedLevel, 0);
});

test('brief sightings pause decay without erasing progress or accumulating sight grace', () => {
  const p = createPlayer(0, 0), w = new WantedSystem();
  w.raise(p, 2);
  w.update(12, p, false);
  w.update(1.25, p, true);
  near(w.decayTimer, 2);
  for (let i = 0; i < 4; i++) {
    w.update(0.5, p, false);
    w.update(1, p, true);
  }
  assert.equal(p.wantedLevel, 1, 'short separated sightings must not keep stars forever');
});

test('only 1.5s of continuous sight renews the full wanted countdown', () => {
  const p = createPlayer(0, 0), w = new WantedSystem();
  w.raise(p, 2);
  w.update(13, p, false);
  for (let i = 0; i < 5; i++) w.update(0.25, p, true);
  near(w.decayTimer, 1);
  w.update(0.25, p, true);
  near(w.decayTimer, 14);
  w.update(13, p, false);
  assert.equal(p.wantedLevel, 2);
  w.update(1, p, false);
  assert.equal(p.wantedLevel, 1);
});

test('raise zero is not a crime and does not refresh an existing countdown', () => {
  const p = createPlayer(0, 0), w = new WantedSystem();
  w.raise(p, 0); w.raise(p);
  assert.equal(p.wantedLevel, 0);
  w.raise(p, 2);
  w.update(13.5, p, false);
  w.raise(p, 0); w.raise(p); w.raise(p, NaN); w.raise(p, Infinity);
  near(w.decayTimer, 0.5);
  w.update(0.5, p, false);
  assert.equal(p.wantedLevel, 1);
});

test('every positive crime resets the full countdown even at maximum stars', () => {
  for (const level of [1, GAME_CONFIG.WANTED_MAX]) {
    const p = createPlayer(0, 0), w = new WantedSystem();
    w.raise(p, level);
    w.update(13, p, false);
    w.raise(p, 0.25);
    const expected = Math.min(GAME_CONFIG.WANTED_MAX, level + 0.25);
    near(p.wantedLevel, expected);
    w.update(13, p, false);
    near(p.wantedLevel, expected);
    w.update(1, p, false);
    near(p.wantedLevel, expected - 1);
  }
});

test('clear removes accumulated sight grace and restores the wanted countdown', () => {
  const p = createPlayer(0, 0), w = new WantedSystem();
  w.raise(p, 2);
  w.update(13, p, false);
  w.update(1.25, p, true);
  w.clear(p);
  assert.equal(p.wantedLevel, 0);
  near(w.sightTimer, 0); near(w.decayTimer, 14);
  w.raise(p, 1);
  w.update(0.25, p, true);
  near(w.sightTimer, 0.25);
  w.update(14, p, false);
  assert.equal(p.wantedLevel, 0);
});

test('concealed player loses a star every 14s despite nearby police searching the old report', () => {
  const f = fixture();
  cop(f, 28, 29.5); unit(f, 22, 31.5);
  f.police.update(0.25, f.ctx);
  assert.equal(f.police.playerVisible, true);
  f.ctx.wanted.update(0.25, f.ctx.player, f.police.playerVisible);
  f.ctx.concealed = true;
  for (const key of ['x', 'y']) Object.defineProperty(f.ctx.player, key, { get() { throw new Error('hidden position read'); } });
  for (let frame = 1; frame <= 112; frame++) {
    f.police.update(0.25, f.ctx);
    f.ctx.wanted.update(0.25, f.ctx.player, f.police.playerVisible);
    assert.equal(f.police.playerVisible, false);
    assert.ok(f.police.searchArea, 'retain report until all stars decay');
    near(f.police.searchArea.x, 24); near(f.police.searchArea.y, 29.5);
    assert.equal(f.ctx.player.wantedLevel, 2 - Math.floor(frame / 56));
  }
  assert.ok(f.police.active, 'searching officers do not prevent decay');
  f.police.update(0.25, f.ctx);
  assert.equal(f.police.searchArea, null);
  assert.equal(f.police.active, false);
  near(f.police.unseenTimer, 0);
});

test('one signal per junction, deterministic phases, yellow/all-red and exclusive walk', () => {
  const map = crossMap();
  const a = new TrafficSignalSystem(), b = new TrafficSignalSystem();
  a.init(map); b.init(map);
  assert.equal(a.signals.length, 1);
  assert.equal(a.at(30.5, 30.5), a.at(31.5, 31.5));
  const phases = new Set();
  for (let i = 0; i < 540; i++) {
    // Dois eixos pedidos: é a demanda que faz o ciclo completo rodar, não o relógio sozinho.
    a.request(a.signals[0], 'SW'); a.pedestrianWaiting(a.signals[0]);
    b.request(b.signals[0], 'SW'); b.pedestrianWaiting(b.signals[0]);
    a.update(map, 0.1); b.update(map, 0.04); b.update(map, 0.06);
    const x = a.signals[0], y = b.signals[0];
    assert.equal(x.phase, y.phase); near(x.remaining, y.remaining, 1e-6);
    assert.ok(!(x.xLight !== 'red' && x.yLight !== 'red'));
    if (x.pedestrians) { assert.equal(x.xLight, 'red'); assert.equal(x.yLight, 'red'); }
    phases.add(x.phase);
  }
  assert.deepEqual([...phases].sort(), ['clearance', 'walk', 'x-green', 'x-yellow', 'y-green', 'y-yellow'].sort());
});

test('an unrequested cross axis is skipped instead of stopping a full red for nobody', () => {
  const map = crossMap();
  const timeToCrossGreen = (demand) => {
    const s = new TrafficSignalSystem();
    s.init(map);
    for (let i = 0; i < 600; i++) {
      if (demand) s.request(s.signals[0], 'SW');
      s.update(map, 0.1);
      if (s.signals[0].yLight === 'green') return i * 0.1;
    }
    return Infinity;
  };
  const asked = timeToCrossGreen(true);
  const empty = timeToCrossGreen(false);
  assert.ok(asked < 13, `eixo cruzado pedido abriu só em ${asked}s`);
  // Dois ciclos encurtados e o terceiro roda inteiro: quem espera num cruzamento vazio
  // não fica sem passagem para sempre.
  assert.ok(empty > asked && empty < 26, `cruzamento vazio abriu em ${empty}s`);
});

test('walk phase only appears when a pedestrian actually waits', () => {
  const probe = (pedestrian) => {
    const map = crossMap(), s = new TrafficSignalSystem();
    s.init(map);
    let crossed = 0, allRed = 0;
    for (let i = 0; i < 1200; i++) {
      // Carros no eixo cruzado mantêm o ciclo completo rodando; o pedestre é o único
      // pedido que pode abrir a fase de travessia.
      s.request(s.signals[0], 'SW');
      if (pedestrian) s.pedestrianWaiting(s.signals[0]);
      s.update(map, 0.05);
      if (s.signals[0].pedestrians) {
        crossed++;
        if (s.signals[0].xLight === 'red' && s.signals[0].yLight === 'red') allRed++;
      }
    }
    return { crossed, allRed };
  };
  assert.equal(probe(false).crossed, 0);
  const waiting = probe(true);
  assert.ok(waiting.crossed > 0 && waiting.crossed < 600, `faixa no tempo errado: ${waiting.crossed}`);
  assert.equal(waiting.allRed, waiting.crossed);
});

test('traffic holds outside red stop line, resumes green without random route waits', () => {
  const map = crossMap(), t = new TrafficSystem(new CollisionSystem());
  t.signalSystem.init(map);
  // Sem ninguém pedindo o eixo cruzado o ciclo encurta direto para o verde, então o
  // vermelho deste cenário precisa da demanda de um fluxo y, como numa fila real.
  driveSignal(t, map, (s) => s.xLight === 'red' && s.remaining >= 6);
  assert.equal(t.signals[0].xLight, 'red');
  const v = car(1, 27.5), p = createPlayer(28, 29);
  v.speed = 2;
  trafficActor(t, v, line(27.5, 45.5));
  for (let i = 0; i < 50; i++) {
    t.update(map, [], [v], 0.1, p);
    assert.ok(v.x < 30 - 0.24, `red violation at ${v.x}`);
  }
  const stopped = v.x;
  // A demanda do teste evapora quando o carro para: o vermelho dura o resto do verde
  // cruzado, o amarelo e vai embora — sem pedestre, a travessia nem aparece.
  for (let i = 0; i < 150; i++) t.update(map, [], [v], 0.1, p);
  assert.ok(v.x > stopped + 2, `never resumed: ${v.x}`);
});

test('committed vehicles clear a junction after the phase turns red', () => {
  const map = crossMap(), t = new TrafficSystem(new CollisionSystem());
  t.signalSystem.init(map);
  const v = car(1, 30.5), p = createPlayer(30, 29);
  trafficActor(t, v, line(30.5, 39.5));
  for (let i = 0; i < 25; i++) t.update(map, [], [v], 0.1, p);
  assert.ok(v.x > 32.5);
});

test('green releases a queue without same-lane junction occupants blocking followers', () => {
  const map = crossMap(), t = new TrafficSystem(new CollisionSystem()), p = createPlayer(20, 29);
  t.signalSystem.init(map);
  const vehicles = [car(1, 27.5), car(2, 25.8), car(3, 24.1)];
  for (const v of vehicles) trafficActor(t, v, line(v.x, 49.5));
  for (let i = 0; i < 280; i++) {
    t.update(map, [], vehicles, 0.05, p);
    for (let j = 1; j < vehicles.length; j++) assert.ok(vehicles[j - 1].x - vehicles[j].x >= 1.05 - 1e-6);
  }
  assert.ok(vehicles.every((v) => v.x > 32.5), `queue did not clear: ${vehicles.map((v) => v.x)}`);
});

test('keep-clear checks the exit lane, including turns, not adjacent or moving cars', () => {
  const map = crossMap(), t = new TrafficSystem(new CollisionSystem());
  t.signalSystem.init(map); t.signalSystem.update(map, 6.1);
  assert.equal(t.signals[0].xLight, 'green');
  const v = car(1, 27.5), blocker = car(2, 33);
  const actor = trafficActor(t, v, line(27.5, 45.5));
  assert.ok(Number.isFinite(signalStop(t, actor, map, [v, blocker])));
  blocker.y = 30.5;
  assert.equal(signalStop(t, actor, map, [v, blocker]), Infinity);
  blocker.y = 31.5; blocker.speed = 1;
  assert.equal(signalStop(t, actor, map, [v, blocker]), Infinity);
  blocker.speed = 0; blocker.x = 30.5; blocker.y = 33;
  actor.route = [...line(27.5, 30.5), { x: 30.5, y: 32.5 }, { x: 30.5, y: 33.5 }];
  assert.ok(Number.isFinite(signalStop(t, actor, map, [v, blocker])), 'blocked turning exit was ignored');
});

test('junction waits never shrink physical headway to escape a blockage', () => {
  const map = crossMap(), t = new TrafficSystem(new CollisionSystem()), p = createPlayer(20, 29);
  const v = car(1, 30.5), blocker = car(2, 31.9);
  trafficActor(t, v, line(30.5, 45.5));
  for (let i = 0; i < 200; i++) {
    t.update(map, [], [v, blocker], 0.05, p);
    assert.ok(blocker.x - v.x >= 1.05 - 1e-6, 'stalled car overlapped the blocker');
  }
  blocker.x = 40;
  for (let i = 0; i < 60; i++) t.update(map, [], [v, blocker], 0.05, p);
  assert.ok(v.x > 33, 'car did not leave after obstruction cleared');
});

test('crossing traffic clears before a green approach enters', () => {
  const map = crossMap(), t = new TrafficSystem(new CollisionSystem()), p = createPlayer(20, 29);
  t.signalSystem.init(map); t.signalSystem.update(map, 6.1);
  const v = car(1, 27.5), crossing = car(2, 30.5, 30.5, 'SW');
  const actor = trafficActor(t, v, line(27.5, 45.5));
  assert.ok(Number.isFinite(signalStop(t, actor, map, [v, crossing])));
  crossing.y = 35;
  assert.equal(signalStop(t, actor, map, [v, crossing]), Infinity);
  for (let i = 0; i < 100; i++) t.update(map, [], [v, crossing], 0.05, p);
  assert.ok(v.x > 32);
});

test('turning occupant yields to an approaching car without a circular signal wait', () => {
  for (const reverse of [false, true]) {
    const map = crossMap(), t = new TrafficSystem(new CollisionSystem()), p = createPlayer(20, 20);
    t.signalSystem.init(map); driveSignal(t, map, (s) => s.yLight === 'green' && s.remaining >= 7);
    const approach = car(1, 30.5, 29.95, 'SW'), turning = car(2, 31.56, 30.5, 'NW');
    const vehicles = reverse ? [turning, approach] : [approach, turning];
    for (const v of vehicles) {
      const end = v === approach ? { x: 30.5, y: 45.5 } : { x: 15.5, y: 30.5 };
      trafficActor(t, v, map.findRoadPath(v.x, v.y, end.x, end.y));
    }
    for (let frame = 0; frame < 100; frame++) {
      t.update(map, [], vehicles, 0.05, p);
      assert.ok(Math.hypot(approach.x - turning.x, approach.y - turning.y) >= GAME_CONFIG.VEHICLE_RADIUS * 2);
    }
    assert.ok(approach.y > 33 && turning.x < 29, 'yielding cars waited on each other');
  }
});

test('lane-aware headway includes parked/player cars, not the adjacent lane', () => {
  const map = crossMap(), p = createPlayer(10, 29);
  for (const adjacent of [false, true]) {
    const t = new TrafficSystem(new CollisionSystem());
    const v = car(1, 5.5), blocker = car(2, 9.5, adjacent ? 30.5 : 31.5, adjacent ? 'NW' : 'SE');
    blocker.occupied = true;
    trafficActor(t, v, line(5.5, 25.5));
    for (let i = 0; i < 50; i++) {
      t.update(map, [], [v, blocker], 0.1, p);
      if (!adjacent) assert.ok(blocker.x - v.x >= 1.05 - 1e-8);
    }
    if (adjacent) assert.ok(v.x > 12);
    else assert.ok(v.speed < 0.1);
  }
});

test('large frames cannot tunnel across a red stop or a vehicle headway', () => {
  const map = crossMap(), p = createPlayer(28, 29), t = new TrafficSystem(new CollisionSystem());
  const v = car(1, 28.5), blocker = car(2, 29.8);
  v.speed = 20;
  trafficActor(t, v, line(28.5, 40.5));
  t.update(map, [], [v, blocker], 1, p);
  assert.ok(blocker.x - v.x >= 1.05 - 1e-8); assert.ok(v.x < 30);
});

test('pedestrians yield before entering either lane, retain route, then cross a safe gap', () => {
  const map = crossMap(), system = new NPCSystem(new CollisionSystem());
  const n = walk(1, 20.5, 29.5, { x: 20.5, y: 32.5 });
  const v = car(2, 24.5, 30.5, 'NW'); v.speed = 2;
  for (let i = 0; i < 10; i++) system.update(n, map, [v], 0.1, 20, 29, 0);
  near(n.y, 29.5); assert.equal(n.pathIndex, 0); assert.equal(n.state, 'walking');
  assert.equal(n.speed, 0);
  v.x = 15; // Passed, moving away: no permanent proximity stop.
  for (let i = 0; i < 22; i++) system.update(n, map, [v], 0.1, 20, 29, 0);
  assert.ok(n.y > 32, `did not cross: ${n.y}`);
});

test('uncontrolled driver/parked crossing times out rather than freezing forever', () => {
  const map = crossMap(), system = new NPCSystem(new CollisionSystem());
  const n = walk(1, 20.5, 29.5, { x: 20.5, y: 32.5 });
  const v = car(2, 20.5, 30.5); // Occupies the crossing, unlike a stopped car behind the line.
  for (let i = 0; i < 102; i++) system.update(n, map, [v], 0.1, 20, 29, 0);
  assert.equal(n.state, 'idle'); assert.equal(pedestrianCrossingIntent(n), undefined);
  assert.equal(n.path.length, 0); near(n.y, 29.5);
});

test('pedestrians obey walk phase but finish crossing when it changes', () => {
  const map = crossMap(), s = new TrafficSignalSystem(), system = new NPCSystem(new CollisionSystem());
  s.init(map);
  const n = walk(1, 29.5, 29.5, { x: 29.5, y: 32.5 });
  system.update(n, map, [], 0.1, 29, 29, 0, s);
  near(n.y, 29.5);
  while (!s.signals[0].pedestrians) s.update(map, 0.1);
  for (let i = 0; i < 6; i++) system.update(n, map, [], 0.1, 29, 29, 0, s);
  assert.ok(n.y >= 30);
  while (s.signals[0].pedestrians) s.update(map, 0.1);
  for (let i = 0; i < 20; i++) system.update(n, map, [], 0.1, 29, 29, 0, s);
  assert.ok(n.y > 32);
});

test('curb request gives pedestrians priority without car/pedestrian deadlock', () => {
  const map = crossMap(), t = new TrafficSystem(new CollisionSystem()), ns = new NPCSystem(new CollisionSystem());
  const p = createPlayer(20, 29), n = walk(1, 20.5, 29.5, { x: 20.5, y: 32.5 });
  const v = car(2, 16.5); v.speed = 1.6;
  trafficActor(t, v, line(16.5, 28.5));
  let yielded = false, crossed = false;
  for (let i = 0; i < 120; i++) {
    t.update(map, [n], [v], 0.05, p);
    ns.update(n, map, [v], 0.05, p.x, p.y, 0);
    if (pedestrianCrossingIntent(n)?.requested && v.speed < 0.2) yielded = true;
    if (n.y > 32) crossed = true;
    if (n.y > 30 && n.y < 32) assert.ok(Math.hypot(v.x - n.x, v.y - n.y) > 0.5);
  }
  assert.ok(yielded); assert.ok(crossed); assert.ok(v.x > 20.5, 'car did not resume');
});

test('NPCSystem never advances cop knockdown/pursuit or vehicle-driven civilians', () => {
  const map = crossMap(), ns = new NPCSystem(new CollisionSystem());
  const n = createNPC(1, 'a', 20, 29, 'cop'); n.state = 'knocked'; n.downTimer = 2;
  ns.update(n, map, [], 1, 21, 29, 5);
  assert.equal(n.downTimer, 2); assert.equal(n.state, 'knocked');
  const driver = walk(2, 20, 29, { x: 22, y: 29 }); driver.inVehicle = true;
  ns.update(driver, map, [], 1, 21, 29, 5); near(driver.x, 20);
});

test('traffic excludes officers and police vehicles from civilian activation', () => {
  const map = crossMap(), t = new TrafficSystem(new CollisionSystem());
  t.rng = () => 0; // Deterministic acceptance, not a replacement for route/movement logic.
  const n = createNPC(1, 'a', 20, 29, 'cop');
  const patrol = createVehicle(1, VEHICLE_DEFS.police, '', 20.5, 31.5, 'SE');
  assert.equal(t.tryActivateVehicle(map, patrol, [n]), false);
  const v = car(2, 20.5);
  // Exercise real activation and graph routing; only the random stream is seeded.
  t.rng = rng(91);
  let activated = false;
  for (let i = 0; i < 40 && !activated; i++) activated = t.tryActivateVehicle(map, v, [n]);
  assert.equal(activated, true);
  assert.equal(n.inVehicle, false);
  assert.equal(t.traffic[0].driver, null);
});

test('traffic driver follows car, theft releases driver and controller never overwrites player', () => {
  const map = crossMap(), t = new TrafficSystem(new CollisionSystem()), p = createPlayer(6, 31.5);
  const v = car(1, 5.5), n = createNPC(2, 'b', 0, 0);
  const tv = trafficActor(t, v, line(5.5, 25.5));
  tv.driver = n; n.inVehicle = true; n.vehicleId = v.id;
  t.update(map, [n], [v], 0.1, p);
  near(n.x, v.x); near(n.y, v.y);
  assert.equal(t.tryStealCar(p, [v], [n]), true);
  assert.equal(n.inVehicle, false); assert.equal(n.vehicleId, null); assert.equal(n.state, 'fleeing');
  v.x = 11; v.speed = 4;
  t.update(map, [n], [v], 0.1, p);
  near(v.x, 11); near(v.speed, 4);
});

test('junction turns follow the outgoing lanes instead of driving into opposing traffic', () => {
  const map = crossMap();
  const approaches = [{ x: 27.5, y: 31.5 }, { x: 34.5, y: 30.5 }, { x: 30.5, y: 27.5 }, { x: 31.5, y: 34.5 }];
  const exits = [{ x: 34.5, y: 31.5 }, { x: 27.5, y: 30.5 }, { x: 30.5, y: 34.5 }, { x: 31.5, y: 27.5 }];
  for (const from of approaches) for (const to of exits) {
    const route = map.findRoadPath(from.x, from.y, to.x, to.y);
    assert.ok(route.length > 2);
    for (let i = 1; i < route.length; i++) {
      const a = route[i - 1], b = route[i];
      if (!map.isIntersectionAt(a.x, a.y) || !map.isIntersectionAt(b.x, b.y)) continue;
      if (a.y === b.y) assert.equal(Math.sign(b.x - a.x), a.y === 30.5 ? -1 : 1, 'wrong-way horizontal junction edge');
      else assert.equal(Math.sign(b.y - a.y), a.x === 30.5 ? 1 : -1, 'wrong-way vertical junction edge');
    }
  }
});

test('opposing left turns clear without head-on deadlock in either update order', () => {
  for (const reverse of [false, true]) {
    const map = crossMap(), t = new TrafficSystem(new CollisionSystem()), p = createPlayer(20, 20);
    const a = car(1, 30.5, 27.5, 'SW'), b = car(2, 31.5, 34.5, 'NE');
    const vehicles = reverse ? [b, a] : [a, b];
    for (const v of vehicles) {
      const exit = v === a ? { x: 45.5, y: 31.5 } : { x: 15.5, y: 30.5 };
      trafficActor(t, v, map.findRoadPath(v.x, v.y, exit.x, exit.y));
    }
    for (let frame = 0; frame < 400; frame++) t.update(map, [], vehicles, 0.05, p);
    assert.ok(a.x > 33 && b.x < 29, `opposing turns stalled: ${JSON.stringify(vehicles.map(v => [v.x, v.y]))}`);
  }
});

test('caixa ocupada espera fora em vez de entrar no anel de quatro carros', () => {
  const map = crossMap(), t = new TrafficSystem(new CollisionSystem());
  t.signalSystem.init(map);
  // Semáforo aberto para o eixo x: a única razão para segurar aqui é a própria caixa ocupada.
  for (const s of t.signals) { s.xLight = 'green'; s.yLight = 'red'; s.pedestrians = false; }
  // Mesma faixa e mesmo eixo, para a regra de "tráfego cruzado na caixa" não disfarçar o teste.
  for (const [index, cell] of [{ x: 30.5, y: 31.5 }, { x: 31.5, y: 31.5 }].entries()) {
    const inbound = car(1, 26.5, 31.5, 'SE');
    const tv = trafficActor(t, inbound, line(26.5, 45.5, 31.5));
    const occupant = car(2 + index, cell.x, cell.y, 'SE');
    occupant.speed = 0;
    t.syncGrids([inbound, occupant], []);
    const stop = t.signalStopDistance(tv, map);
    assert.ok(Number.isFinite(stop), `entrou na célula ${index} da caixa já ocupada`);
    assert.ok(stop < 4, `parou longe demais da fila: ${stop.toFixed(2)}`);
    t.traffic.length = 0;
  }
  const free = car(1, 26.5, 31.5, 'SE');
  const tv = trafficActor(t, free, line(26.5, 45.5, 31.5));
  t.syncGrids([free], []);
  assert.equal(t.signalStopDistance(tv, map), Infinity, 'cruzamento vazio não deve segurar ninguém');
});

test('empurrão de 0,1 tile perto do nó não vira o carro para o sentido contrário', () => {
  const map = crossMap(), t = new TrafficSystem(new CollisionSystem());
  // Desce a coluna x=30 (sentido +y) e a resolução de colisão o deixou em (30,6 ; 31,4):
  // a sobra até o nó (30,5 ; 31,5) é igual nos dois eixos. Olhar a sobra em vez do trecho
  // faria ele virar para oeste, de frente para o carro que vem atrás na mesma faixa.
  const turning = car(1, 30.6, 31.4, 'SW');
  const tv = trafficActor(t, turning, [{ x: 30.5, y: 29.5 }, { x: 30.5, y: 30.5 }, { x: 30.5, y: 31.5 },
    { x: 30.5, y: 32.5 }, { x: 30.5, y: 33.5 }, { x: 30.5, y: 34.5 }]);
  tv.routeIndex = 2;
  const through = car(2, 29.5, 31.5, 'SE');
  trafficActor(t, through, line(29.5, 45.5, 31.5));
  const vehicles = [turning, through], player = createPlayer(10, 10);
  t.update(map, [], vehicles, 0.05, player);
  assert.equal(turning.dir, 'SW', 'virou para o eixo da deriva em vez do eixo da rota');
  t.syncGrids(vehicles, []);
  const headOn = t.vehicleAhead(turning);
  assert.ok(!headOn || headOn.vehicle.id !== 2, 'encarou o carro que vem por trás como obstáculo');
  for (let frame = 0; frame < 800; frame++) t.update(map, [], vehicles, 0.05, player);
  assert.ok(turning.y > 32.4, `virou e congelou no cruzamento (y=${turning.y.toFixed(2)})`);
  assert.ok(through.x > 30.5, `bloqueado para sempre pelo carro que virou (x=${through.x.toFixed(2)})`);
});

test('carro empurrado para o lado da faixa ainda alcança os nós e faz a curva', () => {
  const map = crossMap(), t = new TrafficSystem(new CollisionSystem());
  t.signalSystem.init(map);
  for (const s of t.signals) { s.xLight = 'green'; s.yLight = 'green'; s.pedestrians = false; }
  // Desce a coluna x=30 e vira para leste na faixa y=31, mas a resolução de colisão o deixou
  // 0,3 tile para oeste do centro da faixa. Como o trânsito só anda em eixo, essa lateralidade
  // nunca se corrige sozinha: medir "cheguei ao nó" pela distância até o centro nunca chegaria a
  // menos de 0,3 de nenhum deles, e ele seguiria reto coluna abaixo, cruzamento após cruzamento,
  // até parar no mato sem rota e sem velocidade — congelado para sempre.
  const v = car(1, 30.2, 28.6, 'SW');
  trafficActor(t, v, [{ x: 30.5, y: 27.5 }, { x: 30.5, y: 28.5 }, { x: 30.5, y: 29.5 },
    { x: 30.5, y: 30.5 }, { x: 30.5, y: 31.5 }, { x: 31.5, y: 31.5 }, { x: 32.5, y: 31.5 },
    { x: 33.5, y: 31.5 }, { x: 34.5, y: 31.5 }, { x: 35.5, y: 31.5 }]);
  const player = createPlayer(5, 5);
  for (let frame = 0; frame < 600; frame++) t.update(map, [], [v], 0.05, player);
  assert.equal(v.dir, 'SE', `não fez a curva na faixa de leste (dir=${v.dir})`);
  assert.ok(v.y < 32, `desceu a coluna muito além do cruzamento (y=${v.y.toFixed(2)})`);
  assert.ok(v.x > 33, `não seguiu pela faixa de leste (x=${v.x.toFixed(2)})`);
});

test('destino da rota nunca é uma célula do próprio cruzamento', () => {
  const t = new TrafficSystem(new CollisionSystem());
  let geradas = 0;
  withRng(42, () => {
    const map = new WorldMap(generateCity(42));
    t.signalSystem.init(map);
    assert.ok(t.signals.length > 10);
    // O anel de quatro conversões só fecha quando um dos carros não tem para onde ir: com o
    // último nó dentro da caixa ele fica preso tentando encostar nele, parado no meio de tudo.
    for (let k = 0; k < map.roadNodes.length; k += 5) {
      const start = map.roadNodes[k];
      const route = t.generateRoute(map, start.x, start.y);
      if (route.length < 2) continue;
      geradas++;
      const last = route[route.length - 1];
      assert.ok(!t.signalSystem.at(last.x, last.y), `rota de (${start.x},${start.y}) termina em (${last.x},${last.y}), dentro da caixa`);
    }
  });
  assert.ok(geradas > 100, `rotas demais indecifráveis: ${geradas} geradas`);
});

for (const seed of [42, 20260909]) test(`generated city ${seed}: 15 minutes of traffic, pedestrians and stable entity counts`, () => withRng(seed, () => {
  const map = new WorldMap(generateCity(seed));
  const collision = new CollisionSystem(), t = new TrafficSystem(collision), ns = new NPCSystem(collision);
  const vehicles = map.data.vehicles.map((v, id) => createVehicle(id, VEHICLE_DEFS[v.defKey], v.color ?? '', v.x, v.y, v.dir));
  const npcs = map.data.npcSpawns.map((p, id) => createNPC(id, 'b', p.x, p.y));
  const p = createPlayer(map.data.playerSpawn.x, map.data.playerSpawn.y);
  t.init(map, vehicles, npcs);
  assert.ok(t.signals.length > 10); assert.ok(t.traffic.length > 10);
  for (const node of map.roadNodes) if (map.isIntersectionAt(node.x, node.y)) assert.ok(t.signalSystem.at(node.x, node.y));
  // Poste só existe onde a luz decide alguma coisa: dois fluxos cruzando no asfalto. Curva
  // sem eixo oposto e estrada de terra na reserva passam sem nada — e os cruzamentos sem
  // poste continuam no mapa, é neles que a preferência de passagem vale.
  const poles = t.signals.filter((s) => s.controlled);
  const giveWay = t.signals.filter((s) => !s.controlled && s.yields);
  const free = t.signals.filter((s) => !s.controlled && !s.yields);
  assert.ok(poles.length < t.signals.length, 'cruzamento sem fluxo cruzado ainda ganhou poste');
  assert.ok(poles.length > 10, 'semáforos urbanos sumiram junto com os postes');
  assert.ok(giveWay.length > 0, 'nenhum cruzamento ficou só com preferência de passagem');
  assert.equal(poles.length + giveWay.length + free.length, t.signals.length);
  // Na malha de terra os dois eixos têm braços iguais, então a vez tem que se dividir: se
  // todo cruzamento mandasse o mesmo eixo esperar, aquilo viraria um semáforo invisível.
  const yields = { x: 0, y: 0 };
  for (const s of giveWay) yields[s.yields]++;
  assert.ok(yields.x > 0 && yields.y > 0, `só um eixo cede a vez: ${JSON.stringify(yields)}`);
  assert.ok(yields.x * 2 >= yields.y && yields.y * 2 >= yields.x, `vez desequilibrada: ${JSON.stringify(yields)}`);
  const starts = t.traffic.map((tv) => ({ vehicle: tv.vehicle, x: tv.vehicle.x, y: tv.vehicle.y }));
  const count = vehicles.length;
  // Fila de semáforo não é travamento: o ciclo inteiro dura ~26s, então uma fileira atrás da
  // linha de parada passa um intervalo de 30s inteiro sem andar 2 tiles. O que não pode
  // acontecer é um carro ficar sem nenhum progresso em intervalos seguidos — isso é beco sem
  // saída (o anel de cruzamento, por exemplo, nunca se desfaz sozinho).
  let window = starts.map(({ vehicle, x, y }) => ({ vehicle, x, y, hold: 0 }));
  for (let frame = 0; frame < 18000; frame++) {
    t.update(map, npcs, vehicles, 0.05, p);
    for (const n of npcs) if (!n.inVehicle && Math.hypot(n.x - p.x, n.y - p.y) <= GAME_CONFIG.NPC_SIM_FAR) ns.update(n, map, vehicles, 0.05, p.x, p.y, 0, t.signalSystem);
    if ((frame + 1) % 600 === 0) {
      const stalledIds = new Set(window
        .filter(({ vehicle, x, y }) => Math.hypot(vehicle.x - x, vehicle.y - y) <= 2)
        .map(({ vehicle }) => vehicle.id));
      for (const entry of window) entry.hold = stalledIds.has(entry.vehicle.id) ? entry.hold + 1 : 0;
      const trapped = window.filter((entry) => entry.hold >= 3);
      const flowing = window.length - stalledIds.size;
      if (trapped.length || flowing <= window.length * 0.75) {
        t.syncGrids(vehicles, npcs);
        const coords = (actor) => actor.route.slice(actor.routeIndex, actor.routeIndex + 4)
          .map((n) => `[${n.x.toFixed(1)},${n.y.toFixed(1)}]`).join(' ');
        for (const entry of window.filter(({ vehicle }) => stalledIds.has(vehicle.id))) {
          const v = entry.vehicle;
          const actor = t.traffic.find((a) => a.vehicle === v), ahead = t.vehicleAhead(v);
          const signal = t.signalStopDistance(actor, map), pedestrian = t.pedestrianStopDistance(v, map, p);
          const alvo = actor.route[actor.routeIndex];
          const node = map.roadNodes[map.nearestRoadNode(v.x, v.y)];
          console.error(`  travado ${entry.hold}x id=${v.id} @(${v.x.toFixed(1)},${v.y.toFixed(1)}) dir=${v.dir} `
            + `piso=${map.tileKindAt(v.x, v.y)} no=${Math.hypot(node.x - v.x, node.y - v.y).toFixed(1)} `
            + `idx=${actor.routeIndex}/${actor.route.length} `
            + `ate=${alvo ? Math.hypot(alvo.x - v.x, alvo.y - v.y).toFixed(1) : 'fim'} `
            + `sinal=${Number.isFinite(signal) ? signal.toFixed(2) : '-'} pedestre=${Number.isFinite(pedestrian) ? pedestrian.toFixed(2) : '-'} `
            + `aFrente=${ahead ? `${ahead.vehicle.id}@${ahead.distance.toFixed(2)}/${ahead.vehicle.dir}` : 'ninguém'} rota=${coords(actor)}`);
        }
      }
      assert.deepEqual(trapped.map(({ vehicle }) => vehicle.id), [],
        `sem progresso por 90s aos ${(frame + 1) * 0.05}s: ${trapped.map(({ vehicle }) => vehicle.id).join(',')}`);
      window = window.map(({ vehicle, hold }) => ({ vehicle, x: vehicle.x, y: vehicle.y, hold }));
    }
  }
  const moved = starts.filter(({ vehicle, x, y }) => Math.hypot(vehicle.x - x, vehicle.y - y) > 2).length;
  assert.ok(moved > starts.length * 0.5, `only ${moved}/${starts.length} cars moved`);
  assert.equal(vehicles.length, count);
  for (const { vehicle: v } of starts) { assert.ok(Number.isFinite(v.x + v.y + v.speed)); assert.equal(map.isWaterWorld(v.x, v.y), false); }
}));

test('offscreen frozen pedestrian cannot indefinitely block traffic under NPC culling', () => {
  const map = crossMap(), t = new TrafficSystem(new CollisionSystem());
  const v = car(1, 10.5), n = walk(2, 13.5, 31.5, { x: 13.5, y: 32.5 });
  trafficActor(t, v, line(10.5, 25.5));
  const p = createPlayer(75, 75);
  for (let i = 0; i < 60; i++) t.update(map, [n], [v], 0.1, p);
  assert.ok(v.x > 16);
  near(n.y, 31.5); // Checker also respects the caller-owned NPC culling contract.
});

test('station allocation does not depend on a random ring around the player', () => {
  const locations = [];
  for (const seed of [1, 99]) {
    const f = fixture(crossMap(), 0);
    f.ctx.map = stationMap();
    f.ctx.rng = rng(seed);
    Object.assign(f.ctx.player, { x: seed === 1 ? 1 : 75, y: 70 });
    const police = new PoliceSystem();
    police.init(f.ctx);
    assert.equal(police.units.length, 8);
    locations.push(police.units.map((u) => ({ ...u.home })));
  }
  assert.deepEqual(locations[0], locations[1]);
});

test('red stop line leaves the crosswalk free for the pedestrian walk phase', () => {
  const map = crossMap(), t = new TrafficSystem(new CollisionSystem()), ns = new NPCSystem(new CollisionSystem());
  const v = car(1, 27.5), n = walk(2, 29.5, 29.5, { x: 29.5, y: 32.5 });
  const p = createPlayer(29, 29);
  v.speed = 2;
  trafficActor(t, v, line(27.5, 45.5));
  let crossed = false;
  for (let i = 0; i < 100; i++) {
    t.update(map, [n], [v], 0.05, p);
    ns.update(n, map, [v], 0.05, p.x, p.y, 0, t.signalSystem);
    crossed ||= n.y > 32;
    assert.ok(v.x < 29 - GAME_CONFIG.VEHICLE_RADIUS, 'red queue is occupying the stripe');
  }
  assert.ok(crossed, `pedestrian never crossed red traffic; final position ${n.y}`);
});

console.log(`Police/traffic checks: ${passed} passed, ${failed} failed`);
