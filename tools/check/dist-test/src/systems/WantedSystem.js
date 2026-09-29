"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WantedSystem = void 0;
const GameConfig_1 = require("../game/GameConfig");
const SIGHT_GRACE_S = 1.5;
/** Wanted decays while unseen, even if officers are searching nearby. */
class WantedSystem {
    constructor() {
        this.decayTimer = GameConfig_1.GAME_CONFIG.WANTED_DECAY_S;
        this.sightTimer = 0;
    }
    raise(player, amount = 0) {
        if (!Number.isFinite(amount) || amount === 0)
            return;
        const next = Math.max(0, Math.min(GameConfig_1.GAME_CONFIG.WANTED_MAX, player.wantedLevel + amount));
        if (amount > 0 || next !== player.wantedLevel) {
            player.wantedLevel = next;
            this.decayTimer = GameConfig_1.GAME_CONFIG.WANTED_DECAY_S;
        }
    }
    /** Third argument is PoliceSystem.playerVisible, NOT a proximity test. */
    update(dt, player, playerVisible) {
        if (!Number.isFinite(dt) || dt <= 0)
            return;
        if (player.wantedLevel <= 0) {
            this.sightTimer = 0;
            return;
        }
        if (playerVisible) {
            // Brief sightings only pause decay; sustained contact renews the full countdown.
            this.sightTimer = Math.min(SIGHT_GRACE_S, this.sightTimer + dt);
            if (this.sightTimer >= SIGHT_GRACE_S)
                this.decayTimer = GameConfig_1.GAME_CONFIG.WANTED_DECAY_S;
            return;
        }
        this.sightTimer = 0;
        this.decayTimer -= dt;
        while (this.decayTimer <= 0 && player.wantedLevel > 0) {
            player.wantedLevel = Math.max(0, player.wantedLevel - 1);
            this.decayTimer += GameConfig_1.GAME_CONFIG.WANTED_DECAY_S;
        }
    }
    clear(player) {
        player.wantedLevel = 0;
        this.decayTimer = GameConfig_1.GAME_CONFIG.WANTED_DECAY_S;
        this.sightTimer = 0;
    }
}
exports.WantedSystem = WantedSystem;
