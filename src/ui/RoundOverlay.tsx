import { StyleSheet, Text, View } from 'react-native';
import { useGameStore } from '../stores/useGameStore';
import { getGame } from '../game/GameState';
import { readableShadow } from './textShadow';

export function RoundOverlay() {
  const overlay = useGameStore((s) => s.overlay);
  if (!overlay) return null;
  const busted = overlay === 'busted';
  const jailed = busted && getGame().jail.locked;
  return (
    <View style={[styles.wrap, { pointerEvents: 'none' }]}>
      <View style={[styles.tint, busted ? styles.bustedTint : styles.wastedTint]} />
      <Text style={[styles.title, busted ? styles.bustedText : styles.wastedText]}>
        {busted ? 'PRESO' : 'WASTED'}
      </Text>
      <Text style={styles.sub}>
        {jailed ? 'Levado para a cela. Cumpra a pena ou consiga as chaves.'
          : busted ? 'A polícia te pegou. Dinheiro perdido.' : 'Você morreu. Reapareceu no hospital.'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 90,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tint: {
    ...StyleSheet.absoluteFillObject,
  },
  bustedTint: {
    backgroundColor: 'rgba(20, 40, 120, 0.45)',
  },
  wastedTint: {
    backgroundColor: 'rgba(120, 8, 8, 0.5)',
  },
  title: {
    fontSize: 64,
    fontWeight: '900',
    letterSpacing: 10,
    color: '#fff',
    ...readableShadow('rgba(0,0,0,0.9)', 0, 3, 12),
  },
  bustedText: {
    color: '#8ab4ff',
  },
  wastedText: {
    color: '#ff5252',
  },
  sub: {
    marginTop: 6,
    color: 'rgba(255,255,255,0.85)',
    fontSize: 13,
    fontWeight: '700',
    ...readableShadow('rgba(0,0,0,0.8)', 0, 1, 3),
  },
});
