import { type ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { type HitId, useHitTarget } from './ControlTouch';

/** Visual de hold — o toque vem do ControlTouch. */
export function TouchHold({
  id,
  style,
  activeColor,
  idleColor = 'rgba(10,14,20,0.85)',
  children,
}: {
  id: HitId;
  style?: StyleProp<ViewStyle>;
  activeColor: string;
  idleColor?: string;
  children: ReactNode;
}) {
  const { ref, onLayout, pressed } = useHitTarget(id);

  return (
    <View
      ref={ref}
      onLayout={onLayout}
      pointerEvents="none"
      collapsable={false}
      style={[
        styles.base,
        style,
        {
          backgroundColor: pressed ? activeColor : idleColor,
          borderColor: pressed ? activeColor : 'rgba(255,255,255,0.4)',
        },
      ]}
    >
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  base: {
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
