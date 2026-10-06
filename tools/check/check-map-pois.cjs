// Run: node tools/check/check-map-pois.cjs
// O mapa passou a desenhar o que o mundo é, e não só o que o gerador guardou: a terra sem fim
// fora da grade e um glifo por tipo de lugar de interesse. Este arquivo não abre navegador nem
// desenha pixel nenhum — ele cobra a aritmética que o `<Canvas>` usa: que o anel cubra o
// retângulo expandido sem sobrepor a cidade nem a si mesmo, que nenhuma aldeia fique de fora da
// lista, que cada tipo tenha silhueta própria, e que a costura no `MapCanvas` esteja de pé.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');
const srcPath = (name) => path.join(root, 'src', name);
const cache = new Map();
let currentGame;

const element = (type, props, key) => ({ type, props: props || {}, key: key == null ? null : String(key) });
const stubs = {
  react: {},
  'react/jsx-runtime': { jsx: element, jsxs: element, Fragment: 'Fragment' },
  'react-native': { StyleSheet: { create: (s) => s }, Platform: { OS: 'web' } },
  '@shopify/react-native-skia': { Group: 'Group', Path: 'Path' },
  [srcPath('game/GameState.ts')]: { getGame: () => currentGame },
};

function load(filename) {
  if (!path.extname(filename)) {
    filename = ['.ts', '.tsx'].map((e) => filename + e).find(fs.existsSync) || filename + '.ts';
  }
  if (Object.hasOwn(stubs, filename)) return stubs[filename];
  if (cache.has(filename)) return cache.get(filename).exports;
  const result = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    fileName: filename, reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX, strict: true, esModuleInterop: true },
  });
  assert.deepEqual(result.diagnostics, [], filename);
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.paths = Module._nodeModulePaths(path.dirname(filename));
  mod.require = (name) => (Object.hasOwn(stubs, name) ? stubs[name]
    : name.startsWith('.') ? load(path.resolve(path.dirname(filename), name)) : require(name));
  cache.set(filename, mod);
  mod._compile(result.outputText, filename);
  return mod.exports;
}

const P = load(srcPath('ui/PontosDeInteresse.tsx'));
const { ExplorationSystem } = load(srcPath('systems/ExplorationSystem.ts'));
const F = load(srcPath('world/Frontier.ts'));
const T = load(srcPath('world/Tribo.ts'));
const { makeProjectors } = load(srcPath('world/MapPresentation.ts'));

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('OK ' + name); }
  catch (error) { failed++; console.error('FAIL ' + name + '\n' + error.stack); }
}

// ---- leitura de caminho ----

/** Parser próprio de `M/L/Z`: rejeita comando desconhecido, par faltando e polilinha aberta. */
function polilinhas(value) {
  const out = [];
  let atual = null;
  let cursor = 0;
  for (const m of value.matchAll(/([MLZ])([^MLZ]*)/gi)) {
    assert.equal(m.index, cursor, 'conteúdo solto no caminho');
    cursor = m.index + m[0].length;
    const cmd = m[1].toUpperCase();
    if (cmd === 'Z') {
      assert.ok(atual && atual.length >= 3, 'fecho sem polilinha de três pontos');
      atual = null;
      continue;
    }
    const nums = m[2].split(',').map(Number);
    assert.equal(nums.length, 2, `${cmd} sem um par exato de coordenadas`);
    assert.ok(nums.every((n) => Number.isFinite(n)), `${cmd} com número ilegível: ${m[2]}`);
    if (cmd === 'M') {
      assert.ok(!atual, 'polilinha nova antes da anterior fechar');
      atual = [];
      out.push(atual);
    } else assert.ok(atual, 'L antes de qualquer M');
    atual.push(nums);
  }
  assert.equal(cursor, value.length, 'sobra no fim do caminho');
  assert.ok(!atual, 'polilinha aberta no fim do caminho');
  return out;
}

function caixa(linha) {
  return { x0: Math.min(...linha.map((p) => p[0])), x1: Math.max(...linha.map((p) => p[0])),
    y0: Math.min(...linha.map((p) => p[1])), y1: Math.max(...linha.map((p) => p[1])) };
}
/** A caixa de uma cabe na da outra. Encostar pode: a boca da caverna compartilha o chão do arco. */
function contida(a, b) {
  const c = caixa(b);
  return a.every(([x, y]) => x >= c.x0 && x <= c.x1 && y >= c.y0 && y <= c.y1);
}
/** Área de interseção das duas caixas — o que `evenOdd` apagaria se as partes fossem sólidas. */
function sobreposição(a, b) {
  const A = caixa(a), B = caixa(b);
  return Math.max(0, Math.min(A.x1, B.x1) - Math.max(A.x0, B.x0))
    * Math.max(0, Math.min(A.y1, B.y1) - Math.max(A.y0, B.y0));
}

// ---- retângulos de mundo ----

const interseção = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x))
  * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
const área = (r) => r.w * r.h;
const engole = (r, x, y) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;

// ---- fixtures ----

const SEM_RIO = { isWaterWorld: () => false };

/** Uma cidade mínima e determinística: a geometria do anel não pode depender do gerador. */
function tilesDaCidade(W, H) {
  const out = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) out.push({ key: 'grass', kind: 'ground', biome: 'countryside' });
  }
  return out;
}
const tileDe = (tiles, W, x, y) => tiles[y * W + x];

/** O `GameState` que a camada lê: só o que ela realmente toca, com um mapa novo por fixture —
 *  os registos são cacheados por objeto de mapa, e reaproveitar um esconderia a última lista. */
function jogo(tiles, W, H, opts = {}) {
  const map = {
    data: { tilesW: W, tilesH: H, tiles, cascatas: opts.cascatas ?? [], cavernas: opts.cavernas ?? [] },
    landmarks: opts.landmarks ?? [],
    isWaterWorld: opts.isWaterWorld ?? (() => false),
  };
  currentGame = { map, exploration: opts.exploration ?? new ExplorationSystem(W, H) };
  return currentGame;
}

/** Exploração marcada tile a tile, sem depender do raio de revelação do `update`. */
function explorados(W, H, células) {
  const e = new ExplorationSystem(W, H);
  const marcadas = new Set(células.map(([x, y]) => y * W + x));
  let corpo = '', i = 0;
  while (i < W * H) {
    const v = marcadas.has(i) ? 1 : 0;
    let run = 1;
    while (i + run < W * H && (marcadas.has(i + run) ? 1 : 0) === v) run++;
    corpo += `${corpo.length ? ',' : ''}${v}.${run.toString(36)}`;
    i += run;
  }
  assert.ok(e.restore(`${W}x${H}:${corpo}`), 'a snapshot de exploração não voltou');
  return e;
}

const vista = (props) => ({ mapW: 390, mapH: 844, zoom: 1, panX: 0, panY: 0, detailed: true, ...props });

/** Desenha a camada e devolve os nós, cobrando antes que o desenho não escreva em estado nenhum. */
function desenhe(props) {
  const e = currentGame.exploration;
  const antes = `${e.exploredCount}/${e.visitedCount}/${e.version}|`
    + JSON.stringify(currentGame.map.data) + JSON.stringify(currentGame.map.landmarks);
  const tree = P.PontosDeInteresse(vista(props));
  assert.equal(`${e.exploredCount}/${e.visitedCount}/${e.version}|`
    + JSON.stringify(currentGame.map.data) + JSON.stringify(currentGame.map.landmarks), antes,
    'desenhar mutou o mapa, os landmarks ou a névoa');
  const nodes = [];
  (function walk(t) {
    if (Array.isArray(t)) return t.forEach(walk);
    if (t && typeof t === 'object' && t.props) { nodes.push(t); walk(t.props.children); }
  })(tree);
  return { tree, nodes, paths: nodes.filter((n) => n.type === 'Path'),
    chaves: new Set(nodes.filter((n) => n.type === 'Path').map((n) => n.key)) };
}

// ---- o registro: um tipo, uma silhueta, um nome, uma cor ----

const TIPOS = Object.keys(P.GLIFOS);
/** A chave do nó de um tipo é `ponto` + tipo, como a camada monta: derivada, não digitada. */
const chaveDe = (tipo) => `ponto${tipo}`;

test('todo tipo de ponto tem glifo, nome e cor — e nenhuma silhueta é igual a outra', () => {
  assert.deepEqual([...TIPOS].sort(), Object.keys(P.CORES_DOS_PONTOS).sort(), 'cor sem tipo');
  assert.deepEqual([...TIPOS].sort(), Object.keys(P.NOMES_DOS_PONTOS).sort(), 'nome sem tipo');
  const silhuetas = new Map();
  for (const tipo of TIPOS) {
    const glifo = P.GLIFOS[tipo];
    assert.ok(glifo.length >= 1, `${tipo} não tem traço nenhum`);
    const nome = P.NOMES_DOS_PONTOS[tipo];
    assert.ok(typeof nome === 'string' && nome.length > 2 && nome !== tipo, `${tipo} sem nome legível`);
    assert(/^#[0-9a-f]{6}$/i.test(P.CORES_DOS_PONTOS[tipo]), `${tipo} sem cor de seis dígitos`);
    for (const linha of glifo) {
      assert.ok(linha.length >= 3, `${tipo} tem polilinha que não fecha`);
      for (const [nx, ny] of linha) {
        assert.ok(Math.abs(nx) <= 1 && Math.abs(ny) <= 1, `${tipo} sai da caixa unitária`);
      }
    }
    const assinatura = JSON.stringify(glifo);
    assert.ok(!silhuetas.has(assinatura), `${tipo} repete a silhueta de ${silhuetas.get(assinatura)}`);
    silhuetas.set(assinatura, tipo);
  }
  // O pedido nomeava estes lugares um por um; se algum sair do registro, o mapa para de mostrá-lo.
  for (const tipo of ['police', 'firestation', 'busstation', 'hospital', 'clinic', 'church',
    'gasstation', 'autoshop', 'shop', 'cascade', 'cave', 'tribo']) {
    assert.ok(TIPOS.includes(tipo), `faltou o tipo ${tipo}`);
  }
});

test('nenhuma parte de um glifo come área de outra: ou é buraco, ou não se toca', () => {
  // Cada tipo é UM nó e `fillType="evenOdd"` decide o que aparece: duas partes sólidas que se
  // sobrepõem sem uma caber na outra se cancelam na interseção, e o ícone perde um pedaço no
  // mapa. Por isso a régua é por par, não "a primeira é o casulo das demais" — o posto tem duas
  // bombas lado a lado, a rodoviária tem rodas embaixo do carro e a igreja tem corpo abaixo do
  // telhado, e nenhum desses é buraco.
  let buracos = 0, soltas = 0;
  for (const tipo of TIPOS) {
    const partes = P.GLIFOS[tipo];
    for (let i = 0; i < partes.length; i++) for (let j = i + 1; j < partes.length; j++) {
      const [a, b] = [partes[i], partes[j]];
      if (contida(a, b) || contida(b, a)) { buracos++; continue; }
      assert.equal(sobreposição(a, b), 0,
        `${tipo}: as partes ${i} e ${j} se cruzam sem uma caber na outra — evenOdd apagaria a sobra`);
      soltas++;
    }
  }
  assert.ok(buracos >= 4, `só ${buracos} detalhes internos são buraco de verdade`);
  assert.ok(soltas >= 4, `só ${soltas} partes separadas convivem no registro`);
  assert.ok(TIPOS.filter((t) => P.GLIFOS[t].length > 1).length >= 4, 'quase nenhum tipo tem detalhe');
});

test('o glifo compilado em tela tem uma subpolilinha fechada por traço, na mão certa', () => {
  for (const tipo of TIPOS) {
    const linhas = polilinhas(P.glifoEm(tipo, 120.5, 33.25, 6));
    assert.equal(linhas.length, P.GLIFOS[tipo].length, `${tipo} perdeu um traço no caminho`);
    linhas.forEach((linha, i) => linha.forEach(([x, y], j) => {
      const [nx, ny] = P.GLIFOS[tipo][i][j];
      assert.equal(x, +(120.5 + nx * 6).toFixed(2), `${tipo} deslocado em x`);
      assert.equal(y, +(33.25 + ny * 6).toFixed(2), `${tipo} deslocado em y`);
    }));
  }
  // Duas cópias do mesmo tipo no frame são UM caminho, não dois nós.
  assert.equal(polilinhas(P.glifoEm('police', 0, 0, 5) + P.glifoEm('police', 50, 50, 5)).length, 2);
});

test('a ficha é um losango centrado no ponto e maior que o glifo', () => {
  const linhas = polilinhas(P.fichaEm(10, -4, 6));
  assert.equal(linhas.length, 1);
  const c = caixa(linhas[0]), k = 6 * 1.25;
  assert.deepEqual([c.x0, c.x1, c.y0, c.y1], [10 - k, 10 + k, -4 - k, -4 + k]);
});

// ---- o anel de terreno ----

test('as bandas da mata tileiam o anel sem buraco, sem sobreposição e sem tocar a cidade', () => {
  const W = 10, H = 8;
  const bandas = P.bandasDaMata(W, H);
  const passos = P.PASSOS_DA_FRONTEIRA;
  assert.deepEqual([...passos], [3, 12, F.PROFUNDIDADE_SEM_NOME, F.FRONTEIRA_ALCANCE],
    'os degraus do mapa deixaram de ser os cortes da `nomeDaTerra`');
  assert.equal(bandas.length, passos.length);
  assert.deepEqual(bandas.map((b) => b.cor), [...P.BANDAS_DA_MATA], 'a ordem do verde mudou');
  bandas.forEach((b, i) => {
    const p = passos[i], q = i === 0 ? 0 : passos[i - 1];
    assert.deepEqual({ ...b.externo }, { x: -p, y: -p, w: W + p * 2, h: H + p * 2 }, 'anel de fora');
    assert.deepEqual({ ...b.furo }, { x: -q, y: -q, w: W + q * 2, h: H + q * 2 }, 'buraco de dentro');
    if (i > 0) assert.deepEqual(bandas[i - 1].externo, b.furo,
      'a banda deixou uma fresta entre as tintas');
  });
  const último = passos[passos.length - 1];
  assert.equal(bandas.reduce((s, b) => s + área(b.externo) - área(b.furo), 0),
    (W + último * 2) * (H + último * 2) - W * H,
    'as bandas não cobrem exatamente o retângulo expandido menos a grade');
  for (let i = 0; i < bandas.length; i++) {
    for (let j = i + 1; j < bandas.length; j++) {
      const a = bandas[i], b = bandas[j];
      // Área da diferença simétrica das duas caixas-anel: zero é o mesmo que não se tocaram.
      const choqe = interseção(a.externo, b.externo) - interseção(a.furo, b.externo)
        - interseção(a.externo, b.furo) + interseção(a.furo, b.furo);
      assert.equal(choqe, 0, `bandas ${i} e ${j} se sobrepõem`);
    }
  }
});

test('a classe do tile de beira é a matéria que a frente continua', () => {
  const casos = [
    [{ kind: 'water', biome: 'forest' }, 'água'],
    [{ kind: 'road', biome: 'downtown' }, 'rua'],
    [{ kind: 'concrete', biome: 'commercial' }, 'concreto'],
    [{ kind: 'ground', biome: 'beach' }, 'areia'],
    [{ kind: 'ground', biome: 'desert' }, 'deserto'],
    [{ kind: 'ground', biome: 'savanna' }, 'deserto'],
    [{ kind: 'ground', biome: 'forest' }, 'mata'],
    [{ kind: 'ground', biome: 'pinewood' }, 'mata'],
    [{ kind: 'ground', biome: 'countryside' }, 'campo'],
    [undefined, 'campo'],
  ];
  for (const [tile, esperado] of casos) {
    assert.equal(P.classeDaBeira(tile), esperado, `classe de ${JSON.stringify(tile)}`);
  }
  // A matéria vence o bioma: rio na praia é rio, senão o anel pintaria areia sobre o canal.
  assert.equal(P.classeDaBeira({ kind: 'water', biome: 'beach' }), 'água');
  assert.equal(P.classeDaBeira({ kind: 'road', biome: 'forest' }), 'rua');
});

test('o anel tintado cobre cada tile de fora quando e somente quando a beira tem matéria', () => {
  const W = 10, H = 8;
  const tiles = tilesDaCidade(W, H);
  const pinta = (x, y, kind, biome) => Object.assign(tileDe(tiles, W, x, y), { kind, biome });
  for (let y = 0; y < H; y++) {
    pinta(0, y, y < 3 ? 'water' : 'road', y < 3 ? 'downtown' : 'commercial');
    pinta(W - 1, y, 'ground', 'beach');
  }
  for (let x = 0; x < W; x++) {
    pinta(x, 0, 'ground', 'forest');
    pinta(x, H - 1, 'concrete', 'industrial');
  }
  const retângulos = P.faixasDaFronteira(tiles, W, H);
  assert.ok(retângulos.length > 0, 'nenhuma tinta no anel');

  // 1) Disjuntos. Quem desenha agrupa por cor para virar um nó por tinta: se uma caixa cobrisse
  //    a outra, a ordem dos nós passaria a decidir o mapa.
  for (let i = 0; i < retângulos.length; i++) {
    for (let j = i + 1; j < retângulos.length; j++) {
      assert.equal(interseção(retângulos[i], retângulos[j]), 0,
        `caixas sobrepostas: ${JSON.stringify(retângulos[i])} x ${JSON.stringify(retângulos[j])}`);
    }
  }
  const alcance = P.PASSOS_DA_FRONTEIRA[P.PASSOS_DA_FRONTEIRA.length - 1];
  const grade = { x: 0, y: 0, w: W, h: H };
  for (const r of retângulos) {
    assert.equal(interseção(r, grade), 0, 'a tinta da frente cobriu a cidade');
    assert.ok(r.x >= -alcance && r.y >= -alcance && r.x + r.w <= W + alcance && r.y + r.h <= H + alcance,
      'o anel pintou além do que o corpo alcança');
    assert.ok([r.x, r.y, r.w, r.h].every(Number.isInteger), `caixa fora da grade de tiles: ${r}`);
    assert.ok(área(r) > 0, 'caixa vazia desenhada');
  }

  // 2) Cobertura, contada num grid em vez de busca linear: o anel de um mapa de 10x8 tem ~83 mil
  //    tiles e cada um deles tem de responder "quantas caixas me pintam".
  const marcas = new Int8Array((W + alcance * 2) * (H + alcance * 2));
  const índice = (x, y) => (y + alcance) * (W + alcance * 2) + (x + alcance);
  for (const r of retângulos) {
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) marcas[índice(x, y)]++;
  }
  const corDe = (x, y) => (retângulos.find((r) => engole(r, x, y)) || { cor: null }).cor;
  const cores = new Map();
  for (let y = -alcance; y < H + alcance; y++) {
    for (let x = -alcance; x < W + alcance; x++) {
      if (x >= 0 && y >= 0 && x < W && y < H) {
        assert.equal(marcas[índice(x, y)], 0, `a frente pintou o tile da cidade ${x},${y}`);
        continue;
      }
      const âncora = tileDe(tiles, W, Math.min(W - 1, Math.max(0, x)), Math.min(H - 1, Math.max(0, y)));
      const classe = P.classeDaBeira(âncora);
      const vezes = marcas[índice(x, y)];
      assert.ok(vezes <= 1, `tile ${x},${y} coberto ${vezes} vezes`);
      if (classe === 'mata' || classe === 'campo') {
        assert.equal(vezes, 0, `${classe} recebeu tinta por cima da banda de mata`);
        continue;
      }
      assert.equal(vezes, 1, `${classe} em ${x},${y} ficou sem tinta`);
      // A tinta é função da classe e do degrau, nunca de em que lado do anel o tile caiu.
      const chave = `${classe}@${degrauDe(x, y, W, H, P.PASSOS_DA_FRONTEIRA)}`;
      if (cores.has(chave)) assert.equal(corDe(x, y), cores.get(chave), `${chave} pintou de duas cores`);
      else cores.set(chave, corDe(x, y));
    }
  }
  assert.ok(cores.size >= 4 * 4, `o anel só distingue ${cores.size} classe/degrau`);
});
/** O degrau a que pertence um tile de fora — rederivado da aritmética, não lido do módulo. */
function degrauDe(x, y, W, H, passos) {
  const fora = (v, limite) => (v < 0 ? -v : v - limite + 1);
  const profundidade = Math.max(fora(x, W), fora(y, H));
  return passos.findIndex((p) => profundidade <= p);
}

test('o canto do anel segue o material do canto da grade, não o do lado vizinho', () => {
  // Só o tile (0,0) é água: se o canto herdasse o lado, o rio morria a três tiles da beira e o
  // mapa mostraria mata onde o mundo tem canal — o defeito que a fronteira inteira existe para não ter.
  const W = 10, H = 8;
  const tiles = tilesDaCidade(W, H).map((t) => ({ ...t, biome: 'forest' }));
  Object.assign(tileDe(tiles, W, 0, 0), { kind: 'water', biome: 'downtown', key: 'river' });
  const retângulos = P.faixasDaFronteira(tiles, W, H);
  assert.equal(P.classeDaBeira(tileDe(tiles, W, 0, 0)), 'água');
  assert.equal(P.classeDaBeira(tileDe(tiles, W, 1, 0)), 'mata');
  assert.equal(P.classeDaBeira(tileDe(tiles, W, 0, 1)), 'mata');
  // O canto NW é água em todos os degraus, e cada degrau tem a SUA tinta: a água escurece com a
  // profundidade de propósito, então comparar o canto com a faixa do degrau vizinho cobraria
  // igualdade entre cores que não são iguais por design.
  for (const p of P.PASSOS_DA_FRONTEIRA) {
    const canto = retângulos.find((r) => engole(r, -p, -p));
    assert.ok(canto, `o canto NW sumiu no degrau ${p}`);
    assert.equal(canto.cor, corDe(retângulos, -p, 0), 'o canto vestiu a mata do lado');
    assert.equal(canto.cor, corDe(retângulos, 0, -p), 'o canto vestiu a mata do alto');
  }
  // Os outros três cantos são mata, e o lado vizinho também: nenhum retângulo os toca.
  for (const [x, y] of [[-1, H], [W, -1], [W, H]]) {
    assert.ok(!retângulos.some((r) => engole(r, x, y)),
      `mata do canto ${x},${y} recebeu tinta de outra matéria`);
  }
  // Água só existe onde o canto alcança: o lado oeste a partir de y=1 é mata, e não foi pintado.
  assert.ok(!retângulos.some((r) => engole(r, -1, 1)), 'a água vazou do canto para o lado');
});

function corDe(retângulos, x, y) {
  const r = retângulos.find((c) => engole(c, x, y));
  assert.ok(r, `nenhuma caixa cobre ${x},${y}`);
  return r.cor;
}

// ---- as aldeias ----

test('a lista de aldeias é exatamente o que uma varredura larga do território encontra', () => {
  for (const [W, H] of [[10, 8], [64, 40]]) {
    const game = jogo(tilesDaCidade(W, H), W, H);
    const colhidas = P.pontosDaFronteira(W, H, SEM_RIO, game.map);
    assert.ok(colhidas.length > 0, `nenhuma aldeia num mundo de ${W}x${H}: o mapa não mostra tribo`);
    const célula = T.CÉLULA_DA_TRIBO;
    const esperadas = [];
    for (let cy = -12; cy <= Math.ceil((H + 320) / célula); cy++) {
      for (let cx = -12; cx <= Math.ceil((W + 320) / célula); cx++) {
        const ac = T.acampamentoDaCélula(cx, cy, W, H, SEM_RIO);
        if (ac) esperadas.push(`${ac.entrada.x.toFixed(4)},${ac.entrada.y.toFixed(4)}`);
      }
    }
    assert.deepEqual(colhidas.map((p) => `${p.x.toFixed(4)},${p.y.toFixed(4)}`).sort(),
      esperadas.sort(), 'a varredura do mapa perdeu ou inventou aldeias');
    for (const p of colhidas) {
      assert.equal(p.tipo, 'tribo');
      assert.equal(p.nome, P.NOMES_DOS_PONTOS.tribo);
      assert.equal(p.sempreVisível, true, 'aldeia atrás da névoa é aldeia que não existe');
      assert.ok(p.x < 0 || p.y < 0 || p.x >= W || p.y >= H, `aldeia dentro da cidade`);
      assert.ok(F.profundidade(p.x, p.y, W, H) <= F.FRONTEIRA_ALCANCE, 'aldeia onde ninguém chega');
    }
    assert.deepEqual(P.pontosDaFronteira(W, H, SEM_RIO, game.map), colhidas,
      'a mesma consulta no mesmo mundo devolve outra lista');
  }
});

test('nenhuma aldeia nasce na água: o rio do mapa manda na lista', () => {
  const W = 64, H = 40;
  // Oceum a oeste: tudo que está além de -40 tiles é água, e nenhuma clareira ali existe.
  const oceano = { isWaterWorld: (x) => x < -40 };
  const comÁgua = P.pontosDaFronteira(W, H, oceano, { id: 'com-oceano' });
  const semÁgua = P.pontosDaFronteira(W, H, SEM_RIO, { id: 'sem-oceano' });
  assert.ok(semÁgua.length > comÁgua.length,
    `o oceano não tirou aldeia nenhuma do mapa (${semÁgua.length} → ${comÁgua.length})`);
  for (const p of comÁgua) assert.ok(!oceano.isWaterWorld(p.x, p.y), 'aldeia plantada no mar');
  assert.ok(comÁgua.length > 0, 'oceano demais apagou o território inteiro');
});

test('a cidade tem um ponto por landmark, cachoeira e boca de caverna, lidos do gerador', () => {
  const { generateCity } = load(srcPath('data/maps/city.ts'));
  const { Map: CityMap } = load(srcPath('world/Map.ts'));
  const data = generateCity();
  const map = new CityMap(data);
  currentGame = { map, exploration: new ExplorationSystem(data.tilesW, data.tilesH) };
  const pontos = P.pontosDaCidade(currentGame);
  assert.equal(pontos.length,
    map.landmarks.length + (data.cascatas ?? []).length + (data.cavernas ?? []).length,
    'o registro perdeu ou duplicou uma fonte do gerador');
  for (const l of map.landmarks) {
    const igual = pontos.find((p) => p.tipo === l.kind && p.x === l.x && p.y === l.y);
    assert.ok(igual, `landmark ${l.kind} ficou sem ponto no mapa`);
    assert.equal(igual.nome, P.NOMES_DOS_PONTOS[l.kind]);
    assert.equal(igual.sempreVisível, false, 'a cidade tem névoa; a terra sem nome não');
  }
  // A cachoeira é anunciada pela bacia: é lá que o jogador chega, não no lábio.
  for (const c of data.cascatas ?? []) {
    assert.ok(pontos.some((p) => p.tipo === 'cascade' && p.x === c.bacia.x && p.y === c.bacia.y),
      'cachoeira anunciada fora da bacia');
  }
  for (const m of data.cavernas ?? []) {
    assert.ok(pontos.some((p) => p.tipo === 'cave' && p.x === m.x && p.y === m.y), 'boca de caverna sumiu');
  }
  const kinds = new Set(map.landmarks.map((l) => l.kind));
  assert.ok(kinds.has('police') && kinds.has('firestation') && kinds.has('busstation'),
    `o mapa gerado não traz delegacia/bombeiros/rodoviária: ${[...kinds]}`);
  assert.ok(kinds.size >= 5, `o mapa gerado só traz ${kinds.size} tipos de landmark`);
  // O contrato é do gerador para o ícone, não ao contrário: um `kind` novo sem glifo apareceria
  // no mapa como um ponto sem nome.
  const texto = fs.readFileSync(srcPath('world/Map.ts'), 'utf8');
  const carimbados = new Set([...texto.matchAll(/kind: '([a-z]+)'/g)].map((m) => m[1]));
  assert.ok(carimbados.size >= 9, `a tabela de landmarks do Map mudou de forma: ${[...carimbados]}`);
  for (const kind of carimbados) assert.ok(TIPOS.includes(kind), `o Map carimba ${kind} sem glifo`);
});

// ---- os troncos ----

test('os pontos de árvore só marcam tronco que existe, fora da grade e dentro do alcance', () => {
  const W = 64, H = 40;
  jogo(tilesDaCidade(W, H), W, H);
  const view = makeProjectors(390, 844, 0, W, H, 1, 0, 0);
  const linhas = polilinhas(P.pontosDeÁrvore(view, 390, 844, W, H, SEM_RIO, 620));
  assert.ok(linhas.length > 20, 'a mata sumiu do mapa');
  assert.ok(linhas.length <= 620 * 1.15,
    `o teto de 620 virou ${linhas.length}: o custo do radar deixou de ser conhecido`);
  for (const linha of linhas) {
    assert.equal(linha.length, 4, 'o pino de árvore deixou de ser um losango');
    const c = caixa(linha);
    const mundo = view.screenToWorld((c.x0 + c.x1) / 2, (c.y0 + c.y1) / 2);
    const tx = Math.floor(mundo.x), ty = Math.floor(mundo.y);
    assert.ok(tx < 0 || ty < 0 || tx >= W || ty >= H, 'tronco pintado dentro da cidade');
    const árvore = F.árvoreDoTile(tx, ty, W, H, SEM_RIO);
    assert.ok(árvore, `o mapa anunciou tronco em ${tx},${ty} onde o corpo passa voando`);
    assert.ok(Math.abs(árvore.x - mundo.x) < 0.02 && Math.abs(árvore.y - mundo.y) < 0.02,
      'o pino do mapa não está no pé da árvore do mundo');
    assert.ok(F.profundidade(tx, ty, W, H) <= F.FRONTEIRA_ALCANCE + 1,
      'o mapa desenhou mata além do que o corpo alcança');
  }
  // Zoom fechado dá mancha, zoom aberto dá textura — nenhum dos dois vira varredura tile a tile.
  const fechado = polilinhas(P.pontosDeÁrvore(makeProjectors(390, 844, 0, W, H, 6, 0, 0),
    390, 844, W, H, SEM_RIO, 620)).length;
  assert.ok(fechado > 0, 'no zoom máximo a mata desapareceu');
  assert.equal(P.pontosDeÁrvore(makeProjectors(390, 844, 0, W, H, 1, -1e6, 0),
    390, 844, W, H, SEM_RIO, 620), '', 'uma janela fora do mundo ainda varre a floresta');
});

// ---- a camada desenhada ----

test('a camada desenha um nó por tipo e por tinta, nunca um grupo transformado por ícone', () => {
  const W = 10, H = 8;
  const tiles = tilesDaCidade(W, H);
  const landmarks = [
    { kind: 'police', key: 'bld_policestation', x: 2.5, y: 2.5, front: { x: 2.5, y: 3.2 } },
    { kind: 'police', key: 'bld_policestation_b', x: 5.5, y: 4.5, front: { x: 5.5, y: 5.2 } },
    { kind: 'firestation', key: 'bld_firestation', x: 7.5, y: 6.5, front: { x: 7.5, y: 7.2 } },
  ];
  jogo(tiles, W, H, { landmarks, exploration: explorados(W, H, landmarks.map((l) => [l.x | 0, l.y | 0])) });
  const { nodes, paths, chaves } = desenhe({ detailed: true });
  assert.equal(nodes.filter((n) => n.props.transform).length, 0,
    'ícone virou grupo transformado: o radar passaria a pagar um nó por lugar');
  const glifos = paths.filter((n) => String(n.key).startsWith('ponto'));
  assert.equal(new Set(glifos.map((n) => n.key)).size, glifos.length, 'dois nós para o mesmo tipo');
  const porChave = new Map(glifos.map((n) => [n.key, n]));
  assert.equal(polilinhas(porChave.get('pontopolice').props.path).length, 2,
    'as duas delegacias não viraram um caminho só');
  assert.ok(chaves.has('pontofirestation'));
  assert.equal(porChave.get('pontopolice').props.color, P.CORES_DOS_PONTOS.police);
  assert.equal(porChave.get('pontofirestation').props.color, P.CORES_DOS_PONTOS.firestation);
  for (const n of glifos) assert.equal(n.props.fillType, 'evenOdd', 'sem evenOdd o buraco vira tinta');
  const tintas = paths.filter((n) => String(n.key).startsWith('tinta'));
  assert.equal(new Set(tintas.map((n) => n.key)).size, tintas.length, 'repetiu a tinta no anel');
  assert.equal(paths.filter((n) => String(n.key).startsWith('banda')).length, P.BANDAS_DA_MATA.length,
    'as bandas da mata mudaram de contagem');
});

test('o glifo desenhado pisa exatamente onde o ponto do mundo está', () => {
  const W = 10, H = 8;
  const l = { kind: 'police', key: 'bld_p', x: 3.4, y: 4.6, front: { x: 3.4, y: 5 } };
  jogo(tilesDaCidade(W, H), W, H, { landmarks: [l], exploration: explorados(W, H, [[3, 4]]) });
  const props = vista({});
  const view = makeProjectors(props.mapW, props.mapH, 0, W, H, props.zoom, props.panX, props.panY);
  const node = desenhe(props).paths.find((n) => n.key === 'pontopolice');
  assert.ok(node, 'a delegacia descoberta não foi desenhada');
  const r = P.raioDoTipo('police', true) * 0.82;
  const s = view.worldToScreen(l.x, l.y);
  const [nx, ny] = P.GLIFOS.police[0][0];
  const primeiro = polilinhas(node.props.path)[0][0];
  assert.equal(primeiro[0], +(s.x + nx * r).toFixed(2), 'o ícone não está no lugar do prédio');
  assert.equal(primeiro[1], +(s.y + ny * r).toFixed(2), 'o ícone não está no lugar do prédio');
  // No radar o ícone encolhe: cinco pixels de rua não podem virar um bloco de tinta.
  assert.ok(P.raioDoTipo('police', false) < P.raioDoTipo('police', true));
  assert.ok(P.raioDoTipo('tribo', true) > P.raioDoTipo('police', true), 'a tribo tem de ser o maior');
});

test('a névoa decide quem aparece na cidade e a terra sem nome escapa dela', () => {
  const W = 10, H = 8;
  const known = { kind: 'hospital', key: 'bld_h', x: 2.5, y: 2.5, front: { x: 2.5, y: 3 } };
  const hidden = { kind: 'church', key: 'bld_c', x: 8.5, y: 6.5, front: { x: 8.5, y: 7 } };
  const cascatas = [{ id: 0, curso: [], largura: 1, bacia: { x: 5.5, y: 3.5, raio: 1 }, topo: 2, base: 0, queda: 2 }];
  const cavernas = [{ id: 0, x: 4.5, y: 1.5, facing: 0, cota: 2 }];
  jogo(tilesDaCidade(W, H), W, H, { landmarks: [known, hidden], cascatas, cavernas,
    exploration: explorados(W, H, [[2, 2], [5, 3], [4, 1]]) });
  const { chaves } = desenhe({ detailed: true });
  assert.ok(chaves.has('pontohospital'), 'o que foi visto ficou de fora');
  assert.ok(!chaves.has('pontochurch'), 'a névoa deixou vazar quem nunca foi visto');
  assert.ok(chaves.has('pontocascade'), 'cachoeira descoberta não apareceu');
  assert.ok(chaves.has('pontocave'), 'boca de caverna descoberta não apareceu');
});

test('o radar esconde o comércio e o mapa cheio mostra', () => {
  const W = 10, H = 8;
  const loja = { kind: 'shop', key: 'bld_cafe', x: 2.5, y: 2.5, front: { x: 2.5, y: 3 } };
  const bomba = { kind: 'gasstation', key: 'bld_gas', x: 5.5, y: 5.5, front: { x: 5.5, y: 6 } };
  jogo(tilesDaCidade(W, H), W, H, { landmarks: [loja, bomba], exploration: explorados(W, H, [[2, 2], [5, 5]]) });
  const noRadar = desenhe({ detailed: false }).chaves;
  const cheio = desenhe({ detailed: true }).chaves;
  // A chave é `ponto` + tipo, e é por ela que o teste procura. À mão, um `s` a mais em `shop`
  // virava asserção vazia: o radar "escondia" um glifo que nunca teve aquele nome, e o mapa
  // cheio reprovaria para sempre sem que a camada tivesse feito nada errado.
  assert.ok(!noRadar.has(chaveDe('shop')), 'dezenas de comércios taparam a rua do radar');
  assert.ok(noRadar.has(chaveDe('gasstation')), 'o posto sumiu do radar — é ele que importa ali');
  assert.ok(cheio.has(chaveDe('shop')), 'o mapa cheio continua sem comércio');
  assert.equal([...cheio].filter((k) => String(k).startsWith('ponto')).length, 2,
    'o mapa cheio desenhou outro ponto além dos dois da cidade');
});

test('o glifo fora da janela não é desenhado, e a aldeia aparece quando a câmera aponta', () => {
  const W = 10, H = 8;
  const game = jogo(tilesDaCidade(W, H), W, H);
  const aldeias = P.pontosDaFronteira(W, H, SEM_RIO, game.map);
  assert.ok(aldeias.length > 0);
  // A ±40 tiles do mapa de 10, a terra sem nome não cabe na tela em zoom 1.
  assert.ok(!desenhe({ detailed: true }).chaves.has('pontotribo'),
    'a aldeia foi desenhada fora da janela visível');
  // Apontando a câmera para a boca de uma delas, ela tem de aparecer: é o "onde tem tribo".
  const alvo = aldeias[0];
  const base = makeProjectors(390, 844, 0, W, H, 1, 0, 0).worldToScreen(alvo.x, alvo.y);
  assert.ok(desenhe({ detailed: true, panX: 195 - base.x, panY: 422 - base.y })
    .chaves.has('pontotribo'), 'o mapa nunca mostra acampamento canibal');
});

// ---- a costura ----

/** Tira comentários sem comer `//` de dentro de string: a régua lê código de verdade. */
function semComentário(texto) {
  let out = '', i = 0;
  while (i < texto.length) {
    const c = texto[i], d = texto[i + 1];
    if (c === '"' || c === "'" || c === '`') {
      out += c; i++;
      while (i < texto.length) {
        if (texto[i] === '\\') { out += texto[i] + texto[i + 1]; i += 2; continue; }
        out += texto[i];
        if (texto[i++] === c) break;
      }
      continue;
    }
    if (c === '/' && d === '/') { while (i < texto.length && texto[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') {
      i += 2;
      while (i < texto.length && !(texto[i] === '*' && texto[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += c; i++;
  }
  return out;
}

test('a camada está costurada no MapCanvas, depois da cidade e antes do resto', () => {
  const fonte = semComentário(fs.readFileSync(srcPath('ui/MiniMap.tsx'), 'utf8'));
  assert.ok(/import \{ PontosDeInteresse \} from '\.\/PontosDeInteresse'/u.test(fonte),
    'o MiniMap deixou de importar a camada');
  const inicio = fonte.indexOf('function MapCanvas');
  assert.ok(inicio >= 0, 'não achou o MapCanvas');
  const fim = fonte.indexOf('function Legend', inicio);
  assert.ok(fim > inicio, 'não achou o fim do MapCanvas');
  const corpo = fonte.slice(inicio, fim);
  const costura = corpo.indexOf('<PontosDeInteresse');
  assert.ok(costura > 0, 'comentar a linha da camada tem de deixar esta régua vermelha');
  assert.ok(costura > corpo.indexOf('<Group clip={mask.discovered}'),
    'a camada ficou por baixo do raster da cidade');
  assert.ok(costura < corpo.indexOf('policeVisionCones'), 'a camada cobriu os cones de visão');
  assert.ok(costura < corpo.indexOf('mapRoute.length >= 2'), 'a camada cobriu a rota do GPS');
  assert.ok(costura > corpo.indexOf('if (room)'), 'dentro de uma sala o mapa voltou a desenhar a cidade');
  const abertura = corpo.slice(costura, costura + 300);
  for (const prop of ['mapW', 'mapH', 'zoom', 'panX', 'panY', 'detailed']) {
    assert.ok(abertura.includes(`${prop}={`), `a costura esqueceu de passar ${prop}`);
  }
});

console.log(`\n${passed} passaram, ${failed} falharam`);
process.exitCode = failed;
