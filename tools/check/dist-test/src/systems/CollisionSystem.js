"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CollisionSystem = void 0;
exports.collideCircleAabb = collideCircleAabb;
exports.vehicleGroundCollider = vehicleGroundCollider;
exports.streetBodyCollider = streetBodyCollider;
function collideCircleAabb(circle, c) {
    const cx = Math.max(c.x, Math.min(circle.x, c.x + c.width));
    const cy = Math.max(c.y, Math.min(circle.y, c.y + c.height));
    let dx = circle.x - cx;
    let dy = circle.y - cy;
    const distSq = dx * dx + dy * dy;
    const r = circle.radius;
    if (distSq > r * r)
        return { collided: false, pushX: 0, pushY: 0 };
    if (distSq > 1e-9) {
        const dist = Math.sqrt(distSq);
        const overlap = r - dist;
        dx /= dist;
        dy /= dist;
        return { collided: true, pushX: dx * overlap, pushY: dy * overlap };
    }
    const left = circle.x - c.x;
    const right = c.x + c.width - circle.x;
    const top = circle.y - c.y;
    const bottom = c.y + c.height - circle.y;
    const min = Math.min(left, right, top, bottom);
    if (min === right)
        return { collided: true, pushX: right + r, pushY: 0 };
    if (min === left)
        return { collided: true, pushX: -left - r, pushY: 0 };
    if (min === bottom)
        return { collided: true, pushX: 0, pushY: bottom + r };
    return { collided: true, pushX: 0, pushY: -top - r };
}
function vehicleGroundCollider(vehicle) {
    const alongX = vehicle.dir === 'SE' || vehicle.dir === 'NW';
    const width = alongX ? vehicle.def.footprintH : vehicle.def.footprintW;
    const height = alongX ? vehicle.def.footprintW : vehicle.def.footprintH;
    return { x: vehicle.x - width / 2, y: vehicle.y - height / 2, width, height, type: 'VEHICLE' };
}
/**
 * A lataria de um ônibus do horário no chão, na caixa com que se bate. O corpo do horário não é
 * `Vehicle` — não tem `def`, motorista nem banco —, mas ele ocupa asfalto, e um pedestre que
 * atravessa a faixa hoje passa por dentro dele como se a lataria fosse de fumaça. A caixa é a
 * mesma régua que a regra de trânsito usa: `meio` no eixo comprido, `flanco` no curto, trocados
 * de lado quando o ônibus corre no eixo X, exatamente como o `footprint` do carro.
 */
function streetBodyCollider(corpo) {
    const alongX = corpo.dir === 'SE' || corpo.dir === 'NW';
    const width = alongX ? corpo.meio * 2 : corpo.flanco * 2;
    const height = alongX ? corpo.flanco * 2 : corpo.meio * 2;
    return { x: corpo.x - width / 2, y: corpo.y - height / 2, width, height, type: 'VEHICLE' };
}
class CollisionSystem {
    resolveCircle(circle, colliders) {
        let moved = true;
        let iterations = 0;
        while (moved && iterations < 4) {
            moved = false;
            iterations++;
            for (const c of colliders) {
                const res = collideCircleAabb(circle, c);
                if (res.collided) {
                    circle.x += res.pushX;
                    circle.y += res.pushY;
                    moved = true;
                }
            }
        }
        return moved;
    }
    overlapsAny(circle, colliders) {
        for (const c of colliders) {
            const res = collideCircleAabb(circle, c);
            if (res.collided)
                return true;
        }
        return false;
    }
    resolveCircleVsVehicles(circle, vehicles, ignoreId = null, radius = 0.42) {
        let moved = true;
        let iterations = 0;
        while (moved && iterations < 4) {
            moved = false;
            iterations++;
            for (const v of vehicles) {
                if (v.id === ignoreId || v.state === 'destroyed' || v.altitude > 0.5)
                    continue;
                const reach = Math.max(v.def.footprintW, v.def.footprintH, radius) + circle.radius;
                if (Math.abs(circle.x - v.x) > reach || Math.abs(circle.y - v.y) > reach)
                    continue;
                const result = collideCircleAabb(circle, vehicleGroundCollider(v));
                if (result.collided && (result.pushX !== 0 || result.pushY !== 0)) {
                    circle.x += result.pushX;
                    circle.y += result.pushY;
                    moved = true;
                }
            }
        }
    }
    /**
     * O mesmo empurrão dos carros, para os corpos do horário. Só a lataria viva: fora do alcance
     * da câmera o ônibus não tem posição calculada, e um corpo parado no último pixel em que ele
     * foi visto seria uma parede invisível na rua vazia.
     */
    resolveCircleVsBuses(circle, bodies) {
        let moved = true;
        let iterations = 0;
        while (moved && iterations < 4) {
            moved = false;
            iterations++;
            for (const b of bodies) {
                if (!b.live)
                    continue;
                const reach = Math.max(b.meio, b.flanco) + circle.radius;
                if (Math.abs(circle.x - b.x) > reach || Math.abs(circle.y - b.y) > reach)
                    continue;
                const result = collideCircleAabb(circle, streetBodyCollider(b));
                if (result.collided && (result.pushX !== 0 || result.pushY !== 0)) {
                    circle.x += result.pushX;
                    circle.y += result.pushY;
                    moved = true;
                }
            }
        }
    }
}
exports.CollisionSystem = CollisionSystem;
