import { StyleSheet, Text, type StyleProp, type ViewStyle } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { runOnJS, useAnimatedStyle, useSharedValue } from 'react-native-reanimated';

/**
 * Hold multi-touch (RNGH Pan). Pressable do RN core cancela o 2º dedo
 * (acel+virar / freio+virar não respondiam juntos).
 */
export function HoldPad({
  onChange,
  style,
  activeColor,
  children,
}: {
  onChange: (pressed: boolean) => void;
  style?: StyleProp<ViewStyle>;
  activeColor: string;
  children: React.ReactNode;
}) {
  const active = useSharedValue(0);

  const gesture = Gesture.Pan()
    .minDistance(0)
    .maxPointers(1)
    .onBegin(() => {
      active.value = 1;
      runOnJS(onChange)(true);
    })
    .onFinalize(() => {
      active.value = 0;
      runOnJS(onChange)(false);
    });

  const animStyle = useAnimatedStyle(() => ({
    backgroundColor: active.value ? activeColor : 'rgba(10,14,20,0.85)',
    borderColor: active.value ? activeColor : 'rgba(255,255,255,0.4)',
    transform: [{ scale: active.value ? 0.97 : 1 }],
  }));

  return (
    <GestureDetector gesture={gesture}>
      <Animated.View style={[styles.base, style, animStyle]}>{children}</Animated.View>
    </GestureDetector>
  );
}

export function HoldPadLabel({ title, sub, large }: { title: string; sub?: string; large?: boolean }) {
  return (
    <>
      <Text style={[styles.title, large && styles.titleLarge]}>{title}</Text>
      {sub ? <Text style={styles.sub}>{sub}</Text> : null}
    </>
  );
}

const styles = StyleSheet.create({
  base: {
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '900',
    letterSpacing: 1,
  },
  titleLarge: {
    fontSize: 26,
  },
  sub: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: 9,
    fontWeight: '700',
    marginTop: 2,
  },
});
