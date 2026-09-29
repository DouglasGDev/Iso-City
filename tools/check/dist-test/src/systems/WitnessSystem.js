"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WitnessSystem = void 0;
const CoverSystem_1 = require("./CoverSystem");
class WitnessSystem {
    constructor() {
        this.calls = [];
        this.time = 0;
        this.incidentId = 0;
        this.lastShot = -Infinity;
        this.delivered = new Set();
        this.reportCooldown = 0;
    }
    observe(incident, ctx) {
        if (this.time - this.lastShot > 2 || this.delivered.has(this.incidentId))
            this.incidentId++;
        this.lastShot = this.time;
        for (const npc of ctx.npcs) {
            if (npc.dead || npc.health <= 0 || npc.state === 'knocked' || (npc.inVehicle && npc.kind !== 'cop'))
                continue;
            const distance = Math.hypot(npc.x - incident.x, npc.y - incident.y);
            if (distance > 20)
                continue;
            if (npc.kind === 'civ') {
                npc.state = 'fleeing';
                npc.fleeTimer = Math.max(npc.fleeTimer, 5);
            }
            if (distance > (npc.kind === 'cop' ? 14 : 16))
                continue;
            if (CoverSystem_1.CoverSystem.firstHit({ x: npc.x, y: npc.y, z: 1.55 }, { x: incident.x, y: incident.y, z: ctx.player.crouching ? 0.8 : 1.4 }, ctx, npc.vehicleId))
                continue;
            const pending = this.calls.find((call) => call.npcId === npc.id);
            if (pending) {
                pending.x = incident.x;
                pending.y = incident.y;
                pending.severity = Math.max(pending.severity, incident.severity);
                continue;
            }
            if (this.calls.length >= 6 || this.reportCooldown > 0)
                continue;
            const radio = npc.kind === 'cop';
            this.calls.push({ ...incident, npcId: npc.id, elapsed: 0,
                duration: radio ? 0.45 : 2.8 + npc.id % 3 * 0.25, incidentId: this.incidentId, radio });
        }
    }
    update(dt, ctx) {
        if (!Number.isFinite(dt) || dt <= 0)
            return;
        this.time += dt;
        this.reportCooldown = Math.max(0, this.reportCooldown - dt);
        for (let i = this.calls.length - 1; i >= 0; i--) {
            const call = this.calls[i];
            const npc = ctx.npcs.find((n) => n.id === call.npcId);
            const cancelled = !npc || npc.dead || npc.health <= 0 || npc.state === 'knocked' || (npc.inVehicle && !call.radio);
            if (cancelled || this.delivered.has(call.incidentId)) {
                if (npc)
                    npc.callingPolice = false;
                this.calls.splice(i, 1);
                continue;
            }
            const previous = call.elapsed;
            call.elapsed += dt;
            if (!call.radio && call.elapsed >= 0.7) {
                npc.callingPolice = true;
                if (previous < 0.7)
                    ctx.onCallStart?.();
            }
            if (call.elapsed < call.duration)
                continue;
            this.delivered.add(call.incidentId);
            this.reportCooldown = 4;
            npc.callingPolice = false;
            npc.fleeTimer = Math.max(npc.fleeTimer, 5);
            ctx.onReport({ x: call.x, y: call.y, severity: call.severity });
            this.calls.splice(i, 1);
        }
        if (this.delivered.size > 16) {
            for (const id of this.delivered)
                if (id < this.incidentId - 8)
                    this.delivered.delete(id);
        }
    }
    reset(npcs) {
        for (const npc of npcs)
            npc.callingPolice = false;
        this.calls.length = 0;
        this.delivered.clear();
        this.lastShot = -Infinity;
        this.reportCooldown = 0;
    }
}
exports.WitnessSystem = WitnessSystem;
