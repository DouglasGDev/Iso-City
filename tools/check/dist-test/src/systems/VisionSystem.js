"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HEARING_RANGE = exports.CROUCH_HEAD_Z = exports.HEAD_Z = exports.EYE_Z = void 0;
exports.clampAngle = clampAngle;
exports.facingAngle = facingAngle;
exports.fovHalf = fovHalf;
exports.sightRange = sightRange;
exports.coneOf = coneOf;
exports.inCone = inCone;
exports.canSee = canSee;
exports.rayEnd = rayEnd;
exports.visionWedge = visionWedge;
const IsoUtils_1 = require("../world/IsoUtils");
const CoverSystem_1 = require("./CoverSystem");
/**
 * Altura dos olhos de quem vê e da cabeça de quem é visto, em metros. Os valores
 * vêm da jogabilidade já calibrada da rua: um mureta de ~1,1 m precisa deixar o
 * policial manter contato visual por cima dela, mas barrar a bala.
 */
exports.EYE_Z = 1.55;
exports.HEAD_Z = 1.45;
exports.CROUCH_HEAD_Z = 0.8;
/** Quem está em alerta varre quase meia-volta; ninguém tem atenção de 360°. */
const MAX_HALF_FOV = Math.PI * 0.78;
/** Passos e tiros chamam a atenção mesmo de costas — dentro de prédio, o som abafa. */
exports.HEARING_RANGE = 7.5;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
/** Normaliza um ângulo para o intervalo [-PI, PI]. */
function clampAngle(angle) {
    return ((angle + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
}
/** Para onde o observador está olhando, em radianos do plano do mundo. */
function facingAngle(viewer) {
    if (typeof viewer.aimAngle === 'number' && Number.isFinite(viewer.aimAngle))
        return viewer.aimAngle;
    const vector = (0, IsoUtils_1.dirToWorldVec)(viewer.dir ?? 'SE');
    return (0, IsoUtils_1.worldVecToAngle)(vector.wx, vector.wy);
}
/** Meio-ângulo efetivo do cone. */
function fovHalf(viewer, cfg) {
    const attention = 0.82 + 0.55 * clamp(viewer.alert ?? 0, 0, 1);
    const mood = 0.72 + 0.28 * clamp(viewer.mood ?? 1, 0, 1);
    return Math.min(MAX_HALF_FOV, cfg.halfFov * attention * mood);
}
/** Alcance efetivo: luz disponível e a altura de quem observa (agachar não encurta o alcance). */
function sightRange(viewer, cfg, light = 1) {
    const highGround = clamp(((viewer.z ?? 0) - 0.4) / 6, 0, 0.3);
    return cfg.range * clamp(light, 0, 1.4) * (1 + highGround);
}
function eyeOf(viewer) {
    return { x: viewer.x, y: viewer.y, z: (viewer.z ?? 0) + exports.EYE_Z };
}
function crestOf(target) {
    return { x: target.x, y: target.y, z: (target.z ?? 0) + (target.crouched ? exports.CROUCH_HEAD_Z : exports.HEAD_Z) };
}
/** Geometria do cone entre dois pontos: serve também a quem não tem dados de obstrução. */
function coneOf(viewer, target, cfg, light = 1) {
    const dx = target.x - viewer.x, dy = target.y - viewer.y;
    return {
        distance: Math.hypot(dx, dy),
        offAxis: Math.abs(clampAngle((0, IsoUtils_1.worldVecToAngle)(dx, dy) - facingAngle(viewer))),
        range: sightRange(viewer, cfg, light),
        half: fovHalf(viewer, cfg),
    };
}
/** Alcance + arco, sem teste de linha — a visão do guarda da cadeia é só isso. */
function inCone(viewer, target, cfg, light = 1) {
    const cone = coneOf(viewer, target, cfg, light);
    return cone.distance <= cone.range && cone.offAxis <= cone.half;
}
/**
 * Enxerga o alvo? Primeiro o cone (ângulo + alcance), depois obstrução real por
 * caixas e veículos. Um cone largo sem teste de linha viraria simples "inimigo
 * próximo", e é justamente o muro que faz a esquina esconder alguém.
 */
function canSee(viewer, target, ctx, cfg, opts = {}) {
    const cone = coneOf(viewer, target, cfg, opts.light ?? 1);
    const base = { distance: cone.distance, offAxis: cone.offAxis, heard: false };
    const muffled = !!opts.indoors;
    const outOfSight = !muffled && cone.distance <= exports.HEARING_RANGE;
    if (cone.distance > cone.range)
        return { ...base, seen: false, reason: 'range', clearance: 1, heard: outOfSight };
    if (cone.offAxis > cone.half)
        return { ...base, seen: false, reason: 'arc', clearance: 1, heard: outOfSight };
    const hit = CoverSystem_1.CoverSystem.firstHit(eyeOf(viewer), crestOf(target), ctx, opts.ignoreVehicle ?? opts.ignoreVehicleId ?? null);
    if (hit && hit.t < 0.94) {
        return { ...base, seen: false, reason: 'blocked', clearance: clamp(1 - hit.t, 0, 1) };
    }
    return { ...base, seen: true, reason: 'seen', clearance: 1 };
}
/** Onde o olhar para: a ponta do cone, ou o primeiro obstáculo no caminho. */
function rayEnd(viewer, angle, radius, ctx, opts = {}) {
    const far = { x: viewer.x + Math.cos(angle) * radius, y: viewer.y + Math.sin(angle) * radius, z: (viewer.z ?? 0) + exports.EYE_Z };
    const hit = CoverSystem_1.CoverSystem.firstHit(eyeOf(viewer), far, ctx, opts.ignoreVehicle ?? opts.ignoreVehicleId ?? null);
    if (!hit || hit.t >= 0.999)
        return { x: far.x, y: far.y };
    return { x: viewer.x + (far.x - viewer.x) * hit.t, y: viewer.y + (far.y - viewer.y) * hit.t };
}
/**
 * Setor de visão já em coordenadas iso de tela, pronto para desenhar. As bordas
 * são recortadas por prédios e carros reais, então a área cega aparece como
 * sombra atrás de cada obstáculo em vez de uma fatia uniforme.
 */
function visionWedge(viewer, halfAngle, radius, project, ctx, rays = 9, opts = {}) {
    const axis = facingAngle(viewer);
    // Poucos rays com um arco largo desenhariam uma estrela dentro do próprio
    // observador: o espaçamento angular tem um teto, não importa o `rays`.
    const span = halfAngle * 2;
    const count = Math.min(48, Math.max(3, Math.ceil(span / Math.max(0.04, span / rays))));
    const origin = project(viewer.x, viewer.y);
    let path = `M${origin.x.toFixed(2)},${origin.y.toFixed(2)}`;
    for (let i = 0; i <= count; i++) {
        const end = rayEnd(viewer, axis - halfAngle + (span * i) / count, radius, ctx, opts);
        const point = project(end.x, end.y);
        path += ` L${point.x.toFixed(2)},${point.y.toFixed(2)}`;
    }
    return `${path} Z`;
}
