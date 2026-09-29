import { useEffect, useRef, useState, memo } from 'react';
import { Picture, Skia, type SkPicture } from '@shopify/react-native-skia';
import { tileKey } from '../assets/AssetRegistry';
import { spriteStore } from '../assets/SpriteStore';
import { worldToScreen } from '../world/IsoUtils';
import { FOG } from '../systems/FogSystem';
import { GAME_CONFIG } from '../game/GameConfig';
import type { GameState } from '../game/GameState';
import { drawRoad } from './RoadPainter';

function cameraCellKey(game: GameState): string {
  const cx = Math.round(game.camera.x * 2);
  const cy = Math.round(game.camera.y * 2);
  return `${cx},${cy},${game.camera.zoom},${Math.round(game.viewW)},${Math.round(game.viewH)}`;
}

function bakeVisibleTiles(game: GameState): SkPicture {
  const { data } = game.map;
  const W = data.tilesW;
  const view = game.fog.view(game);
  const aabb = game.fog.worldBounds(view);
  const tx0 = Math.max(0, Math.floor(aabb.minX - 1));
  const tx1 = Math.min(W - 1, Math.ceil(aabb.maxX + 1));
  const ty0 = Math.max(0, Math.floor(aabb.minY - 1));
  const ty1 = Math.min(data.tilesH - 1, Math.ceil(aabb.maxY + 1));

  const fallback =
    spriteStore[tileKey('tile_ground_grass')] ||
    spriteStore[tileKey('tile_ground_dirt')] ||
    spriteStore[tileKey('tile_ground_concrete')];

  const recorder = Skia.PictureRecorder();
  const rx = view.radiusX + FOG.padding + 128;
  const ry = view.radiusY + FOG.padding + 64;
  const canvas = recorder.beginRecording(Skia.XYWHRect(view.x - rx, view.y - ry, rx * 2, ry * 2));
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      const p = worldToScreen(tx, ty);
      if (!game.fog.intersects(view, p.x - 65, p.y - 2, 130, 68)) continue;
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
