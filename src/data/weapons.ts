import { GAME_CONFIG } from '../game/GameConfig';

export type GunId = 'pistol' | 'revolver' | 'smg' | 'micro' | 'rifle' | 'sniper' | 'shotgun';
export type MeleeId = 'bat';
export type WeaponId = 'unarmed' | GunId | MeleeId;

export interface WeaponDefinition {
  readonly id: GunId;
  readonly label: string;
  readonly magazineSize: number;
  readonly reserveAmmo: number;
  /** Seconds; range is in world tiles, not screen pixels. */
  readonly fireInterval: number;
  readonly reloadSeconds: number;
  readonly range: number;
  /** Per pellet. A trigger always consumes exactly one round/shell. */
  readonly damage: number;
  readonly automatic: boolean;
  readonly pellets: number;
  /** Full cone width in radians; deterministic, evenly spaced pellets. */
  readonly spread: number;
}

export const WEAPON_DEFS: Readonly<Record<GunId, WeaponDefinition>> = {
  pistol: {
    id: 'pistol', label: 'PISTOLA', magazineSize: 12, reserveAmmo: 48,
    fireInterval: 0.32, reloadSeconds: 1.25, range: 14, damage: 27, automatic: false,
    pellets: 1, spread: 0,
  },
  revolver: {
    // Poucos tiros, cada um conta: é a arma de quem prefere acertar a descarregar.
    id: 'revolver', label: 'REVÓLVER', magazineSize: 6, reserveAmmo: 30,
    fireInterval: 0.55, reloadSeconds: 2.1, range: 18, damage: 62, automatic: false,
    pellets: 1, spread: 0,
  },
  smg: {
    id: 'smg', label: 'SMG', magazineSize: 30, reserveAmmo: 90,
    fireInterval: 0.1, reloadSeconds: 1.65, range: 12, damage: 13, automatic: true,
    pellets: 1, spread: 0,
  },
  micro: {
    // Ratina: alcance curto e pente infinito de tão rápido que esvazia.
    id: 'micro', label: 'MICRO', magazineSize: 33, reserveAmmo: 99,
    fireInterval: 0.07, reloadSeconds: 1.4, range: 10, damage: 11, automatic: true,
    pellets: 1, spread: 0,
  },
  rifle: {
    id: 'rifle', label: 'RIFLE', magazineSize: 24, reserveAmmo: 72,
    fireInterval: 0.16, reloadSeconds: 1.9, range: 24, damage: 24, automatic: true,
    pellets: 1, spread: 0,
  },
  sniper: {
    // Um tiro derruba um pedestre e fura colete; quem erra espera o ferrolho.
    id: 'sniper', label: 'PRECISÃO', magazineSize: 5, reserveAmmo: 20,
    fireInterval: 1.4, reloadSeconds: 2.6, range: 40, damage: 110, automatic: false,
    pellets: 1, spread: 0,
  },
  shotgun: {
    id: 'shotgun', label: 'ESCOPETA', magazineSize: 6, reserveAmmo: 24,
    fireInterval: 0.85, reloadSeconds: 2.2, range: 9, damage: 12, automatic: false,
    pellets: 7, spread: 0.3,
  },
};

export interface MeleeDefinition {
  readonly label: string;
  readonly cooldown: number;
  readonly animationSeconds: number;
  readonly damage: number;
  readonly range: number;
  readonly arc: number;
  readonly knockback: number;
}

export const MELEE_DEFS: Readonly<Record<'unarmed' | MeleeId, MeleeDefinition>> = {
  unarmed: {
    label: 'SOCOS', cooldown: GAME_CONFIG.ATTACK_COOLDOWN_S,
    animationSeconds: GAME_CONFIG.ATTACK_ANIM_S, damage: GAME_CONFIG.ATTACK_DAMAGE,
    range: GAME_CONFIG.ATTACK_RANGE, arc: GAME_CONFIG.ATTACK_ARC, knockback: 0.28,
  },
  bat: {
    label: 'TACO', cooldown: 0.72, animationSeconds: 0.52,
    damage: 38, range: 1.5, arc: 1.05, knockback: 0.38,
  },
};

export const GUN_IDS: readonly GunId[] = ['pistol', 'revolver', 'smg', 'micro', 'rifle', 'sniper', 'shotgun'];
export const WEAPON_ORDER: readonly WeaponId[] =
  ['unarmed', 'pistol', 'revolver', 'smg', 'micro', 'rifle', 'sniper', 'shotgun', 'bat'];

export function isGunId(id: string): id is GunId {
  return (GUN_IDS as readonly string[]).includes(id);
}

export function weaponLabel(id: WeaponId): string {
  return isGunId(id) ? WEAPON_DEFS[id].label : MELEE_DEFS[id].label;
}
