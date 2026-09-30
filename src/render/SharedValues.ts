import type { SharedValue } from 'react-native-reanimated';
import type { AnimalVisualState } from '../entities/Animal';

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
