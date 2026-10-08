import type { GameState } from '../game/GameState';
import { GAME_CONFIG } from '../game/GameConfig';
import { createVehicle } from '../entities/Vehicle';
import { VEHICLE_DEFS } from '../data/vehicles';
import { GUN_IDS } from '../data/weapons';
import type { Season, WeatherKind } from './WeatherSystem';
import type { HazardKind } from './HazardSystem';

/**
 * A fileira do menu de cheat. `picker` roda um valor com ◄/► e só escreve no mundo no
 * confirmar; `ação` faz o efeito direto no confirmar. Cabeçalho de grupo não é fileira
 * navegável — a UI pinta, o navegador de menus pula.
 */
export type CheatRowId =
  | 'veiculo' | 'clima' | 'desastre' | 'estacao'
  | 'procurado' | 'limpar'
  | 'vida' | 'dinheiro' | 'invencivel' | 'armas';

export type CheatKind = 'picker' | 'acao';

export interface CheatRow {
  id: CheatRowId;
  group: string;
  kind: CheatKind;
  /** Texto vivo: um picker mostra o valor escolhido, uma ação mostra o estado atual. */
  label: (game: GameState) => string;
}

interface Opção<T> { value: T; name: string }

const VEÍCULOS: Opção<string>[] = [
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
const CLIMAS: Opção<WeatherKind>[] = [
  { value: 'clear', name: 'limpo' },
  { value: 'mist', name: 'névoa' },
  { value: 'clouds', name: 'nublado' },
  { value: 'drizzle', name: 'garoa' },
  { value: 'rain', name: 'chuva' },
  { value: 'storm', name: 'tempestade' },
  { value: 'snow', name: 'neve' },
];

// O primeiro item não é um desastre: é a ausência deles, para o cheat também saber limpar.
const DESASTRES: Opção<HazardKind | null>[] = [
  { value: null, name: 'nenhum' },
  { value: 'tornado', name: 'TORNADO' },
  { value: 'hurricane', name: 'FURACÃO' },
  { value: 'tsunami', name: 'TSUNAMI' },
];

const ESTAÇÕES: Opção<Season>[] = [
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
export class CheatSystem {
  private veículo = 0;
  private clima = 0;
  private desastre = 0;
  private estação = 0;
  private procurado = 0;

  readonly grupos: { header: string; ids: CheatRowId[] }[] = [
    { header: 'VEÍCULOS', ids: ['veiculo'] },
    { header: 'POLÍCIA', ids: ['procurado', 'limpar'] },
    { header: 'JOGADOR', ids: ['vida', 'dinheiro', 'invencivel', 'armas'] },
    { header: 'CLIMA', ids: ['clima', 'desastre', 'estacao'] },
  ];

  rows(): CheatRow[] {
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
  nudge(id: CheatRowId, dir: -1 | 1): void {
    const roda = (atual: number, tamanho: number) =>
      (atual + dir + tamanho * 4) % tamanho;
    if (id === 'veiculo') this.veículo = roda(this.veículo, VEÍCULOS.length);
    else if (id === 'clima') this.clima = roda(this.clima, CLIMAS.length);
    else if (id === 'desastre') this.desastre = roda(this.desastre, DESASTRES.length);
    else if (id === 'estacao') this.estação = roda(this.estação, ESTAÇÕES.length);
    else if (id === 'procurado') this.procurado = roda(this.procurado, GAME_CONFIG.WANTED_MAX + 1);
  }

  /** Escreve o efeito da fileira no mundo. É o único ponto que toca o `GameState`. */
  run(game: GameState, id: CheatRowId): void {
    const player = game.player;
    if (id === 'veiculo') {
      const def = VEHICLE_DEFS[VEÍCULOS[this.veículo].value];
      const novoId = game.vehicles.reduce((max, v) => Math.max(max, v.id + 1), 0);
      game.vehicles.push(createVehicle(
        novoId, def, def.colors[0] ?? '', player.x, player.y, player.direction,
      ));
      game.notifyEntityChange();
    } else if (id === 'procurado') {
      player.wantedLevel = this.procurado;
    } else if (id === 'limpar') {
      game.wanted.clear(player);
      this.procurado = 0;
    } else if (id === 'vida') {
      player.health = 100;
    } else if (id === 'dinheiro') {
      player.money += 50_000;
    } else if (id === 'invencivel') {
      player.invulnUntil = invencível(game) ? 0 : Infinity;
    } else if (id === 'armas') {
      for (const gun of GUN_IDS) game.weapons.acquire(gun);
    } else if (id === 'clima') {
      game.weather.force(CLIMAS[this.clima].value);
    } else if (id === 'desastre') {
      const kind = DESASTRES[this.desastre].value;
      if (kind) game.hazard.force(kind, MODO_DESASTRE);
      else limparDesastre(game);
    } else if (id === 'estacao') {
      game.weather.season = ESTAÇÕES[this.estação].value;
    }
  }
}

function invencível(game: GameState): boolean {
  return game.player.invulnUntil > game.time;
}

/** O desastre tem campo público em `HazardSystem`: sem método de limpar, volta ao calmo. */
function limparDesastre(game: GameState): void {
  game.hazard.kind = null;
  game.hazard.phase = 'calm';
  game.hazard.strength = 0;
}
