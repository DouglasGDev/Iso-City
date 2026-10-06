import { memo, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Group, Image, Path } from '@shopify/react-native-skia';
import { useDerivedValue, useSharedValue, type SharedValue } from 'react-native-reanimated';
import { isAboard } from '../entities/Player';
import { depthOf, worldToScreen } from '../world/IsoUtils';
import { expandRect } from '../world/streaming/StreamingBounds';
import type { FogView } from '../systems/FogSystem';
import { ALTURA_DE_TELA_MAX, liftDeTela } from '../systems/AltitudeSystem';
import { GAME_CONFIG } from '../game/GameConfig';
import type { GameState } from '../game/GameState';
import { staticNodesFor, type StaticNode } from './ChunkStatics';
import { frontierNodesFor } from './FrontierStatics';
import { triboNodesFor, type TriboNode } from './TriboStatics';
import { caixaDoNodo, TriboSprite } from './TriboSprite';
import { EntitySprite } from './EntitySprite';
import { resolveEntityImage } from './entityImages';
import { isNpcVisible } from '../entities/NPC';
import { animalVisualState, isAnimalVisible, type Animal } from '../entities/Animal';
import { AnimalSprite } from './AnimalSprite';
import { animalSVs, gorilaSVs, piranhaSVs, guerreiroSVs } from './SharedValues';
import { gorilaVisível, gorilaVisualState, type Gorila } from '../entities/Gorila';
import { GorilaSprite } from './GorilaSprite';
import { piranhaVisível, piranhaVisualState, type Piranha } from '../entities/Piranha';
import { PiranhaSprite } from './PiranhaSprite';
import { guerreiroVisualState, type Guerreiro } from '../entities/Guerreiro';
import { GuerreiroSprite, caixaDoGuerreiro } from './GuerreiroSprite';
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

/**
 * O gigante da fronteira. Mesmo contrato da fauna: um par de SharedValues registrado por id, e o
 * corpo mutável nunca atravessa para a UI thread.
 *
 * Ele tem de ser seu próprio componente porque `WildlifeSprite` é construído sobre um `Animal`, e o
 * modelo do gorila fala `vida/morto/raio` — se entrasse no array da fauna, o laço de publicação que
 * chama `animalVisualState` leria campos que não existem e a fera sumiria da tela em silêncio.
 */
function GorilaViva({ gorila, game, clock }: {
  gorila: Gorila; game: GameState; clock: SharedValue<number>;
}) {
  const position = useSharedValue({
    x: gorila.x, y: gorila.y, h: game.map.heightSmoothAt(gorila.x, gorila.y),
  });
  const visual = useSharedValue(gorilaVisualState(gorila, 0));
  useEffect(() => {
    visual.value = gorilaVisualState(gorila, clock.value);
    gorilaSVs.set(gorila.id, { position, visual });
    return () => { if (gorilaSVs.get(gorila.id)?.position === position) gorilaSVs.delete(gorila.id); };
  }, [gorila.id, position, visual]);
  return <GorilaSprite gorila={gorila} position={position} visual={visual} clock={clock} />;
}

/**
 * A barbatana do rio sem fim. O mesmo contrato do gigante: um par de `SharedValue` por id, e o
 * corpo mutável fica do lado da simulação.
 *
 * Ela não poderia entrar na fauna nem no `GorilaViva` por um motivo que é de modelo, não de
 * organização: `piranhaVisualState` lê `estado/velocidade/raio` de um peixe que passa a vida
 * dentro de um canal de seis tiles, e os dois laços acima chamam funções que não conhecem esses
 * campos. Um componente próprio é o que mantém a fila de sprites honesta.
 */
function PiranhaViva({ peixe, game, clock }: {
  peixe: Piranha; game: GameState; clock: SharedValue<number>;
}) {
  const position = useSharedValue({
    x: peixe.x, y: peixe.y, h: game.map.heightSmoothAt(peixe.x, peixe.y),
  });
  const visual = useSharedValue(piranhaVisualState(peixe, 0));
  useEffect(() => {
    visual.value = piranhaVisualState(peixe, clock.value);
    piranhaSVs.set(peixe.id, { position, visual });
    return () => { if (piranhaSVs.get(peixe.id)?.position === position) piranhaSVs.delete(peixe.id); };
  }, [peixe.id, position, visual]);
  return <PiranhaSprite piranha={peixe} position={position} visual={visual} clock={clock} />;
}

/**
 * Um guerreiro da aldeia. O mesmo contrato do gigante e da barbatana: um par de `SharedValue` por id,
 * e o corpo mutável fica do lado da simulação — o `Guerreiro` é um objeto vivo que o bando escreve a
 * cada tick, e a UI thread não pode capturar isso.
 *
 * Ele não podia entrar na fauna nem no `GorilaViva` por motivo de modelo, não de arrumação: o laço
 * deles chama `animalVisualState`/`gorilaVisualState`, que leem `health`/`vida` e nada de `posto`,
 * `trilhoθ` ou `carrega`. E não podia ser desenhado pela camada do acampamento (`TriboSprite`), que é
 * estática e por célula: aí os corpos ficariam sempre atrás ou sempre na frente do jogador, e a cena
 * que a aldeia existe para dar — um sentinela passando por trás da fogueira enquanto você entra pela
 * boca — deixaria de existir. É a mesma razão da mata sem fim, e é por ela que ele entra na fila.
 */
function GuerreiroViva({ guerreiro, game, clock }: {
  guerreiro: Guerreiro; game: GameState; clock: SharedValue<number>;
}) {
  const position = useSharedValue({
    x: guerreiro.x, y: guerreiro.y, h: game.map.heightSmoothAt(guerreiro.x, guerreiro.y),
  });
  // A mesma lição do `WildlifeSprite`: ler `clock.value` em props é o aviso do Reanimated no
  // aparelho, e aqui ele dispararia um por sentinela visível — nove na aldeia grande.
  const visual = useSharedValue(guerreiroVisualState(guerreiro, 0));
  useEffect(() => {
    visual.value = guerreiroVisualState(guerreiro, clock.value);
    guerreiroSVs.set(guerreiro.id, { position, visual });
    return () => { if (guerreiroSVs.get(guerreiro.id)?.position === position) guerreiroSVs.delete(guerreiro.id); };
  }, [guerreiro.id, position, visual]);
  return <GuerreiroSprite guerreiro={guerreiro} position={position} visual={visual} clock={clock} />;
}

type DrawItem = { id: string; depth: number; node?: StaticNode; animal?: Animal; gorila?: Gorila;
  piranha?: Piranha; guerreiro?: Guerreiro; wreck?: Wreck; tribo?: TriboNode };

function entityVisible(game: GameState, view: FogView, id: string, x: number, y: number, lift = 0) {
  const image = resolveEntityImage(id);
  if (!image) return false;
  const p = worldToScreen(x, y, game.map.heightSmoothAt(x, y));
  const w = Math.max(40, image.width()), h = Math.max(32, image.height());
  return game.fog.intersects(view, p.x - w / 2 - 32, p.y - h - lift - 16, w + 64, h + lift + 32);
}

function visibleItems(game: GameState, statics: StaticNode[], mata: StaticNode[],
  aldeia: TriboNode[]): DrawItem[] {
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
  // A mata sem fim vem na mesma fila, e por um motivo que não é arrumação: um tronco desenhado
  // numa camada própria estaria sempre na frente ou sempre atrás do jogador, e quem anda entre
  // duas pinheiras tem de ser tapado pela que está mais perto da câmera. São `StaticNode` do
  // mesmo formato, ordenados pela mesma profundidade e descartados pelo mesmo recorte.
  for (const node of mata) {
    if (game.fog.intersects(view, node.sx - node.w / 2, node.sy - node.h, node.w, node.h)) {
      items.push({ id: node.id, depth: node.depth, node });
    }
  }
  // O acampamento entra na mesma fila pelo mesmo motivo da mata, e com um a mais: uma cabana
  // desenhada antes de `SortedWorldLayer` estaria sempre atrás do jogador, e a cena que este lugar
  // existe para dar — alguém entrando pela boca, passando entre a fogueira e a casa grande — é
  // exatamente a que uma camada fixa não desenha. A caixa vem de `caixaDoNodo`, e não de um número
  // escrito aqui, porque é a arte que sabe o próprio tamanho: se o telhado crescer, o recorte
  // cresce junto.
  for (const node of aldeia) {
    const b = caixaDoNodo(node);
    if (game.fog.intersects(view, b.x, b.y, b.width, b.height)) {
      items.push({ id: node.id, depth: node.depth, tribo: node });
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
  // projeção sobe a folga de tela, e ela não é mais `altitude * 64` — acima da mão-de-passagem a
  // curva satura em `ALTURA_DE_TELA_MAX` tiles de tela por construção. A janela de carro é dilatada
  // por esse alcance, que é o máximo real: dilatá-la pela cota do céu (46) pagaria custo de consulta
  // por pixels que nunca vão existir, e dilatá-la pelo teto isométrico velho sumiria com o aparelho
  // que passa voando pelo canto da tela.
  const vehWindow = expandRect(window, ALTURA_DE_TELA_MAX);
  for (const i of spatial.query('veh', vehWindow)) {
    const v = game.vehicles[i];
    if (!v || v.state === 'destroyed') continue;
    const chao = game.map.heightSmoothAt(v.x, v.y);
    if (game.player.currentVehicleId === v.id ||
      entityVisible(game, view, `veh:${i}`, v.x, v.y, liftDeTela(chao + v.altitude, chao))) {
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
  // A fera não está na grade `spatial` — é um indivíduo por mundo e a lista dela é o próprio
  // sistema. A caixa é a do sprite (96x112) folgada na copa e no braço erguido: um soco levanta
  // o corpo 10 px acima do quadro, e um recorte justo ao tronco cortaria o punho no alto.
  const fera = game.gorilas.fera;
  if (fera && gorilaVisível(fera)) {
    const p = worldToScreen(fera.x, fera.y, game.map.heightSmoothAt(fera.x, fera.y));
    if (game.fog.intersects(view, p.x - 56, p.y - 132, 112, 152)) {
      items.push({ id: `gorila:${fera.id}`, depth: depth(fera.x, fera.y), gorila: fera });
    }
  }
  // A caixa é a do quadro (140x84) folgada na cabeça do salto: o corpo sobe ~30 px acima da linha
  // d'água na dentada, e um recorte justo à silhueta boiando cortaria o bote no meio — justo o
  // quadro que o jogador precisa ver. É a mesma caixa que o `piranhaContext` usa para o som e para
  // a esteira, e ela ser a mesma não é coincidência: o que se ouve tem de ser o que se vê.
  const peixe = game.piranhas.fera;
  if (peixe && piranhaVisível(peixe)) {
    const p = worldToScreen(peixe.x, peixe.y, game.map.heightSmoothAt(peixe.x, peixe.y));
    if (game.fog.intersects(view, p.x - 78, p.y - 120, 156, 132)) {
      items.push({ id: `piranha:${peixe.id}`, depth: depth(peixe.x, peixe.y), piranha: peixe });
    }
  }
  // O bando também não está na grade `spatial`: os corpos moram dentro do `Bando`, e a lista deles é
  // o getter do sistema — que já devolve só quem merece ser desenhado (vivos e os cadáveres dentro do
  // prazo do fade) e ordenado por id, então a fila aqui é determinística e o recorte fino decide o
  // resto. A caixa vem de `caixaDoGuerreiro`, e não de um número escrito aqui: é o mesmo contrato do
  // acampamento, a arte é que sabe o próprio tamanho, e o windup do porrete levanta tinta acima do
  // quadro — um recorte justo ao tronco cortaria o braço no quadro que antecede o golpe.
  for (const corpo of game.tribos.guerreiros) {
    const p = worldToScreen(corpo.x, corpo.y, game.map.heightSmoothAt(corpo.x, corpo.y));
    const b = caixaDoGuerreiro(p.x, p.y);
    if (game.fog.intersects(view, b.x, b.y, b.width, b.height)) {
      items.push({ id: `guerreiro:${corpo.id}`, depth: depth(corpo.x, corpo.y), guerreiro: corpo });
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

export function SortedWorldLayer({ game, focus, clock, children }: {
  game: GameState; focus: SharedValue<OcclusionFocus>; clock: SharedValue<number>;
  children?: ReactNode;
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
    const result = visibleItems(game, nodes, frontierNodesFor(game), triboNodesFor(game));
    game.streaming.stats.cullMs = Math.round((performance.now() - t0) * 100) / 100;
    return result;
  }, [game, version, tick]);

  // A manta é um plano no MEIO do olhar, e o olhar aponta para baixo: entre a câmera e o chão, o
  // que está mais perto do olho é o algodão. Então ele tem de ser pintado depois da cidade — antes
  // disso o predio sai por cima do céu fechado e o "mar de nuvens" vira um lençol estendido no
  // chão, que foi exatamente o que a fotografia do navegador mostrou. O `children` é o encaixe:
  // quem decide o que é o plano é o GameCanvas, quem sabe a ordem de profundidade somos nós.
  //
  // Voar por cima da manta continua possível: o aparelho que passou da barriga do algodão sai do
  // grupo do chão e entra no de cima. Abaixo da barriga ele pertence à cidade, e é ela que a nuvem
  // engole — que é a outra metade do fenômeno: sumir na manta não é efeito de tinta, é estar atrás.
  // Com o céu aberto a lista nem se divide, e a ordem de sempre continua idêntica quadro a quadro.
  const { chao, ar } = useMemo(() => {
    if (game.altitude.doCeu < 0.02) return { chao: items, ar: [] as typeof items };
    const baixo: typeof items = [];
    const cima: typeof items = [];
    for (const it of items) {
      const v = it.id.startsWith('veh:') ? game.vehicles[Number(it.id.slice(4))] : undefined;
      if (v && v.altitude + game.map.heightSmoothAt(v.x, v.y) > game.altitude.daBase) cima.push(it);
      else baixo.push(it);
    }
    return { chao: baixo, ar: cima };
  }, [items, game]);

  const desenha = (item: (typeof items)[number]) => item.node
    ? <StaticSprite key={item.id} node={item.node} focus={focus} />
    : item.animal ? <WildlifeSprite key={item.id} animal={item.animal} game={game} clock={clock} />
      : item.gorila ? <GorilaViva key={item.id} gorila={item.gorila} game={game} clock={clock} />
      : item.piranha ? <PiranhaViva key={item.id} peixe={item.piranha} game={game} clock={clock} />
      : item.guerreiro ? <GuerreiroViva key={item.id} guerreiro={item.guerreiro} game={game} clock={clock} />
      : item.wreck ? <WreckSprite key={item.id} wreck={item.wreck} clock={clock}
        h={game.map.heightSmoothAt(item.wreck.x, item.wreck.y)}
        smoking={game.time - item.wreck.explodedAt < SMOLDER_S} />
      : item.tribo ? <TriboSprite key={item.id} node={item.tribo} clock={clock} />
      : <EntitySprite key={item.id} id={item.id} />;

  // Chaves estáveis e o mesmo pai preservam os shared values ao mudar a ordem de profundidade.
  return (
    <Group>
      <Group>{chao.map(desenha)}</Group>
      {children}
      <Group>{ar.map(desenha)}</Group>
    </Group>
  );
}
