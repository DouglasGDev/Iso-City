import type { Dir4 } from '../game/GameConfig';
import { GAME_CONFIG } from '../game/GameConfig';
import type { Map } from '../world/Map';
import type { NPC } from '../entities/NPC';
import type { Vehicle } from '../entities/Vehicle';
import { dirToAngle, velocityToDir } from '../world/IsoUtils';
import { terrain } from './TerrainSystem';
import { vehicleGroundCollider, type CollisionSystem } from './CollisionSystem';
import { segmentAabb } from './WeaponSystem';

/**
 * Conduzir uma viatura de IA e descer a tripulação dela.
 *
 * Isto é mecânica, não conveniência: a polícia dirige assim desde que as viaturas pararam de
 * teletransportar para o alvo, e os bombeiros e o SAMU precisam exatamente do mesmo — um veículo
 * que segue a malha de asfalto, que enruga quando não consegue, que estaciona onde a rua passa e
 * de cujo lado há calçada livre para alguém descer. Deixar isso dentro do `PoliceSystem` e copiar
 * para o caminhão de fogo seria ter duas réguas discordando da mesma rua: a de lá já tem quatro
 * chamadas próprias (patrulha dirigida, resposta dirigida, busca a pé, volta ao quartel) e cada
 * cópia envelheceria justo quando a regra de rota mudasse.
 *
 * O que ficou aqui é o movimento. O que ficou em cada serviço é a decisão — para onde ir, quando
 * descer, quando voltar — porque é aí que a ronda, o incêndio e a ambulância são coisas diferentes.
 */

export type Ponto = { x: number; y: number };

/** O estado de uma rota. Vive no agente, nunca aqui: duas viaturas não podem dividir um waypoint. */
export interface Rota {
  route: Ponto[];
  routeIndex: number;
  refreshTimer: number;
}

export const rotaNova = (): Rota => ({ route: [], routeIndex: 0, refreshTimer: 0 });

/** Limpa a rota de um agente que acabou de mudar de ideia (novo alvo, nova ocorrência). */
export function esqueceARota(rota: Rota): void {
  rota.route = [];
  rota.routeIndex = 0;
  rota.refreshTimer = 0;
}

/** Linha reta sem prédio nem carro no meio: é o que autoriza o atalho a pé, cortando o quarteirão. */
export function linhaLivre(map: Map, from: Ponto, to: Ponto): boolean {
  const radius = Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y)) / 2;
  return !map.queryNearby((from.x + to.x) / 2, (from.y + to.y) / 2, radius + 0.01)
    .some((box) => segmentAabb(from.x, from.y, to.x, to.y, box) !== null);
}

/**
 * O próximo passo em direção ao objetivo, pela malha certa: asfalto para veículo, calçada para
 * corpo. `patrol` usa a rota **dirigida** (mão única respeitada, para a ronda não parecer Guida
 * contra a mão); a resposta usa a não-dirigida, porque quem atende uma ocorrência entra pela
 * contramão do mapa sem ceremonya nenhuma — e é melhor chegar por uma rua proibida do que ficar
 * girando em torno do quarteirão enquanto o lugar queima.
 */
export function waypoint(
  rota: Rota, from: Ponto, goal: Ponto, dt: number, map: Map, rng: () => number,
  onFoot = false, patrol = false,
): Ponto {
  rota.refreshTimer -= dt;
  const distance = Math.hypot(from.x - goal.x, from.y - goal.y);
  let dry = true;
  if (distance < 6) {
    const steps = Math.max(1, Math.ceil(distance * 3));
    for (let i = 1; i <= steps; i++) {
      if (map.isWaterWorld(from.x + (goal.x - from.x) * i / steps, from.y + (goal.y - from.y) * i / steps)) dry = false;
    }
  }
  if (onFoot && distance < 6 && dry && linhaLivre(map, from, goal)) return goal;
  if (rota.refreshTimer <= 0) {
    rota.route = onFoot ? map.findSidewalkPath(from.x, from.y, goal.x, goal.y)
      : patrol ? map.findRoadPath(from.x, from.y, goal.x, goal.y)
        : map.findUndirectedRoadPath(from.x, from.y, goal.x, goal.y);
    rota.routeIndex = rota.route.length > 1 && Math.hypot(rota.route[0].x - from.x, rota.route[0].y - from.y) < 0.75 ? 1 : 0;
    rota.refreshTimer = patrol ? 12 : 2.2 + rng() * 0.4;
  }
  while (rota.routeIndex < rota.route.length &&
    Math.hypot(from.x - rota.route[rota.routeIndex].x, from.y - rota.route[rota.routeIndex].y) < 0.2) rota.routeIndex++;
  if (rota.routeIndex < rota.route.length) return rota.route[rota.routeIndex];
  return onFoot && distance < 5 && dry && linhaLivre(map, from, goal) ? goal : from;
}

/**
 * Move o veículo com a lataria inteira julgando, em subpassos de 0,15 tile: é o que não deixa um
 * carro atravessar a esquina de um prédio na diagonal quando o dt é grande. A montanha barra do
 * mesmo jeito que barra o jogador — viatura nenhuma corta talude.
 */
export function deslizaViatura(
  v: Vehicle, map: Map, collision: CollisionSystem, vehicles: Vehicle[], vx: number, vy: number, dt: number,
): void {
  const steps = Math.max(1, Math.ceil(Math.hypot(vx, vy) * dt / 0.15));
  const radius = Math.min(v.def.footprintW, v.def.footprintH) / 2;
  for (let i = 0; i < steps; i++) {
    const prevX = v.x, prevY = v.y;
    const circle = { x: v.x + vx * dt / steps, y: v.y + vy * dt / steps, radius };
    collision.resolveCircle(circle, map.queryNearby(circle.x, circle.y, 2));
    collision.resolveCircleVsVehicles(circle, vehicles, v.id);
    terrain.blockDrive(map, circle, prevX, prevY);
    if (map.isInside(circle.x, circle.y, radius) && !map.isWaterWorld(circle.x, circle.y)) { v.x = circle.x; v.y = circle.y; }
  }
}

/**
 * O lado de onde a tripulação desce: os quatro flancos da lataria, do mais perto para o mais longe,
 * aceitando o primeiro que tem calçada livre, linha de visão do carro até lá, nenhum outro veículo
 * ocupando e nenhum corpo parado em cima. Um ponto de porta ruim é viatura atravessada na rua ou
 * bombeiro nascendo dentro de uma parede.
 */
export function pontoDeSaída(
  v: Vehicle, npc: NPC, map: Map, collision: CollisionSystem, vehicles: Vehicle[], npcs: NPC[],
): Ponto | null {
  const box = vehicleGroundCollider(v);
  const margin = GAME_CONFIG.NPC_RADIUS + 0.12;
  const points = [
    { x: box.x - margin, y: v.y }, { x: box.x + box.width + margin, y: v.y },
    { x: v.x, y: box.y - margin }, { x: v.x, y: box.y + box.height + margin },
  ].sort((a, b) => Math.hypot(a.x - npc.x, a.y - npc.y) - Math.hypot(b.x - npc.x, b.y - npc.y));
  for (const p of points) {
    const circle = { ...p, radius: GAME_CONFIG.NPC_RADIUS };
    if (!map.isInside(p.x, p.y, circle.radius) || map.isWaterWorld(p.x, p.y) ||
      collision.overlapsAny(circle, map.queryNearby(p.x, p.y, 1)) ||
      !linhaLivre(map, v, p)) continue;
    if (vehicles.some((other) => other !== v && other.altitude <= 0.5 &&
      collision.overlapsAny(circle, [vehicleGroundCollider(other)]))) continue;
    if (npcs.some((n) => n !== npc && !n.dead && !n.inVehicle && Math.hypot(n.x - p.x, n.y - p.y) < 0.4)) continue;
    return p;
  }
  return null;
}

/**
 * Um passo de gente: subpassos de 0,1 tile contra parede, carro e talude, com a animação amarrada
 * ao passo de verdade (não ao desejo de andar) — é por isso que o corpo para de mexer as pernas no
 * instante em que encosta em alguma coisa.
 */
export function passaAndando(
  npc: NPC, dx: number, dy: number, dt: number, map: Map, collision: CollisionSystem, vehicles: Vehicle[],
): void {
  const distance = Math.hypot(dx, dy);
  if (!distance) return;
  const steps = Math.max(1, Math.ceil(npc.speed * dt / 0.1));
  for (let i = 0; i < steps; i++) {
    const prevX = npc.x, prevY = npc.y;
    const circle = { x: npc.x + dx / distance * npc.speed * dt / steps, y: npc.y + dy / distance * npc.speed * dt / steps, radius: GAME_CONFIG.NPC_RADIUS };
    collision.resolveCircle(circle, map.queryNearby(circle.x, circle.y, 1.5));
    collision.resolveCircleVsVehicles(circle, vehicles);
    terrain.blockWalk(map, circle, prevX, prevY);
    if (map.isInside(circle.x, circle.y, circle.radius) && !map.isWaterWorld(circle.x, circle.y)) { npc.x = circle.x; npc.y = circle.y; }
  }
  npc.dir = velocityToDir(dx, dy);
  npc.animTimer += dt * 1000;
  if (npc.animTimer > 110) { npc.animTimer = 0; npc.frame = (npc.frame + 1) % 4; }
}

/** A direção que o sprite do veículo mostra a partir do vetor de deslocamento. */
export function direçãoDoPasso(dx: number, dy: number): Dir4 {
  return Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 'SE' : 'NW') : (dy >= 0 ? 'SW' : 'NE');
}

export function apontaViatura(v: Vehicle, dx: number, dy: number): void {
  const dir = direçãoDoPasso(dx, dy);
  v.dir = dir;
  v.facingAngle = dirToAngle(dir);
}
