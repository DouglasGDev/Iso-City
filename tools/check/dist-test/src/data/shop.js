"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FOOD_MENUS = exports.GUN_STORE_STOCK = void 0;
const weapons_1 = require("./weapons");
/**
 * A ficha da vitrine vem da definição da arma, não de um texto à parte: assim o preço nunca
 * promete um dano ou um pente diferente do que o tiro entrega.
 */
const gunNote = (id) => {
    const def = weapons_1.WEAPON_DEFS[id];
    return `Dano ${def.damage * def.pellets} · alcance ${def.range} · pente ${def.magazineSize}`;
};
exports.GUN_STORE_STOCK = [
    { id: 'gun-pistol', kind: 'gun', gun: 'pistol', label: 'Pistola', price: 400, note: gunNote('pistol') },
    { id: 'gun-revolver', kind: 'gun', gun: 'revolver', label: 'Revólver', price: 900, note: gunNote('revolver') },
    { id: 'gun-smg', kind: 'gun', gun: 'smg', label: 'SMG', price: 1200, note: gunNote('smg') },
    { id: 'gun-micro', kind: 'gun', gun: 'micro', label: 'Micro-SMG', price: 1500, note: gunNote('micro') },
    { id: 'gun-shotgun', kind: 'gun', gun: 'shotgun', label: 'Escopeta', price: 1800, note: gunNote('shotgun') },
    { id: 'gun-rifle', kind: 'gun', gun: 'rifle', label: 'Rifle', price: 2600, note: gunNote('rifle') },
    { id: 'gun-sniper', kind: 'gun', gun: 'sniper', label: 'Rifle de precisão', price: 3800, note: gunNote('sniper') },
    { id: 'ammo-box', kind: 'ammo', label: 'Caixa de munição', price: 80, note: 'Enche todos os pentes' },
];
exports.FOOD_MENUS = {
    cafe: [
        { id: 'cafe-copo', kind: 'meal', label: 'Café coado', price: 8, health: 12, stamina: 1 },
        { id: 'cafe-bolo', kind: 'meal', label: 'Fatia de bolo', price: 14, health: 28, stamina: 0.6 },
        { id: 'cafe-prato', kind: 'meal', label: 'Prato do dia', price: 32, health: 70, stamina: 1 },
    ],
    pizza: [
        { id: 'pizza-refri', kind: 'meal', label: 'Refrigerante', price: 6, health: 8, stamina: 1 },
        { id: 'pizza-fatia', kind: 'meal', label: 'Fatia de pizza', price: 12, health: 26, stamina: 0.5 },
        { id: 'pizza-grande', kind: 'meal', label: 'Pizza grande', price: 30, health: 66, stamina: 1 },
    ],
    sorveteria: [
        { id: 'sorvete-casquinha', kind: 'meal', label: 'Casquinha', price: 6, health: 12, stamina: 0.7 },
        { id: 'sorvete-milkshake', kind: 'meal', label: 'Milk-shake', price: 15, health: 30, stamina: 1 },
        { id: 'sorvete-bomba', kind: 'meal', label: 'Bomba de chocolate', price: 24, health: 48, stamina: 1 },
    ],
};
