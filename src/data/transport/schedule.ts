import type { TransportNetwork, TransportRoute, TransportService, TransportStation } from './types';

/**
 * Estado de um serviço num instante. A posição não é integrada nem guardada: ela é lida do
 * relógio, e é por isso que uma linha fora da área de streaming não precisa de estado —
 * volta a aparecer no horário exato em que chegaria se tivesse rodando o tempo todo.
 */
export interface TransportSample {
  x: number;
  y: number;
  /** Orientação de viagem, em radianos, no mesmo espaço de `Player.facingAngle`. */
  angle: number;
  /** Parado na calçada, embarcando. */
  stopped: boolean;
  /**
   * Encostado no berço de origem, terminando a volta. É a última passada do ciclo: o ônibus
   * chegou, abre a porta para quem desce e fecha antes de virar o relógio de novo. A partida
   * anunciada no telão é a primeira passada da volta seguinte, no mesmo tile — é ela que embarca.
   * Deixar o passageiro entrar nesta aqui seria a viagem sair antes da hora que o próprio painel
   * mostrou, porque este corpo ainda está devolvendo a volta que fez, não começando a próxima.
   */
  parked: boolean;
  /** +1 na ida, -1 na volta: é o que inverte a fila e a placa do próximo ponto. */
  dir: 1 | -1;
  /** Índice da última parada passada na rota, ou -1. */
  stop: number;
  /**
   * Índice da passada na tabela da rota. Com `dwell`, é o que diz *em que sentido* o ônibus
   * encostou: `stop` é a calçada, e a mesma calçada recebe a ida e a volta da mesma linha. Sem
   * ele, quem embarca no primeiro ônibus que encosta pode estar pegando a meia-volta.
   */
  pass: number;
  /**
   * O instante dentro da volta de que a amostra foi lida, em [0, ciclo). É o que diz *há quanto*
   * o ônibus está parado: a espera do ponto `k` começa em `table[k].time` e dura `dwell`, e quem
   * precisa abrir lataria atrás de si tem de sair dessa janela inteira antes de andar. Sem ele,
   * atrasar um ônibus parado é girar o relógio dentro da mesma espera — o corpo continua no
   * mesmo pixel, e a fila de ônibus encostados não se desgruda nunca.
   */
  phase: number;
}

/** Uma chegada: quantos segundos até a linha passar na calçada. */
export interface TransportArrival {
  route: number;
  station: number;
  in: number;
}

/** Um trecho de viagem: uma linha, da parada de embarque à de desembarque. */
export interface TransportLeg {
  route: number;
  from: number;
  to: number;
  /** Instante de embarque e de chegada no relógio do mundo. */
  board: number;
  arrive: number;
  /**
   * Índice da passada na tabela da rota — o embarque prometido, não "qualquer ônibus da linha
   * naquela calçada". A mesma calçada serve os dois sentidos da mesma linha e o plano vale para
   * um deles: sem o índice, quem embarca no primeiro que encosta pode estar pegando a meia-volta
   * e desce no destino uma volta inteira depois do horário prometido.
   */
  pass: number;
  /**
   * O índice do veículo que cumpre esta perna. O telão anuncia hora e o GPS manda procurar um
   * ônibus: os dois têm de apontar para a mesma lataria, e é este número, somado ao bloco de
   * frota da linha, que produz a matrícula pintada no teto.
   */
  unit: number;
}

export interface TransportTrip {
  legs: TransportLeg[];
  /** Transbordos = número de embarques menos um. */
  transfers: number;
  arrive: number;
}

const mod = (v: number, m: number) => ((v % m) + m) % m;

/**
 * Ponto da polilinha a uma distância do origem, com a orientação de quem a percorre. O
 * sentido escolhe a polilinha, não o sinal do vetor: a volta corre na faixa do outro lado da
 * via, com curvatura e comprimento próprios, e virar o ângulo de 180° sobre a mesma linha
 * seria o ônibus na contramão que o jogador vê passar por ele.
 */
export function alongRoute(route: TransportRoute, dist: number, dir: 1 | -1): { x: number; y: number; angle: number } {
  const points = dir === 1 ? route.points : route.back;
  const cum = dir === 1 ? route.cum : route.backCum;
  const total = dir === 1 ? route.length : route.backLength;
  if (points.length < 2) {
    const p = points[0] ?? { x: 0, y: 0 };
    return { x: p.x, y: p.y, angle: 0 };
  }
  const d = Math.max(0, Math.min(total, dist));
  let lo = 0, hi = cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= d) lo = mid; else hi = mid;
  }
  const a = points[lo], b = points[hi];
  const span = cum[hi] - cum[lo];
  const f = span > 1e-6 ? (d - cum[lo]) / span : 0;
  const dx = b.x - a.x, dy = b.y - a.y;
  return {
    x: a.x + dx * f,
    y: a.y + dy * f,
    angle: Math.atan2(dy, dx),
  };
}

/**
 * Onde o serviço está no instante `time`. O ciclo é a volta completa (ida, volta e as paradas
 * no meio); cada veículo do horário desfasado de `cycle / units`, que é exatamente o que mantém
 * o intervalo da frota prometido pelo serviço, e a linha inteira desfasada de `route.phase`, que
 * é o que impede duas linhas de ritmos parecidos de chegar juntas ao mesmo cruzamento.
 */
export function sampleRoute(
  route: TransportRoute, service: TransportService, time: number, unit: number,
): TransportSample {
  const u = mod(time - route.phase - (unit * route.cycle) / route.units, route.cycle);
  const table = route.table;
  let k = 0;
  for (let i = table.length - 1; i >= 0; i--) {
    if (table[i].time <= u) { k = i; break; }
  }
  const cur = table[k];
  const next = table[k + 1] ?? { dist: 0, time: route.cycle };
  const dir: 1 | -1 = u < route.turnAt ? 1 : -1;
  const stopIndex = k < route.stops.length ? k : 2 * route.stops.length - 1 - k;
  // A última passada de uma linha que morre no pátio é descanso, não embarque apressado: o
  // ônibus encosta na baia, fecha a porta e fica ali até a hora de virar o ciclo. É o que põe
  // lataria estacionada dentro da rodoviária, e é o que faz a frota da linha de terminal ser
  // menor que o comprido do trajeto pede.
  const parado = service.dwell + (k === table.length - 1 ? route.layover : 0);
  if (u < cur.time + parado) {
    const p = alongRoute(route, cur.dist, dir);
    return {
      ...p, stopped: true, dir, stop: stopIndex, pass: k, phase: u,
      parked: k === table.length - 1,
    };
  }
  const span = next.time - cur.time - parado;
  const f = span > 1e-6 ? (u - cur.time - parado) / span : 1;
  // O virador de terminal não interpola entre os dois `dist`: a ida e a volta são medidas por
  // polilinhas diferentes, e o último ponto de uma não é o primeiro da outra — o `dist` da
  // volta recomeça do zero. Misturá-los faria o ônibus correr a faixa de volta inteira ao
  // contrário no instante da travessia, uns poucos frames que cruzam lataria e sentido.
  const desde = k === route.stops.length - 1 ? 0 : cur.dist;
  const p = alongRoute(route, desde + (next.dist - desde) * f, dir);
  return { ...p, stopped: false, parked: false, dir, stop: stopIndex, pass: k, phase: u };
}

/**
 * Caixa de contorno de uma rota, para o portão de tier saber se ela alcança o jogador. São
 * as duas faixas: a da ida e a da volta, que hoje correm lados opostos da mesma via.
 */
export function routeBounds(route: TransportRoute): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of route.points) {
    if (p.x < x0) x0 = p.x;
    if (p.x > x1) x1 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.y > y1) y1 = p.y;
  }
  for (const p of route.back) {
    if (p.x < x0) x0 = p.x;
    if (p.x > x1) x1 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.y > y1) y1 = p.y;
  }
  return { x0, y0, x1, y1 };
}

/**
 * Instante absoluto em que a passada `k` de um veículo acontece depois de `time`.
 *
 * O que define a passada é onde ela cai dentro da volta, não em qual volta ela foi escrita:
 * `phase` mora em [0, 2·ciclo), porque é o desfaso do veículo somado à tabela. Reduzir ao
 * relógio de `time` só para frente, como faz um `while (fase < time) fase += ciclo`, nunca
 * traria a passada de volta — numa linha cujo ciclo é mais longo que o tempo decorrido do
 * jogo o painel mostraria o ônibus chegando daqui a quase duas voltas. Com `game.time`
 * crescendo sem parar, isso é questão de minutos de partida.
 */
export function passAt(route: TransportRoute, k: number, time: number, unit: number): number {
  const { cycle, units } = route;
  const phase = route.phase + (unit * cycle) / units + route.table[k].time;
  // `|| cycle`: a passada que cai exatamente em `time` já está acontecendo, e a pergunta é
  // pela próxima.
  return time + (mod(phase - time, cycle) || cycle);
}

/**
 * Próximas passadas na calçada, na ordem em que chegam. É a conta do relógio, não uma
 * simulação: dá para responder de qualquer lugar do mundo, e é assim que o mapa cheio
 * mostrará o horário de uma parada que o jogador nunca viu.
 */
export function nextArrivals(
  network: TransportNetwork, station: number, time: number, count = 3,
): TransportArrival[] {
  const found: TransportArrival[] = [];
  const S = (route: TransportRoute) => route.stops.length;
  for (const routeId of network.stopsAt[station]) {
    const route = network.routes[routeId];
    for (let i = 0; i < S(route); i++) {
      if (route.stops[i].station !== station) continue;
      for (const k of [i, 2 * S(route) - 1 - i]) {
        let best = Infinity;
        for (let unit = 0; unit < route.units; unit++) {
          const t = passAt(route, k, time, unit);
          if (t < best) best = t;
        }
        if (Number.isFinite(best)) found.push({ route: routeId, station, in: best - time });
      }
    }
  }
  found.sort((a, b) => a.in - b.in || a.route - b.route);
  return found.slice(0, count);
}

/** Índice da parada `station` na rota, ou -1 se ela não para ali. */
export function stopIndexOn(route: TransportRoute, station: number): number {
  for (let i = 0; i < route.stops.length; i++) if (route.stops[i].station === station) return i;
  return -1;
}

/**
 * Uma linha de partida do painel de embarque. É o sentido, não a linha: a mesma linha passa
 * na mesma calçada duas vezes por volta, uma para cada ponta, e quem olha o telão quer saber
 * "Linha 3 sentido Avenida 7 · 8 s", não "Linha 3". `pass` é o índice da passada na tabela
 * da rota — o mesmo índice que `sampleRoute` lê — porque é por ele que a viagem sabe em que
 * sentido o ônibus encosta, sem adivinhar olhando a posição do veículo.
 */
export interface TransportDeparture {
  route: number;
  pass: number;
  /** A estação do ponto final deste sentido: o destino que o painel oferece. */
  destination: number;
  /** Segundos até o ônibus encostar nesta calçada. */
  wait: number;
  /**
   * O índice do veículo que serve a espera anunciada. É ele, e não "um ônibus da linha", que
   * encosta na baia no horário do painel, e por isso o prefixo da lataria pode ser mostrado
   * junto: o passageiro procura no pátio o número que leu no telão.
   */
  unit: number;
  /** Segundos de trajeto até o ponto final, embarcando nesta passada. */
  ride: number;
  /**
   * O id da plataforma onde esta linha encosta, ou -1 na calçada de rua, que tem marquise e
   * não tem baia. É a placa que o passageiro procura depois de escolher no telão, e vem da
   * mesma lista que a régua do embarque lê: painel, GPS e porta apontam para o mesmo tile.
   */
  platform: number;
}

/**
 * O telão de partidas de uma calçada, na ordem em que os ônibus chegam. Não é uma lista de
 * linhas sorteadas: cada linha que serve a parada entra com os dois sentidos que ela tem, e o
 * tempo é o do horário (`passAt` com o desfaso de cada veículo), o mesmo número que desenha o
 * ônibus no asfalto. Uma linha cujo ponto final é a própria parada fica de fora — ninguém
 * embarca para não ir a lugar nenhum.
 */
export function departures(
  network: TransportNetwork, station: number, time: number,
): TransportDeparture[] {
  const found: TransportDeparture[] = [];
  // A baia de cada linha nesta calçada: lida da mesma lista que pinta o chão e que abre a
  // porta, para o número do painel ser o número da placa na quadra.
  const baias = network.stations[station]?.platforms ?? [];
  const onde = (routeId: number): number => {
    for (const id of baias) if (network.platforms[id].lines.includes(routeId)) return id;
    return -1;
  };
  for (const routeId of network.stopsAt[station]) {
    const route = network.routes[routeId];
    const S = route.stops.length;
    const last = 2 * S - 1;
    for (let i = 0; i < S; i++) {
      if (route.stops[i].station !== station) continue;
      // Ida nesta passada, volta na espelhada: é a mesma simetria que constrói a tabela.
      for (const pass of [i, last - i]) {
        const fim = pass < S ? S - 1 : last;
        const ride = route.table[fim].time - route.table[pass].time;
        if (ride <= network.services[route.service].dwell) continue;
        let wait = Infinity;
        let veículo = 0;
        for (let unit = 0; unit < route.units; unit++) {
          const t = passAt(route, pass, time, unit) - time;
          if (t < wait) { wait = t; veículo = unit; }
        }
        if (!Number.isFinite(wait)) continue;
        // O índice da parada é dobrado como em `sampleRoute`: a volta percorre a tabela de
        // trás para frente, e o ponto final dela é a primeira parada, não uma linha imaginária.
        const parada = fim < S ? fim : 2 * S - 1 - fim;
        found.push({
          route: routeId, pass, destination: route.stops[parada].station,
          wait, unit: veículo, ride, platform: onde(routeId),
        });
      }
    }
  }
  // Duas passadas da mesma linha no mesmo sentido (uma calçada servida duas vezes no ciclo)
  // são a mesma partida: fica a que chega primeiro, que é a que o painel mostraria.
  const melhor = new Map<string, TransportDeparture>();
  for (const d of found) {
    const chave = `${d.route}|${d.destination}`;
    const anterior = melhor.get(chave);
    if (!anterior || d.wait < anterior.wait) melhor.set(chave, d);
  }
  return [...melhor.values()].sort((a, b) => a.wait - b.wait || a.route - b.route);
}

/**
 * O embarque anunciado. O telão não promete uma linha, promete um ônibus: hora, plataforma e
 * matrícula. Quem toca naquela linha do painel tem de entrar NAQUELE veículo, senão o avisado
 * e o cumprido são duas viagens diferentes que por acaso rodam a mesma avenida — e é exatamente
 * o que o passageiro vê: o 104 encostando na baia enquanto o GPS manda esperar o 109.
 *
 * Devolve nulo quando o anúncio não bate com o destino (o veículo escolhido não passa por
 * ali), e nulo também quando o ônibus que o painel mostrou já era: o anúncio é o próximo
 * turno daquela passada, e planejar depois dele é inventar um embarque que ninguém anunciou.
 */
export function announcedRide(
  route: TransportRoute, service: TransportService, from: number, to: number, time: number,
  pass: number, unit: number,
): TransportLeg | null {
  const T = route.table.length;
  const stopOf = (idx: number) => {
    const i = idx < route.stops.length ? idx : 2 * route.stops.length - 1 - idx;
    return route.stops[i]?.station ?? -1;
  };
  if (stopOf(mod(pass, T)) !== from) return null;
  const board = passAt(route, mod(pass, T), time, unit);
  const delta0 = route.table[mod(pass, T)].time;
  for (let step = 1; step < T; step++) {
    const j = pass + step;
    if (stopOf(mod(j, T)) !== to) continue;
    const raw = j < T ? route.table[j].time : route.table[j - T].time + route.cycle;
    const delta = raw - delta0;
    if (delta <= service.dwell) continue;
    return { route: route.id, from, to, board, arrive: board + delta, pass: mod(pass, T), unit };
  }
  return null;
}

/**
 * Embarque e chegada mais cedo de uma linha, com a passada que o ônibus encosta: é o índice da
 * tabela que diz o sentido, porque a mesma calçada recebe a ida e a volta da mesma linha.
 * Varre cada veículo do horário e cada passada da parada de embarque, e caminha a tabela até a
 * parada de destino — com uma volta de folga, porque o destino pode estar atrás de quem embarcou
 * na ida e só aparecer depois de o terminal virar o ciclo.
 */
function earliestRide(
  route: TransportRoute, service: TransportService, from: number, to: number, time: number,
): { board: number; arrive: number; pass: number; unit: number } | null {
  const T = route.table.length;
  const S = route.stops.length;
  const stopOf = (idx: number) => {
    const i = idx < S ? idx : 2 * S - 1 - idx;
    return route.stops[i]?.station ?? -1;
  };
  let best: { board: number; arrive: number; pass: number; unit: number } | null = null;
  for (let unit = 0; unit < route.units; unit++) {
    for (let k = 0; k < T; k++) {
      if (stopOf(k) !== from) continue;
      const board = passAt(route, k, time, unit);
      const delta0 = route.table[k].time;
      for (let step = 1; step < T; step++) {
        const j = k + step;
        if (stopOf(j % T) !== to) continue;
        const raw = j < T ? route.table[j].time : route.table[j - T].time + route.cycle;
        const delta = raw - delta0;
        if (delta <= service.dwell) continue;
        const arrive = board + delta;
        // O embarque manda, e a chegada desempata: é o ônibus que encosta primeiro nesta
        // calçada que o painel anuncia, e o plano que o jogador cumpre tem de ser o MESMO
        // veículo. Escolher o que chega antes, quando for outro, daria ao passageiro um número
        // de frota no telão e outro no GPS — dois horários contando a mesma viagem de cabeça
        // para baixo.
        if (!best || board < best.board - 1e-9 || (Math.abs(board - best.board) <= 1e-9 && arrive < best.arrive)) {
          best = { board, arrive, pass: k, unit };
        }
        break;
      }
    }
  }
  return best;
}

/**
 * Viagem de uma calçada a outra com o menor número de embarques. O plano é do horário, não
 * do asfalto: ele devolve os instantes de embarque e de chegada, que é o que a Fase 3 vai
 * transformar em "and até a parada, espere, embarque, desça".
 *
 * Com `anunciado`, a primeira perna é O veículo que o painel mostrou — linha, passada e
 * matrícula — e o resto da viagem é planejado a partir da calçada onde ele deixa o passageiro.
 * Sem ele, o plano escolhe o primeiro ônibus que alcança o destino, que é o que o GPS faz
 * quando ninguém tocou em linha nenhuma.
 */
export function planTrip(
  network: TransportNetwork, from: number, to: number, time: number,
  anunciado?: { route: number; pass: number; unit: number } | null,
): TransportTrip | null {
  if (from === to || !network.stations[from] || !network.stations[to]) return null;
  if (anunciado) {
    const rota = network.routes[anunciado.route];
    if (!rota) return null;
    // O ônibus anunciado serve o destino ou não há viagem: quem tocou numa linha do painel não
    // é despachado para um transbordo que o painel não mostrou.
    const perna = announcedRide(rota, network.services[rota.service], from, to, time,
      anunciado.pass, anunciado.unit);
    if (!perna) return null;
    return { legs: [perna], transfers: 0, arrive: perna.arrive };
  }
  type Reach = { rides: number; route: number; prev: number };
  const best = new Int32Array(network.stations.length).fill(-1);
  const froms = new Int32Array(network.stations.length).fill(-1);
  const routes = new Int32Array(network.stations.length).fill(-1);
  best[from] = 0;
  const queue: number[] = [from];
  for (let head = 0; head < queue.length; head++) {
    const station = queue[head];
    for (const routeId of network.stopsAt[station]) {
      const route = network.routes[routeId];
      for (const stop of route.stops) {
        const next = stop.station;
        if (best[next] >= 0 && best[next] <= best[station] + 1) continue;
        best[next] = best[station] + 1;
        routes[next] = routeId;
        froms[next] = station;
        queue.push(next);
      }
    }
  }
  if (best[to] < 0) return null;
  const chain: { route: number; from: number; to: number }[] = [];
  for (let cur = to; cur !== from; cur = froms[cur]) {
    chain.unshift({ route: routes[cur], from: froms[cur], to: cur });
  }
  const legs: TransportLeg[] = [];
  let clock = time;
  for (const step of chain) {
    const ride = earliestRide(
      network.routes[step.route], network.services[network.routes[step.route].service],
      step.from, step.to, clock,
    );
    if (!ride) return null;
    legs.push({
      route: step.route, from: step.from, to: step.to,
      board: ride.board, arrive: ride.arrive, pass: ride.pass, unit: ride.unit,
    });
    clock = ride.arrive;
  }
  return { legs, transfers: legs.length - 1, arrive: legs[legs.length - 1].arrive };
}

/** Parada mais perto de um ponto do mundo, dentro do alcance do pedestre. */
export function stopsNear(
  network: TransportNetwork, x: number, y: number, radius: number,
): TransportStation[] {
  const { cell, cols, rows, head, next } = network.grid;
  const found: TransportStation[] = [];
  const cx = Math.floor(x / cell), cy = Math.floor(y / cell);
  const reach = Math.ceil(radius / cell);
  for (let gy = cy - reach; gy <= cy + reach; gy++) {
    if (gy < 0 || gy >= rows) continue;
    for (let gx = cx - reach; gx <= cx + reach; gx++) {
      if (gx < 0 || gx >= cols) continue;
      for (let i = head[gy * cols + gx]; i >= 0; i = next[i]) {
        const s = network.stations[i];
        if (Math.hypot(s.x - x, s.y - y) <= radius) found.push(s);
      }
    }
  }
  found.sort((a, b) => Math.hypot(a.x - x, a.y - y) - Math.hypot(b.x - x, b.y - y) || a.id - b.id);
  return found;
}
