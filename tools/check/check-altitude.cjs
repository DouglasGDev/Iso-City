// Run: node tools/check/check-altitude.cjs
//
// Oráculo da coluna de ar. O contrato que ele guarda é a razão de o jogo continuar isométrico
// depois de soltar o voo: abaixo da linha de passagem a altura É pixel de tela, exatamente como
// sempre foi, e acima dela a altura vira escala e nuvem — nunca um sprite que escorrega para fora
// do quadro. Um check que relaxa a primeira parte deixa de medir o voo raso; um que aceita muro no
// número (clamp no teto) deixa de medir ar.
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');
const source = (name) => path.join(root, 'src', name);
const program = ts.createProgram([
  source('systems/AltitudeSystem.ts'), source('systems/AltitudeAudioSystem.ts'),
  source('systems/MovementSystem.ts'), source('systems/AirSupportSystem.ts'),
], {
  target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, moduleResolution: ts.ModuleResolutionKind.Node10,
  strict: true, esModuleInterop: true, skipLibCheck: true, noEmit: true, jsx: ts.JsxEmit.ReactJSX,
});
const diagnostics = ts.getPreEmitDiagnostics(program);
if (diagnostics.length) {
  console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCurrentDirectory: () => root, getCanonicalFileName: (f) => f, getNewLine: () => '\n',
  }));
  process.exit(1);
}
require.extensions['.ts'] = (module, filename) => {
  const { outputText } = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    fileName: filename,
  });
  module._compile(outputText, filename);
};
const stub = (name, exports) => {
  const filename = source(name);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
};
stub('audio/SoundManager.ts', { sound: { play() {}, setLoop() {} } });
stub('assets/AssetRegistry.ts', { spriteKeyForVehicle: () => '' });
const load = (name) => require(source(name + '.ts'));
const { GAME_CONFIG } = load('game/GameConfig');
const { ELEVATION_PX } = load('world/IsoUtils');
const { Map: CityMap } = load('world/Map');
const { CollisionSystem } = load('systems/CollisionSystem');
const { MovementSystem } = load('systems/MovementSystem');
const { AltitudeSystem, alturaDeTela, ancoraDaCamera, folgaDoQuadro, liftDeTela, cidadeNaCota,
  zoomDaAltura, mantaEm, nuvemNoCampo, ALTURA_DE_TELA_MAX } = load('systems/AltitudeSystem');
const { AltitudeAudioSystem } = load('systems/AltitudeAudioSystem');
const { AirSupportSystem } = load('systems/AirSupportSystem');
const { createVehicle } = load('entities/Vehicle');
const { VEHICLE_DEFS } = load('data/vehicles');
const input = load('game/InputState');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`OK ${name}`); }
  catch (error) { failed++; process.exitCode = 1; console.error(`FAIL ${name}`, error && error.message ? error.message : error); }
}
function check(condition, message) { assert.ok(condition, message); }

const MAO = GAME_CONFIG.HELI_CEILING_ELEVATION;
const TETO = GAME_CONFIG.CEU_TETO;

/** Chão plano de 24x24 sem pedra nenhuma: aqui se mede o ar, não o relevo. */
function plainMap() {
  const W = 24;
  return new CityMap({
    tilesW: W, tilesH: W, worldW: W, worldH: W, buildings: [], props: [], vehicles: [],
    npcSpawns: [], playerSpawn: { x: 1.5, y: 1.5 },
    tiles: Array.from({ length: W * W }, () => ({ kind: 'grass', key: '', biome: 'forest' })),
    heights: Float32Array.from(new Array(W * W).fill(0)),
  });
}

/** Instantâneo de ar escrito à mão: é a coluna que o movimento lê, sem clima no meio. */
const ar = (over) => Object.assign({
  cota: 0, chao: 0, teto: MAO, base: 30, topo: 35, dentro: 0, acima: 0, visivel: 1,
  rarefeito: 0, cidade: 1, ventoX: 0, ventoY: 0,
}, over);

test('abaixo da mão-de-passagem a altura continua sendo pixel de tela', () => {
  // Identidade exata, não aproximada: é o que garante que o voo raso não se moveu um décimo de
  // pixel e que `check-terrain`, `check-relief` e o do sombreamento medem a mesma lataria de antes.
  for (let cota = 0; cota <= MAO; cota += 0.25) {
    check(alturaDeTela(cota) === cota, `alturaDeTela(${cota}) = ${alturaDeTela(cota)}`);
  }
  for (const chao of [0, 2, 4]) {
    // A folga do quadro é o que a medição no navegador manda: meio quadro de 600 px ao zoom da
    // rua. É em pixels, e é ela que diz até onde a lataria sobe antes de a câmera ir junto.
    const margem = folgaDoQuadro(600, GAME_CONFIG.ZOOM_DEFAULT);
    for (let folga = 0; folga <= MAO - chao; folga += 0.5) {
      check(Math.abs(liftDeTela(chao + folga, chao) - folga * ELEVATION_PX) < 1e-9,
        `lift de ${folga} sobre o chão ${chao} saiu da escala do relevo`);
      const ancora = ancoraDaCamera(chao + folga, chao, margem);
      // Dentro da folga a câmera mira o chão de sempre: nenhum pixel do voo raso se moveu.
      if (folga <= margem) check(ancora === chao, `a câmera mexeu no voo raso (chão ${chao}, ${folga})`);
      // E fora dela a lataria para na folga, não fora da tela.
      const lift = (alturaDeTela(chao + folga) - ancora) * ELEVATION_PX;
      check(lift <= margem * ELEVATION_PX + 1e-9,
        `a lataria passou da folga do quadro (${lift.toFixed(1)}px sobre ${margem * ELEVATION_PX}px)`);
    }
  }
  // E o zoom também não encosta onde a cidade ainda é o chão.
  check(zoomDaAltura(0) === GAME_CONFIG.ZOOM_DEFAULT);
  check(zoomDaAltura(MAO) === GAME_CONFIG.ZOOM_DEFAULT);
  check(cidadeNaCota(MAO) === 1, 'a cidade sumiu ainda no voo raso');
});

test('acima da linha a tela satura e é o mundo que encolhe', () => {
  let anterior = -1;
  for (let cota = MAO; cota <= TETO * 2; cota += 0.5) {
    const atual = alturaDeTela(cota);
    check(atual > anterior, `a curva de tela deixou de subir em ${cota}`);
    check(atual < MAO + ALTURA_DE_TELA_MAX, `a tela passou do próprio teto (${atual})`);
    anterior = atual;
  }
  // Subir continua movendo a máquina na tela, só que cada vez menos: senão a curva seria um clamp.
  check(alturaDeTela(46) - alturaDeTela(20) > 1.5, 'a curva achatou antes da hora');
  // A curva é função PURA da cota: o mesmo andar na subida e na descida devolve o mesmo quadro.
  for (let cota = 9; cota <= TETO; cota += 3) {
    check(alturaDeTela(cota) === alturaDeTela(Number(cota.toFixed(4))), 'a tela tem memória');
  }
  // A lataria para no quadro em vez de ir embora: o par curva+âncora tem limite conhecido, e o
  // limite é a TELA. Este é o exato número que a sonda do navegador mediu quebrado -- 8 tiles de
  // folga são 8 * 64 * 1,55 = 794 pixels acima do centro num quadro de 600, ou seja, o helicóptero
  // voava para fora da própria tela muito antes de encostar na nuvem.
  for (const [viewH, zoom] of [[600, GAME_CONFIG.ZOOM_DEFAULT], [600, GAME_CONFIG.ZOOM_ALTO],
    [360, GAME_CONFIG.ZOOM_DEFAULT], [1200, GAME_CONFIG.ZOOM_ALTO]]) {
    const margem = folgaDoQuadro(viewH, zoom);
    const px = (alturaDeTela(9999) - ancoraDaCamera(9999, 0, margem)) * ELEVATION_PX * zoom;
    check(px <= GAME_CONFIG.ALTURA_NO_QUADRO * viewH / 2 + 1e-6,
      `no teto do céu a máquina está a ${px.toFixed(0)}px do centro num quadro de ${viewH}px `
      + `ao zoom ${zoom}`);
  }
  // E o que cresce no lugar da translação é a escala do mundo.
  check(zoomDaAltura(20) < GAME_CONFIG.ZOOM_DEFAULT, 'o mundo não afastou a 20 tiles');
  check(zoomDaAltura(TETO) === GAME_CONFIG.ZOOM_ALTO, 'o zoom não chegou ao piso no teto');
  check(zoomDaAltura(20) > zoomDaAltura(TETO), 'o zoom inverteu no meio do caminho');
  check(cidadeNaCota(TETO) === 0, 'a cidade ainda era chão lá em cima');
});

test('o ar rarefeito murcha a subida em vez de bater num clamp', () => {
  const map = plainMap();
  const movement = new MovementSystem(new CollisionSystem(), () => []);
  const voa = (ceuAr, segundos) => {
    input.resetInputState();
    input.setHeliControl('up', true);
    const heli = createVehicle(1, VEHICLE_DEFS.helicopter, 'red', 3.5, 3.5, 'SE');
    for (let i = 0; i < Math.round(segundos * 10); i++) movement.updateVehicle(heli, map, 0.1, ceuAr);
    input.resetInputState();
    return heli;
  };
  const cheio = voa(ar({ teto: TETO }), 20);
  const rarefeito = voa(ar({ teto: TETO, rarefeito: 1 }), 20);
  check(cheio.elevation > TETO - 0.2, `o ar limpo não chegou ao teto (${cheio.elevation.toFixed(2)})`);
  check(rarefeito.elevation < cheio.elevation - 5,
    `o ar pesado iça igual: ${rarefeito.elevation.toFixed(2)} contra ${cheio.elevation.toFixed(2)}`);
  check(rarefeito.elevation > MAO, 'o teto antigo ainda é parede (clamp herdado)');
  // O curso também sente: a máquina voa mais devagar lá em cima.
  input.resetInputState();
  input.setJoystickInput(1, 0, 1);
  const medida = (ceuAr) => {
    const heli = createVehicle(2, VEHICLE_DEFS.helicopter, 'red', 3.5, 3.5, 'SE');
    heli.elevation = TETO;
    for (let i = 0; i < 20; i++) movement.updateVehicle(heli, map, 0.1, ceuAr);
    return heli.speed;
  };
  const cru = medida(ar({ teto: TETO }));
  const pesado = medida(ar({ teto: TETO, rarefeito: 1 }));
  input.resetInputState();
  check(pesado < cru - 1e-6, `o curso não sentiu o ar (${pesado.toFixed(2)} ≥ ${cru.toFixed(2)})`);
  // E o antigo teto continua valendo para quem não informou coluna nenhuma.
  input.resetInputState();
  input.setHeliControl('up', true);
  const semCeu = createVehicle(3, VEHICLE_DEFS.helicopter, 'red', 3.5, 3.5, 'SE');
  for (let i = 0; i < 400; i++) movement.updateVehicle(semCeu, map, 0.1);
  input.resetInputState();
  check(semCeu.elevation <= MAO + 1e-9, `sem coluna informada o teto velho mudou (${semCeu.elevation})`);
});

test('o vento empurra só quem já saiu do chão', () => {
  const map = plainMap();
  const movement = new MovementSystem(new CollisionSystem(), () => []);
  input.resetInputState();
  const vento = ar({ teto: TETO, ventoX: 1.2, ventoY: -1.2 });

  const noAr = createVehicle(1, VEHICLE_DEFS.helicopter, 'red', 12, 12, 'SE');
  noAr.elevation = 20; noAr.altitude = 20;
  for (let i = 0; i < 10; i++) movement.updateVehicle(noAr, map, 0.1, vento);
  check(noAr.x > 12 + 1.2 * 1 * 0.9, `o casco não derrapou com o vento (${noAr.x.toFixed(2)})`);
  check(Math.abs((noAr.y - 12) + (noAr.x - 12)) < 1e-6, 'o vento saiu da diagonal do iso');

  const noChao = createVehicle(2, VEHICLE_DEFS.helicopter, 'red', 12, 12, 'SE');
  for (let i = 0; i < 10; i++) movement.updateVehicle(noChao, map, 0.1, vento);
  check(noChao.x === 12 && noChao.y === 12, 'o vento moveu uma máquina parada no chão');

  // Meio palmo do chão é atrito de roda: a deriva entra aos poucos, não num degrau.
  const raspando = createVehicle(3, VEHICLE_DEFS.helicopter, 'red', 12, 12, 'SE');
  raspando.elevation = 0.5; raspando.altitude = 0.5;
  for (let i = 0; i < 10; i++) movement.updateVehicle(raspando, map, 0.1, vento);
  check(raspando.x - 12 < (noAr.x - 12) * 0.6, `a derrapagem deu um salto no descolar
    (${(raspando.x - 12).toFixed(2)} contra ${(noAr.x - 12).toFixed(2)})`);
});

test('subir e descer devolve o mesmo ponto da cidade', () => {
  const map = plainMap();
  const movement = new MovementSystem(new CollisionSystem(), () => []);
  const heli = createVehicle(1, VEHICLE_DEFS.helicopter, 'red', 6.5, 6.5, 'SE');
  const limpo = ar({ teto: TETO });
  input.resetInputState();
  input.setHeliControl('up', true);
  for (let i = 0; i < 250; i++) movement.updateVehicle(heli, map, 0.1, limpo);
  check(heli.elevation > 20, `não subiu (${heli.elevation.toFixed(2)})`);
  input.setHeliControl('up', false);
  input.setHeliControl('down', true);
  for (let i = 0; i < 400; i++) movement.updateVehicle(heli, map, 0.1, limpo);
  input.resetInputState();
  check(heli.altitude === 0, `não pousou (${heli.altitude.toFixed(2)})`);
  check(Math.abs(heli.x - 6.5) < 1e-9 && Math.abs(heli.y - 6.5) < 1e-9,
    `a travessia do céu mudou o ponto do mapa (${heli.x.toFixed(3)}, ${heli.y.toFixed(3)})`);
});

test('a manta é um lugar com buraco, não uma parede pintada', () => {
  // Determinístico: o mesmo ponto do céu é nuvem duas vezes, e um save não encontra outro céu.
  check(mantaEm(30, 40, 12, 0, 0) === mantaEm(30, 40, 12, 0, 0));
  // Contínuo: meio tile de passo não pode dar degrau — é o que faria a borda piscar na tela.
  let maior = 0;
  for (let x = 0; x < 60; x += 0.5) {
    for (let y = 0; y < 60; y += 0.5) {
      maior = Math.max(maior, Math.abs(mantaEm(x, y, 12, 0, 0) - mantaEm(x + 0.5, y, 12, 0, 0)));
    }
  }
  check(maior < 0.12, `salto de ${maior.toFixed(3)} no campo: a borda da nuvem vai piscar`);
  // A média do ranking é o meio do céu: sem isso "45% de cobertura" fecha outra coisa na tela.
  let soma = 0, n = 0;
  for (let x = 0; x < 80; x += 1) for (let y = 0; y < 80; y += 1) { soma += mantaEm(x, y, 12, 0, 0); n++; }
  check(Math.abs(soma / n - 0.5) < 0.1, `o ranking saiu do meio (${(soma / n).toFixed(2)})`);
  // E o limiar devolve ao número do clima o que ele promete: cobertura é fração do mundo fechado.
  // O céu "limpo" não fecha a 0% porque a borda do tojo é mole de propósito: ficam uns fiapos no
  // canto do quadro, e fiapo é o que separa um céu desenhado de um azul pintado.
  for (const [cobertura, de, ate] of [[0, 0, 0.05], [0.45, 0.36, 0.54], [0.85, 0.76, 0.94]]) {
    let fechadas = 0, total = 0;
    for (let x = 0; x < 90; x += 1) for (let y = 0; y < 90; y += 1) {
      fechadas += nuvemNoCampo(x, y, 12, 0, 0, cobertura); total++;
    }
    const media = fechadas / total;
    check(media >= de && media <= ate,
      `cobertura ${cobertura} fechou ${(media * 100).toFixed(0)}% do céu`);
  }
  // Com o céu todo fechado ainda há rasgo: sem buraco não é nuvem, é um teto pintado.
  let aberto = 0;
  for (let x = 0; x < 90; x += 1) for (let y = 0; y < 90; y += 1) {
    if (nuvemNoCampo(x, y, 12, 0, 0, 1) < 0.2) aberto++;
  }
  check(aberto > 0 && aberto * 40 < 90 * 90, `o céu fechado virou laje única (${aberto} pontos livres)`);
});

test('nuvem é porta, não parede: o teto fica acima do lombo da manta', () => {
  for (const cobertura of [0, 0.2, 0.5, 0.85, 1]) {
    const sistema = new AltitudeSystem();
    for (let i = 0; i < 40; i++) {
      sistema.update(0.1, { x: 40, y: 40, cota: 0, chao: 0, cobertura, nevoia: 0, vento: 0,
        severidade: cobertura * 0.6, tempo: 12 });
    }
    check(sistema.doTeto >= sistema.doTopo + GAME_CONFIG.CEU_FOLGA - 1e-9,
      `cobertura ${cobertura}: a manta encostou no teto do céu`);
    check(sistema.doTopo > sistema.daBase, `cobertura ${cobertura}: nuvem sem espessura`);
    // A manta tem de começar acima do voo raso: senão a rua inteira some no telhado.
    check(sistema.daBase > MAO, `cobertura ${cobertura}: a base desceu dentro do quarteirão`);
  }
});

/**
 * O passo que a camada de nuvens escolhe para caber no quadro: é a conta de `useCloudPaint`, e o
 * check mede a mesma fórmula para que a grade grossa não vire um xadrez de bolhas gigantes.
 */
function passoDoQuadro(alcance) {
  return Math.max(GAME_CONFIG.NUVEM_PINTURA, Math.ceil(alcance / 10));
}

test('a manta que o render pinta é o mesmo campo, no mesmo lugar', () => {
  const ceuDaPintura = (cobertura) => {
    const sistema = new AltitudeSystem();
    for (let i = 0; i < 40; i++) {
      sistema.update(0.1, { x: 120, y: 120, cota: 0, chao: 0, cobertura, nevoia: 0, vento: 0.2,
        severidade: cobertura * 0.6, tempo: 30 });
    }
    return sistema;
  };
  // Mesmo céu, mesma chamada, mesmas bolhas: a manta é um lugar, e um render que sorteasse o
  // próprio traçado a cada rede faria o algodão ferver na tela.
  const alto = ceuDaPintura(0.85);
  const uma = JSON.stringify(alto.pinta(120, 120, 50, 30, 4));
  const duas = JSON.stringify(alto.pinta(120, 120, 50, 30, 4));
  check(uma === duas, 'a pintura não é determinística: a nuvem vai tremer a cada rede');
  const pintadas = JSON.parse(uma);
  check(pintadas.length > 0, 'céu a 85% e a pintura não achou uma bolha');
  for (const b of pintadas) {
    check(Number.isFinite(b.x) && Number.isFinite(b.y) && b.r > 0, 'bolha fora do mundo');
  }
  // A grade tem de alcançar a beira do quadro: bolha a menos no canto é céu recortado, e é o
  // único jeito de o teto ficar barato sem buraco.
  const alcance = 50;
  let maisLonge = 0;
  for (const b of pintadas) maisLonge = Math.max(maisLonge, Math.abs(b.x - 120), Math.abs(b.y - 120));
  check(maisLonge >= alcance - 8, `a manta parou a ${maisLonge.toFixed(1)} tiles do centro`);

  // Cobertura entra na pintura como entra no céu: mais fechada, mais bolhas.
  const Conta = (cobertura) => ceuDaPintura(cobertura).pinta(120, 120, 50, 30, 4).length;
  const limpo = Conta(0), meio = Conta(0.5), fechado = Conta(1);
  check(limpo < meio && meio < fechado,
    `a pintura não segue o clima: ${limpo} / ${meio} / ${fechado} bolhas`);
  // E o teto de bolhas não estoura o orçamento do quadro mais largo que existe.
  const largo = 90;
  const redes = alto.pinta(120, 120, largo, 30, passoDoQuadro(largo)).length;
  check(redes > 0 && redes <= 420, `${redes} bolhas no quadro largo: ou não pintou nada ou pintou demais`);

  // O lombo fica acima da barriga e o aparelho acima do lombo: é a ordem de tela que faz o mar de
  // nuvens ser CHÃO para quem subiu. Comprimida, a curva ainda tem de manter as três separadas.
  const sistema = ceuDaPintura(0.85);
  check(alturaDeTela(sistema.doTopo) > alturaDeTela(sistema.daBase),
    'a manta saiu sem espessura de tela: algodão plano');
  check(alturaDeTela(46) > alturaDeTela(sistema.doTopo),
    'de cima, o aparelho afundou no próprio mar de nuvens');
  check(alturaDeTela(0) < alturaDeTela(sistema.daBase),
    'a barriga da manta ficou abaixo da rua');
});

/**
 * A laje inteira, medida por área: a grade grossa é barata de propósito, então o que tem de ser
 * garantido à mão é a consequência dela — todo ponto onde o campo diz "nuvem" precisa cair dentro
 * do raio de uma bolha pintada. Se a soma dos raios não alcança o vizinho, o buraco é da grade, e a
 * grade não tem direito a buraco: buraco é do campo, é por ele que a cidade reaparece.
 *
 * Foi aqui que a hipótese da malha caiu por terra. O céu fechado do navegador deixou a cidade
 * legível, e eu chamei aquilo de lacuna da grade; medindo a área pintada, as duas geometrias
 * (a antiga, de passo inteiro de desencontro, e a atual) cobrem 100% dos pontos de nuvem. O
 * algodão estava inteiro — o que acontecia é que ele era desenhado ANTES dos prédios, e prédio
 * desenha por cima. Ordem de tela não se mede aqui: é o que a sonda fotografa.
 */
test('céu fechado é laje, não peneira: onde o campo é nuvem há algodão pintado', () => {
  // Alcance 30 com o passo mínimo de 4 tiles: é a grade FINA do produto, a que o `useCloudPaint`
  // usa em qualquer janela comum (passo = max(4, alcance/10)). É também a única onde a assersão
  // vale por geometria e não por sorte — com alcance 60 e passo 4 a grade tem 961 células e o teto
  // de 420 bolhas corta a lista antes de fechar o quadro, que é outra conta e outro check.
  const passo = GAME_CONFIG.NUVEM_PINTURA, alcance = 30, centro = 120;
  const grossa = (cobertura) => {
    const sistema = new AltitudeSystem();
    for (let i = 0; i < 40; i++) {
      sistema.update(0.1, { x: centro, y: centro, cota: 30, chao: 0, cobertura, nevoia: 0,
        vento: 0.2, severidade: cobertura * 0.6, tempo: 30 });
    }
    const blobs = sistema.pinta(centro, centro, alcance, 30, passo);
    const { ventoX, ventoY } = sistema.snapshot;
    let bruto = 0, coberto = 0;
    // Amostra um passo para dentro da borda: a última linha da grade não tem vizinho de um lado, e
    // recorte na beira do quadro é outra conversa (e outro check, o do alcance).
    for (let x = centro - alcance + passo; x <= centro + alcance - passo; x += 0.5) {
      for (let y = centro - alcance + passo; y <= centro + alcance - passo; y += 0.5) {
        // 0.5 é o meio do campo, não o 0.9 da nuvem grossa: é a faixa de borda, onde a malha
        // aparecería primeiro se a grade fosse aberta demais.
        if (nuvemNoCampo(x, y, 30, ventoX, ventoY, cobertura) < 0.5) continue;
        bruto++;
        for (const b of blobs) {
          const dx = x - b.x, dy = y - b.y;
          if (dx * dx + dy * dy <= b.r * b.r) { coberto++; break; }
        }
      }
    }
    return { bruto, coberto, blobs: blobs.length };
  };
  for (const cobertura of [0.85, 1]) {
    const r = grossa(cobertura);
    const fra = r.coberto / r.bruto;
    check(r.bruto > 800 && fra >= 0.99,
      `cobertura ${cobertura}: ${(100 - fra * 100).toFixed(1)}% da nuvem sem bolha pintada `
      + `(${r.coberto}/${r.bruto}, ${r.blobs} bolhas)`);
  }
});

/** A ronda policial inteira num mapa de bairro, com o ar que o `GameState` entregaria. */
function caca(sky, cotaDoFugitivo) {
  const roadNodes = Array.from({ length: 12 }, (_, i) => ({ x: 90 + i * 4, y: 90 }));
  const ctx = {
    map: { worldW: 200, worldH: 200, roadNodes, heightSmoothAt: () => 0,
      isInside: () => true, isWaterWorld: () => false },
    player: { x: 100, y: 100, health: 100, currentVehicleId: 7, wantedLevel: 4 },
    vehicles: [], rng: () => 0.5, allocVehicleId: () => 100, onStructChange() {},
    target: { x: 100, y: 100 }, deployOfficer: () => false, time: 0, sky,
  };
  const aeronave = createVehicle(7, VEHICLE_DEFS.helicopter, 'red', 100, 100, 'SE');
  aeronave.elevation = cotaDoFugitivo;
  aeronave.altitude = cotaDoFugitivo;
  ctx.vehicles.push(aeronave);
  const air = new AirSupportSystem();
  return { air, ctx, aeronave };
}

/**
 * Quantas varreduras ACABAM de encontrar o alvo — não quantos quadros com o holofote aceso, que é
 * uma medida do tempo de retenção (1,5 s), não do que a tripulação viu. Entre duas varreduras o
 * `spotTimer` só decresce, então qualquer subida é um achado novo.
 */
function varreduras(air, ctx, segundos, dt = 0.05) {
  let achados = 0;
  let antes = 0;
  for (let t = 0; t < segundos; t += dt) {
    ctx.time += dt;
    air.update(dt, 4, ctx);
    const agora = air.spotTimer;
    if (agora > antes + 1e-9) achados++;
    antes = agora;
  }
  return achados;
}

test('a laje de nuvem entre os dois apaga o holofote', () => {
  // Mesmo céu, mesma máquina, mesma posição: a única diferença é existir ou não manta no meio do
  // olhar. Comparar os dois regimes é o que prova que foi a nuvem que cegou, não um número mudado.
  const limpo = new AltitudeSystem();
  const fechado = new AltitudeSystem();
  const adapter = (sistema, cobertura) => ({
    get base() { return sistema.daBase; },
    obstrucao: (x, y, de, ate, tempo) => sistema.obstrucao(x, y, de, ate, tempo),
    update: (dt, cota) => sistema.update(dt, { x: 100, y: 100, cota, chao: 0, cobertura,
      nevoia: 0, vento: 0, severidade: cobertura * 0.6, tempo: 0 }),
  });
  const semNuvem = adapter(limpo, 0);
  const comNuvem = adapter(fechado, 1);

  const a = caca(semNuvem, 22);
  const b = caca(comNuvem, 22);
  // Deixa o apoio aéreo chegar e cirandar antes de contar.
  for (let t = 0; t < 20; t += 0.05) {
    a.ctx.time += 0.05; b.ctx.time += 0.05;
    semNuvem.update(0.05, 22); comNuvem.update(0.05, 22);
    a.air.update(0.05, 4, a.ctx); b.air.update(0.05, 4, b.ctx);
  }
  check(a.air.helis.length === 1 && b.air.helis.length === 1, 'a caça não ganhou asas');
  const vistos = varreduras(a.air, a.ctx, 12);
  const cegos = varreduras(b.air, b.ctx, 12);
  const varredurasPrevistas = 12 / 0.4;
  check(vistos >= varredurasPrevistas * 0.9,
    `céu limpo e a ronda só achou ${vistos}/${varredurasPrevistas} varreduras`);
  check(cegos <= vistos * 0.35, `tempestade e o holofote atravessou o algodão: ${cegos} de ${vistos}`);
  console.log(`   varreduras: céu limpo ${vistos}/${varredurasPrevistas}, dentro da manta ${cegos}`);
});

test('a ronda sobe atrás do fugitivo e para no próprio teto', () => {
  const limpo = new AltitudeSystem();
  const sky = { get base() { return limpo.daBase; },
    obstrucao: (x, y, de, ate, tempo) => limpo.obstrucao(x, y, de, ate, tempo) };
  const naRua = caca(sky, 0);
  for (let t = 0; t < 20; t += 0.05) { naRua.ctx.time += 0.05; limpo.update(0.05,
    { x: 100, y: 100, cota: 0, chao: 0, cobertura: 0, nevoia: 0, vento: 0, severidade: 0, tempo: 0 });
    naRua.air.update(0.05, 4, naRua.ctx); }
  check(Math.abs(naRua.air.helis[0].altitude - GAME_CONFIG.POLICE_HELI_ALTITUDE) < 0.05,
    `com o alvo na rua a ronda mudou de andar (${naRua.air.helis[0].altitude.toFixed(2)})`);

  const noAr = caca(sky, 30);
  for (let t = 0; t < 30; t += 0.05) { noAr.ctx.time += 0.05; limpo.update(0.05,
    { x: 100, y: 100, cota: 30, chao: 0, cobertura: 0, nevoia: 0, vento: 0, severidade: 0, tempo: 0 });
    noAr.air.update(0.05, 4, noAr.ctx); }
  const ronda = noAr.air.helis[0];
  check(ronda.altitude > GAME_CONFIG.POLICE_HELI_ALTITUDE * 2,
    `a ronda não foi atrás do fugitivo do ar (${ronda.altitude.toFixed(2)})`);
  check(ronda.altitude <= GAME_CONFIG.POLICE_HELI_TETO + 1e-9,
    `a ronda passou do teto dela (${ronda.altitude.toFixed(2)})`);
  // E o teto da máquina é bem mais baixo que o do herói: a fuga pelo ar existe.
  check(GAME_CONFIG.POLICE_HELI_TETO < GAME_CONFIG.CEU_TETO, 'o teto policial passou o do jogador');
});

test('sem céu informado a caça é exatamente a de antes', () => {
  const semSky = caca(undefined, 30);
  for (let t = 0; t < 20; t += 0.05) {
    semSky.ctx.time += 0.05;
    semSky.air.update(0.05, 4, semSky.ctx);
  }
  const heli = semSky.air.helis[0];
  check(Math.abs(heli.altitude - GAME_CONFIG.POLICE_HELI_ALTITUDE) < 0.05,
    `sem coluna de ar a ronda subiu sozinha (${heli.altitude.toFixed(2)})`);
});

test('a bruma do chão é um andar embaixo de tudo', () => {
  const sistema = new AltitudeSystem();
  const env = (cota) => ({ x: 10, y: 10, cota, chao: 0, cobertura: 0, nevoia: 0.9, vento: 0,
    severidade: 0, tempo: 5 });
  for (let i = 0; i < 60; i++) sistema.update(0.05, env(1));
  const noChao = sistema.snapshot;
  for (let i = 0; i < 60; i++) sistema.update(0.05, env(12));
  const acima = sistema.snapshot;
  check(noChao.visivel < 0.6, `a névoa da manhã não fechou a rua (${noChao.visivel.toFixed(2)})`);
  check(acima.visivel > 0.9, `subir não saiu da bruma (${acima.visivel.toFixed(2)})`);
});

/**
 * O que a coluna publica sobre a EXISTÊNCIA da manta. `base` e `topo` são um intervalo teórico e
 * saem do sistema mesmo num dia de azul absoluto — é o que faz um leitor que só olha os dois
 * desenhar algodão onde não há nuvem nenhuma e escrever "NUVEM 480 m" para o nada.
 */
test('o instantâneo diz se há manta, não só onde ela estaria', () => {
  const vazio = new AltitudeSystem().snapshot;
  check(vazio.cobertura === 0, `antes do primeiro quadro o céu já tinha nuvem (${vazio.cobertura})`);
  const limpo = ceuEm(10, 10, 2, 0);
  const fechado = ceuEm(10, 10, 2, 1);
  check(limpo.cobertura === 0, `céu limpo publicou ${limpo.cobertura} de nuvem`);
  // O cerne do contrato, e o que a régua sozinha NÃO entrega: no dia mais azul que existe a coluna
  // continua publicando um lençol de 30 a 35 tiles, cinco de espessura. Não é bug da geometria — é
  // ela sendo o que é, uma cota teórica. Quem desenha nuvem a partir só de `base`/`topo` pinta
  // algodão no azul e escreve "NUVEM 480 m" numa tarde limpa; por isso a existência sai aqui.
  check(limpo.base === GAME_CONFIG.NUVEM_BASE_ALTA
    && limpo.topo === limpo.base + GAME_CONFIG.NUVEM_ESPESSURA[0],
    `a banda teórica mudou de lugar num céu sem nuvem (${limpo.base}..${limpo.topo})`);
  check(limpo.acima === 0 && limpo.fechamento === 0,
    `sem céu publicado havia manta no quadro (${limpo.acima}/${limpo.fechamento})`);
  check(fechado.cobertura > 0.98, `dia fechado publicou ${fechado.cobertura}`);
  check(fechado.base < limpo.base, `a manta fechada não baixou a base (${limpo.base} -> ${fechado.base})`);
  check(fechado.dentro === 0 && fechado.fechamento === 0,
    `a 2 tiles do chão a laje já tocava alguém (${fechado.dentro}/${fechado.fechamento})`);
});

// ---------------------------------------------------------------------------
// O ouvido da coluna. Os dois leitos só existem porque há ar acima da rua, e o
// contrato é um só: o que muda no volume tem de ser o que muda no céu.
// ---------------------------------------------------------------------------

/** O céu publicado de verdade, parado a `cota` num ponto do mapa. */
function ceuEm(x, y, cota, cobertura, vento = 0) {
  const sistema = new AltitudeSystem();
  const env = { x, y, cota, chao: 0, cobertura, nevoia: 0, vento, severidade: 0, tempo: 5 };
  for (let i = 0; i < 200; i++) sistema.update(0.05, env);
  return sistema.snapshot;
}

/** Um instantâneo lavrado à mão: serve para isolar UMA variável do mixer. */
function arDe(parte) {
  return Object.assign({
    cota: 0, chao: 0, teto: GAME_CONFIG.CEU_TETO, base: GAME_CONFIG.NUVEM_BASE_ALTA,
    topo: GAME_CONFIG.NUVEM_BASE_ALTA, cobertura: 0, dentro: 0, bruma: 0, fechamento: 0,
    acima: 0, visivel: 1, rarefeito: 0, cidade: 1, ventoX: 0, ventoY: 0,
  }, parte);
}

function ouvido() {
  const pedidos = [];
  const ultimo = (canal) => {
    for (let i = pedidos.length - 1; i >= 0; i--) if (pedidos[i][0] === canal) return pedidos[i][1];
    return -1;
  };
  return { pedidos, ultimo, saida: { rotor: (v) => pedidos.push(['rotor', v]), ar: (v) => pedidos.push(['ar', v]) } };
}

/** Quantos decibéis o piloto ouviria depois de `n` amostras naquele pedaço do céu. */
function volume(ar, { pilotando = true, velocidade = 0, aoArLivre = true, n = 60 } = {}) {
  const o = ouvido();
  const sys = new AltitudeAudioSystem(o.saida);
  for (let i = 0; i < n; i++) sys.update(0.1, { pilotando, velocidade, aoArLivre, ar });
  return { rotor: o.ultimo('rotor'), ar: o.ultimo('ar'), pedidos: o.pedidos };
}

test('na rua não há sopro: o leito da região continua sem concorrente', () => {
  const rua = volume(ceuEm(10, 10, 2.2, 0.2));
  assert.equal(rua.ar, 0, `o ar da altitude invadiu a rua (${rua.ar})`);
  check(rua.rotor > 0.2, `sem casco no ar não se ouve pá nenhuma (${rua.rotor})`);
});

test('o sopro é a coluna: cresce com a altura e nunca cai no meio do caminho', () => {
  const baixo = volume(ceuEm(10, 10, 6, 0.2)).ar;
  const meio = volume(ceuEm(10, 10, 20, 0.2)).ar;
  const alto = volume(ceuEm(10, 10, 40, 0.2)).ar;
  check(meio > baixo, `subir de 6 para 20 não abriu o ar (${baixo} -> ${meio})`);
  check(alto > meio, `subir de 20 para 40 fechou o ar (${meio} -> ${alto})`);
  assert.equal(baixo, 0, 'a 6 tiles o aparelho ainda é a rua');
});

test('a travessia tem som: o chiado engrossa dentro do algodão e o corte das pás amolece', () => {
  // Varre o mapa atrás de um ponto onde a laje fecha de verdade. Sem este ponto o teste
  // passaria calado comparando dois céus limpos.
  let x = -1;
  for (let i = 0; i < 80 && x < 0; i++) if (ceuEm(i, 13, 18, 0.95).dentro > 0.35) x = i;
  check(x >= 0, 'nenhum ponto do céu fechou: a varredura da manta está cega');
  const embaixo = ceuEm(x, 13, 4, 0.95);
  const noMeio = ceuEm(x, 13, 18, 0.95);
  const acima = ceuEm(x, 13, 40, 0.95);
  check(noMeio.dentro > embaixo.dentro, 'a laje não engoliu o casco no meio da espessura');
  const sob = volume(noMeio), deBaixo = volume(embaixo), deCima = volume(acima);
  check(sob.ar > deBaixo.ar, `entrar na nuvem não mudou o chiado (${deBaixo.ar} -> ${sob.ar})`);
  check(sob.rotor < deBaixo.rotor, `o corte das pás não amoleceu no molhado (${deBaixo.rotor} -> ${sob.rotor})`);
  // Passou do lombo, o chiado assenta: o pico é DENTRO da manta, não acima dela.
  check(sob.ar > deCima.ar + 0.02, `o pico do chiado não está na travessia (${sob.ar} vs ${deCima.ar})`);
});

test('no teto o rotor emagrece e o ar é o único som que sobra', () => {
  const limpo = volume(arDe({ cidade: 0.1, rarefeito: 0 }));
  const raro = volume(arDe({ cidade: 0.1, rarefeito: 1 }));
  check(raro.rotor < limpo.rotor * 0.8,
    `o ar rarefeito não tirou mordida das pás (${limpo.rotor} -> ${raro.rotor})`);
  check(raro.ar > 0.15, `lá em cima o sopro sumiu (${raro.ar})`);
});

test('vento e curso são vento relativo: cada um abre o sopro sozinho', () => {
  const calmo = volume(arDe({ cidade: 0 })).ar;
  const comVento = volume(arDe({ cidade: 0, ventoX: 1.7, ventoY: -1.7 })).ar;
  const comCurso = volume(arDe({ cidade: 0 }), { velocidade: GAME_CONFIG.HELI_MAX_SPEED }).ar;
  check(comVento > calmo, `a frente não soprou no casco (${calmo} -> ${comVento})`);
  check(comCurso > calmo, `o curso próprio não fez vento (${calmo} -> ${comCurso})`);
});

test('sem casco pilotado e dentro de casa não há leito nenhum', () => {
  const alto = ceuEm(10, 10, 40, 0.2);
  const emTerra = volume(alto, { pilotando: false });
  assert.equal(emTerra.rotor, 0, 'o rotor do jogador tocou sem ninguém no manche');
  const naSala = volume(alto, { aoArLivre: false });
  assert.equal(naSala.rotor, 0, 'o casco cantou dentro de uma sala');
  assert.equal(naSala.ar, 0, 'o sopro da altitude entrou dentro de casa');
});

test('o volume é quantizado: um céu parado não inunda a ponte do áudio', () => {
  const { pedidos } = volume(ceuEm(10, 10, 30, 0.6), { velocidade: 2, n: 200 });
  check(pedidos.length <= 8, `200 amostras paradas fizeram ${pedidos.length} pedidos ao canal nativo`);
});

test('pausa e menu calam os dois leitos na mesma hora', () => {
  const o = ouvido();
  const sys = new AltitudeAudioSystem(o.saida);
  const alto = ceuEm(10, 10, 40, 0.2);
  for (let i = 0; i < 40; i++) sys.update(0.1, { pilotando: true, velocidade: 3, aoArLivre: true, ar: alto });
  check(o.ultimo('rotor') > 0.1 && o.ultimo('ar') > 0.1, 'o voo nunca chegou a soar');
  sys.suspend();
  assert.equal(o.ultimo('rotor'), 0, 'o rotor continuou girando no menu');
  assert.equal(o.ultimo('ar'), 0, 'o sopro continuou no menu');
});

console.log(`Altitude checks: ${passed} passed, ${failed} failed.`);
if (failed) { console.error('Falha de altitude = voo preso ao iso ou travessia com corte; não relaxar asserções.'); process.exitCode = 1; }
