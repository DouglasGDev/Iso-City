import type { Biome } from '../game/GameConfig';
import type { WorldAabb } from '../world/Visibility';

export interface FogEnvironment {
  /** Normalized day: 0 = midnight, 0.5 = noon (DayNightSystem.t). */
  timeOfDay: number;
  rain: number;
  /** 0..1 de céu coberto: escurece a cena sem molhar nada. */
  cover?: number;
  /** Clima severo fecha o céu além das nuvens da frente. */
  dark?: number;
  /** Neve: a borda clareia e fecha em vez de virar cinza de chuva. */
  snow?: boolean;
  biome: Biome;
}
/** Immutable publication: assign the whole object to one SharedValue each game tick. */
export interface FogSnapshot {
  readonly color: string;
  readonly colors: string[];
  readonly positions: number[];
  readonly clarity: number;
}

const clamp = (x: number) => Math.max(0, Math.min(1, x));
function target({ timeOfDay, rain, cover, dark, snow, biome }: FogEnvironment) {
  const t = Number.isFinite(timeOfDay) ? ((timeOfDay % 1) + 1) % 1 : 0.5;
  // Neve usa a mesma intensidade da chuva, mas tinta para branco frio em vez de cinza molhado.
  const wet = !snow && Number.isFinite(rain) ? clamp(rain) : 0;
  const white = snow && Number.isFinite(rain) ? clamp(rain) : 0;
  const cloud = Number.isFinite(cover) ? clamp(cover ?? 0) : 0;
  // O perigo fecha o céu por cima das nuvens: menos luz do dia, mais parede de névoa.
  const gloom = Number.isFinite(dark) ? clamp(dark ?? 0) : 0;
  const daylight = (t < 0.2 || t > 0.86 ? 0 : t < 0.3 ? (t - 0.2) / 0.1 : t < 0.72 ? 1 : (0.86 - t) / 0.14)
    * (1 - cloud * 0.55) * (1 - gloom * 0.5);
  const warm = Math.max(0, 1 - Math.abs(t - 0.27) / 0.07, 1 - Math.abs(t - 0.8) / 0.08);
  // Tinted shade rather than a pale gray wall. Match the local landscape at the opaque rim,
  // but keep hue muted and dark: a saturated mid-tone washes the whole visible scene.
  const base = biome === 'pinewood' ? [34, 56, 52] : biome === 'forest' || biome === 'park' ? [44, 60, 46]
    : biome === 'savanna' ? [96, 80, 48] : biome === 'countryside' ? [66, 76, 50]
      : biome === 'desert' ? [104, 90, 62]
        : biome === 'beach' || biome === 'docks' ? [56, 86, 90]
          : biome === 'industrial' ? [68, 62, 54] : [50, 66, 70];
  const night = [15, 27, 43];
  const rgb = base.map((v, i) => (night[i] + (v - night[i]) * daylight) * (1 - wet * 0.22 - white * 0.12)
    + [24, 7, -5][i] * warm + [0, 5, 10][i] * wet + [30, 34, 38][i] * white);
  const wooded = biome === 'forest' || biome === 'pinewood';
  return { rgb, clarity: 0.60 - wet * 0.09 - white * 0.11 - cloud * 0.03 - gloom * 0.05
    - (1 - daylight) * 0.035 - (wooded ? 0.025 : 0) };
}
function publish(rgb: number[], clarity: number): FogSnapshot {
  const [r, g, b] = rgb.map((v) => Math.round(Math.max(0, Math.min(255, v))));
  const color = '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
  return {
    color, clarity,
    positions: [0, clarity, clarity + (1 - clarity) * 0.32, clarity + (1 - clarity) * 0.62,
      clarity + (1 - clarity) * 0.84, 1],
    colors: [0, 0, 0.10, 0.32, 0.72].map((a) => `rgba(${r},${g},${b},${a})`).concat(color),
  };
}
const INITIAL = target({ timeOfDay: 0.5, rain: 0, biome: 'countryside' });
export const FOG = { ...publish(INITIAL.rgb, INITIAL.clarity), padding: 112 };

export interface FogContext {
  camera: { x: number; y: number; zoom: number };
  viewW: number;
  viewH: number;
}
export interface FogView { x: number; y: number; radiusX: number; radiusY: number }

/** Fixed outer envelope: weather changes inner clarity, NEVER the culling/bake footprint.
 * Small radius increase + much wider transparent center, while retaining a hidden opaque apron.
 */
export function fogRadii(width: number, height: number, zoom: number) {
  'worklet';
  return { x: Math.min(width * 0.495, 520 * zoom), y: Math.min(height * 0.59, 310 * zoom) };
}

export class FogSystem {
  private rgb = [...INITIAL.rgb];
  private clarity = INITIAL.clarity;
  private published: FogSnapshot = FOG;

  get snapshot(): FogSnapshot { return this.published; }

  /** Smooth biome/weather transitions; pause/invalid dt does not publish or advance. */
  update(dt: number, environment: FogEnvironment): FogSnapshot {
    if (!Number.isFinite(dt) || dt <= 0) return this.published;
    const next = target(environment);
    const blend = 1 - Math.exp(-Math.min(dt, 0.25) * 1.8);
    this.rgb = this.rgb.map((v, i) => v + (next.rgb[i] - v) * blend);
    this.clarity += (next.clarity - this.clarity) * blend;
    this.published = publish(this.rgb, this.clarity);
    return this.published;
  }

  view({ camera, viewW, viewH }: FogContext): FogView {
    const radius = fogRadii(viewW, viewH, camera.zoom);
    return { x: (camera.x - camera.y) * 64, y: (camera.x + camera.y) * 32,
      radiusX: radius.x / camera.zoom, radiusY: radius.y / camera.zoom };
  }

  intersects(view: FogView, x: number, y: number, width: number, height: number, padding = FOG.padding): boolean {
    // Keep a hidden apron for camera motion, shake and the interval between culling passes.
    const dx = Math.max(x - padding - view.x, 0, view.x - x - width - padding) / view.radiusX;
    const dy = Math.max(y - padding - view.y, 0, view.y - y - height - padding) / view.radiusY;
    return dx * dx + dy * dy <= 1;
  }

  worldBounds(view: FogView): WorldAabb {
    const x = view.x / 128 + view.y / 64;
    const y = view.y / 64 - view.x / 128;
    const extent = Math.hypot(view.radiusX / 128, view.radiusY / 64) + FOG.padding / 128 + FOG.padding / 64 + 1;
    return { minX: x - extent, maxX: x + extent, minY: y - extent, maxY: y + extent };
  }
}
