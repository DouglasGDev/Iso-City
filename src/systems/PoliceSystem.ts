import { GAME_CONFIG, type Dir4 } from '../game/GameConfig';
import type { Map } from '../world/Map';
import type { Player } from '../entities/Player';
import { createNPC, type NPC } from '../entities/NPC';
import { createVehicle, type Vehicle } from '../entities/Vehicle';
import { VEHICLE_DEFS } from '../data/vehicles';
import { dirToAngle, rotateAngleToward, velocityToDir } from '../world/IsoUtils';
import { sound } from '../audio/SoundManager';
import { vehicleGroundCollider, type CollisionSystem } from './CollisionSystem';
import type { HealthSystem } from './HealthSystem';
import type { WantedSystem } from './WantedSystem';
import { segmentAabb, segmentCircle, type WeaponTracer } from './WeaponSystem';
import { CoverSystem } from './CoverSystem';
import { canSee, facingAngle, fovHalf, sightRange, type Viewer, type VisionConfig } from './VisionSystem';
import { createMemory, observe, type DetectionMemory, type Response } from './DetectionResponse';
import { TacticsSystem, type TacticalTarget } from './TacticsSystem';
import { AirSupportSystem } from './AirSupportSystem';

type Point = { x: number; y: number };
export interface PoliceSearchArea extends Point { radius: number; phase: 'pursuit' | 'search' }
/** Arco de um oficial: quem olha, de onde, para onde e até onde enxerga agora. */
export interface VisionCone extends Point { id: number; axis: number; half: number; radius: number; alert: number }
interface Navigation {
  route: Point[];
  routeIndex: number;
  refreshTimer: number;
  goal: Point | null;
  sweep: number;
  wait: number;
}
interface PoliceUnit extends Navigation {
  vehicleId: number;
  crew: number[];
  home: Point;
  tier: number;
  mode: 'standby' | 'patrol' | 'respond' | 'deployed' | 'return';
  stuckTimer: number;
  ramCooldown: number;
}
interface PoliceCop extends Navigation {
  npcId: number;
  vehicleId: number;
  shotCooldown: number;
  aimAngle: number;
  fireFlash: number;
  armed: boolean;
  /** O que o oficial viu recentemente: abre o cone e segura a guarda depois. */
  detection: DetectionMemory;
  response: Response;
}
export interface PoliceContext {
  map: Map;
  player: Player;
  vehicles: Vehicle[];
  npcs: NPC[];
  collision: CollisionSystem;
  health: HealthSystem;
  wanted: WantedSystem;
  time: number;
  concealed?: boolean;
  /** Noite fecha o cone: os faróis veem, mas o resto escurece o alcance. */
  night?: boolean;
  allocVehicleId: () => number;
  allocNpcId: () => number;
  onStructChange: () => void;
  onBusted: () => void;
  shake: (amount: number) => void;
  rng: () => number;
}
const nav = (): Navigation => ({ route: [], routeIndex: 0, refreshTimer: 0, goal: null, sweep: 0, wait: 0 });
const SEARCH_MIN = 4;
const SEARCH_MAX = 18;
const FLEET_TIERS = [1, 1, 1, 2, 3, 4, 5, 5];
/** Distância de tiro desejada e alcance útil por estrela: SWAT e federal atiram mais longe e abrem mais. */
const COP_STANDOFF = [0, 0, 5.2, 5.8, 6.6, 7] as const;
const COP_FIRE_RANGE = [0, 0, 11, 11, 12.5, 14] as const;
const COP_AIM_TURN = 6.5;
/** Marca de uma unidade sem viatura: a equipe que desceu de corda do helicóptero. */
const AIRBORNE_UNIT = -1;

export class PoliceSystem {
  readonly units: PoliceUnit[] = [];
  readonly cops: PoliceCop[] = [];
  tracers: WeaponTracer[] = [];
  nearestPoliceDist = Infinity;
  searchArea: PoliceSearchArea | null = null;
  playerVisible = false;
  private initialized = false;
  private dispatchTimer = 0;
  private sirenTimer = 0;
  private unseenTimer = 0;
  private nextTracerId = 1000000;
  private lastContext: PoliceContext | null = null;
  private readonly tactics = new TacticsSystem();
  readonly air = new AirSupportSystem();

  get active() { return this.searchArea !== null && this.units.some((u) => u.mode === 'respond' || u.mode === 'deployed'); }

  init(ctx: PoliceContext): void {
    if (this.initialized) return;
    this.initialized = true;
    this.lastContext = ctx;
    const spawn = ctx.map.data.playerSpawn;
    const stations = ctx.map.landmarksOf('police').slice().sort((a, b) =>
      Math.hypot(a.x - spawn.x, a.y - spawn.y) - Math.hypot(b.x - spawn.x, b.y - spawn.y));
    if (!stations.length) return;
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
      if (!spot) continue;
      const tier = FLEET_TIERS[slot];
      const def = VEHICLE_DEFS[tier >= 3 ? 'swat' : slot % 2 === 0 ? 'police_compact' : 'police'];
      const vehicle = createVehicle(ctx.allocVehicleId(), def, '', spot.x, spot.y, spot.lane ?? 'SE');
      vehicle.health = tier >= 3 ? 220 : 120;
      vehicle.occupied = true;
      const unit: PoliceUnit = { ...nav(), vehicleId: vehicle.id, home: { ...spot }, crew: [], tier,
        mode: slot < 3 ? 'patrol' : 'standby', stuckTimer: 0, ramCooldown: 0 };
      vehicle.state = unit.mode === 'patrol' ? 'driving' : 'parked';
      ctx.vehicles.push(vehicle);
      this.units.push(unit);
      for (let seat = 0; seat < (tier >= 3 ? 3 : 2); seat++) {
        const npc = createNPC(ctx.allocNpcId(), 'a', spot.x, spot.y, 'cop', ctx.rng);
        npc.inVehicle = true;
        npc.vehicleId = vehicle.id;
        npc.health = tier >= 3 ? 100 : 70;
        ctx.npcs.push(npc);
        unit.crew.push(npc.id);
        this.cops.push({ ...nav(), npcId: npc.id, vehicleId: vehicle.id,
          shotCooldown: 0.8 + seat * 0.3, aimAngle: 0, fireFlash: 0, armed: false,
          detection: createMemory(), response: 'ignore' });
      }
    }
    ctx.onStructChange();
  }

  report(point: Point): void {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
    this.searchArea = { x: point.x, y: point.y, radius: SEARCH_MIN, phase: 'search' };
    this.unseenTimer = 0;
    this.dispatchTimer = 0;
    for (const unit of this.units) if (unit.mode === 'respond' || unit.mode === 'deployed') Object.assign(unit, nav());
    for (const cop of this.cops) Object.assign(cop, nav());
  }

  reset(): void {
    this.searchArea = null;
    this.playerVisible = false;
    this.nearestPoliceDist = Infinity;
    this.unseenTimer = this.dispatchTimer = this.sirenTimer = 0;
    this.tracers.length = 0;
    for (const unit of this.units) {
      if (unit.mode !== 'standby') unit.mode = 'return';
      Object.assign(unit, nav());
    }
    for (const cop of this.cops) { cop.armed = false; cop.fireFlash = 0; Object.assign(cop, nav()); }
    this.tactics.reset();
    if (this.lastContext) {
      this.lastContext.player.arrestTimer = 0;
      // A caça acabou: recolhe o apoio aéreo e libera as equipes que desceram de corda.
      this.air.reset(this.airContext(this.lastContext));
      this.releaseAirborne(this.lastContext);
    }
    sound.setLoop('siren', null);
  }

  update(dt: number, ctx: PoliceContext): void {
    if (!Number.isFinite(dt) || dt <= 0) return;
    this.init(ctx);
    this.lastContext = ctx;
    for (const tracer of this.tracers) tracer.life -= dt;
    this.tracers = this.tracers.filter((t) => t.life > 0);
    const level = Math.min(5, Math.ceil(ctx.player.wantedLevel));
    // Sem delegacia não há frota, logo não há apoio aéreo. O voo usa o último ponto
    // conhecido; a varredura de solo só decide depois que o holofote localiza o alvo.
    if (this.units.length) this.air.update(dt, level, this.airContext(ctx));
    if (level <= 0) {
      if (this.searchArea) this.reset();
      this.playerVisible = false;
      this.releaseAirborne(ctx);
    } else this.perceive(dt, ctx);
    this.dispatchTimer -= dt;
    if (level > 0 && this.searchArea && this.dispatchTimer <= 0 && this.unseenTimer < 16) {
      const count = this.units.filter((u) => (u.mode === 'respond' || u.mode === 'deployed') && this.operational(u, ctx)).length;
      const target = GAME_CONFIG.POLICE_UNITS_BY_WANTED[level];
      if (count < target) {
        const choices = this.units.filter((u) => (u.mode === 'patrol' || u.mode === 'standby' || u.mode === 'return') &&
          u.tier <= level && this.operational(u, ctx));
        choices.sort((a, b) => {
          if (level >= 3 && a.tier !== b.tier) return b.tier - a.tier;
          const av = this.vehicle(ctx, a.vehicleId)!, bv = this.vehicle(ctx, b.vehicleId)!;
          return Math.hypot(av.x - this.searchArea!.x, av.y - this.searchArea!.y) - Math.hypot(bv.x - this.searchArea!.x, bv.y - this.searchArea!.y);
        });
        const unit = choices[0];
        if (unit) { unit.mode = 'respond'; Object.assign(unit, nav()); }
      }
      this.dispatchTimer = 2.5;
    }
    for (const unit of this.units) this.updateUnit(dt, unit, ctx, level);
    for (const cop of this.cops) this.updateCop(dt, cop, ctx, level);
    this.checkArrest(dt, ctx, level);
    this.sirens(dt, ctx);
  }

  private vehicle(ctx: PoliceContext, id: number) { return ctx.vehicles.find((v) => v.id === id); }
  private npc(ctx: PoliceContext, id: number) { return ctx.npcs.find((n) => n.id === id); }
  private operational(unit: PoliceUnit, ctx: PoliceContext): boolean {
    const vehicle = this.vehicle(ctx, unit.vehicleId);
    return !!vehicle && vehicle.health > 0 && vehicle.state !== 'destroyed' && ctx.player.currentVehicleId !== vehicle.id &&
      unit.crew.some((id) => { const n = this.npc(ctx, id); return n && !n.dead && n.health > 0; });
  }

  /** O helicóptero persegue o último ponto conhecido; a pé, a equipe descida de corda é dele. */
  private airContext(ctx: PoliceContext) {
    return {
      map: ctx.map, player: ctx.player, vehicles: ctx.vehicles, rng: ctx.rng,
      concealed: ctx.concealed, allocVehicleId: ctx.allocVehicleId, onStructChange: ctx.onStructChange,
      target: this.searchArea,
      deployOfficer: (x: number, y: number, tier: number) => this.deployOfficer(x, y, tier, ctx),
    };
  }

  /**
   * Policial de corda: a pé, sem viatura, preso a uma unidade aérea descartável. A ficha dele
   * sai do mundo quando a caça termina, então a população nunca cresce com o tempo.
   */
  private deployOfficer(x: number, y: number, tier: number, ctx: PoliceContext): boolean {
    const circle = { x, y, radius: GAME_CONFIG.NPC_RADIUS };
    if (!ctx.map.isInside(x, y, circle.radius) || ctx.map.isWaterWorld(x, y) ||
      ctx.collision.overlapsAny(circle, ctx.map.queryNearby(x, y, 1)) ||
      ctx.npcs.some((n) => !n.dead && !n.inVehicle && Math.hypot(n.x - x, n.y - y) < 0.5) ||
      ctx.vehicles.some((v) => v.altitude <= 0.5 && v.state !== 'destroyed' && Math.hypot(v.x - x, v.y - y) < 1.2)) return false;
    const npc = createNPC(ctx.allocNpcId(), 'a', x, y, 'cop', ctx.rng);
    npc.health = tier >= 3 ? 100 : 70;
    npc.state = 'chasing';
    ctx.npcs.push(npc);
    this.units.push({ ...nav(), vehicleId: AIRBORNE_UNIT, home: { x, y }, crew: [npc.id], tier,
      mode: 'deployed', stuckTimer: 0, ramCooldown: 0 });
    this.cops.push({ ...nav(), npcId: npc.id, vehicleId: AIRBORNE_UNIT,
      shotCooldown: 0.5 + ctx.rng() * 0.5, aimAngle: 0, fireFlash: 0, armed: false,
      detection: createMemory(), response: 'ignore' });
    ctx.onStructChange();
    return true;
  }

  /** A caça acabou: recolhe os helicópteros e libera as equipes descidas de corda. */
  private releaseAirborne(ctx: PoliceContext): void {
    let changed = false;
    for (let i = this.units.length - 1; i >= 0; i--) {
      if (this.units[i].vehicleId !== AIRBORNE_UNIT) continue;
      const unit = this.units.splice(i, 1)[0];
      for (const id of unit.crew) {
        const index = this.cops.findIndex((cop) => cop.npcId === id);
        if (index >= 0) this.cops.splice(index, 1);
        this.tactics.forget(id);
        const npc = this.npc(ctx, id);
        if (!npc) continue;
        if (npc.dead) { npc.kind = 'civ'; continue; } // O corpo fica para o LifeSystem reciclar.
        ctx.npcs.splice(ctx.npcs.indexOf(npc), 1);
      }
      changed = true;
    }
    if (changed) ctx.onStructChange();
  }

  private clearLine(map: Map, from: Point, to: Point): boolean {
    const radius = Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y)) / 2;
    return !map.queryNearby((from.x + to.x) / 2, (from.y + to.y) / 2, radius + 0.01)
      .some((box) => segmentAabb(from.x, from.y, to.x, to.y, box) !== null);
  }

  /**
   * Visão de um inimigo: cone (alcance + arco conforme o quanto está tenso) e depois
   * obstrução real por prédios e carros. De costas, nem a 1 tile ele percebe alguém.
   */
  private sees(ctx: PoliceContext, from: Viewer, range: number, alert = 0, ignoreVehicleId: number | null = null): boolean {
    if (ctx.concealed || ctx.player.health <= 0) return false;
    const cfg: VisionConfig = {
      range,
      halfFov: alert > 0 ? GAME_CONFIG.POLICE_VISION_HALF_ALERT : GAME_CONFIG.POLICE_VISION_HALF_FOOT,
    };
    return canSee({ ...from, alert }, { x: ctx.player.x, y: ctx.player.y, crouched: ctx.player.crouching },
      ctx, cfg, {
        light: ctx.night ? GAME_CONFIG.VISION_NIGHT_LIGHT : 1,
        ignoreVehicle: (v) => v.id === ignoreVehicleId || v.id === ctx.player.currentVehicleId,
      }).seen;
  }

  /** Memória do policial: ver abre o arco e grava a última posição; sumir relaxa aos poucos. */
  private observe(dt: number, cop: PoliceCop, npc: NPC, ctx: PoliceContext, range: number): boolean {
    // O oficial só registra o que vê com os próprios olhos: denúncia e tiro já entram
    // por `report()`. E com o alvo escondido nada aqui toca na posição real dele.
    // O olhar de um oficial segue o corpo: a mira só vira a cabeça depois que ele vê,
    // então usar aimAngle como direção criaria um laço em que ele nunca enxerga nada.
    const seen = this.sees(ctx, { x: npc.x, y: npc.y, dir: npc.dir }, range, cop.detection.attention);
    const distance = seen ? Math.hypot(npc.x - ctx.player.x, npc.y - ctx.player.y) : Infinity;
    cop.response = observe(cop.detection, { seen, heard: false, distance,
      // Tiroteio em curso é ameaça clara; a 1,5 tile de um civil desarmado ainda é só suspeita.
      threat: cop.armed && distance < range, kind: 'police', forgetAfter: GAME_CONFIG.POLICE_ALERT_MEMORY_S },
      seen ? { x: ctx.player.x, y: ctx.player.y } : cop.detection.lastSeen ?? { x: npc.x, y: npc.y }, dt);
    return seen;
  }

  private perceive(dt: number, ctx: PoliceContext): void {
    const previous = this.playerVisible;
    this.playerVisible = this.air.spotsPlayer || this.units.some((u) => {
      const v = this.vehicle(ctx, u.vehicleId);
      return !!v && this.operational(u, ctx) && u.crew.some((id) => this.npc(ctx, id)?.inVehicle) &&
        this.sees(ctx, { x: v.x, y: v.y, dir: v.dir, z: v.altitude }, GAME_CONFIG.POLICE_VISION_RANGE_VEHICLE, 0, v.id);
    }) || ctx.npcs.some((n) => n.kind === 'cop' && !n.dead && n.health > 0 && !n.inVehicle &&
      n.state !== 'knocked' && this.sees(ctx, { x: n.x, y: n.y, dir: n.dir }, GAME_CONFIG.POLICE_VISION_RANGE_FOOT));
    if (this.playerVisible) {
      this.unseenTimer = 0;
      this.searchArea = { x: ctx.player.x, y: ctx.player.y, radius: SEARCH_MIN, phase: 'pursuit' };
    } else if (this.searchArea) {
      const growing = Math.min(dt, Math.max(0, 8 - this.unseenTimer));
      this.unseenTimer += dt;
      this.searchArea.phase = 'search';
      this.searchArea.radius = Math.max(SEARCH_MIN, Math.min(SEARCH_MAX, this.searchArea.radius + (2 * growing - dt) * 0.55));
    }
    if (previous !== this.playerVisible) {
      for (const unit of this.units) if (unit.mode === 'respond' || unit.mode === 'deployed') Object.assign(unit, nav());
      for (const cop of this.cops) Object.assign(cop, nav());
    }
  }

  private searchGoal(agent: Navigation, from: Point, dt: number, ctx: PoliceContext, onFoot: boolean): Point {
    const area = this.searchArea!;
    if (this.playerVisible) return area;
    if (!agent.goal) agent.goal = { x: area.x, y: area.y };
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

  private waypoint(agent: Navigation, from: Point, goal: Point, dt: number, ctx: PoliceContext, onFoot: boolean, patrol = false): Point {
    agent.refreshTimer -= dt;
    const distance = Math.hypot(from.x - goal.x, from.y - goal.y);
    let dry = true;
    if (distance < 6) {
      const steps = Math.max(1, Math.ceil(distance * 3));
      for (let i = 1; i <= steps; i++) if (ctx.map.isWaterWorld(from.x + (goal.x - from.x) * i / steps, from.y + (goal.y - from.y) * i / steps)) dry = false;
    }
    if (onFoot && distance < 6 && dry && this.clearLine(ctx.map, from, goal)) return goal;
    if (agent.refreshTimer <= 0) {
      agent.route = onFoot ? ctx.map.findSidewalkPath(from.x, from.y, goal.x, goal.y) :
        patrol ? ctx.map.findRoadPath(from.x, from.y, goal.x, goal.y) : ctx.map.findUndirectedRoadPath(from.x, from.y, goal.x, goal.y);
      agent.routeIndex = agent.route.length > 1 && Math.hypot(agent.route[0].x - from.x, agent.route[0].y - from.y) < 0.75 ? 1 : 0;
      agent.refreshTimer = patrol ? 12 : 2.2 + ctx.rng() * 0.4;
    }
    while (agent.routeIndex < agent.route.length && Math.hypot(from.x - agent.route[agent.routeIndex].x, from.y - agent.route[agent.routeIndex].y) < 0.2) agent.routeIndex++;
    if (agent.routeIndex < agent.route.length) return agent.route[agent.routeIndex];
    return onFoot && distance < 5 && dry && this.clearLine(ctx.map, from, goal) ? goal : from;
  }

  private updateUnit(dt: number, unit: PoliceUnit, ctx: PoliceContext, level: number): void {
    const v = this.vehicle(ctx, unit.vehicleId);
    if (!v) return;
    const crew = unit.crew.map((id) => this.npc(ctx, id)).filter((n): n is NPC => !!n);
    const alive = crew.filter((n) => !n.dead && n.health > 0);
    if (v.health <= 0 || v.state === 'destroyed' || ctx.player.currentVehicleId === v.id) {
      this.disembark(unit, ctx);
      if (v.state === 'destroyed') for (const n of crew) { n.inVehicle = false; n.vehicleId = null; }
      return;
    }
    if (!alive.length) { v.speed = 0; v.state = 'parked'; v.occupied = false; return; }
    for (const n of crew) if (n.inVehicle) { n.x = v.x; n.y = v.y; n.lastX = v.x; n.lastY = v.y; }
    if ((unit.mode === 'respond' || unit.mode === 'deployed') && (level <= 0 || !this.searchArea)) {
      unit.mode = 'return'; Object.assign(unit, nav());
    }
    const foot = alive.some((n) => !n.inVehicle);
    if (unit.mode === 'deployed') {
      this.disembark(unit, ctx);
      v.speed = 0; v.state = 'parked';
      if (this.searchArea && Math.hypot(v.x - this.searchArea.x, v.y - this.searchArea.y) > 17) unit.mode = 'respond';
      else return;
    }
    if (foot) { v.speed = 0; v.state = 'parked'; return; }
    if (unit.mode === 'standby') { v.speed = 0; v.state = 'parked'; return; }
    let goal: Point;
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
    } else if (unit.mode === 'return') {
      goal = unit.home;
      if (Math.hypot(v.x - goal.x, v.y - goal.y) < 1) {
        unit.mode = unit.tier === 1 ? 'patrol' : 'standby'; Object.assign(unit, nav());
        v.speed = 0;
        return;
      }
    } else {
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
    if (distance < 0.05) { v.speed = 0; unit.stuckTimer += dt; return; }
    const dir: Dir4 = Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 'SE' : 'NW') : (dy >= 0 ? 'SW' : 'NE');
    v.dir = dir;
    v.facingAngle = dirToAngle(dir);
    const speed = unit.mode === 'patrol' ? 1.6 : GAME_CONFIG.POLICE_SPEED + level * 0.14;
    v.speed = Math.min(speed, v.speed + GAME_CONFIG.VEHICLE_ACCEL * dt, distance / dt);
    v.state = 'driving';
    const before = { x: v.x, y: v.y };
    this.slide(v, ctx, dx / distance * v.speed, dy / distance * v.speed, dt);
    const moved = Math.hypot(v.x - before.x, v.y - before.y);
    if (moved < v.speed * dt * 0.15) {
      unit.stuckTimer += dt;
      if (unit.stuckTimer > 1) unit.refreshTimer = 0;
    } else unit.stuckTimer = 0;
    for (const n of crew) if (n.inVehicle) { n.x = v.x; n.y = v.y; }
  }

  private exitPoint(v: Vehicle, npc: NPC, ctx: PoliceContext): Point | null {
    const box = vehicleGroundCollider(v);
    const margin = GAME_CONFIG.NPC_RADIUS + 0.12;
    const points = [
      { x: box.x - margin, y: v.y }, { x: box.x + box.width + margin, y: v.y },
      { x: v.x, y: box.y - margin }, { x: v.x, y: box.y + box.height + margin },
    ].sort((a, b) => Math.hypot(a.x - npc.x, a.y - npc.y) - Math.hypot(b.x - npc.x, b.y - npc.y));
    for (const p of points) {
      const circle = { ...p, radius: GAME_CONFIG.NPC_RADIUS };
      if (!ctx.map.isInside(p.x, p.y, circle.radius) || ctx.map.isWaterWorld(p.x, p.y) ||
        ctx.collision.overlapsAny(circle, ctx.map.queryNearby(p.x, p.y, 1)) ||
        !this.clearLine(ctx.map, v, p)) continue;
      if (ctx.vehicles.some((other) => other !== v && other.altitude <= 0.5 &&
        ctx.collision.overlapsAny(circle, [vehicleGroundCollider(other)]))) continue;
      if (ctx.npcs.some((n) => n !== npc && !n.dead && !n.inVehicle && Math.hypot(n.x - p.x, n.y - p.y) < 0.4)) continue;
      return p;
    }
    return null;
  }

  private disembark(unit: PoliceUnit, ctx: PoliceContext): void {
    const v = this.vehicle(ctx, unit.vehicleId);
    if (!v) return;
    let changed = false;
    for (const id of unit.crew) {
      const npc = this.npc(ctx, id);
      if (!npc || !npc.inVehicle || npc.dead) continue;
      const point = this.exitPoint(v, npc, ctx);
      if (!point) continue;
      npc.x = point.x; npc.y = point.y;
      npc.lastX = point.x; npc.lastY = point.y;
      npc.inVehicle = false; npc.vehicleId = null;
      if (npc.state !== 'knocked') npc.state = 'chasing';
      changed = true;
    }
    if (ctx.player.currentVehicleId !== v.id) v.occupied = unit.crew.some((id) => this.npc(ctx, id)?.inVehicle);
    if (changed) { ctx.onStructChange(); if (!ctx.concealed && Math.hypot(v.x - ctx.player.x, v.y - ctx.player.y) < 16) sound.play('doorOpen', 0.3); }
  }

  private updateCop(dt: number, cop: PoliceCop, ctx: PoliceContext, level: number): void {
    cop.fireFlash = Math.max(0, cop.fireFlash - dt);
    cop.shotCooldown = Math.max(0, cop.shotCooldown - dt);
    const npc = this.npc(ctx, cop.npcId);
    cop.armed = level >= 2 && !!this.searchArea;
    if (!npc || npc.dead || npc.health <= 0 || npc.inVehicle) return;
    if (npc.state === 'knocked') {
      npc.downTimer -= dt; npc.anim = 'idle'; npc.speed = npc.frame = 0;
      if (npc.downTimer <= 0) npc.state = 'chasing';
      return;
    }
    // Equipe de corda não tem viatura: a unidade dela é achada pela tripulação.
    const unit = cop.vehicleId === AIRBORNE_UNIT ? this.units.find((u) => u.crew.includes(npc.id))
      : this.units.find((u) => u.vehicleId === cop.vehicleId);
    const vehicle = this.vehicle(ctx, cop.vehicleId);
    const returning = !this.searchArea || !unit || unit.mode === 'return' || unit.mode === 'respond';
    const visible = !returning && this.observe(dt, cop, npc, ctx,
      cop.armed ? GAME_CONFIG.POLICE_VISION_RANGE_VEHICLE : GAME_CONFIG.POLICE_VISION_RANGE_FOOT);
    let goal: Point;
    if (returning && vehicle && vehicle.health > 0 && ctx.player.currentVehicleId !== vehicle.id) {
      goal = this.exitPoint(vehicle, npc, ctx) ?? { x: vehicle.x + 0.9, y: vehicle.y };
      this.tactics.forget(npc.id);
      if (Math.hypot(npc.x - goal.x, npc.y - goal.y) < 0.45 && this.clearLine(ctx.map, npc, goal)) {
        npc.inVehicle = true; npc.vehicleId = vehicle.id;
        npc.x = vehicle.x; npc.y = vehicle.y;
        npc.speed = 0; vehicle.occupied = true;
        Object.assign(cop, nav()); ctx.onStructChange(); return;
      }
    } else if (!visible && cop.detection.blindFor < 3 && cop.detection.lastSeen) {
      // Memória própria: o oficial varre o canto onde *ele* perdeu o alvo de vista,
      // não a média do esquadrão. É isso que faz flanquear por trás funcionar.
      goal = cop.detection.lastSeen;
    } else if (this.searchArea) goal = this.searchGoal(cop, npc, dt, ctx, true);
    else { npc.state = 'idle'; npc.anim = 'idle'; npc.speed = 0; this.tactics.forget(npc.id); return; }
    const target: TacticalTarget = visible
      ? { x: ctx.player.x, y: ctx.player.y, visible: true, contactRange: GAME_CONFIG.ARREST_RANGE }
      : { x: goal.x, y: goal.y, visible: false, contactRange: GAME_CONFIG.ARREST_RANGE };
    const order = this.tactics.order(dt, { id: npc.id, x: npc.x, y: npc.y, radius: GAME_CONFIG.NPC_RADIUS,
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
      cop.aimAngle = rotateAngleToward(cop.aimAngle, memory + Math.sin(cop.sweep * 1.1) * 0.8, COP_AIM_TURN * dt);
    }
    const step = this.waypoint(cop, npc, order.anchor, dt, ctx, true);
    const dx = step.x - npc.x, dy = step.y - npc.y, d = Math.hypot(dx, dy);
    npc.speed = d < 0.12 ? 0 : Math.min(level === 1 ? 1.9 : 1.75, d / dt);
    npc.state = npc.speed || order.engaged ? 'chasing' : 'idle';
    npc.anim = npc.speed ? 'walk' : 'idle';
    if (npc.speed) {
      const steps = Math.max(1, Math.ceil(npc.speed * dt / 0.1));
      for (let i = 0; i < steps; i++) {
        const circle = { x: npc.x + dx / d * npc.speed * dt / steps, y: npc.y + dy / d * npc.speed * dt / steps, radius: GAME_CONFIG.NPC_RADIUS };
        ctx.collision.resolveCircle(circle, ctx.map.queryNearby(circle.x, circle.y, 1.5));
        ctx.collision.resolveCircleVsVehicles(circle, ctx.vehicles);
        if (ctx.map.isInside(circle.x, circle.y, circle.radius) && !ctx.map.isWaterWorld(circle.x, circle.y)) { npc.x = circle.x; npc.y = circle.y; }
      }
      npc.dir = velocityToDir(dx, dy);
      npc.animTimer += dt * 1000;
      if (npc.animTimer > 110) { npc.animTimer = 0; npc.frame = (npc.frame + 1) % 4; }
    } else npc.frame = 0;
    npc.lastX = npc.x; npc.lastY = npc.y;
    // O corpo acompanha o olhar: é a mesma direção para o sprite, para o cone e para o radar.
    npc.dir = velocityToDir(Math.cos(cop.aimAngle), Math.sin(cop.aimAngle));
    // A reação manda no gatilho: só atira quem chegou a "perseguir" — o que apenas
    // suspeita da movimentação avança e cerca, sem abrir fogo às cegas.
    if (order.fire && cop.shotCooldown <= 0 && cop.response === 'chase' && this.fire(cop, npc, ctx, level)) this.tactics.noteShot(npc.id);
  }

  /**
   * Cones de visão dos oficiais empenhados, em coordenadas do mundo. O mapa desenha
   * exatamente o que a polícia pode ver agora: patrulha de rotina (memória em calma)
   * não vira raio-x na HUD, mas quem já te viu varre o arco aberto.
   */
  visionCones(ctx: PoliceContext): VisionCone[] {
    const cones: VisionCone[] = [];
    for (const cop of this.cops) {
      const npc = this.npc(ctx, cop.npcId);
      if (!npc || npc.dead || npc.inVehicle || npc.state === 'knocked' || cop.detection.phase === 'calm') continue;
      const viewer: Viewer = { x: npc.x, y: npc.y, dir: npc.dir, alert: cop.detection.attention };
      const radius = cop.armed ? GAME_CONFIG.POLICE_VISION_RANGE_VEHICLE : GAME_CONFIG.POLICE_VISION_RANGE_FOOT;
      const cfg: VisionConfig = { range: radius,
        halfFov: cop.detection.attention > 0 ? GAME_CONFIG.POLICE_VISION_HALF_ALERT : GAME_CONFIG.POLICE_VISION_HALF_FOOT };
      cones.push({ id: npc.id, x: npc.x, y: npc.y, axis: facingAngle(viewer), half: fovHalf(viewer, cfg),
        radius: sightRange(viewer, cfg, ctx.night ? GAME_CONFIG.VISION_NIGHT_LIGHT : 1), alert: cop.detection.attention });
    }
    return cones;
  }

  /** Colegas a pé no mesmo tiroteio: a tática espaça o esquadrão em vez de empilhar todo mundo. */
  private alliesFor(self: PoliceCop, npc: NPC, ctx: PoliceContext): NPC[] {
    const allies: NPC[] = [];
    for (const other of this.cops) {
      if (other === self) continue;
      const mate = this.npc(ctx, other.npcId);
      if (!mate || mate.dead || mate.inVehicle || mate.state === 'knocked') continue;
      if (Math.hypot(mate.x - npc.x, mate.y - npc.y) > 10) continue;
      allies.push(mate);
    }
    return allies;
  }

  private fire(cop: PoliceCop, npc: NPC, ctx: PoliceContext, level: number): boolean {
    cop.shotCooldown = level >= 4 ? 0.7 : 1.35;
    cop.fireFlash = 0.12;
    const angle = cop.aimAngle + (ctx.rng() - 0.5) * (level >= 4 ? 0.045 : 0.11);
    const distance = Math.hypot(npc.x - ctx.player.x, npc.y - ctx.player.y);
    const end = { x: npc.x + Math.cos(angle) * (distance + 0.3), y: npc.y + Math.sin(angle) * (distance + 0.3), z: ctx.player.crouching ? 0.65 : 1.25 };
    const barrier = CoverSystem.firstHit({ x: npc.x, y: npc.y, z: 1.35 }, end, ctx);
    let t = barrier?.t ?? 1;
    let hit = !!barrier;
    const victim = segmentCircle(npc.x, npc.y, end.x, end.y, ctx.player, GAME_CONFIG.PLAYER_RADIUS);
    const friendly = ctx.npcs.some((n) => {
      if (n === npc || n.dead || n.inVehicle) return false;
      const crossing = segmentCircle(npc.x, npc.y, end.x, end.y, n, GAME_CONFIG.NPC_RADIUS);
      return crossing !== null && crossing < t && (victim === null || crossing < victim);
    });
    if (friendly) { cop.fireFlash = 0; cop.shotCooldown = 0.25; return false; }
    if (victim !== null && victim < t && ctx.player.currentVehicleId === null) {
      t = victim; hit = true;
      if (ctx.health.damage(ctx.player, level >= 4 ? 10 : 7, ctx.time)) ctx.shake(0.16);
    } else if (barrier?.vehicle && barrier.vehicle.id === ctx.player.currentVehicleId) {
      barrier.vehicle.health = Math.max(0, barrier.vehicle.health - (level >= 4 ? 9 : 5));
    }
    this.tracers.push({ id: this.nextTracerId++, x1: npc.x, y1: npc.y,
      x2: npc.x + (end.x - npc.x) * t, y2: npc.y + (end.y - npc.y) * t, life: 0.15, hit });
    if (distance < 22) sound.play(level >= 4 ? 'smgShot' : 'pistolShot', 0.32 * (1 - distance / 26));
    return true;
  }

  private checkArrest(dt: number, ctx: PoliceContext, level: number): void {
    const player = ctx.player;
    const close = level === 1 && !ctx.concealed && this.cops.some((cop) => {
      const npc = this.npc(ctx, cop.npcId);
      // Prender é contato: o arco largo de quem já está em cima do alvo vale aqui.
      return npc && !npc.dead && !npc.inVehicle && npc.state !== 'knocked' &&
        this.sees(ctx, { x: npc.x, y: npc.y, dir: npc.dir }, GAME_CONFIG.ARREST_RANGE, 1);
    });
    if (close && player.currentVehicleId === null && Math.hypot(player.vx, player.vy) < 0.5 && player.health > 0) {
      player.arrestTimer += dt;
      if (player.arrestTimer >= GAME_CONFIG.ARREST_STAND_STILL_S) { player.arrestTimer = 0; ctx.onBusted(); }
    } else player.arrestTimer = 0;
  }

  private sirens(dt: number, ctx: PoliceContext): void {
    this.nearestPoliceDist = Infinity;
    if (!ctx.concealed) for (const unit of this.units) {
      if (unit.mode !== 'respond' && unit.mode !== 'deployed') continue;
      const vehicle = this.vehicle(ctx, unit.vehicleId);
      if (vehicle && this.operational(unit, ctx)) this.nearestPoliceDist = Math.min(this.nearestPoliceDist, Math.hypot(vehicle.x - ctx.player.x, vehicle.y - ctx.player.y));
      for (const id of unit.crew) {
        const npc = this.npc(ctx, id);
        if (npc && !npc.dead && !npc.inVehicle) this.nearestPoliceDist = Math.min(this.nearestPoliceDist, Math.hypot(npc.x - ctx.player.x, npc.y - ctx.player.y));
      }
    }
    this.sirenTimer -= dt;
    if (this.sirenTimer > 0) return;
    this.sirenTimer = 0.3;
    const volume = Math.max(0, Math.min(0.65, 0.7 * (1 - this.nearestPoliceDist / 28)));
    sound.setLoop('siren', volume > 0 && this.active ? 'siren' : null, volume);
  }

  private slide(v: Vehicle, ctx: PoliceContext, vx: number, vy: number, dt: number): void {
    const steps = Math.max(1, Math.ceil(Math.hypot(vx, vy) * dt / 0.15));
    const radius = Math.min(v.def.footprintW, v.def.footprintH) / 2;
    for (let i = 0; i < steps; i++) {
      const circle = { x: v.x + vx * dt / steps, y: v.y + vy * dt / steps, radius };
      ctx.collision.resolveCircle(circle, ctx.map.queryNearby(circle.x, circle.y, 2));
      ctx.collision.resolveCircleVsVehicles(circle, ctx.vehicles, v.id);
      if (ctx.map.isInside(circle.x, circle.y, radius) && !ctx.map.isWaterWorld(circle.x, circle.y)) { v.x = circle.x; v.y = circle.y; }
    }
  }
}
