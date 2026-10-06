import { Group, Path } from '@shopify/react-native-skia';
import { getGame, type GameState } from '../game/GameState';
import { makeProjectors } from '../world/MapPresentation';
import { FRONTEIRA_ALCANCE, PROFUNDIDADE_SEM_NOME, árvoreDoTile, type ConsultaDeÁgua } from '../world/Frontier';
import { CÉLULA_DA_TRIBO, acampamentoDaCélula } from '../world/Tribo';
import type { Biome } from '../game/GameConfig';

/**
 * O mapa mostra o que o mundo é, não só o que o gerador guardou.
 *
 * Até aqui, `radarPixels` e a máscara de exploração eram rigorosamente `W×H`: fora da grade o
 * mapa era o fundo preto da tela, e o jogador que saísse da última rua via uma mata infinita
 * pela janela e um vazio absoluto no instrumento com que ele decide para onde andar. Isso é
 * pior que um muro — é o mapa mentindo. A fronteira já é uma *função* da coordenada (nada dela
 * é salvo; `Frontier` e `Tribo` derivam tudo do mesmo hash), então desenhar esse terreno no
 * mapa não custa geometria nova nem versão de save: custa ler as mesmas chamadas que o chão do
 * mundo já lê, e é por isso que a mata do mapa e o tronco que barra o passo não podem divergir.
 *
 * A outra metade é o pedido com outras palavras: "tudo de interesse" tem de ter cara no mapa.
 * O `Map` já expõe `landmarks` com nove tipos (delegacia, bombeiros, hospital, rodoviária…), o
 * gerador já expõe cachoeiras e bocas de caverna, e a tribo já existe como acampamento
 * determinístico — e nenhum dos três era desenhado. Um retângulo genérico por porta não
 * responde "onde fica o posto de bombeiros"; um glifo por tipo responde, e é por isso que cada
 * tipo aqui tem silhueta própria em vez de um círculo colorido.
 *
 * Um critério final, este de execução: todo traço nasce de polilinhas fechadas (`M`/`L`/`Z`)
 * montadas já em coordenada de tela, e nunca de um `<Group transform>` por ícone. Ícone
 * transformado é um nó por lugar no frame do radar, que roda a 120 ms; ícone compilado em
 * caminho é um nó por *tipo*, e o radar passa a pagar uma dezena de nós seja qual for o
 * tamanho da cidade. É também o que permite ao check em memória medir a geometria de cada glifo
 * e a área de cada faixa sem navegador nenhum.
 */

/** O viewport que o `MapCanvas` já calcula; aqui só se repete a assinatura. */
interface Vista {
  mapW: number;
  mapH: number;
  zoom: number;
  panX: number;
  panY: number;
  detailed: boolean;
}

/** Um retângulo do mundo, em tiles. Mantido cru para o poder cobrar cobertura sem projeção. */
export interface Rect { x: number; y: number; w: number; h: number; }
export interface RetânguloPintado extends Rect { cor: string; }

export type TipoDePonto =
  | 'police' | 'hospital' | 'firestation' | 'church' | 'gasstation'
  | 'clinic' | 'autoshop' | 'busstation' | 'shop' | 'cave' | 'cascade' | 'tribo';

export interface PontoDeInteresse {
  tipo: TipoDePonto;
  x: number;
  y: number;
  /** O nome que a legenda e qualquer fala de navegação diriam. */
  nome: string;
  /** Fora da grade a exploração não alcança: a terra sem nome é conhecida por definição. */
  sempreVisível: boolean;
}

/**
 * As cores por tipo não são paleta de designer, são as cores que o resto da interface já
 * promete: o azul é o `C.police` do radar, o ouro é o da rota do GPS, e o vermelho da tribo é o
 * dos avisos de caçada. Ícone que destoa da HUD vira duas leituras do mesmo lugar.
 */
export const CORES_DOS_PONTOS: Record<TipoDePonto, string> = {
  police: '#7ebaff', hospital: '#ff9fb0', firestation: '#ff8a5c', church: '#e8d8a8',
  gasstation: '#8fe0c0', clinic: '#c9b7ff', autoshop: '#b8c9d6', busstation: '#eabb72',
  shop: '#d4ba98', cave: '#9d8fd6', cascade: '#6fd8e8', tribo: '#e0655f',
};

export const NOMES_DOS_PONTOS: Record<TipoDePonto, string> = {
  police: 'Delegacia', hospital: 'Hospital', firestation: 'Bombeiros', church: 'Igreja',
  gasstation: 'Posto de gasolina', clinic: 'Clínica', autoshop: 'Oficina', busstation: 'Rodoviária',
  shop: 'Comércio', cave: 'Caverna', cascade: 'Cachoeira', tribo: 'Acampamento canibal',
};

/**
 * O que cada tipo faz na tela, em `[-1,1]` com y para baixo. O tipo inteiro é um nó só com
 * `fillType="evenOdd"`, então vale a aritmética do par: uma parte dentro da outra vira buraco (o
 * para-brisa do ônibus, as órbitas do caveiro) e duas partes que se encostam sem se sobrepor
 * ficam sólidas juntas (o corpo abaixo do telhado, as duas bombas do posto, as rodas sob o carro).
 * O que não pode existir é parte que cruza parte: aí a interseção se apaga sozinha e o glifo
 * perde um pedaço no mapa.
 *
 * As silhuetas têm de sobreviver a cinco pixels: por isso nenhuma é um traço fino (uma cruz de
 * espessura 0,1 sumiria) e por isso hospital e clínica não são o mesmo glifo em cor diferente —
 * o jogador lê a forma antes da cor, e dois serviços médicos vizinhos com a mesma forma
 * pareceria um erro de mapa.
 */
export const GLIFOS: Record<TipoDePonto, number[][][]> = {
  police: [[[0, -1], [0.85, -0.55], [0.7, 0.45], [0, 1], [-0.7, 0.45], [-0.85, -0.55]]],
  hospital: [[[-0.34, -1], [0.34, -1], [0.34, -0.34], [1, -0.34], [1, 0.34], [0.34, 0.34],
    [0.34, 1], [-0.34, 1], [-0.34, 0.34], [-1, 0.34], [-1, -0.34], [-0.34, -0.34]]],
  firestation: [[[0, -1], [0.6, -0.2], [0.85, 0.5], [0.3, 1], [-0.35, 1], [-0.8, 0.35], [-0.45, -0.35]]],
  church: [[[0, -1], [0.9, 0.15], [-0.9, 0.15]], [[-0.6, 0.3], [0.6, 0.3], [0.6, 1], [-0.6, 1]]],
  gasstation: [[[-0.85, -0.8], [0.15, -0.8], [0.15, 1], [-0.85, 1]],
    [[0.4, -0.4], [0.9, -0.4], [0.9, 1], [0.4, 1]]],
  clinic: [[[0.35, -1], [1, -0.35], [1, 0.35], [0.35, 1], [-0.35, 1], [-1, 0.35], [-1, -0.35], [-0.35, -1]],
    [[-0.25, -0.55], [0.25, -0.55], [0.25, 0.55], [-0.25, 0.55]]],
  autoshop: [[[-0.95, 0.6], [-0.35, 0.1], [0.1, -0.5], [0.5, -0.95], [0.95, -0.5], [0.5, -0.1],
    [0.1, 0.45], [-0.4, 0.95]]],
  busstation: [[[-0.85, -0.8], [0.85, -0.8], [0.85, 0.6], [-0.85, 0.6]],
    [[-0.6, -0.55], [0.6, -0.55], [0.6, -0.1], [-0.6, -0.1]],
    [[-0.65, 0.6], [-0.25, 0.6], [-0.25, 0.95], [-0.65, 0.95]],
    [[0.25, 0.6], [0.65, 0.6], [0.65, 0.95], [0.25, 0.95]]],
  shop: [[[-0.9, -1], [0.9, -1], [0.9, -0.4], [-0.9, -0.4]],
    [[-0.75, -0.15], [0.75, -0.15], [0.6, 1], [-0.6, 1]]],
  cave: [[[-0.9, 1], [-0.9, 0.1], [-0.55, -0.6], [0, -1], [0.55, -0.6], [0.9, 0.1], [0.9, 1]],
    [[-0.5, 1], [-0.5, 0.15], [0, -0.4], [0.5, 0.15], [0.5, 1]]],
  cascade: [[[-0.45, -1], [0.45, -1], [0.6, 0.3], [-0.6, 0.3]],
    [[-1, 0.5], [1, 0.5], [1, 1], [-1, 1]]],
  tribo: [[[-0.7, -0.5], [-0.7, 0.2], [-0.4, 0.5], [-0.4, 1], [0.4, 1], [0.4, 0.5], [0.7, 0.2],
    [0.7, -0.5], [0.35, -1], [-0.35, -1]],
    [[-0.45, -0.35], [-0.15, -0.35], [-0.15, 0.05], [-0.45, 0.05]],
    [[0.15, -0.35], [0.45, -0.35], [0.45, 0.05], [0.15, 0.05]]],
};

/**
 * Os pontos que só aparecem no mapa cheio. Não é pudor de radar: o comércio é dezenas de
 * ícones, e no painel de 112 px do "onde estou agora" eles tapariam a rua com que o jogador
 * decide a curva. No mapa cheio, onde se olha o plano inteiro, todos voltam.
 */
const SÓ_NO_MAPA = new Set<TipoDePonto>(['shop']);

/** Raio do glifo em pixels de tela. No radar o ícone não pode engolir o traçado da rua. */
export function raioDoTipo(tipo: TipoDePonto, detailed: boolean): number {
  if (tipo === 'tribo') return detailed ? 7 : 5;
  return detailed ? 6 : 4;
}

/**
 * O glifo de um tipo já em coordenada de tela. `r` veste a caixa `[-r, r]²` em torno do centro;
 * cada subpolilinha vira um fecho `Z` no mesmo caminho, porque todas as cópias de um tipo no
 * frame são um nó só.
 */
export function glifoEm(tipo: TipoDePonto, cx: number, cy: number, r: number): string {
  let out = '';
  for (const linha of GLIFOS[tipo]) {
    linha.forEach(([nx, ny], i) => {
      out += `${i ? 'L' : 'M'}${(cx + nx * r).toFixed(2)},${(cy + ny * r).toFixed(2)}`;
    });
    out += 'Z';
  }
  return out;
}

/** A ficha escura atrás do glifo: sem ela, um ícone claro sobre asfalto claro desaparece. */
export function fichaEm(cx: number, cy: number, r: number): string {
  const k = r * 1.25;
  return `M${cx.toFixed(2)},${(cy - k).toFixed(2)}L${(cx + k).toFixed(2)},${cy.toFixed(2)}`
    + `L${cx.toFixed(2)},${(cy + k).toFixed(2)}L${(cx - k).toFixed(2)},${cy.toFixed(2)}Z`;
}

/** Losango de um retângulo do mundo, já em tela. É o mesmo mapeamento do `mapPolygon` do mapa. */
function retânguloNaTela(project: (x: number, y: number) => { x: number; y: number }, r: Rect): string {
  return [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]].map(([x, y], i) => {
    const p = project(x, y);
    return `${i ? 'L' : 'M'}${p.x.toFixed(2)},${p.y.toFixed(2)}`;
  }).join('') + 'Z';
}

// ---- o que a cidade tem de interesse ----

/** Cache por `Map`: landmarks, cachoeiras e cavernas são do gerador e não mudam na partida. */
const cacheDaCidade = new WeakMap<object, PontoDeInteresse[]>();

/**
 * O que a cidade tem de interesse, lido do que já existe — `map.landmarks`, `cascatas`,
 * `cavernas` — e nunca de uma lista de endereços à parte, porque uma lista à parte é um mapa
 * descrevendo outro mapa: no dia em que o gerador mover a rodoviária, ela continuaria apontando
 * para o lote velho.
 *
 * A cadeia não ganha glifo próprio de propósito: a porta do presídio é ancorada na esquadra mais
 * isolada da cidade (`InteriorSystem`), então um ícone por porta e outro por prédio dariam dois
 * glifos no mesmo metro quadrado, e o jogador leria dois lugares onde há um.
 */
export function pontosDaCidade(game: GameState): PontoDeInteresse[] {
  const cacheado = cacheDaCidade.get(game.map);
  if (cacheado) return cacheado;
  const out: PontoDeInteresse[] = [];
  for (const l of game.map.landmarks) {
    out.push({ tipo: l.kind, x: l.x, y: l.y, nome: NOMES_DOS_PONTOS[l.kind], sempreVisível: false });
  }
  for (const c of game.map.data.cascatas ?? []) {
    // A cachoeira é anunciada pela bacia, não pelo lábio: é na bacia que o jogador chega, e é
    // onde a queda deixa de ser um ponto no horizonte e vira um lugar em que se entra.
    out.push({ tipo: 'cascade', x: c.bacia.x, y: c.bacia.y, nome: NOMES_DOS_PONTOS.cascade,
      sempreVisível: false });
  }
  for (const m of game.map.data.cavernas ?? []) {
    out.push({ tipo: 'cave', x: m.x, y: m.y, nome: NOMES_DOS_PONTOS.cave, sempreVisível: false });
  }
  cacheDaCidade.set(game.map, out);
  return out;
}

/** Cache por mundo: os acampamentos são hash puro, então a lista é do seed, não da partida. */
const cacheDaFronteira = new WeakMap<object, PontoDeInteresse[]>();

/**
 * As aldeias da terra sem nome, colhidas nas células do anel jogável.
 *
 * A varredura tem teto por aritmética e não por gosto: `densidadeDoTerritório` só responde
 * acima de `PROFUNDIDADE_SEM_NOME` e morre a 24 tiles do muro invisível, então as células que
 * podem ter aldeia são as que tocam esse anel — nada além dele tem acampamento. É o mesmo
 * `acampamentoDaCélula` que o render do mundo e o bando de guerreiros consultam; desenhar o
 * mapa a partir de outra conta seria o mapa e a mata discordarem sobre onde é aldeia, que é
 * exatamente o defeito que a fronteira inteira existe para não ter.
 *
 * O glifo fica na boca do lugar, e não no centro: quem olha o mapa quer saber por onde se entra,
 * e o centro da clareira é a fogueira — para onde se é arrastado.
 */
export function pontosDaFronteira(W: number, H: number, água: ConsultaDeÁgua,
  mundo: object): PontoDeInteresse[] {
  const cacheado = cacheDaFronteira.get(mundo);
  if (cacheado) return cacheado;
  const out: PontoDeInteresse[] = [];
  const x0 = Math.floor(-FRONTEIRA_ALCANCE / CÉLULA_DA_TRIBO);
  const x1 = Math.floor((W + FRONTEIRA_ALCANCE) / CÉLULA_DA_TRIBO);
  const y0 = Math.floor(-FRONTEIRA_ALCANCE / CÉLULA_DA_TRIBO);
  const y1 = Math.floor((H + FRONTEIRA_ALCANCE) / CÉLULA_DA_TRIBO);
  for (let cy = y0; cy <= y1; cy++) {
    for (let cx = x0; cx <= x1; cx++) {
      const ac = acampamentoDaCélula(cx, cy, W, H, água);
      if (!ac) continue;
      out.push({ tipo: 'tribo', x: ac.entrada.x, y: ac.entrada.y,
        nome: NOMES_DOS_PONTOS.tribo, sempreVisível: true });
    }
  }
  cacheDaFronteira.set(mundo, out);
  return out;
}

// ---- o terreno além da grade ----

/** Degraus de profundidade: os mesmos cortes de `nomeDaTerra`, e não números inventados aqui. */
export const PASSOS_DA_FRONTEIRA: readonly number[] = [3, 12, PROFUNDIDADE_SEM_NOME, FRONTEIRA_ALCANCE];
/** Verde de mata, do mais perto da cidade ao mais fundo. É a régua que faz "fora" parecer longe. */
export const BANDAS_DA_MATA: readonly string[] = ['#3f5239', '#31452f', '#263828', '#1c2a20'];

/**
 * O material do tile de beira que a faixa de fora continua.
 *
 * A mata sem fim é a regra geral, mas o anel não é só mata: medido no mapa gerado a beira tem
 * praia, deserto, rio e asfalto em partes do perímetro, e pintar tudo de verde trocaria o "aqui
 * acaba a cidade" por "aqui o mapa mente". A classe existe por isso — é a matéria da última
 * fila, lida da mesma forma que `chãoDaFronteira` pinta o chão do mundo.
 */
export type ClasseDaBeira = 'mata' | 'campo' | 'areia' | 'deserto' | 'água' | 'rua' | 'concreto';

export function classeDaBeira(t: { kind: string; biome: Biome } | undefined): ClasseDaBeira {
  if (!t) return 'campo';
  if (t.kind === 'water') return 'água';
  if (t.kind === 'road') return 'rua';
  if (t.kind === 'concrete') return 'concreto';
  if (t.biome === 'beach') return 'areia';
  if (t.biome === 'desert' || t.biome === 'savanna') return 'deserto';
  if (t.biome === 'forest' || t.biome === 'pinewood') return 'mata';
  return 'campo';
}

/**
 * A tinta de cada classe em cada degrau. `null` quer dizer "deixa a banda de mata aparecer":
 * mata e campo já são o que as faixas pintam, e reescrevê-los por cima só apagaria o sombreado
 * de profundidade que faz a terra sem nome parecer longe da orla.
 */
const TINTAS: Partial<Record<ClasseDaBeira, readonly string[]>> = {
  areia: ['#a8985f', '#94855a', '#7f7254', '#6c614a'],
  deserto: ['#8a7c60', '#786c55', '#655b48', '#544c3d'],
  água: ['#1c374b', '#17303f', '#122633', '#0d1f29'],
  rua: ['#8f9ea3', '#7d8b90', '#6a777c', '#586469'],
  concreto: ['#43535b', '#3a4850', '#313d45', '#28323a'],
};

/** Cache por `data`: o anel é geometria do gerador, e varrer 960 tiles de beira por frame é bobagem. */
const cacheDoAnel = new WeakMap<object, RetânguloPintado[]>();

/**
 * O anel jogável fatiado em retângulos de mundo, por material e degrau de profundidade.
 *
 * Cada lado percorre a própria fila de beira e empilha degraus para fora, juntando tiles
 * vizinhos do mesmo material numa caixa só — é o que mantém a conta em dezenas de retângulos
 * numa malha de 240, em vez de milhares. Os quatro cantos são anéis decompostos em duas caixas
 * cada, porque para um tile fora em duas direções a beira de referência é o canto da grade, e se
 * o canto do mapa é água o canto do mundo tem de ser água.
 *
 * Nada aqui passa do último degrau: fora de `FRONTEIRA_ALCANCE` o corpo não chega, e um mapa que
 * desenha o que ninguém alcança inventa um destino.
 *
 * As caixas são disjuntas de propósito, e não retângulos aninhados pintados um sobre o outro:
 * quem desenha agrupa por cor para virar um nó por tinta, e se uma caixa cobrisse a outra a
 * ordem dos nós passaria a decidir o mapa. Sem sobreposição, cor nenhuma esconde outra.
 */
export function faixasDaFronteira(tiles: readonly { key: string; kind: string; biome: Biome }[],
  W: number, H: number): RetânguloPintado[] {
  const cacheado = cacheDoAnel.get(tiles);
  if (cacheado) return cacheado;
  const out: RetânguloPintado[] = [];
  const linha = (ty: number, tx: number) => tiles[ty * W + tx];
  // A fatia nova de um eixo (`anel`), a extensão inteira (`cheio`) e a parte velha (`sobria`),
  // para o canto ficar do lado que o anchor manda: -1 empurra para fora pela esquerda/cima.
  const eixo = (s: -1 | 1, a: number, p: number, pp: number) => ({
    anel: { pos: s < 0 ? a - p : a + pp, tam: p - pp },
    cheio: { pos: s < 0 ? a - p : a, tam: p },
    sobrio: { pos: s < 0 ? a - pp : a, tam: pp },
  });
  PASSOS_DA_FRONTEIRA.forEach((passo, degrau) => {
    const inicial = degrau === 0 ? 0 : PASSOS_DA_FRONTEIRA[degrau - 1];
    const largura = passo - inicial;
    // Lados: a profundidade corre no eixo perpendicular à fila de beira, e a fila percorre só
    // a extensão da grade — o que sobra fora dela são os cantos, tratados à parte.
    const lados = [
      { classe: (i: number) => classeDaBeira(linha(i, 0)), tamanho: H,
        caixa: (i: number, n: number): Rect => ({ x: -passo, y: i, w: largura, h: n }) },
      { classe: (i: number) => classeDaBeira(linha(i, W - 1)), tamanho: H,
        caixa: (i: number, n: number): Rect => ({ x: W + inicial, y: i, w: largura, h: n }) },
      { classe: (i: number) => classeDaBeira(linha(0, i)), tamanho: W,
        caixa: (i: number, n: number): Rect => ({ x: i, y: -passo, w: n, h: largura }) },
      { classe: (i: number) => classeDaBeira(linha(H - 1, i)), tamanho: W,
        caixa: (i: number, n: number): Rect => ({ x: i, y: H + inicial, w: n, h: largura }) },
    ];
    for (const lado of lados) {
      let inicio = 0;
      while (inicio < lado.tamanho) {
        const classe = lado.classe(inicio);
        let fim = inicio + 1;
        while (fim < lado.tamanho && lado.classe(fim) === classe) fim++;
        const tinta = TINTAS[classe];
        if (tinta) out.push({ ...lado.caixa(inicio, fim - inicio), cor: tinta[degrau] });
        inicio = fim;
      }
    }
    // Cantos: o anel entre o degrau anterior e este, em duas caixas que não se tocam.
    const cantos: [number, number, -1 | 1, -1 | 1, number, number][] = [
      [0, 0, -1, -1, 0, 0], [0, H, -1, 1, 0, H - 1], [W, 0, 1, -1, W - 1, 0], [W, H, 1, 1, W - 1, H - 1],
    ];
    for (const [ax, ay, sx, sy, tx, ty] of cantos) {
      const tinta = TINTAS[classeDaBeira(linha(ty, tx))];
      if (!tinta) continue;
      const ex = eixo(sx, ax, passo, inicial), ey = eixo(sy, ay, passo, inicial);
      out.push({ x: ex.anel.pos, y: ey.cheio.pos, w: ex.anel.tam, h: ey.cheio.tam, cor: tinta[degrau] });
      if (inicial > 0) {
        out.push({ x: ex.sobrio.pos, y: ey.anel.pos, w: ex.sobrio.tam, h: ey.anel.tam,
          cor: tinta[degrau] });
      }
    }
  });
  cacheDoAnel.set(tiles, out);
  return out;
}

/**
 * As quatro bandas de mata, cada uma o anel do retângulo expandido menos o anel de dentro.
 *
 * Devolvidas em coordenadas do mundo, com um `furo`: em `evenOdd` dois losangos fechados viram
 * um anel só, e o furo é o que impede a tinta da mata de cobrir a cidade já desenhada abaixo
 * dela no mesmo frame — sem clipe, sem máscara e sem mexer no `MapCanvas`.
 */
export interface Banda { cor: string; externo: Rect; furo: Rect; }

export function bandasDaMata(W: number, H: number): Banda[] {
  const out: Banda[] = [];
  PASSOS_DA_FRONTEIRA.forEach((passo, i) => {
    const inicial = i === 0 ? 0 : PASSOS_DA_FRONTEIRA[i - 1];
    out.push({
      cor: BANDAS_DA_MATA[i],
      externo: { x: -passo, y: -passo, w: W + passo * 2, h: H + passo * 2 },
      furo: { x: -inicial, y: -inicial, w: W + inicial * 2, h: H + inicial * 2 },
    });
  });
  return out;
}

/**
 * Os troncos visíveis deste recorte, num único caminho.
 *
 * A densidade de amostragem vem do zoom, não de um passo fixo: a um tile por ponto o mapa cheio
 * varreria as ~180 mil caixas do anel em cada arrasto de dedo, e a vinte tiles o radar perderia
 * a textura da mata. O teto de pontos é o que dá custo conhecido ao pior caso, e o piso de
 * pixels por ponto é o que faz cada tronco continuar sendo um pino desenhável.
 *
 * A árvore é a MESMA `árvoreDoTile` que o mundo desenha e que barra o passo: plantar o ponto do
 * mapa por outra conta seria o mapa dizer "tem tronco aqui" onde o corpo passa voando.
 */
export function pontosDeÁrvore(view: ReturnType<typeof makeProjectors>, mapaW: number, mapaH: number,
  W: number, H: number, água: ConsultaDeÁgua, teto: number): string {
  const A = FRONTEIRA_ALCANCE;
  const cantosDaTela = [[0, 0], [mapaW, 0], [0, mapaH], [mapaW, mapaH]]
    .map(([sx, sy]) => view.screenToWorld(sx, sy));
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const c of cantosDaTela) {
    minX = Math.min(minX, c.x); maxX = Math.max(maxX, c.x);
    minY = Math.min(minY, c.y); maxY = Math.max(maxY, c.y);
  }
  minX = Math.max(-A, Math.floor(minX)); maxX = Math.min(W + A, Math.ceil(maxX));
  minY = Math.max(-A, Math.floor(minY)); maxY = Math.min(H + A, Math.ceil(maxY));
  const área = Math.max(0, maxX - minX) * Math.max(0, maxY - minY);
  if (área <= 0) return '';
  // 16 px por ponto no pior caso, e o teto aperta o passo se a janela ainda assim for grande.
  const passoPelaTela = Math.max(1, Math.ceil(16 / Math.max(0.05, view.scale)));
  const passo = Math.max(passoPelaTela, Math.ceil(Math.sqrt(área / Math.max(1, teto))));
  let out = '';
  let desenhadas = 0;
  for (let ty = minY + Math.floor(passo / 2); ty < maxY; ty += passo) {
    for (let tx = minX + Math.floor(passo / 2); tx < maxX; tx += passo) {
      if (tx >= 0 && ty >= 0 && tx < W && ty < H) continue;
      const árvore = árvoreDoTile(tx, ty, W, H, água);
      if (!árvore) continue;
      const p = view.worldToScreen(árvore.x, árvore.y);
      const r = Math.max(0.9, Math.min(2.4, view.scale * 0.55 * árvore.escala));
      out += `M${p.x.toFixed(2)},${(p.y - r).toFixed(2)}L${(p.x + r).toFixed(2)},${p.y.toFixed(2)}`
        + `L${p.x.toFixed(2)},${(p.y + r).toFixed(2)}L${(p.x - r).toFixed(2)},${p.y.toFixed(2)}Z`;
      desenhadas++;
    }
  }
  return desenhadas ? out : '';
}

// ---- o desenho ----

/** Agrupa retângulos por cor para que cada tinta do anel seja um nó, não duzentos. */
function porCor(retângulos: RetânguloPintado[],
  project: (x: number, y: number) => { x: number; y: number }): { cor: string; path: string }[] {
  const grupos = new globalThis.Map<string, string[]>();
  for (const r of retângulos) {
    const lista = grupos.get(r.cor);
    if (lista) lista.push(retânguloNaTela(project, r));
    else grupos.set(r.cor, [retânguloNaTela(project, r)]);
  }
  return Array.from(grupos, ([cor, partes]) => ({ cor, path: partes.join('') }));
}

/**
 * A camada. Vive fora do `Group` transformado do `MapCanvas` de propósito: o transform daquela
 * camada pertence ao raster da cidade, e herdá-lo amarraria o anel ao recorte losangular do
 * mapa gerado — que é exatamente a grade que esta frente existe para ultrapassar.
 */
export function PontosDeInteresse({ mapW, mapH, zoom, panX, panY, detailed }: Vista) {
  const game = getGame();
  const data = game.map.data;
  const W = data.tilesW, H = data.tilesH;
  const view = makeProjectors(mapW, mapH, 0, W, H, zoom, panX, panY);
  const project = view.worldToScreen;
  const água: ConsultaDeÁgua = game.map;

  const bandas = bandasDaMata(W, H).map((b) => ({
    cor: b.cor,
    path: `${retânguloNaTela(project, b.externo)}${retânguloNaTela(project, b.furo)}`,
  }));
  const tintas = porCor(faixasDaFronteira(data.tiles, W, H), project);
  const mata = pontosDeÁrvore(view, mapW, mapH, W, H, água, detailed ? 620 : 260);

  const pontos = [...pontosDaCidade(game), ...pontosDaFronteira(W, H, água, game.map)]
    .filter((ponto) => {
      if (SÓ_NO_MAPA.has(ponto.tipo) && !detailed) return false;
      const s = project(ponto.x, ponto.y);
      if (s.x < -14 || s.y < -14 || s.x > mapW + 14 || s.y > mapH + 14) return false;
      // Dentro da grade vale a mesma regra do resto do mapa: o que nunca foi visto não é
      // anunciado. A terra sem nome fica de fora porque a exploração não tem como conhecê-la —
      // e é justamente o que faz a aldeia aparecer no instrumento como um lugar a procurar.
      if (!ponto.sempreVisível
        && !game.exploration.isExplored(Math.floor(ponto.x), Math.floor(ponto.y))) return false;
      return true;
    });

  let fichas = '';
  const glifos = new globalThis.Map<TipoDePonto, string>();
  for (const ponto of pontos) {
    const s = project(ponto.x, ponto.y);
    const r = raioDoTipo(ponto.tipo, detailed);
    fichas += fichaEm(s.x, s.y, r);
    glifos.set(ponto.tipo, (glifos.get(ponto.tipo) ?? '') + glifoEm(ponto.tipo, s.x, s.y, r * 0.82));
  }

  return <Group>
    {bandas.map((b) => <Path key={`banda${b.cor}`} path={b.path} color={b.cor} fillType="evenOdd" />)}
    {tintas.map((t) => <Path key={`tinta${t.cor}`} path={t.path} color={t.cor} />)}
    {mata !== '' && <Path path={mata} color="#16211a" opacity={0.85} />}
    {fichas !== '' && <Path path={fichas} color="#0a1016" opacity={0.66} />}
    {Array.from(glifos, ([tipo, path]) => (
      <Path key={`ponto${tipo}`} path={path} color={CORES_DOS_PONTOS[tipo]} fillType="evenOdd" />))}
  </Group>;
}
