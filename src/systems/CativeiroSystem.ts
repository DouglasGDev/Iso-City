import { type Acampamento } from '../world/Tribo';
import { PRAZO_DA_SACIEDADE } from './TriboSystem';

/**
 * O cativeiro: o poste, a corda e a janela.
 *
 * A fase 3 terminava com o corpo entregue no centro da clareira e o bando satisfeito por vinte e
 * cinco segundos. Este sistema começa exatamente ali, porque uma entrega sem consequência seria um
 * sequestro que não sequestra: o jogador é atado ao poste do lugar, e o que ele tem é uma corda e um
 * relógio.
 *
 * **A corda não cede com o tempo — cede com o debate, e recalca quando ele para.** O esforço é a
 * *virada* do manche de um lado para o outro, e não a direção: um corpo amarrado não anda, e o
 * gesto de bater de um lado ao outro é o que um punho preso faz de verdade. Por isso a régua é o
 * sinal que troca, nunca o módulo — segurar o manche no canto é polegar descansando, e polegar
 * descansando aperta o nó um pouco mais. Um prisioneiro parado nunca se solta, e isto é decisão e
 * não acidente: se a corda cedesse sozinha, o minigame seria uma tela de carregamento.
 *
 * **A janela é o prazo da saciedade, e não um número irmão dele.** Vinte e cinco segundos é quanto
 * o bando demora a voltar a olhar para você, e é quanto o poste segura um homem. Importar a
 * constante — em vez de escrever 25 outra vez — é o que impede as duas metades do lugar de
 * discordarem: uma janela maior que a calma seria um cativeiro onde ninguém nunca chega, e menor
 * seria um cativeiro onde chegar antes não serve para nada.
 *
 * **Nenhuma posição é escrita por tique.** O corpo é posto no ponto da amarra uma única vez, na
 * entrega, e o ponto é a soma dos dois raios mais um dedo — de propósito, porque
 * `empurraDoAcampamento` só empurra quem está *dentro* da soma. Um `for` escrevendo coordenada
 * contra o colisor, no mesmo quadro, é o braço de borracha que o transporte já pagou para conhecer,
 * e é a razão de este sistema não ter um campo `x`/`y` seu.
 *
 * As duas saídas são as duas cenas que o lugar pode dar. A corda arrebenta: o prisioneiro está de pé
 * ao lado do poste, livre, e o bando volta a olhar para a clareira — correr a partir dali é o
 * resto do jogo. A janela fecha: ele é posto para fora da jurisdição, vivo e mais pobre, porque a
 * terceira opção (apanhar até morrer sem poder sair do lugar) é a morte inevitável que este mundo
 * inteiro existe para não ter.
 */

/** Integração perdida por virada de manche. Catorze puxões = a corda inteira. */
const FORÇA_DO_PUXÃO = 0.075;
/** O nó recalca sozinho, por segundo de corpo parado: é o que faz debater-se ser um esforço e não um contador. */
const APERTO_DO_NÓ = 0.05;
/** Abaixo disto o manche não está de lado nenhum: é o polegar no centro, e centro não puxa nada. */
const MORTO_DO_PUXÃO = 0.25;
/** De quanto em quanto a corda vira uma frase na tela. Quatro faixas, a última é o estalo. */
const FAIXA_DA_ORDENSA = 0.25;
/**
 * O segundo entre ser jogado no poste e a instrução ser dita. Não é enfeite nem dramaturgia: a
 * legenda do jogo é um **slot só** (`InteriorSystem.say` sobrescreve), e a frase do bando — quanto
 * dinheiro ele acabou de te tomar — é escrita no mesmo tick em que esta amarra começa. Falasse por
 * cima na hora, o preço nunca seria lido, e quem está preso com as mãos ocupadas não relê nada.
 */
const SILÊNCIO_DA_ENTREGA = 1;

export interface CativeiroContext {
  /** `null` dentro de uma sala: ali não há clareira, poste nem corda, e os dois relógios param juntos. */
  player: { x: number; y: number } | null;
  /** A pé? Quem sobe num carro com as mãos presas arrebentou a amarra por outro caminho. */
  aPé: () => boolean;
  /** O bando volta a olhar para a própria clareira. Só ele sabe o que a corda no chão custa. */
  acorda: (aldeiaId: number) => void;
  /** Põe o corpo para fora da jurisdição: o destino de quem não se soltou a tempo. */
  expulsa: () => void;
  say: (text: string, seconds?: number) => void;
  play: (key: 'triboGrito' | 'triboTambor' | 'bodyHit', volume: number) => void;
  shake: (amount: number) => void;
}

export class CativeiroSystem {
  private ac: Acampamento | null = null;
  /** 1 = recém-atado, 0 = arrebentou. É a corda, e não a saúde do prisioneiro. */
  private integridade = 0;
  /** Segundos de bando satisfeito que ainda restam. */
  private janela = 0;
  /** -1, 0 ou 1: o lado em que o manche estava no último tique. É a única memória do esforço. */
  private lado = 0;
  /** Puxões contados e ainda não cobrados — o efeito acontece no tick, com o contexto do tick. */
  private puxões = 0;
  /** A última faixa de corda que já virou frase: cada faixa fala uma vez, e só uma. */
  private ordensa = 1;
  /** A instrução da estreia, dita depois de um segundo de chão — ver `SILÊNCIO_DA_ENTREGA`. */
  private estreia = false;
  /** Segundo de silêncio que ainda falta antes de a instrução poder ser dita. */
  private aviso = 0;

  /** O manche de quem está amarrado. Não anda: debate. */
  get amarrado(): boolean { return this.ac !== null; }

  /**
   * O corpo chegou à clareira e foi atado. Não devolve nada, e não escreve coordenada: quem pousa o
   * corpo é o arrasto do bando, no tick anterior, com o ponto que o próprio território calcula. Este
   * método só acende os dois relógios — a corda e a janela — no instante em que aquilo aconteceu.
   */
  amarra(ac: Acampamento): void {
    this.ac = ac;
    this.integridade = 1;
    this.ordensa = 1;
    this.janela = PRAZO_DA_SACIEDADE;
    this.lado = 0;
    this.puxões = 0;
    this.estreia = true;
    this.aviso = SILÊNCIO_DA_ENTREGA;
  }

  /**
   * A leitura do manche. Um puxão é a *troca* de lado: o primeiro empurrão para a esquerda arma o
   * gesto, e só o primeiro empurrão para a direita o conta. Passar pelo centro não desarma — bater
   * de um lado ao outro passa por ele, e é este o gesto que se faz com as mãos presas.
   *
   * O puxão não é acumulado: ele é gasto no tique seguinte, e um tique em que a corda não corre o
   * descarta (`update`). Sem isso o esforço viraria uma fila escondida, e balançar o manche dentro
   * de uma sala — onde o poste não existe — compraria a fuga instantânea na rua.
   */
  puxa(sinal: number): void {
    if (!this.ac) return;
    const lado = sinal > MORTO_DO_PUXÃO ? 1 : sinal < -MORTO_DO_PUXÃO ? -1 : 0;
    if (lado === 0) return;
    const anterior = this.lado;
    this.lado = lado;
    if (anterior !== 0 && anterior !== lado) this.puxões++;
  }

  /**
   * O relógio do cativeiro. Duas escritas e nenhuma delas é coordenada: a corda, e a janela.
   *
   * O `aPé` vem antes do resto porque subir num carro não é esperar por ele: quem arrebenta a amarra
   * para entrar num assento de motorista não vai ser punido por continuar de pé no poste.
   */
  update(dt: number, ctx: CativeiroContext): void {
    const ac = this.ac;
    if (!ac || !Number.isFinite(dt) || dt <= 0) return;
    if (!ctx.player) {
      // Dentro de casa não há poste, corda nem corpo no chão do mundo: os dois relógios param, e o
      // polegar que se mexeu lá dentro não vira nada. É o mesmo `player: null` que congela a janela
      // — congelar um e deixar o outro contando seria a fuga pelo banheiro.
      this.puxões = 0;
      this.lado = 0;
      return;
    }
    if (this.estreia) {
      this.aviso -= dt;
      if (this.aviso <= 0) {
        this.estreia = false;
        ctx.say('Amarrado ao poste — bate o manche de um lado para o outro', 5);
      }
    }
    if (!ctx.aPé()) {
      this.solta(ac, ctx, true);
      return;
    }
    const puxões = this.puxões;
    this.puxões = 0;
    this.integridade = Math.min(1, this.integridade + APERTO_DO_NÓ * dt - puxões * FORÇA_DO_PUXÃO);
    while (this.integridade <= this.ordensa - FAIXA_DA_ORDENSA && this.integridade > 0) {
      this.ordensa -= FAIXA_DA_ORDENSA;
      ctx.play('bodyHit', 0.35);
      ctx.shake(0.08);
      ctx.say(this.ordensa <= 0.25 ? 'O nó quase cedeu — continua'
        : this.ordensa <= 0.5 ? 'A corda afrouxou um pouco'
          : 'A corda range', 2.2);
    }
    if (this.integridade <= 0) {
      this.solta(ac, ctx, true);
      return;
    }
    this.janela -= dt;
    if (this.janela <= 0) this.solta(ac, ctx, false);
  }

  /**
   * O fim do cativeiro. `livre` é a corda que arrebentou; `false` é a janela que venceu, e aí o corpo
   * sai da clareira pela mão deles, não pela própria.
   */
  private solta(ac: Acampamento, ctx: CativeiroContext, livre: boolean): void {
    this.puxões = 0;
    this.lado = 0;
    this.janela = 0;
    this.integridade = 0;
    this.ordensa = 1;
    this.estreia = false;
    this.aviso = 0;
    this.ac = null;
    if (livre) {
      ctx.play('triboGrito', 0.85);
      ctx.shake(0.3);
      ctx.say('Corda arrebentada — corre', 3);
      ctx.acorda(ac.id);
      return;
    }
    ctx.expulsa();
    ctx.play('bodyHit', 0.6);
    ctx.shake(0.25);
    ctx.say('Não te soltaram: te puseram para fora da clareira', 4);
  }
}
