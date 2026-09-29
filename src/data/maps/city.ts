import { GAME_CONFIG } from '../../game/GameConfig';
import type { Biome, Dir4, TileKind } from '../../game/GameConfig';
import { BUILDING_CATALOG } from '../buildings';
import type { BuildingCatalogEntry } from '../buildings';
import { CIVILIAN_VEHICLES, VEHICLE_DEFS } from '../vehicles';

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

export interface MapTile {
  kind: TileKind;
  key: string;
  biome: Biome;
  /** One-way straight lane; null only inside a 2x2 junction. */
  lane?: Dir4 | null;
  bridge?: boolean;
  /** Reserved for secondary roads; avenues always remain asphalt. */
  secondary?: boolean;
}

export interface CityMapData {
  tilesW: number;
  tilesH: number;
  tiles: MapTile[];
  buildings: PlacedBuilding[];
  props: PlacedProp[];
  vehicles: PlacedVehicle[];
  npcSpawns: { x: number; y: number }[];
  playerSpawn: { x: number; y: number };
  worldW: number;
  worldH: number;
}

type Rect = { x0: number; y0: number; x1: number; y1: number };
type Block = Rect & { col: number; row: number; biome: Biome; special?: BuildingCatalogEntry };
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
const PROP_BUDGET = { urban: 150, fences: 72, forestTrees: 200, forestDetails: 16,
  countryside: 64, beach: 40, pinewood: 56, savanna: 36, desert: 96 } as const;
type PropBudget = keyof typeof PROP_BUDGET;
const MAX_PROPS = 756;
const MAX_VEHICLES = 120;
const MAX_SPAWNS = 700;
const FENCE_THICKNESS = 0.12;
const FENCE_GATE = 1; // Full AABB-to-AABB opening, not distance between anchors.

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
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

export function generateCity(seed = 20260909): CityMapData {
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
  // Broad forest clearings, field strips and dunes, rather than per-tile noise.
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const t = tiles[y * W + x];
      if (t.kind === 'water') continue;
      if (t.biome === 'forest' && (Math.floor(x / 6) + Math.floor(y / 5)) % 4 === 0) {
        Object.assign(t, { kind: 'dirt', key: 'tile_ground_dirt_grasspatch' });
      } else if (t.biome === 'countryside' && Math.floor(y / 3) % 4 === 0) {
        Object.assign(t, { kind: 'dirt', key: 'tile_ground_dirt_drypatch' });
      } else if (t.biome === 'pinewood' && (Math.floor(x / 5) + Math.floor(y / 8)) % 3 === 0) {
        Object.assign(t, { kind: 'dirt', key: 'tile_ground_dirt_grasspatch' });
      } else if (t.biome === 'savanna' && (Math.floor(x / 7) + Math.floor(y / 4)) % 3 === 0) {
        Object.assign(t, { kind: 'grass', key: GRASS });
      } else if (t.biome === 'beach' && y < riverTop - 2 && Math.floor(x / 5) % 5 === 0) {
        // Faixa seca para dentro da restinga: a areia molhada da margem fica perto do rio.
        t.key = DUST;
      } else if (t.biome === 'desert' && (Math.floor(x / 9) + Math.floor(y / 6)) % 3 === 0) {
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
          lane: lane === 0 ? 'NW' : 'SE', bridge: false, secondary: false,
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
          kind: 'road', bridge, secondary: false,
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

  // Deterministic civic reservations guarantee services in their mapped districts.
  for (const [name, biome, targetX, targetY] of [
    ['bld_hospital_a', 'commercial', 0.57, 0.35],
    ['bld_policestation_a', 'downtown', 0.44, 0.35],
    ['bld_policestation_a', 'downtown', 0.44, 0.73],
    ['bld_policestation_a', 'suburb', 0.85, 0.73],
    ['bld_gunshop_a', 'commercial', 0.66, 0.35],
  ] as const) {
    const entry = BUILDING_CATALOG.find((e) => e.name === name);
    const candidates = blocks.filter((b) => b.biome === biome && !b.special &&
      (targetY < 0.5 ? b.y1 <= northQuay : b.y0 >= southQuay + 2));
    candidates.sort((a, b) =>
      Math.hypot((a.x0 + a.x1) / 2 - W * targetX, (a.y0 + a.y1) / 2 - H * targetY)
      - Math.hypot((b.x0 + b.x1) / 2 - W * targetX, (b.y0 + b.y1) / 2 - H * targetY));
    if (!entry || !candidates.length) throw new Error(`No civic lot for ${name}`);
    candidates[0].special = entry;
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
    countryside: 0, beach: 0, pinewood: 0, savanna: 0, desert: 0 };
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
    // Every court has an unobstructed two-tile entrance between the front lots.
    reservePath({ x0: cx - 1, x1: cx + 1, y0: b.y0, y1: b.y1 }, natural);
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
      for (const [x0, x1] of [[b.x0 + 2, cx - 1], [cx + 1, b.x1 - 2]]) {
        eachCell({ x0, x1, y0: b.y1 - 5, y1: b.y1 - 2 }, (x, y) => {
          parking[y * W + x] = 1;
          Object.assign(tiles[y * W + x], { kind: 'concrete', key: ASPHALT });
        });
        for (const y of [b.y1 - 4.3, b.y1 - 2.7]) parkingSlots.push({ x: (x0 + x1) / 2, y });
      }
      // Open side forecourts act as driveways; sidewalks remain continuous concrete.
      for (const [x0, x1] of [[b.x0, cx - 1], [cx + 1, b.x1]]) {
        eachCell({ x0, x1, y0: b.y1 - 4, y1: b.y1 - 3 }, (x, y) => {
          Object.assign(tiles[y * W + x], { kind: 'concrete', key: CONCRETE });
        });
      }
    }

    const palette = blockPalette(b.biome, rng);
    if (b.special) {
      // Beside, not across, the court's central pedestrian entrance.
      if (!commitBuilding(b.special, cx - 1.4, bottom)) throw new Error(`Blocked civic lot: ${b.special.name}`);
    }
    if (palette) {
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
        // Os lotes vão até a borda do corredor protegido (cx-1 / cx+1), nunca além:
        // a cobertura do céu da quadra continua sendo a entrada pedonal oficial.
        for (const [start, end] of [[left, cx - 1], [cx + 1, right]]) {
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
            walkway[y * W + x] = 1;
            Object.assign(tiles[y * W + x], { kind: 'concrete', key: ASPHALT });
          }
        }
      }
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
      urbanSites.push({ key: 'prop_lightpole_a', x: cx + 1.7, y: bottom - 0.1 });
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
    const spacing = biome === 'forest' || biome === 'pinewood' ? 2.5 : biome === 'savanna' ? 3.5
      : biome === 'desert' ? 4.5 : 4;
    const keys = {
      forest: ['prop_tree_common_large', 'prop_tree_common_medium', 'prop_tree_pine_medium', 'prop_tree_pine_small'],
      countryside: ['prop_flowers_yellow', 'prop_flowers_red', 'prop_weed_medium', 'prop_tree_common_medium', 'prop_flowers_pink'],
      beach: ['prop_rocks_brown_a', 'prop_rocks_gray_b', 'prop_weed_small_dry', 'prop_trunk_b', 'prop_weed_medium_dry'],
      pinewood: ['prop_tree_pine_tall', 'prop_tree_pine_tall', 'prop_tree_pine_medium', 'prop_tree_pine_small'],
      savanna: ['prop_weed_small_dry', 'prop_weed_small_dry', 'prop_rocks_brown_a', 'prop_tree_common_medium', 'prop_trunk_b'],
      desert: ['prop_rocks_gray_a', 'prop_weed_medium_dry', 'prop_rocks_brown_b', 'prop_weed_large_b_dry',
        'prop_trunk_c', 'prop_tire_buried_a', 'prop_rocks_gray_c'],
    }[biome];
    const sites: Point[] = [];
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
          addProp(keys[Math.floor(sceneryRng() * keys.length)], p.x, p.y, budget);
          if (propCounts[budget] > before && ++planted === 5) break;
        }
      }
    }
    for (const p of orderedSites) {
      const details = biome === 'forest' && propCounts.forestTrees >= PROP_BUDGET.forestTrees;
      const choices = details ? ['prop_trunk_a', 'prop_rocks_gray_b', 'prop_weed_medium'] : keys;
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
  const npcSpawns = shuffle(candidates.filter((p) => Math.hypot(p.x - playerSpawn.x, p.y - playerSpawn.y) > 1), rng).slice(0, MAX_SPAWNS);

  return { tilesW: W, tilesH: H, tiles, buildings, props, vehicles, npcSpawns, playerSpawn, worldW: W, worldH: H };
}
