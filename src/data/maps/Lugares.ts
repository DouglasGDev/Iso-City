import type { Biome } from '../../game/GameConfig';
import type { RoadRank } from './city';

/**
 * O nome dos lugares.
 *
 * Até aqui o mapa sabia de cor o que cada tile *é* — asfalto, grama, pinhal — e não sabia
 * onde você *está*. A única resposta que a tela dava para "onde eu estou?" era o rótulo do
 * bioma debaixo do pé, que é a mesma palavra para as dezenas de milhares de células da mata
 * inteira. Uma cidade sem bairro e sem rua é um tabuleiro, não um lugar: ninguém pode dizer
 * "te encontro no Jardim Aurora, na esquina da Avenida Brasil com a Rua das Laranjeiras",
 * e é essa frase que faz um mapa de 240×240 tiles caber na cabeça de quem joga.
 *
 * A decisão de desenho: **nada aqui é escrito à mão e nada aqui vai para o save.** Bairro,
 * zona, rio e via são geometria derivada do que o gerador já decidiu — a malha de quadras,
 * as linhas de avenida, as travessas de lote e o leito entre as duas margens. A partição é
 * feita sobre o *índice de quadra*, nunca sobre fração do mundo, então toda costura de bairro
 * cai no meio de uma avenida: nenhum lote acorda metade em um bairro, metade no outro, e o
 * nome que se lê no canto sudoeste de um cruzamento é sempre o do lado em que se está.
 *
 * O nome vem de um baralho embaralhado pela semente do mundo e distribuído em ordem espacial
 * (oeste→leste, norte→sul). Duas consequências valem mais que a lista em si: a mesma semente
 * dá a mesma cidade para sempre — o check em memória pode cobrar o nome que a tela mostra —
 * e semente diferente dá bairros diferentes, porque "Centro" fixo em todo mapa novo seria o
 * mesmo tipo de mentira que o grid de módulos que o gerador já abandonou.
 *
 * Onde não há quadra não há bairro, e o pedido diz isso com outras palavras: é **zona**. Mata,
 * pinhal, campo, praia, savana e deserto passam pelo mesmo mecanismo com outro prefixo, porque
 * "Mata do Ipê" serve de referência exatamente como um bairro — só não finge ser cidade. O rio
 * é o terceiro caso e o único pedaço do mapa que atravessa o mundo de ponta a ponta: merece
 * nome tanto quanto a avenida que o margeia.
 */

export type EspecieDeLugar = 'bairro' | 'zona' | 'rio';

/** Um pedaço nomeado do mapa. Retângulo em tiles, `x1`/`y1` exclusivos, como todo `Rect` do gerador. */
export interface Distrito {
  id: number;
  nome: string;
  /** O nome solto, sem prefixo nem ligação: o que a tela mostra quando não cabe a frase toda. */
  apelido: string;
  biome: Biome;
  especie: EspecieDeLugar;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Onde o nome se apoia no mapa: o centro geométrico do retângulo. */
  cx: number;
  cy: number;
}

/** Uma via nomeada: o facho de asfalto de duas células, correndo ao longo de um trecho medido. */
export interface Via {
  id: number;
  nome: string;
  rank: RoadRank;
  /** `ns` corre norte-sul e ocupa colunas; `ew` corre leste-oeste e ocupa linhas. */
  eixo: 'ns' | 'ew';
  /** As duas células transversais da mão dupla: [faixa0, faixa1] inclusive. */
  faixa0: number;
  faixa1: number;
  /** O trecho que ela realmente percorre, em tiles, inclusive nas duas pontas. */
  de: number;
  ate: number;
}

export interface Lugares {
  distritos: Distrito[];
  vias: Via[];
}

/** A quadra como o gerador a planeja: índice no grid e o bioma que `regionOf` escolheu. */
export interface Quadra {
  col: number;
  row: number;
  biome: Biome;
}

/** A travessa de lote: o corredor de duas colunas que `ruaDe` decidiu asfaltar. */
export interface Travessa {
  x: number;
  y0: number;
  y1: number;
  rank: RoadRank;
  col: number;
  row: number;
}

/** O que é terra sem quadra urbana — portanto sem bairro, e sim zona. */
const BIOMAS_NATURAIS: readonly Biome[] =
  ['forest', 'countryside', 'beach', 'pinewood', 'savanna', 'desert'];

/**
 * O prefixo diz a função do lugar antes de o apelido chegar. Um apelido sozinho, solto, não
 * responde "isto é cidade?"; "Distrito Bonança" responde, e "Mata do Ipê" também.
 */
export const PREFIXO_DO_LUGAR: Record<Biome, string> = {
  downtown: 'Centro', commercial: 'Vila', market: 'Mercado', residential: 'Jardim',
  suburb: 'Bairro', park: 'Parque', industrial: 'Distrito', docks: 'Porto',
  forest: 'Mata', countryside: 'Campo', beach: 'Praia', pinewood: 'Pinhal',
  savanna: 'Savana', desert: 'Deserto',
};

/**
 * O baralho dos apelidos. Coisa vista — bicho, árvore, pedra, hora do dia, devoção — porque
 * topônimo brasileiro é isso, não série de letras. Dois e três palavras são bem-vindas: é o
 * que faz o mapa parecer habitado antes de a primeira casa aparecer na tela. Nenhum se repete,
 * e o embaralhamento pela semente decide quem ganha qual, em ordem espacial.
 */
export const APELIDOS: readonly string[] = [
  'Aurora', 'Ipê', 'Acácia', 'Jacarandá', 'Araucária', 'Eucalipto', 'Buriti', 'Mandacaru',
  'Coqueiral', 'Capim Duro', 'Pedra Branca', 'Água Limpa', 'Boa Vista', 'Vale Verde',
  'Lagoa Serena', 'Serra Alta', 'Nevoeiro', 'Ventania', 'Sol Nascente', 'Lua Cheia',
  'Sabiá', 'Garça', 'Cutia', 'Tatu', 'Onça', 'Raposa', 'Coruja', 'Jacaré', 'Capivara',
  'Bugio', 'Dourado', 'Prata', 'Cristal', 'Bonança', 'Esperança', 'Progresso', 'Horizonte',
  'Colina', 'Alegria', 'Canto Claro', 'Pau Brasil', 'Jequitibá', 'Maré Mansa', 'Campo Belo',
];

/** Avenidas carregam o nome grande da cidade: nação, herói, coisa nobre. */
export const NOMES_DAS_AVENIDAS: readonly string[] = [
  'Brasil', 'Rio Branco', 'Independência', 'das Palmeiras', 'Tiradentes', 'Marechal Deodoro',
  'Dom Pedro Segunda', 'Getúlio Vargas', 'dos Navegantes', 'da Bandeira', 'Paulista',
  'Ametista', 'do Cerrado', 'das Nações', 'dos Bandeirantes', 'Marquesa',
];

/** Ruas carregam o nome miúdo: data, santo, fruta, província. */
export const NOMES_DAS_RUAS: readonly string[] = [
  'Sete de Setembro', 'Quinze de Novembro', 'dos Andradas', 'Bahia', 'Paraíba',
  'Rui Barbosa', 'General Osório', 'Visconde de Mauá', 'Sete de Março', 'Coronel Bento',
  'Santana', 'Nazaré', 'Glória', 'Piedade', 'Rosário', 'Laranjeiras', 'Figueira',
  'Aroeira', 'do Peixe', 'Jaqueira', 'Cacau', 'Cravino',
];

/**
 * O nome das travessas de lote. Baralho separado do das ruas do grid de propósito: os dois
 * tipos de via têm de poder coexistir no mesmo mapa sem que a placa "Rua Santana" apareça em
 * duas ruas que não se encostam, e é mais honesto ter 26 nomes a mais do que um número a mais
 * no meio de um nome.
 */
export const NOMES_DAS_TRAVESSAS: readonly string[] = [
  'Santa Rita', 'São José', 'Santo Antônio', 'Santa Luzia', 'Cruzeiro', 'Jambeiro',
  'Cambuci', 'Pitangueira', 'Araçá', 'Ingazeiro', 'Umburana', 'Serrinha', 'Poção',
  'Lajeado', 'Duna', 'Beija-flor', 'Andorinha', 'Siri', 'Ferradura', 'Algodão',
  'Cana Verde', 'Pimenta', 'Dália', 'Manacá', 'Carnaúba', 'Gavião',
];

/** O que se acrescenta quando o baralho acaba — nunca um número solto no meio de um nome. */
const SUFIXOS: readonly string[] =
  ['do Norte', 'do Sul', 'do Leste', 'do Oeste', 'de Cima', 'de Baixo'];

/** Três quadras de lado para a cidade, quatro para a terra vazia: o bairro tem de ser legível no radar. */
const LARGURA_DO_BAIRRO = 3;
const LARGURA_DA_ZONA = 4;

/** O posto que manda quando duas vias se encontram no mesmo cruzamento. */
const PRIORIDADE_DO_POSTO: Record<RoadRank, number> = {
  highway: 0, avenue: 1, street: 2, residential: 3, access: 4,
};

function natural(biome: Biome): boolean {
  return BIOMAS_NATURAIS.includes(biome);
}

function embaralha<T>(itens: readonly T[], rng: () => number): T[] {
  const out = itens.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * O nome da vez, com escape determinístico. Enquanto houver baralho, o nome é só ele; depois
 * vem o ponto cardeal, e só quando os dois acabam entra o índice — é o único jeito de o
 * contrato "nenhum nome se repete no mapa" valer em qualquer gerador, inclusive um que um dia
 * quadrisse o grid.
 */
function nomeDaLista(baralho: readonly string[], i: number, id: number): string {
  const base = baralho[i % baralho.length];
  const volta = Math.floor(i / baralho.length);
  if (volta === 0) return base;
  const sufixo = SUFIXOS[(volta - 1) % SUFIXOS.length];
  const outraVolta = Math.floor((volta - 1) / SUFIXOS.length);
  return outraVolta === 0 ? `${base} ${sufixo}` : `${base} ${sufixo} ${id + 1}`;
}

/**
 * 'do' ou 'da' conforme o apelido. Não é gramática completa nem tabela de gênero: é a regra
 * que o português real sustenta — palavra terminada em `a` pede `da` — e ela acerta em cheio
 * até nos acentuados ("Mata do Jacarandá", "Mata da Jacarandá" seria o erro). Só as zonas
 * usam; bairro vai de nome seco, como "Jardim Aurora".
 */
function ligação(apelido: string): string {
  return apelido.endsWith('a') ? 'da' : 'do';
}

/** O nome completo do distrito, com o prefixo da sua espécie. */
export function nomeDoDistrito(biome: Biome, apelido: string): string {
  const prefixo = PREFIXO_DO_LUGAR[biome];
  return natural(biome) ? `${prefixo} ${ligação(apelido)} ${apelido}` : `${prefixo} ${apelido}`;
}

export interface Partição {
  distritos: Distrito[];
  /** Índice da partição: `col,row` → distrito. É como a travessa sabe de que bairro ela é. */
  porQuadra: Map<string, number>;
}

/**
 * A partição. Varre o grid em ordem espacial e, de cada quadra ainda livre, faz o maior
 * retângulo de até `cap` por `cap` que caiba inteirinho num único bioma. Retângulo e não
 * mancha porque retângulo é o que se pode desenhar, consultar e provar: borda em avenida,
 * área sem buraco, nome apoiado no próprio centro.
 *
 * A costura entre dois distritos vizinhos corta o facho da avenida ao meio — a célula mais a
 * oeste (ou mais ao norte) fica com o bairro de antes, a segunda com o de depois. Sem isso
 * haveria tile de asfalto sem dono, e "nenhum tile do mapa sem lugar" é o contrato.
 *
 * A única linha de quadras que não existe é a do rio, e ela não deixa buraco: as duas fileiras
 * encostadas nele ficam com o facho inteiro da própria margem, e o que sobra entre os dois
 * fachos é o leito, que vira distrito do tipo `rio` na mão de quem chama.
 */
export function distritosDasQuadras(quadras: readonly Quadra[], xs: readonly number[],
  ys: readonly number[], W: number, H: number, rng: () => number,
  leito?: { x0: number; y0: number; x1: number; y1: number }): Partição {
  const colunas = xs.length - 1;
  const linhas = ys.length - 1;
  const fileiraDoRio = Math.floor(linhas / 2);
  const bioma = new Map<string, Biome>();
  for (const q of quadras) bioma.set(`${q.col},${q.row}`, q.biome);

  const porQuadra = new Map<string, number>();
  const distritos: Distrito[] = [];
  const baralho = embaralha(APELIDOS, rng);
  const livre = (col: number, row: number, b: Biome) =>
    bioma.get(`${col},${row}`) === b && !porQuadra.has(`${col},${row}`);

  for (let row = 0; row < linhas; row++) {
    for (let col = 0; col < colunas; col++) {
      const b = bioma.get(`${col},${row}`);
      if (!b || porQuadra.has(`${col},${row}`)) continue;
      const cap = natural(b) ? LARGURA_DA_ZONA : LARGURA_DO_BAIRRO;
      let c1 = col;
      while (c1 + 1 < colunas && c1 - col + 1 < cap && livre(c1 + 1, row, b)) c1++;
      let r1 = row;
      while (r1 - row + 1 < cap) {
        let inteira = true;
        for (let c = col; c <= c1; c++) if (!livre(c, r1 + 1, b)) { inteira = false; break; }
        if (!inteira) break;
        r1++;
      }
      const id = distritos.length;
      for (let r = row; r <= r1; r++) {
        for (let c = col; c <= c1; c++) porQuadra.set(`${c},${r}`, id);
      }
      const acimaFechado = row - 1 === fileiraDoRio;
      const abaixoFechado = r1 + 1 === fileiraDoRio;
      const x0 = col === 0 ? 0 : xs[col] + 1;
      const x1 = c1 === colunas - 1 ? W : xs[c1 + 1] + 1;
      const y0 = row === 0 ? 0 : (acimaFechado ? ys[row] : ys[row] + 1);
      const y1 = r1 === linhas - 1 ? H : (abaixoFechado ? ys[r1 + 1] + 2 : ys[r1 + 1] + 1);
      const apelido = nomeDaLista(baralho, id, id);
      distritos.push({
        id, apelido, nome: nomeDoDistrito(b, apelido), biome: b,
        especie: natural(b) ? 'zona' : 'bairro',
        x0, y0, x1, y1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2,
      });
    }
  }
  // O leito entra por último e com o nome que sobrou do mesmo baralho: é o único lugar do
  // mapa que não é quadra de ninguém, e nome repetido com o bairro da margem seria o rio
  // brigar com a própria beira.
  if (leito) {
    const id = distritos.length;
    distritos.push(distritoDoRio(id, leito, nomeDaLista(baralho, id, id)));
  }
  return { distritos, porQuadra };
}

/**
 * O rio, do leito a leito, entre os dois fachos de margem. `biome` é `docks` porque a grade não
 * tem bioma de água e o campo é obrigatório — o que lê a espécie nunca lê o bioma daqui, e
 * trocar isso por um falso `forest` faria o leito aparecer como mata no instrumento errado.
 */
export function distritoDoRio(id: number, leito: { x0: number; y0: number; x1: number; y1: number },
  apelido: string): Distrito {
  const nome = `Rio ${apelido}`;
  return { id, nome, apelido, biome: 'docks', especie: 'rio',
    x0: leito.x0, y0: leito.y0, x1: leito.x1, y1: leito.y1,
    cx: (leito.x0 + leito.x1) / 2, cy: (leito.y0 + leito.y1) / 2 };
}

/** As duas células do facho de uma linha, em índice de tile, com o canto do mapa respeitado. */
function célula(tiles: readonly { kind: string }[], W: number, H: number, eixo: 'ns' | 'ew',
  transversal: number, aoLong: number): boolean {
  const prim = eixo === 'ns' ? aoLong * W + transversal : transversal * W + aoLong;
  const seg = eixo === 'ns'
    ? (transversal + 1 < W ? prim + 1 : -1)
    : (transversal + 1 < H ? prim + W : -1);
  return tiles[prim]?.kind === 'road'
    || (seg >= 0 && tiles[seg]?.kind === 'road');
}

/**
 * O asfalto da linha medido no próprio mapa, não numa lista de coordenadas: caminha pelo
 * facho e corta onde o road acaba. É isso que faz uma avenida sem ponte sobre o rio virar duas
 * vias homônimas — norte e sul — em vez de uma que promete asfalto onde há água.
 */
function trechosDoFacho(tiles: readonly { kind: string }[], W: number, H: number,
  eixo: 'ns' | 'ew', linha: number): [number, number][] {
  const comprimento = eixo === 'ns' ? H : W;
  const runs: [number, number][] = [];
  let aberto = -1;
  for (let i = 0; i < comprimento; i++) {
    const r = célula(tiles, W, H, eixo, linha, i);
    if (r && aberto < 0) aberto = i;
    if (!r && aberto >= 0) {
      if (i - aberto >= 4) runs.push([aberto, i - 1]);
      aberto = -1;
    }
  }
  if (aberto >= 0 && comprimento - aberto >= 4) runs.push([aberto, comprimento - 1]);
  return runs;
}

/** O posto da linha é o mais alto que o seu próprio asfalto carrega — aqui só se lê o que o gerador carimbou. */
function postoDoFacho(tiles: readonly { kind: string; rank?: RoadRank }[], W: number, H: number,
  eixo: 'ns' | 'ew', linha: number): RoadRank {
  let melhor: RoadRank = 'avenue';
  let visto = false;
  const comprimento = eixo === 'ns' ? H : W;
  for (let i = 0; i < comprimento; i++) {
    const t = tiles[eixo === 'ns' ? i * W + linha : linha * W + i];
    if (t?.kind !== 'road' || !t.rank) continue;
    if (!visto || PRIORIDADE_DO_POSTO[t.rank] < PRIORIDADE_DO_POSTO[melhor]) {
      melhor = t.rank;
      visto = true;
    }
  }
  return melhor;
}

/**
 * As linhas do grid: cada coluna vira avenida, cada linha vira rua — a convenção de cidade
 * brasileira que faz o jogador saber em que eixo anda só de ler o letreiro. As duas margens do
 * rio perdem o baralho e ganham nome próprio, porque "Avenida Beira-Rio" ensina mais do que
 * "Avenida Prata" para a mesma rua em dois mapas.
 */
export function viasDoGrid(tiles: readonly { kind: string; rank?: RoadRank }[], W: number, H: number,
  xs: readonly number[], ys: readonly number[], margens: readonly number[],
  rng: () => number): Via[] {
  const vias: Via[] = [];
  const avenidas = embaralha(NOMES_DAS_AVENIDAS, rng);
  const ruas = embaralha(NOMES_DAS_RUAS, rng);
  let usadasA = 0;
  let usadasR = 0;

  const push = (eixo: 'ns' | 'ew', linha: number, nome: string) => {
    const rank = postoDoFacho(tiles, W, H, eixo, linha);
    for (const [de, ate] of trechosDoFacho(tiles, W, H, eixo, linha)) {
      vias.push({ id: vias.length, nome, rank, eixo, faixa0: linha, faixa1: linha + 1, de, ate });
    }
  };

  for (const x of xs) push('ns', x, `Avenida ${nomeDaLista(avenidas, usadasA++, vias.length)}`);
  for (let i = 0; i < ys.length; i++) {
    const y = ys[i];
    const margem = margens.indexOf(y);
    push('ew', y, margem >= 0
      ? `Avenida Beira-Rio ${margem === 0 ? 'Norte' : 'Sul'}`
      : `Rua ${nomeDaLista(ruas, usadasR++, vias.length)}`);
  }
  return vias;
}

/**
 * As travessas de lote: o corredor de duas colunas que serpenteia por dentro do quarteirão e
 * é a única rua que quem mora no lote realmente usa.
 *
 * A regra que manda aqui é uma só: **um corredor, uma placa.** O nome é do corredor (a banda de
 * colunas), não do bairro, e por isso ele atravessa dois ou três bairros sem trocar de letreiro
 * — como toda rua verdadeira. O contrário também vale e é o que faz a regra existir: dois
 * corredores paralelos dentro do mesmo bairro não podem ter a mesma placa, e nomear a travessa
 * pelo apelido do bairro produzia exatamente isso, um "Rua Aurora" em cada terceira rua do
 * Jardim Aurora.
 *
 * O trecho, esse sim, é medido no asfalto: duas travessas encostadas do mesmo corredor, com a
 * boca do cruzamento no meio, são a mesma rua e viram uma única `Via`, com o trecho emendado.
 * Quando o corredor tem um vão de verdade (uma praça, um lote sem rua), a mesma placa reaparece
 * noutro trecho — e o check abaixo do mapa é quem prova que uma placa nunca saltou de corredor.
 */
export function viasDasTravessas(travessas: readonly Travessa[], distritos: readonly Distrito[],
  porQuadra: ReadonlyMap<string, number>, rng: () => number): Via[] {
  const baralho = embaralha(NOMES_DAS_TRAVESSAS, rng);
  const fora: Via[] = [];
  const abertas = new Map<number, Via>();
  const nomes = new Map<number, string>();
  // Ordem oeste→leste decide quem ganha qual nome, e o corredor só é contado uma vez: o
  // segundo trecho do mesmo corredor herda a placa do primeiro, não pesca outro nome.
  const ordenadas = travessas.slice().sort((a, b) => (a.x - b.x) || (a.y0 - b.y0));
  for (const t of ordenadas) {
    const id = porQuadra.get(`${t.col},${t.row}`);
    const dono = id === undefined ? undefined : distritos[id];
    if (!dono || dono.especie !== 'bairro') continue;
    const anterior = abertas.get(t.x);
    // `y1` é exclusivo e a avenida do meio come dois tiles: o vizinho encosta em `ate + 3`.
    if (anterior && anterior.rank === t.rank && t.y0 === anterior.ate + 3) {
      anterior.ate = t.y1 - 1;
      continue;
    }
    if (!nomes.has(t.x)) nomes.set(t.x, `Rua ${nomeDaLista(baralho, nomes.size, nomes.size)}`);
    const via: Via = { id: fora.length, nome: nomes.get(t.x)!, rank: t.rank, eixo: 'ns',
      faixa0: t.x, faixa1: t.x + 1, de: t.y0, ate: t.y1 - 1 };
    abertas.set(t.x, via);
    fora.push(via);
  }
  return fora;
}

/** O distrito que pisa este tile. Os retângulos são disjoint por construção, então a primeira resposta é a única. */
export function distritoEm(lugares: Lugares, tx: number, ty: number): Distrito | null {
  const x = Math.floor(tx);
  const y = Math.floor(ty);
  for (const d of lugares.distritos) {
    if (x >= d.x0 && x < d.x1 && y >= d.y0 && y < d.y1) return d;
  }
  return null;
}

/**
 * A via deste tile. Num cruzamento duas faixas se sobrepõem de propósito — é ali que as duas
 * ruas se conhecem — e a que manda é a de posto mais alto, que é a que o motorista usa para se
 * situar. Desempate por id, nunca por ordem de `Map`: o mesmo tile tem de dar o mesmo nome em
 * qualquer chamada, senão o HUD piscaria entre duas ruas a cada quadro.
 */
export function viaEm(lugares: Lugares, tx: number, ty: number): Via | null {
  const x = Math.floor(tx);
  const y = Math.floor(ty);
  let achada: Via | null = null;
  for (const v of lugares.vias) {
    const naFaixa = v.eixo === 'ns'
      ? x >= v.faixa0 && x <= v.faixa1
      : y >= v.faixa0 && y <= v.faixa1;
    if (!naFaixa) continue;
    const noTrecho = v.eixo === 'ns' ? y >= v.de && y <= v.ate : x >= v.de && x <= v.ate;
    if (!noTrecho) continue;
    if (!achada || PRIORIDADE_DO_POSTO[v.rank] < PRIORIDADE_DO_POSTO[achada.rank]) achada = v;
  }
  return achada;
}

/** A frase que a tela mostra: o bairro primeiro, porque é a resposta de "onde"; a rua depois. */
export function fraseDoLugar(distrito: Distrito | null, via: Via | null): string {
  if (!distrito) return via ? via.nome : '';
  return via ? `${distrito.nome} · ${via.nome}` : distrito.nome;
}
