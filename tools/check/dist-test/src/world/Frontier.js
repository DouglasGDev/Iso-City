"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GRAMA_DA_CIDADE = exports.NOME_DA_FACE = exports.PROFUNDIDADE_SEM_NOME = exports.PROFUNDIDADE_MAXIMA_DA_MATA = exports.MATA_FECHADA = exports.MATA_DA_ORLA = exports.SEMENTE_DA_FRONTEIRA = exports.FRONTEIRA_ALCANCE = void 0;
exports.sorte = sorte;
exports.foraDoMapa = foraDoMapa;
exports.profundidade = profundidade;
exports.faceDaFronteira = faceDaFronteira;
exports.nomeDaTerra = nomeDaTerra;
exports.densidadeDaMata = densidadeDaMata;
exports.árvoreDoTile = árvoreDoTile;
exports.limiteJogável = limiteJogável;
exports.seguraNaFronteira = seguraNaFronteira;
exports.empurraDoTronco = empurraDoTronco;
exports.luzDoDossel = luzDoDossel;
exports.tintaDoChão = tintaDoChão;
exports.chãoDaFronteira = chãoDaFronteira;
exports.biomaDaFronteira = biomaDaFronteira;
exports.rioDaFronteira = rioDaFronteira;
exports.chaveDoTile = chaveDoTile;
exports.tilesDaFronteira = tilesDaFronteira;
exports.tileDaChave = tileDaChave;
const Tribo_1 = require("./Tribo");
/**
 * A fronteira é o que existe fora da grade do mapa.
 *
 * Até aqui o mundo terminava num `Math.min(worldW - raio, ...)`: o jogador corria contra o
 * nada e era empurrado de volta, sem parede, sem árvore, sem explicação — o buraco onde a
 * cidade acaba é a coisa mais falsa que um mapa isométrico pode mostrar. O pedido é o
 * contrário: fora da cidade tem de haver **árvore**, tanto que até atrapalha o passo, e o
 * caminho tem de não acabar. Não acabar de verdade, não "um anel de floresta larguíssimo":
 * andam-se cem tiles para fora e a mata continua igual, porque ela nunca foi um lugar
 * guardado no mapa — ela é uma *função* da coordenada.
 *
 * Isso é possível por uma razão que já era verdadeira no motor e ninguém tinha explorado:
 * nenhuma leitura do mundo quebra fora da grade. `heightSmoothAt` satura na coluna da borda
 * (superfície contínua, sem degrau na emenda), `tileKindAt` e `biomeAt` devolvem `null`,
 * `isWaterWorld` devolve `false`, o índice de chunk satura e o streaming simplesmente nunca
 * pede o que não existe. Ou seja: o que faltava não era permissão para sair, era **matéria**
 * lá fora. Esta camada cria essa matéria de forma determinística — sem gerador, sem tile
 * novo, sem orçamento de memória novo, sem tocar um caractere da planta da cidade.
 *
 * A determinística é a outra metade do contrato. Hash puro de `(tx, ty)` quer dizer que a
 * árvore em (-18, 240) é a mesma hoje, amanhã e em qualquer aparelho, que o check em memória
 * pode cobrar a mesma árvore que o render desenha, e que nada aqui precisa ser salvo no
 * arquivo de missão: quem salva a coordenada salva a floresta junto. É também o que permite
 * ao chão desenhado e ao tronco que barra serem **a mesma chamada** — floresta pintada onde
 * não se pode passar é decoração, floresta que barra onde está pintada é mapa.
 */
/** Tiles de mata além de cada borda antes do muro invisível. Nada nesta vida chega lá. */
exports.FRONTEIRA_ALCANCE = 140;
/** Sal da fronteira: trocá-la reescreve a mata inteira, e isso é uma decisão de designer. */
exports.SEMENTE_DA_FRONTEIRA = 0x1f7a3d;
/**
 * Densidade de tronco por tile, nos dois extremos da curva. A orla é quase aberta de
 * propósito: a beira do mapa é campo, e uma parede de pinheiros colada na última fila de
 * tiles faria a fronteira parecer um muro pintado. Ela fecha conforme se anda para fora, e é
 * esse fechar — lento, medido — que vende o "sem fim" melhor do que qualquer distância.
 */
exports.MATA_DA_ORLA = 0.05;
exports.MATA_FECHADA = 0.46;
/** A partir desta profundidade a mata não engrossa mais: só continua. */
exports.PROFUNDIDADE_MAXIMA_DA_MATA = 26;
/**
 * A partir daqui a terra não tem nome de cidade — e é daqui para fora que a tribo mora. A
 * constante é compartilhada de propósito: o que faz a HUD dizer "a terra sem nome" tem de ser o
 * mesmo número que faz o acampamento existir, senão o jogador entraria na aldeia ainda ouvindo
 * "a mata velha", ou veria cabana onde a frente ainda chama aquilo de mata dela.
 *
 * É também o teto da banda do gigante: `GorilaSystem` importa este mesmo número para saber onde
 * ele para. Uma fronteira entre dois predadores tem de ser uma linha que o jogador *lê* no nome
 * que a HUD diz, e não um segundo número sorteado — com dois números, a faixa entre eles seria a
 * terra de ninguém com dois donos dentro.
 */
exports.PROFUNDIDADE_SEM_NOME = 40;
/** Clareiras do maciço: um tile de mata em três nunca tem tronco, e é o que deixa andar. */
const CELULA_DO_MACIÇO = 3;
const MACIÇO_ABERTO = 0.24;
/** O tronco que barra, por espécie — a largura visível do pé, não a copa desenhada. */
const TRONCO_DOS_SPRITES = {
    prop_tree_common_medium: 0.15,
    prop_tree_common_large: 0.19,
    prop_tree_pine_small: 0.14,
    prop_tree_pine_medium: 0.18,
    prop_tree_pine_tall: 0.22,
    prop_trunk_b: 0.13,
};
/**
 * Hash inteiro → [0,1). Três `sal` por tile dão eixos independentes: presença, escolha de
 * espécie e deslocamento do pé. Não é ruído de valor — não precisa ser: o olho lê a mata como
 * maciço pelo agrupamento de três tiles, não pela correlação de um noise.
 *
 * É exportada porque o que nasce da fronteira tem de nascer do MESMO sal que o chão dela: o
 * gorila escolhe de onde emerge com esta função, e um `Math.random` lá faria o ponto de
 * nascimento depender do quadro em que a semente foi sorteada — algo que um check em memória
 * não consegue reproduzir e que o jogador sentiria como "apareceu do nada".
 */
function sorte(tx, ty, sal) {
    let h = exports.SEMENTE_DA_FRONTEIRA ^ Math.imul(tx | 0, 0x1b873593)
        ^ Math.imul(ty | 0, 0xcc9e2d51) ^ Math.imul(sal | 0, 0x165667b1);
    h ^= h >>> 16;
    h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
}
/** A grade do mapa em unidades de mundo: `worldW === tilesW`, então o lado de fora começa em `>= W`. */
function foraDoMapa(x, y, W, H) {
    return x < 0 || y < 0 || x >= W || y >= H;
}
/** Quantos tiles o corpo está além da borda mais perto, no sentido de saída. */
function profundidade(x, y, W, H) {
    const dx = Math.max(0, -x, x - W);
    const dy = Math.max(0, -y, y - H);
    return Math.hypot(dx, dy);
}
/**
 * Para onde o jogador saiu, na fala do jogo. O eixo que percorre é o da face: -x é noroeste
 * na tela porque `worldToScreen` faz X crescer para sudeste — é a mesma convenção do `Dir4`
 * do resto do código, então "a pé para o NW" e "a seta da bússola" não contam histórias
 * diferentes.
 */
function faceDaFronteira(x, y, W, H) {
    const oeste = Math.max(0, -x);
    const leste = Math.max(0, x - W);
    const norte = Math.max(0, -y);
    const sul = Math.max(0, y - H);
    const maior = Math.max(oeste, leste, norte, sul);
    if (maior <= 0)
        return null;
    if (maior === oeste)
        return 'NW';
    if (maior === leste)
        return 'SE';
    return maior === norte ? 'NE' : 'SW';
}
exports.NOME_DA_FACE = {
    NW: 'a pé para o noroeste',
    SE: 'a pé para o sudeste',
    NE: 'a pé para o nordeste',
    SW: 'a pé para o sudoeste',
};
/** O nome da terra conforme a profundidade — a frase que a HUD diz, nunca um número solto. */
function nomeDaTerra(prof) {
    if (prof <= 0)
        return 'a cidade';
    if (prof < 3)
        return 'a orla';
    if (prof < 12)
        return 'a mata fechada';
    if (prof < exports.PROFUNDIDADE_SEM_NOME)
        return 'a mata velha';
    return 'a terra sem nome';
}
/**
 * Densidade de troncos: a orla quase aberta, o mato fechando até os 26 tiles e depois só
 * continua. Sem teto a densidade passaria de um e a mata viraria parede intransponível, o
 * que trocaria um muro invisível por um muro visível — e o pedido foi o oposto: árvore que
 * atrapalha, não árvore que tranca.
 */
function densidadeDaMata(prof) {
    if (prof <= 0)
        return exports.MATA_DA_ORLA;
    const t = Math.min(1, prof / exports.PROFUNDIDADE_MAXIMA_DA_MATA);
    return exports.MATA_DA_ORLA + (exports.MATA_FECHADA - exports.MATA_DA_ORLA) * t;
}
/**
 * A espécie pelo quanto se saiu do mapa: folha larga na orla, conífera no fundo, como o
 * §8 do gerador faz com a altitude. A mata velha é mais alta e mais escura de propósito —
 * é a escala que diz ao jogador que ele foi longe demais, sem precisar de HUD.
 */
function espécieDaProfundidade(prof, r) {
    if (prof < 3)
        return r < 0.55 ? 'prop_tree_common_medium' : 'prop_tree_common_large';
    if (prof < 12)
        return r < 0.35 ? 'prop_tree_common_large'
            : r < 0.7 ? 'prop_tree_pine_medium' : 'prop_tree_pine_small';
    return r < 0.12 ? 'prop_trunk_b' : r < 0.55 ? 'prop_tree_pine_tall' : 'prop_tree_pine_medium';
}
/**
 * A árvore deste tile de fora, ou `null` quando ali há só chão. Chamada pelo render (para
 * desenhar) e pelo movimento (para barrar) com as MESMAS coordenadas de tile: é o único
 * jeito de a tinta do chão e o tronco que empurra o jogador nunca divergirem.
 *
 * `água` vem de fora porque só o mapa sabe onde o rio continua: floresta dentro do canal
 * seria tronco desenhado sobre água pintada e, o que importa para quem joga, uma parede no
 * meio da única estrada líquida que existe para fora do mundo.
 */
function árvoreDoTile(tx, ty, W, H, água) {
    if (!Number.isFinite(tx) || !Number.isFinite(ty))
        return null;
    if (tx >= 0 && ty >= 0 && tx < W && ty < H)
        return null;
    if (água.isWaterWorld(tx + 0.5, ty + 0.5))
        return null;
    // A clareira é uma terra pisada, não um erro de desenho: quem pinta o chão, quem barra o
    // tronco e quem desenha a cabana consultam a MESMA função do `Tribo`. Se a mata fosse
    // consultada só no movimento, o chão apareceria com copa por cima da fogueira.
    if ((0, Tribo_1.clareiraNoTile)(tx, ty, W, H, água))
        return null;
    const prof = profundidade(tx + 0.5, ty + 0.5, W, H);
    // Os últimos dois tiles antes do limite invisível são clareira aberta. Não é capricho de
    // paisagismo: tronco empurra para fora, o `limiteJogável` empurra para dentro, e um corpo
    // espremido entre os dois vibra num lugar só. Sem árvore na beirada, quem chega no fim do
    // mundo para sozinho, e a clareira ainda avisa que ali a mata acaba sem precisar de muro.
    if (prof > exports.FRONTEIRA_ALCANCE - 2)
        return null;
    const cx = Math.floor(tx / CELULA_DO_MACIÇO), cy = Math.floor(ty / CELULA_DO_MACIÇO);
    if (sorte(cx, cy, 7) < MACIÇO_ABERTO)
        return null;
    if (sorte(tx, ty, 1) > densidadeDaMata(prof))
        return null;
    const chave = espécieDaProfundidade(prof, sorte(tx, ty, 2));
    const tronco = TRONCO_DOS_SPRITES[chave] ?? 0.16;
    // O pé sai do centro do tile com folga de meio tile: árvore alinhada em grade é pomar, e
    // pomar no meio do nada denunciaria a função que ela é.
    const ox = (sorte(tx, ty, 3) - 0.5) * 0.66;
    const oy = (sorte(tx, ty, 4) - 0.5) * 0.66;
    const escala = 1 + sorte(tx, ty, 5) * 0.25 + Math.min(0.35, prof * 0.012);
    return { chave, x: tx + 0.5 + ox, y: ty + 0.5 + oy, escala, tronco };
}
/** Onde o corpo pode pisar: o mapa e a mata sem fim em volta dele, com a folga do próprio raio. */
function limiteJogável(v, tamanho, raio) {
    if (!Number.isFinite(v))
        return raio;
    return Math.max(raio - exports.FRONTEIRA_ALCANCE, Math.min(tamanho + exports.FRONTEIRA_ALCANCE - raio, v));
}
/**
 * O passo de quem saiu do mapa: segura no alcance jogável e desvia do tronco, na ordem que
 * os dois não se contradizem. É a única porta de entrada que o movimento precisa conhecer —
 * trocar o `Math.max(raio, Math.min(worldW - raio, …))` do jogador por esta chamada dá o
 * mapa inteiro mais a mata em volta num único movimento, e dentro da cidade o tronco nem é
 * consultado.
 */
function seguraNaFronteira(corpo, W, H, água) {
    corpo.x = limiteJogável(corpo.x, W, corpo.radius);
    corpo.y = limiteJogável(corpo.y, H, corpo.radius);
    // O empurrão vem depois: ele é o que faz a mata parecer sólida. Se viesse antes, o limite
    // o anularia nos tiles da beirada e o jogador atravessaria árvore andando para fora.
    const tronco = empurraDoTronco(corpo, W, H, água);
    // A cabana vem depois do tronco porque ela é o destino de quem entrou no acampamento: ser
    // empurrado para fora de uma parede de palha e cair em cima de um tronco, que empurra de
    // volta para a clareira, seria os dois colisores brigando pelo mesmo corpo. Com esta ordem o
    // corpo para numa das duas coisas e o passo trava no lugar certo.
    const cabana = (0, Tribo_1.empurraDoAcampamento)(corpo, W, H, água);
    if (tronco || cabana) {
        corpo.x = limiteJogável(corpo.x, W, corpo.radius);
        corpo.y = limiteJogável(corpo.y, H, corpo.radius);
    }
}
/**
 * Empurra o corpo para fora dos troncos que ele invadiu. Mora aqui, e não na grade de
 * colisores do mapa, por dois motivos: a floresta não tem lista de objetos para indexar (ela
 * é derivada da coordenada, e 40 mil troncos na `queryNearby` da cidade seria pagar por uma
 * mata que ninguém vê), e o tronco é um pino redondo — um círculo contra um círculo não
 * precisa do motor de AABB nem do histórico de recuo de um prédio.
 *
 * Varre só os tiles que o corpo toca, e só quando ele está fora: dentro da cidade a função
 * devolve `false` na primeira comparação, e o passo de quem anda na rua não paga nada por
 * uma mata que não está lá.
 */
function empurraDoTronco(corpo, W, H, água) {
    if (!foraDoMapa(corpo.x, corpo.y, W, H))
        return false;
    if (!Number.isFinite(corpo.x) || !Number.isFinite(corpo.y) || !(corpo.radius > 0))
        return false;
    const r = corpo.radius;
    const x0 = Math.floor(corpo.x - r), x1 = Math.floor(corpo.x + r);
    const y0 = Math.floor(corpo.y - r), y1 = Math.floor(corpo.y + r);
    let tocado = false;
    for (let ty = y0; ty <= y1; ty++) {
        for (let tx = x0; tx <= x1; tx++) {
            const árvore = árvoreDoTile(tx, ty, W, H, água);
            if (!árvore)
                continue;
            const alcance = r + árvore.tronco;
            const dx = corpo.x - árvore.x;
            const dy = corpo.y - árvore.y;
            const d = Math.hypot(dx, dy);
            if (d >= alcance)
                continue;
            if (d < 1e-4) {
                // Em cima exato do pé: qualquer direção serve, e o SE é o único canto que sempre
                // existe — um corpo nunca some por falta de para onde empurrar.
                corpo.x += alcance;
                corpo.y += alcance;
            }
            else {
                corpo.x += dx * (alcance - d) / d;
                corpo.y += dy * (alcance - d) / d;
            }
            tocado = true;
        }
    }
    return tocado;
}
/**
 * Luz do dossel: 1 na orla, escurecendo até 0,62 no fundo. Não é sombra do relevo (fora do
 * mapa não há encosta) — é tinta de copa fechando por cima de quem entra, e é o único
 * indicador de profundidade que o jogador lê sem olhar número nenhum.
 */
function luzDoDossel(prof) {
    return Math.max(0.62, 1 - Math.min(1, prof / 60) * 0.38);
}
/**
 * Tinta do chão da mata: o mesmo verde-terra dos tiles de campo e pinhal, trocando a cara
 * conforme a profundidade. Uma única cor chapada faria a fronteira parecer o fundo de tela
 * que ela substituiu; a variação por tile, derivada do mesmo hash, é o que dá ao losango a
 * mesma textura granulada que o gerador dá à cidade.
 */
function tintaDoChão(tx, ty, prof) {
    const v = sorte(tx, ty, 9);
    const escuro = sorte(tx, ty, 11) < 0.14;
    if (escuro)
        return prof < 6 ? '#46523a' : '#2f3b2c';
    if (v < 0.3)
        return prof < 6 ? '#6b7a4c' : '#405034';
    if (v < 0.62)
        return prof < 6 ? '#61703f' : '#39492e';
    return prof < 6 ? '#57663c' : '#334229';
}
/** O nome do tile que veste a cidade onde a beira não tem material nenhum. */
exports.GRAMA_DA_CIDADE = 'tile_ground_grass';
/**
 * O vizinho de dentro de um tile de fora: a última linha da grade, na direção do mapa. Uma
 * conta só para o chão e para o rio, porque as duas têm de concordar — um canal pintado como
 * água e barrado como mata seria o pior dos dois.
 */
function beira(W, H, tx, ty) {
    const bx = Math.min(W - 1, Math.max(0, tx));
    const by = Math.min(H - 1, Math.max(0, ty));
    return by * W + bx;
}
/**
 * O chão sem fim é o tile da cidade, e não UM tile: cada losango fora da grade continua o
 * material da última linha da grade que ele encosta — grama onde a beira é campo, terra onde
 * a savana chega ao limite, areia na praia, água por onde o rio sai do mapa.
 *
 * Medido na malha gerada, a grama é 51% do anel externo; fixar um único tile trocaria de
 * material em quase metade do perímetro, e trocar de material na borda é exatamente o "aqui
 * termina" que esta frente existe para esconder. A variação de TOM continua sendo da
 * profundidade (`tintaDoChão` segura o que não tem sprite, e o dossel escurece o resto), mas a
 * MATÉRIA é a da cidade — porque o limite do mapa não é uma mudança de terreno, é a cidade
 * acabar.
 */
function chãoDaFronteira(tiles, W, H, tx, ty) {
    return tiles[beira(W, H, tx, ty)]?.key || exports.GRAMA_DA_CIDADE;
}
/**
 * O bioma de fora, pela mesma razão do chão: fora da grade não há tile, mas há vizinho.
 *
 * Quem lê `biome` é a névoa (e o áudio do lugar). Sem esta função, a terra sem nome caía no
 * `?? 'residential'` de quem consulta o mapa, e a parede da moldura vestia o azul-cinza do asfalto
 * sobre um chão que continua o material da beira — a fronteira inteira ficava com a cor de uma
 * cidade que não está ali, e numa manhã de névoa isso é a única coisa que sobra do quadro.
 */
function biomaDaFronteira(tiles, W, H, tx, ty) {
    return tiles[beira(W, H, tx, ty)]?.biome ?? 'forest';
}
/**
 * O rio sem fim: onde a beira do mapa é água, o tile de fora é água, e o canal continua para
 * fora com a largura que tinha na borda. Medido nas três seeds do gerador, o rio corta o mapa
 * de lado a lado e sai da grade por (0, 125..130) e por (239, 125..130) — seis tiles de cada
 * boca, e é por esses seis que se nada até onde a neblina alcança.
 *
 * Sem esta regra a frente pintava o rio, plantava tronco sólido dentro dele e deixava quem
 * entrasse andar no leito seco: três leituras da mesma coordenada dizendo três coisas
 * diferentes. Com ela, chão, natação e floresta respondem pela mesma pergunta — e é dentro
 * desse canal que a piranha gigante caça.
 */
function rioDaFronteira(tiles, W, H, tx, ty) {
    return tiles[beira(W, H, tx, ty)]?.kind === 'water';
}
/**
 * Empacotamento de tile em um número. O viés não é enfeite: `ty * 8192 + tx` com `tx`
 * negativo *toma emprestado* do `ty` e a decodificação por divisão inteira devolve a linha
 * errada — a mata do canto apareceria 240 tiles ao sul. Guardar a coluna sempre em [0, 8192)
 * é o que faz `tileDaChave` ser o inverso exato de `chaveDoTile`, inclusive fora do mapa.
 */
const VIÉS_DA_CHAVE = 4096;
/** A chave plana deste tile de fronteira. Válida para ±4096 tiles em x — sobra mata. */
function chaveDoTile(tx, ty) {
    return ty * 8192 + (tx + VIÉS_DA_CHAVE);
}
/**
 * Os tiles fora do mapa que entram num retângulo de mundo. A ordem não é a do pintor
 * isométrico — quem desenha ordena por profundidade do próprio nó, como já faz com a
 * estática do chunk. Devolvido em chaves planas para o chamador não carregar objeto por
 * tile — são centenas por quadro.
 */
function tilesDaFronteira(minX, maxX, minY, maxY, W, H, out) {
    out.length = 0;
    const x0 = Math.floor(Math.min(minX, maxX)), x1 = Math.floor(Math.max(minX, maxX));
    const y0 = Math.floor(Math.min(minY, maxY)), y1 = Math.floor(Math.max(minY, maxY));
    for (let ty = y0; ty <= y1; ty++) {
        for (let tx = x0; tx <= x1; tx++) {
            if (tx >= 0 && ty >= 0 && tx < W && ty < H)
                continue;
            out.push(chaveDoTile(tx, ty));
        }
    }
}
/** Decodifica a chave plana de `tilesDaFronteira`. */
function tileDaChave(chave) {
    const ty = Math.floor(chave / 8192);
    return { tx: chave - ty * 8192 - VIÉS_DA_CHAVE, ty };
}
