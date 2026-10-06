import { useMemo } from 'react';
import { Group, Path, Skia, type SkPath } from '@shopify/react-native-skia';
import { useDerivedValue, type SharedValue } from 'react-native-reanimated';
import { gorilaPose, type GorilaVisualState } from '../entities/Gorila';
import { worldToScreen } from '../world/IsoUtils';

/**
 * O dorsípede da mata sem fim, desenhado em contornos autorados — o mesmo contrato da fauna:
 * nenhuma imagem externa, nenhum atlas, nenhuma licença. Geometria em grade inteira, oito tintas
 * por quadro, cache por pose.
 *
 * A escala é a mensagem. Um homem tem 32 px de altura; este corpo tem 112, e por isso ele entra
 * na fila de desenho do tamanho de um pinheiro alto (`prop_tree_pine_tall.png` são 80×116). É
 * assim que a fronteira se apresenta: não é um bicho no meio da mata, é a mata ficando de pé e
 * andando.
 */

export interface GorilaSpriteProps {
  /** Identidade estável apenas: o corpo mutável nunca atravessa para a UI thread. */
  gorila: { id: number };
  /** Tiles de mundo, não pixels. `h` é a cota do chão publicada pelo laço de simulação. */
  position: SharedValue<{ x: number; y: number; h: number }>;
  /** Publica `gorilaVisualState(fera, game.time)` junto da posição, a cada tick. */
  visual: SharedValue<GorilaVisualState>;
  clock: SharedValue<number>;
}

// Prata de um dorsípede de duas toneladas: pelo marrom-ferrugem no corpo, cinza-prata no manto,
// couro escuro nas extremidades. O 5 e o 7 são o que faz o bicho ler "silverback" a dez tiles,
// antes de qualquer detalhe de rosto.
const PALETA = [
  '#1a1713', '#2f2822', '#443a2e', '#5b4c3a', '#77604a', '#9c917c', '#201b16', '#c6bda7',
] as const;

/** Quadro em pixels de tela. Base no pé: o transform ancora (w/2, h) no ponto do mundo. */
const LARGURA = 96;
const ALTURA = 112;

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
 * Um bloco de corpo: contorno preto por fora, pelo na tinta base, pelo iluminado na face que a
 * câmera vê. Todo membro é feito de blocos empilhados do ombro ao punho — é o que dá ao gigante
 * a silhueta grossa de dorsípede em vez de quatro paus.
 */
function bloco(p: ReturnType<typeof pintor>, x: number, y: number, w: number, h: number,
  base: number, luz: number): void {
  p.rect(0, x - 1, y - 1, w + 2, h + 2);
  p.rect(base, x, y, w, h);
  p.rect(luz, x + 2, y + 3, Math.max(2, w - 5), Math.max(2, h - 7));
}

/**
 * A mão ou o pé: couro escuro, sempre por cima do bloco que o segura.
 *
 * O brilho do nó dos dedos é tinta 7 e não uma tinta média porque a fila de pintura é fixa por
 * índice de tinta (0 → 7): qualquer traço mais claro que o couro (tinta 6) desenhado antes dele
 * é coberto e nunca aparece. Foi assim que todos os punhos e pés do gigante saíam como tijolos
 * pretos lisos, sem volume, por mais "detalhe" que se escrevesse neles.
 */
function extremidade(p: ReturnType<typeof pintor>, x: number, y: number, w: number, h: number): void {
  p.rect(0, x - 1, y - 1, w + 2, h + 2);
  p.rect(6, x, y, w, h);
  p.rect(7, x + 2, y + 2, w - 4, 2);
}

/**
 * A pose de cada quadro, em pixels de tela dentro do quadro 96x112.
 *
 * `perna` desloca o lado perto da câmera — braço e perna do MESMO lado juntos, porque num
 * dorsípede o braço é antepé: quem avança é o lado, não a diagonal de um humano andando. O lado
 * oposto vai no sentido inverso, um pouco menos porque some atrás da massa do tronco. `dobra` é
 * o joelho da perna que passa por baixo do corpo (pé sobe, canela encurta); `alto` é o corpo
 * subindo sobre o apoio firme; `inclina` derruba o ombro e a cabeça para a frente — é o lance
 * que faz o golpe *descer* na tela em vez de o sprite apenas trocar de desenho.
 */
interface PoseArte {
  alto: number;
  perna: number;
  dobra: number;
  inclina: number;
  /** Deslocamento extra do crânio: a cabeça acompanha o golpe, e no aviso ela se ergue. */
  cabeça: readonly [number, number];
  braços: 'anda' | 'alto' | 'peito' | 'baixo' | 'aberto';
}

const POSES: readonly PoseArte[] = [
  { alto: 0, perna: 0, dobra: 0, inclina: 0, cabeça: [0, 0], braços: 'anda' },     // 0 parado
  { alto: 0, perna: 9, dobra: 0, inclina: 1, cabeça: [2, 1], braços: 'anda' },     // 1 contato, lado da câmera à frente
  { alto: 3, perna: 3, dobra: 7, inclina: 0, cabeça: [0, -1], braços: 'anda' },    // 2 esse lado passa por baixo
  { alto: 0, perna: -9, dobra: 0, inclina: 1, cabeça: [-2, 1], braços: 'anda' },   // 3 contato do outro lado
  { alto: 3, perna: -3, dobra: -7, inclina: 0, cabeça: [0, -1], braços: 'anda' },  // 4 o outro lado passa
  { alto: 10, perna: 0, dobra: 0, inclina: -3, cabeça: [-1, -7], braços: 'alto' }, // 5 windup do soco
  { alto: 6, perna: 0, dobra: 0, inclina: 2, cabeça: [0, -9], braços: 'peito' },   // 6 punho no peito
  { alto: 5, perna: -5, dobra: 0, inclina: 8, cabeça: [5, 7], braços: 'baixo' },   // 7 O GOLPE desferido
  { alto: 7, perna: 0, dobra: 0, inclina: -2, cabeça: [0, -11], braços: 'aberto' }, // 8 punhos armados fora
];

/**
 * O quadro de um pose. `away` é a vista de costas (NE/NW) e `frame` segue a fonia do
 * `gorilaPose`: 0 parado, 1..4 marcha, 5 braço no alto, 6 peito batido, 7 o golpe chegando,
 * 8 os punhos armados antes da batida.
 *
 * A ordem de desenho é a anatomia: o lado que está atrás do corpo, o tronco, a cabeça pendurada
 * à frente do ombro, e por último o lado perto da câmera. Assim o contorno do membro próximo
 * separa braço de tronco em vez de engolir o rosto — que é exatamente o erro da primeira versão
 * desta arte, e o que o probe offline deixou ver.
 *
 * Exportado como função pura porque a geometria é a regra do bicho, não um detalhe do componente:
 * `tools/tmp/render-gorila.cjs` rasteriza exatamente estes traços num PNG e os olhos conferem o
 * resultado antes de qualquer navegador. Um sprite que só existe dentro de um `<Group>` não pode
 * ser lido por ninguém.
 */
export function gorilaQuadro(away: boolean, frame: number): Frame {
  const pose = POSES[frame];
  const p = pintor();
  const { rect, poly } = p;
  const y = -pose.alto;
  const perto = pose.perna;
  const longe = -pose.perna * 0.8;
  // O joelho que dobra: a canela encurta e o pé sobe do chão. O outro lado continua plantado,
  // e é esse contraste — um pé no chão, um pé no ar — que faz a passada ler como peso.
  const dobraPerto = Math.max(0, pose.dobra);
  const dobraLonge = Math.max(0, -pose.dobra);
  const cab = { x: pose.cabeça[0], y: pose.cabeça[1] + y + pose.inclina * 1.2 };

  /**
   * Tronco com o ombro levantado (`alto`, só na metade de cima) e derrubado para a frente
   * (`inclina`, só no lado que olha para a câmera). Sem isso, "o corpo inclina" seria um
   * quadro novo desenhado à mão e a inclinação não casaria com a cabeça.
   */
  const torço = (pts: readonly (readonly [number, number])[]) => pts.map(([x, yy]) => [x,
    yy - pose.alto * Math.min(1, Math.max(0, 60 - yy) / 34)
      + pose.inclina * Math.max(0, x - 44) / 34] as const);
  const cranio = (pts: readonly (readonly [number, number])[]) =>
    pts.map(([x, yy]) => [x + cab.x, yy + cab.y] as const);

  if (away) {
    // ---- de costas: ombro largo, lombo prateado, cabeça perdida atrás do ombro ----
    // Visto por trás, o gigante é quase um triângulo: os braços caem nas duas bordas e chegam
    // ao chão, e o quadril fica estreito embaixo. Os braços são desenhados DEPOIS do tronco
    // porque eles são o que sobra dele na silhueta — antes, some o braço por baixo da massa.
    // O balanço lateral é a metade visível da passada daqui: o corpo pende para o lado que está
    // plantado, e o outro lado sobe com o pé do chão.
    const bal = perto * 0.35;
    const pend = (pts: readonly (readonly [number, number])[]) => pts.map(([x, yy]) => [x,
      yy - pose.alto * Math.min(1, Math.max(0, 60 - yy) / 34)
        + bal * (x - 48) / 34 + pose.inclina * 0.5] as const);
    poly(0, pend([[14, 66], [20, 40], [34, 22], [48, 16], [62, 22], [76, 40],
      [82, 66], [74, 82], [58, 90], [38, 90], [22, 82]]));
    poly(1, pend([[18, 65], [24, 43], [36, 27], [48, 21], [60, 27], [72, 43],
      [77, 65], [70, 79], [57, 86], [39, 86], [26, 79]]));
    // O manto de prata é o LOMBO, não um escudo no meio das costas: uma faixa colada na espinha,
    // larga no ombro e afunilando até o começo do quadril. Cheia de tinta clara, a silhueta virava
    // um ovo com pernas — e o jogador parava de ler o bicho e só via o desenho.
    poly(5, pend([[24, 30], [36, 24], [48, 22], [60, 24], [72, 30], [66, 44], [56, 54],
      [48, 58], [40, 54], [30, 44]]));
    poly(7, pend([[32, 30], [40, 26], [48, 25], [56, 26], [64, 30], [58, 39], [48, 44], [38, 39]]));
    poly(3, pend([[24, 80], [38, 88], [58, 88], [72, 80], [68, 88], [56, 94], [40, 94], [28, 88]]));
    // O crânio visto por trás: um calombo ACIMA da linha do ombro, com uma orelha de cada lado.
    poly(0, cranio([[38, 22], [48, 10], [58, 22], [56, 33], [40, 33]]));
    poly(1, cranio([[41, 23], [48, 14], [55, 23], [53, 31], [43, 31]]));
    rect(0, 33 + cab.x, 19 + cab.y, 7, 12);
    rect(1, 34 + cab.x, 21 + cab.y, 5, 8);
    rect(0, 56 + cab.x, 19 + cab.y, 7, 12);
    rect(1, 57 + cab.x, 21 + cab.y, 5, 8);
    if (pose.braços === 'alto') {
      // Os dois braços sobem pelo lado de fora do corpo e os punhos encostam neles: o erro da
      // versão anterior era um quadrado solto no alto da tela, que lia como orelha e não como
      // punho. O ombro, o cotovelo e o punho têm de se tocar na silhueta.
      bloco(p, 16, 24 + y, 18, 34, 1, 2);
      bloco(p, 10, 2 + y, 18, 30, 1, 2);
      extremidade(p, 6, 0 + y, 24, 16);
      bloco(p, 62, 24 + y, 18, 34, 1, 2);
      bloco(p, 68, 2 + y, 18, 30, 1, 2);
      extremidade(p, 66, 0 + y, 24, 16);
    } else if (pose.braços === 'baixo') {
      // De costas, o golpe é o contrário do windup: os cotovelos abrem, os ombros sobem e a
      // cabeça some entre eles. É o quadro que diz "acabou de bater" sem precisar ver o alvo —
      // e por isso os punhos têm de estar embaixo, rentes ao chão que ele acabou de acertar.
      bloco(p, 6, 36 + y, 20, 42, 1, 2);
      bloco(p, 70, 36 + y, 20, 42, 1, 2);
      extremidade(p, 0, 76 + y, 22, 15);
      extremidade(p, 74, 76 + y, 22, 15);
      rect(7, 4, 96, 12, 3);
      rect(7, 80, 97, 12, 3);
    } else if (pose.braços === 'peito' || pose.braços === 'aberto') {
      // Bater no peito visto por trás são os COTOVELOS: abertos quando o punho está armado,
      // colados no corpo no instante da batida. Os punhos em si somem atrás do lombo.
      const fora = pose.braços === 'aberto' ? 10 : 0;
      bloco(p, 12 - fora, 34 + y, 19, 30, 1, 2);
      bloco(p, 65 + fora, 34 + y, 19, 30, 1, 2);
      bloco(p, 18 - fora * 2, 60 + y, 16, 16, 1, 2);
      bloco(p, 62 + fora * 2, 60 + y, 16, 16, 1, 2);
    } else {
      bloco(p, 10 + perto * 0.4, 44 + y, 18, 46, 1, 2);
      bloco(p, 68 + longe * 0.4, 44 + y, 18, 46, 1, 2);
      extremidade(p, 6 + perto * 0.4, 90 - dobraPerto * 0.6, 24, 12);
      extremidade(p, 66 + longe * 0.4, 90 - dobraLonge * 0.6, 24, 12);
    }
    // As duas pernas de costas: a que está plantada desce reta até o chão, a que passa encurta e
    // levanta o pé. Sem a diferença de altura os cinco quadros de marcha saíam idênticos.
    const perna = (x: number, dx: number, dobra: number, base: number, tinta: number, luz: number) => {
      bloco(p, x + dx, 74, 15, 26 - dobra * 0.5, tinta, luz);
      extremidade(p, x + dx - 4, 98 - dobra, 21, 11);
      if (dobra > 0) rect(6, x + dx - 4, 98 - dobra, 21, 3);
    };
    perna(32, perto * 0.5, dobraPerto, 0, 1, 2);
    perna(49, longe * 0.5, dobraLonge, 0, 1, 2);
    return p.paths;
  }

  // ---- o lado atrás do corpo ----
  if (pose.braços === 'alto') {
    // Os dois punhos sobem juntos — um gigante não alivia um braço — mas em alturas diferentes.
    // No mesmo nível eles se encostam e a silhueta vira uma laje só, e uma laje não lê como
    // "ele está levantando os dois braços".
    bloco(p, 36, 28 + y, 16, 26, 1, 2);
    bloco(p, 24, 10 + y, 16, 26, 1, 2);
    extremidade(p, 18, 8 + y, 22, 16);
  } else if (pose.braços === 'peito') {
    bloco(p, 32, 36 + y, 15, 24, 1, 2);
    extremidade(p, 34, 46 + y, 17, 15);
  } else if (pose.braços === 'aberto') {
    bloco(p, 38, 30 + y, 15, 22, 1, 2);
    extremidade(p, 30, 22 + y, 18, 15);
  } else if (pose.braços === 'baixo') {
    // O outro braço acompanha o golpe mas fica atrás do tronco e desce menos: dois punhos no
    // mesmo ponto virariam um bloco só na silhueta.
    bloco(p, 40, 40 + y, 15, 30, 1, 2);
    extremidade(p, 42, 68 + y, 20, 15);
  } else {
    bloco(p, 40 + longe * 0.5, 38 + y, 16, 30, 1, 2);
    bloco(p, 42 + longe * 0.5, 64 + y, 15, 28 - dobraLonge * 0.4, 1, 2);
    extremidade(p, 38 + longe * 0.5, 88 - dobraLonge, 20, 10);
  }
  // Perna de trás do corpo: coxa, canela e pé deslocados pelo mesmo `longe`, com o joelho
  // dobrando quando é ela que passa por baixo.
  bloco(p, 28 + longe * 0.5, 58 + y, 19, 26 - dobraLonge * 0.4, 1, 2);
  bloco(p, 30 + longe * 0.5, 82, 15, 16 - dobraLonge * 0.5, 1, 2);
  extremidade(p, 26 + longe * 0.5, 96 - dobraLonge, 22, 10);

  // ---- tronco ----
  // O dorso desaba do ombro (alto, à frente) para o quadril (baixo, atrás): é a linha que faz um
  // dorsípede ler como dorsípede.
  poly(0, torço([[8, 56], [14, 42], [28, 30], [46, 22], [64, 22], [74, 30],
    [80, 44], [80, 60], [74, 74], [56, 84], [32, 84], [16, 72]]));
  poly(1, torço([[12, 55], [18, 44], [30, 34], [46, 26], [62, 26], [70, 33],
    [76, 45], [76, 59], [70, 71], [55, 80], [33, 80], [19, 70]]));
  // Quadril e ventre no pelo médio: a prata termina onde a perna começa, senão o bicho parece
  // estar vestindo uma canga.
  poly(2, torço([[14, 60], [30, 72], [52, 76], [68, 68], [72, 58], [68, 74], [50, 82], [26, 80], [15, 70]]));
  // O manto de prata: uma faixa colada na crista do dorso, do ombro ao quadril, com a largura de
  // um palmo. Largo demais, ela engolia o corpo inteiro e o gigante virava um ovo claro com
  // pernas — o que assusta é o lombo prateado SE MOVENDO entre as árvores, não a mancha.
  poly(5, torço([[18, 46], [30, 35], [46, 29], [62, 28], [70, 33], [64, 41], [50, 41],
    [36, 45], [24, 54]]));
  poly(7, torço([[26, 40], [38, 32], [52, 29], [62, 30], [58, 36], [46, 38], [34, 43]]));
  // Ombro iluminado: o volume que a luz do dossel pega primeiro.
  poly(4, torço([[56, 24], [68, 27], [77, 36], [78, 46], [70, 40], [62, 32], [55, 28]]));
  poly(3, torço([[10, 54], [22, 48], [28, 60], [20, 70], [10, 64]]));

  // ---- cabeça: pendurada à frente e abaixo do ombro, onde um dorsípede a põe ----
  poly(0, cranio([[70, 40], [82, 33], [93, 39], [96, 51], [90, 62], [77, 63], [69, 52]]));
  poly(1, cranio([[73, 41], [82, 36], [90, 41], [92, 50], [87, 58], [77, 58], [72, 49]]));
  // Orelha e sobrancela óssea: a barra escura que faz a cara ler "irritado" a dez tiles.
  rect(0, 67 + cab.x, 45 + cab.y, 7, 12);
  rect(1, 68 + cab.x, 47 + cab.y, 5, 8);
  rect(0, 74 + cab.x, 43 + cab.y, 21, 5);
  poly(2, cranio([[76, 48], [88, 47], [93, 52], [88, 58], [78, 57]]));
  // Focinho para baixo e para frente, nunca redondo: é o que separa um gorila de um ursinho.
  poly(6, cranio([[82, 52], [95, 52], [93, 62], [82, 62]]));
  rect(0, 84 + cab.x, 57 + cab.y, 10, 3);
  // Narina e olho: dois pontos claros no couro escuro. O olho é o único contato do bicho com você.
  rect(0, 90 + cab.x, 54 + cab.y, 3, 3);
  rect(0, 78 + cab.x, 46 + cab.y, 5, 3);
  rect(7, 79 + cab.x, 47 + cab.y, 2, 2);
  // A boca aberta do aviso é uma fresta no focinho, não um tijolo preto na cara: desenhada
  // larga, ela engolia o maxilar e o rosto inteiro virava um quadrado escuro.
  if (pose.braços === 'peito' || pose.braços === 'aberto') {
    rect(6, 83 + cab.x, 58 + cab.y, 9, 4);
    rect(0, 84 + cab.x, 59 + cab.y, 7, 2);
  }

  // ---- o lado perto da câmera ----
  if (pose.braços === 'alto') {
    // Os punhos sobem pelo lado de DENTRO do ombro, não por cima da cabeça: levantado sobre o
    // rosto, o braço do gigante tapava o crânio inteiro e o windup era um corpo sem cabeça.
    bloco(p, 52, 22 + y, 19, 34, 2, 3);
    bloco(p, 48, 2 + y, 19, 28, 2, 3);
    extremidade(p, 44, 0 + y, 24, 17);
  } else if (pose.braços === 'peito') {
    // Cotovelo fechado e punho SOBRE a prata: é o contraste que faz o gesto ler "bater no
    // peito" e não "coçar a barriga". O punho fica à esquerda da cabeça — posto sobre o rosto,
    // ele desaparece na cara e o quadro vira um borrão.
    bloco(p, 44, 34 + y, 17, 26, 2, 3);
    bloco(p, 46, 54 + y, 24, 12, 2, 3);
    extremidade(p, 50, 40 + y, 18, 16);
    rect(4, 44, 40 + y, 14, 5);
  } else if (pose.braços === 'aberto') {
    bloco(p, 52, 28 + y, 18, 26, 2, 3);
    bloco(p, 62, 16 + y, 18, 18, 2, 3);
    extremidade(p, 66, 8 + y, 20, 16);
    rect(4, 66, 22 + y, 12, 5);
  } else if (pose.braços === 'baixo') {
    // O golpe: o braço cai na vertical, à frente do peito, e o punho bate no chão MAIS BAIXO que
    // os pés. Um palmo acima disso o quadro era só o gigante parado apoiado nos nós dos dedos —
    // é o que faltava para o jogador levar o dano sem nunca ver o dano sendo desferido. A cabeça
    // fica à direita do braço: o focinho continua vendo, o que se esconde é só a bochecha, e um
    // gorila que bate realmente recolhe o queixo.
    bloco(p, 50, 26 + y, 20, 30, 2, 3);
    bloco(p, 56, 50 + y, 20, 40, 2, 3);
    extremidade(p, 52, 88 + y, 26, 16);
    rect(4, 58, 56 + y, 12, 5);
    // O que levanta do chão no instante da pancada: duas lascas claras e a poeira rente ao solo,
    // em altura FIXA — é o chão que reage, não o corpo.
    rect(7, 42, 100, 9, 3);
    rect(7, 80, 101, 9, 3);
    rect(4, 48, 108, 36, 2);
  } else {
    // O nó dos dedos no chão: o braço é tão longo que a passada é um balanço sobre ele, e é essa
    // linha vertical do ombro ao solo que faz o bicho parecer impossível.
    bloco(p, 52 + perto * 0.5, 30 + y, 20, 36, 2, 3);
    bloco(p, 54 + perto * 0.5, 62 + y, 18, 34 - dobraPerto * 0.3, 2, 3);
    extremidade(p, 50 + perto * 0.5, 94 - dobraPerto * 0.5, 24, 12);
  }
  bloco(p, 12 + perto * 0.55, 56 + y, 24, 28 - dobraPerto * 0.35, 2, 3);
  bloco(p, 14 + perto * 0.55, 82, 18, 18 - dobraPerto * 0.5, 2, 3);
  extremidade(p, 8 + perto * 0.55, 98 - dobraPerto, 26, 11);
  return p.paths;
}

interface Arte { frames: Frame[]; sombra: SkPath }
let cache: Arte | null = null;

/** Índice da primeira vista de costas: as duas vistas compartilham a numeração de pose. */
const VISTAS = POSES.length;

/** Nove poses por vista (parada, quatro de marcha, windup, batida, golpe, punhos armados), espelhadas em quatro direções. */
function getArte(): Arte {
  if (cache) return cache;
  const frames = [false, true].flatMap((away) =>
    POSES.map((_, frame) => gorilaQuadro(away, frame)));
  const sombra = Skia.Path.Make();
  // A sombra de contato é larga como a base do bicho: um gigante sem ela flutua na mata.
  sombra.addRect(Skia.XYWHRect(-28, -6, 56, 3));
  sombra.addRect(Skia.XYWHRect(-34, -3, 68, 5));
  sombra.addRect(Skia.XYWHRect(-26, 2, 52, 3));
  return (cache = { frames, sombra });
}

type Pose = ReturnType<typeof gorilaPose>;

function Camada({ frames, tinta, cor, pose }: {
  frames: Frame[]; tinta: number; cor: string; pose: SharedValue<Pose>;
}) {
  const path = useDerivedValue(() => frames[(pose.value.away ? VISTAS : 0) + pose.value.frame][tinta],
    [frames, tinta, pose]);
  return <Path path={path} color={cor} antiAlias={false} />;
}

export function GorilaSprite({ gorila, position, visual, clock }: GorilaSpriteProps) {
  const arte = useMemo(getArte, [gorila.id]);
  const pose = useDerivedValue(() => gorilaPose(visual.value, clock.value), [visual, clock]);
  const opacidade = useDerivedValue(() => pose.value.alpha, [pose]);
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
    <Group transform={tela} opacity={opacidade} antiAlias={false}>
      <Path path={arte.sombra} color="#20261f" opacity={0.28} />
      <Group transform={corpo}>
        {PALETA.map((cor, tinta) => (
          <Camada key={tinta} frames={arte.frames} tinta={tinta} cor={cor} pose={pose} />
        ))}
      </Group>
    </Group>
  );
}
