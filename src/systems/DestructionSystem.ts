import { GAME_CONFIG, type Dir4 } from '../game/GameConfig';
import type { Player } from '../entities/Player';
import type { NPC } from '../entities/NPC';
import type { Vehicle } from '../entities/Vehicle';
import { damagedVehicleKey } from '../assets/AssetRegistry';
import { sound } from '../audio/SoundManager';
import type { HealthSystem } from './HealthSystem';
import type { WantedSystem } from './WantedSystem';

export interface WreckShard {
  /** deslocamento em tiles do mundo e tamanho/rotação em px de tela */
  dx: number;
  dy: number;
  size: number;
  rot: number;
}

export interface Wreck {
  x: number;
  y: number;
  dir: Dir4;
  /** frame carbonizado do pack; null = desenhar a carcaça vetorial */
  key: string | null;
  /** entortado o suficiente pra não parecer um carro estacionado */
  tilt: number;
  shards: WreckShard[];
  /** GameState.time da explosão: o render anima fogo/fumaça a partir daqui */
  explodedAt: number;
}

/** Manchões de asfalto queimado não podem crescer sem limite na sessão. */
const MAX_WRECKS = 40;

export interface DestructionContext {
  player: Player;
  vehicles: Vehicle[];
  npcs: NPC[];
  health: HealthSystem;
  wanted: WantedSystem;
  time: number;
  onPlayerExitedVehicle: () => void;
  shake: (amount: number) => void;
  onStructChange: () => void;
}

/**
 * Veículos com HP zero explodem em área: dano em cadeia a carros, NPCs e ao
 * jogador; o casco carbonizado e os estilhaços ficam no cenário.
 */
export class DestructionSystem {
  wrecks: Wreck[] = [];

  update(dt: number, ctx: DestructionContext) {
    for (const v of ctx.vehicles) {
      if (v.health > 0 || v.state === 'destroyed') continue;
      this.explode(v, ctx);
    }
    void dt;
  }

  /** Espalhamento fixo por veículo: o mesmo wreck não muda de forma a cada explosão. */
  private static shards(seed: number): WreckShard[] {
    let state = (seed * 2654435761) >>> 0;
    const rnd = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 4294967296);
    return Array.from({ length: 7 }, () => ({
      dx: (rnd() * 2 - 1) * 0.8,
      dy: (rnd() * 2 - 1) * 0.8,
      size: 2 + rnd() * 4,
      rot: rnd() * Math.PI,
    }));
  }

  private explode(v: Vehicle, ctx: DestructionContext) {
    v.state = 'destroyed';
    v.speed = 0;
    v.occupied = false;
    v.altitude = 0;
    const tilt = (((Math.imul(v.id + 1, 668265263) >>> 0) / 4294967296) - 0.5) * 0.26;
    this.wrecks.push({
      x: v.x,
      y: v.y,
      dir: v.dir,
      key: damagedVehicleKey(v.def, v.color, v.dir),
      tilt,
      shards: DestructionSystem.shards(v.id + 1),
      explodedAt: ctx.time,
    });
    if (this.wrecks.length > MAX_WRECKS) this.wrecks.splice(0, this.wrecks.length - MAX_WRECKS);

    sound.play('explosion', 0.85);
    sound.play('glassBreak', 0.5);
    ctx.shake(1.4);

    const inVehicle = ctx.player.currentVehicleId === v.id;
    if (inVehicle) {
      ctx.onPlayerExitedVehicle();
      ctx.health.damage(ctx.player, GAME_CONFIG.PLAYER_EXPLODE_DAMAGE, ctx.time);
      ctx.player.invulnUntil = ctx.time + 0.8;
    }

    const r = GAME_CONFIG.VEHICLE_EXPLOSION_RADIUS;
    for (const other of ctx.vehicles) {
      if (other === v || other.state === 'destroyed') continue;
      const d = Math.hypot(other.x - v.x, other.y - v.y);
      if (d < r) other.health -= GAME_CONFIG.VEHICLE_EXPLOSION_DMG * (1 - d / r);
    }
    for (const npc of ctx.npcs) {
      if (npc.dead) continue;
      const d = Math.hypot(npc.x - v.x, npc.y - v.y);
      if (d < r) {
        npc.health -= 60;
        if (npc.health <= 0) {
          npc.dead = true;
          npc.state = 'dead';
        } else {
          npc.state = 'knocked';
          npc.downTimer = GAME_CONFIG.NPC_DOWN_S;
        }
      }
    }
    if (!inVehicle) {
      const d = Math.hypot(ctx.player.x - v.x, ctx.player.y - v.y);
      if (d < r) ctx.health.damage(ctx.player, 22 * (1 - d / r), ctx.time);
    }
    ctx.onStructChange();
  }
}
