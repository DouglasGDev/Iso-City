import type { GunId, WeaponId } from '../data/weapons';
import { GUN_IDS } from '../data/weapons';
import type { Dir4 } from './GameConfig';
import type { CharId } from '../entities/types';

/**
 * Contrato do save game, sem I/O: só o formato. Versão única (v1): se a estrutura mudar,
 * bump `SAVE_VERSION` e o loader recusa saves antigos em vez de corromper o mundo gerado.
 * Ficar livre de AsyncStorage deixa `GameState` carregável fora do app (checks em node).
 */
export const SAVE_VERSION = 1;

export interface SaveGame {
  version: number;
  /** game.time (s) e hora do mundo DayNight.t (0..1). */
  time: number;
  dayT: number;
  /** Subset persistente do jogador; timers transitórios são recriados no load. */
  player: {
    x: number;
    y: number;
    direction: Dir4;
    facingAngle: number;
    health: number;
    money: number;
    wantedLevel: number;
    stamina: number;
    char: CharId;
  };
  weapons: {
    equipped: WeaponId;
    owned: WeaponId[];
    ammo: Record<GunId, { loaded: number; reserve: number }>;
  };
  /** Grade de exploração em run-length (ExplorationSystem.serialize). */
  exploration: string;
}

/** Estrutura mínima que um payload salvo precisa ter para ser aplicável. */
export function isSaveGame(value: unknown): value is SaveGame {
  const save = value as SaveGame;
  if (save?.version !== SAVE_VERSION || !save.player || !save.weapons
    || typeof save.exploration !== 'string') return false;
  return GUN_IDS.every((id) => Boolean(save.weapons.ammo?.[id]));
}

/** % do mapa já revelado a partir do RLE, sem desserializar a grade inteira. */
export function exploredPercent(exploration: string): number {
  const header = exploration.slice(0, exploration.indexOf(':'));
  const [w, h] = header.split('x').map(Number);
  const total = w > 0 && h > 0 ? w * h : 0;
  if (!total) return 0;
  let explored = 0;
  for (const group of exploration.slice(header.length + 1).split(',')) {
    const dot = group.indexOf('.');
    if (Number(group.slice(0, dot)) > 0) explored += parseInt(group.slice(dot + 1), 36) || 0;
  }
  return (explored / total) * 100;
}
