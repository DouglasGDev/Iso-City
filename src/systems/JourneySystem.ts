import { BOARDING_REACH, fleetLabel, naPlataforma, plataformaDaLinha } from '../data/transport/network';
import type { TransportLeg } from '../data/transport/schedule';
import type { Player } from '../entities/Player';
import type { TransportNetwork } from '../data/transport/types';
import type { Landmark, Map } from '../world/Map';
import type { TransportSystem } from './TransportSystem';

/**
 * O que o jogador está fazendo para a viagem acontecer. Não existe atalho: a perna é a pé até
 * a calçada, a espera é a do relógio até o ônibus encostar, o embarque é a porta do veículo
 * parado, e descer é escolher a calçada. Uma viagem nunca é um menu que move o corpo — é o
 * plano do horário que o jogador cumpre no mundo.
 */
export type JourneyPhase = 'walk' | 'wait' | 'ride';

export interface Journey {
  /** Estação para onde o jogador quer ir. */
  target: number;
  /** Pernas do horário, no instante em que foram planejadas. */
  legs: TransportLeg[];
  /** Perna atual. */
  leg: number;
  phase: JourneyPhase;
  /**
   * A calçada onde o ônibus encostou pela última vez enquanto o jogador ia a bordo. É o que
   * responde "onde eu desci" quando a porta abre, sem precisar de evento do `alight`.
   */
  stopped: number | null;
}

export interface JourneyContext {
  player: Player;
  map: Map;
  transport: TransportSystem;
  /**
   * Onde a rua vê o jogador. Dentro de uma sala isso é o pé da porta, nunca o plano da sala
   * — senão a distância até a plataforma seria medida num mapa que não existe.
   */
  world: { x: number; y: number };
  /** Marca o destino no GPS; é o que faz a travessia ser andada, não adivinhada. */
  mark: (x: number, y: number) => void;
  clearMark: () => void;
  say: (text: string) => void;
}

/** O que a placa de um lugar diz no telão, quando o destino tem um. */
const PLACE: Record<Landmark['kind'], string> = {
  police: 'Esquadra', hospital: 'Hospital', firestation: 'Bombeiros', church: 'Igreja',
  gasstation: 'Posto', clinic: 'Clínica', autoshop: 'Oficina', busstation: 'Rodoviária', shop: 'Comércio',
};

/**
 * O nome de uma calçada no telão: o lugar que fica em frente dela, se houver, e o nome do
 * cruzamento se não houver. "Avenida 1 · Rua 4" é verdadeiro, mas quem escolhe um destino
 * pensa no hospital, não no asfalto.
 */
export function stationName(network: TransportNetwork, map: Map, station: number): string {
  const s = network.stations[station];
  if (!s) return '—';
  let best: string | null = null;
  let bestD = 3.5;
  for (const landmark of map.landmarks) {
    const d = Math.hypot(landmark.front.x - s.x, landmark.front.y - s.y);
    if (d < bestD) { bestD = d; best = PLACE[landmark.kind]; }
  }
  return best ?? s.name;
}

/**
 * A viagem planejada pelo horário. Guarda só o plano e a fase: nada aqui move ninguém, e é de
 * propósito — quem empurra o jogador é o próprio jogador, com o GPS, a calçada e a porta do
 * ônibus. O sistema observa o mundo acontecer e diz o que falta.
 */
export class JourneySystem {
  journey: Journey | null = null;

  /**
   * Planeja e começa. A plataforma é a calçada com linha mais perto da porta do prédio de onde
   * a viagem foi pedida, nunca uma coordenada escrita à mão. Devolve false quando o horário não
   * tem linha entre a plataforma e o destino: a resposta honesta é não prometer viagem nenhuma.
   * Com `anunciado`, o ônibus do telão é o ônibus do plano — se ele não serve o destino, não há
   * viagem, em vez de um transbordo que a linha tocada nunca prometeu.
   */
  begin(
    ctx: JourneyContext, platform: number, destination: number,
    anunciado?: { route: number; pass: number; unit: number } | null,
  ): boolean {
    if (destination === platform) return false;
    const trip = ctx.transport.trip(platform, destination, anunciado);
    if (!trip || !trip.legs.length) return false;
    this.journey = { target: destination, legs: trip.legs, leg: 0, phase: 'walk', stopped: null };
    this.markPlatform(ctx);
    ctx.say(`Viagem até ${this.name(ctx, destination)}`);
    return true;
  }

  update(ctx: JourneyContext): void {
    const journey = this.journey;
    if (!journey) return;
    const player = ctx.player;
    // Morreu, pegou um carro ou subiu num helicóptero: quem manda no trajeto passou a ser
    // outra coisa, e a viagem não finge que ainda está acontecendo.
    if (player.health <= 0 || player.state === 'dead' || player.currentVehicleId !== null) {
      this.journey = null;
      ctx.clearMark();
      ctx.say('Viagem cancelada');
      return;
    }

    const aboard = player.busUnit === null ? null : ctx.transport.units[player.busUnit];
    if (aboard) {
      const route = ctx.transport.network.routes[aboard.route];
      if (aboard.stopped && aboard.stop >= 0) journey.stopped = route.stops[aboard.stop].station;
      journey.phase = 'ride';
      // Na tela da cidade o ônibus é o destino: o risco do GPS não corre na frente dele.
      ctx.clearMark();
      return;
    }

    // Acabou de descer: a calçada onde o ônibus encostou é o novo ponto de partida do plano.
    if (journey.phase === 'ride') {
      const onde = journey.stopped;
      if (onde === journey.target) {
        this.journey = null;
        ctx.clearMark();
        ctx.say(`Você chegou · ${this.name(ctx, journey.target)}`);
        return;
      }
      if (onde === null || !this.replan(ctx, onde)) {
        this.journey = null;
        ctx.clearMark();
        ctx.say(onde === null ? 'Descida fora do trajeto · viagem encerrada'
          : `Sem linha desta calçada até ${this.name(ctx, journey.target)}`);
      }
      return;
    }

    const leg = journey.legs[journey.leg];
    if (!leg) { this.journey = null; return; }
    if (journey.phase !== 'walk') return;
    // Na calçada certa o plano vira espera: a plataforma deixou de ser destino.
    const baia = this.baia(ctx, leg);
    const perto = baia
      // Na quadra exclusiva da rodoviária a espera não começa no pátio inteiro: começa na
      // plataforma da linha escolhida. Parar no meio do asfalto e esperar "o da Linha 3" é o
      // embarque no ônibus errado que a numeração das baias existe para impedir, e o pino do
      // GPS aponta exatamente para ela.
      ? naPlataforma(baia, ctx.world.x, ctx.world.y)
      : ctx.transport.stopsAt(ctx.world.x, ctx.world.y, BOARDING_REACH)
        .some((s) => s.id === leg.from);
    if (!perto) return;
    journey.phase = 'wait';
    ctx.clearMark();
  }

  /**
   * Recomeça o plano a partir da calçada onde o jogador está. É isto que paga o transbordo:
   * desceu antes da hora, pegou a linha errada ou o ônibus furou — o horário é consultado de
   * novo daquela calçada, e a viagem continua real.
   */
  private replan(ctx: JourneyContext, from: number): boolean {
    const journey = this.journey;
    if (!journey) return false;
    const trip = ctx.transport.trip(from, journey.target);
    if (!trip || !trip.legs.length) return false;
    journey.legs = trip.legs;
    journey.leg = 0;
    journey.stopped = null;
    journey.phase = trip.legs[0].from === from ? 'wait' : 'walk';
    if (journey.phase === 'walk') this.markPlatform(ctx);
    else ctx.clearMark();
    return true;
  }

  /** O nome de uma calçada, na boca de quem planejou a viagem: lugar em frente ou cruzamento. */
  private name(ctx: JourneyContext, station: number): string {
    return stationName(ctx.transport.network, ctx.map, station);
  }

  /** A plataforma onde esta perna embarca, ou `null` na calçada de rua, que tem marquise só. */
  private baia(ctx: JourneyContext, leg: TransportLeg) {
    return plataformaDaLinha(ctx.transport.network, leg.from, leg.route);
  }

  private markPlatform(ctx: JourneyContext): void {
    const leg = this.journey?.legs[this.journey.leg];
    if (!leg) return;
    const station = ctx.transport.network.stations[leg.from];
    const baia = this.baia(ctx, leg);
    // O pino crava na baia, não na estação: no pátio a estação é um ponto só do virador, e o
    // passageiro precisa saber em qual das plataformas ele encosta.
    ctx.mark(baia ? baia.x : station.x, baia ? baia.y : station.y);
  }

  /**
   * A linha do objetivo na HUD. Um texto só, para o toque e para o teclado, porque vem do
   * horário: diz a perna, o tempo, a calçada e a matrícula do ônibus que o painel prometeu, e
   * nunca promete um atalho.
   */
  status(ctx: JourneyContext): string | null {
    const journey = this.journey;
    if (!journey) return null;
    const leg = journey.legs[journey.leg];
    if (!leg) return null;
    const network = ctx.transport.network;
    const rota = network.routes[leg.route];
    if (journey.phase === 'walk') {
      const baia = this.baia(ctx, leg);
      // O número de frota vai no aviso antes do embarque: no pátio há mais lataria da mesma
      // cor parada do que plataformas, e o que o passageiro procura é o ônibus que leu no telão.
      return `ÔNIBUS ${fleetLabel(rota, leg.unit)} · `
        + `${baia ? `NA ${baia.name.toUpperCase()}` : 'NA PLATAFORMA'}`
        + ` · ${this.name(ctx, journey.target)}`;
    }
    if (journey.phase === 'wait') {
      // A contagem é do ônibus que a HUD nomeia. `arrivals` responde "o primeiro da linha", que
      // na mesma calçada pode ser outro veículo da mesma lataria — e aí o aviso diria CNA-186
      // contando os segundos do CNA-187.
      const espera = `${Math.ceil(ctx.transport.esperaDaPerna(leg))} s`;
      return `${fleetLabel(rota, leg.unit)} · ${rota.name} · CHEGA EM ${espera}`;
    }
    const aboard = ctx.player.busUnit === null ? null : ctx.transport.units[ctx.player.busUnit];
    if (!aboard) return null;
    const route = network.routes[aboard.route];
    // Embarcou em outra linha — o ônibus que encostou primeiro, por exemplo. O plano não
    // some: o que a HUD diz é a verdade da calçada, e descer ali recomeça a viagem dali.
    if (aboard.route !== leg.route) {
      const onde = aboard.stop >= 0 ? route.stops[aboard.stop].station : -1;
      return `ESTA NÃO É A ${route.name} · DESÇA EM ${this.name(ctx, onde)}`;
    }
    return `${route.name} · ${fleetLabel(route, aboard.unit)} · DESCER EM ${this.name(ctx, leg.to)}`;
  }
}
