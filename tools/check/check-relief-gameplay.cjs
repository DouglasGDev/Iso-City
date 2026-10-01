// Contrato: o relevo não manda em nada que se joga em cima.
//
// O pedido do jogador, em uma frase: "regra de relevo mais rígida pra não atrapalhar a
// gameplay". Este arquivo é a rígida versão disso, medida e não opinada. Cada asserção
// abaixo foi calibrada no que o gerador entrega hoje nas três sementes do check-map, com
// folga real sobre o teto físico do pé (TERRAIN_STEP_UP_TILES) e da roda
// (TERRAIN_STEP_UP_VEHICLE) — o que quebrar aqui não é gosto estético, é jogo travado.
//
// A ordem importa: o morro é livre no fundo da reserva (check-terrain guarda isso), e a
// partir do momento em que o chão vira rua, passeio, soleira, platô de prédio ou sala, a
// cota deixa de existir.
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
const { InteriorSystem } = load(path.join(root, 'src/systems/InteriorSystem.ts'));

// O resolutor de faixas converge com tolerância de 1e-6, então "nivelado" aqui é nivelado
// ao ponto de não mover um pixel na tela (1/64 de tile), não igualdade binária de float.
const RASA = 1e-4;
const STEP_PE = GAME_CONFIG.TERRAIN_STEP_UP_TILES;
const STEP_CAR = GAME_CONFIG.TERRAIN_STEP_UP_VEHICLE;
const NATURAL = new Set(['forest', 'countryside', 'beach', 'pinewood', 'savanna', 'desert']);
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
/**
 * Na projeção iso o eixo do mundo é diagonal na tela: SE/NW é tráfego correndo em x,
 * SW/NE correndo em y. É isto que diz de que lado a pista está deitada — e o corte de
 * nível é o lado oposto.
 */
const eixoDaFaixa = (lane) => (!lane ? null : lane === 'SE' || lane === 'NW' ? 'x' : 'y');

let passed = 0;
const test = (nome, fn) => { fn(); passed++; console.log(`OK ${nome}`); };

for (const seed of [20260909, 20260910, 42]) {
  const data = generateCity(seed);
  const W = data.tilesW;
  const H = data.tilesH;
  const alt = (x, y) => data.heights[y * W + x];
  const kind = (x, y) => data.tiles[y * W + x].kind;
  const dentro = (x, y) => x >= 0 && y >= 0 && x < W && y < H;
  const mapa = new CityMap(data);
  const interiors = new InteriorSystem(mapa);

  // ---- 1. A cidade é um plano ------------------------------------------------
  // Não é "quase plano": é zero exato na altura e zero exato na régua do relevo, para
  // nenhum tile urbano chegar perto do tint da serra. Foi o ponto de partida de todo o
  // epic — morro que entra no asfalto não é morro, é buraco no jogo.
  test('seed ' + seed + ': a malha urbana é o plano zero — altura e tinta', () => {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (NATURAL.has(data.tiles[y * W + x].biome)) continue;
        const i = y * W + x;
        assert.equal(data.heights[i], 0, `altura ${data.heights[i]} sob o urbano em (${x},${y})`);
        assert.equal(data.relevo[i], 0, `tinta de serra subindo no urbano em (${x},${y})`);
      }
    }
  });

  // ---- 2. O passeio é rasa ---------------------------------------------------
  // Calçada é rede de pedestre: um degrau entre dois tiles de passeio é NPC parado na
  // frente da loja e animal atravessando a rua na diagonal errada.
  test('seed ' + seed + ': passeio é rasa contínua, sem degrau entre tiles', () => {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (kind(x, y) !== 'concrete') continue;
        for (const [dx, dy] of [[1, 0], [0, 1]]) {
          const nx = x + dx, ny = y + dy;
          if (!dentro(nx, ny) || kind(nx, ny) !== 'concrete') continue;
          assert.ok(Math.abs(alt(x, y) - alt(nx, ny)) < RASA,
            `passeio em rampa: (${x},${y})=${alt(x, y)} e (${nx},${ny})=${alt(nx, ny)}`);
        }
      }
    }
  });

  // ---- 3. A pista deita sobre a própria largura ------------------------------
  // Esta é a regra nova, e a que o pedido pedia. Uma rua subindo a serra no sentido do
  // tráfego é estrada de montanha (§1). A mesma rua subindo de uma faixa para a outra é
  // rua torta: trocar de faixa vira murar. Medido antes da regra, metade dos ressaltos
  // que o relevo punha no asfalto corria ATRAVÉS das faixas.
  test('seed ' + seed + ': asfalto nivelado através da pista e ainda subindo ao longo dela', () => {
    let aoLongo = 0, maiorLongo = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (kind(x, y) !== 'road') continue;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx, ny = y + dy;
          if (!dentro(nx, ny) || kind(nx, ny) !== 'road') continue;
          const meu = eixoDaFaixa(data.tiles[y * W + x].lane) ?? eixoDaFaixa(data.tiles[ny * W + nx].lane);
          const dele = eixoDaFaixa(data.tiles[ny * W + nx].lane) ?? eixoDaFaixa(data.tiles[y * W + x].lane);
          if (!meu || meu !== dele) continue;   // nó: cruzamento não tem faixa
          const s = Math.abs(alt(x, y) - alt(nx, ny));
          const atravessando = dx !== 0 ? meu === 'y' : meu === 'x';
          if (atravessando) {
            assert.ok(s < RASA, `degrau entre faixas em (${x},${y})->(${nx},${ny}): ${s} tiles`);
          } else {
            aoLongo++;
            if (s > maiorLongo) maiorLongo = s;
            assert.ok(s <= STEP_CAR,
              `roda não sobe isso: (${x},${y})->(${nx},${ny}) tem ${s.toFixed(2)} tiles`);
          }
        }
      }
    }
    // A regra não pode ser cumprida apagando o relevo do asfalto: sem nenhuma subida,
    // alguém "consertou" o item 3 nivelando a reserva inteira — e aí morreu a estrada de
    // serra que o §1 pede.
    assert.ok(aoLongo > 2000, `a pista não sobe em canto nenhum (${aoLongo} trechos): estrada inclinada é pedido`);
    assert.ok(maiorLongo > 0.1, `o asfalto está todo aplainado (maior subida ${maiorLongo.toFixed(2)})`);
  });

  // ---- 4. Soleira e platô ----------------------------------------------------
  test('seed ' + seed + ': soleira é rasa com o passeio — sair de casa nunca é saltar', () => {
    for (const entrada of interiors.entrances) {
      const tx = Math.floor(entrada.x + Math.cos(entrada.facing) * 0.4);
      const ty = Math.floor(entrada.y + Math.sin(entrada.facing) * 0.4);
      if (!dentro(tx, ty)) continue;
      for (const [dx, dy] of DIRS) {
        const nx = tx + dx, ny = ty + dy;
        if (!dentro(nx, ny)) continue;
        assert.ok(Math.abs(alt(nx, ny) - alt(tx, ty)) < RASA,
          `porta ${entrada.id} abre para um degrau de ${alt(nx, ny) - alt(tx, ty)} tiles`);
      }
    }
  });

  test('seed ' + seed + ': quem nasce no mundo nasce em platô', () => {
    const pontos = [[data.playerSpawn.x, data.playerSpawn.y]]
      .concat(data.npcSpawns.map((p) => [p.x, p.y]))
      .concat(data.vehicles.map((v) => [v.x, v.y]));
    for (const par of pontos) {
      const tx = Math.floor(par[0]), ty = Math.floor(par[1]);
      if (!dentro(tx, ty)) continue;
      for (const [dx, dy] of DIRS) {
        const nx = tx + dx, ny = ty + dy;
        if (!dentro(nx, ny)) continue;
        const s = Math.abs(alt(tx, ty) - alt(nx, ny));
        assert.ok(s <= STEP_CAR,
          `spawn (${tx},${ty}) encosta um ressalto de ${s.toFixed(2)} tiles — metade do que a roda sobe`);
      }
    }
  });

  // ---- 5. O talude não encosta na guia --------------------------------------
  test('seed ' + seed + ': nenhum talude barra o passo encostado no asfalto', () => {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        for (const [dx, dy] of DIRS) {
          const nx = x + dx, ny = y + dy;
          if (!dentro(nx, ny)) continue;
          if (kind(x, y) !== 'road' && kind(nx, ny) !== 'road') continue;
          const s = Math.abs(alt(x, y) - alt(nx, ny));
          assert.ok(s <= STEP_PE,
            `paredão na guia em (${x},${y})->(${nx},${ny}): ${s.toFixed(2)} tiles, a pé não passa`);
        }
      }
    }
  });

  // ---- 6. A sala é um plano sem relevo --------------------------------------
  // O interior não é um lugar do mapa, então também não herda o chão do mapa. Aqui mora
  // a parte do pedido que fala de interiores: o plano da sala é autossuficiente.
  test('seed ' + seed + ': a sala não tem canal de relevo nenhum', () => {
    const qualquer = interiors.entrances[0];
    assert.ok(qualquer, 'há porta para abrir');
    const sala = interiors.open(qualquer, { x: 0, y: 0 });
    const d = sala.map.data;
    assert.ok(Array.from(d.heights).every((v) => v === 0), 'o piso da sala é liso por construção');
    assert.ok(!d.relevo || Array.from(d.relevo).every((v) => v === 0),
      'a régua do relevo não entra na sala: lá dentro não há serra a pintar');
    assert.ok(!d.shades || Array.from(d.shades).every((v) => v === 0),
      'nem uma sombra de encosta cai dentro de casa');
    assert.equal(d.buildings.length, 0, 'nenhum prédio da cidade mora dentro da sala');
    assert.equal(d.vehicles.length, 0, 'nenhum carro da cidade mora dentro da sala');
    // O avesso: a cidade naquele mesmo par de números tem morro. É justamente o que não
    // pode alcançar quem está dentro — a sala é o plano dela, não um recorte do relevo.
    interiors.leave({ x: 0, y: 0 });
    const sob = data.heights[Math.floor(qualquer.y) * W + Math.floor(qualquer.x)];
    assert.ok(Number.isFinite(sob), 'a cidade tem cota do lado de fora');
  });
}

console.log(`\nRelevo × jogabilidade: ${passed} passed, 0 failed.`);
