// Run: node tools/check/check-hazard.cjs. Tornado, furacão e tsunami: ciclo de vida, força e estrago.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('module');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');
const modules = new Map();

function load(filename) {
  if (!path.extname(filename)) filename += '.ts';
  if (modules.has(filename)) return modules.get(filename).exports;
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    fileName: filename, compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  });
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.require = (name) => (name.startsWith('.')
    ? load(path.resolve(path.dirname(filename), name))
    : require(name));
  modules.set(filename, mod);
  mod._compile(compiled.outputText, filename);
  return mod.exports;
}

const { GAME_CONFIG: C } = load(path.join(root, 'src/game/GameConfig.ts'));
const { HazardSystem } = load(path.join(root, 'src/systems/HazardSystem.ts'));
const { FogSystem } = load(path.join(root, 'src/systems/FogSystem.ts'));

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('OK ' + name); }
  catch (error) { failed++; console.error('FAIL ' + name + '\n' + error.stack); }
}
const fixed = (v) => () => v;
const DT = 0.1;

/** Chão sintético: água nas linhas 0..13, areia até 17, o resto é cidade. */
function terrain({ water = 14, sand = 4, w = 120, h = 120 } = {}) {
  return {
    worldW: w,
    worldH: h,
    biomeAt: (x, y) => {
      if (x < 0 || y < 0 || x >= w || y >= h) return null;
      const ty = Math.floor(y);
      if (ty < water) return 'sea';
      if (ty < water + sand) return 'beach';
      return 'residential';
    },
    isWaterWorld: (x, y) => y >= 0 && y < water && x >= 0 && x < w,
  };
}
const ctx = (over = {}) => ({
  indoors: false, season: 'verao', weather: 'storm', camera: { x: 60, y: 60 },
  terrain: terrain(), onAlert: () => {}, ...over,
});
const swept = (over = {}) => ({
  time: 10, indoors: false,
  player: { x: 60, y: 60, radius: C.PLAYER_RADIUS, currentVehicleId: null },
  npcs: [], vehicles: [], animals: [],
  health: { damage: () => true }, clamp: () => {}, shake: () => {}, onStructChange: () => {},
  ...over,
});
const run = (system, seconds, rng, context, extra = null) => {
  const ticks = Math.round(seconds / DT);
  for (let i = 0; i < ticks; i++) {
    system.update(DT, rng, context);
    if (extra) extra(system, i);
  }
};
/** Roda até o perigo nascer; devolve os segundos decorridos ou -1 se nada acordou. */
function wake(system, context, seconds = 400) {
  const ticks = Math.round(seconds / DT);
  for (let i = 0; i < ticks; i++) {
    system.update(DT, fixed(0.35), context);
    if (system.phase !== 'calm') return (i + 1) * DT;
  }
  return -1;
}
/** força() precisa do terreno já conhecido: um tique comum antes apresenta o mapa. */
const prime = (system, context) => system.update(DT, fixed(0.4), context);

test('nenhum perigo nasce em céu limpo, no frio ou dentro de casa', () => {
  const dry = terrain({ water: 0 });
  for (const [season, weather] of [['verao', 'clear'], ['inverno', 'storm'],
    ['outono', 'snow'], ['primavera', 'rain'], ['inverno', 'clear']]) {
    const h = new HazardSystem();
    assert.equal(wake(h, ctx({ season, weather, terrain: dry }), 900), -1,
      `${season}/${weather} acordou ${h.kind}`);
    assert.equal(h.alert, null);
    assert.equal(h.bed, null);
  }
  const indoors = new HazardSystem();
  assert.equal(wake(indoors, ctx({ indoors: true, weather: 'storm' }), 900), -1,
    'perigo dentro de casa');
});

test('o sorteio só aceita o que o clima e a estação permitem', () => {
  const dry = terrain({ water: 0 });
  for (const [kind, season, weather] of [['tornado', 'primavera', 'storm'], ['hurricane', 'outono', 'rain']]) {
    const h = new HazardSystem();
    assert.ok(wake(h, ctx({ season, weather, terrain: dry })) > 0, `${season}/${weather} não sorteou ${kind}`);
    assert.equal(h.kind, kind);
  }
  const winter = new HazardSystem();
  assert.ok(wake(winter, ctx({ season: 'inverno', weather: 'clear', camera: { x: 60, y: 20 } })) > 0,
    'a costa não fez tsunami');
  assert.equal(winter.kind, 'tsunami');
});

test('os pesos do sorteio dividem o mesmo dia entre os três perigos', () => {
  // Câmera na beira do mar: sem isso o tsunami nem entra no sorteio.
  const context = ctx({ camera: { x: 60, y: 20 } });
  for (const [roll, kind] of [[0.1, 'tornado'], [0.5, 'hurricane'], [0.9, 'tsunami']]) {
    const h = new HazardSystem();
    h.update(DT, fixed(roll), context);
    while (h.phase === 'calm') h.update(DT, fixed(roll), context);
    assert.equal(h.kind, kind, `rolagem ${roll} sorteou ${h.kind}`);
    assert.equal(h.phase, 'watch', 'o perigo nasceu já ativo');
  }
});

test('o aviso vem antes do perigo e o evento termina sozinho', () => {
  const heard = [];
  const h = new HazardSystem();
  const context = ctx({ onAlert: (kind) => heard.push(kind) });
  assert.ok(wake(h, context) > 0, 'nada nasceu');
  assert.equal(h.phase, 'watch');
  assert.ok(h.alert.startsWith('AVISO · '), `alerta ${h.alert}`);
  assert.deepEqual(heard, [h.kind], 'o aviso não bate com o perigo sorteado');
  run(h, C.HAZARD_WATCH_S + 7, fixed(0.999), context);
  assert.equal(h.phase, 'active', 'o aviso não virou perigo');
  assert.ok(h.alert.startsWith('PERIGO · '), `alerta ${h.alert}`);
  assert.ok(h.strength > 0.9, `força ${h.strength} no auge`);
  run(h, C.HAZARD_FADE_S + C.TORNADO_LIFE_S[1] + 2, fixed(0.999), context);
  assert.equal(h.phase, 'calm', 'o evento não acabou');
  assert.equal(h.kind, null);
  assert.equal(h.strength, 0);
  assert.equal(h.alert, null);
  assert.equal(h.bed, null);
  assert.equal(heard.length, 1, 'o aviso repetiu');
});

test('o intervalo entre eventos respeita o cooldown sorteado', () => {
  const h = new HazardSystem();
  const context = ctx({});
  prime(h, context);
  h.force('tornado', 0.2);
  run(h, C.HAZARD_FADE_S + 2, fixed(0.5), context);
  assert.equal(h.phase, 'calm');
  const wanted = C.HAZARD_COOLDOWN_S[0] + 0.5 * (C.HAZARD_COOLDOWN_S[1] - C.HAZARD_COOLDOWN_S[0]);
  assert.ok(h.cooldown <= wanted + 1e-9 && h.cooldown >= C.HAZARD_COOLDOWN_S[0] - 20,
    `cooldown ${h.cooldown} fora do intervalo configurado`);
  const before = h.kind;
  run(h, h.cooldown - 20, fixed(0.35), context);
  assert.equal(h.kind, before, 'o perigo voltou antes da hora');
});

test('o funil anda pelo mapa, cresce com a força e nunca sai do terreno', () => {
  const h = new HazardSystem();
  const context = ctx({});
  prime(h, context);
  h.force('tornado', 20);
  const start = { x: h.vortex.x, y: h.vortex.y };
  assert.ok(Math.hypot(start.x - 60, start.y - 60) >= 20, 'o funil nasceu em cima da câmera');
  const radii = [];
  let last = 0;
  // rng válida (0..1): o rumo passeia devagar, então o funil anda de verdade em vez de tremer no lugar.
  let seed = 7;
  // 22 s com vida de 20 s: persegue a câmera vivo e já começa a morrer sem sair do terreno.
  run(h, 22, () => { seed = (seed * 137) % 997; return seed / 997; }, context, (system) => {
    radii.push(system.vortex.radius);
    assert.ok(system.vortex.x > 3 && system.vortex.x < 117, `funil saiu em x=${system.vortex.x}`);
    assert.ok(system.vortex.y > 3 && system.vortex.y < 117, `funil saiu em y=${system.vortex.y}`);
    last = system.vortex.spin;
  });
  assert.ok(Math.hypot(h.vortex.x - start.x, h.vortex.y - start.y) > 4, 'o funil ficou plantado');
  assert.equal(h.phase, 'fading', 'o tornado não começou a morrer');
  assert.ok(Math.max(...radii) > Math.min(...radii), 'o raio não seguiu a força');
  assert.ok(last > 0, 'o funil não girou');
  assert.equal(h.bed, 'tornado');
  assert.ok(h.bedVolume > 0 && h.bedVolume <= 1, `volume do leito ${h.bedVolume}`);
  run(h, C.HAZARD_FADE_S + 2, fixed(0.9), context);
  assert.equal(h.bed, null);
  assert.equal(h.vortex.radius, 0);
});

test('a força do funil é circular, morre no alcance e fecha no núcleo', () => {
  const h = new HazardSystem();
  prime(h, ctx({}));
  h.force('tornado', 60);
  run(h, 2, fixed(0.5), ctx({}));
  const out = { fx: 0, fy: 0, core: false, near: false };
  const { x, y, radius } = h.vortex;
  assert.ok(radius > C.TORNADO_RADIUS[0], `raio ${radius} ainda pequeno`);
  h.forceAt(x + radius * C.TORNADO_REACH + 2, y, out);
  assert.equal(out.fx, 0);
  assert.equal(out.near, false, 'o vento alcançou longe demais');
  h.forceAt(x + radius * 0.5, y, out);
  const east = { fx: out.fx, fy: out.fy };
  assert.ok(east.fy !== 0, 'sem componente tangencial');
  assert.equal(out.core, true, 'meio raio não é núcleo');
  h.forceAt(x - radius * 0.5, y, out);
  assert.ok(Math.sign(out.fy) !== Math.sign(east.fy), 'o giro não é circular');
  h.forceAt(x + radius * 1.5, y, out);
  assert.equal(out.core, false, 'núcleo fora do raio');
  assert.equal(out.near, true);
});

test('a varredura empurra, arremessa, fere e resolve o choque com o cenário', () => {
  const h = new HazardSystem();
  const context = ctx({});
  prime(h, context);
  h.force('tornado', 60);
  run(h, 1, fixed(0.5), context);
  const core = { x: h.vortex.x + 0.3, y: h.vortex.y };
  const player = { x: core.x, y: core.y, radius: C.PLAYER_RADIUS, currentVehicleId: null };
  const npc = { ...core, radius: C.NPC_RADIUS, dead: false, inVehicle: false, state: 'walking',
    fleeTimer: 0, health: 100 };
  const fleeing = { x: h.vortex.x + C.TORNADO_RADIUS[1] * 1.6, y: h.vortex.y,
    radius: C.NPC_RADIUS, dead: false, inVehicle: false, state: 'idle', fleeTimer: 0, health: 100 };
  const animal = { x: h.vortex.x - 0.4, y: h.vortex.y, radius: 0.3, dead: false, state: 'idle',
    fleeTimer: 0, health: 65, speed: 0 };
  const before = { x: npc.x, y: npc.y };
  const hits = [];
  const shakes = [];
  let clamped = 0;
  let struct = 0;
  h.sweep(DT, swept({ player, npcs: [npc, fleeing], animals: [animal],
    health: { damage: (p, amount) => { hits.push([p, amount]); return true; } },
    clamp: () => { clamped++; },
    shake: (a) => shakes.push(a),
    onStructChange: () => { struct++; } }));
  assert.notDeepEqual({ x: npc.x, y: npc.y }, before, 'o pedestre no funil não se mexeu');
  assert.ok(npc.dead, 'o pedestre no núcleo sobreviveu');
  assert.equal(animal.dead, true, 'o animal no núcleo não morreu');
  assert.ok(struct > 0, 'a morte não avisou a cena');
  assert.equal(fleeing.dead, false, 'quem estava fora do núcleo morreu');
  assert.equal(fleeing.state, 'fleeing', 'quem viu o funil não correu');
  assert.ok(fleeing.fleeTimer > 0);
  assert.equal(hits.length, 1, `${hits.length} pedidos de dano para um jogador`);
  assert.equal(hits[0][0], player);
  assert.ok(hits[0][1] > 0 && hits[0][1] <= C.TORNADO_PLAYER_DMG_S, `dano por tique ${hits[0][1]}`);
  assert.ok(clamped >= 3, `${clamped} corpos passaram pela resolução de colisão`);
  assert.ok(shakes.length > 0 && shakes[0] > 0, 'sem tremor de câmera perto do funil');
});

test('quem dirige apanha junto com o carro, mas só o carro é empurrado', () => {
  const h = new HazardSystem();
  prime(h, ctx({}));
  h.force('tornado', 60);
  run(h, 1, fixed(0.5), ctx({}));
  const vehicle = { id: 3, x: h.vortex.x + 0.3, y: h.vortex.y, radius: C.VEHICLE_RADIUS,
    health: 100, state: 'parked', altitude: 0, speed: 0 };
  const heli = { id: 9, x: h.vortex.x, y: h.vortex.y - 0.2, radius: C.VEHICLE_RADIUS,
    health: 100, state: 'flying', altitude: 3, speed: 0 };
  const player = { x: vehicle.x, y: vehicle.y, radius: C.PLAYER_RADIUS, currentVehicleId: 3 };
  const clamped = [];
  const hits = [];
  h.sweep(DT, swept({ player, vehicles: [vehicle, heli],
    health: { damage: (p, amount) => { hits.push([p, amount]); return true; } },
    clamp: (body) => { clamped.push(body); } }));
  assert.ok(vehicle.x !== h.vortex.x + 0.3 || vehicle.y !== h.vortex.y, 'o carro não foi empurrado');
  assert.ok(vehicle.health < 100, 'o carro no funil não apanhou');
  assert.equal(heli.health, 100, 'helicóptero voando levou vento do chão');
  assert.ok(!clamped.includes(player), 'o motorista foi arrastado para fora do carro');
  assert.equal(player.x, vehicle.x, 'o motorista não foi junto com o carro');
  assert.equal(player.y, vehicle.y, 'o motorista ficou para trás');
  assert.ok(clamped.length > 0, 'nenhum veículo foi resolvido contra o cenário');
  assert.equal(hits.length, 1);
  assert.equal(hits[0][0], player, 'o motorista não apanhou junto com o carro');
});

test('furacão empurra tudo na mesma direção, molha, escurece e deita a chuva', () => {
  const h = new HazardSystem();
  prime(h, ctx({}));
  h.force('hurricane', 30);
  assert.equal(h.bed, null, 'o furacão abriu um segundo leito de clima');
  const npcs = Array.from({ length: 6 }, (_, i) => ({ x: 20 + i * 8, y: 30 + i * 5,
    radius: C.NPC_RADIUS, dead: false, inVehicle: false, state: 'walking', fleeTimer: 0, health: 100 }));
  const start = npcs.map((n) => ({ x: n.x, y: n.y }));
  const out = { fx: 0, fy: 0, core: false, near: false };
  h.forceAt(60, 60, out);
  assert.ok(out.fx !== 0 || out.fy !== 0, 'vento global sem força');
  assert.equal(out.near, true, 'o furacão só alcança um ponto');
  assert.equal(out.core, false, 'rajada comum matou alguém');
  for (let i = 0; i < 20; i++) h.sweep(DT, swept({ npcs }));
  npcs.forEach((n, i) => {
    const d = { x: n.x - start[i].x, y: n.y - start[i].y };
    assert.ok(Math.hypot(d.x, d.y) > 0.05, `pedestre ${i} não foi empurrado`);
    assert.ok(Math.abs(d.x) > 1e-6 || Math.abs(out.fx) < 1e-6, `pedestre ${i} saiu do vento`);
    assert.equal(n.state, 'walking', 'o furacão pôs o pedestre para correr');
    assert.equal(n.dead, false, 'vento comum matou quem não estava no núcleo');
  });
  assert.ok(h.wet > 0 && h.wet <= C.HURRICANE_WET + 1e-9, `umidade do furacão ${h.wet}`);
  assert.ok(h.dark > 0 && h.dark <= 1, `céu do furacão ${h.dark}`);
  assert.ok(h.slant !== 0 && Math.abs(h.slant) <= 1.5 + 1e-9, `inclinação ${h.slant}`);
  // A rajada oscila: o vento nunca é o mesmo dois tiques seguidos.
  const push = [];
  run(h, 12, fixed(0.5), ctx({}), (system) => {
    system.forceAt(60, 60, out);
    push.push(Math.hypot(out.fx, out.fy));
  });
  assert.ok(Math.max(...push) > Math.min(...push) * 1.05, 'o vento não variou');
});

test('o tsunami sobe da costa, para no limite e volta para o mar', () => {
  const noCoast = new HazardSystem();
  prime(noCoast, ctx({ terrain: terrain({ water: 0 }), season: 'inverno', weather: 'clear' }));
  assert.equal(wake(noCoast, ctx({ terrain: terrain({ water: 0 }), season: 'inverno', weather: 'clear' })), -1,
    'tsunami num mapa sem mar');

  const h = new HazardSystem();
  const context = ctx({});
  prime(h, context);
  h.force('tsunami', 20);
  assert.equal(h.bed, 'wave');
  assert.equal(h.wave.axis, 'y', 'a faixa de linhas não subiu em Y');
  assert.equal(h.wave.dir, 1, 'a onda não subiu do mar para dentro do mapa');
  assert.ok(h.wave.from >= 12 && h.wave.from <= 15, `origem fora da beira (${h.wave.from})`);
  assert.ok(h.wave.u1 - h.wave.u0 >= C.TSUNAMI_SPAN_TILES - 2, `trecho estreito ${h.wave.u1 - h.wave.u0}`);
  const out = { fx: 0, fy: 0, core: false, near: false };
  const middle = (h.wave.u0 + h.wave.u1) / 2;
  h.forceAt(middle, h.wave.from + 40, out);
  assert.equal(out.near, false, 'a onda alcançou a terra seca');
  let peak = 0;
  run(h, 6, fixed(0.5), context, (system) => {
    peak = Math.max(peak, system.wave.reach);
    assert.ok(system.wave.reach <= C.TSUNAMI_REACH_TILES + 1e-6, 'a onda passou do limite');
    assert.ok(system.wave.edge <= 120, 'a onda saiu do mapa');
  });
  assert.equal(h.phase, 'active');
  assert.ok(peak >= C.TSUNAMI_REACH_TILES - 0.5, `a onda só andou ${peak} tiles`);
  h.forceAt(middle, h.wave.edge, out);
  assert.equal(out.core, true, 'na crista não há parede de água');
  assert.ok(out.fy * h.wave.dir > 0, 'a onda não empurra para dentro da terra');
  h.forceAt(h.wave.u0 - 4, h.wave.edge, out);
  assert.equal(out.near, false, 'a onda varreu fora do trecho sorteado');
  run(h, C.TSUNAMI_LIFE_S[1] + C.HAZARD_FADE_S + 4, fixed(0.9), context);
  assert.equal(h.wave.reach, 0, 'a água não voltou para o mar');
  assert.equal(h.bed, null);
  assert.equal(h.phase, 'calm');
});

test('a água do tsunami é o corredor inteiro: atrás da crista se nada e se afoga', () => {
  const h = new HazardSystem();
  const context = ctx({});
  prime(h, context);
  h.force('tsunami', 20);
  const middle = (h.wave.u0 + h.wave.u1) / 2;
  // `d` são tiles contados do mar para dentro da terra, no sentido em que a onda corre.
  const at = (d, u = middle) => (h.wave.axis === 'y'
    ? { x: u, y: h.wave.from + h.wave.dir * d }
    : { x: h.wave.from + h.wave.dir * d, y: u });
  assert.equal(h.floodedAt(at(8).x, at(8).y), false, 'a onda nem subiu e a praia já está alagada');
  run(h, 2, fixed(0.5), context);
  assert.ok(h.wave.reach > 3, `a onda só andou ${h.wave.reach} tiles`);
  assert.equal(h.floodedAt(at(0).x, at(0).y), true, 'a beira alagada não contou como água');
  const deep = at(h.wave.reach / 2);
  assert.equal(h.floodedAt(deep.x, deep.y), true, 'o meio do corredor ficou de fora da água');
  const lip = at(h.wave.reach + 0.5);
  assert.equal(h.floodedAt(lip.x, lip.y), true, 'o lábio de espuma da frente não molha ninguém');
  const dry = at(h.wave.reach + 6);
  assert.equal(h.floodedAt(dry.x, dry.y), false, 'a terra seca à frente da crista alagou');
  const aside = at(h.wave.reach / 2, h.wave.u0 - 4);
  assert.equal(h.floodedAt(aside.x, aside.y), false, 'a onda alagou fora do trecho sorteado');

  const out = { fx: 0, fy: 0, core: false, near: false };
  h.forceAt(deep.x, deep.y, out);
  assert.equal(out.core, true, 'no fundo do corredor dá para ficar em pé seco');
  assert.ok((h.wave.axis === 'y' ? out.fy : out.fx) * h.wave.dir > 0, 'a corrente não empurra para dentro');

  // O jogador no meio da água: a cada tique a corrente o arrasta e a onda o afoga.
  let hurt = 0;
  const player = { x: deep.x, y: deep.y, radius: C.PLAYER_RADIUS, currentVehicleId: null };
  const start = h.wave.axis === 'y' ? player.y : player.x;
  for (let i = 0; i < 10; i++) {
    h.update(DT, fixed(0.5), context);
    h.sweep(DT, swept({ player, health: { damage: (p, amount) => { hurt += amount; return true; } } }));
  }
  assert.ok(hurt >= C.TSUNAMI_PLAYER_DMG_S * 0.9, `um segundo na onda custou só ${hurt} de vida`);
  assert.ok(((h.wave.axis === 'y' ? player.y : player.x) - start) * h.wave.dir > 0,
    'a corrente não levou o jogador');

  run(h, C.TSUNAMI_LIFE_S[1] + C.HAZARD_FADE_S + 4, fixed(0.9), context);
  assert.equal(h.floodedAt(deep.x, deep.y), false, 'a água voltou para o mar e ficou alagada');
});

test('tsunami só entra no sorteio com a câmera na beira do mar', () => {
  // O mar do mapa sintético são as linhas 0..13: a câmera padrão está a 47 tiles dele.
  const far = new HazardSystem();
  assert.equal(wake(far, ctx({ season: 'inverno', weather: 'clear' }), 900), -1,
    'a onda veio para quem nem vê a praia');
  const near = new HazardSystem();
  const beach = ctx({ season: 'inverno', weather: 'clear', camera: { x: 60, y: 20 } });
  assert.ok(wake(near, beach, 900) > 0, 'a praia não chamou a onda');
  assert.equal(near.kind, 'tsunami');
  assert.equal(near.wave.axis, 'y');
  assert.ok(Math.abs(near.wave.from - 20) <= C.TSUNAMI_NEAR_TILES, `onda longe da câmera (${near.wave.from})`);
  // Roteiro e QA mandam a onda entrar mesmo com a câmera no meio do mapa.
  const scripted = new HazardSystem();
  prime(scripted, ctx({}));
  scripted.force('tsunami', 20);
  assert.ok(scripted.wave.u1 > scripted.wave.u0, 'force() não abriu a onda');
});

test('mar lateral também é costa: a onda de leste entra em X', () => {
  const side = {
    worldW: 120,
    worldH: 120,
    biomeAt: (x, y) => (x < 0 || y < 0 || x >= 120 || y >= 120 ? null
      : x >= 106 ? 'sea' : x >= 102 ? 'beach' : 'residential'),
    isWaterWorld: (x, y) => x >= 106 && x < 120 && y >= 0 && y < 120,
  };
  const h = new HazardSystem();
  const context = ctx({ terrain: side, season: 'inverno', weather: 'clear', camera: { x: 96, y: 60 } });
  assert.ok(wake(h, context, 900) > 0, 'a praia de leste não chamou nada');
  assert.equal(h.kind, 'tsunami');
  assert.equal(h.phase, 'watch');
  run(h, C.HAZARD_WATCH_S + 2, fixed(0.5), context);
  assert.equal(h.wave.axis, 'x', 'a onda de leste não corre em X');
  assert.equal(h.wave.dir, -1, 'a onda não veio do mar para a terra');
  assert.ok(h.wave.from >= 105 && h.wave.from <= 107, `origem fora da beira (${h.wave.from})`);
  const out = { fx: 0, fy: 0, core: false, near: false };
  h.forceAt(h.wave.from - 4, (h.wave.u0 + h.wave.u1) / 2, out);
  assert.ok(out.fx * h.wave.dir > 0, 'a onda de leste não empurra para dentro da terra');
  assert.ok(Math.abs(out.fy) < Math.abs(out.fx), 'o empurrão lateral venceu a parede de água');
});

test('dentro de casa nada é empurrado e o perigo não machuca', () => {
  const h = new HazardSystem();
  prime(h, ctx({}));
  h.force('tornado', 30);
  run(h, 1, fixed(0.5), ctx({}));
  const npc = { x: h.vortex.x, y: h.vortex.y, radius: C.NPC_RADIUS, dead: false,
    inVehicle: false, state: 'walking', fleeTimer: 0, health: 100 };
  let damaged = 0;
  let shook = 0;
  const before = { x: npc.x, y: npc.y };
  h.sweep(DT, swept({ indoors: true, npcs: [npc],
    health: { damage: () => { damaged++; return true; } }, shake: () => { shook++; } }));
  assert.equal(damaged, 0);
  assert.equal(shook, 0);
  assert.equal(npc.dead, false);
  assert.deepEqual({ x: npc.x, y: npc.y }, before, 'o vento mexeu em quem está abrigado');
});

test('o mapa do jogo tem costa navegável para a onda', () => {
  const { generateCity } = load(path.join(root, 'src/data/maps/city.ts'));
  const { Map: CityMap } = load(path.join(root, 'src/world/Map.ts'));
  const map = new CityMap(generateCity());
  const h = new HazardSystem();
  const context = ctx({ terrain: map, camera: { x: map.data.playerSpawn.x, y: map.data.playerSpawn.y } });
  prime(h, context);
  h.force('tsunami', 20);
  assert.ok(h.wave.u1 > h.wave.u0, 'o litoral do mapa real não produziu onda');
  const limit = h.wave.axis === 'y' ? map.worldW : map.worldH;
  assert.ok(h.wave.u0 >= 0 && h.wave.u1 <= limit, 'a onda varre fora do mapa');
  const middle = (h.wave.u0 + h.wave.u1) / 2;
  // No mapa do jogo a onda pode subir tanto de norte/sul (Y) como de leste/oeste (X).
  const at = (u, a) => (h.wave.axis === 'y' ? { x: u, y: a } : { x: a, y: u });
  const born = at(middle, h.wave.from);
  assert.ok(map.isWaterWorld(born.x, born.y), `a onda nasceu em terra (${born.x}, ${born.y})`);
  run(h, 8, fixed(0.5), context);
  assert.ok(h.wave.reach > 2, 'a onda do mapa real não subiu a praia');
  const crest = at(middle, h.wave.from + h.wave.dir);
  assert.ok(map.biomeAt(crest.x, crest.y) !== null, 'a crista saiu do mapa');
});

test('a névoa fecha com o perigo mas a área de corte não se move', () => {
  const view = { camera: { x: 80, y: 80, zoom: C.ZOOM_DEFAULT }, viewW: 844, viewH: 390 };
  const settle = (environment) => {
    const f = new FogSystem();
    for (let i = 0; i < 400; i++) f.update(0.05, environment);
    return f;
  };
  const clear = settle({ timeOfDay: 0.5, rain: 0, biome: 'residential' });
  const gloom = settle({ timeOfDay: 0.5, rain: 0.8, cover: 0.85, dark: 0.2, biome: 'residential' });
  assert.deepEqual(gloom.view(view), clear.view(view), 'o perigo moveu a área de corte');
  assert.ok(gloom.snapshot.clarity < clear.snapshot.clarity, 'o perigo não fechou a visão');
  assert.ok(gloom.snapshot.clarity > 0.3, `visibilidade ${gloom.snapshot.clarity} fechou demais`);
});

test('dt inválido e rng maluco não travam nem explodem o ciclo', () => {
  const h = new HazardSystem();
  const snapshot = JSON.stringify([h.kind, h.phase, h.strength, h.wet, h.dark, h.slant]);
  for (const dt of [0, -1, NaN, Infinity]) h.update(dt, fixed(0.5), ctx({}));
  assert.equal(JSON.stringify([h.kind, h.phase, h.strength, h.wet, h.dark, h.slant]), snapshot);
  for (const rng of [() => NaN, () => -3, () => 1e9, () => 0.999999, Math.random]) {
    const wild = new HazardSystem();
    for (let i = 0; i < 4000; i++) {
      wild.update(0.1, rng, ctx({ season: i % 2 ? 'inverno' : 'verao', weather: i % 3 ? 'clear' : 'storm' }));
      wild.sweep(0.1, swept({}));
      assert.ok(Number.isFinite(wild.strength) && wild.strength >= 0 && wild.strength <= 1, 'força fora de 0..1');
      assert.ok(Number.isFinite(wild.wet) && Number.isFinite(wild.dark) && Math.abs(wild.slant) <= 1.5);
      assert.ok(wild.bedVolume >= 0 && wild.bedVolume <= 1, `leito ${wild.bedVolume}`);
      if (wild.kind === 'tornado') {
        assert.ok(Number.isFinite(wild.vortex.x) && Number.isFinite(wild.vortex.y));
        assert.ok(wild.vortex.radius >= 0 && wild.vortex.radius <= C.TORNADO_RADIUS[1] + 1e-6);
      }
      if (wild.kind === 'tsunami') {
        assert.ok(Number.isFinite(wild.wave.edge) && wild.wave.reach >= 0);
        assert.ok(wild.wave.reach <= C.TSUNAMI_REACH_TILES + 1e-6);
      }
    }
  }
});

console.log(`Hazard checks: ${passed} passed, ${failed} failed.`);
if (failed) { console.error('Failures may indicate implementation issues; assertions were not relaxed.'); process.exitCode = 1; }
