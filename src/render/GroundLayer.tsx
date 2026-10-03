import { useEffect, useRef, useState, memo } from 'react';
import {
  BlendMode, ClipOp, Picture, Skia, VertexMode,
  type SkCanvas, type SkColor, type SkImage, type SkMatrix, type SkPaint, type SkPath, type SkPicture,
} from '@shopify/react-native-skia';
import { tileKey } from '../assets/AssetRegistry';
import { spriteStore } from '../assets/SpriteStore';
import { ELEVATION_PX, worldToScreen } from '../world/IsoUtils';
import { FOG } from '../systems/FogSystem';
import { GAME_CONFIG } from '../game/GameConfig';
import { vertexHeight } from '../world/Map';
import type { GameState } from '../game/GameState';
import type { CityMapData } from '../data/maps/city';
import { drawRoad } from './RoadPainter';
// O `liberarWeb` e o `devolverNoTempoDoDesenho` moram em `SkiaLifetime` porque o chunk de
// estática do mundo passou a devolver caminhos de sombra pelo mesmo motivo: dois donos para
// um ciclo de vida é como se nasce um uso-after-free.
import { devolverNoTempoDoDesenho, liberarWeb } from './SkiaLifetime';

function cameraCellKey(game: GameState): string {
  const cx = Math.round(game.camera.x * 2);
  const cy = Math.round(game.camera.y * 2);
  // A neve cresce com o jogador parado olhando a nevasca cair: sem o nível quantizado no
  // teto, o chão só acordaria branco quando a câmera andasse meio tile.
  return `${cx},${cy},${game.camera.zoom},${Math.round(game.viewW)},${Math.round(game.viewH)},${game.snow.nivel}`;
}

/**
 * Malha, não pilha: a altura de um canto de losango é a média dos tiles que encostam
 * naquele vértice, então a borda que um tile desenha é exatamente a borda que o vizinho
 * desenha. É isso que fecha o relevo como superfície contínua — sem emenda, sem parede,
 * sem o degrau de bloco que a cota por tile sozinha sempre mostra. A função mora em
 * `world/Map`, porque é a mesma cota que `heightSmoothAt` interpola sob os pés de quem
 * anda aqui: duas leituras do relevo, um só relevo.
 *
 * O terreno entorta o sprite do chão em vez de empilhar um bloco em cima dele: X nunca
 * se move (é o que mantém a projeção isométrica 2:1), só Y cisalha e comprime conforme o
 * declive. O losango encolhe na vertical tanto quanto o tile sobe na diagonal — encosta
 * forte o achata, que é como um mapa de relevo mostra pendão.
 *
 * Mas um losango inteiro não cabe numa matriz afim: com quatro cantos de cotas diferentes
 * ele não é mais um paralelogramo, e a matriz que casa três cantos estoura o quarto — é
 * justamente aí que a emenda abre, e o morro vira grade. Então o tile é desenhado como
 * dois triângulos, cada um com a matriz dos três cantos dele e a máscara do próprio
 * triângulo. Vértice compartilhado, borda compartilhada: a malha fecha continua.
 *
 * A máscara é sempre a mesma, no espaço da imagem, e por isso vive fora do laço: o que
 * muda de um tile para o outro é só a matriz. Nela entra o 2% de folga em volta do
 * losango, para a ponta de um vizinho cobrir a do outro em vez de deixar fio de fundo.
 */
const TILE_OVER = 1.006;
const CANTO = [
  { x: 64, y: 0 },
  { x: 128, y: 32 },
  { x: 64, y: 64 },
  { x: 0, y: 32 },
];
let tris: [SkPath, SkPath] | null = null;

function faceDaImagem(i: number, j: number, k: number) {
  const p = Skia.Path.Make();
  for (const n of [i, j, k]) {
    const x = 64 + (CANTO[n].x - 64) * TILE_OVER;
    const y = 32 + (CANTO[n].y - 32) * TILE_OVER;
    if (n === i) p.moveTo(x, y);
    else p.lineTo(x, y);
  }
  p.close();
  return p;
}

/** Matriz afim que leva os três pontos da imagem exatamente aos três cantos do tile. */
function matrizDeApara(p1: { x: number; y: number }, p2: { x: number; y: number }, p3: { x: number; y: number },
  q1: { x: number; y: number }, q2: { x: number; y: number }, q3: { x: number; y: number }): SkMatrix {
  const ux = p2.x - p1.x, uy = p2.y - p1.y;
  const vx = p3.x - p1.x, vy = p3.y - p1.y;
  const sx = q2.x - q1.x, sy = q2.y - q1.y;
  const tx = q3.x - q1.x, ty = q3.y - q1.y;
  const det = ux * vy - vx * uy;
  const a = (sx * vy - tx * uy) / det;
  const b = (tx * ux - sx * vx) / det;
  const c = (sy * vy - ty * uy) / det;
  const d = (ty * ux - sy * vx) / det;
  return Skia.Matrix([a, b, q1.x - (a * p1.x + b * p1.y), c, d, q1.y - (c * p1.x + d * p1.y), 0, 0, 1]);
}

function drawTiltedTile(canvas: SkCanvas, img: SkImage,
  A: { x: number; y: number }, B: { x: number; y: number },
  C: { x: number; y: number }, D: { x: number; y: number }) {
  const [t1, t2] = tris ??= [faceDaImagem(0, 1, 2), faceDaImagem(0, 2, 3)];
  canvas.save();
  canvas.concat(matrizDeApara(CANTO[0], CANTO[1], CANTO[2], A, B, C));
  canvas.clipPath(t1, ClipOp.Intersect, false);
  canvas.drawImage(img, 0, 0);
  canvas.restore();
  canvas.save();
  canvas.concat(matrizDeApara(CANTO[0], CANTO[2], CANTO[3], A, C, D));
  canvas.clipPath(t2, ClipOp.Intersect, false);
  canvas.drawImage(img, 0, 0);
  canvas.restore();
}

/**
 * Tinta do chão: malha de triângulos com cor em cada vértice, não losango chapado por
 * tile. Dois escuros diferentes moram nela, e é justamente a confusão entre os dois que
 * fazia o morro parecer um telão de sombra.
 *
 * A FORMA vem do declive. Serve para ler para onde a encosta olha — como mapa
 * topográfico — e por isso é leve: o talude nu no máximo escurece um passo e esfria um
 * pouco. Ele não tem nada em cima dele; sombra funda ali seria mentira, e era: medida na
 * malha, a tinta velha deixava três em cada dez vértices de relevo abaixo de 0,5 de
 * luminância, com fundo de 0,36. Um morro inteiro pintado como se fosse um buraco.
 *
 * A COPA vem das árvores reais, carimbadas no gerador (`data.copa`). É o único preto
 * fundo que existe aqui, porque é o único projetado por alguma coisa que está em cima do
 * chão. Onda curta, deslocada para baixo na tela, colada no pé: a mata fecha e escurece,
 * o talude nu clareia, e a diferença entre mato e pedra passa a ser o que o olho vê.
 *
 * É tudo multiplicativo e OPACO: a cor de um vértice é o quanto de cada canal do chão
 * sobrevive. Alfa 1 é a única forma de o Modulate significar a mesma coisa no Skia nativo
 * (cor pura) e no CanvasKit da web (cor pré-multiplicada) — e é o que conserta o morro
 * apagado: com alfa menor que 1 o Modulate multiplicava também o alfa do chão, cada
 * losango virava vidro e o verde-marinho do fundo subia por baixo. Os dois lados da
 * encosta escureciam para o mesmo barro e o contraste sol/sombra, que é todo o relevo,
 * ia embora.
 *
 * Daí as duas réguas separadas. A do CONTRASTE é fixa: o hillshade já vem do declive
 * real do terreno, e é ele que o olho lê. A segunda, `relevo`, só responde ONDE existe
 * morro, e não quanto. Medir o contraste contra ela foi o erro que deixou a serra lavada:
 * dentro do maciço o maior declive por perto é o mesmo em todo canto (a régua satura),
 * então dividir por ela transformava a cena inteira num platô de 10% de variação.
 *
 * Onde as duas réguas são zero (asfalto, rio, interior) o peso desliza para branco e o
 * losango não é tocado. É por isso que a serra pode ganhar copa sem que a cidade perca um
 * pixel.
 */
/** Abaixo disto não há morro nenhum por perto: ondulação de ruído, e a tinta não entra. */
const REGUA_MIN = 0.06;
/** De ondinha a serra declarada, num trecho curto para a fronteira não virar contorno. */
const REGUA_FAIXA = 0.1;
/**
 * Declive que já é encosta declarada. Medida contra o campo real: o gerador hoje leva a
 * encosta mediana a ~0,3 de hillshade (p90 = 0,49), então esta régua é calibrada em cima
 * disso, não no olho nu.
 */
const REF = 0.3;
/** O platô dentro da serra não é nem sol nem sombra: é a meia-tinta que segura os dois. */
const PLATO = 0.9;
/**
 * Fundo da encosta nua na sombra. Não é sombra de objeto, é só a face que olha para o
 * lado oposto ao sol, e num mapa topográfico ela continua sendo chão: 0,78 deixa o
 * talude lido como relevo sem jamais competir com a copa, que desce a 0,42. Abaixo de
 * ~0,6 o morro vira buraco recortado na tela e a sombra da árvore perde o que comparar.
 */
const FUNDO = 0.78;
/** <1 abre o contraste logo na base da encosta, onde o olho ainda não viu morro nenhum. */
const CURVA = 0.8;
/**
 * Ao sol e na sombra, o matiz é um sussurro. Foi o grito que fez o pedido: com a pedra
 * segurando azul demais na encosta fria, o morro nu do deserto ganhava um lago azul-cinza
 * na tela — uma sombra gigantesca sem árvore nenhuma em cima. Medido no pixel do talude
 * nu, quadro com tinta contra quadro sem tinta (`check-relief-shadow-browser.cjs`): o
 * matiz velho esfriava o chão em 27,5 de azul sobre o vermelho; o de hoje esfria 12,3, e
 * o escuro que faz o relevo ser lido caiu só de 16,9% para 13,4%. A encosta continua
 * escurecendo para o lado oposto ao sol — só não pinta cor onde não há objeto.
 * O frio forte não sumiu do mapa: migrou para o `COPA_MATIZ` abaixo, onde ele é verdade.
 */
const SOL = { r: 0, g: 0.03, b: 0.07 };
const SOMBRA = { r: 0.08, g: 0.02, b: -0.06 };
/**
 * Copada fechada. É o fundo do mapa inteiro, e só se chega nela embaixo de árvore: o
 * verde-azulado da mata, não o ocre da pedra na sombra.
 */
const COPA_FUNDO = 0.42;
/** Matiz da sombra de folha: mais fria que a pedra, porque é clorofila, não terra. */
const COPA_MATIZ = { r: 0.16, g: 0.06, b: -0.18 };

/** A cota de um vértice de malha é a média dos tiles que encostam nele. */
function vertexField(field: Float32Array, W: number, H: number, x: number, y: number) {
  let soma = 0;
  let n = 0;
  for (let dy = -1; dy <= 0; dy++) {
    for (let dx = -1; dx <= 0; dx++) {
      const tx = x + dx;
      const ty = y + dy;
      if (tx < 0 || ty < 0 || tx >= W || ty >= H) continue;
      soma += field[ty * W + tx];
      n++;
    }
  }
  return n ? soma / n : 0;
}

/**
 * Declive no vértice, medido na MESMA superfície que se desenha. Ler o `shades` do tile e
 * promediar os quatro cantos foi o erro que lavou a serra: o hillshade é assinado, e com
 * costelas de ~8 tiles o sol de uma face e a sombra da outra caem no mesmo vértice e se
 * cancelam — a média dá quase zero em toda a montanha, e a tinta fica no meio-termo. O
 * gradiente da cota média não cancela, porque a cota não tem sinal: onde a superfície
 * vira para o sol, o gradiente vira para o sol. E de quebra o que se pinta é exatamente o
 * chão que se entortou, não uma versão dele medida noutro lugar.
 */
function vertexShade(data: CityMapData, x: number, y: number) {
  const leste = vertexHeight(data, x + 2, y);
  const oeste = vertexHeight(data, x - 2, y);
  const sul = vertexHeight(data, x, y + 2);
  const norte = vertexHeight(data, x, y - 2);
  // Os mesmos 4,2 e a mesma curva saturante do gerador: a tinta do losango e a sombra do
  // prop têm de nascer do mesmo sol, senão a floresta inteira fica torta contra a luz.
  const g = (((leste - oeste) + (sul - norte)) / 4) * 4.2;
  return g >= 0 ? 1 - Math.exp(-g) : Math.exp(g) - 1;
}

function vertexRelevo(data: CityMapData, x: number, y: number) {
  return data.relevo ? vertexField(data.relevo, data.tilesW, data.tilesH, x, y) : 0;
}

/** Copada no vértice, média dos tiles que encostam nele — a mesma malha da cota. */
function vertexCopa(data: CityMapData, x: number, y: number) {
  return data.copa ? vertexField(data.copa, data.tilesW, data.tilesH, x, y) : 0;
}

/**
 * Cor do vértice = multiplicador por canal, sempre opaco. Alfa 1 é o que garante que o
 * Skia nativo (cor pura) e o CanvasKit da web (cor pré-multiplicada) leiam o mesmo número
 * em cada um dos milhões de pixels da grade.
 *
 * Forma e copa se multiplicam: o talude nu entrega um passo de sombra, a mata entrega o
 * escuro. Somar os dois em vez de trocar um pelo outro seria o telão de volta.
 */
function shadeColor(s: number, f: number, c: number): SkColor {
  const w = Math.min(1, Math.max(0, (f - REGUA_MIN) / REGUA_FAIXA));
  const t = Math.pow(Math.min(1, Math.abs(s) / REF), CURVA);
  const aoSol = s >= 0;
  const lum = aoSol ? PLATO + (1 - PLATO) * t : PLATO - (PLATO - FUNDO) * t;
  const matiz = aoSol ? SOL : SOMBRA;
  const escuro = 1 - (1 - COPA_FUNDO) * c;
  const forma = (canal: number) => 1 - (1 - lum * (1 - canal * t)) * w;
  return new Float32Array([
    forma(matiz.r) * escuro * (1 - COPA_MATIZ.r * c),
    forma(matiz.g) * escuro * (1 - COPA_MATIZ.g * c),
    forma(matiz.b) * escuro * (1 - COPA_MATIZ.b * c),
    1,
  ]);
}

let tinta: SkPaint | null = null;

function pincelDeTinta() {
  return tinta ??= (() => {
    const q = Skia.Paint();
    q.setAntiAlias(true);
    q.setColor(Skia.Color('#ffffff'));
    // O modo vai na tinta E no argumento: o CanvasKit da web lê o modo da tinta e ignora o
    // argumento do drawVertices (a malha saía opaca por cima do chão), o Skia nativo lê o
    // argumento. Declarar os dois é o único jeito de as duas pontas desenharem a mesma cena.
    q.setBlendMode(BlendMode.Modulate);
    return q;
  })();
}

function drawGroundTint(canvas: SkCanvas, data: CityMapData,
  tx0: number, ty0: number, tx1: number, ty1: number) {
  if (!data.relevo && !data.copa) return;
  const gw = tx1 - tx0 + 2;
  const gh = ty1 - ty0 + 2;
  const pos: { x: number; y: number }[] = new Array(gw * gh);
  const cor = new Float32Array(gw * gh);
  const regua = new Float32Array(gw * gh);
  const copaV = new Float32Array(gw * gh);
  let temTinta = false;
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      const wx = tx0 + gx;
      const wy = ty0 + gy;
      const k = gy * gw + gx;
      cor[k] = vertexShade(data, wx, wy);
      regua[k] = vertexRelevo(data, wx, wy);
      copaV[k] = vertexCopa(data, wx, wy);
      if (regua[k] > REGUA_MIN || copaV[k] > 0) temTinta = true;
      const p = worldToScreen(wx, wy, vertexHeight(data, wx, wy));
      pos[k] = { x: p.x, y: p.y };
    }
  }
  if (!temTinta) return;
  // O losango só entra na malha se o PRÓPRIO tile tiver morro ou copa. Decidir só pelo
  // vértice não basta: o canto compartilhado com a encosta levaria tinta para o asfalto do
  // lado, e o quarteirão acordaria contornado por uma sombra que não existe. O tile plano
  // e nu fica de fora, e o vizinho inclinado ainda morre suave no canto — a cota daquele
  // canto é média com o zero do plano, então a tinta chega a nada antes de encostar na rua.
  const idx: number[] = [];
  const W = data.tilesW;
  const relevo = data.relevo;
  const copa = data.copa;
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      const i = ty * W + tx;
      if ((!relevo || relevo[i] <= 0) && (!copa || copa[i] <= 0)) continue;
      const a = (ty - ty0) * gw + (tx - tx0);
      const b = a + 1, c = a + gw + 1, d = a + gw;
      if (regua[a] <= REGUA_MIN && regua[b] <= REGUA_MIN && regua[c] <= REGUA_MIN && regua[d] <= REGUA_MIN &&
        copaV[a] <= 0 && copaV[b] <= 0 && copaV[c] <= 0 && copaV[d] <= 0) continue;
      idx.push(a, b, c, a, c, d);
    }
  }
  if (!idx.length) return;
  const verts = Skia.MakeVertices(VertexMode.Triangles, pos, null,
    pos.map((_, k) => shadeColor(cor[k], regua[k], copaV[k])), idx, false);
  canvas.drawVertices(verts, BlendMode.Modulate, pincelDeTinta());
  // O `drawVertices` já embrulhou a malha na picture (Skia é refcountado), então o que sobrou
  // aqui é só a alça wasm do bake anterior: sem devolvê-la, cada repintura do chão deixa um
  // clone de vértices morto no heap.
  liberarWeb(verts);
}

/**
 * Neve no chão. Não é tinta de relevo — é o contrário: o `shadeColor` acima só escurece,
 * porque multiplica, e neve clareia.
 *
 * O número que a folha lê não é o acumulado cru: é o acumulado do `SnowSystem` passado
 * pela peneira do tile — areia e cais não seguram nada, asfalto escorre, mato e cota alta
 * seguram tudo. Uma mesma nevasca branqueia a serra e deixa a praia em areia, e quando ela
 * para é a cidade que limpa primeiro, porque a rampa de retenção sobe com a altitude. Por
 * isso não há campo por tile a integrar: a paisagem sai da superfície, não de um estado
 * por quadra que precisaria derreter 57.600 números a cada tick.
 *
 * Cada tile é uma losango opaco na sua própria faixa de alfa, e não uma malha de vértices
 * com `Screen`. Não por gosto: no CanvasKit da web o `drawVertices` compõe a cor do pincel
 * e ignora a cor por vértice, então a malha de neve era um lençol de branco a fundo
 * perdido em cima de qualquer cobertura maior que zero — medido, o chão ia a +46% com o
 * acumulado em 0,15 e a +48% com ele em 0,95, e o pincel verde que serviu de sonda pintou a
 * tela de verde sem que a cor dos vértices mudasse um pixel. Losango por losango com alfa
 * declarado no pincel é o único desenho que faz a mesma coisa nos dois lados do cabo.
 */
const NEVE_COR = '#e3ecf8';
/**
 * Alfa de cada faixa, do farelo ao nevão. Medido no mirante do pinhal do alto pelo quadro
 * A/B/A/B de `check-snow-browser.cjs` (chão seco a 96,3 de luminância): com o acumulado em
 * 0,2 o chão vai a 101,3 (+5,2%) e com ele em 0,95, a 113,6 (+18%) — e o mesmo par no
 * deserto não se move um pixel. O topo não é branco puro porque a folha passa ANTES da
 * tinta: a copa dos pinheiros continua multiplicando por baixo da neve, e é ela que segura
 * o nevão da serra sombreada em ~114 em vez de 150.
 */
const NEVE_FAIXAS = [0.05, 0.13, 0.24, 0.38, 0.55] as const;

/** Ruído por tile: sem ele a neve seria um lençol perfeitamente chapado. */
function sorte(x: number, y: number, salt: number): number {
  let h = Math.imul(x ^ Math.imul(salt, 0x9e3779b9), 2246822519) ^ Math.imul(y + salt, 3266489917);
  h = Math.imul(h ^ (h >>> 15), 668265263) ^ h;
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
}

/** Cobertura do tile, já granulada pelo ruído do lugar. */
function neveNoTile(game: GameState, data: CityMapData, tx: number, ty: number): number {
  if (tx < 0 || ty < 0 || tx >= data.tilesW || ty >= data.tilesH) return 0;
  const i = ty * data.tilesW + tx;
  const t = data.tiles[i];
  const c = game.snow.cobertura(data.heights[i], t.biome, t.kind);
  return c <= 0 ? 0 : c * (0.62 + 0.38 * sorte(tx, ty, 1));
}

const pinceisDeNeve: (SkPaint | null)[] = NEVE_FAIXAS.map(() => null);

/**
 * Sem antialias: duas folhas vizinhas com borda suavizada deixam um fio de chão seco entre
 * si, e o fio se repete em cada junta da malha — a neve sairia quadriculada.
 */
function pincelDeNeve(faixa: number): SkPaint {
  return pinceisDeNeve[faixa] ??= (() => {
    const q = Skia.Paint();
    q.setAntiAlias(false);
    q.setColor(Skia.Color(NEVE_COR));
    q.setAlphaf(NEVE_FAIXAS[faixa]);
    return q;
  })();
}

/**
 * Grãos de neve pousados no chão: o pedido não era só clarear o tile, era deixar partícula
 * em cima dele. São elipses 2:1 — o achatamento do plano isométrico — plantadas por posição
 * interpolada nos quatro cantos do próprio tile, então elas acompanham a encosta entortada
 * em vez de flutuar horizontais sobre ela. O teto por bake é o que mantém o custo igual
 * com a janela cheia de neve ou vazia: detalhe nenhum pode escalar com o mapa.
 */
const GRAO_MAX = 260;
const GRAO_MIN = 0.4;

/**
 * Grão e manta são sempre os mesmos objetos rebobinados, não caminhos que renascem: um
 * `Skia.Path.Make()` por bake é memória wasm que a web não devolve ao heap, e o chão repinta
 * até dez vezes por segundo enquanto o carro anda. `rewind()` mantém o armazenamento do
 * traçado reservado — que é justamente o que um laço de bake paga — e o caminho já registrado
 * na picture anterior não é tocado, porque o Skia é copy-on-write.
 */
let graos: SkPath | null = null;
const mantas: (SkPath | null)[] = NEVE_FAIXAS.map(() => null);
let pincelDoGrao: SkPaint | null = null;

function drawSnowGrain(canvas: SkCanvas, game: GameState, data: CityMapData,
  tx0: number, ty0: number, tx1: number, ty1: number) {
  const path = graos ??= Skia.Path.Make();
  path.rewind();
  const W = data.tilesW;
  let n = 0;
  for (let ty = ty0; ty <= ty1 && n < GRAO_MAX; ty++) {
    for (let tx = tx0; tx <= tx1 && n < GRAO_MAX; tx++) {
      const c = neveNoTile(game, data, tx, ty);
      if (c < GRAO_MIN) continue;
      const vA = vertexHeight(data, tx, ty);
      const vB = vertexHeight(data, tx + 1, ty);
      const vC = vertexHeight(data, tx + 1, ty + 1);
      const vD = vertexHeight(data, tx, ty + 1);
      const A = worldToScreen(tx, ty, vA);
      const B = worldToScreen(tx + 1, ty, vB);
      const C = worldToScreen(tx + 1, ty + 1, vC);
      const D = worldToScreen(tx, ty + 1, vD);
      const qtd = 1 + Math.floor(c * 3);
      for (let k = 0; k < qtd && n < GRAO_MAX; k++) {
        const u = sorte(tx, ty, 3 + k);
        const v = sorte(tx, ty, 11 + k);
        // O tile é o losango dentro do quadrado (u,v): o que passa da diagonal cai no vizinho.
        if (Math.abs(u - 0.5) + Math.abs(v - 0.5) > 0.44) continue;
        const r = 1.6 + sorte(tx, ty, 21 + k) * 1.9;
        const iu = 1 - u;
        const iv = 1 - v;
        const x = A.x * iu * iv + B.x * u * iv + C.x * u * v + D.x * iu * v;
        const y = A.y * iu * iv + B.y * u * iv + C.y * u * v + D.y * iu * v;
        path.addOval(Skia.XYWHRect(x - r, y - r * 0.5, r * 2, r));
        n++;
      }
    }
  }
  if (!n) return;
  const q = pincelDoGrao ??= (() => {
    const p = Skia.Paint();
    p.setAntiAlias(true);
    p.setColor(Skia.Color('#eef4ff'));
    return p;
  })();
  q.setAlphaf(Math.min(0.6, 0.22 + game.snow.depth * 0.4));
  canvas.drawPath(path, q);
}

function drawGroundSnow(canvas: SkCanvas, game: GameState, data: CityMapData,
  tx0: number, ty0: number, tx1: number, ty1: number) {
  if (game.snow.depth <= 0) return;
  // Rebobinadas uma vez por bake, antes do laço: assim a faixa que não teve tile nesta janela
  // fica vazia em vez de carregar o losango de dez segundos atrás.
  for (let f = 0; f < mantas.length; f++) mantas[f]?.rewind();
  let temNeve = false;
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      const c = neveNoTile(game, data, tx, ty);
      if (c <= 0) continue;
      temNeve = true;
      const f = Math.min(NEVE_FAIXAS.length - 1, (c * NEVE_FAIXAS.length) | 0);
      let folha = mantas[f];
      if (!folha) folha = mantas[f] = Skia.Path.Make();
      // O losango do próprio tile, nos quatro cantos projetados com a cota de cada um: a
      // folha veste a encosta entortada em vez de boiar horizontal sobre ela.
      const A = worldToScreen(tx, ty, vertexHeight(data, tx, ty));
      const B = worldToScreen(tx + 1, ty, vertexHeight(data, tx + 1, ty));
      const C = worldToScreen(tx + 1, ty + 1, vertexHeight(data, tx + 1, ty + 1));
      const D = worldToScreen(tx, ty + 1, vertexHeight(data, tx, ty + 1));
      folha.moveTo(A.x, A.y);
      folha.lineTo(B.x, B.y);
      folha.lineTo(C.x, C.y);
      folha.lineTo(D.x, D.y);
      folha.close();
    }
  }
  if (!temNeve) return;
  for (let f = 0; f < NEVE_FAIXAS.length; f++) {
    const folha = mantas[f];
    if (folha && !folha.isEmpty()) canvas.drawPath(folha, pincelDeNeve(f));
  }
  drawSnowGrain(canvas, game, data, tx0, ty0, tx1, ty1);
}

function bakeVisibleTiles(game: GameState): SkPicture {
  const { data } = game.map;
  const W = data.tilesW;
  const view = game.fog.view(game);
  const aabb = game.fog.worldBounds(view);
  // O AABB já vem dilatado pelo relevo (FogSystem.worldBounds): o tile elevado é
  // desenhado na posição plana de quem está `h` tiles mais ao fundo.
  const climb = GAME_CONFIG.TERRAIN_MAX_ELEVATION;
  const tx0 = Math.max(0, Math.floor(aabb.minX - 1));
  const tx1 = Math.min(W - 1, Math.ceil(aabb.maxX));
  const ty0 = Math.max(0, Math.floor(aabb.minY - 1));
  const ty1 = Math.min(data.tilesH - 1, Math.ceil(aabb.maxY));

  const fallback =
    spriteStore[tileKey('tile_ground_grass')] ||
    spriteStore[tileKey('tile_ground_dirt')] ||
    spriteStore[tileKey('tile_ground_concrete')];

  const recorder = Skia.PictureRecorder();
  const rx = view.radiusX + FOG.padding + 128;
  const ry = view.radiusY + FOG.padding + 64 + climb * ELEVATION_PX;
  const canvas = recorder.beginRecording(Skia.XYWHRect(view.x - rx, view.y - ry, rx * 2, ry * 2));
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      // O canto compartilhado é o que fecha a malha: o tile se apoia na média dos
      // quatro tiles que tocam cada vértice dele, e não na própria cota isolada.
      const vA = vertexHeight(data, tx, ty);
      const vB = vertexHeight(data, tx + 1, ty);
      const vC = vertexHeight(data, tx + 1, ty + 1);
      const vD = vertexHeight(data, tx, ty + 1);
      const A = worldToScreen(tx, ty, vA);
      const plano = vA === vB && vB === vC && vC === vD;
      if (!game.fog.intersects(view, A.x - 65, A.y - 2, 130, 68 + vA * ELEVATION_PX)) continue;
      const t = data.tiles[ty * W + tx];
      if (t.kind === 'road') {
        drawRoad(canvas, data, tx, ty, vA, vB, vC, vD);
      } else {
        const img = spriteStore[tileKey(t.key)] || fallback;
        if (!img) continue;
        // Cidade e água são planas por contrato, e é o caminho rápido: sem matriz nem
        // máscara por tile, o bake da malha urbana custa o que custava antes do relevo.
        if (plano) canvas.drawImage(img, A.x - 64, A.y);
        else drawTiltedTile(canvas, img, A,
          worldToScreen(tx + 1, ty, vB), worldToScreen(tx + 1, ty + 1, vC), worldToScreen(tx, ty + 1, vD));
      }
    }
  }
  // A neve veste o chão antes da tinta, e por uma razão física: a copa acima ainda é sol
  // tapado, e sol tapado escurece neve. Pintada depois da tinta, a manta branca ignoraria
  // a sombra da árvore em cima dela e a mata fechada acordaria clareada no meio do escuro.
  drawGroundSnow(canvas, game, data, tx0, ty0, tx1, ty1);
  // A tinta veste o chão inteiro de uma vez, com o vértice dividido com o vizinho: pintada
  // losango a losango, a emenda da grade virava contorno de bloco.
  drawGroundTint(canvas, data, tx0, ty0, tx1, ty1);
  const picture = recorder.finishRecordingAsPicture();
  recorder.dispose();
  return picture;
}

export const GroundLayer = memo(function GroundLayer({ game }: { game: GameState }) {
  const [picture, setPicture] = useState<SkPicture | null>(null);
  const lastKey = useRef('');
  // A picture que está no `<Picture>` agora. É a referência que decide se uma liberação adiada
  // ainda vale: devolvê-la enquanto ela desenha é o uso-after-free que estourou o heap.
  const entregue = useRef<SkPicture | null>(null);

  useEffect(() => {
    const anterior = entregue.current;
    entregue.current = picture;
    if (anterior && anterior !== picture) {
      devolverNoTempoDoDesenho(anterior, () => entregue.current === anterior);
    }
  }, [picture]);

  useEffect(() => {
    return () => {
      const atual = entregue.current;
      entregue.current = null;
      if (atual) devolverNoTempoDoDesenho(atual);
    };
  }, []);

  useEffect(() => {
    lastKey.current = '';
    const tick = () => {
      const key = cameraCellKey(game);
      if (key === lastKey.current) return;
      lastKey.current = key;
      setPicture(bakeVisibleTiles(game));
    };
    tick();
    const iv = setInterval(tick, GAME_CONFIG.BAKE_INTERVAL_MS);
    return () => clearInterval(iv);
  }, [game]);

  if (!picture) return null;
  return <Picture picture={picture} />;
});
