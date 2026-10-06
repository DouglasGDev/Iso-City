import { useEffect, useRef } from 'react';
import { Group, Oval, Path, Skia, type SkPath, type Transforms3d } from '@shopify/react-native-skia';
import { useDerivedValue, useSharedValue, type SharedValue } from 'react-native-reanimated';
import { GAME_CONFIG } from '../game/GameConfig';
import { ELEVATION_PX, worldToScreen } from '../world/IsoUtils';
import { alturaDeTela, type SkySnapshot } from '../systems/AltitudeSystem';
import type { GameState } from '../game/GameState';

/**
 * A manta desenhada.
 *
 * O teto de nuvem não é uma textura nem um plano: é o MESMO campo que o movimento, a câmera e a
 * polícia consultam, amostrado numa grade grossa em volta da câmera. Por isso o buraco existe — a
 * cidade reaparece por cima do ombro no meio de um céu fechado e some de novo trinta segundos
 * depois, porque o buraco é um lugar, não um efeito.
 *
 * A manta vive no ESPAÇO DO MUNDO, dentro do grupo da câmera, e a altura dela passa pela curva
 * saturada como a do aparelho. É isso que faz o algodão ficar embaixo de você em vez de fugir para
 * fora do quadro conforme ele sobe: nuvem e lataria obedecem à mesma compressão, e a paralaxe sai
 * de graça — quem anda é a câmera, não o desenho.
 *
 * Vista de baixo, porém, uma laje a quatorze tiles de cota não tem para onde ir nesta projeção: o
 * quadro é um losango visto de cima, não um céu. Então o que a barriga da manta vira quando você
 * está na rua é a única coisa que uma isometria sabe ler de um teto de nuvem — SOMBRA passando
 * sobre a cidade. O mesmo campo, carimbado no chão, andando com o vento.
 */

/** Fatores 2:1 de `worldToScreen`: um tile de raio é 64px na horizontal e 32 na vertical. */
const LASURA_X = 64;
const LASURA_Y = 32;
/** Seis reconstruções por segundo: a manta é lenta, e o laço de simulação é quem tem o campo. */
const REDE_MS = 160;
/**
 * A espessura que o algodão MOSTRA, em tiles de tela. Não é a espessura da nuvem — essa o piloto
 * atravessa de verdade e ela tem treze tiles — é a franja entre a barriga e o lombo no desenho.
 * Pintar a distância física empurra o lombo duzentos pixels para cima, e a barriga sobra em lasca
 * pelo buraco que o próprio lombo abre: duas folhas soltas no céu em vez de um volume.
 */
const FRANJA = 0.5;

export interface CloudPaint {
  /** Quádruplos (cx, cy, rx, ry) já em tela do grupo da câmera, no plano da BARRIGA da manta. */
  manta: SharedValue<number[]>;
  /** Os mesmos quádruplos no plano do chão: o vulto que a manta planta sobre a cidade. */
  chao: SharedValue<number[]>;
  /** Pixels de tela entre a barriga e o lombo: a franja que faz volume, não a espessura do ar. */
  espessura: SharedValue<number>;
  /** Sombra do casco sobre o lombo (coords de tela, raio em tiles; `a` = 0 sem voo alto). */
  sombra: SharedValue<{ x: number; y: number; r: number; a: number }>;
  /** Força da sombra no chão, já com a cobertura do dia. Zero desliga a camada inteira. */
  forca: SharedValue<number>;
}

/**
 * Reconstrói a manta seis vezes por segundo no laço de simulação. O UI thread não tem campo de
 * nuvem, não tem câmera e não tem mapa: o que ele recebe é tela pronta e três números, e o worklet
 * que desenha não decide nada.
 */
export function useCloudPaint(game: GameState, size: { width: number; height: number }): CloudPaint {
  const manta = useSharedValue<number[]>([]);
  const chao = useSharedValue<number[]>([]);
  const espessura = useSharedValue(0);
  const sombra = useSharedValue({ x: 0, y: 0, r: 0, a: 0 });
  const forca = useSharedValue(0);

  useEffect(() => {
    const limpa = () => {
      if (manta.value.length > 0) manta.value = [];
      if (chao.value.length > 0) chao.value = [];
      if (forca.value !== 0) forca.value = 0;
      if (sombra.value.a !== 0) sombra.value = { ...sombra.value, a: 0 };
    };
    const iv = setInterval(() => {
      const ar = game.altitude;
      // Céu limpo ou porta fechada: caminho vazio, e as duas camadas somam zero pixel pintado —
      // não adianta ter opacity baixo se o traçado continua carregando duzentas elipses.
      if (game.interiors.active || ar.doCeu < 0.02) {
        limpa();
        return;
      }
      const cam = game.camera;
      const zoom = Math.max(0.2, cam.zoom);
      const h = alturaDeTela(ar.daBase);
      // O losango visível, resolvido para o pior caso dos dois eixos. A grade engrossa junto com
      // ele: lá em cima o zoom abre e o quadro pede duas vezes e meia mais mundo.
      // Falta ainda a diferença de plano: a manta é pintada em alturaDeTela(daBase), não no plano da
      // câmera, e esse desnível sobe o projetor do algodão na tela. Sem pagá-lo a borda que o jogador
      // vê no canto do quadro é a borda da AMOSTRA, não o fim da nuvem — um recorte reto atravessando
      // o céu, que é assinatura de grade e nunca de fenômeno. Um tile de desnível custa dois de
      // alcance: o deslocamento é vertical (h*ELEVATION_PX) e a conta de (x+y) divide por LASURA_Y,
      // que é a metade exata de ELEVATION_PX.
      const alcance = size.width / (2 * LASURA_X * zoom) + size.height / (2 * LASURA_Y * zoom)
        + 2 * Math.abs(h - cam.h) + GAME_CONFIG.NUVEM_PINTURA;
      // Nove e não dez: com o desnível pago, dez casas por eixo passam de vinte células e a lista
      // encosta no teto de bolhas do pinta(), que corta por linha e deixaria a última faixa do céu
      // sem algodão nenhum — a borda de novo, agora por orçamento.
      const passo = Math.max(GAME_CONFIG.NUVEM_PINTURA, Math.ceil(alcance / 9));
      const lista: number[] = [];
      const vultos: number[] = [];
      for (const b of ar.pinta(cam.x, cam.y, alcance, game.time, passo)) {
        const q = worldToScreen(b.x, b.y, h);
        lista.push(q.x, q.y, b.r * LASURA_X, b.r * LASURA_Y);
        // A sombra gruda no relevo: plantada no plano zero ela boiaria sobre o morro e cortaria a
        // encosta, que é exatamente o detalhe que denuncia um efeito em vez de um fenômeno.
        const g = worldToScreen(b.x, b.y, game.map.heightSmoothAt(b.x, b.y));
        vultos.push(g.x, g.y, b.r * LASURA_X, b.r * LASURA_Y);
      }
      manta.value = lista;
      chao.value = vultos;
      // Pouca cobertura é algodão frouxo, não laje: a força acompanha o céu que o clima tem hoje.
      forca.value = Math.min(0.3, ar.doCeu * 0.36);
      espessura.value = Math.min(alturaDeTela(ar.doTopo) - h, FRANJA) * ELEVATION_PX;
      // A sombra do casco sobre o lombo é a única coisa que diz, acima de tudo, que o aparelho ainda
      // está SOBRE algo. Ela mora no plano da barriga porque quem a desenha está no grupo que sobe
      // a espessura até o topo.
      const s = ar.snapshot;
      if (s.cota > s.topo - 3) {
        const q = worldToScreen(cam.x, cam.y, h);
        sombra.value = { x: q.x, y: q.y, r: 2.1, a: 1 };
      } else if (sombra.value.a !== 0) {
        sombra.value = { ...sombra.value, a: 0 };
      }
    }, REDE_MS);
    return () => clearInterval(iv);
  }, [game, size.width, size.height, manta, chao, espessura, sombra, forca]);

  return { manta, chao, espessura, sombra, forca };
}

/**
 * O traçado a partir dos quádruplos publicados. Rebobinado, não recriado: um `Skia.Path.Make()` por
 * quadro é memória wasm que ninguém devolve ao heap, e este aqui é lido a todo quadro com o céu
 * fechado ou aberto.
 */
function useMantaPath(quadros: SharedValue<number[]>) {
  const caixa = useRef<SkPath | null>(null);
  return useDerivedValue(() => {
    if (!caixa.current) caixa.current = Skia.Path.Make();
    const path = caixa.current;
    path.rewind();
    const q = quadros.value;
    for (let i = 0; i + 3 < q.length; i += 4) {
      path.addOval(Skia.XYWHRect(q[i] - q[i + 2], q[i + 1] - q[i + 3], q[i + 2] * 2, q[i + 3] * 2));
    }
    return path;
  }, [quadros]);
}

/**
 * O mar de nuvens: para quem está acima dele é o chão, e para quem está subindo é a parede que
 * fecha por cima do telhado. Entra no MEIO da camada ordenada — depois da cidade, antes do que
 * passou da barriga do algodão — porque numa câmera que olha para baixo o plano mais alto é o mais
 * perto do olho. Pintado antes dos prédios, ele não é céu: é lençol estendido no chão.
 */
export function CloudSea({ paint, sky }: { paint: CloudPaint; sky: SharedValue<SkySnapshot> }) {
  const path = useMantaPath(paint.manta);
  const opacity = useDerivedValue(() => sky.value.fechamento, [sky]);
  const lombo = useDerivedValue<Transforms3d>(
    () => [{ translateY: -paint.espessura.value }], [paint]);
  const sombraTransform = useDerivedValue<Transforms3d>(() => {
    const sh = paint.sombra.value;
    return [{ translateX: sh.x }, { translateY: sh.y }, { scale: sh.r }];
  }, [paint]);
  const sombraOpacity = useDerivedValue(
    () => paint.sombra.value.a * sky.value.acima * (1 - sky.value.dentro) * 0.34, [sky, paint]);
  return (
    <Group opacity={opacity}>
      {/* A barriga primeiro, no plano em que a grade foi amostrada, e o lombo uma espessura acima:
          duas faces do mesmo traçado são o volume do algodão sem segunda malha nenhuma. */}
      <Path path={path} style="fill" color="#b6c2d2" />
      <Group transform={lombo}>
        <Path path={path} style="fill" color="#f4f7fc" />
        <Group transform={sombraTransform} opacity={sombraOpacity}>
          <Oval x={-LASURA_X} y={-LASURA_Y} width={LASURA_X * 2} height={LASURA_Y * 2} color="#3a4763" />
          <Oval x={-LASURA_X / 2} y={-LASURA_Y / 2} width={LASURA_X} height={LASURA_Y} color="#2a3550" />
        </Group>
      </Group>
    </Group>
  );
}

/** O vulto da manta atravessando a cidade: é assim que um dia nublado se lê numa projeção sem céu. */
export function CloudShadows({ paint, sky }: { paint: CloudPaint; sky: SharedValue<SkySnapshot> }) {
  const path = useMantaPath(paint.chao);
  // Passou do lombo, a sombra acabou: quem está sobre a manta não tem mais cidade para ensombrar.
  const opacity = useDerivedValue(() => paint.forca.value * (1 - sky.value.acima), [paint, sky]);
  return (
    <Group opacity={opacity}>
      <Path path={path} style="fill" color="#2a3550" />
    </Group>
  );
}
