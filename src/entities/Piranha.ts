import type { Dir4 } from '../game/GameConfig';

/**
 * A piranha do rio sem fim.
 *
 * O espelho aquático do gorila, e "espelho" aqui é regra, não enfeite: o chão cobra quem
 * insiste nele a pé, a água cobra quem insiste nela a nado. O pedido do jogador foi uma
 * piranha gigante atacando quem entra no rio além do limite — e o que faz isso ser mecânica em
 * vez de susto de um quadro é o mesmo contrato de sempre: **correr não escapa, sair da água
 * escapa, atirar acelera, matar não perdoa.**
 *
 * A diferença que importa é o meio. Na mata o jogador anda mais rápido que o gorila; na água
 * ele nada a `PLAYER_SWIM_SPEED` (1,15 tile/s) e a piranha nada a mais de 2 — nadar em linha
 * reta é uma sentença. Isso não é um bug de balanceamento, é a lição do lugar: a água não tem
 * para onde correr, então a única fuga é **sair dela**, e a única margem que existe além do
 * limite é a mata. O gorila ensina a voltar para a cidade; a piranha ensina a voltar para a
 * terra.
 *
 * Ela mora separada do `Animal` do `WildlifeSystem` pela mesma razão do gigante: o rebanho é
 * um mecanismo de habitat, com grade, reserva de nascimento e tile de mapa. No rio sem fim não
 * há `data.tiles`, não há bioma e não há "casa" — o que existe é uma função da coordenada, e um
 * mecanismo por classe vale também para o modelo.
 */

/**
 * Fases da caçada. Como no gigante, a ausência do corpo é descrita pelo sistema (`fera ===
 * null`), não por um estado: 'submersa' seria um estado de sprite, e o sprite já lê o `golpe`
 * para isso.
 */
export type PiranhaEstado = 'espreitando' | 'rodeando' | 'saltando' | 'retirando' | 'morto';

/** Raio do corpo em tiles. Três metros e meio de peixe: maior que o gigante, mais baixo. */
export const PIRANHA_RAIO = 1.15;
/**
 * Vida. 420 é ~5 tiros de rifle e ~120 de pistola: menos que o gorila porque o corpo aqui é
 * um alvo molhado de 140 px dentro de um canal de seis tiles — sem terreno para se esconder,
 * o jogador acerta tudo o que atira. Se ela fosse tão dura quanto o gigante, a luta seria só
 * espera.
 */
export const PIRANHA_VIDA = 420;
/** Dano de uma dentada. Quatro delas fecham um personagem com 100 de vida. */
export const PIRANHA_DANO_MORDIDA = 26;
/**
 * Distância da dentada, já contando o corpo: o bote atravessa o canal, não encosta no alvo.
 * Por isso é maior que o alcance do soco do gorila (2,1) — um peixe não tem braço, tem salto.
 */
export const PIRANHA_ALCANCE_MORDIDA = 2.6;
/** Cadência do bote: 1,9 s entre saltos. É o tempo de ele afundar, contornar e voltar. */
export const PIRANHA_CADENCIA = 1.9;
/**
 * O arco do salto, em segundos, medido a partir do `golpe` que acabou de zerar. Existe porque
 * o dano é aplicado no lançamento e desenhado depois: sem uma janela lida do cooldown o corpo
 * subiria na tela um quadro antes da mordida cair, ou nunca subia — o mesmo erro do punho do
 * gigante antes da `GORILA_IMPACTO_S`.
 */
export const PIRANHA_ARCO_S = 0.36;
/** Metade do arco em que a boca ainda está se abrindo; depois dela é a dentada aberta. */
export const PIRANHA_BOCA_S = 0.2;
/** Janela em que o corpo ainda está fora d'água depois do dano. */
export const PIRANHA_IMPACTO_S = 0.16;
/** Windup embaixo d'água: a barbatana some e o jogador tem este tempo para escolher. */
export const PIRANHA_SALTO_S = 0.3;
/** Raio da volta, em tiles: a distância em que a barbatana contorna quem está na água. */
export const PIRANHA_RODEIO_RAIO = 5.5;
/** Queda do corpo (ele vira de barriga para cima), boia e fade, separados de propósito. */
export const PIRANHA_QUEDA_S = 0.8;
export const PIRANHA_CADAVER_S = 18;
export const PIRANHA_FADE_S = 3.5;
/** A cada tile e meio percorrido, uma ondulação que se vê e se ouve. Régua, não animação. */
export const PIRANHA_PASSO_TILES = 1.5;

export interface Piranha {
  /** Um só indivíduo por mundo; o id existe para o render ter uma chave estável. */
  readonly id: number;
  x: number;
  y: number;
  dir: Dir4;
  estado: PiranhaEstado;
  vida: number;
  readonly raio: number;
  /** Velocidade real do último tick: é o que o render usa para decidir se a cauda bate. */
  velocidade: number;
  morto: boolean;
  /** Segundos desde a morte, -1 enquanto vivo. */
  deathTimer: number;
  /** Segundos de movimento efetivo perto da câmera. */
  animTime: number;
  /** Cooldown da mordida, em segundos de simulação. */
  golpe: number;
  /** Windup em curso: quando zerar, o bote acontece. */
  espera: number;
  /** Fração de percurso até a próxima ondulação sentida. */
  passo: number;
  /**
   * Cópia da dívida do rio no instante em que este indivíduo nasceu. É ela que dita a
   * velocidade dele, e ela não muda quando o jogador volta para a margem: um bicho que acordou
   * porque você atravessou o canal inteiro tem de continuar sendo o bicho que atravessou.
   */
  rancor: number;
}

export function criaPiranha(x: number, y: number, rancor: number): Piranha {
  return {
    id: 1, x, y, dir: 'SE', estado: 'espreitando', vida: PIRANHA_VIDA, raio: PIRANHA_RAIO,
    velocidade: 0, morto: false, deathTimer: -1, animTime: 0,
    golpe: 0, espera: 0, passo: 0, rancor,
  };
}

/**
 * Aplica dano ao corpo. Devolve `true` só no primeiro golpe letal, como `fereGorila`: quem
 * chama precisa saber quando a vida acabou para tratar a carcaça uma única vez.
 *
 * Ferida, ela não foge — e aqui isso tem um peso a mais: um predador que dá a volta no seu
 * alvo não interrompe a volta porque levou um tiro. O acerto aumenta o rancor dele, que é a
 * velocidade dele, e é essa a lição que a fronteira inteira ensina.
 */
export function ferePiranha(peixe: Piranha, amount: number): boolean {
  if (peixe.morto || !Number.isFinite(amount) || amount <= 0) return false;
  peixe.vida = Math.max(0, peixe.vida - amount);
  peixe.rancor = Math.min(2.4, peixe.rancor + 0.2);
  if (peixe.vida > 0) {
    if (peixe.estado === 'retirando' || peixe.estado === 'espreitando') peixe.estado = 'rodeando';
    return false;
  }
  peixe.morto = true;
  peixe.estado = 'morto';
  peixe.deathTimer = 0;
  peixe.velocidade = 0;
  return true;
}

/**
 * Instantâneo imutável para a UI thread — o mesmo contrato do `gorilaVisualState`: um worklet
 * não pode capturar o corpo mutável, então a pose nasce de um objeto novo por tick.
 */
export interface PiranhaVisualState {
  dir: Dir4;
  estado: PiranhaEstado;
  velocidade: number;
  morto: boolean;
  deathTimer: number;
  /** Windup embaixo d'água no instante da publicação: é o quadro em que a barbatana some. */
  esperando: boolean;
  /** Cooldown publicado junto: é o que permite desenhar o arco do salto depois do dano cair. */
  golpe: number;
  animTime: number;
  sampledAt: number;
}

export function piranhaVisualState(peixe: Piranha, clock: number): PiranhaVisualState {
  return {
    dir: peixe.dir, estado: peixe.estado, velocidade: peixe.velocidade, morto: peixe.morto,
    deathTimer: peixe.deathTimer, esperando: peixe.estado === 'saltando' && peixe.espera > 0,
    golpe: peixe.golpe,
    animTime: peixe.animTime, sampledAt: clock,
  };
}

/**
 * Pose do sprite. Os mesmos campos da pose do gigante (frame/mirror/away/bob + curva de queda)
 * mais um `salto`, que a fauna não tem: em peixe o gesto não é o braço, é o corpo inteiro
 * deixando a água.
 *
 * É `'worklet'` porque roda na UI thread dentro do `useDerivedValue` do sprite.
 */
export function piranhaPose(visual: PiranhaVisualState, clock: number) {
  'worklet';
  // Interpola no máximo 0,1 s entre publicações: nunca inventar tempo de morte para um corpo
  // que o mundo parou de simular.
  const decorrido = visual.deathTimer + (visual.morto ? Math.max(0, Math.min(0.1, clock - visual.sampledAt)) : 0);
  const progress = visual.morto ? Math.min(1, decorrido / PIRANHA_QUEDA_S) : 0;
  const rola = progress * progress * (3 - 2 * progress);
  const andando = !visual.morto && visual.velocidade > 0.01;
  const aviso = visual.estado === 'espreitando';
  // O arco é lido do cooldown, não de um temporizador paralelo: o dano cai no lançamento e o
  // corpo sobe no mesmo número, senão o jogador levaria a mordida vendo um peixe quieto.
  const noAr = !visual.morto && !visual.esperando
    && visual.golpe > PIRANHA_CADENCIA - PIRANHA_ARCO_S;
  const u = noAr ? Math.min(1, (PIRANHA_CADENCIA - visual.golpe) / PIRANHA_ARCO_S) : 0;
  const mordendo = noAr && visual.golpe > PIRANHA_CADENCIA - PIRANHA_IMPACTO_S;
  // 0 parado, 1..3 natação (cauda para lá, neutra, para cá), 4 barbatana do aviso, 5 submerso,
  // 6 saindo da água e 7 a dentada aberta no alto do arco.
  const fase = (visual.animTime * 4.2) % 3;
  const frame = visual.morto ? 8
    : visual.esperando ? 5
      : noAr ? (mordendo || u > 0.55 ? 7 : 6)
        : andando ? 1 + (Math.floor(fase) % 3)
          : aviso ? 4 : 0;
  // O corpo boia: mesmo parado ele sobe e desce com a própria esteira, e é isso que separa um
  // peixe desenhado de um peixe dentro d'água. No salto, o mesmo `bob` vira parábola.
  const flutuando = Math.sin(clock * 2.1) * (andando ? 1.1 : 2.2);
  const altura = noAr ? Math.sin(Math.PI * u) * 30 : 0;
  return {
    // O arco em radianos (mesma unidade do gigante): sai da água com o focinho para cima e
    // desce com ele para baixo. Como o `mirror` vem depois na fila de transforms, o sinal não
    // precisa conhecer a direção — o lado que lidera é sempre o lado que aponta.
    rotation: noAr ? 0.34 * (2 * u - 1) : 0,
    // Morto ela é o quadro 8 desenhado de propósito — barriga clara para cima, olho riscado —
    // em vez de um giro de 180° no sprite: em isométrico um peixe rodado inteiro seria um peixe
    // voando, e o que afunda é só o dorso escuro.
    scaleY: visual.morto ? 1 - 0.12 * rola : 1,
    offsetY: -altura + (visual.morto ? 6 * rola : 0),
    alpha: visual.morto
      ? Math.max(0, Math.min(1, (PIRANHA_CADAVER_S - decorrido) / PIRANHA_FADE_S))
      : visual.esperando ? 0.55 : 1,
    frame,
    mirror: visual.dir === 'SW' || visual.dir === 'NW' ? -1 : 1,
    away: visual.dir === 'NE' || visual.dir === 'NW',
    bob: flutuando + (visual.morto ? 0 : Math.sin(fase * Math.PI * 2 / 3) * (andando ? 1.4 : 0)),
  };
}

/** O corpo ainda merece ser desenhado? Depois de afundar, nem barriga branca. */
export function piranhaVisível(peixe: Pick<Piranha, 'morto' | 'deathTimer'>): boolean {
  'worklet';
  return !peixe.morto || peixe.deathTimer < PIRANHA_CADAVER_S;
}
