"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SpatialIndex = void 0;
const GameConfig_1 = require("../../game/GameConfig");
const KINDS = ['npc', 'veh', 'animal', 'wreck'];
/**
 * Grade de baldes do tamanho de um chunk, populada uma vez por tick pelo `GameLoop`.
 *
 * O contrato de quem consome: `query` devolve um buffer emprestado do próprio índice,
 * válido até a próxima consulta do MESMO tipo. É o preço de não criar array novo a cada
 * leitura — com 60 ticks por segundo, quatro consultas por tick e um array de dezenas de
 * índices em cada uma, a alocação vira trabalho para o coletor no meio do frame, que é
 * exatamente o que a spec §15 pede para não fazer.
 */
class SpatialIndex {
    constructor(worldW, worldH) {
        this.cell = GameConfig_1.GAME_CONFIG.CHUNK_SIZE;
        this.buckets = new Map();
        this.out = new Map();
        /** Total inserido no último tick, por tipo: é o "quantos existem" da métrica. */
        this.totals = { npc: 0, veh: 0, animal: 0, wreck: 0 };
        this.cols = Math.max(1, Math.ceil(worldW / this.cell));
        this.rows = Math.max(1, Math.ceil(worldH / this.cell));
        const cells = this.cols * this.rows;
        for (const kind of KINDS) {
            this.buckets.set(kind, Array.from({ length: cells }, () => []));
            this.out.set(kind, []);
        }
    }
    cellOf(x, y) {
        const cx = Math.min(this.cols - 1, Math.max(0, Math.floor(x / this.cell)));
        const cy = Math.min(this.rows - 1, Math.max(0, Math.floor(y / this.cell)));
        return cy * this.cols + cx;
    }
    /** Esvazia e recarrega a grade com o que o mundo tem agora. Chamar uma vez por tick. */
    rebuild(kind, items, x, y) {
        const buckets = this.buckets.get(kind);
        this.clearKind(kind, buckets);
        for (let i = 0; i < items.length; i++) {
            buckets[this.cellOf(x(items[i]), y(items[i]))].push(i);
        }
        this.totals[kind] = items.length;
    }
    clearKind(kind, buckets) {
        for (let i = 0; i < buckets.length; i++) {
            if (buckets[i].length)
                buckets[i].length = 0;
        }
        this.out.get(kind).length = 0;
    }
    /**
     * Índices de `kind` cujo tile cai dentro de `rect`. A folga do retângulo é conta de quem
     * chama, porque é ela que sabe o tamanho do desenho: um pinheiro de dois tiles e um
     * pedestre de um não pedem a mesma margem.
     */
    query(kind, rect) {
        const buckets = this.buckets.get(kind);
        const out = this.out.get(kind);
        out.length = 0;
        const cx0 = Math.min(this.cols - 1, Math.max(0, Math.floor(rect.minX / this.cell)));
        const cx1 = Math.min(this.cols - 1, Math.max(0, Math.floor((rect.maxX - 1e-6) / this.cell)));
        const cy0 = Math.min(this.rows - 1, Math.max(0, Math.floor(rect.minY / this.cell)));
        const cy1 = Math.min(this.rows - 1, Math.max(0, Math.floor((rect.maxY - 1e-6) / this.cell)));
        for (let cy = cy0; cy <= cy1; cy++) {
            const row = cy * this.cols;
            for (let cx = cx0; cx <= cx1; cx++) {
                const bucket = buckets[row + cx];
                for (let i = 0; i < bucket.length; i++)
                    out.push(bucket[i]);
            }
        }
        return out;
    }
    /** Quantos do tipo estão na janela. É o "entidades visíveis/ativas" da métrica. */
    countIn(kind, rect) {
        return this.query(kind, rect).length;
    }
}
exports.SpatialIndex = SpatialIndex;
