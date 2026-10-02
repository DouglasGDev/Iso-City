import { StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { setVehicleControl } from '../game/InputState';

function Pedal({
  title,
  subtitle,
  accent,
  onChange,
  wide,
}: {
  title: string;
  subtitle: string;
  accent: string;
  onChange: (pressed: boolean) => void;
  wide?: boolean;
}) {
  const scale = useSharedValue(1);
  const pressed = useSharedValue(false);

  const pan = Gesture.Pan()
    .minDistance(0)
    .onTouchesDown(() => {
      pressed.value = true;
      scale.value = withSpring(0.92, { damping: 16 });
      runOnJS(onChange)(true);
    })
    .onTouchesUp(() => {
      pressed.value = false;
      scale.value = withSpring(1, { damping: 16 });
      runOnJS(onChange)(false);
    })
    .onFinalize(() => {
      pressed.value = false;
      scale.value = withSpring(1, { damping: 16 });
      runOnJS(onChange)(false);
    });

  const anim = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
    backgroundColor: pressed.value ? accent : 'rgba(10,14,20,0.82)',
    borderColor: pressed.value ? accent : 'rgba(255,255,255,0.35)',
  }));

  return (
    <GestureDetector gesture={pan}>
      <Animated.View style={[styles.pedal, wide && styles.pedalWide, anim]}>
        <Text style={styles.pedalTitle}>{title}</Text>
        <Text style={styles.pedalSub}>{subtitle}</Text>
      </Animated.View>
    </GestureDetector>
  );
}

function SteerBtn({ label, onChange }: { label: string; onChange: (p: boolean) => void }) {
  const scale = useSharedValue(1);
  const pressed = useSharedValue(false);

  const pan = Gesture.Pan()
    .minDistance(0)
    .onTouchesDown(() => {
      pressed.value = true;
      scale.value = withSpring(0.9, { damping: 16 });
      runOnJS(onChange)(true);
    })
    .onTouchesUp(() => {
      pressed.value = false;
      scale.value = withSpring(1, { damping: 16 });
      runOnJS(onChange)(false);
    })
    .onFinalize(() => {
      pressed.value = false;
      scale.value = withSpring(1, { damping: 16 });
      runOnJS(onChange)(false);
    });

  const anim = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
    backgroundColor: pressed.value ? 'rgba(90,160,255,0.95)' : 'rgba(10,14,20,0.82)',
  }));

  return (
    <GestureDetector gesture={pan}>
      <Animated.View style={[styles.steer, anim]}>
        <Text style={styles.steerText}>{label}</Text>
      </Animated.View>
    </GestureDetector>
  );
}

/**
 * Controles estilo GTA 2D:
 * - Esquerda/direita = virar
 * - Acelerar / Freio·Ré (não “seta pra frente”)
 */
export function VehicleDpad() {
  return (
    <View style={[styles.wrap, { pointerEvents: 'box-none' }]}>
      <View style={styles.row}>
        <View style={styles.steerCol}>
          <SteerBtn label="◀" onChange={(p) => setVehicleControl('left', p)} />
          <SteerBtn label="▶" onChange={(p) => setVehicleControl('right', p)} />
        </View>
        <View style={styles.pedalCol}>
          <Pedal
            title="ACEL"
            subtitle="acelerar"
            accent="rgba(80,210,120,0.95)"
            onChange={(p) => setVehicleControl('accel', p)}
            wide
          />
          <Pedal
            title="FREIO"
            subtitle="freio / ré"
            accent="rgba(255,120,90,0.95)"
            onChange={(p) => setVehicleControl('brake', p)}
            wide
          />
        </View>
      </View>
      <Text style={styles.hint}>◀▶ vira · ACEL anda · FREIO para e depois dá ré</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: 16,
    bottom: 12,
    alignItems: 'flex-start',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'stretch',
    gap: 10,
  },
  steerCol: {
    gap: 8,
    justifyContent: 'center',
  },
  pedalCol: {
    gap: 8,
  },
  steer: {
    width: 58,
    height: 58,
    borderRadius: 16,
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.35)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  steerText: {
    color: '#fff',
    fontSize: 22,
    fontWeight: '800',
  },
  pedal: {
    minWidth: 100,
    height: 54,
    borderRadius: 14,
    borderWidth: 2,
    paddingHorizontal: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pedalWide: {
    minWidth: 118,
  },
  pedalTitle: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '900',
    letterSpacing: 1,
  },
  pedalSub: {
    color: 'rgba(255,255,255,0.75)',
    fontSize: 9,
    fontWeight: '700',
    marginTop: 1,
  },
  hint: {
    marginTop: 6,
    color: 'rgba(255,255,255,0.5)',
    fontSize: 10,
    fontWeight: '600',
  },
});
