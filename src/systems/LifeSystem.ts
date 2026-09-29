import { createNPC, isNpcVisible, bloodStains, NPC_CORPSE_LIFETIME_S, type NPC } from '../entities/NPC';
import type { Vehicle } from '../entities/Vehicle';
import { GAME_CONFIG } from '../game/GameConfig';
import type { Map as WorldMap } from '../world/Map';
import type { CollisionSystem } from './CollisionSystem';

type Point = { x: number; y: number };

export interface LifeContext {
  /** Outdoor world position. Inside an interior, pass its exterior entrance. */
  player: Readonly<Point>;
  npcs: NPC[];
  map: Pick<WorldMap, 'sidewalkNodes' | 'sidewalkNeighbors' | 'isInside' | 'tileKindAt' | 'queryNearby'>;
  vehicles: readonly Vehicle[];
  collision: Pick<CollisionSystem, 'overlapsAny'>;
  rng?: () => number;
  // Include sprite margins to avoid pop-in with camera lag or wide viewports.
  isPointVisible?: (x: number, y: number) => boolean;
  onStructChange: () => void;
}

const SPAWN_ATTEMPTS = 32;
const RESPAWNS_PER_UPDATE = 4;
const RETRY_S = 1;

// Observe deaths after damage systems, including entities beyond the simulation radius.
export class LifeSystem {
  private time = 0;
  private retryAt = new WeakMap<NPC, number>();

  update(dt: number, ctx: LifeContext): void {
    if (!Number.isFinite(dt) || dt <= 0) return;
    this.time += dt;
    let changed = false;
    let respawns = 0;
    for (const npc of ctx.npcs) {
      if (!npc.dead) {
        npc.deathTimer = -1;
        this.retryAt.delete(npc);
        continue;
      }

      const previous = npc.deathTimer;
      // First observation starts at zero, not dt. This also handles old objects
      // without a timer, without needing damage systems to know about LifeSystem.
      npc.deathTimer = previous >= 0 ? Math.min(NPC_CORPSE_LIFETIME_S, previous + dt) : 0;
      if (previous < 0) npc.blood = bloodStains(npc.id, npc.dir);
      if (previous < NPC_CORPSE_LIFETIME_S && npc.deathTimer >= NPC_CORPSE_LIFETIME_S && !npc.inVehicle) {
        changed = true;
      }
      // Police and drivers share corpse timing only. Their owning systems alone
      // may release/reuse their slots. A released former driver is a pedestrian.
      if (npc.kind !== 'civ' || npc.inVehicle || npc.vehicleId !== null ||
          npc.deathTimer < NPC_CORPSE_LIFETIME_S || respawns >= RESPAWNS_PER_UPDATE ||
          !this.offscreen(npc, ctx) || this.time < (this.retryAt.get(npc) ?? 0)) continue;

      this.retryAt.set(npc, this.time + RETRY_S);
      const spot = this.spawnPoint(npc, ctx);
      if (!spot) continue; // No safe destination: keep the expired slot, never force a spawn.

      // Preserve index, ID, object identity and population size. Reset ALL NPC
      // fields (route, knockdown, pursuit, vehicle links, animation and timers).
      Object.assign(npc, createNPC(npc.id, npc.char, spot.x, spot.y, 'civ', ctx.rng));
      this.retryAt.delete(npc);
      respawns++;
      changed = true;
    }
    if (changed) ctx.onStructChange();
  }

  private offscreen(point: Point, ctx: LifeContext): boolean {
    return Math.hypot(point.x - ctx.player.x, point.y - ctx.player.y) > GAME_CONFIG.NPC_SIM_FAR &&
      !ctx.isPointVisible?.(point.x, point.y);
  }

  private spawnPoint(slot: NPC, ctx: LifeContext): Point | null {
    const { map } = ctx;
    const nodes = map.sidewalkNodes;
    if (!nodes.length) return null;
    const start = Math.floor((ctx.rng ?? Math.random)() * nodes.length);
    // Consecutive candidates avoid repeatedly sampling the same blocked node.
    for (let attempt = 0; attempt < Math.min(SPAWN_ATTEMPTS, nodes.length); attempt++) {
      const index = (start + attempt) % nodes.length;
      const point = nodes[index];
      const radius = GAME_CONFIG.NPC_RADIUS;
      if (!point || !map.isInside(point.x, point.y, radius) ||
          !this.offscreen(point, ctx) || !map.sidewalkNeighbors[index]?.length) continue;
      const tile = map.tileKindAt(point.x, point.y);
      if (tile === null || tile === 'water' || tile === 'road') continue;
      if (ctx.collision.overlapsAny({ ...point, radius }, map.queryNearby(point.x, point.y, radius + 1))) continue;
      if (ctx.vehicles.some((v) => v.state !== 'destroyed' && v.altitude <= 0.5 &&
          Math.hypot(v.x - point.x, v.y - point.y) < Math.max(1.5,
            Math.min(v.def.footprintW, v.def.footprintH) * 0.34 + radius))) continue;
      if (ctx.npcs.some((n) => n !== slot && isNpcVisible(n) &&
          Math.hypot(n.x - point.x, n.y - point.y) < 0.6)) continue;
      return point;
    }
    return null;
  }
}
