import type { SkPath } from '@shopify/react-native-skia';
import { worldToScreen } from '../world/IsoUtils';

/**
 * Sombra de contato — o sinal de altura que o hillshade não dá.
 *
 * O sol deste jogo é o do hillshade (`city.ts` / `GroundLayer.tsx`): luz entrando pelo
 * topo da tela. Descer na tela é andar para (+x,+y) no mundo, então toda sombra cai
 * verticalmente para baixo, sem ângulo lateral — é a mesma direção do borrão de copa
 * que o gerador já pinta embaixo das árvores.
 *
 * O que importa para o 2.5D é a FOLGA: a distância vertical entre o pé de quem anda e o
 * chão projetado. Quem está no chão cola a sombra no losango; quem salta, pisa num
 * terraço ou voa deixa a sombra no chão e afasta o corpo dela — é isso que vende altura
 * numa câmera que não pode se mover.
 */

/**Px de sombra por px de folga vertical. Baixo de propósito: sombra comprida em iso vira mancha. */
export const SUN_DROP_RATIO = 0.16;
/** Elipse de contato é o losango do chão: metade da largura em altura. */
export const SHADOW_FLATTEN = 0.5;
/** Meia-largura (px) da sombra de uma entidade, a partir da largura do próprio sprite. */
export function entityShadowWidth(spriteWidth: number) {
  'worklet';
  return Math.max(6, Math.min(26, spriteWidth * 0.36));
}

/**
 * Estado da sombra para uma folga `gap` em px de tela. Não é física de sol: é leitura.
 * Longe do chão a sombra escorrega para baixo, some um pouco e encolhe — nessa ordem.
 */
export function contactShadow(gap: number) {
  'worklet';
  const up = Math.max(0, gap);
  return {
    drop: up * SUN_DROP_RATIO,
    fade: 1 - Math.min(0.8, up / 260),
    spread: 1 - Math.min(0.35, up / 600),
  };
}

/**
 * Losango do lote, deslocado para baixo: o prédio cobre a maior parte e a fresta que
 * sobra embaixo da base é exatamente o que se lê como "este prédio pisa neste chão".
 * Roda no JS thread (nascida no `buildStaticNodes`), por isso não precisa de 'worklet'
 * para as funções dela — mas usa a projeção oficial, senão a sombra não bate com o
 * colisor do lote.
 */
export function lotShadow(path: SkPath, x: number, y: number, side: number,
  groundH: number, drop: number) {
  // O lote é o quadrado [x-side, x] × [y-side, y] (mesma definição do colisor em Map.ts).
  const corners = [[x - side, y - side], [x, y - side], [x, y], [x - side, y]];
  corners.forEach(([cx, cy], i) => {
    const p = worldToScreen(cx, cy, groundH);
    if (i === 0) path.moveTo(p.x, p.y + drop);
    else path.lineTo(p.x, p.y + drop);
  });
  path.close();
}

/** A sombra cresce com a altura desenhada, mas nunca vira lista de supermercado. */
export function buildingShadowDrop(drawnHeight: number) {
  return Math.min(18, Math.max(2.5, drawnHeight * 0.055));
}
