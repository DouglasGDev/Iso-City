import { GAME_CONFIG } from '../game/GameConfig';
import type { SkySnapshot } from './AltitudeSystem';

/**
 * O que se ouve dentro da coluna de ar.
 *
 * Até aqui o voo alto era mudo de um jeito que nenhum outro canto do jogo é: o casco tinha o loop
 * genérico do motor, o vento do clima continuava tocando como se você estivesse na calçada, e
 * atravessar a linha de nuvem não fazia nem um decibel de diferença. Som é o sentido que mais
 * cedo denuncia um efeito em vez de um fenômeno — a tela pode mentir por um quadro, o ouvido não.
 *
 * Este sistema não manda em nada: recebe o instantâneo da coluna, mais duas verdades que só o
 * piloto tem (está no comando? está ao ar livre?), e devolve dois volumes. O laço de simulação é
 * quem tem a cota, o vento e a nuvem; o ouvido é só leitura.
 *
 * Dois leitos, e cada um responde a uma coisa diferente:
 *
 *  · `rotor` é o corte das pás DO CASCO que você pilota. O apoio aéreo da polícia já tinha um
 *    one-shot de 1 s atirado por distância — serve para um aparelho que passa. Um aparelho que
 *    você comanda não passa: fica, e precisa de leito próprio, contínuo, com volume. Ele carrega
 *    a subida (passo come mais ar), emagrece no teto (o ar rarefeito não iça nada) e amolece
 *    dentro da nuvem (pás molhadas não cortam seco).
 *
 *  · `ar` é o sopro passando por cima da lataria, e é a única camada que existe PORQUE você subiu:
 *    na rua vale zero de propósito, para não brigar com o leito da região — que é de outro dono e
 *    não se toca aqui. Cresce com a altura, com o vento da frente e com o próprio curso do casco,
 *    e engrossa no meio do algodão: aquele chiado é o som de atravessar a manta.
 */

export interface AltitudeAudioContext {
  /** No comando de um helicóptero com o motor vivo. Fora disso não há pá nenhuma para ouvir. */
  pilotando: boolean;
  /** tiles/s do casco no plano: é o vento relativo que o ar sente mesmo com o aparelho parado. */
  velocidade: number;
  /** Dentro de casa o casco não existe: a sala tem o próprio leito e a própria acústica. */
  aoArLivre: boolean;
  /** O instantâneo da coluna: cota, nuvem, vento e o quanto do ar ainda iça. */
  ar: SkySnapshot;
}

export interface AltitudeAudioOutput {
  rotor(volume: number): void;
  ar(volume: number): void;
}

/** Pedidos quantizados: um por quadro ao canal nativo afogaria a ponte por uma diferença inaudível. */
const DEGRAU = 50;
const quantiza = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * DEGRAU) / DEGRAU;

function rampa(v: number, teto: number) {
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v / teto)) : 0;
}

export class AltitudeAudioSystem {
  private rotor = 0;
  private sopro = 0;
  private enviadoRotor = -1;
  private enviadoAr = -1;
  /** A subida não vem no instantâneo: ela é a diferença da cota entre duas amostras. */
  private subida = 0;
  private cota: number | null = null;

  constructor(private output: AltitudeAudioOutput) {}

  get noAr() { return this.rotor > 0.02; }

  update(dt: number, ctx: AltitudeAudioContext): void {
    if (!Number.isFinite(dt) || dt <= 0) return;
    const ar = ctx.ar;
    const cota = Number.isFinite(ar.cota) ? ar.cota : 0;
    const cru = this.cota === null ? 0 : (cota - this.cota) / dt;
    this.cota = cota;
    // 4 por segundo: uma diferença de cota é ruído puro num laço de 60 Hz, e o que se ouve aqui é
    // a TREND de subida, não o degrau do quadro.
    this.subida += (cru - this.subida) * Math.min(1, dt * 4);

    const vivo = ctx.pilotando && ctx.aoArLivre;
    const vento = rampa(Math.hypot(ar.ventoX, ar.ventoY), GAME_CONFIG.VENTO_MAX);
    const altura = 1 - ar.cidade;
    const curso = rampa(ctx.velocidade, GAME_CONFIG.HELI_MAX_SPEED);

    // O passo engole mais ar quanto mais o piloto cobra dele, e é a subida — não o curso — que
    // faz o rotor de verdade mudar de voz. No teto o contrário: com o ar rarefeito a pá morde
    // vazio, e o corte emagrece exatamente quando o manche já não responde mais.
    const carga = rampa(Math.abs(this.subida), GAME_CONFIG.HELI_CLIMB_RATE);
    const alvoRotor = vivo
      ? (0.30 + carga * 0.20 + curso * 0.06 + vento * 0.05) * (1 - ar.rarefeito * 0.4)
        * (1 - ar.dentro * 0.22)
      : 0;
    // O sopro é a camada da altitude: zero no voo raso para não duplicar o leito da região, e o
    // chiado molhado do algodão passando pela lataria quando o casco está dentro dele.
    const alvoAr = ctx.aoArLivre
      ? altura * (0.22 + vento * 0.34 + curso * 0.24) + ar.dentro * 0.2 + ar.bruma * altura * 0.12
      : 0;

    // Subida rápida, descida mais rápida ainda: o ouvido espera o ar chegar quando o aparelho
    // mergulha, e um fade lento faria o mergulho chegar mudo.
    this.rotor += limita(alvoRotor - this.rotor, dt * (alvoRotor > this.rotor ? 1.6 : 2.6));
    this.sopro += limita(alvoAr - this.sopro, dt * (alvoAr > this.sopro ? 0.9 : 1.4));
    this.publica();
  }

  /** Menu, pausa, sala: o laço congela e nenhum leito pode continuar andando sozinho. */
  suspend(): void {
    this.rotor = 0;
    this.sopro = 0;
    this.subida = 0;
    this.cota = null;
    this.publica();
  }

  private publica(): void {
    const rotor = quantiza(this.rotor);
    const ar = quantiza(this.sopro);
    if (rotor !== this.enviadoRotor) {
      this.enviadoRotor = rotor;
      this.output.rotor(rotor);
    }
    if (ar !== this.enviadoAr) {
      this.enviadoAr = ar;
      this.output.ar(ar);
    }
  }
}

function limita(d: number, passo: number) {
  return Math.max(-passo, Math.min(passo, d));
}
