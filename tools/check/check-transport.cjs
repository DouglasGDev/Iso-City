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
const { BOARDING_DOOR, BOARDING_REACH, buildTransportNetwork, fleetLabel, fleetNumber, naPlataforma, plataformaDaLinha, RAIO_DO_ONIBUS, seEncostam } = load(path.join(root, 'src/data/transport/network.ts'));
const { sampleRoute, alongRoute, stopsNear } = load(path.join(root, 'src/data/transport/schedule.ts'));
const { TransportSystem, FILA_DO_PONTO, FOLGA_PARA_CHOQUE } = load(path.join(root, 'src/systems/TransportSystem.ts'));
const { TrafficSignalSystem } = load(path.join(root, 'src/systems/TrafficSignalSystem.ts'));
const { DayNightSystem } = load(path.join(root, 'src/systems/DayNightSystem.ts'));
const { spriteKeyForVehicle, isKnownAsset } = load(path.join(root, 'src/assets/AssetRegistry.ts'));
const { VEHICLE_DEFS } = load(path.join(root, 'src/data/vehicles.ts'));

let passed = 0;
const failures = [];
const medido = [];
/** Geometria da porta por semente: a calçada mais longe do ônibus parado que ela serve. */
const portas = [];
/** Geometria do hall por semente: a porta da rodoviária mais longe da própria calçada de embarque. */
const calçadas = [];
/** A viagem cumprida por semente: os segundos que o corpo andou, esperou e rodou de verdade. */
const viagens = [];
/** O quanto as linhas se repetem por semente: pares que dividem asfalto no mesmo sentido e a via mais disputada. */
const rotasDistintas = [];
/** As baias do pátio por semente: o que a rodoviária tem de plataforma, guichê e porta própria. */
const plataformasMedidas = [];
/** A frota pintada por semente: quantos ônibus, quantas viações e que matrículas existem. */
const frotaMedidas = [];
function check(ok, message) {
  if (ok) passed++;
  else failures.push(message);
}

const ARTERIAS = ['highway', 'avenue', 'street', 'residential', 'access'];

/**
 * Verdade de geometria, medida por fora da régua da regra: os dois retângulos de lataria se
 * encostaram de fato? A frenagem olha os eixos de quem freia e projeta o vizinho neles, o que
 * é conservador de propósito — para não deixar duas latarias se atravessarem, é melhor frear
 * diante de um encontro que ainda é hipótese. A pergunta aqui é outra e ela precisa dos quatro
 * eixos dos dois retângulos: um ônibus que curva à frente do outro tem eixos próprios, e no eixo
 * dele pode haver rua sobrando onde o eixo do primeiro já via lataria em cima.
 */
const MEIA_LARGURA_DO_ONIBUS = Math.min(VEHICLE_DEFS.bus_school.footprintW,
  VEHICLE_DEFS.bus_school.footprintH) / 2;
function meiaProjeto(c, ex, ey) {
  return RAIO_DO_ONIBUS * Math.abs(ex * Math.cos(c.angle) + ey * Math.sin(c.angle))
    + MEIA_LARGURA_DO_ONIBUS * Math.abs(-ex * Math.sin(c.angle) + ey * Math.cos(c.angle));
}
/**
 * Quanto de rua ainda separa as duas latarias, no eixo que separa mais: positivo é folga,
 * negativo é o quanto uma caixa já comeu da outra. Pelo teorema do eixo separador, basta um
 * dos quatro eixos com folga positiva para as duas lataria serem duas, e é esse eixo que a
 * régua mede — o toque é o zero dela, visto do lado de dentro.
 */
function folgaEntre(a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  let folga = -Infinity;
  for (const c of [a, b]) {
    const cos = Math.cos(c.angle), sin = Math.sin(c.angle);
    for (const [ex, ey] of [[cos, sin], [-sin, cos]]) {
      const f = Math.abs(dx * ex + dy * ey)
        - (meiaProjeto(a, ex, ey) + meiaProjeto(b, ex, ey));
      if (f > folga) folga = f;
    }
  }
  return folga;
}
function latariaComLataria(a, b) {
  return folgaEntre(a, b) < 0;
}

/**
 * As duas funções acima são a régua de dois ônibus: meia-lataria de ônibus dos dois lados. A rua
 * entrega corpos do tamanho deles — um pedestre é um círculo de quinze centésimos, um sedã é mais
 * curto e mais estreito — e medir um pedestre com a caixa do ônibus abriria a faixa em meio tile
 * para cada lado, que é o erro contrário: o check diria que a lataria passou por cima de alguém
 * quando passou a um tile de distância. Esta é a mesma separação pelo teorema do eixo separador,
 * com a lataria lida do próprio corpo.
 */
function meiaProjetoDe(c, ex, ey) {
  const cos = Math.cos(c.angle), sin = Math.sin(c.angle);
  return c.meio * Math.abs(ex * cos + ey * sin)
    + c.flanco * Math.abs(-ex * sin + ey * cos);
}
function folgaEntreCaixas(a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  let folga = -Infinity;
  for (const c of [a, b]) {
    const cos = Math.cos(c.angle), sin = Math.sin(c.angle);
    for (const [ex, ey] of [[cos, sin], [-sin, cos]]) {
      const f = Math.abs(dx * ex + dy * ey)
        - (meiaProjetoDe(a, ex, ey) + meiaProjetoDe(b, ex, ey));
      if (f > folga) folga = f;
    }
  }
  return folga;
}

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

  // ---- 4b) Rotas distintas. A régua é a de quem está na calçada, não a do gerador: duas linhas
  //          que rodam o mesmo asfalto NO MESMO SENTIDO são a mesma rota — um ônibus passa e o
  //          outro passa atrás, no mesmo meio-fio, e é isso que o jogador chama de "todos fazem
  //          a mesma rota". Por isso a ida de cada linha é confrontada faixa por faixa com a ida
  //          das outras: a avenida inteira não vale como prova, porque uma perna curta pode
  //          encostar na avenida da troncal em uma esquina e ainda ser outra rota.
  const idaDe = network.routes.map((r) => {
    const faixas = new Set();
    for (let i = 0; i + 1 < r.points.length; i++) {
      const ang = Math.atan2(r.points[i + 1].y - r.points[i].y, r.points[i + 1].x - r.points[i].x);
      const octante = ((Math.round(ang / (Math.PI / 4)) % 8) + 8) % 8;
      faixas.add(`${Math.floor(r.points[i].x)},${Math.floor(r.points[i].y)},${octante}`);
    }
    return faixas;
  });
  let dividem = 0, piorPar = { frac: 0, nome: 'nenhuma' };
  for (let a = 0; a < idaDe.length; a++) {
    for (let b = a + 1; b < idaDe.length; b++) {
      let c = 0;
      for (const k of idaDe[a]) if (idaDe[b].has(k)) c++;
      if (!c) continue;
      dividem++;
      const frac = c / Math.min(idaDe[a].size, idaDe[b].size);
      if (frac > piorPar.frac) {
        piorPar = { frac, nome: `${network.routes[a].name} e ${network.routes[b].name}, ${c} tiles` };
      }
    }
  }
  check(piorPar.frac <= 0.6,
    `duas linhas fazem a mesma rota: ${piorPar.nome} dividem ${(100 * piorPar.frac).toFixed(0)}% `
    + 'do trajeto no mesmo sentido');

  // Nenhum corredor vira tapete de ônibus. A conta é por VIA e não por faixa porque a avenida é
  // o que se vê de longe: dez linhas na mesma avenida são dez ônibus em fila, ainda que cada um
  // corra num trecho diferente dela.
  const carga = new Map();
  for (const r of network.routes) {
    for (const via of new Set(r.edges.map((e) => network.edges[e].road))) {
      carga.set(via, (carga.get(via) || 0) + 1);
    }
  }
  const cargaMax = Math.max(...carga.values());
  check(cargaMax <= 8, `${cargaMax} linhas dividem o mesmo corredor`);
  rotasDistintas.push({ seed, dividem, pior: +(100 * piorPar.frac).toFixed(0), cargaMax });

  // ---- 5. Toda via da malha é de um corredor contíguo, e o posto carimbado do mapa está na malha
  const postosMapa = new Set();
  for (const t of data.tiles) if (t.kind === 'road' && t.rank) postosMapa.add(t.rank);
  const postosMalha = new Set(network.roads.map((r) => r.rank));
  check([...postosMapa].every((r) => postosMalha.has(r)),
    `posto do mapa sem via na malha: ${[...postosMapa].filter((r) => !postosMalha.has(r)).join(',')}`);
  check([...postosMalha].every((r) => ARTERIAS.includes(r)), 'via da malha com posto que não é da hierarquia');

  // ---- 6. Linha de ônibus: sem acesso, rodovia só onde não há caminho sem ela, as duas
  //         metades em faixas opostas e o horário das duas polilinhas fechado.
  // A malha que uma linha pode percorrer é a de mão dupla: uma faixa sem gêmea no mesmo
  // corredor não é um desvio que a linha deixou de tomar, é uma rua por onde ela jamais iria
  // e voltaria. Medir o "caminho sem a rodovia" com faixas que a linha não pode usar
  // acusaria de escolha o que é construção do mapa.
  const semEspinha = network.nodes.map(() => []);
  for (const e of network.edges) {
    if (e.rank === 'highway' || e.rank === 'access') continue;
    if (network.twin[e.id] < 0) continue;
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
  /** A régua de um sentido: vértices colados e distância acumulada fechando no fim. */
  const régua = (poly, cum, total) => {
    let soma = 0;
    for (let i = 1; i < poly.length; i++) {
      const d = Math.hypot(poly[i].x - poly[i - 1].x, poly[i].y - poly[i - 1].y);
      if (d > 1.6) return `salto de ${d.toFixed(2)} tiles entre vértices vizinhos`;
      soma += d;
    }
    if (Math.abs(soma - total) > 1e-6) {
      return `tiles somados ${soma.toFixed(3)} contra régua ${total.toFixed(3)}`;
    }
    if (Math.abs(cum[cum.length - 1] - total) > 1e-6) return 'régua não fecha no último vértice';
    return '';
  };
  let espinhaUsada = 0;
  const postosNasRotas = new Set();
  for (const r of network.routes) {
    const rot = (m) => `${m} (linha ${r.name})`;
    for (const id of r.edges) postosNasRotas.add(network.edges[id].rank);
    // Acesso é o asfalto do terminal, e ninguém pisa nele de passagem: a boca do pátio já está
    // resolvida quando o Dijkstra entra na caixa de manobra, então voltar pela faixa gêmea seria
    // revisitar um nó `done`. Uma linha que corre por cima de um `access` sem morrer lá dentro
    // é a malha tendo usado a quadra exclusiva como atalho — o que o desenho inteiro evita.
    const morreNoPátio = [r.stops[0], r.stops[r.stops.length - 1]]
      .some((s) => s && network.stations[s.station]?.terminal === true);
    check(!r.ranks.includes('access') || morreNoPátio,
      rot('corre por uma via de acesso sem terminar dentro do terminal'));
    const S = r.stops.length;
    check(S >= 3 && r.table.length === 2 * S, rot(`tabela sem o espelho das ${S} calçadas`));
    if (S < 3 || r.table.length !== 2 * S) continue;
    const service = network.services[r.service];
    const de = network.stations[r.stops[0].station].node;
    const ate = network.stations[r.stops[S - 1].station].node;
    if (r.ranks.includes('highway')) {
      // A espinha só atravessa o rio: se a malha de mão dupla ligava as duas pontas por outro
      // lado, a linha escolheu a rodovia por escolha, não por necessidade.
      check(!alcance(de, ate), rot('usa rodovia havendo caminho sem ela'));
      espinhaUsada++;
    }
    check(r.stops.every((s) => network.stations[s.station]), rot('parada que não é uma estação'));
    check(r.stops.every((s, i) => i === 0 || s.at > r.stops[i - 1].at),
      rot('ida com parada fora da ordem da própria polilinha'));
    // Na volta as mesmas calçadas aparecem de trás para frente, então a distância dela
    // DECRESCE com o índice. Volta crescente é o ônibus percorrendo a faixa contrária na
    // ordem da ida — o espelho exato da contramão que o jogador vê.
    check(r.stops.every((s, i) => i === 0 || s.voltaAt < r.stops[i - 1].voltaAt),
      rot('volta com parada fora da ordem da polilinha contrária'));
    check(r.stops[0].at === 0 && Math.abs(r.stops[S - 1].at - r.length) < 1e-6,
      rot('ida que não nasce no virador de origem nem morre no de destino'));
    // A volta encosta entre o zero e o fim da própria polilinha. Os dois terminais podem parar
    // no tile da travessia — é ali que a linha dá meia-volta, e a ida já encosta no mesmo ponto,
    // um ônibus de cada vez. Uma parada do MEIO da rota nesse tile seria o ônibus plantado em
    // cima da meia-lua da curva, no meio do cruzamento.
    check(r.stops.every((s, i) => s.voltaAt >= 0 && s.voltaAt <= r.backLength + 1e-6
      && (i === 0 || i === S - 1 || (s.voltaAt > 0 && s.voltaAt < r.backLength))),
      rot('volta parado fora do comprimento da própria polilinha'));
    check(r.table.every((e, i) => i === 0 || e.time > r.table[i - 1].time), rot('horário que não cresce'));
    check(Math.abs(r.table[2 * S - 1].time + service.dwell + r.layover - r.cycle) < 1e-9,
      rot('ciclo que não fecha na última calçada da volta (com o descanso do berço)'));
    for (let i = 0; i < S; i++) {
      check(r.table[i].dist === r.stops[i].at, rot('passada de ida com distância de outra polilinha'));
      check(r.table[2 * S - 1 - i].dist === r.stops[i].voltaAt,
        rot('passada espelhada com distância da ida, quando é a volta que a percorre'));
    }
    check(!régua(r.points, r.cum, r.length), rot(`polilinha da ida: ${régua(r.points, r.cum, r.length)}`));
    check(!régua(r.back, r.backCum, r.backLength), rot(`polilinha da volta: ${régua(r.back, r.backCum, r.backLength)}`));
    // Os dois sentidos só se encontram nos dois viradores. Um tile de faixa dividido no meio
    // da quadra são os dois ônibus da mesma linha passando lado a lado pelo mesmo lado da rua.
    const asfaltoIda = new Set(r.points.filter((p) => p.tile >= 0).map((p) => p.tile));
    const asfaltoVolta = new Set(r.back.filter((p) => p.tile >= 0).map((p) => p.tile));
    let divididos = 0;
    for (const t of asfaltoIda) if (asfaltoVolta.has(t)) divididos++;
    check(divididos === 2, rot(`ida e volta dividem ${divididos} tiles de faixa, quando só os dois viradores seriam dos dois`));
    // Andar a pé custa 1/1,85 s por tile no mesmo asfalto. O ciclo gasta a polilinha da ida E
    // a da volta, então é a soma das duas que mede o ônibus contra o pé. Uma linha que custa
    // mais que o pé não é transporte, é um ônibus turístico parado em cada esquina.
    check(r.cycle / (r.length + r.backLength) < 1 / GAME_CONFIG.PLAYER_WALK_SPEED,
      rot(`perde do pé: ${r.cycle.toFixed(1)}s por ${(r.length + r.backLength).toFixed(0)} tiles`));
    // O intervalo publicado é o que a frota paga, não o que o papel pediria: `units` tem teto
    // de garagem, e passar dele é a linha rodar com o intervalo dos veículos que tem. A régua
    // antiga — "sempre mais curto que o `headway` do serviço" — é justamente o que lotava a
    // cidade: sem teto, toda linha pedia `ciclo/18` veículos e a malha fechava com 213 ônibus.
    check(r.units >= 1 && Math.abs(r.headway - r.cycle / r.units) < 1e-6,
      rot('intervalo publicado que não é o que a frota da linha paga'));
    check(r.units <= (r.role === 'troncal' ? 7 : r.role === 'arterial' ? 5 : 4),
      rot(`frota acima do teto do papel ${r.role}: ${r.units}`));
    // Uma rede de verdade tem ritmos diferentes: a avenida com ônibus seguido, o bairro com
    // ônibus raro. Vinte linhas com o mesmo intervalo é o "todos fazem a mesma coisa" que o
    // jogador vê, e é o que a malha tinha antes dos papéis.
    check(r.headway >= 12 && r.headway <= 120,
      rot('intervalo fora do que uma linha de ônibus publica: ' + r.headway.toFixed(1) + 's'));
  }
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

  // ---- 8. Horário analítico: o ciclo fecha, a parada fica parada e o veículo não sai da
  //         rua — nem da faixa em que a ida corre, nem da contrária por onde volta.
  for (const r of network.routes) {
    const rot = (m) => `${m} (linha ${r.name})`;
    const service = network.services[r.service];
    let fechado = true;
    let colado = true;
    let naVolta = 0;
    let doOutroLado = 0;
    for (let unit = 0; unit < r.units && fechado; unit++) {
      const a = sampleRoute(r, service, 12.5, unit);
      const b = sampleRoute(r, service, 12.5 + r.cycle, unit);
      if (Math.hypot(a.x - b.x, a.y - b.y) > 1e-6) fechado = false;
      for (let t = 0; t < r.cycle; t += Math.max(0.4, r.cycle / 90)) {
        const s = sampleRoute(r, service, t, unit);
        let ida = Infinity, volta = Infinity;
        for (const p of r.points) ida = Math.min(ida, Math.hypot(p.x - s.x, p.y - s.y));
        for (const p of r.back) volta = Math.min(volta, Math.hypot(p.x - s.x, p.y - s.y));
        if (Math.min(ida, volta) > 0.9) { colado = false; break; }
        // Duas faixas gêmeas de um mesmo corredor ficam a um tile de asfalto uma da outra. A
        // volta que corre na contrária passa longe da polilinha da ida; a volta que corre na
        // própria faixa passa em cima dela, e é isso que o jogador vê quando o ônibus vem de
        // frente no lado errado da rua.
        if (s.dir === -1 && !s.stopped) { naVolta++; if (ida > 0.8) doOutroLado++; }
      }
    }
    check(fechado, rot('horário que não fecha o ciclo'));
    check(colado, rot('veículo que largou as duas polilinhas da linha'));
    check(naVolta > 0 && doOutroLado > naVolta * 0.4,
      rot('volta que não corre na faixa contrária: só ' + doOutroLado + ' de ' + naVolta + ' amostras do outro lado'));
    // Na janela de embarque o veículo não anda: é a calçada, não um ponto do trajeto. O
    // instante lê o descompasso da linha — sem ele o veículo 0 de uma linha defasada está em
    // outro lugar do ciclo, e a régua cobraria parada onde o horário não tem parada.
    const parado = sampleRoute(r, service, r.phase + r.table[0].time + service.dwell / 2, 0);
    check(parado.stopped && Math.hypot(parado.x - r.points[0].x, parado.y - r.points[0].y) < 1e-6,
      rot('anda durante a parada na calçada de origem'));
    const antes = sampleRoute(r, service, r.phase + r.turnAt - 1, 0);
    const depois = sampleRoute(r, service, r.phase + r.turnAt + service.dwell + 1, 0);
    check(antes.dir === 1 && depois.dir === -1, rot('virador de terminal que não inverte o sentido'));
    // O descompasso existe para as linhas não chegarem juntas ao mesmo cruzamento, mas ele não
    // pode mover o horário: a mesma passada lida em dois instantes separados por um ciclo tem de
    // devolver o mesmo ponto. É a contraparte da conta fechada, e é ela que o `phase` quebraria
    // se entrasse como estado em vez de offset.
    const fase = sampleRoute(r, service, r.phase + 7.5, 0);
    const faseDuas = sampleRoute(r, service, r.phase + 7.5 + r.cycle, 0);
    check(Math.hypot(fase.x - faseDuas.x, fase.y - faseDuas.y) < 1e-6,
      rot('descompasso que não é periódico com o ciclo'));
    // Uma linha que morre no pátio descansa no berço: a última passada fica parada o ciclo
    // inteiro do descanso, e é isso que põe ônibus estacionado dentro da rodoviária.
    if (r.layover > 0) {
      const última = 2 * r.stops.length - 1;
      const descanso = sampleRoute(r, service, r.phase + r.table[última].time
        + service.dwell + r.layover / 2, 0);
      check(descanso.stopped && descanso.dir === -1
        && Math.hypot(descanso.x - r.back[r.back.length - 1].x, descanso.y - r.back[r.back.length - 1].y) < 1e-6,
        rot('descanso de pátio que não deixa o ônibus parado no berço'));
      check(r.role === 'rodoviaria', rot('linha com descanso que não é de rodoviária'));
    }
  }
  check(alongRoute(network.routes[0], 0, 1).x === network.routes[0].points[0].x, 'alongRoute não começa na origem');
  // A origem da volta é o virador do destino: as duas polilinhas têm de se encontrar lá, e é
  // por isso que `alongRoute` escolhe a polilinha pelo sentido, não pelo sinal do vetor.
  check(alongRoute(network.routes[0], 0, -1).x === network.routes[0].back[0].x,
    'alongRoute na volta não começa no virador do destino');

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
    if (list.some((a) => a.in > 4 * network.routes[a.route].headway)) { esperasOk = false; break; }
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
      const i = route.stops.indexOf(de), j = route.stops.indexOf(ate);
      // O trecho percorre uma das duas metades, e pode virar o terminal no meio: embarca na
      // ida e desce na volta, ou o contrário. Cada interpretação tem um asfalto e um número de
      // calçadas atravessadas próprios — e é o par dos dois que tem de bater com o tempo que
      // o horário cobrou. Somar `|ate.at - de.at|` mediria a ida de um trecho rodado na volta.
      // Na volta o `dist` CRESCER com o tempo, porque é o índice da parada que decresce.
      const S = route.stops.length;
      const formas = [
        { d: j > i ? ate.at - de.at : route.length - de.at + ate.voltaAt,
          k: j > i ? j - i : (2 * S - 1 - j) - i },
        { d: j < i ? ate.voltaAt - de.voltaAt : route.backLength - de.voltaAt + ate.at,
          k: j < i ? i - j : i + j + 1 },
      ];
      const prevista = (f) => f.d / service.speed + f.k * service.dwell;
      const trilha = Math.abs(prevista(formas[0]) - (leg.arrive - leg.board))
        < Math.abs(prevista(formas[1]) - (leg.arrive - leg.board)) ? formas[0] : formas[1];
      check(Math.abs(prevista(trilha) - (leg.arrive - leg.board)) < 1e-5,
        `trecho da ${route.name} cobrou ${(leg.arrive - leg.board).toFixed(1)}s por um asfalto de `
        + `${trilha.d.toFixed(1)} tiles que custa ${prevista(trilha).toFixed(1)}s`);
      asfalto += trilha.d;
      if (leg.from === leg.to || leg.board < clock - 1e-9 || leg.arrive <= leg.board) { ok = false; break; }
      // A espera tem teto: com a frota do papel sempre há um carro da linha passando dentro do
      // intervalo que ela publica, e nenhum trecho espera mais que isso. É o intervalo *da
      // linha*, não o do serviço: a rua do bairro roda a cada 45 s e a régua tem de cobrar a
      // verdade daquela linha, senão o check reprova um horário que está certo.
      if (leg.board - clock > route.headway + service.dwell) { ok = false; break; }
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
      // O ciclo gasta as duas polilinhas, a da ida e a contrária da volta.
      onibus_tile: +(network.routes.reduce((a, r) => a + r.cycle / (r.length + r.backLength), 0) / network.routes.length).toFixed(3),
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
  // uma linha que corta o mapa inteiro tem caixa enorme e nunca estaria fora de nada. E o
  // asfalto dela são duas faixas — a ida e a contrária por onde a volta corre —, porque um
  // carro parado na volta é tão visível quanto um parado na ida.
  const maisPerto = (r, x, y) => {
    let m = Infinity;
    for (const p of r.points) {
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < m) m = d;
    }
    for (const p of r.back) {
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
    for (const poly of [r.points, r.back]) {
      for (let i = 0; i < poly.length; i += 7) {
        for (const [dx, dy] of [[MEIO_ANEL, 0], [-MEIO_ANEL, 0], [0, MEIO_ANEL], [0, -MEIO_ANEL]]) {
          const ax = poly[i].x + dx, ay = poly[i].y + dy;
          if (ax < 12 || ay < 12 || ax > data.tilesW - 12 || ay > data.tilesH - 12) continue;
          const d = maisPerto(r, ax, ay);
          if (d > GAME_CONFIG.ACTIVE_RADIUS_TILES + 4 && d < GAME_CONFIG.STREAMING_RADIUS_TILES - 4) {
            return { ax, ay, zoom: 1, viewBounds: { minX: ax - 8, maxX: ax + 8, minY: ay - 8, maxY: ay + 8 } };
          }
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
        // O relógio de um ônibus parado na fila é `clock - atraso`, e é esse relógio que o
        // throttle reposiciona: comparar com o relógio cru mediria a fila da rua, não o
        // descompasso do tick. Congelado ou atrasado, o corpo está onde a própria conta manda.
        const e = sampleRoute(anel, network.services[anel.service], system.clock - u.atraso, u.unit);
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
    const ponto = distante.points.concat(distante.back).reduce((a, p) =>
      Math.hypot(p.x - camera.ax, p.y - camera.ay) < Math.hypot(a.x - camera.ax, a.y - camera.ay) ? p : a);
    streaming.update({
      ...camera, ax: ponto.x, ay: ponto.y,
      viewBounds: { minX: ponto.x - 8, maxX: ponto.x + 8, minY: ponto.y - 8, maxY: ponto.y + 8 },
    });
    system.update(0.016, ponto.x, ponto.y, streaming);
    const vivasA = new Set(system.units.filter((u) => u.route === distante.id && u.live)
      .map((u) => u.unit));
    check(vivasA.size > 0, 'linha voltou para a câmera e continua morta');
    // Um quadro depois de entrar em cena, o corpo que nasceu empurrado para o primeiro buraco
    // de asfalto já foi reescrito pelo próprio horário: o `descolaDaRua` só vale no primeiro
    // quadro. O que pode continuar fora da conta é a fila do ponto, e ela anda sempre ao longo
    // da própria faixa — relógio nenhum move um ônibus parado, então o `encaixaNaDoca` empurra
    // lataria parada pela calçada adiante. Andar na transversal é cair fora da faixa, e andar
    // mais do que a fila do ponto é o corpo ter vindo de um relógio que a cena não mostra.
    system.update(system.clock + 1 / 60, ponto.x, ponto.y, streaming);
    const andada = FILA_DO_PONTO * (2 * RAIO_DO_ONIBUS + FOLGA_PARA_CHOQUE);
    // O corpo é escrito pelo relógio *do quadro*, e a dívida do quadro anterior é lida junto: no
    // topo do laço a amostra é `time - atraso - dt*(1 - marcha realizada)`, porque o `time` já
    // andou um passo inteiro enquanto o ônibus plantado não andou nada. Comparar com o relógio
    // puro cobrança, portanto, um ônibus que dosou o pé no quadro anterior — meia marcha lida
    // atrás é meio passo de asfalto fora da conta. A compensação entra aqui com a marcha que o
    // próprio sistema mediu, senão o que se testa é o atraso de um frame, não a lataria.
    const service = network.services[distante.service];
    // Falta ainda o aperto do quadro que está acontecendo: `atraso` cresce depois de o corpo ser
    // escrito, e um segundo de atraso por segundo de freio é exatamente um passo de marcha para
    // trás — a lataria só alcança o relógio novo no quadro seguinte. Essa metade não é lida de
    // fora, então a régua é o teto dela: um passo de marcha atrás é o máximo que um corpo em
    // freio pode dever ao próprio relógio, e nada além disso tem explicação.
    const umPasso = service.speed / 60;
    let desviou = null;
    for (const u of system.units) {
      if (u.route !== distante.id || !u.live || !vivasA.has(u.unit)) continue;
      const deve = (1 / 60) * (1 - system.marchava[system.units.indexOf(u)]);
      const esperado = sampleRoute(distante, service, system.clock - u.atraso - deve, u.unit);
      const dx = u.x - esperado.x, dy = u.y - esperado.y;
      const cos = Math.cos(esperado.angle), sin = Math.sin(esperado.angle);
      const longo = dx * cos + dy * sin;
      const lado = -dx * sin + dy * cos;
      const emFila = u.stopped && longo >= -1e-6 && longo <= andada + 1e-6;
      const pagandoOMesmoQuadro = longo >= -umPasso - 1e-6 && longo <= 1e-6;
      if (Math.abs(lado) > 1e-6 || (!emFila && !pagandoOMesmoQuadro)) {
        desviou = { unit: u.unit, parado: u.stopped, longo, lado };
        break;
      }
    }
    check(!desviou, desviou
      ? `linha congelada voltou fora do horário: unidade ${desviou.unit} `
        + `${desviou.parado ? 'parada' : 'em marcha'} a ${desviou.longo.toFixed(2)} tiles no eixo da `
        + `faixa e ${desviou.lado.toFixed(2)} na transversal (fila de até ${andada.toFixed(1)} tiles, `
        + `passo de marcha de ${umPasso.toFixed(3)})`
      : 'linha congelada voltou fora do horário');
  }

  // ---- 10b. O ônibus que aparece na tela: quadrante dentro do ângulo, nenhum volteio em reta
  // e a arte que o sprite vai pedir existe de verdade nos quatro sentidos.
  {
    const CENTRO = { SE: 0, SW: Math.PI / 2, NW: Math.PI, NE: -Math.PI / 2 };
    const angDist = (a, b) => Math.abs(((a - b + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI);
    check(system.units.length > 0 && system.units.length <= 400,
      `a varredura de unidades do render saiu do tamanho de uma lista curta: ${system.units.length}`);

    // Sem `streaming` a câmera não gating nada: todo horário é amostrado no mesmo instante, e
    // o que se compara é a arte escolhida contra o ângulo que acabou de ser lido do relógio.
    const linha = network.routes[0];
    const doMeio = linha.points[Math.floor(linha.points.length / 2)];
    system.update(system.clock + 1 / 60, doMeio.x, doMeio.y);
    let quadranteOk = true;
    for (const u of system.units) {
      if (!CENTRO.hasOwnProperty(u.dir) || angDist(u.angle, CENTRO[u.dir]) > Math.PI / 4 + 0.16) {
        quadranteOk = false;
        break;
      }
    }
    check(quadranteOk, 'unidade desenhada num quadrante que não é o do seu ângulo de viagem');

    const passo = 0.15;
    const minhas = system.units.filter((u) => u.route === linha.id);
    const ultimoAngulo = new Map(minhas.map((u) => [u.unit, null]));
    const dirNaReta = new Map(minhas.map((u) => [u.unit, null]));
    let trepidação = false;
    for (let t = 0; t < linha.cycle; t += passo) {
      system.update(t, doMeio.x, doMeio.y);
      for (const u of minhas) {
        const anterior = ultimoAngulo.get(u.unit);
        if (anterior !== null && Math.abs(u.angle - anterior) < 1e-9) {
          // Reta de verdade: o mesmo ângulo por dois passos seguidos não pode trocar de arte.
          if (dirNaReta.get(u.unit) === null) dirNaReta.set(u.unit, u.dir);
          else if (dirNaReta.get(u.unit) !== u.dir) trepidação = true;
        } else {
          dirNaReta.set(u.unit, u.dir);
        }
        ultimoAngulo.set(u.unit, u.angle);
      }
    }
    check(!trepidação, `o sprite do ônibus troca de quadrante no meio de uma reta (linha ${linha.name})`);

    const arteOk = ['SE', 'SW', 'NW', 'NE'].every((d) =>
      isKnownAsset(spriteKeyForVehicle(VEHICLE_DEFS.bus_school, '', d, 0)));
    check(arteOk, 'a linha terrestre pede um ônibus que não está no catálogo de artes');

    // O que a varredura do render paga por quadro: o tamanho da lista, e o que o portão de
    // zona deixa existir com a câmera plantada no meio de uma linha.
    streaming.update({ ax: doMeio.x, ay: doMeio.y, zoom: 1,
      viewBounds: { minX: doMeio.x - 8, maxX: doMeio.x + 8, minY: doMeio.y - 8, maxY: doMeio.y + 8 } });
    system.update(system.clock + 1 / 60, doMeio.x, doMeio.y, streaming);
    console.log(`ônibus seed ${seed}: ${system.units.length} unidades na malha · `
      + `${system.units.filter((u) => u.live).length} materializadas com a câmera na linha ${linha.name}`);
  }

  // ---- 10c. O §3b: a cadeia inteira do passageiro, do ponto de ônibus ao passeio da chegada.
  // Nada aqui é método privado espiado de fora — é o que o `GameState` chama, na mesma ordem.
  {
    const { createPlayer, isAboard } = load(path.join(root, 'src/entities/Player.ts'));
    const { CollisionSystem } = load(path.join(root, 'src/systems/CollisionSystem.ts'));
    const collision = new CollisionSystem();
    const player = createPlayer(12, 12);

    // Sem `streaming` nenhuma linha é cortada: o que se encontra aqui é o horário da cidade
    // inteira, não o recorte de uma tela.
    const anchor = network.routes[0].points[Math.floor(network.routes[0].points.length / 2)];
    let indice = -1;
    for (let t = 0; t < 40 && indice < 0; t += 0.05) {
      system.update(t, anchor.x, anchor.y);
      // `stopped` não basta: a última passada de uma linha é o ônibus encostando no próprio
      // berço para fechar a volta, e a porta dele fica fechada de propósito — embarcar ali
      // seria viajar antes da hora que o telão prometeu. A cadeia do passageiro começa num
      // ônibus que abre a porta.
      indice = system.units.findIndex((u) => u.stopped && !u.parked);
    }
    check(indice >= 0, 'nenhum ônibus da malha encosta na calçada em quarenta segundos de relógio');

    // A porta do ônibus não é mais o centro da caixa. O encosto é um tile de faixa FORA do
    // cruzamento, adiante dele, e o marco de embarque é um tile de passeio: dois pontos que a
    // malha escolhe por regras diferentes, e a distância entre eles tem de caber na porta em
    // TODA a cidade — um ponto de ônibus sem embarque é decoração. Varredura estrutural:
    // nenhuma simulação, só a geometria que a derivação produziu, calçada por calçada.
    let piorCanto = { d: -1, nome: '' };
    let piorPorta = { d: -1, nome: '' };
    let naCaixa = 0;
    let naZebra = 0;
    let atrasDaEsquina = 0;
    let encostos = 0;
    for (const s of network.stations) {
      const caixa = network.nodes[s.node];
      const d = Math.hypot(s.x - caixa.x, s.y - caixa.y);
      if (d > piorCanto.d) piorCanto = { d, nome: s.name };
      check(d <= BOARDING_REACH,
        `parada "${s.name}" a ${d.toFixed(2)} tiles do próprio cruzamento: o marco saiu da esquina`);
    }
    check(piorCanto.d > 1, 'a calçada mais longe da cidade está a um passo do asfalto: o passeio virou faixa');
    for (const r of network.routes) {
      for (const st of r.stops) {
        const marco = network.stations[st.station];
        const caixa = network.nodes[marco.node];
        for (const [dist, dir, metade] of [[st.at, 1, 'ida'], [st.voltaAt, -1, 'volta']]) {
          const p = alongRoute(r, dist, dir);
          const tx = Math.floor(p.x), ty = Math.floor(p.y);
          encostos++;
          const t = data.tiles[ty * W + tx];
          // Parar dentro da caixa é o ônibus plantado no meio do cruzamento; parar na zebra é
          // fechar o passo de quem atravessa. As duas eram a queixa que abriu esta fase.
          if (boxOf.has(ty * W + tx)) naCaixa++;
          if (t.key.includes('pelican')) naZebra++;
          const adiante = (p.x - caixa.x) * Math.cos(p.angle) + (p.y - caixa.y) * Math.sin(p.angle);
          // Adiante do cruzamento é onde a fila de carros já passou e o ônibus não a segura.
          // Atrás dele só pode estar o virador de terminal: ali a linha nasce ou morre, e não
          // há fila nenhuma para liberar — é o último tile de uma metade e o primeiro da outra.
          if (adiante < 0) atrasDaEsquina++;
          check(adiante >= 0 || dist === 0 || dist === r.length || dist === r.backLength,
            `${r.name} · ${marco.name}: ônibus da ${metade} encosta ${(-adiante).toFixed(2)} tiles ANTES `
            + 'do cruzamento, em cima da fila de carros, sem ser o virador');
          const porta = Math.hypot(p.x - marco.x, p.y - marco.y);
          if (porta > piorPorta.d) piorPorta = { d: porta, nome: `${r.name} · ${marco.name}` };
          check(porta <= BOARDING_DOOR,
            `${r.name} · ${marco.name}: a calçada está a ${porta.toFixed(2)} tiles do ônibus parado e a `
            + `porta alcança ${BOARDING_DOOR}`);
        }
      }
    }
    check(naCaixa === 0, `${naCaixa} dos ${encostos} encostos para dentro da caixa de um cruzamento`);
    check(naZebra === 0, `${naZebra} dos ${encostos} encostos parado em cima da faixa de pedestre`);
    check(atrasDaEsquina <= 2 * network.routes.length,
      `${atrasDaEsquina} encostos atrás do cruzamento: mais que os dois viradores de cada linha`);
    portas.push({
      seed, d: +piorPorta.d.toFixed(2), nome: piorPorta.nome, canto: +piorCanto.d.toFixed(2),
      encostos, viradores: atrasDaEsquina,
    });

    if (indice >= 0) {
      const paradaDe = (u) => network.stations[network.routes[u.route].stops[u.stop].station];
      const estacao = paradaDe(system.units[indice]);
      player.x = estacao.x;
      player.y = estacao.y;
      const embarcado = system.boarding(player);
      check(embarcado !== null,
        `na calçada da parada "${estacao.name}", com o ônibus parado, o embarque não viu o ônibus`);

      if (embarcado !== null) {
        const unidade = system.units[embarcado];
        const rota = network.routes[unidade.route];
        check(unidade.stopped && unidade.live,
          'o embarque ofereceu um veículo que não está encostado na calçada');

        system.board(player, embarcado);
        check(isAboard(player) && player.busUnit === embarcado && player.state === 'driving',
          'embarcou e não passou a obedecer ao horário');
        check(system.boarding(player) === null, 'quem já vai a bordo embarca num segundo ônibus');

        // O passageiro não tem física própria: a posição dele é a do horário, quadro a
        // quadro. O horizonte do laço é uma constante local de propósito — `system.clock` é
        // exatamente o tempo que o `update` acabou de receber, então comparar com ele dentro
        // do laço empurra o fim um passo à frente a cada volta e o laço nunca acaba.
        let colado = true;
        const partida = { x: player.x, y: player.y };
        const seisSegundos = system.clock + 6;
        for (let t = system.clock; t < seisSegundos; t += 1 / 60) {
          system.update(t, estacao.x, estacao.y);
          system.ride(player);
          const u = system.units[embarcado];
          if (player.x !== u.x || player.y !== u.y) { colado = false; break; }
        }
        check(colado, 'o passageiro se descolou do ônibus durante a viagem');
        // Sem isso, `colado` seria satisfeito por dois números congelados no mesmo lugar.
        check(Math.hypot(player.x - partida.x, player.y - partida.y) > 1,
          'o ônibus levou o passageiro, mas não saiu do lugar');

        // A linha que se leva nas costas nunca sai do alcance: a câmera segue o jogador, e o
        // portão de zona lê do asfalto onde o veículo está.
        streaming.update({ ax: player.x, ay: player.y, zoom: 1,
          viewBounds: { minX: player.x - 8, maxX: player.x + 8, minY: player.y - 8, maxY: player.y + 8 } });
        system.update(system.clock + 1 / 60, player.x, player.y, streaming);
        check(system.units[embarcado].live, 'a linha do passageiro saiu do alcance da própria câmera');

        // Descer em movimento é um teletransporte disfarçado, então a porta não abre no asfalto.
        let recusou = false;
        const umaVolta = system.clock + rota.cycle;
        for (let t = system.clock; t < umaVolta; t += 0.05) {
          system.update(t, estacao.x, estacao.y);
          if (system.units[embarcado].stopped) continue;
          recusou = system.alight(player, map, collision) === false;
          break;
        }
        check(recusou, 'a porta abriu com o ônibus em movimento');
        check(isAboard(player), 'desembarcou enquanto o veículo andava');

        // Na próxima calçada o corpo pisa o passeio da parada, não o ponto do asfalto.
        let encostou = false;
        const ateAVolta = system.clock + rota.cycle;
        for (let t = system.clock; t < ateAVolta; t += 0.05) {
          system.update(t, estacao.x, estacao.y);
          if (system.units[embarcado].stopped) { encostou = true; break; }
        }
        check(encostou, 'a linha nunca volta a encostar numa calçada: não há para onde desembarcar');
        if (encostou) {
          const u = system.units[embarcado];
          const destino = paradaDe(u);
          check(system.alight(player, map, collision) === true, 'encostou na calçada e a porta não abriu');
          check(!isAboard(player) && player.busUnit === null && player.state === 'idle',
            'desembarcou mas continuou a bordo');
          const pousou = { x: player.x, y: player.y, radius: GAME_CONFIG.PLAYER_RADIUS };
          check(collision.resolveCircle(pousou, map.queryNearby(player.x, player.y, 1.8)) === false,
            'quem desceu do ônibus parou dentro de um muro do passeio');
          const doPasseio = Math.hypot(player.x - destino.x, player.y - destino.y);
          check(doPasseio <= 1.5,
            `o desembarque largou o corpo a ${doPasseio.toFixed(2)} tiles do passeio da parada "${destino.name}"`);
        }

        // Um ônibus que passa sem parar não abre porta para quem estende a mão no asfalto. A
        // folga do cenário é a porta inteira: um veículo em movimento a menos de `BOARDING_DOOR`
        // de um encostado ainda está na cena daquele embarque, e uma régua curta faria o teste
        // provar o cenário errado.
        const passando = system.units.find((v) => !v.stopped &&
          system.units.every((w) => !w.stopped || Math.hypot(w.x - v.x, w.y - v.y) > BOARDING_DOOR));
        if (passando) {
          const naRua = createPlayer(passando.x, passando.y);
          check(system.boarding(naRua) === null, 'embarque aceito com o veículo passando sem parar');
          system.board(naRua, system.units.indexOf(passando));
          check(!isAboard(naRua), 'subiu num ônibus que estava passando');
        }
      }
    }

    // A porta tem duas réguas e as duas mandam. O corpo de um ônibus encostado alcança
    // `BOARDING_DOOR` tiles, mas quem está além do braço (`BOARDING_REACH`) só embarca pelo
    // passeio da parada que aquele ônibus serve: sem a segunda régua o passageiro do lado de lá
    // de uma avenida entra por cima do asfalto, e sem a primeira o ônibus para a três tiles da
    // calçada certa e ninguém o alcança. Varredura da cidade inteira no horário completo — sem
    // `streaming` nenhuma linha é cortada —, calçada por calçada, sobre o que o embarque de
    // verdade devolve.
    system.update(60, anchor.x, anchor.y);
    let oferecidas = 0;
    let pelaCalçada = 0;
    for (const s of network.stations) {
      const quem = createPlayer(s.x, s.y);
      const dado = system.boarding(quem);
      if (dado === null) continue;
      oferecidas++;
      const u = system.units[dado];
      const d = Math.hypot(s.x - u.x, s.y - u.y);
      const parada = network.routes[u.route].stops[u.stop].station;
      check(u.live && u.stopped, `"${s.name}": o embarque ofereceu um veículo que não está encostado`);
      check(d <= BOARDING_DOOR,
        `"${s.name}": embarque a ${d.toFixed(2)} tiles do ônibus, fora da porta (${BOARDING_DOOR})`);
      if (d > BOARDING_REACH) {
        pelaCalçada++;
        check(parada === s.id,
          `"${s.name}": embarque a ${d.toFixed(2)} tiles num ônibus que para na "${network.stations[parada].name}", `
          + 'do outro lado da rua');
      }
    }
    check(oferecidas > 0, 'nenhuma calçada da cidade encontrou um ônibus encostado ao qual embarcar');
    // Sem amostra nenhuma na faixa entre as duas réguas, a régua longa seria código morto e a
    // varredura acima não estaria provando nada.
    check(pelaCalçada > 0, 'a régua longa da porta nunca foi exercida: nenhuma calçada embarcou além do braço');
  }

  // ---- 10d. O §3c: a rodoviária é um lugar do mundo e o telão planeja viagem de verdade.
  // Nada aqui aceita teleporte: a prova é que o `JourneySystem` nunca empurra o corpo, e que
  // a única forma de o jogador mudar de calçada é andar, esperar, embarcar e descer.
  {
    const { createPlayer, isAboard } = load(path.join(root, 'src/entities/Player.ts'));
    const { CollisionSystem } = load(path.join(root, 'src/systems/CollisionSystem.ts'));
    const { JourneySystem, stationName } = load(path.join(root, 'src/systems/JourneySystem.ts'));
    const { departures, nextArrivals, planTrip } = load(path.join(root, 'src/data/transport/schedule.ts'));
    const { InteriorSystem } = load(path.join(root, 'src/systems/InteriorSystem.ts'));
    const collision = new CollisionSystem();
    const halls = new InteriorSystem(map).entrances.filter((e) => e.kind === 'terminal');
    const stations = map.landmarksOf('busstation');
    check(stations.length >= 1, `seed ${seed}: a cidade não tem rodoviária`);
    check(halls.length === stations.length,
      `seed ${seed}: ${halls.length} hall(s) para ${stations.length} rodoviária(s)`);

    // Toda porta de hall tem de dar para uma calçada que exista na malha. Sem isso a
    // rodoviária é um prédio com menu, não um lugar de embarque.
    //
    // O relógio desta cena nasce aqui, do zero. A seção do portão varreu a cidade inteira no
    // instante 60 e deixou em cada unidade o atraso que a rua cobrou até lá; amostrar essa mesma
    // lataria em 13,7 é reler o horário 46 segundos antes de o mundo ter vivido, e o ônibus
    // encosta no passeio de embarque antes de a própria passada existir. Nenhum jogador verá
    // isso — ninguém volta no tempo —, então a prova de rua também não pode.
    const cena = new TransportSystem(map, seed);
    check(fingerprint(cena.network) === fingerprint(network),
      `seed ${seed}: o sistema da cena da viagem derivou outra malha`);
    let pior = { d: -1, nome: '', linhas: 0 };
    for (const hall of halls) {
      const plataforma = cena.platformNear(hall.x, hall.y);
      check(!!plataforma, `seed ${seed}: a porta da rodoviária não dá para nenhuma calçada com linha`);
      if (!plataforma) continue;
      check(plataforma.lines.length >= 1, `seed ${seed}: plataforma do hall sem linha`);
      const d = Math.hypot(plataforma.x - hall.x, plataforma.y - hall.y);
      check(d <= 6, `seed ${seed}: da porta do hall ao embarque são ${d.toFixed(2)} tiles`);
      if (d > pior.d) pior = { d, nome: stationName(network, map, plataforma.id), linhas: plataforma.lines.length };
    }
    if (pior.d >= 0) calçadas.push({ seed, d: +pior.d.toFixed(2), nome: pior.nome, linhas: pior.linhas });

    // O telão é o horário lido da mesma malha que desenha o ônibus: nada de lista inventada.
    const t0 = 13.7;
    const hall = halls[0];
    const orig = hall ? cena.platformNear(hall.x, hall.y) : null;
    if (orig) {
      cena.update(t0, orig.x, orig.y);
      const rows = cena.departuresAt(orig.id);
      check(rows.length >= 1, `seed ${seed}: o telão da rodoviária está vazio`);
      check(rows.length === departures(network, orig.id, t0).length,
        'o painel não é o mesmo cálculo do horário');
      const vistos = new Set();
      let ordemOk = true;
      let duplicadoOk = true;
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        if (i > 0 && rows[i - 1].wait > r.wait) ordemOk = false;
        const chave = `${r.route}|${r.destination}`;
        if (vistos.has(chave)) duplicadoOk = false;
        vistos.add(chave);
        const linha = network.routes[r.route];
        check(r.destination !== orig.id, 'o telão oferece a própria calçada como destino');
        check(r.wait > 0, 'partida com espera impossível');
        check(r.ride > network.services[linha.service].dwell,
          `a linha ${linha.name} promete um passeio mais curto que a própria parada`);
        const chegas = nextArrivals(network, orig.id, t0, 999).filter((a) => a.route === r.route);
        check(chegas.length >= 1 && chegas[0].in <= r.wait + 1e-9,
          `o telão anuncia a linha ${linha.name} e o relógio da parada não a vê`);
        const viagem = planTrip(network, orig.id, r.destination, t0);
        check(!!viagem && viagem.legs.length >= 1 && viagem.legs[0].from === orig.id,
          `o destino ${stationName(network, map, r.destination)} do telão não tem viagem desta calçada`);
        check(!!viagem && viagem.arrive >= t0 + r.wait,
          'a viagem chega antes de o ônibus encostar na calçada');
        check(!!viagem && viagem.transfers === viagem.legs.length - 1,
          'o número de transbordos não bate com o número de embarques');
        check(stationName(network, map, r.destination) !== '—', 'destino do telão sem nome');
      }
      check(ordemOk, 'o telão não está na ordem em que os ônibus chegam');
      check(duplicadoOk, 'o telão repete a mesma linha no mesmo sentido');

      // A viagem inteira, cumprida no mundo: um destino que o horário alcança num só embarque.
      const unico = rows.find((r) => {
        const v = planTrip(network, orig.id, r.destination, t0);
        return v && v.legs.length === 1;
      });
      const player = createPlayer(hall.x, hall.y);
      const dito = [];
      let pino = null;
      let limpo = 0;
      let andado = 0;
      const ctx = {
        player, map, transport: cena, world: { x: player.x, y: player.y },
        mark: (x, y) => { pino = { x, y }; },
        clearMark: () => { pino = null; limpo++; },
        say: (text) => dito.push(text),
      };
      const viaja = new JourneySystem();
      const tick = (t, aBordo) => {
        cena.update(t, player.x, player.y);
        if (aBordo) cena.ride(player);
        ctx.world.x = player.x;
        ctx.world.y = player.y;
        const antes = { x: player.x, y: player.y };
        viaja.update(ctx);
        if (player.x !== antes.x || player.y !== antes.y) andado++;
      };
      if (unico) {
        // O embarque é o ônibus anunciado, com passada e frota: é o caminho que
        // `GameState.chooseDeparture` percorre quando o dedo toca numa linha do telão.
        check(viaja.begin(ctx, orig.id, unico.destination, unico) === true,
          'o telão recusou um destino que ele mesmo anunciou');
        const perna = viaja.journey && viaja.journey.legs[0];
        check(!!perna && perna.from === orig.id, 'a viagem começa em outra calçada que não a do hall');
        check(!!perna && perna.route === unico.route && perna.pass === unico.pass
          && perna.unit === unico.unit,
          `o plano embarca outro ônibus que não o anunciado: telão linha #${unico.route} `
          + `passada ${unico.pass} unidade ${unico.unit}, plano linha #${perna && perna.route} `
          + `passada ${perna && perna.pass} unidade ${perna && perna.unit}`);
        // A espera que a HUD conta é a do ônibus que ela nomeia. No instante do plano a contagem
        // da perna é, segundo a segundo, a hora que o telão escreveu para aquela placa — senão o
        // aviso diria AUR-104 contando a chegada da AUR-105 da mesma linha.
        check(!!perna && Math.abs(cena.esperaDaPerna(perna) - unico.wait) < 1e-6,
          `o telão anuncia o ${fleetLabel(network.routes[unico.route], unico.unit)} em `
          + `${unico.wait.toFixed(2)}s e a espera da perna conta `
          + `${perna ? cena.esperaDaPerna(perna).toFixed(2) : 'nada'}s`);
        const estação = network.stations[orig.id];
        // O embarque é a baia da linha escolhida, não a pedra da estação. No pátio a estação é
        // um ponto só do virador e as linhas encostam ao comprido da coluna de passeio: quem é
        // mandado para a estação espera no lugar errado e vê o ônibus passar sem a porta abrir.
        const embarque = plataformaDaLinha(network, orig.id, unico.route) || estação;
        check(embarque === estação || embarque.station === orig.id,
          'a plataforma da linha escolhida não pertence à calçada do hall');
        check(!!pino && Math.hypot(pino.x - embarque.x, pino.y - embarque.y) < 1e-9,
          'o pino do GPS não é a plataforma de embarque');
        check(dito[0] === `Viagem até ${stationName(network, map, unico.destination)}`,
          'a viagem não disse para onde o jogador vai');

        // Longe da plataforma o plano espera: anda quem quer, não quem planejou. O passo é dado
        // para o lado, nunca ao comprido da coluna — o passeio da baia corre na vertical, e um
        // ponto três tiles acima ainda estaria em cima do `ponto` dela.
        const ang = Math.atan2(hall.y - embarque.y, hall.x - embarque.x);
        let longe = { x: embarque.x + Math.cos(ang) * (BOARDING_REACH + 1),
          y: embarque.y + Math.sin(ang) * (BOARDING_REACH + 1) };
        if (embarque !== estação && naPlataforma(embarque, longe.x, longe.y)) {
          longe = { x: embarque.x + BOARDING_REACH + 1, y: embarque.y };
        }
        player.x = longe.x;
        player.y = longe.y;
        tick(t0);
        check(viaja.journey.phase === 'walk', 'a viagem pulou a perna a pé');
        check(limpo === 0 && pino !== null, 'tirou o pino antes de chegar à plataforma');

        player.x = embarque.x;
        player.y = embarque.y;
        tick(t0);
        check(viaja.journey.phase === 'wait', 'na plataforma certa o plano não virou espera');
        check(pino === null, 'a plataforma de embarque continuou marcada como destino');

        let rel = t0;
        let embarcado = -1;
        const rota = network.routes[perna.route];
        const ateEmbarcar = perna.board + 120;
        // O embarque é o da passada prometida, não "qualquer ônibus daquela linha nesta
        // calçada": a mesma pedra recebe a ida e a volta, e quem entra na volta prometendo a
        // ida desce do outro lado da cidade uma volta inteira depois do horário do telão.
        while (rel < ateEmbarcar && embarcado < 0) {
          rel = Math.min(rel + 0.05, ateEmbarcar);
          cena.update(rel, player.x, player.y);
          embarcado = cena.units.findIndex((u) => u.live && u.stopped && u.route === perna.route
            && u.stop >= 0 && u.pass === perna.pass && rota.stops[u.stop].station === orig.id);
        }
        check(embarcado >= 0, 'a passada prometida pelo plano nunca encosta na calçada de embarque');
        check(cena.boarding(player) !== null,
          'o ônibus encostou no passeio e o embarque não o viu de lá');
        if (embarcado >= 0) {
          const noEmbarque = { unit: embarcado, rel, atraso: cena.units[embarcado].atraso };
          cena.board(player, embarcado);
          tick(rel);
          check(viaja.journey.phase === 'ride', 'embarcou e a viagem não virou percurso');
          check(isAboard(player), 'o embarque não colocou ninguém a bordo');

          let desceu = false;
          const ateChegar = perna.arrive + 120;
          let naDescida = null;
          let ultimo = null;
          while (rel < ateChegar && !desceu) {
            rel += 0.05;
            cena.update(rel, player.x, player.y);
            cena.ride(player);
            const u = cena.aboard(player);
            desceu = !!u && u.stopped && u.stop >= 0 && rota.stops[u.stop].station === perna.to;
            if (desceu) naDescida = { passada: u.pass, atraso: u.atraso };
            else if (u) ultimo = {
              stop: u.stop, pass: u.pass, atraso: u.atraso, x: u.x, y: u.y,
              parado: u.stopped, segurado: u.held,
            };
          }
          // "Nunca encosta" pode ser duas contas muito diferentes: o ônibus da perna está preso
          // atrás de uma fila que comeu a volta inteira, ou ele anda e a descida nunca é
          // reconhecida. Sem a parada onde ele parou no fim do laço, o check acusa a viagem de
          // não chegar sem dizer se ela ficou no meio do caminho ou na porta errada.
          check(desceu, ultimo
            ? `a linha nunca encosta na calçada do destino: embarcou aos ${noEmbarque.rel.toFixed(1)}s `
              + `(prometido ${perna.board.toFixed(1)}s) com ${noEmbarque.atraso.toFixed(1)}s de atraso, `
              + `e aos ${rel.toFixed(1)}s (janela até ${ateChegar.toFixed(1)}s, prometido `
              + `${perna.arrive.toFixed(1)}s) a unidade está na parada ${ultimo.stop}`
              + ` (passada ${ultimo.pass}, ${ultimo.parado ? 'parado' : 'em marcha'}`
              + `${ultimo.segurado ? '+segurado' : ''}, ${ultimo.atraso.toFixed(1)}s de atraso) em `
              + `(${ultimo.x.toFixed(1)},${ultimo.y.toFixed(1)}), destino ${perna.to}`
            : 'a linha nunca encosta na calçada do destino');
          check(Math.hypot(player.x - cena.units[embarcado].x, player.y - cena.units[embarcado].y) < 1e-9,
            'a bordo, o passageiro não está em cima do ônibus');
          tick(rel);
          check(viaja.journey.phase === 'ride', 'descer do ônibus mudou a viagem sem pedir');
          check(cena.alight(player, map, collision) === true,
            'encostou no destino e a porta não abriu');
          tick(rel);
          check(viaja.journey === null, 'desceu no destino e a viagem continua de pé');
          check(dito[dito.length - 1] === `Você chegou · ${stationName(network, map, unico.destination)}`,
            'a chegada não avisou onde o jogador está');
          const alvo = network.stations[unico.destination];
          check(Math.hypot(player.x - alvo.x, player.y - alvo.y) <= 1.5,
            'desembarcou longe do passeio do destino');
          check(pino === null, 'a viagem terminou com pino no mapa');
          // Chegar antes do telão prometeu é o plano e a rua contando histórias diferentes: ou
          // o embarque pegou uma passada que o plano não ofereceu, ou a descida aconteceu numa
          // pedra que o plano pulou. O `atraso` que a rua dá só empurra para depois, nunca antes.
          check(rel >= perna.arrive - 0.1, naDescida
            ? `a viagem terminou antes do horário prometido: embarcou aos ${noEmbarque.rel.toFixed(1)}s `
              + `(prometido ${perna.board.toFixed(1)}s) na unidade ${noEmbarque.unit}, que já tinha `
              + `${noEmbarque.atraso.toFixed(1)}s de atraso, e desceu aos ${rel.toFixed(1)}s `
              + `(prometido ${perna.arrive.toFixed(1)}s) na passada ${naDescida.passada} `
              + `com o plano na ${perna.pass}`
            : 'a viagem terminou antes do horário prometido');
          check(andado === 0, 'o plano moveu o jogador por conta própria');
          // A contagem da HUD nunca é um número solto no ar: depois de a hora prometida passar,
          // ela enrola para o ciclo seguinte do MESMO veículo, sempre dentro de uma volta da
          // linha. Apontar para o colega que passou antes deixaria o aviso nomeando um ônibus e
          // contando os segundos de outro.
          const enrolada = cena.esperaDaPerna(perna);
          const ciclo = network.routes[perna.route].cycle;
          check(enrolada > 0 && enrolada <= ciclo + 1e-6,
            `a espera da perna enrolou para ${enrolada.toFixed(2)}s, fora de um ciclo de `
            + `${ciclo.toFixed(1)}s da ${network.routes[perna.route].name}`);
          viagens.push({
            seed,
            linhas: rows.length,
            tela: stationName(network, map, orig.id),
            baia: embarque === estação ? estação.name : embarque.name,
            destino: stationName(network, map, unico.destination),
            pe: +Math.hypot(hall.x - embarque.x, hall.y - embarque.y).toFixed(1),
            espera: +(perna.board - t0).toFixed(1),
            passeio: +(perna.arrive - perna.board).toFixed(1),
            total: +(rel - t0).toFixed(1),
            moveu: andado,
          });
        }
      } else {
        check(halls.length === 0, `seed ${seed}: o telão não oferece nenhum destino de um só embarque`);
      }
    }
  }

  // ---- 10d-bis. As plataformas e os guichês da quadra exclusiva. A cobrança é literal: "o
  //          terminal de ônibus tem que ter tudo exclusivo pra ele, inclusive a quadra, onde tem
  //          que ter os guichês de embarque". Uma placa desenhada sobre a calçada não prova nada
  //          — o que prova é a porta: com o ônibus da Linha X encostado no berço dele, quem espera
  //          na baia da Linha Y não entra. Tudo abaixo é lido da malha e do relógio da rua, nunca
  //          de um número escrito à mão ao lado do desenho.
  {
    const { createPlayer } = load(path.join(root, 'src/entities/Player.ts'));
    // O relógio da prova de rua corre num sistema à parte, pelo mesmo motivo da seção 10e:
    // varrer minutos até o ônibus encostar no pátio amassa o atraso da malha, e medido no
    // `system` compartilhado as seções 12, 13 e 14 leriam lataria sobre lataria de uma cidade
    // que esta seção amassou.
    const pátio = new TransportSystem(map, seed);
    check(fingerprint(pátio.network) === fingerprint(network),
      `seed ${seed}: o sistema isolado das plataformas derivou outra malha`);
    const passeioDoMapa = new Set(map.sidewalkNodes.map((n) => `${Math.floor(n.x)},${Math.floor(n.y)}`));
    const pátios = network.stations.filter((s) => s.terminal);
    check(pátios.length >= 1, `seed ${seed}: a cidade não tem estação dentro da quadra exclusiva`);
    const comBaia = pátios.filter((s) => (s.platforms ?? []).length >= 1);
    check(comBaia.length >= 1 && comBaia.length === pátios.length,
      `seed ${seed}: ${comBaia.length} de ${pátios.length} rodoviária(s) têm plataforma`);

    let naBaia = 0;
    for (const st of comBaia) {
      const próprias = st.platforms.map((id) => network.platforms[id]);
      check(próprias.every((p) => p.station === st.id),
        `seed ${seed}: a ${st.name} lista uma plataforma que é de outra estação`);
      check(próprias.map((p) => p.número).sort((a, b) => a - b).join() === próprias.map((_, i) => i + 1).join(),
        `seed ${seed}: as baias da ${st.name} não são numeradas de 1 a ${próprias.length} sem furo `
        + `(são ${próprias.map((p) => p.número).join(',')})`);
      check(próprias.every((p) => p.name === `Plataforma ${p.número}`),
        `seed ${seed}: a placa de uma baia da ${st.name} não mostra o número dela`);

      // Um tile de passeio pertencendo a duas baias são duas linhas embarcando no mesmo
      // passageiro, e é exatamente o engano que a numeração existe para impedir.
      const pisados = new Map();
      for (const p of próprias) {
        check(p.ponto.length >= 1 && p.lines.length >= 1,
          `${p.name} da ${st.name}: ${p.ponto.length} tile(s) de passeio e ${p.lines.length} linha(s)`);
        for (const q of p.ponto) {
          const k = `${Math.floor(q.x)},${Math.floor(q.y)}`;
          const dono = pisados.get(k);
          check(dono === undefined,
            `o tile ${k} do pátio pertence à ${p.name} e à `
            + `${dono === undefined ? 'outra baia' : network.platforms[dono].name}`);
          pisados.set(k, p.id);
          const t = tile(Math.floor(q.y) * W + Math.floor(q.x));
          check(t.terminal === true && passeioDoMapa.has(k),
            `${p.name}: o tile ${k} da plataforma não é passeio do terminal (${t.key})`);
        }
        // O guichê é passeio do pátio — bilheteiro em cima do asfalto não existe — e fica na
        // ponta da baia, o canto oposto ao ônibus parado: a cabine não fecha o embarque de
        // ninguém e a placa do poste continua legível da boca do pátio.
        const kg = `${Math.floor(p.guichê.x)},${Math.floor(p.guichê.y)}`;
        const tg = tile(Math.floor(p.guichê.y) * W + Math.floor(p.guichê.x));
        check(tg.terminal === true && passeioDoMapa.has(kg),
          `${p.name}: o guichê está em (${p.guichê.x},${p.guichê.y}), tile ${tg.key}, que não é passeio do pátio`);
        check(p.ponto.length === 1 || Math.hypot(p.guichê.x - p.x, p.guichê.y - p.y) > 0.9,
          `${p.name}: o guichê está em cima do poste da placa, e a plataforma tem ${p.ponto.length} tiles`);
        check(kg !== `${Math.floor(p.encosto.x)},${Math.floor(p.encosto.y)}`,
          `${p.name}: o guichê está no asfalto em que o ônibus encosta`);
        // O berço é faixa de acesso do pátio: não a avenida, não a caixa do virador.
        const te = tile(Math.floor(p.encosto.y) * W + Math.floor(p.encosto.x));
        check(te.terminal === true && te.rank === 'access',
          `${p.name}: o ônibus encosta em (${p.encosto.x},${p.encosto.y}), tile ${te.key} de posto ${te.rank}`);
        check(p.edge >= 0 && network.edges[p.edge].rank === 'access',
          `${p.name}: a plataforma não aponta para faixa de acesso do pátio (aresta ${p.edge})`);
      }

      // Cada linha que morre no pátio tem baia, e tem uma só.
      const servidas = new Set();
      for (const r of network.routes) if (r.stops.some((s) => s.station === st.id)) servidas.add(r.id);
      const anunciadas = new Set();
      for (const p of próprias) {
        for (const linha of p.lines) {
          check(!anunciadas.has(linha),
            `a linha ${network.routes[linha].name} tem duas plataformas na ${st.name}`);
          anunciadas.add(linha);
          check(plataformaDaLinha(network, st.id, linha) === p,
            `a linha ${network.routes[linha].name} está na ${p.name} e a busca por linha acha outra`);
        }
      }
      check(anunciadas.size === servidas.size,
        `${servidas.size} linha(s) morrem no pátio da ${st.name} e só ${anunciadas.size} têm plataforma`);

      // O telão e a malha apontam para a mesma baia, linha por linha: painel, GPS e porta.
      for (const row of pátio.departuresAt(st.id)) {
        const esperada = plataformaDaLinha(network, st.id, row.route);
        check(row.platform >= 0 && row.platform === (esperada ? esperada.id : -1),
          `o telão da ${st.name} manda a ${network.routes[row.route].name} para a plataforma ${row.platform} `
          + `e a malha diz ${(esperada && esperada.name) || 'calçada de rua'}`);
      }

      // A prova de rua. O ônibus da linha encosta no berço que a placa anuncia, a porta abre para
      // quem está naquela baia e não entrega ao da baia ao lado o ônibus do vizinho. O relógio é
      // corrido, não cravado: a janela de parada são dois segundos e o atraso da rua é de
      // dezenas, então cobrar o encosto num instante fixo acusaria de furo um horário que ainda
      // está a quarenta tiles de distância.
      for (const p of próprias) {
        const vizinha = próprias.find((q) => q.id !== p.id);
        for (const linha of p.lines) {
          const rota = network.routes[linha];
          let rel = 13.7;
          const até = rel + 900;
          let encostado = -1;
          while (rel < até && encostado < 0) {
            rel = Math.min(rel + 0.5, até);
            pátio.update(rel, p.x, p.y);
            encostado = pátio.units.findIndex((u) => u.live && u.stopped && u.route === linha
              && u.stop >= 0 && rota.stops[u.stop].station === st.id);
          }
          check(encostado >= 0, `na ${p.name} o ônibus da ${rota.name} nunca encosta em 900s de relógio`);
          if (encostado < 0) continue;
          const u = pátio.units[encostado];
          const d = Math.hypot(u.x - p.encosto.x, u.y - p.encosto.y);
          check(d <= 0.6,
            `${p.name}: o ônibus da ${rota.name} encosta a ${d.toFixed(2)} tiles do berço da placa `
            + `(${u.x.toFixed(2)},${u.y.toFixed(2)})`);
          naBaia++;
          const meu = pátio.boarding(createPlayer(p.x, p.y));
          check(meu !== null && pátio.units[meu].route === linha,
            `${p.name}: parado na plataforma com o ônibus encostado, a porta não abriu para a linha dela`);
          if (!vizinha) continue;
          // Andar dois tiles na mesma calçada é mudar de plataforma. Se a porta não se importa, a
          // placa é tinta: o passageiro embarca no que chegou primeiro, não no que comprou.
          const aoLado = pátio.boarding(createPlayer(vizinha.x, vizinha.y));
          check(aoLado === null || !p.lines.includes(pátio.units[aoLado].route),
            `${p.name}: quem espera na ${vizinha.name} embarca no ônibus da ${rota.name} `
            + `(a ${Math.hypot(vizinha.x - u.x, vizinha.y - u.y).toFixed(1)} tiles do berço dele)`);
        }
      }

      plataformasMedidas.push({
        seed,
        nome: st.name,
        baias: próprias.length,
        linhas: anunciadas.size,
        descreve: próprias.map((p) => `${p.name} com ${p.ponto.length} tile(s) de passeio, `
          + `${p.lines.length} linha(s) e guichê a ${Math.hypot(p.guichê.x - p.x, p.guichê.y - p.y).toFixed(1)} `
          + 'tiles do poste').join(' · '),
      });
    }
    check(naBaia >= 1, `seed ${seed}: nenhuma plataforma teve ônibus encostado na janela do horário`);
  }

  // ---- 10d-ter. A viação, a matrícula e a hora do painel. "Sem repetir o número de ônibus" é
  //          conta, não gosto: cada corpo da cidade tem uma matrícula, ela é a única naquele
  //          mundo, e o ônibus que o telão anuncia é o mesmo que o plano embarca. O que prova
  //          aqui é a malha e o relógio, nunca a string escrita ao lado do desenho.
  {
    const { departures, planTrip } = load(path.join(root, 'src/data/transport/schedule.ts'));
    check(network.companies.length >= 2,
      `seed ${seed}: a cidade tem ${network.companies.length} viação(ões) operando a malha`);
    const siglas = new Set(network.companies.map((c) => c.code));
    check(siglas.size === network.companies.length, 'duas viações têm a mesma sigla na lataria');
    for (const c of network.companies) {
      check(c.name.length >= 4 && /^[A-Z]{3}$/.test(c.code)
        && /^#[0-9a-f]{6}$/i.test(c.livery) && /^#[0-9a-f]{6}$/i.test(c.stripe)
        && c.livery.toLowerCase() !== c.stripe.toLowerCase(),
        `a viação "${c.name}" (${c.code}) não tem nome, sigla de três letras e dois tons de tinta `
        + `(${c.livery}/${c.stripe})`);
    }

    const placas = new Map();
    let frota = 0;
    const porVia = new Map();
    for (const r of network.routes) {
      const via = network.companies[r.company];
      check(!!via, `${r.name} roda sem viação`);
      if (!via) continue;
      porVia.set(via.code, (porVia.get(via.code) || 0) + 1);
      for (let u = 0; u < r.units; u++) {
        const numero = fleetNumber(r, u);
        check(/^\d{3,}$/.test(numero), `${r.name}: matrícula "${numero}" não é número de garagem`);
        const prefixo = `${via.code}-${numero}`;
        check(prefixo === fleetLabel(r, u),
          `a etiqueta lida na rua (${fleetLabel(r, u)}) não é a sigla mais a matrícula (${prefixo})`);
        const dono = placas.get(prefixo);
        check(dono === undefined,
          `a matrícula ${prefixo} está pintada em ${dono} e em ${r.name} unidade ${u}`);
        placas.set(prefixo, `${r.name}#${u}`);
        frota++;
      }
    }
    check(placas.size === frota, `${placas.size} matrícula(s) únicas para uma frota de ${frota} ônibus`);
    check(porVia.size >= 3,
      `a malha inteira é de ${porVia.size} viação(ões) — a rua seria uma garagem só`);

    // O painel e o plano são o mesmo ônibus. A hora anunciada é a do veículo que o plano
    // embarca, porque o passageiro lê um número no telão e procura esse número no pátio. É
    // exatamente o que `GameState.chooseDeparture` entrega: a linha tocada vai amarrada no
    // plano, e o horário não tem liberdade de responder "o mais rápido que eu achei".
    const rodoviária = network.stations.find((s) => s.terminal);
    const horários = [];
    let recusa = 0;
    for (const instante of [13.7, 60, 137.25, 301.4]) {
      const outras = departures(network, rodoviária.id, instante);
      for (const row of outras) {
        const viagem = planTrip(network, rodoviária.id, row.destination, instante,
          { route: row.route, pass: row.pass, unit: row.unit });
        const perna = viagem && viagem.legs[0];
        check(!!perna && perna.route === row.route,
          `o telão anuncia a ${network.routes[row.route].name} para `
          + `${row.destination} e o plano embarca em ${perna ? network.routes[perna.route].name : 'nenhuma'}`);
        if (!perna || perna.route !== row.route) continue;
        // Uma linha tocada é uma perna só: quem escolhe o ônibus não é despachado para um
        // transbordo que o painel não mostrou.
        check(viagem.transfers === 0 && viagem.legs.length === 1,
          `a ${network.routes[row.route].name} para ${row.destination} virou uma viagem de `
          + `${viagem.legs.length} perna(s)`);
        check(perna.unit === row.unit,
          `o painel manda procurar a frota ${fleetNumber(network.routes[row.route], row.unit)} e o `
          + `plano embarca na ${fleetNumber(network.routes[row.route], perna.unit)} da mesma linha`);
        check(Math.abs(row.wait - (perna.board - instante)) < 1e-6,
          `a espera anunciada (${row.wait.toFixed(2)}s) não é a do embarque planejado `
          + `(${(perna.board - instante).toFixed(2)}s)`);
        // A partida anunciada é uma partida daquela linha naquele sentido: a passada do painel
        // tem de ser uma passada em que o ônibus encosta na calçada de onde o plano embarca.
        check(perna.board >= instante && perna.arrive > perna.board,
          `a ${network.routes[row.route].name} embarca aos ${perna.board.toFixed(2)}s e chega aos `
          + `${perna.arrive.toFixed(2)}s no instante ${instante}`);
        horários.push(row.wait);
      }
      // E a recusa honesta: o ônibus anunciado não serve destino por onde ele não passa. Amarrar
      // o plano àquela lataria tem de responder "não há viagem", em vez de arranjar pela cidade
      // um transbordo que o telão não mostrou.
      for (const row of outras) {
        const rota = network.routes[row.route];
        const servidas = new Set(rota.stops.map((s) => s.station));
        const fora = network.stations.find((s, id) => id !== rodoviária.id && !servidas.has(id));
        if (!fora) continue;
        const livre = planTrip(network, rodoviária.id, fora.id, instante);
        if (!livre) continue;
        check(!planTrip(network, rodoviária.id, fora.id, instante,
          { route: row.route, pass: row.pass, unit: row.unit }),
          `a ${rota.name} levou o passageiro a ${fora.name}, que ela não serve, em `
          + `${livre.legs.length} perna(s) de transbordo inventado`);
        recusa++;
      }
    }
    check(horários.length >= 4,
      `a rodoviária só conferiu ${horários.length} partida(s) contra o plano em quatro instantes`);
    check(recusa >= 1,
      'um ônibus anunciado que não serve o destino ainda assim arranjou viagem');

    // A hora que o painel mostra é relógio do mundo, e o relógio do mundo enrola no próprio dia.
    const dn = new DayNightSystem();
    dn.t = 0.5;
    check(dn.clock === '12:00', `o meio do dia não é meio-dia no relógio (${dn.clock})`);
    check(dn.clockIn(60) === '16:48',
      `sessenta segundos de mundo não são quatro horas e quarenta e oito de calendário `
      + `(um dia de ${GAME_CONFIG.DAY_NIGHT_CYCLE_S}s) · ${dn.clockIn(60)}`);
    check(dn.clockIn(GAME_CONFIG.DAY_NIGHT_CYCLE_S) === '12:00',
      `um ciclo inteiro depois o painel mostra ${dn.clockIn(GAME_CONFIG.DAY_NIGHT_CYCLE_S)}`);
    dn.t = 0.99;
    check(dn.clockIn(60) === '04:33',
      `a partida que passa da meia-noite não enrolou o calendário (${dn.clockIn(60)})`);
    frotaMedidas.push({
      seed,
      frota,
      viações: [...porVia.entries()].sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c}:${n}`).join(' '),
      primeiras: [...placas.keys()].slice(0, 3).join(', '),
      unicas: placas.size,
    });
  }

  // ---- 10e. A seta grande. O que a tela aponta tem de ser O ônibus da perna planejada, não o
  //          mais perto nem o da mesma linha: a ida e a volta correm em faixas vizinhas da mesma
  //          rua, então dois veículos da "Linha 7" passam pelo jogador ao mesmo tempo, para lados
  //          opostos da cidade, e um deles é a meia-volta. A prova não é repetir a conta da
  //          espera — é a rua: corrido o relógio até a passada prometida acontecer, a seta está
  //          no corpo que encostou, e não pula para o próximo enquanto a porta dele está aberta.
  //
  //          A varredura roda num sistema à parte, de propósito: ela empurra o relógio muitos
  //          minutos sem câmera nem streaming, que é exatamente o regime em que a malha acumula
  //          atraso e aperta a fila. Media isso no `system` compartilhado, as seções 12 e 13
  //          passavam a ler lataria sobre lataria de uma cidade que a varredura amassou.
  {
    const { planTrip } = load(path.join(root, 'src/data/transport/schedule.ts'));
    const seta = new TransportSystem(map, seed);
    check(fingerprint(seta.network) === fingerprint(network),
      `seed ${seed}: o sistema isolado da seta derivou outra malha — a prova abaixo não é a cidade`);
    const malha = seta.network;
    const anchor = malha.routes[0].points[Math.floor(malha.routes[0].points.length / 2)];
    // 1/30 é o passo mais longo que o relógio aceita sem cortar: acima dele o `dt` é podado e a
    // frenagem da rua deixa de ser a frenagem do jogo. E a janela é o CICLO inteiro da linha, não
    // um minuto: uma perna pode esperar mais que um minuto, e parar a varredura antes seria
    // denunciar um ônibus que nunca chegou à calçada prometida.
    const passo = 1 / 30;
    seta.update(300, anchor.x, anchor.y);
    let testadas = 0;
    let marcados = 0;
    let naCalçada = 0;
    let firmes = 0;
    for (const origem of malha.stations) {
      if (marcados >= 8) break;
      if (!origem.lines.length) continue;
      const agora = seta.clock;
      for (const destino of malha.stations) {
        if (destino.id === origem.id) continue;
        const planejada = planTrip(malha, origem.id, destino.id, agora);
        const perna = planejada && planejada.legs[0];
        if (!perna) continue;
        testadas++;
        const rota = malha.routes[perna.route];
        const i = seta.expectedUnit(perna.route, perna.pass);
        check(i !== null, `"${origem.name}" → "${destino.name}": o plano tem perna `
          + `na ${rota.name} e a seta não achou nenhum veículo`);
        if (i === null) break;
        marcados++;
        const u = seta.units[i];
        check(u.route === perna.route, `"${origem.name}": a seta marcou um veículo da `
          + `${malha.routes[u.route].name}, a perna pede a ${rota.name}`);
        check(u.live && seta.lida[i], `"${origem.name}": a seta marcou um veículo que o relógio `
          + 'não escreveu neste frame — a tela apontaria um corpo congelado');
        let achou = -1;
        for (let f = 1; f <= rota.cycle / passo && achou < 0; f++) {
          seta.update(agora + f * passo, anchor.x, anchor.y);
          for (let k = 0; k < seta.units.length; k++) {
            const q = seta.units[k];
            if (q.live && q.route === perna.route && q.stopped && q.pass === perna.pass) {
              achou = k;
              break;
            }
          }
        }
        check(achou >= 0, `"${origem.name}" → "${destino.name}": a passada ${perna.pass} da `
          + `${rota.name} não aconteceu em um ciclo inteiro do horário`);
        if (achou < 0) break;
        // A seta é rechamada a cada frame no jogo (`GameState.busTarget`), então o que o
        // jogador vê na calçada é a conta daquele instante, não a do instante em que o plano
        // nasceu: um ônibus que se atrasa no caminho perde a seta para o que encosta. A
        // promessa que tem de ser cumprida é outra e é esta — quando há ônibus na calçada
        // servindo a perna, a seta está num deles.
        check(seta.expectedUnit(perna.route, perna.pass) === achou,
          `"${origem.name}" → "${destino.name}": o #${achou} encostou na passada prometida e `
          + `a seta apontou #${seta.expectedUnit(perna.route, perna.pass)}`);
        naCalçada++;
        // Metade do `dwell` depois a porta continua aberta, e a seta não pode ter ido para um
        // veículo que serve outra passada: largar um ônibus parado na calçada por um que ainda
        // nem chegou é o erro que faz o jogador correr atrás do asfalto.
        let saltou = 0;
        for (let g = 0; g < Math.round(malha.services[rota.service].dwell / 2 / passo); g++) {
          seta.update(seta.clock + passo, anchor.x, anchor.y);
          const q = seta.expectedUnit(perna.route, perna.pass);
          if (q === null) { saltou++; continue; }
          const v = seta.units[q];
          if (!(v.live && v.route === perna.route && v.stopped && v.pass === perna.pass)) saltou++;
        }
        check(saltou === 0, `"${origem.name}": a seta saiu da passada prometida em ${saltou} `
          + `quadro(s) enquanto havia ônibus encostado nela`);
        if (saltou === 0) firmes++;
        break;
      }
    }
    check(testadas > 0, 'nenhuma calçada da cidade tem viagem planejada para testar a seta');
    check(marcados >= 6, `a seta só marcou ônibus em ${marcados} viagens planejadas (mínimo 6)`);
    check(naCalçada === marcados, `a seta falhou no embarque de `
      + `${marcados - naCalçada} de ${marcados} pernas`);
    check(firmes === marcados, `a seta pulou de ônibus no meio do embarque em `
      + `${marcados - firmes} de ${marcados} pernas`);
    console.log(`seta do ônibus: ${marcados} pernas planejadas · na calçada prometida a seta `
      + `estava no ônibus encostado em ${naCalçada} · nenhuma seta largou o embarque em curso (${firmes})`);
  }

  // ---- 12. O corpo do ônibus na rua. O `GameState` chama o transporte antes do trânsito e
  //          entrega a lista ao `TrafficSystem`, que é quem freia o motorista diante dela — e
  //          o teste de que ela freia de verdade está em check-police-traffic.cjs, onde mora o
  //          trânsito. O que se prova aqui é a entrega: um corpo que não espelha o horário é
  //          um carro que para atrás de um ônibus que não está ali, ou passa por cima de um que
  //          está. Índice a índice, sem cópia e sem sobra.
  {
    // Três instantes em vez de um. O espelho é conta de quadro e vale em qualquer um deles, mas
    // "a amostra tem os dois estados do ônibus" não pode depender de ter justo um ônibus em dwell
    // no segundo 300 sob a câmera do canto do mapa: com a frota fluindo, isso é sorte de
    // instante, e um check que depende de sorte é o que acusa o conserto de ter quebrado.
    let parados = 0;
    let espelhado = true;
    let andando = 0;
    let materializadas = 0;
    let motivoDoEspelho = '';
    check(system.bodies.length === system.units.length,
      `a lista de corpos tem ${system.bodies.length} posições para ${system.units.length} ônibus do horário`);
    for (const instante of [300, 304, 308]) {
      system.update(instante, camera.ax, camera.ay);
      for (let i = 0; i < system.units.length; i++) {
        const u = system.units[i];
        const b = system.bodies[i];
        if (!b || b.x !== u.x || b.y !== u.y || b.angle !== u.angle || b.dir !== u.dir
          || b.live !== u.live) {
          espelhado = false;
          motivoDoEspelho = `índice ${i}: corpo(${b && b.x},${b && b.y}) relógio(${u.x},${u.y})`;
          break;
        }
        const cruzero = network.services[network.routes[u.route].service].speed;
        // O corpo pode dizer "parado" por dois motivos honestos: encostou na calçada, ou a
        // faixa dele está ocupada e ele está andando para trás no relógio. Os dois são velocidade
        // zero na rua, e é isso que o motorista de trás precisa saber. Entre os dois estados
        // agora há um terceiro, e ele é o ônibus dosando o pé atrás de outro ônibus: o corpo
        // anda a uma fração do cruzeiro, e é essa fração que a rua precisa ler para contar o
        // encontro — um espelho que só conhece o tudo-ou-nada chamaria de mentira o comboio.
        if (b.speed !== ((u.stopped || u.held) ? 0 : cruzero * system.marchaAnunciada(i))) {
          espelhado = false;
          motivoDoEspelho = `índice ${i}: velocidade do corpo ${b.speed}, cruzeiro ${cruzero} × `
            + `marcha anunciada ${system.marchaAnunciada(i)} (parado=${u.stopped}, `
            + `segurado=${u.held})`;
          break;
        }
        if (u.stopped) parados++; else if (u.live) andando++;
        if (u.live) materializadas++;
      }
    }
    check(espelhado, `um corpo da rua não espelha a posição, o rumo, a velocidade ou a vida do `
      + `ônibus do horário (${motivoDoEspelho})`);
    // Sem amostra dos dois estados, o laço acima seria satisfeito por uma lista congelada.
    check(parados > 0 && andando > 0 && materializadas > 0,
      `a amostra não tem os dois estados do ônibus: ${parados} parados, ${andando} andando, ${materializadas} vivos`);
    const raio = Math.max(VEHICLE_DEFS.bus_school.footprintW, VEHICLE_DEFS.bus_school.footprintH) / 2;
    check(system.bodies.every((b) => b.radius === raio),
      `o corpo do ônibus entra na rua com raio de ${system.bodies[0].radius}, e o ônibus mede ${raio}`);

    // O portão de zonas corta o horário e o corpo juntos: um ônibus que a câmera não alcança
    // não é calculado, e um corpo não calculado não pode segurar fila em lugar nenhum.
    streaming.update(camera);
    system.update(system.clock + 240, camera.ax, camera.ay, streaming);
    check(system.units.every((u, i) => u.live === system.bodies[i].live),
      'o portão de zonas deixou um corpo vivo para um ônibus que ele mesmo congelou');
    console.log(`corpos seed ${seed}: ${system.units.length} ônibus · ${parados} encostados no `
      + `instante lido · ${system.bodies.filter((b) => b.live).length} na rua com a câmera no canto do mapa`);
  }

  // ---- 13. O ônibus olha para a frente. O horário é uma conta, e duas contas podem cair no
  //          mesmo pixel — foi exatamente isso que apareceu no print: cinco ônibus em cima um
  //          do outro num cruzamento. Rodando a malha com a câmera numa linha e o relógio
  //          quadro a quadro, o que se cobra é que nenhuma lataria encoste na outra, que quem
  //          está sendo segurado diga velocidade zero ao trânsito, e que a fila inteira caiba
  //          numa volta do ciclo — atrasado sim, sumido do horário não.
  {
    // A câmera vai para onde a malha é mais densa. Com frota por papel a linha 0 pode ser um
    // ramal com três ônibus no mapa inteiro, e medir a frenagem num canto quase vazio seria
    // aprovar o teste sem rodá-lo: o que se quer é o pior quadro da cidade, não o da primeira
    // linha da lista.
    let doMeio = network.routes[0].points[Math.floor(network.routes[0].points.length / 2)];
    {
      let maisCheio = -1;
      for (const r of network.routes) {
        const p = r.points[Math.floor(r.points.length / 2)];
        let corpo = 0;
        for (const outra of network.routes) {
          for (let u = 0; u < outra.units; u++) {
            const s = sampleRoute(outra, network.services[outra.service], 600, u);
            if (Math.hypot(s.x - p.x, s.y - p.y) <= 16) corpo++;
          }
        }
        if (corpo > maisCheio) { maisCheio = corpo; doMeio = p; }
      }
    }
    streaming.update({
      ax: doMeio.x, ay: doMeio.y, zoom: 1,
      viewBounds: { minX: doMeio.x - 8, maxX: doMeio.x + 8, minY: doMeio.y - 8, maxY: doMeio.y + 8 },
    });
    let toque = 0, conservadora = 0, segurado = 0, corpoMentiroso = 0;
    let mínima = Infinity, folgaMínima = Infinity, máximoAtraso = 0;
    let naRua = 0, leituras = 0, paresMedidos = 0;
    // O `toque` abaixo é o regime, amostrado de meio em meio segundo. Entre duas amostras o
    // asfalto ainda se escreve, e um quadro de lataria sobre lataria é uma tela em que dois
    // ônibus são um só. Por isso a geometria é olhada em todo quadro, depois de o update ter
    // escrito os corpos: é exatamente o que a cena desenha, e o que ela nunca pode desenhar é
    // duas latarias no mesmo monte de asfalto.
    let quadroComContato = 0, fundoContato = 0, quadroDoFundo = -1, quemNoFundo = '';
    // Lataria que muda de lugar sem passar pelo meio é o "teletransporta" do jogador, e é ela que
    // o recuo de emergência escreve: um corpo e meio para trás no mesmo quadro, na frente de uma
    // câmera que desenha sessenta vezes por segundo. A régua é a da própria física do sistema —
    // um quadro de cruzeiro, e o dobro disso com a recuperação de atraso correndo atrás do
    // horário. Quem acabou de entrar em cena não tem quadro anterior: a lataria dele nasce onde
    // o horário manda, e é por isso que a janela do portão fica fora da conta.
    let recuoIlegal = 0, avancoIlegal = 0, maiorSalto = 0, maiorAvanco = 0, passosMedidos = 0;
    const amostraDoRecuo = [], amostraDoAvanco = [];
    const quadroAnterior = new Map();
    // Um minuto de asfalto a 60 quadros por segundo, amostrando a geometria a cada meio
    // segundo. Os quinze primeiros são aquecimento: o horário nasce com duas contas no mesmo
    // pixel, e o ônibus parado não atravessa o corpo do outro num frame — ele espera a rua
    // abrir. O que se cobra é o regime, não o instante zero.
    for (let f = 0; f < 3600; f++) {
      system.update(system.clock + 1 / 60, doMeio.x, doMeio.y, streaming);
      if (f >= 900) {
        for (let i = 0; i < system.bodies.length; i++) {
          const corpo = system.bodies[i];
          const u = system.units[i];
          const antes = quadroAnterior.get(i);
          // Quem nasce no quadro não tem história, e quem está no berço é a doca que o escreve:
          // os dois ficam fora da régua de passo, que é a conta de quem percorre asfalto.
          if (!corpo.live || !antes || u.stopped || system.nascida[i]) {
            if (corpo.live) quadroAnterior.set(i, { x: corpo.x, y: corpo.y, angle: corpo.angle });
            else quadroAnterior.delete(i);
            continue;
          }
          const cos = Math.cos(antes.angle), sin = Math.sin(antes.angle);
          const d = (corpo.x - antes.x) * cos + (corpo.y - antes.y) * sin;
          const lado = Math.abs(-(corpo.x - antes.x) * sin + (corpo.y - antes.y) * cos);
          const cruzeiro = network.services[network.routes[u.route].service].speed;
          // O teto de avanço é a física do sistema, não um palpite: um quadro de cruzeiro, mais
          // a recuperação de atraso (`ATRASO_RECUPERA` = meio quadro), mais a dívida de `deve`
          // que o corpo do quadro anterior devia por estar plantado (um quadro inteiro). Dois
          // quadros e meio de cruzeiro é o máximo que um ônibus pode andar entre duas amostras
          // sem que lataria tenha pulado asfalto. Os cinco por cento de folga cobrem o quadro em
          // que a dívida é quitada *neste* passo: a conta fecha no limite exato, e um limite exato
          // medido em ponto flutuante acusaria o próprio teto que ele acabou de respeitar.
          const tetoDeAvanço = cruzeiro / 60 * 2.5 * 1.05;
          // Um corpo do anel distante é materializado um quadro sim, quatro não: entre duas
          // leituras dele o asfalto percorrido é de quatro quadros, e nada disso é salto — o
          // ônibus andou o meio do caminho, a régua é que não estava olhando. Quem não foi lido
          // neste quadro deixa a marca de onde foi visto pela última vez.
          if (!system.lida[i]) continue;
          passosMedidos++;
          if (d < -0.02 || (d > tetoDeAvanço && lado < 0.2)) {
            const amostra = `f${f} ${network.routes[u.route].name}#${u.unit}: ${d.toFixed(3)}t `
              + `de ${antes.x.toFixed(2)},${antes.y.toFixed(2)} para `
              + `${corpo.x.toFixed(2)},${corpo.y.toFixed(2)} (atraso ${u.atraso.toFixed(2)}s, `
              + `dose ${system.marchaAnunciada(i).toFixed(2)}, cedendo ${system.cedendo[i].toFixed(2)}t)`;
            if (d < 0) {
              recuoIlegal++;
              if (Math.abs(d) > maiorSalto) maiorSalto = Math.abs(d);
              if (amostraDoRecuo.length < 3) amostraDoRecuo.push(amostra);
            } else {
              avancoIlegal++;
              if (d > maiorAvanco) maiorAvanco = d;
              if (amostraDoAvanco.length < 3) amostraDoAvanco.push(amostra);
            }
          }
          quadroAnterior.set(i, { x: corpo.x, y: corpo.y, angle: corpo.angle });
        }
      }
      if (f >= 900) {
        const vivos = [];
        const donos = [];
        for (let i = 0; i < system.bodies.length; i++) {
          if (!system.bodies[i].live) continue;
          vivos.push(system.bodies[i]);
          donos.push(i);
        }
        for (let a = 0; a < vivos.length; a++) {
          for (let c = a + 1; c < vivos.length; c++) {
            const dx = vivos[a].x - vivos[c].x, dy = vivos[a].y - vivos[c].y;
            // Duas caixas de 1,25 × 0,85 tiles não se encostam a três tiles de centro a centro,
            // e o filtro de distância é o que paga essa conta sessenta vezes por segundo.
            if (dx * dx + dy * dy > 9) continue;
            const folga = folgaEntre(vivos[a], vivos[c]);
            if (folga >= 0) continue;
            quadroComContato++;
            if (folga < fundoContato) {
              fundoContato = folga;
              quadroDoFundo = system.frame;
              // Quem são os dois: sem o nome da linha e a parada, o número diz que houve um
              // acidente e não onde. O fundo é sempre o caso mais grave, então um registro
              // dele basta para a mensagem apontar a esquina. A régua é do PAR que encosta
              // (`a`,`c`), não dos dois primeiros vivos da lista — ler `u[0]`/`u[1]` aqui era
              // acusar o relógio de quem nunca esteve no asfalto do acidente. E porque corpo e
              // relógio são a mesma escrita só no fim do quadro, a testemunha é reamostrada:
              // `sampleRoute` no atraso de agora diz se a lataria está onde o horário manda.
              const A = system.units[donos[a]], B = system.units[donos[c]];
              const naFaixa = (u, corpo, outro) => {
                const cs = Math.cos(corpo.angle), sn = Math.sin(corpo.angle);
                return {
                  frente: (outro.x - corpo.x) * cs + (outro.y - corpo.y) * sn,
                  lado: Math.abs(-(outro.x - corpo.x) * sn + (outro.y - corpo.y) * cs),
                };
              };
              const ga = vivos[a], gb = vivos[c];
              const reA = sampleRoute(network.routes[A.route],
                network.services[network.routes[A.route].service], system.clock - A.atraso, A.unit);
              const reB = sampleRoute(network.routes[B.route],
                network.services[network.routes[B.route].service], system.clock - B.atraso, B.unit);
              const roleta = network.routes[A.route];
              const conta = (u, corpo, re) => `${network.routes[u.route].name} frota${u.unit}`
                + ` fase${u.phase.toFixed(1)} atraso${u.atraso.toFixed(1)}`
                + `@${u.stop} ${u.stopped ? 'parado' : 'marcha'}${u.held ? '+segurado' : ''}`
                + ` corpo(${corpo.x.toFixed(2)},${corpo.y.toFixed(2)}a${(corpo.angle * 57.3).toFixed(0)}°)`
                + ` relógio(${re.x.toFixed(2)},${re.y.toFixed(2)})`;
              const fa = naFaixa(A, ga, gb), fb = naFaixa(B, gb, ga);
              quemNoFundo = `${conta(A, ga, reA)} contra ${conta(B, gb, reB)}`
                + ` · na minha faixa ele a ${fa.frente.toFixed(2)} de lado ${fa.lado.toFixed(2)}, `
                + `eu a ${fb.frente.toFixed(2)} de lado ${fb.lado.toFixed(2)}`
                + ` · linha ciclo ${roleta.cycle.toFixed(1)}, virador ${roleta.turnAt.toFixed(1)}, `
                + `frota de ${roleta.units}`;
            }
          }
        }
      }
      if (f < 900 || f % 30) continue;
      const vivas = [];
      for (let i = 0; i < system.units.length; i++) {
        const u = system.units[i];
        if (!u.live) continue;
        vivas.push(system.bodies[i]);
        if (u.held) segurado++;
        if (u.atraso > máximoAtraso) máximoAtraso = u.atraso;
        if (u.held && system.bodies[i].speed !== 0) corpoMentiroso++;
      }
      naRua = Math.max(naRua, vivas.length);
      leituras++;
      for (let a = 0; a < vivas.length; a++) {
        for (let c = a + 1; c < vivas.length; c++) {
          paresMedidos++;
          // Lataria com lataria, nos quatro eixos dos dois retângulos. Um círculo de raio fixo
          // deixaria passar o ônibus que atravessa na frente, que é o caso em que os dois
          // corpos são mais compridos do que largos — e a régua conservadora da frenagem, que
          // olha só os eixos de quem freia, contaria como toque um par que no asfalto tem rua
          // entre os dois. Essa diferença é a conta do meio: ela é o quanto a regra freia à
          // frente do encontro, não o bug que o jogador veria na tela.
          if (latariaComLataria(vivas[a], vivas[c])) {
            toque++;
          } else if (seEncostam(vivas[a], vivas[c]) || seEncostam(vivas[c], vivas[a])) conservadora++;
          const f = folgaEntre(vivas[a], vivas[c]);
          if (f < folgaMínima) folgaMínima = f;
          const d = Math.hypot(vivas[a].x - vivas[c].x, vivas[a].y - vivas[c].y);
          if (d < mínima) mínima = d;
        }
      }
    }
    // A amostra tem de ser uma rua cheia, não um quadro deserto: com poucos ônibus na cena a
    // régua de lataria não mede nada. O piso era *uma fração da frota simultânea*, e fração de
    // simultânea é o número que a batida recompensa: um entupimento despeja vinte latarias no
    // mesmo cruzamento e a cena parece cheia, enquanto a malha fluindo espalha a mesma frota e
    // lê menos de uma vez. O que a régua de fato mede são os pares olhados, então o piso de
    // "não é deserto" fica no absoluto e o peso estatístico vai para a contagem de pares.
    check(naRua >= 8 && leituras >= 60 && paresMedidos >= 4000,
      `a olhada para a frente foi medida com ${naRua} ônibus na rua, ${leituras} amostras e `
      + `${paresMedidos} pares de lataria olhados`);
    check(toque === 0, `dois ônibus encostam lataria: ${toque} amostra(s) com as caixas se tocando, `
      + `folga mais apertada a ${(isFinite(folgaMínima) ? folgaMínima : 0).toFixed(2)} tiles `
      + `(centros mais perto a ${(isFinite(mínima) ? mínima : 0).toFixed(2)} tiles)`);
    // A amostra de meio em meio segundo perdoa o contato de um quadro, e um quadro é uma tela:
    // dois ônibus desenhados no mesmo asfalto são um bug que o jogador vê mesmo que a régua de
    // amostragem nunca o pegue. Esta é a conta que não pisca.
    check(quadroComContato === 0, `${quadroComContato} quadro(s) com duas latarias em cima uma da `
      + `outra, a mais funda ${(-fundoContato).toFixed(3)} tiles no quadro ${quadroDoFundo} `
      + `· ${quemNoFundo}`);
    check(corpoMentiroso === 0, `${corpoMentiroso} amostra(s) de ônibus segurado por alguém à frente `
      + `reportando velocidade de cruzeiro ao trânsito`);
    // Lataria que pula é o "as vezes teletransporta" do jogador, e é a conta que o §13 inteiro não
    // media: até aqui eu cobrava onde os corpos PARAVAM, nunca o caminho que eles percorreram para
    // chegar lá. Um recuo de emergência de um corpo e meio no mesmo quadro é aprovado por todas as
    // regras de above — nenhuma caixa encosta, ninguém mente a marcha — e na tela é um ônibus que
    // deixa de existir num pixel e reaparece dois quarteirões atrás.
    check(recuoIlegal === 0, `${recuoIlegal} quadro(s) de lataria andando para TRÁS em ${passosMedidos} `
      + `passos medidos (${(recuoIlegal / Math.max(1, passosMedidos) * 100).toFixed(2)}% dos passos), `
      + `o maior recuo ${maiorSalto.toFixed(2)} tiles: `
      + (amostraDoRecuo.join(' | ') || 'nenhuma amostra'));
    // Andar para a frente depressa demais é a outra metade do mesmo gesto: o corpo não tem marcha
    // maior do que a própria via, e um passo de dois tiles num quadro de 1/60 s é a lataria
    // atravessando o cruzamento sem que o semáforo, o pedestre ou o vizinho o vejam no meio.
    check(avancoIlegal === 0, `${avancoIlegal} quadro(s) de lataria avançando mais que os `
      + `dois quadros e meio de cruzeiro que o sistema pode pagar em ${passosMedidos} passos `
      + `medidos, o maior avanço `
      + `${maiorAvanco.toFixed(2)} tiles: ` + (amostraDoAvanco.join(' | ') || 'nenhuma amostra'));
    check(segurado > 0, `ninguém foi segurado pela olhada para a frente em ${leituras} amostras: `
      + `a régua não viu a regra entrar em ação`);
    // O atraso é livre para crescer (parar atrás de alguém é parar de verdade), mas um minuto
    // de fila não pode comer a volta inteira: quem some do horário por mais que uma volta não
    // é mais um ônibus atrasado, é um ônibus que deixou de existir.
    const cicloMaisLongo = Math.max(...network.routes.map((r) => r.cycle));
    check(máximoAtraso < cicloMaisLongo,
      `a fila deixou um ônibus mais de uma volta inteira atrás do horário (${máximoAtraso.toFixed(1)}s `
      + `de atraso para o maior ciclo da malha, ${cicloMaisLongo.toFixed(0)}s)`);
    console.log(`frente seed ${seed}: ${naRua} ônibus na rua · ${segurado} amostras seguradas · `
      + `folga mais apertada ${(isFinite(folgaMínima) ? folgaMínima : 0).toFixed(2)} tiles · `
      + `${conservadora} amostra(s) de freio antes do toque · `
      + `${quadroComContato} quadro(s) de lataria sobre lataria · `
      + `${passosMedidos} passos de lataria medidos, ${recuoIlegal} recuo(s) (maior `
      + `${maiorSalto.toFixed(2)}t) e ${avancoIlegal} salto(s) à frente (maior ${maiorAvanco.toFixed(2)}t) · `
      + `maior atraso ${máximoAtraso.toFixed(1)}s`);
  }

  // ---- 14. A rua entra no freio. O §13 provou que dois horários não se atravessam; o que o
  //          jogador reclamou foi do que a malha não dirige: "eles atravessam carros", "não param
  //          pra pedestres que atravessam a rua". O ônibus agora recebe do `GameState` uma
  //          varredura do asfalto, e o que se cobra aqui é a conta que ela paga no relógio — a
  //          varredura em si é do `GameState` e é ela que o navegador olha. Quatro corpos, sempre
  //          plantados a 2,2 tiles na frente do MESMO ônibus, e uma pergunta por corpo: ele segura
  //          a lataria, ou não?
  //
  //          O ônibus é escolhido por um reconhecimento antes da medição: marcha livre pelos dois
  //          segundos (a malha não o segurou em quadro nenhum, ele não encostou em guichê algum,
  //          e a trilha dele percorre mais de três tiles), asfalto sob o corpo plantado e calçada
  //          de um dos lados. Entre os que servem, o critério de preferência é a solidão — o mais
  //          longe de qualquer outro asfalto — porque quanto menos gente em volta, menos cascata
  //          na conta. Mas a autoria da parada não é presumida pela solidão: ela é medida, quadro a
  //          quadro, por duas testemunhas adiante (`vazio.seguradas` e `frenteOcupada`). Numa
  //          cidade com duzentos ônibus no horário não existe asfalto deserto, e um número mágico
  //          de tiles seria apenas uma semente que passa ou não passa no check.
  {
    const meioDaLinha = network.routes[0].points[Math.floor(network.routes[0].points.length / 2)];
    const câmera = {
      ax: meioDaLinha.x, ay: meioDaLinha.y, zoom: 1,
      viewBounds: {
        minX: meioDaLinha.x - 8, maxX: meioDaLinha.x + 8,
        minY: meioDaLinha.y - 8, maxY: meioDaLinha.y + 8,
      },
    };
    streaming.update(câmera);
    const JANELA = 120;

    /** A rua do teste é uma lista fixa de corpos com o contrato do `GameState`, sem a grade. */
    function ruaDe(corpos) {
      return {
        pertoDe(x, y, raio, visita) {
          for (const c of corpos) {
            const dx = c.x - x, dy = c.y - y;
            if (dx * dx + dy * dy > raio * raio) continue;
            visita(c);
          }
        },
      };
    }

    /**
     * Copia o estado mutável do sistema — a frota, os corpos e as réguas de marcha — deixando
     * a malha, as sondas e as zonas onde estão. É o que permite rodar cinco cenários sobre o
     * MESMO ramo: refazer os novecentos quadros de aquecimento por corpo plantado pagaria o
     * check inteiro cinco vezes, e o aquecimento não é a conta que estou medindo.
     *
     * A cópia é uma instância NOVA, e não um `Object.create` do ramo. É `recebeRua` quem paga a
     * conta: ele é um campo-função, e campo-função fica vinculado a quem o construiu — um clone
     * que herda o `recebeRua` do original escreve a varredura da rua no ramo de origem e lê a
     * própria régua vazia. O resultado é silencioso e exatamente o pior possível para um check:
     * o pedestre plantado na faixa não segura ônibus nenhum, e a falha acusa o freio quando o
     * quebrado era o espelho.
     */
    function instantâneo(s) {
      const clone = (valor) => {
        if (ArrayBuffer.isView(valor)) return new valor.constructor(valor);
        if (Array.isArray(valor)) return valor.map(clone);
        if (valor && typeof valor === 'object') return { ...valor };
        return valor;
      };
      const cópia = new TransportSystem(map, seed);
      for (const chave of Object.keys(s)) {
        const valor = s[chave];
        if (typeof valor === 'function') continue;
        if (chave === 'network') continue;
        cópia[chave] = clone(valor);
      }
      return cópia;
    }

    /** Um sistema aquecido do zero: os mesmos novecentos quadros de regime do §13, sem rua. */
    function novoSistema() {
      const s = new TransportSystem(map, seed);
      for (let f = 0; f < 900; f++) {
        s.update(s.clock + 1 / 60, meioDaLinha.x, meioDaLinha.y, streaming);
      }
      return s;
    }

    // ---- reconhecimento: a janela vazia roda primeiro e anota, quadro a quadro, onde a frota
    //          inteira passou e quem foi segurado por ela. É dessa trilha que sai o ônibus
    //          medido: o critério é o mais solitário dos que correm soltos, e o que torna a
    //          conta honesta não é a solidão escolhida — é a medição dela, quadro a quadro, no
    //          fim de cada cenário (ver `vizinhos`). Numa cidade com cinquenta ônibus na tela
    //          não existe asfalto deserto; o que existe é o ônibus cujo entorno ninguém cruza
    //          por dois segundos, e é ele que a medição confirma ou desmente.
    const base = novoSistema();
    const ramo = base.bodies.map((b) => ({ x: b.x, y: b.y, angle: b.angle, live: b.live }));
    const ramoUnidades = base.units.map((u) => ({ stopped: u.stopped, atraso: u.atraso }));
    // O instante de onde cada cenário parte: o relógio do ramo, congelado antes da janela.
    const ramoDoRelógio = instantâneo(base);
    const trilha = [];
    const atrasos = [];
    const seguradasNaJanela = new Array(base.units.length).fill(0);
    const paradasNaJanela = new Array(base.units.length).fill(0);
    for (let f = 0; f < JANELA; f++) {
      base.update(base.clock + 1 / 60, meioDaLinha.x, meioDaLinha.y, streaming);
      trilha.push(base.bodies.map((b) => (b.live ? { x: b.x, y: b.y } : null)));
      atrasos.push(base.units.map((u) => u.atraso));
      for (let i = 0; i < base.units.length; i++) {
        if (base.units[i].held) seguradasNaJanela[i]++;
        if (base.units[i].stopped) paradasNaJanela[i]++;
      }
    }

    let v = -1;
    let ponto = null;
    let solidãoDoEscolhido = 0;
    let calçadaDoEscolhido = 0;
    for (let i = 0; i < base.units.length; i++) {
      const b = ramo[i];
      if (!b.live || ramoUnidades[i].stopped || seguradasNaJanela[i] > 0) continue;
      // Rodar solto pelo ramo NÃO basta: um ônibus que encosta no guichê no segundo seguinte ao
      // reconhecimento também não foi `held` em quadro nenhum, e ele para pelo dwell — não pela
      // rua. Medido, ele daria "o corpo plantado não segurou nada" (já estava parado) e a janela
      // de liberação daria "a faixa abriu e ele não saiu do lugar". É o deslocamento da trilha
      // quem separa o ônibus em marcha do ônibus encostado, e a marcha é o único regime onde um
      // pedestre pode mudar a conta.
      const última = trilha[JANELA - 1][i];
      if (!última || Math.hypot(última.x - b.x, última.y - b.y) < 3) continue;
      if (paradasNaJanela[i] > 0) continue;
      const alvo = { x: b.x + Math.cos(b.angle) * 2.2, y: b.y + Math.sin(b.angle) * 2.2 };
      if (map.tileKindAt(alvo.x, alvo.y) !== 'road') continue;
      // A calçada é o lado que NÃO é asfalto: sem um passeio ao lado do corpo plantado, o cenário
      // "pedestre na calçada não segura linha nenhuma" não teria onde ser plantado e viraria
      // "pedestre na faixa de lado" — que testa outra coisa, com outra resposta esperada.
      const lateral = { x: -Math.sin(b.angle), y: Math.cos(b.angle) };
      let lado = 0;
      for (const sinal of [1, -1]) {
        if (map.tileKindAt(alvo.x + lateral.x * 0.95 * sinal,
          alvo.y + lateral.y * 0.95 * sinal) !== 'road') { lado = sinal; break; }
      }
      if (lado === 0) continue;
      let mínima = Infinity;
      for (let f = 0; f < JANELA; f++) {
        for (let j = 0; j < base.units.length; j++) {
          if (j === i) continue;
          const p = trilha[f][j];
          if (!p) continue;
          const d = Math.hypot(p.x - alvo.x, p.y - alvo.y);
          if (d < mínima) mínima = d;
        }
      }
      if (mínima <= solidãoDoEscolhido) continue;
      v = i;
      ponto = alvo;
      solidãoDoEscolhido = mínima;
      calçadaDoEscolhido = lado;
    }
    check(v >= 0, 'nenhum ônibus da malha corre em marcha livre por dois segundos com a câmera na '
      + 'linha, com asfalto sob o corpo plantado e um passeio ao lado: sem um corpo em regime de '
      + 'cruzeiro para plantar alguém na frente, a conta abaixo não teria do que acusar o freio');

    if (v >= 0) {
      const rumo = ramo[v].angle;
      const lateral = { x: -Math.sin(rumo), y: Math.cos(rumo) };
      const PE = GAME_CONFIG.NPC_RADIUS;
      const sedãDef = VEHICLE_DEFS.sedan;
      const latariaDoSedã = {
        meio: Math.max(sedãDef.footprintW, sedãDef.footprintH) / 2,
        flanco: Math.min(sedãDef.footprintW, sedãDef.footprintH) / 2,
      };
      const ladoDaCalçada = calçadaDoEscolhido;
      // O raio da olhada para a frente, espelhado aqui de propósito: a pergunta abaixo é "havia
      // ALGUMA coisa na frente dele além do corpo plantado?", e ela só faz sentido na mesma
      // distância em que o próprio ônibus enxerga.
      const RAIO_DA_OLHADA = 6;

      /**
       * Roda a janela sobre o ramo congelado, com a rua entregue, e devolve a conta do ônibus
       * medido: quantos quadros ele foi segurado (plantado, ou dosando o pé na rampa antes de
       * plantar), se lataria e corpo se tocaram em algum, qual a
       * folga mais apertada entre eles, se um corpo segurado reportou marcha ao trânsito, o
       * asfalto que ele percorreu no último segundo, quantos quadros OUTRO ônibus da malha esteve
       * na frente dele dentro da olhada, e quantos vizinhos fecharam a janela com um relógio
       * diferente do reconhecimento.
       *
       * Os dois últimos são contas diferentes e cada uma prova uma coisa:
       *
       * `frenteOcupada` é o atestado de que o freio medido foi do corpo plantado. Um ônibus
       * parado no meio da malha não é uma bolha: quem vem atrás encosta nele e freia também, e
       * isso é trânsito funcionando, não contaminação. O que desqualificaria a medição é o
       * contrário — um VISINHO À FRENTE do medido, porque aí a lataria que o segurou pode ser
       * dele, e não do pedestre. A trilha do reconhecimento não cobre isso: ela é a rua vazia, e
       * num ramo vazio o ônibus de trás alcança o medido parado. É aqui, quadro a quadro, que a
       * frente precisa estar limpa.
       *
       * `vizinhosDiferentes` roda a mesma janela sem corpo nenhum, e aí a cascata não tem de onde
       * vir: o espelho tem de reproduzir o ramo ao último décimo de segundo, ou o que estou
       * medindo é a cópia, não a malha.
       */
      function mede(corpos) {
        const s = instantâneo(ramoDoRelógio);
        const rua = corpos.length ? ruaDe(corpos) : undefined;
        const caixa = { x: 0, y: 0, angle: 0, meio: RAIO_DO_ONIBUS, flanco: MEIA_LARGURA_DO_ONIBUS };
        let seguradas = 0, dosadas = 0, toque = 0, folga = Infinity, mentiroso = 0, vizinhosDiferentes = 0;
        let frenteOcupada = 0;
        let começoDoÚltimoSegundo = null, andou = 0;
        for (let f = 0; f < JANELA; f++) {
          s.update(s.clock + 1 / 60, meioDaLinha.x, meioDaLinha.y, streaming, undefined, rua);
          const u = s.units[v], b = s.bodies[v];
          if (u.held) { seguradas++; if (b.speed !== 0) mentiroso++; }
          // Dosar também é tirar a marcha: o corpo que entra na rampa a 3,5 tiles por segundo
          // perde marcha proporcional à rua que falta, e é só no fim dessa rampa que o pedal vai
          // ao chão. Contar só a planta é cobrar do freio o tudo-ou-nada que ele não tem mais.
          else if (s.marchaAnunciada(v) < 1) dosadas++;
          caixa.x = b.x; caixa.y = b.y; caixa.angle = b.angle;
          for (const c of corpos) {
            const d = folgaEntreCaixas(caixa, c);
            if (d < folga) folga = d;
            if (d < 0) toque++;
          }
          const cos = Math.cos(b.angle), sin = Math.sin(b.angle);
          for (let j = 0; j < s.bodies.length; j++) {
            if (j === v) continue;
            const outro = s.bodies[j];
            if (!outro.live) continue;
            const dx = outro.x - b.x, dy = outro.y - b.y;
            if (dx * dx + dy * dy > RAIO_DA_OLHADA * RAIO_DA_OLHADA) continue;
            // À frente, na faixa: a projeção no rumo dele é positiva e o desvio lateral cabe
            // numa pista. Atrás é a cascata honesta, e fora da faixa é outro ônibus em outra rua.
            if (dx * cos + dy * sin > 0 && Math.abs(-dx * sin + dy * cos) < 1) frenteOcupada++;
          }
          if (f === JANELA - 61) começoDoÚltimoSegundo = { x: b.x, y: b.y };
          if (começoDoÚltimoSegundo) {
            andou = Math.max(andou, Math.hypot(b.x - começoDoÚltimoSegundo.x, b.y - começoDoÚltimoSegundo.y));
          }
          if (f === JANELA - 1) {
            for (let j = 0; j < s.units.length; j++) {
              if (j === v) continue;
              if (Math.abs(s.units[j].atraso - atrasos[JANELA - 1][j]) > 1e-12) vizinhosDiferentes++;
            }
          }
        }
        return {
          s, seguradas, dosadas, toque, folga, mentiroso, andou, vizinhosDiferentes, frenteOcupada,
          atraso: s.units[v].atraso,
        };
      }

      const corpoDe = (x, y, ângulo, meio, flanco, mole, speed = 0) => ({
        x, y, angle: ângulo, speed, meio, flanco, mole,
      });
      const pedestreNaFaixa = () => corpoDe(ponto.x, ponto.y, rumo + Math.PI / 2, PE, PE, true);
      const vazio = mede([]);
      const naFaixa = mede([pedestreNaFaixa()]);
      const naCalçada = mede([corpoDe(ponto.x + lateral.x * 0.95 * ladoDaCalçada,
        ponto.y + lateral.y * 0.95 * ladoDaCalçada, rumo, PE, PE, true, 1.2)]);
      const javali = mede([corpoDe(ponto.x, ponto.y, rumo + Math.PI / 2, 0.34, 0.34, true)]);
      const sedã = mede([corpoDe(ponto.x, ponto.y, rumo, latariaDoSedã.meio,
        latariaDoSedã.flanco, false)]);

      // ---- O espelho é fiel ao ramo. Sem corpo na rua, a janela copiada tem de fechar com o
      //          MESMO relógio de cada vizinho e com o medido nunca segurado — senão o que estou
      //          medindo adiante é o clone, e qualquer número abaixo mente.
      check(vazio.vizinhosDiferentes === 0 && vazio.seguradas === 0,
        `a rua vazia não reproduziu o reconhecimento: ${vazio.vizinhosDiferentes} vizinho(s) com o `
        + `relógio trocado e o ônibus segurado em ${vazio.seguradas} quadro(s) sem corpo na faixa`);

      // ---- E a frente estava limpa. Um ônibus parado no meio da malha faz quem vem ATRÁS frear
      //          também — isso é trânsito, e é justamente o §13 —, mas um ônibus À FRENTE tiraria
      //          do corpo plantado a autoria da parada medida abaixo. Só os cenários segurados
      //          precisam desse atestado: no do passeio a conta é `não segurou`, e um vizinho à
      //          frente aparece igual na rua vazia — é a igualdade exata de atraso adiante que
      //          cobra isso, não a geometria.
      const sujas = [['pedestre', naFaixa], ['javali', javali],
        ['sedã', sedã]].filter(([, m]) => m.frenteOcupada > 0);
      check(sujas.length === 0,
        sujas.map(([nome, m]) => `${nome}: ${m.frenteOcupada} quadro(s) com outro ônibus da malha na `
          + 'frente, dentro da olhada e na mesma faixa').join(' · ')
        + ' — a lataria que segurou o ônibus pode ser dele, e não do corpo plantado');

      // ---- Quem está na faixa do ônibus para o ônibus. Vale para o pedestre, para o bicho e para
      //          a lataria de um carro parado: os três são o "eles atravessam carros / não param
      //          pra pedestres que atravessam a rua" que a tela mostrou, e a conta é a mesma nos
      //          três — segurar o relógio, nunca tocar o corpo e ficar plantado no asfalto.
      for (const [nome, m] of [['pedestre', naFaixa], ['javali', javali], ['sedã parado', sedã]]) {
        // Plantado ou dosando: o corpo na faixa tem de ter tirado a marcha do ônibus, e a régua é
        // a janela inteira — a rampa de aproximação é parte do freio, não uma folga nele.
        check(m.seguradas + m.dosadas >= JANELA * 0.8,
          `${nome} plantado na faixa segurou o ônibus em apenas ${m.seguradas} de ${JANELA} quadros `
          + `(${m.dosadas} dosando o pé antes deles)`);
        check(m.atraso - vazio.atraso > 1,
          `${nome} na faixa não custou tempo nenhum ao ônibus: ${m.atraso.toFixed(2)}s de atraso contra `
          + `${vazio.atraso.toFixed(2)}s com a rua vazia`);
        check(m.toque === 0, `${nome} na faixa foi atravessado: ${m.toque} quadro(s) com a lataria `
          + `sobre o corpo, a folga mais apertada a ${m.folga.toFixed(3)} tiles dele`);
        check(m.mentiroso === 0, `${m.mentiroso} quadro(s) de ônibus segurado por ${nome} reportando `
          + `velocidade de cruzeiro ao trânsito`);
        // Um décimo de tile por segundo é o assentamento da própria linha de parada: parado, o
        // corpo não tem marcha, a margem de um quadro (`speed * PASSO_MÁXIMO`) sai da régua, e a
        // folga pura volta a ser a marca. Cobrar zero cobraria a conta exata de um quadro e o
        // check falharia por um centímetro de asfalto. O que não tem defesa é deslizar: meio tile
        // num segundo é o ônibus entrando na travessa com o pedestre nela.
        check(m.andou < 0.1, `o ônibus andou ${m.andou.toFixed(2)} tiles no último segundo com ${nome} `
          + 'na faixa: segurar o relógio é ficar plantado no asfalto, não deslizar para dentro do corpo');
      }

      // ---- E quem está na calçada não segura linha nenhuma. É a contraparte exata do número
      //          acima, e é a que importa para a cidade inteira: se a faixa do ônibus fosse larga
      //          o bastante para prender quem passa no passeio, toda linha da malha encostaria em
      //          cada pedestre de cada esquina e o horário viraria lenda. Com a isolação medida
      //          acima, a conta tem de ser a da rua vazia, ao último décimo de segundo.
      check(ladoDaCalçada !== 0, 'não havia calçada ao lado do ponto plantado: o corpo de fora '
        + 'da faixa não foi testado');
      check(naCalçada.seguradas === 0,
        `um pedestre a 0,95 tile do eixo da faixa — no passeio — segurou o ônibus em `
        + `${naCalçada.seguradas} quadro(s)`);
      check(Math.abs(naCalçada.atraso - vazio.atraso) < 1e-9,
        `o pedestre do passeio custou ${(naCalçada.atraso - vazio.atraso).toFixed(3)}s de atraso ao `
        + 'ônibus: a faixa está mais larga do que a lataria dele');
      check(naCalçada.toque === 0,
        `a lataria passou por cima do pedestre do passeio em ${naCalçada.toque} quadro(s)`);

      // ---- A faixa abrindo, o ônibus volta a andar. É a metade que falta ao freio: um corpo que
      //          segura o relógio para sempre é um ônibus que sumiu do horário, e o que o jogador
      //          viu foi justamente lataria desaparecendo no meio do mapa.
      {
        const rua = ruaDe([pedestreNaFaixa()]);
        const presa = naFaixa.s;
        const antes = presa.units[v].atraso;
        const encostado = { x: presa.bodies[v].x, y: presa.bodies[v].y };
        let segurouDepois = 0, percorrido = 0, frenteDepois = 0;
        let motivoSegurou = '', vizinhos = [];
        // O atraso só é devolvido com a rua aberta de verdade: parado no horário o ônibus não tem
        // o que recuperar, segurado pelo freio ele está pagando, e com lataria na folga de
        // encosto recuperar é fechar o buraco que o recuo acabou de abrir. Falta ainda a janela
        // que o próprio streaming abre: no anel distante a linha é calculada um quadro a cada
        // `VEHICLE_SIM_TICK_DIVISOR`, e relógio nenhum anda nos quadros em que o ônibus nem foi
        // lido. Falta a sexta, que só aparece quando a linha escolhida beira o recorte: o corpo
        // pode estar calculado e mesmo assim fora da cena, porque `cuidaDaFrente` pula quem o
        // asfalto não materializa — um ônibus que o jogador não vê não deve marcha a ninguém nem
        // tem de quem recebê-la, e cobrar recuperação desses quadros seria acusar o streaming de
        // estrangular o horário. Sem separar as sete contas a falha parece um freio que não solta
        // quando é uma lataria que o recorte de cena ainda não calculou.
        let noDwell = 0, naFolga = 0, noFreio = 0, ruaLivre = 0, nãoLido = 0, foraDaCena = 0;
        // O sétimo balde é o ônibus dosando o pé atrás de outro ônibus: ele não está segurado
        // (tem marcha), não está na folga (ainda tem rua), e mesmo assim cobra atraso do
        // relógio. Contar esse quadro como rua livre é a régua que acusava o freio de não
        // devolver marcha quando o que aconteceu foi o ônibus freando em progresso.
        let dosando = 0, cobradoDosando = 0, cobradoLivre = 0;
        // A régua de verdade é o que o relógio fez quadro a quadro, não o que a geometria parece
        // dizer: somar o que foi devolvido e o que foi cobrado separa "a rua estava tomada" de
        // "a conta não rodou", e só a segunda é defeito.
        let devolvido = 0, cobrado = 0, parado = 0, presaNaFolgaDoSistema = 0, semMotivo = null;
        let relógioAnterior = antes;
        // A olhada para a frente lê o asfalto ANTES do freio decidir: reler a régua no fim do
        // quadro é medir a rua depois que o próprio recuo a reorganizou, e um corpo que caiu um
        // passo para trás mostra folga onde o motorista viu lataria. O que se cobra aqui é a
        // decisão, não a fotografia.
        let quadroDaOlhada = 0;
        let vistoNaFrente = false, obstáculo = '';
        const frenteOriginal = presa.apertoÀFrente.bind(presa);
        const ruaOriginal = presa.apertoDaRua.bind(presa);
        const abraçoOriginal = presa.abraço.bind(presa);
        const travessiaOriginal = presa.apertoDeTravessia.bind(presa);
        const cuidaOriginal = presa.cuidaDaFrente.bind(presa);
        presa.cuidaDaFrente = (dt) => {
          const bb = presa.bodies[v], uu = presa.units[v];
          vistoNaFrente = false;
          if (bb.live && !uu.stopped && quadroDaOlhada >= 10) {
            const n = frenteOriginal(v, bb);
            const rr = ruaOriginal(v, bb);
            const travessia = travessiaOriginal(v, bb);
            const ab = abraçoOriginal(v, bb);
            if (n.aperto > 0 || rr.aperto > 0 || ab > 0 || travessia > 0
              || n.deficit > 0 || rr.deficit > 0) {
              vistoNaFrente = true;
              if (!obstáculo) {
                obstáculo = `quadro ${quadroDaOlhada}: frente ${n.aperto.toFixed(3)}/`
                  + `${n.deficit.toFixed(2)}t, rua ${rr.aperto.toFixed(3)}/${rr.deficit.toFixed(2)}t, `
                  + `abraço ${ab.toFixed(2)}t, travessia ${travessia.toFixed(3)}`;
              }
            }
          }
          return cuidaOriginal(dt);
        };
        for (let f = 0; f < JANELA; f++) {
          // Os três primeiros quadros ainda têm o pedestre no asfalto: é a travessa da rua, não a
          // do relógio — o corpo sai do mundo e a olhada para a frente tem de soltar junto.
          quadroDaOlhada = f;
          presa.update(presa.clock + 1 / 60, meioDaLinha.x, meioDaLinha.y, streaming,
            undefined, f < 3 ? rua : undefined);
          const u = presa.units[v];
          const contas = u.atraso - relógioAnterior;
          relógioAnterior = u.atraso;
          if (contas > 1e-9) cobrado += contas;
          else if (contas < -1e-9) devolvido -= contas;
          if (f > 10 && u.held && !vistoNaFrente) {
            segurouDepois++;
            if (!motivoSegurou) {
              const bb = presa.bodies[v];
              motivoSegurou = `quadro ${f}: atraso ${u.atraso.toFixed(2)}s, no dwell ${u.stopped}, `
                + 'materializado ' + bb.live;
              for (let j = 0; j < presa.units.length; j++) {
                if (j === v || !presa.bodies[j].live) continue;
                const d = Math.hypot(presa.bodies[j].x - bb.x, presa.bodies[j].y - bb.y);
                if (d < 6) vizinhos.push(`${network.routes[presa.units[j].route].name}#${presa.units[j].unit} `
                  + `${d.toFixed(2)}t ${presa.units[j].stopped ? 'PARADO' : 'marcha'}`);
              }
            }
          }
          const b = presa.bodies[v];
          const cos = Math.cos(b.angle), sin = Math.sin(b.angle);
          let colado = false;
          for (let j = 0; j < presa.bodies.length; j++) {
            if (j === v || !presa.bodies[j].live) continue;
            const dx = presa.bodies[j].x - b.x, dy = presa.bodies[j].y - b.y;
            if (dx * dx + dy * dy > RAIO_DA_OLHADA * RAIO_DA_OLHADA) continue;
            const alonge = dx * cos + dy * sin;
            if (alonge > 0 && Math.abs(-dx * sin + dy * cos) < 1) frenteDepois++;
            if (alonge > 0 && alonge < 2 * RAIO_DO_ONIBUS + FOLGA_PARA_CHOQUE
              && Math.abs(-dx * sin + dy * cos) < 1) colado = true;
          }
          if (!presa.lida[v]) nãoLido++;
          else if (!b.live) foraDaCena++;
          else if (u.stopped) noDwell++;
          else if (u.held) noFreio++;
          else if (colado) naFolga++;
          else if (presa.marchaAnunciada(v) < 1) {
            dosando++;
            if (contas > 1e-9) cobradoDosando += contas;
          }
          else {
            ruaLivre++;
            if (contas > 1e-9) cobradoLivre += contas;
            // Rua aberta e o relógio parado: é aqui, e só aqui, que a conta tem de devolver
            // marcha. Em vez de adivinar a geometria de fora, se pergunta ao próprio sistema o que
            // a olhada para a frente viu no quadro — a mesma régua que `cuidaDaFrente` usou.
            if (Math.abs(contas) < 1e-9) {
              parado++;
              // As quatro fontes que o portão de `cuidaDaFrente` consulta, lidas uma por uma: o
              // `aperto` vem da frente ou do cruzamento, o `abraço` vem do ombro, e o `deficit`
              // vem de lataria que já está dentro de lataria — na malha ou na rua. Dizer só
              // "estava colado" não separa a fila legítima do buraco na régua.
              const naFrente = presa.apertoÀFrente(v, b);
              const ruaVista = presa.apertoDaRua(v, b);
              const aberto = {
                f, atraso: u.atraso, frente: naFrente, abraço: presa.abraço(v, b),
                travessia: presa.apertoDeTravessia(v, b),
                // Copiado, não emprestado: `apertoDaRua` devolve o buffer `contaRua` do sistema,
                // que o próximo quadro reescreve. Guardar a referência era ler o veredito de
                // outro ônibus.
                rua: { aperto: ruaVista.aperto, deficit: ruaVista.deficit, colado: ruaVista.colado },
              };
              if (naFrente.colado && aberto.abraço === 0 && aberto.travessia === 0
                && aberto.rua.aperto === 0 && aberto.rua.deficit === 0) presaNaFolgaDoSistema++;
              else if (!semMotivo) semMotivo = aberto;
            }
          }
          percorrido = Math.max(percorrido, Math.hypot(b.x - encostado.x, b.y - encostado.y));
        }
        const depois = presa.units[v].atraso;
        // Segurar diante de uma lataria medida é trânsito; segurar sem que a própria olhada do
        // sistema tenha visto nada é o corpo preso no horário. A régua é a leitura que decide o
        // freio, não a fotografia do fim do quadro — depois do recuo a folga sempre aparece.
        check(segurouDepois === 0, `a faixa abriu e o ônibus continuou segurado SEM NADA À FRENTE em `
          + `${segurouDepois} de ${JANELA - 11} quadros (${frenteDepois} deles com outro ônibus da malha `
          + 'na frente): o corpo saiu da rua e ficou preso no horário'
          + `${motivoSegurou ? ` · primeiro segurado: ${motivoSegurou}` : ''}`
          + `${vizinhos.length ? ` · perto: ${vizinhos.join(' | ')}` : ''}`
          + `${obstáculo ? ` · última olhada que viu alguma coisa: ${obstáculo}` : ' · a olhada nunca viu nada'}`);
        // Meia marcha por segundo exatamente nos quadros em que a rua estava aberta, com a
        // tolerância de um quadro pela borda entre o relógio e a lataria. É a régua do que de
        // fato aconteceu: os três quadros em que o pedestre ainda sai do mundo são freio, não
        // deixa de ser, e cobrar os dois segundos inteiros seria cobrar de um ônibus parado.
        const esperava = Math.min((ruaLivre / 60) * 0.5, antes + cobrado);
        check(devolvido >= esperava - 0.5 / 60,
          `aberta a faixa, o ônibus devolveu ${devolvido.toFixed(2)}s de atraso em ${ruaLivre} `
          + `quadro(s) de rua livre (esperava ${esperava.toFixed(2)}s; saldo ${(antes - depois).toFixed(2)}s `
          + `de ${antes.toFixed(2)}s para ${depois.toFixed(2)}s): ${cobrado.toFixed(2)}s cobrados em `
          + `${noFreio} quadro(s) de freio · dos ${parado} quadro(s) em que a rua estava aberta e o `
          + `relógio não andou, ${presaNaFolgaDoSistema} o próprio sistema via colado${semMotivo ? ` e o `
            + `primeiro sem explicação foi o quadro ${semMotivo.f} (atraso ${semMotivo.atraso.toFixed(2)}s: `
            + `frente aperta ${semMotivo.frente.aperto.toFixed(3)}/déficit `
            + `${semMotivo.frente.deficit.toFixed(2)} tiles, abraço `
            + `${semMotivo.abraço.toFixed(2)} tiles, travessia ${semMotivo.travessia.toFixed(3)}, `
            + `rua aperta ${semMotivo.rua.aperto.toFixed(3)}/déficit ${semMotivo.rua.deficit.toFixed(2)})`
            : ' e nenhum sem explicação'} — `
          + `${nãoLido} nem calculados na zona distante, ${foraDaCena} com o corpo fora da cena, `
          + `${noDwell} no dwell do horário, ${naFolga} com `
          + `lataria na folga de encosto, ${dosando} dosando o pé (${cobradoDosando.toFixed(2)}s `
          + `cobrados neles) e ${cobradoLivre.toFixed(2)}s cobrados em quadro(s) contado(s) como `
          + `rua livre)`);
        check(percorrido > 1, `o ônibus não saiu do lugar depois que o pedestre atravessou: `
          + `${percorrido.toFixed(2)} tiles percorridos em dois segundos de rua livre`);
        console.log(`rua seed ${seed}: ônibus da linha ${base.units[v].route} sozinho a `
          + `${solidãoDoEscolhido.toFixed(1)} tiles · pedestre na faixa segurou ${naFaixa.seguradas}/${JANELA} quadros `
          + `(+${(naFaixa.atraso - vazio.atraso).toFixed(2)}s) · javali ${javali.seguradas} `
          + `(+${(javali.atraso - vazio.atraso).toFixed(2)}s) · sedã ${sedã.seguradas} `
          + `(+${(sedã.atraso - vazio.atraso).toFixed(2)}s) · passeio ${naCalçada.seguradas} `
          + `(+${(naCalçada.atraso - vazio.atraso).toFixed(3)}s) · nenhum toque, folga mais apertada `
          + `${Math.min(naFaixa.folga, javali.folga, sedã.folga, naCalçada.folga).toFixed(2)} tiles · `
          + `faixa aberta devolveu ${devolvido.toFixed(2)}s em ${ruaLivre} quadro(s) de rua livre `
          + `(cobrados ${cobrado.toFixed(2)}s, ${parado} quadro(s) de rua aberta com o relógio parado: `
          + `${presaNaFolgaDoSistema} deles o sistema via colado${semMotivo ? `, sobrando o quadro `
            + `${semMotivo.f} (frente ${semMotivo.frente.aperto.toFixed(3)}/`
            + `${semMotivo.frente.deficit.toFixed(2)} tiles, abraço `
            + `${semMotivo.abraço.toFixed(2)} tiles, travessia ${semMotivo.travessia.toFixed(3)}, `
            + `rua ${semMotivo.rua.aperto.toFixed(3)}/${semMotivo.rua.deficit.toFixed(2)} tiles)`
            : ', sem nenhum sem causa'} · ${nãoLido} fora do `
          + `cálculo, ${foraDaCena} fora da cena, ${noFreio} no freio, ${noDwell} no dwell, `
          + `${naFolga} na folga) e `
          + `${percorrido.toFixed(1)} tiles`
          + ` · cascata atrás: ${[naFaixa, javali, sedã].map((m) => m.vizinhosDiferentes).join('/')}`
          + ' vizinho(s) frearam junto (esperado: lataria parada na faixa é fila)');
      }
    }
  }

  // ---- 15. O ônibus obedece a luz. O §13 provou que dois horários não se atravessam e o §14
  //          que a rua entra no freio. Faltava a terceira parede da cidade parada, e foi a
  //          primeira que o jogador apontou: "eles atravessam carros". Dentro do carro, o ônibus
  //          passava no vermelho por cima de quem espera o verde, porque nenhuma conta da malha
  //          perguntava a um poste se podia entrar no cruzamento — enquanto o `TrafficSystem` já
  //          pergunta, e é por isso que o resto do trânsito para.
  //
  //          A luz aqui é PINADA: `sinais.update` nunca é chamado, e cada caixa guarda para
  //          sempre a fase em que a geometria a pôs. É de propósito. Um ciclo rodando faria a
  //          medida depender de em que fase o aquecimento pegou cada poste, e o que se quer
  //          cobrar é a regra, não o sorteio: com o vermelho fixo, lataria que entra na boca é
  //          invasão sem apelação, e o verde que solta a fila é a MESMA caixa, um frame depois,
  //          com a luz trocada à mão — que é a única prova de que o ônibus parou pela luz e não
  //          porque a rua estava entupida.
  {
    const OLHADA = 7;
    const sinais = new TrafficSignalSystem();
    sinais.init(map);
    const controlados = sinais.signals.filter((s) => s.controlled);
    check(controlados.length > 0, 'a cidade gerada não tem um único cruzamento com luz');

    /** Quantos passos de rota correm para dentro desta boca, por este eixo: o critério da câmera. */
    function aproximação(posto, noX) {
      let passos = 0;
      for (const rota of network.routes) {
        for (const perna of [rota.points, rota.back]) {
          for (let i = 1; i < perna.length; i++) {
            const a = perna[i - 1], b = perna[i];
            const dx = Math.sign(b.x - a.x), dy = Math.sign(b.y - a.y);
            if (noX ? (dx === 0 || dy !== 0) : (dy === 0 || dx !== 0)) continue;
            const u = noX ? dx : dy;
            const beira = (noX ? (u > 0 ? posto.minX : posto.maxX) : (u > 0 ? posto.minY : posto.maxY));
            const falta = (beira - (noX ? a.x : a.y)) * u;
            if (falta <= 0 || falta > OLHADA) continue;
            const lado = noX ? a.y : a.x;
            const span = noX ? [posto.minY, posto.maxY] : [posto.minX, posto.maxX];
            if (lado < span[0] - 1 || lado > span[1] + 1) continue;
            passos++;
          }
        }
      }
      return passos;
    }

    // Candidatos: cada caixa controlada com um eixo no vermelho, ordenada por quantas rotas ela
    // segura na porta, com uma preferência declarada pela boca do eixo do `y`: é nela que a mesma
    // passagem prova também a cortesia (`request`) que o carro faz — ninguém fica parado no verde
    // do eixo principal sem que alguém tenha pedido o outro. Na boca do eixo do x a luz é a única
    // testemunha possível, e a régua abaixo diz qual das duas foi medida. A preferência é um peso
    // de 0,6 sobre a boca do x, não um veto: uma esquina do `y` com um passo de rota não apagaria
    // a avenida do `x` com duzentos.
    const candidatos = [];
    for (const posto of controlados) {
      for (const noX of [false, true]) {
        if ((noX ? posto.xLight : posto.yLight) !== 'red') continue;
        const passos = aproximação(posto, noX);
        if (passos > 0) candidatos.push({ posto, noX, passos, peso: noX ? passos * 0.6 : passos });
      }
    }
    candidatos.sort((a, b) => b.peso - a.peso);
    check(candidatos.length > 0,
      'nenhum cruzamento com luz vermelha tem uma rota correndo para dentro dele');

    const rede = new TransportSystem(map, seed);
    rede.signals = sinais;
    let medida = null;
    const tentativas = [];
    for (const cand of candidatos.slice(0, 6)) {
      const câmera = {
        ax: cand.posto.x, ay: cand.posto.y, zoom: 1,
        viewBounds: {
          minX: cand.posto.x - 8, maxX: cand.posto.x + 8,
          minY: cand.posto.y - 8, maxY: cand.posto.y + 8,
        },
      };
      streaming.update(câmera);
      for (let f = 0; f < 300; f++) {
        rede.update(rede.clock + 1 / 60, câmera.ax, câmera.ay, streaming);
      }
      let chegadas = 0, naLuz = 0, sóLuz = 0, plantado = 0, mentiroso = 0, invasões = 0;
      let folgaMínima = Infinity, verdes = 0, diagonais = 0, dentroDaBoca = 0;
      let líder = -1, folgaDoLíder = Infinity, rumoDoLíder = 0;
      let piorInvasão = 0, quemInvasor = '';
      for (let f = 0; f < 600; f++) {
        rede.update(rede.clock + 1 / 60, câmera.ax, câmera.ay, streaming);
        for (let i = 0; i < rede.units.length; i++) {
          const unid = rede.units[i], corpo = rede.bodies[i];
          if (!corpo.live || !unid.live || unid.stopped) continue;
          const ux = Math.cos(corpo.angle), uy = Math.sin(corpo.angle);
          // A caixa do corpo é virada pelo rumo quantizado, não pelo `angle` do segmento: numa
          // curva o ângulo é diagonal e o nariz medido nele cairia fora da lataria desenhada.
          if (Math.max(Math.abs(ux), Math.abs(uy)) < 0.999) { diagonais++; continue; }
          const noX = Math.abs(ux) >= Math.abs(uy);
          const rumo = noX ? ux : uy;
          // Quem já está na caixa não freia — pegou o amarelo e atravessa. É a metade da regra
          // que a luz pinada não pode apagar: um ônibus plantado no meio do cruzamento segura as
          // duas correntes ao mesmo tempo, que é o entupimento que ninguém destrava a pé.
          if (sinais.at(corpo.x, corpo.y)) { dentroDaBoca++; continue; }
          let posto = null;
          for (let d = 0.5; d <= OLHADA && !posto; d += 0.5) {
            posto = sinais.at(corpo.x + ux * d, corpo.y + uy * d);
          }
          if (!posto || !posto.controlled) continue;
          if ((noX ? posto.xLight : posto.yLight) !== 'red') { verdes++; continue; }
          // A boca é a aresta que este corpo encara, e o nariz é a lataria dele projetada no
          // próprio eixo. Parar com o para-choque em cima da faixa de travessia é tapar o fluxo
          // cruzado — outra parede, mesma conta de metros.
          const beira = noX ? (rumo > 0 ? posto.minX : posto.maxX)
            : (rumo > 0 ? posto.minY : posto.maxY);
          const lado = noX ? corpo.y : corpo.x;
          const span = noX ? [posto.minY, posto.maxY] : [posto.minX, posto.maxX];
          if (lado < span[0] - 0.5 || lado > span[1] + 0.5) continue;
          const folga = (beira - (noX ? corpo.x : corpo.y)) * rumo - corpo.meio;
          if (folga < -corpo.meio * 2) continue;
          chegadas++;
          if (folga < folgaMínima) folgaMínima = folga;
          if (folga < -0.02) {
            invasões++;
            if (-folga > piorInvasão) {
              piorInvasão = -folga;
              quemInvasor = `${network.routes[unid.route].name}#${unid.unit} entrou `
                + `${(-folga).toFixed(2)} tiles na boca do cruzamento ${posto.id}`
                + `(${posto.x},${posto.y}) pelo eixo ${noX ? 'x' : 'y'} com a luz `
                + `${(noX ? posto.xLight : posto.yLight)} · ${corpo.dir} marchando `
                + `${rede.marchaAnunciada(i).toFixed(2)} e atraso ${unid.atraso.toFixed(1)}s`;
            }
          }
          // A atribuição. Apertar por causa da luz é outra conta que apertar por causa da fila:
          // as três fontes que decidem a marcha são lidas uma por uma, e os baldes que o
          // sistema empresta são copiados na hora, porque o próximo ônibus reescreve o mesmo
          // objeto — guardar a referência era medir o veredito de outro corpo.
          const luz = rede.apertoDoSinal(i, corpo);
          const apertoLuz = luz.aperto;
          if (apertoLuz <= 0) continue;
          naLuz++;
          const frota = rede.apertoÀFrente(i, corpo);
          const rua = rede.apertoDaRua(i, corpo);
          const apertoRua = rua.aperto, deficitRua = rua.deficit;
          if (frota.aperto <= 0 && apertoRua <= 0 && deficitRua <= 0 && frota.deficit <= 0
            && rede.abraço(i, corpo) <= 0 && rede.apertoDeTravessia(i, corpo) <= 0) {
            sóLuz++;
            if (unid.held) {
              plantado++;
              if (corpo.speed !== 0) mentiroso++;
            }
            if (posto === cand.posto && noX === cand.noX && folga > 0 && folga < folgaDoLíder) {
              líder = i; folgaDoLíder = folga; rumoDoLíder = rumo;
            }
          }
        }
      }
      const pediuVez = cand.posto.demandY > 0;
      tentativas.push(`cruzamento ${cand.posto.id}(${cand.posto.x},${cand.posto.y}) eixo `
        + `${cand.noX ? 'x' : 'y'}: ${chegadas} chegada(s) no vermelho, ${sóLuz} quadro(s) `
        + `segurados só pela luz, ${invasões} invasão(ões)`);
      if (sóLuz >= 20 && líder >= 0) {
        medida = { ...cand, câmera, líder, rumo: rumoDoLíder, folgaDoLíder, pediuVez,
          chegadas, naLuz, sóLuz, plantado, mentiroso, invasões, piorInvasão, quemInvasor,
          folgaMínima, verdes, dentroDaBoca, diagonais };
        break;
      }
    }

    if (!medida) {
      check(false, `o semáforo nunca segurou um ônibus da malha: ${tentativas.length} boca(s) `
        + `vermelha(s) olhada(s) e em nenhuma a luz foi a única parede · `
        + `${tentativas.join(' · ') || 'nenhuma caixa controlada com rota chegando'}`);
    } else {
      // A régua não pode ter medido um deserto: sem trânsito chegando à boca, "nenhuma invasão"
      // é uma afirmação sobre uma cidade vazia.
      check(medida.chegadas >= 40, `a boca do cruzamento ${medida.posto.id} teve só `
        + `${medida.chegadas} amostra(s) de ônibus chegando no vermelho em 600 quadros`);
      // O que o jogador acusa: "atravessam carros". Um carro parado no verde do eixo cruzado é
      // exatamente a lataria na frente desta boca, e aqui a luz está pinada — não existe fase em
      // que o vermelho era verde quando ele entrou.
      check(medida.invasões === 0, `${medida.invasões} quadro(s) de lataria dentro da boca do `
        + `cruzamento no vermelho · o mais fundo: ${medida.quemInvasor || 'nenhum'} · folga mais `
        + `apertada lida na janela ${medida.folgaMínima.toFixed(2)} tiles antes da boca`);
      check(medida.mentiroso === 0, `${medida.mentiroso} quadro(s) de ônibus plantado pelo sinal `
        + `anunciando marcha ao trânsito`);
      // A luz não é uma parede universal: o eixo que está no verde tem de passar, senão a régua
      // de cima estaria medindo um cruzamento fechado para todo mundo.
      check(medida.verdes > 0, `nenhum ônibus passou pelo eixo verde dos ${medida.chegadas} `
        + `corpos olhados: a conta não distingue a luz do muro`);
      // A cortesia do eixo cruzado: um ônibus parado no vermelho do `y` é demanda. Sem ela, o
      // cruzamento passa a volta inteira mostrando verde para o eixo principal e o ônibus nunca
      // teria vez — o mesmo pedido que o carro já faz em `TrafficSystem`.
      check(!medida.noX || medida.pediuVez, `o ônibus chegou à boca do eixo do y e nunca pediu `
        + `a vez (demandY = ${medida.posto.demandY})`);
      // O verde solta a fila: a MESMA caixa, a MESMA lataria, um frame de diferença na luz. É a
      // prova de que o corpo estava plantado pela luz e não pelo horário — no dwell do ponto a
      // luz não muda nada, e aqui ela mudou.
      const posto = medida.posto;
      if (medida.noX) posto.xLight = 'green'; else posto.yLight = 'green';
      const beira = medida.noX ? (medida.rumo > 0 ? posto.minX : posto.maxX)
        : (medida.rumo > 0 ? posto.minY : posto.maxY);
      let cruzou = -1, andou = 0;
      const saída = { x: rede.bodies[medida.líder].x, y: rede.bodies[medida.líder].y };
      for (let f = 0; f < 600 && cruzou < 0; f++) {
        rede.update(rede.clock + 1 / 60, medida.câmera.ax, medida.câmera.ay, streaming);
        const corpo = rede.bodies[medida.líder];
        andou = Math.max(andou, Math.hypot(corpo.x - saída.x, corpo.y - saída.y));
        if ((beira - (medida.noX ? corpo.x : corpo.y)) * medida.rumo - corpo.meio < -0.02) cruzou = f;
      }
      check(cruzou >= 0, `aberto o verde, o ônibus segurado a ${medida.folgaDoLíder.toFixed(2)} `
        + `tiles da boca não entrou no cruzamento em 10 s (andou ${andou.toFixed(2)} tiles, `
        + `marcha ${rede.marchaAnunciada(medida.líder).toFixed(2)}, atraso `
        + `${rede.units[medida.líder].atraso.toFixed(1)}s)`);
      console.log(`semáforo seed ${seed}: ${controlados.length} caixa(s) com luz · `
        + `${candidatos.length} boca(s) vermelha(s) com rota · medida a ${posto.id}(${posto.x},`
        + `${posto.y}) eixo ${medida.noX ? 'x' : 'y'}: ${medida.chegadas} chegada(s) no vermelho, `
        + `${medida.sóLuz} quadro(s) em que a única parede era a luz (${medida.plantado} com o pé `
        + `no chão), folga mais apertada ${medida.folgaMínima.toFixed(2)} tiles antes da boca, `
        + `${medida.invasões} invasão(ões), ${medida.pediuVez ? 'o eixo do y pediu a vez' : `eixo do x (${medida.posto.demandY})`}, `
        + `${medida.verdes} amostra(s) de eixo verde passando, ${medida.dentroDaBoca} dentro da caixa, `
        + `${medida.diagonais} curva(s) fora do eixo · verde aberto: o líder entrou no quadro ${cruzou} `
        + `(${(cruzou / 60).toFixed(1)}s)`);
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
for (const r of rotasDistintas) {
  console.log(`rotas seed ${r.seed}: ${r.dividem} par(es) dividem asfalto no mesmo sentido, `
    + `a pior sobreposição é ${r.pior}% do trajeto · corredor mais disputado tem ${r.cargaMax} linha(s)`);
}
for (const p of portas) {
  console.log(`porta seed ${p.seed}: calçada mais longe a ${p.d} tiles do ônibus parado `
    + `("${p.nome}") · a porta alcança ${BOARDING_DOOR} · o marco mais longe da esquina a ${p.canto} `
    + `(passeio aceito até ${BOARDING_REACH}) · ${p.encostos} encostos, ${p.viradores} deles no `
    + 'virador de terminal, nenhum na caixa e nenhum na zebra');
}
for (const h of calçadas) {
  console.log(`rodoviária seed ${h.seed}: porta do hall mais longe a ${h.d} tiles do embarque `
    + `("${h.nome}") · ${h.linhas} linha(s) no telão`);
}
for (const p of plataformasMedidas) {
  console.log(`plataformas seed ${p.seed}: ${p.nome} tem ${p.baias} baia(s) para ${p.linhas} `
    + `linha(s) do pátio · ${p.descreve}`);
}
for (const f of frotaMedidas) {
  console.log(`frota seed ${f.seed}: ${f.frota} ônibus com ${f.unicas} matrícula(s) única(s) · `
    + `${f.viações} · as três primeiras placas: ${f.primeiras}`);
}
for (const v of viagens) {
  console.log(`viagem seed ${v.seed}: ${v.linhas} partidas no telão · ${v.pe} tiles a pé até a `
    + `${v.baia} · ${v.espera}s de espera · ${v.passeio}s de passeio · ${v.total}s no total até `
    + `"${v.destino}" · o plano moveu o jogador ${v.moveu} vez(es)`);
}
if (failures.length) {
  for (const f of failures) console.error(`FALHA: ${f}`);
  console.error(`Transporte: ${passed} passaram, ${failures.length} falharam`);
  process.exit(1);
}
console.log(`Transporte: ${passed} passaram, 0 falharam`);
