"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GUERREIRO_FADE_S = exports.GUERREIRO_CADAVER_S = exports.GUERREIRO_QUEDA_S = exports.GUERREIRO_AVISO_S = exports.GUERREIRO_IMPACTO_S = exports.GUERREIRO_WINDUP = exports.GUERREIRO_CADENCIA = exports.GUERREIRO_ALCANCE = exports.GUERREIRO_DANO = exports.GUERREIRO_VIDA = exports.GUERREIRO_RAIO = void 0;
exports.criaGuerreiro = criaGuerreiro;
exports.fereGuerreiro = fereGuerreiro;
exports.guerreiroVisualState = guerreiroVisualState;
exports.guerreiroPose = guerreiroPose;
exports.guerreiroVisível = guerreiroVisível;
exports.dirDe = dirDe;
/** Corpo de um homem armado, em tiles. Um quinto da cabana, três quartos do jogador. */
exports.GUERREIRO_RAIO = 0.3;
/**
 * Vida: 90 é dois tiros de rifle e um soco bem dado de porrete a menos que você esteja ferido.
 * O guerreiro tem de morrer — um inimigo que só pode ser espantado transforma a aldeia num muro —
 * mas morrer rápido demais transformaria o território em treino de tiro, que é o oposto do aviso.
 */
exports.GUERREIRO_VIDA = 90;
/** Porrete na omoplata: três desses num jogador cheio já são um problema; cinco são um desmaio. */
exports.GUERREIRO_DANO = 15;
/** Comprimento do braço mais o porrete. O golpe não exige sobreposição de corpos. */
exports.GUERREIRO_ALCANCE = 1.15;
/** Cadência do braço: 1,1 s entre marteladas — um pouco mais lento que o soco do jogador. */
exports.GUERREIRO_CADENCIA = 1.1;
/** Windup visível: o porrete no alto é a janela em que ainda dá para sair do alcance. */
exports.GUERREIRO_WINDUP = 0.24;
/** Janela do impacto lida do cooldown, pelo mesmo motivo do gigante: o quadro do golpe existe. */
exports.GUERREIRO_IMPACTO_S = 0.15;
/** Levantar o braço antes de gritar: o grito é um gesto, não um alarme sonoro solto no ar. */
exports.GUERREIRO_AVISO_S = 0.5;
exports.GUERREIRO_QUEDA_S = 0.85;
exports.GUERREIRO_CADAVER_S = 18;
exports.GUERREIRO_FADE_S = 3;
function criaGuerreiro(id, bando, posto, x, y, olhar) {
    return {
        id, bando, posto, x, y, dir: dirDe(olhar), olhar,
        estado: 'patrulhando', vida: exports.GUERREIRO_VIDA, raio: exports.GUERREIRO_RAIO,
        velocidade: 0, furor: 0, morto: false, deathTimer: -1, animTime: 0,
        golpe: 0, espera: 0, trilhoθ: 0, trilhoSentido: 1,
        grito: 0, carrega: false,
    };
}
/**
 * Aplica dano ao corpo. Devolve `true` só no primeiro golpe letal, como `fereGorila`: quem chama
 * precisa saber quando a vida acabou para tratar o cadáver uma única vez — e, no caso do bando,
 * para saber que o próximo agora está furioso.
 */
function fereGuerreiro(g, amount) {
    if (g.morto || !Number.isFinite(amount) || amount <= 0)
        return false;
    g.vida = Math.max(0, g.vida - amount);
    if (g.vida > 0) {
        // Ferido mas não nocauteado: ele para de tentar capturar e volta a bater. Um homem sendo
        // atingido no meio do gesto de agarrar não recomeça a marcenaria — reage.
        if (g.estado === 'capturando' || g.estado === 'carregando') {
            g.estado = 'perseguindo';
            g.carrega = false;
        }
        return false;
    }
    g.morto = true;
    g.estado = 'morto';
    g.deathTimer = 0;
    g.velocidade = 0;
    g.carrega = false;
    return true;
}
function guerreiroVisualState(g, clock) {
    return {
        dir: g.dir, estado: g.estado, olhar: g.olhar, velocidade: g.velocidade, morto: g.morto,
        deathTimer: g.deathTimer, esperando: g.estado === 'batendo' && g.espera > 0,
        golpe: g.golpe, animTime: g.animTime, carrega: g.carrega, sampledAt: clock,
    };
}
/**
 * Pose do sprite. Mesma família da do gigante (frame/mirror/away/bob + curva de queda), mas com os
 * quadros de um corpo ereto: 0 parado, 1..4 marcha, 5 porrete no alto, 6 braço armado de
 * sentinela, 7 o golpe chegando, 8 o arrasto do prisioneiro.
 *
 * É `'worklet'` porque roda na UI thread dentro do `useDerivedValue` do sprite.
 */
function guerreiroPose(visual, clock) {
    'worklet';
    const decorrido = visual.deathTimer + (visual.morto
        ? Math.max(0, Math.min(0.1, clock - visual.sampledAt)) : 0);
    const progress = visual.morto ? Math.min(1, decorrido / exports.GUERREIRO_QUEDA_S) : 0;
    const caindo = progress * progress * (3 - 2 * progress);
    const andando = !visual.morto && (visual.estado === 'patrulhando' || visual.estado === 'cercando'
        || visual.estado === 'perseguindo' || visual.estado === 'capturando'
        || visual.estado === 'voltando' || visual.estado === 'carregando')
        && visual.velocidade > 0.01;
    const correndo = visual.estado === 'perseguindo' || visual.estado === 'cercando';
    const windup = !visual.morto && (visual.estado === 'batendo' || visual.esperando
        || visual.estado === 'avistando');
    const impacto = !visual.morto && !windup
        && visual.golpe > exports.GUERREIRO_CADENCIA - exports.GUERREIRO_IMPACTO_S;
    const ritmo = correndo ? 7 : 3.6;
    const fase = (visual.animTime * ritmo) % 4;
    const frame = visual.morto ? 0
        : visual.carrega ? 8
            : impacto ? 7
                : windup ? (visual.estado === 'avistando' ? 6 : 5)
                    : andando ? 1 + (Math.floor(fase) % 4)
                        : 0;
    // O centro de massa sobe na passada e afunda no apoio, na MESMA fase do quadro — a régua que
    // fez o gigante rolar em vez de pular vale para um corpo de setenta quilos pelos mesmos motivos.
    const apoio = Math.abs(Math.sin(Math.PI * fase / 2));
    const respirando = !andando && !windup && !impacto && !visual.morto;
    const bob = andando ? -apoio * (correndo ? 2.2 : 1.4)
        : respirando ? Math.sin(clock * 1.7) * 0.7 : 0;
    const lado = visual.dir === 'SE' || visual.dir === 'NE' ? 1 : -1;
    const tomba = Math.min(1, progress / 0.7);
    const giro = tomba * tomba * (3 - 2 * tomba);
    return {
        rotation: lado * 1.35 * giro,
        scaleY: 1 - 0.12 * giro,
        offsetY: 3 * giro,
        alpha: visual.morto
            ? Math.max(0, Math.min(1, (exports.GUERREIRO_CADAVER_S - decorrido) / exports.GUERREIRO_FADE_S)) : 1,
        frame,
        mirror: visual.dir === 'SW' || visual.dir === 'NW' ? -1 : 1,
        away: visual.dir === 'NE' || visual.dir === 'NW',
        bob,
    };
}
/** O corpo ainda merece ser desenhado? Depois do sumiço, nem cadáver. */
function guerreiroVisível(g) {
    'worklet';
    return !g.morto || g.deathTimer < exports.GUERREIRO_CADAVER_S;
}
/**
 * A direção do sprite a partir de um ângulo de mundo, na fonia do jogo: `worldToScreen` faz +x
 * descer para o sudeste, então o mesmo par de eixos que `deltaToDir` usa para a fauna vale aqui.
 */
function dirDe(olhar) {
    const c = Math.cos(olhar), s = Math.sin(olhar);
    if (c >= 0 && s >= 0)
        return 'SE';
    if (c < 0 && s < 0)
        return 'NW';
    if (c >= 0)
        return 'NE';
    return 'SW';
}
