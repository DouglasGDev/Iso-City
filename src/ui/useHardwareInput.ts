import { useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { getGame } from '../game/GameState';
import { isAboard } from '../entities/Player';
import { useGameStore } from '../stores/useGameStore';
import { sound } from '../audio/SoundManager';
import {
  HardwareInput, mouseWorldAim,
  type HardwareMode, type InputCamera, type InputMenuAction, type InputUiAction,
} from '../game/InputState';
import { uiNav } from './UiNav';

const EDITABLE = 'input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"]';
const UI_TARGET = `${EDITABLE},button,a,[role="button"],[role="dialog"],[role="menu"],[data-hardware-input="ui"]`;
// Só as caixas que realmente recebem toque: o cluster mobile e os botões. Os painéis de
// leitura do HUD (vida, arma, procurado) não podem roubar a mira nem engolir um tiro.
const UI_BOXES = '[data-testid^="control-"],[data-hardware-input="ui"],button,[role="button"]';

// Ctrl is an attack hold: locomotion must still work. Other Ctrl combinations
// (reload/find/address bar/devtools etc.) remain browser shortcuts.
const CTRL_GAME_KEYS = new Set([
  'ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight', 'Space',
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
]);

function closest(target: EventTarget | null, selector: string): Element | null {
  return target && 'closest' in target ? (target as Element).closest(selector) : null;
}

function inside(rect: DOMRect | null, x: number, y: number) {
  return !!rect && rect.width > 0 && rect.height > 0 &&
    x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

/** `PointerEvent.buttons` bits the game owns: left fires, right aims. */
const MOUSE_FIRE = 1;
const MOUSE_AIM = 2;

interface BrowserInputOptions {
  isSuspended: () => boolean;
  isDriving: () => boolean;
  getCamera: () => InputCamera;
  onMode: (mode: HardwareMode) => void;
  onMenu: (action: InputMenuAction) => void;
  onUi?: (action: InputUiAction) => void;
  onGesture?: () => void;
}

export function isMobileBrowser(win: Window): boolean {
  const nav = win.navigator as Navigator & { userAgentData?: { mobile: boolean } };
  return nav.userAgentData?.mobile === true || /Android|iPhone|iPad|iPod/i.test(nav.userAgent) ||
    (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1) ||
    (win.matchMedia('(pointer: coarse)').matches && win.matchMedia('(hover: none)').matches);
}

/** Browser adapter exported for deterministic event/RAF fakes; never installed natively. */
export function attachHardwareInput(win: Window, doc: Document, options: BrowserInputOptions) {
  const input = new HardwareInput(options.onMode, options.onMenu,
    options.onUi ?? ((action) => { uiNav.dispatch(action); }));
  const touchOnly = isMobileBrowser(win);
  let pointer: { x: number; y: number } | null = null;
  let frame = 0;
  let disposed = false;
  /** Button mask the game accepted: bit 0 left (fire), bit 1 right (aim). */
  let mouseMask = 0;

  function refresh() {
    const blocked = options.isSuspended();
    input.setSuspended(blocked);
    input.setFocused(!doc.hidden && doc.hasFocus() && !closest(doc.activeElement, EDITABLE));
    if (!blocked) input.setDriving(options.isDriving());
    if (blocked || doc.hidden || !doc.hasFocus()) {
      pointer = null;
      mouseMask = 0;
    }
  }

  function surfaceRects() {
    const canvases = Array.from(doc.querySelectorAll('canvas'));
    let surface: HTMLCanvasElement | null = null;
    let area = 0;
    for (const canvas of canvases) {
      const r = canvas.getBoundingClientRect();
      if (r.width * r.height > area) { surface = canvas; area = r.width * r.height; }
    }
    return { canvases, element: surface, rect: surface?.getBoundingClientRect() ?? null };
  }

  /** Os botões, o cluster de toque e os canvas menores (minimapa/ícones) pertencem à interface. */
  function overUi(x: number, y: number, surface: HTMLCanvasElement | null, canvases: HTMLCanvasElement[]) {
    for (const element of Array.from(doc.querySelectorAll(UI_BOXES))) {
      if (inside(element.getBoundingClientRect(), x, y)) return true;
    }
    for (const canvas of canvases) {
      if (canvas !== surface &&
          inside((canvas.parentElement?.parentElement ?? canvas).getBoundingClientRect(), x, y)) return true;
    }
    return false;
  }

  /**
   * `held` means the game already owns a mouse button: from then on only the button mask
   * can drop the aim, so sliding the cursor over the HUD never cancels the mira or swallows the tiro.
   */
  function surfaceAt(x: number, y: number, target: EventTarget | null, held: boolean) {
    if (!held && closest(target, UI_TARGET)) return null;
    const { element, rect, canvases } = surfaceRects();
    if (!inside(rect, x, y)) return null;
    return held || !overUi(x, y, element, canvases) ? rect : null;
  }

  function updateAim(activate: boolean, target?: EventTarget | null) {
    if (!pointer || options.isSuspended()) return false;
    const rect = surfaceAt(pointer.x, pointer.y, target ?? doc.elementFromPoint(pointer.x, pointer.y), mouseMask !== 0);
    if (!rect) {
      mouseMask = 0;
      input.cancelMouse();
      return false;
    }
    const aim = mouseWorldAim(pointer.x, pointer.y, rect, options.getCamera());
    input.mouseMove(aim.x, aim.y, activate, aim.px, aim.py);
    return true;
  }

  /**
   * Left fires, right aims. While a button is already held the browser reports the second one
   * only as the new `buttons` mask of a pointermove, so presses have to come from the mask.
   */
  function syncMouse(next: number, target?: EventTarget | null) {
    const mask = next & (MOUSE_FIRE | MOUSE_AIM);
    const pressed = mask & ~mouseMask;
    if (mouseMask & ~mask & MOUSE_FIRE) input.mouseButton(false, 0);
    if (mouseMask & ~mask & MOUSE_AIM) input.mouseButton(false, 2);
    if (!pressed) {
      mouseMask = mask;
      return true;
    }
    // A primeira borda ainda respeita a HUD: clique em botão de interface não é tiro.
    if (!updateAim(true, target)) return false;
    mouseMask = mask;
    if (pressed & MOUSE_FIRE) input.mouseButton(true, 0);
    if (pressed & MOUSE_AIM) input.mouseButton(true, 2);
    options.onGesture?.();
    return true;
  }

  const keydown = (event: KeyboardEvent) => {
    refresh();
    if (event.defaultPrevented || event.isComposing ||
        closest(event.target, EDITABLE) || (event.code === 'Space' && closest(event.target, UI_TARGET))) return;
    // F3 liga o painel de métricas do streaming (§17). Vem antes do `touchOnly` de propósito:
    // tecla de função não é ponteiro. Deixá-la atrás do guarda significaria que o painel só
    // existe no teclado de quem nunca tocou na tela — num tablet com teclado físico, e no QA web
    // que nasce em emulação de toque, o painel seria impossível de abrir.
    if (event.code === 'F3') {
      event.preventDefault();
      const game = getGame();
      game.showDebug = !game.showDebug;
      return;
    }
    if (touchOnly) return;
    if (event.metaKey || event.altKey || (event.ctrlKey && !CTRL_GAME_KEYS.has(event.code))) {
      input.release();
      return;
    }
    if (input.keyDown(event.code, event.repeat)) {
      event.preventDefault();
      options.onGesture?.();
    }
  };
  const keyup = (event: KeyboardEvent) => { if (!touchOnly) input.keyUp(event.code); };
  const contextmenu = (event: MouseEvent) => { if (!touchOnly) event.preventDefault(); };
  const pointerdown = (event: PointerEvent) => {
    refresh();
    if (event.pointerType === 'touch' || event.pointerType === 'pen') {
      pointer = null;
      mouseMask = 0;
      input.touch();
      return;
    }
    if (touchOnly || event.pointerType !== 'mouse' || (event.button !== 0 && event.button !== 2) ||
        event.defaultPrevented) return;
    pointer = { x: event.clientX, y: event.clientY };
    if (syncMouse(event.buttons, event.target) && mouseMask) {
      // Do not let the still-mounted touch responder interpret this mouse click.
      event.preventDefault();
      event.stopPropagation();
    }
  };
  const pointermove = (event: PointerEvent) => {
    if (touchOnly || event.pointerType !== 'mouse') return;
    refresh();
    const changed = !pointer || pointer.x !== event.clientX || pointer.y !== event.clientY;
    pointer = { x: event.clientX, y: event.clientY };
    // The second button of a press only ever shows up here, as a new `buttons` mask.
    if (event.buttons !== mouseMask) syncMouse(event.buttons, event.target);
    else updateAim(changed, event.target);
    if (mouseMask) event.stopPropagation();
  };
  const pointerup = (event: PointerEvent) => {
    if (touchOnly || event.pointerType !== 'mouse' || (event.button !== 0 && event.button !== 2)) return;
    syncMouse(event.buttons, event.target);
    if (mouseMask) event.stopPropagation();
  };
  const cancel = () => {
    pointer = null;
    mouseMask = 0;
    input.release();
  };
  const blur = () => { cancel(); input.setFocused(false); };
  const visibility = () => { if (doc.hidden) blur(); else refresh(); };
  const disconnected = (event: GamepadEvent) => input.disconnect(event.gamepad.index);
  const poll = () => {
    if (disposed) return;
    refresh();
    let pads: (Gamepad | null)[] = [];
    try { pads = Array.from(win.navigator.getGamepads?.() ?? []); } catch { /* Permissions Policy / unavailable API. */ }
    input.pollGamepads(pads);
    if (input.mode === 'keyboard') updateAim(false);
    input.refreshKeyboard();
    frame = win.requestAnimationFrame(poll);
  };

  win.addEventListener('keydown', keydown);
  win.addEventListener('keyup', keyup);
  win.addEventListener('contextmenu', contextmenu);
  win.addEventListener('pointerdown', pointerdown, true);
  win.addEventListener('pointermove', pointermove, true);
  win.addEventListener('pointerup', pointerup, true);
  win.addEventListener('pointercancel', cancel, true);
  win.addEventListener('blur', blur);
  win.addEventListener('focus', refresh);
  win.addEventListener('pagehide', blur);
  win.addEventListener('gamepaddisconnected', disconnected);
  doc.addEventListener('visibilitychange', visibility);
  doc.addEventListener('focusin', refresh);
  refresh();
  if (!touchOnly) frame = win.requestAnimationFrame(poll);
  return {
    refresh,
    dispose() {
      disposed = true;
      win.cancelAnimationFrame(frame);
      win.removeEventListener('keydown', keydown);
      win.removeEventListener('keyup', keyup);
      win.removeEventListener('contextmenu', contextmenu);
      win.removeEventListener('pointerdown', pointerdown, true);
      win.removeEventListener('pointermove', pointermove, true);
      win.removeEventListener('pointerup', pointerup, true);
      win.removeEventListener('pointercancel', cancel, true);
      win.removeEventListener('blur', blur);
      win.removeEventListener('focus', refresh);
      win.removeEventListener('pagehide', blur);
      win.removeEventListener('gamepaddisconnected', disconnected);
      doc.removeEventListener('visibilitychange', visibility);
      doc.removeEventListener('focusin', refresh);
      input.release();
    },
  };
}

/** Call once in App. Expo Go has no native Gamepad API: it always returns touch. */
export function useHardwareInput(suspended: boolean): HardwareMode {
  const [mode, setMode] = useState<HardwareMode>('touch');
  const suspendedRef = useRef(suspended);
  suspendedRef.current = suspended;
  const adapter = useRef<ReturnType<typeof attachHardwareInput> | null>(null);
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined' || typeof document === 'undefined') return;
    const binding = attachHardwareInput(window, document, {
      isSuspended: () => {
        const ui = useGameStore.getState();
        return suspendedRef.current || ui.screen !== 'playing' || ui.paused || ui.mapOpen || ui.overlay !== null;
      },
      isDriving: () => isAboard(getGame().player),
      getCamera: getGame,
      onMode: (mode) => {
        setMode(mode);
        // As telas de menu precisam saber se mostram régua de foco e dicas de tecla.
        uiNav.setInputKind(mode);
      },
      onGesture: () => { if (!sound.isUnlocked) void sound.unlock().catch(() => undefined); },
      onMenu: (action) => {
        const ui = useGameStore.getState();
        if (ui.screen !== 'playing' || ui.overlay !== null) return;
        if (ui.mapOpen) useGameStore.closeMap();
        else if (action === 'pause' && ui.shopOpen) useGameStore.closeShop();
        else if (action === 'map') useGameStore.openMap();
        else useGameStore.togglePause();
      },
    });
    adapter.current = binding;
    return () => { adapter.current = null; binding.dispose(); };
  }, []);
  useEffect(() => { adapter.current?.refresh(); }, [suspended]);
  return mode;
}
