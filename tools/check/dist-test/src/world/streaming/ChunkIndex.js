"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ChunkIndex = void 0;
const GameConfig_1 = require("../../game/GameConfig");
/**
 * Índice espacial do que NUNCA SE MOVE: cada prédio e cada adorno do mapa pertence ao
 * chunk do tile em que pisa. É a resposta da pergunta "o que esta região do mapa tem?",
 * respondida sem percorrer os 4.451 estáticos do mapa inteiro.
 *
 * Uma estática mora num chunk só, de propósito. Um lote 3×3 ancora no canto sul e
 * cresce para noroeste, e a sombra dele cai para sul — em vez de duplicar o índice nos
 * vizinhos (e depois descontar as repetições a cada passada), quem consulta dilata o
 * retângulo por `CHUNK_QUERY_MARGIN`. A margem é maior que qualquer desenho que cruza a
 * borda, então o resultado é o mesmo conjunto, com metade do trabalho e sem chave
 * repetida.
 */
class ChunkIndex {
    constructor(data) {
        this.size = GameConfig_1.GAME_CONFIG.CHUNK_SIZE;
        this.cols = Math.max(1, Math.ceil(data.worldW / this.size));
        this.rows = Math.max(1, Math.ceil(data.worldH / this.size));
        const total = this.cols * this.rows;
        this.buildingsByChunk = Array.from({ length: total }, () => []);
        this.propsByChunk = Array.from({ length: total }, () => []);
        this.weight = new Int32Array(total);
        for (let i = 0; i < data.buildings.length; i++) {
            const b = data.buildings[i];
            const id = this.at(b.x, b.y);
            this.buildingsByChunk[id].push(i);
            this.weight[id]++;
        }
        for (let i = 0; i < data.props.length; i++) {
            const p = data.props[i];
            const id = this.at(p.x, p.y);
            this.propsByChunk[id].push(i);
            this.weight[id]++;
        }
    }
    get count() {
        return this.cols * this.rows;
    }
    cxOf(id) {
        return id % this.cols;
    }
    cyOf(id) {
        return (id - this.cxOf(id)) / this.cols;
    }
    idOf(cx, cy) {
        return cy * this.cols + cx;
    }
    /** Chunk de um ponto do mundo. Tiles negativos (câmera fora da borda) saturam na beira. */
    at(x, y) {
        const cx = Math.min(this.cols - 1, Math.max(0, Math.floor(x / this.size)));
        const cy = Math.min(this.rows - 1, Math.max(0, Math.floor(y / this.size)));
        return this.idOf(cx, cy);
    }
    /** Centro do chunk em coordenadas de mundo: a distância de prioridade é medida daí. */
    centerX(id) {
        return (this.cxOf(id) + 0.5) * this.size;
    }
    centerY(id) {
        return (this.cyOf(id) + 0.5) * this.size;
    }
    /**
     * Índices de chunk que tocam o retângulo, preenchidos em `out` (sem alocar). A ordem
     * é a varredura da malha, linha a linha; quem precisa de prioridade ordena depois.
     */
    chunkIdsIn(rect, out = []) {
        out.length = 0;
        const cx0 = Math.min(this.cols - 1, Math.max(0, Math.floor(rect.minX / this.size)));
        const cx1 = Math.min(this.cols - 1, Math.max(0, Math.floor((rect.maxX - 1e-6) / this.size)));
        const cy0 = Math.min(this.rows - 1, Math.max(0, Math.floor(rect.minY / this.size)));
        const cy1 = Math.min(this.rows - 1, Math.max(0, Math.floor((rect.maxY - 1e-6) / this.size)));
        for (let cy = cy0; cy <= cy1; cy++) {
            for (let cx = cx0; cx <= cx1; cx++)
                out.push(this.idOf(cx, cy));
        }
        return out;
    }
}
exports.ChunkIndex = ChunkIndex;
