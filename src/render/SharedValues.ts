import type { SharedValue } from 'react-native-reanimated';
import type { AnimalVisualState } from '../entities/Animal';
import type { GorilaVisualState } from '../entities/Gorila';
import type { PiranhaVisualState } from '../entities/Piranha';

export interface CameraSV {
  x: number;
  y: number;
  zoom: number;
  /** Altura do chão sob a câmera: ela acompanha o morro, senão o jogador cola no topo da tela. */
  h: number;
}

export interface EntitySV {
  x: number;
  y: number;
  /**
   * Altura do chão sob a entidade, em tiles. O laço de simulação é o único que conhece
   * o mapa, então é ele quem entrega o `h` pronto para a worklet — no UI thread não há
   * Map para consultar.
   */
  h: number;
  /**
   * Pixels de tela que o corpo fica ACIMA do próprio chão. É escrito pelo laço de simulação e não
   * por cada sprite porque a conta deixou de ser um `altitude * 64`: acima da linha de passagem a
   * altura para de virar translação, e a curva que decide isso mora num lugar só.
   */
  lift?: number;
}

let cameraSV: SharedValue<CameraSV> | null = null;

export function registerCameraSV(sv: SharedValue<CameraSV>) {
  cameraSV = sv;
}

export function getCameraSV(): SharedValue<CameraSV> {
  if (!cameraSV) {
    throw new Error('cameraSV not registered yet');
  }
  return cameraSV;
}

export const entitySVs = new Map<string, SharedValue<EntitySV>>();
export const animalSVs = new Map<number, { position: SharedValue<EntitySV>; visual: SharedValue<AnimalVisualState> }>();
/**
 * O gigante tem a sua própria fila por um motivo que não é organização: ele não mora no array
 * `animals` (o modelo dele fala `vida/morto/raio`, não `health/dead/radius`), então o laço que
 * publica a fauna não tem o que ler. Um indivíduo por mundo, e a chave é o id dele.
 */
export const gorilaSVs = new Map<number, { position: SharedValue<EntitySV>; visual: SharedValue<GorilaVisualState> }>();
/**
 * A barbatana tem a sua própria fila pelo mesmo motivo do gigante: ela também não mora no array
 * `animals`, e o modelo dela fala `estado/vida/morto`. Um indivíduo por mundo — o rio não cria
 * dois ao mesmo tempo, e a fila de sprites é o que denunciaria isso na tela.
 */
export const piranhaSVs = new Map<number, { position: SharedValue<EntitySV>; visual: SharedValue<PiranhaVisualState> }>();
