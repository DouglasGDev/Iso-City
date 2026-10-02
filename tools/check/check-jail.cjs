/**
 * Penitenciária: a porta na esquadra mais isolada, o bloco maior de celas, o depósito
 * gradesado, a pena que corre, as chaves do guarda, a fuga silenciosa que só vira caçada
 * quando o guarda te vê, e a contenção que te devolve para trás das grades.
 * Roda headless (sem Skia nem áudio), com o GameState real.
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
execFileSync(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '-p', path.join(__dirname, 'tsconfig.json')], { stdio: 'inherit' });
const compiled = path.join(__dirname, 'dist-test/src');
const load = (file) => require(path.join(compiled, file));
const ui = { paused: false, mapOpen: false, shopOpen: false, overlay: null, mapMarker: null, mapRoute: [] };
const sfx = [];
for (const [file, exports] of [
  ['audio/SoundManager.js', { sound: { play: (key) => sfx.push(key), ambient() {}, weather() {}, setLoop() {}, stopLoops() {} } }],
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
const { JailSystem } = load('systems/JailSystem.js');
const { CollisionSystem } = load('systems/CollisionSystem.js');
const { createPlayer } = load('entities/Player.js');
const { GAME_CONFIG } = load('game/GameConfig.js');
const jailData = load('data/jail.js');

const world = new WorldMap(generateCity());
const interiors = new InteriorSystem(world);
const p = createPlayer(0, 0);

function clearAt(map, x, y) {
  return !map.queryNearby(x, y, 0.5).some((c) => x > c.x - 0.17 && x < c.x + c.width + 0.17 &&
    y > c.y - 0.17 && y < c.y + c.height + 0.17);
}
/** Busca em largura no passo de um raio de personagem: é assim que o jogador anda. */
function walkable(map, from, goal, blocked = []) {
  const step = 0.2;
  const solid = (x, y) => map.queryNearby(x, y, 0.5).some((c) => x > c.x - 0.14 && x < c.x + c.width + 0.14 &&
      y > c.y - 0.14 && y < c.y + c.height + 0.14) ||
    blocked.some((c) => x > c.x - 0.14 && x < c.x + c.width + 0.14 && y > c.y - 0.14 && y < c.y + c.height + 0.14);
  const start = [Math.round(from.x / step), Math.round(from.y / step)];
  const queue = [start];
  const seen = new Set([start.join(',')]);
  for (let i = 0; i < queue.length; i++) {
    const [gx, gy] = queue[i];
    const x = gx * step, y = gy * step;
    if (Math.hypot(x - goal.x, y - goal.y) < 0.5) return true;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = gx + dx, ny = gy + dy, key = `${nx},${ny}`;
      if (seen.has(key) || nx < 0 || ny < 0 || nx * step > map.worldW || ny * step > map.worldH) continue;
      if (solid(nx * step, ny * step)) continue;
      seen.add(key);
      queue.push([nx, ny]);
    }
  }
  return false;
}

// ---------------------------------------------------------------- a porta na esquadra mais isolada
const jailDoor = interiors.jailEntrance;
assert.ok(jailDoor, 'o mapa tem porta de cadeia');
assert.equal(jailDoor.kind, 'jail');
assert.equal(jailDoor.service, 'cells');
assert.equal(jailDoor.label, 'Cadeia');
assert.equal(jailDoor.counter, null, 'a cadeia não tem balcão de venda');
const stations = world.landmarksOf('police');
assert.ok(stations.length >= 2, 'a cidade tem mais de uma esquadra para escolher a isolada');
const centerX = world.data.worldW / 2, centerY = world.data.worldH / 2;
const isolationOf = (l) => Math.hypot(l.front.x - centerX, l.front.y - centerY);
const mostIsolated = stations.reduce((best, l) => (isolationOf(l) > isolationOf(best) ? l : best));
assert.ok(Math.hypot(jailDoor.x - mostIsolated.front.x, jailDoor.y - mostIsolated.front.y) < 1e-9,
  'a cadeia fica na esquadra mais longe do centro');
assert.ok(clearAt(world, jailDoor.x, jailDoor.y), 'porta de cadeia desobstruída');
assert.equal(interiors.entrances[0], jailDoor, 'a cadeia é registrada antes das lojas');
for (const other of interiors.entrances) {
  if (other === jailDoor) continue;
  assert.ok(Math.hypot(other.x - jailDoor.x, other.y - jailDoor.y) >= 8, 'nenhuma loja rouba o endereço da cadeia');
}

// ---------------------------------------------------------------- a planta da sala grande
p.x = jailDoor.x;
p.y = jailDoor.y;
const room = interiors.open(jailDoor, p);
assert.equal(room.kind, 'jail');
assert.equal(room.map.worldW, jailData.JAIL_W);
assert.equal(room.map.worldH, jailData.JAIL_H);
assert.ok(jailData.JAIL_W >= 16 && jailData.JAIL_H >= 11, 'a penitenciária é maior que uma sala comum');
assert.equal(room.shop, null);
assert.ok(jailData.JAIL_CELLS.length >= 5, 'pelo menos cinco celas');
assert.equal(jailData.JAIL_GATE_SLOTS.length, jailData.JAIL_CELLS.length + 1, 'um vão por cela mais o depósito');
assert.equal(jailData.JAIL_ARMORY_GATE, jailData.JAIL_CELLS.length, 'o depósito é o último vão');
assert.equal(room.furniture.filter((f) => f.kind === 'bars').length, jailData.JAIL_GATE_SLOTS.length,
  'uma grade por vão gradesado');
assert.equal(room.furniture.filter((f) => f.kind === 'bed').length, jailData.JAIL_CELLS.length, 'beliche em cada cela');
// Grade não é parede estática: quem abre e fecha é o JailSystem.
for (const bars of room.furniture.filter((f) => f.kind === 'bars')) {
  assert.ok(clearAt(room.map, bars.x + bars.w / 2, bars.y + bars.d / 2), 'a grade não pode estar na colisão fixa');
}
for (const cell of jailData.JAIL_CELLS) {
  assert.ok(cell.x1 > cell.x0 && cell.gateX0 > cell.x0 && cell.gateX1 < cell.x1, 'vão da grade dentro da cela');
  assert.ok(clearAt(room.map, (cell.gateX0 + cell.gateX1) / 2, jailData.JAIL_FRONT_Y), 'vão da grade livre no mapa');
}
const closedGates = jailData.JAIL_GATE_SLOTS.map((s) => ({ x: s.x, y: s.y, width: s.width, height: s.height }));
assert.ok(walkable(room.map, { x: jailData.JAIL_SPAWN.x, y: jailData.JAIL_SPAWN.y }, room.service),
  'painel alcançável pelo pátio');
assert.ok(walkable(room.map, { x: jailData.JAIL_SPAWN.x, y: jailData.JAIL_SPAWN.y }, room.exit),
  'porta de saída alcançável');
// Depósito é área trancada: com o vão fechado não se alcança o interior da jaula.
assert.ok(!walkable(room.map, { x: jailData.JAIL_SPAWN.x, y: jailData.JAIL_SPAWN.y }, jailData.JAIL_ARMORY.loot, closedGates),
  'depósito fechado não tem entrada');
// Mas a cela trancada também não abre: nem o quarto do jogador.
assert.ok(!walkable(room.map, { x: jailData.JAIL_SPAWN.x, y: jailData.JAIL_SPAWN.y }, jailData.JAIL_CELL_SPAWN, closedGates),
  'cela trancada não tem saída');
// TODA cela, não só a do jogador. A cela 0 encosta na parede oeste do quarto, então ela sempre
// pareceu selada — e foi assim que o bloco inteiro passou a checar verde com a última cela aberta
// por uma faixa de chão sobrando entre a divisória e a casca leste. O usuário viu pela frente:
// "tem uma cela sem uma parede, fica aberta, é a do lado de onde abre as celas" (o painel fica em
// 13.9, colado na cela 4). Fecha as duas pontas do bloco e testa cada uma, fechada e aberta.
const ultimo = jailData.JAIL_CELLS.length - 1;
assert.ok(Math.abs(jailData.JAIL_CELLS[0].x0 - jailData.JAIL_T) < 1e-9,
  'a primeira cela encosta na parede oeste, sem faixa sobrando');
assert.ok(Math.abs(jailData.JAIL_CELLS[ultimo].x1 - (jailData.JAIL_W - jailData.JAIL_T)) < 1e-9,
  'a última cela encosta na parede leste, sem faixa sobrando');
for (const [i, cell] of jailData.JAIL_CELLS.entries()) {
  const dentro = { x: (cell.x0 + cell.x1) / 2, y: jailData.JAIL_FRONT_Y - 1.2 };
  assert.ok(clearAt(room.map, dentro.x, dentro.y), `dentro da cela ${i} tem piso livre`);
  assert.ok(!walkable(room.map, { x: jailData.JAIL_SPAWN.x, y: jailData.JAIL_SPAWN.y }, dentro, closedGates),
    `cela ${i} fechada só tem a grade como entrada`);
  // Abertas as grades das celas (o vão do depósito continua trancado), cada cela é alcançável.
  assert.ok(walkable(room.map, { x: jailData.JAIL_SPAWN.x, y: jailData.JAIL_SPAWN.y }, dentro,
      [closedGates[ultimo + 1]]),
    `cela ${i} abre pela própria grade`);
}
for (const f of room.furniture) {
  if (f.kind === 'bars') continue;
  assert.ok(!clearAt(room.map, f.x + f.w / 2, f.y + f.d / 2), `móvel ${f.id} precisa bloquear o próprio centro`);
  assert.ok(f.x >= 0 && f.y >= 0 && f.x + f.w <= room.map.worldW && f.y + f.d <= room.map.worldH, `móvel ${f.id} fora da sala`);
}
interiors.leave(p);
assert.equal(interiors.active, null);

// ---------------------------------------------------------------- contexto de teste
const log = { wanted: [], said: [], freed: [], guns: [] };
const makeCtx = (player) => ({
  player,
  damagePlayer: (amount) => { player.health = Math.max(0, player.health - amount); return true; },
  raiseWanted: (stars) => log.wanted.push(stars),
  releaseInmate: (inmate) => log.freed.push(inmate.id),
  grantGun: (id) => { log.guns.push(id); return true; },
  say: (text) => log.said.push(text),
  notify: () => {},
});

// ---------------------------------------------------------------- pena, grade e relógio
assert.equal(JailSystem.sentenceFor(0), GAME_CONFIG.JAIL_BASE_S);
assert.equal(JailSystem.sentenceFor(3), GAME_CONFIG.JAIL_BASE_S + 3 * GAME_CONFIG.JAIL_PER_STAR_S);
assert.ok(JailSystem.sentenceFor(5) > JailSystem.sentenceFor(1), 'mais estrela, mais tempo');

const jail = new JailSystem();
const cellPlayer = createPlayer(0, 0);
cellPlayer.x = jailData.JAIL_CELL_SPAWN.x;
cellPlayer.y = jailData.JAIL_CELL_SPAWN.y;
const cellCtx = makeCtx(cellPlayer);
jail.incarcerate(JailSystem.sentenceFor(2));
assert.ok(jail.inside && jail.locked, 'presão: dentro e trancado');
assert.equal(jail.atLarge, false, 'recém-presão não está à solta');
assert.equal(jail.occupants.length, jailData.JAIL_INMATES.length + 1, 'presos mais o guarda');
assert.equal(jail.occupants.filter((o) => o.cell === -1).length, 1, 'um guarda só');
assert.ok(jail.gates.every((open) => !open), 'todos os vãos fecham na entrada');
assert.match(jail.prompt(cellPlayer) ?? '', /cela trancada · \d+ s/i, 'na grade a dica conta a pena');
cellPlayer.y = jailData.JAIL_FRONT_Y - 2;
assert.match(jail.prompt(cellPlayer) ?? '', /pena · \d+ s/i, 'no fundo da cela ainda dá para ver o relógio');

// A grade fechada é parede dos dois lados; aberta não é nada.
const collision = new CollisionSystem();
const slot0 = jailData.JAIL_GATE_SLOTS[0];
const gateX = slot0.x + slot0.width / 2;
cellPlayer.x = gateX;
cellPlayer.y = jailData.JAIL_FRONT_Y - 0.1;
jail.blockPlayer(cellPlayer, collision);
assert.ok(cellPlayer.y <= jailData.JAIL_FRONT_Y - GAME_CONFIG.PLAYER_RADIUS + 1e-9,
  'de dentro da cela a grade empurra o jogador para trás');
cellPlayer.y = slot0.y + slot0.height + 0.1;
cellPlayer.x = gateX;
jail.blockPlayer(cellPlayer, collision);
assert.ok(cellPlayer.y >= slot0.y + slot0.height + GAME_CONFIG.PLAYER_RADIUS - 1e-9,
  'do corredor a mesma grade devolve o jogador');
jail.gates[0] = true;
cellPlayer.x = gateX;
cellPlayer.y = jailData.JAIL_FRONT_Y;
const free = { x: cellPlayer.x, y: cellPlayer.y };
jail.blockPlayer(cellPlayer, collision);
assert.ok(Math.abs(cellPlayer.x - free.x) < 1e-9 && Math.abs(cellPlayer.y - free.y) < 1e-9,
  'vão aberto deixa passar');
jail.gates[0] = false;

// Cumprir o tempo abre a própria cela, sem alarme e sem fuga.
for (let i = 0; i < Math.ceil(JailSystem.sentenceFor(2) * 60) + 4; i++) jail.update(1 / 60, cellCtx);
assert.ok(!jail.locked, 'a pena acaba');
assert.equal(jail.gates[jailData.JAIL_PLAYER_CELL], true, 'a cela do jogador abre no fim da pena');
assert.equal(jail.atLarge, false, 'sair depois da pena não é fuga');
assert.ok(log.said.some((t) => /Pena cumprida/.test(t)), 'avisa que a cela abriu');
assert.deepEqual(log.wanted, [], 'cumprir a pena não é crime novo');

// ---------------------------------------------------------------- fuga silenciosa + contenção por visão
const captive = new JailSystem();
captive.incarcerate(JailSystem.sentenceFor(4));
const inmatePlayer = createPlayer(0, 0);
inmatePlayer.x = jailData.JAIL_CELL_SPAWN.x;
inmatePlayer.y = jailData.JAIL_CELL_SPAWN.y;
const inmateCtx = makeCtx(inmatePlayer);
const guard = captive.occupants.find((o) => o.cell === -1);

// Sem chaves a grade não cede.
inmatePlayer.x = gateX;
inmatePlayer.y = jailData.JAIL_FRONT_Y - GAME_CONFIG.PLAYER_RADIUS;
assert.equal(captive.tryInteract(inmateCtx), true, 'interagir na grade responde');
assert.ok(captive.gates.every((open) => !open), 'nada abre sem as chaves');
assert.ok(log.said.some((t) => /faltam|chaves/.test(t)), 'diz por que não abre');

// Derruba o guarda: as chaves caem dentro da cela.
guard.downTimer = GAME_CONFIG.NPC_DOWN_S;
guard.state = 'knocked';
for (let i = 0; i < 30; i++) captive.update(1 / 60, inmateCtx);
assert.ok(captive.keysOnFloor, 'o guarda derrubado larga as chaves');
assert.ok(captive.keysOnFloor.y < jailData.JAIL_FRONT_Y, 'as chaves caem do lado do preso');
inmatePlayer.x = captive.keysOnFloor.x;
inmatePlayer.y = captive.keysOnFloor.y;
captive.update(1 / 60, inmateCtx);
assert.ok(captive.keysHeld, 'chaves pegadas');

// Arrombar a própria cela antes do tempo é fuga, mas silenciosa: só o olhar do guarda acorda a caçada.
inmatePlayer.x = gateX;
inmatePlayer.y = jailData.JAIL_FRONT_Y - GAME_CONFIG.PLAYER_RADIUS;
log.wanted.length = 0;
assert.equal(captive.tryInteract(inmateCtx), true);
assert.equal(captive.gates[0], true, 'a grade destrancada fica aberta');
assert.ok(!captive.locked, 'a pena acabou por fora');
assert.ok(captive.atLarge, 'o fugitivo está à solta dentro da cadeia');
assert.equal(captive.alarm, false, 'a fuga em si não dispara o alarme: o guarda precisa ver');
assert.deepEqual(log.wanted.slice(-1), [GAME_CONFIG.WANTED_JAILBREAK], 'fuga custa a estrela certa');
const remainingAtBreak = captive.sentenceLeft;

// O guarda se recupera e volta a patrulhar: agora é ele quem pode caçar.
guard.downTimer = 0;
guard.state = 'idle';

// Fora do cone de visão, o guarda não reage: de costas para o fugitivo ele não enxerga nada.
guard.x = 6; guard.y = 6.2; guard.dir = 'SW';
inmatePlayer.x = 6; inmatePlayer.y = 5.6; // o guarda olha para SW (para baixo); o fugitivo está acima dele
for (let i = 0; i < 10; i++) captive.update(1 / 60, inmateCtx);
assert.equal(captive.alarm, false, 'de costas o guarda não enxerga o fugitivo');
assert.equal(captive.atLarge, true, 'ainda à solta: ninguém viu');

// De frente, mas longe o bastante para não agarrar: a visão acorda o alarme e a caçada.
guard.x = 6; guard.y = 6.2; guard.dir = 'NE';
inmatePlayer.x = 6; inmatePlayer.y = 3.6; // NE aponta para cima, onde está o fugitivo, a 2.6 de distância
captive.update(1 / 60, inmateCtx);
assert.ok(captive.alarm, 'visto, o alarme dispara');
assert.ok(captive.atLarge && !captive.locked, 'longe, o guarda ainda não conteve');

// Encostar é contenção: o guarda devolve o preso para a cela e confisca as chaves.
guard.x = 6; guard.y = 6.2; guard.dir = 'NE';
inmatePlayer.x = 6; inmatePlayer.y = 5.9; // dentro do alcance de contenção
captive.update(1 / 60, inmateCtx);
assert.ok(captive.locked, 'o guarda conteve e trancou de novo');
assert.equal(captive.alarm, false, 'a contenção desliga a caçada');
assert.equal(captive.atLarge, false, 'de volta, não está mais à solta');
assert.equal(captive.keysHeld, false, 'as chaves foram confiscadas');
assert.equal(captive.sentenceLeft, remainingAtBreak + GAME_CONFIG.JAIL_BREAK_PENALTY_S,
  'a contenção cobra o tempo que restava mais o castigo');
assert.ok(Math.hypot(inmatePlayer.x - jailData.JAIL_CELL_SPAWN.x, inmatePlayer.y - jailData.JAIL_CELL_SPAWN.y) < 0.01,
  'o preso foi devolvido à cela');

// ---------------------------------------------------------------- depósito gradesado: área trancada
const store = new JailSystem();
store.incarcerate(1);
const storePlayer = createPlayer(0, 0);
store.keysHeld = true;
store.sentenceLeft = 0; // pena estourada para não bloquear o cenário
store.locked = false;
for (let i = 0; i < 200; i++) store.update(1 / 60, makeCtx(storePlayer)); // pena cumprida: grade 0 abre
const armSlot = jailData.JAIL_GATE_SLOTS[jailData.JAIL_ARMORY_GATE];
storePlayer.x = armSlot.x + armSlot.width / 2;
storePlayer.y = armSlot.y + armSlot.height + 0.2; // do lado de fora da jaula
log.guns.length = 0;
assert.ok(!store.gates[jailData.JAIL_ARMORY_GATE], 'depósito começa trancado');
assert.equal(store.tryInteract(makeCtx(storePlayer)), true, 'interagir na grade do depósito');
assert.ok(store.gates[jailData.JAIL_ARMORY_GATE], 'com as chaves o depósito abre');
storePlayer.x = jailData.JAIL_ARMORY.loot.x;
storePlayer.y = jailData.JAIL_ARMORY.loot.y;
assert.equal(store.tryInteract(makeCtx(storePlayer)), true, 'a pistola é alcançável com a jaula aberta');
assert.deepEqual(log.guns, ['pistol'], 'o depósito entrega uma pistola');
assert.equal(store.tryInteract(makeCtx(storePlayer)), true, 'segunda ida ainda responde');
assert.deepEqual(log.guns, ['pistol'], 'a pistola é pega uma única vez');

// ---------------------------------------------------------------- painel da invasão: liberta e alarma
const panel = new JailSystem();
panel.incarcerate(JailSystem.sentenceFor(4));
const panelPlayer = createPlayer(0, 0);
panel.keysHeld = true;
panel.locked = false;
panel.sentenceLeft = 0;
log.wanted.length = 0;
panelPlayer.x = jailData.JAIL_PANEL.x;
panelPlayer.y = jailData.JAIL_PANEL.y;
const panelCtx = makeCtx(panelPlayer);
assert.equal(panel.tryInteract(panelCtx), true, 'o painel responde com as chaves');
assert.ok(panel.gates.slice(0, jailData.JAIL_CELLS.length).every((open) => open), 'todas as celas abertas');
assert.ok(panel.occupants.filter((o) => o.cell >= 0).every((o) => o.free), 'os presos correm');
assert.ok(panel.alarm, 'a invasão é barulho: o guarda já sabe');
assert.ok(panel.atLarge, 'quem invade está à solta');
const beforeWanted = log.wanted.length;
panelPlayer.x = jailData.JAIL_PANEL.x;
panelPlayer.y = jailData.JAIL_PANEL.y;
assert.equal(panel.tryInteract(panelCtx), true);
assert.equal(log.wanted.length, beforeWanted, 'painel vazio não levanta estrela');

// Guarda no chão e cadáver vencido: as chaves não somem com o corpo.
const dead = new JailSystem();
dead.incarcerate(1);
const deadGuard = dead.occupants.find((o) => o.cell === -1);
deadGuard.downTimer = 0.2;
dead.update(1 / 60, makeCtx(createPlayer(deadGuard.x, deadGuard.y - 3)));
assert.ok(dead.keysOnFloor, 'chaves caem antes de o guarda levantar');
deadGuard.dead = true;
deadGuard.deathTimer = 10_000;
const count = dead.occupants.length;
dead.update(1 / 60, makeCtx(createPlayer(0, 0)));
assert.equal(dead.occupants.length, count - 1, 'cadáver vencido sai da sala');

// ---------------------------------------------------------------- GameState: preso de verdade
const { GameState } = load('game/GameState.js');
const g = new GameState();
g.police.update = () => {};
g.trafficSystem.update = () => {};
const gDoor = g.interiors.jailEntrance;
assert.ok(gDoor, 'GameState conhece a porta da cadeia');
assert.ok(g.interiors.delegate, 'a sala delega cela e painel');
assert.equal(g.jail.inside, false, 'começa livre');

g.player.wantedLevel = 3;
g.player.money = 900;
g.player.health = 0;
g.bust();
assert.equal(ui.overlay, 'busted');
assert.ok(g.interiors.active, 'acorda dentro de uma sala');
assert.equal(g.interiors.active.kind, 'jail');
assert.ok(g.jail.inside && g.jail.locked, 'presão do GameState');
assert.equal(g.jail.sentenceLeft, JailSystem.sentenceFor(3), 'a pena medida pelas estrelas');
assert.ok(Math.hypot(g.player.x - jailData.JAIL_CELL_SPAWN.x, g.player.y - jailData.JAIL_CELL_SPAWN.y) < 0.6, 'acorda na cela');
assert.equal(g.player.wantedLevel, 0, 'a cadeia zera o procurado');
assert.equal(g.player.health, 100);
assert.equal(g.player.money, 900 - GAME_CONFIG.BUSTED_MONEY_LOSS, 'a perda do bust continua');
ui.overlay = null;

// Rodada após rodada a grade segura o jogador dentro da cela.
for (let i = 0; i < 120; i++) g.update(1 / 60);
assert.ok(g.player.y < jailData.JAIL_FRONT_Y, 'o jogador não atravessa a grade fechada');
assert.equal(g.activeMap, g.interiors.active.map, 'a sala é o mapa ativo');
g.player.x = gateX;
g.player.y = jailData.JAIL_FRONT_Y - GAME_CONFIG.PLAYER_RADIUS;
g.player.facingAngle = Math.PI / 2;
const streetCount = g.npcs.length;
g.interiors.update(0.6);
assert.equal(g.useInterior(), true, 'interagir dentro da cela responde');
assert.equal(g.npcs.length, streetCount, 'nada é morto na rua por causa da cela');
assert.match(g.interiors.prompt(g.player) ?? '', /trancada|pena/i, 'a dica diz que a grade não abre');

// A simulação cumpre a pena sozinha e a saída volta a funcionar.
const framesLeft = Math.ceil((g.jail.sentenceLeft + 1) * 60);
for (let i = 0; i < framesLeft; i++) g.update(1 / 60);
assert.ok(!g.jail.locked, 'a simulação cumpre a pena');
assert.equal(g.jail.gates[jailData.JAIL_PLAYER_CELL], true);
g.player.x = g.interiors.active.exit.x;
g.player.y = g.interiors.active.exit.y;
g.interiors.update(0.6);
assert.ok(g.useInterior(), 'sai pela porta');
assert.equal(g.interiors.active, null);
assert.equal(g.jail.inside, false, 'fora da sala a cela não prende mais');
assert.ok(Math.hypot(g.player.x - gDoor.x, g.player.y - gDoor.y) < 0.6, 'aparece na calçada da esquadra isolada');

// Liberto na rua: o ex-preso volta a ser pedestre do mapa, na porta da frente.
const pedestrians = g.npcs.length;
const escapee = g.jail.occupants.find((o) => o.cell >= 0);
g.releaseToStreet(escapee);
assert.equal(g.npcs.length, pedestrians + 1, 'vira pedestre');
assert.ok(Math.hypot(escapee.x - gDoor.x, escapee.y - gDoor.y) < 0.01, 'sai pela porta da frente');
assert.ok(clearAt(g.map, escapee.x, escapee.y), 'solto na calçada, não dentro do prédio');

console.log(`OK penitenciária: porta isolada, ${jailData.JAIL_CELLS.length} celas + depósito gradesado, ` +
  `pena de ${JailSystem.sentenceFor(3)}s com 3 estrelas, fuga silenciosa, contenção por visão ` +
  `(+${GAME_CONFIG.JAIL_BREAK_PENALTY_S}s) e ${log.freed.length} preso(s) devolvido(s) à rua`);
