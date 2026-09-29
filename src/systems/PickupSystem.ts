import { GAME_CONFIG } from '../game/GameConfig';
import { GUN_IDS, type GunId } from '../data/weapons';
import type { Player } from '../entities/Player';
import type { Map } from '../world/Map';

export type PickupKind = 'cash' | 'health' | 'ammo' | 'gun';

export interface Pickup {
  id: number;
  kind: PickupKind;
  x: number;
  y: number;
  amount: number;
  active: boolean;
  respawnAt: number;
  /** drop de combate: não reaparece, é removido após cooldown */
  temporary?: boolean;
  weapon?: GunId;
}

const MAX_ITEMS = 80;

/** Coletáveis espalhados pela cidade (grana na calçada + kits de vida). */
export class PickupSystem {
  items: Pickup[] = [];
  private spawns: { x: number; y: number }[] = [];
  private nextId = 0;

  init(map: Map, rng: () => number) {
    this.spawns = map.data.npcSpawns.length
      ? map.data.npcSpawns
      : map.sidewalkNodes.slice(0, 400);
    const pick = () => this.spawns[Math.floor(rng() * this.spawns.length)];
    for (let i = 0; i < GAME_CONFIG.PICKUP_CASH_COUNT; i++) {
      const s = pick();
      this.items.push(this.mk('cash', s.x, s.y, rndRange(rng, GAME_CONFIG.PICKUP_CASH_MIN, GAME_CONFIG.PICKUP_CASH_MAX)));
    }
    for (let i = 0; i < GAME_CONFIG.PICKUP_HEALTH_COUNT; i++) {
      const s = pick();
      this.items.push(this.mk('health', s.x, s.y, GAME_CONFIG.PICKUP_HEALTH_AMOUNT));
    }
    for (const shop of map.landmarks.filter((l) => l.key.startsWith('bld_gunshop'))) {
      this.items.push(this.mk('ammo', shop.front.x, shop.front.y, 0));
    }
    // Hidden firearm caches scattered across the city: the way to acquire guns.
    for (let i = 0; i < GAME_CONFIG.PICKUP_GUN_COUNT; i++) {
      const s = pick();
      const gun = this.mk('gun', s.x, s.y, 0);
      gun.weapon = GUN_IDS[i % GUN_IDS.length];
      this.items.push(gun);
    }
  }

  private mk(kind: PickupKind, x: number, y: number, amount: number): Pickup {
    return { id: this.nextId++, kind, x, y, amount, active: true, respawnAt: 0 };
  }

  /** Dinheiro derrubado (NPCs derrotados, recompensas). */
  spawnDrop(x: number, y: number, amount: number) {
    this.pushTemporary(this.mk('cash', x, y, Math.max(5, Math.round(amount))));
  }

  /** Arma derrubada por um oficial abatido; some como o dinheiro. */
  spawnWeaponDrop(x: number, y: number, weapon: GunId) {
    const gun = this.mk('gun', x, y, 0);
    gun.weapon = weapon;
    this.pushTemporary(gun);
  }

  private pushTemporary(p: Pickup) {
    if (this.items.length >= MAX_ITEMS) {
      const oldest = this.items.findIndex((item) => item.temporary);
      if (oldest < 0) return;
      this.items.splice(oldest, 1);
    }
    p.temporary = true;
    this.items.push(p);
  }

  update(time: number, player: Player, rng: () => number, onCollect: (p: Pickup) => void) {
    this.items = this.items.filter((p) => !(p.temporary && !p.active && time >= p.respawnAt));
    for (const p of this.items) {
      if (!p.active) {
        if (!p.temporary && time >= p.respawnAt && this.spawns.length) {
          if (p.kind !== 'ammo' && p.kind !== 'gun') {
            const s = this.spawns[Math.floor(rng() * this.spawns.length)];
            p.x = s.x;
            p.y = s.y;
          }
          p.active = true;
        }
        continue;
      }
      if ((p.kind === 'ammo' || p.kind === 'gun') && (player.currentVehicleId !== null || player.swimming)) continue;
      const d = Math.hypot(p.x - player.x, p.y - player.y);
      if (d < 0.65) {
        p.active = false;
        p.respawnAt = p.temporary ? time + 1 : time + GAME_CONFIG.PICKUP_RESPAWN_S;
        onCollect(p);
      }
    }
  }

  visibleItems(x: number, y: number, radius: number): Pickup[] {
    const r2 = radius * radius;
    return this.items.filter((p) => p.active && (p.x - x) * (p.x - x) + (p.y - y) * (p.y - y) < r2);
  }
}

function rndRange(rng: () => number, min: number, max: number): number {
  return Math.round(min + rng() * (max - min));
}
