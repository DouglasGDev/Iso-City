import { GAME_CONFIG } from '../game/GameConfig';
import type { Player } from '../entities/Player';

/** Dano/regeneração do jogador. Regenera devagar depois de um tempo sem apanhar. */
export class HealthSystem {
  damage(player: Player, amount: number, time: number): boolean {
    if (amount <= 0) return false;
    if (time < player.invulnUntil) return false;
    player.health = Math.max(0, player.health - amount);
    player.lastDamageAt = time;
    return true;
  }

  heal(player: Player, amount: number) {
    player.health = Math.min(100, player.health + amount);
  }

  update(dt: number, player: Player, time: number) {
    if (player.health <= 0 || player.health >= 100) return;
    if (time - player.lastDamageAt < GAME_CONFIG.HEALTH_REGEN_DELAY_S) return;
    player.health = Math.min(100, player.health + GAME_CONFIG.HEALTH_REGEN_PER_S * dt);
  }
}
