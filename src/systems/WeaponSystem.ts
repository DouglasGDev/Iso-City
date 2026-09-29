import { GUN_IDS, isGunId, WEAPON_DEFS, WEAPON_ORDER, type GunId, type WeaponDefinition, type WeaponId } from '../data/weapons';
import { GAME_CONFIG } from '../game/GameConfig';
import type { Player } from '../entities/Player';
import type { NPC } from '../entities/NPC';
import type { Vehicle } from '../entities/Vehicle';
import type { Collider } from '../entities/types';
import type { Map } from '../world/Map';
import type { WantedSystem } from './WantedSystem';
import type { PickupSystem } from './PickupSystem';
import { vehicleGroundCollider } from './CollisionSystem';
import { damage as damageAnimal, type Animal } from '../entities/Animal';
import { CoverSystem } from './CoverSystem';
import type { CrimeIncident } from './WitnessSystem';

type Point = { x: number; y: number };

export interface WeaponEvents {
  onShot?: (weapon: WeaponDefinition) => void;
  onReload?: (weapon: WeaponDefinition) => void;
  onEmpty?: (weapon: WeaponDefinition) => void;
}

export interface WeaponContext extends WeaponEvents {
  player: Player;
  npcs: NPC[];
  vehicles: Vehicle[];
  animals?: readonly Animal[];
  onCrime?: (incident: CrimeIncident) => void;
  map: Pick<Map, 'queryNearby'>;
  wanted: Pick<WantedSystem, 'raise'>;
  pickups: Pick<PickupSystem, 'spawnDrop' | 'spawnWeaponDrop'>;
  /** Manual aim (mouse / right stick): normalized world direction. */
  aim?: { x: number; y: number; active: boolean };
  onStructChange: () => void;
  shake: (amount: number) => void;
  rng: () => number;
  paused?: boolean;
  overlay?: boolean;
}

export interface WeaponTracer {
  id: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  life: number;
  /** True for a wall or entity impact, false for a range-limit miss. */
  hit: boolean;
}

/** First segment fraction in [0, 1], including touching/starting inside a wall. */
export function segmentAabb(x1: number, y1: number, x2: number, y2: number, box: Collider): number | null {
  let enter = 0;
  let exit = 1;
  for (const [start, delta, min, max] of [
    [x1, x2 - x1, box.x, box.x + box.width],
    [y1, y2 - y1, box.y, box.y + box.height],
  ]) {
    if (delta === 0) {
      if (start < min || start > max) return null;
      continue;
    }
    const a = (min - start) / delta;
    const b = (max - start) / delta;
    enter = Math.max(enter, Math.min(a, b));
    exit = Math.min(exit, Math.max(a, b));
    if (enter > exit) return null;
  }
  return enter;
}

export function segmentCircle(x1: number, y1: number, x2: number, y2: number, center: Point, radius: number): number | null {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const ox = x1 - center.x;
  const oy = y1 - center.y;
  const c = ox * ox + oy * oy - radius * radius;
  if (c <= 0) return 0;
  const a = dx * dx + dy * dy;
  if (a === 0) return null;
  const b = ox * dx + oy * dy;
  const discriminant = b * b - a * c;
  if (discriminant < 0) return null;
  const t = (-b - Math.sqrt(discriminant)) / a;
  return t >= 0 && t <= 1 ? t : null;
}

const liveNpc = (n: NPC) => !n.dead && n.state !== 'dead' && n.health > 0 && !n.inVehicle;
const liveVehicle = (v: Vehicle) => v.state !== 'destroyed' && v.health > 0;
const canUse = (ctx: WeaponContext) => !ctx.paused && !ctx.overlay && ctx.player.health > 0 &&
  ctx.player.state !== 'dead' && ctx.player.currentVehicleId === null && !ctx.player.swimming;

interface Hit {
  t: number;
  hit: boolean;
  npc?: NPC;
  vehicle?: Vehicle;
  animal?: Animal;
}

/** Hitscan and aiming share the exact same obstruction test. Walls win ties. */
function trace(ctx: WeaponContext, x2: number, y2: number): Hit {
  const { x: x1, y: y1 } = ctx.player;
  const barrier = CoverSystem.firstHit({ x: x1, y: y1, z: ctx.player.crouching ? 0.65 : 1.35 },
    { x: x2, y: y2, z: 1.2 }, ctx, ctx.player.currentVehicleId);
  let best: Hit = barrier ? { t: barrier.t, hit: true, vehicle: barrier.vehicle } : { t: Infinity, hit: false };
  for (const vehicle of ctx.vehicles) {
    if (!liveVehicle(vehicle) || vehicle.id === ctx.player.currentVehicleId || vehicle.altitude > 0.5) continue;
    const t = segmentAabb(x1, y1, x2, y2, vehicleGroundCollider(vehicle));
    if (t !== null && t < best.t) best = { t, hit: true, vehicle };
  }
  for (const npc of ctx.npcs) {
    if (!liveNpc(npc)) continue;
    const t = segmentCircle(x1, y1, x2, y2, npc, GAME_CONFIG.NPC_RADIUS);
    if (t !== null && t < best.t) best = { t, hit: true, npc };
  }
  for (const animal of ctx.animals ?? []) {
    if (animal.dead || animal.health <= 0) continue;
    const t = segmentCircle(x1, y1, x2, y2, animal, animal.radius);
    if (t !== null && t < best.t) best = { t, hit: true, animal };
  }
  return best.hit ? best : { t: 1, hit: false };
}

/** No GameState, rendering or audio dependency; timers advance only with simulation dt. */
export class WeaponSystem {
  equipped: WeaponId = 'unarmed';
  /** Firearms are found on the map, not carried from the spawn; melee is always allowed. */
  readonly owned = new Set<WeaponId>(['unarmed', 'bat']);
  readonly ammo: Record<GunId, { loaded: number; reserve: number }> = {
    pistol: { loaded: 0, reserve: 0 },
    revolver: { loaded: 0, reserve: 0 },
    smg: { loaded: 0, reserve: 0 },
    micro: { loaded: 0, reserve: 0 },
    rifle: { loaded: 0, reserve: 0 },
    sniper: { loaded: 0, reserve: 0 },
    shotgun: { loaded: 0, reserve: 0 },
  };
  reloadLeft = 0;
  tracers: WeaponTracer[] = [];
  aimTarget: Point | null = null;
  fireFlash = 0;
  aimAngle = 0;
  /** Optional default callbacks; per-action context callbacks take precedence. */
  events: WeaponEvents = {};

  private cooldown = 0;
  private emptyCooldown = 0;
  private reloading: GunId | null = null;
  private available = true;
  private nextTracerId = 0;

  get current(): WeaponDefinition | null {
    return isGunId(this.equipped) ? WEAPON_DEFS[this.equipped] : null;
  }

  cycle(direction: -1 | 1 = 1): WeaponId {
    this.cancelReload();
    this.aimTarget = null;
    this.fireFlash = 0;
    const list = WEAPON_ORDER.filter((id) => this.owned.has(id));
    const index = Math.max(0, list.indexOf(this.equipped));
    this.equipped = list[(index + direction + list.length) % list.length];
    // Keep shot cooldown across switches so cycling cannot accelerate fire.
    return this.equipped;
  }

  /** Ground/loot acquisition: first pickup grants the gun plus one full loadout. */
  acquire(id: GunId): boolean {
    const fresh = !this.owned.has(id);
    this.owned.add(id);
    const ammo = this.ammo[id];
    const def = WEAPON_DEFS[id];
    ammo.loaded = Math.max(ammo.loaded, def.magazineSize);
    ammo.reserve = Math.max(ammo.reserve, def.reserveAmmo);
    return fresh;
  }

  reload(ctx?: WeaponContext): boolean {
    const def = this.current;
    if (!def || this.reloading || !(ctx ? canUse(ctx) : this.available)) return false;
    const ammo = this.ammo[def.id];
    if (ammo.loaded >= def.magazineSize || ammo.reserve <= 0) return false;
    this.reloading = def.id;
    this.reloadLeft = def.reloadSeconds;
    (ctx?.onReload ?? this.events.onReload)?.(def);
    return true;
  }

  cancelReload() {
    this.reloading = null;
    this.reloadLeft = 0;
  }

  suspend() {
    this.cancelReload();
    this.available = false;
    this.aimTarget = null;
    this.fireFlash = 0;
  }

  /** Round reset does not manufacture ammunition; a new game starts with a fresh system. */
  reset() {
    this.suspend();
    this.equipped = 'unarmed';
    this.owned.clear();
    this.owned.add('unarmed');
    this.owned.add('bat');
    for (const id of GUN_IDS) {
      this.ammo[id].loaded = 0;
      this.ammo[id].reserve = 0;
    }
    this.cooldown = this.emptyCooldown = 0;
    this.tracers.length = 0;
    this.aimAngle = 0;
  }

  /** Ammo crate: top up every owned gun to its loadout; melee has no ammo. */
  refill() {
    this.cancelReload();
    for (const id of GUN_IDS) {
      if (!this.owned.has(id)) continue;
      this.ammo[id].loaded = WEAPON_DEFS[id].magazineSize;
      this.ammo[id].reserve = WEAPON_DEFS[id].reserveAmmo;
    }
  }

  update(dt: number) {
    if (!Number.isFinite(dt) || dt <= 0) return;
    this.cooldown = Math.max(0, this.cooldown - dt);
    this.emptyCooldown = Math.max(0, this.emptyCooldown - dt);
    this.fireFlash = Math.max(0, this.fireFlash - dt);
    for (const tracer of this.tracers) tracer.life -= dt;
    this.tracers = this.tracers.filter((t) => t.life > 0);
    if (!this.reloading) return;
    if (this.reloading !== this.equipped) {
      this.cancelReload();
      return;
    }
    this.reloadLeft = Math.max(0, this.reloadLeft - dt);
    if (this.reloadLeft > 1e-8) return;
    const ammo = this.ammo[this.reloading];
    const transfer = Math.min(WEAPON_DEFS[this.reloading].magazineSize - ammo.loaded, ammo.reserve);
    ammo.loaded += transfer;
    ammo.reserve -= transfer;
    this.cancelReload();
  }

  updateAim(ctx: WeaponContext) {
    this.available = canUse(ctx);
    const manual = ctx.aim?.active ? Math.atan2(ctx.aim.y, ctx.aim.x) : null;
    this.aimAngle = manual ?? ctx.player.facingAngle;
    this.aimTarget = null;
    if (!this.available) {
      this.suspend();
      return;
    }
    const def = this.current;
    if (!def || manual !== null) return;
    let bestAngle = Math.PI / 10; // Gentle assist: only within 18 degrees of facing.
    let bestDistance = Infinity;
    const consider = (target: NPC | Vehicle | Animal, kind: 'npc' | 'vehicle' | 'animal') => {
      const dx = target.x - ctx.player.x;
      const dy = target.y - ctx.player.y;
      const distance = Math.hypot(dx, dy);
      if (distance < 1e-8 || distance > def.range) return;
      const angle = Math.atan2(dy, dx);
      const delta = Math.abs(Math.atan2(Math.sin(angle - ctx.player.facingAngle), Math.cos(angle - ctx.player.facingAngle)));
      if (delta > bestAngle || (delta === bestAngle && distance >= bestDistance)) return;
      const hit = trace(ctx, target.x, target.y);
      if (hit[kind] !== target) return;
      bestAngle = delta;
      bestDistance = distance;
      this.aimTarget = { x: target.x, y: target.y };
      this.aimAngle = angle;
    };
    for (const npc of ctx.npcs) if (liveNpc(npc)) consider(npc, 'npc');
    for (const vehicle of ctx.vehicles) if (liveVehicle(vehicle)) consider(vehicle, 'vehicle');
    for (const animal of ctx.animals ?? []) if (!animal.dead && animal.health > 0) consider(animal, 'animal');
  }

  /** Bare calls are taps. A held trigger repeats only on automatic weapons. */
  tryFire(ctx: WeaponContext, trigger: { pressed?: boolean; held?: boolean } = { pressed: true }): boolean {
    if (!canUse(ctx)) {
      this.suspend();
      return false;
    }
    const def = this.current;
    if (!def || (!trigger.pressed && !(def.automatic && trigger.held))) return false;
    if (this.cooldown > 1e-8 || this.reloading) return false;
    const ammo = this.ammo[def.id];
    if (ammo.loaded <= 0) {
      if (!this.reload(ctx) && this.emptyCooldown <= 0) {
        this.emptyCooldown = 0.35;
        (ctx.onEmpty ?? this.events.onEmpty)?.(def);
      }
      return false;
    }
    this.updateAim(ctx);
    const p = ctx.player;
    ammo.loaded--;
    this.cooldown = def.fireInterval;
    this.fireFlash = def.id === 'shotgun' ? 0.1 : 0.07;

    // Resolve the complete volley before damage: a fatal first pellet must not let
    // later pellets pass through that target or produce duplicate death drops.
    const npcDamage = new globalThis.Map<NPC, number>();
    const vehicleDamage = new globalThis.Map<Vehicle, number>();
    const animalDamage = new globalThis.Map<Animal, number>();
    for (let pellet = 0; pellet < def.pellets; pellet++) {
      const offset = def.pellets === 1 ? 0 : (pellet / (def.pellets - 1) - 0.5) * def.spread;
      const angle = this.aimAngle + offset;
      const x2 = p.x + Math.cos(angle) * def.range;
      const y2 = p.y + Math.sin(angle) * def.range;
      const hit = trace(ctx, x2, y2);
      this.tracers.push({ id: this.nextTracerId++, x1: p.x, y1: p.y,
        x2: p.x + (x2 - p.x) * hit.t, y2: p.y + (y2 - p.y) * hit.t, life: 0.12, hit: hit.hit });
      if (hit.npc) npcDamage.set(hit.npc, (npcDamage.get(hit.npc) ?? 0) + def.damage);
      if (hit.vehicle) vehicleDamage.set(hit.vehicle, (vehicleDamage.get(hit.vehicle) ?? 0) + def.damage);
      if (hit.animal) animalDamage.set(hit.animal, (animalDamage.get(hit.animal) ?? 0) + def.damage);
    }

    for (const [animal, damage] of animalDamage) {
      if (damageAnimal(animal, damage)) ctx.onStructChange();
    }
    let crime = 1;
    for (const [npc, damage] of npcDamage) {
      npc.health = Math.max(0, npc.health - damage);
      crime = Math.max(crime, npc.kind === 'cop' ? 3 : 2);
      if (npc.health <= 0) {
        npc.dead = true;
        npc.state = 'dead';
        npc.speed = 0;
        npc.anim = 'idle';
        npc.frame = 0;
        crime = Math.max(crime, npc.kind === 'cop' ? GAME_CONFIG.WANTED_HIT_COP + 1 : GAME_CONFIG.WANTED_KILL);
        ctx.pickups.spawnDrop(npc.x, npc.y, GAME_CONFIG.DROP_MONEY_MIN +
          ctx.rng() * (GAME_CONFIG.DROP_MONEY_MAX - GAME_CONFIG.DROP_MONEY_MIN));
        // Armed officers are the reliable way to find a sidearm before exploring.
        if (npc.kind === 'cop') ctx.pickups.spawnWeaponDrop(npc.x, npc.y, 'pistol');
        ctx.onStructChange();
      }
    }
    for (const [vehicle, damage] of vehicleDamage) {
      // DestructionSystem owns explosions/occupant damage, later in the same tick.
      vehicle.health = Math.max(0, vehicle.health - damage);
      crime = Math.max(crime, ['police', 'swat'].includes(vehicle.def.type) ? 3 : 1);
    }
    ctx.onCrime?.({ x: p.x, y: p.y, severity: crime });
    ctx.shake(npcDamage.size || vehicleDamage.size || animalDamage.size ? 0.18 : 0.06);
    (ctx.onShot ?? this.events.onShot)?.(def);
    if (ammo.loaded === 0) this.reload(ctx);
    return true;
  }
}
