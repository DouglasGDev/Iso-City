const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
execFileSync(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '-p', path.join(__dirname, 'tsconfig.json')], { stdio: 'inherit' });
const compiled = path.join(__dirname, 'dist-test/src');
const load = (file) => require(path.join(compiled, file));
const ui = { paused: false, mapOpen: false, shopOpen: false, overlay: null, mapMarker: null, mapRoute: [] };
for (const [file, exports] of [
  ['audio/SoundManager.js', { sound: { play() {}, ambient() {}, weather() {}, setLoop() {}, stopLoops() {} } }],
  ['assets/AssetRegistry.js', { spriteKeyForVehicle: () => '' }],
  ['stores/useGameStore.js', { useGameStore: { getState: () => ui, clearMapMarker() {}, refreshMapRoute() {},
    showOverlay: (kind) => { ui.overlay = kind; }, openShop: () => { ui.shopOpen = true; }, closeShop: () => { ui.shopOpen = false; } } }],
]) {
  const filename = path.join(compiled, file);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}
const { Map: WorldMap } = load('world/Map.js');
const { generateCity } = load('data/maps/city.js');
const { InteriorSystem } = load('systems/InteriorSystem.js');
const { createPlayer } = load('entities/Player.js');
const { GameState } = load('game/GameState.js');
const input = load('game/InputState.js');
const world = new WorldMap(generateCity());
const interiors = new InteriorSystem(world);
const p = createPlayer(0, 0);
let transitions = 0;
let used = 0;
let shopsOpened = 0;
const owned = new Set(['unarmed', 'bat']);
const ctx = {
  player: p,
  heal: () => { p.health = 100; },
  grantGun: (id) => (owned.has(id) ? false : (owned.add(id), true)),
  refillOwned: () => [...owned].some((id) => id !== 'unarmed' && id !== 'bat'),
  feed: (health, stamina) => { p.health = Math.min(100, p.health + health); p.stamina = Math.min(1, p.stamina + stamina); },
  onTransition: () => transitions++,
  onUse: () => used++,
  onOpenShop: () => shopsOpened++,
};
function clearAt(map, x, y) {
  return !map.queryNearby(x, y, 0.5).some((c) => x > c.x - 0.17 && x < c.x + c.width + 0.17 && y > c.y - 0.17 && y < c.y + c.height + 0.17);
}
function reachable(map, from, goal) {
  const step = 0.25;
  const start = [Math.round(from.x / step), Math.round(from.y / step)];
  const queue = [start];
  const seen = new Set([start.join(',')]);
  for (let i = 0; i < queue.length; i++) {
    const [x, y] = queue[i];
    if (Math.hypot(x * step - goal.x, y * step - goal.y) < 0.5) return true;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx; const ny = y + dy; const key = `${nx},${ny}`;
      if (seen.has(key) || nx < 0 || ny < 0 || nx * step > map.worldW || ny * step > map.worldH) continue;
      if (!clearAt(map, nx * step, ny * step)) continue;
      seen.add(key); queue.push([nx, ny]);
    }
  }
  return false;
}
const entranceDensity = interiors.entrances.length / (world.worldW * world.worldH);
assert.ok(entranceDensity > 10 / (160 * 160) && entranceDensity < 100 / (160 * 160), `entrance density: ${entranceDensity}`);
assert.equal(new Set(interiors.entrances.map((e) => `${e.x},${e.y}`)).size, interiors.entrances.length);
// A porta da cadeia é a calçada da esquadra, não a fachada de uma loja: ver check-jail.
for (const e of interiors.entrances.filter((e) => e.kind !== 'jail')) {
  assert.ok(clearAt(world, e.x, e.y), `blocked entrance ${e.id}`);
  const b = world.data.buildings[e.id];
  assert.ok(b, `entrada ${e.id} sem prédio`);
  const faceB = b.key.endsWith('_b');
  assert.ok(Math.abs((faceB ? e.x - b.x : e.y - b.y) - 0.24) < 1e-7, 'door not on front facade');
  assert.ok(Math.hypot(e.x - b.x, e.y - b.y) < b.footprintW + 0.3);
  assert.ok(!/warehouse|fruitstand|autoshop/.test(b.key), 'unsupported establishment has a generic interior');
  assert.equal(e.service === 'ammo', b.key.includes('gunshop'));
  for (const other of interiors.entrances) if (other !== e) assert.ok(Math.hypot(e.x - other.x, e.y - other.y) >= 8);
  p.x = e.x - Math.cos(e.facing) * 0.6; p.y = e.y - Math.sin(e.facing) * 0.6;
  assert.equal(interiors.nearest(p), null, 'cannot enter through the back of the facade');
}
for (const kind of ['home', 'shop', 'office']) {
  const e = interiors.entrances.find((e) => e.kind === kind);
  assert.ok(e, kind);
  p.x = e.x; p.y = e.y; p.health = 60; p.money = 500;
  assert.ok(interiors.interact(ctx));
  const room = interiors.active;
  assert.equal(room.kind, kind);
  assert.ok(room.furniture.length >= 5);
  assert.ok(clearAt(room.map, p.x, p.y));
  assert.ok(reachable(room.map, p, room.service), `unreachable ${kind} service`);
  assert.ok(reachable(room.map, p, room.exit), `unreachable ${kind} exit`);
  for (const f of room.furniture) assert.ok(!clearAt(room.map, f.x + f.w / 2, f.y + f.d / 2));
  assert.equal(interiors.interact(ctx), false, 'entry debounce');
  interiors.update(0.6);
  p.x = room.service.x; p.y = room.service.y;
  const opened = shopsOpened;
  assert.ok(interiors.interact(ctx));
  if (room.shop) {
    assert.equal(shopsOpened, opened + 1, 'o balcão abre o estoque em vez de vender um item só');
    assert.equal(p.money, 500, 'abrir a loja não cobra nada');
    assert.ok(room.shop.items.length >= 3, `${room.shop.title} tem estoque`);
    assert.ok(room.shop.items.every((i) => i.price > 0), 'todo item tem preço');
  } else {
    assert.equal(p.money, 500 - room.service.cost);
    assert.equal(p.health, 100);
    interiors.update(0.6);
    p.money = 0; p.health = 50;
    interiors.interact(ctx);
    assert.equal(p.health, 50);
    assert.equal(p.money, 0);
    assert.equal(interiors.message, 'Dinheiro insuficiente');
  }
  interiors.update(0.6);
  p.x = room.exit.x; p.y = room.exit.y;
  assert.ok(interiors.interact(ctx));
  assert.equal(interiors.active, null);
  assert.equal(p.x, e.x); assert.equal(p.y, e.y);
  interiors.update(0.6);
}
assert.equal(transitions, 6);
// Armaria: comprar arma, não comprar de novo, e munição só para quem já tem fogo.
owned.clear(); owned.add('unarmed'); owned.add('bat');
const armaria = interiors.entrances.find((e) => e.counter === 'armaria');
assert.ok(armaria, 'armaria acessível');
p.x = armaria.x; p.y = armaria.y; p.health = 100; p.money = 500;
assert.ok(interiors.interact(ctx));
const gunStore = interiors.active;
assert.equal(gunStore.shop.title, 'Armaria');
assert.ok(gunStore.furniture.some((f) => f.kind === 'rack'), 'as armas ficam num armário de parede');
interiors.update(0.6);
p.x = gunStore.service.x; p.y = gunStore.service.y;
assert.ok(interiors.interact(ctx));
const ammo = gunStore.shop.items.find((i) => i.kind === 'ammo');
assert.equal(interiors.buy(ammo.id, ctx), false, 'sem arma de fogo não há o que abastecer');
assert.equal(interiors.message, 'Nenhuma arma para abastecer');
assert.equal(p.money, 500);
const rifle = gunStore.shop.items.find((i) => i.gun === 'rifle');
p.money = 1000;
assert.equal(interiors.buy(rifle.id, ctx), false, 'dinheiro não chega');
assert.equal(interiors.message, 'Dinheiro insuficiente');
assert.equal(owned.has('rifle'), false, 'não se entrega arma de graça');
p.money = 500;
const pistol = gunStore.shop.items.find((i) => i.gun === 'pistol');
assert.equal(interiors.buy(pistol.id, ctx), true);
assert.equal(p.money, 500 - pistol.price);
assert.equal(owned.has('pistol'), true);
assert.equal(interiors.message, 'Pistola comprada');
p.money = 500;
assert.equal(interiors.buy(pistol.id, ctx), false, 'arma repetida não sai duas vezes');
assert.equal(interiors.message, 'Você já tem essa arma');
assert.equal(p.money, 500);
assert.equal(interiors.buy(ammo.id, ctx), true, 'com uma arma no bolso a caixa vale');
interiors.leave(p); interiors.update(0.6);
// Restaurante: cardápio de verdade, prato devolve vida e fôlego.
const food = interiors.entrances.find((e) => e.service === 'food');
assert.ok(food, 'accessible food establishment');
p.x = food.x; p.y = food.y; p.health = 50; p.money = 100; p.stamina = 0.2;
assert.ok(interiors.interact(ctx));
const restaurant = interiors.active;
assert.ok(restaurant.furniture.some((f) => f.id === 'seat-a'));
assert.ok(reachable(restaurant.map, p, restaurant.service));
assert.ok(reachable(restaurant.map, p, restaurant.exit));
interiors.update(0.6);
p.x = restaurant.service.x; p.y = restaurant.service.y;
assert.ok(interiors.interact(ctx));
assert.ok(restaurant.shop.items.every((i) => i.kind === 'meal'), 'restaurante não vende arma nem munição');
const dish = restaurant.shop.items[0];
assert.equal(interiors.buy(dish.id, ctx), true);
assert.equal(p.money, 100 - dish.price);
assert.equal(p.health, 50 + dish.health);
assert.equal(p.stamina, Math.min(1, 0.2 + dish.stamina));
assert.equal(interiors.message, 'Bom apetite');
p.health = 100; p.stamina = 1;
assert.equal(interiors.buy(dish.id, ctx), false, 'sem fome não se vende prato');
assert.equal(interiors.message, 'Sem fome');
interiors.leave(p); interiors.update(0.6);
assert.equal(p.facingAngle, food.facing);
p.x = interiors.entrances[0].x; p.y = interiors.entrances[0].y;
for (const patch of [{ currentVehicleId: 0 }, { swimming: true }, { health: 0 }]) {
  Object.assign(p, { currentVehicleId: null, swimming: false, health: 100 }, patch);
  assert.equal(interiors.interact(ctx), false);
}
assert.equal(interiors.buy('gun-pistol', ctx), false, 'fora da loja não há balcão');
// Toda planta tem de abrir caminho do ponto onde o jogador aparece até o balcão e
// até a porta. A pizzaria nasceu com o box exatamente em cima do spawn: entrava-se
// e ficava-se preso dentro do próprio móvel, e só uma quadra com pizza na frente
// revelava isso — que é o caso de hoje, com o comércio espalhado por mais distritos.
const layouts = new Map();
for (const e of interiors.entrances) {
  if (e.kind === 'jail') continue;
  const id = `${e.kind}:${e.counter ?? e.service}`;
  if (!layouts.has(id)) layouts.set(id, e);
}
Object.assign(p, { currentVehicleId: null, swimming: false, health: 100, money: 500 });
for (const [id, entrance] of layouts) {
  p.x = entrance.x; p.y = entrance.y;
  assert.ok(interiors.interact(ctx), `planta ${id} não abre`);
  const room = interiors.active;
  assert.ok(clearAt(room.map, p.x, p.y), `planta ${id}: você nasce dentro de um móvel`);
  assert.ok(reachable(room.map, p, room.service), `planta ${id}: balcão inacessível`);
  assert.ok(reachable(room.map, p, room.exit), `planta ${id}: porta inacessível`);
  interiors.leave(p); interiors.update(0.6);
}
console.log(`OK ${layouts.size} plantas de sala com spawn livre, balcão e porta alcançáveis`);
console.log(`OK ${interiors.entrances.length} safe entrances, furnished layouts, armaria e cardápio com preço, posse e fome`);
const g = new GameState();
g.police.update = () => {};
g.trafficSystem.update = () => {};
g.npcSystem.update = () => {};
g.npcs = []; g.vehicles = [];
const e = g.interiors.entrances[0];
g.player.x = e.x; g.player.y = e.y;
g.weapons.acquire('pistol');
g.weapons.equipped = 'pistol';
g.weapons.ammo.pistol.loaded = 3;
g.weapons.reload();
input.setAttackHeld(true); input.inputState.interactQueued = true;
g.update(1 / 60);
assert.ok(g.interiors.active);
assert.equal(g.weapons.reloadLeft, 0);
assert.equal(g.weapons.ammo.pistol.loaded, 3);
assert.equal(input.inputState.attackHeld, false);
assert.equal(g.activeMap, g.interiors.active.map);
ui.paused = true;
const time = g.time;
g.update(0.5);
assert.equal(g.time, time);
ui.paused = false;
g.missions.state.phase = 'toDeliver';
g.missions.state.timeLeft = 1;
g.missions.state.target = { x: g.player.x, y: g.player.y };
g.missions.state.deliver = { ...g.missions.state.target };
const money = g.player.money;
for (let i = 0; i < 70; i++) g.update(1 / 60);
assert.equal(g.missions.state.phase, 'break');
assert.equal(g.player.money, money, 'no exterior delivery from room coordinates');
g.finishRound('wasted', 100, 'hospital');
assert.equal(g.interiors.active, null);
assert.equal(g.activeMap, g.map);
console.log('OK GameState interior entry clears firing/reload, pause freezes, mission timer continues, respawn returns outdoors');
const { PNG } = require('pngjs');
for (const dir of ['NE', 'NW', 'SE', 'SW']) {
  for (const anim of ['idle', 'walk']) {
    for (let frame = 1; frame <= (anim === 'idle' ? 1 : 4); frame++) {
      const file = path.join(root, `assets/sprites/Characters/char_police_${anim}_${dir}_f0${frame}.png`);
      const image = PNG.sync.read(fs.readFileSync(file));
      assert.equal(image.width, 24); assert.equal(image.height, 32);
      const base = fs.readFileSync(file.replace('char_police', 'char_a'));
      assert.notDeepEqual(fs.readFileSync(file), base);
    }
  }
}
console.log('OK police uniform sprites distinct from civilians in all walking/idle directions');

// --- Camera framing inside a room -------------------------------------------
const { clampToRoom, indoorZoom } = load('world/Camera.js');
const { GAME_CONFIG } = load('game/GameConfig.js');
const RW = 7, RH = 5;
const cam = (x, y, zoom) => ({ x, y, targetX: x, targetY: y, zoom });
// Phones keep the fixed close-up; big screens pull in until the room fills them.
assert.equal(indoorZoom(RW, RH, 844, 390), GAME_CONFIG.ZOOM_INDOORS);
assert.equal(indoorZoom(RW, RH, 1920, 1080), 2.6);
assert.ok(indoorZoom(RW, RH, 1200, 800) > GAME_CONFIG.ZOOM_INDOORS);
// Standing in the back corner must not push the far walls off the top of the screen.
const back = cam(0.1, 0.1, 1.8);
clampToRoom(back, RW, RH, 844, 390);
assert.ok(back.x + back.y >= 390 / (2 * 1.8 * 32) - 1e-9, 'back walls stay on screen');
// Same at the doorway: the low front ledges must remain visible.
const front = cam(RW + 2, RH + 2, 1.8);
clampToRoom(front, RW, RH, 844, 390);
assert.ok(front.x + front.y <= RW + RH - 390 / (2 * 1.8 * 32) + 1e-9, 'front sill stays on screen');
assert.ok(front.x <= RW && front.y <= RH, 'camera never leaves the room');
// A viewport wider than the room has no valid range: centre it instead of drifting.
const huge = cam(0, 0, indoorZoom(RW, RH, 4000, 2000));
clampToRoom(huge, RW, RH, 4000, 2000);
assert.equal(huge.x, RW / 2);
assert.equal(huge.y, RH / 2);
console.log('OK indoor camera clamps to the room on every edge and centres on oversized viewports');
