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

const MAX_H = GAME_CONFIG.TERRAIN_MAX_ELEVATION;
const STEP = GAME_CONFIG.TERRAIN_STEP_UP_TILES;
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
  let visible = 0;
  const cotas = new Set();
  for (let i = 0; i < W * H; i++) {
    const h = city.heights[i];
    if (h > max) max = h;
    if (h > 0) raised++;
    // Relevos de 32px na tela já são morro; abaixo disso é ondulação de planície.
    if (h >= 0.5) visible++;
    cotas.add(Math.round(h * 1000));
  }
  return { seed, W, H, max, raised, visible, kinds: cotas.size };
});

test('o campo de altura é contínuo, limitado e nunca levanta a cidade nem a água', () => {
  for (const { seed, city } of cities) {
    const W = city.tilesW;
    const H = city.tilesH;
    check(city.heights instanceof Float32Array, 'heights precisa ser Float32Array (malha, não lista de objetos)');
    check(city.heights.length === W * H, 'heights indexada igual a tiles');
    let urban = 0;
    for (let i = 0; i < W * H; i++) {
      const h = city.heights[i];
      check(Number.isFinite(h), `altura não finita no tile ${i}`);
      check(h >= 0 && h <= MAX_H + 1e-9, `tile ${i} fora do intervalo de relevo: ${h}`);
      if (city.tiles[i].kind === 'water') check(h === 0, `água elevada no tile ${i}: o leito tem que ser o fundo do vale`);
      // A planície urbana é a regra, não o efeito colateral: fora da reserva o chão
      // é o nível zero, e é por isso que a porta do interior abre para a calçada.
      if (!NATURAL.has(city.tiles[i].biome)) {
        urban++;
        check(h === 0, `seed ${seed}: cidade elevada no tile ${i} (${city.tiles[i].biome}): ${h}`);
      }
    }
    check(urban / (W * H) > 0.25, `seed ${seed}: só ${(urban / (W * H) * 100).toFixed(0)}% do mapa é planície urbana`);
  }
});

test('o relevo existe: serras com crista e encosta suficiente para ler profundidade', () => {
  for (const s of stats) {
    check(s.kinds > 400, `seed ${s.seed}: só ${s.kinds} cotas diferentes — sem encosta contínua isso é pilha de bloco`);
    check(s.raised / (s.W * s.H) > 0.02, `seed ${s.seed}: ${(s.raised / (s.W * s.H) * 100).toFixed(1)}% do mapa elevado é pouco`);
    check(s.max >= 2.5, `seed ${s.seed}: crista máxima de ${s.max} tiles não é serra`);
    console.log(`  seed ${s.seed}: crista ${(s.max * ELEVATION_PX).toFixed(0)}px, ${(s.raised / (s.W * s.H) * 100).toFixed(1)}% do chão elevado, ${(s.visible / (s.W * s.H) * 100).toFixed(1)}% acima de 0,5 tile, ${s.kinds} cotas`);
  }
});

test('encosta íngreme só acontece dentro da reserva: a cidade não ganha muro invisível', () => {
  const SLOPE = GAME_CONFIG.TERRAIN_MAX_SLOPE_TILES;
  for (const { seed, city } of cities) {
    const W = city.tilesW;
    const H = city.tilesH;
    // Distância ao chão que se pisa: via, trilha e clareira de prédio. Paredão a dois
    // tiles de uma rua é exatamente o bug que esta asserção guarda.
    const macio = new Uint16Array(W * H).fill(W + H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (city.tiles[i].kind === 'road') macio[i] = 0;
      }
    }
    // BFS de distância ao asfalto: a mesma métrica que o gerador usa para o teto de declive.
    const queue = [];
    for (let i = 0; i < W * H; i++) if (macio[i] === 0) queue.push(i);
    for (let head = 0; head < queue.length; head++) {
      const i = queue[head];
      const x = i % W;
      const d = macio[i] + 1;
      for (const [nx, ny] of [[x + 1, (i - x) / W], [x - 1, (i - x) / W], [x, (i - x) / W + 1], [x, (i - x) / W - 1]]) {
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const j = ny * W + nx;
        if (macio[j] > d) { macio[j] = d; queue.push(j); }
      }
    }
    let pares = 0;
    let walls = 0;
    let soft = 0;
    // O que faz a serra aparecer numa encosta contínua é a tinta do hillshade, não a
    // parede: sem contraste de sombra o relevo vira sprite deslocado e ninguém lê morro.
    // Mede-se na encosta de verdade (o tile que tem altura para mostrar), não na reserva
    // inteira — platô e vale são planos por natureza e não têm sombra nenhuma mesmo.
    let comSombra = 0;
    let encosta = 0;
    for (let i = 0; i < W * H; i++) {
      if (!NATURAL.has(city.tiles[i].biome) || city.tiles[i].kind === 'water') continue;
      check(city.shades[i] === 0 || Math.abs(city.shades[i]) <= 1, `seed ${seed}: sombra fora de [-1,1] no tile ${i}`);
      if (city.heights[i] < 0.5) continue;
      encosta++;
      if (Math.abs(city.shades[i]) >= 0.25) comSombra++;
    }
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const here = city.tiles[i];
        // O sinal da tinta é o mapa inteiro: luz vem de cima da tela, então a encosta
        // que sobe conforme desce na tela clareia e a que despenca na sua direção escurece.
        // Inverter isso de novo devolve a serra de cabeça para baixo.
        if (NATURAL.has(here.biome) && here.kind !== 'water' && city.heights[i] >= 0.5) {
          const sobe = ((city.heights[y * W + Math.min(W - 1, x + 2)] - city.heights[y * W + Math.max(0, x - 2)])
            + (city.heights[Math.min(H - 1, y + 2) * W + x] - city.heights[Math.max(0, y - 2) * W + x])) / 4;
          check(sobe * city.shades[i] >= -1e-6,
            `seed ${seed}: sombra invertida em (${x},${y}) — a luz estaria batendo de baixo`);
        }
        for (const [dx, dy] of [[1, 0], [0, 1]]) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= W || ny >= H) continue;
          const j = ny * W + nx;
          const there = city.tiles[j];
          if (here.kind === 'water' || there.kind === 'water') continue;
          const step = Math.abs(city.heights[i] - city.heights[j]);          // O teto de declive é o que a projeção isométrica ainda desenha como encosta:
          // acima de meio tile por tile o losango inverte e o morro vira beiral — é o
          // degrau de bloco que esta asserção não deixa voltar, em canto nenhum do mapa.
          pares++;
          check(step <= SLOPE + 1e-6,
            `seed ${seed}: talude de ${step.toFixed(2)} tiles entre (${x},${y}) e (${nx},${ny}) — a malha inverte na tela`);
          // Aresta que barra o passo: tem que ser rareada e nunca encostada no que se pisa.
          if (step > STEP) {
            walls++;
            check(NATURAL.has(here.biome) && NATURAL.has(there.biome),
              `seed ${seed}: parede inescalável fora da reserva em (${x},${y})`);
            check(Math.min(macio[i], macio[j]) > 3,
              `seed ${seed}: aresta de ${step.toFixed(2)} tiles a ${Math.min(macio[i], macio[j])} tiles do asfalto (${x},${y})`);
          }
          // Perto de via e trilha o declive tem que ser de montar, não de escalar.
          const perto = Math.min(macio[i], macio[j]);
          if (perto <= 2) {
            soft++;
            check(step <= GAME_CONFIG.TERRAIN_STEP_UP_VEHICLE + 1e-9,
              `seed ${seed}: ressalto de ${step.toFixed(2)} tiles a ${perto} tiles do asfalto em (${x},${y})`);
          }
        }
      }
    }
    console.log(`  seed ${seed}: ${pares} pares de vizinhos, ${walls} arestas que barram o passo, ${soft} vizinhos suaves junto ao asfalto, ${(comSombra / encosta * 100).toFixed(0)}% da encosta com sombra legível`);
    check(comSombra / encosta > 0.4, `seed ${seed}: só ${(comSombra / encosta * 100).toFixed(0)}% da encosta tem sombra — relevo que não se vê não é relevo, é deslocamento de sprite`);
    check(soft > 2000, `seed ${seed}: a malha de corredores suaves não cobre as vias (${soft})`);
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
  // Cotas em tiles: a malha é contínua, e as regras comparam desnível, não degrau.
  const cotas = [0, 0.25, 0.5, 1, 2, 3, 4];
  const heights = new Float32Array(W * W);
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) heights[y * W + x] = cotas[Math.min(cotas.length - 1, x)];
  const map = new CityMap({
    tilesW: W, tilesH: W, worldW: W, worldH: W, buildings: [], props: [], vehicles: [],
    npcSpawns: [], playerSpawn: { x: 0.5, y: 0.5 },
    tiles: Array.from({ length: W * W }, () => ({ kind: 'grass', key: '', biome: 'forest' })),
    heights,
  });
  check(map.heightAt(0.2, 0.2) === 0, 'heightAt usa o tile do ponto');
  check(map.heightAt(1.9, 5) === 0.25, 'heightAt floor-a a coordenada');
  check(map.heightAt(5.9, 5) === 3, 'heightAt lê a cota contínua do tile');
  check(map.heightAtTile(-1, 0) === 0 && map.heightAtTile(W, 0) === 0, 'fora do mapa é chão plano, não NaN');
  check(map.shadeAtTile(-1, 0) === 0, 'fora do mapa não tem sombra');
  // Subir: meia encosta passa, ressalto de montanha barra o pé.
  check(map.canClimb(0.5, 0.5, 1.5, 0.5), 'rampa de 1/4 de tile tem que ser pisável');
  check(map.canClimb(1.5, 0.5, 2.5, 0.5), 'rampa de 1/2 tile ainda é trilha');
  check(!map.canClimb(2.5, 0.5, 4.5, 0.5), 'parede de montanha tem que barrar o passo');
  // Descer: até TERRAIN_MAX_DROP_TILES é andar, além disso é borda.
  check(map.canClimb(3.5, 0.5, 0.5, 0.5), 'descer rampa rasa é andar');
  check(!map.canClimb(6.5, 0.5, 0.5, 0.5), 'queda funda tem que barrar');
  // Roda: só passa onde a pista é suave nos dois sentidos.
  check(map.canDriveOver(0.5, 0.5, 1.5, 0.5), 'rampa suave é dirigível');
  check(!map.canDriveOver(2.5, 0.5, 4.5, 0.5), 'talude não é estrada');
  check(!map.canDriveOver(4.5, 0.5, 1.5, 0.5), 'dirigibilidade é simétrica: descida funda também barra');
  // A régua do motor é a superfície desenhada, não o tile: entre 0,5 e 1,5 a malha sobe
  // 0,1875 em vez do degrau bruto de 0,25, porque cada canto média os tiles vizinhos. O
  // que o contrato exige é o sinal, a grandeza e a honestidade — a leitura suavizada nunca
  // inventa uma ladeira mais íngreme que o degrau mais bruto que existe no mapa (1 tile).
  check(Math.abs(map.slopeAlong(0.5, 0.5, 1, 0) - 0.1875) < 1e-9, 'slopeAlong mede o desnível contínuo à frente');
  check(Math.abs(map.slopeAlong(4.5, 0.5, -1, 0) + 0.875) < 1e-9, 'slopeAlong é negativa descendo');
  const bruto = Math.max(...cotas.map((c, i) => (i ? c - cotas[i - 1] : 0)));
  for (let x = 0.5; x < 6; x += 1) {
    const l = map.slopeAlong(x, 0.5, 1, 0);
    check(l > 0 && l <= bruto + 1e-9, `subida em x=${x}: ${l} fora de (0, ${bruto}]`);
    check(map.slopeAlong(x + 1, 0.5, -1, 0) < 0, `descer em x=${x + 1} tem que ler negativa`);
  }
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
    const climb = MAX_H;
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
  const ground = (cota) => new CityMap({
    tilesW: W, tilesH: W, worldW: W, worldH: W, buildings: [], props: [], vehicles: [],
    npcSpawns: [], playerSpawn: { x: 1.5, y: 1.5 },
    tiles: Array.from({ length: W * W }, () => ({ kind: 'grass', key: '', biome: 'forest' })),
    heights: Float32Array.from(Array.from({ length: W * W }, (_, i) => cota(i % W)), (v) => v),
  });
  const collision = new CollisionSystem();
  const walk = (map, x, y, dx, dy, ticks) => {
    const player = createPlayer(x, y);
    for (let i = 0; i < ticks; i++) movePlayerGround(player, map, collision, dx, dy);
    return player;
  };
  // Talude de montanha: o passo enrosca na face e não passa para o outro lado.
  const mountain = ground((x) => (x < 9 ? 0 : 1.5));
  for (const from of [8.4, 8.7, 8.95]) {
    const p = walk(mountain, from, 9.5, 0.35, 0, 60);
    check(p.x < 9, `andou através da parede de montanha partindo de x=${from} (${p.x.toFixed(2)})`);
  }
  // Encosta de montar, um quarto de tile por lance: é trilha, não muro — sobe até o topo.
  const ramp = ground((x) => Math.min(1.5, Math.max(0, (x - 8) * 0.25)));
  const up = walk(ramp, 8.4, 9.5, 0.35, 0, 120);
  check(up.x > 13, `a ladeira barrou o passo que deveria escalar (parou em ${up.x.toFixed(2)})`);
  check(Math.abs(up.y - 9.5) < 1e-9, 'escalou para fora da linha do teste');
  // Borda funda: do platô para o vale não se despenca andando.
  const ledge = ground((x) => (x < 10 ? 3 : 0));
  const off = walk(ledge, 9.6, 9.5, 0.35, 0, 60);
  check(off.x < 10, `caiu da borda de 3 tiles andando (${off.x.toFixed(2)})`);
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
  // Longe da pedra: o cruzeiro precisa ser medido no plano, antes de qualquer talude,
  // senão a folga lida é a da rampa onde a máquina encostou, não a altura de voo.
  const heli = createVehicle(1, VEHICLE_DEFS.helicopter, 'red', 2.5, 12.5, 'SE');
  // (+2,+1) no manche é +X no mundo: a mesma base inversa que o jogo usa no joystick.
  const fly = (ticks) => { for (let i = 0; i < ticks; i++) movement.updateVehicle(heli, map, 0.1); };

  // Levitação: o manche tira do chão na taxa de subida, não num salto de um frame.
  input.setJoystickInput(2, 1, 1);
  movement.updateVehicle(heli, map, 0.1);
  check(heli.altitude > 0 && heli.altitude < 0.5, `lift-off de um frame: ${heli.altitude.toFixed(2)}`);
  fly(12);
  check(heli.x < 9, `o cruzeiro foi medido em cima do talude (x=${heli.x.toFixed(2)})`);
  check(Math.abs(heli.altitude - GAME_CONFIG.HELI_CRUISE_ALTITUDE) < 0.05,
    `não ficou na altura de levitação (${heli.altitude.toFixed(2)})`);

  // Voo raso contra a montanha: a face barra a máquina em vez de içá-la por elevador.
  // Ela para ONDE a pedra desenhada chega até ela — a malha contínua sobe o talude dentro
  // do último tile, então o casco encosta antes da borda do platô. O que não pode, de
  // jeito nenhum, é a montanha subir o helicóptero sozinha: sem pé de cabra a cota fica
  // abaixo da crista.
  fly(30);
  check(heli.x < 11, `atravessou o talude voando baixo (x=${heli.x.toFixed(2)})`);
  check(heli.elevation < PLATEAU,
    `a montanha içou a máquina sozinha: cota ${heli.elevation.toFixed(2)} com o casco parado em x=${heli.x.toFixed(2)}`);
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
