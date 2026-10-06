"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WeaponSystem = void 0;
exports.segmentAabb = segmentAabb;
exports.segmentCircle = segmentCircle;
const weapons_1 = require("../data/weapons");
const GameConfig_1 = require("../game/GameConfig");
const CollisionSystem_1 = require("./CollisionSystem");
const Animal_1 = require("../entities/Animal");
const CoverSystem_1 = require("./CoverSystem");
/** First segment fraction in [0, 1], including touching/starting inside a wall. */
function segmentAabb(x1, y1, x2, y2, box) {
    let enter = 0;
    let exit = 1;
    for (const [start, delta, min, max] of [
        [x1, x2 - x1, box.x, box.x + box.width],
        [y1, y2 - y1, box.y, box.y + box.height],
    ]) {
        if (delta === 0) {
            if (start < min || start > max)
                return null;
            continue;
        }
        const a = (min - start) / delta;
        const b = (max - start) / delta;
        enter = Math.max(enter, Math.min(a, b));
        exit = Math.min(exit, Math.max(a, b));
        if (enter > exit)
            return null;
    }
    return enter;
}
function segmentCircle(x1, y1, x2, y2, center, radius) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const ox = x1 - center.x;
    const oy = y1 - center.y;
    const c = ox * ox + oy * oy - radius * radius;
    if (c <= 0)
        return 0;
    const a = dx * dx + dy * dy;
    if (a === 0)
        return null;
    const b = ox * dx + oy * dy;
    const discriminant = b * b - a * c;
    if (discriminant < 0)
        return null;
    const t = (-b - Math.sqrt(discriminant)) / a;
    return t >= 0 && t <= 1 ? t : null;
}
const liveNpc = (n) => !n.dead && n.state !== 'dead' && n.health > 0 && !n.inVehicle;
const liveVehicle = (v) => v.state !== 'destroyed' && v.health > 0;
const canUse = (ctx) => !ctx.paused && !ctx.overlay && ctx.player.health > 0 &&
    ctx.player.state !== 'dead' && ctx.player.currentVehicleId === null && !ctx.player.swimming;
/** Hitscan and aiming share the exact same obstruction test. Walls win ties. */
function trace(ctx, x2, y2) {
    const { x: x1, y: y1 } = ctx.player;
    const barrier = CoverSystem_1.CoverSystem.firstHit({ x: x1, y: y1, z: ctx.player.crouching ? 0.65 : 1.35 }, { x: x2, y: y2, z: 1.2 }, ctx, ctx.player.currentVehicleId);
    let best = barrier ? { t: barrier.t, hit: true, vehicle: barrier.vehicle } : { t: Infinity, hit: false };
    for (const vehicle of ctx.vehicles) {
        if (!liveVehicle(vehicle) || vehicle.id === ctx.player.currentVehicleId || vehicle.altitude > 0.5)
            continue;
        const t = segmentAabb(x1, y1, x2, y2, (0, CollisionSystem_1.vehicleGroundCollider)(vehicle));
        if (t !== null && t < best.t)
            best = { t, hit: true, vehicle };
    }
    for (const npc of ctx.npcs) {
        if (!liveNpc(npc))
            continue;
        const t = segmentCircle(x1, y1, x2, y2, npc, GameConfig_1.GAME_CONFIG.NPC_RADIUS);
        if (t !== null && t < best.t)
            best = { t, hit: true, npc };
    }
    for (const animal of ctx.animals ?? []) {
        if (animal.dead || animal.health <= 0)
            continue;
        const t = segmentCircle(x1, y1, x2, y2, animal, animal.radius);
        if (t !== null && t < best.t)
            best = { t, hit: true, animal };
    }
    // Um corpo de dois metros e meio na frente da linha de tiro também é uma parede: sem isto o
    // tiro passaria através do gigante para acertar o nada, e a única coisa que faz um chefão
    // parece sólido é o projétil parar nele.
    const gorila = ctx.gorila;
    if (gorila && !gorila.morto) {
        const t = segmentCircle(x1, y1, x2, y2, gorila, gorila.raio);
        if (t !== null && t < best.t)
            best = { t, hit: true, gorila };
    }
    // A piranha para o tiro do mesmo jeito: o corpo está na água, e água não é transparente para
    // chumbo nesta altura. É também o que faz atirar de fora da margem ser possível — e é esse o
    // único caminho do "atirar acelera" do rio, já que quem está dentro d'água não dispara.
    const piranha = ctx.piranha;
    if (piranha && !piranha.morto) {
        const t = segmentCircle(x1, y1, x2, y2, piranha, piranha.raio);
        if (t !== null && t < best.t)
            best = { t, hit: true, piranha };
    }
    // O bando inteiro entra na mesma linha de tiro, corpo por corpo, e um guerreiro morto não é
    // parede: um cadáver no caminho que parasse a bala ensinaria o jogador a atirar em chão vazio.
    for (const g of ctx.guerreiros ?? []) {
        if (g.morto)
            continue;
        const t = segmentCircle(x1, y1, x2, y2, g, g.raio);
        if (t !== null && t < best.t)
            best = { t, hit: true, guerreiro: g };
    }
    return best.hit ? best : { t: 1, hit: false };
}
/** No GameState, rendering or audio dependency; timers advance only with simulation dt. */
class WeaponSystem {
    constructor() {
        this.equipped = 'unarmed';
        /** Firearms are found on the map, not carried from the spawn; melee is always allowed. */
        this.owned = new Set(['unarmed', 'bat']);
        this.ammo = {
            pistol: { loaded: 0, reserve: 0 },
            revolver: { loaded: 0, reserve: 0 },
            smg: { loaded: 0, reserve: 0 },
            micro: { loaded: 0, reserve: 0 },
            rifle: { loaded: 0, reserve: 0 },
            sniper: { loaded: 0, reserve: 0 },
            shotgun: { loaded: 0, reserve: 0 },
        };
        this.reloadLeft = 0;
        this.tracers = [];
        this.aimTarget = null;
        this.fireFlash = 0;
        this.aimAngle = 0;
        /** Optional default callbacks; per-action context callbacks take precedence. */
        this.events = {};
        this.cooldown = 0;
        this.emptyCooldown = 0;
        this.reloading = null;
        this.available = true;
        this.nextTracerId = 0;
    }
    get current() {
        return (0, weapons_1.isGunId)(this.equipped) ? weapons_1.WEAPON_DEFS[this.equipped] : null;
    }
    cycle(direction = 1) {
        this.cancelReload();
        this.aimTarget = null;
        this.fireFlash = 0;
        const list = weapons_1.WEAPON_ORDER.filter((id) => this.owned.has(id));
        const index = Math.max(0, list.indexOf(this.equipped));
        this.equipped = list[(index + direction + list.length) % list.length];
        // Keep shot cooldown across switches so cycling cannot accelerate fire.
        return this.equipped;
    }
    /** Ground/loot acquisition: first pickup grants the gun plus one full loadout. */
    acquire(id) {
        const fresh = !this.owned.has(id);
        this.owned.add(id);
        const ammo = this.ammo[id];
        const def = weapons_1.WEAPON_DEFS[id];
        ammo.loaded = Math.max(ammo.loaded, def.magazineSize);
        ammo.reserve = Math.max(ammo.reserve, def.reserveAmmo);
        return fresh;
    }
    reload(ctx) {
        const def = this.current;
        if (!def || this.reloading || !(ctx ? canUse(ctx) : this.available))
            return false;
        const ammo = this.ammo[def.id];
        if (ammo.loaded >= def.magazineSize || ammo.reserve <= 0)
            return false;
        this.reloading = def.id;
        this.reloadLeft = def.reloadSeconds;
        (ctx?.onReload ?? this.events.onReload)?.(def);
        return true;
    }
    cancelReload() {
        this.reloading = null;
        this.reloadLeft = 0;
    }
    suspend() {
        this.cancelReload();
        this.available = false;
        this.aimTarget = null;
        this.fireFlash = 0;
    }
    /** Round reset does not manufacture ammunition; a new game starts with a fresh system. */
    reset() {
        this.suspend();
        this.equipped = 'unarmed';
        this.owned.clear();
        this.owned.add('unarmed');
        this.owned.add('bat');
        for (const id of weapons_1.GUN_IDS) {
            this.ammo[id].loaded = 0;
            this.ammo[id].reserve = 0;
        }
        this.cooldown = this.emptyCooldown = 0;
        this.tracers.length = 0;
        this.aimAngle = 0;
    }
    /** Ammo crate: top up every owned gun to its loadout; melee has no ammo. */
    refill() {
        this.cancelReload();
        for (const id of weapons_1.GUN_IDS) {
            if (!this.owned.has(id))
                continue;
            this.ammo[id].loaded = weapons_1.WEAPON_DEFS[id].magazineSize;
            this.ammo[id].reserve = weapons_1.WEAPON_DEFS[id].reserveAmmo;
        }
    }
    update(dt) {
        if (!Number.isFinite(dt) || dt <= 0)
            return;
        this.cooldown = Math.max(0, this.cooldown - dt);
        this.emptyCooldown = Math.max(0, this.emptyCooldown - dt);
        this.fireFlash = Math.max(0, this.fireFlash - dt);
        for (const tracer of this.tracers)
            tracer.life -= dt;
        this.tracers = this.tracers.filter((t) => t.life > 0);
        if (!this.reloading)
            return;
        if (this.reloading !== this.equipped) {
            this.cancelReload();
            return;
        }
        this.reloadLeft = Math.max(0, this.reloadLeft - dt);
        if (this.reloadLeft > 1e-8)
            return;
        const ammo = this.ammo[this.reloading];
        const transfer = Math.min(weapons_1.WEAPON_DEFS[this.reloading].magazineSize - ammo.loaded, ammo.reserve);
        ammo.loaded += transfer;
        ammo.reserve -= transfer;
        this.cancelReload();
    }
    updateAim(ctx) {
        this.available = canUse(ctx);
        const manual = ctx.aim?.active ? Math.atan2(ctx.aim.y, ctx.aim.x) : null;
        this.aimAngle = manual ?? ctx.player.facingAngle;
        this.aimTarget = null;
        if (!this.available) {
            this.suspend();
            return;
        }
        const def = this.current;
        if (!def || manual !== null)
            return;
        let bestAngle = Math.PI / 10; // Gentle assist: only within 18 degrees of facing.
        let bestDistance = Infinity;
        const consider = (target, kind) => {
            const dx = target.x - ctx.player.x;
            const dy = target.y - ctx.player.y;
            const distance = Math.hypot(dx, dy);
            if (distance < 1e-8 || distance > def.range)
                return;
            const angle = Math.atan2(dy, dx);
            const delta = Math.abs(Math.atan2(Math.sin(angle - ctx.player.facingAngle), Math.cos(angle - ctx.player.facingAngle)));
            if (delta > bestAngle || (delta === bestAngle && distance >= bestDistance))
                return;
            const hit = trace(ctx, target.x, target.y);
            if (hit[kind] !== target)
                return;
            bestAngle = delta;
            bestDistance = distance;
            this.aimTarget = { x: target.x, y: target.y };
            this.aimAngle = angle;
        };
        for (const npc of ctx.npcs)
            if (liveNpc(npc))
                consider(npc, 'npc');
        for (const vehicle of ctx.vehicles)
            if (liveVehicle(vehicle))
                consider(vehicle, 'vehicle');
        for (const animal of ctx.animals ?? [])
            if (!animal.dead && animal.health > 0)
                consider(animal, 'animal');
        // O gigante é o alvo mais alto da mira automática, e é de propósito: quem está a 20 tiles
        // de um dorsípede de dois toneladas com o polegar no gatilho não pode estar acertando o ar.
        if (ctx.gorila && !ctx.gorila.morto)
            consider(ctx.gorila, 'gorila');
        if (ctx.piranha && !ctx.piranha.morto)
            consider(ctx.piranha, 'piranha');
        // O bando entra na mira automática pelo mesmo critério de um pedestre — o menor desvio de
        // ângulo, com a distância desempateando — porque aqui não existe alvo preferido: na frente do
        // cano, quem está mais no meio da linha é quem você vai acertar.
        for (const g of ctx.guerreiros ?? [])
            if (!g.morto)
                consider(g, 'guerreiro');
    }
    /** Bare calls are taps. A held trigger repeats only on automatic weapons. */
    tryFire(ctx, trigger = { pressed: true }) {
        if (!canUse(ctx)) {
            this.suspend();
            return false;
        }
        const def = this.current;
        if (!def || (!trigger.pressed && !(def.automatic && trigger.held)))
            return false;
        if (this.cooldown > 1e-8 || this.reloading)
            return false;
        const ammo = this.ammo[def.id];
        if (ammo.loaded <= 0) {
            if (!this.reload(ctx) && this.emptyCooldown <= 0) {
                this.emptyCooldown = 0.35;
                (ctx.onEmpty ?? this.events.onEmpty)?.(def);
            }
            return false;
        }
        this.updateAim(ctx);
        const p = ctx.player;
        ammo.loaded--;
        this.cooldown = def.fireInterval;
        this.fireFlash = def.id === 'shotgun' ? 0.1 : 0.07;
        // Resolve the complete volley before damage: a fatal first pellet must not let
        // later pellets pass through that target or produce duplicate death drops.
        const npcDamage = new globalThis.Map();
        const vehicleDamage = new globalThis.Map();
        const animalDamage = new globalThis.Map();
        // Os corpos do bando somam por id, não num total: a rajada de escopeta pode levar três deles,
        // e quem decide quem caiu é o `TriboSystem` — um único número somado não diria a ele qual
        // corpo perdeu vida, e o companheiro ileso ao lado sairia ferido.
        const guerreiroDamage = new globalThis.Map();
        // As duas feras da fronteira somam num laço, não em dois `if` soltos: cada uma tem um corpo
        // por mundo e o dano tem de sair uma única vez por rajada, pela porta do sistema dono. Um
        // laço é o que deixa essa regra visível para a próxima fera que entrar aqui.
        const feras = [
            { dano: 0, onHit: ctx.onGorilaHit },
            { dano: 0, onHit: ctx.onPiranhaHit },
        ];
        for (let pellet = 0; pellet < def.pellets; pellet++) {
            const offset = def.pellets === 1 ? 0 : (pellet / (def.pellets - 1) - 0.5) * def.spread;
            const angle = this.aimAngle + offset;
            const x2 = p.x + Math.cos(angle) * def.range;
            const y2 = p.y + Math.sin(angle) * def.range;
            const hit = trace(ctx, x2, y2);
            this.tracers.push({ id: this.nextTracerId++, x1: p.x, y1: p.y,
                x2: p.x + (x2 - p.x) * hit.t, y2: p.y + (y2 - p.y) * hit.t, life: 0.12, hit: hit.hit });
            if (hit.npc)
                npcDamage.set(hit.npc, (npcDamage.get(hit.npc) ?? 0) + def.damage);
            if (hit.vehicle)
                vehicleDamage.set(hit.vehicle, (vehicleDamage.get(hit.vehicle) ?? 0) + def.damage);
            if (hit.animal)
                animalDamage.set(hit.animal, (animalDamage.get(hit.animal) ?? 0) + def.damage);
            if (hit.gorila)
                feras[0].dano += def.damage;
            if (hit.piranha)
                feras[1].dano += def.damage;
            if (hit.guerreiro) {
                guerreiroDamage.set(hit.guerreiro, (guerreiroDamage.get(hit.guerreiro) ?? 0) + def.damage);
            }
        }
        // Uma única chamada por rajada, não por chumbo: é o sistema da fera que decide se aquele dano
        // matou, e ele só tem um corpo para dar. A festa do disparo continua aqui porque é este arquivo
        // que sabe que a fera é um alvo — o sistema dono dela não conhece armas.
        let feraAtingida = false;
        for (const fera of feras) {
            if (fera.dano <= 0)
                continue;
            feraAtingida = true;
            fera.onHit?.(fera.dano);
        }
        for (const [animal, damage] of animalDamage) {
            if ((0, Animal_1.damage)(animal, damage))
                ctx.onStructChange();
        }
        // Um chamada por corpo ferido, com o id dele: quem manda na vida deles é o `TriboSystem`, e é
        // ele que sabe que um companheiro caído acorda os outros — somar tudo num número só jogaria
        // fora exatamente a informação que a aldeia usa para ficar mais rápida.
        for (const [g, damage] of guerreiroDamage)
            ctx.onGuerreiroHit?.(g.id, damage);
        let crime = 1;
        for (const [npc, damage] of npcDamage) {
            npc.health = Math.max(0, npc.health - damage);
            crime = Math.max(crime, npc.kind === 'cop' ? 3 : 2);
            if (npc.health <= 0) {
                npc.dead = true;
                npc.state = 'dead';
                npc.speed = 0;
                npc.anim = 'idle';
                npc.frame = 0;
                crime = Math.max(crime, npc.kind === 'cop' ? GameConfig_1.GAME_CONFIG.WANTED_HIT_COP + 1 : GameConfig_1.GAME_CONFIG.WANTED_KILL);
                ctx.pickups.spawnDrop(npc.x, npc.y, GameConfig_1.GAME_CONFIG.DROP_MONEY_MIN +
                    ctx.rng() * (GameConfig_1.GAME_CONFIG.DROP_MONEY_MAX - GameConfig_1.GAME_CONFIG.DROP_MONEY_MIN));
                // Armed officers are the reliable way to find a sidearm before exploring.
                if (npc.kind === 'cop')
                    ctx.pickups.spawnWeaponDrop(npc.x, npc.y, 'pistol');
                ctx.onStructChange();
            }
        }
        for (const [vehicle, damage] of vehicleDamage) {
            // DestructionSystem owns explosions/occupant damage, later in the same tick.
            vehicle.health = Math.max(0, vehicle.health - damage);
            crime = Math.max(crime, ['police', 'swat'].includes(vehicle.def.type) ? 3 : 1);
        }
        ctx.onCrime?.({ x: p.x, y: p.y, severity: crime });
        ctx.shake(npcDamage.size || vehicleDamage.size || animalDamage.size || feraAtingida ? 0.18 : 0.06);
        (ctx.onShot ?? this.events.onShot)?.(def);
        if (ammo.loaded === 0)
            this.reload(ctx);
        return true;
    }
}
exports.WeaponSystem = WeaponSystem;
