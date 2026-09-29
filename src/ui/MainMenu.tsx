import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { sound } from '../audio/SoundManager';
import { readSummary, type SaveSummary } from '../game/SaveStorage';
import { useUiFocus, useUiInputKind, useUiPress, useUiSurface } from './useUiNav';

/** Tela de abertura. Oferece CONTINUAR só quando existe um save game gravado. */
export function MainMenu({
  onPlay,
  onContinue,
  onQuit,
}: {
  onPlay: () => void;
  onContinue: () => void;
  onQuit: () => void;
}) {
  const focus = useUiFocus('main');
  const press = useUiPress('main');
  const kind = useUiInputKind();
  const [summary, setSummary] = useState<SaveSummary | null>(null);

  useEffect(() => {
    let alive = true;
    readSummary().then((s) => { if (alive) setSummary(s); }).catch(() => { if (alive) setSummary(null); });
    return () => { alive = false; };
  }, []);

  const select = (id: string) => {
    sound.play('uiClick', 0.6);
    if (id === 'continue') onContinue();
    else if (id === 'quit') onQuit();
    else onPlay();
  };

  const rows: { id: string; label: string; style?: object }[] = summary
    ? [
      { id: 'continue', label: 'CONTINUAR', style: styles.btnResume },
      { id: 'new', label: 'NOVO JOGO' },
      { id: 'quit', label: 'SAIR DO JOGO', style: styles.btnGhost },
    ]
    : [
      { id: 'play', label: 'JOGAR' },
      { id: 'quit', label: 'SAIR DO JOGO', style: styles.btnGhost },
    ];

  useUiSurface('main', {
    items: () => rows.map((row) => ({ id: row.id, onSelect: () => select(row.id) })),
  });

  return (
    <View style={styles.root} testID="main-menu">
      <Text style={styles.title}>ISO CITY</Text>
      <Text style={styles.sub}>cidade isométrica · entre nos carros · explore</Text>
      {summary && (
        <Text style={styles.resume} testID="menu-resume-info">
          {`${Math.round(summary.exploredPercent)}% do mapa revelado · $${summary.money}`}
        </Text>
      )}
      {rows.map((row) => (
        <Pressable
          key={row.id}
          testID={`menu-${row.id}`}
          accessibilityRole="button"
          accessibilityState={{ selected: focus === row.id }}
          style={[styles.btn, row.style, focus === row.id && styles.btnFocus]}
          onPressIn={() => {
            press(row.id);
            void sound.unlock();
          }}
          onPress={() => {
            void (async () => {
              await sound.unlock();
              select(row.id);
            })();
          }}
        >
          <Text style={styles.btnText}>{row.label}</Text>
          {focus === row.id && <View style={styles.caret} pointerEvents="none" />}
        </Pressable>
      ))}
      {kind !== 'touch' && (
        <Text style={styles.keys} testID="menu-keys">
          {kind === 'gamepad' ? 'D-pad escolher · A confirmar'
            : '↑↓ escolher · Enter confirmar'}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#141820',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 14,
    zIndex: 200,
  },
  title: {
    color: '#ffe082',
    fontSize: 36,
    fontWeight: '900',
    letterSpacing: 4,
  },
  sub: {
    color: 'rgba(255,255,255,0.55)',
    fontSize: 13,
    fontWeight: '700',
  },
  resume: {
    color: 'rgba(255,224,130,0.9)',
    fontSize: 12,
    fontWeight: '800',
    marginBottom: 10,
  },
  btn: {
    width: 260,
    backgroundColor: 'rgba(70,180,255,0.95)',
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: 'center',
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0)',
  },
  btnResume: {
    backgroundColor: 'rgba(80,200,140,0.95)',
  },
  btnGhost: {
    backgroundColor: 'rgba(255,100,90,0.88)',
  },
  // Foco de teclado/controle: o mesmo realce que a loja e a pausa usam.
  btnFocus: {
    borderColor: '#ffe9a8',
  },
  caret: {
    position: 'absolute',
    left: 12,
    top: 14,
    bottom: 14,
    width: 4,
    borderRadius: 2,
    backgroundColor: '#1b2130',
  },
  btnText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '800',
    letterSpacing: 1.2,
  },
  keys: {
    color: 'rgba(255,233,168,0.85)',
    fontSize: 11,
    fontWeight: '700',
    marginTop: 6,
  },
});
