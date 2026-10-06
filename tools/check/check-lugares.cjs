// Run: node tools/check/check-lugares.cjs
// O mapa respondia "do que você é feito" (o bioma do tile) e nunca "onde você está". Este
// arquivo cobra a resposta nova, em memória e sem navegador: que a partição cubra o grid
// inteiro sem sobrepor nem deixar buraco, que toda costura caia no meio de uma avenida, que
// o nome siga a função do lugar (bairro onde há quadra, zona onde há terra, rio onde há
// água), que nenhum nome se repita, que todo facho nomeado seja asfalto de ponta a ponta e
// que a consulta faça exatamente o que a tela mostra. A última prova é de contrato de fonte:
// o nome tem de chegar ao instrumento, e um módulo perfeito que ninguém monta é um stub.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');
const srcPath = (name) => path.join(root, 'src', name);
const cache = new Map();

function load(filename) {
  if (!path.extname(filename)) filename += '.ts';
  if (cache.has(filename)) return cache.get(filename).exports;
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    fileName: filename, reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  });
  assert.deepEqual(compiled.diagnostics, [], filename);
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.paths = Module._nodeModulePaths(path.dirname(filename));
  mod.require = (name) => (name.startsWith('.')
    ? load(path.resolve(path.dirname(filename), name)) : require(name));
  cache.set(filename, mod);
  mod._compile(compiled.outputText, filename);
  return mod.exports;
}

const L = load(srcPath('data/maps/Lugares.ts'));
const { generateCity, WORLD_SEED } = load(srcPath('data/maps/city.ts'));
const { Map: CityMap } = load(srcPath('world/Map.ts'));

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`OK ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL ${name}\n${error && error.stack ? error.stack : error}`);
  }
}

const NATURAIS = new Set(['forest', 'countryside', 'beach', 'pinewood', 'savanna', 'desert']);
const ARTÉRIAS = new Set(['highway', 'avenue']);

// ---- a partição em malha sintética: aqui o buraco e a sobreposição são visíveis ----

const XS = [8, 24, 40, 56, 72, 88];
const YS = [8, 24, 40, 56, 72, 88];
const W = 96;
const H = 96;
const FILEIRA_DO_RIO = Math.floor((YS.length - 2) / 2);

/** O grid de teste: três colunas de cidade a oeste, mato a leste, e a fileira do rio pulada. */
function quadrasSintéticas(biomaDe) {
  const out = [];
  for (let row = 0; row < YS.length - 1; row++) {
    if (row === FILEIRA_DO_RIO) continue;
    for (let col = 0; col < XS.length - 1; col++) out.push({ col, row, biome: biomaDe(col, row) });
  }
  return out;
}

const LEITO = { x0: 0, y0: YS[FILEIRA_DO_RIO] + 2, x1: W, y1: YS[FILEIRA_DO_RIO + 1] };
const rngFixo = () => 0.5;
const ENTRADA = quadrasSintéticas((col) => (col <= 2 ? 'residential' : 'forest'));
const partição = L.distritosDasQuadras(ENTRADA, XS, YS, W, H, rngFixo, LEITO);
const distritos = partição.distritos;

test('o grid inteiro tem dono, uma vez só', () => {
  // A régua mais dura possível: cada célula do mapa pertence a exatamente um lugar. Um
  // tile a menos é rua sem bairro; um a mais é o nome piscando entre dois a cada quadro.
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const donos = distritos.filter((d) => L.distritoEm({ distritos, vias: [] }, x, y) === d);
      assert.equal(donos.length, 1, `tile ${x},${y} tem ${donos.length} lugares: `
        + donos.map((d) => d.nome).join(' | '));
    }
  }
});

test('a costura do bairro cai no meio da avenida, nunca dentro do lote', () => {
  // Toda borda vertical interna é a linha média de um facho de avenida (xs+1), e o mesmo
  // para as horizontais — exceto nas duas beiras do rio, onde a fileira vizinha não existe
  // e o bairro fica com a avenida inteira. Sem isso um lote acordaria partida ao meio.
  const verticais = new Set(XS.map((x) => x + 1));
  const horizontais = new Set(YS.map((y) => y + 1));
  horizontais.add(YS[FILEIRA_DO_RIO] + 2);
  horizontais.add(YS[FILEIRA_DO_RIO + 1]);
  for (const d of distritos) {
    if (d.x0 !== 0) assert.ok(verticais.has(d.x0), `${d.nome} abre em ${d.x0}, fora do facho`);
    if (d.x1 !== W) assert.ok(verticais.has(d.x1), `${d.nome} fecha em ${d.x1}, dentro do lote`);
    if (d.y0 !== 0) assert.ok(horizontais.has(d.y0), `${d.nome} abre em ${d.y0}, dentro do lote`);
    if (d.y1 !== H) assert.ok(horizontais.has(d.y1), `${d.nome} fecha em ${d.y1}, dentro do lote`);
  }
});

test('nenhum distrito atravessa bioma e nenhum é maior que a janela de leitura', () => {
  const cap = (b) => (NATURAIS.has(b) ? 4 : 3);
  for (const d of distritos) {
    if (d.especie === 'rio') continue;
    const largura = (d.x1 - d.x0) / 16;
    const altura = (d.y1 - d.y0) / 16;
    assert.ok(largura <= cap(d.biome) + 1, `${d.nome} tem ${largura} quadras de largura`);
    assert.ok(altura <= cap(d.biome) + 1, `${d.nome} tem ${altura} quadras de altura`);
  }
  const quadras = new Set(ENTRADA.map((b) => `${b.col},${b.row}`));
  assert.equal(partição.porQuadra.size, quadras.size,
    `a partição entregou ${partição.porQuadra.size} dono(s) para ${quadras.size} quadras`);
  for (const [chave, id] of partição.porQuadra) {
    assert.ok(quadras.has(chave), `a partição inventou a quadra ${chave}`);
    const [col, row] = chave.split(',').map(Number);
    assert.equal(distritos[id].biome, col <= 2 ? 'residential' : 'forest',
      `${distritos[id].nome} invadiu a quadra ${chave}`);
    assert.ok(row !== FILEIRA_DO_RIO, `ninguém constrói sobre o rio: ${chave}`);
  }
});

test('onde não há quadra urbana é zona, e o rio é o terceiro caso', () => {
  const bairros = distritos.filter((d) => d.especie === 'bairro');
  const zonas = distritos.filter((d) => d.especie === 'zona');
  const rios = distritos.filter((d) => d.especie === 'rio');
  assert.ok(bairros.length > 0 && zonas.length > 0, 'a partição só conhece uma espécie de lugar');
  assert.equal(rios.length, 1);
  for (const d of bairros) assert.ok(!NATURAIS.has(d.biome), `${d.nome} é mata com nome de bairro`);
  for (const d of zonas) assert.ok(NATURAIS.has(d.biome), `${d.nome} é cidade com nome de zona`);
  assert.ok(rios[0].nome.startsWith('Rio '), `${rios[0].nome} não se anuncia como rio`);
});

// ---- o mapa de verdade: as duas sementes que o projeto já usa ----

const cidade = generateCity(WORLD_SEED);
const lugares = cidade.lugares;
const tilesDe = (x, y) => cidade.tiles[y * cidade.tilesW + x];

test('o mapa gerado entregou bairros, zonas, rio e vias', () => {
  assert.ok(lugares, 'o gerador não publicou `lugares`');
  const bairros = lugares.distritos.filter((d) => d.especie === 'bairro');
  const zonas = lugares.distritos.filter((d) => d.especie === 'zona');
  const rios = lugares.distritos.filter((d) => d.especie === 'rio');
  console.log(`   ${bairros.length} bairros, ${zonas.length} zonas, ${rios.length} rios, `
    + `${lugares.vias.length} vias`);
  assert.ok(bairros.length >= 6, `só ${bairros.length} bairros: a cidade continua um tabuleiro`);
  assert.ok(zonas.length >= 3, `só ${zonas.length} zonas`);
  assert.equal(rios.length, 1);
  assert.ok(lugares.vias.length >= cidade.tilesW / 16 * 2,
    `${lugares.vias.length} vias para um grid de ${cidade.tilesW / 16} linhas por eixo`);
});

test('todo tile da grade tem exatamente um lugar, inclusive o asfalto', () => {
  const vazios = [];
  const duplicados = [];
  for (let y = 0; y < cidade.tilesH; y++) {
    for (let x = 0; x < cidade.tilesW; x++) {
      const donos = lugares.distritos
        .filter((d) => x >= d.x0 && x < d.x1 && y >= d.y0 && y < d.y1);
      if (donos.length === 0) vazios.push(`${x},${y}`);
      if (donos.length > 1) duplicados.push(`${x},${y}=${donos.map((d) => d.nome).join('|')}`);
    }
  }
  assert.equal(vazios.length, 0, `tiles sem bairro: ${vazios.slice(0, 8).join(' ')}`);
  assert.equal(duplicados.length, 0, `tiles com dois bairros: ${duplicados.slice(0, 4).join(' ')}`);
});

test('o nome segue a função do lugar e o apelido é o resto da frase', () => {
  const nomes = new Set();
  for (const d of lugares.distritos) {
    const prefixo = L.PREFIXO_DO_LUGAR[d.biome];
    if (d.especie === 'rio') {
      // O rio não tem prefixo de bioma porque não é terra de ninguém: a grade não tem bioma de
      // água, e o `docks` que o campo carrega é só o placeholder que a espécie ignora.
      assert.equal(d.nome, `Rio ${d.apelido}`, `${d.nome} não é o rio do próprio apelido`);
    } else if (d.especie === 'zona') {
      // Zona é terra sem quadra: o nome se escreve com ligação, "Mata do Ipê", e é por isso
      // que o apelido mora no meio da frase, não no fim.
      const m = new RegExp(`^${prefixo} (do|da) (.+)$`).exec(d.nome);
      assert.ok(m, `${d.nome} não é "${prefixo} do/da <apelido>"`);
      assert.equal(m[2], d.apelido, `${d.nome} não termina no próprio apelido`);
    } else {
      // Bairro vai de nome seco, "Jardim Aurora". O único caso em que um bairro carrega uma
      // palavra dessas no meio é o apelido que já nasceu com ela ("Acácia do Norte"), e aí a
      // frase inteira continua sendo prefixo + apelido.
      assert.equal(d.nome, `${prefixo} ${d.apelido}`, `${d.nome} foge da fórmula do bairro`);
    }
    assert.ok(d.nome.length <= 30, `nome longo demais para o mapa: ${d.nome}`);
    assert.ok(!nomes.has(d.nome), `bairro com o mesmo nome duas vezes: ${d.nome}`);
    nomes.add(d.nome);
  }
});

test('cada corredor tem uma placa só, e nenhuma placa vale para dois corredores', () => {
  const porNome = new Map();
  for (const v of lugares.vias) {
    const lista = porNome.get(v.nome) ?? [];
    lista.push(v);
    porNome.set(v.nome, lista);
  }
  // Um nome só pode voltar a aparecer AO LONGO DO MESMO CORREDOR: avenida cortada pelo rio é
  // a mesma avenida, duas vezes. Nome repetido em corredores diferentes são duas ruas
  // diferentes com a mesma placa, e o jogador não tem como saber qual delas é a sua.
  for (const [nome, lista] of porNome) {
    const corredores = new Set(lista.map((v) => `${v.eixo}|${v.faixa0}`));
    assert.ok(corredores.size === 1,
      `"${nome}" é placa de ${corredores.size} corredores: ${[...corredores].join(' e ')}`);
    const faixas = new Set(lista.map((v) => `${v.faixa0},${v.faixa1}`));
    assert.equal(faixas.size, 1, `"${nome}" corre em faixas diferentes: ${[...faixas].join(' e ')}`);
  }
  const travessas = lugares.vias.filter((v) => v.rank === 'street' || v.rank === 'residential');
  assert.ok(travessas.length > 10, `só ${travessas.length} travessas nomeadas`);
  const corredores = new Set(travessas.map((v) => v.faixa0));
  const nomesDeTravessa = new Set(travessas.map((v) => v.nome));
  assert.ok(nomesDeTravessa.size === corredores.size,
    `${corredores.size} corredores de travessa para ${nomesDeTravessa.size} placas`);
  for (const v of travessas) assert.ok(/^Rua \S/.test(v.nome), `${v.nome} sem nome de rua`);
});

test('toda via nomeada é asfalto de ponta a ponta, nos dois lados da mão dupla', () => {
  let lidos = 0;
  for (const v of lugares.vias) {
    for (let linha = v.faixa0; linha <= v.faixa1; linha++) {
      for (let i = v.de; i <= v.ate; i++) {
        const x = v.eixo === 'ns' ? linha : i;
        const y = v.eixo === 'ns' ? i : linha;
        const t = tilesDe(x, y);
        assert.ok(t && t.kind === 'road',
          `${v.nome} passa por ${x},${y}, que é ${t && t.kind} — via nomeada sobre terra`);
        lidos++;
      }
    }
  }
  assert.ok(lidos > 4000, `as vias cobrem só ${lidos} tiles: nada foi medido no mapa`);
});

test('artéria sem nome não existe, e o asfalto miúdo também sabe quem é', () => {
  const semNome = [];
  let ruas = 0;
  let miúdo = 0;
  for (let y = 0; y < cidade.tilesH; y++) {
    for (let x = 0; x < cidade.tilesW; x++) {
      const t = tilesDe(x, y);
      if (t.kind !== 'road' || !t.rank) continue;
      const via = L.viaEm(lugares, x, y);
      if (ARTÉRIAS.has(t.rank)) {
        ruas++;
        if (!via) semNome.push(`${x},${y} ${t.rank}`);
        else assert.ok(ARTÉRIAS.has(via.rank),
          `${x},${y} é ${t.rank} e a placa diz ${via.rank}`);
      } else if (t.rank !== 'access') {
        miúdo++;
        if (!via) semNome.push(`${x},${y} ${t.rank}`);
      }
    }
  }
  console.log(`   ${ruas} tiles de artéria, ${miúdo} de rua miúda nomeados`);
  assert.ok(ruas > 5000 && miúdo > 500, `contagem impossível: ${ruas} e ${miúdo}`);
  assert.equal(semNome.length, 0, `asfalto sem via: ${semNome.slice(0, 10).join(' | ')}`);
});

test('o rio mora no leito e não mastiga a avenida da margem', () => {
  const rio = lugares.distritos.find((d) => d.especie === 'rio');
  const meio = Math.floor((rio.y0 + rio.y1) / 2);
  const água = [];
  for (let x = rio.x0 + 4; x < rio.x1 - 4; x += 7) água.push(tilesDe(x, meio).kind);
  assert.ok(água.every((k) => k === 'water' || k === 'road'),
    `o leito tem chão de ${[...new Set(água)].join(', ')} no meio`);
  assert.ok(água.filter((k) => k === 'water').length / água.length > 0.7,
    'o tal rio é metade asfalto');
  // As duas avenidas de margem são cidade, não água: é a rua onde se para, e quem está
  // nelas tem de ouvir o nome do bairro.
  let dentro = 0;
  for (let x = 0; x < cidade.tilesW; x++) {
    for (const y of [rio.y0 - 1, rio.y0 - 2, rio.y1, rio.y1 + 1]) {
      if (L.distritoEm(lugares, x, y).especie !== 'rio') dentro++;
    }
  }
  assert.ok(dentro > cidade.tilesW, 'a faixa do rio comeu a avenida da margem');
});

test('a mesma semente dá a mesma cidade e semente diferente dá outros bairros', () => {
  const outra = generateCity(WORLD_SEED);
  assert.deepEqual(outra.lugares, cidade.lugares,
    'dois gerações da mesma semente deram nomes diferentes — o save não tem como confiar neles');
  const deOutroMundo = generateCity(WORLD_SEED ^ 0x5a5a5a).lugares;
  const nomes = new Set(cidade.lugares.distritos.map((d) => d.nome));
  const diferentes = deOutroMundo.distritos.filter((d) => !nomes.has(d.nome)).length;
  assert.ok(diferentes >= deOutroMundo.distritos.length * 0.8,
    'trocou o mapa, ficou a mesma legenda');
  const vias = new Set(cidade.lugares.vias.map((v) => `${v.eixo}|${v.faixa0}|${v.de}|${v.nome}`));
  assert.ok(deOutroMundo.vias.filter((v) => !vias.has(`${v.eixo}|${v.faixa0}|${v.de}|${v.nome}`))
    .length > deOutroMundo.vias.length * 0.5, 'as vias não acompanharam os bairros');
});

test('a consulta do Map devolve o lugar dentro da grade e nada fora dela', () => {
  const map = new CityMap(cidade);
  const spawn = map.lugarEm(cidade.playerSpawn.x, cidade.playerSpawn.y);
  assert.ok(spawn.distrito, 'o jogador nasceu em lugar anônimo');
  assert.ok(spawn.distrito.nome.length > 3, spawn.distrito.nome);
  const fora = map.lugarEm(-5, cidade.playerSpawn.y);
  assert.deepEqual(fora, { distrito: null, via: null },
    'fora da grade a consulta inventou bairro — é a fronteira quem nomeia a terra');
  const além = map.lugarEm(cidade.playerSpawn.x, cidade.tilesH + 12);
  assert.deepEqual(além, { distrito: null, via: null });
});

test('a frase é bairro e rua quando há asfalto, bairro sozinho quando não há', () => {
  const comRua = L.fraseDoLugar({ nome: 'Jardim Aurora' }, { nome: 'Rua Acácia' });
  assert.equal(comRua, 'Jardim Aurora · Rua Acácia');
  assert.equal(L.fraseDoLugar({ nome: 'Mata do Ipê' }, null), 'Mata do Ipê');
  assert.equal(L.fraseDoLugar(null, { nome: 'Avenida Brasil' }), 'Avenida Brasil');
  assert.equal(L.fraseDoLugar(null, null), '');
});

test('o nome chega ao instrumento: rótulo no mapa e linha de lugar no cabeçalho', () => {
  const rótulos = fs.readFileSync(srcPath('ui/RótulosDeLugares.tsx'), 'utf8');
  assert.match(rótulos, /lugarDoJogador|distritos/, 'o módulo de rótulos não lê o mapa');
  const minimapa = fs.readFileSync(srcPath('ui/MiniMap.tsx'), 'utf8');
  assert.ok(minimapa.includes('RótulosDeLugares'),
    'o componente de rótulos não está montado no mapa — nome que não aparece é stub');
  const cabeçalho = fs.readFileSync(srcPath('ui/MiniMap.tsx'), 'utf8');
  assert.ok(/lugarDoJogador\(\)/.test(cabeçalho),
    'o cabeçalho continua lendo o bioma do tile em vez do lugar');
});

console.log(`\n${passed} passaram, ${failed} falharam`);
process.exit(failed ? 1 : 0);
