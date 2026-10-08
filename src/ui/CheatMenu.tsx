import { useState } from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { getGame } from '../game/GameState';
import { CheatSystem, type CheatRowId } from '../systems/CheatSystem';
import { useGameStore } from '../stores/useGameStore';
import { sound } from '../audio/SoundManager';
import { uiNav } from './UiNav';
import { useUiFocus, useUiInputKind, useUiPress, useUiSurface } from './useUiNav';

// Uma só folha de seleção para a sessão: fechar e reabrir o cheat lembra onde ficou cada picker.
const cheat = new CheatSystem();

const ROW_IDS = cheat.grupos.flatMap((g) => g.ids);

export function CheatMenu() {
  const open = useGameStore((s) => s.cheatOpen);
  if (!open) return null;
  return <CheatPanel />;
}

function CheatPanel() {
  const game = getGame();
  const focus = useUiFocus('cheat');
  const press = useUiPress('cheat');
  const kind = useUiInputKind();
  const [revision, setRevision] = useState(0);
  const rerender = () => setRevision((n) => n + 1);
  const close = () => useGameStore.closeCheat();

  const act = (id: CheatRowId) => {
    sound.play('uiClick', 0.6);
    cheat.run(game, id);
    rerender();
  };
  const nudge = (id: CheatRowId, dir: -1 | 1) => {
    cheat.nudge(id, dir);
    rerender();
  };

  useUiSurface('cheat', {
    items: () => [
      ...ROW_IDS.map((id) => ({ id, onSelect: () => act(id) })),
      { id: 'close', onSelect: close },
    ],
    // ◄/► giram o valor da fileira focada; ↑/↓ seguem andando pelo cardápio.
    move: ['up', 'down'],
    onAction: (action) => {
      if (action !== 'left' && action !== 'right') return;
      const focused = uiNav.focusId('cheat');
      const dir = action === 'left' ? -1 : 1;
      if ((ROW_IDS as string[]).includes(focused)) nudge(focused as CheatRowId, dir);
    },
    onBack: close,
  });

  const rowById = new Map(cheat.rows().map((row) => [row.id, row]));
  let últimoGrupo = '';

  return (
    <View style={styles.overlay} testID="cheat-menu">
      <View style={styles.panel}>
        <Text style={styles.title} testID="cheat-title">TRAPAÇAS</Text>
        <ScrollView style={styles.list} showsVerticalScrollIndicator={false}>
          {ROW_IDS.map((id) => {
            const row = rowById.get(id)!;
            const showHeader = row.group !== últimoGrupo;
            últimoGrupo = row.group;
            const focused = focus === id;
            return (
              <View key={id}>
                {showHeader && <Text style={styles.group}>{row.group}</Text>}
                <TouchableOpacity
                  testID={`cheat-row-${id}`}
                  accessibilityRole="button"
                  accessibilityState={{ selected: focused }}
                  style={[styles.row, focused && styles.rowFocus]}
                  onPressIn={() => press(id)}
                  onPress={() => act(id)}
                >
                  {row.kind === 'picker' && (
                    <TouchableOpacity
                      testID={`cheat-left-${id}`}
                      style={styles.arrow}
                      onPressIn={() => press(id)}
                      onPress={() => nudge(id, -1)}
                    >
                      <Text style={styles.arrowText}>◄</Text>
                    </TouchableOpacity>
                  )}
                  <Text style={styles.label} numberOfLines={1}>{row.label(game)}</Text>
                  {row.kind === 'picker' && (
                    <TouchableOpacity
                      testID={`cheat-right-${id}`}
                      style={styles.arrow}
                      onPressIn={() => press(id)}
                      onPress={() => nudge(id, 1)}
                    >
                      <Text style={styles.arrowText}>►</Text>
                    </TouchableOpacity>
                  )}
                </TouchableOpacity>
              </View>
            );
          })}
        </ScrollView>
        <TouchableOpacity
          style={[styles.close, focus === 'close' && styles.closeFocus]}
          onPress={close}
          onPressIn={() => press('close')}
          testID="cheat-close"
        >
          <Text style={styles.closeText}>FECHAR</Text>
        </TouchableOpacity>
        {kind !== 'touch' && (
          <Text style={styles.keys} testID="cheat-keys">
            {kind === 'gamepad' ? 'D-pad linha · ◄/► no direcional · A aplicar · B/F4 fechar'
              : '↑↓ linha · ←→ mudar valor · Enter aplicar · F4 fechar'}
          </Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(6,9,14,0.78)',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 100,
  },
  panel: {
    width: 320,
    maxHeight: '94%',
    backgroundColor: '#181c24',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
    paddingVertical: 14,
    paddingHorizontal: 16,
    gap: 8,
  },
  title: { color: '#ffe9a8', fontSize: 18, fontWeight: '800', letterSpacing: 2 },
  list: { flexGrow: 1, flexShrink: 1, minHeight: 0 },
  group: {
    color: '#7fa9d6',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1,
    marginTop: 8,
    marginBottom: 2,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0)',
  },
  rowFocus: {
    borderColor: '#ffe9a8',
    backgroundColor: 'rgba(255,233,168,0.1)',
  },
  arrow: { paddingHorizontal: 10, paddingVertical: 2 },
  arrowText: { color: '#ffd54a', fontSize: 16, fontWeight: '900' },
  label: { color: '#fff', fontSize: 14, fontWeight: '800', flex: 1, textAlign: 'center' },
  close: {
    backgroundColor: 'rgba(200,90,80,0.9)',
    borderRadius: 10,
    paddingVertical: 11,
    alignItems: 'center',
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0)',
  },
  closeFocus: { borderColor: '#ffe9a8' },
  closeText: { color: '#fff', fontSize: 14, fontWeight: '800', letterSpacing: 1 },
  keys: { color: 'rgba(255,233,168,0.75)', fontSize: 9, fontWeight: '700', textAlign: 'center' },
});
