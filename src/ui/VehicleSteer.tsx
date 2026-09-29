import { StyleSheet, Text, View } from 'react-native';
import { TouchHold } from './TouchHold';
import { useControlInsets } from './useControlInsets';
import { IconTurnLeft, IconTurnRight } from './ActionIcons';

export function VehicleSteer() {
  const insets = useControlInsets();

  return (
    <View
      style={[styles.wrap, { left: insets.left, bottom: insets.bottom }]}
      pointerEvents="none"
    >
      <View style={styles.row} pointerEvents="none">
        <TouchHold id="left" style={styles.btn} activeColor="rgba(80,150,255,0.95)">
          <IconTurnLeft />
        </TouchHold>
        <TouchHold id="right" style={styles.btn} activeColor="rgba(80,150,255,0.95)">
          <IconTurnRight />
        </TouchHold>
      </View>
      <Text style={styles.hint}>segura pra virar</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    alignItems: 'center',
    zIndex: 30,
  },
  row: {
    flexDirection: 'row',
    gap: 22,
  },
  btn: {
    width: 84,
    height: 84,
    borderRadius: 20,
  },
  hint: {
    marginTop: 6,
    color: 'rgba(255,255,255,0.45)',
    fontSize: 10,
    fontWeight: '700',
  },
});
