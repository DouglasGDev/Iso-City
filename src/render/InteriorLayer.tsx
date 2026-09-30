import { memo, useEffect, useMemo, useState } from 'react';
import { Circle, Group, Path, RadialGradient, Skia } from '@shopify/react-native-skia';
import type { Furniture, InteriorKind, InteriorRoom } from '../systems/InteriorSystem';
import type { GameState } from '../game/GameState';
import { worldToScreen } from '../world/IsoUtils';
import { EntitySprite } from './EntitySprite';
import { GAME_CONFIG } from '../game/GameConfig';
import { JAIL_FRONT_Y } from '../data/jail';

// Everything here is measured against the 32 px character sprite (~1.7 m), so a
// tile (~1.5 m) holds one person comfortably and furniture never dwarfs the player.
const WALL_H = 46;
const WALL_T = 0.3;
// The two camera-side walls stay low: a full-height wall would hide the player.
const SILL_H = 13;

interface Point { x: number; y: number }

function polygon(points: Point[]) {
  const p = Skia.Path.Make();
  p.moveTo(points[0].x, points[0].y);
  for (const point of points.slice(1)) p.lineTo(point.x, point.y);
  p.close();
  return p;
}

/** Ground point (x, y) raised `z` screen pixels. */
function iso(x: number, y: number, z = 0): Point {
  const p = worldToScreen(x, y);
  return { x: p.x, y: p.y - z };
}

/** The three visible faces of an axis-aligned box standing between z0 and z1. */
function box(x: number, y: number, w: number, d: number, z0: number, z1: number) {
  return {
    top: polygon([iso(x, y, z1), iso(x + w, y, z1), iso(x + w, y + d, z1), iso(x, y + d, z1)]),
    left: polygon([iso(x, y + d, z1), iso(x, y + d, z0), iso(x + w, y + d, z0), iso(x + w, y + d, z1)]),
    right: polygon([iso(x + w, y, z1), iso(x + w, y, z0), iso(x + w, y + d, z0), iso(x + w, y + d, z1)]),
    foot: polygon([iso(x, y), iso(x + w, y), iso(x + w, y + d), iso(x, y + d)]),
  };
}

function Box({ x, y, w, d, z0 = 0, z1, color, outline }: {
  x: number; y: number; w: number; d: number; z0?: number; z1: number; color: string; outline?: string;
}) {
  const faces = useMemo(() => box(x, y, w, d, z0, z1), [x, y, w, d, z0, z1]);
  return <Group>
    <Path path={faces.left} color={color} />
    <Path path={faces.left} color="#000" opacity={0.26} />
    <Path path={faces.right} color={color} />
    <Path path={faces.right} color="#000" opacity={0.12} />
    <Path path={faces.top} color={color} />
    {outline
      ? <Path path={faces.top} color={outline} style="stroke" strokeWidth={1.2} />
      : <Path path={faces.top} color="#fff" opacity={0.1} style="stroke" strokeWidth={1.2} />}
  </Group>;
}

function Shadow({ x, y, w, d, grow = 0.06 }: { x: number; y: number; w: number; d: number; grow?: number }) {
  const path = useMemo(() => box(x - grow, y - grow, w + grow * 2, d + grow * 2, 0, 0).foot,
    [x, y, w, d, grow]);
  return <Path path={path} color="rgba(14,10,8,0.26)" />;
}

const shade = (color: string, amount: number) => {
  const n = parseInt(color.slice(1), 16);
  const mix = (v: number) => Math.max(0, Math.min(255, Math.round(
    amount > 0 ? v + (255 - v) * (amount / 100) : v * (1 + amount / 100))));
  return `rgb(${mix((n >> 16) & 255)},${mix((n >> 8) & 255)},${mix(n & 255)})`;
};

const FurnitureSprite = memo(function FurnitureSprite({ item }: { item: Furniture }) {
  const { x, y, w, d, height, color, kind } = item;
  const center = worldToScreen(x + w / 2, y + d / 2);
  return <Group>
    <Shadow x={x} y={y} w={w} d={d} />
    {kind === 'bed' && <>
      <Box x={x} y={y} w={w} d={d} z1={7} color="#6b4f37" />
      <Box x={x + 0.05} y={y + 0.05} w={w - 0.1} d={d - 0.1} z0={7} z1={height} color="#f4eee2" />
      <Box x={x + 0.1} y={y + 0.12} w={w - 0.2} d={0.3} z0={height} z1={height + 3} color="#ffffff" />
      <Box x={x + 0.03} y={y + 0.62} w={w - 0.06} d={d - 0.68} z0={height} z1={height + 2.5} color={color} />
    </>}
    {kind === 'sofa' && <>
      <Box x={x} y={y + 0.16} w={w} d={d - 0.16} z1={height} color={color} />
      <Box x={x} y={y} w={w} d={0.16} z1={height + 11} color={shade(color, -28)} />
      <Box x={x} y={y} w={0.15} d={d} z0={height} z1={height + 6} color={shade(color, -18)} />
      <Box x={x + w - 0.15} y={y} w={0.15} d={d} z0={height} z1={height + 6} color={shade(color, -18)} />
      <Box x={x + 0.18} y={y + 0.2} w={(w - 0.42) / 2} d={d - 0.28} z0={height} z1={height + 2.5} color={shade(color, 22)} />
      <Box x={x + 0.24 + (w - 0.42) / 2} y={y + 0.2} w={(w - 0.42) / 2} d={d - 0.28} z0={height} z1={height + 2.5} color={shade(color, 22)} />
    </>}
    {(kind === 'table' || kind === 'desk') && <>
      {[0.06, w - 0.14].map((lx) => [0.06, d - 0.14].map((ly) => (
        <Box key={`${lx}:${ly}`} x={x + lx} y={y + ly} w={0.08} d={0.08} z1={height - 3} color={shade(color, -34)} />
      )))}
      <Box x={x} y={y} w={w} d={d} z0={height - 3} z1={height} color={color} outline="rgba(255,255,255,0.22)" />
      {kind === 'desk' && <>
        <Box x={x + w - 0.5} y={y + 0.06} w={0.44} d={d - 0.12} z1={height - 3} color={shade(color, -20)} />
        <Box x={x + 0.16} y={y + 0.1} w={0.46} d={0.12} z0={height} z1={height + 7} color="#2b333c" />
        <Box x={x + 0.2} y={y + 0.14} w={0.38} d={0.04} z0={height + 2} z1={height + 6.4} color="#7fc7d9" />
      </>}
    </>}
    {kind === 'chair' && <>
      {[0.04, w - 0.12].map((lx) => [0.04, d - 0.12].map((ly) => (
        <Box key={`${lx}:${ly}`} x={x + lx} y={y + ly} w={0.07} d={0.07} z1={height - 2} color={shade(color, -36)} />
      )))}
      <Box x={x} y={y} w={w} d={d} z0={height - 2} z1={height} color={color} />
      <Box x={x + 0.03} y={y} w={w - 0.06} d={0.09} z0={height} z1={height + 11} color={shade(color, -14)} />
    </>}
    {kind === 'shelf' && <>
      <Box x={x} y={y} w={w} d={d} z1={height} color={shade(color, -22)} />
      <Box x={x + 0.04} y={y + 0.03} w={w - 0.08} d={d - 0.06} z0={height - 2} z1={height} color={shade(color, 18)} />
      {[0.32, 0.62].map((t) => <Group key={`board${t}`}>
        <Box x={x + 0.04} y={y + 0.03} w={w - 0.08} d={d - 0.06} z0={height * t} z1={height * t + 1.6} color={shade(color, 24)} />
        {[0, 1, 2].map((i) => (
          <Box key={`book${t}:${i}`} x={x + 0.1 + i * (w - 0.2) / 3} y={y + 0.07} w={(w - 0.2) / 3 - 0.04} d={d - 0.16}
            z0={height * t + 1.6} z1={height * t + 9 + (i % 2) * 2}
            color={i % 3 === 0 ? '#c9a24d' : i % 3 === 1 ? '#6f93b8' : '#b96a52'} />
        ))}
      </Group>)}
    </>}
    {kind === 'counter' && <>
      <Box x={x} y={y} w={w} d={d} z1={height - 3} color={color} />
      <Box x={x - 0.06} y={y - 0.06} w={w + 0.12} d={d + 0.12} z0={height - 3} z1={height} color={shade(color, 26)} />
      <Box x={x + 0.1} y={y + 0.12} w={0.16} d={d - 0.24} z1={height - 3} color={shade(color, -26)} />
      <Box x={x + w - 0.62} y={y + 0.14} w={0.48} d={0.34} z0={height} z1={height + 6} color="#33404a" />
      <Box x={x + w - 0.56} y={y + 0.18} w={0.36} d={0.05} z0={height + 1} z1={height + 5} color="#8fd0c0" />
    </>}
    {kind === 'rack' && <>
      <Box x={x} y={y} w={w} d={d} z1={height - 6} color={shade(color, -26)} />
      <Box x={x + 0.05} y={y + 0.05} w={w - 0.1} d={d - 0.1} z0={height - 6} z1={height} color={shade(color, 16)} />
      {[0.34, 0.68].map((t) => <Group key={`rack-shelf${t}`}>
        <Box x={x + 0.06} y={y + 0.05} w={w - 0.12} d={d - 0.1} z0={height * t} z1={height * t + 1.8} color={shade(color, 30)} />
        {[0, 1, 2, 3].map((i) => <Group key={`rack-gun${t}:${i}`}>
          <Box x={x + 0.18 + i * (w - 0.36) / 4} y={y + 0.1} w={(w - 0.36) / 4 - 0.06} d={d - 0.24}
            z0={height * t + 1.8} z1={height * t + 5} color={i % 2 ? '#2f3740' : '#4b3a2c'} />
        </Group>)}
      </Group>)}
    </>}
    {kind === 'crate' && <>
      <Box x={x} y={y} w={w} d={d} z1={height - 3} color={color} />
      <Box x={x + 0.04} y={y + 0.04} w={w - 0.08} d={d - 0.08} z0={height - 3} z1={height} color={shade(color, 20)} />
      <Box x={x + w / 2 - 0.05} y={y + 0.02} w={0.1} d={d - 0.04} z0={height} z1={height + 1.4} color={shade(color, -34)} />
    </>}
    {kind === 'grill' && <>
      <Box x={x} y={y} w={w} d={d} z1={height - 4} color={shade(color, -30)} />
      <Box x={x} y={y} w={w} d={d} z0={height - 4} z1={height} color="#3b424a" outline="rgba(255,255,255,0.26)" />
      {[0.28, 0.68].map((t) => (
        <Circle key={`burner${t}`} cx={iso(x + w * t, y + d / 2).x} cy={iso(x + w * t, y + d / 2, height).y}
          r={4.5} color="#1d2126" />
      ))}
      <Circle cx={iso(x + w * 0.28, y + d / 2).x} cy={iso(x + w * 0.28, y + d / 2, height).y} r={2} color="#e07a35" />
      <Box x={x + 0.06} y={y - 0.02} w={w - 0.12} d={0.1} z0={height + 8} z1={height + 11} color="#59636d" />
    </>}
    {kind === 'booth' && <>
      <Box x={x} y={y + 0.18} w={w} d={d - 0.18} z1={height - 8} color={color} />
      <Box x={x} y={y} w={w} d={0.18} z1={height} color={shade(color, -18)} />
      <Box x={x + 0.1} y={y + 0.24} w={w - 0.2} d={d - 0.3} z0={height - 8} z1={height - 5.5} color={shade(color, 20)} />
    </>}
    {kind === 'stool' && <>
      <Box x={x + w / 2 - 0.05} y={y + d / 2 - 0.05} w={0.1} d={0.1} z1={height - 2} color={shade(color, -30)} />
      <Circle cx={center.x} cy={iso(x + w / 2, y + d / 2, height - 2).y} r={w * 15} color={color} />
      <Circle cx={center.x} cy={iso(x + w / 2, y + d / 2, height).y} r={w * 13} color={shade(color, 22)} />
    </>}
    {/* Meia-parede de concreto: a cela precisa ser vista por cima, não escondida atrás. */}
    {kind === 'block' && <>
      <Box x={x} y={y} w={w} d={d} z1={height} color={color} />
      <Box x={x + 0.03} y={y + 0.03} w={w - 0.06} d={d - 0.06} z0={height} z1={height + 2} color={shade(color, 16)} />
    </>}
    {/* A grade só é desenhada fechada: destrancada, o vão vira passagem livre. */}
    {kind === 'bars' && (() => {
      const count = Math.max(3, Math.round(w * 6));
      const mid = y + d / 2;
      // O trilho do topo é uma barra de frente, não uma caixa: a tampa em paralelogramo de
      // uma caixa deitados 40 px de altura cobria o preso inteiro na altura da cabeça.
      return <>
        <Path path={polygon([iso(x, mid, height), iso(x + w, mid, height),
          iso(x + w, mid, height - 4), iso(x, mid, height - 4)])} color="#39424c" />
        {Array.from({ length: count }, (_, i) => {
          const barX = x + 0.06 + ((w - 0.12) * i) / (count - 1);
          return <Path key={`bar${i}`}
            path={polygon([iso(barX, mid, 0), iso(barX, mid, height - 4)])}
            color={color} style="stroke" strokeWidth={1.6} />;
        })}
        <Path path={polygon([iso(x, mid, height - 4), iso(x + w, mid, height - 4)])}
          color={shade(color, 24)} style="stroke" strokeWidth={2.4} />
      </>;
    })()}
    {kind === 'plant' && <>
      <Box x={x + 0.12} y={y + 0.12} w={w - 0.24} d={d - 0.24} z1={5} color="#9c5634" />
      <Circle cx={center.x} cy={center.y - height - 2} r={10} color="#2f6f3f" />
      <Circle cx={center.x - 5} cy={center.y - height + 3} r={7} color="#3f8a4c" />
      <Circle cx={center.x + 5} cy={center.y - height + 1} r={6.5} color="#57a55e" />
      <Circle cx={center.x} cy={center.y - height - 9} r={5.5} color="#69b56a" />
    </>}
  </Group>;
});

interface Palette {
  floor: string; floorAlt: string; grout: string; wall: string; wallDark: string; trim: string; rug: string;
}

const PALETTES: Record<InteriorKind, Palette> = {
  home: { floor: '#8f7049', floorAlt: '#9c7c53', grout: 'rgba(74,46,20,0.4)', wall: '#e3d6bb', wallDark: '#c6b795', trim: '#8d7454', rug: '#8f4a48' },
  shop: { floor: '#8a9496', floorAlt: '#939d9f', grout: 'rgba(52,60,62,0.35)', wall: '#dfe4e1', wallDark: '#bfc7c4', trim: '#7d8b8b', rug: '#5f7f7a' },
  office: { floor: '#9a9488', floorAlt: '#a49e92', grout: 'rgba(66,62,52,0.32)', wall: '#e6e2d6', wallDark: '#c8c3b4', trim: '#847f72', rug: '#4f6a7c' },
  jail: { floor: '#7b8086', floorAlt: '#848a90', grout: 'rgba(40,45,50,0.45)', wall: '#b9bec4', wallDark: '#9aa1a8', trim: '#5f676f', rug: '#4b535a' },
  precinct: { floor: '#8b959c', floorAlt: '#959ea5', grout: 'rgba(46,56,66,0.4)', wall: '#d7dee2', wallDark: '#b6c0c6', trim: '#54626d', rug: '#3f5566' },
};

const RoomShell = memo(function RoomShell({ room }: { room: InteriorRoom }) {
  const W = room.map.worldW;
  const H = room.map.worldH;
  const p = PALETTES[room.kind];
  const geometry = useMemo(() => {
    const surround = box(-4, -4, W + 8, H + 8, -30, 0);
    const floor = box(0, 0, W, H, 0, 0).top;
    // Wood runs along x in homes; tiles get a grout grid elsewhere.
    const lines = room.kind === 'home'
      ? Array.from({ length: H * 2 - 1 }, (_, i) => polygon([iso(0, (i + 1) / 2), iso(W, (i + 1) / 2)]))
      : [
        ...Array.from({ length: W - 1 }, (_, i) => polygon([iso(i + 1, 0), iso(i + 1, H)])),
        ...Array.from({ length: H - 1 }, (_, i) => polygon([iso(0, i + 1), iso(W, i + 1)])),
      ];
    const edgeShadow = [
      polygon([iso(0, 0), iso(W, 0), iso(W - 0.25, 0.25), iso(0.25, 0.25)]),
      polygon([iso(0, 0), iso(0, H), iso(0.25, H - 0.25), iso(0.25, 0.25)]),
    ];
    const back = box(0, -WALL_T, W, WALL_T, 0, WALL_H);
    const side = box(-WALL_T, 0, WALL_T, H, 0, WALL_H);
    // A window lets daylight in on the two far walls; homes get a picture instead.
    const pane = (axis: 'x' | 'y', from: number, to: number, low: number, high: number) => polygon(
      axis === 'x'
        ? [iso(from, 0, low), iso(to, 0, low), iso(to, 0, high), iso(from, 0, high)]
        : [iso(0, from, low), iso(0, to, low), iso(0, to, high), iso(0, from, high)],
    );
    return {
      surround, floor, lines, edgeShadow,
      walls: [back, side],
      window: room.kind === 'home' ? null : {
        glass: pane('x', W * 0.3, W * 0.76, 13, 34),
        sill: pane('x', W * 0.3 - 0.06, W * 0.76 + 0.06, 11, 13),
        head: pane('x', W * 0.3, W * 0.76, 34, 36),
      },
      picture: room.kind === 'home' ? {
        frame: pane('y', H * 0.34, H * 0.34 + 0.85, 16, 34),
        art: pane('y', H * 0.34 + 0.08, H * 0.34 + 0.77, 18, 32),
      } : null,
      // A bordered field reads as a rug; a flat rectangle reads as painted concrete.
      rug: room.kind === 'shop' || room.kind === 'jail' ? null : (() => {
        const [rx, ry, rw, rd] = [W * 0.5 - 1, H * 0.52 - 0.7, 2, 1.4];
        return {
          outer: box(rx, ry, rw, rd, 0, 0).top,
          inner: box(rx + 0.18, ry + 0.13, rw - 0.36, rd - 0.26, 0, 0).top,
        };
      })(),
      lamps: [
        { x: W * 0.3, y: H * 0.45 },
        { x: W * 0.7, y: H * 0.6 },
      ].map((lamp) => ({ ...lamp, s: worldToScreen(lamp.x, lamp.y) })),
    };
  }, [W, H, room.kind]);
  return <Group>
    <Path path={geometry.surround.top} color="#23272e" />
    <Path path={geometry.surround.left} color="#171a20" />
    <Path path={geometry.surround.right} color="#1c2026" />
    <Path path={geometry.floor} color={p.floor} />
    {room.kind === 'home' && Array.from({ length: H }, (_, row) => (
      <Path key={`plank${row}`} path={box(0, row, W, 0.5, 0, 0).top} color={p.floorAlt} opacity={row % 2 ? 0.55 : 0.25} />
    ))}
    {geometry.lines.map((line, i) => <Path key={`line${i}`} path={line} color={p.grout} style="stroke" strokeWidth={1} />)}
    {geometry.rug && <Group>
      <Path path={geometry.rug.outer} color={p.rug} opacity={0.7} />
      <Path path={geometry.rug.inner} color={shade(p.rug, 24)} opacity={0.85} />
    </Group>}
    {geometry.edgeShadow.map((shadow, i) => <Path key={`edge${i}`} path={shadow} color="#000" opacity={0.14} />)}
    {geometry.walls.map((wall, i) => <Group key={`wall${i}`}>
      <Path path={i === 0 ? wall.left : wall.right} color={p.wall} />
      <Path path={i === 0 ? wall.left : wall.right} color="#000" opacity={0.1} />
      <Path path={wall.top} color={p.wallDark} />
      <Path path={i === 0 ? wall.right : wall.left} color={p.wallDark} />
    </Group>)}
    {/* Baseboard + a shadow where the wall meets the floor. */}
    <Path path={polygon([iso(0, 0, 0), iso(W, 0, 0), iso(W, 0, 5), iso(0, 0, 5)])} color={p.trim} opacity={0.75} />
    <Path path={polygon([iso(0, 0, 0), iso(0, H, 0), iso(0, H, 5), iso(0, 0, 5)])} color={p.trim} opacity={0.6} />
    {geometry.window && <>
      <Path path={geometry.window.glass} color="#bcdcef" />
      <Path path={geometry.window.glass} color="#7fb6d8" opacity={0.5} />
      <Path path={geometry.window.sill} color="#f2f0e6" />
      <Path path={geometry.window.head} color={p.wallDark} />
    </>}
    {geometry.picture && <>
      <Path path={geometry.picture.frame} color="#6b543a" />
      <Path path={geometry.picture.art} color="#7fa37c" />
    </>}
    {geometry.lamps.map((lamp, i) => <Circle key={`lamp${i}`} cx={lamp.s.x} cy={lamp.s.y} r={78}>
      <RadialGradient c={lamp.s} r={78} colors={['rgba(255,226,168,0.26)', 'rgba(255,226,168,0)']} />
    </Circle>)}
  </Group>;
});

/** Doorway, service pips and the guard's keys. Drawn last: the low front ledges would clip them. */
const Markers = memo(function Markers({ room, keys }: { room: InteriorRoom; keys: { x: number; y: number } | null }) {
  const geometry = useMemo(() => {
    const exit = worldToScreen(room.exit.x, room.exit.y);
    const service = worldToScreen(room.service.x, room.service.y);
    return {
      exit,
      arrow: polygon([
        { x: exit.x - 7, y: exit.y - 2 }, { x: exit.x + 7, y: exit.y - 2 }, { x: exit.x, y: exit.y + 7 },
      ]),
      service,
      keys: keys ? worldToScreen(keys.x, keys.y) : null,
    };
  }, [room, keys]);
  return <Group>
    <Circle cx={geometry.exit.x} cy={geometry.exit.y} r={13} color="#69d6a2" opacity={0.4} />
    <Path path={geometry.arrow} color="#d7ffdf" />
    <Circle cx={geometry.service.x} cy={geometry.service.y} r={10} color="#e8c379" style="stroke" strokeWidth={2.5} />
    <Circle cx={geometry.service.x} cy={geometry.service.y} r={4} color="#e8c379" opacity={0.7} />
    {geometry.keys && <>
      <Circle cx={geometry.keys.x} cy={geometry.keys.y} r={9} color="#ffd479" opacity={0.35} />
      <Circle cx={geometry.keys.x} cy={geometry.keys.y} r={3.4} color="#ffd479" style="stroke" strokeWidth={2} />
      <Path path={polygon([
        { x: geometry.keys.x + 2, y: geometry.keys.y }, { x: geometry.keys.x + 9, y: geometry.keys.y + 3 },
      ])} color="#ffd479" style="stroke" strokeWidth={2} />
    </>}
  </Group>;
});

/** The two camera-side walls: low ledges, with a doorway cut where the exit is. */
const FrontSills = memo(function FrontSills({ room }: { room: InteriorRoom }) {
  const W = room.map.worldW;
  const H = room.map.worldH;
  const p = PALETTES[room.kind];
  const geometry = useMemo(() => {
    const door = 0.85;
    const from = Math.max(0, room.exit.x - door);
    const to = Math.min(W, room.exit.x + door);
    return {
      right: box(W, 0, WALL_T, H, 0, SILL_H),
      leftA: box(0, H, from, WALL_T, 0, SILL_H),
      leftB: box(to, H, W - to, WALL_T, 0, SILL_H),
      mat: box(room.exit.x - 0.65, H - 0.55, 1.3, 0.55, 0, 1.2).top,
      matEdge: polygon([
        iso(room.exit.x - 0.55, H - 0.47), iso(room.exit.x + 0.55, H - 0.47),
        iso(room.exit.x + 0.55, H - 0.08), iso(room.exit.x - 0.55, H - 0.08),
      ]),
    };
  }, [W, H, room.exit.x, room.kind]);
  return <Group>
    <Path path={geometry.mat} color="#5f4d38" />
    <Path path={geometry.matEdge} color="#8f7856" style="stroke" strokeWidth={1} />
    {[geometry.right, geometry.leftA, geometry.leftB].map((sill, i) => <Group key={i}>
      <Path path={sill.foot} color="#20242a" />
      <Path path={sill.top} color={p.wallDark} />
      <Path path={sill.left} color={p.wall} />
      <Path path={sill.right} color={p.wall} />
      {/* The face that looks out of the building: the screen corners see past the
          low ledge, so it has to read as shade rather than more floor. */}
      <Path path={i === 0 ? sill.right : sill.left} color="#000" opacity={0.52} />
    </Group>)}
  </Group>;
});

export function InteriorLayer({ game, room }: { game: GameState; room: InteriorRoom }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const iv = setInterval(() => setTick((n) => n + 1), 80);
    return () => clearInterval(iv);
  }, []);
  type Entry = { key: string; depth: number; item: Furniture | null; sprite: string | null };
  const items: Entry[] = [];
  for (const item of room.furniture) {
    // Cela destrancada some com a grade: é o JailSystem que manda na passagem.
    if (item.kind === 'bars' && game.jail.gateOpen(Number(item.id.replace(/\D/g, '')))) continue;
    // A linha frontal das celas é larga e baixa: pela regra do canto próximo ela passaria
    // por cima de quem está do lado de fora dela. O centro da peça é o que a câmera vê.
    const cellFront = room.kind === 'jail' && (item.kind === 'bars' || item.kind === 'block')
      && item.y >= JAIL_FRONT_Y - 0.01;
    items.push({
      key: item.id,
      depth: cellFront ? item.x + item.w / 2 + item.y + item.d / 2 : item.x + item.y + item.w + item.d,
      item,
      sprite: null,
    });
  }
  // Preso e guarda são entities da sala: entram na mesma ordenação por profundidade.
  if (room.kind === 'jail') {
    for (const inmate of game.jail.occupants) {
      items.push({ key: `inmate:${inmate.id}`, depth: inmate.x + inmate.y, item: null, sprite: `inmate:${inmate.id}` });
    }
  }
  // Morador, atendente e cliente: corpo de pedestre, vida de dentro da sala.
  for (const occupant of game.crowd.list) {
    items.push({
      key: `people:${occupant.id}`,
      depth: occupant.x + occupant.y,
      item: null,
      sprite: `people:${occupant.id}`,
    });
  }
  items.push({ key: 'player', depth: game.player.x + game.player.y + 0.1, item: null, sprite: 'player' });
  items.sort((a, b) => a.depth - b.depth);
  return <Group>
    <RoomShell room={room} />
    {items.map(({ key, item, sprite }) => item
      ? <FurnitureSprite key={key} item={item} />
      : <EntitySprite key={key} id={sprite!} />)}
    <FrontSills room={room} />
    <Markers room={room} keys={room.kind === 'jail' ? game.jail.keysOnFloor : null} />
  </Group>;
}

export function EntranceMarkers({ game }: { game: GameState }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const iv = setInterval(() => setTick((n) => n + 1), GAME_CONFIG.ENTITY_CULL_MS);
    return () => clearInterval(iv);
  }, []);
  const view = game.fog.view(game);
  return <Group>
    {game.interiors.entrances.map((door) => {
      const p = worldToScreen(door.x, door.y, game.map.heightAt(door.x, door.y));
      if (!game.fog.intersects(view, p.x - 10, p.y - 10, 20, 20)) return null;
      return <Group key={door.id}>
        <Circle cx={p.x} cy={p.y} r={10} color="#86d4c2" opacity={0.35} />
        <Path path={polygon([{ x: p.x - 5, y: p.y - 6 }, { x: p.x + 5, y: p.y - 6 }, { x: p.x, y: p.y + 3 }])} color="#b5f0da" />
      </Group>;
    })}
  </Group>;
}
