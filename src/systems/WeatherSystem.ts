import { GAME_CONFIG } from '../game/GameConfig';
import type { Biome } from '../game/GameConfig';

export type Season = 'primavera' | 'verao' | 'outono' | 'inverno';
export type WeatherKind = 'clear' | 'clouds' | 'rain' | 'storm' | 'snow';

const SEASONS: Season[] = ['primavera', 'verao', 'outono', 'inverno'];
const SEASON_NAME: Record<Season, string> = {
  primavera: 'Primavera', verao: 'Verão', outono: 'Outono', inverno: 'Inverno',
};
const KIND_NAME: Record<WeatherKind, string> = {
  clear: 'limpo', clouds: 'nublado', rain: 'chuva', storm: 'tempestade', snow: 'neve',
};
/** [nuvens, chuva, tempestade, neve]: chance de abrir cada frente numa checagem do relógio. */
const FRONT_CHANCE: Record<Season, [number, number, number, number]> = {
  primavera: [0.30, 0.22, 0.06, 0.02],
  verao: [0.24, 0.18, 0.16, 0],
  outono: [0.32, 0.24, 0.05, 0.02],
  inverno: [0.26, 0.12, 0.04, 0.30],
};
const FRONT_KINDS: WeatherKind[] = ['clouds', 'rain', 'storm', 'snow'];
/** Areia e praia não seguram neve, e a tempestade ali é pancada de vento, não raio. */
const WARM_BIOMES: readonly Biome[] = ['desert', 'savanna', 'beach', 'docks'];
/** Umidade (áudio + névoa molhada), cobertura de nuvem e inclinação máxima do vento. */
const WET: Record<WeatherKind, number> = { clear: 0, clouds: 0, rain: 0.8, storm: 1, snow: 0.55 };
const COVER: Record<WeatherKind, number> = { clear: 0, clouds: 0.45, rain: 0.6, storm: 0.85, snow: 0.5 };
const SLANT: Record<WeatherKind, number> = { clear: 0.06, clouds: 0.1, rain: 0.45, storm: 1, snow: 0.5 };

const ease = (from: number, to: number, step: number) =>
  from < to ? Math.min(to, from + step) : Math.max(to, from - step);

/**
 * Estações do ano e frentes de clima. A estação roda no relógio do mundo e só escolhe o
 * tipo de tempo; o bioma embaixo do player decide se aquilo pega (neve na areia não pega).
 * A intensidade (0..1) continua sendo o que a névoa, o tint e o som de chuva consomem.
 */
export class WeatherSystem {
  season: Season = 'primavera';
  /** Segundos decorridos da estação atual. */
  seasonTime = 0;
  kind: WeatherKind = 'clear';
  intensity = 0;
  /** 0..1 de céu coberto: escurece a cena sem molhar nada. */
  cover = 0;
  /** -1..1: para que lado a chuva e a neve caem. */
  wind = 0;
  private target = 0;
  private coverTarget = 0;
  private windTarget = 0;
  private frontLeft = 0;
  private checkTimer = GAME_CONFIG.WEATHER_CHECK_INTERVAL_S;
  private boltTimer = 0;
  private flash = 0;
  private thunderTimer = 0;

  constructor(private readonly onThunder: () => void = () => {}) {}

  get raining(): boolean { return this.kind === 'rain' || this.kind === 'storm'; }
  get snowing(): boolean { return this.kind === 'snow'; }
  /** Clarão visível: zero assim que a frente seca, senão o QA pisca em céu limpo. */
  get bolt(): number { return this.intensity > 0.02 ? this.flash : 0; }
  get label(): string { return `${SEASON_NAME[this.season]} · ${KIND_NAME[this.kind]}`; }

  update(dt: number, rng: () => number, biome: Biome) {
    if (!Number.isFinite(dt) || dt <= 0) return;

    this.seasonTime += dt;
    if (this.seasonTime >= GAME_CONFIG.SEASON_LENGTH_S) {
      this.seasonTime -= GAME_CONFIG.SEASON_LENGTH_S;
      this.season = SEASONS[(SEASONS.indexOf(this.season) + 1) % SEASONS.length];
    }

    this.checkTimer -= dt;
    if (this.checkTimer <= 0) {
      this.checkTimer = GAME_CONFIG.WEATHER_CHECK_INTERVAL_S;
      if (this.kind === 'clear') this.openFront(biome, rng);
    }
    if (this.kind !== 'clear') {
      this.frontLeft -= dt;
      if (this.frontLeft <= 0) this.enter('clear', rng);
    }

    const step = dt / GAME_CONFIG.WEATHER_FADE_S;
    this.intensity = ease(this.intensity, this.target, step);
    this.cover = ease(this.cover, this.coverTarget, step);
    this.wind = ease(this.wind, this.windTarget, dt * 0.25);

    if (this.kind === 'storm') {
      this.boltTimer -= dt;
      if (this.boltTimer <= 0) {
        this.boltTimer = 2.5 + rng() * 6.5;
        this.flash = 1;
        // O trovão chega depois do clarão; a distância vem justamente desse atraso.
        this.thunderTimer = 0.7 + rng() * 2.6;
      }
    }
    if (this.flash > 0) this.flash = Math.max(0, this.flash - dt * 3);
    if (this.thunderTimer > 0) {
      this.thunderTimer -= dt;
      if (this.thunderTimer <= 0) this.onThunder();
    }
  }

  /** Força uma frente (QA, missões, tornado): o resto do ciclo continua normal. */
  force(kind: WeatherKind, seconds = 60) {
    this.enter(kind, () => 0.5);
    this.frontLeft = seconds;
  }

  private openFront(biome: Biome, rng: () => number) {
    const chance = [...FRONT_CHANCE[this.season]];
    if (WARM_BIOMES.includes(biome)) {
      chance[3] = 0;
      chance[2] *= 0.5;
    }
    const roll = rng();
    let acc = 0;
    for (let i = 0; i < FRONT_KINDS.length; i++) {
      acc += chance[i];
      if (roll < acc) {
        this.enter(FRONT_KINDS[i], rng);
        return;
      }
    }
  }

  private enter(kind: WeatherKind, rng: () => number) {
    this.kind = kind;
    const strength = 0.65 + rng() * 0.35;
    this.target = WET[kind] * strength;
    this.coverTarget = COVER[kind];
    this.windTarget = (rng() * 2 - 1) * SLANT[kind];
    this.frontLeft = kind === 'clouds' ? 60 + rng() * 90 : kind === 'clear' ? 0 : 40 + rng() * 55;
    if (kind === 'storm') this.boltTimer = 1.5 + rng() * 3;
  }
}
