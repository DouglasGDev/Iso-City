import { GAME_CONFIG } from '../../game/GameConfig';
import type { Biome, Dir4, TileKind } from '../../game/GameConfig';
import { BUILDING_CATALOG } from '../buildings';
import type { BuildingCatalogEntry } from '../buildings';
import { CIVILIAN_VEHICLES, VEHICLE_DEFS } from '../vehicles';
import { distritosDasQuadras, viasDasTravessas, viasDoGrid } from './Lugares';
import type { Lugares } from './Lugares';

export interface PlacedBuilding {
  key: string;
  x: number;
  y: number;
  footprintW: number;
  footprintH: number;
  tag: string;
}

export interface PlacedProp {
  key: string;
  /** Ground anchor in world tiles; fences use the segment midpoint. */
  x: number;
  y: number;
  /** Absolute world AABB, NOT relative to x/y. Map must register it as FENCE. */
  collider?: { x: number; y: number; width: number; height: number };
  /** Uniform native-pixel multiplier; default 1. Apply before static culling. */
  renderScale?: number;
  /** Normalized source-image ground anchor; default { x: 0.5, y: 1 }.
   * Draw at iso(x,y) - renderAnchor * scaledImageSize (no minimum-size clamp).
   */
  renderAnchor?: { x: number; y: number };
}

export interface PlacedVehicle {
  defKey: string;
  color: string | null;
  x: number;
  y: number;
  dir: Dir4;
}

/**
 * Queda d'água nascida do próprio relevo. Nada aqui é desenhado à mão: o gerador escolhe
 * o talude onde a encosta mais cai, e a água passa por cima dele seguindo o chão.
 */
export interface Cascade {
  id: number;
  /**
   * Eixo do escoamento, do manancial até a bacia, em coordenadas de mundo já alisadas.
   * Só guarda a planta: a cota de cada ponto é lida do chão no render, pela mesma função
   * que entorta o losango — assim a folha de água nunca descola da encosta.
   */
  curso: { x: number; y: number }[];
  /** Largura do canal no lábio, em tiles. Abaixo do lábio a corrente alarga sozinha. */
  largura: number;
  /** Bacia de impacto: onde a queda chega e a água empoça. */
  bacia: { x: number; y: number; raio: number };
  /** Cota do lábio e do fundo da queda, em tiles de relevo. */
  topo: number;
  base: number;
  /** Desnível aproveitado pela queda, em tiles. É o que vira altura de tela: 1 tile = 64px. */
  queda: number;
}

/**
 * O vão por onde se entra numa caverna. A sala não está aqui — isto é só o pé da porta
 * pregado na encosta, do lado de fora, exatamente como a fachada de um prédio guarda a
 * porta de uma sala que o mapa nunca viu.
 */
export interface CaveMouth {
  id: number;
  /** Centro do vão, em coordenadas de mundo: é onde a pedra escurece. */
  x: number;
  y: number;
  /** Para onde quem sai da caverna olha: o sentido por onde a encosta desce. */
  facing: number;
  /** Cota do chão sob a boca, em tiles. Serve de régua para a porta não nascer no vale. */
  cota: number;
}

/**
 * O posto do tile na hierarquia viária. Não é tinta nem enfeite de radar: é o que diz a
 * velocidade de cruzeiro, o custo de uma rota e onde um ônibus pode parar. Vem sempre da
 * geometria do gerador, nunca de um desenho à mão.
 * - `highway` — a espinha do mapa: as colunas que têm ponte sobre o rio e as duas avenidas
 *   que correm nas margens. É por onde passa toda viagem de ponta a ponta.
 * - `avenue` — o grid primário, uma a cada `SPACING` tiles, com calçada dos dois lados.
 * - `street` — rua local que parte o quarteirão comercial ao meio e serve os lotes.
 * - `residential` — a mesma rua, no bairro de casas: quem entra ali é vizinho, não passagem.
 * - `access` — derivação curta que serve uma instalação (porto, aeroporto, pátio). Ainda não
 *   existe nenhuma no mapa, e acesso sem instalação seria só asfalto sobrando: quem criar a
 *   instalação carimba o acesso junto. Toda rua deste mapa é de mão dupla em faixas
 *   separadas, porque o grafo dirigido não aceita beco sem saída.
 */
export type RoadRank = 'highway' | 'avenue' | 'street' | 'residential' | 'access';

export interface MapTile {
  kind: TileKind;
  key: string;
  biome: Biome;
  /** One-way straight lane; null only inside a 2x2 junction. */
  lane?: Dir4 | null;
  bridge?: boolean;
  /** Papel na hierarquia viária. Todo tile de estrada tem um; os outros não. */
  rank?: RoadRank;
  /**
   * O asfalto é do terminal. Carimbo de posse, não de desenho: diz ao jogo e à malha que
   * este tile — faixa, caixa de manobra, plataforma ou pista de pátio — pertence à quadra da
   * rodoviária e não ao fluxo da cidade. É por ele que a parada nasce dentro do pátio em vez
   * de nascer na esquina da avenida, e que uma linha pode terminar aqui sem que ninguém
   * confunda o virador de terminal com um cruzamento.
   */
  terminal?: boolean;
}

export interface CityMapData {
  tilesW: number;
  tilesH: number;
  tiles: MapTile[];
  /**
   * Altura do chão em tiles (0 a TERRAIN_MAX_ELEVATION), indexada igual a `tiles`.
   * Campo contínuo, sem degrau: cidade e água são sempre 0 — a planície urbana é o
   * zero do mundo e o leito é o fundo do vale. Só move o eixo Y da projeção iso,
   * nunca o X: é profundidade 2.5D, não uma terceira dimensão de câmera.
   */
  heights: Float32Array;
  /**
   * Relevo sombreado do mesmo tile, de -1 (encosta na sombra) a +1 (lombo iluminado),
   * com a luz vindo de cima da tela. É tinta pura: o GroundLayer usa para pintar por
   * cima do losango e a serra aparecer sem escada de terraço.
   */
  shades?: Float32Array;
  /**
   * Onde existe morro: o maior declive num raio de 9 tiles, de 0 a 1, e zero no chão plano
   * — asfalto, rio e interior. A tinta do GroundLayer usa só isto para decidir se pinta o
   * losango; quão forte pintar vem do `shades` do próprio tile.
   */
  relevo?: Float32Array;
  /**
   * Quanto de copa faz sombra naquele tile, de 0 (chão nu) a 1 (mata fechada). Carimbado
   * pelo gerador a partir das árvores reais, deslocado para baixo na tela — a direção para
   * onde a luz de cima projeta. É tinta pura, como `shades`: o GroundLayer só lê o número.
   * Cidade e água são sempre zero, porque ali não há morro nem mata a sombrear.
   */
  copa?: Float32Array;
  buildings: PlacedBuilding[];
  props: PlacedProp[];
  vehicles: PlacedVehicle[];
  /**
   * Cachoeiras do relevo. Vazio onde não há morro com caimento bastante para segurar uma
   * queda — e toda sala interior é um mapa sem cascatas, por isso o campo é opcional:
   * quem lê precisa tratar a ausência, não o zero.
   */
  cascatas?: Cascade[];
  /**
   * Boca da caverna: o vão de uma sala que não está no mapa. É o avesso da porta de
   * prédio — a fachada fica na encosta e o que tem dentro é um plano à parte, como em
   * todo interior. Só o pé da porta é mundo; a travessia inteira se passa dentro.
   */
  cavernas?: CaveMouth[];
  /**
   * Bairros, zonas, o rio e as vias nomeadas — o mapa respondendo "onde você está" em vez
   * de só "do que você é feito". É derivado da malha, não guardado: a mesma semente dá os
   * mesmos nomes para sempre e nada disso entra no save. Interior não tem bairro nenhum,
   * por isso o campo é opcional e quem lê trata a ausência.
   */
  lugares?: Lugares;
  npcSpawns: { x: number; y: number }[];
  playerSpawn: { x: number; y: number };
  worldW: number;
  worldH: number;
}

type Rect = { x0: number; y0: number; x1: number; y1: number };
type Block = Rect & { col: number; row: number; biome: Biome; special?: BuildingCatalogEntry;
  /** Rua local no corredor da quadra, com o posto dela. `null` é a entrada pedonal só. */
  street?: RoadRank;
  /** A quadra é do terminal: lote cívico sem vizinhos, pátio fechado e faixa própria. */
  terminal?: boolean };
type Point = { x: number; y: number };

const GRASS = 'tile_ground_grass';
const DIRT = 'tile_ground_dirt';
const CONCRETE = 'tile_ground_concrete';
const ASPHALT = 'tile_ground_asphalt';
// Areia clara (tools/prepare-terrain.cjs): a terra batida do pack é esverdeada e
// não lê como praia nem como deserto.
const SAND = 'tile_ground_sand_beach';
const DUNE = 'tile_ground_sand_dune';
const DUST = 'tile_ground_sand_dry';
const SPACING = 16;
const SETBACK = 0.65;
const MAX_BUILDINGS = 1200;
// Clareira habitada: uma quadra de reserva em cada cinco ganha morador, com teto
// próprio para o rural não comer o orçamento de prédios que é mobile.
const RURAL_BLOCK_EVERY = 5;
// Areia e savana são reservas curtas: com o ritmo do mato a praia inteira ficava com
// um bangalô só, e um imóvel novo por quadra não estoura o teto de prédios.
const RURAL_BLOCK_EVERY_SMALL_RESERVE = 3;
const MAX_RURAL_BUILDINGS = 90;
// Hard partitions total 720: urban infill can never spend the forest's trees.
// The reserve grew to 20 quadras, so its quota moved up to keep the canopy readable.
//
// Os tetos abaixo nasceram de medida, não de gosto. O que pesa no mobile não é o total
// de props do mapa — é o que a janela de neblina deixa passar por quadro. Medido na
// janela de um celular (844x390, zoom padrão) varrendo o mundo inteiro, com estas cotas:
// mediana 7, p99 ~35, pior quadro na casa dos 50 sprites estáticos (prédio + prop juntos),
// e o teto que o check-map cobra é 72. Ou seja: ainda há janela para encher antes de o
// quadro pesar — é essa folga que a mata e a serra estão usando aqui.
//
// A mata fecha a 2.300 árvores sobre ~9.000 tiles (uma a cada ~16 tiles², contra as
// ~41 tiles² da cota velha) e a serra sobe a 1.300: sem isso o alto do morro continuava
// meia-clareira, e o "pode lotar de árvore" do pedido morria no orçamento, não no mapa.
const PROP_BUDGET = { urban: 150, fences: 72, forestTrees: 2300, forestDetails: 60,
  countryside: 110, beach: 40, pinewood: 900, savanna: 48, desert: 110, serra: 1300 } as const;
type PropBudget = keyof typeof PROP_BUDGET;
const MAX_PROPS = 4400;
/**
 * Raio da copa em tiles, medido no PNG do sprite (128px de largura = 1 tile de chão),
 * com a pinheira um passo mais estreita que a frondosa do mesmo tamanho. É o que decide
 * o tamanho do borro de sombra, então o número é o da silhueta desenhada — não um raio
 * de gosto.
 */
const PROP_CANOPY: Record<string, number> = {
  prop_tree_common_large: 0.44, prop_tree_common_medium: 0.34,
  prop_tree_pine_tall: 0.34, prop_tree_pine_medium: 0.3, prop_tree_pine_small: 0.26,
};
/** Curva de saturação do campo de copa: ganho antes do `1 - e^-x`. Calibrado na medida. */
const COPA_GANHO = 2.2;
const MAX_VEHICLES = 120;
const MAX_SPAWNS = 700;
const FENCE_THICKNESS = 0.12;
const FENCE_GATE = 1; // Full AABB-to-AABB opening, not distance between anchors.

/** Gerador determinístico compartilhado com a derivação da malha de transporte. */
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Ruído de valor em grade, determinístico pela semente do mundo. Não usa Math.random:
 * `seed 42` tem de gerar o mesmo relevo tile a tile, senão o snapshot dos checadores quebra.
 */
function reliefNoise(seed: number): (x: number, y: number) => number {
  const lattice = (sx: number, sy: number, rng: () => number) => {
    // Grade 64x64 com envelopamento: a célula mais miúda daqui é 5 tiles, então nenhuma
    // oitava volta sobre si mesma dentro dos 240 tiles do mapa.
    const table = new Float64Array(64 * 64);
    for (let i = 0; i < table.length; i++) table[i] = rng();
    // O valor no canto é bilinear com smoothstep: sem ele a montanha teria facetas
    // quadradas alinhadas ao grid, que é justamente o look que se quer evitar.
    return (x: number, y: number) => {
      const gx = x / sx;
      const gy = y / sy;
      const x0 = Math.floor(gx);
      const y0 = Math.floor(gy);
      const fx = gx - x0;
      const fy = gy - y0;
      const ax = fx * fx * (3 - 2 * fx);
      const ay = fy * fy * (3 - 2 * fy);
      const at = (dx: number, dy: number) => table[((y0 + dy) & 63) * 64 + ((x0 + dx) & 63)];
      const top = at(0, 0) + (at(1, 0) - at(0, 0)) * ax;
      const bottom = at(0, 1) + (at(1, 1) - at(0, 1)) * ax;
      return top + (bottom - top) * ay;
    };
  };
  const rng = mulberry32(seed);
  // Ruído isótropo nunca faz serra: toda máxima de um campo isótropo é um domo, e domo de
  // 8 tiles lado a lado é favo. Crista de mapa é LINEAR, então a estrutura do meio vem de
  // duas grades esticadas em sentidos opostos: lombo comprido em x e lombo comprido em y.
  // Cruzadas, elas produzem parede com topo e vale entre as paredes.
  //
  // A escala é ditada pelo quadro, não pelo gosto: no zoom padrão a câmera mostra ~7 tiles
  // de lado. Uma onda de 34 tiles nunca cabe inteira ali, então o olho vê só um pedaço de
  // flanco — e flanco visto de perto é piso inclinado, não montanha. As duas esticadas
  // vêm com célula curta de 5 tiles para que a travessia crista-vale-crista caiba no quadro,
  // e a onda grande perde peso: ela só decide ONDE a serra existe, nunca o desenho.
  const octaves = [
    { fn: lattice(34, 34, rng), w: 0.45 },
    { fn: lattice(19, 5, rng), w: 1 },
    { fn: lattice(5, 19, rng), w: 1 },
    { fn: lattice(5, 5, rng), w: 0.3 },
  ];
  const total = 2.75;
  return (x, y) => octaves.reduce((sum, o) => sum + o.w * o.fn(x, y), 0) / total;
}

function shuffle<T>(items: T[], rng: () => number): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

/** Center a finite grid, leaving a green margin outside its perimeter loop. */
function avenueLines(size: number): number[] {
  const intervals = Math.floor((size - 14) / SPACING);
  if (intervals < 3) throw new Error('City needs at least four avenues per axis');
  const margin = Math.floor((size - intervals * SPACING - 2) / 2);
  return Array.from({ length: intervals + 1 }, (_, i) => margin + i * SPACING);
}

/**
 * A cidade em índices de quadra, nunca em frações soltas do mundo: toda fronteira
 * de distrito cai em uma avenida, então nenhum lote fica metade cidade/metade mata.
 * Do oeste para o centro: fábricas e docas na beira do rio, centro financeiro na
 * curva, comércio a leste e casas subindo até a mata. Ao norte, o subúrbio encosta
 * no pinhal e um cinto de parque segura o deserto — loja não abre para duna.
 */
function urbanDistrict(col: number, row: number): Biome {
  if (row <= 4) return col === 8 ? 'suburb' : 'park';
  if (row === 7) return 'park'; // Faixa do rio: pintada pela orla, não por aqui.
  const bank = row < 7 ? 'north' : 'south';
  if (bank === 'north') {
    if (col <= 2) return 'industrial';
    if (col <= 4) return 'residential';
    if (col <= 6) return 'downtown';
    if (col <= 9) return 'commercial';
    return 'suburb'; // Casinhas de praia entre o comércio e a areia.
  }
  if (row === 8 && col <= 3) return 'docks';
  if (col <= 2) return 'industrial';
  if (col <= 5) return 'market';
  if (col === 6) return 'downtown';
  if (col <= 10) return 'commercial';
  if (row <= 11) return 'suburb';
  return col <= 2 ? 'industrial' : 'residential';
}

function isNatural(biome: Biome): boolean {
  return biome === 'forest' || biome === 'countryside' || biome === 'beach'
    || biome === 'pinewood' || biome === 'savanna' || biome === 'desert';
}

/**
 * A espécie pelo nível — nunca pelo desenho da encosta. É a leitura do §8 no mapa: o pé do
 * morro continua a mata de folha larga do vale, o meio-talude divide a frondosa com o
 * pinho, e o alto frio e batido de vento é só conífera. Vale para o plantio da serra e
 * para a cena de fundo da mata inteira, porque espécie escolhida só no morro deixa o vale
 * com a mesma floresta do topo — e aí a altitude não se lê em nada.
 *
 * Pinhal que recebe folha larga perde a silhueta própria, e tipologia por bioma é contrato
 * do projeto; savana é aberta de propósito; e árvore na duna ou na rocha do deserto é o
 * mapa mentindo — lá o que existe é pedra, mato seco e sombra nua.
 */
function especieDoNivel(biome: Biome, nivel: number): string[] | null {
  if (biome === 'pinewood') {
    return nivel >= 2 ? ['prop_tree_pine_tall', 'prop_tree_pine_medium']
      : ['prop_tree_pine_small', 'prop_tree_pine_medium'];
  }
  if (biome === 'forest') {
    return nivel >= 2.6 ? ['prop_tree_pine_tall', 'prop_tree_pine_medium']
      : nivel >= 1.6 ? ['prop_tree_pine_small', 'prop_tree_pine_medium', 'prop_tree_common_medium']
        : ['prop_tree_common_large', 'prop_tree_common_medium', 'prop_tree_pine_small'];
  }
  if (biome === 'countryside') return ['prop_tree_common_medium', 'prop_tree_common_large'];
  if (biome === 'savanna') return ['prop_tree_common_medium'];
  return null;
}

/** Quanto do talude de cada reserva vira árvore. Mata e pinhal fecham; campo e savana ralam. */
const SERRA_ABERTURA: Partial<Record<Biome, number>> = { countryside: 0.45, savanna: 0.3 };

/**
 * Chão pisado da reserva: terra batida na mata, areia clara na praia e no deserto.
 * É a mesma chave que o teste de mapa espera encontrar na trilha.
 */
function trailGround(biome: Biome): { kind: TileKind; key: string } {
  if (biome === 'beach') return { kind: 'dirt', key: DUNE };
  if (biome === 'desert') return { kind: 'dirt', key: SAND };
  return { kind: 'dirt', key: DIRT };
}

function ground(biome: Biome): { kind: TileKind; key: string } {
  if (biome === 'beach') return { kind: 'dirt', key: SAND };
  if (biome === 'desert') return { kind: 'dirt', key: DUST };
  if (biome === 'savanna') return { kind: 'dirt', key: 'tile_ground_dirt_drypatch' };
  if (biome === 'industrial' || biome === 'docks') return { kind: 'dirt', key: DIRT };
  if (biome === 'downtown' || biome === 'commercial' || biome === 'market') {
    return { kind: 'concrete', key: CONCRETE };
  }
  return { kind: 'grass', key: GRASS };
}

/** Catálogo indexado por família, ou seja sem a face `_a`/`_b`: é o que se repete visualmente na rua. */
const FAMILIES = (() => {
  const byFamily = new Map<string, BuildingCatalogEntry[]>();
  for (const entry of BUILDING_CATALOG) {
    const family = entry.name.replace(/^bld_/, '').replace(/_[ab]$/, '');
    byFamily.set(family, [...(byFamily.get(family) ?? []), entry]);
  }
  return byFamily;
})();

const HOUSE_SMALL = ['house_small_blue', 'house_small_brickbrown', 'house_small_brickred',
  'house_small_purple', 'house_small_red', 'house_small_yellow'];
const HOUSE_MEDIUM = ['house_medium_blue', 'house_medium_brickwhite', 'house_medium_brown',
  'house_medium_green', 'house_medium_white'];
const HOUSE_TALL = ['house_tall_blue', 'house_tall_brickbrown', 'house_tall_brickwhite',
  'house_tall_brown', 'house_tall_green', 'house_tall_purple'];
const OFFICE_SMALL = ['office_small_brickred', 'office_small_brown', 'office_small_gray', 'office_small_orange'];
const OFFICE_MEDIUM = ['office_medium_blue', 'office_medium_brickbrown', 'office_medium_brickred',
  'office_medium_green', 'office_medium_white'];
const OFFICE_TALL = ['office_tall_blue', 'office_tall_brown', 'office_tall_yellow'];
const STOREFRONTS = ['cafe', 'pizza', 'icecream', 'autoshop', 'fruitstand', 'clinic'];
const WAREHOUSES = ['warehouse_blue', 'warehouse_brown', 'warehouse_green'];

/**
 * O que cada distrito conhece. A lista é plana de propósito: a largura do lote é a
 * única escolha feita por quadra (fileiras e vagas dependem dela) e dentro da
 * largura sorteada cada lote recebe uma família diferente. Um distrito que só tenha
 * uma família numa largura não gera quadra nenhuma dela — ver `blockPalette`.
 */
const BIOME_FAMILIES: Record<Biome, string[]> = {
  residential: [...HOUSE_SMALL, ...HOUSE_MEDIUM, ...HOUSE_TALL],
  suburb: [...HOUSE_SMALL, ...HOUSE_MEDIUM, 'mobilehomes_style1', 'mobilehomes_style2'],
  // A rua de lojas miúdas fica no centro e no mercado; o comércio é de empenas
  // largas. Abrir as duas classes em todo distrito empurrava o orçamento mobile de
  // prédios ao teto.
  downtown: [...OFFICE_SMALL, ...OFFICE_MEDIUM, ...OFFICE_TALL, 'apartments_brickwhite', ...STOREFRONTS],
  commercial: [...OFFICE_SMALL, ...OFFICE_MEDIUM, 'apartments_brickwhite'],
  market: STOREFRONTS,
  industrial: [...WAREHOUSES, 'gasstation', ...OFFICE_SMALL],
  docks: [...WAREHOUSES],
  park: [],
  // As reservas só usam o que faz sentido no chão delas: casa de tora na mata,
  // celeiro e caravana no campo, bangalô na areia, adobe na terra seca. As
  // tipologias próprias de bioma são as desenhadas em tools/prepare-biome-buildings.cjs.
  forest: [...HOUSE_SMALL, 'cabin_log', 'mobilehomes_style1', 'mobilehomes_style2'],
  pinewood: [...HOUSE_SMALL, 'cabin_log', 'mobilehomes_style1', 'mobilehomes_style2'],
  countryside: [...HOUSE_SMALL, ...HOUSE_MEDIUM, 'cabin_log', 'farm_barn', ...WAREHOUSES],
  savanna: [...HOUSE_SMALL, ...HOUSE_MEDIUM, 'adobe_house', 'farm_barn'],
  beach: [...HOUSE_SMALL, ...HOUSE_MEDIUM, 'beach_bungalow'],
  desert: [...HOUSE_MEDIUM, ...HOUSE_TALL, 'adobe_house'],
};

/** Armazéns são deliberadamente maiores que casas, inclusive na escala visual. */
function scaledEntry(entry: BuildingCatalogEntry): BuildingCatalogEntry {
  return entry.tag === 'warehouse'
    ? { ...entry, footprintW: entry.footprintW * 1.5, footprintH: entry.footprintH * 1.5 }
    : entry;
}

interface BlockPalette {
  /** Largura do lote, comum a toda a quadra: manda no espaçamento das fileiras. */
  size: number;
  /** Prédio do próximo lote, diferente da família `avoid` quando houver vizinho. */
  draw: (avoid?: string) => BuildingCatalogEntry;
}

/** `bld_house_small_red_a` → `house_small_red`: é a família que se repete na rua. */
function familyOf(entryName: string): string {
  return entryName.replace(/^bld_/, '').replace(/_[ab]$/, '');
}

/**
 * A tipologia que dá a cara da reserva. Ela ancora o primeiro lote do sítio: solta
 * no saco, dividede com doze famílias de casinha, bangalô e celeiro quase nunca
 * apareciam e a reserva continuava tendo fachada de subúrbio.
 */
const BIOME_SIGNATURE: Partial<Record<Biome, string>> = {
  forest: 'cabin_log',
  pinewood: 'cabin_log',
  countryside: 'farm_barn',
  savanna: 'adobe_house',
  beach: 'beach_bungalow',
  desert: 'adobe_house',
};

/**
 * Uma quadra não é um molde. O saco embaralhado distribui as famílias do distrito
 * entre os lotes, então a empenada da rua alterna sobrado, casa e loja em vez de
 * repetir o mesmo sprite quadra após quadra; esvaziado, o saco só reabre com uma
 * família diferente da última colocada, e a face `_a`/`_b` sorteia cada lote.
 */
function blockPalette(biome: Biome, rng: () => number): BlockPalette | null {
  const known = BIOME_FAMILIES[biome];
  if (!known.length) return null;
  const byWidth = new Map<number, string[]>();
  for (const family of known) {
    const faces = FAMILIES.get(family);
    if (!faces?.length) throw new Error(`Unknown building family: ${family}`);
    const width = scaledEntry(faces[0]).footprintW;
    byWidth.set(width, [...(byWidth.get(width) ?? []), family]);
  }
  // Menos de duas famílias na mesma largura repetiria o prédio em todos os lotes,
  // que é exatamente o defeito que este sorteio existe para matar.
  const widths = [...byWidth.keys()].filter((w) => byWidth.get(w)!.length > 1).sort((a, b) => a - b);
  if (!widths.length) return null;
  const signature = BIOME_SIGNATURE[biome];
  // Na reserva a largura sorteada é a da tipologia própria do bioma, quando ele tem
  // uma: deixar o sorteio livre podia parar num saco de galpão e o sítio nascer sem
  // nenhuma das casas que existem justamente para aquela paisagem.
  const owned = signature ? widths.filter((w) => byWidth.get(w)!.includes(signature)) : [];
  const buckets = owned.length ? owned : widths;
  const width = buckets[Math.floor(rng() * buckets.length)];
  const families = byWidth.get(width)!;
  // Só ancora se couber na largura sorteada da quadra: a empenada não pode quebrar.
  let anchor = signature && families.includes(signature) ? signature : '';
  let bag: string[] = [];
  let last = '';
  const take = () => {
    if (!bag.length) {
      bag = shuffle(families.filter((f) => f !== last), rng);
      if (!bag.length) bag = shuffle(families, rng);
      last = '';
    }
    return bag.pop()!;
  };
  return {
    size: width,
    draw: (avoid) => {
      // O primeiro lote do sítio é o do bioma; dos demais cuida o saco.
      let family = anchor;
      anchor = '';
      if (!family) family = take();
      // Um lote que não coube (trilha, vaga, entulho) some da fileira sem levar a
      // repetição junto: o vizinho que sobra continua de família diferente.
      for (let tries = 0; family === avoid && tries < 4; tries++) family = take();
      last = family;
      const faces = FAMILIES.get(family)!;
      return scaledEntry(faces[Math.floor(rng() * faces.length)]);
    },
  };
}

/**
 * A semente do mundo. Um só lugar, porque dela dependem o mapa e tudo que é derivado do
 * mapa — a malha de transporte nasce das mesmas ruas e precisa nascer da mesma cidade.
 */
export const WORLD_SEED = 20260909;

export function generateCity(seed = WORLD_SEED): CityMapData {
  const rng = mulberry32(seed);
  const W = GAME_CONFIG.MAP_TILES_W;
  const H = GAME_CONFIG.MAP_TILES_H;
  const xs = avenueLines(W);
  const ys = avenueLines(H);
  const riverRow = Math.floor((ys.length - 1) / 2);
  const northQuay = ys[riverRow];
  const southQuay = ys[riverRow + 1];
  const riverTop = northQuay + 6;
  const riverBottom = southQuay - 4; // exclusive: six contiguous water tiles
  const crossings = new Set([0, Math.floor((xs.length - 1) / 2), xs.length - 1]);
  // Fractions of the avenue grid, snapped to whole blocks: the reserves grow
  // with the world instead of remaining a fixed handful of northern blocks.
  const boundary = (lines: number[], fraction: number) => lines[Math.round((lines.length - 1) * fraction)];
  // A mata do noroeste cobre cinco colunas por quatro quadras; a savanna mantém a
  // sua pegada antiga, porque só a floresta ganhou terreno com estes valores.
  const forestEast = boundary(xs, 0.42);
  const forestSouth = boundary(ys, 0.33);
  const savannaWest = boundary(xs, 0.34);
  const countryWest = boundary(xs, 0.55);
  const countryNorth = boundary(ys, 0.83);
  const beachWest = boundary(xs, 0.78);
  const beachNorth = ys[Math.max(0, riverRow - Math.max(1, Math.round((ys.length - 1) * 0.16)))];
  const pineEast = boundary(xs, 0.55);
  // O nordeste seco fica do lado oposto da mata: mesma faixa norte, margem leste.
  // A praia continua na beira do rio, logo abaixo dele.
  const desertWest = boundary(xs, 0.7);
  // Índice de quadra de cada linha de divisa: as fronteiras já nascem em avenidas,
  // então o plano da cidade é o mesmo dentro do lote e na calçada ao lado dele.
  const indexOfLine = (lines: number[], line: number) => Math.round((line - lines[0]) / SPACING);
  const blockOf = (lines: number[], value: number) => Math
    .max(0, Math.min(lines.length - 2, Math.floor((value - lines[0]) / SPACING)));
  const colOf = (x: number) => blockOf(xs, x);
  const rowOf = (y: number) => blockOf(ys, y);
  const lastCol = xs.length - 2, lastRow = ys.length - 2;
  const forestEastCol = indexOfLine(xs, forestEast);
  const pineEastCol = indexOfLine(xs, pineEast);
  const desertWestCol = indexOfLine(xs, desertWest);
  const savannaWestCol = indexOfLine(xs, savannaWest);
  const countryWestCol = indexOfLine(xs, countryWest);
  const beachWestCol = indexOfLine(xs, beachWest);
  const reserveSouthRow = indexOfLine(ys, forestSouth);
  const greenNorthRow = indexOfLine(ys, countryNorth);
  const beachNorthRow = indexOfLine(ys, beachNorth);
  // As reservas em índices de quadra, no mesmo grid que os lotes: mata e pinhal a
  // pique, savanna e campo no sul, e o deserto a leste do cinto de parque.
  const naturalBlock = (col: number, row: number): Biome | undefined => {
    if (row < reserveSouthRow) {
      if (col < forestEastCol) return 'forest';
      if (col < pineEastCol) return 'pinewood';
      if (col >= desertWestCol) return 'desert';
      return undefined;
    }
    if (row >= greenNorthRow) {
      return col >= countryWestCol ? 'countryside'
        : col >= savannaWestCol ? 'savanna' : undefined;
    }
    if (col >= beachWestCol && row >= beachNorthRow && row < riverRow) return 'beach';
    return undefined;
  };
  const regionOf = (col: number, row: number): Biome => naturalBlock(col, row) ?? urbanDistrict(col, row);
  // O rio é a única linha que corta quadra: na orla a praia precisa encostar na
  // água até nas pontes, senão o banco norte acordaria cortado do resto da areia.
  const naturalRegion = (x: number, y: number): Biome | undefined => {
    if (y >= beachNorth && y < riverBottom && x >= beachWest && y >= northQuay && y < southQuay) return 'beach';
    return naturalBlock(colOf(x), rowOf(y));
  };
  /**
   * Bioma do tile. Só as margens fora das avenidas decidem por coordenada: elas são
   * o cinturão verde que fecha a cidade pelo sul e pelo leste, e sem ele o campo
   * viraria uma fatia de quadras no meio do concreto.
   */
  const biomeAtTile = (x: number, y: number): Biome => {
    if (y >= ys[lastRow] + 2) return 'countryside';
    if (colOf(x) === lastCol && y >= southQuay + 2) return 'countryside';
    return naturalRegion(x, y) ?? urbanDistrict(colOf(x), rowOf(y));
  };
  const tiles: MapTile[] = Array.from({ length: W * H }, (_, i) => {
    const biome = biomeAtTile(i % W, Math.floor(i / W));
    return { ...ground(biome), biome };
  });
  const buildings: PlacedBuilding[] = [];
  const props: PlacedProp[] = [];
  const vehicles: PlacedVehicle[] = [];
  const blocks: Block[] = [];
  const walkway = new Uint8Array(W * H);
  const parking = new Uint8Array(W * H);
  // Local spatial buckets keep clearance checks bounded as the city grows.
  const occupied: Rect[][] = Array.from({ length: W * H }, () => []);
  const at = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < W && y < H ? tiles[y * W + x] : undefined;
  const road = (x: number, y: number) => at(x, y)?.kind === 'road';
  const eachCell = (r: Rect, visit: (x: number, y: number) => void) => {
    for (let y = Math.floor(r.y0); y < Math.ceil(r.y1); y++) {
      for (let x = Math.floor(r.x0); x < Math.ceil(r.x1); x++) visit(x, y);
    }
  };
  const occupy = (r: Rect) => eachCell(r, (x, y) => occupied[y * W + x].push(r));
  const overlaps = (a: Rect, b: Rect) =>
    a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
  const clearRect = (r: Rect, allowParking = false) => {
    let clear = r.x0 >= 0 && r.y0 >= 0 && r.x1 <= W && r.y1 <= H;
    eachCell(r, (x, y) => {
      const t = at(x, y);
      const i = y * W + x;
      if (!t || t.kind === 'water' || t.kind === 'road' || walkway[i] || (!allowParking && parking[i])) {
        clear = false;
      }
      if (occupied[i]?.some((o) => overlaps(r, o))) clear = false;
    });
    return clear;
  };
  const safeCircle = (p: Point, radius: number) => {
    let clear = true;
    eachCell({ x0: p.x - radius, y0: p.y - radius, x1: p.x + radius, y1: p.y + radius }, (x, y) => {
      const t = at(x, y);
      if (!t || t.kind === 'water' || t.kind === 'road') clear = false;
      for (const r of occupied[y * W + x] ?? []) {
        const dx = p.x - Math.max(r.x0, Math.min(p.x, r.x1));
        const dy = p.y - Math.max(r.y0, Math.min(p.y, r.y1));
        if (dx * dx + dy * dy <= radius * radius) clear = false;
      }
    });
    return clear;
  };

  // Plan whole blocks: o mesmo regionOf que pintou os tiles decide o lote, então
  // nenhum quarteirão acorda com metade do bioma do vizinho.
  for (let row = 0; row < ys.length - 1; row++) {
    if (row === riverRow) continue;
    for (let col = 0; col < xs.length - 1; col++) {
      const b: Block = {
        x0: xs[col] + 2, x1: xs[col + 1],
        y0: ys[row] + 2, y1: ys[row + 1], col, row,
        biome: regionOf(col, row),
      };
      if (!isNatural(b.biome) && (col + row * 3) % 13 === 0) b.biome = 'park';
      blocks.push(b);
      eachCell(b, (x, y) => { tiles[y * W + x] = { ...ground(b.biome), biome: b.biome }; });
    }
  }
  for (let y = northQuay + 2; y < southQuay; y++) {
    for (let x = 0; x < W; x++) {
      const biome = naturalRegion(x, y) ?? 'park';
      tiles[y * W + x] = y >= riverTop && y < riverBottom
        ? { kind: 'water', key: 'tile_ground_water', biome }
        : { ...ground(biome), biome };
    }
  }
  /**
   * O mesmo ruído que levanta a serra, lido um pouco mais aberto. Ele também decide
   * onde o chão troca de cor, então o mosaico de albedo acompanha o maciço — terra
   * exposta na crista, mato fechado no vale — em vez de brigar com a tinta do GroundLayer.
   */
  const relief = reliefNoise(seed ^ 0x7a656c69);
  const mosaico = (x: number, y: number) => relief(x * 0.7, y * 0.7);

  // Manchas, não retângulos. O corte é o percentil do próprio campo dentro do bioma,
  // então cada bioma pinta a mesma fração do seu chão em qualquer semente. O grid de
  // módulo que havia aqui desenhava blocos alinhados ao losango — pontilhado que se lia
  // como degrau e engolia a sombra do morro, que é o único sinal de relevo na tela.
  const FRACAO_PATCH: Partial<Record<Biome, number>> = {
    forest: 0.18, pinewood: 0.18, countryside: 0.18, savanna: 0.22, beach: 0.22, desert: 0.22,
  };
  const campos = new Map<Biome, number[]>();
  const entraNoMosaico = (biome: Biome, x: number, y: number) =>
    FRACAO_PATCH[biome] !== undefined && tiles[y * W + x].kind !== 'water'
    // Na praia só seca o que está para dentro: a areia molhada da margem é da beira do rio.
    && (biome !== 'beach' || y < riverTop - 2);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const biome = tiles[y * W + x].biome;
      if (!entraNoMosaico(biome, x, y)) continue;
      let campo = campos.get(biome);
      if (!campo) campos.set(biome, campo = []);
      campo.push(mosaico(x, y));
    }
  }
  const corte = new Map<Biome, number>();
  for (const [biome, valores] of campos) {
    valores.sort((a, b) => a - b);
    const i = Math.min(valores.length - 1, Math.floor(valores.length * (1 - (FRACAO_PATCH[biome] ?? 0))));
    corte.set(biome, valores[i]);
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const t = tiles[y * W + x];
      const limiar = corte.get(t.biome);
      if (limiar === undefined || !entraNoMosaico(t.biome, x, y)) continue;
      if (mosaico(x, y) < limiar) continue;
      if (t.biome === 'forest' || t.biome === 'pinewood') {
        Object.assign(t, { kind: 'dirt', key: 'tile_ground_dirt_grasspatch' });
      } else if (t.biome === 'countryside') {
        Object.assign(t, { kind: 'dirt', key: 'tile_ground_dirt_drypatch' });
      } else if (t.biome === 'savanna') {
        Object.assign(t, { kind: 'grass', key: GRASS });
      } else if (t.biome === 'beach') {
        t.key = DUST;
      } else if (t.biome === 'desert') {
        t.key = DUNE;
      }
    }
  }

  // Paint exactly the planned lanes. Twin lanes never masquerade as T junctions.
  for (const y of ys) {
    for (let x = xs[0]; x <= xs[xs.length - 1] + 1; x++) {
      for (let lane = 0; lane < 2; lane++) {
        Object.assign(tiles[(y + lane) * W + x], {
          kind: 'road', key: 'tile_road_straight_SE_normal',
          lane: lane === 0 ? 'NW' : 'SE', bridge: false,
        });
      }
    }
  }
  xs.forEach((x, col) => {
    for (let y = ys[0]; y <= ys[ys.length - 1] + 1; y++) {
      if (!crossings.has(col) && y > northQuay + 1 && y < southQuay) continue;
      for (let lane = 0; lane < 2; lane++) {
        const t = tiles[y * W + x + lane];
        const junction = t.kind === 'road';
        const bridge = t.kind === 'water';
        Object.assign(t, {
          kind: 'road', bridge,
          lane: junction ? null : lane === 0 ? 'SW' : 'NE',
          key: junction ? 'tile_road_xsing_normal'
            : bridge ? 'tile_road_bridge_body_SW_normal' : 'tile_road_straight_SW_normal',
        });
      }
    }
  });
  ys.forEach((y, row) => xs.forEach((x, col) => {
    if ((row + col) % 3 !== 0) return;
    for (const [dx, dy] of [[-1, 0], [-1, 1], [2, 0], [2, 1], [0, -1], [1, -1], [0, 2], [1, 2]]) {
      const t = at(x + dx, y + dy);
      if (t?.kind === 'road' && t.lane && !t.bridge && !isNatural(t.biome)) {
        t.key = `tile_road_pelican_${t.lane}_normal`;
      }
    }
  }));

  // Avenida no meio do mato não é asfalto: dentro das reservas a mesma malha vira
  // estrada de terra, sem tinta de solo nem faixa de pedestre. O radar já puxa a
  // cor de terra de qualquer chave que contenha 'dirt'.
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const t = tiles[y * W + x];
      if (t.kind !== 'road' || t.bridge || !isNatural(t.biome)) continue;
      t.key = t.key.replace('tile_road_', 'tile_road_dirt_');
    }
  }

  // Reserve a continuous one-tile sidewalk, including diagonal corner squares,
  // BEFORE any lot, building, parking or decoration can claim the ground.
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const t = tiles[y * W + x];
      if (t.kind === 'road' || t.kind === 'water') continue;
      let beside = false;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) if (road(x + dx, y + dy)) beside = true;
      }
      if (beside) {
        walkway[y * W + x] = 1;
        // Na reserva não há meio-fio: a faixa ao lado da estrada de terra é o
        // próprio terreno. `walkway` continua marcando o corredor pedonal.
        if (isNatural(t.biome)) continue;
        t.kind = 'concrete';
        t.key = CONCRETE;
      }
    }
  }

  const reservePath = (r: Rect, natural = false) => eachCell(r, (x, y) => {
    const t = at(x, y);
    if (!t || t.kind === 'water' || t.kind === 'road' || walkway[y * W + x]) return;
    if (natural && !isNatural(t.biome)) return;
    walkway[y * W + x] = 1;
    // Trilha é o caminho seco dentro da reserva: terra na mata, areia pisada na
    // areia. O teste de mapa procura exatamente esta chave por bioma.
    Object.assign(t, natural ? trailGround(t.biome) : { kind: 'concrete', key: CONCRETE });
  });
  // Two-tile walking loops on the outside and a dry riverside promenade.
  reservePath({ x0: 3, x1: forestEast, y0: 3, y1: 5 }, true);
  reservePath({ x0: 3, x1: 5, y0: 3, y1: northQuay }, true);
  reservePath({ x0: 3, x1: W - 3, y0: H - 5, y1: H - 3 }, true);
  reservePath({ x0: W - 5, x1: W - 3, y0: southQuay + 2, y1: H - 3 }, true);
  reservePath({ x0: beachWest, x1: W - 3, y0: riverTop - 2, y1: riverTop }, true);

  // ---- Relevo: serra do lado de fora da cidade ----------------------------
  // Cidade é planície: asfalto, passeio, lote, prédio e porta de interior pisam todos
  // no nível zero. Relevo é o que existe do lado de fora do perímetro urbano, e é um
  // campo contínuo de altura em tiles (com casa decimal), não degrau empilhado: a
  // encosta se lê pela sombra que o GroundLayer pinta por cima do losango, como em
  // mapa topográfico. Para a montanha nunca acordar um paredão encostado na rua, cada
  // tile tem um teto de declive sobre o vizinho mais baixo — apertado perto do asfalto
  // e da água, largo só no coração da reserva.
  // `relief` e o teto de cada reserva vêm declarados lá em cima, onde o mesmo campo
  // decidiu as manchas de albedo: cor do chão e altura do chão são a mesma montanha.
  const MAX_ELEV = GAME_CONFIG.TERRAIN_MAX_ELEVATION;
  const MAX_SLOPE = GAME_CONFIG.TERRAIN_MAX_SLOPE_TILES;
  /** Crista provável por bioma, em tiles. Mata e pinhal são serra; o resto é morro. */
  const RESERVE_PEAK: Partial<Record<Biome, number>> = {
    pinewood: MAX_ELEV, forest: 2.6, desert: 1.9, countryside: 1.5, savanna: 1.1, beach: 0.5,
  };
  const naturalTile = (i: number) => isNatural(tiles[i].biome);
  /** Chão que se pisa e leito: a cota deles é o zero do mundo, sempre. */
  const flatTile = (i: number) => !naturalTile(i) || tiles[i].kind === 'water';
  const DIRS4: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const DIAS4: [number, number][] = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
  const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
  const suave = (v: number) => v * v * (3 - 2 * v);
  /**
   * Distância de Manhattan (duas varreduras, exata e barata) até a semente: é a
   * medida da rampa, porque montanha que começa no tile vizinho ao asfalto é muro.
   */
  const manhattan = (isSource: (i: number) => boolean) => {
    const far = W + H;
    const d = new Uint16Array(W * H).fill(far);
    for (let i = 0; i < W * H; i++) if (isSource(i)) d[i] = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (y > 0) d[i] = Math.min(d[i], d[i - W] + 1);
        if (x > 0) d[i] = Math.min(d[i], d[i - 1] + 1);
      }
    }
    for (let y = H - 1; y >= 0; y--) {
      for (let x = W - 1; x >= 0; x--) {
        const i = y * W + x;
        if (y < H - 1) d[i] = Math.min(d[i], d[i + W] + 1);
        if (x < W - 1) d[i] = Math.min(d[i], d[i + 1] + 1);
      }
    }
    return d;
  };
  const toCity = manhattan((i) => !naturalTile(i));
  const toWater = manhattan((i) => tiles[i].kind === 'water');
  /** Distância à borda do mapa: o maciço tem de morrer antes do fim do mundo. */
  const edgeAt = (i: number) => {
    const x = i % W;
    const y = (i - x) / W;
    return Math.min(x, y, W - 1 - x, H - 1 - y) + 1;
  };
  const heights = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const t = tiles[i];
      if (flatTile(i)) continue;
      // Espessura do maciço: mato colado na cidade ou na borda do mapa tem direito a um
      // morro, não a uma cordilheira. As duas janelas são a mesma pergunta (quanto mato
      // tem atrás), então é o mínimo delas, não o produto — multiplicar envelope derruba
      // a crista para 60% do teto e serra de 256px vira colina de 150.
      const corpo = Math.min(
        clamp01(edgeAt(i) / 6),
        // Rampa de aproximação: zero no passeio, amplitude cheia ~7 tiles dentro do
        // mato. Curta de propósito, e o que ela aperta é o declive: a encosta íngreme é
        // o que faz a montanha se ler como montanha.
        suave(clamp01((toCity[i] - 2) / 5)),
      );
      // No pé do morro o chão abre até a beira da água, mas abre em rampa e nunca a zero:
      // a 2 tiles da margem ainda sobra morro, e é o que impede o rio de correr dentro de
      // um degrau.
      const vale = 0.4 + 0.6 * suave(clamp01((toWater[i] - 2) / 6));
      const n = t.biome === 'pinewood' || t.biome === 'forest'
        ? clamp01(relief(x, y) * 2.1 - 0.55)
        : clamp01(relief(x, y) * 1.35 - 0.18);
      // Crista comprida e vale largo: a curva em S achata os dois extremos e concentra a
      // descida no meio da encosta — é o perfil de serra de mapa, topo plano, flanco
      // contínuo, pé aberto. A raiz quadrada fazia o contrário: levantava o vale até
      // quase o topo e sobrava uma parede estreita entre um buraco e outro, que é favo,
      // não montanha.
      const crista = suave(n);
      heights[i] = Math.min(RESERVE_PEAK[t.biome] ?? 0, MAX_ELEV) * corpo * vale * crista;
    }
  }
  /**
   * Média binomial 3x3. O FBM já é contínuo, mas o encontro das três oitavas deixa
   * dente de um tile, e dente de um tile é o que ainda se leria como bloco. Cidade e
   * água entram na média como zero, então o maciço sempre amolece ao encostar no
   * asfalto — a planície urbana é causa do relevo, não consequência dele.
   */
  const borrar = (passos: number) => {
    const tmp = new Float32Array(W * H);
    for (let p = 0; p < passos; p++) {
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const i = y * W + x;
          if (pin[i]) continue;
          let soma = heights[i] * 4;
          let peso = 4;
          for (const [dx, dy] of DIRS4) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
            soma += heights[ny * W + nx] * 2;
            peso += 2;
          }
          for (const [dx, dy] of DIAS4) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
            soma += heights[ny * W + nx];
            peso += 1;
          }
          tmp[i] = soma / peso;
        }
      }
      heights.set(tmp);
    }
  };
  /**
   * Teto de declive por tile: quanto ele pode subir em relação ao vizinho mais baixo.
   * Encosta de montar perto da cidade, da água e do que o pé e a roda pisam (rua,
   * trilha, clareira de prédio); no fundo da reserva o teto é o que a projeção ainda
   * desenha como encosta (TERRAIN_MAX_SLOPE_TILES) — passar disso não faz montanha mais
   * alta, faz losango invertido, que é a cara de pilha de bloco. A regra só rebaixa,
   * então a crista fica onde está e o que sai é o paredão solto.
   */
  const macio = new Uint8Array(W * H); // via, trilha e clareira: o chão que se pisa
  const pin = new Uint8Array(W * H);   // cota travada: cidade, água e base de prédio
  for (let i = 0; i < W * H; i++) {
    if (tiles[i].kind === 'road' || walkway[i]) macio[i] = 1;
    if (flatTile(i)) pin[i] = 1;
  }
  const budget = new Float32Array(W * H);
  const montarTeto = () => {
    const toMacio = manhattan((i) => macio[i] === 1 || pin[i] === 1);
    for (let i = 0; i < W * H; i++) {
      if (pin[i]) {
        budget[i] = 0;
        continue;
      }
      const perto = Math.min(toCity[i], toWater[i]);
      const solta = perto <= 2 ? 0.07 : perto <= 6 ? 0.16 : perto <= 10 ? 0.24 : MAX_SLOPE;
      // Perto da via o teto é o que a roda ainda sobe (TERRAIN_STEP_UP_VEHICLE), não o que
      // o olho aceita: a faixa de 0,14 antiga era tão mansa que a reserva inteira, costurada
      // de trilhas, ficava sem encosta nenhuma. Estrada inclinada é pedido do §1.
      const d = toMacio[i];
      const via = d <= 1 ? 0.2 : d <= 2 ? 0.26 : MAX_SLOPE;
      budget[i] = Math.min(solta, via);
    }
  };
  const aparar = () => {
    for (let round = 0; round < 16; round++) {
      let moved = false;
      for (let sweep = 0; sweep < 2; sweep++) {
        for (let yy = 0; yy < H; yy++) {
          for (let xx = 0; xx < W; xx++) {
            const y = sweep ? H - 1 - yy : yy;
            const x = sweep ? W - 1 - xx : xx;
            const i = y * W + x;
            const teto = budget[i];
            if (teto <= 0) continue;
            let baixo = heights[i];
            for (const [dx, dy] of DIRS4) {
              const nx = x + dx;
              const ny = y + dy;
              if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
              const v = heights[ny * W + nx];
              if (v < baixo) baixo = v;
            }
            const alvo = baixo + teto;
            if (alvo < heights[i] - 1e-6) {
              heights[i] = alvo;
              moved = true;
            }
          }
        }
      }
      if (!moved) break;
    }
  };
  /**
   * O asfalto é nivelado ATRAVÉS da própria largura.
   *
   * Uma rua que sobe a serra no sentido do tráfego é estrada de montanha: é pedido do §1
   * e é o que faz o relevo entrar no mapa sem brigar com ele. Uma rua que sobe de uma
   * faixa para a outra não é nada — é rua torta. O carro troca de faixa e encara um
   * ressalto, o NPC na calçada vê o passeio em rampa, e o jogador lê exatamente
   * "o relevo está atrapalhando o mapa". Medido antes desta regra: dos ressaltos que o
   * relevo punha no asfalto da reserva, metade corria através das faixas (p90 0,20).
   *
   * Então cada corte perpendicular ao eixo da via vira uma tira de nível: a tira inteira
   * desce ao nível do seu tile mais baixo. O declive ao longo do eixo fica inteiro, e a
   * estrada continua subindo o morro — só sobe deitada sobre a própria largura, como
   * qualquer estrada de verdade.
   */
  const nivelarFaixa = () => {
    const eixoDaVia = (i: number): 'x' | 'y' | null => {
      const lane = tiles[i].lane;
      // Na projeção iso, andar em +x desce para a direita na tela: SE/NW é tráfego em x,
      // SW/NE é tráfego em y. A tira de nível é o corte do outro lado.
      if (!lane) return null;
      return lane === 'SE' || lane === 'NW' ? 'x' : 'y';
    };
    const asfalto = (x: number, y: number) =>
      x >= 0 && y >= 0 && x < W && y < H && tiles[y * W + x].kind === 'road';
    /**
     * Em cruzamento e na ponta da rua o tile não tem `lane`. O eixo vem então da própria
     * topologia do asfalto: por onde ele continua é o sentido do tráfego, e o outro lado é
     * a largura da pista. Empate é nó — não se corta um nó, e errar aqui é pior que deixar
     * o tile de fora: foi exatamente um tile de eixo chutado que deixou 1,36 tiles de muro
     * no meio da via na primeira versão desta regra.
     */
    const eixoEm = (x: number, y: number): 'x' | 'y' | null => {
      const proprio = eixoDaVia(y * W + x);
      if (proprio) return proprio;
      const emX = (asfalto(x - 1, y) ? 1 : 0) + (asfalto(x + 1, y) ? 1 : 0);
      const emY = (asfalto(x, y - 1) ? 1 : 0) + (asfalto(x, y + 1) ? 1 : 0);
      if (emX === emY) return null;
      return emX > emY ? 'x' : 'y';
    };
    // Faixa = a seção transversal completa. A varredura não para em tile já visitado:
    // parar ali cria buraco na tira, e buraco na tira é trecho de rua sem dono.
    const dono = new Int32Array(W * H).fill(-1);
    const bandas: number[][] = [];
    const registradas = new Set<number>();
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (!asfalto(x, y)) continue;
        const i = y * W + x;
        if (dono[i] >= 0) continue;
        const eixo = eixoEm(x, y);
        // Nó sem eixo: faixa de um tile só. Continua sob teto de declive, só não nivela.
        const faixa = [i];
        if (eixo) {
          const [dx, dy] = eixo === 'x' ? [0, 1] : [1, 0];
          for (const sentido of [-1, 1]) {
            let nx = x + dx * sentido;
            let ny = y + dy * sentido;
            while (asfalto(nx, ny) && eixoEm(nx, ny) === eixo) {
              faixa.push(ny * W + nx);
              nx += dx * sentido;
              ny += dy * sentido;
            }
          }
          const chave = Math.min(...faixa);
          if (registradas.has(chave)) continue;
          registradas.add(chave);
        }
        const id = bandas.push(faixa) - 1;
        for (const j of faixa) dono[j] = id;
      }
    }
    // Teto de declive ao longo da pista. É o mesmo 0,2 que o teto geral já dava à via:
    // margem sobre os 0,34 da roda, e suficiente para a estrada subir a serra de verdade.
    const TETO_FAIXA = 0.2;
    for (let rodada = 0; rodada < 400; rodada++) {
      let mexeu = false;
      // (1) Nivelar: a faixa inteira desce ao seu próprio mínimo. Nunca sobe — subir uma
      // tira é o que empurrou o degrau entre faixas a 0,40 quando se tentou pela média.
      for (const faixa of bandas) {
        let m = Infinity;
        for (const i of faixa) if (heights[i] < m) m = heights[i];
        for (const i of faixa) {
          if (heights[i] > m + 1e-6) { heights[i] = m; mexeu = true; }
        }
      }
      // (2) Aparar: a faixa é um nó na rede do `aparar` — se um tile da tira encara chão
      // mais baixo, a tira inteira des junto, e o nivelar de cima continua valendo.
      for (let f = 0; f < bandas.length; f++) {
        const faixa = bandas[f];
        const nivel = heights[faixa[0]];
        let piso = Infinity;
        for (const i of faixa) {
          const x = i % W;
          const y = (i - x) / W;
          for (const [dx, dy] of DIRS4) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
            const j = ny * W + nx;
            if (dono[j] === f) continue;
            if (heights[j] < piso) piso = heights[j];
          }
        }
        if (piso === Infinity) continue;
        const alvo = piso + TETO_FAIXA;
        if (nivel > alvo + 1e-6) {
          for (const i of faixa) heights[i] = alvo;
          mexeu = true;
        }
      }
      if (!mexeu) break;
    }
    // Travado: o que vem depois (borrar, aparar) ajusta o mato ao asfalto, nunca o
    // contrário. Sem isto a próxima passada de sombra desfaz a tira no primeiro flanco.
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (tiles[i].kind !== 'road') continue;
        pin[i] = 1;
        macio[i] = 1;
        budget[i] = 0;
      }
    }
  };
  montarTeto();
  // Uma passada só. Cada `borrar` é um 3x3 binomial (σ ≈ 0,7 tile), e a serra que cabe no
  // quadro da câmera tem crista e vale a cada ~5 tiles: cinco passadas somadas apagavam
  // justamente essa escala e sobrava um piso ondulado, com meio tile de salto por ladeira.
  borrar(1);
  aparar();

  // Deterministic civic reservations guarantee services in their mapped districts.
  for (const [name, biome, targetX, targetY] of [
    ['bld_hospital_a', 'commercial', 0.57, 0.35],
    ['bld_policestation_a', 'downtown', 0.44, 0.35],
    ['bld_policestation_a', 'downtown', 0.44, 0.73],
    ['bld_policestation_a', 'suburb', 0.85, 0.73],
    // Bombeiros: o catálogo já tinha o prédio, a arte e o `kind` no Map, mas nenhuma reserva o
    // plantava — o glifo existia no registro de pontos de interesse e o mundo nunca tinha o
    // lugar. O alvo é o lado leste da faixa baixa ao sul do rio, a mesma margem da esquadra de
    // 0,44 mas a uma quadra dela, porque serviço de emergência colado no outro emerge um prédio
    // só na leitura do mapa.
    ['bld_firestation_a', 'downtown', 0.62, 0.73],
    ['bld_gunshop_a', 'commercial', 0.66, 0.35],
    // Rodoviária: o lote cívico do ônibus. O alvo é a franja oeste da faixa comercial ao
    // norte do rio, longe do hospital e da loja de armas, para a quadra sorteada não ser a
    // mesma que já reservou um serviço — a tabela reserva em ordem, e `!b.special` no filtro
    // de candidatos é o que impede dois prédios cívicos de dividirem a mesma quadra.
    ['bld_busstation_a', 'commercial', 0.28, 0.35],
  ] as const) {
    const entry = BUILDING_CATALOG.find((e) => e.name === name);
    const candidates = blocks.filter((b) => b.biome === biome && !b.special &&
      (targetY < 0.5 ? b.y1 <= northQuay : b.y0 >= southQuay + 2));
    candidates.sort((a, b) =>
      Math.hypot((a.x0 + a.x1) / 2 - W * targetX, (a.y0 + a.y1) / 2 - H * targetY)
      - Math.hypot((b.x0 + b.x1) / 2 - W * targetX, (b.y0 + b.y1) / 2 - H * targetY));
    if (!entry || !candidates.length) throw new Error(`No civic lot for ${name}`);
    candidates[0].special = entry;
    // A rodoviária é a única reserva que leva a quadra inteira, não um lote dentro dela:
    // `terminal` é o que faz o laço de quadras pular o loteamento e o passo do pátio nascer.
    if (name === 'bld_busstation_a') candidates[0].terminal = true;
  }

  const commitBuilding = (entry: BuildingCatalogEntry, x: number, y: number) => {
    // South-point convention: footprintH is visual height, never ground depth.
    const r = { x0: x - entry.footprintW, y0: y - entry.footprintW, x1: x, y1: y };
    if (buildings.length >= MAX_BUILDINGS || !clearRect(r)) return false;
    occupy(r);
    buildings.push({ key: entry.name, x, y, footprintW: entry.footprintW, footprintH: entry.footprintH, tag: entry.tag });
    return true;
  };
  const propCounts: Record<PropBudget, number> = { urban: 0, fences: 0, forestTrees: 0, forestDetails: 0,
    countryside: 0, beach: 0, pinewood: 0, savanna: 0, desert: 0, serra: 0 };
  const addProp = (key: string, x: number, y: number, budget: PropBudget = 'urban') => {
    const r = { x0: x - 0.3, y0: y - 0.3, x1: x + 0.3, y1: y + 0.3 };
    if (props.length >= MAX_PROPS || propCounts[budget] >= PROP_BUDGET[budget] || !clearRect(r)) return;
    occupy(r);
    props.push({ key, x, y });
    propCounts[budget]++;
  };
  const fenceLots: { home: PlacedBuilding; block: Block }[] = [];
  let ruralHomes = 0;
  const urbanSites: { key: string; x: number; y: number }[] = [];
  const parkingSlots: Point[] = [];
  /**
   * Qual quadra ganha rua local. É a metade leste do corredor pedonal que o gerador já
   * protegia virando asfalto de bairro, então a pergunta é de vizinhança, não de desenho:
   * uma coluna sim serve duas, os lotes continuam dos dois lados, e o grafo dirigido só
   * aceita quem atravessa de avenida a avenida. Fica de fora o que não tem fachada para
   * servir: quadra cívica (o prédio ancorado em `cx - 1.4` comeria a calçada nova),
   * parque, zona portuária e as quadras de armazém, cujo lote de 3 tiles não cabe em uma
   * faixa de 2,7. `access` não aparece aqui de propósito: acesso é derivação sem saída,
   * e este mapa proibe faixa sem saída — quem criar a instalação carimba o acesso junto.
   */
  const ruaDe = (b: Block): RoadRank | null => {
    if (b.special || b.col % 2 !== 1) return null;
    const rank = b.biome === 'downtown' || b.biome === 'commercial' || b.biome === 'market' ? 'street'
      : b.biome === 'residential' || b.biome === 'suburb' ? 'residential' : null;
    if (!rank) return null;
    // O nome do bairro não basta: na orla e nas costuras do mosaico o bioma troca de
    // célula em célula, e uma célula de reserva no corredor faria nascer asfalto sobre a
    // terra batida da mata e calçada de concreto onde o pedestre pisa areia. Varre as
    // quatro células do corredor — passeio, duas faixas, passeio — dentro da quadra. Quem
    // já é via fica de fora: a boca encostada na avenida é asfalto por contrato.
    const meio = Math.round((b.x0 + b.x1) / 2);
    for (let y = b.y0; y < b.y1; y++) {
      for (let x = meio - 2; x <= meio + 1; x++) {
        const t = at(x, y);
        if (t?.kind !== 'road' && isNatural(t?.biome ?? 'forest')) return null;
      }
    }
    return rank;
  };
  type Rua = { x: number; y0: number; y1: number; sul: number; norte: number;
    row: number; col: number; rank: RoadRank };
  const ruas: Rua[] = [];
  for (const b of blocks) {
    const cx = (b.x0 + b.x1) / 2;
    const cy = (b.y0 + b.y1) / 2;
    const left = b.x0 + 1 + SETBACK;
    const right = b.x1 - 1 - SETBACK;
    const top = b.y0 + 1 + SETBACK;
    const bottom = b.y1 - 1 - SETBACK;
    const industrial = b.biome === 'industrial' || b.biome === 'docks';
    const natural = isNatural(b.biome);
    const hasParking = !b.special && !natural && b.biome !== 'park' && (industrial || (b.row + b.col) % 2 === 0);
    const street = natural ? null : ruaDe(b);
    // Meia-largeza do corredor, em tiles: 1 é a travessa pedonal de sempre; 2 acrescenta
    // o passeio dos dois lados da rua nova. É a única forma de a calçada nascer de
    // concreto — a varredura que paveia o passeio do mapa inteiro já rodou.
    const faixa = street ? 2 : 1;
    // Do muro até o passeio. Sem rua a borda é a travessa de sempre; com rua o lote
    // encosta no passeio novo, e é dali que o recuo de 0,65 é medido.
    const Oeste = street ? cx - faixa - SETBACK : cx - 1;
    const Leste = street ? cx + faixa + SETBACK : cx + 1;
    // Every court has an unobstructed two-tile entrance between the front lots.
    reservePath({ x0: cx - faixa, x1: cx + faixa, y0: b.y0, y1: b.y1 }, natural);
    if (street) {
      ruas.push({ x: cx - 1, y0: b.y0, y1: b.y1, sul: ys[b.row], norte: ys[b.row + 1],
        row: b.row, col: b.col, rank: street });
    }
    if (natural) {
      reservePath({ x0: b.col === 0 ? 3 : b.x0, x1: b.col === xs.length - 2 ? W - 3 : b.x1,
        y0: cy - 1, y1: cy + 1 }, true);
      if (b.row === 0) reservePath({ x0: cx - 1, x1: cx + 1, y0: 3, y1: b.y0 }, true);
      if (b.row === ys.length - 2) reservePath({ x0: cx - 1, x1: cx + 1, y0: b.y1, y1: H - 3 }, true);
      if (b.biome === 'beach') reservePath({ x0: cx - 1, x1: cx + 1, y0: b.y1, y1: riverTop }, true);
      // Reserva não é terreno vazio para sempre: uma quadra da mata e do campo, ou a
      // terceira quadra da areia e da savana, cria o seu morador, e a casa fica
      // espaçada do vizinho.
      // As trilhas já foram reservadas acima, então `clearRect` recusa o lote que
      // tapasse caminho — o sítio só nasce onde sobra clareira.
      const every = b.biome === 'beach' || b.biome === 'savanna'
        ? RURAL_BLOCK_EVERY_SMALL_RESERVE : RURAL_BLOCK_EVERY;
      if (ruralHomes < MAX_RURAL_BUILDINGS && (b.col * 7 + b.row * 13) % every === 0) {
        const rural = blockPalette(b.biome, rng);
        if (rural) {
          const lots = 1 + Math.floor(rng() * 3);
          let lastFamily = '';
          for (let i = 0; i < lots; i++) {
            const entry = rural.draw(lastFamily);
            if (!commitBuilding(entry, left + rural.size + i * (rural.size + 1.3), top + rural.size)) continue;
            ruralHomes++;
            lastFamily = familyOf(entry.name);
          }
        }
      }
      continue; // O resto da reserva continua mato: nem prédio nem vaga de carro.
    }
    if (hasParking) {
      for (const [x0, x1] of [[b.x0 + 2, cx - faixa], [cx + faixa, b.x1 - 2]]) {
        eachCell({ x0, x1, y0: b.y1 - 5, y1: b.y1 - 2 }, (x, y) => {
          parking[y * W + x] = 1;
          Object.assign(tiles[y * W + x], { kind: 'concrete', key: ASPHALT });
        });
        for (const y of [b.y1 - 4.3, b.y1 - 2.7]) parkingSlots.push({ x: (x0 + x1) / 2, y });
      }
      // Open side forecourts act as driveways; sidewalks remain continuous concrete.
      for (const [x0, x1] of [[b.x0, cx - faixa], [cx + faixa, b.x1]]) {
        eachCell({ x0, x1, y0: b.y1 - 4, y1: b.y1 - 3 }, (x, y) => {
          Object.assign(tiles[y * W + x], { kind: 'concrete', key: CONCRETE });
        });
      }
    }

    const palette = blockPalette(b.biome, rng);
    if (b.special) {
      // Beside, not across, the court's central pedestrian entrance. A rodoviária não tem
      // "ao lado do corredor": o corredor é a pista dela. O hall vai para a franja leste do
      // lote e o resto da quadra é pátio — see o passo do terminal abaixo do laço de ruas.
      const anchorX = b.terminal ? cx + 5 : cx - 1.4;
      if (!commitBuilding(b.special, anchorX, bottom)) throw new Error(`Blocked civic lot: ${b.special.name}`);
    }
    if (palette && !b.terminal) {
      const size = palette.size;
      let lastFamily = '';
      const firstY = top + size; // South-point anchor, not visual sprite height.
      const lastY = hasParking ? b.y1 - 5 - SETBACK : bottom;
      // Quadra fechada: a fileira nasce encostada na calçada e a próxima vizinha fica
      // a um junta de distância, então a empenada da rua lê como uma parede só. Entre
      // duas fileiras sobra o beco, largo o bastante para o halo de 0.2 das colisões
      // deixar uma célula de passagem livre e seca atrás de cada fachada.
      const alley = size >= 3 ? 1.5 : size === 2 ? 1.3 : 1.4;
      const join = size >= 3 ? 0.6 : size === 2 ? 0.3 : 0.28;
      // A primeira faixa do subúrbio é quintal, não beco: funda o bastante para a
      // cerca com portão da casa da esquina e ainda assim deixar o pátio seco.
      const yardPad = size === 1 && (b.biome === 'residential' || b.biome === 'suburb') ? 1.05 : 0;
      const rowY = (row: number) => firstY + row * (size + alley) + (row ? yardPad : 0);
      const rows = Math.max(1, 1 + Math.floor((lastY - firstY - yardPad) / (size + alley)));
      for (let row = 0; row < rows; row++) {
        const y = rowY(row);
        // Os lotes vão até a borda do corredor protegido (`Oeste`/`Leste`), nunca além: a
        // cobertura do céu da quadra continua sendo a entrada pedonal oficial, e com rua
        // nasce aí o passeio — o recuo de 0,65 é medido a partir dele, não do eixo.
        for (const [start, end] of [[left, Oeste], [Leste, right]]) {
          // A casa do quintal fica isolada na fileira da frente: sem folga lateral a
          // cerca do vizinho reclama os painéis e a quadra vira um quintal só.
          const side = row === 0 && yardPad ? 1.25 : join;
          const count = Math.min(4, Math.floor((end - start + side) / (size + side)));
          for (let i = 0; i < count; i++) {
            // Um sorteio por lote, não por fileira: a parede da rua continua reta
            // porque a largura é da quadra, mas nenhuma fachada repete a vizinha.
            const entry = palette.draw(lastFamily);
            if (!commitBuilding(entry, start + size + i * (size + side), y)) continue;
            lastFamily = familyOf(entry.name);
            if (row === 0 && i === 0 && entry.tag.startsWith('house_') && yardPad > 0) {
              fenceLots.push({ home: buildings[buildings.length - 1], block: b });
            }
          }
        }
      }
      // Depois das fachadas, o que sobrou entre duas fileiras vira beco pavimentado:
      // só recebem asfalto as células cujo centro fica livre do halo de colisão, e o
      // walkway impede que um entulho tape a única passagem de quem mora atrás.
      for (let row = yardPad ? 2 : 1; row < rows; row++) {
        const gapTop = rowY(row - 1); // Borda sul da fileira anterior.
        const gapBottom = rowY(row) - size; // Borda norte desta.
        for (let y = Math.ceil(gapTop - 0.2); y + 0.5 <= gapBottom - 0.3; y++) {
          for (let x = Math.ceil(left); x < Math.floor(right); x++) {
            // O beco para no passeio da rua: asfalto de beco por cima de via e calçada
            // novas sumiria com o traçado, e a célula da via não pode ser passeio.
            if (x >= cx - faixa && x < cx + faixa) continue;
            walkway[y * W + x] = 1;
            Object.assign(tiles[y * W + x], { kind: 'concrete', key: ASPHALT });
          }
        }
      }
    }
    if (b.terminal) {
      // A quadra inteira é do terminal: sem fileira de lotes não há beco nem quintal, e a
      // árvore de sempre cairia em cima da plataforma. O que sobra de lote a oeste do pátio
      // é a praça de espera do hall, e ela só recebe poste — a três tiles da faixa mais
      // perto, para o halo de 0,3 não raspar nem o passeio nem o recuo do salão.
      for (const y of [b.y0 + 3, cy, b.y1 - 5]) {
        urbanSites.push({ key: 'prop_lightpole_a', x: cx - 4, y });
      }
      continue;
    }
    const tree = b.biome === 'park' || b.biome === 'suburb'
      ? 'prop_tree_common_medium' : 'prop_tree_pine_small';
    for (const x of [cx - 2.3, cx + 2.3]) {
      for (const y of [cy - 1.3, cy + 1.3]) urbanSites.push({ key: tree, x, y });
    }
    if (b.biome === 'park') {
      for (const x of [left + 1, right - 1]) {
        for (const y of [top + 1, bottom - 1]) urbanSites.push({ key: 'prop_tree_common_large', x, y });
      }
    } else {
      // O poste fica no lote, encostado no passeio: com rua, a célula cx+1 é calçada e
      // objeto nenhum pisa calçada; sem rua, é a mesma borda de sempre. Os 0,02 de folga
      // dos dois lados são o halo de 0,3 do prop não raspando nem o passeio nem o recuo
      // de 0,65 do lote vizinho, que chegaria a flutuar no concreto.
      urbanSites.push({ key: 'prop_lightpole_a', x: cx + 2.32, y: bottom - 0.1 });
    }
  }
  /**
   * A rua local existe no chão a partir do corredor que o laço de quadras acabou de
   * proteger: asfalto de bairro ligado de avenida a avenida, na única forma que o grafo
   * dirigido aceita neste mapa — mão dupla em faixas separadas, a oeste descendo (+y) e a
   * leste subindo (−y) — e com caixa de cruzamento de 2×2 nas duas bocas, do mesmo
   * desenho que se usa onde uma avenida cruza a outra. Nenhuma célula aqui é coordenada
   * escrita à mão: tudo vem do que `ruaDe` escolheu quadra a quadra.
   */
  const POSTOS: RoadRank[] = ['avenue', 'highway', 'street', 'residential', 'access'];
  // O valor guardado é o índice, e zero é "ainda sem posto" — por isso `avenue` mora no
  // índice 0 e só é carimbada pelo else do laço de hierarquia, nunca por aqui.
  const ACESSO = POSTOS.indexOf('access');
  const posto = new Uint8Array(W * H); // índice em POSTOS; 0 = ainda sem posto
  // O pavimento continua sendo decisão do bioma de cada tile, não da rua: na boca norte
  // de um subúrbio que encosta na orla, a avenida ali já é terra batida, e a caixa de
  // cruzamento que ela empresta à rua tem que nascer com o mesmo pavimento. É exatamente
  // a regra que a varredura de avenidas aplica dentro da reserva.
  const chave = (i: number, desenho: string) =>
    `tile_road_${isNatural(tiles[i].biome) ? 'dirt_' : ''}${desenho}_normal`;
  for (const r of ruas) {
    for (let y = r.y0; y < r.y1; y++) {
      for (const [x, lane] of [[r.x, 'SW'], [r.x + 1, 'NE']] as [number, Dir4][]) {
        const i = y * W + x;
        // O beco e o corredor pedonal marcaram estas células como passeio. Via não é
        // passeio: deixá-las marcadas é o que faria um NPC nascer no meio do trânsito.
        walkway[i] = 0;
        parking[i] = 0;
        posto[i] = r.rank === 'street' ? 2 : 3;
        Object.assign(tiles[i], { kind: 'road', key: chave(i, 'straight_SW'),
          lane, bridge: false });
      }
    }
    // Nas bocas o asfalto da avenida entra dentro do cruzamento: as quatro células que
    // ela tinha ali perdem a faixa e quem chega decide o rumo lá dentro, igual a um
    // cruzamento de avenida com avenida.
    for (const [y, linha] of [[r.sul, r.row], [r.norte, r.row + 1]] as [number, number][]) {
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const i = (y + dy) * W + r.x + dx;
          Object.assign(tiles[i], { kind: 'road', key: chave(i, 'xsing'),
            lane: null, bridge: false });
        }
      }
      // Travessia na boca, no mesmo ritmo do grid de avenidas: a mesma quadra que tem
      // faixa no cruzamento grande tem na boca da sua rua, e a cidade não fica metade
      // sinalizada.
      if ((linha + r.col) % 3 !== 0) continue;
      for (const [dx, dy] of [[-1, 0], [-1, 1], [2, 0], [2, 1], [0, -1], [1, -1], [0, 2], [1, 2]]) {
        const t = at(r.x + dx, y + dy);
        if (t?.kind === 'road' && t.lane && !t.bridge && !isNatural(t.biome)) {
          t.key = `tile_road_pelican_${t.lane}_normal`;
        }
      }
    }
  }

  /**
   * A quadra da rodoviária deixa de ser lote cívico com um prédio no meio e vira pátio
   * exclusivo. O desenho é o de uma rodoviária de cidade média, e cada medida vem da quadra,
   * nunca de uma coordenada escrita à mão:
   *
   * - boca de 2×2 na avenida do norte, do mesmo traçado da rua local, com a zebra por fora
   *   para quem chega a pé;
   * - duas faixas paralelas dentro da quadra — a oeste desce, a leste sobe — que são a via de
   *   mão dupla por onde o ônibus entra, encosta na plataforma e sai;
   * - caixa de manobra 2×2 no fundo: é o virador de terminal, e é nela que a linha nasce e
   *   morre, com calçada dos dois lados porque o embarque acontece nos dois sentidos;
   * - plataforma de embarque (concreto) colada em cada faixa e pista de manobra (asfalto) uma
   *   faixa além; as duas entram no grafo pedonal, então o passageiro anda até o ponto e o
   *   loteador entende que ali não sobra terreno;
   * - o posto `access`, carimbado aqui e não no grid: acesso é derivação, e este mapa só a
   *   aceita com a instalação que a justifica. Esta é a primeira instalação do mapa.
   */
  for (const b of blocks.filter((q) => q.terminal)) {
    const cx = (b.x0 + b.x1) / 2;
    const boca = ys[b.row];
    const virada = b.y1 - 4;
    const posse = (x: number, y: number) => { tiles[y * W + x].terminal = true; };
    for (let y = b.y0; y < virada; y++) {
      for (const [x, lane] of [[cx - 1, 'SW'], [cx, 'NE']] as [number, Dir4][]) {
        const i = y * W + x;
        walkway[i] = 0;
        parking[i] = 0;
        posto[i] = ACESSO;
        posse(x, y);
        Object.assign(tiles[i], { kind: 'road', key: chave(i, 'straight_SW'),
          lane, bridge: false });
      }
    }
    for (const [x, plataforma] of [[cx - 2, true], [cx + 1, true],
      [cx - 3, false], [cx + 2, false]] as [number, boolean][]) {
      for (let y = b.y0; y <= virada + 1; y++) {
        const i = y * W + x;
        // A boca empresta as duas colunas do meio à avenida; o que está sendo calçado aqui
        // não pode ser via, senão o passeio nasce por cima do asfalto do cruzamento.
        if (tiles[i].kind === 'road') continue;
        parking[i] = 0;
        walkway[i] = 1;
        posse(x, y);
        Object.assign(tiles[i], { kind: 'concrete', key: plataforma ? CONCRETE : ASPHALT });
      }
    }
    for (let dy = 0; dy < 2; dy++) {
      for (let dx = 0; dx < 2; dx++) {
        const x = cx - 1 + dx, y = virada + dy;
        const i = y * W + x;
        walkway[i] = 0;
        parking[i] = 0;
        posto[i] = ACESSO;
        posse(x, y);
        Object.assign(tiles[i], { kind: 'road', key: chave(i, 'xsing'),
          lane: null, bridge: false });
      }
    }
    // A boca perde a faixa e ganha o rumo de quem decide: as quatro células que a avenida tinha
    // ali viram caixa, igual ao que a rua local faz na sua ponta. Ficar sem caixa faria do
    // pátio um beco dentro de uma arterial — e beco o grafo dirigido não aceita.
    for (let dy = 0; dy < 2; dy++) {
      for (let dx = 0; dx < 2; dx++) {
        const i = (boca + dy) * W + cx - 1 + dx;
        Object.assign(tiles[i], { kind: 'road', key: chave(i, 'xsing'),
          lane: null, bridge: false });
      }
    }
    for (const [dx, dy] of [[-1, 0], [-1, 1], [2, 0], [2, 1], [0, -1], [1, -1], [0, 2], [1, 2]]) {
      const t = at(cx - 1 + dx, boca + dy);
      if (t?.kind === 'road' && t.lane && !t.bridge && !isNatural(t.biome)) {
        t.key = `tile_road_pelican_${t.lane}_normal`;
      }
    }
  }

  // Todo tile de estrada recebe o seu posto na hierarquia, e a regra é a geometria que o
  // gerador usou acima, não uma lista de coordenadas. Espinha do mapa: as colunas que têm
  // ponte sobre o rio e as avenidas das duas margens — é por aí que se viaja de ponta a
  // ponta e onde um ônibus faz velocidade. Miúdo: as ruas que acabaram de nascer. O resto
  // do grid primário é avenida. `access` só aparece onde o passo do terminal carimbou: é a
  // derivação daquela instalação, não uma rua que o gerador inventou no meio de um lote.
  const espinhaCol = new Set<number>();
  for (const col of crossings) espinhaCol.add(xs[col]).add(xs[col] + 1);
  const espinhaRow = new Set<number>([northQuay, northQuay + 1, southQuay, southQuay + 1]);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const t = tiles[i];
      if (t.kind !== 'road') continue;
      t.rank = posto[i] ? POSTOS[posto[i]]
        : espinhaCol.has(x) || espinhaRow.has(y) ? 'highway' : 'avenue';
    }
  }

  // Spread the bounded urban quota across both riverbanks, not just early rows.
  for (const p of shuffle(urbanSites, mulberry32(seed ^ 0x75726261))) {
    if (propCounts.urban >= PROP_BUDGET.urban) break;
    addProp(p.key, p.x, p.y);
  }

  // A few open-front home gardens, never shop/service perimeters. The complete
  // garden + approach must be free; reserve it atomically, including the gate.
  // This is generation-time work, using the same local occupancy buckets.
  const fenceRng = mulberry32(seed ^ 0x66656e63);
  const fencedBlocks = new Set<Block>();
  const fencePanel = (r: Rect, alongX: boolean, wire: boolean): PlacedProp => {
    const width = r.x1 - r.x0;
    const height = r.y1 - r.y0;
    // PNGs: wood_a 46x39 (+X/SE), wood_b 45x41 (+Y/SW), wire_a 46x42 (+X).
    // Ground post span is 32x16 source pixels = half a world tile (64x32).
    // Midpoints (19,29)/(19,31) account for transparent right/bottom padding.
    const imageW = alongX ? 46 : 45;
    const imageH = alongX ? (wire ? 42 : 39) : 41;
    return {
      key: alongX ? (wire ? 'prop_fence_wire_a' : 'prop_fence_wood_a') : 'prop_fence_wood_b',
      x: (r.x0 + r.x1) / 2, y: (r.y0 + r.y1) / 2,
      collider: { x: r.x0, y: r.y0, width, height },
      renderScale: (alongX ? width : height) * 2,
      renderAnchor: { x: 19 / imageW, y: (alongX && wire ? 31 : 29) / imageH },
    };
  };
  for (const { home, block } of shuffle(fenceLots, fenceRng)) {
    if (propCounts.fences + 6 > PROP_BUDGET.fences) break;
    if (fencedBlocks.has(block)) continue;
    const cx = home.x - home.footprintW / 2;
    const x0 = cx - 1;
    const x1 = cx + 1;
    const y0 = home.y + 0.35;
    const y1 = y0 + 1.2;
    const half = FENCE_THICKNESS / 2;
    const garden = { x0: x0 - half, x1: x1 + half, y0, y1: y1 + 0.45 };
    if (!clearRect(garden)) continue;
    const panels: PlacedProp[] = [];
    for (const x of [x0, x1]) {
      for (let i = 0; i < 2; i++) {
        panels.push(fencePanel({ x0: x - half, x1: x + half, y0: y0 + i * 0.6, y1: y0 + (i + 1) * 0.6 }, false, false));
      }
    }
    const wire = fenceRng() < 0.35;
    for (const [left, right] of [[x0 + half, cx - FENCE_GATE / 2], [cx + FENCE_GATE / 2, x1 - half]]) {
      panels.push(fencePanel({ x0: left, x1: right, y0: y1 - FENCE_THICKNESS, y1 }, true, wire));
    }
    props.push(...panels);
    propCounts.fences += panels.length;
    occupy(garden); // Keeps later props/parking out of the opening and approach.
    fencedBlocks.add(block);
  }

  // Independent streams and hard quotas: urban props cannot starve any reserve.
  // Shuffle candidates across the WHOLE region before applying its quota, so
  // row-major truncation cannot leave the southern forest empty. No frame work.
  for (const biome of ['forest', 'countryside', 'beach', 'pinewood', 'savanna', 'desert'] as const) {
    const sceneryRng = mulberry32(seed ^ ({ forest: 0x6e617475, countryside: 0x6669656c, beach: 0x62656163,
      pinewood: 0x70696e65, savanna: 0x73617661, desert: 0x64657365 }[biome]));
    // O deserto é esparso de propósito: pedra e mato seco longe um do outro é o que
    // vende o vazio, não um matagal. Mesmo assim a região é grande demais para uma
    // amostragem grossa — a cota não fecharia. Praia e campo são faixas estreitas
    // sob o grid de ruas, então precisam de amostragem mais fina que a mata.
    //
    // Mata e pinhal descem a 1,6 tile: a copa dos sprites grandes mede 1,2 tile de
    // largura, então é nesse passo que a floresta fecha e passa a ser lida como mancha
    // contínua — com sombra própria, que é o que o morro nu não tinha.
    const spacing = biome === 'forest' || biome === 'pinewood' ? 1.6 : biome === 'savanna' ? 3.5
      : biome === 'desert' ? 4.5 : 4;
    // Lista base de cada bioma. A mata não tem uma: ali a espécie é da cota do sitio, e
    // quem decide é `lista` logo abaixo.
    const keys: Partial<Record<Biome, string[]>> = {
      countryside: ['prop_flowers_yellow', 'prop_flowers_red', 'prop_weed_medium', 'prop_tree_common_medium', 'prop_flowers_pink'],
      beach: ['prop_rocks_brown_a', 'prop_rocks_gray_b', 'prop_weed_small_dry', 'prop_trunk_b', 'prop_weed_medium_dry'],
      pinewood: ['prop_tree_pine_tall', 'prop_tree_pine_tall', 'prop_tree_pine_medium', 'prop_tree_pine_small'],
      savanna: ['prop_weed_small_dry', 'prop_weed_small_dry', 'prop_rocks_brown_a', 'prop_tree_common_medium', 'prop_trunk_b'],
      desert: ['prop_rocks_gray_a', 'prop_weed_medium_dry', 'prop_rocks_brown_b', 'prop_weed_large_b_dry',
        'prop_trunk_c', 'prop_tire_buried_a', 'prop_rocks_gray_c'],
    };
    const sites: Point[] = [];
    // §8: na mata, a espécie é da cota do sitio, não do bioma inteiro. A lista fixa dava
    // a mesma metade de conifera no vale e na crista, e aí a altitude não se lia em nada
    // — o pinho fica no alto, a frondosa no pé, e o meio-talude divide os dois.
    const lista = (p: Point): string[] => biome === 'forest'
      ? especieDoNivel('forest', heights[Math.floor(p.y) * W + Math.floor(p.x)])!
      : keys[biome]!;
    for (let y = 1.5; y < H - 1; y += spacing) {
      for (let x = 1.5; x < W - 1; x += spacing) {
        if (at(Math.floor(x), Math.floor(y))?.biome !== biome) continue;
        sites.push({ x: x + (sceneryRng() - 0.5) * 0.4, y: y + (sceneryRng() - 0.5) * 0.4 });
      }
    }
    const orderedSites = shuffle(sites, sceneryRng);
    // Guarantee readable woodland in every block before distributing the remaining quota.
    if (biome === 'forest' || biome === 'pinewood') {
      const budget = biome === 'forest' ? 'forestTrees' : 'pinewood';
      for (const block of blocks.filter((b) => b.biome === biome)) {
        let planted = 0;
        for (const p of orderedSites) {
          if (p.x <= block.x0 || p.x >= block.x1 || p.y <= block.y0 || p.y >= block.y1) continue;
          const before = propCounts[budget];
          const ks = lista(p);
          addProp(ks[Math.floor(sceneryRng() * ks.length)], p.x, p.y, budget);
          if (propCounts[budget] > before && ++planted === 5) break;
        }
      }
    }
    for (const p of orderedSites) {
      const details = biome === 'forest' && propCounts.forestTrees >= PROP_BUDGET.forestTrees;
      const choices = details ? ['prop_trunk_a', 'prop_rocks_gray_b', 'prop_weed_medium'] : lista(p);
      const budget = biome === 'forest' ? (details ? 'forestDetails' : 'forestTrees') : biome;
      if (propCounts[budget] >= PROP_BUDGET[budget]) break;
      addProp(choices[Math.floor(sceneryRng() * choices.length)], p.x, p.y, budget);
    }
  }

  // Populate reserved bays, not arbitrary asphalt nodes. TrafficSystem can spawn
  // its bounded moving fleet on the connected directed avenues independently.
  const serviceVehicles = ['helicopter', 'police', 'firetruck', 'garbage', 'bus_school', 'ambulance', 'police_compact'];
  for (const p of shuffle(parkingSlots, rng)) {
    if (vehicles.length >= MAX_VEHICLES) break;
    const defKey = serviceVehicles[vehicles.length] ?? CIVILIAN_VEHICLES[Math.floor(rng() * CIVILIAN_VEHICLES.length)];
    const def = VEHICLE_DEFS[defKey];
    const radius = Math.max(def.footprintW, def.footprintH) / 2;
    const r = { x0: p.x - radius, y0: p.y - radius, x1: p.x + radius, y1: p.y + radius };
    if (!clearRect(r, true)) continue;
    occupy(r);
    vehicles.push({ defKey, color: def.colors.length ? def.colors[Math.floor(rng() * def.colors.length)] : null,
      x: p.x, y: p.y, dir: p.x % SPACING < SPACING / 2 ? 'SE' : 'NW' });
  }

  const candidates: Point[] = [];
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      if (!walkway[y * W + x] || !(road(x - 1, y) || road(x + 1, y) || road(x, y - 1) || road(x, y + 1))) continue;
      const p = { x: x + 0.5, y: y + 0.5 };
      if (safeCircle(p, 0.2)) candidates.push(p);
    }
  }
  const central = candidates.filter((p) => p.y < northQuay && at(Math.floor(p.x), Math.floor(p.y))?.biome === 'commercial');
  central.sort((a, b) => Math.hypot(a.x - W * 0.57, a.y - H * 0.35) - Math.hypot(b.x - W * 0.57, b.y - H * 0.35));
  if (!central.length) throw new Error('No clear commercial sidewalk for player');
  const playerSpawn = central[0];
  // O baralho inteiro fica guardado: a cachoeira, que nasce depois, aparda spawns dentro do
  // próprio corredor e repõe a cidade com as sobras desta mesma lista.
  const spawnPool = shuffle(candidates.filter((p) => Math.hypot(p.x - playerSpawn.x, p.y - playerSpawn.y) > 1), rng);
  const npcSpawns = spawnPool.slice(0, MAX_SPAWNS);

  // ---- Relevo: plataforma de obra, não mesa cortada no morro ----------------
  // A porta fica na fachada, um palmo FORA da parede (fileira sul ou coluna leste).
  // Travando só o pé-direito, a casa do campo ficava com o degrau exatamente onde quem
  // sai pisa: entrava-se e não se saía mais, porque acima de TERRAIN_STEP_UP_TILES é
  // parede. Então o lote inteiro, com duas fileiras de apronto, é travado num só nível.
  // Mas travar ao zero do mundo era outra mentira cartográfica: um platô riscado no
  // meio da encosta, com borda em zigue-zague, é justamente o degrau de bloco que se
  // quer evitar. A plataforma agora fica no nível médio do próprio chão que ela ocupa
  // — como se move terra para a obra — e o morro em volta é borrado e reaparado depois,
  // então o que se vê é a encosta abraçando a casa em rampa, não um corte seco.
  const plataformas: { cells: number[]; nivel: number; cx: number; cy: number }[] = [];
  for (const b of buildings) {
    const cells: number[] = [];
    eachCell({ x0: b.x - b.footprintW - 2, y0: b.y - b.footprintW - 2, x1: b.x + 2, y1: b.y + 2 }, (x, y) => {
      if (x < 0 || y < 0 || x >= W || y >= H) return;
      const i = y * W + x;
      if (flatTile(i)) return;
      cells.push(i);
    });
    if (cells.length < 3) continue;
    let soma = 0;
    for (const i of cells) soma += heights[i];
    plataformas.push({
      cells,
      nivel: soma / cells.length,
      cx: b.x - b.footprintW * 0.5,
      cy: b.y - b.footprintW * 0.5,
    });
  }
  // Vizinhança de nível: duas plataformas coladas no mesmo morro não podem virar mesa e
  // buraco separados por parede. Cada uma cede um pouco à outra até o conjunto concordar.
  for (let it = 0; it < 8; it++) {
    const alvo = plataformas.map((p) => {
      let soma = p.nivel * 2;
      let peso = 2;
      for (const q of plataformas) {
        if (q === p) continue;
        const d = Math.hypot(q.cx - p.cx, q.cy - p.cy);
        if (d >= 12) continue;
        const w = 1 - d / 12;
        soma += q.nivel * w;
        peso += w;
      }
      return soma / peso;
    });
    for (let k = 0; k < plataformas.length; k++) plataformas[k].nivel = alvo[k];
  }
  for (const p of plataformas) {
    for (const i of p.cells) {
      heights[i] = p.nivel;
      pin[i] = 1;
      macio[i] = 1;
      budget[i] = 0;
    }
  }
  borrar(1);
  montarTeto();
  aparar();

  // Poeira: média e aparar deixam resto de 1e-8 onde o chão é planície. Um tile assim
  // desloca o losango uma fração de pixel e faz o depth sort comparar float; zerar o
  // que não chega a um pixel de altura devolve à planície o valor exato zero.
  for (let i = 0; i < W * H; i++) if (heights[i] < 0.015) heights[i] = 0;

  // Por último, e depois de qualquer poeira: o asfalto é travado em tiras de nível. É a
  // regra mais rígida do relevo e por um bom motivo — abaixo dela não existe caso em que
  // o morro tenha direito de mandar na rua.
  nivelarFaixa();
  // A faixa só desce, então sobra ao mato o trabalho de se ajustar à rua pronta. O asfalto
  // já está travado (budget 0), portanto esta passada final nivela o entorno sem jamais
  // desfazer o corte de nível — e é ela que impede o morro de encostar na guia como muro.
  montarTeto();
  aparar();

  // ---- Cachoeiras ----------------------------------------------------------
  // O relevo não tem parede, e é de propósito: o teto de declive é justamente o que
  // impede o morro de acordar um degrau de bloco (#115, #118). Então a queda não nasce
  // de um corte — nasce do LANCE mais íngreme da linha de escoamento, o trecho onde a
  // cota mais cai por tile andado. E há um motivo geométrico para isso virar cachoeira na
  // tela: em `worldToScreen`, cada tile de (x+y) ganho desce o ponto 32px e cada tile de
  // cota perdido desce mais 64. Um talude a 0,3 tile/tile, que é o máximo que o teto
  // permite, desce em tela 1,6 vez mais rápido do que chão plano — e se o caimento vem
  // para a câmera (x e y crescendo juntos) o X não anda um pixel: o traçado sai uma
  // coluna vertical. É essa coluna que o render vestirá de água, ponto a ponto, com a
  // cota lida do próprio chão, e não uma faixa plana colada na parede. Daí a régua abaixo
  // ser medida em pixels de tela, não em gosto: 0,8 tile de desnível são 51px de queda, e
  // o lance ainda precisa descer pelo menos 112px na tela para não ser riacho.
  const CASCATA_MAX = 4;
  const CASCATA_QUEDA_MIN = 0.8;
  /** Pixels de descida na tela. Abaixo disto não é queda, é riacho. */
  const CASCATA_DESCIDA_MIN = 112;
  /** Janela do lance: curto demais não dá folha de água, comprido demais é rampa. */
  const CASCATA_LANCE_MIN = 3;
  const CASCATA_LANCE_MAX = 8;
  /** Travessia máxima, em fração da descida: faz a folha cair reta em vez de escorregar de lado. */
  const CASCATA_LATERAL = 0.6;
  /** Duas quedas coladas no mesmo talude se leriam como uma malhada só. */
  const CASCATA_ESPACO = 22;
  /** Quantos lances do mesmo tile a varredura guarda, do melhor para o pior. */
  const CASCATA_CANDIDATAS = 4;
  /** Queda que se paga por tile de travessia na tela: faz a coluna bater o declive torto. */
  const CASCATA_TORTO = 0.04;
  /** Curvatura máxima do lance, em fração da descida: acima disso a folha não vestiu o talude. */
  const CASCATA_CURVA = 0.3;
  /** Os oito vizinhos: a diagonal é o único passo que desce a prumo na tela. */
  const VIZINHOS: [number, number][] = [
    [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1],
  ];
  /** Amostra do eixo: miúdo porque a folha tem de vestir o losango, não cortá-lo. */
  const CASCATA_PASSO = 0.3;
  /**
   * O que uma queda deste porte jorra: a calha da folha e o raio da poça no pé. O canal
   * estreita no lábio e alarga na bacia — é o guarda-chuva clássico, e vem do próprio fluxo,
   * porque a água que cai precisa de mais chão para sair.
   *
   * A régua é a tela, não o gosto: uma folha de 1,3 tile numa queda de 326px de tela deu
   * 110px de largura por 326 de altura, e o olho leu rampa de concreto. Meio tile de calha
   * para um lance de um tile de cota é o ponto em que a cortina fica mais alta que larga e
   * ainda cabe um corpo nela. E a poça gira em volta do jato sem ser lago: o diâmetro que a
   * folha desenhada pede é o dobro da sua largura no pé — em 1,27 tile o caldo tinha o triplo
   * da calha e virava poça de chuva na frente da queda, que era o que se via.
   */
  const medidaQueda = (queda: number) => {
    const largura = Math.min(1.35, 0.55 + queda * 0.28);
    return { largura, raio: Math.min(1.4, 0.4 + largura * 0.75) };
  };
  /** O mundo morre antes da borda: nada despenca do fim do mapa. */
  const CASCATA_BORDA = 5;
  const cascatas: Cascade[] = [];
  const naCatar = new Uint8Array(W * H);
  {
    // Onde a água não pode passar: prédio, asfalto, trilha, rio e borda. O mato não entra
    // aqui de propósito — a mata inteira estaria a duas tiles de um prop, e a única
    // encosta sobra seria o deserto. Prop no corredor é tirado depois, não filtrado antes.
    const catar = new Uint8Array(W * H);
    for (const b of buildings) {
      const s = b.footprintW;
      for (let y = Math.floor(b.y - s); y <= Math.ceil(b.y); y++) {
        for (let x = Math.floor(b.x - s); x <= Math.ceil(b.x); x++) {
          if (x >= 0 && y >= 0 && x < W && y < H) catar[y * W + x] = 1;
        }
      }
    }
    const àObstáculo = manhattan((i) => catar[i] === 1
      || tiles[i].kind === 'road' || tiles[i].kind === 'water' || walkway[i] === 1);
    // A régua da NASCENTE é de limpeza visual: longe de asfalto, rio e prédio, para a queda
    // brotar na encosta e não em cima de um lote. O TRAJECTO não obedece a ela — descer um
    // morro é exatamente ir para o vale, onde a água mora. Filhar o escoamento pela mesma
    // régua matava o passo a duas tiles da fonte: medido, 966 de cada 1.001 fontes morriam
    // por caminho curto e o mapa inteiro ficava sem cachoeira.
    const pisável = (x: number, y: number) => {
      if (x < CASCATA_BORDA || y < CASCATA_BORDA || x >= W - CASCATA_BORDA || y >= H - CASCATA_BORDA) return false;
      const i = y * W + x;
      return !flatTile(i) && àObstáculo[i] >= 2 && toWater[i] >= 3;
    };
    /** Chão natural dentro do mapa: o que a corrente pode atravessar. */
    const escoável = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H && !flatTile(y * W + x);

    // O escoamento guloso desce pelo vizinho mais baixo — mas na tela "mais baixo" não é
    // só a cota: o passo +x desce para a direita e o +y para a esquerda, e o único passo
    // que desce A PIUMO é a diagonal (+x,+y), porque nela o (x−y) não anda. Sem essa
    // conta, a linha de maior declive de um talude que olha para o +x andava um eixo
    // inteiro e depois corria para o outro: um L no mundo, um V na tela, e a folha de
    // água fechando por dentro da curva como uma laje de concreto. Paga-se um pouco de
    // queda por tile de travessia e o morro devolve uma coluna.
    const desce = (x0: number, y0: number) => {
      const nós: { x: number; y: number }[] = [{ x: x0, y: y0 }];
      let x = x0;
      let y = y0;
      for (let k = 0; k < 16; k++) {
        let melhor = 0.05;
        let dir: [number, number] | null = null;
        for (const [dx, dy] of VIZINHOS) {
          if (!escoável(x + dx, y + dy)) continue;
          const d = heights[y * W + x] - heights[(y + dy) * W + x + dx];
          const v = d - Math.abs(dx - dy) * CASCATA_TORTO;
          if (v > melhor) {
            melhor = v;
            dir = [dx, dy];
          }
        }
        if (!dir) break;
        x += dir[0];
        y += dir[1];
        nós.push({ x, y });
      }
      return nós;
    };
    // Chaikin: o escoamento guloso é um degrau de escada, e escada desenhada é zigue-
    // zague. Três rodadas trocam cada canto por dois pontos a 1/4 e 3/4 e o traçado
    // assenta na diagonal — que é a direção que desce reta na tela.
    const alisa = (nós: { x: number; y: number }[]) => {
      let pts = nós.map((p) => ({ x: p.x + 0.5, y: p.y + 0.5 }));
      for (let it = 0; it < 3; it++) {
        const out: { x: number; y: number }[] = [pts[0]];
        for (let i = 0; i < pts.length - 1; i++) {
          const a = pts[i];
          const b = pts[i + 1];
          out.push({ x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25 });
          out.push({ x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75 });
        }
        out.push(pts[pts.length - 1]);
        pts = out;
      }
      return pts;
    };
    const reamostra = (pts: { x: number; y: number }[]) => {
      const acum = [0];
      for (let i = 1; i < pts.length; i++) {
        acum.push(acum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
      }
      const total = acum[acum.length - 1];
      const out: { x: number; y: number }[] = [];
      let k = 1;
      for (let s = 0; s <= total + 1e-6; s += CASCATA_PASSO) {
        while (k < pts.length - 1 && acum[k] < s) k++;
        const t = acum[k] === acum[k - 1] ? 0 : (s - acum[k - 1]) / (acum[k] - acum[k - 1]);
        out.push({
          x: pts[k - 1].x + (pts[k].x - pts[k - 1].x) * t,
          y: pts[k - 1].y + (pts[k].y - pts[k - 1].y) * t,
        });
      }
      const fim = pts[pts.length - 1];
      if (Math.hypot(fim.x - out[out.length - 1].x, fim.y - out[out.length - 1].y) > 0.02) out.push(fim);
      else out[out.length - 1] = fim;
      return out;
    };

    // Cada tile é uma nascente em potencial, mas a cachoeira não é o caminho inteiro até o
    // vale — é o LANCE desse caminho onde a cota despenca sem deitar para o lado na tela.
    // A janela desliza sobre a linha de escoamento e fica a melhor pontuação de cada fonte.
    type Lance = { boca: { x: number; y: number }; fim: { x: number; y: number };
      nós: { x: number; y: number }[]; curso: { x: number; y: number }[];
      queda: number; topo: number; base: number; pontos: number; pxQeda: number; poça: number };
    // O que a folha consegue desenhar é o que quase não sai da reta entre o lábio e o pé.
    // Na tela, travessia é (x−y) a 64px e descida é (x+y) a 32px: um lance que faz curva
    // descreve um V e o preenchimento fecha por dentro da barriga — a laje pálida que
    // atravessa o morro. Medir só as pontas não pega, porque um L perfeito tem as duas
    // pontas na mesma vertical e o cotovelo a três tiles dela.
    const prumo = (curso: { x: number; y: number }[], pxQeda: number): boolean => {
      const boca = [(curso[0].x - curso[0].y) * 64, (curso[0].x + curso[0].y) * 32];
      const pé = [(curso[curso.length - 1].x - curso[curso.length - 1].y) * 64,
        (curso[curso.length - 1].x + curso[curso.length - 1].y) * 32];
      const dx = pé[0] - boca[0];
      const dy = pé[1] - boca[1];
      const corda = Math.hypot(dx, dy);
      if (corda < 1) return false;
      let max = 0;
      for (const p of curso) {
        const px = (p.x - p.y) * 64;
        const py = (p.x + p.y) * 32;
        const d = Math.abs((px - boca[0]) * dy - (py - boca[1]) * dx) / corda;
        if (d > max) max = d;
      }
      return max <= Math.max(24, pxQeda * CASCATA_CURVA);
    };
    /**
     * A poça é água de movimento: `isWaterWorld` vale pelo tile que o disco encosta, não pelo
     * ponto — um canto de tile molhado afoga o tile inteiro. Por isso ela nunca pode tocar o
     * asfalto: um carro atravessando a faixa veria água no meio da pista e a checagem de
     * trânsito encerra ali. O passeio afogado é problema de outro lado, e está resolvido lá
     * (`Map.buildSidewalkGraph` não planta node em tile alagado), porque tirar o node é o
     * gesto certo: poça na calçada se contorna, como se contorna o rio.
     *
     * O chão disponível limita a poça; ele não cancela a queda. Encolhe-se o disco até caber,
     * primeiro no chão natural e, não cabendo, no que sobra — laje alagada é meio-boca de
     * desenho, queda que não existe é meio-boca de função.
     */
    const poçaLimpa = (fim: { x: number; y: number }, raio: number, piso: number): number => {
      const cx = fim.x + 0.5;
      const cy = fim.y + 0.5;
      const asfalto = (tx: number, ty: number) => {
        if (tx < 0 || ty < 0 || tx >= W || ty >= H) return true;
        return tiles[ty * W + tx].kind === 'road';
      };
      const natural = (tx: number, ty: number) => {
        if (asfalto(tx, ty)) return true;
        const j = ty * W + tx;
        return flatTile(j) || walkway[j] === 1;
      };
      for (const suja of [natural, asfalto]) {
        for (let r = raio; r >= piso - 1e-6; r -= 0.05) {
          let limpa = true;
          for (let ty = Math.floor(cy - r); ty <= Math.ceil(cy + r) && limpa; ty++) {
            for (let tx = Math.floor(cx - r); tx <= Math.ceil(cx + r) && limpa; tx++) {
              const dx = Math.max(tx - cx, 0, cx - tx - 1);
              const dy = Math.max(ty - cy, 0, cy - ty - 1);
              if (Math.hypot(dx, dy) <= r && suja(tx, ty)) limpa = false;
            }
          }
          if (limpa) return Math.max(0.5, r);
        }
      }
      return 0;
    };
    const lances: Lance[] = [];
    for (let y = CASCATA_BORDA; y < H - CASCATA_BORDA; y++) {
      for (let x = CASCATA_BORDA; x < W - CASCATA_BORDA; x++) {
        if (!pisável(x, y) || heights[y * W + x] < 1) continue;
        const trilha = desce(x, y);
        const opções: Lance[] = [];
        for (let i = 0; i + CASCATA_LANCE_MIN < trilha.length; i++) {
          const a = trilha[i];
          const ia = a.y * W + a.x;
          for (let j = i + CASCATA_LANCE_MIN; j <= Math.min(trilha.length - 1, i + CASCATA_LANCE_MAX); j++) {
            const b = trilha[j];
            // A bacia é um anel de raio até 1,4 tile em volta do pé: se o pé chega perto
            // da borda, metade do anel fica fora do mundo e a água morre no nada.
            if (b.x < CASCATA_BORDA || b.y < CASCATA_BORDA
              || b.x >= W - CASCATA_BORDA || b.y >= H - CASCATA_BORDA) continue;
            const queda = heights[ia] - heights[b.y * W + b.x];
            if (queda < CASCATA_QUEDA_MIN) continue;
            // A conta é a projeção em si: `worldToScreen` dá y = (x+y)·32 − h·64, então o
            // chão andado desce 32px por tile de (x+y) e a cota perdida desce mais 64 por
            // tile. Travessia é o (x−y), a 64px. Um lance que desce o morro para o NORTE da
            // tela perde altura e ganha tela para cima — é riacho morro acima, e a primeira
            // régua deixou um desses passar: queda certa, sinal errado.
            const pxChão = ((b.x + b.y) - (a.x + a.y)) * 32;
            const pxAltura = queda * 64;
            const pxQeda = pxChão + pxAltura;
            if (pxChão <= 0 || pxQeda < CASCATA_DESCIDA_MIN) continue;
            const pxLado = Math.abs((b.x - b.y) - (a.x - a.y)) * 64;
            if (pxLado > pxQeda * CASCATA_LATERAL) continue;
            // Pontua a COLUNA de cota, nunca o comprimento: um lance largo e manso também
            // desce na tela pelo chão andado, e isso é rampa. O quadrado em `pxAltura` é o
            // que faz o talude íngreme bater o riacho comprido, e o divisor em travessia é
            // o que apruma a folha.
            const pontos = (pxAltura * pxAltura) / (pxLado + 32);
            // Não guardar só o campeão: o lance mais pontudo deste tile pode ser o
            // cotovelo que a folha não desenha. Fica uma fila curta, do melhor para o
            // pior, e a escolha cai no primeiro que é reto e não atravessa rua.
            opções.push({
              boca: a, fim: b, nós: trilha.slice(i, j + 1), curso: [],
              queda, topo: heights[ia], base: heights[b.y * W + b.x], pontos, pxQeda, poça: 0,
            });
            opções.sort((p, q) => q.pontos - p.pontos);
            if (opções.length > CASCATA_CANDIDATAS) opções.length = CASCATA_CANDIDATAS;
          }
        }
        for (const c of opções) {
          c.curso = reamostra(alisa(c.nós));
          if (!prumo(c.curso, c.pxQeda)) continue;
          // O traçado alisado corta esquinas: se ele saiu do corredor, o lance não era uma
          // linha só e a folha ficaria torta atravessando rua e lote.
          let firme = true;
          for (const p of c.curso) {
            const tx = Math.floor(p.x);
            const ty = Math.floor(p.y);
            if (tx < 0 || ty < 0 || tx >= W || ty >= H) { firme = false; break; }
            const j = ty * W + tx;
            if (flatTile(j) || tiles[j].kind === 'road' || walkway[j]) { firme = false; break; }
          }
          if (!firme) continue;
          // Poça mínima desenhável: meio tile de calha já é o bastante para a cortina caber
          // dentro do caldo. Abaixo disso a folha despeja num pires e a leitura volta a ser
          // pintura colada na pedra.
          const { largura, raio } = medidaQueda(c.queda);
          c.poça = poçaLimpa(c.fim, raio, Math.max(0.5, largura * 0.6));
          if (!c.poça) continue;
          lances.push(c);
          break;
        }
      }
    }
    lances.sort((a, b) => b.pontos - a.pontos);
    const escolhidas: Lance[] = [];
    for (const c of lances) {
      if (escolhidas.length >= CASCATA_MAX) break;
      // Duas janelas do mesmo talude têm lábios vizinhos: a varredura acha o lance a partir
      // de cada tile rio acima, então o afastamento é medido na boca da queda.
      const perto = escolhidas.some((o) => Math.hypot(o.boca.x - c.boca.x, o.boca.y - c.boca.y) < CASCATA_ESPACO);
      if (!perto) escolhidas.push(c);
    }
    escolhidas.forEach((c, id) => {
      const fim = c.fim;
      const { largura } = medidaQueda(c.queda);
      const bacia = { x: fim.x + 0.5, y: fim.y + 0.5, raio: c.poça };
      cascatas.push({
        id,
        curso: c.curso,
        largura,
        bacia,
        topo: c.topo,
        base: c.base,
        queda: c.queda,
      });
      // Carimbo do corredor: a folha de água não pode ter mato atravessado nela, nem pedra
      // boiando no jato. `naCatar` tira o que já foi plantado — e os retângulos em `occupied`
      // barram o que a serra ainda vai plantar, porque adProp consulta a mesma malha.
      const meia = largura * 0.5 + 0.75;
      const marca = (px: number, py: number, alcance: number) => {
        for (let y = Math.max(0, Math.floor(py - alcance)); y <= Math.min(H - 1, Math.floor(py + alcance)); y++) {
          for (let x = Math.max(0, Math.floor(px - alcance)); x <= Math.min(W - 1, Math.floor(px + alcance)); x++) {
            if (Math.hypot(x + 0.5 - px, y + 0.5 - py) <= alcance) naCatar[y * W + x] = 1;
          }
        }
      };
      c.curso.forEach((p, k) => {
        marca(p.x, p.y, meia);
        // `occupy` escreve na malha de tiles e não conhece borda: fora do mapa não há o
        // que bloquear, então o retângulo é aparado antes.
        if (k % 2 === 0) {
          occupy({
            x0: Math.max(0, p.x - meia + 0.3), y0: Math.max(0, p.y - meia + 0.3),
            x1: Math.min(W, p.x + meia - 0.3), y1: Math.min(H, p.y + meia - 0.3),
          });
        }
      });
      // `marca` mede ao centro do tile e `isWaterWorld` ao tile inteiro, então a máscara chega
      // quase um tile além do disco: a folga é o que evita pedra e mato plantados na água.
      marca(bacia.x, bacia.y, bacia.raio + 1.2);
      occupy({
        x0: Math.max(0, bacia.x - bacia.raio - 0.2), y0: Math.max(0, bacia.y - bacia.raio - 0.2),
        x1: Math.min(W, bacia.x + bacia.raio + 0.2), y1: Math.min(H, bacia.y + bacia.raio + 0.2),
      });
    });
    if (cascatas.length) {
      // Pedra e mato em cima do escoamento sumiriam atrás da folha ou, pior, apareceriam
      // atravessados nela. Tira-se antes de a copa ser carimbada, para a sombra também ir.
      for (let k = props.length - 1; k >= 0; k--) {
        const p = props[k];
        if (naCatar[Math.floor(p.y) * W + Math.floor(p.x)]) props.splice(k, 1);
      }
      // Cidadão nascendo dentro da queda acordaria boiando no lençol. O corredor é aparado da
      // lista de spawns e o buraco tapado com a sobra do mesmo baralho, para a praça não
      // esvaziar porque a serra resolveu despejar água na calçada.
      for (let k = npcSpawns.length - 1; k >= 0; k--) {
        const p = npcSpawns[k];
        if (naCatar[Math.floor(p.y) * W + Math.floor(p.x)]) npcSpawns.splice(k, 1);
      }
      for (const p of spawnPool.slice(MAX_SPAWNS)) {
        if (npcSpawns.length >= MAX_SPAWNS) break;
        if (naCatar[Math.floor(p.y) * W + Math.floor(p.x)]) continue;
        npcSpawns.push(p);
      }
    }
  }

  // ---- Serra arborizada ----------------------------------------------------
  // O morro era o lugar mais visível do mapa e o mais nu: mata e pinhal param dentro do
  // próprio bioma, e a crista alta — justamente onde a sombra de telão mora — não recebia
  // árvore nenhuma. Esta passada vem DEPOIS do relevo fechado porque a régua é a altura
  // final: planta na encosta e no topo de qualquer reserva seca.
  const serraRng = mulberry32(seed ^ 0x73657272);
  const taludes: { x: number; y: number; biome: Biome; nivel: number }[] = [];
  for (let y = 2; y < H - 2; y++) {
    for (let x = 2; x < W - 2; x++) {
      const i = y * W + x;
      if (flatTile(i)) continue;
      const h = heights[i];
      const declive = Math.max(Math.abs(h - heights[i + 1]), Math.abs(h - heights[i - 1]),
        Math.abs(h - heights[i + W]), Math.abs(h - heights[i - W]));
      // Lombada de quintal não é serra: só entra o que tem caimento declarado ou topo.
      if (h < 1.2 && declive < 0.07) continue;
      taludes.push({ x, y, biome: tiles[i].biome, nivel: h });
    }
  }
  for (const p of shuffle(taludes, serraRng)) {
    if (propCounts.serra >= PROP_BUDGET.serra) break;
    const especies = especieDoNivel(p.biome, p.nivel);
    if (!especies) continue;
    if (serraRng() > (SERRA_ABERTURA[p.biome] ?? 1)) continue;
    addProp(especies[Math.floor(serraRng() * especies.length)],
      p.x + 0.5 + (serraRng() - 0.5) * 0.7, p.y + 0.5 + (serraRng() - 0.5) * 0.7, 'serra');
  }

  // ---- Bocas de caverna --------------------------------------------------
  // Vem antes da sombra de propósito: arrancar a árvore do pé da porta tem de arrancar
  // a copa dela junto, e a copa é carimbada logo abaixo.
  // A porta nasce onde o morro já é morro: cota alta, encosta atrás, descida na frente.
  // Uma boca em platô é um buraco no chão, e uma boca no vale é uma porta de loja.
  const cavernas: CaveMouth[] = [];
  {
    /** O mundo acaba antes da borda: porta a dois tiles do fim do mapa não tem o que explorar. */
    const BORDA = 7;
    /** Só a serra alta recebe boca — o pé do morro é onde a cidade começa a existir. */
    const COTA_MIN = 1.6;
    /** O quanto a encosta tem de cair à frente da porta para o vão se ler como entrada. */
    const DESCIDA_MIN = 0.08;
    /** Bocas não podem ser vizinhas: uma caverna por região, senão o mapa vira queijo. */
    const DISTANCIA = 40;
    const MAX_BOCAS = 3;
    // Onde o corpo humano já construiu: prédio, passeio e asfalto não têm porta por cima.
    const obra = new Uint8Array(W * H);
    for (const b of buildings) {
      const s = b.footprintW;
      for (let y = Math.floor(b.y - s); y <= Math.ceil(b.y); y++) {
        for (let x = Math.floor(b.x - s); x <= Math.ceil(b.x); x++) {
          if (x >= 0 && y >= 0 && x < W && y < H) obra[y * W + x] = 1;
        }
      }
    }
    for (let i = 0; i < W * H; i++) if (walkway[i] === 1) obra[i] = 1;
    const chão = (x: number, y: number) => {
      if (x < BORDA || y < BORDA || x >= W - BORDA || y >= H - BORDA) return false;
      const i = y * W + x;
      return !flatTile(i) && obra[i] === 0 && tiles[i].kind !== 'water';
    };
    // Cachoeira lava a porta: o jato e a bacia ficam fora da escolha de propósito, para
    // a entrada da caverna ser atravessável e não um caldo de espuma.
    const caiPerto = (x: number, y: number) => cascatas.some((c) => c.bacia.raio + 4 > Math.hypot(c.bacia.x - x, c.bacia.y - y)
      || c.curso.some((p) => Math.hypot(p.x - x, p.y - y) < 6));
    type Candidato = { x: number; y: number; cota: number; dx: number; dy: number; nota: number };
    const candidatos: Candidato[] = [];
    for (let y = BORDA; y < H - BORDA; y++) {
      for (let x = BORDA; x < W - BORDA; x++) {
        const i = y * W + x;
        if (!chão(x, y) || toCity[i] < 4 || heights[i] < COTA_MIN || caiPerto(x, y)) continue;
        let dx = 0;
        let dy = 0;
        let maisBaixo = heights[i];
        for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const v = heights[(y + oy) * W + (x + ox)];
          if (v < maisBaixo) { maisBaixo = v; dx = ox; dy = oy; }
        }
        if (heights[i] - maisBaixo < DESCIDA_MIN) continue;
        // Atrás da porta tem de subir, e na frente tem de haver dois passos de descida
        // limpos: é por ali que o jogador chega andando, e é para lá que quem sai olha.
        if (heights[(y - dy) * W + (x - dx)] <= heights[i]) continue;
        if (!chão(x + dx, y + dy) || !chão(x + dx * 2, y + dy * 2)) continue;
        candidatos.push({ x, y, cota: heights[i], dx, dy, nota: heights[i] + toCity[i] * 0.08 });
      }
    }
    // Primeiro as mais altas e mais afastadas do asfalto; o empate se desfaz pela varredura,
    // então o mesmo seed devolve sempre as mesmas bocas.
    candidatos.sort((a, b) => b.nota - a.nota || a.y * W + a.x - (b.y * W + b.x));
    for (const c of candidatos) {
      if (cavernas.length >= MAX_BOCAS) break;
      if (cavernas.some((m) => Math.hypot(m.x - c.x, m.y - c.y) < DISTANCIA)) continue;
      const x = c.x + 0.5;
      const y = c.y + 0.5;
      cavernas.push({ id: cavernas.length, x, y, facing: Math.atan2(c.dy, c.dx), cota: c.cota });
      // A árvore que nasce em cima do vão entope a entrada: tira a pedra e o mato do pé
      // da porta e dos dois passos que descem dela, e deixa o resto do talude plantado.
      for (let k = props.length - 1; k >= 0; k--) {
        const p = props[k];
        const naPorta = Math.hypot(p.x - x, p.y - y) < 2.2;
        const naDescida = Math.hypot(p.x - (x + c.dx), p.y - (y + c.dy)) < 1.6
          || Math.hypot(p.x - (x + c.dx * 2), p.y - (y + c.dy * 2)) < 1.6;
        if (naPorta || naDescida) props.splice(k, 1);
      }
    }
  }

  // ---- Sombra de copa ------------------------------------------------------
  // É isto que separa "morro" de "mata" na tela. A tinta de forma do GroundLayer diz em
  // que direção a encosta olha; o escuro de verdade tem de vir de alguma coisa que está
  // em cima do chão, e a única coisa assim no relevo é a árvore. Cada copa carimba um
  // borro deslocado para baixo na tela — em iso, descer na tela é andar para (+x,+y), e
  // é para lá que a luz vinda de cima projeta — colado no tronco, porque sombra que
  // descola do pé vira mancha solta no mapa.
  //
  // Fica num campo do próprio tile, igual a `shades` e `relevo`: o render só lê número,
  // nada de percorrer árvore por árvore por quadro, e é isso que permite lotar a serra
  // sem custar um draw call a mais.
  const copa = new Float32Array(W * H);
  // Pena de queda do borro, em tiles. É o que faz duas copas vizinhas encostarem uma
  // sombra na outra em vez de deixarem um vão de sol no meio da mata.
  const COPA_PENA = 0.6;
  for (const p of props) {
    if (!p.key.includes('tree')) continue;
    // Raio da copa em tiles, medido no sprite: 128px de largura é um tile de chão.
    const raio = PROP_CANOPY[p.key] ?? 0.5;
    const sx = p.x + 0.42, sy = p.y + 0.42;
    const alcance = raio + COPA_PENA;
    for (let y = Math.max(0, Math.floor(sy - alcance)); y <= Math.min(H - 1, Math.floor(sy + alcance)); y++) {
      for (let x = Math.max(0, Math.floor(sx - alcance)); x <= Math.min(W - 1, Math.floor(sx + alcance)); x++) {
        const i = y * W + x;
        // Cidade e água não recebem tinta nenhuma — contrato que já existe no relevo.
        if (flatTile(i)) continue;
        const d = Math.hypot(x + 0.5 - sx, y + 0.5 - sy);
        if (d >= alcance) continue;
        // Cheio sob a copa, linear até zero no fim da pena.
        copa[i] += d <= raio ? 1 : 1 - (d - raio) / COPA_PENA;
      }
    }
  }
  // O carimbo é por tile, e tile a tile a mata viraria tabuleiro. Duas passadas do mesmo
  // binomial que alisa a cota — é o que transforma mil copas soltas numa mancha só, que
  // é como a sombra de uma floresta se vê de cima. Tile plano e água ficam de fora da
  // média: a sombra da encosta não sangra para o asfalto do lado.
  const borrarCopa = new Float32Array(W * H);
  for (let passo = 0; passo < 2; passo++) {
    borrarCopa.set(copa);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (flatTile(i)) { copa[i] = 0; continue; }
        let soma = borrarCopa[i] * 4;
        let peso = 4;
        for (const [dx, dy] of DIRS4) {
          const j = (y + dy) * W + x + dx;
          if (x + dx < 0 || y + dy < 0 || x + dx >= W || y + dy >= H || flatTile(j)) continue;
          soma += borrarCopa[j] * 2;
          peso += 2;
        }
        for (const [dx, dy] of DIAS4) {
          const j = (y + dy) * W + x + dx;
          if (x + dx < 0 || y + dy < 0 || x + dx >= W || y + dy >= H || flatTile(j)) continue;
          soma += borrarCopa[j] * 2;
          peso += 2;
        }
        copa[i] = soma / peso;
      }
    }
  }
  // Ganho calibrado na medida, não no gosto. A curva é exponencial de propósito: dentro
  // da mata fechada dez copas carimbam o mesmo losango, e o que se quer é que ele encoste
  // no escuro sem virar uma placa de valor 1 igual à placa ao lado — o moteado é o que
  // ainda se lê como folha, não como tinta. Uma árvore só no campo, que é o caso claro,
  // fica no meio do caminho e não no preto.
  for (let i = 0; i < W * H; i++) copa[i] = 1 - Math.exp(-COPA_GANHO * copa[i]);

  // ---- Relevo sombreado ---------------------------------------------------
  // A luz vem de cima da tela, como em qualquer mapa topográfico: o desnível vira
  // tinta, não geometria. É isto que faz a serra aparecer sem escada de terraço — a
  // encosta que olha para a câmera escurece, o lombo que olha para o fundo clareia —
  // e como a cidade é toda plano, ali a sombra simplesmente não existe.
  const shades = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (flatTile(i)) continue;
      // Declive medido em dois tiles, não um: a diferença vizinha-a-vizinha troca de
      // sinal a cada dente do ruído, e sombra que pisca entre losango claro e losango
      // escuro é tabuleiro, não encosta. Em dois tiles o dente se cancela e sobra a
      // inclinação real do morro.
      const leste = heights[y * W + Math.min(W - 1, x + 2)];
      const oeste = heights[y * W + Math.max(0, x - 2)];
      const sul = heights[Math.min(H - 1, y + 2) * W + x];
      const norte = heights[Math.max(0, y - 2) * W + x];
      // Na projeção iso, descer na tela é andar para (+x,+y). Luz vinda de cima, como
      // em qualquer mapa: o lombo que sobe conforme desce na tela pega a luz e clareia;
      // a encosta que despenca na sua direção é a sombra. O sinal é isso — e o centro
      // tem que ser o zero, porque chão de platô não se pinta.
      // O ganho calibra o quanto de encosta satura a tinta. Com teto de declive de 0,3
      // tile/tile, um ganho linear forte pinta metade da serra inteira no mesmo preto
      // saturado — e mancha chapada de losango é exatamente a camada que se quer evitar.
      // A curva abaixo é suave e nunca encosta no teto: encosta mais forte sempre é mais
      // escura, só que sem platô de tinta.
      const g = (((leste - oeste) + (sul - norte)) / 4) * 4.2;
      shades[i] = g >= 0 ? 1 - Math.exp(-g) : Math.exp(g) - 1;
    }
  }

  // ---- Régua do relevo ----------------------------------------------------
  // Declive de 0,1 tile/tile num morro largo e declive de 0,1 numa lombada de nada não
  // significam a mesma coisa para o olho: o primeiro é serra, o segundo é chão. Sem uma
  // régua local, a tinta teria que escolher entre apagar a serra inteira ou pintar a
  // lombada como penhasco. `relevo` é o maior declive num entorno largo — a escala com
  // que aquele pedaço do mundo é medido. É filtro máximo separável (uma linha por vez),
  // então custa 2 varreduras e não 19×19 por tile.
  const RAIO = 9;
  const forca = new Float32Array(W * H);
  const relevo = new Float32Array(W * H);
  const varrido = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) forca[i] = flatTile(i) ? 0 : Math.abs(shades[i]);
  for (let y = 0; y < H; y++) {
    const base = y * W;
    for (let x = 0; x < W; x++) {
      let m = 0;
      for (let k = -RAIO; k <= RAIO; k++) {
        const nx = x + k;
        if (nx < 0 || nx >= W) continue;
        const v = forca[base + nx];
        if (v > m) m = v;
      }
      relevo[base + x] = m;
    }
  }
  // As duas varreduras escrevem em arrays separados: filtro máximo no lugar contaminaria
  // a linha de baixo com o resultado já ampliado da linha de cima.
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) {
      let m = 0;
      for (let k = -RAIO; k <= RAIO; k++) {
        const ny = y + k;
        if (ny < 0 || ny >= H) continue;
        const v = relevo[ny * W + x];
        if (v > m) m = v;
      }
      varrido[y * W + x] = m;
    }
  }
  // Cidade e água ficam fora da régua: onde o chão é asfalto não há morro a medir, e a
  // tinta da serra não pode subir na rua nem contornar o quarteirão.
  for (let i = 0; i < W * H; i++) relevo[i] = flatTile(i) ? 0 : varrido[i];

  // O nome dos lugares é a última coisa do mapa, e não por preguiça de ordem: a partição lê
  // as quadras que o gerador planejou, o facho de cada via lê o asfalto já pintado e o posto
  // já carimbado, e a travessa só sabe o próprio nome depois que o bairro existe. Antes disso
  // seria nome de rua que ninguém asfaltou.
  const nomeadora = mulberry32(seed ^ 0x6e6f6d61);
  const partição = distritosDasQuadras(blocks, xs, ys, W, H, nomeadora,
    { x0: 0, y0: northQuay + 2, x1: W, y1: southQuay });
  const vias = [
    ...viasDoGrid(tiles, W, H, xs, ys, [northQuay, southQuay], nomeadora),
    ...viasDasTravessas(ruas, partição.distritos, partição.porQuadra, nomeadora),
  ];
  // Um só índice para as duas listas: o nome da via é o que se mostra, e o id é o que o check
  // cobra sem depender de ordem de concatenação.
  vias.forEach((v, i) => { v.id = i; });
  const lugares: Lugares = { distritos: partição.distritos, vias };

  return { tilesW: W, tilesH: H, tiles, heights, shades, relevo, copa, buildings, props, vehicles,
    cascatas, cavernas, npcSpawns, playerSpawn, worldW: W, worldH: H, lugares };
}
