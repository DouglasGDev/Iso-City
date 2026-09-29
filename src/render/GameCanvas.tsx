import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { Canvas, Group, Path, Rect, Skia, useCanvasRef, type SkPath, type Transforms3d } from '@shopify/react-native-skia';
import { useDerivedValue, useSharedValue, type DerivedValue } from 'react-native-reanimated';
import { getGame } from '../game/GameState';
import { GameLoop } from '../game/GameLoop';
import { registerCameraSV, entitySVs, animalSVs } from './SharedValues';
import { animalVisualState } from '../entities/Animal';
import { GroundLayer } from './GroundLayer';
import { SortedWorldLayer, type OcclusionFocus } from './SortedWorldLayer';
import { effectiveAim, inputState } from '../game/InputState';
import { GAME_CONFIG } from '../game/GameConfig';
import { screenToWorld } from '../world/IsoUtils';
import { MarkerLayer } from './MarkerLayer';
import { WeaponEffects, type WeaponVisualState } from './WeaponEffects';
import { useGameStore } from '../stores/useGameStore';
import { EntranceMarkers, InteriorLayer } from './InteriorLayer';
import { TrafficSignalLayer } from './TrafficSignalLayer';
import { FogLayer } from './FogLayer';
import { WitnessLayer } from './WitnessLayer';
import { HazardLayer, HAZARD_VISUAL_IDLE, type HazardVisualState } from './HazardLayer';

const RAIN_COUNT = 72;
const SNOW_COUNT = 90;
const RAIN_STREAK = { dy: 30 };

/** Tile de precipitação: chuva são riscos inclinados pelo vento, neve são flocos com deriva. */
function buildPrecipTile(w: number, h: number, slant: number, snow: boolean) {
  const p = Skia.Path.Make();
  const count = snow ? SNOW_COUNT : RAIN_COUNT;
  for (let i = 0; i < count; i++) {
    const x = ((i * 137.508) % (w + 80)) - 40;
    const y = (i * 89.777) % h;
    if (snow) p.addCircle(x + slant * 10 * (1 + (i % 3)), y, 1.7);
    else {
      p.moveTo(x, y);
      p.lineTo(x + slant * 22, y + RAIN_STREAK.dy);
    }
  }
  return p;
}

function Precipitation({ path, transform, opacity, snow }: {
  path: SkPath;
  transform: DerivedValue<Transforms3d>;
  opacity: DerivedValue<number>;
  snow: boolean;
}) {
  return (
    <Group transform={transform} opacity={opacity}>
      {snow
        ? <Path path={path} style="fill" color="rgba(238,244,255,0.85)" />
        : <Path path={path} style="stroke" strokeWidth={1.6} color="rgba(190,215,255,0.55)" />}
    </Group>
  );
}

export function GameCanvas({ suspended }: { suspended: boolean }) {
  const gen = useGameStore((s) => s.gameGen);
  const game = useMemo(() => getGame(), [gen]);
  const room = useSyncExternalStore((cb) => game.subscribeEntityChange(cb), () => game.interiors.active, () => null);
  const canvasRef = useCanvasRef();
  const [size, setSize] = useState({ width: 1, height: 1 });

  const camera = useSharedValue({ x: game.camera.x, y: game.camera.y, zoom: game.camera.zoom });
  const shake = useSharedValue({ x: 0, y: 0 });
  const env = useSharedValue({ night: 0, warm: 0, rain: 0, snow: 0, bolt: 0 });
  const fog = useSharedValue(game.fog.snapshot);
  const rainY = useSharedValue(0);
  const clock = useSharedValue(0);
  const weapons = useSharedValue<WeaponVisualState>({ tracers: [], target: null, muzzle: null });
  const hazard = useSharedValue<HazardVisualState>(HAZARD_VISUAL_IDLE);
  const focus = useSharedValue<OcclusionFocus>({ x: 0, y: 0, depth: 0, active: false });

  useEffect(() => {
    registerCameraSV(camera);
  }, [camera]);

  const onLayout = useCallback((e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setSize({ width, height });
    game.setViewSize(width, height);
  }, [game]);

  const rainTileH = Math.max(480, size.height + 80);
  // A inclinação e o tipo só mudam devagar: o tile é reconstruído no máximo a cada meia volta do vento.
  const [precip, setPrecip] = useState<{ snow: boolean; slant: number } | null>(null);
  const precipPath = useMemo(
    () => buildPrecipTile(size.width, rainTileH, precip?.slant ?? 0, precip?.snow ?? false),
    [size.width, rainTileH, precip],
  );

  const cameraTransform = useDerivedValue(() => {
    const c = camera.value;
    const sh = shake.value;
    const sx = (c.x - c.y) * 64;
    const sy = (c.x + c.y) * 32;
    return [
      { translateX: size.width / 2 + sh.x },
      { translateY: size.height / 2 + sh.y },
      { scale: c.zoom },
      { translateX: -sx },
      { translateY: -sy },
    ];
  }, [size, camera, shake]);

  const nightOpacity = useDerivedValue(() => env.value.night, [env]);
  const warmOpacity = useDerivedValue(() => env.value.warm, [env]);
  const flashOpacity = useDerivedValue(() => env.value.bolt * 0.5, [env]);
  const rainOpacity = useDerivedValue(
    () => Math.min(1, env.value.rain * (env.value.snow > 0.5 ? 1.15 : 1.4)), [env]);
  const rainTransformA = useDerivedValue<Transforms3d>(() => [{ translateY: rainY.value }], [rainY]);
  const rainTransformB = useDerivedValue<Transforms3d>(
    () => [{ translateY: rainY.value - rainTileH }],
    [rainY, rainTileH],
  );

  const loop = useMemo(() => new GameLoop(game), [game]);

  // liga/desliga o overlay de precipitação sem re-renderizar o canvas inteiro
  useEffect(() => {
    const iv = setInterval(() => {
      const weather = game.weather;
      // O perigo inclina a chuva por cima do vento da frente: é assim que o furacão deita a água.
      const tilt = weather.wind + game.hazard.slant;
      if (game.interiors.active || (weather.intensity <= 0.02 && game.hazard.wet <= 0.02)) {
        setPrecip((prev) => (prev === null ? prev : null));
        return;
      }
      const slant = Math.round(tilt * 8) / 8;
      const snow = weather.snowing;
      setPrecip((prev) => (prev && prev.snow === snow && prev.slant === slant
        ? prev : { snow, slant }));
    }, 500);
    return () => clearInterval(iv);
  }, [game]);

  useEffect(() => {
    if (suspended) return;
    loop.start(() => {
      camera.value = {
        x: game.camera.x,
        y: game.camera.y,
        zoom: game.camera.zoom,
      };
      shake.value = { x: game.shakeX, y: game.shakeY };
      env.value = {
        night: game.interiors.active ? 0 : game.dayNight.tintAlpha,
        warm: game.interiors.active ? 0 : game.dayNight.warmAlpha * 0.16,
        rain: game.interiors.active ? 0 : Math.min(1, game.weather.intensity + game.hazard.wet),
        snow: game.interiors.active ? 0 : (game.weather.snowing ? 1 : 0),
        bolt: game.interiors.active ? 0 : game.weather.bolt,
      };
      fog.value = game.fog.snapshot;
      clock.value = game.time;
      const hz = game.hazard;
      hazard.value = {
        kind: hz.kind,
        strength: game.interiors.active ? 0 : hz.strength,
        spin: hz.vortex.spin,
        time: game.time,
        vortex: { x: hz.vortex.x, y: hz.vortex.y, radius: hz.vortex.radius },
        wave: { u0: hz.wave.u0, u1: hz.wave.u1, from: hz.wave.from, edge: hz.wave.edge, dir: hz.wave.dir, axis: hz.wave.axis },
      };
      // Neve cai devagar; a chuva continua na velocidade de sempre.
      const fall = game.weather.snowing ? 95 : 560;
      rainY.value = (game.time * fall) % rainTileH;
      const weapon = game.weapons;
      const player = game.player;
      focus.value = { x: (player.x - player.y) * 64, y: (player.x + player.y) * 32,
        depth: player.x + player.y, active: !game.interiors.active };
      const onFoot = player.health > 0 && player.currentVehicleId === null && !player.swimming;
      const moving = inputState.magnitude > GAME_CONFIG.JOYSTICK_DEADZONE;
      const aiming = effectiveAim(player.facingAngle);
      const direction = aiming.active ? { x: aiming.x, y: aiming.y }
        : screenToWorld(inputState.dx, inputState.dy);
      const aimLength = Math.hypot(direction.x, direction.y) || 1;
      // On mouse the reticle is the cursor's world point; sticks and touch keep the fixed ray.
      const atCursor = aiming.active && Number.isFinite(aiming.pointX) && Number.isFinite(aiming.pointY);
      const manualTarget = !onFoot ? null
        : atCursor ? { x: aiming.pointX, y: aiming.pointY, lift: 0 }
          : aiming.active || moving
            ? { x: player.x + direction.x / aimLength * 2, y: player.y + direction.y / aimLength * 2 }
            : null;
      weapons.value = {
        tracers: [...weapon.tracers, ...game.police.tracers].map((t) => ({ ...t })),
        target: manualTarget ?? (onFoot && weapon.aimTarget ? { ...weapon.aimTarget } : null),
        muzzle: weapon.fireFlash > 0 ? {
          x: game.player.x + Math.cos(weapon.aimAngle) * 0.3,
          y: game.player.y + Math.sin(weapon.aimAngle) * 0.3,
        } : null,
      };
      for (const [id, sv] of animalSVs) {
        const animal = game.wildlife.animals[id];
        if (!animal) continue;
        sv.position.value = { x: animal.x, y: animal.y };
        sv.visual.value = animalVisualState(animal, game.time);
      }
      for (const [id, sv] of entitySVs) {
        if (id === 'player') {
          sv.value = { x: game.player.x, y: game.player.y };
          continue;
        }
        const [kind, idxStr] = id.split(':');
        const idx = Number(idxStr);
        if (kind === 'npc') {
          const npc = game.npcs[idx];
          if (npc) sv.value = { x: npc.x, y: npc.y };
        } else if (kind === 'inmate') {
          const inmate = game.jail.byId(idx);
          if (inmate) sv.value = { x: inmate.x, y: inmate.y };
        } else if (kind === 'people') {
          const occupant = game.crowd.byId(idx);
          if (occupant) sv.value = { x: occupant.x, y: occupant.y };
        } else if (kind === 'veh') {
          const v = game.vehicles[idx];
          if (v) sv.value = { x: v.x, y: v.y };
        }
      }
    });
    return () => loop.stop();
  }, [loop, game, camera, shake, env, fog, rainY, clock, rainTileH, weapons, hazard, focus, suspended]);

  return (
    <View style={styles.container} onLayout={onLayout} pointerEvents="none">
      <Canvas ref={canvasRef} style={styles.canvas} opaque>
        <Rect x={0} y={0} width={size.width} height={size.height} color="#3d4a2f" />
        <Group transform={cameraTransform}>
          {room ? <>
            <InteriorLayer game={game} room={room} />
            <WeaponEffects state={weapons} />
          </> : <>
            <GroundLayer game={game} />
            <MarkerLayer game={game} clock={clock} />
            <TrafficSignalLayer game={game} />
            <EntranceMarkers game={game} />
            <SortedWorldLayer game={game} focus={focus} clock={clock} />
            <HazardLayer state={hazard} />
            <WitnessLayer game={game} />
            <WeaponEffects state={weapons} />
          </>}
        </Group>
        {!room && <FogLayer width={size.width} height={size.height} camera={camera} snapshot={fog} />}
        <Rect x={0} y={0} width={size.width} height={size.height} color="#0a1230" opacity={nightOpacity} />
        <Rect x={0} y={0} width={size.width} height={size.height} color="#ff7a2e" opacity={warmOpacity} />
        {precip ? (
          <>
            <Precipitation path={precipPath} transform={rainTransformA} opacity={rainOpacity} snow={precip.snow} />
            <Precipitation path={precipPath} transform={rainTransformB} opacity={rainOpacity} snow={precip.snow} />
          </>
        ) : null}
        {!room && <Rect x={0} y={0} width={size.width} height={size.height} color="#eaf2ff" opacity={flashOpacity} />}
      </Canvas>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#242a31',
  },
  canvas: {
    flex: 1,
  },
});
