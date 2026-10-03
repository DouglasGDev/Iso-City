import { memo } from 'react';
import { Canvas, Group, Path } from '@shopify/react-native-skia';

type IconProps = { size?: number; color?: string };

/**
 * Cada `<Canvas>` é uma superfície GPU própria, e o navegador só mantém ~16 contextos WebGL
 * vivos: passando disso ele descarta o mais antigo, que é justamente o do jogo, e a tela
 * fica branca para sempre. Por isso o nível de procurado é uma fileira só, num canvas só.
 */
const VectorIcon = memo(function VectorIcon({
  path,
  size = 32,
  color = '#fff',
  filled = false,
}: IconProps & { path: string; filled?: boolean }) {
  return (
    <Canvas style={{ width: size, height: size, pointerEvents: 'none' }}>
      <Group transform={[{ scale: size / 24 }]}>
        <Path
          path={path}
          color={color}
          style={filled ? 'fill' : 'stroke'}
          strokeWidth={1.8}
          strokeCap="round"
          strokeJoin="round"
        />
      </Group>
    </Canvas>
  );
});

const STAR_PATH = 'M12 2 L15 8 L22 9 L17 14 L18 21 L12 18 L6 21 L7 14 L2 9 L9 8 Z';

/** Fileira de estrelas do nível de procurado — um canvas para todas, não um por estrela. */
export function IconStarRow({ count, size = 12, color = '#ffd54a', gap = 1 }:
  { count: number; size?: number; color?: string; gap?: number }) {
  if (count <= 0) return null;
  const scale = size / 24;
  return (
    <Canvas
      style={{ width: count * size + (count - 1) * gap, height: size, pointerEvents: 'none' }}
      accessible
      accessibilityLabel={`Procurado: ${count} de 5`}
      testID="hud-wanted"
    >
      {Array.from({ length: count }, (_, i) => (
        <Group key={i} transform={[{ translateX: i * (size + gap) }, { scale }]}>
          <Path path={STAR_PATH} color={color} style="fill" />
        </Group>
      ))}
    </Canvas>
  );
}

export function IconTurnLeft(props: IconProps) {
  return <VectorIcon {...props} path="M15 5 L8 12 L15 19" />;
}

export function IconTurnRight(props: IconProps) {
  return <VectorIcon {...props} path="M9 5 L16 12 L9 19" />;
}

export function IconGas(props: IconProps) {
  return <VectorIcon {...props} path="M5 11 L12 4 L19 11 M12 4 V16 M6 20 H18" />;
}

export function IconBrake(props: IconProps) {
  return <VectorIcon {...props} path="M5 7 H19 V10 H5 Z M7 15 H17 V18 H7 Z" />;
}

export function IconRun(props: IconProps) {
  return <VectorIcon {...props} path="M4 5 L11 12 L4 19 M13 5 L20 12 L13 19" />;
}

export function IconCar(props: IconProps) {
  return <VectorIcon {...props} path="M4 10 L7 4 H17 L20 10 M3 10 H21 V18 H3 Z M7 10 H17 M6 14 H8 M16 14 H18 M5 18 V21 M19 18 V21" />;
}

/** Ônibus da malha: carroceria retangular, janelas e a porta do passeio. */
export function IconBus(props: IconProps) {
  return <VectorIcon {...props} path="M4 3 H20 V18 H4 Z M4 9 H20 M9 3 V9 M15 3 V9 M11 12 H15 V18 M6 18 V21 M18 18 V21" />;
}

export function IconHeli(props: IconProps) {
  return <VectorIcon {...props} path="M6 3 H21 M14 3 V7 M11 7 H16 Q21 7 21 12 V14 H9 L5 10 H2 V6 M5 10 H10 M16 7 V12 H21 M11 14 V19 M18 14 V19 M7 19 H21" />;
}

/** Buzina: alto-falante voltado para a direita, ondas sonoras saindo dele. */
export function IconHorn(props: IconProps) {
  return <VectorIcon {...props} path="M3 9 H7 L13 4 V20 L7 15 H3 Z M16 8 Q19 12 16 16 M19 5 Q23.5 12 19 19" />;
}

export function IconExit(props: IconProps) {
  return <VectorIcon {...props} path="M10 4 H4 V20 H10 M9 12 H21 M16 7 L21 12 L16 17" />;
}

export function IconSteal(props: IconProps) {
  return <VectorIcon {...props} path="M8 10 V6 C8 1 16 1 16 6 M5 10 H19 V21 H5 Z M12 14 V17" />;
}

export function IconFist(props: IconProps) {
  return <VectorIcon {...props} path="M6 12 V6 Q6 4 8 4 Q10 4 10 6 V10 V5 Q10 3 12 3 Q14 3 14 5 V10 V6 Q14 4 16 4 Q18 4 18 6 V11 V8 Q18 6 20 6 Q22 6 22 8 V14 Q22 17 18 19 V22 H9 V19 L3 13 Q1 10 3 9 Q5 8 8 13 H12" />;
}

export function IconAim(props: IconProps) {
  return <VectorIcon {...props} path="M12 4 A8 8 0 1 1 12 20 A8 8 0 1 1 12 4 M12 2 V7 M12 17 V22 M2 12 H7 M17 12 H22 M11 12 H13 M12 11 V13" />;
}

export function IconReload(props: IconProps) {
  return <VectorIcon {...props} path="M20 9 A8 8 0 0 0 6 6 L3 9 M3 4 V9 H8 M4 15 A8 8 0 0 0 18 18 L21 15 M16 15 H21 V20" />;
}

export function IconWeapon(props: IconProps) {
  return <VectorIcon {...props} path="M4 4 H19 M16 1 L19 4 L16 7 M3 9 H21 V13 H12 L10 21 H5 L7 13 H3 Z M12 13 V16 H16 V13" />;
}

export function IconMap(props: IconProps) {
  return <VectorIcon {...props} path="M3 5 L9 3 L15 6 L21 4 V19 L15 21 L9 18 L3 20 Z M9 3 V18 M15 6 V21" />;
}

export function IconPause(props: IconProps) {
  return <VectorIcon {...props} path="M6 4 H9 V20 H6 Z M15 4 H18 V20 H15 Z" filled />;
}

export function IconPlay(props: IconProps) {
  return <VectorIcon {...props} path="M7 3 L21 12 L7 21 Z" filled />;
}
