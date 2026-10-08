"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CheatSystem = void 0;
const GameConfig_1 = require("../game/GameConfig");
const Vehicle_1 = require("../entities/Vehicle");
const vehicles_1 = require("../data/vehicles");
const weapons_1 = require("../data/weapons");
const VEÍCULOS = [
    { value: 'sedan', name: 'Sedã' },
    { value: 'taxi', name: 'Táxi' },
    { value: 'hatchback', name: 'Hatch' },
    { value: 'pickup', name: 'Picape' },
    { value: 'van', name: 'Van' },
    { value: 'truck', name: 'Caminhão' },
    { value: 'ambulance', name: 'Ambulância' },
    { value: 'police', name: 'Viatura' },
    { value: 'swat', name: 'SWAT' },
    { value: 'firetruck', name: 'Bombeiro' },
    { value: 'bus_school', name: 'Ônibus' },
    { value: 'garbage', name: 'Coletor' },
    { value: 'helicopter', name: 'Helicóptero' },
];
// A ordem é a escada do tempo: do sol aberto até a nevasca, passando pelas frentes.
const CLIMAS = [
    { value: 'clear', name: 'limpo' },
    { value: 'mist', name: 'névoa' },
    { value: 'clouds', name: 'nublado' },
    { value: 'drizzle', name: 'garoa' },
    { value: 'rain', name: 'chuva' },
    { value: 'storm', name: 'tempestade' },
    { value: 'snow', name: 'neve' },
];
// O primeiro item não é um desastre: é a ausência deles, para o cheat também saber limpar.
const DESASTRES = [
    { value: null, name: 'nenhum' },
    { value: 'tornado', name: 'TORNADO' },
    { value: 'hurricane', name: 'FURACÃO' },
    { value: 'tsunami', name: 'TSUNAMI' },
];
const ESTAÇÕES = [
    { value: 'primavera', name: 'Primavera' },
    { value: 'verao', name: 'Verão' },
    { value: 'outono', name: 'Outono' },
    { value: 'inverno', name: 'Inverno' },
];
const MODO_DESASTRE = 120;
/**
 * Catálogo de trapaças sob demanda. Não conhece React nem a tela: guarda só a seleção de
 * cada picker e escreve no `GameState` que recebe — por isso dá para provar cada cheat em
 * memória sem navegador, e a HUD é apenas uma leitura viva de `rows`.
 */
class CheatSystem {
    constructor() {
        this.veículo = 0;
        this.clima = 0;
        this.desastre = 0;
        this.estação = 0;
        this.procurado = 0;
        this.grupos = [
            { header: 'VEÍCULOS', ids: ['veiculo'] },
            { header: 'POLÍCIA', ids: ['procurado', 'limpar'] },
            { header: 'JOGADOR', ids: ['vida', 'dinheiro', 'invencivel', 'armas'] },
            { header: 'CLIMA', ids: ['clima', 'desastre', 'estacao'] },
        ];
    }
    rows() {
        return [
            {
                id: 'veiculo', group: 'VEÍCULOS', kind: 'picker',
                label: () => `Carro: ${VEÍCULOS[this.veículo].name}`,
            },
            {
                id: 'procurado', group: 'POLÍCIA', kind: 'picker',
                label: () => `Procurado: ${'★'.repeat(this.procurado) || 'nenhum'}`,
            },
            {
                id: 'limpar', group: 'POLÍCIA', kind: 'acao',
                label: () => 'Limpar procurado',
            },
            {
                id: 'vida', group: 'JOGADOR', kind: 'acao',
                label: () => 'Vida cheia',
            },
            {
                id: 'dinheiro', group: 'JOGADOR', kind: 'acao',
                label: () => 'Mais $50.000',
            },
            {
                id: 'invencivel', group: 'JOGADOR', kind: 'acao',
                label: (game) => `Invencível: ${invencível(game) ? 'LIGADO' : 'desligado'}`,
            },
            {
                id: 'armas', group: 'JOGADOR', kind: 'acao',
                label: () => 'Todas as armas',
            },
            {
                id: 'clima', group: 'CLIMA', kind: 'picker',
                label: () => `Clima: ${CLIMAS[this.clima].name}`,
            },
            {
                id: 'desastre', group: 'CLIMA', kind: 'picker',
                label: () => `Desastre: ${DESASTRES[this.desastre].name}`,
            },
            {
                id: 'estacao', group: 'CLIMA', kind: 'picker',
                label: () => `Estação: ${ESTAÇÕES[this.estação].name}`,
            },
        ];
    }
    /** ◄/► numa fileira picker: muda só a seleção, nunca escreve no mundo antes do confirmar. */
    nudge(id, dir) {
        const roda = (atual, tamanho) => (atual + dir + tamanho * 4) % tamanho;
        if (id === 'veiculo')
            this.veículo = roda(this.veículo, VEÍCULOS.length);
        else if (id === 'clima')
            this.clima = roda(this.clima, CLIMAS.length);
        else if (id === 'desastre')
            this.desastre = roda(this.desastre, DESASTRES.length);
        else if (id === 'estacao')
            this.estação = roda(this.estação, ESTAÇÕES.length);
        else if (id === 'procurado')
            this.procurado = roda(this.procurado, GameConfig_1.GAME_CONFIG.WANTED_MAX + 1);
    }
    /** Escreve o efeito da fileira no mundo. É o único ponto que toca o `GameState`. */
    run(game, id) {
        const player = game.player;
        if (id === 'veiculo') {
            const def = vehicles_1.VEHICLE_DEFS[VEÍCULOS[this.veículo].value];
            const novoId = game.vehicles.reduce((max, v) => Math.max(max, v.id + 1), 0);
            game.vehicles.push((0, Vehicle_1.createVehicle)(novoId, def, def.colors[0] ?? '', player.x, player.y, player.direction));
            game.notifyEntityChange();
        }
        else if (id === 'procurado') {
            player.wantedLevel = this.procurado;
        }
        else if (id === 'limpar') {
            game.wanted.clear(player);
            this.procurado = 0;
        }
        else if (id === 'vida') {
            player.health = 100;
        }
        else if (id === 'dinheiro') {
            player.money += 50000;
        }
        else if (id === 'invencivel') {
            player.invulnUntil = invencível(game) ? 0 : Infinity;
        }
        else if (id === 'armas') {
            for (const gun of weapons_1.GUN_IDS)
                game.weapons.acquire(gun);
        }
        else if (id === 'clima') {
            game.weather.force(CLIMAS[this.clima].value);
        }
        else if (id === 'desastre') {
            const kind = DESASTRES[this.desastre].value;
            if (kind)
                game.hazard.force(kind, MODO_DESASTRE);
            else
                limparDesastre(game);
        }
        else if (id === 'estacao') {
            game.weather.season = ESTAÇÕES[this.estação].value;
        }
    }
}
exports.CheatSystem = CheatSystem;
function invencível(game) {
    return game.player.invulnUntil > game.time;
}
/** O desastre tem campo público em `HazardSystem`: sem método de limpar, volta ao calmo. */
function limparDesastre(game) {
    game.hazard.kind = null;
    game.hazard.phase = 'calm';
    game.hazard.strength = 0;
}
