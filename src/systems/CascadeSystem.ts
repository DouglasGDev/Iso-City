import { GAME_CONFIG } from '../game/GameConfig';
import type { Cascade, CityMapData } from '../data/maps/city';
import type { Player } from '../entities/Player';
import type { NPC } from '../entities/NPC';
import type { Vehicle } from '../entities/Vehicle';
import type { Animal } from '../entities/Animal';

export interface CascadeForce {
  fx: number;
  fy: number;
  /** Dentro do lençol desenhado: é a queda em pessoa, empurra com tudo e machuca. */
  core: boolean;
  /** Na correnteza, na beira espirrada ou no giro da bacia. */
  near: boolean;
}

/** O que a correnteza alcança: corpos do mundo, sem conhecer o GameState. */
export interface CascadeSweepContext {
  time: number;
  indoors: boolean;
  player: Player;
  npcs: NPC[];
  vehicles: Vehicle[];
  animals: Animal[];
  health: { damage(player: Player, amount: number, time: number): boolean };
  /** Reposiciona um corpo arrastado sem atravessar prédio, cerca ou móvel. */
  clamp(body: { x: number; y: number; radius: number }): void;
  shake(amount: number): void;
}

/**
 * Eixo da queda em espaço de mundo. As amostras vêm do gerador já reamostradas a
 * `CASCATA_PASSO` tiles, então o comprimento acumulado é o suficiente para saber onde um
 * ponto cai ao longo da queda — e é a posição ao longo dela que manda na força: a água
 * acelera conforme desce, igual ao lençol desenhado.
 */
interface Corredor {
  id: number;
  xs: number[];
  ys: number[];
  cum: number[];
  /**
   * Tangente de cada amostra, medida sobre duas amostras de cada lado. O eixo é uma escada
   * de meio tile: o segmento puro de 0,3 troca de diagonal a cada passo, e empurrar pelo
   * segmento faria a correnteza bater para um lado e para o outro em vez de descer. O
   * lençol desenhado já é liso — a força tem de seguir o mesmo caminho médio.
   */
  txs: number[];
  tys: number[];
  total: number;
  largura: number;
  porte: number;
  pe: { x: number; y: number };
  bacia: { x: number; y: number; raio: number };
  /** Caixa de rejeição: poucas comparções para a maioria esmagadora das entidades. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

function montar(c: Cascade): Corredor | null {
  const n = c.curso.length;
  if (n < 2) return null;
  const xs: number[] = [];
  const ys: number[] = [];
  const cum: number[] = [0];
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let i = 0; i < n; i++) {
    const p = c.curso[i];
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
    xs.push(p.x);
    ys.push(p.y);
    if (i) {
      const a = c.curso[i - 1];
      cum.push(cum[i - 1] + Math.hypot(p.x - a.x, p.y - a.y));
    }
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  const r = Math.max(0.4, c.largura) * GAME_CONFIG.CASCADE_MARGIN + c.bacia.raio;
  const txs: number[] = [];
  const tys: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 2);
    const b = Math.min(n - 1, i + 2);
    const dx = xs[b] - xs[a];
    const dy = ys[b] - ys[a];
    const m = Math.hypot(dx, dy) || 1;
    txs.push(dx / m);
    tys.push(dy / m);
  }
  // A bacia fica um passo além do pé da queda, e é ela que segura o corpo no fim.
  x0 -= r; y0 -= r; x1 += r; y1 += r;
  return {
    id: c.id, xs, ys, cum, txs, tys, total: cum[n - 1],
    largura: c.largura,
    // Desnível aproveitado vira porte: 1,6 tile de queda é a cachoeira cheia.
    porte: clamp01(c.queda / 1.6),
    pe: { x: xs[n - 1], y: ys[n - 1] },
    bacia: { x: c.bacia.x, y: c.bacia.y, raio: c.bacia.raio },
    x0, y0, x1, y1,
  };
}

/**
 * A cachoeira do relevo: uma correnteza que empurra quem entra no lençol e uma bacia onde
 * a água empoça. É a contrapartida física do que a CascadeLayer desenha — o mesmo eixo
 * amostrado pelo gerador, a mesma meia-largura do canal — só que aqui ela move corpo.
 * O sistema não conhece o GameState: recebe entidades e o `clamp` da colisão por contexto,
 * do mesmo jeito que o perigo severo.
 */
export class CascadeSystem {
  private readonly corredores: Corredor[] = [];

  constructor(data: CityMapData) {
    for (const c of data.cascatas ?? []) {
      const r = montar(c);
      if (r) this.corredores.push(r);
    }
  }

  get count(): number { return this.corredores.length; }

  /**
   * Meia-largura do canal em tiles, no ponto `t` da queda (0 = lábio, 1 = pé). É a fórmula
   * da folha desenhada, sem margem: dentro dela é a veia que arrasta; fora, até
   * `CASCADE_MARGIN`, é o espirro que empurra mais devagar.
   */
  private meiaLargura(c: Corredor, t: number): number {
    return Math.max(0.25, c.largura * 0.5 * (0.72 + 0.56 * t));
  }

  /** Força da correnteza num ponto do mundo; false = nenhum lençol alcança. */
  forceAt(x: number, y: number, out: CascadeForce): boolean {
    out.fx = 0;
    out.fy = 0;
    out.core = false;
    out.near = false;
    if (!this.corredores.length || !Number.isFinite(x) || !Number.isFinite(y)) return false;
    for (const c of this.corredores) {
      if (x < c.x0 || x > c.x1 || y < c.y0 || y > c.y1) continue;
      const eixo = this.eixoDe(c, x, y);
      if (!eixo) continue;
      const t = c.total > 0 ? clamp01(eixo.s / c.total) : 1;
      const half = this.meiaLargura(c, t);
      if (eixo.d <= half * GAME_CONFIG.CASCADE_MARGIN) {
        // A veia acelera até o pé; a beira espirrada só empurra de leve.
        const dentro = eixo.d <= half;
        const k = GAME_CONFIG.CASCADE_FLOW_SPEED * c.porte
          * (0.62 + 0.38 * t) * (dentro ? 1 : 0.42);
        out.fx = eixo.tx * k;
        out.fy = eixo.ty * k;
        out.core = dentro;
        out.near = true;
        return true;
      }
      // Bacia: a água que chega se espalha para fora e gira um pouco em vez de emparedar
      // o corpo na ponta. É o que faz a bacia ser um lugar para nadar, não um buraco.
      const dx = x - c.pe.x;
      const dy = y - c.pe.y;
      const d = Math.hypot(dx, dy);
      if (d > c.bacia.raio) continue;
      const ux = d > 1e-4 ? dx / d : eixo.tx;
      const uy = d > 1e-4 ? dy / d : eixo.ty;
      const fraco = 1 - d / c.bacia.raio;
      const k = GAME_CONFIG.CASCADE_POOL_SPEED * (0.4 + 0.6 * fraco);
      out.fx = (ux - uy * 0.4) * k;
      out.fy = (uy + ux * 0.4) * k;
      out.near = true;
      return true;
    }
    return false;
  }

  /**
   * O rugido ouvido num ponto do mundo, 0..1. Depende do porte da queda e cai com a
   * distância: uma cachoeira é um lugar, não uma estação de rádio do mapa inteiro.
   */
  volumeEm(x: number, y: number): number {
    if (!this.corredores.length || !Number.isFinite(x) || !Number.isFinite(y)) return 0;
    let best = 0;
    for (const c of this.corredores) {
      const eixo = this.eixoDe(c, x, y);
      const d = eixo ? eixo.d : Math.hypot(x - c.bacia.x, y - c.bacia.y) - c.bacia.raio;
      const perto = 1 - Math.max(0, d) / GAME_CONFIG.CASCADE_NOISE_TILES;
      if (perto <= 0) continue;
      // Meio alcance já é volume cheio: longe é que some, perto não compete com a chuva.
      best = Math.max(best, Math.min(1, perto * 1.9) * (0.55 + 0.45 * c.porte));
    }
    return best;
  }

  /** Arrasta e machuca o que estiver na correnteza. O veículo dirige o corpo de quem vai dentro. */
  sweep(dt: number, ctx: CascadeSweepContext) {
    if (ctx.indoors || !this.corredores.length) return;
    if (!Number.isFinite(dt) || dt <= 0) return;
    const f: CascadeForce = { fx: 0, fy: 0, core: false, near: false };

    const driven = ctx.player.currentVehicleId === null ? null
      : ctx.vehicles.find((v) => v.id === ctx.player.currentVehicleId) ?? null;
    const px = driven ? driven.x : ctx.player.x;
    const py = driven ? driven.y : ctx.player.y;
    this.forceAt(px, py, f);
    if (f.near) {
      if (f.core) {
        ctx.shake(dt * 0.9);
        if (!driven) {
          ctx.health.damage(ctx.player, GAME_CONFIG.CASCADE_PLAYER_DMG_S * dt, ctx.time);
        }
      }
      if (!driven) this.body(ctx.player, GAME_CONFIG.PLAYER_RADIUS, f, dt, 1, ctx);
    }

    for (const npc of ctx.npcs) {
      if (npc.dead || npc.inVehicle) continue;
      if (!this.forceAt(npc.x, npc.y, f)) continue;
      this.body(npc, GAME_CONFIG.NPC_RADIUS, f, dt, 1, ctx);
    }

    for (const animal of ctx.animals) {
      if (animal.dead) continue;
      if (!this.forceAt(animal.x, animal.y, f)) continue;
      this.body(animal, animal.radius, f, dt, 0.85, ctx);
    }

    for (const v of ctx.vehicles) {
      if (v.state === 'destroyed') continue;
      // No ar a queda não alcança: só o que encosta no chão é arrastado.
      if (v.altitude > 0.5) continue;
      if (!this.forceAt(v.x, v.y, f)) continue;
      this.body(v, GAME_CONFIG.VEHICLE_RADIUS, f, dt, 2.4, ctx);
      if (f.core) v.health -= GAME_CONFIG.CASCADE_VEHICLE_DMG_S * dt;
      if (v === driven) {
        ctx.player.x = v.x;
        ctx.player.y = v.y;
      }
    }
  }

  /** Ponto mais próximo do eixo: distância, avanço acumulado e tangente unitária. */
  private eixoDe(c: Corredor, x: number, y: number) {
    const n = c.xs.length;
    let bestD = Infinity;
    let bestS = 0;
    let bestTx = 1;
    let bestTy = 0;
    for (let i = 0; i + 1 < n; i++) {
      const ax = c.xs[i];
      const ay = c.ys[i];
      const bx = c.xs[i + 1] - ax;
      const by = c.ys[i + 1] - ay;
      const len2 = bx * bx + by * by;
      if (len2 < 1e-9) continue;
      const len = Math.sqrt(len2);
      const u = Math.max(0, Math.min(1, ((x - ax) * bx + (y - ay) * by) / len2));
      const dx = x - (ax + bx * u);
      const dy = y - (ay + by * u);
      const d = Math.hypot(dx, dy);
      if (d >= bestD) continue;
      bestD = d;
      bestS = c.cum[i] + len * u;
      bestTx = c.txs[i] + (c.txs[i + 1] - c.txs[i]) * u;
      bestTy = c.tys[i] + (c.tys[i + 1] - c.tys[i]) * u;
    }
    // Um ponto fora da extensão do eixo ainda tem pé: a bacia continua valendo depois dele.
    if (bestD === Infinity) return null;
    const m = Math.hypot(bestTx, bestTy) || 1;
    return { d: bestD, s: bestS, tx: bestTx / m, ty: bestTy / m };
  }

  /** Desloca o corpo pela correnteza e resolve o choque com o cenário. */
  private body(entity: { x: number; y: number }, radius: number, f: CascadeForce,
    dt: number, mass: number, ctx: CascadeSweepContext) {
    const k = dt / mass;
    const body = { x: entity.x + f.fx * k, y: entity.y + f.fy * k, radius };
    ctx.clamp(body);
    entity.x = body.x;
    entity.y = body.y;
  }
}
