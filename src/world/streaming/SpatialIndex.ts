import { GAME_CONFIG } from '../../game/GameConfig';
import type { WorldRect } from './ChunkIndex';

/**
 * O que se move. Os prédios têm índice próprio (`ChunkIndex`), porque nascem no
 * gerador e nunca mudam; pedestre, carro, bicho e destroço mudam de tile a cada tick,
 * então a resposta deles precisa ser reconstruída — e é justamente por isso que a
 * reconstrução tem que ser barata e não pode alocar.
 */
export type IndexedKind = 'npc' | 'veh' | 'animal' | 'wreck';
const KINDS: IndexedKind[] = ['npc', 'veh', 'animal', 'wreck'];

/**
 * Grade de baldes do tamanho de um chunk, populada uma vez por tick pelo `GameLoop`.
 *
 * O contrato de quem consome: `query` devolve um buffer emprestado do próprio índice,
 * válido até a próxima consulta do MESMO tipo. É o preço de não criar array novo a cada
 * leitura — com 60 ticks por segundo, quatro consultas por tick e um array de dezenas de
 * índices em cada uma, a alocação vira trabalho para o coletor no meio do frame, que é
 * exatamente o que a spec §15 pede para não fazer.
 */
export class SpatialIndex {
  readonly cell = GAME_CONFIG.CHUNK_SIZE;
  readonly cols: number;
  readonly rows: number;
  private buckets = new Map<IndexedKind, number[][]>();
  private out = new Map<IndexedKind, number[]>();
  /** Total inserido no último tick, por tipo: é o "quantos existem" da métrica. */
  readonly totals: Record<IndexedKind, number> = { npc: 0, veh: 0, animal: 0, wreck: 0 };

  constructor(worldW: number, worldH: number) {
    this.cols = Math.max(1, Math.ceil(worldW / this.cell));
    this.rows = Math.max(1, Math.ceil(worldH / this.cell));
    const cells = this.cols * this.rows;
    for (const kind of KINDS) {
      this.buckets.set(kind, Array.from({ length: cells }, () => [] as number[]));
      this.out.set(kind, []);
    }
  }

  private cellOf(x: number, y: number): number {
    const cx = Math.min(this.cols - 1, Math.max(0, Math.floor(x / this.cell)));
    const cy = Math.min(this.rows - 1, Math.max(0, Math.floor(y / this.cell)));
    return cy * this.cols + cx;
  }

  /** Esvazia e recarrega a grade com o que o mundo tem agora. Chamar uma vez por tick. */
  rebuild<S>(kind: IndexedKind, items: readonly S[], x: (s: S) => number, y: (s: S) => number): void {
    const buckets = this.buckets.get(kind)!;
    this.clearKind(kind, buckets);
    for (let i = 0; i < items.length; i++) {
      buckets[this.cellOf(x(items[i]), y(items[i]))].push(i);
    }
    this.totals[kind] = items.length;
  }

  private clearKind(kind: IndexedKind, buckets: number[][]): void {
    for (let i = 0; i < buckets.length; i++) {
      if (buckets[i].length) buckets[i].length = 0;
    }
    this.out.get(kind)!.length = 0;
  }

  /**
   * Índices de `kind` cujo tile cai dentro de `rect`. A folga do retângulo é conta de quem
   * chama, porque é ela que sabe o tamanho do desenho: um pinheiro de dois tiles e um
   * pedestre de um não pedem a mesma margem.
   */
  query(kind: IndexedKind, rect: WorldRect): readonly number[] {
    const buckets = this.buckets.get(kind)!;
    const out = this.out.get(kind)!;
    out.length = 0;
    const cx0 = Math.min(this.cols - 1, Math.max(0, Math.floor(rect.minX / this.cell)));
    const cx1 = Math.min(this.cols - 1, Math.max(0, Math.floor((rect.maxX - 1e-6) / this.cell)));
    const cy0 = Math.min(this.rows - 1, Math.max(0, Math.floor(rect.minY / this.cell)));
    const cy1 = Math.min(this.rows - 1, Math.max(0, Math.floor((rect.maxY - 1e-6) / this.cell)));
    for (let cy = cy0; cy <= cy1; cy++) {
      const row = cy * this.cols;
      for (let cx = cx0; cx <= cx1; cx++) {
        const bucket = buckets[row + cx];
        for (let i = 0; i < bucket.length; i++) out.push(bucket[i]);
      }
    }
    return out;
  }

  /** Quantos do tipo estão na janela. É o "entidades visíveis/ativas" da métrica. */
  countIn(kind: IndexedKind, rect: WorldRect): number {
    return this.query(kind, rect).length;
  }
}
