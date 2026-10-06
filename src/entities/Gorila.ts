import type { Dir4 } from '../game/GameConfig';

/**
 * O gorila da fronteira.
 *
 * A mata sem fim não é um cenário de fundo: ela é território de alguma coisa. O pedido foi
 * explícito — "vir um gorila gigante e matar" — e o que faz esse tipo de evento funcionar
 * num mundo aberto não é o bicho em si, é a *regra* por trás dele: quanto mais longe da
 * cidade você insiste em ficar, mais a terra cobra. Um gorila que aparece porque sim é um
 * susto de um quadro; um que acorda conforme a sua profundidade, que nasce SEMPRE mais fundo
 * do que você (correr para fora não escapa), que não pisa o asfalto (voltar para dentro
 * salva) e que fica mais rápido e mais furioso a cada tiro que você acerta, esse é mecânica.
 *
 * Ele mora separado do `Animal` do `WildlifeSystem` por um motivo que não é organização: o
 * rebanho é um mecanismo de habitat, com clamps de grade, reserva de nascimento, fuga e
 * repovoamento por tile de mapa. Nada disso existe na fronteira — lá não há `data.tiles`,
 * não há bioma, não há "casa". O que existe lá é exatamente aquilo que a fronteira é: um
 * corpo que anda sobre uma função da coordenada. Um mecanismo por classe, inclusive no
 * modelo.
 */

/**
 * `adormecido` não é um estado do corpo — é a ausência dele: quem descreve o sono é o
 * `GorilaSystem` com `fera === null`. Os demais são as fases da caçada, e cada transição é
 * uma decisão de design documentada no sistema, não um `if` de conveniência.
 */
export type GorilaEstado = 'espreitando' | 'cacando' | 'batendo' | 'retirando' | 'morto';

/** Raio do corpo em tiles. Meio tile seria um homem; isto é um dorsípede de dois metros. */
export const GORILA_RAIO = 0.9;
/**
 * Vida. 720 é ~9 tiros de rifle e ~180 socos: o jogador pode vencer, mas só se estiver
 * armado, mirar e não tiver medo de levar um soco no meio — o pedido foi "matar", não
 * "ser um chefe de missa". Abaixo disso a fronteira seria um treino de tiro.
 */
export const GORILA_VIDA = 720;
/** Dano de um soco. Três deles fecham um personagem com 100 de vida. */
export const GORILA_DANO_SOCO = 34;
/** Distância de contato, já contando o braço: o golpe não exige sobreposição de corpos. */
export const GORILA_ALCANCE_SOCO = 2.1;
/** Cadência do braço: 1,15 s entre marteladas. Mais rápido que isso vira tela de carregamento. */
export const GORILA_CADENCIA = 1.15;
/**
 * Quanto o punho fica embaixo depois de bater. É a janela do quadro de impacto, e ela existe
 * porque o sistema aplica o dano e devolve o corpo para a marcha no MESMO tick: sem uma janela
 * lida do cooldown, o golpe nunca era desenhado — o jogador via o braço subir e, no instante de
 * levar o dano, o gigante já estava andando de novo.
 */
export const GORILA_IMPACTO_S = 0.18;
/** Altura do windup visível (braço no alto) — o jogador tem de VER o golpe chegando. */
export const GORILA_WINDUP = 0.22;
/**
 * A batida de peito do aviso: o ciclo completo e o tempo em que o punho está colado no tórax.
 * Mora aqui e não dentro do `GorilaSystem` porque é o mesmo número que o sprite lê para escolher
 * o gesto — dois relógios separados fariam o tremor chegar num quadro e o punho no outro.
 */
export const PEITO_CICLO = 1.1;
export const PEITO_BATIDA = 0.3;
/** Queda do corpo, sumiço do cadáver e fade, separados de propósito: um gigante cai devagar. */
export const GORILA_QUEDA_S = 1.2;
export const GORILA_CADAVER_S = 24;
export const GORILA_FADE_S = 4;
/** A cada tile percorrido, um passo que se sente. Não é animação: é a régua do tremor. */
export const GORILA_PASSO_TILES = 1.35;

export interface Gorila {
  /** Um só indivíduo por mundo; o id existe para o render ter uma chave estável. */
  readonly id: number;
  x: number;
  y: number;
  dir: Dir4;
  estado: GorilaEstado;
  vida: number;
  readonly raio: number;
  /** Velocidade real do último tick: é o que o render usa para decidir se ele caminha. */
  velocidade: number;
  morto: boolean;
  /** Segundos desde a morte, -1 enquanto vivo. */
  deathTimer: number;
  /** Segundos de movimento efetivo perto da câmera. */
  animTime: number;
  /** Cooldown do braço, em segundos de simulação. */
  golpe: number;
  /**
   * Relógio da batida de peito do aviso, em contagem regressiva. É do corpo e não do sistema
   * porque o gesto desenhado e o tremor ouvido têm de nascer do mesmo número, no mesmo tick.
   */
  peito: number;
  /** Windup em curso: quando zerar, o soco acontece. */
  espera: number;
  /** Fração de percurso até o próximo passo sentido. */
  passo: number;
  /**
   * Cópia do rancor do mundo no instante em que este indivíduo nasceu. É ela, e não o
   * rancor global, que dita a velocidade e a fúria dele: um bicho que acordou porque você
   * passou dez minutos na mata velha tem de ser mais rápido que um que acordou por descuido,
   * e tem de continuar o mesmo depois que você voltar para a cidade.
   */
  rancor: number;
}

export function criaGorila(x: number, y: number, rancor: number): Gorila {
  return {
    id: 1, x, y, dir: 'SE', estado: 'espreitando', vida: GORILA_VIDA, raio: GORILA_RAIO,
    velocidade: 0, morto: false, deathTimer: -1, animTime: 0,
    golpe: 0, peito: PEITO_CICLO * 0.45, espera: 0, passo: 0, rancor,
  };
}

/**
 * Aplica dano ao corpo. Devolve `true` só no primeiro golpe letal, como `damage` do `Animal`:
 * quem chama precisa saber quando a vida acabou para tratar o cadáver uma única vez.
 *
 * Ferido, ele NÃO foge — é essa a diferença entre uma presa e um predador. Um bicho de duas
 * toneladas que leva um tiro e sai correndo seria piada; aqui o tiro aumenta o rancor dele,
 * e é isso que ensina ao jogador a lição que a fronteira inteira ensina: atirar não faz a
 * coisa ir embora, faz a coisa vir mais rápido.
 */
export function fereGorila(gorila: Gorila, amount: number): boolean {
  if (gorila.morto || !Number.isFinite(amount) || amount <= 0) return false;
  gorila.vida = Math.max(0, gorila.vida - amount);
  gorila.rancor = Math.min(2.4, gorila.rancor + 0.18);
  if (gorila.vida > 0) {
    if (gorila.estado === 'retirando' || gorila.estado === 'espreitando') gorila.estado = 'cacando';
    return false;
  }
  gorila.morto = true;
  gorila.estado = 'morto';
  gorila.deathTimer = 0;
  gorila.velocidade = 0;
  return true;
}

/**
 * Instantâneo imutável para a UI thread — o mesmo contrato do `animalVisualState`: um worklet
 * não pode capturar o corpo mutável, então a pose nasce de um objeto novo por tick.
 */
export interface GorilaVisualState {
  dir: Dir4;
  estado: GorilaEstado;
  velocidade: number;
  morto: boolean;
  deathTimer: number;
  /** Windup no instante da publicação: o braço sobe na tela, não no motor. */
  esperando: boolean;
  /**
   * Cooldown do braço publicado junto: é o que permite ao sprite desenhar o punho embaixo no
   * instante em que o dano cai, já que o sistema devolve o corpo à marcha nesse mesmo tick.
   */
  golpe: number;
  /** Relógio da batida de peito, para o gesto do aviso acontecer no quadro do tremor. */
  peito: number;
  animTime: number;
  sampledAt: number;
}

export function gorilaVisualState(gorila: Gorila, clock: number): GorilaVisualState {
  return {
    dir: gorila.dir, estado: gorila.estado, velocidade: gorila.velocidade, morto: gorila.morto,
    deathTimer: gorila.deathTimer, esperando: gorila.estado === 'batendo' && gorila.espera > 0,
    golpe: gorila.golpe, peito: gorila.peito,
    animTime: gorila.animTime, sampledAt: clock,
  };
}

/**
 * Pose do sprite. Mesma forma da pose dos animais (frame/mirror/away/bob + curva de queda), mas
 * com os quadros que a fauna não tem: o braço no alto do windup, o punho embaixo no instante do
 * impacto, e os dois gestos separados da batida de peito de quem está avisando, não atacando.
 *
 * É `'worklet'` porque roda na UI thread dentro do `useDerivedValue` do sprite.
 */
export function gorilaPose(visual: GorilaVisualState, clock: number) {
  'worklet';
  // Interpola no máximo 0,1 s entre publicações, exatamente como o bicho pequeno: nunca
  // inventar tempo de morte para um corpo que o mundo parou de simular.
  const decorrido = visual.deathTimer + (visual.morto ? Math.max(0, Math.min(0.1, clock - visual.sampledAt)) : 0);
  const progress = visual.morto ? Math.min(1, decorrido / GORILA_QUEDA_S) : 0;
  const queda = progress * progress * (3 - 2 * progress);
  const lado = visual.dir === 'SE' || visual.dir === 'NE' ? 1 : -1;
  const andando = !visual.morto && (visual.estado === 'cacando' || visual.estado === 'retirando')
    && visual.velocidade > 0.01;
  const correndo = visual.estado === 'cacando';
  const windup = !visual.morto && (visual.estado === 'batendo' || visual.esperando);
  // O impacto não é um estado: é uma janela lida do cooldown do braço. O sistema aplica o dano e
  // devolve o corpo à marcha no mesmo tick, então sem esta janela o punho embaixo nunca chegava
  // à tela — o jogador via o braço subir e, no instante de levar o dano, já era tarde.
  const impacto = !visual.morto && !windup
    && visual.golpe > GORILA_CADENCIA - GORILA_IMPACTO_S;
  // A passada é uma fase contínua em 0..4 e o quadro é o piso dela. É a mesma régua que o `bob`
  // usa logo abaixo: quadro e altura do corpo têm de vir do mesmo número, ou o gigante sobe no
  // quadro errado e parece estar flutuando.
  const ritmo = correndo ? 6.5 : 3.5;
  const fase = (visual.animTime * ritmo) % 4;
  const aviso = visual.estado === 'espreitando';
  // 0 parado, 1..4 marcha, 5 windup, 7 o golpe chegando ao chão, 6 o punho no peito e 8 os
  // punhos armados. A cadência é mais lenta que a de um cervo porque a passada é mais longa: um
  // gigante corre em frames largos, não em tremor.
  const frame = visual.morto ? 0
    : impacto ? 7
      : windup ? 5
        : andando ? 1 + (Math.floor(fase) % 4)
          : aviso ? (visual.peito >= PEITO_CICLO - PEITO_BATIDA ? 6 : 8)
            : 0;
  // O centro de massa sobe na passada e afunda no apoio, senoidal e na MESMA fase do quadro. O
  // bob antigo era binário (-2/-3 px só nos quadros de contato): o corpo pulava de altura em vez
  // de rolar sobre o braço, que é exatamente como um dorsípede anda.
  const apoio = Math.abs(Math.sin(Math.PI * fase / 2));
  const respirando = !andando && !windup && !impacto && !visual.morto;
  const bob = andando ? -apoio * (correndo ? 3.4 : 2)
    : respirando ? Math.sin(clock * 1.5) * 1.1 - 0.55 : 0;
  // A queda: gira até o chão em três quartos do tempo, e no resto o corpo ainda quica uma vez.
  // Um gigante de duas toneladas que apenas tomba linearmente parece de papel; o que pesa é o
  // tranco depois de encostar.
  const tomba = Math.min(1, progress / 0.68);
  const giro = tomba * tomba * (3 - 2 * tomba);
  const quica = progress > 0.68
    ? Math.abs(Math.sin((progress - 0.68) * 9.4)) * (1 - progress) * 13 : 0;
  return {
    rotation: lado * 1.45 * giro,
    // Encolher 58% no eixo Y era o que fazia o corpo derreter em vez de deitar: em isométrico,
    // um dorsípede esticado no chão mantém a altura do dorso e perde só a perspectiva da massa.
    scaleY: 1 - 0.2 * giro,
    offsetY: 4 * giro - quica,
    alpha: visual.morto ? Math.max(0, Math.min(1, (GORILA_CADAVER_S - decorrido) / GORILA_FADE_S)) : 1,
    frame,
    mirror: visual.dir === 'SW' || visual.dir === 'NW' ? -1 : 1,
    away: visual.dir === 'NE' || visual.dir === 'NW',
    bob,
  };
}

/** O corpo ainda merece ser desenhado? Depois do sumiço, nem cadáver. */
export function gorilaVisível(gorila: Pick<Gorila, 'morto' | 'deathTimer'>): boolean {
  'worklet';
  return !gorila.morto || gorila.deathTimer < GORILA_CADAVER_S;
}
