import {
  GORILA_ALCANCE_SOCO, GORILA_CADAVER_S, GORILA_CADENCIA, GORILA_DANO_SOCO, GORILA_RAIO,
  GORILA_WINDUP, PEITO_CICLO, criaGorila, fereGorila, type Gorila,
} from '../entities/Gorila';
import type { Dir4 } from '../game/GameConfig';
import {
  NOME_DA_FACE, PROFUNDIDADE_SEM_NOME, type ConsultaDeÁgua, faceDaFronteira, foraDoMapa,
  limiteJogável, nomeDaTerra, profundidade, sorte,
} from '../world/Frontier';
import { expulsaDaClareira, terraDaAldeia } from '../world/Tribo';

/**
 * A cobrança da fronteira.
 *
 * A mata sem fim foi construída como função da coordenada: ela nunca acaba, e é exatamente
 * por isso que ela precisa *custar* alguma coisa. Sem custo, andar cem tiles para fora é só
 * um cenário mais largo — o jogador não sente diferença entre a beira do mapa e o meio da
 * mata velha, e a fronteira vira paisagem de fundo. O que transforma distância em mecânica é
 * uma única regra: a terra cobra quem insiste nela.
 *
 * A cobrança é um número acumulado no tempo em que o jogador está fora, ponderado pela
 * profundidade. Ela existe antes de existir qualquer fera: o primeiro efeito dela é um urro
 * longínquo e uma frase na HUD, o segundo é o corpo que se levanta. Isso é o que faz a
 * fronteira parecer viva em vez de parecer um gatilho — quem passou um minuto na mata fechada
 * ouve a coisa antes de vê-la, e quem só cutucou a orla não ouve nada.
 *
 * O resto do contrato é o que não deixa a mecânica virar chatice:
 * — **correr para fora não escapa.** Ele nasce sempre mais fundo do que você;
 * — **correr para dentro escapa.** Ele não pisa a cidade, e é por isso que a dívida tem
 *   prazo: voltar para o asfalto a apaga, mas devagar;
 * — **atirar não espanta, acelera.** Cada acerto aumenta o rancor com que aquele indivíduo
 *   foi criado, e o rancor é a velocidade dele;
 * — **matar não perdoa.** A dívida cai para o piso do aviso, não para zero;
 * — **a clareira pintada não é dele.** Onde a terra é pisada por um acampamento a mata para de
 *   cobrar e o corpo contorna: o mesmo predicado que devolve o nadador à piranha, agora com um
 *   terceiro predador na régua, e a aldeia com uma casa em vez de um cenário no meio da caçada;
 * — **a terra sem nome não é dele.** A banda da caçada termina exatamente na porta da tribo
 *   (`PROFUNDIDADE_SEM_NOME`), e é isso que faz as duas ameaças do fim do mundo serem *procuráveis*
 *   uma de cada vez: quem quer o gigante anda até a mata velha, quem quer a aldeia atravessa a
 *   linha e não vê mais bicho nenhum — só os deles;
 * — **a cidade é um lugar, não um menu.** Quem entra numa sala congela a rua — o trânsito, a
 *   polícia e este gigante juntos, pela mesma razão: o plano do interior não é uma coordenada
 *   do mapa, então lá dentro não há profundidade nenhuma para cobrar.
 */

// ---- a régua da cobrança ----
// Os números abaixo não são "dificuldade": são o tempo que o jogador leva para ser caçado
// andando devagar. Na medição do arcos abaixo, atravassar 40 tiles de mata a pé dá ~0,5 de
// dívida — o aviso, não a fera — enquanto acampar na mata velha dá 1,0 em ~40 s.
/** Por segundo, na orla: a beira do mapa quase não cobra, e é de propósito. */
const COBRANÇA_BASE = 0.006;
/** Cada tile de profundidade acrescenta isto ao preço por segundo. É o que faz a mata velha doer. */
const COBRANÇA_POR_TILE = 0.0014;
/** Teto da taxa: a ~60 tiles de profundidade a cobrança já é a máxima e não cresce mais. */
const COBRANÇA_TETO = 0.09;
/** Em dívida por segundo dentro do mapa: ~30 s de asfalto apagam o preço de uma travessia. */
const ESQUECIMENTO = 0.035;
/** A partir daqui a fronteira avisa (urro distante + uma frase). Não nasce nada ainda. */
const LIMIAR_DO_AVISO = 0.5;
/** A dívida que compra a fera. */
const LIMIAR_DA_CAÇADA = 1;
/** O teto da dívida: acima disso o mundo já cobra o máximo, e mais tempo não muda nada. */
const COBRANÇA_MÁXIMA = 2.4;
/** Dívida que sobra quando ele se retira, e quando cai. Matar não perdoa nada. */
const DÍVIDA_DA_RETIRADA = 0.62;
const DÍVIDA_DA_QUEDA = 1.3;

// ---- o corpo ----
/**
 * Profundidade mínima para *qualquer* coisa nascer. Seis tiles: a `nomeDaTerra` chama de
 * "orla" tudo abaixo de três e de "mata fechada" até doze, então o gatilho fica dentro da
 * segunda — quem parou cinco minutos na beirada do mapa ouve a mata quieta, quem acampou na
 * mata fechada é caçado. Uma fronteira que morde a orla vira muro, e o pedido foi o contrário.
 */
const PROFUNDIDADE_DA_COBRA = 6;
/**
 * O teto da mata dele: a partir desta profundidade a fronteira é outra coisa, e o gigante não
 * entra. A linha não é um número inventado aqui — é exatamente a porta da tribo, a mesma
 * `PROFUNDIDADE_SEM_NOME` que faz a HUD trocar de nome e que faz existir um acampamento. Isso é
 * o que separa os dois predadores de verdade: uma posse sorteada por hash daria uma borda
 * irregular que nenhum jogador leria, enquanto a borda que ele *ouve* (a mata velha acabando e a
 * terra sem nome começando) é a mesma borda que os dois sistemas obedecem.
 *
 * Sem esta regra, o gigante continuaria caçando fundo na terra deles: quem descesse ao território
 * encontraria os dois, um cobrando dívida no mesmo relógio do outro, e a aldeia — que é o evento
 * que o jogador procura — viraria ruído dentro da caçada do bicho. Com ela, cada banda tem um dono
 * e os dois são encontráveis de propósito: a mata velha é onde ele se levanta, a terra sem nome é
 * onde eles patrulham.
 */
const TERRA_DO_GIGANTE = PROFUNDIDADE_SEM_NOME;
/** Fundo da banda, com um tile de folga: o ponto de emergência nunca risca a linha. */
const LIMITE_DA_BANDA = TERRA_DO_GIGANTE - 1;
/** Distância, em tiles, do ponto de emergência. Sempre fora da janela de névoa. */
const AFASTAMENTO_MÍNIMO = 22;
const AFASTAMENTO_MÁXIMO = 34;
/** Ele para a uns cinco tiles da borda: nem na cidade, nem visível da rua. */
const PROFUNDIDADE_DA_RETIRADA = 5;
/** Um indivíduo a menos: quanto tempo a terra leva para criar o próximo. */
const RENASCER_S = 22;
/** A fase de aviso: ele atravessa a mata de pé, devagar, e o jogador tem este tempo para correr. */
const ESPEITA_S = 2.4;
const PASSO_DO_AVISO = 0.42;
/** Velocidade: base + rancor. Com a dívida cheia ele é mais rápido que a corrida do jogador. */
const PASSO_BASE = 3.4;
const PASSO_POR_RANCOR = 0.9;
/** Intervalo do urro durante a caçada. */
const URRO_S = 9;
/** Queda do urro com a distância, em tiles: além daqui ninguém ouve nada. */
const URRO_ALCANCE = 60;
/** Recuo do corpo no impacto do soco — é o que faz a coisa parecer pesar duas toneladas. */
const SOCO_RECUO = 1.4;
/** A tolerância do golpe: o braço não é um raio rígido, e um "errou" de 3 cm seria injusto. */
const SOCO_FOLGA = 0.35;
/** Além desta distância ele deixa de ser uma ameaça e vira um ponto no mapa: some. */
const ABANDONO_TILES = 90;

/**
 * O corpo que a fera persegue. É o `Player` do jogo, visto por duas coordenadas — e só: o
 * alcance do braço já conta o corpo dele (`GORILA_ALCANCE_SOCO` é braço, não raio do alvo),
 * então pedir um raio ao jogador seria um campo que ninguém lê cobrando um nome que o
 * jogador não tem.
 */
export interface GorilaCorpo {
  x: number;
  y: number;
}

/** O mínimo de estrutura que o sistema precisa do mundo. O `GameState` real satisfaz isto. */
export interface GorilaContext {
  /** Dimensões da grade da cidade, em tiles de mundo — a fronteira é o que está além delas. */
  worldW: number;
  worldH: number;
  /**
   * `null` quando o jogador está dentro de uma sala: a rua congela, e a fera com ela — o
   * mesmo contrato do trânsito e da polícia, pela mesma razão.
   */
  player: GorilaCorpo | null;
  /** Onde a cidade enxerga o jogador: dentro de uma sala é o pé da porta, não o `player.x`. */
  worldPosition: { x: number; y: number };
  /**
   * A consulta de água do mundo — a mesma que a frente usa para não plantar árvore no canal. É
   * ela que diz a este sistema onde a mata termina e o rio começa, e portanto onde a dívida deixa
   * de ser dele. O `Map` real satisfaz a interface; exigi-la aqui em vez de uma flag é o que
   * impede os dois predadores de cobrarem o mesmo trecho.
   */
  água: ConsultaDeÁgua;
  /** O único ponto de dano do jogador. É isto que respeita `invulnUntil`. */
  damages: (amount: number) => boolean;
  shake: (amount: number) => void;
  say: (text: string, seconds?: number) => void;
  play: (key: 'gorillaRoar' | 'gorillaStep' | 'bodyHit', volume: number) => void;
  isVisible: (x: number, y: number) => boolean;
  onStructChange: () => void;
}

/**
 * O ponto de emergência: o círculo de `alcance` tiles em volta do jogador, recortado pela banda.
 *
 * Três regras não são negociáveis: o ponto é **mais fundo** que o jogador (correr para fora nunca
 * te põe na frente dele), está a uma distância que a janela de névoa não alcança (ele se levanta
 * fora da tela e chega andando, em vez de aparecer em cima do jogador) e **pisa a banda dele**
 * (`LIMITE_DA_BANDA`): um gigante levantando na porta da aldeia seria os dois predadores cobrando
 * o mesmo corpo, e a posse resolvida na dívida continuaria quebrada no mapa.
 *
 * As três juntas não cabem numa fórmula de uma linha porque a profundidade não é um eixo: é a
 * **distância ao retângulo** do mapa. Numa face, andar de lado não muda a profundidade nenhuma e o
 * afastamento inteiro pode ser lateral; num canto, andar de lado *aumenta* a profundidade, porque
 * ela passa a ser a hipotenusa dos dois eixos. Resolver isso com pitágoras num eixo só — o que
 * esta função fazia — punha a fera a 60 tiles de fundo atrás de um jogador que estava a 30: nem na
 * banda, nem perto dele, nem em lugar nenhum que a HUD nomeia. Então o ângulo é escolhido contra a
 * **medida real** (`profundidade`), e os dois sinais do sorteio são candidatos: o hash decide o
 * lado preferido, a terra medida decide qual dos dois sobrevive.
 *
 * O `sal` 21 é um eixo do mesmo hash que desenha as árvores, então a mesma coordenada dá a mesma
 * emboscada em qualquer aparelho, e um check em memória pode recalcular o ponto.
 */
export function pontoDeEmergência(px: number, py: number, W: number, H: number): { x: number; y: number } {
  const tx = Math.floor(px), ty = Math.floor(py);
  const alcance = AFASTAMENTO_MÍNIMO + sorte(tx, ty, 21) * (AFASTAMENTO_MÁXIMO - AFASTAMENTO_MÍNIMO);
  const minha = profundidade(px, py, W, H);
  // O frame de saída: do ponto do mapa mais perto até o jogador é exatamente o vetor de
  // profundidade, e girar esse vetor é o único movimento que não muda de terra. Quem está dentro do
  // mapa não tem vetor nenhum — aí a normal da face mais perto faz o papel, porque para ele "para
  // fora" ainda é uma escolha de direção, não uma consequência da coordenada.
  let ux = 0, uy = 0;
  if (minha > 1e-6) {
    ux = (px - Math.min(W, Math.max(0, px))) / minha;
    uy = (py - Math.min(H, Math.max(0, py))) / minha;
  } else {
    const norte = py, oeste = px, sul = H - py, leste = W - px;
    const menor = Math.min(norte, oeste, sul, leste);
    if (menor === norte) uy = -1;
    else if (menor === oeste) ux = -1;
    else if (menor === sul) uy = 1;
    else ux = 1;
  }
  // Perpendicular à saída, com o sinal do sorteio: é o "para que lado da mata ele contorna".
  const sinal = sorte(tx, ty, 22) < 0.5 ? -1 : 1;
  const lx = -uy * sinal, ly = ux * sinal;
  const alvo = Math.min(LIMITE_DA_BANDA, minha + alcance);
  const girar = (φ: number) => ({
    x: px + alcance * (ux * Math.cos(φ) + lx * Math.sin(φ)),
    y: py + alcance * (uy * Math.cos(φ) + ly * Math.sin(φ)),
  });
  const prende = (v: number) => Math.max(-1, Math.min(1, v));
  // Três famílias de ângulo, do mais provável para o mais bruto: reto para fora (o caso em que a
  // banda ainda tem folga para o afastamento todo), a solução da face (só a componente normal
  // conta), a lei dos cossenos em torno do ponto mais perto (o caso do canto), e uma varredura. A
  // varredura existe porque nenhuma das três analíticas sabe onde o canto do mapa começa: um
  // desvio lateral de trinta tiles numa face longa atravessa o canto, e aí a conta boa deixa de
  // ser a da face — medir os vinte e quatro e escolher o que pousa na terra é o que faz a resposta
  // sair do mapa real e não de um chute que costuma dar certo.
  const ângulos = [0,
    Math.acos(prende((alvo - minha) / alcance)),
    Math.acos(prende((alvo * alvo - minha * minha - alcance * alcance) / (2 * Math.max(1e-6, minha) * alcance)))];
  for (let i = 1; i <= 24; i++) ângulos.push(i * Math.PI / 12);
  let melhor = girar(0);
  let melhorNota = Infinity;
  for (const φ of ângulos) {
    // Os dois lados do ângulo: num canto, um deles atravessa a porta da tribo e o outro continua
    // sendo mata dele. O hash já escolheu um `sinal`, e ele só desempata — quem decide é a terra
    // medida, porque um ponto na terra deles não é um gigante atrasado, é um gigante errado.
    for (const lado of [sinal, -sinal]) {
      const cand = girar(φ * lado);
      const dele = profundidade(cand.x, cand.y, W, H);
      // Nota lexicográfica disfarçada de soma. A parede dura é a terra deles (`TERRA_DO_GIGANTE`),
      // não o teto da banda: o `LIMITE_DA_BANDA` é um tile de folga, e num canto fundo um ângulo
      // pode pousar no fio da linha sem conseguir jamais ser mais fundo que o jogador e ainda
      // dentro dele — trocar esse ponto por um nascimento raso dentro da mata seria trocar a regra
      // que o jogador lê ("correr para fora não te põe na frente dele") por uma folga de um tile,
      // que ele não lê. Depois: mais fundo que ele, e o mais perto do fundo da terra dele.
      const nota = (dele >= TERRA_DO_GIGANTE ? 1000 : 0) + (dele <= minha ? 100 : 0)
        + Math.abs(dele - alvo);
      if (nota < melhorNota) { melhorNota = nota; melhor = cand; }
    }
  }
  const born = { x: limiteJogável(melhor.x, W, GORILA_RAIO), y: limiteJogável(melhor.y, H, GORILA_RAIO) };
  seguraNaBanda(born, W, H);
  return born;
}

/**
 * Puxa um corpo de volta para a banda do gigante, escalando o vetor de saída dele.
 *
 * A profundidade é a distância ao retângulo do mapa, então a única escala que a faz pousar
 * exatamente na linha é a do vetor entre o ponto mais perto do mapa e o corpo. Mexer numa
 * componente só — o que esta função fazia, pela normal de uma face — é pior que não fazer nada num
 * canto: lá o corpo sai por dois eixos ao mesmo tempo, encurtar um deles deixa a hipotenusa dos
 * dois onde estava, e o sinal trocado ainda empurrava o gigante para *dentro* da terra deles. O
 * `LIMITE_DA_BANDA / prof` encolhe os dois eixos na mesma razão, e por isso o ponto que sobe a
 * diagonal de um canto desce por ela.
 *
 * É o espelho do `expulsaDaClareira`: de um lado a aldeia barra o bicho, do outro a banda dele
 * barra a si mesmo. Exportada porque a prova que importa não é "ele evita" e sim "ele nunca pisa"
 * — um check que só olha a decisão do sistema não vê o tick em que o passo atravessou a linha.
 * Devolve se mexeu, para quem chama poder contar o empurrão em vez de confiar na intenção.
 */
export function seguraNaBanda(corpo: { x: number; y: number }, W: number, H: number): boolean {
  const prof = profundidade(corpo.x, corpo.y, W, H);
  if (prof <= LIMITE_DA_BANDA) return false;
  const k = LIMITE_DA_BANDA / prof;
  const cx = Math.min(W, Math.max(0, corpo.x));
  const cy = Math.min(H, Math.max(0, corpo.y));
  corpo.x = cx + (corpo.x - cx) * k;
  corpo.y = cy + (corpo.y - cy) * k;
  return true;
}

/** A conta por segundo, na profundidade dada. Exportada porque o check cobra a régua, não o feel. */
export function taxaDaCobrança(prof: number): number {
  return Math.min(COBRANÇA_TETO, COBRANÇA_BASE + Math.max(0, prof) * COBRANÇA_POR_TILE);
}

/** A velocidade de um indivíduo criado com esta dívida. */
export function velocidadeDaFera(rancor: number): number {
  return PASSO_BASE + rancor * PASSO_POR_RANCOR;
}

/** A frase da HUD, com a primeira letra em maiúscula: o jogo fala em frases, não em campos. */
function frase(texto: string): string {
  return texto.charAt(0).toUpperCase() + texto.slice(1);
}

export class GorilaSystem {
  /**
   * A dívida acumulada. Pública porque a HUD lê: "a mata fechada" é o *lugar*, isto é o
   * *quanto* o lugar está cobrando, e as duas coisas juntas são a frase que o jogador lê
   * antes de ver qualquer coisa.
   */
  rancor = 0;
  /** O corpo do mundo, ou `null` quando ninguém se levantou ainda. */
  fera: Gorila | null = null;
  /** Prazo para o próximo indivíduo; corre mesmo com um cadáver na tela. */
  private espera = 0;
  private avisoFeito = false;
  private urro = 0;

  /** Perigo lido pela HUD: 0 na cidade, 1 no instante em que a fera nasce. */
  get perigo(): number {
    return Math.min(1, this.rancor / LIMIAR_DA_CAÇADA);
  }

  /** A fera viva que um tiro pode acertar, ou `null`. É a única porta do alvo. */
  get alvo(): Gorila | null {
    const g = this.fera;
    return g && !g.morto ? g : null;
  }

  /** O nome da terra onde o jogador está, na fala do jogo. `null` dentro de uma sala. */
  terra(player: { x: number; y: number } | null, W: number, H: number): string {
    if (!player) return nomeDaTerra(0);
    return nomeDaTerra(profundidade(player.x, player.y, W, H));
  }

  /** Para onde ele saiu, na fala do jogo — `null` enquanto ele estiver dentro do mapa. */
  face(player: { x: number; y: number } | null, W: number, H: number): Dir4 | null {
    return player ? faceDaFronteira(player.x, player.y, W, H) : null;
  }

  /**
   * Cobra uma dívida que não veio do andar.
   *
   * A mata acumula preço segundo a segundo, mas nem todo mundo chega nela a pé: uma aeronave que
   * cai lá dentro atravessou o trecho inteiro de uma vez, e o preço tem de ser pago de uma vez. É
   * só um `max`, e é por isso que a method existe — sem ela, quem quisesse cobrar teria de escrever
   * em `rancor` por fora, e aí a régua da fronteira deixaria de ter um único dono.
   *
   * Não nasce fera daqui: quem decide é o `update`, com a mesma regra de profundidade de sempre.
   * Cobrar sobre o asfalto não levanta gigante nenhum, porque o gigante não pisa a cidade — mas o
   * número fica, e é ele que pega quem desceu voando e resolveu ir a pé.
   */
  cobra(dívida: number): void {
    if (!Number.isFinite(dívida) || dívida <= 0) return;
    this.rancor = Math.min(COBRANÇA_MÁXIMA, Math.max(this.rancor, dívida));
  }

  /**
   * O tick. Um único ponto de escrita no corpo do gigante: quem chama é o `GameState`, depois
   * de todo mundo ter se movido, porque a fera persegue o jogador *onde ele está neste quadro*.
   */
  update(dt: number, ctx: GorilaContext): void {
    if (!Number.isFinite(dt) || dt <= 0) return;
    // Sala aberta: sem coordenada do mundo, não há profundidade, e sem profundidade não há
    // cobrança — o corpo fica onde a porta o deixou, exatamente como o sedã parado na rua.
    if (!ctx.player) return;
    const { player, worldW: W, worldH: H } = ctx;
    const prof = profundidade(ctx.worldPosition.x, ctx.worldPosition.y, W, H);

    this.espera = Math.max(0, this.espera - dt);

    // A terra cobra quem insiste nela, mas não cobra duas vezes pelo mesmo trecho: com um corpo
    // vivo atrás de você a dívida está congelada, porque o preço daquele pedaço de mata já foi
    // pago com a fera. Deixar o número subir com a caçada em curso faria a fronteira virar uma
    // fila de gigantes no instante em que o primeiro caísse — e a HUD leria perigo 1 o tempo
    // todo, que é o mesmo que não ler nada.
    const cobrando = !this.fera || this.fera.morto;
    // O rio pertence à piranha. Não é uma concessão ao nadador — é a única forma de a fronteira
    // ter UM dono por trecho: sem este teste, quem descesse ao canal além da grade acumularia as
    // duas dívidas na mesma régua e veria o gigante levantar no meio d'água para depois ver a
    // barbatana subir no mesmo lugar. A mata continua cobrando quem encosta na margem, porque a
    // consulta é do corpo, não da vontade.
    const naÁgua = prof > 0 && ctx.água.isWaterWorld(player.x, player.y);
    // A clareira de terra pisada é casa de outra coisa, e a posse tem de ser uma pergunta só: o
    // mesmo predicado que faz o chão parar de plantar árvore, que o guerreiro usa para saber a
    // quem defender e que a HUD usa para nomear o lugar. Deixar o gigante cobrar quem está sentado
    // ao lado da fogueira seria o bug exato que o rio já não tem: duas feras donas do mesmo ponto,
    // uma dívida dupla na mesma régua e um urro subindo debaixo de um corpo que já tem dono.
    const naPisada = prof > 0 && terraDaAldeia(player.x, player.y, W, H, ctx.água);
    // E o fundo inteiro é deles, não só a clareira: a banda do gigante acaba na porta da tribo, e
    // cobrar dívida além dela seria o gigante disputando com o guerreiro o mesmo jogador — o bug
    // que o rio não tem, resolvido pela mesma régua, agora com um número em vez de um hash.
    const naTerraDels = prof >= TERRA_DO_GIGANTE;
    if (prof > 0) {
      if (cobrando && !naÁgua && !naPisada && !naTerraDels) {
        this.rancor = Math.min(COBRANÇA_MÁXIMA, this.rancor + taxaDaCobrança(prof) * dt);
      }
    } else {
      this.rancor = Math.max(0, this.rancor - ESQUECIMENTO * dt);
      this.avisoFeito = false;
    }

    if (!this.fera && !naÁgua && !naPisada && !naTerraDels
      && this.rancor >= LIMIAR_DO_AVISO && !this.avisoFeito) {
      this.avisoFeito = true;
      const face = faceDaFronteira(player.x, player.y, W, H);
      // Só faz sentido dizer que a mata está quieta para quem ainda não vê nada: a frase é o
      // piso do mecanismo e o urro distante é o teto. Ela não se repete dentro da mesma
      // dívida — volta quando o jogador pisa o asfalto e sai de novo.
      ctx.say(frase(`${nomeDaTerra(prof)} está quieta demais — ${face ? NOME_DA_FACE[face] : 'a mata'}`), 3.6);
      ctx.play('gorillaRoar', 0.16);
    }

    if (!this.fera && !naÁgua && !naPisada && this.deveNascer(prof)) this.nasce(ctx, player);

    const g = this.fera;
    if (!g) return;
    if (g.morto) {
      this.updateCadáver(dt, g, ctx);
      return;
    }
    this.updateCaçada(dt, g, ctx, prof);
  }

  /** O levantamento do corpo: nasce do hash, avisa em voz alta e começa de pé. */
  private nasce(ctx: GorilaContext, player: GorilaCorpo): void {
    const W = ctx.worldW, H = ctx.worldH;
    const born = pontoDeEmergência(player.x, player.y, W, H);
    // O ponto de emergência é hash puro, e hash puro não sabe que ali tem uma fogueira. Hoje a
    // banda já o põe longe o bastante: medida no mundo gerado, a jurisdição mais rasa está a 51
    // tiles de fundo e o teto dele a 39, e o check da tribo varre o perímetro inteiro cobrando
    // isso. O empurão fica porque a folga não é uma regra — é consequência do sorteio da célula —
    // e se um dia a tribo encostar na banda, o que tem de valer é a posse, não o histórico do hash.
    expulsaDaClareira(born, W, H, ctx.água);
    this.fera = criaGorila(born.x, born.y, Math.min(COBRANÇA_MÁXIMA, this.rancor));
    this.fera.espera = ESPEITA_S;
    this.avisoFeito = false;
    this.urro = URRO_S;
    // A dívida desce para o piso do aviso: sem isto o próximo tick compraria uma segunda fera
    // em cima da primeira, e a fronteira viraria uma fila de gigantes.
    this.rancor = Math.min(this.rancor, DÍVIDA_DA_RETIRADA);
    const face = faceDaFronteira(born.x, born.y, W, H);
    ctx.say(face ? `Algo grande se levantou ${NOME_DA_FACE[face]} — corra`
      : 'Algo grande se levantou na mata — corra', 3.2);
    ctx.play('gorillaRoar', 0.8);
    ctx.shake(0.5);
    ctx.onStructChange();
  }

  /** A caçada inteira: estado, deslocamento, braço e os sinais que o jogador lê. */
  private updateCaçada(dt: number, g: Gorila, ctx: GorilaContext, prof: number): void {
    const player = ctx.player;
    if (!player) return;
    const W = ctx.worldW, H = ctx.worldH;
    const dx = player.x - g.x;
    const dy = player.y - g.y;
    const d = Math.hypot(dx, dy);

    // A presa voltou para o mapa: ele a acompanha até a beira da mata e vai embora. Não é
    // medo — é o contrato do lugar. Uma fronteira que não tem uma margem onde ela manda e
    // outra onde ela não manda não é uma fronteira, é só um mapa maior.
    if (g.estado !== 'retirando' && !foraDoMapa(player.x, player.y, W, H)) {
      g.estado = 'retirando';
      ctx.say('Ele não pisa o asfalto. Volta.', 2.6);
    }
    // A presa passou da porta deles: a caçada termina exatamente aí, com a frase dizendo por quê.
    // Não é medo dos guerreiros — é o mesmo contrato do asfalto, do rio e da clareira, e é o que
    // faz o jogador poder *procurar* as duas coisas: a mata velha é onde ele se levanta, e a terra
    // sem nome é onde ninguém mais se levanta.
    if (prof >= TERRA_DO_GIGANTE) {
      ctx.say('Ele parou na borda da terra sem nome. Aqui não é mata dele.', 3.4);
      this.encerra(DÍVIDA_DA_RETIRADA, 'teto');
      return;
    }

    let vx = 0;
    let vy = 0;
    if (g.estado === 'retirando') {
      const face: Dir4 = faceDaFronteira(g.x, g.y, W, H) ?? 'SE';
      [vx, vy] = face === 'NW' ? [-1, 0] : face === 'SE' ? [1, 0] : face === 'NE' ? [0, -1] : [0, 1];
    } else if (g.estado === 'batendo') {
      g.espera = Math.max(0, g.espera - dt);
      if (g.espera <= 0) this.soca(g, player, ctx, d, dx, dy);
    } else {
      if (d > 1e-4) { vx = dx / d; vy = dy / d; }
      if (g.estado !== 'espreitando' && d <= GORILA_ALCANCE_SOCO && g.golpe <= 0) {
        // Braço no alto e corpo parado: o meio segundo que dá ao jogador a escolha entre
        // correr e atirar. Sem windup visível o dano seria um número caindo do céu.
        g.estado = 'batendo';
        g.espera = GORILA_WINDUP;
        g.velocidade = 0;
        this.vozes(dt, g, ctx, d);
        return;
      }
      const passo = velocidadeDaFera(g.rancor)
        * (g.estado === 'espreitando' ? PASSO_DO_AVISO : 1) * dt;
      g.x += vx * passo;
      g.y += vy * passo;
      g.dir = direçãoDe(vx, vy, g.dir);
      this.passo(g, passo, ctx);
      if (g.estado === 'espreitando') {
        g.espera -= dt;
        // Ele para de posar quando chega perto o bastante para o jogador vê-lo de pé na mata.
        if (g.espera <= 0 || d < 14) g.estado = 'cacando';
      }
    }

    // O tronco não o segura — é o que faz dele uma coisa de duas toneladas dentro de uma
    // floresta: quem tem de desviar é você. O limite invisível do mundo, esse segura tudo.
    g.x = limiteJogável(g.x, W, g.raio);
    g.y = limiteJogável(g.y, H, g.raio);
    // E a casa dos outros também: o gigante contorna a clareira. Isto não é timidez, é o contrato
    // de posse — se ele atravessasse a terra pisada pelo caminho mais curto, a aldeia seria só um
    // desenho no meio do território dele, e o predador que mora lá não existiria. Expulso a cada
    // tick pelo lado de fora, ele descreve a borda quando continua andando para dentro: é o dar a
    // volta que o jogador vê, com o tronco e o muro invisível continuando exatamente como eram.
    expulsaDaClareira(g, W, H, ctx.água);
    // A banda dele, depois da terra deles: um passo longo atrás de um tiro pode pôr o corpo além
    // da porta da tribo no mesmo tick, e a posse de um ponto não pode depender de a decisão ter
    // rodado antes ou depois do movimento. Aqui é a régua física, não a intenção.
    seguraNaBanda(g, W, H);
    g.golpe = Math.max(0, g.golpe - dt);
    const andou = vx !== 0 || vy !== 0;
    g.velocidade = andou && g.estado !== 'batendo'
      ? velocidadeDaFera(g.rancor) * (g.estado === 'espreitando' ? PASSO_DO_AVISO : 1) : 0;
    if (andou && ctx.isVisible(g.x, g.y)) g.animTime += dt;

    this.vozes(dt, g, ctx, Math.hypot(player.x - g.x, player.y - g.y));

    // O corpo que chegou à beira da mata se dissolve na mata, e o mundo volta a dever pouco.
    if (g.estado === 'retirando' && prof === 0
      && profundidade(g.x, g.y, W, H) >= PROFUNDIDADE_DA_RETIRADA) {
      this.encerra(DÍVIDA_DA_RETIRADA, 'teto');
      return;
    }
    // Preso no limite e a 90 tiles do jogador: já não é uma ameaça, é um ponto no mapa. Some
    // sem frase — a fronteira não anuncia que desistiu — mas o preço da insistência fica, pelo
    // mesmo piso da retirada. Um corpo que evapora de graça ensinaria o jogador a correr.
    if (d > ABANDONO_TILES) this.encerra(DÍVIDA_DA_RETIRADA, 'teto');
  }

  /** O braço que desce: dano, recuo, tremor e o som do corpo no chão. */
  private soca(g: Gorila, player: GorilaCorpo, ctx: GorilaContext, d: number, dx: number, dy: number): void {
    g.espera = 0;
    g.golpe = GORILA_CADENCIA;
    g.estado = 'cacando';
    if (d > GORILA_ALCANCE_SOCO + SOCO_FOLGA) return;
    // Passa pelo `HealthSystem`, como todo dano do jogo: é a invulnerabilidade do pós-dano
    // que impede dois socos em sequência de virarem uma morte instantânea por spam.
    if (!ctx.damages(GORILA_DANO_SOCO)) return;
    const nx = d > 1e-4 ? dx / d : 0;
    const ny = d > 1e-4 ? dy / d : 0;
    player.x += nx * SOCO_RECUO;
    player.y += ny * SOCO_RECUO;
    ctx.shake(1.05);
    ctx.play('bodyHit', 0.85);
  }

  /** O corpo caído: queda, cadáver e o sumiço. Ele continua sendo um lugar no mapa nesse tempo. */
  private updateCadáver(dt: number, g: Gorila, ctx: GorilaContext): void {
    g.deathTimer += dt;
    if (g.deathTimer < GORILA_CADAVER_S) return;
    this.encerra(DÍVIDA_DA_QUEDA, 'piso');
    // Matar a fera não perdoa a dívida: ela volta para o nível da queda, não para zero. Uma
    // fronteira que se resetasse com um tiro seria um checkpoint, e o pedido foi o contrário.
    ctx.say('O gigante caiu. A mata continua aqui.', 3.4);
  }

  /** Urro, tórax e passos: os três canais pelo que a câmera alcança. */
  private vozes(dt: number, g: Gorila, ctx: GorilaContext, d: number): void {
    if (g.estado === 'espreitando') {
      g.peito -= dt;
      if (g.peito <= 0) {
        g.peito = PEITO_CICLO;
        // Ele bate no peito antes de correr: é o gesto que diz "eu te vi" mais cedo do que
        // qualquer sprite, e é o único aviso de que a fase de posar está acabando. O relógio é
        // do corpo porque o `gorilaPose` lê o MESMO número para pôr o punho no tórax — dois
        // temporizadores fariam o tremor chegar num quadro e o gesto no seguinte.
        ctx.shake(d < 24 ? 0.16 : 0.05);
      }
    }
    this.urro -= dt;
    if (this.urro > 0) return;
    this.urro = URRO_S;
    const perto = 1 - d / URRO_ALCANCE;
    if (perto <= 0) return;
    ctx.play('gorillaRoar', 0.75 * perto);
    if (d < 30) ctx.shake(0.12 * perto);
  }

  /** A cada tile e meio um tranco no chão — a régua do tremor, não um temporizador. */
  private passo(g: Gorila, andado: number, ctx: GorilaContext): void {
    if (andado <= 0) return;
    g.passo += andado;
    if (g.passo < 1.35) return;
    g.passo = 0;
    ctx.shake(0.09);
    ctx.play('gorillaStep', 0.5);
  }

  /**
   * Tira o corpo do mundo e põe o prazo do próximo. Um só lugar faz isso, por contrato.
   *
   * As duas formas não são sinônimos. `'teto'` é uma fuga: o jogador escapou e a dívida desce
   * para o piso daquele tipo de saída. `'piso'` é uma cobrança: matar o gigante não perdoa
   * nada, e a dívida sobe pelo menos até o preço da queda — uma fronteira que zerasse com um
   * tiro seria um checkpoint, e o pedido foi justamente o contrário.
   */
  private encerra(dívida: number, forma: 'piso' | 'teto'): void {
    this.fera = null;
    this.espera = RENASCER_S;
    this.rancor = Math.max(0, forma === 'piso'
      ? Math.max(this.rancor, dívida)
      : Math.min(this.rancor, dívida));
    this.avisoFeito = false;
  }

  /** A única porta de entrada do dano recebido pela fera: quem atira chama esta função. */
  fere(amount: number): boolean {
    const g = this.fera;
    if (!g || g.morto) return false;
    const letal = fereGorila(g, amount);
    if (letal) this.avisoFeito = false;
    return letal;
  }

  /** Nasce quando a dívida foi paga, o jogador está no fundo dele e não há corpo na mata. */
  private deveNascer(prof: number): boolean {
    return this.espera <= 0
      && this.rancor >= LIMIAR_DA_CAÇADA
      && prof >= PROFUNDIDADE_DA_COBRA
      // A banda, com um tile de folga: sem folga, um jogador colado na linha daria um ponto de
      // emergência exatamente na profundidade dele, e "ele nasce sempre mais fundo" — a regra que
      // impede correr para fora de virar corrida para cima do bicho — passaria a valer só quase.
      && prof < LIMITE_DA_BANDA;
  }
}

/**
 * A direção do sprite a partir do deslocamento, na fonia do jogo: `worldToScreen` faz +x
 * descer para o sudeste, então é o mesmo par de eixos que `deltaToDir` usa para a fauna.
 * Sem vetor novo (parado, braço no alto) a direção antiga se mantém — um gigante que gira no
 * próprio eixo a cada quadro seria um borrão na tela.
 */
function direçãoDe(vx: number, vy: number, anterior: Dir4): Dir4 {
  if (vx === 0 && vy === 0) return anterior;
  const e = 1e-6;
  if (vx > e && vy > e) return 'SE';
  if (vx < -e && vy < -e) return 'NW';
  if (vx > e && vy < -e) return 'NE';
  if (vx < -e && vy > e) return 'SW';
  // Só um eixo se moveu: o que percorre mais decide, porque no losango isométrico um passo
  // reto em x é sudeste e um passo reto em y é sudoeste — não existem "cardeais" no mundo.
  return Math.abs(vx) >= Math.abs(vy)
    ? (vx > 0 ? 'SE' : 'NW')
    : (vy > 0 ? 'SW' : 'NE');
}
