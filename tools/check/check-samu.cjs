// Run: node tools/check/check-samu.cjs
//
// Este arquivo cobra o que o pedido do jogador pediu e a tela ainda não entregava: quando alguém cai
// no chão da cidade, existe um resgate que ATRAVESSA a rua para chegar nele. Não é texto na HUD — é
// uma ambulância que sai do hospital, um paramédico que desce e anda até o corpo, e um relógio de
// hemorragia que decide se aquela pessoa levanta ou morre ali. Se o SAMU não aparecer, "gente que não
// devia morrer" continua sendo só uma frase.
//
// As réguas medidas aqui são as que fazem o socorro ser mecânica:
// — a frota nasce PARADA na porta de um hospital do mapa, com tripulação de `paramedico` dentro;
// — um civil caído perto do asfalto é registrado e despacha UMA ambulância; crítico (vida <= 0) sangra
//   e morre sem resgate, leve levanta sozinho;
// — sem asfalto a alcance de parada não há hemorragia nenhuma: o SAMU não pune a topografia;
// — a maca chega a pé, aplica `TEMPO_DO_SOCORRO`, e devolve a pessoa ao mundo VIVA (vida restaurada,
//   de pé, de volta a civil) — é isto que "não devia morrer" significa no código;
// — quem cai do serviço volta para a cidade como civil, para o `LifeSystem` reciclar sem esvaziar a
//   população;
// — a sirene do resgate toca no canal `socorro`, separado do `siren` da polícia e do `alarme` do fogo,
//   senão dois atendimentos se calariam no mesmo tick;
// — e o uniforme é tinta medida no quadro: boné verde e jaleco branco, distintos do amarelo do bombeiro.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('module');
const ts = require('typescript');
const { PNG } = require('pngjs');

const root = path.resolve(__dirname, '../..');
const src = (name) => path.join(root, 'src', name);

// O mesmo portão do `tsc`: se o sistema não compila sozinho, o resto do arquivo não prova nada.
const program = ts.createProgram([src('systems/SamuSystem.ts')], {
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

const { SamuSystem } = load(src('systems/SamuSystem.ts'));
const { Map: CityMap } = load(src('world/Map.ts'));
const { generateCity, WORLD_SEED } = load(src('data/maps/city.ts'));
const { CollisionSystem } = load(src('systems/CollisionSystem.ts'));
const { createPlayer } = load(src('entities/Player.ts'));
const { createNPC } = load(src('entities/NPC.ts'));

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
 * Uma cidade de duas avenidas em cruz, um hospital no quadrante noroeste e — quando `mata` — o sudeste
 * inteiro em mato. As medidas cabem nas réguas: um caído em (26,32.5) tem asfalto a menos de
 * `ALCANCE_DA_PARADA` tiles e o canto (70,70) tem a rua a ~40 tiles, então um é atendível e o outro
 * não, sem nenhum caso especial no sistema para isso — é a topografia quem decide.
 */
function cidade({ hospital = false, mata = false } = {}) {
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
  const buildings = hospital
    ? [{ key: 'bld_hospital_a', x: 18, y: 27, footprintW: 3, footprintH: 4, tag: 'special' }] : [];
  return new CityMap({
    tilesW: W, tilesH: W, worldW: W, worldH: W, tiles, buildings, props: [],
    vehicles: [], npcSpawns: [], playerSpawn: { x: 24, y: 29.5 },
  }, []);
}

function fixture(opções = {}) {
  const mapa = opções.mapa ?? cidade({});
  let vehicleId = 100;
  let npcId = 500;
  let mudanças = 0;
  const ctx = {
    map: mapa,
    player: opções.jogador ?? createPlayer(24, 29.5),
    vehicles: [], npcs: [],
    collision: new CollisionSystem(),
    allocVehicleId: () => vehicleId++,
    allocNpcId: () => npcId++,
    onStructChange: () => { mudanças++; },
    rng: () => (opções.rng ?? 0.5),
  };
  return { s: new SamuSystem(), ctx, mapa, mudanças: () => mudanças };
}

const PASSO = 1 / 30;
/** O relógio do mundo só existe para o ritmo do som: o SAMU usa duração (sangramento, atendimento),
 *  não datas absolutas, então adiantar o sistema sem adiantar `agora` não mudaria a mecânica. */
function avançar(s, ctx, segundos, olhar) {
  const passos = Math.round(segundos / PASSO);
  for (let i = 0; i < passos; i++) {
    agora += PASSO;
    s.update(PASSO, ctx);
    if (olhar && olhar(agora, s, ctx, i) === false) return;
  }
}

const distância = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/** Um civil já caído no chão, com a vida que o caso pede. `knocked` é o gatilho do SAMU. */
function caído(id, x, y, health) {
  const npc = createNPC(id, 'a', x, y, 'civ', () => 0.5);
  npc.state = 'knocked';
  npc.health = health;
  npc.downTimer = 6;
  npc.inVehicle = false;
  return npc;
}

// ---- a linha do tempo do resgate completo ----
/**
 * Uma única simulação longa, com as marcas registradas no caminho: o socorro tem etapas e refazê-las
 * dez vezes custaria dez caminhos de rua. Cada prova abaixo lê a mesma linha do tempo, e a linha só é
 * construída se alguma prova pedirla.
 */
let cena = null;
function resgateCompleto() {
  if (cena) return cena;
  const f = fixture({ mapa: cidade({ hospital: true, mata: true }) });
  const marcas = {};
  // Arma a frota primeiro para poder pôr o corpo a uma curta distância do hospital — não por trapaça,
  // mas porque é ESSA a régua: um crítico sangra por ~30 s e a ambulância só o salva se a resposta
  // couber nesse tempo. Um corpo longe demais morre no chão (é o caso honesto que a hemorragia existe
  // para produzir, e que a prova do "sem socorro" cobra). Aqui o que se quer ver é o resgate FECHAR.
  f.s.update(PASSO, f.ctx);
  const base = f.s.viaturas[0].home;
  const vítima = caído(700, base.x + 6, 30, -20); // crítico a ~6 tiles da vaga: a lataria dirige e chega
  f.ctx.npcs.push(vítima);
  // O corpo de um desmaio leve no matagal fundo: sem rua perto, o SAMU não pode chegar, e por
  // isso também não sangra. É o caso "ninguém veio" honesto, não um castigo pela geografia.
  const perdido = caído(701, 70, 70, 30);
  f.ctx.npcs.push(perdido);
  marcas.aceso = { crítica: null, leve: null };

  let unidade = null;
  const vivo = (npc) => {
    const n = f.ctx.npcs.find((c) => c.id === npc.id);
    return !!n && !n.dead;
  };
  avançar(f.s, f.ctx, 240, (tempo, s) => {
    if (!unidade) unidade = s.viaturas.find((c) => c.vítima === vítima.id) ?? null;
    const u = unidade;
    const lataria = u && f.ctx.vehicles.find((c) => c.id === u.vehicleId);

    if (marcas.aceso.crítica === null) {
      const reg = s.vítimas.find((v) => v.npcId === vítima.id);
      const leve = s.vítimas.find((v) => v.npcId === perdido.id);
      if (reg && leve) {
        marcas.aceso.crítica = reg.crítica;
        marcas.aceso.leve = leve.crítica;
        marcas.aceso.paradaDaLeve = !!leve.parada;
      }
    }
    if (!marcas.despachado && u && u.modo === 'a caminho') {
      marcas.despachado = { tempo, partida: distância(lataria, vítima) };
    }
    if (!marcas.emTerra && u && u.modo === 'em terra') {
      const aPé = s.paramédicos.filter((p) => {
        const n = f.ctx.npcs.find((c) => c.id === p.npcId);
        return n && !n.inVehicle;
      });
      marcas.emTerra = {
        tempo, longeDaParada: distância(lataria, u.parada), aPé: aPé.length,
        tripulação: u.crew.length,
      };
    }
    const maca = f.ctx.npcs.find((n) => s.paramédicos.some((p) => p.npcId === n.id && p.alvo === vítima.id));
    if (marcas.maca === undefined) marcas.maca = 0;
    if (maca && !marcas.juntoDoCorpo) {
      marcas.juntoDoCorpo = { tempo, longeDoCorpo: distância(maca, vítima) };
    }
    const reg = s.vítimas.find((v) => v.npcId === vítima.id);
    if (reg) marcas.atendimentoMáx = Math.max(marcas.atendimentoMáx || 0, reg.atendimento);
    if (!marcas.socorrida && s.resgatadas > 0) {
      marcas.socorrida = {
        tempo, state: vítima.state, health: vítima.health,
        naFolha: s.vítimas.some((v) => v.npcId === vítima.id),
      };
    }
    if (marcas.socorrida && !marcas.deVolta && u && u.modo === 'de volta') {
      marcas.deVolta = { tempo, aPé: s.paramédicos.filter((p) => {
        const n = f.ctx.npcs.find((c) => c.id === p.npcId);
        return n && !n.inVehicle;
      }).length };
    }
    if (marcas.deVolta && !marcas.noHospital && u && u.modo === 'hospital' && lataria &&
      distância(lataria, u.home) < 2) {
      marcas.noHospital = { tempo, tripulação: u.crew.length, vivo: vivo(vítima) };
    }
    marcas.incidentesMáx = Math.max(marcas.incidentesMáx || 0, s.stats().vítimas);
    marcas.simulado = tempo;
    if (marcas.noHospital) return false;
    return true;
  });
  marcas.tocados = TOCADOS.slice();
  marcas.loops = LOOPS.slice();
  marcas.estatísticas = f.s.stats();
  marcas.continuaViva = vivo(vítima) && vítima.state !== 'knocked';
  // O desmaio leve do mato nunca entrou na hemorragia (sem rua) e se levanta sozinho: é o
  // `NPCSystem` quem devolve a pessoa ao andar, e o SAMU apenas a riscaria da folha.
  marcas.leveSaiuDaFolha = !f.s.vítimas.some((v) => v.npcId === perdido.id);
  cena = { ...f, marcas, vítima, perdido };
  return cena;
}

// ---- a frota no hospital ----

test('o gerador do mundo reserva hospital e a frota nasce na porta dele', () => {
  const map = new CityMap(generateCity(WORLD_SEED), []);
  const hospitais = map.landmarksOf('hospital');
  assert.ok(hospitais.length > 0, 'o gerador parou de pôr hospital no mapa: não há para quem voltar');
  const f = fixture({ mapa: map, jogador: createPlayer(hospitais[0].front.x, hospitais[0].front.y) });
  f.s.update(PASSO, f.ctx);
  assert.equal(f.s.viaturas.length, hospitais.length,
    `uma ambulância por hospital: ${f.s.viaturas.length} para ${hospitais.length} hospitais`);
  assert.equal(f.s.paramédicos.length, hospitais.length * 2,
    `tripulação de dois por ambulância: ${f.s.paramédicos.length} nomes na folha`);
  for (const u of f.s.viaturas) {
    const v = f.ctx.vehicles.find((c) => c.id === u.vehicleId);
    assert.ok(v, `a ambulância ${u.vehicleId} não está no mundo`);
    assert.equal(v.def.type, 'ambulance', 'o veículo do SAMU não é uma ambulância');
    assert.equal(v.state, 'parked', 'a ambulância não está parada na vaga');
    assert.equal(u.modo, 'hospital');
    assert.ok(distância(v, u.home) < 0.01, 'a ambulância não está na vaga do hospital');
    assert.ok(distância(v, hospitais[0].front) < 45,
      `ambulância a ${distância(v, hospitais[0].front).toFixed(0)} tiles do hospital — ninguém a veria na porta`);
    for (const id of u.crew) {
      const n = f.ctx.npcs.find((c) => c.id === id);
      assert.ok(n && n.kind === 'paramedico' && n.inVehicle, 'a tripulação não embarcou como paramédico');
      assert.equal(n.health, 80, 'o paramédico perdeu o equipamento de saúde que a própria classe dá');
    }
  }
});

// ---- a varredura do chão: o gatilho ----

test('um civil caído ao lado do asfalto é registrado como ocorrência crítica', () => {
  const f = fixture({ mapa: cidade({ hospital: true }) });
  f.ctx.npcs.push(caído(800, 26, 32.5, -12));
  f.s.update(PASSO, f.ctx);
  assert.equal(f.s.vítimas.length, 1, 'o corpo no chão não virou ocorrência');
  const v = f.s.vítimas[0];
  assert.equal(v.crítica, true, 'um caído com vida negativa não sangra: ninguém morreria por demora');
  assert.ok(v.parada, 'o corpo atendível perdeu o asfalto de parada');
});

test('um desmaio leve no matagal fundo não sangra: o SAMU não pune a topografia', () => {
  const f = fixture({ mapa: cidade({ hospital: true, mata: true }) });
  f.ctx.npcs.push(caído(801, 70, 70, -40));
  f.s.update(PASSO, f.ctx);
  const v = f.s.vítimas.find((x) => x.npcId === 801);
  assert.ok(v, 'nem registrou o corpo no chão');
  assert.equal(v.parada, null, 'o matagal fundo ganhou asfalto de parada: a régua de alcance mudou');
  assert.equal(v.crítica, false,
    'um caído sem rua perto sangra: o SAMU matou quem nunca poderia alcançar');
});

test('o pedestre em pé não é ocorrência: só quem está no chão vira vítima', () => {
  const f = fixture({ mapa: cidade({ hospital: true }) });
  const npc = createNPC(802, 'a', 26, 32.5, 'civ', () => 0.5);
  npc.state = 'idle';
  f.ctx.npcs.push(npc);
  f.s.update(PASSO, f.ctx);
  assert.equal(f.s.vítimas.length, 0, 'o SAMU despachou para um pedestre andando');
});

// ---- o despacho ----

test('o corpo crítico tira a ambulância mais perto do hospital, uma por ocorrência', () => {
  const f = fixture({ mapa: cidade({ hospital: true, mata: true }) });
  const atendível = caído(803, 26, 32.5, -12);
  const semRua = caído(804, 70, 70, -12);
  f.ctx.npcs.push(atendível, semRua);
  avançar(f.s, f.ctx, 1);
  assert.equal(atendível && f.s.vítimas.find((v) => v.npcId === 803).viatura, f.s.viaturas[0].vehicleId,
    'nenhuma ambulância atendeu o corpo crítico ao lado da rua');
  assert.equal(f.s.vítimas.find((v) => v.npcId === 804).viatura, null,
    'um corpo sem asfalto recebeu ambulância');
  assert.equal(f.s.viaturas[0].modo, 'a caminho');
  // A segunda ocorrência atendível não tem com quem contar: frota finita, como no caminhão de fogo.
  const outro = caído(805, 27.5, 32.5, -12);
  f.ctx.npcs.push(outro);
  avançar(f.s, f.ctx, 1);
  assert.equal(f.s.vítimas.find((v) => v.npcId === 805).viatura, null,
    'a única ambulância do mapa se dividiu em duas ocorrências');
});

// ---- a folha manda: nenhuma ambulância fica presa a um corpo que já se foi ----

/**
 * O bug que só a cidade viva mostrava: uma ambulância chamada por um corpo que se levanta sozinho
 * (ou morre por outra causa) antes do resgate chegar. A `sangra` risca o da folha sem passar pela
 * `soltaVítima`, então `u.vítima` ficava apontando para um id morto. Como `despacha` só oferece a
 * lataria quando `u.vítima === null`, ela voltava ao hospital e nunca mais saía — o "não vi
 * paramédico" do jogador, provado offline pela primeira vez com uma SEGUNDA ocorrência depois da
 * primeira. O resgate bem-sucedido limpa a referência e esconde isso; só o corpo que escapa pela
 * folha denuncia o vínculo pendurado.
 */
test('um corpo que escapa da folha no meio do trajeto não prende a ambulância para sempre', () => {
  const f = fixture({ mapa: cidade({ hospital: true }) });
  f.s.update(PASSO, f.ctx); // arma a frota para poder pôr o corpo perto da vaga
  const base = f.s.viaturas[0].home;

  const primeiro = caído(810, base.x + 6, 30, -20);
  f.ctx.npcs.push(primeiro);
  avançar(f.s, f.ctx, 1);
  const u = f.s.viaturas[0];
  assert.equal(u.vítima, primeiro.id, 'a primeira ocorrência não prendeu a ambulância');
  assert.equal(u.modo, 'a caminho');

  // O corpo levanta sozinho ANTES de a lataria encostar: sai da folha por `sangra`, não por `soltaVítima`.
  primeiro.state = 'walking';
  primeiro.downTimer = 0;
  avançar(f.s, f.ctx, 60); // tempo de sobra para ir 'de volta' e estacionar de novo no hospital

  assert.equal(u.vítima, null, 'a ambulância voltou ao hospital ainda apontando para um corpo que se foi');
  assert.equal(u.modo, 'hospital', `prendida no modo ${u.modo}: nunca mais atenderia`);

  // Uma NOGA ocorrência no mesmo asfalto tem de achar a lataria livre. É aqui que o bug travava.
  const segundo = caído(811, base.x + 6, 30, -20);
  f.ctx.npcs.push(segundo);
  avançar(f.s, f.ctx, 1);
  const reg = f.s.vítimas.find((v) => v.npcId === segundo.id);
  assert.ok(reg, 'a segunda ocorrência nem foi registrada');
  assert.equal(reg.viatura, u.vehicleId,
    'a ambulância ficou presa ao primeiro corpo e não veio ao segundo: é o "não vi paramédico"');
  assert.equal(u.modo, 'a caminho');
});

// ---- o relógio da hemorragia ----

test('um corpo crítico sem socorro sangra e morre no chão onde caiu', () => {
  const f = fixture({ mapa: cidade({ mata: true }) }); // sem hospital: ninguém vem
  const v = caído(806, 26, 32.5, -12);
  f.ctx.npcs.push(v);
  let morreu = null;
  avançar(f.s, f.ctx, 34, (tempo) => {
    if (!morreu && v.dead) morreu = { tempo, health: v.health, state: v.state };
    return !v.dead;
  });
  assert.ok(morreu, 'o crítico em hemorragia nunca morreu: o tempo de resposta não é uma mecânica');
  assert.ok(morreu.tempo > 25, `morreu em ${morreu.tempo.toFixed(0)} s: a hemorragia de 30 s não existe`);
  assert.equal(morreu.state, 'dead', 'o corpo não fechou no chão');
});

test('um desmaio leve sem rua se levanta sozinho em vez de sangrar até morrer', () => {
  const f = fixture({ mapa: cidade({ mata: true }) });
  const v = caído(807, 70, 70, 20);
  f.ctx.npcs.push(v);
  let sumiuDaFolha = false;
  avançar(f.s, f.ctx, 20, () => { sumiuDaFolha = !f.s.vítimas.some((x) => x.npcId === 807); return !sumiuDaFolha; });
  assert.ok(!v.dead, 'um leve no mato morreu sem socorro: a hemorragia vazou para quem não é crítica');
  // Sem o `NPCSystem` aqui o corpo fica no chão do teste; o que o SAMU prova é que ele NÃO sangrou.
  assert.equal(sumiuDaFolha || !v.dead, true, 'o leve não-crítico deveria sair da folha ao se levantar');
});

// ---- a linha do tempo do resgate ----

test('a ambulância pega a rua até a parada e a tripulação desce a pé', () => {
  const { marcas } = resgateCompleto();
  assert.ok(marcas.despachado, `nenhuma ambulância saiu do hospital: ${JSON.stringify(marcas.emTerra || null)}`);
  assert.ok(marcas.emTerra, 'a ambulância nunca encostou na parada');
  assert.ok(marcas.emTerra.longeDaParada <= 1.4,
    `parou a ${marcas.emTerra.longeDaParada.toFixed(2)} tiles do asfalto marcado`);
  assert.equal(marcas.emTerra.aPé, 2, `saíram ${marcas.emTerra.aPé} de dois da lataria`);
  assert.ok(marcas.emTerra.tempo > marcas.despachado.tempo, 'chegou antes de ser chamado');
});

test('o paramédico anda até o corpo e a maca trabalha no alcance', () => {
  const { marcas } = resgateCompleto();
  assert.ok(marcas.juntoDoCorpo, 'nenhum paramédico encostou no caído');
  assert.ok(marcas.juntoDoCorpo.longeDoCorpo <= 1.5,
    `a maca abriu a 2,5 a ${marcas.juntoDoCorpo.longeDoCorpo.toFixed(2)} tiles do corpo`);
  // A `atendimentoMáx` é lida um passo antes do `soltaVítima` fechar o corpo, então o teto observável
  // é um `dt` abaixo de 2,5 — e a maca ter chegado ali é justamente o que prova que ela trabalhou a
  // janela inteira em vez de tocar o corpo e sair (o sintoma do bug que esta linha pega).
  assert.ok(marcas.atendimentoMáx >= 2.4,
    `o atendimento chegou a ${marcas.atendimentoMáx} s: a maca nunca fechou o socorro`);
});

test('o socorro devolve a pessoa viva e de pé: gente que não devia morrer', () => {
  const { marcas, vítima } = resgateCompleto();
  assert.ok(marcas.socorrida, `ninguém foi resgatado: ${JSON.stringify(marcas.emTerra || null)}`);
  assert.equal(marcas.socorrida.naFolha, false, 'a vítima salva continuou na folha do SAMU');
  assert.equal(marcas.socorrida.state, 'fleeing', 'quem foi socorrido não levantou de pé');
  assert.ok(marcas.socorrida.health >= 45, 'o socorrido voltou com a vida que o resgate devolve');
  assert.equal(vítima.dead, false, 'a pessoa socorrida está morta: o resgate não salvou nada');
  assert.ok(marcas.continuaViva, 'depois de salva a pessoa voltou a morrer no chão');
});

test('depois do socorro a equipe embarca e a ambulância volta para o hospital', () => {
  const { marcas } = resgateCompleto();
  assert.ok(marcas.deVolta, 'a lataria não saiu do asfalto depois do atendimento');
  assert.equal(marcas.deVolta.aPé, 0, 'a equipe voltou para a rua vazia: ficou alguém a pé');
  assert.ok(marcas.noHospital, `a ambulância não voltou à vaga: ${JSON.stringify(marcas.deVolta || null)}`);
  assert.equal(marcas.noHospital.tripulação, 2, 'a frota voltou sem tripulação completa');
  assert.equal(marcas.estatísticas.resgatadas, 1, 'a contagem que a HUD de serviço lê não bate com o resgate');
  assert.equal(marcas.estatísticas.ambulâncias, 1, 'a frota da cidade mudou de tamanho por socorrer alguém');
});

test('o desmaio leve do mato sai da folha sem drama, sem morto e sem ambulância', () => {
  const { marcas } = resgateCompleto();
  assert.equal(marcas.aceso.leve, false, 'o desmaio no matagal virou hemorragia');
  assert.equal(marcas.aceso.paradaDaLeve, false, 'o matagal fundo ganhou parada atendível');
  assert.equal(marcas.estatísticas.perdidas, 0,
    'um corpo sem rua morreu: o SAMU matou quem a topografia escondeu');
});

// ---- o profissional fora da multidão ----

test('paramédico morto em serviço sai da folha e volta para a cidade como civil', () => {
  const f = fixture({ mapa: cidade({ hospital: true }) });
  f.s.update(PASSO, f.ctx);
  const vítima = f.ctx.npcs.find((n) => n.kind === 'paramedico');
  const dono = f.s.paramédicos.find((p) => p.npcId === vítima.id);
  const viatura = f.s.viaturas.find((u) => u.vehicleId === dono.viatura);
  assert.equal(viatura.crew.length, 2);
  vítima.health = 0;
  vítima.dead = true;
  vítima.state = 'dead';
  f.s.update(PASSO, f.ctx);
  assert.equal(f.s.paramédicos.some((p) => p.npcId === vítima.id), false, 'o corpo ficou na folha de serviço');
  assert.equal(viatura.crew.length, 1, 'a tripulação não abriu a vaga do morto');
  assert.equal(vítima.kind, 'civ',
    'o cadáver de um paramédico continua "paramedico": o LifeSystem não recicla e a população vaza');
});

test('a posse do profissional é o predicado, não o nome da classe', () => {
  const NPC = fs.readFileSync(src('entities/NPC.ts'), 'utf8');
  assert.match(NPC, /export type NPCKind = 'civ' \| 'cop' \| 'bombeiro' \| 'paramedico'/,
    'o paramédico não é um tipo de NPC reconhecido pela cidade');
  const pares = [
    ['systems/NPCSystem.ts', /npc\.kind !== 'civ'/],
    ['systems/LifeSystem.ts', /npc\.kind !== 'civ'/],
    ['systems/TrafficSystem.ts', /n\.kind === 'civ'/],
    ['game/GameState.ts', /npc\.kind !== 'civ'/],
  ];
  for (const [arquivo, régua] of pares) {
    const código = fs.readFileSync(src(arquivo), 'utf8');
    assert.ok(régua.test(código),
      `${arquivo} voltou a decidir por nome de classe: a multidão sequestraria o paramédico`);
  }
});

// ---- o som e o contrato de fonte ----

test('a sirene do resgate toca no canal do socorro, nunca no alarme nem na ronda', () => {
  const { marcas } = resgateCompleto();
  const escritos = marcas.loops;
  assert.ok(escritos.length > 0, 'nenhum volume foi escrito no alto-falante do resgate');
  for (const l of escritos) {
    assert.equal(l.ch, 'socorro', `o resgate tocou no canal ${l.ch} — dividiria o alto-falante com a ronda ou o fogo`);
    if (l.key !== null) assert.equal(l.key, 'siren');
    assert.ok(l.volume >= 0 && l.volume <= 0.5, `volume de sirene ${l.volume}`);
  }
  assert.ok(escritos.some((l) => l.key === 'siren' && l.volume > 0), 'a sirene nunca tocou durante o atendimento');
  assert.ok(escritos.length <= marcas.simulado / 0.3 + 2,
    `${escritos.length} escritas em ${marcas.simulado.toFixed(0)} s: a HUD não pode acompanhar isso`);
  // Mudez de verdade: depois que a ambulância voltou ao hospital, o alto-falante não é escrito outra vez.
  const depois = escritos.filter((l) => l.t > marcas.noHospital.tempo + 0.01);
  assert.equal(depois.length, 0,
    `${depois.length} escritas depois do fim do serviço: a sirene continua cutucando o áudio de um resgate que acabou`);
});

test('o socorro que fecha tem som, e a ambulância que embarca abre a porta', () => {
  const { marcas } = resgateCompleto();
  assert.ok(marcas.tocados.some((t) => t.key === 'healthPickup'),
    'a pessoa levantou viva sem som nenhum: a cena não existe para quem ouve');
  assert.ok(marcas.tocados.some((t) => t.key === 'doorOpen'),
    'a tripulação desceu sem barulho de lataria');
});

test('nada é decoração: o GameState liga o hospital, o chão caído e o tick do SAMU', () => {
  const código = fs.readFileSync(src('game/GameState.ts'), 'utf8');
  const resgate = código.indexOf('this.samu.update(dt, this.samuContext(outdoorPlayer))');
  const fogo = código.indexOf('this.incendio.update(dt, this.incendioContext(outdoorPlayer, !!room))');
  assert.ok(resgate > 0, 'o SamuSystem não é percorrido no tick do mundo');
  assert.ok(fogo > 0 && resgate > fogo,
    'o resgate roda antes do incêndio: sairia atrás de um corpo que ainda não queimou');
  assert.ok(/this\.samu\.init\(this\.samuContext\(\)\)/.test(código),
    'a frota do SAMU não é armada no boot: nenhum hospital teria ambulância na porta');
  assert.ok(/private samuContext\(player = this\.player\): SamuContext/.test(código),
    'o contexto do SAMU perdeu o relógio/pedido do mundo');
  assert.ok(/new SamuSystem\(\)/.test(código), 'o SamuSystem não é instanciado no estado do jogo');
});

test('o paramédico tem jaleco no quadro: tinta medida, chave de sprite e fila de render', () => {
  const pasta = path.join(root, 'assets/sprites/Characters');
  for (const dir of ['NE', 'NW', 'SE', 'SW']) {
    const arquivos = [`char_paramedico_idle_${dir}_f01.png`,
      ...[1, 2, 3, 4].map((n) => `char_paramedico_walk_${dir}_f${String(n).padStart(2, '0')}.png`)];
    for (const file of arquivos) {
      assert.ok(fs.existsSync(path.join(pasta, file)), `falta o sprite ${file}: o paramédico desenharia pedestre`);
    }
  }
  const manifesto = fs.readFileSync(src('assets/AssetManifest.ts'), 'utf8');
  assert.match(manifesto, /"Characters\/char_paramedico_idle_SE_f01\.png"/,
    'o gerador de manifest não viu os jalecos: o boot nunca carregaria o paramédico');
  const reg = fs.readFileSync(src('assets/AssetRegistry.ts'), 'utf8');
  assert.ok(/export function paramedicoCharacterKey/.test(reg),
    'sumiu a chave do jaleco: o corpo do paramédico voltou a ser o do pedestre');
  const render = fs.readFileSync(src('render/entityImages.ts'), 'utf8');
  assert.ok(/npc\.kind === 'paramedico' \? paramedicoCharacterKey/.test(render),
    'a fila de entidades não pergunta o `kind` do paramédico: ele é um pedestre de jaleco na tela');

  // Tinta, não nome de arquivo: os passos acima passam com um PNG copiado do pedestre. O que faz do
  // sprite um jaleco é o verde do boné (y 2..4) e o branco do tronco (y 9..18) — as duas partes que
  // sobrevivem ao tint de noite e à névoa da moldura. A cara (y 6..8) fica intocado de propósito: é o
  // tom de pele, e medi-la igualaria o paramédico ao pedestre. Verde é G dominando R e B; amarelo é R
  // dominando G, o que não existe no boné daqui — a mesma régua do `check-incendio` cobrada ao contrário.
  const ler = (file) => {
    const im = PNG.sync.read(fs.readFileSync(path.join(pasta, file)));
    let verde = 0, branco = 0, amarelo = 0;
    for (let y = 0; y < im.height; y++) {
      for (let x = 0; x < im.width; x++) {
        const i = (y * im.width + x) * 4;
        if (im.data[i + 3] < 50) continue;
        const r = im.data[i], g = im.data[i + 1], b = im.data[i + 2];
        if (y >= 2 && y <= 4 && g > 80 && g > r + 25 && g > b + 10) verde++;
        if (y >= 9 && y <= 18 && r > 200 && g > 200 && b > 185) branco++;
        if (y >= 2 && y <= 4 && r > 150 && g > 100 && b < 90) amarelo++;
      }
    }
    return { verde, branco, amarelo, w: im.width, h: im.height };
  };
  const paramédico = ler('char_paramedico_idle_SE_f01.png');
  assert.equal(paramédico.w, 24, 'o jaleco não saiu do pack 24x32: é outro desenho');
  assert.equal(paramédico.h, 32, 'o jaleco não saiu do pack 24x32: é outro desenho');
  assert.ok(paramédico.verde >= 8,
    `o boné do paramédico tem verde demais/menos de nada (${paramédico.verde}): é um pedestre com nome de socorrista`);
  assert.ok(paramédico.branco >= 20,
    `o tronco não é branco (${paramédico.branco}): o jaleco do resgate não aparece na tela`);
  assert.equal(paramédico.amarelo, 0,
    'o paramédico tem capacete amarelo: a brigada de fogo e o resgate seriam a mesma mancha no incêndio');

  // As duas brigadas no mesmo fogo têm de ser cores opostas, medida nas duas fontes.
  const bombeiro = ler('char_bombeiro_idle_SE_f01.png');
  assert.ok(bombeiro.amarelo >= 8, 'o bombeiro perdeu o capacete amarelo: as réguas cruzadas quebraram');
  assert.equal(bombeiro.verde, 0, 'o bombeiro tem boné verde: o paramédico e a brigada se confundem');
});

console.log(`\n${passed} provas, ${failed} falhas`);
if (failed) process.exitCode = 1;
