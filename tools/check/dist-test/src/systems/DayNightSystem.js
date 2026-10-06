"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DayNightSystem = void 0;
const GameConfig_1 = require("../game/GameConfig");
/**
 * Relógio do mundo: 0 = meia-noite, 0.5 = meio-dia. Expõe opacidades de tint
 * (noite azulada + alaranjado do amanhecer/entardecer) para o render.
 */
class DayNightSystem {
    constructor() {
        this.t = GameConfig_1.GAME_CONFIG.DAY_START_T;
    }
    update(dt) {
        this.t = (this.t + dt / GameConfig_1.GAME_CONFIG.DAY_NIGHT_CYCLE_S) % 1;
    }
    /** alpha do tint noturno (0 dia, 1 noite fechada) */
    get nightAlpha() {
        const t = this.t;
        if (t < 0.2 || t > 0.86)
            return 1;
        if (t < 0.3)
            return 1 - (t - 0.2) / 0.1;
        if (t < 0.72)
            return 0;
        if (t < 0.86)
            return (t - 0.72) / 0.14;
        return 0;
    }
    /** alpha do tint laranja do crepúsculo/amanhecer */
    get warmAlpha() {
        const t = this.t;
        if (t >= 0.2 && t < 0.34)
            return 1 - Math.abs(t - 0.27) / 0.07;
        if (t >= 0.72 && t < 0.88)
            return 1 - Math.abs(t - 0.8) / 0.08;
        return 0;
    }
    get isNight() {
        return this.nightAlpha > 0.55;
    }
    get tintAlpha() {
        return this.nightAlpha * GameConfig_1.GAME_CONFIG.NIGHT_TINT_MAX;
    }
    /** "HH:MM" no relógio do jogo */
    get clock() {
        return formatT(this.t);
    }
    /**
     * O mesmo "HH:MM" um pouco mais tarde: é como um painel de embarque anuncia partida. O
     * horário do ônibus é medido em segundos de mundo (`wait` até o veículo encostar), mas o
     * telão de uma rodoviária não mostra contagem regressiva para quem vai embora daqui a meia
     * volta da cidade — mostra a hora. A volta completa do calendário é `DAY_NIGHT_CYCLE_S`,
     * então a fração do dia é o instante pedido somado a esse ciclo.
     */
    clockIn(seconds) {
        return formatT(this.t + seconds / GameConfig_1.GAME_CONFIG.DAY_NIGHT_CYCLE_S);
    }
}
exports.DayNightSystem = DayNightSystem;
/**
 * "HH:MM" a partir da fração do dia, enrolando na meia-noite. O epsilão não é decoração: a
 * fração de um dia é soma de quocientes binários, e meia-volta de dia mais sessenta segundos
 * vale 0,6999999999999999 — sem ele o painel de meio da tarde mostraria 16:47.
 */
function formatT(t) {
    const dia = ((t % 1) + 1) % 1;
    const mins = Math.floor(dia * 24 * 60 + 1e-9);
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
