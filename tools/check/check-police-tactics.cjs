// Run: node tools/check/check-police-tactics.cjs
// Tática de esquadrão: distância de tiro, giro lateral, capa na recarga, espaçamento e mira que gira.
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');
const source = (name) => path.join(root, 'src', name);
const program = ts.createProgram([source('systems/TacticsSystem.ts'), source('systems/PoliceSystem.ts')], {
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
const { TacticsSystem } = load('systems/TacticsSystem');
const { PoliceSystem } = load('systems/PoliceSystem');
const { CollisionSystem } = load('systems/CollisionSystem');
const { HealthSystem } = load('systems/HealthSystem');
const { WantedSystem } = load('systems/WantedSystem');
const { CoverSystem } = load('systems/CoverSystem');
const { canSee, fovHalf, inCone, sightRange, visionWedge } = load('systems/VisionSystem');
const { createMemory, observe } = load('systems/DetectionResponse');
const { Map: WorldMap } = load('world/Map');
const { createNPC } = load('entities/NPC');
const { createVehicle } = load('entities/Vehicle');
const { createPlayer } = load('entities/Player');
const { VEHICLE_DEFS } = load('data/vehicles');
const { GAME_CONFIG } = load('game/GameConfig');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('OK ' + name); }
  catch (error) { failed++; process.exitCode = 1; console.error('FAIL ' + name, error); }
}

/** Chão livre de 80x80 com uma avenida leste-oeste; obstáculos entram como colliders. */
function plainMap(buildings = [], colliders = []) {
  const W = 80;
  const tiles = Array.from({ length: W * W }, (_, i) => {
    const x = i % W, y = Math.floor(i / W);
    return { kind: y === 30 || y === 31 ? 'road' : 'concrete', key: '', lane: y === 30 ? 'NW' : y === 31 ? 'SE' : null };
  });
  return new WorldMap({ tilesW: W, tilesH: W, worldW: W, worldH: W, tiles, buildings,
    props: [], vehicles: [], npcSpawns: [], playerSpawn: { x: 24, y: 29.5 } }, colliders);
}
function context(map, rngValue = 0.5) {
  return { map, vehicles: [], npcs: [], collision: new CollisionSystem(), health: new HealthSystem(),
    wanted: new WantedSystem(), time: 0, rng: () => rngValue, player: createPlayer(30, 30.5) };
}
const OPTIONS = { standoff: 5, fireRange: 11, turnRate: 6.5, allies: [] };
const agent = (over = {}) => ({ id: 1, x: 24, y: 30.5, radius: GAME_CONFIG.NPC_RADIUS,
  armed: true, cooldown: 0, aimAngle: 0, ...over });
const target = (over = {}) => ({ x: 30, y: 30.5, visible: true, contactRange: GAME_CONFIG.ARREST_RANGE, ...over });
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

test('o agente armado mantém a distância de tiro em vez de colar no alvo', () => {
  const map = plainMap(); const ctx = context(map);
  const tactics = new TacticsSystem();
  const shot = tactics.order(0.05, agent({ x: 28.5, y: 30.5 }), target(), ctx, OPTIONS);
  assert.equal(shot.engaged, true);
  assert.equal(shot.intent, 'standoff');
  assert.ok(Math.abs(distance(shot.anchor, target()) - 5) < 0.4, `anchor a ${distance(shot.anchor, target())} tiles`);
  const far = tactics.order(0.05, agent({ x: 10, y: 30.5 }), target(), ctx, OPTIONS);
  assert.ok(distance(far.anchor, target()) < 20 && distance(far.anchor, target()) > 4, 'fecha a distância sem parar em cima');
  assert.equal(far.intent, 'standoff');
});

test('o alvo que encosta no policial é repelido para fora da faixa de engajamento', () => {
  const ctx = context(plainMap());
  const tactics = new TacticsSystem();
  const pin = tactics.order(0.05, agent({ x: 30.4, y: 30.5 }), target(), ctx, OPTIONS);
  assert.ok(distance(pin.anchor, target()) > 2.5, 'recua para reabrir espaço');
  assert.ok(pin.anchor.x > 30, 'o recuo é para o lado onde o policial já está');
});

test('a mira gira até o alvo e só então libera o tiro', () => {
  const ctx = context(plainMap());
  const tactics = new TacticsSystem();
  const turned = tactics.order(0.05, agent({ aimAngle: Math.PI }), target(), ctx, OPTIONS);
  assert.equal(turned.fire, false, 'não atira de costas');
  assert.ok(Math.abs(turned.aimAngle - Math.PI + 6.5 * 0.05) < 1e-9, 'gira a taxa pedida');
  let state = agent({ aimAngle: Math.PI });
  for (let i = 0; i < 40; i++) {
    const step = tactics.order(0.05, state, target(), ctx, OPTIONS);
    state = { ...state, aimAngle: step.aimAngle };
    if (i === 0) assert.equal(step.fire, false);
  }
  assert.equal(tactics.order(0.05, state, target(), ctx, OPTIONS).fire, true, 'assenta e atira');
  const outside = tactics.order(0.05, state, target({ x: 200, y: 30.5 }), ctx, OPTIONS);
  assert.equal(outside.fire, false, 'fora do alcance útil não puxa o gatilho');
});

test('depois do primeiro tiro o policial passa a girar em torno do alvo', () => {
  const ctx = context(plainMap());
  const tactics = new TacticsSystem();
  const state = agent({ x: 25, y: 30.5 });
  const before = tactics.order(0.05, state, target(), ctx, OPTIONS);
  assert.equal(before.intent, 'standoff');
  tactics.noteShot(state.id);
  const path = [];
  let anchor = before.anchor, lastIntent = '';
  for (let i = 0; i < 60; i++) {
    const step = tactics.order(0.05, { ...state, x: anchor.x, y: anchor.y }, target(), ctx, OPTIONS);
    lastIntent = step.intent;
    anchor = step.anchor;
    path.push({ x: anchor.x, y: anchor.y });
  }
  assert.equal(lastIntent, 'strafe');
  const drift = Math.abs(path[path.length - 1].y - 30.5);
  assert.ok(drift > 0.8, `o flanco não deslocou lateralmente (${drift})`);
  for (const point of path) assert.ok(Math.abs(distance(point, target()) - 5) < 0.3, 'o giro mantém o raio');
  const reversed = path.filter((p) => p.y < 30.5 - 0.05).length;
  assert.ok(reversed > 0 && reversed < path.length, 'troca de lado em vez de circundar sempre igual');
});

test('a pausa da recarga leva o policial para trás de uma capa real', () => {
  const wall = { x: 27, y: 28.6, width: 0.4, height: 2.4, type: 'BUILDING' };
  const ctx = context(plainMap([], [wall]));
  const tactics = new TacticsSystem();
  const hiding = tactics.order(0.05, agent({ cooldown: 1.2 }), target(), ctx, OPTIONS);
  assert.equal(hiding.intent, 'cover');
  assert.ok(distance(hiding.anchor, target()) < 6, 'a capa fica perto, não do outro lado do mapa');
  assert.ok(CoverSystem.firstHit({ ...hiding.anchor, z: 0.62 }, { x: 30, y: 30.5, z: 1.2 }, ctx),
    'a bala do alvo tem que esbarra no obstáculo');
  const popped = tactics.order(0.05, agent({ cooldown: 0.05, x: hiding.anchor.x, y: hiding.anchor.y }), target(), ctx, OPTIONS);
  assert.notEqual(popped.intent, 'cover', 'terminou a recarga, levanta e volta a engajar');
  assert.equal(popped.engaged, true);
});

test('cerca baixa também serve de capa porque o policial agacha para recarregar', () => {
  const fence = { x: 27, y: 29.2, width: 0.3, height: 1.2, type: 'FENCE' };
  const ctx = context(plainMap([], [fence]));
  const tactics = new TacticsSystem();
  const hiding = tactics.order(0.05, agent({ cooldown: 1.2 }), target(), ctx, OPTIONS);
  assert.equal(hiding.intent, 'cover');
  assert.ok(CoverSystem.firstHit({ ...hiding.anchor, z: 0.62 }, { x: 30, y: 30.5, z: 1.2 }, ctx));
  assert.ok(!CoverSystem.firstHit({ ...hiding.anchor, z: 1.55 }, { x: 30, y: 30.5, z: 1.45 }, ctx),
    'de pé por trás desta cerca ele segue visível: a capa é o agachar');
});

test('o esquadrão se espaça em vez de empilhar todos no mesmo ponto', () => {
  const ctx = context(plainMap());
  const tactics = new TacticsSystem();
  const mates = [{ x: 26, y: 30.5 }, { x: 26, y: 30.6 }, { x: 26, y: 30.7 }];
  const anchors = mates.map((mate, index) => tactics.order(0.05, agent({ id: index + 1, x: mate.x, y: mate.y }),
    target(), ctx, { ...OPTIONS, allies: mates.filter((_, other) => other !== index) })).map((o) => o.anchor);
  for (const pair of [[0, 1], [1, 2], [0, 2]]) {
    const [a, b] = pair;
    assert.ok(Math.hypot(anchors[a].x - anchors[b].x, anchors[a].y - anchors[b].y) > 0.8,
      `agentes ${a} e ${b} ficaram colados`);
  }
});

test('sem capa disponível o agente não inventa esconderijo', () => {
  const ctx = context(plainMap());
  const tactics = new TacticsSystem();
  const open = tactics.order(0.05, agent({ cooldown: 1.3 }), target(), ctx, OPTIONS);
  assert.notEqual(open.intent, 'cover');
  assert.equal(open.engaged, true);
});

test('alvo oculto: o agente avança para a última posição sem ler a posição real', () => {
  const ctx = context(plainMap());
  const tactics = new TacticsSystem();
  const hidden = { x: 24, y: 30.5, visible: false, contactRange: 1.35 };
  Object.defineProperty(hidden, 'secret', { get() { throw new Error('lê o alvo vivo'); } });
  const go = tactics.order(0.05, agent({ cooldown: 1.2 }), hidden, ctx, OPTIONS);
  assert.equal(go.intent, 'advance');
  assert.equal(go.fire, false);
  assert.deepEqual(go.anchor, { x: 24, y: 30.5 });
});

test('desarmado: um algema e o segundo abre leque em volta em vez de subir em cima do alvo', () => {
  const ctx = context(plainMap());
  const tactics = new TacticsSystem();
  const close = { x: 30.5, y: 30.5 };
  const mates = [close, { x: 33, y: 30.5 }];
  const first = tactics.order(0.05, agent({ id: 1, x: close.x, y: close.y, armed: false }), target(), ctx,
    { ...OPTIONS, allies: [mates[1]] });
  assert.equal(first.intent, 'press');
  assert.ok(distance(first.anchor, target()) < 1.2, 'vai ao alcance da algema');
  const second = tactics.order(0.05, agent({ id: 2, x: mates[1].x, y: mates[1].y, armed: false }), target(), ctx,
    { ...OPTIONS, allies: [close] });
  assert.equal(second.intent, 'standoff');
  assert.ok(distance(second.anchor, target()) > 2, 'o colega que chegou depois fica na lateral');
});

test('esquecer o agente devolve o estado para a patrulha seguinte', () => {
  const ctx = context(plainMap());
  const tactics = new TacticsSystem();
  tactics.order(0.05, agent(), target(), ctx, OPTIONS);
  tactics.noteShot(1);
  const orbiting = tactics.order(0.05, agent({ x: 25, y: 30.5 }), target(), ctx, OPTIONS).intent;
  assert.equal(orbiting, 'strafe');
  tactics.forget(1);
  assert.equal(tactics.order(0.05, agent({ x: 25, y: 30.5 }), target(), ctx, OPTIONS).intent, 'standoff');
  tactics.reset();
  assert.equal(tactics.order(0.05, agent({ x: 25, y: 30.5 }), target(), ctx, OPTIONS).intent, 'standoff');
});

// ---------- integração com o PoliceSystem ----------
const navigation = () => ({ route: [], routeIndex: 0, refreshTimer: 0, goal: null, sweep: 0, wait: 0 });
function scenario(level, map = plainMap(), count = 2) {
  let vehicleId = 100, npcId = 200;
  const events = { changes: 0, busted: 0 };
  const ctx = { map, player: createPlayer(30, 30.5), vehicles: [], npcs: [],
    collision: new CollisionSystem(), health: new HealthSystem(), wanted: new WantedSystem(), time: 0,
    allocVehicleId: () => vehicleId++, allocNpcId: () => npcId++, rng: () => 0.5,
    onStructChange: () => events.changes++, onBusted: () => events.busted++, shake() {} };
  const police = new PoliceSystem();
  police.init(ctx);
  ctx.wanted.raise(ctx.player, level);
  police.report({ x: ctx.player.x, y: ctx.player.y });
  const car = createVehicle(ctx.allocVehicleId(), VEHICLE_DEFS.police, '', 22, 30.5, 'SE');
  car.state = 'parked'; car.occupied = false;
  ctx.vehicles.push(car);
  const owner = { ...navigation(), vehicleId: car.id, crew: [], home: { x: 22, y: 30.5 }, tier: 1,
    mode: 'deployed', stuckTimer: 0, ramCooldown: 0 };
  police.units.push(owner);
  for (let seat = 0; seat < count; seat++) {
    const npc = createNPC(ctx.allocNpcId(), 'a', 22 + seat * 0.2, 30.5, 'cop', ctx.rng);
    npc.state = 'chasing';
    ctx.npcs.push(npc);
    owner.crew.push(npc.id);
    police.cops.push({ ...navigation(), npcId: npc.id, vehicleId: car.id, shotCooldown: 0.4,
      armed: false, fireFlash: 0, aimAngle: 0, detection: createMemory(), response: 'ignore' });
  }
  return { ctx, police, events, car };
}
function run(f, seconds, dt = 0.05) {
  const trail = [], shots = new Set();
  for (let t = 0; t < seconds - 1e-8; t += dt) {
    f.ctx.time += dt;
    f.police.update(dt, f.ctx);
    for (const tracer of f.police.tracers) shots.add(tracer.id);
    for (const cop of f.police.cops) {
      const npc = f.ctx.npcs.find((n) => n.id === cop.npcId);
      if (npc && !npc.inVehicle) trail.push({ id: cop.npcId, x: npc.x, y: npc.y, d: Math.hypot(npc.x - f.ctx.player.x, npc.y - f.ctx.player.y) });
    }
  }
  return { trail, shots: shots.size };
}

test('policial armado a pé para na faixa de tiro e continua atirando de lá', () => {
  const f = scenario(2);
  const { trail, shots } = run(f, 6);
  const live = trail.filter((p) => p.d < 40);
  const closest = Math.min(...live.map((p) => p.d));
  assert.ok(closest > 2.5, `colou no player a ${closest.toFixed(2)} tiles`);
  assert.ok(shots > 2, `trocou poucos tiros (${shots})`);
  assert.ok(f.ctx.player.health < 100, 'o tiroteio continua perigoso');
  const drift = live.filter((p) => p.id === live[0].id).map((p) => p.y);
  assert.ok(Math.max(...drift) - Math.min(...drift) > 0.5, 'não fica estatuado: reposiciona em volta');
});

test('dois policiais no mesmo tiroteio não ficam no mesmo ponto', () => {
  const f = scenario(2, plainMap(), 2);
  const { trail } = run(f, 6);
  const first = trail.filter((p) => p.id === trail[0].id);
  const second = trail.filter((p) => p.id !== trail[0].id);
  let smallest = Infinity;
  for (let i = 0; i < first.length; i++) smallest = Math.min(smallest, Math.hypot(first[i].x - second[i].x, first[i].y - second[i].y));
  assert.ok(smallest > 0.55, `esquadrão empilhado a ${smallest.toFixed(2)} tiles`);
});

test('nível 1: um policial algema o player parado e o outro espera na lateral', () => {
  const f = scenario(1, plainMap(), 2);
  const { trail, shots } = run(f, 10);
  assert.ok(f.events.busted > 0, 'a prisão em nível 1 continua acontecendo');
  assert.equal(shots, 0, 'nível 1 não atira');
  const last = trail.slice(-2);
  const positions = last.map((p) => p.d).sort((a, b) => a - b);
  assert.ok(positions[0] <= GAME_CONFIG.ARREST_RANGE, `ninguém algema (${positions[0].toFixed(2)})`);
  assert.ok(positions[1] > GAME_CONFIG.ARREST_RANGE * 1.5, 'o segundo fica na lateral');
  assert.equal(f.ctx.player.health, 100, 'nível 1 não leva dano');
});

console.log(`Tática policial: ${passed} passaram, ${failed} falharam`);
if (failed) process.exitCode = 1;
