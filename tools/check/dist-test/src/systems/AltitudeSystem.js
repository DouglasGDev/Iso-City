"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AltitudeSystem = exports.ALTURA_DE_TELA_MAX = void 0;
exports.mantaEm = mantaEm;
exports.nuvemNoCampo = nuvemNoCampo;
exports.alturaDeTela = alturaDeTela;
exports.folgaDoQuadro = folgaDoQuadro;
exports.ancoraDaCamera = ancoraDaCamera;
exports.liftDeTela = liftDeTela;
exports.cidadeNaCota = cidadeNaCota;
exports.zoomDaAltura = zoomDaAltura;
const GameConfig_1 = require("../game/GameConfig");
const IsoUtils_1 = require("../world/IsoUtils");
/**
 * A coluna de ar.
 *
 * Até hoje a altura só existia como deslocamento de tela: `worldToScreen` tira `h * 64` pixels do
 * eixo Y e o teto do voo era o ponto em que a lataria saía do quadro. Isso não é voar — é deslizar
 * um sprite para cima até ele sumir, e é por isso que o helicóptero parecia preso ao iso: acima de
 * oito tiles o mundo não encolhia, não fechava, não mudava de natureza, só escorregava para fora
 * da tela.
 *
 * Este sistema é o único lugar onde a coluna existe. Ele não integra nada nem manda em corpo
 * nenhum: recebe a cota de quem está no comando e devolve um instantâneo numérico — onde está a
 * manta, quanta nuvem há neste ponto do céu, quanto do ar ainda iça, para onde o vento empurra e
 * quanta cidade ainda se vê lá embaixo. Câmera, movimento, nuvens e som leem daqui, e é por isso
 * que atravessar a linha de nuvem é uma travessia e não um corte de cena: os quatro olham para a
 * mesma curva no mesmo quadro.
 *
 * A manta não é um plano texturizado: é um CAMPO sobre o mundo (`mantaEm`), com buracos, que anda
 * com o vento do clima. Ter buraco é o que faz a coisa parecer ar em vez de parede — você sobe pela
 * barriga cinza, a cidade fecha num algodão, e de repente abre um rasgo e lá está o bairro outra
 * vez, trinta segundos antes de sumir de novo.
 */
const clamp01 = (v) => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0);
const mix = (a, b, t) => a + (b - a) * clamp01(t);
/** Sobe de 0 a 1 entre `de` e `ate` em curva, sem degrau nas pontas. Inverte se `de > ate`. */
function rampa(de, ate, v) {
    if (!Number.isFinite(v))
        return 0;
    if (Math.abs(ate - de) <= 1e-6)
        return v >= ate ? 1 : 0;
    const t = clamp01((v - de) / (ate - de));
    return t * t * (3 - 2 * t);
}
// ---------------------------------------------------------------------------
// O campo de nuvem
// ---------------------------------------------------------------------------
const RAIZ2 = Math.SQRT1_2;
const ONDE = GameConfig_1.GAME_CONFIG.NUVEM_ONDE;
/**
 * Ruído de valor determinístico. Não passa pelo `rng` do jogo de propósito: a nuvem é um lugar, não
 * um sorteio — ela tem de estar no mesmo ponto quando o jogador voltar por ela depois de descer e
 * subir de novo, e um save carregado não pode encontrar o céu em outro lugar.
 */
function celula(i, j) {
    const s = Math.sin(i * 127.1 + j * 311.7) * 43758.5453;
    return s - Math.floor(s);
}
function ruido(x, y) {
    const i = Math.floor(x), j = Math.floor(y);
    const fx = x - i, fy = y - j;
    const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
    const a = celula(i, j), b = celula(i + 1, j), c = celula(i, j + 1), d = celula(i + 1, j + 1);
    return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v;
}
/**
 * 0..1 de nuvem neste ponto do céu, em três escalas: o vulto grande que decide onde a manta existe,
 * o médio que abre o buraco, o pequeno que mastiga a borda. A deriva desloca o campo com o vento, e
 * é ela que faz a sombra da nuvem andar sobre a cidade.
 *
 * O número é um RANKING do céu, não uma opacidade: ele só diz qual é o tojo daquele ponto. Quem
 * decide quantos tojos existem é a cobertura do clima, na `nuvemNoCampo`. Misturar as duas aqui é o
 * erro que parece sutil e entrega um céu limpo num dia de tempestade.
 */
function mantaEm(x, y, tempo, derivaX, derivaY) {
    const dx = x - derivaX * tempo;
    const dy = y - derivaY * tempo;
    const bruto = ruido(dx / 26, dy / 26) * 0.58
        + ruido(dx / 9.5 + 4.3, dy / 9.5 - 2.1) * 0.29
        + ruido(dx / 3.4 - 7.7, dy / 3.4 + 5.2) * 0.13;
    // O somatório de ruídos se acumula no meio; o estiramento devolve o campo a um ranking igualmente
    // provável em todo o céu, que é o que faz "45% de cobertura" fechar 45% do mundo.
    return clamp01(0.5 + (bruto - 0.5) * 1.7);
}
/**
 * O ranking virou nuvem: um ponto do céu está fechado quando o tojo dele está acima do limiar que a
 * cobertura deixou sobrando. As bordas têm ONDE/7 de maciez para o tojo ter contorno visível em vez
 * de um dente de serra na tela — e para haver, dentro da manta, o rasgo por onde a cidade reaparece.
 */
function nuvemNoCampo(x, y, tempo, derivaX, derivaY, fechada) {
    // Calibre medido, não teoria: o somatório de ruídos é denso no meio, então o limiar cru fecharia
    // 71% do céu num dia de 60% de cobertura. Os dois números abaixo são o ajuste que devolve ao
    // número do clima o que ele promete na tela.
    const coberto = clamp01((clamp01(fechada) - 0.02) / 1.12);
    const limiar = 1 - coberto;
    const mole = ONDE / 12;
    return rampa(limiar - mole, limiar + mole, mantaEm(x, y, tempo, derivaX, derivaY));
}
// ---------------------------------------------------------------------------
// As curvas que a tela e o manche partilham
// ---------------------------------------------------------------------------
const MAO = GameConfig_1.GAME_CONFIG.HELI_CEILING_ELEVATION;
/**
 * Onde a altura ainda é pixel de tela, e onde ela passa a ser escala.
 *
 * Abaixo da linha de passagem a função é a identidade, e isso não é elegância de corte: é o que
 * garante que o voo raso não se moveu um décimo de pixel. Um helicóptero pairando a 2,2 tiles sobre
 * o platô continua com a lataria exatamente `altitude * ELEVATION_PX` acima da própria sombra, como
 * sempre esteve, e o check que mede isso no canvas continua medindo a mesma coisa.
 *
 * Acima da linha, a curva satura. A cota continua subindo de verdade — é ela que o piloto comanda e
 * que decide se você está ou não atrás da nuvem — mas a tela para de receber translação, porque o
 * que faz "subir" parecer subir não é a lataria ir para o topo do quadro: é o mundo embaixo dela
 * encolher e a nuvem fechar.
 */
function alturaDeTela(cota) {
    if (!Number.isFinite(cota))
        return 0;
    if (cota <= MAO)
        return cota;
    return MAO + GameConfig_1.GAME_CONFIG.ISO_SPAN_ACIMA_DO_QUADRO
        * (1 - Math.exp(-(cota - MAO) / GameConfig_1.GAME_CONFIG.ISO_SATURACAO));
}
/**
 * Quantos tiles de tela cabem na folga que a lataria tem acima do anchor da câmera. É a conta que
 * transforma a fração do quadro em unidade de mundo, e ela depende do zoom porque meio quadro são
 * PIXELS: a mesma máquina que enche um retrato de 360 px é uma ficha num monitor de 1200, e a cota
 * onde ela para de escorregar para cima tem de ser outra em cada um.
 */
function folgaDoQuadro(viewH, zoom) {
    const metade = (Number.isFinite(viewH) ? Math.max(1, viewH) : 1) / 2;
    return GameConfig_1.GAME_CONFIG.ALTURA_NO_QUADRO * metade / (IsoUtils_1.ELEVATION_PX * Math.max(0.05, zoom));
}
/**
 * A cota que a câmera mira. É o par da função acima e só existe para que as duas se cancelem
 * embaixo: a lataria fica `alturaDeTela(cota) - aqui` acima do centro do quadro. Enquanto ela cabe
 * na folga, o `max` segura a câmera no chão de sempre e a distância é `altitude * 64` pixels — o
 * voo raso não se move um décimo. Quando estoura, a câmera sobe junto e a folga vira o teto da
 * translação: a máquina para de escorregar pelo quadro em vez de ir embora da tela.
 */
function ancoraDaCamera(cota, chao, folga) {
    return Math.max(chao, alturaDeTela(cota) - Math.max(0, folga));
}
/**
 * Pixels de tela entre a lataria e o chão debaixo dela. É uma conta só, num lugar só, para que o
 * sprite, o descarte de visibilidade e o laço de simulação concordem sobre onde a máquina está
 * desenhada: abaixo da linha de passagem ela vale `altitude * ELEVATION_PX`, exatamente como sempre
 * valeu, e é ela que o check do rotor lê no canvas.
 */
function liftDeTela(cota, chao) {
    return (alturaDeTela(cota) - chao) * IsoUtils_1.ELEVATION_PX;
}
/**
 * O teto da curva acima, em tiles de tela: `alturaDeTela` não passa de 15 por construção, não
 * importa a cota. É o número que o descarte de visibilidade usa para dilatar a janela dos
 * aparelhos — com a cota livre até 46 tiles, dilatar pelo antigo teto isométrico deixaria um
 * helicóptero entrar voando pelo canto da tela com um sumiço no lugar.
 */
exports.ALTURA_DE_TELA_MAX = MAO + GameConfig_1.GAME_CONFIG.ISO_SPAN_ACIMA_DO_QUADRO;
/** Quanto do quadro ainda é cidade desenhada: 1 no voo raso, 0 lá em cima. */
function cidadeNaCota(cota) {
    // O fim da curva é perto do teto, não no meio do caminho: quem tira a cidade do quadro é a
    // nuvem, e a altitude só vai afastando o chão devagar até você estar acima de tudo.
    return 1 - rampa(MAO, GameConfig_1.GAME_CONFIG.CEU_TETO * 0.8, cota);
}
/** O zoom que a altura pede. Abaixo da linha de passagem é o zoom de sempre, sem tocar. */
function zoomDaAltura(cota) {
    return mix(GameConfig_1.GAME_CONFIG.ZOOM_DEFAULT, GameConfig_1.GAME_CONFIG.ZOOM_ALTO, 1 - cidadeNaCota(cota));
}
const VAZIO = Object.freeze({
    cota: 0, chao: 0, teto: GameConfig_1.GAME_CONFIG.CEU_TETO, base: GameConfig_1.GAME_CONFIG.NUVEM_BASE_ALTA,
    topo: GameConfig_1.GAME_CONFIG.NUVEM_BASE_ALTA, cobertura: 0, dentro: 0, bruma: 0, fechamento: 0, acima: 0,
    visivel: 1, rarefeito: 0, cidade: 1, ventoX: 0, ventoY: 0,
});
/**
 * O ar acima da cidade. Não tem mapa, não tem save, não tem `init`: o único estado é o que ele
 * suaviza de um quadro para o outro para a parede de nuvem não piscar quando o casco roça uma borda
 * do campo.
 */
class AltitudeSystem {
    constructor() {
        this.published = VAZIO;
        this.brumaSuavizada = 0;
        this.teto = GameConfig_1.GAME_CONFIG.CEU_TETO;
        this.base = GameConfig_1.GAME_CONFIG.NUVEM_BASE_ALTA;
        this.topo = GameConfig_1.GAME_CONFIG.NUVEM_BASE_ALTA;
        /** O quanto o céu do dia fecha: 0 é um azul sem nada, 1 é teto de nuvem colado no voo raso. */
        this.fechada = 0;
    }
    get snapshot() { return this.published; }
    /** O ar tem teto, e ele fica ACIMA da manta: sem folga sobrando, nuvem seria parede. */
    get doTeto() { return this.teto; }
    get daBase() { return this.base; }
    get doTopo() { return this.topo; }
    /** Zero quando a bruma foi embora: o render desliga a camada inteira em vez de pintar branco. */
    get bruma() { return this.brumaSuavizada; }
    get doCeu() { return this.fechada; }
    update(dt, env) {
        if (!Number.isFinite(dt) || dt <= 0)
            return this.published;
        this.fechada = clamp01(Math.max(env.cobertura, env.severidade * 0.85));
        this.base = mix(GameConfig_1.GAME_CONFIG.NUVEM_BASE_ALTA, GameConfig_1.GAME_CONFIG.NUVEM_BASE_BAIXA, this.fechada);
        this.topo = this.base
            + mix(GameConfig_1.GAME_CONFIG.NUVEM_ESPESSURA[0], GameConfig_1.GAME_CONFIG.NUVEM_ESPESSURA[1], this.fechada);
        this.teto = Math.max(GameConfig_1.GAME_CONFIG.CEU_TETO, this.topo + GameConfig_1.GAME_CONFIG.CEU_FOLGA);
        // O vento é o da tela (é ele que deita a chuva) e vira deriva no eixo iso: +X de tela é a
        // diagonal (1,-1) no plano. A força cresce com a altura porque no meio da rua o prédio barra o
        // ar, e lá em cima não há nada que o barra.
        const altitude = 1 - cidadeNaCota(env.cota);
        const rajada = 1 + 0.22 * Math.sin(env.tempo * 0.31) + 0.13 * Math.sin(env.tempo * 0.83 + 1.7);
        const forca = GameConfig_1.GAME_CONFIG.VENTO_MAX * env.vento * (0.35 + 0.65 * altitude) * rajada;
        const ventoX = forca * RAIZ2;
        const ventoY = -ventoX;
        const tojo = nuvemNoCampo(env.x, env.y, env.tempo, ventoX, ventoY, this.fechada);
        const dentro = this.nuvemNoPonto(env.cota, tojo);
        // A névoa da manhã é um andar embaixo de tudo: fecha no chão e acaba uma hora depois do
        // telhado. Subir acima dela e ver a cidade reaparecer é a prova mais barata que existe de que a
        // altura é de verdade — e era impossível de notar enquanto altura só movia sprite.
        const nevoa = clamp01(env.nevoia) * rampa(env.chao + GameConfig_1.GAME_CONFIG.BRUMA_DO_CHAO, env.chao - 0.4, env.cota);
        // O que a coluna entrega para a tela é SÓ a nuvem. A névoa do chão fecha o ALCANCE do olhar, e
        // quem desenha alcance é a parede da moldura — `FogSystem` já recebe o mesmo número do clima e
        // com ele clareia e encolhe a beira. Deixar os dois pintarem o quadro era pagar duas vezes pelo
        // mesmo fenômeno, e a segunda cópia é a pior: um lavado chapado sobre 100% da tela, centro
        // incluso, apagando a rua inteira numa manhã que deveria só ter o horizonte mais perto.
        // Histerese de um terço de segundo: na borda mastigada do campo o casco entra e sai a cada
        // quadro, e sem memória a tela esbranaça e volta em vez de fechar.
        this.brumaSuavizada += (clamp01(dentro) - this.brumaSuavizada) * (1 - Math.exp(-dt * 3.2));
        // Três coisas tapam a cidade lá de baixo e a mais forte vence: a manta no meio do caminho do
        // olhar (não adianta haver buraco no meu ponto se o teto de nuvem inteiro está entre mim e o
        // chão), a parede em que eu mesmo estou metido e a névoa do andar de baixo. Depois vem a
        // distância: a 46 tiles o bairro é uma ficha, e ficha nenhuma se lê.
        const fechamento = this.fechada * rampa(this.base - ONDE, this.base + ONDE * 2, env.cota);
        const tapado = Math.max(fechamento, this.brumaSuavizada, nevoa);
        const next = {
            cota: env.cota,
            chao: env.chao,
            teto: this.teto,
            base: this.base,
            topo: this.topo,
            cobertura: this.fechada,
            dentro,
            bruma: this.brumaSuavizada,
            fechamento,
            acima: tojo * rampa(this.topo - ONDE, this.topo + ONDE * 2, env.cota),
            visivel: clamp01((1 - tapado) * (1 - rampa(MAO * 2.5, this.teto, env.cota) * 0.55)),
            rarefeito: rampa(MAO + 4, this.teto, env.cota),
            cidade: cidadeNaCota(env.cota),
            ventoX,
            ventoY,
        };
        this.published = next;
        return next;
    }
    /**
     * Quanta nuvem tem dentro deste casco. É a pergunta que a perseguição aérea faz: um helicóptero
     * de polícia atrás de você não vê através de algodão, e quem some na manta não fugiu por
     * velocidade — foi para um ar que a máquina dele não alcança.
     */
    dentroDoCasco(x, y, cota, tempo) {
        const { ventoX, ventoY } = this.published;
        return this.nuvemNoPonto(cota, nuvemNoCampo(x, y, tempo, ventoX, ventoY, this.fechada));
    }
    /**
     * Quanta nuvem há na LAJE de ar entre duas cotas do mesmo ponto. É a pergunta que a perseguição
     * aérea faz de cabeça para baixo: o piloto da ronda não está dentro do algodão, ele está embaixo
     * olhando para cima, e o que separa os dois é a espessura da manta no meio do olhar.
     *
     * Não é a fração da linha que conta — é a espessura. Um dedo de nuvem já some com um aparelho a
     * vinte tiles de altitude, e é por isso que a curva satura em pouco mais de um tile.
     */
    obstrucao(x, y, cotaA, cotaB, tempo) {
        if (!Number.isFinite(cotaA) || !Number.isFinite(cotaB))
            return 0;
        const de = Math.min(cotaA, cotaB), ate = Math.max(cotaA, cotaB);
        const espessura = Math.min(ate, this.topo) - Math.max(de, this.base);
        if (espessura <= 0)
            return 0;
        const { ventoX, ventoY } = this.published;
        const tojo = nuvemNoCampo(x, y, tempo, ventoX, ventoY, this.fechada);
        return clamp01(tojo * (0.35 + this.fechada * 0.8)) * rampa(0.2, 1.6, espessura);
    }
    /**
     * As bolhas que o render desenha deste lado do casco. A grade é grossa e deslocada por um hash
     * fixo, e o que cada bolha carrega é o TAMANHO, não a opacidade: assim a manta inteira sai num
     * caminho Skia só, preenchido uma vez, e o buraco continua sendo a ausência de bolha — que é o
     * que faz a cidade reaparecer por cima do ombro quando você sobe.
     *
     * O passo é parâmetro porque o quadro muda de tamanho: com o zoom no teto a janela visível é ~2,5
     * vezes mais larga, e engrossar a grade é o que mantém o custo parado — bolha maior no lugar de
     * bolha a mais, nunca um canto do quadro sem manta porque a lista estourou o teto.
     *
     * Roda no laço de simulação, não no worklet: o UI thread não tem campo de nuvem nenhum, e a
     * manta é lenta o bastante para ser redesenhada seis vezes por segundo sem que ninguém note.
     */
    pinta(x, y, alcance, tempo, passo = GameConfig_1.GAME_CONFIG.NUVEM_PINTURA) {
        if (!Number.isFinite(x) || !Number.isFinite(y) || !(alcance > 0))
            return [];
        const { ventoX, ventoY } = this.published;
        const blobs = [];
        const i0 = Math.floor((x - alcance) / passo), i1 = Math.ceil((x + alcance) / passo);
        const j0 = Math.floor((y - alcance) / passo), j1 = Math.ceil((y + alcance) / passo);
        for (let i = i0; i <= i1; i++) {
            for (let j = j0; j <= j1; j++) {
                // O desencontro tira o xadrez da grade sem tirar o lugar: o mesmo tile dá a mesma bolha
                // em qualquer quadro, em qualquer dia. A folga é de três décimos do passo, e esse número
                // é o que separa nuvem de peneira: com um passo inteiro de deslocamento, dois vizinhos
                // podem cair a dois passos um do outro e, com raio de um passo, aquilo que era laje vira
                // malha. A cidade legível através de um céu fechado, no navegador, não veio desta linha:
                // veio da ordem de pintura — a manta entrava antes dos prédios, e prédio desenha por cima.
                const cx = (i + 0.5 + (celula(i, j) - 0.5) * 0.6) * passo;
                const cy = (j + 0.5 + (celula(j + 7919, i - 131) - 0.5) * 0.6) * passo;
                const v = nuvemNoCampo(cx, cy, tempo, ventoX, ventoY, this.fechada);
                if (v < 0.45)
                    continue;
                // Raio mínimo de 1,26 passo: vizinho ortogonal mais distante possível fica a 1,6, o
                // diagonal a 2,26 — e duas bolhas desses raios somam 2,52. Onde o campo diz que há nuvem,
                // há nuvem pintada; o buraco que sobra é lugar do campo, não lacuna da grade.
                blobs.push({ x: cx, y: cy, r: passo * (0.95 + 0.7 * v) });
                if (blobs.length >= 420)
                    return blobs;
            }
        }
        return blobs;
    }
    /**
     * A barriga e o lombo engolem antes e depois do bloco: não há linha onde a visibilidade acaba, há
     * dois tiles e meio de "está ficando branco". A espessura é o que separa uma nuvem alta e fofa —
     * onde ainda dá para ver a asa — de um céu fechado e cego.
     */
    nuvemNoPonto(cota, tojo) {
        const atravessa = rampa(this.base - ONDE, this.base + ONDE, cota)
            * (1 - rampa(this.topo - ONDE, this.topo + ONDE * 2, cota));
        return clamp01(tojo * (0.35 + this.fechada * 0.8) * atravessa);
    }
}
exports.AltitudeSystem = AltitudeSystem;
