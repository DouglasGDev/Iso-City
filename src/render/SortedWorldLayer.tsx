import { memo, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Group, Image, type SkImage } from '@shopify/react-native-skia';
import { useDerivedValue, useSharedValue, type SharedValue } from 'react-native-reanimated';
import { buildingKey, propKey } from '../assets/AssetRegistry';
import { spriteStore } from '../assets/SpriteStore';
import { BUILDING_GEOMETRY } from '../assets/BuildingGeometry';
import { depthOf, worldToScreen } from '../world/IsoUtils';
import type { FogView } from '../systems/FogSystem';
import { GAME_CONFIG } from '../game/GameConfig';
import type { GameState } from '../game/GameState';
import { EntitySprite } from './EntitySprite';
import { resolveEntityImage } from './entityImages';
import { isNpcVisible } from '../entities/NPC';
import { animalVisualState, isAnimalVisible, type Animal } from '../entities/Animal';
import { AnimalSprite } from './AnimalSprite';
import { animalSVs } from './SharedValues';
import { SMOLDER_S, WreckSprite } from './WreckSprite';
import type { Wreck } from '../systems/DestructionSystem';

interface StaticNode {
  id: string;
  img: SkImage;
  sx: number;
  sy: number;
  w: number;
  h: number;
  depth: number;
}

function buildStaticNodes(game: GameState): StaticNode[] {
  const nodes: StaticNode[] = [];
  for (const [i, b] of game.map.data.buildings.entries()) {
    const img = spriteStore[buildingKey(b.key)];
    if (!img) continue;
    const p = worldToScreen(b.x, b.y);
    const geometry = BUILDING_GEOMETRY[b.key];
    const scale = b.footprintW * 64 / geometry.span;
    const w = img.width() * scale, h = img.height() * scale;
    nodes.push({ id: `building:${i}`, img,
      sx: p.x + w / 2 - geometry.anchorX * scale, sy: p.y + h - geometry.anchorY * scale,
      w, h, depth: depthOf(b.x, b.y) });
  }
  for (const [i, pr] of game.map.data.props.entries()) {
    const img = spriteStore[propKey(pr.key)];
    if (!img) continue;
    const p = worldToScreen(pr.x, pr.y);
    const scale = pr.renderScale ?? 1;
    const w = img.width() * scale, h = img.height() * scale;
    const anchor = pr.renderAnchor ?? { x: 0.5, y: 1 };
    nodes.push({ id: `prop:${i}`, img, sx: p.x + w * (0.5 - anchor.x), sy: p.y + h * (1 - anchor.y),
      w, h, depth: depthOf(pr.x, pr.y) });
  }
  return nodes;
}

export interface OcclusionFocus {
  x: number;
  y: number;
  depth: number;
  active: boolean;
}

const BuildingSprite = memo(function BuildingSprite({ node, focus }: {
  node: StaticNode;
  focus: SharedValue<OcclusionFocus>;
}) {
  const { sx, sy, w, h, depth } = node;
  const opening = useDerivedValue(() => {
    const p = focus.value;
    const visible = p.active && depth > p.depth && p.x + 58 >= sx - w / 2 && p.x - 58 <= sx + w / 2 &&
      p.y + 34 >= sy - h && p.y - 64 <= sy;
    return { rect: { x: p.x - 58, y: p.y - 64, width: visible ? 116 : 0, height: visible ? 98 : 0 },
      rx: 58, ry: 49 };
  }, [sx, sy, w, h, depth, focus]);
  const sprite = <Image image={node.img} x={sx - w / 2} y={sy - h} width={w} height={h} fit="fill" />;
  return <Group>
    <Group clip={opening} invertClip>{sprite}</Group>
    <Group clip={opening} opacity={0.16}>{sprite}</Group>
  </Group>;
});

const StaticSprite = memo(function StaticSprite({ node, focus }: {
  node: StaticNode;
  focus: SharedValue<OcclusionFocus>;
}) {
  return node.id.startsWith('building:') ? <BuildingSprite node={node} focus={focus} />
    : <Image image={node.img} x={node.sx - node.w / 2} y={node.sy - node.h}
      width={node.w} height={node.h} fit="fill" />;
});

function WildlifeSprite({ animal, clock }: { animal: Animal; clock: SharedValue<number> }) {
  const position = useSharedValue({ x: animal.x, y: animal.y });
  const visual = useSharedValue(animalVisualState(animal, clock.value));
  useEffect(() => {
    animalSVs.set(animal.id, { position, visual });
    return () => { if (animalSVs.get(animal.id)?.position === position) animalSVs.delete(animal.id); };
  }, [animal.id, position, visual]);
  return <AnimalSprite animal={animal} position={position} visual={visual} clock={clock} />;
}

type DrawItem = { id: string; depth: number; node?: StaticNode; animal?: Animal; wreck?: Wreck };

function entityVisible(game: GameState, view: FogView, id: string, x: number, y: number, lift = 0) {
  const image = resolveEntityImage(id);
  if (!image) return false;
  const p = worldToScreen(x, y);
  const w = Math.max(40, image.width()), h = Math.max(32, image.height());
  return game.fog.intersects(view, p.x - w / 2 - 32, p.y - h - lift - 16, w + 64, h + lift + 32);
}

function visibleItems(game: GameState, statics: StaticNode[]): DrawItem[] {
  const view = game.fog.view(game);
  const items: DrawItem[] = statics.filter((n) => game.fog.intersects(view, n.sx - n.w / 2, n.sy - n.h, n.w, n.h))
    .map((node) => ({ id: node.id, depth: node.depth, node }));
  if (game.player.currentVehicleId === null) {
    items.push({ id: 'player', depth: depthOf(game.player.x, game.player.y) });
  }
  for (const [i, n] of game.npcs.entries()) {
    if (isNpcVisible(n) && entityVisible(game, view, `npc:${i}`, n.x, n.y)) {
      items.push({ id: `npc:${i}`, depth: depthOf(n.x, n.y) });
    }
  }
  for (const [i, v] of game.vehicles.entries()) {
    if (v.state === 'destroyed') continue;
    if (game.player.currentVehicleId === v.id || entityVisible(game, view, `veh:${i}`, v.x, v.y, v.altitude * 38)) {
      items.push({ id: `veh:${i}`, depth: depthOf(v.x, v.y) + (v.altitude > 0.5 ? 1000 : 0) });
    }
  }
  for (const animal of game.wildlife.animals) {
    const p = worldToScreen(animal.x, animal.y);
    if (isAnimalVisible(animal) && game.fog.intersects(view, p.x - 40, p.y - 65, 80, 90)) {
      items.push({ id: `animal:${animal.id}`, depth: depthOf(animal.x, animal.y), animal });
    }
  }
  for (const [i, wreck] of game.destruction.wrecks.entries()) {
    const p = worldToScreen(wreck.x, wreck.y);
    if (game.fog.intersects(view, p.x - 46, p.y - 46, 92, 66)) {
      items.push({ id: `wreck:${i}`, depth: depthOf(wreck.x, wreck.y), wreck });
    }
  }
  return items.sort((a, b) => a.depth - b.depth || a.id.localeCompare(b.id));
}

export function SortedWorldLayer({ game, focus, clock }: {
  game: GameState; focus: SharedValue<OcclusionFocus>; clock: SharedValue<number>;
}) {
  const version = useSyncExternalStore(
    (cb) => game.subscribeEntityChange(cb),
    () => game.entityVersion,
    () => game.entityVersion,
  );
  const allStatic = useMemo(() => buildStaticNodes(game), [game]);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((value) => value + 1), GAME_CONFIG.ENTITY_CULL_MS);
    return () => clearInterval(timer);
  }, [game]);
  const items = useMemo(() => visibleItems(game, allStatic), [game, allStatic, version, tick]);

  // Chaves estáveis e o mesmo pai preservam os shared values ao mudar a ordem de profundidade.
  return (
    <Group>
      {items.map((item) => item.node
        ? <StaticSprite key={item.id} node={item.node} focus={focus} />
        : item.animal ? <WildlifeSprite key={item.id} animal={item.animal} clock={clock} />
          : item.wreck ? <WreckSprite key={item.id} wreck={item.wreck} clock={clock}
            smoking={game.time - item.wreck.explodedAt < SMOLDER_S} />
          : <EntitySprite key={item.id} id={item.id} />)}
    </Group>
  );
}
