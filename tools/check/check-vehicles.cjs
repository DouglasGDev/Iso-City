// Run: node tools/check/check-vehicles.cjs
// Real asset registry, PNGs, entities, collision, movement and interaction systems.
// TypeScript is compiled in memory; no native renderer, config or build output needed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { PNG } = require('pngjs');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');
require.extensions['.png'] = (module, file) => { module.exports = file; };
require.extensions['.ts'] = (module, file) => module._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  fileName: file,
}).outputText, file);
const load = (file) => require(path.join(root, 'src', file + '.ts'));
// O atropelamento faz barulho: só o áudio nativo é stub, o resto do sistema roda real.
const audio = [];
const soundFile = path.join(root, 'src', 'audio/SoundManager.ts');
require.cache[soundFile] = {
  id: soundFile, filename: soundFile, loaded: true,
  exports: { sound: { play: (...args) => audio.push(args), setLoop: (...args) => audio.push(args) } },
};
const { VEHICLE_DEFS, CIVILIAN_VEHICLES, VEHICLE_ORDER } = load('data/vehicles');
const { spriteKeyForVehicle, vehicleKey, isKnownAsset, ASSETS_TO_LOAD, damagedVehicleKey } = load('assets/AssetRegistry');
const { createVehicle, vehicleSpriteKey } = load('entities/Vehicle');
const { createPlayer } = load('entities/Player');
const { CollisionSystem, vehicleGroundCollider, collideCircleAabb } = load('systems/CollisionSystem');
const { VehicleSystem } = load('systems/VehicleSystem');
const { VehicleImpactSystem } = load('systems/VehicleImpactSystem');
const { HealthSystem } = load('systems/HealthSystem');
const { WantedSystem } = load('systems/WantedSystem');
const { createNPC } = load('entities/NPC');
const { createAnimal } = load('entities/Animal');
const { InteractionSystem } = load('systems/InteractionSystem');
const { MovementSystem } = load('systems/MovementSystem');
const { Map: WorldMap } = load('world/Map');
const { inputState, resetVehicleArrows } = load('game/InputState');
const { GAME_CONFIG } = load('game/GameConfig');
const { DIR_VECTORS } = load('world/IsoUtils');
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const metadata = JSON.parse(fs.readFileSync(path.join(root, 'assets/vehicle-source/source.json'), 'utf8'));
const directions = ['NE', 'NW', 'SE', 'SW'];
const variants = ['taxi', 'ambulance', 'hatchback', 'police_compact'];
const hatchbackIndices = { NE: '003', NW: '001', SE: '008', SW: '007' };
const collision = new CollisionSystem();
const vehicleSystem = new VehicleSystem();
const interaction = new InteractionSystem(vehicleSystem);
const movement = new MovementSystem(collision);
let passed = 0;
function test(name, run) {
  run();
  passed++;
  console.log('OK ' + name);
}
function near(a, b) { assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`); }
function world(obstacles = []) {
  const size = 32;
  return new WorldMap({ tilesW: size, tilesH: size, worldW: size, worldH: size,
    tiles: Array.from({ length: size * size }, () => ({ kind: 'road', key: '', lane: null })),
    buildings: [], props: [], vehicles: [], npcSpawns: [], playerSpawn: { x: 12, y: 12 },
  }, obstacles);
}
const emptyWorld = world();

test('CC0 provenance is limited to this pack and preserves the original license', () => {
  assert.equal(metadata.license, 'CC0-1.0');
  assert.equal(metadata.sourceUrl, 'https://kenney.nl/assets/isometric-tiles-vehicles');
  assert.equal(metadata.archive.sha256, 'b478cf692d936e2cfda2368f8d24505841508907adc343f1068a6b2ea457d3fd');
  const license = fs.readFileSync(path.join(root, metadata.originalLicense.file));
  assert.match(license.toString(), /Creative Commons Zero, CC0/);
  assert.match(license.toString(), /Kenney Vleugels/);
  assert.equal(sha256(license), metadata.originalLicense.sha256);
  assert.match(metadata.scope, /No license claim.*pre-existing vehicle fleet/);
  assert.equal(metadata.derivatives.length, 16);
  assert.deepEqual(metadata.directionValidation.hatchbackIndices, hatchbackIndices);
  assert.equal(metadata.preparation.sampling, 'nearest-neighbor');
});

test('new driveable fleet keeps police classification and civilian/service separation', () => {
  for (const id of variants) {
    assert.equal(VEHICLE_DEFS[id].driveable, true);
    assert.ok(VEHICLE_ORDER.includes(id));
  }
  assert.equal(VEHICLE_DEFS.police_compact.type, 'police');
  assert.equal(VEHICLE_DEFS.police_compact.baseKey, 'veh_police_compact');
  assert.ok(CIVILIAN_VEHICLES.includes('taxi'));
  assert.ok(CIVILIAN_VEHICLES.includes('hatchback'));
  assert.ok(!CIVILIAN_VEHICLES.includes('ambulance'));
  assert.ok(!CIVILIAN_VEHICLES.includes('police_compact'));
  assert.ok(VEHICLE_DEFS.hatchback.footprintH < VEHICLE_DEFS.taxi.footprintH);
  assert.ok(VEHICLE_DEFS.police_compact.footprintH < VEHICLE_DEFS.police.footprintH);
  assert.ok(VEHICLE_DEFS.ambulance.footprintH > VEHICLE_DEFS.taxi.footprintH);
});

test('baseKey selects variants; all old keys, helicopter rotors and garbage stay compatible', () => {
  for (const [id, def] of Object.entries(VEHICLE_DEFS)) {
    for (const color of def.colors.length ? def.colors : ['']) for (const dir of directions) {
      for (const frame of [0, 1, 2]) {
        const key = spriteKeyForVehicle(def, color, dir, frame);
        assert.ok(isKnownAsset(key), key);
        assert.ok(ASSETS_TO_LOAD.includes(key), key);
        if (!variants.includes(id)) assert.equal(key, vehicleKey(def.type, color, dir, frame));
      }
    }
  }
  assert.equal(spriteKeyForVehicle(VEHICLE_DEFS.helicopter, '', 'NE', 2), 'Vehicles/veh_helicopter_red_NE_f2.png');
  assert.equal(spriteKeyForVehicle(VEHICLE_DEFS.garbage, '', 'SW'), 'Vehicles/veh_garbage_SW_normal.png');
  assert.equal(spriteKeyForVehicle({ ...VEHICLE_DEFS.sedan, baseKey: 'custom_variant' }, 'blue', 'NW'),
    'Vehicles/custom_variant_blue_NW.png');
  assert.equal(spriteKeyForVehicle(VEHICLE_DEFS.police_compact, '', 'SE'), 'Vehicles/veh_police_compact_SE.png');
});

// O casco carbonizado do destroço usa o frame *_damaged do pack; onde ele não
// existe o render desenha a carcaça vetorial.
const paintOf = (def, color) => def.type === 'helicopter' ? color || 'red'
  : def.colors.length ? color : '';

test('charred frames resolve and load for every direction where the pack has them', () => {
  const withHull = [];
  for (const [id, def] of Object.entries(VEHICLE_DEFS)) {
    for (const color of def.colors.length ? def.colors : ['']) {
      for (const dir of directions) {
        const paint = paintOf(def, color);
        const expected = `Vehicles/${def.baseKey}${paint ? '_' + paint : ''}_${dir}_damaged.png`;
        const key = damagedVehicleKey(def, color, dir);
        if (key === null) {
          assert.equal(isKnownAsset(expected), false, `${id} ${color} ${dir} exists but is not resolved`);
          continue;
        }
        assert.equal(key, expected);
        assert.ok(isKnownAsset(key), key);
        assert.ok(ASSETS_TO_LOAD.includes(key), `${key} must be loaded to draw wrecks`);
        const png = PNG.sync.read(fs.readFileSync(path.join(root, 'assets/sprites', key)));
        const normal = PNG.sync.read(fs.readFileSync(path.join(root, 'assets/sprites', spriteKeyForVehicle(def, color, dir))));
        assert.ok(Math.abs(png.width - normal.width) <= 3 && Math.abs(png.height - normal.height) <= 3,
          `${key} must keep the vehicle silhouette (${png.width}x${png.height} vs ${normal.width}x${normal.height})`);
      }
    }
    if (damagedVehicleKey(def, def.colors[0] || '', 'SE') !== null) withHull.push(id);
  }
  assert.deepEqual(withHull, ['sedan', 'pickup', 'van', 'box', 'truck', 'police', 'garbage',
    'bus_school', 'firetruck', 'swat']);
  for (const id of ['taxi', 'ambulance', 'hatchback', 'police_compact', 'helicopter']) {
    assert.equal(damagedVehicleKey(VEHICLE_DEFS[id], VEHICLE_DEFS[id].colors[0] || '', 'NW'), null, id);
  }
});

for (const id of variants) {
  const def = VEHICLE_DEFS[id];
  const color = def.colors[0] || '';
  test(`${id}: four distinct PNGs, verified source mapping, hashes, proportional nearest pixels and padding`, () => {
    const hashes = new Set();
    const entries = metadata.derivatives.filter((entry) => entry.variant === id);
    assert.equal(entries.length, 4);
    for (const dir of directions) {
      const key = vehicleSpriteKey(createVehicle(1, def, color, 12, 12, dir));
      const entry = entries.find((item) => item.direction === dir);
      assert.ok(entry, `${id} ${dir}`);
      assert.equal(entry.assetKey, key);
      const expectedSource = id === 'hatchback' ? `PNG/Civilian/Blue/Sedan 4/carBlue5_${hatchbackIndices[dir]}.png`
        : id === 'police_compact' ? `PNG/Police/police_${dir}.png`
          : id === 'taxi' ? `PNG/Taxi/taxi_${dir}.png` : `PNG/Ambulance/ambulance_${dir}.png`;
      assert.equal(entry.source.archiveEntry, expectedSource);
      assert.equal(entry.source.file, `assets/vehicle-source/${expectedSource}`);
      assert.equal(entry.output.file, `assets/sprites/${key}`);
      const originalBytes = fs.readFileSync(path.join(root, entry.source.file));
      const bytes = fs.readFileSync(path.join(root, entry.output.file));
      assert.equal(sha256(originalBytes), entry.source.sha256);
      assert.equal(sha256(bytes), entry.output.sha256);
      hashes.add(sha256(bytes));
      const original = PNG.sync.read(originalBytes), image = PNG.sync.read(bytes);
      assert.equal(image.width, def.spriteW);
      assert.equal(image.height, def.spriteH);
      assert.ok(image.width >= 56 && image.width <= 64);
      assert.equal(original.width, entry.source.width);
      assert.equal(original.height, entry.source.height);
      assert.equal(image.width, entry.output.width);
      assert.equal(image.height, entry.output.height);
      const { scale, scaledWidth, scaledHeight, xOffset, yOffset } = entry.transform;
      assert.equal(scaledWidth, Math.round(original.width * scale));
      assert.equal(scaledHeight, Math.round(original.height * scale));
      assert.ok(xOffset >= 2 && yOffset >= 2);
      let visible = 0;
      for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
        const to = (y * image.width + x) * 4;
        const outside = x < xOffset || x >= xOffset + scaledWidth || y < yOffset || y >= yOffset + scaledHeight;
        if (outside) assert.equal(image.data[to + 3], 0, 'transparent padding');
        else {
          const sx = Math.floor((x - xOffset + 0.5) * original.width / scaledWidth);
          const sy = Math.floor((y - yOffset + 0.5) * original.height / scaledHeight);
          const from = (sy * original.width + sx) * 4;
          assert.deepEqual(image.data.subarray(to, to + 4), original.data.subarray(from, from + 4), 'nearest source pixel');
          if (image.data[to + 3]) visible++;
        }
      }
      assert.ok(visible > image.width * image.height * 0.3, 'non-empty vehicle body');
    }
    assert.equal(hashes.size, 4, 'not duplicated directional placeholders');
  });

  for (const dir of directions) {
    test(`${id} ${dir}: rotated collision, entry, forward/reverse driving and unobstructed exit`, () => {
      const car = createVehicle(10, def, color, 12, 12, dir);
      const player = createPlayer(12, 11.1);
      const ground = vehicleGroundCollider(car);
      const alongX = dir === 'SE' || dir === 'NW';
      assert.equal(ground.type, 'VEHICLE');
      assert.equal(ground.width, alongX ? def.footprintH : def.footprintW);
      assert.equal(ground.height, alongX ? def.footprintW : def.footprintH);
      near(ground.x + ground.width / 2, car.x);
      near(ground.y + ground.height / 2, car.y);
      for (const [dx, dy] of [[0, 0], [ground.width / 2, 0], [-ground.width / 2, 0], [0, ground.height / 2], [0, -ground.height / 2]]) {
        const body = { x: car.x + dx, y: car.y + dy, radius: GAME_CONFIG.PLAYER_RADIUS };
        collision.resolveCircleVsVehicles(body, [car]);
        const overlap = collideCircleAabb(body, ground);
        near(Math.hypot(overlap.pushX, overlap.pushY), 0);
      }
      const ignored = { x: car.x, y: car.y, radius: GAME_CONFIG.PLAYER_RADIUS };
      collision.resolveCircleVsVehicles(ignored, [car], car.id);
      near(ignored.x, car.x); near(ignored.y, car.y);
      assert.equal(interaction.nearestVehicle(player, [car]), car);
      assert.equal(interaction.tryEnter(player, [car]), true);
      assert.equal(player.currentVehicleId, car.id);
      assert.equal(player.state, 'driving');
      assert.equal(car.occupied, true);
      assert.equal(car.state, 'driving');
      const vector = DIR_VECTORS[dir];
      resetVehicleArrows();
      inputState.vehicleAccel = true;
      for (let tick = 0; tick < 8; tick++) movement.updateVehicle(car, emptyWorld, 0.05);
      assert.ok(car.speed > 0);
      assert.ok((car.x - 12) * vector.wx + (car.y - 12) * vector.wy > 0);
      car.speed = 0;
      const start = { x: car.x, y: car.y };
      inputState.vehicleAccel = false;
      inputState.vehicleBrake = true;
      for (let tick = 0; tick < 4; tick++) movement.updateVehicle(car, emptyWorld, 0.05);
      assert.ok(car.speed < 0);
      assert.ok((car.x - start.x) * vector.wx + (car.y - start.y) * vector.wy < 0);
      resetVehicleArrows();
      // Block the first door: the real map/collision lookup must choose the other side.
      const doorX = car.x + Math.cos(car.facingAngle + Math.PI / 2) * 1.2;
      const doorY = car.y + Math.sin(car.facingAngle + Math.PI / 2) * 1.2;
      const wall = { x: doorX - 0.35, y: doorY - 0.35, width: 0.7, height: 0.7, type: 'BUILDING' };
      assert.equal(interaction.tryExit(player, [car], world([wall]), collision), true);
      assert.equal(player.currentVehicleId, null);
      assert.equal(player.state, 'idle');
      assert.equal(car.occupied, false);
      assert.equal(car.state, 'parked');
      assert.equal(car.speed, 0);
      const body = { x: player.x, y: player.y, radius: GAME_CONFIG.PLAYER_RADIUS };
      assert.equal(collision.overlapsAny(body, [wall, vehicleGroundCollider(car)]), false);
    });
  }

  test(`${id}: NPC ao volante nao tranca a porta; destruido e no ar tranca`, () => {
    const car = createVehicle(20, def, color, 12, 12, 'SE');
    const player = createPlayer(12, 12);
    // Assalto: quem está no banco é expulso pelo proprio sistema da viatura/transito, nao por
    // uma porta trancada. Se a porta fechasse, carro de policia seria mobiliario urbano.
    car.occupied = true;
    vehicleSystem.enterVehicle(player, car);
    assert.equal(player.currentVehicleId, car.id);
    assert.equal(player.state, 'driving');
    player.currentVehicleId = null;
    car.occupied = false;
    car.state = 'destroyed';
    vehicleSystem.enterVehicle(player, car);
    assert.equal(player.currentVehicleId, null);
    assert.equal(interaction.nearestVehicle(player, [car]), null);
    car.state = 'driving';
    car.altitude = 2;
    vehicleSystem.enterVehicle(player, car);
    assert.equal(player.currentVehicleId, null, 'aeronave pairando nao se aborda');
  });
}
// ------------------------------------------------------------------ atropelamento

function rolling(id, x, y, speed, dir = 'SE') {
  const v = createVehicle(id, VEHICLE_DEFS.sedan, 'blue', x, y, dir);
  v.state = 'driving';
  v.speed = speed;
  return v;
}

function impactScene(overrides) {
  const drops = [];
  const shakes = [];
  return {
    impact: new VehicleImpactSystem(), drops, shakes,
    ctx: Object.assign({
      map: world(), collision, health: new HealthSystem(), wanted: new WantedSystem(),
      player: createPlayer(24, 24), vehicles: [], npcs: [], animals: [],
      pickups: { spawnDrop: (x, y, amount) => drops.push({ x, y, amount }) },
      time: 5, indoors: false, rng: () => 0.5,
      shake: (amount) => shakes.push(amount), onStructChange: () => {},
    }, overrides),
  };
}

test('atropelamento: o carro do jogador a 2,6 mata o pedestre, deixa dinheiro e sobe o procurado', () => {
  const car = rolling(1, 12, 12, 2.6);
  const npc = createNPC(7, 'a', 12.2, 12);
  const scene = impactScene({ vehicles: [car], npcs: [npc] });
  scene.ctx.player.currentVehicleId = car.id;
  scene.impact.update(0.05, scene.ctx);
  assert.equal(npc.dead, true);
  assert.equal(npc.state, 'dead');
  assert.equal(scene.drops.length, 1);
  assert.ok(audio.some((entry) => entry[0] === 'bodyHit'), 'o baque do corpo tem que ser ouvido');
  assert.ok(scene.ctx.player.wantedLevel >= GAME_CONFIG.WANTED_KILL);
  // Arremesso para fora da pista: sem isso o corpo ficaria sob as rodas apanhando todo frame.
  assert.ok(Math.abs(npc.y - car.y) > 0.6, 'pedestre continua embaixo do carro');
});

test('atropelamento: abaixo de HIT_PED_SPEED o carro apenas encosta', () => {
  const car = rolling(2, 12, 12, GAME_CONFIG.HIT_PED_SPEED - 0.4);
  const npc = createNPC(8, 'a', 12.2, 12);
  const scene = impactScene({ vehicles: [car], npcs: [npc] });
  scene.impact.update(0.05, scene.ctx);
  assert.equal(npc.health, 45);
  assert.equal(npc.x, 12.2);
  assert.equal(scene.drops.length, 0);
});

test('atropelamento: carro dirigido por NPC machuca, mas a culpa não é de quem anda a pé', () => {
  const car = rolling(3, 12, 12, 2.2);
  const npc = createNPC(9, 'a', 12.2, 12);
  const scene = impactScene({ vehicles: [car], npcs: [npc] });
  scene.impact.update(0.05, scene.ctx);
  assert.equal(npc.dead, true);
  assert.equal(scene.ctx.player.wantedLevel, 0);
  assert.equal(scene.drops.length, 0);
});

test('atropelamento: o veículo em curso machuca o jogador a pé e o joga para fora da rua', () => {
  const car = rolling(4, 12, 12, 2.6);
  const player = createPlayer(12.2, 12);
  const scene = impactScene({ vehicles: [car], player });
  scene.impact.update(0.05, scene.ctx);
  assert.ok(player.health < 100);
  assert.ok(Math.abs(player.y - 12) > 0.6);
  assert.ok(scene.shakes.length >= 1);
});

test('atropelamento: dentro de uma sala nenhum carro da rua alcança o jogador', () => {
  const car = rolling(5, 12, 12, 2.6);
  const player = createPlayer(12.2, 12);
  const scene = impactScene({ vehicles: [car], player, indoors: true });
  scene.impact.update(0.05, scene.ctx);
  assert.equal(player.health, 100);
});

test('atropelamento: quem fica preso embaixo da roda apanha aos poucos, não de novo por impacto', () => {
  const car = rolling(6, 12, 12, 2.6);
  const boar = createAnimal(1, 'boar', 12.2, 12);
  const burst = (GAME_CONFIG.RUNOVER_DAMAGE + 2.6 * GAME_CONFIG.RUNOVER_DAMAGE_PER_SPEED) * 1.4;
  const scene = impactScene({ vehicles: [car], animals: [boar] });
  scene.impact.update(0.05, scene.ctx);
  assert.equal(boar.dead, false, 'o javali aguenta o impacto inicial');
  const after = boar.health;
  assert.ok(Math.abs(after - (95 - burst)) < 1e-6, 'dano do impacto fora do previsto');
  boar.x = 12.2; boar.y = 12; // empurrado contra uma parede, ele continua sob o carro
  scene.impact.update(0.05, scene.ctx);
  assert.ok(boar.health < after, 'esmagamento não machucou');
  assert.ok(boar.health > after - burst, 'esmagamento aplicou um impacto inteiro de novo');
  assert.equal(boar.dead, false);
});

console.log(`${passed} vehicle checks passed`);
