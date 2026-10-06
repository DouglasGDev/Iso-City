"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Map = void 0;
exports.vertexHeight = vertexHeight;
const GameConfig_1 = require("../game/GameConfig");
const Frontier_1 = require("./Frontier");
const IsoUtils_1 = require("./IsoUtils");
/**
 * O sprite ancora na ponta SUL (bottom-center).
 * A base visível no chão é o losango iso = quadrado no mundo, de lado ≈ footprintW
 * (NÃO usa footprintH — isso é altura do desenho, não profundidade no chão).
 */
function buildingGroundCollider(b) {
    return {
        x: b.x - b.footprintW,
        y: b.y - b.footprintW,
        width: b.footprintW,
        height: b.footprintW,
        type: 'BUILDING',
    };
}
const LANDMARK_KINDS = [
    { re: /^bld_policestation/, kind: 'police' },
    { re: /^bld_hospital/, kind: 'hospital' },
    { re: /^bld_firestation/, kind: 'firestation' },
    { re: /^bld_church/, kind: 'church' },
    { re: /^bld_gasstation/, kind: 'gasstation' },
    { re: /^bld_clinic/, kind: 'clinic' },
    { re: /^bld_autoshop/, kind: 'autoshop' },
    { re: /^bld_busstation/, kind: 'busstation' },
    { re: /^bld_(cafe|pizza|icecream|gunshop|fruitstand)/, kind: 'shop' },
];
/**
 * Cota de um CANTO da malha, em coordenadas inteiras: a média dos tiles que encostam
 * naquele vértice. É a superfície que o GroundLayer entorta, e por isso mora aqui — o
 * chão desenhado e o sprite que pisa nele têm de ler o mesmo número, senão o personagem
 * flutua sobre um relevo e anda sobre outro.
 */
function vertexHeight(data, x, y) {
    const W = data.tilesW;
    const hs = data.heights;
    let soma = 0;
    let n = 0;
    for (let dy = -1; dy <= 0; dy++) {
        for (let dx = -1; dx <= 0; dx++) {
            const tx = x + dx;
            const ty = y + dy;
            if (tx < 0 || ty < 0 || tx >= W || ty >= data.tilesH)
                continue;
            soma += hs[ty * W + tx];
            n++;
        }
    }
    return n ? soma / n : 0;
}
class Map {
    constructor(data, extraColliders = []) {
        this.landmarks = [];
        this.roadNodes = [];
        /** Vizinhos com aresta direcionada respeitando faixa (mão única). */
        this.roadOut = [];
        /** Vizinhos sem mão única — usado no GPS quando a rota dirigida falha. */
        this.roadUndirected = [];
        this.roadNodeTiles = [];
        this.sidewalkNodes = [];
        this.sidewalkNeighbors = [];
        this.colliderGrid = [];
        this.colliderGridCols = 0;
        this.colliderGridRows = 0;
        this.sidewalkGrid = [];
        this.roadGrid = [];
        this.nodeGridCols = 0;
        this.nodeGridRows = 0;
        /** Cantos da malha já promedidos: (tilesW+1)·(tilesH+1) cotas, calculadas uma vez. */
        this.cornerH = new Float32Array(0);
        /**
         * Tiles da bacia de cada cachoeira, que são água para o movimento sem reescrever o tile:
         * um `kind:'water'` no meio da encosta afundaria o morro no gerador, e a rede pisável
         * colapsaria (bug #115). Aqui a água é uma camada à parte, desenhada pela CascadeLayer.
         */
        this.cascadeWater = null;
        // O relevo é dado do mapa, não suposição: um chão sem malha de altura é plano, e é
        // assim que interior antigo e fixture de teste continuam lendo altura sem crash.
        if (!data.heights)
            data.heights = new Float32Array(data.tilesW * data.tilesH);
        if (!data.shades)
            data.shades = new Float32Array(data.tilesW * data.tilesH);
        this.data = data;
        this.buildCorners();
        this.buildCascadeWater();
        const colliders = [...extraColliders];
        const buildingColliders = [];
        for (const b of data.buildings) {
            const c = buildingGroundCollider(b);
            colliders.push(c);
            buildingColliders.push(c);
        }
        for (const p of data.props) {
            if (p.collider) {
                colliders.push({ ...p.collider, type: 'FENCE', coverHeight: p.key.includes('wire') ? 0 : 0.95 });
            }
            else if (/^prop_(trashcan|rocks|trunk)/.test(p.key)) {
                colliders.push({ x: p.x - 0.22, y: p.y - 0.22, width: 0.44, height: 0.44,
                    type: 'PROP', coverHeight: p.key.includes('trashcan') ? 0.95 : 0.7 });
            }
        }
        this.staticColliders = colliders;
        this.buildingColliders = buildingColliders;
        this.buildColliderGrid(colliders);
        this.buildRoadGraph();
        this.buildSidewalkGraph();
        this.buildNodeGrids();
        this.buildLandmarks();
    }
    buildLandmarks() {
        for (const b of this.data.buildings) {
            const found = LANDMARK_KINDS.find((l) => l.re.test(b.key));
            if (!found)
                continue;
            const cx = b.x - b.footprintW / 2;
            const cy = b.y - b.footprintW / 2;
            let front = this.nearestSidewalkPoint(cx, cy + b.footprintW * 0.55);
            if (!front)
                front = this.nearestSidewalkPoint(cx, cy);
            if (!front)
                continue;
            this.landmarks.push({ kind: found.kind, key: b.key, x: cx, y: cy, front });
        }
    }
    nearestSidewalkPoint(x, y) {
        let best = null;
        let bestD = 25; // até ~5 tiles
        for (const n of this.sidewalkNodes) {
            const d = Math.hypot(n.x - x, n.y - y);
            if (d < bestD) {
                bestD = d;
                best = n;
            }
        }
        return best;
    }
    landmarksOf(kind) {
        return this.landmarks.filter((l) => l.kind === kind);
    }
    landmark(kind) {
        return this.landmarks.find((l) => l.kind === kind) ?? null;
    }
    buildColliderGrid(colliders) {
        const W = this.data.worldW;
        const H = this.data.worldH;
        const cs = Map.COLLIDER_CELL;
        this.colliderGridCols = Math.max(1, Math.ceil(W / cs));
        this.colliderGridRows = Math.max(1, Math.ceil(H / cs));
        this.colliderGrid = Array.from({ length: this.colliderGridRows * this.colliderGridCols }, () => []);
        for (const c of colliders) {
            const gx0 = Math.max(0, Math.floor(c.x / cs));
            const gy0 = Math.max(0, Math.floor(c.y / cs));
            const gx1 = Math.min(this.colliderGridCols - 1, Math.floor((c.x + c.width) / cs));
            const gy1 = Math.min(this.colliderGridRows - 1, Math.floor((c.y + c.height) / cs));
            for (let gy = gy0; gy <= gy1; gy++) {
                for (let gx = gx0; gx <= gx1; gx++) {
                    this.colliderGrid[gy * this.colliderGridCols + gx].push(c);
                }
            }
        }
    }
    buildNodeGrids() {
        const W = this.data.worldW;
        const H = this.data.worldH;
        const cs = Map.NODE_CELL;
        this.nodeGridCols = Math.max(1, Math.ceil(W / cs));
        this.nodeGridRows = Math.max(1, Math.ceil(H / cs));
        this.sidewalkGrid = Array.from({ length: this.nodeGridRows * this.nodeGridCols }, () => []);
        this.roadGrid = Array.from({ length: this.nodeGridRows * this.nodeGridCols }, () => []);
        for (let i = 0; i < this.sidewalkNodes.length; i++) {
            const n = this.sidewalkNodes[i];
            const gx = Math.min(this.nodeGridCols - 1, Math.max(0, Math.floor(n.x / cs)));
            const gy = Math.min(this.nodeGridRows - 1, Math.max(0, Math.floor(n.y / cs)));
            this.sidewalkGrid[gy * this.nodeGridCols + gx].push(i);
        }
        for (let i = 0; i < this.roadNodes.length; i++) {
            const n = this.roadNodes[i];
            const gx = Math.min(this.nodeGridCols - 1, Math.max(0, Math.floor(n.x / cs)));
            const gy = Math.min(this.nodeGridRows - 1, Math.max(0, Math.floor(n.y / cs)));
            this.roadGrid[gy * this.nodeGridCols + gx].push(i);
        }
    }
    nearestInGrid(x, y, grid, nodes) {
        if (nodes.length === 0)
            return 0;
        const cs = Map.NODE_CELL;
        const gx = Math.floor(x / cs);
        const gy = Math.floor(y / cs);
        let best = 0;
        let bestD = Infinity;
        let found = false;
        for (let ring = 0; ring <= 3; ring++) {
            for (let dy = -ring; dy <= ring; dy++) {
                for (let dx = -ring; dx <= ring; dx++) {
                    if (ring > 0 && Math.abs(dx) !== ring && Math.abs(dy) !== ring)
                        continue;
                    const cx = gx + dx;
                    const cy = gy + dy;
                    if (cx < 0 || cy < 0 || cx >= this.nodeGridCols || cy >= this.nodeGridRows)
                        continue;
                    const bucket = grid[cy * this.nodeGridCols + cx];
                    for (let k = 0; k < bucket.length; k++) {
                        const i = bucket[k];
                        const n = nodes[i];
                        const d = (n.x - x) * (n.x - x) + (n.y - y) * (n.y - y);
                        if (d < bestD) {
                            bestD = d;
                            best = i;
                            found = true;
                        }
                    }
                }
            }
            if (found)
                return best;
        }
        for (let i = 0; i < nodes.length; i++) {
            const n = nodes[i];
            const d = (n.x - x) * (n.x - x) + (n.y - y) * (n.y - y);
            if (d < bestD) {
                bestD = d;
                best = i;
            }
        }
        return best;
    }
    allowsDirectedEdge(fromTx, fromTy, dx, dy) {
        const { tilesW: W, tiles } = this.data;
        const from = tiles[fromTy * W + fromTx];
        const to = tiles[(fromTy + dy) * W + (fromTx + dx)];
        const md = (0, IsoUtils_1.deltaToDir)(dx, dy);
        if (from.lane && from.lane !== md)
            return false;
        if (to.lane && to.lane !== md)
            return false;
        if (!from.lane && !to.lane) {
            // Continue the surrounding lanes through each 2x2 junction, including turns.
            for (const step of [-1, 1, -2, 2]) {
                const lane = this.laneAt(fromTx + dx * step + 0.5, fromTy + dy * step + 0.5);
                if (lane && (dx !== 0) === (lane === 'SE' || lane === 'NW'))
                    return lane === md;
            }
        }
        return true;
    }
    buildRoadGraph() {
        const { tilesW: W, tilesH: H, tiles } = this.data;
        const index = {};
        const key = (tx, ty) => `${tx},${ty}`;
        for (let ty = 0; ty < H; ty++) {
            for (let tx = 0; tx < W; tx++) {
                if (tiles[ty * W + tx].kind !== 'road')
                    continue;
                const i = this.roadNodes.length;
                index[key(tx, ty)] = i;
                this.roadNodes.push({ x: tx + 0.5, y: ty + 0.5 });
                this.roadNodeTiles.push({ tx, ty });
                this.roadOut.push([]);
                this.roadUndirected.push([]);
            }
        }
        const dirs = [
            [1, 0],
            [-1, 0],
            [0, 1],
            [0, -1],
        ];
        for (let ty = 0; ty < H; ty++) {
            for (let tx = 0; tx < W; tx++) {
                const a = index[key(tx, ty)];
                if (a === undefined)
                    continue;
                for (const [dx, dy] of dirs) {
                    const b = index[key(tx + dx, ty + dy)];
                    if (b === undefined)
                        continue;
                    this.roadUndirected[a].push(b);
                    if (this.allowsDirectedEdge(tx, ty, dx, dy)) {
                        this.roadOut[a].push(b);
                    }
                }
            }
        }
    }
    buildSidewalkGraph() {
        const { tilesW: W, tilesH: H, tiles } = this.data;
        const index = {};
        const key = (tx, ty) => `${tx},${ty}`;
        const isRoad = (tx, ty) => tx >= 0 && ty >= 0 && tx < W && ty < H && tiles[ty * W + tx].kind === 'road';
        const isBridge = (tx, ty) => isRoad(tx, ty) && !!tiles[ty * W + tx].bridge;
        const isSidewalk = (tx, ty) => {
            if (tx < 0 || ty < 0 || tx >= W || ty >= H)
                return false;
            // Água de movimento, não só de tile: a bacia da cachoeira é `isWaterWorld` sem ser
            // `kind:'water'`. Um node de passeio ali dentro é um pedestre nadando parado em cima do
            // próprio destino, porque o destino é ele — e a faixa inteira para atrás dele. O passeio
            // dá volta na poça como dá volta no rio.
            if (this.isWaterWorld(tx + 0.5, ty + 0.5))
                return false;
            const t = tiles[ty * W + tx];
            if (t.kind === 'road') {
                // Bridge decks and their dry approaches connect the two sidewalk banks.
                return isBridge(tx, ty) || isBridge(tx + 1, ty) || isBridge(tx - 1, ty)
                    || isBridge(tx, ty + 1) || isBridge(tx, ty - 1);
            }
            return isRoad(tx + 1, ty) || isRoad(tx - 1, ty) || isRoad(tx, ty + 1) || isRoad(tx, ty - 1);
        };
        this.sidewalkNodes.length = 0;
        this.sidewalkNeighbors.length = 0;
        for (let ty = 0; ty < H; ty++) {
            for (let tx = 0; tx < W; tx++) {
                if (!isSidewalk(tx, ty))
                    continue;
                index[key(tx, ty)] = this.sidewalkNodes.length;
                this.sidewalkNodes.push({ x: tx + 0.5, y: ty + 0.5 });
                this.sidewalkNeighbors.push([]);
            }
        }
        const dirs = [
            [1, 0],
            [-1, 0],
            [0, 1],
            [0, -1],
        ];
        for (let ty = 0; ty < H; ty++) {
            for (let tx = 0; tx < W; tx++) {
                const a = index[key(tx, ty)];
                if (a === undefined)
                    continue;
                for (const [dx, dy] of dirs) {
                    const nx = tx + dx;
                    const ny = ty + dy;
                    const b = index[key(nx, ny)];
                    if (b !== undefined) {
                        this.sidewalkNeighbors[a].push(b);
                        continue;
                    }
                    if (isRoad(nx, ny)) {
                        const ox = nx + dx;
                        const oy = ny + dy;
                        const c = index[key(ox, oy)];
                        if (c !== undefined && !this.sidewalkNeighbors[a].includes(c)) {
                            this.sidewalkNeighbors[a].push(c);
                        }
                        // também 2 tiles de asfalto (rua dupla)
                        if (isRoad(ox, oy)) {
                            const c2 = index[key(ox + dx, oy + dy)];
                            if (c2 !== undefined && !this.sidewalkNeighbors[a].includes(c2)) {
                                this.sidewalkNeighbors[a].push(c2);
                            }
                        }
                    }
                }
            }
        }
    }
    laneAt(x, y) {
        const tx = Math.floor(x);
        const ty = Math.floor(y);
        if (tx < 0 || ty < 0 || tx >= this.data.tilesW || ty >= this.data.tilesH)
            return null;
        const t = this.data.tiles[ty * this.data.tilesW + tx];
        if (t.kind !== 'road')
            return null;
        return t.lane ?? null;
    }
    nearestRoadNode(x, y) {
        return this.nearestInGrid(x, y, this.roadGrid, this.roadNodes);
    }
    findRoadPath(fromX, fromY, toX, toY) {
        return this.bfsRoadPath(fromX, fromY, toX, toY, this.roadOut);
    }
    findUndirectedRoadPath(fromX, fromY, toX, toY) {
        return this.bfsRoadPath(fromX, fromY, toX, toY, this.roadUndirected);
    }
    bfsRoadPath(fromX, fromY, toX, toY, adj) {
        if (this.roadNodes.length === 0)
            return [];
        const start = this.nearestRoadNode(fromX, fromY);
        const goal = this.nearestRoadNode(toX, toY);
        if (start === goal)
            return [this.roadNodes[start]];
        const prev = new Int32Array(this.roadNodes.length).fill(-1);
        const q = [start];
        prev[start] = start;
        let qi = 0;
        while (qi < q.length) {
            const cur = q[qi++];
            if (cur === goal)
                break;
            for (const nb of adj[cur]) {
                if (prev[nb] !== -1)
                    continue;
                prev[nb] = cur;
                q.push(nb);
            }
        }
        if (prev[goal] === -1)
            return [];
        const chain = [];
        let c = goal;
        while (c !== start) {
            chain.push(c);
            c = prev[c];
        }
        chain.push(start);
        chain.reverse();
        return chain.map((i) => this.roadNodes[i]);
    }
    randomRoadNodeIndex(rng = Math.random) {
        return Math.floor(rng() * this.roadNodes.length);
    }
    nearestSidewalkNode(x, y) {
        return this.nearestInGrid(x, y, this.sidewalkGrid, this.sidewalkNodes);
    }
    findSidewalkPath(fromX, fromY, toX, toY) {
        if (this.sidewalkNodes.length === 0)
            return [];
        const start = this.nearestSidewalkNode(fromX, fromY);
        const goal = this.nearestSidewalkNode(toX, toY);
        if (start === goal)
            return [this.sidewalkNodes[start]];
        const prev = new Int32Array(this.sidewalkNodes.length).fill(-1);
        const q = [start];
        prev[start] = start;
        let qi = 0;
        while (qi < q.length) {
            const cur = q[qi++];
            if (cur === goal)
                break;
            for (const nb of this.sidewalkNeighbors[cur]) {
                if (prev[nb] !== -1)
                    continue;
                prev[nb] = cur;
                q.push(nb);
            }
        }
        if (prev[goal] === -1)
            return [];
        const chain = [];
        let c = goal;
        while (c !== start) {
            chain.push(c);
            c = prev[c];
        }
        chain.push(start);
        chain.reverse();
        return chain.map((i) => this.sidewalkNodes[i]);
    }
    randomSidewalkNodeIndex(rng = Math.random) {
        if (this.sidewalkNodes.length === 0)
            return 0;
        return Math.floor(rng() * this.sidewalkNodes.length);
    }
    isCrosswalkAt(x, y) {
        const tx = Math.floor(x);
        const ty = Math.floor(y);
        if (tx < 0 || ty < 0 || tx >= this.data.tilesW || ty >= this.data.tilesH)
            return false;
        const t = this.data.tiles[ty * this.data.tilesW + tx];
        return t.kind === 'road' && t.key.includes('pelican');
    }
    isNearCrosswalk(x, y, radius = 1.4) {
        const r = Math.ceil(radius);
        const tx0 = Math.floor(x) - r;
        const ty0 = Math.floor(y) - r;
        for (let dy = -r; dy <= r; dy++) {
            for (let dx = -r; dx <= r; dx++) {
                if (this.isCrosswalkAt(tx0 + dx, ty0 + dy))
                    return true;
            }
        }
        return false;
    }
    /** Cruzamento principal (via dupla, lane null = pode virar / semáforo). */
    isIntersectionAt(x, y) {
        const tx = Math.floor(x);
        const ty = Math.floor(y);
        if (tx < 0 || ty < 0 || tx >= this.data.tilesW || ty >= this.data.tilesH)
            return false;
        const t = this.data.tiles[ty * this.data.tilesW + tx];
        if (t.kind !== 'road' || t.bridge)
            return false;
        return t.lane == null;
    }
    queryNearby(x, y, radius) {
        const minX = x - radius;
        const maxX = x + radius;
        const minY = y - radius;
        const maxY = y + radius;
        const cs = Map.COLLIDER_CELL;
        const gx0 = Math.max(0, Math.floor(minX / cs));
        const gy0 = Math.max(0, Math.floor(minY / cs));
        const gx1 = Math.min(this.colliderGridCols - 1, Math.floor(maxX / cs));
        const gy1 = Math.min(this.colliderGridRows - 1, Math.floor(maxY / cs));
        const out = [];
        for (let gy = gy0; gy <= gy1; gy++) {
            for (let gx = gx0; gx <= gx1; gx++) {
                const cell = this.colliderGrid[gy * this.colliderGridCols + gx];
                for (let i = 0; i < cell.length; i++) {
                    const c = cell[i];
                    if (c.x + c.width < minX || c.x > maxX || c.y + c.height < minY || c.y > maxY)
                        continue;
                    // Um colisor grande é registrado em cada célula que ele toca, então a mesma peça
                    // pode vir de duas varreduras. O `Set` que fazia isso custava um objeto de hash por
                    // chamada — e são ~250 chamadas por tick. O repetido só aparece na borda da célula,
                    // numa lista de meia dúzia de itens: procurar nela é mais barato do que hashear.
                    if (out.indexOf(c) < 0)
                        out.push(c);
                }
            }
        }
        return out;
    }
    get worldW() {
        return this.data.worldW;
    }
    get worldH() {
        return this.data.worldH;
    }
    isInside(x, y, margin = 0) {
        return x >= margin && x <= this.worldW - margin && y >= margin && y <= this.worldH - margin;
    }
    isWaterWorld(x, y) {
        // NaN passa por toda comparação de limite (`NaN < 0` e `NaN >= tilesW` são ambos
        // falsos) e devolve `tiles[NaN]`, que é undefined: um só pedestre com posição quebrada
        // derrubava o update inteiro, frame após frame.
        if (!Number.isFinite(x) || !Number.isFinite(y))
            return false;
        const tx = Math.floor(x);
        const ty = Math.floor(y);
        // Fora da grade o mundo continua pelo rio: o canal que sai do mapa é água também para o
        // movimento. Sem isto a fronteira pintaria a água, encheria o canal de tronco e deixaria
        // o jogador andando no leito seco de um rio desenhado.
        if (tx < 0 || ty < 0 || tx >= this.data.tilesW || ty >= this.data.tilesH) {
            return (0, Frontier_1.rioDaFronteira)(this.data.tiles, this.data.tilesW, this.data.tilesH, tx, ty);
        }
        const i = ty * this.data.tilesW + tx;
        // A bacia da cachoeira é água de verdade para o movimento, sem ser tile de água no mapa.
        if (this.cascadeWater && this.cascadeWater[i])
            return true;
        return this.data.tiles[i].kind === 'water';
    }
    tileKindAt(x, y) {
        const tx = Math.floor(x);
        const ty = Math.floor(y);
        if (tx < 0 || ty < 0 || tx >= this.data.tilesW || ty >= this.data.tilesH)
            return null;
        return this.data.tiles[ty * this.data.tilesW + tx].kind;
    }
    biomeAt(x, y) {
        const tx = Math.floor(x);
        const ty = Math.floor(y);
        if (tx < 0 || ty < 0 || tx >= this.data.tilesW || ty >= this.data.tilesH)
            return null;
        return this.data.tiles[ty * this.data.tilesW + tx].biome;
    }
    /**
     * Altura do chão em tiles, losango a losango: é a cota das REGRAS — quem pode subir,
     * onde o carro perde força, o que é parede. Para desenhar, use `heightSmoothAt`, que é
     * a superfície contínua; a cota quantizada serve para decidir, nunca para saltar a tela.
     */
    heightAt(x, y) {
        return this.heightAtTile(Math.floor(x), Math.floor(y));
    }
    /** Mesma leitura por índice de tile, para o render varrer a malha sem Math.floor. */
    heightAtTile(tx, ty) {
        if (tx < 0 || ty < 0 || tx >= this.data.tilesW || ty >= this.data.tilesH)
            return 0;
        return this.data.heights[ty * this.data.tilesW + tx];
    }
    buildCorners() {
        const { tilesW: W, tilesH: H } = this.data;
        const c = new Float32Array((W + 1) * (H + 1));
        for (let y = 0; y <= H; y++) {
            for (let x = 0; x <= W; x++)
                c[y * (W + 1) + x] = vertexHeight(this.data, x, y);
        }
        this.cornerH = c;
    }
    /**
     * Marca os tiles cobertos pela bacia de cada queda. Uma varredura por tile do disco, no
     * construtor, uma vez por mapa: `isWaterWorld` é caminho quente (movimento, NPCs, trânsito,
     * polícia) e só paga um leitura de array.
     */
    buildCascadeWater() {
        const list = this.data.cascatas;
        if (!list || !list.length)
            return;
        const W = this.data.tilesW;
        const H = this.data.tilesH;
        const mask = new Uint8Array(W * H);
        let algum = 0;
        for (const c of list) {
            const r = Math.max(0.5, c.bacia.raio);
            const x0 = Math.max(0, Math.floor(c.bacia.x - r));
            const x1 = Math.min(W - 1, Math.ceil(c.bacia.x + r));
            const y0 = Math.max(0, Math.floor(c.bacia.y - r));
            const y1 = Math.min(H - 1, Math.ceil(c.bacia.y + r));
            for (let ty = y0; ty <= y1; ty++) {
                for (let tx = x0; tx <= x1; tx++) {
                    // Distância do disco ao tile inteiro, não ao centro dele: medindo pelo centro,
                    // um disco de um tile e um pouco perde as quatro diagonais e a bacia desenhada
                    // — elipse cheia — vira uma cruz de tiles pisáveis. O corpo parava num canto
                    // molhado do desenho e continuava andando sobre a relva.
                    const dx = Math.max(tx - c.bacia.x, c.bacia.x - (tx + 1), 0);
                    const dy = Math.max(ty - c.bacia.y, c.bacia.y - (ty + 1), 0);
                    if (Math.hypot(dx, dy) > r)
                        continue;
                    mask[ty * W + tx] = 1;
                    algum = 1;
                }
            }
        }
        if (algum)
            this.cascadeWater = mask;
    }
    /**
     * Cota contínua do chão: bilinear entre os cantos da malha, ou seja, a altura VISUAL.
     * O tile quantizado é regra de movimento, não aparência—entre dois tiles a cota salta de
     * um dia inteiro, e na tela isso é o personagem subindo e descendo de degrau no mesmo
     * lugar enquanto anda. Aqui a superfície é a mesma que o chão desenhado entortou.
     */
    heightSmoothAt(x, y) {
        const W = this.data.tilesW;
        const H = this.data.tilesH;
        if (!this.cornerH.length || W < 1 || H < 1)
            return 0;
        // NaN não pode virar cota: um único número assim na árvore de transforms derruba o
        // canvas inteiro, e a tela fecha em branco sem mensagem.
        if (!Number.isFinite(x) || !Number.isFinite(y))
            return 0;
        const cx = Math.min(W - 1, Math.max(0, Math.floor(x)));
        const cy = Math.min(H - 1, Math.max(0, Math.floor(y)));
        const fx = Math.min(1, Math.max(0, x - cx));
        const fy = Math.min(1, Math.max(0, y - cy));
        const s = W + 1;
        const a = this.cornerH[cy * s + cx];
        const b = this.cornerH[cy * s + cx + 1];
        const c = this.cornerH[(cy + 1) * s + cx];
        const d = this.cornerH[(cy + 1) * s + cx + 1];
        const norte = a + (b - a) * fx;
        const sul = c + (d - c) * fx;
        return norte + (sul - norte) * fy;
    }
    /** Sombra da encosta (-1 a +1): tinta do relevo, nunca geometria. */
    shadeAtTile(tx, ty) {
        if (tx < 0 || ty < 0 || tx >= this.data.tilesW || ty >= this.data.tilesH)
            return 0;
        return this.data.shades[ty * this.data.tilesW + tx];
    }
    /**
     * A única "colisão" do relevo: comparar duas cotas. Encosta é andar; o que passa
     * de TERRAIN_STEP_UP_TILES entre um tile e o próximo é parede, e queda funda
     * demais é borda — é assim que a montanha barra o NPC sem geometria nova nem
     * câmera em 3D.
     */
    canClimb(fromX, fromY, toX, toY) {
        const up = this.heightAt(toX, toY) - this.heightAt(fromX, fromY);
        return up <= GameConfig_1.GAME_CONFIG.TERRAIN_STEP_UP_TILES && -up <= GameConfig_1.GAME_CONFIG.TERRAIN_MAX_DROP_TILES;
    }
    /**
     * Roda não faz trilha: o gerador aplaina o asfalto inteiro dentro de um declive
     * suave, então um carro que encare um ressalto está cortando campo, não subindo rua.
     */
    canDriveOver(fromX, fromY, toX, toY) {
        const up = this.heightAt(toX, toY) - this.heightAt(fromX, fromY);
        return Math.abs(up) <= GameConfig_1.GAME_CONFIG.TERRAIN_STEP_UP_VEHICLE;
    }
    /**
     * Inclinação no ponto, em tiles de desnível por tile andado: positiva subindo. Lê a
     * superfície contínua de propósito—medida no tile quantizado, o declive mudaria de um
     * salto para outro conforme o carro cruzasse a borda do losango, e a velocidade do
     * motor oscilaria em degrau na mesma encosta.
     */
    slopeAlong(x, y, dx, dy) {
        return this.heightSmoothAt(x + dx, y + dy) - this.heightSmoothAt(x, y);
    }
}
exports.Map = Map;
Map.COLLIDER_CELL = 8;
Map.NODE_CELL = 12;
