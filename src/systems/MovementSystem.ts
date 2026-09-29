import { GAME_CONFIG, type Dir4 } from '../game/GameConfig';
import { inputState } from '../game/InputState';
import { DIR_VECTORS, angleToWorldDir, dirToAngle, screenToWorld } from '../world/IsoUtils';
import type { Player } from '../entities/Player';
import { vehicleGroundCollider, type CollisionSystem } from './CollisionSystem';
import type { Map } from '../world/Map';
import type { Vehicle } from '../entities/Vehicle';
import type { Collider } from '../entities/types';
import { CROUCH_SPEED } from './CrouchSystem';

export const FENCE_CLEARANCE_PX = 12;
export const MAX_VAULT_FENCE_THICKNESS = 0.4;

export function isLowFence(c: Collider): boolean {
  return c.type === 'FENCE' && Math.min(c.width, c.height) <= MAX_VAULT_FENCE_THICKNESS;
}

/** Conservative vehicle footprints, also used to certify a vault's entire route. */
export function solidVehicleColliders(vehicles: readonly Vehicle[]): Collider[] {
  return vehicles.filter((v) => v.state !== 'destroyed' && !(v.altitude > 0.5)).map(vehicleGroundCollider);
}

/** Shared by ordinary locomotion and JumpSystem's certified vault, not vehicles. */
export function movePlayerGround(
  player: Player, map: Map, collision: CollisionSystem, dx: number, dy: number,
  vehicles: readonly Vehicle[] = [],
) {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
  const radius = GAME_CONFIG.PLAYER_RADIUS;
  // Thin fences/walls must not be tunneled through during a long simulation tick.
  const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / (radius * 0.5)));
  const sx = dx / steps;
  const sy = dy / steps;
  const cars = solidVehicleColliders(vehicles);
  const clearFence = player.jumpTimer > 0 && player.jumpEnd !== null &&
    player.jumpHeight >= FENCE_CLEARANCE_PX;
  const resolve = () => {
    const nearby = map.queryNearby(player.x, player.y, radius + 0.2);
    const obstacles = clearFence ? nearby.filter((c) => !isLowFence(c)) : nearby;
    const circle = { x: player.x, y: player.y, radius };
    collision.resolveCircle(circle, obstacles.concat(cars));
    player.x = Math.max(radius, Math.min(map.worldW - radius, circle.x));
    player.y = Math.max(radius, Math.min(map.worldH - radius, circle.y));
  };
  for (let step = 0; step < steps; step++) {
    if (Math.abs(sx) > 1e-8) { player.x += sx; resolve(); }
    if (Math.abs(sy) > 1e-8) { player.y += sy; resolve(); }
  }
}

const TWO_PI = Math.PI * 2;

function angleDiff(from: number, to: number): number {
  let d = to - from;
  while (d <= -Math.PI) d += TWO_PI;
  while (d > Math.PI) d -= TWO_PI;
  return d;
}

export class MovementSystem {
  constructor(
    private collision: CollisionSystem,
    private getVehicles: () => readonly Vehicle[] = () => [],
  ) {}

  updatePlayer(player: Player, map: Map, dt: number, runAllowed?: boolean) {
    if (player.currentVehicleId !== null || player.health <= 0 ||
        player.state === 'driving' || player.state === 'enteringVehicle' || player.state === 'dead') {
      player.vx = 0;
      player.vy = 0;
      return;
    }
    if (!Number.isFinite(dt) || dt <= 0) return;
    // Only a guided vault owns horizontal motion. Ordinary jumps retain controls
    // and solid fences, so they cannot drift into an uncertified landing.
    if (player.jumpTimer > 0 && player.jumpEnd !== null) {
      player.vx = 0;
      player.vy = 0;
      player.speed = 0;
      return;
    }

    const { dx, dy, magnitude } = inputState;
    const runHeld = !player.crouching && (runAllowed === undefined ? inputState.runHeld : runAllowed);
    const dead = GAME_CONFIG.JOYSTICK_DEADZONE;
    const mag = magnitude;
    const inWater = map.isWaterWorld(player.x, player.y);

    let desiredVx = 0;
    let desiredVy = 0;
    let moving = false;
    let targetAngle = player.facingAngle;

    if (mag > dead) {
      const nx = dx / mag;
      const ny = dy / mag;
      const t = Math.min(1, (mag - dead) / (1 - dead));
      const curve = t * t * (3 - 2 * t);
      const maxSpeed = inWater
        ? GAME_CONFIG.PLAYER_SWIM_SPEED
        : player.crouching ? CROUCH_SPEED
        : runHeld ? GAME_CONFIG.PLAYER_RUN_SPEED : GAME_CONFIG.PLAYER_WALK_SPEED;
      // Inverse of (worldX-worldY)*64, (worldX+worldY)*32.
      const { x: wx, y: wy } = screenToWorld(nx, ny);
      const wlen = Math.hypot(wx, wy) || 1;
      desiredVx = (wx / wlen) * maxSpeed * curve;
      desiredVy = (wy / wlen) * maxSpeed * curve;
      moving = true;

      // ângulo alvo suave (sem snap)
      targetAngle = Math.atan2(wy, wx);

      player.direction = angleToWorldDir(targetAngle);
      player.walkDir = player.direction;
    }

    // interpola facingAngle suavemente
    const turnSpeed = GAME_CONFIG.PLAYER_TURN_SPEED;
    const maxStep = turnSpeed * dt;
    const diff = angleDiff(player.facingAngle, targetAngle);
    if (Math.abs(diff) > maxStep) {
      player.facingAngle += diff > 0 ? maxStep : -maxStep;
    } else {
      player.facingAngle = targetAngle;
    }
    player.facingAngle = ((player.facingAngle % TWO_PI) + TWO_PI) % TWO_PI;

    if (moving) {
      const k = Math.min(1, GAME_CONFIG.PLAYER_ACCEL * dt);
      player.vx += (desiredVx - player.vx) * k;
      player.vy += (desiredVy - player.vy) * k;
    } else {
      const damp = Math.exp(-GAME_CONFIG.PLAYER_FRICTION * dt);
      player.vx *= damp;
      player.vy *= damp;
      if (Math.hypot(player.vx, player.vy) < 0.08) {
        player.vx = 0;
        player.vy = 0;
      }
    }

    // Folding out of a sprint must not retain running speed, even on a tiny tick.
    const speed = Math.hypot(player.vx, player.vy);
    if (player.crouching && !inWater && speed > CROUCH_SPEED) {
      player.vx *= CROUCH_SPEED / speed;
      player.vy *= CROUCH_SPEED / speed;
    }
    player.speed = Math.hypot(player.vx, player.vy);
    if (player.speed > 0.12 && !(mag > dead)) {
      targetAngle = Math.atan2(player.vy, player.vx);
      const diff2 = angleDiff(player.facingAngle, targetAngle);
      if (Math.abs(diff2) > maxStep) {
        player.facingAngle += diff2 > 0 ? maxStep : -maxStep;
      } else {
        player.facingAngle = targetAngle;
      }
    }

    movePlayerGround(player, map, this.collision, player.vx * dt, player.vy * dt, this.getVehicles());
    player.swimming = map.isWaterWorld(player.x, player.y);
    if (player.swimming) {
      player.anim = 'swim';
      player.state = player.speed > 0.08 ? 'walking' : 'idle';
    } else if (player.speed > 0.12) {
      player.anim = 'walk';
      player.state = player.speed > GAME_CONFIG.PLAYER_WALK_SPEED * 1.12 ? 'running' : 'walking';
    } else {
      player.anim = 'idle';
      player.state = 'idle';
      player.frame = 0;
      player.animTimer = 0;
    }
  }

  updateVehicle(vehicle: Vehicle, map: Map, dt: number) {
    if (vehicle.def.type === 'helicopter') {
      this.updateHelicopter(vehicle, map, dt);
      return;
    }
    const { vehicleAccel, vehicleBrake, vehicleLeft, vehicleRight } = inputState;
    const maxSpeed = GAME_CONFIG.VEHICLE_MAX_SPEED;
    const reverseMax = maxSpeed * GAME_CONFIG.VEHICLE_REVERSE_RATIO;

    if (vehicleAccel && !vehicleBrake) {
      if (vehicle.speed < 0) {
        vehicle.speed = Math.min(0, vehicle.speed + GAME_CONFIG.VEHICLE_BRAKE * 1.6 * dt);
      } else {
        vehicle.speed = Math.min(maxSpeed, vehicle.speed + GAME_CONFIG.VEHICLE_ACCEL * dt);
      }
    } else if (vehicleBrake) {
      if (vehicle.speed > 0.02) {
        vehicle.speed = Math.max(0, vehicle.speed - GAME_CONFIG.VEHICLE_BRAKE * dt);
      } else {
        vehicle.speed = Math.max(-reverseMax, vehicle.speed - GAME_CONFIG.VEHICLE_REVERSE_ACCEL * dt);
      }
    } else {
      if (vehicle.speed > 0) {
        vehicle.speed = Math.max(0, vehicle.speed - GAME_CONFIG.VEHICLE_COAST * dt);
      } else if (vehicle.speed < 0) {
        vehicle.speed = Math.min(0, vehicle.speed + GAME_CONFIG.VEHICLE_COAST * dt);
      }
      if (Math.abs(vehicle.speed) < GAME_CONFIG.VEHICLE_STOP_EPS) vehicle.speed = 0;
    }

    // Só troca de faixa iso (90°) com o carro já andando — nunca gira parado
    const movingAbs = Math.abs(vehicle.speed);
    const wantTurn = (vehicleLeft && !vehicleRight) || (vehicleRight && !vehicleLeft);
    if (wantTurn && movingAbs >= GAME_CONFIG.VEHICLE_TURN_MIN_SPEED) {
      const reverse = vehicle.speed < 0;
      const turn = () => {
        if (vehicleLeft) vehicle.dir = reverse ? TURN_CW[vehicle.dir] : TURN_CCW[vehicle.dir];
        else vehicle.dir = reverse ? TURN_CCW[vehicle.dir] : TURN_CW[vehicle.dir];
      };
      if (vehicle.turnTimer <= 0) {
        turn();
        vehicle.turnTimer = 0.001;
      } else {
        vehicle.turnTimer += dt;
        if (vehicle.turnTimer >= GAME_CONFIG.VEHICLE_TURN_STEP_S) {
          vehicle.turnTimer = 0.001;
          turn();
        }
      }
    } else {
      vehicle.turnTimer = 0;
    }

    vehicle.facingAngle = dirToAngle(vehicle.dir);
    const vdir = DIR_VECTORS[vehicle.dir];
    const vx = vdir.wx * vehicle.speed;
    const vy = vdir.wy * vehicle.speed;
    const radius = Math.max(
      GAME_CONFIG.VEHICLE_RADIUS,
      Math.min(vehicle.def.footprintW, vehicle.def.footprintH) * 0.28,
    );
    const ox = vehicle.x;
    const oy = vehicle.y;
    this.slideMove(vehicle, map, vx, vy, dt, radius);
    if (map.isWaterWorld(vehicle.x, vehicle.y)) {
      vehicle.x = ox;
      vehicle.y = oy;
      vehicle.speed = 0;
    }
  }

  private updateHelicopter(vehicle: Vehicle, map: Map, dt: number) {
    const { vehicleAccel, vehicleBrake, dx, dy, magnitude } = inputState;
    const dead = GAME_CONFIG.JOYSTICK_DEADZONE;
    vehicle.altitude += (GAME_CONFIG.HELI_CRUISE_ALTITUDE - vehicle.altitude) * Math.min(1, 3.2 * dt);

    let vx = 0;
    let vy = 0;
    const maxSpeed = vehicleAccel ? GAME_CONFIG.HELI_MAX_SPEED : GAME_CONFIG.HELI_MAX_SPEED * 0.58;

    if (magnitude > dead) {
      const nx = dx / magnitude;
      const ny = dy / magnitude;
      const t = Math.min(1, (magnitude - dead) / (1 - dead));
      const curve = t * t * (3 - 2 * t);
      const { x: wx, y: wy } = screenToWorld(nx, ny);
      const wlen = Math.hypot(wx, wy) || 1;
      const spd = maxSpeed * curve;
      vx = (wx / wlen) * spd;
      vy = (wy / wlen) * spd;
      vehicle.dir = angleToWorldDir(Math.atan2(wy, wx));
      vehicle.speed = spd;
    } else if (vehicleBrake) {
      vehicle.speed = Math.max(0, vehicle.speed - GAME_CONFIG.VEHICLE_BRAKE * 1.6 * dt);
    } else {
      vehicle.speed = Math.max(0, vehicle.speed - GAME_CONFIG.VEHICLE_COAST * dt);
      const vdir = DIR_VECTORS[vehicle.dir];
      vx = vdir.wx * vehicle.speed;
      vy = vdir.wy * vehicle.speed;
    }

    vehicle.x += vx * dt;
    vehicle.y += vy * dt;
    vehicle.facingAngle = dirToAngle(vehicle.dir);
    const r = 0.4;
    vehicle.x = Math.max(r, Math.min(map.worldW - r, vehicle.x));
    vehicle.y = Math.max(r, Math.min(map.worldH - r, vehicle.y));
  }

  private slideMove(
    e: { x: number; y: number },
    map: Map,
    vx: number,
    vy: number,
    dt: number,
    radius: number,
  ) {
    const stepX = vx * dt;
    const stepY = vy * dt;
    const queryR = radius + Math.hypot(stepX, stepY) + 1.4;

    if (Math.abs(stepX) > 1e-8) {
      e.x += stepX;
      const nearby = map.queryNearby(e.x, e.y, queryR);
      const c = { x: e.x, y: e.y, radius };
      this.collision.resolveCircle(c, nearby);
      e.x = c.x;
      e.y = c.y;
    }

    if (Math.abs(stepY) > 1e-8) {
      e.y += stepY;
      const nearby = map.queryNearby(e.x, e.y, queryR);
      const c = { x: e.x, y: e.y, radius };
      this.collision.resolveCircle(c, nearby);
      e.x = c.x;
      e.y = c.y;
    }

    e.x = Math.max(radius, Math.min(map.worldW - radius, e.x));
    e.y = Math.max(radius, Math.min(map.worldH - radius, e.y));
  }
}

const TURN_CW: Record<Dir4, Dir4> = { SE: 'SW', SW: 'NW', NW: 'NE', NE: 'SE' };
const TURN_CCW: Record<Dir4, Dir4> = { SE: 'NE', NE: 'NW', NW: 'SW', SW: 'SE' };
