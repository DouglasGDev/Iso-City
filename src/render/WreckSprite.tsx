import { useMemo } from 'react';
import { Circle, Group, Image, Oval, Path, RoundedRect, Skia } from '@shopify/react-native-skia';
import { useDerivedValue, type SharedValue } from 'react-native-reanimated';
import { spriteStore } from '../assets/SpriteStore';
import { solicitarSprite } from '../assets/SpriteRequests';
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

/**
 * Uma baforada da coluna de fumaça. As três têm o mesmo tempo e fases diferentes, então cada uma
 * precisa do próprio número: o Skia lê o shared value a cada quadro, e uma constante multiplicada
 * fora daqui viraria leitura no render.
 */
function Puff({ cx, cy, phase, rise, raio, alpha }: {
  cx: number;
  cy: number;
  phase: number;
  rise: SharedValue<number>;
  raio: SharedValue<number>;
  alpha: SharedValue<number>;
}) {
  const y = useDerivedValue(() => cy + rise.value - phase * 6, [cy, phase, rise]);
  const r = useDerivedValue(() => raio.value + phase * 2, [phase, raio]);
  const op = useDerivedValue(() => alpha.value * (1 - phase * 0.25), [alpha, phase]);
  return <Circle cx={cx} cy={y} r={r} color="#4b4a48" opacity={op} />;
}

export function WreckSprite({ wreck, clock, smoking, h }: {
  wreck: Wreck;
  clock: SharedValue<number>;
  smoking: boolean;
  /** Cota do chão onde a carcaça esfriou: o resto do mundo já é desenhado nela. */
  h: number;
}) {
  const s = worldToScreen(wreck.x, wreck.y, h);
  const image = wreck.key ? spriteStore[wreck.key] ?? null : null;
  // A carcaça nasce de uma explosão, no meio da partida: o casco queimado dela é pedido agora.
  if (wreck.key && !image) solicitarSprite(wreck.key);
  const w = image ? image.width() : 0;
  const hh = image ? image.height() : 0;
  const shards = useMemo(() => {
    const path = Skia.Path.Make();
    for (const shard of wreck.shards) {
      const p = worldToScreen(wreck.x + shard.dx, wreck.y + shard.dy, h);
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

  // Os números da queimada são shared values entregues como props. Lê-los aqui no render congelaria
  // a bola de fogo no quadro em que o React passou por este componente — a camada de desenho do Skia
  // materializa cada shared value a todo quadro, e é por isso que o fogo cresce sozinho.
  const idade = useDerivedValue(() => clock.value - wreck.explodedAt, [clock, wreck.explodedAt]);
  const fogo = useDerivedValue(() => Math.min(1, idade.value / BLAST_S), [idade]);
  const brilho = useDerivedValue(() => 1 - fogo.value, [fogo]);
  const opHalo = useDerivedValue(() => brilho.value * 0.5, [brilho]);
  const opBola = useDerivedValue(() => brilho.value * 0.85, [brilho]);
  const raioHalo = useDerivedValue(() => 10 + 52 * fogo.value, [fogo]);
  const raioBola = useDerivedValue(() => 10 + 34 * Math.sqrt(fogo.value), [fogo]);
  const raioNucleo = useDerivedValue(() => 6 + 12 * fogo.value, [fogo]);
  const brasa = useDerivedValue(() => Math.min(1, idade.value / SMOLDER_S), [idade]);
  const ascenso = useDerivedValue(() => -18 - idade.value * 9, [idade]);
  const raioFumaca = useDerivedValue(() => 7 + 13 * brasa.value, [brasa]);
  const opFumaca = useDerivedValue(() => (1 - brasa.value) * 0.5, [brasa]);

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
          { translateX: -w / 2 }, { translateY: -hh }]}>
          <Image image={image} x={0} y={0} width={w} height={hh} fit="fill" />
        </Group>
      ) : (
        <CharredHull cx={s.x} cy={s.y - 9} angle={HULL_ANGLE[wreck.dir] + wreck.tilt} />
      )}
      {smoking ? (
        <>
          <Circle cx={s.x} cy={s.y - 12} r={raioHalo} color="#ffb347" style="stroke"
            strokeWidth={3} opacity={opHalo} />
          <Circle cx={s.x} cy={s.y - 12} r={raioBola} color="#ff8a2b" opacity={opBola} />
          <Circle cx={s.x} cy={s.y - 12} r={raioNucleo} color="#ffe9a8" opacity={brilho} />
          {SMOKE_PUFFS.map((phase) => (
            <Puff key={phase} cx={s.x + (phase - 0.9) * 5} cy={s.y} phase={phase}
              rise={ascenso} raio={raioFumaca} alpha={opFumaca} />
          ))}
        </>
      ) : null}
    </Group>
  );
}
