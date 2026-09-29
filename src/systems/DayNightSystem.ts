import { GAME_CONFIG } from '../game/GameConfig';

/**
 * Relógio do mundo: 0 = meia-noite, 0.5 = meio-dia. Expõe opacidades de tint
 * (noite azulada + alaranjado do amanhecer/entardecer) para o render.
 */
export class DayNightSystem {
  t: number;

  constructor() {
    this.t = GAME_CONFIG.DAY_START_T;
  }

  update(dt: number) {
    this.t = (this.t + dt / GAME_CONFIG.DAY_NIGHT_CYCLE_S) % 1;
  }

  /** alpha do tint noturno (0 dia, 1 noite fechada) */
  get nightAlpha(): number {
    const t = this.t;
    if (t < 0.2 || t > 0.86) return 1;
    if (t < 0.3) return 1 - (t - 0.2) / 0.1;
    if (t < 0.72) return 0;
    if (t < 0.86) return (t - 0.72) / 0.14;
    return 0;
  }

  /** alpha do tint laranja do crepúsculo/amanhecer */
  get warmAlpha(): number {
    const t = this.t;
    if (t >= 0.2 && t < 0.34) return 1 - Math.abs(t - 0.27) / 0.07;
    if (t >= 0.72 && t < 0.88) return 1 - Math.abs(t - 0.8) / 0.08;
    return 0;
  }

  get isNight(): boolean {
    return this.nightAlpha > 0.55;
  }

  get tintAlpha(): number {
    return this.nightAlpha * GAME_CONFIG.NIGHT_TINT_MAX;
  }

  /** "HH:MM" no relógio do jogo */
  get clock(): string {
    const mins = Math.floor(this.t * 24 * 60);
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }
}
