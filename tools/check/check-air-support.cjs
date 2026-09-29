// Run: node tools/check/check-air-support.cjs
// Escalada por estrela: helicóptero policial que cerca a última posição, ilumina o alvo e desce equipe de corda.
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');
const source = (name) => path.join(root, 'src', name);
const program = ts.createProgram([source('systems/PoliceSystem.ts'), source('systems/AirSupportSystem.ts')], {
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
const { CollisionSystem } = load('systems/CollisionSystem');
const { HealthSystem } = load('systems/HealthSystem');
const { WantedSystem } = load('systems/WantedSystem');
const { Map: WorldMap } = load('world/Map');
const { createPlayer } = load('entities/Player');
const { GAME_CONFIG } = load('game/GameConfig');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('OK ' + name); }
  catch (error) { failed++; process.exitCode = 1; console.error('FAIL ' + name, error); }
}

/** Avenida leste-oeste e norte-sul num chão livre de 80x80; a delegacia fica no quadrante oeste. */
function crossMap(buildings = []) {
  const W = 80;
  const tiles = Array.from({ length: W * W }, (_, i) => {
    const x = i % W, y = Math.floor(i / W);
    const h = y === 30 || y === 31, v = x === 30 || x === 31;
    if (!h && !v) return { kind: 'concrete', key: '' };
    return { kind: 'road', key: '', lane: h && v ? null : h ? (y === 30 ? 'NW' : 'SE') : x === 30 ? 'SW' : 'NE' };
  });
  return new WorldMap({ tilesW: W, tilesH: W, worldW: W, worldH: W, tiles, buildings,
    props: [], vehicles: [], npcSpawns: [], playerSpawn: { x: 24, y: 29.5 } }, []);
}
const stationMap = () => crossMap([{ key: 'bld_policestation_test', x: 18, y: 27, footprintW: 3, footprintH: 4 }]);

function fixture(map = stationMap(), level = 5, rngValue = 0.5) {
  let vehicleId = 100, npcId = 200;
  const events = { changes: 0, busted: 0 };
  const ctx = { map, player: createPlayer(24, 29.5), vehicles: [], npcs: [],
    collision: new CollisionSystem(), health: new HealthSystem(), wanted: new WantedSystem(), time: 0,
    allocVehicleId: () => vehicleId++, allocNpcId: () => npcId++, rng: () => rngValue,
    onStructChange: () => events.changes++, onBusted: () => events.busted++, shake() {} };
  const police = new PoliceSystem();
  police.init(ctx);
  ctx.wanted.raise(ctx.player, level);
  if (level > 0) police.report({ x: ctx.player.x, y: ctx.player.y });
  return { ctx, police, events };
}
function tick(f, seconds, dt = 0.05) {
  for (let t = 0; t < seconds - 1e-8; t += dt) { f.ctx.time += dt; f.police.update(dt, f.ctx); }
}
const heliVehicles = (f) => f.ctx.vehicles.filter((v) => v.def.type === 'helicopter');
const airborne = (f) => f.police.cops.filter((cop) => cop.vehicleId === -1);

test('a caça só ganha asas a partir de quatro estrelas', () => {
  for (const level of [1, 2, 3]) {
    const f = fixture(stationMap(), level);
    tick(f, 20);
    assert.equal(heliVehicles(f).length, 0, `nível ${level} não pode ter helicóptero`);
    assert.equal(f.police.air.spotsPlayer, false);
  }
  const four = fixture(stationMap(), 4); tick(four, 8);
  assert.equal(heliVehicles(four).length, 1);
  const five = fixture(stationMap(), 5); tick(five, 8);
  assert.equal(heliVehicles(five).length, 2, 'nível 5 manda duas aeronaves');
});

test('sem delegacia no mapa não há aeronave nem equipe de corda', () => {
  const f = fixture(crossMap(), 5);
  assert.equal(f.police.units.length, 0);
  tick(f, 20);
  assert.equal(f.ctx.vehicles.length, 0); assert.equal(f.ctx.npcs.length, 0);
});

test('o aparelho paira alto, ciranda o último ponto conhecido e some quando a caça acaba', () => {
  const f = fixture(stationMap(), 4);
  tick(f, 12);
  const [heli] = f.police.air.helis;
  assert.ok(heli, 'aeronave deve existir');
  assert.ok(heli.altitude > GAME_CONFIG.POLICE_HELI_ALTITUDE * 0.9, `altitude ${heli.altitude}`);
  const distances = [];
  for (let i = 0; i < 200; i++) {
    tick(f, 0.05);
    distances.push(Math.hypot(heli.x - f.police.searchArea.x, heli.y - f.police.searchArea.y));
  }
  assert.ok(Math.max(...distances) > 1 && Math.min(...distances) < GAME_CONFIG.POLICE_HELI_SPOT_RANGE,
    'ciranda em volta do alvo em vez de cair em cima dele');
  const vehicle = heliVehicles(f)[0];
  f.ctx.wanted.clear(f.ctx.player);
  tick(f, 1);
  assert.equal(f.police.air.helis.length, 0); assert.equal(heliVehicles(f).length, 0);
  assert.equal(f.ctx.vehicles.includes(vehicle), false);
});

test('o holofote entrega o esconderijo: a delegacia passa a ver o player de cima', () => {
  const lit = fixture(stationMap(), 4);
  tick(lit, 10);
  const heli = lit.police.air.helis[0];
  Object.assign(lit.ctx.player, { x: heli.x, y: heli.y, health: 100 });
  lit.police.searchArea = { x: heli.x, y: heli.y, radius: 4, phase: 'search' };
  let seen = 0;
  tick(lit, 0.4); // aquece a varredura: o primeiro holofote pode demorar um ciclo
  for (let i = 0; i < 20; i++) {
    tick(lit, 0.05);
    const above = lit.police.air.helis[0] ?? heli;
    Object.assign(lit.ctx.player, { x: above.x, y: above.y, health: 100 });
    if (lit.police.playerVisible) seen++;
  }
  assert.equal(lit.police.air.spotsPlayer, true);
  assert.ok(seen >= 18, `o holofote piscou: viu o alvo em apenas ${seen}/20 quadros`);
  assert.equal(lit.police.searchArea.phase, 'pursuit');

  // Dentro de prédio o holofote não enxerga nada.
  const hidden = fixture(stationMap(), 4);
  tick(hidden, 10);
  const craft = hidden.police.air.helis[0];
  Object.assign(hidden.ctx.player, { x: craft.x, y: craft.y, health: 100 });
  hidden.ctx.concealed = true;
  tick(hidden, 0.5);
  assert.equal(hidden.police.air.spotsPlayer, false);
});

test('a equipe desce de corda no solo, arma-se e entra no tiroteio', () => {
  const f = fixture(stationMap(), 5);
  const before = f.ctx.npcs.length;
  tick(f, 24);
  const dropped = airborne(f);
  assert.ok(dropped.length > 0, `nenhum policial desceu em 24s (helicópteros: ${f.police.air.helis.length})`);
  assert.ok(f.ctx.npcs.length > before);
  for (const cop of dropped) {
    const npc = f.ctx.npcs.find((n) => n.id === cop.npcId);
    assert.ok(npc && !npc.inVehicle && npc.kind === 'cop');
    assert.ok(npc.x >= 0.2 && npc.x <= 79.8 && npc.y >= 0.2 && npc.y <= 79.8);
    assert.equal(cop.armed, true, 'a 4 estrelas a equipe de corda vem armada');
  }
  const shots = new Set();
  Object.assign(f.ctx.player, { x: f.police.air.helis[0].x, y: f.police.air.helis[0].y, health: 100 });
  for (let i = 0; i < 400; i++) { tick(f, 0.05); for (const t of f.police.tracers) shots.add(t.id); }
  assert.ok(shots.size > 0, 'a equipe desce para atirar');
  assert.equal(f.police.nearestPoliceDist < 20, true);
});

test('helicóptero no ar não colide com nada e não serve de capa', () => {
  const f = fixture(stationMap(), 4);
  tick(f, 10);
  const heli = heliVehicles(f)[0];
  const circle = { x: heli.x, y: heli.y, radius: 0.45 };
  const start = { x: circle.x, y: circle.y };
  f.ctx.collision.resolveCircleVsVehicles(circle, f.ctx.vehicles);
  assert.equal(circle.x, start.x); assert.equal(circle.y, start.y);
  tick(f, 6);
  for (const craft of heliVehicles(f)) {
    assert.ok(craft.altitude > 0.5, 'ainda em voo: nada no solo encosta nele');
  }
});

test('a hélice é audível de longe e silencia dentro de prédio', () => {
  const f = fixture(stationMap(), 4);
  tick(f, 10);
  const heli = f.police.air.helis[0];
  Object.assign(f.ctx.player, { x: heli.x, y: heli.y });
  audio.length = 0;
  tick(f, 1);
  assert.ok(audio.some(([key]) => key === 'heliRotor'), 'o rotor precisa ser ouvido');
  f.ctx.concealed = true;
  audio.length = 0;
  tick(f, 1);
  assert.equal(audio.some(([key]) => key === 'heliRotor'), false);
});

test('fora de caça a equipe de corda sai do mundo sem deixar registro', () => {
  const f = fixture(stationMap(), 5);
  tick(f, 24);
  assert.ok(airborne(f).length > 0, 'precisa ter equipe de corda para liberar');
  const fleet = f.police.units.filter((u) => u.vehicleId !== -1).slice();
  const groundCops = f.police.cops.filter((c) => c.vehicleId !== -1).slice();
  f.ctx.wanted.clear(f.ctx.player);
  tick(f, 1);
  assert.equal(airborne(f).length, 0);
  assert.equal(f.police.cops.length, groundCops.length);
  assert.equal(f.police.units.length, fleet.length);
  fleet.forEach((u, i) => assert.equal(f.police.units[i], u));
  assert.equal(f.police.cops.every((c) => c.vehicleId !== -1), true);
  assert.equal(heliVehicles(f).length, 0);
  assert.equal(f.ctx.npcs.every((n) => n.kind !== 'cop' || groundCops.some((c) => c.npcId === n.id)), true);
});

test('ciclos repetidos de caça aérea não incham a frota nem a população', () => {
  const f = fixture(stationMap(), 5);
  const npcs = f.ctx.npcs.length, units = f.police.units.length, cops = f.police.cops.length;
  for (let round = 0; round < 12; round++) {
    f.ctx.wanted.raise(f.ctx.player, 5);
    f.police.report({ x: 40, y: 31.5 });
    tick(f, 6);
    f.ctx.wanted.clear(f.ctx.player);
    tick(f, 0.5);
  }
  assert.equal(f.police.units.length, units, `${f.police.units.length} unidades`);
  assert.equal(f.police.cops.length, cops); assert.equal(f.ctx.npcs.length, npcs);
  assert.equal(f.ctx.vehicles.length <= 8, true, `${f.ctx.vehicles.length} veículos`);
  assert.equal(new Set(f.ctx.npcs.map((n) => n.id)).size, f.ctx.npcs.length);
});

console.log(`Apoio aéreo policial: ${passed} passaram, ${failed} falharam`);
if (failed) process.exitCode = 1;
