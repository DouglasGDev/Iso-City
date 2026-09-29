"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DestructionSystem = void 0;
const GameConfig_1 = require("../game/GameConfig");
const AssetRegistry_1 = require("../assets/AssetRegistry");
const SoundManager_1 = require("../audio/SoundManager");
/** Manchões de asfalto queimado não podem crescer sem limite na sessão. */
const MAX_WRECKS = 40;
/**
 * Veículos com HP zero explodem em área: dano em cadeia a carros, NPCs e ao
 * jogador; o casco carbonizado e os estilhaços ficam no cenário.
 */
class DestructionSystem {
    constructor() {
        this.wrecks = [];
    }
    update(dt, ctx) {
        for (const v of ctx.vehicles) {
            if (v.health > 0 || v.state === 'destroyed')
                continue;
            this.explode(v, ctx);
        }
        void dt;
    }
    /** Espalhamento fixo por veículo: o mesmo wreck não muda de forma a cada explosão. */
    static shards(seed) {
        let state = (seed * 2654435761) >>> 0;
        const rnd = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 4294967296);
        return Array.from({ length: 7 }, () => ({
            dx: (rnd() * 2 - 1) * 0.8,
            dy: (rnd() * 2 - 1) * 0.8,
            size: 2 + rnd() * 4,
            rot: rnd() * Math.PI,
        }));
    }
    explode(v, ctx) {
        v.state = 'destroyed';
        v.speed = 0;
        v.occupied = false;
        v.altitude = 0;
        const tilt = (((Math.imul(v.id + 1, 668265263) >>> 0) / 4294967296) - 0.5) * 0.26;
        this.wrecks.push({
            x: v.x,
            y: v.y,
            dir: v.dir,
            key: (0, AssetRegistry_1.damagedVehicleKey)(v.def, v.color, v.dir),
            tilt,
            shards: DestructionSystem.shards(v.id + 1),
            explodedAt: ctx.time,
        });
        if (this.wrecks.length > MAX_WRECKS)
            this.wrecks.splice(0, this.wrecks.length - MAX_WRECKS);
        SoundManager_1.sound.play('explosion', 0.85);
        SoundManager_1.sound.play('glassBreak', 0.5);
        ctx.shake(1.4);
        const inVehicle = ctx.player.currentVehicleId === v.id;
        if (inVehicle) {
            ctx.onPlayerExitedVehicle();
            ctx.health.damage(ctx.player, GameConfig_1.GAME_CONFIG.PLAYER_EXPLODE_DAMAGE, ctx.time);
            ctx.player.invulnUntil = ctx.time + 0.8;
        }
        const r = GameConfig_1.GAME_CONFIG.VEHICLE_EXPLOSION_RADIUS;
        for (const other of ctx.vehicles) {
            if (other === v || other.state === 'destroyed')
                continue;
            const d = Math.hypot(other.x - v.x, other.y - v.y);
            if (d < r)
                other.health -= GameConfig_1.GAME_CONFIG.VEHICLE_EXPLOSION_DMG * (1 - d / r);
        }
        for (const npc of ctx.npcs) {
            if (npc.dead)
                continue;
            const d = Math.hypot(npc.x - v.x, npc.y - v.y);
            if (d < r) {
                npc.health -= 60;
                if (npc.health <= 0) {
                    npc.dead = true;
                    npc.state = 'dead';
                }
                else {
                    npc.state = 'knocked';
                    npc.downTimer = GameConfig_1.GAME_CONFIG.NPC_DOWN_S;
                }
            }
        }
        if (!inVehicle) {
            const d = Math.hypot(ctx.player.x - v.x, ctx.player.y - v.y);
            if (d < r)
                ctx.health.damage(ctx.player, 22 * (1 - d / r), ctx.time);
        }
        ctx.onStructChange();
    }
}
exports.DestructionSystem = DestructionSystem;
