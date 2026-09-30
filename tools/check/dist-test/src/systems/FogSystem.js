"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FogSystem = exports.FOG = void 0;
exports.fogRadii = fogRadii;
const GameConfig_1 = require("../game/GameConfig");
const IsoUtils_1 = require("../world/IsoUtils");
const clamp = (x) => Math.max(0, Math.min(1, x));
function target({ timeOfDay, rain, cover, dark, snow, biome }) {
    const t = Number.isFinite(timeOfDay) ? ((timeOfDay % 1) + 1) % 1 : 0.5;
    // Neve usa a mesma intensidade da chuva, mas tinta para branco frio em vez de cinza molhado.
    const wet = !snow && Number.isFinite(rain) ? clamp(rain) : 0;
    const white = snow && Number.isFinite(rain) ? clamp(rain) : 0;
    const cloud = Number.isFinite(cover) ? clamp(cover ?? 0) : 0;
    // O perigo fecha o céu por cima das nuvens: menos luz do dia, mais parede de névoa.
    const gloom = Number.isFinite(dark) ? clamp(dark ?? 0) : 0;
    const daylight = (t < 0.2 || t > 0.86 ? 0 : t < 0.3 ? (t - 0.2) / 0.1 : t < 0.72 ? 1 : (0.86 - t) / 0.14)
        * (1 - cloud * 0.55) * (1 - gloom * 0.5);
    const warm = Math.max(0, 1 - Math.abs(t - 0.27) / 0.07, 1 - Math.abs(t - 0.8) / 0.08);
    // Tinted shade rather than a pale gray wall. Match the local landscape at the opaque rim,
    // but keep hue muted and dark: a saturated mid-tone washes the whole visible scene.
    const base = biome === 'pinewood' ? [34, 56, 52] : biome === 'forest' || biome === 'park' ? [44, 60, 46]
        : biome === 'savanna' ? [96, 80, 48] : biome === 'countryside' ? [66, 76, 50]
            : biome === 'desert' ? [104, 90, 62]
                : biome === 'beach' || biome === 'docks' ? [56, 86, 90]
                    : biome === 'industrial' ? [68, 62, 54] : [50, 66, 70];
    const night = [15, 27, 43];
    const rgb = base.map((v, i) => (night[i] + (v - night[i]) * daylight) * (1 - wet * 0.22 - white * 0.12)
        + [24, 7, -5][i] * warm + [0, 5, 10][i] * wet + [30, 34, 38][i] * white);
    const wooded = biome === 'forest' || biome === 'pinewood';
    return { rgb, clarity: 0.60 - wet * 0.09 - white * 0.11 - cloud * 0.03 - gloom * 0.05
            - (1 - daylight) * 0.035 - (wooded ? 0.025 : 0) };
}
function publish(rgb, clarity) {
    const [r, g, b] = rgb.map((v) => Math.round(Math.max(0, Math.min(255, v))));
    const color = '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
    return {
        color, clarity,
        positions: [0, clarity, clarity + (1 - clarity) * 0.32, clarity + (1 - clarity) * 0.62,
            clarity + (1 - clarity) * 0.84, 1],
        colors: [0, 0, 0.10, 0.32, 0.72].map((a) => `rgba(${r},${g},${b},${a})`).concat(color),
    };
}
const INITIAL = target({ timeOfDay: 0.5, rain: 0, biome: 'countryside' });
exports.FOG = { ...publish(INITIAL.rgb, INITIAL.clarity), padding: 112 };
/** Fixed outer envelope: weather changes inner clarity, NEVER the culling/bake footprint.
 * Small radius increase + much wider transparent center, while retaining a hidden opaque apron.
 */
function fogRadii(width, height, zoom) {
    'worklet';
    return { x: Math.min(width * 0.495, 520 * zoom), y: Math.min(height * 0.59, 310 * zoom) };
}
class FogSystem {
    constructor() {
        this.rgb = [...INITIAL.rgb];
        this.clarity = INITIAL.clarity;
        this.published = exports.FOG;
    }
    get snapshot() { return this.published; }
    /** Smooth biome/weather transitions; pause/invalid dt does not publish or advance. */
    update(dt, environment) {
        if (!Number.isFinite(dt) || dt <= 0)
            return this.published;
        const next = target(environment);
        const blend = 1 - Math.exp(-Math.min(dt, 0.25) * 1.8);
        this.rgb = this.rgb.map((v, i) => v + (next.rgb[i] - v) * blend);
        this.clarity += (next.clarity - this.clarity) * blend;
        this.published = publish(this.rgb, this.clarity);
        return this.published;
    }
    view({ camera, viewW, viewH }) {
        const radius = fogRadii(viewW, viewH, camera.zoom);
        // Centro da tela = a projeção DO PONTO ELEVADO que a câmera mira, a mesma fórmula
        // do transform da câmera. Sem o `h` o descarte de tiles e a neblina ficariam
        // deslocados para baixo assim que o jogador subisse no morro.
        const center = (0, IsoUtils_1.worldToScreen)(camera.x, camera.y, camera.h);
        return { x: center.x, y: center.y,
            radiusX: radius.x / camera.zoom, radiusY: radius.y / camera.zoom };
    }
    intersects(view, x, y, width, height, padding = exports.FOG.padding) {
        // Keep a hidden apron for camera motion, shake and the interval between culling passes.
        const dx = Math.max(x - padding - view.x, 0, view.x - x - width - padding) / view.radiusX;
        const dy = Math.max(y - padding - view.y, 0, view.y - y - height - padding) / view.radiusY;
        return dx * dx + dy * dy <= 1;
    }
    worldBounds(view) {
        const x = view.x / 128 + view.y / 64;
        const y = view.y / 64 - view.x / 128;
        // Um tile elevado é pintado na posição plana de (tx-h, ty-h): para a crista da
        // montanha entrar no window de bake, a varredura tem que ir `climb` tiles além.
        // Simétrico de propósito — o AABB continua sendo a janela centrada na vista, e quem
        // decide o que realmente se desenha é o intersects com a altura de cada tile.
        const climb = GameConfig_1.GAME_CONFIG.TERRAIN_MAX_LEVEL * GameConfig_1.GAME_CONFIG.TERRAIN_LEVEL_TILES;
        const extent = Math.hypot(view.radiusX / 128, view.radiusY / 64)
            + exports.FOG.padding / 128 + exports.FOG.padding / 64 + 1 + climb;
        return { minX: x - extent, maxX: x + extent, minY: y - extent, maxY: y + extent };
    }
}
exports.FogSystem = FogSystem;
