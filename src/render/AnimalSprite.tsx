import { useMemo } from 'react';
import { Group, Path, Skia, type SkPath } from '@shopify/react-native-skia';
import { useDerivedValue, type SharedValue } from 'react-native-reanimated';
import {
  animalSpritePose, type Animal, type AnimalPoint, type AnimalSpecies, type AnimalVisualState,
} from '../entities/Animal';

export interface AnimalSpriteProps {
  /** Only immutable identity/species is read from the JS model. Reuse this object after respawn. */
  animal: Pick<Animal, 'id' | 'species'>;
  /**
   * World tiles, NOT screen pixels. Draw inside the world's existing camera/depth group.
   * `h` é a altura do chão em tiles: o laço de simulação a publica junto, porque o
   * worklet não consegue consultar o mapa.
   */
  position: SharedValue<AnimalPoint & { h: number }>;
  /** Publish animalVisualState(animal, game.time) alongside position once per game tick. */
  visual: SharedValue<AnimalVisualState>;
  /** Simulation seconds; pause this clock together with simulation. */
  clock: SharedValue<number>;
}

// Original, hand-authored pixel contours. No images, atlas, registry, external art or licences.
// All geometry is on an integer grid. Two distinct three-quarter views, mirrored into four directions.
const PALETTES = {
  rabbit: ['#514b3d', '#807762', '#aca28b', '#c8bea5', '#e2d9c1', '#bd9d8e', '#292a22', '#f3ead5'],
  deer: ['#503d2b', '#765638', '#a97b4b', '#c99b63', '#e0cd9f', '#bcad8d', '#302b24', '#f0e2c1'],
  fox: ['#493429', '#854326', '#c46932', '#e3984b', '#e6d5b0', '#b57b65', '#242c2c', '#fff0ce'],
  boar: ['#302c2b', '#4e4640', '#736052', '#99806a', '#b2a18a', '#8c6960', '#211f20', '#ebdcad'],
} as const;
const SIZE = { rabbit: { w: 30, h: 30 }, deer: { w: 48, h: 52 },
  fox: { w: 46, h: 32 }, boar: { w: 46, h: 36 } } as const;
type Frame = SkPath[];
interface Art { frames: Frame[]; shadow: SkPath }
const artCache: Partial<Record<AnimalSpecies, Art>> = {};

function painter(): { paths: Frame; rect: (ink: number, x: number, y: number, w: number, h: number) => void;
  contour: (ink: number, points: readonly (readonly [number, number])[]) => void } {
  const paths = Array.from({ length: 8 }, () => Skia.Path.Make());
  return {
    paths,
    rect: (ink, x, y, w, h) => { paths[ink].addRect(Skia.XYWHRect(x, y, w, h)); },
    contour: (ink, points) => {
      const path = paths[ink];
      points.forEach(([x, y], index) => index === 0 ? path.moveTo(x, y) : path.lineTo(x, y));
      path.close();
    },
  };
}

function rabbitFrame(away: boolean, frame: number): Frame {
  const { paths, rect, contour } = painter();
  const stride = frame === 1 ? -2 : frame === 3 ? 2 : 0;
  const lift = frame === 2 ? 1 : 0;
  const headY = away ? 12 : 14;
  // Far feet, compact haunch, long near hind foot, and independently stepping forepaw.
  rect(0, 8 - stride, 24, 7, 3);
  rect(1, 9 - stride, 24, 5, 2);
  rect(0, 21 + stride, 23, 3, 4 - lift);
  rect(1, 22 + stride, 23, 1, 3 - lift);
  contour(0, [[6, 15], [15, 15], [15, 16], [20, 16], [20, 18], [24, 18], [24, 25],
    [21, 25], [21, 27], [6, 27], [6, 25], [4, 25], [4, 18], [6, 18]]);
  rect(1, 6, 20, 16, 6);
  contour(2, [[7, 16], [14, 16], [14, 17], [19, 17], [19, 19], [22, 19], [22, 23],
    [18, 23], [18, 25], [7, 25], [7, 23], [5, 23], [5, 19], [7, 19]]);
  rect(3, 8, 17, 6, 2);
  rect(3, 6, 19, 3, 3);
  rect(0, 7 + stride, 25 - lift, 8, 4);
  rect(2, 8 + stride, 25 - lift, 6, 3);
  rect(4, 10 + stride, 27 - lift, 4, 1);
  rect(0, 21 - stride, 24, 4, 5 - lift);
  rect(2, 22 - stride, 24, 2, 4 - lift);
  // Cotton tail: stepped white pixels, not a generic circle.
  rect(0, 2, 20, 5, 5);
  rect(4, 2, 21, 4, 3);
  rect(7, 3, 20, 3, 2);
  // Far ear leans backward; the near ear is taller with a muted rose inner plane.
  contour(0, [[15, headY - 11], [18, headY - 11], [18, headY - 7], [20, headY - 7],
    [20, headY + 3], [16, headY + 3], [16, headY - 5], [15, headY - 5]]);
  rect(1, 16, headY - 10, 1, 8);
  contour(0, [[21, headY - 12], [24, headY - 12], [24, headY - 10], [25, headY - 10],
    [25, headY - 4], [24, headY - 4], [24, headY + 2], [20, headY + 2],
    [20, headY - 4], [21, headY - 4]]);
  rect(2, 22, headY - 11, 1, 9);
  rect(5, 22, headY - 9, 1, 7);
  contour(0, [[19, headY], [25, headY], [25, headY + 2], [27, headY + 2],
    [27, headY + 5], [29, headY + 5], [29, headY + 8], [24, headY + 8],
    [24, headY + 10], [19, headY + 10], [19, headY + 8], [17, headY + 8], [17, headY + 3], [19, headY + 3]]);
  rect(2, 19, headY + 2, 6, 6);
  rect(2, 24, headY + 4, 3, 3);
  rect(3, 20, headY + 2, 3, 2);
  if (!away) {
    rect(4, 22, headY + 7, 5, 2);
    rect(6, 25, headY + 3, 1, 2);
    rect(6, 28, headY + 6, 1, 1);
    rect(5, 26, headY + 8, 2, 1);
  } else {
    // Looking away: darker rear cheek, smaller visible eye, no frontal bib.
    rect(1, 18, headY + 5, 3, 4);
    rect(6, 26, headY + 3, 1, 1);
    rect(6, 28, headY + 5, 1, 1);
  }
  return paths;
}

function deerFrame(away: boolean, frame: number): Frame {
  const { paths, rect, contour } = painter();
  const stride = frame === 1 ? -3 : frame === 3 ? 3 : 0;
  const lift = frame === 2 || frame === 4 ? 1 : 0;
  const headY = away ? 15 : 18;
  // Four narrow articulated legs. Separate hooves and bent knees remain legible at native size.
  const leg = (x: number, y: number, step: number, far: boolean) => {
    const end = far ? 49 - lift : 52 - (frame === 4 ? 1 : 0);
    const knee = x + (step > 0 ? 1 : step < 0 ? -1 : 0);
    rect(0, x, y, 3, 6);
    rect(0, knee, y + 5, 3, 4);
    rect(0, x + step, y + 8, 3, end - y - 8);
    rect(far ? 1 : 2, x + 1, y, 1, 7);
    rect(far ? 1 : 3, x + step + 1, y + 8, 1, end - y - 9);
    rect(6, x + step, end - 2, 4, 2);
  };
  leg(14, 33, -stride, true);
  leg(28, 32, stride, true);
  leg(8, 36, stride, false);
  leg(32, 35, -stride, false);
  contour(0, [[8, 26], [25, 26], [25, 27], [33, 27], [33, 30], [36, 30], [36, 36],
    [33, 36], [33, 39], [26, 39], [26, 41], [13, 41], [13, 39], [7, 39], [7, 37], [5, 37], [5, 29], [8, 29]]);
  rect(1, 7, 31, 26, 7);
  contour(2, [[9, 27], [24, 27], [24, 28], [31, 28], [31, 30], [34, 30], [34, 35],
    [28, 35], [28, 38], [14, 38], [14, 36], [7, 36], [7, 30], [9, 30]]);
  rect(3, 10, 28, 13, 2);
  rect(3, 8, 30, 5, 2);
  rect(4, 15, 38, 11, 2);
  // Short raised tail with the pale rump patch typical of a deer.
  rect(0, 2, 26, 5, 7);
  rect(2, 3, 27, 3, 4);
  rect(4, 4, 30, 3, 4);
  // Upright neck and elongated muzzle; never the round head/body of a generic critter.
  contour(0, [[31, headY + 2], [36, headY + 2], [36, headY + 8], [38, headY + 8],
    [38, 33], [33, 37], [28, 35], [28, 28], [30, 28], [30, headY + 7], [31, headY + 7]]);
  rect(2, 32, headY + 4, 3, 16);
  rect(3, 33, headY + 5, 2, 11);
  if (!away) rect(4, 35, headY + 9, 2, 8);
  contour(0, [[34, headY - 2], [41, headY - 2], [41, headY], [44, headY],
    [44, headY + 3], [48, headY + 3], [48, headY + 7], [42, headY + 7],
    [42, headY + 6], [36, headY + 6], [36, headY + 4], [33, headY + 4], [33, headY], [34, headY]]);
  rect(2, 35, headY, 7, 4);
  rect(2, 40, headY + 2, 6, 3);
  rect(3, 36, headY, 4, 1);
  rect(away ? 1 : 4, 40, headY + 5, 6, 1);
  rect(6, 46, headY + 3, 2, 3);
  rect(6, 41, headY + 1, 1, 2);
  // Leaf-shaped ears with stepped edges.
  contour(0, [[28, headY - 6], [31, headY - 6], [31, headY - 5], [34, headY - 5],
    [34, headY - 3], [36, headY - 3], [36, headY], [32, headY], [32, headY - 2], [30, headY - 2], [30, headY - 4], [28, headY - 4]]);
  rect(2, 30, headY - 5, 3, 2);
  rect(4, 32, headY - 3, 2, 2);
  rect(0, 41, headY - 6, 3, 5);
  rect(2, 42, headY - 5, 1, 4);
  // Two forked antlers, authored as square-ended twigs, in natural bone/wood colour.
  rect(5, 35, 5, 2, headY - 5);
  rect(5, 33, 4, 3, 2);
  rect(5, 31, 1, 2, 5);
  rect(5, 29, 0, 2, 3);
  rect(5, 34, 0, 1, 5);
  rect(5, 37, 3, 2, 3);
  rect(5, 39, 1, 1, 4);
  rect(5, 39, 7, 2, headY - 8);
  rect(5, 41, 6, 3, 2);
  rect(5, 43, 2, 2, 5);
  rect(5, 46, 1, 1, 4);
  rect(5, 44, 4, 3, 1);
  rect(7, 35, 7, 1, 5);
  if (away) rect(1, 33, headY + 1, 3, 10);
  return paths;
}

// Fox: long low torso, black stockings, pointed ears and a sweeping white-tipped brush.
function foxFrame(away: boolean, frame: number): Frame {
  const { paths, rect, contour } = painter();
  const stride = frame === 1 ? -2 : frame === 3 ? 2 : 0;
  const lift = frame === 2 || frame === 4 ? 1 : 0;
  const hy = away ? 8 : 10;
  contour(0, [[2, 11], [6, 13], [8, 17], [16, 18], [17, 23], [12, 26], [6, 23], [3, 18], [1, 16], [1, 11]]);
  contour(2, [[3, 13], [6, 16], [8, 19], [15, 19], [15, 22], [11, 24], [7, 21], [4, 17]]);
  rect(4, 2, 12, 3, 5); rect(7, 2, 12, 2, 2);
  for (const [x, far, step] of [[17, true, -stride], [31, true, stride], [14, false, stride], [33, false, -stride]] as const) {
    const end = far ? 30 - lift : 32;
    rect(0, x, 23, 3, end - 23); rect(far ? 1 : 2, x + 1, 23, 1, 4);
    rect(6, x + step, 28 - lift, 3, end - 28 + lift);
  }
  contour(0, [[15, 15], [25, 15], [29, 17], [35, 16], [38, 21], [35, 26], [22, 27], [13, 24], [12, 19]]);
  contour(2, [[16, 16], [25, 16], [29, 18], [34, 18], [36, 21], [33, 25], [23, 25], [14, 23], [14, 19]]);
  rect(3, 17, 17, 9, 2); rect(1, 17, 24, 14, 2);
  if (!away) rect(4, 29, 22, 6, 3);
  contour(0, [[29, hy + 3], [28, hy - 5], [32, hy - 2], [34, hy + 1], [37, hy - 6],
    [40, hy - 3], [40, hy + 4], [43, hy + 6], [46, hy + 7], [45, hy + 10], [37, hy + 12], [31, hy + 9]]);
  rect(1, 29, hy - 3, 2, 6); rect(2, 37, hy - 4, 2, 7); rect(5, 38, hy - 2, 1, 4);
  contour(2, [[31, hy + 2], [38, hy + 2], [39, hy + 5], [44, hy + 7], [43, hy + 9], [37, hy + 10], [32, hy + 7]]);
  contour(away ? 1 : 4, [[33, hy + 7], [36, hy + 8], [40, hy + 7], [44, hy + 8], [42, hy + 10], [36, hy + 11]]);
  rect(3, 32, hy + 3, 4, 2); rect(6, 39, hy + 4, 1, 2); rect(6, 44, hy + 7, 2, 2);
  return paths;
}

// Boar: heavy wedge-shaped shoulders, bristled ridge, short cloven legs and pale tusks.
function boarFrame(away: boolean, frame: number): Frame {
  const { paths, rect, contour } = painter();
  const stride = frame === 1 ? -2 : frame === 3 ? 2 : 0;
  const lift = frame === 2 || frame === 4 ? 1 : 0;
  const hy = away ? 14 : 17;
  for (const [x, far, step] of [[13, true, -stride], [29, true, stride], [9, false, stride], [32, false, -stride]] as const) {
    const end = far ? 33 - lift : 36;
    rect(0, x, 25, 5, end - 25); rect(far ? 1 : 2, x + 1, 26, 3, end - 28);
    rect(6, x + step, end - 3, 5, 3); rect(4, x + step + 2, end - 2, 1, 2);
  }
  rect(0, 2, 18, 3, 8); rect(1, 3, 18, 1, 6); rect(6, 1, 23, 3, 3);
  contour(0, [[7, 13], [16, 9], [26, 9], [32, 13], [36, 19], [36, 28], [28, 31], [13, 31], [5, 27], [4, 19]]);
  contour(2, [[8, 14], [17, 11], [25, 11], [31, 15], [34, 20], [33, 27], [27, 29], [13, 29], [6, 25], [6, 19]]);
  rect(1, 10, 27, 19, 3); rect(3, 10, 14, 9, 3); rect(3, 8, 17, 4, 4);
  for (let x = 13; x < 29; x += 3) { rect(0, x, 7 + (x % 2), 2, 5); rect(4, x, 10, 1, 2); }
  contour(0, [[29, hy], [30, hy - 7], [35, hy - 4], [37, hy], [39, hy - 5], [42, hy - 3],
    [41, hy + 5], [46, hy + 7], [46, hy + 13], [39, hy + 15], [32, hy + 12], [28, hy + 7]]);
  rect(1, 31, hy - 5, 2, 6); rect(5, 32, hy - 3, 1, 3);
  contour(2, [[31, hy + 1], [38, hy + 1], [40, hy + 6], [44, hy + 8], [44, hy + 12], [39, hy + 13], [33, hy + 10], [30, hy + 6]]);
  rect(away ? 1 : 3, 32, hy + 2, 4, 5); rect(6, 38, hy + 4, 2, 2);
  rect(5, 42, hy + 8, 3, 4); rect(6, 44, hy + 9, 1, 2);
  rect(7, 39, hy + 10, 2, 4); rect(7, 38, hy + 8, 1, 3);
  if (!away) rect(7, 43, hy + 12, 2, 2);
  return paths;
}

function getArt(species: AnimalSpecies): Art {
  const cached = artCache[species];
  if (cached) return cached;
  const draw = { rabbit: rabbitFrame, deer: deerFrame, fox: foxFrame, boar: boarFrame }[species];
  const frames = [false, true].flatMap((away) => Array.from({ length: 5 }, (_, frame) => draw(away, frame)));
  const shadow = Skia.Path.Make();
  const half = species === 'rabbit' ? 12 : 21;
  shadow.addRect(Skia.XYWHRect(-half + 4, -5, half * 2 - 8, 2));
  shadow.addRect(Skia.XYWHRect(-half, -3, half * 2, 4));
  shadow.addRect(Skia.XYWHRect(-half + 4, 1, half * 2 - 8, 2));
  const art = { frames, shadow };
  artCache[species] = art;
  return art;
}

type Pose = ReturnType<typeof animalSpritePose>;
function PixelLayer({ frames, ink, color, pose }: { frames: Frame[]; ink: number; color: string; pose: SharedValue<Pose> }) {
  const path = useDerivedValue(() => frames[(pose.value.away ? 5 : 0) + pose.value.frame][ink], [frames, ink, pose]);
  return <Path path={path} color={color} antiAlias={false} />;
}

/** Nine paths per animal, cached geometry, no intervals/React state/asset loading/native bitmap dependency. */
export function AnimalSprite({ animal, position, visual, clock }: AnimalSpriteProps) {
  const species = animal.species;
  const art = useMemo(() => getArt(species), [species]);
  const { w, h } = SIZE[species];
  const pose = useDerivedValue(() => animalSpritePose(visual.value, clock.value), [visual, clock]);
  const opacity = useDerivedValue(() => pose.value.alpha, [pose]);
  const world = useDerivedValue(() => [
    { translateX: Math.round((position.value.x - position.value.y) * 64) },
    { translateY: Math.round((position.value.x + position.value.y) * 32 - position.value.h * 64) },
  ], [position]);
  const body = useDerivedValue(() => [
    { translateY: pose.value.offsetY + pose.value.bob },
    { rotate: pose.value.rotation },
    { scaleY: pose.value.scaleY },
    { scaleX: pose.value.mirror },
    { translateX: -w / 2 },
    { translateY: -h },
  ], [pose, w, h]);
  return (
    <Group transform={world} opacity={opacity} antiAlias={false}>
      <Path path={art.shadow} color="#252b20" opacity={0.24} />
      <Group transform={body}>
        {PALETTES[species].map((color, ink) => <PixelLayer key={ink} frames={art.frames} ink={ink} color={color} pose={pose} />)}
      </Group>
    </Group>
  );
}
