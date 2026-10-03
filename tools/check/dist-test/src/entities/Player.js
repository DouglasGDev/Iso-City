"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.meleeMotion = meleeMotion;
exports.crouchPose = crouchPose;
exports.createPlayer = createPlayer;
exports.playerCollider = playerCollider;
exports.isAboard = isAboard;
const GameConfig_1 = require("../game/GameConfig");
const weapons_1 = require("../data/weapons");
/** Three continuous phases, shared by the renderer and animation regression tests. */
function meleeMotion(melee, secondsLeft) {
    'worklet';
    const duration = weapons_1.MELEE_DEFS[melee].animationSeconds;
    const progress = Math.max(0, Math.min(1, 1 - secondsLeft / duration));
    const smooth = (t) => t * t * (3 - 2 * t);
    let reach;
    if (progress < 0.28)
        reach = -0.22 * smooth(progress / 0.28); // windup
    else if (progress < 0.55)
        reach = -0.22 + 1.22 * smooth((progress - 0.28) / 0.27);
    else
        reach = 1 - smooth((progress - 0.55) / 0.45); // return
    return { reach, swing: melee === 'bat' ? -1.2 + reach * 2.1 : 0 };
}
/** Foot-anchored split pose: rigid torso lowers, legs fold without scaling the head or weapons. */
function crouchPose(crouching, height = 32) {
    'worklet';
    return {
        torsoOffsetY: crouching ? height * 0.25 : 0,
        legScaleY: crouching ? 1 / 3 : 1,
        legScaleX: crouching ? 1.15 : 1,
    };
}
function createPlayer(x, y) {
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
        char: GameConfig_1.GAME_CONFIG.PLAYER_CHAR,
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
function playerCollider(p) {
    const r = GameConfig_1.GAME_CONFIG.PLAYER_RADIUS;
    return { x: p.x - r, y: p.y - r, width: r * 2, height: r * 2, type: 'PLAYER' };
}
/**
 * "A bordo" é uma coisa só: o corpo do jogador deixou de ser um pedestre na calçada e passou
 * a ser a posição de outra coisa — um carro dirigido ou um ônibus da malha. As duas origens
 * ficam separadas porque cada uma obedece a um dono diferente, mas toda leitura de "está
 * dentro de algo" usa esta função, senão o pedestre volta a andar em cima do asfalto com o
 * ônibus passando por cima dele.
 */
function isAboard(p) {
    return p.currentVehicleId !== null || p.busUnit !== null;
}
