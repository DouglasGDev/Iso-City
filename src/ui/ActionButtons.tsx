import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Image, StyleSheet, Text, View, useWindowDimensions, type StyleProp, type ViewStyle } from 'react-native';
import { ASSET_FILES } from '../assets/AssetManifest';
import { getGame } from '../game/GameState';
import { inputState } from '../game/InputState';
import { useControlInsets } from './useControlInsets';
import { type HitId, useHitTarget } from './ControlTouch';
import type { Vehicle } from '../entities/Vehicle';
import { isGunId } from '../data/weapons';
import { readableShadow } from './textShadow';
import {
  IconAim,
  IconBrake,
  IconBus,
  IconCar,
  IconExit,
  IconFist,
  IconGas,
  IconHeli,
  IconHorn,
  IconReload,
  IconRun,
  IconSteal,
  IconWeapon,
} from './ActionIcons';

function ActionBtn({
  id,
  icon,
  accent,
  label,
  accessibilityLabel,
  style,
  active = false,
}: {
  id: HitId;
  icon: ReactNode;
  accent: string;
  label: string;
  accessibilityLabel: string;
  style?: StyleProp<ViewStyle>;
  active?: boolean;
}) {
  const { ref, onLayout, pressed } = useHitTarget(id);
  return (
    <View
      ref={ref}
      onLayout={onLayout}
      collapsable={false}
      accessible
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ selected: pressed || active }}
      testID={`control-${id}`}
      style={[
        styles.action,
        style,
        {
          pointerEvents: 'none',
          borderColor: pressed || active ? accent : 'rgba(255,255,255,0.4)',
          backgroundColor: pressed ? accent : active ? 'rgba(38,78,70,0.95)' : 'rgba(10,14,20,0.85)',
        },
      ]}
    >
      {icon}
      <Text style={styles.actionLabel} numberOfLines={1}>{label}</Text>
    </View>
  );
}

function FootActions({ compact }: { compact: boolean }) {
  const game = getGame();
  const [equipped, setEquipped] = useState(game.weapons.equipped);
  const [crouching, setCrouching] = useState(game.player.crouching);
  const [aiming, setAiming] = useState(false);
  useEffect(() => {
    const iv = setInterval(() => {
      setEquipped(game.weapons.equipped);
      setCrouching(game.player.crouching);
      setAiming(inputState.aimTouchHeld);
    }, 100);
    return () => clearInterval(iv);
  }, [game]);
  const armed = isGunId(equipped);
  // `tintColor` é prop do Image, não estilo: o react-native-web avisa contra a forma antiga e o
  // RN 0.81 tem a prop, então o caminho novo existe nos dois lados.
  const weaponIcon = equipped !== 'unarmed' ? <Image source={ASSET_FILES[`Weapons/${equipped}_icon.png`]}
    style={{ width: 34, height: 18 }} tintColor="#e4edf5" resizeMode="contain" /> : <IconWeapon size={18} />;

  return (
    <View style={[styles.footActions, compact && styles.compactFootActions, { pointerEvents: 'none' }]}>
      <View style={[styles.weaponRow, { pointerEvents: 'none' }]}>
        <ActionBtn id="weaponPrev" icon={<Text style={styles.glyphIcon}>‹</Text>} accent="rgba(70,180,255,0.95)"
          label="‹ ARMA" accessibilityLabel="Arma anterior" style={styles.utility} />
        <ActionBtn id="weapon" icon={weaponIcon} accent="rgba(70,180,255,0.95)"
          label="ARMA ›" accessibilityLabel="Próxima arma" style={styles.utility} />
      </View>
      <View style={[styles.weaponRow, { pointerEvents: 'none' }]}>
        <ActionBtn id="jump" icon={<Text style={styles.jumpIcon}>↑</Text>} accent="rgba(90,200,240,0.95)"
          label="PULAR" accessibilityLabel="Pular ou saltar cerca baixa" style={styles.utility} />
        <ActionBtn id="crouch" icon={<Text style={styles.jumpIcon}>↓</Text>} accent="rgba(100,220,170,0.95)"
          label={crouching ? 'LEVANTAR' : 'AGACHAR'} accessibilityLabel="Alternar agachamento"
          active={crouching} style={styles.utility} />
      </View>
      <View style={[styles.weaponRow, { pointerEvents: 'none' }]}>
        <ActionBtn id="aim" icon={<IconAim size={18} />} accent="rgba(255,150,70,0.95)"
          label="MIRA" accessibilityLabel="Alternar mira manual" active={aiming} style={styles.utility} />
        <ActionBtn id="reload" icon={<IconReload size={18} color={armed ? '#fff' : '#8d9ba9'} />}
          accent="rgba(70,180,255,0.95)" label="RECARGA" accessibilityLabel="Recarregar arma" style={styles.utility} />
      </View>
      <View style={[styles.meleeRow, compact && styles.compactRow, { pointerEvents: 'none' }]}>
        <ActionBtn
          id="attack"
          icon={armed ? <IconAim size={compact ? 28 : 36} /> : <IconFist size={compact ? 28 : 36} />}
          accent="rgba(255,90,90,0.95)"
          label={armed ? 'ATIRAR' : equipped === 'bat' ? 'GOLPEAR' : 'SOCO'}
          accessibilityLabel={armed ? 'Atirar' : equipped === 'bat' ? 'Golpear com taco' : 'Socar'}
          style={[styles.attack, compact && styles.compactAttack]}
        />
        <ActionBtn
          id="run"
          icon={<IconRun size={compact ? 28 : 36} />}
          accent="rgba(255,210,70,0.95)"
          label="CORRER"
          accessibilityLabel="Correr"
          style={[styles.run, compact && styles.compactRun]}
        />
      </View>
    </View>
  );
}

/**
 * `flying` é o helicóptero do player ao volante: ali o pedal verde vira cabra para cima
 * e o vermelho vira cabra para baixo. A entrada continua a mesma, só o nome muda.
 */
export function ActionButtons({ flying = false }: { flying?: boolean }) {
  const game = getGame();
  const insets = useControlInsets();
  const { width, height } = useWindowDimensions();
  const compact = width < 700 || height < 500;
  const driving = useSyncExternalStore(
    (cb) => game.subscribeEntityChange(cb),
    () => game.player.currentVehicleId !== null,
    () => game.player.currentVehicleId !== null,
  );
  const aboard = useSyncExternalStore(
    (cb) => game.subscribeEntityChange(cb),
    () => game.player.busUnit !== null,
    () => game.player.busUnit !== null,
  );

  const [near, setNear] = useState<Vehicle | null>(null);
  const [interiorPrompt, setInteriorPrompt] = useState<string | null>(null);
  useEffect(() => {
    const update = () => setInteriorPrompt(game.interiors.prompt(game.player));
    update();
    const iv = setInterval(update, 150);
    return () => clearInterval(iv);
  }, [game]);
  useEffect(() => {
    if (driving || aboard) {
      setNear(null);
      return;
    }
    const update = () => setNear(game.interiors.active ? null : game.interaction.nearestVehicle(game.player, game.vehicles));
    update();
    const iv = setInterval(update, 220);
    return () => clearInterval(iv);
  }, [driving, aboard, game]);
  // O ônibus da malha obedece ao horário, não ao joystick: o que a HUD dele oferece é uma
  // porta e o nome da linha, nunca um pedal. `door` é o que o botão faz neste instante — a
  // de embarque só existe com o veículo encostado, a de saída idem.
  const [door, setDoor] = useState<'embarcar' | 'desembarcar' | null>(null);
  const [line, setLine] = useState<string | null>(null);
  useEffect(() => {
    const update = () => {
      const unit = game.transport.aboard(game.player);
      if (unit) {
        setLine(game.transport.network.routes[unit.route].name);
        setDoor(unit.stopped ? 'desembarcar' : null);
      } else {
        setLine(null);
        setDoor(game.transport.boarding(game.player) === null ? null : 'embarcar');
      }
    };
    update();
    const iv = setInterval(update, 220);
    return () => clearInterval(iv);
  }, [driving, aboard, game]);

  const heli = near?.def.type === 'helicopter';
  const boardingBus = door === 'embarcar';

  return (
    <View
      style={[styles.container, { right: insets.right, bottom: insets.bottom, pointerEvents: 'none' }]}
    >
      {!driving && !aboard && (interiorPrompt || near || boardingBus) ? (
        <View style={[styles.contextActions, { pointerEvents: 'none' }]}>
          {interiorPrompt && !boardingBus && (
            <View style={[styles.interiorAction, { pointerEvents: 'none' }]}>
              <Text style={styles.interiorLabel} numberOfLines={2}>{interiorPrompt}</Text>
              <ActionBtn id="interact" icon={<IconExit size={22} />} accent="rgba(80,180,150,0.95)"
                label={game.interiors.active ? 'INTERAGIR' : 'ENTRAR'} accessibilityLabel={interiorPrompt} style={styles.enter} />
            </View>
          )}
          {near && !boardingBus && (
            <ActionBtn
              id="enter"
              icon={heli ? <IconHeli size={24} /> : near.occupied ? <IconSteal size={24} /> : <IconCar size={24} />}
              accent={heli ? 'rgba(90,210,255,0.95)' : near.occupied ? 'rgba(255,110,80,0.95)' : 'rgba(70,180,255,0.95)'}
              label={near.occupied ? 'TOMAR' : 'ENTRAR'}
              accessibilityLabel={heli ? 'Entrar no helicóptero' : near.occupied ? 'Tomar veículo' : 'Entrar no veículo'}
              style={styles.enter}
            />
          )}
          {boardingBus && (
            <ActionBtn
              id="enter"
              icon={<IconBus size={24} />}
              accent="rgba(255,206,84,0.95)"
              label="EMBARCAR"
              accessibilityLabel="Entrar no ônibus"
              style={styles.enter}
            />
          )}
        </View>
      ) : null}
      {aboard ? (
        <View style={[styles.exitRow, { pointerEvents: 'none' }]}>
          {line && (
            <View style={[styles.lineBadge, { pointerEvents: 'none' }]} accessible accessibilityLabel={`Linha ${line}`}>
              <Text style={styles.lineLabel} numberOfLines={1}>{line}</Text>
            </View>
          )}
          {door === 'desembarcar' && (
            <ActionBtn
              id="exit"
              icon={<IconBus size={28} />}
              accent="rgba(255,150,80,0.95)"
              label="DESEMBARCAR"
              accessibilityLabel="Descer do ônibus na calçada"
              style={styles.exit}
            />
          )}
        </View>
      ) : null}
      {driving && (
        <View style={[styles.exitRow, { pointerEvents: 'none' }]}>
          <ActionBtn
            id="horn"
            icon={<IconHorn size={26} />}
            accent="rgba(255,200,80,0.95)"
            label="BUZINA"
            accessibilityLabel="Buzinar"
            style={styles.horn}
          />
          <ActionBtn
            id="exit"
            icon={<IconExit size={28} />}
            accent="rgba(255,150,80,0.95)"
            label="SAIR"
            accessibilityLabel="Sair do veículo"
            style={styles.exit}
          />
        </View>
      )}
      {driving ? (
        <View style={[styles.pedals, compact && styles.compactPedals, { pointerEvents: 'none' }]}>
          <ActionBtn
            id="brake"
            icon={flying ? <Text style={styles.glyphIcon}>▼</Text> : <IconBrake />}
            accent="rgba(255,90,80,0.98)"
            label={flying ? 'DESCER' : 'FREAR'}
            accessibilityLabel={flying ? 'Descer o helicóptero' : 'Frear'}
            style={[styles.brake, compact && styles.compactBrake]}
          />
          <ActionBtn
            id="accel"
            icon={flying ? <Text style={styles.glyphIcon}>▲</Text> : <IconGas />}
            accent="rgba(70,210,120,0.98)"
            label={flying ? 'SUBIR' : 'ACELERAR'}
            accessibilityLabel={flying ? 'Subir o helicóptero' : 'Acelerar'}
            style={[styles.accel, compact && styles.compactAccel]}
          />
        </View>
      ) : aboard ? null : <FootActions compact={compact} />}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    gap: 8,
    alignItems: 'flex-end',
    zIndex: 30,
  },
  action: {
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
  },
  contextActions: { flexDirection: 'row', alignItems: 'flex-end', gap: 12 },
  interiorAction: { alignItems: 'center', gap: 4 },
  // Legibilidade sobre o asfalto: a sombra é a mesma nos dois lados, só a API muda —
  // `readableShadow` entrega `textShadow` ao react-native-web e as três propriedades
  // antigas ao nativo, que é a única forma que ele tem de aplicá-las.
  interiorLabel: { color: '#d4f3e4', fontSize: 10, lineHeight: 12, maxWidth: 74, ...readableShadow('#000') },
  // O letreiro da linha: informação, não botão — por isso não tem borda de ação.
  lineBadge: {
    height: 40,
    borderRadius: 12,
    paddingHorizontal: 12,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: 'rgba(255,206,84,0.95)',
    backgroundColor: 'rgba(10,14,20,0.85)',
  },
  lineLabel: {
    color: '#ffe5a3',
    fontWeight: '900',
    fontSize: 12,
    letterSpacing: 0.4,
    maxWidth: 130,
    ...readableShadow('#000'),
  },
  footActions: { width: 198, gap: 6 },
  compactFootActions: { width: 150 },
  jumpIcon: { color: '#fff', fontSize: 20, lineHeight: 22, fontWeight: '800' },
  glyphIcon: { color: '#9fd0ff', fontSize: 26, lineHeight: 28, fontWeight: '900' },
  weaponRow: { flexDirection: 'row', gap: 8 },
  utility: { flex: 1, minWidth: 0, height: 48, borderRadius: 12 },
  meleeRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 14 },
  compactRow: { gap: 10 },
  attack: { width: 84, height: 84, borderRadius: 42 },
  run: { width: 100, height: 100, borderRadius: 50 },
  compactAttack: { width: 64, height: 64, borderRadius: 32 },
  compactRun: { width: 76, height: 76, borderRadius: 38 },
  enter: { width: 64, height: 56, borderRadius: 18 },
  exitRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 10 },
  exit: { width: 84, height: 84, borderRadius: 42 },
  horn: { width: 64, height: 64, borderRadius: 20 },
  actionLabel: {
    color: '#fff',
    fontWeight: '800',
    fontSize: 9,
    letterSpacing: 0.2,
  },
  pedals: { flexDirection: 'row', alignItems: 'flex-end', gap: 22, marginTop: 4 },
  compactPedals: { gap: 12 },
  brake: { width: 90, height: 90, borderRadius: 22 },
  accel: { width: 112, height: 112, borderRadius: 28 },
  compactBrake: { width: 70, height: 70, borderRadius: 20 },
  compactAccel: { width: 80, height: 80, borderRadius: 24 },
});
