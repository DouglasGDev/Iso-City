"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createMemory = createMemory;
exports.observe = observe;
exports.remembered = remembered;
exports.urgency = urgency;
const PHASES = ['calm', 'suspicious', 'alert', 'hostile'];
const ATTENTION = [0, 0.34, 0.72, 1];
/**
 * Reação esperada de cada tipo ao detectar. Presa não contra-ataca nem vem ver de perto:
 * do 'alert' para cima é corrida, e o que cresce é a atenção (arco mais aberto, memória mais
 * longa), não a direção. Pedestre foge, guarda e polícia apertam o cerco.
 */
const REACTIONS = {
    police: { calm: 'ignore', suspicious: 'look', alert: 'approach', hostile: 'chase' },
    guard: { calm: 'ignore', suspicious: 'look', alert: 'approach', hostile: 'chase' },
    wildlife: { calm: 'ignore', suspicious: 'look', alert: 'flee', hostile: 'flee' },
    civilian: { calm: 'ignore', suspicious: 'look', alert: 'flee', hostile: 'flee' },
};
const DEFAULT_FORGET = [0, 2.5, 4, 7];
function createMemory() {
    return { phase: 'calm', attention: 0, lastSeen: null, blindFor: 0, escapes: 0 };
}
const index = (phase) => PHASES.indexOf(phase);
function move(memory, to, input) {
    const from = index(memory.phase);
    memory.phase = to;
    memory.attention = ATTENTION[index(to)];
    // Sobe rápido (um flagrante não pede licença), desce degrau por degrau.
    if (index(to) > from)
        memory.blindFor = 0;
    if (to === 'alert' && input.threat)
        memory.phase = 'hostile';
}
/**
 * Atualiza a memória de um observador e devolve a reação do turno.
 * Ver dá segurança; ouvir dá suspeita; sumir por `forgetAfter` segundos relaxa.
 * O alvo nunca é adivinhado de graça: `lastSeen` é a única pista registrada.
 */
function observe(memory, input, target, dt) {
    const forgetAfter = input.forgetAfter ?? DEFAULT_FORGET[index(memory.phase)];
    if (input.seen) {
        if (memory.blindFor > 0.4)
            memory.escapes++;
        memory.blindFor = 0;
        memory.lastSeen = { x: target.x, y: target.y };
        const next = input.threat ? 'hostile'
            : memory.phase === 'calm' ? (input.distance < 3 ? 'alert' : 'suspicious')
                : memory.phase === 'suspicious' ? 'alert' : memory.phase;
        move(memory, next, input);
    }
    else {
        memory.blindFor += dt;
        if (input.heard && index(memory.phase) < index('alert')) {
            memory.lastSeen = { x: target.x, y: target.y };
            move(memory, memory.phase === 'calm' ? 'suspicious' : 'alert', input);
        }
        else if (memory.blindFor > forgetAfter) {
            memory.blindFor = 0;
            move(memory, PHASES[Math.max(0, index(memory.phase) - 1)], input);
        }
    }
    return REACTIONS[input.kind][memory.phase];
}
/** Onde o observador *acha* que o alvo está — o rastro, não a verdade. */
function remembered(memory, fallback) {
    return memory.lastSeen ?? { x: fallback.x, y: fallback.y };
}
/** Áspera (0..n) para ordenar decisões e desenhar o nível de alerta no mapa. */
function urgency(memory) {
    return index(memory.phase) + memory.attention;
}
