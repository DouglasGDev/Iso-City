// Run: node tools/check/check-life.cjs
// Same in-memory TS loader/native cache stubs as check-police-traffic.cjs and
// check-weapons.cjs. Real life/collision/damage systems; no generated config/build.
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');
const source = (name) => path.join(root, 'src', name + '.ts');
const program = ts.createProgram([source('systems/LifeSystem'), source('entities/NPC')], {
  target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, moduleResolution: ts.ModuleResolutionKind.Node10,
  strict: true, esModuleInterop: true, skipLibCheck: true, noEmit: true,
});
const diagnostics = ts.getPreEmitDiagnostics(program);
if (diagnostics.length) {
  console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCurrentDirectory: () => root, getCanonicalFileName: (f) => f, getNewLine: () => '\n',
  }));
  process.exit(1);
}
require.extensions['.ts'] = (module, filename) => {
  const { outputText } = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    fileName: filename,
  });
  module._compile(outputText, filename);
};
function stub(name, exports) {
  const filename = source(name);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}
const load = (name) => require(source(name));
const { LifeSystem } = load('systems/LifeSystem');
assert.equal(require.cache[source('game/GameState')], undefined, 'LifeSystem must not load GameState');
stub('audio/SoundManager', { sound: { play() {}, setLoop() {} } });
stub('assets/AssetManifest', { ASSET_FILES: {} });
let game;
stub('game/GameState', { getGame: () => game });
const { createNPC, deathPose, isNpcVisible, bloodStains, BLOOD_POOL_STAINS, DEATH_FALL_S, NPC_CORPSE_LIFETIME_S,
  NPC_CORPSE_FADE_S, PLAYER_DEATH_DELAY_S } = load('entities/NPC');
const { CollisionSystem } = load('systems/CollisionSystem');
const { NPCSystem } = load('systems/NPCSystem');
const { CombatSystem } = load('systems/CombatSystem');
const { WeaponSystem } = load('systems/WeaponSystem');
const { DestructionSystem } = load('systems/DestructionSystem');
const { createPlayer } = load('entities/Player');
const { createVehicle } = load('entities/Vehicle');
const { VEHICLE_DEFS } = load('data/vehicles');
const { GAME_CONFIG } = load('game/GameConfig');
const { Map: WorldMap } = load('world/Map');
const { generateCity } = load('data/maps/city');
const { characterKey, policeCharacterKey, spriteKeyForVehicle } = load('assets/AssetRegistry');
const { spriteStore } = load('assets/SpriteStore');
const { resolveEntityImage } = load('render/entityImages');
let passed = 0;
function test(name, fn) { fn(); passed++; console.log('OK ' + name); }
function near(a, b, eps = 1e-8) { assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`); }
const wall = (x, y, width = 1, height = 1) => ({ x, y, width, height, type: 'BUILDING' });
function fixture(nodes = [{ x: 75, y: 10 }, { x: 77, y: 10 }], walls = []) {
  const events = { changes: 0, wanted: [], drops: [], damage: [] };
  const map = {
    sidewalkNodes: nodes, sidewalkNeighbors: nodes.map((_, i) => [(i + 1) % nodes.length]),
    isInside: (x, y, r) => x >= r && y >= r && x <= 160 - r && y <= 160 - r,
    tileKindAt: () => 'concrete',
    nearestSidewalkNode(x, y) {
      let best = 0, dist = Infinity;
      nodes.forEach((p, i) => { const d = Math.hypot(p.x - x, p.y - y); if (d < dist) { dist = d; best = i; } });
      return best;
    },
    queryNearby(x, y, r) { return walls.filter((b) => b.x <= x + r && b.x + b.width >= x - r &&
      b.y <= y + r && b.y + b.height >= y - r); },
  };
  const ctx = { map, player: createPlayer(5, 5), vehicles: [], npcs: [], collision: new CollisionSystem(),
    rng: () => 0, onStructChange: () => events.changes++, time: 0, shake() {}, onPlayerExitedVehicle() {},
    health: { damage: (...args) => events.damage.push(args) },
    wanted: { raise: (_p, amount) => events.wanted.push(amount) },
    pickups: { spawnDrop: (...args) => events.drops.push(args), spawnWeaponDrop: () => {} } };
  return { ctx, events, life: new LifeSystem() };
}
function dead(f, x = 6, y = 5, patch = {}) {
  const n = createNPC(100 + f.ctx.npcs.length, 'a', x, y);
  Object.assign(n, { dead: true, health: 0, state: 'dead' }, patch);
  f.ctx.npcs.push(n);
  return n;
}
function advance(f, seconds, dt = 0.1) {
  for (let elapsed = 0; elapsed < seconds - 1e-8; elapsed += dt) f.life.update(Math.min(dt, seconds - elapsed), f.ctx);
}

test('strict TS; new civ/cop timers start at -1, death observation starts at exactly zero', () => {
  assert.equal(diagnostics.length, 0);
  for (const kind of ['civ', 'cop']) assert.equal(createNPC(1, 'a', 0, 0, kind).deathTimer, -1);
  const f = fixture(), n = dead(f);
  f.life.update(3, f.ctx);
  assert.equal(n.deathTimer, 0);
  assert.equal(f.events.changes, 0, 'damage system already owns the death notification');
  f.life.update(0.25, f.ctx);
  near(n.deathTimer, 0.25);
  assert.equal(n.health, 0);
  assert.equal(n.dead, true);
  const legacy = dead(f); delete legacy.deathTimer;
  f.life.update(0.1, f.ctx);
  assert.equal(legacy.deathTimer, 0);
});

test('invalid dt and paused caller do not observe death or advance timers', () => {
  const f = fixture(), n = dead(f, 60, 5);
  for (const dt of [0, -1, NaN, Infinity, -Infinity]) f.life.update(dt, f.ctx);
  assert.equal(n.deathTimer, -1);
  f.life.update(0.1, f.ctx);
  const snapshot = { ...n };
  for (const dt of [0, -1, NaN, Infinity]) f.life.update(dt, f.ctx);
  assert.deepEqual(n, snapshot);
  assert.equal(f.events.changes, 0);
});

test('body lasts 18 simulation seconds, fades only from 15 to 18, notifies disappearance once', () => {
  const f = fixture(), n = dead(f);
  f.life.update(0.1, f.ctx);
  f.life.update(15, f.ctx);
  assert.equal(isNpcVisible(n), true);
  assert.equal(deathPose(n.dead, n.deathTimer).alpha, 1);
  f.life.update(1.5, f.ctx);
  near(deathPose(true, n.deathTimer).alpha, 0.5);
  f.life.update(1.5, f.ctx);
  assert.equal(n.deathTimer, NPC_CORPSE_LIFETIME_S);
  assert.equal(isNpcVisible(n), false);
  assert.equal(deathPose(true, n.deathTimer).alpha, 0);
  assert.equal(f.events.changes, 1);
  advance(f, 25);
  assert.equal(f.events.changes, 1);
  assert.equal(n.dead, true, 'never respawn an expired corpse next to the player');
  assert.equal(n.x, 6);
});

test('smooth worklet fall handles all directions, alive reset, sentinel and finite pose bounds', () => {
  assert.equal(NPC_CORPSE_FADE_S, 3);
  assert.equal(PLAYER_DEATH_DELAY_S, 0.8);
  assert.ok(DEATH_FALL_S <= PLAYER_DEATH_DELAY_S);
  for (const dir of ['SE', 'NE', 'SW', 'NW']) {
    const first = deathPose(true, 0, dir);
    assert.deepEqual(deathPose(true, -1, dir), first);
    assert.deepEqual(deathPose(true, undefined, dir), first);
    assert.deepEqual(deathPose(true, NaN, dir), first);
    assert.deepEqual(deathPose(false, 100, dir), first);
    const middle = deathPose(true, DEATH_FALL_S / 2, dir);
    const last = deathPose(true, DEATH_FALL_S, dir);
    near(Math.abs(middle.rotation), Math.PI / 4);
    near(Math.abs(last.rotation), Math.PI / 2);
    near(last.scaleY, 0.75);
    assert.equal(Math.sign(last.rotation), dir === 'NE' || dir === 'SE' ? 1 : -1);
    assert.deepEqual(deathPose(true, PLAYER_DEATH_DELAY_S, dir), last, 'player delay includes full fall');
    for (let t = 0; t <= 25; t += 0.017) {
      const pose = deathPose(true, t, dir);
      assert.ok(Object.values(pose).every(Number.isFinite));
      assert.ok(pose.alpha >= 0 && pose.alpha <= 1 && pose.scaleY >= 0.75 && pose.scaleY <= 1);
    }
    assert.equal(deathPose(true, Infinity, dir).alpha, 0);
  }
});

test('only expired far civs respawn; old position and destination must both exceed FAR strictly', () => {
  const f = fixture([{ x: 5 + GAME_CONFIG.NPC_SIM_FAR, y: 5 }]);
  const n = dead(f, 60, 5);
  f.life.update(0.1, f.ctx);
  f.life.update(17.99, f.ctx);
  assert.equal(n.dead, true);
  f.life.update(0.01, f.ctx);
  assert.equal(n.dead, true, 'destination at FAR is forbidden');
  f.ctx.map.sidewalkNodes[0].x += 0.01;
  n.x = 5 + GAME_CONFIG.NPC_SIM_FAR;
  advance(f, 2);
  assert.equal(n.dead, true, 'old corpse at FAR is forbidden');
  n.x += 0.01;
  advance(f, 2);
  assert.equal(n.dead, false);
  assert.equal(n.x, 5 + GAME_CONFIG.NPC_SIM_FAR + 0.01);
  assert.equal(f.events.changes, 2, 'expiry and later respawn each notify');
});

test('camera veto protects old and new positions even beyond simulation range', () => {
  for (const blockedX of [60, 75]) {
    const f = fixture([{ x: 75, y: 10 }]), n = dead(f, 60, 5);
    f.ctx.isPointVisible = (x) => x === blockedX;
    f.life.update(0.1, f.ctx); f.life.update(18, f.ctx);
    advance(f, 3);
    assert.equal(n.dead, true);
    f.ctx.isPointVisible = () => false;
    advance(f, 2);
    assert.equal(n.dead, false);
  }
});

test('repurpose in place resets every transient field, not array/index/id/char or other actors', () => {
  const f = fixture(), n = dead(f, 60, 5, { downTimer: 2, punchCooldown: 5, speed: 2,
    anim: 'walk', frame: 3, animTimer: 88, dir: 'NW', path: [{ x: 4, y: 5 }], pathIndex: 1,
    fleeTimer: 9, patienceTimer: -10, stuckTimer: 8, lastX: 0, lastY: 0 });
  const alive = createNPC(3, 'c', 95, 95);
  f.ctx.npcs.push(alive);
  const snapshot = structuredClone(alive), array = f.ctx.npcs, id = n.id;
  f.life.update(0.1, f.ctx); f.life.update(18, f.ctx);
  assert.equal(f.ctx.npcs, array);
  assert.equal(f.ctx.npcs.length, 2);
  assert.equal(f.ctx.npcs[0], n);
  assert.deepEqual(n, createNPC(id, 'a', 75, 10, 'civ', () => 0));
  assert.deepEqual(alive, snapshot);
  assert.equal(f.events.changes, 1, 'expiry and respawn in same update are batched');
});

test('police and traffic-linked slots are never reused or detached, including inconsistent flags', () => {
  const f = fixture();
  const actors = [dead(f, 60, 5, { kind: 'cop', health: -15 }),
    dead(f, 61, 5, { inVehicle: true, vehicleId: 12 }),
    dead(f, 62, 5, { inVehicle: false, vehicleId: 13 }),
    dead(f, 63, 5, { inVehicle: true, vehicleId: null })];
  const before = actors.map((n) => structuredClone(n));
  f.life.update(0.1, f.ctx); advance(f, 50);
  actors.forEach((n, i) => assert.deepEqual(n,
    { ...before[i], deathTimer: 18, blood: bloodStains(n.id, n.dir) }));
  assert.equal(f.ctx.npcs.length, 4);
  assert.equal(f.events.changes, 1);
  // TrafficSystem has explicitly released this reference: it is now a pedestrian.
  actors[1].inVehicle = false; actors[1].vehicleId = null;
  f.life.update(1, f.ctx);
  assert.equal(actors[1].dead, false);
  assert.equal(actors[0].kind, 'cop');
});

test('living knockdowns/low HP are not deaths; external in-place revival starts a new cycle', () => {
  const f = fixture(), n = createNPC(1, 'a', 6, 5);
  Object.assign(n, { state: 'knocked', downTimer: 2, health: 0 });
  f.ctx.npcs.push(n);
  f.life.update(25, f.ctx);
  assert.equal(n.dead, false); assert.equal(n.deathTimer, -1); assert.equal(n.downTimer, 2);
  n.dead = true;
  f.life.update(0.1, f.ctx); f.life.update(18, f.ctx);
  Object.assign(n, createNPC(n.id, n.char, n.x, n.y));
  n.dead = true; // A kill can happen before LifeSystem observes the revived actor.
  f.life.update(1, f.ctx);
  assert.equal(n.deathTimer, 0);
  assert.equal(isNpcVisible(n), true);
});

test('reject water/road/outside/isolated nodes, walls, vehicles, living NPCs and visible corpses', () => {
  for (const mode of ['water', 'road', 'outside', 'isolated', 'wall', 'vehicle', 'npc', 'corpse']) {
    const f = fixture([{ x: 75, y: 10 }], mode === 'wall' ? [wall(74.8, 9.8)] : []);
    const n = dead(f, 60, 5);
    if (mode === 'water' || mode === 'road') f.ctx.map.tileKindAt = () => mode;
    if (mode === 'outside') f.ctx.map.sidewalkNodes[0].x = 161;
    if (mode === 'isolated') f.ctx.map.sidewalkNeighbors[0] = [];
    if (mode === 'vehicle') f.ctx.vehicles.push(createVehicle(1, VEHICLE_DEFS.sedan, 'blue', 75, 10, 'SE'));
    if (mode === 'npc') f.ctx.npcs.push(createNPC(2, 'c', 75, 10));
    if (mode === 'corpse') dead(f, 75, 10);
    // The blocking corpse remains in its initial visible window this tick.
    n.deathTimer = 17.99;
    f.life.update(0.02, f.ctx);
    assert.equal(n.dead, true, mode);
    assert.equal(n.x, 60, mode);
  }
});

test('empty/fully blocked map waits; bounded search retries later without repeated notifications', () => {
  const empty = fixture([]), e = dead(empty, 60, 5);
  empty.life.update(0.1, empty.ctx); empty.life.update(18, empty.ctx); advance(empty, 10);
  assert.equal(e.dead, true); assert.equal(empty.events.changes, 1);
  const nodes = Array.from({ length: 100 }, (_, i) => ({ x: 75 + i * 0.5, y: 10 }));
  const f = fixture(nodes), n = dead(f, 60, 5);
  let probes = 0;
  f.ctx.collision.overlapsAny = () => { probes++; return true; };
  f.life.update(0.1, f.ctx); f.life.update(18, f.ctx);
  assert.equal(probes, 32);
  advance(f, 0.5);
  assert.equal(probes, 32, 'no failed spawn search every frame');
  f.ctx.collision.overlapsAny = () => false;
  advance(f, 1.1);
  assert.equal(n.dead, false); assert.equal(f.events.changes, 2);
});

test('large death waves are bounded, keep unique slots, batch notifications and eventually recover', () => {
  const nodes = Array.from({ length: 24 }, (_, i) => ({ x: 70 + i * 2, y: 10 }));
  const f = fixture(nodes);
  for (let i = 0; i < 12; i++) dead(f, 60 + i, 30);
  const refs = [...f.ctx.npcs], ids = refs.map((n) => n.id);
  for (let round = 0; round < 20; round++) {
    for (const n of refs) { n.dead = true; n.health = 0; n.state = 'dead'; }
    f.life.update(0.1, f.ctx); f.life.update(18, f.ctx);
    assert.equal(refs.filter((n) => !n.dead).length, 4);
    f.life.update(0.1, f.ctx); f.life.update(0.1, f.ctx);
    assert.ok(refs.every((n) => !n.dead));
    assert.deepEqual(f.ctx.npcs.map((n) => n.id), ids);
    refs.forEach((n, i) => assert.equal(f.ctx.npcs[i], n));
    assert.equal(f.events.changes, (round + 1) * 3);
  }
});

test('render resolves idle corpse before observation and throughout fade, hides expired/driver slots', () => {
  const f = fixture(); game = f.ctx;
  for (const kind of ['civ', 'cop']) for (const dir of ['NE', 'NW', 'SE', 'SW']) {
    f.ctx.npcs.length = 0;
    const n = dead(f, 6, 5, { kind, dir, anim: 'walk', frame: 3 });
    const key = kind === 'cop' ? policeCharacterKey('idle', dir, 0) : characterKey(n.char, 'idle', dir, 0);
    const image = spriteStore[key] = { key };
    for (const t of [-1, 0, DEATH_FALL_S, 15, 17.999]) {
      n.deathTimer = t;
      assert.equal(resolveEntityImage('npc:0'), image);
      assert.equal(isNpcVisible(n), true);
    }
    n.deathTimer = 18;
    assert.equal(resolveEntityImage('npc:0'), null);
    n.deathTimer = 0; n.inVehicle = true;
    assert.equal(resolveEntityImage('npc:0'), null);
    n.inVehicle = false; delete spriteStore[key];
    assert.equal(resolveEntityImage('npc:0'), null, 'no stale image fallback');
    n.dead = false;
    const walkingKey = kind === 'cop' ? policeCharacterKey('walk', dir, 3) : characterKey(n.char, 'walk', dir, 3);
    spriteStore[walkingKey] = { key: walkingKey };
    assert.equal(resolveEntityImage('npc:0'), spriteStore[walkingKey]);
  }
  assert.equal(resolveEntityImage('npc:999'), null);
});

test('player death uses idle image without Player fields, preserves vehicle image/entry semantics', () => {
  const f = fixture(); game = f.ctx;
  const p = f.ctx.player;
  p.anim = 'walk'; p.frame = 3;
  const key = characterKey(p.char, 'idle', p.direction, 0), image = spriteStore[key] = { key };
  for (const mode of ['health', 'state']) {
    p.health = mode === 'health' ? 0 : 100; p.state = mode === 'state' ? 'dead' : 'walking';
    assert.equal(resolveEntityImage('player'), image);
    assert.equal(deathPose(true, PLAYER_DEATH_DELAY_S, p.direction).alpha, 1);
  }
  p.currentVehicleId = 1;
  assert.equal(resolveEntityImage('player'), null);
  const v = createVehicle(1, VEHICLE_DEFS.sedan, 'blue', 10, 10, 'SE');
  f.ctx.vehicles.push(v);
  const vk = spriteKeyForVehicle(v.def, v.color, v.dir, 0); spriteStore[vk] = { key: vk };
  assert.equal(resolveEntityImage('veh:0'), spriteStore[vk]);
  v.state = 'destroyed'; assert.equal(resolveEntityImage('veh:0'), null);
});

for (const cause of ['melee', 'gun', 'explosion']) test(`real ${cause} death is observed, not repeated: health/drops/crime stay owned by damage`, () => {
  const f = fixture(); game = f.ctx;
  const n = createNPC(1, 'a', 5.5, 5);
  n.health = 1; n.anim = 'walk'; n.frame = 3;
  f.ctx.npcs.push(n);
  if (cause === 'melee') new CombatSystem().tryAttack(f.ctx);
  if (cause === 'gun') { const w = new WeaponSystem(); w.acquire('pistol'); w.equipped = 'pistol'; w.tryFire(f.ctx); }
  if (cause === 'explosion') {
    const v = createVehicle(1, VEHICLE_DEFS.sedan, 'blue', 5.5, 5, 'SE');
    v.health = 0; f.ctx.vehicles.push(v);
    new DestructionSystem().update(0.1, f.ctx);
  }
  assert.equal(n.dead, true); assert.equal(n.deathTimer, -1);
  const idle = characterKey(n.char, 'idle', n.dir, 0); spriteStore[idle] = { key: idle };
  assert.equal(resolveEntityImage('npc:0'), spriteStore[idle]);
  const health = n.health, player = structuredClone(f.ctx.player);
  const drops = structuredClone(f.events.drops), wanted = [...f.events.wanted], damage = f.events.damage.length;
  const changes = f.events.changes;
  f.life.update(0.1, f.ctx); advance(f, 20);
  assert.ok(n.blood?.length, `${cause} deaths leave blood on the ground`);
  assert.equal(n.health, health); assert.deepEqual(f.ctx.player, player);
  assert.deepEqual(f.events.drops, drops); assert.deepEqual(f.events.wanted, wanted);
  assert.equal(f.events.damage.length, damage);
  assert.equal(f.events.changes, changes + 1);
  assert.equal(n.deathTimer, 18);
});

test('generated city respawns on a clear sidewalk and new pedestrian resumes normal simulation', () => {
  const f = fixture();
  f.ctx.map = new WorldMap(generateCity(42));
  Object.assign(f.ctx.player, f.ctx.map.data.playerSpawn);
  let seed = 42;
  f.ctx.rng = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  const far = f.ctx.map.sidewalkNodes.find((p) => Math.hypot(p.x - f.ctx.player.x, p.y - f.ctx.player.y) > 45);
  assert.ok(far);
  const n = dead(f, far.x, far.y);
  f.life.update(0.1, f.ctx); f.life.update(18, f.ctx); advance(f, 10);
  assert.equal(n.dead, false);
  assert.ok(Math.hypot(n.x - f.ctx.player.x, n.y - f.ctx.player.y) > GAME_CONFIG.NPC_SIM_FAR);
  assert.ok(f.ctx.map.sidewalkNodes.some((p) => p.x === n.x && p.y === n.y));
  assert.equal(f.ctx.map.isWaterWorld(n.x, n.y), false);
  assert.equal(f.ctx.collision.overlapsAny({ x: n.x, y: n.y, radius: GAME_CONFIG.NPC_RADIUS },
    f.ctx.map.queryNearby(n.x, n.y, 2)), false);
  const system = new NPCSystem(f.ctx.collision), start = { x: n.x, y: n.y };
  for (let i = 0; i < 120; i++) system.update(n, f.ctx.map, [], 0.05, start.x, start.y, 0);
  assert.ok(Math.hypot(n.x - start.x, n.y - start.y) > 0.1);
  assert.equal(n.deathTimer, -1);
});

test('civilians swim to the nearest sidewalk instead of walking on water and settle once ashore', () => {
  const f = fixture();
  const map = f.ctx.map;
  map.worldW = 160; map.worldH = 160;
  map.isWaterWorld = (x, y) => Math.floor(y) === 10 && x < 75;
  const n = createNPC(1, 'a', 71, 10);
  Object.assign(n, { state: 'fleeing', fleeTimer: 30, anim: 'walk', frame: 2, speed: GAME_CONFIG.NPC_FLEE_SPEED });
  f.ctx.npcs.push(n);
  const system = new NPCSystem(f.ctx.collision);
  system.update(n, map, [], 0.05, 60, 60, 0);
  assert.equal(n.swimming, true);
  assert.equal(n.anim, 'swim', 'no walking frames on top of the water');
  assert.equal(n.dir, 'SE', 'the stroke points at the shore, not away from the player');
  assert.equal(n.speed, GAME_CONFIG.NPC_SWIM_SPEED);
  assert.ok(n.x > 71 && n.x < 71.1);
  for (let i = 0; i < 4; i++) system.update(n, map, [], 0.05, 60, 60, 0);
  assert.equal(n.frame, 3, 'the swim cycle keeps playing');
  for (let i = 0; i < 200 && n.swimming; i++) system.update(n, map, [], 0.05, 60, 60, 0);
  assert.equal(n.swimming, false, 'the swim stops on the sidewalk');
  assert.equal(n.state, 'idle');
  assert.equal(n.anim, 'idle');
  assert.equal(n.x, 75, 'the swim ends on the sidewalk node');
});

test('swimming panic expires while crossing, so a river cannot freeze the flee state', () => {
  const f = fixture();
  const map = f.ctx.map;
  map.worldW = 160; map.worldH = 160;
  map.isWaterWorld = () => true;
  const n = createNPC(1, 'a', 71, 10);
  Object.assign(n, { state: 'fleeing', fleeTimer: 0.2 });
  const system = new NPCSystem(f.ctx.collision);
  for (let i = 0; i < 10; i++) system.update(n, map, [], 0.05, 60, 60, 0);
  assert.equal(n.state, 'idle');
  assert.equal(n.anim, 'swim', 'still swimming until the position leaves the water');
});

test('swimming civilians draw the player walk frames, including the police variant', () => {
  const f = fixture(); game = f.ctx;
  const n = createNPC(1, 'a', 71, 10);
  Object.assign(n, { swimming: true, anim: 'swim', dir: 'SW', frame: 2 });
  f.ctx.npcs.push(n);
  const key = characterKey(n.char, 'swim', 'SW', 2);
  assert.equal(key, 'Characters/char_a_walk_SW_f03.png');
  const image = spriteStore[key] = { key };
  assert.equal(resolveEntityImage('npc:0'), image);
  const cop = createNPC(2, 'a', 71, 10, 'cop');
  Object.assign(cop, { swimming: true, anim: 'swim', dir: 'SW', frame: 0 });
  f.ctx.npcs.push(cop);
  const copKey = policeCharacterKey('swim', 'SW', 0);
  spriteStore[copKey] = { key: copKey };
  assert.equal(resolveEntityImage('npc:1'), spriteStore[copKey]);
});

test('a fresh death bleeds once: fixed iso stains that trail the side the body fell to', () => {
  const f = fixture(); game = f.ctx;
  const east = dead(f, 60, 5, { dir: 'SE' });
  const west = dead(f, 61, 5, { dir: 'NW' });
  f.life.update(0.1, f.ctx);
  const stain = east.blood;
  assert.ok(Array.isArray(stain), 'the first observed tick draws blood');
  assert.equal(stain.length, BLOOD_POOL_STAINS + 6);
  assert.notEqual(west.blood, stain);
  const mean = (list) => list.reduce((sum, s) => sum + s.dx, 0) / list.length;
  assert.ok(mean(stain.slice(0, BLOOD_POOL_STAINS)) > 0 && mean(west.blood.slice(0, BLOOD_POOL_STAINS)) < 0,
    'the pool runs to the side the body fell to');
  for (const s of [...stain, ...west.blood]) {
    assert.ok(s.rx > s.ry, `flattened on the iso ground: ${JSON.stringify(s)}`);
    assert.ok(Math.abs(s.dx) <= 28 && Math.abs(s.dy) <= 14, JSON.stringify(s));
    assert.ok(s.alpha > 0 && s.alpha <= 1, JSON.stringify(s));
  }
  f.life.update(0.1, f.ctx);
  assert.equal(east.blood, stain, 'an already observed death does not re-bleed');
  assert.deepEqual(bloodStains(west.id, 'NW'), west.blood, 'the pattern is deterministic');
});

test('explosion leaves a wreck with the vehicle pose, blast time and fixed shard scatter', () => {
  const f = fixture(); game = f.ctx;
  const system = new DestructionSystem();
  const v = createVehicle(3, VEHICLE_DEFS.sedan, 'blue', 12, 11, 'NW');
  v.health = 0; f.ctx.vehicles.push(v);
  f.ctx.time = 4.5;
  system.update(0.1, f.ctx);
  assert.equal(system.wrecks.length, 1);
  const wreck = system.wrecks[0];
  assert.deepEqual({ x: wreck.x, y: wreck.y, dir: wreck.dir, explodedAt: wreck.explodedAt },
    { x: 12, y: 11, dir: 'NW', explodedAt: 4.5 });
  // Manifest vazio em memória: sem frame carbonizado o render usa a carcaça vetorial.
  assert.equal(wreck.key, null);
  assert.ok(Math.abs(wreck.tilt) <= 0.13, String(wreck.tilt));
  assert.equal(wreck.shards.length, 7);
  for (const s of wreck.shards) {
    assert.ok(Math.abs(s.dx) <= 0.8 && Math.abs(s.dy) <= 0.8, JSON.stringify(s));
    assert.ok(s.size >= 2 && s.size < 6 && s.rot >= 0 && s.rot < Math.PI, JSON.stringify(s));
  }
  const again = new DestructionSystem();
  const twin = createVehicle(3, VEHICLE_DEFS.sedan, 'blue', 40, 40, 'SE');
  twin.health = 0; f.ctx.vehicles = [twin];
  again.update(0.1, f.ctx);
  assert.deepEqual(again.wrecks[0].shards, wreck.shards, 'same vehicle keeps the same debris');
});

test('burnt hulls stop piling up: the oldest scorch is replaced after 40 explosions', () => {
  const f = fixture(); game = f.ctx;
  const system = new DestructionSystem();
  f.ctx.vehicles = Array.from({ length: 45 }, (_, i) =>
    createVehicle(i + 1, VEHICLE_DEFS.sedan, 'blue', 20 + i * 0.1, 20, 'SE'));
  for (const v of f.ctx.vehicles) v.health = 0;
  f.ctx.time = 9;
  system.update(0.1, f.ctx);
  assert.equal(system.wrecks.length, 40);
  near(system.wrecks[0].x, 20 + 5 * 0.1, 1e-9);
  near(system.wrecks[39].x, 20 + 44 * 0.1, 1e-9);
});

// Same CPU Skia backend as check-weapons.cjs. Exercise the documented feet-pivot
// transform with real idle sprites; EntitySprite integration belongs to main.
async function checkPosePixels() {
  const ck = await require('canvaskit-wasm')();
  const { PNG } = require('pngjs');
  const surface = ck.MakeSurface(128, 128);
  assert.ok(surface);
  const canvas = surface.getCanvas();
  const mass = (bytes) => {
    const { data } = PNG.sync.read(bytes);
    let alpha = 0;
    for (let i = 3; i < data.length; i += 4) alpha += data[i];
    return alpha;
  };
  test('real idle sprites show fall, hold and fade in CPU Skia for civilians, cops and player', () => {
    for (const char of ['a', 'b', 'c', 'police']) for (const dir of ['NE', 'NW', 'SE', 'SW']) {
      const key = char === 'police' ? policeCharacterKey('idle', dir, 0) : characterKey(char, 'idle', dir, 0);
      const image = ck.MakeImageFromEncoded(fs.readFileSync(path.join(root, 'assets/sprites', key)));
      assert.ok(image, key);
      const frame = (elapsed, dead = true) => {
        const pose = deathPose(dead, elapsed, dir);
        canvas.clear(ck.TRANSPARENT);
        canvas.save();
        canvas.translate(64, 80 + pose.offsetY);
        canvas.rotate(pose.rotation * 180 / Math.PI, 0, 0);
        canvas.scale(1, pose.scaleY);
        canvas.translate(-image.width() / 2, -image.height());
        const paint = new ck.Paint();
        paint.setAlphaf(pose.alpha);
        canvas.drawImage(image, 0, 0, paint);
        paint.delete();
        canvas.restore();
        surface.flush();
        const snapshot = surface.makeImageSnapshot();
        const bytes = Buffer.from(snapshot.encodeToBytes());
        snapshot.delete();
        return bytes;
      };
      const start = frame(0), middle = frame(DEATH_FALL_S / 2), lying = frame(DEATH_FALL_S);
      assert.notDeepEqual(start, middle, `${key}: visible start of fall`);
      assert.notDeepEqual(middle, lying, `${key}: visible end of fall`);
      assert.deepEqual(lying, frame(15), `${key}: stable body until fade`);
      assert.deepEqual(start, frame(100, false), `${key}: alive resets pose and opacity`);
      const ratio = mass(frame(16.5)) / mass(lying);
      assert.ok(ratio > 0.49 && ratio < 0.51, `${key}: half-alpha at 16.5s (${ratio})`);
      assert.equal(mass(frame(18)), 0, `${key}: fully gone at 18s`);
      image.delete();
    }
  });
  surface.dispose();
}
checkPosePixels().then(() => console.log(`Life checks passed: ${passed}`)).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
