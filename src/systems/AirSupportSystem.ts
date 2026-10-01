import { GAME_CONFIG } from '../game/GameConfig';
import type { Map } from '../world/Map';
import type { Player } from '../entities/Player';
import type { Vehicle } from '../entities/Vehicle';
import { createVehicle } from '../entities/Vehicle';
import { VEHICLE_DEFS } from '../data/vehicles';
import { velocityToDir } from '../world/IsoUtils';
import { sound } from '../audio/SoundManager';

type Point = { x: number; y: number };
type HeliPhase = 'inbound' | 'orbit' | 'descend' | 'climb' | 'outbound';

interface Heli {
  vehicleId: number;
  x: number;
  y: number;
  altitude: number;
  phase: HeliPhase;
  /** Ângulo da ronda: o aparelho ciranda a última posição conhecida, nunca paira sobre o player. */
  orbit: number;
  dropTimer: number;
  deployTimer: number;
  searchTimer: number;
  leaveTimer: number;
  /** true quando o aparelho foi destruído e a ficha só precisa sair da lista. */
  retired: boolean;
}

export interface AirSupportContext {
  map: Map;
  player: Player;
  vehicles: Vehicle[];
  rng: () => number;
  allocVehicleId: () => number;
  onStructChange: () => void;
  /** Player dentro de prédio: nem o holofote do helicóptero enxerga. */
  concealed?: boolean;
  /** Último ponto conhecido da perseguição; null quando a polícia perdeu o rastro. */
  target: Point | null;
  /** Desembarca um policial no solo; falso se o ponto está ocupado ou molhado. */
  deployOfficer: (x: number, y: number, tier: number) => boolean;
}

/** Helicópteros por estrela (0..5): o apoio aéreo assume a caça a partir de 4 estrelas. */
const HELIS_BY_LEVEL = [0, 0, 0, 0, 1, 2];
const HOVER_ALTITUDE = GAME_CONFIG.POLICE_HELI_ALTITUDE;
/** Altura do rapel: baixa o bastante para o holofote alcançar a rua, alta para não colidir. */
const DROP_ALTITUDE = 1.5;
const ORBIT_RADIUS = 4.2;
const HELI_SPEED = 3.4;
const DEPLOY_INTERVAL_S: [number, number] = [6.5, 9.5];
const OFFICERS_PER_DROP = 2;
const SPOT_SCAN_S = 0.4;
/** O holofote acompanha o alvo: a indicação aguenta entre duas varreduras sem piscar. */
const SPOT_HOLD_S = 1.5;
const LEAVE_S = 9;

/**
 * Apoio aéreo da polícia: cerca a última posição conhecida, mantém a delegacia inteira
 * informada enquanto ilumina o alvo e desce equipes de corda. Voo não colide com nada.
 */
export class AirSupportSystem {
  readonly helis: Heli[] = [];
  spotsPlayer = false;
  private spotTimer = 0;

  get active() { return this.helis.length > 0; }

  update(dt: number, level: number, ctx: AirSupportContext): void {
    if (!Number.isFinite(dt) || dt <= 0) return;
    const wanted = ctx.target ? HELIS_BY_LEVEL[Math.min(5, Math.max(0, level))] : 0;
    let serving = this.helis.filter((heli) => heli.phase !== 'outbound').length;
    while (serving < wanted && this.spawn(ctx)) serving++;
    this.spotTimer = Math.max(0, this.spotTimer - dt);
    for (const heli of [...this.helis]) this.step(dt, heli, ctx);
    // O holofote vale enquanto a caça tem alvo e o player está na rua.
    this.spotsPlayer = this.spotTimer > 0 && !ctx.concealed && !!ctx.target;
    if (!ctx.target) for (const heli of this.helis) this.dismiss(heli);
    for (let i = this.helis.length - 1; i >= 0; i--) {
      const heli = this.helis[i];
      if (!heli.retired && !(heli.phase === 'outbound' && heli.leaveTimer <= 0)) continue;
      this.discard(this.helis.splice(i, 1)[0], ctx);
    }
  }

  reset(ctx: AirSupportContext): void {
    for (const heli of this.helis.splice(0)) this.discard(heli, ctx);
    this.spotTimer = 0;
    this.spotsPlayer = false;
  }

  private dismiss(heli: Heli): void {
    if (heli.phase === 'outbound') return;
    heli.phase = 'outbound';
    heli.leaveTimer = LEAVE_S;
  }

  private spawn(ctx: AirSupportContext): boolean {
    const target = ctx.target;
    if (!target) return false;
    const ring = ctx.map.roadNodes.filter((node) => {
      const d = Math.hypot(node.x - target.x, node.y - target.y);
      return d > 26 && d < 70;
    });
    const node = ring[Math.floor(ctx.rng() * ring.length)] ?? ctx.map.roadNodes[0];
    if (!node) return false;
    const vehicle = createVehicle(ctx.allocVehicleId(), VEHICLE_DEFS.helicopter, 'white', node.x, node.y, 'SE');
    vehicle.altitude = HOVER_ALTITUDE * 0.7;
    // O par do aparelho é a cota: sobrevoar um morro já erguido não o enterra no talude.
    vehicle.elevation = ctx.map.heightSmoothAt(node.x, node.y) + vehicle.altitude;
    vehicle.occupied = true;
    vehicle.state = 'driving';
    ctx.vehicles.push(vehicle);
    this.helis.push({ vehicleId: vehicle.id, x: node.x, y: node.y, altitude: vehicle.altitude,
      phase: 'inbound', orbit: ctx.rng() * Math.PI * 2, dropTimer: 0, deployTimer: 3 + ctx.rng() * 3,
      searchTimer: 0, leaveTimer: 0, retired: false });
    ctx.onStructChange();
    return true;
  }

  private step(dt: number, heli: Heli, ctx: AirSupportContext): void {
    const vehicle = ctx.vehicles.find((v) => v.id === heli.vehicleId);
    if (!vehicle || vehicle.state === 'destroyed' || vehicle.health <= 0) {
      heli.retired = true;
      // O wreck precisa encostar no chão: a DestructionSystem cuida da explosão a partir dali.
      if (vehicle) {
        vehicle.altitude = Math.max(0, vehicle.altitude - dt * 4);
        vehicle.elevation = ctx.map.heightSmoothAt(vehicle.x, vehicle.y) + vehicle.altitude;
      }
      return;
    }
    const target = ctx.target ?? { x: heli.x, y: heli.y };
    const desired = heli.phase === 'outbound' ? this.escapeVector(heli, ctx) : this.hoverPoint(heli, target, dt);
    const dx = desired.x - heli.x, dy = desired.y - heli.y;
    const distance = Math.hypot(dx, dy);
    if (distance > 0.01) {
      const step = Math.min(HELI_SPEED * (heli.phase === 'outbound' ? 1.4 : 1), distance / dt) * dt;
      heli.x += dx / distance * step;
      heli.y += dy / distance * step;
      vehicle.dir = velocityToDir(dx, dy);
      vehicle.facingAngle = Math.atan2(dy, dx);
    }
    heli.x = Math.max(0.5, Math.min(ctx.map.worldW - 0.5, heli.x));
    heli.y = Math.max(0.5, Math.min(ctx.map.worldH - 0.5, heli.y));

    const ceiling = heli.phase === 'descend' ? DROP_ALTITUDE : HOVER_ALTITUDE;
    heli.altitude += (ceiling - heli.altitude) * Math.min(1, 1.5 * dt);
    vehicle.x = heli.x;
    vehicle.y = heli.y;
    vehicle.altitude = heli.altitude;
    // A ronda mantém a FOLGA sobre o terreno: a cota é o chão de agora mais o par.
    vehicle.elevation = ctx.map.heightSmoothAt(heli.x, heli.y) + heli.altitude;
    vehicle.occupied = true;
    vehicle.state = 'driving';
    vehicle.speed = distance > 0.01 ? HELI_SPEED : 0;

    if (heli.phase === 'inbound' && Math.hypot(heli.x - target.x, heli.y - target.y) < ORBIT_RADIUS * 2.4) heli.phase = 'orbit';
    if (heli.phase === 'orbit') this.deploy(dt, heli, ctx, target);
    if (heli.phase === 'descend') {
      heli.dropTimer -= dt;
      if (heli.dropTimer <= 0) {
        this.release(heli, ctx);
        heli.phase = 'climb';
      }
    }
    if (heli.phase === 'climb' && heli.altitude > HOVER_ALTITUDE * 0.85) heli.phase = 'orbit';
    if (heli.phase === 'outbound') heli.leaveTimer -= dt;
    this.scan(dt, heli, ctx);
    this.rotor(heli, ctx);
  }

  /** Slot de ronda: ciranda em volta da última posição conhecida. */
  private hoverPoint(heli: Heli, target: Point, dt: number): Point {
    heli.orbit += 0.5 * dt;
    return { x: target.x + Math.cos(heli.orbit) * ORBIT_RADIUS, y: target.y + Math.sin(heli.orbit) * ORBIT_RADIUS };
  }

  private escapeVector(heli: Heli, ctx: AirSupportContext): Point {
    const center = { x: ctx.map.worldW / 2, y: ctx.map.worldH / 2 };
    const dx = heli.x - center.x, dy = heli.y - center.y;
    const len = Math.hypot(dx, dy) || 1;
    const edge = Math.max(ctx.map.worldW, ctx.map.worldH);
    return { x: center.x + dx / len * edge, y: center.y + dy / len * edge };
  }

  /** Pousa de corda só quando já está em cima do alvo: senão o helicóptero vira alvo parado. */
  private deploy(dt: number, heli: Heli, ctx: AirSupportContext, target: Point): void {
    heli.deployTimer -= dt;
    if (heli.deployTimer > 0) return;
    heli.deployTimer = DEPLOY_INTERVAL_S[0] + ctx.rng() * (DEPLOY_INTERVAL_S[1] - DEPLOY_INTERVAL_S[0]);
    if (Math.hypot(heli.x - target.x, heli.y - target.y) > ORBIT_RADIUS * 2) return;
    heli.phase = 'descend';
    heli.dropTimer = 1.4;
  }

  /** Oito pontos em volta do aparelho: os livres recebem os policiais que descem de corda. */
  private release(heli: Heli, ctx: AirSupportContext): void {
    let dropped = 0;
    for (let attempt = 0; attempt < 8 && dropped < OFFICERS_PER_DROP; attempt++) {
      const angle = (attempt / 8) * Math.PI * 2;
      const point = { x: heli.x + Math.cos(angle) * 0.7, y: heli.y + Math.sin(angle) * 0.7 };
      if (!ctx.map.isInside(point.x, point.y, 0.3) || ctx.map.isWaterWorld(point.x, point.y)) continue;
      if (ctx.deployOfficer(point.x, point.y, 4)) dropped++;
    }
    if (dropped) sound.play('vault', 0.4);
  }

  /** Reconhecimento: de cima o helicóptero vê o player e a delegacia inteira passa a saber onde ele está. */
  private scan(dt: number, heli: Heli, ctx: AirSupportContext): void {
    heli.searchTimer -= dt;
    if (heli.searchTimer > 0) return;
    heli.searchTimer = SPOT_SCAN_S;
    if (ctx.concealed || ctx.player.health <= 0) return;
    if (Math.hypot(heli.x - ctx.player.x, heli.y - ctx.player.y) < GAME_CONFIG.POLICE_HELI_SPOT_RANGE) {
      this.spotTimer = SPOT_HOLD_S;
    }
  }

  private rotor(heli: Heli, ctx: AirSupportContext): void {
    if (ctx.concealed) return;
    const far = GAME_CONFIG.POLICE_HELI_SPOT_RANGE * 2;
    const distance = Math.hypot(heli.x - ctx.player.x, heli.y - ctx.player.y);
    if (distance < far) sound.play('heliRotor', 0.34 * (1 - distance / far));
  }

  private discard(heli: Heli, ctx: AirSupportContext): void {
    const index = ctx.vehicles.findIndex((v) => v.id === heli.vehicleId);
    // O wreck fica no mundo para a DestructionSystem explodir; só a ficha de voo sai.
    if (index >= 0 && ctx.vehicles[index].state !== 'destroyed') ctx.vehicles.splice(index, 1);
    ctx.onStructChange();
  }
}
