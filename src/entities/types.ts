import type { Dir4 } from '../game/GameConfig';

export type EntityState =
  | 'idle'
  | 'walking'
  | 'running'
  | 'enteringVehicle'
  | 'driving'
  | 'shooting'
  | 'dead';

export interface Collider {
  x: number;
  y: number;
  width: number;
  height: number;
  type: 'PLAYER' | 'VEHICLE' | 'BUILDING' | 'FENCE' | 'PROP' | 'NPC';
  coverHeight?: number;
}

export type CharId = 'a' | 'b' | 'c';
export type CharAnim = 'idle' | 'walk' | 'swim';

export interface VehicleDef {
  type: 'sedan' | 'pickup' | 'van' | 'box' | 'truck' | 'police' | 'garbage' | 'bus_school' | 'firetruck' | 'swat' | 'helicopter' | 'taxi' | 'ambulance' | 'hatchback';
  colors: string[];
  baseKey: string;
  spriteW: number;
  spriteH: number;
  footprintW: number;
  footprintH: number;
  /** false = cenário / não entra (baú, helicóptero) */
  driveable: boolean;
}

export type VehicleDir4 = Dir4;
