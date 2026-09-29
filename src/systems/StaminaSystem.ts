import { GAME_CONFIG } from '../game/GameConfig';
import type { Player } from '../entities/Player';

/** Exhaustion latches until a useful reserve has recovered, even with Run held. */
export class StaminaSystem {
  private exhausted = new WeakSet<Player>();
  private readonly recoverAt = Math.max(0.25, GAME_CONFIG.STAMINA_SPRINT_MIN * 3);

  update(player: Player, dt: number, wantsRun: boolean, moving: boolean) {
    if (!Number.isFinite(dt) || dt <= 0) return;
    // Same gate as movement's preceding canSprint call. Never drain while the
    // player is forced to walk, or recovery would stall with Run held down.
    const allowed = this.canSprint(player);
    const sprinting = wantsRun && moving && allowed && !player.swimming &&
      player.currentVehicleId === null && player.state !== 'dead' &&
      player.state !== 'enteringVehicle';
    if (sprinting) {
      player.stamina = Math.max(0, player.stamina - GAME_CONFIG.STAMINA_RUN_DRAIN * dt);
      if (player.stamina <= GAME_CONFIG.STAMINA_SPRINT_MIN) this.exhausted.add(player);
    } else {
      const regenRate = moving ? GAME_CONFIG.STAMINA_REGEN * 0.55 : GAME_CONFIG.STAMINA_REGEN;
      player.stamina = Math.min(1, player.stamina + regenRate * dt);
    }
  }

  canSprint(player: Player): boolean {
    if (player.stamina <= GAME_CONFIG.STAMINA_SPRINT_MIN) this.exhausted.add(player);
    else if (player.stamina >= this.recoverAt) this.exhausted.delete(player);
    return !player.crouching && !this.exhausted.has(player);
  }
}
