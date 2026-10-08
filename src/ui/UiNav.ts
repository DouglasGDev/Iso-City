import type { HardwareMode, InputUiAction } from '../game/InputState';

/** Telas que congelam a simulação e podem ser percorridas por teclado/controle. */
export type UiSurface = 'main' | 'pause' | 'shop' | 'departures' | 'map' | 'cheat';

export interface UiItem {
  id: string;
  disabled?: boolean;
  onSelect: () => void;
}

export interface UiSurfaceSpec {
  /** Lida na hora da ação: o cardápio pode mudar de itens sem registrar a tela de novo. */
  items: () => UiItem[];
  /** Ações que andam no foco. O mapa não usa nenhuma, porque lá as setas movem a câmera. */
  move?: InputUiAction[];
  onAction?: (action: InputUiAction) => void;
  onBack?: () => void;
}

/** Com loja e pausa abertas ao mesmo tempo, quem recebe o toque primeiro é quem está por cima. */
const PRIORITY: UiSurface[] = ['cheat', 'map', 'departures', 'shop', 'pause', 'main'];
const MOVE: InputUiAction[] = ['up', 'down', 'left', 'right'];
const STEP: Partial<Record<InputUiAction, number>> = { up: -1, left: -1, down: 1, right: 1, prev: -1, next: 1 };

/**
 * Dono do foco dos menus. Não conhece React nem GameState: as telas registram um spec
 * e o adaptador de hardware chama `dispatch`, que decide entre mover, confirmar ou delegar.
 */
export class UiNavStore {
  private specs = new Map<UiSurface, UiSurfaceSpec>();
  private focus = new Map<UiSurface, string>();
  private kind: HardwareMode = 'touch';
  private listeners = new Set<() => void>();

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  };

  private notify() {
    for (const cb of [...this.listeners]) cb();
  }

  /** Como as telas estão sendo dirigidas; dita quais dicas de tecla aparecem nelas. */
  inputKind(): HardwareMode {
    return this.kind;
  }

  setInputKind(mode: HardwareMode) {
    if (this.kind === mode) return;
    this.kind = mode;
    this.notify();
  }

  open(surface: UiSurface, spec: UiSurfaceSpec) {
    this.specs.set(surface, spec);
    const items = spec.items();
    const kept = this.focus.get(surface);
    if (!kept || !items.some((item) => item.id === kept)) this.focus.set(surface, items[0]?.id ?? '');
    this.notify();
  }

  close(surface: UiSurface) {
    if (!this.specs.delete(surface)) return;
    this.focus.delete(surface);
    this.notify();
  }

  active(): UiSurface | null {
    for (const surface of PRIORITY) if (this.specs.has(surface)) return surface;
    return null;
  }

  focusId(surface: UiSurface): string {
    return this.focus.get(surface) ?? '';
  }

  items(surface: UiSurface): UiItem[] {
    return this.specs.get(surface)?.items() ?? [];
  }

  /** Toque e mouse também movem o foco, para a régua visual nunca mentir. */
  step(surface: UiSurface, id: string) {
    if (!this.specs.has(surface)) return;
    this.focus.set(surface, id);
    this.notify();
  }

  dispatch(action: InputUiAction): boolean {
    const surface = this.active();
    if (!surface) return false;
    const spec = this.specs.get(surface)!;
    if ((spec.move ?? MOVE).includes(action)) return this.move(surface, STEP[action] ?? 0);
    if (action === 'back') {
      spec.onBack?.();
      return true;
    }
    // Sem lista na tela (o mapa), confirmar é ação da própria tela.
    if (action === 'confirm' && this.items(surface).length) return this.activate(surface);
    // O resto é da tela: no mapa são andar/zoom; na loja, virar página.
    spec.onAction?.(action);
    return false;
  }

  /** Pula as linhas bloqueadas (item já comprado, sem dinheiro) e dá a volta na lista. */
  move(surface: UiSurface, delta: number): boolean {
    const items = this.items(surface).filter((item) => !item.disabled);
    if (!items.length || !delta) return false;
    const current = items.findIndex((item) => item.id === this.focusId(surface));
    // Foco em linha que virou indisponível (compra): entra na lista pelo lado do toque.
    const base = current < 0 ? (delta > 0 ? -1 : 0) : current;
    const next = items[(base + delta + items.length * 2) % items.length];
    this.focus.set(surface, next.id);
    this.notify();
    return true;
  }

  private activate(surface: UiSurface): boolean {
    const item = this.items(surface).find((entry) => entry.id === this.focusId(surface));
    if (!item || item.disabled) return false;
    item.onSelect();
    return true;
  }
}

export const uiNav = new UiNavStore();
