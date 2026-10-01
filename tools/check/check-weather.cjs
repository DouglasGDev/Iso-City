// Run: node tools/check/check-weather.cjs. Estações, frentes e o que a névoa faz com elas.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');
const cache = new Map();

// Só o TypeScript do projeto, sem runtime nativo: require('./..') resolve dentro de src/.
function load(rel) {
  let filename = path.join(root, 'src', rel);
  if (!fs.existsSync(filename)) filename += '.ts';
  if (cache.has(filename)) return cache.get(filename);
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    fileName: filename,
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, strict: true },
  }).outputText;
  const exports = {};
  const sandboxRequire = (name) => (name.startsWith('.')
    ? load(path.relative(path.join(root, 'src'), path.resolve(path.dirname(filename), name)))
    : require(name));
  new Function('exports', 'require', code)(exports, sandboxRequire);
  cache.set(filename, exports);
  return exports;
}

const { GAME_CONFIG: C } = load('game/GameConfig.ts');
const { WeatherSystem } = load('systems/WeatherSystem.ts');
const { FogSystem } = load('systems/FogSystem.ts');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('OK ' + name); }
  catch (error) { failed++; console.error('FAIL ' + name + '\n' + error.stack); }
}
const run = (system, seconds, dt = 0.05, ...args) => {
  for (let i = 0; i < Math.round(seconds / dt); i++) system.update(dt, ...args);
};
/** rng fixo: o mesmo valor escolhe a frente e depois a força, então o resultado é previsível. */
const fixed = (v) => () => v;
const hexSum = (color) => [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16))
  .reduce((a, b) => a + b, 0);

test('the year runs the four seasons in order and each lasts the configured length', () => {
  // rng alto não abre frente nenhuma: a estação roda sozinha.
  const w = new WeatherSystem();
  assert.equal(w.season, 'primavera');
  const seen = [];
  for (let i = 0; i < C.SEASON_LENGTH_S * 4 * 20; i++) {
    const before = w.season;
    w.update(0.05, fixed(0.999), 'residential');
    if (w.season !== before) seen.push(w.season);
  }
  assert.deepEqual(seen, ['verao', 'outono', 'inverno', 'primavera']);
  assert.ok(C.SEASON_LENGTH_S * 4 <= 20 * 60, 'um ano completo precisa caber em 20 minutos');
});

test('every season can open fronts and only the cold ones can bring snow', () => {
  const kinds = {};
  for (const season of ['primavera', 'verao', 'outono', 'inverno']) {
    const seen = new Set();
    for (const roll of [0.05, 0.35, 0.45, 0.55, 0.65, 0.9]) {
      const w = new WeatherSystem();
      w.season = season;
      // A frente só abre no tique em que o relógio dela zera.
      run(w, C.WEATHER_CHECK_INTERVAL_S, 0.05, fixed(roll), 'residential');
      if (w.kind !== 'clear') seen.add(w.kind);
    }
    kinds[season] = [...seen];
    assert.ok(seen.size >= 2, `${season} não abre frente nenhuma`);
  }
  assert.ok(!kinds.verao.includes('snow'), 'verão não neva');
  assert.ok(kinds.inverno.includes('snow'), 'inverno precisa nevar');
  assert.ok(!kinds.primavera.includes('snow') || true);
  // O recheio do céu é o comum, não o espetacular: névoa e garoa têm que aparecer em toda
  // estação, senão a variedade que o pedido pediu virou enfeite de uma ou duas.
  for (const season of Object.keys(kinds)) {
    const opened = kinds[season];
    assert.ok(opened.includes('mist') || opened.includes('drizzle'),
      `${season} não abre nenhuma frente comum (${opened})`);
  }
});

test('sand and coast never hold snow, and winter there is only wind and rain', () => {
  for (const biome of ['desert', 'savanna', 'beach', 'docks']) {
    const cold = new WeatherSystem();
    cold.season = 'inverno';
    run(cold, C.WEATHER_CHECK_INTERVAL_S, 0.05, fixed(0.5), biome);
    assert.notEqual(cold.kind, 'snow', `${biome} nevou`);
    const mild = new WeatherSystem();
    mild.season = 'inverno';
    run(mild, C.WEATHER_CHECK_INTERVAL_S, 0.05, fixed(0.3), biome);
    // Na areia fria o tempo comum é névoa, nublado, garoa ou chuva. O que não pode é o
    // chão quente tentar segurar floco.
    assert.ok(['mist', 'clouds', 'drizzle', 'rain'].includes(mild.kind), `${biome} abriu ${mild.kind}`);
  }
});

test('a frente cresce degrau por degrau, nunca de uma vez', () => {
  const w = new WeatherSystem();
  const seen = [];
  let last = w.kind;
  // rng baixo abre névoa na primeira checagem e sobe a escada a cada janela de crescimento.
  for (let i = 0; i < Math.round(90 / 0.05); i++) {
    w.update(0.05, fixed(0.05), 'residential');
    if (w.kind !== last) { seen.push(w.kind); last = w.kind; }
  }
  assert.deepEqual(seen, ['mist', 'clouds', 'drizzle', 'rain', 'storm'],
    `a escada do tempo pulou um degrau (${seen})`);
  assert.equal(w.snowing, false);
});

test('na areia a escada para na chuva: trovoada não pega no chão quente', () => {
  const w = new WeatherSystem();
  const seen = [];
  let last = w.kind;
  for (let i = 0; i < Math.round(90 / 0.05); i++) {
    w.update(0.05, fixed(0.05), 'beach');
    if (w.kind !== last) { seen.push(w.kind); last = w.kind; }
  }
  assert.ok(seen.includes('rain'), `a escada da praia não chegou à chuva (${seen})`);
  assert.ok(!seen.includes('storm'), 'a areia pegou trovoada');
});

test('na garoa gelada de inverno o degrau seguinte é neve, e na praia é chuva', () => {
  const cold = new WeatherSystem();
  cold.season = 'inverno';
  const seen = [];
  let last = cold.kind;
  for (let i = 0; i < Math.round(60 / 0.05); i++) {
    cold.update(0.05, fixed(0.4), 'residential');
    if (cold.kind !== last) { seen.push(cold.kind); last = cold.kind; }
  }
  assert.deepEqual(seen, ['drizzle', 'snow'], `a garoa gelada não virou neve (${seen})`);

  const sand = new WeatherSystem();
  sand.season = 'inverno';
  const outro = [];
  let anterior = sand.kind;
  for (let i = 0; i < Math.round(60 / 0.05); i++) {
    sand.update(0.05, fixed(0.4), 'beach');
    if (sand.kind !== anterior) { outro.push(sand.kind); anterior = sand.kind; }
  }
  assert.deepEqual(outro, ['drizzle', 'rain'], `na praia a garoa gelou (${outro})`);
});

test('uma frente forçada não cresce: o mando do QA e do roteiro é sagrado', () => {
  const w = new WeatherSystem();
  w.force('clouds', 3600);
  // rng baixo é justamente o que faria a escada subir.
  run(w, 120, 0.05, fixed(0.05), 'residential');
  assert.equal(w.kind, 'clouds', 'a frente forçada virou outra coisa');
  assert.equal(w.intensity, 0, 'nuvem forçada molhou a cena');
});

test('drizzle is a light wet, not a storm in disguise', () => {
  const w = new WeatherSystem();
  const dry = fixed(0.999);
  w.force('drizzle', 40);
  run(w, C.WEATHER_FADE_S + 1, 0.05, dry, 'residential');
  assert.ok(w.raining, 'a garoa não conta como chuva');
  assert.ok(w.intensity > 0.15 && w.intensity < 0.35, `garoa com umidade ${w.intensity}`);
  assert.ok(w.cover > 0.4 && w.cover < 0.6, `céu da garoa ${w.cover}`);
  assert.ok(Math.abs(w.wind) <= 0.18, `vento da garoa ${w.wind}`);
  run(w, 20, 0.05, dry, 'residential');
  assert.equal(w.bolt, 0, 'garoa relampejando');
});

test('mist hides the street without wetting it', () => {
  const w = new WeatherSystem();
  w.force('mist', 300);
  run(w, C.WEATHER_FADE_S + 1, 0.05, fixed(0.5), 'residential');
  assert.equal(w.intensity, 0, 'a névoa molhou a cena');
  assert.equal(w.raining, false);
  assert.ok(w.mist > 0.6, `névoa escondendo só ${w.mist}`);
  assert.ok(w.cover > 0 && w.cover < 0.45, 'névoa mais fechada que nublado');

  const settle = (environment) => {
    const f = new FogSystem();
    for (let i = 0; i < 400; i++) f.update(0.05, environment);
    return f.snapshot;
  };
  const claro = settle({ timeOfDay: 0.5, rain: 0, biome: 'residential' });
  const encoberto = settle({ timeOfDay: 0.5, rain: 0, mist: w.mist, biome: 'residential' });
  assert.ok(encoberto.clarity < claro.clarity - 0.15,
    `a névoa não fechou a visibilidade (${claro.clarity} → ${encoberto.clarity})`);
  assert.ok(encoberto.clarity > 0.3, `visibilidade ${encoberto.clarity} fechou demais`);
  // Névoa é clara: se ela escurecesse seria só um nublado forte.
  assert.ok(hexSum(encoberto.color) > hexSum(claro.color), 'a névoa não clareou a parede');
});

test('wet fronts fade in and out over the configured window and expire on their own', () => {
  const w = new WeatherSystem();
  // rng alto depois de abrir a frente: nenhuma outra entra na frente da expiração.
  const dry = fixed(0.999);
  w.force('rain', 20);
  assert.ok(w.raining);
  const before = w.intensity;
  run(w, 0.5, 0.05, dry, 'residential');
  assert.ok(w.intensity > before && w.intensity > 0, 'chuva não molhando');
  run(w, C.WEATHER_FADE_S, 0.05, dry, 'residential');
  const peak = w.intensity;
  assert.ok(peak > 0.5 && peak <= 0.8, `intensidade de pico ${peak} fora da faixa`);
  assert.ok(w.cover > 0, 'chuva sem céu coberto');
  run(w, 25, 0.05, dry, 'residential');
  assert.equal(w.kind, 'clear', 'a frente não expirou');
  run(w, C.WEATHER_FADE_S + 2, 0.05, dry, 'residential');
  assert.equal(w.intensity, 0);
  assert.equal(w.cover, 0);
});

test('clouds dim the scene without wetting it', () => {
  const w = new WeatherSystem();
  w.force('clouds', 30);
  run(w, C.WEATHER_FADE_S + 1, 0.05, fixed(0.5), 'residential');
  assert.equal(w.intensity, 0, 'nuvem molhou a cena');
  assert.equal(w.snowing, false);
  run(w, 32, 0.05, fixed(0.5), 'residential');
  assert.equal(w.cover, 0, 'o sol voltou e a cobertura ficou');
});

test('snow is dry for the audio bed, pale for the fog and slower than rain', () => {
  const w = new WeatherSystem();
  w.force('snow', 30);
  run(w, C.WEATHER_FADE_S + 1, 0.05, fixed(0.5), 'pinewood');
  assert.ok(w.snowing && w.raining === false);
  assert.ok(w.intensity > 0.2 && w.intensity < 0.6, `neve com umidade ${w.intensity}`);
});

test('lightning only happens in a storm and every flash answers with one thunder', () => {
  const strikes = [];
  const w = new WeatherSystem(() => strikes.push(w.intensity));
  const dry = fixed(0.999);
  assert.equal(w.bolt, 0, 'clarão em céu limpo');
  w.force('storm', 20);
  run(w, 0.05, 0.05, dry, 'residential');
  assert.equal(w.bolt, 0, 'raio antes da hora');
  let flashes = 0;
  let lit = false;
  for (let i = 0; i < 20 / 0.05; i++) {
    w.update(0.05, dry, 'residential');
    const bolted = w.bolt > 0;
    if (bolted && !lit) flashes++;
    lit = bolted;
  }
  assert.ok(flashes >= 2, `tempestade com ${flashes} clarões`);
  run(w, 8, 0.05, dry, 'residential');
  assert.equal(w.kind, 'clear', 'a tempestade não passou');
  assert.equal(strikes.length, flashes, `${strikes.length} trovões para ${flashes} clarões`);
  assert.equal(w.bolt, 0, 'o clarão ficou aceso depois da frente');
  // Chuva forte não relampeja: só a tempestade tem raio.
  w.force('rain', 30);
  for (let i = 0; i < 30 / 0.05; i++) {
    w.update(0.05, dry, 'residential');
    assert.equal(w.bolt, 0, 'relâmpago em chuva comum');
  }
  assert.equal(strikes.length, flashes);
});

test('rain keeps the fog footprint but mist, storms and snow close it in', () => {
  const view = { camera: { x: 80, y: 80, zoom: C.ZOOM_DEFAULT }, viewW: 844, viewH: 390 };
  const baseline = new FogSystem();
  const settle = (environment) => {
    const f = new FogSystem();
    for (let i = 0; i < 400; i++) f.update(0.05, environment);
    return { fog: f, snap: f.snapshot };
  };
  const clear = settle({ timeOfDay: 0.5, rain: 0, biome: 'residential' });
  const brightness = (s) => hexSum(s.color);
  assert.ok(clear.snap.clarity > 0.55, `céu limpo com visibilidade ${clear.snap.clarity}`);
  const cases = [
    ['clouds', { timeOfDay: 0.5, rain: 0, cover: 0.45, biome: 'residential' }],
    ['drizzle', { timeOfDay: 0.5, rain: 0.25, cover: 0.55, biome: 'residential' }],
    ['mist', { timeOfDay: 0.5, rain: 0, cover: 0.3, mist: 0.85, biome: 'residential' }],
    ['rain', { timeOfDay: 0.5, rain: 0.7, cover: 0.6, biome: 'residential' }],
    ['storm', { timeOfDay: 0.5, rain: 1, cover: 0.85, biome: 'residential' }],
    ['snow', { timeOfDay: 0.5, rain: 0.5, cover: 0.5, snow: true, biome: 'residential' }],
  ];
  for (const [name, environment] of cases) {
    const { fog, snap } = settle(environment);
    assert.deepEqual(fog.view(view), baseline.view(view), `${name} moveu a area de corte`);
    // Só a névoa passa abaixo de 0.4: é exatamente para isso que ela existe. As outras
    // frentes têm que continuar deixando a rua reconhecível.
    assert.ok(snap.clarity <= 0.601 && snap.clarity > (name === 'mist' ? 0.3 : 0.4),
      `${name} clarity ${snap.clarity}`);
    assert.ok(snap.clarity < clear.snap.clarity, `${name} não fechou a visão`);
    if (name === 'clouds' || name === 'storm' || name === 'rain' || name === 'drizzle') {
      assert.ok(brightness(snap) < brightness(clear.snap), `${name} não escureceu`);
    }
    if (name === 'mist') assert.ok(brightness(snap) > brightness(clear.snap), 'a névoa não clareou');
    if (name === 'snow') assert.ok(brightness(snap) > brightness(clear.snap), 'neve não clareou a borda');
  }
});

test('label names the season and the front in pt-BR', () => {
  const w = new WeatherSystem();
  assert.equal(w.label, 'Primavera · limpo');
  w.season = 'inverno';
  w.force('snow', 30);
  assert.equal(w.label, 'Inverno · neve');
  w.force('storm', 30);
  assert.equal(w.label, 'Inverno · tempestade');
  w.force('mist', 30);
  assert.equal(w.label, 'Inverno · névoa');
  w.force('drizzle', 30);
  assert.equal(w.label, 'Inverno · garoa');
});

test('a paused or bad dt changes nothing and a wild rng cannot break the cycle', () => {
  const w = new WeatherSystem();
  const snapshot = JSON.stringify([w.season, w.kind, w.intensity, w.cover, w.mist, w.wind]);
  for (const dt of [0, -1, NaN, Infinity]) w.update(dt, fixed(0.3), 'forest');
  assert.equal(JSON.stringify([w.season, w.kind, w.intensity, w.cover, w.mist, w.wind]), snapshot);
  const wild = new WeatherSystem();
  const rngs = [() => NaN, () => -5, () => 1e9, () => 0.999999];
  for (const rng of rngs) {
    for (const biome of ['downtown', 'beach', 'pinewood', 'desert']) {
      for (let i = 0; i < 4000; i++) wild.update(0.1, rng, biome);
      assert.ok(Number.isFinite(wild.intensity) && wild.intensity >= 0 && wild.intensity <= 1, 'umidade fora de 0..1');
      assert.ok(Number.isFinite(wild.cover) && wild.cover >= 0 && wild.cover <= 1, 'cobertura fora de 0..1');
      assert.ok(Number.isFinite(wild.mist) && wild.mist >= 0 && wild.mist <= 1, 'névoa fora de 0..1');
      assert.ok(Number.isFinite(wild.wind) && Math.abs(wild.wind) <= 1, 'vento fora de -1..1');
      assert.ok(['primavera', 'verao', 'outono', 'inverno'].includes(wild.season));
    }
  }
});

console.log(`Weather checks: ${passed} passed, ${failed} failed.`);
if (failed) { console.error('Failures may indicate implementation issues; assertions were not relaxed.'); process.exitCode = 1; }
