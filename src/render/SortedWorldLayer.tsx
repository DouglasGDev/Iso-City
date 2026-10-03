import { memo, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Group, Image, Path } from '@shopify/react-native-skia';
import { useDerivedValue, useSharedValue, type SharedValue } from 'react-native-reanimated';
import { isAboard } from '../entities/Player';
import { depthOf, ELEVATION_PX, worldToScreen } from '../world/IsoUtils';
import { expandRect } from '../world/streaming/StreamingBounds';
import type { FogView } from '../systems/FogSystem';
import { GAME_CONFIG } from '../game/GameConfig';
import type { GameState } from '../game/GameState';
import { staticNodesFor, type StaticNode } from './ChunkStatics';
import { EntitySprite } from './EntitySprite';
import { resolveEntityImage } from './entityImages';
import { isNpcVisible } from '../entities/NPC';
import { animalVisualState, isAnimalVisible, type Animal } from '../entities/Animal';
import { AnimalSprite } from './AnimalSprite';
import { animalSVs } from './SharedValues';
import { SMOLDER_S, WreckSprite } from './WreckSprite';
import type { Wreck } from '../systems/DestructionSystem';

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
    {/* A sombra vai por baixo e FORA do recorte de oclusão: ela é tinta no chão, não
        fachada, então o buraco que abre a parede para mostrar o jogador não pode levá-la. */}
    {node.shade && <>
      <Path path={node.shade.penumbra} color="#20261f" opacity={0.17} />
      <Path path={node.shade.core} color="#1a201a" opacity={0.13} />
    </>}
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

function WildlifeSprite({ animal, game, clock }: {
  animal: Animal; game: GameState; clock: SharedValue<number>;
}) {
  const position = useSharedValue({
    x: animal.x, y: animal.y, h: game.map.heightSmoothAt(animal.x, animal.y),
  });
  // Ler `clock.value` aqui é o aviso que o Reanimated dá no aparelho ("Reading from `value` during
  // component render"), e ele dispara um por animal visível. A semente só serve ao primeiro desenho:
  // o efeito abaixo publica a pose real no commit, antes do primeiro quadro, e o GameLoop continua
  // escrevendo a cada tick. O `sampledAt` sem relógio não engana ninguém — só os mortos o leem,
  // interpolando no máximo 0.1s.
  const visual = useSharedValue(animalVisualState(animal, 0));
  useEffect(() => {
    visual.value = animalVisualState(animal, clock.value);
    animalSVs.set(animal.id, { position, visual });
    return () => { if (animalSVs.get(animal.id)?.position === position) animalSVs.delete(animal.id); };
  }, [animal.id, position, visual]);
  return <AnimalSprite animal={animal} position={position} visual={visual} clock={clock} />;
}

type DrawItem = { id: string; depth: number; node?: StaticNode; animal?: Animal; wreck?: Wreck };

function entityVisible(game: GameState, view: FogView, id: string, x: number, y: number, lift = 0) {
  const image = resolveEntityImage(id);
  if (!image) return false;
  const p = worldToScreen(x, y, game.map.heightSmoothAt(x, y));
  const w = Math.max(40, image.width()), h = Math.max(32, image.height());
  return game.fog.intersects(view, p.x - w / 2 - 32, p.y - h - lift - 16, w + 64, h + lift + 32);
}

function visibleItems(game: GameState, statics: StaticNode[]): DrawItem[] {
  const view = game.fog.view(game);
  // Profundidade com relevo: o tile elevado do morro da frente passa na frente de
  // quem está embaixo, exatamente como o losango dele aparece na tela.
  const depth = (x: number, y: number) => depthOf(x, y, game.map.heightSmoothAt(x, y));
  const items: DrawItem[] = [];
  // `statics` já é só o que mora nos chunks da tela: a filtragem abaixo decide o quadro,
  // não a existência. São dezenas de nós, não os 4.451 da cidade.
  for (const node of statics) {
    if (game.fog.intersects(view, node.sx - node.w / 2, node.sy - node.h, node.w, node.h)) {
      items.push({ id: node.id, depth: node.depth, node });
    }
  }
  game.streaming.stats.drawnStatics = items.length;
  if (!isAboard(game.player)) {
    items.push({ id: 'player', depth: depth(game.player.x, game.player.y) });
  }
  // Os candidatos vêm da grade de vizinhança, nunca da lista mundial: cada tipo tem seu
  // próprio buffer emprestado, então as quatro consultas não se derrubam entre si.
  // A janela é a visível dilatada até englobar o jogador. A câmera o segue, mas ela é medida
  // pelo ponto que mira, e no quadro em que ele entra num carro longe desse ponto o carro
  // dirigido sumiria da tela junto com ele — o recorte fino abaixo continua decidindo o que
  // de fato aparece, então alargar o candidato aqui não desenha nada a mais.
  const w = game.streaming.zones.visible;
  const p = game.player;
  const window = { minX: Math.min(w.minX, p.x - 1), minY: Math.min(w.minY, p.y - 1),
    maxX: Math.max(w.maxX, p.x + 1), maxY: Math.max(w.maxY, p.y + 1) };
  const { spatial } = game;  for (const i of spatial.query('npc', window)) {
    const n = game.npcs[i];
    if (!n || !isNpcVisible(n)) continue;
    if (entityVisible(game, view, `npc:${i}`, n.x, n.y)) {
      items.push({ id: `npc:${i}`, depth: depth(n.x, n.y) });
    }
  }
  // O helicóptero no teto aparece na tela muito antes de o tile dele entrar no footprint: a
  // projeção sobe `altitude * ELEVATION_PX` pixels, e em tiles de tela isso vale até a própria
  // cota máxima. A janela de carro é dilatada por esse alcance — senão o helicóptero entraria
  // voando pelo canto da tela com um sumiço no lugar.
  const vehWindow = expandRect(window, GAME_CONFIG.HELI_CEILING_ELEVATION);
  for (const i of spatial.query('veh', vehWindow)) {
    const v = game.vehicles[i];
    if (!v || v.state === 'destroyed') continue;
    if (game.player.currentVehicleId === v.id ||
      entityVisible(game, view, `veh:${i}`, v.x, v.y, v.altitude * ELEVATION_PX)) {
      items.push({ id: `veh:${i}`, depth: depth(v.x, v.y) + (v.altitude > 0.5 ? 1000 : 0) });
    }
  }
  // O ônibus da malha não é um Vehicle e não mora na grade `spatial`: a lista dele é o próprio
  // horário, curta (uma entrada por unidade de linha) e já cortada pelo portão de zona pelo
  // `live`. O recorte fino é o mesmo dos carros — névoa, projeção e profundidade do asfalto.
  const unidades = game.transport.units;
  for (let i = 0; i < unidades.length; i++) {
    const u = unidades[i];
    if (!u.live) continue;
    if (u.x < window.minX - 1 || u.x > window.maxX + 1) continue;
    if (u.y < window.minY - 1 || u.y > window.maxY + 1) continue;
    if (entityVisible(game, view, `bus:${i}`, u.x, u.y)) {
      items.push({ id: `bus:${i}`, depth: depth(u.x, u.y) });
    }
  }
  for (const i of spatial.query('animal', window)) {
    const animal = game.wildlife.animals[i];
    if (!animal || !isAnimalVisible(animal)) continue;
    const p = worldToScreen(animal.x, animal.y, game.map.heightSmoothAt(animal.x, animal.y));
    if (game.fog.intersects(view, p.x - 40, p.y - 65, 80, 90)) {
      items.push({ id: `animal:${animal.id}`, depth: depth(animal.x, animal.y), animal });
    }
  }
  for (const i of spatial.query('wreck', window)) {
    const wreck = game.destruction.wrecks[i];
    if (!wreck) continue;
    const p = worldToScreen(wreck.x, wreck.y, game.map.heightSmoothAt(wreck.x, wreck.y));
    if (game.fog.intersects(view, p.x - 46, p.y - 46, 92, 66)) {
      items.push({ id: `wreck:${i}`, depth: depth(wreck.x, wreck.y), wreck });
    }
  }
  game.streaming.stats.visibleEntities =
    items.length - game.streaming.stats.drawnStatics;
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
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((value) => value + 1), GAME_CONFIG.ENTITY_CULL_MS);
    return () => clearInterval(timer);
  }, [game]);
  const items = useMemo(() => {
    // É aqui que a cadeia fecha: câmera → chunks → nós residentes → recorte fino → Skia. O
    // orçamento de construção anda junto, então o anel de streaming se preenche sem nunca
    // atrasar o que já está na tela.
    const t0 = performance.now();
    const nodes = staticNodesFor(game, game.streaming);
    const result = visibleItems(game, nodes);
    game.streaming.stats.cullMs = Math.round((performance.now() - t0) * 100) / 100;
    return result;
  }, [game, version, tick]);

  // Chaves estáveis e o mesmo pai preservam os shared values ao mudar a ordem de profundidade.
  return (
    <Group>
      {items.map((item) => item.node
        ? <StaticSprite key={item.id} node={item.node} focus={focus} />
        : item.animal ? <WildlifeSprite key={item.id} animal={item.animal} game={game} clock={clock} />
          : item.wreck ? <WreckSprite key={item.id} wreck={item.wreck} clock={clock}
            h={game.map.heightSmoothAt(item.wreck.x, item.wreck.y)}
            smoking={game.time - item.wreck.explodedAt < SMOLDER_S} />
          : <EntitySprite key={item.id} id={item.id} />)}
    </Group>
  );
}
