/** Original wildlife model. Deliberately not an NPC or a police/combat target kind. */
export type AnimalSpecies = 'rabbit' | 'deer' | 'fox' | 'boar';
export type AnimalHabitat = 'forest' | 'countryside' | 'pinewood' | 'savanna';
export const ANIMAL_HABITATS: Record<AnimalSpecies, readonly AnimalHabitat[]> = {
  rabbit: ['forest', 'countryside', 'savanna'],
  deer: ['forest', 'pinewood', 'countryside'],
  fox: ['forest', 'pinewood', 'countryside', 'savanna'],
  boar: ['forest', 'pinewood', 'savanna'],
};
export function isAnimalHabitat(biome: string): biome is AnimalHabitat {
  return biome === 'forest' || biome === 'countryside' || biome === 'pinewood' || biome === 'savanna';
}
export type AnimalDirection = 'SE' | 'SW' | 'NW' | 'NE';
export type AnimalState = 'idle' | 'walking' | 'fleeing' | 'dead';
export interface AnimalPoint { x: number; y: number }

export const ANIMAL_FALL_SECONDS = 0.65;
export const ANIMAL_CORPSE_SECONDS = 16;
export const ANIMAL_FADE_SECONDS = 3;
export const ANIMAL_STATS = {
  rabbit: { health: 20, radius: 0.16, walkSpeed: 0.65, fleeSpeed: 3.4, alertRadius: 5.5 },
  deer: { health: 65, radius: 0.3, walkSpeed: 0.85, fleeSpeed: 4.4, alertRadius: 7.5 },
  fox: { health: 35, radius: 0.22, walkSpeed: 1.05, fleeSpeed: 4.1, alertRadius: 6.5 },
  boar: { health: 95, radius: 0.34, walkSpeed: 0.55, fleeSpeed: 3.15, alertRadius: 4.5 },
} as const;

export interface Animal extends AnimalPoint {
  readonly id: number;
  readonly kind: 'animal';
  readonly species: AnimalSpecies;
  /** The slot, object and id survive replacement; this number identifies a new life. */
  generation: number;
  /** Reserve it was born in. Fright can take it anywhere, but it walks back here. */
  homeX: number;
  homeY: number;
  dir: AnimalDirection;
  state: AnimalState;
  health: number;
  radius: number;
  speed: number;
  dead: boolean;
  /** Simulation seconds since death, -1 alive, capped at ANIMAL_CORPSE_SECONDS. */
  deathTimer: number;
  /** Seconds of actual, nearby movement only; far animals do not animate walking. */
  animTime: number;
  moveX: number;
  moveY: number;
  decisionTimer: number;
  fleeTimer: number;
  callTimer: number;
  /** Private-to-simulation bookkeeping, published poses exclude these fields. */
  randomState: number;
  deathNotified: boolean;
}

export function createAnimal(id: number, species: AnimalSpecies, x: number, y: number, seed = id + 1): Animal {
  return {
    id, kind: 'animal', species, generation: 0, x, y, homeX: x, homeY: y, dir: 'SE', state: 'idle',
    health: ANIMAL_STATS[species].health, radius: ANIMAL_STATS[species].radius,
    speed: 0, dead: false, deathTimer: -1, animTime: 0,
    moveX: 1, moveY: 0, decisionTimer: 1, fleeTimer: 0, callTimer: 8,
    randomState: seed >>> 0, deathNotified: false,
  };
}

/**
 * Returns true ONLY for the first lethal hit of this life. Dead/invalid hits do
 * nothing, including not restarting the fall. WildlifeSystem delivers onDeath
 * once, on its next positive-dt update (also when the corpse is far away).
 */
export function damage(animal: Animal, amount: number): boolean {
  if (animal.dead || !Number.isFinite(amount) || amount <= 0) return false;
  animal.health = Math.max(0, animal.health - amount);
  if (animal.health > 0) {
    animal.state = 'fleeing';
    animal.fleeTimer = Math.max(animal.fleeTimer, 3.5);
    return false;
  }
  animal.dead = true;
  animal.state = 'dead';
  animal.deathTimer = 0;
  animal.speed = 0;
  animal.fleeTimer = 0;
  animal.deathNotified = false;
  return true;
}

/** Small immutable snapshot for the UI thread; never capture the mutable Animal in a worklet. */
export interface AnimalVisualState {
  dir: AnimalDirection;
  state: AnimalState;
  speed: number;
  dead: boolean;
  deathTimer: number;
  animTime: number;
  /** Same simulation-second clock supplied to AnimalSprite, not Date.now(). */
  sampledAt: number;
}

export function animalVisualState(animal: Animal, clock: number): AnimalVisualState {
  return {
    dir: animal.dir, state: animal.state, speed: animal.speed, dead: animal.dead,
    deathTimer: animal.deathTimer, animTime: animal.animTime, sampledAt: clock,
  };
}

export function isAnimalVisible(animal: Pick<Animal, 'dead' | 'deathTimer'>): boolean {
  'worklet';
  return !animal.dead || animal.deathTimer < ANIMAL_CORPSE_SECONDS;
}

/** Pure, non-graphic collapse: feet stay anchored, body settles, then fades. */
export function animalDeathPose(dead: boolean, deathTimer: number, dir: AnimalDirection = 'SE') {
  'worklet';
  const elapsed = Math.max(0, deathTimer);
  const progress = dead ? Math.min(1, elapsed / ANIMAL_FALL_SECONDS) : 0;
  const fall = progress * progress * (3 - 2 * progress);
  const side = dir === 'SE' || dir === 'NE' ? 1 : -1;
  return {
    rotation: side * 0.42 * fall,
    scaleY: 1 - 0.62 * fall,
    offsetY: -2 * fall,
    alpha: dead ? Math.max(0, Math.min(1, (ANIMAL_CORPSE_SECONDS - elapsed) / ANIMAL_FADE_SECONDS)) : 1,
  };
}

/** Frame zero is resting; 1..4 are hand-drawn gait frames. No far/pause clock drift. */
export function animalSpritePose(visual: AnimalVisualState, clock: number) {
  'worklet';
  // Interpolate only a small gap between publications. Never invent long death timers.
  const elapsed = visual.deathTimer + (visual.dead ? Math.max(0, Math.min(0.1, clock - visual.sampledAt)) : 0);
  const moving = !visual.dead && visual.speed > 0.01 && (visual.state === 'walking' || visual.state === 'fleeing');
  const running = visual.state === 'fleeing';
  const frame = moving ? 1 + (Math.floor(visual.animTime * (running ? 13 : 7)) % 4) : 0;
  return {
    ...animalDeathPose(visual.dead, elapsed, visual.dir),
    frame,
    mirror: visual.dir === 'SW' || visual.dir === 'NW' ? -1 : 1,
    away: visual.dir === 'NE' || visual.dir === 'NW',
    bob: moving && (frame === 1 || frame === 3) ? (running ? -2 : -1) : 0,
  };
}
