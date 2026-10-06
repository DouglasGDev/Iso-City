"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PiranhaSystem = void 0;
exports.podeNadar = podeNadar;
exports.noRioSemFim = noRioSemFim;
exports.taxaDaCobrançaNaÁgua = taxaDaCobrançaNaÁgua;
exports.velocidadeDaPiranha = velocidadeDaPiranha;
exports.passoNaÁgua = passoNaÁgua;
exports.pontoDeEmergênciaNoRio = pontoDeEmergênciaNoRio;
const Piranha_1 = require("../entities/Piranha");
const Frontier_1 = require("../world/Frontier");
/**
 * A cobrança do rio sem fim.
 *
 * O espelho aquático do `GorilaSystem`, com a mesma espinha dorsal porque a mesma pergunta está
 * sendo respondida: *quanto custa insistir num lugar que não é seu?* O rio foi feito pela mesma
 * função da coordenada que fez a mata — a boca continua além da grade com a largura da boca — e
 * por isso ele não pode ser só um cenário mais molhado. Andar na água é mais lento, não tem
 * cobertura, não tem borda: se o preço fosse zero, atravessar o mapa nadando seria um atalho em
 * vez de uma travessia.
 *
 * A régua é igual (dívida acumulada por segundo, ponderada pela profundidade) e a mudança de
 * meio muda uma coisa só: o **passo dele é mais rápido que o seu**. A pé, no gorila, correr dá —
 * nadar não. `PLAYER_SWIM_SPEED` é 1,15 tile/s e a piranha baseia em 2,15: a única saída é
 * sair da água, e é por isso que a margem existe logo em volta do canal. Isto não é dificuldade,
 * é a gramática do lugar: a água não tem para onde correr.
 *
 * O resto do contrato é o do gigante, declarado aqui para que ninguém "otimize" um dos dois e
 * os dois envelheçam juntos:
 * — **nadar para longe não escapa.** Ele nasce sempre mais fundo no mesmo canal;
 * — **sair da água escapa.** Ele não nada para dentro da grade nem sobe na margem;
 * — **atirar não espanta, acelera.** Cada acerto aumenta o rancor com que ele foi criado;
 * — **matar não perdoa.** A dívida cai para o piso, não para zero;
 * — **fora da água e fora do mapa, a dívida congela, não desaparece**: é a mata cobrando a pé,
 *   e o `GorilaSystem` já está lá para isso. Os dois sistemas nunca cobram o mesmo trecho.
 */
// ---- a régua da cobrança ----
/**
 * Os números abaixo são tempo de travessia, não "dificuldade". Medindo a 1,15 tile/s para fora:
 * o aviso (~0,5) chega aos ~12 s, uns 14 tiles além da borda; a fera (~1,0) aos ~18 s, uns 20
 * tiles. Parado no meio do canal a 20 tiles, a taxa é 0,082/s — doze segundos de água quieta
 * compram a caçada. É o dobro da velocidade da mata: na água você já está exposto, e a fronteira
 * não avisa duas vezes pelo mesmo risco.
 */
const COBRANÇA_BASE = 0.012;
/** Cada tile além da borda acrescenta isto ao preço por segundo. */
const COBRANÇA_POR_TILE = 0.0035;
/** Teto da taxa: a ~28 tiles de profundidade o rio já cobra o máximo. */
const COBRANÇA_TETO = 0.11;
/** Em dívida por segundo dentro da grade: ~20 s de asfalto apagam o preço de uma travessia. */
const ESQUECIMENTO = 0.05;
const LIMIAR_DO_AVISO = 0.5;
const LIMIAR_DA_CAÇADA = 1;
const COBRANÇA_MÁXIMA = 2.4;
/** Dívida que sobra quando ele se retira, e quando cai. Matar não perdoa nada. */
const DÍVIDA_DA_RETIRADA = 0.6;
const DÍVIDA_DA_QUEDA = 1.3;
// ---- o corpo ----
/**
 * Profundidade mínima para a fera nascer. Quatro tiles além da borda: o canal tem seis tiles de
 * largura e a beira da grade é a boca dele, então "quatro" é o ponto em que você já está
 * decididamente do lado de fora — quem molhou os pés na margem e voltou não é caçado.
 */
const PROFUNDIDADE_DA_COBRA = 4;
/** Distância, ao longo do canal, do ponto de emergência. Sempre fora da janela de névoa. */
const AFASTAMENTO_MÍNIMO = 12;
const AFASTAMENTO_MÁXIMO = 22;
/** Um indivíduo a menos: quanto tempo o rio leva para criar o próximo. */
const RENASCER_S = 18;
/** A fase de aviso: a barbatana atravessa o canal devagar, e este é o tempo de escolher correr. */
const ESPEITA_S = 2;
const PASSO_DO_AVISO = 0.45;
/**
 * Velocidade: base + rancor. A base já é maior que `PLAYER_SWIM_SPEED` (1,15) de propósito — é
 * o que faz a única fuga ser a margem. Com a dívida cheia ele chega a ~4,3 tiles/s.
 */
const PASSO_BASE = 2.15;
const PASSO_POR_RANCOR = 0.95;
/** Rad/s da volta: a velocidade angular com que a barbatana contorna quem está na água. */
const GIRO_DA_VOLTA = 0.75;
/** Intervalo do aviso submerso durante a caçada. */
const RONCA_S = 6.5;
/** Queda do som com a distância, em tiles: além daqui ninguém ouve a água. */
const RONCA_ALCANCE = 55;
/** Recuo do corpo na dentada — é o que joga o nadador para fora do alcance da próxima. */
const MORDIDA_RECUO = 1.2;
const MORDIDA_FOLGA = 0.4;
/** Além desta distância ela deixa de ser uma ameaça e vira um ponto no mapa: some. */
const ABANDONO_TILES = 80;
/** Na retirada, é a esta distância que ela já afundou o bastante para o mundo esquecê-la. */
const AFUNDAMENTO_TILES = 16;
/**
 * Onde o rio manda: fora da grade e em cima da água. A grade é a parte proibida e a proibição é
 * dupla — o mapa tem rio dentro dele, e é exatamente por isso que "é água" não basta: a piranha
 * é da fronteira, não do canal. Quem nada no rio da cidade não é caçado, e um sistema que lesse
 * só `isWaterWorld` transformaria a ponte da avenida num campo de morte.
 */
function podeNadar(x, y, W, H, água) {
    if (!Number.isFinite(x) || !Number.isFinite(y))
        return false;
    if (!(0, Frontier_1.foraDoMapa)(x, y, W, H))
        return false;
    return água.isWaterWorld(x, y);
}
/** O jogador está no rio sem fim? É a única condição que faz esta dívida correr. */
function noRioSemFim(player, W, H, água) {
    if (!player || !player.swimming)
        return false;
    return podeNadar(player.x, player.y, W, H, água);
}
/** A conta por segundo, na profundidade dada. Exportada porque o check cobra a régua, não o feel. */
function taxaDaCobrançaNaÁgua(prof) {
    return Math.min(COBRANÇA_TETO, COBRANÇA_BASE + Math.max(0, prof) * COBRANÇA_POR_TILE);
}
/** A velocidade de um indivíduo criado com esta dívida. Sempre acima da velocidade de nado. */
function velocidadeDaPiranha(rancor) {
    return PASSO_BASE + Math.max(0, rancor) * PASSO_POR_RANCOR;
}
/**
 * Um passo que respeita o canal.
 *
 * A direção pedida é tentada primeiro; se o ponto não é água livre, gira-se para os lados em
 * passos de 22,5° até achar um que seja. Isso é o que faz o bicho *seguir* o rio em vez de
 * atravessar a margem: num canal de seis tiles, qualquer volta grande esbarra na beira, e o
 * desvio miúdo é o que mantém a barbatana no meio da água. As duas vedações são a mesma regra
 * de sempre — `podeNadar` já recusou a grade, então nenhum passo a leva para dentro da cidade.
 */
function passoNaÁgua(x, y, ux, uy, raio, W, H, água, passo) {
    if (!(passo > 0))
        return { x, y, andou: false };
    const d = Math.hypot(ux, uy);
    if (!Number.isFinite(d) || d < 1e-6)
        return { x, y, andou: false };
    const base = Math.atan2(uy / d, ux / d);
    for (const giro of [0, 0.4, -0.4, 0.8, -0.8, 1.2, -1.2, 1.6, -1.6, 2, -2, 2.4, -2.4]) {
        const a = base + giro;
        const cx = Math.cos(a), cy = Math.sin(a);
        // O ponto testado é a frente do corpo, não o centro: é a cabeça que raspa na margem, e uma
        // barbatana que encosta na terra é o sprite saindo do rio.
        if (!podeNadar(x + cx * (passo + raio), y + cy * (passo + raio), W, H, água))
            continue;
        return { x: x + cx * passo, y: y + cy * passo, andou: true };
    }
    return { x, y, andou: false };
}
/**
 * O ponto de emergência dentro do mesmo canal.
 *
 * Varre afastamentos crescentes ao longo da normal da face e, para cada um, deslocamentos
 * laterais a partir do centro. A primeira posição que satisfaz `podeNadar` é o ponto — o que não
 * é um detalhe de implementação, é a garantia de que ela nunca nasce na margem, nunca nasce
 * dentro da grade e sempre nasce mais fundo do que o nadador: a profundidade É a distância para
 * fora da grade, então caminhar `alcance` tiles pela normal já é descer `alcance` tiles. O `sal`
 * 41 é um eixo novo do mesmo hash que desenha a mata, então a mesma coordenada dá a mesma
 * emboscada em qualquer aparelho e um check em memória pode recalcular o ponto.
 */
function pontoDeEmergênciaNoRio(px, py, W, H, água) {
    const face = faceDaPiranha(px, py, W, H) ?? 'SE';
    const [nx, ny, lx, ly] = face === 'NW' ? [-1, 0, 0, 1]
        : face === 'SE' ? [1, 0, 0, 1]
            : face === 'NE' ? [0, -1, 1, 0] : [0, 1, 1, 0];
    const tx = Math.floor(px), ty = Math.floor(py);
    for (let i = 0; i < 8; i++) {
        const alcance = AFASTAMENTO_MÍNIMO + (0, Frontier_1.sorte)(tx, ty, 41 + i) * (AFASTAMENTO_MÁXIMO - AFASTAMENTO_MÍNIMO);
        for (let j = 0; j < 9; j++) {
            // O primeiro teste é reto para fora; os demais abrem leque para os lados, porque o canal
            // pode virar e a única certeza é que a água continua.
            const lado = j === 0 ? 0 : (j % 2 ? 1 : -1) * Math.ceil(j / 2) * 1.5;
            const x = px + nx * alcance + lx * lado;
            const y = py + ny * alcance + ly * lado;
            if (podeNadar(x, y, W, H, água))
                return { x, y };
        }
    }
    return null;
}
/** Para onde o nadador saiu, no eixo da face — o mesmo par de `faceDaFronteira`. */
function faceDaPiranha(x, y, W, H) {
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
/** A frase da HUD, com a primeira letra em maiúscula: o jogo fala em frases, não em campos. */
function frase(texto) {
    return texto.charAt(0).toUpperCase() + texto.slice(1);
}
/** A face, na fala de quem nada: `NOME_DA_FACE` é "a pé para o...", e aqui ninguém está a pé. */
function aNado(face) {
    return face ? `a nado para o ${Frontier_1.NOME_DA_FACE[face].replace('a pé para o ', '')}` : 'no rio';
}
class PiranhaSystem {
    constructor() {
        /** A dívida do rio, lida pela HUD. Pública pelo mesmo motivo do `rancor` do gigante. */
        this.rancor = 0;
        /** O corpo do mundo, ou `null` quando ninguém subiu ainda. */
        this.fera = null;
        this.espera = 0;
        this.avisoFeito = false;
        /** Relógio do aviso submerso. O nome é do contador, não do gesto — o gesto é `ronca()`. */
        this.ronco = 0;
    }
    /** Perigo lido pela HUD: 0 na cidade, 1 no instante em que a fera sobe. */
    get perigo() {
        return Math.min(1, this.rancor / LIMIAR_DA_CAÇADA);
    }
    /** A fera viva que um tiro pode acertar, ou `null`. É a única porta do alvo. */
    get alvo() {
        const p = this.fera;
        return p && !p.morto ? p : null;
    }
    /**
     * Cobra uma dívida que não veio do nado.
     *
     * É a ponte com a `FrontierFallSystem`: um casco que desce sobre o rio além do limite
     * atravessou o trecho inteiro de uma vez, e o preço tem de ser pago de uma vez — senão quem
     * cai de helicóptero no canal e sai da cabine a nado teria de ficar mais vinte segundos na
     * água para ser cobrado pelo voo que já fez. Igual ao `cobra` do gigante: é só um `max`, e é
     * por isso que o método existe — sem ele, alguém cobraria escrevendo em `rancor` por fora.
     */
    cobra(dívida) {
        if (!Number.isFinite(dívida) || dívida <= 0)
            return;
        this.rancor = Math.min(COBRANÇA_MÁXIMA, Math.max(this.rancor, dívida));
    }
    /** O tick. Um único ponto de escrita no corpo da fera: quem chama é o `GameState`. */
    update(dt, ctx) {
        if (!Number.isFinite(dt) || dt <= 0)
            return;
        if (!ctx.player)
            return;
        const { player, worldW: W, worldH: H, água } = ctx;
        const nadando = noRioSemFim(player, W, H, água);
        const prof = (0, Frontier_1.profundidade)(player.x, player.y, W, H);
        this.espera = Math.max(0, this.espera - dt);
        // Com um corpo na água atrás de você a dívida está congelada: o preço daquele pedaço de
        // canal já foi pago com a fera. É a mesma razão do gigante, e a fila de piranhas é o mesmo
        // sintoma de quem esqueceu dela.
        const cobrando = !this.fera || this.fera.morto;
        if (nadando) {
            if (cobrando) {
                this.rancor = Math.min(COBRANÇA_MÁXIMA, this.rancor + taxaDaCobrançaNaÁgua(prof) * dt);
            }
        }
        else if (!(0, Frontier_1.foraDoMapa)(player.x, player.y, W, H)) {
            this.rancor = Math.max(0, this.rancor - ESQUECIMENTO * dt);
            this.avisoFeito = false;
        }
        // Fora do mapa e fora d'água: nada cresce, nada cai. É a mata cobrando, e a cobra já tem
        // dono — o `GorilaSystem`.
        if (!this.fera && this.rancor >= LIMIAR_DO_AVISO && nadando && !this.avisoFeito) {
            this.avisoFeito = true;
            ctx.say(frase(`o rio ${aNado(faceDaPiranha(player.x, player.y, W, H))} está fundo demais — saia da água`), 3.6);
            ctx.play('piranhaThreat', 0.2);
        }
        if (!this.fera && this.deveSubir(nadando, prof))
            this.sobe(ctx, player);
        const p = this.fera;
        if (!p)
            return;
        if (p.morto) {
            this.updateCarcaça(dt, p, ctx);
            return;
        }
        this.updateCaçada(dt, p, ctx, nadando);
    }
    /** A subida do corpo: nasce do hash do canal, avisa em voz alta e começa devagar. */
    sobe(ctx, player) {
        const { worldW: W, worldH: H, água } = ctx;
        const born = pontoDeEmergênciaNoRio(player.x, player.y, W, H, água);
        if (!born) {
            // Sem canal livre para ela, o rio não cria nada — e a dívida fica onde está. Um corpo
            // nascendo fora d'água seria o sprite seco, e é o único erro que esta regra não perdoa.
            this.espera = RENASCER_S;
            return;
        }
        this.fera = (0, Piranha_1.criaPiranha)(born.x, born.y, Math.min(COBRANÇA_MÁXIMA, this.rancor));
        this.fera.espera = ESPEITA_S;
        this.avisoFeito = false;
        this.ronco = RONCA_S;
        this.rancor = Math.min(this.rancor, DÍVIDA_DA_RETIRADA);
        ctx.say(`Algo grande subiu ${aNado(faceDaPiranha(born.x, born.y, W, H))} — saia da água`, 3.2);
        ctx.play('piranhaSplash', 0.85);
        ctx.shake(0.4);
        ctx.onStructChange();
    }
    /** A caçada inteira: estados, deslocamento no canal, volta, bote e os sinais que se leem. */
    updateCaçada(dt, p, ctx, nadando) {
        const player = ctx.player;
        if (!player)
            return;
        const { worldW: W, worldH: H, água } = ctx;
        const dx = player.x - p.x;
        const dy = player.y - p.y;
        const d = Math.hypot(dx, dy);
        // A presa saiu da água: ela a acompanha até a beira do canal e afunda. Não é medo — é o
        // contrato do lugar, e é a resposta à única pergunta que importa para quem nada: para onde
        // eu vou? A resposta é a margem, e a margem é o único sítio onde ela não entra.
        if (p.estado !== 'retirando' && !nadando) {
            p.estado = 'retirando';
            ctx.say('Ela não sai da água. Volta.', 2.6);
        }
        const passo = velocidadeDaPiranha(p.rancor);
        let andou = false;
        if (p.estado === 'retirando') {
            const face = faceDaPiranha(p.x, p.y, W, H) ?? 'SE';
            const [nx, ny] = face === 'NW' ? [-1, 0] : face === 'SE' ? [1, 0] : face === 'NE' ? [0, -1] : [0, 1];
            const mov = passo * dt;
            const r = passoNaÁgua(p.x, p.y, nx, ny, p.raio, W, H, água, mov);
            p.x = r.x;
            p.y = r.y;
            andou = r.andou;
            p.dir = direçãoDe(nx, ny, p.dir);
        }
        else if (p.estado === 'saltando') {
            p.espera = Math.max(0, p.espera - dt);
            if (p.espera <= 0)
                this.morde(p, player, ctx, d, dx, dy);
        }
        else {
            if (p.estado !== 'espreitando' && d <= Piranha_1.PIRANHA_ALCANCE_MORDIDA && p.golpe <= 0) {
                // Afunda antes de subir: é o meio segundo em que a barbatana some da tela, e é o único
                // aviso de que o bote vem. Sem windup visível a mordida seria um número caindo do céu.
                p.estado = 'saltando';
                p.espera = Piranha_1.PIRANHA_SALTO_S;
                p.velocidade = 0;
                this.ronca(dt, p, ctx, d);
                return;
            }
            // Para onde ela quer ir. No aviso é reto em você; na volta é o ponto do círculo que
            // avança — e o círculo é o que faz a barbatana aparecer atrás de você três vezes.
            let ux = dx;
            let uy = dy;
            if (p.estado === 'rodeando') {
                const ângulo = Math.atan2(p.y - player.y, p.x - player.x) + GIRO_DA_VOLTA * dt;
                const raio = Math.min(Piranha_1.PIRANHA_RODEIO_RAIO, Math.max(1.5, d));
                ux = player.x + Math.cos(ângulo) * raio - p.x;
                uy = player.y + Math.sin(ângulo) * raio - p.y;
            }
            const mov = passo * (p.estado === 'espreitando' ? PASSO_DO_AVISO : 1) * dt;
            const r = passoNaÁgua(p.x, p.y, ux, uy, p.raio, W, H, água, mov);
            p.x = r.x;
            p.y = r.y;
            andou = r.andou;
            p.dir = direçãoDe(ux, uy, p.dir);
            if (p.estado === 'espreitando') {
                p.espera -= dt;
                // Ela para de posar quando chega perto o bastante para a barbatana entrar na tela.
                if (p.espera <= 0 || d < 10)
                    p.estado = 'rodeando';
            }
        }
        p.golpe = Math.max(0, p.golpe - dt);
        p.velocidade = andou && p.estado !== 'saltando'
            ? passo * (p.estado === 'espreitando' ? PASSO_DO_AVISO : 1) : 0;
        if (andou && ctx.isVisible(p.x, p.y)) {
            p.animTime += dt;
            p.passo += p.velocidade * dt;
            if (p.passo >= 1.5) {
                p.passo = 0;
                // A esteira é o relógio do corpo na água: a cada tile e meio um tranco de superfície,
                // lido do percurso e não de um temporizador, senão o som andaria em outra velocidade.
                ctx.play('piranhaSplash', 0.24);
                ctx.shake(0.05);
            }
        }
        this.ronca(dt, p, ctx, Math.hypot(player.x - p.x, player.y - p.y));
        // Afundou: o mundo volta a dever pouco, e o canal fica quieto de novo.
        if (p.estado === 'retirando' && d > AFUNDAMENTO_TILES) {
            this.encerra(DÍVIDA_DA_RETIRADA, 'teto');
            return;
        }
        if (d > ABANDONO_TILES)
            this.encerra(DÍVIDA_DA_RETIRADA, 'teto');
        // Dentro da grade não há fera nenhuma, e é o `update` dela que diz isso: se por qualquer
        // caminho o corpo parasse dentro do mapa, ele afunda ali mesmo.
        if (!(0, Frontier_1.foraDoMapa)(p.x, p.y, W, H))
            this.encerra(DÍVIDA_DA_RETIRADA, 'teto');
    }
    /** O bote: dano, recuo, tremor e o som do corpo caindo na água depois da dentada. */
    morde(p, player, ctx, d, dx, dy) {
        p.espera = 0;
        p.golpe = Piranha_1.PIRANHA_CADENCIA;
        p.estado = 'rodeando';
        ctx.play('piranhaSplash', 0.8);
        if (d > Piranha_1.PIRANHA_ALCANCE_MORDIDA + MORDIDA_FOLGA)
            return;
        // Passa pelo `HealthSystem`, como todo dano do jogo: é a invulnerabilidade do pós-dano que
        // impede dois saltos seguidos de virarem uma morte instantânea por spam.
        if (!ctx.damages(Piranha_1.PIRANHA_DANO_MORDIDA))
            return;
        const nx = d > 1e-4 ? dx / d : 0;
        const ny = d > 1e-4 ? dy / d : 0;
        // O empurrão é para longe dela, isto é, para a margem: o rio cospe quem apanha. Não é
        // recompensa — é o preço de ter descido, e é o que impede a dentada de virar afogamento
        // automático em três lances sem que o jogador possa fazer nada a respeito.
        player.x += nx * MORDIDA_RECUO;
        player.y += ny * MORDIDA_RECUO;
        ctx.shake(1);
        ctx.play('bodyHit', 0.8);
    }
    /** A carcaça: ela vira de barriga para cima, boia e afunda. Continua sendo um lugar no mapa. */
    updateCarcaça(dt, p, ctx) {
        p.deathTimer += dt;
        if (p.deathTimer < Piranha_1.PIRANHA_CADAVER_S)
            return;
        this.encerra(DÍVIDA_DA_QUEDA, 'piso');
        ctx.say('A piranha afundou. O rio continua aqui.', 3.4);
    }
    /** O aviso submerso: o ronco grave que vem de baixo, com a queda da distância. */
    ronca(dt, p, ctx, d) {
        this.ronco -= dt;
        if (this.ronco > 0)
            return;
        this.ronco = RONCA_S;
        const perto = 1 - d / RONCA_ALCANCE;
        if (perto <= 0)
            return;
        if (p.estado === 'morto')
            return;
        ctx.play('piranhaThreat', 0.6 * perto);
        if (d < 26)
            ctx.shake(0.08 * perto);
    }
    /**
     * Tira o corpo do mundo e põe o prazo da próxima. Um só lugar faz isso, por contrato, com as
     * duas formas documentadas no `GorilaSystem.encerra`: `'teto'` é fuga, `'piso'` é cobrança.
     */
    encerra(dívida, forma) {
        this.fera = null;
        this.espera = RENASCER_S;
        this.rancor = Math.max(0, forma === 'piso'
            ? Math.max(this.rancor, dívida)
            : Math.min(this.rancor, dívida));
        this.avisoFeito = false;
    }
    /** A única porta de entrada do dano recebido pela fera: quem atira chama esta função. */
    fere(amount) {
        const p = this.fera;
        if (!p || p.morto)
            return false;
        const letal = (0, Piranha_1.ferePiranha)(p, amount);
        if (letal)
            this.avisoFeito = false;
        return letal;
    }
    /** Sobe quando a dívida foi paga, o nadador está fundo o bastante e não há corpo no canal. */
    deveSubir(nadando, prof) {
        return this.espera <= 0
            && nadando
            && this.rancor >= LIMIAR_DA_CAÇADA
            && prof >= PROFUNDIDADE_DA_COBRA;
    }
}
exports.PiranhaSystem = PiranhaSystem;
/**
 * A direção do sprite a partir do deslocamento, na fonia do jogo: `worldToScreen` faz +x descer
 * para o sudeste, então é o mesmo par de eixos do `GorilaSystem`. Sem vetor novo a direção
 * antiga se mantém — um peixe que gira no próprio eixo a cada quadro seria um borrão.
 */
function direçãoDe(vx, vy, anterior) {
    if (vx === 0 && vy === 0)
        return anterior;
    const e = 1e-6;
    if (vx > e && vy > e)
        return 'SE';
    if (vx < -e && vy < -e)
        return 'NW';
    if (vx > e && vy < -e)
        return 'NE';
    if (vx < -e && vy > e)
        return 'SW';
    return Math.abs(vx) >= Math.abs(vy)
        ? (vx > 0 ? 'SE' : 'NW')
        : (vy > 0 ? 'SW' : 'NE');
}
