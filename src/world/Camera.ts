import { GAME_CONFIG, type Dir4 } from '../game/GameConfig';
import { FRONTEIRA_ALCANCE } from './Frontier';

export interface CameraState {
  x: number;
  y: number;
  targetX: number;
  targetY: number;
  zoom: number;
  /** Altura do chão sob a câmera, em tiles. Transla a tela para cima; nunca gira nada. */
  h: number;
}

export function createCamera(x: number, y: number): CameraState {
  return { x, y, targetX: x, targetY: y, zoom: GAME_CONFIG.ZOOM_DEFAULT, h: 0 };
}

export function cameraFollow(
  cam: CameraState,
  followX: number,
  followY: number,
  lookX: number,
  lookY: number,
  dt: number,
  mapWorldW: number,
  mapWorldH: number,
) {
  cam.targetX = followX + lookX * GAME_CONFIG.CAMERA_LOOKAHEAD;
  cam.targetY = followY + lookY * GAME_CONFIG.CAMERA_LOOKAHEAD;

  const k = 1 - Math.exp(-GAME_CONFIG.CAMERA_LERP * dt);
  cam.x += (cam.targetX - cam.x) * k;
  cam.y += (cam.targetY - cam.y) * k;
}

export function clampToMap(
  cam: CameraState,
  mapWorldW: number,
  mapWorldH: number,
  viewW: number,
  viewH: number,
) {
  const marginX = viewW / (2 * cam.zoom * 128);
  const marginY = viewH / (2 * cam.zoom * 64);
  // A mata sem fim é mundo, então a câmera entra nela junto com o jogador: sem este alcance,
  // quem anda para fora some atrás de uma borda de tela que parou na última rua. O alcance é
  // o MESMO do `limiteJogável` — câmera e corpo têm de parar no mesmo tile, ou o jogador anda
  // para fora do próprio enquadramento.
  cam.x = Math.max(-marginX - FRONTEIRA_ALCANCE, Math.min(mapWorldW + marginX + FRONTEIRA_ALCANCE, cam.x));
  cam.y = Math.max(-marginY - FRONTEIRA_ALCANCE, Math.min(mapWorldH + marginY + FRONTEIRA_ALCANCE, cam.y));
}

export function setZoom(cam: CameraState, zoom: number, mapWorldW: number, mapWorldH: number, viewW: number, viewH: number) {
  cam.zoom = Math.max(GAME_CONFIG.ZOOM_MIN, Math.min(GAME_CONFIG.ZOOM_MAX, zoom));
  clampToMap(cam, mapWorldW, mapWorldH, viewW, viewH);
}

function fit(value: number, min: number, max: number) {
  // A viewport larger than the axis has no valid range: centre it instead.
  return max < min ? (min + max) / 2 : Math.max(min, Math.min(max, value));
}

/** Rooms are a screen diamond: both axes span roomW + roomH in projected tiles. */
export function roomBounds(roomW: number, roomH: number) {
  const half = (roomW + roomH) / 2;
  return { u: roomW / 2 - roomH / 2, v: half, halfU: half, halfV: half };
}

/** Keep the whole viewport inside the room so the player never sees past the walls. */
export function clampToRoom(
  cam: CameraState,
  roomW: number,
  roomH: number,
  viewW: number,
  viewH: number,
) {
  const { u, v, halfU, halfV } = roomBounds(roomW, roomH);
  const visibleU = viewW / (2 * cam.zoom * 64);
  const visibleV = viewH / (2 * cam.zoom * 32);
  const cu = fit(cam.x - cam.y, u - halfU + visibleU, u + halfU - visibleU);
  const cv = fit(cam.x + cam.y, v - halfV + visibleV, v + halfV - visibleV);
  cam.x = (cu + cv) / 2;
  cam.y = (cv - cu) / 2;
}

/**
 * Close-up zoom that keeps the character the SAME size in every interior. It is measured
 * against a reference room, not the actual one: a bigger room (the penitenciária) stays
 * at the same scale and simply pans via `clampToRoom`, instead of shrinking the player.
 */
const INDOOR_REF_SPAN = 12;
export function indoorZoom(_roomW: number, _roomH: number, viewW: number, viewH: number) {
  return Math.min(2.6, Math.max(GAME_CONFIG.ZOOM_INDOORS,
    viewW / (64 * INDOOR_REF_SPAN), viewH / (32 * INDOOR_REF_SPAN)));
}
