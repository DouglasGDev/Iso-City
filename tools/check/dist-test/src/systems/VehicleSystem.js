"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.VehicleSystem = void 0;
const GameConfig_1 = require("../game/GameConfig");
class VehicleSystem {
    /**
     * `occupied` é NPC ao volante, não porta trancada: assaltar um carro é justamente tirar
     * quem dirige (TrafficSystem devolve o motorista à calçada e PoliceSystem despeja a guarnição).
     * A única coisa que não se assalta é o que está voando — o heli de apoio varre o céu sozinho.
     */
    enterVehicle(player, vehicle) {
        if (!vehicle.def.driveable)
            return;
        if (vehicle.state === 'destroyed')
            return;
        if (vehicle.altitude > AIRBORNE_ALTITUDE)
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
        // A aeronave sem piloto desce sozinha até o chão que está embaixo dela (settleAirborne).
        // Zerar a altura aqui seria teletransportar o casco do alto do platô para o nível da rua.
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
        if (vehicle.altitude > AIRBORNE_ALTITUDE)
            return false;
        const dx = player.x - vehicle.x;
        const dy = player.y - vehicle.y;
        const range = GameConfig_1.GAME_CONFIG.VEHICLE_ENTER_RANGE * (vehicle.def.type === 'helicopter' ? 1.45 : 1);
        return dx * dx + dy * dy < range * range;
    }
}
exports.VehicleSystem = VehicleSystem;
/** Acima disso a aeronave está pairando: não há porta para abrir nem motorista para expulsar. */
const AIRBORNE_ALTITUDE = 0.5;
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
