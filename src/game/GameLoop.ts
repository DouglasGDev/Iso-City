import { GAME_CONFIG } from './GameConfig';
import type { GameState } from './GameState';

export interface DrawFrame {
  (dt: number): void;
}

export class GameLoop {
  private running = false;
  private lastTime = 0;
  private acc = 0;
  private rafId = 0;
  private onFrame?: DrawFrame;

  constructor(private game: GameState) {}

  start(onFrame: DrawFrame) {
    if (this.running) return;
    this.running = true;
    this.onFrame = onFrame;
    this.lastTime = performance.now();
    this.acc = 0;
    const tick = (now: number) => {
      if (!this.running) return;
      let dt = (now - this.lastTime) / 1000;
      this.lastTime = now;
      if (dt > GAME_CONFIG.MAX_DT) dt = GAME_CONFIG.MAX_DT;
      this.acc += dt;
      let steps = 0;
      while (this.acc >= GAME_CONFIG.FIXED_DT && steps < 4) {
        this.game.update(GAME_CONFIG.FIXED_DT);
        this.acc -= GAME_CONFIG.FIXED_DT;
        steps++;
      }
      this.onFrame?.(dt);
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.rafId);
    this.onFrame = undefined;
  }
}
