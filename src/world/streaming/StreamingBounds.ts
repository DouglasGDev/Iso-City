import { GAME_CONFIG } from '../../game/GameConfig';
import type { WorldRect } from './ChunkIndex';

/** As três zonas que a câmera desenha, simula e carrega — mais a âncora que as mede. */
export interface StreamingZones {
  /** Footprint real da tela: o que pode aparecer no quadro deste instante. */
  visible: WorldRect;
  /** Círculo de simulação completa, aproximado pelo retângulo que o envolve. */
  active: WorldRect;
  /** Círculo de carga/prefetch: dentro dele o chunk existe; fora, dorme. */
  streaming: WorldRect;
  /** Âncora das medidas, em tiles de mundo (o ponto que a câmera mira). */
  ax: number;
  ay: number;
  active2: number;
  streaming2: number;
}

export function expandRect(rect: WorldRect, margin: number): WorldRect {
  return {
    minX: rect.minX - margin,
    minY: rect.minY - margin,
    maxX: rect.maxX + margin,
    maxY: rect.maxY + margin,
  };
}

function circleRect(cx: number, cy: number, r: number): WorldRect {
  return { minX: cx - r, minY: cy - r, maxX: cx + r, maxY: cy + r };
}

/**
 * Uma circunferência num mundo isométrico é um retângulo inclinado de 45°, porque
 * um tile de X anda a tela para a direita-baixo e um de Y para a esquerda-baixo.
 * Medir a zona no quadrado da circunferência é a única forma honesta de usar uma
 * distância euclidiana em tiles: o tier fino ainda é feito por `dist²` abaixo, e o
 * retângulo só decide quais chunks entram no índice.
 */
export function zonesFor(ax: number, ay: number, worldBounds: WorldRect): StreamingZones {
  const margin = GAME_CONFIG.CHUNK_QUERY_MARGIN;
  const visible = expandRect(worldBounds, margin);
  const activeR = GAME_CONFIG.ACTIVE_RADIUS_TILES + margin;
  // O relevo já entra no footprint visível (`FogSystem.worldBounds` dilata pela cota
  // máxima), mas a zona de carga é um círculo em tiles e a crista de uma serra do lado
  // de fora dele ainda é desenhada: a mesma cota máxima abre espaço no anel de streaming.
  const streamingR = GAME_CONFIG.STREAMING_RADIUS_TILES + margin + GAME_CONFIG.TERRAIN_MAX_ELEVATION;
  return {
    visible,
    active: circleRect(ax, ay, activeR),
    streaming: circleRect(ax, ay, streamingR),
    ax,
    ay,
    active2: GAME_CONFIG.ACTIVE_RADIUS_TILES * GAME_CONFIG.ACTIVE_RADIUS_TILES,
    streaming2: GAME_CONFIG.STREAMING_RADIUS_TILES * GAME_CONFIG.STREAMING_RADIUS_TILES,
  };
}
