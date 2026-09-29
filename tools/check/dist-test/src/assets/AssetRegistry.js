"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ASSETS_TO_LOAD = void 0;
exports.weaponKey = weaponKey;
exports.tileKey = tileKey;
exports.characterKey = characterKey;
exports.policeCharacterKey = policeCharacterKey;
exports.vehicleKey = vehicleKey;
exports.damagedVehicleKey = damagedVehicleKey;
exports.buildingKey = buildingKey;
exports.propKey = propKey;
exports.spriteKeyForVehicle = spriteKeyForVehicle;
exports.isKnownAsset = isKnownAsset;
exports.isUsableAsset = isUsableAsset;
const AssetManifest_1 = require("./AssetManifest");
function weaponKey(weapon, direction) {
    return `Weapons/${weapon}_${direction}.png`;
}
function tileKey(name) {
    return `Roads and Grounds/${name}.png`;
}
/** frame 0..3 → assets f01..f04 (pack Kenney é 1-based). Idle só tem f01. */
function characterKey(char, anim, dir, frame) {
    const clamped = anim === 'idle' ? 0 : ((frame % 4) + 4) % 4;
    const f = String(clamped + 1).padStart(2, '0');
    const folderAnim = anim === 'swim' ? 'walk' : anim;
    return `Characters/char_${char}_${folderAnim}_${dir}_f${f}.png`;
}
function policeCharacterKey(anim, dir, frame) {
    return characterKey('a', anim, dir, frame).replace('char_a_', 'char_police_');
}
function vehicleKey(type, color, dir, rotorFrame = 0) {
    if (type === 'helicopter') {
        const c = color || 'red';
        const base = `Vehicles/veh_helicopter_${c}_${dir}`;
        if (rotorFrame === 1 || rotorFrame === 2)
            return `${base}_f${rotorFrame}.png`;
        return `${base}.png`;
    }
    if (type === 'garbage') {
        return `Vehicles/veh_garbage_${dir}_normal.png`;
    }
    if (type === 'police' || type === 'bus_school' || type === 'firetruck' || type === 'swat') {
        return `Vehicles/veh_${type}_${dir}.png`;
    }
    return `Vehicles/veh_${type}${color ? '_' + color : ''}_${dir}.png`;
}
/**
 * Frame carbonizado do pack, quando existir (táxi, hatchback, ambulância,
 * police_compact e helicóptero não têm).
 */
function damagedVehicleKey(def, color, dir) {
    const paint = def.type === 'helicopter' ? color || 'red' : def.colors.length ? color : '';
    const key = `Vehicles/${def.baseKey}${paint ? '_' + paint : ''}_${dir}_damaged.png`;
    return key in AssetManifest_1.ASSET_FILES ? key : null;
}
function buildingKey(name) {
    return `Buildings/${name}.png`;
}
function propKey(name) {
    return `Props/${name}.png`;
}
function spriteKeyForVehicle(def, color, dir, rotorFrame = 0) {
    // Classification (e.g. police) is independent of the visual variant's baseKey.
    const paint = def.type === 'helicopter' ? color || 'red' : def.colors.length ? color : '';
    const base = `Vehicles/${def.baseKey}${paint ? '_' + paint : ''}_${dir}`;
    if (def.type === 'helicopter' && (rotorFrame === 1 || rotorFrame === 2)) {
        return `${base}_f${rotorFrame}.png`;
    }
    if (def.type === 'garbage')
        return `${base}_normal.png`;
    return `${base}.png`;
}
function isKnownAsset(key) {
    return key in AssetManifest_1.ASSET_FILES;
}
const IGNORE_PATTERNS = [
    /_damaged/,
    /_toppled/,
    /_dirty/,
    /_f1\.png$/,
    /_f2\.png$/,
    /water/,
    /bridge/,
    /_dry/,
];
function isUsableAsset(key) {
    if (!(key in AssetManifest_1.ASSET_FILES))
        return false;
    // Helicóptero: carregar frames do rotor (f1/f2)
    if (/Vehicles\/veh_helicopter_.*_f[12]\.png$/.test(key))
        return true;
    // casco queimado dos veículos que têm arte danificada no pack
    if (/^Vehicles\/veh_[a-z0-9_]+_(NE|NW|SE|SW)_damaged\.png$/.test(key))
        return true;
    if (/Roads and Grounds\/tile_ground_water\.png$/.test(key))
        return true;
    if (/Roads and Grounds\/tile_ground_.*water.*_clean\.png$/.test(key))
        return true;
    if (/Roads and Grounds\/tile_road_bridge_.*_normal\.png$/.test(key))
        return true;
    // terra batida nas vias secundárias (o filtro /_dry/ bloqueava drypatch)
    if (/Roads and Grounds\/tile_ground_dirt(_drypatch|_grasspatch|_puddle)?\.png$/.test(key)) {
        return true;
    }
    // areia da praia e do deserto (tools/prepare-terrain.cjs); /_dry/ pegaria a seca
    if (/Roads and Grounds\/tile_ground_sand_.*\.png$/.test(key))
        return true;
    // mato seco: é o único verde do deserto e da restinga da praia
    if (/Props\/prop_weed_.*_dry\.png$/.test(key))
        return true;
    return !IGNORE_PATTERNS.some((re) => re.test(key));
}
exports.ASSETS_TO_LOAD = Object.keys(AssetManifest_1.ASSET_FILES).filter(isUsableAsset);
