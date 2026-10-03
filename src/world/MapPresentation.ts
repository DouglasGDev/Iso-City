import type { Biome } from '../game/GameConfig';
import type { CityMapData } from '../data/maps/city';
import type { ExplorationSystem } from '../systems/ExplorationSystem';

export const MAP_COLORS = {
  background: '#0c141d', unknown: '#15212c', grid: '#22323f', border: '#334958',
  route: '#eabb72', visited: '#71dfc7', player: '#edfff9', police: '#7ebaff',
  mission: '#eabb72', destination: '#caacff', ammo: '#eda56e',
};
export const BIOME_LABEL: Record<Biome, string> = {
  downtown: 'Centro', commercial: 'Comércio', market: 'Mercado', residential: 'Residencial',
  suburb: 'Subúrbios', park: 'Parque', industrial: 'Zona industrial', docks: 'Porto',
  forest: 'Floresta', countryside: 'Campo', beach: 'Praia', pinewood: 'Pinhal', savanna: 'Savana',
  desert: 'Deserto',
};
const BIOME_RGB: Record<Biome, number[]> = {
  downtown: [49, 66, 77], commercial: [62, 69, 72], market: [70, 72, 63], residential: [45, 72, 67],
  suburb: [45, 75, 63], park: [37, 77, 59], industrial: [67, 65, 67], docks: [42, 69, 81],
  forest: [30, 61, 50], countryside: [58, 75, 54], beach: [143, 130, 96],
  pinewood: [31, 73, 71], savanna: [119, 101, 57], desert: [131, 118, 92],
};

export function isoMetrics(tilesW: number, tilesH: number) {
  return { ox: tilesH, imgW: tilesW + tilesH + 1, imgH: (tilesW + tilesH) / 2 + 1 };
}
export function mapPoint(x: number, y: number, tilesH: number) {
  return { x: x - y + tilesH, y: (x + y) / 2 };
}
export function makeProjectors(mapW: number, mapH: number, pad: number, tilesW: number, tilesH: number,
  zoom: number, panX: number, panY: number) {
  const { imgW, imgH } = isoMetrics(tilesW, tilesH);
  const fit = Math.min(Math.max(1, mapW - pad * 2) / imgW, Math.max(1, mapH - pad * 2) / imgH);
  const drawW = imgW * fit, drawH = imgH * fit;
  const originX = (mapW - drawW) / 2, originY = (mapH - drawH) / 2;
  const imgX = (originX - mapW / 2) * zoom + mapW / 2 + panX;
  const imgY = (originY - mapH / 2) * zoom + mapH / 2 + panY;
  const scale = fit * zoom;
  return {
    imgW, imgH, imgX, imgY, scale,
    worldToScreen(x: number, y: number) {
      const p = mapPoint(x, y, tilesH);
      return { x: imgX + p.x * scale, y: imgY + p.y * scale };
    },
    screenToWorld(sx: number, sy: number) {
      const ix = (sx - imgX) / scale - tilesH, iy = (sy - imgY) / scale;
      return { x: iy + ix / 2, y: iy - ix / 2 };
    },
  };
}

export function mapPolygon(x: number, y: number, w: number, h: number, tilesH: number) {
  return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]].map(([px, py], i) => {
    const p = mapPoint(px, py, tilesH);
    return `${i ? 'L' : 'M'}${p.x},${p.y}`;
  }).join(' ') + ' Z';
}

export function explorationPaths(exploration: ExplorationSystem) {
  const pathFor = (visited: boolean) => {
    const paths: string[] = [];
    for (let y = 0; y < exploration.height; y++) {
      let start = -1;
      for (let x = 0; x <= exploration.width; x++) {
        const selected = x < exploration.width && (visited ? exploration.isVisited(x, y) : exploration.isExplored(x, y));
        if (selected && start < 0) start = x;
        if (!selected && start >= 0) {
          paths.push(mapPolygon(start, y, x - start, 1, exploration.height));
          start = -1;
        }
      }
    }
    return paths.join(' ') || 'M0,0';
  };
  return { discovered: pathFor(false), visited: pathFor(true) };
}

export function radarPixels(data: CityMapData) {
  const resolution = 3;
  const { ox, imgW, imgH } = isoMetrics(data.tilesW, data.tilesH);
  const width = imgW * resolution, height = Math.ceil(imgH * resolution);
  const pixels = new Uint8Array(width * height * 4);
  const buildings = new Uint8Array(data.tilesW * data.tilesH);
  for (const b of data.buildings) {
    for (let y = Math.max(0, Math.floor(b.y - b.footprintW)); y < Math.min(data.tilesH, b.y); y++) {
      for (let x = Math.max(0, Math.floor(b.x - b.footprintW)); x < Math.min(data.tilesW, b.x); x++) buildings[y * data.tilesW + x] = 1;
    }
  }
  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      const ix = (px + 0.5) / resolution - ox, iy = (py + 0.5) / resolution;
      const wx = iy + ix / 2, wy = iy - ix / 2;
      const x = Math.floor(wx), y = Math.floor(wy);
      if (x < 0 || y < 0 || x >= data.tilesW || y >= data.tilesH) continue;
      const index = y * data.tilesW + x, t = data.tiles[index];
      let rgb = BIOME_RGB[t.biome];
      if (t.kind === 'water') rgb = [28, 55, 75];
      else if (t.kind === 'road') {
        // Na terra batida da reserva e no deque da ponte o que se lê é o material, e ele
        // manda antes do posto. No asfalto da cidade o que manda é a hierarquia: a
        // espinha clareia, a rua de bairro escurece, e o radar passa a mostrar por onde
        // se atravessa o mapa e por onde se entra só para morar.
        rgb = t.bridge ? [172, 159, 123] : t.key.includes('dirt') ? [118, 117, 94]
          : t.rank === 'highway' ? [200, 212, 216]
          : t.rank === 'street' ? [123, 137, 142]
          : t.rank === 'residential' ? [104, 116, 121]
          : [159, 174, 178];
      }
      else if (t.kind === 'concrete') rgb = [67, 83, 91];
      if (buildings[index] && t.kind !== 'road' && t.kind !== 'water') rgb = [94, 111, 119];
      const o = (py * width + px) * 4;
      pixels[o] = rgb[0]; pixels[o + 1] = rgb[1]; pixels[o + 2] = rgb[2]; pixels[o + 3] = 255;
    }
  }
  return { pixels, width, height };
}
