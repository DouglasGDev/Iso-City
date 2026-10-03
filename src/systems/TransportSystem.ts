import { GAME_CONFIG, type Dir4 } from '../game/GameConfig';
import { buildTransportNetwork } from '../data/transport/network';
import {
  nextArrivals,
  planTrip,
  sampleRoute,
  stopsNear,
} from '../data/transport/schedule';
import type { RoadGraph, TransportNetwork, TransportStation } from '../data/transport/types';
import type { TransportArrival, TransportTrip } from '../data/transport/schedule';
import { angleToWorldDirStable } from '../world/IsoUtils';
import type { WorldStreamingManager, StreamingTier } from '../world/streaming/WorldStreamingManager';
import { TIER } from '../world/streaming/WorldStreamingManager';

/**
 * Uma sonda do portão a cada tantos tiles de polilinha. Quatro é um quarto de chunk: o
 * portão decide em chunks, então a amostra nunca muda a decisão que a rota inteira daria.
 */
const PROBE_STEP = 4;

/**
 * Um veículo do horário de uma linha. O estado é derivado do relógio a cada leitura, então
 * um ônibus congelado fora da área de streaming não acumula erro: quando o jogador volta, a
 * posição que aparece é a que o horário manda, não a última que ele viu.
 */
export interface TransportUnit {
  route: number;
  unit: number;
  x: number;
  y: number;
  angle: number;
  /**
   * Quadrante do sprite. Derivado do `angle` com a mesma histerese do jogador a pé, porque
   * uma linha que contorna uma caixa faz o ângulo cruzar a fronteira do quadrante no meio
   * do gesto — sem folga o ônibus piscaria entre duas artes a cada curva.
   */
  dir: Dir4;
  /** Encostado na calçada, embarcando. */
  stopped: boolean;
  /**
   * A linha desta unidade está no alcance da câmera, então o horário dela é calculado. É o
   * portão da linha inteira: uma rota que atravessa a cidade tem carro nos dois cantos, e o
   * que decide se ele existe é o chunk onde ele está, não a distância dele até a câmera.
   */
  live: boolean;
}

/**
 * A rede de transporte da cidade: a malha é derivada do mapa na construção, e o que roda
 * aqui é o horário das linhas, lido do tempo de jogo. É o portão de zonas do streaming que
 * decide o que se materializa — fora da área simulada ninguém calcula posição de nada.
 */
export class TransportSystem {
  readonly network: TransportNetwork;
  readonly units: TransportUnit[] = [];
  /**
   * Polilinha de cada linha amostrada a cada `PROBE_STEP` tiles, em [x, y, x, y...]. É o que
   * o portão de zonas consulta: a rota real, não a caixa dela.
   */
  private readonly probes: Float32Array[] = [];
  private readonly tiers: Uint8Array;
  /**
   * Distância acima da qual nenhum ponto amostrado pode definir a zona. Uma margem de um
   * passo de sonda cobre o trecho entre duas sondas, que é o único erro que o portão tem.
   */
  private readonly streamFloor2: number;
  private time = 0;
  private frame = 0;

  constructor(graph: RoadGraph, seed: number) {
    this.network = buildTransportNetwork(graph, seed);
    this.tiers = new Uint8Array(this.network.routes.length);
    this.streamFloor2 = (GAME_CONFIG.STREAMING_RADIUS_TILES + PROBE_STEP) ** 2;
    for (const route of this.network.routes) {
      const sonda: number[] = [];
      for (let i = 0; i < route.points.length; i += PROBE_STEP) {
        sonda.push(route.points[i].x, route.points[i].y);
      }
      const ultimo = route.points[route.points.length - 1];
      if (sonda[sonda.length - 2] !== ultimo.x || sonda[sonda.length - 1] !== ultimo.y) {
        sonda.push(ultimo.x, ultimo.y);
      }
      this.probes[route.id] = Float32Array.from(sonda);
      for (let unit = 0; unit < route.units; unit++) {
        const p = sampleRoute(route, this.network.services[route.service], 0, unit);
        this.units.push({
          route: route.id, unit, x: p.x, y: p.y, angle: p.angle,
          dir: angleToWorldDirStable(p.angle, 'SE'), stopped: p.stopped, live: false,
        });
      }
    }
  }

  /** Relógio da malha: é o espelho do relógio do jogo, nunca um tempo acumulado à parte. */
  get clock(): number {
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
  update(time: number, x: number, y: number, streaming?: WorldStreamingManager): void {
    if (!Number.isFinite(time)) return;
    this.time = time;
    this.frame++;
    // A zona é lida da linha, não do veículo: as unidades de um mesmo horário moram no mesmo
    // asfalto, e uma consulta por linha basta para saber quais horários calcular. O recorte
    // de quem existe na tela vem depois, do chunk onde cada carro está.
    if (streaming) this.readTiers(x, y, streaming);
    for (const u of this.units) {
      const tier = streaming ? this.tiers[u.route] : TIER.VISIBLE;
      if (tier === TIER.OUTSIDE) {
        u.live = false;
        continue;
      }
      // No anel distante a linha continua no horário, só que materializada um a cada
      // `VEHICLE_SIM_TICK_DIVISOR` frames — o mesmo descompasso do trânsito, com o `+ unit`
      // para não cair tudo no mesmo frame.
      if (tier === TIER.DISTANT
        && (this.frame + u.route * 3 + u.unit) % GAME_CONFIG.VEHICLE_SIM_TICK_DIVISOR !== 0) continue;
      const route = this.network.routes[u.route];
      const s = sampleRoute(route, this.network.services[route.service], this.time, u.unit);
      u.x = s.x;
      u.y = s.y;
      u.angle = s.angle;
      u.stopped = s.stopped;
      u.dir = angleToWorldDirStable(s.angle, u.dir);
      // A zona da linha decide o que é calculado; a zona do asfalto onde o carro está decide
      // o que existe na tela e no som. Uma linha que atravessa o mapa tem unidade dos dois
      // lados da câmera, e o render não pode repetir esse recorte por conta própria.
      u.live = !streaming || streaming.tierOf(u.x, u.y) >= TIER.ACTIVE;
    }
  }

  /**
   * Zona de cada linha vista da câmera, do ponto mais próximo da polilinha. A caixa da rota
   * não serve de teste: uma linha que atravessa o mapa tem uma caixa enorme, e a câmera no
   * canto estaria "dentro" de tudo enquanto o asfalto mais perto está do outro lado do mundo.
   * Os pontos são a polilinha amostrada a cada `PROBE_STEP` tiles na construção — a margem
   * de erro é menor que um chunk, que é a granularidade com que o portão decide.
   */
  private readTiers(x: number, y: number, streaming: WorldStreamingManager): void {
    for (const route of this.network.routes) {
      const probes = this.probes[route.id];
      let best: StreamingTier = TIER.OUTSIDE;
      for (let i = 0; i < probes.length; i += 2) {
        const dx = probes[i] - x;
        const dy = probes[i + 1] - y;
        // Longe demais para ser sequer o anel de streaming: nem consulta o tierOf.
        if (dx * dx + dy * dy > this.streamFloor2) continue;
        const t = streaming.tierOf(probes[i], probes[i + 1]);
        if (t > best) {
          best = t;
          if (t === TIER.VISIBLE) break;
        }
      }
      this.tiers[route.id] = best;
    }
  }

  /** Paradas ao alcance de quem está a pé no ponto pedido. */
  stopsAt(x: number, y: number, radius = 2.4): TransportStation[] {
    return stopsNear(this.network, x, y, radius);
  }

  /** Próximas passadas de uma parada, com o tempo de espera no relógio da malha. */
  arrivals(station: number, count = 3): TransportArrival[] {
    return nextArrivals(this.network, station, this.time, count);
  }

  /** Viagem de uma calçada a outra pelo horário. `null` é cidade sem linha entre elas. */
  trip(from: number, to: number): TransportTrip | null {
    return planTrip(this.network, from, to, this.time);
  }
}
