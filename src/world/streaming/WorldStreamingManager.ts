import { GAME_CONFIG } from '../../game/GameConfig';
import { ChunkIndex, type ChunkId, type WorldRect } from './ChunkIndex';
import { zonesFor, type StreamingZones } from './StreamingBounds';

/**
 * Camadas que uma posição do mundo pode ocupar. O número cresce do que não existe para
 * o que está na tela, porque as decisões são sempre "corte o que está mais longe":
 * `OUTSIDE` não tem nó de desenho nem simulação; `DISTANT` tem o mundo carregado e
 * espera; `ACTIVE` simula; `VISIBLE` pode estar em qualquer ponto da tela.
 */
export const TIER = {
  OUTSIDE: 0,
  DISTANT: 1,
  ACTIVE: 2,
  VISIBLE: 3,
} as const;
export type StreamingTier = (typeof TIER)[keyof typeof TIER];

/** O que o gestor lê do jogo a cada tick. Deliberadamente um dado, não o GameState. */
export interface StreamingContext {
  /** Âncora das zonas: o ponto que a câmera mira, em tiles. */
  ax: number;
  ay: number;
  zoom: number;
  /** Footprint da câmera em tiles, já dilatado pelo relevo (`FogSystem.worldBounds`). */
  viewBounds: WorldRect;
}

export interface StreamingStats {
  fps: number;
  frameMs: number;
  /** Tempo médio do `GameState.update` no último segundo: é o custo do GameLoop puro. */
  updateMs: number;
  /** Tempo da última passada de visibilidade no render. */
  cullMs: number;
  visibleChunks: number;
  activeChunks: number;
  loadedChunks: number;
  /** Nós de desenho residentes no cache de chunks (prédios + adornos). */
  staticNodes: number;
  drawnStatics: number;
  visibleEntities: number;
  simulatedEntities: number;
  /** Só pedestres: é o número que diz se a IA está de fato parada longe da câmera. */
  activeNpcs: number;
  totalEntities: number;
}

const INITIAL_STATS: StreamingStats = {
  fps: 0, frameMs: 0, updateMs: 0, cullMs: 0,
  visibleChunks: 0, activeChunks: 0, loadedChunks: 0, staticNodes: 0,
  drawnStatics: 0, visibleEntities: 0, simulatedEntities: 0, activeNpcs: 0, totalEntities: 0,
};

/**
 * Dono das três zonas do mundo. Uma instância por partida, alimentada pelo `GameLoop`,
 * lida pelo render: as decisões de carga acontecem fora da árvore React, e a árvore só
 * pergunta "o que deste conjunto eu desenho?".
 *
 * O laço é o de sempre: câmera → footprint → coordenada de chunk → conjunto de chunks →
 * objetos visíveis → Skia. Nunca "todos os objetos do mapa → verificar um por um".
 */
export class WorldStreamingManager {
  readonly index: ChunkIndex;
  /** Chunks do footprint da câmera, do mais perto para o mais longe. */
  visibleChunks: ChunkId[] = [];
  /** Chunks que precisam de nós de desenho: é a ordem de construção, por prioridade. */
  neededChunks: ChunkId[] = [];
  /** Chunks dentro da zona de simulação completa. */
  activeChunks: ChunkId[] = [];
  zones: StreamingZones;
  stats: StreamingStats = { ...INITIAL_STATS };
  private key = '';
  private frames = 0;
  private frameSum = 0;
  private updateSum = 0;
  private elapsed = 0;

  constructor(index: ChunkIndex) {
    this.index = index;
    this.zones = zonesFor(0, 0, { minX: -32, minY: -32, maxX: 32, maxY: 32 });
  }

  /**
   * Atualiza as zonas. Devolve `true` quando o conjunto de chunks mudou, ou seja,
   * quando o render tem trabalho a fazer: é o único motivo de acordar o React por causa
   * de câmera, em vez de varrer o mundo inteiro a cada 120 ms.
   */
  update(ctx: StreamingContext): boolean {
    // Quantizado em meio tile, do mesmo jeito que o bake do chão: enquanto a câmera não
    // andar meio tile, o conjunto de chunks é o mesmo e recomputá-lo é trabalho zero.
    const key = `${Math.round(ctx.ax * 2)},${Math.round(ctx.ay * 2)},${Math.round(ctx.zoom * 100)},` +
      `${Math.round(ctx.viewBounds.minX)},${Math.round(ctx.viewBounds.maxX)},` +
      `${Math.round(ctx.viewBounds.minY)},${Math.round(ctx.viewBounds.maxY)}`;
    if (key === this.key) return false;
    this.key = key;
    this.zones = zonesFor(ctx.ax, ctx.ay, ctx.viewBounds);
    const { visible, active, streaming } = this.zones;
    const scratch: ChunkId[] = [];
    const needed = this.byDistance(this.index.chunkIdsIn(streaming, scratch), ctx.ax, ctx.ay);
    // O teto existe para o mapa crescer, não para o mapa atual: 225 chunks de 16 tiles
    // não caberiam inteiros dentro dele, e o que passa do limite é justamente o mais
    // longe — o único que a câmera não alcança antes de o conjunto ser recalculado.
    this.neededChunks = needed.length > GAME_CONFIG.CHUNK_CACHE_LIMIT
      ? needed.slice(0, GAME_CONFIG.CHUNK_CACHE_LIMIT) : needed;
    this.visibleChunks = this.byDistance(this.index.chunkIdsIn(visible, []), ctx.ax, ctx.ay);
    this.activeChunks = this.byDistance(this.index.chunkIdsIn(active, []), ctx.ax, ctx.ay);
    this.stats.visibleChunks = this.visibleChunks.length;
    this.stats.activeChunks = this.activeChunks.length;
    return true;
  }

  /** Ordenação de prioridade (§14): o que está na tela é o primeiro a ser construído. */
  private byDistance(ids: ChunkId[], ax: number, ay: number): ChunkId[] {
    return ids.sort((a, b) => this.dist2(a, ax, ay) - this.dist2(b, ax, ay));
  }

  private dist2(id: ChunkId, ax: number, ay: number): number {
    const dx = this.index.centerX(id) - ax;
    const dy = this.index.centerY(id) - ay;
    return dx * dx + dy * dy;
  }

  /** Camada de um ponto: retângulo primeiro, distância depois, porque é o teste barato. */
  tierOf(x: number, y: number): StreamingTier {
    const z = this.zones;
    if (x >= z.visible.minX && x <= z.visible.maxX && y >= z.visible.minY && y <= z.visible.maxY) {
      return TIER.VISIBLE;
    }
    const dx = x - z.ax;
    const dy = y - z.ay;
    const d2 = dx * dx + dy * dy;
    if (d2 <= z.active2) return TIER.ACTIVE;
    return d2 <= z.streaming2 ? TIER.DISTANT : TIER.OUTSIDE;
  }

  /** Dentro da zona que simula por inteiro? É o corte usado por pedestre e trânsito. */
  isSimulated(x: number, y: number): boolean {
    const z = this.zones;
    if (x < z.active.minX || x > z.active.maxX || y < z.active.minY || y > z.active.maxY) return false;
    const dx = x - z.ax;
    const dy = y - z.ay;
    return dx * dx + dy * dy <= z.active2;
  }

  /** Dentro do footprint da câmera? É o pré-filtro das camadas de marcador e semáforo. */
  isInView(x: number, y: number): boolean {
    const v = this.zones.visible;
    return x >= v.minX && x <= v.maxX && y >= v.minY && y <= v.maxY;
  }

  needsChunk(id: ChunkId): boolean {
    return this.neededChunks.indexOf(id) >= 0;
  }

  /** O render conta o que manteve residente; a métrica é lida pelo painel e pelo check. */
  reportCache(loadedChunks: number, staticNodes: number): void {
    this.stats.loadedChunks = loadedChunks;
    this.stats.staticNodes = staticNodes;
  }

  /**
   * Média móvel de um segundo. Contar frame a frame mostraria o jitter do relógio do
   * navegador em vez do que o jogador sente, e o painel serviria para nada.
   */
  noteFrame(dt: number, updateMs: number): void {
    this.frames++;
    this.frameSum += dt;
    this.updateSum += updateMs;
    this.elapsed += dt;
    if (this.elapsed < 1) return;
    this.stats.fps = Math.round(this.frames / this.elapsed);
    this.stats.frameMs = Math.round((this.elapsed / this.frames) * 1000 * 10) / 10;
    this.stats.updateMs = Math.round((this.updateSum / this.frames) * 100) / 100;
    this.frames = 0;
    this.frameSum = 0;
    this.updateSum = 0;
    this.elapsed = 0;
  }
}
