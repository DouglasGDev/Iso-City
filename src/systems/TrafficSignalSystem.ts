import type { Dir4 } from '../game/GameConfig';
import type { Map as WorldMap } from '../world/Map';

export type TrafficLight = 'red' | 'yellow' | 'green';
export type TrafficPhase = 'x-green' | 'x-yellow' | 'y-green' | 'y-yellow' | 'clearance' | 'walk';
/** Eixo da via no cruzamento: 'x' corre para SE/NW, 'y' corre para SW/NE. */
export type JunctionAxis = 'x' | 'y';

export interface TrafficSignal {
  id: number;
  /** All positions/bounds are world tiles. One record per connected junction. */
  x: number;
  y: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  phase: TrafficPhase;
  xLight: TrafficLight;
  yLight: TrafficLight;
  pedestrians: boolean;
  remaining: number;
  /** Tem poste: luz só decide alguma coisa onde dois fluxos se cruzam no asfalto. */
  controlled: boolean;
  /** Cruzamento sem sinal: o eixo marcado espera a vez do outro. Null = cada um segue. */
  yields: JunctionAxis | null;
  /** Segundos de demanda recente — quem está chegando ainda não passou por aqui. */
  demandY: number;
  walkDemand: number;
  /** Encurtamentos seguidos do ciclo; depois de dois, o ciclo inteiro roda uma vez. */
  skipped: number;
  /** Índice da fase atual em PHASES. */
  step: number;
}
const PHASES: readonly [TrafficPhase, number][] = [
  ['x-green', 8], ['x-yellow', 1.5], ['clearance', 1],
  ['y-green', 8], ['y-yellow', 1.5], ['clearance', 1],
  ['walk', 4], ['clearance', 1],
];
const CYCLE = PHASES.reduce((sum, [, seconds]) => sum + seconds, 0);
/** A aproximação varre 7 tiles de rota, a ~2,2 tiles/s: 1,5s de memória cobre o carro todo. */
const DEMAND = 1.5;
/** Ninguém fica sem passagem para sempre: dois ciclos encurtados e o terceiro é completo. */
const MAX_SKIP = 2;
/** Pedaço de asfalto que morre antes disso é beco, e semáforo de beco para motorista para ninguém. */
const MIN_ARM = 4;
/** Uma avenida por grade de 16 tiles: o índice do cruzamento é o que decide a vez em empate. */
const GRID_STEP = 16;
/** Tile keys stay numeric: string keys dominated the per-frame traffic lookups. */
const cellKey = (x: number, y: number) => (Math.floor(x) + 512) * 4096 + Math.floor(y) + 512;
const keyX = (key: number) => Math.floor(key / 4096) - 512;
const keyY = (key: number) => (key % 4096) - 512;
const axisOf = (dir: Dir4): JunctionAxis => dir === 'SE' || dir === 'NW' ? 'x' : 'y';

interface Box { minX: number; minY: number; maxX: number; maxY: number }

/** Braços reais do cruzamento: uma faixa que sai da caixa e continua por MIN_ARM tiles. */
function junctionArms(map: WorldMap, box: Box) {
  const { tilesW: W, tilesH: H, tiles } = map.data;
  const road = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < W && y < H && tiles[y * W + x].kind === 'road';
  const reach = (x0: number, y0: number, dx: number, dy: number) => {
    for (let i = 0; i < MIN_ARM; i++) {
      const x = x0 + dx * i, y = y0 + dy * i;
      // A avenida tem duas faixas lado a lado; basta uma delas estar no mapa.
      if (!(road(x, y) || (dx ? road(x, y + 1) : road(x + 1, y)))) return false;
    }
    return true;
  };
  return {
    W: reach(box.minX - 1, box.minY, -1, 0),
    E: reach(box.maxX, box.minY, 1, 0),
    N: reach(box.minX, box.minY - 1, 0, -1),
    S: reach(box.minX, box.maxY, 0, 1),
  };
}

/** Metade ou mais da caixa em estrada de terra é trilha de reserva, não avenida urbana. */
function isDirtBox(map: WorldMap, box: Box) {
  const { tilesW: W, tiles } = map.data;
  let dirt = 0, total = 0;
  for (let y = box.minY; y < box.maxY; y++) {
    for (let x = box.minX; x < box.maxX; x++) {
      total++;
      if (tiles[y * W + x].key.includes('dirt')) dirt++;
    }
  }
  return dirt * 2 >= total;
}

/**
 * No renderer, wall clock, randomness, entity or audio dependencies. Vehicles and
 * pedestrians only reach this system through the demand flags they leave behind.
 */
export class TrafficSignalSystem {
  readonly signals: TrafficSignal[] = [];
  private cells = new Map<number, TrafficSignal>();
  private world: WorldMap | null = null;

  init(map: WorldMap) {
    this.world = map;
    this.signals.length = 0;
    this.cells.clear();
    const pending = new Set<number>();
    for (const n of map.roadNodes) {
      if (map.isIntersectionAt(n.x, n.y)) pending.add(cellKey(n.x, n.y));
    }
    // Join the four tiles of a 2x2 junction rather than giving each its own clock.
    while (pending.size) {
      const first = pending.values().next().value!;
      const queue = [first];
      pending.delete(first);
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (let i = 0; i < queue.length; i++) {
        const x = keyX(queue[i]), y = keyY(queue[i]);
        minX = Math.min(minX, x); minY = Math.min(minY, y);
        maxX = Math.max(maxX, x + 1); maxY = Math.max(maxY, y + 1);
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const key = cellKey(x + dx, y + dy);
          if (pending.delete(key)) queue.push(key);
        }
      }
      const signal = this.classify(map, { minX, minY, maxX, maxY });
      signal.id = this.signals.length;
      this.signals.push(signal);
      for (const key of queue) this.cells.set(key, signal);
    }
  }

  /**
   * O que a geometria decide sobre cada caixa:
   * - luz só faz sentido onde há fluxo cruzado de verdade (três braços ou mais, um em
   *   cada eixo) sobre asfalto;
   * - curva de dois braços não tem com quem conflitar: ninguém para nela;
   * - cruzamento de terra na reserva não ganha poste nem vermelho invisível, ganha
   *   preferência de passagem para o eixo que tem continuação;
   * - de resto, cada cruzamento entra o ciclo em um ponto diferente, senão a cidade
   *   inteira troca de luz no mesmo instante.
   */
  private classify(map: WorldMap, box: Box): TrafficSignal {
    const arms = junctionArms(map, box);
    const xArms = Number(arms.W) + Number(arms.E);
    const yArms = Number(arms.N) + Number(arms.S);
    const crossing = xArms > 0 && yArms > 0 && xArms + yArms >= 3;
    const controlled = crossing && !isDirtBox(map, box);
    // Braços iguais (a malha de terra é simétrica) não têm via preferencial nenhuma: a vez
    // alterna de cruzamento em cruzamento, senão quem sobe a mata para em todos eles enquanto
    // quem atravessa de lado nunca espera.
    const even = (Math.floor(box.minX / GRID_STEP) + Math.floor(box.minY / GRID_STEP)) % 2 === 0;
    const yields: JunctionAxis | null = crossing && !controlled
      ? (xArms > yArms ? 'y' : yArms > xArms ? 'x' : even ? 'y' : 'x')
      : null;
    const signal: TrafficSignal = { id: 0, x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2,
      ...box, phase: 'x-green', xLight: 'green', yLight: 'green', pedestrians: false, remaining: 0,
      controlled, yields, demandY: 0, walkDemand: 0, skipped: 0, step: 0 };
    if (!controlled) return signal;
    let t = (((box.minX * 7 + box.minY * 11) % CYCLE) + CYCLE) % CYCLE;
    while (t >= PHASES[signal.step][1]) {
      t -= PHASES[signal.step][1];
      signal.step = (signal.step + 1) % PHASES.length;
    }
    this.apply(signal, PHASES[signal.step][1] - t);
    return signal;
  }

  private apply(signal: TrafficSignal, remaining: number) {
    const phase = PHASES[signal.step][0];
    signal.phase = phase;
    signal.remaining = remaining;
    signal.xLight = phase === 'x-green' ? 'green' : phase === 'x-yellow' ? 'yellow' : 'red';
    signal.yLight = phase === 'y-green' ? 'green' : phase === 'y-yellow' ? 'yellow' : 'red';
    signal.pedestrians = phase === 'walk';
  }

  /**
   * Fim de fase. O verde que volta é o do eixo principal enquanto ninguém mais pedir
   * nada: um cruzamento vazio não fica mostrando vermelho para quem não existe.
   */
  private advance(signal: TrafficSignal) {
    let step = (signal.step + 1) % PHASES.length;
    if (step === 0) signal.skipped = 0;
    // A travessia não tem pressa nenhuma: faixa vazia parada no vermelho é só prejuízo.
    if (signal.step === 5 && !signal.walkDemand) step = 0;
    // O eixo cruzado tem válvula de escape: depois de dois encurtamentos o ciclo inteiro
    // roda uma vez, senão um fluxo que a leitura de demanda não alcançava fica sem vez.
    else if (signal.step === 2 && !signal.demandY && signal.skipped < MAX_SKIP) step = 0;
    if (step === 0 && signal.step !== PHASES.length - 1) signal.skipped++;
    signal.step = step;
    this.apply(signal, PHASES[step][1]);
  }

  update(map: WorldMap, dt: number) {
    if (this.world !== map) this.init(map);
    if (!Number.isFinite(dt) || dt <= 0) return;
    for (const s of this.signals) {
      if (s.demandY > 0) s.demandY = Math.max(0, s.demandY - dt);
      if (s.walkDemand > 0) s.walkDemand = Math.max(0, s.walkDemand - dt);
      if (!s.controlled) continue;
      // Quantizado: duas integrações de tempo diferentes para o mesmo relógio têm que
      // trocar de fase no mesmo instante, senão o ciclo deriva.
      s.remaining = Math.round((s.remaining - dt) * 1e8) / 1e8;
      while (s.remaining <= 0) this.advance(s);
    }
  }

  /** Um motorista na aproximação do cruzamento, no seu eixo. */
  request(signal: TrafficSignal, dir: Dir4) {
    if (axisOf(dir) === 'y') signal.demandY = DEMAND;
  }

  /** Alguém parado na calçada esperando para atravessar. */
  pedestrianWaiting(signal: TrafficSignal) {
    signal.walkDemand = DEMAND;
  }

  at(x: number, y: number): TrafficSignal | null {
    return this.cells.get(cellKey(x, y)) ?? null;
  }

  /** Crosswalk/curb lookup, limited to the immediate junction neighborhood. */
  near(x: number, y: number): TrafficSignal | null {
    const direct = this.at(x, y);
    if (direct) return direct;
    let best: TrafficSignal | null = null;
    let distance = Infinity;
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const s = this.at(x + dx, y + dy);
        if (!s) continue;
        const d = Math.hypot(s.x - x, s.y - y);
        if (d < distance) { distance = d; best = s; }
      }
    }
    return best;
  }

  allows(signal: TrafficSignal, dir: Dir4): boolean {
    // Sem poste não há luz a obedecer: a vez é da preferência de passagem.
    if (!signal.controlled) return true;
    return (axisOf(dir) === 'x' ? signal.xLight : signal.yLight) === 'green';
  }

  /** O motorista está no eixo que cede a vez neste cruzamento sem sinal? */
  mustYield(signal: TrafficSignal, dir: Dir4): boolean {
    return !signal.controlled && signal.yields === axisOf(dir);
  }
}
