import { GAME_CONFIG } from '../game/GameConfig';
import type { Player } from '../entities/Player';

const SIGHT_GRACE_S = 1.5;

/** Wanted decays while unseen, even if officers are searching nearby. */
export class WantedSystem {
  private decayTimer: number = GAME_CONFIG.WANTED_DECAY_S;
  private sightTimer = 0;

  raise(player: Player, amount = 0) {
    if (!Number.isFinite(amount) || amount === 0) return;
    const next = Math.max(0, Math.min(GAME_CONFIG.WANTED_MAX, player.wantedLevel + amount));
    if (amount > 0 || next !== player.wantedLevel) {
      player.wantedLevel = next;
      this.decayTimer = GAME_CONFIG.WANTED_DECAY_S;
    }
  }

  /** Third argument is PoliceSystem.playerVisible, NOT a proximity test. */
  update(dt: number, player: Player, playerVisible: boolean) {
    if (!Number.isFinite(dt) || dt <= 0) return;
    if (player.wantedLevel <= 0) {
      this.sightTimer = 0;
      return;
    }
    if (playerVisible) {
      // Brief sightings only pause decay; sustained contact renews the full countdown.
      this.sightTimer = Math.min(SIGHT_GRACE_S, this.sightTimer + dt);
      if (this.sightTimer >= SIGHT_GRACE_S) this.decayTimer = GAME_CONFIG.WANTED_DECAY_S;
      return;
    }
    this.sightTimer = 0;
    this.decayTimer -= dt;
    while (this.decayTimer <= 0 && player.wantedLevel > 0) {
      player.wantedLevel = Math.max(0, player.wantedLevel - 1);
      this.decayTimer += GAME_CONFIG.WANTED_DECAY_S;
    }
  }

  clear(player: Player) {
    player.wantedLevel = 0;
    this.decayTimer = GAME_CONFIG.WANTED_DECAY_S;
    this.sightTimer = 0;
  }
}
