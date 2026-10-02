import { Skia, PaintStyle, type SkCanvas, type SkPaint, type SkPath } from '@shopify/react-native-skia';
import type { CityMapData } from '../data/maps/city';
import { worldToScreen } from '../world/IsoUtils';

// Tintas criadas no primeiro traçado, não na importação do módulo: no aparelho o
// bundle inteiro é avaliado antes de qualquer tela, e um `Skia.Paint()` no topo faz
// uma Skia desatualizada derrubar o boot antes de vermos o erro.
interface RoadPaints {
  asphalt: SkPaint;
  earth: SkPaint;
  earthEdge: SkPaint;
  deck: SkPaint;
  curb: SkPaint;
  marking: SkPaint;
  crossing: SkPaint;
}

let paints: RoadPaints | null = null;
function roadPaints(): RoadPaints {
  if (paints) return paints;
  const stroke = (color: string, width: number) => {
    const p = Skia.Paint();
    p.setColor(Skia.Color(color));
    p.setStyle(PaintStyle.Stroke);
    p.setStrokeWidth(width);
    p.setAntiAlias(true);
    return p;
  };
  const fill = (color: string) => {
    const p = Skia.Paint();
    p.setColor(Skia.Color(color));
    return p;
  };
  paints = {
    asphalt: fill('#34383e'),
    // Estrada de terra das reservas: o mesmo traçado, só que sem asfalto nem tinta.
    earth: fill('#96805c'),
    earthEdge: stroke('#7a6746', 2),
    deck: fill('#454b52'),
    curb: stroke('#b6bac0', 2),
    marking: stroke('#e9ddb0', 1.5),
    crossing: stroke('#ecebe5', 4),
  };
  return paints;
}

/**
 * O losango do tile é sempre o mesmo objeto rebobinado. Um `Skia.Path.Make()` por tile a cada
 * bake é memória wasm que a web não devolve ao heap, e o bake repete até dez vezes por segundo
 * enquanto o carro anda — foi assim que o canvaskit estourou. O `rewind()` mantém o
 * armazenamento reservado; o traço já registrado na picture não é tocado (Skia é copy-on-write).
 */
let losango: SkPath | null = null;

/**
 * O asfalto pisa a mesma quad do chão: cada canto do tile sobe na cota do próprio
 * vértice, senão a rua atravessaria a encosta como um papel esticado por cima dela.
 */
export function drawRoad(canvas: SkCanvas, data: CityMapData, tx: number, ty: number,
  vA: number, vB: number, vC: number, vD: number) {
  const { asphalt, earth, earthEdge, deck, curb, marking, crossing } = roadPaints();
  const tileIndex = ty * data.tilesW + tx;
  const tile = data.tiles[tileIndex];
  const surf = (x: number, y: number) => {
    const fx = x - tx;
    const fy = y - ty;
    return vA * (1 - fx) * (1 - fy) + vB * fx * (1 - fy) + vD * (1 - fx) * fy + vC * fx * fy;
  };
  const road = (x: number, y: number) => x >= 0 && y >= 0 && x < data.tilesW && y < data.tilesH
    && data.tiles[y * data.tilesW + x].kind === 'road';
  const path = losango ??= Skia.Path.Make();
  path.rewind();
  const corners = [[tx, ty], [tx + 1, ty], [tx + 1, ty + 1], [tx, ty + 1]];
  corners.forEach(([x, y], i) => {
    const p = worldToScreen(x, y, surf(x, y));
    if (i === 0) path.moveTo(p.x, p.y);
    else path.lineTo(p.x, p.y);
  });
  path.close();
  const dirt = tile.key.includes('dirt');
  canvas.drawPath(path, tile.bridge ? deck : dirt ? earth : asphalt);

  const line = (x1: number, y1: number, x2: number, y2: number, paint = dirt ? earthEdge : curb) => {
    const a = worldToScreen(x1, y1, surf(x1, y1));
    const b = worldToScreen(x2, y2, surf(x2, y2));
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
