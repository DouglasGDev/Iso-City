import { useMemo } from 'react';
import { Group, Path, Skia, type SkPath } from '@shopify/react-native-skia';
import { useDerivedValue, type SharedValue } from 'react-native-reanimated';
import { guerreiroPose, type GuerreiroVisualState } from '../entities/Guerreiro';
import { worldToScreen } from '../world/IsoUtils';

/**
 * O guerreiro da aldeia, desenhado em contornos autorados — o mesmo contrato do gigante e da
 * piranha: nenhuma imagem externa, nenhum atlas, nenhuma licença. Geometria em grade inteira, oito
 * tintas por quadro, cache por pose.
 *
 * A escala é a mensagem, e aqui ela é o contrário da do gigante: um homem de setenta quilos tem de
 * ler *homem* antes de ler "inimigo". São 46 px de altura contra os 32 do jogador — o dobro do
 * braço com o porrete, não o dobro do corpo. Um guerreiro do tamanho do player sumiria na grama e
 * a aldeia voltaria a ser desenho; um guerreiro do tamanho de um armário seria mais um monstro da
 * fronteira, e o lugar inteiro existe porque ele é *gente com casa*.
 */

export interface GuerreiroSpriteProps {
  /** Identidade estável apenas: o corpo mutável nunca atravessa para a UI thread. */
  guerreiro: { id: number };
  /** Tiles de mundo, não pixels. `h` é a cota do chão publicada pelo laço de simulação. */
  position: SharedValue<{ x: number; y: number; h: number }>;
  /** Publica `guerreiroVisualState(corpo, game.time)` junto da posição, a cada tick. */
  visual: SharedValue<GuerreiroVisualState>;
  clock: SharedValue<number>;
}

// Pele queimada de mato, ocre no tecido, osso nos colares e vermelhão na pintura de guerra. A
// ordem é a fila de pintura: 0 é o contorno de tudo e 7 é o que nunca pode ser coberto — por isso
// o osso e o brilho do golpe são 7, não uma tinta média (é a mesma armadilha que deixou os punhos
// do gigante em tijolos lisos).
const PALETA = [
  '#120e0a', '#3d2a1a', '#8a5a35', '#b9773f', '#c8963c', '#8d2f1d', '#332d27', '#efe4c6',
] as const;

/** Quadro em pixels de tela. Base no pé: o transform ancora (w/2, h) no ponto do mundo. */
const LARGURA = 36;
const ALTURA = 46;
/** O chão do desenho: os pés encostam aqui e o porrete erguido tem de caber acima. */
const SOLO = 45;

/**
 * A caixa que a neblina corta, no ponto do mundo onde o corpo pisa. Vive ao lado da arte porque é a
 * arte que sabe o próprio tamanho: se o porrete crescer, o recorte cresce junto, e um número escrito
 * na camada de desenho seria um guerreiro decepado na beira da tela.
 *
 * Os números são o quadro de `LARGURA`x`ALTURA` ancorado no pé folgado no que a pose faz com ele: o
 * `bob` da passada desce 2,2 px e o `offsetY` da queda levanta 3, o `scaleX` do espelho inverte o
 * meio-quadro, e a tinta dos traços tem de caber com sobra. O cadáver tombando gira até 1,35 rad em
 * volta do pé, e aí a cabeça sai da caixa por uns pixels — é aceito de propósito: isto é um teste de
 * descarte, não um recorte de pintura, e alargar a caixa até o ângulo morto do caído pagaria custo de
 * névoa por um corpo que já está sumindo.
 */
export function caixaDoGuerreiro(sx: number, sy: number) {
  return { x: sx - 30, y: sy - 62, width: 60, height: 78 };
}

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
 * Um membro: contorno por fora, tinta base no meio, luz na face que a câmera pega. Empilhados do
 * ombro ao pulso eles dão o volume; um pau de dois pixels com contorno é o que faz um personagem
 * procedural ler como boneco de palito.
 */
function membro(p: ReturnType<typeof pintor>, x: number, y: number, w: number, h: number,
  base: number, luz: number): void {
  p.rect(0, x - 1, y - 1, w + 2, h + 2);
  p.rect(base, x, y, w, h);
  if (w >= 4 && h >= 6) p.rect(luz, x + 1, y + 2, Math.max(1, w - 3), Math.max(1, h - 5));
}

/** A mão, sempre por cima do membro que a segura: couro escuro com um fio de osso nos nós. */
function mo(p: ReturnType<typeof pintor>, x: number, y: number, lado: 1 | -1): void {
  p.rect(0, x - 1, y - 1, 6, 6);
  p.rect(1, x, y, 4, 4);
  p.rect(7, lado > 0 ? x + 2 : x, y + 1, 2, 1);
}

/** O pé: quem pisa, com o calcanhar mais escuro que o peito do pé. */
function pe(p: ReturnType<typeof pintor>, x: number, y: number, dx: number): void {
  p.rect(0, x - 1, y - 1, 9, 5);
  p.rect(1, x, y, 7, 3);
  p.rect(2, dx > 0 ? x + 3 : x, y, 4, 2);
}

/** O alcance do braço com a arma: do punho ao centro da pedra. */
const CABO = 10;
/** Meia-largura da cabeça de obsidiana. */
const PEDRA = 3.5;

/**
 * O porrete ancorado no punho que o segura: do ponto (x, y) saem `CABO` pixels de cabo na direção
 * (dx, dy) e a cabeça de pedra fecha no fim dela.
 *
 * Ancorar na mão é o que faz a arma existir. Desenhada por coordenadas soltas em cada pose, ela era
 * cinco comprimentos que discordavam: uma cabeça flutuando três pixels acima do punho que a erguia,
 * outra no quadril de quem gritava de braços vazios, e o windup atravessando a cara do próprio dono
 * — os três defeitos que a primeira versão tinha e que nenhum check de geometria absoluta vê, porque
 * cada um deles, sozinho, está "dentro da caixa". Aqui, se o braço se move, a pedra vai junto por
 * construção, e o giro do golpe é visível porque gira o *punho*, não o desenho.
 */
function porrete(p: ReturnType<typeof pintor>, x: number, y: number, dx: number, dy: number): void {
  const n = Math.hypot(dx, dy) || 1;
  const ux = dx / n, uy = dy / n;
  const vx = -uy, vy = ux;
  const ponta = { x: x + ux * CABO, y: y + uy * CABO };
  // Cabo: contorno por fora, madeira por dentro, e a atadura de couro no punho — sem ela a pedra
  // parece colada no cabo por milagre e a mão parece segurar o ar.
  const lado = (w: number): readonly (readonly [number, number])[] =>
    [[x + vx * w, y + vy * w], [x - vx * w, y - vy * w],
      [ponta.x - vx * w, ponta.y - vy * w], [ponta.x + vx * w, ponta.y + vy * w]];
  p.poly(0, lado(1.9));
  p.poly(1, lado(1.1));
  p.rect(4, x - 1.2, y - 1.2, 2.6, 2.6);
  // A cabeça de pedra: um octógano lascado, não um quadrado — o mesmo motivo do punho do gigante,
  // onde o tijolo liso denunciava a escala. O chip de osso é a quina que pega a luz.
  const h = PEDRA;
  const chanfro = h * 0.42;
  const faceta = (r: number): readonly (readonly [number, number])[] => [
    [ponta.x - r + chanfro, ponta.y - r], [ponta.x + r - chanfro, ponta.y - r],
    [ponta.x + r, ponta.y - r + chanfro], [ponta.x + r, ponta.y + r - chanfro],
    [ponta.x + r - chanfro, ponta.y + r], [ponta.x - r + chanfro, ponta.y + r],
    [ponta.x - r, ponta.y + r - chanfro], [ponta.x - r, ponta.y - r + chanfro]];
  p.poly(0, faceta(h + 0.9));
  p.poly(6, faceta(h));
  p.rect(7, ponta.x - 1.5, ponta.y - 1.5, 2, 2);
}

/**
 * A corda que sai do punho de quem puxa e desce até fora da caixa.
 *
 * O prisioneiro **não** é desenhado aqui. Durante séculos de pixel art um corpo carregado num sprite
 * de 36×46 é um problema sem solução — as quatro tentativas desta folha provaram: o volume dentro da
 * silhueta de quem carrega é lido como parte de quem carrega, e o volume fora dela é lido como um
 * saco pendurado — mas o motivo decisivo não é de escala, é de duplicação: o corpo arrastado pela
 * `TriboSystem` **é o jogador**, com sprite, sombra e lugar próprio na fila ordenada. Pintar um
 * segundo homem neste quadro seria o mesmo homem desenhado duas vezes, em duas posições que nenhum
 * dos dois sistemas combinou entre si.
 *
 * Então o sprite diz só a metade que é dele: a corda. Ela sai das duas mãos juntas, atrás do
 * quadril, e desce para fora da caixa na direção de onde o corpo vem — e é o jogador, logo ali
 * atrás, que fecha a frase. Contorno escuro primeiro e fio de osso por cima: osso claro sobre o
 * verde do chão, sem borda, é um caco caído, não um barbante sob tensão.
 */
function corda(p: ReturnType<typeof pintor>, x: number, y: number): void {
  p.poly(0, [[x - 1, y - 1], [x + 2.5, y - 1], [x - 6, SOLO + 1], [x - 9.5, SOLO + 1]]);
  p.poly(7, [[x, y], [x + 1.4, y], [x - 6.6, SOLO], [x - 8, SOLO]]);
}

/**
 * A pose de cada quadro, em pixels dentro da caixa 36x46.
 *
 * `perna` desloca o lado perto da câmera e `longe` o outro, em sentidos opostos: num humano ereto a
 * passada é diagonal — o contrário do dorsípede, onde o braço é antepé. `dobra` é o joelho da
 * perna que passa por baixo (o pé sobe, a canela encurta); `alto` é o corpo subindo sobre o apoio;
 * `inclina` derruba o ombro para a frente, e é o que faz o golpe *descer* na tela em vez de o
 * sprite apenas trocar de desenho.
 */
interface PoseArte {
  alto: number;
  perna: number;
  dobra: number;
  inclina: number;
  cab: readonly [number, number];
  braços: 'descanso' | 'anda' | 'alto' | 'sentinela' | 'golpe' | 'arrasta';
}

const POSES: readonly PoseArte[] = [
  { alto: 0, perna: 0, dobra: 0, inclina: 0, cab: [0, 0], braços: 'descanso' },
  { alto: 0, perna: 5, dobra: 0, inclina: 1, cab: [1, 0], braços: 'anda' },
  { alto: 2, perna: 2, dobra: 4, inclina: 0, cab: [0, -1], braços: 'anda' },
  { alto: 0, perna: -5, dobra: 0, inclina: 1, cab: [-1, 0], braços: 'anda' },
  { alto: 2, perna: -2, dobra: -4, inclina: 0, cab: [0, -1], braços: 'anda' },
  { alto: 1, perna: 1, dobra: 0, inclina: -2, cab: [0, -1], braços: 'alto' },
  { alto: 0, perna: 0, dobra: 0, inclina: -1, cab: [0, 0], braços: 'sentinela' },
  { alto: 1, perna: 3, dobra: 0, inclina: 6, cab: [2, 2], braços: 'golpe' },
  // Quem arrasta um corpo não anda: arma uma base. Os dois pés ficam plantados, afastados, o corpo
  // tomba para *longe* do peso e as duas mãos pendem atrás, na corda. `alto` é zero de propósito —
  // o arrasto não sobe nem desce, ele raspa, e é justamente a ausência de balanço que o distingue
  // da patrulha a um tile de distância.
  { alto: 0, perna: 4, dobra: 0, inclina: 3, cab: [1, 1], braços: 'arrasta' },
];

/**
 * O quadro de uma pose. `away` é a vista de costas (NE/NW), e as duas vistas compartilham a
 * numeração do `guerreiroPose`: 0 parado, 1..4 marcha, 5 porrete no alto, 6 braço armado de
 * sentinela, 7 o golpe chegando, 8 o arrasto do prisioneiro.
 *
 * A ordem de desenho é a anatomia: o lado atrás do corpo, o tronco, a cabeça, e por último o lado
 * perto da câmera com a arma — assim o contorno do membro próximo separa braço de tronco em vez de
 * engolir o rosto.
 *
 * Exportado como função pura porque a geometria é a regra do corpo, não um detalhe do componente:
 * `tools/tmp/render-guerreiro.cjs` rasteriza exatamente estes traços num PNG antes de qualquer
 * navegador. Um sprite que só existe dentro de um `<Group>` não pode ser lido por ninguém.
 */
export function guerreiroQuadro(away: boolean, frame: number): Frame {
  const pose = POSES[frame];
  const p = pintor();
  const { poly, rect } = p;
  const y = -pose.alto;
  const perto = pose.perna;
  const longe = -pose.perna * 0.8;
  const dobraPerto = Math.max(0, pose.dobra);
  const dobraLonge = Math.max(0, -pose.dobra);
  const cab = { x: pose.cab[0], y: pose.cab[1] + y + pose.inclina * 0.9 };
  const inclina = (pts: readonly (readonly [number, number])[]) => pts.map(([x, yy]) => [x,
    yy - pose.alto * Math.min(1, Math.max(0, 30 - yy) / 18)
    + pose.inclina * Math.max(0, x - 18) / 9] as const);
  const cranio = (pts: readonly (readonly [number, number])[]) =>
    pts.map(([x, yy]) => [x + cab.x, yy + cab.y] as const);
  const corpoX = away ? 18 : 20;

  // ---- o lado atrás do corpo ----
  if (pose.braços === 'alto') {
    // No windup os dois braços sobem, e o de trás sobe *atrás* da cabeça: é o que faz o gesto ler
    // dois braços e não um só com a pedra em cima do rosto.
    membro(p, corpoX - 11, 12 + y, 4, 10, 1, 2);
    mo(p, corpoX - 12, 9 + y, -1);
  } else if (pose.braços === 'sentinela') {
    // Quem avisa ergue uma mão só; a outra fica no porrete plantado no chão, ao lado do pé. Duas
    // mãos vazias fariam do grito um homem indefeso — e a silhueta do aviso precisa dizer que ele
    // está armado *enquanto* chama, senão o jogador não sabe se ainda dá tempo de correr.
    membro(p, corpoX - 12, 20 + y, 4, 12, 1, 2);
    mo(p, corpoX - 13, 31 + y, -1);
    porrete(p, corpoX - 11.5, 32.5 + y, 0.3, 1);
  } else if (pose.braços === 'arrasta') {
    // No arrasto os dois braços caem para trás e para baixo, pendurados no peso, e a arma não aparece
    // em parte alguma: de duas mãos que puxam uma corda, nenhuma está livre para segurar um porrete.
    // É o quadro mais desarmado do sprite, e é ele que torna o carregador o alvo mais gordo da
    // clareira — a terceira porta de escape da captura, documentada na `TriboSystem`, começa aqui,
    // no desenho, e não num número de vida.
    membro(p, corpoX - 13, 21 + y, 4, 9, 1, 2);
  } else {
    membro(p, corpoX - 11 + longe * 0.4, 20 + y, 4, 13, 1, 2);
    mo(p, corpoX - 12 + longe * 0.4, 32 + y, -1);
  }
  // Perna de trás: coxa, canela e pé deslocados pelo mesmo `longe`, com o joelho dobrando quando é
  // ela que passa por baixo.
  membro(p, corpoX - 8 + longe * 0.4, 32 + y * 0.4, 6, SOLO - 33 - dobraLonge * 0.4, 1, 2);
  pe(p, corpoX - 10 + longe * 0.4, SOLO - dobraLonge, longe);

  // ---- tronco ----
  poly(0, inclina([[12, 19], [14, 16], [22, 15], [25, 18], [26, 28], [24, 33], [13, 33], [11, 26]]));
  poly(2, inclina([[13, 20], [15, 17], [21, 16], [24, 19], [25, 28], [23, 32], [14, 32], [12, 26]]));
  // O saiote de ocre marca a cintura e a linha do quadril: sem ele o torso é um retângulo de pele
  // e o corpo inteiro parece nu de um jeito que o atlas não pretende.
  poly(4, inclina([[12, 30], [25, 30], [26, 36], [22, 38], [15, 38], [11, 36]]));
  poly(5, inclina([[12, 30], [25, 30], [25, 32], [12, 32]]));
  // Peito pintado: duas barras de vermelhão na diagonal, do ombro ao esterno. É o que faz a
  // silhueta ler "guerreiro" e não "aldeão" a dez tiles, e é a única decoração do corpo com um
  // motivo que não é de enfeite: é a marca de quem sai em caçada.
  //
  // Só de frente, e a razão é a mesma de tudo nesta folha: a tinta está *na pele do peito*, então
  // quando ele vira as costas a pintura vai para o outro lado do corpo e não pode aparecer na
  // nuca. Deixá-la nas duas vistas era o que fazia a vista `away` ser o mesmo homem de frente sem
  // cara — e o que se desenha atrás é a espinha, logo abaixo.
  //
  // Transformadas pelo tronco (`inclina`), nunca pelo crânio: a pintura vive na pele do peito, e
  // quando o guerreiro se debruça sobre o golpe a cabeça desloca-se com `cab` enquanto o torso
  // tomba. Aplicada ao `cranio`, a barra descia um palmo a cada inclinação e acabava sobre o
  // saiote nos quadros 7 e 8 — o corpo ficava com a pintura do peito na cintura, e ninguém lê
  // guerra em cima de um abdômen liso.
  if (!away) poly(5, inclina([[15, 21], [18, 20], [22, 26], [19, 27]]));
  if (!away) poly(5, inclina([[14, 25], [17, 24], [21, 30], [18, 31]]));
  // De costas é a espinha que leva a pintura, e ela é outra coisa além de dois pontos de olho: as
  // escápulas em sombra de tinta 1, a faixa de guerra do meio das costas e o nó do cinto na
  // nuca do saiote. Sem isso, a vista `away` era o mesmo homem de frente sem cara — e uma vista
  // que só *omite* detalhes não é uma vista, é um desenho incompleto.
  if (away) {
    poly(1, inclina([[15, 18], [17, 19], [16, 24], [14, 22]]));
    poly(1, inclina([[21, 18], [23, 19], [22, 24], [20, 22]]));
    poly(5, inclina([[17, 20], [20, 20], [19, 30], [18, 30]]));
    poly(3, inclina([[16, 32], [20, 32], [21, 36], [19, 37], [17, 36]]));
  }
  // Colar de osso: um fio claro rente ao pescoço, tinta 7 porque nada pode cobri-lo.
  rect(7, 15 + cab.x, 19 + cab.y, 7, 2);

  // ---- cabeça ----
  poly(0, cranio([[14, 7], [17, 5], [22, 5], [25, 8], [25, 14], [22, 17], [16, 17], [13, 13]]));
  poly(2, cranio([[15, 8], [17, 6], [21, 6], [24, 9], [24, 14], [21, 16], [16, 16], [14, 13]]));
  // Cabelo amarrado para trás: a massa escura no alto e o tufo na nuca, que é o que dá leitura de
  // movimento quando o corpo gira.
  poly(1, cranio([[14, 6], [20, 4], [25, 7], [24, 9], [20, 7], [15, 8]]));
  if (away) {
    // De costas o crânio é cabelo, não cara: a massa fecha do alto até a nuca e o nó pendura sob a
    // linha do occipital.
    poly(1, cranio([[14, 6], [20, 4], [26, 7], [25, 15], [21, 17], [16, 16], [13, 12]]));
    poly(1, cranio([[18, 16], [22, 16], [21, 22], [18, 21]]));
    // As duas penas do nó: osso, tinta 7, com a base *dentro* da massa de cabelo. Um fio começando
    // acima do crânio flutuava dois pixels acima da cabeça e virava um caco solto no ar.
    poly(7, cranio([[20, 6], [22, -1], [23.5, 4], [21.5, 7]]));
    poly(7, cranio([[16, 6], [17, 0], [19, 4], [17.5, 7]]));
  } else {
    // A faixa de tecido na testa e os dois pontos de olho: o único contato dele com você antes do
    // grito. A faixa existe porque ela é o que segura a pena — sem ela o osso nascia do nada.
    rect(4, 14 + cab.x, 7 + cab.y, 10, 2);
    rect(0, 14 + cab.x, 7 + cab.y, 10, 1);
    rect(0, 17 + cab.x, 11 + cab.y, 2, 2);
    rect(0, 21 + cab.x, 11 + cab.y, 2, 2);
    // A pena, plantada na faixa e subindo para trás: a base encosta no tecido (y=7) e o topo fica
    // acima do cabelo, com largura própria — um fio de dois pixels é risco, não pena.
    poly(7, cranio([[15, 7], [14, 0], [16.5, 0], [17.5, 7]]));
  }

  // Perna da frente: a que está plantada desce reta até o chão, a que passa encurta e levanta o pé.
  // É desenhada antes do braço porque os dois se cruzam no quadril, e o que passa na frente de quê
  // não é escolha de quem desenha: o braço pende do ombro *por fora* da coxa, e com a perna por cima
  // a mão do guerreiro afundava na própria coxa e o porrete plantado no chão sumia atrás dela.
  membro(p, corpoX + 1 + perto * 0.5, 32 + y * 0.4, 6, SOLO - 33 - dobraPerto * 0.4, 2, 3);
  pe(p, corpoX + perto * 0.5, SOLO - dobraPerto, perto);

  // ---- o braço perto da câmera ----
  if (pose.braços === 'alto') {
    // O punho na altura da têmpora e a pedra subindo *em frente* à testa, deslocada para o lado de
    // quem vê: erguido sobre o rosto, o cabo atravessava a cara inteira e o windup era um corpo sem
    // cabeça — o mesmo erro que a primeira versão do gigante cometeu.
    membro(p, corpoX - 1, 15 + y, 5, 9, 2, 3);
    mo(p, corpoX + 1, 13 + y, 1);
    porrete(p, corpoX + 2.5, 14 + y, 0.35, -1);
  } else if (pose.braços === 'sentinela') {
    // O braço do grito: esticado para cima e para a frente, com a boca aberta. A arma fica na outra
    // mão, plantada no chão — ver o porrete *no chão* enquanto o braço sobe é o que distingue o
    // aviso do golpe na única fração de segundo em que ainda dá para virar as costas.
    membro(p, corpoX - 1, 14 + y, 5, 12, 2, 3);
    mo(p, corpoX, 10 + y, 1);
    rect(0, 18 + cab.x, 14 + cab.y, 4, 3);
    rect(6, 19 + cab.x, 15 + cab.y, 2, 1);
  } else if (pose.braços === 'golpe') {
    // O braço cai na diagonal e a pedra bate MAIS BAIXO que o joelho, no nível do chão. Um palmo
    // acima disso o quadro era só um homem apoiado no cabo, e o jogador levaria o dano sem nunca
    // ver o dano sendo desferido.
    membro(p, corpoX - 1, 20 + y + pose.inclina, 5, 12, 2, 3);
    mo(p, corpoX + 1, 30 + y + pose.inclina, 1);
    porrete(p, corpoX + 2.5, 31.5 + y + pose.inclina, 0.2, 1);
  } else if (pose.braços === 'arrasta') {
    // O braço perto da câmera faz o par com o de trás: os dois caem atrás do quadril e as duas mãos
    // fecham juntas no mesmo punho de corda, uma sobre a outra. É o único gesto do sprite em que
    // nenhum dos braços está livre, e é ele que amarra o corpo que anda sozinho na fila, logo atrás
    // dele — o jogador sendo arrastado, não um segundo homem pintado dentro deste desenho.
    membro(p, corpoX - 6, 20 + y, 5, 11, 2, 3);
    mo(p, corpoX - 14, 29 + y, -1);
    mo(p, corpoX - 11, 31 + y, 1);
    corda(p, corpoX - 9, 34 + y);
  } else if (pose.braços === 'descanso') {
    membro(p, corpoX - 3, 20 + y, 5, 13, 2, 3);
    mo(p, corpoX - 3, 32 + y, 1);
    // O porrete apoiado no chão, na mão: a pedra embaixo, o cabo subindo do punho para o quadril.
    // Segurá-lo erguido o tempo todo seria um golpe engatilhado em cada quadro parado.
    porrete(p, corpoX - 1.5, 33.5 + y, 0.15, 1);
  } else {
    membro(p, corpoX - 3 + perto * 0.5, 20 + y, 5, 13, 2, 3);
    mo(p, corpoX - 4 + perto * 0.5, 32 + y, 1);
    // Em marcha a pedra vai às costas, pendurada no punho que passa: carregar a arma erguida o
    // tempo todo seria um golpe engatilhado em cada passo da patrulha, e o aviso perderia o único
    // sinal que ele tem.
    porrete(p, corpoX - 2.5 + perto * 0.5, 33 + y, -0.45, -0.9);
  }

  return p.paths;
}

interface Arte { frames: Frame[]; sombra: SkPath }
let cache: Arte | null = null;

/** Índice da primeira vista de costas: as duas vistas compartilham a numeração de pose. */
const VISTAS = POSES.length;

/** Nove poses por vista (parado, quatro de marcha, windup, sentinela, golpe, arrasto), em duas vistas. */
function getArte(): Arte {
  if (cache) return cache;
  const frames = [false, true].flatMap((away) => POSES.map((_, frame) => guerreiroQuadro(away, frame)));
  const sombra = Skia.Path.Make();
  // A sombra de contato é a largura do passo, não a da carcaça: um homem flutua se a elipse sob os
  // pés for mais larga que os ombros.
  sombra.addRect(Skia.XYWHRect(-9, -3, 18, 3));
  sombra.addRect(Skia.XYWHRect(-12, -1, 24, 2));
  return (cache = { frames, sombra });
}

type Pose = ReturnType<typeof guerreiroPose>;

function Camada({ frames, tinta, cor, pose }: {
  frames: Frame[]; tinta: number; cor: string; pose: SharedValue<Pose>;
}) {
  const path = useDerivedValue(() => frames[(pose.value.away ? VISTAS : 0) + pose.value.frame][tinta],
    [frames, tinta, pose]);
  return <Path path={path} color={cor} antiAlias={false} />;
}

export function GuerreiroSprite({ guerreiro, position, visual, clock }: GuerreiroSpriteProps) {
  const arte = useMemo(getArte, [guerreiro.id]);
  const pose = useDerivedValue(() => guerreiroPose(visual.value, clock.value), [visual, clock]);
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
      <Path path={arte.sombra} color="#20261f" opacity={0.26} />
      <Group transform={corpo}>
        {PALETA.map((cor, tinta) => (
          <Camada key={tinta} frames={arte.frames} tinta={tinta} cor={cor} pose={pose} />
        ))}
      </Group>
    </Group>
  );
}
