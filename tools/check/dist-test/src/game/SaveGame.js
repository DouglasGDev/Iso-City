"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SAVE_VERSION = void 0;
exports.isSaveGame = isSaveGame;
exports.exploredPercent = exploredPercent;
const weapons_1 = require("../data/weapons");
/**
 * Contrato do save game, sem I/O: só o formato. Versão única (v1): se a estrutura mudar,
 * bump `SAVE_VERSION` e o loader recusa saves antigos em vez de corromper o mundo gerado.
 * Ficar livre de AsyncStorage deixa `GameState` carregável fora do app (checks em node).
 */
exports.SAVE_VERSION = 1;
/** Estrutura mínima que um payload salvo precisa ter para ser aplicável. */
function isSaveGame(value) {
    const save = value;
    if (save?.version !== exports.SAVE_VERSION || !save.player || !save.weapons
        || typeof save.exploration !== 'string')
        return false;
    return weapons_1.GUN_IDS.every((id) => Boolean(save.weapons.ammo?.[id]));
}
/** % do mapa já revelado a partir do RLE, sem desserializar a grade inteira. */
function exploredPercent(exploration) {
    const header = exploration.slice(0, exploration.indexOf(':'));
    const [w, h] = header.split('x').map(Number);
    const total = w > 0 && h > 0 ? w * h : 0;
    if (!total)
        return 0;
    let explored = 0;
    for (const group of exploration.slice(header.length + 1).split(',')) {
        const dot = group.indexOf('.');
        if (Number(group.slice(0, dot)) > 0)
            explored += parseInt(group.slice(dot + 1), 36) || 0;
    }
    return (explored / total) * 100;
}
