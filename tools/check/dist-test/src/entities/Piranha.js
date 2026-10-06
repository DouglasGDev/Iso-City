"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PIRANHA_PASSO_TILES = exports.PIRANHA_FADE_S = exports.PIRANHA_CADAVER_S = exports.PIRANHA_QUEDA_S = exports.PIRANHA_RODEIO_RAIO = exports.PIRANHA_SALTO_S = exports.PIRANHA_IMPACTO_S = exports.PIRANHA_BOCA_S = exports.PIRANHA_ARCO_S = exports.PIRANHA_CADENCIA = exports.PIRANHA_ALCANCE_MORDIDA = exports.PIRANHA_DANO_MORDIDA = exports.PIRANHA_VIDA = exports.PIRANHA_RAIO = void 0;
exports.criaPiranha = criaPiranha;
exports.ferePiranha = ferePiranha;
exports.piranhaVisualState = piranhaVisualState;
exports.piranhaPose = piranhaPose;
exports.piranhaVisível = piranhaVisível;
/** Raio do corpo em tiles. Três metros e meio de peixe: maior que o gigante, mais baixo. */
exports.PIRANHA_RAIO = 1.15;
/**
 * Vida. 420 é ~5 tiros de rifle e ~120 de pistola: menos que o gorila porque o corpo aqui é
 * um alvo molhado de 140 px dentro de um canal de seis tiles — sem terreno para se esconder,
 * o jogador acerta tudo o que atira. Se ela fosse tão dura quanto o gigante, a luta seria só
 * espera.
 */
exports.PIRANHA_VIDA = 420;
/** Dano de uma dentada. Quatro delas fecham um personagem com 100 de vida. */
exports.PIRANHA_DANO_MORDIDA = 26;
/**
 * Distância da dentada, já contando o corpo: o bote atravessa o canal, não encosta no alvo.
 * Por isso é maior que o alcance do soco do gorila (2,1) — um peixe não tem braço, tem salto.
 */
exports.PIRANHA_ALCANCE_MORDIDA = 2.6;
/** Cadência do bote: 1,9 s entre saltos. É o tempo de ele afundar, contornar e voltar. */
exports.PIRANHA_CADENCIA = 1.9;
/**
 * O arco do salto, em segundos, medido a partir do `golpe` que acabou de zerar. Existe porque
 * o dano é aplicado no lançamento e desenhado depois: sem uma janela lida do cooldown o corpo
 * subiria na tela um quadro antes da mordida cair, ou nunca subia — o mesmo erro do punho do
 * gigante antes da `GORILA_IMPACTO_S`.
 */
exports.PIRANHA_ARCO_S = 0.36;
/** Metade do arco em que a boca ainda está se abrindo; depois dela é a dentada aberta. */
exports.PIRANHA_BOCA_S = 0.2;
/** Janela em que o corpo ainda está fora d'água depois do dano. */
exports.PIRANHA_IMPACTO_S = 0.16;
/** Windup embaixo d'água: a barbatana some e o jogador tem este tempo para escolher. */
exports.PIRANHA_SALTO_S = 0.3;
/** Raio da volta, em tiles: a distância em que a barbatana contorna quem está na água. */
exports.PIRANHA_RODEIO_RAIO = 5.5;
/** Queda do corpo (ele vira de barriga para cima), boia e fade, separados de propósito. */
exports.PIRANHA_QUEDA_S = 0.8;
exports.PIRANHA_CADAVER_S = 18;
exports.PIRANHA_FADE_S = 3.5;
/** A cada tile e meio percorrido, uma ondulação que se vê e se ouve. Régua, não animação. */
exports.PIRANHA_PASSO_TILES = 1.5;
function criaPiranha(x, y, rancor) {
    return {
        id: 1, x, y, dir: 'SE', estado: 'espreitando', vida: exports.PIRANHA_VIDA, raio: exports.PIRANHA_RAIO,
        velocidade: 0, morto: false, deathTimer: -1, animTime: 0,
        golpe: 0, espera: 0, passo: 0, rancor,
    };
}
/**
 * Aplica dano ao corpo. Devolve `true` só no primeiro golpe letal, como `fereGorila`: quem
 * chama precisa saber quando a vida acabou para tratar a carcaça uma única vez.
 *
 * Ferida, ela não foge — e aqui isso tem um peso a mais: um predador que dá a volta no seu
 * alvo não interrompe a volta porque levou um tiro. O acerto aumenta o rancor dele, que é a
 * velocidade dele, e é essa a lição que a fronteira inteira ensina.
 */
function ferePiranha(peixe, amount) {
    if (peixe.morto || !Number.isFinite(amount) || amount <= 0)
        return false;
    peixe.vida = Math.max(0, peixe.vida - amount);
    peixe.rancor = Math.min(2.4, peixe.rancor + 0.2);
    if (peixe.vida > 0) {
        if (peixe.estado === 'retirando' || peixe.estado === 'espreitando')
            peixe.estado = 'rodeando';
        return false;
    }
    peixe.morto = true;
    peixe.estado = 'morto';
    peixe.deathTimer = 0;
    peixe.velocidade = 0;
    return true;
}
function piranhaVisualState(peixe, clock) {
    return {
        dir: peixe.dir, estado: peixe.estado, velocidade: peixe.velocidade, morto: peixe.morto,
        deathTimer: peixe.deathTimer, esperando: peixe.estado === 'saltando' && peixe.espera > 0,
        golpe: peixe.golpe,
        animTime: peixe.animTime, sampledAt: clock,
    };
}
/**
 * Pose do sprite. Os mesmos campos da pose do gigante (frame/mirror/away/bob + curva de queda)
 * mais um `salto`, que a fauna não tem: em peixe o gesto não é o braço, é o corpo inteiro
 * deixando a água.
 *
 * É `'worklet'` porque roda na UI thread dentro do `useDerivedValue` do sprite.
 */
function piranhaPose(visual, clock) {
    'worklet';
    // Interpola no máximo 0,1 s entre publicações: nunca inventar tempo de morte para um corpo
    // que o mundo parou de simular.
    const decorrido = visual.deathTimer + (visual.morto ? Math.max(0, Math.min(0.1, clock - visual.sampledAt)) : 0);
    const progress = visual.morto ? Math.min(1, decorrido / exports.PIRANHA_QUEDA_S) : 0;
    const rola = progress * progress * (3 - 2 * progress);
    const andando = !visual.morto && visual.velocidade > 0.01;
    const aviso = visual.estado === 'espreitando';
    // O arco é lido do cooldown, não de um temporizador paralelo: o dano cai no lançamento e o
    // corpo sobe no mesmo número, senão o jogador levaria a mordida vendo um peixe quieto.
    const noAr = !visual.morto && !visual.esperando
        && visual.golpe > exports.PIRANHA_CADENCIA - exports.PIRANHA_ARCO_S;
    const u = noAr ? Math.min(1, (exports.PIRANHA_CADENCIA - visual.golpe) / exports.PIRANHA_ARCO_S) : 0;
    const mordendo = noAr && visual.golpe > exports.PIRANHA_CADENCIA - exports.PIRANHA_IMPACTO_S;
    // 0 parado, 1..3 natação (cauda para lá, neutra, para cá), 4 barbatana do aviso, 5 submerso,
    // 6 saindo da água e 7 a dentada aberta no alto do arco.
    const fase = (visual.animTime * 4.2) % 3;
    const frame = visual.morto ? 8
        : visual.esperando ? 5
            : noAr ? (mordendo || u > 0.55 ? 7 : 6)
                : andando ? 1 + (Math.floor(fase) % 3)
                    : aviso ? 4 : 0;
    // O corpo boia: mesmo parado ele sobe e desce com a própria esteira, e é isso que separa um
    // peixe desenhado de um peixe dentro d'água. No salto, o mesmo `bob` vira parábola.
    const flutuando = Math.sin(clock * 2.1) * (andando ? 1.1 : 2.2);
    const altura = noAr ? Math.sin(Math.PI * u) * 30 : 0;
    return {
        // O arco em radianos (mesma unidade do gigante): sai da água com o focinho para cima e
        // desce com ele para baixo. Como o `mirror` vem depois na fila de transforms, o sinal não
        // precisa conhecer a direção — o lado que lidera é sempre o lado que aponta.
        rotation: noAr ? 0.34 * (2 * u - 1) : 0,
        // Morto ela é o quadro 8 desenhado de propósito — barriga clara para cima, olho riscado —
        // em vez de um giro de 180° no sprite: em isométrico um peixe rodado inteiro seria um peixe
        // voando, e o que afunda é só o dorso escuro.
        scaleY: visual.morto ? 1 - 0.12 * rola : 1,
        offsetY: -altura + (visual.morto ? 6 * rola : 0),
        alpha: visual.morto
            ? Math.max(0, Math.min(1, (exports.PIRANHA_CADAVER_S - decorrido) / exports.PIRANHA_FADE_S))
            : visual.esperando ? 0.55 : 1,
        frame,
        mirror: visual.dir === 'SW' || visual.dir === 'NW' ? -1 : 1,
        away: visual.dir === 'NE' || visual.dir === 'NW',
        bob: flutuando + (visual.morto ? 0 : Math.sin(fase * Math.PI * 2 / 3) * (andando ? 1.4 : 0)),
    };
}
/** O corpo ainda merece ser desenhado? Depois de afundar, nem barriga branca. */
function piranhaVisível(peixe) {
    'worklet';
    return !peixe.morto || peixe.deathTimer < exports.PIRANHA_CADAVER_S;
}
