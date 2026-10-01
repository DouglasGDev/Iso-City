import { GAME_CONFIG } from '../game/GameConfig';
import type { Map } from '../world/Map';

export interface Steppable {
  x: number;
  y: number;
}

/**
 * O relevo como regra de movimento. Não existe geometria nova: altura é comparação de
 * nível entre tiles, então a montanha barra o passo exatamente como um muro barra — e
 * é por isso que a câmera continua isométrica e o depth sort continua valendo.
 */
export class TerrainSystem {
  /**
   * Reverte o eixo que o pedestre não alcança: acima de `TERRAIN_STEP_UP_TILES` é
   * parede, abaixo de `-TERRAIN_MAX_DROP_TILES` é borda. Chamar depois de integrar e
   * depois de resolver colisão — um empurrão de carro também jogaria alguém morro
   * acima.
   */
  blockWalk(map: Map, body: Steppable, prevX: number, prevY: number) {
    if (body.x !== prevX && !map.canClimb(prevX, prevY, body.x, prevY)) body.x = prevX;
    if (body.y !== prevY && !map.canClimb(prevX, prevY, body.x, body.y)) body.y = prevY;
  }

  /** Roda não faz trilha: só passa onde a pista é suave nos dois sentidos. */
  blockDrive(map: Map, body: Steppable, prevX: number, prevY: number) {
    if (body.x !== prevX && !map.canDriveOver(prevX, prevY, body.x, prevY)) body.x = prevX;
    if (body.y !== prevY && !map.canDriveOver(prevX, prevY, body.x, body.y)) body.y = prevY;
  }

  /**
   * Ar também tem relevo: quem voa baixo contra a face de um platô é barrado pela face,
   * não içado por elevador. A cota do aparelho precisa passar acima do ressalto à frente
   * (com uma folga de casco) para o voo continuar — é assim que a montanha barra o
   * helicóptero sem nenhuma geometria nova e sem câmera em 3D.
   */
  blockFlight(map: Map, body: Steppable, prevX: number, prevY: number, elevation: number): boolean {
    const teto = elevation + GAME_CONFIG.HELI_WALL_TOLERANCE;
    const x = body.x;
    const y = body.y;
    // A face barrada é a mesma face desenhada: o talude do morro é contínuo na tela, e
    // bater no tile quantizado liberaria o casco no meio da encosta.
    if (body.x !== prevX && map.heightSmoothAt(body.x, body.y) > teto) body.x = prevX;
    if (body.y !== prevY && map.heightSmoothAt(body.x, body.y) > teto) body.y = prevY;
    return body.x !== x || body.y !== y;
  }

  /**
   * Ladeira com peso: subir custa, descer empurra. É um multiplicador de propósito —
   * física de suspensão quebraria o trânsito em grade e o isométrico com ela. A sonda
   * anda um tile inteiro e lê a superfície contínua: é o declive médio daquele trecho,
   * não o degrau do tile, que é o que fazia a velocidade piscar a cada losango cruzado.
   */
  speedFactor(map: Map, x: number, y: number, dx: number, dy: number): number {
    const len = Math.hypot(dx, dy);
    if (!(len > 1e-6)) return 1;
    const slope = map.slopeAlong(x, y, dx / len, dy / len);
    if (slope > 0) return Math.max(0.4, 1 - slope * GAME_CONFIG.TERRAIN_SLOPE_SLOW);
    if (slope < 0) return Math.min(1.2, 1 - slope * GAME_CONFIG.TERRAIN_SLOPE_SLOW * 0.5);
    return 1;
  }
}

export const terrain = new TerrainSystem();
