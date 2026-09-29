import { memo, useEffect, useState } from 'react';
import { Circle, Group, Line, Oval, RadialGradient, Rect, RoundedRect } from '@shopify/react-native-skia';
import type { GameState } from '../game/GameState';
import { worldToScreen } from '../world/IsoUtils';
import type { JunctionAxis, TrafficLight, TrafficSignal } from '../systems/TrafficSignalSystem';
import { GAME_CONFIG } from '../game/GameConfig';

const LAMP: Record<TrafficLight, string> = {
  red: '#ff4d4d',
  yellow: '#ffc15e',
  green: '#57e08a',
};
const OFF = '#22272e';
/** Greys and yellows sampled from the pack's prop_lightpole / prop_trafficlight art. */
const POLE_LIT = '#a5b3bd';
const POLE_MID = '#7a868f';
const POLE_DARK = '#5d676f';
const EDGE = '#0d1014';
const HOUSING = '#ffcc6a';
const HOUSING_SHADE = '#d99a2b';
/** Tinta de pare do entroncamento sem sinal, no mesmo tom das faixas do asfalto. */
const STOP_BAR = '#d8d2b6';

/** Lens rows inside the housing, measured from the pole base upward. */
const LENSES: [TrafficLight, number][] = [['red', 51.5], ['yellow', 45.5], ['green', 39.5]];

/**
 * One pole + signal head, planted with its base at screen (x, y).
 * ~57px tall at zoom 1 against the 32px character: a real crossing light.
 */
const SignalHead = memo(function SignalHead({ x, y, light, walk, glow }: {
  x: number; y: number; light: TrafficLight; walk: boolean; glow: number;
}) {
  return (
    <Group>
      <Oval x={x - 7} y={y - 4} width={22} height={9} color="rgba(0,0,0,0.26)" />
      <RoundedRect x={x - 4} y={y - 6} width={8} height={6} r={1.5} color={POLE_MID} />
      <Rect x={x - 4} y={y - 6} width={8} height={1.6} color={POLE_LIT} />
      <Rect x={x - 1.8} y={y - 34} width={3.6} height={28} color={POLE_LIT} />
      <Rect x={x + 0.6} y={y - 34} width={1.2} height={28} color={POLE_MID} />
      <RoundedRect x={x - 2.6} y={y - 35.5} width={5.2} height={2.4} r={1} color={POLE_DARK} />
      <RoundedRect x={x - 6.5} y={y - 57} width={13} height={23} r={3} color={HOUSING} />
      <RoundedRect x={x + 2.4} y={y - 57} width={4.1} height={23} r={3} color={HOUSING_SHADE} />
      {LENSES.map(([kind, up]) => {
        const cy = y - up;
        const on = kind === light;
        return (
          <Group key={kind}>
            <RoundedRect x={x - 5.4} y={cy - 5} width={10.8} height={2.2} r={1} color={HOUSING_SHADE} />
            {on && glow > 0.05 && <Circle cx={x} cy={cy} r={16}>
              <RadialGradient c={{ x, y: cy }} r={16}
                colors={[`${LAMP[kind]}${Math.round(Math.min(1, glow) * 150).toString(16).padStart(2, '0')}`, `${LAMP[kind]}00`]} />
            </Circle>}
            <Circle cx={x} cy={cy} r={3.1} color={EDGE} />
            <Circle cx={x} cy={cy} r={2.5} color={on ? LAMP[kind] : OFF} />
          </Group>
        );
      })}
      <RoundedRect x={x - 6.5} y={y - 57} width={13} height={23} r={3} color={EDGE} style="stroke" strokeWidth={1} />
      {/* Pedestrian phase reads on the shaft: a green figure or an amber hand. */}
      <RoundedRect x={x - 3.4} y={y - 32} width={6.8} height={7} r={1.4} color={EDGE} />
      <Circle cx={x} cy={y - 29.6} r={1.1} color={walk ? LAMP.green : LAMP.yellow} />
      <Rect x={x - 1.1} y={y - 28.2} width={2.2} height={2.4} color={walk ? LAMP.green : LAMP.yellow} />
    </Group>
  );
});

/**
 * Barra de pare no entroncamento sem poste. A preferência de passagem existe no asfalto
 * mas não tem luz nenhuma: sem a faixa pintada, o motorista que para do nada parece um
 * bug para quem olha de fora.
 */
const YieldBar = memo(function YieldBar({ box, axis }: { box: TrafficSignal; axis: JunctionAxis }) {
  // Quem vem pelo eixo que cede a vez para na borda da caixa, de frente para o cruzamento.
  const edges = axis === 'y'
    ? [[box.minX, box.minY, box.maxX, box.minY], [box.minX, box.maxY, box.maxX, box.maxY]]
    : [[box.minX, box.minY, box.minX, box.maxY], [box.maxX, box.minY, box.maxX, box.maxY]];
  return (
    <Group>
      {edges.map(([x1, y1, x2, y2], i) => {
        const a = worldToScreen(x1, y1);
        const b = worldToScreen(x2, y2);
        return <Line key={`bar${box.id}-${i}`} p1={a} p2={b} color={STOP_BAR} strokeWidth={2.6} />;
      })}
    </Group>
  );
});

/**
 * Semáforos dos cruzamentos: um poste no meio-fio de cada eixo, com a lente do estado
 * acesa e a placa de pedestre no corpo do poste. Só desenha os sinais próximos da câmera.
 * O resto do que a simulação controla não tem ferro para desenhar: curva sem fluxo
 * cruzado e estrada de terra na reserva passam sem poste, só com a barra de pare no eixo
 * que cede a vez.
 */
export function TrafficSignalLayer({ game }: { game: GameState }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const iv = setInterval(() => setTick((t) => t + 1), GAME_CONFIG.ENTITY_CULL_MS);
    return () => clearInterval(iv);
  }, []);

  const signals = game.trafficSystem.signals;
  const view = game.fog.view(game);
  // Degraus largos: mantém o memo() das cabeças e das barras silencioso entre os ticks do culling.
  const glow = game.interiors.active ? 0 : Math.round(game.dayNight.tintAlpha * 3) / 3;

  return (
    <Group>
      {signals.map((s: TrafficSignal) => {
        if (!s.controlled) {
          if (!s.yields) return null;
          const corner = worldToScreen(s.minX, s.minY);
          const other = worldToScreen(s.maxX, s.maxY);
          const left = Math.min(corner.x, other.x) - 6, top = Math.min(corner.y, other.y) - 6;
          if (!game.fog.intersects(view, left, top, Math.abs(other.x - corner.x) + 12, Math.abs(other.y - corner.y) + 12)) return null;
          return <YieldBar key={`way${s.id}`} box={s} axis={s.yields} />;
        }
        // Cada eixo enxerga o próprio sinal do canto oposto do meio-fio.
        const xBase = worldToScreen(s.minX - 0.18, s.maxY + 0.18);
        const yBase = worldToScreen(s.maxX + 0.18, s.minY - 0.18);
        const left = Math.min(xBase.x, yBase.x) - 18;
        const right = Math.max(xBase.x, yBase.x) + 18;
        const top = Math.min(xBase.y, yBase.y) - 62;
        if (!game.fog.intersects(view, left, top, right - left, Math.max(yBase.y, xBase.y) + 10 - top)) return null;
        const walk = s.pedestrians;
        return (
          <Group key={`sig${s.id}`}>
            <SignalHead x={xBase.x} y={xBase.y} light={s.xLight} walk={walk} glow={glow} />
            <SignalHead x={yBase.x} y={yBase.y} light={s.yLight} walk={walk} glow={glow} />
          </Group>
        );
      })}
    </Group>
  );
}
