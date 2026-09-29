"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.visibleWorldAabb = visibleWorldAabb;
exports.inAabb = inAabb;
const GameConfig_1 = require("../game/GameConfig");
/** Aproximação da área de mundo visível a partir da câmera isométrica. */
function visibleWorldAabb(cam, viewW, viewH, margin = GameConfig_1.GAME_CONFIG.VIEW_CULL_MARGIN) {
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
function inAabb(x, y, b, pad = 0) {
    return x >= b.minX - pad && x <= b.maxX + pad && y >= b.minY - pad && y <= b.maxY + pad;
}
