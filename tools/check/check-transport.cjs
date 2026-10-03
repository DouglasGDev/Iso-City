// Fase 1 da rede de transporte: a malha é derivada do mapa, o horário é analítico e o
// portão de zonas do streaming decide o que se materializa. Roda contra as fontes atuais.
const fs = require('fs');
const path = require('path');
const Module = require('module');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');
const modules = new Map();
const skia = {
  PaintStyle: { Stroke: 'stroke' },
  Skia: {
    Color: (color) => color,
    Paint: () => ({ setColor(color) { this.color = color; }, setStyle() {}, setStrokeWidth() {}, setAntiAlias() {} }),
    Path: { Make: () => ({ moveTo() {}, lineTo() {}, close() {}, rewind() {} }) },
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
const { generateCity, WORLD_SEED } = load(path.join(root, 'src/data/maps/city.ts'));
const { Map: CityMap } = load(path.join(root, 'src/world/Map.ts'));
const { GAME_CONFIG } = load(path.join(root, 'src/game/GameConfig.ts'));
const { ChunkIndex } = load(path.join(root, 'src/world/streaming/ChunkIndex.ts'));
const { WorldStreamingManager } = load(path.join(root, 'src/world/streaming/WorldStreamingManager.ts'));
const { buildTransportNetwork } = load(path.join(root, 'src/data/transport/network.ts'));
const { sampleRoute, alongRoute, stopsNear } = load(path.join(root, 'src/data/transport/schedule.ts'));
const { TransportSystem } = load(path.join(root, 'src/systems/TransportSystem.ts'));

let passed = 0;
const failures = [];
const medido = [];
function check(ok, message) {
  if (ok) passed++;
  else failures.push(message);
}

const ARTERIAS = ['highway', 'avenue', 'street', 'residential', 'access'];

/** Resumo estável da malha: troca qualquer coisa na derivação e o resumo muda. */
function fingerprint(network) {
  return JSON.stringify({
    nodes: network.nodes.map((n) => [n.x, n.y, n.curbed ? 1 : 0, n.roads]),
    roads: network.roads.map((r) => [r.rank, r.axis, r.at, r.label]),
    edges: network.edges.map((e) => [e.from, e.to, e.rank, e.road, e.length, e.path.length]),
    stations: network.stations.map((s) => [s.node, s.x, s.y, s.name, s.rank]),
    routes: network.routes.map((r) => [r.name, r.edges, r.stops, +r.length.toFixed(3), +r.cycle.toFixed(3), r.units]),
  });
}

for (const seed of [WORLD_SEED, 42]) {
  const data = generateCity(seed);
  const map = new CityMap(data);
  const W = data.tilesW;
  const network = buildTransportNetwork(map, seed);
  const tile = (index) => data.tiles[index];

  // ---- 1. A malha nasce do mapa e não é vazia
  check(network.nodes.length >= 200, `caixas de cruzamento derivadas: ${network.nodes.length}`);
  check(network.edges.length >= 800, `faixas derivadas em corredor: ${network.edges.length}`);
  check(network.stations.length >= 150, `paradas com calçada: ${network.stations.length}`);
  check(network.routes.length >= 8, `linhas traçadas: ${network.routes.length}`);

  // ---- 2. Todo nó é uma caixa 2x2 de via sem faixa, no centro geométrico dela
  let caixasOk = true;
  for (const n of network.nodes) {
    if (n.x !== n.tx + 1 || n.y !== n.ty + 1) { caixasOk = false; break; }
    for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      const t = tile((n.ty + dy) * W + n.tx + dx);
      if (t.kind !== 'road' || t.lane) { caixasOk = false; break; }
    }
  }
  check(caixasOk, 'nó da malha que não é caixa 2x2 de cruzamento');

  // ---- 3. Toda aresta é um caminho legal do grafo dirigido do mapa, com um posto só
  const boxOf = new Map();
  for (const n of network.nodes) {
    for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) boxOf.set((n.ty + dy) * W + n.tx + dx, n.id);
  }
  const nodeIndex = new Map();
  map.roadNodeTiles.forEach((n, i) => nodeIndex.set(n.ty * W + n.tx, i));
  let arestasOk = true;
  const postoDaAresta = new Map();
  for (const e of network.edges) {
    const origem = map.roadNodeTiles[e.path[0]];
    const fim = map.roadNodeTiles[e.path[e.path.length - 1]];
    if (boxOf.get(origem.ty * W + origem.tx) !== e.from
      || boxOf.get(fim.ty * W + fim.tx) !== e.to) { arestasOk = false; break; }
    if (e.length !== e.path.length - 1) { arestasOk = false; break; }
    for (let i = 0; i + 1 < e.path.length; i++) {
      if (!map.roadOut[e.path[i]].includes(e.path[i + 1])) { arestasOk = false; break; }
      const t = map.roadNodeTiles[e.path[i + 1]];
      const next = tile(t.ty * W + t.tx);
      if (i + 1 < e.path.length - 1) {
        // Miúdo da faixa: sentido da calçada e posto batem com a aresta.
        const prev = map.roadNodeTiles[e.path[i]];
        const dx = t.tx - prev.tx, dy = t.ty - prev.ty;
        const esperado = dx === 1 ? 'SE' : dx === -1 ? 'NW' : dy === 1 ? 'SW' : 'NE';
        if (next.lane !== esperado || next.rank !== e.rank) { arestasOk = false; break; }
      }
    }
    if (!arestasOk) break;
    postoDaAresta.set(e.id, e.rank);
  }
  check(arestasOk, 'aresta que não é uma faixa legal do grafo dirigido do mapa');

  // ---- 4. Parada é calçada de verdade: o ponto está num nó do grafo pedonal do mapa
  const passeio = new Set(map.sidewalkNodes.map((s) => `${Math.floor(s.x)},${Math.floor(s.y)}`));
  let paradasOk = true;
  for (const s of network.stations) {
    if (!passeio.has(`${Math.floor(s.x)},${Math.floor(s.y)}`)) { paradasOk = false; break; }
    const n = network.nodes[s.node];
    if (Math.hypot(s.x - n.x, s.y - n.y) > 2.2) { paradasOk = false; break; }
    if (!s.name || s.name.includes('undefined')) { paradasOk = false; break; }
    if (s.rank === 'highway') { paradasOk = false; break; }
    if (!n.curbed) { paradasOk = false; break; }
  }
  check(paradasOk, 'parada fora do passeio, longe da caixa ou em rodovia');

  // ---- 5. Toda via da malha é de um corredor contíguo, e o posto carimbado do mapa está na malha
  const postosMapa = new Set();
  for (const t of data.tiles) if (t.kind === 'road' && t.rank) postosMapa.add(t.rank);
  const postosMalha = new Set(network.roads.map((r) => r.rank));
  check([...postosMapa].every((r) => postosMalha.has(r)),
    `posto do mapa sem via na malha: ${[...postosMapa].filter((r) => !postosMalha.has(r)).join(',')}`);
  check([...postosMalha].every((r) => ARTERIAS.includes(r)), 'via da malha com posto que não é da hierarquia');

  // ---- 6. Linha de ônibus: sem acesso, rodovia só onde não há caminho sem ela, parada em
  //         ordem e horário crescente
  const semEspinha = network.nodes.map(() => []);
  for (const e of network.edges) {
    if (e.rank === 'highway' || e.rank === 'access') continue;
    semEspinha[e.from].push(e.to);
  }
  const alcance = (start, end) => {
    const visto = new Uint8Array(semEspinha.length);
    const fila = [start];
    visto[start] = 1;
    while (fila.length) {
      const c = fila.pop();
      if (c === end) return true;
      for (const nx of semEspinha[c]) if (!visto[nx]) { visto[nx] = 1; fila.push(nx); }
    }
    return false;
  };
  let rotasOk = true;
  let espinhaUsada = 0;
  const postosNasRotas = new Set();
  for (const r of network.routes) {
    if (r.ranks.includes('access')) { rotasOk = false; break; }
    for (const id of r.edges) postosNasRotas.add(network.edges[id].rank);
    const de = network.stations[r.stops[0].station].node;
    const ate = network.stations[r.stops[r.stops.length - 1].station].node;
    if (r.ranks.includes('highway')) {
      // A espinha só atravessa o rio: se a malha de avenidas ligava as duas pontas por
      // outro lado, a linha escolheu a rodovia por escolha, não por necessidade.
      if (alcance(de, ate)) { rotasOk = false; break; }
      espinhaUsada++;
    }
    const S = r.stops.length;
    if (S < 3 || r.table.length !== 2 * S) { rotasOk = false; break; }
    if (r.stops.some((s, i) => i > 0 && s.at <= r.stops[i - 1].at)) { rotasOk = false; break; }
    if (r.stops.some((s) => !network.stations[s.station])) { rotasOk = false; break; }
    if (r.table.some((e, i) => i > 0 && e.time <= r.table[i - 1].time)) { rotasOk = false; break; }
    if (r.table[r.table.length - 1].time >= r.cycle) { rotasOk = false; break; }
    // Andar a pé custa 1/1,85 s por tile no mesmo asfalto. Uma linha que custa mais que
    // isso não é transporte, é um ônibus turístico parado em cada esquina.
    if (r.cycle / (2 * r.length) >= 1 / GAME_CONFIG.PLAYER_WALK_SPEED) { rotasOk = false; break; }
    // A intervalo da frota é um teto, não uma meta: com `units` inteiros o intervalo real é
    // sempre igual ou mais curto que o pedido, e é o valor curto que o passageiro espera.
    if (r.units < 1 || r.cycle / r.units > network.services[r.service].headway + 1e-9) { rotasOk = false; break; }
    // A polilinha é contínua e a distância acumulada bate com o comprimento.
    let soma = 0;
    for (let i = 1; i < r.points.length; i++) {
      const d = Math.hypot(r.points[i].x - r.points[i - 1].x, r.points[i].y - r.points[i - 1].y);
      if (d > 1.6) { rotasOk = false; break; }
      soma += d;
    }
    if (!rotasOk) break;
    if (Math.abs(soma - r.length) > 1e-6 || Math.abs(r.cum[r.cum.length - 1] - r.length) > 1e-6) { rotasOk = false; break; }
    if (Math.abs(r.stops[S - 1].at - r.length) > 1e-6) { rotasOk = false; break; }
  }
  check(rotasOk, 'linha usa rodovia havendo caminho sem ela, para fora da polilinha, perde do pé ou tem horário fora de ordem');
  for (const rank of ['avenue', 'street', 'residential']) {
    check(postosNasRotas.has(rank), `nenhuma linha passa por uma via de posto ${rank}`);
  }

  // ---- 7. Cobertura do território: de qualquer cruzamento habitado se caminha até uma
  //         parada com linha em menos de duas quadras.
  const servidas = network.stations.filter((s) => s.lines.length > 0);
  check(servidas.length >= network.routes.length * 3, `linhas com poucas paradas: ${servidas.length}`);
  const cell = network.grid.cell;
  let maisLonge = 0;
  let semAlcance = 0;
  for (const n of network.nodes) {
    if (!n.curbed) continue;
    let best = Infinity;
    const cx = Math.floor(n.x / cell), cy = Math.floor(n.y / cell);
    for (let gy = Math.max(0, cy - 4); gy <= Math.min(network.grid.rows - 1, cy + 4); gy++) {
      for (let gx = Math.max(0, cx - 4); gx <= Math.min(network.grid.cols - 1, cx + 4); gx++) {
        // O balde guarda índices de `network.stations`, não a posição em `servidas`.
        for (let i = network.grid.head[gy * network.grid.cols + gx]; i >= 0; i = network.grid.next[i]) {
          const s = network.stations[i];
          if (!s.lines.length) continue;
          const d = Math.hypot(s.x - n.x, s.y - n.y);
          if (d < best) best = d;
        }
      }
    }
    // Nenhum ponto servido na janela de varredura é o pior caso possível: mais longe que
    // o próprio alcance da varredura, e por isso conta como distância, não como silêncio.
    if (!Number.isFinite(best)) { semAlcance++; best = 999; }
    if (best > maisLonge) maisLonge = best;
  }
  check(maisLonge <= 34, `há cruzamento a ${maisLonge.toFixed(0)} tiles da parada servida mais perto`
    + (semAlcance ? ` (${semAlcance} sem nenhum ponto na varredura)` : ''));

  // ---- 8. Horário analítico: o ciclo fecha, a parada fica parada e o veículo não sai da rua
  let horarioOk = true;
  for (const r of network.routes) {
    const service = network.services[r.service];
    for (let unit = 0; unit < r.units; unit++) {
      const a = sampleRoute(r, service, 12.5, unit);
      const b = sampleRoute(r, service, 12.5 + r.cycle, unit);
      if (Math.hypot(a.x - b.x, a.y - b.y) > 1e-6) { horarioOk = false; break; }
      for (let t = 0; t < r.cycle; t += Math.max(0.4, r.cycle / 90)) {
        const s = sampleRoute(r, service, t, unit);
        let best = Infinity;
        for (const p of r.points) best = Math.min(best, Math.hypot(p.x - s.x, p.y - s.y));
        if (best > 0.9) { horarioOk = false; break; }
      }
      if (!horarioOk) break;
    }
    if (!horarioOk) break;
    // Na janela de embarque o veículo não anda: é a calçada, não um ponto do trajeto.
    const service2 = network.services[r.service];
    const parado = sampleRoute(r, service2, r.table[0].time + service2.dwell / 2, 0);
    if (!parado.stopped || Math.hypot(parado.x - r.points[0].x, parado.y - r.points[0].y) > 1e-6) { horarioOk = false; break; }
    const antes = sampleRoute(r, service2, r.turnAt - 1, 0);
    const depois = sampleRoute(r, service2, r.turnAt + service2.dwell + 1, 0);
    if (antes.dir !== 1 || depois.dir !== -1) { horarioOk = false; break; }
  }
  check(horarioOk, 'horário que não fecha o ciclo, anda durante a parada ou larga a polilinha');
  check(alongRoute(network.routes[0], 0, 1).x === network.routes[0].points[0].x, 'alongRoute não começa na origem');

  // ---- 8b. Quem está a pé acha a parada no balde, e não acha parada onde não tem uma.
  const naCalcada = servidas.slice(0, 20).every((s) =>
    stopsNear(network, s.x, s.y, 2.4).some((p) => p.id === s.id));
  check(naCalcada, 'parada não aparece no raio de embarque de quem está nela');
  const longe = servidas.slice(0, 20).every((s) => stopsNear(network, s.x + 6, s.y + 6, 2.4).length === 0);
  check(longe, 'balde de paradas devolveu ponto a seis tiles de distância');

  // ---- 9. Chegadas e transbordo: a espera é finita, a viagem é mais rápida que a pé
  const system = new TransportSystem(map, seed);
  const agora = 300;
  system.update(agora, 120, 120);
  let esperasOk = true;
  for (const s of servidas.slice(0, 24)) {
    const list = system.arrivals(s.id, 2);
    if (list.length === 0 || list.some((a) => !(a.in > 0))) { esperasOk = false; break; }
    if (list.some((a) => a.in > 4 * network.services[network.routes[a.route].service].headway)) { esperasOk = false; break; }
    for (let i = 1; i < list.length; i++) if (list[i].in < list[i - 1].in) { esperasOk = false; break; }
  }
  check(esperasOk, 'chegada atrasada, fora de ordem ou mais longe que quatro intervalos da frota');

  let pior = { d: 0, from: 0, to: 0 };
  for (const s of servidas) {
    for (const t of servidas) {
      const d = Math.hypot(s.x - t.x, s.y - t.y);
      if (d > pior.d) pior = { d, from: s.id, to: t.id };
    }
  }
  const viagem = system.trip(pior.from, pior.to);
  check(!!viagem, 'não há viagem de transporte entre as duas paradas servidas mais distantes');
  if (viagem) {
    let ok = viagem.transfers === viagem.legs.length - 1 && viagem.arrive === viagem.legs[viagem.legs.length - 1].arrive;
    let clock = agora;
    let asfalto = 0;
    for (const leg of viagem.legs) {
      const route = network.routes[leg.route];
      const service = network.services[route.service];
      const de = route.stops.find((s) => s.station === leg.from);
      const ate = route.stops.find((s) => s.station === leg.to);
      if (!de || !ate) { ok = false; break; }
      asfalto += Math.abs(ate.at - de.at);
      if (leg.from === leg.to || leg.board < clock - 1e-9 || leg.arrive <= leg.board) { ok = false; break; }
      // A espera tem teto: com `units = ceil(ciclo/intervalo)` sempre há um carro da linha
      // passando dentro do intervalo pedido, e nenhum trecho espera mais que isso.
      if (leg.board - clock > service.headway + service.dwell) { ok = false; break; }
      clock = leg.arrive;
    }
    check(ok, 'viagem com trecho que não embarca na linha certa ou espera maior que o intervalo da frota');
    // No mesmo asfalto o ônibus tem de ganhar do pé. A linha reta do mapa não vale como
    // comparação: quem anda a pé também desvia do quarteirão.
    check(asfalto > 0 && viagem.arrive - agora < asfalto / GAME_CONFIG.PLAYER_WALK_SPEED,
      `a viagem perdeu do pé no mesmo asfalto: ${(viagem.arrive - agora).toFixed(0)}s contra `
      + `${(asfalto / GAME_CONFIG.PLAYER_WALK_SPEED).toFixed(0)}s por ${asfalto.toFixed(0)} tiles`);
    medido.push({
      seed,
      linhas: network.routes.length,
      pares: servidas.length,
      espinha: espinhaUsada,
      espacamento: +(network.routes.reduce((a, r) => a + (r.stops[r.stops.length - 1].at - r.stops[0].at), 0)
        / network.routes.reduce((a, r) => a + r.stops.length - 1, 0)).toFixed(2),
      // Segundos por tile de asfalto, na média das linhas: é aí que o ônibus compara com o pé.
      onibus_tile: +(network.routes.reduce((a, r) => a + r.cycle / (2 * r.length), 0) / network.routes.length).toFixed(3),
      pe_tile: +(1 / GAME_CONFIG.PLAYER_WALK_SPEED).toFixed(3),
      pior_d: +pior.d.toFixed(0),
      alcance: +maisLonge.toFixed(0),
      asfalto: +asfalto.toFixed(0),
      onibus: +(viagem.arrive - agora).toFixed(0),
      transferencias: viagem.legs.length - 1,
    });
  }

  // ---- 10. Portão de zonas: longe da câmera nada é materializado e o horário não derrapa
  const streaming = new WorldStreamingManager(new ChunkIndex(data));
  const camera = { ax: 12, ay: 12, zoom: 1, viewBounds: { minX: 4, maxX: 20, minY: 4, maxY: 20 } };
  // A distância que o portão usa é a do asfalto mais perto da linha, não a da caixa dela:
  // uma linha que corta o mapa inteiro tem caixa enorme e nunca estaria fora de nada.
  const maisPerto = (r, x, y) => {
    let m = Infinity;
    for (const p of r.points) {
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < m) m = d;
    }
    return m;
  };
  let distante = null;
  let piorDist = 0;
  // Anel distante é uma câmera que fica a meio caminho entre a área ativa e o streaming de
  // uma linha, sem que ela mesma passe por perto. Procura na polilinha porque a distância
  // certa depende de onde o asfalto dela está, não de onde a caixa dele começa.
  const MEIO_ANEL = (GAME_CONFIG.ACTIVE_RADIUS_TILES + GAME_CONFIG.STREAMING_RADIUS_TILES) / 2;
  const cameraNoAnel = (r) => {
    for (let i = 0; i < r.points.length; i += 7) {
      for (const [dx, dy] of [[MEIO_ANEL, 0], [-MEIO_ANEL, 0], [0, MEIO_ANEL], [0, -MEIO_ANEL]]) {
        const ax = r.points[i].x + dx, ay = r.points[i].y + dy;
        if (ax < 12 || ay < 12 || ax > data.tilesW - 12 || ay > data.tilesH - 12) continue;
        const d = maisPerto(r, ax, ay);
        if (d > GAME_CONFIG.ACTIVE_RADIUS_TILES + 4 && d < GAME_CONFIG.STREAMING_RADIUS_TILES - 4) {
          return { ax, ay, zoom: 1, viewBounds: { minX: ax - 8, maxX: ax + 8, minY: ay - 8, maxY: ay + 8 } };
        }
      }
    }
    return null;
  };
  let anel = null;
  let cameraAnel = null;
  for (const r of network.routes) {
    const d = maisPerto(r, camera.ax, camera.ay);
    if (d > piorDist) { piorDist = d; distante = r; }
    if (anel) continue;
    const c = cameraNoAnel(r);
    if (c) { anel = r; cameraAnel = c; }
  }
  check(!!distante && piorDist > GAME_CONFIG.STREAMING_RADIUS_TILES,
    `nenhuma linha nasce longe da câmera para testar o portão (a mais afastada tem asfalto a ${piorDist.toFixed(0)} tiles)`);
  check(!!anel, 'nenhuma linha tem câmera no anel distante para testar o throttle');
  streaming.update(camera);
  if (distante) {
    const unidades = system.units.filter((u) => u.route === distante.id);
    const congeladas = unidades.map((u) => ({ ...u }));
    system.update(system.clock + 240, camera.ax, camera.ay, streaming);
    check(unidades.every((u, i) => u.x === congeladas[i].x && u.y === congeladas[i].y),
      'linha fora do streaming teve posição recalculada');
    check(unidades.every((u) => u.live === false), 'linha longe da câmera marcada como viva');
  }
  if (anel && cameraAnel) {
    // No anel a linha não aparece na tela, mas o horário anda um a cada
    // `VEHICLE_SIM_TICK_DIVISOR` frames: um frame move uma parte, quatro frames movem todas.
    streaming.update(cameraAnel);
    const unidades = system.units.filter((u) => u.route === anel.id);
    if (unidades.length >= GAME_CONFIG.VEHICLE_SIM_TICK_DIVISOR) {
      const antes = unidades.map((u) => ({ ...u }));
      system.update(system.clock + 1 / 60, cameraAnel.ax, cameraAnel.ay, streaming);
      check(unidades.some((u, i) => u.x !== antes[i].x || u.y !== antes[i].y),
        'anel distante não materializou nenhuma unidade no frame');
      check(unidades.some((u, i) => u.x === antes[i].x && u.y === antes[i].y),
        'anel distante materializou tudo no mesmo frame: não há throttle');
      for (let i = 0; i < GAME_CONFIG.VEHICLE_SIM_TICK_DIVISOR; i++) {
        system.update(system.clock + 1 / 60, cameraAnel.ax, cameraAnel.ay, streaming);
      }
      check(unidades.every((u) => !u.live), 'linha do anel distante apareceu na tela');
      check(unidades.every((u) => {
        const e = sampleRoute(anel, network.services[anel.service], system.clock, u.unit);
        // No anel a unidade é reposicionada um a cada `VEHICLE_SIM_TICK_DIVISOR` frames, então
        // ela pode estar até três frames atrasada do relógio — nunca um quadros de distância
        // no asfalto. O que o throttle corta é o custo do tick, não a verdade da posição.
        const atraso = network.services[anel.service].speed
          * GAME_CONFIG.VEHICLE_SIM_TICK_DIVISOR / 60;
        return Math.hypot(e.x - u.x, e.y - u.y) <= atraso + 1e-6;
      }), 'anel distante ficou para trás mais do que o throttle permite');
    }
  }
  if (distante) {
    // A câmera vai até o asfalto mais perto da linha: ela reaparece no instante exato do
    // relógio. Congelar não é atrasar — é não calcular, e quando volta a conta já estava feita.
    const ponto = distante.points.reduce((a, p) =>
      Math.hypot(p.x - camera.ax, p.y - camera.ay) < Math.hypot(a.x - camera.ax, a.y - camera.ay) ? p : a);
    streaming.update({
      ...camera, ax: ponto.x, ay: ponto.y,
      viewBounds: { minX: ponto.x - 8, maxX: ponto.x + 8, minY: ponto.y - 8, maxY: ponto.y + 8 },
    });
    system.update(0.016, ponto.x, ponto.y, streaming);
    const vivo = system.units.filter((u) => u.route === distante.id).find((u) => u.live);
    check(!!vivo, 'linha voltou para a câmera e continua morta');
    if (vivo) {
      const esperado = sampleRoute(distante, network.services[distante.service], system.clock, vivo.unit);
      check(Math.hypot(esperado.x - vivo.x, esperado.y - vivo.y) < 1e-6,
        'linha congelada voltou fora do horário');
    }
  }
}

// ---- 11. Determinismo: a mesma semente devolve a mesma malha, outra semente devolve outra
const data = generateCity(WORLD_SEED);
const map = new CityMap(data);
const uma = fingerprint(buildTransportNetwork(map, WORLD_SEED));
const duas = fingerprint(buildTransportNetwork(map, WORLD_SEED));
check(uma === duas, 'a mesma semente derivou duas malhas diferentes');
const outra = fingerprint(buildTransportNetwork(map, WORLD_SEED ^ 0x5eed));
check(outra !== uma, 'trocar a semente não mudou nada: a rota não depende do mundo');
const porSemente = new Map();
for (const seed of [WORLD_SEED, 42, 7]) {
  const d = generateCity(seed);
  const n = buildTransportNetwork(new CityMap(d), seed);
  porSemente.set(seed, `${n.nodes.length}/${n.edges.length}/${n.stations.length}/${n.routes.length}`);
}

console.log(`malha: ${[...porSemente].map(([s, v]) => `seed ${s} -> nós ${v.split('/')[0]}, faixas ${v.split('/')[1]}, paradas ${v.split('/')[2]}, linhas ${v.split('/')[3]}`).join(' · ')}`);
for (const m of medido) {
  console.log(`medido seed ${m.seed}: ${m.linhas} linhas, ${m.pares} paradas servidas `
    + `(${m.espinha} cruzando pela espinha) · parada a cada ${m.espacamento} tiles · `
    + `cruzamento mais longe a ${m.alcance} tiles de uma parada servida · `
    + `${m.onibus_tile}s por tile de ônibus contra ${m.pe_tile}s a pé · `
    + `ponta a ponta: ${m.asfalto} tiles de asfalto em ${m.onibus}s com ${m.transferencias} transbordo(s)`);
}
if (failures.length) {
  for (const f of failures) console.error(`FALHA: ${f}`);
  console.error(`Transporte: ${passed} passaram, ${failures.length} falharam`);
  process.exit(1);
}
console.log(`Transporte: ${passed} passaram, 0 falharam`);
