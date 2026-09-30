import type { Dir4 } from '../game/GameConfig';

export interface IsoPoint {
  x: number;
  y: number;
}

/**
 * Pixels de tela que um tile de elevação anda para cima. O losango do tile é
 * 128x64, então 64px por tile de altura é exatamente o lado vertical de um cubo
 * isométrico da mesma base: o relevo vira volume no mesmo ritmo da arte, sem
 * inventar uma terceira projeção. `h` é altura em tiles, nunca em pixels.
 */
export const ELEVATION_PX = 64;

/**
 * Projeção iso 2:1 do jogo. `h` desloca só o eixo Y de tela: o X continua
 * (x - y), ou seja, elevar o chão não gira nem inclina a câmera. É assim que o
 * relevo entra sem tirar do jogo a identidade isométrica.
 */
export function worldToScreen(x: number, y: number, h = 0): IsoPoint {
  return { x: (x - y) * 64, y: (x + y) * 32 - h * ELEVATION_PX };
}

export function screenToWorld(sx: number, sy: number): IsoPoint {
  return { x: sx / 128 + sy / 64, y: sy / 64 - sx / 128 };
}

/**
 * Chave do pintor isométrico: quem está mais para baixo na tela desenha por último.
 * Com relevo, a âncora de um tile elevado sobe `2h` na mesma contagem, então o
 * morro da frente empurra o jogador de trás para o fundo exatamente como faz na tela.
 */
export function depthOf(x: number, y: number, h = 0): number {
  return x + y - 2 * h;
}

export interface ScreenDirVec {
  sx: number;
  sy: number;
}

export const DIR_VECTORS: Record<Dir4, { wx: number; wy: number }> = {
  SE: { wx: 1, wy: 0 },
  SW: { wx: 0, wy: 1 },
  NE: { wx: 0, wy: -1 },
  NW: { wx: -1, wy: 0 },
};

export function screenDirToWorld(dir: Dir4): { wx: number; wy: number } {
  return DIR_VECTORS[dir];
}

export function velocityToDir(vx: number, vy: number): Dir4 {
  const sx = vx - vy;
  const sy = vx + vy;
  if (Math.abs(sx) < 1e-4 && Math.abs(sy) < 1e-4) return 'SE';
  if (sy >= 0) {
    return sx >= 0 ? 'SE' : 'SW';
  }
  return sx >= 0 ? 'NE' : 'NW';
}

export function dirToAngle(dir: Dir4): number {
  // Mesma convenção do movimento: SE=+X, SW=+Y, NW=-X, NE=-Y
  return { SE: 0, SW: Math.PI / 2, NW: Math.PI, NE: -Math.PI / 2 }[dir];
}

export function angleToDir(angle: number): Dir4 {
  return angleToWorldDir(angle);
}

export function screenVecToDir(sx: number, sy: number): Dir4 {
  const wx = (sx + sy) / 2;
  const wy = (sy - sx) / 2;
  return velocityToDir(wx, wy);
}

export function worldVecToAngle(wx: number, wy: number): number {
  return Math.atan2(wy, wx);
}

export function angleToWorldDir(angle: number): Dir4 {
  const a = ((angle + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
  if (a >= -Math.PI / 4 && a < Math.PI / 4) return 'SE';
  if (a >= Math.PI / 4 && a < (3 * Math.PI) / 4) return 'SW';
  if (a >= (3 * Math.PI) / 4 || a < (-3 * Math.PI) / 4) return 'NW';
  return 'NE';
}

/** Troca de sprite 4-dir com histerese leve (jogador a pé). */
export function angleToWorldDirStable(angle: number, current: Dir4): Dir4 {
  const next = angleToWorldDir(angle);
  if (next === current) return current;
  const a = ((angle + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
  const centers: Record<Dir4, number> = {
    SE: 0,
    SW: Math.PI / 2,
    NW: Math.PI,
    NE: -Math.PI / 2,
  };
  const angDiff = (x: number, y: number) => {
    let d = x - y;
    d = ((d + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
    return Math.abs(d);
  };
  // Só troca se o próximo quadrante estiver claramente mais perto
  if (angDiff(a, centers[next]) + 0.14 < angDiff(a, centers[current])) return next;
  return current;
}

export function rotateAngleToward(current: number, target: number, maxStep: number): number {
  const diff = ((target - current + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
  if (Math.abs(diff) <= maxStep) return target;
  return current + (diff > 0 ? maxStep : -maxStep);
}

const DIR_WORLD_VEC: Record<Dir4, { wx: number; wy: number }> = {
  SE: { wx: 1, wy: 0 },
  SW: { wx: 0, wy: 1 },
  NE: { wx: 0, wy: -1 },
  NW: { wx: -1, wy: 0 },
};

export function dirToWorldVec(dir: Dir4): { wx: number; wy: number } {
  return DIR_WORLD_VEC[dir];
}

/** Deslocamento tile (tx,ty) → direção iso (+X=SE, +Y=SW, …). */
export function deltaToDir(dx: number, dy: number): Dir4 {
  if (dx > 0) return 'SE';
  if (dx < 0) return 'NW';
  if (dy > 0) return 'SW';
  return 'NE';
}

