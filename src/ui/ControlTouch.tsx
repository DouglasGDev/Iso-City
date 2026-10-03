import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Dimensions, StyleSheet, View, useWindowDimensions } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { runOnJS } from 'react-native-reanimated';
import {
  inputState,
  queueCrouch,
  queueHorn,
  queueJump,
  queueReload,
  queueWeapon,
  resetActionInput,
  resetJoystickInput,
  setAttackHeld,
  setHeliControl,
  setJoystickInput,
  setRunHeld,
  setVehicleControl,
  toggleAimTouch,
} from '../game/InputState';
import { sound } from '../audio/SoundManager';
import { useControlInsets } from './useControlInsets';
import { useGameStore } from '../stores/useGameStore';

export type HitId = 'joy' | 'run' | 'jump' | 'crouch' | 'attack' | 'aim' | 'weapon' | 'weaponPrev' | 'reload' | 'enter' | 'exit' | 'interact' | 'map' | 'pause' | 'left' | 'right' | 'accel' | 'brake' | 'horn';

function resetControls() {
  resetActionInput();
  resetJoystickInput();
  setRunHeld(false);
  setVehicleControl('left', false);
  setVehicleControl('right', false);
  setVehicleControl('accel', false);
  setVehicleControl('brake', false);
  setHeliControl('up', false);
  setHeliControl('down', false);
}

export const JOY_SIZE = 168;
export const JOY_KNOB = 72;
const JOY_TRAVEL = (JOY_SIZE - JOY_KNOB) / 2;

type Rect = { x: number; y: number; w: number; h: number };
type Pid = number;
type Pt = { id: number; x: number; y: number };

type JoyVisual = {
  base: { x: number; y: number };
  knob: { x: number; y: number };
  active: boolean;
  home: { x: number; y: number };
};

type Ctx = {
  driving: boolean;
  pressed: Partial<Record<HitId, boolean>>;
  joy: JoyVisual;
  register: (id: HitId, box: Rect | null) => void;
};

const ControlTouchContext = createContext<Ctx | null>(null);

export function useControlTouch(): Ctx {
  const ctx = useContext(ControlTouchContext);
  if (!ctx) throw new Error('useControlTouch outside ControlTouch');
  return ctx;
}

const ignoreTarget = (_id: HitId, _box: Rect | null) => {};

export function useHitTarget(id: HitId) {
  const context = useContext(ControlTouchContext);
  const register = context?.register ?? ignoreTarget;
  const pressed = context?.pressed ?? {};
  const ref = useRef<View>(null);
  const onLayout = useCallback(() => {
    ref.current?.measureInWindow((x, y, w, h) => {
      if (w > 1 && h > 1) register(id, { x, y, w, h });
    });
  }, [id, register]);
  useEffect(() => {
    const t = setTimeout(onLayout, 50);
    const iv = setInterval(onLayout, 400);
    return () => {
      clearTimeout(t);
      clearInterval(iv);
      register(id, null);
    };
  }, [id, register, onLayout]);
  return { ref, onLayout, pressed: !!pressed[id], managed: context !== null };
}

function contains(b: Rect, px: number, py: number, pad: number) {
  return px >= b.x - pad && px <= b.x + b.w + pad && py >= b.y - pad && py <= b.y + b.h + pad;
}

function fallbackDriving(
  px: number,
  py: number,
  left: number,
  right: number,
  bottom: number,
): HitId | null {
  const { width, height } = Dimensions.get('window');
  const r = width - right;
  const b = height - bottom;
  if (px > r - 118 && py > b - 118) return 'accel';
  if (px > r - 118 - 24 - 96 && px <= r - 118 && py > b - 104) return 'brake';
  if (px > r - 110 && py > b - 118 - 18 - 92 && py <= b - 118) return 'exit';
  if (py > b - 92 && py < b) {
    if (px > left && px < left + 88) return 'left';
    if (px > left + 88 && px < left + 196) return 'right';
  }
  return null;
}

/**
 * Um único responder na tela: vários dedos (andar+correr, virar+acelerar).
 * O sistema de toque do RN só entrega o 2º dedo para a MESMA view.
 */
export function ControlTouch({
  driving,
  flying = false,
  aboard = false,
  children,
}: {
  driving: boolean;
  flying?: boolean;
  aboard?: boolean;
  children: ReactNode;
}) {
  const insets = useControlInsets();
  const boxes = useRef<Partial<Record<HitId, Rect>>>({});
  const pointers = useRef(new Map<Pid, HitId>());
  const joyCenter = useRef({ x: 0, y: 0 });
  const active = useRef(false);
  const { width, height } = useWindowDimensions();

  const home = useMemo(() => ({
    x: insets.left + 6,
    y: Math.max(110, height - JOY_SIZE - 44 - insets.bottom - (width < 360 ? 24 : 0)),
  }), [insets.left, insets.bottom, width, height]);

  const [pressed, setPressed] = useState<Partial<Record<HitId, boolean>>>({});
  const [joy, setJoy] = useState<JoyVisual>({
    base: home,
    knob: { x: 0, y: 0 },
    active: false,
    home,
  });

  useEffect(() => {
    setJoy((j) => ({ ...j, home, base: j.active ? j.base : home }));
  }, [home]);

  const register = useCallback((id: HitId, box: Rect | null) => {
    if (box) boxes.current[id] = box;
    else delete boxes.current[id];
  }, []);

  const applyJoy = useCallback((pageX: number, pageY: number) => {
    const cx = joyCenter.current.x;
    const cy = joyCenter.current.y;
    let dx = pageX - cx;
    let dy = pageY - cy;
    const len = Math.hypot(dx, dy);
    if (len > JOY_TRAVEL && len > 1e-6) {
      dx = (dx / len) * JOY_TRAVEL;
      dy = (dy / len) * JOY_TRAVEL;
    }
    setJoy((j) => ({ ...j, knob: { x: dx, y: dy }, active: true }));
    const mag = Math.min(1, Math.hypot(dx, dy) / JOY_TRAVEL);
    setJoystickInput(dx / JOY_TRAVEL, dy / JOY_TRAVEL, mag);
  }, []);

  const hitTest = useCallback(
    (px: number, py: number): HitId | null => {
      // A whitelist é o que a tela oferece: um id fora dela não é consultado no `boxes` e o
      // toque escapa para o fallback. Por isso a bordo precisa da própria lista — o passageiro
      // tem `driving` falso (ele não está ao volante de um `Vehicle`), mas o botão que ele vê
      // é o DESEMBARCAR, e sem 'exit' aqui o toque caía no canto de CORRER.
      const order: HitId[] = flying
        ? ['pause', 'map', 'brake', 'accel', 'exit', 'horn']
        : driving
          ? ['pause', 'map', 'brake', 'accel', 'exit', 'horn', 'left', 'right']
          : aboard
            ? ['pause', 'map', 'exit']
            : ['pause', 'map', 'interact', 'enter', 'weaponPrev', 'weapon', 'reload', 'crouch', 'jump', 'aim', 'attack', 'run'];
      let best: HitId | null = null;
      let bestD = Infinity;
      for (const id of order) {
        const box = boxes.current[id];
        if (!box) continue;
        const pad = id === 'brake' || id === 'accel' ? 6 : 12;
        if (!contains(box, px, py, pad)) continue;
        const d = Math.hypot(px - (box.x + box.w / 2), py - (box.y + box.h / 2));
        if (d < bestD) {
          bestD = d;
          best = id;
        }
      }
      if (best) return best;
      if (!driving || flying) {
        const { width, height } = Dimensions.get('window');
        // fallback CORRER (canto inferior direito) se o hitbox não registrou. A bordo não há
        // para que correr — o corpo é do ônibus —, então o canto é só do DESEMBARCAR.
        if (!aboard && px > width - insets.right - 130 && py > height - insets.bottom - 130) return 'run';
        if (px < width * 0.48 && py > height * 0.16) return 'joy';
        return null;
      }
      return fallbackDriving(px, py, insets.left, insets.right, insets.bottom);
    },
    [driving, flying, aboard, insets.left, insets.right, insets.bottom],
  );

  const activate = useCallback(
    (id: HitId, pageX: number, pageY: number) => {
      if (!sound.isUnlocked) void sound.unlock();
      setPressed((p) => ({ ...p, [id]: true }));
      if (id === 'joy') {
        joyCenter.current = { x: pageX, y: pageY };
        setJoy((j) => ({
          ...j,
          base: { x: pageX - JOY_SIZE / 2, y: pageY - JOY_SIZE / 2 },
          active: true,
        }));
        applyJoy(pageX, pageY);
        return;
      }
      if (id === 'map') useGameStore.openMap();
      else if (id === 'pause') useGameStore.pause();
      else if (id === 'interact') inputState.interactQueued = true;
      else if (id === 'run') setRunHeld(true);
      else if (id === 'jump') queueJump();
      else if (id === 'crouch') queueCrouch();
      else if (id === 'attack') setAttackHeld(true);
      else if (id === 'aim') toggleAimTouch();
      else if (id === 'weaponPrev') queueWeapon(-1);
      else if (id === 'weapon') queueWeapon(1);
      else if (id === 'reload') queueReload();
      else if (id === 'left') setVehicleControl('left', true);
      else if (id === 'right') setVehicleControl('right', true);
      else if (id === 'accel') { setVehicleControl('accel', true); setHeliControl('up', true); }
      else if (id === 'brake') { setVehicleControl('brake', true); setHeliControl('down', true); }
      else if (id === 'horn') queueHorn();
      else if (id === 'enter' || id === 'exit') {
        inputState.enterQueued = true;
      }
    },
    [applyJoy],
  );

  const deactivate = useCallback((id: HitId) => {
    setPressed((p) => ({ ...p, [id]: false }));
    if (id === 'joy') {
      setJoy((j) => ({ ...j, base: j.home, knob: { x: 0, y: 0 }, active: false }));
      resetJoystickInput();
      return;
    }
    if (id === 'run') setRunHeld(false);
    else if (id === 'attack') setAttackHeld(false);
    else if (id === 'left') setVehicleControl('left', false);
    else if (id === 'right') setVehicleControl('right', false);
    else if (id === 'accel') { setVehicleControl('accel', false); setHeliControl('up', false); }
    else if (id === 'brake') { setVehicleControl('brake', false); setHeliControl('down', false); }
  }, []);

  const onDown = useCallback(
    (pts: Pt[]) => {
      for (const t of pts) {
        if (pointers.current.has(t.id)) continue;
        const hit = hitTest(t.x, t.y);
        if (!hit) continue;
        let taken = false;
        for (const used of pointers.current.values()) {
          if (used === hit) taken = true;
        }
        if (taken) continue;
        pointers.current.set(t.id, hit);
        activate(hit, t.x, t.y);
      }
    },
    [activate, hitTest],
  );

  const onMove = useCallback(
    (pts: Pt[]) => {
      for (const t of pts) {
        if (pointers.current.get(t.id) === 'joy') applyJoy(t.x, t.y);
      }
    },
    [applyJoy],
  );

  const onUp = useCallback(
    (ids: number[]) => {
      for (const id of ids) {
        const hit = pointers.current.get(id);
        if (!hit) continue;
        pointers.current.delete(id);
        deactivate(hit);
      }
    },
    [deactivate],
  );

  const cancel = useCallback(() => {
    pointers.current.clear();
    resetControls();
    setPressed({});
    setJoy((j) => ({ ...j, base: j.home, knob: { x: 0, y: 0 }, active: false }));
  }, []);

  const fns = useRef({ onDown, onMove, onUp, cancel });
  fns.current = { onDown, onMove, onUp, cancel };

  const dispatchDown = useCallback((pts: Pt[]) => {
    if (active.current) fns.current.onDown(pts);
  }, []);
  const dispatchMove = useCallback((pts: Pt[]) => {
    if (active.current) fns.current.onMove(pts);
  }, []);
  const dispatchUp = useCallback((ids: number[]) => {
    if (active.current) fns.current.onUp(ids);
  }, []);
  const dispatchCancel = useCallback(() => {
    if (active.current) fns.current.cancel();
  }, []);

  const gesture = useMemo(
    () =>
      Gesture.Pan()
        .minDistance(0)
        .maxPointers(10)
        .shouldCancelWhenOutside(false)
        .onTouchesDown((e) => {
          const pts: Pt[] = [];
          for (const t of e.changedTouches) {
            pts.push({ id: t.id, x: t.absoluteX, y: t.absoluteY });
          }
          runOnJS(dispatchDown)(pts);
        })
        .onTouchesMove((e) => {
          const pts: Pt[] = [];
          for (const t of e.allTouches) {
            pts.push({ id: t.id, x: t.absoluteX, y: t.absoluteY });
          }
          runOnJS(dispatchMove)(pts);
        })
        .onTouchesUp((e) => {
          const ids: number[] = [];
          for (const t of e.changedTouches) ids.push(t.id);
          runOnJS(dispatchUp)(ids);
        })
        .onTouchesCancelled(() => {
          runOnJS(dispatchCancel)();
        })
        .onFinalize((_event, success) => {
          if (!success) runOnJS(dispatchCancel)();
        }),
    [dispatchDown, dispatchMove, dispatchUp, dispatchCancel],
  );

  // Só a troca de superfície (a pé ↔ volante ↔ voo) libera os dedos: ela monta outro conjunto
  // de controles. `aboard` não entra aqui de propósito — passageiro e pedestre usam o mesmo
  // joystick, e com ele na lista o notify do streaming ao virar a esquina derrubava o
  // empurrão no instante em que a porta abria, congelando quem acabou de descer do ônibus.
  useEffect(() => {
    const currentPointers = pointers.current;
    active.current = true;
    cancel();
    return () => {
      active.current = false;
      currentPointers.clear();
      resetControls();
    };
  }, [driving, flying, home, cancel]);

  const value = useMemo(
    () => ({ driving, pressed, joy, register }),
    [driving, pressed, joy, register],
  );

  return (
    <ControlTouchContext.Provider value={value}>
      <View style={[styles.layer, { pointerEvents: 'box-none' }]} collapsable={false}>
        {children}
        <GestureDetector gesture={gesture}>
          <Animated.View collapsable={false} style={styles.capture} />
        </GestureDetector>
      </View>
    </ControlTouchContext.Provider>
  );
}

const styles = StyleSheet.create({
  layer: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 20,
  },
  capture: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'transparent',
    zIndex: 80,
  },
});
