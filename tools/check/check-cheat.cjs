/**
 * Trapaças sob demanda: um painel que reescreve o mundo — carro, clima, desastre, estação,
 * procurado, vida, dinheiro, invencibilidade e armas — aberto pelo mesmo gesto no teclado (F4)
 * e no controle (clique do analógico direito). Roda headless com o GameState e o HardwareInput
 * reais, porque um cheat que só existe na tela é decoração: o que vale é o efeito no mundo.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
execFileSync(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '-p', path.join(__dirname, 'tsconfig.json')], { stdio: 'inherit' });

const compiled = path.join(__dirname, 'dist-test/src');
const src = (rel) => path.join(root, 'src', rel);
const load = (file) => require(path.join(compiled, file));

const ui = { screen: 'playing', paused: false, mapOpen: false, shopOpen: false, departuresOpen: false,
  cheatOpen: false, overlay: null, mapMarker: null, mapRoute: [] };
for (const [file, exports] of [
  ['audio/SoundManager.js', { sound: { play() {}, ambient() {}, weather() {}, setLoop() {}, stopLoops() {}, unlock() {}, setActive() {} } }],
  ['assets/AssetRegistry.js', { spriteKeyForVehicle: () => '' }],
  ['stores/useGameStore.js', { useGameStore: { getState: () => ui, clearMapMarker() {}, refreshMapRoute() {},
    showOverlay() {}, openShop() {}, closeShop() {}, openDepartures() {}, closeDepartures() {},
    openCheat: () => { ui.cheatOpen = true; }, closeCheat: () => { ui.cheatOpen = false; },
    toggleCheat: () => { ui.cheatOpen = !ui.cheatOpen; } } }],
]) {
  const filename = path.join(compiled, file);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

const { GameState } = load('game/GameState.js');
const { CheatSystem } = load('systems/CheatSystem.js');
const { HardwareInput } = load('game/InputState.js');
const { GAME_CONFIG } = load('game/GameConfig.js');
const { GUN_IDS } = load('data/weapons.js');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`OK ${name}`); passed++; }
  catch (e) { console.error(`FAIL ${name}\n${e.stack || e.message}`); failed++; }
}
const fresh = () => new GameState();

test('o cardápio cobre os quatro pedidos, não um só', () => {
  const cheat = new CheatSystem();
  const headers = cheat.grupos.map((g) => g.header);
  for (const need of ['VEÍCULOS', 'POLÍCIA', 'JOGADOR', 'CLIMA']) {
    assert.ok(headers.includes(need), `falta o grupo ${need}: o cheat deixaria de cobrir uma das áreas`);
  }
  const ids = cheat.rows().map((r) => r.id);
  for (const id of ['veiculo', 'clima', 'desastre', 'estacao', 'procurado', 'vida', 'dinheiro', 'invencivel', 'armas', 'limpar']) {
    assert.ok(ids.includes(id), `a fileira ${id} sumiu do cardápio`);
  }
});

test('um carro: o picker roda entre as opções e o confirmar estaciona o tipo certo no jogador', () => {
  const g = fresh();
  const cheat = new CheatSystem();
  const idsAntes = new Set(g.vehicles.map((v) => v.id));
  // O cardápio abre em sedan (índice 0); girar uma vez cai no segundo, girar de novo no terceiro.
  const último = () => g.vehicles[g.vehicles.length - 1];
  cheat.nudge('veiculo', 1);
  cheat.run(g, 'veiculo');
  assert.equal(último().def.type, 'taxi', 'confirmar sem girar deveria estacionar o segundo da lista');
  cheat.nudge('veiculo', 1);
  cheat.run(g, 'veiculo');
  assert.equal(último().def.type, 'hatchback', 'o giro do picker não acompanhou a seleção');
  assert.ok(!idsAntes.has(último().id), 'o cheat reciclou um id de veículo já em uso');
  assert.ok(último().x === g.player.x && último().y === g.player.y, 'o carro não nasceu ao lado do jogador');
  // ◄ devolve pela lista...
  cheat.nudge('veiculo', -1);
  cheat.nudge('veiculo', -1);
  cheat.run(g, 'veiculo');
  assert.equal(último().def.type, 'sedan', '◄ não voltou ao começo');
  // ...e ao passar do primeiro dá a volta para o fim do cardápio (helicoptero).
  cheat.nudge('veiculo', -1);
  cheat.run(g, 'veiculo');
  assert.equal(último().def.type, 'helicopter', 'o picker não fecha o círculo ao voltar do primeiro');
});

test('o clima cai do menu para o céu', () => {
  const g = fresh();
  const cheat = new CheatSystem();
  // Do limpo até a tempestade: índice 5 na escada clear,mist,clouds,drizzle,rain,storm.
  for (let i = 0; i < 5; i++) cheat.nudge('clima', 1);
  cheat.run(g, 'clima');
  assert.equal(g.weather.kind, 'storm', 'forçar tempestade não mudou a frente do tempo');
  assert.notEqual(g.weather.escalateIn, 0, 'o clima forçado deveria travar a escalada automática');
});

test('o desastre entra e o "nenhum" o tira do ar', () => {
  const g = fresh();
  const cheat = new CheatSystem();
  cheat.nudge('desastre', 1); // nenhum -> tornado
  cheat.run(g, 'desastre');
  assert.equal(g.hazard.kind, 'tornado', 'o tornado do cheat nunca nasceu');
  assert.equal(g.hazard.phase, 'active', 'o desastre forçado deveria entrar já ativo');
  cheat.nudge('desastre', -1); // volta ao "nenhum"
  cheat.run(g, 'desastre');
  assert.equal(g.hazard.kind, null, 'o "nenhum" deixou o tornado girando na cidade');
  assert.equal(g.hazard.phase, 'calm', 'limpar o desastre deveria devolver o mundo ao calmo');
});

test('a estação e o procurado saem do painel', () => {
  const g = fresh();
  const cheat = new CheatSystem();
  for (let i = 0; i < 3; i++) cheat.nudge('estacao', 1); // primavera->inverno
  cheat.run(g, 'estacao');
  assert.equal(g.weather.season, 'inverno', 'a estação do cheat não bateu no calendário do mundo');
  for (let i = 0; i < GAME_CONFIG.WANTED_MAX; i++) cheat.nudge('procurado', 1);
  cheat.run(g, 'procurado');
  assert.equal(g.player.wantedLevel, GAME_CONFIG.WANTED_MAX,
    'confirmar o procurado máximo não subiu as estrelas todas');
  cheat.run(g, 'limpar');
  assert.equal(g.player.wantedLevel, 0, 'limpar procurado deixou o jogador marcado');
});

test('o corpo do jogador: vida, dinheiro e invencibilidade', () => {
  const g = fresh();
  const cheat = new CheatSystem();
  g.player.health = 12;
  const bolso = g.player.money;
  cheat.run(g, 'vida');
  cheat.run(g, 'dinheiro');
  assert.equal(g.player.health, 100, 'vida cheia não encheu a barra');
  assert.equal(g.player.money, bolso + 50_000, 'o dinheiro não entrou no bolso');
  cheat.run(g, 'invencivel');
  assert.ok(g.player.invulnUntil === Infinity, 'o primeiro toque em invencível não ligou o escudo');
  cheat.run(g, 'invencivel');
  assert.ok(!(g.player.invulnUntil > g.time), 'o segundo toque não desligou o escudo');
});

test('as armas entram na mão e no estoque', () => {
  const g = fresh();
  const cheat = new CheatSystem();
  cheat.run(g, 'armas');
  for (const gun of GUN_IDS) {
    assert.ok(g.weapons.owned.has(gun), `o cheat deixou ${gun} de fora do arsenal`);
    assert.ok(g.weapons.ammo[gun].reserve > 0, `${gun} veio sem munição: pistola de colecionador`);
  }
});

// Entrada é o outro lado da moeda: um efeito sem tecla nem botão para chamar é meia feature.
test('o teclado (F4) e o controle (clicar o analógico direito) abrem o mesmo cheat', () => {
  const chamadas = [];
  const input = new HardwareInput(() => {}, (action) => chamadas.push(action), () => {});
  input.setSuspended(false);
  assert.ok(input.keyDown('F4'), 'o F4 não foi reclamado como tecla de menu');
  assert.deepEqual(chamadas, ['cheat'], 'F4 devia pedir o cheat ao orquestrador de menus');
  input.keyUp('F4');

  const pad = (rs) => ({
    index: 0, connected: true, mapping: 'standard', axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 16 }, (_, i) => (i === 11 ? { pressed: rs, value: rs ? 1 : 0 } : { pressed: false, value: 0 })),
  });
  chamadas.length = 0;
  // Uma leitura neutra arma o pad e libera o gate de Start/Select; a próxima, com o clique, dispara.
  input.pollGamepads([pad(false)]);
  input.pollGamepads([pad(true)]);
  assert.deepEqual(chamadas, ['cheat'], 'o clique do analógico direito não abriu o cheat');
});

test('o painel congela a cidade e o navegador de menus dirige por cima', () => {
  const store = fs.readFileSync(src('stores/useGameStore.ts'), 'utf8');
  assert.match(store, /cheatOpen: boolean/, 'o store não guarda o painel de cheat aberto');
  assert.match(store, /function toggleCheat\(\)/, 'sumiu o toggle: uma tecla teria de saber se abre ou fecha');

  const app = fs.readFileSync(path.join(root, 'App.tsx'), 'utf8');
  assert.ok(/cheatOpen \|\| overlay !== null/.test(app) || /suspended[^;]*cheatOpen/.test(app),
    'com o cheat aberto a simulação continuaria rodando atrás do painel');
  assert.match(app, /<CheatMenu \/>/, 'o CheatMenu nunca é montado: nada aparece na tela');

  const nav = fs.readFileSync(src('ui/UiNav.ts'), 'utf8');
  assert.match(nav, /'cheat'/, 'a superfície "cheat" não existe no navegador de menus');
  const prioridade = nav.match(/const PRIORITY[^=]*=\s*\[([^\]]*)\]/);
  assert.ok(prioridade, 'não achei a fila PRIORITY dos menus');
  const lista = prioridade[1];
  assert.ok(lista.indexOf('cheat') >= 0 &&
    (lista.indexOf('cheat') < lista.indexOf('pause') || lista.indexOf('pause') < 0),
    'o cheat precisa estar acima da pausa na fila de foco');

  const menu = fs.readFileSync(src('ui/CheatMenu.tsx'), 'utf8');
  assert.match(menu, /useUiSurface\('cheat'/, 'o painel não se registra como tela navegável');
  assert.match(menu, /move: \['up', 'down'\]/,
    'sem tirar ◄/► da navegação de foco, as setas andariam a lista em vez de mudar o valor');

  const input = fs.readFileSync(src('game/InputState.ts'), 'utf8');
  assert.match(input, /'map' \| 'pause' \| 'cheat'/, 'a ação de menu "cheat" sumiu do tipo');
  assert.match(input, /code === 'F4'/, 'o F4 deixou de ser tecla de cheat no teclado');
  assert.match(input, /this\.menu\('cheat'\)/, 'o controle não pede mais o cheat ao orquestrador');
});

console.log(`\n${passed} provas, ${failed} falhas`);
if (failed) process.exitCode = 1;
