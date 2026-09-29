export interface ExplorationContext {
  position: { x: number; y: number };
  outdoors: boolean;
}

const REVEAL_RADIUS = 8;
const MAX_TRAIL_DISTANCE = 3;
const TRAIL_STEP = 0.5;

/** Discoveries: unknown (0), explored (1), physically visited (2). Persistable via serialize/restore. */
export class ExplorationSystem {
  private readonly tiles: Uint8Array;
  private explored = 0;
  private visited = 0;
  private revision = 0;
  private previous: { x: number; y: number } | null = null;

  constructor(public readonly width: number, public readonly height: number) {
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 0 || height < 0
      || !Number.isSafeInteger(width * height)) {
      throw new RangeError('Exploration dimensions must be non-negative safe integers');
    }
    this.tiles = new Uint8Array(width * height);
  }

  get exploredCount(): number { return this.explored; }
  get visitedCount(): number { return this.visited; }
  get percent(): number { return this.tiles.length ? this.explored / this.tiles.length * 100 : 0; }
  get version(): number { return this.revision; }

  isExplored(x: number, y: number): boolean {
    return this.containsCell(x, y) && this.tiles[y * this.width + x] > 0;
  }

  isVisited(x: number, y: number): boolean {
    return this.containsCell(x, y) && this.tiles[y * this.width + x] === 2;
  }

  /** Disconnect sampling for teleports/room transitions without losing discoveries. */
  breakTrail(): void {
    this.previous = null;
  }

  /**
   * Run-length snapshot para o save: `WxH:v.run,...` com contagens em base 36.
   * Sem base64 porque o Hermes não garante btoa; um mapa recém-começado ocupa ~20 bytes.
   */
  serialize(): string {
    const tiles = this.tiles;
    let out = '';
    for (let i = 0; i < tiles.length;) {
      const value = tiles[i];
      let run = 1;
      while (i + run < tiles.length && tiles[i + run] === value) run++;
      out += `${out.length ? ',' : ''}${value}.${run.toString(36)}`;
      i += run;
    }
    return `${this.width}x${this.height}:${out}`;
  }

  /** Recria a grade salva no sistema já dimensionado; descarta se o tamanho não bater. */
  restore(data: string): boolean {
    const header = data.slice(0, data.indexOf(':'));
    const [w, h] = header.split('x');
    if (Number(w) !== this.width || Number(h) !== this.height) return false;
    const body = data.slice(header.length + 1);
    const tiles = this.tiles;
    tiles.fill(0);
    this.explored = 0;
    this.visited = 0;
    let index = 0;
    for (const group of body.split(',')) {
      const dot = group.indexOf('.');
      const value = Number(group.slice(0, dot));
      const run = parseInt(group.slice(dot + 1), 36);
      if (!Number.isInteger(value) || !Number.isInteger(run) || run < 1) continue;
      for (let k = 0; k < run && index < tiles.length; k++, index++) {
        tiles[index] = value;
        if (value > 0) this.explored++;
        if (value === 2) this.visited++;
      }
      if (index >= tiles.length) break;
    }
    this.previous = null;
    this.revision++;
    return true;
  }

  update({ position: { x, y }, outdoors }: ExplorationContext): boolean {
    if (!outdoors || !Number.isFinite(x) || !Number.isFinite(y)
      || x < 0 || y < 0 || x >= this.width || y >= this.height) {
      this.breakTrail();
      return false;
    }
    const tx = Math.floor(x), ty = Math.floor(y);
    const previous = this.previous;
    // Copy coordinates: the caller may mutate its player object between updates.
    this.previous = { x, y };
    if (previous && Math.floor(previous.x) === tx && Math.floor(previous.y) === ty) return false;

    let changed = false;
    if (previous) {
      const dx = x - previous.x, dy = y - previous.y;
      const distance = Math.hypot(dx, dy);
      // Only interpolate ordinary movement; long jumps never discover a corridor.
      if (distance <= MAX_TRAIL_DISTANCE) {
        const steps = Math.ceil(distance / TRAIL_STEP);
        for (let i = 1; i < steps; i++) {
          const sx = Math.floor(previous.x + dx * i / steps);
          const sy = Math.floor(previous.y + dy * i / steps);
          if (this.visitCell(sx, sy)) changed = true;
        }
      }
    }
    if (this.visitCell(tx, ty)) changed = true;
    if (changed) this.revision++;
    return changed;
  }

  private containsCell(x: number, y: number): boolean {
    return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  private visitCell(tx: number, ty: number): boolean {
    const index = ty * this.width + tx;
    // A visited cell has already revealed its entire radius, including on revisits.
    if (this.tiles[index] === 2) return false;
    if (this.tiles[index] === 0) this.explored++;
    this.tiles[index] = 2;
    this.visited++;

    const minX = Math.max(0, tx - REVEAL_RADIUS), maxX = Math.min(this.width - 1, tx + REVEAL_RADIUS);
    const minY = Math.max(0, ty - REVEAL_RADIUS), maxY = Math.min(this.height - 1, ty + REVEAL_RADIUS);
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        // Tile-center distances from (floor(position.x) + .5, floor(position.y) + .5).
        if ((x - tx) ** 2 + (y - ty) ** 2 > REVEAL_RADIUS ** 2) continue;
        const nearby = y * this.width + x;
        if (this.tiles[nearby] === 0) {
          this.tiles[nearby] = 1;
          this.explored++;
        }
      }
    }
    return true;
  }
}
