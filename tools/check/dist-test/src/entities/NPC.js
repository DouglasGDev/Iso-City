"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BLOOD_POOL_STAINS = exports.PLAYER_DEATH_DELAY_S = exports.NPC_CORPSE_FADE_S = exports.NPC_CORPSE_LIFETIME_S = exports.DEATH_FALL_S = void 0;
exports.deathPose = deathPose;
exports.bloodStains = bloodStains;
exports.isNpcVisible = isNpcVisible;
exports.createNPC = createNPC;
exports.npcCollider = npcCollider;
/** Simulation seconds, shared by LifeSystem and render worklets. */
exports.DEATH_FALL_S = 0.65;
exports.NPC_CORPSE_LIFETIME_S = 18;
exports.NPC_CORPSE_FADE_S = 3;
exports.PLAYER_DEATH_DELAY_S = 0.8;
// A -1 timer can survive until the first simulation tick after a death.
function deathPose(dead, deathTimer, dir = 'SE') {
    'worklet';
    const elapsed = deathTimer >= 0 ? deathTimer : 0;
    const progress = dead ? Math.min(1, elapsed / exports.DEATH_FALL_S) : 0;
    const fall = progress * progress * (3 - 2 * progress);
    const side = dir === 'NE' || dir === 'SE' ? 1 : -1;
    return {
        rotation: side * Math.PI / 2 * fall,
        offsetY: -2 * fall,
        scaleY: 1 - 0.25 * fall,
        alpha: dead ? Math.max(0, Math.min(1, (exports.NPC_CORPSE_LIFETIME_S - elapsed) / exports.NPC_CORPSE_FADE_S)) : 1,
    };
}
/**
 * Poça e respingos determinísticos por (id, direção). Vive no NPC, então o
 * respawn limpa tudo sozinho — sem lista global crescendo com a sessão.
 */
function bloodStains(seed, dir) {
    let state = Math.imul(seed + 1, 2654435761) >>> 0;
    const rnd = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 4294967296);
    // O corpo cai para o lado do `dir`; a poça escorre para esse mesmo lado.
    const side = dir === 'NE' || dir === 'SE' ? 1 : -1;
    const splatter = (count, offset, spread, size, alpha) => Array.from({ length: count }, () => {
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
exports.BLOOD_POOL_STAINS = 3;
/** Lifecycle visibility only; viewport/depth culling still belongs to render. */
function isNpcVisible(npc) {
    'worklet';
    return !npc.inVehicle && (!npc.dead || !(npc.deathTimer >= exports.NPC_CORPSE_LIFETIME_S));
}
function createNPC(id, char, x, y, kind = 'civ', rng = Math.random) {
    return {
        id,
        char,
        kind,
        health: kind === 'cop' ? 70 : 45,
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
function npcCollider(n) {
    return { x: n.x - 0.14, y: n.y - 0.14, width: 0.28, height: 0.28, type: 'NPC' };
}
