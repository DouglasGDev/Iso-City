import { worldToScreen } from '../world/IsoUtils';
import type { Cascade } from '../data/maps/city';

/**
 * Geometria de tela de uma cachoeira. Nada aqui é desenhado à mão nem colado na parede:
 * cada seção transversal da folha é projectada a partir do chão, com a cota lida na mesma
 * `heightSmoothAt` que entorta o losango. É isso que responde ao "não é textura plana" —
 * se o morro muda de inclinação no meio do lance, a folha entorta junto.
 *
 * O arquivo não importa Skia nem React de propósito: o checador em memória calcula a
 * projeção aqui e o desenho acontece na UI thread em cima destes mesmos números.
 */
/**
 * Uma margem do canal em tela, na ordem do fluxo: pares `[x0, y0, x1, y1, …]`, já em
 * espaço de projeção (antes do transform da câmera — o mesmo espaço em que o chão é
 * desenhado). `i` é a mesma seção nas duas margens.
 */
export type Margem = number[];

export interface GeometriaCascata {
  /**
   * Margens do lençol. O preenchimento NÃO é um polígono de ida e volta: ver `faixa` na
   * camada. Um traçado que curva fecha por dentro da barriga quando o bordo interno
   * cruza o externo, e o lençol vira uma laje pálida atravessando o morro.
   */
  lencoEsq: Margem;
  lencoDir: Margem;
  /** A pedra molhada em volta da folha: mais larga e assentada no chão seco. */
  pedraEsq: Margem;
  pedraDir: Margem;
  /** O eixo do fluxo em tela. É por ele que a correnteza escorre. */
  eixo: number[];
  /** Comprimento de tela acumulado sobre `eixo`, para a correnteza andar em ritmo constante. */
  arco: number[];
  total: number;
  /** Lábio: centro da crista por onde a água sai e a meia-largura medida em tela. */
  labio: { x: number; y: number; rx: number };
  /** Pé: onde o jato bate, em tela. */
  pe: { x: number; y: number; rx: number };
  /** Bacia: centro em tela e o raio do anel de água parada, já em pixels. */
  bacia: { x: number; y: number; rx: number };
  /** Quantas seções há no eixo — o comprimento de cada margem. */
  amostras: number;
  /** Caixa de tela da queda inteira, para o descarte da neblina. */
  caixa: { x: number; y: number; w: number; h: number };
}

/**
 * A folha não pode afundar no próprio chão: o tile é pintado com tinta e sombra, e água a
 * mesma cota sumiria na mistura. Três centésimos de tile é menos do que o olho registra
 * como degrau e o bastante para o lençol ficar por cima.
 */
const ELEVA = 0.03;
/**
 * A pedra encharcada respira além da água: sem ela a folha boia como adesivo. Um terço de
 * tile além da margem é o filete molhado que se vê na rocha; largo demais, vira acostamento
 * de asfalto em volta da queda, que foi exatamente como a primeira versão foi lida — com o
 * canal estreito de hoje, 1,2 tile de pedra de cada lado fazia mais sombra que água.
 */
const PEDRA = 0.62;
/**
 * Um círculo de `r` tiles no chão iso é uma elipse de meia-largura r·64·√2: projeção de
 * (cos, sen) sobre (x−y)·64. A meia-altura é a metade, como em todo losango 2:1.
 */
const RING_X = 64 * Math.SQRT2;

/**
 * Seção do canal em tela. `t` é a fração do lance: a garganta fecha no lábio e a calha
 * alarga até a bacia — a mesma curva que o gerador promete ao escolher a largura.
 */
function meiaDoCanal(c: Cascade, t: number) {
  return c.largura * 0.5 * (0.72 + 0.56 * t);
}

export function geometriaDaCascata(c: Cascade, altura: (x: number, y: number) => number): GeometriaCascata | null {
  const pts = c.curso;
  if (pts.length < 2) return null;
  const n = pts.length;
  const esq: number[] = [];
  const dir: number[] = [];
  const pedraE: number[] = [];
  const pedraD: number[] = [];
  const eixo: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(n - 1, i + 1)];
    const m = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    // Normal da corrente no plano do mundo: é a direção por onde a calha abre.
    const nx = -(b.y - a.y) / m;
    const ny = (b.x - a.x) / m;
    const p = pts[i];
    const t = i / (n - 1);
    const meia = meiaDoCanal(c, t);
    const centro = worldToScreen(p.x, p.y, altura(p.x, p.y) + ELEVA);
    eixo.push(centro.x, centro.y);
    for (const lado of [1, -1]) {
      const largura = meia * lado;
      const wx = p.x + nx * largura;
      const wy = p.y + ny * largura;
      const at = worldToScreen(wx, wy, altura(wx, wy) + ELEVA);
      (lado > 0 ? esq : dir).push(at.x, at.y);
      const pw = meia * PEDRA * lado;
      const px = p.x + nx * pw;
      const py = p.y + ny * pw;
      const ped = worldToScreen(px, py, altura(px, py));
      (lado > 0 ? pedraE : pedraD).push(ped.x, ped.y);
    }
  }

  const arco: number[] = [0];
  for (let i = 1; i < n; i++) {
    const d = Math.hypot(eixo[i * 2] - eixo[i * 2 - 2], eixo[i * 2 + 1] - eixo[i * 2 - 1]);
    arco.push(arco[i - 1] + d);
  }

  // A meia-largura de cada ponta é a corda entre o eixo e a margem, medida em tela: o
  // canal é desenhado no losango torto e a espuma tem de casar com o traçado dele.
  const k = (n - 1) * 2;
  const boca = { x: eixo[0], y: eixo[1], rx: Math.hypot(esq[0] - eixo[0], esq[1] - eixo[1]) };
  const cauda = { x: eixo[k], y: eixo[k + 1], rx: Math.hypot(esq[k] - eixo[k], esq[k + 1] - eixo[k + 1]) };
  const pe = worldToScreen(c.bacia.x, c.bacia.y, altura(c.bacia.x, c.bacia.y));
  const baciaRx = Math.max(6, c.bacia.raio * RING_X);
  // A caixa de descarte é a pedra molhada mais o anel da bacia: a névoa sobe uns quarenta
  // pixels acima do pé, e o fôlego da neblina já cobre isso com a sua margem.
  let x0 = pe.x - baciaRx;
  let x1 = pe.x + baciaRx;
  let y0 = pe.y - baciaRx * 0.5;
  let y1 = pe.y + baciaRx * 0.5;
  for (const lado of [pedraE, pedraD]) {
    for (let i = 0; i < lado.length; i += 2) {
      x0 = Math.min(x0, lado[i]);
      x1 = Math.max(x1, lado[i]);
      y0 = Math.min(y0, lado[i + 1]);
      y1 = Math.max(y1, lado[i + 1]);
    }
  }
  return {
    lencoEsq: esq,
    lencoDir: dir,
    pedraEsq: pedraE,
    pedraDir: pedraD,
    eixo,
    arco,
    total: arco[n - 1],
    labio: { x: boca.x, y: boca.y, rx: Math.max(4, boca.rx) },
    pe: { x: cauda.x, y: cauda.y, rx: Math.max(4, cauda.rx) },
    bacia: { x: pe.x, y: pe.y, rx: baciaRx },
    amostras: n,
    caixa: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 },
  };
}
