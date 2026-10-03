"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TrafficSystem = void 0;
const GameConfig_1 = require("../game/GameConfig");
const Vehicle_1 = require("../entities/Vehicle");
const vehicles_1 = require("../data/vehicles");
const IsoUtils_1 = require("../world/IsoUtils");
const TerrainSystem_1 = require("./TerrainSystem");
const SoundManager_1 = require("../audio/SoundManager");
const TrafficSignalSystem_1 = require("./TrafficSignalSystem");
const NPCSystem_1 = require("./NPCSystem");
const WorldStreamingManager_1 = require("../world/streaming/WorldStreamingManager");
const ROAD_SPEED = 2.15;
const HEADWAY_S = 0.85;
/** Abaixo disso o carro está de fato parado; uma fila engatinhando não conta como saída bloqueada. */
const STOPPED_SPEED = 0.2;
/** Folga do plano do nó: o carro anda 0,125 tile por frame, então não dá para exigir precisão menor. */
const NODE_REACH = 0.12;
/** Quanto tempo um motorista espera a vez num entroncamento sem sinal antes de entrar anyway. */
const YIELD_PATIENCE = 8;
/** Larger than every look-ahead below (9.1 tiles), so a 3x3 cell scan is exact. */
const GRID_CELL = 12;
const radiusOf = (v) => Math.max(GameConfig_1.GAME_CONFIG.VEHICLE_RADIUS, Math.min(v.def.footprintW, v.def.footprintH) * 0.34);
const cellOf = (n) => Math.floor(n / GRID_CELL);
const cellKey = (cx, cy) => (cx + 2048) * 8192 + (cy + 2048);
class TrafficSystem {
    /** Renderer data; advanced once per traffic update, never by the renderer/NPCs. */
    get signals() { return this.signalSystem.signals; }
    constructor(collision, seed = 98765) {
        this.collision = collision;
        this.traffic = [];
        this.signalSystem = new TrafficSignalSystem_1.TrafficSignalSystem();
        this.vehicleGrid = new Map();
        this.npcGrid = new Map();
        /** Carimbo do tick: é o relógio que escalona o anel distante do trânsito. */
        this.frame = 0;
        this.rng = this.mulberry32(seed);
    }
    static rebuild(grid, items, x, y, 
    /** Pula o item na hora do empurrão: quem chama não precisa criar array filtrado antes. */
    skip) {
        for (const bucket of grid.values())
            bucket.length = 0;
        for (const item of items) {
            if (skip?.(item))
                continue;
            const key = cellKey(cellOf(x(item)), cellOf(y(item)));
            const bucket = grid.get(key);
            if (bucket)
                bucket.push(item);
            else
                grid.set(key, [item]);
        }
    }
    /** Visits every item within GRID_CELL of (x, y); `found` stops the scan early. */
    static near(grid, x, y, found) {
        const cx = cellOf(x), cy = cellOf(y);
        for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
                const bucket = grid.get(cellKey(cx + dx, cy + dy));
                if (!bucket)
                    continue;
                for (let i = 0; i < bucket.length; i++)
                    if (found(bucket[i]))
                        return true;
            }
        }
        return false;
    }
    mulberry32(a) {
        return () => {
            a |= 0;
            a = (a + 0x6d2b79f5) | 0;
            let t = Math.imul(a ^ (a >>> 15), 1 | a);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }
    init(map, vehicles, npcs, allocVehicleId) {
        this.traffic = [];
        this.signalSystem.init(map);
        let spawned = 0;
        for (const v of vehicles) {
            if (spawned >= GameConfig_1.GAME_CONFIG.TRAFFIC_MAX)
                break;
            if (this.tryActivateVehicle(map, v, npcs))
                spawned++;
        }
        let nextId = 0;
        for (const v of vehicles)
            if (v.id >= nextId)
                nextId = v.id + 1;
        this.spawnExtraTraffic(map, vehicles, npcs, allocVehicleId ?? (() => nextId++));
    }
    tryActivateVehicle(map, v, npcs) {
        if (v.state !== 'parked' || !v.def.driveable || v.occupied || v.health <= 0)
            return false;
        if (v.def.type === 'helicopter' || v.def.type === 'police' || v.def.type === 'swat')
            return false;
        if (map.tileKindAt(v.x, v.y) !== 'road' || this.rng() > GameConfig_1.GAME_CONFIG.TRAFFIC_SPAWN_CHANCE)
            return false;
        const route = this.generateRoute(map, v.x, v.y);
        if (route.length < 2)
            return false;
        // Carro de trânsito é carro dirigido: sem pedestre no banco não há trânsito, e roubar
        // um veículo vazio não expulsa ninguém. Sem NPC livre na cidade o lote fica estacionado.
        const driver = npcs.find((n) => n.kind === 'civ' && !n.dead && !n.inVehicle && n.state !== 'knocked') ?? null;
        if (!driver)
            return false;
        driver.inVehicle = true;
        driver.vehicleId = v.id;
        driver.state = 'idle';
        v.occupied = true;
        v.state = 'driving';
        this.traffic.push({ vehicle: v, driver, route, routeIndex: 0, state: 'driving',
            targetSpeed: ROAD_SPEED * (0.85 + this.rng() * 0.35), stuckTimer: 0, hornCooldown: 0,
            yieldWait: 0, yieldPass: false });
        return true;
    }
    spawnExtraTraffic(map, vehicles, npcs, allocVehicleId) {
        if (map.roadNodes.length < 4)
            return;
        let attempts = 0;
        while (this.traffic.length < GameConfig_1.GAME_CONFIG.TRAFFIC_MAX && attempts++ < 400) {
            const idx = map.randomRoadNodeIndex(this.rng);
            const node = map.roadNodes[idx];
            const tile = map.roadNodeTiles[idx];
            if (map.data.tiles[tile.ty * map.data.tilesW + tile.tx].bridge)
                continue;
            if (vehicles.some((v) => Math.hypot(v.x - node.x, v.y - node.y) < 2.2))
                continue;
            const def = vehicles_1.VEHICLE_DEFS[vehicles_1.CIVILIAN_VEHICLES[Math.floor(this.rng() * vehicles_1.CIVILIAN_VEHICLES.length)]];
            if (!def?.driveable)
                continue;
            const lane = map.laneAt(node.x, node.y);
            let dir = lane ?? 'SE';
            if (!lane) {
                const horizontal = map.tileKindAt(node.x - 1, node.y) === 'road' && map.tileKindAt(node.x + 1, node.y) === 'road';
                dir = horizontal ? (tile.ty % 2 === 0 ? 'SE' : 'NW') : (tile.tx % 2 === 0 ? 'SW' : 'NE');
            }
            const color = def.colors.length ? def.colors[Math.floor(this.rng() * def.colors.length)] : '';
            const v = (0, Vehicle_1.createVehicle)(allocVehicleId(), def, color, node.x, node.y, dir);
            if (this.tryActivateVehicle(map, v, npcs))
                vehicles.push(v);
        }
    }
    generateRoute(map, startX, startY) {
        if (map.roadNodes.length < 4)
            return [];
        for (let attempt = 0; attempt < 10; attempt++) {
            const goal = map.roadNodes[map.randomRoadNodeIndex(this.rng)];
            const directed = this.outsideJunction(map.findRoadPath(startX, startY, goal.x, goal.y));
            if (directed.length >= 4)
                return directed;
        }
        // Only use an undirected route if every edge still respects existing lane directions.
        for (let attempt = 0; attempt < 8; attempt++) {
            const goal = map.roadNodes[map.randomRoadNodeIndex(this.rng)];
            const route = this.outsideJunction(map.findUndirectedRoadPath(startX, startY, goal.x, goal.y));
            if (route.length >= 4 && route.every((p, i) => {
                if (!i)
                    return true;
                const prev = route[i - 1];
                const dir = Math.abs(p.x - prev.x) >= Math.abs(p.y - prev.y) ? (p.x > prev.x ? 'SE' : 'NW') : (p.y > prev.y ? 'SW' : 'NE');
                return (!map.laneAt(prev.x, prev.y) || map.laneAt(prev.x, prev.y) === dir) &&
                    (!map.laneAt(p.x, p.y) || map.laneAt(p.x, p.y) === dir);
            }))
                return route;
        }
        return [];
    }
    /**
     * Um destino dentro da caixa do cruzamento é um carro que vai sentar ali no meio e não sair
     * mais: ele não alcança o último nó (está bloqueado por quem cruza) e, parado dentro da caixa,
     * é exatamente a peça que faltava para o anel de conversões travar. A rota termina antes.
     */
    outsideJunction(route) {
        let end = route.length;
        while (end > 1 && this.signalSystem.at(route[end - 1].x, route[end - 1].y))
            end--;
        return end === route.length ? route : route.slice(0, end);
    }
    refreshRoute(tv, map) {
        const route = this.generateRoute(map, tv.vehicle.x, tv.vehicle.y);
        if (route.length >= 2) {
            tv.route = route;
            tv.routeIndex = 0;
            tv.stuckTimer = 0;
            tv.state = 'driving';
        }
        else
            tv.vehicle.speed = 0;
    }
    /** Rebuilds the proximity indexes once per frame; every look-ahead is shorter than GRID_CELL. */
    syncGrids(vehicles, npcs) {
        TrafficSystem.rebuild(this.vehicleGrid, vehicles, (v) => v.x, (v) => v.y);
        // O filtro de quem está a pé vivia num `npcs.filter` que criava um array de 400 posições
        // a cada tick. Agora o `rebuild` pula o item na hora do empurrão: mesma grade, zero lixo.
        TrafficSystem.rebuild(this.npcGrid, npcs, (n) => n.x, (n) => n.y, (n) => n.dead || n.inVehicle);
    }
    update(map, npcs, vehicles, dt, player, 
    /** As zonas do mundo. Sem ela (testes, mapa pequeno) todo carro dirige como antes. */
    streaming) {
        if (!Number.isFinite(dt) || dt <= 0)
            return;
        this.syncGrids(vehicles, npcs);
        this.signalSystem.update(map, dt);
        this.frame++;
        // Compacta no lugar: `filter` devolvia um array novo de até 56 motoristas por tick, que é
        // exatamente o tipo de lixo que o coletor ia catar no meio do frame.
        let kept = 0;
        for (const tv of this.traffic) {
            if (tv.state === 'stolen' || tv.state === 'parked')
                continue;
            const v = tv.vehicle;
            if (v.state === 'destroyed' || v.health <= 0) {
                tv.state = 'parked';
                v.speed = 0;
                if (tv.driver) {
                    tv.driver.inVehicle = false;
                    tv.driver.vehicleId = null;
                    tv.driver = null;
                }
                continue;
            }
            if (player.currentVehicleId === v.id) {
                this.takeOver(v.id);
                continue;
            }
            // Quem está fora da área de streaming para de receber decisão, mas NÃO é estacionado nem
            // esvaziado: posição, rota, motorista e dano ficam exatamente onde estavam, para o carro
            // voltar a andar quando o jogador cruzar a zona de novo. O anel de pedestre congela na
            // mesma distância (ACTIVE_RADIUS), então quem dirige e quem anda continuam no mesmo mundo.
            const tier = streaming ? streaming.tierOf(v.x, v.y) : WorldStreamingManager_1.TIER.ACTIVE;
            // No anel distante o motorista continua dirigindo, só que a cada poucos frames: o passo é
            // o dt de sempre, então ele anda mais devagar em vez de saltar um tile inteiro por vez.
            // O `+ v.id` desencala a frota — um frame dado atualiza um quarto de cada carro, não um
            // quarto dos carros todos de uma vez.
            const dirige = tier === WorldStreamingManager_1.TIER.OUTSIDE ? false
                : tier === WorldStreamingManager_1.TIER.DISTANT
                    ? (this.frame + v.id) % GameConfig_1.GAME_CONFIG.VEHICLE_SIM_TICK_DIVISOR === 0 : true;
            if (dirige) {
                this.updateTrafficVehicle(tv, map, dt, player);
                if (tv.driver) {
                    tv.driver.x = v.x;
                    tv.driver.y = v.y;
                    tv.driver.lastX = v.x;
                    tv.driver.lastY = v.y;
                }
            }
            this.traffic[kept++] = tv;
        }
        this.traffic.length = kept;
    }
    signalStopDistance(tv, map) {
        const v = tv.vehicle;
        // A vehicle already committed must clear the box, even on yellow/all-red.
        if (this.signalSystem.at(v.x, v.y))
            return Infinity;
        const onCrosswalk = map.isCrosswalkAt(v.x, v.y);
        let distance = 0;
        let crosswalkDistance = Infinity;
        let from = v;
        for (let i = tv.routeIndex; i < tv.route.length && i < tv.routeIndex + 8; i++) {
            const point = tv.route[i];
            distance += Math.hypot(point.x - from.x, point.y - from.y);
            if (distance > 7)
                break;
            if (map.isCrosswalkAt(point.x, point.y))
                crosswalkDistance = Math.min(crosswalkDistance, distance);
            const s = this.signalSystem.at(point.x, point.y);
            if (s) {
                const horizontal = v.dir === 'SE' || v.dir === 'NW';
                const grid = this.vehicleGrid;
                this.signalSystem.request(s, v.dir);
                let crossing = false;
                if (TrafficSystem.near(grid, point.x, point.y, (other) => other !== v && other.state !== 'destroyed' && other.altitude <= 0.5 &&
                    this.signalSystem.at(other.x, other.y)?.id === s.id &&
                    horizontal !== (other.dir === 'SE' || other.dir === 'NW') &&
                    // A stopped turning car yielding to this approach must not also block its signal.
                    !(other.speed < 0.05 && this.vehicleAhead(other)?.vehicle === v)))
                    crossing = true;
                let exitIndex = i + 1;
                while (exitIndex < tv.route.length && this.signalSystem.at(tv.route[exitIndex].x, tv.route[exitIndex].y) === s)
                    exitIndex++;
                const exit = tv.route[exitIndex];
                const last = tv.route[exitIndex - 1];
                const minGap = Math.max(1.05, radiusOf(v) * 2 + 0.25);
                // Não entre na caixa se uma célula do seu próprio trajeto dentro dela já estiver ocupada
                // por um carro parado. É assim que o anel de quatro carros nasce — cada um quer a célula
                // do próximo — e, diferente de um congestionamento comum, ele nunca se desfaz sozinho.
                // Só vale carro de dentro da caixa: quem está na fila, parado antes da faixa, é o próprio
                // approach e já é tratado pelo espaço entre veículos. A exceção de quem apenas dá
                // passagem repete a regra de cruzamento acima, senão os dois se esperam do lado de fora.
                let cellHeld = false;
                for (let j = i; j < exitIndex && !cellHeld; j++) {
                    const node = tv.route[j];
                    cellHeld = TrafficSystem.near(grid, node.x, node.y, (other) => other !== v
                        && other.state !== 'destroyed' && other.def.driveable && other.altitude <= 0.5
                        && other.speed <= STOPPED_SPEED
                        && this.signalSystem.at(other.x, other.y)?.id === s.id
                        && Math.hypot(other.x - node.x, other.y - node.y) < minGap
                        && !(other.speed < 0.05 && this.vehicleAhead(other)?.vehicle === v));
                }
                // Check the outgoing lane, including turns; the moving approach queue is not a blocked exit.
                let spillsOver = false;
                if (exit) {
                    const length = Math.hypot(exit.x - last.x, exit.y - last.y);
                    const ux = (exit.x - last.x) / length, uy = (exit.y - last.y) / length;
                    if (TrafficSystem.near(grid, exit.x, exit.y, (other) => {
                        if (other === v || other.state === 'destroyed' || !other.def.driveable || other.altitude > 0.5
                            || other.speed > STOPPED_SPEED)
                            return false;
                        const dx = other.x - exit.x, dy = other.y - exit.y;
                        const forward = dx * ux + dy * uy;
                        const gap = Math.max(1.05, radiusOf(v) + radiusOf(other) + 0.25);
                        return forward > -0.5 && forward < gap && Math.abs(dx * uy - dy * ux) < 0.7;
                    }))
                        spillsOver = true;
                }
                if ((!this.signalSystem.allows(s, v.dir) && !onCrosswalk) || crossing || spillsOver || cellHeld
                    // Cruzamento sem sinal não tem luz nenhuma para esperar: a via secundária cede
                    // a vez para a preferencial, do jeito que se faz em entroncamento de estrada.
                    || (!tv.yieldPass && this.signalSystem.mustYield(s, v.dir) && this.priorityRunning(s, grid, v))) {
                    // Stop before the pedestrian stripe, not on top of it. A car that has
                    // already entered the stripe clears it rather than trapping pedestrians.
                    const lineDistance = onCrosswalk ? distance : Math.min(distance, crosswalkDistance);
                    return Math.max(0, lineDistance - 0.5 - radiusOf(v) - 0.15);
                }
                return Infinity;
            }
            from = point;
        }
        return Infinity;
    }
    /** Tem carro da via preferencial entrando no cruzamento ou chegando nele agora? */
    priorityRunning(s, grid, v) {
        const xPriority = s.yields === 'y';
        return TrafficSystem.near(grid, s.x, s.y, (other) => other !== v && other.state !== 'destroyed'
            && other.def.driveable && other.altitude <= 0.5 && other.speed > STOPPED_SPEED
            && (other.dir === 'SE' || other.dir === 'NW') === xPriority
            && Math.hypot(other.x - s.x, other.y - s.y) < 4.5);
    }
    /**
     * Quem cede a vez não pode esperar para sempre: um motorista parado no entroncamento
     * sem sinal espera ~8s e então entra, como qualquer motorista faz na vida real. Quem
     * está na caixa já está a salvo do próprio check de aproximação.
     */
    yieldPatience(tv, v, dt, moved) {
        if (moved >= 0.02) {
            tv.yieldWait = 0;
            tv.yieldPass = false;
            return;
        }
        const s = this.signalSystem.near(v.x, v.y);
        if (!s || !this.signalSystem.mustYield(s, v.dir)) {
            tv.yieldWait = 0;
            return;
        }
        tv.yieldWait += dt;
        if (tv.yieldWait > YIELD_PATIENCE)
            tv.yieldPass = true;
    }
    pedestrianStopDistance(v, map, player) {
        const axis = IsoUtils_1.DIR_VECTORS[v.dir];
        let stop = Infinity;
        const farReach = GameConfig_1.GAME_CONFIG.NPC_SIM_FAR;
        TrafficSystem.near(this.npcGrid, v.x, v.y, (n) => {
            // Match the existing NPC culling contract: frozen offscreen actors cannot hold queues forever.
            const pdx = n.x - player.x, pdy = n.y - player.y;
            if (n.kind !== 'cop' && n.state !== 'fleeing' && pdx * pdx + pdy * pdy > farReach * farReach)
                return false;
            const dx = n.x - v.x, dy = n.y - v.y;
            let fwd = axis.wx * dx + axis.wy * dy;
            let side = Math.abs(axis.wy * dx - axis.wx * dy);
            const intent = (0, NPCSystem_1.pedestrianCrossingIntent)(n);
            if (intent?.requested && n.state === 'walking') {
                // Waiting at the curb requests a gap at the segment/lane intersection.
                const ax = intent.to.x - intent.from.x, ay = intent.to.y - intent.from.y;
                const denom = axis.wy * ax - axis.wx * ay;
                if (Math.abs(denom) > 0.01) {
                    const t = -(axis.wy * (intent.from.x - v.x) - axis.wx * (intent.from.y - v.y)) / denom;
                    if (t >= 0 && t <= 1) {
                        fwd = axis.wx * (intent.from.x + ax * t - v.x) + axis.wy * (intent.from.y + ay * t - v.y);
                        side = 0;
                    }
                }
            }
            if (fwd <= 0 || fwd >= 6 || side >= 0.7)
                return false;
            if (map.tileKindAt(n.x, n.y) !== 'road' && !intent?.requested)
                return false;
            stop = Math.min(stop, Math.max(0, fwd - radiusOf(v) - 0.65));
            return false;
        });
        return stop;
    }
    vehicleAhead(v) {
        const axis = IsoUtils_1.DIR_VECTORS[v.dir];
        let closest = null;
        TrafficSystem.near(this.vehicleGrid, v.x, v.y, (other) => {
            if (other === v || other.state === 'destroyed' || !other.def.driveable || other.altitude > 0.5)
                return false;
            const dx = other.x - v.x, dy = other.y - v.y;
            const fwd = axis.wx * dx + axis.wy * dy;
            const side = Math.abs(axis.wy * dx - axis.wx * dy);
            // Lane separation matters: opposite/adjacent lanes must not cause phantom queues.
            if (fwd > 0 && fwd < 9 && side < 0.7 && (!closest || fwd < closest.distance))
                closest = { vehicle: other, distance: fwd };
            return false;
        });
        return closest;
    }
    /**
     * Eixo por onde o carro deve andar para alcançar o próximo nó: o trecho da rota, nunca a
     * sobra até ele. Um deslocamento de 0,1 tile causado pela resolução de colisão bastaria para
     * o carro virar para o eixo perpendicular e parar de frente para o fluxo que ele próprio
     * bloqueia; medir o avanço pela distância até o centro do nó, por outro lado, faria um carro
     * empurrado 0,3 tile para o lado nunca "chegar" a lugar nenhum, pois o trânsito só anda em
     * eixo e nunca corrige a lateralidade sozinho.
     */
    static routeHeading(tv) {
        const node = tv.route[tv.routeIndex];
        if (!node)
            return null;
        const previous = tv.routeIndex > 0 ? tv.route[tv.routeIndex - 1] : null;
        let sx = previous ? node.x - previous.x : 0, sy = previous ? node.y - previous.y : 0;
        if (!sx && !sy) {
            const next = tv.route[tv.routeIndex + 1];
            if (!next)
                return null;
            sx = next.x - node.x;
            sy = next.y - node.y;
        }
        const len = Math.hypot(sx, sy);
        return len ? { ux: sx / len, uy: sy / len } : null;
    }
    /** O carro já cruzou o plano deste nó no eixo da rota? */
    static nodeBehind(tv, v) {
        const node = tv.route[tv.routeIndex];
        const heading = TrafficSystem.routeHeading(tv);
        return !!node && !!heading
            && (node.x - v.x) * heading.ux + (node.y - v.y) * heading.uy <= NODE_REACH;
    }
    updateTrafficVehicle(tv, map, dt, player) {
        const v = tv.vehicle;
        tv.hornCooldown = Math.max(0, tv.hornCooldown - dt);
        while (tv.routeIndex < tv.route.length && TrafficSystem.nodeBehind(tv, v))
            tv.routeIndex++;
        if (tv.routeIndex >= tv.route.length) {
            this.refreshRoute(tv, map);
            return;
        }
        const target = tv.route[tv.routeIndex];
        const dx = target.x - v.x, dy = target.y - v.y;
        const dist = Math.hypot(dx, dy);
        const heading = TrafficSystem.routeHeading(tv);
        if (!heading) {
            this.refreshRoute(tv, map);
            return;
        }
        const toWaypoint = Math.abs(heading.ux) >= Math.abs(heading.uy)
            ? (heading.ux >= 0 ? 'SE' : 'NW') : (heading.uy >= 0 ? 'SW' : 'NE');
        const lane = map.laneAt(v.x, v.y);
        if (lane && (0, IsoUtils_1.dirToAngle)(lane) !== (0, IsoUtils_1.dirToAngle)(toWaypoint) && dist > 0.65) {
            v.speed = 0;
            tv.stuckTimer += dt;
            if (tv.stuckTimer > 0.5)
                this.refreshRoute(tv, map);
            return;
        }
        v.dir = toWaypoint;
        v.facingAngle = (0, IsoUtils_1.dirToAngle)(v.dir);
        const axis = IsoUtils_1.DIR_VECTORS[v.dir];
        const pedStop = this.pedestrianStopDistance(v, map, player);
        let stop = Math.min(pedStop, this.signalStopDistance(tv, map));
        let desired = tv.targetSpeed;
        const ahead = this.vehicleAhead(v);
        if (ahead) {
            const gap = Math.max(1.05, radiusOf(v) + radiusOf(ahead.vehicle) + 0.25);
            const available = Math.max(0, ahead.distance - gap);
            stop = Math.min(stop, available);
            const forwardSpeed = Math.max(0, Math.cos(ahead.vehicle.facingAngle - v.facingAngle) * ahead.vehicle.speed);
            desired = Math.min(desired, forwardSpeed + Math.max(0, available - v.speed * HEADWAY_S) / HEADWAY_S);
        }
        if (Number.isFinite(stop))
            desired = Math.min(desired, Math.sqrt(2 * GameConfig_1.GAME_CONFIG.VEHICLE_BRAKE * Math.max(0, stop - 0.05)));
        if (map.isIntersectionAt(v.x, v.y))
            desired = Math.min(desired, ROAD_SPEED * 0.7);
        const diff = desired - v.speed;
        v.speed = Math.max(0, v.speed + Math.sign(diff) * Math.min(Math.abs(diff), (diff > 0 ? GameConfig_1.GAME_CONFIG.VEHICLE_ACCEL : GameConfig_1.GAME_CONFIG.VEHICLE_BRAKE) * dt));
        // Hard geometric travel cap prevents tunneling into stop lines/headway on a long frame.
        const travel = Math.min(v.speed * dt, dist, stop);
        v.speed = Math.min(v.speed, travel / dt);
        tv.state = v.speed < 0.05 && Number.isFinite(stop) ? 'waiting' : 'driving';
        this.maybeHonk(tv, player, pedStop, ahead);
        const ox = v.x, oy = v.y;
        this.slideMove(v, map, axis.wx * travel, axis.wy * travel, radiusOf(v));
        if (map.isWaterWorld(v.x, v.y)) {
            v.x = ox;
            v.y = oy;
            v.speed = 0;
        }
        const moved = Math.hypot(v.x - ox, v.y - oy);
        this.yieldPatience(tv, v, dt, moved);
        // Deliberate signal/pedestrian/headway waits never trigger random reroutes.
        if (moved < 0.01 && travel > 0.02 && !Number.isFinite(stop)) {
            tv.stuckTimer += dt;
            if (tv.stuckTimer > 1.2)
                this.refreshRoute(tv, map);
        }
        else
            tv.stuckTimer = 0;
    }
    /** Audible only within earshot, and quieter the further the car is from the camera. */
    static hornVolume(distance) {
        return distance > 26 ? 0 : Math.max(0.12, 0.5 - distance * 0.015);
    }
    maybeHonk(tv, player, pedStop, ahead) {
        if (tv.hornCooldown > 0)
            return;
        const v = tv.vehicle;
        const impatient = pedStop < 2 && v.speed > 0.4;
        // Someone parked right in its lane: a driver with a passenger behind it honks.
        const blocked = !!ahead && ahead.vehicle.id === player.currentVehicleId
            && ahead.distance < 4 && Math.abs(ahead.vehicle.speed) < 0.6;
        if (!impatient && !blocked)
            return;
        const volume = TrafficSystem.hornVolume(Math.hypot(v.x - player.x, v.y - player.y));
        if (volume > 0)
            SoundManager_1.sound.play('carHorn', volume);
        tv.hornCooldown = 4 + volume * 4;
    }
    /** Motorista buzinando no carro do jogador: quem está preso na frente responde. */
    honk(player) {
        for (const tv of this.traffic) {
            if (tv.driver === null || tv.hornCooldown > 0)
                continue;
            if (tv.state !== 'waiting' && tv.stuckTimer < 0.4)
                continue;
            const distance = Math.hypot(tv.vehicle.x - player.x, tv.vehicle.y - player.y);
            const volume = distance < 1.5 ? 0 : TrafficSystem.hornVolume(distance);
            if (volume <= 0)
                continue;
            SoundManager_1.sound.play('carHorn', volume);
            tv.hornCooldown = 8;
            return;
        }
    }
    slideMove(v, map, stepX, stepY, radius) {
        for (const [dx, dy] of [[stepX, 0], [0, stepY]]) {
            if (!dx && !dy)
                continue;
            const prevX = v.x, prevY = v.y;
            const circle = { x: v.x + dx, y: v.y + dy, radius };
            this.collision.resolveCircle(circle, map.queryNearby(circle.x, circle.y, radius + 2));
            // O trânsito também enxerga o relevo: um talude no meio da pista barra o carro em
            // vez de atravessar a montanha como se o chão fosse plano.
            TerrainSystem_1.terrain.blockDrive(map, circle, prevX, prevY);
            v.x = circle.x;
            v.y = circle.y;
        }
    }
    tryStealCar(player, _vehicles, _npcs) {
        for (const tv of this.traffic) {
            if ((tv.state !== 'driving' && tv.state !== 'waiting') || !tv.driver)
                continue;
            if (Math.hypot(player.x - tv.vehicle.x, player.y - tv.vehicle.y) >= GameConfig_1.GAME_CONFIG.VEHICLE_ENTER_RANGE)
                continue;
            this.releaseDriver(tv);
            tv.state = 'stolen';
            tv.vehicle.occupied = true;
            tv.vehicle.state = 'driving';
            tv.vehicle.speed = 0;
            player.currentVehicleId = tv.vehicle.id;
            player.state = 'driving';
            player.x = tv.vehicle.x;
            player.y = tv.vehicle.y;
            player.vx = 0;
            player.vy = 0;
            player.facingAngle = tv.vehicle.facingAngle;
            return true;
        }
        return false;
    }
    releaseDriver(tv) {
        if (!tv.driver)
            return;
        const n = tv.driver, v = tv.vehicle;
        n.inVehicle = false;
        n.vehicleId = null;
        n.x = v.x + Math.cos(v.facingAngle + Math.PI / 2) * 1.2;
        n.y = v.y + Math.sin(v.facingAngle + Math.PI / 2) * 1.2;
        n.lastX = n.x;
        n.lastY = n.y;
        n.state = 'fleeing';
        n.fleeTimer = 3;
        tv.driver = null;
    }
    takeOver(vehicleId) {
        for (const tv of this.traffic) {
            if (tv.vehicle.id !== vehicleId)
                continue;
            tv.state = 'stolen';
            this.releaseDriver(tv);
        }
    }
}
exports.TrafficSystem = TrafficSystem;
