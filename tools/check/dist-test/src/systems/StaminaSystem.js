"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.StaminaSystem = void 0;
const GameConfig_1 = require("../game/GameConfig");
/** Exhaustion latches until a useful reserve has recovered, even with Run held. */
class StaminaSystem {
    constructor() {
        this.exhausted = new WeakSet();
        this.recoverAt = Math.max(0.25, GameConfig_1.GAME_CONFIG.STAMINA_SPRINT_MIN * 3);
    }
    update(player, dt, wantsRun, moving) {
        if (!Number.isFinite(dt) || dt <= 0)
            return;
        // Same gate as movement's preceding canSprint call. Never drain while the
        // player is forced to walk, or recovery would stall with Run held down.
        const allowed = this.canSprint(player);
        const sprinting = wantsRun && moving && allowed && !player.swimming &&
            player.currentVehicleId === null && player.state !== 'dead' &&
            player.state !== 'enteringVehicle';
        if (sprinting) {
            player.stamina = Math.max(0, player.stamina - GameConfig_1.GAME_CONFIG.STAMINA_RUN_DRAIN * dt);
            if (player.stamina <= GameConfig_1.GAME_CONFIG.STAMINA_SPRINT_MIN)
                this.exhausted.add(player);
        }
        else {
            const regenRate = moving ? GameConfig_1.GAME_CONFIG.STAMINA_REGEN * 0.55 : GameConfig_1.GAME_CONFIG.STAMINA_REGEN;
            player.stamina = Math.min(1, player.stamina + regenRate * dt);
        }
    }
    canSprint(player) {
        if (player.stamina <= GameConfig_1.GAME_CONFIG.STAMINA_SPRINT_MIN)
            this.exhausted.add(player);
        else if (player.stamina >= this.recoverAt)
            this.exhausted.delete(player);
        return !player.crouching && !this.exhausted.has(player);
    }
}
exports.StaminaSystem = StaminaSystem;
