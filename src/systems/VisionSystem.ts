import type { Dir4 } from '../game/GameConfig';
import { dirToWorldVec, worldVecToAngle } from '../world/IsoUtils';
import type { Vehicle } from '../entities/Vehicle';
import { CoverSystem, type CoverContext } from './CoverSystem';

/**
 * Altura dos olhos de quem vê e da cabeça de quem é visto, em metros. Os valores
 * vêm da jogabilidade já calibrada da rua: um mureta de ~1,1 m precisa deixar o
 * policial manter contato visual por cima dela, mas barrar a bala.
 */
export const EYE_Z = 1.55;
export const HEAD_Z = 1.45;
export const CROUCH_HEAD_Z = 0.8;

/** Quem está em alerta varre quase meia-volta; ninguém tem atenção de 360°. */
const MAX_HALF_FOV = Math.PI * 0.78;
/** Passos e tiros chamam a atenção mesmo de costas — dentro de prédio, o som abafa. */
export const HEARING_RANGE = 7.5;

export interface Viewer {
  x: number;
  y: number;
  /** Altura do chão. Policial em telhado ou helicóptero enxerga por cima do mato. */
  z?: number;
  /** Radianos no plano do mundo. Quando existe, manda sobre o `dir` (mira dos policiais). */
  aimAngle?: number;
  dir?: Dir4;
  /** 0..1 — abre o cone: tenso, o guarda gira a cabeça quase o dobro. */
  alert?: number;
  /** 0..1 — desânio ou distração reduzem o arco e o alcance. */
  mood?: number;
}

export interface Target {
  x: number;
  y: number;
  z?: number;
  crouched?: boolean;
}

export interface VisionConfig {
  /** Alcance nominal em tiles, com luz plena e alvo de pé. */
  range: number;
  /** Meio-ângulo do cone, em radianos. */
  halfFov: number;
}

export type BlindReason = 'seen' | 'range' | 'arc' | 'blocked';

export interface Sight {
  seen: boolean;
  reason: BlindReason;
  distance: number;
  /** Desvio do eixo da visão em radianos; 0 = alvo exatamente de frente. */
  offAxis: number;
  /** Fração do trajeto livre até a primeira obstrução (1 = nada no caminho). */
  clearance: number;
  /** Ouviu o alvo sem vê-lo — motivo para olhar para lá sem abrir fogo. */
  heard: boolean;
}

export interface VisionOptions {
  /** 0..1 — luz disponível; noite e neblina encurtam o alcance. */
  light?: number;
  /** Veículo do próprio observador: o corpo do carro não pode cegar quem dirige. */
  ignoreVehicleId?: number | null;
  /**
   * Obstáculos a ignorar. Para a polícia ver alguém dentro de um carro é preciso
   * descartar o capô do alvo além do carro de quem olha — um predicado cobre os dois.
   */
  ignoreVehicle?: (vehicle: Vehicle) => boolean;
  /** Dentro de um interior o teto abafa o som; as paredes já estão nos colliders. */
  indoors?: boolean;
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/** Normaliza um ângulo para o intervalo [-PI, PI]. */
export function clampAngle(angle: number): number {
  return ((angle + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
}

/** Para onde o observador está olhando, em radianos do plano do mundo. */
export function facingAngle(viewer: Viewer): number {
  if (typeof viewer.aimAngle === 'number' && Number.isFinite(viewer.aimAngle)) return viewer.aimAngle;
  const vector = dirToWorldVec(viewer.dir ?? 'SE');
  return worldVecToAngle(vector.wx, vector.wy);
}

/** Meio-ângulo efetivo do cone. */
export function fovHalf(viewer: Viewer, cfg: VisionConfig): number {
  const attention = 0.82 + 0.55 * clamp(viewer.alert ?? 0, 0, 1);
  const mood = 0.72 + 0.28 * clamp(viewer.mood ?? 1, 0, 1);
  return Math.min(MAX_HALF_FOV, cfg.halfFov * attention * mood);
}

/** Alcance efetivo: luz disponível e a altura de quem observa (agachar não encurta o alcance). */
export function sightRange(viewer: Viewer, cfg: VisionConfig, light = 1): number {
  const highGround = clamp(((viewer.z ?? 0) - 0.4) / 6, 0, 0.3);
  return cfg.range * clamp(light, 0, 1.4) * (1 + highGround);
}

function eyeOf(viewer: Viewer) {
  return { x: viewer.x, y: viewer.y, z: (viewer.z ?? 0) + EYE_Z };
}

function crestOf(target: Target) {
  return { x: target.x, y: target.y, z: (target.z ?? 0) + (target.crouched ? CROUCH_HEAD_Z : HEAD_Z) };
}

/** Geometria do cone entre dois pontos: serve também a quem não tem dados de obstrução. */
export function coneOf(viewer: Viewer, target: Target, cfg: VisionConfig, light = 1) {
  const dx = target.x - viewer.x, dy = target.y - viewer.y;
  return {
    distance: Math.hypot(dx, dy),
    offAxis: Math.abs(clampAngle(worldVecToAngle(dx, dy) - facingAngle(viewer))),
    range: sightRange(viewer, cfg, light),
    half: fovHalf(viewer, cfg),
  };
}

/** Alcance + arco, sem teste de linha — a visão do guarda da cadeia é só isso. */
export function inCone(viewer: Viewer, target: Target, cfg: VisionConfig, light = 1): boolean {
  const cone = coneOf(viewer, target, cfg, light);
  return cone.distance <= cone.range && cone.offAxis <= cone.half;
}

/**
 * Enxerga o alvo? Primeiro o cone (ângulo + alcance), depois obstrução real por
 * caixas e veículos. Um cone largo sem teste de linha viraria simples "inimigo
 * próximo", e é justamente o muro que faz a esquina esconder alguém.
 */
export function canSee(viewer: Viewer, target: Target, ctx: CoverContext, cfg: VisionConfig, opts: VisionOptions = {}): Sight {
  const cone = coneOf(viewer, target, cfg, opts.light ?? 1);
  const base = { distance: cone.distance, offAxis: cone.offAxis, heard: false };
  const muffled = !!opts.indoors;
  const outOfSight = !muffled && cone.distance <= HEARING_RANGE;

  if (cone.distance > cone.range) return { ...base, seen: false, reason: 'range', clearance: 1, heard: outOfSight };
  if (cone.offAxis > cone.half) return { ...base, seen: false, reason: 'arc', clearance: 1, heard: outOfSight };

  const hit = CoverSystem.firstHit(eyeOf(viewer), crestOf(target), ctx, opts.ignoreVehicle ?? opts.ignoreVehicleId ?? null);
  if (hit && hit.t < 0.94) {
    return { ...base, seen: false, reason: 'blocked', clearance: clamp(1 - hit.t, 0, 1) };
  }
  return { ...base, seen: true, reason: 'seen', clearance: 1 };
}

/** Onde o olhar para: a ponta do cone, ou o primeiro obstáculo no caminho. */
export function rayEnd(viewer: Viewer, angle: number, radius: number, ctx: CoverContext, opts: VisionOptions = {}): { x: number; y: number } {
  const far = { x: viewer.x + Math.cos(angle) * radius, y: viewer.y + Math.sin(angle) * radius, z: (viewer.z ?? 0) + EYE_Z };
  const hit = CoverSystem.firstHit(eyeOf(viewer), far, ctx, opts.ignoreVehicle ?? opts.ignoreVehicleId ?? null);
  if (!hit || hit.t >= 0.999) return { x: far.x, y: far.y };
  return { x: viewer.x + (far.x - viewer.x) * hit.t, y: viewer.y + (far.y - viewer.y) * hit.t };
}

/**
 * Setor de visão já em coordenadas iso de tela, pronto para desenhar. As bordas
 * são recortadas por prédios e carros reais, então a área cega aparece como
 * sombra atrás de cada obstáculo em vez de uma fatia uniforme.
 */
export function visionWedge(
  viewer: Viewer,
  halfAngle: number,
  radius: number,
  project: (x: number, y: number) => { x: number; y: number },
  ctx: CoverContext,
  rays = 9,
  opts: VisionOptions = {},
): string {
  const axis = facingAngle(viewer);
  // Poucos rays com um arco largo desenhariam uma estrela dentro do próprio
  // observador: o espaçamento angular tem um teto, não importa o `rays`.
  const span = halfAngle * 2;
  const count = Math.min(48, Math.max(3, Math.ceil(span / Math.max(0.04, span / rays))));
  const origin = project(viewer.x, viewer.y);
  let path = `M${origin.x.toFixed(2)},${origin.y.toFixed(2)}`;
  for (let i = 0; i <= count; i++) {
    const end = rayEnd(viewer, axis - halfAngle + (span * i) / count, radius, ctx, opts);
    const point = project(end.x, end.y);
    path += ` L${point.x.toFixed(2)},${point.y.toFixed(2)}`;
  }
  return `${path} Z`;
}
