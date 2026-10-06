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
import type { Gorila } from '../entities/Gorila';
import type { Guerreiro } from '../entities/Guerreiro';

export interface AttackContext {
  player: Player;
  npcs: NPC[];
  animals?: readonly Animal[];
  /**
   * O gigante da fronteira, enquanto estiver em pé. A porta do dano é `onGorilaHit`, não o
   * corpo: quem manda na vida dele é o `GorilaSystem`, e dois writes diretos (`vida -= x` aqui
   * e a caçada ali) fariam o cadáver acordar no tick seguinte.
   */
  gorila?: Gorila | null;
  onGorilaHit?: (damage: number) => void;
  /**
   * Os corpos do bando que acordou. Entram do mesmo jeito da fauna: um golpe de arcovarre mais de
   * um, e cada um apanha pelo próprio corpo — mas o dano sai pela porta do `TriboSystem` com o id,
   * porque quem decide quem caiu, quem fica furioso e quem larga o prisioneiro é o sistema deles.
   * Um porrete que escrevesse `vida -= x` aqui teria duas regras de morte para o mesmo corpo.
   */
  guerreiros?: readonly Guerreiro[];
  onGuerreiroHit?: (id: number, damage: number) => void;
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

    // O gigante entra no corpo a corpo pelo mesmo cone e o mesmo alcance, mas sem recuo: duas
    // toneladas não saem do lugar por um porrete, e empurrá-lo seria ensinar ao jogador que a
    // coisa é leve. Bater nele só atrasa a própria vida — é o que faz um taco ser uma resposta
    // possível, e não uma resposta boa.
    const gorila = ctx.gorila;
    if (gorila && !gorila.morto) {
      const dx = gorila.x - p.x, dy = gorila.y - p.y;
      const distance = Math.hypot(dx, dy);
      const noCone = distance <= 1e-4 || (dx * fx + dy * fy) / distance >= Math.cos(def.arc);
      if (distance <= def.range + gorila.raio && noCone
        && !walls.some((wall) => segmentAabb(p.x, p.y, gorila.x, gorila.y, wall) !== null)) {
        ctx.onGorilaHit?.(def.damage);
        hitAny = true;
        sound.play(melee === 'bat' ? 'batHit' : 'bodyHit', 0.4);
      }
    }
    // O bando entra no corpo a corpo pelo mesmo cone e alcance de um pedestre, e estar numa lista
    // é o que faz a aldeia ser combate e não chefão: dois deles dentro do arco do porrete apanham
    // juntos. Sem recuo nem empurrão de propósito — o corpo deles é do `TriboSystem`, e um desloc
    // escrito aqui seria o segundo dono da coordenada.
    for (const g of ctx.guerreiros ?? []) {
      if (g.morto) continue;
      const gx = g.x - p.x, gy = g.y - p.y;
      const gdist = Math.hypot(gx, gy);
      if (gdist > def.range + g.raio) continue;
      if (gdist > 1e-4 && (gx * fx + gy * fy) / gdist < Math.cos(def.arc)) continue;
      if (walls.some((wall) => segmentAabb(p.x, p.y, g.x, g.y, wall) !== null)) continue;
      ctx.onGuerreiroHit?.(g.id, def.damage);
      hitAny = true;
      sound.play(melee === 'bat' ? 'batHit' : 'bodyHit', 0.42);
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
