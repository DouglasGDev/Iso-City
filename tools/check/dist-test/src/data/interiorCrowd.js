"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.crowdRolesFor = crowdRolesFor;
/** Sala de estar e quarto: dois moradores, um em cada metade da casa. */
const HOME = [
    { role: 'resident', anchors: ['sofa', 'table'], char: 'a', kind: 'civ', roam: 1.05, speed: 0.5 },
    { role: 'resident', anchors: ['bed', 'desk'], char: 'b', kind: 'civ', roam: 0.85, speed: 0.45 },
];
/** Comércio: quem atende o caixa, quem faz a comida e quem está comprando. */
const SHOP = [
    { role: 'shopkeeper', anchors: ['counter'], char: 'b', kind: 'civ', roam: 0.3, speed: 0.32 },
    { role: 'cook', anchors: ['grill'], char: 'c', kind: 'civ', roam: 0.25, speed: 0.3 },
    { role: 'customer', anchors: ['table', 'booth', 'stool'], char: 'a', kind: 'civ', roam: 1.05, speed: 0.55 },
    { role: 'customer', anchors: ['shelf', 'rack', 'crate'], char: 'c', kind: 'civ', roam: 1.15, speed: 0.5 },
];
/** Escritório: a recepção e um funcionário circulando. */
const OFFICE = [
    { role: 'clerk', anchors: ['shelf', 'desk'], char: 'b', kind: 'civ', roam: 0.45, speed: 0.35 },
    { role: 'worker', anchors: ['desk', 'sofa', 'plant'], char: 'a', kind: 'civ', roam: 1.1, speed: 0.5 },
];
/**
 * Delegacia: o oficial de plantão no balcão, um segundo circulando entre as escrivanias
 * e o cidadão sentado à espera. É elenco de sala, não guarnição — quem persegue na rua é
 * o PoliceSystem, e ele não enxerga para dentro destas paredes.
 */
const PRECINCT = [
    { role: 'officer', anchors: ['counter'], char: 'a', kind: 'cop', roam: 0.3, speed: 0.32 },
    { role: 'officer', anchors: ['desk'], char: 'b', kind: 'cop', roam: 0.95, speed: 0.45 },
    { role: 'citizen', anchors: ['sofa', 'table'], char: 'c', kind: 'civ', roam: 0.75, speed: 0.4 },
];
/**
 * Elenco de uma sala. A cadeia fica de fora: lá o elenco é de presos e guarda, e quem
 * o manda é o `JailSystem`. O resto é a planta quem decide — um papel cuja base não
 * existe no layout (o cozinheiro sem cozinha, o cliente sem mesa) não é contratado.
 */
function crowdRolesFor(kind) {
    return kind === 'home' ? HOME : kind === 'office' ? OFFICE : kind === 'shop' ? SHOP
        : kind === 'precinct' ? PRECINCT : [];
}
