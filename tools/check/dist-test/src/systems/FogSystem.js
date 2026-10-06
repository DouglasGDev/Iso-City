"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FogSystem = exports.FOG = void 0;
exports.nevoaCores = nevoaCores;
exports.aberturaDaParede = aberturaDaParede;
exports.fogRadii = fogRadii;
const GameConfig_1 = require("../game/GameConfig");
const IsoUtils_1 = require("../world/IsoUtils");
const clamp = (x) => Math.max(0, Math.min(1, x));
function target({ timeOfDay, rain, cover, mist, dark, snow, biome }) {
    const t = Number.isFinite(timeOfDay) ? ((timeOfDay % 1) + 1) % 1 : 0.5;
    // Neve usa a mesma intensidade da chuva, mas tinta para branco frio em vez de cinza molhado.
    const wet = !snow && Number.isFinite(rain) ? clamp(rain) : 0;
    const white = snow && Number.isFinite(rain) ? clamp(rain) : 0;
    const cloud = Number.isFinite(cover) ? clamp(cover ?? 0) : 0;
    // Névoa não molha e não escurece: ela clareia e chega mais perto. É o único termo que
    // encolhe de verdade a distância visível, e é por isso que a frente de névoa se percebe.
    const haze = Number.isFinite(mist) ? clamp(mist ?? 0) : 0;
    // O perigo fecha o céu por cima das nuvens: menos luz do dia, mais parede de névoa.
    const gloom = Number.isFinite(dark) ? clamp(dark ?? 0) : 0;
    const daylight = (t < 0.2 || t > 0.86 ? 0 : t < 0.3 ? (t - 0.2) / 0.1 : t < 0.72 ? 1 : (0.86 - t) / 0.14)
        * (1 - cloud * 0.55) * (1 - haze * 0.3) * (1 - gloom * 0.5);
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
        + [24, 7, -5][i] * warm * (1 - haze) + [0, 5, 10][i] * wet + [30, 34, 38][i] * white
        // A névoa é clara: a parede passa por cima da cor do bioma em vez de escurecê-la.
        + [86, 90, 94][i] * haze);
    const wooded = biome === 'forest' || biome === 'pinewood';
    return { rgb, clarity: 0.60 - wet * 0.09 - white * 0.11 - cloud * 0.03 - haze * 0.24 - gloom * 0.05
            - (1 - daylight) * 0.035 - (wooded ? 0.025 : 0) };
}
/** Os degraus de tinta até a borda. O stop final é a cor cheia da parede, publicada no instantâneo. */
const NEVOA = [0, 0, 0.10, 0.32, 0.72];
/**
 * As tintas da parede com o quanto da névoa já ficou para baixo de quem olha.
 *
 * `abrir` escala a ALFA e não a geometria de propósito: a única parede que existe no céu claro lá de
 * cima é a moldura, e empurrar o losango para fora dela custaria assar chão que nenhum pixel mostra,
 * enquanto apagar a tinta custa zero e devolve o canto do quadro para o algodão.
 */
function nevoaCores(rgb, abrir, opaca) {
    'worklet';
    const forca = 1 - Math.max(0, Math.min(1, Number.isFinite(abrir) ? abrir : 0));
    const [r, g, b] = rgb;
    const degraus = NEVOA.map((a) => `rgba(${r},${g},${b},${(a * forca).toFixed(3)})`);
    // A borda é a cor cheia do bioma: é ela que fecha o canto do quadro na rua, e o contrato
    // publicado é que o último stop É o `color` do instantâneo enquanto a parede está inteira.
    return forca === 1 ? degraus.concat(opaca) : degraus.concat(`rgba(${r},${g},${b},${forca.toFixed(3)})`);
}
/**
 * Quanto da névoa do chão ficou para trás, 0..1, medido na altura da CÂMERA e não na cota.
 *
 * A parede existe porque o ar do rodapé do mundo tem alcance; ela não é um desenho do quadro, é o
 * horizonte próximo. Quando a câmera é obrigada a sair do plano do chão para a máquina continuar no
 * quadro, o alcance que resta é o da própria moldura — e é exatamente aí que a parede deve sumir.
 * A curva começa um tile acima do morro mais alto do mapa (4) e fecha seis tiles depois, onde o
 * anchor da câmera para de subir porque a lataria estourou a folga do quadro. No chão ela é zero por
 * construção, e isso não é detalhe de gosto: é o que garante que a rua, o mato e a chuva não se
 * moveram um pixel.
 */
function aberturaDaParede(alturaDaCamera) {
    'worklet';
    if (!Number.isFinite(alturaDaCamera) || alturaDaCamera <= 5)
        return 0;
    const t = Math.min(1, (alturaDaCamera - 5) / 6);
    return t * t * (3 - 2 * t);
}
function publish(rgb, clarity) {
    const [r, g, b] = rgb.map((v) => Math.round(Math.max(0, Math.min(255, v))));
    const color = '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
    return {
        color, clarity, rgb: [r, g, b],
        positions: [0, clarity, clarity + (1 - clarity) * 0.32, clarity + (1 - clarity) * 0.62,
            clarity + (1 - clarity) * 0.84, 1],
        colors: nevoaCores([r, g, b], 0, color),
    };
}
const INITIAL = target({ timeOfDay: 0.5, rain: 0, biome: 'countryside' });
exports.FOG = { ...publish(INITIAL.rgb, INITIAL.clarity), padding: 112 };
/** Fixed outer envelope: weather changes inner clarity, NEVER the culling/bake footprint.
 * Small radius increase + much wider transparent center, while retaining a hidden opaque apron.
 *
 * O termo `520 * zoom` é a névoa, não a moldura: lá embaixo é ele que decide o que se vê, e o cap de
 * tela só segura o que a moldura já cortaria de qualquer jeito. Subindo, a névoa dilata até o cap
 * encostar na moldura e PARA ali — passar disso seria assar mundo fora do quadro. O que continua
 * sendo fixo contra o clima é o footprint; a altitude é outro regime, e ela sim move a janela.
 */
function fogRadii(width, height, zoom, alturaDaCamera = 0) {
    'worklet';
    const dilata = 1 + aberturaDaParede(alturaDaCamera) * 1.5;
    return { x: Math.min(width * 0.495, 520 * zoom * dilata), y: Math.min(height * 0.59, 310 * zoom * dilata) };
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
        const radius = fogRadii(viewW, viewH, camera.zoom, camera.h);
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
        const climb = GameConfig_1.GAME_CONFIG.TERRAIN_MAX_ELEVATION;
        const extent = Math.hypot(view.radiusX / 128, view.radiusY / 64)
            + exports.FOG.padding / 128 + exports.FOG.padding / 64 + 1 + climb;
        return { minX: x - extent, maxX: x + extent, minY: y - extent, maxY: y + extent };
    }
}
exports.FogSystem = FogSystem;
