import { Platform, type TextStyle } from 'react-native';

/**
 * A sombra de texto tem duas APIs e nenhuma serve aos dois lados:
 * `textShadowColor/Offset/Radius` é o que o RN 0.81 nativo conhece — o `textShadow` único
 * nem entra na conversão de estilos do lado de lá. Já o react-native-web lê as três antigas,
 * monta o CSS sozinho e avisa no console que estão obsoletas. Cada plataforma recebe, então,
 * a API que ela de fato aplica, com os mesmos números: o `0px 0px 3px #000` da web é exatamente
 * a string que a conversão antiga do próprio react-native-web produzia.
 */
export function readableShadow(color: string, width = 0, height = 0, radius = 3): TextStyle {
  return Platform.OS === 'web'
    // O tipo do RN ainda só descreve as três propriedades antigas; o valor é o CSS pronto.
    ? ({ textShadow: `${width}px ${height}px ${radius}px ${color}` } as TextStyle)
    : { textShadowColor: color, textShadowOffset: { width, height }, textShadowRadius: radius };
}
