import type { Collider } from '../entities/types';
import type { Vehicle } from '../entities/Vehicle';
import { vehicleGroundCollider } from './CollisionSystem';

type Point = { x: number; y: number; z: number };
export interface CoverContext {
  map: { queryNearby(x: number, y: number, radius: number): readonly Collider[] };
  vehicles: readonly Vehicle[];
}
export interface CoverHit { t: number; collider: Collider; vehicle?: Vehicle }

function intersection(from: Point, to: Point, box: Collider, height: number): number | null {
  let enter = 0, exit = 1;
  for (const [start, delta, min, max] of [
    [from.x, to.x - from.x, box.x, box.x + box.width],
    [from.y, to.y - from.y, box.y, box.y + box.height],
    [from.z, to.z - from.z, 0, height],
  ]) {
    if (Math.abs(delta) < 1e-10) {
      if (start < min || start > max) return null;
    } else {
      const a = (min - start) / delta, b = (max - start) / delta;
      enter = Math.max(enter, Math.min(a, b));
      exit = Math.min(exit, Math.max(a, b));
      if (enter > exit) return null;
    }
  }
  return enter;
}

export class CoverSystem {
  /**
   * Primeiro obstáculo entre dois pontos. `ignoreVehicle` aceita um id (o carro de
   * quem atira) ou um predicado (a visão policial também precisa ignorar o carro
   * do alvo, senão o capô do próprio jogador funcionaria como parede).
   */
  static firstHit(from: Point, to: Point, ctx: CoverContext,
    ignoreVehicle: number | null | ((vehicle: Vehicle) => boolean) = null): CoverHit | null {
    const ignored = typeof ignoreVehicle === 'function' ? ignoreVehicle : (v: Vehicle) => v.id === ignoreVehicle;
    let hit: CoverHit | null = null;
    const radius = Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y)) / 2;
    for (const collider of ctx.map.queryNearby((from.x + to.x) / 2, (from.y + to.y) / 2, radius + 0.01)) {
      const height = collider.coverHeight ?? (collider.type === 'FENCE' ? 0.95 : 8);
      if (height <= 0) continue;
      const t = intersection(from, to, collider, height);
      if (t !== null && (!hit || t < hit.t)) hit = { t, collider };
    }
    for (const vehicle of ctx.vehicles) {
      if (ignored(vehicle) || vehicle.altitude > 0.5) continue;
      const collider = vehicleGroundCollider(vehicle);
      const tall = ['van', 'box', 'truck', 'swat', 'garbage', 'bus_school', 'firetruck', 'ambulance'].includes(vehicle.def.type);
      const height = vehicle.state === 'destroyed' ? 0.55 : tall ? 1.9 : 1.05;
      const t = intersection(from, to, collider, height);
      if (t !== null && (!hit || t < hit.t)) hit = { t, collider, vehicle };
    }
    return hit;
  }
}
