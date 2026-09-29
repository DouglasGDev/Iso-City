import { GAME_CONFIG } from '../game/GameConfig';
import { MELEE_DEFS, type MeleeId } from '../data/weapons';
import type { Player } from '../entities/Player';
import type { NPC } from '../entities/NPC';
import type { Map } from '../world/Map';
import { sound } from '../audio/SoundManager';
import type { WantedSystem } from './WantedSystem';
import type { PickupSystem } from './PickupSystem';
import { segmentAabb } from './WeaponSystem';
import { damage as damageAnimal, type Animal } from '../entities/Animal';

export interface AttackContext {
  player: Player;
  npcs: NPC[];
  animals?: readonly Animal[];
  time: number;
  map: Pick<Map, 'queryNearby'>;
  wanted: Pick<WantedSystem, 'raise'>;
  pickups: Pick<PickupSystem, 'spawnDrop'>;
  /** Manual aim (mouse / right stick). Falls back to the walking facing when inactive. */
  aim?: { x: number; y: number; active: boolean };
  onStructChange: () => void;
  shake: (amount: number) => void;
  rng: () => number;
  paused?: boolean;
  overlay?: boolean;
}

/** Separate melee cadence/damage; neither fists nor bats use firearm ammunition. */
export class CombatSystem {
  private cooldown = 0;
  private animationLeft = 0;

  update(dt: number) {
    if (!Number.isFinite(dt) || dt <= 0) return;
    this.cooldown = Math.max(0, this.cooldown - dt);
    this.animationLeft = Math.max(0, this.animationLeft - dt);
  }

  get attacking(): boolean {
    return this.animationLeft > 0;
  }

  /** Returns true for a swing, including a miss. Walls block center-to-center LOS. */
  tryAttack(ctx: AttackContext, melee: 'unarmed' | MeleeId = 'unarmed'): boolean {
    const p = ctx.player;
    if (p.currentVehicleId !== null || p.swimming || p.health <= 0 || p.state === 'dead' ||
      ctx.paused || ctx.overlay || this.cooldown > 1e-8) return false;

    const def = MELEE_DEFS[melee];
    this.cooldown = def.cooldown;
    this.animationLeft = def.animationSeconds;
    p.attackTimer = def.animationSeconds;
    p.attackWeapon = melee;
    p.attackAngle = ctx.aim?.active ? Math.atan2(ctx.aim.y, ctx.aim.x) : p.facingAngle;
    sound.play(melee === 'bat' ? 'batSwing' : 'punch', melee === 'bat' ? 0.5 : 0.4);

    const fx = Math.cos(p.attackAngle);
    const fy = Math.sin(p.attackAngle);
    const walls = ctx.map.queryNearby(p.x, p.y, def.range + def.knockback + GAME_CONFIG.NPC_RADIUS);
    let hitAny = false;

    for (const npc of ctx.npcs) {
      if (npc.dead || npc.state === 'dead' || npc.health <= 0 || npc.inVehicle) continue;
      const dx = npc.x - p.x;
      const dy = npc.y - p.y;
      const d = Math.hypot(dx, dy);
      if (d > def.range) continue;
      const dot = d > 1e-4 ? (dx / d) * fx + (dy / d) * fy : 1;
      if (dot < Math.cos(def.arc)) continue;
      // Full segment (also endpoints/inside) avoids punching through thin facades.
      if (walls.some((wall) => segmentAabb(p.x, p.y, npc.x, npc.y, wall) !== null)) continue;

      hitAny = true;
      npc.health = Math.max(0, npc.health - def.damage);
      const pushX = (d > 1e-4 ? dx / d : fx) * def.knockback;
      const pushY = (d > 1e-4 ? dy / d : fy) * def.knockback;
      let fraction = 1;
      for (const wall of walls) {
        const r = GAME_CONFIG.NPC_RADIUS;
        const t = segmentAabb(npc.x, npc.y, npc.x + pushX, npc.y + pushY, {
          ...wall, x: wall.x - r, y: wall.y - r, width: wall.width + r * 2, height: wall.height + r * 2,
        });
        if (t !== null) fraction = Math.min(fraction, Math.max(0, t - 1e-4));
      }
      npc.x += pushX * fraction;
      npc.y += pushY * fraction;

      if (npc.health <= 0) {
        this.killNpc(npc, ctx, melee);
      } else {
        npc.state = 'knocked';
        npc.downTimer = GAME_CONFIG.NPC_DOWN_S;
        npc.anim = 'idle';
        npc.frame = 0;
        sound.play(melee === 'bat' ? 'batHit' : 'bodyHit', melee === 'bat' ? 0.6 : 0.55);
        ctx.wanted.raise(p, npc.kind === 'cop' ? GAME_CONFIG.WANTED_HIT_COP : GAME_CONFIG.WANTED_HIT_CIV);
      }
    }

    for (const animal of ctx.animals ?? []) {
      if (animal.dead || animal.health <= 0) continue;
      const dx = animal.x - p.x, dy = animal.y - p.y;
      const distance = Math.hypot(dx, dy);
      if (distance > def.range + animal.radius) continue;
      if (distance > 1e-4 && (dx * fx + dy * fy) / distance < Math.cos(def.arc)) continue;
      if (walls.some((wall) => segmentAabb(p.x, p.y, animal.x, animal.y, wall) !== null)) continue;
      damageAnimal(animal, def.damage);
      hitAny = true;
      sound.play(melee === 'bat' ? 'batHit' : 'bodyHit', 0.4);
    }
    if (hitAny) {
      ctx.shake(melee === 'bat' ? 0.45 : 0.35);
      ctx.onStructChange();
    }
    return true;
  }

  private killNpc(npc: NPC, ctx: AttackContext, melee: 'unarmed' | MeleeId = 'unarmed') {
    npc.dead = true;
    npc.state = 'dead';
    npc.speed = 0;
    npc.anim = 'idle';
    npc.frame = 0;
    ctx.wanted.raise(ctx.player, npc.kind === 'cop' ? GAME_CONFIG.WANTED_HIT_COP + 1 : GAME_CONFIG.WANTED_KILL);
    const drop =
      GAME_CONFIG.DROP_MONEY_MIN +
      ctx.rng() * (GAME_CONFIG.DROP_MONEY_MAX - GAME_CONFIG.DROP_MONEY_MIN);
    ctx.pickups.spawnDrop(npc.x, npc.y, drop);
    sound.play(melee === 'bat' ? 'batHit' : 'bodyHit', 0.7);
  }
}
