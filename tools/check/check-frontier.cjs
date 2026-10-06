// Run: node tools/check/check-frontier.cjs. A fronteira sem fim e o que ela cobra: a mata
// nasce do mesmo hash que a pinta, barra onde está pintada, e quem insiste nela é caçado.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('module');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');
const modules = new Map();

function load(filename) {
  if (!path.extname(filename)) filename += '.ts';
  if (modules.has(filename)) return modules.get(filename).exports;
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    fileName: filename, compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  });
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.require = (name) => (name.startsWith('.')
    ? load(path.resolve(path.dirname(filename), name))
    : require(name));
  modules.set(filename, mod);
  mod._compile(compiled.outputText, filename);
  return mod.exports;
}

const F = load(path.join(root, 'src/world/Frontier.ts'));

/**
 * A consulta de água das provas de mata: um mundo sem rio, para o tronco continuar sendo a
 * única coisa que barra. As provas do canal usam o Map real, porque só ele sabe onde a beira
 * do mapa é água.
 */
const SEM_RIO = { isWaterWorld: () => false };
const G = load(path.join(root, 'src/entities/Gorila.ts'));
const GS = load(path.join(root, 'src/systems/GorilaSystem.ts'));
const FF = load(path.join(root, 'src/systems/FrontierFallSystem.ts'));

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('OK ' + name); }
  catch (error) { failed++; console.error('FAIL ' + name + '\n' + error.stack); }
}

// A grade da cidade como ela é no jogo (208x208), mas o número não importa: a fronteira é uma
// função da coordenada, e as provas abaixo valem em qualquer mapa que exista.
const W = 208, H = 208;
const DT = 1 / 30;

/**
 * O `GameState` falso: só o que o sistema pede, com as três saídas de efeito registradas.
 * Registrar é o que permite cobrar *ordem* (aviso antes da fera) e não apenas estado final.
 *
 * `worldPosition` é getter de propósito: no jogo é a cidade que lê o pé do jogador a cada
 * quadro. Um objeto congelado faria o sistema cobrar a profundidade de quando o mundo foi
 * criado, e um teste de fuga para a cidade nunca veria `prof === 0` — a condição que dispensa
 * o gigante.
 */
function mundo(player, opts = {}) {
  const log = { falas: [], sons: [], tremores: [], _struct: 0 };
  const ctx = {
    worldW: W, worldH: H,
    player,
    // A mata e o rio são DONO de trechos diferentes do mesmo mundo, e a partilha é lida daqui:
    // sem `água` o `GorilaSystem` cobraria quem nada no canal sem fim, e as duas feras nasceriam
    // no mesmo nadador. É o campo obrigatório do contrato, então a prova também o tem.
    água: opts.água || SEM_RIO,
    get worldPosition() {
      return player ? { x: player.x, y: player.y } : { x: 100, y: 100 };
    },
    damages: (amount) => {
      if (!player || player.health <= 0) return false;
      if (opts.invulnerável) return false;
      player.health = Math.max(0, player.health - amount);
      return true;
    },
    shake: (a) => log.tremores.push(a),
    say: (t, s) => log.falas.push({ t, s }),
    play: (k, v) => log.sons.push({ k, v }),
    isVisible: () => true,
    onStructChange: () => { log._struct++; },
  };
  return { ctx, log };
}

function anda(system, ctx, segundos, passo = DT) {
  for (let i = 0; i < Math.round(segundos / passo); i++) system.update(passo, ctx);
}

// ---------------------------------------------------------------- a mata

test('a mata é a mesma chamada: o tile que pinta é o tile que barra', () => {
  // Mesma coordenada, duas chamadas, duas camadas diferentes do jogo. Se isto divergir, a
  // fronteira mostra árvore onde se passa — o erro que faz mata pintada ser decoração.
  // O corpo é posto no *pé* da árvore desenhada, não no centro do tile: o pé sai do centro com
  // folga de meio tile, e um corpo no centro de uma árvore deslocada não toca em nada — a prova
  // falharia por causa do probe, não por causa do mapa.
  const casos = [[-3, 104], [240, 77], [-18, 240], [104, -1], [55, 300], [-9, 63], [300, 150]];
  for (const [tx, ty] of casos) {
    const pintada = F.árvoreDoTile(tx, ty, W, H, SEM_RIO);
    const corpo = pintada ? { x: pintada.x, y: pintada.y, radius: 0.16 }
      : { x: tx + 0.5, y: ty + 0.5, radius: 0.16 };
    const barra = F.empurraDoTronco(corpo, W, H, SEM_RIO);
    assert.equal(!!pintada, barra, `tile (${tx}, ${ty}): tinta ${!!pintada} x sólido ${barra}`);
  }
});

test('a mata é determinística e nunca é pomar', () => {
  const primeira = [];
  for (let i = 0; i < 400; i++) {
    const t = F.árvoreDoTile(-40 - (i % 25), 100 + Math.floor(i / 25), W, H, SEM_RIO);
    primeira.push(t ? `${t.chave}|${t.x.toFixed(4)}|${t.y.toFixed(4)}|${t.escala.toFixed(4)}` : '-');
  }
  const segunda = [];
  for (let i = 0; i < 400; i++) {
    const t = F.árvoreDoTile(-40 - (i % 25), 100 + Math.floor(i / 25), W, H, SEM_RIO);
    segunda.push(t ? `${t.chave}|${t.x.toFixed(4)}|${t.y.toFixed(4)}|${t.escala.toFixed(4)}` : '-');
  }
  assert.deepEqual(segunda, primeira, 'duas leituras da mesma coordenada divergiram');
  // Alinhamento: nenhuma árvore pode estar exatamente no centro do tile — pomar denuncia.
  for (let tx = -30; tx < 30; tx++) {
    for (let ty = -30; ty < 30; ty++) {
      const t = F.árvoreDoTile(tx, ty, W, H, SEM_RIO);
      if (!t) continue;
      assert.notEqual(t.x % 1, 0, `árvore alinhada em x no tile (${tx}, ${ty})`);
      assert.notEqual(t.y % 1, 0, `árvore alinhada em y no tile (${tx}, ${ty})`);
    }
  }
});

test('a mata fecha com a profundidade e o chão escurece junto', () => {
  assert.ok(F.densidadeDaMata(20) > F.densidadeDaMata(1), 'a mata não engrossa ao entrar');
  assert.equal(F.densidadeDaMata(F.PROFUNDIDADE_MAXIMA_DA_MATA), F.MATA_FECHADA,
    'a densidade não satura na profundidade máxima');
  assert.ok(F.densidadeDaMata(400) <= 1, 'densidade acima de 1 viraria parede');
  assert.ok(F.luzDoDossel(80) < F.luzDoDossel(2), 'o dossel não fecha por cima de quem entra');
  assert.equal(F.luzDoDossel(400), 0.62, 'a luz de fundo mudou');
});

test('ninguém atravessa o limite invisível, nem correndo contra ele', () => {
  const corpo = { x: W / 2, y: -2, radius: 0.15 };
  for (let i = 0; i < 400; i++) {
    corpo.x += 6; corpo.y -= 6; // 6 tiles por tick, na diagonal de saída.
    F.seguraNaFronteira(corpo, W, H, SEM_RIO);
  }
  assert.ok(corpo.y >= -F.FRONTEIRA_ALCANCE + corpo.radius - 1e-9,
    `passou do alcance: y=${corpo.y}`);
  assert.ok(Number.isFinite(corpo.x) && Number.isFinite(corpo.y));
});

// ---------------------------------------------------------------- a cobrança

test('a cidade não cobra nada: 60 s de calçada e a dívida fica em zero', () => {
  const system = new GS.GorilaSystem();
  const player = { x: 100, y: 100, radius: 0.15, health: 100 };
  const { ctx, log } = mundo(player);
  anda(system, ctx, 60);
  assert.equal(system.rancor, 0, 'a cidade cobrou algo');
  assert.equal(system.fera, null, 'nasceu fera na cidade');
  assert.equal(log.falas.length, 0, 'a HUD falou sem razão');
});

test('a régua: a taxa cresce com a profundidade e satura no teto', () => {
  assert.ok(GS.taxaDaCobrança(40) > GS.taxaDaCobrança(6), 'a mata velha cobra igual à orla');
  assert.equal(GS.taxaDaCobrança(400), GS.taxaDaCobrança(80), 'a taxa não tem teto');
  assert.ok(GS.taxaDaCobrança(-5) === GS.taxaDaCobrança(0), 'profundidade negativa cobraria');
});

test('primeiro o aviso, depois a fera — e o aviso não se repete', () => {
  const system = new GS.GorilaSystem();
  const player = { x: 100, y: -12, radius: 0.15, health: 100 };
  const { ctx, log } = mundo(player);
  let avisoEm = -1, feraEm = -1;
  for (let t = 0; feraEm < 0 && t < 200; t += DT) {
    system.update(DT, ctx);
    if (avisoEm < 0 && log.falas.length) avisoEm = t;
    if (feraEm < 0 && system.fera) feraEm = t;
  }
  assert.ok(avisoEm >= 0, 'a fronteira nunca avisou');
  assert.ok(feraEm > avisoEm, `fera (${feraEm}) antes do aviso (${avisoEm})`);
  const falasDoAviso = log.falas.filter((f) => f.t.includes('quieta demais')).length;
  assert.equal(falasDoAviso, 1, 'o aviso se repetiu na mesma dívida');
  assert.ok(feraEm - avisoEm > 5, 'entre o aviso e a fera não há tempo de sentir o medo');
});

test('quem só cutuca a orla não é caçado: 3 tiles é campo aberto', () => {
  const system = new GS.GorilaSystem();
  const player = { x: 100, y: -3, radius: 0.15, health: 100 };
  const { ctx } = mundo(player);
  anda(system, ctx, 180);
  assert.equal(system.fera, null, 'a orla criou uma fera');
});

test('a fera nasce sempre mais fundo do que você e nunca em cima', () => {
  const faces = [[100, -20], [W + 20, 100], [100, H + 20], [-20, 100], [-15, -15], [223, 223]];
  for (const [px, py] of faces) {
    const system = new GS.GorilaSystem();
    system.rancor = 2;
    const player = { x: px, y: py, radius: 0.15, health: 100 };
    const { ctx } = mundo(player);
    system.update(DT, ctx);
    assert.ok(system.fera, `nenhuma fera nasceu na face de (${px}, ${py})`);
    const minha = F.profundidade(px, py, W, H);
    const dele = F.profundidade(system.fera.x, system.fera.y, W, H);
    assert.ok(dele > minha, `nasceu menos fundo: ${dele} <= ${minha}`);
    const d = Math.hypot(system.fera.x - px, system.fera.y - py);
    assert.ok(d >= 20 && d <= 40, `distância de emergência ${d.toFixed(1)} fora da janela`);
    assert.equal(system.fera.estado, 'espreitando', 'ele já nasceu correndo');
  }
});

test('a mesma coordenada dá a mesma emboscada em qualquer aparelho', () => {
  for (let i = 0; i < 40; i++) {
    const px = 60 + i * 2.37, py = -18.5;
    // Dois sistemas, dois jogadores, mesma coordenada: é assim que se prova que o ponto de
    // emergência vem do hash e não do tempo de quadro nem de um sorteio por processo.
    const a = new GS.GorilaSystem();
    const b = new GS.GorilaSystem();
    a.rancor = 2;
    b.rancor = 2;
    a.update(DT, mundo({ x: px, y: py, radius: 0.15, health: 100 }).ctx);
    b.update(DT, mundo({ x: px, y: py, radius: 0.15, health: 100 }).ctx);
    assert.ok(a.fera && b.fera, `nenhuma fera em (${px.toFixed(1)}, ${py})`);
    assert.deepEqual({ x: a.fera.x, y: a.fera.y, dir: a.fera.dir, rancor: a.fera.rancor },
      { x: b.fera.x, y: b.fera.y, dir: b.fera.dir, rancor: b.fera.rancor },
      `emboscada divergiu em (${px.toFixed(1)}, ${py})`);
  }
});

// ---------------------------------------------------------------- a caçada

test('parado na mata, o soco chega: três marteladas e o jogador cai', () => {
  const system = new GS.GorilaSystem();
  const player = { x: 100, y: -12, radius: 0.15, health: 100 };
  const { ctx, log } = mundo(player);
  // Do primeiro tick até a morte, sem rodar o tempo antes: com 90 s de simulação prévia o
  // gigante já teria matado o jogador, e a contagem de socos seria zero por causa do probe.
  let socos = 0, t = 0;
  while (player.health > 0 && t < 120) {
    const antes = player.health;
    system.update(DT, ctx);
    if (player.health < antes) socos++;
    t += DT;
  }
  assert.equal(player.health, 0, `sobreviveu com ${player.health} depois de ${t.toFixed(0)} s`);
  // 34 de dano, 100 de vida: três marteladas. Quatro admite o frame em que o recuo afastou o
  // corpo; cinco seria o braço virar metralhadora.
  assert.ok(socos >= 3 && socos <= 5, `socos até a morte: ${socos}`);
  assert.ok(t > 40, `matou em ${t.toFixed(0)} s: a fronteira não deu tempo de reagir`);
  assert.ok(log.tremores.some((a) => a >= 1), 'o soco não treme a tela');
});

test('a cadência do braço é a do projeto, não a do frame', () => {
  const system = new GS.GorilaSystem();
  const player = { x: 100, y: -12, radius: 0.15, health: 100 };
  const { ctx } = mundo(player);
  const tempos = [];
  let t = 0;
  while (player.health > 0 && t < 120) {
    const antes = player.health;
    system.update(DT, ctx);
    if (player.health < antes) tempos.push(t);
    t += DT;
  }
  assert.ok(tempos.length >= 2, `só ${tempos.length} soco(s) para medir cadência`);
  for (let i = 1; i < tempos.length; i++) {
    const intervalo = tempos[i] - tempos[i - 1];
    // 1,15 s de cadência + 0,22 s de braço no alto, com um frame de folga de cada lado: é o
    // tempo que o jogador tem para ver o gesto e sair do alcance.
    assert.ok(intervalo > 1.1 && intervalo < 1.7,
      `intervalo entre o soco ${i} e o ${i + 1}: ${intervalo.toFixed(2)} s`);
  }
});

test('a invulnerabilidade do pós-dano vale para o gigante também', () => {
  const system = new GS.GorilaSystem();
  const player = { x: 100, y: -12, radius: 0.15, health: 100 };
  const { ctx, log } = mundo(player, { invulnerável: true });
  anda(system, ctx, 120);
  assert.equal(player.health, 100, 'o soco atravessou a invulnerabilidade');
  assert.equal(log.tremores.filter((a) => a >= 1).length, 0, 'tremeu como se acertasse');
});

test('a distância só cai: correr para dentro da mata não te põe na frente dele', () => {
  const system = new GS.GorilaSystem();
  const player = { x: 100, y: -12, radius: 0.15, health: 100 };
  const { ctx } = mundo(player);
  anda(system, ctx, 60);
  assert.ok(system.fera);
  // Fugindo para fora a 4 tiles/s: a profundidade do jogador cresce, e a dele também tem de
  // crescer — ele nunca pode ficar para trás a ponto de o jogador atravessar a mata inteira.
  let anterior = F.profundidade(system.fera.x, system.fera.y, W, H);
  for (let i = 0; i < 300; i++) {
    player.y -= 4 * DT;
    system.update(DT, ctx);
    if (!system.fera || system.fera.morto) break;
    const dele = F.profundidade(system.fera.x, system.fera.y, W, H);
    assert.ok(dele >= anterior - 0.001, 'ele recuou na profundidade durante a fuga para fora');
    anterior = dele;
  }
});

test('voltar para a cidade o perde, e ele não pisa o asfalto', () => {
  const system = new GS.GorilaSystem();
  const player = { x: 100, y: -12, radius: 0.15, health: 100 };
  const { ctx, log } = mundo(player);
  anda(system, ctx, 45);
  assert.ok(system.fera, 'a fera não nasceu para a fuga');
  const vidaAntes = player.health;
  // Corrida de volta: 4 tiles/s até o interior do mapa e mais um bocado de calçada.
  for (let i = 0; i < 600; i++) {
    player.y += 4 * DT;
    if (player.y > 20) player.y = 20;
    system.update(DT, ctx);
    if (!system.fera) break;
    if (!F.foraDoMapa(player.x, player.y, W, H)) {
      assert.ok(system.fera.estado === 'retirando' || system.fera.velocidade === 0
        || F.profundidade(system.fera.x, system.fera.y, W, H) > 0,
        'ele entrou na cidade');
    }
  }
  assert.equal(system.fera, null, 'ele perseguiu o jogador até o asfalto');
  assert.equal(player.health, vidaAntes, 'a ferida chegou na cidade');
  assert.ok(log.falas.some((f) => f.t.includes('asfalto')), 'a HUD não disse que ele não entra');
  assert.ok(system.rancor <= 0.62, `a dívida não baixou com a retirada: ${system.rancor}`);
});

test('a dívida apaga no asfalto, mas apaga devagar', () => {
  const system = new GS.GorilaSystem();
  const fora = { x: 100, y: -12, radius: 0.15, health: 100 };
  const { ctx } = mundo(fora);
  anda(system, ctx, 30);
  assert.ok(system.rancor > 0.4, '30 s na mata não cobraram nada');
  const dívida = system.rancor;
  const dentro = { x: 100, y: 100, radius: 0.15, health: 100 };
  const dentroCtx = mundo(dentro).ctx;
  anda(system, dentroCtx, 10);
  assert.ok(system.rancor < dívida, 'a cidade não perdoa nada');
  assert.ok(system.rancor > dívida - 0.5, 'a dívida evaporou: a fronteira não teria memória');
});

// ---------------------------------------------------------------- o tiro

test('um gigante de 720 de vida: atirar não espanta, acelera', () => {
  const system = new GS.GorilaSystem();
  const player = { x: 100, y: -12, radius: 0.15, health: 100 };
  const { ctx } = mundo(player);
  anda(system, ctx, 45);
  const fera = system.fera;
  assert.ok(fera);
  const rancorAntes = fera.rancor;
  const velocidadeAntes = GS.velocidadeDaFera(rancorAntes);
  assert.equal(system.fere(50), false, '50 de dano mataram um gigante');
  assert.equal(fera.morto, false, '50 de dano derrubaram um gigante');
  assert.equal(fera.estado !== 'retirando', true, 'ferido, ele fugiu');
  assert.ok(fera.rancor > rancorAntes, `o tiro não o deixou mais bravo: ${fera.rancor}`);
  assert.ok(GS.velocidadeDaFera(fera.rancor) > velocidadeAntes,
    'o tiro não o deixou mais rápido');
  assert.equal(system.alvo, fera, 'a fera viva não está na mira de quem atira');
});

test('a vida acaba uma sola vez e o corpo cai devagar', () => {
  const system = new GS.GorilaSystem();
  const player = { x: 100, y: -12, radius: 0.15, health: 100 };
  const { ctx, log } = mundo(player);
  anda(system, ctx, 45);
  const fera = system.fera;
  assert.ok(fera);
  let letais = 0;
  for (let i = 0; i < 30; i++) if (system.fere(60)) letais++;
  assert.equal(letais, 1, `${letais} golpes letais no mesmo corpo`);
  assert.equal(fera.morto, true);
  assert.equal(fera.estado, 'morto');
  // Um cadáver não é alvo: quem atira duas vezes no corpo caído não ganha dois prêmios.
  assert.equal(system.alvo, null, 'a mira ainda procura um gigante morto');
  assert.equal(system.fere(60), false, 'um tiro no cadáver contou como golpe');
  anda(system, ctx, 4);
  assert.ok(system.fera === fera, 'o cadáver sumiu antes da hora');
  assert.ok(G.GORILA_QUEDA_S < 2, 'um gigante de duas toneladas cai em dois segundos');
  anda(system, ctx, 22);
  assert.equal(system.fera, null, 'o corpo não se dissolveu');
  assert.ok(log.falas.some((f) => f.t.includes('caiu')), 'a morte não foi dita');
  assert.ok(system.rancor >= 1.3, `matar zerou a dívida: ${system.rancor}`);
});

test('dentro de uma sala o mundo congela, inclusive ele', () => {
  const system = new GS.GorilaSystem();
  const fora = { x: 100, y: -12, radius: 0.15, health: 100 };
  const { ctx } = mundo(fora);
  anda(system, ctx, 20);
  const dívida = system.rancor;
  assert.ok(dívida > 0, 'a mata não cobrou nada antes da sala');
  const sala = mundo(null);
  anda(system, sala.ctx, 30);
  assert.equal(system.rancor, dívida, 'a sala cobra ou perdoa dívida');
  const pos = system.fera ? { x: system.fera.x, y: system.fera.y } : null;
  assert.ok(!pos || (pos.x === system.fera.x && pos.y === system.fera.y),
    'a fera andou com a porta fechada');
});

test('uma fera por vez, e prazo para a próxima', () => {
  const system = new GS.GorilaSystem();
  // A 34 tiles de profundidade: ainda é a banda dele. O teste já foi em -40, que era "mata
  // velha" quando a mata era uma coisa só — hoje essa linha é a porta da tribo, e o gigante não
  // entra nela. É justamente a separação que esta prova passa a respeitar.
  const player = { x: 100, y: -34, radius: 0.15, health: 100 };
  const { ctx, log } = mundo(player);
  anda(system, ctx, 120);
  assert.ok(system.fera, 'a mata velha não criou fera');
  assert.equal(system.rancor < 1, true, 'a dívida ficou acima do gatilho com uma fera viva');
  anda(system, ctx, 60);
  const nascimentos = log.falas.filter((f) => f.t.includes('se levantou')).length;
  assert.equal(nascimentos, 1, `${nascimentos} gigantes ao mesmo tempo`);
});

// ---------------------------------------------------------------- o desenho

test('a pose nunca sai dos 18 quadros que o sprite guarda', () => {
  // O `GorilaSprite` indexa `frames[(away ? VISTAS : 0) + frame]` numa arte de 9 poses por vista.
  // Um frame 9, um `away` que não seja booleano ou um `mirror` estranho devolvem `undefined` — e
  // na Skia web um caminho ausente é um gigante invisível, não um erro. Esta é a única forma de
  // conferir a fila de desenho sem navegador.
  const estados = ['espreitando', 'cacando', 'batendo', 'retirando', 'morto'];
  const dirs = ['SE', 'SW', 'NE', 'NW'];
  for (const estado of estados) {
    for (const dir of dirs) {
      for (let t = 0; t < 40; t++) {
        const vivo = estado !== 'morto';
        const visual = { dir, estado, velocidade: vivo ? 2.2 : 0, morto: !vivo,
          deathTimer: vivo ? -1 : t * 0.1, esperando: estado === 'batendo' && t % 3 === 0,
          golpe: vivo ? (t % 5 === 0 ? G.GORILA_CADENCIA - t * 0.01 : 0) : 0,
          peito: ((t * 0.37) % 1) * G.PEITO_CICLO,
          animTime: t * 0.13, sampledAt: 0 };
        const pose = G.gorilaPose(visual, t * 0.05);
        assert.ok(Number.isInteger(pose.frame) && pose.frame >= 0 && pose.frame <= 8,
          `frame ${pose.frame} em ${estado}/${dir}`);
        assert.equal(typeof pose.away, 'boolean', 'o away não é booleano');
        assert.ok(pose.mirror === 1 || pose.mirror === -1, `mirror ${pose.mirror}`);
        assert.ok(pose.alpha >= 0 && pose.alpha <= 1, `alpha ${pose.alpha}`);
      }
    }
  }
});

test('o punho no chão aparece no exato tick em que o jogador perde vida', () => {
  // O `soca()` aplica o dano e devolve o corpo à marcha no mesmo tick: se a pose só olhasse o
  // `estado`, o quadro de impacto seria invisível para sempre — o braço sobe, o jogador apanha,
  // e no instante do dano o gigante já está andando de novo. Esta prova não desenha nada: ela
  // publica o instantâneo exatamente como a UI thread faria e cobra o frame 7 no tick do dano.
  const system = new GS.GorilaSystem();
  const player = { x: 100, y: -12, radius: 0.15, health: 100 };
  const { ctx } = mundo(player);
  let achados = 0;
  for (let i = 0; i < 30 * 60 && achados < 3; i++) {
    const antes = player.health;
    system.update(DT, ctx);
    if (player.health >= antes || !system.fera) continue;
    const pose = G.gorilaPose(G.gorilaVisualState(system.fera, i * DT), i * DT);
    assert.equal(pose.frame, 7, `dano aplicado no quadro ${i}, mas a pose mostrou frame ${pose.frame}`);
    achados++;
  }
  assert.equal(achados, 3, `só ${achados} pancada(s) chegaram à tela`);
});

test('o corpo rola na passada em vez de pular de altura', () => {
  // O `bob` antigo era binário: -2/-3 px só nos quadros de contato, zero nos demais. O resultado
  // era um gigante saltando de altura a cada quadro. Agora quadro e altura saem da MESMA fase
  // senoidal, então o maior deslocamento entre dois quadros de 30 fps é a derivada da própria onda
  // (amplitude × π/2 × cadência × dt ≈ 1,16 px) e nunca um degrau de 2-3 px; e a curva tem de
  // percorrer muitas alturas, porque o modelo velho tinha exatamente três.
  const visual = { dir: 'SE', estado: 'cacando', velocidade: 2.2, morto: false, deathTimer: -1,
    esperando: false, golpe: 0, peito: 0, animTime: 0, sampledAt: 0 };
  const amplitude = 3.4;
  const tetos = amplitude * Math.PI / 2 * 6.5 * DT;
  const alturas = new Set();
  let anterior = null;
  let maiorSalto = 0;
  const quadros = new Set();
  for (let i = 0; i < 240; i++) {
    visual.animTime = i * DT;
    const pose = G.gorilaPose(visual, visual.animTime);
    if (anterior !== null) maiorSalto = Math.max(maiorSalto, Math.abs(pose.bob - anterior));
    anterior = pose.bob;
    alturas.add(pose.bob.toFixed(3));
    quadros.add(pose.frame);
  }
  assert.ok(maiorSalto <= tetos + 1e-9,
    `a passada deu um salto de ${maiorSalto.toFixed(3)} px, acima da derivada da onda (${tetos.toFixed(3)})`);
  assert.ok(alturas.size > 20, `a altura só tinha ${alturas.size} valores: voltou a ser binária`);
  assert.deepEqual([...quadros].sort((a, b) => a - b), [1, 2, 3, 4],
    'a marcha não percorre os quatro quadros de passada');
});

test('o aviso tem dois gestos, e o punho no peito é o quadro do tremor', () => {
  // `espreitando` já foi um pose estático. Agora o corpo alterna entre os punhos armados (8) e a
  // batida de peito (6), e a janela da batida é a MESMA constante que o sistema usa para tremer o
  // chão. Se os dois relógios divergirem, o jogador sente o tranco num quadro e vê o punho no
  // peito no seguinte — o aviso perde o sentido, que é existir antes do corrida.
  const visual = { dir: 'SE', estado: 'espreitando', velocidade: 0, morto: false, deathTimer: -1,
    esperando: false, golpe: 0, peito: G.PEITO_CICLO, animTime: 0, sampledAt: 0 };
  const batendo = [];
  const armado = [];
  for (let i = 0; i <= 40; i++) {
    visual.peito = G.PEITO_CICLO - i * (G.PEITO_CICLO / 40);
    const pose = G.gorilaPose(visual, 0);
    const janela = visual.peito >= G.PEITO_CICLO - G.PEITO_BATIDA;
    (janela ? batendo : armado).push(pose.frame);
    assert.equal(pose.frame, janela ? 6 : 8,
      `peito ${visual.peito.toFixed(2)} s deu frame ${pose.frame}`);
  }
  assert.ok(batendo.length > 0 && armado.length > 0, 'um dos dois gestos nunca foi desenhado');
});

test('quem anda é o corpo: o relógio da batida de peito vive no gigante', () => {
  // O gesto do aviso e o tremor do peito saíam de um `private peito` do sistema, nunca publicado:
  // a UI thread não tinha como saber em que quadro do gesto o corpo estava, e a batida não tinha
  // sprite. O relógio agora é campo do `Gorila` e chega à tela pelo instantâneo — e é o corpo em
  // fase de aviso que prova isso, porque fora dela ninguém vê o gesto acontecer.
  const system = new GS.GorilaSystem();
  const player = { x: 100, y: -22, radius: 0.15, health: 100 };
  const { ctx } = mundo(player);
  for (let i = 0; i < 30 * 30 && !system.fera; i++) system.update(DT, ctx);
  assert.ok(system.fera, 'a fera não nasceu na mata velha');
  const fera = system.fera;
  assert.equal(typeof fera.peito, 'number', 'o corpo não carrega o relógio do peito');
  assert.equal(fera.estado, 'espreitando', 'ele já saiu do aviso antes de a prova começar');
  let observado = 0;
  let batidas = 0;
  while (fera.estado === 'espreitando' && observado < 200) {
    const antes = fera.peito;
    system.update(DT, ctx);
    if (fera.estado !== 'espreitando') break;
    observado++;
    assert.ok(fera.peito < antes || fera.peito === G.PEITO_CICLO,
      `o relógio do peito parou: ${antes.toFixed(3)} -> ${fera.peito.toFixed(3)}`);
    if (fera.peito === G.PEITO_CICLO) batidas++;
    assert.equal(G.gorilaVisualState(fera, 0).peito, fera.peito,
      'o instantâneo não publica o relógio do peito');
  }
  assert.ok(batidas >= 1, 'em 200 quadros de aviso o peito nunca bateu');
});

test('o corpo some dissolvido, não piscando', () => {
  // A fila corta o cadáver em `GORILA_CADAVER_S`; se a opacidade ainda for maior que zero nesse
  // instante, o gigante desaparece no meio do quadro em vez de terminar de sumir.
  let anterior = 1;
  // Passo em inteiro sobre 0,1 s: `t += 0.1` acumula erro de float e o último quadro pararia em
  // 23,9 s — a prova falharia por causa do relógio do probe, não por causa do fade.
  for (let i = 0; i <= G.GORILA_CADAVER_S * 10; i++) {
    const t = i / 10;
    const pose = G.gorilaPose({ dir: 'SE', estado: 'morto', velocidade: 0, morto: true,
      deathTimer: t, esperando: false, golpe: 0, peito: 0, animTime: 0, sampledAt: t }, t);
    assert.ok(pose.alpha <= anterior + 1e-9, `o fantasma ganhou opacidade em ${t}s`);
    anterior = pose.alpha;
  }
  assert.equal(anterior, 0, `no corte da fila ainda havia corpo pintado: ${anterior}`);
});

test('o recorte do mundo e o sumiço do sprite são a mesma hora', () => {
  // `SortedWorldLayer` só põe a fera na fila enquanto `gorilaVisível` diz sim. Se o sistema de
  // vida a retirasse antes, o componente desmontaria com o corpo ainda pintando — e o contrário
  // deixa um cadáver transparente ocupando a ordenação por profundidade para sempre.
  assert.ok(G.gorilaVisível({ morto: false, deathTimer: -1 }), 'o corpo vivo saiu da fila');
  assert.ok(G.gorilaVisível({ morto: true, deathTimer: 0 }), 'um cadáver recém-caído foi cortado');
  assert.ok(G.gorilaVisível({ morto: true, deathTimer: G.GORILA_CADAVER_S - 0.01 }),
    'o cadáver desapareceu antes do prazo');
  assert.equal(G.gorilaVisível({ morto: true, deathTimer: G.GORILA_CADAVER_S }), false,
    'o cadáver ficou para sempre na tela');
});

test('a HUD lê terra, face e perigo da mesma coordenada', () => {
  // `GameState.frontierStatus` é feito destes três leitores e nada mais. Se algum divergir do
  // que o sistema cobra, a linha da HUD conta uma história enquanto a fera faz outra.
  const system = new GS.GorilaSystem();
  const cidade = { x: 100, y: 100, radius: 0.15, health: 100 };
  anda(system, mundo(cidade).ctx, 60);
  assert.equal(system.perigo, 0, 'a cidade cobrou perigo');
  assert.equal(system.terra(cidade, W, H), 'a cidade', 'a HUD chamou a calçada de mata');
  assert.equal(system.face(cidade, W, H), null, 'a HUD apontou saída para quem nunca saiu');
  const fora = { x: 100, y: -20, radius: 0.15, health: 100 };
  anda(system, mundo(fora).ctx, 60);
  assert.equal(system.face(fora, W, H), 'NE', `a face lida foi ${system.face(fora, W, H)}`);
  assert.ok(system.perigo > 0, 'a mata não subiu o perigo da HUD');
  assert.notEqual(system.terra(fora, W, H), 'a cidade', 'a HUD chama de cidade quem está na mata');
});

// ---------------------------------------------------------------- a fronteira pelo ar

const CFG = load(path.join(root, 'src/game/GameConfig.ts')).GAME_CONFIG;
const { Map: CityMap } = load(path.join(root, 'src/world/Map.ts'));
const { MovementSystem } = load(path.join(root, 'src/systems/MovementSystem.ts'));
const { CollisionSystem } = load(path.join(root, 'src/systems/CollisionSystem.ts'));
const { createVehicle } = load(path.join(root, 'src/entities/Vehicle.ts'));
const { createPlayer } = load(path.join(root, 'src/entities/Player.ts'));
const { VEHICLE_DEFS } = load(path.join(root, 'src/data/vehicles.ts'));
const input = load(path.join(root, 'src/game/InputState.ts'));

// Quarenta tiles bastam: o que cobra o céu é a coordenada, não a cidade, e os 140 tiles de
// alcance da fronteira ficam todos fora da malha em qualquer tamanho. O mapa é o `Map` real
// porque é ele que a física de voo consulta — um chão inventado seria exatamente o lugar onde
// uma prova de queda deixa de ser uma queda.
const WM = 40;

function mapaPlano() {
  return new CityMap({
    tilesW: WM, tilesH: WM, worldW: WM, worldH: WM,
    buildings: [], props: [], vehicles: [], npcSpawns: [],
    playerSpawn: { x: 2, y: 2 },
    tiles: Array.from({ length: WM * WM }, () => ({ kind: 'grass', key: '', biome: 'forest' })),
    heights: Float32Array.from(new Array(WM * WM).fill(0)),
  });
}

function aeronave(x, cota, id = 1) {
  const v = createVehicle(id, VEHICLE_DEFS.helicopter, 'red', x, 20, 'SE');
  v.elevation = cota;
  v.altitude = cota; // chão nivelado a zero: aqui cota e folga são o mesmo número
  return v;
}

/**
 * A costura do jogo dentro de um laço: o `MovementSystem` faz a máquina cair e a
 * `FrontierFallSystem` decide quanto a queda custa, na mesma ordem do `GameState` — física
 * primeiro, cobrança depois, porque é a posição *deste* quadro que a fronteira cobra. Provar o
 * sistema sozinho provaria a regra; é este laço que prova o helicóptero, e é só nele que a
 * profundidade em que o motor morre pode ser medida em vez de declarada.
 */
function voo(v, opts = {}) {
  const log = { falas: [], sons: [], tremores: [], dívidas: [], dívidasÁgua: [], dano: 0, struct: 0 };
  const quedas = new FF.FrontierFallSystem();
  const gorila = opts.gorila || null;
  const map = mapaPlano();
  const movement = new MovementSystem(new CollisionSystem(), () => []);
  const ctx = {
    worldW: map.worldW, worldH: map.worldH,
    vehicles: [v],
    pilotado: opts.pilotado === false ? null : v.id,
    damages: (amount) => { log.dano += amount; return true; },
    shake: (a) => log.tremores.push(a),
    say: (t, s) => log.falas.push({ t, s }),
    play: (k, volume) => log.sons.push({ k, volume }),
    // O pouso decide a quem cobrar, e as duas portas têm de existir no banco: `cobra` é a mata,
    // `cobraÁgua` é o canal. É `água` quem diz qual dos dois é — o mesmo predicado que a natação
    // e a frente usam, não uma quarta opinião sobre onde termina o rio.
    água: opts.água || SEM_RIO,
    cobra: (dívida) => { log.dívidas.push(dívida); if (gorila) gorila.cobra(dívida); },
    cobraÁgua: (dívida) => { log.dívidasÁgua.push(dívida); },
    onStructChange: () => { log.struct++; },
  };
  const voa = (ticks) => {
    for (let i = 0; i < ticks; i++) {
      movement.updateVehicle(v, map, DT);
      quedas.update(DT, ctx);
    }
  };
  // Só a cobrança, sem física: para as provas em que a altura é premissa (a copa que segura o
  // casco, o casco já parado na serapilheira) e não resultado.
  const cobra = (ticks) => { for (let i = 0; i < ticks; i++) quedas.update(DT, ctx); };
  return { log, quedas, gorila, map, voa, cobra };
}

test('o motor morre na profundidade, não na borda que a tela pinta', () => {
  input.resetInputState();
  const v = aeronave(WM - 2, CFG.HELI_CEILING_ELEVATION);
  const { log, voa } = voo(v);
  input.setJoystickInput(2, 1, 1); // frente no manche é +X no mundo: a mesma base do joystick
  let ticks = 0;
  while (!v.motorDead && ticks < 900) { voa(1); ticks++; }
  input.resetInputState();
  const prof = F.profundidade(v.x, v.y, WM, WM);
  assert.ok(v.motorDead, `voou ${prof.toFixed(0)}t de mata além do mapa e o motor não morreu`);
  assert.ok(prof >= FF.PROFUNDIDADE_DO_MOTOR && prof <= FF.PROFUNDIDADE_DO_MOTOR + 1,
    `o motor morreu a ${prof.toFixed(2)}t, não na linha de ${FF.PROFUNDIDADE_DO_MOTOR}`);
  assert.ok(log.sons.some((s) => s.k === 'rotorFail'), 'a máquina morreu sem anúncio sonoro');
  assert.ok(log.falas.some((f) => /pás morreram/.test(f.t)), 'a máquina morreu sem frase');

  // O vizinho imediato da linha, pairando: é a prova de que a fronteira aérea não é o muro
  // pintado. Aos 9,4 tiles o céu ainda é seu, e nada aqui cai.
  const beirada = aeronave(WM + FF.PROFUNDIDADE_DO_MOTOR - 0.6, CFG.HELI_CRUISE_ALTITUDE, 2);
  const b = voo(beirada);
  b.cobra(150);
  assert.equal(beirada.motorDead, false, 'o céu cobrou antes da linha');
  assert.ok(Math.abs(beirada.altitude - CFG.HELI_CRUISE_ALTITUDE) < 0.05,
    `pairando a ${beirada.altitude.toFixed(2)} sem ninguém no manche`);
});

test('a velocidade é o plano da queda: o mesmo teto, dois rigores', () => {
  // As funções puras são a regra, não um detalhe do laço: que voar rápido salva a máquina não se
  // prova olhando um número dentro de um `for`.
  const cruzeiro = CFG.HELI_CRUISE_ALTITUDE, teto = CFG.HELI_CEILING_ELEVATION;
  assert.equal(FF.rigidezDaChegada(cruzeiro, CFG.HELI_MAX_SPEED), 0,
    'a frente não amorteceu a queda da levitação');
  assert.ok(FF.rigidezDaChegada(teto, CFG.HELI_MAX_SPEED) > 5,
    'de cima, a frente não comprou plano nenhum');
  assert.ok(FF.rigidezDaChegada(teto, 0) > FF.rigidezDaChegada(teto, CFG.HELI_MAX_SPEED),
    'soltar o manche não piorou a chegada');
  assert.ok(FF.rigidezDaChegada(5, 2) > FF.rigidezDaChegada(4, 2), 'cair menos doeu igual');
  // O teto do piloto é a decisão de balanceamento, e ela é escrita aqui porque é uma escolha: o
  // chão não pode ser o verdugo, porque o pedido é a máquina quebrada *e* a fera atrás.
  assert.ok(FF.danoDoPiloto(FF.rigidezDaChegada(teto, 0)) < 100, 'o chão matou quem caiu dele');
  assert.ok(FF.danoDaCarcaça(FF.rigidezDaChegada(teto, 0)) > 100, 'a pior queda deixou o casco de pé');
  assert.ok(FF.danoDaCarcaça(0) < 100, 'um pouso amortecido desfez a máquina');
});

test('quem pilota a queda chega vivo, de máquina inteira e com a mata cobrando', () => {
  input.resetInputState();
  const v = aeronave(WM + FF.PROFUNDIDADE_DO_MOTOR, CFG.HELI_CRUISE_ALTITUDE);
  const { log, voa } = voo(v);
  input.setJoystickInput(2, 1, 1);
  let ticks = 0;
  while (v.altitude > 0.05 && ticks < 300) { voa(1); ticks++; }
  input.resetInputState();
  assert.ok(v.altitude <= 0.05, `ainda no ar depois de ${(ticks * DT).toFixed(1)} s`);
  assert.ok(v.x > WM, `a frente não levou a máquina para fora do mapa (x=${v.x.toFixed(1)})`);
  assert.ok(v.health > 0, `amorteceu e mesmo assim a máquina se desfez (${v.health})`);
  assert.equal(log.dano, FF.danoDoPiloto(0), 'o pouso amortecido cobrou outro preço que um solavanco');
  assert.ok(log.falas.some((f) => /Amorteceu/.test(f.t)), 'a HUD não contou o pouso que aconteceu');
  assert.deepEqual(log.dívidas, [1], `a descida não pagou a caçada: ${JSON.stringify(log.dívidas)}`);
});

test('a queda de focinho desfaz a máquina e entrega o piloto vivo à mata', () => {
  input.resetInputState();
  const v = aeronave(WM + FF.PROFUNDIDADE_DO_MOTOR + 2, CFG.HELI_CEILING_ELEVATION);
  const { log, voa } = voo(v);
  voa(120); // 4 s: mais do que os 2,9 s de uma queda reta de 8 tiles
  assert.ok(v.motorDead, 'nem morreu no ar');
  assert.equal(v.health, 0, `caiu de focinho e a carcaça ficou em ${v.health}`);
  assert.ok(log.dano > 0 && log.dano < 100, `o chão resolvou o piloto (${log.dano})`);
  assert.equal(log.dano, FF.danoDoPiloto(CFG.HELI_CEILING_ELEVATION), 'não foi a altura crua que cobrou');
  assert.ok(log.tremores.some((a) => a >= 1.3), 'a chegada não tremeu a tela');
  assert.ok(log.falas.some((f) => /vai explodir/.test(f.t)), 'a carcaça destruída não anunciou a explosão');
});

test('uma descida, uma cobrança: cada quadro em terra não é uma queda nova', () => {
  input.resetInputState();
  const v = aeronave(WM + FF.PROFUNDIDADE_DO_MOTOR + 2, CFG.HELI_CEILING_ELEVATION);
  const { log, voa } = voo(v);
  voa(200); // 6,7 s: passa o pouso e ainda não chega o reacender
  const contados = (k) => log.sons.filter((s) => s.k === k).length;
  assert.equal(contados('rotorFail'), 1, 'o motor morreu mais de uma vez na mesma travessia');
  assert.equal(contados('metalHit'), 1, `a terra bateu ${contados('metalHit')} vezes`);
  assert.equal(log.dívidas.length, 1, `a caçada foi cobrada ${log.dívidas.length} vezes`);
  assert.equal(log.falas.filter((f) => /Bateu/.test(f.t)).length, 1, 'a frase do pouso se repete');
});

test('o reacender é do chão: cinco segundos parado, nunca no ar', () => {
  input.resetInputState();
  const v = aeronave(WM + FF.PROFUNDIDADE_DO_MOTOR + 2, 3);
  const { log, quedas, cobra } = voo(v);
  cobra(1);
  assert.ok(v.motorDead, 'não morreu no ar');
  v.altitude = 3; v.elevation = 3;
  cobra(300); // 10 s a três tiles — a copa de uma árvore que segura o casco
  assert.ok(v.motorDead, 'o motor voltou sem tocar o chão');
  assert.ok(!log.sons.some((s) => s.k === 'engineCatch'), 'pegou no ar');
  v.altitude = 0; v.elevation = 0;
  cobra(140); // 4,67 s parado
  assert.ok(v.motorDead, 'reacendeu antes do prazo');
  v.altitude = 0;
  cobra(20); // fecha os 5 s
  assert.equal(v.motorDead, false, 'o motor não voltou depois de cinco segundos no chão');
  assert.equal(quedas.semMotor(v.id), false, 'a HUD continua devendo o SEM MOTOR');
  assert.ok(log.sons.some((s) => s.k === 'engineCatch'), 'voltou sem barulho');
  assert.ok(log.falas.some((f) => /O motor voltou/.test(f.t)), 'voltou sem aviso');
});

test('máquina pousada na mata é problema do chão, não do céu', () => {
  input.resetInputState();
  const parado = aeronave(WM + 20, 0);
  const p = voo(parado);
  p.cobra(150);
  assert.equal(parado.motorDead, false, 'o céu cobrou um casco em terra');
  assert.equal(p.quedas.semMotor(parado.id), false, 'a HUD anunciou SEM MOTOR de um helicóptero estacionado');
  assert.equal(p.log.falas.length, 0, 'a fronteira aérea falou de um objeto parado');

  const rua = Object.keys(VEHICLE_DEFS).find((k) => VEHICLE_DEFS[k].type !== 'helicopter');
  const carro = createVehicle(9, VEHICLE_DEFS[rua], 'blue', WM + 20, 20, 'SE');
  // A definição de "aeronave" é lida aqui porque é a única alavanca de um futuro avião: se o
  // catálogo ganhar um casco que voa por cota e `éAeronave` não o conhecer, a fronteira aérea
  // simplesmente não o cobra — e isso é um buraco no contrato, não um detalhe de implementação.
  assert.equal(FF.éAeronave(VEHICLE_DEFS.helicopter), true, 'o helicóptero não é aeronave');
  assert.equal(FF.éAeronave(VEHICLE_DEFS[rua]), false, `${rua} virou aeronave no papel`);
  const c = voo(carro);
  c.cobra(150);
  assert.equal(carro.motorDead, false, 'a fronteira aérea tratou um carro como aeronave');
});

test('a dívida do pouso é o atalho da caçada: a fera nasce no chão que a máquina escolheu', () => {
  input.resetInputState();
  const v = aeronave(WM + FF.PROFUNDIDADE_DO_MOTOR, CFG.HELI_CRUISE_ALTITUDE);
  const gorila = new GS.GorilaSystem();
  const f = voo(v, { gorila });
  input.setJoystickInput(2, 1, 1);
  let ticks = 0;
  while (v.altitude > 0.05 && ticks < 300) { f.voa(1); ticks++; }
  input.resetInputState();
  assert.ok(gorila.rancor >= 1, `pousou na mata devendo ${gorila.rancor.toFixed(2)} — menos que a fera`);
  // A costura é o pedido inteiro: o helicóptero cai e a coisa grande vem. Com a dívida já paga
  // pelo ar, o primeiro quadro em profundidade basta — sem ela a descida seria um susto sem
  // consequência e a caçada voltaria a ser minuto e meio de espera a pé.
  const { ctx } = mundo({ x: 100, y: -12, radius: 0.15, health: 100 });
  gorila.update(DT, ctx);
  assert.ok(gorila.fera, 'a mata cobrada pelo ar não respondeu com uma fera');
});

test('a HUD sabe por que o manche não responde', () => {
  input.resetInputState();
  const v = aeronave(WM + FF.PROFUNDIDADE_DO_MOTOR + 2, 4);
  const { quedas, cobra } = voo(v);
  assert.equal(quedas.semMotor(null), false, 'a pé a HUD inventou uma aeronave sem motor');
  assert.equal(quedas.semMotor(v.id), false, 'a HUD anunciou uma queda que não aconteceu');
  cobra(1);
  assert.ok(v.motorDead, 'não morreu');
  assert.equal(quedas.semMotor(v.id), true, 'sem motor e a HUD muda de assunto');
});

// ------------------------------------------------------- o chão sem fim
//
// `bakeFrontier` é uma função de Skia e não roda em node, então o que se prova aqui é a regra
// que ela consulta: `chãoDaFronteira` mora em `src/world/Frontier.ts` exatamente para que a
// memória possa cobrar a conta contra a cidade *gerada*, e não contra um mapa inventado. Um
// chão pintado com um tile que não existe, ou com um tile que não é o da beira, é um muro — e
// muro é o que esta frente veio derrubar.

const { generateCity } = load(path.join(root, 'src/data/maps/city.ts'));
const { vertexHeight } = load(path.join(root, 'src/world/Map.ts'));
const CITY_SRC = fs.readFileSync(path.join(root, 'src/data/maps/city.ts'), 'utf8');
const FRONTIER_SRC = fs.readFileSync(path.join(root, 'src/render/FrontierLayer.tsx'), 'utf8');

// Uma geração só: ela custa ~0,6 s e é o único jeito de medir o que a borda REAL do mapa é.
const cidade = generateCity();
const CW = cidade.tilesW, CH = cidade.tilesH;
const tileDe = (x, y) => cidade.tiles[y * CW + x];

/**
 * As bocas por onde o rio sai da grade, medidas no mapa gerado: oeste e leste da mesma linha
 * d'água que corta a cidade de lado a lado. O teste não escolhe coordenada — lê a que o
 * gerador deu, e é isso que faz a prova sobreviver a uma troca de seed.
 */
const bocas = (() => {
  const oeste = [], leste = [];
  for (let y = 0; y < CH; y++) {
    if (tileDe(0, y).kind === 'water') oeste.push(y);
    if (tileDe(CW - 1, y).kind === 'water') leste.push(y);
  }
  return { oeste, leste };
})();

test('o chão sem fim continua o material da beira, tile por tile', () => {
  // As quatro faces, em três profundidades: o losango de fora não tem linha própria, então o
  // que ele veste é a última linha da grade que está na direção do mapa — o mesmo clamp que a
  // leitura de altura usa no canto compartilhado.
  const materiais = new Set();
  for (const prof of [1, 7, 140]) {
    for (let i = 0; i < CH; i += 3) {
      for (const [fora, dentro] of [[-prof, 0], [CW - 1 + prof, CW - 1]]) {
        const esperado = tileDe(dentro, i).key || F.GRAMA_DA_CIDADE;
        const obtido = F.chãoDaFronteira(cidade.tiles, CW, CH, fora, i);
        assert.equal(obtido, esperado, `coluna ${fora}, linha ${i}: a frente veste ${obtido}, a beira é ${esperado}`);
        materiais.add(obtido);
      }
    }
    for (let i = 0; i < CW; i += 3) {
      for (const [fora, dentro] of [[-prof, 0], [CH - 1 + prof, CH - 1]]) {
        const esperado = tileDe(i, dentro).key || F.GRAMA_DA_CIDADE;
        const obtido = F.chãoDaFronteira(cidade.tiles, CW, CH, i, fora);
        assert.equal(obtido, esperado, `linha ${fora}, coluna ${i}: a frente veste ${obtido}, a beira é ${esperado}`);
        materiais.add(obtido);
      }
    }
  }
  // A savana, a praia e o rio também saem do mapa. Um único tile fixo passaria grama por cima
  // de quase metade do perímetro, e o material novo na borda é o "aqui termina" de volta.
  assert.ok(materiais.size > 1, `a fronteira voltou a ser um material só: ${[...materiais]}`);
  for (const nome of materiais) {
    assert.ok(fs.existsSync(path.join(root, 'assets/sprites/Roads and Grounds', `${nome}.png`)),
      `a frente pede um chão que não existe no pack: ${nome}`);
  }
});

test('a grama da fronteira é a MESMA grama que representa grama na cidade', () => {
  // Lido do gerador, não repetido no teste: se um dos lados trocar de arquivo, a emenda abre.
  const gramaDaCidade = CITY_SRC.match(/const GRASS = '([^']+)'/)?.[1];
  assert.ok(gramaDaCidade, 'o gerador não nomeia mais o tile de grama');
  assert.equal(F.GRAMA_DA_CIDADE, gramaDaCidade,
    `a frente veste ${F.GRAMA_DA_CIDADE} e a cidade veste ${gramaDaCidade}`);
  // E ele é mesmo o chão da beira — a regra não é um fallback escondido, é o material da
  // maioria do anel externo.
  const anel = new Map();
  for (let y = 0; y < CH; y++) {
    for (let x = 0; x < CW; x++) {
      if (x !== 0 && y !== 0 && x !== CW - 1 && y !== CH - 1) continue;
      const k = tileDe(x, y).key;
      anel.set(k, (anel.get(k) || 0) + 1);
    }
  }
  const maisComum = [...anel.entries()].sort((a, b) => b[1] - a[1])[0];
  assert.equal(maisComum[0], gramaDaCidade, `a beira da cidade não é grama, é ${maisComum[0]}`);
  // E onde a beira é grama, o losango de fora é grama: a regra não é um fallback escondido.
  let gramaNaBeira = -1;
  for (let i = 0; i < CH; i++) if (tileDe(0, i).key === gramaDaCidade) { gramaNaBeira = i; break; }
  assert.ok(gramaNaBeira >= 0, 'não há um único tile de grama na beira oeste');
  assert.equal(F.chãoDaFronteira(cidade.tiles, CW, CH, -1, gramaNaBeira), gramaDaCidade,
    'na beira gramada a frente vestiu outra coisa');
});

test('a emenda não tem degrau: o canto compartilhado é o mesmo número', () => {
  const map = new CityMap(cidade);
  // O `GroundLayer` entorta o tile de dentro pela média dos vizinhos (`vertexHeight`); a frente
  // entorta o de fora pela leitura contínua. Nos cantos inteiros — e só neles a emenda existe —
  // as duas têm de voltar o MESMO número, senão a mata nasce um tile acima do campo.
  for (let y = 0; y <= CH; y += 2) {
    for (let x = 0; x <= CW; x += 2) {
      const dentro = vertexHeight(cidade, x, y);
      const fora = map.heightSmoothAt(x, y);
      assert.ok(Math.abs(dentro - fora) < 1e-6,
        `canto (${x}, ${y}): a cidade pinta ${dentro.toFixed(5)} e a mata apoia em ${fora.toFixed(5)}`);
    }
  }
  // Fora da grade a superfície satura na linha da borda em vez de cair para zero: é isso que
  // deita a mata no degrau. Um `NaN` aqui derrubaria o canvas inteiro, e um salto de um dia
  // inteiro seria o muro pintado.
  for (const d of [1, 2, 40]) {
    for (const par of [0, Math.floor(CH / 2), CH - 1]) {
      // O número da CIDADE no canto mais a leste que existe — é nele que o tile de fora tem de
      // se apoiar. `cornerH` é Float32 e a média de `vertexHeight` é double, daí a régua.
      const borda = vertexHeight(cidade, CW, par);
      assert.ok(Number.isFinite(map.heightSmoothAt(CW + d, par)), 'a frente deu NaN fora do mapa');
      assert.ok(Math.abs(map.heightSmoothAt(CW + d, par) - borda) < 1e-6,
        `a cota caiu do degrau a ${d} tiles da borda: ${borda} -> ${map.heightSmoothAt(CW + d, par)}`);
    }
  }
});

test('o rio que sai do mapa continua fora dele com a largura da boca', () => {
  const rio = new CityMap(cidade);
  assert.ok(bocas.oeste.length >= 4, `a boca oeste encolheu: ${bocas.oeste.length} tile(s)`);
  assert.deepEqual(bocas.oeste, bocas.leste, 'o rio não entra e sai pela mesma linha dágua');
  const margemNorte = Math.min(...bocas.oeste) - 1;
  const margemSul = Math.max(...bocas.oeste) + 1;
  for (const d of [1, 40, F.FRONTEIRA_ALCANCE - 1]) {
    for (const y of bocas.oeste) {
      assert.ok(rio.isWaterWorld(-d + 0.5, y + 0.5), `a ${d} tiles a oeste a água secou na linha ${y}`);
    }
    // O canal não alarga nem estreita: margem continua margem a 140 tiles da borda.
    assert.equal(rio.isWaterWorld(-d + 0.5, margemNorte + 0.5), false, 'o rio sem fim vazou para o norte');
    assert.equal(rio.isWaterWorld(-d + 0.5, margemSul + 0.5), false, 'o rio sem fim vazou para o sul');
  }
  // E nem tudo que sai do mapa é rio: onde a beira é campo, o campo continua.
  assert.equal(rio.isWaterWorld(CW / 2, -12), false, 'a frente inventou água onde a beira é grama');
  for (const y of bocas.leste) {
    assert.ok(rio.isWaterWorld(CW - 1 + 60 + 0.5, y + 0.5), `o leste não continuou o rio na linha ${y}`);
  }
});

test('a mata não planta no canal, e planta na margem', () => {
  const rio = new CityMap(cidade);
  for (const d of [1, 5, 60, F.FRONTEIRA_ALCANCE - 1]) {
    for (const y of bocas.oeste) {
      assert.equal(F.árvoreDoTile(-d, y, CW, CH, rio), null,
        `tronco dentro do rio em (-${d}, ${y}): a mata fecharia a única saída líquida`);
    }
  }
  // A prova de cima não pode ter virado "o mundo ficou sem árvore": na margem a mata é a de
  // sempre, e é este número que diz que o corte foi no canal, não na floresta.
  let troncos = 0;
  for (let d = 1; d <= 60; d++) {
    for (let y = 40; y < 100; y++) if (F.árvoreDoTile(-d, y, CW, CH, rio)) troncos++;
  }
  assert.ok(troncos > 200, `a margem só tinha ${troncos} troncos: ou a mata sumiu, ou nada foi cortado`);
});

test('quem desce ao canal além do limite é posto a nadar de verdade', () => {
  input.resetInputState();
  const rio = new CityMap(cidade);
  const doMeio = bocas.oeste[Math.floor(bocas.oeste.length / 2)];
  const p = createPlayer(-6.5, doMeio + 0.5);
  const movimento = new MovementSystem(new CollisionSystem(), () => []);
  for (let i = 0; i < 30; i++) movimento.updatePlayer(p, rio, DT, false);
  assert.equal(p.swimming, true, 'em pleno rio sem fim o jogador andou no seco');
  assert.equal(p.anim, 'swim', `a natação mostrou a animação ${p.anim}`);
  // Na margem ao lado, a mesma profundidade é terra: senão isto seria só "tudo é rio".
  p.x = -6.5; p.y = Math.min(...bocas.oeste) - 3.5;
  movimento.updatePlayer(p, rio, DT, false);
  assert.equal(p.swimming, false, 'a margem do rio virou água');
});

test('uma só mão para o losango inclinado, e o sprite vem da regra', () => {
  // O losango entortado tem DONO: o `GroundLayer`. A frente importa e usa; reimplementar é a
  // emenda que o contrato do relevo proíbe, porque as duas mãos envelhecem diferente.
  assert.match(FRONTIER_SRC, /import \{[^}]*\bdrawTiltedTile\b[^}]*\} from '\.\/GroundLayer'/,
    'a frente voltou a desenhar o próprio losango inclinado');
  assert.ok(!/function drawTiltedTile/.test(FRONTIER_SRC), 'há duas implementações de tile inclinado');
  assert.ok(FRONTIER_SRC.includes('chãoDaFronteira('), 'a frente escolhe o tile sozinha de novo');
  assert.ok(FRONTIER_SRC.includes('drawTiltedTile(canvas'), 'o tile da cidade não é entortado no relevo');
  // A pinta por coordenada continua existindo, mas só como o que é: o chão antes do sprite
  // chegar. Sem ela, o boot mostra o verde-de-tela que esta camada veio substituir.
  assert.ok(FRONTIER_SRC.includes('tintaDoChão('), 'sumiu o chão de reserva antes do tile carregar');
});

// ---------------------------------------------------------------- o rio sem fim

const P = load(path.join(root, 'src/entities/Piranha.ts'));
const PS = load(path.join(root, 'src/systems/PiranhaSystem.ts'));

/**
 * O banco da barbatana: o `Map` real gerado, com o rio que sai pela boca oeste. Não é um canal
 * inventado porque a regra que está sendo provada é justamente *onde* o rio existe — e só o
 * gerador sabe quais linhas d'água atravessam a beira. Um `isWaterWorld` de mentira provaria a
 * aritmética do sistema e deixaria passar a piranha caçando em terra.
 */
const RIO = new CityMap(cidade);
const BOCA = bocas.oeste[Math.floor(bocas.oeste.length / 2)];

/** Um corpo na água: o que o sistema lê do jogador são três campos, e só eles. */
function nadador(d = -8, y = BOCA + 0.5, swimming = true) {
  return { x: d, y, swimming, health: 100, radius: 0.15 };
}

function rio(player, opts = {}) { return mundo(player, { ...opts, água: RIO }); }

/**
 * Uma gota d'água DENTRO da grade, lida do mesmo `Map` que o sistema lê. A procura é varrida
 * no mapa gerado em vez de chutada numa coordenada: "o rio da cidade" é exatamente o lugar que
 * a prova precisa nomear, e um (CW/2, boca) seco deixaria a interseção ser provada por acidente
 * — a asserção passaria contra um `podeNadar` que esqueceu a grade, que é o defeito que ela
 * existe para pegar.
 */
function águaDaCidade() {
  for (let y = 40; y < CH - 40; y++) {
    for (let x = 40; x < CW - 40; x++) {
      if (RIO.isWaterWorld(x + 0.5, y + 0.5)) return { x: x + 0.5, y: y + 0.5 };
    }
  }
  throw new Error('o mapa gerado não tem água nenhuma dentro da grade');
}
const NO_RIO_DA_CIDADE = águaDaCidade();

test('podeNadar é a interseção das duas proibições: fora da grade E em cima da água', () => {
  // Dentro da grade, em pleno rio da cidade: não é a frente, é a ponte da avenida. Uma leitura
  // só de `isWaterWorld` transformaria o canal urbano em campo de morte.
  assert.equal(RIO.isWaterWorld(NO_RIO_DA_CIDADE.x, NO_RIO_DA_CIDADE.y), true,
    'a amostra da cidade não é água — a prova de baixo não prova nada');
  assert.equal(F.foraDoMapa(NO_RIO_DA_CIDADE.x, NO_RIO_DA_CIDADE.y, CW, CH), false,
    'a amostra da cidade já está fora da grade');
  assert.equal(PS.podeNadar(NO_RIO_DA_CIDADE.x, NO_RIO_DA_CIDADE.y, CW, CH, RIO), false,
    'a cidade virou rio sem fim');
  // Fora da grade, na margem: é mata, e a mata já tem dono — o gigante.
  assert.equal(PS.podeNadar(-8.5, Math.min(...bocas.oeste) - 3.5, CW, CH, RIO), false,
    'a terra além da borda foi contada como canal');
  // Fora da grade, dentro do canal: a única resposta que liga a fera.
  assert.equal(PS.podeNadar(-8.5, BOCA + 0.5, CW, CH, RIO), true, 'o rio sem fim não deixa nadar');
  // `noRioSemFim` é a mesma porta com o `swimming` em cima: parado na beira não se nada.
  assert.equal(PS.noRioSemFim(nadador(), CW, CH, RIO), true);
  assert.equal(PS.noRioSemFim(nadador(-8, BOCA + 0.5, false), CW, CH, RIO), false,
    'quem está de pé no leito seco está sendo caçado');
  assert.equal(PS.noRioSemFim(null, CW, CH, RIO), false, 'sem jogador há presa');
});

test('a régua da água: mais fundo cobra mais, satura, e ele nada mais rápido que você', () => {
  assert.ok(PS.taxaDaCobrançaNaÁgua(40) > PS.taxaDaCobrançaNaÁgua(6), 'o rio fundo cobra igual à boca');
  assert.equal(PS.taxaDaCobrançaNaÁgua(400), PS.taxaDaCobrançaNaÁgua(80), 'a taxa não tem teto');
  assert.equal(PS.taxaDaCobrançaNaÁgua(-5), PS.taxaDaCobrançaNaÁgua(0), 'profundidade negativa cobraria');
  // A razão de existir do rio: a única saída é a margem, e isto é o que garante a frase.
  const nado = CFG.PLAYER_SWIM_SPEED;
  assert.ok(PS.velocidadeDaPiranha(0) > nado, `nascendo calma ela anda ${PS.velocidadeDaPiranha(0)} contra ${nado}`);
  assert.ok(PS.velocidadeDaPiranha(2.4) > PS.velocidadeDaPiranha(0), 'o rancor não acelera nada');
});

test('a cidade não caça ninguém: 60 s nadando no rio dentro da grade e a dívida fica em zero', () => {
  const system = new PS.PiranhaSystem();
  const player = nadador(NO_RIO_DA_CIDADE.x, NO_RIO_DA_CIDADE.y);
  const { ctx, log } = rio(player);
  anda(system, ctx, 60);
  assert.equal(system.rancor, 0, 'a ponte da avenida cobrou algo');
  assert.equal(system.fera, null, 'nasceu piranha na cidade');
  assert.equal(log.falas.length, 0, 'a HUD falou sem razão');
});

test('fora do rio e fora da grade a dívida congela: não cresce, não apaga', () => {
  const system = new PS.PiranhaSystem();
  system.rancor = 1;
  // Na margem, a pé: o mesmo trecho que o rio não cobra, a mata cobra — e é o `GorilaSystem`
  // que está lá. Se ela caísse aqui, atravessar a borda a nado e voltar para a terra apagaria o
  // preço do que se fez na água.
  const player = nadador(-20, Math.min(...bocas.oeste) - 3.5, false);
  const { ctx } = rio(player);
  anda(system, ctx, 60);
  assert.equal(system.rancor, 1, 'a dívida evaporou na margem');
});

test('primeiro o aviso, depois a fera — e o aviso não se repete', () => {
  const system = new PS.PiranhaSystem();
  const player = nadador(-14);
  const { ctx, log } = rio(player);
  let avisoEm = -1, feraEm = -1;
  for (let t = 0; feraEm < 0 && t < 400; t += DT) {
    system.update(DT, ctx);
    if (avisoEm < 0 && log.falas.length) avisoEm = t;
    if (feraEm < 0 && system.fera) feraEm = t;
  }
  assert.ok(avisoEm >= 0, 'o rio nunca avisou');
  assert.ok(feraEm > avisoEm, `fera (${feraEm}) antes do aviso (${avisoEm})`);
  assert.ok(feraEm - avisoEm > 5, 'entre o aviso e a barbatana não há tempo de escolher correr');
  const falasDoAviso = log.falas.filter((f) => /fundo demais/.test(f.t)).length;
  assert.equal(falasDoAviso, 1, 'o aviso se repetiu na mesma dívida');
  assert.ok(log.sons.some((s) => s.k === 'piranhaThreat'), 'o aviso não teve som');
});

test('a barbatana nasce sempre mais fundo no mesmo canal, nunca na margem', () => {
  for (const d of [-6, -14, -40, -95]) {
    for (const y of bocas.oeste) {
      const system = new PS.PiranhaSystem();
      system.rancor = 2;
      const player = nadador(d, y + 0.5);
      const { ctx } = rio(player);
      system.update(DT, ctx);
      assert.ok(system.fera, `nenhuma piranha em (${d}, ${y})`);
      const p = system.fera;
      assert.ok(PS.podeNadar(p.x, p.y, CW, CH, RIO), `nasceu fora d'água em (${p.x.toFixed(1)}, ${p.y.toFixed(1)})`);
      assert.ok(F.foraDoMapa(p.x, p.y, CW, CH), 'nasceu dentro da cidade');
      const minha = F.profundidade(player.x, player.y, CW, CH);
      assert.ok(F.profundidade(p.x, p.y, CW, CH) > minha, 'nasceu mais rasa que você');
      const distância = Math.hypot(p.x - player.x, p.y - player.y);
      assert.ok(distância >= 12 && distância <= 22, `emergência a ${distância.toFixed(1)} tiles, fora da janela`);
      assert.equal(p.estado, 'espreitando', 'ela já nasceu correndo');
    }
  }
});

test('a boca rasa não caça: a três tiles do limite ela ainda não sobe', () => {
  // A regra que devolve a fronteira a quem só molhou os pés: `profundidade` é o quanto você
  // atravessou, e enquanto for um passo o canal é seu. Sem a barreira de profundidade o rio
  // caçaria quem encostou na beira — e a única fuga disso seria voltar, que já era a fuga antes.
  for (const d of [-1, -2, -3]) {
    const system = new PS.PiranhaSystem();
    system.rancor = 2;
    const player = nadador(d, BOCA + 0.5);
    const { ctx, log } = rio(player);
    assert.equal(PS.noRioSemFim(player, CW, CH, RIO), true, `(${d}, boca) não é água livre`);
    anda(system, ctx, 60);
    assert.equal(system.fera, null, `nasceu barbatana a ${-d} tiles do limite`);
    assert.ok(log.falas.some((f) => /fundo demais/.test(f.t)), 'o rio parou de avisar na boca rasa');
  }
  // E a quatro tiles, que é a régua, ela sobe: a barreira é a profundidade, não a distância do
  // aviso. Sem este caso espelho, o teste de cima passaria com a fera proibida de nascer nunca.
  const fundo = new PS.PiranhaSystem();
  fundo.rancor = 2;
  fundo.update(DT, rio(nadador(-4, BOCA + 0.5)).ctx);
  assert.ok(fundo.fera, 'a barreira engoliu a caçada que ela mesma autoriza');
});

test('a mesma coordenada dá a mesma emboscada em qualquer aparelho', () => {
  for (let i = 0; i < 25; i++) {
    const px = -12 - i * 1.7, py = bocas.oeste[i % bocas.oeste.length] + 0.5;
    const a = new PS.PiranhaSystem();
    const b = new PS.PiranhaSystem();
    a.rancor = 2;
    b.rancor = 2;
    a.update(DT, rio(nadador(px, py)).ctx);
    b.update(DT, rio(nadador(px, py)).ctx);
    assert.ok(a.fera && b.fera, `nenhuma piranha em (${px.toFixed(1)}, ${py})`);
    assert.deepEqual({ x: a.fera.x, y: a.fera.y, dir: a.fera.dir, rancor: a.fera.rancor },
      { x: b.fera.x, y: b.fera.y, dir: b.fera.dir, rancor: b.fera.rancor },
      `emboscada divergiu em (${px.toFixed(1)}, ${py})`);
  }
});

test('o passo dela nunca sai do canal nem entra na cidade', () => {
  const system = new PS.PiranhaSystem();
  const player = nadador(-16);
  const { ctx } = rio(player);
  system.rancor = 2;
  system.update(DT, ctx);
  assert.ok(system.fera, 'a fera não subiu para a caçada');
  let andadas = 0;
  for (let i = 0; i < 900; i++) {
    // A presa se mexe pelo canal, como se move quem joga: sem isto a fera ficaria parada e a
    // prova de deslocamento não deslocaria nada.
    const p = system.fera;
    if (p) {
      player.x = -16 + Math.sin(i / 40) * 3;
      player.y = BOCA + 0.5 + Math.cos(i / 55) * 2;
    }
    system.update(DT, ctx);
    const agora = system.fera;
    if (!agora || agora.morto) continue;
    if (agora.velocidade > 0) andadas++;
    assert.ok(PS.podeNadar(agora.x, agora.y, CW, CH, RIO),
      `saiu do rio em (${agora.x.toFixed(2)}, ${agora.y.toFixed(2)}) estado ${agora.estado}`);
    assert.ok(F.foraDoMapa(agora.x, agora.y, CW, CH), 'entrou na cidade nadando');
  }
  assert.ok(andadas > 200, `ela quase não andou: ${andadas} quadros com velocidade`);
});

test('sair da água a faz afundar: ela não sobe na margem nem nada para dentro', () => {
  const system = new PS.PiranhaSystem();
  const player = nadador(-16);
  const { ctx, log } = rio(player);
  system.rancor = 2;
  system.update(DT, ctx);
  assert.ok(system.fera, 'a fera não subiu');
  // Na margem: o único lugar do trecho onde ela não entra.
  player.swimming = false;
  player.y = Math.min(...bocas.oeste) - 3.5;
  for (let i = 0; i < 600 && system.fera; i++) system.update(DT, ctx);
  assert.ok(log.falas.some((f) => /não sai da água/.test(f.t)), 'a HUD não explicou o recuo');
  assert.equal(system.fera, null, 'ela ficou rondando a margem para sempre');
  assert.ok(system.rancor <= 0.62, `a dívida não caiu com a retirada: ${system.rancor}`);
});

test('a dentada chega, machuca uma vez e cospe o nadador para fora do alcance', () => {
  const system = new PS.PiranhaSystem();
  const player = nadador(-16);
  const { ctx, log } = rio(player);
  system.rancor = 2;
  system.update(DT, ctx);
  const fera = system.fera;
  assert.ok(fera);
  // posta ao lado do nadador e fora da pose de aviso: o que se quer medir aqui é o bote, não os
  // dezoito segundos de volta que a caçada leva para chegar até ele.
  fera.x = player.x - 1;
  fera.y = player.y;
  fera.estado = 'rodeando';
  fera.golpe = 0;
  const antes = { x: player.x, y: player.y };
  const quadros = [];
  let ticks = 0;
  while (player.health === 100 && ticks < 120) {
    quadros.push({ estado: fera.estado, espera: fera.espera, vida: player.health });
    system.update(DT, ctx);
    ticks++;
  }
  assert.ok(player.health < 100, 'a uma tile de distância, ela nunca mordeu');
  // O windup é uma pose, não um número: tem de existir um quadro em que ela já decidiu o bote,
  // o relógio do salto ainda está correndo e a sua vida ainda é a de antes. Sem esse intervalo
  // a barbatana não afunda nada e a mordida é um dano caindo do céu sem aviso.
  const windup = quadros.filter((q) => q.estado === 'saltando' && q.vida === 100);
  assert.ok(windup.length >= 2, `o bote não teve windup visível: ${windup.length} quadro(s)`);
  assert.ok(windup[0].espera > 0, 'o windup não publicou relógio para o sprite ler');
  assert.equal(100 - player.health, P.PIRANHA_DANO_MORDIDA,
    'a mordida não passou uma única vez pelo HealthSystem');
  // O recuo é para longe dela — é o que impede três lances de virarem afogamento automático.
  const empurrada = Math.hypot(player.x - antes.x, player.y - antes.y);
  assert.ok(empurrada > 1 && empurrada < 1.4, `a dentada empurrou ${empurrada.toFixed(2)} tiles`);
  assert.ok(log.sons.some((s) => s.k === 'bodyHit'), 'a mordida não fez som de corpo');
  assert.ok(log.tremores.some((a) => a >= 1), 'a mordida não tremeu a tela');
  assert.ok(fera.golpe > 0, 'ela morde de novo no mesmo instante');
});

test('atirar não espanta, acelera', () => {
  const system = new PS.PiranhaSystem();
  const player = nadador(-16);
  const { ctx } = rio(player);
  system.rancor = 2;
  system.update(DT, ctx);
  const fera = system.fera;
  assert.ok(fera);
  fera.estado = 'retirando'; // a prova de que um tiro não a deixa fugir
  const rancorAntes = fera.rancor;
  const antes = PS.velocidadeDaPiranha(rancorAntes);
  assert.equal(system.fere(60), false, 'um tiro de 60 matou uma piranha de 420');
  assert.ok(fera.rancor > rancorAntes, `o tiro não a deixou mais brava: ${fera.rancor}`);
  assert.equal(fera.estado, 'rodeando', 'o tiro a pôs para fora do canal');
  assert.ok(PS.velocidadeDaPiranha(fera.rancor) > antes, 'a raiva não virou velocidade');
  assert.ok(system.fera === fera, 'ela sumiu do mundo com um tiro');
});

test('matar não perdoa: o corpo boia, afunda e a dívida cai para o piso', () => {
  const system = new PS.PiranhaSystem();
  const player = nadador(-16);
  const { ctx, log } = rio(player);
  system.rancor = 2;
  system.update(DT, ctx);
  const fera = system.fera;
  assert.ok(fera);
  const cadências = [];
  let t = 0;
  while (!fera.morto && t < 120) {
    if (system.fere(60)) break;
    cadências.push(t);
    t += 0.2;
    system.update(DT, ctx);
  }
  assert.ok(fera.morto, 'doze tiros de 60 não mataram uma piranha de 420');
  assert.ok(cadências.length >= 6, `${fera.vida} de vida caiu em ${cadências.length} tiros`);
  assert.equal(system.fera, fera, 'o sistema esqueceu o cadáver antes da hora');
  assert.ok(P.piranhaVisível({ morto: true, deathTimer: 0 }), 'um corpo recém-boiando saiu da fila');
  // A dívida com o corpo ainda boiando, lida tick a tick. Comparar só com o instante do tiro
  // deixaria passar a forma errada do `encerra`: sobre a carcaça o rio volta a cobrar, então o
  // preço já subiu quando ela some — e é esse preço que o afundar não pode derrubar. `piso` é
  // "o máximo entre o que você deve e o piso"; `teto` derruba para 1,3, e é exatamente aí que
  // "matar não perdoa" vira "matar zera a conta".
  const dívidaNaMorte = system.rancor;
  let afundouEm = -1, dívidaNoAfundar = 0, dívidaComCorpoNaÁgua = dívidaNaMorte;
  const ticksAtéAfundar = Math.round((P.PIRANHA_CADAVER_S + 4) / DT);
  for (let i = 0; afundouEm < 0 && i < ticksAtéAfundar; i++) {
    if (system.fera) dívidaComCorpoNaÁgua = system.rancor;
    system.update(DT, ctx);
    if (system.fera === null) { afundouEm = i; dívidaNoAfundar = system.rancor; }
  }
  assert.ok(afundouEm >= 0, 'a carcaça não afundou');
  assert.ok(log.falas.some((f) => /afundou/.test(f.t)), 'a morte não foi dita');
  assert.ok(dívidaComCorpoNaÁgua > 1.3,
    `a carcaça não voltou a cobrar o canal: ${dívidaComCorpoNaÁgua.toFixed(2)}`);
  assert.ok(dívidaNoAfundar >= dívidaComCorpoNaÁgua,
    `matar devolveu parte da dívida: ${dívidaComCorpoNaÁgua.toFixed(2)} → ${dívidaNoAfundar.toFixed(2)}`);
  assert.ok(dívidaNoAfundar >= 1.3, `o afundar zerou a dívida: ${dívidaNoAfundar}`);
});

test('as duas feras nunca cobram o mesmo trecho: na água a mata fica quieta', () => {
  // O contrato da partilha, lido dos dois lados no mesmo banco de água.
  const player = nadador(-20);
  const { ctx: doGorila, log: logDoGorila } = rio({ x: player.x, y: player.y, radius: 0.15, health: 100 });
  const gorila = new GS.GorilaSystem();
  anda(gorila, doGorila, 180);
  assert.equal(gorila.rancor, 0, 'o gigante cobrou quem nada no rio');
  assert.equal(gorila.fera, null, 'o gigante nasceu no meio do canal');
  assert.equal(logDoGorila.falas.length, 0, 'a mata avisou dentro do canal');

  const nadando = nadador(-20);
  const { ctx: doRio } = rio(nadando);
  const piranha = new PS.PiranhaSystem();
  anda(piranha, doRio, 180);
  assert.ok(piranha.rancor > 0.4, 'o rio não cobrou o nadador');
  assert.ok(piranha.fera, 'o nadador não foi caçado');

  // E na margem do mesmo rio é o inverso: a terra cobra, a barbatana não.
  const { ctx: naTerra } = rio({ x: -20, y: Math.min(...bocas.oeste) - 3.5, radius: 0.15, health: 100 });
  const gigante = new GS.GorilaSystem();
  anda(gigante, naTerra, 180);
  assert.ok(gigante.rancor > 0.4, 'a margem do rio virou território neutro');
});

test('um casco que desce sobre o canal cobra a barbatana, não a mata', () => {
  input.resetInputState();
  // A água é um predicado injetado no banco, e é de propósito: o que se prova aqui é a ESCOLHA
  // de quem cobra, e a escolha é uma leitura de `podeNadar`. Um mapa com rio desenhado provaria
  // o desenho de novo, não o roteamento.
  const emTodoLugar = { isWaterWorld: () => true };
  const v = aeronave(WM - 2, CFG.HELI_CEILING_ELEVATION);
  const molhado = voo(v, { água: emTodoLugar });
  input.setJoystickInput(2, 1, 1);
  let ticks = 0;
  while (v.altitude > 0.05 && ticks < 900) { molhado.voa(1); ticks++; }
  input.resetInputState();
  assert.ok(v.altitude <= 0.05, 'não pousou em 30 s de queda');
  assert.ok(F.foraDoMapa(v.x, v.y, WM, WM), `pousou dentro do mapa (x=${v.x.toFixed(1)})`);
  assert.equal(molhado.log.dívidas.length, 0, 'a queda no rio cobrou a mata');
  assert.equal(molhado.log.dívidasÁgua.length, 1, 'a queda no rio não cobrou o canal');
  // A mesma máquina, a mesma queda, sem rio nenhum: agora é a mata que recebe a dívida. Sem este
  // segundo caso, "cobra a barbatana" poderia ser só "não cobra ninguém".
  const v2 = aeronave(WM - 2, CFG.HELI_CEILING_ELEVATION);
  const seco = voo(v2, { água: SEM_RIO });
  input.setJoystickInput(2, 1, 1);
  let t2 = 0;
  while (v2.altitude > 0.05 && t2 < 900) { seco.voa(1); t2++; }
  input.resetInputState();
  assert.equal(seco.log.dívidasÁgua.length, 0, 'o pouso em terra chamou a piranha');
  assert.equal(seco.log.dívidas.length, 1, 'o pouso em terra não cobrou a mata');
});

test('a ponte da queda com o rio: a dívida entra pela mão certa do sistema', () => {
  const system = new PS.PiranhaSystem();
  assert.equal(system.fera, null);
  system.cobra(1.9);
  assert.equal(system.rancor, 1.9, 'a dívida do voo não foi cobrada');
  system.cobra(0.5);
  assert.equal(system.rancor, 1.9, 'cobrar menos baixou a dívida');
  system.cobra(NaN);
  system.cobra(-3);
  assert.equal(system.rancor, 1.9, 'um NaN virou dívida');
  system.cobra(99);
  assert.ok(system.rancor <= 2.4, `a ponte estourou o teto: ${system.rancor}`);
});

console.log(`\n${passed} passaram, ${failed} falharam`);process.exit(failed ? 1 : 0);
