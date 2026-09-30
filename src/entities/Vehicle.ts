import type { Dir4 } from '../game/GameConfig';
import type { VehicleDef } from './types';
import { spriteKeyForVehicle } from '../assets/AssetRegistry';
import { dirToAngle } from '../world/IsoUtils';

export type VehicleState = 'parked' | 'driving' | 'destroyed';

export interface Vehicle {
  id: number;
  def: VehicleDef;
  color: string;
  x: number;
  y: number;
  dir: Dir4;
  facingAngle: number;
  speed: number;
  health: number;
  occupied: boolean;
  state: VehicleState;
  turnTimer: number;
  flashing: number;
  /** Frame do rotor (1|2) para helicóptero; 0 = sprite base */
  animFrame: 0 | 1 | 2;
  animTimer: number;
  /** Altura ACIMA DO CHÃO debaixo do nariz. Toda a cidade lê isto como "está no ar". */
  altitude: number;
  /**
   * Cota absoluta em tiles acima do nível 0 do mundo — é isto que o piloto comanda.
   * `altitude` sai dela subtraindo o chão local: sobrevoar um morro encurta a folga
   * sem que a máquina tenha descido um palmo.
   */
  elevation: number;
}

export function createVehicle(
  id: number,
  def: VehicleDef,
  color: string,
  x: number,
  y: number,
  dir: Dir4,
): Vehicle {
  const isHeli = def.type === 'helicopter';
  return {
    id,
    def,
    color,
    x,
    y,
    dir,
    facingAngle: dirToAngle(dir),
    speed: 0,
    health: 100,
    occupied: false,
    state: 'parked',
    turnTimer: 0,
    flashing: 0,
    animFrame: isHeli ? 1 : 0,
    animTimer: 0,
    altitude: 0,
    elevation: 0,
  };
}

export function vehicleSpriteKey(v: Vehicle): string {
  const rotor = v.def.type === 'helicopter' ? (v.animFrame === 0 ? 1 : v.animFrame) : 0;
  return spriteKeyForVehicle(v.def, v.color, v.dir, rotor);
}
