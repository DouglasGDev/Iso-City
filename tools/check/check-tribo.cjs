// Run: node tools/check/check-tribo.cjs. O território da tribo é uma função da coordenada: a
// aldeia existe antes de alguém olhar, a mata respeita a clareira, e o que aparece no chão é o
// mesmo corpo que barra o passo.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('module');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');
const modules = new Map();

/**
 * Dublê de Skia que GRAVA os traços em vez de desenhá-los. A fase 2 existe para provar que a
 * parede pintada é a parede em que se bate, e isso só se prova medindo a geometria real: se este
 * check confiasse no `PÉ` declarado, estaria conferindo um número contra o mesmo número. Então o
 * caminho gravado é o mesmo `SkPath` que o `<Group>` recebe, e a meia-largura do pé é medida dele.
 */
class Traço {
  constructor() { this.pontos = []; }
  addRect(r) { this.pontos.push([r.x, r.y], [r.x + r.width, r.y + r.height]); return this; }
  moveTo(x, y) { this.pontos.push([x, y]); return this; }
  lineTo(x, y) { this.pontos.push([x, y]); return this; }
  close() { return this; }
  // Sombra e halo da fogueira são um path só com duas calotas (para o alfa não somar na
  // sobreposição). No dublê a união dos pontos basta: quem mede aqui é caixa e largura de pé.
  addPath(outro) { this.pontos.push(...outro.pontos); return this; }
}
class Caminho {
  constructor() { this.traços = []; }
  addRect(r) { const t = new Traço(); t.addRect(r); this.traços.push(t); return this; }
  moveTo(x, y) { const t = new Traço(); t.moveTo(x, y); this.traços.push(t); return this; }
  lineTo(x, y) { const atual = this.traços[this.traços.length - 1];
    if (atual) atual.lineTo(x, y); else { const t = new Traço(); t.moveTo(x, y); this.traços.push(t); }
    return this; }
  close() { return this; }
  addPath(outro) { this.traços.push(...outro.traços); return this; }
  isEmpty() { return this.traços.length === 0; }
  rewind() { this.traços.length = 0; }
}
const stubs = {
  react: { useMemo: (fn) => fn(), memo: (c) => c },
  'react-native-reanimated': { useSharedValue: (v) => ({ value: v }), useDerivedValue: (fn) => ({ value: fn() }) },
  'react/jsx-runtime': { jsx: () => null, jsxs: () => null, Fragment: (c) => c },
  '@shopify/react-native-skia': {
    Skia: { Path: { Make: () => new Caminho() }, XYWHRect: (x, y, width, height) => ({ x, y, width, height }),
      Paint: () => ({ setAntiAlias() {}, setColor() {}, setAlphaf() {} }), Color: () => 0 },
  },
};

/**
 * Dublês por caminho, registrados só antes da fase 3c. O `GameState` puxa meio grafo do app —
 * `SoundManager` (expo-av) e `useGameStore` (react-native) — e nada ali é comportamento do bando:
 * é a borda por onde o grito sai e por onde a frase chega à tela. Casar por sufixo em vez de pelo
 * nome do pacote é o que permite ao resto do check continuar carregando o módulo de verdade.
 */
const dubles = new Map();

function load(filename) {
  // `./TriboSprite` não tem extensão e é `.tsx`: o resolutor é o do Metro, não o do node, e um
  // check que só sabe de `.ts` deixaria a tinta de fora das provas justamente por causa do nome.
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
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  });
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.require = (name) => (Object.prototype.hasOwnProperty.call(stubs, name) ? stubs[name]
    : name.startsWith('.') ? load(path.resolve(path.dirname(filename), name)) : require(name));
  modules.set(filename, mod);
  mod._compile(compiled.outputText, filename);
  return mod.exports;
}

const F = load(path.join(root, 'src/world/Frontier.ts'));
const T = load(path.join(root, 'src/world/Tribo.ts'));
const { generateCity } = load(path.join(root, 'src/data/maps/city.ts'));
const { Map: CityMap } = load(path.join(root, 'src/world/Map.ts'));

const TRIBO_SRC = fs.readFileSync(path.join(root, 'src/world/Tribo.ts'), 'utf8');
const FRONTIER_SRC = fs.readFileSync(path.join(root, 'src/world/Frontier.ts'), 'utf8');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('OK ' + name); }
  catch (error) { failed++; console.error('FAIL ' + name + '\n' + error.stack); }
}

/**
 * O mundo real, gerado uma vez. As provas abaixo não inventam canal nem borda: elas medem a
 * aldeia no mapa que o jogo carrega, porque a pergunta que importa é "onde o rio sai da grade,
 * tem cabana em cima?" — e só a borda gerada sabe responder.
 */
const cidade = generateCity();
const CW = cidade.tilesW, CH = cidade.tilesH;
const RIO = new CityMap(cidade);
const tileDe = (x, y) => cidade.tiles[y * CW + x];
const bocas = (() => {
  const oeste = [];
  for (let y = 0; y < CH; y++) if (tileDe(0, y).kind === 'water') oeste.push(y);
  return { oeste };
})();

const CÉLULA = T.CÉLULA_DA_TRIBO;
/** A célula de um tile — a mesma conta que o `Tribo` faz, exposta para o check não adivinhar. */
const célulaDe = (tx) => Math.floor(tx / CÉLULA);

/**
 * Varre todas as células que o mundo alcança: do lado de fora mais remoto (o muro invisível
 * fica a `FRONTEIRA_ALCANCE` tiles de qualquer borda) até o outro lado. Numa grade de 240 com
 * célula de 24 são ~30 por eixo, e cada uma custa uma hash — a varredura inteira é o que o
 * render de um único quadro já paga.
 */
function todasAsCélulas() {
  const fora = Math.ceil(F.FRONTEIRA_ALCANCE / CÉLULA) + 1;
  const dentro = Math.ceil(Math.max(CW, CH) / CÉLULA);
  const lista = [];
  for (let cy = -fora; cy <= dentro + fora; cy++) {
    for (let cx = -fora; cx <= dentro + fora; cx++) lista.push([cx, cy]);
  }
  return lista;
}

function acampamentosDoMundo() {
  const achados = [];
  for (const [cx, cy] of todasAsCélulas()) {
    const ac = T.acampamentoDaCélula(cx, cy, CW, CH, RIO);
    if (ac) achados.push(ac);
  }
  return achados;
}

const ACAMPAMENTOS = acampamentosDoMundo();

test('o território existe no mapa de verdade: a tribo não é uma pasta vazia', () => {
  // Antes de provar qualquer regra, provar que há regra: se a densidade, a água ou a banda de
  // profundidade estivessem erradas, todo o resto passaria por vacuidade.
  assert.ok(ACAMPAMENTOS.length >= 6,
    `só ${ACAMPAMENTOS.length} acampamento(s) no mundo inteiro — a tribo sumiu`);
  const profs = ACAMPAMENTOS.map((a) => a.prof);
  assert.ok(Math.max(...profs) - Math.min(...profs) > 20,
    'todos os acampamentos estão na mesma profundidade: a progressão do território não existe');
});

test('dentro da cidade não há tribo: nenhum tile da grade é clareira', () => {
  for (let y = 0; y < CH; y += 7) {
    for (let x = 0; x < CW; x += 7) {
      assert.equal(T.clareiraNoTile(x, y, CW, CH, RIO), false, `clareira em (${x}, ${y}) da cidade`);
    }
  }
  for (const [x, y] of [[CW / 2, CH / 2], [1.5, 1.5], [CW - 1.5, CH - 1.5], [0.5, CH - 0.5]]) {
    assert.equal(T.acampamentoEm(x, y, CW, CH, RIO), null, `aldeia em (${x}, ${y})`);
    assert.equal(T.terraDaTribo(F.profundidade(x, y, CW, CH)), false, 'a cidade é território deles');
  }
});

test('a tribo mora exatamente onde a frente perde o nome', () => {
  // A banda não é dois números que por acaso coincidem: a HUD diz "a terra sem nome" e o
  // território começa ali. Se um dos lados mudar de régua sem o outro, isto abre.
  for (let prof = 0; prof <= 150; prof++) {
    assert.equal(T.terraDaTribo(prof), F.nomeDaTerra(prof) === 'a terra sem nome',
      `aos ${prof} tiles: a fala diz "${F.nomeDaTerra(prof)}" e o território diz ${T.terraDaTribo(prof)}`);
  }
});

test('o mesmo tile dá a mesma aldeia em qualquer aparelho', () => {
  // A célula sorteada de propósito não serve: se ela não tem aldeia, as duas comparações de
  // baixo passam por vacuidade e um cache no módulo passaria despercebido. É uma célula que o
  // próprio mapa disse que tem.
  assert.ok(ACAMPAMENTOS.length > 0, 'sem acampamento no mundo, sem o que testar');
  const c = ACAMPAMENTOS[0];
  const a = T.acampamentoDaCélula(c.cx, c.cy, CW, CH, RIO);
  const b = T.acampamentoDaCélula(c.cx, c.cy, CW, CH, RIO);
  assert.ok(a, `a célula (${c.cx}, ${c.cy}) fez uma aldeia e depois perdeu a primeira`);
  assert.deepEqual(a, b, 'a mesma célula montou dois acampamentos diferentes');
  // E a determinística não é "a mesma memória": são objetos novos, com conteúdo igual. Um cache
  // devolveria o mesmo objeto, e um objeto guardado é exatamente o que faz a aldeia deixar de
  // ser uma função da coordenada.
  assert.notEqual(a, b, 'o acampamento foi guardado em cache — não é mais uma função');
  assert.notEqual(a.cabanas, b.cabanas, 'a lista de cabanas é a mesma memória em duas leituras');
  for (const ac of ACAMPAMENTOS.slice(0, 12)) {
    assert.deepEqual(T.acampamentoDaCélula(ac.cx, ac.cy, CW, CH, RIO), ac,
      `a célula (${ac.cx}, ${ac.cy}) mudou de aldeia ao recalcular`);
  }
  assert.ok(!/Math\.random/.test(TRIBO_SRC), 'o território sorteia com Math.random');
});

test('a clareira cabe na própria célula — é isso que faz a pergunta custar uma hash', () => {
  // A invariante estrutural do módulo: centro + meia-largura nunca atravessa a borda da célula.
  // Se vazar, `acampamentoDoTile` (que consulta só a célula do ponto) deixaria de ver a clareira
  // do vizinho, e o jogador entraria numa cabana desenhada sobre a mata.
  for (const ac of ACAMPAMENTOS) {
    const base = (ac.cx + 0.5) * CÉLULA, topo = (ac.cy + 0.5) * CÉLULA;
    assert.ok(Math.abs(ac.x - base) + ac.meiaLargura <= CÉLULA / 2,
      `clareira vazando pela lateral da célula ${ac.cx}`);
    assert.ok(Math.abs(ac.y - topo) + ac.meiaAltura <= CÉLULA / 2,
      `clareira vazando pelo topo da célula ${ac.cy}`);
  }
});

test('a mata não cresce na clareira, e a clareira não vaza para o mato', () => {
  for (const ac of ACAMPAMENTOS) {
    for (let ty = Math.floor(ac.y - ac.meiaAltura); ty <= Math.ceil(ac.y + ac.meiaAltura); ty++) {
      for (let tx = Math.floor(ac.x - ac.meiaLargura); tx <= Math.ceil(ac.x + ac.meiaLargura); tx++) {
        const dx = (tx + 0.5 - ac.x) / ac.meiaLargura;
        const dy = (ty + 0.5 - ac.y) / ac.meiaAltura;
        const dentro = dx * dx + dy * dy <= 1;
        assert.equal(T.clareiraNoTile(tx, ty, CW, CH, RIO), dentro,
          `tile (${tx}, ${ty}) mudou de dono na borda da clareira`);
        // A pergunta do HUD e do guerreiro tem de ter a mesma resposta da pergunta do chão: se
        // `acampamentoDoTile` esquecer a elipse e devolver o acampamento da célula inteira, o
        // jogador ouve "estou na aldeia deles" estando a vinte tiles de mato dela.
        assert.equal(T.acampamentoEm(tx + 0.5, ty + 0.5, CW, CH, RIO) !== null, dentro,
          `quem pergunta "estou na aldeia?" discorda de quem pinta o chão, em (${tx}, ${ty})`);
        if (dentro) {
          assert.equal(F.árvoreDoTile(tx, ty, CW, CH, RIO), null,
            `tronco dentro do acampamento em (${tx}, ${ty})`);
        }
      }
    }
  }
  // E a mata continua sendo mata: sem este controle, "a clareira cortou a floresta" passaria
  // com a floresta inteira cortada.
  let troncos = 0, testados = 0;
  for (let d = 45; d < 110; d += 3) {
    for (let y = 0; y < CH; y += 5) {
      testados++;
      if (F.árvoreDoTile(-d, y, CW, CH, RIO)) troncos++;
    }
  }
  assert.ok(troncos > testados * 0.12,
    `a mata do território sumiu: ${troncos}/${testados} tiles têm tronco`);
});

test('nenhum acampamento no rio: a estrada líquida continua sendo da piranha', () => {
  // Duas leituras da mesma água: a fogueira não pode estar no canal, e o canal não pode ser
  // clareira de ninguém. É o mesmo predicado que a frente usa para não plantar tronco ali.
  for (const ac of ACAMPAMENTOS) {
    assert.equal(RIO.isWaterWorld(ac.x, ac.y), false,
      `fogueira no rio em (${ac.x.toFixed(1)}, ${ac.y.toFixed(1)})`);
    for (let ty = Math.floor(ac.y - ac.meiaAltura); ty <= Math.ceil(ac.y + ac.meiaAltura); ty++) {
      for (let tx = Math.floor(ac.x - ac.meiaLargura); tx <= Math.ceil(ac.x + ac.meiaLargura); tx++) {
        const dx = (tx + 0.5 - ac.x) / ac.meiaLargura;
        const dy = (ty + 0.5 - ac.y) / ac.meiaAltura;
        if (dx * dx + dy * dy > 1) continue;
        assert.equal(RIO.isWaterWorld(tx + 0.5, ty + 0.5), false,
          `clareira sobre a água em (${tx}, ${ty})`);
      }
    }
  }
  for (const y of bocas.oeste) {
    for (let d = 1; d <= 140; d++) {
      assert.equal(T.clareiraNoTile(-d, y, CW, CH, RIO), false,
        `clareira atravessando o canal em (-${d}, ${y})`);
    }
  }
});

test('o acampamento é um lugar: cabanas em volta da fogueira e uma entrada marcada', () => {
  const dentro = (ac, x, y) => {
    const dx = (x - ac.x) / ac.meiaLargura;
    const dy = (y - ac.y) / ac.meiaAltura;
    return dx * dx + dy * dy <= 1;
  };
  for (const ac of ACAMPAMENTOS) {
    assert.ok(ac.cabanas.length >= 3 && ac.cabanas.length <= 6,
      `${ac.cabanas.length} cabanas: ou é casebre, ou é cidade`);
    assert.equal(ac.fogueira.x, ac.x, 'a fogueira não é o centro do lugar');
    for (const caba of ac.cabanas) {
      assert.ok(dentro(ac, caba.x, caba.y), `cabana do lado de fora da clareira em (${caba.x.toFixed(1)}, ${caba.y.toFixed(1)})`);
      assert.ok(caba.raio > 0.5 && caba.raio < 1.5, `cabana com raio de ${caba.raio}: ou é poste, é prédio`);
    }
    // Cabana em cima de cabana é um desenho quebrado e um colisor impossível de contornar.
    for (const a of ac.cabanas) for (const b of ac.cabanas) {
      if (a === b) continue;
      assert.ok(Math.hypot(a.x - b.x, a.y - b.y) > a.raio + b.raio, 'duas cabanas sobrepostas');
    }
    // O lugar tem porta, e a porta dá para a cidade. Medido contra o `rumo` publicado pelo
    // próprio acampamento, e não contra a `face`: a face é a palavra do jogo ('noroeste'), o rumo
    // é a conta. Num canto do mundo a cidade fica numa diagonal que nenhuma face nomeia, e
    // cobrar a face seria cobrar um retrato aproximado de uma porta real.
    assert.ok(dentro(ac, ac.entrada.x, ac.entrada.y), 'a entrada está fora da clareira');
    const portx = ac.entrada.x - ac.x, porty = ac.entrada.y - ac.y;
    assert.ok(portx * ac.rumo.x + porty * ac.rumo.y > 0.5,
      'a entrada está virada para o fim do mundo, não para a cidade');
    assert.ok(Math.hypot(portx, porty) > 2, `a porta encostada na fogueira: ${Math.hypot(portx, porty).toFixed(2)} tiles`);
    if (ac.totem) {
      assert.ok((ac.totem.x - ac.x) * ac.rumo.x + (ac.totem.y - ac.y) * ac.rumo.y > 0,
        'o totem está nas costas do acampamento, virado para o fim do mundo');
      // O totem marca a porta: se ele mora em outro lugar, a entrada é só um desenho.
      assert.ok(Math.hypot(ac.totem.x - ac.entrada.x, ac.totem.y - ac.entrada.y) < 0.01,
        'o totem não está na entrada');
    }
    // E a porta leva a algum lugar: nenhuma cabana pode estar sobre o caminho reto entre a boca
    // e a fogueira. A régua é a distância ao segmento, e não a distância ao ponto da entrada,
    // porque uma casa pode estar a três tiles da boca e ainda assim atravessar a trilha dela —
    // o que jogador vê como "porta" é o corredor, não o marco.
    const ax = ac.entrada.x, ay = ac.entrada.y;
    const bx = ac.fogueira.x, by = ac.fogueira.y;
    const pp = (bx - ax) * (bx - ax) + (by - ay) * (by - ay);
    for (const caba of ac.cabanas) {
      const t = Math.max(0, Math.min(1, ((caba.x - ax) * (bx - ax) + (caba.y - ay) * (by - ay)) / pp));
      const d = Math.hypot(caba.x - (ax + (bx - ax) * t), caba.y - (ay + (by - ay) * t));
      assert.ok(d > caba.raio,
        `uma cabana fecha o corredor da entrada: a ${d.toFixed(2)} tiles da trilha, raio ${caba.raio.toFixed(2)}`);
    }
    // E a porta é o vão mais largo do anel, medido em ângulo e não em intenção: nem a casa da
    // esquerda nem a da direita podem chegar perto da linha da boca. A distância ao corredor
    // acima não pega isto sozinha — uma casa a trinta graus da porta está longe da trilha e
    // ainda assim fecha a vista de "aqui se entra", que é o que o jogador lê de fora.
    const φd = Math.atan2(ac.entrada.y - ac.y, ac.entrada.x - ac.x);
    const dobras = ac.cabanas.map((c) => {
      let a = Math.atan2(c.y - ac.y, c.x - ac.x) - φd;
      while (a > Math.PI) a -= Math.PI * 2;
      while (a < -Math.PI) a += Math.PI * 2;
      return a;
    });
    const esquerda = Math.min(...dobras.filter((a) => a < 0).map((a) => -a));
    const direita = Math.min(...dobras.filter((a) => a > 0));
    assert.ok(esquerda > 0.6 && direita > 0.6,
      `a porta virou fresta: ${esquerda.toFixed(2)} rad de um lado, ${direita.toFixed(2)} do outro`);
    assert.ok(ac.ossos.length >= 2, 'um acampamento canibal sem osso nenhum');
  }
});

test('a fogueira barra: corpo em cima dela é posto para fora', () => {
  const corpo = { x: 0, y: 0, radius: 0.15 };
  for (const ac of ACAMPAMENTOS.slice(0, 8)) {
    corpo.x = ac.fogueira.x; corpo.y = ac.fogueira.y;
    F.seguraNaFronteira(corpo, CW, CH, RIO);
    assert.ok(Math.hypot(corpo.x - ac.fogueira.x, corpo.y - ac.fogueira.y)
      >= corpo.radius + ac.fogueira.raio, 'o jogador ficou dentro da fogueira');
  }
});

test('atravesar o acampamento a pé não é atravessar o ar', () => {
  // O passo varrido: um corpo empurrado continuamente contra o centro do lugar tem de parar na
  // parede de cabanas, não teletransportar para dentro delas. É a mesma chamada que o
  // `MovementSystem` faz por tick, então o que esta prova vê é o que o jogador sente.
  const corpo = { x: 0, y: 0, radius: 0.15 };
  for (const ac of ACAMPAMENTOS.slice(0, 6)) {
    const [vx, vy] = ac.face === 'NW' ? [-1, -1] : ac.face === 'SE' ? [1, 1]
      : ac.face === 'NE' ? [1, -1] : [-1, 1];
    corpo.x = ac.x - vx * 10; corpo.y = ac.y - vy * 10;
    let entrou = false;
    for (let i = 0; i < 400; i++) {
      corpo.x += vx * 0.08; corpo.y += vy * 0.08;
      F.seguraNaFronteira(corpo, CW, CH, RIO);
      for (const pino of T.pinosDoAcampamento(ac)) {
        const d = Math.hypot(corpo.x - pino.x, corpo.y - pino.y);
        if (d < corpo.radius + pino.raio - 0.01) entrou = true;
      }
    }
    assert.ok(!entrou, `corpo atravessou um pino do acampamento (${ac.cx}, ${ac.cy})`);
  }
});

test('a aldeia mais perto é mesmo a mais perto', () => {
  for (const ac of ACAMPAMENTOS.slice(0, 10)) {
    const achada = T.aldeiaMaisPerto(ac.x + 3, ac.y - 2, CW, CH, RIO);
    assert.ok(achada, 'no meio do território, nenhuma aldeia por perto');
    // Força bruta na vizinhança larga: o que a função devolve tem de ser o mínimo real.
    let melhor = null, distância = Infinity;
    for (let oy = -3; oy <= 3; oy++) {
      for (let ox = -3; ox <= 3; ox++) {
        const c = T.acampamentoDaCélula(ac.cx + ox, ac.cy + oy, CW, CH, RIO);
        if (!c) continue;
        const d = Math.hypot(c.x - (ac.x + 3), c.y - (ac.y - 2));
        if (d < distância) { distância = d; melhor = c; }
      }
    }
    assert.equal(achada.id, melhor.id, 'a aldeia mais perto devolveu outra');
  }
});

test('o território fecha conforme se entra, e para antes do muro invisível', () => {
  assert.equal(T.densidadeDoTerritório(0), 0, 'a cidade é território');
  assert.equal(T.densidadeDoTerritório(39.9), 0, 'a mata velha é território');
  assert.ok(T.densidadeDoTerritório(40) > 0, 'a terra sem nome não é território');
  assert.ok(T.densidadeDoTerritório(80) > T.densidadeDoTerritório(41),
    'o território não adensa: entrar nele não muda nada');
  assert.equal(T.densidadeDoTerritório(F.FRONTEIRA_ALCANCE), 0, 'há aldeia no fim do mundo');
  for (const ac of ACAMPAMENTOS) {
    assert.ok(ac.prof >= F.PROFUNDIDADE_SEM_NOME, `aldeia a ${ac.prof} tiles: antes da hora`);
    assert.ok(ac.prof < F.FRONTEIRA_ALCANCE, 'aldeia colada no muro invisível');
  }
  // Medido, não declarado: as células do fundo do território têm de ter mais aldeias que as da
  // porta. É a progressão que o jogador sente, e é o único jeito de a curva não ser enfeite.
  //
  // As faixas não são arbitrarias: o centro de uma célula é `(cx+0.5)·24`, então a profundidade
  // das células vem quantizada em degraus de ~24 tiles (medido: 36, 60, 84, 108, 132 ao longo dos
  // eixos). Uma faixa estreta como [40,60) cairia num degrau quase vazio e a comparação seria
  // entre dois ruídos — 4 células medidas contra 60. As faixas abaixo pegam um degrau inteiro de
  // cada lado e o guardião abaixo abre a boca se algum dia isso voltar a não acontecer.
  const faixa = (de, até) => {
    let com = 0, totas = 0;
    for (const [cx, cy] of todasAsCélulas()) {
      const prof = F.profundidade((cx + 0.5) * CÉLULA, (cy + 0.5) * CÉLULA, CW, CH);
      if (prof < de || prof >= até) continue;
      totas++;
      if (T.acampamentoDaCélula(cx, cy, CW, CH, RIO)) com++;
    }
    return { com, totas };
  };
  const porta = faixa(48, 72), fundo = faixa(96, 120);
  assert.ok(porta.totas > 40 && fundo.totas > 40,
    `varredura curta demais para medir nada (${porta.totas}/${fundo.totas})`);
  assert.ok(fundo.com / fundo.totas > porta.com / porta.totas,
    `o fundo não é mais habitado que a porta: ${porta.com}/${porta.totas} vs ${fundo.com}/${fundo.totas}`);
});

test('uma só mão para o território: chão, mata e passo perguntam à mesma função', () => {
  // A partitura é a mesma lição da água: se a regra da clareira for copiada para o render ou
  // para o movimento, as três leituras de uma coordenada envelhecem diferente e a aldeia deixa
  // de ser um lugar.
  assert.match(FRONTIER_SRC, /import \{[^}]*\bclareiraNoTile\b[^}]*\} from '\.\/Tribo'/,
    'a mata não consulta mais o território');
  assert.match(FRONTIER_SRC, /import \{[^}]*\bempurraDoAcampamento\b[^}]*\} from '\.\/Tribo'/,
    'o passo não consulta mais o território');
  assert.ok(FRONTIER_SRC.includes('clareiraNoTile(tx, ty, W, H, água)'),
    'a clareira deixou de cortar o tronco no `árvoreDoTile`');
  assert.ok(FRONTIER_SRC.includes('empurraDoAcampamento(corpo, W, H, água)'),
    'a cabana deixou de barrar no `seguraNaFronteira`');
  assert.match(FRONTIER_SRC, /if \(prof < PROFUNDIDADE_SEM_NOME\)/,
    'a fala da fronteira voltou a ter um número próprio para a terra sem nome');
  // E o território não reimplementa a fronteira: profundidade, hash e face vêm de lá.
  for (const nome of ['sorte', 'profundidade', 'faceDaFronteira', 'chaveDoTile']) {
    assert.ok(new RegExp(`import \\{[\\s\\S]*\\b${nome}\\b[\\s\\S]*\\} from '\\.\\/Frontier'`).test(TRIBO_SRC),
      `o Tribo voltou a ter a própria conta de ${nome}`);
    assert.ok(!new RegExp(`function ${nome}\\b`).test(TRIBO_SRC),
      `o Tribo reimplementou ${nome}`);
  }
});

test('nada do território é decoração: cada campo do acampamento é lido por alguém', () => {
  // Os pinos que o desenho usa são os mesmos que o movimento barra — uma função, não duas
  // listas. Se o render precisar de um campo que só existe no desenho, esta prova abre.
  for (const ac of ACAMPAMENTOS.slice(0, 10)) {
    const pinos = T.pinosDoAcampamento(ac);
    // O `+ 2` é o centro do lugar: a fogueira e o poste da amarra, os dois corpos que existem em
    // toda clareira. Um deles sumir da lista é a casa desenhada sem parede ou a parede invisível.
    assert.equal(pinos.length, ac.cabanas.length + (ac.totem ? 1 : 0) + 2,
      'a lista de corpos sólidos não é o acampamento inteiro');
    for (const pino of pinos) {
      assert.ok(Number.isFinite(pino.x) && Number.isFinite(pino.y) && pino.raio > 0,
        'um pino sem geometria');
    }
    assert.equal(T.célulaDaTribo(Math.floor(ac.x), Math.floor(ac.y)).cx, ac.cx,
      'a célula do acampamento não é a célula do ponto dele');
  }
});

/**
 * ===========================================================================
 * FASE 2 — o acampamento desenhado.
 *
 * A lição que a fronteira já pagou e que aqui se cobra de novo: um cenário que só existe dentro
 * de um `<Group>` não pode ser lido por ninguém, e um render que confia no próprio comentário não
 * prova nada. Então estas provas carregam os MÓDULOS REAIS (`TriboSprite.tsx`, `TriboStatics.ts`)
 * num dublê de Skia que grava os traços, e medem. O que se mede são as três costuras do desenho:
 * o corpo (o nó tem de ter o raio do pino), a tinta (o pé pintado tem de medir o `PÉ` declarado)
 * e a janela (o que a câmera alcança aparece, e o que ela deixa para trás sai da memória).
 * ===========================================================================
 */
const SPR = load(path.join(root, 'src/render/TriboSprite.tsx'));
const ST = load(path.join(root, 'src/render/TriboStatics.ts'));
const { FogSystem } = load(path.join(root, 'src/systems/FogSystem.ts'));
const { GAME_CONFIG } = load(path.join(root, 'src/game/GameConfig.ts'));
const { worldToScreen, depthOf } = load(path.join(root, 'src/world/IsoUtils.ts'));
const { quadroDaCabana, quadroDoTotem, quadroDaFogueira, quadroDoOsso, quadroDoPoste,
  brilhoDaFogueira, PÉ, RAIO_DE_PIXEL, caixaDoNodo } = SPR;
const { triboNodesFor, triboCacheStats } = ST;

const SPRITE_SRC = fs.readFileSync(path.join(root, 'src/render/TriboSprite.tsx'), 'utf8');
const STATICS_SRC = fs.readFileSync(path.join(root, 'src/render/TriboStatics.ts'), 'utf8');
const SORTED_SRC = fs.readFileSync(path.join(root, 'src/render/SortedWorldLayer.tsx'), 'utf8');
const CHAO_SRC = fs.readFileSync(path.join(root, 'src/render/FrontierLayer.tsx'), 'utf8');

/** Os quadros exportados, nas mesmas chamadas que o `<Group>` faz. */
const QUADROS = [
  ...[0, 1, 2].flatMap((planta) => [
    { rótulo: `cabana${planta} frente`, tipo: 'cabana', frame: quadroDaCabana(planta, false) },
    { rótulo: `cabana${planta} costas`, tipo: 'cabana', frame: quadroDaCabana(planta, true) },
  ]),
  { rótulo: 'totem frente', tipo: 'totem', frame: quadroDoTotem(true) },
  { rótulo: 'totem costas', tipo: 'totem', frame: quadroDoTotem(false) },
  ...[0, 1, 2].map((v) => ({ rótulo: `fogueira${v}`, tipo: 'fogueira', frame: quadroDaFogueira(v) })),
  ...[0, 1, 2].map((v) => ({ rótulo: `osso${v}`, tipo: 'osso', frame: quadroDoOsso(v) })),
  { rótulo: 'poste frente', tipo: 'poste', frame: quadroDoPoste(true) },
  { rótulo: 'poste costas', tipo: 'poste', frame: quadroDoPoste(false) },
];

/** Caixa de um quadro gravado, sobre todas as tintas. */
function caixaDaArte(frame) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const caminho of frame) for (const traço of caminho.traços) for (const [x, y] of traço.pontos) {
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  assert.ok(Number.isFinite(x0), 'o quadro não gravou tinta nenhuma');
  return { x0, y0, x1, y1 };
}

/**
 * A meia-largura do PÉ desenhado: a maior |x| da silhueta (tinta 0) nos pontos na altura do pé ou
 * abaixo dele. É o número que `escala` promete casar com o raio do pino, e acima da linha do pé o
 * que existe é telhado — que por definição sobra para fora do corpo.
 */
function meiaLarguraDoPé(frame) {
  let meia = 0;
  for (const traço of frame[0].traços) for (const [x, y] of traço.pontos) {
    if (y >= 0) meia = Math.max(meia, Math.abs(x));
  }
  return meia;
}

/**
 * A impressão digital de um quadro gravado: dois desenhos com a mesma assinatura são o mesmo
 * desenho, e uma `away` que não muda a assinatura não muda a tela.
 */
function assinatura(frame) {
  return frame.map((c) => c.traços.map((t) => t.pontos.map((p) => p.join(',')).join(';')).join('|')).join('#');
}

/**
 * Um `GameState` mínimo para o desenho: o `Map` de verdade (cota contínua, água, tamanho do mundo)
 * e um `FogSystem` de verdade, porque a janela de neblina É a régua do que existe no quadro. O que
 * não se finge aqui é o importante: nada nestas provas depende de NPCs, veículos ou relógio.
 */
function jogoEm(x, y) {
  const fog = new FogSystem();
  return { map: RIO, fog, viewW: 844, viewH: 390,
    camera: { x, y, zoom: GAME_CONFIG.ZOOM_DEFAULT, h: RIO.heightSmoothAt(x, y) } };
}

const NOSSO_AC = ACAMPAMENTOS[0];

test('o corpo desenhado é o corpo que barra: um nó por pino, com o raio do pino', () => {
  const game = jogoEm(NOSSO_AC.x, NOSSO_AC.y);
  const nós = triboNodesFor(game).filter((n) => n.id.startsWith(`tribo:${NOSSO_AC.id}:`));
  assert.ok(nós.length > 0, 'a câmera em cima do acampamento não desenhou nada');
  const esperados = [
    ...NOSSO_AC.cabanas.map((c, i) => [`cabana:${i}`, 'cabana', c]),
    ...(NOSSO_AC.totem ? [['totem', 'totem', NOSSO_AC.totem]] : []),
    ['fogueira', 'fogueira', NOSSO_AC.fogueira],
    ['poste', 'poste', NOSSO_AC.poste],
  ];
  assert.equal(nós.filter((n) => n.tipo !== 'osso').length, esperados.length,
    'o número de corpos desenhados não é o número de corpos sólidos');
  for (const [sufixo, tipo, parte] of esperados) {
    const n = nós.find((x) => x.id === `tribo:${NOSSO_AC.id}:${sufixo}`);
    assert.ok(n, `faltou o nó ${sufixo}`);
    assert.equal(n.tipo, tipo, `${sufixo} é do tipo ${n.tipo}`);
    // A conta única do módulo, lida do lado de lá: se a escala for a do desenho, o raio volta.
    const raioDesenhado = n.escala * PÉ[tipo] / RAIO_DE_PIXEL;
    assert.ok(Math.abs(raioDesenhado - parte.raio) < 1e-9,
      `${sufixo}: pino de ${parte.raio.toFixed(3)} tiles, desenho de ${raioDesenhado.toFixed(3)}`);
    // E o nó pisa o lugar certo: a âncora é a projeção do corpo com a cota contínua, não um
    // arredondamento de tile — é por isso que uma cabana num morro não flutua nem afunda.
    const h = RIO.heightSmoothAt(parte.x, parte.y);
    const p = worldToScreen(parte.x, parte.y, h);
    assert.equal(n.sx, p.x, `${sufixo} desviou do pé na horizontal`);
    assert.equal(n.sy, p.y, `${sufixo} desviou do pé na vertical`);
    assert.equal(n.depth, depthOf(parte.x, parte.y, h), `${sufixo} entrou na fila com a profundidade errada`);
  }
  // O osso é o que diz que aqui se comeu, e não o que barra: ele aparece na aldeia sem virar pino.
  assert.equal(nós.filter((n) => n.tipo === 'osso').length, NOSSO_AC.ossos.length,
    'a conta de ossos desenhados não bate com a do acampamento');
  assert.equal(T.pinosDoAcampamento(NOSSO_AC).length, esperados.length,
    'o osso entrou na lista de corpos sólidos');
});

test('o pé pintado mede o PÉ declarado — a escala não é conversa de comentário', () => {
  for (const q of QUADROS) {
    if (q.tipo === 'osso') continue;
    const meia = meiaLarguraDoPé(q.frame);
    assert.ok(Math.abs(meia - PÉ[q.tipo] / 2) <= 1,
      `${q.rótulo}: pé desenhado de ${meia.toFixed(1)} px, PÉ declara ${PÉ[q.tipo]} (alvo ${(PÉ[q.tipo] / 2).toFixed(1)})`);
  }
  // Um tile de raio vale a elipse inteira: é esta igualdade que faz o `escala` de `TriboStatics`
  // ser a ÚNICA conta entre colisor e desenho, e não uma das duas.
  assert.equal(RAIO_DE_PIXEL, 64 * Math.SQRT2, 'a projeção de um círculo de um tile mudou de conta');
});

test('as vistas são de verdade: frente e costas são desenhos diferentes', () => {
  // Se `away` escolher o mesmo path nas duas vistas, a porta da cabana é um desenho fixo e o
  // jogador entra pela parede. É barato de provar e é exatamente o que se quebra ao refatorar.
  for (const planta of [0, 1, 2]) {
    assert.notEqual(assinatura(quadroDaCabana(planta, false)), assinatura(quadroDaCabana(planta, true)),
      `a planta ${planta} tem a mesma tinta de frente e de costas`);
  }
  assert.notEqual(assinatura(quadroDoTotem(true)), assinatura(quadroDoTotem(false)),
    'o totem tem uma só vista, e `away` não muda nada nele');
  // A corda do poste é a única tinta do lugar que diz "aqui se amarra alguém": sem duas vistas, o
  // cativeiro seria um pau qualquer e a aldeia não teria o seu centro de castigo.
  assert.notEqual(assinatura(quadroDoPoste(true)), assinatura(quadroDoPoste(false)),
    'o poste tem uma só vista, e a corda nunca aparece');
});

test('frente, costas e espelho são a projeção da porta, não um chute', () => {
  const game = jogoEm(NOSSO_AC.x, NOSSO_AC.y);
  const nós = triboNodesFor(game).filter((n) => n.id.startsWith(`tribo:${NOSSO_AC.id}:`));
  const sufixo = (n) => n.id.slice(`tribo:${NOSSO_AC.id}:`.length);
  const índice = (n) => Number(sufixo(n).split(':')[1]);
  const normal = (n) => {
    if (n.tipo === 'cabana') {
      const c = NOSSO_AC.cabanas[índice(n)];
      return [c, NOSSO_AC.x - c.x, NOSSO_AC.y - c.y];
    }
    if (n.tipo === 'totem') return [NOSSO_AC.totem, NOSSO_AC.rumo.x, NOSSO_AC.rumo.y];
    if (n.tipo === 'poste') return [NOSSO_AC.poste, NOSSO_AC.x - NOSSO_AC.poste.x, NOSSO_AC.y - NOSSO_AC.poste.y];
    if (n.tipo === 'osso') {
      const o = NOSSO_AC.ossos[índice(n)];
      return [o, o.x - NOSSO_AC.x, o.y - NOSSO_AC.y];
    }
    return null;
  };
  let vistas = 0;
  for (const n of nós) {
    const parte = normal(n);
    if (!parte) continue;
    const [p, nx, ny] = parte;
    // A face é a direção em que a porta olha PROJETADA no plano iso — com a cota de fora, porque
    // face é para onde o corpo aponta, não se o terreno em volta desce. É `worldToScreen` que diz,
    // e não a conta `nx + ny` copiada para cá: se `IsoUtils` mudar, esta prova muda junto.
    const base = worldToScreen(p.x, p.y, 0), ponta = worldToScreen(p.x + nx, p.y + ny, 0);
    assert.equal(n.away, ponta.y - base.y <= 0, `${n.id}: a vista mostrada não é a da projeção da porta`);
    assert.equal(n.espelha, ponta.x - base.x < 0, `${n.id}: o espelho não é o lado para onde a porta cai`);
    vistas++;
  }
  assert.ok(vistas >= 3, `só ${vistas} corpos têm orientação para conferir`);
});

test('as quatro leituras de uma porta saem de dois desenhos', () => {
  // `away` × `espelha` são duas metades do arco de câmera, e a promessa do módulo é que os dois
  // juntos cobrem o mundo inteiro sem precisar de quatro vistas por planta. Se alguma combinação
  // nunca acontecer, um dos booleanos é enfeite — e se acontecer em todo canto, a conta é constante.
  //
  // A amostra é espalhada pelo mundo de propósito: os primeiros acampamentos da varredura moram
  // todos no mesmo canto, têm a cidade no mesmo rumo e o vão do anel na mesma diagonal, e as suas
  // portas nunca apontariam para um dos quatro quadrantes. Medir só eles seria provar um acaso da
  // ordem do laço.
  const passo = Math.max(1, Math.floor(ACAMPAMENTOS.length / 16));
  const vistas = new Set();
  for (const ac of ACAMPAMENTOS.filter((_, i) => i % passo === 0)) {
    const nós = triboNodesFor(jogoEm(ac.x, ac.y))
      .filter((n) => n.id.startsWith(`tribo:${ac.id}:`) && n.tipo === 'cabana');
    for (const n of nós) vistas.add(`${n.away},${n.espelha}`);
  }
  assert.equal(vistas.size, 4, `só ${[...vistas].join(' | ')} — a aldeia inteira olha para um lado`);
});

test('a caixa de neblina guarda a arte escalada', () => {
  const node = (tipo, escala) => ({ id: `t:${tipo}`, tipo, sx: 0, sy: 0, escala, planta: 0,
    away: false, espelha: false, depth: 0 });
  for (const q of QUADROS) {
    const b = caixaDaArte(q.frame);
    const halo = q.tipo === 'fogueira' ? caixaDaArte([brilhoDaFogueira()]) : null;
    const meia = Math.max(-b.x0, b.x1, halo ? Math.max(-halo.x0, halo.x1) : 0);
    const topo = Math.max(-b.y0, halo ? -halo.y0 : 0);
    const base = Math.max(b.y1, halo ? halo.y1 : 0);
    const caixa = caixaDoNodo(node(q.tipo, 1));
    assert.ok(caixa.x <= -meia - 1e-9 && caixa.x + caixa.width >= meia - 1e-9,
      `${q.rótulo}: a neblina corta a arte na horizontal (${(-meia).toFixed(0)}..${meia.toFixed(0)} fora de ${caixa.x.toFixed(0)}..${(caixa.x + caixa.width).toFixed(0)})`);
    assert.ok(caixa.y <= -topo - 1e-9 && caixa.y + caixa.height >= base - 1e-9,
      `${q.rótulo}: a neblina corta a arte na vertical (${(-topo).toFixed(0)}..${base.toFixed(0)} fora de ${caixa.y.toFixed(0)}..${(caixa.y + caixa.height).toFixed(0)})`);
    // E a caixa não engoliu o mundo: ela pode folgar, mas não pode passar de três vezes a largura
    // do que se desenha — uma caixa enorme é a neblina pagando para pintar mato vazio.
    assert.ok(caixa.width <= 3 * 2 * meia,
      `${q.rótulo}: caixa de ${caixa.width.toFixed(0)} px para ${meia.toFixed(0)} de arte de cada lado`);
    assert.ok(caixa.height <= 4 * (topo + base),
      `${q.rótulo}: caixa de ${caixa.height.toFixed(0)} px para ${(topo + base).toFixed(0)} de arte`);
  }
  // A caixa acompanha a escala: um recorte que esquece o `escala` do nó é uma cabana cortada ao
  // meio na fogueira, e um osso minúsculo com janela de gigante.
  for (const tipo of ['cabana', 'totem', 'fogueira', 'osso', 'poste']) {
    const largura = (escala) => caixaDoNodo(node(tipo, escala)).width;
    assert.ok(Math.abs(largura(2) - 2 * largura(1)) < 1e-9, `a caixa de ${tipo} não dobra com a escala`);
    assert.ok(Math.abs(largura(0.47) - 0.47 * largura(1)) < 1e-9, `a caixa de ${tipo} não encolhe com a escala`);
  }
});

test('todo corpo desenhado pisa a terra pisada', () => {
  // A cabana não pode encostar no mato: é a mesma elipse que corta o tronco no `Frontier`, então
  // um pino cuja borda sai da clareira seria uma casa desenhada sobre uma pinheira — ou um tronco
  // invisível atravessado na porta. Medido no anel inteiro, não no centro.
  for (const ac of ACAMPAMENTOS) {
    const partes = [...ac.cabanas, ac.fogueira, ac.poste, ...(ac.totem ? [ac.totem] : []), ...ac.ossos];
    for (const parte of partes) {
      const raio = parte.raio ?? 0;
      for (let i = 0; i < 12; i++) {
        const φ = (i / 12) * Math.PI * 2;
        const tx = Math.floor(parte.x + Math.cos(φ) * raio);
        const ty = Math.floor(parte.y + Math.sin(φ) * raio);
        assert.equal(T.clareiraNoTile(tx, ty, CW, CH, RIO), true,
          `corpo do acampamento (${ac.cx}, ${ac.cy}) vazando para a mata em (${tx}, ${ty})`);
      }
    }
  }
});

test('o poste da amarra cabe na clareira sem subir em cima de outro corpo', () => {
  // O cativeiro acrescenta um corpo sólido no meio do lugar, e um corpo no meio tem de caber entre
  // os que já existem. Se o poste nascesse dentro do pino de uma cabana, `empurraDoAcampamento`
  // empurraria o prisioneiro contra a parede a cada tique e a amarra viraria um braço de borracha:
  // o corpo preso num pino e arrastado por outro é o mesmo bug do transporte que escreveu posição
  // enquanto o colisor escrevia posição. Medido no pior caso do mundo, não no acampamento da frente.
  const pior = { casa: Infinity, fogo: Infinity, totem: Infinity };
  for (const ac of ACAMPAMENTOS) {
    const folga = (v) => Math.hypot(ac.poste.x - v.x, ac.poste.y - v.y) - (ac.poste.raio + v.raio);
    for (const c of ac.cabanas) pior.casa = Math.min(pior.casa, folga(c));
    pior.fogo = Math.min(pior.fogo, folga(ac.fogueira));
    if (ac.totem) pior.totem = Math.min(pior.totem, folga(ac.totem));
    // E o poste é um pino de verdade: tem geometria, e está dentro da célula que o publicou.
    assert.ok(ac.poste.raio > 0 && Number.isFinite(ac.poste.x) && Number.isFinite(ac.poste.y),
      'o poste nasceu sem corpo');
  }
  // 0,2 tile de folga é o diâmetro do pino do guerreiro: menos que isso e um sentinela andando
  // entre a casa e o poste empurraria o prisioneiro, e o empurrão seria a mecânica.
  assert.ok(pior.casa > 0.2, `o poste encosta numa cabana: pior folga ${pior.casa.toFixed(3)} tiles`);
  assert.ok(pior.fogo > 0.2, `o poste encosta na fogueira: pior folga ${pior.fogo.toFixed(3)} tiles`);
  assert.ok(pior.totem > 0.2, `o poste encosta no totem: pior folga ${pior.totem.toFixed(3)} tiles`);
});

test('o acampamento que a câmera mira aparece na tela', () => {
  const game = jogoEm(NOSSO_AC.x, NOSSO_AC.y);
  const view = game.fog.view(game);
  const nós = triboNodesFor(game).filter((n) => n.id.startsWith(`tribo:${NOSSO_AC.id}:`));
  const fogueira = nós.find((n) => n.tipo === 'fogueira');
  assert.ok(fogueira, 'sem fogueira, sem aldeia');
  const caixa = caixaDoNodo(fogueira);
  assert.equal(game.fog.intersects(view, caixa.x, caixa.y, caixa.width, caixa.height), true,
    'no meio do acampamento a neblina corta a própria fogueira — a âncora do nó está errada');
  let visíveis = 0;
  for (const n of nós) {
    const b = caixaDoNodo(n);
    if (game.fog.intersects(view, b.x, b.y, b.width, b.height)) visíveis++;
  }
  assert.ok(visíveis >= 2, `só ${visíveis} de ${nós.length} corpos estão na tela de quem está no meio da aldeia`);
});

test('a aldeia entra e sai com a câmera, e o cache é a única coisa que muda', () => {
  const game = jogoEm(NOSSO_AC.x, NOSSO_AC.y);
  const primeira = triboNodesFor(game);
  assert.ok(primeira.length > 0, 'o território está vazio no desenho');
  const segunda = triboNodesFor(game);
  assert.equal(segunda, primeira, 'a varredura alocou um array novo: o `memo` do sprite morre a cada 8 Hz');
  assert.equal(segunda[0], primeira[0], 'os nós foram reconstruídos: a aldeia inteira re-renderiza a cada varredura');
  const residentes = triboCacheStats(game);
  assert.ok(residentes.acampamentos >= 1, 'nenhum acampamento residente com a câmera dentro dele');
  assert.equal(residentes.nós, primeira.length, 'o cache conta nós que a varredura não devolve');

  // De volta à cidade, com o MESMO jogo: janela inteira dentro da grade é zero aldeia, e o que
  // ficou para trás tem de sair da memória — na web isto é heap de verdade, e a tribo é o cenário
  // que o jogador abandona. Um cache que só cresce seria uma aldeia por célula visitada, para
  // sempre, e é exatamente o que a evicção abaixo impede.
  const irPara = (x, y) => {
    game.camera.x = x; game.camera.y = y; game.camera.h = RIO.heightSmoothAt(x, y);
  };
  irPara(CW / 2, CH / 2);
  assert.equal(triboNodesFor(game).length, 0, 'a cidade tem acampamento desenhado');
  assert.equal(triboCacheStats(game).acampamentos, 0,
    'a aldeia ficou residente depois que a câmera voltou para a cidade');

  // E volta: a aldeia refaz do zero, porque o território é uma função da coordenada e não uma
  // lista de coisas vistas. A cota da câmera acompanha o relevo, como no jogo.
  irPara(NOSSO_AC.x, NOSSO_AC.y);
  assert.equal(triboNodesFor(game).length, primeira.length, 'a aldeia não voltou quando a câmera voltou');
  assert.ok(triboCacheStats(game).acampamentos >= 1, 'nada residente com a câmera de novo no meio da aldeia');

  // A câmera anda do meio da aldeia para o centro da cidade, devagar: em nenhum passo o array muda
  // de identidade, a aldeia é vista enquanto ela está na janela, e quando a janela volta inteira
  // para dentro da grade não sobra nenhum residente.
  const andada = jogoEm(NOSSO_AC.x, NOSSO_AC.y);
  let viu = 0;
  const passos = 60;
  for (let i = 0; i <= passos; i++) {
    const t = i / passos;
    const x = NOSSO_AC.x + (CW / 2 - NOSSO_AC.x) * t;
    const y = NOSSO_AC.y + (CH / 2 - NOSSO_AC.y) * t;
    andada.camera.x = x; andada.camera.y = y;
    andada.camera.h = RIO.heightSmoothAt(x, y);
    const nós = triboNodesFor(andada);
    assert.equal(nós === triboNodesFor(andada), true, 'a varredura mudou de array no meio da andada');
    if (nós.some((n) => n.id.startsWith(`tribo:${NOSSO_AC.id}:`))) viu++;
  }
  assert.ok(viu > 0, 'a aldeia nunca estava na janela enquanto a câmera saía dela');
  assert.equal(triboCacheStats(andada).acampamentos, 0, 'a andada para a cidade deixou aldeia residente');
});

test('uma só mão do território ao quadro: nem imagem, nem sorteio, nem camada própria', () => {
  assert.match(STATICS_SRC, /import \{[^}]*\bacampamentoDaCélula\b[^}]*\} from '\.\.\/world\/Tribo'/,
    'o desenho voltou a ter o próprio acampamento');
  assert.match(STATICS_SRC, /import \{[^}]*\bCÉLULA_DA_TRIBO\b[^}]*\} from '\.\.\/world\/Tribo'/,
    'o desenho voltou a ter a própria célula');
  assert.match(STATICS_SRC, /escala: meio \* RAIO_DE_PIXEL \/ PÉ\[tipo\]/,
    'a escala deixou de ser a conta que casa o pino com o desenho');
  for (const [nome, src] of [['TriboStatics', STATICS_SRC], ['TriboSprite', SPRITE_SRC]]) {
    assert.ok(!/Math\.random/.test(src), `${nome} sorteia com Math.random`);
  }
  // Arte autorada: nenhum PNG, nenhum atlas, nenhuma licença — o contrato da fronteira inteira.
  for (const vedado of ['spriteStore', 'AssetRegistry', 'SkImage', '.png', 'require(']) {
    assert.ok(!SPRITE_SRC.includes(vedado), `TriboSprite voltou a depender de material externo (${vedado})`);
  }
  assert.equal((SPRITE_SRC.match(/^export function quadro/gm) || []).length, 5,
    'a arte deixou de exportar as cinco formas como funções puras — a sonda offline não as leria');

  // A aldeia entra na MESMA fila ordenada, e não numa camada própria: é o contrato isométrico.
  assert.ok(!fs.existsSync(path.join(root, 'src/render/TriboLayer.tsx')),
    'o acampamento virou camada própria, e o jogador passaria por dentro do telhado');
  assert.match(SORTED_SRC, /import \{[^}]*\btriboNodesFor\b[^}]*\} from '\.\/TriboStatics'/,
    'a fila ordenada deixou de pedir os nós da aldeia');
  assert.match(SORTED_SRC, /items\.push\(\{ id: node\.id, depth: node\.depth, tribo: node \}\)/,
    'o nó da tribo não entra mais na ordenação por profundidade');
  assert.match(SORTED_SRC, /caixaDoNodo\(node\)/,
    'o recorte da tribo voltou a ser uma caixa inventada na camada');

  // E o chão pinta a clareira pela mesma pergunta que a mata corta o tronco.
  assert.match(CHAO_SRC, /clareiraNoTile\(tx, ty, W, H, game\.map\)/,
    'a terra pisada deixou de perguntar ao território');
  assert.match(CHAO_SRC, /const faixa = \(canal \|\| pisada\)/,
    'o dossel voltou a escurecer o meio de uma aldeia sem árvore');
});

test('cada campo do nó é lido por alguém do outro lado da costura', () => {
  // TriboNode é o contrato entre a geometria e a tinta. Um campo que ninguém lê é decoração, e um
  // campo que só a arte lê é geometria morando no lugar errado.
  const LIDO = SPRITE_SRC + '\n' + SORTED_SRC;
  for (const campo of ['id', 'tipo', 'sx', 'sy', 'escala', 'planta', 'away', 'espelha', 'depth']) {
    assert.ok(new RegExp(`node\\.${campo}\\b`).test(LIDO), `TriboNode.${campo} não é lido por ninguém`);
  }
  for (const campo of ['escala', 'planta', 'away', 'espelha', 'sx', 'sy', 'tipo']) {
    assert.ok(new RegExp(`node\\.${campo}\\b`).test(SPRITE_SRC),
      `a tinta deixou de ler node.${campo} — a decisão está morando do lado errado`);
  }
});

// ===================== fase 3: quem defende o lugar =====================
//
// As provas acima cobriam o cenário. Esta parte cobre a posse: um bando que é função do lugar, uma
// patrulha que anda no trilho publicado, um olho que obedece ao `olhar` do corpo e à casa desenhada,
// e um golpe que para antes de matar porque o dono da terra quer prisioneiro, não cadáver.

const GUER = load(path.join(root, 'src/entities/Guerreiro.ts'));
const S = load(path.join(root, 'src/systems/TriboSystem.ts'));
const GOR = load(path.join(root, 'src/systems/GorilaSystem.ts'));
const GSPR = load(path.join(root, 'src/render/GuerreiroSprite.tsx'));

const SISTEMA_SRC = fs.readFileSync(path.join(root, 'src/systems/TriboSystem.ts'), 'utf8');
const GORILA_SRC = fs.readFileSync(path.join(root, 'src/systems/GorilaSystem.ts'), 'utf8');
const GUERREIRO_SRC = fs.readFileSync(path.join(root, 'src/entities/Guerreiro.ts'), 'utf8');
const GSPRITE_SRC = fs.readFileSync(path.join(root, 'src/render/GuerreiroSprite.tsx'), 'utf8');

const CALMA = ['patrulhando', 'postado', 'voltando'];
const ACORDADO = ['avistando', 'cercando', 'perseguindo', 'batendo', 'capturando', 'carregando'];

/** O raio normalizado do ponto: 1 é a elipse pintada, `FOLGA_DA_JURISDIÇÃO` é a borda da posse. */
const raioDe = (ac, x, y) => Math.hypot((x - ac.x) / ac.meiaLargura, (y - ac.y) / ac.meiaAltura);

/**
 * O mundo mínimo que o `TriboSystem` aceita: o `Map` de verdade para a água, um corpo mutável para o
 * jogador e um diário do que ele pediu. Nada aqui é um espionamento dos campos privados — quem
 * decide é lido pelo `estado` publicado dos corpos e pelo que o sistema cobrou, exatamente como o
 * `GameState` lê.
 */
function aldeiaEm(player, opts = {}) {
  const ac = opts.ac === undefined ? NOSSO_AC : opts.ac;
  const diary = { dano: [], says: [], plays: [], arrastou: 0, últimoArrasto: null, capturas: [] };
  let vida = opts.vida === undefined ? 100 : opts.vida;
  const ctx = {
    worldW: CW, worldH: CH,
    player, worldPosition: opts.worldPosition === undefined ? player : opts.worldPosition,
    água: RIO,
    damages: (amount) => {
      if (!(amount > 0)) return false;
      if (opts.vidaFixa === undefined) vida -= amount;
      diary.dano.push(amount);
      return true;
    },
    vidaDoJogador: () => (opts.vidaFixa === undefined ? vida : opts.vidaFixa),
    aPé: () => (opts.aPé === undefined ? true : opts.aPé),
    // O mesmo número que o `GameState` entrega: a amarra é a soma dos dois raios, então medir o
    // ponto da corda com um raio inventado aqui seria provar uma amarra que não existe no jogo.
    raioDoCorpo: () => GAME_CONFIG.PLAYER_RADIUS,
    arrasta: (x, y) => { player.x = x; player.y = y; diary.arrastou++; diary.últimoArrasto = { x, y }; },
    captura: (a) => { diary.capturas.push(a.id); },
    shake: () => {},
    say: (t) => { diary.says.push(t); },
    play: (k) => { diary.plays.push(k); },
    isVisible: () => true,
    onStructChange: () => {},
  };
  const sys = new S.TriboSystem();
  return { sys, ctx, diary, ac, vida: () => vida,
    /**
     * Congela a leitura da saúde. É assim que a segunda metade da prova da captura mede o *prazo*
     * da folga sem que o bando, com o prisioneiro ainda no meio da clareira, simplesmente o leve
     * de novo — duas capturas emenda não é o que está sob prova, e esconderia o relógio.
     */
    travaVida: () => { opts.vidaFixa = 100; },
    /**
     * Os corpos DESTE acampamento. O sistema materializa as três células ao redor do jogador,
     * então `sys.guerreiros` é o mundo visível inteiro — medir a aldeia sob prova por essa lista
     * seria cobrar do vizinho o que é do dono da terra.
     */
    corpos: () => sys.guerreiros.filter((g) => g.bando === ac.id)
      .sort((a, b) => a.posto - b.posto) };
}

/** Andar o tempo dado, corpo a corpo, com a opção de medir cada quadro. */
function anda(A, segundos, porTick) {
  const dt = 1 / 30;
  const ticks = Math.round(segundos / dt);
  for (let i = 0; i < ticks; i++) {
    A.sys.update(dt, A.ctx);
    if (porTick) porTick(i, A.corpos());
  }
  return ticks;
}

/** Por a mão no corpo: o `update` lê a posição e o olhar no pré-pass, antes de qualquer movimento. */
function pôr(g, x, y, olhar, θ) {
  g.x = x; g.y = y; g.olhar = olhar; g.dir = GUER.dirDe(olhar);
  // Colocar um corpo no trilho é dizer em que ângulo do trilho ele está. Sem isto, a ronda do
  // quadro seguinte o devolve ao posto velho e a geometria que a prova escolheu evapora.
  if (θ !== undefined) g.trilhoθ = θ;
  g.estado = 'patrulhando'; g.espera = 0; g.velocidade = 0; g.morto = false;
}

/**
 * A corda limpa do lugar: um posto do anel de onde a linha até o centro da clareira não tem pino,
 * com uma amostra dentro do alcance do olho e outra um tile e meio além dele, ambas dentro da
 * jurisdição DESTE acampamento. É a única geometria em que um "não viu" pode ser atribuído ao
 * ângulo ou à distância, e não a uma casa no meio do caminho ou a um vizinho que não é o dono.
 *
 * A mesma corda é lida para fora: o posto também tem de ter um ponto a 2,2 tiles dele, pelo normal
 * de saída do trilho, ainda dentro da posse. É o lugar onde um sentinela parado VARRE por
 * construção (o cone gira em torno do normal), e é a única geometria em que um prisioneiro solto na
 * fogueira pode ser visto de novo quando a folga do bando vence.
 */
function cordaLimpa(ac) {
  const livre = (x, y) => T.acampamentoQueRecebe(x, y, CW, CH, RIO)?.id === ac.id
    && !RIO.isWaterWorld(x, y)
    && !T.empurraDoAcampamento({ x, y, radius: 0.2 }, CW, CH, RIO);
  const postos = S.postosDoBando(ac);
  for (let índice = 0; índice < postos.length; índice++) {
    const θ = postos[índice];
    const posto = S.pontoDoTrilho(ac, θ);
    const paraDentro = Math.atan2(ac.y - posto.y, ac.x - posto.x);
    const perto = { x: posto.x + Math.cos(paraDentro) * 8, y: posto.y + Math.sin(paraDentro) * 8 };
    const longe = { x: posto.x + Math.cos(paraDentro) * (S.OLHO_TILES + 1.5),
      y: posto.y + Math.sin(paraDentro) * (S.OLHO_TILES + 1.5) };
    const paraFora = S.normalDoTrilho(ac, θ);
    const fora = { x: posto.x + Math.cos(paraFora) * 2.2, y: posto.y + Math.sin(paraFora) * 2.2 };
    if (!livre(perto.x, perto.y) || !livre(longe.x, longe.y) || !livre(fora.x, fora.y)) continue;
    return { índice, θ, posto, paraDentro, perto, longe, paraFora, fora };
  }
  return null;
}

test('o bando é do lugar, não do acaso: dois sistemas separados põem os mesmos corpos no mesmo trilho', () => {
  let conferidas = 0;
  for (const ac of ACAMPAMENTOS.slice(0, 8)) {
    const corpo = () => ({ x: ac.entrada.x, y: ac.entrada.y });
    const a = aldeiaEm(corpo(), { ac }), b = aldeiaEm(corpo(), { ac });
    a.sys.update(1 / 30, a.ctx);
    b.sys.update(1 / 30, b.ctx);
    const ga = a.corpos(), gb = b.corpos();
    assert.ok(ga.length >= 2, `aldeia ${ac.id} sem gente nenhuma para defender a porta`);
    assert.equal(ga.length, S.tamanhoDoBando(ac),
      `aldeia ${ac.id}: o bando não tem o tamanho que a aldeia define`);
    assert.ok(ga.length <= ac.cabanas.length,
      `aldeia ${ac.id}: mais guerreiros do que portas — o bando virou turba`);
    const sinal = (l) => l.map((g) => `${g.posto}|${g.trilhoSentido}|${g.estado}|${raioDe(ac, g.x, g.y).toFixed(9)}`).join(';');
    assert.equal(sinal(gb), sinal(ga), `aldeia ${ac.id}: dois mundos, dois bandos diferentes`);
    // O id é do contador do sistema, nunca do hash do lugar: um corpo serve a um bando só, e quem
    // materializa duas aldeias no mesmo mundo dá à segunda números que a primeira não tem — porque
    // se saíssem da coordenada, dois lugares vizinhos compartilhariam corpos.
    assert.ok(ga.every((g) => Number.isInteger(g.id) && g.id > 0), 'um guerreiro nasceu sem id');
    assert.ok(ga.every((g) => g.bando === ac.id), 'um guerreiro serve a outra aldeia que não a do seu bando');
    const todos = a.sys.guerreiros;
    assert.equal(new Set(todos.map((g) => g.id)).size, todos.length,
      'dois bandos compartilharam um id de guerreiro');
    const célula = T.célulaDaTribo(Math.floor(ac.entrada.x), Math.floor(ac.entrada.y));
    const outra = ACAMPAMENTOS.find((c) => c.id !== ac.id
      && Math.abs(c.cx - célula.cx) <= 1 && Math.abs(c.cy - célula.cy) <= 1
      && Math.hypot(c.x - ac.entrada.x, c.y - ac.entrada.y) <= 30);
    if (outra) {
      conferidas++;
      const doLugar = new Set(a.corpos().map((g) => g.id));
      const doVizinho = todos.filter((g) => g.bando === outra.id);
      assert.ok(doVizinho.length > 0, `aldeia ${outra.id} ao lado não materializou bando`);
      assert.ok(doVizinho.every((g) => !doLugar.has(g.id)),
        'o bando vizinho recebeu um id que já pertencia a este lugar');
    }
  }
  assert.ok(conferidas > 0, 'nenhum par de aldeias vizinhas foi materializado junto: a conta dos ids não foi provada');
});

test('nenhum sentinela nasce em cima de uma casa: o posto é a lacuna do anel publicado', () => {
  for (const ac of ACAMPAMENTOS) {
    const postos = S.postosDoBando(ac);
    assert.equal(postos.length, S.tamanhoDoBando(ac), 'os postos e o tamanho do bando divergem');
    assert.equal(postos[0], ac.porta, 'a boca não é o primeiro posto: ninguém guarda a única entrada');
    for (const θ of postos) {
      const p = S.pontoDoTrilho(ac, θ);
      assert.ok(raioDe(ac, p.x, p.y) < 1, 'o posto está fora da clareira pintada');
      assert.equal(T.jurisdiçãoDaAldeia(ac, p.x, p.y), true, 'o posto está fora da própria jurisdição');
      const corpo = { x: p.x, y: p.y, radius: GUER.GUERREIRO_RAIO };
      assert.equal(T.empurraDoAcampamento(corpo, CW, CH, RIO), false,
        `aldeia ${ac.id}: um posto está dentro de um pino que o render desenha`);
      assert.equal(corpo.x, p.x, 'o empurrão mexeu no posto mesmo sem tocar em nada');
    }
  }
});

test('o cone de visão é o `olhar` publicado e o alcance do olho é um número só', () => {
  const ac = NOSSO_AC;
  const A = aldeiaEm({ x: ac.x, y: ac.y }, { ac });
  A.sys.update(1 / 30, A.ctx);
  const corpos = A.corpos();
  assert.ok(corpos.length >= 2, 'a aldeia sob prova não materializou bando suficiente');

  // O sentinela fica num posto do anel olhando para dentro, e o jogador é colocado na MESMA linha
  // dele a duas distâncias: a corda é a do próprio posto para o centro, escolhida por `cordaLimpa`
  // porque é a única geometria em que um "não viu" se atribui ao ângulo ou ao alcance.
  const eixo = cordaLimpa(ac);
  assert.ok(eixo, 'nenhum posto do bando tem corda limpa para dentro da clareira: a régua do olho não foi medida');
  const { θ, posto, paraDentro, perto, longe } = eixo;
  const g = corpos[0];

  const mira = (alvo, olhar) => {
    pôr(g, posto.x, posto.y, olhar, θ);
    A.ctx.player = alvo; A.ctx.worldPosition = alvo;
    A.sys.update(1 / 30, A.ctx);
    return g.estado === 'avistando';
  };

  // (1) oito tiles na cara: acorda. (2) os mesmos oito tiles, com o corpo girado de costas: não
  // acorda. As duas posições do jogador são idênticas — o que decide é o ângulo, e é por isso que
  // os dois casos têm de aparecer juntos: um teste só do "vê" passaria com um predador que enxerga
  // em círculo.
  assert.equal(mira(perto, paraDentro), true, 'a oito tiles na cara ele não te vê: o cone está invertido');
  assert.equal(mira(perto, paraDentro + Math.PI), false, 'de costas para você ele te vê: não existe cone');
  // (3) um tile e meio além do alcance publicado, na mesma linha limpa, no mesmo ângulo: o que
  // corta agora é só a distância.
  assert.equal(mira(longe, paraDentro), false,
    `a ${S.OLHO_TILES + 1.5} tiles ele te vê: a fronteira não tem alcance finito`);
  // E o alcance cobrado é o publicado, não um número parecido no teste: a amostra de "vê" está
  // dentro dele e a de "não vê" está fora, por menos de dois tiles de margem.
  assert.ok(Math.hypot(longe.x - posto.x, longe.y - posto.y) > S.OLHO_TILES,
    'a amostra longe não mede o limite do olho');
  assert.ok(Math.hypot(perto.x - posto.x, perto.y - posto.y) < S.OLHO_TILES,
    'a amostra perto não está dentro do olho');
});

test('a casa no meio do caminho tapa a vista: o mesmo ângulo, com e sem cabana na linha', () => {
  let caso = null;
  for (const ac of ACAMPAMENTOS) {
    const A = aldeiaEm({ x: ac.entrada.x, y: ac.entrada.y }, { ac });
    A.sys.update(1 / 30, A.ctx);
    const g = A.corpos()[0];
    if (!g) continue;
    for (const casa of ac.cabanas) {
      // O sentinela fica no trilho, do lado OPPOSTO da casa: é a única posição do anel em que a
      // cabana cai na linha de vista com distância de sobra para o olho.
      const θ = Math.atan2((casa.y - ac.y) / ac.meiaAltura, (casa.x - ac.x) / ac.meiaLargura) + Math.PI;
      const posto = S.pontoDoTrilho(ac, θ);
      const dx = casa.x - posto.x, dy = casa.y - posto.y;
      const d = Math.hypot(dx, dy);
      if (d < 4 || d > 10) continue;
      const ux = dx / d, uy = dy / d;
      const antes = { x: posto.x + ux * d * 0.6, y: posto.y + uy * d * 0.6 };
      const depois = { x: posto.x + ux * (d + 1.6), y: posto.y + uy * (d + 1.6) };
      if (!T.jurisdiçãoDaAldeia(ac, antes.x, antes.y) || !T.jurisdiçãoDaAldeia(ac, depois.x, depois.y)) continue;
      if (RIO.isWaterWorld(depois.x, depois.y)) continue;
      const vê = (alvo) => {
        pôr(g, posto.x, posto.y, Math.atan2(alvo.y - posto.y, alvo.x - posto.x));
        A.ctx.player = alvo; A.ctx.worldPosition = alvo;
        A.sys.update(1 / 30, A.ctx);
        return g.estado === 'avistando';
      };
      // Os dois alvos estão na mesma linha, com o mesmo ângulo publicado, dentro do alcance e dentro
      // da terra dele. O que separa um do outro é a cabana: antes dela ele acorda, depois dela você
      // é mato.
      if (Math.hypot(depois.x - posto.x, depois.y - posto.y) > S.OLHO_TILES) continue;
      if (!vê(antes) || vê(depois)) continue;
      caso = { ac, casa, d };
      break;
    }
    if (caso) break;
  }
  assert.ok(caso, 'nenhum acampamento do mundo tem a geometria "casa no meio da vista" — o cone não foi provado');
});

test('um avistamento acorda o bando inteiro no mesmo quadro, e quem só ouviu corta pela frente', () => {
  const ac = NOSSO_AC;
  const A = aldeiaEm({ x: ac.x, y: ac.y }, { ac });
  A.sys.update(1 / 30, A.ctx);
  const corpos = A.corpos();
  assert.ok(corpos.length >= 3, 'precisa de um bando com pelo menos três corpos para provar o flanco');
  // O vidente vai para um posto de lacuna olhando para o centro; os outros ficam apontando para
  // longe dele. Assim a única fonte de "alguém viu" é o cone do primeiro.
  const postos = S.postosDoBando(ac);
  const vidente = corpos.find((g) => g.posto === 1) ?? corpos[1];
  const pVidente = S.pontoDoTrilho(ac, postos[1] ?? vidente.trilhoθ);
  pôr(vidente, pVidente.x, pVidente.y, Math.atan2(ac.y - pVidente.y, ac.x - pVidente.x));
  const outros = corpos.filter((g) => g !== vidente);
  for (const g of outros) {
    const p = S.pontoDoTrilho(ac, g.trilhoθ);
    pôr(g, p.x, p.y, Math.atan2(p.y - ac.y, p.x - ac.x));
  }
  A.sys.update(1 / 30, A.ctx);
  assert.equal(vidente.estado, 'avistando', 'quem viu não levantou o braço');
  for (const g of outros) {
    assert.equal(g.estado, 'cercando', `o guerreiro ${g.id} que só ouviu o grito ficou em ${g.estado}`);
  }
  // E o flanco é um LUGAR, não um corpo: os que não viram têm de acabar num ponto do trilho, longe
  // do jogador — se estivessem seguindo o corpo, estariam em cima dele e não na borda.
  let chegou = null;
  for (let i = 0; i < 240 && !chegou; i++) {
    A.sys.update(1 / 30, A.ctx);
    for (const g of outros) {
      if (g.estado !== 'perseguindo') continue;
      chegou = { g, r: raioDe(ac, g.x, g.y), d: Math.hypot(g.x - ac.x, g.y - ac.y) };
      break;
    }
  }
  assert.ok(chegou, 'nenhum flanco chegou ao ponto de corte em 8 s de emboscada');
  assert.ok(Math.abs(chegou.r - S.ALTURA_DO_TRAILHO) < 1e-6 || chegou.d > 3,
    'o flanco perseguiu o corpo em vez de fechar no trilho da frente');
});

test('a patrulha anda no trilho: o circuito é a elipse publicada, com pausa e varredura de olhos', () => {
  const ac = NOSSO_AC;
  // O jogador estaciona do lado de fora da jurisdição: nenhum bando é disputado, então isto mede a
  // ronda pura, sem luta no meio.
  const fora = { x: ac.x + 1.6 * ac.meiaLargura, y: ac.y };
  assert.equal(T.jurisdiçãoDaAldeia(ac, fora.x, fora.y), false, 'a amostra de ronda está dentro da posse');
  // E não pode estar na posse de *nenhum* vizinho: um bando disputado acordaria e a ronda puro
  // sangue que esta prova mede não existiria.
  assert.equal(T.acampamentoQueRecebe(fora.x, fora.y, CW, CH, RIO), null,
    'a amostra de ronda é terra de alguma aldeia');
  const A = aldeiaEm(fora, { ac });
  let postado = 0, varrendo = 0, pior = 0;
  anda(A, 60, (_i, corpos) => {
    for (const g of corpos) {
      pior = Math.max(pior, Math.abs(raioDe(ac, g.x, g.y) - S.ALTURA_DO_TRAILHO));
      assert.ok(CALMA.includes(g.estado), `rondando, o guerreiro ${g.id} entrou em ${g.estado}`);
      if (g.estado !== 'postado') continue;
      postado++;
      // No posto o corpo é pedra e os olhos são farol.
      const antes = { x: g.x, y: g.y, olhar: g.olhar };
      A.sys.update(1 / 30, A.ctx);
      if (g.estado === 'postado') {
        assert.equal(g.x, antes.x, 'a sentinela andou enquanto fazia a pausa');
        if (g.olhar !== antes.olhar) varrendo++;
      }
    }
  });
  assert.ok(pior < 1e-9, `a patrulha saiu do trilho por ${pior} de raio normalizado`);
  assert.ok(postado > 0, '60 s de ronda e nenhum sentinela parou no próprio posto');
  assert.ok(varrendo > 0, 'a pausa da sentinela não varre nada: o cone de visão seria um adorno');
  assert.equal(A.diary.dano.length, 0, 'a patrulha bateu em alguém que nunca entrou na terra deles');
  assert.equal(A.diary.capturas.length, 0, 'capturou quem não pisou a jurisdição');
});

test('a posse inteira cabe na elipse dilatada: o clamp do bando nunca é a única porteira', () => {
  // A jurisdição é a elipse × `FOLGA_DA_JURISDIÇÃO` MAIS o disco da porta (`PORTA_ALCANCE`), e o
  // `prendeAoTerritório` do bando só conhece a elipse. Se a porta chegasse além da dilatada, existiria
  // terra deles que nenhum guerreiro pisa — a posse que a HUD anuncia seria maior que a que ele
  // defende, exatamente a falha que a folga existe para não deixar existir. Sobre a elipse não há o
  // que medir: nela, o raio da borda É 1,45 por construção. O que pode vazar é a porta, então é o
  // disco dela que esta varredura percorre, em todas as aldeias do mundo.
  let pior = 0, onde = null;
  for (const ac of ACAMPAMENTOS) {
    for (let k = 0; k <= 24; k++) {
      const ρ = (k / 24) * (T.PORTA_ALCANCE + 0.5);
      for (let n = 0; n < 32; n++) {
        const α = (n / 32) * Math.PI * 2;
        const x = ac.entrada.x + Math.cos(α) * ρ, y = ac.entrada.y + Math.sin(α) * ρ;
        if (!T.jurisdiçãoDaAldeia(ac, x, y)) continue;
        const r = raioDe(ac, x, y);
        if (r > pior) { pior = r; onde = { ac: ac.id, r }; }
      }
    }
  }
  // A porta tem de ser jurisdição de verdade (senão a varredura acima não mediu nada) e tem de caber
  // na elipse que o bando respeita. É também o registro honesto do porquê a mutação do clamp não muda
  // comportamento: com a porta dentro da dilatada, quem devolve a caçada é a disputa por posse, e o
  // clamp é guarda da invariante — não a única porteira.
  assert.ok(pior > 1, `nenhum ponto da porta sai da elipse pintada (pior raio ${pior}): o disco de entrada é decorativo`);
  assert.ok(pior <= T.FOLGA_DA_JURISDIÇÃO,
    `terra deles a ${pior.toFixed(3)} de raio (${JSON.stringify(onde)}), além da elipse que o bando respeita `
    + `(${T.FOLGA_DA_JURISDIÇÃO}): o guerreiro não alcança a própria porta`);
});

test('eles não perseguem para fora de casa: a caçada acaba na borda da jurisdição', () => {
  const ac = NOSSO_AC;
  const A = aldeiaEm({ x: ac.x, y: ac.y }, { ac });
  A.sys.update(1 / 30, A.ctx);
  const postos = S.postosDoBando(ac);
  const vidente = A.corpos().find((g) => g.posto === 1);
  const p = S.pontoDoTrilho(ac, postos[1]);
  pôr(vidente, p.x, p.y, Math.atan2(ac.y - p.y, ac.x - p.x));
  anda(A, 3);
  assert.ok(A.corpos().some((g) => ACORDADO.includes(g.estado)), 'o bando não acordou');
  // Saúde congelada: esta prova mede até onde a caçada ACOMPANHA, e quem cai a pé na terra deles é
  // capturado em três segundos. Um bando que levou o prisioneiro volta para o trilho porque a caçada
  // acabou em casa — e a perna seguinte mediria uma patrulha no lugar de uma fuga. O piso do abolo
  // é a prova de cima e de baixo, não esta.
  A.travaVida();

  // Primeira perna: o jogador sai andando pela borda, mas ainda pisa a terra deles. É o trecho em
  // que a caçada tem de acompanhá-lo até o limite — sem um passo além dele.
  const àBorda = { x: ac.x - 1.4 * ac.meiaLargura, y: ac.y };
  assert.equal(T.jurisdiçãoDaAldeia(ac, àBorda.x, àBorda.y), true, 'a amostra da borda já é fora');
  // E é terra DISPUTADA: o `update` só manda o bando atrás de quem `acampamentoQueRecebe` aponta.
  // Se a amostra caísse no vazio entre células, a caçada pararia por posse e a prova de baixo
  // (a borda) passaria sem ninguém ter sido expulso de nada.
  assert.equal(T.acampamentoQueRecebe(àBorda.x, àBorda.y, CW, CH, RIO)?.id, ac.id,
    'a amostra da borda não é a terra deste acampamento');
  let máximo = 0, colado = Infinity;
  anda(A, 12, (i) => {
    const t = Math.min(1, i / 300);
    const p = { x: ac.x + (àBorda.x - ac.x) * t, y: ac.y };
    A.ctx.player = p; A.ctx.worldPosition = p;
    for (const g of A.corpos()) {
      máximo = Math.max(máximo, raioDe(ac, g.x, g.y));
      colado = Math.min(colado, Math.hypot(g.x - p.x, g.y - p.y));
      assert.ok(raioDe(ac, g.x, g.y) <= T.FOLGA_DA_JURISDIÇÃO + 1e-9,
        `o guerreiro ${g.id} saiu da própria terra (raio ${raioDe(ac, g.x, g.y).toFixed(3)})`);
    }
  });
  // A caçada foi real e chegou até onde a terra deles acaba: um deles pisou a folga da borda (raio
  // > 1 é além da elipse pintada) e veio a um braço de quem andava. Sem a primeira metade, o
  // `máximo` de baixo seria o trilho de uma patrulha e a fuga nunca teria sido testada.
  assert.ok(máximo > 1, `a caçada seguiu até ${máximo.toFixed(2)} de raio — ficou no trilho, não foi à borda`);
  assert.ok(colado <= GUER.GUERREIRO_ALCANCE + 0.3,
    `nenhum deles alcançou quem andava na borda (o mais perto ficou a ${colado.toFixed(1)} tiles)`);

  // Segunda perna: o jogador pisa fora da terra deles, mas ainda DENTRO da célula do acampamento. É
  // essa a diferença entre "a caçada parou na borda da posse" e "parou porque o mapa acabou": uma
  // amostra a duas meias-larguras a oeste cairia na célula vizinha, onde `acampamentoQueRecebe`
  // devolve nulo por falta de dono e não por jurisdição. Aqui o dono da célula é ele mesmo, e ainda
  // assim o guerreiro não vem.
  const naCélula = (x, y) => Math.floor(x / CÉLULA) === ac.cx && Math.floor(y / CÉLULA) === ac.cy;
  const fora = [[1, 0], [-1, 0], [0, 1], [0, -1], [0.72, 0.72], [-0.72, 0.72], [0.72, -0.72], [-0.72, -0.72]]
    .map(([ux, uy]) => ({ x: ac.x + ux * 1.9 * ac.meiaLargura, y: ac.y + uy * 1.9 * ac.meiaAltura }))
    .find((q) => naCélula(q.x, q.y)
      && T.acampamentoQueRecebe(q.x, q.y, CW, CH, RIO) === null
      && !RIO.isWaterWorld(q.x, q.y));
  assert.ok(fora, 'nenhum ponto a 1,9 de raio cai fora da posse dentro da própria célula — a amostra da fuga não existe');
  assert.equal(T.jurisdiçãoDaAldeia(ac, fora.x, fora.y), false, 'a fuga foi para fora da elipse mas ainda é terra deles');
  const fugiu = fora;
  A.ctx.player = fugiu; A.ctx.worldPosition = fugiu;
  const danoAntes = A.diary.dano.length;
  let coladoDeFora = Infinity;
  anda(A, 40, (_i, corpos) => {
    for (const g of corpos) {
      máximo = Math.max(máximo, raioDe(ac, g.x, g.y));
      colado = Math.min(colado, Math.hypot(g.x - fugiu.x, g.y - fugiu.y));
      coladoDeFora = Math.min(coladoDeFora, Math.hypot(g.x - fugiu.x, g.y - fugiu.y));
      // A única régua é a elipse: o `jurisdiçãoDaAldeia` tem a janela da boca e passaria por
      // condescendente; aqui o teto é o raio dilatado, e a casa no caminho não pode empurrar
      // ninguém para fora dele.
      assert.ok(raioDe(ac, g.x, g.y) <= T.FOLGA_DA_JURISDIÇÃO + 1e-9,
        `o guerreiro ${g.id} saiu da própria terra (raio ${raioDe(ac, g.x, g.y).toFixed(3)})`);
    }
  });
  assert.ok(máximo <= T.FOLGA_DA_JURISDIÇÃO + 1e-9, 'eles perseguem até a cidade');
  assert.equal(A.diary.dano.length, danoAntes, 'bateu em quem já estava fora da terra dele');
  // E o controle negativo da régua: do lado de fora, o mais perto que eles chegam é longe de um
  // braço. Se um guerreiro vazasse um tile além da folga, isto fecha antes de qualquer contagem.
  assert.ok(coladoDeFora > GUER.GUERREIRO_ALCANCE,
    `um deles alcançou o fugido (a ${coladoDeFora.toFixed(2)} tiles dele, braço de ${GUER.GUERREIRO_ALCANCE})`);
  // E a calmaria volta sozinha: sem ninguém enxergando, o bando devolve o posto ao trilho.
  anda(A, 10);
  assert.ok(A.corpos().every((g) => CALMA.includes(g.estado)), 'o bando ficou de guarda para sempre');
  assert.equal(A.sys.perigo, 0, 'a HUD ainda acusa perigo depois de o bando ter desistido');
});

test('quem cai a pé na terra pisada é levado, não morto: o golpe para no piso do abolo', () => {
  const ac = NOSSO_AC;
  // 40 de vida: o primeiro porrete ainda desce (25 sobrando), o segundo seria um abolo — e é aí
  // que o braço muda de intenção. É o único jeito de provar que a captura intercepta um golpe que
  // mataria, e não um sorteio de estado.
  const A = aldeiaEm({ x: ac.entrada.x, y: ac.entrada.y }, { ac, vida: 40 });
  A.sys.update(1 / 30, A.ctx);
  const postos = S.postosDoBando(ac);
  const vidente = A.corpos().find((g) => g.posto === 1);
  const p = S.pontoDoTrilho(ac, postos[1]);
  pôr(vidente, p.x, p.y, Math.atan2(ac.y - p.y, ac.x - p.x));

  let mínimo = Infinity, levaram = 0, emLuta = false;
  const dt = 1 / 30;
  for (let i = 0; i < 30 * 40 && A.diary.capturas.length === 0; i++) {
    A.sys.update(dt, A.ctx);
    mínimo = Math.min(mínimo, A.vida());
    const corpos = A.corpos();
    if (corpos.some((g) => g.estado === 'capturando' || g.estado === 'carregando')) { emLuta = true; levaram++; }
  }
  assert.equal(A.diary.capturas.length, 1, 'ninguém foi levado em 40 s de apanhar dentro da aldeia');
  assert.equal(A.diary.capturas[0], ac.id, 'o prisioneiro foi entregue a outra aldeia');
  assert.ok(A.diary.dano.length > 0, 'nem um porrete desceu: a captura não nasceu de um espancamento');
  assert.ok(mínimo >= S.PISO_DO_ABOLO, `a vida caiu a ${mínimo}: eles mataram em vez de capturar`);
  // E as duas réguas de baixo NÃO leem o piso: elas medem o que o piso significa. Um `mínimo >=
  // PISO_DO_ABOLO` sozinho é satisfeito por um piso zerado — que é exatamente a mutação que passou
  // por aqui sem ser pega. Então: quem é levado ainda tem de estar de pé para o cativeiro (uma
  // martelada inteira de vida sobrando) e o braço tem de parar com folga real, não um fio acima do
  // chão. Sem estas duas, "eles capturam em vez de matar" seria uma frase sobre um número.
  assert.ok(mínimo >= GUER.GUERREIRO_DANO,
    `levaram o jogador com ${mínimo.toFixed(0)} de vida: o porrete para mais baixo que uma martelada, e isso é execução`);
  assert.ok(S.PISO_DO_ABOLO >= GUER.GUERREIRO_DANO * 1.5,
    'o piso do abolo não deixa folga entre apanhar e ser levado: captura perto da morte não é cativeiro');
  assert.ok(emLuta && levaram > 0, 'ninguém carregou o corpo — a entrega não passou de um teleporte');
  assert.ok(A.diary.arrastou > 0, 'o prisioneiro não foi arrastado: o `arrasta` do contexto é enfeite');
  const entrega = A.diary.últimoArrasto;
  // A entrega é no poste, e no ponto em que a corda deixa o corpo **encostado** nele sem estar
  // dentro: a soma dos dois raios. Esta régua prova as duas decisões do cativeiro de uma vez — o
  // corpo não é teletransportado da fogueira para o poste depois (um dono só de coordenada), e o
  // `empurraDoAcampamento` do quadro seguinte não tem o que empurrar, então a amarra não briga com
  // o colisor. Chamar `pontoDaAmarra` aqui seria pedir à função que provesse a si mesma; o que se
  // mede é a geometria que ela promete.
  const alcance = ac.poste.raio + GAME_CONFIG.PLAYER_RADIUS;
  const dPoste = Math.hypot(entrega.x - ac.poste.x, entrega.y - ac.poste.y);
  assert.ok(dPoste >= alcance,
    `amarrado dentro do poste (${dPoste.toFixed(3)} < ${alcance.toFixed(3)}): o colisor empurraria o prisioneiro a cada quadro`);
  assert.ok(dPoste <= alcance + 0.03,
    `a corda larga o corpo a ${dPoste.toFixed(3)} tiles do poste: amarra frouxa é espaço para andar, não para esperar`);
  const dxFogo = ac.fogueira.x - ac.poste.x, dyFogo = ac.fogueira.y - ac.poste.y;
  const cruz = ((entrega.x - ac.poste.x) * dyFogo - (entrega.y - ac.poste.y) * dxFogo)
    / Math.hypot(dxFogo, dyFogo);
  assert.ok(Math.abs(cruz) < 1e-9,
    'o corpo não está na linha poste→fogueira: quem está amarrado não fica de frente para o centro do lugar');
  assert.ok(Math.hypot(entrega.x - ac.fogueira.x, entrega.y - ac.fogueira.y) > ac.fogueira.raio,
    'o corpo foi deixado na fogueira — o poste existe justamente para a amarra ter onde ficar');
  // O quadro da entrega ainda carrega o alerta do quadro que viu — a varredura de olhos aconteceu
  // antes do corpo chegar ao poste. O que importa é a calma vir sozinha com o prisioneiro ainda no
  // meio da aldeia: se a folga não existisse, o perigo ficaria em 1 para sempre.
  anda(A, 2);
  assert.equal(A.sys.perigo, 0, 'o bando continuou em alerta depois de já ter comido');

  // E a folga do bando satisfeito tem de ter prazo: `PRAZO_DA_SACIEDADE` depois ele volta a olhar
  // para você. O prisioneiro é largado no poste, no fundo da clareira, e ali ele está às costas de
  // toda sentinela — o cone do posto gira em torno do NORMAL DE SAÍDA do trilho, porque é para a
  // mata que eles vigiam. Medir a volta com o jogador parado dentro do acampamento seria provar
  // que ninguém olha, e não que a folga venceu. A prova então o põe na cara de um posto: o ponto a
  // 2,2 tiles do trilho, pelo normal, ainda dentro da jurisdição (a corda limpa de cima). O relógio
  // é a única variável: o mesmo olho, na mesma linha, antes do prazo não acorda nada.
  const eixo = cordaLimpa(ac);
  assert.ok(eixo, 'nenhum posto tem corda limpa para fora: a volta do bando satisfeito não seria medida');
  const sentinela = A.corpos().find((g) => g.posto === eixo.índice && !g.morto);
  assert.ok(sentinela, `o posto ${eixo.índice} não tem corpo neste bando`);
  // O jogador da prova é um corpo À PARTE, com a coordenada da amostra: `acerta` empurra quem
  // apanha escrevendo em `player.x/y`, e entregar aqui o próprio objeto da amostra faria o porrete
  // levar o ponto de medida para fora da jurisdição. O bando então pararia de vê-lo por um motivo
  // que não é o prazo — e a prova abaixo viraria uma conta de empurrão.
  const amostra = { x: eixo.fora.x, y: eixo.fora.y };
  A.ctx.player = amostra; A.ctx.worldPosition = amostra;
  assert.equal(T.acampamentoQueRecebe(amostra.x, amostra.y, CW, CH, RIO)?.id, ac.id,
    'a amostra da cara do posto já é fora da terra deles');
  A.travaVida();
  // O corpo é posto NO posto, com os olhos no jogador, e corre um único quadro. É o mesmo
  // mecanismo da prova do cone, e é o único honesto aqui: deixar o sentinela livre para a ronda e
  // só girar a cabeça significaria medir a geometria de onde ele resolveu estar naquele instante —
  // uma casa na linha ou onze tiles de distância dariam o "não viu" errado. E `pôr` limpa o
  // estado, então só se faz enquanto ninguém acordou: fazê-lo depois do grito apagaria a notícia
  // que a prova procura.
  const virar = () => {
    amostra.x = eixo.fora.x; amostra.y = eixo.fora.y;
    pôr(sentinela, eixo.posto.x, eixo.posto.y, eixo.paraFora, eixo.θ);
  };
  let acordouLogo = false, acordouDepois = false, quadroDoAcordar = -1;
  const antesDoPrazo = 30 * Math.max(1, S.PRAZO_DA_SACIEDADE - 8);
  const depoisDoPrazo = 30 * (S.PRAZO_DA_SACIEDADE + 5);
  for (let i = 0; i < 30 * (S.PRAZO_DA_SACIEDADE + 15); i++) {
    if (!A.corpos().some((x) => ACORDADO.includes(x.estado))) virar();
    A.sys.update(dt, A.ctx);
    const vendo = A.corpos().some((x) => ACORDADO.includes(x.estado));
    if (vendo && quadroDoAcordar < 0) quadroDoAcordar = i;
    if (i < antesDoPrazo && vendo) acordouLogo = true;
    if (i >= depoisDoPrazo && vendo) acordouDepois = true;
  }
  assert.equal(acordouLogo, false, 'o bando satisfeito voltou para a briga antes do prazo');
  assert.ok(acordouDepois, 'passado o prazo a tribo continua satisfeita: a folga não tem prazo');
  // E o relógio cobrado é o publicado: acordou depois do prazo, nunca antes da janela de leitura.
  assert.ok(quadroDoAcordar >= 30, `o bando acordou no quadro ${quadroDoAcordar} de uma folga de ${S.PRAZO_DA_SACIEDADE} s`);
});

test('cada estado do contrato aparece numa caçada real e desce para a tela em quadro legal', () => {
  // O atlas publicado do guerreiro (o doc de `guerreiroPose`): 0 parado, 1..4 marcha, 5 porrete no
  // alto, 6 braço armado de sentinela, 7 o golpe chegando, 8 o arrasto do prisioneiro. A prova não
  // grila o NOME de cada estado dentro da pose — isso obrigaria o desenho a ter um `if` por estado,
  // inclusive para os que são parados por definição, como o sentinela no posto, que É o quadro 0.
  // Ela alimenta a pose com o corpo que o sistema publicou num quadro de verdade e cobra o que sai.
  const ÚLTIMO_QUADRO = 8;
  // Os quadros em que o corpo está parado: 0 em pé, 5 porrete no alto, 6 braço armado de sentinela.
  const CONGELADOS = [0, 5, 6];
  const estados = [...GUERREIRO_SRC.match(/export type GuerreiroEstado =([^;]*);/)[1]
    .matchAll(/'([^']+)'/g)].map((m) => m[1]);
  const ac = NOSSO_AC;
  const A = aldeiaEm({ x: ac.entrada.x, y: ac.entrada.y }, { ac, vida: 40 });
  A.sys.update(1 / 30, A.ctx);
  const p = S.pontoDoTrilho(ac, S.postosDoBando(ac)[1]);
  pôr(A.corpos().find((g) => g.posto === 1), p.x, p.y, Math.atan2(ac.y - p.y, ac.x - p.x));
  const vistos = new Set();
  let deslizando = null, foraDoAtlas = null, passadaVista = 0;
  const dt = 1 / 30;
  // Uma caçada inteira, sem coreografia: o grito, o corte pela frente, o porrete, a captura, a volta
  // para a fogueira com o prisioneiro nos braços — e um companheiro abatido a tiro no meio do
  // caminho, porque o estado de morto só conta se aparecer com um corpo caído de verdade.
  for (let i = 0; i < 30 * 70; i++) {
    if (i === 30 * 20) {
      const alvo = A.corpos().find((g) => !g.morto);
      assert.equal(alvo && A.sys.fere(alvo.id, 999), true, 'o tiro no guerreiro não o derrubou');
    }
    A.sys.update(dt, A.ctx);
    for (const g of A.corpos()) {
      const visual = GUER.guerreiroVisualState(g, i * dt);
      const pose = GUER.guerreiroPose(visual, i * dt);
      vistos.add(g.morto ? 'morto' : g.estado);
      if (!Number.isInteger(pose.frame) || pose.frame < 0 || pose.frame > ÚLTIMO_QUADRO) {
        foraDoAtlas = `'${g.estado}' desenhado no quadro ${pose.frame}`;
      }
      // Ninguém desliza: corpo com velocidade publicada tem de estar desenhado num quadro em que o
      // corpo faz alguma coisa com o peso. Marcha (1..4) e arrasto do prisioneiro (8) andam — o 8 com
      // os dois pés plantados, e anda mesmo assim, porque quem puxa um corpo avança arrastando os
      // calcanhares em vez de levantar a passada. O golpe chegando (7) também: a janela do impacto
      // existe exatamente porque o sistema aplica o dano e devolve o corpo para a marcha no MESMO
      // tick, e um braço que bate e corre no quadro seguinte é o follow-through de uma martelada, não
      // um corpo congelado. Os
      // quadros parados são 0, 5 (porrete no alto) e 6 (braço armado de sentinela) — e os estados
      // que os usam publicam `velocidade = 0` por contrato, então um corpo correndo num deles é o
      // que esta régua procura: um estado entrante no contrato sem quadro de caminhada. Ela vem do
      // que o SISTEMA escreveu neste quadro, não de uma combinação inventada pelo teste.
      if (!g.morto && g.velocidade > 0.01 && CONGELADOS.includes(pose.frame)) {
        deslizando = `'${g.estado}' a ${g.velocidade.toFixed(2)} tiles/s no quadro ${pose.frame}`;
      }
      // E a régua tem de ter medido alguma coisa: sem um único corpo andando com passada na tela,
      // "ninguém desliza" seria verdade por ausência de caminhada, não por pose correta.
      if (!g.morto && g.velocidade > 0.01 && pose.frame >= 1 && pose.frame <= 4) passadaVista++;
    }
  }
  assert.equal(foraDoAtlas, null, `a pose devolveu um quadro que não existe no atlas: ${foraDoAtlas}`);
  assert.equal(deslizando, null, `corpo andando sem passada na tela: ${deslizando}`);
  assert.ok(passadaVista > 30, `em 70 s de caçada a passada apareceu em ${passadaVista} quadros — a régua de cima não mediu nada`);
  for (const e of estados) {
    assert.ok(vistos.has(e), `o estado '${e}' não aparece em 70 s de caçada — é branches morto ou a tela nunca o vê`);
  }
});

/* ===========================================================================
 * A arte do guerreiro sob régua.
 *
 * As provas abaixo medem o `<Path>` real que o jogo recebe, gravado no mesmo dublê de Skia da fase
 * 2 — geometria absoluta nenhuma foi copiada para cá. O motivo de existir é o que a folha anterior
 * desta fase provou na marra: um sprite lido só pelo comentário é um sprite errado em produção. As
 * quatro tentativas de desenhar o prisioneiro DENTRO do quadro do carregador passaram por um
 * `tsc` limpo e por uma banca de comportamento limpa, e estavam erradas no pixel — volume dentro da
 * silhueta de quem carrega é lido como parte de quem carrega, e dois corpos do mesmo ink empilhados
 * são um homem mais gordo. A única coisa que viu isso foi ampliar o traço e olhar. Aqui fica a
 * régua que impede o olho de voltar a fechar: um corpo só, uma arma na mão, uma vista por lado, e a
 * corda no quadro que puxa.
 * =========================================================================== */

const { guerreiroQuadro } = GSPR;
// A caixa, o solo e o cabo são lidos do próprio módulo, para a régua trocar junto com a arte se a
// arte trocar — e para nenhuma destas provas poder passar conferindo um número contra ele mesmo.
const LARGURA_GUER = Number(GSPRITE_SRC.match(/const LARGURA = (\d+)/)[1]);
const ALTURA_GUER = Number(GSPRITE_SRC.match(/const ALTURA = (\d+)/)[1]);
const SOLO_GUER = Number(GSPRITE_SRC.match(/const SOLO = (\d+)/)[1]);
const CABO_GUER = Number(GSPRITE_SRC.match(/const CABO = (\d+)/)[1]);
/** O tamanho do atlas, contado nas poses do módulo: um quadro `{ alto: … }` por pose. */
const QUADROS_DO_ATLAS = (GSPRITE_SRC.match(/\{ alto:/g) || []).length;
/**
 * O índice do arrasto é o último quadro do atlas, e a prova abaixo é que ele merece o nome: é o
 * único em que existe a linha de osso pendurada atrás do quadril.
 */
const QUADRO_DO_ARRASTO = QUADROS_DO_ATLAS - 1;

/** Os quadros que existem: nove poses × duas vistas, nas mesmas chamadas do `<Camada>`. */
const QUADROS_DO_GUERREIRO = [false, true].flatMap((away) => [...Array(QUADROS_DO_ATLAS).keys()].map((frame) => ({
  rótulo: `${away ? 'costas' : 'frente'} q${frame}`, away, frame, path: guerreiroQuadro(away, frame),
})));

/**
 * As caixas de cada forma pintada numa tinta. Um traço de dois pontos é um `addRect` (o dublê guarda
 * os dois cantos opostos); três ou mais é um polígono. É o único jeito de contar *formas* — mãos,
 * pedras, barras de pintura — em vez de contar pixels, e o número de pontos é o que separa o membro
 * retangular da sombra de tinta desenhada em polígono, sem depender de uma largura que a conta
 * binária devolve como 3,9999999999999996.
 */
function formas(frame, tinta) {
  return frame[tinta].traços.map((t) => {
    const xs = t.pontos.map((p) => p[0]), ys = t.pontos.map((p) => p[1]);
    return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys),
      largura: Math.max(...xs) - Math.min(...xs), altura: Math.max(...ys) - Math.min(...ys),
      pontos: t.pontos.length };
  });
}
const centroDaForma = (f) => [(f.x0 + f.x1) / 2, (f.y0 + f.y1) / 2];
const distância = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** As duas mãos: o único ink 1 que é quadrado de 4 px (o punho em `mo`). */
const mãosDoQuadro = (frame) => formas(frame, 1)
  .filter((f) => Math.abs(f.largura - 4) < 0.01 && Math.abs(f.altura - 4) < 0.01);
/** A cabeça de obsidiana: o ink 6 largo o bastante para ser uma pedra lascada, não a boca aberta. */
const pedraDoQuadro = (frame) => formas(frame, 6).filter((f) => f.largura * f.altura >= 25);
/** A amarra: fio de osso (ink 7) comprido e pendurado abaixo do quadril — só existe no arrasto. */
const amarraDoQuadro = (frame) => formas(frame, 7).filter((f) => f.y0 >= 28 && f.altura >= 8);
/** Barra de vermelhão no peito: larga, diagonal, acima da cintura. Vive na frente, não na nuca. */
const peitoPintado = (frame) => formas(frame, 5).filter((f) => f.y0 < 28 && f.largura >= 4);
/** Sombra de tinta 1 nas escápulas: os dois polígonos estreitos das costas, acima da cintura. */
const escápulasDoQuadro = (frame) => formas(frame, 1)
  .filter((f) => f.pontos >= 3 && f.y0 < 28 && f.largura < 4);
/** O pé que pisa: o ink 1 de 7×3 encostado exatamente na linha do solo. */
const péPlantado = (frame) => formas(frame, 1).some((f) => Math.abs(f.largura - 7) < 0.01
  && Math.abs(f.altura - 3) < 0.01 && Math.abs(f.y0 - SOLO_GUER) < 0.01);

/** A cabeça: o polígono de pele grande acima do ombro — o censo é o que conta, um guerreiro tem uma. */
const cabeçasDoQuadro = (frame) => formas(frame, 2).filter((f) => f.pontos >= 3
  && Math.min(f.largura, f.altura) >= 6 && f.y1 < 26);
/**
 * A borda de trás do torso, contada no MAIOR contorno de tinta 0 do quadro. Não é o contorno mais à
 * esquerda, nem o mais largo: no arrasto, o traçado da corda chega a x=1,5 e é mais largo que muito
 * ombro — o tronco é o que tem maior área, e é a mesma silhueta de 15×19 px nos dezoito quadros.
 */
const torsoDoQuadro = (frame) => formas(frame, 0)
  .reduce((a, b) => (b.largura * b.altura > a.largura * a.altura ? b : a));
const bordaDeTrás = (frame) => torsoDoQuadro(frame).x0;
/** Manchas de corpo (pele, tecido, pintura) grandes o bastante para serem lidas como um volume. */
const manchasDeCorpo = (frame) => [2, 3, 4, 5].flatMap((tinta) => formas(frame, tinta))
  .filter((f) => f.largura * f.altura >= 20);
/**
 * Volume de corpo atrás do tronco, acima da cintura. A perna que passa por trás na passada é tinta
 * de coxa abaixo do quadril e é legítima; um torso de prisioneiro ali não é — quem está sendo
 * levado é o jogador, com sprite, sombra e lugar próprio na fila ordenada.
 */
const corpoAtrás = (frame) => {
  const trás = bordaDeTrás(frame);
  return manchasDeCorpo(frame).filter((f) => f.x0 < trás && f.y0 < 30);
};

/**
 * Quantos corpos o contorno desenha: as caixas de tinta 0 são juntadas quando se encostam (com a
 * folga de meio pixel que o contorno de um membro já deixa). Um guerreiro é UM; dois é o prisioneiro
 * pintado dentro do sprite do carregador, e um latejando é um caco solto no ar.
 */
function componentesDoContorno(frame) {
  const caixas = formas(frame, 0);
  const pai = caixas.map((_, i) => i);
  const raiz = (i) => (pai[i] === i ? i : (pai[i] = raiz(pai[i])));
  const encosta = (a, b) => a.x0 <= b.x1 + 0.5 && b.x0 <= a.x1 + 0.5
    && a.y0 <= b.y1 + 0.5 && b.y0 <= a.y1 + 0.5;
  for (let i = 0; i < caixas.length; i++) {
    for (let j = i + 1; j < caixas.length; j++) if (encosta(caixas[i], caixas[j])) pai[raiz(i)] = raiz(j);
  }
  return new Set(caixas.map((_, i) => raiz(i))).size;
}

/**
 * Pixels cobertos pela união de todas as tintas (varredura de linha, regra par-ímpar). É a medida
 * de "quanto homem existe no quadro": um corpo inteiro a mais custa uma fração enorme disto, e um
 * pixel de diferença entre poses custa quase nada.
 */
function áreaPintada(frame) {
  const polígonos = [];
  for (const caminho of frame) for (const traço of caminho.traços) {
    polígonos.push(traço.pontos.length === 2
      ? [[traço.pontos[0][0], traço.pontos[0][1]], [traço.pontos[1][0], traço.pontos[0][1]],
        traço.pontos[1], [traço.pontos[0][0], traço.pontos[1][1]]]
      : traço.pontos);
  }
  let total = 0;
  for (let y = -8; y < 56; y++) {
    let linha = 0;
    for (const pts of polígonos) {
      const xs = [];
      for (let i = 0; i < pts.length; i++) {
        const [x0, y0] = pts[i], [x1, y1] = pts[(i + 1) % pts.length];
        if ((y0 <= y && y1 > y) || (y1 <= y && y0 > y)) xs.push(x0 + ((y - y0) / (y1 - y0)) * (x1 - x0));
      }
      xs.sort((a, b) => a - b);
      for (let i = 0; i + 1 < xs.length; i += 2) linha += Math.round(xs[i + 1]) - Math.round(xs[i]) + 1;
    }
    total += linha;
  }
  return total;
}

test('o guerreiro desenhado é um corpo só: contorno junto, pé no chão e mais alto que largo', () => {
  // A régua que faltava quando o prisioneiro ainda era pintado aqui. Ela não diz "não desenhe o
  // corpo": diz que o quadro inteiro tem de ler UMA silhueta ereta, e é isso que pega tanto o
  // segundo homem colado ao carregador quanto o latejando sozinho no ar.
  for (const q of QUADROS_DO_GUERREIRO) {
    assert.ok(formas(q.path, 0).length > 0, `${q.rótulo}: nenhum contorno — o quadro é tinta solta, não corpo`);
    const soltos = componentesDoContorno(q.path);
    assert.equal(soltos, 1, `${q.rótulo}: o contorno tem ${soltos} corpos — ou há um segundo homem`
      + ` desenhado dentro deste sprite, ou há um fragmento pendurado no ar`);
    // O contorno pode estar junto e ainda assim haver dois homens: colado no ombro, o prisioneiro
    // vira "ombro largo" para a conectividade. A contagem de cabeças é a régua que não se deixa
    // convencer pelo abraço — um guerreiro tem uma cabeça de pele, em todos os dezoito quadros.
    const cabeças = cabeçasDoQuadro(q.path);
    assert.equal(cabeças.length, 1, `${q.rótulo}: ${cabeças.length} cabeças no quadro — o corpo que ele `
      + `carrega é o jogador, desenhado pelo sprite dele, com sombra e lugar próprio na fila`);
    // E a zona atrás: abaixo da cintura a perna de trás passa por fora do tronco e é tinta de coxa
    // legítima; acima dela, atrás da borda do torso, só existe o traçado do cabo e da amarra.
    const atrás = corpoAtrás(q.path);
    assert.equal(atrás.length, 0, `${q.rótulo}: ${atrás.length} volumes de corpo atrás do torso, acima`
      + ` da cintura (x < ${bordaDeTrás(q.path).toFixed(1)}) — é prisioneiro pintado onde o sistema já`
      + ` publica o jogador`);
    const b = caixaDaArte(q.path);
    const largura = b.x1 - b.x0, altura = b.y1 - b.y0;
    // Empilhar dois homens no mesmo pixel não aumenta a altura: aumenta a LARGURA. É por isso que a
    // proporção manda e o número absoluto de pixels não.
    assert.ok(altura >= largura * 1.5, `${q.rótulo}: silhueta ${largura.toFixed(0)}×${altura.toFixed(0)}`
      + ` px — menos de uma vez e meia mais alta que larga é boneco empilhado, não homem em pé`);
    assert.ok(altura >= 40 && altura <= ALTURA_GUER + 10,
      `${q.rótulo}: corpo de ${altura.toFixed(0)} px para uma caixa de ${ALTURA_GUER}`);
    assert.ok(b.x0 >= -2 && b.x1 <= LARGURA_GUER + 2,
      `${q.rótulo}: a tinta vai de ${b.x0.toFixed(1)} a ${b.x1.toFixed(1)} numa caixa de ${LARGURA_GUER}`);
    assert.ok(péPlantado(q.path), `${q.rótulo}: nenhum pé na linha do solo (y=${SOLO_GUER}) — o corpo flutua`);
  }
});

test('a área pintada é a de um homem em cada quadro: o arrasto não ganha corpo', () => {
  // Os dez quadros de um mesmo lado têm de ser o MESMO corpo em poses diferentes. A comparação é
  // feita contra o quadro parado da própria vista, porque frente e costas têm quantidades de tinta
  // diferentes por construção (de costas o crânio é cabelo, não cara) e o que importa é a variação
  // dentro de uma vista. Um prisioneiro desenhado dentro do sprite empurraria o quadro 8 para fora
  // desta banda — foi exatamente o que as duas primeiras versões faziam.
  for (const away of [false, true]) {
    const base = áreaPintada(guerreiroQuadro(away, 0));
    assert.ok(base > 1500, `${away ? 'costas' : 'frente'}: ${base} px pintados no quadro parado — não há corpo`);
    for (let frame = 1; frame <= QUADRO_DO_ARRASTO; frame++) {
      const área = áreaPintada(guerreiroQuadro(away, frame));
      const razão = área / base;
      assert.ok(razão >= 0.85 && razão <= 1.08,
        `${away ? 'costas' : 'frente'} q${frame}: ${razão.toFixed(2)}× a tinta do quadro parado`
        + ` — ou sumiu um membro, ou entrou um corpo que o sistema já desenha sozinho`);
    }
  }
});

test('a pedra está na ponta do cabo e o cabo na mão: um porrete por quadro, a um cabo do punho', () => {
  // Ancorar a arma no punho é a decisão desta folha, e sem régua ela regressa sozinha: a primeira
  // versão tinha cinco comprimentos que discordavam, uma pedra flutuando acima do punho e um windup
  // atravessando a cara do dono. Cada um deles estava "dentro da caixa" e nenhum aparecia num check
  // de geometria absoluta. Aqui a pergunta é uma só: a uma martelada de braço da mão que a segura?
  for (const q of QUADROS_DO_GUERREIRO) {
    const mãos = mãosDoQuadro(q.path);
    assert.equal(mãos.length, 2, `${q.rótulo}: ${mãos.length} punhos desenhados — o guerreiro tem duas mãos`);
    const pedras = pedraDoQuadro(q.path);
    if (q.frame === QUADRO_DO_ARRASTO) continue;
    assert.equal(pedras.length, 1, `${q.rótulo}: ${pedras.length} cabeças de obsidiana no quadro`);
    const alcance = Math.min(...mãos.map((m) => distância(centroDaForma(pedras[0]), centroDaForma(m))));
    assert.ok(Math.abs(alcance - CABO_GUER) <= 2,
      `${q.rótulo}: pedra a ${alcance.toFixed(1)} px do punho mais perto, cabo declarado ${CABO_GUER}`
        + ` — a arma flutua longe da mão ou está enterrada no braço`);
  }
});

test('as costas não mostram o peito: duas diagonais na frente, as escápulas atrás', () => {
  // A vista `away` já foi o mesmo homem de frente sem cara, e a volta por cima dela é isto: a
  // pintura de guerra vive NA PELE do peito, então de frente há duas barras diagonais e de costas
  // não há nenhuma — o que existe atrás é a sombra das escápulas e a faixa do meio das costas. Um
  // `if` a menos no desenho e a pintura aparece na nuca, o que ninguém vê num typecheck.
  for (const q of QUADROS_DO_GUERREIRO) {
    const barras = peitoPintado(q.path).length, ombros = escápulasDoQuadro(q.path).length;
    assert.equal(barras, q.away ? 0 : 2,
      `${q.rótulo}: ${barras} barras de vermelhão no peito — ${q.away ? 'de costas a pintura está do outro lado do corpo' : 'de frente é a marca de quem sai em caçada'}`);
    assert.equal(ombros, q.away ? 2 : 0,
      `${q.rótulo}: ${ombros} sombras de escápula — a vista que só OMITE detalhes é um desenho incompleto`);
  }
  for (let frame = 0; frame <= QUADRO_DO_ARRASTO; frame++) {
    assert.notEqual(assinatura(guerreiroQuadro(false, frame)), assinatura(guerreiroQuadro(true, frame)),
      `q${frame}: frente e costas são a mesma tinta — ` + '`away` não muda nada no sprite');
  }
});

test('o arrasto é um quadro: base plantada, mãos atrás do quadril, amarra de osso e nenhuma arma', () => {
  // O quadro 8 é o único gesto do sprite em que nenhuma das duas mãos está livre, e é isso que faz
  // do carregador o alvo mais gordo da clareira — a terceira porta de escape da captura começa no
  // desenho. Cada réguas abaixo é uma mutação concreta que já esteve aqui: o arrasto igual ao parado,
  // o porrete continuando na mão, a corda virando tinta de enfeite em outro quadro.
  for (const away of [false, true]) {
    const lado = away ? 'costas' : 'frente';
    const arrasto = guerreiroQuadro(away, QUADRO_DO_ARRASTO);
    const outro = (frame) => guerreiroQuadro(away, frame);
    const mãos = mãosDoQuadro(arrasto);
    assert.notEqual(assinatura(arrasto), assinatura(outro(0)),
      `${lado}: o arrasto é o quadro parado com um enfeite — quem puxa um corpo não fica em pé à toa`);
    // Nenhuma arma: de duas mãos que puxam uma corda, nenhuma segura um porrete.
    assert.equal(pedraDoQuadro(arrasto).length, 0, `${lado}: o carregador ainda segura a pedra`);
    // A amarra existe, é de osso, e só existe aqui.
    assert.equal(amarraDoQuadro(arrasto).length, 1, `${lado}: nenhuma linha de osso comprida pendurada atrás do quadril`);
    for (let frame = 0; frame < QUADRO_DO_ARRASTO; frame++) {
      assert.equal(amarraDoQuadro(outro(frame)).length, 0,
        `${lado} q${frame}: há amarra num quadro que não é o arrasto — a corda é enfeite de outro gesto`);
    }
    // Os dois braços atrás do peso: a mão mais adiantada do arrasto fica onde nenhuma outra vista de
    // nenhum outro quadro chega — medir o "atrás" por comparação com a própria vista é o que evita
    // o número mágico, porque o `corpoX` troca entre frente e costas.
    const mãoMaisAdiantada = (frame) => Math.max(...mãosDoQuadro(outro(frame)).map((m) => centroDaForma(m)[0]));
    const menorAlcance = Math.min(...[...Array(QUADRO_DO_ARRASTO).keys()].map(mãoMaisAdiantada));
    const atrás = Math.max(...mãos.map((m) => centroDaForma(m)[0]));
    assert.ok(atrás <= menorAlcance - 2,
      `${lado}: no arrasto a mão mais adiantada está em ${atrás.toFixed(1)} px e em marcha a mais`
        + ` adiantada chega a ${menorAlcance.toFixed(1)} — os dois braços não estão atrás do peso`);
    // E o corpo alcança PARA TRÁS: a silhueta do arrasto se estende bem além do bordo esquerdo do
    // homem parado, que é o lado de onde o peso vem. Sem isto o quadro seria um parado com os braços
    // caídos, e o vão entre os dois sprites existiria só na cabeça de quem escreveu o sistema.
    const alcance = caixaDaArte(arrasto).x0, parado = caixaDaArte(outro(0)).x0;
    assert.ok(alcance < parado - 3,
      `${lado}: a tinta mais recuada do arrasto está em ${alcance.toFixed(1)} contra ${parado.toFixed(1)} do parado`
        + ` — o corpo não alcança o peso`);
  }
});

test('a amarra tem comprimento no mundo: o corpo na ponta é o jogador, atrás de quem puxa', () => {
  // O outro lado da mesma costura. O sprite do guerreiro pinta a corda e para aí; o corpo na ponta
  // é o `Player`, posto lá pelo `arrasta` do contexto a cada quadro. Se o sistema entregar as duas
  // coordenadas do carregador, os dois sprites caem na MESMA linha da fila ordenada e o arrasto
  // vira um homem mais gordo — exatamente o defeito que as quatro tentativas de arte desta folha
  // tiveram de descobrir olhando PNG ampliado. Aqui a régua é behavioural: uma caçada real, e o vão
  // medido entre o corpo que anda e o corpo que ele puxa.
  const ac = NOSSO_AC;
  const player = { x: ac.entrada.x, y: ac.entrada.y };
  const A = aldeiaEm(player, { ac, vida: 40 });
  A.sys.update(1 / 30, A.ctx);
  const vidente = A.corpos().find((g) => g.posto === 1);
  const p = S.pontoDoTrilho(ac, S.postosDoBando(ac)[1]);
  pôr(vidente, p.x, p.y, Math.atan2(ac.y - p.y, ac.x - p.x));
  let medidos = 0, colados = 0, àFrente = 0, menorVão = Infinity, maiorVão = -Infinity, fora = 0;
  const dt = 1 / 30;
  for (let i = 0; i < 30 * 40 && A.diary.capturas.length === 0; i++) {
    const antes = A.diary.arrastou;
    A.sys.update(dt, A.ctx);
    if (A.diary.arrastou === antes) continue;
    const carregador = A.corpos().find((g) => g.estado === 'carregando' && g.carrega);
    // O quadro da entrega não entra: ali o corpo é atado no poste de propósito, e a amarra do
    // arrasto vale para a caminhada, não para o último passo.
    if (!carregador) continue;
    medidos++;
    const vão = Math.hypot(player.x - carregador.x, player.y - carregador.y);
    menorVão = Math.min(menorVão, vão);
    maiorVão = Math.max(maiorVão, vão);
    // Atrás, nunca ao lado nem na frente: o projétil do vão contra o `olhar` publicado. É a mesma
    // conta que o sprite faz em pixels, e é o que impede o prisioneiro de ser desenhado sobre o
    // peito de quem o arrasta quando a câmera pega o corpo de lado.
    const proa = ((player.x - carregador.x) * Math.cos(carregador.olhar)
      + (player.y - carregador.y) * Math.sin(carregador.olhar)) / Math.max(vão, 1e-6);
    if (proa > -0.9) àFrente++;
    // O vão mínimo não é um palpite: é a largura do próprio corpo. Abaixo de dois raios de guerreiro
    // os dois sprites se sobrepõem e a fila ordenada perde o sentido de existir.
    if (vão < 2 * GUER.GUERREIRO_RAIO) colados++;
    if (!T.acampamentoQueRecebe(player.x, player.y, CW, CH, RIO)) fora++;
  }
  assert.ok(medidos > 20, `a corda só apareceu em ${medidos} quadros de uma caçada de 40 s — a régua não mediu caminhada`);
  assert.equal(colados, 0, 'o prisioneiro foi arrastado colado em quem puxa: na tela é um homem mais gordo, não dois');
  assert.equal(àFrente, 0, 'o corpo na ponta da corda passou para a frente ou para o lado de quem puxa');
  assert.ok(maiorVão - menorVão < 1e-9, `a amarra estica e encolhe (${menorVão.toFixed(2)}..${maiorVão.toFixed(2)}) — o vão é um número do sistema, não um acaso do passo`);
  assert.equal(fora, 0, 'o jogador arrastado saiu da terra pisada: seria um corpo desenhado dentro do mato');
  // E o número do vão é o mesmo nos dois lados da costura: a corda desenhada e o corpo empurrado
  // têm de concordar sobre o comprimento, senão o sprite aponta para um lugar onde ninguém está.
  assert.ok(Math.abs(menorVão - S.DISTANCIA_DA_AMARRA) < 1e-9,
    `o vão arrastado foi ${menorVão.toFixed(2)} tiles, a amarra declara ${S.DISTANCIA_DA_AMARRA}`);
  assert.ok(S.DISTANCIA_DA_AMARRA >= 2 * GUER.GUERREIRO_RAIO,
    'a amarra declarada é mais curta que a largura do próprio corpo: o arrasto nasceria empilhado');
  const entrega = A.diary.últimoArrasto;
  // A chegada troca de alvo, e é isto que esta régua pega: o caminho é medido do corpo que puxa, a
  // amarra é medida do poste. Esquecesse de trocar, o prisioneiro seria deixado a `DISTANCIA_DA_AMARRA`
  // de um guerreiro que parou, e a corda no chão seria um número velho ainda valendo.
  const alcance = ac.poste.raio + GAME_CONFIG.PLAYER_RADIUS;
  const dPoste = Math.hypot(entrega.x - ac.poste.x, entrega.y - ac.poste.y);
  assert.ok(dPoste >= alcance && dPoste <= alcance + 0.03,
    `na chegada o corpo ficou a ${dPoste.toFixed(3)} tiles do poste, e a amarra o quer encostado a ${alcance.toFixed(3)} com um dedo de folga`);
  assert.ok(Math.abs(dPoste - S.DISTANCIA_DA_AMARRA) > 0.2,
    'a entrega ainda é um passo de corda: o vão do arrasto continuou mandando no ponto onde o corpo pousa');
});

test('o arrasto chega à tela pelo `carrega`, e não por um estado novo', () => {
  // O quadro 8 é o único do atlas que nasce de um BOOLEANO do corpo, não de um estado da máquina:
  // `carrega`. Se a pose passar a escolher o gesto por `estado`, o guerreiro que voltou para o posto
  // continua arrastando um jogador que já foi solto — e o `fereGuerreiro`, que devolve o corpo à
  // perseguição limpando o booleano, perde o único sinal que ele tem na tela. A prova varre a
  // matriz inteira porque é um contrato de duas variáveis, não um caso.
  const estados = [...GUERREIRO_SRC.match(/export type GuerreiroEstado =([^;]*);/)[1]
    .matchAll(/'([^']+)'/g)].map((m) => m[1]);
  for (const estado of estados) {
    for (const carrega of [false, true]) {
      for (const morto of [false, true]) {
        for (const velocidade of [0, 1.8]) {
          const visual = GUER.guerreiroVisualState(
            Object.assign(GUER.criaGuerreiro(1, 1, 0, 0, 0, 0), { estado, carrega, morto, velocidade }), 0);
          const { frame } = GUER.guerreiroPose(visual, 0);
          const esperado = morto ? 0 : carrega ? QUADRO_DO_ARRASTO : null;
          if (esperado === null) {
            assert.notEqual(frame, QUADRO_DO_ARRASTO,
              `'${estado}' sem carregar pintou o arrasto — o corpo puxa um prisioneiro que não existe`);
          } else {
            assert.equal(frame, esperado, `'${estado}' carrega=${carrega} morto=${morto} desenhado no quadro ${frame}`);
          }
        }
      }
    }
  }
});

function behind(atrás, menorAlcance, lado) {
  assert.ok(atrás <= menorAlcance - 2,
    `${lado}: no arrasto a mão mais adiantada está em ${atrás.toFixed(1)} px e em marcha a mais`
      + ` adiantada chega a ${menorAlcance.toFixed(1)} — os dois braços não estão atrás do peso`);
  return true;
}


test('atirar em quem carrega solta o prisioneiro, e um companheiro caído enfurece os outros', () => {
  const ac = NOSSO_AC;
  const A = aldeiaEm({ x: ac.entrada.x, y: ac.entrada.y }, { ac, vida: 40 });
  A.sys.update(1 / 30, A.ctx);
  const postos = S.postosDoBando(ac);
  const vidente = A.corpos().find((g) => g.posto === 1);
  const p = S.pontoDoTrilho(ac, postos[1]);
  pôr(vidente, p.x, p.y, Math.atan2(ac.y - p.y, ac.x - p.x));
  let carregador = null;
  const dt = 1 / 30;
  for (let i = 0; i < 30 * 40 && !carregador; i++) {
    A.sys.update(dt, A.ctx);
    carregador = A.corpos().find((g) => g.carrega) ?? null;
  }
  assert.ok(carregador, 'nunca houve quem carregasse o corpo — nada a liberar');
  const restante = A.corpos().filter((g) => g !== carregador && !g.morto);
  const furorAntes = restante.map((g) => g.furor);
  const arrastouAntes = A.diary.arrastou;

  // O tiro não letal no carregador: ele solta na hora e volta a bater.
  assert.equal(A.sys.fere(carregador.id, 20), false, 'vinte de dano mataram um guerreiro de 90');
  assert.equal(carregador.carrega, false, 'levou um tiro nas costas e continuou carregando o corpo');
  assert.equal(carregador.morto, false, 'um tiro não letal derrubou o guerreiro');

  // E o bando inteiro fica mais rápido com um dos seus no chão: é a mesma lição da mata — atirar
  // não espanta, acelera.
  assert.equal(A.sys.fere(carregador.id, 999), true, 'o segundo tiro não foi letal');
  assert.equal(carregador.morto, true, 'mataram o guerreiro e ele continua de pé');
  const furorDepois = restante.map((g) => g.furor);
  assert.ok(furorDepois.some((f, i) => f > furorAntes[i]),
    'um companheiro caído não deixou os outros mais furiosos');
  for (const g of A.sys.guerreiros) A.sys.fere(g.id, 999);
  assert.equal(A.corpos().filter((g) => !g.morto).length, 0, 'sobrou alguém em pé para atirar');
  assert.ok(A.corpos().length > 0, 'o cadáver sumiu da lista na hora — não houve queda desenhada');
  anda(A, 5);
  assert.equal(A.diary.arrastou, arrastouAntes, 'com o carregador morto outro corpo continuou arrastando o jogador');
});

test('bando satisfeito não olha para você, mas o jogador inteiro é surrado e não agarrado', () => {
  const ac = NOSSO_AC;
  // Vida travada em 100: o chão do abolo nunca chega. Se ainda assim houvesse captura, ela estaria
  // saindo do estado, não da regra — e é exatamente isso que esta prova veta.
  const A = aldeiaEm({ x: ac.entrada.x, y: ac.entrada.y }, { ac, vidaFixa: 100 });
  A.sys.update(1 / 30, A.ctx);
  const postos = S.postosDoBando(ac);
  const vidente = A.corpos().find((g) => g.posto === 1);
  const p = S.pontoDoTrilho(ac, postos[1]);
  pôr(vidente, p.x, p.y, Math.atan2(ac.y - p.y, ac.x - p.x));
  anda(A, 30);
  assert.ok(A.diary.dano.length >= 3, 'trinta segundos dentro da aldeia e ninguém bateu: a luta não aconteceu');
  assert.equal(A.diary.arrastou, 0, 'agarraram um jogador com a vida cheia — a captura não obedece ao chão');
  assert.equal(A.diary.capturas.length, 0, 'amarraram ao poste alguém que podia correr');

  // A pé é requisito: quem está dentro de um carro não é corpo que se arrasta.
  const B = aldeiaEm({ x: ac.entrada.x, y: ac.entrada.y }, { ac, vida: 40, aPé: false });
  B.sys.update(1 / 30, B.ctx);
  const v2 = B.sys.guerreiros.find((g) => g.posto === 1);
  pôr(v2, p.x, p.y, Math.atan2(ac.y - p.y, ac.x - p.x));
  anda(B, 30);
  assert.equal(B.diary.arrastou, 0, 'arrastaram um motorista pelo vidro do carro');
  assert.ok(B.diary.dano.length > 0, 'a cavalo de motor nenhum deles bateu: o `aPé` travou a luta inteira');
});

test('nenhum ponto do mundo tem dois donos: o rio, a aldeia e o gigante medem a mesma régua', () => {
  // (a) rio ∩ aldeia = vazio, medido no anel inteiro de cada acampamento do mapa.
  let amostras = 0;
  for (const ac of ACAMPAMENTOS) {
    const raio = T.FOLGA_DA_JURISDIÇÃO + 0.1;
    for (let v = -raio; v <= raio; v += 0.5) {
      for (let u = -raio; u <= raio; u += 0.5) {
        const x = ac.x + u * ac.meiaLargura, y = ac.y + v * ac.meiaAltura;
        if (!T.jurisdiçãoDaAldeia(ac, x, y)) continue;
        amostras++;
        assert.equal(RIO.isWaterWorld(x, y) && T.terraDaAldeia(x, y, CW, CH, RIO), false,
          `aldeia ${ac.id} cobra um ponto que o canal também cobra em (${x.toFixed(1)}, ${y.toFixed(1)})`);
      }
    }
  }
  assert.ok(amostras > 200, `só ${amostras} pontos jurisdição medidos: a varredura não cobriu o anel`);

  // (b) o gigante não cobra a terra deles. A posse do fundo é uma coisa só — clareira, porta e o
  // mato entre as clareiras — e a prova tem de medir os dois casos separados: dentro da
  // jurisdição (onde um bando patrulha) e na mata aberta do fundo (onde não patrulha ninguém e,
  // ainda assim, o gigante não entra). É a separação que faz cada predador ser *procurável*: quem
  // quer o bicho anda até a mata velha, quem quer a aldeia atravessa a linha.
  const ac = NOSSO_AC;
  const gorilaParado = (p, segundos) => {
    const sys = new GOR.GorilaSystem();
    const avisos = [];
    const ctx = { worldW: CW, worldH: CH, player: p, worldPosition: p, água: RIO,
      damages: () => true, shake: () => {}, say: (t) => { avisos.push(t); }, play: () => {},
      isVisible: () => true, onStructChange: () => {} };
    let viuFera = false;
    let ondeAFeiraEstava = null;
    let avisosAntes = 0;
    for (let i = 0; i < Math.round(segundos * 30); i++) {
      sys.update(1 / 30, ctx);
      // Visto em qualquer quadro, não só no último: a fera se levanta, caça e se retira, e um
      // sistema que só tivesse levantado corpo uma vez ainda teria levantado — o que se prova é
      // que a terra cobra e levanta, não em que instante a amostra foi lida.
      if (sys.fera && !viuFera) {
        viuFera = true;
        ondeAFeiraEstava = { x: sys.fera.x, y: sys.fera.y };
        // Contado aqui, e não no fim da corrida: a frase que vale é a que veio ANTES do corpo. O
        // urro de levantamento e a frase da retirada também caem em `avisos`, e somá-los depois
        // deixaria esta prova passando num sistema que nunca avisou — só porque falou ao nascer.
        avisosAntes = avisos.length - 1;
      }
    }
    return { sys, avisos, viuFera, ondeAFeiraEstava, avisosAntes };
  };
  // O caminho de volta para a cidade, medido a meio tile: é por ele que o jogador sai do fundo, e
  // é nele que as duas amostras existem — o fundo que já é terra deles e a banda que ainda é mata.
  const raioDeSaída = (alvo) => {
    const passos = [];
    for (let t = 0; t <= 110; t += 0.5) {
      const x = alvo.x + alvo.rumo.x * t, y = alvo.y + alvo.rumo.y * t;
      const prof = F.profundidade(x, y, CW, CH);
      if (RIO.isWaterWorld(x, y) || T.terraDaAldeia(x, y, CW, CH, RIO)) continue;
      passos.push({ x, y, prof });
    }
    return passos;
  };
  const naAldeia = gorilaParado({ x: ac.entrada.x, y: ac.entrada.y }, 200);
  assert.equal(naAldeia.sys.rancor, 0, 'o gigante cobrou dívida na terra do bando');
  assert.equal(naAldeia.viuFera, false, 'o gigante se levantou dentro de uma aldeia');
  assert.equal(naAldeia.avisos.length, 0, 'o gigante avisou da fera dentro da terra deles');

  const trilha = raioDeSaída(ac);
  const fundo = trilha.find((p) => p.prof >= F.PROFUNDIDADE_SEM_NOME);
  const banda = trilha.find((p) => p.prof <= F.PROFUNDIDADE_SEM_NOME - 2 && p.prof >= 8);
  assert.ok(fundo, 'a trilha de saída nunca chega ao fundo fora da jurisdição: nada mede a banda');
  assert.ok(banda, 'a trilha de saída não tem mata velha: a comparação seria com nada');
  const noFundo = gorilaParado(fundo, 200);
  assert.equal(noFundo.sys.rancor, 0, 'o gigante cobrou dívida na terra sem nome inteira');
  assert.equal(noFundo.viuFera, false, 'o gigante se levantou na terra sem nome');
  assert.equal(noFundo.avisos.length, 0, 'o gigante avisou de um bicho que não caça aquela terra');

  // Na mata velha, a mesma régua cobra e levanta corpo — senão os zeros acima são só um sistema
  // que não roda. A dívida em si não é a prova: `nasce` a devolve para o teto da retirada no
  // instante em que a fera se levanta. O que diz que a mata cobra é o corpo no mundo e a voz antes.
  const naMata = gorilaParado(banda, 200);
  assert.equal(naMata.viuFera, true, 'a mata velha não levantou fera nenhuma: os zeros do fundo não provam nada');
  assert.ok(naMata.avisosAntes > 0, 'a mata levantou a fera sem avisar antes: a régua comparada é outra');
  const nascido = naMata.ondeAFeiraEstava;
  assert.ok(F.profundidade(nascido.x, nascido.y, CW, CH) < F.PROFUNDIDADE_SEM_NOME,
    'a fera nasceu além da porta da tribo');
  assert.equal(T.terraDaAldeia(nascido.x, nascido.y, CW, CH, RIO), false,
    'a fera nasceu em cima de uma aldeia');

  // (c) a varredura inteira do perímetro: nenhum ponto de emergência do mundo cai em terra pisada.
  // Esta prova já foi uma estatística — "o hash às vezes põe a fera na clareira, por isso o
  // expulso tem de existir". A banda do gigante tornou a afirmação mais forte do que ela: o teto
  // dele é um, o chão deles é outro, e entre os dois ainda há mata que não é de ninguém. Medido,
  // não acreditado: a jurisdição mais rasa do mapa é procurada aqui, e se um dia ela encostar na
  // banda, é esta varredura que avisa — o `expulsaDaClareira` do `nasce` fica exatamente para esse
  // dia, porque a profundidade do fundo é consequência do sorteio da célula, não uma regra.
  let maisRasa = Infinity;
  for (const a of ACAMPAMENTOS) {
    const raio = T.FOLGA_DA_JURISDIÇÃO + 0.05;
    for (let v = -raio; v <= raio; v += 0.25) {
      for (let u = -raio; u <= raio; u += 0.25) {
        const x = a.x + u * a.meiaLargura, y = a.y + v * a.meiaAltura;
        if (!T.jurisdiçãoDaAldeia(a, x, y)) continue;
        const p = F.profundidade(x, y, CW, CH);
        if (p < maisRasa) maisRasa = p;
      }
    }
  }
  assert.ok(maisRasa > F.PROFUNDIDADE_SEM_NOME,
    `a jurisdição mais rasa está a ${maisRasa.toFixed(1)} de fundo, dentro da terra que a frente `
    + `chama de mata dele (${F.PROFUNDIDADE_SEM_NOME}) — as duas posses se tocam`);
  let nascimentos = 0;
  for (let prof = 6; prof < F.PROFUNDIDADE_SEM_NOME; prof += 1) {
    for (let k = 0; k <= 20; k++) {
      const ao = (k / 20) * CW;
      const amostras = [[ao, -prof], [ao, CH + prof], [-prof, ao], [CW + prof, ao],
        [-prof * 0.7, -prof * 0.7], [CW + prof * 0.7, -prof * 0.7],
        [-prof * 0.7, CH + prof * 0.7], [CW + prof * 0.7, CH + prof * 0.7]];
      for (const [px, py] of amostras) {
        if (RIO.isWaterWorld(px, py)) continue;
        const nasc = GOR.pontoDeEmergência(px, py, CW, CH);
        nascimentos++;
        assert.equal(T.terraDaAldeia(nasc.x, nasc.y, CW, CH, RIO), false,
          `fera nascendo em terra pisada: jogador a ${F.profundidade(px, py, CW, CH).toFixed(1)} `
          + `de fundo, ponto em (${nasc.x.toFixed(1)}, ${nasc.y.toFixed(1)}) `
          + `a ${F.profundidade(nasc.x, nasc.y, CW, CH).toFixed(1)}`);
      }
    }
  }
  assert.ok(nascimentos > 4000, `só ${nascimentos} emergências medidas: a varredura não cobriu o perímetro`);
});

test('a banda do gigante termina na porta deles: nem o ponto de emergência nem o corpo cruzam', () => {
  const LIMITE = F.PROFUNDIDADE_SEM_NOME - 1;
  // As quatro faces e os quatro cantos, em profundidade crescente. O canto é o caso que quebra a
  // implementação ingênua: ali o corpo sai do mapa por dois eixos ao mesmo tempo, e encurtar só um
  // deles *aumenta* a profundidade medida. É a única forma de a linha ser uma parede e não um
  // pedido. O fundo da varredura é o próprio teto da banda: a um jogador que já está em cima da
  // linha não existe ponto nem mais fundo nem dentro da terra dele, e essa é exatamente a hora em
  // que o `deveNascer` dele não levanta nada — cobrar geometria ali seria cobrar o impossível.
  let vistos = 0;
  for (let prof = 6; prof < F.PROFUNDIDADE_SEM_NOME - 1; prof += 1) {
    for (const [px, py] of [
      [CW / 2, -prof], [CW / 2, CH + prof], [-prof, CH / 2], [CW + prof, CH / 2],
      [-prof * 0.7, -prof * 0.7], [CW + prof * 0.7, -prof * 0.7],
      [-prof * 0.7, CH + prof * 0.7], [CW + prof * 0.7, CH + prof * 0.7],
    ]) {
      const minha = F.profundidade(px, py, CW, CH);
      const nasc = GOR.pontoDeEmergência(px, py, CW, CH);
      const dele = F.profundidade(nasc.x, nasc.y, CW, CH);
      const d = Math.hypot(nasc.x - px, nasc.y - py);
      assert.ok(dele <= LIMITE + 1e-6,
        `fera nascendo a ${dele.toFixed(2)} de profundidade, em terra deles, atrás do jogador (${px.toFixed(1)}, ${py.toFixed(1)})`);
      assert.ok(dele > minha, `nasceu menos fundo que o jogador: ${dele.toFixed(2)} <= ${minha.toFixed(2)}`);
      assert.ok(d >= 20 && d <= 40, `distância de emergência ${d.toFixed(1)} fora da janela`);
      vistos++;
    }
  }
  assert.ok(vistos > 250, `só ${vistos} amostras de emergência: a varredura não cobriu a banda`);

  // E o corpo em caçada: um jogador que desce até a terra sem nome é seguido até a linha e não
  // além dela, com a frase dizendo por quê. Medido tick a tick, porque o que vale não é a decisão
  // do sistema e sim o lugar onde o corpo do gigante esteve em cada quadro.
  const sys = new GOR.GorilaSystem();
  const falas = [];
  const ctx = {
    worldW: CW, worldH: CH, água: RIO, damages: () => true, shake: () => {},
    say: (t) => falas.push(t), play: () => {}, isVisible: () => true, onStructChange: () => {},
  };
  const player = { x: CW / 2, y: -12 };
  ctx.player = player; ctx.worldPosition = player;
  sys.cobra(2);
  let viuFera = false, travessia = 0;
  for (let y = -12; y >= -58; y -= 0.4) {
    player.y = y;
    sys.update(1 / 30, ctx);
    const g = sys.fera;
    if (!g) continue;
    viuFera = true;
    const dele = F.profundidade(g.x, g.y, CW, CH);
    if (dele > LIMITE + 1e-6) travessia++;
  }
  assert.ok(viuFera, 'a caçada nunca levantou um corpo: o acompanhamento do corpo não prova nada');
  assert.equal(travessia, 0, 'o gigante pisou a terra sem nome durante a caçada');
  assert.ok(falas.some((f) => f.includes('terra sem nome')),
    'ele entrou na terra deles sem dizer que parou na borda: a fronteira virou muro invisível');
});

test('uma só mão da posse: nem o guerreiro nem o gigante inventam um teste de pertence', () => {
  for (const importado of ['acampamentoQueRecebe', 'jurisdiçãoDaAldeia', 'FOLGA_DA_JURISDIÇÃO',
    'empurraDoAcampamento']) {
    assert.match(SISTEMA_SRC, new RegExp(`import \\{[\\s\\S]*?\\b${importado}\\b[\\s\\S]*?\\} from '\\.\\./world/Tribo'`),
      `o sistema deixou de perguntar ao território por ${importado}`);
  }
  // O gigante pergunta a MESMA função, e é isso que torna "um ponto, um dono" verdade em vez de
  // duas opiniões parecidas. Os dois nomes vêm de `../world/Tribo` — a ordem em que aparecem no
  // `import` é capricho de quem escreveu, o que importa é a procedência.
  const importaçõesDoTerritório = GORILA_SRC.match(/import \{([^}]*)\} from '\.\.\/world\/Tribo'/g) || [];
  const pedidas = importaçõesDoTerritório.join('\n');
  for (const nome of ['terraDaAldeia', 'expulsaDaClareira']) {
    assert.ok(new RegExp(`\\b${nome}\\b`).test(pedidas),
      `o gigante voltou a ter uma opinião própria sobre ${nome}`);
  }
  assert.match(GORILA_SRC, /const naPisada = prof > 0 && terraDaAldeia\(/,
    'a cobrança do gigante deixou de consultar a posse da terra');
  for (const chamado of ['!naPisada', 'expulsaDaClareira(born', 'expulsaDaClareira(g,']) {
    assert.ok(GORILA_SRC.includes(chamado), `o gigante deixou de aplicar ${chamado}`);
  }
  // O sistema não conhece o `GameState` — o nome pode aparecer em comentário explicando quem faz o
  // quê, mas importar o orquestrador é o sistema voltar a orquestrar o jogo pela porta dos fundos.
  assert.ok(!/from '[^']*GameState'/.test(SISTEMA_SRC), 'o sistema importou o orquestrador');
  assert.ok(!/from '[^']*GameConfig'/.test(SISTEMA_SRC), 'o sistema importou a config do jogo');
  for (const vedado of ['Math.random', 'require(', '.png', 'setTimeout', 'setInterval']) {
    assert.ok(!SISTEMA_SRC.includes(vedado), `TriboSystem usa ${vedado}`);
  }
  assert.deepEqual([...new Set(SISTEMA_SRC.match(/'tribo[A-Za-z]+'|'bodyHit'/g) || [])].sort(),
    ["'bodyHit'", "'triboGrito'", "'triboTambor'"],
    'o sistema pede um som que o jogo não tem (ou perdeu uma das vozes)');
  // A jurisdição é um número publicado, não dois parecidos.
  assert.equal((TRIBO_SRC.match(/FOLGA_DA_JURISDIÇÃO =/g) || []).length, 1,
    'a jurisdição ganhou um segundo dono numérico');
  assert.match(TRIBO_SRC, /if \(água\.isWaterWorld\(x, y\)\) return null;/,
    'a posse voltou a poder cair dentro do canal');
  // Cada estado publicado tem de aparecer na tela, e a régua não é o nome escrito dentro da pose:
  // isso obrigaria o desenho a ter um `if` por estado — inclusive para os estados que são parados
  // por definição, como o sentinela no posto, que é exatamente o quadro 0. A prova é behavioural
  // (`cada estado do contrato aparece numa caçada real e desce para a tela em quadro legal`). Aqui
  // fica só o que é fonte: um estado que nem o sistema nem o modelo escrevem é um branches morto.
  const ESCRITOS = SISTEMA_SRC + '\n' + GUERREIRO_SRC;
  const estados = [...GUERREIRO_SRC.match(/export type GuerreiroEstado =([^;]*);/)[1]
    .matchAll(/'([^']+)'/g)].map((m) => m[1]);
  // A lista é lida da union do modelo, com o tamanho cobrado: um estado novo no tipo sem quadro nem
  // prova passa por aqui antes de passar em qualquer asserção de comportamento.
  assert.equal(estados.length, 10, 'a union de estados mudou de tamanho — a banca precisa de revisão');
  for (const e of estados) {
    assert.ok(ESCRITOS.includes(`'${e}'`), `o estado '${e}' não é escrito por ninguém`);
  }
});

// ===================== fase 4: o cativeiro =====================
//
// O poste, a corda e a janela. As provas daqui são do sistema puro por um motivo e do jogo real por
// outro: o sistema é quem decide quanto a corda segura e o que conta como esforço, então isso é
// medido sem mapa, sem sprite e sem joystick; se o manche chega até ele, e para onde o corpo vai
// quando a janela fecha, é costura — e costura só é provada no `GameState` de verdade, lá embaixo.
const CAT = load(path.join(root, 'src/systems/CativeiroSystem.ts'));
const CAT_SRC = fs.readFileSync(path.join(root, 'src/systems/CativeiroSystem.ts'), 'utf8');

/**
 * O mundo mínimo do poste: um acampamento, os dois relógios e o diário do que ele pediu. Repare no
 * que NÃO existe aqui: não há `arrasta`, não há coordenada do prisioneiro. O cativeiro não tem porta
 * para mover corpo, e é por isso que a amarra não briga com o colisor.
 */
function cativeiroEm(ac, opts = {}) {
  const diary = { ditos: [], tocados: [], expulsou: 0, acordou: [], tremores: 0 };
  const ctx = {
    player: opts.indoors ? null : { x: ac.poste.x, y: ac.poste.y },
    aPé: () => (opts.aPé === undefined ? true : opts.aPé),
    acorda: (id) => { diary.acordou.push(id); },
    expulsa: () => { diary.expulsou++; },
    say: (t) => { diary.ditos.push(t); },
    play: (k) => { diary.tocados.push(k); },
    shake: () => { diary.tremores++; },
  };
  const sys = new CAT.CativeiroSystem();
  sys.amarra(ac);
  const dt = 1 / 30;
  /** Anda `s` segundos, entregando ao manche a leitura que o gesto pede, e para se a cena acabar. */
  const anda = (s, sinal) => {
    let q = 0;
    for (; q < Math.round(s / dt) && sys.amarrado; q++) {
      if (sinal) sys.puxa(sinal(q * dt));
      sys.update(dt, ctx);
    }
    return q;
  };
  /** O mesmo, sem parar quando a corda cede — para as provas que medem o depois. */
  const andaTudo = (s, sinal) => {
    const n = Math.round(s / dt);
    for (let q = 0; q < n; q++) {
      if (sinal) sys.puxa(sinal(q * dt));
      sys.update(dt, ctx);
    }
    return n;
  };
  return { sys, ctx, diary, anda, andaTudo, ac, batidas: () => diary.tocados.filter((k) => k === 'bodyHit').length };
}

/** O puxão honesto: o manche troca de lado `f` vezes por segundo, saltando de um canto ao outro. */
const vaiEVolta = (f) => (t) => (Math.floor(t * f) % 2 === 0 ? 1 : -1);
/** O puxão de verdade: varre o centro entre um lado e outro, `f` viradas por segundo. */
const varreCentro = (f) => (t) => Math.sin(t * f * Math.PI);

test('a janela do poste É o prazo da saciedade: importado, medido e não repetido', () => {
  const C = cativeiroEm(NOSSO_AC);
  const quadros = C.anda(120, null);
  const segundos = quadros / 30;
  assert.ok(Math.abs(segundos - S.PRAZO_DA_SACIEDADE) <= 1 / 30 + 1e-9,
    `o poste segurou um corpo parado por ${segundos.toFixed(2)} s e o bando fica satisfeito por ${S.PRAZO_DA_SACIEDADE}`);
  assert.equal(C.diary.expulsou, 1, 'a janela fechou sem que o corpo fosse posto para fora');
  assert.equal(C.diary.acordou.length, 0, 'a janela fechou acordando o bando: são dois donos para o mesmo relógio');
  assert.equal(C.sys.amarrado, false, 'vinte e cinco segundos depois o jogo ainda acha alguém amarrado');
  // E a fonte: um `25` escrito aqui é o dia em que as duas metades do lugar passam a discordar, com o
  // número de uma delas escondido dentro de uma constante de outro arquivo.
  assert.match(CAT_SRC, /janela = PRAZO_DA_SACIEDADE/,
    'a janela voltou a ser um número próprio e não o prazo do bando');
  assert.ok(!/=\s*25\b/.test(CAT_SRC), 'o cativeiro escreveu 25 em algum lugar');
});

test('a corda cede com o debate e recalca com a pausa: parado, devagar e rápido', () => {
  // Parado: o nó aperta, e uma corda que cedesse sozinha faria do minigame uma tela de carregamento.
  const parado = cativeiroEm(NOSSO_AC);
  parado.andaTudo(60, null);
  assert.equal(parado.diary.acordou.length, 0, 'o corpo parado se soltou: a fuga não é um esforço');
  assert.equal(parado.diary.expulsou, 1, 'parado 60 s e a cena não terminou em expulsão');

  // Um puxão por segundo: honesto, e insuficiente. É a aritmética que faz da janela uma janela —
  // cada virada tira 0,075 e o nó recalca 0,05 por segundo, então sobram 0,025 de corda perdida por
  // segundo, e os vinte e cinco segundos de prazo compram cinco oitavos de uma corda inteira.
  const devagar = cativeiroEm(NOSSO_AC);
  devagar.anda(60, vaiEVolta(1));
  assert.equal(devagar.diary.acordou.length, 0, 'um puxão por segundo derruba uma corda de vinte e cinco segundos: não há prazo');
  assert.equal(devagar.diary.expulsou, 1, 'devagar demais para fugir e ainda assim solto');

  // Três por segundo: a corda arrebenta antes do prazo, e quem acorda é o bando.
  const rápido = cativeiroEm(NOSSO_AC);
  const q = rápido.anda(60, vaiEVolta(3));
  assert.ok(q / 30 < S.PRAZO_DA_SACIEDADE - 1,
    `três puxões por segundo só soltaram o corpo no segundo ${(q / 30).toFixed(1)} — a régua está frouxa`);
  assert.deepEqual(rápido.diary.acordou, [NOSSO_AC.id],
    'a corda arrebentou e o bando da mesma clareira não foi chamado de volta');
  assert.equal(rápido.diary.expulsou, 0, 'livre pela corda e expulso pela janela: as duas saídas na mesma cena');
  assert.ok(rápido.diary.tocados.includes('triboGrito'), 'o estalo da corda não foi ouvido pelo lugar');
});

test('o esforço é a virada do manche: segurar no canto, passar pelo centro e o morto do stick', () => {
  // Segurar no canto é polegar descansando. Se o módulo do manche contasse, um dedo colado no vidro
  // seria uma fuga — e é exatamente o atalho que um jogador acha no primeiro segundo de minigame.
  const colado = cativeiroEm(NOSSO_AC);
  colado.andaTudo(20, () => 1);
  assert.equal(colado.batidas(), 0, 'o manche colado num lado rangeu a corda: está contando magnitude, e não virada');
  assert.equal(colado.diary.acordou.length, 0, 'dedo colado libertou o prisioneiro');

  // O gesto real varre o centro: um corpo amarrado não salta de um canto do manche ao outro, ele
  // balança, e o balanço passa por zero. Se o centro desarmasse a memória do lado, cada ida-e-volta
  // contaria zero e ninguém nunca sairia do poste.
  const centro = cativeiroEm(NOSSO_AC);
  centro.anda(8, varreCentro(3));
  assert.ok(centro.batidas() >= 3,
    `o vai-e-volta pelo centro só rangeu ${centro.batidas()} vezes em oito segundos: a virada está sendo perdida`);

  // E o morto do stick: tremor de dedo não abre corda.
  const tremido = cativeiroEm(NOSSO_AC);
  tremido.andaTudo(20, (t) => Math.sin(t * 60) * 0.2);
  assert.equal(tremido.batidas(), 0, 'o manche dentro do morto do puxão rangeu a corda');
  assert.equal(tremido.diary.acordou.length, 0, 'tremor de polegar libertou o prisioneiro');
});

test('as legendas do cativeiro: o preço é lido antes da instrução, e cada faixa fala uma vez', () => {
  const C = cativeiroEm(NOSSO_AC);
  // O `say` da entrega é escrito no mesmo tick em que a amarra começa, e a legenda do jogo é um slot
  // só. Falasse na hora, "levaram X de você" nunca seria lido — por isso a instrução espera.
  C.sys.update(1 / 30, C.ctx);
  assert.equal(C.diary.ditos.length, 0, 'a instrução atropelou a frase do preço no mesmo tick da entrega');
  C.andaTudo(2, null);
  const instrução = C.diary.ditos.filter((t) => /poste/.test(t) && /manche/.test(t));
  assert.equal(instrução.length, 1, `a instrução foi dita ${instrução.length} vezes: ou atrasou, ou se repete a cada quadro`);
  // As faixas: uma frase por quarto de corda, e nenhuma frase duas vezes.
  const rápido = cativeiroEm(NOSSO_AC);
  rápido.anda(60, vaiEVolta(3));
  const meios = rápido.diary.ditos.filter((t) => /corda|nó/.test(t));
  assert.equal(meios.length, 3, `a corda falou ${meios.length} vezes em uma fuga completa — são três quartos antes do estalo`);
  assert.equal(new Set(meios).size, 3, 'a mesma faixa de corda foi dita duas vezes');
  assert.ok(rápido.diary.ditos.some((t) => /arrebentad/i.test(t)), 'a corda arrebentou sem que a tela dissesse');
});

test('a amarra não briga com o colisor: nenhum tique escreve o corpo, e o empurrão não tem o que empurrar', () => {
  // A porta não existe: sem `arrasta` no contexto, o sistema não tem como escrever coordenada.
  assert.ok(!/\barrasta\b/.test(CAT_SRC), 'o cativeiro voltou a ter uma porta de coordenada');
  assert.ok(!/player\.(x|y)\s*[-+*/]?=/.test(CAT_SRC), 'o cativeiro escreve na coordenada do jogador');
  assert.ok(!/Math\.random/.test(CAT_SRC), 'o cativeiro sorteia: a corda tem de ser a mesma régua para todo mundo');

  // E o ponto da amarra, medido em TODOS os acampamentos dos dois seeds com o colisor rodando:
  // encostado no poste é fora do poste, então o empurrão devolve o corpo intacto. É isto que dispensa
  // o `for` que reescreveria a posição todo quadro — o braço de borracha que o transporte já pagou.
  let conferidos = 0;
  for (const ac of ACAMPAMENTOS) {
    const nó = T.pontoDaAmarra(ac, GAME_CONFIG.PLAYER_RADIUS);
    const corpo = { x: nó.x, y: nó.y, radius: GAME_CONFIG.PLAYER_RADIUS };
    const tocado = T.empurraDoAcampamento(corpo, CW, CH, RIO);
    assert.equal(corpo.x, nó.x, `${conferidos}: o colisor moveu o corpo no eixo X — a amarra escreve coordenada para compensar`);
    assert.equal(corpo.y, nó.y, `${conferidos}: o colisor moveu o corpo no eixo Y`);
    assert.equal(tocado, false, `${conferidos}: o corpo amarrado foi considerado dentro de um pino`);
    conferidos++;
  }
  assert.ok(conferidos > 8, `só ${conferidos} acampamentos conferidos — a régua não varreu o mundo`);

  // O outro lado da mesma decisão: rodando o sistema por uma janela inteira com o colisor no meio de
  // cada quadro, o corpo não sai do lugar um milímetro. É `seguraNaFronteira` quem roda, e não o
  // empurrão da cabana sozinho, porque a guarda da fronteira já chama os dois colisores do mundo —
  // tronco e acampamento — na ordem exata em que o `GameState` os chama. Um `arrasta` do cativeiro
  // seria desfazido aqui, no mesmo quadro, e é isto que esta linha prova: não há o que desfazer.
  const ac = NOSSO_AC;
  const nó = T.pontoDaAmarra(ac, GAME_CONFIG.PLAYER_RADIUS);
  const corpo = { x: nó.x, y: nó.y, radius: GAME_CONFIG.PLAYER_RADIUS };
  const C = cativeiroEm(ac);
  for (let q = 0; q < 30 * 12; q++) {
    C.sys.update(1 / 30, C.ctx);
    F.seguraNaFronteira(corpo, CW, CH, RIO);
  }
  assert.equal(corpo.x, nó.x, 'doze segundos de colisor moveram o prisioneiro no eixo X');
  assert.equal(corpo.y, nó.y, 'doze segundos de colisor moveram o prisioneiro no eixo Y');
  assert.equal(C.sys.amarrado, true, 'doze segundos de espera soltaram a corda');
});

test('dentro de casa o poste não afrouxa: a sala para a janela, a corda e o esforço', () => {
  const C = cativeiroEm(NOSSO_AC, { indoors: true });
  C.andaTudo(40, vaiEVolta(3));
  assert.equal(C.sys.amarrado, true, 'entrar numa sala afrouxou a corda: a fuga seria pelo banheiro');
  assert.equal(C.diary.ditos.length, 0, 'dentro de casa o cativeiro falou com o prisioneiro');
  assert.equal(C.diary.tocados.length, 0, 'dentro de casa a corda rangeu');
  // E o relógio da janela também parou: devolve o corpo à rua e ele ainda tem a janela inteira.
  C.ctx.player = { x: NOSSO_AC.poste.x, y: NOSSO_AC.poste.y };
  const sobra = C.anda(60, null);
  assert.ok(Math.abs(sobra / 30 - S.PRAZO_DA_SACIEDADE) <= 1 / 30 + 1e-9,
    `a janela voltou a correr com ${sobra / 30} s: quarenta segundos dentro de casa comeram o prazo`);
  // O terceiro relógio parado é o do esforço. Quarenta segundos de polegar dentro de uma sala são
  // cento e vinte viradas que a corda nunca viu: se ficassem guardados para o próximo quadro na
  // rua, a fuga seria comprada no banheiro e o minigame inteiro deixaria de existir.
  assert.equal(C.diary.expulsou, 1, 'a sala virou atalho: o corpo saiu do poste pela corda, não pela janela');
  assert.equal(C.diary.acordou.length, 0, 'o bando foi acordado por uma fuga que aconteceu dentro de uma loja');
});

// ===================== fase 3c: o orquestrador de verdade =====================
//
// Tudo acima prova o sistema. Esta parte prova a costura, e por isso roda o `GameState` real, não um
// resumo dele: a frase do pedido é "GameState só orquestra", e uma régua de texto passaria com a
// chamada movida para antes da separação de corpos, com o `arrasta` escrevendo em outra entidade, ou
// com o `aPé` devolvendo `true` para um motorista — três maneiras de ligar tudo errado sem apagar
// linha alguma. Então o que segue é o jogo de verdade: o mundo gerado, o manpower do dia, o tique a
// tique, e o bando cobrando dentro dele.
//
// O `sound` e a store saem do caminho por dublô: o alto-falante grava o que tocou (é assim que a
// banca ouve o grito) e a interface guarda o que o jogo mandou dizer. Nada disso é comportamento do
// bando — é exatamente a borda que o contexto entrega.

const TOCADOS = [];

// As duas bordas que o `GameState` toca fora da simulação. O alto-falante grava a tecla tocada — é
// assim que a banca ouve o grito — e a interface guarda o que o jogo mandou dizer. Uma store que
// abre o menu no meio da caçada mudaria o tique, então ela é congelada em "jogo rodando, nada
// aberto": o estado que o jogador vê na clareira.
const UI = { paused: false, mapOpen: false, shopOpen: false, departuresOpen: false,
  overlay: null, mapMarker: null, mapRoute: [] };
dubles.set('audio/SoundManager.ts', { sound: { play: (tecla) => TOCADOS.push(tecla),
  ambient: () => {}, weather: () => {}, setLoop: () => {}, stopLoops: () => {},
  suspend: () => {}, unlock: () => {}, setMuted: () => {}, isUnlocked: true } });
dubles.set('stores/useGameStore.ts', { useGameStore: { getState: () => UI,
  clearMapMarker: () => {}, refreshMapRoute: () => {}, showOverlay: (kind) => { UI.overlay = kind; },
  openShop: () => {}, closeShop: () => {}, openDepartures: () => {}, closeDepartures: () => {} } });

const JOGO = load(path.join(root, 'src/game/GameState.ts'));
const input = load(path.join(root, 'src/game/InputState.ts'));
const { createVehicle } = load(path.join(root, 'src/entities/Vehicle.ts'));
const { VEHICLE_DEFS } = load(path.join(root, 'src/data/vehicles.ts'));
const GS_SRC = fs.readFileSync(path.join(root, 'src/game/GameState.ts'), 'utf8');
const SOUNDS_SRC = fs.readFileSync(path.join(root, 'src/audio/sounds.ts'), 'utf8');
const GITIGNORE_SRC = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');

const ALDEIA = ACAMPAMENTOS[0];

/**
 * O jogo parado numa clareira, com a caçada inteira rodando dentro dele.
 *
 * Não é uma instância só para todas as provas: desde a fase 4, capturar **muda** o jogo — o
 * prisioneiro fica amarrado, o manche deixa de andar e um relógio de vinte e cinco segundos começa a
 * correr. Quem prova a tranca do arrasto precisa de um jogo em que ninguém foi amarrado ainda, e
 * fingir isso resetando campos privados do cativeiro seria a prova mais fraca do arquivo. Cada prova
 * de comportamento paga um construtor; as que só leem código não pagam nada.
 *
 * Os quadros são contados e medidos na porta do tique do bando — o instante em que `handleMovement`
 * já decidiu para onde o manche leve o corpo e o sistema ainda não escreveu nada. É o único ponto de
 * leitura em que a tranca do prisioneiro é visível: depois do arrasto, a coordenada e a velocidade
 * estão zeradas dos dois jeitos, com tranca e sem ela.
 */
function caçadaReal() {
  const g = new JOGO.GameState();
  // Trânsito, polícia e pedestres não são o assunto e só atrasariam o tique; a fronteira, o gigante
  // e o bando ficam de pé — o gigante não entra aqui (#222) e é justamente isso que deixa a clareira
  // ser medida sem uma fera no meio.
  g.police.update = () => {};
  g.trafficSystem.update = () => {};
  g.npcSystem.update = () => {};
  g.npcs = [];
  g.vehicles = [];
  const diário = { naPorta: [] };
  // As legendas desta partida, e não uma pilha global: "o jogo disse esta frase" só prova algo se o
  // `some` não estiver pescando a fala de um jogo anterior.
  const ditos = [];
  g.interiors.say = (texto) => { ditos.push(texto); };
  const tiqueReal = g.tribos.update.bind(g.tribos);
  g.tribos.update = (dt, ctx) => {
    const p = ctx.player;
    diário.naPorta.push(p ? { vx: p.vx, vy: p.vy, speed: p.speed, swimming: p.swimming,
      arrastado: g.tribos.arrastado, carrega: !!g.tribos.guerreiros.some((x) => x.carrega) } : null);
    return tiqueReal(dt, ctx);
  };
  g.player.x = ALDEIA.entrada.x;
  g.player.y = ALDEIA.entrada.y;
  g.player.health = 40;
  g.player.money = 400;
  g.player.stamina = 1;
  return { g, diário, ditos };
}

test('o GameState real chama o bando: o grito sai pelo alto-falante do jogo e a entrega cobra', () => {
  const { g, ditos } = caçadaReal();
  assert.ok(g.tribos instanceof S.TriboSystem, 'o orquestrador não tem um bando para tiquear');
  const dt = 1 / 30;
  let embarcou = -1, entregue = -1;
  for (let q = 0; q < 30 * 70; q++) {
    g.update(dt);
    if (embarcou < 0 && g.tribos.arrastado) embarcou = q;
    if (g.player.money !== 400) { entregue = q; break; }
    assert.ok(g.player.health > 0, `o jogador morreu na clareira no quadro ${q} — a captura não é morte`);
  }
  assert.ok(embarcou >= 0, 'setenta segundos de clareira e ninguém nunca carregou o corpo no jogo real');
  assert.ok(entregue > embarcou, `carregado no quadro ${embarcou} e nunca entregue ao poste`);
  const levado = 400 - g.player.money;
  assert.equal(levado, Math.ceil(400 * 0.25), `a captura cobrou ${levado} de 400 — não são 25% do bolso`);
  assert.ok(ditos.some((t) => t.includes('Levaram') && t.includes(String(levado))),
    'a captura aconteceu sem que o jogo dissesse o preço: o sequestro virou teleporte');
  // Entregue amarrado ao poste, vivo, e com a vida exatamente onde o abolo parou — as duas réguas do
  // sistema valendo dentro do orquestrador, não só no banco de provas.
  const nó = T.pontoDaAmarra(ALDEIA, GAME_CONFIG.PLAYER_RADIUS);
  assert.ok(Math.hypot(g.player.x - nó.x, g.player.y - nó.y) < 1e-9,
    'o prisioneiro foi largado fora do ponto da amarra');
  assert.ok(g.player.health >= GUER.GUERREIRO_DANO,
    `entregaram o corpo com ${g.player.health.toFixed(1)} de vida: abaixo de uma martelada é execução`);
  assert.ok(TOCADOS.includes('triboGrito'), 'o grito do bando nunca passou pelo som do jogo');
  assert.equal(g.tribos.arrastado, false, 'entregue o corpo, o jogo ainda tem alguém na ponta da corda');

  // A volta à calma medida pelo jogo inteiro, não pelo banco: fora do terreiro de qualquer aldeia,
  // sem corpo para carregar, a leitura que a HUD faz do bando tem de descer a zero. Cobrar
  // `perigo === 0` no QUADRO da entrega seria cobrar que um guerreiro feche os olhos para quem está
  // no meio do terreiro dele — medido: no mesmo tique em que o poste recebe o corpo, um par de
  // olhos que ainda o vê soma `dt * 3` na alerta da banda.
  const calmaria = { x: ALDEIA.x + 1.6 * ALDEIA.meiaLargura, y: ALDEIA.y };
  assert.equal(T.acampamentoQueRecebe(calmaria.x, calmaria.y, CW, CH, RIO), null,
    'a amostra de calmaria é terra de alguma aldeia: a medição não seria de volta à calma');
  g.player.x = calmaria.x;
  g.player.y = calmaria.y;
  let acalmou = -1;
  for (let q = 0; q < 30 * 40 && acalmou < 0; q++) {
    g.update(dt);
    if (g.tribos.perigo === 0) acalmou = q;
  }
  assert.ok(acalmou >= 0, `quarenta segundos fora da posse e a HUD ainda acusa perigo ${g.tribos.perigo}`);
  assert.equal(g.tribos.aldeiaEmDisputa(), null, 'a aldeia continuou brigando com quem já foi embora');
});

test('o manche não empurra o prisioneiro: no tique do bando a velocidade do stick é zero', () => {
  const { g, diário } = caçadaReal();
  const dt = 1 / 30;
  // O corpo é posto sob um carregador de verdade, no quadro seguinte ao da entrega: a banda está
  // satisfeita, mas o gesto de carregar é o mesmo que a tranca olha, e é ele que está sob prova.
  g.player.x = ALDEIA.entrada.x;
  g.player.y = ALDEIA.entrada.y;
  g.player.health = 40;
  let sobe = false;
  for (let q = 0; q < 30 * 70 && !sobe; q++) {
    g.update(dt);
    sobe = g.tribos.arrastado;
  }
  assert.ok(sobe, 'ninguém carrega o corpo no jogo real — a tranca não teria o que fechar');
  // Manche colado no fundo, correndo, por oito quadros. O que se cobra não é o lugar a que ele chega
  // (o arrasto reescreve o lugar de qualquer jeito), e sim o que o corpo leva até a porta do tique.
  input.setJoystickInput(1, 0, 1);
  input.setRunHeld(true);
  const lidos = [];
  for (let q = 0; q < 8; q++) {
    g.update(dt);
    lidos.push(diário.naPorta[diário.naPorta.length - 1]);
  }
  assert.ok(lidos.every((p) => p && p.arrastado), 'o arrasto caiu no meio da medição: a tranca não esteve fechada');
  for (const p of lidos) {
    assert.equal(p.vx, 0, 'o manche empurrou o prisioneiro no eixo X antes do tique do bando');
    assert.equal(p.vy, 0, 'o manche empurrou o prisioneiro no eixo Y antes do tique do bando');
    assert.equal(p.speed, 0, 'o prisioneiro ganhou velocidade de corrida debaixo do arrasto');
  }
  // E o cansaço: o ramo do prisioneiro chama o fôlego SEM esforço, de propósito — a perna que se
  // move é a de quem puxa. Medido no mesmo intervalo: sem a tranca, correr comeria o fôlego.
  assert.ok(g.player.stamina >= 1 - 1e-9, 'o prisioneiro se cansou de correr contra uma corda');

  // Controle: o MESMO manche, no MESMO lugar, sem ninguém carregando. Se aqui a porta também lesse
  // zero, as três asserções de cima seriam uma conta sobre um número morto.
  for (const x of g.tribos.guerreiros) x.carrega = false;
  g.player.stamina = 1;
  g.update(dt);
  const livre = diário.naPorta[diário.naPorta.length - 1];
  assert.equal(livre.arrastado, false, 'ainda havia carregador no quadro de controle');
  assert.ok(Math.abs(livre.vx) > 1e-6, 'o manche colado não chegou ao tique nem sem a tranca: a medição é cega');
  assert.ok(livre.speed > 0, 'sem carregador o corpo não andou: o joystick está desligado do jogo');
});

test('quem sobe num carro no meio do arrasto solta o corpo: a clareira não proibe estacionar', () => {
  const { g } = caçadaReal();
  const dt = 1 / 30;
  input.resetJoystickInput();
  input.setRunHeld(false);
  g.player.x = ALDEIA.entrada.x;
  g.player.y = ALDEIA.entrada.y;
  g.player.health = 40;
  let carregador = null;
  for (let q = 0; q < 30 * 70 && !carregador; q++) {
    g.update(dt);
    carregador = g.tribos.guerreiros.find((x) => x.carrega) ?? null;
  }
  assert.ok(carregador, 'a segunda amostra nunca teve quem carregasse o corpo');
  // O carro é o do jogo: entra pelo `VehicleSystem`, com o jogador sentado dentro, exatamente como
  // no atropelamento de rua. É o único jeito de o `aPé` do contexto ser testado por fora dele.
  const carro = createVehicle(9404, VEHICLE_DEFS.sedan, 'red', g.player.x, g.player.y, 'SE');
  g.vehicles = [carro];
  g.vehicleSystem.enterVehicle(g.player, carro);
  assert.equal(g.player.currentVehicleId, carro.id, 'o jogador não entrou no carro');
  g.update(dt);
  assert.equal(g.tribos.arrastado, false, 'o corpo continuou na corda depois de subir num carro');
  assert.equal(g.tribos.guerreiros.some((x) => x.carrega), false,
    'sobrou um guerreiro carregando alguém que já dirige');
  assert.equal(carregador.carrega, false, 'quem puxava não soltou a amarra');
  assert.equal(carregador.estado, 'perseguindo', 'o gesto de carregar terminou em outro lugar do contrato');
  assert.ok(Math.hypot(g.player.x - carro.x, g.player.y - carro.y) < 1e-9,
    'libertado o corpo, ele ficou preso na corda em vez de ir com o carro');
  g.vehicleSystem.exitVehicle(g.player, carro);
  g.vehicles = [];
});

/**
 * Leva o corpo até o poste pelo jogo inteiro, sem atalho: a caçada, o arrasto e a entrega. Devolve o
 * quadro em que a amarra começou, ou `-1` se o jogo matou o jogador antes. É a única maneira de as
 * provas do cativeiro começarem do mesmo lugar em que o jogador começaria.
 */
function atéAmarra(g, dt) {
  for (let q = 0; q < 30 * 70; q++) {
    g.update(dt);
    if (g.cativeiro.amarrado) return q;
    if (g.player.health <= 0) return -1;
  }
  return -1;
}

test('a fuga do poste passa pelo manche do jogo: a virada real arrebenta a corda e acorda o bando antes do prazo', () => {
  const { g, ditos } = caçadaReal();
  const dt = 1 / 30;
  input.resetJoystickInput();
  input.setRunHeld(false);
  input.resetActionInput?.();

  const amarra = atéAmarra(g, dt);
  assert.ok(amarra >= 0, 'setenta segundos de clareira e o jogo nunca amarrou ninguém ao poste');
  assert.equal(g.tribos.arrastado, false, 'amarrado ao poste e ainda há um carregador no mundo');
  const nó = T.pontoDaAmarra(ALDEIA, GAME_CONFIG.PLAYER_RADIUS);
  assert.ok(Math.hypot(g.player.x - nó.x, g.player.y - nó.y) < 1e-9,
    'o cativeiro começou com o corpo fora do ponto da amarra');
  // A calma que a entrega publicou: sem ela, a leitura de baixo não distinguiria bando satisfeito
  // de bando que simplesmente ainda não viu ninguém.
  assert.equal(g.tribos.perigo, 0, 'recém-entregue e o bando já olhava para o poste');

  // O manche do jogo não empurra quem está no poste. Aqui a régua é o LUGAR, e não a velocidade lida
  // na porta do tique como na prova do arrasto: no arrasto havia outro escrevendo a coordenada e
  // restava medir o impulso, aqui o único candidato a mover o corpo é o joystick — então o corpo
  // parado é a prova, e um `else if` esquecido no ramo do cativeiro moveria este corpo.
  input.setJoystickInput(1, 0, 1);
  input.setRunHeld(true);
  // Um segundo e meio de manche colado no canto, correndo. A régua é o lugar, quadro a quadro, e o
  // intervalo é mais longo que o silêncio deliberado da instrução de propósito: a legenda do jogo é um
  // slot só, a frase do preço foi escrita no quadro do nó, e é aqui dentro que as duas têm de caber —
  // cobrar a instrução antes do silêncio terminar seria cobrar que ela atropelasse o preço.
  const TRANCA = 45;
  for (let q = 0; q < TRANCA; q++) {
    g.update(dt);
    assert.ok(g.cativeiro.amarrado, `a corda cedeu em ${q / 30} s de manche colado num lado só`);
    assert.equal(g.player.x, nó.x, `o manche colado moveu o prisioneiro no eixo X no quadro ${q}`);
    assert.equal(g.player.y, nó.y, `o manche colado moveu o prisioneiro no eixo Y no quadro ${q}`);
  }
  const preço = ditos.findIndex((t) => /Levaram/.test(t));
  const instrução = ditos.findIndex((t) => /bate o manche/.test(t));
  assert.ok(instrução >= 0, 'o jogo amarrou o corpo e nunca disse, pela legenda dele, como se solta');
  assert.ok(preço >= 0 && preço < instrução,
    `a instrução chegou antes do preço (dita no dito ${instrução}, preço no ${preço}): as duas frases disputando o mesmo slot, e o jogador perde a que tem o número`);
  // O segundo dono do relógio, lido pela mesma porta da HUD: um bando satisfeito não acumula a vista
  // que o quadro em que ele foi satisfeito ainda teve. Sem isto, a asserção de baixo — "ele acordou em
  // fração de segundo" — poderia ser apenas um resto de alerta que nunca chegou a zero.
  assert.equal(g.tribos.stats().alerta, 0, 'um bando satisfeito ainda acumulando a vista do quadro da entrega');

  // O esforço entra pelo manche de verdade: quem chama `puxa` é o `handleMovement`, com o
  // `inputState.dx` que o jogo recebe. Nenhuma prova aqui toca o sistema à mão.
  let soltoNo = -1;
  for (let q = 0; q < 30 * 24; q++) {
    input.setJoystickInput(Math.floor(q / 10) % 2 === 0 ? 1 : -1, 0, 1);
    g.update(dt);
    if (!g.cativeiro.amarrado) { soltoNo = q; break; }
  }
  input.resetJoystickInput();
  input.setRunHeld(false);
  assert.ok(soltoNo >= 0, 'vinte e quatro segundos de vaivém e o corpo continua no poste: o manche não chega ao cativeiro');
  // O relógio do cativeiro corre desde o quadro do nó, e os quarenta e cinco quadros de manche colado
  // que provaram a tranca também foram gastos dele.
  const desdeONó = (TRANCA + soltoNo) / 30;
  assert.ok(desdeONó < S.PRAZO_DA_SACIEDADE - 10,
    `a corda só arrebentou ${desdeONó.toFixed(1)} s depois da entrega, e o prazo é ${S.PRAZO_DA_SACIEDADE}: foi a janela que venceu, não o esforço`);
  assert.ok(ditos.some((t) => /Corda arrebentada/.test(t)), 'a corda arrebentou no jogo sem que a tela dissesse');
  assert.ok(!ditos.some((t) => /puseram para fora da clareira/.test(t)),
    'a fuga pela corda terminou em expulsão: as duas saídas do poste se confundiram');

  // E o corpo volta a obedecer ao manche: solto, o ramo do poste tem de sair do caminho. Medido aqui,
  // antes da acordada, porque depois dela há porrete batendo e meio tile de recuo no corpo — e um
  // corpo empurrado por eles não é a mesma conta que um corpo andado por você.
  const antes = { x: g.player.x, y: g.player.y };
  input.setJoystickInput(1, 0, 1);
  for (let q = 0; q < 20; q++) g.update(dt);
  input.resetJoystickInput();
  assert.ok(Math.hypot(g.player.x - antes.x, g.player.y - antes.y) > 0.05,
    'livre da corda e o manche continua sem mover o corpo: a tranca não abriu');

  // A porta do `acorda`, medida pelo relógio do lugar e não pela sorte da ronda. Entregue o corpo, o
  // bando fica satisfeito vinte e cinco segundos, e no poste ele está às costas de toda sentinela — a
  // fase 3 documenta por quê: o cone do posto gira em torno do normal de SAÍDA do trilho, porque é
  // para a mata que eles vigiam. Então a prova não pede que o bando olhe para o poste; ela põe o
  // corpo livre na cara de um posto, o mesmo ponto que a fase 3 usa, e cobra que aquele olho funcione
  // antes do prazo. Sem a porta, o mesmo ponto, o mesmo olho e o mesmo quadro não acordariam nada —
  // é literalmente a asserção espelhada, lá em cima, na prova da volta à calma.
  const eixo = cordaLimpa(ALDEIA);
  assert.ok(eixo, 'nenhum posto da aldeia tem corda limpa: a porta do cativeiro não teria olho para acordar');
  g.player.x = eixo.fora.x;
  g.player.y = eixo.fora.y;
  assert.equal(T.jurisdiçãoDaAldeia(ALDEIA, g.player.x, g.player.y), true,
    'a cara do posto para onde o corpo foi posto já não é terra deles');
  const calmaQueElesDeviam = S.PRAZO_DA_SACIEDADE - desdeONó;
  let acordou = -1;
  for (let q = 0; q < 30 * 6 && acordou < 0; q++) {
    g.update(dt);
    if (g.tribos.perigo > 0) acordou = q;
  }
  assert.ok(acordou >= 0, `seis segundos na cara de um posto e ninguém olhou: o cativeiro não devolveu a visão ao bando (a calma dele duraria mais ${calmaQueElesDeviam.toFixed(1)} s)`);
  assert.ok(acordou / 30 < calmaQueElesDeviam - 5,
    `o bando acordou ${acordou / 30} s depois da fuga, quando a calma dele ainda duraria ${calmaQueElesDeviam.toFixed(1)} s: foi o prazo vencendo, não a porta do cativeiro`);
});

test('a janela que fecha põe o corpo para fora da clareira: vivo, mais pobre e sem acordar o bando', () => {
  const { g, ditos } = caçadaReal();
  const dt = 1 / 30;
  input.resetJoystickInput();
  input.setRunHeld(false);
  const amarra = atéAmarra(g, dt);
  assert.ok(amarra >= 0, 'o jogo nunca amarrou ninguém: a expulsão não teria de onde acontecer');
  const bolso = g.player.money;
  assert.ok(g.player.health > 0, 'amarrado e morto: o cativeiro é execução');

  // O corpo parado espera a janela inteira. É exatamente o desfecho que a falha tem de ter: ninguém
  // morre no poste, e a terceira opção — apanhar até morrer sem poder sair — é a morte inevitável
  // que este mundo existe para não ter.
  let fechou = -1;
  for (let q = 0; q < 30 * (S.PRAZO_DA_SACIEDADE + 5); q++) {
    g.update(dt);
    if (!g.cativeiro.amarrado) { fechou = q; break; }
  }
  assert.ok(fechou >= 0, 'trinta segundos de poste e o jogo ainda acha alguém amarrado');
  // A janela começa no quadro em que o corpo é atado — e esse quadro já gasta um dt dela, e a contagem
  // abaixo é de quadros lidos, 0-indexada. Dois terços de quadro de tolerância, e não um número solto:
  // é o preço exato de as duas bordas da medição serem quadros inteiros.
  const esperados = S.PRAZO_DA_SACIEDADE - 2 / 30;
  assert.ok(Math.abs(fechou / 30 - esperados) <= 1 / 30,
    `a janela fechou em ${fechou / 30} s e o prazo, contado do nó, é ${esperados.toFixed(4)} s`);
  assert.ok(g.player.health > 0, 'a janela fechou matando o prisioneiro: cativeiro é expulsão, não enforcamento');
  assert.equal(g.player.money, bolso, 'a expulsão cobrou o preço de novo: a mesma captura duas vezes');
  assert.ok(ditos.some((t) => /puseram para fora da clareira/.test(t)),
    'o corpo saiu da clareira sem que o jogo dissesse por quê');
  assert.ok(!ditos.some((t) => /Corda arrebentada/.test(t)), 'a janela fechou contando como corda arrebentada');

  // Fora da posse, e fora pela borda: a mesma régua do gigante, com o corpo a um passo da elipse e
  // não largado em algum lugar do mapa.
  assert.equal(T.acampamentoQueRecebe(g.player.x, g.player.y, CW, CH, RIO), null,
    'expulso do poste e ainda em terra de aldeia: a expulsão não expulsou');
  const u = (g.player.x - ALDEIA.x) / ALDEIA.meiaLargura;
  const v = (g.player.y - ALDEIA.y) / ALDEIA.meiaAltura;
  const ρ = Math.hypot(u, v);
  assert.ok(ρ > 1, `o corpo ficou a ${ρ.toFixed(3)} de raio normalizado: dentro da elipse`);
  assert.ok(ρ < 1.6, `o corpo foi largado a ${ρ.toFixed(2)} de raio normalizado: isso é teleporte, não expulsão`);
  assert.equal(g.tribos.aldeiaEmDisputa(), null, 'expulso pela janela e o bando entrou em disputa: a calma não foi respeitada');

  // A tranca abriu: o mesmo manche que não o moveu no poste agora o move na mata.
  const antes = { x: g.player.x, y: g.player.y };
  input.setJoystickInput(1, 0, 1);
  for (let q = 0; q < 20; q++) g.update(dt);
  input.resetJoystickInput();
  assert.ok(Math.hypot(g.player.x - antes.x, g.player.y - antes.y) > 0.05,
    'expulso da clareira e o manche continua travado: a saída do cativeiro não devolveu o corpo ao jogador');
});

test('a banca de armas e o porrete batem no guerreiro pela porta do dono do corpo', () => {
  const { g } = caçadaReal();
  const dt = 1 / 30;
  g.player.health = 100;
  g.player.money = 400;
  g.weapons.acquire('pistol');
  g.weapons.equipped = 'pistol';
  g.weapons.ammo.pistol.loaded = 40;
  const alvo = () => g.tribos.guerreiros.filter((x) => !x.morto)
    .sort((a, b) => Math.hypot(a.x - g.player.x, a.y - g.player.y)
      - Math.hypot(b.x - g.player.x, b.y - g.player.y))[0];
  let caiu = null, quadros = 0;
  // Um quadro antes de escolher alvo: o bando é materializado pelo próprio tique, e mirar o vazio no
  // quadro zero deixaria esta prova dependendo do estado que outra prova deixou para trás — exatamente
  // o acoplamento que dar a cada prova o seu próprio jogo veio aqui desfazer.
  g.update(dt);
  for (; quadros < 30 * 40 && !caiu; quadros++) {
    const v = alvo();
    if (!v) break;
    g.player.facingAngle = Math.atan2(v.y - g.player.y, v.x - g.player.x);
    // Toque e solta, toque e solta: a pistola é de tiro único por pressão, e segurar o gatilho é o
    // caminho do fuzil — atirar aqui com a tecla colada seria provar que nada atirou.
    input.setAttackHeld(quadros % 2 === 0);
    g.update(dt);
    if (v.morto) caiu = v;
  }
  assert.ok(caiu, `quarenta segundos de pistola em ${GUER.GUERREIRO_VIDA} de vida e ninguém caiu`);
  assert.ok(quadros >= 4, `${caiu.id} caiu no quadro ${quadros}: um tiro só matou um guerreiro de ${GUER.GUERREIRO_VIDA}`);
  assert.equal(caiu.vida, 0, 'o cadáver tem vida sobrando — o dano não passou pelo dono do corpo');
  assert.ok(g.tribos.guerreiros.includes(caiu), 'o corpo sumiu da lista na hora do tiro');
  assert.ok(!g.tribos.alvos().includes(caiu), 'o morto continua sendo alvo da mira');
  const vidaDepois = caiu.vida;
  for (let q = 0; q < 30; q++) {
    input.setAttackHeld(q % 2 === 0);
    g.update(dt);
  }
  assert.equal(caiu.vida, vidaDepois, 'um cadáver levou dano: a lista de alvos não respeita o morto');

  // Corpo a corpo: o mesmo `ctx` do tiro, agora pelo braço. O porrete do jogador contra um corpo do
  // bando — e é o `CombatSystem` que tem de bater, porque é o sistema que sabe quem é o alvo.
  input.resetActionInput?.();
  g.weapons.equipped = 'bat';
  const vizinho = alvo();
  assert.ok(vizinho, 'não sobrou ninguém em pé para apanhar do porrete');
  vizinho.x = g.player.x + 0.7;
  vizinho.y = g.player.y;
  vizinho.olhar = Math.PI;
  g.player.facingAngle = 0;
  const vidaAntes = vizinho.vida;
  for (let q = 0; q < 30 * 4; q++) {
    vizinho.x = g.player.x + 0.7;
    vizinho.y = g.player.y;
    g.weapons.equipped = 'bat';
    input.setAttackHeld(q % 8 === 0);
    g.update(dt);
    if (vizinho.vida < vidaAntes) break;
  }
  assert.ok(vizinho.vida < vidaAntes, 'quatro segundos de porrete no braço dele e a vida não caiu: o corpo não está na lista do corpo a corpo');
});

test('o orquestrador não tem segunda opinião sobre o bando', () => {
  // A ordem do tique é a única razão de o arrasto existir: o bando escreve a coordenada do jogador,
  // então roda depois de quem empurra corpos para fora de paredes. Trocar de lado não quebra nada
  // visível num quadro — é exatamente o tipo de regressão que só uma régua de fonte pega.
  const tique = GS_SRC.indexOf('this.tribos.update(dt, this.triboContext(!!room, view));');
  const separação = GS_SRC.indexOf('if (!room) this.separate(this.player);');
  const manche = GS_SRC.indexOf('this.handleMovement(dt);');
  assert.ok(tique > 0 && separação > 0 && manche > 0, 'a costura do bando saiu do tique do jogo');
  assert.ok(separação < tique, 'o bando voltou a rodar antes da separação de corpos');
  assert.ok(manche < tique, 'o bando roda antes do manche: a tranca do prisioneiro perdeu o quadro');
  // A tranca, escrita com as mesmas palavras do passageiro de ônibus — o precedente sancionado de
  // "corpo que o joystick não empurra". Os quatro campos e o fôlego sem esforço.
  assert.match(GS_SRC, /else if \(!this\.interiors\.active && this\.tribos\.arrastado\) \{/,
    'a tranca do prisioneiro deixou de ser um ramo do manche');
  const inícioDaTranca = GS_SRC.indexOf('this.tribos.arrastado) {');
  // O corpo do ramo recortado até o `} else {` seguinte, e não uma janela fixa de caracteres: a
  // janela cortaria o meio do próprio comentário do bloco e acusaria `player.vx = 0` de ter sumido
  // só porque o porquê dele ficou longo.
  const fimDaTranca = GS_SRC.indexOf('\n    } else {', inícioDaTranca);
  assert.ok(inícioDaTranca > 0 && fimDaTranca > inícioDaTranca, 'a tranca do prisioneiro não termina');
  const tranca = GS_SRC.slice(inícioDaTranca, fimDaTranca);
  for (const campo of ['player.vx = 0;', 'player.vy = 0;', 'player.speed = 0;', 'player.swimming = false;']) {
    assert.ok(tranca.includes(campo), `a tranca do prisioneiro deixou de zerar ${campo}`);
  }
  assert.ok(tranca.includes('this.stamina.update(player, dt, false, false)'),
    'a tranca voltou a gastar o fôlego de quem não se move');
  // O `aPé` é a porta da captura, e a palavra é do jogador, não do bando: dentro de um carro, de uma
  // moto, do ônibus do horário ou nadando, ninguém é corpo para arrastar.
  assert.match(GS_SRC, /aPé: \(\) => !isAboard\(this\.player\) && !this\.player\.swimming,/,
    'o `aPé` do bando deixou de perguntar ao jogador se ele está a pé');
  // A coordenada tem um dono por quadro: o `arrasta` do contexto é a única escrita, e ela não passa
  // pela resolução de colisão — quem puxa já foi expulso do pino pelo próprio sistema.
  const arrasta = GS_SRC.slice(GS_SRC.indexOf('private tribosArrasta('));
  assert.match(arrasta.slice(0, 400), /player\.x = x;\s*\n\s*player\.y = y;/,
    'o arrasto deixou de escrever a coordenada do jogador');
  assert.ok(!arrasta.slice(0, 400).includes('resolveCircle'),
    'o arrasto voltou a passar pela colisão: dois donos discordando do mesmo pé');
  for (const campo of ['carrega', 'vida', 'olhar', 'estado']) {
    assert.ok(!new RegExp(`\\bg\\w*\\.{campo}\\s*=`).test(GS_SRC),
      `o orquestrador escreve .${campo} de um guerreiro: o corpo deixou de ter um dono`);
  }
  // As duas vozes do bando: registradas no catálogo, presentes no disco, e brancas na lista do
  // repositório — um `.wav` fora do `.gitignore` é uma clareira sem tambor para quem clonar.
  for (const [chave, arquivo] of [['triboGrito', 'tribo_grito.wav'], ['triboTambor', 'tribo_tambor.wav']]) {
    assert.ok(SOUNDS_SRC.includes(`${chave}: require('../../assets/Audio/generated/${arquivo}')`),
      `${chave} saiu do catálogo de sons do jogo`);
    assert.ok(GITIGNORE_SRC.includes(`!assets/Audio/generated/${arquivo}`),
      `${arquivo} voltou a ficar de fora do repositório`);
    const wav = fs.readFileSync(path.join(root, 'assets/Audio/generated', arquivo));
    assert.equal(wav.subarray(0, 4).toString('latin1'), 'RIFF', `${arquivo} não é um WAV`);
    assert.equal(wav.readUInt16LE(20), 1, `${arquivo} deixou de ser mono`);
    assert.equal(wav.readUInt32LE(24), 22050, `${arquivo} mudou a taxa de amostragem`);
  }
  // A HUD nomeia a aldeia brigando, e lê a disputa do sistema — não um número copiado.
  assert.match(GS_SRC, /const aldeia = this\.tribos\.aldeiaEmDisputa\(\) !== null;/,
    'a leitura da fronteira deixou de perguntar ao bando quem briga');
  assert.match(GS_SRC, /aldeia \? 'ALDEIA ACORDADA'/, 'a frase da aldeia acordada sumiu da HUD');
  // O alvo listado entra pela mira e sai pela porta do dano, vazio dentro de casa.
  assert.match(GS_SRC, /guerreiros: room \? \[\] : this\.tribos\.alvos\(\),/,
    'os guerreiros deixaram de ser alvo da banca de armas');
  assert.match(GS_SRC, /onGuerreiroHit: \(id, damage\) => \{ if \(this\.tribos\.fere\(id, damage\)\) this\.notifyEntityChange\(\); \},/,
    'o dano do guerreiro deixou de passar pelo dono do corpo');
});

test('o orquestrador do cativeiro só orquestra: dois relógios no mesmo tick e nenhuma corda na fonte do jogo', () => {
  const bando = GS_SRC.indexOf('this.tribos.update(dt, this.triboContext(!!room, view));');
  const relógio = GS_SRC.indexOf('this.cativeiro.update(dt, this.cativeiroContext(!!room));');
  const salto = GS_SRC.indexOf("this.jump.update(this.player, this.activeMap");
  assert.ok(bando > 0 && relógio > bando && salto > relógio,
    'o relógio do cativeiro saiu da linha do bando: a entrega e a amarra deixaram de ver o mesmo mundo');
  // Entre os dois só pode existir o que não decide nada: se o orquestrador chamasse um terceiro
  // sistema ali, a janela começaria a contar num mundo um quadro mais velho que a corda.
  const entre = GS_SRC.slice(GS_SRC.indexOf(';', bando) + 1, relógio)
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.ok(!/\bthis\.\w+\.\w+\(/.test(entre),
    'o cativeiro voltou a rodar depois de um terceiro sistema no mesmo tick: a amarra vê um mundo mais velho');

  // A tranca do amarrado é um ramo do manche, vem depois da do arrastado (um corpo em caminho ainda
  // não tem poste) e faz as duas únicas coisas que o poste permite: parar o passo e ler o esforço.
  const arrastado = GS_SRC.indexOf('this.tribos.arrastado) {');
  const inícioAmarra = GS_SRC.indexOf('this.cativeiro.amarrado) {');
  assert.ok(arrastado > 0 && inícioAmarra > arrastado,
    'a tranca do amarrado deixou de vir depois da do arrastado: quem ainda está sendo levado já estaria no poste');
  const fimAmarra = GS_SRC.indexOf('\n    } else {', inícioAmarra);
  assert.ok(fimAmarra > inícioAmarra, 'a tranca do amarrado não termina');
  const amarra = GS_SRC.slice(inícioAmarra, fimAmarra);
  assert.match(GS_SRC, /else if \(!this\.interiors\.active && this\.cativeiro\.amarrado\) \{/,
    'a tranca do amarrado deixou de ser um ramo do manche');
  for (const campo of ['player.vx = 0;', 'player.vy = 0;', 'player.speed = 0;', 'player.swimming = false;']) {
    assert.ok(amarra.includes(campo), `a tranca do amarrado deixou de zerar ${campo}`);
  }
  assert.ok(amarra.includes('this.stamina.update(player, dt, false, false)'),
    'a tranca do amarrado voltou a gastar o fôlego de quem não se move');
  assert.ok(amarra.includes('this.cativeiro.puxa(inputState.dx);'),
    'o esforço deixou de ser lido do manche dentro da tranca: o poste ficou surdo ao puxão');

  // A entrega: o bando manda, o bolso é do jogo, e o que chega ao cativeiro é só o acampamento —
  // nenhum `player.x` sai da mão que ata, porque quem pousou o corpo no poste foi o próprio bando.
  assert.match(GS_SRC, /captura: \(ac\) => this\.tribosCapturam\(ac\),/,
    'a captura deixou de passar pela única porta do cativeiro');
  const entrega = GS_SRC.slice(GS_SRC.indexOf('private tribosCapturam('), GS_SRC.indexOf('/**', GS_SRC.indexOf('private tribosCapturam(')));
  assert.ok(entrega.includes('this.cativeiro.amarra(ac);'),
    'a entrega deixou de atar o corpo ao poste');
  assert.ok(!/player\.(x|y|vx|vy)\s*=[^=]/.test(entrega),
    'quem ata escreveu coordenada: o corpo no poste voltou a ter dois donos');

  // O contexto do poste: o mais curto da fronteira, e cada nome dele é uma ferramenta que já existia.
  const contexto = GS_SRC.slice(GS_SRC.indexOf('private cativeiroContext('), GS_SRC.indexOf('private frontierFallContext('));
  assert.ok(contexto.includes('player: indoors ? null : this.player'),
    'o cativeiro voltou a correr os relógios dentro de uma sala');
  assert.match(contexto, /aPé: \(\) => !isAboard\(this\.player\) && !this\.player\.swimming,/,
    'o poste deixou de perguntar ao jogador se ele está a pé');
  assert.ok(contexto.includes('acorda: (aldeiaId) => this.tribos.acorda(aldeiaId),'),
    'a corda solta deixou de acordar o bando pela porta dele');
  assert.ok(contexto.includes('expulsa: () => expulsaDaClareira('),
    'o fracasso deixou de usar a borda que já é da clareira');
  assert.ok(!/\balerta\b|\bperigo\b|\bsetAlerta\b/.test(contexto),
    'o orquestrador mexeu na atenção do bando por fora: a porta do `acorda` virou um atalho');

  // A corda não tem número no orquestrador: o esforço, o aperto, o morto do stick e o prazo vivem no
  // sistema. Um `0.075` aqui seria uma segunda corda, e a régua do check não enxergaria a diferença.
  // A varredura é do código, não da fonte: os comentários do orquestrador explicam a corda usando o
  // nome dela, e proibir isso seria calar o porquê para proteger o quê.
  const código = GS_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  for (const nome of ['integridade', 'ordensa', 'janela', 'puxões', 'FORÇA_DO_PUXÃO', 'MORTO_DO_PUXÃO', 'APERTO_DO_NÓ', 'PRAZO_DA_SACIEDADE']) {
    assert.ok(!new RegExp(`\\b${nome}\\b`).test(código),
      `o GameState voltou a conhecer a corda por dentro: \`${nome}\` aparece no código do orquestrador`);
  }
});

test('typecheck isolado do modelo, do nó, da corda, da tinta e da banca', () => {
  const program = ts.createProgram([
    path.join(root, 'src/world/Tribo.ts'), path.join(root, 'src/render/TriboStatics.ts'),
    path.join(root, 'src/render/TriboSprite.tsx'), path.join(root, 'src/render/GuerreiroSprite.tsx'),
    path.join(root, 'src/entities/Guerreiro.ts'),
    path.join(root, 'src/systems/TriboSystem.ts'),
    path.join(root, 'src/systems/CativeiroSystem.ts'),
  ], { strict: true, noImplicitReturns: true, noFallthroughCasesInSwitch: true, noEmit: true,
    target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler, jsx: ts.JsxEmit.ReactJSX,
    esModuleInterop: true, skipLibCheck: true, types: ['react'] });
  const errors = ts.getPreEmitDiagnostics(program);
  assert.equal(errors.length, 0, ts.formatDiagnosticsWithColorAndContext(errors, {
    getCanonicalFileName: (file) => file, getCurrentDirectory: () => root, getNewLine: () => '\n',
  }));
});


console.log(`\n${passed} passaram, ${failed} falharam`);
process.exitCode = failed ? 1 : 0;
