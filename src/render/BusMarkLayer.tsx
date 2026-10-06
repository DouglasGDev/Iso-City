import { memo, useEffect, useMemo, useState } from 'react';
import { Circle, Group, Path, RoundedRect, Skia, type SkPath } from '@shopify/react-native-skia';
import { useDerivedValue, type SharedValue } from 'react-native-reanimated';
import type { GameState } from '../game/GameState';
import { fleetNumber } from '../data/transport/network';
import { entitySVs, type EntitySV } from './SharedValues';
import { worldToScreen } from '../world/IsoUtils';
import { GAME_CONFIG } from '../game/GameConfig';

/**
 * Identificação do ônibus na rua. Três coisas, e as três existem para a mesma pergunta do
 * jogador: "é este?" A placa com o número da linha responde na calçada e de longe, entre os
 * dois sentidos da mesma avenida; a matrícula no teto responde quando já há um número lido no
 * telão para procurar entre as latarias paradas na baia; a cor da faixa diz de que viação é o
 * corpo, que é como se lê uma frota antes de ler qualquer placa. A seta grande responde quando
 * há um plano de viagem, e marca o veículo que serve a passada prometida — não o mais perto,
 * não o da mesma linha.
 */

/** Grade 5×7 de lâmpadas, linha a linha. A Skia do mundo não desenha fonte: traço é o que há. */
const DIGITOS: Record<string, string[]> = {
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['01110', '10000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00001', '01110'],
};

const LAMPADA = 1.5;
const PASSO_DA_LAMPADA = 2.2;
const ALTURA_DA_PLACA = 17;

/**
 * Uma placa por rótulo de linha, construída uma única vez e centralizada na origem: há ~20
 * linhas na cidade e o caminho é lido por todos os carros dela, então o custo de desenho é
 * um, não um por ônibus por quadro.
 */
const placas = new Map<string, { path: SkPath; largura: number }>();
function placaDaLinha(rotulo: string): { path: SkPath; largura: number } {
  const existente = placas.get(rotulo);
  if (existente) return existente;
  const colunas = rotulo.length * 5 + (rotulo.length - 1);
  const largura = 6 + colunas * PASSO_DA_LAMPADA;
  const path = Skia.Path.Make();
  rotulo.split('').forEach((char, d) => {
    const grade = DIGITOS[char];
    if (!grade) return;
    grade.forEach((linha, r) => {
      for (let c = 0; c < linha.length; c++) {
        if (linha[c] !== '1') continue;
        const x = (d * 6 + c) * PASSO_DA_LAMPADA - (colunas * PASSO_DA_LAMPADA) / 2;
        const y = (r - 3) * PASSO_DA_LAMPADA;
        path.addRect(Skia.XYWHRect(x, y, LAMPADA, LAMPADA));
      }
    });
  });
  const criada = { path, largura };
  placas.set(rotulo, criada);
  return criada;
}

let setaGrande: SkPath | null = null;
/**
 * A seta: um bloco grosso apontando para o ônibus, em coordenadas locais, 28×30 pixels sobre
 * um corpo de 55 — é grande de propósito. Uma marca discreta sobre lataria em movimento some
 * na cena, e o que o jogador pergunta não é "qual destes é bonito", é "em qual eu entro".
 */
function seta(): SkPath {
  if (setaGrande) return setaGrande;
  const p = Skia.Path.Make();
  p.moveTo(-6, -16);
  p.lineTo(6, -16);
  p.lineTo(6, 0);
  p.lineTo(14, 0);
  p.lineTo(0, 15);
  p.lineTo(-14, 0);
  p.lineTo(-6, 0);
  p.close();
  setaGrande = p;
  return p;
}

const BOARD_BEZEL = '#0f1216';
const LED = '#ffc861';
const SETA = '#ffe14a';
const SETA_CONTORNO = '#3a2c07';
/** A matrícula é tinta escura sobre a cor da viação: é o contraste do número na lataria. */
const MATRÍCULA = '#14181d';
const ESCALA_DA_MATRÍCULA = 0.62;

const Mark = memo(function Mark({ sv, clock, rotulo, matrícula, cor, traço, alvo, opaca }: {
  sv: SharedValue<EntitySV>;
  clock: SharedValue<number>;
  rotulo: string;
  matrícula: string;
  cor: string;
  traço: string;
  alvo: boolean;
  /** Quanta marca sobra depois da nuvem que há entre o olho e este corpo. */
  opaca: number;
}) {
  const { path, largura } = useMemo(() => placaDaLinha(rotulo), [rotulo]);
  const placa = useMemo(() => placaDaLinha(matrícula), [matrícula]);
  const chao = useDerivedValue(() => {
    const p = sv.value;
    return worldToScreen(p.x, p.y, p.h);
  }, [sv]);
  // A placa nasce acima do teto (o sprite do ônibus tem 55 pixels de corpo) e a seta, mais
  // acima ainda, respira: um marcador parado no meio de um monte de lataria em movimento é
  // lido como cenário, e o que se procura é um aviso.
  const quadro = useDerivedValue(() => [
    { translateX: chao.value.x }, { translateY: chao.value.y - 66 },
  ], [chao]);
  // A faixa de matrícula vai colada no corpo, abaixo da placa de linha: no ônibus de verdade o
  // número da garagem é tinta do teto, não um letreiro luminoso, e por isso ele é menor, escuro
  // e pintado na cor da viação — quem procura o 117 no pátio lê a lataria, não o display.
  const quadroMatrícula = useDerivedValue(() => [
    { translateX: chao.value.x }, { translateY: chao.value.y - 46 },
    { scale: ESCALA_DA_MATRÍCULA },
  ], [chao]);
  const salto = useDerivedValue(() => -Math.abs(Math.sin(clock.value * 3.1)) * 9, [clock]);
  const setaTransform = useDerivedValue(() => [
    { translateX: chao.value.x }, { translateY: chao.value.y - 92 + salto.value },
  ], [chao, salto]);

  return (
    <Group opacity={opaca}>
      <Group transform={quadro}>
        <RoundedRect x={-largura / 2} y={-ALTURA_DA_PLACA / 2} width={largura}
          height={ALTURA_DA_PLACA} r={2.5} color={BOARD_BEZEL} />
        <RoundedRect x={-largura / 2 + 1.4} y={-ALTURA_DA_PLACA / 2 + 1.4} width={largura - 2.8}
          height={ALTURA_DA_PLACA - 2.8} r={1.6} color="#1b1f26" />
        <Path path={path} color={LED} opacity={0.96} />
      </Group>
      <Group transform={quadroMatrícula}>
        <RoundedRect x={-placa.largura / 2 - 4} y={-11} width={placa.largura + 8} height={22}
          r={3} color={cor} />
        <RoundedRect x={-placa.largura / 2 - 4} y={-11} width={placa.largura + 8} height={22}
          r={3} color={traço} style="stroke" strokeWidth={1.6} />
        <Path path={placa.path} color={MATRÍCULA} />
      </Group>
      {alvo ? (
        <Group transform={setaTransform}>
          <Circle cx={0} cy={6} r={22} color={SETA} opacity={0.16} />
          <Path path={seta()} color={SETA_CONTORNO} style="stroke" strokeWidth={2.4} />
          <Path path={seta()} color={SETA} />
        </Group>
      ) : null}
    </Group>
  );
});

/**
 * Placas e seta dos ônibus da malha. Fica por cima de toda a cena (é tinta de aviso, não
 * objeto do mundo) e segue o corpo pelo mesmo shared value de 60 fps que o sprite usa: uma
 * seta que anda no ritmo do culling, e não no do asfalto, escorregaria do ônibus no momento
 * em que o jogador mais precisa dela — quando ele encosta.
 *
 * Por pintar depois da manta, a marca é a única tinta do transporte que sobreviveria a um voo
 * alto: sem pagar a nuvem do próprio ponto, a placa de um ônibus invisível ficava pregada no
 * meio do algodão. Ela não é cenário, é aviso de um corpo que já foi tapado.
 */
export function BusMarkLayer({ game, clock }: { game: GameState; clock: SharedValue<number> }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const iv = setInterval(() => setTick((t) => t + 1), GAME_CONFIG.ENTITY_CULL_MS);
    return () => clearInterval(iv);
  }, []);

  const alvo = game.busTarget();
  const view = game.fog.view(game);
  const unidades = game.transport.units;
  const network = game.transport.network;
  // A cota de quem olha vem da coluna de ar, não do chão: é a laje entre o olho e AQUELE ônibus
  // que decide se a placa existe na tela, e a laje tem buraco. Uma marca do outro lado do algodão
  // não é um aviso — é um fantasma pregado num teto de nuvem.
  const ar = game.altitude.snapshot;
  const desenhados: {
    i: number; rotulo: string; matrícula: string; cor: string; traço: string;
    opaca: number; sv: SharedValue<EntitySV>;
  }[] = [];
  for (let i = 0; i < unidades.length; i++) {
    const u = unidades[i];
    if (!u.live) continue;
    if (!game.streaming.isInView(u.x, u.y)) continue;
    const chao = game.map.heightSmoothAt(u.x, u.y);
    const p = worldToScreen(u.x, u.y, chao);
    if (!game.fog.intersects(view, p.x - 40, p.y - 100, 80, 110)) continue;
    const coberta = game.altitude.obstrucao(u.x, u.y, ar.cota, chao, game.time);
    if (coberta > 0.98) continue;
    // O corpo só tem placa se tiver corpo: o shared value é o do sprite, escrito pelo laço do
    // relógio. Sem ele a marca ficaria pregada num ponto do asfalto enquanto o ônibus some.
    const sv = entitySVs.get(`bus:${i}`);
    if (!sv) continue;
    const route = network.routes[u.route];
    const nome = route?.name ?? '';
    const digitos = nome.match(/\d+/g);
    if (!route || !digitos) continue;
    const via = network.companies[route.company];
    desenhados.push({
      i, rotulo: digitos.join(''), matrícula: fleetNumber(route, u.unit),
      cor: via.livery, traço: via.stripe, opaca: 1 - coberta, sv,
    });
  }

  return (
    <Group>
      {desenhados.map((d) => (
        <Mark key={`mk${d.i}`} sv={d.sv} clock={clock} rotulo={d.rotulo} opaca={d.opaca}
          matrícula={d.matrícula} cor={d.cor} traço={d.traço} alvo={d.i === alvo} />
      ))}
    </Group>
  );
}
