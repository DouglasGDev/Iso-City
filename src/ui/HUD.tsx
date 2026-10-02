import { memo, useEffect, useState, type ReactNode } from 'react';
import { Image, StyleSheet, Text, TouchableOpacity, View, useWindowDimensions } from 'react-native';
import { ASSET_FILES } from '../assets/AssetManifest';
import { getGame } from '../game/GameState';
import { useGameStore } from '../stores/useGameStore';
import { sound } from '../audio/SoundManager';
import { useControlInsets } from './useControlInsets';
import { useHitTarget } from './ControlTouch';
import { remainingRouteDistance } from '../world/Gps';
import { IconFist, IconMap, IconPause, IconPlay, IconStarRow } from './ActionIcons';
import { isGunId } from '../data/weapons';

const MISSION_LABEL: Record<string, string> = {
  giver: 'Vá até o contato', toPickup: 'Pegue a encomenda', toDeliver: 'Entregue a encomenda',
};

function readWeapon(game: ReturnType<typeof getGame>) {
  const { equipped, current, ammo, reloadLeft } = game.weapons;
  const rounds = isGunId(equipped) ? ammo[equipped] : null;
  return {
    equipped,
    label: current?.label ?? (equipped === 'bat' ? 'TACO' : 'Desarmado'),
    loaded: rounds?.loaded ?? 0,
    reserve: rounds?.reserve ?? 0,
    reloadTenths: Math.max(0, Math.ceil(reloadLeft * 10)),
    progress: current && reloadLeft > 0
      ? Math.round(Math.max(0, Math.min(1, 1 - reloadLeft / current.reloadSeconds)) * 100) : 0,
  };
}

const WeaponReadout = memo(function WeaponReadout({ compact }: { compact: boolean }) {
  const game = getGame();
  const [weapon, setWeapon] = useState(() => readWeapon(game));
  useEffect(() => {
    const iv = setInterval(() => {
      const next = readWeapon(game);
      setWeapon((prev) => JSON.stringify(prev) === JSON.stringify(next) ? prev : next);
    }, 100);
    return () => clearInterval(iv);
  }, [game]);
  const gun = isGunId(weapon.equipped);
  const reloading = weapon.reloadTenths > 0;
  return (
    <View style={[styles.panel, styles.weaponPanel, compact && styles.compactWeapon]}
      accessible accessibilityLabel={`${weapon.label}${gun ? `, ${weapon.loaded} carregadas, ${weapon.reserve} de reserva` : ''}`}
      testID="hud-weapon">
      <View style={styles.weaponHeading}>
        {weapon.equipped !== 'unarmed'
          ? <Image source={ASSET_FILES[`Weapons/${weapon.equipped}_icon.png`]} style={styles.weaponImage}
            tintColor="#b3e5fc" resizeMode="contain" />
          : <IconFist size={18} color="#b3e5fc" />}
        <Text style={styles.weaponName} numberOfLines={1} testID="hud-weapon-label">{weapon.label}</Text>
      </View>
      <Text style={[styles.weaponAmmo, gun && weapon.loaded === 0 && styles.emptyAmmo]} testID="hud-ammo">
        {gun ? `${weapon.loaded} / ${weapon.reserve}` : 'CORPO A CORPO'}
      </Text>
      {reloading && <Text style={styles.reloadText}>RECARGA {weapon.progress}%</Text>}
      <View style={[styles.reloadTrack, !reloading && styles.hiddenTrack]} testID="hud-reload-progress"
        accessibilityRole="progressbar" accessibilityLabel="Progresso da recarga"
        accessibilityValue={{ min: 0, max: 100, now: weapon.progress }}>
        <View style={[styles.reloadFill, { width: `${weapon.progress}%` }]} />
      </View>
    </View>
  );
});

function MenuButton({ id, label, onPress, children }: {
  id: 'map' | 'pause'; label: string; onPress: () => void; children: ReactNode;
}) {
  const { ref, onLayout, managed } = useHitTarget(id);
  return (
    <View ref={ref} onLayout={onLayout} collapsable={false}
      style={{ pointerEvents: managed ? 'none' : 'auto' }}>
      <TouchableOpacity style={styles.menuButton} accessibilityRole="button" accessibilityLabel={label}
        testID={`hud-${id}`} onPress={() => { onPress(); sound.play('uiSwitch', 0.4); }}>
        {children}
      </TouchableOpacity>
    </View>
  );
}

export function HUD() {
  const game = getGame();
  const insets = useControlInsets();
  const { width, height } = useWindowDimensions();
  const compact = height < 500 || width < 700;
  const narrow = width < 500;
  const [, setTick] = useState(0);
  const paused = useGameStore((s) => s.paused);
  const mapRoute = useGameStore((s) => s.mapRoute);
  const mapMarker = useGameStore((s) => s.mapMarker);
  useEffect(() => {
    const iv = setInterval(() => setTick((t) => t + 1), 200);
    return () => clearInterval(iv);
  }, []);
  const health = Math.round(game.player.health);
  const wantedLevel = Math.max(0, Math.min(5, Math.ceil(game.player.wantedLevel) || 0));
  const mission = game.missions.state;
  const gpsActive = !!mapMarker && mapRoute.length >= 2;
  const area = game.police.searchArea;
  const interior = game.interiors.active;
  const hazard = game.hazard.alert;
  let objective = interior ? interior.label : gpsActive
    ? `GPS ${remainingRouteDistance(mapRoute, game.player.x, game.player.y).toFixed(0)}m`
    : MISSION_LABEL[mission.phase] ?? '';
  // Na cela o relógio é o objetivo: diz quanto falta para a grade abrir.
  if (interior?.kind === 'jail' && game.jail.locked) objective = `CADEIA · ${Math.ceil(game.jail.sentenceLeft)}s`;
  if (wantedLevel && area) objective = area.phase === 'pursuit'
    ? wantedLevel === 1 ? 'POLÍCIA · PARE PARA SE RENDER' : 'POLÍCIA · AVISTADO'
    : 'POLÍCIA · BUSCANDO';
  if (game.witnesses.calls.some((call) => !call.radio)) objective = 'TESTEMUNHA · CHAMANDO A POLÍCIA';
  const timedMission = !gpsActive && !interior && mission.phase !== 'giver' && mission.phase !== 'break';
  return (
    <View style={[styles.container, { paddingTop: insets.top, paddingLeft: Math.max(12, insets.left), paddingRight: Math.max(12, insets.right) }]}>
      <View style={styles.topRow}>
        <View style={styles.panel} testID="hud-health">
          <View style={styles.statRow}>
            <Text style={styles.stat}>HP {health}</Text>
            <Text style={styles.money} testID="hud-cash">$ {Math.round(game.player.money)}</Text>
          </View>
          <View style={styles.hpTrack}><View style={[styles.hpFill, {
            width: `${Math.max(0, Math.min(100, health))}%`,
            backgroundColor: health > 50 ? '#69f0ae' : health > 25 ? '#ffd54a' : '#ff8a80',
          }]} /></View>
          <View style={styles.stTrack}><View style={[styles.stFill, { width: `${Math.max(0, Math.min(100, game.player.stamina * 100))}%` }]} /></View>
          {game.player.state === 'running' && <Text style={styles.sprintText}>CORRENDO</Text>}
          {game.player.crouching && <Text style={styles.sprintText}>AGACHADO</Text>}
        </View>
        {!narrow && <WeaponReadout compact={compact} />}
        <View style={styles.topRight}>
          {!narrow && <View style={styles.clockPanel}>
            <Text style={styles.clock}>{game.dayNight.clock}</Text>
            <Text style={styles.weather} numberOfLines={1}>{game.weather.label}</Text>
            <View style={styles.stars}>
              <IconStarRow count={wantedLevel} />
            </View>
          </View>}
          <MenuButton id="map" label="Abrir mapa" onPress={() => useGameStore.openMap()}><IconMap size={22} /></MenuButton>
          <MenuButton id="pause" label={paused ? 'Retomar jogo' : 'Pausar jogo'} onPress={() => useGameStore.togglePause()}>
            {paused ? <IconPlay size={22} /> : <IconPause size={22} />}
          </MenuButton>
        </View>
      </View>
      {narrow && <View style={styles.narrowWeapon}><WeaponReadout compact /></View>}
      {objective ? <View style={[styles.objectivePanel, compact && styles.compactObjective]}>
        <Text style={styles.objective} numberOfLines={1}>{objective}</Text>
        {timedMission && <View style={styles.missionRow}>
          <Text style={styles.missionText}>{Math.ceil(mission.timeLeft)}s · $ {Math.round(mission.reward)}</Text>
          <View style={styles.missionTrack} testID="hud-mission-progress"><View style={[styles.missionFill, {
            width: `${Math.max(0, Math.min(100, mission.timeLeft / Math.max(1, mission.totalTime) * 100))}%`,
          }]} /></View>
        </View>}
      </View> : null}
      {hazard ? <View style={[styles.hazardPanel, compact && styles.compactHazard]}
        testID="hud-hazard" accessible accessibilityLabel={hazard}>
        <Text style={styles.hazardText} numberOfLines={1}>{hazard}</Text>
      </View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  // `pointerEvents` vive no estilo: o RNWeb avisa que a prop do View está obsoleta, e o estilo é
  // o caminho que o próprio View nativo resolve.
  container: { position: 'absolute', top: 0, left: 0, right: 0, zIndex: 50, pointerEvents: 'box-none' },
  topRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, pointerEvents: 'box-none' },
  topRight: { flexDirection: 'row', gap: 6, alignItems: 'center', pointerEvents: 'box-none' },
  menuButton: { width: 48, height: 48, borderRadius: 14, backgroundColor: 'rgba(8,12,18,0.62)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.24)', alignItems: 'center', justifyContent: 'center' },
  panel: { backgroundColor: 'rgba(8,12,18,0.62)', borderRadius: 9, paddingVertical: 5, paddingHorizontal: 9, pointerEvents: 'none' },
  statRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  stat: { color: '#fff', fontSize: 11, fontWeight: '800' },
  money: { color: '#b9f6ca', fontSize: 11, fontWeight: '800' },
  hpTrack: { height: 4, width: 110, borderRadius: 2, backgroundColor: '#344044', marginVertical: 4, overflow: 'hidden' },
  hpFill: { height: '100%' },
  stTrack: { height: 3, width: 110, borderRadius: 2, backgroundColor: '#344044', overflow: 'hidden' },
  stFill: { height: '100%', backgroundColor: '#4dd0e1' },
  sprintText: { fontSize: 8, color: '#4dd0e1', marginTop: 3, fontWeight: '700' },
  clockPanel: { alignItems: 'flex-end', paddingHorizontal: 4, pointerEvents: 'none' },
  clock: { color: '#fff', fontSize: 12, fontWeight: '800', textShadowColor: '#000', textShadowRadius: 3 },
  weather: { color: '#cfd8dc', fontSize: 9, fontWeight: '700', marginTop: 1, textShadowColor: '#000', textShadowRadius: 3 },
  stars: { flexDirection: 'row', gap: 1, marginTop: 3 },
  weaponPanel: { width: 160 },
  compactWeapon: { width: 136 },
  narrowWeapon: { alignSelf: 'flex-end', marginTop: 8 },
  weaponHeading: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  weaponImage: { width: 28, height: 17 },
  weaponName: { flex: 1, color: '#e3f2fd', fontSize: 10, fontWeight: '800' },
  weaponAmmo: { color: '#fff', fontSize: 13, fontWeight: '800', fontVariant: ['tabular-nums'] },
  emptyAmmo: { color: '#ff8a80' },
  reloadText: { color: '#7bddff', fontSize: 9 },
  reloadTrack: { height: 2, marginTop: 2, backgroundColor: '#344044', overflow: 'hidden' },
  hiddenTrack: { opacity: 0 },
  reloadFill: { height: '100%', backgroundColor: '#7bddff' },
  objectivePanel: { marginTop: 6, alignSelf: 'center', backgroundColor: 'rgba(8,12,18,0.55)', borderRadius: 6, paddingVertical: 4, paddingHorizontal: 10, maxWidth: '55%', alignItems: 'center', pointerEvents: 'none' },
  compactObjective: { maxWidth: '46%', paddingVertical: 3 },
  objective: { color: '#ffe082', fontSize: 10, fontWeight: '700' },
  hazardPanel: { marginTop: 4, alignSelf: 'center', backgroundColor: 'rgba(96,18,14,0.78)', borderWidth: 1,
    borderColor: 'rgba(255,171,145,0.55)', borderRadius: 6, paddingVertical: 3, paddingHorizontal: 10,
    maxWidth: '55%', alignItems: 'center', pointerEvents: 'none' },
  compactHazard: { maxWidth: '46%' },
  hazardText: { color: '#ffd0c2', fontSize: 10, fontWeight: '800', letterSpacing: 0.4 },
  missionRow: { flexDirection: 'row', gap: 6, alignItems: 'center' },
  missionText: { color: '#b3e5fc', fontSize: 9 },
  missionTrack: { height: 2, width: 64, backgroundColor: '#344044', overflow: 'hidden' },
  missionFill: { height: '100%', backgroundColor: '#ffd54a' },
});
