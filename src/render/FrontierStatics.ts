import { isUsableAsset, propKey } from '../assets/AssetRegistry';
import { spriteStore } from '../assets/SpriteStore';
import { solicitarSprite } from '../assets/SpriteRequests';
import { depthOf, worldToScreen } from '../world/IsoUtils';
import { árvoreDoTile, chaveDoTile } from '../world/Frontier';
import type { GameState } from '../game/GameState';
import type { StaticNode } from './ChunkStatics';

/**
 * As árvores da fronteira entram na MESMA fila de desenho da cidade.
 *
 * Não é capricho de organização: é o contrato isométrico. Um tronco desenhado numa camada
 * própria, antes ou depois de `SortedWorldLayer`, estaria sempre na frente ou sempre atrás do
 * jogador. Na mata isso é exatamente o que o olho denuncia — quem anda entre duas pinheiras
 * precisa ser tapado pela que está mais perto da câmera, e uma camada fixa nunca taparia.
 *
 * Aqui eles nascem como `StaticNode`, o mesmo formato que o chunk do asfalto devolve, então o
 * laço de recorte, a ordenação por profundidade e o `<StaticSprite>` que desenha são os que já
 * existem. O que a fronteira acrescenta ao quadro é nó, não caminho de código.
 *
 * O cache por bloco existe pelo mesmo motivo do `ChunkStaticCache`: o `StaticSprite` é `memo`
 * pela identidade do objeto. Reconstruir os nós a cada passada de descarte jogaria fora o memo
 * e re-renderizaria a mata inteira a cada meio tile de câmera.
 */

/** Lado do bloco de cache, em tiles: o pedaço de mata que entra e sai da tela junto. */
const LADO_DO_BLOCO = 8;

/**
 * Os nós de um bloco, ou `null` quando algum sprite dele ainda está na fila. A mesma regra do
 * chunk: adiar é mais certo do que assar metade e ficar com um tronco invisível para sempre,
 * porque o cache nunca refaz um bloco que já existe.
 */
function buildBloco(game: GameState, bx: number, by: number): StaticNode[] | null {
  const { worldW: W, worldH: H } = game.map;
  const nodes: StaticNode[] = [];
  let adiada = false;
  for (let ty = by * LADO_DO_BLOCO; ty < (by + 1) * LADO_DO_BLOCO; ty++) {
    for (let tx = bx * LADO_DO_BLOCO; tx < (bx + 1) * LADO_DO_BLOCO; tx++) {
      // A MESMA chamada que barra o passo do jogador: a copa desenhada, o tronco que empurra e
      // o chão sob ele são três leituras de uma única função da coordenada.
      const árvore = árvoreDoTile(tx, ty, W, H, game.map);
      if (!árvore) continue;
      const chave = propKey(árvore.chave);
      const img = spriteStore[chave];
      if (img === undefined) {
        // O que não está no catálogo nunca vem; esperar por ele deixaria o bloco inteiro
        // ausente. É o filtro de usáveis que já corta o arquivo quebrado na cidade.
        if (isUsableAsset(chave)) {
          solicitarSprite(chave);
          adiada = true;
        }
        continue;
      }
      // `null` é o que foi pedido e falhou: essa árvore fica de fora sem adiar o bloco, do
      // contrário um PNG quebrado no catálogo deixaria a mata inteira do lado de fora invisível.
      if (!img) continue;
      // O pé pisa a cota contínua, a mesma sob os pés de quem anda: `heightSmoothAt` satura na
      // coluna da borda, então a árvore do lado de fora se apoia exatamente no mesmo canto que
      // o tile vizinho de dentro — a emenda entre a cidade e a mata não tem degrau.
      const h = game.map.heightSmoothAt(árvore.x, árvore.y);
      const p = worldToScreen(árvore.x, árvore.y, h);
      const w = img.width() * árvore.escala;
      const altura = img.height() * árvore.escala;
      // Âncora centro/base, o padrão dos props do gerador quando `renderAnchor` não existe:
      // o pé no ponto do mundo e a copa subindo pela tela. Assim a mata de fora assenta igual
      // à de dentro.
      nodes.push({ id: `frontier:${chaveDoTile(tx, ty)}`, img,
        sx: p.x, sy: p.y, w, h: altura, depth: depthOf(árvore.x, árvore.y, h) });
    }
  }
  return adiada ? null : nodes;
}

class FrontierStaticCache {
  private blocos = new Map<number, StaticNode[]>();
  private out: StaticNode[] = [];

  /**
   * Quantos blocos e nós estão residentes. Medido pela mesma razão do `streaming.stats`:
   * o que o check cobra não é "a mata apareceu", é "a mata apareceu e foi embora quando a
   * câmera voltou para a cidade" — sem esta leitura, liberar o bloco errado seria invisível.
   */
  stats(): { blocos: number; nos: number } {
    let nos = 0;
    for (const nodes of this.blocos.values()) nos += nodes.length;
    return { blocos: this.blocos.size, nos };
  }

  /**
   * Nós das árvores dos blocos que cobrem a janela da neblina. O array devolvido é sempre o
   * mesmo, esvaziado na hora: a passada de descarte roda a 8 Hz e não pode nascer um objeto
   * por varredura.
   */
  collect(game: GameState): StaticNode[] {
    const out = this.out;
    out.length = 0;
    const { worldW: W, worldH: H } = game.map;
    const view = game.fog.view(game);
    const aabb = game.fog.worldBounds(view);
    const bx0 = Math.floor(aabb.minX / LADO_DO_BLOCO);
    const bx1 = Math.floor((aabb.maxX + 1) / LADO_DO_BLOCO);
    const by0 = Math.floor(aabb.minY / LADO_DO_BLOCO);
    const by1 = Math.floor((aabb.maxY + 1) / LADO_DO_BLOCO);
    const needed = new Set<number>();
    for (let by = by0; by <= by1; by++) {
      for (let bx = bx0; bx <= bx1; bx++) {
        // Bloco inteiro dentro da grade não é mata: `árvoreDoTile` devolve `null` em cada tile
        // dele, e varrer 64 hashes para descobrir isso seria a cidade pagar pela floresta que
        // não está lá — o mesmo princípio que tira o tronco do passo de quem anda na rua.
        if (bx * LADO_DO_BLOCO >= 0 && by * LADO_DO_BLOCO >= 0
          && (bx + 1) * LADO_DO_BLOCO <= W && (by + 1) * LADO_DO_BLOCO <= H) continue;
        const chave = chaveDoTile(bx, by);
        needed.add(chave);
        let nodes = this.blocos.get(chave);
        if (!nodes) {
          nodes = buildBloco(game, bx, by) ?? undefined;
          if (nodes) this.blocos.set(chave, nodes);
        }
        if (nodes) for (const node of nodes) out.push(node);
      }
    }
    // Soltar o que saiu da janela: na web isto é memória de verdade, e o bloco vazio de uma
    // mata que ficou para trás não tem de caminhar com o jogador até o outro lado do mundo.
    for (const chave of Array.from(this.blocos.keys())) {
      if (!needed.has(chave)) this.blocos.delete(chave);
    }
    return out;
  }
}

const caches = new WeakMap<GameState, FrontierStaticCache>();

/** Um cache por partida, a mesma regra do chunk: morre com o `GameState` dono do mundo. */
export function frontierNodesFor(game: GameState): StaticNode[] {
  let cache = caches.get(game);
  if (!cache) caches.set(game, cache = new FrontierStaticCache());
  return cache.collect(game);
}

export function frontierCacheStats(game: GameState): { blocos: number; nos: number } {
  return caches.get(game)?.stats() ?? { blocos: 0, nos: 0 };
}
