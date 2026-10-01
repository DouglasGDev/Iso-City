// Run: node tools/check/check-input.cjs. In-memory TS compilation; no generated files or native runtime.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');
const cache = new Map();
const effects = [];
const platform = { OS: 'web' };
const stubs = {
  react: { useEffect: (effect) => effects.push(effect), useRef: (current) => ({ current }),
    useState: (value) => [value, () => {}] },
  'react-native': { Platform: platform },
  [path.join(root, 'src/game/GameState.ts')]: { getGame() { throw Error('Unexpected GameState dependency'); } },
  [path.join(root, 'src/stores/useGameStore.ts')]: {},
  [path.join(root, 'src/audio/SoundManager.ts')]: {},
};
function load(filename) {
  if (stubs[filename]) return stubs[filename];
  if (cache.has(filename)) return cache.get(filename).exports;
  const source = fs.readFileSync(filename, 'utf8');
  const result = ts.transpileModule(source, {
    fileName: filename, reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS,
      strict: true, esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX },
  });
  assert.deepEqual(result.diagnostics, []);
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.paths = Module._nodeModulePaths(path.dirname(filename));
  mod.require = (name) => {
    if (!name.startsWith('.')) return stubs[name] ?? require(name);
    const resolved = path.resolve(path.dirname(filename), name);
    return load(fs.existsSync(resolved + '.ts') ? resolved + '.ts' : resolved + '.tsx');
  };
  cache.set(filename, mod);
  mod._compile(result.outputText, filename);
  return mod.exports;
}
const source = (relative) => load(path.join(root, 'src', relative));
const input = source('game/InputState.ts');
const { inputState: state, HardwareInput, mouseWorldAim } = input;
const { MovementSystem } = source('systems/MovementSystem.ts');
const { StaminaSystem } = source('systems/StaminaSystem.ts');
const { createPlayer } = source('entities/Player.ts');
const { GAME_CONFIG: C } = source('game/GameConfig.ts');
const { worldToScreen, angleToWorldDir } = source('world/IsoUtils.ts');
const { attachHardwareInput, useHardwareInput } = source('ui/useHardwareInput.ts');
let passed = 0;
function near(actual, expected, tolerance = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
}
function test(name, fn) {
  input.resetInputState();
  fn();
  passed++;
  console.log('OK ' + name);
}
function neutral() {
  for (const [key, value] of Object.entries(state)) {
    // The cursor world point has no numeric zero: NaN is its resting value.
    if (key === 'aimPointX' || key === 'aimPointY') assert.ok(Number.isNaN(value), key);
    else assert.equal(value, typeof value === 'boolean' ? false : 0, key);
  }
}
function pad(index = 0) {
  return { index, mapping: 'standard', connected: true, axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, () => ({ value: 0, pressed: false })) };
}
function button(p, index, value) {
  p.buttons[index] = { value, pressed: value > 0.5 };
}
function fixture() {
  const player = createPlayer(100, 100);
  // Chão plano: o stub também responde o contrato de relevo que o movimento consulta.
  const map = { worldW: 1000, worldH: 1000, isWaterWorld: () => false, queryNearby: () => [],
    canClimb: () => true, canDriveOver: () => true, slopeAlong: () => 0,
    heightAt: () => 0, heightSmoothAt: () => 0 };
  const movement = new MovementSystem({ resolveCircle() {} });
  return { player, map, movement };
}

test('input normalization, invalid values, independent aim and complete reset', () => {
  input.setJoystickInput(3, 4, 5);
  near(state.dx, 0.6); near(state.dy, 0.8); near(state.magnitude, 1);
  input.setAimInput(-3, 4);
  near(state.aimX, -0.6); near(state.aimY, 0.8);
  near(state.dx, 0.6);
  for (const args of [[NaN, 1, 1], [1, Infinity, 1], [0, 0, 1], [1, 1, NaN], [1, 1, -1]]) {
    input.setJoystickInput(...args); assert.equal(state.magnitude, 0);
  }
  input.setAimInput(NaN, 1); assert.equal(state.aimActive, false);
  input.queueInteract(); assert.equal(input.consumeInteract(), true); assert.equal(input.consumeInteract(), false);
  input.queueJump(); assert.equal(input.consumeJump(), true); assert.equal(input.consumeJump(), false);
  input.setAttackHeld(true); input.setRunHeld(true); input.queueEnter(); input.queueReload(); input.queueWeapon(); input.queueJump(); input.queueCrouch();
  input.setVehicleControl('accel', true); input.setHeliControl('up', true); input.setHeliControl('down', true);
  input.setAimInput(1, 0);
  input.resetVehicleArrows(); assert.equal(state.heliUp, false); assert.equal(state.heliDown, false);
  assert.equal(state.vehicleAccel, false);
  input.resetInputState(); neutral();
});

test('full mobile joystick walks; Run is explicit and runAllowed=false is authoritative', () => {
  for (const [held, allowed, speed] of [[false, undefined, C.PLAYER_WALK_SPEED],
    [true, undefined, C.PLAYER_RUN_SPEED], [true, false, C.PLAYER_WALK_SPEED],
    [false, false, C.PLAYER_WALK_SPEED], [false, true, C.PLAYER_RUN_SPEED]]) {
    const { player, map, movement } = fixture();
    input.setJoystickInput(1, 0, 1); input.setRunHeld(held);
    movement.updatePlayer(player, map, 1 / 30, allowed);
    near(player.speed, speed);
  }
});

test('golden 2:1 movement projection, constant speed and consistent four-way direction', () => {
  for (const [sx, sy] of [[64, 32], [-64, 32], [64, -32], [-64, -32],
    [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1], [0.2, 1], [1, 0.2]]) {
    const { player, map, movement } = fixture();
    input.setJoystickInput(sx, sy, 1);
    movement.updatePlayer(player, map, 1 / 30, false);
    const wx = sx / 128 + sy / 64;
    const wy = sy / 64 - sx / 128;
    const len = Math.hypot(wx, wy);
    near(player.vx, wx / len * C.PLAYER_WALK_SPEED);
    near(player.vy, wy / len * C.PLAYER_WALK_SPEED);
    const projected = worldToScreen(player.vx, player.vy);
    near(projected.x * sy - projected.y * sx, 0, 1e-8);
    assert.equal(player.walkDir, angleToWorldDir(Math.atan2(wy, wx)));
  }
});

test('partial analog input, deadzone, friction, swimming and blocked player states', () => {
  const { player, map, movement } = fixture();
  input.setJoystickInput(1, 1, 0.5);
  movement.updatePlayer(player, map, 1 / 30, false);
  const t = (0.5 - C.JOYSTICK_DEADZONE) / (1 - C.JOYSTICK_DEADZONE);
  near(player.speed, C.PLAYER_WALK_SPEED * t * t * (3 - 2 * t));
  input.setJoystickInput(1, 0, C.JOYSTICK_DEADZONE);
  movement.updatePlayer(player, map, 1 / 30, true);
  assert.ok(player.speed < C.PLAYER_WALK_SPEED * t * t * (3 - 2 * t));
  map.isWaterWorld = () => true;
  input.setJoystickInput(1, 0, 1);
  movement.updatePlayer(player, map, 1 / 30, true);
  near(player.speed, C.PLAYER_SWIM_SPEED); assert.equal(player.anim, 'swim');
  // A água do tsunami não é tile de mar: é o chão alagado que o HazardSystem aponta.
  map.isWaterWorld = () => false;
  movement.updatePlayer(player, map, 1 / 30, true, true);
  near(player.speed, C.PLAYER_SWIM_SPEED);
  assert.equal(player.anim, 'swim');
  assert.equal(player.swimming, true, 'a corrente não pôs o jogador a nadar');
  movement.updatePlayer(player, map, 1 / 30, true, false);
  assert.equal(player.swimming, false, 'fora da água do tsunami continua-se andando');
  for (const state of ['driving', 'enteringVehicle', 'dead']) {
    player.state = state;
    movement.updatePlayer(player, map, 1 / 30, true);
    near(player.vx, 0); near(player.vy, 0);
  }
});

test('aim never rotates movement/facing; helicopter uses the same inverse projection', () => {
  const a = fixture(); const b = fixture();
  input.setJoystickInput(1, 1, 1);
  a.movement.updatePlayer(a.player, a.map, 0.1, false);
  input.setAimInput(-1, -1);
  b.movement.updatePlayer(b.player, b.map, 0.1, false);
  for (const key of ['vx', 'vy', 'facingAngle', 'direction', 'walkDir']) assert.equal(a.player[key], b.player[key]);
  // A cota é o estado de voo; sem ela o aparelho não tem para onde subir.
  const heli = { x: 100, y: 100, speed: 0, dir: 'SE', altitude: 0, elevation: 0, def: { type: 'helicopter' } };
  a.movement.updateVehicle(heli, a.map, 0.1);
  near((heli.x - 100) / (heli.y - 100), 3);
});

test('stamina hysteresis matches actual movement-before-update call order while Run stays held', () => {
  const { player, map, movement } = fixture();
  const stamina = new StaminaSystem();
  player.stamina = 0;
  input.setJoystickInput(1, 0, 1); input.setRunHeld(true);
  let previous = false; let lastTransition = -1000; let transitions = 0;
  for (let frame = 0; frame < 1500; frame++) {
    const can = stamina.canSprint(player);
    assert.equal(stamina.canSprint(player), can);
    if (can !== previous) {
      assert.ok(frame - lastTransition >= 60, 'must not oscillate near zero');
      if (can) assert.ok(player.stamina >= 0.25);
      transitions++; lastTransition = frame; previous = can;
    }
    const before = player.stamina;
    movement.updatePlayer(player, map, 1 / 60, state.runHeld && can);
    stamina.update(player, 1 / 60, state.runHeld, true);
    assert.ok(can ? player.stamina < before : player.stamina > before);
    assert.ok(player.stamina >= 0 && player.stamina <= 1);
  }
  assert.ok(transitions >= 8);
});

test('stamina recovers walking/idle/swimming, ignores invalid dt, isolates players and respawn', () => {
  const stamina = new StaminaSystem();
  const p = createPlayer(1, 1); const other = createPlayer(1, 1);
  p.stamina = 0; assert.equal(stamina.canSprint(p), false);
  assert.equal(stamina.canSprint(other), true);
  stamina.update(p, 0.1, true, true); near(p.stamina, C.STAMINA_REGEN * 0.55 * 0.1);
  p.stamina = 0.5; p.swimming = true;
  stamina.update(p, 0.1, true, true); near(p.stamina, 0.5 + C.STAMINA_REGEN * 0.55 * 0.1);
  p.swimming = false; p.stamina = 0.5;
  stamina.update(p, 0.1, true, false); near(p.stamina, 0.5 + C.STAMINA_REGEN * 0.1);
  const before = p.stamina;
  for (const dt of [0, -1, NaN, Infinity]) stamina.update(p, dt, true, true);
  near(p.stamina, before);
  p.stamina = 0; stamina.canSprint(p); p.stamina = 1;
  assert.equal(stamina.canSprint(p), true);
  stamina.update(p, 100, true, true); near(p.stamina, 0);
  stamina.update(p, 100, true, true); near(p.stamina, 1);
});

test('keyboard diagonals, opposing keys, arrows, both Shift keys and vehicle controls', () => {
  const modes = []; const h = new HardwareInput((mode) => modes.push(mode));
  h.keyDown('KeyW'); h.keyDown('KeyD');
  near(state.dx, Math.SQRT1_2); near(state.dy, -Math.SQRT1_2); near(state.magnitude, 1);
  h.keyDown('KeyA'); near(state.dx, 0); near(state.dy, -1);
  h.keyDown('KeyS'); near(state.magnitude, 0);
  h.keyDown('ShiftLeft'); h.keyDown('ShiftRight'); h.keyUp('ShiftLeft'); assert.equal(state.runHeld, true);
  h.keyUp('ShiftRight'); assert.equal(state.runHeld, false);
  for (const key of ['KeyW', 'KeyD', 'KeyA', 'KeyS']) h.keyUp(key);
  h.keyDown('ArrowUp'); assert.equal(state.vehicleAccel, true);
  h.keyDown('ArrowLeft'); assert.equal(state.vehicleLeft, true);
  h.keyUp('ArrowUp'); assert.equal(state.vehicleAccel, false);
  h.keyDown('ArrowDown'); assert.equal(state.vehicleBrake, true);
  h.keyUp('ArrowLeft'); h.keyDown('ArrowRight'); assert.equal(state.vehicleRight, true);
  assert.deepEqual(modes, ['keyboard']);
});

test('keyboard jump edges, fast taps, repeats and merged mouse/both Ctrl fire holds', () => {
  const h = new HardwareInput();
  for (const [key, consume, expected = true] of [['Space', input.consumeJump], ['KeyE', input.consumeEnter], ['KeyF', input.consumeInteract],
    ['KeyQ', input.consumeWeapon, -1], ['KeyZ', input.consumeWeapon, 1], ['KeyC', input.consumeCrouch], ['KeyR', input.consumeReload]]) {
    const empty = consume === input.consumeWeapon ? 0 : false;
    h.keyDown(key); assert.equal(consume(), expected);
    h.keyDown(key, true); h.keyDown(key); assert.equal(consume(), empty);
    h.keyUp(key); h.keyDown(key); h.keyUp(key); assert.equal(consume(), expected);
  }
  assert.equal(input.consumeAttack(), false); assert.equal(state.attackHeld, false);
  h.keyDown('ControlLeft'); assert.equal(input.consumeAttack(), true);
  h.keyDown('ControlRight'); h.keyUp('ControlLeft'); assert.equal(state.attackHeld, true);
  h.mouseButton(true); h.keyUp('ControlRight'); assert.equal(state.attackHeld, true);
  assert.equal(input.consumeAttack(), false);
  input.resetActionInput(); h.refreshKeyboard(); assert.equal(input.consumeAttack(), false);
  h.mouseButton(false); h.keyDown('ControlLeft'); h.keyUp('ControlLeft'); assert.equal(input.consumeAttack(), true);
  h.setDriving(true); h.mouseButton(true); h.keyDown('Space');
  assert.equal(state.attackHeld, false); assert.equal(input.consumeJump(), false);
  // No ar o Espaço e o Ctrl viram a cabra: mexem na cota sem roubar o manche do WASD.
  assert.equal(state.heliUp, true); assert.equal(state.heliDown, false);
  h.keyDown('ControlLeft'); assert.equal(state.heliDown, true);
  h.keyUp('Space'); h.keyUp('ControlLeft'); assert.equal(state.heliUp, false);
  h.release(); neutral();
});

test('mouse right button is manual aim and left is fire; release/cancel/pause drop the aim', () => {
  const h = new HardwareInput();
  h.mouseMove(0.6, 0.8, true, 13, 22);
  assert.equal(state.aimActive, false); // cursor alone never aims
  assert.ok(Number.isNaN(state.aimPointX) && Number.isNaN(state.aimPointY), 'no reticle point without the aim held');
  h.mouseButton(true, 2); assert.equal(state.aimActive, true);
  near(state.aimX, 0.6); near(state.aimY, 0.8);
  near(state.aimPointX, 13); near(state.aimPointY, 22); // the reticle sits on the cursor
  h.mouseButton(true, 0); assert.equal(input.consumeAttack(), true); assert.equal(state.aimActive, true);
  h.mouseButton(false, 0); h.mouseButton(false, 2);
  assert.equal(state.aimActive, false);
  assert.ok(Number.isNaN(state.aimPointX) && Number.isNaN(state.aimPointY), 'dropping the aim drops the point');
  h.mouseMove(-1, 0); h.mouseButton(true, 2);
  near(state.aimX, -1); near(state.aimY, 0); assert.ok(Number.isNaN(state.aimPointX), 'stick aim has no cursor point');
  h.setSuspended(true); assert.equal(state.aimActive, false); h.setSuspended(false);
  h.mouseButton(true, 2); h.cancelMouse(); assert.equal(state.aimActive, false);
  neutral();
});

test('touch MIRA toggle aims along the facing, hardware aim wins and reset clears it', () => {
  assert.equal(input.toggleAimTouch(), true);
  const a = input.effectiveAim(Math.PI / 3);
  assert.equal(a.active, true); near(a.x, Math.cos(Math.PI / 3)); near(a.y, Math.sin(Math.PI / 3));
  input.setAimInput(0, -1); assert.equal(input.effectiveAim(0).y, -1); // trigger aim wins
  input.setAimInput(0, 0);
  assert.equal(input.toggleAimTouch(), false);
  assert.equal(input.effectiveAim(0).active, false);
  input.toggleAimTouch(); input.resetActionInput();
  assert.equal(state.aimTouchHeld, false);
  assert.equal(input.effectiveAim(0).active, false);
});

test('first hardware taps survive ControlTouch teardown, but consumed or suspended edges never replay', () => {
  const h = new HardwareInput();
  for (const [key, consume, expected = true] of [['Space', input.consumeJump], ['ControlLeft', input.consumeAttack], ['KeyE', input.consumeEnter],
    ['KeyF', input.consumeInteract], ['KeyQ', input.consumeWeapon, -1], ['KeyZ', input.consumeWeapon, 1],
    ['KeyC', input.consumeCrouch], ['KeyR', input.consumeReload]]) {
    h.keyDown(key); h.keyUp(key);
    input.resetActionInput(); input.resetJoystickInput(); input.resetVehicleArrows(); input.setRunHeld(false);
    h.refreshKeyboard(); assert.equal(consume(), expected);
    h.refreshKeyboard(); assert.equal(consume(), consume === input.consumeWeapon ? 0 : false);
  }
  const p = pad(); h.pollGamepads([p]); button(p, 7, 1); button(p, 2, 1); button(p, 1, 1); h.pollGamepads([p]);
  input.resetActionInput(); h.pollGamepads([p]);
  assert.equal(input.consumeAttack(), true); assert.equal(input.consumeReload(), true); assert.equal(input.consumeJump(), true);
  h.pollGamepads([p]); assert.equal(input.consumeAttack(), false); assert.equal(input.consumeJump(), false);
  h.keyDown('Space'); h.setSuspended(true); h.setSuspended(false); h.refreshKeyboard(); neutral();
});

test('mouse aim golden world vector with offset/scaled viewport, zoom and shake', () => {
  const rect = { left: 37, top: 29, width: 1600, height: 800 };
  const game = { camera: { x: 10, y: 20, zoom: 2 }, player: { x: 11, y: 21 },
    viewW: 800, viewH: 400, shakeX: 7, shakeY: -3 };
  const delta = worldToScreen(3, 2); // target (13,22) minus camera (10,20)
  const aim = mouseWorldAim(37 + (400 + 7 + delta.x * 2) * 2,
    29 + (200 - 3 + delta.y * 2) * 2, rect, game);
  near(aim.x, 2 / Math.sqrt(5)); near(aim.y, 1 / Math.sqrt(5));
  near(aim.px, 13); near(aim.py, 22); // the ground point the cursor is actually over
  assert.deepEqual(mouseWorldAim(0, 0, { ...rect, width: 0 }, game), { x: 0, y: 0, px: NaN, py: NaN });
  assert.deepEqual(mouseWorldAim(NaN, 0, rect, game), { x: 0, y: 0, px: NaN, py: NaN });
});

test('standard pad LS, RS world aim gated by LT, RT, brake, A, X, Y and both bumpers', () => {
  const h = new HardwareInput(); const p = pad(); h.pollGamepads([null, p]);
  p.axes = [1, 1, 1, 0]; button(p, 0, 1); button(p, 6, 0.6); button(p, 7, 0.7);
  h.pollGamepads([null, p]);
  assert.equal(h.mode, 'gamepad'); near(state.magnitude, 1); near(state.dx, Math.SQRT1_2);
  near(state.aimX, Math.SQRT1_2); near(state.aimY, -Math.SQRT1_2);
  assert.equal(state.runHeld, true); assert.equal(state.vehicleAccel, true); assert.equal(state.vehicleBrake, true);
  assert.equal(input.consumeAttack(), true); h.pollGamepads([p]); assert.equal(input.consumeAttack(), false);
  input.resetActionInput(); h.pollGamepads([p]); assert.equal(input.consumeAttack(), false);
  // RS alone is not aiming: LT must stay pressed for the manual aim mode.
  button(p, 6, 0); h.pollGamepads([p]); assert.equal(state.aimActive, false);
  button(p, 6, 0.6); h.pollGamepads([p]); assert.equal(state.aimActive, true);
  // LT alone still aims: with a neutral right stick the shot follows the facing.
  p.axes = [0, 0, 0, 0]; h.pollGamepads([p]);
  assert.equal(state.aimActive, false); assert.equal(state.aimTriggerHeld, true);
  assert.equal(input.effectiveAim(1.2).active, true, 'LT must bypass the auto-aim cone');
  near(input.effectiveAim(1.2).x, Math.cos(1.2)); near(input.effectiveAim(1.2).y, Math.sin(1.2));
  button(p, 6, 0); h.pollGamepads([p]);
  assert.equal(state.aimTriggerHeld, false); assert.equal(input.effectiveAim(1.2).active, false);
  button(p, 6, 0.6); h.pollGamepads([p]);
  button(p, 6, 0); h.pollGamepads([p]);
  for (const [index, consume, expected = true] of [[1, input.consumeJump], [2, input.consumeReload], [3, input.consumeEnter],
    [4, input.consumeWeapon, -1], [5, input.consumeWeapon, 1], [10, input.consumeCrouch]]) {
    button(p, index, 1); h.pollGamepads([p]); assert.equal(consume(), expected);
    h.pollGamepads([p]); assert.equal(consume(), consume === input.consumeWeapon ? 0 : false);
    button(p, index, 0); h.pollGamepads([p]);
  }
  h.pollGamepads([pad()]); assert.equal(state.aimActive, false); assert.equal(state.attackHeld, false);
});

test('pad deadzones, nonstandard/held-at-connect pads and malformed axes do not steal touch', () => {
  const h = new HardwareInput(); const p = pad();
  input.setJoystickInput(1, 0, 0.8); input.setRunHeld(true);
  p.axes = [0.1, -0.1, NaN, Infinity]; h.pollGamepads([p]);
  near(state.magnitude, 0.8); assert.equal(h.mode, 'touch');
  const unknown = pad(2); unknown.mapping = ''; unknown.axes[0] = 1;
  h.pollGamepads([p, unknown]); assert.equal(h.mode, 'touch');
  const held = pad(3); button(held, 7, 1); h.pollGamepads([p, held]); assert.equal(h.mode, 'touch');
  button(held, 7, 0); h.pollGamepads([p, held]); button(held, 7, 1); h.pollGamepads([p, held]);
  assert.equal(h.mode, 'gamepad'); assert.equal(input.consumeAttack(), true);
});

test('touch reactivation preserves second finger and requires gamepad neutral before taking over', () => {
  const h = new HardwareInput(); const p = pad(); h.pollGamepads([p]);
  p.axes[0] = 1; h.pollGamepads([p]); h.touch();
  input.setJoystickInput(0, 1, 0.75); input.setRunHeld(true);
  h.touch(); h.pollGamepads([p]); near(state.dy, 0.75); assert.equal(state.runHeld, true);
  p.axes[0] = 0; h.pollGamepads([p]); near(state.dy, 0.75);
  p.axes[0] = -1; h.pollGamepads([p]); near(state.dx, -1); assert.equal(h.mode, 'gamepad');
  h.keyDown('KeyW'); h.pollGamepads([p]); assert.equal(h.mode, 'keyboard'); near(state.dy, -1);
});

test('pause/blur clear every held and queued action; held keys and triggers cannot replay', () => {
  const h = new HardwareInput();
  for (const key of ['KeyW', 'ShiftLeft', 'Space', 'ControlLeft', 'KeyQ', 'KeyZ', 'KeyC', 'KeyR', 'KeyE', 'KeyF']) h.keyDown(key);
  h.setSuspended(true); neutral(); h.setSuspended(false);
  h.keyDown('Space', true); h.refreshKeyboard(); neutral();
  h.keyUp('Space'); h.keyDown('Space'); assert.equal(input.consumeJump(), true);
  h.setFocused(false); neutral(); h.keyDown('KeyW'); neutral(); h.setFocused(true);
  const p = pad(); h.pollGamepads([p]); button(p, 7, 1); h.pollGamepads([p]);
  h.setSuspended(true); neutral(); h.pollGamepads([p]); h.setSuspended(false); h.pollGamepads([p]); neutral();
  button(p, 7, 0); h.pollGamepads([p]); button(p, 7, 1); h.pollGamepads([p]);
  assert.equal(input.consumeAttack(), true);
});

test('map/pause keyboard and pad menu edges work while suspended, never repeat or leak shots', () => {
  const menus = []; const h = new HardwareInput(() => {}, (action) => menus.push(action));
  h.setSuspended(true);
  h.keyDown('KeyM'); h.keyDown('KeyM', true); h.keyDown('Escape'); h.keyDown('Escape', true);
  assert.deepEqual(menus, ['map', 'pause']); neutral();
  const p = pad(); h.pollGamepads([p]); button(p, 8, 1); button(p, 7, 1);
  h.pollGamepads([p]); h.pollGamepads([p]); assert.deepEqual(menus, ['map', 'pause', 'map']); neutral();
  button(p, 8, 0); h.pollGamepads([p]); button(p, 9, 1); h.pollGamepads([p]); h.pollGamepads([p]);
  assert.deepEqual(menus, ['map', 'pause', 'map', 'pause']); neutral();
});

test('disconnect clears selected pad only, supports hot-plug and multiple pad arbitration', () => {
  const h = new HardwareInput(); const a = pad(); const b = pad(1); h.pollGamepads([a, b]);
  button(a, 7, 1); h.pollGamepads([a, b]); input.consumeAttack();
  h.pollGamepads([a, b]); button(b, 7, 1); h.pollGamepads([a, b]);
  assert.equal(input.consumeAttack(), true); // new device, not inherited held state
  h.pollGamepads([a, b]); assert.equal(input.consumeAttack(), false);
  h.disconnect(1); neutral(); assert.equal(h.mode, 'touch');
  input.setJoystickInput(0, 1, 1); h.disconnect(0); near(state.dy, 1);
  h.pollGamepads([]); near(state.dy, 1);
  button(a, 7, 0); h.pollGamepads([a]); button(a, 7, 1); h.pollGamepads([a]);
  h.pollGamepads([]); neutral();
});

class Events {
  listeners = new Map();
  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(handler);
  }
  removeEventListener(type, handler) { this.listeners.get(type)?.delete(handler); }
  emit(type, patch = {}) {
    const event = { target: null, defaultPrevented: false, button: 0, buttons: 0, pointerType: 'mouse',
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...patch };
    for (const handler of this.listeners.get(type) ?? []) handler(event);
    return event;
  }
  count() { return [...this.listeners.values()].reduce((n, s) => n + s.size, 0); }
}
function box(left, top, width, height, kind = 'world') {
  return { kind, parentElement: null,
    closest(selector) {
      if (kind === 'editor' && selector.includes('input')) return this;
      if (kind === 'button' && selector.includes('button')) return this;
      return null;
    },
    getBoundingClientRect: () => ({ left, top, width, height, right: left + width, bottom: top + height }),
  };
}
function browser(navigator = {}, touchScreen = false) {
  const win = new Events(); const doc = new Events();
  const canvas = box(20, 30, 800, 400); const target = box(20, 30, 800, 400);
  const uiBox = box(20, 30, 200, 100, 'button');
  const mini = box(30, 140, 110, 110); mini.parentElement = box(30, 140, 110, 130);
  const game = { camera: { x: 10, y: 20, zoom: 1.5 }, player: { x: 10, y: 20 },
    viewW: 800, viewH: 400, shakeX: 0, shakeY: 0 };
  let suspended = false; let driving = false; let pads = []; let next = 0; let pointTarget = target;
  const frames = new Map(); const menus = []; const modes = [];
  win.navigator = { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', platform: 'Win32', maxTouchPoints: 0,
    getGamepads: () => pads, ...navigator };
  win.matchMedia = () => ({ matches: touchScreen });
  win.requestAnimationFrame = (fn) => { frames.set(++next, fn); return next; };
  win.cancelAnimationFrame = (id) => frames.delete(id);
  doc.hidden = false; doc.focused = true; doc.activeElement = target; doc.hasFocus = () => doc.focused;
  doc.elementFromPoint = () => pointTarget;
  doc.querySelectorAll = (selector) => selector === 'canvas' ? [mini, canvas] : [uiBox];
  doc.querySelector = () => null;
  const binding = attachHardwareInput(win, doc, {
    isSuspended: () => suspended, isDriving: () => driving, getCamera: () => game,
    onMode: (mode) => modes.push(mode), onMenu: (action) => { menus.push(action); suspended = !suspended; },
  });
  return { win, doc, game, target, uiBox, binding, menus, modes, frames,
    step() { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach((fn) => fn()); },
    suspend(value) { suspended = value; binding.refresh(); },
    drive(value) { driving = value; binding.refresh(); },
    pads(value) { pads = value; }, pointAt(value) { pointTarget = value; },
  };
}

test('phones and tablets retain touch controls despite keyboard, mouse or gamepad events', () => {
  const devices = [
    { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8)' },
    { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' },
    { userAgent: 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)' },
    { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)', platform: 'MacIntel', maxTouchPoints: 5 },
    { userAgentData: { mobile: true } },
    {},
  ];
  for (let i = 0; i < devices.length; i++) {
    const b = browser(devices[i], i === devices.length - 1);
    const p = pad(); p.axes[0] = 1; button(p, 7, 1); b.pads([p]);
    input.setJoystickInput(1, 0, 0.5); input.setRunHeld(true);
    for (const code of ['KeyW', 'Space', 'ControlLeft', 'ControlRight', 'KeyQ', 'KeyZ', 'KeyC', 'KeyR', 'KeyM', 'Escape']) {
      assert.equal(b.win.emit('keydown', { code }).defaultPrevented, false);
      b.win.emit('keyup', { code });
    }
    b.win.emit('pointermove', { clientX: 700, clientY: 250, target: b.target });
    b.win.emit('pointerdown', { clientX: 700, clientY: 250, target: b.target });
    b.win.emit('pointerup', { target: b.target });
    b.win.emit('pointerdown', { pointerType: 'touch' }); b.step();
    near(state.dx, 0.5); assert.equal(state.runHeld, true);
    assert.equal(state.attackHeld, false); assert.equal(state.aimActive, false);
    assert.equal(input.consumeAttack(), false); assert.equal(input.consumeWeapon(), 0); assert.equal(input.consumeJump(), false);
    assert.equal(input.consumeCrouch(), false);
    assert.equal(input.consumeReload(), false); assert.deepEqual(b.menus, []); assert.deepEqual(b.modes, []);
    assert.equal(b.frames.size, 0, 'mobile must not poll hardware');
    b.win.emit('blur'); neutral();
    b.binding.dispose(); assert.equal(b.win.count(), 0); assert.equal(b.doc.count(), 0);
  }
});

test('desktop touchscreens and narrow windows still accept keyboard and gamepad', () => {
  const b = browser({ maxTouchPoints: 10, userAgentData: { mobile: false } });
  b.win.innerWidth = 390;
  b.win.emit('keydown', { code: 'KeyW' }); near(state.magnitude, 1);
  b.win.emit('keyup', { code: 'KeyW' });
  const p = pad(); b.pads([p]); b.step(); p.axes[0] = 1; b.step();
  assert.deepEqual(b.modes, ['keyboard', 'gamepad']);
  b.binding.dispose(); neutral();
});

test('browser keys prevent scrolling, exclude text/modifiers and can close pause from a button', () => {
  const b = browser();
  assert.equal(b.win.emit('keydown', { code: 'ArrowUp', target: b.target }).defaultPrevented, true);
  assert.equal(state.vehicleAccel, true);
  b.win.emit('keyup', { code: 'ArrowUp', target: b.uiBox }); near(state.magnitude, 0);
  for (const patch of [{ metaKey: true }, { altKey: true }, { isComposing: true },
    { target: box(0, 0, 100, 20, 'editor') }, { target: b.uiBox }]) {
    assert.equal(b.win.emit('keydown', { code: 'Space', ...patch }).defaultPrevented, false);
    assert.equal(input.consumeJump(), false); assert.equal(state.attackHeld, false);
  }
  b.win.emit('keydown', { code: 'Escape', target: b.uiBox }); b.step(); neutral();
  b.win.emit('keyup', { code: 'Escape' });
  b.win.emit('keydown', { code: 'Escape', target: b.uiBox });
  assert.deepEqual(b.menus, ['pause', 'pause']);
  b.binding.dispose();
});

test('browser mouse: left shoots, right holds manual aim; HUD clicks never shoot, HUD overlap keeps the aim', () => {
  const b = browser();
  for (const [clientX, clientY, target] of [[80, 80, b.target], [60, 160, b.target], [700, 250, b.uiBox], [900, 200, b.target]]) {
    b.win.emit('pointerdown', { clientX, clientY, buttons: 1, target }); assert.equal(state.attackHeld, false);
  }
  b.suspend(true); b.win.emit('pointerdown', { clientX: 700, clientY: 250, buttons: 1, target: b.target }); neutral();
  b.suspend(false);
  const down = b.win.emit('pointerdown', { clientX: 700, clientY: 250, buttons: 1, target: b.target });
  assert.equal(down.defaultPrevented, true); assert.equal(down.stopped, true);
  assert.equal(input.consumeAttack(), true); assert.equal(state.aimActive, false);
  assert.equal(b.win.emit('contextmenu', {}).defaultPrevented, true);
  b.win.emit('pointerup', { clientX: 700, clientY: 250, buttons: 0, target: b.target });
  // A faixa do topo é HUD, mas só as caixas de botão pertencem à interface: mirar no alto
  // da tela (acima do painel de vida/arma) tem que funcionar.
  b.win.emit('pointerdown', { clientX: 300, clientY: 45, button: 2, buttons: 2, target: b.target });
  assert.equal(state.aimActive, true, 'the HUD bar cannot cover the whole top row');
  b.win.emit('pointermove', { clientX: 300, clientY: 45, buttons: 3, target: b.target });
  assert.equal(input.consumeAttack(), true);
  b.win.emit('pointerup', { clientX: 300, clientY: 45, button: 2, buttons: 0, target: b.target });
  assert.equal(state.aimActive, false);
  // Right button enters manual aim; the cursor keeps tracking camera motion while held.
  b.win.emit('pointerdown', { clientX: 700, clientY: 250, button: 2, buttons: 2, target: b.target });
  assert.equal(state.aimActive, true); assert.equal(input.consumeAttack(), false);
  const oldAim = state.aimX; b.game.camera.x += 1; b.step(); assert.notEqual(state.aimX, oldAim);
  // Chrome reports the second button only as a pointermove carrying the new mask.
  b.win.emit('pointermove', { clientX: 700, clientY: 250, buttons: 3, target: b.target });
  assert.equal(input.consumeAttack(), true, 'left fires while the aim is held');
  assert.equal(state.aimActive, true);
  // Still aiming, so crossing the HUD must not cancel the aim nor swallow the next shot.
  b.win.emit('pointermove', { clientX: 80, clientY: 80, buttons: 3, target: b.target });
  assert.equal(state.aimActive, true, 'the HUD cannot steal a held aim');
  b.win.emit('pointermove', { clientX: 400, clientY: 300, buttons: 2, target: b.target });
  assert.equal(state.attackHeld, false); assert.equal(state.aimActive, true);
  b.win.emit('pointermove', { clientX: 400, clientY: 300, buttons: 0, target: b.target });
  assert.equal(state.aimActive, false);
  b.win.emit('pointerup', { buttons: 0, target: b.uiBox });
  b.binding.dispose();
});

test('browser pointer touch/pen never fires and ignores idle hardware after switching back', () => {
  const b = browser();
  b.win.emit('keydown', { code: 'KeyW' });
  b.win.emit('pointerdown', { pointerType: 'touch', clientX: 700, clientY: 250 });
  input.setJoystickInput(1, 0, 0.5); input.setRunHeld(true);
  b.win.emit('pointerdown', { pointerType: 'touch', clientX: 700, clientY: 250 });
  b.win.emit('pointermove', { pointerType: 'touch', clientX: 700, clientY: 250 }); b.step();
  near(state.dx, 0.5); assert.equal(state.runHeld, true); assert.equal(state.attackHeld, false);
  assert.deepEqual(b.modes, ['keyboard', 'touch']);
  b.binding.dispose(); neutral();
});

test('browser blur/hidden, focus in editor, pointercancel, disconnect and denied API release inputs', () => {
  const b = browser();
  b.win.emit('keydown', { code: 'Space' }); b.win.emit('blur'); neutral();
  b.doc.focused = false; b.step(); neutral();
  b.doc.focused = true; b.win.emit('focus');
  b.win.emit('keydown', { code: 'KeyW' });
  b.doc.hidden = true; b.doc.emit('visibilitychange'); neutral(); b.step(); neutral();
  b.doc.hidden = false; b.doc.emit('visibilitychange');
  b.win.emit('keydown', { code: 'Space' });
  b.doc.activeElement = box(0, 0, 100, 20, 'editor'); b.doc.emit('focusin'); neutral();
  b.doc.activeElement = b.target; b.doc.emit('focusin');
  b.win.emit('keydown', { code: 'KeyR' }); b.win.emit('pointercancel'); neutral();
  const p = pad(); b.pads([p]); b.step(); button(p, 7, 1); b.step(); assert.equal(state.attackHeld, true);
  b.win.emit('gamepaddisconnected', { gamepad: p }); neutral();
  button(p, 7, 0); b.step(); button(p, 7, 1); b.step();
  b.win.navigator.getGamepads = () => { throw Error('SecurityError'); }; b.step(); neutral();
  b.binding.dispose();
});

test('browser driving RT accelerates without shooting; stationary mouse never steals gamepad aim', () => {
  const b = browser();
  b.win.emit('pointermove', { clientX: 700, clientY: 250, target: b.target });
  const p = pad(); b.pads([p]); b.step(); p.axes[2] = -1; b.step();
  assert.equal(state.aimActive, false); // RS alone does not aim anymore
  button(p, 6, 1); b.step();
  near(state.aimX, -Math.SQRT1_2); near(state.aimY, Math.SQRT1_2);
  b.step(); near(state.aimX, -Math.SQRT1_2);
  b.drive(true); button(p, 6, 0); p.axes[2] = 0; b.step(); button(p, 7, 1); b.step();
  assert.equal(state.vehicleAccel, true); assert.equal(state.attackHeld, false); assert.equal(input.consumeAttack(), false);
  // O gatilho é pedal e cabra no mesmo toque: no ar ele move a cota, não a velocidade.
  assert.equal(state.heliUp, true); assert.equal(state.heliDown, false);
  button(p, 7, 0); button(p, 6, 1); b.step();
  assert.equal(state.heliUp, false); assert.equal(state.heliDown, true);
  b.binding.dispose();
});

test('adapter teardown cancels RAF/removes every listener; SSR/native hook attaches nothing', () => {
  const b = browser(); b.win.emit('keydown', { code: 'Space' });
  b.binding.dispose(); neutral();
  assert.equal(b.frames.size, 0); assert.equal(b.win.count(), 0); assert.equal(b.doc.count(), 0);
  b.win.emit('keydown', { code: 'Space' }); neutral();
  for (const os of ['web', 'android', 'ios']) {
    platform.OS = os;
    assert.equal(useHardwareInput(false), 'touch');
    for (const effect of effects.splice(0)) assert.equal(effect(), undefined);
  }
});

test('browser Ctrl permits movement/jump while Meta, Alt and other Ctrl shortcuts stay native', () => {
  const b = browser();
  b.win.emit('keydown', { code: 'ControlLeft', ctrlKey: true });
  assert.equal(input.consumeAttack(), true);
  for (const code of ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowRight']) {
    assert.equal(b.win.emit('keydown', { code, ctrlKey: true }).defaultPrevented, true);
    near(state.magnitude, 1); assert.equal(state.attackHeld, true);
    b.win.emit('keyup', { code, ctrlKey: true }); near(state.magnitude, 0);
  }
  assert.equal(b.win.emit('keydown', { code: 'Space', ctrlKey: true }).defaultPrevented, true);
  assert.equal(input.consumeJump(), true); assert.equal(input.consumeAttack(), false);
  b.win.emit('keydown', { code: 'Space', repeat: true, ctrlKey: true });
  assert.equal(input.consumeJump(), false);
  b.win.emit('keyup', { code: 'Space', ctrlKey: true });
  for (const code of ['KeyR', 'KeyF', 'KeyL', 'KeyT', 'KeyQ', 'KeyZ', 'KeyC', 'KeyE', 'KeyM', 'F5']) {
    assert.equal(b.win.emit('keydown', { code, ctrlKey: true }).defaultPrevented, false);
    b.win.emit('keyup', { code, ctrlKey: true }); neutral();
  }
  for (const modifier of ['metaKey', 'altKey']) {
    assert.equal(b.win.emit('keydown', { code: 'KeyW', [modifier]: true }).defaultPrevented, false);
    assert.equal(b.win.emit('keydown', { code: 'ControlRight', [modifier]: true }).defaultPrevented, false);
    neutral();
  }
  b.binding.dispose();
});

test('B alone claims gamepad, never runs, waits for neutral and does not leak across driving/disconnect', () => {
  const h = new HardwareInput(); const p = pad();
  button(p, 1, 1); h.pollGamepads([p]); assert.equal(h.mode, 'touch');
  button(p, 1, 0); h.pollGamepads([p]); button(p, 1, 1); h.pollGamepads([p]);
  assert.equal(h.mode, 'gamepad'); assert.equal(input.consumeJump(), true); assert.equal(state.runHeld, false);
  h.pollGamepads([p]); assert.equal(input.consumeJump(), false);
  h.setDriving(true); h.pollGamepads([p]); assert.equal(input.consumeJump(), false);
  button(p, 1, 0); h.pollGamepads([p]); button(p, 1, 1); h.pollGamepads([p]);
  assert.equal(input.consumeJump(), false);
  h.setDriving(false); h.pollGamepads([p]); assert.equal(input.consumeJump(), false);
  button(p, 1, 0); h.pollGamepads([p]); button(p, 1, 1); h.pollGamepads([p]);
  assert.equal(state.jumpQueued, true); h.disconnect(0); neutral();
});

test('rendered touch jump target works alongside joystick/run and clears on cancellation/unmount', () => {
  let touchContext;
  const callbacks = {};
  const gesture = new Proxy({}, { get: (_target, name) => (...args) => {
    if (String(name).startsWith('on')) callbacks[name] = args[0];
    return gesture;
  } });
  Object.assign(stubs.react, {
    createContext: (value) => (touchContext = { value, Provider: 'Provider' }),
    useContext: (context) => context.value,
    useCallback: (fn) => fn, useMemo: (fn) => fn(),
    useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
  });
  Object.assign(stubs['react-native'], {
    StyleSheet: { create: (styles) => styles, absoluteFillObject: {} },
    Dimensions: { get: () => ({ width: 390, height: 700 }) },
    useWindowDimensions: () => ({ width: 390, height: 700 }), View: 'View', Text: 'Text', Image: 'Image',
  });
  stubs['react-native-reanimated'] = { __esModule: true, default: { View: 'AnimatedView' }, runOnJS: (fn) => fn };
  stubs['react-native-gesture-handler'] = { Gesture: { Pan: () => gesture }, GestureDetector: 'GestureDetector' };
  stubs[path.join(root, 'src/ui/useControlInsets.ts')] = { useControlInsets: () => ({ left: 16, right: 16, bottom: 16 }) };
  stubs[path.join(root, 'src/audio/SoundManager.ts')] = { sound: { isUnlocked: true } };
  stubs[path.join(root, 'src/assets/AssetManifest.ts')] = { ASSET_FILES: {} };
  stubs[path.join(root, 'src/ui/ActionIcons.tsx')] = new Proxy({}, { get: () => () => null });
  const game = { weapons: { equipped: 'unarmed' }, player: { currentVehicleId: null } };
  stubs[path.join(root, 'src/game/GameState.ts')].getGame = () => game;
  const { ControlTouch } = source('ui/ControlTouch.tsx');
  const { ActionButtons } = source('ui/ActionButtons.tsx');
  const provider = ControlTouch({ driving: false, children: null });
  touchContext.value = provider.props.value;
  const cleanups = effects.splice(0).map((effect) => effect()).filter(Boolean);
  const views = [];
  function render(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(render); return; }
    if (typeof node.type === 'function') { render(node.type(node.props)); return; }
    if (node.props?.testID) views.push(node);
    render(node.props?.children);
  }
  render(ActionButtons({ flying: false })); effects.splice(0); // Layout is driven explicitly; no timer fakes needed.
  const jump = views.find((node) => node.props.testID === 'control-jump');
  assert.ok(jump); assert.equal(jump.props.accessibilityRole, 'button');
  assert.match(jump.props.accessibilityLabel, /Pular/);
  const rects = { jump: [250, 180, 120, 48], run: [290, 590, 76, 76], attack: [220, 590, 64, 64],
    weaponPrev: [220, 80, 70, 44], weapon: [300, 80, 70, 44], crouch: [300, 240, 70, 44] };
  assert.equal(views.find(n => n.props.testID === 'control-weaponPrev').props.accessibilityLabel, 'Arma anterior');
  assert.equal(views.find(n => n.props.testID === 'control-weapon').props.accessibilityLabel, 'Próxima arma');
  assert.equal(views.find(n => n.props.testID === 'control-crouch').props.accessibilityLabel, 'Alternar agachamento');
  for (const node of views) {
    const id = node.props.testID.replace('control-', '');
    if (!rects[id]) continue;
    node.props.ref.current = { measureInWindow: (fn) => fn(...rects[id]) };
    node.props.onLayout();
  }
  const down = (id, x, y) => callbacks.onTouchesDown({ changedTouches: [{ id, absoluteX: x, absoluteY: y }] });
  const up = (id) => callbacks.onTouchesUp({ changedTouches: [{ id }] });
  down(1, 50, 500);
  callbacks.onTouchesMove({ allTouches: [{ id: 1, absoluteX: 80, absoluteY: 510 }] });
  const magnitude = state.magnitude; assert.ok(magnitude > 0);
  down(2, 330, 620); assert.equal(state.runHeld, true);
  down(3, 310, 204); assert.equal(input.consumeJump(), true);
  near(state.magnitude, magnitude); assert.equal(state.runHeld, true); assert.equal(state.attackHeld, false);
  down(4, 310, 204); assert.equal(input.consumeJump(), false, 'held target cannot retrigger with another finger');
  for (const [x, y, consume, expected] of [[255, 102, input.consumeWeapon, -1], [335, 102, input.consumeWeapon, 1],
    [335, 262, input.consumeCrouch, true]]) {
    down(5, x, y); assert.equal(consume(), expected);
    down(6, x, y); assert.equal(consume(), consume === input.consumeWeapon ? 0 : false);
    near(state.magnitude, magnitude); assert.equal(state.runHeld, true); assert.equal(state.attackHeld, false);
    up(5); up(6);
  }
  down(5, 255, 102); down(6, 335, 262);
  assert.equal(state.weaponQueued, -1); assert.equal(state.crouchQueued, true);
  up(3); down(3, 310, 204); assert.equal(state.jumpQueued, true);
  callbacks.onTouchesCancelled(); neutral();
  down(3, 310, 204); assert.equal(state.jumpQueued, true);
  callbacks.onFinalize(null, false); neutral();
  down(3, 310, 204); assert.equal(state.jumpQueued, true);
  cleanups.forEach((cleanup) => cleanup()); neutral();
  down(3, 310, 204); neutral(); // delayed runOnJS after teardown must be ignored.
  game.player.currentVehicleId = 1;
  views.length = 0; render(ActionButtons({ flying: false })); effects.splice(0);
  for (const id of ['jump', 'crouch', 'weaponPrev', 'weapon']) {
    assert.equal(views.some((node) => node.props.testID === `control-${id}`), false);
  }
  // No ar os mesmos pedais viram cabra: o caminho de entrada não muda, só o nome.
  const labels = (flying) => {
    views.length = 0; render(ActionButtons({ flying })); effects.splice(0);
    const get = (id) => views.find((node) => node.props.testID === `control-${id}`);
    return [get('accel').props.accessibilityLabel, get('brake').props.accessibilityLabel];
  };
  assert.deepEqual(labels(false), ['Acelerar', 'Frear']);
  assert.deepEqual(labels(true), ['Subir o helicóptero', 'Descer o helicóptero']);
});

test('directional weapon slot defaults forward, latest edge wins and never conflicts with E/F/R', () => {
  assert.equal(input.consumeWeapon(), 0);
  input.queueWeapon(); assert.equal(input.consumeWeapon(), 1); assert.equal(input.consumeWeapon(), 0);
  input.queueWeapon(-1); input.queueWeapon(1); assert.equal(input.consumeWeapon(), 1);
  input.queueWeapon(1); input.queueWeapon(-1); assert.equal(input.consumeWeapon(), -1);
  const h = new HardwareInput();
  h.keyDown('KeyQ'); h.keyUp('KeyQ'); h.keyDown('KeyZ'); h.keyUp('KeyZ');
  input.resetActionInput(); h.refreshKeyboard(); assert.equal(input.consumeWeapon(), 1);
  h.keyDown('KeyQ'); h.keyUp('KeyQ');
  input.resetActionInput(); h.refreshKeyboard(); assert.equal(input.consumeWeapon(), -1);
  h.refreshKeyboard(); assert.equal(input.consumeWeapon(), 0);
  for (const [code, consume] of [['KeyE', input.consumeEnter], ['KeyF', input.consumeInteract], ['KeyR', input.consumeReload]]) {
    h.keyDown(code); h.keyUp(code); assert.equal(consume(), true);
    assert.equal(input.consumeWeapon(), 0); assert.equal(input.consumeCrouch(), false);
  }
});

test('C/Q/Z pending actions clear on release, pause, blur, driving and touch handover', () => {
  const boundaries = [h => h.release(), h => { h.setSuspended(true); h.setSuspended(false); },
    h => { h.setFocused(false); h.setFocused(true); }, h => { h.setDriving(true); h.setDriving(false); }, h => h.touch()];
  for (const boundary of boundaries) {
    for (const key of ['KeyC', 'KeyQ', 'KeyZ']) {
      const h = new HardwareInput(); h.keyDown(key); boundary(h); h.refreshKeyboard(); neutral();
      h.keyUp(key); h.keyDown(key); h.keyUp(key);
      assert.equal(key === 'KeyC' ? input.consumeCrouch() : input.consumeWeapon(), key === 'KeyC' ? true : key === 'KeyQ' ? -1 : 1);
      h.release();
    }
  }
  const h = new HardwareInput(); h.setDriving(true); h.keyDown('KeyC');
  assert.equal(input.consumeCrouch(), false);
  h.setDriving(false); h.keyDown('KeyC'); h.refreshKeyboard(); assert.equal(input.consumeCrouch(), false);
  h.keyUp('KeyC'); h.keyDown('KeyC'); assert.equal(input.consumeCrouch(), true);
});

test('LS click and bumpers alone claim the pad, preserve pending payloads and require neutral after lifecycle changes', () => {
  for (const [index, consume, expected] of [[10, input.consumeCrouch, true], [4, input.consumeWeapon, -1], [5, input.consumeWeapon, 1]]) {
    const h = new HardwareInput(); const p = pad(); button(p, index, 1);
    h.pollGamepads([p]); assert.equal(h.mode, 'touch'); neutral();
    button(p, index, 0); h.pollGamepads([p]); button(p, index, 1); h.pollGamepads([p]);
    assert.equal(h.mode, 'gamepad'); assert.equal(state.runHeld, false);
    input.resetActionInput(); h.pollGamepads([p]); assert.equal(consume(), expected);
    h.pollGamepads([p]); assert.equal(consume(), index === 10 ? false : 0);
    h.setSuspended(true); h.setSuspended(false); h.pollGamepads([p]); neutral();
    button(p, index, 0); h.pollGamepads([p]); button(p, index, 1); h.pollGamepads([p]);
    assert.equal(consume(), expected); h.disconnect(0); neutral();
  }
  const h = new HardwareInput(); const p = pad(); h.setDriving(true); h.pollGamepads([p]);
  button(p, 10, 1); h.pollGamepads([p]); assert.equal(input.consumeCrouch(), false);
  h.setDriving(false); h.pollGamepads([p]); assert.equal(input.consumeCrouch(), false);
  button(p, 10, 0); h.pollGamepads([p]); button(p, 10, 1); h.pollGamepads([p]);
  assert.equal(input.consumeCrouch(), true);
});

test('horn is a driving-only tap on H and pad B, drains once and never survives input boundaries', () => {
  const h = new HardwareInput();
  h.keyDown('KeyH'); h.keyUp('KeyH');
  assert.equal(input.consumeHorn(), false, 'a horn tap on foot must stay silent'); neutral();
  h.setDriving(true);
  h.keyDown('KeyH'); assert.equal(input.consumeHorn(), true); assert.equal(input.consumeHorn(), false);
  h.keyDown('KeyH', true); h.keyDown('KeyH');
  assert.equal(input.consumeHorn(), false, 'key auto-repeat cannot machine-gun the horn');
  h.keyUp('KeyH'); neutral();
  for (const boundary of [(x) => x.release(), (x) => { x.setSuspended(true); x.setSuspended(false); }, (x) => x.touch()]) {
    h.keyDown('KeyH'); boundary(h); h.refreshKeyboard(); neutral();
    assert.equal(input.consumeHorn(), false);
    h.keyUp('KeyH'); h.setDriving(true);
  }
  const g = new HardwareInput(); const p = pad();
  button(p, 1, 1); g.pollGamepads([p]); button(p, 1, 0); g.pollGamepads([p]); button(p, 1, 1); g.pollGamepads([p]);
  assert.equal(input.consumeHorn(), false); assert.equal(input.consumeJump(), true); neutral();
  g.setDriving(true); g.pollGamepads([p]);
  button(p, 1, 0); g.pollGamepads([p]); button(p, 1, 1); g.pollGamepads([p]);
  assert.equal(input.consumeJump(), false); assert.equal(input.consumeHorn(), true); neutral();
  button(p, 1, 0); g.pollGamepads([p]); g.release(); neutral();
});

test('cash bundles share cached 3D paths; simulation clock rotates and floats without allocating paths per frame', () => {
  let allocations = 0;
  stubs['@shopify/react-native-skia'] = {
    Circle: 'Circle', Group: 'Group', Oval: 'Oval', Path: 'Path', Rect: 'Rect',
    Skia: { Path: { Make() {
      allocations++;
      return { points: [], moveTo(x, y) { this.points.push([x, y]); },
        lineTo(x, y) { this.points.push([x, y]); }, close() {} };
    } } },
  };
  stubs['react-native-reanimated'].useDerivedValue = (read) => ({ get value() { return read(); } });
  const { MarkerLayer } = source('render/MarkerLayer.tsx');
  const clock = { value: 0 };
  const game = { fog: { view: () => ({}), intersects: () => true },
    map: { heightAt: () => 0, heightSmoothAt: () => 0 },
    pickups: { items: [{ id: 0, active: true, kind: 'cash', x: 1, y: 1 }] },
    missions: { state: { phase: 'break' } }, destruction: { wrecks: [] } };
  function render(node) {
    if (!node || typeof node !== 'object') return [];
    if (Array.isArray(node)) return node.flatMap(render);
    if (typeof node.type === 'function') return render(node.type(node.props));
    return [node, ...render(node.props?.children)];
  }
  const nodes = render(MarkerLayer({ game, clock })); effects.splice(0);
  const paths = nodes.filter(n => n.type === 'Path').map(n => n.props.path);
  const transform = nodes.find(n => n.type === 'Group' && n.props.transform).props.transform;
  const count = allocations; assert.equal(count, 72 * 6); assert.equal(paths.length, 8);
  assert.equal(nodes.filter(n => n.type === 'Circle').length, 0);
  const original = paths.map(p => p.value); const startY = transform.value[1].translateY;
  const top = original[3];
  clock.value = 0.5;
  assert.notEqual(paths[3].value, top); assert.notEqual(transform.value[1].translateY, startY);
  for (let i = 0; i < 600; i++) {
    clock.value = i / 60;
    for (const path of paths) for (const [x, y] of path.value.points) {
      assert.ok(Number.isFinite(x) && Number.isFinite(y));
      assert.ok(Math.abs(x) <= 14 && Math.abs(y) <= 10);
    }
    assert.equal(transform.value[0].translateX, 0);
  }
  assert.equal(allocations, count);
  clock.value = 0;
  paths.forEach((p, i) => assert.equal(p.value, original[i]));
  render(MarkerLayer({ game, clock })); effects.splice(0);
  assert.equal(allocations, count, 'remounts and other pickups reuse the geometry');
});

console.log(`Input/UI checks passed: ${passed}`);
