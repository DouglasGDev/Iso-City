import { GAME_CONFIG } from '../game/GameConfig';
import type { NPC } from '../entities/NPC';
import { velocityToDir } from '../world/IsoUtils';
import type { CollisionSystem } from './CollisionSystem';
import type { Map } from '../world/Map';
import type { Vehicle } from '../entities/Vehicle';
import type { TrafficSignalSystem } from './TrafficSignalSystem';
import { segmentAabb } from './WeaponSystem';
import { terrain } from './TerrainSystem';

interface CrossingIntent {
  from: { x: number; y: number };
  to: { x: number; y: number };
  wait: number;
  requested: boolean;
}
// Weak keys preserve array indices and disappear when the population is replaced.
const crossings = new WeakMap<NPC, CrossingIntent>();
export const pedestrianCrossingIntent = (npc: NPC) => crossings.get(npc);

function nearbyVehicles(vehicles: Vehicle[], x: number, y: number, radius: number): Vehicle[] {
  const r2 = radius * radius;
  const out: Vehicle[] = [];
  for (let i = 0; i < vehicles.length; i++) {
    const v = vehicles[i];
    const dx = v.x - x;
    const dy = v.y - y;
    if (dx * dx + dy * dy <= r2) out.push(v);
  }
  return out;
}

export class NPCSystem {
  constructor(private collision: CollisionSystem) {}

  update(npc: NPC, map: Map, vehicles: Vehicle[], dt: number, playerX: number, playerY: number, wanted: number, signals?: TrafficSignalSystem) {
    // PoliceSystem exclusively owns cops, including their knockdown timers.
    if (npc.dead || npc.inVehicle || npc.kind === 'cop' || !Number.isFinite(dt) || dt <= 0) return;
    if (npc.state !== 'walking') crossings.delete(npc);
    if (npc.callingPolice && npc.state !== 'knocked') {
      npc.anim = 'idle';
      npc.frame = npc.speed = 0;
      return;
    }

    if (npc.state === 'knocked') {
      npc.downTimer -= dt;
      npc.anim = 'idle';
      npc.frame = 0;
      npc.speed = 0;
      if (npc.downTimer <= 0) {
        npc.state = 'fleeing';
        npc.fleeTimer = 3.5 + Math.random() * 2;
      }
      return;
    }

    npc.swimming = map.isWaterWorld(npc.x, npc.y);
    // Nadando não há faixa a atravessar: o state continua 'walking' durante a natação, e sem
    // este corte o pedido de travessia feito antes de cair na água fica vivo, projeto o ponto
    // de cruzamento no eixo do carro e para uma faixa inteira atrás de um pedestre boiando.
    if (npc.swimming) crossings.delete(npc);
    if (npc.swimming) {
      this.swimToShore(npc, map, dt);
      return;
    }

    const distPlayer = Math.hypot(npc.x - playerX, npc.y - playerY);
    if (npc.state !== 'fleeing' && wanted >= 2 && distPlayer < 3.4) {
      npc.state = 'fleeing';
      npc.fleeTimer = 2.4 + Math.random() * 1.6;
    }

    if (npc.state === 'fleeing') {
      this.updateFlee(npc, map, vehicles, dt, playerX, playerY);
      return;
    }

    if (npc.state === 'walking') {
      npc.animTimer += dt * 1000;
      if (npc.animTimer > GAME_CONFIG.ANIM_FRAME_MS) {
        npc.animTimer = 0;
        npc.frame = (npc.frame + 1) % 4;
      }

      const wp = npc.path[npc.pathIndex];
      if (!wp) {
        this.goIdle(npc);
        return;
      }

      const dx = wp.x - npc.x;
      const dy = wp.y - npc.y;
      const dist = Math.hypot(dx, dy);
      if (dist < 0.2) {
        crossings.delete(npc);
        npc.pathIndex++;
        if (npc.pathIndex >= npc.path.length) {
          this.goIdle(npc);
          return;
        }
      } else {
        if (this.waitBeforeCrossing(npc, map, vehicles, dt, wp, signals)) return;
        const speed = Math.min(GAME_CONFIG.NPC_WALK_SPEED, dist / dt);
        const vx = (dx / dist) * speed;
        const vy = (dy / dist) * speed;
        const prevX = npc.x;
        const prevY = npc.y;
        npc.x += vx * dt;
        npc.y += vy * dt;

        const nearby = map.queryNearby(npc.x, npc.y, 1.5);
        const circle = { x: npc.x, y: npc.y, radius: GAME_CONFIG.NPC_RADIUS };
        this.collision.resolveCircle(circle, nearby);
        this.collision.resolveCircleVsVehicles(
          circle,
          nearbyVehicles(vehicles, npc.x, npc.y, 7.5),
          null,
          0.35,
        );
        npc.x = circle.x;
        npc.y = circle.y;
        // O passeio tem relevo: sem este julgamento o pedestre cortaria o morro por
        // dentro e a montanha deixaria de existir para a multidão.
        terrain.blockWalk(map, npc, prevX, prevY);

        // se a colisão bloqueou quase tudo, pula waypoint / repath
        const moved = Math.hypot(npc.x - prevX, npc.y - prevY);
        if (moved < GAME_CONFIG.NPC_WALK_SPEED * dt * 0.15) {
          npc.stuckTimer += dt;
          if (npc.stuckTimer > 0.7) {
            npc.pathIndex++;
            npc.stuckTimer = 0;
            if (npc.pathIndex >= npc.path.length) this.assignNewRoute(npc, map);
          }
        } else {
          npc.stuckTimer = 0;
        }

        npc.speed = GAME_CONFIG.NPC_WALK_SPEED;
        npc.anim = 'walk';
        npc.dir = velocityToDir(vx, vy);
      }

      npc.lastX = npc.x;
      npc.lastY = npc.y;
    } else {
      npc.anim = 'idle';
      npc.frame = 0;
      npc.speed = 0;
      npc.patienceTimer -= dt * 1000;
      if (npc.patienceTimer <= 0) this.assignNewRoute(npc, map);
    }
  }

  private waitBeforeCrossing(npc: NPC, map: Map, vehicles: Vehicle[], dt: number,
    wp: { x: number; y: number }, signals?: TrafficSignalSystem): boolean {
    // Once committed, clear the road even if the light changes. Never stop mid-lane.
    if (map.tileKindAt(npc.x, npc.y) === 'road') return false;
    const distance = Math.hypot(wp.x - npc.x, wp.y - npc.y);
    const ux = (wp.x - npc.x) / distance, uy = (wp.y - npc.y) / distance;
    const look = Math.min(distance, 0.8);
    if (map.tileKindAt(npc.x + ux * look, npc.y + uy * look) !== 'road') {
      crossings.delete(npc);
      return false;
    }
    let intent = crossings.get(npc);
    if (!intent || intent.to.x !== wp.x || intent.to.y !== wp.y) {
      intent = { from: { x: npc.x, y: npc.y }, to: { ...wp }, wait: 0, requested: false };
      crossings.set(npc, intent);
    }
    const signal = signals?.near(npc.x + ux * look, npc.y + uy * look);
    // Só espera faixa onde existe faixa: em cruzamento sem sinal (curva, estrada de
    // terra na reserva) quem decide é o vão entre os carros, e o pedido de travessia
    // é o que faz a fase de pedestre aparecer no ciclo do semáforo.
    const red = !!signal && signal.controlled && !signal.pedestrians;
    if (signal && red) signals?.pedestrianWaiting(signal);
    const box = { x: Math.min(npc.x, wp.x) - 0.65, y: Math.min(npc.y, wp.y) - 0.65,
      width: Math.abs(wp.x - npc.x) + 1.3, height: Math.abs(wp.y - npc.y) + 1.3, type: 'NPC' as const };
    const danger = vehicles.some((v) => {
      if (v.state === 'destroyed' || !v.def.driveable || v.altitude > 0.5) return false;
      if (Math.hypot(v.x - npc.x, v.y - npc.y) > Math.max(10, Math.abs(v.speed) * 2.5 + distance)) return false;
      // Stopped traffic only blocks if physically occupying the crossing, not by proximity.
      return segmentAabb(v.x, v.y, v.x + Math.cos(v.facingAngle) * v.speed * 2.5,
        v.y + Math.sin(v.facingAngle) * v.speed * 2.5, box) !== null;
    });
    if (!red && !danger) { intent.wait = 0; intent.requested = true; return false; }
    intent.wait += dt;
    intent.requested = !red && intent.wait >= 1.5;
    npc.speed = 0;
    npc.anim = 'idle';
    npc.frame = 0;
    npc.stuckTimer = 0; // A deliberate yield must not skip route waypoints.
    // A parked car or an uncooperative player must not freeze this pedestrian forever.
    // Red phases alone are finite and must not trigger repathing before the walk phase.
    if (danger && intent.wait >= 10 && !red) {
      this.goIdle(npc);
      npc.patienceTimer = 500;
    }
    return true;
  }

  /**
   * Margem = o node de passeio SECO mais próximo. O node mais próximo a conta pura não pode
   * ser: uma poça permanente (bacia de cachoeira, entulho alagado) em cima de um passeio deixa
   * o pedestre em cima do próprio destino, `dist` 0, e ele nada parado ali para sempre. Como o
   * intento de travessia sobrevivia enquanto ele nadava, um só pedestre afogado parava a faixa
   * inteira atrás dele. Varre o grafo de passeio em largura, com orçamento curto: passado o
   * orçamento, nada na direção que já tinha (enxurrada e tsunami são finitos e a água baixa).
   */
  private dryShore(npc: NPC, map: Map): { x: number; y: number } | null {
    const start = map.nearestSidewalkNode(npc.x, npc.y);
    const first = map.sidewalkNodes[start];
    if (!first) return null;
    if (!map.isWaterWorld(first.x, first.y)) return first;
    const fila = [start];
    const visto = new Set<number>([start]);
    for (let frente = 0; frente < fila.length && visto.size <= 48; frente++) {
      for (const vizinho of map.sidewalkNeighbors[fila[frente]] ?? []) {
        if (visto.has(vizinho)) continue;
        visto.add(vizinho);
        const n = map.sidewalkNodes[vizinho];
        if (n && !map.isWaterWorld(n.x, n.y)) return n;
        fila.push(vizinho);
      }
    }
    return null;
  }

  /** Água não é calçada: o pedestre nada até a margem em vez de andar boiando. */
  private swimToShore(npc: NPC, map: Map, dt: number) {
    // Sem margem seca ao alcance: usa o node de sempre e nada às cegas, o código abaixo já
    // faz isso. Ir para `idle` aqui seria o pedestre largando a braçada enquanto ainda está
    // com a cintura na água—a animação segue a posição, não o destino.
    const shore = this.dryShore(npc, map) ?? map.sidewalkNodes[map.nearestSidewalkNode(npc.x, npc.y)];
    if (!shore) {
      this.goIdle(npc);
      return;
    }
    npc.anim = 'swim';
    npc.animTimer += dt * 1000;
    if (npc.animTimer > GAME_CONFIG.ANIM_FRAME_MS * 1.6) {
      npc.animTimer = 0;
      npc.frame = (npc.frame + 1) % 4;
    }
    // O pânico passa enquanto nadam; senão ficam para sempre travados na margem.
    if (npc.state === 'fleeing') {
      npc.fleeTimer -= dt;
      if (npc.fleeTimer <= 0) npc.state = 'idle';
    }
    const dx = shore.x - npc.x;
    const dy = shore.y - npc.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 0.02 && !map.isWaterWorld(shore.x, shore.y)) {
      // Passo final no passeio: sem o snap o pedestre nadaria parado a um pixel da margem.
      npc.x = shore.x;
      npc.y = shore.y;
      this.goIdle(npc);
      return;
    }
    // O node de passeio mais próximo pode estar alagado ele mesmo (tsunami, enxurrada), e
    // aí dist é 0: dividir por ele espalha NaN pela posição do pedestre, e um único NaN
    // derruba o update de todos os NPCs para sempre. Sem destino, nada na direção que já
    // tinha e continua nadando até achar terra.
    const cego = dist < 1e-6;
    const ang = cego ? (npc.x + npc.y) : Math.atan2(dy, dx);
    const ux = Math.cos(ang);
    const uy = Math.sin(ang);
    npc.dir = velocityToDir(ux, uy);
    const speed = cego ? GAME_CONFIG.NPC_SWIM_SPEED : Math.min(GAME_CONFIG.NPC_SWIM_SPEED, dist / dt);
    const circle = {
      x: npc.x + ux * speed * dt,
      y: npc.y + uy * speed * dt,
      radius: GAME_CONFIG.NPC_RADIUS,
    };
    this.collision.resolveCircle(circle, map.queryNearby(circle.x, circle.y, 1.5));
    npc.x = Math.max(GAME_CONFIG.NPC_RADIUS, Math.min(map.worldW - GAME_CONFIG.NPC_RADIUS, circle.x));
    npc.y = Math.max(GAME_CONFIG.NPC_RADIUS, Math.min(map.worldH - GAME_CONFIG.NPC_RADIUS, circle.y));
    npc.speed = speed;
    npc.lastX = npc.x;
    npc.lastY = npc.y;
    // Em terra de novo: volta ao comportamento normal já no próximo tick.
    if (!map.isWaterWorld(npc.x, npc.y)) this.goIdle(npc);
  }

  private updateFlee(
    npc: NPC,
    map: Map,
    vehicles: Vehicle[],
    dt: number,
    playerX: number,
    playerY: number,
  ) {
    npc.fleeTimer -= dt;
    npc.animTimer += dt * 1000;
    if (npc.animTimer > GAME_CONFIG.ANIM_FRAME_MS * 0.7) {
      npc.animTimer = 0;
      npc.frame = (npc.frame + 1) % 4;
    }

    let dx = npc.x - playerX;
    let dy = npc.y - playerY;
    let dist = Math.hypot(dx, dy);
    if (dist < 0.05) {
      dx = 1;
      dy = 0;
      dist = 1;
    }
    const speed = GAME_CONFIG.NPC_FLEE_SPEED;
    const vx = (dx / dist) * speed;
    const vy = (dy / dist) * speed;
    const prevX = npc.x;
    const prevY = npc.y;
    npc.x += vx * dt;
    npc.y += vy * dt;

    const nearby = map.queryNearby(npc.x, npc.y, 1.5);
    const circle = { x: npc.x, y: npc.y, radius: GAME_CONFIG.NPC_RADIUS };
    this.collision.resolveCircle(circle, nearby);
    this.collision.resolveCircleVsVehicles(
      circle,
      nearbyVehicles(vehicles, npc.x, npc.y, 7.5),
      null,
      0.35,
    );
    npc.x = Math.max(GAME_CONFIG.NPC_RADIUS, Math.min(map.worldW - GAME_CONFIG.NPC_RADIUS, circle.x));
    npc.y = Math.max(GAME_CONFIG.NPC_RADIUS, Math.min(map.worldH - GAME_CONFIG.NPC_RADIUS, circle.y));
    // Fugindo em linha reta o pedestre esbarra no morro: o degrau alto é parede, e ele
    // contorna tropeçando na própria fuga em vez de atravessar a montanha.
    terrain.blockWalk(map, npc, prevX, prevY);
    npc.speed = speed;
    npc.anim = 'walk';
    npc.dir = velocityToDir(vx, vy);
    npc.lastX = npc.x;
    npc.lastY = npc.y;

    if (npc.fleeTimer <= 0) this.goIdle(npc);
  }

  private goIdle(npc: NPC) {
    crossings.delete(npc);
    npc.state = 'idle';
    npc.speed = 0;
    npc.anim = 'idle';
    npc.frame = 0;
    npc.path = [];
    npc.pathIndex = 0;
    npc.patienceTimer =
      GAME_CONFIG.NPC_PATIENCE_MS[0] +
      Math.random() * (GAME_CONFIG.NPC_PATIENCE_MS[1] - GAME_CONFIG.NPC_PATIENCE_MS[0]);
  }

  private assignNewRoute(npc: NPC, map: Map) {
    if (map.sidewalkNodes.length < 2) {
      this.goIdle(npc);
      return;
    }
    const startIdx = map.nearestSidewalkNode(npc.x, npc.y);
    let best: { x: number; y: number }[] = [];
    for (let attempt = 0; attempt < 8; attempt++) {
      const goalIdx = map.randomSidewalkNodeIndex();
      if (goalIdx === startIdx) continue;
      const goal = map.sidewalkNodes[goalIdx];
      const path = map.findSidewalkPath(npc.x, npc.y, goal.x, goal.y);
      if (path.length > best.length) best = path;
      if (path.length >= 6) break;
    }
    while (best.length > 1 && Math.hypot(best[0].x - npc.x, best[0].y - npc.y) < 0.35) {
      best.shift();
    }
    if (best.length < 2) {
      // anda até um vizinho local se BFS falhar
      const local = map.sidewalkNeighbors[startIdx];
      if (local && local.length > 0) {
        const n = map.sidewalkNodes[local[Math.floor(Math.random() * local.length)]];
        best = [n];
      } else {
        this.goIdle(npc);
        return;
      }
    }
    npc.path = best;
    npc.pathIndex = 0;
    npc.state = 'walking';
    npc.anim = 'walk';
    npc.stuckTimer = 0;
  }
}
