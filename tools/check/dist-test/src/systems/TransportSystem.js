"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TransportSystem = void 0;
const GameConfig_1 = require("../game/GameConfig");
const network_1 = require("../data/transport/network");
const schedule_1 = require("../data/transport/schedule");
const WorldStreamingManager_1 = require("../world/streaming/WorldStreamingManager");
/**
 * Uma sonda do portão a cada tantos tiles de polilinha. Quatro é um quarto de chunk: o
 * portão decide em chunks, então a amostra nunca muda a decisão que a rota inteira daria.
 */
const PROBE_STEP = 4;
/**
 * A rede de transporte da cidade: a malha é derivada do mapa na construção, e o que roda
 * aqui é o horário das linhas, lido do tempo de jogo. É o portão de zonas do streaming que
 * decide o que se materializa — fora da área simulada ninguém calcula posição de nada.
 */
class TransportSystem {
    constructor(graph, seed) {
        this.units = [];
        /**
         * Polilinha de cada linha amostrada a cada `PROBE_STEP` tiles, em [x, y, x, y...]. É o que
         * o portão de zonas consulta: a rota real, não a caixa dela.
         */
        this.probes = [];
        this.time = 0;
        this.frame = 0;
        this.network = (0, network_1.buildTransportNetwork)(graph, seed);
        this.tiers = new Uint8Array(this.network.routes.length);
        this.streamFloor2 = (GameConfig_1.GAME_CONFIG.STREAMING_RADIUS_TILES + PROBE_STEP) ** 2;
        for (const route of this.network.routes) {
            const sonda = [];
            for (let i = 0; i < route.points.length; i += PROBE_STEP) {
                sonda.push(route.points[i].x, route.points[i].y);
            }
            const ultimo = route.points[route.points.length - 1];
            if (sonda[sonda.length - 2] !== ultimo.x || sonda[sonda.length - 1] !== ultimo.y) {
                sonda.push(ultimo.x, ultimo.y);
            }
            this.probes[route.id] = Float32Array.from(sonda);
            for (let unit = 0; unit < route.units; unit++) {
                const p = (0, schedule_1.sampleRoute)(route, this.network.services[route.service], 0, unit);
                this.units.push({
                    route: route.id, unit, x: p.x, y: p.y, angle: p.angle,
                    stopped: p.stopped, dir: p.dir, live: false,
                });
            }
        }
    }
    /** Relógio da malha: é o espelho do relógio do jogo, nunca um tempo acumulado à parte. */
    get clock() {
        return this.time;
    }
    /**
     * Espelha o relógio do jogo e materializa o que a câmera alcança. Não é `dt`: a posição de
     * um veículo é função pura do tempo, então acumular um tempo próprio faria a cidade atrasar
     * toda vez que o tick dela é pulado — morrendo o jogador ou entrando numa sala — e o
     * horário passaria a depender de quantos frames alguém deixou de rodar. `x`/`y` são a
     * âncora da câmera, o mesmo ponto que define as zonas: sem `streaming` (teste, mapa
     * pequeno) toda a cidade é materializada.
     */
    update(time, x, y, streaming) {
        if (!Number.isFinite(time))
            return;
        this.time = time;
        this.frame++;
        // A zona é lida da linha, não do veículo: as unidades de um mesmo horário moram no mesmo
        // asfalto, e uma consulta por linha basta para saber quais horários calcular. O recorte
        // de quem existe na tela vem depois, do chunk onde cada carro está.
        if (streaming)
            this.readTiers(x, y, streaming);
        for (const u of this.units) {
            const tier = streaming ? this.tiers[u.route] : WorldStreamingManager_1.TIER.VISIBLE;
            if (tier === WorldStreamingManager_1.TIER.OUTSIDE) {
                u.live = false;
                continue;
            }
            // No anel distante a linha continua no horário, só que materializada um a cada
            // `VEHICLE_SIM_TICK_DIVISOR` frames — o mesmo descompasso do trânsito, com o `+ unit`
            // para não cair tudo no mesmo frame.
            if (tier === WorldStreamingManager_1.TIER.DISTANT
                && (this.frame + u.route * 3 + u.unit) % GameConfig_1.GAME_CONFIG.VEHICLE_SIM_TICK_DIVISOR !== 0)
                continue;
            const route = this.network.routes[u.route];
            const s = (0, schedule_1.sampleRoute)(route, this.network.services[route.service], this.time, u.unit);
            u.x = s.x;
            u.y = s.y;
            u.angle = s.angle;
            u.stopped = s.stopped;
            u.dir = s.dir;
            // A zona da linha decide o que é calculado; a zona do asfalto onde o carro está decide
            // o que existe na tela e no som. Uma linha que atravessa o mapa tem unidade dos dois
            // lados da câmera, e o render não pode repetir esse recorte por conta própria.
            u.live = !streaming || streaming.tierOf(u.x, u.y) >= WorldStreamingManager_1.TIER.ACTIVE;
        }
    }
    /**
     * Zona de cada linha vista da câmera, do ponto mais próximo da polilinha. A caixa da rota
     * não serve de teste: uma linha que atravessa o mapa tem uma caixa enorme, e a câmera no
     * canto estaria "dentro" de tudo enquanto o asfalto mais perto está do outro lado do mundo.
     * Os pontos são a polilinha amostrada a cada `PROBE_STEP` tiles na construção — a margem
     * de erro é menor que um chunk, que é a granularidade com que o portão decide.
     */
    readTiers(x, y, streaming) {
        for (const route of this.network.routes) {
            const probes = this.probes[route.id];
            let best = WorldStreamingManager_1.TIER.OUTSIDE;
            for (let i = 0; i < probes.length; i += 2) {
                const dx = probes[i] - x;
                const dy = probes[i + 1] - y;
                // Longe demais para ser sequer o anel de streaming: nem consulta o tierOf.
                if (dx * dx + dy * dy > this.streamFloor2)
                    continue;
                const t = streaming.tierOf(probes[i], probes[i + 1]);
                if (t > best) {
                    best = t;
                    if (t === WorldStreamingManager_1.TIER.VISIBLE)
                        break;
                }
            }
            this.tiers[route.id] = best;
        }
    }
    /** Paradas ao alcance de quem está a pé no ponto pedido. */
    stopsAt(x, y, radius = 2.4) {
        return (0, schedule_1.stopsNear)(this.network, x, y, radius);
    }
    /** Próximas passadas de uma parada, com o tempo de espera no relógio da malha. */
    arrivals(station, count = 3) {
        return (0, schedule_1.nextArrivals)(this.network, station, this.time, count);
    }
    /** Viagem de uma calçada a outra pelo horário. `null` é cidade sem linha entre elas. */
    trip(from, to) {
        return (0, schedule_1.planTrip)(this.network, from, to, this.time);
    }
}
exports.TransportSystem = TransportSystem;
