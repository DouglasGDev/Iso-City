import { GAME_CONFIG } from '../game/GameConfig';
import type { CameraState } from './Camera';

export interface WorldAabb {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** Aproximação da área de mundo visível a partir da câmera isométrica. */
export function visibleWorldAabb(cam: CameraState, viewW: number, viewH: number, margin: number = GAME_CONFIG.VIEW_CULL_MARGIN): WorldAabb {
  const halfSx = viewW / (2 * cam.zoom);
  const halfSy = viewH / (2 * cam.zoom);
  // sx=(x-y)*64, sy=(x+y)*32 → x = sx/128 + sy/64, y = sy/64 - sx/128
  const extentX = halfSx / 128 + halfSy / 64 + margin;
  const extentY = halfSy / 64 + halfSx / 128 + margin;
  return {
    minX: cam.x - extentX,
    maxX: cam.x + extentX,
    minY: cam.y - extentY,
    maxY: cam.y + extentY,
  };
}

export function inAabb(x: number, y: number, b: WorldAabb, pad = 0): boolean {
  return x >= b.minX - pad && x <= b.maxX + pad && y >= b.minY - pad && y <= b.maxY + pad;
}
