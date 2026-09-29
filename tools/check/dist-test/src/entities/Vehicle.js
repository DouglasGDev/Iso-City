"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createVehicle = createVehicle;
exports.vehicleSpriteKey = vehicleSpriteKey;
const AssetRegistry_1 = require("../assets/AssetRegistry");
const IsoUtils_1 = require("../world/IsoUtils");
function createVehicle(id, def, color, x, y, dir) {
    const isHeli = def.type === 'helicopter';
    return {
        id,
        def,
        color,
        x,
        y,
        dir,
        facingAngle: (0, IsoUtils_1.dirToAngle)(dir),
        speed: 0,
        health: 100,
        occupied: false,
        state: 'parked',
        turnTimer: 0,
        flashing: 0,
        animFrame: isHeli ? 1 : 0,
        animTimer: 0,
        altitude: 0,
    };
}
function vehicleSpriteKey(v) {
    const rotor = v.def.type === 'helicopter' ? (v.animFrame === 0 ? 1 : v.animFrame) : 0;
    return (0, AssetRegistry_1.spriteKeyForVehicle)(v.def, v.color, v.dir, rotor);
}
