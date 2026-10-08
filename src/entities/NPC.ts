import type { Dir4 } from '../game/GameConfig';
import type { CharAnim, CharId, Collider } from './types';

export type NPCState = 'idle' | 'walking' | 'fleeing' | 'chasing' | 'knocked' | 'dead';
/**
 * `civ` é quem a multidão dirige. `cop`, `bombeiro` e `paramedico` são profissionais: têm um sistema
 * próprio que decide para onde eles vão, e a multidão não pode tocar neles — nem o trânsito, nem a
 * vizinhança, nem a vista. Por isso os três são excluídos com `kind !== 'civ'` e não por nome.
 */
export type NPCKind = 'civ' | 'cop' | 'bombeiro' | 'paramedico';

/** Simulation seconds, shared by LifeSystem and render worklets. */
export const DEATH_FALL_S = 0.65;
export const NPC_CORPSE_LIFETIME_S = 18;
export const NPC_CORPSE_FADE_S = 3;
export const PLAYER_DEATH_DELAY_S = 0.8;

// A -1 timer can survive until the first simulation tick after a death.
export function deathPose(dead: boolean, deathTimer: number, dir: Dir4 = 'SE') {
  'worklet';
  const elapsed = deathTimer >= 0 ? deathTimer : 0;
  const progress = dead ? Math.min(1, elapsed / DEATH_FALL_S) : 0;
  const fall = progress * progress * (3 - 2 * progress);
  const side = dir === 'NE' || dir === 'SE' ? 1 : -1;
  return {
    rotation: side * Math.PI / 2 * fall,
    offsetY: -2 * fall,
    scaleY: 1 - 0.25 * fall,
    alpha: dead ? Math.max(0, Math.min(1, (NPC_CORPSE_LIFETIME_S - elapsed) / NPC_CORPSE_FADE_S)) : 1,
  };
}

/** Rastro no chão: elipses em px de tela a partir do ponto onde o corpo caiu. */
export interface BloodStain {
  dx: number;
  dy: number;
  rx: number;
  ry: number;
  alpha: number;
}

/**
 * Poça e respingos determinísticos por (id, direção). Vive no NPC, então o
 * respawn limpa tudo sozinho — sem lista global crescendo com a sessão.
 */
export function bloodStains(seed: number, dir: Dir4): BloodStain[] {
  let state = Math.imul(seed + 1, 2654435761) >>> 0;
  const rnd = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 4294967296);
  // O corpo cai para o lado do `dir`; a poça escorre para esse mesmo lado.
  const side = dir === 'NE' || dir === 'SE' ? 1 : -1;
  const splatter = (count: number, offset: number, spread: number, size: number, alpha: number) =>
    Array.from({ length: count }, () => {
      const angle = rnd() * Math.PI * 2;
      const reach = spread * (0.4 + rnd() * 0.8);
      return {
        dx: side * offset + Math.cos(angle) * reach,
        dy: Math.sin(angle) * reach * 0.45,
        rx: size * (0.7 + rnd() * 0.8),
        ry: size * (0.35 + rnd() * 0.27),
        alpha,
      };
    });
  return [...splatter(3, 7, 5, 9, 0.9), ...splatter(6, 6, 18, 2.2, 0.72)];
}

/** Quantidade de elipses que formam a poça (o resto são respingos). */
export const BLOOD_POOL_STAINS = 3;

/** Lifecycle visibility only; viewport/depth culling still belongs to render. */
export function isNpcVisible(npc: Pick<NPC, 'dead' | 'deathTimer' | 'inVehicle'>): boolean {
  'worklet';
  return !npc.inVehicle && (!npc.dead || !(npc.deathTimer >= NPC_CORPSE_LIFETIME_S));
}

export interface NPC {
  id: number;
  char: CharId;
  kind: NPCKind;
  health: number;
  /** >0 = caçado no chão (s restantes) */
  downTimer: number;
  /** cooldown de soco (cop apenas) */
  punchCooldown: number;
  x: number;
  y: number;
  dir: Dir4;
  state: NPCState;
  speed: number;
  anim: CharAnim;
  frame: number;
  animTimer: number;
  /** Dentro d'água: nada até a margem em vez de andar sobre a água. */
  swimming: boolean;
  /** Rota atual (waypoints na rua) */
  path: { x: number; y: number }[];
  pathIndex: number;
  patienceTimer: number;
  stuckTimer: number;
  lastX: number;
  lastY: number;
  dead: boolean;
  /** -1 = alive/unobserved death; otherwise simulation seconds since death, capped at 18. */
  deathTimer: number;
  /** Manchas no chão criadas na morte; null até o LifeSystem observar o óbito. */
  blood: BloodStain[] | null;
  /** Dirigindo um veículo do trânsito */
  inVehicle: boolean;
  vehicleId: number | null;
  /** Tempo restante fugindo após ter o carro roubado (s) */
  fleeTimer: number;
  callingPolice: boolean;
}

export function createNPC(id: number, char: CharId, x: number, y: number, kind: NPCKind = 'civ', rng = Math.random): NPC {
  return {
    id,
    char,
    kind,
    // O bombeiro aguenta mais que o pedestre porque ele entra onde o pedestre não entra: o
    // IncendioSystem dá dano contínuo por proximidade da boca, e sem equipamento ele derreteria
    // no primeiro jato de água errada. O valor é o da roupa, não uma dificuldade. O paramédico fica
    // um degrau abaixo: ele atravessa o trânsito para chegar ao ferido, mas não entra no fogo.
    health: kind === 'cop' ? 70 : kind === 'bombeiro' ? 90 : kind === 'paramedico' ? 80 : 45,
    downTimer: 0,
    punchCooldown: 0,
    x,
    y,
    dir: 'SE',
    state: 'idle',
    speed: 0,
    anim: 'idle',
    frame: 0,
    animTimer: 0,
    swimming: false,
    path: [],
    pathIndex: 0,
    patienceTimer: 400 + rng() * 1200,
    stuckTimer: 0,
    lastX: x,
    lastY: y,
    dead: false,
    deathTimer: -1,
    blood: null,
    inVehicle: false,
    vehicleId: null,
    fleeTimer: 0,
    callingPolice: false,
  };
}

export function npcCollider(n: NPC): Collider {
  return { x: n.x - 0.14, y: n.y - 0.14, width: 0.28, height: 0.28, type: 'NPC' };
}
