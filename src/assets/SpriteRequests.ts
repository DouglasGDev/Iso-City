import { spriteStore } from './SpriteStore';

/**
 * O que a cena olhou e não achou.
 *
 * A fila do `SpriteProvider` é estática: ela sabe que o chão vem antes do personagem e o
 * personagem antes da arma, mas não sabe QUAIS prédios estão diante da câmera nesta rua. É
 * aqui que o desenho devolve a informação — e é por isso que um chunk pode adiar o próprio
 * bake sem medo: o sprite que falta não vai chegar na volta do carrossel, vai chegar agora.
 */
const demandas = new Set<string>();

/** Avisar que um arquivo falta. Idempotente e barato o bastante para chamar a cada passada. */
export function solicitarSprite(key: string): void {
  demandas.add(key);
}

/**
 * Tomar até `n` demandas que ainda não chegaram, na ordem em que nasceram. O teto é o lote em
 * voo: sem ele, a cidade inteira pediria os 543 arquivos de uma vez e a fila voltaria a ser
 * debandada — que é exatamente o gargalo que este módulo veio tirar do caminho.
 */
export function promoverDemandas(n: number): string[] {
  if (n <= 0) return [];
  const tomadas: string[] = [];
  for (const key of demandas) {
    demandas.delete(key);
    // `undefined` é o que ainda não foi pedido; `null` é o que foi pedido e falhou. Só o
    // primeiro cabe numa vaga do lote — pedir de novo o arquivo quebrado ocuparia a vaga para
    // sempre e empurraria para trás o pedido que a câmera realmente precisa.
    if (spriteStore[key] !== undefined) continue;
    tomadas.push(key);
    if (tomadas.length >= n) break;
  }
  return tomadas;
}
