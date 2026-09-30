"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.VehicleImpactSystem = void 0;
const SoundManager_1 = require("../audio/SoundManager");
const GameConfig_1 = require("../game/GameConfig");
const Animal_1 = require("../entities/Animal");
const IsoUtils_1 = require("../world/IsoUtils");
const CollisionSystem_1 = require("./CollisionSystem");
/** Célula da grade de veículos: maior que qualquer corpo atropelável, para a varredura ser exata. */
const CELL = 4;
const OFFSET = 4096;
const STRIDE = 16384;
/** Acima dessa altitude o carro está voando e quem está embaixo dele é sombra, não vítima. */
const AIRBORNE = 0.5;
/** Preso embaixo da roda o corpo apanha continuamente, mas na fração do impacto inicial. */
const CRUSH_RATE = 2.2;
/**
 * Atropelamento: todo veículo em curso — dirigido pelo jogador, pelo trânsito ou pela polícia —
 * machuca pedestres, bichos e o jogador a pé. O corpo é arremessado para fora da pista e, se
 * não conseguir sair (parede, gente), continua apanhando até o carro passar.
 */
class VehicleImpactSystem {
    constructor() {
        this.grid = new Map();
        /**
         * Contato já cobrado. Sem o lacre um único frame de sobreposição viraria uma execução por
         * tick; com ele, a mesma roda só volta a machucar depois que o corpo sai de baixo dela.
         */
        this.contact = new Set();
        this.playerContact = false;
        this.playerFirst = false;
    }
    update(dt, ctx) {
        if (!Number.isFinite(dt) || dt <= 0)
            return;
        const movers = this.index(ctx.vehicles);
        const next = new Set();
        let changed = false;
        if (movers) {
            for (const npc of ctx.npcs) {
                if (npc.dead || npc.inVehicle)
                    continue;
                const v = this.underneath(npc.x, npc.y, GameConfig_1.GAME_CONFIG.NPC_RADIUS);
                if (!v)
                    continue;
                next.add(npc);
                if (this.runOverNpc(v, npc, !this.contact.has(npc), dt, ctx))
                    changed = true;
            }
            for (const animal of ctx.animals) {
                if (animal.dead)
                    continue;
                const v = this.underneath(animal.x, animal.y, animal.radius);
                if (!v)
                    continue;
                next.add(animal);
                if (this.runOverAnimal(v, animal, !this.contact.has(animal), dt, ctx))
                    changed = true;
            }
            this.playerContact = !ctx.indoors && this.runOverPlayer(ctx, dt);
            if (this.playerFirst)
                changed = true;
        }
        this.contact = next;
        if (changed)
            ctx.onStructChange();
    }
    /** Só entram na grade os veículos que de fato atropelam: o resto nem é procurado. */
    index(vehicles) {
        for (const bucket of this.grid.values())
            bucket.length = 0;
        let movers = 0;
        for (const v of vehicles) {
            if (!v.def.driveable || v.state === 'destroyed' || v.altitude > AIRBORNE)
                continue;
            if (Math.abs(v.speed) < GameConfig_1.GAME_CONFIG.HIT_PED_SPEED)
                continue;
            const key = (Math.floor(v.x / CELL) + OFFSET) * STRIDE + Math.floor(v.y / CELL) + OFFSET;
            const bucket = this.grid.get(key);
            if (bucket)
                bucket.push(v);
            else
                this.grid.set(key, [v]);
            movers++;
        }
        return movers;
    }
    /** O corpo está sobre a caixa desenhada do carro? Um ônibus comprido pega quem ele cobre. */
    underneath(x, y, radius) {
        const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL);
        for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
                const bucket = this.grid.get((cx + dx + OFFSET) * STRIDE + (cy + dy + OFFSET));
                if (!bucket)
                    continue;
                for (const v of bucket) {
                    const reach = Math.max(v.def.footprintW, v.def.footprintH) * 0.5 + radius;
                    if (Math.abs(v.x - x) > reach || Math.abs(v.y - y) > reach)
                        continue;
                    if ((0, CollisionSystem_1.collideCircleAabb)({ x, y, radius }, (0, CollisionSystem_1.vehicleGroundCollider)(v)).collided)
                        return v;
                }
            }
        }
        return null;
    }
    /** Dano do impacto; o que vem depois é esmagamento, proporcional ao tempo preso embaixo. */
    static damage(v, scale, first, dt) {
        const impact = (GameConfig_1.GAME_CONFIG.RUNOVER_DAMAGE + Math.abs(v.speed) * GameConfig_1.GAME_CONFIG.RUNOVER_DAMAGE_PER_SPEED) * scale;
        return first ? impact : impact * dt * CRUSH_RATE;
    }
    /**
     * Arremesso para o lado do carro, na direção em que ele já ia: a vítima sai da roda e o lacre
     * se desfaz. A parede decide o quanto disso chega ao chão, senão atropelar empurraria gente
     * para dentro do prédio.
     */
    throw(target, radius, v, ctx) {
        const axis = IsoUtils_1.DIR_VECTORS[v.dir];
        const side = axis.wy * (target.x - v.x) - axis.wx * (target.y - v.y) >= 0 ? 1 : -1;
        const reach = GameConfig_1.GAME_CONFIG.RUNOVER_THROW + Math.abs(v.speed) * 0.22;
        const circle = {
            x: target.x + (-axis.wy * side) * reach + axis.wx * reach * 0.45,
            y: target.y + axis.wx * side * reach + axis.wy * reach * 0.45,
            radius,
        };
        circle.x = Math.max(radius, Math.min(ctx.map.worldW - radius, circle.x));
        circle.y = Math.max(radius, Math.min(ctx.map.worldH - radius, circle.y));
        ctx.collision.resolveCircle(circle, ctx.map.queryNearby(circle.x, circle.y, radius + 2));
        target.x = circle.x;
        target.y = circle.y;
    }
    /** Volume de quem apanha do outro lado da cidade: 56 carros não fazem barulho no seu ouvido. */
    static volume(v, player) {
        const d = Math.hypot(v.x - player.x, v.y - player.y);
        return d > 26 ? 0 : Math.max(0.25, 0.8 - d * 0.021);
    }
    heard(v, ctx) {
        const volume = VehicleImpactSystem.volume(v, ctx.player);
        if (volume > 0 && Math.hypot(v.x - ctx.player.x, v.y - ctx.player.y) < 9)
            ctx.shake(0.35);
        return volume;
    }
    runOverNpc(v, npc, first, dt, ctx) {
        const driven = ctx.player.currentVehicleId === v.id;
        npc.health = Math.max(0, npc.health - VehicleImpactSystem.damage(v, 1, first, dt));
        if (first) {
            this.throw(npc, GameConfig_1.GAME_CONFIG.NPC_RADIUS, v, ctx);
            npc.lastX = npc.x;
            npc.lastY = npc.y;
            if (npc.health > 0) {
                npc.state = 'knocked';
                npc.downTimer = GameConfig_1.GAME_CONFIG.NPC_DOWN_S;
                npc.anim = 'idle';
                npc.frame = 0;
            }
            const volume = this.heard(v, ctx);
            if (volume > 0)
                SoundManager_1.sound.play('bodyHit', volume);
        }
        if (npc.health > 0) {
            // Atropelar alguém com o próprio carro é crime; apanhar de um motorista do trânsito não.
            if (driven && first) {
                ctx.wanted.raise(ctx.player, npc.kind === 'cop'
                    ? GameConfig_1.GAME_CONFIG.WANTED_HIT_COP : GameConfig_1.GAME_CONFIG.WANTED_HIT_PED);
            }
            return first;
        }
        npc.dead = true;
        npc.state = 'dead';
        npc.speed = 0;
        npc.anim = 'idle';
        npc.frame = 0;
        if (driven) {
            ctx.wanted.raise(ctx.player, npc.kind === 'cop'
                ? GameConfig_1.GAME_CONFIG.WANTED_HIT_COP + 1 : GameConfig_1.GAME_CONFIG.WANTED_KILL);
            ctx.pickups.spawnDrop(npc.x, npc.y, GameConfig_1.GAME_CONFIG.DROP_MONEY_MIN +
                ctx.rng() * (GameConfig_1.GAME_CONFIG.DROP_MONEY_MAX - GameConfig_1.GAME_CONFIG.DROP_MONEY_MIN));
        }
        return true;
    }
    /** Bicho pega mais que gente: 95 hp de javali não param um caminhão. */
    runOverAnimal(v, animal, first, dt, ctx) {
        if (!first) {
            (0, Animal_1.damage)(animal, VehicleImpactSystem.damage(v, 1.4, false, dt));
            return false;
        }
        this.throw(animal, animal.radius, v, ctx);
        (0, Animal_1.damage)(animal, VehicleImpactSystem.damage(v, 1.4, true, dt));
        const volume = this.heard(v, ctx);
        if (volume > 0)
            SoundManager_1.sound.play('bodyHit', volume * 0.8);
        return true;
    }
    runOverPlayer(ctx, dt) {
        const player = ctx.player;
        if (player.currentVehicleId !== null || player.health <= 0 || player.state === 'dead')
            return false;
        const v = this.underneath(player.x, player.y, GameConfig_1.GAME_CONFIG.PLAYER_RADIUS);
        if (!v)
            return false;
        this.playerFirst = !this.playerContact;
        ctx.health.damage(player, VehicleImpactSystem.damage(v, GameConfig_1.GAME_CONFIG.RUNOVER_PLAYER_RATIO, this.playerFirst, dt), ctx.time);
        if (!this.playerFirst)
            return true;
        this.throw(player, GameConfig_1.GAME_CONFIG.PLAYER_RADIUS, v, ctx);
        SoundManager_1.sound.play('bodyHit', 0.85);
        ctx.shake(1.1);
        return true;
    }
}
exports.VehicleImpactSystem = VehicleImpactSystem;
