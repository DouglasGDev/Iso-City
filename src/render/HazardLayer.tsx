import { Group, Path, Skia, type SkPath } from '@shopify/react-native-skia';
import { useDerivedValue, type SharedValue } from 'react-native-reanimated';
import type { HazardKind } from '../systems/HazardSystem';

/** Estado por quadro, igual ao das armas: os caminhos são montados fora do React. */
export interface HazardVisualState {
  kind: HazardKind | null;
  strength: number;
  /** Giro do funil (rad) e o relógio do mundo, para a espuma não congelar. */
  spin: number;
  time: number;
  vortex: { x: number; y: number; radius: number };
  wave: { u0: number; u1: number; from: number; edge: number; dir: number; axis: 'x' | 'y' };
}

export const HAZARD_VISUAL_IDLE: HazardVisualState = {
  kind: null, strength: 0, spin: 0, time: 0,
  vortex: { x: 0, y: 0, radius: 0 }, wave: { u0: 0, u1: 0, from: 0, edge: 0, dir: 1, axis: 'y' },
};

const px = (x: number, y: number) => (x - y) * 64;
const py = (x: number, y: number) => (x + y) * 32;
const FUNNEL_HEIGHT = 250;
/** O raio do funil é o alcance do vento; a nuvem visível é bem mais estreita que ele. */
const FUNNEL_VISUAL = 0.42;

/** Largura (px) da coluna a `t` do chão: pé estreito, ombro largo. */
const funnelHalf = (r: number, t: number) => r * (0.28 + t * 0.7);
/** O eixo do funil varre em arco: sem isso a coluna parece um cilindro parado. */
const funnelSway = (r: number, spin: number, t: number) =>
  Math.sin(spin * 1.25 + t * 3.4) * r * 0.34 * t;

function funnelCentre(s: HazardVisualState, t: number) {
  const r = Math.max(0.5, s.vortex.radius) * 64 * FUNNEL_VISUAL;
  const bx = px(s.vortex.x, s.vortex.y);
  const by = py(s.vortex.x, s.vortex.y);
  const height = FUNNEL_HEIGHT * (0.55 + 0.45 * s.strength);
  return { x: bx + funnelSway(r, s.spin, t), y: by - t * height, r };
}

/** Corpo do funil: sobe pela margem esquerda e desce pela direita. */
function funnelPath(path: SkPath, s: HazardVisualState) {
  const steps = 8;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const c = funnelCentre(s, t);
    const p = { x: c.x - funnelHalf(c.r, t), y: c.y };
    if (i === 0) path.moveTo(p.x, p.y);
    else path.lineTo(p.x, p.y);
  }
  for (let i = steps; i >= 0; i--) {
    const t = i / steps;
    const c = funnelCentre(s, t);
    path.lineTo(c.x + funnelHalf(c.r, t), c.y);
  }
  path.close();
}

/** Elipse iso: um círculo de `r` tiles no chão vira 2:1 na tela. */
function isoEllipse(path: SkPath, cx: number, cy: number, rx: number) {
  path.moveTo(cx - rx, cy);
  path.conicTo(cx, cy - rx * 0.71, cx + rx, cy, 1);
  path.conicTo(cx, cy + rx * 0.71, cx - rx, cy, 1);
  path.close();
}

/** Bandas da frente da coluna: um arco que corre pela elipse em três alturas. */
function bands(path: SkPath, s: HazardVisualState) {
  for (const t of [0.18, 0.46, 0.78]) {
    const c = funnelCentre(s, t);
    const w = funnelHalf(c.r, t) * 0.62;
    // Janela de ~240° sobre a elipse: com o spin as pontes andam, e é isso que se lê como giro.
    for (let i = 0; i <= 8; i++) {
      const a = s.spin * 0.6 + (i / 8) * Math.PI * 1.35 + t * 1.7;
      const x = c.x + Math.cos(a) * w;
      const y = c.y + Math.sin(a) * w * 0.42;
      if (i === 0) path.moveTo(x, y);
      else path.lineTo(x, y);
    }
  }
}

/** Detritos orbitando a base: é o giro que se lê primeiro num tornado. */
function debris(path: SkPath, s: HazardVisualState) {
  const c = funnelCentre(s, 0);
  const foot = funnelHalf(c.r, 0);
  for (let i = 0; i < 8; i++) {
    const a = s.spin * 2.1 + i * (Math.PI / 4);
    const lift = (i % 3) * 0.5;
    path.addCircle(c.x + Math.cos(a) * foot * (1 + lift * 0.5),
      c.y + Math.sin(a) * foot * 0.5 - lift * 30 * s.strength, 2.2 + (i % 2));
  }
}

/** Ponto do corredor da onda (u = praia, a = terra adentro) no espaço do mundo. */
function wavePoint(axis: 'x' | 'y', u: number, a: number) {
  return axis === 'y' ? { x: u, y: a } : { x: a, y: u };
}

/** Área coberta pela água: do mar (atrás da origem) até a crista. */
function floodPath(path: SkPath, s: HazardVisualState) {
  const { u0, u1, from, edge, dir, axis } = s.wave;
  const back = from - dir * 9;
  const corners: [number, number][] = [[u0, back], [u1, back], [u1, edge], [u0, edge]];
  corners.forEach(([u, a], i) => {
    const p = wavePoint(axis, u, a);
    const at = { x: px(p.x, p.y), y: py(p.x, p.y) };
    if (i === 0) path.moveTo(at.x, at.y);
    else path.lineTo(at.x, at.y);
  });
  path.close();
}

/** Crista quebrando: a linha da frente de onda com um lábio de espuma acima. */
function crestPath(path: SkPath, s: HazardVisualState) {
  const { u0, u1, edge, axis } = s.wave;
  const steps = 16;
  const point = (i: number, lift: number) => {
    const u = u0 + (u1 - u0) * (i / steps);
    const a = edge + Math.sin(u * 0.8 + s.time * 2.6) * 0.35;
    const p = wavePoint(axis, u, a);
    return { x: px(p.x, p.y), y: py(p.x, p.y) - lift };
  };
  for (let i = 0; i <= steps; i++) {
    const p = point(i, 0);
    if (i === 0) path.moveTo(p.x, p.y);
    else path.lineTo(p.x, p.y);
  }
  for (let i = steps; i >= 0; i--) {
    const p = point(i, 30 * s.strength);
    path.lineTo(p.x, p.y);
  }
  path.close();
}

/** Só vale mostrar o perigo fora de casa e com força: dentro do quarto nada é desenhado. */
const shown = (s: HazardVisualState) => s.strength > 0.02;

export function HazardLayer({ state }: { state: SharedValue<HazardVisualState> }) {
  const tornado = useDerivedValue(() => (state.value.kind === 'tornado' && shown(state.value) ? 1 : 0), [state]);
  const tsunami = useDerivedValue(() => (state.value.kind === 'tsunami' && shown(state.value) ? 1 : 0), [state]);

  const funnel = useDerivedValue(() => {
    const path = Skia.Path.Make();
    if (state.value.kind === 'tornado' && shown(state.value)) funnelPath(path, state.value);
    return path;
  }, [state]);
  /** Nuvem baixa sobre o funil; para o tsunami é o espelho d'água inundando a rua. */
  const cover = useDerivedValue(() => {
    const path = Skia.Path.Make();
    const s = state.value;
    if (!shown(s)) return path;
    if (s.kind === 'tornado') {
      // A nuvem fica um pouco abaixo do topo: na altura cheia ela sai da tela e não aparece.
      const top = funnelCentre(s, 0.82);
      isoEllipse(path, top.x, top.y, funnelHalf(top.r, 1) * 1.35);
    } else if (s.kind === 'tsunami') floodPath(path, s);
    return path;
  }, [state]);
  const swirl = useDerivedValue(() => {
    const path = Skia.Path.Make();
    if (state.value.kind === 'tornado' && shown(state.value)) bands(path, state.value);
    return path;
  }, [state]);
  const trash = useDerivedValue(() => {
    const path = Skia.Path.Make();
    if (state.value.kind === 'tornado' && shown(state.value)) debris(path, state.value);
    return path;
  }, [state]);
  const foam = useDerivedValue(() => {
    const path = Skia.Path.Make();
    if (state.value.kind === 'tsunami' && shown(state.value)) crestPath(path, state.value);
    return path;
  }, [state]);

  return (
    <Group>
      <Group opacity={tsunami}>
        <Path path={cover} color="rgba(24,76,94,0.6)" />
        <Path path={foam} color="rgba(226,244,250,0.88)" />
      </Group>
      <Group opacity={tornado}>
        <Path path={cover} color="rgba(44,46,52,0.5)" />
        {/* Poeira clara: sobre o céu que o próprio tornado fecha, cinza escuro some. */}
        <Path path={funnel} color="rgba(140,126,108,0.62)" />
        <Path path={funnel} color="rgba(232,222,200,0.34)" style="stroke" strokeWidth={2} />
        <Path path={swirl} color="rgba(228,222,206,0.34)" style="stroke" strokeWidth={3} />
        <Path path={trash} color="rgba(188,166,128,0.85)" />
      </Group>
    </Group>
  );
}
