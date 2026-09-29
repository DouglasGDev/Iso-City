import { Skia, PaintStyle, type SkCanvas } from '@shopify/react-native-skia';
import type { CityMapData } from '../data/maps/city';
import { worldToScreen } from '../world/IsoUtils';

const asphalt = Skia.Paint();
asphalt.setColor(Skia.Color('#34383e'));
// Estrada de terra das reservas: o mesmo traçado, só que sem asfalto nem tinta.
const earth = Skia.Paint();
earth.setColor(Skia.Color('#96805c'));
const earthEdge = Skia.Paint();
earthEdge.setColor(Skia.Color('#7a6746'));
earthEdge.setStyle(PaintStyle.Stroke);
earthEdge.setStrokeWidth(2);
earthEdge.setAntiAlias(true);
const deck = Skia.Paint();
deck.setColor(Skia.Color('#454b52'));
const curb = Skia.Paint();
curb.setColor(Skia.Color('#b6bac0'));
curb.setStyle(PaintStyle.Stroke);
curb.setStrokeWidth(2);
curb.setAntiAlias(true);
const marking = Skia.Paint();
marking.setColor(Skia.Color('#e9ddb0'));
marking.setStyle(PaintStyle.Stroke);
marking.setStrokeWidth(1.5);
marking.setAntiAlias(true);
const crossing = Skia.Paint();
crossing.setColor(Skia.Color('#ecebe5'));
crossing.setStyle(PaintStyle.Stroke);
crossing.setStrokeWidth(4);
crossing.setAntiAlias(true);

export function drawRoad(canvas: SkCanvas, data: CityMapData, tx: number, ty: number) {
  const tile = data.tiles[ty * data.tilesW + tx];
  const road = (x: number, y: number) => x >= 0 && y >= 0 && x < data.tilesW && y < data.tilesH
    && data.tiles[y * data.tilesW + x].kind === 'road';
  const path = Skia.Path.Make();
  const corners = [[tx, ty], [tx + 1, ty], [tx + 1, ty + 1], [tx, ty + 1]];
  corners.forEach(([x, y], i) => {
    const p = worldToScreen(x, y);
    if (i === 0) path.moveTo(p.x, p.y);
    else path.lineTo(p.x, p.y);
  });
  path.close();
  const dirt = tile.key.includes('dirt');
  canvas.drawPath(path, tile.bridge ? deck : dirt ? earth : asphalt);

  const line = (x1: number, y1: number, x2: number, y2: number, paint = dirt ? earthEdge : curb) => {
    const a = worldToScreen(x1, y1);
    const b = worldToScreen(x2, y2);
    canvas.drawLine(a.x, a.y, b.x, b.y, paint);
  };
  if (!road(tx, ty - 1)) line(tx, ty, tx + 1, ty);
  if (!road(tx + 1, ty)) line(tx + 1, ty, tx + 1, ty + 1);
  if (!road(tx, ty + 1)) line(tx, ty + 1, tx + 1, ty + 1);
  if (!road(tx - 1, ty)) line(tx, ty, tx, ty + 1);

  const pedestrian = tile.key.includes('pelican');
  if (pedestrian && tile.lane) {
    for (let i = 0; i < 5; i++) {
      const offset = 0.14 + i * 0.18;
      if (tile.lane === 'SE' || tile.lane === 'NW') line(tx + 0.1, ty + offset, tx + 0.9, ty + offset, crossing);
      else line(tx + offset, ty + 0.1, tx + offset, ty + 0.9, crossing);
    }
  } else if (!dirt) {
    if (tile.lane === 'NW' && road(tx, ty + 1)
      && data.tiles[(ty + 1) * data.tilesW + tx].lane === 'SE') {
      line(tx + 0.2, ty + 1, tx + 0.8, ty + 1, marking);
    }
    if (tile.lane === 'SW' && road(tx + 1, ty)
      && data.tiles[ty * data.tilesW + tx + 1].lane === 'NE') {
      line(tx + 1, ty + 0.2, tx + 1, ty + 0.8, marking);
    }
  }
}
