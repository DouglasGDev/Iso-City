"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.InteractionSystem = void 0;
class InteractionSystem {
    constructor(vehicleSystem) {
        this.vehicleSystem = vehicleSystem;
    }
    nearestVehicle(player, vehicles) {
        if (player.state === 'driving')
            return null;
        let best = null;
        let bestDist = Infinity;
        for (const v of vehicles) {
            if (!v.def.driveable)
                continue;
            if (v.state === 'destroyed')
                continue;
            const dx = player.x - v.x;
            const dy = player.y - v.y;
            const d = dx * dx + dy * dy;
            if (d < bestDist && this.vehicleSystem.isNear(player, v)) {
                bestDist = d;
                best = v;
            }
        }
        return best;
    }
    tryEnter(player, vehicles) {
        const v = this.nearestVehicle(player, vehicles);
        if (!v)
            return false;
        this.vehicleSystem.enterVehicle(player, v);
        return true;
    }
    tryExit(player, vehicles, map, collision) {
        if (player.currentVehicleId === null)
            return false;
        const v = vehicles.find((x) => x.id === player.currentVehicleId);
        if (!v)
            return false;
        this.vehicleSystem.exitVehicle(player, v, map, collision);
        return true;
    }
    currentVehicle(player, vehicles) {
        if (player.currentVehicleId === null)
            return null;
        return vehicles.find((x) => x.id === player.currentVehicleId) ?? null;
    }
}
exports.InteractionSystem = InteractionSystem;
