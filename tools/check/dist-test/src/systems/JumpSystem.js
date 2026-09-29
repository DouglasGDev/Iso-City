"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.JumpSystem = exports.JUMP_HEIGHT_PX = exports.JUMP_DURATION = void 0;
const GameConfig_1 = require("../game/GameConfig");
const InputState_1 = require("../game/InputState");
const IsoUtils_1 = require("../world/IsoUtils");
const MovementSystem_1 = require("./MovementSystem");
exports.JUMP_DURATION = 0.65;
exports.JUMP_HEIGHT_PX = 24;
const VAULT_REACH = 0.45;
const VAULT_DISTANCE = 1.5;
const SKIN = 0.02;
/** Continuous, conservative swept circle: clip against the radius-expanded AABB.
 * Square corners intentionally reject marginal diagonal gaps instead of tunneling. */
function sweep(a, b, box, radius) {
    let near = 0;
    let far = 1;
    for (const axis of ['x', 'y']) {
        const delta = b[axis] - a[axis];
        const lo = box[axis] - radius;
        const hi = box[axis] + (axis === 'x' ? box.width : box.height) + radius;
        if (Math.abs(delta) < 1e-10) {
            if (a[axis] < lo || a[axis] > hi)
                return null;
        }
        else {
            const t0 = (lo - a[axis]) / delta;
            const t1 = (hi - a[axis]) / delta;
            near = Math.max(near, Math.min(t0, t1));
            far = Math.min(far, Math.max(t0, t1));
            if (near > far)
                return null;
        }
    }
    return { near, far };
}
/** No GameState, audio, React or wall-clock dependency. Call after ground movement. */
class JumpSystem {
    constructor(getVehicles = () => []) {
        this.getVehicles = getVehicles;
        this.flights = new WeakMap();
    }
    obstacles(map, a, b) {
        const radius = Math.hypot(b.x - a.x, b.y - a.y) / 2 + GameConfig_1.GAME_CONFIG.PLAYER_RADIUS + SKIN;
        return map.queryNearby((a.x + b.x) / 2, (a.y + b.y) / 2, radius)
            .concat((0, MovementSystem_1.solidVehicleColliders)(this.getVehicles()));
    }
    dryPath(map, a, b) {
        const r = GameConfig_1.GAME_CONFIG.PLAYER_RADIUS;
        const minX = Math.min(a.x, b.x) - r;
        const maxX = Math.max(a.x, b.x) + r;
        const minY = Math.min(a.y, b.y) - r;
        const maxY = Math.max(a.y, b.y) + r;
        if (![minX, maxX, minY, maxY].every(Number.isFinite) ||
            minX < 0 || minY < 0 || maxX > map.worldW || maxY > map.worldH)
            return false;
        // Water is tile-based. Test every touched tile, not just the endpoints or
        // sparse samples: even a diagonal corner of a water tile blocks a vault.
        for (let y = Math.floor(minY); y <= Math.floor(maxY); y++) {
            for (let x = Math.floor(minX); x <= Math.floor(maxX); x++) {
                if (map.isWaterWorld(x + 0.5, y + 0.5) &&
                    sweep(a, b, { x, y, width: 1, height: 1, type: 'PROP' }, r))
                    return false;
            }
        }
        return true;
    }
    pathFree(map, a, b) {
        return this.dryPath(map, a, b) && !this.obstacles(map, a, b)
            .some((c) => !(0, MovementSystem_1.isLowFence)(c) && sweep(a, b, c, GameConfig_1.GAME_CONFIG.PLAYER_RADIUS));
    }
    landingFree(map, collision, point) {
        return this.dryPath(map, point, point) && !collision.overlapsAny({ ...point, radius: GameConfig_1.GAME_CONFIG.PLAYER_RADIUS - 1e-5 }, this.obstacles(map, point, point));
    }
    blocked(player, map) {
        return player.currentVehicleId !== null || player.state === 'driving' ||
            player.state === 'enteringVehicle' || player.state === 'dead' || player.health <= 0 ||
            player.swimming || map.isWaterWorld(player.x, player.y);
    }
    /** True only on takeoff (ordinary jump or certified vault); holding never requeues. */
    tryJump(player, map, collision) {
        if (player.jumpTimer > 0 || this.blocked(player, map) || !this.landingFree(map, collision, player))
            return false;
        const start = { x: player.x, y: player.y };
        const world = InputState_1.inputState.magnitude > GameConfig_1.GAME_CONFIG.JOYSTICK_DEADZONE
            ? (0, IsoUtils_1.screenToWorld)(InputState_1.inputState.dx, InputState_1.inputState.dy)
            : { x: Math.cos(player.facingAngle), y: Math.sin(player.facingAngle) };
        const length = Math.hypot(world.x, world.y) || 1;
        const ray = { x: start.x + world.x / length * VAULT_DISTANCE, y: start.y + world.y / length * VAULT_DISTANCE };
        const fences = this.obstacles(map, start, ray).filter(MovementSystem_1.isLowFence)
            .map((c) => sweep(start, ray, c, GameConfig_1.GAME_CONFIG.PLAYER_RADIUS + SKIN))
            .filter((hit) => hit !== null && hit.near * VAULT_DISTANCE <= VAULT_REACH)
            .sort((a, b) => a.near - b.near);
        const hit = fences[0];
        let end = null;
        if (hit) {
            const distance = hit.far * VAULT_DISTANCE + SKIN;
            const candidate = { x: start.x + world.x / length * distance, y: start.y + world.y / length * distance };
            if (distance <= VAULT_DISTANCE && this.pathFree(map, start, candidate) && this.landingFree(map, collision, candidate)) {
                end = candidate;
            }
        }
        player.jumpStart = start;
        player.jumpEnd = end;
        player.jumpDuration = exports.JUMP_DURATION;
        player.jumpTimer = exports.JUMP_DURATION;
        player.jumpHeight = 0;
        player.crouching = false;
        this.flights.set(player, { map, safe: start });
        return true;
    }
    /** Reset on teleport/round transitions. Does not move the player to an old map. */
    cancel(player) {
        player.jumpTimer = 0;
        player.jumpHeight = 0;
        player.jumpStart = null;
        player.jumpEnd = null;
        this.flights.delete(player);
    }
    recover(player, map, collision, flight) {
        if (this.landingFree(map, collision, player))
            return true;
        const candidates = [flight.safe, player.jumpStart, player.jumpEnd].filter((p) => p !== null);
        candidates.sort((a, b) => Math.hypot(a.x - player.x, a.y - player.y) - Math.hypot(b.x - player.x, b.y - player.y));
        for (const point of candidates) {
            if (this.pathFree(map, player, point) && this.landingFree(map, collision, point)) {
                player.x = point.x;
                player.y = point.y;
                return true;
            }
        }
        return false;
    }
    /** Advance once per simulation tick AFTER MovementSystem and external separation.
     * Substeps preserve the clearance window even when dt exceeds the whole flight.
     * A dynamic obstruction aborts to a reachable safe point, never through a wall. */
    update(player, map, collision, dt) {
        const flight = this.flights.get(player);
        if (!flight || flight.map !== map || player.jumpTimer <= 0) {
            if (player.jumpTimer > 0 || player.jumpHeight > 0 || flight)
                this.cancel(player);
            return null;
        }
        if (this.blocked(player, map)) {
            if (player.currentVehicleId === null && !player.swimming && !map.isWaterWorld(player.x, player.y)) {
                this.recover(player, map, collision, flight);
            }
            this.cancel(player);
            return 'cancelled';
        }
        if (!Number.isFinite(dt) || dt <= 0)
            return null;
        let remaining = Math.min(dt, player.jumpTimer);
        while (remaining > 1e-9) {
            const step = Math.min(remaining, 1 / 120);
            const timer = Math.max(0, player.jumpTimer - step);
            const t = Math.min(1, 1 - timer / player.jumpDuration);
            const end = player.jumpEnd;
            if (end && player.jumpStart) {
                // Keep all horizontal travel within t=.2.. .8 (height >=15.36px).
                const progress = Math.max(0, Math.min(1, (t - 0.2) / 0.6));
                const target = {
                    x: player.jumpStart.x + (end.x - player.jumpStart.x) * progress,
                    y: player.jumpStart.y + (end.y - player.jumpStart.y) * progress,
                };
                if (!this.pathFree(map, player, target) || !this.pathFree(map, target, end) || !this.landingFree(map, collision, end)) {
                    if (this.recover(player, map, collision, flight)) {
                        this.cancel(player);
                        return 'cancelled';
                    }
                    // No safe retreat if dynamic objects enclose both sides: wait aloft for
                    // clearance, rather than teleport through a car/wall or land in a fence.
                    player.jumpHeight = Math.max(MovementSystem_1.FENCE_CLEARANCE_PX, player.jumpHeight);
                    return null;
                }
                player.jumpHeight = 4 * exports.JUMP_HEIGHT_PX * t * (1 - t);
                (0, MovementSystem_1.movePlayerGround)(player, map, collision, target.x - player.x, target.y - player.y, this.getVehicles());
                player.vx = 0;
                player.vy = 0;
                player.speed = 0;
                if (this.landingFree(map, collision, player))
                    flight.safe = { x: player.x, y: player.y };
            }
            else {
                player.jumpHeight = 4 * exports.JUMP_HEIGHT_PX * t * (1 - t);
                if (this.landingFree(map, collision, player))
                    flight.safe = { x: player.x, y: player.y };
            }
            player.jumpTimer = timer;
            remaining -= step;
            if (timer <= 1e-9) {
                if (!this.recover(player, map, collision, flight)) {
                    player.jumpTimer = step;
                    player.jumpHeight = MovementSystem_1.FENCE_CLEARANCE_PX;
                    return null;
                }
                this.cancel(player);
                return 'landed';
            }
        }
        return null;
    }
}
exports.JumpSystem = JumpSystem;
