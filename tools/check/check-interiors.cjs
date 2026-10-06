const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
execFileSync(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '-p', path.join(__dirname, 'tsconfig.json')], { stdio: 'inherit' });
const compiled = path.join(__dirname, 'dist-test/src');
const load = (file) => require(path.join(compiled, file));
const ui = { paused: false, mapOpen: false, shopOpen: false, departuresOpen: false, overlay: null, mapMarker: null, mapRoute: [] };
for (const [file, exports] of [
  ['audio/SoundManager.js', { sound: { play() {}, ambient() {}, weather() {}, setLoop() {}, stopLoops() {} } }],
  ['assets/AssetRegistry.js', { spriteKeyForVehicle: () => '' }],
  ['stores/useGameStore.js', { useGameStore: { getState: () => ui, clearMapMarker() {}, refreshMapRoute() {},
    showOverlay: (kind) => { ui.overlay = kind; }, openShop: () => { ui.shopOpen = true; }, closeShop: () => { ui.shopOpen = false; },
    openDepartures: () => { ui.departuresOpen = true; }, closeDepartures: () => { ui.departuresOpen = false; } } }],
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
let records = 0;
let shopsOpened = 0;
let boardsOpened = 0;
const owned = new Set(['unarmed', 'bat']);
const ctx = {
  player: p,
  heal: () => { p.health = 100; },
  grantGun: (id) => (owned.has(id) ? false : (owned.add(id), true)),
  refillOwned: () => [...owned].some((id) => id !== 'unarmed' && id !== 'bat'),
  feed: (health, stamina) => { p.health = Math.min(100, p.health + health); p.stamina = Math.min(1, p.stamina + stamina); },
  clearRecord: () => { p.wantedLevel = 0; records++; },
  onTransition: () => transitions++,
  onUse: () => used++,
  onOpenShop: () => shopsOpened++,
  onOpenDepartures: () => boardsOpened++,
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
// A delegacia e a rodoviária também são calçada (ver o bloco próprio de cada uma), então as
// três escapam da regra da fachada — e do espaçamento de 8 tiles, que é uma regra de comércio.
const storefront = (e) => e.kind !== 'jail' && e.kind !== 'precinct' && e.kind !== 'terminal';
for (const e of interiors.entrances.filter(storefront)) {
  assert.ok(clearAt(world, e.x, e.y), `blocked entrance ${e.id}`);
  const b = world.data.buildings[e.id];
  assert.ok(b, `entrada ${e.id} sem prédio`);
  const faceB = b.key.endsWith('_b');
  assert.ok(Math.abs((faceB ? e.x - b.x : e.y - b.y) - 0.24) < 1e-7, 'door not on front facade');
  assert.ok(Math.hypot(e.x - b.x, e.y - b.y) < b.footprintW + 0.3);
  assert.ok(!/warehouse|fruitstand|autoshop/.test(b.key), 'unsupported establishment has a generic interior');
  assert.equal(e.service === 'ammo', b.key.includes('gunshop'));
  for (const other of interiors.entrances.filter(storefront)) if (other !== e) assert.ok(Math.hypot(e.x - other.x, e.y - other.y) >= 8);
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
// --------------------------------------------------- delegacia aberta a qualquer hora
// O pedido foi este: a porta da esquadra não pode aparecer só quando o jogador é preso.
// Toda esquadra tem a sua, na calçada, e o balcão cobra fiança pelas estrelas do registro.
const stations = world.landmarksOf('police');
assert.ok(stations.length >= 2, 'a cidade tem mais de uma esquadra');
const precincts = interiors.entrances.filter((e) => e.kind === 'precinct');
assert.equal(precincts.length, stations.length - 1, 'cada esquadra tem porta, menos a que é presídio');
for (const e of precincts) {
  assert.equal(e.label, 'Delegacia');
  assert.equal(e.service, 'bail');
  assert.equal(e.counter, null, 'a delegacia não vende nada');
  assert.ok(clearAt(world, e.x, e.y), 'porta da delegacia bloqueada');
  assert.ok(stations.some((s) => Math.hypot(s.front.x - e.x, s.front.y - e.y) < 3), 'porta longe da esquadra');
  for (const other of interiors.entrances) if (other !== e) {
    assert.ok(Math.hypot(e.x - other.x, e.y - other.y) >= 2.5, 'duas portas no mesmo endereço');
  }
  p.x = e.x - Math.cos(e.facing) * 0.6; p.y = e.y - Math.sin(e.facing) * 0.6;
  assert.equal(interiors.nearest(p), null, 'não se entra pelas costas da porta da delegacia');
  p.x = e.x; p.y = e.y;
  assert.equal(interiors.nearest(p), e, 'a calçada da esquadra abre a delegacia');
}
{
  const door = precincts[0];
  Object.assign(p, { currentVehicleId: null, swimming: false, health: 100, money: 500, wantedLevel: 0 });
  p.x = door.x; p.y = door.y;
  assert.ok(interiors.interact(ctx), 'a delegacia abre sem estar preso');
  const hall = interiors.active;
  assert.equal(hall.kind, 'precinct');
  assert.equal(hall.shop, null);
  assert.ok(hall.furniture.length >= 5, 'a delegacia é mobiliada');
  assert.ok(hall.furniture.some((f) => f.kind === 'counter'), 'tem balcão de atendimento');
  assert.ok(clearAt(hall.map, p.x, p.y), 'você não nasce dentro de um móvel da delegacia');
  assert.ok(reachable(hall.map, p, hall.service), 'balcão da delegacia inacessível');
  assert.ok(reachable(hall.map, p, hall.exit), 'saída da delegacia inacessível');
  interiors.update(0.6);
  p.x = hall.service.x; p.y = hall.service.y;
  assert.ok(interiors.interact(ctx));
  assert.equal(p.money, 500, 'sem registro o balcão não cobra');
  assert.equal(interiors.message, 'Você não está procurado');
  p.wantedLevel = 2;
  interiors.update(2.5);
  assert.ok(interiors.interact(ctx));
  assert.equal(records, 1, 'a fiança limpa o registro no WantedSystem');
  assert.equal(p.wantedLevel, 0);
  assert.equal(p.money, 500 - 2 * hall.service.cost, 'a fiança cobra por estrela');
  assert.equal(interiors.message, 'Fiança paga');
  p.wantedLevel = 3; p.money = 100;
  interiors.update(2.5);
  assert.ok(interiors.interact(ctx));
  assert.equal(p.wantedLevel, 3, 'sem dinheiro o balcão não solta ninguém');
  assert.equal(p.money, 100);
  assert.equal(interiors.message, 'Dinheiro insuficiente');
  // O recado mostra o preço das estrelas que o jogador tem agora, não um valor fixo.
  p.wantedLevel = 4; p.money = 500;
  interiors.update(2.5);
  assert.equal(interiors.prompt(p), `Pagar fiança · $${4 * hall.service.cost}`);
  interiors.update(2.5);
  p.x = hall.exit.x; p.y = hall.exit.y;
  assert.ok(interiors.interact(ctx));
  assert.equal(interiors.active, null);
  assert.equal(p.x, door.x); assert.equal(p.y, door.y);
  interiors.update(0.6);
}
// ---------------------------------------------------------------------- rodoviária
// A rodoviária é o mesmo caso da delegacia: a porta está na calçada porque o prédio está lá,
// não porque o jogador precisa de um menu. Quem entra encontra um hall com telão, e o telão
// planeja viagem — não teleporta (ver check-transport para a malha e os horários).
const busStations = world.landmarksOf('busstation');
assert.ok(busStations.length >= 1, 'a cidade tem rodoviária');
const terminals = interiors.entrances.filter((e) => e.kind === 'terminal');
assert.equal(terminals.length, busStations.length, 'cada rodoviária tem porta de hall');
for (const e of terminals) {
  assert.equal(e.label, 'Rodoviária');
  assert.equal(e.service, 'departures');
  assert.equal(e.counter === null, true, 'o hall da rodoviária não vende nada no balcão');
  assert.ok(clearAt(world, e.x, e.y), 'porta da rodoviária bloqueada');
  assert.ok(busStations.some((s) => Math.hypot(s.front.x - e.x, s.front.y - e.y) < 3), 'porta longe da rodoviária');
  for (const other of interiors.entrances) if (other !== e) {
    assert.ok(Math.hypot(e.x - other.x, e.y - other.y) >= 2.5, 'duas portas no mesmo endereço');
  }
  p.x = e.x - Math.cos(e.facing) * 0.6; p.y = e.y - Math.sin(e.facing) * 0.6;
  assert.equal(interiors.nearest(p), null, 'não se entra pelas costas da porta da rodoviária');
  p.x = e.x; p.y = e.y;
  assert.equal(interiors.nearest(p), e, 'a calçada da rodoviária abre o hall');
}
{
  const door = terminals[0];
  Object.assign(p, { currentVehicleId: null, swimming: false, health: 100, money: 500 });
  p.x = door.x; p.y = door.y;
  assert.ok(interiors.interact(ctx), 'o hall abre a pé, na calçada');
  const hall = interiors.active;
  assert.equal(hall.kind, 'terminal');
  assert.equal(hall.shop, null, 'o telão não é uma loja');
  assert.ok(hall.furniture.length >= 5, 'o hall é mobiliado');
  assert.ok(hall.furniture.some((f) => f.kind === 'shelf'), 'o telão ocupa a parede do fundo');
  assert.ok(hall.furniture.some((f) => f.kind === 'counter'), 'tem bilheteria');
  assert.ok(hall.furniture.some((f) => f.kind === 'sofa'), 'tem banco de espera');
  assert.ok(clearAt(hall.map, p.x, p.y), 'você não nasce dentro de um móvel do hall');
  assert.ok(reachable(hall.map, p, hall.service), 'telão da rodoviária inacessível');
  assert.ok(reachable(hall.map, p, hall.exit), 'saída do hall inacessível');
  assert.equal(hall.service.label, 'Painel de partidas');
  assert.equal(hall.service.cost, 0, 'consultar o telão é grátis');
  interiors.update(0.6);
  p.x = hall.service.x; p.y = hall.service.y;
  assert.equal(interiors.prompt(p), 'Painel de partidas');
  const opened = boardsOpened;
  assert.ok(interiors.interact(ctx));
  assert.equal(boardsOpened, opened + 1, 'o telão abre o itinerário em vez de vender um trecho');
  assert.equal(p.money, 500, 'o telão não cobra nada antes da viagem');
  assert.equal(interiors.interact(ctx), false, 'o telão não reabre no mesmo toque');
  interiors.update(0.6);
  p.x = hall.exit.x; p.y = hall.exit.y;
  assert.ok(interiors.interact(ctx));
  assert.equal(interiors.active, null);
  assert.equal(p.x, door.x); assert.equal(p.y, door.y);
  interiors.update(0.6);
}
console.log(`OK rodoviária: ${terminals.length} hall${terminals.length === 1 ? '' : 's'} na calçada, telão de partidas grátis e sem teleporte`);
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
p.facingAngle = food.facing;
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
// A âncora devolve a orientação com que o jogador pediu a porta, não a do batente: quem
// entra de costas para a calçada sai de costas. Antes isto só passava por coincidência —
// a orientação do teste vinha em cadeia da última sala fechada, e um mapa novo trocava o
// azar de passar ou não.
p.facingAngle = food.facing + Math.PI;
p.x = food.x; p.y = food.y;
assert.ok(interiors.interact(ctx));
interiors.leave(p); interiors.update(0.6);
assert.equal(p.facingAngle, food.facing + Math.PI, 'sair devolve a orientação de quem entrou');
assert.equal(p.x, food.x); assert.equal(p.y, food.y);
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
// O telão é uma tela de menu: enquanto ele está na frente, a rua não anda — a mesma
// regra da loja, senão o ônibus partia enquanto o jogador escolhia o destino.
ui.departuresOpen = true;
const timeBoards = g.time;
g.update(0.5);
assert.equal(g.time, timeBoards, 'o telão aberto não deixa o mundo andar');
ui.departuresOpen = false;
// Do lado de fora do hall não existe telão: as três entradas da viagem têm de recusar
// em vez de inventar uma plataforma longe da rodoviária.
assert.equal(g.departureRows().length, 0, 'fora do hall não há partidas');
// A linha do telão é o ônibus do plano: do lado de fora do hall não há calçada nenhuma, e
// tocar numa partida, com placa e passada na mão, tem de recusar em vez de inventar uma.
assert.equal(g.chooseDeparture(0, 1), false, 'sem hall não há viagem para planejar');
assert.equal(g.journeyStatus(), null, 'sem telão não há viagem em andamento');
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

// --- A sala é um plano à parte, não um lugar do mapa -------------------------
// O pedido do jogador, escrito em asserção: dentro de um interior as coordenadas da sala
// não existem na cidade. A rua vê a âncora da porta, o save grava a rua, sair devolve ao
// pé da porta por onde se entrou, e o chão do jogador vem do plano dele — nunca do relevo.
{
  // O round anterior fechou com overlay aberto: sem tela limpa o update não roda.
  Object.assign(ui, { paused: false, mapOpen: false, shopOpen: false, departuresOpen: false, overlay: null });
  const door = g.interiors.entrances.find((e) => e.kind === 'home') ?? g.interiors.entrances[0];
  // Meio tile do lado de fora do vão, de propósito: a volta tem que ser este ponto exato,
  // não o centro do lote nem a coordenada da porta.
  const desde = { x: door.x + Math.cos(door.facing) * 0.4, y: door.y + Math.sin(door.facing) * 0.4 };
  Object.assign(g.player, { health: 100, currentVehicleId: null, swimming: false });
  g.player.x = desde.x; g.player.y = desde.y;
  g.interiors.update(0.6);
  input.inputState.interactQueued = true;
  g.update(1 / 60);
  const room = g.interiors.active;
  assert.ok(room, 'a porta abriu');
  assert.ok(Math.hypot(g.player.x - desde.x, g.player.y - desde.y) > 0.5, 'o jogador foi para o plano da sala');
  assert.ok(Math.hypot(g.worldPosition.x - desde.x, g.worldPosition.y - desde.y) < 1e-9,
    'a rua enxerga a âncora, jamais a coordenada de dentro');
  assert.notEqual(g.worldPosition, g.player, 'worldPosition é o pé da porta, não o corpo na sala');

  // O plano é autossuficiente: tamanho próprio, chão liso e nada do mundo lá dentro.
  assert.ok(room.map.worldW >= 7 && room.map.worldH >= 5, 'a sala tem dimensão própria');
  assert.ok(Array.from(room.map.data.heights).every((h) => h === 0), 'o piso da sala é liso por construção');
  assert.equal(room.map.data.buildings.length, 0, 'nenhum prédio da cidade mora dentro da sala');
  assert.equal(room.map.data.vehicles.length, 0, 'nenhum carro da cidade mora dentro da sala');

  // O chão que o sprite usa é o da sala. A cidade, naquele mesmo par de números, tem
  // relevo — e era justamente isso que levantava o jogador dentro de casa antes de o
  // render passar a ler o mapa ativo.
  const cidade = g.map.heightAt(g.player.x, g.player.y);
  // A sala é um Map de verdade, e a malha de cantos que desenha o relevo é resolvida no
  // construtor: mexer em `data.heights` por fora não mudaria a cota lida. O que prova o
  // contrato é um plano da sala com ladeira, construído pela mesma via do jogo.
  const salaComCota = (nivel) => new WorldMap({
    ...room.map.data,
    heights: Float32Array.from(room.map.data.heights, () => nivel),
  });
  const planoOriginal = room.map;
  room.map = salaComCota(2);
  assert.equal(g.playerGround(), 2, 'o chão do jogador vem do plano da sala');
  room.map = planoOriginal;
  assert.equal(g.playerGround(), 0, 'a sala é lisa: quem está dentro pisa o piso dela');
  if (cidade > 0) assert.notEqual(g.playerGround(), cidade, `o relevo da cidade (${cidade.toFixed(2)} tiles) não alcança ninguém lá dentro`);

  // O save feito de dentro grava a rua. Carregar a sala não devolve o jogador ao mapa
  // com coordenadas de cômodo — que é exatamente o bug que este bloco barra.
  const save = g.snapshot();
  assert.ok(Math.hypot(save.player.x - desde.x, save.player.y - desde.y) < 1e-9,
    'o snapshot grava a âncora na porta, não a sala');
  const reloaded = new GameState();
  reloaded.applySave(save);
  assert.equal(reloaded.interiors.active, null, 'o load abre na rua');
  assert.ok(Math.hypot(reloaded.player.x - desde.x, reloaded.player.y - desde.y) < 1e-9,
    'o load devolve o jogador ao pé da porta');

  // Sair pela porta de dentro: volta para onde entrou, de frente para a rua.
  g.player.x = room.exit.x; g.player.y = room.exit.y;
  g.interiors.update(0.6);
  input.inputState.interactQueued = true;
  g.update(1 / 60);
  assert.equal(g.interiors.active, null, 'a sala fechou');
  assert.equal(g.interiors.street, null, 'sem sala, sem âncora');
  assert.ok(Math.hypot(g.player.x - desde.x, g.player.y - desde.y) < 1e-9,
    'sair devolve ao ponto exato da calçada por onde se entrou');
  assert.equal(g.worldPosition, g.player, 'na rua, o mundo vê o próprio corpo');
  assert.equal(g.activeMap, g.map, 'e o mapa ativo volta a ser a cidade');
  g.interiors.update(0.6);
}
// Quem é algemado na rua não volta para o beco onde caiu: sai pela porta de quem prendeu.
{
  const jailDoor = g.interiors.jailEntrance;
  if (jailDoor) {
    Object.assign(g.player, { health: 100, currentVehicleId: null, swimming: false });
    g.player.x = jailDoor.x + 9; g.player.y = jailDoor.y + 9;
    g.interiors.open(jailDoor, g.player);
    assert.ok(Math.hypot(g.interiors.street.x - jailDoor.x, g.interiors.street.y - jailDoor.y) < 1e-9,
      'preso entra pela porta e por ela volta, não pelo ponto da captura');
    g.interiors.leave(g.player);
    g.interiors.update(0.6);
  }
}
console.log('OK interior é plano à parte: âncora na rua, save na calçada, saída no ponto de entrada, chão da sala');

// --------------------------------------------------- a porta nunca abre para a encosta
// Sair de uma sala devolve o jogador ao pé da fachada. Se o tile seguinte estiver mais
// alto que o passo, ele saiu da loja para ficar preso no morro — era exatamente o que o
// relevo fazia com as casas do campo, que ficam em bioma natural e portanto fora da
// planície urbana. Da porta tem de dar para andar o mundo inteiro.
function walkableFrom(world, from, limit = 40000) {
  const key = (x, y) => `${x},${y}`;
  const start = [Math.floor(from.x), Math.floor(from.y)];
  const seen = new Set([key(...start)]);
  const queue = [start];
  for (let i = 0; i < queue.length && seen.size < limit; i++) {
    const [x, y] = queue[i];
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy, id = key(nx, ny);
      if (seen.has(id) || nx < 0 || ny < 0 || nx >= world.data.tilesW || ny >= world.data.tilesH) continue;
      if (!clearAt(world, nx + 0.5, ny + 0.5)) continue;
      if (!world.canClimb(x + 0.5, y + 0.5, nx + 0.5, ny + 0.5)) continue;
      seen.add(id); queue.push([nx, ny]);
    }
  }
  return seen.size;
}
const step = GAME_CONFIG.TERRAIN_STEP_UP_TILES;
for (const e of interiors.entrances) {
  const sole = world.heightAt(e.x, e.y);
  for (const [dx, dy] of [[0.9, 0], [-0.9, 0], [0, 0.9], [0, -0.9]]) {
    const d = Math.abs(world.heightAt(e.x + dx, e.y + dy) - sole);
    assert.ok(d < step, `porta ${e.id} (${e.label}) abre para um degrau de ${d.toFixed(2)} tiles`);
  }
  const alcance = walkableFrom(world, e);
  assert.ok(alcance > 2000, `porta ${e.id} (${e.label}) não leva a lugar nenhum: só ${alcance} tiles andáveis`);
}
console.log(`OK relevo nunca tranca uma porta: soleira nivelada e ${world.data.tilesW}x${world.data.tilesH} andáveis a partir de cada uma das ${interiors.entrances.length} portas`);
