/**
 * Gente de dentro: moradores, atendente, cozinheiro, clientes e funcionários que vivem na
 * sala — a base deles é o móvel da própria planta, eles andam por volta dela, correm do
 * estampido, apanham, morrem e sangram como na rua, mas nunca saem do quarto.
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
const { InteriorCrowdSystem } = load('systems/InteriorCrowdSystem.js');
const { CollisionSystem } = load('systems/CollisionSystem.js');
const { createPlayer } = load('entities/Player.js');
const { NPC_CORPSE_LIFETIME_S } = load('entities/NPC.js');
const { GAME_CONFIG } = load('game/GameConfig.js');

const world = new WorldMap(generateCity());
const interiors = new InteriorSystem(world);
const collision = new CollisionSystem();
const p = createPlayer(0, 0);
const clearAt = (map, x, y, margin = 0.1) => !map.staticColliders.some((c) =>
  x + margin > c.x && x - margin < c.x + c.width && y + margin > c.y && y - margin < c.y + c.height);
const inside = (map, x, y) => x > 0.4 && y > 0.4 && x < map.worldW - 0.4 && y < map.worldH - 0.4;
const roomOf = (entrance) => {
  p.x = entrance.x; p.y = entrance.y;
  return interiors.open(entrance, p);
};
const crowdCtx = (room, extra = {}) => ({
  player: p, room, collision, shot: false, melee: false, notify: () => {}, ...extra,
});
const run = (crowd, room, frames, extra) => {
  for (let i = 0; i < frames; i++) crowd.update(1 / 60, crowdCtx(room, extra));
};

// ---------------------------------------------------------------- o elenco de cada sala
const crowd = new InteriorCrowdSystem();
const home = roomOf(interiors.entrances.find((e) => e.kind === 'home'));
const office = roomOf(interiors.entrances.find((e) => e.kind === 'office'));
assert.ok(home && office, 'a cidade tem casa e escritório');

assert.equal(crowd.inside, false, 'fora de sala não há elenco');
assert.ok(crowd.enter(home), 'a casa ganha gente');
const homeCast = crowd.list.length;
assert.equal(crowd.inside, true);
assert.ok(crowd.list.length >= 2, `casa tem pelo menos dois moradores (${crowd.list.length})`);
assert.ok(crowd.list.every((o) => o.role === 'resident'), 'na casa mora gente, não se trabalha');
assert.equal(new Set(crowd.list.map((o) => o.id)).size, crowd.list.length, 'id único por morador');
for (const o of crowd.list) {
  assert.equal(o.kind, 'civ', 'nenhum morador é policial');
  assert.equal(o.inVehicle, false, 'nenhum morador dirige');
  assert.ok(inside(home.map, o.x, o.y), 'morador nasce dentro da sala');
  assert.ok(clearAt(home.map, o.x, o.y), 'morador não nasce dentro do móvel');
  assert.ok(Math.hypot(o.x - home.service.x, o.y - home.service.y) > 0.7, 'não pisa o ponto de serviço');
  assert.ok(Math.hypot(o.x - home.exit.x, o.y - home.exit.y) > 0.7, 'não tapa a porta de saída');
}
assert.ok(new Set(crowd.list.map((o) => `${Math.round(o.baseX)},${Math.round(o.baseY)}`)).size === crowd.list.length,
  'cada morador tem a sua base');

// O comércio: quem atende, quem cozinha e quem compra — e só quem a planta permite.
const shops = interiors.entrances.filter((e) => e.kind === 'shop');
assert.ok(shops.length >= 2, 'há comércio para abrir');
const casts = shops.map((e) => {
  const room = roomOf(e);
  const c = new InteriorCrowdSystem();
  c.enter(room);
  return { room, c, list: c.list.slice(), hasKitchen: room.furniture.some((f) => f.kind === 'grill') };
});
for (const { room, list, hasKitchen } of casts) {
  assert.ok(list.length >= 2, `comércio ${room.label} tem freguesia`);
  assert.ok(list.some((o) => o.role === 'shopkeeper'), 'o balcão tem quem atenda');
  assert.equal(list.some((o) => o.role === 'cook'), hasKitchen,
    `cozinheiro só existe com cozinha (${room.label})`);
  assert.ok(list.filter((o) => o.role === 'customer').length >= 1, 'tem cliente');
  assert.equal(new Set(list.map((o) => `${o.baseX.toFixed(2)},${o.baseY.toFixed(2)}`)).size, list.length,
    `dois papéis não dividem o mesmo posto (${room.label})`);
  for (const o of list) {
    assert.ok(inside(room.map, o.x, o.y) && clearAt(room.map, o.x, o.y), `posto de ${o.role} livre`);
  }
}
// Escritório: recepção e funcionário.
const officeCrowd = new InteriorCrowdSystem();
officeCrowd.enter(office);
assert.ok(officeCrowd.list.some((o) => o.role === 'clerk'), 'tem quem atenda a recepção');
assert.ok(officeCrowd.list.some((o) => o.role === 'worker'), 'tem funcionário circulando');

// A cadeia tem elenco próprio: nada de morador entre as celas.
const jailDoor = interiors.jailEntrance;
const jailRoom = roomOf(jailDoor);
const jailCrowd = new InteriorCrowdSystem();
assert.equal(jailCrowd.enter(jailRoom), false, 'a cadeia não recebe elenco genérico');
assert.equal(jailCrowd.inside, false);
assert.equal(jailCrowd.list.length, 0);

// ---------------------------------------------------------------- vivem: andam, param, não atravessam
// O jogador fica em chão livre, o mais perto do meio da sala que a planta permitir: parado
// em cima da mesa ele não seria atirador nem referência de distância de nada.
let stand = { x: home.map.worldW / 2, y: home.map.worldH / 2 };
let standNear = Infinity;
for (let x = 0.8; x <= home.map.worldW - 0.8; x += 0.2) {
  for (let y = 0.8; y <= home.map.worldH - 0.8; y += 0.2) {
    if (!clearAt(home.map, x, y, 0.5)) continue;
    const d = Math.hypot(x - home.map.worldW / 2, y - home.map.worldH / 2);
    if (d < standNear) {
      standNear = d;
      stand = { x, y };
    }
  }
}
p.x = stand.x;
p.y = stand.y;
const before = crowd.list.map((o) => ({ x: o.x, y: o.y }));
let stroll = 0;
let walkPrev = crowd.list.map((o) => ({ x: o.x, y: o.y }));
for (let i = 0; i < 600; i++) {
  crowd.update(1 / 60, crowdCtx(home));
  crowd.list.forEach((o, k) => {
    stroll += Math.hypot(o.x - walkPrev[k].x, o.y - walkPrev[k].y);
    walkPrev[k] = { x: o.x, y: o.y };
  });
}
assert.ok(stroll > 1.5, `a casa não é um cenário de estátuas (${stroll.toFixed(2)} de passeio)`);
for (let i = 0; i < crowd.list.length; i++) {
  const o = crowd.list[i];
  assert.ok(inside(home.map, o.x, o.y) && clearAt(home.map, o.x, o.y),
    `morador ${o.role} atravessou móvel ou parede`);
  // Sem susto, ninguém sai do próprio canto: a base é o que a pessoa conhece.
  assert.ok(Math.hypot(o.x - o.baseX, o.y - o.baseY) <= o.roam + 0.7,
    `morador ${o.role} fugiu da própria base`);
  assert.ok(o.anim === 'idle' || o.anim === 'walk', 'animação de quem vive em casa');
  assert.ok(o.frame >= 0 && o.frame <= 3);
  assert.ok(Math.hypot(o.x - before[i].x, o.y - before[i].y) < 3, 'ninguém teleporta pelo quarto');
}

// ---------------------------------------------------------------- o estampido: corre quem ouve
const spread = crowd.list.map((o) => Math.hypot(o.x - p.x, o.y - p.y));
crowd.update(1 / 60, crowdCtx(home, { shot: true }));
assert.ok(crowd.list.every((o) => o.panic > 0), 'dentro de casa o tiro ouve-se em todo canto');
// Percurso e pico de distância: na sala pequena o canto de hoje é a parede de amanhã, então
// o que prova a fuga é quanto a pessoa andou e o mais longe que chegou de quem atirou. Cinco
// segundos de corrida, porque contornar móvel não é linha reta.
let ran = 0;
const peak = spread.slice();
let fleePrev = crowd.list.map((o) => ({ x: o.x, y: o.y }));
for (let i = 0; i < 300; i++) {
  crowd.update(1 / 60, crowdCtx(home));
  crowd.list.forEach((o, k) => {
    ran += Math.hypot(o.x - fleePrev[k].x, o.y - fleePrev[k].y);
    peak[k] = Math.max(peak[k], Math.hypot(o.x - p.x, o.y - p.y));
    fleePrev[k] = { x: o.x, y: o.y };
  });
}
const closest = spread.indexOf(Math.min(...spread));
const after = crowd.list.map((o) => Math.hypot(o.x - p.x, o.y - p.y));
assert.ok(ran > 6, `a sala corre do estampido (${ran.toFixed(2)} de corrida)`);
assert.ok(peak[closest] > spread[closest] + 0.5,
  `quem estava ao alcance correu de quem atirou (${spread[closest].toFixed(2)} → ${peak[closest].toFixed(2)})`);
// A sala tem sete passos e o andar iso abre um eixo por vez: contornar a mesa às vezes
// passa raspando no meio do caminho. O que não pode é devolver o chão já ganho.
assert.ok(after.every((d, k) => d >= peak[k] - 1),
  'fugindo não se devolve a distância ganha de quem atirou');
assert.ok(after.every((d, k) => d >= spread[k] - 1),
  'fugindo não se cai em cima de quem atirou');
assert.ok(crowd.list.some((o) => o.state === 'fleeing'), 'estado de fuga registrado');
run(crowd, home, 900);
assert.ok(crowd.list.every((o) => o.panic <= 0), 'o susto passa');
assert.ok(crowd.list.every((o) => Math.hypot(o.x - o.baseX, o.y - o.baseY) <= o.roam + 0.9),
  'cumprido o susto, volta para a própria base');
for (const o of crowd.list) {
  assert.ok(inside(home.map, o.x, o.y) && clearAt(home.map, o.x, o.y), 'fugindo não se entra na parede');
}

// ------------------------------------------------- a fuga vale em toda sala, não só na casa
for (const { room, c } of casts.slice(0, 4).concat([{ room: office, c: officeCrowd }])) {
  p.x = room.map.worldW / 2;
  p.y = room.map.worldH / 2;
  const start = c.list.map((o) => Math.hypot(o.x - p.x, o.y - p.y));
  c.update(1 / 60, crowdCtx(room, { shot: true }));
  assert.ok(c.list.every((o) => o.panic > 0), `em ${room.label} o tiro ouve-se em todo canto`);
  const top = start.slice();
  let fled = 0;
  let flightPrev = c.list.map((o) => ({ x: o.x, y: o.y }));
  for (let i = 0; i < 300; i++) {
    c.update(1 / 60, crowdCtx(room));
    c.list.forEach((o, k) => {
      fled += Math.hypot(o.x - flightPrev[k].x, o.y - flightPrev[k].y);
      top[k] = Math.max(top[k], Math.hypot(o.x - p.x, o.y - p.y));
      flightPrev[k] = { x: o.x, y: o.y };
    });
  }
  // Em planta apertada pode não haver ganho de distância algum -- o fundo já é o posto de
  // quem atende. O que toda sala tem de ter é perna: ninguém encara o estampido parado.
  assert.ok(fled > 2, `em ${room.label} a sala se levanta do estampido (${fled.toFixed(2)} de corrida)`);
  assert.ok(c.list.every((o, k) => Math.hypot(o.x - p.x, o.y - p.y) >= top[k] - 1),
    `em ${room.label} a fuga não devolve o chão ganho`);
  run(c, room, 600);
  assert.ok(c.list.every((o) => o.panic <= 0), `em ${room.label} o susto passa`);
  for (const o of c.list) {
    assert.ok(inside(room.map, o.x, o.y) && clearAt(room.map, o.x, o.y),
      `${o.role} não fura móvel nem parede em ${room.label}`);
    assert.ok(Math.hypot(o.x - o.baseX, o.y - o.baseY) <= o.roam + 1.4,
      `feito o susto, ${o.role} volta para o posto em ${room.label}`);
  }
}

// ---------------------------------------------------------------- apanhar, cair e morrer
const victim = crowd.list[0];
// O soco só assusta o alcance dele: o jogador encosta no morador para testar isso.
p.x = victim.x + 0.3;
p.y = victim.y;
victim.health = 20;
crowd.update(1 / 60, crowdCtx(home, { melee: true }));
assert.ok(victim.panic > 0, 'um soco assusta quem está perto');
victim.state = 'knocked';
victim.downTimer = GAME_CONFIG.NPC_DOWN_S;
run(crowd, home, 5);
assert.equal(victim.state, 'knocked', 'caído fica no chão');
assert.equal(victim.anim, 'idle', 'sem andar caído');
run(crowd, home, Math.ceil(GAME_CONFIG.NPC_DOWN_S * 60) + 10);
assert.ok(victim.downTimer === 0 && victim.state !== 'knocked', 'levanta-se sozinho');
assert.ok(victim.panic > 0, 'quem apanhou sai assustado');

victim.health = 0;
victim.dead = true;
victim.state = 'dead';
crowd.update(1 / 60, crowdCtx(home));
assert.ok(victim.blood && victim.blood.length > 0, 'o corpo ensanguenta o chão da sala');
assert.equal(victim.deathTimer >= 0, true, 'o relógio do cadáver começa');
const others = crowd.list.filter((o) => !o.dead);
assert.ok(others.every((o) => o.panic > 0), 'ver um colega cair põe todo mundo em pânico');
run(crowd, home, Math.ceil(NPC_CORPSE_LIFETIME_S * 60) + 30);
assert.equal(crowd.list.includes(victim), false, 'cadáver vencido sai da sala');
assert.ok(crowd.list.every((o) => !o.dead), 'só ficam os vivos');

// ---------------------------------------------------------------- o elenco é da sala, não da visita
const ids = crowd.list.map((o) => o.id);
crowd.leave();
assert.equal(crowd.inside, false, 'sair fecha a cortina');
assert.equal(crowd.list.length, 0);
assert.ok(crowd.enter(home), 'voltar pela porta reabre a mesma casa');
assert.deepEqual(crowd.list.map((o) => o.id), ids, 'voltar não recontrata ninguém');
assert.ok(crowd.byId(ids[0]), 'busca estável por id');
assert.equal(crowd.byId(999999), undefined);

// ---------------------------------------------------------------- GameState: dentro da sala eles existem
const { GameState } = load('game/GameState.js');
const input = load('game/InputState.js');
const g = new GameState();
g.police.update = () => {};
g.trafficSystem.update = () => {};
const door = g.interiors.entrances.find((e) => e.kind === 'home' || e.kind === 'shop');
assert.ok(door, 'há casa ou loja para entrar');
g.player.x = door.x;
g.player.y = door.y;
g.player.money = 500;
input.inputState.interactQueued = true;
g.update(1 / 60);
assert.ok(g.interiors.active, 'entrou na sala');
assert.ok(g.crowd.inside, 'a sala do GameState tem gente');
assert.ok(g.crowd.list.length >= 2, `gente da sala: ${g.crowd.list.length}`);
const street = g.npcs.length;
const room = g.interiors.active;

// Vivem com o relógio do jogo: passeio somado de todos, sprite que gira o frame, e passo por
// passo -- ninguém some de um canto ao outro num tick.
let lived = 0;
let stepped = 0;
let blinked = false;
let livePrev = g.crowd.list.map((o) => ({ x: o.x, y: o.y, frame: o.frame }));
for (let i = 0; i < 420; i++) {
  g.update(1 / 60);
  g.crowd.list.forEach((o, k) => {
    const step = Math.hypot(o.x - livePrev[k].x, o.y - livePrev[k].y);
    lived += step;
    stepped = Math.max(stepped, step);
    if (o.frame !== livePrev[k].frame) blinked = true;
    livePrev[k] = { x: o.x, y: o.y, frame: o.frame };
  });
}
assert.ok(lived > 1, `a sala passeia com o tick do GameState (${lived.toFixed(2)} de passeio)`);
assert.ok(blinked, 'o tick do GameState anima o sprite da sala');
assert.ok(stepped < 0.2, `a sala não teleporta ninguém (maior passo ${stepped.toFixed(3)})`);
assert.ok(g.crowd.list.every((o) => inside(room.map, o.x, o.y)), 'a sala não perde ninguém');
assert.equal(g.npcs.length, street, 'pedestre da rua não vira morador de sala');

// Socar um morador: ele é alvo dentro de casa, apanha e cai, e a rua não fica sabendo.
// O encontro acontece num chão aberto: soco através de móvel o mundo inteiro barra, e ali
// não seria teste de nada.
const target = g.crowd.list[g.crowd.list.length - 1];
let spot = null;
for (let x = 0.8; x < room.map.worldW - 1.6 && !spot; x += 0.25) {
  for (let y = 0.8; y < room.map.worldH - 0.8 && !spot; y += 0.25) {
    if (clearAt(room.map, x, y, 0.35) && clearAt(room.map, x + 0.3, y, 0.35)) spot = { x, y };
  }
}
assert.ok(spot, 'a sala tem chão aberto para uma briga');
target.x = spot.x;
target.y = spot.y;
g.player.x = spot.x - 0.3;
g.player.y = spot.y;
g.player.facingAngle = 0;
g.player.invulnUntil = 0;
const hp = target.health;
for (let i = 0; i < 30; i++) {
  input.inputState.attackQueued = true;
  g.player.x = target.x - 0.3;
  g.player.y = target.y;
  g.update(1 / 60);
  if (target.health < hp) break;
}
assert.ok(target.health < hp, 'o morador apanha dentro de casa');
assert.equal(g.npcs.length, street, 'a luta é da sala, não da calçada');

// Matou: corpo, sangue e o dinheiro cai na porta da rua (dentro da sala não há para onde).
while (target.health > 0) {
  target.health = 0;
  target.dead = true;
  target.state = 'dead';
}
g.update(1 / 60);
assert.ok(target.blood, 'morador morto sangra na sala');
assert.ok(g.crowd.list.some((o) => o.panic > 0), 'a sala toda corre do tiro');

// Sair pela porta: o elenco congela com a sala e a rua volta a ser a rua.
g.player.x = room.exit.x;
g.player.y = room.exit.y;
g.interiors.update(0.6);
input.inputState.interactQueued = true;
assert.equal(g.useInterior(), true, 'sai pela porta');
assert.equal(g.interiors.active, null);
assert.equal(g.crowd.inside, false, 'sem sala, sem simulação de sala');
assert.equal(g.crowd.list.length, 0);
for (let i = 0; i < 60; i++) g.update(1 / 60);
assert.equal(g.npcs.length, street, 'nada vazou da sala para a rua');

//ressuscita: o save não guarda gente de sala — o mundo é re-simulado.
const fresh = new GameState();
assert.equal(fresh.crowd.list.length, 0, 'partida nova começa sem elenco simulado');

console.log(`OK gente de dentro: elenco por sala (casa ${homeCast}, escritório ${officeCrowd.list.length}, ` +
  `comércio ${casts.length} lojas (atendente${casts.some((c) => c.hasKitchen) ? ', cozinha e' : ' e'} clientes), ` +
  `fuga do estampido, soco, queda, morte com sangue e elenco que é da sala, não da visita`);
