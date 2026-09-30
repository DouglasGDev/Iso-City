import { useEffect, useRef, useState, memo } from 'react';
import { PaintStyle, Picture, Skia, type SkCanvas, type SkPicture } from '@shopify/react-native-skia';
import { tileKey } from '../assets/AssetRegistry';
import { spriteStore } from '../assets/SpriteStore';
import { ELEVATION_PX, worldToScreen } from '../world/IsoUtils';
import { FOG } from '../systems/FogSystem';
import { GAME_CONFIG } from '../game/GameConfig';
import type { Biome } from '../game/GameConfig';
import type { GameState } from '../game/GameState';
import type { CityMapData } from '../data/maps/city';
import { drawRoad } from './RoadPainter';

function cameraCellKey(game: GameState): string {
  const cx = Math.round(game.camera.x * 2);
  const cy = Math.round(game.camera.y * 2);
  return `${cx},${cy},${game.camera.zoom},${Math.round(game.viewW)},${Math.round(game.viewH)}`;
}

/**
 * Face do terraço: o lado vertical do bloco que a elevação empurra para cima. A
 * cor é sempre a do próprio chão do tile (terra, areia, rocha, concreto), porque o
 * que se corta numa encosta é o terreno, não um muro pintado por cima dele.
 */
function facePaint(biome: Biome, rocky: boolean) {
  const paint = Skia.Paint();
  paint.setAntiAlias(false);
  const hex = rocky ? '#6f6b63'
    : biome === 'forest' || biome === 'pinewood' ? '#4a4230'
      : biome === 'countryside' ? '#5d5133'
        : biome === 'savanna' ? '#7a6640'
          : biome === 'desert' ? '#a08a5f'
            : biome === 'beach' || biome === 'docks' ? '#c9b184'
              : biome === 'park' ? '#4f5c39'
                : biome === 'industrial' ? '#7a7368' : '#8b8f96';
  paint.setColor(Skia.Color(hex));
  return paint;
}

/** A aresta iluminada no topo da face: dois pixels que separam um platô do outro. */
function rimPaint(biome: Biome, rocky: boolean) {
  const paint = Skia.Paint();
  paint.setStyle(PaintStyle.Stroke);
  paint.setStrokeWidth(2);
  paint.setAntiAlias(true);
  const hex = rocky ? '#8d8981'
    : biome === 'forest' || biome === 'pinewood' ? '#6a6046'
      : biome === 'beach' || biome === 'docks' ? '#e2cfa4'
        : biome === 'desert' ? '#c0a877' : '#a6a9b0';
  paint.setColor(Skia.Color(hex));
  return paint;
}

const PAINTS = new Map<string, ReturnType<typeof facePaint>>();

function paintFor(kind: 'face' | 'rim', biome: Biome, rocky: boolean) {
  const key = `${kind}:${biome}:${rocky ? 'r' : 's'}`;
  let paint = PAINTS.get(key);
  if (!paint) {
    paint = kind === 'face' ? facePaint(biome, rocky) : rimPaint(biome, rocky);
    PAINTS.set(key, paint);
  }
  return paint;
}

/**
 * Segunda passada, depois de todo o chão: a face que sobra onde o vizinho de frente
 * (leste/sul na tela) está mais baixo. Uma passada só não dá — o losango do vizinho
 * mais baixo é desenhado depois e cobriria o paredão inteiro.
 */
function drawFaces(canvas: SkCanvas, data: CityMapData, tx: number, ty: number) {
  const W = data.tilesW;
  const i = ty * W + tx;
  const h = data.heights[i];
  const biome = data.tiles[i].biome;
  for (const [dx, dy] of [[1, 0], [0, 1]] as const) {
    const nx = tx + dx;
    const ny = ty + dy;
    if (nx >= data.tilesW || ny >= data.tilesH) continue;
    const drop = h - data.heights[ny * W + nx];
    if (drop <= 0) continue;
    const rocky = drop >= GAME_CONFIG.TERRAIN_CLIFF_LEVELS * GAME_CONFIG.TERRAIN_LEVEL_TILES;
    // Os dois cantos da aresta compartilhada, projetados na altura do tile alto.
    const [a, b] = dy === 0
      ? [worldToScreen(tx + 1, ty, h), worldToScreen(tx + 1, ty + 1, h)]
      : [worldToScreen(tx, ty + 1, h), worldToScreen(tx + 1, ty + 1, h)];
    const bottom = drop * ELEVATION_PX;
    const path = Skia.Path.Make();
    path.moveTo(a.x, a.y);
    path.lineTo(b.x, b.y);
    path.lineTo(b.x, b.y + bottom);
    path.lineTo(a.x, a.y + bottom);
    path.close();
    canvas.drawPath(path, paintFor('face', biome, rocky));
    canvas.drawLine(a.x, a.y, b.x, b.y, paintFor('rim', biome, rocky));
  }
}

function bakeVisibleTiles(game: GameState): SkPicture {
  const { data } = game.map;
  const W = data.tilesW;
  const view = game.fog.view(game);
  const aabb = game.fog.worldBounds(view);
  // O AABB já vem dilatado pelo relevo (FogSystem.worldBounds): o tile elevado é
  // desenhado na posição plana de quem está `h` tiles mais ao fundo.
  const climb = GAME_CONFIG.TERRAIN_MAX_LEVEL * GAME_CONFIG.TERRAIN_LEVEL_TILES;
  const tx0 = Math.max(0, Math.floor(aabb.minX - 1));
  const tx1 = Math.min(W - 1, Math.ceil(aabb.maxX));
  const ty0 = Math.max(0, Math.floor(aabb.minY - 1));
  const ty1 = Math.min(data.tilesH - 1, Math.ceil(aabb.maxY));

  const fallback =
    spriteStore[tileKey('tile_ground_grass')] ||
    spriteStore[tileKey('tile_ground_dirt')] ||
    spriteStore[tileKey('tile_ground_concrete')];

  const recorder = Skia.PictureRecorder();
  const rx = view.radiusX + FOG.padding + 128;
  const ry = view.radiusY + FOG.padding + 64 + climb * ELEVATION_PX;
  const canvas = recorder.beginRecording(Skia.XYWHRect(view.x - rx, view.y - ry, rx * 2, ry * 2));
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      const h = data.heights[ty * W + tx] ?? 0;
      const p = worldToScreen(tx, ty, h);
      if (!game.fog.intersects(view, p.x - 65, p.y - 2, 130, 68 + h * ELEVATION_PX)) continue;
      const t = data.tiles[ty * W + tx];
      if (t.kind === 'road') {
        drawRoad(canvas, data, tx, ty);
        continue;
      }
      const img = spriteStore[tileKey(t.key)] || fallback;
      if (!img) continue;
      canvas.drawImage(img, p.x - 64, p.y);
    }
  }
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) drawFaces(canvas, data, tx, ty);
  }
  const picture = recorder.finishRecordingAsPicture();
  recorder.dispose();
  return picture;
}

export const GroundLayer = memo(function GroundLayer({ game }: { game: GameState }) {
  const [picture, setPicture] = useState<SkPicture | null>(null);
  const lastKey = useRef('');

  useEffect(() => {
    lastKey.current = '';
    const tick = () => {
      const key = cameraCellKey(game);
      if (key === lastKey.current) return;
      lastKey.current = key;
      setPicture(bakeVisibleTiles(game));
    };
    tick();
    const iv = setInterval(tick, GAME_CONFIG.BAKE_INTERVAL_MS);
    return () => clearInterval(iv);
  }, [game]);

  if (!picture) return null;
  return <Picture picture={picture} />;
});
