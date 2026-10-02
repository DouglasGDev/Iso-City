import { Canvas, Circle, Group, Path, Rect } from '@shopify/react-native-skia';
import { getGame } from '../game/GameState';
import { MAP_COLORS as C, makeProjectors, mapPolygon } from '../world/MapPresentation';
import type { InteriorRoom } from '../systems/InteriorSystem';

/**
 * Planta do cômodo. GTA SA não mostra a cidade quando você entra numa loja: o radar passa
 * a desenhar o interior. É o que é aqui — e não é um recorte do mapa da cidade. A sala tem
 * mapa, tamanho e coordenadas próprios (7×5, ou 17×12 na cadeia); a projeção desta planta
 * roda inteira sobre eles, então nenhum tile, prédio ou morro da cidade entra neste canvas.
 */

// Piso e parede lidos de cima: o mesmo par claro-escuro do chão e da meia-parede desenhadas
// na sala em si, só que vistos de topo.
const FLOOR = '#3a434b';
const WALL = '#7f8d95';
const EDGE = '#161d24';

export function InteriorPlan({ room, mapW, mapH, zoom = 1, panX = 0, panY = 0, detailed = false }: {
  room: InteriorRoom;
  mapW: number;
  mapH: number;
  zoom?: number;
  panX?: number;
  panY?: number;
  detailed?: boolean;
}) {
  const game = getGame();
  const W = room.map.worldW;
  const H = room.map.worldH;
  const { worldToScreen: project, imgX, imgY, scale } = makeProjectors(mapW, mapH, 8, W, H, zoom, panX, panY);
  const player = game.player;
  const p = project(player.x, player.y);
  // Como no resto do radar: o ângulo do mundo chega torto à tela iso, e é este ajuste que
  // vira a seta para o lado que o sprite está olhando.
  const heading = Math.atan2((Math.cos(player.facingAngle) + Math.sin(player.facingAngle)) * 0.5,
    Math.cos(player.facingAngle) - Math.sin(player.facingAngle));
  const walls = [
    mapPolygon(-0.55, -0.55, W + 1.1, 0.55, H),
    mapPolygon(-0.55, H, W + 1.1, 0.55, H),
    mapPolygon(-0.55, -0.55, 0.55, H + 1.1, H),
    mapPolygon(W, -0.55, 0.55, H + 1.1, H),
  ];
  const jail = room.kind === 'jail';
  const people = jail ? game.jail.occupants : game.crowd.list;

  return (
    <Canvas style={{ width: mapW, height: mapH, pointerEvents: 'none' }}>
      <Rect x={0} y={0} width={mapW} height={mapH} color={C.background} />
      <Group transform={[{ translateX: imgX }, { translateY: imgY }, { scale }]}>
        <Path path={mapPolygon(0, 0, W, H, H)} color={FLOOR} />
        {room.furniture.map((f) => {
          const path = mapPolygon(f.x, f.y, f.w, f.d, H);
          return <Group key={`m${f.id}`}>
            <Path path={path} color={f.color} opacity={0.92} />
            <Path path={path} color={EDGE} style="stroke" strokeWidth={detailed ? 0.07 : 0.12} />
          </Group>;
        })}
        {walls.map((path, i) => <Path key={`p${i}`} path={path} color={WALL} />)}
      </Group>
      {(() => {
        const s = project(room.service.x, room.service.y);
        return <Circle cx={s.x} cy={s.y} r={detailed ? 4.5 : 3} color={C.route} opacity={0.9} />;
      })()}
      {(() => {
        const s = project(room.exit.x, room.exit.y);
        const r = detailed ? 7 : 5;
        return <Path path={`M${s.x},${s.y - r} L${s.x + r},${s.y} L${s.x},${s.y + r} L${s.x - r},${s.y} Z`}
          color={C.visited} />;
      })()}
      {people.map((o) => {
        if (o.dead) return null;
        const s = project(o.x, o.y);
        return <Circle key={`q${o.id}`} cx={s.x} cy={s.y} r={detailed ? 2.6 : 2}
          color={o.kind === 'cop' ? C.police : '#c3b493'} />;
      })}
      {jail && game.jail.keysOnFloor && (() => {
        const s = project(game.jail.keysOnFloor!.x, game.jail.keysOnFloor!.y);
        return <Circle cx={s.x} cy={s.y} r={detailed ? 3.4 : 2.6} color={C.destination} />;
      })()}
      <Circle cx={p.x} cy={p.y} r={detailed ? 13 : 9} color={C.visited} opacity={0.15} />
      <Group transform={[{ translateX: p.x }, { translateY: p.y }, { rotate: heading }]}>
        <Path path={detailed ? 'M9,0 L-6,-5 L-3,0 L-6,5 Z' : 'M6,0 L-4,-4 L-2,0 L-4,4 Z'} color={C.player} />
      </Group>
    </Canvas>
  );
}
