"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DIR_VECTORS = exports.ELEVATION_PX = void 0;
exports.worldToScreen = worldToScreen;
exports.screenToWorld = screenToWorld;
exports.depthOf = depthOf;
exports.screenDirToWorld = screenDirToWorld;
exports.velocityToDir = velocityToDir;
exports.dirToAngle = dirToAngle;
exports.angleToDir = angleToDir;
exports.screenVecToDir = screenVecToDir;
exports.worldVecToAngle = worldVecToAngle;
exports.angleToWorldDir = angleToWorldDir;
exports.angleToWorldDirStable = angleToWorldDirStable;
exports.rotateAngleToward = rotateAngleToward;
exports.dirToWorldVec = dirToWorldVec;
exports.deltaToDir = deltaToDir;
/**
 * Pixels de tela que um tile de elevação anda para cima. O losango do tile é
 * 128x64, então 64px por tile de altura é exatamente o lado vertical de um cubo
 * isométrico da mesma base: o relevo vira volume no mesmo ritmo da arte, sem
 * inventar uma terceira projeção. `h` é altura em tiles, nunca em pixels.
 */
exports.ELEVATION_PX = 64;
/**
 * Projeção iso 2:1 do jogo. `h` desloca só o eixo Y de tela: o X continua
 * (x - y), ou seja, elevar o chão não gira nem inclina a câmera. É assim que o
 * relevo entra sem tirar do jogo a identidade isométrica.
 */
function worldToScreen(x, y, h = 0) {
    return { x: (x - y) * 64, y: (x + y) * 32 - h * exports.ELEVATION_PX };
}
function screenToWorld(sx, sy) {
    return { x: sx / 128 + sy / 64, y: sy / 64 - sx / 128 };
}
/**
 * Chave do pintor isométrico: quem está mais para baixo na tela desenha por último.
 * Com relevo, a âncora de um tile elevado sobe `2h` na mesma contagem, então o
 * morro da frente empurra o jogador de trás para o fundo exatamente como faz na tela.
 */
function depthOf(x, y, h = 0) {
    return x + y - 2 * h;
}
exports.DIR_VECTORS = {
    SE: { wx: 1, wy: 0 },
    SW: { wx: 0, wy: 1 },
    NE: { wx: 0, wy: -1 },
    NW: { wx: -1, wy: 0 },
};
function screenDirToWorld(dir) {
    return exports.DIR_VECTORS[dir];
}
function velocityToDir(vx, vy) {
    const sx = vx - vy;
    const sy = vx + vy;
    if (Math.abs(sx) < 1e-4 && Math.abs(sy) < 1e-4)
        return 'SE';
    if (sy >= 0) {
        return sx >= 0 ? 'SE' : 'SW';
    }
    return sx >= 0 ? 'NE' : 'NW';
}
function dirToAngle(dir) {
    // Mesma convenção do movimento: SE=+X, SW=+Y, NW=-X, NE=-Y
    return { SE: 0, SW: Math.PI / 2, NW: Math.PI, NE: -Math.PI / 2 }[dir];
}
function angleToDir(angle) {
    return angleToWorldDir(angle);
}
function screenVecToDir(sx, sy) {
    const wx = (sx + sy) / 2;
    const wy = (sy - sx) / 2;
    return velocityToDir(wx, wy);
}
function worldVecToAngle(wx, wy) {
    return Math.atan2(wy, wx);
}
function angleToWorldDir(angle) {
    const a = ((angle + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
    if (a >= -Math.PI / 4 && a < Math.PI / 4)
        return 'SE';
    if (a >= Math.PI / 4 && a < (3 * Math.PI) / 4)
        return 'SW';
    if (a >= (3 * Math.PI) / 4 || a < (-3 * Math.PI) / 4)
        return 'NW';
    return 'NE';
}
/** Troca de sprite 4-dir com histerese leve (jogador a pé). */
function angleToWorldDirStable(angle, current) {
    const next = angleToWorldDir(angle);
    if (next === current)
        return current;
    const a = ((angle + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
    const centers = {
        SE: 0,
        SW: Math.PI / 2,
        NW: Math.PI,
        NE: -Math.PI / 2,
    };
    const angDiff = (x, y) => {
        let d = x - y;
        d = ((d + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
        return Math.abs(d);
    };
    // Só troca se o próximo quadrante estiver claramente mais perto
    if (angDiff(a, centers[next]) + 0.14 < angDiff(a, centers[current]))
        return next;
    return current;
}
function rotateAngleToward(current, target, maxStep) {
    const diff = ((target - current + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
    if (Math.abs(diff) <= maxStep)
        return target;
    return current + (diff > 0 ? maxStep : -maxStep);
}
const DIR_WORLD_VEC = {
    SE: { wx: 1, wy: 0 },
    SW: { wx: 0, wy: 1 },
    NE: { wx: 0, wy: -1 },
    NW: { wx: -1, wy: 0 },
};
function dirToWorldVec(dir) {
    return DIR_WORLD_VEC[dir];
}
/** Deslocamento tile (tx,ty) → direção iso (+X=SE, +Y=SW, …). */
function deltaToDir(dx, dy) {
    if (dx > 0)
        return 'SE';
    if (dx < 0)
        return 'NW';
    if (dy > 0)
        return 'SW';
    return 'NE';
}
