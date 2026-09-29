"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WEAPON_ORDER = exports.GUN_IDS = exports.MELEE_DEFS = exports.WEAPON_DEFS = void 0;
exports.isGunId = isGunId;
exports.weaponLabel = weaponLabel;
const GameConfig_1 = require("../game/GameConfig");
exports.WEAPON_DEFS = {
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
exports.MELEE_DEFS = {
    unarmed: {
        label: 'SOCOS', cooldown: GameConfig_1.GAME_CONFIG.ATTACK_COOLDOWN_S,
        animationSeconds: GameConfig_1.GAME_CONFIG.ATTACK_ANIM_S, damage: GameConfig_1.GAME_CONFIG.ATTACK_DAMAGE,
        range: GameConfig_1.GAME_CONFIG.ATTACK_RANGE, arc: GameConfig_1.GAME_CONFIG.ATTACK_ARC, knockback: 0.28,
    },
    bat: {
        label: 'TACO', cooldown: 0.72, animationSeconds: 0.52,
        damage: 38, range: 1.5, arc: 1.05, knockback: 0.38,
    },
};
exports.GUN_IDS = ['pistol', 'revolver', 'smg', 'micro', 'rifle', 'sniper', 'shotgun'];
exports.WEAPON_ORDER = ['unarmed', 'pistol', 'revolver', 'smg', 'micro', 'rifle', 'sniper', 'shotgun', 'bat'];
function isGunId(id) {
    return exports.GUN_IDS.includes(id);
}
function weaponLabel(id) {
    return isGunId(id) ? exports.WEAPON_DEFS[id].label : exports.MELEE_DEFS[id].label;
}
