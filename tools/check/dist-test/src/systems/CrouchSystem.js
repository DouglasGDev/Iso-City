"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CrouchSystem = exports.CROUCH_SPEED = void 0;
/** World units/second; crouching never changes the ground collision footprint. */
exports.CROUCH_SPEED = 0.85;
/** Pure posture state. Call update before movement and after water/vehicle/death transitions. */
class CrouchSystem {
    blocked(player) {
        return player.health <= 0 || player.state === 'dead' || player.swimming ||
            player.currentVehicleId !== null || player.state === 'driving' ||
            player.state === 'enteringVehicle' || player.jumpTimer > 0 || player.jumpHeight > 0;
    }
    /** Toggle once per consumed input edge; returns the resulting posture. */
    toggle(player) {
        player.crouching = !this.blocked(player) && !player.crouching;
        return player.crouching;
    }
    update(player) {
        if (this.blocked(player))
            player.crouching = false;
    }
}
exports.CrouchSystem = CrouchSystem;
