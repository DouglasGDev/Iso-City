import { useMemo } from 'react';
import { Circle, Group, Image, Oval, Path, RoundedRect, Skia } from '@shopify/react-native-skia';
import { useDerivedValue, type SharedValue } from 'react-native-reanimated';
import { spriteStore } from '../assets/SpriteStore';
import { worldToScreen } from '../world/IsoUtils';
import type { Dir4 } from '../game/GameConfig';
import type { Wreck } from '../systems/DestructionSystem';

/** Bola de fogo; a fumaça continua um pouco mais que o fogo. */
export const BLAST_S = 0.9;
export const SMOLDER_S = 7;

const SMOKE_PUFFS = [0, 0.9, 1.8];

/** Ângulo iso do eixo longo do veículo (mesma convenção dos sprites do pack). */
const HULL_ANGLE: Record<Dir4, number> = {
  SE: Math.atan2(32, 64),
  SW: Math.atan2(32, -64),
  NW: -Math.atan2(32, 64),
  NE: -Math.atan2(32, -64),
};

/** Carcaça desenhada para os veículos sem arte queimada no pack (táxi, hatch, heli…). */
function CharredHull({ cx, cy, angle }: { cx: number; cy: number; angle: number }) {
  return (
    <Group transform={[{ translateX: cx }, { translateY: cy }, { rotate: angle }]}>
      <RoundedRect x={-19} y={-9} width={38} height={18} r={5} color="#241f1c" />
      <RoundedRect x={-8} y={-7} width={15} height={14} r={3} color="#15110f" />
      <RoundedRect x={-19} y={-9} width={38} height={18} r={5} color="#5a4a3c" style="stroke" strokeWidth={1.2}
        opacity={0.55} />
      <Circle cx={-11} cy={9} r={3.4} color="#0e0c0b" />
      <Circle cx={12} cy={9} r={3.4} color="#0e0c0b" />
    </Group>
  );
}

export function WreckSprite({ wreck, clock, smoking }: {
  wreck: Wreck;
  clock: SharedValue<number>;
  smoking: boolean;
}) {
  const s = worldToScreen(wreck.x, wreck.y);
  const image = wreck.key ? spriteStore[wreck.key] ?? null : null;
  const w = image ? image.width() : 0;
  const h = image ? image.height() : 0;
  const shards = useMemo(() => {
    const path = Skia.Path.Make();
    for (const shard of wreck.shards) {
      const p = worldToScreen(wreck.x + shard.dx, wreck.y + shard.dy);
      const cx = p.x - s.x, cy = p.y - s.y;
      const cos = Math.cos(shard.rot) * shard.size, sin = Math.sin(shard.rot) * shard.size;
      path.moveTo(cx - cos + sin, cy - sin - cos);
      path.lineTo(cx + cos + sin, cy + sin - cos);
      path.lineTo(cx + cos - sin, cy + sin + cos);
      path.lineTo(cx - cos - sin, cy - sin + cos);
      path.close();
    }
    return path;
  }, [wreck, s.x, s.y]);

  const age = useDerivedValue(() => clock.value - wreck.explodedAt, [clock, wreck.explodedAt]);
  const fire = useDerivedValue(() => {
    const p = Math.min(1, age.value / BLAST_S);
    return { r: 10 + 34 * Math.sqrt(p), core: 6 + 12 * p, alpha: 1 - p, ring: 10 + 52 * p };
  }, [age]);
  const smoke = useDerivedValue(() => {
    const p = Math.min(1, age.value / SMOLDER_S);
    return { rise: -18 - age.value * 9, r: 7 + 13 * p, alpha: (1 - p) * 0.5 };
  }, [age]);

  return (
    <Group>
      {/* queimado no asfalto: duas manchas irregulares, não um círculo perfeito */}
      <Oval x={s.x - 30} y={s.y - 13} width={60} height={24} color="rgba(12,10,9,0.55)" />
      <Oval x={s.x - 17} y={s.y - 19} width={41} height={26} color="rgba(26,20,14,0.42)" />
      {/* estilhaços: escuros sobre o passeio, com a borda clara para aparecer no asfalto */}
      <Group transform={[{ translateX: s.x }, { translateY: s.y }]}>
        <Path path={shards} color="#201d1a" opacity={0.95} />
        <Path path={shards} color="#a89e8f" style="stroke" strokeWidth={1} opacity={0.7} />
      </Group>
      {image ? (
        <Group transform={[{ translateX: s.x }, { translateY: s.y }, { rotate: wreck.tilt },
          { translateX: -w / 2 }, { translateY: -h }]}>
          <Image image={image} x={0} y={0} width={w} height={h} fit="fill" />
        </Group>
      ) : (
        <CharredHull cx={s.x} cy={s.y - 9} angle={HULL_ANGLE[wreck.dir] + wreck.tilt} />
      )}
      {smoking ? (
        <>
          <Circle cx={s.x} cy={s.y - 12} r={fire.value.ring} color="#ffb347" style="stroke"
            strokeWidth={3} opacity={fire.value.alpha * 0.5} />
          <Circle cx={s.x} cy={s.y - 12} r={fire.value.r} color="#ff8a2b" opacity={fire.value.alpha * 0.85} />
          <Circle cx={s.x} cy={s.y - 12} r={fire.value.core} color="#ffe9a8" opacity={fire.value.alpha} />
          {SMOKE_PUFFS.map((phase) => (
            <Circle key={phase} cx={s.x + (phase - 0.9) * 5} cy={s.y + smoke.value.rise - phase * 6}
              r={smoke.value.r + phase * 2} color="#4b4a48" opacity={smoke.value.alpha * (1 - phase * 0.25)} />
          ))}
        </>
      ) : null}
    </Group>
  );
}
