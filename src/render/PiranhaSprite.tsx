import { useMemo } from 'react';
import { Group, Path, Skia, type SkPath } from '@shopify/react-native-skia';
import { useDerivedValue, type SharedValue } from 'react-native-reanimated';
import { piranhaPose, type PiranhaVisualState } from '../entities/Piranha';
import { worldToScreen } from '../world/IsoUtils';

/**
 * A piranha do rio sem fim, desenhada em contornos autorados — o mesmo contrato da fauna e do
 * gigante: nenhuma imagem externa, nenhum atlas, nenhuma licença. Geometria em grade inteira,
 * oito tintas por quadro, cache por pose.
 *
 * O que ela tem de dizer na tela, em três pixels de silhueta, é *água*: uma barbatana que corta
 * a superfície, um corpo que sai dela e uma esteira que se abre atrás. Por isso o quadro é mais
 * largo que alto (140x84 contra 96x112 do gigante) e por isso a base do sprite não é um pé — é a
 * linha d'água. Metade do desenho é a marca que ele deixa, não o bicho.
 *
 * A marca tem camada própria (`esteira`, desenhada antes do corpo) por um motivo que a primeira
 * versão desta arte provou na sonda offline: a fila de pintura é fixa por índice de tinta, então
 * uma onda desenhada em tinta 7 — o único branco do conjunto — passava *por cima* da barriga e o
 * peixe saía com um lençol de espuma atravessado no meio. Onda por baixo, corpo por cima, é a
 * única ordem que lê "ele está dentro d'água".
 */

export interface PiranhaSpriteProps {
  /** Identidade estável apenas: o corpo mutável nunca atravessa para a UI thread. */
  piranha: { id: number };
  /** Tiles de mundo, não pixels. `h` é a cota do chão publicada pelo laço de simulação. */
  position: SharedValue<{ x: number; y: number; h: number }>;
  /** Publica `piranhaVisualState(fera, game.time)` junto da posição, a cada tick. */
  visual: SharedValue<PiranhaVisualState>;
  clock: SharedValue<number>;
}

// Um predador de rio turvo: dorso verde-petróleo quase preto, flanco acinzentado, barriga
// clara e a garganta vermelha que faz a dentada ler "piranha" de longe. O 7 é só esmalte dos
// dentes — a espuma saiu daqui e virou camada própria pelo motivo documentado acima.
const PALETA = [
  '#0e1716', '#22463c', '#3a6656', '#5d8470', '#8aa98f', '#cfdcc9', '#b8402f', '#eef5f2',
] as const;

/** Quadro em pixels de tela. Base na linha d'água: o transform ancora (w/2, h) no ponto do mundo. */
const LARGURA = 140;
const ALTURA = 84;
/** A linha d'água do quadro: tudo abaixo dela é marca, tudo acima é corpo. */
const ÁGUA = 72;

type Frame = SkPath[];

function pintor(): {
  paths: Frame;
  rect: (tinta: number, x: number, y: number, w: number, h: number) => void;
  poly: (tinta: number, points: readonly (readonly [number, number])[]) => void;
} {
  const paths = Array.from({ length: 8 }, () => Skia.Path.Make());
  return {
    paths,
    rect: (tinta, x, y, w, h) => { paths[tinta].addRect(Skia.XYWHRect(x, y, w, h)); },
    poly: (tinta, points) => {
      const path = paths[tinta];
      points.forEach(([x, y], i) => (i === 0 ? path.moveTo(x, y) : path.lineTo(x, y)));
      path.close();
    },
  };
}

/**
 * A pose de cada quadro, em deslocamentos — não em coordenadas novas por pose. O corpo é UM
 * desenho transformado, e é isso que faz a natação ler como um peixe e não como nove desenhos
 * diferentes trocando de lugar.
 *
 * `afundo` põe o corpo mais dentro ou mais fora da água (é o que faz o windup ser só uma marca e
 * o salto ser inteiro); `cauda` varre a metade de trás, e como o pedúnculo é fino, um
 * deslocamento pequeno ali já é uma rabada; `boca` abre a maxila; `inclina` abaixa o focinho —
 * no salto é o corpo arqueando, na dentada é o golpe chegando.
 *
 * O `afundo` da pose 5 é zero por um motivo que a sonda offline pagou para aprender: o quadro
 * submerso desenha a marca em **coordenadas da superfície**, então um `afundo` ali empurrava o
 * losango inteiro para fora da própria célula — a pose existia no código e não aparecia na tela.
 */
interface PoseArte {
  afundo: number;
  cauda: number;
  boca: number;
  inclina: number;
}

const POSES: readonly PoseArte[] = [
  { afundo: 4, cauda: 0, boca: 0, inclina: 0 },     // 0 boiando, barbatana fora
  { afundo: 5, cauda: -9, boca: 0, inclina: -2 },   // 1 rabada para cima
  { afundo: 4, cauda: 0, boca: 0, inclina: 0 },     // 2 neutro
  { afundo: 5, cauda: 9, boca: 0, inclina: 2 },     // 3 rabada para baixo
  { afundo: 17, cauda: -6, boca: 0, inclina: 0 },   // 4 aviso: quase só a barbatana
  { afundo: 0, cauda: 0, boca: 0, inclina: 0 },     // 5 submersa: a marca, ver acima
  { afundo: -16, cauda: 4, boca: 0.5, inclina: -7 }, // 6 saindo da água
  { afundo: -13, cauda: 8, boca: 1, inclina: 9 },   // 7 A DENTADA aberta
  { afundo: 6, cauda: 0, boca: 0.2, inclina: 0 },   // 8 barriga para cima
];

/** A dentada aberta é a única boca com dentes: o resto é uma fresta escura. */
const DENTES: readonly (readonly [number, number])[] = [
  [134, 52], [128, 58], [121, 55], [115, 59], [109, 55],
];

/** O corpo e a marca de um quadro. Duas camadas, uma ordem: onda por baixo, bicho por cima. */
export interface PiranhaQuadro {
  corpo: Frame;
  esteira: SkPath;
}

/**
 * O quadro de uma pose. `away` é a vista de costas (NE/NW): aí a cabeça some na distância e o
 * que se vê é a barbatana no meio do dorso, o rabo perto da câmera e a esteira em V abrindo por
 * baixo — a silhueta que o jogador persegue com os olhos quando ela vem de frente para ele.
 *
 * Exportado como função pura porque a geometria é a regra do bicho, não um detalhe do
 * componente: `tools/tmp/render-piranha.cjs` rasteriza exatamente estes traços num PNG e os
 * olhos conferem o resultado antes de qualquer navegador.
 */
export function piranhaQuadro(away: boolean, frame: number): PiranhaQuadro {
  const pose = POSES[frame];
  const morta = frame === 8;
  const submersa = frame === 5;
  const p = pintor();
  const { rect, poly } = p;
  const esteira = Skia.Path.Make();
  // O giro do corpo em torno do focinho: um `inclina` positivo derruba a cabeça e levanta o
  // rabo, e é isso que separa "o peixe subiu" de "o peixe foi desenhado mais acima".
  //
  // As duas vistas pedem eixos diferentes, e é a lição que a sonda deu: de lado, o corpo está
  // deitado no quadro e a cauda é a metade da ESQUERDA (`x < 46`); de costas, o corpo está
  // EM PÉ — a cabeça no alto porque está longe, o caudal embaixo porque está perto — então ali a
  // rabada é um deslocamento LATERAL da metade de BAIXO, e o corpo pende para o lado oposto para
  // equilibrar. Aplicar a fórmula de lado na vista de costas deixava `cauda` sem efeito nenhum
  // (o rabo de costas tem x > 46) e as cinco poses da linha 2 saíam como um losango parado.
  const ponto = ([x, y]: readonly [number, number]): readonly [number, number] => {
    if (away) {
      // Mergulhar, aqui, não é descer no quadro: é encolher em direção à linha d'água, porque o
      // que se vê de costas é o quanto do bicho ainda está FORA. Pular é o contrário — sobe e
      // cresce, e é por isso que os dois lados do `if` não compartilham a conta.
      const submerso = pose.afundo >= 0
        ? ÁGUA - (ÁGUA - y) * (1 - pose.afundo / 55)
        : y + pose.afundo;
      const rabo = Math.max(0, y - 52) / 22;
      const ombro = Math.max(0, 52 - y) / 52;
      return [x + pose.cauda * (rabo * 1.8 - ombro * 0.5), submerso - pose.inclina * ombro];
    }
    // Afundar, de lado, também não é descer no quadro: é encolher em direção à linha d'água,
    // porque o que afunda é o que está FORA dela. Um `afundo` positivo traduzido em y empurrava o
    // ventre para baixo da linha — a sonda mostrou o peixe enterrado na lama em vez de submerso.
    const exposto = pose.afundo >= 0 ? ÁGUA - (ÁGUA - y) * (1 - pose.afundo / 55) : y + pose.afundo;
    let yy = exposto
      + (x < 46 ? pose.cauda * (46 - x) / 40 : 0)
      + pose.inclina * (112 - x) / 56;
    // Morta ela é o MESMO corpo espelhado na vertical em torno de um ponto acima da linha
    // d'água: a barriga clara sobe para onde estava o dorso escuro e as barbatanas apontam para
    // dentro do rio. Um giro de 180° no sprite seria um peixe voando.
    if (morta) yy = 2 * (ÁGUA - 30) - yy;
    return [x, yy];
  };
  const corpo = (pts: readonly (readonly [number, number])[]) => pts.map(ponto);
  const r = (tinta: number, x: number, y: number, w: number, h: number) => {
    const [dx, dy] = ponto([x, y]);
    rect(tinta, dx, dy, w, h);
  };
  /**
   * As duas cristas de onda que o corpo empurra. Coladas à linha d'água e baixas: a marca tem de
   * ler "algo passou aqui", não "neve no rio" — a primeira versão abriu um lençol branco de
   * 20 px abaixo do peixe e foi isso que a sonda mostrou.
   */
  const onda = (força: number, largura: number) => {
    if (força <= 0) return;
    const f = Math.min(1, força);
    esteira.addRect(Skia.XYWHRect(70 - largura, ÁGUA - 2, largura * 2, 3 + 2 * f));
    esteira.addRect(Skia.XYWHRect(70 - largura * 1.5, ÁGUA + 3, largura * 3, 2 + 2 * f));
  };
  /**
   * A esteira de costas: o V que ela abre por onde já passou, abrindo para a CÂMERA. De lado a
   * onda é uma faixa horizontal porque o corpo corta a água na transversal; de costas o corpo
   * foge pelo eixo da visão, e a única coisa que sobra é a marca em leque atrás dele — um retângulo
   * ali leria "mancha", não "trilha".
   */
  const esteiraEmV = (força: number) => {
    if (força <= 0) return;
    const abertura = 10 + 30 * Math.min(1, força);
    for (const lado of [-1, 1]) {
      esteira.moveTo(70, 48);
      esteira.lineTo(70 + lado * 3, 48);
      esteira.lineTo(70 + lado * abertura, ÁGUA + 9);
      esteira.lineTo(70 + lado * (abertura - 4), ÁGUA + 11);
      esteira.close();
    }
    esteira.addRect(Skia.XYWHRect(70 - abertura * 0.7, ÁGUA + 1, abertura * 1.4, 3));
  };

  if (away) {
    // ---- de costas: a cabeça some lá fora, o rabo fica perto de você ----
    if (submersa) {
      // Submersa: não há corpo nenhum, só o que a superfície ainda lembra. É o quadro que avisa
      // o bote, e é por isso que ele existe — sem ele o salto apareceria do nada. A bolha é LARGA
      // e BAIXA e a sombra fica logo abaixo da linha: um losango pequeno no meio do nada não
      // avisa "algo grande vai subir", e a primeira versão era exatamente isso.
      esteiraEmV(0.45);
      poly(4, corpo([[48, ÁGUA - 10], [70, ÁGUA - 16], [92, ÁGUA - 10], [70, ÁGUA - 2]]));
      poly(2, corpo([[56, ÁGUA - 8], [70, ÁGUA - 12], [84, ÁGUA - 8], [70, ÁGUA - 3]]));
      // O dorso ainda escuro, uma palma abaixo da linha: é a silhueta que faz a marca parecer ter
      // um dono.
      poly(1, corpo([[54, ÁGUA + 2], [70, ÁGUA - 2], [86, ÁGUA + 2], [70, ÁGUA + 9]]));
      return { corpo: p.paths, esteira };
    }
    esteiraEmV(morta ? 0.4 : 1);
    // O dorso: uma CUNHA, estreita na cabeça (longe) e larga na base da cauda (perto). É a
    // perspectiva que diz para onde ela vai, e a simetria era o que a fazia ler como folha.
    poly(0, corpo([[70, 14], [78, 22], [85, 34], [88, 48], [84, 58], [70, 62],
      [56, 58], [52, 48], [55, 34], [62, 22]]));
    poly(1, corpo([[70, 17], [76, 24], [82, 34], [85, 47], [81, 56], [70, 59],
      [59, 56], [55, 47], [58, 34], [64, 24]]));
    // O mescado: duas barras atravessando o dorso, que é o que faz a silhueta ler escama.
    poly(2, corpo([[56, 31], [84, 31], [85, 37], [55, 37]]));
    poly(2, corpo([[55, 43], [85, 43], [84, 49], [56, 49]]));
    // A barbatana dorsal: um gancho curto, assimétrico e deslocado para a direita da linha média.
    // Longa e centrada, ela era um veinho no prolongamento do corpo — e corpo + veinho era a
    // folha de pinheiro que a primeira sonda mostrou. Curta e torta, ela lê "fora d'água".
    if (!morta) {
      poly(0, corpo([[67, 42], [64, 24], [72, 13], [81, 20], [74, 27], [76, 42]]));
      poly(3, corpo([[69, 40], [67, 25], [72, 17], [77, 22], [73, 27], [74, 40]]));
    }
    // O caudal, largo e perto da câmera: um LEQUE — estreito no pedúnculo, aberto na borda, com a
    // barriga d'água atravessada. Com duas pontas simétricas e o meio recortado virava bigode, e
    // um bigode não empurra nada.
    poly(0, corpo([[66, 55], [74, 55], [91, 71], [86, 79], [70, 74], [54, 79], [49, 71]]));
    poly(2, corpo([[68, 58], [72, 58], [84, 71], [70, 67], [56, 71]]));
    // A cabeça: um capuz escuro lá no fundo, com o olho que ainda te vê.
    poly(0, corpo([[63, 20], [70, 12], [77, 20], [70, 27]]));
    if (morta) {
      // De costas, barriga para cima é o CONTRÁRIO do que a vista mostra: a barbatana some para
      // dentro do rio e o que fica fora é uma placa clara. Espelhar o desenho inteiro seria um
      // peixe voando — o que pesa aqui é a troca de cor, não a geometria.
      poly(5, corpo([[57, 24], [83, 24], [86, 52], [54, 52]]));
      poly(4, corpo([[62, 30], [78, 30], [80, 46], [60, 46]]));
      poly(7, corpo([[64, 16], [70, 21], [76, 16], [70, 24]]));
    } else {
      r(0, 66, 18, 8, 6);
      r(4, 67, 19, 5, 4);
      r(0, 68, 20, 3, 2);
      r(7, 69, 20, 2, 2);
    }
    return { corpo: p.paths, esteira };
  }

  // ---- de lado: a silhueta que faz o rio inteiro fazer sentido ----
  onda(submersa ? 0.5 : 1, 34);
  if (submersa) {
    // A superfície estufada no comprimento do corpo, a ponta da dorsal ainda fora, e o dorso
    // escuro uma palma ABAIXO da linha. É esse último traço que faz a marca ter dono: sem ele,
    // a pose era "uma onda", e o jogador não aprendia a jogar para fora antes do bote.
    poly(4, corpo([[46, ÁGUA - 10], [86, ÁGUA - 18], [126, ÁGUA - 10], [86, ÁGUA - 2]]));
    poly(2, corpo([[58, ÁGUA - 8], [86, ÁGUA - 14], [114, ÁGUA - 8], [86, ÁGUA - 3]]));
    poly(0, corpo([[100, ÁGUA - 22], [106, ÁGUA - 30], [110, ÁGUA - 21], [104, ÁGUA - 20]]));
    poly(1, corpo([[52, ÁGUA + 2], [92, ÁGUA - 3], [130, ÁGUA + 2], [92, ÁGUA + 9]]));
    return { corpo: p.paths, esteira };
  }
  // O contorno: focinho rombo à direita, pedúnculo fino à esquerda. A boca fica no canto
  // direito-baixo porque é ela que desce na dentada.
  poly(0, corpo([[138, 44], [132, 32], [116, 23], [92, 18], [64, 20], [42, 28], [26, 38],
    [20, 48], [26, 58], [44, 66], [72, 70], [100, 68], [122, 60], [136, 54], [138, 50]]));
  poly(1, corpo([[135, 44], [130, 34], [115, 26], [92, 21], [66, 23], [45, 30], [30, 39],
    [25, 48], [30, 56], [47, 63], [73, 67], [99, 65], [120, 58], [133, 52]]));
  // O dorso escuro, mais escuro que o flanco: é a parte que fica fora d'água e a que a luz do
  // céu pega. Sem essa faixa o peixe lê como um balão verde.
  poly(2, corpo([[130, 35], [114, 26], [92, 22], [66, 24], [45, 31], [58, 30], [86, 28],
    [112, 32], [128, 40]]));
  // As três barras do mescado: é o que faz a silhueta ler "peixe de rio grande" em vez de
  // "tubarão pequeno".
  poly(4, corpo([[60, 26], [66, 26], [58, 62], [52, 61]]));
  poly(4, corpo([[80, 22], [86, 22], [78, 66], [72, 66]]));
  poly(4, corpo([[100, 24], [105, 25], [98, 66], [93, 65]]));
  // A barriga clara e a garganta vermelha: o vermelho é só abaixo da linha da boca, onde uma
  // piranha de verdade é vermelha. Pintá-la inteira seria um palhaço.
  poly(5, corpo([[30, 54], [48, 63], [74, 67], [100, 65], [120, 58], [110, 62], [80, 64],
    [52, 60], [36, 56]]));
  poly(6, corpo([[104, 62], [122, 56], [134, 50], [130, 58], [116, 64]]));
  // A barbatana dorsal: alta, em gancho. É ela que aparece primeiro na superfície e é ela que o
  // jogador aprende a odiar — por isso sobe 14 px acima do dorso e não se mistura ao corpo.
  poly(0, corpo([[86, 20], [96, 2], [104, 8], [100, 22]]));
  poly(3, corpo([[89, 19], [96, 6], [100, 10], [97, 21]]));
  // A adiposa e a anal, pequenas atrás: sem elas o dorso termina liso demais para um peixe.
  poly(0, corpo([[46, 27], [52, 20], [56, 28]]));
  poly(0, corpo([[52, 66], [44, 76], [60, 70]]));
  // A peitoral, encostada atrás do opérculo: é a única barbatana que se move na volta, e por
  // isso ela é desenhada por cima do flanco, não antes.
  poly(0, corpo([[108, 56], [94, 70], [98, 72], [112, 62]]));
  poly(3, corpo([[106, 57], [96, 68], [99, 70], [109, 61]]));
  // O opérculo (a tampa da guelra): uma foice escura que separa a cabeça do corpo. Sem ela o
  // peixe é um tubo com um olho colado na frente.
  poly(0, corpo([[112, 26], [116, 40], [110, 56], [106, 54], [111, 40], [108, 28]]));
  // O caudal: uma forquilha funda, que é o que dá o comprimento do empurrão.
  poly(0, corpo([[24, 44], [8, 28], [2, 30], [14, 48], [2, 68], [8, 70], [24, 52]]));
  poly(2, corpo([[22, 45], [10, 32], [16, 48], [10, 66]]));
  // A maxila. Fechada é uma fresta; aberta é uma cunha com a garganta escura e cinco dentes de
  // esmalte — e os dentes são a única tinta 7 do corpo.
  if (pose.boca > 0.2) {
    poly(0, corpo([[138, 44], [136, 50], [124, 56], [114, 54], [124, 46]]));
    poly(0, corpo([[136, 52 + pose.boca * 6], [124, 58], [112, 56], [122, 62 + pose.boca * 4]]));
    poly(1, corpo([[134, 48], [124, 54], [116, 53], [124, 49]]));
    for (const [x, y] of DENTES) {
      const yy = y + (y > 56 ? pose.boca * 4 : 0);
      poly(7, corpo([[x, 50], [x - 2, yy], [x - 4, 50]]));
    }
  } else {
    poly(0, corpo([[136, 48], [126, 55], [114, 54], [124, 50]]));
    poly(6, corpo([[133, 50], [125, 55], [117, 54], [125, 51]]));
  }
  // O olho: anel escuro, íris clara, pupila. É o único contato dela com você antes do bote, e
  // por isso ele fica alto na cabeça — olhando para a superfície, como um predador de rio.
  r(0, 116, 34, 11, 9);
  r(4, 118, 36, 7, 5);
  r(0, 120, 37, 4, 3);
  r(7, 121, 37, 2, 2);
  if (morta) {
    // A barriga larga fora d'água: o espelho já levou o dorso escuro para baixo, mas o que sobra
    // em cima ainda tem a largura do flanco, e um peixe vivo de cabeça para baixo continua
    // parecendo um peixe vivo. Esta placa clara é o que troca a leitura.
    poly(5, corpo([[36, 62], [70, 70], [104, 68], [126, 58], [122, 68], [96, 76], [58, 78],
      [38, 70]]));
    poly(4, corpo([[52, 66], [86, 72], [116, 64], [112, 70], [86, 77], [54, 74]]));
    // X no olho: o brilho saiu, e é o único sinal desta vista de que o corpo já não nada.
    poly(7, corpo([[115, 33], [124, 42], [126, 40], [117, 31]]));
    poly(7, corpo([[124, 33], [115, 42], [113, 40], [122, 31]]));
  }
  return { corpo: p.paths, esteira };
}

interface Arte { frames: Frame[]; esteiras: SkPath[] }
let cache: Arte | null = null;

/** Índice da primeira vista de costas: as duas vistas compartilham a numeração de pose. */
const VISTAS = POSES.length;

/** Nove poses por vista (boiando, três de natação, aviso, submersa, saída, dentada, morta). */
function getArte(): Arte {
  if (cache) return cache;
  const quadros = [false, true].flatMap((away) =>
    POSES.map((_, frame) => piranhaQuadro(away, frame)));
  return (cache = {
    frames: quadros.map((q) => q.corpo),
    esteiras: quadros.map((q) => q.esteira),
  });
}

type Pose = ReturnType<typeof piranhaPose>;

function Camada({ frames, tinta, cor, pose }: {
  frames: Frame[]; tinta: number; cor: string; pose: SharedValue<Pose>;
}) {
  const path = useDerivedValue(() => frames[(pose.value.away ? VISTAS : 0) + pose.value.frame][tinta],
    [frames, tinta, pose]);
  return <Path path={path} color={cor} antiAlias={false} />;
}

export function PiranhaSprite({ piranha, position, visual, clock }: PiranhaSpriteProps) {
  const arte = useMemo(getArte, [piranha.id]);
  const pose = useDerivedValue(() => piranhaPose(visual.value, clock.value), [visual, clock]);
  const opacidade = useDerivedValue(() => pose.value.alpha, [pose]);
  const esteira = useDerivedValue(() => arte.esteiras[(pose.value.away ? VISTAS : 0) + pose.value.frame],
    [arte, pose]);
  const tela = useDerivedValue(() => {
    const q = worldToScreen(position.value.x, position.value.y, position.value.h);
    return [{ translateX: Math.round(q.x) }, { translateY: Math.round(q.y) }];
  }, [position]);
  const corpo = useDerivedValue(() => [
    { translateY: pose.value.offsetY + pose.value.bob },
    { rotate: pose.value.rotation },
    { scaleY: pose.value.scaleY },
    { scaleX: pose.value.mirror },
    { translateX: -LARGURA / 2 },
    { translateY: -ALTURA },
  ], [pose]);
  return (
    <Group transform={tela} antiAlias={false}>
      {/* A onda fica FORA do `<Group>` do corpo: ela é a marca no rio, e um corpo que pula não
          leva a superfície junto. É também o que a mantém opaca mesmo com o peixe submerso. */}
      <Path path={esteira} color="#cfe6e4" opacity={0.42} />
      <Group transform={corpo} opacity={opacidade}>
        {PALETA.map((cor, tinta) => (
          <Camada key={tinta} frames={arte.frames} tinta={tinta} cor={cor} pose={pose} />
        ))}
      </Group>
    </Group>
  );
}
