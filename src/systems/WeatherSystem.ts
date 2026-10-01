import { GAME_CONFIG } from '../game/GameConfig';
import type { Biome } from '../game/GameConfig';

export type Season = 'primavera' | 'verao' | 'outono' | 'inverno';
export type WeatherKind = 'clear' | 'mist' | 'clouds' | 'drizzle' | 'rain' | 'storm' | 'snow';

const SEASONS: Season[] = ['primavera', 'verao', 'outono', 'inverno'];
const SEASON_NAME: Record<Season, string> = {
  primavera: 'Primavera', verao: 'Verão', outono: 'Outono', inverno: 'Inverno',
};
const KIND_NAME: Record<WeatherKind, string> = {
  clear: 'limpo', mist: 'névoa', clouds: 'nublado', drizzle: 'garoa', rain: 'chuva',
  storm: 'tempestade', snow: 'neve',
};
/** Índice de cada frente dentro de `FRONT_CHANCE`, para ninguém mexer por posição. */
const COL: Record<Exclude<WeatherKind, 'clear'>, number> = {
  mist: 0, clouds: 1, drizzle: 2, rain: 3, storm: 4, snow: 5,
};
/**
 * [névoa, nublado, garoa, chuva, tempestade, neve]: chance de abrir cada frente numa
 * checagem do relógio; o resto da rolagem é céu limpo. A tempestade perdeu espaço para as
 * frentes comuns de propósito — o pedido é de menos espetáculo pronto e mais tempo virando
 * aos poucos.
 */
const FRONT_CHANCE: Record<Season, number[]> = {
  primavera: [0.12, 0.24, 0.16, 0.14, 0.05, 0.02],
  verao: [0.05, 0.22, 0.12, 0.14, 0.13, 0],
  outono: [0.15, 0.26, 0.16, 0.15, 0.04, 0.02],
  inverno: [0.16, 0.22, 0.09, 0.10, 0.03, 0.26],
};
const FRONT_KINDS: WeatherKind[] = ['mist', 'clouds', 'drizzle', 'rain', 'storm', 'snow'];
/**
 * A escada do tempo. Uma frente não pula para a tempestade: ela cresce um degrau por vez
 * enquanto vive, e quem ignorou a garoa se vê debaixo de chuva forte sem ter visto nada
 * mudar de uma hora para outra. `snow` e `storm` são becos — nevada e trovoada não crescem.
 */
const UP: Record<WeatherKind, WeatherKind | null> = {
  clear: null, mist: 'clouds', clouds: 'drizzle', drizzle: 'rain', rain: 'storm',
  snow: null, storm: null,
};
/** Chance de subir o degrau cada vez que a janela de crescimento vence. */
const UP_CHANCE: Record<WeatherKind, number> = {
  clear: 0, mist: 0.4, clouds: 0.45, drizzle: 0.5, rain: 0.22, snow: 0, storm: 0,
};
/** Vida de cada frente em segundos. A névoa e o nublado são longos; a trovoada passa rápido. */
const LIFE: Record<WeatherKind, [number, number]> = {
  clear: [0, 0], mist: [70, 160], clouds: [60, 150], drizzle: [50, 115],
  rain: [40, 95], storm: [35, 70], snow: [40, 95],
};
/** Areia e praia não seguram neve, e a tempestade ali é pancada de vento, não raio. */
const WARM_BIOMES: readonly Biome[] = ['desert', 'savanna', 'beach', 'docks'];
/** Umidade (áudio + névoa molhada), cobertura de nuvem e inclinação máxima do vento. */
const WET: Record<WeatherKind, number> = {
  clear: 0, mist: 0, clouds: 0, drizzle: 0.3, rain: 0.8, storm: 1, snow: 0.55,
};
const COVER: Record<WeatherKind, number> = {
  clear: 0, mist: 0.3, clouds: 0.45, drizzle: 0.55, rain: 0.6, storm: 0.85, snow: 0.5,
};
const SLANT: Record<WeatherKind, number> = {
  clear: 0.06, mist: 0.02, clouds: 0.1, drizzle: 0.18, rain: 0.45, storm: 1, snow: 0.5,
};
/**
 * O quanto cada frente esconde. Não é umidade — é a parede de névoa da tela fechando a
 * visibilidade. Só a névoa fecha mesmo; chuva e neve embaçam de leve, e é de propósito:
 * sem esta linha a frente de névoa seria um número invisível.
 */
const HIDE: Record<WeatherKind, number> = {
  clear: 0, mist: 1, clouds: 0, drizzle: 0.05, rain: 0.08, storm: 0.15, snow: 0.12,
};

const ease = (from: number, to: number, step: number) =>
  from < to ? Math.min(to, from + step) : Math.max(to, from - step);
/**
 * Toda rolagem passa por aqui. O `rng` do jogo é bom, mas QA, save corrompido e um frame com
 * NaN não podem entregar um número fora de 0..1: uma frente com força negativa faria a
 * umidade e a névoa andarem para trás.
 */
const sane = (v: number) => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.5);
const pick = (rng: () => number, range: readonly number[]) =>
  range[0] + sane(rng()) * (range[1] - range[0]);

/**
 * Estações do ano e frentes de clima. A estação roda no relógio do mundo e só escolhe o
 * tipo de tempo; o bioma embaixo do player decide se aquilo pega (neve na areia não pega).
 * A intensidade (0..1) continua sendo o que a névoa, o tint e o som de chuva consomem, e a
 * `mist` (0..1) é o que fecha a visibilidade sem molhar ninguém.
 */
export class WeatherSystem {
  season: Season = 'primavera';
  /** Segundos decorridos da estação atual. */
  seasonTime = 0;
  kind: WeatherKind = 'clear';
  intensity = 0;
  /** 0..1 de céu coberto: escurece a cena sem molhar nada. */
  cover = 0;
  /** 0..1 de névoa: é o quanto a visibilidade encolhe, não o quanto o chão molha. */
  mist = 0;
  /** -1..1: para que lado a chuva e a neve caem. */
  wind = 0;
  private target = 0;
  private coverTarget = 0;
  private mistTarget = 0;
  private windTarget = 0;
  private frontLeft = 0;
  /**
   * Segundos até a frente tentar crescer para o próximo degrau. `Infinity` é mando externo
   * (QA, roteiro): uma frente forçada não muda de natureza no meio do teste.
   */
  private escalateIn = Infinity;
  private checkTimer = GAME_CONFIG.WEATHER_CHECK_INTERVAL_S;
  private boltTimer = 0;
  private flash = 0;
  private thunderTimer = 0;

  constructor(private readonly onThunder: () => void = () => {}) {}

  get raining(): boolean {
    return this.kind === 'drizzle' || this.kind === 'rain' || this.kind === 'storm';
  }
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
      this.escalateIn -= dt;
      if (this.escalateIn <= 0) {
        this.escalateIn = pick(rng, GAME_CONFIG.WEATHER_ESCALATE_RETRY_S);
        this.grow(biome, rng);
      }
      if (this.frontLeft <= 0) this.enter('clear', rng);
    }

    const step = dt / GAME_CONFIG.WEATHER_FADE_S;
    this.intensity = ease(this.intensity, this.target, step);
    this.cover = ease(this.cover, this.coverTarget, step);
    this.mist = ease(this.mist, this.mistTarget, step);
    this.wind = ease(this.wind, this.windTarget, dt * 0.25);

    if (this.kind === 'storm') {
      this.boltTimer -= dt;
      if (this.boltTimer <= 0) {
        this.boltTimer = 2.5 + sane(rng()) * 6.5;
        this.flash = 1;
        // O trovão chega depois do clarão; a distância vem justamente desse atraso.
        this.thunderTimer = 0.7 + sane(rng()) * 2.6;
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
    // Mando externo não cresce: o teste que força "rain" tem que continuar vendo chuva.
    this.escalateIn = Infinity;
  }

  private openFront(biome: Biome, rng: () => number) {
    const chance = [...FRONT_CHANCE[this.season]];
    if (WARM_BIOMES.includes(biome)) {
      chance[COL.snow] = 0;
      chance[COL.storm] *= 0.5;
    }
    const roll = sane(rng());
    let acc = 0;
    for (let i = 0; i < FRONT_KINDS.length; i++) {
      acc += chance[i];
      if (roll < acc) {
        this.enter(FRONT_KINDS[i], rng);
        return;
      }
    }
  }

  /**
   * Um degrau acima, se a rolagem deixar. As duas correções vêm do chão quente: na garoa
   * gelada de inverno o próximo degrau é neve, e na areia a trovoada não pega raio.
   */
  private grow(biome: Biome, rng: () => number) {
    const from = this.kind;
    if (sane(rng()) >= UP_CHANCE[from]) return;
    let to = UP[from];
    if (!to) return;
    if (from === 'drizzle' && this.season === 'inverno' && !WARM_BIOMES.includes(biome)) to = 'snow';
    if (to === 'storm' && WARM_BIOMES.includes(biome)) to = 'rain';
    if (to === from) return;
    this.enter(to, rng);
  }

  private enter(kind: WeatherKind, rng: () => number) {
    this.kind = kind;
    const strength = 0.65 + sane(rng()) * 0.35;
    this.target = WET[kind] * strength;
    this.coverTarget = COVER[kind];
    this.mistTarget = HIDE[kind] * strength;
    this.windTarget = (sane(rng()) * 2 - 1) * SLANT[kind];
    this.frontLeft = kind === 'clear' ? 0 : pick(rng, LIFE[kind]);
    this.escalateIn = pick(rng, GAME_CONFIG.WEATHER_ESCALATE_FIRST_S);
    if (kind === 'storm') this.boltTimer = 1.5 + sane(rng()) * 3;
  }
}
