"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.simplifyRoute = simplifyRoute;
exports.routeLength = routeLength;
exports.remainingRouteDistance = remainingRouteDistance;
exports.buildGpsRoute = buildGpsRoute;
function dist(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
}
/** Remove pontos quase colineares / muito próximos pra desenhar limpo. */
function simplifyRoute(points, minStep = 0.85) {
    if (points.length <= 2)
        return points.slice();
    const out = [points[0]];
    for (let i = 1; i < points.length - 1; i++) {
        if (dist(out[out.length - 1], points[i]) >= minStep)
            out.push(points[i]);
    }
    const last = points[points.length - 1];
    if (dist(out[out.length - 1], last) > 0.15)
        out.push(last);
    else
        out[out.length - 1] = last;
    return out;
}
function routeLength(points) {
    let n = 0;
    for (let i = 1; i < points.length; i++)
        n += dist(points[i - 1], points[i]);
    return n;
}
/** Distância restante a partir da posição atual (aproxima pelo ponto mais próximo). */
function remainingRouteDistance(route, x, y) {
    if (route.length < 2)
        return route.length ? dist({ x, y }, route[0]) : 0;
    let bestI = 0;
    let bestD = Infinity;
    for (let i = 0; i < route.length; i++) {
        const d = dist({ x, y }, route[i]);
        if (d < bestD) {
            bestD = d;
            bestI = i;
        }
    }
    let rem = bestD;
    for (let i = bestI + 1; i < route.length; i++)
        rem += dist(route[i - 1], route[i]);
    return rem;
}
function snapToRoad(map, x, y) {
    if (map.roadNodes.length === 0)
        return null;
    const i = map.nearestRoadNode(x, y);
    return map.roadNodes[i];
}
function snapToSidewalk(map, x, y) {
    if (map.sidewalkNodes.length > 0) {
        const i = map.nearestSidewalkNode(x, y);
        return map.sidewalkNodes[i];
    }
    return snapToRoad(map, x, y);
}
/** BFS devolve centros de tile; exige passos ortogonais de ~1 tile. */
function pathLooksOnNetwork(mid) {
    if (mid.length < 2)
        return false;
    for (let i = 1; i < mid.length; i++) {
        const dx = Math.abs(mid[i].x - mid[i - 1].x);
        const dy = Math.abs(mid[i].y - mid[i - 1].y);
        // vizinhos 4-dir no grafo (~1.0); corta diagonais longas / teleporte
        if (dx + dy > 1.6 || (dx > 0.2 && dy > 0.2))
            return false;
    }
    return true;
}
/**
 * Gera rota estilo GPS só pela malha de ruas/calçadas.
 * Nunca inventa linha reta pelo mato/água se o pathfinding falhar.
 */
function buildGpsRoute(map, fromX, fromY, toX, toY, driving) {
    const start = { x: fromX, y: fromY };
    const goal = { x: toX, y: toY };
    const fromSnap = driving ? snapToRoad(map, fromX, fromY) : snapToSidewalk(map, fromX, fromY);
    const toSnap = driving ? snapToRoad(map, toX, toY) : snapToSidewalk(map, toX, toY);
    if (!fromSnap || !toSnap)
        return [start];
    let mid = [];
    if (driving) {
        // undirected primeiro: GPS de navegação, não simula mão única
        mid = map.findUndirectedRoadPath(fromSnap.x, fromSnap.y, toSnap.x, toSnap.y);
        if (!pathLooksOnNetwork(mid)) {
            mid = map.findRoadPath(fromSnap.x, fromSnap.y, toSnap.x, toSnap.y);
        }
    }
    else {
        mid = map.findSidewalkPath(fromSnap.x, fromSnap.y, toSnap.x, toSnap.y);
        if (!pathLooksOnNetwork(mid)) {
            mid = map.findUndirectedRoadPath(fromSnap.x, fromSnap.y, toSnap.x, toSnap.y);
        }
    }
    if (!pathLooksOnNetwork(mid)) {
        // inacessível (rio sem ponte etc.) — só leva até a rua mais perto
        if (dist(start, fromSnap) < 0.35)
            return [start];
        return simplifyRoute([start, fromSnap], 0.5);
    }
    const raw = [];
    if (dist(start, fromSnap) > 0.4)
        raw.push(start);
    raw.push(fromSnap);
    // mid já inclui fromSnap/toSnap como nós; evita duplicar
    for (const p of mid) {
        const last = raw[raw.length - 1];
        if (dist(last, p) > 0.2)
            raw.push(p);
    }
    if (dist(raw[raw.length - 1], toSnap) > 0.2)
        raw.push(toSnap);
    if (dist(toSnap, goal) > 0.45)
        raw.push(goal);
    return simplifyRoute(raw, driving ? 1.05 : 0.7);
}
