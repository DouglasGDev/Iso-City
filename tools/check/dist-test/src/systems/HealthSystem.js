"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HealthSystem = void 0;
const GameConfig_1 = require("../game/GameConfig");
/** Dano/regeneração do jogador. Regenera devagar depois de um tempo sem apanhar. */
class HealthSystem {
    damage(player, amount, time) {
        if (amount <= 0)
            return false;
        if (time < player.invulnUntil)
            return false;
        player.health = Math.max(0, player.health - amount);
        player.lastDamageAt = time;
        return true;
    }
    heal(player, amount) {
        player.health = Math.min(100, player.health + amount);
    }
    update(dt, player, time) {
        if (player.health <= 0 || player.health >= 100)
            return;
        if (time - player.lastDamageAt < GameConfig_1.GAME_CONFIG.HEALTH_REGEN_DELAY_S)
            return;
        player.health = Math.min(100, player.health + GameConfig_1.GAME_CONFIG.HEALTH_REGEN_PER_S * dt);
    }
}
exports.HealthSystem = HealthSystem;
