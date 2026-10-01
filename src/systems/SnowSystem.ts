import { GAME_CONFIG } from '../game/GameConfig';
import type { Biome, TileKind } from '../game/GameConfig';
import type { WeatherKind } from './WeatherSystem';

/**
 * Areia, savana, praia e cais não seguram neve: o floco derrete ao tocar o chão quente.
 * É o avesso exato da regra do `WeatherSystem`, que impede a frente de neve de NASCER
 * nesses biomas — aqui é o que já caiu indo embora.
 */
const CHAO_QUENTE: readonly Biome[] = ['desert', 'savanna', 'beach', 'docks'];
/**
 * Quanto do acumulado cada superfície segura. Asfalto escorre e evapora no próprio calor,
 * terra e mato seguram, e a água não branqueia nunca: neve no rio vira água, não vira
 * placa branca.
 */
const RETENCAO: Record<TileKind, number> = {
  grass: 1, dirt: 0.9, concrete: 0.5, road: 0.3, water: 0,
};
/** Cota alta segura a neve que o pé do morro já perdeu: a linha de neve desce pela encosta. */
const GANHO_POR_COTA = 0.22;
const GANHO_MAX = 0.6;
/**
 * Só acima disto o chão começa a branquear. Sem limiar, um único floco caindo mancha a
 * cidade inteira e a neve deixa de ser um evento.
 */
const LIMIAR = 0.08;
/** Largura da rampa entre o primeiro branco e a placa fechada. */
const RAMP = 0.55;
/** Chuva não é só ausência de neve: ela derrete o que já caiu, e derrete rápido. */
const CHUVA_DERRETE = 5;
/**
 * A garoa é água mesma, só que fina: derrete a metade da força de uma chuva. Névoa e nublado
 * não derretrem nada além do degelo natural.
 */
const DEGELO: Partial<Record<WeatherKind, number>> = {
  drizzle: CHUVA_DERRETE * 0.5, rain: CHUVA_DERRETE, storm: CHUVA_DERRETE,
};

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * A neve que FICA no chão.
 *
 * O `WeatherSystem` decide se está nevando agora; esta classe cuida do que aquilo deixa
 * depois. É um único acumulado do mundo (0..1) porque neve não some do mapa inteiro no
 * instante em que o sol volta: a frente passa, o céu limpa, e a serra continua branca por
 * um dia e meio de jogo. O que dá forma ao branco é a leitura por tile — `cobertura`
 * responde ao chão que tem embaixo (areia não segura, asfalto escorre, mato segura) e à
 * cota, então a neve desce morro abaixo ao derreter em vez de sumir de uma vez.
 *
 * Não há campo por tile a integrar: o acumulado é um número e o resto é função do tile,
 * calculada só na janela da neblina. Custa zero no tick e o degelo continua parecendo
 * paisagem porque cada superfície tem a própria resposta ao mesmo acumulado.
 */
export class SnowSystem {
  /** Neve acumulada no chão do mundo inteiro, 0..1. */
  depth = 0;

  update(dt: number, kind: WeatherKind, intensity: number) {
    if (!Number.isFinite(dt) || dt <= 0) return;
    if (kind === 'snow') {
      // Nevada forte deita neve mais rápido que o fio fraco que abre a frente.
      const forca = 0.4 + 0.6 * clamp01(intensity);
      this.depth = clamp01(this.depth + (dt * forca) / GAME_CONFIG.SNOW_ACCUMULATE_S);
      return;
    }
    const degelo = DEGELO[kind] ?? 1;
    this.depth = clamp01(this.depth - (dt * degelo) / GAME_CONFIG.SNOW_MELT_S);
  }

  /**
   * Fração de neve no chão daquele tile, na mesma escala 0..1 que o render veste. Zero é
   * chão seco e 1 é placa fechada; o meio da rampa é o que faz a borda da neve ser mancha,
   * não contorno.
   */
  cobertura(altura: number, biome: Biome, kind: TileKind): number {
    const retenc = RETENCAO[kind];
    if (retenc <= 0 || CHAO_QUENTE.includes(biome)) return 0;
    const peso = retenc * (1 + Math.min(GANHO_MAX, Math.max(0, altura) * GANHO_POR_COTA));
    const v = this.depth * peso - LIMIAR;
    return v <= 0 ? 0 : Math.min(1, v / RAMP);
  }

  /** Nível quantizado: é o que chama o rebake do chão quando a neve cresce parado. */
  get nivel(): number { return Math.round(this.depth * 16); }
}
