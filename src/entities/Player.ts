import { GAME_CONFIG, type Dir4 } from '../game/GameConfig';
import { MELEE_DEFS, type MeleeId } from '../data/weapons';
import type { CharAnim, CharId, Collider, EntityState } from './types';

/** Three continuous phases, shared by the renderer and animation regression tests. */
export function meleeMotion(melee: 'unarmed' | MeleeId, secondsLeft: number) {
  'worklet';
  const duration = MELEE_DEFS[melee].animationSeconds;
  const progress = Math.max(0, Math.min(1, 1 - secondsLeft / duration));
  const smooth = (t: number) => t * t * (3 - 2 * t);
  let reach: number;
  if (progress < 0.28) reach = -0.22 * smooth(progress / 0.28); // windup
  else if (progress < 0.55) reach = -0.22 + 1.22 * smooth((progress - 0.28) / 0.27);
  else reach = 1 - smooth((progress - 0.55) / 0.45); // return
  return { reach, swing: melee === 'bat' ? -1.2 + reach * 2.1 : 0 };
}

/** Foot-anchored split pose: rigid torso lowers, legs fold without scaling the head or weapons. */
export function crouchPose(crouching: boolean, height = 32) {
  'worklet';
  return {
    torsoOffsetY: crouching ? height * 0.25 : 0,
    legScaleY: crouching ? 1 / 3 : 1,
    legScaleX: crouching ? 1.15 : 1,
  };
}

export interface Player {
  id: 'player';
  x: number;
  y: number;
  vx: number;
  vy: number;
  direction: Dir4;
  speed: number;
  health: number;
  money: number;
  wantedLevel: number;
  currentVehicleId: number | null;
  /**
   * Índice de `TransportSystem.units` quando o jogador está dentro de um ônibus da malha.
   * Vive separado de `currentVehicleId` porque os dois não obedecem à mesma coisa: um carro
   * obedece ao joystick, o ônibus obedece ao horário. Para o resto do jogo — corpo escondido,
   * câmera, quem pode ser atropelado — os dois são a mesma coisa, e é para isso que existe
   * `isAboard`.
   */
  busUnit: number | null;
  state: EntityState;
  char: CharId;
  anim: CharAnim;
  frame: number;
  animTimer: number;
  walkDir: Dir4;
  facingAngle: number;
  swimming: boolean;
  crouching: boolean;
  /** Visual elevation in unzoomed screen pixels; never changes the ground collider. */
  jumpHeight: number;
  /** Simulation seconds remaining; zero means grounded. */
  jumpTimer: number;
  jumpDuration: number;
  jumpStart: { x: number; y: number } | null;
  /** Non-null only for a validated, guided fence vault. */
  jumpEnd: { x: number; y: number } | null;
  /** 0..1; drena ao correr, regenera parado/andando */
  stamina: number;
  /** >0 = melee windup/extension/return active (simulation seconds remaining). */
  attackTimer: number;
  attackWeapon: 'unarmed' | MeleeId;
  /** Capture the swing direction without changing walking/facing input. */
  attackAngle: number;
  /** timestamp (game.time) do último dano sofrido */
  lastDamageAt: number;
  /** tempo parado perto da viatura/policial permitindo prisão (s) */
  arrestTimer: number;
  invulnUntil: number;
}

export function createPlayer(x: number, y: number): Player {
  return {
    id: 'player',
    x,
    y,
    vx: 0,
    vy: 0,
    direction: 'SE',
    speed: 0,
    health: 100,
    money: 500,
    wantedLevel: 0,
    currentVehicleId: null,
    busUnit: null,
    state: 'idle',
    char: GAME_CONFIG.PLAYER_CHAR,
    anim: 'idle',
    frame: 0,
    animTimer: 0,
    walkDir: 'SE',
    facingAngle: 0,
    swimming: false,
    crouching: false,
    jumpHeight: 0,
    jumpTimer: 0,
    jumpDuration: 0.65,
    jumpStart: null,
    jumpEnd: null,
    stamina: 1,
    attackTimer: 0,
    attackWeapon: 'unarmed',
    attackAngle: 0,
    lastDamageAt: -999,
    arrestTimer: 0,
    invulnUntil: 0,
  };
}

export function playerCollider(p: Player): Collider {
  const r = GAME_CONFIG.PLAYER_RADIUS;
  return { x: p.x - r, y: p.y - r, width: r * 2, height: r * 2, type: 'PLAYER' };
}

/**
 * "A bordo" é uma coisa só: o corpo do jogador deixou de ser um pedestre na calçada e passou
 * a ser a posição de outra coisa — um carro dirigido ou um ônibus da malha. As duas origens
 * ficam separadas porque cada uma obedece a um dono diferente, mas toda leitura de "está
 * dentro de algo" usa esta função, senão o pedestre volta a andar em cima do asfalto com o
 * ônibus passando por cima dele.
 */
export function isAboard(p: Player): boolean {
  return p.currentVehicleId !== null || p.busUnit !== null;
}
