import { useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { getGame } from '../game/GameState';
import { useGameStore } from '../stores/useGameStore';
import { uiNav } from './UiNav';
import { useUiFocus, useUiInputKind, useUiPress, useUiSurface } from './useUiNav';

/**
 * Telão de partidas da rodoviária. Não é um menu de teletransporte: cada linha dele é o
 * horário que já move os ônibus na rua, e escolher uma entrega um plano que o jogador cumpre
 * a pé — andar até a calçada, esperar o ônibus encostar, embarcar, descer no ponto.
 */
export function DeparturesMenu() {
  const open = useGameStore((s) => s.departuresOpen);
  const room = open ? getGame().interiors.active : null;
  // O telão só existe na sala da rodoviária: fechar a porta fecha o painel junto.
  if (!open || room?.kind !== 'terminal') return null;
  return <DeparturesPanel />;
}

function DeparturesPanel() {
  const game = getGame();
  const [revision, setRevision] = useState(0);
  const focus = useUiFocus('departures');
  const press = useUiPress('departures');
  const kind = useUiInputKind();
  const list = useRef<ScrollView>(null);
  const rowY = useRef(new Map<string, number>());
  const rowH = useRef(52);
  const viewport = useRef(0);
  const rows = game.departureRows();
  const close = () => useGameStore.closeDepartures();
  // Escolher não move ninguém: fecha o painel e devolve o jogador à porta, com o plano no GPS.
  // A linha tocada é o ônibus do plano, não o mais rápido que o horário oferece.
  const choose = (line: number, destination: number) => {
    if (game.chooseDeparture(line, destination)) return;
    setRevision((n) => n + 1);
  };
  useUiSurface('departures', {
    items: () => [
      ...rows.map((d) => ({
        id: `${d.route}:${d.destination}`,
        onSelect: () => choose(d.route, d.destination),
      })),
      { id: 'close', onSelect: close },
    ],
    onAction: (action) => {
      if (action !== 'prev' && action !== 'next') return;
      const page = Math.max(1, Math.round(viewport.current / rowH.current));
      uiNav.move('departures', action === 'prev' ? -page : page);
    },
    onBack: close,
  });
  useEffect(() => {
    const y = rowY.current.get(focus);
    if (y === undefined) return;
    list.current?.scrollTo({ y: Math.max(0, y - viewport.current / 2 + rowH.current / 2), animated: false });
  }, [focus, revision]);
  return (
    <View style={styles.overlay} testID="departures-menu">
      <View style={styles.panel}>
        <Text style={styles.title}>PARTIDAS · RODOVIÁRIA</Text>
        <Text style={styles.subtitle} testID="departures-clock">
          {`Relógio ${game.dayNight.clock} · embarque na plataforma anunciada`}
        </Text>
        <View style={styles.headRow}>
          <Text style={styles.head}>LINHA · DESTINO</Text>
          <Text style={[styles.head, styles.headTime]}>EMBARCA</Text>
          <Text style={[styles.head, styles.headTime]}>VIAGEM</Text>
        </View>
        <ScrollView
          ref={list}
          style={styles.list}
          showsVerticalScrollIndicator={false}
          onLayout={(event) => { viewport.current = event.nativeEvent.layout.height; }}
        >
          {rows.map((d) => {
            const id = `${d.route}:${d.destination}`;
            return (
              <TouchableOpacity
                key={id}
                testID={`departures-row-${id}`}
                accessibilityRole="button"
                accessibilityState={{ selected: focus === id }}
                style={[styles.row, focus === id && styles.rowFocus]}
                onPressIn={() => press(id)}
                onPress={() => choose(d.route, d.destination)}
                onLayout={(event) => {
                  rowY.current.set(id, event.nativeEvent.layout.y);
                  rowH.current = Math.max(1, event.nativeEvent.layout.height);
                }}
              >
                <View style={styles.rowText}>
                  <View style={styles.lineRow}>
                    <View style={[styles.chip, { backgroundColor: d.cor }]} />
                    <Text style={styles.itemLabel} numberOfLines={1}>{`${d.line} · ${d.code}`}</Text>
                  </View>
                  <Text style={styles.itemCompany} numberOfLines={1}
                    testID={`departures-company-${id}`}>
                    {d.company}
                  </Text>
                  <Text style={styles.itemNote} numberOfLines={1}
                    testID={`departures-bay-${id}`}>
                    {`${d.bay ? `${d.place} · ${d.bay.toUpperCase()}` : `até ${d.place}`} · FROTA ${d.fleet}`}
                  </Text>
                </View>
                <View style={styles.timeCell}>
                  <Text style={styles.time} testID={`departures-at-${id}`}>{d.at}</Text>
                  <Text style={styles.countdown} testID={`departures-wait-${id}`}>
                    {`em ${Math.ceil(d.wait)}s`}
                  </Text>
                </View>
                <Text style={[styles.time, styles.timeRide]} testID={`departures-ride-${id}`}>
                  {formatLength(d.ride)}
                </Text>
              </TouchableOpacity>
            );
          })}
          {!rows.length && <Text style={styles.empty}>Nenhum ônibus parte desta calçada.</Text>}
        </ScrollView>
        <Text style={styles.message} testID="departures-message">{game.interiors.message || ' '}</Text>
        <TouchableOpacity
          style={[styles.close, focus === 'close' && styles.closeFocus]}
          onPress={close}
          onPressIn={() => press('close')}
          testID="departures-close"
        >
          <Text style={styles.closeText}>SAIR DO TELÃO</Text>
        </TouchableOpacity>
        {kind !== 'touch' && (
          <Text style={styles.keys} testID="departures-keys">
            {kind === 'gamepad' ? 'D-pad linha · LB/RB página · A escolher · B sair'
              : '↑↓ linha · PageUp/Down página · Enter escolher · Backspace sair'}
          </Text>
        )}
      </View>
    </View>
  );
}

/** Minuto e segundo do trajeto: é o que o telão de verdade mostraria. */
function formatLength(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  return m ? `${m}min${s % 60 ? ` ${s % 60}s` : ''}` : `${s}s`;
}

const styles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(6,9,14,0.72)',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 100,
  },
  panel: {
    width: 360,
    maxHeight: '94%',
    backgroundColor: '#141a22',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
    paddingVertical: 14,
    paddingHorizontal: 16,
    gap: 6,
  },
  title: { color: '#ffe9a8', fontSize: 18, fontWeight: '800', letterSpacing: 2 },
  subtitle: { color: '#9fd6a4', fontSize: 11, fontWeight: '700', marginBottom: 2 },
  headRow: { flexDirection: 'row', gap: 10, paddingHorizontal: 6, paddingBottom: 2 },
  head: { flex: 1, color: '#7f8ea3', fontSize: 9, fontWeight: '800', letterSpacing: 1 },
  headTime: { flex: 0, width: 54, textAlign: 'right' },
  list: { flexGrow: 1, flexShrink: 1, minHeight: 0 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 6,
    paddingHorizontal: 6,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.07)',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0)',
  },
  rowFocus: {
    borderColor: '#ffe9a8',
    backgroundColor: 'rgba(255,233,168,0.1)',
  },
  rowText: { flex: 1 },
  lineRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  /** A cor da viação no painel: a mesma lataria que o passageiro vai ver parado na baia. */
  chip: { width: 9, height: 9, borderRadius: 2, borderWidth: 1, borderColor: 'rgba(0,0,0,0.45)' },
  itemLabel: { color: '#fff', fontSize: 14, fontWeight: '800' },
  itemCompany: { color: '#9fd6a4', fontSize: 10, fontWeight: '700' },
  itemNote: { color: '#96a2b3', fontSize: 11 },
  timeCell: { width: 54, alignItems: 'flex-end' },
  time: { width: 54, textAlign: 'right', color: '#ffd54a', fontSize: 14, fontWeight: '800' },
  /** A contagem regressiva é a nota da hora: o painel anuncia hora, o ponto é que tem pressa. */
  countdown: { color: '#96a2b3', fontSize: 9, fontWeight: '700' },
  timeRide: { color: '#8fd0c0' },
  empty: { color: '#96a2b3', fontSize: 12, padding: 10 },
  message: { color: '#f2c063', fontSize: 12, fontWeight: '700', minHeight: 16 },
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
