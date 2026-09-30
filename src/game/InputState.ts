export interface InputStateData {
  dx: number;
  dy: number;
  magnitude: number;
  runHeld: boolean;
  jumpQueued: boolean;
  attackQueued: boolean;
  attackHeld: boolean;
  reloadQueued: boolean;
  weaponQueued: -1 | 0 | 1;
  crouchQueued: boolean;
  interactQueued: boolean;
  enterQueued: boolean;
  vehicleAccel: boolean;
  vehicleBrake: boolean;
  vehicleLeft: boolean;
  vehicleRight: boolean;
  /**
   * Cabra do helicóptero. Separado de `vehicleAccel`/`vehicleBrake` porque no teclado as
   * mesmas teclas já empurram o manche: W voa para cima na tela, Space é que sobe a cota.
   * No toque e no controle os pedais fazem os dois papéis e espelham aqui.
   */
  heliUp: boolean;
  heliDown: boolean;
  hornQueued: boolean;
  /** Normalized WORLD-space direction, not a target position or movement facing. */
  aimX: number;
  aimY: number;
  /** World point under the mouse while manual aim is held. NaN when no cursor drives the aim. */
  aimPointX: number;
  aimPointY: number;
  aimActive: boolean;
  /** Touch-only "MIRA" toggle: aims along the movement facing, bypassing auto-aim. */
  aimTouchHeld: boolean;
  /** Gamepad LT held with a neutral right stick: the same facing fallback. */
  aimTriggerHeld: boolean;
}

type BooleanQueuedAction = 'jumpQueued' | 'attackQueued' | 'reloadQueued' | 'crouchQueued' | 'enterQueued' | 'interactQueued' | 'hornQueued';
type QueuedAction = BooleanQueuedAction | 'weaponQueued';
const consumedActions: Record<QueuedAction, number> = {
  jumpQueued: 0, attackQueued: 0, reloadQueued: 0, weaponQueued: 0, crouchQueued: 0, enterQueued: 0, interactQueued: 0,
  hornQueued: 0,
};

export const inputState: InputStateData = {
  dx: 0,
  dy: 0,
  magnitude: 0,
  runHeld: false,
  jumpQueued: false,
  attackQueued: false,
  attackHeld: false,
  reloadQueued: false,
  weaponQueued: 0,
  crouchQueued: false,
  interactQueued: false,
  enterQueued: false,
  vehicleAccel: false,
  vehicleBrake: false,
  vehicleLeft: false,
  vehicleRight: false,
  heliUp: false,
  heliDown: false,
  hornQueued: false,
  aimX: 0,
  aimY: 0,
  aimPointX: NaN,
  aimPointY: NaN,
  aimActive: false,
  aimTouchHeld: false,
  aimTriggerHeld: false,
};

export function setJoystickInput(dx: number, dy: number, magnitude: number) {
  const len = Math.hypot(dx, dy);
  if (!Number.isFinite(len) || !Number.isFinite(magnitude) || len < 1e-8 || magnitude <= 0) {
    resetJoystickInput();
    return;
  }
  inputState.magnitude = Math.min(1, magnitude);
  inputState.dx = dx / len * inputState.magnitude;
  inputState.dy = dy / len * inputState.magnitude;
}

export function resetJoystickInput() {
  inputState.dx = 0;
  inputState.dy = 0;
  inputState.magnitude = 0;
}

export function setVehicleControl(
  control: 'accel' | 'brake' | 'left' | 'right',
  pressed: boolean,
) {
  if (control === 'accel') inputState.vehicleAccel = pressed;
  else if (control === 'brake') inputState.vehicleBrake = pressed;
  else if (control === 'left') inputState.vehicleLeft = pressed;
  else inputState.vehicleRight = pressed;
}

export function setHeliControl(control: 'up' | 'down', pressed: boolean) {
  if (control === 'up') inputState.heliUp = pressed;
  else inputState.heliDown = pressed;
}

export function resetVehicleArrows() {
  inputState.vehicleAccel = false;
  inputState.vehicleBrake = false;
  inputState.vehicleLeft = false;
  inputState.vehicleRight = false;
  inputState.heliUp = false;
  inputState.heliDown = false;
}

export function setRunHeld(holding: boolean) {
  inputState.runHeld = holding;
}

export function queueAttack() {
  inputState.attackQueued = true;
}

/** Rising edge is a tap; holding is used only by automatic weapons. */
export function setAttackHeld(holding: boolean) {
  if (holding && !inputState.attackHeld) queueAttack();
  inputState.attackHeld = holding;
}

export function queueJump() {
  inputState.jumpQueued = true;
}

/** Momentary car horn, valid only behind the wheel. */
export function queueHorn() {
  inputState.hornQueued = true;
}

export function consumeHorn(): boolean {
  return consumeAction('hornQueued');
}

export function consumeJump(): boolean {
  return consumeAction('jumpQueued');
}

export function queueReload() {
  inputState.reloadQueued = true;
}

/** One pending step, like other tap actions; the latest edge supplies its direction. */
export function queueWeapon(direction: -1 | 1 = 1) {
  inputState.weaponQueued = direction;
}

export function queueCrouch() {
  inputState.crouchQueued = true;
}

export function consumeCrouch(): boolean {
  return consumeAction('crouchQueued');
}

function consumeAction(action: BooleanQueuedAction): boolean {
  const queued = inputState[action];
  inputState[action] = false;
  if (queued) consumedActions[action]++;
  return queued;
}

export function consumeReload(): boolean {
  return consumeAction('reloadQueued');
}

export function consumeWeapon(): -1 | 0 | 1 {
  const direction = inputState.weaponQueued;
  inputState.weaponQueued = 0;
  if (direction !== 0) consumedActions.weaponQueued++;
  return direction;
}

/** Clear actions on pause/overlays, driving and round transitions. */
export function resetActionInput() {
  inputState.attackHeld = false;
  inputState.attackQueued = false;
  inputState.jumpQueued = false;
  inputState.reloadQueued = false;
  inputState.weaponQueued = 0;
  inputState.crouchQueued = false;
  inputState.enterQueued = false;
  inputState.interactQueued = false;
  inputState.hornQueued = false;
  inputState.aimTouchHeld = false;
  inputState.aimTriggerHeld = false;
  setAimInput(0, 0);
}

export function queueEnter() {
  inputState.enterQueued = true;
}

export function consumeEnter(): boolean {
  return consumeAction('enterQueued');
}

export function consumeInteract(): boolean {
  return consumeAction('interactQueued');
}

export function consumeAttack(): boolean {
  return consumeAction('attackQueued');
}

export function queueInteract() {
  inputState.interactQueued = true;
}

export function setAimInput(x: number, y: number, pointX = NaN, pointY = NaN) {
  const len = Math.hypot(x, y);
  inputState.aimActive = Number.isFinite(len) && len > 1e-8;
  inputState.aimX = inputState.aimActive ? x / len : 0;
  inputState.aimY = inputState.aimActive ? y / len : 0;
  inputState.aimPointX = inputState.aimActive ? pointX : NaN;
  inputState.aimPointY = inputState.aimActive ? pointY : NaN;
}

export function toggleAimTouch(): boolean {
  inputState.aimTouchHeld = !inputState.aimTouchHeld;
  return inputState.aimTouchHeld;
}

/** Manual aim wins; the touch toggle aims along the current facing; otherwise auto-aim applies. */
export function effectiveAim(facingAngle: number): {
  x: number; y: number; active: boolean; pointX: number; pointY: number;
} {
  if (inputState.aimActive) {
    return {
      x: inputState.aimX, y: inputState.aimY, active: true,
      pointX: inputState.aimPointX, pointY: inputState.aimPointY,
    };
  }
  if (inputState.aimTouchHeld || inputState.aimTriggerHeld) {
    return { x: Math.cos(facingAngle), y: Math.sin(facingAngle), active: true, pointX: NaN, pointY: NaN };
  }
  return { x: 0, y: 0, active: false, pointX: NaN, pointY: NaN };
}

export function resetInputState() {
  resetActionInput();
  resetJoystickInput();
  resetVehicleArrows();
  setRunHeld(false);
}

export type HardwareMode = 'touch' | 'keyboard' | 'gamepad';
export type InputMenuAction = 'map' | 'pause';
/** Ações de menu: só existem enquanto a simulação está suspensa (pausa, loja, mapa). */
export type InputUiAction = 'up' | 'down' | 'left' | 'right' | 'confirm' | 'back' | 'prev' | 'next' | 'zoomIn' | 'zoomOut';

/**
 * Analógico da navegação: o eixo esquerdo move a câmera do mapa e os gatilhos dão zoom.
 * Vive separado de `inputState` porque a simulação está congelada quando ele é lido.
 */
export const uiAnalog = { x: 0, y: 0, zoom: 0 };

export function setUiAnalog(x: number, y: number, zoom: number) {
  uiAnalog.x = Number.isFinite(x) ? x : 0;
  uiAnalog.y = Number.isFinite(y) ? y : 0;
  uiAnalog.zoom = Number.isFinite(zoom) ? zoom : 0;
}

export function resetUiAnalog() {
  setUiAnalog(0, 0, 0);
}
export interface InputViewport {
  left: number;
  top: number;
  width: number;
  height: number;
}
export interface InputCamera {
  camera: { x: number; y: number; zoom: number };
  player: { x: number; y: number };
  viewW: number;
  viewH: number;
  shakeX: number;
  shakeY: number;
}

/**
 * Client CSS pixels -> aim direction from the player plus the world point under the cursor.
 * `px`/`py` are NaN when the projection is meaningless, so the reticle can fall back to the ray.
 */
export function mouseWorldAim(clientX: number, clientY: number, rect: InputViewport, game: InputCamera) {
  const { camera: c } = game;
  if (rect.width <= 0 || rect.height <= 0 || c.zoom <= 0) return { x: 0, y: 0, px: NaN, py: NaN };
  const sx = ((clientX - rect.left) * game.viewW / rect.width - game.viewW / 2 - game.shakeX) / c.zoom;
  const sy = ((clientY - rect.top) * game.viewH / rect.height - game.viewH / 2 - game.shakeY) / c.zoom;
  const px = c.x + sx / 128 + sy / 64;
  const py = c.y + sy / 64 - sx / 128;
  const x = px - game.player.x;
  const y = py - game.player.y;
  const len = Math.hypot(x, y);
  if (!Number.isFinite(len) || len <= 1e-8) return { x: 0, y: 0, px: NaN, py: NaN };
  return { x: x / len, y: y / len, px, py };
}

/** Only the browser's Standard mapping is supported; no native/XInput shim. */
export interface StandardGamepad {
  index: number;
  connected: boolean;
  mapping: string;
  axes: readonly number[];
  buttons: readonly { pressed: boolean; value: number }[];
}

const HARDWARE_KEYS = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight',
  'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'Space', 'KeyE', 'KeyF', 'KeyQ', 'KeyZ', 'KeyC', 'KeyR', 'KeyM', 'KeyH', 'Escape',
  'Enter', 'NumpadEnter', 'Backspace', 'PageUp', 'PageDown', 'Equal', 'Minus',
]);
/** Teclas que só significam algo com a simulação congelada. */
const UI_KEYS = new Map<string, InputUiAction>([
  ['ArrowUp', 'up'], ['ArrowDown', 'down'], ['ArrowLeft', 'left'], ['ArrowRight', 'right'],
  ['Enter', 'confirm'], ['NumpadEnter', 'confirm'], ['Backspace', 'back'],
  ['PageUp', 'prev'], ['PageDown', 'next'], ['Equal', 'zoomIn'], ['Minus', 'zoomOut'],
]);
/** Segurar seta repete a navegação; repetir confirmar/voltar dispararia duas ações. */
const UI_REPEATABLE = new Set<InputUiAction>(['up', 'down', 'left', 'right']);
const PAD_BUTTON_COUNT = 16;
/** Botões que valem como "o jogador está usando o pad" dentro do jogo. */
const PAD_BUTTONS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
/** D-pad (12-15) e os botões de cardápio; nada aqui move o jogador. */
const PAD_UI_BUTTONS = [0, 1, 4, 5, 12, 13, 14, 15];
const PAD_UI_EDGES: readonly [number, InputUiAction][] = [
  [12, 'up'], [13, 'down'], [14, 'left'], [15, 'right'],
  [0, 'confirm'], [1, 'back'], [4, 'prev'], [5, 'next'],
];
const PAD_DEADZONE = 0.18;
function stick(axes: readonly number[], offset: number) {
  const axis = (n: number) => Number.isFinite(n) ? Math.max(-1, Math.min(1, n)) : 0;
  let x = axis(axes[offset]);
  let y = axis(axes[offset + 1]);
  const len = Math.hypot(x, y);
  if (len <= PAD_DEADZONE) return { x: 0, y: 0, magnitude: 0 };
  if (len > 1) { x /= len; y /= len; }
  return { x, y, magnitude: Math.min(1, len) };
}
function trigger(pad: StandardGamepad, index: number) {
  const value = pad.buttons[index]?.value;
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value as number)) : 0;
}
interface PadHistory {
  buttons: boolean[];
  blocked: boolean;
  menuBlocked: boolean;
  uiBlocked: boolean;
}

/** Pure input arbitration; neither React, browser globals nor GameState are imported. */
export class HardwareInput {
  mode: HardwareMode = 'touch';
  private suspended = false;
  private focused = true;
  private driving = false;
  private keys = new Set<string>();
  private down = new Set<string>();
  private mouseHeld = false;
  private aimHeld = false;
  private mouseAim = { x: 0, y: 0, px: NaN, py: NaN };
  private attackWasHeld = false;
  private pads = new Map<number, PadHistory>();
  private selectedPad: number | null = null;
  private pending = new Map<QueuedAction, { consumed: number; direction?: -1 | 1 }>();

  constructor(
    private onMode: (mode: HardwareMode) => void = () => {},
    private onMenu: (action: InputMenuAction) => void = () => {},
    private onUi: (action: InputUiAction) => void = () => {},
  ) {}

  /** Release on lifecycle boundaries; held pad controls must return to neutral. */
  release() {
    resetInputState();
    resetUiAnalog();
    this.pending.clear();
    this.keys.clear();
    this.mouseHeld = false;
    this.aimHeld = false;
    this.mouseAim = { x: 0, y: 0, px: NaN, py: NaN };
    this.attackWasHeld = false;
    for (const pad of this.pads.values()) {
      pad.blocked = true;
      pad.menuBlocked = true;
      pad.uiBlocked = true;
    }
  }

  setSuspended(value: boolean) {
    if (value === this.suspended) return;
    this.suspended = value;
    this.release();
  }

  setFocused(value: boolean) {
    if (value === this.focused) return;
    this.focused = value;
    this.down.clear();
    this.release();
  }

  setDriving(value: boolean) {
    if (value === this.driving) return;
    this.driving = value;
    this.release();
  }

  touch() {
    // A second finger must NOT clear the first finger's movement/run input.
    this.claim('touch');
  }

  private claim(mode: HardwareMode) {
    if (this.mode === mode) return;
    this.release();
    this.mode = mode;
    this.onMode(mode);
  }

  private menu(action: InputMenuAction) {
    this.release();
    this.onMenu(action);
  }

  keyDown(code: string, repeat = false): boolean {
    if (!HARDWARE_KEYS.has(code) || !this.focused) return false;
    const uiAction = UI_KEYS.get(code);
    // Com a simulação congelada as setas/Enter pertencem ao cardápio, não ao jogador.
    if (this.suspended && uiAction && (UI_REPEATABLE.has(uiAction) || !repeat)) {
      this.claim('keyboard');
      this.onUi(uiAction);
      return true;
    }
    if (repeat || this.down.has(code)) return true;
    this.down.add(code);
    if (code === 'KeyM' || code === 'Escape') {
      this.claim('keyboard');
      this.menu(code === 'KeyM' ? 'map' : 'pause');
      return true;
    }
    if (this.suspended) return false;
    this.claim('keyboard');
    this.keys.add(code);
    if (code === 'Space' && !this.driving) this.queue('jumpQueued');
    if (code === 'KeyE') this.queue('enterQueued');
    if (code === 'KeyF') this.queue('interactQueued');
    if (code === 'KeyQ') this.queueWeapon(-1);
    if (code === 'KeyZ') this.queueWeapon(1);
    if (code === 'KeyC' && !this.driving) this.queue('crouchQueued');
    if (code === 'KeyR') this.queue('reloadQueued');
    if (code === 'KeyH' && this.driving) this.queue('hornQueued');
    this.applyKeyboard();
    return true;
  }

  keyUp(code: string) {
    this.down.delete(code);
    this.keys.delete(code);
    if (this.mode === 'keyboard' && !this.suspended && this.focused) this.applyKeyboard();
  }

  mouseMove(x: number, y: number, activate = true, pointX = NaN, pointY = NaN) {
    if (this.suspended || !this.focused) return;
    if (activate) this.claim('keyboard');
    if (this.mode !== 'keyboard') return;
    this.mouseAim = { x, y, px: pointX, py: pointY };
    this.applyKeyboard();
  }

  /** Left button (0) fires; right button (2) holds GTA-SA style manual aim. */
  mouseButton(held: boolean, button: 0 | 2 = 0) {
    if (held && (this.suspended || !this.focused)) return;
    if (held) this.claim('keyboard');
    if (button === 2) this.aimHeld = held;
    else this.mouseHeld = held;
    if (this.mode === 'keyboard' && !this.suspended && this.focused) this.applyKeyboard();
  }

  cancelMouse() {
    this.mouseHeld = false;
    this.aimHeld = false;
    this.mouseAim = { x: 0, y: 0, px: NaN, py: NaN };
    if (this.mode === 'keyboard' && !this.suspended && this.focused) this.applyKeyboard();
  }

  private queue(action: BooleanQueuedAction) {
    inputState[action] = true;
    this.pending.set(action, { consumed: consumedActions[action] });
  }

  private queueWeapon(direction: -1 | 1) {
    queueWeapon(direction);
    this.pending.set('weaponQueued', { consumed: consumedActions.weaponQueued, direction });
  }

  private flushPending() {
    // Hiding ControlTouch unmounts it and resets the shared input. Preserve only
    // unconsumed hardware taps across that cleanup, never across release/pause.
    for (const [action, pending] of this.pending) {
      if (consumedActions[action] !== pending.consumed) this.pending.delete(action);
      else if (action === 'weaponQueued') inputState.weaponQueued = pending.direction ?? 1;
      else inputState[action] = true;
    }
  }

  private attack(held: boolean) {
    // Compare hardware edges, not shared state: GameState can clear actions when
    // driving/swimming without turning a held trigger into a fresh tap each tick.
    if (held && !this.attackWasHeld) this.queue('attackQueued');
    inputState.attackHeld = held;
    this.attackWasHeld = held;
  }

  refreshKeyboard() {
    if (this.mode === 'keyboard' && !this.suspended && this.focused) {
      this.flushPending();
      this.applyKeyboard();
    }
  }

  private applyKeyboard() {
    const has = (...codes: string[]) => codes.some((code) => this.keys.has(code));
    const left = has('KeyA', 'ArrowLeft');
    const right = has('KeyD', 'ArrowRight');
    const up = has('KeyW', 'ArrowUp');
    const down = has('KeyS', 'ArrowDown');
    const x = Number(right) - Number(left);
    const y = Number(down) - Number(up);
    setJoystickInput(x, y, Math.min(1, Math.hypot(x, y)));
    setRunHeld(has('ShiftLeft', 'ShiftRight'));
    setVehicleControl('accel', up);
    setVehicleControl('brake', down);
    setVehicleControl('left', left && !right);
    setVehicleControl('right', right && !left);
    // No ar o WASD continua sendo o manche: quem toca o pé de cabra é o Espaço (sobe) e
    // o Ctrl (desce), teclas que a pé pertencem ao pulo e ao ataque.
    setHeliControl('up', has('Space'));
    setHeliControl('down', has('ControlLeft', 'ControlRight'));
    this.attack(!this.driving && (has('ControlLeft', 'ControlRight') || this.mouseHeld));
    if (this.aimHeld) setAimInput(this.mouseAim.x, this.mouseAim.y, this.mouseAim.px, this.mouseAim.py);
    else setAimInput(0, 0);
  }

  disconnect(index: number) {
    this.pads.delete(index);
    if (this.selectedPad !== index) return;
    this.selectedPad = null;
    if (this.mode === 'gamepad') this.claim('touch');
  }

  pollGamepads(gamepads: readonly (StandardGamepad | null)[]) {
    const connected = gamepads.filter((p): p is StandardGamepad => !!p && p.connected && p.mapping === 'standard');
    for (const index of this.pads.keys()) {
      if (!connected.some((p) => p.index === index)) this.disconnect(index);
    }
    for (const pad of connected) {
      const buttons = Array.from({ length: PAD_BUTTON_COUNT }, (_, i) => {
        const b = pad.buttons[i];
        return !!b && (i === 6 || i === 7 ? b.value > 0.15 : b.pressed || b.value > 0.5);
      });
      let history = this.pads.get(pad.index);
      if (!history) {
        history = { buttons: buttons.slice(), blocked: true, menuBlocked: true, uiBlocked: true };
        this.pads.set(pad.index, history);
      }
      const previous = history.buttons;
      history.buttons = buttons;
      const ls = stick(pad.axes, 0);
      const rs = stick(pad.axes, 2);
      if (!this.focused) continue;
      const menuReady = !history.menuBlocked;
      if (!buttons[8] && !buttons[9]) history.menuBlocked = false;
      if (menuReady && ((buttons[8] && !previous[8]) || (buttons[9] && !previous[9]))) {
        this.claim('gamepad');
        this.selectedPad = pad.index;
        this.menu(buttons[9] ? 'pause' : 'map');
        return;
      }
      if (this.suspended) {
        history.blocked = true;
        this.pollMenuPad(pad, history, previous, buttons, ls);
        continue;
      }
      const active = ls.magnitude > 0 || rs.magnitude > 0 || PAD_BUTTONS.some((i) => buttons[i]);
      if (!active) history.blocked = false;
      if (history.blocked) continue;
      if (active && (this.mode !== 'gamepad' || this.selectedPad !== pad.index)) {
        if (this.mode === 'gamepad') this.release();
        else this.claim('gamepad');
        this.selectedPad = pad.index;
        history.blocked = false;
      }
      if (this.mode !== 'gamepad' || this.selectedPad !== pad.index) continue;
      this.flushPending();
      setJoystickInput(ls.x, ls.y, ls.magnitude);
      setRunHeld(buttons[0]);
      setVehicleControl('accel', buttons[7]);
      setVehicleControl('brake', buttons[6]);
      // Os gatilhos são os pedais do pad: no helicóptero eles içam e baixam a cabra,
      // igual ao toque — o manche continua sendo o analógico esquerdo.
      setHeliControl('up', buttons[7]);
      setHeliControl('down', buttons[6]);
      setVehicleControl('left', ls.x < -PAD_DEADZONE);
      setVehicleControl('right', ls.x > PAD_DEADZONE);
      this.attack(!this.driving && buttons[7]);
      // LT is the aim trigger on foot (GTA-SA); brake while driving. Auto-aim yields while aiming.
      const aiming = !this.driving && buttons[6];
      inputState.aimTriggerHeld = aiming;
      setAimInput(aiming ? rs.x / 128 + rs.y / 64 : 0, aiming ? rs.y / 64 - rs.x / 128 : 0);
      if (!this.driving && buttons[1] && !previous[1]) this.queue('jumpQueued');
      if (this.driving && buttons[1] && !previous[1]) this.queue('hornQueued');
      if (buttons[2] && !previous[2]) this.queue('reloadQueued');
      if (buttons[3] && !previous[3]) this.queue('enterQueued');
      if (buttons[4] && !previous[4]) this.queueWeapon(-1);
      if (buttons[5] && !previous[5]) this.queueWeapon(1);
      if (!this.driving && buttons[10] && !previous[10]) this.queue('crouchQueued');
    }
  }

  /**
   * O pad com menus abertos: D-pad/A/B navegam, analógico esquerdo e gatilhos movem o mapa.
   * Um pad já segurado ao abrir a tela nunca dispara sozinho — espera o neutro, como no jogo.
   */
  private pollMenuPad(pad: StandardGamepad, history: PadHistory, previous: readonly boolean[],
    buttons: readonly boolean[], ls: { x: number; y: number; magnitude: number }) {
    const zoom = trigger(pad, 7) - trigger(pad, 6);
    const live = ls.magnitude > 0 || Math.abs(zoom) > 0.15 || PAD_UI_BUTTONS.some((i) => buttons[i]);
    if (!live) history.uiBlocked = false;
    if (live && (this.mode !== 'gamepad' || this.selectedPad !== pad.index)) {
      if (this.mode === 'gamepad') this.release();
      else this.claim('gamepad');
      this.selectedPad = pad.index;
      history.uiBlocked = true;
    }
    if (this.mode !== 'gamepad' || this.selectedPad !== pad.index) return;
    setUiAnalog(ls.x, ls.y, zoom);
    if (history.uiBlocked) return;
    for (const [index, action] of PAD_UI_EDGES) {
      if (buttons[index] && !previous[index]) {
        this.onUi(action);
        return;
      }
    }
  }
}
