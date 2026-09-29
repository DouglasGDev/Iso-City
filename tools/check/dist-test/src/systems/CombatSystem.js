"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CombatSystem = void 0;
const GameConfig_1 = require("../game/GameConfig");
const weapons_1 = require("../data/weapons");
const SoundManager_1 = require("../audio/SoundManager");
const WeaponSystem_1 = require("./WeaponSystem");
const Animal_1 = require("../entities/Animal");
/** Separate melee cadence/damage; neither fists nor bats use firearm ammunition. */
class CombatSystem {
    constructor() {
        this.cooldown = 0;
        this.animationLeft = 0;
    }
    update(dt) {
        if (!Number.isFinite(dt) || dt <= 0)
            return;
        this.cooldown = Math.max(0, this.cooldown - dt);
        this.animationLeft = Math.max(0, this.animationLeft - dt);
    }
    get attacking() {
        return this.animationLeft > 0;
    }
    /** Returns true for a swing, including a miss. Walls block center-to-center LOS. */
    tryAttack(ctx, melee = 'unarmed') {
        const p = ctx.player;
        if (p.currentVehicleId !== null || p.swimming || p.health <= 0 || p.state === 'dead' ||
            ctx.paused || ctx.overlay || this.cooldown > 1e-8)
            return false;
        const def = weapons_1.MELEE_DEFS[melee];
        this.cooldown = def.cooldown;
        this.animationLeft = def.animationSeconds;
        p.attackTimer = def.animationSeconds;
        p.attackWeapon = melee;
        p.attackAngle = ctx.aim?.active ? Math.atan2(ctx.aim.y, ctx.aim.x) : p.facingAngle;
        SoundManager_1.sound.play(melee === 'bat' ? 'batSwing' : 'punch', melee === 'bat' ? 0.5 : 0.4);
        const fx = Math.cos(p.attackAngle);
        const fy = Math.sin(p.attackAngle);
        const walls = ctx.map.queryNearby(p.x, p.y, def.range + def.knockback + GameConfig_1.GAME_CONFIG.NPC_RADIUS);
        let hitAny = false;
        for (const npc of ctx.npcs) {
            if (npc.dead || npc.state === 'dead' || npc.health <= 0 || npc.inVehicle)
                continue;
            const dx = npc.x - p.x;
            const dy = npc.y - p.y;
            const d = Math.hypot(dx, dy);
            if (d > def.range)
                continue;
            const dot = d > 1e-4 ? (dx / d) * fx + (dy / d) * fy : 1;
            if (dot < Math.cos(def.arc))
                continue;
            // Full segment (also endpoints/inside) avoids punching through thin facades.
            if (walls.some((wall) => (0, WeaponSystem_1.segmentAabb)(p.x, p.y, npc.x, npc.y, wall) !== null))
                continue;
            hitAny = true;
            npc.health = Math.max(0, npc.health - def.damage);
            const pushX = (d > 1e-4 ? dx / d : fx) * def.knockback;
            const pushY = (d > 1e-4 ? dy / d : fy) * def.knockback;
            let fraction = 1;
            for (const wall of walls) {
                const r = GameConfig_1.GAME_CONFIG.NPC_RADIUS;
                const t = (0, WeaponSystem_1.segmentAabb)(npc.x, npc.y, npc.x + pushX, npc.y + pushY, {
                    ...wall, x: wall.x - r, y: wall.y - r, width: wall.width + r * 2, height: wall.height + r * 2,
                });
                if (t !== null)
                    fraction = Math.min(fraction, Math.max(0, t - 1e-4));
            }
            npc.x += pushX * fraction;
            npc.y += pushY * fraction;
            if (npc.health <= 0) {
                this.killNpc(npc, ctx, melee);
            }
            else {
                npc.state = 'knocked';
                npc.downTimer = GameConfig_1.GAME_CONFIG.NPC_DOWN_S;
                npc.anim = 'idle';
                npc.frame = 0;
                SoundManager_1.sound.play(melee === 'bat' ? 'batHit' : 'bodyHit', melee === 'bat' ? 0.6 : 0.55);
                ctx.wanted.raise(p, npc.kind === 'cop' ? GameConfig_1.GAME_CONFIG.WANTED_HIT_COP : GameConfig_1.GAME_CONFIG.WANTED_HIT_CIV);
            }
        }
        for (const animal of ctx.animals ?? []) {
            if (animal.dead || animal.health <= 0)
                continue;
            const dx = animal.x - p.x, dy = animal.y - p.y;
            const distance = Math.hypot(dx, dy);
            if (distance > def.range + animal.radius)
                continue;
            if (distance > 1e-4 && (dx * fx + dy * fy) / distance < Math.cos(def.arc))
                continue;
            if (walls.some((wall) => (0, WeaponSystem_1.segmentAabb)(p.x, p.y, animal.x, animal.y, wall) !== null))
                continue;
            (0, Animal_1.damage)(animal, def.damage);
            hitAny = true;
            SoundManager_1.sound.play(melee === 'bat' ? 'batHit' : 'bodyHit', 0.4);
        }
        if (hitAny) {
            ctx.shake(melee === 'bat' ? 0.45 : 0.35);
            ctx.onStructChange();
        }
        return true;
    }
    killNpc(npc, ctx, melee = 'unarmed') {
        npc.dead = true;
        npc.state = 'dead';
        npc.speed = 0;
        npc.anim = 'idle';
        npc.frame = 0;
        ctx.wanted.raise(ctx.player, npc.kind === 'cop' ? GameConfig_1.GAME_CONFIG.WANTED_HIT_COP + 1 : GameConfig_1.GAME_CONFIG.WANTED_KILL);
        const drop = GameConfig_1.GAME_CONFIG.DROP_MONEY_MIN +
            ctx.rng() * (GameConfig_1.GAME_CONFIG.DROP_MONEY_MAX - GameConfig_1.GAME_CONFIG.DROP_MONEY_MIN);
        ctx.pickups.spawnDrop(npc.x, npc.y, drop);
        SoundManager_1.sound.play(melee === 'bat' ? 'batHit' : 'bodyHit', 0.7);
    }
}
exports.CombatSystem = CombatSystem;
