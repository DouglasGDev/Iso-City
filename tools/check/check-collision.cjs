const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
require.extensions['.png'] = (module, file) => { module.exports = file; };
require.extensions['.ts'] = (module, file) => module._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText, file);
const { CollisionSystem, collideCircleAabb, vehicleGroundCollider } = require('../../src/systems/CollisionSystem.ts');
const { createVehicle } = require('../../src/entities/Vehicle.ts');
const { VEHICLE_DEFS } = require('../../src/data/vehicles.ts');
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
