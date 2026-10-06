import type { Dir4 } from '../game/GameConfig';

/**
 * O guerreiro da aldeia.
 *
 * A mata cobra quem insiste nela (o gigante) e o rio cobra quem navega nele (a piranha). Falta a
 * terceira resposta, que é a única das três com uma *casa*: o acampamento existe como função da
 * coordenada, a clareira é pintada no chão, e uma posse sem ninguém para defendê-la é só um
 * desenho. O guerreiro é o dono vindo conferir.
 *
 * A diferença de comportamento não é um detalhe de IA, é a definição do lugar: o gigante atravessa
 * o mundo inteiro atrás de você, a piranha patrulha o canal, e o guerreiro **defende a clareira e
 * não sai dela**. Ele não persegue até a cidade, não atravessa duas células para pegar um carro,
 * não aparece na sua rua. É por isso que entrar num acampamento é uma decisão e não um gatilho
 * aleatório: quem pisa a terra pisada é caçado *ali*, e quem volta para a trilha está fora da
 * jurisdição dele — a mesma simetria que faz o asfalto salvar do gorila.
 *
 * O segundo traço que o separa das outras duas feras é o bando: um guerreiro que vê alguém avisa
 * em voz alta, e o aviso compra a emboscada — os vizinhos cortam pela frente em vez de correr
 * atrás. Um predador solitário é um susto; três que se chamam são uma mecânica de território, e é
 * o que faz a aldeia parecer morada antes de qualquer HUD dizer isso.
 *
 * O terceiro é o que ele faz com quem já não reage: **captura, não mata.** Uma fera que só mata
 * ensina o jogador a atirar primeiro; uma que arrasta o desacordado para dentro do lugar ensina
 * outra coisa — que ali se come gente, sem precisar de uma linha de texto para dizer.
 *
 * Mora separado do `NPC` do `TrafficSystem` pelo mesmo motivo do gorila separado do `Animal`: o
 * pedestre do trânsito é um mecanismo de calçada, com grade, semáforo, carro dirigido e nível de
 * procurado. Nada disso existe na terra sem nome, e o que existe lá — posse, cone de visão, chamada
 * e cativeiro — não tem lugar no modelo de quem atravessa a rua.
 */

/**
 * `adormecido` não é um estado: um bando sem ninguém acordado é simplesmente a lista dele andando
 * em círculo. As demais fases são decisões de design documentadas no `TriboSystem`, cada uma com
 * um gesto diferente na tela — inclusive as que não disparam dano nenhum.
 */
export type GuerreiroEstado =
  | 'patrulhando' | 'postado' | 'avistando' | 'cercando' | 'perseguindo'
  | 'batendo' | 'capturando' | 'carregando' | 'voltando' | 'morto';

/** Corpo de um homem armado, em tiles. Um quinto da cabana, três quartos do jogador. */
export const GUERREIRO_RAIO = 0.3;
/**
 * Vida: 90 é dois tiros de rifle e um soco bem dado de porrete a menos que você esteja ferido.
 * O guerreiro tem de morrer — um inimigo que só pode ser espantado transforma a aldeia num muro —
 * mas morrer rápido demais transformaria o território em treino de tiro, que é o oposto do aviso.
 */
export const GUERREIRO_VIDA = 90;
/** Porrete na omoplata: três desses num jogador cheio já são um problema; cinco são um desmaio. */
export const GUERREIRO_DANO = 15;
/** Comprimento do braço mais o porrete. O golpe não exige sobreposição de corpos. */
export const GUERREIRO_ALCANCE = 1.15;
/** Cadência do braço: 1,1 s entre marteladas — um pouco mais lento que o soco do jogador. */
export const GUERREIRO_CADENCIA = 1.1;
/** Windup visível: o porrete no alto é a janela em que ainda dá para sair do alcance. */
export const GUERREIRO_WINDUP = 0.24;
/** Janela do impacto lida do cooldown, pelo mesmo motivo do gigante: o quadro do golpe existe. */
export const GUERREIRO_IMPACTO_S = 0.15;
/** Levantar o braço antes de gritar: o grito é um gesto, não um alarme sonoro solto no ar. */
export const GUERREIRO_AVISO_S = 0.5;
export const GUERREIRO_QUEDA_S = 0.85;
export const GUERREIRO_CADAVER_S = 18;
export const GUERREIRO_FADE_S = 3;

export interface Guerreiro {
  /** Único no mundo inteiro: é a chave do par de `SharedValue` do render e do registro de tiros. */
  readonly id: number;
  /** `chaveDoTile` da célula do acampamento: o bando a que este corpo pertence. */
  readonly bando: number;
  /** O lugar dele no anel. É do hash, então o mesmo guerreiro guarda o mesmo posto para sempre. */
  readonly posto: number;
  x: number;
  y: number;
  dir: Dir4;
  /**
   * Ângulo de olhar em radianos, em coordenadas de mundo. O `dir` é para o sprite (quatro
   * direções), este é para o cone de visão (contínuo) — e é por isso que os dois existem: um
   * guerreiro que só tivesse `dir` enxergaria em diagonal ou não enxergaria, e quem varre a
   * postura de sentinela move os olhos entre uma direção e outra.
   */
  olhar: number;
  estado: GuerreiroEstado;
  vida: number;
  readonly raio: number;
  /** Velocidade real do último tick: o render usa isto para decidir se ele caminha. */
  velocidade: number;
  /**
   * Cópia do furor do bando no instante em que este corpo acordou. É ela, e não o furor global,
   * que dita a velocidade dele — o guerreiro que acordou com o terceiro companheiro caído tem de
   * continuar furioso mesmo depois de o bando inteiro se acalmar.
   */
  furor: number;
  morto: boolean;
  deathTimer: number;
  animTime: number;
  /** Cooldown do braço, em segundos de simulação. */
  golpe: number;
  /**
   * Relógio da pausa em curso: windup do golpe, tempo de aviso com o braço no alto e espera no
   * posto. Uma só variável porque as três são a mesma coisa — um corpo parado contando segundos
   * até o próximo gesto — e um campo por caso seria três números podendo discordar.
   */
  espera: number;
  /**
   * Os dois números do circuito: o ângulo do trilho onde este corpo está e o sentido que ele segue.
   * Moram no corpo porque a patrulha é um estado do guerreiro, não uma função do relógio — dois
   * sentinelas no mesmo posto andam em direções opostas desde o instante em que o hash do lugar os
   * pôs na borda, e é isso que faz a ronda parecer turno e não mola.
   */
  trilhoθ: number;
  trilhoSentido: number;
  /** Relógio do grito individual, para três guerreiros não uivarem juntos no mesmo quadro. */
  grito: number;
  /**
   * Ele está levando o jogador. Mora no corpo porque é o corpo que decide o gesto: o `pose` lê isto
   * para trocar o porrete erguido pelo arrasto — os dois braços atrás do quadril, as duas mãos na
   * corda, nenhuma arma — e o `guerreiroVisualState` publica para a UI thread sem expor o `Player`.
   *
   * O corpo arrastado não é desenhado aqui. É o jogador, com sprite, sombra e lugar próprio na fila
   * ordenada, e a corda que sai deste sprite é o que emenda os dois.
   */
  carrega: boolean;
}

export function criaGuerreiro(id: number, bando: number, posto: number,
  x: number, y: number, olhar: number): Guerreiro {
  return {
    id, bando, posto, x, y, dir: dirDe(olhar), olhar,
    estado: 'patrulhando', vida: GUERREIRO_VIDA, raio: GUERREIRO_RAIO,
    velocidade: 0, furor: 0, morto: false, deathTimer: -1, animTime: 0,
    golpe: 0, espera: 0, trilhoθ: 0, trilhoSentido: 1,
    grito: 0, carrega: false,
  };
}

/**
 * Aplica dano ao corpo. Devolve `true` só no primeiro golpe letal, como `fereGorila`: quem chama
 * precisa saber quando a vida acabou para tratar o cadáver uma única vez — e, no caso do bando,
 * para saber que o próximo agora está furioso.
 */
export function fereGuerreiro(g: Guerreiro, amount: number): boolean {
  if (g.morto || !Number.isFinite(amount) || amount <= 0) return false;
  g.vida = Math.max(0, g.vida - amount);
  if (g.vida > 0) {
    // Ferido mas não nocauteado: ele para de tentar capturar e volta a bater. Um homem sendo
    // atingido no meio do gesto de agarrar não recomeça a marcenaria — reage.
    if (g.estado === 'capturando' || g.estado === 'carregando') {
      g.estado = 'perseguindo';
      g.carrega = false;
    }
    return false;
  }
  g.morto = true;
  g.estado = 'morto';
  g.deathTimer = 0;
  g.velocidade = 0;
  g.carrega = false;
  return true;
}

/**
 * Instantâneo imutável para a UI thread — o mesmo contrato de `gorilaVisualState`: um worklet não
 * pode capturar o corpo mutável, então a pose nasce de um objeto novo por tick.
 */
export interface GuerreiroVisualState {
  dir: Dir4;
  estado: GuerreiroEstado;
  /** Publicado em radianos porque o sentinela varre a paisagem com um ângulo, não com quatro. */
  olhar: number;
  velocidade: number;
  morto: boolean;
  deathTimer: number;
  esperando: boolean;
  golpe: number;
  animTime: number;
  carrega: boolean;
  sampledAt: number;
}

export function guerreiroVisualState(g: Guerreiro, clock: number): GuerreiroVisualState {
  return {
    dir: g.dir, estado: g.estado, olhar: g.olhar, velocidade: g.velocidade, morto: g.morto,
    deathTimer: g.deathTimer, esperando: g.estado === 'batendo' && g.espera > 0,
    golpe: g.golpe, animTime: g.animTime, carrega: g.carrega, sampledAt: clock,
  };
}

/**
 * Pose do sprite. Mesma família da do gigante (frame/mirror/away/bob + curva de queda), mas com os
 * quadros de um corpo ereto: 0 parado, 1..4 marcha, 5 porrete no alto, 6 braço armado de
 * sentinela, 7 o golpe chegando, 8 o arrasto do prisioneiro.
 *
 * É `'worklet'` porque roda na UI thread dentro do `useDerivedValue` do sprite.
 */
export function guerreiroPose(visual: GuerreiroVisualState, clock: number) {
  'worklet';
  const decorrido = visual.deathTimer + (visual.morto
    ? Math.max(0, Math.min(0.1, clock - visual.sampledAt)) : 0);
  const progress = visual.morto ? Math.min(1, decorrido / GUERREIRO_QUEDA_S) : 0;
  const caindo = progress * progress * (3 - 2 * progress);
  const andando = !visual.morto && (visual.estado === 'patrulhando' || visual.estado === 'cercando'
    || visual.estado === 'perseguindo' || visual.estado === 'capturando'
    || visual.estado === 'voltando' || visual.estado === 'carregando')
    && visual.velocidade > 0.01;
  const correndo = visual.estado === 'perseguindo' || visual.estado === 'cercando';
  const windup = !visual.morto && (visual.estado === 'batendo' || visual.esperando
    || visual.estado === 'avistando');
  const impacto = !visual.morto && !windup
    && visual.golpe > GUERREIRO_CADENCIA - GUERREIRO_IMPACTO_S;
  const ritmo = correndo ? 7 : 3.6;
  const fase = (visual.animTime * ritmo) % 4;
  const frame = visual.morto ? 0
    : visual.carrega ? 8
      : impacto ? 7
        : windup ? (visual.estado === 'avistando' ? 6 : 5)
          : andando ? 1 + (Math.floor(fase) % 4)
            : 0;
  // O centro de massa sobe na passada e afunda no apoio, na MESMA fase do quadro — a régua que
  // fez o gigante rolar em vez de pular vale para um corpo de setenta quilos pelos mesmos motivos.
  const apoio = Math.abs(Math.sin(Math.PI * fase / 2));
  const respirando = !andando && !windup && !impacto && !visual.morto;
  const bob = andando ? -apoio * (correndo ? 2.2 : 1.4)
    : respirando ? Math.sin(clock * 1.7) * 0.7 : 0;
  const lado = visual.dir === 'SE' || visual.dir === 'NE' ? 1 : -1;
  const tomba = Math.min(1, progress / 0.7);
  const giro = tomba * tomba * (3 - 2 * tomba);
  return {
    rotation: lado * 1.35 * giro,
    scaleY: 1 - 0.12 * giro,
    offsetY: 3 * giro,
    alpha: visual.morto
      ? Math.max(0, Math.min(1, (GUERREIRO_CADAVER_S - decorrido) / GUERREIRO_FADE_S)) : 1,
    frame,
    mirror: visual.dir === 'SW' || visual.dir === 'NW' ? -1 : 1,
    away: visual.dir === 'NE' || visual.dir === 'NW',
    bob,
  };
}

/** O corpo ainda merece ser desenhado? Depois do sumiço, nem cadáver. */
export function guerreiroVisível(g: Pick<Guerreiro, 'morto' | 'deathTimer'>): boolean {
  'worklet';
  return !g.morto || g.deathTimer < GUERREIRO_CADAVER_S;
}

/**
 * A direção do sprite a partir de um ângulo de mundo, na fonia do jogo: `worldToScreen` faz +x
 * descer para o sudeste, então o mesmo par de eixos que `deltaToDir` usa para a fauna vale aqui.
 */
export function dirDe(olhar: number): Dir4 {
  const c = Math.cos(olhar), s = Math.sin(olhar);
  if (c >= 0 && s >= 0) return 'SE';
  if (c < 0 && s < 0) return 'NW';
  if (c >= 0) return 'NE';
  return 'SW';
}
