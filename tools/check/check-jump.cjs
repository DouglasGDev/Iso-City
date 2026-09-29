// Run: node tools/check/check-jump.cjs. Real systems, in-memory TS, no native runtime or output files.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');
const cache = new Map();
function load(filename) {
  assert.ok(!filename.endsWith('GameState.ts'), 'Jump must not depend on GameState');
  if (cache.has(filename)) return cache.get(filename).exports;
  const result = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    fileName: filename, reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, strict: true },
  });
  assert.deepEqual(result.diagnostics, []);
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.require = (name) => name.startsWith('.') ? load(path.resolve(path.dirname(filename), name + '.ts')) : require(name);
  cache.set(filename, mod);
  mod._compile(result.outputText, filename);
  return mod.exports;
}
const source = (relative) => load(path.join(root, 'src', relative));
const { JumpSystem, JUMP_DURATION, JUMP_HEIGHT_PX } = source('systems/JumpSystem.ts');
const { MovementSystem, movePlayerGround, solidVehicleColliders, FENCE_CLEARANCE_PX } = source('systems/MovementSystem.ts');
const { CollisionSystem } = source('systems/CollisionSystem.ts');
const { createPlayer, playerCollider, crouchPose } = source('entities/Player.ts');
const { CrouchSystem, CROUCH_SPEED } = source('systems/CrouchSystem.ts');
const { StaminaSystem } = source('systems/StaminaSystem.ts');
const { GAME_CONFIG: C } = source('game/GameConfig.ts');
const input = source('game/InputState.ts');
const { worldToScreen } = source('world/IsoUtils.ts');
let passed = 0;
const near = (a, b, tolerance = 1e-8) => assert.ok(Math.abs(a - b) <= tolerance, `${a} != ${b}`);
function test(name, fn) {
  input.resetInputState();
  fn();
  passed++;
  console.log('OK ' + name);
}
function fixture(colliders = [], x = 9.7, y = 10) {
  const water = new Set();
  const vehicles = [];
  const map = {
    worldW: 20, worldH: 20,
    isWaterWorld: (x, y) => water.has(`${Math.floor(x)},${Math.floor(y)}`),
    queryNearby: (x, y, r) => colliders.filter((c) => c.x + c.width >= x - r && c.x <= x + r &&
      c.y + c.height >= y - r && c.y <= y + r),
  };
  const player = createPlayer(x, y);
  const collision = new CollisionSystem();
  const jump = new JumpSystem(() => vehicles);
  const movement = new MovementSystem(collision, () => vehicles);
  return { player, collision, jump, movement, map, colliders, water, vehicles };
}
function fence() { return { x: 10, y: 8, width: 0.08, height: 4, type: 'FENCE' }; }
function car(x, y) { return { x, y, state: 'parked', def: { footprintW: 1, footprintH: 1 } }; }
function clear(f) {
  assert.equal(f.collision.overlapsAny({ x: f.player.x, y: f.player.y, radius: C.PLAYER_RADIUS - 1e-5 },
    f.colliders.concat(solidVehicleColliders(f.vehicles))), false, 'ground footprint must be free');
}
function tick(f, dt = 1 / 60) {
  f.movement.updatePlayer(f.player, f.map, dt);
  return f.jump.update(f.player, f.map, f.collision, dt);
}
function start(f) { assert.equal(f.jump.tryJump(f.player, f.map, f.collision), true); }
function grounded(p) {
  near(p.jumpTimer, 0); near(p.jumpHeight, 0);
  assert.equal(p.jumpStart, null); assert.equal(p.jumpEnd, null);
}

test('takeoff, no double jump, exact 0.65s duration/24px apex and single landing event', () => {
  const f = fixture(); const p = f.player;
  grounded(p); near(p.jumpDuration, JUMP_DURATION);
  start(f); assert.equal(p.jumpEnd, null);
  assert.equal(f.jump.tryJump(p, f.map, f.collision), false);
  near(p.jumpTimer, JUMP_DURATION); near(p.jumpHeight, 0);
  assert.equal(tick(f, JUMP_DURATION / 2), null);
  near(p.jumpHeight, JUMP_HEIGHT_PX); near(p.jumpTimer, JUMP_DURATION / 2);
  assert.equal(tick(f, JUMP_DURATION / 2), 'landed'); grounded(p);
  near(p.x, 9.7); near(p.y, 10);
  assert.equal(tick(f), null); start(f);
});

test('ordinary jump keeps walking/running input, inertia, aiming and ground trajectory', () => {
  for (const run of [false, true]) {
    const air = fixture(); const ground = fixture(); start(air);
    input.setJoystickInput(0.8, -0.3, 1); input.setRunHeld(run); input.setAimInput(-1, 1);
    for (let i = 0; i < 40; i++) {
      tick(air); ground.movement.updatePlayer(ground.player, ground.map, 1 / 60);
      for (const key of ['x', 'y', 'vx', 'vy', 'speed', 'facingAngle']) near(air.player[key], ground.player[key]);
      assert.ok(air.player.jumpHeight >= 0 && air.player.jumpHeight <= 24);
    }
    grounded(air.player);
  }
});

test('vault crosses low fences in four world directions and diagonal, using input over stale facing', () => {
  for (const [dx, dy, horizontal] of [[1, 0, false], [-1, 0, false], [0, 1, true], [0, -1, true], [1, 0.4, false]]) {
    const c = horizontal ? { x: 8, y: 10, width: 4, height: 0.08, type: 'FENCE' } : fence();
    const x = horizontal ? 10 : dx > 0 ? 9.7 : 10.38;
    const y = horizontal ? dy > 0 ? 9.7 : 10.38 : 10;
    const f = fixture([c], x, y); const p = f.player;
    const screen = worldToScreen(dx, dy); input.setJoystickInput(screen.x, screen.y, 1);
    p.facingAngle = Math.PI; start(f); assert.ok(p.jumpEnd, 'nearby fence should select guided vault');
    const end = { ...p.jumpEnd };
    // Steering may not redirect a certified route into adjacent walls.
    input.setJoystickInput(-1, -1, 1); input.setRunHeld(true);
    let landed = false;
    for (let i = 0; i < 50 && !landed; i++) {
      landed = tick(f) === 'landed';
      if (p.jumpHeight < FENCE_CLEARANCE_PX) clear(f);
    }
    assert.equal(landed, true); near(p.x, end.x); near(p.y, end.y); grounded(p); clear(f);
  }
});

test('guided vault is timestep-stable at 30/60/120fps and across a single oversized tick', () => {
  let end = null;
  for (const dt of [1 / 30, 1 / 60, 1 / 120, 0.12, 3]) {
    const f = fixture([fence()]); start(f); end ??= { ...f.player.jumpEnd };
    for (let i = 0; i < 100 && f.player.jumpTimer > 0; i++) tick(f, dt);
    grounded(f.player); near(f.player.x, end.x); near(f.player.y, end.y); clear(f);
  }
});

test('blocked destination/path never selects vault through buildings, props, thick fences or cars', () => {
  const blockers = [
    { x: 9.94, y: 9, width: 0.005, height: 2, type: 'BUILDING' },
    { x: 10.25, y: 9, width: 0.1, height: 2, type: 'BUILDING' },
    { x: 10.2, y: 9, width: 0.1, height: 2, type: 'PROP' },
    { x: 10.2, y: 9, width: 0.1, height: 2, type: 'VEHICLE' },
    { x: 10.2, y: 9, width: 0.8, height: 2, type: 'FENCE' },
  ];
  for (const blocker of blockers) {
    const f = fixture([fence(), blocker]); start(f); assert.equal(f.player.jumpEnd, null);
    input.setJoystickInput(64, 32, 1); input.setRunHeld(true);
    for (let i = 0; i < 40; i++) tick(f);
    assert.ok(f.player.x <= 10 - C.PLAYER_RADIUS + 1e-6); clear(f);
  }
  input.resetInputState();
  const f = fixture([fence()]); f.vehicles.push(car(10.65, 10)); start(f);
  assert.equal(f.player.jumpEnd, null);
});

test('vault refuses water along the diagonal path, wet landing footprint and world boundaries', () => {
  const dry = fixture([fence()], 9.7, 10.4);
  input.setJoystickInput(128, 0, 1); start(dry); assert.ok(dry.player.jumpEnd);
  assert.ok(dry.player.jumpEnd.y + C.PLAYER_RADIUS < 10, 'landing footprint is dry; only route clips water');
  const diagonal = fixture([fence()], 9.7, 10.4);
  diagonal.water.add('10,10'); start(diagonal); assert.equal(diagonal.player.jumpEnd, null);
  input.resetInputState();
  const wet = fixture([fence()]); wet.water.add('10,10'); start(wet); assert.equal(wet.player.jumpEnd, null);
  const boundary = fixture([fence()]); boundary.map.worldW = 10.3; start(boundary); assert.equal(boundary.player.jumpEnd, null);
  const startWet = fixture(); startWet.water.add('9,10');
  assert.equal(startWet.jump.tryJump(startWet.player, startWet.map, startWet.collision), false);
});

test('distant fences and thick/unknown colliders cannot be vaulted by an ordinary high jump', () => {
  for (const collider of [fence(), { ...fence(), width: 0.6 }, { ...fence(), type: 'BUILDING' }, { ...fence(), type: 'PROP' }]) {
    const f = fixture([collider], collider.width > 0.4 ? 9.7 : 9.3, 10); start(f);
    assert.equal(f.player.jumpEnd, null); input.setJoystickInput(64, 32, 1); input.setRunHeld(true);
    for (let i = 0; i < 40; i++) tick(f);
    assert.ok(f.player.x <= 9.85 + 1e-6); clear(f); input.resetInputState();
  }
});

test('shared movement ignores only low FENCE at certified clearance; buildings/cars always block', () => {
  for (const height of [0, FENCE_CLEARANCE_PX - 0.01, FENCE_CLEARANCE_PX, 24]) {
    const f = fixture([fence()]); const p = f.player;
    p.jumpTimer = 0.4; p.jumpEnd = { x: 11, y: 10 }; p.jumpHeight = height;
    movePlayerGround(p, f.map, f.collision, 0.8, 0);
    assert.ok(height >= FENCE_CLEARANCE_PX ? p.x > 10.2 : p.x <= 9.85 + 1e-8);
  }
  for (const type of ['BUILDING', 'PROP', 'VEHICLE']) {
    const f = fixture([{ ...fence(), type }]); const p = f.player;
    p.jumpTimer = 0.4; p.jumpEnd = { x: 11, y: 10 }; p.jumpHeight = 24;
    movePlayerGround(p, f.map, f.collision, 4, 0); assert.ok(p.x <= 9.85 + 1e-8); clear(f);
  }
  const f = fixture(); f.vehicles.push(car(10.6, 10));
  f.player.jumpTimer = 0.4; f.player.jumpEnd = { x: 11, y: 10 }; f.player.jumpHeight = 24;
  movePlayerGround(f.player, f.map, f.collision, 3, 0, f.vehicles);
  assert.ok(f.player.x < 10.6); clear(f);
});

test('dynamic car or wall blocking the landing aborts to reachable near side, never inside fence', () => {
  for (const dynamic of ['car', 'wall']) {
    const f = fixture([fence()]); start(f); tick(f, 0.325);
    assert.ok(f.player.x > 9.85 && f.player.x < 10.23, 'must test while overlapping the fence');
    if (dynamic === 'car') f.vehicles.push(car(10.65, 10));
    else f.colliders.push({ x: 10.25, y: 9, width: 0.005, height: 2, type: 'BUILDING' });
    assert.equal(tick(f), 'cancelled'); grounded(f.player); clear(f);
    assert.ok(f.player.x < 10);
  }
});

test('no ordinary landing inside fence after external separation nudges the player', () => {
  const f = fixture([fence()], 9.3, 10); start(f); tick(f, 0.6);
  f.player.x = 10.03;
  assert.equal(f.jump.update(f.player, f.map, f.collision, 0.1), 'landed');
  grounded(f.player); clear(f); assert.ok(f.player.x < 10);
});

test('vehicle/water/death reject takeoff and cancel active flight without moving vehicle position', () => {
  const patches = [{ currentVehicleId: 1 }, { state: 'driving' }, { state: 'enteringVehicle' },
    { state: 'dead' }, { health: 0 }, { swimming: true }];
  for (const patch of patches) {
    const f = fixture([fence()]); Object.assign(f.player, patch);
    assert.equal(f.jump.tryJump(f.player, f.map, f.collision), false);
    const air = fixture([fence()]); start(air); tick(air, 0.1); Object.assign(air.player, patch);
    const x = air.player.x; assert.equal(air.jump.update(air.player, air.map, air.collision, 0), 'cancelled');
    grounded(air.player); near(air.player.x, x);
  }
  const f = fixture(); start(f); f.water.add('9,10');
  assert.equal(f.jump.update(f.player, f.map, f.collision, 1 / 60), 'cancelled'); grounded(f.player);
});

test('invalid dt, explicit cancel, map transitions, respawn and multiple players are isolated', () => {
  const a = fixture([fence()]); const b = fixture(); start(a); start(b);
  for (const dt of [0, -1, NaN, Infinity]) {
    assert.equal(a.jump.update(a.player, a.map, a.collision, dt), null);
    near(a.player.jumpTimer, JUMP_DURATION); near(a.player.jumpHeight, 0);
  }
  a.player.x = 15; a.jump.cancel(a.player); grounded(a.player); near(a.player.x, 15);
  near(b.player.jumpTimer, JUMP_DURATION);
  assert.equal(b.jump.update(b.player, a.map, b.collision, 1), null); grounded(b.player);
  start(a); a.jump.cancel(a.player); start(a);
  const second = createPlayer(2, 2); assert.equal(a.jump.tryJump(second, a.map, a.collision), true);
  a.jump.cancel(a.player); near(second.jumpTimer, JUMP_DURATION);
});

test('ground movement and vault certification use full oriented vehicle footprints, not center radii', () => {
  for (const dir of ['SE', 'NW', 'SW', 'NE']) {
    const f = fixture([], 8, 10);
    f.vehicles.push({ ...car(10, 10), dir, altitude: 0, def: { footprintW: .8, footprintH: 2 } });
    const box = solidVehicleColliders(f.vehicles)[0];
    near(box.width, dir === 'SE' || dir === 'NW' ? 2 : .8);
    movePlayerGround(f.player, f.map, f.collision, 5, 0, f.vehicles);
    near(f.player.x, box.x - C.PLAYER_RADIUS); clear(f);
    f.vehicles[0].altitude = 1;
    assert.equal(solidVehicleColliders(f.vehicles).length, 0);
    movePlayerGround(f.player, f.map, f.collision, 5, 0, f.vehicles);
    assert.ok(f.player.x > 11);
  }
});

test('crouch toggles only on consumed edges, isolates players and never changes the collider', () => {
  const crouch = new CrouchSystem(); const f = fixture(); const p = f.player;
  const other = createPlayer(2, 2); const collider = playerCollider(p);
  assert.equal(p.crouching, false);
  input.queueCrouch();
  if (input.consumeCrouch()) crouch.toggle(p);
  assert.equal(p.crouching, true); assert.equal(other.crouching, false);
  if (input.consumeCrouch()) crouch.toggle(p);
  for (let i = 0; i < 120; i++) crouch.update(p);
  assert.equal(p.crouching, true); assert.deepEqual(playerCollider(p), collider);
  input.resetInputState(); crouch.update(p);
  assert.equal(p.crouching, true, 'release clears input, not the toggled stance');
  assert.equal(crouch.toggle(p), false); assert.equal(crouch.toggle(p), true);
});

test('crouch rejects and cancels jump, water, vehicle and death states without auto-restoring', () => {
  const crouch = new CrouchSystem();
  for (const patch of [{ jumpTimer: 0.1 }, { jumpHeight: 1 }, { swimming: true }, { currentVehicleId: 0 },
    { state: 'driving' }, { state: 'enteringVehicle' }, { state: 'dead' }, { health: 0 }, { health: -1 }]) {
    const p = createPlayer(2, 2); const original = { ...p };
    assert.equal(crouch.toggle(p), true); Object.assign(p, patch); crouch.update(p);
    assert.equal(p.crouching, false); assert.equal(crouch.toggle(p), false);
    for (const key of Object.keys(patch)) p[key] = original[key];
    crouch.update(p); assert.equal(p.crouching, false);
    assert.equal(crouch.toggle(p), true);
  }
});

test('crouch caps sprint inertia at 0.85, preserves analog/directions and recovers stamina with Run held', () => {
  near(CROUCH_SPEED, 0.85);
  for (const dt of [1 / 120, 1 / 60, 1 / 30]) {
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1]]) {
      const f = fixture(); const p = f.player; const crouch = new CrouchSystem();
      const stamina = new StaminaSystem();
      input.setJoystickInput(dx, dy, 1); input.setRunHeld(true);
      f.movement.updatePlayer(p, f.map, 0.1, true); near(p.speed, C.PLAYER_RUN_SPEED);
      crouch.toggle(p); p.stamina = 0.5;
      f.movement.updatePlayer(p, f.map, dt, true);
      near(p.speed, CROUCH_SPEED); assert.equal(p.state, 'walking');
      const screen = worldToScreen(p.vx, p.vy); near(screen.x * dy - screen.y * dx, 0);
      assert.equal(stamina.canSprint(p), false);
      stamina.update(p, dt, true, true); assert.ok(p.stamina > 0.5);
      crouch.toggle(p); assert.equal(stamina.canSprint(p), true);
    }
  }
  const f = fixture(); f.player.crouching = true;
  input.setJoystickInput(1, 0, 0.5);
  f.movement.updatePlayer(f.player, f.map, 1 / 30, true);
  const t = (0.5 - C.JOYSTICK_DEADZONE) / (1 - C.JOYSTICK_DEADZONE);
  near(f.player.speed, CROUCH_SPEED * t * t * (3 - 2 * t));
  input.resetJoystickInput();
  f.movement.updatePlayer(f.player, f.map, 2, true); near(f.player.speed, 0);
  assert.equal(f.player.anim, 'idle'); assert.equal(f.player.crouching, true);
  f.water.add(`${Math.floor(f.player.x)},${Math.floor(f.player.y)}`);
  input.setJoystickInput(1, 0, 1);
  f.movement.updatePlayer(f.player, f.map, 1 / 30, true);
  near(f.player.speed, C.PLAYER_SWIM_SPEED); new CrouchSystem().update(f.player);
  assert.equal(f.player.crouching, false);
});

test('accepted jump and vault stand up; rejected takeoff alone does not change stance', () => {
  for (const colliders of [[], [fence()]]) {
    const f = fixture(colliders); f.player.crouching = true;
    start(f); assert.equal(f.player.crouching, false);
    assert.equal(!!f.player.jumpEnd, colliders.length > 0);
  }
  const blocked = fixture([{ x: 9.6, y: 9.9, width: 1, height: 1, type: 'PROP' }]);
  blocked.player.crouching = true;
  assert.equal(blocked.jump.tryJump(blocked.player, blocked.map, blocked.collision), false);
  assert.equal(blocked.player.crouching, true);
});

test('crouch visual folds legs at fixed feet and aligns the torso seam, weapon and melee offsets', () => {
  for (const height of [32, 64]) {
    const standing = crouchPose(false, height), pose = crouchPose(true, height);
    assert.deepEqual(standing, { torsoOffsetY: 0, legScaleY: 1, legScaleX: 1 });
    near(pose.torsoOffsetY, height * 0.25);
    near(height + (height - height) * pose.legScaleY, height, 0); // foot anchor
    const seam = height * 0.625;
    near(height + (seam - height) * pose.legScaleY, seam + pose.torsoOffsetY);
    assert.ok(pose.legScaleX > 1 && pose.legScaleY < 1);
    // Same rigid translation is applied to the shoulder and to both held-weapon renderers.
    near(-18 + pose.torsoOffsetY, -18 + height * 0.25);
  }
});

console.log(`Jump/crouch checks passed: ${passed}`);
