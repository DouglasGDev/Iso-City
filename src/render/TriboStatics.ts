import { depthOf, worldToScreen } from '../world/IsoUtils';
import { chaveDoTile } from '../world/Frontier';
import { CÉLULA_DA_TRIBO, acampamentoDaCélula, type Acampamento } from '../world/Tribo';
import { PÉ, RAIO_DE_PIXEL } from './TriboSprite';
import type { GameState } from '../game/GameState';

/**
 * O acampamento entra na MESMA fila de desenho da mata e da cidade.
 *
 * Não é arrumação: é o contrato isométrico, o mesmo que já fez as árvores da fronteira nascerem
 * como `StaticNode` em vez de camada própria. Uma cabana desenhada numa camada antes de
 * `SortedWorldLayer` estaria sempre atrás do jogador, e a cena que este lugar existe para dar —
 * alguém andando pelo meio do anel, entrando pela boca, passando entre a fogueira e a casa grande
 * — é exatamente a que uma camada fixa não consegue desenhar. Quem fica atrás do telhado tem de
 * ser tapado pelo telhado, e só a profundidade faz isso.
 *
 * O que a tribo acrescenta ao quadro é nó, não caminho de código: o recorte da neblina, a ordenação
 * e o `<Group>` que desenha já existem. A diferença é que aqui o "sprite" é um `<Path>` autor, como
 * o do gigante e o do peixe, e por isso o nó não carrega imagem nem espera fila de carregamento —
 * ele carrega a decisão da geometria (planta, porta, espelho, escala) e a arte vem dela.
 *
 * **A escala é o contrato com o colisor.** `escala = raio · RAIO_DE_PIXEL / PÉ[tipo]` faz a
 * largura desenhada do pé valer exatamente o diâmetro do pino que `empurraDoAcampamento` usa,
 * porque um círculo de raio `raio` em coordenada de tile projeta-se em uma elipse de semieixo-X
 * `raio·64·√2`. Não é coincidência verificável depois: é a única conta que existe entre os dois, e
 * o check corta a palavra para mostrar que a parede pintada é a parede em que se bate.
 *
 * O cache por acampamento existe pelo mesmo motivo do `FrontierStaticCache`: o sprite é `memo` pela
 * identidade do objeto. Reconstruir os nós a cada varredura de 8 Hz jogaria fora o memo e
 * re-renderizaria a aldeia inteira enquanto a câmera andasse.
 */

/** Meio-de-mundo de um osso: tamanho de arte, não de corpo — nada barra um osso. */
const MEIO_DO_OSSO = 0.3;

/**
 * As cinco formas que moram numa clareira. A lista é daqui, e não da arte, porque é a geometria
 * que decide o que existe no mundo; `TriboSprite` pede o nome de volta para tipar a paleta, a
 * caixa e o dispatch. É a única direção que os dois módulos se enxergam em tempo de execução: o
 * import do lado da arte é `import type` e desaparece na transpilação, então quem depende de quem
 * só existe no tipador.
 */
export type TriboTipo = 'cabana' | 'totem' | 'fogueira' | 'osso' | 'poste';

export interface TriboNode {
  /** Estável e único no mundo: a chave da célula mais a peça. É a chave React e o desempate da ordenação. */
  id: string;
  tipo: TriboTipo;
  /** Projeção do pé: o ponto do mundo onde o corpo pisa, já com a cota contínua. */
  sx: number;
  sy: number;
  /** Multiplicador do quadro autado, derivado do raio do pino — ver o comentário do módulo. */
  escala: number;
  /** Planta da cabana (0..2) ou variação do osso. Ignorado pelos outros tipos. */
  planta: number;
  /** A face virada para a câmera mostra o vão; a de costas mostra o couro estendido. */
  away: boolean;
  /** Espelhar no eixo X de tela = girar o corpo 90° no mundo. Toda tinta é par, só o vão não é. */
  espelha: boolean;
  depth: number;
}

/**
 * O corpo de um pino do acampamento em nós de tela. `meio` é a semilargura do mundo: o raio do
 * pino para o que barra, um tamanho de arte para o que não barra.
 */
function nó(ac: Acampamento, tipo: TriboTipo, x: number, y: number, meio: number,
  suffix: string, game: GameState, planta = 0, normalX = 0, normalY = 0): TriboNode {
  const h = game.map.heightSmoothAt(x, y);
  const p = worldToScreen(x, y, h);
  return {
    id: `tribo:${ac.id}:${suffix}`,
    tipo,
    sx: p.x,
    sy: p.y,
    escala: meio * RAIO_DE_PIXEL / PÉ[tipo],
    planta,
    // A frente de um corpo em iso é a metade do arco que desce na tela: uma normal (nx, ny) volta-se
    // para a câmera quando `nx + ny > 0`, e cai para o lado esquerdo quando `nx - ny < 0`. É a mesma
    // conta que faz a fera mostrar as costas quando anda para NE, e é por isso que mora aqui, na
    // geometria, e não num `if` dentro do `<Group>`.
    away: normalX + normalY <= 0,
    espelha: normalX - normalY < 0,
    depth: depthOf(x, y, h),
  };
}

/**
 * Os nós de um acampamento: as cabanas do anel, o totem da boca, a fogueira do centro, o poste da
 * amarra e os ossos espalhados. São exatamente os corpos que `pinosDoAcampamento` barra, e por dois
 * motivos que são o mesmo: quem desenha lê `ac.cabanas`, `ac.totem`, `ac.fogueira`, `ac.poste` e
 * `ac.ossos` da função, e o que
 * barra lê a mesma lista pela mesma função de coordenada. Uma casa desenhada sem pino seria um
 * cenário atravessável, e um pino sem casa seria uma parede invisível — as duas coisas são o mesmo
 * bug, e este arquivo é o único lugar onde ele poderia nascer.
 *
 * A porta de cada casa olha para a fogueira. Não é decoro: é o que faz um anel de formas ler como
 * um lugar construído por gente que combinou de morar junto, e é a mesma conta que faz o totem
 * apontar de volta para a cidade.
 */
function buildAcampamento(game: GameState, cx: number, cy: number): TriboNode[] | null {
  const { worldW: W, worldH: H } = game.map;
  const ac = acampamentoDaCélula(cx, cy, W, H, game.map);
  if (!ac) return null;
  const nós: TriboNode[] = [];
  for (let i = 0; i < ac.cabanas.length; i++) {
    const caba = ac.cabanas[i];
    // A normal da porta é o vetor da casa para o centro do lugar, em coordenada de mundo.
    nós.push(nó(ac, 'cabana', caba.x, caba.y, caba.raio, `cabana:${i}`, game,
      caba.planta, ac.x - caba.x, ac.y - caba.y));
  }
  if (ac.totem) {
    nós.push(nó(ac, 'totem', ac.totem.x, ac.totem.y, ac.totem.raio, 'totem', game, 0,
      ac.rumo.x, ac.rumo.y));
  }
  nós.push(nó(ac, 'fogueira', ac.fogueira.x, ac.fogueira.y, ac.fogueira.raio, 'fogueira', game));
  // A porta do poste olha para a fogueira pela mesma conta das cabanas: quem está amarrado é
  // mostrado ao lugar, e o lugar inteiro vê as costas de quem se debate. É a única forma do anel
  // que existe para ser encarada — a corda só aparece no quadro da frente.
  nós.push(nó(ac, 'poste', ac.poste.x, ac.poste.y, ac.poste.raio, 'poste', game, 0,
    ac.x - ac.poste.x, ac.y - ac.poste.y));
  for (let i = 0; i < ac.ossos.length; i++) {
    const osso = ac.ossos[i];
    // O osso não barra ninguém: ele é o que diz que aqui se comeu, e um corpo invisível no chão
    // seria pior que nenhum corpo. O tamanho é o da arte, e a orientação vem de onde ele jaz na
    // clareira — um osso a oeste do centro espelhado, um a leste não. É a mesma conta das cabanas,
    // aplicada ao chão, e por isso o lugar tem duas metades desiguais sem um hash novo.
    nós.push(nó(ac, 'osso', osso.x, osso.y, MEIO_DO_OSSO, `osso:${i}`, game, i % 3,
      osso.x - ac.x, osso.y - ac.y));
  }
  return nós;
}

class TriboStaticCache {
  private acampamentos = new Map<number, TriboNode[]>();
  private out: TriboNode[] = [];

  /**
   * Quantos acampamentos e nós estão residentes. Medido pela mesma razão do
   * `frontierCacheStats`: o que o check cobra não é "a aldeia apareceu", é "a aldeia apareceu,
   * tinha o número certo de cabanas e foi embora quando a câmera voltou para a cidade".
   */
  stats(): { acampamentos: number; nós: number } {
    let nós = 0;
    for (const nodes of this.acampamentos.values()) nós += nodes.length;
    return { acampamentos: this.acampamentos.size, nós };
  }

  /**
   * Nós dos acampamentos das células que caem na janela da neblina. A clareira nunca sai da
   * própria célula (é a invariante do `RECUO_DA_CÉLULA` no `Tribo`), então a varredura é a grade
   * de células da janela e nada mais: nem vizinhança 3×3, nem lista de aldeias do mundo — que é
   * infinita.
   */
  collect(game: GameState): TriboNode[] {
    const out = this.out;
    out.length = 0;
    const view = game.fog.view(game);
    const aabb = game.fog.worldBounds(view);
    if (!Number.isFinite(aabb.minX)) return out;
    const cx0 = Math.floor(aabb.minX / CÉLULA_DA_TRIBO);
    const cx1 = Math.floor(aabb.maxX / CÉLULA_DA_TRIBO);
    const cy0 = Math.floor(aabb.minY / CÉLULA_DA_TRIBO);
    const cy1 = Math.floor(aabb.maxY / CÉLULA_DA_TRIBO);
    const necessárias = new Set<number>();
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        // Célula inteira dentro da grade nunca é território deles: `densidadeDoTerritório` devolve
        // zero lá, e varrer a hash para descobrir isso seria a cidade pagar por uma aldeia que não
        // está no mapa. O corte é o mesmo do bloco de mata.
        if ((cx + 1) * CÉLULA_DA_TRIBO <= game.map.worldW && cx * CÉLULA_DA_TRIBO >= 0
          && (cy + 1) * CÉLULA_DA_TRIBO <= game.map.worldH && cy * CÉLULA_DA_TRIBO >= 0) continue;
        const chave = chaveDoTile(cx, cy);
        necessárias.add(chave);
        let nós = this.acampamentos.get(chave);
        if (nós === undefined) {
          nós = buildAcampamento(game, cx, cy) ?? [];
          this.acampamentos.set(chave, nós);
        }
        for (const n of nós) out.push(n);
      }
    }
    // Soltar o que saiu da janela: na web isto é memória de verdade, e a aldeia ficou para trás.
    for (const chave of Array.from(this.acampamentos.keys())) {
      if (!necessárias.has(chave)) this.acampamentos.delete(chave);
    }
    return out;
  }
}

const caches = new WeakMap<GameState, TriboStaticCache>();

/** Um cache por partida, a mesma regra do chunk e da mata: morre com o `GameState` dono do mundo. */
export function triboNodesFor(game: GameState): TriboNode[] {
  let cache = caches.get(game);
  if (!cache) caches.set(game, cache = new TriboStaticCache());
  return cache.collect(game);
}

export function triboCacheStats(game: GameState): { acampamentos: number; nós: number } {
  return caches.get(game)?.stats() ?? { acampamentos: 0, nós: 0 };
}
