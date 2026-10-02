"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.JAIL_PIECES = exports.JAIL_INMATES = exports.JAIL_PATROL = exports.JAIL_ARMORY_GATE = exports.JAIL_GATE_SLOTS = exports.JAIL_ARMORY = exports.JAIL_PANEL = exports.JAIL_EXIT = exports.JAIL_SPAWN = exports.JAIL_CELL_SPAWN = exports.JAIL_PLAYER_CELL = exports.JAIL_CELLS = exports.JAIL_FRONT_Y = exports.JAIL_T = exports.JAIL_H = exports.JAIL_W = void 0;
exports.jailCellWalk = jailCellWalk;
/**
 * Planta da penitenciária. Uma sala grande, isolada na orla da cidade: um bloco de
 * celas no fundo, um pátio de dia no meio, um depósito de armas gradesado (área
 * trancada que só as chaves do guarda abrem) e a porta da rua na frente.
 * Tudo aqui é geometria pura — quem transforma isso em móveis, colisão, visão e
 * pena é o `JailSystem` / `InteriorSystem`, então a cela que se vê é a cela que bloqueia.
 */
exports.JAIL_W = 17;
exports.JAIL_H = 12;
/** Espessura das paredes internas, igual à do casca da sala. */
exports.JAIL_T = 0.35;
/** Linha frontal das celas: é ali que ficam as grades e o batente da porta de cada cela. */
exports.JAIL_FRONT_Y = 4.4;
const cell = (x0, x1) => {
    const gate = 1.4, center = (x0 + x1) / 2;
    return { x0, x1, gateX0: center - gate / 2, gateX1: center + gate / 2 };
};
// Cinco celas ao longo da parede do fundo, com divisórias de uma espessura de parede.
// O bloco encosta nas faces internas das paredes oeste e leste do próprio quarto: sobrar piso
// entre a casca e a divisória é uma cela sem porta — era a última, aberta para o pátio bem ao
// lado do painel que destranca tudo. As larguras saem da conta, então o bloco nunca deixa fresta.
const CELAS = 5;
const faceOeste = exports.JAIL_T;
const faceLeste = exports.JAIL_W - exports.JAIL_T;
const larguraCela = (faceLeste - faceOeste - (CELAS - 1) * exports.JAIL_T) / CELAS;
exports.JAIL_CELLS = Array.from({ length: CELAS }, (_unused, i) => cell(faceOeste + i * (larguraCela + exports.JAIL_T), faceOeste + (i + 1) * larguraCela + i * exports.JAIL_T));
/** Cela onde quem é pego acorda. */
exports.JAIL_PLAYER_CELL = 0;
exports.JAIL_CELL_SPAWN = { x: (exports.JAIL_CELLS[0].x0 + exports.JAIL_CELLS[0].x1) / 2, y: 3.7 };
/** Entrada de quem invade: no meio do pátio, longe de móvel e das grades. */
exports.JAIL_SPAWN = { x: 8, y: 6.6 };
exports.JAIL_EXIT = { x: 8, y: exports.JAIL_H - exports.JAIL_T };
/** Painel que destranca todas as celas — só responde com as chaves do guarda. */
exports.JAIL_PANEL = { x: 13.9, y: 6.5 };
/**
 * Depósito de armas: uma jaula gradesada no canto do pátio. As grades são a única
 * passagem; com a cela-mãe fechada é impossível alcançá-las por fora — é área trancada.
 * A face oeste da jaula é a própria parede do quarto: uma jaula que não encosta nela
 * deixa um beco de piso entre as barras e a casca, que é o mesmo buraco da cela aberta.
 */
exports.JAIL_ARMORY = { x0: exports.JAIL_T, x1: 4.4, y0: 6.6, y1: 9.4, gateX0: 1.9, gateX1: 3.3, loot: { x: 1.5, y: 7.3 } };
/**
 * Cada vão gradesado da sala, indexado na ordem em que `JailSystem.gates` os mantém.
 * Os primeiros são as celas; o último é a porta do depósito. O renderizador usa o
 * sufixo numérico do id da grade (`gate-<i>`) para consultar `gateOpen(i)`.
 */
exports.JAIL_GATE_SLOTS = [
    ...exports.JAIL_CELLS.map((c) => ({ x: c.gateX0, y: exports.JAIL_FRONT_Y, width: c.gateX1 - c.gateX0, height: exports.JAIL_T })),
    { x: exports.JAIL_ARMORY.gateX0, y: exports.JAIL_ARMORY.y1 - exports.JAIL_T, width: exports.JAIL_ARMORY.gateX1 - exports.JAIL_ARMORY.gateX0, height: exports.JAIL_T },
];
/** Índice do vão do depósito em `JAIL_GATE_SLOTS` / `JailSystem.gates`. */
exports.JAIL_ARMORY_GATE = exports.JAIL_CELLS.length;
/**
 * Rondas do guarda: passa em frente à cela do jogador e volta para a mesa de serviço.
 * O primeiro ponto é perto demais da grade para ser acidente — é assim que se consegue
 * as chaves sem arma: ele vem conferir o preso e leva um soco através das barras.
 */
exports.JAIL_PATROL = [{ x: 1.8, y: 4.9 }, { x: 10, y: 9.2 }];
exports.JAIL_INMATES = [
    { cell: 1, char: 'a' }, { cell: 1, char: 'c' }, { cell: 2, char: 'a' },
    { cell: 3, char: 'c' }, { cell: 4, char: 'a' },
];
/** Caixa de caminhada de um preso dentro da própria cela. */
function jailCellWalk(index) {
    const c = exports.JAIL_CELLS[index];
    return { x0: c.x0 + 0.28, x1: c.x1 - 0.28, y0: exports.JAIL_FRONT_Y - 1.25, y1: exports.JAIL_FRONT_Y - 0.3 };
}
/**
 * Mobiliário da penitenciária. As grades (`bars`) são as únicas peças sem colisão
 * estática: quem abre e fecha a passagem é o `JailSystem`, senão a cela continuaria
 * trancada depois de destrancada.
 */
exports.JAIL_PIECES = [
    // Batentes de concreto e a grade de cada cela, na linha frontal.
    ...exports.JAIL_CELLS.map((c, i) => ({
        id: `front-${i}`, kind: 'block', x: c.x0, y: exports.JAIL_FRONT_Y, w: c.gateX0 - c.x0, d: exports.JAIL_T,
        height: 15, color: '#8d949b',
    })),
    ...exports.JAIL_CELLS.map((c, i) => ({
        id: `front-b-${i}`, kind: 'block', x: c.gateX1, y: exports.JAIL_FRONT_Y, w: c.x1 - c.gateX1, d: exports.JAIL_T,
        height: 15, color: '#8d949b',
    })),
    ...exports.JAIL_CELLS.slice(1).map((c, i) => ({
        id: `divider-${i}`, kind: 'block', x: c.x0 - exports.JAIL_T, y: exports.JAIL_T, w: exports.JAIL_T, d: exports.JAIL_FRONT_Y - exports.JAIL_T,
        height: 40, color: '#969ba1',
    })),
    ...exports.JAIL_CELLS.map((c, i) => ({
        id: `gate-${i}`, kind: 'bars', x: c.gateX0, y: exports.JAIL_FRONT_Y, w: c.gateX1 - c.gateX0, d: exports.JAIL_T,
        height: 40, color: '#4a5560',
    })),
    ...exports.JAIL_CELLS.map((c, i) => ({
        id: `cot-${i}`, kind: 'bed', x: c.x0 + 0.25, y: 0.6, w: 1.15, d: 1.75, height: 11, color: '#6d7a86',
    })),
    ...exports.JAIL_CELLS.map((c, i) => ({
        id: `bucket-${i}`, kind: 'stool', x: c.x1 - 0.72, y: 0.65, w: 0.45, d: 0.45, height: 9, color: '#5c666f',
    })),
    // Depósito de armas: jaula gradesada com o batente sul aberto para a grade.
    { id: 'arm-w', kind: 'block', x: exports.JAIL_ARMORY.x0, y: exports.JAIL_ARMORY.y0, w: exports.JAIL_T, d: exports.JAIL_ARMORY.y1 - exports.JAIL_ARMORY.y0, height: 40, color: '#969ba1' },
    { id: 'arm-e', kind: 'block', x: exports.JAIL_ARMORY.x1 - exports.JAIL_T, y: exports.JAIL_ARMORY.y0, w: exports.JAIL_T, d: exports.JAIL_ARMORY.y1 - exports.JAIL_ARMORY.y0, height: 40, color: '#969ba1' },
    { id: 'arm-n', kind: 'block', x: exports.JAIL_ARMORY.x0, y: exports.JAIL_ARMORY.y0, w: exports.JAIL_ARMORY.x1 - exports.JAIL_ARMORY.x0, d: exports.JAIL_T, height: 40, color: '#969ba1' },
    { id: 'arm-s-l', kind: 'block', x: exports.JAIL_ARMORY.x0, y: exports.JAIL_ARMORY.y1 - exports.JAIL_T, w: exports.JAIL_ARMORY.gateX0 - exports.JAIL_ARMORY.x0, d: exports.JAIL_T, height: 15, color: '#8d949b' },
    { id: 'arm-s-r', kind: 'block', x: exports.JAIL_ARMORY.gateX1, y: exports.JAIL_ARMORY.y1 - exports.JAIL_T, w: exports.JAIL_ARMORY.x1 - exports.JAIL_ARMORY.gateX1, d: exports.JAIL_T, height: 15, color: '#8d949b' },
    { id: `gate-${exports.JAIL_ARMORY_GATE}`, kind: 'bars', x: exports.JAIL_ARMORY.gateX0, y: exports.JAIL_ARMORY.y1 - exports.JAIL_T, w: exports.JAIL_ARMORY.gateX1 - exports.JAIL_ARMORY.gateX0, d: exports.JAIL_T, height: 40, color: '#4a5560' },
    { id: 'locker', kind: 'shelf', x: exports.JAIL_ARMORY.x0 + 0.3, y: exports.JAIL_ARMORY.y0 + 0.5, w: 1.1, d: 0.5, height: 36, color: '#4d5a67' },
    { id: 'ammo-crate', kind: 'crate', x: 2.7, y: 8.1, w: 0.8, d: 0.8, height: 17, color: '#6f7d4f' },
    // Pátio de dia: mesa de serviço, balcão de triagem, evidências e visita.
    { id: 'guard-desk', kind: 'desk', x: 12.6, y: 5.0, w: 1.3, d: 0.65, height: 15, color: '#7c6a52' },
    { id: 'intake', kind: 'counter', x: 6.4, y: 10.4, w: 2.4, d: 0.65, height: 20, color: '#6b737b' },
    { id: 'evidence', kind: 'shelf', x: faceLeste - 0.5, y: 4.9, w: 0.5, d: 1.7, height: 34, color: '#7a6a55' },
    { id: 'panel', kind: 'desk', x: 14.3, y: 6.15, w: 0.9, d: 0.7, height: 26, color: '#3f4a55' },
    { id: 'visitor-a', kind: 'chair', x: 8.2, y: 8.0, w: 0.5, d: 0.5, height: 13, color: '#5a6470' },
    { id: 'visitor-b', kind: 'chair', x: 9.4, y: 8.0, w: 0.5, d: 0.5, height: 13, color: '#5a6470' },
    { id: 'visiting-table', kind: 'table', x: 8.6, y: 8.6, w: 0.9, d: 0.9, height: 14, color: '#7d7161' },
];
