import type { Vehicle } from '../entities/Vehicle';
import type { VehicleDef } from '../entities/types';
import { NOME_DA_FACE, type ConsultaDeÁgua, faceDaFronteira, nomeDaTerra, profundidade } from '../world/Frontier';
import { podeNadar } from './PiranhaSystem';

/**
 * A fronteira pelo ar.
 *
 * O chão sem fim já cobrava quem insistia nele; o céu acima dele era o buraco no contrato. Um
 * helicóptero que passa por cima da borda não pisa tronco nenhum — `MovementSystem` deixa, e com
 * razão, porque sobrevoar mata é o que uma aeronave faz — então sem esta regra a fronteira inteira
 * se resolveria em cinco segundos de manche para cima. O pedido do jogador foi o contrário: pelo
 * ar a máquina **quebra**.
 *
 * O que quebra é o motor, e a razão é a mesma de tudo aqui: a fronteira não é um muro pintado, é
 * um lugar que não é seu. Ninguém vê uma barreira no céu, só a ausência de qualquer coisa que
 * atenda — a máquina para de responder e desce. Isso é mais honesto do que um colisor invisível,
 * e dá ao jogador uma janela real de escolha em vez de um "não" instantâneo.
 *
 * A queda é um mecanismo, não uma punição instantânea, e por isso ela tem duas saídas:
 * — **pilotar a queda.** Sem motor o manche de subida não iça nada, mas o nariz continua
 *   mandando: quem chega em frente amortece o pouso e sobrevive para ver a mata ao redor;
 * — **cair de focinho.** Quem para no ar cai reto, e aí a aeronave se desfaz — é o caminho do
 *   `DestructionSystem`, com destroço, explosão e o jogador expulso no meio da nada.
 *
 * As duas saídas pagam a mesma dívida. O preço de cair na fronteira é a caçada: `cobra` entrega
 * ao `GorilaSystem` a dívida de uma caçada inteira, então quem desceu entre as árvores já chegou
 * num mundo que veio procurá-lo. É a cena que foi pedida — o helicóptero cai e a coisa grande
 * aparece no barulho — e ela não é um scripted evento: é o contrato da fronteira, cobrando por
 * coordenada, exatamente como cobra de quem anda.
 */

/**
 * Profundidade, em tiles além da borda, onde o céu deixa de ser seu.
 *
 * Dez não é um número arbitrário: é o plano que a máquina ainda consegue fazer. Com o motor morto
 * a cota desce a `HELI_FALL_RATE` (2,8 tiles/s) e o nariz empurra a `HELI_MAX_SPEED` (4,6 tiles/s)
 * — de cima, a 8 tiles de cota, sobram ~2,8 s e ~13 tiles de frente: quem voa alto ainda volta
 * para o mapa. Quem voa baixo (a levitação de 2,2 tiles) tem meio segundo e três tiles: cai. A
 * linha é exatamente o ponto onde a altitude deixa de ser um detalhe e passa a ser a diferença
 * entre os dois finais.
 */
export const PROFUNDIDADE_DO_MOTOR = 10;

/** Tiles de queda que cada tile/s de avanço compra: é o plano que a velocidade sustenta. */
const PLANO_POR_VELOCIDADE = 0.5;
/**
 * Dano de uma chegada perfeitamente amortecida: um solavanco, não uma sentença.
 *
 * O teto do piloto (rigidez 8 → ~65) é deliberadamente menor que a vida dele: quem cai na mata
 * tem de sobreviver o bastante para ser cobrado por ela. O pedido do jogador é o avião quebrando
 * *e* a fera vindo atrás — se o chão matasse, a caçada nunca aconteceria e a fronteira aérea
 * seria um fim em vez de uma passagem. O que mata é a carcaça (18 + 22 por tile de rigidez: a
 * partir de ~3,7 ela explode), e é do estouro que o `DestructionSystem` expulsa o piloto.
 */
const DANO_DA_CHEGADA = 9;
/** Dano do jogador por tile de queda que sobra depois do plano. */
const DANO_POR_RIGIDEZ = 7;
/** Dano na carcaça por tile de queda que sobra, mais o arranhão de qualquer pouso duro. */
const DANO_CARÇAÇA_POR_RIGIDEZ = 22;
const DANO_CARÇAÇA_BASE = 18;
/**
 * Dívida entregue à mata por uma aeronave que caiu nela. É o teto do aviso e o piso da caçada
 * (`LIMIAR_DA_CAÇADA`), então a descida nunca termina em "azar sem consequência": o preço é o
 * mesmo que sessenta segundos de teimosia a pé cobrariam, pago de uma vez.
 */
const DÍVIDA_DA_DESCIDA = 1;
/** Segundos parado no chão até o motor voltar a pegar. No ar ele não volta nunca. */
const REACENDER_S = 5;

/** Uma aeronave, para este sistema: tudo que voa por cota e não por roda. */
export function éAeronave(def: VehicleDef): boolean {
  return def.type === 'helicopter';
}

/**
 * O quanto a chegada foi dura, em tiles de queda efetivos: a altura de que você caiu menos o
 * plano que a velocidade comprou. Zero é um pouso; oito é um anúncio.
 *
 * Exportada pura porque é a regra, não um detalhe do laço: um check em memória precisa poder
 * afirmar que voar rápido salvou a máquina, e isso não se prova olhando um número dentro de um
 * `for`.
 */
export function rigidezDaChegada(altura: number, velocidade: number): number {
  const plano = Math.max(0, velocidade) * PLANO_POR_VELOCIDADE;
  return Math.max(0, altura - plano);
}

export function danoDoPiloto(rigidez: number): number {
  return DANO_DA_CHEGADA + rigidez * DANO_POR_RIGIDEZ;
}

export function danoDaCarcaça(rigidez: number): number {
  return DANO_CARÇAÇA_BASE + rigidez * DANO_CARÇAÇA_POR_RIGIDEZ;
}

export interface FrontierFallContext {
  worldW: number;
  worldH: number;
  /** A frota inteira. A fronteira não escolhe alvo: o céu é a regra para qualquer casco. */
  vehicles: Vehicle[];
  /** O id da máquina que o jogador pilota, ou `null`. Só quem está dentro apanha no pouso. */
  pilotado: number | null;
  damages: (amount: number) => boolean;
  shake: (amount: number) => void;
  say: (text: string, seconds?: number) => void;
  play: (key: 'rotorFail' | 'metalHit' | 'engineCatch', volume: number) => void;
  /** Entrega a dívida ao `GorilaSystem`. É a ponte entre o céu e a fera da terra. */
  cobra: (dívida: number) => void;
  /**
   * A consulta de água do mundo, e a ponte com a fera do rio. As duas vêm juntas porque é a mesma
   * pergunta: *em quê* é que este casco caiu? Um helicóptero que desce sobre o canal além da grade
   * não deve nada à mata — deve à piranha — e a única forma de esta frase não virar duas contas
   * divergentes é a queda usar exatamente o mesmo oracle que os dois predadores usam.
   */
  água: ConsultaDeÁgua;
  cobraÁgua: (dívida: number) => void;
  onStructChange: () => void;
}

/** O histórico de uma máquina sem motor. Vive enquanto a máquina vive. */
interface Queda {
  /** Tiles acima do chão no instante em que o motor parou: o tamanho da queda, congelado ali. */
  altura: number;
  /** O pouso já foi cobrado? Cobra-se uma vez — cada tick em terra não pode ser uma queda nova. */
  pousou: boolean;
  /** Segundos parado no chão com o motor morto, para o reacender. */
  noChão: number;
}

export class FrontierFallSystem {
  private quedas = new Map<number, Queda>();

  /**
   * A máquina do jogador está sem motor? É o que a HUD lê: a fronteira aérea precisa dizer
   * *por que* o manche parou de responder, senão o jogador acusa o controle de bug.
   */
  semMotor(id: number | null): boolean {
    return id !== null && this.quedas.has(id);
  }

  update(dt: number, ctx: FrontierFallContext): void {
    if (!Number.isFinite(dt) || dt <= 0) return;
    const { worldW: W, worldH: H } = ctx;
    for (const v of ctx.vehicles) {
      if (!éAeronave(v.def)) continue;
      if (v.state === 'destroyed') {
        // O casco virou destroço: o histórico morre com ele. Deixar a chave pendurada seria um
        // reacender sobre um cadáver de metal.
        this.quedas.delete(v.id);
        continue;
      }
      if (!v.motorDead) {
        // Só o ar morre: um helicóptero pousado e andando para fora do mapa é um objeto no chão,
        // e o chão tem a sua própria cobrança — a do `GorilaSystem`, lenta e honesta.
        if (v.altitude > 0.05 && profundidade(v.x, v.y, W, H) >= PROFUNDIDADE_DO_MOTOR) {
          this.falha(v, ctx);
        }
        continue;
      }
      const q = this.quedas.get(v.id);
      if (!q) continue;
      if (v.altitude > 0.05) {
        // Ainda caindo: o tempo em terra recomeça a cada quadro fora do chão, senão uma
        // encosta que levanta no meio da descida reacenderia o motor no ar.
        q.noChão = 0;
        continue;
      }
      if (!q.pousou) {
        this.pousa(v, q, ctx);
        continue;
      }
      q.noChão += dt;
      if (q.noChão >= REACENDER_S) {
        v.motorDead = false;
        this.quedas.delete(v.id);
        ctx.play('engineCatch', 0.55);
        ctx.say('O motor voltou. A mata não.', 2.6);
      }
    }
  }

  /** O motor para. A frase é o contrato sendo anunciado no instante em que ele vira fato. */
  private falha(v: Vehicle, ctx: FrontierFallContext): void {
    const face = faceDaFronteira(v.x, v.y, ctx.worldW, ctx.worldH);
    v.motorDead = true;
    this.quedas.set(v.id, { altura: v.altitude, pousou: false, noChão: 0 });
    ctx.play('rotorFail', 0.85);
    ctx.say(face ? `As pás morreram ${NOME_DA_FACE[face]} — escolhe o chão`
      : 'As pás morreram no ar', 3.2);
    ctx.onStructChange();
  }

  /** A chegada: dano em quem está dentro, dano no casco, barulho e a dívida da mata. */
  private pousa(v: Vehicle, q: Queda, ctx: FrontierFallContext): void {
    q.pousou = true;
    q.noChão = 0;
    const rigidez = rigidezDaChegada(q.altura, v.speed);
    // A carcaça apanha sempre: um helicóptero que caiu de fora do mapa não sai ileso nem quando o
    // piloto é bom, e é o `DestructionSystem` que decide, no próximo tick, se ela explode.
    v.health = Math.max(0, v.health - danoDaCarcaça(rigidez));
    // Qualquer pouso cobra um solavanco de quem está dentro, e não só o duro: `DANO_DA_CHEGADA` é
    // o preço de base de ter caído, e o que a rigidez faz é crescer em cima dele. Cobrar apenas do
    // impacto forte faria da saída premiada — amortecer com o nariz — o único caminho sem
    // consequência nenhuma, e a consequência é o que faz a escolha ser uma escolha.
    if (ctx.pilotado === v.id) ctx.damages(danoDoPiloto(rigidez));
    if (rigidez >= 1.2) {
      ctx.shake(1.3);
      ctx.say(`Bateu ${nomeDaTerra(profundidade(v.x, v.y, ctx.worldW, ctx.worldH))} — ${v.health <= 0
        ? 'vai explodir' : 'sai da máquina'}`, 3);
    } else {
      ctx.shake(0.5);
      ctx.say('Amorteceu. Por pouco.', 2.4);
    }
    ctx.play('metalHit', 0.9);
    // O preço da descida é a caçada, e ele é pago mesmo se o piloto escapou: a terra cobrou o
    // trecho que a máquina atravessou voando, e voar por cima não é passar por fora.
    //
    // Caiu dentro do canal é o rio que cobra, e a decisão usa a MESMA função que decide onde a
    // piranha caça e onde o gigante se recusa a pisar. Importar `podeNadar` em vez de reescrever
    // um teste de água aqui é o que garante que nenhuma queda cai num trecho sem dono: os três
    // sistemas leem a mesma fronteira, e é por isso que ela pode ser uma regra em vez de três.
    if (podeNadar(v.x, v.y, ctx.worldW, ctx.worldH, ctx.água)) ctx.cobraÁgua(DÍVIDA_DA_DESCIDA);
    else ctx.cobra(DÍVIDA_DA_DESCIDA);
    ctx.onStructChange();
  }
}
