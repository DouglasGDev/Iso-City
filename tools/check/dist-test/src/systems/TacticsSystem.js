"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TacticsSystem = void 0;
const CollisionSystem_1 = require("./CollisionSystem");
const CoverSystem_1 = require("./CoverSystem");
/** Faixa de engajamento como múltiplos do standoff: abaixo o agente reabre espaço, acima ele fecha. */
const BAND_MIN = 0.62;
const BAND_MAX = 1.45;
const ORBIT_RATE = 0.24;
const ORBIT_FLIP_S = [1.3, 2.6];
const SPACING = 1.15;
const COVER_ENTER = 0.42;
const COVER_EXIT = 0.16;
const COVER_SCAN_S = 0.45;
const COVER_REACH = 3.6;
const COVER_HOLD_S = 2.6;
const AIM_TOLERANCE = 0.1;
const wrap = (angle) => Math.atan2(Math.sin(angle), Math.cos(angle));
/**
 * Doutrina de combate de um esquadrão a pé: manter distância de tiro, girar em torno do alvo,
 * espaçar os integrantes e deitar atrás de capa durante a recarga. Só devolve ordens locais;
 * quem comanda continua decidido rota, percepção e dano.
 */
class TacticsSystem {
    constructor() {
        this.stances = new Map();
    }
    forget(id) { this.stances.delete(id); }
    reset() { this.stances.clear(); }
    /** Registra um disparo: a partir daí o agente passa a se reposicionar entre tiros. */
    noteShot(id) {
        const stance = this.stances.get(id);
        if (stance)
            stance.shots++;
    }
    order(dt, agent, target, ctx, options) {
        const stance = this.stanceFor(agent, ctx);
        const dx = agent.x - target.x, dy = agent.y - target.y;
        const distance = Math.hypot(dx, dy) || 1e-6;
        const bearing = Math.atan2(dy, dx);
        stance.bearing = bearing;
        // Agachado na capa: o cooldown comanda a saída, não a linha de visão (senão ele nunca levanta).
        if (stance.cover) {
            stance.hunkerTimer += dt;
            const runn = Math.hypot(stance.cover.x - target.x, stance.cover.y - target.y) > distance + 5;
            if (agent.cooldown > COVER_EXIT && stance.hunkerTimer < COVER_HOLD_S && !runn) {
                return { anchor: { x: stance.cover.x, y: stance.cover.y }, intent: 'cover', engaged: true,
                    fire: false, aimAngle: agent.aimAngle, distance };
            }
            stance.cover = null;
        }
        if (!target.visible) {
            return { anchor: { x: target.x, y: target.y }, intent: 'advance', engaged: false,
                fire: false, aimAngle: agent.aimAngle, distance };
        }
        const aimAngle = this.aim(agent, target, options.turnRate * dt);
        const settled = Math.abs(wrap(aimAngle - Math.atan2(-dy, -dx))) < AIM_TOLERANCE;
        if (!agent.armed)
            return this.unarmedOrder(stance, agent, target, ctx, options, distance, aimAngle);
        if (agent.cooldown > COVER_ENTER) {
            const cover = this.coverPoint(stance, dt, agent, target, ctx, distance);
            if (cover) {
                stance.cover = cover;
                stance.hunkerTimer = 0;
                return { anchor: { ...cover }, intent: 'cover', engaged: true, fire: false, aimAngle, distance };
            }
        }
        const min = options.standoff * BAND_MIN, max = options.standoff * BAND_MAX;
        const holding = distance >= min && distance <= max;
        const radius = holding ? distance : options.standoff;
        const arc = holding && stance.shots > 0 ? this.orbit(stance, ctx, dt) : bearing;
        const anchor = this.place({ x: target.x + Math.cos(arc) * radius, y: target.y + Math.sin(arc) * radius }, agent, options.allies, ctx);
        return { anchor, intent: holding && stance.shots > 0 ? 'strafe' : 'standoff', engaged: true,
            fire: settled && distance <= options.fireRange, aimAngle, distance };
    }
    unarmedOrder(stance, agent, target, ctx, options, distance, aimAngle) {
        // Sem arma o policial só serve para algemar: estica o braço até o alcance da prisão. Se um
        // colega já está na vez dele, ele para no anel externo — senão ficaria entrando e saindo.
        const outer = target.contactRange * 2.4;
        const rival = distance <= outer && options.allies.some((ally) => Math.hypot(ally.x - target.x, ally.y - target.y) < distance);
        const ring = rival ? outer : target.contactRange * 0.6;
        const anchor = this.place({ x: target.x + Math.cos(stance.bearing) * ring,
            y: target.y + Math.sin(stance.bearing) * ring }, agent, options.allies, ctx);
        return { anchor, intent: rival ? 'standoff' : 'press', engaged: true, fire: false, aimAngle, distance };
    }
    stanceFor(agent, ctx) {
        let stance = this.stances.get(agent.id);
        if (!stance) {
            stance = { bearing: 0, orbit: ctx.rng() < 0.5 ? -1 : 1, orbitTimer: 0.6 + ctx.rng(),
                cover: null, hunkerTimer: 0, scanTimer: 0, shots: 0 };
            this.stances.set(agent.id, stance);
        }
        return stance;
    }
    /** A mira gira até o alvo em vez de teletransportar: o policial vira o cano visivelmente. */
    aim(agent, target, step) {
        const want = Math.atan2(target.y - agent.y, target.x - agent.x);
        const delta = wrap(want - agent.aimAngle);
        return Math.abs(delta) <= step ? want : agent.aimAngle + Math.sign(delta) * step;
    }
    /** Deriva lateral em torno do alvo, trocando de lado em intervalos irregulares. */
    orbit(stance, ctx, dt) {
        stance.orbitTimer -= dt;
        if (stance.orbitTimer <= 0) {
            stance.orbit = -stance.orbit;
            stance.orbitTimer = ORBIT_FLIP_S[0] + ctx.rng() * (ORBIT_FLIP_S[1] - ORBIT_FLIP_S[0]);
        }
        return stance.bearing + stance.orbit * ORBIT_RATE * dt;
    }
    /** Empurra o agente para longe de aliados grudados e recua o ponto até terreno pisável. */
    place(anchor, agent, allies, ctx) {
        let x = anchor.x, y = anchor.y;
        for (const ally of allies) {
            const ax = agent.x - ally.x, ay = agent.y - ally.y, d = Math.hypot(ax, ay);
            if (d >= SPACING)
                continue;
            const nx = d < 1e-4 ? Math.cos(agent.id) : ax / d, ny = d < 1e-4 ? Math.sin(agent.id) : ay / d;
            x += nx * (SPACING - d);
            y += ny * (SPACING - d);
        }
        const point = { x, y };
        if (this.standable(point, agent, ctx))
            return point;
        for (const scale of [0.7, 0.45, 0.25]) {
            const shorter = { x: agent.x + (x - agent.x) * scale, y: agent.y + (y - agent.y) * scale };
            if (this.standable(shorter, agent, ctx))
                return shorter;
        }
        return { x: agent.x, y: agent.y };
    }
    standable(point, agent, ctx) {
        const circle = { ...point, radius: agent.radius };
        return ctx.map.isInside(point.x, point.y, agent.radius) && !ctx.map.isWaterWorld(point.x, point.y) &&
            !ctx.collision.overlapsAny(circle, ctx.map.queryNearby(point.x, point.y, agent.radius + 1));
    }
    /** Só há capa se a bala do alvo esbarra no obstáculo antes do policial; senão é só esconderijo falso. */
    coverPoint(stance, dt, agent, target, ctx, distance) {
        stance.scanTimer -= dt;
        if (stance.scanTimer > 0)
            return null;
        stance.scanTimer = COVER_SCAN_S;
        let best = null, bestCost = Infinity;
        const boxes = [...ctx.map.queryNearby(agent.x, agent.y, COVER_REACH), ...ctx.vehicles.map(CollisionSystem_1.vehicleGroundCollider)];
        for (const box of boxes) {
            const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
            const lean = Math.hypot(cx - target.x, cy - target.y);
            if (lean < 1e-4 || lean > distance + 2)
                continue;
            const reach = Math.max(box.width, box.height) / 2 + agent.radius + 0.4;
            const point = { x: cx + (cx - target.x) / lean * reach, y: cy + (cy - target.y) / lean * reach };
            const travel = Math.hypot(point.x - agent.x, point.y - agent.y);
            if (travel > COVER_REACH || travel >= bestCost)
                continue;
            if (!this.standable(point, agent, ctx) || this.shielded(point, target, ctx) === null)
                continue;
            best = point;
            bestCost = travel;
            if (travel < 1.2)
                break;
        }
        return best;
    }
    shielded(point, target, ctx) {
        // Agachado durante a recarga: a bala sai baixo, então cerca e carro baixo servem de capa.
        return CoverSystem_1.CoverSystem.firstHit({ ...point, z: 0.62 }, { x: target.x, y: target.y, z: 1.2 }, { map: ctx.map, vehicles: ctx.vehicles }) !== null;
    }
}
exports.TacticsSystem = TacticsSystem;
