import { StyleSheet, Text, TouchableOpacity, View, type ViewStyle } from 'react-native';
import { useEffect, useRef, useState } from 'react';
import { sound } from '../audio/SoundManager';
import { useUiFocus, useUiInputKind, useUiPress, useUiSurface } from './useUiNav';

export function PauseMenu({
  visible,
  onResume,
  onSave,
  onMap,
  onMainMenu,
  onQuit,
}: {
  visible: boolean;
  onResume: () => void;
  onSave: () => void;
  onMap: () => void;
  onMainMenu: () => void;
  onQuit: () => void;
}) {
  // Painel em cartão próprio: a tela só existe no navegador de menus enquanto estiver aberta.
  if (!visible) return null;
  return (
    <PausePanel
      onResume={onResume}
      onSave={onSave}
      onMap={onMap}
      onMainMenu={onMainMenu}
      onQuit={onQuit}
    />
  );
}

function PausePanel({
  onResume,
  onSave,
  onMap,
  onMainMenu,
  onQuit,
}: {
  onResume: () => void;
  onSave: () => void;
  onMap: () => void;
  onMainMenu: () => void;
  onQuit: () => void;
}) {
  const focus = useUiFocus('pause');
  const press = useUiPress('pause');
  const kind = useUiInputKind();
  const [saved, setSaved] = useState(false);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (savedTimer.current) clearTimeout(savedTimer.current); }, []);
  const rows: { id: string; label: string; style?: ViewStyle; action: () => void }[] = [
    { id: 'resume', label: 'CONTINUAR', action: onResume },
    {
      id: 'save',
      label: 'SALVAR JOGO',
      style: styles.btnSave,
      action: () => {
        onSave();
        setSaved(true);
        if (savedTimer.current) clearTimeout(savedTimer.current);
        savedTimer.current = setTimeout(() => setSaved(false), 1600);
      },
    },
    { id: 'map', label: 'ABRIR MAPA', style: styles.btnMap, action: onMap },
    { id: 'menu', label: 'MENU PRINCIPAL', style: styles.btnMuted, action: onMainMenu },
    { id: 'quit', label: 'SAIR DO JOGO', style: styles.btnDanger, action: onQuit },
  ];
  const act = (row: (typeof rows)[number]) => {
    sound.play('uiClick', 0.6);
    row.action();
  };
  useUiSurface('pause', {
    items: () => rows.map((row) => ({ id: row.id, onSelect: () => act(row) })),
    // B/Backspace voltar é retomar o jogo, não fechar o menu para o nada.
    onBack: onResume,
  });
  return (
    <View style={styles.overlay} testID="pause-menu">
      <View style={styles.panel}>
        <Text style={styles.title}>PAUSADO</Text>
        {rows.map((row) => (
          <TouchableOpacity
            key={row.id}
            testID={`pause-${row.id}`}
            accessibilityRole="button"
            accessibilityState={{ selected: focus === row.id }}
            style={[styles.btn, row.style, focus === row.id && styles.btnFocus]}
            onPressIn={() => press(row.id)}
            onPress={() => act(row)}
          >
            <Text style={styles.btnText}>{row.label}</Text>
            {focus === row.id && <View style={styles.caret} />}
          </TouchableOpacity>
        ))}
        <Text style={styles.saved} testID="pause-saved-note">{saved ? 'JOGO SALVO ✓' : ' '}</Text>
        {kind !== 'touch' && (
          <Text style={styles.keys} testID="pause-keys">
            {kind === 'gamepad' ? 'D-pad escolher · A confirmar · B voltar ao jogo'
              : '↑↓ escolher · Enter confirmar · Esc voltar ao jogo'}
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
    backgroundColor: 'rgba(0,0,0,0.75)',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 100,
  },
  panel: {
    width: 280,
    backgroundColor: '#181c24',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
    padding: 24,
    alignItems: 'center',
    gap: 12,
  },
  title: {
    color: '#fff',
    fontSize: 22,
    fontWeight: '800',
    letterSpacing: 2,
    marginBottom: 8,
  },
  btn: {
    width: '100%',
    backgroundColor: 'rgba(70,180,255,0.9)',
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0)',
  },
  btnMap: {
    backgroundColor: 'rgba(80,200,140,0.92)',
  },
  btnSave: {
    backgroundColor: 'rgba(255,200,90,0.95)',
  },
  btnMuted: {
    backgroundColor: 'rgba(90,100,120,0.95)',
  },
  btnDanger: {
    backgroundColor: 'rgba(255,100,90,0.9)',
  },
  // Foco de teclado/controle: contorno claro, igual ao menu inicial.
  btnFocus: {
    borderColor: '#ffe9a8',
  },
  caret: {
    pointerEvents: 'none',
    position: 'absolute',
    left: 12,
    top: 10,
    bottom: 10,
    width: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(12,18,26,0.85)',
  },
  btnText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '800',
    letterSpacing: 1,
  },
  saved: {
    color: 'rgba(120,220,150,0.95)',
    fontSize: 11,
    fontWeight: '800',
    height: 14,
    marginTop: 2,
  },
  keys: {
    color: 'rgba(255,233,168,0.8)',
    fontSize: 10,
    fontWeight: '700',
    marginTop: 2,
  },
});
