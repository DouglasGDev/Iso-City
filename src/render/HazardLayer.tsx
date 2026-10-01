import { Group, Path, Skia, type SkPath } from '@shopify/react-native-skia';
import { useDerivedValue, type SharedValue } from 'react-native-reanimated';
import { GAME_CONFIG } from '../game/GameConfig';
import { worldToScreen } from '../world/IsoUtils';
import type { HazardKind } from '../systems/HazardSystem';

/** Estado por quadro, igual ao das armas: os caminhos são montados fora do React. */
export interface HazardVisualState {
  kind: HazardKind | null;
  strength: number;
  /** Giro do funil (rad) e o relógio do mundo, para a espuma não congelar. */
  spin: number;
  time: number;
  vortex: { x: number; y: number; radius: number };
  /**
   * Olho do furacão e o raio do campo de vento, exatamente como `HazardSystem` o usa para
   * empurrar. A nuvem é desenhada neste raio: o que se vê é literalmente o que puxa.
   */
  storm: { x: number; y: number; radius: number; spin: number };
  wave: { u0: number; u1: number; from: number; edge: number; dir: number; axis: 'x' | 'y' };
}

export const HAZARD_VISUAL_IDLE: HazardVisualState = {
  kind: null, strength: 0, spin: 0, time: 0,
  vortex: { x: 0, y: 0, radius: 0 },
  storm: { x: 0, y: 0, radius: 0, spin: 0 },
  wave: { u0: 0, u1: 0, from: 0, edge: 0, dir: 1, axis: 'y' },
};

// Nada deste arquivo roda no JS thread: cada caminho é montado dentro de um
// `useDerivedValue`, na UI thread. Por isso toda ajuda aqui carrega a diretiva
// `'worklet'` — sem ela o Reanimated não registra a função, e no aparelho a chamada
// vira "x is not a function" no meio de um furacão. Além disso o `path` é um objeto
// nativo do Skia criado lá: uma função do JS thread jamais poderia recebê-lo.
const px = (x: number, y: number) => {
  'worklet';
  return worldToScreen(x, y).x;
};
const py = (x: number, y: number, h = 0) => {
  'worklet';
  return worldToScreen(x, y, h).y;
};
const FUNNEL_HEIGHT = 250;
/** O raio do funil é o alcance do vento; a nuvem visível é bem mais estreita que ele. */
const FUNNEL_VISUAL = 0.42;
/**
 * Um círculo de `r` tiles no chão iso vira uma elipse de meia-largura r·64·√2 e meia-altura
 * metade disso: é a projeção de (cos, sen) em (x−y)·64, (x+y)·32. Sem esse fator o anel do
 * furacão não bateria com o raio que empurra.
 */
const RING_X = 64 * Math.SQRT2;

/** Largura (px) da coluna a `t` do chão: pé estreito, ombro largo. */
const funnelHalf = (r: number, t: number) => {
  'worklet';
  return r * (0.28 + t * 0.7);
};
/** O eixo do funil varre em arco: sem isso a coluna parece um cilindro parado. */
const funnelSway = (r: number, spin: number, t: number) => {
  'worklet';
  return Math.sin(spin * 1.25 + t * 3.4) * r * 0.34 * t;
};

function funnelCentre(s: HazardVisualState, t: number) {
  'worklet';
  const r = Math.max(0.5, s.vortex.radius) * 64 * FUNNEL_VISUAL;
  const bx = px(s.vortex.x, s.vortex.y);
  const by = py(s.vortex.x, s.vortex.y);
  const height = FUNNEL_HEIGHT * (0.55 + 0.45 * s.strength);
  return { x: bx + funnelSway(r, s.spin, t), y: by - t * height, r };
}

/** Corpo do funil: sobe pela margem esquerda e desce pela direita. */
function funnelPath(path: SkPath, s: HazardVisualState) {
  'worklet';
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
  'worklet';
  path.moveTo(cx - rx, cy);
  path.conicTo(cx, cy - rx * 0.71, cx + rx, cy, 1);
  path.conicTo(cx, cy + rx * 0.71, cx - rx, cy, 1);
  path.close();
}

const BAND_T = [0.18, 0.46, 0.78];

/** Bandas da frente da coluna: um arco que corre pela elipse em três alturas. */
function bands(path: SkPath, s: HazardVisualState) {
  'worklet';
  for (const t of BAND_T) {
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
  'worklet';
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
  'worklet';
  return axis === 'y' ? { x: u, y: a } : { x: a, y: u };
}

/** Elipse do chão iso: um círculo de `r` tiles em torno do ponto (x, y) do mundo. */
function stormRing(path: SkPath, x: number, y: number, r: number) {
  'worklet';
  const cx = px(x, y);
  const cy = py(x, y);
  const rx = Math.max(1, r) * RING_X;
  path.moveTo(cx - rx, cy);
  path.conicTo(cx, cy - rx * 0.5, cx + rx, cy, 1);
  path.conicTo(cx, cy + rx * 0.5, cx - rx, cy, 1);
  path.close();
}

/**
 * O campo inteiro de vento como mancha, com o olho recortado no meio: dois anéis no mesmo
 * caminho + `evenOdd` e o buraco vira o buraco — é ele que diz de onde a tempestade vem.
 */
function stormCover(path: SkPath, s: HazardVisualState) {
  'worklet';
  stormRing(path, s.storm.x, s.storm.y, s.storm.radius);
  stormRing(path, s.storm.x, s.storm.y, Math.min(GAME_CONFIG.HURRICANE_EYE_TILES, s.storm.radius));
}

/** Olho calmo: o céu claro dentro do recorte, onde o vento para. */
function stormEye(path: SkPath, s: HazardVisualState) {
  'worklet';
  stormRing(path, s.storm.x, s.storm.y, Math.min(GAME_CONFIG.HURRICANE_EYE_TILES, s.storm.radius));
}

/** Braços espiralados: é o giro que se lê como furacão, e ele enrola para dentro do olho. */
function stormArms(path: SkPath, s: HazardVisualState) {
  'worklet';
  const r = Math.max(1, s.storm.radius);
  // O traço é largo e tem ponta redonda, então cada extremidade sai meio traço além do
  // ponto final: o braço começa na borda do olho e termina no limite do campo de vento.
  const ponta = 0.9;
  const dentro = Math.min(0.9, (GAME_CONFIG.HURRICANE_EYE_TILES + ponta) / r);
  const fora = Math.max(dentro + 0.05, 1 - ponta / r);
  const steps = 20;
  for (let arm = 0; arm < 3; arm++) {
    for (let i = 0; i <= steps; i++) {
      // t = fração do raio; o ângulo folga com a distância, então o braço vem de fora e
      // se enrola no olho, igual à força que `windForce` aplica.
      const t = dentro + (i / steps) * (fora - dentro);
      const a = s.storm.spin * 0.8 + arm * (Math.PI * 2 / 3) + (1 - t) * 2.7;
      const d = r * t;
      const at = worldToScreen(s.storm.x + Math.cos(a) * d, s.storm.y + Math.sin(a) * d);
      if (i === 0) path.moveTo(at.x, at.y);
      else path.lineTo(at.x, at.y);
    }
  }
}

/** Área coberta pela água: do mar (atrás da origem) até a crista. */
function floodPath(path: SkPath, s: HazardVisualState) {
  'worklet';
  const { u0, u1, from, edge, dir, axis } = s.wave;
  const back = from - dir * 9;
  const corners: [number, number][] = [[u0, back], [u1, back], [u1, edge], [u0, edge]];
  corners.forEach(([u, a], i) => {
    const p = wavePoint(axis, u, a);
    const at = worldToScreen(p.x, p.y);
    if (i === 0) path.moveTo(at.x, at.y);
    else path.lineTo(at.x, at.y);
  });
  path.close();
}

/** Crista quebrando: a linha da frente de onda com um lábio de espuma acima. */
function crestPath(path: SkPath, s: HazardVisualState) {
  'worklet';
  const { u0, u1, edge, axis } = s.wave;
  const steps = 16;
  for (let i = 0; i <= steps; i++) {
    const u = u0 + (u1 - u0) * (i / steps);
    const a = edge + Math.sin(u * 0.8 + s.time * 2.6) * 0.35;
    const p = wavePoint(axis, u, a);
    const at = worldToScreen(p.x, p.y);
    if (i === 0) path.moveTo(at.x, at.y);
    else path.lineTo(at.x, at.y);
  }
  for (let i = steps; i >= 0; i--) {
    const u = u0 + (u1 - u0) * (i / steps);
    const a = edge + Math.sin(u * 0.8 + s.time * 2.6) * 0.35;
    const p = wavePoint(axis, u, a);
    const at = worldToScreen(p.x, p.y);
    path.lineTo(at.x, at.y - 30 * s.strength);
  }
  path.close();
}

/** Só vale mostrar o perigo fora de casa e com força: dentro do quarto nada é desenhado. */
const shown = (s: HazardVisualState) => {
  'worklet';
  return s.strength > 0.02;
};

export function HazardLayer({ state }: { state: SharedValue<HazardVisualState> }) {
  const tornado = useDerivedValue(() => (state.value.kind === 'tornado' && shown(state.value) ? 1 : 0), [state]);
  const tsunami = useDerivedValue(() => (state.value.kind === 'tsunami' && shown(state.value) ? 1 : 0), [state]);
  const hurricane = useDerivedValue(() => (state.value.kind === 'hurricane' && shown(state.value) ? 1 : 0), [state]);

  /** Massa de nuvem do furacão: o disco de vento, o olho calmo no meio e os braços em giro. */
  const mass = useDerivedValue(() => {
    const path = Skia.Path.Make();
    if (state.value.kind === 'hurricane' && shown(state.value)) stormCover(path, state.value);
    return path;
  }, [state]);
  const eye = useDerivedValue(() => {
    const path = Skia.Path.Make();
    if (state.value.kind === 'hurricane' && shown(state.value)) stormEye(path, state.value);
    return path;
  }, [state]);
  const spiral = useDerivedValue(() => {
    const path = Skia.Path.Make();
    if (state.value.kind === 'hurricane' && shown(state.value)) stormArms(path, state.value);
    return path;
  }, [state]);

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
      {/*
        A mancha do furacão vem antes das outras: ela é a sombra da tempestade sobre a
        cidade, não um objeto na rua. Os alpha são baixos de propósito — a tela tem de
        continuar legível para se pilotar dentro do vento.
      */}
      <Group opacity={hurricane}>
        {/*
          `evenOdd` é o que fura o olho: o disco grande e o disco do olho estão no mesmo
          caminho, então o centro fica vazio e a cidade aparece onde o vento para.
        */}
        <Path path={mass} fillType="evenOdd" color="rgba(52,60,76,0.24)" />
        {/* Braços largos: o disco tem ~1.000px de largura, e traço fino some nele.
            Junta redonda: com 20 segmentos por braço, o canto vivo da polilinha aparece. */}
        <Path path={spiral} color="rgba(206,214,226,0.2)" style="stroke" strokeWidth={150}
          strokeJoin="round" strokeCap="round" />
        <Path path={spiral} color="rgba(238,244,252,0.34)" style="stroke" strokeWidth={52}
          strokeJoin="round" strokeCap="round" />
        {/* Parede do olho: o anel claro é a fronteira entre a calmaria e o vento que arremessa. */}
        <Path path={eye} color="rgba(240,246,254,0.4)" style="stroke" strokeWidth={26} />
        <Path path={eye} color="rgba(150,168,190,0.22)" />
      </Group>
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
