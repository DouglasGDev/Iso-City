"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.expandRect = expandRect;
exports.zonesFor = zonesFor;
const GameConfig_1 = require("../../game/GameConfig");
function expandRect(rect, margin) {
    return {
        minX: rect.minX - margin,
        minY: rect.minY - margin,
        maxX: rect.maxX + margin,
        maxY: rect.maxY + margin,
    };
}
function circleRect(cx, cy, r) {
    return { minX: cx - r, minY: cy - r, maxX: cx + r, maxY: cy + r };
}
/**
 * Uma circunferência num mundo isométrico é um retângulo inclinado de 45°, porque
 * um tile de X anda a tela para a direita-baixo e um de Y para a esquerda-baixo.
 * Medir a zona no quadrado da circunferência é a única forma honesta de usar uma
 * distância euclidiana em tiles: o tier fino ainda é feito por `dist²` abaixo, e o
 * retângulo só decide quais chunks entram no índice.
 */
function zonesFor(ax, ay, worldBounds) {
    const margin = GameConfig_1.GAME_CONFIG.CHUNK_QUERY_MARGIN;
    const visible = expandRect(worldBounds, margin);
    const activeR = GameConfig_1.GAME_CONFIG.ACTIVE_RADIUS_TILES + margin;
    // O relevo já entra no footprint visível (`FogSystem.worldBounds` dilata pela cota
    // máxima), mas a zona de carga é um círculo em tiles e a crista de uma serra do lado
    // de fora dele ainda é desenhada: a mesma cota máxima abre espaço no anel de streaming.
    const streamingR = GameConfig_1.GAME_CONFIG.STREAMING_RADIUS_TILES + margin + GameConfig_1.GAME_CONFIG.TERRAIN_MAX_ELEVATION;
    return {
        visible,
        active: circleRect(ax, ay, activeR),
        streaming: circleRect(ax, ay, streamingR),
        ax,
        ay,
        active2: GameConfig_1.GAME_CONFIG.ACTIVE_RADIUS_TILES * GameConfig_1.GAME_CONFIG.ACTIVE_RADIUS_TILES,
        streaming2: GameConfig_1.GAME_CONFIG.STREAMING_RADIUS_TILES * GameConfig_1.GAME_CONFIG.STREAMING_RADIUS_TILES,
    };
}
