import type { MapTile, RoadRank } from '../maps/city';

/**
 * Modalidades que a rede sabe descrever. Hoje só `bus` tem malha: o mapa ainda não tem
 * pista, cais nem ferrovia, e uma linha desenhada sobre um tile que não existe seria
 * exatamente o transporte "posicionado à mão" que a spec proíbe. Quando o gerador tiver a
 * superfície, a malha daquela modalidade é derivada do mesmo jeito — o modelo não muda.
 */
export type TransportModality = 'bus' | 'rail' | 'sea' | 'air';

/**
 * O pouco que a derivação precisa saber do mundo, na forma mais estreita possível, para
 * `src/data` não importar `src/world`: os nós do grafo dirigido de ruas, os tiles que eles
 * são e os passeios onde um pedestre espera. `Map` satisfaz esta forma sozinho, e uma
 * planta de teste pode satisfazer com um objeto literal.
 */
export interface RoadGraph {
  readonly data: { tilesW: number; tilesH: number; tiles: MapTile[] };
  readonly roadNodeTiles: readonly { tx: number; ty: number }[];
  readonly roadOut: readonly number[][];
  readonly sidewalkNodes: readonly { x: number; y: number }[];
}

/**
 * Uma via da malha: os dois sentidos de um mesmo corredor agrupados. O agrupamento é
 * geométrico — mesmo posto, mesmo eixo, faixas em colunas (ou linhas) vizinhas — e é ele
 * que dá nome à parada, igual a uma placa de esquina: "Avenida 3 · Rua 7".
 */
export interface TransportRoad {
  id: number;
  rank: RoadRank;
  /** Eixo em que as faixas correm: `x` viaja em coluna constante, `y` em linha constante. */
  axis: 'x' | 'y';
  /** Coordenada da faixa mais ao norte/oeste: é o que identifica a via no mapa. */
  at: number;
  label: string;
}

/**
 * Nó da malha: uma caixa de cruzamento 2×2 do mapa, no centro geométrico dela. É o único
 * lugar onde um ônibus pode virar, porque é o único lugar onde o grafo dirigido do mapa
 * aceita trocar de faixa — a mesma caixa que o `RoadPainter` desenha como cruzamento.
 */
export interface TransportNode {
  id: number;
  x: number;
  y: number;
  /** Tile noroeste da caixa: devolve o nó ao tile do mapa, para quem desenha. */
  tx: number;
  ty: number;
  /** Vias que desembocam na caixa, em ordem estável de rótulo. */
  roads: number[];
  /** Tem passeio encostado: sem calçada não há onde o ônibus parar. */
  curbed: boolean;
}

/**
 * Arete da malha: uma faixa inteira entre duas caixas. O posto é constante por construção
 * (medido no gerador: 960 faixas, zero troca de posto no meio), então a areta herda o posto
 * da faixa e com ele a velocidade de cruzeiro e o direito de ter parada.
 */
export interface TransportEdge {
  id: number;
  from: number;
  to: number;
  rank: RoadRank;
  road: number;
  length: number;
  /** Nós do grafo do mapa percorridos, da caixa de origem à de destino, inclusive. */
  path: number[];
}

/** Parada: o nó, o ponto exato no passeio e as linhas que passam por ela. */
export interface TransportStation {
  id: number;
  node: number;
  x: number;
  y: number;
  name: string;
  rank: RoadRank;
  road: number;
  lines: number[];
}

/** Uma parada da rota na ordem em que o veículo a encontra. */
export interface TransportStop {
  station: number;
  /** Distância ao longo da polilinha da rota. */
  at: number;
}

/**
 * A rota em si: a sequência de paradas, a geometria por onde ela passa e o horário fechado
 * (duração do ciclo e quantos veículos precisa ter para manter o intervalo da frota). Nada
 * aqui é escrito à mão — vem do grafo do mapa e da semente do mundo.
 */
export interface TransportRoute {
  id: number;
  name: string;
  modality: TransportModality;
  service: number;
  edges: number[];
  stops: TransportStop[];
  /** Postos atravessados pela rota: é o que o check cobra como cobertura. */
  ranks: RoadRank[];
  points: { x: number; y: number }[];
  /** Distância acumulada em cada ponto de `points`. */
  cum: number[];
  length: number;
  /**
   * Tempo de uma volta completa (ida, volta e as paradas no meio), e a marca de onde a
   * volta começa. É o que transforma o relógio do jogo em posição sem nenhum estado.
   */
  cycle: number;
  turnAt: number;
  /** Tabelas de chegada: `dist` ao longo da polilinha no instante `time` do ciclo. */
  table: { dist: number; time: number }[];
  /** Veículos necessários no horário para o `headway` do serviço. */
  units: number;
}

/**
 * O serviço que opera as rotas: a modalidade, a velocidade de cruzeiro e o intervalo entre
 * os veículos. É aqui que uma modalidade se diferencia — trem e balsa têm o mesmo tipo de rota,
 * outro ritmo.
 */
export interface TransportService {
  id: number;
  modality: TransportModality;
  label: string;
  /** Tiles por segundo de cruzeiro, na escala do jogo (a pé 1,85, carro 3,15). */
  speed: number;
  /** Segundos entre duas passadas na mesma parada. */
  headway: number;
  /** Segundos parado na calçada para embarcar. */
  dwell: number;
  routes: number[];
}

/** Baldes de consulta por posição: a célula é do tamanho do `CHUNK_SIZE` do streaming. */
export interface StationGrid {
  cell: number;
  cols: number;
  rows: number;
  head: Int32Array;
  next: Int32Array;
}

export interface TransportNetwork {
  roads: TransportRoad[];
  nodes: TransportNode[];
  edges: TransportEdge[];
  stations: TransportStation[];
  routes: TransportRoute[];
  services: TransportService[];
  /** Aretas que saem de cada nó, para o Dijkstra de rota. */
  out: number[][];
  /** Nó → estação daquele nó, ou -1. */
  stationOf: number[];
  /** Estação → ids das rotas que param nela. */
  stopsAt: number[][];
  grid: StationGrid;
}
