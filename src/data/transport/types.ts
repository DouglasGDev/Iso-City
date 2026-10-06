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
  /**
   * Vizinhança do passeio: quais calçadas um pedestre alcança andando de um tile ao outro. É
   * por ela que se mede o comprido de um ponto de ônibus, e não a régua em linha reta — entre
   * dois tiles a 3 tiles de distancia pode haver um muro no meio, e a zona de embarque tem de
   * ser o passeio contínuo em que alguém espera.
   */
  readonly sidewalkNeighbors: readonly number[][];
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

/**
 * Uma plataforma de embarque do pátio da rodoviária: o bay de uma linha dentro da quadra
 * exclusiva, com o seu número, o seu trecho de calçada e o seu guichê.
 *
 * Ela não é uma marquise desenhada sobre a planta — é a conta de onde a lataria para. Cada
 * linha que morre no pátio encosta num tile de faixa diferente da mesma faixa de entrada, e é
 * o tile daquele encosto que divide o passeio em plataformas, de frente para ele. Sem isto a
 * rodoviária teria um único "ponto" grande dentro da quadra: o telão diria Linha 3 e o
 * passageiro procuraria o ônibus de olho no asfalto, que é exatamente o que quem já andou de
 * ônibus interestadual não faz — ele olha o número da plataforma no painel e vai até lá.
 */
export interface TransportPlatform {
  id: number;
  /** A estação-terminal a que ela pertence. */
  station: number;
  /** O número na placa, 1-based: é o que o telão mostra e o que o passageiro procura. */
  número: number;
  /** O nome lido no painel e na placa da quadra. */
  name: string;
  /** A faixa do pátio em que o ônibus encosta — a aresta `access` da quadra exclusiva. */
  edge: number;
  /**
   * O marco: o tile de passeio de frente para o encosto da linha. É o `x`/`y` que o GPS aponta
   * e o poste desenha, e é a ele que a zona da plataforma se prende.
   */
  x: number;
  y: number;
  /** O asfalto em que a lataria para, lido do berço que o horário já usa. */
  encosto: { x: number; y: number };
  /**
   * O passeio desta plataforma e de nenhuma outra: os tiles da coluna, entre o meio do caminho
   * para a plataforma de cima e o meio do caminho para a de baixo. É a régua do embarque na
   * quadra e é o que se pinta no chão — quem está na Plataforma 2 não embarca no ônibus da 1
   * só porque a porta alcança.
   */
  ponto: { x: number; y: number }[];
  /**
   * O guichê: o tile de passeio do lado de *dentro* da plataforma, o avesso da faixa em que o
   * ônibus encosta. É a fileira de bilheteria de uma rodoviária real, colada na plataforma e
   * olhando para ela, e mora aqui porque a posição dele é deriva do berço, não escolha de
   * desenhista.
   */
  guichê: { x: number; y: number };
  /** As linhas que embarcam aqui. No pátio de hoje é uma por plataforma. */
  lines: number[];
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
  /**
   * A caixa é o pátio da rodoviária: a parada não é uma marquise na esquina, é o embarque
   * dentro da quadra exclusiva, e é para ela que a malha manda as linhas de pontas. Quem lê
   * (plataforma do hall, painel de partidas, o check) quer saber isto sem conhecer o tile.
   */
  terminal?: boolean;
  lines: number[];
  /**
   * A zona de embarque: os tiles de passeio contínuo em que quem espera está *no ponto*,
   * medidos a pé desde o marco, e não em linha reta. É a régua do embarque e é exatamente o
   * que se pinta no chão — o jogador embarca onde vê a marquise, e um tile do outro lado da
   * rua nunca entra nela porque o passeio não o conecta ao marco.
   */
  ponto: { x: number; y: number }[];
  /**
   * As plataformas desta calçada, quando ela é o pátio de uma rodoviária. Uma rua comum tem
   * uma marquise e um poste, e não precisa de nada aqui; na quadra exclusiva o embarque é por
   * baia, e quem chega quer saber o número dela. Vazio é o mesmo que não existir.
   */
  platforms?: number[];
}

/**
 * A viação que opera a linha. Numa cidade de verdade o ônibus não é um veículo genérico com
 * número: é um corpo pintado com as cores de uma empresa, com o prefixo da garagem dele no
 * teto, e duas linhas da mesma empresa param no mesmo tipo de lugar. É isso que faz o
 * jogador ler a rua — a cor diz a viação, o prefixo diz *qual* ônibus, e o número da linha
 * diz para onde ele vai. Nenhum dos três é sorteio: a viação vem do papel da linha e do
 * corredor por onde ela corre, e o prefixo é a ordem em que a frota foi publicada.
 */
export interface TransportCompany {
  id: number;
  /** Nome de fachada, o que estaria escrito no guichê e no telão. */
  name: string;
  /** Sigla pintada na lataria, e o prefixo de cada número de frota da viação. */
  code: string;
  /** Cor do corpo do ônibus, no formato que a camada de desenho lê. */
  livery: string;
  /** A faixa mais escura do mesmo esquema, para o filete e a borda da placa. */
  stripe: string;
}

/**
 * O lugar da linha na cidade, e portanto o ritmo dela. Numa rede real o passageiro não vê
 * "ônibus a cada 17 s em tudo quanto é rua": a avenida troncal tem ônibus seguidos porque é
 * por ela que se atravessa a cidade, a rua do bairro tem um a cada vários minutos, e a
 * rodoviária tem partidas em hora marcada. O papel é o que produz essa diferença — e é ele
 * que paga a frota: sem papel próprio toda linha sai com o mesmo intervalo e a cidade
 * inteira vira um corredor saturado, que é o amontoado que o jogador vê.
 */
export type TransportRole = 'troncal' | 'arterial' | 'local' | 'rodoviaria';

/** Uma parada da rota na ordem em que o veículo a encontra. */
export interface TransportStop {
  station: number;
  /** Distância ao longo da polilinha da ida, no ponto em que o ônibus encosta. */
  at: number;
  /**
   * Distância da mesma calçada ao longo da polilinha da volta. Não é `length - at`: a volta
   * corre na faixa do outro lado da via, tem curva própria e comprimento próprio.
   */
  voltaAt: number;
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
  /** O papel da linha na rede, e portanto o intervalo e a política de paradas dela. */
  role: TransportRole;
  /** Índice de `TransportNetwork.companies`: de quem são as cores deste ônibus. */
  company: number;
  /**
   * Primeiro número de frota desta linha. Os veículos dela são `fleet`, `fleet + 1`, … na
   * ordem do índice do horário, e o bloco de cada linha começa onde o da anterior parou —
   * é por isso que nenhum prefixo se repete na cidade inteira, e por isso que ele não precisa
   * ser guardado por veículo.
   */
  fleet: number;
  edges: number[];
  stops: TransportStop[];
  /** Postos atravessados pela rota: é o que o check cobra como cobertura. */
  ranks: RoadRank[];
  points: { x: number; y: number }[];
  /** Distância acumulada em cada ponto de `points`. */
  cum: number[];
  length: number;
  /**
   * Polilinha da volta: as mesmas ruas, percorridas na faixa do sentido contrário. Ela começa
   * onde a ida termina e termina onde a ida começa, porque o ônibus vira na ponta e pega a
   * calçada do outro lado — é isso que fecha o ciclo sem nenhum teleporte no meio da rua.
   */
  back: { x: number; y: number }[];
  backCum: number[];
  backLength: number;
  /**
   * Tempo de uma volta completa (ida, volta e as paradas no meio), e a marca de onde a
   * volta começa. É o que transforma o relógio do jogo em posição sem nenhum estado.
   */
  cycle: number;
  turnAt: number;
  /** Tabelas de chegada: `dist` ao longo da polilinha no instante `time` do ciclo. */
  table: { dist: number; time: number }[];
  /**
   * Segundos entre duas passadas na mesma calçada *desta* linha. Não é o do serviço: a troncal
   * da avenida e a rua do bairro têm ritmos diferentes, e é essa diferença que faz a frota
   * caber no orçamento sem transformar cada cruzamento num corredor de ônibus idêntico.
   */
  headway: number;
  /**
   * Descompasso do ciclo desta linha, em segundos. Sem ele, toda linha nasce com o veículo 0
   * parado no ponto `0` no instante zero e as voltas de ritmos parecidos batem juntas nos
   * mesmos cruzamentos: os 453 de 768 pares de lataria a menos de 0,7 tile medidos na malha
   * eram dois ônibus *em movimento* de linhas diferentes se encontrando no virar.
   */
  phase: number;
  /**
   * Segundos que o veículo passa estacionado no berço de origem antes de fechar a volta. É o
   * descanso de pátio de uma linha que morre na rodoviária: na vida real o ônibus não atravessa
   * a cidade de dois em dois minutos sem parar — ele encosta, descarrega, e fica na baia até a
   * hora da próxima partida. No horário isso é só um `stopped` comprido no fim da tabela.
   */
  layover: number;
  /** Veículos necessários no horário para o `headway` da linha, dentro do teto do papel. */
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
  /**
   * Aresta → a faixa gêmea do mesmo corredor, no sentido contrário, ou -1 quando não há. É o
   * que diz se uma via é de mão dupla: a linha de ônibus vai por uma faixa e volta pela outra,
   * então uma aresta sem par não é por onde se corra. A régua de cobertura lê o mesmo mapa —
   * um caminho que existe no grafo do mapa mas não existe na malha de mão dupla não é um desvio
   * que a linha deixou de tomar.
   */
  twin: Int32Array;
  stations: TransportStation[];
  /**
   * As plataformas de embarque do mundo, derivadas dos berços das linhas que morrem no pátio.
   * Vivem fora da estação porque o telão, o GPS e a camada de desenho precisam delas por id, e
   * a estação guarda só a lista dos seus números.
   */
  platforms: TransportPlatform[];
  routes: TransportRoute[];
  services: TransportService[];
  /** As viações da cidade, na ordem em que `TransportRoute.company` aponta para elas. */
  companies: TransportCompany[];
  /** Aretas que saem de cada nó, para o Dijkstra de rota. */
  out: number[][];
  /** Nó → estação daquele nó, ou -1. */
  stationOf: number[];
  /** Estação → ids das rotas que param nela. */
  stopsAt: number[][];
  grid: StationGrid;
}
