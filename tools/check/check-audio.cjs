const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const code = ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '../../src/audio/SoundManager.ts'), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
}).outputText;
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
function fixture() {
  const players = [], warnings = [], timers = new Map();
  let timerId = 0;
  const hooks = {};
  const Audio = {
    async setIsEnabledAsync() {},
    async setAudioModeAsync(mode) {
      assert.equal(mode.staysActiveInBackground, false);
      if (hooks.session) await hooks.session();
    },
    Sound: {
      async createAsync(source, status) {
        assert.equal(status.shouldPlay, false);
        const p = {
          source, looping: status.isLooping, volume: status.volume, loaded: true,
          plays: 0, stops: 0, unloads: 0, playing: false, callback: null,
          setOnPlaybackStatusUpdate(cb) { this.callback = cb; },
          async getStatusAsync() {
            if (hooks.status) await hooks.status(this);
            return { isLoaded: this.loaded, isPlaying: this.playing };
          },
          async setVolumeAsync(v) { this.volume = v; },
          async playAsync() {
            assert.equal(this.loaded, true);
            this.plays++;
            if (hooks.play) await hooks.play(this);
            this.playing = true;
          },
          async stopAsync() { this.stops++; this.playing = false; },
          async unloadAsync() { this.unloads++; this.loaded = false; },
        };
        players.push(p);
        if (hooks.create) await hooks.create(p);
        return { sound: p };
      },
    },
  };
  const sources = new Proxy({}, { get: (_, key) => key });
  const exports = {};
  vm.runInNewContext(code, {
    exports,
    require(name) {
      // O app importa os submódulos de áudio, nunca o barril 'expo-av': o barril avisa que
      // está deprecado na importação e esse aviso derruba o LogBox no aparelho.
      if (name === 'expo-av/build/Audio') return Audio;
      if (name === 'expo-av/build/Audio.types') return { InterruptionModeIOS: {}, InterruptionModeAndroid: {} };
      if (name === 'expo-asset') return { Asset: { fromModule: (uri) => ({ uri }) } };
      if (name === './sounds') return { SFX: sources, LOOPS: sources, AMBIENT: sources };
      throw new Error(name);
    },
    console: { warn: (...args) => warnings.push(args) },
    setTimeout: (fn) => { timers.set(++timerId, fn); return timerId; },
    clearTimeout: (id) => timers.delete(id),
  });
  return { sound: exports.sound, players, warnings, hooks, timers };
}
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('OK ' + name); }
(async () => {
  await test('background blocks new SFX, unlock, ambient and vehicle loops', async () => {
    const f = fixture();
    f.sound.setActive(false);
    f.sound.init();
    f.sound.play('pistolShot');
    f.sound.ambient('cityDay');
    f.sound.setLoop('engine', 'engine');
    f.sound.resumeAmbient();
    await f.sound.unlock();
    await flush();
    assert.equal(f.players.length, 0);
    assert.equal(f.sound.isUnlocked, false);
    assert.equal(f.warnings.length, 0);
  });
  await test('background unloads active sounds and preserves mute preference', async () => {
    const f = fixture();
    await f.sound.unlock();
    f.sound.ambient('cityDay');
    f.sound.setLoop('engine', 'engine');
    f.sound.setLoop('siren', 'siren');
    f.sound.play('pistolShot');
    await flush();
    assert.equal(f.players.length, 5);
    const old = [...f.players];
    f.sound.setActive(false);
    f.sound.setActive(false);
    await flush();
    assert.ok(old.every(p => !p.loaded && p.unloads === 1));
    assert.equal(f.timers.size, 0);
    assert.equal(f.sound.muted, false);
    f.sound.setActive(true);
    await flush();
    assert.equal(f.players.length, old.length + 3);
    assert.ok(f.players.slice(old.length).every(p => p.looping && p.plays === 1));
    f.sound.setMuted(true);
    f.sound.setActive(false);
    f.sound.setActive(true);
    await flush();
    assert.equal(f.sound.muted, true);
    assert.ok(f.players.every(p => !p.loaded));
  });
  await test('pending unlock cannot replay a queued shot after background/foreground', async () => {
    const f = fixture(), gate = deferred();
    f.hooks.session = () => gate.promise;
    f.sound.play('pistolShot');
    await flush();
    f.sound.setActive(false);
    f.sound.setActive(true);
    gate.resolve();
    await flush();
    assert.equal(f.players.length, 0);
    f.sound.play('pistolShot');
    await flush();
    assert.equal(f.players.filter(p => p.source.uri === 'pistolShot' && p.plays === 1).length, 1);
  });
  await test('SFX loading during background is unloaded without playing or leaking', async () => {
    const f = fixture(), gate = deferred();
    await f.sound.unlock();
    f.hooks.create = p => p.source.uri === 'pistolShot' ? gate.promise : undefined;
    f.sound.play('pistolShot');
    await flush();
    const shot = f.players.find(p => p.source.uri === 'pistolShot');
    f.sound.setActive(false);
    f.sound.setActive(true);
    gate.resolve();
    await flush();
    assert.equal(shot.plays, 0);
    assert.equal(shot.unloads, 1);
    assert.equal(f.timers.size, 0);
  });
  await test('loop loading and status requests cannot play after background', async () => {
    for (const operation of ['create', 'status']) {
      const f = fixture(), gate = deferred();
      await f.sound.unlock();
      f.hooks[operation] = p => p.looping ? gate.promise : undefined;
      f.sound.setLoop('engine', 'engine');
      await flush();
      const engine = f.players.find(p => p.looping);
      f.sound.setActive(false);
      gate.resolve();
      await flush();
      assert.equal(engine.plays, 0);
      assert.equal(engine.unloads, 1);
      assert.equal(f.warnings.length, 0);
    }
  });
  await test('native focus loss during pending play is cancelled, foreground failures still report', async () => {
    for (const loop of [false, true]) {
      const f = fixture(), gate = deferred();
      await f.sound.unlock();
      f.hooks.play = () => gate.promise;
      if (loop) f.sound.setLoop('engine', 'engine'); else f.sound.play('pistolShot');
      await flush();
      const player = f.players.at(-1);
      f.sound.setActive(false);
      gate.reject(new Error('AudioFocusNotAcquiredException'));
      await flush();
      assert.equal(player.unloads, 1);
      assert.equal(f.warnings.length, 0);
    }
    const f = fixture();
    await f.sound.unlock();
    f.hooks.play = async () => { throw new Error('broken asset'); };
    f.sound.play('pistolShot');
    await flush();
    assert.equal(f.warnings.length, 1);
    assert.equal(f.warnings[0][1].message, 'broken asset');
  });
  await test('repeated lifecycle transitions retain only the latest loop players', async () => {
    const f = fixture();
    await f.sound.unlock();
    f.sound.ambient('cityDay');
    f.sound.setLoop('engine', 'engine');
    await flush();
    for (let i = 0; i < 20; i++) {
      f.sound.setActive(false);
      await flush();
      assert.ok(f.players.every(p => !p.loaded));
      f.sound.setActive(true);
      await flush();
      assert.equal(f.players.filter(p => p.loaded).length, 2);
    }
    assert.equal(f.warnings.length, 0);
    f.sound.setActive(false);
    await flush();
    assert.ok(f.players.every(p => p.unloads === 1));
  });
  await test('regional rain channel is independent, bounded and follows unlock/mute/background cleanup', async () => {
    const f = fixture();
    f.sound.weather(0.4, 'rain'); f.sound.ambient('pinewoodDay', 0.4);
    await flush(); assert.equal(f.players.length, 0, 'no players before unlock');
    await f.sound.unlock(); await flush();
    assert.equal(f.players.filter(p => p.looping && p.loaded).length, 2);
    assert.ok(f.players.some(p => p.source.uri === 'rain' && p.playing));
    for (let i = 0; i < 10; i++) { f.sound.weather(0.3 + i * 0.01, 'rain'); f.sound.ambient('savannaNight', 0.35); }
    await flush();
    assert.equal(f.players.filter(p => p.looping && p.loaded).length, 2);
    f.sound.setMuted(true); await flush(); assert.ok(f.players.every(p => !p.loaded));
    f.sound.setActive(false); f.sound.setActive(true); await flush(); assert.ok(f.players.every(p => !p.loaded));
    f.sound.setMuted(false); await flush();
    assert.equal(f.players.filter(p => p.looping && p.loaded).length, 2);
    f.sound.weather(0, 'rain'); await flush();
    assert.equal(f.players.filter(p => p.looping && p.loaded).length, 1);
    f.sound.weather(NaN, 'rain'); await flush();
    f.sound.setActive(false); await flush(); assert.ok(f.players.every(p => p.unloads === 1));
    assert.equal(f.warnings.length, 0);
  });
  await test('one weather channel plays whichever bed was asked for', async () => {
    const f = fixture();
    await f.sound.unlock(); await flush();
    f.sound.weather(0.4, 'wind'); await flush();
    const beds = f.players.filter(p => p.looping && p.loaded);
    assert.equal(beds.length, 1, 'dois leitos de clima ao mesmo tempo');
    assert.equal(beds[0].source.uri, 'wind', 'neve tocou o leito de chuva');
    f.sound.weather(0.45, 'rain'); await flush();
    const wet = f.players.filter(p => p.looping && p.loaded);
    assert.equal(wet.length, 1); assert.equal(wet.at(-1).source.uri, 'rain');
    f.sound.weather(0, 'rain'); await flush();
    assert.equal(f.players.filter(p => p.looping && p.loaded).length, 0);
    assert.equal(f.warnings.length, 0);
  });
  await test('tornado and tsunami beds reuse the weather channel, never a second player', async () => {
    const f = fixture();
    await f.sound.unlock(); await flush();
    f.sound.weather(0.5, 'rain'); await flush();
    assert.equal(f.players.filter(p => p.looping && p.loaded).length, 1);
    for (const key of ['tornado', 'wave']) {
      f.sound.weather(0.7, key); await flush();
      const beds = f.players.filter(p => p.looping && p.loaded);
      assert.equal(beds.length, 1, `${key} abriu um segundo leito`);
      assert.equal(beds[0].source.uri, key, `o canal do tempo não trocou para ${key}`);
    }
    f.sound.weather(0, 'wave'); await flush();
    assert.equal(f.players.filter(p => p.looping && p.loaded).length, 0);
    assert.equal(f.warnings.length, 0);
  });
  const ambientExports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '../../src/systems/AmbientSystem.ts'), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText, { exports: ambientExports });
  const { AmbientSystem, selectAmbient } = ambientExports;
  await test('explicit ambient context selects every region/day/night without rain replacing the region', () => {
    for (const [biome, base] of Object.entries({ beach: 'coast', docks: 'coast', industrial: 'industry',
      countryside: 'country', forest: 'forest', park: 'forest', pinewood: 'pinewood', savanna: 'savanna',
      downtown: 'city', commercial: 'city', residential: 'city', suburb: 'city', market: 'city' })) {
      for (const rain of [0, 0.5, 1, NaN]) for (const [timeOfDay, suffix] of [[0, 'Night'], [0.5, 'Day'], [1.5, 'Day']]) {
        assert.equal(selectAmbient({ outdoors: true, biome, timeOfDay, rain }), base + suffix);
        assert.equal(selectAmbient({ outdoors: false, biome, timeOfDay, rain }), null);
      }
    }
  });
  await test('ambient transitions debounce boundaries, fade before switching and silence interiors', () => {
    const beds = [], rain = [];
    const system = new AmbientSystem({ ambient: (key, volume) => beds.push({ key, volume }), weather: v => rain.push(v) });
    const context = { outdoors: true, biome: 'countryside', timeOfDay: 0.5, rain: 0 };
    const run = (ticks) => { for (let i = 0; i < ticks; i++) system.update(0.1, context); };
    run(20); assert.equal(beds.at(-1).key, 'countryDay'); assert.equal(beds.at(-1).volume, 0.48);
    context.biome = 'forest'; run(5); context.biome = 'countryside'; run(5);
    assert.ok(beds.every(v => v.key === 'countryDay'), 'no chatter at biome boundary');
    context.biome = 'pinewood'; run(40);
    const switchIndex = beds.findIndex(v => v.key === 'pinewoodDay');
    assert.ok(switchIndex > 0); assert.equal(beds[switchIndex].volume, 0);
    assert.ok(beds[switchIndex - 1].volume <= 0.08, 'old bed faded before key switch');
    context.rain = 1; run(25);
    assert.equal(beds.at(-1).key, 'pinewoodDay'); assert.ok(beds.at(-1).volume < 0.4);
    assert.equal(rain.at(-1), 0.58);
    const before = beds.length + rain.length; run(100);
    assert.equal(beds.length + rain.length, before, 'stable state does not spam native requests');
    for (const dt of [0, -1, NaN, Infinity]) system.update(dt, { ...context, outdoors: false });
    assert.equal(beds.length + rain.length, before);
    context.outdoors = false; run(1);
    assert.equal(beds.at(-1).key, null); assert.equal(rain.at(-1), 0);
    context.outdoors = true; context.biome = 'beach'; context.timeOfDay = 0; run(30);
    assert.equal(beds.at(-1).key, 'coastNight');
  });
  await test('suspend silences region and rain for the menus and the next tick re-arms the real biome', () => {
    const beds = [], rain = [];
    const system = new AmbientSystem({ ambient: (key, volume) => beds.push({ key, volume }), weather: v => rain.push(v) });
    const context = { outdoors: true, biome: 'pinewood', timeOfDay: 0.5, rain: 1 };
    for (let i = 0; i < 30; i++) system.update(0.1, context);
    assert.equal(beds.at(-1).key, 'pinewoodDay'); assert.ok(rain.at(-1) > 0.5);
    const bedsBefore = beds.length;
    system.suspend();
    assert.deepEqual(beds.slice(bedsBefore).map((b) => b.key), [null], 'region bed must stop for the menu');
    assert.equal(rain.at(-1), 0, 'rain bed must stop for the menu');
    for (let i = 0; i < 30; i++) system.update(0.1, context);
    assert.equal(beds.at(-1).key, 'pinewoodDay'); assert.ok(rain.at(-1) > 0.5, 'resume cannot be stuck on the city bed');
  });
  await test('snow keeps the region bed but asks the weather channel for wind, softer than rain', () => {
    const beds = [], weather = [];
    const system = new AmbientSystem({ ambient: (key, volume) => beds.push({ key, volume }),
      weather: (volume, bed) => weather.push([volume, bed]) });
    const wet = { outdoors: true, biome: 'pinewood', timeOfDay: 0.5, rain: 1, snow: true };
    for (let i = 0; i < 40; i++) system.update(0.1, wet);
    assert.equal(beds.at(-1).key, 'pinewoodDay', 'a neve trocou a região do ambiente');
    assert.deepEqual(weather.at(-1), [0.4, 'wind']);
    wet.snow = false;
    for (let i = 0; i < 40; i++) system.update(0.1, wet);
    assert.deepEqual(weather.at(-1), [0.58, 'rain'], 'a chuva perdeu o leito molhado');
    // Só muda quando muda: o canal nativo não pode receber pedido a cada quadro.
    const before = weather.length;
    for (let i = 0; i < 200; i++) system.update(0.1, wet);
    assert.equal(weather.length, before, 'weather spam');
  });
  await test('a névoa não tem água nenhuma: pede o vento, entra devagar e abafa a região', () => {
    const beds = [], weather = [];
    const system = new AmbientSystem({ ambient: (key, volume) => beds.push({ key, volume }),
      weather: (volume, bed) => weather.push([volume, bed]) });
    const foggy = { outdoors: true, biome: 'forest', timeOfDay: 0.5, rain: 0, mist: 1 };
    for (let i = 0; i < 60; i++) system.update(0.1, foggy);
    assert.equal(beds.at(-1).key, 'forestDay', 'a névoa trocou a região do ambiente');
    assert.ok(beds.at(-1).volume < 0.48 - 0.08, `a mata enevoada continua alta ${beds.at(-1).volume}`);
    assert.deepEqual(weather.at(-1), [0.22, 'wind'], 'a névoa não pediu o sopro de vento');
    // Entra devagar de propósito: o som que fecha a visão não pode bater de uma vez.
    const slow = new AmbientSystem({ ambient: () => {}, weather: (volume, bed) => weather.push([volume, bed]) });
    weather.length = 0;
    for (let i = 0; i < 3; i++) slow.update(0.1, foggy);
    assert.ok(weather.at(-1)[0] < 0.08, `a névoa chegou cheia demais ${weather.at(-1)[0]}`);
    // Chuva de verdade manda no canal: a névoa não toma o lugar de quem está molhando.
    for (let i = 0; i < 60; i++) system.update(0.1, { ...foggy, rain: 0.6 });
    assert.equal(weather.at(-1)[1], 'rain', 'a névoa abafou o leito da chuva');
    assert.ok(weather.at(-1)[0] > 0.3, `a chuva perdeu volume ${weather.at(-1)[0]}`);
    for (let i = 0; i < 60; i++) system.update(0.1, { ...foggy, mist: 0 });
    assert.deepEqual(weather.at(-1), [0, 'rain'], 'a névoa sumiu e o canal ficou preso no vento');
    const before = weather.length;
    for (let i = 0; i < 200; i++) system.update(0.1, { ...foggy, mist: 0 });
    assert.equal(weather.length, before, 'weather spam depois da névoa');
  });
  await test('a hazard bed takes the weather channel from the rain and gives it back when it ends', () => {
    const beds = [], weather = [];
    const system = new AmbientSystem({ ambient: (key, volume) => beds.push({ key, volume }),
      weather: (volume, bed) => weather.push([volume, bed]) });
    const wet = { outdoors: true, biome: 'beach', timeOfDay: 0.5, rain: 1, snow: false,
      hazardBed: 'tornado', hazardVolume: 0.62 };
    for (let i = 0; i < 40; i++) system.update(0.1, wet);
    assert.equal(beds.at(-1).key, 'coastDay', 'o perigo trocou o ambiente da região');
    assert.deepEqual(weather.at(-1), [0.62, 'tornado'], 'o tornado não tomou o canal do clima');
    wet.hazardBed = 'wave'; wet.hazardVolume = 0.8;
    for (let i = 0; i < 5; i++) system.update(0.1, wet);
    assert.deepEqual(weather.at(-1), [0.8, 'wave'], 'o tsunami não assumiu o leito');
    wet.hazardBed = null;
    for (let i = 0; i < 10; i++) system.update(0.1, wet);
    assert.deepEqual(weather.at(-1), [0.58, 'rain'], 'a chuva não voltou quando o perigo acabou');
    const before = weather.length;
    for (let i = 0; i < 200; i++) system.update(0.1, wet);
    assert.equal(weather.length, before, 'weather spam durante o perigo');
  });
  await test('twelve original regional WAVs are reproducible PCM mono, seamless, non-clipping and lightweight', () => {
    const generated = new Map();
    const generator = path.resolve(__dirname, '../generate-sfx.js');
    // Run synthesis with an in-memory filesystem: tests never modify existing audio assets.
    vm.runInNewContext(fs.readFileSync(generator, 'utf8'), {
      require: (name) => name === 'fs' ? { mkdirSync() {}, writeFileSync: (file, data) => generated.set(path.basename(file), data) } : require(name),
      __dirname: path.dirname(generator), Buffer, process: { argv: ['node', generator, '--regions'] }, console: { log() {} },
    });
    assert.equal(generated.size, 12);
    const hashes = new Set(); let bytes = 0;
    const registry = fs.readFileSync(path.resolve(__dirname, '../../src/audio/sounds.ts'), 'utf8');
    for (const [name, expected] of generated) {
      const wav = fs.readFileSync(path.resolve(__dirname, '../../assets/Audio/generated', name));
      assert.ok(wav.equals(expected), name + ' must match its original synthesizer');
      assert.ok(registry.includes('/' + name)); bytes += wav.length;
      assert.equal(wav.toString('ascii', 0, 4), 'RIFF'); assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
      assert.equal(wav.readUInt16LE(20), 1); assert.equal(wav.readUInt16LE(22), 1);
      assert.equal(wav.readUInt32LE(24), 22050); assert.equal(wav.readUInt16LE(34), 16);
      assert.equal(wav.length, 44 + 22050 * 6 * 2);
      let mean = 0, squares = 0, peak = 0;
      const n = (wav.length - 44) / 2;
      for (let i = 0; i < n; i++) { const v = wav.readInt16LE(44 + i * 2) / 32767; mean += v / n; squares += v * v / n; peak = Math.max(peak, Math.abs(v)); }
      assert.ok(peak <= 0.271 && peak > 0.2); assert.ok(Math.sqrt(squares) > 0.01 && Math.sqrt(squares) < 0.15);
      assert.ok(Math.abs(mean) < 2 / 32767, name + ' DC bias');
      const seam = Math.abs(wav.readInt16LE(44) - wav.readInt16LE(wav.length - 2)) / 32767;
      assert.ok(seam < 0.025, name + ' seam: ' + seam);
      hashes.add(require('node:crypto').createHash('sha256').update(wav).digest('hex'));
    }
    assert.equal(hashes.size, 12); assert.ok(bytes < 3.3e6);
  });
  console.log(`Audio checks passed: ${passed}`);
})().catch(error => { console.error(error); process.exitCode = 1; });
