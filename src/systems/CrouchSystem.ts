import type { Player } from '../entities/Player';

/** World units/second; crouching never changes the ground collision footprint. */
export const CROUCH_SPEED = 0.85;

/** Pure posture state. Call update before movement and after water/vehicle/death transitions. */
export class CrouchSystem {
  private blocked(player: Player): boolean {
    return player.health <= 0 || player.state === 'dead' || player.swimming ||
      player.currentVehicleId !== null || player.state === 'driving' ||
      player.state === 'enteringVehicle' || player.jumpTimer > 0 || player.jumpHeight > 0;
  }

  /** Toggle once per consumed input edge; returns the resulting posture. */
  toggle(player: Player): boolean {
    player.crouching = !this.blocked(player) && !player.crouching;
    return player.crouching;
  }

  update(player: Player): void {
    if (this.blocked(player)) player.crouching = false;
  }
}
