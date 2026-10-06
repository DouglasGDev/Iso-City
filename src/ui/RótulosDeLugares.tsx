import { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { getGame } from '../game/GameState';
import { makeProjectors } from '../world/MapPresentation';
import { readableShadow } from './textShadow';

/**
 * Os nomes no mapa cheio.
 *
 * O `MapCanvas` já dizia tudo sobre o terreno: asfalto, matagal, água, e o glifo de cada
 * lugar entrável. O que ele não dizia, e o jogador precisa dizer em voz alta para combinar um
 * encontro, é *o nome do lugar*. Este componente é a única camada de texto do instrumento, e
 * é RN (`<Text>`) e não Skia de propósito: o projeto desenha sem fonte carregada havia
 * dezenas de milhares de frames, e um `useFonts` aqui custaria um `.ttf` novo no bundle, um
 * boot que pode não voltar no mobile, e ainda entregaria um texto sem o ajuste de DPI e o
 * anti-aliasing que o sistema dá de graça — que é exatamente o que faz um rótulo de mapa
 * parecer mapa.
 *
 * O que decide se um nome aparece é geometria, não lista. Um rótulo só entra quando:
 *
 * 1. o retângulo projetado do lugar **comporta** o próprio nome — ninguém lê "Jardim Aurora"
 *    espremido em 14 pixels de losango, e um nome cortado pela metade ensina o jogador a não
 *    confiar no mapa;
 * 2. o centro do lugar já foi **explorado** — o nome é a recompensa de ter ido, e é a mesma
 *    regra da tinta do chão, lida do mesmo `ExplorationSystem`. Rótulo de terra onde você
 *    nunca pisou seria o mapa contando o fim do jogo;
 * 3. ele **não briga** com um rótulo já aceito. A ordem é a de tamanho na tela (o bairro
 *    grande antes da travessa miúda), então o que sobrevive ao teste de interseção é sempre o
 *    nome mais informativo, não o que o gerador enumerou primeiro.
 *
 * Placa de rua só entra em zoom fundo. Na cidade inteira as dezenas de vias somem debaixo dos
 * bairros, e um mapa onde tudo está escrito é um mapa onde nada está legível.
 */

/** O mesmo viewport que `MapCanvas` e `PontosDeInteresse` já recebem. */
interface Vista {
  mapW: number;
  mapH: number;
  zoom: number;
  panX: number;
  panY: number;
}

/** Abaixo disto o mapa é de orientação, não de endereço: nenhuma placa é desenhada. */
const ZOOM_DA_PLACA = 3;
/** Largura média de um glifo como fração do corpo. Chute honesto: só decide folga, e folga a
 *  mais nunca corta um nome — apenas adia o rótulo para o próximo nível de zoom. */
const LARGURA_DA_LETRA = 0.62;
/** Iso 2:1: para cada tile andado para leste a tela desce meio pixel, e a placa acompanha. */
const ÂNGULO_DA_RUA = 26.57;
const SENO_DA_RUA = Math.sin((ÂNGULO_DA_RUA * Math.PI) / 180);
/** A folga que o nome precisa deixar nas pontas do losango para não vazar pelo asfalto vizinho. */
const FOLGA_DO_LOSANGO = 0.9;

interface Caixa { x: number; y: number; w: number; h: number; }

interface Rotulo {
  chave: string;
  texto: string;
  x: number;
  y: number;
  w: number;
  h: number;
  corpo: number;
  rotate: number;
  estilo: 'bairro' | 'zona' | 'rio' | 'rua';
}

function encostada(a: Caixa, b: Caixa): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

const clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n));

/** A largura que a fonte do sistema vai gastar, estimada em vez de medida: medir texto no
 *  RN exige layout assíncrono, e o mapa redraw a cada arrasto de dedo. */
function larguraDoNome(texto: string, corpo: number): number {
  return texto.length * corpo * LARGURA_DA_LETRA;
}

export function RótulosDeLugares({ mapW, mapH, zoom, panX, panY }: Vista) {
  const game = getGame();
  const lugares = game.map.data.lugares;
  // Além do pan e do zoom, a única coisa que pode acender um nome novo é a descoberta.
  const descoberta = game.exploration.version;
  const rótulos = useMemo(() => {
    if (!lugares || game.interiors.active) return [];
    const dados = game.map.data;
    const { worldToScreen } = makeProjectors(mapW, mapH, 0, dados.tilesW, dados.tilesH,
      zoom, panX, panY);
    const aceitos: Caixa[] = [];
    const out: Rotulo[] = [];
    const pisado = (x: number, y: number) =>
      game.exploration.isExplored(Math.floor(x), Math.floor(y));

    /** O teste único das três regras acima: cabe na caixa, está fora do corte da tela, e não
     *  atropela ninguém. `inclinada` mede o traço já virado, porque placa torta ocupa mais
     *  altura de tela do que a própria altura do corpo. */
    const tentar = (caixa: Caixa, rect: Caixa, rotulo: Rotulo, inclinada: boolean) => {
      if (caixa.x > mapW || caixa.y > mapH || caixa.x + caixa.w < 0 || caixa.y + caixa.h < 0) return;
      if (rect.w > caixa.w * FOLGA_DO_LOSANGO || rect.h > caixa.h * FOLGA_DO_LOSANGO) return;
      const cobra = inclinada ? { ...rect, h: rect.h + rect.w * SENO_DA_RUA } : rect;
      if (aceitos.some((r) => encostada(r, cobra))) return;
      aceitos.push(cobra);
      out.push(rotulo);
    };

    const distritos = [...lugares.distritos].sort((a, b) =>
      (b.x1 - b.x0) * (b.y1 - b.y0) - (a.x1 - a.x0) * (a.y1 - a.y0));
    for (const d of distritos) {
      if (!pisado(d.cx, d.cy)) continue;
      const cantos = [worldToScreen(d.x0, d.y0), worldToScreen(d.x1, d.y0),
        worldToScreen(d.x1, d.y1), worldToScreen(d.x0, d.y1)];
      const x0 = Math.min(...cantos.map((c) => c.x)), x1 = Math.max(...cantos.map((c) => c.x));
      const y0 = Math.min(...cantos.map((c) => c.y)), y1 = Math.max(...cantos.map((c) => c.y));
      const caixa = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
      const centro = worldToScreen(d.cx, d.cy);
      // O rio é uma faixa, não um lote: corpo pequeno sempre, senão o nome vaza pela margem.
      const corpo = d.especie === 'rio' ? 10 : Math.round(clamp(caixa.h / 5, 9, 15));
      const w = larguraDoNome(d.nome, corpo), h = corpo * 1.35;
      tentar(caixa, { x: centro.x - w / 2, y: centro.y - h / 2, w, h },
        { chave: `d${d.id}`, texto: d.nome, x: centro.x, y: centro.y, w, h, corpo,
          rotate: 0, estilo: d.especie }, false);
    }

    if (zoom < ZOOM_DA_PLACA) return out;
    for (const v of lugares.vias) {
      const ao = (v.de + v.ate) / 2;
      const faixa = (v.faixa0 + v.faixa1) / 2;
      const wx = v.eixo === 'ns' ? faixa : ao;
      const wy = v.eixo === 'ns' ? ao : faixa;
      if (!pisado(wx, wy)) continue;
      const centro = worldToScreen(wx, wy);
      const corpo = v.rank === 'highway' || v.rank === 'avenue' ? 11 : 9.5;
      const w = larguraDoNome(v.nome, corpo), h = corpo * 1.35;
      const rect = { x: centro.x - w / 2, y: centro.y - h / 2, w, h };
      // A régua da placa é o próprio trecho visível: uma viela de cinco tiles não tem rua
      // onde deitar "Rua Pitangueira", e um nome cortado no meio do quarteirão é pior que
      // nenhum nome. As pontas do trecho projetadas dão o comprimento real na tela.
      const a = worldToScreen(v.eixo === 'ns' ? faixa : v.de, v.eixo === 'ns' ? v.de : faixa);
      const b = worldToScreen(v.eixo === 'ns' ? faixa : v.ate, v.eixo === 'ns' ? v.ate : faixa);
      const trecho = Math.hypot(b.x - a.x, b.y - a.y);
      tentar({ x: centro.x - trecho / 2, y: centro.y - 48, w: trecho, h: 96 }, rect,
        { chave: `v${v.id}`, texto: v.nome, x: centro.x, y: centro.y, w, h, corpo,
          rotate: v.eixo === 'ew' ? ÂNGULO_DA_RUA : -ÂNGULO_DA_RUA, estilo: 'rua' }, true);
    }
    return out;
  }, [game, lugares, mapW, mapH, zoom, panX, panY, descoberta]);

  if (!rótulos.length) return null;
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none" testID="map-labels">
      {rótulos.map((r) => (
        <Text key={r.chave} numberOfLines={1} style={[styles.base, styles[r.estilo], {
          left: r.x - r.w / 2, top: r.y - r.h / 2, width: r.w, height: r.h, lineHeight: r.h,
          fontSize: r.corpo, transform: [{ rotate: `${r.rotate}deg` }],
        }]}>{r.texto}</Text>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  base: {
    position: 'absolute',
    textAlign: 'center',
    includeFontPadding: false,
    ...readableShadow('#04080c', 0, 1, 3),
  },
  bairro: { color: '#f2fbf8', fontWeight: '800', letterSpacing: 0.3 },
  zona: { color: '#cfe4d6', fontWeight: '700', letterSpacing: 0.6 },
  rio: { color: '#a9d8ea', fontWeight: '700', fontStyle: 'italic', letterSpacing: 1.2 },
  rua: { color: '#e6d3ae', fontWeight: '700', letterSpacing: 0.2, opacity: 0.92 },
});
