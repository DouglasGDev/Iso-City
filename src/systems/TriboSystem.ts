import {
  GUERREIRO_ALCANCE, GUERREIRO_AVISO_S, GUERREIRO_CADENCIA, GUERREIRO_DANO, GUERREIRO_RAIO,
  GUERREIRO_WINDUP, criaGuerreiro, dirDe, fereGuerreiro, guerreiroVisível,
  type Guerreiro,
} from '../entities/Guerreiro';
import type { Acampamento } from '../world/Tribo';
import {
  FOLGA_DA_JURISDIÇÃO, acampamentoDaCélula, acampamentoQueRecebe, célulaDaTribo,
  empurraDoAcampamento, jurisdiçãoDaAldeia, pontoDaAmarra,
} from '../world/Tribo';
import {
  NOME_DA_FACE, PROFUNDIDADE_SEM_NOME, type ConsultaDeÁgua, faceDaFronteira, profundidade, sorte,
} from '../world/Frontier';

/**
 * O bando que defende a clareira.
 *
 * A fase 1 estabeleceu que o acampamento é uma função da coordenada; a fase 2 que ele é desenhado e
 * pisa a mesma terra que barra o passo. Falta a terceira, que é a razão de ser das outras duas: um
 * lugar com casa tem dono, e o dono vem ver quem entrou. Este sistema decide **patrulha, visão,
 * chamada, emboscada, dano, morte, retirada e captura**; o `GameState` só orquestra — entrega o
 * corpo do jogador, a régua de dano e os alto-falantes, e recebe de volta a frase da HUD, o número
 * do perigo e o instante em que alguém foi levado.
 *
 * Os números abaixo não são dificuldade: são a distância que o jogador leva para ser cercado entrando
 * a pé pela boca do lugar, andando devagar. Ele pode vencer — são corpos com 90 de vida, que morrem.
 * E pode escapar, por três portas e não uma: a jurisdição acaba na borda dilatada da clareira, o
 * golpe que começaria a captura pode ser respondido com tiro (quem carrega um prisioneiro é o alvo
 * mais gordo do lugar), e um bando satisfeito — o que acabou de levar alguém — não olha para você
 * por vinte e cinco segundos. Captura inevitável não é mecânica, é cutscene.
 *
 * A posse do trecho é a única que esta classe não inventa: `terraDaAldeia` é a mesma pergunta que o
 * `GorilaSystem` faz para não cobrar o rio, e o rio é do peixe. Um ponto, um dono, uma régua — e é
 * por isso que o guerreiro não tem um teste de pertence próprio.
 *
 * A patrulha é um trilho na borda da clareira, e isso é decisão, não preguiça: as cabanas ficam a
 * 0,65 do raio da elipse e o trilho a 0,95, então um sentinela andando no trilho não encosta em
 * parede nenhuma por aritmética — o mesmo par de números que a fase 2 cobriu para o desenho e para o
 * colisor. Fora do trilho, na luta, ele anda livre e obedece ao `empurraDoAcampamento`: a casa que
 * você vê é a casa que barra.
 */

// ---- o bando ----
/** Dois guerreiros por aldeia, mais um a cada dezoito tiles de fundo, nunca mais do que as casas. */
const BASE_DO_BANDO = 2;
const UM_A_CADA_TILES = 18;
/** A 30 tiles da aldeia o bando entra no mundo; a 46, quem não está em luta sai dele junto. */
const ENTRADA_DA_BANDA = 30;
const FIM_DA_BANDA = 46;
/** Segundos sem ninguém enxergar até o bando devolver a paisagem ao silêncio. */
const VOLTA_A_CALMA_S = 6;
/** O tempo que um bando satisfeito fica voltado aos próprios afazeres — ele já comeu hoje. */
export const PRAZO_DA_SACIEDADE = 25;

// ---- o trilho ----
/** Fração do raio da clareira onde a sentinela anda: fora do alcance de qualquer parede desenhada. */
export const ALTURA_DO_TRAILHO = 0.95;
/** Velocidade da ronda: mais devagar que o passo do jogador, para que a passada seja lida. */
const PASSO_PATRULHA = 1.15;

// ---- a visão ----
/** Tiles de alcance do olho, em dia claro e a pé. A casa no meio do caminho conta junto. */
export const OLHO_TILES = 12;
/** Cosseno do semi-ângulo do cone (~63°): largo o bastante para pegar quem orla a clareira. */
const OLHO_COS = 0.45;

// ---- a luta ----
const PASSO_CAÇA_BASE = 2.9;
const PASSO_POR_FUROR = 0.5;
const PASSO_CAÇA_TETO = 3.85;
/** A folga do golpe: três centímetros de "errou" seriam injustos, meio braço seria trapaça. */
const GOLPE_FOLGA = 0.2;
/** Recuo do jogador no porrete: meio tile. Um homem de setenta quilos não é arremessado. */
const GOLPE_RECUO = 0.55;
/**
 * Vida abaixo da qual eles param de bater e passam a agarrar. É o piso da captura, não a morte: o
 * golpe que levasse o jogador para baixo deste número não desce — e é isto que faz ser possível
 * provar que a aldeia captura *por causa* do estado do corpo, e não por sorteio.
 */
export const PISO_DO_ABOLO = 24;
/** Tiles por segundo arrastando um corpo: um guerreiro carrega um homem, mas não corre com ele. */
const PASSO_DO_CARREGO = 1.6;
/**
 * O comprimento da amarra, em tiles: a distância entre quem puxa e o corpo na ponta. É uma medida
 * de desenho, não de enfeite — abaixo disto os dois sprites se empilham na mesma linha da fila
 * ordenada e o arrasto some da tela; acima, a corda do sprite (que tem comprimento fixo em pixels)
 * mentiria sobre o vão.
 */
export const DISTANCIA_DA_AMARRA = 0.9;
/** Cada morte no bando: os que ficam mais rápidos e mais dispostos a atravessar a clareira. */
const FUROR_DA_MORTE = 0.34;
const FUROR_TETO = 2;

// ---- voz ----
const GRITO_S = 6;
const TAMBOR_S = 9;
/** Alcance das vozes em tiles: o som é do bando, mas só ouve quem está perto do acontecimento. */
const VOZ_ALCANCE = 45;

/** O corpo que o bando persegue: duas coordenadas e a permissão de ser arrastado. */
export interface TriboCorpo {
  x: number;
  y: number;
}

/** O mínimo de mundo que o sistema precisa ler. O `GameState` real satisfaz isto. */
export interface TriboContext {
  worldW: number;
  worldH: number;
  /** `null` dentro de uma sala: lá dentro não há clareira, e o bando continua no posto. */
  player: TriboCorpo | null;
  /** Onde a cidade enxerga o jogador — a régua de profundidade, como na mata e no rio. */
  worldPosition: TriboCorpo;
  água: ConsultaDeÁgua;
  /** O único ponto de dano do jogador no jogo: é ele que respeita `invulnUntil`. */
  damages: (amount: number) => boolean;
  /**
   * A vida do jogador, lida e não escrita. Este é o único motivo de a contexto ter um segundo canal
   * de saúde além de `damages`: para a captura existir, o golpe precisa poder **parar antes** de
   * matar, e um sistema que só sabe causar dano não sabe onde está o chão do alvo.
   */
  vidaDoJogador: () => number;
  /** A pé? Dentro de um carro, uma moto ou uma aeronave não há corpo que seja arrastado. */
  aPé: () => boolean;
  /**
   * A largura do corpo na ponta da corda, em tiles. É leitura e não constante daqui porque o
   * prisioneiro não é do bando: é o jogador, e quem sabe o raio dele é o `GameState`. O número
   * decide o ponto onde o corpo pousa ao ser atado — soma dos dois pinos, e é por isso que o
   * colisor não empurra o que acabou de ser amarrado.
   */
  raioDoCorpo: () => number;
  /** Move o corpo do jogador junto com quem o carrega. Só é chamada com um carregador em curso. */
  arrasta: (x: number, y: number) => void;
  /**
   * O prisioneiro foi atado ao poste da clareira. É a única saída de captura deste sistema, e quem
   * decide o custo — dinheiro, armas, quanto tempo a corda segura — é o `GameState`: a mecânica é
   * daqui, a punição é do jogo.
   */
  captura: (ac: Acampamento) => void;
  shake: (amount: number) => void;
  say: (text: string, seconds?: number) => void;
  play: (key: 'triboGrito' | 'triboTambor' | 'bodyHit', volume: number) => void;
  isVisible: (x: number, y: number) => boolean;
  onStructChange: () => void;
}

interface Bando {
  readonly id: number;
  ac: Acampamento;
  guerreiros: Guerreiro[];
  /** Ângulo de cada posto no trilho, em parâmetro de elipse: o circuito é sorteado, não medido. */
  postos: number[];
  /** 0..1 — quantos deles estão de olho em você. É o que a HUD lê como perigo. */
  alerta: number;
  furor: number;
  /** Segundos de calma depois de levar alguém. */
  satisfeita: number;
  /** Segundos desde que alguém enxergou o jogador; é o relógio da volta à calma. */
  visto: number;
  /** Relógio do tambor do bando, para o aviso contínuo ter um ritmo e não um zumbido. */
  tambor: number;
}

/** O ponto do trilho neste ângulo: a borda de fora da terra pisada, entre as casas. */
export function pontoDoTrilho(ac: Acampamento, θ: number): { x: number; y: number } {
  return {
    x: ac.x + Math.cos(θ) * ac.meiaLargura * ALTURA_DO_TRAILHO,
    y: ac.y + Math.sin(θ) * ac.meiaAltura * ALTURA_DO_TRAILHO,
  };
}

/**
 * Quantos tiles há por radiano de parâmetro neste ângulo. Sem esta correção o sentinela andaria
 * quase o dobro de chão no eixo longo da elipse que no curto — é a mesma leitura que a fase 1 fez da
 * corda mais curta de uma elipse, agora aplicada ao passo de quem caminha nela.
 */
export function arcoDoTrilho(ac: Acampamento, θ: number): number {
  return Math.hypot(Math.sin(θ) * ac.meiaLargura, Math.cos(θ) * ac.meiaAltura) || 1;
}

/** A normal para fora da elipse: para onde a sentinela olha quando para no próprio posto. */
export function normalDoTrilho(ac: Acampamento, θ: number): number {
  return Math.atan2(Math.sin(θ) / ac.meiaAltura, Math.cos(θ) / ac.meiaLargura);
}

/** A tangente do circuito: a direção em que o corpo anda, no sentido escolhido pelo hash. */
export function rumoDoTrilho(ac: Acampamento, θ: number, sentido: number): number {
  return Math.atan2(Math.cos(θ) * ac.meiaAltura * sentido, -Math.sin(θ) * ac.meiaLargura * sentido);
}

/** O menor caminho angular de `a` até `b`, em (-π, π]. */
function anguloDelta(a: number, b: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/**
 * Quantos corpos a aldeia põe de pé. É uma função do lugar, não do acaso: as casas que o hash
 * construiu são o teto do bando (um guerreiro por porta de cabana, nunca uma turba), e a
 * profundidade é o piso da ousadia — quanto mais dentro do território, mais eles são.
 */
export function tamanhoDoBando(ac: Acampamento): number {
  return Math.max(BASE_DO_BANDO, Math.min(ac.cabanas.length,
    BASE_DO_BANDO + Math.floor((ac.prof - PROFUNDIDADE_SEM_NOME) / UM_A_CADA_TILES)
    + Math.floor(sorte(ac.cx, ac.cy, 210) * 2)));
}

/**
 * Os postos do bando: a boca primeiro, depois as lacunas entre casas vizinhas.
 *
 * A lacuna é o único ponto do anel onde um corpo pode parar sem encostar em parede, e ela existe
 * antes de qualquer guerreiro — é a média angular de duas cabanas publicadas, medida no parâmetro da
 * elipse (o mesmo que posiciona as casas), com um tremendo de hash para o circuito não parecer
 * formatura de tropa.
 */
export function postosDoBando(ac: Acampamento): number[] {
  const quantos = tamanhoDoBando(ac);
  const casas = ac.cabanas;
  const postos: number[] = [ac.porta];
  for (let k = 1; k < quantos; k++) {
    const i = (k - 1) % casas.length;
    const a = casas[i], b = casas[(i + 1) % casas.length];
    const θa = Math.atan2((a.y - ac.y) / ac.meiaAltura, (a.x - ac.x) / ac.meiaLargura);
    const θb = Math.atan2((b.y - ac.y) / ac.meiaAltura, (b.x - ac.x) / ac.meiaLargura);
    // Média no círculo, não no real: a lacuna entre 350° e 10° é 0°, e uma média de números dá 180°
    // — um posto no lado oposto do lugar, com o sentinela atravessando a fogueira para chegar.
    postos.push(θa + anguloDelta(θa, θb) / 2 + (sorte(ac.cx, ac.cy, 200 + k) - 0.5) * 0.25);
  }
  return postos;
}

/** Os corpos altos do lugar: o que tapa a vista. A fogueira não entra — fogo não esconde ninguém. */
function obstáculos(ac: Acampamento): { x: number; y: number; raio: number }[] {
  const fora: { x: number; y: number; raio: number }[] = ac.cabanas.map((c) => ({
    x: c.x, y: c.y, raio: c.raio,
  }));
  if (ac.totem) fora.push(ac.totem);
  return fora;
}

/** O pino alto que está no meio do caminho entre a sentinela e o alvo. */
function bloqueado(obstáculos: { x: number; y: number; raio: number }[],
  gx: number, gy: number, px: number, py: number): boolean {
  const dx = px - gx, dy = py - gy;
  const quadr = dx * dx + dy * dy;
  if (quadr < 1e-9) return false;
  for (const o of obstáculos) {
    const t = ((o.x - gx) * dx + (o.y - gy) * dy) / quadr;
    if (t <= 0.02 || t >= 0.98) continue;
    const ax = gx + dx * t - o.x, ay = gy + dy * t - o.y;
    const folga = o.raio + 0.05;
    if (ax * ax + ay * ay < folga * folga) return true;
  }
  return false;
}

export class TriboSystem {
  private bandas = new Map<number, Bando>();
  private próximoId = 1;
  private tempo = 0;

  /**
   * Todos os corpos ainda desenháveis do mundo, em ordem estável de id. É a única porta do render
   * para a lista: quem percorre a tela lê isto e decide o recorte, nunca o contrário.
   */
  get guerreiros(): Guerreiro[] {
    const fora: Guerreiro[] = [];
    for (const b of this.bandas.values()) {
      for (const g of b.guerreiros) if (guerreiroVisível(g)) fora.push(g);
    }
    return fora.sort((a, b) => a.id - b.id);
  }

  /** Os corpos vivos que um tiro pode acertar: cadáver não atira de volta nem leva ninguém. */
  alvos(): Guerreiro[] {
    return this.guerreiros.filter((g) => !g.morto);
  }

  /** Perigo lido pela HUD: 0 quando ninguém olha, 1 no instante em que o bando acorda inteiro. */
  get perigo(): number {
    let pior = 0;
    for (const b of this.bandas.values()) pior = Math.max(pior, b.alerta);
    return pior;
  }

  /**
   * Alguém está te carregando neste instante. É a única pergunta que o `GameState` faz fora do tick,
   * e ela tem de sair daqui porque o carregador é um corpo deste sistema: o joystick não pode
   * empurrar um corpo que já tem dono, e um flag copiado no `Player` seriam dois números podendo
   * discordar — o mesmo motivo de `vidaDoJogador` ser leitura e não campo.
   */
  get arrastado(): boolean {
    for (const b of this.bandas.values()) {
      for (const g of b.guerreiros) if (g.carrega) return true;
    }
    return false;
  }

  /** A aldeia brigando com alguém agora, ou `null`. É a palavra que a HUD usa para nomear o lugar. */
  aldeiaEmDisputa(): Acampamento | null {
    let pior: Acampamento | null = null, alerta = 0;
    for (const b of this.bandas.values()) {
      if (b.alerta > alerta) { alerta = b.alerta; pior = b.ac; }
    }
    return alerta > 0.05 ? pior : null;
  }

  /**
   * A corda do poste arrebentou: o bando volta a olhar para a própria clareira.
   *
   * É uma porta e não um `alerta = 1`, e a diferença é o mecanismo inteiro. Quem acorda é a visão: o
   * que este chamado faz é devolver ao bando a disposição de olhar, e se um sentinela no trilho tem
   * o prisioneiro no cone, o grito sai pelo caminho normal, com o aviso antes da fera. Um bando que
   * acorda em bloco porque um número mudou seria uma coreografia — e o `acorda` do cativeiro não
   * sabe onde ninguém está.
   *
   * Devolve `false` quando o bando já saiu do mundo (o prisioneiro correu para longe o bastante
   * enquanto estava amarrado). O cativeiro não liga para a resposta, e está certo: solto numa aldeia
   * sem bando é exatamente o que se quer que aconteça.
   */
  acorda(aldeiaId: number): boolean {
    const b = this.bandas.get(aldeiaId);
    if (!b) return false;
    b.satisfeita = 0;
    return true;
  }

  /**
   * O tick. Uma escrita por corpo, depois de todo mundo ter se movido, porque a sentinela enxerga o
   * jogador *onde ele está neste quadro* — e quem carrega um prisioneiro o arrasta pelo caminho que
   * o movimento já escolheu.
   */
  update(dt: number, ctx: TriboContext): void {
    if (!Number.isFinite(dt) || dt <= 0) return;
    if (!ctx.player) return;
    this.tempo += dt;
    const { player, worldW: W, worldH: H } = ctx;
    const prof = profundidade(ctx.worldPosition.x, ctx.worldPosition.y, W, H);
    // A disputa é comparada pela chave do lugar, nunca pelo objeto: `acampamentoQueRecebe` monta o
    // acampamento na hora (é função da coordenada, sem cache), então um `===` entre dois objetos
    // recém-construídos seria falso para sempre — e o bando inteiro viveria em `acalma`, uma aldeia
    // desenhada que nunca acorda, exatamente o bug que a fase 3 existe para não deixar existir.
    const disputada = prof > 0 ? acampamentoQueRecebe(player.x, player.y, W, H, ctx.água)?.id : undefined;
    this.materializa(player, ctx);
    for (const b of this.bandas.values()) {
      if (b.id === disputada) this.updateBando(b, dt, ctx, player);
      else this.acalma(b, dt, ctx);
    }
    this.evictua(player);
  }

  /**
   * Traz para o mundo os bandos das aldeias perto do jogador.
   *
   * Varre as três células ao redor do corpo, e não só a dele, por um motivo de tela: um acampamento
   * que o jogador está *vendo* precisa ter gente andando na borda, e a boca da clareira pode estar a
   * dez tiles do pé de quem olha, na célula do lado. Uma aldeia sem sentinela é o cenário vazio que
   * a fase 1 prometeu que isto não seria.
   */
  private materializa(player: TriboCorpo, ctx: TriboContext): void {
    const { worldW: W, worldH: H } = ctx;
    const { cx, cy } = célulaDaTribo(Math.floor(player.x), Math.floor(player.y));
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const ac = acampamentoDaCélula(cx + ox, cy + oy, W, H, ctx.água);
        if (!ac || this.bandas.has(ac.id)) continue;
        if (Math.hypot(ac.x - player.x, ac.y - player.y) > ENTRADA_DA_BANDA) continue;
        this.bandas.set(ac.id, this.novoBando(ac, ctx));
      }
    }
  }

  private novoBando(ac: Acampamento, ctx: TriboContext): Bando {
    const postos = postosDoBando(ac);
    const guerreiros: Guerreiro[] = [];
    for (let k = 0; k < postos.length; k++) {
      // O corpo nasce no trilho, perto do próprio posto, com o sentido que o hash deu: um bando que
      // aparece inteiro no mesmo ponto é um esquadhão, e um que já estava andando quando você chegou
      // é uma aldeia.
      const sentido = sorte(ac.cx, ac.cy, 260 + k) < 0.5 ? -1 : 1;
      const θ = postos[k] + (sorte(ac.cx, ac.cy, 220 + k) - 0.5) * 0.9;
      const ponto = pontoDoTrilho(ac, θ);
      const g = criaGuerreiro(this.próximoId++, ac.id, k, ponto.x, ponto.y,
        rumoDoTrilho(ac, θ, sentido));
      g.trilhoθ = θ;
      g.trilhoSentido = sentido;
      guerreiros.push(g);
    }
    ctx.onStructChange();
    return {
      id: ac.id, ac, guerreiros, postos, alerta: 0, furor: 0,
      satisfeita: 0, visto: VOLTA_A_CALMA_S, tambor: TAMBOR_S,
    };
  }

  /** Bandos longe demais e sem ninguém em luta saem do mundo; a aldeia fica, o bando não. */
  private evictua(player: TriboCorpo): void {
    for (const [id, b] of this.bandas) {
      if (Math.hypot(b.ac.x - player.x, b.ac.y - player.y) <= FIM_DA_BANDA) continue;
      const emLuta = b.guerreiros.some((g) => !g.morto && g.estado !== 'patrulhando'
        && g.estado !== 'postado' && g.estado !== 'voltando');
      if (!emLuta) this.bandas.delete(id);
    }
  }

  /** Fora da jurisdição: cada bando trata da própria vida — patrulha, posto e cadáver. */
  private acalma(b: Bando, dt: number, ctx: TriboContext): void {
    b.alerta = Math.max(0, b.alerta - dt * 0.4);
    b.satisfeita = Math.max(0, b.satisfeita - dt);
    b.visto += dt;
    for (const g of b.guerreiros) {
      if (g.morto) { g.deathTimer += dt; continue; }
      g.golpe = Math.max(0, g.golpe - dt);
      g.grito = Math.max(0, g.grito - dt);
      g.espera = Math.max(0, g.espera - dt);
      if (g.carrega) g.carrega = false;
      if (g.estado !== 'patrulhando' && g.estado !== 'postado' && g.estado !== 'voltando') {
        g.estado = 'voltando';
      }
      if (g.estado === 'voltando') {
        const posto = pontoDoTrilho(b.ac, b.postos[g.posto]);
        this.movePara(g, b, dt, posto, PASSO_CAÇA_BASE * 0.7, ctx);
        if (Math.hypot(posto.x - g.x, posto.y - g.y) < 0.4) this.retomaRonda(g, b);
      } else this.ronda(g, b, dt, ctx);
    }
  }

  /** O bando brigando com o jogador: primeiro se enxerga, depois cada corpo age com a notícia. */
  private updateBando(b: Bando, dt: number, ctx: TriboContext, player: TriboCorpo): void {
    b.satisfeita = Math.max(0, b.satisfeita - dt);
    const altos = obstáculos(b.ac);
    // A varredura vem antes da ação de propósito: quem avisa é o que viu, mas o que *ouve* age no
    // mesmo quadro. Um tick de diferença seria um bando que acorda em fila, e a emboscada em grupo
    // perderia a única coisa que a faz parecer emboscada — a simultaneidade.
    let viu = false;
    const meViu = new Map<Guerreiro, boolean>();
    for (const g of b.guerreiros) {
      const sim = !g.morto && b.satisfeita <= 0 && this.enxerga(g, b, player, altos);
      meViu.set(g, sim);
      if (sim) viu = true;
    }
    for (const g of b.guerreiros) {
      if (g.morto) { g.deathTimer += dt; continue; }
      g.golpe = Math.max(0, g.golpe - dt);
      g.grito = Math.max(0, g.grito - dt);
      this.passa(g, b, dt, ctx, player, altos, viu, meViu.get(g) === true);
    }
    // `satisfeita` é reavaliada depois das ações porque a entrega acontece dentro delas: o guerreiro
    // que chega ao poste no quadro N publica a calma e `passa` ainda devolve o resto da banda. Somar
    // a vista do quadro inteiro contra a calma que acabou de ser publicada deixaria o bando satisfeito
    // acordado — e `aldeiaEmDisputa` corta em 0,05, então a HUD gritaria 'ALDEIA ACORDADA' para quem
    // acabou de jantar, um quadro depois de o prisioneiro ser atado.
    if (viu && b.satisfeita <= 0) {
      b.visto = 0;
      b.alerta = Math.min(1, b.alerta + dt * 3);
    } else {
      b.visto += dt;
      b.alerta = Math.max(0, b.alerta - dt * 0.35);
      if (b.visto > VOLTA_A_CALMA_S) {
        for (const g of b.guerreiros) {
          if (g.morto) continue;
          g.carrega = false;
          if (g.estado !== 'patrulhando' && g.estado !== 'postado') g.estado = 'voltando';
        }
      }
    }
    this.tambor(b, dt, ctx, player);
  }

  /** A máquina de estados de um corpo. Cada transição é uma linha do contrato do lugar. */
  private passa(g: Guerreiro, b: Bando, dt: number, ctx: TriboContext, player: TriboCorpo,
    altos: { x: number; y: number; raio: number }[], viu: boolean, meViu: boolean): void {
    const d = Math.hypot(player.x - g.x, player.y - g.y);
    const acorda = viu && b.satisfeita <= 0;
    switch (g.estado) {
      case 'patrulhando':
      case 'postado':
        this.ronda(g, b, dt, ctx);
        if (acorda) this.chamado(g, b, ctx, meViu, d);
        return;
      case 'voltando': {
        const posto = pontoDoTrilho(b.ac, b.postos[g.posto]);
        this.movePara(g, b, dt, posto, PASSO_CAÇA_BASE * 0.7, ctx);
        if (Math.hypot(posto.x - g.x, posto.y - g.y) < 0.4) this.retomaRonda(g, b);
        if (acorda) this.chamado(g, b, ctx, meViu, d);
        return;
      }
      case 'avistando':
        // Braço no alto, corpo parado, grito no ar: o meio segundo em que ainda dá para virar as
        // costas e ir embora, e o quadro que conta a história do lugar inteiro.
        g.espera -= dt;
        g.velocidade = 0;
        this.viraPara(g, player);
        if (g.espera <= 0) { g.estado = 'cercando'; g.furor = Math.max(1, b.furor); }
        return;
      case 'cercando': {
        const alvo = pontoDeCorte(g, b.ac, player);
        this.movePara(g, b, dt, alvo, this.velocidade(g, b), ctx);
        if (Math.hypot(alvo.x - g.x, alvo.y - g.y) < 0.5) g.estado = 'perseguindo';
        else if (d <= GUERREIRO_ALCANCE && g.golpe <= 0) this.ergue(g, ctx, player, d);
        return;
      }
      case 'perseguindo':
        this.movePara(g, b, dt, player, this.velocidade(g, b), ctx);
        if (g.golpe <= 0 && d <= GUERREIRO_ALCANCE) {
          // O golpe que não mata de propósito: se o próximo porrete levasse o jogador abaixo do piso
          // do abolo e ele estiver a pé, o braço desce em vez de bater. É a diferença entre um
          // predador e uma execução, e o que faz a captura nascer do lugar, não de um sorteio.
          if (ctx.vidaDoJogador() - GUERREIRO_DANO < PISO_DO_ABOLO
            && ctx.aPé() && jurisdiçãoDaAldeia(b.ac, player.x, player.y)) {
            g.estado = 'capturando';
          } else this.ergue(g, ctx, player, d);
        }
        return;
      case 'batendo':
        g.espera = Math.max(0, g.espera - dt);
        g.velocidade = 0;
        if (g.espera <= 0) this.acerta(g, ctx, player, d);
        return;
      case 'capturando':
        // Ele fecha no corpo, não no braço. Se o jogador saiu da jurisdição ou entrou num carro no
        // meio do gesto, a captura simplesmente não aconteceu — não há estado preso esperando.
        this.viraPara(g, player);
        if (!ctx.aPé() || !jurisdiçãoDaAldeia(b.ac, player.x, player.y)) {
          g.estado = 'perseguindo';
          return;
        }
        if (d > GUERREIRO_ALCANCE + GOLPE_FOLGA) {
          this.movePara(g, b, dt, player, this.velocidade(g, b), ctx);
          return;
        }
        // Um corpo, um carregador. O destino da caminhada é o poste no fundo da clareira e não o
        // centro, e uma caminhada mais longa dá tempo de sobra para um segundo guerreiro fechar a
        // mesma porta: os dois escreveriam a cauda no mesmo quadro, um por vez, e o prisioneiro
        // apareceria na tela sendo puxado em duas direções ao mesmo tempo — pior, os dois sprites
        // com o braço cheio de alguém. Quem chega depois não disputa o corpo, bate.
        if (b.guerreiros.some((outro) => outro !== g && outro.carrega)) {
          g.estado = 'perseguindo';
          return;
        }
        g.estado = 'carregando';
        g.carrega = true;
        ctx.say('Te levando para o poste — atira neles', 3);
        ctx.shake(0.35);
        ctx.play('triboGrito', 0.7);
        return;
      case 'carregando': {
        if (!g.carrega) { g.estado = 'perseguindo'; return; }
        // A mesma porta do `capturando`, agora do lado de dentro do gesto: quem arrancou o corpo do
        // chão pode vê-lo subir num carro no meio do caminho — a clareira não proibe estacionar.
        // Sem esta saída o carregador continuaria puxando um corpo que está dentro de lataria, e o
        // `GameState` escreveria a coordenada do passageiro contra a do motorista no mesmo tick.
        if (!ctx.aPé()) { g.carrega = false; g.estado = 'perseguindo'; return; }
        // O destino é o poste, não o centro do terreiro. A fogueira é onde eles comem; o poste é
        // onde eles amarram, e um corpo largado no meio do terreiro teria de ser arrastado até lá
        // por uma mão que não existe — o `carregando` acaba aqui, e o cativeiro começa aqui.
        const poste = b.ac.poste;
        this.movePara(g, b, dt, poste, PASSO_DO_CARREGO, ctx);
        // O corpo na ponta da corda não é o guerreiro: é o jogador, com sprite, sombra e lugar
        // próprio na fila ordenada. Entregar as mesmas duas coordenadas empilharia os dois desenhos
        // num pixel só e o arrasto viraria um homem mais gordo, não dois. O ponto é o fim da
        // amarra, atrás de quem puxa — na direção oposta àquela para onde ele caminha.
        const cauda = { x: g.x - Math.cos(g.olhar) * DISTANCIA_DA_AMARRA,
          y: g.y - Math.sin(g.olhar) * DISTANCIA_DA_AMARRA };
        if (Math.hypot(poste.x - g.x, poste.y - g.y) > 0.8) {
          ctx.arrasta(cauda.x, cauda.y);
          return;
        }
        // Na chegada, a amarra não vale: o corpo é posto *no* ponto da amarra, e não a um passo
        // dela. O ponto é a soma dos dois raios, então o `empurraDoAcampamento` do próximo quadro o
        // vê encostado no poste e não dentro dele — é isto que dispensa o cativeiro de escrever
        // coordenada por tique para segurar o prisioneiro no lugar.
        const nó = pontoDaAmarra(b.ac, ctx.raioDoCorpo());
        ctx.arrasta(nó.x, nó.y);
        g.carrega = false;
        g.estado = 'voltando';
        b.satisfeita = PRAZO_DA_SACIEDADE;
        b.alerta = 0;
        b.visto = VOLTA_A_CALMA_S;
        // O bando inteiro devolve o posto: quem acabou de levar jantar não persegue quem deixou
        // para trás, e é isso que dá ao jogador uma janela real entre uma captura e a próxima.
        for (const outro of b.guerreiros) {
          if (outro.morto || outro === g) continue;
          outro.carrega = false;
          outro.estado = 'voltando';
        }
        ctx.captura(b.ac);
        return;
      }
      default:
        return;
    }
  }

  /**
   * Quem viu avisa em voz alta; quem ouviu corta pela frente.
   *
   * A separação é o mecanismo todo: se os que enxergam e os que só ouvem fizessem a mesma coisa, o
   * bando viraria uma patrulha de botos correndo atrás do mesmo calcanhar. O grito é do primeiro, o
   * deslocamento de flanco é dos demais, e o jogador no meio dos dois é a cena que a aldeia existe
   * para dar.
   */
  private chamado(g: Guerreiro, b: Bando, ctx: TriboContext, meViu: boolean, d: number): void {
    if (meViu) {
      g.estado = 'avistando';
      g.espera = GUERREIRO_AVISO_S;
      // O corpo para no mesmo tick do braço no alto: `ronda` acabou de publicar o passo da patrulha,
      // e um sentinela desenhado em pose de aviso ainda deslizando pelo trilho é a diferença entre
      // um grito e um boneco empurrado. É o que `ergue` já faz com o porrete.
      g.velocidade = 0;
      g.furor = Math.max(1, b.furor);
      b.alerta = Math.max(b.alerta, 0.6);
      if (g.grito > 0) return;
      g.grito = GRITO_S;
      ctx.play('triboGrito', 0.85 * Math.max(0.15, 1 - d / VOZ_ALCANCE));
      const face = faceDaFronteira(b.ac.x, b.ac.y, ctx.worldW, ctx.worldH);
      ctx.say(face ? `Um deles te viu — ${NOME_DA_FACE[face]}` : 'Um deles te viu', 2.8);
      return;
    }
    g.estado = 'cercando';
    g.furor = Math.max(1, b.furor);
  }

  /** Erguer o porrete: o dano só vem depois de um windup que o jogador vê na tela. */
  private ergue(g: Guerreiro, ctx: TriboContext, player: TriboCorpo, d: number): void {
    g.estado = 'batendo';
    g.espera = GUERREIRO_WINDUP;
    g.velocidade = 0;
    this.viraPara(g, player);
    if (g.grito <= 0 && d < 14) {
      g.grito = GRITO_S;
      ctx.play('triboGrito', 0.4);
    }
  }

  /** O braço que desce: dano pelo `HealthSystem`, meio tile de recuo e o som do corpo. */
  private acerta(g: Guerreiro, ctx: TriboContext, player: TriboCorpo, d: number): void {
    g.estado = 'perseguindo';
    g.golpe = GUERREIRO_CADENCIA;
    if (d > GUERREIRO_ALCANCE + GOLPE_FOLGA) return;
    if (!ctx.damages(GUERREIRO_DANO)) return;
    const nx = d > 1e-4 ? (player.x - g.x) / d : 0;
    const ny = d > 1e-4 ? (player.y - g.y) / d : 0;
    player.x += nx * GOLPE_RECUO;
    player.y += ny * GOLPE_RECUO;
    ctx.shake(0.3);
    ctx.play('bodyHit', 0.6);
  }

  private viraPara(g: Guerreiro, alvo: TriboCorpo): void {
    const dx = alvo.x - g.x, dy = alvo.y - g.y;
    if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) return;
    g.olhar = Math.atan2(dy, dx);
    g.dir = dirDe(g.olhar);
  }

  private velocidade(g: Guerreiro, b: Bando): number {
    return Math.min(PASSO_CAÇA_TETO, PASSO_CAÇA_BASE + Math.max(g.furor, b.furor) * PASSO_POR_FUROR);
  }

  /** Andar livre: a casa que você vê é a casa que barra o passo, inclusive para eles. */
  private movePara(g: Guerreiro, b: Bando, dt: number, alvo: { x: number; y: number },
    velocidade: number, ctx: TriboContext): void {
    const dx = alvo.x - g.x, dy = alvo.y - g.y;
    const d = Math.hypot(dx, dy);
    if (d < 1e-4) { g.velocidade = 0; return; }
    const passo = Math.min(velocidade * dt, d);
    g.x += (dx / d) * passo;
    g.y += (dy / d) * passo;
    this.viraPara(g, alvo);
    g.velocidade = Math.min(velocidade, passo / Math.max(dt, 1e-6));
    this.prendeAoTerritório(g, b);
    const corpo = { x: g.x, y: g.y, radius: GUERREIRO_RAIO };
    if (empurraDoAcampamento(corpo, ctx.worldW, ctx.worldH, ctx.água)) {
      g.x = corpo.x;
      g.y = corpo.y;
    }
    if (ctx.isVisible(g.x, g.y)) g.animTime += dt;
  }

  /**
   * O limite do bando: eles não saem da jurisdição.
   *
   * Não é covardia, é alçada — o contrato que faz a fronteira ter lugares com donos diferentes, e a
   * razão de `terraDaAldeia` existir como função única. A borda dilatada deixa o sentinela chegar à
   * trilha, onde o jogador aparece, mas nunca a dois terços de célula para fora: lá ele seria um
   * pedestre qualquer correndo pelo mapa, e a aldeia voltaria a ser desenho.
   */
  private prendeAoTerritório(g: Guerreiro, b: Bando): void {
    const ac = b.ac;
    const u = (g.x - ac.x) / ac.meiaLargura;
    const v = (g.y - ac.y) / ac.meiaAltura;
    const r = Math.hypot(u, v);
    if (r <= FOLGA_DA_JURISDIÇÃO) return;
    const k = FOLGA_DA_JURISDIÇÃO / r;
    g.x = ac.x + u * k * ac.meiaLargura;
    g.y = ac.y + v * k * ac.meiaAltura;
  }

  /** O corpo parado e os olhos em farol: o posto varre a mata sem sair do lugar. */
  private varredura(ac: Acampamento, g: Guerreiro): number {
    return normalDoTrilho(ac, g.trilhoθ) + Math.sin(this.tempo * 0.8 + g.posto) * 0.9;
  }

  /** O circuito: andar no trilho e parar no próprio posto para varrer a mata com os olhos. */
  private ronda(g: Guerreiro, b: Bando, dt: number, ctx: TriboContext): void {
    const ac = b.ac;
    if (g.estado === 'postado') {
      g.espera -= dt;
      g.velocidade = 0;
      // A varredura da sentinela: o corpo não gira, os olhos vão de um lado ao outro. É o que faz o
      // cone de visão existir antes de qualquer sprite — o poste parado que enxerga.
      g.olhar = this.varredura(ac, g);
      g.dir = dirDe(g.olhar);
      if (g.espera <= 0) g.estado = 'patrulhando';
      return;
    }
    const θ = g.trilhoθ;
    const posto = b.postos[g.posto];
    const novo = θ + g.trilhoSentido * (PASSO_PATRULHA * dt) / arcoDoTrilho(ac, θ);
    // O posto pelo qual ele passa é a pausa: a distância angular com sinal trocado no sentido da
    // caminhada é o "cruzou a linha", e é lida do trilho, não de um relógio — um sentinela atrasado
    // por causa de um quadro longo ainda para no lugar certo.
    const antes = anguloDelta(θ, posto) * g.trilhoSentido;
    const depois = anguloDelta(novo, posto) * g.trilhoSentido;
    const chegou = antes >= 0 && depois <= 0;
    g.trilhoθ = chegou ? posto : novo;
    if (chegou) {
      g.estado = 'postado';
      g.espera = 2.2 + sorte(ac.cx, ac.cy, 240 + g.posto) * 2.4;
    }
    const p = pontoDoTrilho(ac, g.trilhoθ);
    g.x = p.x;
    g.y = p.y;
    // O quadro da chegada já é o quadro parado. Deixar o passo da ronda publicado por mais um tick
    // seria um sentinela desenhado de pé escorregando até o posto — e é o primeiro tick de `postado`
    // que a tela vê, não o segundo.
    g.velocidade = chegou ? 0 : PASSO_PATRULHA;
    // Andando ele olha para frente do circuito: com quatro corpos em ângulos diferentes a volta
    // inteira é varrida em meia volta, e o cone de um sentinela que só olhasse para fora deixaria
    // entrar alguém pela porta ao lado dele.
    g.olhar = chegou ? this.varredura(ac, g) : rumoDoTrilho(ac, g.trilhoθ, g.trilhoSentido);
    g.dir = dirDe(g.olhar);
    if (ctx.isVisible(g.x, g.y)) g.animTime += dt;
  }

  /** Devolver o corpo ao trilho com o ângulo que ele tem agora: sem salto, sem teleporte. */
  private retomaRonda(g: Guerreiro, b: Bando): void {
    const ac = b.ac;
    g.trilhoθ = Math.atan2((g.y - ac.y) / ac.meiaAltura, (g.x - ac.x) / ac.meiaLargura);
    g.estado = 'patrulhando';
    g.velocidade = 0;
    g.olhar = normalDoTrilho(ac, g.trilhoθ);
    g.dir = dirDe(g.olhar);
  }

  /** O cone: distância, ângulo da postura e o que a casa põe no meio do caminho. */
  private enxerga(g: Guerreiro, b: Bando, player: TriboCorpo,
    altos: { x: number; y: number; raio: number }[]): boolean {
    const dx = player.x - g.x, dy = player.y - g.y;
    const d = Math.hypot(dx, dy);
    if (d > OLHO_TILES) return false;
    if (!jurisdiçãoDaAldeia(b.ac, player.x, player.y)) return false;
    const cos = (dx * Math.cos(g.olhar) + dy * Math.sin(g.olhar)) / (d || 1);
    if (cos < OLHO_COS) return false;
    return !bloqueado(altos, g.x, g.y, player.x, player.y);
  }

  /**
   * O tambor do bando. É o único som contínuo daqui e existe por um motivo: um acampamento que só se
   * anuncia no grito é um lugar que só existe no instante em que você é visto. O tambor vem com o
   * alerta subindo, fraco e longe, e é o que faz a aldeia ser ouvida antes de ser vista — a mesma
   * função do urro distante na mata.
   */
  private tambor(b: Bando, dt: number, ctx: TriboContext, player: TriboCorpo): void {
    if (b.alerta <= 0.15) return;
    b.tambor -= dt;
    if (b.tambor > 0) return;
    b.tambor = TAMBOR_S;
    const perto = 1 - Math.hypot(b.ac.x - player.x, b.ac.y - player.y) / VOZ_ALCANCE;
    if (perto <= 0) return;
    ctx.play('triboTambor', 0.5 * perto * b.alerta);
  }

  /**
   * A única porta do dano que eles recebem: quem mira um corpo chama esta função com o id dele. Um
   * companheiro caído acorda os demais — a fronteira inteira ensina que atirar não espanta, acelera,
   * e aqui isso é um número e não uma frase.
   */
  fere(id: number, amount: number): boolean {
    for (const b of this.bandas.values()) {
      const g = b.guerreiros.find((x) => x.id === id);
      if (!g || g.morto) continue;
      const letal = fereGuerreiro(g, amount);
      if (!letal) return false;
      // A morte de um companheiro empurra o bando acima do piso de quem já está brigando: `chamado`
      // acorda cada corpo com furor 1, então somar 0,34 a um bando em 0 seria um número que ninguém
      // herda — e a lição da fronteira é que abater um deles acelera a briga, não a mantém igual.
      b.furor = Math.min(FUROR_TETO, Math.max(1, b.furor) + FUROR_DA_MORTE);
      b.alerta = 1;
      for (const outro of b.guerreiros) {
        if (outro === g || outro.morto) continue;
        // A fúria é do bando, não de quem estava parado: sem esta linha, matar um guerreiro no meio
        // da briga não aceleraria a briga. `max` porque o corpo que acordou com o terceiro
        // companheiro caído já carrega um furor próprio, que um saldo anterior não pode apagar.
        outro.furor = Math.max(outro.furor, b.furor);
        if (outro.estado === 'patrulhando' || outro.estado === 'postado'
          || outro.estado === 'voltando' || outro.estado === 'avistando') outro.estado = 'cercando';
      }
      return true;
    }
    return false;
  }

  /** Quantos corpos o mundo tem agora — a métrica do painel e a única forma de o check ler a lista. */
  stats(): { bandas: number; guerreiros: number; alerta: number } {
    let n = 0;
    for (const b of this.bandas.values()) n += b.guerreiros.length;
    return { bandas: this.bandas.size, guerreiros: n, alerta: this.perigo };
  }
}

/**
 * O ponto que corta o caminho do jogador: o trilho do lado de fora, adiante dele.
 *
 * Exportado porque a rota do flanco só é provável de medir contra a própria regra: o check que
 * cobra "quem só ouviu o grito corta pela frente" teria de copiar o arco de meia volta e o
 * sentido de cada corpo, e uma cópia aqui envelheceria justo quando o ângulo do corte mudar.
 */
export function pontoDeCorte(g: Guerreiro, ac: Acampamento, player: TriboCorpo): { x: number; y: number } {
  const θ = Math.atan2((player.y - ac.y) / ac.meiaAltura, (player.x - ac.x) / ac.meiaLargura)
    + Math.PI * 0.62 * (g.trilhoSentido >= 0 ? 1 : -1);
  // Meio arco à frente, no sentido em que este corpo já estava andando: é o flanco que fecha na
  // frente de quem entra, sem que os dois interceptadores do bando concorram pelo mesmo ponto.
  return pontoDoTrilho(ac, θ);
}
