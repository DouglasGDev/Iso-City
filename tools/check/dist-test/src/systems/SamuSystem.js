"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SamuSystem = void 0;
const GameConfig_1 = require("../game/GameConfig");
const NPC_1 = require("../entities/NPC");
const Vehicle_1 = require("../entities/Vehicle");
const vehicles_1 = require("../data/vehicles");
const SoundManager_1 = require("../audio/SoundManager");
const Pilotagem_1 = require("./Pilotagem");
/**
 * O resgate do mundo — e quem vem buscar quem está no chão.
 *
 * Este jogo já tinha como alguém **cair**: o soco derruba, o carro atropela e o incêndio do
 * `IncendioSystem` deixa a pessoa no chão com a queimadura aberta (um `knocked` de vida negativa é,
 * literalmente, "gente que não devia morrer"). O que não existia era o que vem depois. Uma cidade
 * onde um corpo no chão se levanta sozinho — ou morre sozinho — sem ninguém atravessando a rua para
 * socorrer é um estado de variável, não uma cena. É por isso que este arquivo existe: a vítima vira
 * um **incidente** com relógio próprio (tem hemorragia, tem hora para acabar, e tem um resgate que
 * chega ou não chega) e o SAMU vira uma **rotina** (frota parada na porta do hospital, chamada,
 * asfalto até perto, maca até o corpo, socorro, volta).
 *
 * A régua inteira foi escolhida para caber na cidade e para ser vista:
 * — **um caído crítico sangra por ~30 s.** Se a ambulância alcançar o corpo antes disso, a pessoa
 *   levanta e vive; se não, morre ali. É o que faz o tempo de resposta ser uma mecânica e não um
 *   texto — e é o "não devia morrer" do pedido: sem SAMU, o mundo mata quem um telefone salvaria.
 * — **só sangra quem é alcançável.** Um desmaio no meio do matagal, sem asfalto a `ALCANCE_DA_PARADA`
 *   tiles, não tem ambulância — e, de propósito, também não tem hemorragia: a pessoa apenas se levanta
 *   quando a consciência volta. Punir um ferido que o SAMU nunca poderia alcançar seria uma regra
 *   escrita contra o jogador, não uma consequência do lugar.
 * — **uma ambulância por ocorrência, do mais crítico para o mais perto.** Frota finita: a segunda
 *   queimadura do mesmo incêndio espera. É a mesma escassez honesta do caminhão de bombeiro.
 * — **o paramédico desce e anda até o corpo.** A lataria encosta no asfalto, a maca sai para o lado
 *   que tem calçada, e é o corpo a pé — não o veículo — que faz "resgate" existir na tela.
 */
/** Fração de vida que o SAMU devolve a quem salva: de pé, fraco, mas vivo e fora do chão. */
const VIDA_SOCORRIDA = 45;
/** Segundos de hemorragia de um caído crítico antes de virar corpo, se ninguém chegar. */
const SANGRAMENTO_S = 30;
/** Segundos de atenção da maca sobre o corpo até o socorro fechar. */
const TEMPO_DO_SOCORRO = 2.5;
/** Tiles do corpo até o paramédico em que a maca trabalha. */
const ALCANCE_DA_MACA = 1.4;
/** Tiles do asfalto até o corpo para a ambulância conseguir parar: acima disso, ninguém atende. */
const ALCANCE_DA_PARADA = 7;
/** O corpo é "crítico" (sangra) abaixo desta vida. Um desmaio leve só espera a consciência voltar. */
const VIDA_CRÍTICA = 0;
/** Ambulâncias por hospital. Com uma, a cidade tem uma chance por ocorrência — e é assim que é. */
const FROTA_POR_HOSPITAL = 1;
const TRIPULAÇÃO = 2;
const PASSO_DO_PARAMÉDICO = 2.3;
const PASSO_DA_AMBULÂNCIA = 3.4;
/** Parados na porta do hospital, o pessoal espera dentro: um paramédico a pé no pátio não serve
 *  para nada e ainda aparece como pedestre no radar. */
/** Uma ambulância perdida (roubada, explodida) volta ao hospital depois disto: o serviço repõe. */
const REPOSIÇÃO_S = 55;
class SamuSystem {
    constructor() {
        this.vítimas = [];
        this.viaturas = [];
        this.paramédicos = [];
        this.resgatadas = 0;
        this.perdidas = 0;
        this.próximoId = 1;
        this.initialized = false;
        this.reposiçãoTimer = 0;
        /** Ritmo da sirene no canal `socorro`, separado do `alarme` do fogo: dois atendimentos ao mesmo
         *  tempo não podem calar um ao outro porque disputariam o mesmo alto-falante. */
        this.sireneTimer = 0;
        this.sireneVolume = -1;
    }
    init(ctx) {
        if (this.initialized)
            return;
        this.initialized = true;
        for (const hospital of ctx.map.landmarksOf('hospital'))
            this.armaBase(hospital, ctx);
        ctx.onStructChange();
    }
    stats() {
        return {
            vítimas: this.vítimas.length,
            críticos: this.vítimas.filter((v) => v.crítica).length,
            ambulâncias: this.viaturas.length,
            paramédicos: this.paramédicos.length,
            resgatadas: this.resgatadas,
            perdidas: this.perdidas,
        };
    }
    update(dt, ctx) {
        if (!Number.isFinite(dt) || dt <= 0)
            return;
        this.init(ctx);
        this.varreChão(ctx);
        this.sangra(dt, ctx);
        this.despacha(ctx);
        // `conduz` pode baixar a ambulância (carjack, a lataria atravessada num corpo) e `trabalha`
        // pode riscar um nome da folha (paramédico atropelado): percorrer a lista viva enquanto ela
        // encolhe pularia o próximo da fila — e o próximo é justamente o que está socorrendo.
        for (const u of this.viaturas.slice())
            this.conduz(dt, u, ctx);
        for (const p of this.paramédicos.slice())
            this.trabalha(dt, p, ctx);
        this.repõe(dt, ctx);
        this.alarme(dt, ctx);
    }
    /**
     * Todo pedestre no chão é uma ocorrência potencial. O registro é feito uma vez por corpo (marca
     * privada via `sangramento`/`atendimento`); um `knocked` novo entra na folha, e o que já estava
     * nela apenas acompanha a coordenada, porque um caído não anda mas pode ser arrastado por um
     * carro em cima dele.
     */
    varreChão(ctx) {
        for (const npc of ctx.npcs) {
            if (npc.kind !== 'civ' || npc.dead || npc.state !== 'knocked')
                continue;
            if (this.vítimas.some((v) => v.npcId === npc.id))
                continue;
            const parada = this.pontoDeParada(npc.x, npc.y, ctx);
            // Só sangra quem tem asfalto por perto: o SAMU não pode ser punido — nem o corpo premiado —
            // pela topografia. Sem parada é o `NPCSystem` quem devolve a pessoa ao andar quando a tontura
            // passa, exatamente como era antes de este sistema existir.
            const crítica = !!parada && npc.health <= VIDA_CRÍTICA;
            this.vítimas.push({
                npcId: npc.id, x: npc.x, y: npc.y, crítica,
                sangramento: SANGRAMENTO_S, atendimento: 0, parada, viatura: null,
            });
        }
    }
    /**
     * A hemorragia é o relógio do drama. Um crítico fica preso no chão (a `downTimer` é pinada) até
     * ser socorrido ou até acabar; ao acabar, morre onde caiu — é isto que faz "ninguém veio" ter
     * consequência. O não crítico só sai da folha quando levanta sozinho.
     */
    sangra(dt, ctx) {
        for (let i = this.vítimas.length - 1; i >= 0; i--) {
            const v = this.vítimas[i];
            const npc = this.npc(ctx, v.npcId);
            if (!npc || npc.dead) {
                if (npc && npc.dead)
                    this.perdidas++;
                this.vítimas.splice(i, 1);
                continue;
            }
            // Já não está no chão: um desmaio leve que se levantou sozinho sai da folha sem drama.
            if (npc.state !== 'knocked') {
                this.vítimas.splice(i, 1);
                continue;
            }
            if (!v.crítica) {
                v.x = npc.x;
                v.y = npc.y;
                continue;
            }
            // Prende o corpo no chão: sem isto o `NPCSystem` devolveria o sangrando ao andar quando o
            // `downTimer` zerasse, e a hemorragia desapareceria por uma regra que não é daqui.
            npc.downTimer = Math.max(npc.downTimer, 3);
            v.sangramento -= dt;
            v.x = npc.x;
            v.y = npc.y;
            if (v.sangramento <= 0) {
                this.morre(npc, ctx);
                this.perdidas++;
                const u = this.viaturas.find((c) => c.vítima === v.npcId);
                if (u) {
                    u.vítima = null;
                    (0, Pilotagem_1.esqueceARota)(u);
                }
                this.vítimas.splice(i, 1);
            }
        }
    }
    /** A morte por hemorragia: o corpo fecha no chão, e o `LifeSystem` recicla como qualquer civil. */
    morre(npc, ctx) {
        npc.health = 0;
        npc.dead = true;
        npc.state = 'dead';
        npc.speed = 0;
        npc.anim = 'idle';
        npc.frame = 0;
        ctx.onStructChange();
    }
    /** O asfalto de onde a equipe trabalha: o nó de rua mais perto, deslocado para a faixa, aceitando
     *  só quem está a `ALCANCE_DA_PARADA` tiles do corpo. Acima disso o SAMU não tem como chegar. */
    pontoDeParada(x, y, ctx) {
        const i = ctx.map.nearestRoadNode(x, y);
        const nó = ctx.map.roadNodes[i];
        if (!nó)
            return null;
        const distância = Math.hypot(nó.x - x, nó.y - y);
        if (distância > ALCANCE_DA_PARADA)
            return null;
        const faixa = ctx.map.laneAt(nó.x, nó.y);
        return {
            x: nó.x + (faixa === 'NE' ? 1.1 : faixa === 'SW' ? -1.1 : 0),
            y: nó.y + (faixa === 'SE' ? 1.1 : faixa === 'NW' ? -1.1 : 0),
        };
    }
    /** Uma ambulância por ocorrência, da mais crítica (menos tempo de vida) para a mais perto. */
    despacha(ctx) {
        const livres = this.viaturas.filter((u) => u.modo === 'hospital');
        if (!livres.length)
            return;
        const alvos = this.vítimas
            .filter((v) => v.parada && v.viatura === null)
            .sort((a, b) => (b.crítica ? 1 : 0) - (a.crítica ? 1 : 0) || a.sangramento - b.sangramento);
        for (const v of alvos) {
            let melhor = null;
            let distância = Infinity;
            for (const u of livres) {
                if (u.vítima !== null || !this.operacional(u, ctx))
                    continue;
                const veh = this.vehicle(ctx, u.vehicleId);
                if (!veh)
                    continue;
                const d = Math.hypot(veh.x - v.x, veh.y - v.y);
                if (d < distância) {
                    distância = d;
                    melhor = u;
                }
            }
            if (!melhor)
                return;
            melhor.modo = 'a caminho';
            melhor.vítima = v.npcId;
            melhor.parada = v.parada;
            (0, Pilotagem_1.esqueceARota)(melhor);
            v.viatura = melhor.vehicleId;
        }
    }
    vehicle(ctx, id) { return ctx.vehicles.find((c) => c.id === id); }
    npc(ctx, id) { return ctx.npcs.find((n) => n.id === id); }
    vítima(npcId) {
        return npcId === null ? null : this.vítimas.find((v) => v.npcId === npcId) ?? null;
    }
    /** Tripulação viva e lataria inteira: uma ambulância destruída não socorre ninguém. */
    operacional(u, ctx) {
        const veh = this.vehicle(ctx, u.vehicleId);
        return !!veh && veh.health > 0 && veh.state !== 'destroyed' && ctx.player.currentVehicleId !== veh.id &&
            u.crew.some((id) => {
                const n = this.npc(ctx, id);
                return !!n && !n.dead && n.health > 0;
            });
    }
    conduz(dt, u, ctx) {
        const veh = this.vehicle(ctx, u.vehicleId);
        if (!veh)
            return;
        const vítima = this.vítima(u.vítima);
        // A folha manda: `u.vítima` só pode apontar para um corpo que ainda está em `this.vítimas`.
        // Toda saída de ocorrência (socorrida, morta, levantou sozinha) corta o vínculo pela `folha`,
        // mas um `baixa`/`de volta` pego no meio do caminho deixava o id para trás. Como `despacha` só
        // oferece a ambulância quando `u.vítima === null`, uma referência pendurada travava a viatura no
        // hospital para sempre — e a cidade nunca mais mandava ninguém a um corpo. Aqui a referência é
        // desfeita assim que o corpo some, então o próximo `despacha` reencontra a lataria livre.
        if (u.vítima !== null && !vítima)
            u.vítima = null;
        // Roubaram ou explodiu a ambulância: a tripulação desce, a ocorrência volta para a fila e o
        // hospital repõe a lataria. Sem isto um único carjack encerrava o serviço de resgate.
        if (veh.state === 'destroyed' || ctx.player.currentVehicleId === veh.id ||
            !u.crew.some((id) => !this.npc(ctx, id)?.dead)) {
            this.baixa(u, ctx, !!vítima);
            return;
        }
        const crew = u.crew.map((id) => this.npc(ctx, id)).filter((n) => !!n);
        if (u.modo === 'hospital') {
            if (vítima) {
                u.modo = 'a caminho';
                (0, Pilotagem_1.esqueceARota)(u);
            }
            else {
                veh.speed = 0;
                veh.state = 'parked';
                return;
            }
        }
        if (u.modo === 'a caminho') {
            // A vítima já foi socorrida por outra equipe, morreu, ou levantou sozinha: vai para casa,
            // não correr atrás de um chão vazio.
            if (!vítima || !u.parada) {
                u.modo = 'de volta';
                (0, Pilotagem_1.esqueceARota)(u);
                return;
            }
            const meta = u.parada;
            const target = (0, Pilotagem_1.waypoint)(u, veh, meta, dt, ctx.map, ctx.rng, false, false);
            const dx = target.x - veh.x, dy = target.y - veh.y, distância = Math.hypot(dx, dy);
            if (distância < 0.05) {
                u.stuckTimer += dt;
                if (u.stuckTimer > 3)
                    (0, Pilotagem_1.esqueceARota)(u);
                return;
            }
            (0, Pilotagem_1.apontaViatura)(veh, dx, dy);
            veh.speed = Math.min(PASSO_DA_AMBULÂNCIA, veh.speed + GameConfig_1.GAME_CONFIG.VEHICLE_ACCEL * dt, distância / dt);
            veh.state = 'driving';
            const antes = { x: veh.x, y: veh.y };
            (0, Pilotagem_1.deslizaViatura)(veh, ctx.map, ctx.collision, ctx.vehicles, dx / distância * veh.speed, dy / distância * veh.speed, dt);
            if (Math.hypot(veh.x - antes.x, veh.y - antes.y) < veh.speed * dt * 0.15) {
                u.stuckTimer += dt;
                if (u.stuckTimer > 1)
                    (0, Pilotagem_1.esqueceARota)(u);
            }
            else
                u.stuckTimer = 0;
            for (const n of crew)
                if (n.inVehicle) {
                    n.x = veh.x;
                    n.y = veh.y;
                    n.lastX = veh.x;
                    n.lastY = veh.y;
                }
            if (Math.hypot(veh.x - meta.x, veh.y - meta.y) <= 1.3) {
                veh.speed = 0;
                veh.state = 'parked';
                this.desce(u, ctx);
                u.modo = 'em terra';
            }
            return;
        }
        if (u.modo === 'em terra') {
            veh.speed = 0;
            veh.state = 'parked';
            // A lataria espera no chão enquanto houver maca sobre um corpo: embarcar quem ainda socorre
            // mandaria a equipe de volta com o crítico aberto — é exatamente o "ninguém veio" que este
            // sistema existe para não produzir. Só quando a última `alvo` se apaga é que a tripulação sobe.
            if (this.aindaTrabalhando(u))
                return;
            // Sem ninguém a pé em cena (todos já voltaram) a ocorrência é um chão vazio: vai para casa.
            if (this.embarca(u, dt, ctx))
                u.modo = 'de volta';
            return;
        }
        if (u.modo === 'de volta') {
            if (Math.hypot(veh.x - u.home.x, veh.y - u.home.y) < 2 && !this.embarca(u, dt, ctx))
                return;
            const meta = u.home;
            const atéCasa = Math.hypot(veh.x - meta.x, veh.y - meta.y);
            // A volta não é ronda: `patrol` é a mão única de quem circula um setor. A rota sem direção é
            // o que a própria `PoliceSystem` usa no modo `return`.
            const target = atéCasa < 2 && (0, Pilotagem_1.linhaLivre)(ctx.map, veh, meta)
                ? meta : (0, Pilotagem_1.waypoint)(u, veh, meta, dt, ctx.map, ctx.rng, false, false);
            const dx = target.x - veh.x, dy = target.y - veh.y, rumo = Math.hypot(dx, dy);
            if (atéCasa < 0.4) {
                veh.speed = 0;
                veh.state = 'parked';
                u.stuckTimer = 0;
                this.recompõe(u, ctx);
                u.modo = 'hospital';
                return;
            }
            if (rumo < 0.05) {
                u.stuckTimer += dt;
                if (u.stuckTimer > 3)
                    (0, Pilotagem_1.esqueceARota)(u);
                return;
            }
            (0, Pilotagem_1.apontaViatura)(veh, dx, dy);
            veh.speed = Math.min(PASSO_DA_AMBULÂNCIA, veh.speed + GameConfig_1.GAME_CONFIG.VEHICLE_ACCEL * dt, rumo / dt);
            veh.state = 'driving';
            (0, Pilotagem_1.deslizaViatura)(veh, ctx.map, ctx.collision, ctx.vehicles, dx / rumo * veh.speed, dy / rumo * veh.speed, dt);
            for (const n of crew)
                if (n.inVehicle) {
                    n.x = veh.x;
                    n.y = veh.y;
                }
        }
    }
    /** Alguma maca desta ambulância ainda tem um crítico em tratamento: a lataria espera no chão. */
    aindaTrabalhando(u) {
        return this.paramédicos.some((p) => p.viatura === u.vehicleId && p.alvo !== null);
    }
    /** Desce a tripulação: a lataria encosta no asfalto e os corpos saem para o lado que tem calçada. */
    desce(u, ctx) {
        const veh = this.vehicle(ctx, u.vehicleId);
        if (!veh)
            return;
        const vítima = this.vítima(u.vítima);
        let mudou = false;
        for (const id of u.crew) {
            const npc = this.npc(ctx, id);
            if (!npc || !npc.inVehicle || npc.dead)
                continue;
            const point = (0, Pilotagem_1.pontoDeSaída)(veh, npc, ctx.map, ctx.collision, ctx.vehicles, ctx.npcs);
            if (!point)
                continue;
            npc.x = point.x;
            npc.y = point.y;
            npc.lastX = point.x;
            npc.lastY = point.y;
            npc.inVehicle = false;
            npc.vehicleId = null;
            const p = this.paramédicos.find((x) => x.npcId === id);
            if (p)
                p.alvo = vítima ? vítima.npcId : null;
            if (npc.state !== 'knocked')
                npc.state = 'chasing';
            mudou = true;
        }
        if (mudou) {
            ctx.onStructChange();
            SoundManager_1.sound.play('doorOpen', 0.28);
        }
    }
    trabalha(dt, p, ctx) {
        const npc = this.npc(ctx, p.npcId);
        if (!npc || npc.dead) {
            this.licenca(p, npc, ctx);
            return;
        }
        const u = this.viaturas.find((c) => c.vehicleId === p.viatura);
        if (!u)
            return;
        const veh = this.vehicle(ctx, p.viatura);
        if (u.modo !== 'em terra' || !veh) {
            if (!npc.inVehicle) {
                npc.speed = 0;
                npc.anim = 'idle';
                npc.frame = 0;
            }
            return;
        }
        const vítima = this.vítima(p.alvo);
        // Maca sem corpo (levantou sozinho, já foi socorrida): a equipe volta para a lataria.
        if (!vítima) {
            p.alvo = null;
            this.andaPara(dt, npc, veh.x, veh.y, ctx, p, true);
            return;
        }
        const d = Math.hypot(npc.x - vítima.x, npc.y - vítima.y);
        if (d <= ALCANCE_DA_MACA) {
            this.socorre(dt, p, vítima, ctx);
            npc.state = 'chasing';
            npc.anim = 'idle';
            npc.speed = 0;
            npc.dir = (0, Pilotagem_1.direçãoDoPasso)(vítima.x - npc.x, vítima.y - npc.y);
            return;
        }
        this.andaPara(dt, npc, vítima.x, vítima.y, ctx, p, false);
    }
    /**
     * O corpo de socorro. Um paramédico junto do crítico basta; dois fecham o atendimento mais rápido
     * porque a `atendimento` é uma fração de progresso compartilhada no próprio corpo da vítima. Quando
     * completa, a pessoa levanta viva e grata: vida restaurada, fora do chão, de volta ao fluxo de
     * pedestre — e sai da folha do SAMU como resgatada, não como mais um número de corpo.
     */
    socorre(dt, p, vítima, ctx) {
        const npc = this.npc(ctx, vítima.npcId);
        if (!npc) {
            this.soltaVítima(vítima, ctx);
            p.alvo = null;
            return;
        }
        // Macas sobre a mesma vítima somam o atendimento: a régua é do tempo da cena, não do número de
        // homens. Um corpo crítico com dois paramédicos fecha na metade do tempo que um levaria.
        const equipe = this.paramédicos.filter((o) => o.alvo === vítima.npcId &&
            Math.hypot(this.npc(ctx, o.npcId).x - vítima.x, this.npc(ctx, o.npcId).y - vítima.y) <= ALCANCE_DA_MACA).length;
        vítima.atendimento += (equipe || 1) * dt;
        if (vítima.atendimento < TEMPO_DO_SOCORRO)
            return;
        // Salva. De pé, fraca, fora do chão e de novo civil: é isto que "não devia morrer" quer dizer.
        npc.health = VIDA_SOCORRIDA;
        npc.state = 'fleeing';
        npc.fleeTimer = 4 + ctx.rng() * 2;
        npc.downTimer = 0;
        npc.speed = 0;
        this.resgatadas++;
        this.soltaVítima(vítima, ctx);
        p.alvo = null;
        SoundManager_1.sound.play('healthPickup', 0.3);
        ctx.onStructChange();
    }
    /** Tira a ocorrência da folha e libera a ambulância que a segurava. */
    soltaVítima(vítima, ctx) {
        const i = this.vítimas.indexOf(vítima);
        if (i >= 0)
            this.vítimas.splice(i, 1);
        const u = this.viaturas.find((c) => c.vítima === vítima.npcId);
        if (u) {
            u.vítima = null;
            (0, Pilotagem_1.esqueceARota)(u);
        }
        void ctx;
    }
    /** Sai da folha de serviço e da tripulação; o corpo é devolvido à cidade como civil. */
    licenca(p, npc, ctx) {
        const i = this.paramédicos.indexOf(p);
        if (i >= 0)
            this.paramédicos.splice(i, 1);
        const u = this.viaturas.find((c) => c.vehicleId === p.viatura);
        if (u) {
            const j = u.crew.indexOf(p.npcId);
            if (j >= 0)
                u.crew.splice(j, 1);
        }
        if (npc && npc.kind === 'paramedico')
            npc.kind = 'civ';
        ctx.onStructChange();
    }
    andaPara(dt, npc, x, y, ctx, p, embarca) {
        if (npc.state === 'knocked') {
            npc.downTimer -= dt;
            npc.speed = 0;
            npc.anim = 'idle';
            npc.frame = 0;
            if (npc.downTimer <= 0)
                npc.state = 'chasing';
            return;
        }
        if (embarca && Math.hypot(npc.x - x, npc.y - y) < 0.5) {
            npc.inVehicle = true;
            npc.vehicleId = p.viatura;
            npc.speed = 0;
            p.alvo = null;
            ctx.onStructChange();
            return;
        }
        const target = (0, Pilotagem_1.waypoint)(p, npc, { x, y }, dt, ctx.map, ctx.rng, true);
        const dx = target.x - npc.x, dy = target.y - npc.y, d = Math.hypot(dx, dy);
        npc.speed = d < 0.12 ? 0 : Math.min(PASSO_DO_PARAMÉDICO, d / dt);
        npc.anim = npc.speed ? 'walk' : 'idle';
        if (npc.speed)
            (0, Pilotagem_1.passaAndando)(npc, dx, dy, dt, ctx.map, ctx.collision, ctx.vehicles);
        else
            npc.frame = 0;
        npc.lastX = npc.x;
        npc.lastY = npc.y;
    }
    /** A tripulação que voltou para o veículo: embarca um por vez, no lado livre da lataria. */
    embarca(u, dt, ctx) {
        const veh = this.vehicle(ctx, u.vehicleId);
        if (!veh)
            return true;
        let todos = true;
        for (const id of u.crew) {
            const npc = this.npc(ctx, id);
            if (!npc || npc.dead || npc.inVehicle)
                continue;
            const p = this.paramédicos.find((x) => x.npcId === id);
            if (!p)
                continue; // Perdeu a folha (morreu e virou civ, baixado com a lataria): não bloqueia.
            todos = false;
            const door = (0, Pilotagem_1.pontoDeSaída)(veh, npc, ctx.map, ctx.collision, ctx.vehicles, ctx.npcs) ??
                { x: veh.x + 0.9, y: veh.y };
            this.andaPara(dt, npc, door.x, door.y, ctx, p, true);
        }
        if (!todos)
            return false;
        if (ctx.player.currentVehicleId !== veh.id)
            veh.occupied = true;
        return true;
    }
    /** Perda de ambulância: a ocorrência volta para a fila e a tripulação sai da folha. */
    baixa(u, ctx, soltaVítima) {
        if (soltaVítima) {
            const vítima = this.vítima(u.vítima);
            if (vítima && vítima.viatura === u.vehicleId)
                vítima.viatura = null;
        }
        this.desce(u, ctx);
        for (const p of this.paramédicos.filter((x) => x.viatura === u.vehicleId))
            this.licenca(p, this.npc(ctx, p.npcId), ctx);
        const i = this.viaturas.indexOf(u);
        if (i >= 0)
            this.viaturas.splice(i, 1);
        this.reposiçãoTimer = REPOSIÇÃO_S;
        ctx.onStructChange();
    }
    /** No hospital a frota se recompõe: a tripulação perdida é substituída. */
    recompõe(u, ctx) {
        const veh = this.vehicle(ctx, u.vehicleId);
        while (u.crew.length < TRIPULAÇÃO && veh) {
            const npc = (0, NPC_1.createNPC)(ctx.allocNpcId(), 'a', veh.x, veh.y, 'paramedico', ctx.rng);
            npc.inVehicle = true;
            npc.vehicleId = veh.id;
            ctx.npcs.push(npc);
            u.crew.push(npc.id);
            this.paramédicos.push({ ...(0, Pilotagem_1.rotaNova)(), npcId: npc.id, viatura: veh.id, alvo: null });
        }
        if (u.crew.length)
            ctx.onStructChange();
    }
    /**
     * Uma ambulância por hospital, parado no asfalto em frente à porta, com a tripulação dentro. É o
     * mesmo desenho da frota do bombeiro: vaga a menos de 10 tiles da frente do prédio, fora da
     * calçada, longe de parede e de outro veículo — porque um hospital tem de ter a ambulância *visível*
     * na porta, é assim que o jogador descobre que existe resgate neste mapa antes de alguém cair.
     */
    armaBase(hospital, ctx) {
        for (let slot = 0; slot < FROTA_POR_HOSPITAL; slot++) {
            const spot = this.vagaDoHospital(hospital, ctx);
            if (!spot)
                continue;
            const def = vehicles_1.VEHICLE_DEFS.ambulance;
            const veh = (0, Vehicle_1.createVehicle)(ctx.allocVehicleId(), def, '', spot.x, spot.y, spot.lane ?? 'SE');
            veh.health = 140;
            veh.occupied = true;
            veh.state = 'parked';
            ctx.vehicles.push(veh);
            const u = { ...(0, Pilotagem_1.rotaNova)(), vehicleId: veh.id, home: { x: spot.x, y: spot.y },
                hospital: hospital.key, crew: [], modo: 'hospital', vítima: null, parada: null, stuckTimer: 0 };
            this.viaturas.push(u);
            for (let seat = 0; seat < TRIPULAÇÃO; seat++) {
                const npc = (0, NPC_1.createNPC)(ctx.allocNpcId(), 'a', spot.x, spot.y, 'paramedico', ctx.rng);
                npc.inVehicle = true;
                npc.vehicleId = veh.id;
                ctx.npcs.push(npc);
                u.crew.push(npc.id);
                this.paramédicos.push({ ...(0, Pilotagem_1.rotaNova)(), npcId: npc.id, viatura: veh.id, alvo: null });
            }
        }
    }
    vagaDoHospital(hospital, ctx) {
        const candidatos = ctx.map.roadNodes
            .filter((p) => Math.hypot(p.x - hospital.front.x, p.y - hospital.front.y) < 10)
            .map((node) => {
            const lane = ctx.map.laneAt(node.x, node.y);
            return { x: node.x + (lane === 'NE' ? 1.1 : lane === 'SW' ? -1.1 : 0),
                y: node.y + (lane === 'SE' ? 1.1 : lane === 'NW' ? -1.1 : 0), lane };
        })
            .filter((p) => !!p.lane && ctx.map.tileKindAt(p.x, p.y) !== 'road')
            .sort((a, b) => Math.hypot(a.x - hospital.front.x, a.y - hospital.front.y) -
            Math.hypot(b.x - hospital.front.x, b.y - hospital.front.y));
        for (const p of candidatos) {
            const circle = { ...p, radius: 1.1 };
            if (!ctx.map.isInside(p.x, p.y, circle.radius) || ctx.map.isWaterWorld(p.x, p.y))
                continue;
            if (ctx.collision.overlapsAny(circle, ctx.map.queryNearby(p.x, p.y, 2.5)))
                continue;
            if (ctx.vehicles.some((other) => Math.hypot(other.x - p.x, other.y - p.y) < 2.6))
                continue;
            return p;
        }
        return null;
    }
    /**
     * A sirene do resgate vem antes da vista: o jogador ouve a ambulância que veio a um corpo perto
     * dele, e é esse volume no ouvido que faz um desmaio do outro lado da rua ser achado sem ler a
     * HUD. O canal é o `socorro`, separado do `alarme` do fogo e do `siren` da polícia.
     */
    alarme(dt, ctx) {
        this.sireneTimer -= dt;
        if (this.sireneTimer > 0)
            return;
        this.sireneTimer = 0.3;
        let maisPerto = Infinity;
        for (const u of this.viaturas) {
            if (u.modo !== 'a caminho' && u.modo !== 'em terra')
                continue;
            const veh = this.vehicle(ctx, u.vehicleId);
            if (!veh)
                continue;
            maisPerto = Math.min(maisPerto, Math.hypot(veh.x - ctx.player.x, veh.y - ctx.player.y));
        }
        const volume = maisPerto === Infinity ? 0 : Math.max(0, Math.min(0.5, 0.55 * (1 - maisPerto / 34)));
        if (volume === this.sireneVolume)
            return;
        this.sireneVolume = volume;
        SoundManager_1.sound.setLoop('socorro', volume > 0 ? 'siren' : null, volume);
    }
    /**
     * A varredura do hospital: uma ambulância perdida volta a existir, e um hospital que nasceu sem
     * vaga livre ganha a frota na segunda passada. Feita no relógio, nunca a cada tick, porque achar a
     * vaga filtra e ordena todos os nós de rua do mapa.
     */
    repõe(dt, ctx) {
        this.reposiçãoTimer -= dt;
        if (this.reposiçãoTimer > 0)
            return;
        this.reposiçãoTimer = REPOSIÇÃO_S;
        let armado = false;
        for (const hospital of ctx.map.landmarksOf('hospital')) {
            if (this.viaturas.some((u) => u.hospital === hospital.key))
                continue;
            this.armaBase(hospital, ctx);
            armado = true;
        }
        if (armado)
            ctx.onStructChange();
    }
}
exports.SamuSystem = SamuSystem;
