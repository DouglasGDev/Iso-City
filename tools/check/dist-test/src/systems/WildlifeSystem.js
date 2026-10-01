"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WildlifeSystem = exports.WILDLIFE_CALL_RADIUS = exports.WILDLIFE_HOME_DISTANCE = exports.WILDLIFE_RESTOCK_SECONDS = exports.WILDLIFE_LOCAL_TARGET = exports.WILDLIFE_LOCAL_RADIUS = exports.WILDLIFE_RESPAWN_ATTEMPTS = exports.WILDLIFE_RESPAWN_DISTANCE = exports.WILDLIFE_UPDATE_LIMIT = exports.WILDLIFE_ACTIVE_RADIUS = exports.WILDLIFE_COUNT = void 0;
exports.isWildlifePositionSafe = isWildlifePositionSafe;
exports.isWildlifePathSafe = isWildlifePathSafe;
const Animal_1 = require("../entities/Animal");
const GameConfig_1 = require("../game/GameConfig");
const IsoUtils_1 = require("../world/IsoUtils");
const VisionSystem_1 = require("./VisionSystem");
const DetectionResponse_1 = require("./DetectionResponse");
exports.WILDLIFE_COUNT = 224;
exports.WILDLIFE_ACTIVE_RADIUS = 32;
exports.WILDLIFE_UPDATE_LIMIT = 48;
/** Conservative fallback without camera culling; also the minimum donor distance. */
exports.WILDLIFE_RESPAWN_DISTANCE = 48;
exports.WILDLIFE_RESPAWN_ATTEMPTS = 12;
exports.WILDLIFE_LOCAL_RADIUS = 14;
exports.WILDLIFE_LOCAL_TARGET = 24;
exports.WILDLIFE_RESTOCK_SECONDS = 0.75;
/** Beyond this many tiles from its reserve an animal heads home instead of camping on asphalt. */
exports.WILDLIFE_HOME_DISTANCE = 26;
const HABITAT_CELL = 12;
const BUCKET_POINTS = 6; // Six ground + six trail samples per habitat cell; <4K on 208x208.
const SPECIES = ['rabbit', 'rabbit', 'deer', 'fox', 'boar', 'deer', 'rabbit'];
const MAX_LIVE_DT = 0.2;
const STEERING = [0, Math.PI / 4, -Math.PI / 4, Math.PI / 2, -Math.PI / 2];
/** Fração do raio de alerta que não precisa ser vista: encostou por trás, é susto em 360°. */
const WILDLIFE_STARTLE_RATIO = 0.5;
/**
 * Raio de voz, em tiles. É maior que a janela da neblina de propósito: quem decide se o
 * som chega ao ouvido é o `GameState`, pela visibilidade e pela distância. Aqui só se
 * declara até onde um bicho pode ter aberto a boca — e 14 tiles já é o outro lado da tela.
 */
exports.WILDLIFE_CALL_RADIUS = 14;
/** Janela de silêncio do grupo, por tipo de chamada. Alarme não pode virar metralhadora. */
const VOZ_CALMA_S = 6;
const VOZ_ALARME_S = 3;
/** Acima disso, quem está no arco apenas para e observa em vez de gastar fôlego correndo. */
const WILDLIFE_WATCH_RATIO = 0.62;
/** Presa não esquece rápido: depois de tanto tempo sem ver nem ouvir, volta a pastar. */
const WILDLIFE_CALM_S = 5;
function overlapsBox(x, y, radius, box) {
    return x + radius >= box.x && x - radius <= box.x + box.width
        && y + radius >= box.y && y - radius <= box.y + box.height;
}
/** Conservative footprint, not just center tile: this is where a life may live and respawn. */
function isWildlifePositionSafe(map, x, y, radius) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(radius) || radius < 0
        || x - radius < 0 || y - radius < 0 || x + radius >= map.worldW || y + radius >= map.worldH)
        return false;
    const { tilesW, tilesH, tiles } = map.data;
    for (let ty = Math.floor(y - radius); ty <= Math.floor(y + radius); ty++) {
        for (let tx = Math.floor(x - radius); tx <= Math.floor(x + radius); tx++) {
            if (tx < 0 || ty < 0 || tx >= tilesW || ty >= tilesH)
                return false;
            const tile = tiles[ty * tilesW + tx];
            if (!tile || !(0, Animal_1.isAnimalHabitat)(tile.biome)
                || (tile.kind !== 'grass' && tile.kind !== 'dirt'))
                return false;
        }
    }
    return !map.queryNearby(x, y, radius).some((box) => overlapsBox(x, y, radius, box));
}
/**
 * Corridor test for stepping, deliberately looser than the habitat test: a frightened
 * animal may cross asphalt, sidewalks and parks, and only water and solid props stop it.
 */
function isWildlifePathSafe(map, x, y, radius) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(radius) || radius < 0
        || x - radius < 0 || y - radius < 0 || x + radius >= map.worldW || y + radius >= map.worldH)
        return false;
    const { tilesW, tilesH, tiles } = map.data;
    for (let ty = Math.floor(y - radius); ty <= Math.floor(y + radius); ty++) {
        for (let tx = Math.floor(x - radius); tx <= Math.floor(x + radius); tx++) {
            if (tx < 0 || ty < 0 || tx >= tilesW || ty >= tilesH)
                return false;
            if (tiles[ty * tilesW + tx]?.kind === 'water')
                return false;
        }
    }
    return !map.queryNearby(x, y, radius).some((box) => overlapsBox(x, y, radius, box));
}
/** O(1) steering test: is this animal still standing in a reserve biome, road or trail included? */
function isReserveGround(map, x, y) {
    const { tilesW, tilesH, tiles } = map.data;
    const tx = Math.floor(x), ty = Math.floor(y);
    if (tx < 0 || ty < 0 || tx >= tilesW || ty >= tilesH)
        return false;
    const tile = tiles[ty * tilesW + tx];
    return !!tile && (0, Animal_1.isAnimalHabitat)(tile.biome);
}
function random(state) {
    state.randomState = (state.randomState + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state.randomState ^ (state.randomState >>> 15), 1 | state.randomState);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
function vehicleBox(vehicle) {
    const alongX = vehicle.dir === 'SE' || vehicle.dir === 'NW';
    const width = vehicle.def ? (alongX ? vehicle.def.footprintH : vehicle.def.footprintW) : (vehicle.radius ?? 0.6) * 2;
    const height = vehicle.def ? (alongX ? vehicle.def.footprintW : vehicle.def.footprintH) : (vehicle.radius ?? 0.6) * 2;
    return { x: vehicle.x - width / 2, y: vehicle.y - height / 2, width, height };
}
class WildlifeSystem {
    constructor() {
        /** Stable array, stable slot objects and ids, including respawns. Never insert into npcs[]. */
        this.animals = [];
        this.habitats = [];
        this.bySpecies = {};
        this.history = new WeakMap();
        this.activeAnimals = [];
        this.vehicleCandidates = [];
        this.rng = { randomState: 0 };
        this.respawnCursor = 0;
        this.restockTimer = 0;
        /** Uma voz por vez no grupo: sem isso a mata vira chiado de rádio. */
        this.voiceCooldown = 0;
        /**
         * O alarme tinha janela própria porque o susto é notícia, não conversa — mas ele não
         * tinha teto nenhum contra o próprio alarme: um veículo atravessando a reserva assustava
         * bicho atrás de bicho e cada um gritava no mesmo segundo. É o "uhu" sem bicho por perto
         * que o pedido apontou, e ele morre aqui.
         */
        this.alarmCooldown = 0;
    }
    /** One scan at init, stratified by habitat/cell/trail rather than world-wide random tiles. */
    init(map, seed = 20260909) {
        this.animals.length = 0;
        this.habitats.length = 0;
        this.history = new WeakMap();
        this.rng.randomState = seed >>> 0;
        this.respawnCursor = 0;
        this.restockTimer = 0;
        this.voiceCooldown = 0;
        this.alarmCooldown = 0;
        const cells = new Map();
        for (let y = 0; y < map.data.tilesH; y++) {
            for (let x = 0; x < map.data.tilesW; x++) {
                const tile = map.data.tiles[y * map.data.tilesW + x];
                if (!(0, Animal_1.isAnimalHabitat)(tile.biome)
                    || !isWildlifePositionSafe(map, x + 0.5, y + 0.5, Animal_1.ANIMAL_STATS.boar.radius + 0.05))
                    continue;
                const cx = Math.floor(x / HABITAT_CELL), cy = Math.floor(y / HABITAT_CELL);
                const key = `${tile.biome}:${cx}:${cy}`;
                let bucket = cells.get(key);
                if (!bucket) {
                    bucket = { biome: tile.biome, x: (cx + 0.5) * HABITAT_CELL, y: (cy + 0.5) * HABITAT_CELL,
                        ground: [], trails: [], groundSeen: 0, trailsSeen: 0 };
                    cells.set(key, bucket);
                    this.habitats.push(bucket);
                }
                const trail = tile.key === 'tile_ground_dirt';
                const samples = trail ? bucket.trails : bucket.ground;
                const count = trail ? ++bucket.trailsSeen : ++bucket.groundSeen;
                const index = count <= BUCKET_POINTS ? count - 1 : Math.floor(random(this.rng) * count);
                if (index < BUCKET_POINTS)
                    samples[index] = { x: x + 0.5, y: y + 0.5 };
            }
        }
        for (const species of Object.keys(Animal_1.ANIMAL_STATS)) {
            this.bySpecies[species] = this.habitats.filter((b) => Animal_1.ANIMAL_HABITATS[species].includes(b.biome));
        }
        let cluster;
        for (let slot = 0; slot < exports.WILDLIFE_COUNT; slot++) {
            const species = SPECIES[Math.floor(slot / 4) % SPECIES.length];
            const buckets = this.bySpecies[species];
            if (!buckets.length)
                continue;
            if (slot % 4 === 0 || !cluster || !Animal_1.ANIMAL_HABITATS[species].includes(cluster.biome)) {
                cluster = buckets[Math.floor(random(this.rng) * buckets.length)];
            }
            const point = this.pickSpawn(map, species, map.data.playerSpawn, 8, 32, undefined, undefined, undefined, [cluster])
                ?? this.pickSpawn(map, species, map.data.playerSpawn, 8, 32);
            if (!point)
                continue;
            const animal = (0, Animal_1.createAnimal)(this.animals.length, species, point.x, point.y, Math.floor(random(this.rng) * 0x100000000));
            this.resetBehaviour(animal);
            this.animals.push(animal);
        }
        this.onStructChange?.();
        return this.animals;
    }
    /** Same idempotent primitive exported by entities/Animal, convenient for integration. */
    damage(animal, amount) { return (0, Animal_1.damage)(animal, amount); }
    update(dt, context) {
        if (!Number.isFinite(dt) || dt <= 0)
            return;
        const { player } = context;
        const validPlayer = Number.isFinite(player.x) && Number.isFinite(player.y);
        const liveDt = Math.min(dt, MAX_LIVE_DT); // Bounded movement work after long suspensions.
        this.voiceCooldown = Math.max(0, this.voiceCooldown - liveDt);
        this.alarmCooldown = Math.max(0, this.alarmCooldown - liveDt);
        let changed = false;
        let callsLeft = 1;
        let localCount = 0;
        this.activeAnimals.length = 0;
        for (const animal of this.animals) {
            if (animal.dead) {
                if (!animal.deathNotified) {
                    animal.deathNotified = true; // Set before callbacks, including re-entrant damage.
                    changed = true;
                    context.onDeath?.(animal);
                }
                animal.deathTimer = Math.min(Animal_1.ANIMAL_CORPSE_SECONDS, Math.max(0, animal.deathTimer) + dt);
                continue;
            }
            if (!validPlayer)
                continue;
            const distance = Math.hypot(animal.x - player.x, animal.y - player.y);
            if (distance <= exports.WILDLIFE_LOCAL_RADIUS)
                localCount++;
            const history = this.history.get(animal);
            if (history) {
                history.settledFor += liveDt;
                const cold = distance > exports.WILDLIFE_RESPAWN_DISTANCE && animal.health === Animal_1.ANIMAL_STATS[animal.species].health
                    && animal.state !== 'fleeing' && animal.fleeTimer <= 0;
                history.hiddenFor = cold && context.isVisible && !context.isVisible(animal.x, animal.y, animal.radius + 2)
                    ? history.hiddenFor + liveDt : 0;
            }
            if (distance <= exports.WILDLIFE_ACTIVE_RADIUS)
                this.activeAnimals.push(animal);
        }
        this.vehicleCandidates.length = 0;
        if (this.activeAnimals.length) {
            // Include the maximum 10-tile vehicle alarm range and one tick of animal movement.
            const reach = exports.WILDLIFE_ACTIVE_RADIUS + 11;
            for (const vehicle of context.vehicles ?? []) {
                if ((vehicle.altitude ?? 0) > 0.5)
                    continue;
                const extent = vehicle.def ? Math.max(vehicle.def.footprintW, vehicle.def.footprintH) / 2 : vehicle.radius ?? 0.6;
                if (Math.abs(vehicle.x - player.x) > reach + extent || Math.abs(vehicle.y - player.y) > reach + extent)
                    continue;
                this.vehicleCandidates.push({ vehicle, box: vehicleBox(vehicle) });
            }
        }
        // Cheap O(slots) bookkeeping; expensive threat/collision/steering work has a hard cap.
        // Nearest-first prevents visible animals being starved by distant slot order.
        this.activeAnimals.sort((a, b) => (a.x - player.x) ** 2 + (a.y - player.y) ** 2
            - (b.x - player.x) ** 2 - (b.y - player.y) ** 2 || a.id - b.id);
        for (let i = 0; i < Math.min(exports.WILDLIFE_UPDATE_LIMIT, this.activeAnimals.length); i++) {
            const animal = this.activeAnimals[i];
            const wasFleeing = animal.state === 'fleeing';
            const threat = this.findThreat(animal, context);
            const response = this.perceive(animal, threat, context, liveDt);
            animal.callTimer = Math.max(0, animal.callTimer - liveDt);
            // Corre quem tem o perigo em cima — visto ou sentido às costas. Um vulto no fim do
            // campo de visão ainda não gasta fôlego: esse primeiro degrau é parar e olhar.
            const bolts = !!threat && (threat.urgent || response === 'flee');
            if (threat && bolts) {
                const dx = animal.x - threat.x, dy = animal.y - threat.y;
                const length = Math.hypot(dx, dy);
                if (length > 0.001) {
                    animal.moveX = dx / length;
                    animal.moveY = dy / length;
                }
                animal.fleeTimer = 3.5;
                animal.state = 'fleeing';
            }
            else if (animal.fleeTimer > 0) {
                animal.fleeTimer = Math.max(0, animal.fleeTimer - liveDt);
                animal.state = animal.fleeTimer > 0 ? 'fleeing' : 'idle';
                if (animal.fleeTimer === 0)
                    animal.decisionTimer = 1 + random(animal) * 2;
            }
            // Freeze de quem avistou perigo longe: parado, de cabeça virada para o risco, sem
            // passear nem voltar para casa até a ameaça chegar perto ou sair do arco.
            const watching = !bolts && animal.fleeTimer <= 0 && !!threat && response === 'look';
            if (watching && threat) {
                animal.state = 'idle';
                animal.speed = 0;
                animal.dir = (0, IsoUtils_1.deltaToDir)(threat.x - animal.x, threat.y - animal.y);
                animal.decisionTimer = Math.max(animal.decisionTimer, 0.8);
            }
            if (!watching && animal.state !== 'fleeing') {
                animal.decisionTimer -= liveDt;
                if (animal.decisionTimer <= 0) {
                    animal.state = animal.state === 'walking' || random(animal) < 0.3 ? 'idle' : 'walking';
                    animal.decisionTimer = 1.2 + random(animal) * 3;
                    const angle = random(animal) * Math.PI * 2;
                    animal.moveX = Math.cos(angle);
                    animal.moveY = Math.sin(angle);
                }
                // Susto pode levar o bicho para qualquer canto da cidade; a casa dele continua sendo a mata.
                if (!isReserveGround(context.map, animal.x, animal.y)
                    || Math.hypot(animal.homeX - animal.x, animal.homeY - animal.y) > exports.WILDLIFE_HOME_DISTANCE) {
                    const dx = animal.homeX - animal.x, dy = animal.homeY - animal.y;
                    const length = Math.hypot(dx, dy);
                    if (length > 0.001) {
                        animal.moveX = dx / length;
                        animal.moveY = dy / length;
                    }
                    animal.state = 'walking';
                    animal.decisionTimer = Math.max(animal.decisionTimer, 0.8);
                }
            }
            const alarm = !wasFleeing && animal.state === 'fleeing';
            // Bicho do outro lado da tela não canta no ouvido de ninguém: a conversa ociosa
            // acontece na frente de quem ouve. O alarme é o único que fura a beirada, porque o
            // susto que o produziu veio justamente de algo que estava chegando por trás.
            const naTela = !context.isVisible
                || context.isVisible(animal.x, animal.y, animal.radius + 2);
            const perto = Math.hypot(animal.x - player.x, animal.y - player.y) <= exports.WILDLIFE_CALL_RADIUS;
            if (context.onCall && callsLeft > 0 && perto && animal.callTimer <= 0
                && (naTela || alarm) && (alarm ? this.alarmCooldown <= 0
                : this.voiceCooldown <= 0 && animal.state === 'idle')) {
                animal.callTimer = (alarm ? 14 : 20) + random(animal) * 14;
                if (alarm)
                    this.alarmCooldown = VOZ_ALARME_S;
                else
                    this.voiceCooldown = VOZ_CALMA_S;
                callsLeft--;
                context.onCall(animal, alarm ? 'alarm' : 'idle');
            }
            if (animal.state === 'walking' || animal.state === 'fleeing')
                this.move(animal, liveDt, context);
            else
                animal.speed = 0;
        }
        // No catch-up bursts after suspension. One slot / 0.75s, at most twelve revalidations.
        this.restockTimer = Math.max(0, this.restockTimer - liveDt);
        if (validPlayer && this.animals.length && this.restockTimer === 0) {
            this.restockTimer = exports.WILDLIFE_RESTOCK_SECONDS;
            const needsLocal = !!context.isVisible && localCount < exports.WILDLIFE_LOCAL_TARGET;
            for (let scanned = 0; scanned < this.animals.length; scanned++) {
                const animal = this.animals[this.respawnCursor];
                this.respawnCursor = (this.respawnCursor + 1) % this.animals.length;
                const history = this.history.get(animal);
                const expired = animal.dead && animal.deathTimer >= Animal_1.ANIMAL_CORPSE_SECONDS;
                // Never erase a body, heal a wounded animal, or move a recently observed/chased life.
                const donor = !animal.dead && needsLocal && history && history.hiddenFor >= 6 && history.settledFor >= 12;
                if (!expired && !donor)
                    continue;
                const localBuckets = needsLocal ? this.bySpecies[animal.species]?.filter((b) => Math.hypot(b.x - player.x, b.y - player.y) <= exports.WILDLIFE_LOCAL_RADIUS + HABITAT_CELL) : undefined;
                if (donor && !localBuckets?.length)
                    continue;
                const local = !!localBuckets?.length;
                const point = this.pickSpawn(context.map, animal.species, player, local ? 8 : exports.WILDLIFE_RESPAWN_DISTANCE, exports.WILDLIFE_RESPAWN_ATTEMPTS, animal, context.isVisible, context.vehicles, local ? localBuckets : undefined, local ? exports.WILDLIFE_LOCAL_RADIUS : Infinity);
                if (point) {
                    const generation = animal.generation + 1;
                    Object.assign(animal, (0, Animal_1.createAnimal)(animal.id, animal.species, point.x, point.y, Math.floor(random(this.rng) * 0x100000000)), { generation });
                    this.resetBehaviour(animal);
                    changed = true;
                }
                break;
            }
        }
        if (changed)
            (context.onStructChange ?? this.onStructChange)?.();
    }
    resetBehaviour(animal) {
        this.beginHistory(animal);
        const angle = random(animal) * Math.PI * 2;
        animal.moveX = Math.cos(angle);
        animal.moveY = Math.sin(angle);
        animal.dir = this.direction(animal.moveX, animal.moveY);
        animal.decisionTimer = 0.5 + random(animal) * 4;
        animal.callTimer = 4 + random(animal) * 16;
        animal.animTime = random(animal) * 10;
    }
    direction(x, y) {
        return x + y >= 0 ? (x - y >= 0 ? 'SE' : 'SW') : (x - y >= 0 ? 'NE' : 'NW');
    }
    pickSpawn(map, species, player, distance, attempts, skip, visible, vehicles, buckets = this.bySpecies[species], maxDistance = Infinity) {
        if (!buckets?.length)
            return null;
        const radius = Animal_1.ANIMAL_STATS[species].radius;
        for (let attempt = 0; attempt < attempts; attempt++) {
            const bucket = buckets[Math.floor(random(this.rng) * buckets.length)];
            // A majority of encounters originate along trails/clearings, not behind scenery.
            const samples = bucket.trails.length && (!bucket.ground.length || random(this.rng) < 0.7)
                ? bucket.trails : bucket.ground;
            const base = samples[Math.floor(random(this.rng) * samples.length)];
            const x = base.x + (random(this.rng) - 0.5) * 0.24;
            const y = base.y + (random(this.rng) - 0.5) * 0.24;
            const separation = player ? Math.hypot(x - player.x, y - player.y) : Infinity;
            if (player && (separation <= distance || separation > maxDistance))
                continue;
            if (visible?.(x, y, radius + 2))
                continue;
            const biome = map.data.tiles[Math.floor(y) * map.data.tilesW + Math.floor(x)]?.biome;
            if (!biome || !(0, Animal_1.isAnimalHabitat)(biome) || !Animal_1.ANIMAL_HABITATS[species].includes(biome))
                continue;
            if (!isWildlifePositionSafe(map, x, y, radius + 0.04))
                continue;
            if (this.animals.some((other) => other !== skip && Math.hypot(x - other.x, y - other.y) < radius + other.radius + 0.8))
                continue;
            let blocked = false;
            for (const vehicle of vehicles ?? []) {
                if ((vehicle.altitude ?? 0) <= 0.5 && overlapsBox(x, y, radius + 0.1, vehicleBox(vehicle))) {
                    blocked = true;
                    break;
                }
            }
            if (blocked)
                continue;
            return { x, y };
        }
        return null;
    }
    /**
     * O que ameaça o bicho agora, e por qual sentido. A vista é um arco à sua frente: quem
     * chega por trás não é visto, apenas sentido quando já está em cima dele. Barulho e
     * motor não têm arco — vibração do chão se percebe dos quatro lados.
     */
    findThreat(animal, context) {
        let result = null;
        let best = 1;
        const consider = (point, radius, seen, watch = 1) => {
            if (!Number.isFinite(radius) || radius <= 0)
                return;
            const distance = Math.hypot(animal.x - point.x, animal.y - point.y);
            const relative = distance / radius;
            if (relative > best)
                return;
            best = relative;
            result = { x: point.x, y: point.y, distance, seen, urgent: relative <= watch };
        };
        const player = context.player;
        if (!player.dead && (player.health ?? 1) > 0) {
            const stats = Animal_1.ANIMAL_STATS[animal.species];
            // A espécie define o quão longe ela se incomoda; a vista nunca passa o teto geral.
            const range = Math.min(stats.alertRadius, GameConfig_1.GAME_CONFIG.WILDLIFE_VISION_RANGE);
            const cfg = { range, halfFov: GameConfig_1.GAME_CONFIG.WILDLIFE_VISION_HALF };
            const viewer = { x: animal.x, y: animal.y, dir: animal.dir };
            const target = { x: player.x, y: player.y };
            const light = context.night ? GameConfig_1.GAME_CONFIG.VISION_NIGHT_LIGHT : 1;
            // De frente enxerga o arco inteiro; de costas só sente quem encosta.
            if ((0, VisionSystem_1.inCone)(viewer, target, cfg, light))
                consider(player, range, true, WILDLIFE_WATCH_RATIO);
            else
                consider(player, stats.alertRadius * WILDLIFE_STARTLE_RATIO, false);
        }
        const noise = context.noise;
        if (noise) {
            if ('x' in noise)
                consider(noise, noise.radius ?? 18, false);
            else
                for (let i = 0; i < Math.min(16, noise.length); i++)
                    consider(noise[i], noise[i].radius ?? 18, false);
        }
        for (const { vehicle } of this.vehicleCandidates) {
            if (vehicle.state === 'destroyed' || Math.abs(vehicle.speed ?? 0) < 0.35)
                continue;
            consider(vehicle, 6 + Math.min(4, Math.abs(vehicle.speed ?? 0) * 0.25), false);
        }
        return result;
    }
    /**
     * Memória de presa. Ver o jogador de longe faz parar e observar; ver de perto, ou sentir
     * o chão tremer às costas, é corrida imediata. 'alert' e 'hostile' correm igual — o que
     * cresce é a atenção, que abre o arco e demora mais para o bicho se acalmar.
     */
    perceive(animal, threat, context, dt) {
        const history = this.history.get(animal) ?? this.beginHistory(animal);
        return (0, DetectionResponse_1.observe)(history.detection, {
            seen: !!threat?.seen,
            heard: !!threat && !threat.seen,
            distance: threat?.distance ?? Infinity,
            kind: 'wildlife',
            threat: !!threat && threat.urgent,
            forgetAfter: WILDLIFE_CALM_S,
        }, threat ?? context.player, dt);
    }
    /** Ficha de vida de um slot: o que ele esqueceu e há quanto tempo está parado. */
    beginHistory(animal) {
        const history = { hiddenFor: 0, settledFor: 0, detection: (0, DetectionResponse_1.createMemory)() };
        this.history.set(animal, history);
        return history;
    }
    move(animal, dt, context) {
        const stats = Animal_1.ANIMAL_STATS[animal.species];
        const distance = (animal.state === 'fleeing' ? stats.fleeSpeed : stats.walkSpeed) * dt;
        const steps = Math.ceil(distance / 0.16);
        const step = distance / steps;
        const startX = animal.x, startY = animal.y;
        let travelled = 0;
        for (let i = 0; i < steps; i++) {
            let moved = false;
            for (const turn of STEERING) {
                const dx = (animal.moveX * Math.cos(turn) - animal.moveY * Math.sin(turn)) * step;
                const dy = (animal.moveX * Math.sin(turn) + animal.moveY * Math.cos(turn)) * step;
                const x = animal.x + dx / 2, y = animal.y + dy / 2;
                // The whole swept footprint fits in this box: no thin-fence or shoreline tunnelling.
                const radius = animal.radius + Math.max(Math.abs(dx), Math.abs(dy)) / 2;
                if (!isWildlifePathSafe(context.map, x, y, radius))
                    continue;
                // A curva que segue o talude é a mesma que desvia da cerca: o animal contorna a
                // montanha em vez de atravessar a parede de terra ou despencar do platô.
                if (!context.map.canClimb(animal.x, animal.y, animal.x + dx, animal.y + dy))
                    continue;
                let blocked = false;
                for (const { box } of this.vehicleCandidates) {
                    if (overlapsBox(x, y, radius, box)) {
                        blocked = true;
                        break;
                    }
                }
                if (blocked)
                    continue;
                animal.x += dx;
                animal.y += dy;
                travelled += step;
                moved = true;
                break;
            }
            if (!moved)
                break;
        }
        animal.speed = travelled / dt;
        if (travelled > 0.00001) {
            animal.animTime += dt;
            animal.dir = this.direction(animal.x - startX, animal.y - startY);
        }
        else if (animal.state === 'walking')
            animal.decisionTimer = 0;
    }
}
exports.WildlifeSystem = WildlifeSystem;
