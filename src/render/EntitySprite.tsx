import { useEffect, useState } from 'react';
import { useDerivedValue, useSharedValue } from 'react-native-reanimated';
import { Circle, FilterMode, Group, Image, Oval, Skia, type SkImage } from '@shopify/react-native-skia';
import { entitySVs } from './SharedValues';
import { resolveEntityImage } from './entityImages';
import { getGame } from '../game/GameState';
import { weaponKey } from '../assets/AssetRegistry';
import { spriteStore } from '../assets/SpriteStore';
import { isGunId, type GunId } from '../data/weapons';
import type { Dir4 } from '../game/GameConfig';
import { MeleeSwing, type MeleeVisualState } from './WeaponEffects';
import { BLOOD_POOL_STAINS, deathPose, type BloodStain } from '../entities/NPC';
import { crouchPose } from '../entities/Player';
import { dirToWorldVec } from '../world/IsoUtils';

interface Props {
  id: string;
}

// Original 24x32 limb outlines, indexed by depth and stride; mirrored for left strikes.
const BASE_ARM_CONTOURS = {
  near: [
    [[15, 8], [19, 8], [19, 20], [14, 20], [14, 19], [13, 19], [13, 10], [14, 10], [14, 9], [15, 9]],
    [[15, 9], [19, 9], [19, 14], [18, 14], [18, 18], [17, 18], [17, 19], [15, 19], [15, 21],
      [12, 21], [12, 14], [14, 14], [14, 11], [13, 11], [13, 10], [15, 10]],
    [[15, 8], [18, 8], [18, 9], [19, 9], [19, 12], [20, 12], [20, 15], [21, 15], [21, 19],
      [20, 19], [20, 20], [17, 20], [17, 19], [16, 19], [16, 18], [14, 18], [14, 9], [15, 9]],
  ],
  far: [
    [[15, 5], [19, 5], [19, 17], [17, 17], [17, 16], [15, 16]],
    [[15, 6], [19, 6], [19, 10], [18, 10], [18, 13], [17, 13], [17, 12], [16, 12], [16, 10], [15, 10]],
    [[15, 5], [19, 5], [19, 9], [20, 9], [20, 13], [21, 13], [21, 18], [19, 18], [19, 19],
      [17, 19], [17, 18], [16, 18], [16, 17], [15, 17]],
  ],
} as const;

function readSpriteFrame(id: string) {
  const p = id === 'player' ? getGame().player : null;
  // Keep the mask's pose and image in the same React snapshot, even when walking.
  return { image: resolveEntityImage(id), direction: p?.direction ?? 'SE',
    anim: p?.anim ?? 'idle', frame: p?.frame ?? 0 };
}

/** Dono de um sprite: jogador, pedestre, preso/guarda da cadeia, morador de sala ou veículo. */
function entityForSprite(id: string, index: number) {
  const game = getGame();
  if (id === 'player') return game.player;
  if (id.startsWith('npc:')) return game.npcs[index];
  if (id.startsWith('inmate:')) return game.jail.byId(index);
  if (id.startsWith('people:')) return game.crowd.byId(index);
  return game.vehicles[index];
}

function pollMsFor(id: string): number {
  if (id === 'player') return 16; // Sample short melee phases, not just sprite frames.
  if (id.startsWith('npc:') || id.startsWith('inmate:') || id.startsWith('people:')) return 100;
  if (id.startsWith('veh:')) {
    const idx = Number(id.split(':')[1]);
    const v = getGame().vehicles[idx];
    if (!v) return 200;
    if (v.def.type === 'helicopter') return 70;
    if (v.occupied || getGame().player.currentVehicleId === v.id) return 55;
    return 220;
  }
  return 120;
}

export function EntitySprite({ id }: Props) {
  const game = getGame();
  const index = Number(id.split(':')[1]);
  const entity = entityForSprite(id, index);
  const sv = useSharedValue({ x: entity?.x ?? 0, y: entity?.y ?? 0 });
  const swimSV = useSharedValue(0);
  const swimAngleSV = useSharedValue(0);
  const [sprite, setSprite] = useState(() => readSpriteFrame(id));
  const { image } = sprite;
  const [swimming, setSwimming] = useState(false);
  const [lift, setLift] = useState(0);
  const [weapon, setWeapon] = useState<{ id: GunId; direction: Dir4 } | null>(null);
  const [batImage, setBatImage] = useState<SkImage | null>(null);
  const hand = useSharedValue({ x: 0, y: -18 });
  const stride = useSharedValue({ bob: 0, lean: 0 });
  const jumpLift = useSharedValue(0);
  const crouching = useSharedValue(false);
  const death = useSharedValue(deathPose(false, 0));
  const melee = useSharedValue<MeleeVisualState>({ weapon: 'unarmed', angle: 0, secondsLeft: 0, visible: false });
  const [meleeBehind, setMeleeBehind] = useState(false);
  const [blood, setBlood] = useState<BloodStain[] | null>(null);

  if (!entitySVs.has(id)) {
    entitySVs.set(id, sv);
  }

  useEffect(() => {
    entitySVs.set(id, sv);
    return () => {
      if (entitySVs.get(id) === sv) entitySVs.delete(id);
    };
  }, [id, sv]);

  useEffect(() => {
    const ms = pollMsFor(id);
    const iv = setInterval(() => {
      const next = readSpriteFrame(id);
      // null is meaningful (vehicle entry, removed entity, unavailable frame).
      setSprite((prev) => prev.image === next.image && prev.direction === next.direction &&
        prev.anim === next.anim && prev.frame === next.frame ? prev : next);
      // Pedestre da rua, gente da cadeia e morador de sala têm o mesmo corpo; só muda a
      // fila onde moram.
      const watched = id.startsWith('npc:') ? game.npcs[index]
        : id.startsWith('inmate:') ? game.jail.byId(index)
          : id.startsWith('people:') ? game.crowd.byId(index) : null;
      if (watched) {
        const npc = watched;
        death.value = deathPose(npc.dead, npc.deathTimer, npc.dir);
        setBlood(npc.dead ? npc.blood : null);
        // Água: mesmo corpo deitado e respingos do player, na direção do nado.
        const inWater = !!npc.swimming && !npc.dead;
        setSwimming(inWater);
        swimSV.value = inWater ? 1 : 0;
        if (inWater) {
          const { wx, wy } = dirToWorldVec(npc.dir);
          swimAngleSV.value = Math.atan2((wx + wy) * 0.5, wx - wy);
        }
        const cop = npc.kind === 'cop' ? game.police.cops.find((c) => c.npcId === npc.id) : null;
        if (cop?.armed && !npc.dead && !npc.inVehicle && npc.state !== 'knocked') {
          const gun: GunId = game.player.wantedLevel > 3 ? 'smg' : 'pistol';
          const direction = npc.dir;
          setWeapon((previous) => previous?.id === gun && previous.direction === direction
            ? previous : { id: gun, direction });
          const right = direction === 'SE' || direction === 'NE';
          hand.value = { x: (right ? 4 : -4) + (cop.fireFlash > 0 ? (right ? -2 : 2) : 0), y: -18 };
        } else setWeapon(null);
      }
      if (id === 'player') {
        const p = getGame().player;
        jumpLift.value = p.jumpHeight;
        death.value = deathPose(p.state === 'dead', game.playerDeathTimer, p.direction);
        setSwimming(p.swimming);
        swimSV.value = p.swimming ? 1 : 0;
        // ângulo na tela iso (não mundo) pra o corpo apontar pra onde nada
        const a = p.facingAngle;
        const wx = Math.cos(a);
        const wy = Math.sin(a);
        swimAngleSV.value = Math.atan2((wx + wy) * 0.5, wx - wy);
        const equipped = game.weapons.equipped;
        const onFoot = !p.swimming && p.currentVehicleId === null && p.health > 0 &&
          p.state !== 'dead' && p.state !== 'driving' && p.state !== 'enteringVehicle';
        crouching.value = p.crouching && onFoot && p.jumpTimer <= 0 && p.jumpHeight <= 0;
        const moving = onFoot && p.speed > 0.05 && p.jumpTimer <= 0;
        const running = !crouching.value && p.state === 'running';
        const phase = game.time * Math.PI * 2 * (running ? 3.8 : 2.2);
        stride.value = {
          bob: moving && !crouching.value ? -Math.abs(Math.sin(phase)) * (running ? 1.9 : 0.55) : 0,
          lean: p.jumpEnd ? (wx - wy) * p.jumpHeight / 150 : moving && running ? (wx - wy) * 0.055 : 0,
        };
        const swinging = p.attackTimer > 0 && equipped === p.attackWeapon;
        const meleeAngle = swinging ? p.attackAngle : p.facingAngle;
        const meleeDir = (['SE', 'SW', 'NW', 'NE'] as const)[
          ((Math.round(meleeAngle / (Math.PI / 2)) % 4) + 4) % 4
        ];
        melee.value = {
          weapon: equipped === 'bat' ? 'bat' : 'unarmed', angle: meleeAngle, dir: meleeDir,
          secondsLeft: swinging ? p.attackTimer : 0,
          visible: onFoot && !isGunId(equipped) && (equipped === 'bat' || swinging),
        };
        if (equipped === 'bat') {
          const next = spriteStore[weaponKey('bat', meleeDir)];
          setBatImage((prev) => (prev === next ? prev : next ?? null));
        } else {
          setBatImage((prev) => (prev === null ? prev : null));
        }
        setMeleeBehind(Math.cos(meleeAngle) + Math.sin(meleeAngle) < 0);
        if (!isGunId(equipped) || !onFoot) {
          setWeapon(null);
        } else {
          const direction = (['SE', 'SW', 'NW', 'NE'] as const)[
            ((Math.round(game.weapons.aimAngle / (Math.PI / 2)) % 4) + 4) % 4
          ];
          setWeapon((previous) => previous?.id === equipped && previous.direction === direction
            ? previous : { id: equipped, direction });
          const right = direction === 'SE' || direction === 'NE';
          hand.value = {
            x: (right ? 4 : -4) + (game.weapons.fireFlash > 0 ? (right ? -2 : 2) : 0),
            y: -18,
          };
        }
      }
      if (id.startsWith('veh:')) {
        const v = getGame().vehicles[Number(id.split(':')[1])];
        setLift(v && v.def.type === 'helicopter' ? v.altitude * 38 : 0);
      }
    }, ms);
    return () => clearInterval(iv);
  }, [id, index, swimSV, swimAngleSV, game, hand, stride, melee, death, jumpLift, crouching]);

  const w = image ? image.width() : 0;
  const h = image ? image.height() : 0;
  const posture = useDerivedValue(() => crouchPose(crouching.value, h), [crouching, h]);
  const torsoTransform = useDerivedValue(() => [{ translateY: posture.value.torsoOffsetY }], [posture]);
  const legsTransform = useDerivedValue(() => [
    { translateX: w / 2 }, { translateY: h },
    { scaleX: posture.value.legScaleX }, { scaleY: posture.value.legScaleY },
    { translateX: -w / 2 }, { translateY: -h },
  ], [posture, w, h]);
  const { direction, anim, frame } = sprite;
  const armClip = useDerivedValue(() => {
    const path = Skia.Path.Make();
    const s = melee.value;
    if (id !== 'player' || !s.visible || w !== 24 || h !== 32) return path;
    // Match MeleeSwing's actual side, not the rounded sprite/weapon direction.
    const right = Math.cos(s.angle) - Math.sin(s.angle) >= 0;
    const nearRight = direction === 'NE' || direction === 'SW';
    const f = ((frame % 4) + 4) % 4;
    const pose = anim === 'idle' || f === 1 || f === 3 ? 0 : f === 0 ? 1 : 2;
    const contour = BASE_ARM_CONTOURS[right === nearRight ? 'near' : 'far'][pose];
    contour.forEach(([x, y], i) => {
      const px = right ? x : 24 - x;
      if (i === 0) path.moveTo(px, y);
      else path.lineTo(px, y);
    });
    path.close();
    return path;
  }, [id, direction, anim, frame, w, h, melee]);

  const screen = useDerivedValue(() => {
    const p = sv.value;
    return { x: (p.x - p.y) * 64, y: (p.x + p.y) * 32 };
  }, [sv]);

  const splashX = useDerivedValue(() => screen.value.x, [screen]);
  const splashY = useDerivedValue(() => screen.value.y - 4, [screen]);
  const shadowY = useDerivedValue(() => screen.value.y - 4, [screen]);
  const bloodTransform = useDerivedValue(() => [
    { translateX: splashX.value }, { translateY: splashY.value },
  ], [splashX, splashY]);

  const swimTransform = useDerivedValue(() => {
    const cx = screen.value.x;
    const cy = screen.value.y;
    const pose = death.value;
    if (pose.rotation !== 0) return [
      { translateX: cx }, { translateY: cy + pose.offsetY },
      { rotate: pose.rotation }, { scaleY: pose.scaleY },
      { translateX: -w / 2 }, { translateY: -h },
    ];
    if (swimSV.value < 0.5) {
      return [
        { translateX: cx },
        { translateY: cy - lift - jumpLift.value + stride.value.bob },
        { rotate: stride.value.lean },
        { translateX: -w / 2 },
        { translateY: -h },
      ];
    }
    // Deitado na direção do movimento (facingAngle no espaço mundo → rotação na tela iso).
    // offset π/2: sprite em pé vira corpo ao longo do eixo de nado.
    const rot = swimAngleSV.value + Math.PI / 2;
    return [
      { translateX: cx },
      { translateY: cy - 4 },
      { rotate: rot },
      { translateX: -w / 2 },
      { translateY: -h * 0.62 },
    ];
  }, [screen, w, h, lift, swimSV, swimAngleSV, stride, jumpLift, death]);

  const meleeTransform = useDerivedValue(() => [
    { translateX: screen.value.x },
    { translateY: screen.value.y - jumpLift.value + stride.value.bob },
    { rotate: stride.value.lean },
    { translateY: posture.value.torsoOffsetY },
  ], [screen, stride, jumpLift, posture]);
  const heldTransform = useDerivedValue(() => [
    { translateX: screen.value.x },
    { translateY: screen.value.y - jumpLift.value + stride.value.bob },
    { rotate: stride.value.lean },
    { translateX: hand.value.x },
    { translateY: hand.value.y + posture.value.torsoOffsetY },
  ], [screen, hand, stride, jumpLift, posture]);
  const heldImage = weapon ? spriteStore[weaponKey(weapon.id, weapon.direction)] : null;
  const weaponW = weapon ? ({
    pistol: 16, revolver: 19, smg: 21, micro: 19, rifle: 30, sniper: 38, shotgun: 29,
  } as Record<GunId, number>)[weapon.id] : 0;
  const weaponH = heldImage ? heldImage.height() * weaponW / heldImage.width() : 0;
  const pointsRight = weapon?.direction === 'SE' || weapon?.direction === 'NE';
  const behind = weapon?.direction === 'NE' || weapon?.direction === 'NW';
  const held = heldImage ? (
    <Group transform={heldTransform}>
      <Image image={heldImage} x={-weaponW * (pointsRight ? 0.3 : 0.7)} y={-weaponH * 0.7}
        width={weaponW} height={weaponH} fit="fill" />
      <Circle cx={0} cy={0} r={1.7} color="#e6c995" />
      {weapon?.id === 'rifle' || weapon?.id === 'sniper' || weapon?.id === 'shotgun' ? (
        <Circle cx={pointsRight ? 9 : -9} cy={-1} r={1.8} color="#e6c995" />
      ) : null}
    </Group>
  ) : null;
  const meleeHeld = id === 'player' ? (
    <Group transform={meleeTransform}><MeleeSwing state={melee} batImage={batImage} /></Group>
  ) : null;

  const opacity = useDerivedValue(() => death.value.alpha, [death]);
  const jumpShadow = useDerivedValue(() => Math.min(0.25, jumpLift.value / 30), [jumpLift]);

  if (!image || w <= 0 || h <= 0) return null;

  return (
    <Group opacity={opacity}>
      {id === 'player' ? <Circle cx={splashX} cy={shadowY} r={7} color="#17251e" opacity={jumpShadow} /> : null}
      {lift > 4 ? <Circle cx={splashX} cy={shadowY} r={14} color="rgba(0,0,0,0.28)" /> : null}
      {swimming ? (
        <>
          <Circle cx={splashX} cy={splashY} r={20} color="rgba(70, 170, 240, 0.32)" />
          <Circle cx={splashX} cy={splashY} r={11} color="rgba(160, 220, 255, 0.38)" />
        </>
      ) : null}
      {behind ? held : null}
      {meleeBehind ? meleeHeld : null}
      {blood ? (
        <Group transform={bloodTransform}>
          {blood.map((stain, i) => (
            <Oval key={i} x={stain.dx - stain.rx} y={stain.dy - stain.ry}
              width={stain.rx * 2} height={stain.ry * 2}
              color={i < BLOOD_POOL_STAINS ? '#5d0f14' : '#7c1620'} opacity={stain.alpha} />
          ))}
        </Group>
      ) : null}
      <Group transform={swimTransform}>
        {id === 'player' ? <>
          <Group transform={legsTransform}>
            <Group clip={{ x: 0, y: h * 0.625, width: w, height: h * 0.375 }}>
              <Group clip={armClip} invertClip>
                <Image image={image} x={0} y={0} width={w} height={h} fit="fill" opacity={swimming ? 0.92 : 1} />
              </Group>
            </Group>
          </Group>
          <Group transform={torsoTransform}>
            <Group clip={{ x: 0, y: 0, width: w, height: h * 0.625 }}>
              <Group clip={armClip} invertClip>
                <Image image={image} x={0} y={0} width={w} height={h} fit="fill" opacity={swimming ? 0.92 : 1} />
              </Group>
            </Group>
          </Group>
        </> : <Image image={image} x={0} y={0} width={w} height={h} fit="fill" opacity={swimming ? 0.92 : 1}
          sampling={{ filter: FilterMode.Nearest }} />}
      </Group>
      {!behind ? held : null}
      {!meleeBehind ? meleeHeld : null}
    </Group>
  );
}
