"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ANIMAL_STATS = exports.ANIMAL_FADE_SECONDS = exports.ANIMAL_CORPSE_SECONDS = exports.ANIMAL_FALL_SECONDS = exports.ANIMAL_HABITATS = void 0;
exports.isAnimalHabitat = isAnimalHabitat;
exports.createAnimal = createAnimal;
exports.damage = damage;
exports.animalVisualState = animalVisualState;
exports.isAnimalVisible = isAnimalVisible;
exports.animalDeathPose = animalDeathPose;
exports.animalSpritePose = animalSpritePose;
exports.ANIMAL_HABITATS = {
    rabbit: ['forest', 'countryside', 'savanna'],
    deer: ['forest', 'pinewood', 'countryside'],
    fox: ['forest', 'pinewood', 'countryside', 'savanna'],
    boar: ['forest', 'pinewood', 'savanna'],
};
function isAnimalHabitat(biome) {
    return biome === 'forest' || biome === 'countryside' || biome === 'pinewood' || biome === 'savanna';
}
exports.ANIMAL_FALL_SECONDS = 0.65;
exports.ANIMAL_CORPSE_SECONDS = 16;
exports.ANIMAL_FADE_SECONDS = 3;
exports.ANIMAL_STATS = {
    rabbit: { health: 20, radius: 0.16, walkSpeed: 0.65, fleeSpeed: 3.4, alertRadius: 5.5 },
    deer: { health: 65, radius: 0.3, walkSpeed: 0.85, fleeSpeed: 4.4, alertRadius: 7.5 },
    fox: { health: 35, radius: 0.22, walkSpeed: 1.05, fleeSpeed: 4.1, alertRadius: 6.5 },
    boar: { health: 95, radius: 0.34, walkSpeed: 0.55, fleeSpeed: 3.15, alertRadius: 4.5 },
};
function createAnimal(id, species, x, y, seed = id + 1) {
    return {
        id, kind: 'animal', species, generation: 0, x, y, homeX: x, homeY: y, dir: 'SE', state: 'idle',
        health: exports.ANIMAL_STATS[species].health, radius: exports.ANIMAL_STATS[species].radius,
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
function damage(animal, amount) {
    if (animal.dead || !Number.isFinite(amount) || amount <= 0)
        return false;
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
function animalVisualState(animal, clock) {
    return {
        dir: animal.dir, state: animal.state, speed: animal.speed, dead: animal.dead,
        deathTimer: animal.deathTimer, animTime: animal.animTime, sampledAt: clock,
    };
}
function isAnimalVisible(animal) {
    'worklet';
    return !animal.dead || animal.deathTimer < exports.ANIMAL_CORPSE_SECONDS;
}
/** Pure, non-graphic collapse: feet stay anchored, body settles, then fades. */
function animalDeathPose(dead, deathTimer, dir = 'SE') {
    'worklet';
    const elapsed = Math.max(0, deathTimer);
    const progress = dead ? Math.min(1, elapsed / exports.ANIMAL_FALL_SECONDS) : 0;
    const fall = progress * progress * (3 - 2 * progress);
    const side = dir === 'SE' || dir === 'NE' ? 1 : -1;
    return {
        rotation: side * 0.42 * fall,
        scaleY: 1 - 0.62 * fall,
        offsetY: -2 * fall,
        alpha: dead ? Math.max(0, Math.min(1, (exports.ANIMAL_CORPSE_SECONDS - elapsed) / exports.ANIMAL_FADE_SECONDS)) : 1,
    };
}
/** Frame zero is resting; 1..4 are hand-drawn gait frames. No far/pause clock drift. */
function animalSpritePose(visual, clock) {
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
