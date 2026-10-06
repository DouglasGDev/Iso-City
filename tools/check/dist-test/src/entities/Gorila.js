"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GORILA_PASSO_TILES = exports.GORILA_FADE_S = exports.GORILA_CADAVER_S = exports.GORILA_QUEDA_S = exports.PEITO_BATIDA = exports.PEITO_CICLO = exports.GORILA_WINDUP = exports.GORILA_IMPACTO_S = exports.GORILA_CADENCIA = exports.GORILA_ALCANCE_SOCO = exports.GORILA_DANO_SOCO = exports.GORILA_VIDA = exports.GORILA_RAIO = void 0;
exports.criaGorila = criaGorila;
exports.fereGorila = fereGorila;
exports.gorilaVisualState = gorilaVisualState;
exports.gorilaPose = gorilaPose;
exports.gorilaVisível = gorilaVisível;
/** Raio do corpo em tiles. Meio tile seria um homem; isto é um dorsípede de dois metros. */
exports.GORILA_RAIO = 0.9;
/**
 * Vida. 720 é ~9 tiros de rifle e ~180 socos: o jogador pode vencer, mas só se estiver
 * armado, mirar e não tiver medo de levar um soco no meio — o pedido foi "matar", não
 * "ser um chefe de missa". Abaixo disso a fronteira seria um treino de tiro.
 */
exports.GORILA_VIDA = 720;
/** Dano de um soco. Três deles fecham um personagem com 100 de vida. */
exports.GORILA_DANO_SOCO = 34;
/** Distância de contato, já contando o braço: o golpe não exige sobreposição de corpos. */
exports.GORILA_ALCANCE_SOCO = 2.1;
/** Cadência do braço: 1,15 s entre marteladas. Mais rápido que isso vira tela de carregamento. */
exports.GORILA_CADENCIA = 1.15;
/**
 * Quanto o punho fica embaixo depois de bater. É a janela do quadro de impacto, e ela existe
 * porque o sistema aplica o dano e devolve o corpo para a marcha no MESMO tick: sem uma janela
 * lida do cooldown, o golpe nunca era desenhado — o jogador via o braço subir e, no instante de
 * levar o dano, o gigante já estava andando de novo.
 */
exports.GORILA_IMPACTO_S = 0.18;
/** Altura do windup visível (braço no alto) — o jogador tem de VER o golpe chegando. */
exports.GORILA_WINDUP = 0.22;
/**
 * A batida de peito do aviso: o ciclo completo e o tempo em que o punho está colado no tórax.
 * Mora aqui e não dentro do `GorilaSystem` porque é o mesmo número que o sprite lê para escolher
 * o gesto — dois relógios separados fariam o tremor chegar num quadro e o punho no outro.
 */
exports.PEITO_CICLO = 1.1;
exports.PEITO_BATIDA = 0.3;
/** Queda do corpo, sumiço do cadáver e fade, separados de propósito: um gigante cai devagar. */
exports.GORILA_QUEDA_S = 1.2;
exports.GORILA_CADAVER_S = 24;
exports.GORILA_FADE_S = 4;
/** A cada tile percorrido, um passo que se sente. Não é animação: é a régua do tremor. */
exports.GORILA_PASSO_TILES = 1.35;
function criaGorila(x, y, rancor) {
    return {
        id: 1, x, y, dir: 'SE', estado: 'espreitando', vida: exports.GORILA_VIDA, raio: exports.GORILA_RAIO,
        velocidade: 0, morto: false, deathTimer: -1, animTime: 0,
        golpe: 0, peito: exports.PEITO_CICLO * 0.45, espera: 0, passo: 0, rancor,
    };
}
/**
 * Aplica dano ao corpo. Devolve `true` só no primeiro golpe letal, como `damage` do `Animal`:
 * quem chama precisa saber quando a vida acabou para tratar o cadáver uma única vez.
 *
 * Ferido, ele NÃO foge — é essa a diferença entre uma presa e um predador. Um bicho de duas
 * toneladas que leva um tiro e sai correndo seria piada; aqui o tiro aumenta o rancor dele,
 * e é isso que ensina ao jogador a lição que a fronteira inteira ensina: atirar não faz a
 * coisa ir embora, faz a coisa vir mais rápido.
 */
function fereGorila(gorila, amount) {
    if (gorila.morto || !Number.isFinite(amount) || amount <= 0)
        return false;
    gorila.vida = Math.max(0, gorila.vida - amount);
    gorila.rancor = Math.min(2.4, gorila.rancor + 0.18);
    if (gorila.vida > 0) {
        if (gorila.estado === 'retirando' || gorila.estado === 'espreitando')
            gorila.estado = 'cacando';
        return false;
    }
    gorila.morto = true;
    gorila.estado = 'morto';
    gorila.deathTimer = 0;
    gorila.velocidade = 0;
    return true;
}
function gorilaVisualState(gorila, clock) {
    return {
        dir: gorila.dir, estado: gorila.estado, velocidade: gorila.velocidade, morto: gorila.morto,
        deathTimer: gorila.deathTimer, esperando: gorila.estado === 'batendo' && gorila.espera > 0,
        golpe: gorila.golpe, peito: gorila.peito,
        animTime: gorila.animTime, sampledAt: clock,
    };
}
/**
 * Pose do sprite. Mesma forma da pose dos animais (frame/mirror/away/bob + curva de queda), mas
 * com os quadros que a fauna não tem: o braço no alto do windup, o punho embaixo no instante do
 * impacto, e os dois gestos separados da batida de peito de quem está avisando, não atacando.
 *
 * É `'worklet'` porque roda na UI thread dentro do `useDerivedValue` do sprite.
 */
function gorilaPose(visual, clock) {
    'worklet';
    // Interpola no máximo 0,1 s entre publicações, exatamente como o bicho pequeno: nunca
    // inventar tempo de morte para um corpo que o mundo parou de simular.
    const decorrido = visual.deathTimer + (visual.morto ? Math.max(0, Math.min(0.1, clock - visual.sampledAt)) : 0);
    const progress = visual.morto ? Math.min(1, decorrido / exports.GORILA_QUEDA_S) : 0;
    const queda = progress * progress * (3 - 2 * progress);
    const lado = visual.dir === 'SE' || visual.dir === 'NE' ? 1 : -1;
    const andando = !visual.morto && (visual.estado === 'cacando' || visual.estado === 'retirando')
        && visual.velocidade > 0.01;
    const correndo = visual.estado === 'cacando';
    const windup = !visual.morto && (visual.estado === 'batendo' || visual.esperando);
    // O impacto não é um estado: é uma janela lida do cooldown do braço. O sistema aplica o dano e
    // devolve o corpo à marcha no mesmo tick, então sem esta janela o punho embaixo nunca chegava
    // à tela — o jogador via o braço subir e, no instante de levar o dano, já era tarde.
    const impacto = !visual.morto && !windup
        && visual.golpe > exports.GORILA_CADENCIA - exports.GORILA_IMPACTO_S;
    // A passada é uma fase contínua em 0..4 e o quadro é o piso dela. É a mesma régua que o `bob`
    // usa logo abaixo: quadro e altura do corpo têm de vir do mesmo número, ou o gigante sobe no
    // quadro errado e parece estar flutuando.
    const ritmo = correndo ? 6.5 : 3.5;
    const fase = (visual.animTime * ritmo) % 4;
    const aviso = visual.estado === 'espreitando';
    // 0 parado, 1..4 marcha, 5 windup, 7 o golpe chegando ao chão, 6 o punho no peito e 8 os
    // punhos armados. A cadência é mais lenta que a de um cervo porque a passada é mais longa: um
    // gigante corre em frames largos, não em tremor.
    const frame = visual.morto ? 0
        : impacto ? 7
            : windup ? 5
                : andando ? 1 + (Math.floor(fase) % 4)
                    : aviso ? (visual.peito >= exports.PEITO_CICLO - exports.PEITO_BATIDA ? 6 : 8)
                        : 0;
    // O centro de massa sobe na passada e afunda no apoio, senoidal e na MESMA fase do quadro. O
    // bob antigo era binário (-2/-3 px só nos quadros de contato): o corpo pulava de altura em vez
    // de rolar sobre o braço, que é exatamente como um dorsípede anda.
    const apoio = Math.abs(Math.sin(Math.PI * fase / 2));
    const respirando = !andando && !windup && !impacto && !visual.morto;
    const bob = andando ? -apoio * (correndo ? 3.4 : 2)
        : respirando ? Math.sin(clock * 1.5) * 1.1 - 0.55 : 0;
    // A queda: gira até o chão em três quartos do tempo, e no resto o corpo ainda quica uma vez.
    // Um gigante de duas toneladas que apenas tomba linearmente parece de papel; o que pesa é o
    // tranco depois de encostar.
    const tomba = Math.min(1, progress / 0.68);
    const giro = tomba * tomba * (3 - 2 * tomba);
    const quica = progress > 0.68
        ? Math.abs(Math.sin((progress - 0.68) * 9.4)) * (1 - progress) * 13 : 0;
    return {
        rotation: lado * 1.45 * giro,
        // Encolher 58% no eixo Y era o que fazia o corpo derreter em vez de deitar: em isométrico,
        // um dorsípede esticado no chão mantém a altura do dorso e perde só a perspectiva da massa.
        scaleY: 1 - 0.2 * giro,
        offsetY: 4 * giro - quica,
        alpha: visual.morto ? Math.max(0, Math.min(1, (exports.GORILA_CADAVER_S - decorrido) / exports.GORILA_FADE_S)) : 1,
        frame,
        mirror: visual.dir === 'SW' || visual.dir === 'NW' ? -1 : 1,
        away: visual.dir === 'NE' || visual.dir === 'NW',
        bob,
    };
}
/** O corpo ainda merece ser desenhado? Depois do sumiço, nem cadáver. */
function gorilaVisível(gorila) {
    'worklet';
    return !gorila.morto || gorila.deathTimer < exports.GORILA_CADAVER_S;
}
