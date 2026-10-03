"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.alongRoute = alongRoute;
exports.sampleRoute = sampleRoute;
exports.routeBounds = routeBounds;
exports.nextArrivals = nextArrivals;
exports.stopIndexOn = stopIndexOn;
exports.planTrip = planTrip;
exports.stopsNear = stopsNear;
const mod = (v, m) => ((v % m) + m) % m;
/** Ponto da polilinha a uma distância do origem, com a orientação de quem a percorre. */
function alongRoute(route, dist, dir) {
    const { points, cum } = route;
    if (points.length < 2) {
        const p = points[0] ?? { x: 0, y: 0 };
        return { x: p.x, y: p.y, angle: 0 };
    }
    const d = Math.max(0, Math.min(route.length, dist));
    let lo = 0, hi = cum.length - 1;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (cum[mid] <= d)
            lo = mid;
        else
            hi = mid;
    }
    const a = points[lo], b = points[hi];
    const span = cum[hi] - cum[lo];
    const f = span > 1e-6 ? (d - cum[lo]) / span : 0;
    const dx = b.x - a.x, dy = b.y - a.y;
    return {
        x: a.x + dx * f,
        y: a.y + dy * f,
        angle: Math.atan2(dir * dy, dir * dx),
    };
}
/**
 * Onde o serviço está no instante `time`. O ciclo é a volta completa (ida, volta e as
 * paradas no meio); cada veículo do horário desfasado de `cycle / units`, que é exatamente
 * o que mantém o intervalo da frota prometido pelo serviço.
 */
function sampleRoute(route, service, time, unit) {
    const u = mod(time - (unit * route.cycle) / route.units, route.cycle);
    const table = route.table;
    let k = 0;
    for (let i = table.length - 1; i >= 0; i--) {
        if (table[i].time <= u) {
            k = i;
            break;
        }
    }
    const cur = table[k];
    const next = table[k + 1] ?? { dist: 0, time: route.cycle };
    const dir = u < route.turnAt ? 1 : -1;
    const stopIndex = k < route.stops.length ? k : 2 * route.stops.length - 1 - k;
    if (u < cur.time + service.dwell) {
        const p = alongRoute(route, cur.dist, dir);
        return { ...p, stopped: true, dir, stop: stopIndex };
    }
    const span = next.time - cur.time - service.dwell;
    const f = span > 1e-6 ? (u - cur.time - service.dwell) / span : 1;
    const p = alongRoute(route, cur.dist + (next.dist - cur.dist) * f, dir);
    return { ...p, stopped: false, dir, stop: stopIndex };
}
/** Caixa de contorno de uma rota, para o portão de tier saber se ela alcança o jogador. */
function routeBounds(route) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of route.points) {
        if (p.x < x0)
            x0 = p.x;
        if (p.x > x1)
            x1 = p.x;
        if (p.y < y0)
            y0 = p.y;
        if (p.y > y1)
            y1 = p.y;
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
function passAt(route, k, time, unit) {
    const { cycle, units } = route;
    const phase = (unit * cycle) / units + route.table[k].time;
    // `|| cycle`: a passada que cai exatamente em `time` já está acontecendo, e a pergunta é
    // pela próxima.
    return time + (mod(phase - time, cycle) || cycle);
}
/**
 * Próximas passadas na calçada, na ordem em que chegam. É a conta do relógio, não uma
 * simulação: dá para responder de qualquer lugar do mundo, e é assim que o mapa cheio
 * mostrará o horário de uma parada que o jogador nunca viu.
 */
function nextArrivals(network, station, time, count = 3) {
    const found = [];
    const S = (route) => route.stops.length;
    for (const routeId of network.stopsAt[station]) {
        const route = network.routes[routeId];
        for (let i = 0; i < S(route); i++) {
            if (route.stops[i].station !== station)
                continue;
            for (const k of [i, 2 * S(route) - 1 - i]) {
                let best = Infinity;
                for (let unit = 0; unit < route.units; unit++) {
                    const t = passAt(route, k, time, unit);
                    if (t < best)
                        best = t;
                }
                if (Number.isFinite(best))
                    found.push({ route: routeId, station, in: best - time });
            }
        }
    }
    found.sort((a, b) => a.in - b.in || a.route - b.route);
    return found.slice(0, count);
}
/** Índice da parada `station` na rota, ou -1 se ela não para ali. */
function stopIndexOn(route, station) {
    for (let i = 0; i < route.stops.length; i++)
        if (route.stops[i].station === station)
            return i;
    return -1;
}
/**
 * Embarque e chegada mais cedo de uma linha. Varre cada veículo do horário e cada passada
 * da parada de embarque, e caminha a tabela até a parada de destino — com uma volta de
 * folga, porque o destino pode estar atrás de quem embarcou na ida e só aparecer depois de
 * o terminal virar o ciclo.
 */
function earliestRide(route, service, from, to, time) {
    const T = route.table.length;
    const S = route.stops.length;
    const stopOf = (idx) => {
        const i = idx < S ? idx : 2 * S - 1 - idx;
        return route.stops[i]?.station ?? -1;
    };
    let best = null;
    for (let unit = 0; unit < route.units; unit++) {
        for (let k = 0; k < T; k++) {
            if (stopOf(k) !== from)
                continue;
            const board = passAt(route, k, time, unit);
            const delta0 = route.table[k].time;
            for (let step = 1; step < T; step++) {
                const j = k + step;
                if (stopOf(j % T) !== to)
                    continue;
                const raw = j < T ? route.table[j].time : route.table[j - T].time + route.cycle;
                const delta = raw - delta0;
                if (delta <= service.dwell)
                    continue;
                const arrive = board + delta;
                if (!best || arrive < best.arrive)
                    best = { board, arrive };
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
 */
function planTrip(network, from, to, time) {
    if (from === to || !network.stations[from] || !network.stations[to])
        return null;
    const best = new Int32Array(network.stations.length).fill(-1);
    const froms = new Int32Array(network.stations.length).fill(-1);
    const routes = new Int32Array(network.stations.length).fill(-1);
    best[from] = 0;
    const queue = [from];
    for (let head = 0; head < queue.length; head++) {
        const station = queue[head];
        for (const routeId of network.stopsAt[station]) {
            const route = network.routes[routeId];
            for (const stop of route.stops) {
                const next = stop.station;
                if (best[next] >= 0 && best[next] <= best[station] + 1)
                    continue;
                best[next] = best[station] + 1;
                routes[next] = routeId;
                froms[next] = station;
                queue.push(next);
            }
        }
    }
    if (best[to] < 0)
        return null;
    const chain = [];
    for (let cur = to; cur !== from; cur = froms[cur]) {
        chain.unshift({ route: routes[cur], from: froms[cur], to: cur });
    }
    const legs = [];
    let clock = time;
    for (const step of chain) {
        const ride = earliestRide(network.routes[step.route], network.services[network.routes[step.route].service], step.from, step.to, clock);
        if (!ride)
            return null;
        legs.push({ route: step.route, from: step.from, to: step.to, board: ride.board, arrive: ride.arrive });
        clock = ride.arrive;
    }
    return { legs, transfers: legs.length - 1, arrive: legs[legs.length - 1].arrive };
}
/** Parada mais perto de um ponto do mundo, dentro do alcance do pedestre. */
function stopsNear(network, x, y, radius) {
    const { cell, cols, rows, head, next } = network.grid;
    const found = [];
    const cx = Math.floor(x / cell), cy = Math.floor(y / cell);
    const reach = Math.ceil(radius / cell);
    for (let gy = cy - reach; gy <= cy + reach; gy++) {
        if (gy < 0 || gy >= rows)
            continue;
        for (let gx = cx - reach; gx <= cx + reach; gx++) {
            if (gx < 0 || gx >= cols)
                continue;
            for (let i = head[gy * cols + gx]; i >= 0; i = next[i]) {
                const s = network.stations[i];
                if (Math.hypot(s.x - x, s.y - y) <= radius)
                    found.push(s);
            }
        }
    }
    found.sort((a, b) => Math.hypot(a.x - x, a.y - y) - Math.hypot(b.x - x, b.y - y) || a.id - b.id);
    return found;
}
