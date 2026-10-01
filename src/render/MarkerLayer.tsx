import { useEffect, useState } from 'react';
import { useDerivedValue, type SharedValue } from 'react-native-reanimated';
import { Circle, Group, Oval, Path, Rect, Skia, type SkPath } from '@shopify/react-native-skia';
import type { GameState } from '../game/GameState';
import { worldToScreen } from '../world/IsoUtils';
import { GAME_CONFIG } from '../game/GameConfig';

type CashFrame = { top: SkPath; longSide: SkPath; shortSide: SkPath; band: SkPath; edges: SkPath; ink: SkPath };
let cashGeometry: CashFrame[] | undefined;
const CASH_FRAMES = 72;

/** Original banknote bundle, orthographically projected around its vertical axis.
 * Shared immutable paths: allocation happens once, never inside a clock worklet. */
function getCashGeometry(): CashFrame[] {
  if (cashGeometry) return cashGeometry;
  cashGeometry = Array.from({ length: CASH_FRAMES }, (_, frame) => {
    const angle = frame * Math.PI * 2 / CASH_FRAMES;
    const c = Math.cos(angle), s = Math.sin(angle);
    const project = (x: number, z: number, height: number) => ({
      x: x * c - z * s, y: (x * s + z * c) * 0.5 - height,
    });
    const polygon = (path: SkPath, points: number[][]) => {
      points.forEach(([x, z, h], i) => {
        const p = project(x, z, h);
        if (i === 0) path.moveTo(p.x, p.y);
        else path.lineTo(p.x, p.y);
      });
      path.close();
    };
    const top = Skia.Path.Make(), longSide = Skia.Path.Make(), shortSide = Skia.Path.Make();
    const band = Skia.Path.Make(), edges = Skia.Path.Make(), ink = Skia.Path.Make();
    const z = c >= 0 ? 6 : -6, x = s >= 0 ? 12 : -12;
    polygon(top, [[-12, -6, 3], [12, -6, 3], [12, 6, 3], [-12, 6, 3]]);
    polygon(longSide, [[-12, z, -3], [12, z, -3], [12, z, 3], [-12, z, 3]]);
    polygon(shortSide, [[x, -6, -3], [x, 6, -3], [x, 6, 3], [x, -6, 3]]);
    for (const h of [-1.5, 0, 1.5]) {
      const a = project(-12, z, h), b = project(12, z, h);
      const d = project(x, -6, h), e = project(x, 6, h);
      edges.moveTo(a.x, a.y); edges.lineTo(b.x, b.y);
      edges.moveTo(d.x, d.y); edges.lineTo(e.x, e.y);
    }
    // Engraved frame, medallions and corner marks, not a stock currency sprite.
    polygon(ink, [[-10, -4.5, 3], [10, -4.5, 3], [10, 4.5, 3], [-10, 4.5, 3]]);
    for (const cx of [-6, 6]) {
      polygon(ink, Array.from({ length: 12 }, (_, i) => {
        const t = i * Math.PI / 6;
        return [cx + Math.cos(t) * 2.5, Math.sin(t) * 3, 3];
      }));
      for (const dz of [-3, 3]) {
        const a = project(cx - 2, dz, 3), b = project(cx + 2, dz, 3);
        ink.moveTo(a.x, a.y); ink.lineTo(b.x, b.y);
      }
    }
    // Paper strap wraps both the top and the visible long face.
    polygon(band, [[-2.5, -6, 3], [2.5, -6, 3], [2.5, 6, 3], [-2.5, 6, 3]]);
    polygon(band, [[-2.5, z, -3], [2.5, z, -3], [2.5, z, 3], [-2.5, z, 3]]);
    return { top, longSide, shortSide, band, edges, ink };
  });
  return cashGeometry;
}

function CashBundle({ x, y, clock, phase }: { x: number; y: number; clock: SharedValue<number>; phase: number }) {
  const frames = getCashGeometry();
  const frame = useDerivedValue(() => {
    const turns = clock.value * 0.22 + phase;
    return Math.floor(((turns % 1) + 1) % 1 * CASH_FRAMES);
  }, [clock, phase]);
  const transform = useDerivedValue(() => [
    { translateX: x }, { translateY: y - 12 + Math.sin(clock.value * 2.8 + phase * Math.PI * 2) * 2.5 },
  ], [x, y, clock, phase]);
  const top = useDerivedValue(() => frames[frame.value].top, [frames, frame]);
  const longSide = useDerivedValue(() => frames[frame.value].longSide, [frames, frame]);
  const shortSide = useDerivedValue(() => frames[frame.value].shortSide, [frames, frame]);
  const band = useDerivedValue(() => frames[frame.value].band, [frames, frame]);
  const edges = useDerivedValue(() => frames[frame.value].edges, [frames, frame]);
  const ink = useDerivedValue(() => frames[frame.value].ink, [frames, frame]);
  return <Group>
    <Oval x={x - 11} y={y - 3} width={22} height={6} color="rgba(10,30,18,0.25)" />
    <Group transform={transform}>
      <Path path={longSide} color="#438e57" />
      <Path path={shortSide} color="#2d6543" />
      <Path path={edges} color="#b0d291" style="stroke" strokeWidth={0.55} />
      <Path path={top} color="#91cb78" />
      <Path path={top} color="#316442" style="stroke" strokeWidth={0.7} />
      <Path path={ink} color="#36754a" style="stroke" strokeWidth={0.65} />
      <Path path={band} color="#f0ddaf" />
      <Path path={band} color="#b39a70" style="stroke" strokeWidth={0.45} />
    </Group>
  </Group>;
}

function Cross({ cx, cy }: { cx: number; cy: number }) {
  return (
    <Group>
      <Rect x={cx - 7} y={cy - 2.4} width={14} height={4.8} color="#fff" />
      <Rect x={cx - 2.4} y={cy - 7} width={4.8} height={14} color="#fff" />
    </Group>
  );
}

/**
 * Marcadores em espaço de mundo (dentro do transform da câmera, sob as entidades):
 * pickups e anel de missão pulsante. Os destroços de veículo têm profundidade
 * própria e são desenhados pelo SortedWorldLayer.
 */
export function MarkerLayer({ game, clock }: { game: GameState; clock: SharedValue<number> }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const iv = setInterval(() => setTick((t) => t + 1), GAME_CONFIG.ENTITY_CULL_MS);
    return () => clearInterval(iv);
  }, []);

  const pulse = useDerivedValue(() => 0.5 + 0.5 * Math.sin(clock.value * 4.5), [clock]);
  const ringR = useDerivedValue(() => 30 + pulse.value * 12, [pulse]);
  const ringA = useDerivedValue(() => 0.75 - pulse.value * 0.35, [pulse]);

  const view = game.fog.view(game);
  const pickups = game.pickups.items.filter((p) => p.active);
  const ms = game.missions.state;
  const missionTarget = ms.phase !== 'break' ? ms.target : null;

  return (
    <Group>
      {pickups.map((p) => {
        const s = worldToScreen(p.x, p.y, game.map.heightSmoothAt(p.x, p.y));
        if (!game.fog.intersects(view, s.x - 20, s.y - 28, 40, 40)) return null;
        if (p.kind === 'ammo') {
          return (
            <Group key={`pk${p.id}`}>
              <Circle cx={s.x} cy={s.y - 8} r={19} color="#171d28" />
              <Circle cx={s.x} cy={s.y - 8} r={19} color="#fbbf64" style="stroke" strokeWidth={2} />
              {[-7, 0, 7].map((dx) => (
                <Group key={dx}>
                  <Rect x={s.x + dx - 2} y={s.y - 14} width={4} height={14} color="#fbbf64" />
                  <Circle cx={s.x + dx} cy={s.y - 14} r={2} color="#fbbf64" />
                </Group>
              ))}
            </Group>
          );
        }
        if (p.kind === 'gun') {
          return (
            <Group key={`pk${p.id}`}>
              <Circle cx={s.x} cy={s.y - 5} r={13} color="rgba(10,14,20,0.6)" />
              <Rect x={s.x - 11} y={s.y - 12} width={22} height={16} color="#2b3340" />
              <Rect x={s.x - 11} y={s.y - 12} width={22} height={16} color="#e0574d" style="stroke" strokeWidth={2} />
              {/* pistol glyph */}
              <Rect x={s.x - 7} y={s.y - 8} width={13} height={3} color="#e8edf2" />
              <Rect x={s.x - 5} y={s.y - 5} width={4} height={6} color="#e8edf2" />
            </Group>
          );
        }
        if (p.kind === 'health') {
          return (
            <Group key={`pk${p.id}`}>
              <Circle cx={s.x} cy={s.y - 6} r={11} color="rgba(255,80,80,0.75)" />
              <Cross cx={s.x} cy={s.y - 6} />
            </Group>
          );
        }
        return <CashBundle key={`pk${p.id}`} x={s.x} y={s.y} clock={clock} phase={p.id * 0.137} />;
      })}

      {missionTarget ? (() => {
        const s = worldToScreen(missionTarget.x, missionTarget.y,
          game.map.heightSmoothAt(missionTarget.x, missionTarget.y));
        if (!game.fog.intersects(view, s.x - 44, s.y - 48, 88, 88)) return null;
        const color =
          ms.phase === 'giver' ? '#ffe082' : ms.phase === 'toPickup' ? '#ff8a50' : '#4dd0e1';
        return (
          <Group>
            <Circle
              cx={s.x}
              cy={s.y - 4}
              r={ringR}
              color={color}
              style="stroke"
              strokeWidth={4}
              opacity={ringA}
            />
            <Circle cx={s.x} cy={s.y - 4} r={7} color={color} opacity={0.85} />
          </Group>
        );
      })() : null}
    </Group>
  );
}
