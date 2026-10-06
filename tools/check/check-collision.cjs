const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
require.extensions['.png'] = (module, file) => { module.exports = file; };
require.extensions['.ts'] = (module, file) => module._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText, file);
const { CollisionSystem, collideCircleAabb, streetBodyCollider, vehicleGroundCollider } = require('../../src/systems/CollisionSystem.ts');
const { createVehicle } = require('../../src/entities/Vehicle.ts');
const { VEHICLE_DEFS } = require('../../src/data/vehicles.ts');
const { RAIO_DO_ONIBUS, MEIA_LARGURA } = require('../../src/data/transport/network.ts');
const { Map: WorldMap } = require('../../src/world/Map.ts');
const { generateCity } = require('../../src/data/maps/city.ts');
const collision = new CollisionSystem();
const box = { x: 0, y: 0, width: 4, height: 4, type: 'BUILDING' };
for (const [x, y] of [[2, 2], [0.1, 2], [3.9, 2], [2, 0.1], [2, 3.9]]) {
  const c = { x, y, radius: 0.15 };
  const push = collideCircleAabb(c, box);
  c.x += push.pushX; c.y += push.pushY;
  assert.ok(c.x <= -0.1499 || c.x >= 4.1499 || c.y <= -0.1499 || c.y >= 4.1499);
}
console.log('OK AABB interior correction reaches the nearest wall plus radius');
for (const dir of ['NE', 'SE', 'SW', 'NW']) {
  const v = createVehicle(0, VEHICLE_DEFS.bus_school, '', 5, 5, dir);
  const ground = vehicleGroundCollider(v);
  assert.equal(ground.width, dir === 'SE' || dir === 'NW' ? 1.25 : 0.85);
  for (const [x, y] of [[5, 5], [5.4, 5], [5, 5.4], [4.6, 5], [5, 4.6]]) {
    const c = { x, y, radius: 0.15 };
    collision.resolveCircleVsVehicles(c, [v]);
    const overlap = collideCircleAabb(c, ground);
    assert.ok(Math.hypot(overlap.pushX, overlap.pushY) < 1e-8);
  }
  const c = { x: 5, y: 5, radius: 0.15 };
  collision.resolveCircleVsVehicles(c, [v], v.id);
  assert.deepEqual(c, { x: 5, y: 5, radius: 0.15 });
}
console.log('OK all four vehicle headings block both sides and the center');
// O corpo do horário. Um ônibus da malha não é `Vehicle` — não tem `def`, motorista nem banco —,
// mas ele ocupa a faixa, e até aqui quem andava a pé atravessava a lataria como se ela fosse de
// fumaça. A caixa é a mesma régua que o trânsito já usa: `meio` no eixo comprido, `flanco` no
// curto, trocados de lado conforme o rumo, exatamente como o `footprint` do carro.
const busao = (dir) => ({
  x: 5, y: 5, dir, angle: 0, speed: 0, radius: RAIO_DO_ONIBUS,
  meio: RAIO_DO_ONIBUS, flanco: MEIA_LARGURA, live: true,
});
for (const dir of ['NE', 'SE', 'SW', 'NW']) {
  const onibus = busao(dir);
  const caixa = streetBodyCollider(onibus);
  const noComprido = dir === 'SE' || dir === 'NW';
  assert.equal(caixa.width, noComprido ? RAIO_DO_ONIBUS * 2 : MEIA_LARGURA * 2);
  assert.equal(caixa.height, noComprido ? MEIA_LARGURA * 2 : RAIO_DO_ONIBUS * 2);
  // Encostado nos quatro lados e em cima do centro: a lataria empurra, e o empurrão sobra rua.
  for (const [x, y] of [[5, 5], [5.4, 5], [5, 5.4], [4.6, 5], [5, 4.6]]) {
    const c = { x, y, radius: 0.15 };
    collision.resolveCircleVsBuses(c, [onibus]);
    assert.ok(Math.abs(c.x - x) > 1e-9 || Math.abs(c.y - y) > 1e-9,
      `o pedestre atravessou o ônibus virado para ${dir} em (${x}, ${y})`);
    assert.ok(!collideCircleAabb(c, caixa).collided, 'o empurrão deixou lataria dentro de lataria');
  }
  // E o mesmo palmo de asfalto fora do comprimento não é parede: virado para o eixo X, o ônibus
  // tem 1,25 tile de comprido e 0,85 de largo, e quem passa a 0,9 tile de lado está na calçada.
  const deLado = { x: 5 + (noComprido ? 0.9 : 0), y: 5 + (noComprido ? 0 : 0.9), radius: 0.15 };
  const antes = { ...deLado };
  collision.resolveCircleVsBuses(deLado, [onibus]);
  assert.deepEqual(deLado, antes, 'a lataria vazou para fora da própria largura');
}
// Congelado fora da cena não é parede: o corpo que o portão de zonas não calcula ficou no último
// pixel em que foi visto, e uma lataria invisível no meio da rua vazia é pior que a fumaça.
const congelado = { ...busao('SE'), live: false };
const passando = { x: 5, y: 5, radius: 0.15 };
collision.resolveCircleVsBuses(passando, [congelado]);
assert.deepEqual(passando, { x: 5, y: 5, radius: 0.15 }, 'o ônibus fora de cena virou parede');
console.log('OK o ônibus do horário é lataria sólida nos quatro rumos, e só quando está na rua');
const heli = createVehicle(2, VEHICLE_DEFS.helicopter, 'red', 3, 3, 'SE');
const body = { x: 3, y: 3, radius: 0.15 };
heli.altitude = 1;
collision.resolveCircleVsVehicles(body, [heli]);
assert.equal(body.x, 3);
heli.altitude = 0;
collision.resolveCircleVsVehicles(body, [heli]);
assert.ok(body.x !== 3 || body.y !== 3);
console.log('OK landed helicopters collide while flying helicopters pass overhead');
const world = new WorldMap(generateCity(42));
world.data.buildings.forEach((b, index) => {
  const c = world.buildingColliders[index];
  assert.equal(c.x, b.x - b.footprintW);
  assert.equal(c.y, b.y - b.footprintW);
  assert.equal(c.width, b.footprintW);
  assert.equal(c.height, b.footprintW);
});
console.log('OK building colliders occupy the full generated ground footprint');
