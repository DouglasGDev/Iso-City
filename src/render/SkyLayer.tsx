import { LinearGradient, Rect } from '@shopify/react-native-skia';
import { useDerivedValue, type SharedValue } from 'react-native-reanimated';
import type { SkySnapshot } from '../systems/AltitudeSystem';

/**
 * O ar entre a câmera e o que está desenhado.
 *
 * Não existe "fundo de céu" numa projeção isométrica: a câmera olha para baixo, o mundo preenche o
 * quadro inteiro, e um gradiente azul plantado atrás do chão seria coberto por tile até o último
 * canto — pintura morta. O que existe, e o que a altitude de verdade muda, é o ar no MEIO: a
 * perspectiva aérea. Quanto mais alto, mais o chão perde contraste e vira uma ficha azulada, e
 * dentro da nuvem isso deixa de ser tinta e passa a ser a parede.
 *
 * É por isso que esta camada é um lavado de tela e não um plano: um único Rect sobre o mundo, com o
 * alpha máximo dos dois fenômenos que ele sabe descrever — a bruma suavizada da coluna (a parede
 * branca de quem está dentro do algodão) e a distância geométrica de quem está só muito alto.
 */
export function SkyWash({ sky, width, height }: {
  sky: SharedValue<SkySnapshot>;
  width: number;
  height: number;
}) {
  // O termo de altitude é discreto de propósito: 0.42 é "a cidade lá embaixo está pálida", não
  // "sumiu". Quem some com a cidade é a manta, e ela tem camada própria.
  const opacity = useDerivedValue(
    () => Math.max(sky.value.bruma, (1 - sky.value.cidade) * 0.42), [sky]);
  return (
    <Rect x={0} y={0} width={width} height={height} opacity={opacity}>
      {/* Claro em cima, mais fundo embaixo: a luz vem do lado para onde você olhou, e é isso que
          separa um lavado de tela de um filtro de foto. */}
      <LinearGradient start={{ x: 0, y: 0 }} end={{ x: 0, y: height }}
        colors={['#f1f6fd', '#c8dcef']} positions={[0, 1]} />
    </Rect>
  );
}
