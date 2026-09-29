import { RadialGradient, Rect } from '@shopify/react-native-skia';
import { useDerivedValue, type SharedValue } from 'react-native-reanimated';
import { FOG, fogRadii, type FogSnapshot } from '../systems/FogSystem';

export function FogLayer({ width, height, camera, snapshot }: {
  width: number;
  height: number;
  camera: SharedValue<{ x: number; y: number; zoom: number }>;
  /** Publish game.fog.snapshot with the camera; no mutable system captured by a worklet. */
  snapshot?: SharedValue<FogSnapshot>;
}) {
  const transform = useDerivedValue(() => {
    const radius = fogRadii(width, height, camera.value.zoom);
    return [{ translateX: width / 2 }, { translateY: height / 2 }, { scaleX: radius.x }, { scaleY: radius.y }];
  }, [width, height, camera]);
  const colors = useDerivedValue(() => snapshot?.value.colors ?? FOG.colors, [snapshot]);
  const positions = useDerivedValue(() => snapshot?.value.positions ?? FOG.positions, [snapshot]);

  return <Rect x={0} y={0} width={width} height={height}>
    <RadialGradient c={{ x: 0, y: 0 }} r={1} colors={colors} positions={positions}
      transform={transform} mode="clamp" />
  </Rect>;
}
