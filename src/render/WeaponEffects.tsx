import { useMemo } from 'react';
import { Group, Image, Path, Skia, type SkImage } from '@shopify/react-native-skia';
import { useDerivedValue, type SharedValue } from 'react-native-reanimated';
import type { WeaponTracer } from '../systems/WeaponSystem';
import { meleeMotion } from '../entities/Player';
import type { MeleeId } from '../data/weapons';
import type { Dir4 } from '../game/GameConfig';

export interface MeleeVisualState {
  weapon: 'unarmed' | MeleeId;
  angle: number;
  secondsLeft: number;
  visible: boolean;
  /** Iso facing of the sprite; omit to keep the vector-only bat. */
  dir?: Dir4;
}

/** Grip (knob) pixel measured from each generated bat sprite. */
const BAT_GRIP: Record<Dir4, { x: number; y: number }> = {
  SE: { x: 5, y: 6 },
  SW: { x: 58, y: 6 },
  NE: { x: 5, y: 41 },
  NW: { x: 58, y: 41 },
};
/** Barrel axis each sprite already draws, in screen degrees (0 = right, positive = down). */
const BAT_BASE: Record<Dir4, number> = { SE: 20, SW: 160, NE: -33, NW: 213 };
const BAT_SCALE = 0.44;

/** Local foot-origin coordinates, projected with the same 64:32 iso basis as entities. */
export function MeleeSwing({ state, batImage = null }: {
  state: SharedValue<MeleeVisualState>;
  batImage?: SkImage | null;
}) {
  const pose = useDerivedValue(() => {
    const s = state.value;
    const { reach, swing } = meleeMotion(s.weapon, s.secondsLeft);
    const fx = Math.cos(s.angle);
    const fy = Math.sin(s.angle);
    const side = fx - fy >= 0 ? 1 : -1;
    // 0..1 nas duas metades do ciclo: armar o golpe e soltá-lo.
    const wind = Math.max(0, Math.min(1, -reach / 0.22));
    const drive = Math.max(0, reach);
    const batWeapon = s.weapon === 'bat';
    const extension = 0.1 + reach * (batWeapon ? 0.18 : 0.28);
    // Shoulders sit on the facing-perpendicular iso axis; they roll back on the windup and forward on the hit.
    const shoulder = { x: side * (3 + reach * 1.6 - wind * 2.6), y: -20 - reach * 1.2 + wind * 1.4 };
    const hand = { x: shoulder.x + (fx - fy) * 64 * extension - wind * side * 7.5,
      y: -18 + (fx + fy) * 32 * extension + wind * 5 - drive * (batWeapon ? 7 : 3) };
    const elbow = { x: (shoulder.x + hand.x) / 2 + side * (4 - reach * 2) + wind * side * 3,
      y: (shoulder.y + hand.y) / 2 + 3 - wind * 2 };
    const bx = Math.cos(s.angle + swing);
    const by = Math.sin(s.angle + swing);
    const tip = { x: hand.x + (bx - by) * 64 * 0.48,
      y: hand.y + (bx + by) * 32 * 0.48 - 12 * (1 - Math.max(0, reach)) };
    return { side, shoulder, hand, elbow, tip, reach, swing };
  }, [state]);

  const arm = useDerivedValue(() => {
    const path = Skia.Path.Make();
    if (!state.value.visible) return path;
    const { shoulder, elbow, hand } = pose.value;
    path.moveTo(shoulder.x, shoulder.y);
    path.lineTo(elbow.x, elbow.y);
    path.lineTo(hand.x, hand.y);
    return path;
  }, [state, pose]);
  const fist = useDerivedValue(() => {
    const path = Skia.Path.Make();
    if (!state.value.visible) return path;
    const { hand } = pose.value;
    path.addCircle(hand.x, hand.y, 2.9);
    return path;
  }, [state, pose]);
  /** Swept arc behind the striking limb while it is actually accelerating. */
  const trail = useDerivedValue(() => {
    const path = Skia.Path.Make();
    const s = state.value;
    const { shoulder, hand, reach } = pose.value;
    if (!s.visible || reach < 0.15) return path;
    const radius = Math.hypot(hand.x - shoulder.x, hand.y - shoulder.y);
    if (radius < 4) return path;
    const current = Math.atan2(hand.y - shoulder.y, hand.x - shoulder.x);
    const sweep = (s.weapon === 'bat' ? 0.85 : 0.5) * Math.min(1, reach);
    path.moveTo(shoulder.x + Math.cos(current - sweep * pose.value.side) * radius * 0.82,
      shoulder.y + Math.sin(current - sweep * pose.value.side) * radius * 0.82);
    path.conicTo(
      shoulder.x + Math.cos(current - sweep * pose.value.side * 0.5) * radius * 1.12,
      shoulder.y + Math.sin(current - sweep * pose.value.side * 0.5) * radius * 1.12,
      shoulder.x + Math.cos(current) * radius, shoulder.y + Math.sin(current) * radius, 1);
    return path;
  }, [state, pose]);
  const bat = useDerivedValue(() => {
    const path = Skia.Path.Make();
    if (!state.value.visible || state.value.weapon !== 'bat' || batImage) return path;
    const { hand: h, tip: t } = pose.value;
    const length = Math.max(1, Math.hypot(t.x - h.x, t.y - h.y));
    const nx = -(t.y - h.y) / length;
    const ny = (t.x - h.x) / length;
    path.moveTo(h.x + nx * 1.2, h.y + ny * 1.2);
    path.lineTo(t.x + nx * 3.2, t.y + ny * 3.2);
    path.quadTo(t.x + (t.x - h.x) / length * 3, t.y + (t.y - h.y) / length * 3,
      t.x - nx * 3.2, t.y - ny * 3.2);
    path.lineTo(h.x - nx * 1.2, h.y - ny * 1.2);
    path.close();
    return path;
  }, [state, pose, batImage]);
  const grain = useDerivedValue(() => {
    const path = Skia.Path.Make();
    if (!state.value.visible || state.value.weapon !== 'bat' || batImage) return path;
    const { hand: h, tip: t } = pose.value;
    path.moveTo(h.x * 0.7 + t.x * 0.3, h.y * 0.7 + t.y * 0.3 - 0.7);
    path.lineTo(t.x, t.y - 0.7);
    return path;
  }, [state, pose, batImage]);
  /** Sprite pivot: grip stays on the hand, the barrel follows the same sweep as the vector bat. */
  const batTransform = useDerivedValue(() => {
    const s = state.value;
    const dir = s.dir ?? (Math.cos(s.angle) >= 0 ? (Math.sin(s.angle) >= 0 ? 'SE' : 'NE')
      : (Math.sin(s.angle) >= 0 ? 'SW' : 'NW'));
    const { hand, tip } = pose.value;
    const dx = tip.x - hand.x;
    const dy = tip.y - hand.y;
    // Skia usa radianos no array de transform; as bases do sprite estão em graus de tela.
    const spin = Math.hypot(dx, dy) < 2 ? 0
      : Math.atan2(dy, dx) - BAT_BASE[dir] * (Math.PI / 180);
    return [
      { translateX: hand.x },
      { translateY: hand.y },
      { rotate: s.weapon === 'bat' ? spin : 0 },
      { scale: BAT_SCALE },
      { translateX: -BAT_GRIP[dir].x },
      { translateY: -BAT_GRIP[dir].y },
    ];
  }, [pose, state]);
  const batOpacity = useDerivedValue(() => state.value.visible && state.value.weapon === 'bat' ? 1 : 0, [state]);
  return (
    <Group>
      <Path path={trail} color="rgba(255,238,205,0.34)" style="stroke" strokeWidth={4.5} strokeCap="round" />
      <Path path={arm} color="#473d32" style="stroke" strokeWidth={5} strokeCap="round" strokeJoin="round" />
      <Path path={arm} color="#d9bd8e" style="stroke" strokeWidth={3} strokeCap="round" strokeJoin="round" />
      <Path path={bat} color="#644328" style="stroke" strokeWidth={1.5} strokeJoin="round" />
      <Path path={bat} color="#b9854f" />
      <Path path={grain} color="#e4bb7e" style="stroke" strokeWidth={1.2} strokeCap="round" />
      {batImage ? (
        <Group transform={batTransform} opacity={batOpacity}>
          <Image image={batImage} x={0} y={0} width={batImage.width()} height={batImage.height()} fit="fill" />
        </Group>
      ) : null}
      <Path path={fist} color="#eed1a2" />
    </Group>
  );
}

export interface WeaponVisualState {
  tracers: WeaponTracer[];
  /** `lift` raises the reticle off its ground point; the mouse cursor needs none. */
  target: { x: number; y: number; lift?: number } | null;
  muzzle: { x: number; y: number } | null;
}

export function WeaponEffects({ state }: { state: SharedValue<WeaponVisualState> }) {
  const trails = useDerivedValue(() => {
    const path = Skia.Path.Make();
    for (const t of state.value.tracers) {
      const dx = t.x2 - t.x1;
      const dy = t.y2 - t.y1;
      const offset = Math.min(0.25, 0.3 / Math.max(0.001, Math.hypot(dx, dy)));
      const x = t.x1 + dx * offset;
      const y = t.y1 + dy * offset;
      path.moveTo((x - y) * 64, (x + y) * 32 - 23);
      path.lineTo((t.x2 - t.y2) * 64, (t.x2 + t.y2) * 32 - 23);
    }
    return path;
  }, [state]);
  const impacts = useDerivedValue(() => {
    const path = Skia.Path.Make();
    for (const t of state.value.tracers) {
      if (t.hit) path.addCircle((t.x2 - t.y2) * 64, (t.x2 + t.y2) * 32 - 23, 2 + t.life * 16);
    }
    const m = state.value.muzzle;
    if (m) {
      const x = (m.x - m.y) * 64;
      const y = (m.x + m.y) * 32 - 23;
      path.moveTo(x - 7, y);
      path.lineTo(x - 2, y - 2);
      path.lineTo(x, y - 7);
      path.lineTo(x + 2, y - 2);
      path.lineTo(x + 7, y);
      path.lineTo(x + 2, y + 2);
      path.lineTo(x, y + 7);
      path.lineTo(x - 2, y + 2);
      path.close();
    }
    return path;
  }, [state]);
  const aim = useMemo(() => {
    const path = Skia.Path.Make();
    path.addCircle(0, 0, 13);
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      path.moveTo(dx * 9, dy * 9);
      path.lineTo(dx * 17, dy * 17);
    }
    return path;
  }, []);
  const aimTransform = useDerivedValue(() => {
    const t = state.value.target;
    return [{ translateX: t ? (t.x - t.y) * 64 : 0 }, { translateY: t ? (t.x + t.y) * 32 - (t.lift ?? 20) : 0 }];
  }, [state]);
  const aimOpacity = useDerivedValue(() => state.value.target ? 0.85 : 0, [state]);
  return (
    <Group>
      <Group transform={aimTransform} opacity={aimOpacity}>
        <Path path={aim} color="#ffcf73" style="stroke" strokeWidth={1.5} />
      </Group>
      <Path path={trails} color="#fff2bc" style="stroke" strokeWidth={1.7} />
      <Path path={impacts} color="#ffc25c" />
    </Group>
  );
}
