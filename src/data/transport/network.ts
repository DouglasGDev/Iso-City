import { mulberry32 } from '../maps/city';
import type { MapTile, RoadRank } from '../maps/city';
import { VEHICLE_DEFS } from '../vehicles';
import { alongRoute } from './schedule';
import type {
  RoadGraph,
  StationGrid,
  TransportCompany,
  TransportEdge,
  TransportNetwork,
  TransportNode,
  TransportPlatform,
  TransportRoad,
  TransportRole,
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

/**
 * O preço de pôr mais uma linha num corredor que já tem outra andando nele, medido na VIA
 * inteira — não na faixa. Contar por faixa foi o que deixou as onze linhas do mesmo mapa
 * atravessarem a mesma "Rodovia 2" e as dez correrem pela mesma "Avenida 1": cada linha tocava
 * um trecho diferente da mesma avenida, nenhuma faixa passava de cinco usos, e o corredor
 * voltava a ficar de graça justamente para quem chegasse depois. Na rua o jogador não vê
 * "faixa", vê a avenida cheia de ônibus iguais.
 *
 * O peso é maior que o custo do asfalto livre (avenida vale 1 por tile): com uma linha a mais
 * na via, ela já custa mais que o dobro, e a próxima procura a paralela. É a mesma razão que
 * faz a cidade real dividir as linhas entre as avenidas paralelas.
 */
const PESO_DO_CORREDOR = 1.15;
/**
 * O preço extra da MESMA faixa — o tile exato por onde a lataria passa. É o que separa duas
 * linhas que dividem a avenida em pontas diferentes (barato) de duas que correm atrás uma da
 * outra no mesmo trecho (caro), e é por isso que ele continua por aresta.
 */
const PESO_DA_FAIXA = 0.6;
/**
 * Onde as contas param de crescer. O teto existe para a última linha da cidade ainda achar
 * caminho: sem ele, com vinte linhas sobre trinta e tantas vias, o custo de um corredor
 * esgotado passaria do custo de atravessar o mapa por dentro da rodovia, e a malha começaria
 * a perder linhas por falta de rota. É alto de propósito — a via só para de ser evitada depois
 * de oito linhas, o que já é o dobro do que qualquer corredor devia ter.
 */
const TETO_DO_CORREDOR = 8;
const TETO_DA_FAIXA = 4;

/**
 * A partir de que fração das vias de uma linha já publicada a nova linha é considerada a mesma
 * rota. O denominador é o menor dos dois conjuntos de propósito: uma perna curta que cabe
 * inteira dentro de uma troncal é o caso que o jogador aponta — "os dois ônibus fazem a mesma
 * rota" — mesmo quando a troncal, mais comprida, tem corredor sobrando para si.
 */
const LIMIAR_DA_DUPLICA = 0.5;

/** O que um tile de via pode custar no pior caso; corta o laço do Dijkstra por antecipação. */
const MAX_TILES = 240;

/**
 * A placa da caixa que mora dentro da quadra exclusiva. Não é "Acesso 3": quem olha o painel
 * do hall ou o radar quer saber que ali é a rodoviária, e é por este nome que o jogador
 * reconhece o terminal numa cidade de duzentas esquinas com nome.
 */
const NOME_DO_TERMINAL = 'Rodoviária';

/**
 * Quantas linhas morrem dentro do pátio. Duas é o mínimo que faz um terminal de verdade: uma
 * linha só seria um ponto de ônibus cercado, e o embarque precisa de escolha de lado — a
 * plataforma oeste atende quem chega do norte da cidade, a leste quem chega do sul. Mais que
 * três, o pátio de dez tiles vira fila e o congestionamento volta por dentro da quadra.
 */
const LINHAS_DO_TERMINAL = 2;

/**
 * A caixa de manobra é do terminal quando os quatro tiles dela são o asfalto carimbado do
 * pátio. É a única forma de a malha saber que aquela caixa não é uma esquina: o posto `access`
 * diz de quem é o asfalto, e o carimbo diz onde a linha tem de terminar.
 */
function caixaDoTerminal(tiles: MapTile[], W: number, node: TransportNode): boolean {
  for (let dy = 0; dy < 2; dy++) {
    for (let dx = 0; dx < 2; dx++) {
      if (!tiles[(node.ty + dy) * W + node.tx + dx]?.terminal) return false;
    }
  }
  return true;
}

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

/**
 * O ritmo e a política de paradas de cada papel. Os números são de rede de transporte de
 * verdade, traduzidos para o relógio do jogo (um dia de 300 s, então um segundo de rua vale
 * ~4,8 minutos de calendário): a troncal da avenida passa a cada ~20 s porque é por ela que se
 * atravessa a cidade, a rua do bairro a cada ~45 s, e a linha de rodoviária a cada ~75 s, com
 * partidas anunciadas em hora.
 *
 * `teto` é o orçamento: `units = ciclo/intervalo` é a conta certa, mas uma linha que cruza o
 * mapa inteiro pediria 17 veículos para manter 20 s de intervalo, e vinte linhas assim são 213
 * ônibus na rua — a frota que a malha tinha e que o jogador vê em todo cruzamento. O teto
 * converte o pedido em realidade de viação: a linha comprida roda com o intervalo que a frota
 * dela paga, e é por isso que ela também para menos: `espaço` encurta o ciclo, o ciclo encurta
 * a frota e a viagem encurta junto. É a mesma alavanca que faz o expresso da vida real ganhar
 * da caminhada mesmo passando menos vezes.
 */
interface Papel {
  headway: number;
  teto: number;
  /** Tiles de asfalto entre duas paradas que esta linha atende. 0 é parar em toda calçada. */
  espaço: number;
  /** Ignora calçada de rua residencial: o expresso para onde se embarca de verdade. */
  sóPrincipais: boolean;
  /** Fração do ciclo passada estacionada no berço de origem, entre uma partida e outra. */
  descanso: number;
}

const PAPEIS: Record<TransportRole, Papel> = {
  troncal: { headway: 20, teto: 7, espaço: 12, sóPrincipais: true, descanso: 0 },
  arterial: { headway: 30, teto: 5, espaço: 8, sóPrincipais: false, descanso: 0 },
  local: { headway: 45, teto: 4, espaço: 0, sóPrincipais: false, descanso: 0 },
  rodoviaria: { headway: 75, teto: 4, espaço: 20, sóPrincipais: true, descanso: 0.3 },
};

/** O ângulo áureo do ciclo: espalha as linhas no tempo sem sorteio e sem depender da semente. */
const ÂNGULO_ÁUREO = 0.6180339887498949;

/**
 * As viações da cidade, e a lista de papéis que cada uma roda. É a última camada de leitura da
 * rua: dois ônibus da mesma troncal pintados iguais dizem ao jogador "estas linhas são do mesmo
 * tipo", e um local verde da municipal diz "este é o ônibus do bairro" antes de ele olhar a
 * placa. A viação não é sorteio — vem do papel da linha e da ordem dela na malha, então a mesma
 * semente pinta sempre a mesma cidade, e uma linha que muda de papel muda de cor com ele.
 */
interface Viação {
  name: string;
  code: string;
  livery: string;
  stripe: string;
  papeis: TransportRole[];
}

const VIAÇÕES: Viação[] = [
  { name: 'Auto Ônibus Cidade Nova', code: 'AOC', livery: '#d8b13f', stripe: '#6f5410', papeis: ['troncal', 'arterial'] },
  { name: 'Viação Aurora', code: 'AUR', livery: '#3f88b0', stripe: '#1d4c63', papeis: ['arterial', 'local'] },
  { name: 'Consórcio Planalto', code: 'CPL', livery: '#c2604a', stripe: '#6f2f21', papeis: ['troncal', 'local'] },
  { name: 'Empresa Municipal de Transportes', code: 'EMT', livery: '#5f9e6a', stripe: '#2f5c39', papeis: ['local', 'arterial'] },
  { name: 'Expresso Rodoviário', code: 'ERO', livery: '#8a6fb5', stripe: '#463563', papeis: ['rodoviaria'] },
  { name: 'Companhia Nacional de Viação', code: 'CNA', livery: '#4a8f8a', stripe: '#255150', papeis: ['rodoviaria'] },
];

/** As viações publicadas: o que `TransportRoute.company` indexa, sem a lista de papéis. */
const EMPRESAS: TransportCompany[] = VIAÇÕES.map((v, i) => ({
  id: i, name: v.name, code: v.code, livery: v.livery, stripe: v.stripe,
}));

/** A primeira matrícula da cidade: um zero à frente de um número de três dígitos é o que a
 *  garagem de verdade usa, e deixa folga para a frota crescer sem dividir o mesmo prefixo. */
const FROTA_INICIAL = 101;

/** O número de um veículo: a matrícula dele, única na malha inteira. */
export function fleetNumber(route: TransportRoute, unit: number): string {
  return String(route.fleet + unit).padStart(3, '0');
}

/** Prefixo pintado no teto e lido no telão: sigla da viação mais a matrícula. */
export function fleetLabel(route: TransportRoute, unit: number): string {
  return `${EMPRESAS[route.company].code}-${fleetNumber(route, unit)}`;
}

/** A viação de uma linha: roda o papel dela e é escolhida pela ordem da linha, para duas
 *  linhas vizinhas do mesmo papel nunca serem da mesma garagem. */
function viaDaLinha(papel: TransportRole, line: number): number {
  const candidatas: number[] = [];
  for (let i = 0; i < VIAÇÕES.length; i++) if (VIAÇÕES[i].papeis.includes(papel)) candidatas.push(i);
  return candidatas[mod(line, candidatas.length)];
}

const mod = (v: number, m: number) => ((v % m) + m) % m;

/** Raio em que um tile do passeio é aceito como a calçada daquela caixa. */
const CALCADA_MAX = 2.2;
/**
 * Alcance da porta de um veículo do horário, em tiles. Não é o `VEHICLE_ENTER_RANGE` do
 * carro: quem espera no ponto está do outro lado do asfalto, e a malha aceita passeio até
 * `CALCADA_MAX` tiles do centro da caixa do cruzamento — medido na cidade inteira, o canto
 * diagonal de uma esquina cai a 2,12 tiles do ônibus parado, e o alcance do carro (1,55)
 * deixaria o ponto de ônibus sem porta em pé. Os dois números têm de falar um com o outro,
 * senão a parada existe no mapa e não existe no jogo: é por isso que o raio é derivado do
 * `CALCADA_MAX`, com dois decímetros de margem para quem espera no marco. O `toFixed` do
 * valor não é enfeite: 2,2 + 0,2 é 2,4000000000000004 em binário, e é esse número que a
 * régua da porta e o check mostram. Não é o único teste de embarque — ver `BOARDING_DOOR`.
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

  // 3b) O par de cada faixa: a volta de uma linha corre na faixa gêmea do mesmo corredor. Nem
  //     toda mão tem a outra — um sentido morre num beco, o outro continua; uma alameda é de
  //     mão única. Uma linha sobre uma dessas seria o ônibus na contramão que o jogador vê
  //     passar por um carro parado, então a rota só pode percorrer via de mão dupla. Vale
  //     também para o `access` do pátio: as duas faixas da rodoviária são gêmeas uma da outra
  //     — a que desce e a que sobe — e sem elas nenhuma linha consegue entrar no terminal.
  const par = new Int32Array(edges.length).fill(-1);
  for (const e of edges) {
    const p = out[e.to].find((id) => {
      const t = edges[id];
      return t.to === e.from && t.road === e.road;
    });
    if (p !== undefined) par[e.id] = p;
  }
  const dual = nodes.map(() => [] as number[]);
  for (const e of edges) if (par[e.id] >= 0) dual[e.from].push(e.id);

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
    // A caixa dentro do asfalto carimbado da rodoviária não é uma esquina com marquise: é o
    // embarque dentro da quadra exclusiva, e a placa dela é o nome da instalação. É também o
    // ponto que a plataforma do hall e o check procuram, por isso a flag mora na parada e não
    // só no tile.
    const pátio = caixaDoTerminal(tiles, W, node);
    const nome = pátio ? NOME_DO_TERMINAL
      : serviveis
        .slice(0, 2)
        .map((r) => roads[r].label)
        .join(' · ');
    const id = stations.length;
    stations.push({
      id, node: node.id, x: curb.x, y: curb.y, name: nome,
      rank: roads[serviveis[0]].rank, road: serviveis[0], terminal: pátio, lines: [],
      ponto: zonaDoPonto(graph, passeio[tileIndex(Math.floor(curb.x), Math.floor(curb.y))],
        passeio, W, H),
    });
    stationOf[node.id] = id;
  }

  const stopsAt = stations.map(() => [] as number[]);
  const routes: TransportRoute[] = [];
  /**
   * A calçada vai sendo tomada na ordem em que as linhas nascem: é o que dá a cada uma o seu
   * berço, e a ordem é a mesma para a mesma semente, então o jogo e o check veem a mesma rua.
   */
  const docas: Doca = new Map();
  /**
   * Faixa → quantas linhas já correm nela. Entra no custo do Dijkstra (ver `PESO_DA_FAIXA`)
   * e cresce na mesma ordem em que as linhas são publicadas, então a malha continua sendo uma
   * função da semente: o quinto ônibus a chegar no mesmo corredor não é sorteio.
   */
  const uso: Map<number, number> = new Map();
  /**
   * Via → quantas linhas já a atravessaram, uma vez por linha não importa quantos trechos. É a
   * conta que o jogador faz olhando a avenida, e é ela que faz a linha seguinte procurar a
   * paralela vazia em vez de descer a mesma "Avenida 1" de ponta a ponta.
   */
  const usoDaVia: Map<number, number> = new Map();
  /**
   * As vias de cada linha publicada, na ordem das linhas. O contador acima diz quantas linhas
   * dividem um corredor; isto diz *quais*, e é a comparação entre duas rotas — não entre duas
   * somas — que decide se a linha nova é uma rota ou a mesma rota com outro nome.
   */
  const viasPorRota: Set<number>[] = [];
  const services: TransportService[] = TRANSPORT_SERVICES.map((s, i) => ({
    ...s, id: i, routes: [],
  }));

  // A garagem numera a frota na ordem em que as linhas nascem: o bloco de cada uma começa onde
  // o da anterior parou, então nenhum prefixo se repete na cidade inteira — nem entre duas
  // linhas, nem entre dois veículos da mesma. É por isso que a matrícula vive na linha e no
  // índice do horário, e nenhum corpo precisa guardar um número próprio.
  /** Publica a linha na malha: o id dela é a posição na lista, e as calçadas recebem a rota. */
  let frotaPublicada = 0;
  const publica = (route: TransportRoute) => {
    frotaPublicada += route.units;
    routes.push(route);
    services[route.service].routes.push(route.id);
    for (const stop of route.stops) {
      stations[stop.station].lines.push(route.id);
      stopsAt[stop.station].push(route.id);
    }
    // A ida e a volta correm em faixas diferentes da mesma rua, e as duas ficam disputadas.
    const vias = new Set<number>();
    for (const id of route.edges) {
      vias.add(edges[id].road);
      for (const faixa of [id, par[id]]) {
        if (faixa < 0) continue;
        uso.set(faixa, (uso.get(faixa) ?? 0) + 1);
      }
    }
    // Uma vez por via, não por trecho: a linha que corta a avenida de ponta a ponta e a que
    // encosta nela por duas caixas ocupam o mesmo corredor aos olhos de quem está na calçada.
    for (const via of vias) usoDaVia.set(via, (usoDaVia.get(via) ?? 0) + 1);
    viasPorRota.push(vias);
  };
  /**
   * Publica a linha, exceto quando ela é a cópia de outra. A interdição do corredor rival já
   * foi tentada dentro de `makeRoute`; se mesmo assim a candidata continua dentro do mesmo
   * corredor, ela só vale o asfalto dividido quando alcança calçadas que nenhum ônibus para
   * ainda — é isso que a faz uma rota e não um nome a mais. Sem calçada nova a linha não nasce
   * e o buraco fica para as passadas de cobertura, que o pagam correndo o corredor inteiro em
   * vez de repetir uma linha que já existe.
   */
  const publicaSeDistinta = (route: TransportRoute): boolean => {
    const vias = new Set(route.edges.map((id) => edges[id].road));
    if (rivalDeSobreposição(vias, viasPorRota).fração > LIMIAR_DA_DUPLICA) {
      if (route.stops.filter((s) => !stations[s.station].lines.length).length < 2) return false;
    }
    publica(route);
    return true;
  };
  const entre = (de: number, ate: number, via = -1, contraDuplicada = false) => makeRoute(
    graph, nodes, edges, dual, par, stations, stationOf, de, ate, routes.length,
    FROTA_INICIAL + frotaPublicada, services[0],
    docas, uso, usoDaVia, viasPorRota, contraDuplicada, via,
  );

  // 5) Linhas: âncoras espalhadas pelo mapa (a mais distante de cada vez) ligadas pelo
  //    caminho dirigido mais barato. O custo por posto é o que faz a linha descer para a
  //    rua local em vez de colar na avenida.
  const rng = mulberry32(seed ^ 0x7472616e);
  const anchors = pickAnchors(stations, rng);
  for (let i = 0; i + 1 < anchors.length; i++) {
    // Uma linha em três não é a corda reta entre as duas âncoras: ela passa pela âncora mais
    // perto do meio do caminho, que é como nasce uma transversal. Sem isto toda linha da
    // cidade é um radial ida-e-volta pela mesma avenida, e é isso que faz o jogador dizer que
    // "todos fazem a mesma rota" mesmo quando os trajetos, medidos, são diferentes.
    const a = stations[anchors[i]], b = stations[anchors[i + 1]];
    const meio = i % 3 === 1
      ? maisPertoDoMeio(anchors, stations, a, b, anchors[i], anchors[i + 1]) : -1;
    const route = entre(anchors[i], anchors[i + 1], meio, true);
    if (route) publicaSeDistinta(route);
  }

  // 5b) Terminal: nenhuma linha passa pela rodoviária de raspão — as duas que morrem dentro
  //     do pátio são publicadas aqui, do pátio para a perna mais distante do mapa. É esta
  //     passada que faz a quadra exclusiva existir no jogo: o Dijkstra vê a boca do pátio como
  //     um beco sem saída (entra-se por uma faixa e sai-se pela gêmea, e a saída só serve a
  //     quem tem o terminal como destino), então nenhum par de âncoras jamais o escolhe. Sem
  //     isto a quadra é asfalto carimbado, com plataforma, virador e baia que nenhum corpo
  //     do horário visita.
  //
  //     A origem é a estação mais longe do pátio, em ordem de distância e não por sorteio: a
  //     malha continua sendo função da semente, e a linha nasce comprida porque é assim que o
  //     ônibus atravessa a cidade de verdade. As origens se repelem por `MIN_ANCHOR_GAP` para
  //     as duas pernas chegarem por lados diferentes, que é o que dá uso às duas plataformas.
  //
  //     Vem antes da cobertura porque o orçamento é finito: `MAX_LINES` paga primeiro quem foi
  //     pedido por último, e se a rodoviária fosse a última conta a pagar ela poderia
  //     simplesmente não ser paga.
  const rodoviária = stations.findIndex((s) => s.terminal === true);
  if (rodoviária >= 0) {
    const pátio = nodes[stations[rodoviária].node];
    const longe = stations
      .filter((s) => s.id !== rodoviária)
      .map((s) => ({ s, d: Math.abs(s.x - pátio.x) + Math.abs(s.y - pátio.y) }))
      .sort((a, b) => (b.d - a.d) || (a.s.id - b.s.id));
    const origens: TransportStation[] = [];
    for (const { s } of longe) {
      if (origens.length >= LINHAS_DO_TERMINAL || routes.length >= MAX_LINES) break;
      if (origens.some((o) => Math.hypot(o.x - s.x, o.y - s.y) < MIN_ANCHOR_GAP)) continue;
      const route = entre(s.id, rodoviária, -1, true);
      if (!route) continue;
      publica(route);
      origens.push(s);
    }
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
  // O buraco que a cidade não tem como tapar não pode travar os outros. Sem `tentados`, a
  // primeira via que não pagasse as calçadas novas encerrava a passada inteira e os buracos
  // seguintes — que teriam linha — ficavam no escuro: foi assim que três linhas sumiram do
  // mapa quando o corredor dividido ficou caro, não porque a cidade tivesse ônibus demais.
  const tentados = new Set<number>();
  while (routes.length < MAX_LINES) {
    const buraco = buracoDeCobertura(nodes, stations, balde, tentados);
    if (!buraco || buraco.dist <= ALCOBERTURA) break;
    tentados.add(buraco.node);
    const caixa = nodes[buraco.node];
    // A via mais local primeiro: é o bairro que está ilhado, e um corredor de avenida já
    // passou por perto sem parar.
    const candidatas = [...caixa.roads].sort((a, b) =>
      (CUSTO[roads[a].rank] - CUSTO[roads[b].rank]) || (a - b));
    for (const road of candidatas) {
      if (roads[road].rank === 'highway') continue;
      const fim = extremosDaVia(road, roads, nodes, edges, stationOf);
      if (!fim) continue;
      const route = entre(fim[0], fim[1]);
      // Corredor que não acrescenta calçada nova é o mesmo ônibus em outra roupa. Duas, e não
      // quatro: o bolso de rua que fecha o buraco mais fundo do mapa tem três esquinas, e a
      // régua antiga mandava essa rua embora por falta de esquina.
      if (!route || route.stops.filter((s) => !stations[s.station].lines.length).length < 2) continue;
      publica(route);
      break;
    }
  }

  // 8) Plataformas: agora que toda linha existe, o pátio sabe onde cada uma encosta, e o
  //    passeio de frente para cada berço vira plataforma numerada com guichê. Vem por último
  //    porque plataforma é conseqüência do horário, não planta: se uma linha deixa de morrer
  //    no pátio, a baia dela some do mapa sozinha, sem ninguém ter de redesenhar a quadra.
  const platforms = plataformasDoPátio(graph, tiles, W, H, passeio, edges, stations, routes);

  return {
    roads, nodes, edges, stations, platforms, routes, services, companies: EMPRESAS,
    out, twin: par, stationOf, stopsAt,
    grid: balde,
  };
}

/**
 * O buraco de cobertura: a caixa com calçada mais longe de uma parada servida, com a
 * distância. Varredura pelo balde de chunks, então o custo é o dos baldes vizinhos, não o
 * do mapa inteiro — é chamada uma vez por linha extra, nunca por frame. `tentados` são as
 * caixas que a passada já pediu linha e não conseguiu: pulá-las é o que deixa a varredura
 * chegar ao buraco seguinte em vez de desistir no primeiro.
 */
function buracoDeCobertura(
  nodes: TransportNode[],
  stations: TransportStation[],
  balde: StationGrid,
  tentados: Set<number>,
): { node: number; dist: number } | null {
  let pior = -1;
  let distancia = -1;
  for (const n of nodes) {
    if (!n.curbed || tentados.has(n.id)) continue;
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

/**
 * Quantos tiles de passeio contínuo, a partir do marco, ainda são "o ponto de ônibus". É o
 * comprido de uma marquise de verdade: três passos de calçada entre a faixa de pedestre e o
 * poste. Medido a pé pela vizinhança do passeio, nunca em linha reta, porque a régua é o que o
 * jogador percorre e o que se pinta no chão — um tile a três tiles do marco do outro lado de
 * um muro não é a mesma calçada e não embarca ninguém.
 */
export const ZONA_DO_PONTO = 3.2;

/**
 * A zona de embarque de uma calçada: o marco e todo passeio que se alcança dele andando, sem
 * atravessar asfalto, dentro de `ZONA_DO_PONTO`. Sai ordenado (o marco primeiro, depois a
 * vizinhança em ordem de índice) para a malha continuar uma função da semente: render, embarque
 * e check têm de ler a mesma lista na mesma ordem.
 *
 * O grafo pedonal tem arestas de travessia — é por elas que o pedestre muda de lado, e é por
 * isso que caminhar por ele não basta para dizer o que é a *mesma* calçada: uma aresta dessas
 * custa três tiles, cabe dentro de `ZONA_DO_PONTO`, e devolve a calçada do outro lado da
 * avenida pintada como se fosse o ponto. Valem só os passos de tile a tile: todos os tiles pelo
 * qual o passo passa têm de ser passeio, o que amarra a tinta ao meio-fio e deixa a travessia
 * do lado de fora da marquise.
 */
function zonaDoPonto(graph: RoadGraph, marco: number,
  passeio: Int32Array, W: number, H: number): { x: number; y: number }[] {
  if (marco < 0 || marco >= graph.sidewalkNodes.length) return [];
  const naCalçada = (de: { x: number; y: number }, até: { x: number; y: number }): boolean => {
    const passos = Math.max(2, Math.ceil(Math.hypot(até.x - de.x, até.y - de.y) / 0.25));
    // Amostra no meio de cada pedaço, nunca na emenda: o ponto exato entre dois tiles é o canto
    // que a calçada diagonal do gerador reserva de propósito, e ler a cota dele jogaria fora o
    // volta-e-meia legítimo de uma esquina.
    for (let p = 0; p < passos; p++) {
      const t = (p + 0.5) / passos;
      const tx = Math.floor(de.x + (até.x - de.x) * t);
      const ty = Math.floor(de.y + (até.y - de.y) * t);
      if (tx < 0 || ty < 0 || tx >= W || ty >= H) return false;
      if (passeio[ty * W + tx] < 0) return false;
    }
    return true;
  };
  const caminha = new Float64Array(graph.sidewalkNodes.length).fill(Infinity);
  const zona: number[] = [marco];
  caminha[marco] = 0;
  for (let p = 0; p < zona.length; p++) {
    const de = graph.sidewalkNodes[zona[p]];
    for (const vizinho of graph.sidewalkNeighbors[zona[p]] ?? []) {
      const até = graph.sidewalkNodes[vizinho];
      if (!naCalçada(de, até)) continue;
      const d = caminha[zona[p]] + Math.hypot(até.x - de.x, até.y - de.y);
      if (d > ZONA_DO_PONTO || caminha[vizinho] <= d) continue;
      caminha[vizinho] = d;
      zona.push(vizinho);
    }
  }
  zona.sort((a, b) => a - b);
  return zona.map((i) => ({ x: graph.sidewalkNodes[i].x, y: graph.sidewalkNodes[i].y }));
}

/**
 * Quanto de calçada, em torno do centro de um tile da zona, ainda conta como estar no ponto. É
 * o corpo de quem espera, não um raio de conveniência: `PLAYER_RADIUS` é 0,3 e um pedestre
 * nunca pisa exatamente o centro do tile, então sete decímetros é o passo que cabe no passeio
 * sem chamar de "ponto" a calçada da vizinha.
 */
export const PASSO_DO_PONTO = 0.7;

/** Quem está nestas coordenadas está no ponto desta calçada? */
export function noPonto(station: TransportStation, x: number, y: number): boolean {
  for (const p of station.ponto) {
    if (Math.hypot(p.x - x, p.y - y) <= PASSO_DO_PONTO) return true;
  }
  return false;
}

/**
 * As plataformas do pátio, derivadas dos berços que o horário já usa.
 *
 * A regra é a de uma rodoviária de verdade: cada linha que morre dentro da quadra exclusiva
 * encosta num tile da faixa de entrada, e o trecho de calçada de frente para aquele tile é a
 * plataforma dela — com número, guichê e embarque próprios. Nada aqui inventa geometria: o
 * encosto vem de `baiaTerminal`, que é exatamente o ponto onde o ônibus do horário para, então
 * o painel que diz "Plataforma 2" e o ônibus que encosta na Plataforma 2 são a mesma conta, e
 * não duas histórias que alguém teve de manter iguais à mão.
 *
 * A coluna de passeio que atende uma faixa é a que encosta nela pelo avesso — para o lado de
 * fora da quadra, nunca para a faixa gêmea do outro lado, que é asfalto. É por isso que a
 * plataforma se formos a pé da calçada até o ônibus e não em linha reta: o embarque acontece no
 * passeio, e a placa fica onde o passageiro a vê.
 */
function plataformasDoPátio(
  graph: RoadGraph, tiles: MapTile[], W: number, H: number,
  passeio: Int32Array, edges: TransportEdge[],
  stations: TransportStation[], routes: TransportRoute[],
): TransportPlatform[] {
  const all: TransportPlatform[] = [];
  for (const st of stations) {
    if (!st.terminal) continue;
    const ids: number[] = [];
    st.platforms = ids;

    // 1) O berço de cada linha que morre no pátio: a última calçada da ida ou a primeira da
    //    volta, lida do mesmo `at`/`voltaAt` que desenha o ônibus parado.
    type Berço = { linha: number, x: number, y: number, faixa: number, calçada: number, ty: number };
    const berços: Berço[] = [];
    for (const route of routes) {
      const S = route.stops.length;
      for (const i of [0, S - 1]) {
        const stop = route.stops[i];
        if (!stop || stop.station !== st.id) continue;
        const naIda = i === S - 1;
        const p = alongRoute(route, naIda ? stop.at : stop.voltaAt, naIda ? 1 : -1);
        const faixa = Math.round(p.x - 0.5), ty = Math.round(p.y - 0.5);
        if (faixa < 0 || ty < 0 || faixa >= W || ty >= H) continue;
        // 2) A coluna de passeio de frente para o berço: a faixa tem calçada para fora e
        //    asfalto para dentro, então dos dois lados vizinhos no máximo um é passeio.
        for (const dx of [-1, 1]) {
          const calçada = faixa + dx;
          if (calçada < 0 || calçada >= W) continue;
          const i2 = ty * W + calçada;
          if (passeio[i2] < 0 || !tiles[i2].terminal) continue;
          berços.push({ linha: route.id, x: p.x, y: p.y, faixa, calçada, ty });
          break;
        }
      }
    }
    if (!berços.length) continue;
    berços.sort((a, b) => (a.calçada - b.calçada) || (a.ty - b.ty) || (a.linha - b.linha));

    // 3) Berços da mesma coluna e da mesma fila são a mesma baia: duas linhas que param no
    //    mesmo tile embarcam na mesma plataforma.
    type Bay = { faixa: number, calçada: number, ty: number,
      encosto: { x: number, y: number }, lines: number[] };
    const baias: Bay[] = [];
    for (const b of berços) {
      const achada = baias.find((x) => x.calçada === b.calçada && x.ty === b.ty);
      if (achada) { achada.lines.push(b.linha); continue; }
      baias.push({ faixa: b.faixa, calçada: b.calçada, ty: b.ty,
        encosto: { x: b.x, y: b.y }, lines: [b.linha] });
    }

    for (const baia of baias) {
      // O comprido do passeio desta coluna: o embarque vai da boca do pátio até o virador, e a
      // plataforma divide esse comprido com a vizinha pelo meio do caminho entre os berços. O
      // tile do meio fica com a baia de fila menor e a outra começa no seguinte, de propósito: se
      // um tile pertencesse às duas, quem estivesse nele poderia embarcar nas duas linhas, e a
      // numeração das baias existe justamente para impedir o passageiro de entrar no ônibus
      // errado.
      const fileira: number[] = [];
      for (let y = 0; y < H; y++) {
        const i = y * W + baia.calçada;
        if (passeio[i] >= 0 && tiles[i].terminal) fileira.push(y);
      }
      if (fileira.indexOf(baia.ty) < 0) continue;
      const vizinhas = baias.filter((b) => b.calçada === baia.calçada).sort((a, b) => a.ty - b.ty);
      const posto = vizinhas.indexOf(baia);
      const ante = vizinhas[posto - 1];
      const próx = vizinhas[posto + 1];
      const desde = ante ? Math.floor((ante.ty + baia.ty) / 2) + 1 : fileira[0];
      const até = próx ? Math.floor((baia.ty + próx.ty) / 2) : fileira[fileira.length - 1];
      const ponto = fileira.filter((y) => y >= desde && y <= até)
        .map((y) => {
          const s = graph.sidewalkNodes[passeio[y * W + baia.calçada]];
          return { x: s.x, y: s.y };
        });

      // O guichê fica na ponta da plataforma: o tile de passeio mais longe do ônibus parado. É o
      // canto onde a cabine não fecha o embarque de ninguém e onde a placa do poste continua
      // visível da boca do pátio — e não um ponto inventado: se a baia tem um tile só, o
      // bilheteiro fica em cima da placa porque não há ponta nenhuma.
      const marco = graph.sidewalkNodes[passeio[baia.ty * W + baia.calçada]];
      let guichê = marco;
      let ponta = Math.hypot(marco.x - baia.encosto.x, marco.y - baia.encosto.y);
      for (const q of ponto) {
        const d = Math.hypot(q.x - baia.encosto.x, q.y - baia.encosto.y);
        if (d > ponta) { ponta = d; guichê = q; }
      }

      // A faixa atendida: a aresta `access` do pátio em que o berço mora. Guarda-a porque é
      // assim que o check sabe que a plataforma tem ônibus na frente, e não é um número de
      // placa colado numa calçada qualquer.
      const edge = edges.findIndex((e) => e.rank === 'access'
        && e.path.some((t) => {
          const n = graph.roadNodeTiles[t];
          return n.tx === baia.faixa && n.ty === baia.ty;
        }));

      const p: TransportPlatform = {
        id: all.length,
        station: st.id,
        número: ids.length + 1,
        name: `Plataforma ${ids.length + 1}`,
        edge,
        x: marco.x,
        y: marco.y,
        encosto: baia.encosto,
        ponto,
        guichê: { x: guichê.x, y: guichê.y },
        lines: baia.lines.sort((a, b) => a - b),
      };
      all.push(p);
      ids.push(p.id);

      // A calçada da estação passa a ser a união das suas baias: quem espera em qualquer
      // plataforma está no ponto, e é o que se pinta no chão.
      const vistos = new Set(st.ponto.map((q) => `${Math.floor(q.x)},${Math.floor(q.y)}`));
      for (const q of ponto) {
        const k = `${Math.floor(q.x)},${Math.floor(q.y)}`;
        if (vistos.has(k)) continue;
        vistos.add(k);
        st.ponto.push(q);
      }
    }
  }
  return all;
}

/**
 * A âncora mais perto do meio do caminho entre as duas pontas, e que não esteja encostada
 * nelas. É a terceira ponta da transversal: sem a peia dos `MIN_ANCHOR_GAP` ela cairia em cima
 * de uma das pontas e o desvio seria o mesmo caminho, escrito duas vezes.
 */
function maisPertoDoMeio(
  anchors: number[], stations: TransportStation[],
  a: TransportStation, b: TransportStation, de: number, ate: number,
): number {
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
  let melhor = -1, distância = Infinity;
  for (const id of anchors) {
    if (id === de || id === ate) continue;
    const s = stations[id];
    if (Math.hypot(s.x - a.x, s.y - a.y) < MIN_ANCHOR_GAP) continue;
    if (Math.hypot(s.x - b.x, s.y - b.y) < MIN_ANCHOR_GAP) continue;
    const d = Math.hypot(s.x - mx, s.y - my);
    if (d < distância) { distância = d; melhor = id; }
  }
  return melhor;
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
/**
 * A linha já publicada que mais divide vias com esta candidata, e a fração que elas têm em
 * comum — medida sobre o *menor* dos dois conjuntos, de propósito: uma perna curta que cabe
 * inteira dentro de uma troncal é o caso que o jogador aponta como "os dois fazem a mesma
 * rota", ainda que a troncal tenha corredor sobrando para si.
 */
function rivalDeSobreposição(vias: Set<number>, viasPorRota: Set<number>[]):
  { rota: number, fração: number } {
  let rota = -1, fração = 0;
  for (let r = 0; r < viasPorRota.length; r++) {
    let comuns = 0;
    for (const via of vias) if (viasPorRota[r].has(via)) comuns++;
    const f = comuns / Math.min(vias.size, viasPorRota[r].size);
    if (f > fração) { fração = f; rota = r; }
  }
  return { rota, fração };
}

function cheapChain(
  nodes: TransportNode[],
  out: number[][],
  edges: TransportEdge[],
  from: number,
  to: number,
  pelaEspinha: boolean,
  uso: Map<number, number>,
  usoDaVia: Map<number, number>,
  /** Vias interditadas desta passada: é como uma linha procura o caminho por fora de uma rival. */
  ban?: Set<number>,
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
      if (ban?.has(e.road)) continue;
      // Rodovia é o último recurso, não um desvio. O `access` do pátio entra na conta: ele só
      // aparece em rota que tenha o terminal como ponta, porque a boca do pátio já está
      // fechada quando o Dijkstra entra nele, e voltar pela faixa gêmea é voltar a um nó
      // resolvido — o virador de terminal não pode ser atalho de ninguém.
      if (!pelaEspinha && e.rank === 'highway') continue;
      const cost = e.length * (CUSTO[e.rank]
        + PESO_DO_CORREDOR * Math.min(usoDaVia.get(e.road) ?? 0, TETO_DO_CORREDOR)
        + PESO_DA_FAIXA * Math.min(uso.get(id) ?? 0, TETO_DA_FAIXA));
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
 * Ponto de uma polilinha: o centro de um tile de faixa ou o ponto por onde se atravessa uma
 * caixa. Só os tiles de faixa são lugar de parar — a caixa é por onde se vira.
 */
interface Vertice {
  x: number;
  y: number;
  /** Índice do tile no grafo do mapa; -1 quando o ponto é dentro de uma caixa. */
  tile: number;
  /** Caixa de cruzamento a que o ponto pertence, ou -1. */
  caixa: number;
}

/** Trecho de meio de uma aresta, em índices de `path`, inclusive. */
interface Fatia { edge: number; desde: number; até: number }

/** A polilinha de um sentido e, para cada caixa que ela visita, onde o ônibus pode encostar. */
interface Traço {
  v: Vertice[];
  cum: number[];
  janelas: number[][];
  /**
   * Para cada caixa, o índice do primeiro tile *depois* dela na direção da linha. É o que
   * separa o encosto adiante do cruzamento — onde o ônibus para — do encosto atrás dele,
   * onde a fila de carros espera.
   */
  saída: number[];
}

const verticeTile = (graph: RoadGraph, tile: number): Vertice => {
  const t = graph.roadNodeTiles[tile];
  return { x: t.tx + 0.5, y: t.ty + 0.5, tile, caixa: -1 };
};

/**
 * Os pontos por onde a mão atravessa a caixa, e não o centro geométrico dela: a caixa é o
 * canto compartilhado pelos quatro tiles, e as duas faixas da mesma rua ficam a meio tile de
 * cada lado desse canto. Um ônibus tem 1,25 × 0,85 de lataria e duas faixas correm a um tile
 * de centro a centro, então dois corpos que entram no cruzamento pelo centro comum, um de
 * cada mão, se encostam pelo simples fato de estarem ali — e o freio, que é honesto, congela
 * os dois. Congelados, os dois viram parede, e a parede para tudo o que chega depois: é o
 * monte de ônibus parado no mesmo ponto que o jogador vê, e é por um vértice compartilhado
 * que a malha inteira emperrava no primeiro minuto.
 *
 * Cada ponto é a projeção da própria faixa sobre a estação longitudinal do centro: o lado em
 * que se entra fica guardado até a curva, e o lado para onde se vai começa no canto do outro
 * lado da caixa, onde a faixa dele realmente começa. Seguir reto dá os dois pontos no mesmo
 * lugar, e a polilinha segue colinear com a rua sem um degrô no meio do asfalto; virar faz a
 * curva dentro da caixa, lateral a lateral, como se faz na rua. A mão contrária passa um tile
 * do lado — o mesmo tile de quando as duas correm no comprido da quadra — sem nada a ver com
 * o centro.
 */
function pontosDaCaixa(
  graph: RoadGraph, nodes: TransportNode[], edges: TransportEdge[],
  entrada: number, saída: number, no: number,
): Vertice[] {
  const c = nodes[no];
  const lados: { p: Vertice; dx: number; dy: number }[] = [];
  for (const [edge, chegando] of [[entrada, true], [saída, false]] as const) {
    const e = edges[edge];
    // O tile de meio mais perto desta ponta da aresta: de onde se vem é o último, para onde se
    // vai é o primeiro. Aresta sem meio não é uma ponta de aresta: são duas caixas coladas.
    const i = chegando ? e.path.length - 2 : 1;
    if (i < 1 || i > e.path.length - 2) continue;
    const aqui = verticeTile(graph, e.path[i]);
    const outro = verticeTile(graph, e.path[chegando ? i - 1
      : i + 1 <= e.path.length - 2 ? i + 1 : 0]);
    // O rumo é sempre o de quem anda: de onde se vem é o tile de antes para o de depois; para
    // onde se vai é o de depois para o de depois-do-depois. Ao contrário, a mão da saída sairia
    // norteando na rua que ela desce, e a curva dentro da caixa sairia no sentido errado — o
    // ponto de projeção fica meio tile *atrás* do canto e a polilinha dá um passo para trás.
    const sinal = chegando ? -1 : 1;
    let dx = (outro.x - aqui.x) * sinal, dy = (outro.y - aqui.y) * sinal;
    const L = Math.hypot(dx, dy);
    if (L < 1e-9) continue;
    dx /= L; dy /= L;
    // A normal à esquerda do rumo é o eixo lateral da via; a faixa nunca passa de meio tile do
    // centro da caixa, e a peia é para o dia em que o gerador inventar um cruzamento mais largo.
    const lateral = Math.max(-0.5, Math.min(0.5, -(aqui.x - c.x) * dy + (aqui.y - c.y) * dx));
    lados.push({
      p: { x: c.x - dy * lateral, y: c.y + dx * lateral, tile: -1, caixa: no },
      dx, dy,
    });
  }
  if (lados.length !== 2) return lados.map((l) => l.p);
  const [de, para] = lados;
  // As duas linhas de faixa se cruzam num canto da caixa, e é nesse canto que se vira. Sem
  // ele, o virar seria a corda direta de meio tile por meio tile: uma diagonal de ângulo exato
  // sobre a fronteira de dois quadrantes do sprite, e o ônibus piscaria entre duas artes no
  // meio do cruzamento. Com ele, cada perna dentro da caixa corre paralela a uma rua.
  const px = -para.dy, py = para.dx;
  const denom = de.dx * px + de.dy * py;
  if (Math.abs(denom) < 1e-6) {
    // Paralelas: é o virador de terminal, onde a ida entra e a volta sai na faixa gêmea, e o
    // meio tile de lado que separa as duas é a própria curva, no rumo de uma rua de verdade.
    return [de.p, para.p];
  }
  const s = ((para.p.x - de.p.x) * px + (para.p.y - de.p.y) * py) / denom;
  const canto: Vertice = { x: de.p.x + de.dx * s, y: de.p.y + de.dy * s, tile: -1, caixa: no };
  // O canto é o vértice da caixa; os dois pontos de projeção só valem se estiverem *antes*
  // dele no sentido em que a mão corre. Uma curva fechada para dentro do cruzamento põe a
  // projeção de entrada meio tile adiante do canto, e a de saída meio tile atrás: segui-los
  // seria andar, voltar e andar de novo — um vaivém de meio tile que faz a polilinha ocupar a
  // faixa contrária por um instante, e dois ônibus de mãos opostas se verem na mesma linha de
  // centro. O canto sozinho resolve: ele está nas duas linhas de faixa, então a perna que
  // chega e a que sai continuam colineais com a rua, e cada trecho fica no rumo de quem anda.
  const entra = s > -1e-9;
  const sai = ((para.p.x - canto.x) * para.dx + (para.p.y - canto.y) * para.dy) > -1e-9;
  const caixa = [canto];
  if (entra) caixa.unshift(de.p);
  if (sai) caixa.push(para.p);
  return caixa;
}

/**
 * Faixa de pedestre: o gerador pinta a zebra encostada na caixa, justamente onde um ônibus
 * pararia se a parada fosse o canto do cruzamento. Encostar em cima dela fecharia o passo de
 * quem atravessa, e o ponto de ônibus fica um tile adiante por isso.
 */
function éZebra(graph: RoadGraph, tile: number): boolean {
  if (tile < 0) return false;
  const t = graph.roadNodeTiles[tile];
  return graph.data.tiles[t.ty * graph.data.tilesW + t.tx].key.includes('pelican');
}

/**
 * Até onde o encosto pode se afastar do centro da caixa, em tiles. O ponto de ônibus é da
 * esquina, não do meio da quadra: uma calçada que corre paralela à faixa está praticamente à
 * mesma distância de todos os tiles dela, e sem esta peia o critério "mais perto do passeio"
 * escolhe um tile qualquer no comprido da quadra — um ônibus parado a oito tiles da marquise.
 */
const ENCOSTO_DA_ESQUINA = 3.2;

/**
 * Até onde a porta de um ônibus encostado alcança quem espera no marco da parada. O encosto
 * agora é um tile de faixa *fora* da caixa, e o marco é um passeio aceito até `CALCADA_MAX`
 * tiles do centro daquela caixa — os dois podem estar em cantos quase opostos do cruzamento,
 * o que faz da distância entre eles algo maior que o asfalto de uma rua. O teto geométrico é
 * a soma dos dois raios; medido na cidade inteira o pior marco↔encosto é 4,47 tiles, então a
 * régua tem folga sem deixar um passageiro do outro lado de uma avenida embarcar.
 */
export const BOARDING_DOOR = +(CALCADA_MAX + ENCOSTO_DA_ESQUINA).toFixed(1);

/**
 * O relógio não sabe que existe um vizinho: duas linhas que servem a mesma caixa escolhem,
 * cada uma por conta própria, o vértice mais perto do passeio, e os dois critérios são o
 * mesmo vértice. Cinco horários diferentes param então no mesmo pixel da mesma esquina — o
 * monte de lataria soldada que o jogador vê na tela. Um ponto de ônibus de verdade é uma
 * fila de marquises ao longo do passeio, cada linha na sua, e é esta régua que separa uma da
 * outra: a mesma caixa de lataria que o asfalto usa para dizer se dois ônibus se encostam,
 * com o palmo de para-choque entre dois carros parados na mesma fila. Fica dentro de
 * `ENCOSTO_DA_ESQUINA`, que é a peia que prende o encosto ao cruzamento, então o berço se
 * espalha pelo passeio sem atravessar a rua.
 */
const PALMO_DO_BERÇO = 0.25;

/**
 * Meia-lataria do ônibus no eixo comprido: o pé do `bus_school` no asfalto, o mesmo desenho
 * que o render usa. Mora aqui porque são os dados da malha que decidem onde cada linha
 * estaciona, e `src/data` não olha para `src/systems` — quem dirige lê esta régua, não o
 * contrário.
 */
export const RAIO_DO_ONIBUS = Math.max(VEHICLE_DEFS.bus_school.footprintW,
  VEHICLE_DEFS.bus_school.footprintH) / 2;

/** Meia-lataria no eixo curto: é o que sobra do `footprint` menor. */
export const MEIA_LARGURA = Math.min(VEHICLE_DEFS.bus_school.footprintW,
  VEHICLE_DEFS.bus_school.footprintH) / 2;

/**
 * A caixa que os dois corpos formam no quadro de quem olha: a minha meia lataria somada à
 * projeção da lataria do outro no meu eixo comprido e no meu lateral. Para dois ônibus
 * paralelos ela é 1,25 × 0,85 tiles; para um que atravessa na minha frente, 1,05 de frente e
 * 1,05 de lado. É por isso que a regra não pode ser um círculo de raio fixo — o círculo é o
 * erro que deixava um ônibus passar por cima do outro no cruzamento.
 */
export function meiaCaixa(de: { angle: number }, para: { angle: number }):
  { frente: number; lado: number } {
  const d = para.angle - de.angle;
  const c = Math.abs(Math.cos(d)), s = Math.abs(Math.sin(d));
  return {
    frente: RAIO_DO_ONIBUS + RAIO_DO_ONIBUS * c + MEIA_LARGURA * s,
    lado: MEIA_LARGURA + RAIO_DO_ONIBUS * s + MEIA_LARGURA * c,
  };
}

/** As duas latarias se encostam? É o zero da régua, sem folga nenhuma — o que o check cobra. */
export function seEncostam(a: { x: number; y: number; angle: number },
  b: { x: number; y: number; angle: number }): boolean {
  const cos = Math.cos(a.angle), sin = Math.sin(a.angle);
  const dx = b.x - a.x, dy = b.y - a.y;
  const caixa = meiaCaixa(a, b);
  return Math.abs(dx * cos + dy * sin) < caixa.frente
    && Math.abs(-dx * sin + dy * cos) < caixa.lado;
}

/**
 * A meia-lataria de um corpo no próprio eixo: `meio` é o comprimento, `flanco` é a largura. Um
 * ônibus é 0,625 × 0,425, um sedã é 0,475 × 0,325, um pedestre é um círculo de 0,15.
 */
export interface Lataria {
  meio: number;
  flanco: number;
}

/**
 * `meiaCaixa` entre dois corpos que cada um traz a sua lataria. Reduz-se exatamente à caixa de
 * ônibus quando os dois são ônibus, e é ela que a malha precisa quando o corpo à frente do
 * ônibus é um carro — ou um pedestre. Com a largura do ônibus no pedestre, a faixa de rolamento
 * engoliria a calçada inteira (1,05 tile de cada lado contra o meio tile de um passeio) e cada
 * pessoa parada no meio-fio prenderia a linha; com a lataria própria, o pedestre só vale dentro
 * do que ele realmente ocupa.
 */
export function meiaCaixaEntre(de: { angle: number } & Lataria,
  para: { angle: number } & Lataria): { frente: number; lado: number } {
  const d = para.angle - de.angle;
  const c = Math.abs(Math.cos(d)), s = Math.abs(Math.sin(d));
  return {
    frente: de.meio + para.meio * c + para.flanco * s,
    lado: de.flanco + para.meio * s + para.flanco * c,
  };
}

/** `seEncostam` com lataria própria dos dois lados. */
export function seEncostamEntre(a: { x: number; y: number; angle: number } & Lataria,
  b: { x: number; y: number; angle: number } & Lataria): boolean {
  const cos = Math.cos(a.angle), sin = Math.sin(a.angle);
  const dx = b.x - a.x, dy = b.y - a.y;
  const caixa = meiaCaixaEntre(a, b);
  return Math.abs(dx * cos + dy * sin) < caixa.frente
    && Math.abs(-dx * sin + dy * cos) < caixa.lado;
}

/**
 * Os dois param no mesmo berço? É `seEncostam` com o palmo de para-choque só no eixo da via:
 * duas faixas de mãos opostas ficam a um tile de centro a centro, e entre elas há fila e
 * calçada de cada lado — não há porque afastá-las, a lataria de uma não encosta na outra. O
 * teste é feito dos dois pontos de vista porque um berço perpendicular ao outro (as duas
 * ruas do mesmo canto) tem caixas que se olham de lados diferentes.
 */
function seDisputamOBerço(
  a: { x: number; y: number; angle: number },
  b: { x: number; y: number; angle: number },
): boolean {
  for (const [de, para] of [[a, b], [b, a]] as const) {
    const cos = Math.cos(de.angle), sin = Math.sin(de.angle);
    const dx = para.x - de.x, dy = para.y - de.y;
    const caixa = meiaCaixa(de, para);
    if (Math.abs(-dx * sin + dy * cos) >= caixa.lado) continue;
    if (Math.abs(dx * cos + dy * sin) < caixa.frente + PALMO_DO_BERÇO) return true;
  }
  return false;
}

/**
 * Berço → calçada tomada. O que se guarda é o ponto no mundo com o rumo de quem estaciona
 * nele, não a distância da polilinha: cada linha mede `cum` a partir do próprio começo, e um
 * número de uma rota não vale na outra — enquanto dois ônibus que param de lados opostos da
 * mesma rua têm o mesmo ponto e rumos contrários, e é o rumo que diz que eles não se tocam.
 *
 * A linha dona do berço também se guarda, e ela é a única que pode se ignorar: a ida encosta
 * no mesmo tile em que a volta dá a meia-volta porque é o *mesmo ônibus* passando por ali em
 * dois momentos do ciclo. Duas linhas diferentes no mesmo tile são dois ônibus parados um em
 * cima do outro, e é exatamente isso que a medição mostrava nos terminais.
 */
type Berço = { x: number; y: number; angle: number; linha: number };
type Doca = Map<number, Berço[]>;

/** Os berços já tomados de uma calçada, criando a lista na primeira visita. */
function fileiraDaDoca(docas: Doca, parada: number): Berço[] {
  let fileira = docas.get(parada);
  if (!fileira) {
    fileira = [];
    docas.set(parada, fileira);
  }
  return fileira;
}

/**
 * O tangente local de um vértice da polilinha: para onde aponta um ônibus estacionado ali.
 * Lido dos vizinhos do próprio vértice porque a polilinha é amostrada no meio das faixas, e
 * o trecho entre dois tiles de faixa é exatamente a direção da via naquele ponto. Um vizinho
 * que mora dentro de uma caixa não diz nada da via — é ali que a polilinha dobra —, então
 * vale o vizinho que é faixa: o rumo de quem chega ao tile ou de quem sai dele.
 */
function rumoDoVértice(traço: Traço, i: number): number {
  const v = traço.v;
  const antes = i > 0 ? v[i - 1] : null;
  const depois = i + 1 < v.length ? v[i + 1] : null;
  const dobra = (p: Vertice | null): boolean => !!p && p.caixa >= 0;
  if (antes && antes.caixa < 0 && dobra(depois)) return Math.atan2(v[i].y - antes.y, v[i].x - antes.x);
  if (depois && depois.caixa < 0 && dobra(antes)) return Math.atan2(depois.y - v[i].y, depois.x - v[i].x);
  const a = antes ?? v[i], b = depois ?? v[i];
  return Math.atan2(b.y - a.y, b.x - a.x);
}

/**
 * Um encosto candidato: distância ao passeio onde se espera, distância à esquina e se ele fica
 * *depois* da caixa no sentido em que a linha corre.
 */
interface Encosto { passeio: number; esquina: number; depois: boolean }

/**
 * Compara dois encostos. Primeiro o que está adiante do cruzamento: a fila de carros para
 * *antes* da faixa de pedestre, e um ônibus que encosta no tile de antes da caixa é o ônibus
 * parado em cima de uma fila — o carro então ou o atravessa ou o espera sem motivo. Depois
 * ganha o mais perto do passeio; empate (trinta e cinco decímetros, que é o que a calçada de
 * um mesmo lado da viavaria muda de um tile para o outro) decide-se pela esquina.
 */
const melhorEncosto = (a: Encosto, b: Encosto): boolean =>
  a.depois !== b.depois ? a.depois
    : a.passeio < b.passeio - 0.35 || (a.passeio <= b.passeio + 0.35 && a.esquina < b.esquina);

/**
 * A polilinha de um sentido. `seq` são as arestas percorridas e `fatias` os tiles de meio de
 * cada uma delas. `cabeça` e `cauda` são os pedaços da *outra* metade nas pontas — o virar de
 * terminal: a volta começa no entroncamento onde a ida encostou e termina no entroncamento de
 * onde a ida partiu, atravessando a caixa dos dois lados. Sem eles o ciclo teria um salto de
 * uma faixa para a contrária no meio da rua.
 */
function montaTraço(
  graph: RoadGraph,
  nodes: TransportNode[],
  edges: TransportEdge[],
  seq: number[],
  fatias: { desde: number; até: number }[],
  cabeça: Fatia | null,
  cauda: Fatia | null,
  /** Prende a primeira e a última caixa ao começo e ao fim da polilinha (é a metade da ida). */
  fixaPontas: boolean,
): Traço {
  const v: Vertice[] = [];
  const cum: number[] = [];
  const faixaDe = seq.map(() => [0, -1] as [number, number]);
  const push = (vrt: Vertice) => {
    const ultimo = v[v.length - 1];
    if (ultimo && Math.abs(ultimo.x - vrt.x) < 1e-9 && Math.abs(ultimo.y - vrt.y) < 1e-9) return;
    cum.push(ultimo
      ? cum[cum.length - 1] + Math.hypot(vrt.x - ultimo.x, vrt.y - ultimo.y)
      : 0);
    v.push(vrt);
  };
  const põe = (edge: number, desde: number, até: number, marca?: [number, number]) => {
    const e = edges[edge];
    const de = Math.max(1, desde);
    const fim = Math.min(e.path.length - 2, até);
    const primeiro = v.length;
    for (let i = de; i <= fim; i++) push(verticeTile(graph, e.path[i]));
    if (marca) { marca[0] = primeiro; marca[1] = v.length - 1; }
  };
  const cabeçaDe: [number, number] = [0, -1];
  const caudaDe: [number, number] = [0, -1];
  if (cabeça) {
    põe(cabeça.edge, cabeça.desde, cabeça.até, cabeçaDe);
    for (const p of pontosDaCaixa(graph, nodes, edges,
      cabeça.edge, seq[0], edges[seq[0]].from)) push(p);
  }
  for (let i = 0; i < seq.length; i++) {
    põe(seq[i], fatias[i].desde, fatias[i].até, faixaDe[i]);
    if (i + 1 < seq.length) {
      for (const p of pontosDaCaixa(graph, nodes, edges, seq[i], seq[i + 1], edges[seq[i]].to)) push(p);
    }
  }
  if (cauda) {
    for (const p of pontosDaCaixa(graph, nodes, edges,
      seq[seq.length - 1], cauda.edge, edges[seq[seq.length - 1]].to)) push(p);
    põe(cauda.edge, cauda.desde, cauda.até, caudaDe);
  }

  const janela = (de: [number, number]): number[] => {
    const out: number[] = [];
    for (let i = de[0]; i <= de[1]; i++) out.push(i);
    return out;
  };
  const janelas: number[][] = seq.map(() => []);
  janelas.push([]);
  for (let i = 0; i < seq.length; i++) {
    for (const k of janela(faixaDe[i])) {
      janelas[i].push(k);
      janelas[i + 1].push(k);
    }
  }
  for (const k of janela(cabeçaDe)) janelas[0].push(k);
  for (const k of janela(caudaDe)) janelas[seq.length].push(k);
  if (fixaPontas) {
    janelas[0] = [0];
    janelas[seq.length] = [v.length - 1];
  }
  // O primeiro vértice que já é da faixa *depois* de cada caixa. Sem aresta saindo da caixa
  // — é o terminal — não há "depois", e a esquina sozinha decide o encosto.
  const saída = seq.map((_, i) => faixaDe[i][0]);
  saída.push(cauda ? caudaDe[0] : Infinity);
  return { v, cum, janelas, saída };
}

/** Quem está nestas coordenadas está no ponto *desta* plataforma? */
export function naPlataforma(platform: TransportPlatform, x: number, y: number): boolean {
  for (const p of platform.ponto) {
    if (Math.hypot(p.x - x, p.y - y) <= PASSO_DO_PONTO) return true;
  }
  return false;
}

/**
 * A plataforma em que uma linha encosta nesta calçada, ou `null` onde não há baia. Mora aqui
 * porque é a dona do `PASSO_DO_PONTO`; o telão (`schedule.ts`) não precisa dela — quem olha o
 * painel quer o número, e o número vem direto da lista da estação.
 */
export function plataformaDaLinha(
  network: TransportNetwork, station: number, route: number,
): TransportPlatform | null {
  const ids = network.stations[station]?.platforms;
  if (!ids) return null;
  for (const id of ids) if (network.platforms[id].lines.includes(route)) return network.platforms[id];
  return null;
}

/**
 * O entroncamento de um terminal: o tile de faixa da aresta mais perto do passeio, sem cair
 * na faixa de pedestre e sem escapar da esquina. É o primeiro (ou o último) ponto da
 * polilinha, porque é ali que o ônibus encosta e vira. Devolve -1 quando a aresta não tem
 * meio — caixas coladas uma na outra, onde não existe onde parar sem invadir o cruzamento.
 *
 * No terminal a linha nasce ou morre, e duas linhas que morrem na mesma caixa param no mesmo
 * ponto pelo tempo inteiro do dwell — por isso o berço vale aqui também: o segundo virador
 * estaciona um corpo adiante na mesma faixa. E como o canto de um terminal é apertado — às
 * vezes o único tile de passeio dentro da peia é justamente o que a primeira linha tomou —,
 * antes de dividir a lataria das duas linhas é a peia que abre: a fila de terminais corre
 * pelo asfalto adiante, colada no passeio, que é o que se vê numa rodoviária de verdade.
 * Perder o berço é o último recurso, não o primeiro.
 */
function baiaTerminal(
  graph: RoadGraph, edges: TransportEdge[], edgeId: number,
  alvo: { x: number; y: number }, esquina: { x: number; y: number },
  tomados: Berço[], linha: number,
): number {
  const e = edges[edgeId];
  const varre = (
    foraZebra: boolean, livre: boolean, peia: number, alcance: number,
  ): number => {
    let achado = -1, melhor: Encosto | null = null;
    for (let i = 1; i <= e.path.length - 2; i++) {
      if (foraZebra && éZebra(graph, e.path[i])) continue;
      const t = graph.roadNodeTiles[e.path[i]];
      const antes = graph.roadNodeTiles[e.path[Math.max(0, i - 1)]];
      const depois = graph.roadNodeTiles[e.path[Math.min(e.path.length - 1, i + 1)]];
      const passeio = Math.hypot(t.tx + 0.5 - alvo.x, t.ty + 0.5 - alvo.y);
      const encosto = {
        passeio,
        esquina: Math.hypot(t.tx + 0.5 - esquina.x, t.ty + 0.5 - esquina.y),
        // No terminal não há fila para liberar: a linha nasce ou morre ali, e a distância à
        // esquina já é o que prende o encosto ao cruzamento.
        depois: false,
      };
      if (encosto.esquina > peia) continue;
      if (passeio > alcance) continue;
      if (livre && tomados.some((b) => b.linha !== linha && seDisputamOBerço(
        { x: t.tx + 0.5, y: t.ty + 0.5, angle: Math.atan2(depois.ty - antes.ty, depois.tx - antes.tx) },
        b))) continue;
      if (achado < 0 || melhorEncosto(encosto, melhor!)) { achado = i; melhor = encosto; }
    }
    return achado;
  };
  // A fila do terminal corre pelo asfalto adiante, colada no passeio, e para onde um
  // passageiro ainda alcança a porta: `alcance` é a régua do embarque menos o pé do ônibus,
  // então o último carro da fila continua sendo um ônibus num ponto de ônibus. Este encosto é a
  // origem da plataforma: `plataformasDoPátio` lê exatamente este `at`/`voltaAt` para dar número,
  // guichê e porta à calçada que o ônibus tem pela frente — por isso a placa "Plataforma 2" e o
  // ônibus que encosta na Plataforma 2 não podem contar histórias diferentes.
  const alcance = BOARDING_DOOR - RAIO_DO_ONIBUS;
  for (const tenta of [
    [true, true, ENCOSTO_DA_ESQUINA, alcance], [false, true, ENCOSTO_DA_ESQUINA, alcance],
    [true, true, Infinity, alcance], [false, true, Infinity, alcance],
    [true, false, Infinity, alcance], [false, false, Infinity, alcance],
  ] as const) {
    const i = varre(tenta[0], tenta[1], tenta[2], tenta[3]);
    if (i >= 0) return i;
  }
  return -1;
}

/**
 * O encosto de uma caixa: o vértice da janela dela que esteja adiante do último encosto
 * escolhido — a ordem do horário tem de bater com a ordem da polilinha —, fora da caixa,
 * colado na esquina e o mais perto do passeio. Dos dois lados da caixa, vale o de depois,
 * onde a fila de carros já passou; zebra só quando não houver alternativa.
 *
 * Por cima disso vem o berço: a calçada que já tem ônibus estacionado recebe a linha seguinte
 * um corpo e um palmo adiante, porque dois horários na mesma marca do passeio são o monte de
 * lataria que aparece na tela. E quando o passeio da esquina não tem mais onde encostar —
 * três linhas é o que cabe entre a caixa do cruzamento e `ENCOSTO_DA_ESQUINA` — a linha
 * *passa direto*: ela não para aqui, para na calçada seguinte da sua rota. É a regra que dá
 * ao ponto de ônibus o espaço que ele precisa, e é por isso que a cidade tem muitos pontos,
 * cada um com a sua fileira de marquises, em vez de uma esquina espremida com dez linhas.
 */
function encosta(
  graph: RoadGraph, traço: Traço, janela: number[],
  alvo: { x: number; y: number }, esquina: { x: number; y: number }, mínimo: number,
  depoisDa: number, tomados: Berço[], linha: number,
): number {
  const varre = (foraZebra: boolean, aceitaTerminal: boolean): number => {
    let achado = -1, melhor: Encosto | null = null;
    for (const i of janela) {
      const p = traço.v[i];
      if (p.caixa >= 0 || traço.cum[i] <= mínimo) continue;
      // Os dois cantos da polilinha são a baia do terminal: a linha nasce e morre ali, divide o
      // mesmo tile de faixa entre a ida e a volta e é por isso que pode estar atrás da caixa —
      // não há fila nenhuma atrás de um ônibus que acaba de virar.
      const éBaia = i === 0 || i === traço.v.length - 1;
      const aceita = aceitaTerminal && éBaia;
      // Adiante da caixa é lei, não preferência: o ônibus que encosta antes do cruzamento para
      // em cima da fila de carros que espera o sinal.
      if (i < depoisDa && !aceita) continue;
      if (foraZebra && éZebra(graph, p.tile)) continue;
      // E o berço também é: a calçada que já tem ônibus estacionado recebe esta linha um corpo
      // e um palmo adiante. O berço da própria linha não briga com ela — é a volta chegando no
      // tile em que a ida encostou, e é o mesmo ônibus em dois momentos do relógio.
      if (!aceita && tomados.some((b) => b.linha !== linha && seDisputamOBerço(
        { x: p.x, y: p.y, angle: rumoDoVértice(traço, i) }, b))) continue;
      const e = {
        passeio: Math.hypot(p.x - alvo.x, p.y - alvo.y),
        esquina: Math.hypot(p.x - esquina.x, p.y - esquina.y),
        depois: i >= depoisDa,
      };
      // A peia da esquina é o que prende uma parada de calçada ao cruzamento dela. No
      // terminal de quem já está na baia de virar não há o que prender: quem decidiu o tile
      // foi a busca de baia, e ela corre pelo asfalto adiante quando a fila de linhas exige.
      if (!aceita && e.esquina > ENCOSTO_DA_ESQUINA) continue;
      // A porta alcança o passeio, não a outra ponta da rua — e isso vale para a baia também:
      // sem esta régua o vértice preferido podia ser o último da polilinha, um ônibus parado a
      // doze tiles do marco em que alguém espera, que é o "ponto de ônibus no meio da rua".
      if (e.passeio > BOARDING_DOOR - RAIO_DO_ONIBUS) continue;
      if (achado < 0 || melhorEncosto(e, melhor!)) { achado = i; melhor = e; }
    }
    return achado;
  };
  // Zebra só quando não houver alternativa: um ônibus parado na faixa de pedestre é feio, um
  // parado em cima de outro é o bug. E a baia do terminal só quando a esquina enteira não tem
  // mais onde encostar: perder o terminal é perder a linha.
  for (const [foraZebra, terminal] of [[true, false], [false, false], [true, true], [false, true]] as const) {
    const i = varre(foraZebra, terminal);
    if (i >= 0) return i;
  }
  return -1;
}

/**
 * Tiles de asfalto de uma sequência de faixas. É a régua do desvio: a terceira ponta só vale
 * se a linha ficar mais comprida por andar por outra rua, e não por dar a volta no quarteirão.
 */
function comprimento(edges: TransportEdge[], chain: number[]): number {
  let soma = 0;
  for (const id of chain) soma += edges[id].length;
  return soma;
}

/**
 * O papel da linha, lido do traçado que ela acabou de desenhar. Duas regras e nenhum sorteio:
 * quem morre no pátio é linha de rodoviária, e o resto se decide pelo quanto a linha é comprida
 * e pelo quanto dela corre em via rápida. É esta leitura que dá à avenida o ônibus seguido e à
 * rua do bairro o ônibus raro — a malha de hoje tinha os dois com o mesmo intervalo de 17 s, e
 * é por isso que a cidade inteira parecia uma só linha desenhada vinte vezes.
 */
function papelDaLinha(
  stations: TransportStation[], fromStation: number, toStation: number,
  edges: TransportEdge[], chain: number[], ida: Traço,
): TransportRole {
  if (stations[fromStation].terminal || stations[toStation].terminal) return 'rodoviaria';
  let veloz = 0, total = 0;
  for (const id of chain) {
    const e = edges[id];
    total += e.length;
    if (e.rank === 'avenue' || e.rank === 'highway') veloz += e.length;
  }
  const razão = total > 0 ? veloz / total : 0;
  const comprido = ida.cum[ida.cum.length - 1];
  if (comprido >= 200 && razão >= 0.5) return 'troncal';
  if (comprido <= 120 || razão < 0.15) return 'local';
  return 'arterial';
}

/**
 * Linha entre duas paradas: o caminho mais barato, a polilinha dos dois sentidos e o horário
 * de ida e volta. Devolve nulo quando não há caminho, quando o caminho não tem onde parar —
 * uma linha sem três calçadas não é uma linha, é um carro passando — ou quando alguma faixa
 * percorrida não tem gêmea no sentido contrário.
 */
function makeRoute(
  graph: RoadGraph,
  nodes: TransportNode[],
  edges: TransportEdge[],
  /** Saídas de via de mão dupla: só por elas uma linha pode ir e voltar na sua própria faixa. */
  dual: number[][],
  /** Aresta → faixa gêmea do mesmo corredor no sentido contrário. */
  par: Int32Array,
  stations: TransportStation[],
  stationOf: number[],
  fromStation: number,
  toStation: number,
  line: number,
  /**
   * Primeira matrícula desta linha na garagem. É passado, não calculado aqui, porque só na
   * publicação se sabe quantos ônibus a cidade já numerou — e uma linha recusada no meio do
   * caminho não come número nenhum.
   */
  frotaBase: number,
  service: TransportService,
  /** O que as linhas anteriores já estacionaram em cada calçada, para esta não parar em cima. */
  docas: Doca,
  /** Faixa → quantas linhas já correm nela, para a próxima procurar corredor menos disputado. */
  uso: Map<number, number>,
  /** Via → quantas linhas já a atravessaram: é o corredor que o jogador vê cheio. */
  usoDaVia: Map<number, number>,
  /**
   * O conjunto de vias de cada linha já publicada, na ordem das linhas. É o que permite comparar
   * a rota nova com as rotas que existem: o `usoDaVia` conta quantas, mas não *quais*.
   */
  viasPorRota: Set<number>[],
  /**
   * Se esta linha tem de procurar um caminho que não seja o corredor de outra. Ligado nas
   * passada de âncoras, que são as linhas que o jogador percorre de olho no mapa; desligado nas
   * passadas de cobertura, cujo único propósito é correr justamente por cima da via isolada.
   */
  contraDuplicada: boolean,
  /**
   * Terceira ponta da linha, quando ela não é a corda reta entre as duas âncoras. É o que faz
   * uma linha nascer *atravessando* um bairro em vez de descer a mesma avenida das duas vezes:
   * a rede real tem radiais, transversais e circulares, e uma malha em que toda linha é o
   * caminho mais curto entre dois pontos desenha vinte cópias tortas do mesmo L.
   */
  viaStation: number,
): TransportRoute | null {
  const from = stations[fromStation].node;
  const to = stations[toStation].node;
  if (from === to) return null;
  const trecho = (de: number, até: number, ban?: Set<number>): number[] | null =>
    cheapChain(nodes, dual, edges, de, até, false, uso, usoDaVia, ban)
    ?? cheapChain(nodes, dual, edges, de, até, true, uso, usoDaVia, ban);
  // A cadeia de uma passada: o caminho mais curto entre as duas âncoras e, quando há terceira
  // ponta, os dois braços que atravessam o bairro. É função porque a mesma construção é pedida
  // duas vezes — uma com as vias livres e outra com o corredor da rival interditado.
  const cadeia = (ban?: Set<number>): number[] | null => {
    const direto = trecho(from, to, ban);
    if (!direto) return null;
    // A terceira ponta só vale se ela acrescentar rua: se os dois braços forem o próprio caminho
    // direto, o "desvio" é a mesma avenida com um nome a mais. E não vale torcer a linha por mais
    // de metade do trajeto — uma transversal de verdade custa até metade a mais que a radial, e
    // acima disso quem paga o desvio é o passageiro.
    if (viaStation < 0) return direto;
    const doMeio = stations[viaStation].node;
    if (doMeio === from || doMeio === to) return direto;
    const a = trecho(from, doMeio, ban), b = trecho(doMeio, to, ban);
    if (!a || !b) return direto;
    const trajeto = [...a, ...b];
    // Faixa repetida não é desvio, é a linha passando duas vezes pelo mesmo asfalto — e a
    // volta, que é a gêmea do caminho inteiro, correria por cima da ida. Não basta olhar a
    // faixa do pedido: o desvio pode descer uma avenida e subir a do mesmo corredor, e aí
    // ida e volta dividem lataria no mesmo tile sem que nenhuma faixa apareça duas vezes.
    const ids = new Set(trajeto);
    const semFaixaRepetida = trajeto.every((id) => !ids.has(par[id]));
    const cm = comprimento(edges, trajeto), cd = comprimento(edges, direto);
    return semFaixaRepetida && cm > cd && cm <= cd * 1.5 ? trajeto : direto;
  };
  let chain = cadeia();
  if (!chain) return null;

  // A linha que percorre as mesmas vias de outra publicada não é uma rota nova: no mapa é a
  // mesma polilinha com um nome a mais, e na calçada é o ônibus que passa e o ônibus que passa
  // de novo. Quando a sobreposição passa do limite, ela procura o caminho por fora, com o
  // corredor da rival interditado. Uma tentativa só: se a cidade não tem por fora — a margem
  // onde cabe uma avenida — a linha é publicada por cima do mesmo asfalto, porque cobertura
  // vale mais que originalidade.
  if (contraDuplicada) {
    const rival = rivalDeSobreposição(new Set(chain.map((id) => edges[id].road)), viasPorRota);
    if (rival.fração > LIMIAR_DA_DUPLICA) {
      // O desvio não compra rodovia. A espinha é último recurso de *travessia* — atravessar o
      // rio — e uma linha que sobe nela só para não dividir a avenida da rival trocaria um
      // problema pelo outro: o expresso de rodovia é o ônibus que nenhum passeio alcança, e o
      // check da malha cobra justamente que rodovia havendo rua, a linha fica na rua.
      const alternativa = cadeia(viasPorRota[rival.rota]);
      const rodovia = (c: number[]) => c.some((id) => edges[id].rank === 'highway');
      if (alternativa && (!rodovia(alternativa) || rodovia(chain))) chain = alternativa;
    }
  }

  // A volta é a faixa gêmea do mesmo corredor, percorrida ao contrário. Um ônibus que volta
  // pela própria faixa é um ônibus na contramão no meio da rua, e é isso que ele parece hoje
  // quando passa por um carro parado. `chain` já só anda por faixa com par, porque o caminho
  // foi buscado na malha de mão dupla; a guarda fica para o dia em que as duas deixarem de
  // andar juntas.
  const reverse: number[] = [];
  for (let i = chain.length - 1; i >= 0; i--) {
    const gêmea = par[chain[i]];
    if (gêmea < 0) return null;
    reverse.push(gêmea);
  }

  // As duas pontas da ida estacionam na calçada das estações terminais, na mesma fileira em
  // que as outras linhas já param: o virador de terminal é um ônibus parado como qualquer um.
  const q0 = baiaTerminal(graph, edges, chain[0], stations[fromStation], nodes[from],
    fileiraDaDoca(docas, fromStation), line);
  const ultimo = chain[chain.length - 1];
  const wl = baiaTerminal(graph, edges, ultimo, stations[toStation], nodes[to],
    fileiraDaDoca(docas, toStation), line);
  if (q0 < 0 || wl < 0) return null;

  const ida = montaTraço(
    graph, nodes, edges, chain,
    chain.map((id, i) => ({
      desde: i === 0 ? q0 : 1,
      até: i + 1 === chain.length ? wl : edges[id].path.length - 2,
    })),
    null, null, true,
  );
  const volta = montaTraço(
    graph, nodes, edges, reverse,
    reverse.map((id) => ({ desde: 1, até: edges[id].path.length - 2 })),
    { edge: ultimo, desde: wl, até: edges[ultimo].path.length - 2 },
    { edge: chain[0], desde: 1, até: q0 },
    false,
  );
  if (ida.v.length < 2 || volta.v.length < 2) return null;

  const caixas: number[] = [from, ...chain.map((id) => edges[id].to)];
  const baias = (traço: Traço, ordem: number[]): Map<number, number> => {
    const achadas = new Map<number, number>();
    let percorrido = -1;
    for (let s = 0; s < ordem.length; s++) {
      const st = stationOf[ordem[s]];
      if (st < 0) continue;
      const fileira = fileiraDaDoca(docas, st);
      const i = encosta(graph, traço, traço.janelas[s], stations[st],
        nodes[ordem[s]], percorrido, traço.saída[s], fileira, line);
      if (i < 0) continue;
      // A linha estaciona e avisa: a próxima que encostar nesta calçada vai um corpo adiante.
      fileira.push({ x: traço.v[i].x, y: traço.v[i].y, angle: rumoDoVértice(traço, i), linha: line });
      achadas.set(ordem[s], i);
      percorrido = traço.cum[i];
    }
    return achadas;
  };
  const encostosIda = baias(ida, caixas);
  const encostosVolta = baias(volta, [...caixas].reverse());

  const stops: TransportStop[] = [];
  for (const no of caixas) {
    const st = stationOf[no];
    const a = encostosIda.get(no);
    const b = encostosVolta.get(no);
    if (st < 0 || a === undefined || b === undefined) continue;
    stops.push({ station: st, at: ida.cum[a], voltaAt: volta.cum[b] });
  }
  // As duas pontas da rota são os dois viradores, e um virador sem berço não é ponta: é uma
  // linha que atravessa a cidade, passa reto pelo próprio terminal e morre sessenta tiles depois
  // do último passageiro ter descido. Se a calçada do destino não recebeu esta linha — o berço
  // estava tomado, a porta não alcança o marco — a linha cai inteira, igual ao berço perdido.
  if (stops.length < 1 || stops[0].station !== fromStation
    || stops[stops.length - 1].station !== toStation) return null;
  // O papel nasce da própria geometria da linha — por onde ela corre, o quanto ela é comprida
  // e se ela morre no pátio — e não de sorteio: a mesma semente dá a mesma cidade, e o jogador
  // que desce na avenida sabe que ali passa a troncal porque a linha *parece* uma troncal.
  const papel = papelDaLinha(stations, fromStation, toStation, edges, chain, ida);
  const P = PAPEIS[papel];
  // A política de paradas vem antes do relógio, porque é ela que diz quantas calçadas o ciclo
  // tem de pagar: o expresso atravessa a cidade parado em quatro esquinas, e o local para em
  // todas. As duas pontas são sempre servidas — sem berço na ponta a linha não tem onde virar.
  const servidas = ((): TransportStop[] => {
    const kept: TransportStop[] = [];
    for (let i = 0; i < stops.length; i++) {
      const s = stops[i];
      const éPonta = i === 0 || i === stops.length - 1;
      if (!éPonta) {
        if (P.espaço > 0 && s.at - kept[kept.length - 1].at < P.espaço) continue;
        if (P.sóPrincipais && stations[s.station].rank === 'residential') continue;
        // A calçada da rodoviária é servida por quem entra no pátio; nenhuma linha urban
        // atravessa a quadra exclusiva para fazer uma parada de esquina.
        if (stations[s.station].terminal && papel !== 'rodoviaria') continue;
      }
      kept.push(s);
    }
    return kept;
  })();
  if (servidas.length < 3) return null;
  const length = ida.cum[ida.cum.length - 1];
  const backLength = volta.cum[volta.cum.length - 1];

  // Horário: ida parada por parada na faixa de um lado, volta na faixa do outro. A travessia
  // é o tempo de cruzeiro sobre a polilinha daquele sentido; a parada some do relógio como
  // `dwell` em cada calçada. A tabela continua simétrica — o índice `i` é a passada de ida e
  // `2S-1-i` é a mesma parada na volta — porque é assim que o schedule lê uma chegada sem
  // um campo a mais em cada linha; o que mudou é a distância de cada passada, que agora é
  // medida na polilinha em que o ônibus realmente anda.
  const table: { dist: number; time: number }[] = [];
  for (let i = 0; i < servidas.length; i++) {
    table.push({ dist: servidas[i].at, time: servidas[i].at / service.speed + i * service.dwell });
  }
  const turnAt = table[table.length - 1].time + service.dwell;
  for (let i = servidas.length - 1; i >= 0; i--) {
    table.push({
      dist: servidas[i].voltaAt,
      time: turnAt + servidas[i].voltaAt / service.speed
        + (servidas.length - 1 - i) * service.dwell,
    });
  }
  // O descanso de pátio é tempo de ciclo, não tempo de rua: a linha de rodoviária chega, pega a
  // faixa gêmea, encosta no próprio berço e fica ali até a próxima partida. É por isso que o
  // pátio tem ônibus estacionados de verdade, e é por isso também que ela precisa de menos
  // veículos no asfalto do que o comprido do trajeto sugere.
  const rodando = table[table.length - 1].time + service.dwell;
  const layover = rodando * P.descanso;
  const cycle = rodando + layover;
  // A frota é o orçamento do papel, não o desejo do horário: `ciclo/intervalo` é a conta, e o
  // teto é o que a viação tem na garagem. Passando do teto, o intervalo publicado é o que os
  // veículos existentes pagam — e é esse número, não o pedido, que o painel e a régua leem.
  const units = Math.max(1, Math.min(P.teto, Math.round(cycle / P.headway)));
  const ranks = new Set<RoadRank>();
  for (const id of chain) ranks.add(edges[id].rank);

  return {
    id: line, name: `Linha ${line + 1}`, modality: service.modality, service: service.id,
    role: papel,
    company: viaDaLinha(papel, line),
    fleet: frotaBase,
    edges: chain, stops: servidas,
    ranks: [...ranks].sort((a, b) => (CUSTO[a] - CUSTO[b]) || a.localeCompare(b)),
    points: ida.v, cum: ida.cum, length,
    back: volta.v, backCum: volta.cum, backLength,
    cycle, turnAt, table,
    headway: cycle / units,
    // O descompasso é o ângulo áureo do ciclo: duas linhas de ritmos parecidos nunca chegam
    // juntas ao mesmo cruzamento, e a conta não depende de sorteio nem de semente.
    phase: mod(line * ÂNGULO_ÁUREO * cycle, cycle),
    layover,
    units,
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
