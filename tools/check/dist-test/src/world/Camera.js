"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createCamera = createCamera;
exports.cameraFollow = cameraFollow;
exports.clampToMap = clampToMap;
exports.setZoom = setZoom;
exports.roomBounds = roomBounds;
exports.clampToRoom = clampToRoom;
exports.indoorZoom = indoorZoom;
const GameConfig_1 = require("../game/GameConfig");
function createCamera(x, y) {
    return { x, y, targetX: x, targetY: y, zoom: GameConfig_1.GAME_CONFIG.ZOOM_DEFAULT };
}
function cameraFollow(cam, followX, followY, lookX, lookY, dt, mapWorldW, mapWorldH) {
    cam.targetX = followX + lookX * GameConfig_1.GAME_CONFIG.CAMERA_LOOKAHEAD;
    cam.targetY = followY + lookY * GameConfig_1.GAME_CONFIG.CAMERA_LOOKAHEAD;
    const k = 1 - Math.exp(-GameConfig_1.GAME_CONFIG.CAMERA_LERP * dt);
    cam.x += (cam.targetX - cam.x) * k;
    cam.y += (cam.targetY - cam.y) * k;
}
function clampToMap(cam, mapWorldW, mapWorldH, viewW, viewH) {
    const marginX = viewW / (2 * cam.zoom * 128);
    const marginY = viewH / (2 * cam.zoom * 64);
    cam.x = Math.max(-marginX, Math.min(mapWorldW + marginX, cam.x));
    cam.y = Math.max(-marginY, Math.min(mapWorldH + marginY, cam.y));
}
function setZoom(cam, zoom, mapWorldW, mapWorldH, viewW, viewH) {
    cam.zoom = Math.max(GameConfig_1.GAME_CONFIG.ZOOM_MIN, Math.min(GameConfig_1.GAME_CONFIG.ZOOM_MAX, zoom));
    clampToMap(cam, mapWorldW, mapWorldH, viewW, viewH);
}
function fit(value, min, max) {
    // A viewport larger than the axis has no valid range: centre it instead.
    return max < min ? (min + max) / 2 : Math.max(min, Math.min(max, value));
}
/** Rooms are a screen diamond: both axes span roomW + roomH in projected tiles. */
function roomBounds(roomW, roomH) {
    const half = (roomW + roomH) / 2;
    return { u: roomW / 2 - roomH / 2, v: half, halfU: half, halfV: half };
}
/** Keep the whole viewport inside the room so the player never sees past the walls. */
function clampToRoom(cam, roomW, roomH, viewW, viewH) {
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
function indoorZoom(_roomW, _roomH, viewW, viewH) {
    return Math.min(2.6, Math.max(GameConfig_1.GAME_CONFIG.ZOOM_INDOORS, viewW / (64 * INDOOR_REF_SPAN), viewH / (32 * INDOOR_REF_SPAN)));
}
