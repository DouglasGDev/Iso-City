// Oráculo do relevo 2.5D: roda nos fontes atuais, sem bundle nem dispositivo.
// O contrato que ele guarda é a razão de o jogo continuar isométrico: altura só move o
// eixo Y da projeção, nunca o X, e nada que o jogador, o NPC ou o carro pisam pode
// virar parede invisível.
const fs = require('fs');
const path = require('path');
const Module = require('module');
const ts = require('typescript');
const assert = require('assert');
const root = path.resolve(__dirname, '../..');
const modules = new Map();
const skia = {
  PaintStyle: { Stroke: 'stroke' },
  Skia: {
    Color: (color) => color,
    Paint: () => ({ setColor() {}, setStyle() {}, setStrokeWidth() {}, setAntiAlias() {} }),
    Path: { Make: () => ({ moveTo() {}, lineTo() {}, close() {} }) },
  },
};
function load(filename) {
  if (!path.extname(filename)) filename += '.ts';
  if (modules.has(filename)) return modules.get(filename).exports;
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    fileName: filename, compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  });
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.require = (name) => name === '@shopify/react-native-skia' ? skia
    : name.startsWith('.') ? load(path.resolve(path.dirname(filename), name)) : require(name);
  modules.set(filename, mod);
  mod._compile(compiled.outputText, filename);
  return mod.exports;
}

const { generateCity } = load(path.join(root, 'src/data/maps/city.ts'));
const { GAME_CONFIG } = load(path.join(root, 'src/game/GameConfig.ts'));
const { Map: CityMap } = load(path.join(root, 'src/world/Map.ts'));
const { ELEVATION_PX, worldToScreen, depthOf } = load(path.join(root, 'src/world/IsoUtils.ts'));
const { FogSystem, FOG } = load(path.join(root, 'src/systems/FogSystem.ts'));

const LEVEL = GAME_CONFIG.TERRAIN_LEVEL_TILES;
const MAX_H = GAME_CONFIG.TERRAIN_MAX_LEVEL * LEVEL;
const NATURAL = new Set(['forest', 'countryside', 'beach', 'pinewood', 'savanna', 'desert']);

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`OK ${name}`); }
  catch (error) { failed++; process.exitCode = 1; console.error(`FAIL ${name}`, error && error.message ? error.message : error); }
}
function check(condition, message) { assert.ok(condition, message); }

const cities = [20260909, 20260910, 42].map((seed) => ({ seed, city: generateCity(seed) }));
const stats = cities.map(({ seed, city }) => {
  const W = city.tilesW;
  const H = city.tilesH;
  let max = 0;
  let raised = 0;
  const levels = new Set();
  for (let i = 0; i < W * H; i++) {
    const h = city.heights[i];
    if (h > max) max = h;
    if (h > 0) raised++;
    levels.add(Math.round(h / LEVEL));
  }
  return { seed, W, H, max, raised, kinds: levels.size };
});

test('o campo de altura é quantizado, limitado e nunca levanta a água', () => {
  for (const { city } of cities) {
    const W = city.tilesW;
    const H = city.tilesH;
    check(city.heights instanceof Float32Array, 'heights precisa ser Float32Array (malha, não lista de objetos)');
    check(city.heights.length === W * H, 'heights indexada igual a tiles');
    for (let i = 0; i < W * H; i++) {
      const h = city.heights[i];
      check(Number.isFinite(h), `altura não finita no tile ${i}`);
      check(h >= 0 && h <= MAX_H + 1e-9, `tile ${i} fora do intervalo de relevo: ${h}`);
      check(Math.abs(h / LEVEL - Math.round(h / LEVEL)) < 1e-9, `tile ${i} não é um degrau inteiro: ${h}`);
      if (city.tiles[i].kind === 'water') check(h === 0, `água elevada no tile ${i}: o leito tem que ser o fundo do vale`);
    }
  }
});

test('o relevo existe:montanhas com crista e degraus suficientes para ler profundidade', () => {
  for (const s of stats) {
    check(s.kinds >= 8, `seed ${s.seed}: só ${s.kinds} alturas diferentes — sem terraços não há relevo`);
    check(s.raised / (s.W * s.H) > 0.02, `seed ${s.seed}: ${(s.raised / (s.W * s.H) * 100).toFixed(1)}% do mapa elevado é pouco`);
    check(s.max >= 6 * LEVEL, `seed ${s.seed}: crista máxima de ${s.max} tiles não é montanha`);
    console.log(`  seed ${s.seed}: crista ${(s.max * ELEVATION_PX).toFixed(0)}px, ${(s.raised / (s.W * s.H) * 100).toFixed(1)}% do chão elevado, ${s.kinds} degraus`);
  }
});

test('parede vertical só acontece dentro da reserva: a cidade não ganha muro invisível', () => {
  for (const { seed, city } of cities) {
    const W = city.tilesW;
    const H = city.tilesH;
    let cliffs = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const here = city.tiles[i];
        for (const [dx, dy] of [[1, 0], [0, 1]]) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= W || ny >= H) continue;
          const j = ny * W + nx;
          const there = city.tiles[j];
          if (here.kind === 'water' || there.kind === 'water') continue;
          const step = Math.abs(city.heights[i] - city.heights[j]);
          if (step <= GAME_CONFIG.TERRAIN_STEP_UP_FOOT * LEVEL + 1e-9) continue;
          cliffs++;
          check(NATURAL.has(here.biome) && NATURAL.has(there.biome),
            `seed ${seed}: talude de ${step.toFixed(2)} tiles entre (${x},${y}) ${here.biome} e (${nx},${ny}) ${there.biome} fora da reserva`);
          check(here.kind !== 'road' && there.kind !== 'road',
            `seed ${seed}: muro em cima do asfalto (${x},${y})`);
        }
      }
    }
    check(cliffs > 50, `seed ${seed}: apenas ${cliffs} taludes — as reservas não barcam nada`);
  }
});

test('todo asfalto é contíguo: carro nunca encontra uma parede na pista', () => {
  for (const { seed, city } of cities) {
    const map = new CityMap(city);
    const W = city.tilesW;
    const H = city.tilesH;
    let roadPairs = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (city.tiles[y * W + x].kind !== 'road') continue;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          if (city.tiles[ny * W + nx].kind !== 'road') continue;
          roadPairs++;
          check(map.canClimb(x + 0.5, y + 0.5, nx + 0.5, ny + 0.5),
            `seed ${seed}: a pé não sobe da rua (${x},${y}) para (${nx},${ny})`);
          check(map.canDriveOver(x + 0.5, y + 0.5, nx + 0.5, ny + 0.5),
            `seed ${seed}: a pista (${x},${y}) vira barreira para carro em (${nx},${ny})`);
        }
      }
    }
    check(roadPairs > 1000, `seed ${seed}: malha de ruas minúscula (${roadPairs})`);
  }
});

test('cada prédio pisa um terrace plano: a porta não abre para o meio de um degrau', () => {
  for (const { seed, city } of cities) {
    const W = city.tilesW;
    for (const b of city.buildings) {
      // A base é o losango [x-fw, x] (mesmo retângulo do collider em Map.ts e do
      // nivelamento em city.ts), e eachCell arredonda floor/fceil.
      const x0 = Math.floor(b.x - b.footprintW);
      const y0 = Math.floor(b.y - b.footprintW);
      const x1 = Math.min(W - 1, Math.ceil(b.x) - 1);
      const y1 = Math.min(city.tilesH - 1, Math.ceil(b.y) - 1);
      let reference = null;
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          if (city.tiles[y * W + x].kind === 'water') continue;
          const h = city.heights[y * W + x];
          if (reference === null) reference = h;
          check(h === reference, `seed ${seed}: prédio ${b.key} em (${b.x},${b.y}) atravessa um degrau (${reference} → ${h})`);
        }
      }
    }
  }
});

test('a elevação só move o Y: a projeção continua isométrica 2:1 e a ordem de pintura bate', () => {
  // Um tile elevado é pintado exatamente onde o tile (x-h, y-h) plano estaria. É essa
  // identidade que mantém a câmera isométrica e faz o depth sort sair certo de graça.
  for (const { city } of cities) {
    const W = city.tilesW;
    const H = city.tilesH;
    let sampled = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const h = city.heights[y * W + x];
        if (h <= 0 || x - h < 0 || y - h < 0) continue;
        if (++sampled % 37 !== 0) continue;
        const lifted = worldToScreen(x, y, h);
        const flat = worldToScreen(x - h, y - h, 0);
        check(lifted.x === flat.x && Math.abs(lifted.y - flat.y) < 1e-9,
          `(${x},${y}) h=${h} não cai na posição plana de (${x - h},${y - h})`);
        check(Math.abs(depthOf(x, y, h) - (x - h + (y - h))) < 1e-9,
          `depthOf(${x},${y},${h}) precisa ordenar junto do tile plano que ele cobre`);
      }
    }
    check(sampled > 200, `amostragem de elevação insuficiente (${sampled})`);
  }
});

test('Map: leitura de altura e as regras de climb/queda/declive', () => {
  const W = 12;
  const steps = [0, 1, 2, 4, 8, 12, 16];
  const levels = new Uint8Array(W * W);
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) levels[y * W + x] = steps[Math.min(steps.length - 1, x)];
  const map = new CityMap({
    tilesW: W, tilesH: W, worldW: W, worldH: W, buildings: [], props: [], vehicles: [],
    npcSpawns: [], playerSpawn: { x: 0.5, y: 0.5 },
    tiles: Array.from({ length: W * W }, () => ({ kind: 'grass', key: '', biome: 'forest' })),
    heights: Float32Array.from(levels, (v) => v * LEVEL),
  });
  check(map.heightAt(0.2, 0.2) === 0, 'heightAt usa o tile do ponto');
  check(map.heightAt(1.9, 5) === LEVEL, 'heightAt floor-a a coordenada');
  check(map.levelAt(1.9, 5) === 1, 'levelAt devolve degraus');
  check(map.heightAtTile(-1, 0) === 0 && map.heightAtTile(W, 0) === 0, 'fora do mapa é chão plano, não NaN');
  // Subir: um degrau passa, dois são parede.
  check(map.canClimb(0.5, 0.5, 1.5, 0.5), 'um degrau para cima tem que ser pisável');
  check(!map.canClimb(1.5, 0.5, 3.5, 0.5), 'dois degraus para cima têm que barrar o passo');
  // Descer: até TERRAIN_MAX_DROP degraus é andar, além disso é borda.
  check(map.canClimb(2.5, 0.5, 0.5, 0.5), 'descer degraus rasos é andar');
  check(!map.canClimb(4.5, 0.5, 0.5, 0.5), 'queda funda tem que barrar');
  // Roda: só passa onde a pista é suave nos dois sentidos.
  check(map.canDriveOver(0.5, 0.5, 1.5, 0.5), 'rampa suave é dirigível');
  check(!map.canDriveOver(1.5, 0.5, 4.5, 0.5), 'talude não é estrada');
  check(!map.canDriveOver(4.5, 0.5, 1.5, 0.5), 'dirigibilidade é simétrica: descida funda também barra');
  check(map.slopeAlong(0.5, 0.5, 1, 0) === 1 && map.slopeAlong(1.5, 0.5, 1, 0) === 1, 'slopeAlong mede o degrau à frente');
  check(map.slopeAlong(3.5, 0.5, -1, 0) === -2, 'slopeAlong é negativa descendo');
});

test('a janela da neblina alcança a crista: um morro alto entra no bake antes da câmera chegar', () => {
  const fog = new FogSystem();
  for (const [zoom, viewW, viewH] of [[1, 390, 844], [0.95, 1920, 1080], [1.85, 320, 568]]) {
    const camera = { x: 100, y: 100, zoom, h: 0 };
    const ctx = { camera, viewW, viewH };
    const view = fog.view(ctx);
    const bounds = fog.worldBounds(view);
    // O mesmo inverso sem relevo, para medir quanto a crista ganhou de window.
    const flat = Math.hypot(view.radiusX / 128, view.radiusY / 64) + FOG.padding / 128 + FOG.padding / 64 + 1;
    const climb = GAME_CONFIG.TERRAIN_MAX_LEVEL * LEVEL;
    check(bounds.maxX - 100 >= flat + climb - 1e-9 && bounds.maxY - 100 >= flat + climb - 1e-9,
      `zoom ${zoom}: window sem a subida do relevo (${(bounds.maxX - 100).toFixed(2)} < ${(flat + climb).toFixed(2)})`);
    // A câmara em si sobe: o centro da vista é a projeção do ponto elevado.
    const lifted = fog.view({ ...ctx, camera: { ...camera, h: MAX_H } });
    check(Math.abs(lifted.y - (view.y - MAX_H * ELEVATION_PX)) < 1e-9 && lifted.x === view.x,
      `zoom ${zoom}: a câmera levantada deslocou a vista para o lado em vez de só para cima`);
  }
});

test('relevo em movimento: o pé sobe a ladeira, mas não atravessa a montanha nem cai da borda', () => {
  const { CollisionSystem } = load(path.join(root, 'src/systems/CollisionSystem.ts'));
  const { createPlayer } = load(path.join(root, 'src/entities/Player.ts'));
  const { movePlayerGround } = load(path.join(root, 'src/systems/MovementSystem.ts'));
  const W = 20;
  const ground = (levelAt) => new CityMap({
    tilesW: W, tilesH: W, worldW: W, worldH: W, buildings: [], props: [], vehicles: [],
    npcSpawns: [], playerSpawn: { x: 1.5, y: 1.5 },
    tiles: Array.from({ length: W * W }, () => ({ kind: 'grass', key: '', biome: 'forest' })),
    heights: Float32Array.from(Array.from({ length: W * W }, (_, i) => levelAt(i % W) * LEVEL), (v) => v),
  });
  const collision = new CollisionSystem();
  const walk = (map, x, y, dx, dy, ticks) => {
    const player = createPlayer(x, y);
    for (let i = 0; i < ticks; i++) movePlayerGround(player, map, collision, dx, dy);
    return player;
  };
  // Talude de 5 degraus: montanha. O passo enrosca na face e não passa para o outro lado.
  const mountain = ground((x) => (x < 9 ? 0 : 5));
  for (const from of [8.4, 8.7, 8.95]) {
    const p = walk(mountain, from, 9.5, 0.35, 0, 60);
    check(p.x < 9, `andou através da parede de montanha partindo de x=${from} (${p.x.toFixed(2)})`);
  }
  // Rampa de um degrau por tile: é trilha, não muro — o mesmo passo sobe até o topo.
  const ramp = ground((x) => Math.min(5, Math.max(0, x - 8)));
  const up = walk(ramp, 8.4, 9.5, 0.35, 0, 90);
  check(up.x > 13, `a ladeira barrou o passo que deveria escalar (parou em ${up.x.toFixed(2)})`);
  check(Math.abs(up.y - 9.5) < 1e-9, 'escalou para fora da linha do teste');
  // Borda funda: do platô para o vale não se despenca andando.
  const ledge = ground((x) => (x < 10 ? 6 : 0));
  const off = walk(ledge, 9.6, 9.5, 0.35, 0, 60);
  check(off.x < 10, `caiu da borda de 6 degraus andando (${off.x.toFixed(2)})`);
});

test('helicóptero no relevo: a cota manda, o talude barra o voo raso e o pouso é no platô', () => {
  const { CollisionSystem } = load(path.join(root, 'src/systems/CollisionSystem.ts'));
  const { MovementSystem } = load(path.join(root, 'src/systems/MovementSystem.ts'));
  const { createVehicle } = load(path.join(root, 'src/entities/Vehicle.ts'));
  const { VEHICLE_DEFS } = load(path.join(root, 'src/data/vehicles.ts'));
  const input = load(path.join(root, 'src/game/InputState.ts'));
  const W = 24;
  const PLATEAU = 4;
  const map = new CityMap({
    tilesW: W, tilesH: W, worldW: W, worldH: W, buildings: [], props: [], vehicles: [],
    npcSpawns: [], playerSpawn: { x: 1.5, y: 1.5 },
    tiles: Array.from({ length: W * W }, () => ({ kind: 'grass', key: '', biome: 'forest' })),
    heights: Float32Array.from(Array.from({ length: W * W }, (_, i) => (i % W < 10 ? 0 : PLATEAU)), (v) => v),
  });
  const movement = new MovementSystem(new CollisionSystem(), () => []);
  const heli = createVehicle(1, VEHICLE_DEFS.helicopter, 'red', 8.5, 12.5, 'SE');
  // (+2,+1) no manche é +X no mundo: a mesma base inversa que o jogo usa no joystick.
  const fly = (ticks) => { for (let i = 0; i < ticks; i++) movement.updateVehicle(heli, map, 0.1); };

  // Levitação: o manche tira do chão na taxa de subida, não num salto de um frame.
  input.setJoystickInput(2, 1, 1);
  movement.updateVehicle(heli, map, 0.1);
  check(heli.altitude > 0 && heli.altitude < 0.5, `lift-off de um frame: ${heli.altitude.toFixed(2)}`);
  fly(30);
  check(Math.abs(heli.altitude - GAME_CONFIG.HELI_CRUISE_ALTITUDE) < 0.05,
    `não ficou na altura de levitação (${heli.altitude.toFixed(2)})`);

  // Voo raso contra a montanha: a face barra a máquina em vez de içá-la por elevador.
  check(heli.x < 10, `atravessou o talude voando baixo (x=${heli.x.toFixed(2)})`);
  input.setHeliControl('up', true);
  fly(20);
  input.setHeliControl('up', false);
  check(heli.elevation > PLATEAU, `subiu a tempo de passar a crista (cota ${heli.elevation.toFixed(2)})`);
  const cotAntes = heli.elevation;
  fly(20);
  check(heli.x > 12, `não cruzou depois de ganhar altura (x=${heli.x.toFixed(2)})`);
  // Ganhou o platô: a cota é a mesma, quem encolheu foi a folga sobre o chão.
  check(Math.abs(heli.elevation - cotAntes) < 1e-6, `a cota mudou sozinha ao pousar no ar (${heli.elevation} ≠ ${cotAntes})`);
  check(Math.abs(heli.altitude - (heli.elevation - PLATEAU)) < 1e-6, 'altitude não é a folga sobre o terreno local');

  // Pouso comandado: desce até o platô, nunca até o nível zero do mundo.
  input.setHeliControl('down', true);
  fly(60);
  input.resetInputState();
  check(Math.abs(heli.elevation - PLATEAU) < 1e-6, `pousou fora do platô (cota ${heli.elevation.toFixed(2)})`);
  check(heli.altitude === 0, `ficou pairando no chão do platô (${heli.altitude.toFixed(2)})`);

  // Sem piloto: a máquina assenta no chão debaixo dela.
  heli.elevation = PLATEAU + 2;
  heli.altitude = 2;
  heli.occupied = false;
  for (let i = 0; i < 40; i++) movement.settleAirborne(heli, map, 0.1);
  check(heli.altitude === 0 && heli.elevation === PLATEAU,
    `a descida automática devolveu o aparelho ao nível do mundo (${heli.elevation})`);

  // Teto: segurar a cabra para sempre não fura o céu.
  const free = createVehicle(2, VEHICLE_DEFS.helicopter, 'red', 3.5, 3.5, 'SE');
  input.setHeliControl('up', true);
  for (let i = 0; i < 200; i++) movement.updateVehicle(free, map, 0.1);
  input.resetInputState();
  check(free.elevation <= GAME_CONFIG.HELI_CEILING_ELEVATION + 1e-9,
    `estourou o teto do voo (${free.elevation.toFixed(2)})`);
});

test('geração determinística: o relevo é do seed, não do relógio', () => {
  for (const [seed, city] of cities.map((c) => [c.seed, c.city])) {
    const again = generateCity(seed);
    check(Buffer.from(city.heights.buffer).equals(Buffer.from(again.heights.buffer)),
      `seed ${seed}: duas gerações do mesmo seed deram relevos diferentes`);
  }
});

console.log(`Terrain checks: ${passed} passed, ${failed} failed.`);
if (failed) { console.error('Falha de relevo = risco de muro invisível ou câmera errada; não relaxar asserções.'); process.exitCode = 1; }
