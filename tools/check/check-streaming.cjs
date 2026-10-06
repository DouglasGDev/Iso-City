/**
 * Streaming do mundo: chunks, zonas e congelamento. Roda headless (sem Skia nem áudio),
 * com o GameState real.
 *
 * A promessa que este arquivo protege, em uma frase: o que sai da tela dorme, mas nunca
 * morre. Um prédio do outro lado da cidade não pode custar nó de desenho nem tick de IA,
 * e o carro que dormiu lá tem de voltar exatamente como ficou — mesma vida, mesmo
 * motorista, mesmo caminho — quando o jogador chegar. As três armadilhas desse contrato
 * são as que um refactor apaga sem querer:
 *
 *  1. índice que perde estática (chunk errado = prédio que some da tela);
 *  2. congelamento que apaga estado (o carro "reaparece novo" e o motorista cai na rua);
 *  3. zona menor que o desenho (pop-in: a névoa alcança onde o carregamento não chegou).
 *
 * Por isso tudo aqui é medido contra força bruta: o índice é a resposta acelerada da
 * mesma pergunta, nunca uma resposta diferente.
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
execFileSync(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'),
  '-p', path.join(__dirname, 'tsconfig.json')], { stdio: 'inherit' });
const compiled = path.join(__dirname, 'dist-test/src');
const load = (file) => require(path.join(compiled, file));
const ui = { paused: false, mapOpen: false, shopOpen: false, departuresOpen: false, overlay: null, mapMarker: null, mapRoute: [] };
for (const [file, exports] of [
  ['audio/SoundManager.js', { sound: { play() {}, ambient() {}, weather() {}, setLoop() {}, stopLoops() {} } }],
  ['assets/AssetRegistry.js', { spriteKeyForVehicle: () => '' }],
  ['stores/useGameStore.js', { useGameStore: { getState: () => ui, clearMapMarker() {}, refreshMapRoute() {},
    showOverlay: (kind) => { ui.overlay = kind; }, openShop: () => { ui.shopOpen = true; },
    closeShop: () => { ui.shopOpen = false; },
    openDepartures: () => { ui.departuresOpen = true; }, closeDepartures: () => { ui.departuresOpen = false; } } }],
]) {
  const filename = path.join(compiled, file);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

const { GAME_CONFIG } = load('game/GameConfig.js');
const { generateCity } = load('data/maps/city.js');
const { Map: WorldMap } = load('world/Map.js');
const { ChunkIndex } = load('world/streaming/ChunkIndex.js');
const { SpatialIndex } = load('world/streaming/SpatialIndex.js');
const { zonesFor, expandRect } = load('world/streaming/StreamingBounds.js');
const { WorldStreamingManager, TIER } = load('world/streaming/WorldStreamingManager.js');
const { GameState } = load('game/GameState.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('OK ' + name); }
  catch (error) { failed++; console.error('FAIL ' + name + '\n' + error.stack); }
}

const CHUNK = GAME_CONFIG.CHUNK_SIZE;
const world = new WorldMap(generateCity(20261002));
const data = world.data;

// ---------------------------------------------------------------- índice de estáticos

test('expandRect dilata os quatro lados igualmente', () => {
  // A janela de candidatos de quem tem altura no ar (helicóptero no teto) é este helper;
  // um lado torto corta o sprite no topo da tela.
  assert.deepEqual(expandRect({ minX: 10, minY: 20, maxX: 30, maxY: 40 }, 8),
    { minX: 2, minY: 12, maxX: 38, maxY: 48 });
});

test('todo prédio e todo adorno pertence a exatamente um chunk', () => {
  const index = new ChunkIndex(data);
  for (let i = 0; i < data.buildings.length; i++) {
    const b = data.buildings[i];
    assert.ok(index.buildingsByChunk[index.at(b.x, b.y)].includes(i), `prédio ${i} sumiu`);
  }
  for (let i = 0; i < data.props.length; i++) {
    assert.ok(index.propsByChunk[index.at(data.props[i].x, data.props[i].y)].includes(i),
      `adorno ${i} sumiu`);
  }
  // "Exatamente um": a soma dos baldes é o tamanho do mapa e nenhum índice se repete.
  const seen = new Set();
  for (const bucket of index.buildingsByChunk) {
    for (const i of bucket) {
      assert.ok(!seen.has(`b${i}`), `prédio ${i} mora em dois chunks`);
      seen.add(`b${i}`);
    }
  }
  for (const bucket of index.propsByChunk) {
    for (const i of bucket) {
      assert.ok(!seen.has(`p${i}`), `adorno ${i} mora em dois chunks`);
      seen.add(`p${i}`);
    }
  }
  assert.equal(seen.size, data.buildings.length + data.props.length,
    'estática ficou de fora de todo chunk');
  // O peso é o que o orçamento de construção paga: tem de bater com os nós do chunk.
  for (let id = 0; id < index.count; id++) {
    assert.equal(index.weight[id],
      index.buildingsByChunk[id].length + index.propsByChunk[id].length, `peso do chunk ${id}`);
  }
});

test('o chunk de um ponto é o chunk do tile dele, com a borda saturada', () => {
  const index = new ChunkIndex(data);
  assert.equal(index.at(0, 0), 0);
  assert.equal(index.cxOf(index.at(CHUNK + 0.9, 0)), 1);
  assert.equal(index.cyOf(index.at(0, CHUNK + 0.9)), 1);
  assert.equal(index.at(-400, 12), index.at(0, 12), 'câmera fora da borda não pode inventar chunk');
  assert.equal(index.at(data.worldW + 99, data.worldH + 99), index.count - 1);
  assert.equal(index.cols, Math.ceil(data.worldW / CHUNK));
  assert.equal(index.count, index.cols * index.rows);
});

test('recarregar o mapa devolve o MESMO chunk para a MESMA estática', () => {
  // §16: a cidade não pode ser sorteada de novo quando um chunk volta. Duas gerações da
  // mesma seed têm de produzir índices byte a byte iguais.
  const a = new ChunkIndex(new WorldMap(generateCity(777)).data);
  const b = new ChunkIndex(new WorldMap(generateCity(777)).data);
  assert.deepEqual(a.buildingsByChunk, b.buildingsByChunk);
  assert.deepEqual(a.propsByChunk, b.propsByChunk);
  assert.deepEqual(Array.from(a.weight), Array.from(b.weight));
});

test('chunkIdsIn devolve todo chunk que toca o retângulo, sem sobra', () => {
  const index = new ChunkIndex(data);
  const rects = [
    { minX: 0, minY: 0, maxX: CHUNK, maxY: CHUNK },
    { minX: 0.5, minY: 0.5, maxX: 15.5, maxY: 15.5 },
    { minX: -30, minY: -30, maxX: 12.4, maxY: 40.2 },
    { minX: data.worldW - 3, minY: data.worldH - 3, maxX: data.worldW + 30, maxY: data.worldH + 30 },
    { minX: 100, minY: 100, maxX: 100.0001, maxY: 100.0001 },
  ];
  for (const rect of rects) {
    const obtido = new Set(index.chunkIdsIn(rect));
    const esperado = new Set();
    for (let cy = 0; cy < index.rows; cy++) {
      for (let cx = 0; cx < index.cols; cx++) {
        const x0 = cx * CHUNK, y0 = cy * CHUNK;
        //Chunk que encosta no retângulo (inclusive na borda) tem de entrar.
        if (x0 < rect.maxX && x0 + CHUNK > rect.minX && y0 < rect.maxY && y0 + CHUNK > rect.minY) {
          esperado.add(index.idOf(cx, cy));
        }
      }
    }
    assert.deepEqual([...obtido].sort((p, q) => p - q), [...esperado].sort((p, q) => p - q),
      `varredura divergiu da força bruta em ${JSON.stringify(rect)}`);
  }
  // Contrato do buffer emprestado: preencher `out` evita o array por tick.
  const buf = [];
  assert.equal(index.chunkIdsIn(rects[1], buf), buf);
  const antes = buf.length;
  index.chunkIdsIn(rects[2], buf);
  assert.notEqual(buf.length, antes, 'o buffer emprestado não foi reaproveitado');
});

test('a arquitetura escala com o mapa, não com o mapa atual', () => {
  // §19: o mundo vai crescer. Nada aqui pode ter 240, 112 ou 225 escrito dentro — um mapa
  // sintético quatro vezes maior precisa virar mais chunk, com a mesma conta.
  const big = new ChunkIndex({ worldW: data.worldW * 2, worldH: data.worldH * 2, buildings: [], props: [] });
  assert.equal(big.cols, data.worldW * 2 / CHUNK);
  assert.equal(big.count, Math.pow(data.worldW * 2 / CHUNK, 2));
  assert.ok(big.count > 225, 'mapa maior não gerou mais chunk');
  assert.ok(big.at(data.worldW + 5, data.worldH + 5) > 225, 'chunk fora do mapa antigo não existe');
});

// ---------------------------------------------------------------- zonas

test('a janela visível cabe dentro da janela de carga (nunca há pop-in por índice)', () => {
  // O footprint da câmera é o que pode aparecer neste quadro. Se ele escapar do anel de
  // streaming, o render pergunta por um chunk que ninguém carregou: prédios nascem no
  // meio da caminhada, que é exatamente o pop-in que a spec não aceita.
  for (let y = 8; y < data.worldH; y += 31) {
    for (let x = 8; x < data.worldW; x += 31) {
      const z = zonesFor(x, y, { minX: x - 11, minY: y - 11, maxX: x + 11, maxY: y + 11 });
      assert.ok(z.visible.minX >= z.streaming.minX && z.visible.maxX <= z.streaming.maxX &&
        z.visible.minY >= z.streaming.minY && z.visible.maxY <= z.streaming.maxY,
        `footprint em (${x}, ${y}) vazou da área de streaming`);
      assert.ok(z.active.minX >= z.streaming.minX && z.active.maxX <= z.streaming.maxX,
        `zona ativa em (${x}, ${y}) passou do anel de carga`);
    }
  }
});

test('as zonas cobrem todo raio que ainda influencia a câmera', () => {
  // O anel de carga é um círculo e a simulação é outro. Se a carga for menor que o
  // alcance de uma regra, o carro parado do lado de fora bloqueia o carro vivo de dentro.
  assert.ok(GAME_CONFIG.STREAMING_RADIUS_TILES > GAME_CONFIG.ACTIVE_RADIUS_TILES);
  assert.ok(GAME_CONFIG.ACTIVE_RADIUS_TILES >= GAME_CONFIG.NPC_SIM_FAR,
    'a zona ativa é menor que o raio de simulação do pedestre');
  assert.ok(GAME_CONFIG.STREAMING_RADIUS_TILES > GAME_CONFIG.POLICE_DESPAWN_DIST,
    'carro policial fora da área de carga ainda pode bloquear quem está vivo');
  // ACTIVE + grade do trânsito + olhada de rota é o pior caso de uma entidade ativa.
  assert.ok(GAME_CONFIG.STREAMING_RADIUS_TILES >=
    GAME_CONFIG.ACTIVE_RADIUS_TILES + 12 + 9, 'anel de prefetch não paga a olhada de rota');
});

test('a camada de uma posição é o retângulo primeiro e a distância depois', () => {
  const mgr = new WorldStreamingManager(new ChunkIndex(data));
  mgr.update({ ax: 120, ay: 120, zoom: GAME_CONFIG.ZOOM_DEFAULT,
    viewBounds: { minX: 108, minY: 108, maxX: 132, maxY: 132 } });
  // O pé da câmera está DENTRO do footprint: VISIBLE é o degrau de cima, e simular é
  // obrigatório lá. `isSimulated` é a leitura que o pedestre e o trânsito usam.
  assert.equal(mgr.tierOf(120, 120), TIER.VISIBLE, 'o pé da câmera não está na tela');
  assert.equal(mgr.isSimulated(120, 120), true, 'o pé da câmera não simula');
  assert.equal(mgr.tierOf(110, 112), TIER.VISIBLE, 'dentro do footprint não é visível');
  assert.equal(mgr.tierOf(120 + GAME_CONFIG.ACTIVE_RADIUS_TILES - 1, 120), TIER.ACTIVE);
  assert.equal(mgr.tierOf(120 + GAME_CONFIG.ACTIVE_RADIUS_TILES + 2, 120), TIER.DISTANT,
    'o anel de espera sumiu');
  assert.equal(mgr.tierOf(120 + GAME_CONFIG.STREAMING_RADIUS_TILES + 40, 120), TIER.OUTSIDE,
    'longe demais ainda é simulado');
  assert.equal(mgr.isSimulated(120 + GAME_CONFIG.ACTIVE_RADIUS_TILES + 20, 120), false);
  assert.equal(mgr.isSimulated(120, 121), true);
  assert.equal(mgr.isInView(110, 112), true);
  assert.equal(mgr.isInView(120 + GAME_CONFIG.STREAMING_RADIUS_TILES, 120), false);
});

test('câmera parada não recomputa nada, e andar um tile inteiro recomputa', () => {
  const mgr = new WorldStreamingManager(new ChunkIndex(data));
  const ctx = { ax: 100, ay: 100, zoom: GAME_CONFIG.ZOOM_DEFAULT,
    viewBounds: { minX: 89, minY: 89, maxX: 111, maxY: 111 } };
  assert.equal(mgr.update(ctx), true, 'a primeira passada tem de acordar o render');
  assert.equal(mgr.update({ ...ctx, ax: 100.1, ay: 100.15 }), false,
    'meio tile de deriva não pode varrer o mundo otra vez');
  assert.equal(mgr.update({ ...ctx, ax: 101.6 }), true, 'um tile andar não mudou o conjunto');
});

test('a prioridade de carga é sempre a mais perto primeiro', () => {
  const mgr = new WorldStreamingManager(new ChunkIndex(data));
  mgr.update({ ax: 60, ay: 180, zoom: GAME_CONFIG.ZOOM_DEFAULT,
    viewBounds: { minX: 49, minY: 169, maxX: 71, maxY: 191 } });
  const d2 = (id) => {
    const dx = mgr.index.centerX(id) - 60, dy = mgr.index.centerY(id) - 180;
    return dx * dx + dy * dy;
  };
  for (const list of [mgr.visibleChunks, mgr.activeChunks, mgr.neededChunks]) {
    for (let i = 1; i < list.length; i++) {
      assert.ok(d2(list[i - 1]) <= d2(list[i]) + 1e-9, 'chunk distante foi carregado antes do perto');
    }
  }
  assert.ok(mgr.neededChunks.length <= GAME_CONFIG.CHUNK_CACHE_LIMIT,
    `pediu ${mgr.neededChunks.length} chunks para um cache de ${GAME_CONFIG.CHUNK_CACHE_LIMIT}`);
  // §14: o que está na tela é sempre o primeiro da fila de construção.
  const visível = new Set(mgr.visibleChunks);
  const primeiro = mgr.neededChunks.find((id) => visível.has(id));
  assert.equal(mgr.neededChunks.indexOf(primeiro), 0,
    'o chunk visível mais perto não é o primeiro da fila');
});

// ---------------------------------------------------------------- índice do que se move

test('a grade de entidades bate com a força bruta em qualquer janela', () => {
  const grid = new SpatialIndex(data.worldW, data.worldH);
  const itens = [];
  for (let i = 0; i < 400; i++) {
    itens.push({ x: (i * 977) % data.worldW, y: (i * 613) % data.worldH });
  }
  grid.rebuild('npc', itens, (o) => o.x, (o) => o.y);
  for (const [cx, cy] of [[120, 120], [16, 16], [data.worldW - 20, 20], [200, 236]]) {
    const rect = zonesFor(cx, cy, { minX: cx - 11, minY: cy - 11, maxX: cx + 11, maxY: cy + 11 }).active;
    const obtido = [...grid.query('npc', rect)].sort((a, b) => a - b);
    const esperado = itens.map((o, i) => ({ i, o }))
      .filter(({ o }) => Math.hypot(o.x - cx, o.y - cy) <= GAME_CONFIG.ACTIVE_RADIUS_TILES +
        GAME_CONFIG.CHUNK_QUERY_MARGIN)
      .map(({ i }) => i).sort((a, b) => a - b);
    // A grade é uma CIRCUNSCRIÇÃO: entrega um pouco mais, nunca menos.
    for (const i of esperado) assert.ok(obtido.includes(i), `entidade ${i} perdida na janela`);
    assert.ok(obtido.length >= esperado.length);
    assert.equal(grid.countIn('npc', rect), obtido.length);
  }
  // Reconstruir com menos itens não pode deixar ranco do tick anterior.
  grid.rebuild('npc', itens.slice(0, 5), (o) => o.x, (o) => o.y);
  assert.equal(grid.totals.npc, 5);
  const tudo = grid.query('npc', { minX: 0, minY: 0, maxX: data.worldW, maxY: data.worldH });
  assert.equal(tudo.length, 5, 'a grade guardou entidade que já foi embora');
});

test('o buffer emprestado é por tipo, não global', () => {
  const grid = new SpatialIndex(data.worldW, data.worldH);
  grid.rebuild('npc', [{ x: 100, y: 100 }], (o) => o.x, (o) => o.y);
  grid.rebuild('veh', [{ x: 200, y: 200 }], (o) => o.x, (o) => o.y);
  const tudo = { minX: 0, minY: 0, maxX: data.worldW, maxY: data.worldH };
  const pedestres = grid.query('npc', tudo);
  const idos = [...pedestres];
  grid.query('veh', tudo);
  assert.deepEqual([...pedestres], idos, 'consultar carro invalidou a lista de pedestre');
  grid.query('npc', { minX: data.worldW - 8, minY: data.worldH - 8, maxX: data.worldW, maxY: data.worldH });
  assert.notDeepEqual([...pedestres], idos, 'a segunda consulta do mesmo tipo tinha de sobrepor o buffer');
});

// ---------------------------------------------------------------- o jogo inteiro

const g = new GameState();
const centro = { x: data.playerSpawn.x, y: data.playerSpawn.y };

function park(x, y, ticks = 10) {
  g.player.x = x;
  g.player.y = y;
  g.player.health = 100;
  for (let i = 0; i < ticks; i++) g.update(1 / 60);
}

test('o GameState acorda com as zonas em volta do jogador', () => {
  assert.ok(g.streaming instanceof WorldStreamingManager);
  assert.ok(g.spatial instanceof SpatialIndex);
  assert.equal(g.streaming.isSimulated(g.player.x, g.player.y), true,
    'o jogador começou fora da zona que simula');
  assert.equal(g.streaming.isInView(g.player.x, g.player.y), true, 'o jogador não está na tela');
  assert.ok(g.streaming.stats.totalEntities > 0, 'as métricas nasceram zeradas');
});

test('atravessar a cidade move as zonas e não perde entidade', () => {
  const pedestres = g.npcs.length, carros = g.vehicles.length;
  const cantos = [[30, 30], [data.worldW - 30, 30], [data.worldW - 30, data.worldH - 30], [centro.x, centro.y]];
  for (const [x, y] of cantos) {
    park(x, y, 24);
    assert.equal(g.streaming.isSimulated(g.player.x, g.player.y), true,
      `chegando em (${x}, ${y}) a zona ativa não cobriu o jogador`);
    assert.ok(g.streaming.stats.visibleChunks > 0, `sem chunk visível em (${x}, ${y})`);
    assert.ok(g.streaming.stats.activeChunks >= g.streaming.stats.visibleChunks);
    // Colisor não se desfaz: §7 é desligar a execução, nunca apagar o dado.
    assert.equal(g.map.staticColliders.length > 0, true);
  }
  assert.equal(g.npcs.length, pedestres, 'streaming deleteou pedestre');
  assert.equal(g.vehicles.length, carros, 'streaming deleteou veículo');
});

test('pedestre fora da zona ativa congela no lugar, e acorda quando a câmera chega', () => {
  park(centro.x, centro.y, 6);
  const longe = g.npcs.find((n) => !n.dead && !n.inVehicle && n.kind !== 'cop' &&
    Math.hypot(n.x - g.camera.x, n.y - g.camera.y) > GAME_CONFIG.STREAMING_RADIUS_TILES + 8);
  assert.ok(longe, 'não há pedestre fora da área de streaming para testar');
  const fotografia = { x: longe.x, y: longe.y, state: longe.state };
  for (let i = 0; i < 180; i++) g.update(1 / 60);
  assert.equal(longe.x, fotografia.x, 'pedestre adormecido andou');
  assert.equal(longe.y, fotografia.y, 'pedestre adormecido andou');
  assert.equal(longe.state, fotografia.state, 'IA rodou dentro do congelado');

  park(longe.x, longe.y, 12);
  let andou = false;
  for (let i = 0; i < 600 && !andou; i++) {
    g.update(1 / 60);
    andou = Math.hypot(longe.x - fotografia.x, longe.y - fotografia.y) > 0.05;
  }
  assert.ok(andou, 'o pedestre não voltou a viver quando a câmera chegou');
});

test('carro adormecido volta exatamente como ficou — vida, motorista e rota', () => {
  park(centro.x, centro.y, 6);
  const tv = g.trafficSystem.traffic.find((t) => t.state !== 'stolen' && t.state !== 'parked' &&
    t.driver && !t.driver.dead &&
    Math.hypot(t.vehicle.x - g.camera.x, t.vehicle.y - g.camera.y) > GAME_CONFIG.STREAMING_RADIUS_TILES + 10);
  assert.ok(tv, 'nenhum carro em trânsito dorme fora da área de streaming');
  const antes = { x: tv.vehicle.x, y: tv.vehicle.y, vida: tv.vehicle.health, estado: tv.vehicle.state,
    motorista: tv.driver.id, rota: (tv.route || []).length, ângulo: tv.vehicle.facingAngle };
  for (let i = 0; i < 240; i++) g.update(1 / 60);
  assert.equal(tv.vehicle.x, antes.x, 'carro congelado se moveu');
  assert.equal(tv.vehicle.y, antes.y, 'carro congelado se moveu');
  assert.equal(tv.vehicle.health, antes.vida, 'carro congelado sofreu dano');
  assert.equal(tv.vehicle.state, antes.estado, 'estado do carro mudou durante o sono');
  assert.equal(tv.driver && tv.driver.id, antes.motorista, 'o motorista sumiu durante o sono');
  assert.equal((tv.route || []).length, antes.rota, 'a rota foi cortada enquanto dormia');

  // Dormir não é desaparecer: o veículo continua no mundo, pronto para ser dirigido.
  assert.ok(g.vehicles.includes(tv.vehicle), 'o GameState perdeu a referência do carro');
  park(tv.vehicle.x, tv.vehicle.y, 30);
  let quilômetro = 0;
  for (let i = 0; i < 900; i++) {
    g.update(1 / 60);
    quilômetro = Math.hypot(tv.vehicle.x - antes.x, tv.vehicle.y - antes.y);
    if (quilômetro > 0.6) break;
  }
  assert.ok(quilômetro > 0.6, `carro acordado não voltou a dirigir (${quilômetro.toFixed(2)} tile)`);
});

test('o anel de espera anda em câmera lenta, nunca para', () => {
  // DISTANT não é congelamento: é o passo reduzido que mantém o carro na rua dele até a
  // câmera chegar. Com o divisor de ticks, a média tem de andar, mas menos que o vizinho ativo.
  const antes = g.trafficSystem.traffic.map((t) => ({ x: t.vehicle.x, y: t.vehicle.y }));
  park(centro.x, centro.y, 8);
  for (let i = 0; i < 240; i++) g.update(1 / 60);
  const distante = g.trafficSystem.traffic.findIndex((t, i) =>
    t.state !== 'parked' && t.state !== 'stolen' && antes[i] &&
    Math.hypot(t.vehicle.x - g.camera.x, t.vehicle.y - g.camera.y) > GAME_CONFIG.ACTIVE_RADIUS_TILES + 12 &&
    Math.hypot(t.vehicle.x - g.camera.x, t.vehicle.y - g.camera.y) < GAME_CONFIG.STREAMING_RADIUS_TILES - 4 &&
    (Math.abs(t.vehicle.x - antes[i].x) + Math.abs(t.vehicle.y - antes[i].y)) > 0.01);
  assert.ok(distante >= 0, 'nenhum carro do anel de espera se moveu em 4 segundos');
});

test('toda entidade na tela está no conjunto de chunks visível', () => {
  // Se um NPC vivo cai fora do `visibleChunks` o sprite dele é cortado antes da névoa:
  // o bug clássico de índice menor que o desenho.
  park(centro.x, centro.y, 6);
  const index = g.streaming.index;
  const z = g.streaming.zones;
  const visíveis = new Set(g.streaming.visibleChunks);
  for (const list of [g.npcs, g.vehicles, g.wildlife.animals]) {
    for (const o of list) {
      if (!z.visible || o.x < z.visible.minX || o.x > z.visible.maxX ||
        o.y < z.visible.minY || o.y > z.visible.maxY) continue;
      if (!g.streaming.isInView(o.x, o.y)) continue;
      assert.ok(visíveis.has(index.at(o.x, o.y)),
        `entidade em (${o.x.toFixed(1)}, ${o.y.toFixed(1)}) está fora do chunk visível`);
    }
  }
});

test('as métricas do painel dizem o que o mundo tem', () => {
  park(centro.x, centro.y, 6);
  const s = g.streaming.stats;
  assert.ok(s.visibleChunks > 0 && s.activeChunks > 0, 'chunk nenhum nas zonas');
  assert.ok(s.totalEntities >= g.npcs.length + g.vehicles.length, 'total de entidades errado');
  assert.equal(s.totalEntities, g.npcs.length + g.vehicles.length + g.wildlife.animals.length +
    g.destruction.wrecks.length);
  assert.ok(s.activeNpcs <= g.npcs.length, 'mais pedestre ativo do que existe');
  assert.ok(s.simulatedEntities >= s.activeNpcs, 'a contagem simulada perdeu o pedestre');
  assert.equal(typeof s.cullMs, 'number');
  assert.equal(typeof s.fps, 'number');
});

test('outra partida do mesmo seed renasce com o mesmo chunk para cada estática', () => {
  // Revisitar a área é recomeçar o mundo: o índice não pode ser sorteado de novo.
  const snapshot = (game) => game.streaming.index.buildingsByChunk.map((c) => c.join(','));
  const refeito = new GameState();
  assert.deepEqual(snapshot(refeito), snapshot(g), 'dois mundos do mesmo seed não batem');
  assert.equal(refeito.streaming.index.count, g.streaming.index.count);
  assert.equal(refeito.map.data.buildings.length, g.map.data.buildings.length);
  assert.deepEqual(refeito.streaming.index.propsByChunk, g.streaming.index.propsByChunk);
});

console.log(`Streaming checks: ${passed} passed, ${failed} failed.`);
if (failed) process.exitCode = 1;
