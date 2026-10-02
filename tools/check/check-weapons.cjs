// Run: node tools/check/check-weapons.cjs (compiles the checker first).
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
execFileSync(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '-p',
  path.join(__dirname, 'tsconfig.json')], { cwd: root, stdio: 'inherit' });
const compiled = path.join(__dirname, 'dist-test/src');
const { WeaponSystem, segmentAabb, segmentCircle } = require(path.join(compiled, 'systems/WeaponSystem.js'));
const { WEAPON_DEFS, MELEE_DEFS, GUN_IDS, WEAPON_ORDER, isGunId, weaponLabel } = require(path.join(compiled, 'data/weapons.js'));
const { GAME_CONFIG } = require(path.join(compiled, 'game/GameConfig.js'));
const { createPlayer, meleeMotion } = require(path.join(compiled, 'entities/Player.js'));
const { createNPC } = require(path.join(compiled, 'entities/NPC.js'));
const { VEHICLE_DEFS } = require(path.join(compiled, 'data/vehicles.js'));
const input = require(path.join(compiled, 'game/InputState.js'));
stub('audio/SoundManager.js', { sound: { play() {}, ambient() {}, weather() {}, setLoop() {}, stopLoops() {} } });
const { CombatSystem } = require(path.join(compiled, 'systems/CombatSystem.js'));

let passed = 0, failed = 0;
function test(name, fn) {
  input.resetActionInput();
  try {
    fn();
    passed++;
    console.log('OK ' + name);
  } catch (error) {
    failed++;
    process.exitCode = 1;
    console.error('FAIL ' + name, error);
  }
}
function near(actual, expected, tolerance = 1e-8) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
}
const wall = (x, y, width, height) => ({ x, y, width, height, type: 'BUILDING' });
function npc(id, x, y = 0, patch = {}) {
  return { ...createNPC(id, 'a', x, y), patienceTimer: 1000, ...patch };
}
function vehicle(id, x, y = 0, patch = {}) {
  return { id, x, y, def: VEHICLE_DEFS.sedan, color: 'blue', dir: 'SE', facingAngle: 0,
    speed: 0, health: 100, occupied: false, state: 'parked', turnTimer: 0,
    flashing: 0, animFrame: 0, animTimer: 0, altitude: 0, ...patch };
}
function setup(equipped = 'pistol', walls = []) {
  const weapons = new WeaponSystem();
  // Tests target gun behavior; ownership itself has its own tests below.
  for (const id of GUN_IDS) weapons.acquire(id);
  while (weapons.equipped !== equipped) weapons.cycle();
  const events = { shots: [], reloads: [], empty: [], wanted: [], crimes: [], drops: [], gunDrops: [], changes: 0, shake: [] };
  const ctx = {
    player: createPlayer(0, 0), npcs: [], vehicles: [],
    map: { queryNearby(x, y, r) {
      return walls.filter((b) => b.x <= x + r && b.x + b.width >= x - r &&
        b.y <= y + r && b.y + b.height >= y - r);
    } },
    wanted: { raise: (_p, amount) => events.wanted.push(amount) },
    pickups: {
      spawnDrop: (x, y, amount) => events.drops.push({ x, y, amount }),
      spawnWeaponDrop: (x, y, weapon) => events.gunDrops.push({ x, y, weapon }),
    },
    onStructChange: () => events.changes++, shake: (a) => events.shake.push(a), rng: () => 0.5,
    onShot: (def) => events.shots.push(def.id), onReload: (def) => events.reloads.push(def.id),
    onEmpty: (def) => events.empty.push(def.id),
    onCrime: (incident) => events.crimes.push(incident),
  };
  return { weapons, ctx, events };
}

test('start owns only melee: empty ammo, cycle unarmed/bat, acquire grants guns', () => {
  const w = new WeaponSystem();
  assert.equal(w.current, null);
  assert.equal(w.tryFire(setup().ctx), false);
  assert.equal(w.reload(), false);
  assert.deepEqual([...w.owned], ['unarmed', 'bat']);
  for (const id of GUN_IDS) assert.deepEqual(w.ammo[id], { loaded: 0, reserve: 0 });
  assert.equal(w.cycle(), 'bat');
  assert.equal(w.current, null);
  assert.equal(w.reload(), false);
  assert.equal(w.tryFire(setup().ctx), false);
  assert.equal(w.ammo.bat, undefined);
  assert.equal(isGunId('bat'), false);
  assert.equal(isGunId('unarmed'), false);
  assert.equal(weaponLabel('bat'), 'TACO');
  assert.equal(w.cycle(), 'unarmed');
  assert.deepEqual(WEAPON_ORDER, ['unarmed', 'pistol', 'revolver', 'smg', 'micro', 'rifle', 'sniper', 'shotgun', 'bat']);
  for (const id of GUN_IDS) {
    const def = WEAPON_DEFS[id];
    assert.ok(def.label && def.fireInterval > 0 && def.reloadSeconds > 0 && def.range > 0 && def.damage > 0);
    assert.ok(isGunId(id));
    assert.equal(weaponLabel(id), def.label);
    for (const key of ['magazineSize', 'reserveAmmo', 'fireInterval', 'reloadSeconds', 'range', 'damage', 'pellets', 'spread']) {
      assert.ok(Number.isFinite(def[key]), `${id}.${key}`);
    }
    assert.equal(w.acquire(id), true, `${id} fresh`);
    assert.ok(w.owned.has(id));
    assert.deepEqual(w.ammo[id], { loaded: def.magazineSize, reserve: def.reserveAmmo });
    w.ammo[id].loaded = 1;
    assert.equal(w.acquire(id), false, `${id} repeat`);
    assert.deepEqual(w.ammo[id], { loaded: def.magazineSize, reserve: def.reserveAmmo }, `${id} top-up`);
  }
  const ownedList = WEAPON_ORDER.filter((id) => w.owned.has(id));
  assert.deepEqual(ownedList, [...WEAPON_ORDER]);
  assert.equal(w.equipped, 'unarmed');
  for (let i = 1; i <= ownedList.length + 1; i++) {
    assert.equal(w.cycle(), ownedList[i % ownedList.length]);
  }
  assert.equal(w.cycle(-1), 'unarmed');
  assert.equal(w.cycle(-1), 'bat');
  assert.equal(w.cycle(-1), 'shotgun');
});

test('empty owned gun cannot fire and signals empty instead of shooting', () => {
  const { weapons: w, ctx, events } = setup();
  for (const id of GUN_IDS) {
    w.equipped = id;
    w.ammo[id] = { loaded: 0, reserve: 0 };
    assert.equal(w.tryFire(ctx), false);
    assert.equal(events.empty.length, 1);
    assert.equal(events.shots.length, 0);
    events.empty.length = 0;
    events.shots.length = 0;
    w.update(0.36);
  }
});

test('killed cop drops cash plus a collectable pistol at the body', () => {
  const { weapons: w, ctx, events } = setup();
  ctx.npcs = [npc(1, 3, 0, { kind: 'cop', health: 1 }), npc(2, 5, { health: 1 })];
  w.tryFire(ctx);
  assert.equal(ctx.npcs[0].dead, true);
  assert.deepEqual(events.gunDrops, [{ x: 3, y: 0, weapon: 'pistol' }]);
  assert.equal(events.drops.length, 1, 'civilian death drops no gun');
});

test('AABB slabs: parallel, zero length, inside, reverse, corners and endpoints', () => {
  const b = wall(2, 2, 2, 2);
  near(segmentAabb(0, 3, 8, 3, b), 0.25);
  near(segmentAabb(3, 0, 3, 8, b), 0.25);
  near(segmentAabb(8, 3, 0, 3, b), 0.5);
  assert.equal(segmentAabb(0, 1, 8, 1, b), null);
  assert.equal(segmentAabb(1, 0, 1, 8, b), null);
  assert.equal(segmentAabb(3, 3, 3, 3, b), 0);
  assert.equal(segmentAabb(2, 2, 2, 2, b), 0);
  assert.equal(segmentAabb(1, 1, 1, 1, b), null);
  assert.equal(segmentAabb(3, 3, 9, 3, b), 0);
  assert.equal(segmentAabb(0, 3, 1.99, 3, b), null);
  assert.equal(segmentAabb(0, 3, 2, 3, b), 1);
  near(segmentAabb(0, 4, 4, 0, b), 0.5);
  near(segmentAabb(0, 2, 8, 2 + 1e-12, b), 0.25);
  near(segmentAabb(0, 2, 8, 2, b), 0.25);
});

test('circle segments: nearest surface, tangent, zero length and out-of-segment', () => {
  const c = { x: 3, y: 0 };
  near(segmentCircle(0, 0, 6, 0, c, 1), 1 / 3);
  near(segmentCircle(0, 1, 6, 1, c, 1), 0.5);
  assert.equal(segmentCircle(0, 0, 0, 0, c, 1), null);
  assert.equal(segmentCircle(3, 0, 3, 0, c, 1), 0);
  assert.equal(segmentCircle(2, 0, 2, 0, c, 1), 0);
  assert.equal(segmentCircle(0, 0, 1, 0, c, 1), null);
  assert.equal(segmentCircle(0, 0, -6, 0, c, 1), null);
  assert.equal(segmentCircle(0, 2, 6, 2, c, 1), null);
  assert.equal(segmentCircle(0, 0, 2, 0, c, 1), 1);
});

test('wall queried across full range blocks NPC and clips world tracer', () => {
  const { weapons: w, ctx } = setup('pistol', [wall(8, -1, 0.2, 2)]);
  ctx.npcs = [npc(1, 12)];
  assert.ok(w.tryFire(ctx));
  assert.equal(ctx.npcs[0].health, 45);
  assert.equal(w.aimTarget, null);
  assert.equal(w.tracers[0].hit, true);
  near(w.tracers[0].x2, 8);
  near(w.tracers[0].y2, 0);
});

test('real map collider grid blocks a shot crossing spatial cells', () => {
  const { Map: WorldMap } = require(path.join(compiled, 'world/Map.js'));
  const { weapons: w, ctx } = setup();
  ctx.map = new WorldMap({
    worldW: 32, worldH: 32, tilesW: 32, tilesH: 32,
    heights: new Float32Array(32 * 32),
    tiles: Array.from({ length: 32 * 32 }, () => ({ kind: 'grass', key: '' })),
    buildings: [{ key: 'test_wall', x: 10, y: 2, footprintW: 2, footprintH: 4 }],
    props: [], vehicles: [], npcSpawns: [], playerSpawn: { x: 1, y: 1 },
  });
  ctx.player.x = 1;
  ctx.player.y = 1;
  ctx.npcs = [npc(1, 13, 1)];
  w.tryFire(ctx);
  assert.equal(ctx.npcs[0].health, 45);
  assert.equal(w.aimTarget, null);
  near(w.tracers[0].x2, ctx.map.buildingColliders[0].x);
  near(w.tracers[0].y2, 1);
});

test('wall behind a nearer target does not prevent hitting it', () => {
  const { weapons: w, ctx } = setup('pistol', [wall(6, -1, 0.2, 2)]);
  ctx.npcs = [npc(1, 3)];
  w.tryFire(ctx);
  assert.equal(ctx.npcs[0].health, 18);
  near(w.tracers[0].x2, 3 - GAME_CONFIG.NPC_RADIUS);
});

test('wall at muzzle, containing origin, and wall/entity tie never leak shots', () => {
  for (const b of [wall(0.01, -1, 0.1, 2), wall(-0.5, -1, 1, 2), wall(4.85, -1, 0.1, 2)]) {
    const { weapons: w, ctx } = setup('pistol', [b]);
    ctx.npcs = [npc(1, 5)];
    w.tryFire(ctx);
    assert.equal(ctx.npcs[0].health, 45);
    assert.ok(w.tracers[0].x2 <= Math.max(0, b.x) + 1e-8);
  }
});

test('nearest NPC wins independent of array order, no penetration', () => {
  const { weapons: w, ctx } = setup();
  const close = npc(1, 3);
  const far = npc(2, 7);
  ctx.npcs = [far, close];
  w.tryFire(ctx);
  assert.equal(close.health, 45 - w.current.damage);
  assert.equal(far.health, 45);
  near(w.tracers[0].x2, 3 - GAME_CONFIG.NPC_RADIUS);
});

test('nearest surface wins even when vehicle center is farther than NPC center', () => {
  const { weapons: w, ctx } = setup();
  ctx.npcs = [npc(1, 4)];
  ctx.vehicles = [vehicle(2, 4.3, 0, { def: { ...VEHICLE_DEFS.truck, footprintW: 3, footprintH: 3 } })];
  w.tryFire(ctx);
  assert.equal(ctx.npcs[0].health, 45);
  assert.equal(ctx.vehicles[0].health, 73);
  near(w.tracers[0].x2, 4.3 - 1.5);
});

test('occupied vehicle absorbs shot, driver is not independently targeted', () => {
  const { weapons: w, ctx } = setup();
  ctx.npcs = [npc(1, 3, 0, { inVehicle: true, vehicleId: 2 }), npc(3, 6)];
  ctx.vehicles = [vehicle(2, 3, 0, { occupied: true })];
  w.tryFire(ctx);
  assert.equal(ctx.vehicles[0].health, 73);
  assert.ok(ctx.npcs.every((n) => n.health === 45));
});

test('dead, zero-health, destroyed and in-vehicle NPCs are invalid targets', () => {
  const { weapons: w, ctx } = setup();
  ctx.npcs = [npc(1, 1, 0, { dead: true }), npc(2, 2, 0, { health: 0 }),
    npc(3, 3, 0, { inVehicle: true }), npc(4, 4, 0, { state: 'dead' }), npc(5, 7)];
  ctx.vehicles = [vehicle(6, 1.5, 0, { state: 'destroyed' }), vehicle(7, 2.5, 0, { health: 0 })];
  w.tryFire(ctx);
  assert.deepEqual(ctx.npcs.map((n) => n.health), [45, 0, 45, 45, 18]);
  assert.deepEqual(ctx.vehicles.map((v) => v.health), [100, 0]);
});

test('soft aim stays in front cone and never rotates player movement', () => {
  const { weapons: w, ctx } = setup();
  ctx.npcs = [npc(1, 6, 1)];
  ctx.player.vx = 1;
  ctx.player.vy = 0.25;
  w.updateAim(ctx);
  assert.deepEqual(w.aimTarget, { x: 6, y: 1 });
  near(w.aimAngle, Math.atan2(1, 6));
  w.tryFire(ctx);
  near(Math.atan2(w.tracers[0].y2, w.tracers[0].x2), w.aimAngle);
  assert.equal(ctx.npcs[0].health, 18);
  assert.equal(ctx.player.facingAngle, 0);
  assert.equal(ctx.player.vx, 1);
  assert.equal(ctx.player.vy, 0.25);
});

test('behind, outside cone, out of range and hidden targets do not attract aim', () => {
  const { weapons: w, ctx } = setup('pistol', [wall(2, 0.2, 0.4, 0.8)]);
  ctx.npcs = [npc(1, -3), npc(2, 4, 4), npc(3, 18), npc(4, 6, 1)];
  w.tryFire(ctx);
  assert.equal(w.aimTarget, null);
  assert.equal(w.aimAngle, 0);
  assert.ok(ctx.npcs.every((n) => n.health === 45));
  assert.equal(w.tracers[0].hit, false);
  near(w.tracers[0].x2, w.current.range);
});

test('vehicle occlusion also excludes hidden NPC from autoaim', () => {
  const { weapons: w, ctx } = setup();
  ctx.npcs = [npc(1, 6, 1)];
  ctx.vehicles = [vehicle(2, 3, 0.5)];
  w.tryFire(ctx);
  assert.deepEqual(w.aimTarget, { x: 3, y: 0.5 });
  assert.equal(ctx.npcs[0].health, 45);
  assert.equal(ctx.vehicles[0].health, 73);
});

test('NPC death drops deterministic cash and notifies structure once', () => {
  const { weapons: w, ctx, events } = setup();
  ctx.npcs = [npc(1, 3, 0, { health: 10 })];
  w.tryFire(ctx);
  assert.equal(ctx.npcs[0].dead, true);
  assert.equal(ctx.npcs[0].state, 'dead');
  assert.equal(ctx.npcs[0].health, 0);
  assert.equal(events.changes, 1);
  assert.deepEqual(events.drops, [{ x: 3, y: 0, amount: (GAME_CONFIG.DROP_MONEY_MIN + GAME_CONFIG.DROP_MONEY_MAX) / 2 }]);
  w.update(w.current.fireInterval);
  w.tryFire(ctx);
  assert.equal(events.changes, 1);
  assert.equal(events.drops.length, 1);
});

test('each successful volley emits its location/severity, never raises wanted directly', () => {
  for (const id of GUN_IDS) {
    const { weapons: w, ctx, events } = setup(id);
    Object.assign(ctx.player, { x: 2, y: 3 });
    ctx.npcs = [npc(1, 2, 7), npc(2, -2, 5, { kind: 'cop' })];
    for (let i = 0; i < 3; i++) {
      assert.ok(w.tryFire(ctx));
      assert.equal(w.tryFire(ctx), false, 'cooldown must not emit another incident');
      w.update(w.current.fireInterval);
    }
    assert.deepEqual(events.crimes, Array.from({ length: 3 }, () => ({ x: 2, y: 3, severity: 1 })));
    assert.deepEqual(events.wanted, []);
    assert.equal(ctx.player.wantedLevel, 0);
    assert.ok(ctx.npcs.every((n) => n.state === 'idle'), 'witness reactions belong to WitnessSystem');
    ctx.player.x = 9;
    assert.equal(events.crimes[0].x, 2, 'incident is a snapshot, not a live player reference');
  }
});

test('isolated, occluded and damaging shots emit incidents without automatic alert', () => {
  for (const scenario of ['isolated', 'wall', 'civilian', 'cop']) {
    const { weapons: w, ctx, events } = setup('pistol', scenario === 'wall' ? [wall(-1, 1, 2, 0.3)] : []);
    if (scenario === 'wall') ctx.npcs = [npc(1, 0, 4, { kind: 'cop' })];
    if (scenario === 'civilian' || scenario === 'cop') ctx.npcs = [npc(1, 3, 0, { kind: scenario === 'cop' ? 'cop' : 'civ', health: 100 })];
    assert.ok(w.tryFire(ctx));
    assert.deepEqual(events.crimes, [{ x: 0, y: 0, severity: scenario === 'cop' ? 3 : scenario === 'civilian' ? 2 : 1 }]);
    assert.deepEqual(events.wanted, []);
    assert.equal(ctx.player.wantedLevel, 0);
    // Legacy callers without the optional hook must not silently restore auto-alert.
    delete ctx.onCrime;
    w.update(2);
    assert.ok(w.tryFire(ctx));
    assert.deepEqual(events.wanted, []);
    assert.equal(events.crimes.length, 1);
  }
});

test('manual reload transfers only missing magazine ammo when timer completes', () => {
  const { weapons: w, ctx, events } = setup();
  w.ammo.pistol.loaded = 9;
  w.ammo.pistol.reserve = 2;
  assert.ok(w.reload(ctx));
  assert.equal(w.reload(ctx), false);
  assert.equal(w.tryFire(ctx), false);
  w.update(w.current.reloadSeconds - 0.01);
  assert.deepEqual(w.ammo.pistol, { loaded: 9, reserve: 2 });
  w.update(0.01);
  assert.deepEqual(w.ammo.pistol, { loaded: 11, reserve: 0 });
  assert.equal(w.reloadLeft, 0);
  assert.equal(w.reload(ctx), false);
  assert.deepEqual(events.reloads, ['pistol']);
});

test('switch cancels reload without transfer and cannot bypass shot cooldown', () => {
  const { weapons: w, ctx } = setup();
  w.tryFire(ctx);
  w.reload(ctx);
  const ammo = { ...w.ammo.pistol };
  w.cycle();
  assert.equal(w.reloadLeft, 0);
  assert.equal(w.tryFire(ctx), false);
  w.update(5);
  assert.deepEqual(w.ammo.pistol, ammo);
  assert.equal(w.ammo.smg.loaded, 30);
});

test('empty magazine automatically reloads and exhausts finite reserves', () => {
  const { weapons: w, ctx, events } = setup();
  const total = w.ammo.pistol.loaded + w.ammo.pistol.reserve;
  for (let i = 0; i < total; i++) {
    assert.ok(w.tryFire(ctx), `shot ${i}`);
    if (w.ammo.pistol.loaded === 0 && w.ammo.pistol.reserve > 0) assert.ok(w.reloadLeft > 0);
    w.update(Math.max(w.current.fireInterval, w.reloadLeft));
  }
  assert.deepEqual(w.ammo.pistol, { loaded: 0, reserve: 0 });
  assert.equal(events.shots.length, total);
  assert.equal(events.reloads.length, 4);
  assert.equal(w.tryFire(ctx), false);
  assert.equal(w.tryFire(ctx), false);
  assert.equal(events.empty.length, 1);
  w.update(0.36);
  assert.equal(w.tryFire(ctx), false);
  assert.equal(events.empty.length, 2);
});

test('refill caps owned guns, round reset restores melee-only loadout', () => {
  const { weapons: w, ctx } = setup();
  w.tryFire(ctx);
  w.reload(ctx);
  w.ammo.smg = { loaded: 2, reserve: 3 };
  w.reset();
  w.update(10);
  assert.equal(w.equipped, 'unarmed');
  assert.equal(w.reloadLeft, 0);
  assert.equal(w.tracers.length, 0);
  assert.equal(w.fireFlash, 0);
  assert.equal(w.aimTarget, null);
  assert.deepEqual([...w.owned], ['unarmed', 'bat']);
  for (const id of GUN_IDS) assert.deepEqual(w.ammo[id], { loaded: 0, reserve: 0 });
  assert.equal(w.tryFire(ctx), false);
  assert.equal(w.acquire('pistol'), true);
  assert.deepEqual(w.ammo.pistol, { loaded: WEAPON_DEFS.pistol.magazineSize, reserve: WEAPON_DEFS.pistol.reserveAmmo });
  w.ammo.pistol.loaded = 1;
  w.ammo.pistol.reserve = 0;
  w.ammo.rifle.loaded = 5;
  w.refill();
  w.refill();
  assert.deepEqual(w.ammo.pistol, { loaded: WEAPON_DEFS.pistol.magazineSize, reserve: WEAPON_DEFS.pistol.reserveAmmo });
  assert.deepEqual(w.ammo.rifle, { loaded: 5, reserve: 0 }, 'refill only touches owned guns');
});

test('driving, swimming, pause, overlay and death forbid fire and cancel reload', () => {
  const patches = [
    (c) => { c.player.currentVehicleId = 1; }, (c) => { c.player.swimming = true; },
    (c) => { c.paused = true; }, (c) => { c.overlay = true; },
    (c) => { c.player.health = 0; }, (c) => { c.player.state = 'dead'; },
  ];
  for (const block of patches) {
    const { weapons: w, ctx, events } = setup();
    w.ammo.pistol.loaded = 3;
    w.reload(ctx);
    block(ctx);
    w.updateAim(ctx); // Integration does this before updating the reload timer.
    w.update(2);
    assert.equal(w.tryFire(ctx), false);
    assert.equal(w.reload(ctx), false);
    assert.equal(w.reload(), false);
    assert.equal(w.reloadLeft, 0);
    assert.equal(w.ammo.pistol.loaded, 3);
    assert.equal(w.aimTarget, null);
    assert.equal(events.shots.length, 0);
  }
});

test('pistol/shotgun require taps; SMG/rifle hold cadence never accelerates', () => {
  for (const id of GUN_IDS) {
    const { weapons: w, ctx, events } = setup(id);
    assert.ok(w.tryFire(ctx, { pressed: true, held: true }));
    assert.equal(w.tryFire(ctx, { pressed: true, held: true }), false);
    for (let i = 0; i < 5; i++) {
      w.update(w.current.fireInterval / 2);
      assert.equal(w.tryFire(ctx, { held: true }), false);
      w.update(w.current.fireInterval / 2);
      assert.equal(w.tryFire(ctx, { held: true }), w.current.automatic);
    }
    assert.equal(events.shots.length, w.current.automatic ? 6 : 1);
    w.update(w.current.fireInterval);
    assert.equal(w.tryFire(ctx, { pressed: false, held: false }), false);
    assert.ok(w.tryFire(ctx));
  }
});

test('tracer and flash lifetime use simulation dt; default event hooks are optional', () => {
  const { weapons: w, ctx, events } = setup();
  delete ctx.onShot;
  delete ctx.onReload;
  delete ctx.onEmpty;
  w.events.onShot = (def) => events.shots.push(def.id);
  w.events.onReload = (def) => events.reloads.push(def.id);
  assert.ok(w.tryFire(ctx));
  const id = w.tracers[0].id;
  w.update(0);
  w.update(-1);
  w.update(NaN);
  near(w.tracers[0].life, 0.12);
  w.update(0.05);
  near(w.fireFlash, 0.02);
  w.update(0.08);
  assert.equal(w.tracers.length, 0);
  assert.equal(w.fireFlash, 0);
  w.update(1);
  w.tryFire(ctx);
  assert.ok(w.tracers[0].id > id);
  assert.deepEqual(events.shots, ['pistol', 'pistol']);
  w.reload();
  assert.deepEqual(events.reloads, ['pistol']);
});

test('held input queues only rising edges, quick taps survive release, reset drains actions', () => {
  input.setAttackHeld(true);
  assert.equal(input.consumeAttack(), true);
  input.setAttackHeld(true);
  assert.equal(input.consumeAttack(), false);
  input.setAttackHeld(false);
  input.setAttackHeld(true);
  input.setAttackHeld(false);
  assert.equal(input.consumeAttack(), true);
  input.queueReload();
  input.queueWeapon();
  assert.equal(input.consumeReload(), true);
  assert.equal(input.consumeReload(), false);
  assert.equal(input.consumeWeapon(), 1);
  assert.equal(input.consumeWeapon(), 0);
  input.setAttackHeld(true);
  input.queueReload();
  input.queueWeapon(-1);
  input.queueCrouch();
  input.queueEnter();
  input.resetActionInput();
  assert.equal(input.inputState.weaponQueued, 0);
  for (const key of ['attackQueued', 'attackHeld', 'reloadQueued', 'crouchQueued', 'enterQueued']) {
    assert.equal(input.inputState[key], false);
  }
});

test('every gun exhausts finite ammo, reloads only available reserves and refills to caps', () => {
  for (const id of GUN_IDS) {
    const { weapons: w, ctx, events } = setup();
    w.equipped = id;
    const def = w.current;
    const total = def.magazineSize + def.reserveAmmo;
    for (let i = 0; i < total; i++) {
      const previousTracers = w.tracers.length;
      assert.ok(w.tryFire(ctx), `${id} shot ${i}`);
      assert.ok(w.ammo[id].loaded >= 0 && w.ammo[id].reserve >= 0);
      assert.equal(w.ammo[id].loaded + w.ammo[id].reserve, total - i - 1);
      assert.equal(w.tracers.length - previousTracers, def.pellets);
      for (const tracer of w.tracers) {
        for (const key of ['x1', 'y1', 'x2', 'y2', 'life']) assert.ok(Number.isFinite(tracer[key]));
      }
      w.update(Math.max(def.fireInterval, w.reloadLeft));
    }
    assert.deepEqual(w.ammo[id], { loaded: 0, reserve: 0 });
    assert.equal(events.shots.length, total);
    assert.equal(w.tryFire(ctx), false);
    assert.equal(w.reload(ctx), false);
    w.refill();
    assert.deepEqual(w.ammo[id], { loaded: def.magazineSize, reserve: def.reserveAmmo });
    assert.equal(w.ammo.bat, undefined);
  }
});

test('rifle and shotgun partial reload conserves ammo, survives invalid dt and cancels on switch', () => {
  for (const id of ['rifle', 'shotgun']) {
    const { weapons: w, ctx } = setup(id);
    w.ammo[id] = { loaded: 1, reserve: 2 };
    const seconds = w.current.reloadSeconds;
    assert.ok(w.reload(ctx));
    for (const dt of [NaN, Infinity, -1, 0]) w.update(dt);
    assert.equal(w.reloadLeft, seconds);
    w.update(seconds - 0.01);
    assert.deepEqual(w.ammo[id], { loaded: 1, reserve: 2 });
    assert.equal(w.tryFire(ctx), false);
    w.update(0.01);
    assert.deepEqual(w.ammo[id], { loaded: 3, reserve: 0 });
    w.ammo[id].reserve = 2;
    assert.ok(w.reload(ctx));
    w.cycle();
    w.update(10);
    assert.deepEqual(w.ammo[id], { loaded: 3, reserve: 2 });
  }
});

test('rifle reaches beyond pistol/SMG and still clips long-range walls', () => {
  const { weapons: w, ctx } = setup('rifle');
  ctx.npcs = [npc(1, 20)];
  w.tryFire(ctx, { held: true });
  assert.equal(ctx.npcs[0].health, 45 - WEAPON_DEFS.rifle.damage);
  assert.ok(WEAPON_DEFS.rifle.range > WEAPON_DEFS.pistol.range);
  const blocked = setup('rifle', [wall(16, -1, 0.1, 2)]);
  blocked.ctx.npcs = [npc(1, 20)];
  blocked.weapons.tryFire(blocked.ctx);
  assert.equal(blocked.ctx.npcs[0].health, 45);
  near(blocked.weapons.tracers[0].x2, 16);
});

test('shotgun spends one shell per volley and each pellet has a distinct spread direction', () => {
  const { weapons: w, ctx, events } = setup('shotgun');
  const def = w.current;
  w.ammo.shotgun.loaded = 1;
  assert.ok(w.tryFire(ctx));
  assert.equal(w.ammo.shotgun.loaded, 0);
  assert.equal(w.ammo.shotgun.reserve, def.reserveAmmo);
  assert.equal(w.tracers.length, def.pellets);
  const angles = w.tracers.map((t) => Math.atan2(t.y2, t.x2));
  assert.equal(new Set(angles).size, def.pellets);
  near(angles[0], -def.spread / 2);
  near(angles[angles.length - 1], def.spread / 2);
  near(angles[Math.floor(angles.length / 2)], 0);
  assert.deepEqual(events.shots, ['shotgun']);
  assert.deepEqual(events.reloads, ['shotgun']);
  assert.equal(w.tryFire(ctx), false);
  w.update(def.reloadSeconds);
  assert.equal(w.tryFire(ctx, { held: true }), false);
  assert.equal(w.ammo.shotgun.loaded, def.magazineSize);
  assert.equal(w.ammo.shotgun.reserve, def.reserveAmmo - def.magazineSize);
});

test('shotgun full wall and muzzle obstruction stop every pellet independently', () => {
  for (const b of [wall(3, -3, 0.1, 6), wall(0.001, -1, 0.01, 2), wall(-0.2, -1, 0.4, 2)]) {
    const { weapons: w, ctx } = setup('shotgun', [b]);
    ctx.npcs = [npc(1, 6), npc(2, 6, 0.9), npc(3, 6, -0.9)];
    w.tryFire(ctx);
    assert.ok(ctx.npcs.every((n) => n.health === 45));
    for (const t of w.tracers) {
      assert.equal(t.hit, true);
      near(t.x2, Math.max(0, b.x));
    }
  }
});

test('shotgun partial cover blocks only covered pellets, not the entire cone', () => {
  const { weapons: w, ctx } = setup('shotgun', [wall(3, 0.1, 0.15, 2)]);
  const center = npc(1, 6), covered = npc(2, 6, 0.9), exposed = npc(3, 6, -0.9);
  ctx.npcs = [center, covered, exposed];
  assert.ok(w.tryFire(ctx));
  near(w.aimAngle, 0);
  assert.equal(covered.health, 45);
  assert.equal(center.health, 45 - WEAPON_DEFS.shotgun.damage);
  assert.equal(exposed.health, 45 - WEAPON_DEFS.shotgun.damage);
  for (const t of w.tracers.filter((t) => t.y2 > 0.1)) near(t.x2, 3);
  assert.equal(w.ammo.shotgun.loaded, WEAPON_DEFS.shotgun.magazineSize - 1);
});

test('shotgun fatal volley does not penetrate a killed target or duplicate death/drop events', () => {
  const { weapons: w, ctx, events } = setup('shotgun');
  ctx.npcs = [npc(1, 0.7, 0, { health: 1 }), npc(2, 4)];
  w.tryFire(ctx);
  assert.equal(ctx.npcs[0].health, 0);
  assert.equal(ctx.npcs[1].health, 45);
  assert.equal(events.drops.length, 1);
  assert.equal(events.changes, 1);
  assert.equal(events.shots.length, 1);
  assert.ok(w.tracers.every((t) => t.x2 < 0.7));
});

test('shotgun pellets hit vehicle surfaces before their driver or targets behind', () => {
  const { weapons: w, ctx } = setup('shotgun');
  ctx.vehicles = [vehicle(10, 1, 0, { health: 1, occupied: true })];
  ctx.npcs = [npc(1, 1, 0, { inVehicle: true }), npc(2, 4)];
  w.tryFire(ctx);
  assert.equal(ctx.vehicles[0].health, 0);
  assert.ok(ctx.npcs.every((n) => n.health === 45));
  assert.ok(w.tracers.every((t) => t.hit && t.x2 < 1));
});

test('melee defaults to original punch stats; bat has its own range/damage and animation', () => {
  for (const id of ['unarmed', 'bat']) {
    const { ctx } = setup(id);
    const combat = new CombatSystem();
    const def = MELEE_DEFS[id];
    ctx.npcs = [npc(1, 0.6, 0, { health: 100 }), npc(2, 1.3, 0, { health: 100 }), npc(3, -0.6)];
    const movement = { vx: 0.5, vy: 0.2 };
    Object.assign(ctx.player, movement);
    assert.ok(id === 'unarmed' ? combat.tryAttack(ctx) : combat.tryAttack(ctx, id));
    assert.equal(ctx.npcs[0].health, 100 - def.damage);
    assert.equal(ctx.npcs[1].health, id === 'bat' ? 100 - def.damage : 100);
    assert.equal(ctx.npcs[2].health, 45);
    assert.equal(ctx.player.attackTimer, def.animationSeconds);
    assert.equal(ctx.player.attackWeapon, id);
    assert.equal(ctx.player.attackAngle, 0);
    assert.equal(ctx.player.vx, movement.vx);
    assert.equal(ctx.player.vy, movement.vy);
    assert.equal(combat.attacking, true);
  }
});

test('melee LOS blocks thin facades, wall endpoints and starting inside walls in four directions', () => {
  for (const id of ['unarmed', 'bat']) {
    for (const angle of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
      const fx = Math.cos(angle), fy = Math.sin(angle);
      for (const distance of [0, 0.4, 0.7]) {
        const { ctx, events } = setup(id, [wall(fx * distance - 0.025, fy * distance - 0.025, 0.05, 0.05)]);
        ctx.player.facingAngle = angle;
        ctx.npcs = [npc(1, fx * 0.7, fy * 0.7)];
        assert.ok(new CombatSystem().tryAttack(ctx, id));
        assert.equal(ctx.npcs[0].health, 45);
        assert.equal(events.changes, 0);
        assert.equal(events.wanted.length, 0);
        assert.equal(events.shake.length, 0);
      }
    }
  }
});

test('melee permits clear LOS beside a wall and clamps knockback before collision', () => {
  for (const id of ['unarmed', 'bat']) {
    const { ctx } = setup(id, [wall(0.9, -1, 0.1, 2), wall(0.2, 0.4, 0.2, 0.2)]);
    ctx.npcs = [npc(1, 0.7, 0, { health: 100 })];
    new CombatSystem().tryAttack(ctx, id);
    assert.equal(ctx.npcs[0].health, 100 - MELEE_DEFS[id].damage);
    assert.ok(ctx.npcs[0].x >= 0.7 && ctx.npcs[0].x + GAME_CONFIG.NPC_RADIUS < 0.9);
  }
});

test('melee cadence survives invalid dt and weapon changes; animation ends before cooldown', () => {
  for (const id of ['unarmed', 'bat']) {
    const { ctx } = setup(id);
    const combat = new CombatSystem();
    const def = MELEE_DEFS[id];
    assert.ok(combat.tryAttack(ctx, id));
    for (const dt of [NaN, Infinity, -1, 0]) combat.update(dt);
    assert.equal(combat.tryAttack(ctx, id), false);
    combat.update(def.animationSeconds);
    assert.equal(combat.attacking, false);
    assert.equal(combat.tryAttack(ctx, id === 'bat' ? 'unarmed' : 'bat'), false);
    combat.update(def.cooldown - def.animationSeconds);
    assert.ok(combat.tryAttack(ctx, id));
  }
});

test('melee rejects blocked players and dead/in-vehicle targets without spending ammo', () => {
  for (const id of ['unarmed', 'bat']) {
    for (const patch of [{ swimming: true }, { currentVehicleId: 42 }, { health: 0 }, { state: 'dead' }]) {
      const { weapons: w, ctx } = setup(id);
      const before = JSON.stringify(w.ammo);
      Object.assign(ctx.player, patch);
      assert.equal(new CombatSystem().tryAttack(ctx, id), false);
      assert.equal(ctx.player.attackTimer, 0);
      assert.equal(JSON.stringify(w.ammo), before);
    }
    for (const mode of ['paused', 'overlay']) {
      const { ctx } = setup(id);
      ctx[mode] = true;
      assert.equal(new CombatSystem().tryAttack(ctx, id), false);
    }
    const { ctx } = setup(id);
    ctx.npcs = [npc(1, 0.5, 0, { dead: true }), npc(2, 0.5, 0, { inVehicle: true }),
      npc(3, 0.5, 0, { health: 0 }), npc(4, 0.5, 0, { state: 'dead' })];
    new CombatSystem().tryAttack(ctx, id);
    assert.deepEqual(ctx.npcs.map((n) => n.health), [45, 45, 0, 45]);
  }
});

test('fatal bat hit clamps health and creates a single drop', () => {
  const { ctx, events } = setup('bat');
  const combat = new CombatSystem();
  ctx.npcs = [npc(1, 0.5, 0, { health: 1 })];
  combat.tryAttack(ctx, 'bat');
  assert.equal(ctx.npcs[0].health, 0);
  assert.equal(ctx.npcs[0].dead, true);
  assert.equal(events.drops.length, 1);
  combat.update(MELEE_DEFS.bat.cooldown);
  combat.tryAttack(ctx, 'bat');
  assert.equal(events.drops.length, 1);
});

test('punch and bat animation have continuous windup, visible extension and full return', () => {
  for (const id of ['unarmed', 'bat']) {
    const duration = MELEE_DEFS[id].animationSeconds;
    const sample = (phase) => meleeMotion(id, duration * (1 - phase));
    near(sample(0).reach, 0);
    near(sample(0.28).reach, -0.22);
    near(sample(0.55).reach, 1);
    near(sample(1).reach, 0);
    near(sample(0.28 - 1e-6).reach, sample(0.28 + 1e-6).reach);
    near(sample(0.55 - 1e-6).reach, sample(0.55 + 1e-6).reach);
    for (let frame = 0; frame < 60; frame++) {
      const pose = sample(frame / 59);
      assert.ok(Number.isFinite(pose.reach) && Number.isFinite(pose.swing));
    }
    if (id === 'bat') assert.ok(sample(0.55).swing - sample(0.28).swing > 2);
  }
});

// Real GameState orchestration with only native audio/assets/store and unrelated
// simulation actors stubbed. No React Native or Skia runtime is required by Node.
function stub(relative, exports) {
  const filename = path.join(compiled, relative);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}
const ui = { paused: false, mapOpen: false, shopOpen: false, overlay: null, mapMarker: null, mapRoute: [] };
stub('audio/SoundManager.js', { sound: { play() {}, ambient() {}, weather() {}, setLoop() {}, stopLoops() {} } });
stub('assets/AssetRegistry.js', { spriteKeyForVehicle: () => '', damagedVehicleKey: () => null });
stub('stores/useGameStore.js', { useGameStore: {
  getState: () => ui, showOverlay: (kind) => { ui.overlay = kind; },
  clearMapMarker() {}, refreshMapRoute() {},
  openShop() { ui.shopOpen = true; }, closeShop() { ui.shopOpen = false; },
} });
const { GameState } = require(path.join(compiled, 'game/GameState.js'));
function gameFixture() {
  Object.assign(ui, { paused: false, mapOpen: false, overlay: null, mapMarker: null });
  const random = Math.random;
  let game;
  Math.random = () => 0.5;
  try { game = new GameState(); } finally { Math.random = random; }
  game.player = createPlayer(10, 10);
  game.npcs = [];
  game.vehicles = [];
  game.pickups.items = [];
  game.map.queryNearby = () => [];
  game.movement.updatePlayer = () => {};
  game.movement.updateVehicle = () => {};
  game.trafficSystem.update = () => {};
  game.npcSystem.update = () => {};
  game.police.update = () => {};
  game.missions.update = () => {};
  return game;
}

test('GameState keeps unarmed and bat taps melee; equipped pistol taps and SMG holds shoot', () => {
  const game = gameFixture();
  let melee = 0;
  game.combat.tryAttack = () => { melee++; return true; };
  input.setAttackHeld(true);
  game.update(1 / 60);
  game.update(0.5);
  assert.equal(melee, 1);
  input.setAttackHeld(false);
  input.queueWeapon();
  game.update(1 / 60);
  assert.equal(game.weapons.equipped, 'bat');
  input.setAttackHeld(true);
  game.update(1 / 60);
  game.update(0.5);
  assert.equal(melee, 2, 'bat taps route to melee, not gunfire');
  input.setAttackHeld(false);
  game.weapons.acquire('pistol');
  game.weapons.acquire('smg');
  game.weapons.equipped = 'pistol';
  input.setAttackHeld(true);
  game.update(1 / 60);
  game.update(0.4);
  assert.equal(game.weapons.ammo.pistol.loaded, 11);
  input.setAttackHeld(false);
  input.queueWeapon();
  game.update(1 / 60);
  assert.equal(game.weapons.equipped, 'smg', 'owned guns cycle in pickup order');
  input.setAttackHeld(true);
  game.update(1 / 60);
  game.update(0.1);
  assert.equal(game.weapons.ammo.smg.loaded, 28);
  assert.equal(melee, 2);
});

test('GameState drains actions while driving/swimming and cancels reload before transfer', () => {
  for (const swimming of [false, true]) {
    const game = gameFixture();
    game.weapons.acquire('pistol');
    game.weapons.equipped = 'pistol';
    game.weapons.ammo.pistol.loaded = 3;
    game.weapons.reload();
    if (swimming) game.player.swimming = true;
    else game.player.currentVehicleId = 42;
    input.setAttackHeld(true);
    input.queueReload();
    input.queueWeapon();
    game.update(2);
    assert.equal(game.weapons.reloadLeft, 0);
    assert.equal(game.weapons.equipped, 'pistol');
    assert.equal(game.weapons.ammo.pistol.loaded, 3);
    assert.equal(input.inputState.attackHeld, false);
    assert.equal(input.inputState.weaponQueued, 0);
    for (const key of ['attackQueued', 'reloadQueued', 'crouchQueued']) assert.equal(input.inputState[key], false);
    game.player.swimming = false;
    game.player.currentVehicleId = null;
    game.update(1 / 60);
    assert.equal(game.weapons.ammo.pistol.loaded, 3);
  }
});

test('actual vehicle entry cancels reload on its completion tick and discards firing', () => {
  const game = gameFixture();
  const car = vehicle(900, 10.8, 10);
  game.vehicles = [car];
  game.trafficSystem.tryStealCar = () => false;
  game.weapons.acquire('pistol');
  game.weapons.equipped = 'pistol';
  game.weapons.ammo.pistol.loaded = 3;
  game.weapons.reload();
  input.queueEnter();
  input.setAttackHeld(true);
  input.queueReload();
  input.queueWeapon();
  game.update(WEAPON_DEFS.pistol.reloadSeconds);
  assert.equal(game.player.currentVehicleId, car.id);
  assert.equal(game.weapons.reloadLeft, 0);
  assert.equal(game.weapons.equipped, 'pistol');
  assert.equal(game.weapons.ammo.pistol.loaded, 3);
  assert.equal(game.weapons.ammo.pistol.reserve, WEAPON_DEFS.pistol.reserveAmmo);
  assert.equal(game.weapons.tracers.length, 0);
  assert.equal(input.inputState.attackHeld, false);
});

test('GameState gates paused/map/overlay ticks and clears held actions before resuming', () => {
  for (const mode of ['paused', 'storePause', 'mapOpen', 'overlay']) {
    const game = gameFixture();
    game.weapons.acquire('pistol');
    game.weapons.equipped = 'pistol';
    if (mode === 'paused') game.paused = true;
    if (mode === 'storePause') ui.paused = true;
    if (mode === 'mapOpen') ui.mapOpen = true;
    if (mode === 'overlay') ui.overlay = 'wasted';
    input.setAttackHeld(true);
    input.queueReload();
    input.queueWeapon();
    game.update(0.5);
    assert.equal(game.time, 0);
    assert.equal(game.weapons.ammo.pistol.loaded, 12);
    assert.equal(game.weapons.equipped, 'pistol');
    assert.equal(input.inputState.attackHeld, false);
    game.paused = ui.paused = ui.mapOpen = false;
    ui.overlay = null;
    game.update(1 / 60);
    assert.equal(game.weapons.ammo.pistol.loaded, 12);
  }
});

test('vehicle killed by gunshot reaches DestructionSystem in the same GameState tick', () => {
  const game = gameFixture();
  const target = vehicle(900, 13.5, 10, { health: 1, occupied: true });
  game.vehicles = [target];
  game.weapons.acquire('pistol');
  game.weapons.equipped = 'pistol';
  input.queueAttack();
  game.update(1 / 60);
  assert.equal(target.health, 0);
  assert.equal(target.state, 'destroyed');
  assert.equal(game.destruction.wrecks.length, 1);
  assert.equal(game.weapons.ammo.pistol.loaded, 11);
});

test('GameState round reset returns to melee-only without transferring ammo', () => {
  const game = gameFixture();
  game.weapons.acquire('pistol');
  game.weapons.equipped = 'pistol';
  input.queueAttack();
  game.update(1 / 60);
  game.weapons.reload();
  game.player.swimming = true;
  input.setAttackHeld(true);
  input.queueReload();
  input.queueWeapon();
  game.finishRound('wasted', 100, 'hospital');
  assert.equal(ui.overlay, 'wasted');
  assert.equal(game.weapons.equipped, 'unarmed');
  assert.equal(game.weapons.reloadLeft, 0);
  assert.equal(game.weapons.tracers.length, 0);
  assert.equal(game.weapons.fireFlash, 0);
  assert.equal(game.player.swimming, false);
  assert.deepEqual([...game.weapons.owned], ['unarmed', 'bat']);
  for (const id of GUN_IDS) assert.deepEqual(game.weapons.ammo[id], { loaded: 0, reserve: 0 });
  assert.equal(input.inputState.attackHeld, false);
  assert.equal(input.consumeAttack(), false);
  assert.equal(input.consumeReload(), false);
  assert.equal(input.consumeWeapon(), 0);
  assert.equal(input.consumeCrouch(), false);
  ui.overlay = null;
});

test('ammo crate refills only owned guns and respawns at its marked location', () => {
  const game = gameFixture();
  game.pickups.init(game.map, () => 0.5);
  const crate = game.pickups.items.find((p) => p.kind === 'ammo');
  assert.ok(crate);
  const location = { x: crate.x, y: crate.y };
  Object.assign(game.player, location);
  game.weapons.acquire('pistol');
  game.weapons.acquire('smg');
  game.weapons.ammo.pistol = { loaded: 1, reserve: 4 };
  game.weapons.ammo.smg = { loaded: 2, reserve: 5 };
  game.update(1 / 60);
  assert.equal(crate.active, false);
  assert.deepEqual(game.weapons.ammo.pistol, { loaded: 12, reserve: 48 });
  assert.deepEqual(game.weapons.ammo.smg, { loaded: 30, reserve: 90 });
  assert.deepEqual(game.weapons.ammo.rifle, { loaded: 0, reserve: 0 }, 'unowned rifles stay empty');
  game.player.x += 10;
  game.pickups.update(crate.respawnAt, game.player, () => 0, () => {});
  assert.equal(crate.active, true);
  assert.deepEqual({ x: crate.x, y: crate.y }, location);
});

test('gun caches grant each weapon with a full loadout and keep their buried location', () => {
  const game = gameFixture();
  game.pickups.init(game.map, () => 0.5);
  const caches = game.pickups.items.filter((p) => p.kind === 'gun');
  assert.equal(caches.length, GAME_CONFIG.PICKUP_GUN_COUNT);
  const byWeapon = new Map(caches.map((c) => [c.weapon, c]));
  assert.deepEqual([...byWeapon.keys()].sort(), [...GUN_IDS].sort(), 'every gun is findable');
  for (const id of GUN_IDS) assert.equal(game.weapons.owned.has(id), false);
  const cache = byWeapon.get('rifle');
  const location = { x: cache.x, y: cache.y };
  Object.assign(game.player, location);
  game.update(1 / 60);
  assert.equal(cache.active, false);
  for (const id of GUN_IDS) {
    assert.equal(game.weapons.owned.has(id), true, `${id} granted`);
    assert.deepEqual(game.weapons.ammo[id], {
      loaded: WEAPON_DEFS[id].magazineSize, reserve: WEAPON_DEFS[id].reserveAmmo });
  }
  assert.ok(isGunId(game.weapons.equipped), 'the last cache picked is equipped');
  // Caches are hidden in fixed spots: they respawn in place instead of migrating.
  game.player.x += 10;
  for (const c of caches) game.pickups.update(c.respawnAt, game.player, () => 0.5, () => {});
  for (const c of caches) assert.equal(c.active, true);
  assert.deepEqual({ x: cache.x, y: cache.y }, location, 'hidden caches do not migrate');
});

test('a pistol dropped by a killed cop is picked up temporarily at the body', () => {
  const game = gameFixture();
  game.weapons.ammo.pistol = { loaded: 0, reserve: 0 };
  game.pickups.spawnWeaponDrop(4, 5, 'pistol');
  const loot = game.pickups.items.at(-1);
  assert.equal(loot.kind, 'gun');
  assert.equal(loot.weapon, 'pistol');
  assert.equal(loot.temporary, true);
  Object.assign(game.player, { x: 4, y: 5 });
  game.update(1 / 60);
  assert.equal(game.weapons.ammo.pistol.loaded, WEAPON_DEFS.pistol.magazineSize);
  assert.equal(game.weapons.ammo.pistol.reserve, WEAPON_DEFS.pistol.reserveAmmo);
});

test('ammo crates reject vehicle/swimming collection and survive cash-drop limits', () => {
  const game = gameFixture();
  game.pickups.init(game.map, () => 0.5);
  const crate = game.pickups.items.find((p) => p.kind === 'ammo');
  Object.assign(game.player, { x: crate.x, y: crate.y, currentVehicleId: 42 });
  game.pickups.update(1, game.player, () => 0.5, () => {});
  assert.equal(crate.active, true);
  game.player.currentVehicleId = null;
  game.player.swimming = true;
  game.pickups.update(2, game.player, () => 0.5, () => {});
  assert.equal(crate.active, true);
  for (let i = 0; i < 120; i++) game.pickups.spawnDrop(0, 0, 20);
  assert.ok(game.pickups.items.includes(crate));
  assert.equal(game.pickups.items.length, 80);
});

test('all directional weapon sprites and CC0 source models are present', () => {
  const fs = require('node:fs');
  const { PNG } = require('pngjs');
  const provenance = JSON.parse(fs.readFileSync(path.join(root, 'assets/weapon-source/source.json'), 'utf8'));
  assert.equal(provenance.license, 'CC0-1.0');
  assert.equal(provenance.models.rifle, 'blasterD');
  assert.equal(provenance.models.shotgun, 'blasterG');
  assert.equal(provenance.models.sniper, 'blasterE');
  assert.equal(provenance.models.revolver, 'blasterJ');
  assert.equal(provenance.models.micro, 'blasterN');
  assert.ok(provenance.originalBat.includes('Original'));
  assert.match(fs.readFileSync(path.join(root, 'assets/weapon-source/License.txt'), 'utf8'), /Creative Commons Zero/);
  for (const id of [...GUN_IDS, 'bat']) {
    for (const direction of ['NE', 'NW', 'SE', 'SW', 'icon']) {
      const image = PNG.sync.read(fs.readFileSync(path.join(root, `assets/sprites/Weapons/${id}_${direction}.png`)));
      // A vista lateral do rifle de precisão é o cano inteiro: o ícone é maior que o sprite.
      const maxWidth = direction === 'icon' ? 340 : 250;
      assert.ok(image.width > 0 && image.width < maxWidth && image.height > 0 && image.height < 200);
      assert.ok(image.data.some((value, index) => index % 4 === 3 && value > 0));
    }
  }
  for (const letter of ['K', 'J', 'I', 'N', 'D', 'E', 'G']) {
    const glb = fs.readFileSync(path.join(root, `assets/weapon-source/Models/GLTF format/blaster${letter}.glb`));
    assert.equal(glb.toString('ascii', 0, 4), 'glTF');
    for (const dir of ['NE', 'NW', 'SE', 'SW']) {
      const render = PNG.sync.read(fs.readFileSync(path.join(root, `assets/weapon-source/Isometric/blaster${letter}_${dir}.png`)));
      assert.ok(render.width > 0 && render.height > 0);
    }
    assert.ok(fs.existsSync(path.join(root, `assets/weapon-source/Side/blaster${letter}.png`)));
  }
  for (const name of ['pistol_shot', 'revolver_shot', 'smg_shot', 'micro_shot', 'rifle_shot', 'sniper_shot', 'weapon_reload', 'weapon_empty']) {
    const wav = fs.readFileSync(path.join(root, `assets/Audio/generated/${name}.wav`));
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
    assert.equal(wav.readUInt16LE(20), 1);
    assert.equal(wav.readUInt32LE(24), 22050);
    assert.equal(wav.readUInt32LE(40), wav.length - 44);
  }
});

// Render the actual EntitySprite + MeleeSwing trees to CPU Skia, without RN/browser.
// Model hooks/polling, but execute production image resolution, clips and transforms.
async function checkMeleeRender() {
  const fs = require('node:fs');
  const vm = require('node:vm');
  const ts = require('typescript');
  const { PNG } = require('pngjs');
  const ck = await require('canvaskit-wasm')();
  const allocated = [];
  const spriteStore = {};
  const intervals = new Set();
  let hooks;
  let game;
  function useState(initial) {
    const owner = hooks;
    const i = owner.cursor++;
    if (!(i in owner.slots)) owner.slots[i] = typeof initial === 'function' ? initial() : initial;
    return [owner.slots[i], (next) => {
      owner.slots[i] = typeof next === 'function' ? next(owner.slots[i]) : next;
    }];
  }
  function useRef(initial) {
    const owner = hooks;
    const i = owner.cursor++;
    if (!(i in owner.slots)) owner.slots[i] = { current: initial };
    return owner.slots[i];
  }
  const reactHooks = {
    useState,
    useRef,
    useEffect(fn) {
      const i = hooks.cursor++;
      if (!(i in hooks.slots)) { hooks.slots[i] = true; hooks.effects.push(fn); }
    },
  };
  const reanimated = {
    useSharedValue(initial) { return useState(() => ({ value: initial }))[0]; },
    useDerivedValue: (fn) => ({ get value() { return fn(); } }),
  };
  const modules = {};
  function load(relative) {
    if (modules[relative]) return modules[relative].exports;
    const module = modules[relative] = { exports: {} };
    const source = fs.readFileSync(path.join(root, relative), 'utf8');
    const js = ts.transpileModule(source, { compilerOptions: {
      module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2020,
    } }).outputText;
    vm.runInNewContext(js, {
      exports: module.exports, module,
      setInterval(fn) { intervals.add(fn); return fn; },
      clearInterval(fn) { intervals.delete(fn); },
      require(id) {
        if (id === 'react') return reactHooks;
        if (id === '@shopify/react-native-skia') return {
          Group: 'Group', Image: 'Image', Circle: 'Circle', Path: 'Path', Skia: {
            Path: { Make() { const p = new ck.Path(); allocated.push(p); return p; } },
          },
        };
        if (id === 'react-native-reanimated') return reanimated;
        if (id === '../entities/Player') return require(path.join(compiled, 'entities/Player.js'));
        if (id === '../entities/NPC') return load('src/entities/NPC.ts');
        if (id === '../game/GameState') return { getGame: () => game };
        if (id === '../assets/SpriteStore') return { spriteStore };
        if (id === '../assets/AssetRegistry') return load('src/assets/AssetRegistry.ts');
        if (id === '../world/IsoUtils') return load('src/world/IsoUtils.ts');
        if (id === './AssetManifest') return { ASSET_FILES: {} };
        if (id === './SharedValues') return { entitySVs: new Map() };
        if (id === './ContactShadow') return load('src/render/ContactShadow.ts');
        if (id === './entityImages') return load('src/render/entityImages.ts');
        if (id === './WeaponEffects') return load('src/render/WeaponEffects.tsx');
        if (id === '../data/weapons') return { isGunId };
        return require(id);
      },
    });
    return module.exports;
  }
  const { MeleeSwing } = load('src/render/WeaponEffects.tsx');
  const { EntitySprite } = load('src/render/EntitySprite.tsx');
  const { characterKey, weaponKey } = load('src/assets/AssetRegistry.ts');
  function asset(key) {
    if (!spriteStore[key]) {
      spriteStore[key] = ck.MakeImageFromEncoded(fs.readFileSync(path.join(root, 'assets/sprites', key)));
      assert.ok(spriteStore[key], key);
    }
    return spriteStore[key];
  }
  function mount() {
    game = { player: createPlayer(0, 0), npcs: [], vehicles: [], time: 0,
      map: { heightAt: () => 0, heightSmoothAt: () => 0 },
      weapons: { equipped: 'unarmed', aimAngle: 0, fireFlash: 0 } };
    const owner = { cursor: 0, slots: [], effects: [], cleanups: [] };
    const render = () => {
      hooks = owner;
      owner.cursor = 0;
      const tree = EntitySprite({ id: 'player' });
      owner.effects.splice(0).forEach((fn) => owner.cleanups.push(fn()));
      return tree;
    };
    render();
    return {
      tick() { intervals.forEach((fn) => fn()); return render(); },
      dispose() { owner.cleanups.forEach((fn) => fn?.()); },
    };
  }
  const surface = ck.MakeSurface(144, 144);
  assert.ok(surface);
  const canvas = surface.getCanvas();
  const value = (v) => v && typeof v === 'object' && 'value' in v ? v.value : v;
  function drawTree(node, onlyImage, opacity = 1) {
    if (!node) return;
    if (Array.isArray(node)) { node.forEach((n) => drawTree(n, onlyImage, opacity)); return; }
    if (typeof node.type === 'function') {
      // Isolate the real base Image for pixel assertions; keep all its ancestor clips.
      if (!onlyImage) drawTree(node.type(node.props), onlyImage, opacity);
      return;
    }
    const props = node.props;
    opacity *= value(props.opacity) ?? 1;
    if (node.type === 'Group') {
      canvas.save();
      for (const t of value(props.transform) ?? []) {
        if ('translateX' in t) canvas.translate(t.translateX, 0);
        if ('translateY' in t) canvas.translate(0, t.translateY);
        if ('rotate' in t) canvas.rotate(t.rotate * 180 / Math.PI, 0, 0); // Skia props use radians.
        if ('scale' in t) canvas.scale(t.scale, t.scale);
        if ('scaleX' in t) canvas.scale(t.scaleX, 1);
        if ('scaleY' in t) canvas.scale(1, t.scaleY);
      }
      if (props.clip) {
        const clip = value(props.clip), op = props.invertClip ? ck.ClipOp.Difference : ck.ClipOp.Intersect;
        if (typeof clip.width === 'number' && typeof clip.height === 'number') {
          canvas.clipRect(ck.XYWHRect(clip.x, clip.y, clip.width, clip.height), op, true);
        } else canvas.clipPath(clip, op, true);
      }
      drawTree(props.children, onlyImage, opacity);
      canvas.restore();
      return;
    }
    if (typeof node.type === 'symbol') { drawTree(props.children, onlyImage, opacity); return; }
    if (onlyImage && (node.type !== 'Image' || props.image !== onlyImage)) return;
    const paint = new ck.Paint();
    const color = ck.parseColorString(props.color ?? '#ffffff');
    paint.setColor(color);
    paint.setAlphaf(color[3] * opacity);
    paint.setAntiAlias(true);
    paint.setStyle(props.style === 'stroke' ? ck.PaintStyle.Stroke : ck.PaintStyle.Fill);
    paint.setStrokeWidth(props.strokeWidth ?? 1);
    paint.setStrokeCap(ck.StrokeCap.Round);
    paint.setStrokeJoin(ck.StrokeJoin.Round);
    if (node.type === 'Path') canvas.drawPath(value(props.path), paint);
    else if (node.type === 'Image') canvas.drawImageRectOptions(props.image,
      ck.XYWHRect(0, 0, props.image.width(), props.image.height()),
      ck.XYWHRect(props.x, props.y, props.width, props.height),
      ck.FilterMode.Nearest, ck.MipmapMode.None, paint);
    else if (node.type === 'Circle') canvas.drawCircle(value(props.cx), value(props.cy), value(props.r), paint);
    else assert.fail(`Unsupported Skia node: ${String(node.type)}`);
    paint.delete();
  }
  function snapshot(tree, onlyImage) {
    canvas.clear(ck.TRANSPARENT);
    canvas.save();
    canvas.translate(72, 96);
    drawTree(tree, onlyImage);
    canvas.restore();
    surface.flush();
    const image = surface.makeImageSnapshot();
    const png = Buffer.from(image.encodeToBytes());
    image.delete();
    // Varredura aqui estava errada: o sprite e o golpe guardam o `SkPath` num ref e o rebobinam
    // a cada quadro — apagar tudo depois de um snapshot matava alça viva, e o `rewind()` do
    // quadro seguinte morria em `Cannot pass deleted object`. Quem cuida da memória da web é o
    // check-memory-browser; aqui a única dívida é o fim do cenário, logo abaixo.
    return png;
  }
  const dirs = ['SE', 'SW', 'NW', 'NE'];
  // Estes dois cenários desenham o MeleeSwing direto, sem `<Canvas>` nem React. O dono dos hooks
  // precisa sobreviver entre quadros como um componente montado: o path do golpe é um `useRef`
  // rebobinado, e sem slot permanente cada quadro recriaria o path — exatamente o que a produção
  // parou de fazer.
  const bare = { cursor: 0, slots: [], effects: [], cleanups: [] };
  function swing(props) {
    hooks = bare;
    bare.cursor = 0;
    return MeleeSwing(props);
  }
  function frame(weapon, angle, phase, visible = true, withImage = false) {
    const dir = dirs[((Math.round(angle / (Math.PI / 2)) % 4) + 4) % 4];
    return snapshot(swing({ state: { value: {
      weapon, angle, dir, secondsLeft: MELEE_DEFS[weapon].animationSeconds * (1 - phase), visible,
    } }, batImage: withImage ? asset(weaponKey('bat', dir)) : null }));
  }
  test('actual Skia render changes fists/vector bat/sprite bat in four directions', () => {
    for (const [id, withImage] of [['unarmed', false], ['bat', false], ['bat', true]]) {
      for (const angle of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
        const start = frame(id, angle, 0, true, withImage);
        const windup = frame(id, angle, 0.28, true, withImage);
        const extension = frame(id, angle, 0.55, true, withImage);
        const finish = frame(id, angle, 1, true, withImage);
        assert.notDeepEqual(windup, start, `${id} windup is visible`);
        assert.notDeepEqual(extension, windup, `${id} extension is visible`);
        assert.notDeepEqual(extension, finish, `${id} return is visible`);
        assert.deepEqual(start, finish, `${id} returns to resting pose`);
        assert.notDeepEqual(extension, frame(id, angle, 0.55, false, withImage), `${id} is not hidden`);
      }
    }
  });
  test('retained bat Image reacts to visible/weapon changes without a React rerender', () => {
    const empty = snapshot(null);
    for (const [i, dir] of dirs.entries()) {
      const state = { value: { weapon: 'bat', angle: i * Math.PI / 2, dir, secondsLeft: 0.2, visible: true } };
      const tree = swing({ state, batImage: asset(weaponKey('bat', dir)) });
      assert.notDeepEqual(snapshot(tree), empty);
      state.value.visible = false;
      assert.deepEqual(snapshot(tree), empty, `${dir}: no floating bat when invisible`);
      state.value.visible = true;
      state.value.weapon = 'unarmed';
      assert.deepEqual(snapshot(tree), snapshot(swing({ state })), `${dir}: stale bat hidden after swap`);
    }
  });
  const pixel = (png, x, y) => png.data.subarray(((64 + y) * png.width + 60 + x) * 4,
    ((64 + y) * png.width + 60 + x) * 4 + 4);
  test('base sprite loses only the striking arm while melee is visible, all chars/dirs/walk frames', () => {
    const view = mount();
    for (const char of ['b', 'a', 'c']) for (const direction of dirs) {
      for (const [anim, f] of [['idle', 0], ['walk', 0], ['walk', 1], ['walk', 2], ['walk', 3]]) {
        Object.assign(game.player, { char, direction, anim, frame: f, attackTimer: 0 });
        const body = asset(characterKey(char, anim, direction, f));
        const idle = snapshot(view.tick(), body);
        // Inactive render is exactly the original asset, not an armless replacement.
        const original = PNG.sync.read(fs.readFileSync(path.join(root, 'assets/sprites', characterKey(char, anim, direction, f))));
        const base = PNG.sync.read(idle);
        for (let y = 0; y < 32; y++) for (let x = 0; x < 24; x++) {
          near(pixel(base, x, y)[3], original.data[(y * 24 + x) * 4 + 3], 1);
        }
        for (const right of [true, false]) {
          // Also strike opposite to the walking sprite: the captured attack angle chooses the side.
          game.player.attackAngle = right ? 0 : Math.PI;
          game.player.attackTimer = 0.15;
          const cut = PNG.sync.read(snapshot(view.tick(), body));
          const label = `${char}/${direction}/${anim}/${f}/${right ? 'right' : 'left'}`;
          const nearArm = right === (direction === 'NE' || direction === 'SW');
          const pose = anim === 'idle' || f === 1 || f === 3 ? 0 : f === 0 ? 1 : 2;
          const probes = nearArm
            ? [[[16, 15], [14, 18], [16, 11]], [[14, 16], [12, 20], [16, 12]], [[19, 17], [16, 14], [16, 11]]][pose]
            : [[[16, 12], [17, 15], [16, 8]], [[16, 10], [16, 8]], [[17, 12], [19, 16], [16, 8]]][pose];
          for (const [px, y] of probes) {
            const x = right ? px : 23 - px;
            assert.ok(pixel(base, x, y)[3] > 100, `${label}: probe was an opaque arm`);
            assert.equal(pixel(cut, x, y)[3], 0, `${label}: original sleeve/forearm removed`);
          }
          let removed = 0;
          for (let y = 0; y < 32; y++) for (let x = 0; x < 24; x++) {
            const a = pixel(base, x, y), b = pixel(cut, x, y);
            const cx = right ? x : 23 - x;
            // Preserve the entire other half/arm, head, torso core and lower legs.
            const blueTrousers = char === 'b' && y >= 16 && a[0] < 100 && a[2] > a[0] * 1.5 && a[2] > a[1] * 1.2;
            if (cx < 12 || y >= 22 || (y < 8 && cx < 15) || (cx < 13 && y < 14) || blueTrousers) {
              assert.deepEqual(b, a, `${label}: protected body pixel ${x},${y}`);
            }
            if (a[3] !== b[3]) { removed++; assert.equal(b[3], 0, `${label}: clean pixel-edge clip`); }
          }
          assert.ok(removed >= 12 && removed < 120, `${label}: bounded arm removal (${removed})`);
          game.player.attackTimer = 0;
          assert.deepEqual(snapshot(view.tick(), body), idle, `${label}: complete sprite restored`);
        }
      }
    }
    view.dispose();
  });
  test('EntitySprite composes clipped b sprite with animated punch/bat in all four directions', () => {
    const view = mount();
    const p = game.player;
    for (const weapon of ['unarmed', 'bat']) for (const [i, direction] of dirs.entries()) {
      Object.assign(p, { direction, facingAngle: i * Math.PI / 2, attackAngle: i * Math.PI / 2, attackWeapon: weapon });
      game.weapons.equipped = weapon;
      const body = asset(characterKey(p.char, 'idle', direction, 0));
      asset(weaponKey('bat', direction));
      const composites = [];
      const bases = [];
      for (const phase of [0, 0.28, 0.55, 0.9]) {
        p.attackTimer = MELEE_DEFS[weapon].animationSeconds * (1 - phase);
        const tree = view.tick();
        composites.push(snapshot(tree));
        bases.push(snapshot(tree, body));
      }
      assert.notDeepEqual(composites[0], composites[1], `${weapon}/${direction}: visible windup`);
      assert.notDeepEqual(composites[1], composites[2], `${weapon}/${direction}: visible extension`);
      assert.notDeepEqual(composites[2], composites[3], `${weapon}/${direction}: visible return`);
      bases.forEach((base) => assert.deepEqual(base, bases[0], 'same base arm stays removed throughout swing'));
    }
    view.dispose();
  });
  test('melee mask follows live walking frames and iso strike side, including diagonal angles', () => {
    const view = mount();
    const p = game.player;
    p.anim = 'walk';
    p.speed = 1;
    p.state = 'running';
    p.attackTimer = 0.15;
    const renders = [];
    for (const [i, direction] of dirs.entries()) {
      p.direction = direction;
      p.facingAngle = i * Math.PI / 2;
      for (const angle of [0, Math.PI / 2, Math.PI, -Math.PI / 2, Math.PI * 0.3, -Math.PI * 0.8]) {
        p.attackAngle = angle;
        for (const f of [0, 1, 2, 3]) {
          p.frame = f;
          const body = asset(characterKey(p.char, p.anim, direction, f));
          renders.push(snapshot(view.tick(), body));
        }
      }
    }
    assert.notDeepEqual(renders[0], renders[1], 'walking still advances during a strike');
    assert.notDeepEqual(renders[0], renders[2], 'opposite stride is preserved');
    assert.deepEqual(renders[1], renders[3], 'matching source walk poses stay identical');
    // 0.3 PI has positive cos but negative cos-sin: it must replace the LEFT arm.
    assert.deepEqual(renders[16], renders[4], 'diagonal side matches MeleeSwing, not cos alone');
    view.dispose();
  });
  test('melee restores full base on finish/swap/swim/death and clears missing images/vehicle ghosts', () => {
    const view = mount();
    const p = game.player;
    const body = asset(characterKey(p.char, 'idle', 'SE', 0));
    const idle = snapshot(view.tick(), body);
    // A comparação de "fantasma" abaixo é da árvore inteira, então a referência também tem
    // de ser da árvore inteira: a sombra de contato desenha no chão, fora do recorte do
    // sprite, e uma base sem sombra nunca bateria com um corpo com sombra.
    const idleFull = snapshot(view.tick());
    for (const equipped of ['unarmed', 'bat']) {
      for (const transition of ['swap', 'swim', 'health', 'dead', 'vehicle', 'missing']) {
        Object.assign(p, { attackTimer: 0.15, attackWeapon: equipped, swimming: false,
          currentVehicleId: null, health: 100, state: 'idle' });
        game.weapons.equipped = equipped;
        asset(weaponKey('bat', 'SE'));
        assert.notDeepEqual(snapshot(view.tick(), body), idle);
        if (transition === 'swap') game.weapons.equipped = equipped === 'bat' ? 'unarmed' : 'pistol';
        if (transition === 'swim') p.swimming = true;
        if (transition === 'health') p.health = 0;
        if (transition === 'dead') p.state = 'dead';
        if (transition === 'vehicle') p.currentVehicleId = 42;
        const key = characterKey(p.char, p.anim, p.direction, p.frame);
        if (transition === 'missing') delete spriteStore[key];
        const tree = view.tick();
        if (transition === 'vehicle' || transition === 'missing') {
          assert.equal(tree, null, `${transition}: no old sprite or floating melee`);
          spriteStore[key] = body;
          p.currentVehicleId = null;
        } else if (transition === 'swim') {
          const swimming = snapshot(tree);
          game.weapons.equipped = 'unarmed';
          p.attackTimer = 0;
          assert.deepEqual(swimming, snapshot(view.tick()), 'swimming has neither arm cut nor floating bat');
        } else {
          assert.deepEqual(snapshot(tree, body), idle, `${transition}: full base restored`);
          if (equipped === 'bat') assert.deepEqual(snapshot(tree), idleFull, `${transition}: stale bat absent`);
        }
        Object.assign(p, { attackTimer: 0, swimming: false, health: 100, state: 'idle' });
        game.weapons.equipped = 'unarmed';
        assert.deepEqual(snapshot(view.tick()), idleFull, `${transition}: recovered sprite without ghosts`);
      }
    }
    game.weapons.equipped = 'bat';
    const heldBat = snapshot(view.tick(), body);
    assert.notDeepEqual(heldBat, idle, 'resting visible bat still replaces the base arm');
    game.weapons.equipped = 'unarmed';
    assert.deepEqual(snapshot(view.tick()), idleFull, 'unequipping the resting bat restores both base arms');
    view.dispose();
  });
  test('crouch renderer lowers the rigid torso by eight pixels and keeps folded feet on the ground', () => {
    const view = mount(); const p = game.player;
    const bounds = (png) => {
      let minY = png.height, maxY = -1;
      for (let y = 0; y < png.height; y++) for (let x = 0; x < png.width; x++) {
        if (png.data[(y * png.width + x) * 4 + 3] > 100) { minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
      }
      return { minY, maxY };
    };
    for (const char of ['a', 'b', 'c']) for (const direction of dirs) {
      Object.assign(p, { char, direction, crouching: false, anim: 'idle', frame: 0, speed: 0 });
      const body = asset(characterKey(char, 'idle', direction, 0));
      const standing = PNG.sync.read(snapshot(view.tick(), body));
      p.crouching = true;
      const crouched = PNG.sync.read(snapshot(view.tick(), body));
      const a = bounds(standing), b = bounds(crouched);
      near(b.minY - a.minY, 8, 0); near(b.maxY, a.maxY, 1);
      for (let y = 0; y < 20; y++) for (let x = 0; x < 24; x++) {
        assert.deepEqual(pixel(crouched, x, y + 8), pixel(standing, x, y), `${char}/${direction}: rigid torso pixel`);
      }
      p.crouching = false;
      assert.deepEqual(PNG.sync.read(snapshot(view.tick(), body)).data, standing.data, 'standing fully restores the original');
    }
    view.dispose();
  });
  test('crouched gun grip and melee shoulder share the torso offset; jumping and swimming suppress the pose', () => {
    const view = mount(); const p = game.player;
    const groups = (node) => !node ? [] : Array.isArray(node) ? node.flatMap(groups) :
      [node, ...groups(node.props?.children)];
    for (const [i, direction] of dirs.entries()) {
      Object.assign(p, { direction, facingAngle: i * Math.PI / 2, attackAngle: i * Math.PI / 2, crouching: false });
      asset(characterKey(p.char, 'idle', direction, 0));
      game.weapons.aimAngle = i * Math.PI / 2;
      for (const equipped of ['pistol', 'bat', 'unarmed']) {
        game.weapons.equipped = equipped; p.attackWeapon = equipped === 'bat' ? 'bat' : 'unarmed';
        p.attackTimer = equipped === 'pistol' ? 0 : 0.15;
        if (equipped !== 'unarmed') asset(weaponKey(equipped, direction));
        const offset = () => {
          const tree = view.tick(); snapshot(tree);
          const group = groups(tree).find(n => n.type === 'Group' && (equipped === 'pistol'
            ? Array.isArray(n.props.children) && n.props.children.some(c => c?.type === 'Image' && c.props.width === 16)
            : n.props.children?.type === MeleeSwing));
          if (p.swimming && equipped === 'pistol') { assert.equal(group, undefined); return null; }
          assert.ok(group, `${direction}/${equipped}: held visual exists`);
          return value(group.props.transform).filter(t => 'translateY' in t).reduce((sum, t) => sum + t.translateY, 0);
        };
        p.crouching = false; const standingY = offset();
        p.crouching = true; near(offset() - standingY, 8, 0);
        p.jumpTimer = 0.2; near(offset(), standingY, 0); p.jumpTimer = 0;
        p.swimming = true;
        if (equipped === 'pistol') assert.equal(offset(), null);
        else near(offset(), standingY, 0);
        p.swimming = false;
      }
    }
    view.dispose();
  });
  for (const image of Object.values(spriteStore)) image.delete();
  while (allocated.length) allocated.pop().delete();
  surface.dispose();
}
checkMeleeRender().then(() => console.log(`Weapon checks: ${passed} passed, ${failed} failed`)).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
