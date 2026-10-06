"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RAIO_DA_CABANA = exports.CLAREIRA_MEIA_ALTURA = exports.CLAREIRA_MEIA_LARGURA = exports.CÉLULA_DA_TRIBO = exports.PORTA_ALCANCE = exports.FOLGA_DA_JURISDIÇÃO = void 0;
exports.terraDaTribo = terraDaTribo;
exports.densidadeDoTerritório = densidadeDoTerritório;
exports.acampamentoDaCélula = acampamentoDaCélula;
exports.acampamentoDoTile = acampamentoDoTile;
exports.clareiraNoTile = clareiraNoTile;
exports.acampamentoEm = acampamentoEm;
exports.jurisdiçãoDaAldeia = jurisdiçãoDaAldeia;
exports.acampamentoQueRecebe = acampamentoQueRecebe;
exports.terraDaAldeia = terraDaAldeia;
exports.expulsaDaClareira = expulsaDaClareira;
exports.empurraDoAcampamento = empurraDoAcampamento;
exports.pinosDoAcampamento = pinosDoAcampamento;
exports.pontoDaAmarra = pontoDaAmarra;
exports.aldeiaMaisPerto = aldeiaMaisPerto;
exports.célulaDaTribo = célulaDaTribo;
const Frontier_1 = require("./Frontier");
/**
 * A tribo é a última coisa que existe antes do mundo acabar.
 *
 * A fronteira já era uma função da coordenada — nada de mata é guardado em arquivo, a árvore de
 * (-18, 240) é a mesma árvore em qualquer aparelho — e o território deles tem de ser a mesma
 * espécie de coisa por três razões concretas, nenhuma delas estética:
 *
 * 1. Não há como *salvar* uma aldeia infinita. Se o acampamento fosse um objeto criado por um
 *    gerador, ele nasceria quando o jogador chega e morreria quando ele sai, e a primeira
 *    cabana vazia que o jogador visse ao voltar denunciaria a máquina. Hash puro quer dizer
 *    que a aldeia estava lá antes de você olhar e continua depois que você desvia a câmera.
 * 2. O render, o movimento e o sistema de guerreiros precisam concordar sobre onde é clareira e
 *    onde é mata. Com um gerador, essa concordaria seria uma sincronização; com uma função, é a
 *    mesma chamada.
 * 3. O check em memória pode cobrar a aldeia inteira sem navegador: recalcular o acampamento a
 *    partir de uma coordenada é exatamente o que o render faz.
 *
 * O lugar também não é um recorte no mapa — é uma banda de profundidade. `nomeDaTerra` já dizia
 * que a partir de `PROFUNDIDADE_SEM_NOME` a terra não tem nome de cidade nenhuma; aqui essa
 * mesma fronteira numérica vira posse: é dali para fora que eles vivem, e é por isso que a
 * constante mora no `Frontier` e é importada, e não copiada.
 */
/** Lado da célula que guarda um acampamento candidato, em tiles. */
const CÉLULA_DA_TRIBO = 24;
exports.CÉLULA_DA_TRIBO = CÉLULA_DA_TRIBO;
/**
 * O centro nunca sai da célula por mais do que isto. Junto com a meia-largura da clareira, é o
 * que garante que uma clareira cabe dentro da própria célula — e é isso que permite a pergunta
 * "estou na clareira de alguém?" custar UMA hash: o ponto consulta a célula que o contém e nada
 * mais. Sem essa invariante seria preciso varrer a vizinhança 3×3 a cada tile de árvore, cada
 * corpo, cada quadro.
 */
const RECUO_DA_CÉLULA = 2;
const CLAREIRA_MEIA_LARGURA = 6;
exports.CLAREIRA_MEIA_LARGURA = CLAREIRA_MEIA_LARGURA;
const CLAREIRA_MEIA_ALTURA = 5;
exports.CLAREIRA_MEIA_ALTURA = CLAREIRA_MEIA_ALTURA;
/** Até onde a tribo se afasta: depois disso é o muro invisível, e ninguém mora num muro. */
const FOLGA_DA_BORDA_EXTERNA = 24;
/**
 * O anel das cabanas, por acampamento e não por cabana: cada lugar sorteia um par de raios e
 * todas as casas dele o vestem. É a conta que faz a prova "nenhuma cabana dentro da outra"
 * ser verdade por geometria e não por sorteio — com raio próprio por casa, duas cabanas
 * vizinhas podem cair a um tile de distância e o lugar vira um amontoado intransponível.
 *
 * O chão da prova: dois pontos do anel separados de `Δθ` estão a pelo menos
 * `2·RY_DO_ANEL·sin(Δθ/2)` um do outro (a corda mais curta de uma elipse é a do eixo menor), e o
 * `Δθ` mais apertado que este código produz é `(2π - VÃO_DA_ENTRADA)·(1 - FOLGA_ANGULAR)/6`. Com
 * os números acima dá 2,11 tiles de corda contra 1,93 de duas casas no maior tamanho — as cabanas
 * não se tocam, e a fogueira no centro fica a mais de um tile e meio de qualquer uma delas.
 */
const RX_DO_ANEL = 3.9;
const RY_DO_ANEL = 3.0;
/** Folga de forma: o anel é ovalado por lugar, nunca um círculo perfeito de forte militar. */
const VARIAÇÃO_DO_ANEL = 0.2;
/**
 * O vão deixado livre na frente do lugar, em radianos de parâmetro: é a porta, e ela tem de ser
 * o vão mais largo do anel — medido no mapa gerado, a boca fica a pelo menos 0,8 rad de qualquer
 * cabana, e é isso que faz entrar num acampamento parecer entrar num lugar.
 */
const VÃO_DA_ENTRADA = 1.2;
/** O quanto uma casa pode escorregar do seu lugar no anel, em fração do vão entre vizinhas. */
const FOLGA_ANGULAR = 0.12;
/**
 * Escala do desenho. O teto é o que segura a conta do anel: `RAIO_DA_CABANA · MÁXIMA_ESCALA` é a
 * metade da corda mínima entre duas casas, e é por isso que ela não passa de 1,05.
 */
const MÁXIMA_ESCALA = 1.05;
/** Pinos que barram o passo — o mesmo pino redondo do tronco, sem AABB e sem grade. */
const RAIO_DA_CABANA = 0.92;
exports.RAIO_DA_CABANA = RAIO_DA_CABANA;
const RAIO_DO_TOTEM = 0.3;
const RAIO_DA_FOGUEIRA = 0.45;
/**
 * O poste do cativeiro: onde eles amarram quem levam para a fogueira. Fino de propósito — é um
 * pino de amarrar gente, não uma parede, e um poste largo bastaria para fechar o terreiro entre a
 * fogueira e as casas em algumas aldeias.
 */
const RAIO_DO_POSTE = 0.26;
/**
 * Distância do poste ao centro, em fração dos raios do anel das cabanas. É 0,46 por aritmética e
 * não por gosto: o anel está em 1,0 e a fogueira em 0, então o poste fica no meio do terreiro, a
 * 0,54 do raio de uma casa — no eixo curto isso vale 1,56 tile entre centros contra 1,23 da soma
 * dos dois pinos, e 1,33 até a fogueira contra 0,71 da soma dela com o poste. Nenhum dos dois
 * encosta nele, e é por isso que ele pode ser um pino listado junto das casas: `empurraDoAcampamento`
 * empurraria o corpo para fora de uma casa em que ele estivesse plantado. O `check-tribo` mede o
 * pior caso sobre todas as aldeias dos dois mapas, porque uma constante derivada de desenho seria o
 * poste dentro de uma cabana em algum hash que ninguém olhou.
 */
const FRAÇÃO_DO_POSTE = 0.46;
/**
 * O vão angular, em radianos, em torno do ponto exato oposto à porta. O poste fica no fundo da
 * aldeia porque é de lá que se foge: amarrar alguém na boca seria deixar a corda a um passo da
 * saída, e a janela de fuga deixaria de ser uma janela para virar uma porta aberta.
 */
const VÃO_DO_POSTE = 1.1;
/**
 * O dedo de folga entre o corpo amarrado e o poste. Zero seria o corpo *tocando* o pino, e um
 * `empurraDoAcampamento` com vírgula flutuante no meio decide tocar de um jeito e empurrar do
 * outro; a folga é o que faz o ponto da amarra estar do lado de fora do colisor por construção.
 */
const FOLGA_DA_AMARRA = 0.02;
/** A terra é deles? É a mesma régua do nome, lida da mesma constante. */
function terraDaTribo(prof) {
    return prof >= Frontier_1.PROFUNDIDADE_SEM_NOME;
}
/**
 * Quantos acampamentos por célula conforme a profundidade.
 *
 * Começa ralo na orla do território e fecha no fundo, do mesmo jeito que `densidadeDaMata`
 * fecha a mata: a progressão é o que faz o jogador sentir que entrou numa posse em vez de
 * tropeçar no mesmo cenário para sempre. E morre antes do muro invisível — acampamento colado
 * no `limiteJogável` seria cabana no nada, com a borda do mundo cortando a metade dela.
 */
function densidadeDoTerritório(prof) {
    if (!terraDaTribo(prof))
        return 0;
    // O limite externo é lido aqui dentro, e não numa constante de módulo: `Frontier` importa esta
    // camada para saber onde a mata não cresce, então os dois módulos se enxergam, e uma constante
    // que dependesse da inicialização do outro nasceria `undefined` conforme o lado por onde o
    // bundle entrasse. Dentro da função, a leitura sempre acontece depois dos dois existirem.
    const fundo = Frontier_1.FRONTEIRA_ALCANCE - FOLGA_DA_BORDA_EXTERNA;
    if (prof > fundo)
        return 0;
    const t = (prof - Frontier_1.PROFUNDIDADE_SEM_NOME) / (fundo - Frontier_1.PROFUNDIDADE_SEM_NOME);
    return 0.1 + Math.min(1, Math.max(0, t)) * 0.35;
}
/** O centro do acampamento desta célula, ou `null` quando a célula não tem aldeia nenhuma. */
function brutoDaCélula(cx, cy, W, H, água) {
    const sorteio = (0, Frontier_1.sorte)(cx, cy, 61);
    const base = (cx + 0.5) * CÉLULA_DA_TRIBO, topo = (cy + 0.5) * CÉLULA_DA_TRIBO;
    const prof = (0, Frontier_1.profundidade)(base, topo, W, H);
    if (sorteio >= densidadeDoTerritório(prof))
        return null;
    const x = base + ((0, Frontier_1.sorte)(cx, cy, 62) - 0.5) * 2 * RECUO_DA_CÉLULA;
    const y = topo + ((0, Frontier_1.sorte)(cx, cy, 63) - 0.5) * 2 * RECUO_DA_CÉLULA;
    // Nada de aldeia no rio. Não é decorativo: um acampamento sobre o canal comeria a única
    // estrada líquida que existe para fora do mundo e poria uma fogueira dentro da área de caça
    // da piranha. A amostragem cobre a clareira inteira, e não só o centro, porque a beira do
    // canal é justamente onde o rio é largo o bastante para a clareira vazar para dentro dele.
    for (const [ax, ay] of AMOSTRA_DA_CLAREIRA) {
        if (água.isWaterWorld(x + ax * CLAREIRA_MEIA_LARGURA, y + ay * CLAREIRA_MEIA_ALTURA))
            return null;
    }
    return { x, y, prof };
}
/** Os pontos da clareira que precisam ser terra: o centro e os oito rumos da elipse. */
const AMOSTRA_DA_CLAREIRA = [
    [0, 0], [1, 0], [-1, 0], [0, 1], [0, -1],
    [0.72, 0.72], [-0.72, 0.72], [0.72, -0.72], [-0.72, -0.72],
];
/**
 * O acampamento desta célula, montado a partir do hash — sem estado, sem memória, sem ordem de
 * criação. Duas chamadas com a mesma célula e o mesmo mundo devolvem o mesmo lugar, tile a tile,
 * e é isso que o check cobra.
 */
function acampamentoDaCélula(cx, cy, W, H, água) {
    const bruto = brutoDaCélula(cx, cy, W, H, água);
    if (!bruto)
        return null;
    const { x, y, prof } = bruto;
    // A tribo não existe fora do mundo: a entrada deles aponta para a cidade, e a direção da
    // cidade é uma conta exata — o ponto mais perto da grade é o clamp da coordenada. `face`
    // continua sendo a palavra do jogo (a HUD e o guerreiro falam "noroeste"), mas não é ela que
    // posiciona nada: um acampamento a 100 tiles a oeste tem a cidade no +x puro, e plantar a
    // porta na diagonal de uma face seria uma porta que não leva a lugar nenhum.
    const face = (0, Frontier_1.faceDaFronteira)(x, y, W, H) ?? 'SE';
    const rumoX = Math.min(W, Math.max(0, x)) - x;
    const rumoY = Math.min(H, Math.max(0, y)) - y;
    const [vx, vy] = face === 'NW' ? [1, 1] : face === 'SE' ? [-1, -1]
        : face === 'NE' ? [-1, 1] : [1, -1];
    const total = 3 + Math.floor((0, Frontier_1.sorte)(cx, cy, 64) * 4);
    // O anel é sorteado uma vez por lugar e todas as cabanas o seguem; a rotação gira porta,
    // totem e casas juntas — por isso a folga que separa uma casa da outra, e a que as separa da
    // porta, não mudam nunca seja qual for o hash da célula.
    const rx = RX_DO_ANEL + ((0, Frontier_1.sorte)(cx, cy, 65) - 0.5) * VARIAÇÃO_DO_ANEL;
    const ry = RY_DO_ANEL + ((0, Frontier_1.sorte)(cx, cy, 66) - 0.5) * VARIAÇÃO_DO_ANEL;
    const arco = Math.PI * 2 - VÃO_DA_ENTRADA;
    const vão = arco / total;
    // O rumo da cidade em parâmetro de elipse: um ângulo físico não é o ângulo que posiciona o
    // ponto no anel, e é este segundo que casa e totem obedecem.
    const d = Math.hypot(rumoX, rumoY);
    const [ux, uy] = d > 1e-6 ? [rumoX / d, rumoY / d] : [vx, vy];
    const θe = Math.atan2(uy / ry, ux / rx);
    const porta = θe + ((0, Frontier_1.sorte)(cx, cy, 67) - 0.5) * 1.0;
    const cabanas = [];
    for (let i = 0; i < total; i++) {
        // Do centro da porta para trás, e nunca sobre ela: o vão é a entrada, não um vazio de
        // sorteio. A folga por casa vem em fração do vão, e é esse teto que fecha a conta do
        // comentário do anel — sem ele, duas casas poderiam cair uma dentro da outra.
        const θ = porta + VÃO_DA_ENTRADA / 2 + vão * (i + 0.5 + ((0, Frontier_1.sorte)(cx, cy, 70 + i) - 0.5) * FOLGA_ANGULAR);
        const escala = 0.9 + (0, Frontier_1.sorte)(cx, cy, 96 + i) * (MÁXIMA_ESCALA - 0.9);
        cabanas.push({
            x: x + Math.cos(θ) * rx,
            y: y + Math.sin(θ) * ry,
            escala,
            planta: Math.floor((0, Frontier_1.sorte)(cx, cy, 104 + i) * 3),
            raio: RAIO_DA_CABANA * escala,
        });
    }
    // A porta é o ponto do anel voltado para a cidade, e o totem fica nela: entre o mundo de fora
    // e a fogueira, é o marco que diz "aqui se entra". Um totem sorteado à parte seria um poste no
    // meio do mato, e uma casa plantada sobre a porta fecharia o único caminho que o jogador vê.
    const entrada = {
        x: x + Math.cos(porta) * (rx + 1.1),
        y: y + Math.sin(porta) * (ry + 0.85),
    };
    const temTotem = (0, Frontier_1.sorte)(cx, cy, 68) < 0.72;
    const totem = temTotem ? { ...entrada, raio: RAIO_DO_TOTEM } : null;
    // O poste do cativeiro fica no fundo da aldeia, no lado oposto à boca: é de lá que a fuga começa,
    // e a distância até a porta é o que faz a janela de 25 segundos ser uma decisão em vez de um
    // teleporte para fora. O ângulo escorrega ±0,55 rad do ponto exato oposto — o suficiente para o
    // poste não aparecer em fila com a fogueira e a porta em toda aldeia desenhada, pouco demais
    // para ele sair do terreiro. Não depende de sorteio por cabana, então o anel não pode enguli-lo:
    // a prova disso é medida, e mora no check.
    const θp = porta + Math.PI + ((0, Frontier_1.sorte)(cx, cy, 132) - 0.5) * VÃO_DO_POSTE;
    const poste = {
        x: x + Math.cos(θp) * rx * FRAÇÃO_DO_POSTE,
        y: y + Math.sin(θp) * ry * FRAÇÃO_DO_POSTE,
        raio: RAIO_DO_POSTE,
    };
    const ossos = [];
    const quantos = 2 + Math.floor((0, Frontier_1.sorte)(cx, cy, 69) * 4);
    for (let i = 0; i < quantos; i++) {
        ossos.push({
            x: x + ((0, Frontier_1.sorte)(cx, cy, 112 + i) - 0.5) * 8.4,
            y: y + ((0, Frontier_1.sorte)(cx, cy, 120 + i) - 0.5) * 6.6,
        });
    }
    return {
        id: (0, Frontier_1.chaveDoTile)(cx, cy), cx, cy, x, y,
        meiaLargura: CLAREIRA_MEIA_LARGURA, meiaAltura: CLAREIRA_MEIA_ALTURA,
        prof, face, rumo: { x: ux, y: uy }, porta, entrada, cabanas, totem,
        fogueira: { x, y, raio: RAIO_DA_FOGUEIRA },
        poste,
        ossos,
    };
}
/** O acampamento dono deste tile — a célula que o contém, sem varrer vizinhos. */
function acampamentoDoTile(tx, ty, W, H, água) {
    const cx = Math.floor(tx / CÉLULA_DA_TRIBO), cy = Math.floor(ty / CÉLULA_DA_TRIBO);
    const ac = acampamentoDaCélula(cx, cy, W, H, água);
    if (!ac)
        return null;
    return dentroDaClareira(ac, tx + 0.5, ty + 0.5) ? ac : null;
}
/** Dentro da terra pisada? A elipse é a clareira, e a clareira é o que a mata respeita. */
function dentroDaClareira(ac, x, y) {
    const dx = (x - ac.x) / ac.meiaLargura;
    const dy = (y - ac.y) / ac.meiaAltura;
    return dx * dx + dy * dy <= 1;
}
/**
 * A clareira deste tile de fora, se houver. É a versão barata — uma hash de presença, duas de
 * centro e as amostras de água — porque quem chama é `árvoreDoTile`, chamado tile por tile pelo
 * chão pintado e pelo tronco que barra. As cabanas não interessam aqui; o que interessa é só
 * "a mata não cresce neste losango", e nada de alocar objeto por tile para responder a isso.
 */
function clareiraNoTile(tx, ty, W, H, água) {
    if (tx >= 0 && ty >= 0 && tx < W && ty < H)
        return false;
    const cx = Math.floor(tx / CÉLULA_DA_TRIBO), cy = Math.floor(ty / CÉLULA_DA_TRIBO);
    const bruto = brutoDaCélula(cx, cy, W, H, água);
    if (!bruto)
        return false;
    const dx = (tx + 0.5 - bruto.x) / CLAREIRA_MEIA_LARGURA;
    const dy = (ty + 0.5 - bruto.y) / CLAREIRA_MEIA_ALTURA;
    return dx * dx + dy * dy <= 1;
}
/** O acampamento onde este ponto do mundo está, ou `null` em mata aberta. */
function acampamentoEm(x, y, W, H, água) {
    if (!Number.isFinite(x) || !Number.isFinite(y))
        return null;
    if (x >= 0 && y >= 0 && x < W && y < H)
        return null;
    return acampamentoDoTile(Math.floor(x), Math.floor(y), W, H, água);
}
/**
 * A jurisdição do bando: até onde a aldeia alcança, medida do centro da clareira.
 *
 * É um número publicado e não um `if` dentro de cada sistema, por um motivo que é de contrato e não
 * de estilo: o gigante da mata é expulso *daqui*, o guerreiro patrulha *até aqui*, a HUD nomeia o
 * lugar por *isto*, e o check que prova "nenhum ponto do mundo tem dois donos" mede a mesma régua.
 * Com um número por lado, a faixa entre os dois seria a terra de ninguém com dois predadores
 * dentro — exatamente a falha que o rio não tem, porque `isWaterWorld` é um só.
 *
 * Vale 1,45 vez a elipse pintada porque o guerreiro precisa chegar à trilha, onde o jogador aparece,
 * sem jamais sair do próprio território: é a diferença entre defender um lugar e virar um pedestre
 * correndo pelo mapa.
 */
exports.FOLGA_DA_JURISDIÇÃO = 1.45;
/** Para onde um corpo grande é expulso: um fio além da jurisdição, para não voltar a pisar nela. */
const SAÍDA_DA_JURISDIÇÃO = exports.FOLGA_DA_JURISDIÇÃO + 0.05;
/**
 * A boca também é jurisdição. As cabanas fecham o anel *antes* dela e o ponto da entrada fica fora
 * da elipse — um guerreiro que só enxergasse dentro da elipse estaria de costas para o único lugar
 * por onde alguém chega.
 */
exports.PORTA_ALCANCE = 2.4;
/** Esta coordenada está na jurisdição desta aldeia? Elipse dilatada mais a boca. */
function jurisdiçãoDaAldeia(ac, x, y) {
    const u = (x - ac.x) / (ac.meiaLargura * exports.FOLGA_DA_JURISDIÇÃO);
    const v = (y - ac.y) / (ac.meiaAltura * exports.FOLGA_DA_JURISDIÇÃO);
    if (u * u + v * v <= 1)
        return true;
    return Math.hypot(x - ac.entrada.x, y - ac.entrada.y) <= exports.PORTA_ALCANCE;
}
/** A aldeia que recebe este ponto do mundo — a jurisdição, não a elipse pintada. */
function acampamentoQueRecebe(x, y, W, H, água) {
    if (!Number.isFinite(x) || !Number.isFinite(y))
        return null;
    if (x >= 0 && y >= 0 && x < W && y < H)
        return null;
    // O canal sempre vence. A clareira já é garantidamente seca (é a amostra que decide o lugar
    // existir), mas a jurisdição é um anel dilatado em volta dela, e nas aldeias que ficam perto de
    // uma curva do rio essa sobra cai dentro d'água. Sem este corte, o mesmo ponto teria dois donos
    // — o gigante não cobraria, o peixe cobraria, e o guerreiro olharia para o outro lado — que é
    // exatamente a falha que o pedido nomeou. O rio é a geografia mais antiga dos dois.
    if (água.isWaterWorld(x, y))
        return null;
    const cx = Math.floor(x / CÉLULA_DA_TRIBO), cy = Math.floor(y / CÉLULA_DA_TRIBO);
    const ac = acampamentoDaCélula(cx, cy, W, H, água);
    if (!ac)
        return null;
    return jurisdiçãoDaAldeia(ac, x, y) ? ac : null;
}
/**
 * A pergunta que os predadores fazem antes de cobrar alguém: este ponto é terra deles?
 *
 * É o espelho do `isWaterWorld` do rio, e a existência das duas no mesmo lugar é o que impede a
 * fronteira de virar um bolo de gatilhos. O pedido foi explícito — nenhum predador pode cobrar o
 * mesmo trecho — e a única forma de isso ser verdade é os sistemas, a HUD e os checks fazerem a
 * MESMA pergunta a esta função, em vez de cada um reinventar um teste de pertence. Um rio é dono do
 * canal; uma aldeia é dona da sua jurisdição; o resto da mata é do gigante — e a terra sem nome,
 * esta função não alcança: o teto da banda dele é a mesma `PROFUNDIDADE_SEM_NOME` que faz o
 * acampamento existir, então o fundo é posse deles por inteiro, clareira e mato entre as clareiras.
 * Três respostas, uma
 * régua por ponto, e nenhuma constante copiada de um módulo para o outro.
 */
function terraDaAldeia(x, y, W, H, água) {
    return acampamentoQueRecebe(x, y, W, H, água) !== null;
}
/**
 * Empurra um corpo grande para fora da jurisdição, pelo lado de fora.
 *
 * Quem chama é o gigante da mata: ele não pisa a terra deles, exatamente como não pisa o asfalto.
 * A regra é radial porque a clareira é uma elipse e a saída mais curta de uma elipse é pela
 * normal do centro — um corpo expulso assim descreve a borda de fora quando continua andando na
 * direção do alvo, que é o "dá a volta" que o jogador vê, e não um teleporte para fora do lugar.
 * No centro exato não há normal: aí ele sai pelas costas do acampamento, o rumo oposto à cidade,
 * que é a única direção que este módulo conhece e que nunca corta a porta.
 */
function expulsaDaClareira(corpo, W, H, água) {
    const ac = acampamentoQueRecebe(corpo.x, corpo.y, W, H, água);
    if (!ac)
        return false;
    const u = (corpo.x - ac.x) / ac.meiaLargura;
    const v = (corpo.y - ac.y) / ac.meiaAltura;
    const r = Math.hypot(u, v);
    if (r < 1e-6) {
        corpo.x = ac.x - ac.rumo.x * ac.meiaLargura * SAÍDA_DA_JURISDIÇÃO;
        corpo.y = ac.y - ac.rumo.y * ac.meiaAltura * SAÍDA_DA_JURISDIÇÃO;
        return true;
    }
    const k = SAÍDA_DA_JURISDIÇÃO / r;
    corpo.x = ac.x + u * k * ac.meiaLargura;
    corpo.y = ac.y + v * k * ac.meiaAltura;
    return true;
}
/**
 * Empurra o corpo para fora das cabanas, do totem e da fogueira.
 *
 * Mora ao lado do `empurraDoTronco` e faz a mesma coisa por decisão, não por coincidência: o
 * acampamento tem de barrar o passo de quem tenta atravessá-lo andando, ou seria um desenho. E
 * tem de barrar pelos MESMOS números que o render desenha — o raio da cabana é o raio do corpo
 * dela, multiplicado pela escala do desenho, senão o jogador encosta no olho e passa por dentro.
 *
 * Só consulta a célula do próprio corpo, então o custo é constante por tick independentemente de
 * quantos acampamentos existem no mundo — que são infinitos, é bom lembrar.
 */
function empurraDoAcampamento(corpo, W, H, água) {
    if (!Number.isFinite(corpo.x) || !Number.isFinite(corpo.y) || !(corpo.radius > 0))
        return false;
    const ac = acampamentoEm(corpo.x, corpo.y, W, H, água);
    if (!ac)
        return false;
    let tocado = false;
    for (const pino of pinosDoAcampamento(ac)) {
        const alcance = corpo.radius + pino.raio;
        const dx = corpo.x - pino.x;
        const dy = corpo.y - pino.y;
        const d = Math.hypot(dx, dy);
        if (d >= alcance)
            continue;
        if (d < 1e-4) {
            // Em cima exato do obstáculo: o mesmo truque do tronco, um canto sempre existe.
            corpo.x += alcance;
            corpo.y += alcance;
        }
        else {
            corpo.x += dx * (alcance - d) / d;
            corpo.y += dy * (alcance - d) / d;
        }
        tocado = true;
    }
    return tocado;
}
/**
 * Os corpos sólidos de um acampamento, numa lista só. O render desenha exatamente esta lista e
 * o movimento barra exatamente esta lista — é por isto que ela é uma função e não um campo: se
 * um dia a cabana crescer no desenho, ela cresce no colisor na mesma linha e ninguém precisa
 * lembrar de sincronizar as duas coisas.
 */
function pinosDoAcampamento(ac) {
    const fora = [];
    for (const caba of ac.cabanas)
        fora.push({ x: caba.x, y: caba.y, raio: caba.raio });
    if (ac.totem)
        fora.push(ac.totem);
    fora.push(ac.fogueira);
    fora.push(ac.poste);
    return fora;
}
/**
 * Onde o corpo é atado: do lado do poste que olha para a fogueira, encostado nele. É uma função da
 * medida do corpo amarrado, e não um campo do acampamento, porque o hash do lugar decide onde está o
 * pau e não quem vai pendurado nele.
 *
 * A distância é a **soma** dos dois raios, mais um dedo. Não é aproximação: `empurraDoAcampamento`
 * só empurra quem está *dentro* da soma, então um corpo pousado exatamente na soma é um corpo que o
 * colisor deixa em paz. É isto que dispensa o cativeiro de escrever coordenada por tique para se
 * manter no poste — escrever posição contra o empurrão, no mesmo quadro, é o braço de borracha que o
 * transporte já pagou para conhecer.
 */
function pontoDaAmarra(ac, raioDoCorpo) {
    const dx = ac.fogueira.x - ac.poste.x;
    const dy = ac.fogueira.y - ac.poste.y;
    const d = Math.hypot(dx, dy) || 1;
    const k = (ac.poste.raio + raioDoCorpo + FOLGA_DA_AMARRA) / d;
    return { x: ac.poste.x + dx * k, y: ac.poste.y + dy * k };
}
/** O território inteiro visto de um ponto: a célula que o contém e a distância até a aldeia. */
function aldeiaMaisPerto(x, y, W, H, água) {
    // A aldeia mais perto pode estar na célula do lado — mas a invariante do `RECUO_DA_CÉLULA`
    // diz que a clareira nunca sai da própria célula, então "a célula do ponto, se for clareira"
    // é a resposta exata para "estou dentro de uma aldeia". Para "qual é a aldeia mais perto de
    // mim" é preciso varrer as vizinhas, e é isto que o guerreiro usa para saber a quem voltar.
    const cx = Math.floor(x / CÉLULA_DA_TRIBO), cy = Math.floor(y / CÉLULA_DA_TRIBO);
    let melhor = null, distância = Infinity;
    for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
            const ac = acampamentoDaCélula(cx + ox, cy + oy, W, H, água);
            if (!ac)
                continue;
            const d = Math.hypot(ac.x - x, ac.y - y);
            if (d < distância) {
                distância = d;
                melhor = ac;
            }
        }
    }
    return melhor;
}
/** O lado da célula para o sistema de guerreiros: o bando mora na célula, não no pixel. */
function célulaDaTribo(tx, ty) {
    return { cx: Math.floor(tx / CÉLULA_DA_TRIBO), cy: Math.floor(ty / CÉLULA_DA_TRIBO) };
}
