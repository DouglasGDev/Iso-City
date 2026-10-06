import { memo, useMemo } from 'react';
import { Group, Path, Skia, type SkPath } from '@shopify/react-native-skia';
import { useDerivedValue, type SharedValue } from 'react-native-reanimated';
import type { TriboNode, TriboTipo } from './TriboStatics';

/**
 * O acampamento desenhado em contornos autorados — o mesmo contrato da fauna e do gigante:
 * nenhuma imagem externa, nenhum atlas, nenhuma licença. Geometria em grade inteira, oito tintas
 * por quadro, cache por forma.
 *
 * **A base de cada quadro é um círculo do mundo, não um número de desenho.** Um pino de colisão
 * é um círculo de raio `raio` em coordenada de tile; projetado em iso 2:1 ele é uma elipse de
 * semieixos `raio·64·√2` na largura e a metade disso na altura. Todo quadro aqui é autado com a
 * elipse do pé valendo exatamente `PÉ_*` pixels de largura, e o componente recebe `escala` — que
 * `TriboStatics` calcula a partir do raio do pino. Por construção, a parede que o jogador vê é a
 * parede em que ele bate: mudar `RAIO_DA_CABANA` no `Tribo` muda o desenho junto, e nenhuma
 * cabana pode nunca ficar maior que o seu colisor.
 *
 * **Por que espelhar sai de graça:** toda tinta é espelhada em bloco — a silhueta, a luz, as
 * sombras e o vão da porta são pares `(x, y)` e `(-x, y)` — e os únicos traços assimétricos são o
 * colmo do beiral e o degrau da porta, que desenham atrás do vão escuro (tinta 4) e por isso são
 * encobertos quando a porta troca de lado. Um espelho no eixo X de tela é o mesmo que virar a
 * cabana de 90° no mundo, e é assim que a porta fica voltada para a fogueira em todo lugar sem
 * precisar de quatro vistas por planta.
 *
 * Exportados como funções puras pelo mesmo motivo do `gorilaQuadro`: a geometria é a regra do
 * lugar, não um detalhe do componente, e `tools/tmp/render-cabana.cjs` rasteriza exatamente estes
 * traços num PNG antes de qualquer navegador. Um acampamento que só existe dentro de um `<Group>`
 * não pode ser lido por ninguém.
 */

/** Pixels de tela por tile de raio de mundo: a semieixo-X da elipse que um pino desenha. */
export const RAIO_DE_PIXEL = 64 * Math.SQRT2;

/**
 * Largura autada do pé de cada forma, em pixels de tela. `escala = meioDeMundo · RAIO_DE_PIXEL
 * / PÉ[tipo]` é a única conta que liga o desenho ao colisor, e ela é pública porque o check cobra
 * os dois lados dela: para cabana, totem e fogueira o `meioDeMundo` é o raio do pino que barra,
 * então a parede pintada é a parede em que o corpo encosta, por construção e não por atenção.
 */
export const PÉ = { cabana: 92, totem: 32, fogueira: 86, osso: 52, poste: 22 } as const;

/**
 * Caixa de recorte por forma, em pixels autados: [meia-largura, topo acima do pé, base abaixo].
 * Medida na folha impressa por `tools/tmp/render-cabana.cjs`, e não estimada de olho: é ela que a
 * neblina usa para cortar, e um traço que passa um pixel dela é um osso com a ponta mordida no
 * canto da tela. O osso é o que mais engana — ele jaz na diagonal, e a silhueta sobe 26 px acima
 * da linha do chão exatamente porque está caído, não em pé.
 */
const CAIXA: Record<TriboTipo, readonly [number, number, number]> = {
  cabana: [58, 140, 28],
  totem: [28, 156, 12],
  fogueira: [104, 74, 26],
  osso: [36, 30, 18],
  poste: [13, 76, 7],
};

const TINTAS = 8;
type Ponto = readonly [number, number];
type Frame = SkPath[];

/**
 * Oito tintas por quadro, e a ordem é a ordem de pintura: um traço de tinta 3 desenhado sobre um
 * de tinta 2 aparece, o contrário some. Por isso cada tipo tem a sua paleta com PAPEIS de camada,
 * não só cores (ver o comentário de `extremidade` no `GorilaSprite` — é o mesmo erro, e o mesmo
 * remédio).
 */
export const PALETAS: Record<TriboTipo, readonly string[]> = {
  // 0 contorno, 1 parede, 2 parede encharcada no pé, 3 barro iluminado, 4 o vão escuro,
  // 5 colmo do telhado, 6 palha escura e caimento, 7 palha ao sol e corda.
  cabana: ['#16110d', '#6b5136', '#3a2a1c', '#8d6f4a', '#0e0a07', '#8f7a3e', '#5c4c24', '#c9ae62'],
  // 0 contorno, 1 lenha e sombra da pedra, 2 pedra, 3 brasa no tronco, 4 pedra ao sol,
  // 5 chama funda, 6 chama, 7 núcleo e fagulha.
  fogueira: ['#16110d', '#2e2a26', '#575348', '#3a2a1c', '#8a8578', '#a8321e', '#e8792f', '#f7dd82'],
  // 0 contorno, 1 madeira na sombra, 2 madeira, 3 madeira ao sol, 4 sulco e boca,
  // 5 pintura de ocre, 6 entalhe claro, 7 osso e dente.
  totem: ['#16110d', '#3a2818', '#5b4029', '#7b5a38', '#221510', '#8c3b2a', '#c9b58c', '#e8ddbd'],
  // 0 contorno, 1 osso na sombra, 2 osso, 3 osso ao sol — as quatro últimas ficam vazias.
  osso: ['#16110d', '#5d5648', '#8a8170', '#c9bfa8', '#8a8170', '#5d5648', '#8a8170', '#c9bfa8'],
  // 0 contorno, 1 pedra do lastro na sombra, 2 pau na sombra, 3 pau ao sol, 4 o sulco da travessa,
  // 5 pedra do lastro ao sol, 6 corda, 7 corda ao sol.
  poste: ['#16110d', '#3f3b34', '#3a2818', '#5b4029', '#221510', '#8a8578', '#a8874f', '#d8c48c'],
};

function pintor(): {
  paths: Frame;
  rect: (tinta: number, x: number, y: number, w: number, h: number) => void;
  poly: (tinta: number, points: readonly Ponto[]) => void;
} {
  const paths = Array.from({ length: TINTAS }, () => Skia.Path.Make());
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
 * Pontos de uma elipse de projeção. O eixo X de tela vale `rx` e o Y vale `rx/2` quando a elipse
 * é a sombra de um círculo do mundo — é o que faz um pé redondo assentar no mesmo losando do
 * chão que o tile dele.
 */
function arco(cx: number, cy: number, rx: number, ry: number,
  θ0: number, θ1: number, passos: number): Ponto[] {
  const pts: Ponto[] = [];
  for (let i = 0; i <= passos; i++) {
    const θ = θ0 + (θ1 - θ0) * (i / passos);
    pts.push([cx + Math.cos(θ) * rx, cy + Math.sin(θ) * ry]);
  }
  return pts;
}

/**
 * A metade de frente de uma elipse de projeção: de `+rx` a `-rx` passando por baixo, que é onde o
 * pé do corpo encosta o chão que a câmera vê. Em tela, `y` cresce para baixo, então o arco da
 * frente é o de `seno` positivo.
 */
const frente = (cx: number, cy: number, rx: number, ry: number): Ponto[] =>
  arco(cx, cy, rx, ry, 0, Math.PI, 4);

/** O arco de trás, o que fecha a silhueta contra o céu. */
const costas = (cx: number, cy: number, rx: number, ry: number): Ponto[] =>
  arco(cx, cy, rx, ry, Math.PI, Math.PI * 2, 4);

function elipse(p: ReturnType<typeof pintor>, tinta: number, cx: number, cy: number,
  rx: number, ry: number): void {
  p.poly(tinta, arco(cx, cy, rx, ry, 0, Math.PI * 2, 8));
}

/** Bloco de madeira: contorno, corpo e uma face iluminada — poste, tábua, tronco. */
function tábua(p: ReturnType<typeof pintor>, x: number, y: number, w: number, h: number,
  escura: number, clara: number): void {
  p.rect(0, x - 2, y - 2, w + 4, h + 4);
  p.rect(escura, x, y, w, h);
  p.rect(clara, x + 2, y + 2, Math.max(2, w - 5), Math.max(2, h - 5));
}

/**
 * O corpo de uma cabana: contorno, parede, pé encharcado, barro ao sol e o vão escuro — tudo em
 * pares espelhados, de modo que um espelho no eixo X é o mesmo que virar a casa no mundo.
 *
 * `rx`/`ry` são os semieixos do PÉ (a meia-largura e a meia-altura em pixels autados, sempre na
 * proporção 2:1 da projeção) e `h` é a altura da parede. A faixa visível de um cilindro em iso é
 * o crescente entre o arco da frente da base e o arco da frente da boca do telhado — os dois
 * arcos de trás são céu e telhado, e é por isso que o contorno os usa e o preenchimento não.
 *
 * Os três formatos que o `Tribo` sorteia diferem na cobertura e no plano, não na parede: é o que
 * faz a aldeia ler como gente com três modos de construir, e não como um carimbo repetido.
 */
function corpo(p: ReturnType<typeof pintor>, rx: number, ry: number, h: number,
  larguraDaPorta: number, alturaDaPorta: number, away: boolean): void {
  const baseF = frente(0, 0, rx, ry);
  const bocaF = frente(0, -h, rx, ry);
  // A meia-largura da porta em x; o lábio de baixo tem de encostar a curva da base, senão a porta
  // é um retângulo flutuando em cima de um pé redondo.
  const yBorda = ry * Math.sqrt(Math.max(0, 1 - (larguraDaPorta / 2 / rx) ** 2));
  // Contorno: base pela frente, boca pelas costas — a silhueta inteira do tambor.
  p.poly(0, [...baseF.map(([x, y]) => [x, y + 2] as Ponto),
    ...costas(0, -h - 2, rx + 2, ry + 2)]);
  // A parede: o crescente entre os dois arcos da frente.
  p.poly(1, [...baseF, ...bocaF.slice().reverse()]);
  // O pé encharcado: a umidade da clareira sobe pela parede, mais alto no meio (onde a frente da
  // base está mais perto da câmera) que nas beiradas.
  const meia = rx * 0.6;
  p.poly(2, [[-rx, -2], [-meia, yBorda * 0.62], [0, ry + 1], [meia, yBorda * 0.62], [rx, -2],
    [rx, -13], [meia, yBorda * 0.62 - 12], [0, ry - 11], [-meia, yBorda * 0.62 - 12], [-rx, -13]]);
  // Barro ao sol: duas manchas altas, uma de cada lado do vão, e é o que tira a parede do plano.
  p.poly(3, [[-rx * 0.82, -h * 0.62], [-rx * 0.42, -h * 0.78], [-rx * 0.36, -h * 0.34],
    [-rx * 0.74, -h * 0.24]]);
  p.poly(3, [[rx * 0.82, -h * 0.62], [rx * 0.42, -h * 0.78], [rx * 0.36, -h * 0.34],
    [rx * 0.74, -h * 0.24]]);
  if (away) {
    // De costas não há porta: há dois couros estendidos sobre a parede, um de cada lado da
    // quina. É o que faz o lugar ter duas faces em vez de ser um carimbo virado para a câmera — e
    // são dois e não um largo porque um único painel escuro no meio da parede foi lido, na folha
    // impressa, como uma boca aberta.
    const couro = (s: number) => p.poly(4, [[s * rx * 0.66, -h * 0.88], [s * rx * 0.2, -h * 0.94],
      [s * rx * 0.24, -h * 0.44], [s * rx * 0.7, -h * 0.52]]);
    couro(-1);
    couro(1);
    // A vara onde os dois estão pendurados: sem ela o couro flutua na parede, e por isso ela fica
    // um dedo ACIMA da boca dos dois — passando pelo meio deles, a linha virava boca e os dois
    // couros viravam olhos, que é a última coisa que uma parede de trás precisa parecer.
    p.poly(7, [[-rx * 0.74, -h * 0.98], [rx * 0.74, -h * 0.98], [rx * 0.74, -h * 0.92],
      [-rx * 0.74, -h * 0.92]]);
    return;
  }
  p.poly(4, [[-larguraDaPorta / 2, -alturaDaPorta], [0, -alturaDaPorta - 6],
    [larguraDaPorta / 2, -alturaDaPorta], [larguraDaPorta / 2, yBorda], [0, ry + 1],
    [-larguraDaPorta / 2, yBorda]]);
}

/**
 * O beiral: a aba do telhado que sobra para fora da parede. É um disco inteiro em tinta 4 e é
 * isso que faz o forro escuro aparecer: o cone vem depois, por cima, e só a calota de baixo do
 * disco sobra — que é exatamente a sombra que uma aba projecta sobre a parede.
 */
function beiral(p: ReturnType<typeof pintor>, rx: number, ry: number, y: number): void {
  elipse(p, 0, 0, y, rx + 3, ry + 2);
  elipse(p, 4, 0, y, rx, ry);
}

/** O cone de colmo: silhueta, corpo, o caimento da palha em duas faixas e a corda. */
function telhadoCônico(p: ReturnType<typeof pintor>, ápice: number, baseY: number,
  brimRx: number, brimRy: number): void {
  const cone = (rx: number, ry: number, topo: number, tinta: number) => p.poly(tinta,
    [[0, topo], [rx, baseY], ...frente(0, baseY, rx, ry), [-rx, baseY]]);
  cone(brimRx + 3, brimRy + 2, ápice - 3, 0);
  cone(brimRx, brimRy, ápice, 5);
  // O caimento: duas faixas escuras correndo do alto ao beiral, simétricas — é o que dá ao
  // telhado espessura de palha em vez de chapéu de papel.
  p.poly(6, [[-5, ápice + 12], [5, ápice + 12], [brimRx * 0.44, baseY - 3], [brimRx * 0.2, baseY - 3]]);
  p.poly(6, [[-5, ápice + 12], [5, ápice + 12], [-brimRx * 0.44, baseY - 3], [-brimRx * 0.2, baseY - 3]]);
  // A aresta iluminada do cone, do alto ao meio do caimento.
  p.poly(7, [[0, ápice + 3], [brimRx * 0.26, baseY * 0.45 + ápice * 0.55], [0, baseY * 0.75 + ápice * 0.25],
    [-brimRx * 0.26, baseY * 0.45 + ápice * 0.55]]);
  // A corda que amarra o colmo no terço de baixo: um anel fino, e é o traço que diz que aquilo foi
  // feito por mãos.
  const yc = baseY + (ápice - baseY) * 0.32;
  p.poly(7, [[-brimRx * 0.52, yc], [brimRx * 0.52, yc], [brimRx * 0.44, yc + 5],
    [-brimRx * 0.44, yc + 5]]);
}

/**
 * Prisma de base quadrada em `cy`: o quadrado de mundo projetado é o losango de semidiagonais
 * `rx`/`ry`, e as duas faces que a câmera vê são as que descem da quina do meio. As tintas 1, 2 e
 * 3 são espelhadas por construção — as duas faces recebem a mesma massa e a quina é uma linha só —
 * porque um losango espelhado no eixo X de tela é o mesmo quadrado girado de 90° no mundo, e uma
 * casa cuja face esquerda fosse mais clara que a direita trocaria de sol quando virasse.
 *
 * É por isso também que a porta fica no meio da face da direita: espelhada, ela cai exatamente no
 * meio da face da esquerda, que é o mesmo portão visto do outro lado da casa.
 */
function prisma(p: ReturnType<typeof pintor>, rx: number, ry: number, h: number, cy: number,
  away: boolean): void {
  const { poly, rect } = p;
  const topo = cy - h;
  poly(0, [[-rx - 2, cy], [0, cy + ry + 2], [rx + 2, cy], [rx + 2, topo - 2], [0, topo - ry - 2],
    [-rx - 2, topo - 2]]);
  poly(1, [[-rx, cy], [0, cy + ry], [rx, cy], [rx, topo], [0, topo - ry], [-rx, topo]]);
  // A quina do meio: a única linha que separa as duas faces, e por isso ela é escura e vertical.
  poly(2, [[-2, cy + ry - 1], [2, cy + ry - 1], [2, topo - ry + 1], [-2, topo - ry + 1]]);
  // A faixa ao sol, colada na boca do telhado, corrida pelas duas faces de uma vez.
  poly(3, [[-rx, topo], [0, topo - ry], [rx, topo], [rx, topo + 8], [0, topo - ry + 8],
    [-rx, topo + 8]]);
  // Tábuas: seis verticais, três por face, cada uma presa entre a borda de cima e a de baixo da
  // sua face — as duas linhas do prisma, não um retângulo que vaza pelo beiral.
  const meio = h + ry;
  for (const x of [-0.75, -0.4, 0.4, 0.75]) {
    const px = Math.round(x * rx);
    const yTopo = topo - ry / 2 + Math.abs(px) / 2 - rx / 2;
    const yBase = cy + ry - Math.abs(px) / (rx / ry);
    rect(6, px - 1, yTopo, 2, Math.max(2, yBase - yTopo));
  }
  if (away) {
    // De costas, o que a casa pendura na face é um couro esticado entre duas travessas.
    poly(4, [[rx * 0.2, topo + 6], [rx * 0.8, topo + 3], [rx * 0.8, topo + meio * 0.5],
      [rx * 0.2, topo + meio * 0.55]]);
    return;
  }
  poly(4, [[rx * 0.24, topo + 8], [rx * 0.76, topo + 5], [rx * 0.76, cy + ry - 12],
    [rx * 0.24, cy + ry - 5]]);
  // Soleira: a tábua posta no chão à frente do portão, onde a terra pisada é mais apertada.
  poly(7, [[rx * 0.18, cy + ry - 4], [rx * 0.82, cy + ry - 8], [rx * 0.86, cy + ry - 2],
    [rx * 0.14, cy + ry + 2]]);
}

/**
 * Cobertura de pirâmide: quatro águas caindo de um ápice sobre o losando do beiral. Diferença do
 * cone: as arestas são retas e as duas faces visíveis têm o mesmo tom, com o caimento da palha em
 * leque — é o que faz a casa quadrada ler como quadrada a dez tiles, antes de qualquer detalhe.
 */
function telhadoPiramidal(p: ReturnType<typeof pintor>, rx: number, ry: number, baseY: number,
  ápice: number, away: boolean): void {
  const { poly } = p;
  poly(0, [[0, ápice - 3], [rx + 3, baseY], [0, baseY + ry + 2], [-rx - 3, baseY]]);
  poly(0, [[0, ápice - 3], [rx + 3, baseY], [0, baseY - ry - 2], [-rx - 3, baseY]]);
  poly(5, [[0, ápice], [rx, baseY], [0, baseY + ry], [-rx, baseY]]);
  // O caimento: um leque de seis varas descendo do ápice ao beiral, simétrico.
  for (const f of [-0.8, -0.45, -0.15, 0.15, 0.45, 0.8]) {
    poly(6, [[0, ápice + 6], [rx * f, baseY], [rx * (f + 0.08), baseY], [3, ápice + 6]]);
  }
  // Ao sol: a calota em volta do ápice, que é onde o dossel aberto pega.
  poly(7, [[0, ápice + 2], [rx * 0.34, baseY * 0.5 + ápice * 0.5], [0, baseY * 0.66 + ápice * 0.34],
    [-rx * 0.34, baseY * 0.5 + ápice * 0.5]]);
  if (!away) {
    // As duas águas da frente se encontram na aresta do meio: sem ela a pirâmide é um chapéu.
    poly(7, [[0, ápice + 2], [2, baseY + ry * 0.6], [0, baseY + ry], [-2, baseY + ry * 0.6]]);
  }
}

/**
 * Planta 0 — a casa redonda de telhado cônico. O corpo ocupa todo o círculo do pino, que é o
 * formato mais barato de acertar contra a colisão: a parede que se vê é a parede que barra.
 */
function cabanaRedonda(away: boolean): Frame {
  const p = pintor();
  corpo(p, 46, 23, 56, 24, 46, away);
  beiral(p, 52, 26, -54);
  telhadoCônico(p, -114, -54, 52, 26);
  return p.paths;
}

/**
 * Planta 1 — a casa grande do lugar. Base quadrada, parede de tábua e quatro águas, com o
 * beiral indo buscar o círculo do pino que a parede não alcança: o quadrado inscrita no círculo
 * tem as quinas no raio e as bordas a 0,71 dele, e é o beiral que fecha a conta.
 */
function cabanaQuadrada(away: boolean): Frame {
  const p = pintor();
  // A base quadrada encosta as quinas no círculo do pino: o losando de semidiagonal 44 (+2 de
  // contorno) é o pé de 92 px que `PÉ.cabana` declara, e é por isso que a parede pode ser quadrada
  // sem que o colisor precise ser outro número.
  prisma(p, 44, 22, 54, 0, away);
  beiral(p, 52, 26, -52);
  telhadoPiramidal(p, 52, 26, -54, -118, away);
  // O pináculo: duas varas cruzadas no alto, com uma pluma. É o mastro da casa grande, e sem ele a
  // planta 1 era só a planta 0 desenhada com régua.
  tábua(p, -2, -134, 4, 26, 1, 3);
  tábua(p, -14, -124, 28, 4, 1, 3);
  p.poly(7, [[-10, -122], [10, -122], [6, -112], [-6, -112]]);
  return p.paths;
}

/**
 * Planta 2 — o celeiro sobre estacas. A silhueta é alta e vazia por baixo: quatro postes, o piso
 * de grão e uma casa pequena em cima. É a forma que faz o jogador trocar de leitura dentro do
 * acampamento — aqui se guarda o que se comeu — e o espelho não muda nada, porque as estacas, o
 * losando do piso e a escada do meio são todos pares.
 */
function celeiroEmpalado(away: boolean): Frame {
  const p = pintor();
  const { poly, rect } = p;
  // As estacas do fundo, mais curtas porque somem atrás do piso; depois o piso; depois as da
  // frente, que descem até o pé do pino. A ordem das tintas faz o assoalho cobrir o toco.
  tábua(p, -30, -56, 6, 26, 1, 3);
  tábua(p, 24, -56, 6, 26, 1, 3);
  poly(0, [[-50, -56], [0, -35], [50, -56], [50, -70], [0, -49], [-50, -70]]);
  poly(1, [[-47, -56], [0, -38], [47, -56], [47, -67], [0, -49], [-47, -67]]);
  poly(3, [[-47, -67], [0, -49], [47, -67], [0, -58]]);
  // As duas da frente caem exatamente na meia-largura do pino (44 + 2 de contorno = 46 = PÉ/2):
  // um corpo suspenso sobre quatro paus mais estreitos que o círculo que o barra seria o jogador
  // batendo no ar a um palmo do celeiro.
  tábua(p, -44, -58, 7, 58, 1, 3);
  tábua(p, 37, -58, 7, 58, 1, 3);
  // A travessa que amarra as quatro, e o esteio diagonal: sem eles o celeiro é um desenho colado
  // em quatro paus, e com eles é construção.
  rect(0, -44, -28, 88, 7);
  rect(3, -43, -27, 86, 5);
  poly(1, [[-41, -24], [-37, -24], [37, -56], [41, -56]]);
  // A casa de grão em cima do piso: o mesmo prisma da casa grande, na metade do tamanho. Ela
  // ocupa quase a plataforma inteira porque um celeiro com um cubo pequeno no meio de um tabuleiro
  // largo é uma mesa — e foi exatamente assim que a folha impressa leu esta planta antes.
  prisma(p, 30, 15, 30, -52, away);
  beiral(p, 40, 20, -80);
  telhadoPiramidal(p, 40, 20, -82, -134, away);
  if (!away) {
    // A escada de mão encostada na beira esquerda da plataforma: quatro travessas e dois
    // montantes. É o que diz que aquele celeiro se usa, e não que ele é um enfeite. Ela não fica no
    // meio porque a casa de grão, que é larga quase como o piso, engoliria os dois degraus de baixo
    // — e uma escada que só tem metade visível é um detalhe pintado sobre outro detalhe.
    for (const [y, w] of [[-8, 18], [-20, 16], [-32, 14], [-44, 12]] as const) {
      tábua(p, -34 - w / 2, y - 3, w, 4, 1, 3);
    }
    rect(0, -38, -50, 4, 52);
    rect(0, -31, -50, 4, 52);
    rect(3, -37, -49, 2, 50);
    rect(3, -30, -49, 2, 50);
  }
  return p.paths;
}

/** As três plantas que o `Tribo` sorteia, cada uma com a sua vista de porta. */
export function quadroDaCabana(planta: number, away: boolean): Frame {
  if (planta === 1) return cabanaQuadrada(away);
  if (planta === 2) return celeiroEmpalado(away);
  return cabanaRedonda(away);
}

/**
 * O totem da boca do acampamento. É um poste entalhado, e a única coisa dele que muda conforme o
 * lado em que se está é a cara: voltado para quem chega, ele tem olhos e boca; de costas, é só o
 * entalhe. O `virada` quem decide é o `rumo` publicado pela geometria, e não uma comparação de
 * coordenada no render — é por isso que o poste aponta de volta para a cidade até num canto do
 * mundo, onde nenhuma das quatro faces diz a direção certa.
 */
export function quadroDoTotem(virada: boolean): Frame {
  const p = pintor();
  const { poly, rect } = p;
  // A base de pedras postas: o pé do poste tem de ter lastro, senão flutua como um lápis.
  elipse(p, 0, 0, 0, 16, 8);
  poly(2, arco(0, -2, 14, 7, 0, Math.PI * 2, 8));
  poly(4, [[-14, -4], [-5, -8], [4, -5], [14, -6], [12, -12], [0, -14], [-12, -11]]);
  // O tronco, de baixo para cima: a casca escura, o corpo e a face que a luz do claro pega.
  tábua(p, -12, -128, 24, 118, 1, 3);
  // Três caras empilhadas, cada uma mais estreita — é a escada que faz o poste ler como entalhado
  // por alguém com ferramenta e tempo, não como um pau na vertical.
  for (const [i, y] of [-32, -70, -108].entries()) {
    const largura = 13 - i * 2;
    poly(0, [[-largura - 2, y], [largura + 2, y], [largura + 2, y - 30], [-largura - 2, y - 30]]);
    poly(2, [[-largura, y], [largura, y], [largura, y - 28], [-largura, y - 28]]);
    poly(3, [[-largura, y - 4], [-largura + 5, y - 4], [-largura + 5, y - 24], [-largura, y - 24]]);
    // A ocre na testa de cada nível: a única cor quente do poste, e por isso é a que se lembra.
    rect(5, -largura + 2, y - 12, largura * 2 - 4, 4);
    if (virada) {
      rect(4, -largura + 3, y - 21, 5, 5);
      rect(4, largura - 8, y - 21, 5, 5);
      rect(6, -largura + 4, y - 20, 3, 3);
      rect(6, largura - 7, y - 20, 3, 3);
      rect(7, -largura + 5, y - 20, 2, 2);
      rect(7, largura - 6, y - 20, 2, 2);
      poly(4, [[-5, y - 9], [5, y - 9], [4, y - 4], [-4, y - 4]]);
    } else {
      poly(4, [[-largura + 3, y - 20], [largura - 3, y - 20], [largura - 5, y - 6],
        [-largura + 5, y - 6]]);
    }
    // Os braços que saem de cada nível, na altura do meio: sem eles o poste é uma ripa.
    poly(0, [[-largura - 12, y - 20], [-largura - 1, y - 20], [-largura - 1, y - 8],
      [-largura - 12, y - 12]]);
    poly(0, [[largura + 12, y - 20], [largura + 1, y - 20], [largura + 1, y - 8],
      [largura + 12, y - 12]]);
    poly(1, [[-largura - 10, y - 19], [-largura - 2, y - 19], [-largura - 2, y - 10],
      [-largura - 10, y - 13]]);
    poly(1, [[largura + 10, y - 19], [largura + 2, y - 19], [largura + 2, y - 10],
      [largura + 10, y - 13]]);
  }
  // A crista: duas penas no topo, a única parte do lugar que se recorta contra o céu.
  poly(0, [[-16, -152], [-2, -130], [-8, -128], [-20, -148]]);
  poly(0, [[16, -152], [2, -130], [8, -128], [20, -148]]);
  poly(6, [[-14, -149], [-4, -132], [-8, -130], [-17, -146]]);
  poly(6, [[14, -149], [4, -132], [8, -130], [17, -146]]);
  return p.paths;
}

/**
 * O poste do cativeiro: um pau de amarrar gente fincado no fundo da clareira, com travessa. É a
 * única forma do lugar desenhada para *segurar* alguém, e isso decide o desenho: baixo (um homem de
 * pé precisa ficar preso na altura do pulso, não do telhado), com travessa (sem ela a corda escorrega
 * para o chão e o poste é uma estaca), e com pedra de lastro (o mesmo pé do totem, porque um poste
 * fincado na terra solta com dois puxões).
 *
 * `virada` mostra a corda do último prisioneiro — dois turnos no nó, a única cor clara do poste, e o
 * detalhe que diz "aqui se amarra" a dez tiles. De costas a travessa é só o sulco escuro, e é isso
 * que faz as duas vistas serem duas telas e não uma.
 */
export function quadroDoPoste(virada: boolean): Frame {
  const p = pintor();
  const { poly, rect } = p;
  // O pé de pedra: a silhueta no chão é a elipse do pino, e ela é o que a escala mede.
  elipse(p, 0, 0, 0, 11, 5.5);
  elipse(p, 5, 0, -2, 9, 4.5);
  poly(1, [[-9, -3], [-3, -7], [4, -5], [9, -7], [7, -11], [-1, -12], [-7, -9]]);
  // O corpo do poste: contorno, madeira e a face que pega o sol do meio-dia.
  tábua(p, -4, -58, 8, 54, 2, 3);
  // A travessa, mais larga que o pau: é nela que a corda morde, e sem ela o poste é uma estaca.
  rect(0, -12, -58, 24, 8);
  rect(2, -11, -57, 22, 6);
  rect(3, -10, -56, 20, 2);
  // A cabeça lascada: o topo não é um corte reto, é um golpe de machado, e é o que separa um poste
  // de uma ripa comprada.
  poly(0, [[-6, -60], [6, -60], [4, -70], [-1, -74], [-6, -68]]);
  poly(2, [[-4, -61], [4, -61], [2, -68], [-1, -71], [-4, -66]]);
  poly(3, [[-2, -62], [1, -62], [0, -68], [-2, -66]]);
  if (virada) {
    // Os dois turnos de corda no nó, e a ponta pendurada: tinta 6 e 7 são as duas mais claras da
    // paleta, então a corda lê corda e não ripa em cima do escuro da madeira.
    rect(6, -7, -52, 14, 3);
    rect(6, -7, -47, 14, 3);
    rect(7, -6, -51, 12, 1);
    poly(6, [[5, -47], [9, -47], [11, -36], [7, -36]]);
    poly(7, [[6, -46], [8, -46], [10, -37], [8, -37]]);
  } else {
    // De costas só o sulco onde a corda morderia: a aldeia vista de fora não mostra corda nenhuma.
    rect(4, -10, -55, 20, 3);
  }
  return p.paths;
}

/**
 * A fogueira nos três quadros do caimento da chama. O fogo não é uma mancha: são pedras postas em
 * anel, lenha cruzada dentro delas e a língua que sobe. O `frame` vem do relógio do jogo no
 * componente, então a aldeia pisca mesmo quando ninguém se mexe, e é isso que faz o acampamento
 * parecer ocupado antes de aparecer um guerreiro.
 */
export function quadroDaFogueira(frame: number): Frame {
  const p = pintor();
  const { poly, rect } = p;
  // O anel de pedras: oito tocos no pé do pino, cada um com a face de cima ao sol.
  for (let i = 0; i < 8; i++) {
    const θ = (i / 8) * Math.PI * 2;
    const x = Math.cos(θ) * 34;
    const y = Math.sin(θ) * 17;
    poly(0, [[x - 8, y - 8], [x + 8, y - 8], [x + 9, y + 2], [x - 9, y + 2]]);
    poly(2, [[x - 6, y - 6], [x + 6, y - 6], [x + 7, y], [x - 7, y]]);
    poly(4, [[x - 6, y - 6], [x + 6, y - 6], [x + 4, y - 3], [x - 4, y - 3]]);
  }
  // A cinza e a brasa por dentro do anel.
  elipse(p, 1, 0, -2, 26, 13);
  elipse(p, 5, 0, -3, 18, 9);
  // A lenha: três paus cruzados, sempre os mesmos. O que muda de quadro é o fogo, não o que
  // queima — é a diferença entre uma fogueira acesa e um desenho tremendo.
  for (const [dx, dy] of [[-24, -4], [18, 2], [-6, -14]] as const) {
    poly(0, [[dx - 12, dy], [dx + 12, dy - 6], [dx + 13, dy - 1], [dx - 11, dy + 5]]);
    poly(1, [[dx - 10, dy], [dx + 10, dy - 5], [dx + 11, dy], [dx - 9, dy + 4]]);
    rect(3, dx - 6, dy - 3, 10, 3);
  }
  const alturas = [[46, 26], [58, 34], [50, 22]][frame % 3];
  const língua = (largura: number, altura: number, tinta: number, deslocamento: number) => {
    poly(tinta, [[-largura, -12], [-largura * 0.6, -12 - altura * 0.55],
      [deslocamento, -12 - altura], [largura * 0.6, -12 - altura * 0.55], [largura, -12]]);
  };
  língua(17, alturas[0], 5, frame === 1 ? 4 : -3);
  língua(12, alturas[1], 6, frame === 1 ? -3 : 4);
  rect(7, -4, -12 - alturas[1] * 0.72, 8, alturas[1] * 0.5);
  // A brasa que levanta: três pontos fora do anel, na altura do caimento da língua.
  for (const [x, y] of [[-20, -52], [14, -64], [4, -44]] as const) {
    rect(7, x + (frame - 1) * 3, y - frame * 2, 3, 3);
  }
  return p.paths;
}

/**
 * Um caminho de elipse fora de um quadro. Retângulo no chão é o erro que a fase do relevo passou
 * apagando: a sombra de uma casa redonda tem de ser a projeção de um círculo do mundo, com o
 * dobro de largura que de altura, ou o acampamento inteiro parece colado sobre caixas.
 */
function elipseSolta(cx: number, cy: number, rx: number, ry: number): SkPath {
  const s = Skia.Path.Make();
  const pts = arco(cx, cy, rx, ry, 0, Math.PI * 2, 10);
  pts.forEach(([x, y], i) => (i === 0 ? s.moveTo(x, y) : s.lineTo(x, y)));
  s.close();
  return s;
}

/** O halo morno no chão pisado: largo como duas cabanas, pintado antes das pedras. */
export function brilhoDaFogueira(): SkPath {
  const brilho = elipseSolta(0, -2, 52, 26);
  // A segunda calota, menor e por cima da mesma tinta: o halo tem de ter centro mais quente que
  // borda, e sem tinta de luz a única forma de dizer isso é uma elipse dentro da outra.
  const maisPerto = elipseSolta(0, -3, 30, 15);
  brilho.addPath(maisPerto);
  return brilho;
}

/** A sombra de contato de um corpo do acampamento: larga como o pé, nunca um ponto nem uma caixa. */
function sombra(rx: number, ry: number): SkPath {
  const s = elipseSolta(2, ry * 0.2, rx, ry);
  s.addPath(elipseSolta(1, ry * 0.1, rx * 0.72, ry * 0.72));
  return s;
}

/** Os três formatos de osso que a clareira espalha. */
export function quadroDoOsso(variação: number): Frame {
  const p = pintor();
  const { poly, rect } = p;
  if (variação === 1) {
    // Caveira deitada na direção da câmera: o crânio, as duas órbitas e os dentes. É o osso que
    // diz o que se comeu aqui, e por isso ele é o maior dos três.
    poly(0, [[-17, -10], [17, -10], [19, 4], [8, 12], [-8, 12], [-19, 4]]);
    poly(2, [[-15, -8], [15, -8], [17, 3], [7, 10], [-7, 10], [-17, 3]]);
    poly(3, [[-14, -7], [-1, -7], [-1, 1], [-14, 1]]);
    rect(1, -11, -4, 8, 7);
    rect(1, 3, -4, 8, 7);
    rect(7, 4, -7, 7, 5);
    poly(2, [[-8, 11], [8, 11], [6, 15], [-6, 15]]);
    for (const x of [-6, -2, 2, 6]) rect(3, x - 1, 11, 2, 4);
    return p.paths;
  }
  if (variação === 2) {
    // Costela enterrada na terra pisada: cinco arcos saindo de uma coluna. É o resto do prato.
    rect(0, -20, -8, 40, 8);
    rect(2, -18, -6, 36, 5);
    for (let i = 0; i < 5; i++) {
      const x = -17 + i * 8;
      poly(0, [[x, -6], [x + 4, -6], [x + 8, 8], [x + 3, 9]]);
      poly(2, [[x + 1, -5], [x + 4, -5], [x + 7, 7], [x + 4, 7]]);
    }
    return p.paths;
  }
  // Dois ossos compridos quebrados, um sobre o outro, cada um com a cabeça redonda nas pontas. É o
  // resto do prato visto de cima, e a haste tem de ter corpo: um fio de dois pixels desaparece na
  // terra pisada e a clareira vira sujeira de desenho em vez de lugar onde se comeu.
  const ossoLongo = (desvio: number) => {
    const y = (v: number) => v + desvio;
    poly(0, [[-26, y(6)], [-20, y(-4)], [18, y(-15)], [27, y(-9)], [22, y(1)], [-16, y(12)]]);
    poly(1, [[-24, y(6)], [-19, y(-3)], [17, y(-13)], [24, y(-8)], [20, y(0)], [-15, y(10)]]);
    poly(2, [[-22, y(5)], [-18, y(-2)], [15, y(-11)], [21, y(-7)], [18, y(-1)], [-14, y(8)]]);
    // A cabeça do osso: o botão que fecha a haste nas duas pontas, e é o traço que diz que aquilo
    // foi partido por alguém e não caiu redondo do céu.
    elipse(p, 1, -25, y(8), 8, 6);
    elipse(p, 2, -25, y(7), 6, 4);
    elipse(p, 1, 24, y(-5), 7, 6);
    elipse(p, 2, 24, y(-6), 5, 4);
    // O sol na haste: uma lasca clara correndo o comprimento, do meio para a ponta gorda.
    poly(3, [[-14, y(2)], [12, y(-8)], [17, y(-6)], [-10, y(5)]]);
  };
  ossoLongo(0);
  ossoLongo(-11);
  return p.paths;
}

interface Arte {
  cabana: Frame[];
  totem: Frame[];
  fogueira: Frame[];
  osso: Frame[];
  poste: Frame[];
  sombra: Record<TriboTipo, SkPath>;
  brilho: SkPath;
}
let cache: Arte | null = null;

/**
 * Dois quadros de porta por planta, duas vistas do totem, três da chama, três do osso, duas do
 * poste. Montado uma vez e nunca mais: os `SkPath` são objetos nativos e recriá-los por nó seria
 * pagar o preço do vazamento que o jogo passou três fases para fechar.
 */
function getArte(): Arte {
  if (cache) return cache;
  const cabana = [0, 1, 2].flatMap((planta) => [quadroDaCabana(planta, false), quadroDaCabana(planta, true)]);
  const osso = [0, 1, 2].map((v) => quadroDoOsso(v));
  return (cache = {
    cabana,
    totem: [quadroDoTotem(true), quadroDoTotem(false)],
    fogueira: [0, 1, 2].map(quadroDaFogueira),
    osso,
    poste: [quadroDoPoste(true), quadroDoPoste(false)],
    sombra: {
      cabana: sombra(46, 23),
      totem: sombra(16, 8),
      fogueira: sombra(36, 18),
      osso: sombra(24, 11),
      poste: sombra(11, 5.5),
    },
    brilho: brilhoDaFogueira(),
  });
}

/**
 * Uma tinta de um quadro. `índice` é um `SharedValue` só para a fogueira, que troca de língua com o
 * relógio; todo corpo parado chega com a lista tendo um quadro, então `% frames.length` fica em
 * zero e o único caminho que acorda a cada quadro é o do fogo.
 */
function Camada({ frames, tinta, cor, índice }: {
  frames: Frame[]; tinta: number; cor: string; índice?: SharedValue<number>;
}) {
  const path = useDerivedValue(() => frames[(índice ? índice.value : 0) % frames.length][tinta],
    [frames, tinta, índice]);
  return <Path path={path} color={cor} antiAlias={false} />;
}

function Corpo({ node, frames, paleta, índice }: {
  node: TriboNode; frames: Frame[]; paleta: readonly string[]; índice?: SharedValue<number>;
}) {
  const arte = useMemo(getArte, []);
  // Espelho e escala no mesmo par de eixos: uma única forma de lista de transformar, sem cast e
  // sem `scaleX` depois de `scale`, que é a ordem que compõe o espelho em torno do pé do quadro e
  // não em torno da margem da tela.
  const tela = useMemo(() => [
    { translateX: node.sx }, { translateY: node.sy },
    { scaleX: node.escala * (node.espelha ? -1 : 1) }, { scaleY: node.escala },
  ], [node.sx, node.sy, node.escala, node.espelha]);
  return (
    <Group transform={tela} antiAlias={false}>
      <Path path={arte.sombra[node.tipo]} color="#20261f" opacity={0.26} />
      {node.tipo === 'fogueira' && (
        <Path path={arte.brilho} color="#c9762c" opacity={0.2} antiAlias={false} />
      )}
      {paleta.map((cor, tinta) => (
        <Camada key={tinta} frames={frames} tinta={tinta} cor={cor} índice={índice} />
      ))}
    </Group>
  );
}

/**
 * O corpo de um acampamento. `node` é a única entrada: posição de tela, escala vinda do pino,
 * planta, porta e espelho já decididos pela geometria em `TriboStatics`, que lê `Tribo`. Não há
 * estado aqui, e é por isso que o `<Group>` pode ser um desenho puro: a aldeia não muda quando o
 * jogador chega, ela só entra na janela da neblina.
 *
 * `memo` pela identidade do nó, a mesma regra do `StaticSprite`: a passada de descarte roda a 8 Hz
 * sobre o cache residente e re-renderizar a aldeia inteira a cada varredura seria pagar por um
 * cenário que não se mexe.
 */
export const TriboSprite = memo(function TriboSprite({ node, clock }: {
  node: TriboNode; clock: SharedValue<number>;
}) {
  const arte = useMemo(getArte, []);
  const língua = useDerivedValue(
    () => Math.floor(clock.value * 7.3) % arte.fogueira.length, [clock]);
  if (node.tipo === 'fogueira') {
    return <Corpo node={node} frames={arte.fogueira} paleta={PALETAS.fogueira} índice={língua} />;
  }
  if (node.tipo === 'cabana') {
    return <Corpo node={node} frames={[arte.cabana[node.planta * 2 + (node.away ? 1 : 0)]]}
      paleta={PALETAS.cabana} />;
  }
  if (node.tipo === 'totem') {
    return <Corpo node={node} frames={[arte.totem[node.away ? 1 : 0]]} paleta={PALETAS.totem} />;
  }
  if (node.tipo === 'poste') {
    return <Corpo node={node} frames={[arte.poste[node.away ? 1 : 0]]} paleta={PALETAS.poste} />;
  }
  return <Corpo node={node} frames={[arte.osso[node.planta % arte.osso.length]]}
    paleta={PALETAS.osso} />;
});

/**
 * A caixa de tela de um nó, já na escala dele. É o retângulo que a neblina corta, e ele mora aqui
 * porque é a arte que sabe o próprio tamanho: se o telhado crescer, o recorte cresce junto, e o
 * punho do gigante não é o único gesto que pode sair voando fora de um recorte justo ao tronco.
 */
export function caixaDoNodo(n: TriboNode): { x: number; y: number; width: number; height: number } {
  const [meia, topo, base] = CAIXA[n.tipo];
  const s = n.escala;
  return { x: n.sx - meia * s, y: n.sy - topo * s, width: meia * 2 * s, height: (topo + base) * s };
}
