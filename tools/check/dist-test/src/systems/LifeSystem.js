"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LifeSystem = void 0;
const NPC_1 = require("../entities/NPC");
const GameConfig_1 = require("../game/GameConfig");
const SPAWN_ATTEMPTS = 32;
const RESPAWNS_PER_UPDATE = 4;
const RETRY_S = 1;
// Observe deaths after damage systems, including entities beyond the simulation radius.
class LifeSystem {
    constructor() {
        this.time = 0;
        this.retryAt = new WeakMap();
    }
    update(dt, ctx) {
        if (!Number.isFinite(dt) || dt <= 0)
            return;
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
            npc.deathTimer = previous >= 0 ? Math.min(NPC_1.NPC_CORPSE_LIFETIME_S, previous + dt) : 0;
            if (previous < 0)
                npc.blood = (0, NPC_1.bloodStains)(npc.id, npc.dir);
            if (previous < NPC_1.NPC_CORPSE_LIFETIME_S && npc.deathTimer >= NPC_1.NPC_CORPSE_LIFETIME_S && !npc.inVehicle) {
                changed = true;
            }
            // Police and drivers share corpse timing only. Their owning systems alone
            // may release/reuse their slots. A released former driver is a pedestrian.
            if (npc.kind !== 'civ' || npc.inVehicle || npc.vehicleId !== null ||
                npc.deathTimer < NPC_1.NPC_CORPSE_LIFETIME_S || respawns >= RESPAWNS_PER_UPDATE ||
                !this.offscreen(npc, ctx) || this.time < (this.retryAt.get(npc) ?? 0))
                continue;
            this.retryAt.set(npc, this.time + RETRY_S);
            const spot = this.spawnPoint(npc, ctx);
            if (!spot)
                continue; // No safe destination: keep the expired slot, never force a spawn.
            // Preserve index, ID, object identity and population size. Reset ALL NPC
            // fields (route, knockdown, pursuit, vehicle links, animation and timers).
            Object.assign(npc, (0, NPC_1.createNPC)(npc.id, npc.char, spot.x, spot.y, 'civ', ctx.rng));
            this.retryAt.delete(npc);
            respawns++;
            changed = true;
        }
        if (changed)
            ctx.onStructChange();
    }
    offscreen(point, ctx) {
        return Math.hypot(point.x - ctx.player.x, point.y - ctx.player.y) > GameConfig_1.GAME_CONFIG.NPC_SIM_FAR &&
            !ctx.isPointVisible?.(point.x, point.y);
    }
    spawnPoint(slot, ctx) {
        const { map } = ctx;
        const nodes = map.sidewalkNodes;
        if (!nodes.length)
            return null;
        const start = Math.floor((ctx.rng ?? Math.random)() * nodes.length);
        // Consecutive candidates avoid repeatedly sampling the same blocked node.
        for (let attempt = 0; attempt < Math.min(SPAWN_ATTEMPTS, nodes.length); attempt++) {
            const index = (start + attempt) % nodes.length;
            const point = nodes[index];
            const radius = GameConfig_1.GAME_CONFIG.NPC_RADIUS;
            if (!point || !map.isInside(point.x, point.y, radius) ||
                !this.offscreen(point, ctx) || !map.sidewalkNeighbors[index]?.length)
                continue;
            const tile = map.tileKindAt(point.x, point.y);
            if (tile === null || tile === 'water' || tile === 'road')
                continue;
            if (ctx.collision.overlapsAny({ ...point, radius }, map.queryNearby(point.x, point.y, radius + 1)))
                continue;
            if (ctx.vehicles.some((v) => v.state !== 'destroyed' && v.altitude <= 0.5 &&
                Math.hypot(v.x - point.x, v.y - point.y) < Math.max(1.5, Math.min(v.def.footprintW, v.def.footprintH) * 0.34 + radius)))
                continue;
            if (ctx.npcs.some((n) => n !== slot && (0, NPC_1.isNpcVisible)(n) &&
                Math.hypot(n.x - point.x, n.y - point.y) < 0.6))
                continue;
            return point;
        }
        return null;
    }
}
exports.LifeSystem = LifeSystem;
