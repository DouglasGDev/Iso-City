import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View, useWindowDimensions } from 'react-native';
import { AlphaType, Canvas, Circle, ColorType, Group, Image, Path, Rect, Skia, FilterMode, type SkImage } from '@shopify/react-native-skia';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { getGame } from '../game/GameState';
import { uiAnalog } from '../game/InputState';
import { useControlInsets } from './useControlInsets';
import { useGameStore } from '../stores/useGameStore';
import { sound } from '../audio/SoundManager';
import { useUiInputKind, useUiSurface } from './useUiNav';
import { remainingRouteDistance, type GpsPoint, buildGpsRoute } from '../world/Gps';
import { MAP_COLORS as C, BIOME_LABEL, makeProjectors, mapPolygon, explorationPaths, radarPixels } from '../world/MapPresentation';
import { InteriorPlan } from './InteriorPlan';
import type { VisionCone } from '../systems/PoliceSystem';

const ZOOM_MIN = 1;
const ZOOM_MAX = 6;
const OPEN_ZOOM = 2.2;
/** Pixels de tela que um toque de D-pad anda no mapa cheio. */
const PAN_STEP = 46;
/** Velocidade do analógico esquerdo: px/s de pan e fator de zoom por segundo. */
const PAN_SPEED = 460;
const ZOOM_SPEED = 0.9;
/** Quão presente fica a terra ainda não descoberta no radar: apagada, nunca escondida. */
const FOG_DIM = 0.42;
/**
 * Ritmo do radar. A janela se move com o jogador, então este é o relógio de rolagem do
 * mapa: a 220ms o terreno dava saltos de ~6px a velocidade de carro, e com a névoa
 * apagando dois terços da janela o salto nem aparecia. Agora que a volta inteira é
 * legível, 120ms é o mínimo para o mapa deslizar em vez de tremer.
 */
const RADAR_TICK = 120;
const clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n));

// Uma única imagem da cidade por partida: radar e mapa cheio compartilham o raster de ~1,8 MB.
let radarCache: { gen: number; image: SkImage | null } | null = null;
function bakeRadar(gameGen: number) {
  if (radarCache?.gen === gameGen) return radarCache.image;
  const { pixels, width, height } = radarPixels(getGame().map.data);
  const data = Skia.Data.fromBytes(pixels);
  const image = Skia.Image.MakeImage({ width, height, alphaType: AlphaType.Unpremul, colorType: ColorType.RGBA_8888 }, data, width * 4);
  data.dispose();
  radarCache = { gen: gameGen, image };
  return image;
}

function routePath(route: GpsPoint[], project: (x: number, y: number) => GpsPoint) {
  return route.map((p, i) => {
    const s = project(p.x, p.y);
    return `${i ? 'L' : 'M'}${s.x},${s.y}`;
  }).join(' ') || 'M0,0';
}

/**
 * Leque de visão de um oficial. O eixo vem do plano do mundo, então o arco nasce
 * torto: em iso um ângulo de 90° para a esquerda não é 90° na tela.
 */
function conePath(cone: VisionCone, project: (x: number, y: number) => GpsPoint) {
  const origin = project(cone.x, cone.y);
  const steps = 10;
  let path = `M${origin.x},${origin.y}`;
  for (let i = 0; i <= steps; i++) {
    const a = cone.axis - cone.half + (cone.half * 2 * i) / steps;
    const edge = project(cone.x + Math.cos(a) * cone.radius, cone.y + Math.sin(a) * cone.radius);
    path += ` L${edge.x},${edge.y}`;
  }
  return `${path} Z`;
}

/** Calma → desconfiado → alerta → em perseguição: a cor conta o quanto já te viram. */
function coneColor(alert: number) {
  return alert >= 0.9 ? '#f47f89' : alert >= 0.5 ? '#f0a86a' : '#e6d07c';
}

function MapCanvas({ mapW, mapH, zoom, panX, panY, detailed }: {
  mapW: number; mapH: number; zoom: number; panX: number; panY: number; detailed: boolean;
}) {
  const gameGen = useGameStore((s) => s.gameGen);
  const mapMarker = useGameStore((s) => s.mapMarker);
  const mapRoute = useGameStore((s) => s.mapRoute);
  const game = getGame();
  const image = useMemo(() => bakeRadar(gameGen), [gameGen]);
  const explorationVersion = game.exploration.version;
  const mask = useMemo(() => explorationPaths(game.exploration), [game, explorationVersion]);
  const W = game.map.data.tilesW, H = game.map.data.tilesH;
  const { worldToScreen: project, imgW, imgH, imgX, imgY, scale } = makeProjectors(mapW, mapH, 0, W, H, zoom, panX, panY);
  const outline = useMemo(() => mapPolygon(0, 0, W, H, H), [W, H]);
  const grid = useMemo(() => {
    const lines: string[] = [];
    for (let x = 0; x <= imgW; x += 16) lines.push(`M${x},0 L${x},${imgH}`);
    for (let y = 0; y <= imgH; y += 16) lines.push(`M0,${y} L${imgW},${y}`);
    return lines.join(' ');
  }, [imgW, imgH]);
  const { player, vehicles, npcs } = game;
  const position = game.worldPosition;
  const p = project(position.x, position.y);
  const route = useMemo(() => routePath(mapRoute, project), [mapRoute, mapW, mapH, zoom, panX, panY, gameGen]);
  // Porta aberta: nem o radar nem o mapa cheio desenham a cidade. A sala é um plano à
  // parte, com mapa e coordenadas próprios, e é a planta dela que entra neste canvas.
  const room = game.interiors.active;
  if (room) {
    return <InteriorPlan room={room} mapW={mapW} mapH={mapH} detailed={detailed}
      zoom={detailed ? zoom : 1} panX={detailed ? panX : 0} panY={detailed ? panY : 0} />;
  }
  const known = (x: number, y: number) => {
    const s = project(x, y);
    return game.exploration.isExplored(Math.floor(x), Math.floor(y)) && s.x > -12 && s.y > -12 && s.x < mapW + 12 && s.y < mapH + 12;
  };
  const heading = Math.atan2((Math.cos(player.facingAngle) + Math.sin(player.facingAngle)) * 0.5,
    Math.cos(player.facingAngle) - Math.sin(player.facingAngle));
  const target = game.missions.state.phase !== 'break' ? game.missions.state.target : null;

  return <Canvas style={{ width: mapW, height: mapH }} pointerEvents="none">
    <Rect x={0} y={0} width={mapW} height={mapH} color={C.background} />
    <Group transform={[{ translateX: imgX }, { translateY: imgY }, { scale }]}>
      <Path path={outline} color={C.unknown} />
      <Group clip={outline}>
        <Path path={grid} color={C.grid} style="stroke" strokeWidth={0.5 / scale} />
      </Group>
      {/* O radar é o instrumento do "onde estou agora", e a janela dele alcança ~20 tiles para
          todo lado enquanto a descoberta revela só 8: dois terços do painel ficavam no cinza de
          nunca-visitado, incluindo a rua onde o jogador está pisando e o caminho à frente. A
          terra desconhecida continua apagada — só não some. No mapa cheio a névoa fecha por
          inteiro, porque lá ela é a recompensa de explorar, não o chão debaixo do pé. */}
      {image && !detailed && (
        <Image image={image} x={0} y={0} width={imgW} height={imgH} fit="fill" opacity={FOG_DIM}
          sampling={{ filter: FilterMode.Linear }} />
      )}
      <Group clip={mask.discovered}>
        {image && <Image image={image} x={0} y={0} width={imgW} height={imgH} fit="fill" sampling={{ filter: FilterMode.Linear }} />}
      </Group>
      <Path path={outline} color={C.border} style="stroke" strokeWidth={1 / scale} />
    </Group>
    {game.police.searchArea && (() => {
      const area = game.police.searchArea;
      const points = Array.from({ length: 49 }, (_, i) => ({ x: area.x + Math.cos(i / 48 * Math.PI * 2) * area.radius,
        y: area.y + Math.sin(i / 48 * Math.PI * 2) * area.radius }));
      const path = routePath(points, project) + ' Z';
      const color = area.phase === 'pursuit' ? '#f47f89' : C.route;
      return <Group><Path path={path} color={color} opacity={0.1} />
        <Path path={path} color={color} style="stroke" strokeWidth={1.2} opacity={0.8} /></Group>;
    })()}
    {game.policeVisionCones().map((cone) => {
      if (!known(cone.x, cone.y)) return null;
      const path = conePath(cone, project);
      const color = coneColor(cone.alert);
      return <Group key={`cone${cone.id}`}>
        <Path path={path} color={color} opacity={detailed ? 0.2 : 0.14} />
        <Path path={path} color={color} style="stroke" strokeWidth={0.8} opacity={0.5} />
      </Group>;
    })}
    {mapRoute.length >= 2 && <Group>
      <Path path={route} color="#161e24" style="stroke" strokeWidth={detailed ? 6 : 4} strokeCap="round" strokeJoin="round" />
      <Path path={route} color={C.route} style="stroke" strokeWidth={detailed ? 3 : 2} strokeCap="round" strokeJoin="round" />
    </Group>}
    {detailed && npcs.filter((n) => !n.dead && !n.inVehicle && n.kind !== 'cop' && known(n.x, n.y)).slice(0, 40).map((n) => {
      const s = project(n.x, n.y);
      return <Circle key={`n${n.id}`} cx={s.x} cy={s.y} r={1.7} color="#a5b5b7" />;
    })}
    {npcs.filter((n) => !n.dead && !n.inVehicle && n.kind === 'cop' && known(n.x, n.y)).map((n) => {
      const s = project(n.x, n.y);
      return <Circle key={`cop${n.id}`} cx={s.x} cy={s.y} r={detailed ? 3 : 2.5} color={C.police} />;
    })}
    {vehicles.filter((v) => v.state !== 'destroyed' && v.id !== player.currentVehicleId && known(v.x, v.y))
      .sort((a, b) => Number(b.def.type === 'police') - Number(a.def.type === 'police') ||
        Math.hypot(a.x - position.x, a.y - position.y) - Math.hypot(b.x - position.x, b.y - position.y))
      .slice(0, detailed ? 40 : 12).map((v) => {
        const s = project(v.x, v.y);
        return <Circle key={`v${v.id}`} cx={s.x} cy={s.y} r={v.def.type === 'helicopter' ? 3.2 : 2}
          color={v.def.type === 'police' ? C.police : '#a1a897'} />;
      })}
    {detailed && game.interiors.entrances.filter((e) => e.service !== 'ammo' && known(e.x, e.y)).map((e) => {
      const s = project(e.x, e.y);
      return <Rect key={`door${e.id}`} x={s.x - 3} y={s.y - 3} width={6} height={6}
        color={e.kind === 'home' ? '#c1d4cb' : '#d4ba98'} style="stroke" strokeWidth={1.2} />;
    })}
    {game.pickups.items.filter((item) => item.kind === 'ammo' && known(item.x, item.y)).map((item) => {
      const s = project(item.x, item.y), r = detailed ? 4 : 3;
      return <Rect key={`ammo${item.id}`} x={s.x - r} y={s.y - r} width={r * 2} height={r * 2}
        color={item.active ? C.ammo : '#776c60'} />;
    })}
    {target && (() => {
      const s = project(target.x, target.y), r = detailed ? 7 : 4;
      return <Group><Path path={`M${s.x},${s.y - r} L${s.x + r},${s.y} L${s.x},${s.y + r} L${s.x - r},${s.y} Z`}
        color={C.mission} /><Circle cx={s.x} cy={s.y} r={2} color={C.background} /></Group>;
    })()}
    {mapMarker && (() => {
      const s = project(mapMarker.x, mapMarker.y);
      return <Group><Circle cx={s.x} cy={s.y} r={detailed ? 10 : 6} color={C.destination} opacity={0.2} />
        <Circle cx={s.x} cy={s.y} r={detailed ? 5 : 3} color={C.destination} />
        <Circle cx={s.x} cy={s.y} r={1.7} color="#f9f5ff" /></Group>;
    })()}
    <Circle cx={p.x} cy={p.y} r={detailed ? 15 : 10} color={C.visited} opacity={0.15} />
    <Circle cx={p.x} cy={p.y} r={detailed ? 11 : 8} color={C.player} style="stroke" strokeWidth={1} opacity={0.65} />
    <Group transform={[{ translateX: p.x }, { translateY: p.y }, { rotate: heading }]}>
      <Path path={detailed ? 'M9,0 L-6,-5 L-3,0 L-6,5 Z' : 'M6,0 L-4,-4 L-2,0 L-4,4 Z'} color={C.player} />
    </Group>
  </Canvas>;
}

function Legend({ color, label }: { color: string; label: string }) {
  return <View style={styles.legendItem}><View style={[styles.legendDot, { backgroundColor: color }]} /><Text style={styles.legendText}>{label}</Text></View>;
}

export function MiniMap() {
  const insets = useControlInsets();
  const { height } = useWindowDimensions();
  const size = height < 500 ? 84 : 112;
  const mapMarker = useGameStore((s) => s.mapMarker);
  const mapRoute = useGameStore((s) => s.mapRoute);
  const suspended = useGameStore((s) => s.paused || s.mapOpen || s.overlay !== null);
  const game = getGame();
  const [, setTick] = useState(0);
  useEffect(() => {
    if (suspended) return;
    const iv = setInterval(() => setTick((t) => t + 1), RADAR_TICK);
    return () => clearInterval(iv);
  }, [suspended]);
  const ms = game.missions.state;
  const dest = mapMarker ?? (ms.phase !== 'break' ? ms.target : null);
  const position = game.worldPosition;
  const project = makeProjectors(size, size, 0, game.map.data.tilesW, game.map.data.tilesH, 1, 0, 0);
  const p = project.worldToScreen(position.x, position.y);
  const radarZoom = 12;
  const rem = dest ? mapMarker && mapRoute.length >= 2 ? remainingRouteDistance(mapRoute, position.x, position.y)
    : Math.hypot(position.x - dest.x, position.y - dest.y) : null;
  const room = game.interiors.active;
  return <View style={[styles.wrap, { top: insets.top + 52, left: Math.max(12, insets.left) }]} pointerEvents="none" testID="minimap">
    <View style={[styles.clip, { width: size, height: size }]}>
      <MapCanvas mapW={size} mapH={size} zoom={radarZoom} panX={(size / 2 - p.x) * radarZoom}
        panY={(size / 2 - p.y) * radarZoom} detailed={false} />
      <Text style={styles.radarLabel}>{room ? 'PLANO' : 'RADAR'}</Text>
    </View>
    {/* O GPS manda: quem está dentro de uma sala ainda tem compromisso do lado de fora. */}
    <Text style={styles.markerHint}>{rem !== null && Number.isFinite(rem)
      ? `${mapMarker ? 'GPS' : 'Missão'} ${rem.toFixed(0)}m`
      : room ? room.label
      : `${game.exploration.percent.toFixed(1)}% explorado`}</Text>
  </View>;
}

export function FullMap({ onClose }: { onClose: () => void }) {
  const win = useWindowDimensions();
  const safe = useSafeAreaInsets();
  const mapW = win.width, mapH = win.height;
  const compact = mapH < 500 || mapW < 700;
  const game = getGame();
  const mapMarker = useGameStore((s) => s.mapMarker);
  const mapRoute = useGameStore((s) => s.mapRoute);
  const [zoom, setZoom] = useState(OPEN_ZOOM);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const zoomRef = useRef(zoom), panRef = useRef(pan);
  zoomRef.current = zoom; panRef.current = pan;
  const pinchBase = useRef({ zoom: 1, x: 0, y: 0 });
  const panBase = useRef({ x: 0, y: 0 });
  const W = game.map.data.tilesW, H = game.map.data.tilesH;
  const inside = game.interiors.active;
  // A planta é um mapa próprio, do tamanho de uma sala. Centralizar e limitar o arrasto
  // com as medidas da cidade jogaria a planta para fora da tela: aqui o viewport é dela.
  const { viewW, viewH, viewPad } = inside
    ? { viewW: inside.map.worldW, viewH: inside.map.worldH, viewPad: 8 }
    : { viewW: W, viewH: H, viewPad: 0 };
  const boundPan = useCallback((x: number, y: number, z: number) => {
    const base = makeProjectors(mapW, mapH, viewPad, viewW, viewH, z, 0, 0);
    return { x: clamp(x, -base.imgW * base.scale / 2, base.imgW * base.scale / 2),
      y: clamp(y, -base.imgH * base.scale / 2, base.imgH * base.scale / 2) };
  }, [mapW, mapH, viewW, viewH, viewPad]);
  const changeView = useCallback((z: number, x: number, y: number) => {
    const next = boundPan(x, y, z);
    zoomRef.current = z; panRef.current = next; setZoom(z); setPan(next);
  }, [boundPan]);
  const centerPlayer = useCallback(() => {
    // Na sala, o corpo que a planta desenha é o do plano dela; na rua é o que a cidade vê.
    const position = game.interiors.active ? game.player : game.worldPosition;
    // Uma planta de 7×5 já cabe inteira na tela no zoom 1: abrir o mapa dentro de casa
    // mostra a sala toda, não um close no balcão.
    const open = inside ? ZOOM_MIN : OPEN_ZOOM;
    const p = makeProjectors(mapW, mapH, viewPad, viewW, viewH, 1, 0, 0).worldToScreen(position.x, position.y);
    changeView(open, (mapW / 2 - p.x) * open, (mapH / 2 - p.y) * open);
  }, [game, mapW, mapH, viewW, viewH, viewPad, inside, changeView]);
  useEffect(() => centerPlayer(), [centerPlayer]);
  const applyZoom = useCallback((next: number) => {
    const z = clamp(next, ZOOM_MIN, ZOOM_MAX), ratio = z / zoomRef.current;
    changeView(z, panRef.current.x * ratio, panRef.current.y * ratio);
  }, [changeView]);

  const markAtScreen = useCallback((sx: number, sy: number) => {
    // Dentro de uma sala não há cidade na tela: o destino espera do lado de fora da porta.
    if (game.interiors.active) return;
    const world = makeProjectors(mapW, mapH, 0, W, H, zoomRef.current, panRef.current.x, panRef.current.y).screenToWorld(sx, sy);
    if (world.x < 0 || world.y < 0 || world.x >= W || world.y >= H) return;
    let x = clamp(world.x, 0.5, W - 0.5), y = clamp(world.y, 0.5, H - 0.5);
    const driving = game.player.currentVehicleId !== null;
    const nodes = driving ? game.map.roadNodes : game.map.sidewalkNodes.length ? game.map.sidewalkNodes : game.map.roadNodes;
    if (nodes.length) {
      const index = driving || !game.map.sidewalkNodes.length ? game.map.nearestRoadNode(x, y) : game.map.nearestSidewalkNode(x, y);
      x = nodes[index].x; y = nodes[index].y;
    }
    const origin = game.worldPosition;
    useGameStore.setMapDestination(x, y, buildGpsRoute(game.map, origin.x, origin.y, x, y, driving));
    sound.play('uiClick', 0.55);
  }, [game, mapW, mapH, W, H]);

  const kind = useUiInputKind();
  const hardware = kind !== 'touch';
  const panBy = useCallback((dx: number, dy: number) => {
    changeView(zoomRef.current, panRef.current.x + dx, panRef.current.y + dy);
  }, [changeView]);
  const markCentre = useCallback(() => markAtScreen(mapW / 2, mapH / 2), [markAtScreen, mapW, mapH]);
  useUiSurface('map', {
    items: () => [],
    // Aqui as setas pertencem à câmera, não a uma lista: nada move foco no mapa.
    move: [],
    onAction: (action) => {
      if (action === 'up') panBy(0, PAN_STEP);
      else if (action === 'down') panBy(0, -PAN_STEP);
      else if (action === 'left') panBy(PAN_STEP, 0);
      else if (action === 'right') panBy(-PAN_STEP, 0);
      else if (action === 'zoomIn') applyZoom(zoomRef.current + 0.5);
      else if (action === 'zoomOut') applyZoom(zoomRef.current - 0.5);
      else if (action === 'confirm') markCentre();
      else if (action === 'prev') centerPlayer();
      else if (action === 'next') changeView(1, 0, 0);
    },
    onBack: onClose,
  });
  useEffect(() => {
    if (!hardware) return;
    // O analógico é contínuo: só o quadro sabe quanto tempo passou desde o último.
    let frame = 0, last = 0;
    const step = (now: number) => {
      const dt = last ? Math.min(0.05, (now - last) / 1000) : 0;
      last = now;
      if (dt > 0) {
        if (uiAnalog.x || uiAnalog.y) panBy(-uiAnalog.x * PAN_SPEED * dt, -uiAnalog.y * PAN_SPEED * dt);
        if (uiAnalog.zoom) applyZoom(zoomRef.current * (1 + uiAnalog.zoom * ZOOM_SPEED * dt));
      }
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [hardware, panBy, applyZoom]);

  const fingerGesture = Gesture.Pan().runOnJS(true).maxPointers(1).minDistance(12)
    .onStart(() => { panBase.current = { ...panRef.current }; })
    .onUpdate((e) => changeView(zoomRef.current, panBase.current.x + e.translationX, panBase.current.y + e.translationY));
  const pinchGesture = Gesture.Pinch().runOnJS(true)
    .onStart((e) => { pinchBase.current = { zoom: zoomRef.current,
      x: (e.focalX - mapW / 2 - panRef.current.x) / zoomRef.current,
      y: (e.focalY - mapH / 2 - panRef.current.y) / zoomRef.current }; })
    .onUpdate((e) => {
      const z = clamp(pinchBase.current.zoom * e.scale, ZOOM_MIN, ZOOM_MAX);
      changeView(z, e.focalX - mapW / 2 - pinchBase.current.x * z, e.focalY - mapH / 2 - pinchBase.current.y * z);
    });
  const tapGesture = Gesture.Tap().runOnJS(true).maxDistance(10).onEnd((event, success) => {
    if (success) markAtScreen(event.x, event.y);
  });
  const composed = Gesture.Race(Gesture.Simultaneous(fingerGesture, pinchGesture), tapGesture);
  const position = game.worldPosition;
  const tile = game.map.data.tiles[Math.floor(position.y) * W + Math.floor(position.x)];
  const rem = mapMarker ? mapRoute.length >= 2 ? remainingRouteDistance(mapRoute, position.x, position.y)
    : Math.hypot(position.x - mapMarker.x, position.y - mapMarker.y) : null;
  const discovered = game.exploration.percent;
  const tools = [
    { id: 'zoom-in', label: 'Ampliar mapa', text: '+', disabled: zoom >= ZOOM_MAX, action: () => applyZoom(zoomRef.current + 0.5) },
    { id: 'zoom-out', label: 'Reduzir mapa', text: '−', disabled: zoom <= ZOOM_MIN, action: () => applyZoom(zoomRef.current - 0.5) },
    { id: 'center', label: 'Centralizar no jogador', text: '◎', action: centerPlayer },
    { id: 'overview', label: 'Ver cidade inteira', text: '◇', action: () => changeView(1, 0, 0) },
  ];

  return <View style={styles.fullOverlay} testID="full-map">
    <GestureDetector gesture={composed}>
      <View style={StyleSheet.absoluteFill} collapsable={false} testID="full-map-surface">
        <MapCanvas mapW={mapW} mapH={mapH} zoom={zoom} panX={pan.x} panY={pan.y} detailed />
      </View>
    </GestureDetector>
    {hardware && (
      <View style={[styles.crosshair, { left: mapW / 2, top: mapH / 2 }]} pointerEvents="none" testID="map-crosshair">
        <View style={styles.crossRing} />
        <Text style={styles.crossLabel}>{inside ? (kind === 'gamepad' ? 'Sem destino dentro de casa' : 'Sem GPS dentro de casa')
          : kind === 'gamepad' ? 'A · marcar aqui' : 'Enter · marcar aqui'}</Text>
      </View>
    )}
    <View style={[styles.mapHeader, { top: safe.top + 12, left: safe.left + 16, right: safe.right + 16 }]} pointerEvents="box-none">
      <View style={styles.titleCard} pointerEvents="none">
        <Text style={styles.eyebrow}>ISO CITY / {inside ? 'INTERIOR' : 'NAVEGAÇÃO'}</Text>
        <Text style={[styles.fullTitle, compact && styles.titleCompact]}>{inside ? 'Plano do interior' : 'Mapa da cidade'}</Text>
        <Text style={styles.subtle}>{inside
          ? `${inside.label} · ${inside.map.worldW}×${inside.map.worldH} tiles, fora do mapa da cidade`
          : BIOME_LABEL[tile?.biome] ?? 'Cidade'}</Text>
      </View>
      <View style={styles.headerRight}>
        <View style={[styles.progressCard, compact && styles.progressCompact]} pointerEvents="none">
          <View style={styles.progressHeading}><Text style={styles.progressLabel}>EXPLORADO</Text>
            <Text style={styles.percent} testID="map-explored">{discovered.toFixed(1)}%</Text></View>
          <View style={styles.progressTrack}><View style={[styles.progressFill, { width: `${discovered}%` }]} /></View>
          {!compact && <Text style={styles.subtle}>Descobertas desta partida</Text>}
        </View>
        <TouchableOpacity style={styles.closeButton} testID="full-map-close" accessibilityRole="button" accessibilityLabel="Fechar mapa"
          onPress={() => { sound.play('uiClick', 0.6); onClose(); }}><Text style={styles.closeText}>×</Text></TouchableOpacity>
      </View>
    </View>
    <View style={[styles.mapTools, { right: safe.right + 16, top: Math.max(safe.top + 106, (mapH - 208) / 2) }]}>
      {tools.map((tool) => <TouchableOpacity key={tool.id} testID={`map-${tool.id}`} accessibilityRole="button"
        accessibilityLabel={tool.label} accessibilityState={{ disabled: !!tool.disabled }} disabled={tool.disabled}
        style={[styles.toolButton, tool.disabled && styles.toolDisabled]} onPress={() => { sound.play('uiClick', 0.4); tool.action(); }}>
        <Text style={styles.toolText}>{tool.text}</Text>
      </TouchableOpacity>)}
    </View>
    <View style={[styles.mapFooter, { bottom: safe.bottom + 12, left: safe.left + 16, right: safe.right + 80 }]} pointerEvents="box-none">
      {mapMarker && rem !== null && <View style={styles.destinationCard}>
        <View style={styles.destinationInfo} pointerEvents="none"><Text style={styles.destinationTitle}>DESTINO MARCADO · {Math.round(rem)}m</Text>
          <Text style={styles.subtle}>{game.exploration.isExplored(Math.floor(mapMarker.x), Math.floor(mapMarker.y)) ? 'Área descoberta' : 'Área não explorada'} · {game.player.currentVehicleId !== null ? 'Veículo' : 'A pé'}</Text></View>
        <TouchableOpacity testID="map-clear" accessibilityRole="button" accessibilityLabel="Limpar destino" style={styles.clearButton}
          onPress={() => useGameStore.clearMapMarker()}><Text style={styles.clearText}>Limpar</Text></TouchableOpacity>
      </View>}
      <View style={styles.legendCard} pointerEvents="none">
        <View style={styles.legendRow}>
          {inside ? <>
            <Legend color={C.player} label="Você" /><Legend color={C.route} label="Balcão" />
            <Legend color={C.visited} label="Saída" /><Legend color="#c3b493" label="Gente" />
          </> : <>
            <Legend color="#657e86" label="Descoberto" />
            <Legend color={C.unknown} label="Não explorado" /><Legend color={C.mission} label="Missão / GPS" />
            {!compact && <><Legend color={C.police} label="Polícia" /><Legend color={C.ammo} label="Munição" /></>}
          </>}
        </View>
        <Text style={styles.help}>{inside ? (hardware ? 'Setas/D-pad mover · zoom · B fechar' : 'Arraste para mover · zoom para ler a planta')
          : hardware
          ? (kind === 'gamepad' ? 'D-pad/LS mover · LT/RT zoom · A marcar no centro · B fechar'
            : 'Setas mover · +/− zoom · Enter marcar · PageUp centralizar · Esc fechar')
          : 'Toque/clique para marcar · Arraste para mover · Explore para revelar'}</Text>
        {game.police.searchArea && <Text style={styles.searchHint}>{game.police.searchArea.phase === 'pursuit' ? 'PERSEGUIÇÃO · área vermelha' : 'BUSCA POLICIAL · última posição conhecida'}</Text>}
      </View>
    </View>
  </View>;
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', zIndex: 40 },
  clip: { overflow: 'hidden', borderRadius: 12, borderWidth: 1.5, borderColor: '#637e80', backgroundColor: C.background },
  radarLabel: { position: 'absolute', top: 4, left: 5, color: '#b1c4c7', fontSize: 7, fontWeight: '800', letterSpacing: 1.2 },
  markerHint: { marginTop: 3, color: C.visited, fontSize: 10, fontWeight: '700', textAlign: 'center',
    textShadowColor: '#0a1219', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 3 },
  fullOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: C.background, zIndex: 110 },
  // Mira do centro: sem cursor, o jogador move o mapa até o ponto e marca ali.
  crosshair: { position: 'absolute', width: 0, alignItems: 'center', zIndex: 120 },
  crossRing: { width: 34, height: 34, borderRadius: 17, marginTop: -17, borderWidth: 2, borderColor: 'rgba(242,192,99,0.9)' },
  crossLabel: { marginTop: 5, color: '#f2c063', fontSize: 9, fontWeight: '800', backgroundColor: 'rgba(8,12,18,0.72)',
    paddingHorizontal: 5, paddingVertical: 2, borderRadius: 4 },
  mapHeader: { position: 'absolute', flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 },
  titleCard: { paddingVertical: 10, paddingHorizontal: 14, borderRadius: 12, backgroundColor: 'rgba(12,20,29,0.94)', borderWidth: 1, borderColor: '#293c48', flexShrink: 1 },
  eyebrow: { color: C.visited, fontSize: 9, fontWeight: '800', letterSpacing: 1.8 },
  fullTitle: { color: '#eff6f4', fontSize: 25, fontWeight: '800', letterSpacing: -0.6, marginTop: 3, marginBottom: 3 },
  titleCompact: { fontSize: 20 },
  subtle: { color: '#8fa4ae', fontSize: 10, lineHeight: 15 },
  headerRight: { flexDirection: 'row', gap: 10, alignItems: 'flex-start' },
  progressCard: { width: 180, padding: 12, borderRadius: 12, borderWidth: 1, borderColor: '#293c48', backgroundColor: '#111e28', gap: 7 },
  progressCompact: { width: 136, padding: 10 },
  progressHeading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  progressLabel: { color: '#8fa4ae', fontSize: 8, letterSpacing: 1.2, fontWeight: '800' },
  percent: { color: C.visited, fontSize: 17, fontWeight: '800', fontVariant: ['tabular-nums'] },
  progressTrack: { height: 3, backgroundColor: '#2b414a', borderRadius: 2, overflow: 'hidden' },
  progressFill: { height: 3, backgroundColor: C.visited },
  closeButton: { width: 48, height: 48, backgroundColor: '#21343e', borderColor: '#3c5660', borderWidth: 1, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  closeText: { color: '#e5f1ee', fontSize: 29, lineHeight: 32 },
  mapTools: { position: 'absolute', gap: 4 },
  toolButton: { width: 48, height: 48, backgroundColor: '#172731', borderRadius: 10, borderWidth: 1, borderColor: '#304652', alignItems: 'center', justifyContent: 'center' },
  toolDisabled: { opacity: 0.4 },
  toolText: { color: '#d3e7e3', fontSize: 26 },
  mapFooter: { position: 'absolute', alignItems: 'flex-start', gap: 8 },
  destinationCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#192632', borderRadius: 10, borderWidth: 1, borderColor: '#495066', paddingLeft: 12, maxWidth: '100%' },
  destinationInfo: { paddingVertical: 8, flexShrink: 1 },
  destinationTitle: { color: '#d9c7fc', fontSize: 10, fontWeight: '800', letterSpacing: 0.5 },
  clearButton: { minWidth: 64, height: 48, alignItems: 'center', justifyContent: 'center', marginLeft: 12 },
  clearText: { color: '#d9c7fc', fontSize: 11, fontWeight: '700' },
  legendCard: { backgroundColor: 'rgba(12,20,29,0.95)', borderRadius: 10, borderWidth: 1, borderColor: '#293c48', paddingHorizontal: 12, paddingVertical: 9, gap: 7, maxWidth: '100%' },
  legendRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 14 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  legendDot: { width: 7, height: 7, borderRadius: 2, borderWidth: 0.5, borderColor: '#697c82' },
  legendText: { color: '#c1cdcf', fontSize: 10 },
  help: { color: '#778f9b', fontSize: 9 },
  searchHint: { color: '#eabb72', fontSize: 9, fontWeight: '700' },
});
