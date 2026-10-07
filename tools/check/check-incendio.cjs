// Run: node tools/check/check-incendio.cjs
//
// O fogo deste jogo era um clarão de sete segundos sobre a carcaça do carro. Este arquivo cobra o
// que existe depois do clarão: um incêndio que é **lugar** (tem combustível, cresce, machuca, passa
// para o vizinho e morre quando acaba o material) e um corpo de bombeiros que é **rotina** (frota na
// porta do quartel do mapa, chamada quando vira incidente, asfalto até perto, mangueira até a boca,
// água, tanque seco, volta, enche, volta).
//
// As réguas medidas aqui são as que fazem o atendimento ser uma mecânica e não um texto:
// — a vela não despacha ninguém: só fogo com `força` de incidente tira um caminhão do quartel;
// — a água acaba antes de o fogo acabar de desejo: tanque seco recolhe a linha e manda o caminhão
//   enchê-lo no quartel, e só então ele volta PARA O MESMO fogo;
// — sem asfalto a alcance de parada não há brigada: um mato fundo queima sozinho, e isso é regra do
//   lugar, não buraco de pathfinding;
// — quem sai da folha volta para a cidade como civil, porque é esse predicado que permite ao
//   `LifeSystem` reciclar o corpo e ao `NPCSystem` andar de novo com o vivo — sem isso a população
//   vaza a cada incêndio;
// — e nada é decoração: o casaco do `DestructionSystem` e o raio do `WeatherSystem` entram por esta
//   porta, e a porta é cobrada no contrato de fonte do `GameState`.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('module');
const ts = require('typescript');
const { PNG } = require('pngjs');

const root = path.resolve(__dirname, '../..');
const src = (name) => path.join(root, 'src', name);

// O mesmo portão do `tsc`: se o sistema não compila sozinho, o resto do arquivo não prova nada.
const program = ts.createProgram([src('systems/IncendioSystem.ts')], {
  target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS,
  moduleResolution: ts.ModuleResolutionKind.Node10, strict: true, esModuleInterop: true,
  skipLibCheck: true, noEmit: true, jsx: ts.JsxEmit.ReactJSX,
});
const diagnostics = ts.getPreEmitDiagnostics(program);
if (diagnostics.length) {
  console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCurrentDirectory: () => root, getCanonicalFileName: (f) => f, getNewLine: () => '\n',
  }));
  process.exit(1);
}

/** Todo som que o sistema escreveu, para cobrar canal e ritmo em vez de confiar na intenção. */
const TOCADOS = [];
const LOOPS = [];
/** O relógio da simulação no instante em que o som foi escrito — é o que cobra o ritmo do loop. */
let agora = 0;
const dubles = new Map([
  ['audio/SoundManager.ts', {
    sound: {
      play: (key, volume) => TOCADOS.push({ key, volume, t: agora }),
      setLoop: (ch, key, volume) => LOOPS.push({ ch, key, volume, t: agora }),
    },
  }],
  ['assets/AssetRegistry.ts', { spriteKeyForVehicle: () => '' }],
]);
const modules = new Map();
function load(filename) {
  // `../audio/SoundManager` e `./Pilotagem` chegam sem extensão: quem resolve é o Metro, não o node.
  if (!path.extname(filename)) {
    for (const extensão of ['.ts', '.tsx']) {
      if (fs.existsSync(filename + extensão)) { filename += extensão; break; }
    }
  }
  const chave = filename.replace(/\\/g, '/');
  for (const [sufixo, exports] of dubles) if (chave.endsWith(sufixo)) return exports;
  if (modules.has(filename)) return modules.get(filename).exports;
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    fileName: filename,
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  });
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.require = (name) => (name.startsWith('.')
    ? load(path.resolve(path.dirname(filename), name)) : require(name));
  modules.set(filename, mod);
  mod._compile(compiled.outputText, filename);
  return mod.exports;
}

const { IncendioSystem } = load(src('systems/IncendioSystem.ts'));
const { Map: CityMap } = load(src('world/Map.ts'));
const { generateCity, WORLD_SEED } = load(src('data/maps/city.ts'));
const { CollisionSystem } = load(src('systems/CollisionSystem.ts'));
const { createPlayer } = load(src('entities/Player.ts'));
const { createVehicle } = load(src('entities/Vehicle.ts'));
const { createNPC } = load(src('entities/NPC.ts'));
const { VEHICLE_DEFS } = load(src('data/vehicles.ts'));

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`OK ${name}`);
  } catch (error) {
    failed++;
    process.exitCode = 1;
    console.error(`FAIL ${name}\n${error && error.stack ? error.stack : error}`);
  }
}

// ---- o chão do teste ----
/**
 * Uma cidade de duas avenidas em cruz, um quartel no quadrante noroeste e — quando `mata` — o
 * sudeste inteiro em mato. As medidas foram escolhidas para caber nas réguas do sistema: o fogo a
 * (36,34) tem asfalto a menos de `ALCANCE_DA_PARADA` tiles e o canto (70,70) tem a rua a ~39 tiles,
 * então um é atendível e o outro não, sem nenhum caso especial no sistema para isso.
 */
function cidade({ quartel = false, mata = false } = {}) {
  const W = 80;
  const tiles = [];
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const h = y === 30 || y === 31;
      const v = x === 30 || x === 31;
      const estrada = h || v;
      const bosque = mata && !estrada && x >= 32 && y >= 32;
      const lane = estrada && !(h && v) ? (h ? (y === 30 ? 'NW' : 'SE') : (x === 30 ? 'SW' : 'NE')) : undefined;
      tiles.push({
        kind: estrada ? 'road' : bosque ? 'grass' : 'concrete',
        key: '',
        biome: bosque ? 'forest' : 'downtown',
        lane,
      });
    }
  }
  const buildings = quartel
    ? [{ key: 'bld_firestation_a', x: 18, y: 27, footprintW: 3, footprintH: 4, tag: 'special' }] : [];
  return new CityMap({
    tilesW: W, tilesH: W, worldW: W, worldH: W, tiles, buildings, props: [],
    vehicles: [], npcSpawns: [], playerSpawn: { x: 24, y: 29.5 },
  }, []);
}

function fixture(opções = {}) {
  const mapa = opções.mapa ?? cidade({});
  let vehicleId = 100;
  let npcId = 500;
  const ocorrências = { mudanças: 0, dano: [], tremores: 0 };
  const ctx = {
    map: mapa,
    player: opções.jogador ?? createPlayer(24, 29.5),
    vehicles: [], npcs: [],
    collision: new CollisionSystem(),
    wrecks: [],
    chuva: opções.chuva ?? 0,
    time: 0,
    dano: (amount) => ocorrências.dano.push(amount),
    shake: () => { ocorrências.tremores++; },
    allocVehicleId: () => vehicleId++,
    allocNpcId: () => npcId++,
    onStructChange: () => { ocorrências.mudanças++; },
    rng: () => (opções.rng ?? 0.5),
  };
  return { s: new IncendioSystem(), ctx, mapa, ocorrências };
}

const PASSO = 1 / 30;
/**
 * O relógio do mundo é o `ctx.time` que o check escreve: o sistema usa datas absolutas (o alastre é
 * `ctx.time + 5`), então adiantar o sistema sem adiantar o relógio faria o fogo alastrar no primeiro
 * tick — exatamente o bug que a régua existe para impedir.
 */
function avançar(s, ctx, segundos, olhar) {
  const passos = Math.round(segundos / PASSO);
  for (let i = 0; i < passos; i++) {
    ctx.time += PASSO;
    agora = ctx.time;
    s.update(PASSO, ctx);
    if (olhar && olhar(ctx.time, s, ctx, i) === false) return;
  }
}

const distância = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
function carroNoLugar(id, x, y) {
  const v = createVehicle(id, VEHICLE_DEFS.sedan, '', x, y, 'SE');
  v.state = 'parked';
  return v;
}

/** O incêndio que o `DestructionSystem` deixa para trás. */
function casco(x, y) {
  return { x, y, dir: 'SE', key: null, tilt: 0, shards: [], explodedAt: 0 };
}

/**
 * Um fogo já no teto da boca. O incêndio nasce vela (raio 0,55) e leva ~9 s para encostar em 3,4;
 * as provas de calor comparam dano por segundo, e essa régua só é legível com a chama alta — sem
 * isto o check mediria o crescimento, não o fogo.
 */
function bocaCheia(f, x, y) {
  const fogo = f.s.acende(x, y, 'carro', null, f.ctx);
  fogo.raio = 3.4;
  fogo.força = 1;
  fogo.combustível = 1;
  return fogo;
}

// ---- a linha do tempo do atendimento completo ----
/**
 * Uma única simulação longa, com as marcas registradas no caminho: o atendimento tem dez etapas e
 * refazê-las dez vezes custaria dez vezes o caminho de rua. Cada prova abaixo lê a mesma linha do
 * tempo, e a linha só é construída se alguma prova pedirla.
 */
let cena = null;
function atendimentoCompleto() {
  if (cena) return cena;
  const f = fixture({ mapa: cidade({ quartel: true, mata: true }) });
  const marcas = {};
  const fogo = f.s.acende(36.5, 34.5, 'mato', null, f.ctx);
  marcas.aceso = { x: fogo.x, y: fogo.y, raio: fogo.raio, força: fogo.força, parada: !!fogo.parada };
  marcas.maxRaio = fogo.raio;
  // O atendimento é acompanhado pela VIATURA, não pela atribuição: no tick em que o fogo morre o
  // sistema solta a unidade (`u.fogo = null`), e procurá-la pelo fogo depois disso devolveria
  // `undefined` — a água do tanque que apagou o incêndio e a volta ao quartel sumiriam da linha do
  // tempo, e as duas provas abaixo mentiriam sobre um serviço que aconteceu.
  let unidade = null;
  /** A última vez em que o fogo estava vivo e a viatura tinha tanque: é a conta do apagar. */
  let naLinha = null;
  const fogosVivos = () => f.s.fogos.some((o) => o.id === fogo.id);
  avançar(f.s, f.ctx, 160, (tempo, s) => {
    if (!unidade) unidade = s.viaturas.find((c) => c.fogo === fogo.id) ?? null;
    const u = unidade;
    const lataria = u && f.ctx.vehicles.find((c) => c.id === u.vehicleId);
    if (!marcas.despachado && u && u.modo === 'a caminho') {
      marcas.despachado = { tempo, força: fogo.força, partida: distância(lataria, fogo) };
    }
    if (!marcas.emTerra && u && u.modo === 'em terra') {
      const aPé = s.bombeiros.filter((b) => {
        const n = f.ctx.npcs.find((c) => c.id === b.npcId);
        return n && !n.inVehicle;
      });
      marcas.emTerra = {
        tempo, longeDaParada: distância(lataria, u.parada), aPé: aPé.length,
        postos: aPé.map((b) => b.posto && { ...b.posto }),
      };
    }
    if (fogo.raio > marcas.maxRaio) marcas.maxRaio = fogo.raio;
    if (!marcas.jato && fogo.atacado > 0) {
      const naLinha = s.bombeiros
        .map((b) => f.ctx.npcs.find((c) => c.id === b.npcId))
        .filter((n) => !!n && !n.inVehicle && !!lataria)
        .map((n) => distância(n, lataria));
      marcas.jato = {
        tempo, água: u ? u.água : 0, homens: fogo.atacado,
        longeDaLataria: naLinha.length ? Math.max(...naLinha) : 0,
      };
      // O tanque é cortado de propósito: com três linhas abertas um incêndio deste tamanho se apaga
      // em ~6 s e o caminhão nunca chegaria seco ao quartel. O que se prova aqui é a REGRA da água
      // (seco = recolher, encher, voltar), e a única forma honesta de reachesseca sem fingir um fogo
      // de combustível infinitos é pôr o tanque no ponto em que ele ainda falta.
      if (u) u.água = Math.min(u.água, 0.05);
    }
    if (marcas.jato && !marcas.seco && u && u.água <= 0) {
      marcas.seco = { tempo, fogoVivo: fogosVivos(), raio: fogo.raio };
    }
    if (marcas.seco && !marcas.reabastecendo && u && u.modo === 'reabastecendo') {
      marcas.reabastecendo = { tempo };
    }
    if (marcas.reabastecendo && !marcas.enchendo && lataria && u && u.modo === 'reabastecendo' &&
      distância(lataria, u.home) < 2) marcas.enchendo = { tempo, água: u.água };
    if (marcas.enchendo && !marcas.cheio && u && u.água >= 1 && u.modo === 'a caminho') {
      marcas.cheio = { tempo, fogoVivo: fogosVivos() };
    }
    if (marcas.cheio && !marcas.segundoJato && fogo.atacado > 0) {
      marcas.segundoJato = { tempo, água: u ? u.água : 0 };
    }
    if (fogosVivos() && u && fogo.atacado > 0) naLinha = { água: u.água, homens: fogo.atacado };
    if (!marcas.apagado && !fogosVivos() && marcas.jato) {
      marcas.apagado = {
        tempo, água: naLinha ? naLinha.água : 0, homens: naLinha ? naLinha.homens : 0,
      };
    }
    if (marcas.apagado && !marcas.quartel && u && u.modo === 'quartel') {
      marcas.quartel = { tempo, água: u.água, tripulação: u.crew.length };
    }
    marcas.perigo = Math.max(marcas.perigo || 0, s.perigo);
    marcas.incidentes = Math.max(marcas.incidentes || 0, s.stats().incidentes);
    marcas.simulado = tempo;
    if (marcas.quartel) return false;
    return true;
  });
  marcas.tocados = TOCADOS.slice();
  marcas.loops = LOOPS.slice();
  marcas.estatísticas = f.s.stats();
  // A linha do tempo termina com o incêndio atendido apagado, e o mato que ele alastrou continua
  // queimando em outros lugares — é por isso que a conta cobrada abaixo é a lista, não o zero.
  marcas.saiuDaLista = !f.s.fogos.some((o) => o.id === fogo.id);
  marcas.alastres = f.s.fogos.length;
  cena = { ...f, marcas, fogo };
  return cena;
}

// ---- o casaco, o raio e a vela ----

test('todo casco do DestructionSystem acende um incêndio no mesmo lugar, uma única vez', () => {
  const f = fixture();
  const antes = TOCADOS.length;
  const w = casco(20.5, 20.5);
  f.ctx.wrecks.push(w);
  f.s.update(PASSO, f.ctx);
  assert.equal(f.s.fogos.length, 1, `o casco não virou incêndio: ${f.s.fogos.length} fogo(s)`);
  const fogo = f.s.fogos[0];
  assert.equal(fogo.fonte, 'carro');
  assert.equal(Math.round(fogo.x * 10) / 10, 20.5);
  assert.equal(Math.round(fogo.y * 10) / 10, 20.5);
  assert.equal(Math.round(fogo.combustível * 100) / 100, 1, 'carro que explode tem tanque, não capim');
  f.s.update(PASSO, f.ctx);
  f.s.update(PASSO, f.ctx);
  assert.equal(f.s.fogos.length, 1, 'o mesmo casco foi cobrado mais de uma vez');
  f.ctx.wrecks.push(casco(60.5, 60.5));
  f.s.update(PASSO, f.ctx);
  assert.equal(f.s.fogos.length, 2, 'um casco novo no mapa tem de acender o seu próprio fogo');
  const sons = TOCADOS.slice(antes);
  assert.ok(sons.some((t) => t.key === 'explosion'), 'o casco que explode tem de soar como explosão');
});

test('um raio no meio da cidade de concreto não acende nada', () => {
  const f = fixture({ rng: 0.5 });
  assert.equal(f.s.descarga(f.ctx), null,
    'relâmpago acendeu sobre asfalto: o chão do mapa virou decoração');
  assert.equal(f.s.fogos.length, 0);
});

test('o raio cai no mato longe do jogador, nunca em cima dele', () => {
  const jogador = createPlayer(38, 38);
  const f = fixture({ mapa: cidade({ mata: true }), jogador, rng: 0.25 });
  const fogo = f.s.descarga(f.ctx);
  assert.ok(fogo, 'com o sudeste inteiro em mato o raio não achou material nenhum');
  assert.equal(fogo.fonte, 'raio');
  const longe = distância(fogo, jogador);
  assert.ok(longe >= 26, `o raio caiu a ${longe.toFixed(1)} tiles do jogador; a coroa mínima é 26`);
});

test('chão que não arde não segura incêndio, e o mapa tem teto de fogos', () => {
  const f = fixture();
  assert.equal(f.s.acende(20.5, 20.5, 'mato', null, f.ctx), null,
    'pegou fogo sobre o concreto: a régua de combustível não está no caminho');
  assert.equal(f.s.acende(NaN, 20.5, 'mato', null, f.ctx), null);
  let acesos = 0;
  for (let i = 0; i < 20; i++) {
    const ponto = f.s.acende(40 + (i % 10), 60 + Math.floor(i / 10), 'carro', null, f.ctx);
    if (ponto) acesos++;
  }
  assert.equal(acesos, 8, 'o teto de incêndios do mapa mudou de número sem o check saber');
  assert.equal(f.s.fogos.length, 8);
});

// ---- a frota e o despacho ----

test('o gerador do mundo reserva quartel de bombeiro e a frota nasce na porta dele', () => {
  const map = new CityMap(generateCity(WORLD_SEED), []);
  const quartéis = map.landmarksOf('firestation');
  assert.ok(quartéis.length > 0, 'o gerador parou de pôr quartel de bombeiro no mapa');
  const f = fixture({ mapa: map, jogador: createPlayer(quartéis[0].front.x, quartéis[0].front.y) });
  f.s.update(PASSO, f.ctx);
  assert.equal(f.s.viaturas.length, quartéis.length,
    `um caminhão por quartel: ${f.s.viaturas.length} para ${quartéis.length} quarteis`);
  assert.equal(f.s.bombeiros.length, quartéis.length * 3,
    `tripulação de três por caminhão: ${f.s.bombeiros.length} nomes na folha`);
  for (const u of f.s.viaturas) {
    const v = f.ctx.vehicles.find((c) => c.id === u.vehicleId);
    assert.ok(v, `a viatura ${u.vehicleId} não está no mundo`);
    assert.equal(v.def.type, 'firetruck', 'o caminhão do corpo de bombeiros não é um caminhão de bombeiro');
    assert.equal(v.state, 'parked');
    assert.equal(u.modo, 'quartel');
    assert.equal(u.água, 1, 'o caminhão tem de sair do quartel com o tanque cheio');
    assert.ok(distância(v, u.home) < 0.01, 'a viatura não está na vaga do quartel');
    assert.ok(distância(v, quartéis[0].front) < 45,
      `caminhão a ${distância(v, quartéis[0].front).toFixed(0)} tiles do quartel — ninguém o veria`);
    for (const id of u.crew) {
      const n = f.ctx.npcs.find((c) => c.id === id);
      assert.ok(n && n.kind === 'bombeiro' && n.inVehicle, 'a tripulação não embarcou');
      assert.equal(n.health, 90, 'o bombeiro perdeu o equipamento de saúde que a própria classe dá');
    }
  }
});

test('fogo recém-aceso é uma vela e não tira nenhum caminhão do quartel', () => {
  const f = fixture({ mapa: cidade({ quartel: true, mata: true }) });
  const fogo = f.s.acende(36.5, 34.5, 'mato', null, f.ctx);
  assert.ok(fogo.parada, 'o fogo atendível perdeu o asfalto de parada');
  avançar(f.s, f.ctx, 1);
  assert.ok(fogo.força < 0.3, `a vela já virou incidente: força ${fogo.força.toFixed(2)}`);
  assert.equal(fogo.viatura, null);
  for (const u of f.s.viaturas) assert.equal(u.modo, 'quartel', 'um caminhão saiu para uma fogueira');
  // A mesma boca, três segundos depois: a régua é do crescimento, não de um temporizador solto.
  avançar(f.s, f.ctx, 3);
  assert.ok(fogo.força >= 0.3, `três segundos depois ainda era vela: força ${fogo.força.toFixed(2)}`);
  assert.notEqual(fogo.viatura, null, 'o incidente pegou corpo e a frota continuou em casa');
  assert.equal(f.s.viaturas[0].modo, 'a caminho');
});

test('quando vira incidente o caminhão mais perto é despachado, um por fogo', () => {
  const f = fixture({ mapa: cidade({ quartel: true, mata: true }) });
  const primeiro = f.s.acende(36.5, 34.5, 'carro', null, f.ctx);
  const segundo = f.s.acende(70.5, 70.5, 'carro', null, f.ctx);
  assert.ok(!segundo.parada, 'o canto do matagal virou atendível: a régua de asfalto mudou');
  primeiro.raio = 3.4;
  primeiro.força = 1;
  segundo.raio = 3.4;
  segundo.força = 1;
  avançar(f.s, f.ctx, 1);
  assert.equal(primeiro.viatura, f.s.viaturas[0].vehicleId, 'nenhum caminhão atendeu o incidente');
  assert.equal(segundo.viatura, null, 'um fogo sem asfalto recebeu brigada');
  assert.equal(f.s.viaturas[0].modo, 'a caminho');
  const fuma = f.s.acende(36.5, 40.5, 'carro', null, f.ctx);
  fuma.raio = 3.4;
  fuma.força = 1;
  avançar(f.s, f.ctx, 1);
  assert.equal(fuma.viatura, null, 'a única frota do mapa se dividiu em duas ocorrências');
});

// ---- a linha do tempo do atendimento ----

test('o despacho espera a boca pegar corpo e o caminhão pega a rua até a parada', () => {
  const { marcas } = atendimentoCompleto();
  assert.ok(marcas.despachado, `nenhum caminhão saiu do quartel: ${JSON.stringify(marcas.emTerra || null)}`);
  assert.ok(marcas.despachado.força >= 0.3,
    `despachou com força ${marcas.despachado.força.toFixed(2)}: a vela ganhou frota`);
  assert.ok(marcas.emTerra, 'o caminhão nunca encostou na parada');
  assert.ok(marcas.emTerra.longeDaParada <= 1.3,
    `parou a ${marcas.emTerra.longeDaParada.toFixed(2)} tiles do asfalto marcado`);
  assert.ok(marcas.emTerra.tempo > marcas.despachado.tempo, 'chegou antes de ser chamado');
});

test('a tripulação desce do caminhão e abre a linha em arco, não em monte', () => {
  const { marcas } = atendimentoCompleto();
  assert.ok(marcas.emTerra, 'não houve atendimento');
  assert.equal(marcas.emTerra.aPé, 3, `saíram ${marcas.emTerra.aPé} de três da lataria`);
  assert.ok(marcas.emTerra.postos.every(Boolean) && marcas.emTerra.postos.length === 3);
  const postos = marcas.emTerra.postos;
  const maisPerto = Math.min(distância(postos[0], postos[1]), distância(postos[1], postos[2]),
    distância(postos[0], postos[2]));
  assert.ok(maisPerto > 0.4,
    `os três postos caem no mesmo ponto (${maisPerto.toFixed(2)} tiles): um monte de homem molha uma pedra`);
});

test('a mangueira é o alcance do posto: nenhum homem trabalha fora da linha', () => {
  const { marcas } = atendimentoCompleto();
  assert.ok(marcas.jato, 'a linha nunca abriu o jato');
  // MANGUEIRA = 9 tiles no sistema; o posto é puxado para a ponta da linha quando a boca está longe.
  assert.ok(marcas.jato.longeDaLataria <= 9.6,
    `o homem mais afastado estava a ${marcas.jato.longeDaLataria.toFixed(1)} tiles do caminhão`);
});

test('a água come o combustível e derruba a boca mais rápido do que ela cresce', () => {
  const { marcas, fogo } = atendimentoCompleto();
  assert.ok(marcas.jato, 'não houve jato');
  assert.ok(marcas.jato.água < 1, `o jato abriu com o tanque em ${marcas.jato.água}`);
  assert.ok(marcas.seco, 'o tanque nunca esvaziou com três linhas abertas');
  assert.ok(marcas.seco.fogoVivo, 'o fogo morreu antes do tanque: não há o que a volta prove');
  assert.ok(marcas.seco.raio < marcas.maxRaio,
    `a boca fechou o atendimento maior do que abriu (${marcas.seco.raio.toFixed(2)} de ${marcas.maxRaio.toFixed(2)}): a água não derruba nada`);
});

test('tanque seco recolhe a linha, enche no quartel e volta para o MESMO fogo', () => {
  const { marcas } = atendimentoCompleto();
  assert.ok(marcas.reabastecendo, 'sem água o caminhão não saiu do incêndio');
  assert.ok(marcas.enchendo, 'a volta ao quartel não aconteceu');
  assert.ok(marcas.cheio, `o tanque nunca encheu: ${JSON.stringify(marcas.enchendo || null)}`);
  assert.ok(marcas.cheio.fogoVivo, 'voltou para molhar cinza: o fogo já estava morto na espera');
  assert.ok(marcas.segundoJato.tempo > marcas.cheio.tempo, 'encheu e não voltou a atacar');
  assert.ok(marcas.segundoJato.água > 0.2, 'a segunda linha abriu com o tanque quase seco');
});

test('a água apaga o incêndio, o fogo sai da lista e o caminhão volta para o quartel', () => {
  const { marcas } = atendimentoCompleto();
  assert.ok(marcas.apagado, `o incêndio não foi apagado: ${JSON.stringify(marcas.quartel || null)}`);
  assert.ok(marcas.apagado.água > 0, 'apagou o fogo com o tanque seco: as contas divergem');
  assert.ok(marcas.apagado.homens > 0,
    'nenhum jato estava aberto no último instante do fogo: ele morreu de velho, não de água');
  assert.ok(marcas.quartel, 'a viatura não voltou ao modal de quartel depois do serviço');
  assert.equal(marcas.quartel.tripulação, 3, 'a tripulação não voltou completa');
  assert.ok(marcas.saiuDaLista,
    'o incêndio apagado continuou na lista: a HUD seguiria contando um fogo que já é cinza');
  assert.equal(marcas.estatísticas.bombeiros, 3,
    `a folha de serviço tem ${marcas.estatísticas.bombeiros} nomes para uma tripulação de três: cada atendimento vazaria ou duplicaria gente`);
  assert.equal(marcas.estatísticas.viaturas, 1, 'a frota da cidade mudou de tamanho por apagar um fogo');
  assert.equal(marcas.perigo > 0, true, 'o maior incêndio vivo nunca apareceu no número que a HUD lê');
});

// ---- o que não é atendível, a chuva e o vizinho ----

test('incêndio no matagal fundo queima sozinho, sem brigada e sem caminhão atolado', () => {
  const f = fixture({ mapa: cidade({ quartel: true, mata: true }) });
  const fogo = f.s.acende(70.5, 70.5, 'mato', null, f.ctx);
  assert.equal(fogo.parada, null, 'o matagal fundo ganhou asfalto de parada');
  avançar(f.s, f.ctx, 40);
  assert.ok(f.s.fogos.length === 0 || fogo.viatura === null, 'a brigada foi a pé pelo mato');
  for (const u of f.s.viaturas) assert.equal(u.modo, 'quartel', 'um caminhão saiu para um fogo sem rua');
  assert.ok(fogo.combustível > 0, `o mato fundo se apagou sozinho em menos de 40 s (${fogo.combustível})`);
  const antes = fogo.combustível;
  avançar(f.s, f.ctx, 60);
  assert.ok(fogo.combustível < antes, 'um fogo que ninguém atende não queima nada: é um desenho');
  assert.equal(fogo.raio <= 3.4, true, 'a boca passou o teto de uma quadra');
});

test('a chuva derruba o teto da chama e come o combustível mais rápido', () => {
  const mede = (chuva) => {
    const f = fixture({ chuva });
    const fogo = f.s.acende(20.5, 20.5, 'carro', null, f.ctx);
    let maxRaio = 0;
    let vida = 0;
    avançar(f.s, f.ctx, 90, (tempo, s) => {
      maxRaio = Math.max(maxRaio, fogo.raio);
      if (!s.fogos.some((o) => o.id === fogo.id)) { vida = tempo; return false; }
      return true;
    });
    return { maxRaio, vida };
  };
  const seco = mede(0);
  const molhado = mede(1);
  assert.ok(seco.vida > 0, 'em tempo seco o fogo do carro nunca se apagou');
  assert.ok(molhado.vida > 0, 'na tempestade o fogo não se apagou sozinho');
  assert.ok(molhado.vida < seco.vida * 0.5,
    `chuva forte apaga em ${molhado.vida.toFixed(0)} s contra ${seco.vida.toFixed(0)} s: a água não muda nada`);
  assert.ok(molhado.maxRaio < seco.maxRaio * 0.75,
    `a boca molhada chegou a ${molhado.maxRaio.toFixed(2)} contra ${seco.maxRaio.toFixed(2)}`);
});

test('fogo forte passa para o carro ao lado', () => {
  const f = fixture({ mapa: cidade({ mata: true }) });
  const alvo = carroNoLugar(77, 40.5, 42.5);
  f.ctx.vehicles.push(alvo);
  const fogo = f.s.acende(40, 40, 'mato', null, f.ctx);
  avançar(f.s, f.ctx, 8);
  assert.ok(fogo.força >= 0.3, `força ${fogo.força.toFixed(2)} aos 8 s: o fogo nunca virou incidente`);
  const cadeia = f.s.fogos.find((o) => o.veículo === alvo.id);
  assert.ok(cadeia, 'um carro estacionado a 2,5 tiles de uma boca cheia não pegou');
  assert.equal(cadeia.combustível > 0, true);
});

test('o mato aceso avança para o mato vizinho em vez de só encolher no centro', () => {
  // rng 0.25 → o alastre aponta para o sul, onde há mato; 0.5 apontaria para o asfalto e seria
  // correto não alastrar. A régua é a mesma, o que muda é o chão.
  const f = fixture({ mapa: cidade({ mata: true }), rng: 0.25 });
  const fogo = f.s.acende(45, 45, 'mato', null, f.ctx);
  avançar(f.s, f.ctx, 12);
  assert.ok(f.s.fogos.length >= 2, `o incêndio não saiu do próprio ponto: ${f.s.fogos.length} fogo(s)`);
  const novo = f.s.fogos.find((o) => o.id !== fogo.id);
  assert.equal(novo.fonte, 'mato', 'o fogo rasteiro virou outra coisa ao andar');
  assert.ok(distância(novo, fogo) > 1, 'o progresso do fogo é um salto, não um passo de frente');
});

test('o carro que é a fonte do fogo queima o dobro do vizinho', () => {
  const f = fixture({ mapa: cidade({ mata: true }) });
  const fonte = carroNoLugar(71, 40.5, 40.5);
  const vizinho = carroNoLugar(72, 39.5, 39.5);
  f.ctx.vehicles.push(fonte, vizinho);
  const fogo = f.s.acende(40, 40, 'carro', fonte.id, f.ctx);
  assert.equal(fogo.veículo, fonte.id);
  avançar(f.s, f.ctx, 3);
  const perdaFonte = 100 - fonte.health;
  const perdaVizinho = 100 - vizinho.health;
  assert.ok(perdaFonte > 0 && perdaVizinho > 0, `fogo que não queima lataria: ${perdaFonte}/${perdaVizinho}`);
  const razão = perdaFonte / perdaVizinho;
  assert.ok(razão > 1.85 && razão < 2.15, `o carro-fonte queimou ${razão.toFixed(2)}x o vizinho, não 2x`);
});

// ---- o dano nas pessoas ----

test('a pé o jogador leva o calor da boca; dentro da lataria, não', () => {
  const cenário = (dentro) => {
    const jogador = createPlayer(20.5, 20.5);
    if (dentro) jogador.currentVehicleId = 999;
    const f = fixture({ jogador });
    const fogo = bocaCheia(f, 20.5, 20.5);
    avançar(f.s, f.ctx, 1);
    return { f, fogo };
  };
  const aPé = cenário(false);
  assert.ok(aPé.f.ocorrências.dano.length > 0, 'um jogador dentro da boca não sente o fogo');
  const total = aPé.f.ocorrências.dano.reduce((m, n) => m + n, 0);
  assert.ok(total > 20 && total < 28, `dano de 1 s em boca cheia foi ${total.toFixed(1)}, não ~24`);
  const dentro = cenário(true);
  assert.equal(dentro.f.ocorrências.dano.length, 0, 'a lataria não protege ninguém do calor');
  assert.ok(aPé.f.ocorrências.tremores > 0, 'incidente grande não empurra a câmera');
});

test('o fogo derruba o pedestre e abre a janela do resgate antes de matar', () => {
  const f = fixture();
  const npc = createNPC(900, 'a', 20.5, 20.5, 'civ', () => 0.5);
  f.ctx.npcs.push(npc);
  f.s.acende(20.5, 20.5, 'carro', null, f.ctx);
  let caído = null;
  let morto = null;
  avançar(f.s, f.ctx, 12, (tempo) => {
    if (!caído && npc.health <= 0) caído = { tempo, state: npc.state, dead: npc.dead };
    if (!morto && npc.dead) morto = { tempo, health: npc.health };
    return true;
  });
  assert.ok(caído, 'o pedestre queimado nunca foi para o chão');
  assert.equal(caído.state, 'knocked', `saiu da boca da vida em ${caído.state}: não há resgate`);
  assert.equal(caído.dead, false);
  assert.ok(morto, 'a queimadura não mata: o fogo é inofensivo');
  assert.ok(morto.tempo - caído.tempo > 0.8,
    `morreu ${morto.tempo - caído.tempo} s depois de cair: a janela do SAMU não existe`);
});

test('bombeiro tem equipamento: aguenta mais que o pedestre na mesma boca', () => {
  const cenário = (kind) => {
    const f = fixture();
    const npc = createNPC(901, 'a', 20.5, 20.5, kind, () => 0.5);
    f.ctx.npcs.push(npc);
    bocaCheia(f, 20.5, 20.5);
    let caído = 0;
    avançar(f.s, f.ctx, 30, (tempo) => {
      if (!caído && npc.health <= 0) caído = tempo;
      return !caído;
    });
    return caído;
  };
  const civil = cenário('civ');
  const bombeiro = cenário('bombeiro');
  assert.ok(civil > 0 && bombeiro > 0, `ninguém caiu em 30 s de boca cheia: civil ${civil}, bombeiro ${bombeiro}`);
  assert.ok(bombeiro > civil * 1.5,
    `bombeiro caiu em ${bombeiro.toFixed(1)} s e o civil em ${civil.toFixed(1)} s: a roupa não vale nada`);
});

test('bombeiro morto em serviço sai da folha e volta para a cidade como civil', () => {
  const f = fixture({ mapa: cidade({ quartel: true, mata: true }) });
  f.s.update(PASSO, f.ctx);
  const vítima = f.ctx.npcs.find((n) => n.kind === 'bombeiro');
  const dono = f.s.bombeiros.find((b) => b.npcId === vítima.id);
  const viatura = f.s.viaturas.find((u) => u.vehicleId === dono.viatura);
  assert.equal(viatura.crew.length, 3);
  vítima.health = 0;
  vítima.dead = true;
  vítima.state = 'dead';
  f.s.update(PASSO, f.ctx);
  assert.equal(f.s.bombeiros.some((b) => b.npcId === vítima.id), false, 'o corpo ficou na folha de serviço');
  assert.equal(viatura.crew.length, 2, 'a tripulação não abriu a vaga do morto');
  assert.equal(vítima.kind, 'civ',
    'o cadáver de um bombeiro continua "bombeiro": o LifeSystem não recicla e a população vaza');
});

test('caminhão roubado não encerra o corpo de bombeiros: a tripulação é devolvida e o quartel repõe', () => {
  const f = fixture({ mapa: cidade({ quartel: true, mata: true }) });
  f.s.update(PASSO, f.ctx);
  const u = f.s.viaturas[0];
  const v = f.ctx.vehicles.find((c) => c.id === u.vehicleId);
  const tripulação = u.crew.slice();
  f.ctx.player.currentVehicleId = v.id;
  f.s.update(PASSO, f.ctx);
  assert.equal(f.s.viaturas.some((c) => c.vehicleId === v.id), false, 'a lataria roubada continuou na frota');
  assert.equal(f.s.bombeiros.filter((b) => b.viatura === v.id).length, 0, 'a folha segue servindo um caminhão que não existe');
  for (const id of tripulação) {
    const n = f.ctx.npcs.find((c) => c.id === id);
    assert.equal(n.kind, 'civ',
      `o bombeiro ${n.id} ficou profissional sem viatura: ninguém mais o dirige, ele é uma estátua na rua`);
    assert.equal(n.inVehicle, false);
  }
  // A ordem é esta porque é a ordem do mundo: o quartel leva `REPOSIÇÃO_S` para pôr outro caminhão
  // na vaga, e uma ocorrência aceso antes disso não tem mesmo quem atenda. Cobrar as duas coisas no
  // mesmo minuto seria esconder a régua da reposição atrás de uma corrida contra o relógio.
  avançar(f.s, f.ctx, 60);
  assert.equal(f.s.viaturas.length, 1, 'o quartel não pôs outro caminhão na vaga do perdido');
  const novo = f.s.viaturas[0];
  assert.equal(novo.quartel, u.quartel, 'a reposição veio de outro quartel');
  assert.equal(novo.crew.length, 3, `a frota voltou com ${novo.crew.length} nomes`);
  assert.notEqual(novo.vehicleId, v.id);
  assert.equal(novo.água, 1, 'a frota reposta saiu do quartel sem tanque: não apagaria nada');
  const fogo = f.s.acende(36.5, 34.5, 'mato', null, f.ctx);
  fogo.raio = 3.4;
  fogo.força = 1;
  avançar(f.s, f.ctx, 2);
  assert.ok(novo.modo !== 'quartel', 'a frota reposta nunca foi chamada para o fogo que apareceu');
  assert.equal(fogo.viatura, novo.vehicleId, 'a reposição atendeu outra ocorrência que não o incêndio');
});

// ---- o som e o contrato de fonte ----

test('a sirene do incêndio toca no canal do alarme, nunca no canal da polícia', () => {
  const { marcas } = atendimentoCompleto();
  const escritos = marcas.loops;
  assert.ok(escritos.length > 0, 'nenhum volume foi escrito no alto-falante do atendimento');
  for (const l of escritos) {
    assert.equal(l.ch, 'alarme', `o incêndio tocou no canal ${l.ch} — dividiria o alto-falante com a ronda`);
    if (l.key !== null) assert.equal(l.key, 'siren');
    assert.ok(l.volume >= 0 && l.volume <= 0.5, `volume de sirene ${l.volume}`);
  }
  assert.ok(escritos.some((l) => l.key === 'siren' && l.volume > 0), 'a sirene nunca tocou durante o atendimento');
  // Ritmo, não tick: o canal é escrito no máximo a cada 0,3 s de simulação…
  assert.ok(escritos.length <= marcas.simulado / 0.3 + 2,
    `${escritos.length} escritas em ${marcas.simulado.toFixed(0)} s: a HUD não pode acompanhar isso`);
  // …e mudez de verdade: depois que a viatura encostou no quartel, o alto-falante não é escrito
  // outra vez. Reescrever o mesmo zero é chamada nativa por nada, e é isto que mantém a cidade
  // calada o resto da sessão sem gastar nada por quadro.
  const depois = escritos.filter((l) => l.t > marcas.quartel.tempo + 0.01);
  assert.equal(depois.length, 0,
    `${depois.length} escritas depois do fim do serviço: o alarme continua cutucando o áudio de um atendimento que acabou`);
});

test('a linha aberta faz barulho de água e a vela do raio não faz estampido', () => {
  const { marcas } = atendimentoCompleto();
  assert.ok(marcas.tocados.some((t) => t.key === 'piranhaSplash'),
    'a mangueira abriu sem som nenhum: a cena não existe para quem ouve');
  // O jogador está no meio do mato de propósito: a coroa do raio é sorteada a partir dele, e com o
  // `rng` fixo as seis tentativas varrem só uma direção — do asfalto, nenhuma cairia em combustível e
  // a prova mediria um `null`, não o silêncio de um fogo de relâmpago.
  const f = fixture({
    mapa: cidade({ mata: true }), jogador: createPlayer(40, 40), rng: 0.25,
  });
  const antes = TOCADOS.length;
  const fogo = f.s.descarga(f.ctx);
  assert.ok(fogo, 'o relâmpago não achou o mato que está em volta dele');
  assert.equal(fogo.fonte, 'raio');
  f.s.update(PASSO, f.ctx);
  assert.equal(TOCADOS.slice(antes).some((t) => t.key === 'explosion'), false,
    'um raio no mato soou como carro explodindo');
});

test('nada é decoração: o GameState liga o casco, o trovão e o tick do incêndio', () => {
  const código = fs.readFileSync(src('game/GameState.ts'), 'utf8');
  const chama = código.indexOf('this.incendio.update(dt, this.incendioContext(outdoorPlayer, !!room))');
  const colhe = código.indexOf('this.destruction.update(dt, {');
  assert.ok(chama > 0, 'o IncendioSystem não é percorrido no tick do mundo');
  assert.ok(colhe > 0 && chama > colhe,
    'o incêndio é atualizado antes do DestructionSystem: o casco pegaria fogo um tick atrasado');
  assert.ok(/incendioContext\(player = this\.player, dentroDeSala = false\)/.test(código),
    'o contexto do incêndio perdeu a trava de sala');
  assert.ok(/wrecks: this\.destruction\.wrecks/.test(código),
    'o contexto não entrega os cascos: o fogo deixou de ser consequência da explosão');
  assert.ok(/dano: \(amount\) => \{ if \(!dentroDeSala\)/.test(código),
    'o dano do fogo não respeita a sala: quem está dentro de um quarto estaria queimando');
  const trovão = código.indexOf('private trovão()');
  assert.ok(trovão > 0 && código.slice(trovão, trovão + 400).includes('this.incendio.descarga('),
    'o raio do clima parou de acender o mundo');
  assert.ok(/new WeatherSystem\(\(\) => this\.trovão\(\)\)/.test(código),
    'o WeatherSystem voltou a tocar o trovão sozinho: o relâmpago não incendeia mais nada');
});

test('a posse do profissional é o predicado, não o nome da classe', () => {
  const NPC = fs.readFileSync(src('entities/NPC.ts'), 'utf8');
  assert.match(NPC, /export type NPCKind = 'civ' \| 'cop' \| 'bombeiro'/,
    'o bombeiro não é um tipo de NPC reconhecido pela cidade');
  const pares = [
    ['systems/NPCSystem.ts', /npc\.kind !== 'civ'/],
    ['systems/LifeSystem.ts', /npc\.kind !== 'civ'/],
    ['systems/TrafficSystem.ts', /n\.kind === 'civ'/],
    ['game/GameState.ts', /npc\.kind !== 'civ'/],
  ];
  for (const [arquivo, régua] of pares) {
    const código = fs.readFileSync(src(arquivo), 'utf8');
    assert.ok(régua.test(código),
      `${arquivo} voltou a decidir por nome de classe: um novo serviço seria sequestrado pela multidão`);
  }
});

test('o bombeiro tem uniforme no quadro: tinta medida, chave de sprite e fila de render', () => {
  const pasta = path.join(root, 'assets/sprites/Characters');
  for (const dir of ['NE', 'NW', 'SE', 'SW']) {
    const arquivos = [`char_bombeiro_idle_${dir}_f01.png`,
      ...[1, 2, 3, 4].map((n) => `char_bombeiro_walk_${dir}_f${String(n).padStart(2, '0')}.png`)];
    for (const file of arquivos) {
      assert.ok(fs.existsSync(path.join(pasta, file)), `falta o sprite ${file}: o bombeiro desenharia pedestre`);
    }
  }
  const manifesto = fs.readFileSync(src('assets/AssetManifest.ts'), 'utf8');
  assert.match(manifesto, /"Characters\/char_bombeiro_idle_SE_f01\.png"/,
    'o gerador de manifest não viu os uniformes: o boot nunca carregaria o bombeiro');
  const reg = fs.readFileSync(src('assets/AssetRegistry.ts'), 'utf8');
  assert.ok(/export function bombeiroCharacterKey/.test(reg),
    'sumiu a chave do uniforme: o corpo do bombeiro voltou a ser o do pedestre');
  const render = fs.readFileSync(src('render/entityImages.ts'), 'utf8');
  assert.ok(/npc\.kind === 'bombeiro' \? bombeiroCharacterKey/.test(render),
    'a fila de entidades não pergunta o `kind` do bombeiro: ele é um pedestre de uniforme na tela');

  // Tinta, não nome de arquivo: os quatro passos acima passam com um PNG copiado do pedestre. O que
  // faz do sprite um uniforme é a coroa do capacete amarelo — as filas y 2..4, o topo do corpo, que é
  // a única parte que sobrevive ao tint de noite e à névoa da moldura. A faixa para na y 4 de
  // propósito: a partir da y 5 começa a cara, e o tom de pele já bate nos limiares do amarelo.
  // Medir a cara igualaria as duas brigadas — é exatamente o pixel (13,5) do policial. Comparado
  // com a polícia, que pinta a coroa de azul-marinho, o amarelo tem de existir na coroa e não existir
  // na do policial.
  const amarela = (file) => {
    const im = PNG.sync.read(fs.readFileSync(path.join(pasta, file)));
    let n = 0;
    for (let y = 2; y <= 4; y++) {
      for (let x = 0; x < im.width; x++) {
        const i = (y * im.width + x) * 4;
        if (im.data[i + 3] < 50) continue;
        if (im.data[i] > 150 && im.data[i + 1] > 100 && im.data[i + 2] < 90) n++;
      }
    }
    return n;
  };
  assert.ok(amarela('char_bombeiro_idle_SE_f01.png') >= 8,
    'o capacete do bombeiro não é amarelo em nenhum pixel da cabeça: é um pedestre com nome de bombeiro');
  assert.equal(amarela('char_police_idle_SE_f01.png'), 0,
    'a polícia também tem capacete amarelo: as duas brigadas seriam a mesma mancha na tela');
});

console.log(`\n${passed} provas, ${failed} falhas`);
if (failed) process.exitCode = 1;
