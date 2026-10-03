"use strict";
/**
 * Planta da caverna. Assim como a penitenciária, isto é geometria pura: a rocha que se
 * desenha é a mesma que bloqueia, porque as duas são lidas desta grade e de nada mais.
 *
 * A caverna é pedra com vazios, não salas com paredes. Aqui se abre o vazio; o que sobra
 * é rocha. Daí o desenho vir em blocos meia-altura: na projeção isométrica a rocha da
 * frente esconderia quem está atrás dela, e um corpo invisível dentro de um buraco não é
 * jogo — é tela preta. Meia-altura é a mesma regra da cela da cadeia: vê-se por cima.
 *
 * O anel externo é rocha de propósito: sobrar piso entre a casca da sala e a rocha é um
 * corredor fantasma onde o jogador prende o pé, e foi exatamente assim que a última cela
 * da prisão nasceu aberta.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.CAVE_GRID = exports.CAVE_DECOR = exports.CAVE_LIGHTS = exports.CAVE_DEPTH = exports.CAVE_EXIT = exports.CAVE_SPAWN = exports.CAVE_MOUTH_X = exports.CAVE_WATER = exports.CAVE_ROCK_H = exports.CAVE_H = exports.CAVE_W = void 0;
exports.caveRock = caveRock;
exports.caveRockTile = caveRockTile;
exports.caveWaterTile = caveWaterTile;
exports.CAVE_W = 24;
exports.CAVE_H = 17;
/** Altura da rocha em pixels de tela. Menos que a parede da sala, mais que o peitoril. */
exports.CAVE_ROCK_H = 21;
/** 1 = rocha, 0 = vazios onde se pisa (ou se nada). */
const rocha = new Uint8Array(exports.CAVE_W * exports.CAVE_H).fill(1);
const dentro = (x, y) => x >= 0 && y >= 0 && x < exports.CAVE_W && y < exports.CAVE_H;
const noAnel = (x, y) => x === 0 || y === 0 || x === exports.CAVE_W - 1 || y === exports.CAVE_H - 1;
/** Escava um retângulo inclusive. Nada fora do anel externo vira piso. */
function escavar(x0, y0, x1, y1) {
    for (let y = Math.max(1, y0); y <= Math.min(exports.CAVE_H - 2, y1); y++) {
        for (let x = Math.max(1, x0); x <= Math.min(exports.CAVE_W - 2, x1); x++)
            rocha[y * exports.CAVE_W + x] = 0;
    }
}
/**
 * O traçado. Três câmaras grandes ligadas por passagens de duas pedras de largura, com a
 * galeria da boca na frente e o ninho no fundo: a rota é comprida de propósito, para que
 * atravessar a caverna seja travessia e não porta ao lado de porta.
 *
 * As paredes têm no mínimo duas pedras de espessura. Com uma só, o desgaste abaixo furaria
 * a parede de um lado ao outro e as câmaras virariam uma tigela.
 */
// Galeria da boca: o único chão que vê o dia, e por isso encostada na frente.
escavar(3, 9, 10, 14);
// O corredor da entrada, do fundo da galeria até a parede da frente.
escavar(5, 15, 8, 15);
// Sala dos lagos, no fundo oeste: a água mora longe da boca.
escavar(1, 1, 10, 5);
// Salão leste, a câmara larga do meio.
escavar(14, 6, 21, 14);
// Ninho, a câmara alta e apertada do fundo leste.
escavar(14, 1, 22, 3);
// Passagens: duas pedras de largura, o mínimo para um corpo encostar e ainda passar.
escavar(5, 6, 6, 8); // galeria → sala dos lagos
escavar(11, 11, 13, 12); // galeria → salão
escavar(17, 4, 18, 5); // salão → ninho
/**
 * Dado da pedra, determinístico e sem semente: a mesma caverna em todo boot e em todo
 * checador, igual ao resto do gerador, que nunca usa Math.random.
 */
function dado(x, y) {
    let h = Math.imul(x + 1, 73856093) ^ Math.imul(y + 1, 19349663) ^ Math.imul(x * y + 7, 83492791);
    h = Math.imul(h ^ (h >>> 13), 59727137);
    return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}
/**
 * O desgaste. Duas regras, e as duas só abrem vazio: escavar nunca fecha passagem nem
 * desconecta sala, que é o motivo pelo qual a caverna é desenhada assim e não ao contrário.
 * Cada pedra aberta encosta por uma face em chão que já existia, então o vazio inteiro
 * continua um só — e o desenho lê a grade pronta, nunca a mordida no meio do caminho.
 *
 * - Pedra que já está mordida por três lados cai: são os dentes que sobram no vão de uma
 *   passagem, e sem isso a boca de cada sala parece cortada a esquadro.
 * - Pedra de face, com um ou dois lados mordidos, cai às vezes: é o que faz a parede entrar
 *   e sair em nichos. Uma passada sobre a grade congelada decide tudo, então o desgaste não
 *   anda pela parede nem come a espessura mínima de duas pedras das divisórias.
 */
const mordida = Uint8Array.from(rocha);
for (let y = 1; y < exports.CAVE_H - 1; y++) {
    for (let x = 1; x < exports.CAVE_W - 1; x++) {
        if (!mordida[y * exports.CAVE_W + x])
            continue;
        const abertas = (dentro(x + 1, y) && !mordida[y * exports.CAVE_W + x + 1] ? 1 : 0)
            + (dentro(x - 1, y) && !mordida[y * exports.CAVE_W + x - 1] ? 1 : 0)
            + (dentro(x, y + 1) && !mordida[(y + 1) * exports.CAVE_W + x] ? 1 : 0)
            + (dentro(x, y - 1) && !mordida[(y - 1) * exports.CAVE_W + x] ? 1 : 0);
        if (abertas >= 3 || (abertas >= 1 && dado(x, y) < 0.14))
            rocha[y * exports.CAVE_W + x] = 0;
    }
}
/** Vazios d'água: piso de nado, não de caminhada. Ficam longe da boca de propósito. */
exports.CAVE_WATER = [
    { x0: 2, y0: 2, x1: 4, y1: 3 },
    { x0: 7, y0: 3, x1: 9, y1: 4 },
    { x0: 15, y0: 12, x1: 17, y1: 13 },
];
for (const poça of exports.CAVE_WATER)
    escavar(poça.x0, poça.y0, poça.x1, poça.y1);
/** A rocha sob o pé: a colisão e o desenho leem este único array. */
function caveRock(x, y) {
    const tx = Math.floor(x);
    const ty = Math.floor(y);
    if (!dentro(tx, ty))
        return true;
    return rocha[ty * exports.CAVE_W + tx] === 1;
}
function caveRockTile(tx, ty) {
    if (!dentro(tx, ty))
        return true;
    return rocha[ty * exports.CAVE_W + tx] === 1;
}
function caveWaterTile(tx, ty) {
    return exports.CAVE_WATER.some((p) => tx >= p.x0 && tx <= p.x1 && ty >= p.y0 && ty <= p.y1);
}
/** Boca da caverna, na parede da frente: por onde se entra e para onde se volta. */
exports.CAVE_MOUTH_X = 6.5;
exports.CAVE_SPAWN = { x: exports.CAVE_MOUTH_X, y: 14.4 };
exports.CAVE_EXIT = { x: exports.CAVE_MOUTH_X, y: exports.CAVE_H - 0.4 };
/**
 * A fresta do ninho. Ainda não leva a lugar nenhum — é pela fresta que a região isolada
 * vai encostar aqui, e enquanto ela não existe o recado é "dá para ver, não dá para ir".
 */
exports.CAVE_DEPTH = { x: 20.5, y: 1.6 };
/**
 * Onde a caverna tem luz própria, e quão longe ela alcança. É tinta: cada fonte despeja um
 * halo e o escuro é o que sobra onde nenhum halo chega.
 *
 * - `dia` é a boca: a única luz que entra de fora, larga e fria.
 * - `fenda` é o dia que vaza de uma rachadura no teto, num ponto qualquer do chão.
 * - `poça` é o reflexo da água parada, fraco e azulado.
 */
exports.CAVE_LIGHTS = [
    { x: exports.CAVE_MOUTH_X, y: exports.CAVE_H - 0.2, raio: 4.6, kind: 'dia' },
    { x: 6.8, y: 11.4, raio: 3.1, kind: 'fenda' },
    { x: 16.2, y: 9.2, raio: 3.4, kind: 'fenda' },
    { x: 4.4, y: 4.6, raio: 2.6, kind: 'fenda' },
    { x: 3, y: 2.5, raio: 1.6, kind: 'poça' },
    { x: 8, y: 3.5, raio: 1.6, kind: 'poça' },
    { x: 16, y: 12.5, raio: 1.6, kind: 'poça' },
];
exports.CAVE_DECOR = [
    { id: 'stal-1', kind: 'stalagmite', x: 8.6, y: 9.6, w: 0.5, d: 0.5, height: 30, color: '#7d7266' },
    { id: 'stal-2', kind: 'stalagmite', x: 3.4, y: 12.8, w: 0.42, d: 0.42, height: 22, color: '#8a7f72' },
    { id: 'col-1', kind: 'column', x: 18.4, y: 7.4, w: 0.9, d: 0.9, height: 40, color: '#6f675d' },
    { id: 'col-2', kind: 'column', x: 15.4, y: 8.6, w: 0.8, d: 0.8, height: 34, color: '#787066' },
    { id: 'stal-3', kind: 'stalagmite', x: 2.2, y: 4.4, w: 0.45, d: 0.45, height: 24, color: '#837869' },
    { id: 'stal-4', kind: 'stalagmite', x: 9.2, y: 1.6, w: 0.5, d: 0.5, height: 28, color: '#7d7266' },
    { id: 'col-3', kind: 'column', x: 19.6, y: 13.2, w: 0.85, d: 0.85, height: 44, color: '#6b645a' },
    { id: 'bones-1', kind: 'bones', x: 15.6, y: 2.1, w: 0.7, d: 0.5, height: 5, color: '#d8cfbe' },
    { id: 'bones-2', kind: 'bones', x: 20.6, y: 2.6, w: 0.55, d: 0.45, height: 4, color: '#cfc4b0' },
];
/** Planta exposta para os checadores: a grade de rocha, tile a tile. */
exports.CAVE_GRID = rocha;
