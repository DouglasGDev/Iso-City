"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PoliceSystem = void 0;
const GameConfig_1 = require("../game/GameConfig");
const Player_1 = require("../entities/Player");
const NPC_1 = require("../entities/NPC");
const Vehicle_1 = require("../entities/Vehicle");
const vehicles_1 = require("../data/vehicles");
const IsoUtils_1 = require("../world/IsoUtils");
const SoundManager_1 = require("../audio/SoundManager");
const TerrainSystem_1 = require("./TerrainSystem");
const CollisionSystem_1 = require("./CollisionSystem");
const WeaponSystem_1 = require("./WeaponSystem");
const CoverSystem_1 = require("./CoverSystem");
const VisionSystem_1 = require("./VisionSystem");
const DetectionResponse_1 = require("./DetectionResponse");
const TacticsSystem_1 = require("./TacticsSystem");
const AirSupportSystem_1 = require("./AirSupportSystem");
const nav = () => ({ route: [], routeIndex: 0, refreshTimer: 0, goal: null, sweep: 0, wait: 0 });
const SEARCH_MIN = 4;
const SEARCH_MAX = 18;
const FLEET_TIERS = [1, 1, 1, 2, 3, 4, 5, 5];
/** Distância de tiro desejada e alcance útil por estrela: SWAT e federal atiram mais longe e abrem mais. */
const COP_STANDOFF = [0, 0, 5.2, 5.8, 6.6, 7];
const COP_FIRE_RANGE = [0, 0, 11, 11, 12.5, 14];
const COP_AIM_TURN = 6.5;
/** Marca de uma unidade sem viatura: a equipe que desceu de corda do helicóptero. */
const AIRBORNE_UNIT = -1;
class PoliceSystem {
    constructor() {
        this.units = [];
        this.cops = [];
        this.tracers = [];
        this.nearestPoliceDist = Infinity;
        this.searchArea = null;
        this.playerVisible = false;
        this.initialized = false;
        this.dispatchTimer = 0;
        this.sirenTimer = 0;
        this.unseenTimer = 0;
        this.nextTracerId = 1000000;
        this.lastContext = null;
        this.tactics = new TacticsSystem_1.TacticsSystem();
        this.air = new AirSupportSystem_1.AirSupportSystem();
    }
    get active() { return this.searchArea !== null && this.units.some((u) => u.mode === 'respond' || u.mode === 'deployed'); }
    init(ctx) {
        if (this.initialized)
            return;
        this.initialized = true;
        this.lastContext = ctx;
        const spawn = ctx.map.data.playerSpawn;
        const stations = ctx.map.landmarksOf('police').slice().sort((a, b) => Math.hypot(a.x - spawn.x, a.y - spawn.y) - Math.hypot(b.x - spawn.x, b.y - spawn.y));
        if (!stations.length)
            return;
        for (let slot = 0; slot < FLEET_TIERS.length; slot++) {
            const station = stations[slot % stations.length];
            const candidates = ctx.map.roadNodes.filter((p) => Math.hypot(p.x - station.front.x, p.y - station.front.y) < 10)
                .map((node) => {
                const lane = ctx.map.laneAt(node.x, node.y);
                return { x: node.x + (lane === 'NE' ? 1.1 : lane === 'SW' ? -1.1 : 0),
                    y: node.y + (lane === 'SE' ? 1.1 : lane === 'NW' ? -1.1 : 0), lane };
            }).filter((p) => p.lane && ctx.map.tileKindAt(p.x, p.y) !== 'road');
            candidates.sort((a, b) => Math.hypot(a.x - station.front.x, a.y - station.front.y) - Math.hypot(b.x - station.front.x, b.y - station.front.y));
            const spot = candidates.find((p) => ctx.map.isInside(p.x, p.y, 0.85) && !ctx.map.isWaterWorld(p.x, p.y) &&
                !ctx.collision.overlapsAny({ ...p, radius: 0.85 }, ctx.map.queryNearby(p.x, p.y, 2)) &&
                !ctx.vehicles.some((v) => Math.hypot(v.x - p.x, v.y - p.y) < 2));
            if (!spot)
                continue;
            const tier = FLEET_TIERS[slot];
            const def = vehicles_1.VEHICLE_DEFS[tier >= 3 ? 'swat' : slot % 2 === 0 ? 'police_compact' : 'police'];
            const vehicle = (0, Vehicle_1.createVehicle)(ctx.allocVehicleId(), def, '', spot.x, spot.y, spot.lane ?? 'SE');
            vehicle.health = tier >= 3 ? 220 : 120;
            vehicle.occupied = true;
            const unit = { ...nav(), vehicleId: vehicle.id, home: { ...spot }, crew: [], tier,
                mode: slot < 3 ? 'patrol' : 'standby', stuckTimer: 0, ramCooldown: 0 };
            vehicle.state = unit.mode === 'patrol' ? 'driving' : 'parked';
            ctx.vehicles.push(vehicle);
            this.units.push(unit);
            for (let seat = 0; seat < (tier >= 3 ? 3 : 2); seat++) {
                const npc = (0, NPC_1.createNPC)(ctx.allocNpcId(), 'a', spot.x, spot.y, 'cop', ctx.rng);
                npc.inVehicle = true;
                npc.vehicleId = vehicle.id;
                npc.health = tier >= 3 ? 100 : 70;
                ctx.npcs.push(npc);
                unit.crew.push(npc.id);
                this.cops.push({ ...nav(), npcId: npc.id, vehicleId: vehicle.id,
                    shotCooldown: 0.8 + seat * 0.3, aimAngle: 0, fireFlash: 0, armed: false,
                    detection: (0, DetectionResponse_1.createMemory)(), response: 'ignore' });
            }
        }
        ctx.onStructChange();
    }
    report(point) {
        if (!Number.isFinite(point.x) || !Number.isFinite(point.y))
            return;
        this.searchArea = { x: point.x, y: point.y, radius: SEARCH_MIN, phase: 'search' };
        this.unseenTimer = 0;
        this.dispatchTimer = 0;
        for (const unit of this.units)
            if (unit.mode === 'respond' || unit.mode === 'deployed')
                Object.assign(unit, nav());
        for (const cop of this.cops)
            Object.assign(cop, nav());
    }
    reset() {
        this.searchArea = null;
        this.playerVisible = false;
        this.nearestPoliceDist = Infinity;
        this.unseenTimer = this.dispatchTimer = this.sirenTimer = 0;
        this.tracers.length = 0;
        for (const unit of this.units) {
            if (unit.mode !== 'standby')
                unit.mode = 'return';
            Object.assign(unit, nav());
        }
        for (const cop of this.cops) {
            cop.armed = false;
            cop.fireFlash = 0;
            Object.assign(cop, nav());
        }
        this.tactics.reset();
        if (this.lastContext) {
            this.lastContext.player.arrestTimer = 0;
            // A caça acabou: recolhe o apoio aéreo e libera as equipes que desceram de corda.
            this.air.reset(this.airContext(this.lastContext));
            this.releaseAirborne(this.lastContext);
        }
        SoundManager_1.sound.setLoop('siren', null);
    }
    update(dt, ctx) {
        if (!Number.isFinite(dt) || dt <= 0)
            return;
        this.init(ctx);
        this.lastContext = ctx;
        for (const tracer of this.tracers)
            tracer.life -= dt;
        this.tracers = this.tracers.filter((t) => t.life > 0);
        const level = Math.min(5, Math.ceil(ctx.player.wantedLevel));
        // Sem delegacia não há frota, logo não há apoio aéreo. O voo usa o último ponto
        // conhecido; a varredura de solo só decide depois que o holofote localiza o alvo.
        if (this.units.length)
            this.air.update(dt, level, this.airContext(ctx));
        if (level <= 0) {
            if (this.searchArea)
                this.reset();
            this.playerVisible = false;
            this.releaseAirborne(ctx);
        }
        else
            this.perceive(dt, ctx);
        this.dispatchTimer -= dt;
        if (level > 0 && this.searchArea && this.dispatchTimer <= 0 && this.unseenTimer < 16) {
            const count = this.units.filter((u) => (u.mode === 'respond' || u.mode === 'deployed') && this.operational(u, ctx)).length;
            const target = GameConfig_1.GAME_CONFIG.POLICE_UNITS_BY_WANTED[level];
            if (count < target) {
                const choices = this.units.filter((u) => (u.mode === 'patrol' || u.mode === 'standby' || u.mode === 'return') &&
                    u.tier <= level && this.operational(u, ctx));
                choices.sort((a, b) => {
                    if (level >= 3 && a.tier !== b.tier)
                        return b.tier - a.tier;
                    const av = this.vehicle(ctx, a.vehicleId), bv = this.vehicle(ctx, b.vehicleId);
                    return Math.hypot(av.x - this.searchArea.x, av.y - this.searchArea.y) - Math.hypot(bv.x - this.searchArea.x, bv.y - this.searchArea.y);
                });
                const unit = choices[0];
                if (unit) {
                    unit.mode = 'respond';
                    Object.assign(unit, nav());
                }
            }
            this.dispatchTimer = 2.5;
        }
        for (const unit of this.units)
            this.updateUnit(dt, unit, ctx, level);
        for (const cop of this.cops)
            this.updateCop(dt, cop, ctx, level);
        this.checkArrest(dt, ctx, level);
        this.sirens(dt, ctx);
    }
    vehicle(ctx, id) { return ctx.vehicles.find((v) => v.id === id); }
    npc(ctx, id) { return ctx.npcs.find((n) => n.id === id); }
    operational(unit, ctx) {
        const vehicle = this.vehicle(ctx, unit.vehicleId);
        return !!vehicle && vehicle.health > 0 && vehicle.state !== 'destroyed' && ctx.player.currentVehicleId !== vehicle.id &&
            unit.crew.some((id) => { const n = this.npc(ctx, id); return n && !n.dead && n.health > 0; });
    }
    /** O helicóptero persegue o último ponto conhecido; a pé, a equipe descida de corda é dele. */
    airContext(ctx) {
        return {
            map: ctx.map, player: ctx.player, vehicles: ctx.vehicles, rng: ctx.rng,
            concealed: ctx.concealed, allocVehicleId: ctx.allocVehicleId, onStructChange: ctx.onStructChange,
            target: this.searchArea,
            sky: ctx.sky, time: ctx.time,
            deployOfficer: (x, y, tier) => this.deployOfficer(x, y, tier, ctx),
        };
    }
    /**
     * Policial de corda: a pé, sem viatura, preso a uma unidade aérea descartável. A ficha dele
     * sai do mundo quando a caça termina, então a população nunca cresce com o tempo.
     */
    deployOfficer(x, y, tier, ctx) {
        const circle = { x, y, radius: GameConfig_1.GAME_CONFIG.NPC_RADIUS };
        if (!ctx.map.isInside(x, y, circle.radius) || ctx.map.isWaterWorld(x, y) ||
            ctx.collision.overlapsAny(circle, ctx.map.queryNearby(x, y, 1)) ||
            ctx.npcs.some((n) => !n.dead && !n.inVehicle && Math.hypot(n.x - x, n.y - y) < 0.5) ||
            ctx.vehicles.some((v) => v.altitude <= 0.5 && v.state !== 'destroyed' && Math.hypot(v.x - x, v.y - y) < 1.2))
            return false;
        const npc = (0, NPC_1.createNPC)(ctx.allocNpcId(), 'a', x, y, 'cop', ctx.rng);
        npc.health = tier >= 3 ? 100 : 70;
        npc.state = 'chasing';
        ctx.npcs.push(npc);
        this.units.push({ ...nav(), vehicleId: AIRBORNE_UNIT, home: { x, y }, crew: [npc.id], tier,
            mode: 'deployed', stuckTimer: 0, ramCooldown: 0 });
        this.cops.push({ ...nav(), npcId: npc.id, vehicleId: AIRBORNE_UNIT,
            shotCooldown: 0.5 + ctx.rng() * 0.5, aimAngle: 0, fireFlash: 0, armed: false,
            detection: (0, DetectionResponse_1.createMemory)(), response: 'ignore' });
        ctx.onStructChange();
        return true;
    }
    /** A caça acabou: recolhe os helicópteros e libera as equipes descidas de corda. */
    releaseAirborne(ctx) {
        let changed = false;
        for (let i = this.units.length - 1; i >= 0; i--) {
            if (this.units[i].vehicleId !== AIRBORNE_UNIT)
                continue;
            const unit = this.units.splice(i, 1)[0];
            for (const id of unit.crew) {
                const index = this.cops.findIndex((cop) => cop.npcId === id);
                if (index >= 0)
                    this.cops.splice(index, 1);
                this.tactics.forget(id);
                const npc = this.npc(ctx, id);
                if (!npc)
                    continue;
                if (npc.dead) {
                    npc.kind = 'civ';
                    continue;
                } // O corpo fica para o LifeSystem reciclar.
                ctx.npcs.splice(ctx.npcs.indexOf(npc), 1);
            }
            changed = true;
        }
        if (changed)
            ctx.onStructChange();
    }
    clearLine(map, from, to) {
        const radius = Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y)) / 2;
        return !map.queryNearby((from.x + to.x) / 2, (from.y + to.y) / 2, radius + 0.01)
            .some((box) => (0, WeaponSystem_1.segmentAabb)(from.x, from.y, to.x, to.y, box) !== null);
    }
    /**
     * Visão de um inimigo: cone (alcance + arco conforme o quanto está tenso) e depois
     * obstrução real por prédios e carros. De costas, nem a 1 tile ele percebe alguém.
     */
    sees(ctx, from, range, alert = 0, ignoreVehicleId = null) {
        if (ctx.concealed || ctx.player.health <= 0)
            return false;
        const cfg = {
            range,
            halfFov: alert > 0 ? GameConfig_1.GAME_CONFIG.POLICE_VISION_HALF_ALERT : GameConfig_1.GAME_CONFIG.POLICE_VISION_HALF_FOOT,
        };
        return (0, VisionSystem_1.canSee)({ ...from, alert }, { x: ctx.player.x, y: ctx.player.y, crouched: ctx.player.crouching }, ctx, cfg, {
            light: ctx.night ? GameConfig_1.GAME_CONFIG.VISION_NIGHT_LIGHT : 1,
            ignoreVehicle: (v) => v.id === ignoreVehicleId || v.id === ctx.player.currentVehicleId,
        }).seen;
    }
    /** Memória do policial: ver abre o arco e grava a última posição; sumir relaxa aos poucos. */
    observe(dt, cop, npc, ctx, range) {
        // O oficial só registra o que vê com os próprios olhos: denúncia e tiro já entram
        // por `report()`. E com o alvo escondido nada aqui toca na posição real dele.
        // O olhar de um oficial segue o corpo: a mira só vira a cabeça depois que ele vê,
        // então usar aimAngle como direção criaria um laço em que ele nunca enxerga nada.
        const seen = this.sees(ctx, { x: npc.x, y: npc.y, dir: npc.dir }, range, cop.detection.attention);
        const distance = seen ? Math.hypot(npc.x - ctx.player.x, npc.y - ctx.player.y) : Infinity;
        cop.response = (0, DetectionResponse_1.observe)(cop.detection, { seen, heard: false, distance,
            // Tiroteio em curso é ameaça clara; a 1,5 tile de um civil desarmado ainda é só suspeita.
            threat: cop.armed && distance < range, kind: 'police', forgetAfter: GameConfig_1.GAME_CONFIG.POLICE_ALERT_MEMORY_S }, seen ? { x: ctx.player.x, y: ctx.player.y } : cop.detection.lastSeen ?? { x: npc.x, y: npc.y }, dt);
        return seen;
    }
    perceive(dt, ctx) {
        const previous = this.playerVisible;
        this.playerVisible = this.air.spotsPlayer || this.units.some((u) => {
            const v = this.vehicle(ctx, u.vehicleId);
            return !!v && this.operational(u, ctx) && u.crew.some((id) => this.npc(ctx, id)?.inVehicle) &&
                this.sees(ctx, { x: v.x, y: v.y, dir: v.dir, z: v.altitude }, GameConfig_1.GAME_CONFIG.POLICE_VISION_RANGE_VEHICLE, 0, v.id);
        }) || ctx.npcs.some((n) => n.kind === 'cop' && !n.dead && n.health > 0 && !n.inVehicle &&
            n.state !== 'knocked' && this.sees(ctx, { x: n.x, y: n.y, dir: n.dir }, GameConfig_1.GAME_CONFIG.POLICE_VISION_RANGE_FOOT));
        if (this.playerVisible) {
            this.unseenTimer = 0;
            this.searchArea = { x: ctx.player.x, y: ctx.player.y, radius: SEARCH_MIN, phase: 'pursuit' };
        }
        else if (this.searchArea) {
            const growing = Math.min(dt, Math.max(0, 8 - this.unseenTimer));
            this.unseenTimer += dt;
            this.searchArea.phase = 'search';
            this.searchArea.radius = Math.max(SEARCH_MIN, Math.min(SEARCH_MAX, this.searchArea.radius + (2 * growing - dt) * 0.55));
        }
        if (previous !== this.playerVisible) {
            for (const unit of this.units)
                if (unit.mode === 'respond' || unit.mode === 'deployed')
                    Object.assign(unit, nav());
            for (const cop of this.cops)
                Object.assign(cop, nav());
        }
    }
    searchGoal(agent, from, dt, ctx, onFoot) {
        const area = this.searchArea;
        if (this.playerVisible)
            return area;
        if (!agent.goal)
            agent.goal = { x: area.x, y: area.y };
        if (Math.hypot(from.x - agent.goal.x, from.y - agent.goal.y) < 1.3 ||
            (agent.route.length > 0 && agent.routeIndex >= agent.route.length)) {
            agent.wait += dt;
            if (agent.wait > 1.5) {
                const angle = ++agent.sweep * 2.4;
                const probe = { x: area.x + Math.cos(angle) * area.radius * 0.75, y: area.y + Math.sin(angle) * area.radius * 0.75 };
                const nodes = onFoot ? ctx.map.sidewalkNodes : ctx.map.roadNodes;
                const index = onFoot ? ctx.map.nearestSidewalkNode(probe.x, probe.y) : ctx.map.nearestRoadNode(probe.x, probe.y);
                agent.goal = nodes[index] ? { ...nodes[index] } : { x: area.x, y: area.y };
                agent.wait = 0;
                agent.refreshTimer = 0;
            }
        }
        return agent.goal;
    }
    waypoint(agent, from, goal, dt, ctx, onFoot, patrol = false) {
        agent.refreshTimer -= dt;
        const distance = Math.hypot(from.x - goal.x, from.y - goal.y);
        let dry = true;
        if (distance < 6) {
            const steps = Math.max(1, Math.ceil(distance * 3));
            for (let i = 1; i <= steps; i++)
                if (ctx.map.isWaterWorld(from.x + (goal.x - from.x) * i / steps, from.y + (goal.y - from.y) * i / steps))
                    dry = false;
        }
        if (onFoot && distance < 6 && dry && this.clearLine(ctx.map, from, goal))
            return goal;
        if (agent.refreshTimer <= 0) {
            agent.route = onFoot ? ctx.map.findSidewalkPath(from.x, from.y, goal.x, goal.y) :
                patrol ? ctx.map.findRoadPath(from.x, from.y, goal.x, goal.y) : ctx.map.findUndirectedRoadPath(from.x, from.y, goal.x, goal.y);
            agent.routeIndex = agent.route.length > 1 && Math.hypot(agent.route[0].x - from.x, agent.route[0].y - from.y) < 0.75 ? 1 : 0;
            agent.refreshTimer = patrol ? 12 : 2.2 + ctx.rng() * 0.4;
        }
        while (agent.routeIndex < agent.route.length && Math.hypot(from.x - agent.route[agent.routeIndex].x, from.y - agent.route[agent.routeIndex].y) < 0.2)
            agent.routeIndex++;
        if (agent.routeIndex < agent.route.length)
            return agent.route[agent.routeIndex];
        return onFoot && distance < 5 && dry && this.clearLine(ctx.map, from, goal) ? goal : from;
    }
    updateUnit(dt, unit, ctx, level) {
        const v = this.vehicle(ctx, unit.vehicleId);
        if (!v)
            return;
        const crew = unit.crew.map((id) => this.npc(ctx, id)).filter((n) => !!n);
        const alive = crew.filter((n) => !n.dead && n.health > 0);
        if (v.health <= 0 || v.state === 'destroyed' || ctx.player.currentVehicleId === v.id) {
            this.disembark(unit, ctx);
            if (v.state === 'destroyed')
                for (const n of crew) {
                    n.inVehicle = false;
                    n.vehicleId = null;
                }
            return;
        }
        if (!alive.length) {
            v.speed = 0;
            v.state = 'parked';
            v.occupied = false;
            return;
        }
        for (const n of crew)
            if (n.inVehicle) {
                n.x = v.x;
                n.y = v.y;
                n.lastX = v.x;
                n.lastY = v.y;
            }
        if ((unit.mode === 'respond' || unit.mode === 'deployed') && (level <= 0 || !this.searchArea)) {
            unit.mode = 'return';
            Object.assign(unit, nav());
        }
        const foot = alive.some((n) => !n.inVehicle);
        if (unit.mode === 'deployed') {
            this.disembark(unit, ctx);
            v.speed = 0;
            v.state = 'parked';
            if (this.searchArea && Math.hypot(v.x - this.searchArea.x, v.y - this.searchArea.y) > 17)
                unit.mode = 'respond';
            else
                return;
        }
        if (foot) {
            v.speed = 0;
            v.state = 'parked';
            return;
        }
        if (unit.mode === 'standby') {
            v.speed = 0;
            v.state = 'parked';
            return;
        }
        let goal;
        if (unit.mode === 'respond' && this.searchArea) {
            goal = this.searchGoal(unit, v, dt, ctx, false);
            const close = Math.hypot(v.x - goal.x, v.y - goal.y) <= (this.playerVisible ? 5 : 3);
            if (close || (unit.stuckTimer > 2.5 && Math.hypot(v.x - goal.x, v.y - goal.y) < 12)) {
                v.speed = 0;
                v.state = 'parked';
                this.disembark(unit, ctx);
                unit.mode = 'deployed';
                return;
            }
        }
        else if (unit.mode === 'return') {
            goal = unit.home;
            if (Math.hypot(v.x - goal.x, v.y - goal.y) < 1) {
                unit.mode = unit.tier === 1 ? 'patrol' : 'standby';
                Object.assign(unit, nav());
                v.speed = 0;
                return;
            }
        }
        else {
            if (!unit.goal || Math.hypot(v.x - unit.goal.x, v.y - unit.goal.y) < 1 ||
                (unit.route.length > 0 && unit.routeIndex >= unit.route.length)) {
                const angle = ++unit.sweep * 2.4 + unit.vehicleId;
                const probe = { x: unit.home.x + Math.cos(angle) * 28, y: unit.home.y + Math.sin(angle) * 28 };
                unit.goal = ctx.map.roadNodes[ctx.map.nearestRoadNode(probe.x, probe.y)] ?? unit.home;
                unit.refreshTimer = 0;
            }
            goal = unit.goal;
        }
        const target = unit.mode === 'return' && Math.hypot(v.x - goal.x, v.y - goal.y) < 2 && this.clearLine(ctx.map, v, goal)
            ? goal : this.waypoint(unit, v, goal, dt, ctx, false, unit.mode === 'patrol');
        const dx = target.x - v.x, dy = target.y - v.y, distance = Math.hypot(dx, dy);
        if (distance < 0.05) {
            v.speed = 0;
            unit.stuckTimer += dt;
            return;
        }
        const dir = Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 'SE' : 'NW') : (dy >= 0 ? 'SW' : 'NE');
        v.dir = dir;
        v.facingAngle = (0, IsoUtils_1.dirToAngle)(dir);
        const speed = unit.mode === 'patrol' ? 1.6 : GameConfig_1.GAME_CONFIG.POLICE_SPEED + level * 0.14;
        v.speed = Math.min(speed, v.speed + GameConfig_1.GAME_CONFIG.VEHICLE_ACCEL * dt, distance / dt);
        v.state = 'driving';
        const before = { x: v.x, y: v.y };
        this.slide(v, ctx, dx / distance * v.speed, dy / distance * v.speed, dt);
        const moved = Math.hypot(v.x - before.x, v.y - before.y);
        if (moved < v.speed * dt * 0.15) {
            unit.stuckTimer += dt;
            if (unit.stuckTimer > 1)
                unit.refreshTimer = 0;
        }
        else
            unit.stuckTimer = 0;
        for (const n of crew)
            if (n.inVehicle) {
                n.x = v.x;
                n.y = v.y;
            }
    }
    exitPoint(v, npc, ctx) {
        const box = (0, CollisionSystem_1.vehicleGroundCollider)(v);
        const margin = GameConfig_1.GAME_CONFIG.NPC_RADIUS + 0.12;
        const points = [
            { x: box.x - margin, y: v.y }, { x: box.x + box.width + margin, y: v.y },
            { x: v.x, y: box.y - margin }, { x: v.x, y: box.y + box.height + margin },
        ].sort((a, b) => Math.hypot(a.x - npc.x, a.y - npc.y) - Math.hypot(b.x - npc.x, b.y - npc.y));
        for (const p of points) {
            const circle = { ...p, radius: GameConfig_1.GAME_CONFIG.NPC_RADIUS };
            if (!ctx.map.isInside(p.x, p.y, circle.radius) || ctx.map.isWaterWorld(p.x, p.y) ||
                ctx.collision.overlapsAny(circle, ctx.map.queryNearby(p.x, p.y, 1)) ||
                !this.clearLine(ctx.map, v, p))
                continue;
            if (ctx.vehicles.some((other) => other !== v && other.altitude <= 0.5 &&
                ctx.collision.overlapsAny(circle, [(0, CollisionSystem_1.vehicleGroundCollider)(other)])))
                continue;
            if (ctx.npcs.some((n) => n !== npc && !n.dead && !n.inVehicle && Math.hypot(n.x - p.x, n.y - p.y) < 0.4))
                continue;
            return p;
        }
        return null;
    }
    disembark(unit, ctx) {
        const v = this.vehicle(ctx, unit.vehicleId);
        if (!v)
            return;
        let changed = false;
        for (const id of unit.crew) {
            const npc = this.npc(ctx, id);
            if (!npc || !npc.inVehicle || npc.dead)
                continue;
            const point = this.exitPoint(v, npc, ctx);
            if (!point)
                continue;
            npc.x = point.x;
            npc.y = point.y;
            npc.lastX = point.x;
            npc.lastY = point.y;
            npc.inVehicle = false;
            npc.vehicleId = null;
            if (npc.state !== 'knocked')
                npc.state = 'chasing';
            changed = true;
        }
        if (ctx.player.currentVehicleId !== v.id)
            v.occupied = unit.crew.some((id) => this.npc(ctx, id)?.inVehicle);
        if (changed) {
            ctx.onStructChange();
            if (!ctx.concealed && Math.hypot(v.x - ctx.player.x, v.y - ctx.player.y) < 16)
                SoundManager_1.sound.play('doorOpen', 0.3);
        }
    }
    updateCop(dt, cop, ctx, level) {
        cop.fireFlash = Math.max(0, cop.fireFlash - dt);
        cop.shotCooldown = Math.max(0, cop.shotCooldown - dt);
        const npc = this.npc(ctx, cop.npcId);
        cop.armed = level >= 2 && !!this.searchArea;
        if (!npc || npc.dead || npc.health <= 0 || npc.inVehicle)
            return;
        if (npc.state === 'knocked') {
            npc.downTimer -= dt;
            npc.anim = 'idle';
            npc.speed = npc.frame = 0;
            if (npc.downTimer <= 0)
                npc.state = 'chasing';
            return;
        }
        // Equipe de corda não tem viatura: a unidade dela é achada pela tripulação.
        const unit = cop.vehicleId === AIRBORNE_UNIT ? this.units.find((u) => u.crew.includes(npc.id))
            : this.units.find((u) => u.vehicleId === cop.vehicleId);
        const vehicle = this.vehicle(ctx, cop.vehicleId);
        const returning = !this.searchArea || !unit || unit.mode === 'return' || unit.mode === 'respond';
        const visible = !returning && this.observe(dt, cop, npc, ctx, cop.armed ? GameConfig_1.GAME_CONFIG.POLICE_VISION_RANGE_VEHICLE : GameConfig_1.GAME_CONFIG.POLICE_VISION_RANGE_FOOT);
        let goal;
        if (returning && vehicle && vehicle.health > 0 && ctx.player.currentVehicleId !== vehicle.id) {
            goal = this.exitPoint(vehicle, npc, ctx) ?? { x: vehicle.x + 0.9, y: vehicle.y };
            this.tactics.forget(npc.id);
            if (Math.hypot(npc.x - goal.x, npc.y - goal.y) < 0.45 && this.clearLine(ctx.map, npc, goal)) {
                npc.inVehicle = true;
                npc.vehicleId = vehicle.id;
                npc.x = vehicle.x;
                npc.y = vehicle.y;
                npc.speed = 0;
                vehicle.occupied = true;
                Object.assign(cop, nav());
                ctx.onStructChange();
                return;
            }
        }
        else if (!visible && cop.detection.blindFor < 3 && cop.detection.lastSeen) {
            // Memória própria: o oficial varre o canto onde *ele* perdeu o alvo de vista,
            // não a média do esquadrão. É isso que faz flanquear por trás funcionar.
            goal = cop.detection.lastSeen;
        }
        else if (this.searchArea)
            goal = this.searchGoal(cop, npc, dt, ctx, true);
        else {
            npc.state = 'idle';
            npc.anim = 'idle';
            npc.speed = 0;
            this.tactics.forget(npc.id);
            return;
        }
        const target = visible
            ? { x: ctx.player.x, y: ctx.player.y, visible: true, contactRange: GameConfig_1.GAME_CONFIG.ARREST_RANGE }
            : { x: goal.x, y: goal.y, visible: false, contactRange: GameConfig_1.GAME_CONFIG.ARREST_RANGE };
        const order = this.tactics.order(dt, { id: npc.id, x: npc.x, y: npc.y, radius: GameConfig_1.GAME_CONFIG.NPC_RADIUS,
            armed: cop.armed, cooldown: cop.shotCooldown, aimAngle: cop.aimAngle }, target, ctx, {
            standoff: COP_STANDOFF[level], fireRange: COP_FIRE_RANGE[level], turnRate: COP_AIM_TURN,
            allies: this.alliesFor(cop, npc, ctx),
        });
        cop.aimAngle = order.aimAngle;
        if (!visible) {
            // O oficial não fica campado no último ponto: ele varre em torno da direção onde
            // *acha* que o alvo está (memória dele, nunca a posição real). Isso revela quem está
            // colado no beco e mantém escondido quem está atrás de parede ou em interior.
            cop.sweep += dt;
            const memory = Math.atan2(goal.y - npc.y, goal.x - npc.x);
            cop.aimAngle = (0, IsoUtils_1.rotateAngleToward)(cop.aimAngle, memory + Math.sin(cop.sweep * 1.1) * 0.8, COP_AIM_TURN * dt);
        }
        const step = this.waypoint(cop, npc, order.anchor, dt, ctx, true);
        const dx = step.x - npc.x, dy = step.y - npc.y, d = Math.hypot(dx, dy);
        npc.speed = d < 0.12 ? 0 : Math.min(level === 1 ? 1.9 : 1.75, d / dt);
        npc.state = npc.speed || order.engaged ? 'chasing' : 'idle';
        npc.anim = npc.speed ? 'walk' : 'idle';
        if (npc.speed) {
            const steps = Math.max(1, Math.ceil(npc.speed * dt / 0.1));
            for (let i = 0; i < steps; i++) {
                const prevX = npc.x, prevY = npc.y;
                const circle = { x: npc.x + dx / d * npc.speed * dt / steps, y: npc.y + dy / d * npc.speed * dt / steps, radius: GameConfig_1.GAME_CONFIG.NPC_RADIUS };
                ctx.collision.resolveCircle(circle, ctx.map.queryNearby(circle.x, circle.y, 1.5));
                ctx.collision.resolveCircleVsVehicles(circle, ctx.vehicles);
                // O talude não deixa o policial cortar pela montanha: ele contorna pela rua,
                // exatamente como o muro de uma casa já o faz hoje.
                TerrainSystem_1.terrain.blockWalk(ctx.map, circle, prevX, prevY);
                if (ctx.map.isInside(circle.x, circle.y, circle.radius) && !ctx.map.isWaterWorld(circle.x, circle.y)) {
                    npc.x = circle.x;
                    npc.y = circle.y;
                }
            }
            npc.dir = (0, IsoUtils_1.velocityToDir)(dx, dy);
            npc.animTimer += dt * 1000;
            if (npc.animTimer > 110) {
                npc.animTimer = 0;
                npc.frame = (npc.frame + 1) % 4;
            }
        }
        else
            npc.frame = 0;
        npc.lastX = npc.x;
        npc.lastY = npc.y;
        // O corpo acompanha o olhar: é a mesma direção para o sprite, para o cone e para o radar.
        npc.dir = (0, IsoUtils_1.velocityToDir)(Math.cos(cop.aimAngle), Math.sin(cop.aimAngle));
        // A reação manda no gatilho: só atira quem chegou a "perseguir" — o que apenas
        // suspeita da movimentação avança e cerca, sem abrir fogo às cegas.
        if (order.fire && cop.shotCooldown <= 0 && cop.response === 'chase' && this.fire(cop, npc, ctx, level))
            this.tactics.noteShot(npc.id);
    }
    /**
     * Cones de visão dos oficiais empenhados, em coordenadas do mundo. O mapa desenha
     * exatamente o que a polícia pode ver agora: patrulha de rotina (memória em calma)
     * não vira raio-x na HUD, mas quem já te viu varre o arco aberto.
     */
    visionCones(ctx) {
        const cones = [];
        for (const cop of this.cops) {
            const npc = this.npc(ctx, cop.npcId);
            if (!npc || npc.dead || npc.inVehicle || npc.state === 'knocked' || cop.detection.phase === 'calm')
                continue;
            const viewer = { x: npc.x, y: npc.y, dir: npc.dir, alert: cop.detection.attention };
            const radius = cop.armed ? GameConfig_1.GAME_CONFIG.POLICE_VISION_RANGE_VEHICLE : GameConfig_1.GAME_CONFIG.POLICE_VISION_RANGE_FOOT;
            const cfg = { range: radius,
                halfFov: cop.detection.attention > 0 ? GameConfig_1.GAME_CONFIG.POLICE_VISION_HALF_ALERT : GameConfig_1.GAME_CONFIG.POLICE_VISION_HALF_FOOT };
            cones.push({ id: npc.id, x: npc.x, y: npc.y, axis: (0, VisionSystem_1.facingAngle)(viewer), half: (0, VisionSystem_1.fovHalf)(viewer, cfg),
                radius: (0, VisionSystem_1.sightRange)(viewer, cfg, ctx.night ? GameConfig_1.GAME_CONFIG.VISION_NIGHT_LIGHT : 1), alert: cop.detection.attention });
        }
        return cones;
    }
    /** Colegas a pé no mesmo tiroteio: a tática espaça o esquadrão em vez de empilhar todo mundo. */
    alliesFor(self, npc, ctx) {
        const allies = [];
        for (const other of this.cops) {
            if (other === self)
                continue;
            const mate = this.npc(ctx, other.npcId);
            if (!mate || mate.dead || mate.inVehicle || mate.state === 'knocked')
                continue;
            if (Math.hypot(mate.x - npc.x, mate.y - npc.y) > 10)
                continue;
            allies.push(mate);
        }
        return allies;
    }
    fire(cop, npc, ctx, level) {
        cop.shotCooldown = level >= 4 ? 0.7 : 1.35;
        cop.fireFlash = 0.12;
        const angle = cop.aimAngle + (ctx.rng() - 0.5) * (level >= 4 ? 0.045 : 0.11);
        const distance = Math.hypot(npc.x - ctx.player.x, npc.y - ctx.player.y);
        const end = { x: npc.x + Math.cos(angle) * (distance + 0.3), y: npc.y + Math.sin(angle) * (distance + 0.3), z: ctx.player.crouching ? 0.65 : 1.25 };
        const barrier = CoverSystem_1.CoverSystem.firstHit({ x: npc.x, y: npc.y, z: 1.35 }, end, ctx);
        let t = barrier?.t ?? 1;
        let hit = !!barrier;
        const victim = (0, WeaponSystem_1.segmentCircle)(npc.x, npc.y, end.x, end.y, ctx.player, GameConfig_1.GAME_CONFIG.PLAYER_RADIUS);
        const friendly = ctx.npcs.some((n) => {
            if (n === npc || n.dead || n.inVehicle)
                return false;
            const crossing = (0, WeaponSystem_1.segmentCircle)(npc.x, npc.y, end.x, end.y, n, GameConfig_1.GAME_CONFIG.NPC_RADIUS);
            return crossing !== null && crossing < t && (victim === null || crossing < victim);
        });
        if (friendly) {
            cop.fireFlash = 0;
            cop.shotCooldown = 0.25;
            return false;
        }
        if (victim !== null && victim < t && !(0, Player_1.isAboard)(ctx.player)) {
            t = victim;
            hit = true;
            if (ctx.health.damage(ctx.player, level >= 4 ? 10 : 7, ctx.time))
                ctx.shake(0.16);
        }
        else if (barrier?.vehicle && barrier.vehicle.id === ctx.player.currentVehicleId) {
            barrier.vehicle.health = Math.max(0, barrier.vehicle.health - (level >= 4 ? 9 : 5));
        }
        this.tracers.push({ id: this.nextTracerId++, x1: npc.x, y1: npc.y,
            x2: npc.x + (end.x - npc.x) * t, y2: npc.y + (end.y - npc.y) * t, life: 0.15, hit });
        if (distance < 22)
            SoundManager_1.sound.play(level >= 4 ? 'smgShot' : 'pistolShot', 0.32 * (1 - distance / 26));
        return true;
    }
    checkArrest(dt, ctx, level) {
        const player = ctx.player;
        const close = level === 1 && !ctx.concealed && this.cops.some((cop) => {
            const npc = this.npc(ctx, cop.npcId);
            // Prender é contato: o arco largo de quem já está em cima do alvo vale aqui.
            return npc && !npc.dead && !npc.inVehicle && npc.state !== 'knocked' &&
                this.sees(ctx, { x: npc.x, y: npc.y, dir: npc.dir }, GameConfig_1.GAME_CONFIG.ARREST_RANGE, 1);
        });
        if (close && !(0, Player_1.isAboard)(player) && Math.hypot(player.vx, player.vy) < 0.5 && player.health > 0) {
            player.arrestTimer += dt;
            if (player.arrestTimer >= GameConfig_1.GAME_CONFIG.ARREST_STAND_STILL_S) {
                player.arrestTimer = 0;
                ctx.onBusted();
            }
        }
        else
            player.arrestTimer = 0;
    }
    sirens(dt, ctx) {
        this.nearestPoliceDist = Infinity;
        if (!ctx.concealed)
            for (const unit of this.units) {
                if (unit.mode !== 'respond' && unit.mode !== 'deployed')
                    continue;
                const vehicle = this.vehicle(ctx, unit.vehicleId);
                if (vehicle && this.operational(unit, ctx))
                    this.nearestPoliceDist = Math.min(this.nearestPoliceDist, Math.hypot(vehicle.x - ctx.player.x, vehicle.y - ctx.player.y));
                for (const id of unit.crew) {
                    const npc = this.npc(ctx, id);
                    if (npc && !npc.dead && !npc.inVehicle)
                        this.nearestPoliceDist = Math.min(this.nearestPoliceDist, Math.hypot(npc.x - ctx.player.x, npc.y - ctx.player.y));
                }
            }
        this.sirenTimer -= dt;
        if (this.sirenTimer > 0)
            return;
        this.sirenTimer = 0.3;
        const volume = Math.max(0, Math.min(0.65, 0.7 * (1 - this.nearestPoliceDist / 28)));
        SoundManager_1.sound.setLoop('siren', volume > 0 && this.active ? 'siren' : null, volume);
    }
    slide(v, ctx, vx, vy, dt) {
        const steps = Math.max(1, Math.ceil(Math.hypot(vx, vy) * dt / 0.15));
        const radius = Math.min(v.def.footprintW, v.def.footprintH) / 2;
        for (let i = 0; i < steps; i++) {
            const prevX = v.x, prevY = v.y;
            const circle = { x: v.x + vx * dt / steps, y: v.y + vy * dt / steps, radius };
            ctx.collision.resolveCircle(circle, ctx.map.queryNearby(circle.x, circle.y, 2));
            ctx.collision.resolveCircleVsVehicles(circle, ctx.vehicles, v.id);
            // A viatura em patrulha respeita o mesmo talude que barra o jogador: morro não é atalho.
            TerrainSystem_1.terrain.blockDrive(ctx.map, circle, prevX, prevY);
            if (ctx.map.isInside(circle.x, circle.y, radius) && !ctx.map.isWaterWorld(circle.x, circle.y)) {
                v.x = circle.x;
                v.y = circle.y;
            }
        }
    }
}
exports.PoliceSystem = PoliceSystem;
