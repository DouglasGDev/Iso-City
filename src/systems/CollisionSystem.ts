import type { Collider } from '../entities/types';
import type { Vehicle } from '../entities/Vehicle';

export interface Circle {
  x: number;
  y: number;
  radius: number;
}

export function collideCircleAabb(
  circle: Circle,
  c: Collider,
): { collided: boolean; pushX: number; pushY: number } {
  const cx = Math.max(c.x, Math.min(circle.x, c.x + c.width));
  const cy = Math.max(c.y, Math.min(circle.y, c.y + c.height));
  let dx = circle.x - cx;
  let dy = circle.y - cy;
  const distSq = dx * dx + dy * dy;
  const r = circle.radius;
  if (distSq > r * r) return { collided: false, pushX: 0, pushY: 0 };
  if (distSq > 1e-9) {
    const dist = Math.sqrt(distSq);
    const overlap = r - dist;
    dx /= dist;
    dy /= dist;
    return { collided: true, pushX: dx * overlap, pushY: dy * overlap };
  }
  const left = circle.x - c.x;
  const right = c.x + c.width - circle.x;
  const top = circle.y - c.y;
  const bottom = c.y + c.height - circle.y;
  const min = Math.min(left, right, top, bottom);
  if (min === right) return { collided: true, pushX: right + r, pushY: 0 };
  if (min === left) return { collided: true, pushX: -left - r, pushY: 0 };
  if (min === bottom) return { collided: true, pushX: 0, pushY: bottom + r };
  return { collided: true, pushX: 0, pushY: -top - r };
}

export function vehicleGroundCollider(vehicle: Vehicle): Collider {
  const alongX = vehicle.dir === 'SE' || vehicle.dir === 'NW';
  const width = alongX ? vehicle.def.footprintH : vehicle.def.footprintW;
  const height = alongX ? vehicle.def.footprintW : vehicle.def.footprintH;
  return { x: vehicle.x - width / 2, y: vehicle.y - height / 2, width, height, type: 'VEHICLE' };
}

export class CollisionSystem {
  resolveCircle(circle: Circle, colliders: Collider[]): boolean {
    let moved = true;
    let iterations = 0;
    while (moved && iterations < 4) {
      moved = false;
      iterations++;
      for (const c of colliders) {
        const res = collideCircleAabb(circle, c);
        if (res.collided) {
          circle.x += res.pushX;
          circle.y += res.pushY;
          moved = true;
        }
      }
    }
    return moved;
  }

  overlapsAny(circle: Circle, colliders: Collider[]): boolean {
    for (const c of colliders) {
      const res = collideCircleAabb(circle, c);
      if (res.collided) return true;
    }
    return false;
  }

  resolveCircleVsVehicles(
    circle: Circle,
    vehicles: Vehicle[],
    ignoreId: number | null = null,
    radius = 0.42,
  ) {
    let moved = true;
    let iterations = 0;
    while (moved && iterations < 4) {
      moved = false;
      iterations++;
      for (const v of vehicles) {
        if (v.id === ignoreId || v.state === 'destroyed' || v.altitude > 0.5) continue;
        const reach = Math.max(v.def.footprintW, v.def.footprintH, radius) + circle.radius;
        if (Math.abs(circle.x - v.x) > reach || Math.abs(circle.y - v.y) > reach) continue;
        const result = collideCircleAabb(circle, vehicleGroundCollider(v));
        if (result.collided && (result.pushX !== 0 || result.pushY !== 0)) {
          circle.x += result.pushX;
          circle.y += result.pushY;
          moved = true;
        }
      }
    }
  }
}
