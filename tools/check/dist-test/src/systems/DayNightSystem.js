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
        const mins = Math.floor(this.t * 24 * 60);
        const h = Math.floor(mins / 60);
        const m = mins % 60;
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    }
}
exports.DayNightSystem = DayNightSystem;
