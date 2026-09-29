import type { SharedValue } from 'react-native-reanimated';
import type { AnimalVisualState } from '../entities/Animal';

export interface CameraSV {
  x: number;
  y: number;
  zoom: number;
}

export interface EntitySV {
  x: number;
  y: number;
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
