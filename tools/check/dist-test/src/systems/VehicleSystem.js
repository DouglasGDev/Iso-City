"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.VehicleSystem = void 0;
const GameConfig_1 = require("../game/GameConfig");
class VehicleSystem {
    enterVehicle(player, vehicle) {
        if (!vehicle.def.driveable)
            return;
        if (vehicle.occupied)
            return;
        if (vehicle.state === 'destroyed')
            return;
        vehicle.occupied = true;
        vehicle.state = 'driving';
        player.currentVehicleId = vehicle.id;
        player.state = 'driving';
        player.speed = 0;
        player.direction = vehicle.dir;
        player.facingAngle = vehicle.facingAngle;
    }
    exitVehicle(player, vehicle, map, collision) {
        const back = BACK_DIR[vehicle.dir];
        const spot = this.findExitSpot(vehicle, map, collision);
        player.x = spot.x;
        player.y = spot.y;
        player.state = 'idle';
        player.currentVehicleId = null;
        player.direction = back;
        vehicle.occupied = false;
        vehicle.state = 'parked';
        vehicle.speed = 0;
        vehicle.altitude = 0;
    }
    findExitSpot(vehicle, map, collision) {
        const r = GameConfig_1.GAME_CONFIG.PLAYER_RADIUS;
        const offsets = [
            { wx: Math.cos(vehicle.facingAngle + Math.PI / 2), wy: Math.sin(vehicle.facingAngle + Math.PI / 2) },
            { wx: Math.cos(vehicle.facingAngle - Math.PI / 2), wy: Math.sin(vehicle.facingAngle - Math.PI / 2) },
            BACK_OFFSET[BACK_DIR[vehicle.dir]],
        ];
        for (const off of offsets) {
            const x = vehicle.x + off.wx * 1.2;
            const y = vehicle.y + off.wy * 1.2;
            if (!map || !collision)
                return { x, y };
            const c = { x, y, radius: r };
            const nearby = map.queryNearby(x, y, 1.8);
            if (!collision.overlapsAny(c, nearby)) {
                return {
                    x: Math.max(r, Math.min(map.worldW - r, x)),
                    y: Math.max(r, Math.min(map.worldH - r, y)),
                };
            }
        }
        return {
            x: vehicle.x + BACK_OFFSET[BACK_DIR[vehicle.dir]].wx * 1.15,
            y: vehicle.y + BACK_OFFSET[BACK_DIR[vehicle.dir]].wy * 1.15,
        };
    }
    isNear(player, vehicle) {
        if (!vehicle.def.driveable)
            return false;
        const dx = player.x - vehicle.x;
        const dy = player.y - vehicle.y;
        const range = GameConfig_1.GAME_CONFIG.VEHICLE_ENTER_RANGE * (vehicle.def.type === 'helicopter' ? 1.45 : 1);
        return dx * dx + dy * dy < range * range;
    }
}
exports.VehicleSystem = VehicleSystem;
const BACK_DIR = {
    SE: 'NW',
    SW: 'NE',
    NE: 'SW',
    NW: 'SE',
};
const BACK_OFFSET = {
    SE: { wx: -1, wy: 0 },
    SW: { wx: 0, wy: -1 },
    NE: { wx: 0, wy: 1 },
    NW: { wx: 1, wy: 0 },
};
