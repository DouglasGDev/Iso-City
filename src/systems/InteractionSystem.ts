import type { Player } from '../entities/Player';
import type { Vehicle } from '../entities/Vehicle';
import type { VehicleSystem } from './VehicleSystem';
import type { CollisionSystem } from './CollisionSystem';
import type { Map } from '../world/Map';

export class InteractionSystem {
  constructor(private vehicleSystem: VehicleSystem) {}

  nearestVehicle(player: Player, vehicles: Vehicle[]): Vehicle | null {
    if (player.state === 'driving') return null;
    let best: Vehicle | null = null;
    let bestDist = Infinity;
    for (const v of vehicles) {
      if (!v.def.driveable) continue;
      if (v.state === 'destroyed') continue;
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

  tryEnter(player: Player, vehicles: Vehicle[]): boolean {
    const v = this.nearestVehicle(player, vehicles);
    if (!v) return false;
    this.vehicleSystem.enterVehicle(player, v);
    return true;
  }

  tryExit(player: Player, vehicles: Vehicle[], map: Map, collision: CollisionSystem): boolean {
    if (player.currentVehicleId === null) return false;
    const v = vehicles.find((x) => x.id === player.currentVehicleId);
    if (!v) return false;
    this.vehicleSystem.exitVehicle(player, v, map, collision);
    return true;
  }

  currentVehicle(player: Player, vehicles: Vehicle[]): Vehicle | null {
    if (player.currentVehicleId === null) return null;
    return vehicles.find((x) => x.id === player.currentVehicleId) ?? null;
  }
}
