import { Skia, type SkImage, type SkPath } from '@shopify/react-native-skia';
import { buildingKey, propKey } from '../assets/AssetRegistry';
import { spriteStore } from '../assets/SpriteStore';
import { BUILDING_GEOMETRY } from '../assets/BuildingGeometry';
import { depthOf, worldToScreen } from '../world/IsoUtils';
import { buildingShadowDrop, lotShadow } from './ContactShadow';
import { devolverNoTempoDoDesenho } from './SkiaLifetime';
import { GAME_CONFIG } from '../game/GameConfig';
import type { GameState } from '../game/GameState';
import type { WorldStreamingManager } from '../world/streaming/WorldStreamingManager';

export interface StaticNode {
  id: string;
  img: SkImage;
  sx: number;
  sy: number;
  w: number;
  h: number;
  depth: number;
  /** Os dois losangos do lote deslocados para baixo: a sombra de contato do prédio. */
  shade?: { penumbra: SkPath; core: SkPath };
}

/**
 * Constrói os nós de desenho de UM chunk. Mesma matemática de antes, mudada de tamanho:
 * o que era um laço sobre os 4.451 estáticos do mapa inteiro no boot agora é um laço
 * sobre as ~20 estáticas de uma quadra, disparado quando aquela quadra entra na área de
 * streaming — minutos antes de entrar na tela.
 */
function buildChunk(game: GameState, chunkId: number): StaticNode[] {
  const { index } = game.streaming;
  const { data } = game.map;
  const nodes: StaticNode[] = [];
  for (const i of index.buildingsByChunk[chunkId]) {
    const b = data.buildings[i];
    const img = spriteStore[buildingKey(b.key)];
    if (!img) continue;
    // O prédio pisa o próprio terraço: o `h` é o do lote, nivelado no gerador, e o
    // sprite sobe junto com o chão em vez de ficar enterrado na encosta.
    const groundH = game.map.heightSmoothAt(b.x, b.y);
    const p = worldToScreen(b.x, b.y, groundH);
    const geometry = BUILDING_GEOMETRY[b.key];
    const scale = b.footprintW * 64 / geometry.span;
    const w = img.width() * scale, h = img.height() * scale;
    // A sombra nasce do mesmo losango do colisor: se o prédio ocupa o lote, é o lote que
    // ele escurece. Fica pré-montada aqui porque prédio não anda.
    const drop = buildingShadowDrop(h);
    const penumbra = Skia.Path.Make(), core = Skia.Path.Make();
    lotShadow(penumbra, b.x, b.y, b.footprintW, groundH, drop);
    lotShadow(core, b.x, b.y, b.footprintW, groundH, drop * 0.4);
    nodes.push({ id: `building:${i}`, img,
      sx: p.x + w / 2 - geometry.anchorX * scale, sy: p.y + h - geometry.anchorY * scale,
      w, h, depth: depthOf(b.x, b.y, groundH), shade: { penumbra, core } });
  }
  for (const i of index.propsByChunk[chunkId]) {
    const pr = data.props[i];
    const img = spriteStore[propKey(pr.key)];
    if (!img) continue;
    const groundH = game.map.heightSmoothAt(pr.x, pr.y);
    const p = worldToScreen(pr.x, pr.y, groundH);
    const scale = pr.renderScale ?? 1;
    const w = img.width() * scale, h = img.height() * scale;
    const anchor = pr.renderAnchor ?? { x: 0.5, y: 1 };
    nodes.push({ id: `prop:${i}`, img, sx: p.x + w * (0.5 - anchor.x), sy: p.y + h * (1 - anchor.y),
      w, h, depth: depthOf(pr.x, pr.y, groundH) });
  }
  return nodes;
}

/**
 * Cache dos nós estáticos por chunk, varrido pelo conjunto de chunks do streaming.
 *
 * Mora fora do componente de propósito: `SortedWorldLayer` é desmontado toda vez que o
 * jogador entra numa loja. Se o cache vivesse no React, cada porta fechada jogaria fora a
 * cidade inteira e a saída da loja custaria o pico de boot de novo — o contrário exato do
 * que o carregamento por chunk existe para evitar.
 */
class ChunkStaticCache {
  private loaded = new Map<number, StaticNode[]>();
  private out: StaticNode[] = [];

  /**
   * Prepara o mundo para esta passada e devolve os nós dos chunks visíveis, ainda sem o
   * recorte fino da névoa: quem chama decide o que entra no quadro. O array devolvido é o
   * mesmo de sempre, esvaziado na hora — varrer lista de desenhos a 8 Hz sem alocar.
   */
  collect(game: GameState, streaming: WorldStreamingManager): StaticNode[] {
    const needed = streaming.neededChunks;
    const seen = new Set<number>(needed);
    // Soltar primeiro: o chunk que saiu da área de streaming leva as sombras dele junto,
    // e é na web que isso é memória de verdade (wasm), não contêiner de JS.
    for (const [id, nodes] of this.loaded) {
      if (seen.has(id)) continue;
      this.loaded.delete(id);
      for (const node of nodes) {
        if (!node.shade) continue;
        devolverNoTempoDoDesenho(node.shade.penumbra);
        devolverNoTempoDoDesenho(node.shade.core);
      }
    }
    // Construir por prioridade: `neededChunks` já vem ordenado do mais perto para o mais
    // longe, então o teto de orçamento nunca atrasa o que está na tela — atrasa o anel
    // externo, que ainda falta minutos de caminhada para ser visto.
    let budget = GAME_CONFIG.CHUNK_BUILD_BUDGET;
    for (const id of needed) {
      if (this.loaded.has(id) || budget <= 0) continue;
      budget--;
      this.loaded.set(id, buildChunk(game, id));
    }
    let residentes = 0;
    for (const nodes of this.loaded.values()) residentes += nodes.length;
    streaming.reportCache(this.loaded.size, residentes);
    const out = this.out;
    out.length = 0;
    for (const id of streaming.visibleChunks) {
      const nodes = this.loaded.get(id);
      if (!nodes) continue;
      for (const node of nodes) out.push(node);
    }
    return out;
  }
}

const caches = new WeakMap<GameState, ChunkStaticCache>();

/** Um cache por partida: o `GameState` é o dono do mundo, e é com ele que o cache morre. */
export function staticNodesFor(game: GameState, streaming: WorldStreamingManager): StaticNode[] {
  let cache = caches.get(game);
  if (!cache) caches.set(game, cache = new ChunkStaticCache());
  return cache.collect(game, streaming);
}
