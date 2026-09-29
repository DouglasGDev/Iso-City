import { StyleSheet, Text, View } from 'react-native';
import { JOY_KNOB, JOY_SIZE, useControlTouch } from './ControlTouch';

/** Visual do joystick — o toque vem do ControlTouch (multi-dedo). */
export function VirtualJoystick() {
  const { joy } = useControlTouch();
  const { base, knob, active } = joy;

  return (
    <View
      pointerEvents="none"
      collapsable={false}
      style={[
        styles.base,
        { left: base.x, top: base.y, opacity: active ? 0.95 : 0.55 },
      ]}
    >
      <View style={styles.ring} />
      <View style={styles.crossH} />
      <View style={styles.crossV} />
      <View style={[styles.arrow, styles.arrowUp]}>
        <Text style={styles.arrowText}>▲</Text>
      </View>
      <View style={[styles.arrow, styles.arrowDown]}>
        <Text style={styles.arrowText}>▼</Text>
      </View>
      <View style={[styles.arrow, styles.arrowLeft]}>
        <Text style={styles.arrowText}>◀</Text>
      </View>
      <View style={[styles.arrow, styles.arrowRight]}>
        <Text style={styles.arrowText}>▶</Text>
      </View>
      <View style={[styles.knob, { transform: [{ translateX: knob.x }, { translateY: knob.y }] }]}>
        <View style={styles.knobInner} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  base: {
    position: 'absolute',
    width: JOY_SIZE,
    height: JOY_SIZE,
    borderRadius: JOY_SIZE / 2,
    backgroundColor: 'rgba(8,12,18,0.7)',
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.35)',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 30,
  },
  ring: {
    position: 'absolute',
    width: JOY_SIZE - 28,
    height: JOY_SIZE - 28,
    borderRadius: (JOY_SIZE - 28) / 2,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
  },
  crossH: {
    position: 'absolute',
    width: JOY_SIZE - 40,
    height: 1,
    backgroundColor: 'rgba(255,255,255,0.15)',
  },
  crossV: {
    position: 'absolute',
    width: 1,
    height: JOY_SIZE - 40,
    backgroundColor: 'rgba(255,255,255,0.15)',
  },
  arrow: {
    position: 'absolute',
  },
  arrowText: {
    color: 'rgba(255,255,255,0.5)',
    fontSize: 12,
    fontWeight: '700',
  },
  arrowUp: { top: 8 },
  arrowDown: { bottom: 8 },
  arrowLeft: { left: 10 },
  arrowRight: { right: 10 },
  knob: {
    width: JOY_KNOB,
    height: JOY_KNOB,
    borderRadius: JOY_KNOB / 2,
    backgroundColor: 'rgba(255,210,90,0.95)',
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.8)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  knobInner: {
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: 'rgba(40,28,0,0.35)',
  },
});
