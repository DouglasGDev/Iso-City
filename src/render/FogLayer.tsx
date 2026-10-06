import { RadialGradient, Rect } from '@shopify/react-native-skia';
import { useDerivedValue, type SharedValue } from 'react-native-reanimated';
import {
  FOG, aberturaDaParede, fogRadii, nevoaCores, type FogSnapshot,
} from '../systems/FogSystem';
import type { CameraSV } from './SharedValues';

export function FogLayer({ width, height, camera, snapshot }: {
  width: number;
  height: number;
  camera: SharedValue<CameraSV>;
  /** Publish game.fog.snapshot with the camera; no mutable system captured by a worklet. */
  snapshot?: SharedValue<FogSnapshot>;
}) {
  const transform = useDerivedValue(() => {
    const radius = fogRadii(width, height, camera.value.zoom, camera.value.h);
    return [{ translateX: width / 2 }, { translateY: height / 2 }, { scaleX: radius.x }, { scaleY: radius.y }];
  }, [width, height, camera]);
  // A parede de névoa é o horizonte próximo: ela existe porque o ar do rodapé do mundo tem alcance.
  // Quem sobe acima dela não tem mais horizonte de parede — tem a moldura, e atrás dela o algodão da
  // manta, que chega até o canto do quadro. A alfa cai junto com a altura da câmera, e no chão ela
  // não cai nada: a rua continua fechada do jeito de sempre.
  const colors = useDerivedValue(() => {
    const atual = snapshot?.value ?? FOG;
    const abrir = aberturaDaParede(camera.value.h);
    return abrir <= 0 ? atual.colors : nevoaCores(atual.rgb, abrir, atual.color);
  }, [snapshot, camera]);
  const positions = useDerivedValue(() => snapshot?.value.positions ?? FOG.positions, [snapshot]);

  return <Rect x={0} y={0} width={width} height={height}>
    <RadialGradient c={{ x: 0, y: 0 }} r={1} colors={colors} positions={positions}
      transform={transform} mode="clamp" />
  </Rect>;
}
