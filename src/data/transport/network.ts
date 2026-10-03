import { mulberry32 } from '../maps/city';
import type { RoadRank } from '../maps/city';
import type {
  RoadGraph,
  StationGrid,
  TransportEdge,
  TransportNetwork,
  TransportNode,
  TransportRoad,
  TransportRoute,
  TransportService,
  TransportStation,
  TransportStop,
} from './types';

/**
 * Família de via para o rótulo: `street` e `residential` são as duas ruas do mesmo desenho
 * — corredor de quadra, uma faixa para cada lado — e quem lê a placa quer saber o número da
 * rua, não em qual zona ela caiu. O posto real continua no tile e na areta.
 */
const FAMILIA: Record<RoadRank, string> = {
  highway: 'Rodovia', avenue: 'Avenida', street: 'Rua', residential: 'Rua', access: 'Acesso',
};

/**
 * Custo de um tile de faixa no Dijkstra de rota, em peso do posto. O ônibus é transporte
 * de bairro: a faixa local vale mais barato que a avenida justamente para a linha entrar no
 * corredor da quadra em vez de colar no fluxo rápido. A rodovia custa seis vezes o tile:
 * ela não é um desvio, é o último recurso — ver `cheapChain`.
 */
const CUSTO: Record<RoadRank, number> = {
  residential: 0.7, street: 0.55, avenue: 1, access: 1.4, highway: 6,
};

/** O que um tile de via pode custar no pior caso; corta o laço do Dijkstra por antecipação. */
const MAX_TILES = 240;

/** Os serviços que operam hoje. Uma linha nova entra aqui, com o seu ritmo próprio. */
export const TRANSPORT_SERVICES: Omit<TransportService, 'id' | 'routes'>[] = [
  {
    modality: 'bus', label: 'Ônibus urbano',
    // Medido na malha do mapa, não no gosto (régua: `check-transport.cjs`, seção 9).
    //
    // Cruzeiro 3,5: uma parada a cada 14,1 tiles de asfalto, então o que come o tempo do
    // ônibus é a calçada, não o motor. A porta agora tem que ser janela de verdade, porque o
    // §3b é embarcar: um segundo com o botão no ar não é tempo de um pedestre decidir, e o
    // polling da HUD é de 220 ms. Dois segundos custam 0,076 s por tile (0,362 → 0,438) e
    // deixam o ônibus ainda 19% mais barato que o pé no mesmo asfalto (0,541).
    //
    // O intervalo caiu de 24 para 18 s para pagar a janela: o que a travessia mais longa do
    // mapa tem de espera são duas transbordos, e com 24 s a régua fechava em 270 s contra
    // 271 s do mesmo caminho a pé — vantagem de um segundo não é transporte. Com 18 s fecha
    // em 243 s, e o preço é a frota: 157 → 205 veículos na malha, 43 → 55 materializados em
    // volta de uma câmera sobre a linha.
    speed: 3.5, headway: 18, dwell: 2,
  },
];

/** Raio em que um tile do passeio é aceito como a calçada daquela caixa. */
const CALCADA_MAX = 2.2;

/**
 * Alcance da porta de um veículo do horário, em tiles. Não é o `VEHICLE_ENTER_RANGE` do
 * carro: quem estaciona na caixa 2x2 de um cruzamento tem a porta do outro lado do asfalto,
 * e a malha aceita passeio até `CALCADA_MAX` tiles do centro daquela caixa — medido na
 * cidade inteira, o canto diagonal de uma esquina cai a 2,12 tiles do ônibus parado, e o
 * alcance do carro (1,55) deixaria o ponto de ônibus sem porta em pé. Os dois números têm de
 * falar um com o outro, senão a parada existe no mapa e não existe no jogo: é por isso que o
 * raio é derivado do `CALCADA_MAX`, com dois decímetros de margem para quem espera no marco.
 * O `toFixed` do valor não é enfeite: 2,2 + 0,2 é 2,4000000000000004 em binário, e é esse
 * número que a régua da porta e o check mostram.
 */
export const BOARDING_REACH = +(CALCADA_MAX + 0.2).toFixed(2);

/**
 * Uma linha para cada tantas paradas: mantém a malha densa sem virar metrô de tudo. O
 * número é de medida, não de gosto — com 20 por linha sobravam bolsões a 46 tiles de
 * qualquer calçada servida, e 16 fecha o território inteiro dentro de duas quadras.
 */
const STATIONS_PER_LINE = 16;
const MIN_LINES = 8;
const MAX_LINES = 20;
/** Âncoras mais próximas que isto entre si não viram linha: seria a mesma rua duas vezes. */
const MIN_ANCHOR_GAP = 26;
/** Os postos que têm de acabar servidos por linha. Rodovia e acesso não param ninguém. */
const COBERTURA: RoadRank[] = ['avenue', 'street', 'residential'];
/**
 * Raio de cobertura em tiles: uma quadra e meia de calçada até a parada com ônibus. É o que
 * a passada de território persegue, e o check cobra mais largo (duas quadras) para o dia em
 * que o gerador mover uma esquina.
 */
const ALCOBERTURA = 26;

interface RawRun {
  from: number;
  to: number;
  rank: RoadRank;
  axis: 'x' | 'y';
  at: number;
  path: number[];
}

/**
 * Deriva a malha de transporte do mapa. A ordem é sempre a mesma para o mesmo mapa: as
 * coleções vêm de chaves ordenadas, e só a escolha das âncoras de linha usa a semente. É
 * assim que `seed 42` tem de devolver a mesma cidade no check e no jogo.
 */
export function buildTransportNetwork(graph: RoadGraph, seed: number): TransportNetwork {
  const W = graph.data.tilesW;
  const H = graph.data.tilesH;
  const tiles = graph.data.tiles;
  const tileIndex = (tx: number, ty: number) => ty * W + tx;

  const nodeOf = new Int32Array(W * H).fill(-1);
  for (let i = 0; i < graph.roadNodeTiles.length; i++) {
    const n = graph.roadNodeTiles[i];
    nodeOf[tileIndex(n.tx, n.ty)] = i;
  }

  // 1) Caixas de cruzamento: região 4-conexa de via sem faixa. No gerador toda caixa é 2×2,
  //    e é o centro dela (o canto compartilhado pelos quatro tiles) que vira nó.
  const boxOf = new Int32Array(W * H).fill(-1);
  const nodes: TransportNode[] = [];
  for (let ty = 0; ty < H; ty++) {
    for (let tx = 0; tx < W; tx++) {
      const i = tileIndex(tx, ty);
      const t = tiles[i];
      if (t.kind !== 'road' || t.lane || boxOf[i] >= 0) continue;
      const stack = [i];
      const region: number[] = [];
      boxOf[i] = nodes.length;
      let x0 = tx, y0 = ty, x1 = tx, y1 = ty;
      while (stack.length) {
        const c = stack.pop()!;
        region.push(c);
        const cx = c % W, cy = Math.floor(c / W);
        x0 = Math.min(x0, cx); y0 = Math.min(y0, cy);
        x1 = Math.max(x1, cx); y1 = Math.max(y1, cy);
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = cx + dx, ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const j = tileIndex(nx, ny);
          const s = tiles[j];
          if (s.kind !== 'road' || s.lane || boxOf[j] >= 0) continue;
          boxOf[j] = nodes.length;
          stack.push(j);
        }
      }
      // Uma caixa que não fecha 2×2 não é um cruzamento deste mapa; ela fica de fora em vez
      // de inventar um nó torto no meio de uma faixa.
      if (region.length !== 4 || x1 - x0 !== 1 || y1 - y0 !== 1) continue;
      nodes.push({ id: nodes.length, x: x0 + 1, y: y0 + 1, tx: x0, ty: y0, roads: [], curbed: false });
    }
  }

  // 2) Faixas entre caixas: a mesma caminhada que o trânsito do jogo faz, só que resumida.
  //    Toda faixa do mapa sai por uma única aresta direcionada, então o laço termina na
  //    próxima caixa — e o posto é constante no caminho (medido no gerador).
  const runs: RawRun[] = [];
  for (const node of nodes) {
    for (let dy = 0; dy < 2; dy++) {
      for (let dx = 0; dx < 2; dx++) {
        const start = nodeOf[tileIndex(node.tx + dx, node.ty + dy)];
        if (start < 0) continue;
        for (const next of graph.roadOut[start]) {
          const nt = graph.roadNodeTiles[next];
          const ni = tileIndex(nt.tx, nt.ty);
          if (boxOf[ni] >= 0) continue;
          const first = tiles[ni];
          if (!first.lane || !first.rank) continue;
          const path = [start, next];
          let cur = next;
          for (let guard = 0; guard < MAX_TILES; guard++) {
            const out = graph.roadOut[cur];
            if (out.length !== 1) break;
            cur = out[0];
            const ct = graph.roadNodeTiles[cur];
            const ci = tileIndex(ct.tx, ct.ty);
            if (boxOf[ci] >= 0) {
              // Uma faixa que devolvesse o carro à caixa de onde saiu não é um corredor de
              // ônibus: é um laço, e o gerador não produz nenhum.
              if (boxOf[ci] === node.id) break;
              path.push(cur);
              const axis: 'x' | 'y' = first.lane === 'SE' || first.lane === 'NW' ? 'x' : 'y';
              runs.push({
                from: node.id, to: boxOf[ci], rank: first.rank, path,
                axis, at: axis === 'x' ? nt.ty : nt.tx,
              });
              break;
            }
            path.push(cur);
          }
        }
      }
    }
  }

  // 3) Corredores e vias: uma faixa é um corredor (posto + eixo + coordenada); as duas
  //    faixas vizinhas de um mesmo sentido oposto são a mesma via. Ordenado por chave para
  //    o rótulo sair sempre igual, sem depender da ordem de varredura.
  const corredor = new Map<string, number>();
  for (const r of runs) {
    const k = `${r.rank}|${r.axis}|${r.at}`;
    if (!corredor.has(k)) corredor.set(k, corredor.size);
  }
  const chaves = [...corredor.keys()].sort((a, b) => a.localeCompare(b));
  const roads: TransportRoad[] = [];
  const roadOfCorredor = new Map<string, number>();
  const ordinals = new Map<string, number>();
  for (let i = 0; i < chaves.length; i++) {
    const [rank, axis, atText] = chaves[i].split('|');
    const at = Number(atText);
    const anterior = i > 0 ? chaves[i - 1].split('|') : null;
    const mesmaVia = !!anterior
      && anterior[0] === rank && anterior[1] === axis && at - Number(anterior[2]) === 1;
    if (mesmaVia) {
      roadOfCorredor.set(chaves[i], roadOfCorredor.get(anterior!.join('|'))!);
      continue;
    }
    const familia = FAMILIA[rank as RoadRank];
    const grupo = `${familia}|${axis}`;
    const n = (ordinals.get(grupo) ?? 0) + 1;
    ordinals.set(grupo, n);
    const id = roads.length;
    roads.push({ id, rank: rank as RoadRank, axis: axis as 'x' | 'y', at, label: `${familia} ${n}` });
    roadOfCorredor.set(chaves[i], id);
  }

  const edges: TransportEdge[] = [];
  const out: number[][] = nodes.map(() => []);
  const nodeRoads = nodes.map(() => new Set<number>());
  for (const r of runs) {
    const road = roadOfCorredor.get(`${r.rank}|${r.axis}|${r.at}`)!;
    const id = edges.length;
    edges.push({ id, from: r.from, to: r.to, rank: r.rank, road, length: r.path.length - 1, path: r.path });
    out[r.from].push(id);
    nodeRoads[r.from].add(road);
    nodeRoads[r.to].add(road);
  }
  for (const node of nodes) {
    node.roads = [...nodeRoads[node.id]].sort((a, b) => a - b);
  }

  // 4) Calçada: o passeio que manda é o grafo pedonal do mapa, não o tile de concreto — lote
  //    também é concreto, e ônibus não para dentro do lote.
  const passeio = new Int32Array(W * H).fill(-1);
  for (let i = 0; i < graph.sidewalkNodes.length; i++) {
    const s = graph.sidewalkNodes[i];
    const j = tileIndex(Math.floor(s.x), Math.floor(s.y));
    if (passeio[j] < 0) passeio[j] = i;
  }
  const stations: TransportStation[] = [];
  const stationOf = nodes.map(() => -1);
  for (const node of nodes) {
    // Rodovia não tem parada: é a espinha de ponta a ponta, e o gerador não põe passeio
    // encostado nela à toa — a regra é do mapa, não de gosto.
    const serviveis = node.roads.filter((r) => roads[r].rank !== 'highway');
    if (!node.roads.length || !serviveis.length) continue;
    const curb = nearestPasseio(passeio, W, H, node, graph);
    if (!curb) continue;
    node.curbed = true;
    const nome = serviveis
      .slice(0, 2)
      .map((r) => roads[r].label)
      .join(' · ');
    const id = stations.length;
    stations.push({
      id, node: node.id, x: curb.x, y: curb.y, name: nome,
      rank: roads[serviveis[0]].rank, road: serviveis[0], lines: [],
    });
    stationOf[node.id] = id;
  }

  const stopsAt = stations.map(() => [] as number[]);
  const routes: TransportRoute[] = [];
  const services: TransportService[] = TRANSPORT_SERVICES.map((s, i) => ({
    ...s, id: i, routes: [],
  }));

  /** Publica a linha na malha: o id dela é a posição na lista, e as calçadas recebem a rota. */
  const publica = (route: TransportRoute) => {
    routes.push(route);
    services[route.service].routes.push(route.id);
    for (const stop of route.stops) {
      stations[stop.station].lines.push(route.id);
      stopsAt[stop.station].push(route.id);
    }
  };
  const entre = (de: number, ate: number) => makeRoute(
    graph, nodes, edges, out, stations, stationOf, de, ate, routes.length, services[0],
  );

  // 5) Linhas: âncoras espalhadas pelo mapa (a mais distante de cada vez) ligadas pelo
  //    caminho dirigido mais barato. O custo por posto é o que faz a linha descer para a
  //    rua local em vez de colar na avenida.
  const rng = mulberry32(seed ^ 0x7472616e);
  const anchors = pickAnchors(stations, rng);
  for (let i = 0; i + 1 < anchors.length; i++) {
    const route = entre(anchors[i], anchors[i + 1]);
    if (route) publica(route);
  }

  // 6) Cobertura por posto: toda família de via que aceita parada tem de ter uma linha. A
  //    varredura por âncoras desenha o caminho mais curto entre dois pontos espalhados, e
  //    nada garante que um deles caia no corredor do miolo — a rua local existiria no mapa
  //    sem ônibus nenhum, que é justamente o buraco que a fase 1 precisa fechar. Aqui a
  //    linha não é escolhida entre dois pontos: ela é o corredor inteiro, da primeira caixa
  //    até a última.
  const postos = new Set<RoadRank>();
  for (const r of routes) for (const rank of r.ranks) postos.add(rank);
  for (const rank of COBERTURA) {
    if (postos.has(rank)) continue;
    for (const road of corredoresMaisLongos(edges, rank)) {
      const fim = extremosDaVia(road, roads, nodes, edges, stationOf);
      if (!fim) continue;
      const route = entre(fim[0], fim[1]);
      if (!route) continue;
      publica(route);
      postos.add(rank);
      break;
    }
  }

  // 7) Cobertura do território: enquanto houver calçada longe demais de qualquer linha, a
  //    linha que falta é o corredor que passa por ela. As âncoras desenham o trajeto mais
  //    curto entre dois pontos espalhados e concentram o serviço nas avenidas do miolo; sem
  //    esta passada a perna do mapa tem rua, tem parada e não tem ônibus.
  const balde = stationGrid(stations, graph);
  for (let rodada = 0; routes.length < MAX_LINES && rodada < MAX_LINES; rodada++) {
    const buraco = buracoDeCobertura(nodes, stations, balde);
    if (!buraco || buraco.dist <= ALCOBERTURA) break;
    const caixa = nodes[buraco.node];
    // A via mais local primeiro: é o bairro que está ilhado, e um corredor de avenida já
    // passou por perto sem parar.
    const candidatas = [...caixa.roads].sort((a, b) =>
      (CUSTO[roads[a].rank] - CUSTO[roads[b].rank]) || (a - b));
    let fechou = false;
    for (const road of candidatas) {
      if (roads[road].rank === 'highway') continue;
      const fim = extremosDaVia(road, roads, nodes, edges, stationOf);
      if (!fim) continue;
      const route = entre(fim[0], fim[1]);
      // Corredor que não acrescenta calçada nova é o mesmo ônibus em outra roupa.
      if (!route || route.stops.filter((s) => !stations[s.station].lines.length).length < 4) continue;
      publica(route);
      fechou = true;
      break;
    }
    if (!fechou) break;
  }

  return {
    roads, nodes, edges, stations, routes, services, out, stationOf, stopsAt,
    grid: balde,
  };
}

/**
 * O buraco de cobertura: a caixa com calçada mais longe de uma parada servida, com a
 * distância. Varredura pelo balde de chunks, então o custo é o dos baldes vizinhos, não o
 * do mapa inteiro — é chamada uma vez por linha extra, nunca por frame.
 */
function buracoDeCobertura(
  nodes: TransportNode[],
  stations: TransportStation[],
  balde: StationGrid,
): { node: number; dist: number } | null {
  let pior = -1;
  let distancia = -1;
  for (const n of nodes) {
    if (!n.curbed) continue;
    let best = Infinity;
    const cx = Math.floor(n.x / balde.cell);
    const cy = Math.floor(n.y / balde.cell);
    for (let gy = Math.max(0, cy - 4); gy <= Math.min(balde.rows - 1, cy + 4); gy++) {
      for (let gx = Math.max(0, cx - 4); gx <= Math.min(balde.cols - 1, cx + 4); gx++) {
        for (let i = balde.head[gy * balde.cols + gx]; i >= 0; i = balde.next[i]) {
          if (!stations[i].lines.length) continue;
          const d = Math.hypot(stations[i].x - n.x, stations[i].y - n.y);
          if (d < best) best = d;
        }
      }
    }
    // Fora do alcance do balde é o mesmo buraco, mais fundo.
    if (!Number.isFinite(best)) best = balde.cell * 8;
    if (best > distancia) { distancia = best; pior = n.id; }
  }
  return pior < 0 ? null : { node: pior, dist: distancia };
}

/**
 * Vias de um posto, da mais comprida para a mais curta. O desempate é o id, para a escolha
 * não depender de em que ordem o Dijkstra percorreu o mapa.
 */
function corredoresMaisLongos(edges: TransportEdge[], rank: RoadRank): number[] {
  const soma = new Map<number, number>();
  for (const e of edges) {
    if (e.rank !== rank) continue;
    soma.set(e.road, (soma.get(e.road) ?? 0) + e.length);
  }
  return [...soma.entries()].sort((a, b) => (b[1] - a[1]) || (a[0] - b[0])).map(([road]) => road);
}

/**
 * As duas paradas das pontas de uma via. Uma caixa sem calçada não embarca ninguém, então a
 * ponta é a primeira e a última caixa do corredor que têm parada, não a primeira e a última
 * que existem. A ordenação é pelo eixo da via: as duas faixas de mão ficam em colunas
 * vizinhas numa vertical, e ordenar por X colocaria uma ao lado da outra em vez de ponta a
 * ponta.
 */
function extremosDaVia(
  road: number,
  roads: TransportRoad[],
  nodes: TransportNode[],
  edges: TransportEdge[],
  stationOf: number[],
): [number, number] | null {
  const caixas = new Set<number>();
  for (const e of edges) {
    if (e.road !== road) continue;
    caixas.add(e.from);
    caixas.add(e.to);
  }
  const naFaixa = roads[road].axis === 'x';
  const ordem = [...caixas].sort((a, b) => {
    const ao = nodes[a], bo = nodes[b];
    return naFaixa
      ? ((ao.x - bo.x) || (ao.y - bo.y))
      : ((ao.y - bo.y) || (ao.x - bo.x));
  });
  const comParada = ordem.filter((id) => stationOf[id] >= 0);
  if (comParada.length < 2) return null;
  return [stationOf[comParada[0]], stationOf[comParada[comParada.length - 1]]];
}

/** O tile de passeio mais próximo da caixa, dentro de `CALCADA_MAX` tiles do centro dela. */
function nearestPasseio(
  passeio: Int32Array, W: number, H: number, node: TransportNode, graph: RoadGraph,
): { x: number; y: number } | null {
  let found: { x: number; y: number } | null = null;
  let best = CALCADA_MAX;
  const reach = Math.ceil(CALCADA_MAX) + 1;
  for (let dy = -reach; dy <= reach; dy++) {
    for (let dx = -reach; dx <= reach; dx++) {
      const tx = node.tx + dx, ty = node.ty + dy;
      if (tx < 0 || ty < 0 || tx >= W || ty >= H) continue;
      if (passeio[ty * W + tx] < 0) continue;
      const s = graph.sidewalkNodes[passeio[ty * W + tx]];
      const d = Math.hypot(s.x - node.x, s.y - node.y);
      // Empate de distância se resolve pelo canto noroeste: é o que mantém a parada no mesmo
      // lado da rua quando o mapa é reamarrado com outra semente.
      if (d < best - 1e-9 || (Math.abs(d - best) < 1e-9 && found && ty * W + tx < keyOf(found, W))) {
        best = d;
        found = { x: s.x, y: s.y };
      }
    }
  }
  return found;
}

function keyOf(p: { x: number; y: number }, W: number): number {
  return Math.floor(p.y) * W + Math.floor(p.x);
}

/** Amostragem do mais-distante: a primeira âncora é sorteada entre as paradas maiores. */
function pickAnchors(stations: TransportStation[], rng: () => number): number[] {
  if (stations.length < MIN_LINES * 2) return [];
  const alvo = Math.max(MIN_LINES, Math.min(MAX_LINES, Math.round(stations.length / STATIONS_PER_LINE)));
  const start = Math.floor(rng() * stations.length);
  const chosen = [start];
  const minGap = new Float64Array(stations.length).fill(Infinity);
  while (chosen.length < alvo) {
    const last = stations[chosen[chosen.length - 1]];
    for (let i = 0; i < stations.length; i++) {
      const d = Math.hypot(stations[i].x - last.x, stations[i].y - last.y);
      if (d < minGap[i]) minGap[i] = d;
    }
    let best = -1, bestGap = MIN_ANCHOR_GAP;
    for (let i = 0; i < stations.length; i++) {
      if (minGap[i] > bestGap) { bestGap = minGap[i]; best = i; }
    }
    if (best < 0) break;
    chosen.push(best);
  }
  return chosen;
}

/**
 * Caminho dirigido mais barato entre duas caixas. `pelaEspinha` libera a rodovia: a malha
 * de avenidas para nas margens e só as colunas com ponte atravessam o rio, então uma linha
 * proibida de usar a espinha nunca chega à outra banda — e o custo 6 por tile é o que faz
 * ela só aparecer quando não existe caminho sem ela. O trabalho é do construtor de mapa,
 * uma vez por mundo, sobre ~270 nós.
 */
function cheapChain(
  nodes: TransportNode[],
  out: number[][],
  edges: TransportEdge[],
  from: number,
  to: number,
  pelaEspinha: boolean,
): number[] | null {
  const dist = new Float64Array(nodes.length).fill(Infinity);
  const prevEdge = new Int32Array(nodes.length).fill(-1);
  const done = new Uint8Array(nodes.length);
  dist[from] = 0;
  for (;;) {
    let cur = -1, best = Infinity;
    for (let i = 0; i < nodes.length; i++) {
      if (!done[i] && dist[i] < best) { best = dist[i]; cur = i; }
    }
    if (cur < 0) break;
    done[cur] = 1;
    if (cur === to) break;
    for (const id of out[cur]) {
      const e = edges[id];
      // Acesso fica fora das duas passadas: é o pátio de uma instalação, não rua de ônibus.
      if (e.rank === 'access' || (!pelaEspinha && e.rank === 'highway')) continue;
      const cost = e.length * CUSTO[e.rank];
      if (dist[cur] + cost < dist[e.to]) {
        dist[e.to] = dist[cur] + cost;
        prevEdge[e.to] = id;
      }
    }
  }
  if (!Number.isFinite(dist[to])) return null;
  const chain: number[] = [];
  for (let cur = to; cur !== from; ) {
    const id = prevEdge[cur];
    if (id < 0) return null;
    chain.unshift(id);
    cur = edges[id].from;
  }
  return chain.length < 2 ? null : chain;
}

/**
 * Linha entre duas paradas: o caminho mais barato, a polilinha do asfalto e o horário de
 * ida e volta. Devolve nulo quando não há caminho ou quando o caminho não tem onde parar —
 * uma linha sem três calçadas não é uma linha, é um carro passando.
 */
function makeRoute(
  graph: RoadGraph,
  nodes: TransportNode[],
  edges: TransportEdge[],
  out: number[][],
  stations: TransportStation[],
  stationOf: number[],
  fromStation: number,
  toStation: number,
  line: number,
  service: TransportService,
): TransportRoute | null {
  const from = stations[fromStation].node;
  const to = stations[toStation].node;
  if (from === to) return null;
  const chain = cheapChain(nodes, out, edges, from, to, false)
    ?? cheapChain(nodes, out, edges, from, to, true);
  if (!chain) return null;

  // Polilinha: o centro da caixa, os tiles da faixa, a próxima caixa. Os tiles de caixa que
  // aparecem dentro do caminho são só o pé da aresta anterior e o da seguinte.
  const points: { x: number; y: number }[] = [];
  const cum: number[] = [];
  const nodePoint = new Map<number, number>();
  const push = (x: number, y: number, node?: number) => {
    const last = points[points.length - 1];
    if (last && Math.abs(last.x - x) < 1e-6 && Math.abs(last.y - y) < 1e-6) {
      if (node !== undefined) nodePoint.set(node, points.length - 1);
      return;
    }
    cum.push(last ? cum[cum.length - 1] + Math.hypot(x - last.x, y - last.y) : 0);
    points.push({ x, y });
    if (node !== undefined) nodePoint.set(node, points.length - 1);
  };
  push(nodes[from].x, nodes[from].y, from);
  for (const id of chain) {
    const e = edges[id];
    for (let i = 1; i < e.path.length - 1; i++) {
      const t = graph.roadNodeTiles[e.path[i]];
      push(t.tx + 0.5, t.ty + 0.5);
    }
    push(nodes[e.to].x, nodes[e.to].y, e.to);
  }
  if (points.length < 2) return null;

  const stops: TransportStop[] = [];
  for (const id of [from, ...chain.map((e) => edges[e].to)]) {
    const station = stationOf[id];
    if (station < 0) continue;
    const at = nodePoint.get(id);
    if (at === undefined) continue;
    const last = stops[stops.length - 1];
    if (last && last.station === station) continue;
    stops.push({ station, at: cum[at] });
  }
  if (stops.length < 3) return null;
  const length = cum[cum.length - 1];

  // Horário: ida parada por parada, volta pelo mesmo caminho. A travessia é o tempo de
  // cruzeiro; a parada some do relógio como `dwell` em cada calçada. A tabela é simétrica:
  // o índice `i` é a passada de ida e `2S-1-i` é a mesma parada na volta, e é assim que o
  // schedule lê uma chegada sem precisar de um campo a mais em cada linha.
  const table: { dist: number; time: number }[] = [];
  for (let i = 0; i < stops.length; i++) {
    table.push({ dist: stops[i].at, time: stops[i].at / service.speed + i * service.dwell });
  }
  const turnAt = table[table.length - 1].time + service.dwell;
  for (let i = stops.length - 1; i >= 0; i--) {
    table.push({
      dist: stops[i].at,
      time: turnAt + (length - stops[i].at) / service.speed + (stops.length - 1 - i) * service.dwell,
    });
  }
  const cycle = table[table.length - 1].time + service.dwell;
  const ranks = new Set<RoadRank>();
  for (const id of chain) ranks.add(edges[id].rank);

  return {
    id: line, name: `Linha ${line + 1}`, modality: service.modality, service: service.id,
    edges: chain, stops, ranks: [...ranks].sort((a, b) => (CUSTO[a] - CUSTO[b]) || a.localeCompare(b)),
    points, cum, length, cycle, turnAt, table,
    units: Math.max(1, Math.ceil(cycle / service.headway)),
  };
}

/** Baldes do tamanho de um chunk para `stopsNear`, montados uma vez e nunca recriados. */
function stationGrid(stations: TransportStation[], graph: RoadGraph): StationGrid {
  const cell = 16;
  const cols = Math.max(1, Math.ceil(graph.data.tilesW / cell));
  const rows = Math.max(1, Math.ceil(graph.data.tilesH / cell));
  const head = new Int32Array(cols * rows).fill(-1);
  const next = new Int32Array(stations.length).fill(-1);
  for (let i = stations.length - 1; i >= 0; i--) {
    const cx = Math.min(cols - 1, Math.max(0, Math.floor(stations[i].x / cell)));
    const cy = Math.min(rows - 1, Math.max(0, Math.floor(stations[i].y / cell)));
    next[i] = head[cy * cols + cx];
    head[cy * cols + cx] = i;
  }
  return { cell, cols, rows, head, next };
}
