const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PNG } = require('pngjs');

const output = path.resolve(__dirname, '../tmp');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let socket;
let nextId = 0;
const pending = new Map();
const errors = [];
// Além dos erros, o harness guarda os avisos: a regra #156 é o console limpo, não só a página viva.
const avisos = [];
// Índice a índice com `avisos`: a seção que estava aberta quando cada um saiu.
const fases = [];
// O React manda o stack do componente como segundo argumento do console.error. É a diferença entre
// "apareceu um loop" e "este componente está em loop". Quando ele não manda (é o caso do
// "Maximum update depth exceeded"), a pilha vem do próprio page: o laço abaixo captura
// `new Error().stack` na hora do console.error e o Node drena a fila a cada aviso.
const pilhas = [];
// A régua roda no fim, então "existe um aviso" sem "em que seção ele nasceu" obriga a caçar às
// cegas. O log de seção é o marcador de página: guardar o último deixa o aviso geograficamente.
let secao = 'boot';
const imprimir = console.log.bind(console);
console.log = (...args) => {
  secao = String(args[0] ?? '').replace(/^OK /, '').slice(0, 34);
  return imprimir(...args);
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++nextId;
  pending.set(id, { resolve, reject });
  socket.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
};
/**
 * O stack do aviso nasce na página. Para "Maximum update depth exceeded" o React não manda o stack do
 * componente como argumento, então a régua de console nomeava o sintoma e nunca o componente culpado.
 * O hook de document-start (logo abaixo) guarda a pilha JS em `window.__qaPilhas`; o Node drena a cada
 * aviso, e a linha sai prefixada com o texto do aviso para a régua conseguir casá-los.
 */
const drenarPilhas = async () => {
  const lote = await evaluate('(() => {const l = window.__qaPilhas || []; window.__qaPilhas = []; '
    + 'return l.map((p) => p.js ? p.texto.slice(0, 60) + " || " + p.js : null).filter(Boolean);})()');
  if (lote) pilhas.push(...lote);
};
async function until(expression, label, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await evaluate(expression)) return;
    await delay(100);
  }
  throw new Error(`Timed out: ${label}`);
}
async function center(selector) {
  return evaluate(`(() => {const e=document.querySelector(${JSON.stringify(selector)}); if(!e)throw new Error('Missing '+${JSON.stringify(selector)});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
}
/** Aceita mais de um rótulo: com um save no storage o menu diz "NOVO JOGO" em vez de "JOGAR". */
async function textCenter(...texts) {
  const code = '(() => {const want=' + JSON.stringify(texts) +
    ";const e=[...document.querySelectorAll('div')].find((el) => el.childElementCount === 0 && want.indexOf(el.textContent) >= 0);" +
    "if (!e) throw new Error('Missing text ' + want.join('/'));" +
    'const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };})()';
  return evaluate(code);
}
const touches = (type, points) => send('Input.dispatchTouchEvent', {
  type, touchPoints: points.map((p) => ({ radiusX: 5, radiusY: 5, force: 1, ...p })),
});
async function tapPoint(p) {
  await touches('touchStart', [{ ...p, id: 1 }]);
  await delay(70);
  await touches('touchEnd', []);
  await delay(180);
}
async function tap(selector) { await tapPoint(await center(selector)); }
/** The context ENTRAR/INTERAGIR button appears and disappears, which nudges the whole
 *  control cluster; re-measure and tap again if the first press did not land. */
async function tapUntil(selector, condition, label, timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    await tap(selector);
    const until = Date.now() + 900;
    while (Date.now() < until) { if (await evaluate(condition)) return; await delay(60); }
  }
  throw new Error(`Timed out: ${label}`);
}
async function shotHold(ms) {
  await touches('touchStart', [{ ...await center('[data-testid="control-attack"]'), id: 1 }]);
  await delay(ms);
  await touches('touchEnd', []);
  await delay(150);
}
async function screenshot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  const bytes = Buffer.from(data, 'base64');
  fs.writeFileSync(path.join(output, `${name}.png`), bytes);
  return PNG.sync.read(bytes);
}
function pixel(image, x, y) {
  const i = (Math.round(y) * image.width + Math.round(x)) * 4;
  return Array.from(image.data.subarray(i, i + 3));
}
function nearPixel(actual, expected, message) {
  // Chrome color-profile conversion slightly shifts the canvas palette in screenshots.
  assert.ok(actual.every((value, i) => Math.abs(value - expected[i]) <= 8), `${message}: ${actual} vs ${expected}`);
}
const channelDistance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
/** The rim colour is weather/biome driven, so the checks read it live instead of hardcoding it. */
const fogState = () => evaluate(`(() => {const s = qa.g.fog.snapshot, h = s.color.slice(1);
  return { rgb: [0, 2, 4].map((i) => parseInt(h.substr(i, 2), 16)), positions: s.positions, colors: s.colors };})()`);
/**
 * Amarra o relógio SEM pausar: a névoa persegue a cor-alvo pelo `FogSystem.update`, então com o
 * jogo parado ela congela no meio do caminho e com o relógio livre ela muda entre o screenshot e a
 * leitura. Prender `t` e o clima a cada quadro dá um número que se repete.
 */
const amarrar = (relogio) => evaluate(`qa.g.paused=false;clearInterval(qa.__amarra);qa.__amarra=setInterval(()=>{`
  + `${relogio};const w=qa.g.weather;w.kind="clear";w.target=0;w.intensity=0;`
  + 'w.cover=0;w.coverTarget=0;w.mist=0;w.mistTarget=0;},16)');
const soltar = () => evaluate('clearInterval(qa.__amarra);qa.g.paused=false');
async function viewport(width, height, mobile = true) {
  await send('Emulation.setDeviceMetricsOverride', { width, height, screenWidth: width, screenHeight: height, deviceScaleFactor: 1, mobile });
  await send('Emulation.setTouchEmulationEnabled', mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
}
const key = (type, code, key, windowsVirtualKeyCode) => send('Input.dispatchKeyEvent', {type,code,key,windowsVirtualKeyCode});
async function exposeGame() {
  await evaluate(`(() => {const mods=[...__r.getModules().values()].filter(m=>m.isInitialized).map(m=>m.publicModule.exports);globalThis.qa={g:mods.find(m=>m?.getGame).getGame(),store:mods.find(m=>m?.useGameStore).useGameStore,input:mods.find(m=>m?.inputState).inputState,sprites:mods.find(m=>m?.spriteStore).spriteStore,sound:mods.find(m=>m?.sound?.play&&m?.sound?.setLoop)?.sound,mobile:mods.find(m=>m?.isMobileBrowser).isMobileBrowser(window)};})()`);
}

(async () => {
  const tabs = await (await fetch('http://127.0.0.1:9223/json/list')).json();
  const page = tabs.find((t) => t.type === 'page');
  socket = new WebSocket(page.webSocketDebuggerUrl);
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (message.id) {
      const p = pending.get(message.id);
      if (!p) return;
      pending.delete(message.id);
      if (message.error) p.reject(new Error(message.error.message));
      else p.resolve(message.result);
    } else if (message.method === 'Runtime.exceptionThrown') {
      errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
    } else if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
      errors.push(message.params.entry.text);
    } else if (message.method === 'Log.entryAdded' && message.params.entry.level === 'warning') {
      avisos.push(message.params.entry.text);
      fases.push(secao);
    } else if (message.method === 'Runtime.consoleAPICalled' && (message.params.type === 'warning' || message.params.type === 'error')) {
      // O tipo está em `params.type`; `message.type` só existe em resposta de comando. Ler o campo
      // errado fazia todo console.warn virar silêncio e o "console limpo" ser do harness, não do jogo.
      const texto = message.params.args.map((a) => a.value ?? a.description ?? '').join(' ');
      avisos.push(texto);
      fases.push(secao);
      const pilha = message.params.args.slice(1).map((a) => a.value ?? a.description ?? '').join('');
      if (pilha) pilhas.push(`${texto.slice(0, 60)}${pilha.slice(0, 400)}`);
      // Sem stack no argumento, a pilha é a da própria página no instante do console.*: drena já.
      if (!pilha) void drenarPilhas().catch(() => {});
    }
  });
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve); socket.addEventListener('error', reject); });
  await send('Page.enable');
  await require('./bundle-identity.cjs').attach(socket, send);
  await send('Page.navigate', { url: 'about:blank' });
  await until('location.href === "about:blank"', 'clean browser context');
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Log.clear');
  // Antes de qualquer script da página: o aviso de loop nasce no boot, e perder o instante é perder
  // o autor. O texto completo fica na página; só a pilha das oito primeiras linhas vem pro Node.
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: 'window.__qaPilhas = []; for (const nivel of ["warn", "error"]) {'
      + 'const original = console[nivel].bind(console);'
      + 'console[nivel] = function (...args) {'
      + 'const texto = String((args[0] && args[0].message) || args[0] || "");'
      + 'const bruta = args[0] && args[0].stack ? String(args[0].stack) : new Error().stack;'
      + 'window.__qaPilhas.push({ texto, js: bruta.split("\\n").slice(1, 9).join(" | ") });'
      + 'if (window.__qaPilhas.length > 120) window.__qaPilhas.shift();'
      + 'return original(...args);};};',
  });
  await viewport(844, 390);
  errors.length = 0;
  avisos.length = 0;
  pilhas.length = 0;
  fases.length = 0;
  await send('Page.navigate', { url: 'http://localhost:8082/?isolated-test=1' });
  // Navegar reaplica o override da aba: reafirmar, senão o desktop herda o toque e perde o teclado.
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await until('!!document.body?.innerText.match(/JOGAR|NOVO JOGO/)', 'initial asset loading', 180000);
  await tapPoint(await textCenter('JOGAR', 'NOVO JOGO'));
  await until('!!document.querySelector("[data-testid=control-weapon]")', 'game controls');
  await exposeGame();
  await delay(500);
  assert.equal(await evaluate('qa.mobile'), true);
  assert.equal(await evaluate('!!document.querySelector("[data-testid=hardware-hints]")'), false);
  await amarrar('qa.g.dayNight.t=0.5');
  await delay(2600);
  const fogDay = await screenshot('qa-fog-day');
  const dayFog = await fogState();
  await soltar();
  nearPixel(pixel(fogDay, 8, 8), dayFog.rgb, 'opaque fog must cover unloaded corners');
  assert.deepEqual(pixel(fogDay, 8, 8), pixel(fogDay, 836, 382));
  assert.equal(await evaluate('qa.g.weapons.equipped'), 'unarmed');
  // O mundo abre com a fila de sprites ainda correndo, então cobrar chave do depósito aqui sem
  // esperar a fila fechar mediria pressa de carregamento, não asset faltando.
  await until(`(()=>{const mods=[...__r.getModules().values()].filter(m=>m.isInitialized)
      .map(m=>m.publicModule.exports);
    return mods.find(m=>m?.CARREGAMENTO).CARREGAMENTO.every((k)=>!!qa.sprites[k])})()`,
    'fila de sprites fechada', 180000);
  for (const key of ['rifle', 'shotgun', 'bat']) {
    for (const dir of ['NE', 'NW', 'SE', 'SW']) {
      assert.ok(await evaluate(`!!qa.sprites['Weapons/${key}_${dir}.png']`), `missing sprite Weapons/${key}_${dir}.png`);
    }
    assert.ok(await evaluate(`!!qa.sprites['Weapons/${key}_icon.png']`), `missing icon ${key}`);
  }
  assert.equal(await evaluate(`Object.keys(qa.sprites).filter(k=>k.startsWith('Characters/char_police_')).length`), 20);
  console.log('OK assets: rifle/shotgun/bat sprites, icons and 20 police frames are loaded');
  assert.deepEqual(await evaluate(`[...qa.g.weapons.owned]`), ['unarmed', 'bat'], 'only melee at spawn');
  assert.deepEqual(await evaluate('qa.g.weapons.ammo.pistol'), { loaded: 0, reserve: 0 });
  await evaluate('qa.g.weapons.acquire("pistol")');
  await tapUntil('[data-testid="control-weapon"]', 'qa.g.weapons.equipped==="pistol"', 'pistol selection');
  await shotHold(700);
  assert.equal(await evaluate('qa.g.weapons.ammo.pistol.loaded'), 11);
  await tap('[data-testid="control-reload"]');
  await until('qa.g.weapons.reloadLeft>0', 'reload start');
  await screenshot('qa-reloading');
  await until('qa.g.weapons.reloadLeft===0', 'reload completion');
  assert.deepEqual(await evaluate('qa.g.weapons.ammo.pistol'), { loaded: 12, reserve: 47 });
  console.log('OK touch: select pistol, semi-auto hold, manual reload and ammo HUD');

  await evaluate('qa.g.weapons.acquire("smg")');
  await tapUntil('[data-testid="control-weapon"]', 'qa.g.weapons.equipped==="smg"', 'SMG selection');
  await shotHold(450);
  const ammo = await evaluate('qa.g.weapons.ammo.smg.loaded');
  assert.ok(ammo <= 27 && ammo >= 22, `SMG hold: ${ammo}`);
  await delay(250);
  assert.equal(await evaluate('qa.g.weapons.ammo.smg.loaded'), ammo);
  const fire = await center('[data-testid="control-attack"]');
  const joy = { x: 170, y: 300, id: 1 };
  await touches('touchStart', [joy]);
  await touches('touchMove', [{ ...joy, x: 200 }]);
  await touches('touchStart', [{ ...joy, x: 200 }, { ...fire, id: 2 }]);
  await delay(250);
  assert.ok(await evaluate('qa.input.magnitude>0 && qa.input.attackHeld'));
  await touches('touchCancel', []);
  await delay(100);
  assert.ok(await evaluate('qa.input.magnitude===0 && !qa.input.attackHeld'));
  console.log('OK touch: automatic fire, release and multitouch cancel');

  await touches('touchStart', [{ ...fire, id: 1 }]);
  await delay(100);
  const pause = await center('[data-testid="hud-pause"]');
  await touches('touchStart', [{ ...fire, id: 1 }, { ...pause, id: 2 }]);
  await touches('touchEnd', [{ ...fire, id: 1 }]);
  await delay(180);
  await touches('touchEnd', []);
  await until('qa.store.getState().paused', 'pause button while firing');
  assert.equal(await evaluate('qa.input.attackHeld'), false);
  const frozenTime = await evaluate('qa.g.time');
  await delay(300);
  assert.equal(await evaluate('qa.g.time'), frozenTime);
  assert.equal(await evaluate('!!document.querySelector("[data-testid=hardware-hints]")'), false);
  await tapPoint(await textCenter('CONTINUAR'));
  await until('!qa.store.getState().paused', 'resume');
  const resumedAmmo = await evaluate('qa.g.weapons.ammo.smg.loaded');
  await delay(250);
  assert.equal(await evaluate('qa.g.weapons.ammo.smg.loaded'), resumedAmmo);
  console.log('OK pause: freezes game and releases held fire before resuming');

  await evaluate(`(() => {
    qa.updateCount=0;
    qa.originalUpdate=qa.g.update;
    qa.g.update=function(dt){qa.updateCount++;return qa.originalUpdate.call(this,dt)};
    qa.input.attackHeld=true;qa.input.magnitude=1;
    Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});
    document.dispatchEvent(new Event('visibilitychange'));
  })()`);
  await until('qa.store.getState().paused && !qa.input.attackHeld && qa.input.magnitude===0', 'background suspension');
  await delay(150);
  const background = await evaluate('({time:qa.g.time,updates:qa.updateCount})');
  await delay(350);
  assert.deepEqual(await evaluate('({time:qa.g.time,updates:qa.updateCount})'), background);
  await evaluate(`delete document.visibilityState;document.dispatchEvent(new Event('visibilitychange'))`);
  await delay(200);
  assert.equal(await evaluate('qa.store.getState().paused'), true);
  assert.equal(await evaluate('qa.updateCount'), background.updates);
  await tapPoint(await textCenter('CONTINUAR'));
  await until(`qa.updateCount>${background.updates}`, 'loop restarts after explicit resume');
  await evaluate('qa.g.update=qa.originalUpdate');
  console.log('OK lifecycle: background clears inputs, stops updates and waits for explicit resume');

  await evaluate(`(() => {const g=qa.g; g.wanted.clear(g.player); g.police.reset();const car=g.vehicles.find(v=>!v.occupied&&v.def.type==='sedan'&&v.state!=='destroyed'); qa.car=car;g.player.x=car.x+0.75;g.player.y=car.y;g.player.health=100;})()`);
  await until('!!document.querySelector("[data-testid=control-enter]")', 'enter vehicle button');
  await delay(500);
  await tap('[data-testid="control-enter"]');
  await until('qa.g.player.currentVehicleId!==null', 'vehicle entry');
  await until('!!document.querySelector("[data-testid=control-accel]")', 'vehicle pedals');
  const vehicleStart = await evaluate('({x:qa.car.x,y:qa.car.y})');
  await touches('touchStart', [{ ...await center('[data-testid="control-accel"]'), id: 1 }]);
  await delay(650);
  await touches('touchEnd', []);
  assert.ok(await evaluate(`Math.hypot(qa.car.x-${vehicleStart.x},qa.car.y-${vehicleStart.y})>0.1`));
  await screenshot('qa-driving');
  // Buzina: o toque no botão do motorista produz exatamente uma execução do som do carro.
  await evaluate('qa.plays=[];qa.origPlay=qa.sound.play;qa.sound.play=function(k,v){qa.plays.push([k,v]);return qa.origPlay.call(qa.sound,k,v)}');
  assert.ok(await evaluate('!!document.querySelector("[data-testid=control-horn]")'), 'the horn button must mount while driving');
  const loudHorns = () => evaluate('qa.plays.filter(([k,v])=>k==="carHorn"&&v>0.8).length');
  const pontoBuzina = await center('[data-testid="control-horn"]');
  await tapPoint(pontoBuzina);
  await until('qa.plays.filter(([k,v])=>k==="carHorn"&&v>0.8).length===1', 'a buzina soa no toque', 5000);
  assert.ok(await evaluate('qa.g.hornCooldown > 0'), 'a buzina precisa de cooldown ou o martelo do volante vira sirene');
  // O re-toque é medido no relógio do jogo, não no de parede. Os 70+180ms do `tapPoint` somados ao
  // round-trip do CDP caiam em ~570ms depois da primeira buzina, contra um cooldown de 550ms: a
  // margem era de 20ms e o teste acusava o produto de não ter cooldown nenhum. Um par
  // start/end sem espera chega ~40ms depois, e a espera do cooldown vira uma asserção.
  await touches('touchStart', [{ ...pontoBuzina, id: 1 }]);
  await touches('touchEnd', []);
  await delay(140);
  assert.equal(await loudHorns(), 1, 'the horn cooldown must swallow an instant re-tap');
  await until('qa.g.hornCooldown <= 0', 'o cooldown da buzina expira', 5000);
  await tapPoint(pontoBuzina);
  await until('qa.plays.filter(([k,v])=>k==="carHorn"&&v>0.8).length===2', 'a buzina volta depois do cooldown', 5000);
  await evaluate('qa.sound.play=qa.origPlay');
  await tap('[data-testid="control-exit"]');
  await until('qa.g.player.currentVehicleId===null', 'vehicle exit');
  console.log('OK vehicle: contextual entry, acceleration, driver horn, driving UI and exit');

  // ---- melee: soco, taco com sprite real e armas novas na mão ----
  await evaluate(`(() => {const g=qa.g; g.wanted.clear(g.player); g.police.reset();
    g.player.currentVehicleId=null; g.player.state='idle'; g.player.swimming=false;
    const n=g.npcs.find(n=>!n.dead&&!n.inVehicle&&n.kind==='civ'); qa.target=n;
    n.x=g.player.x+0.6; n.y=g.player.y; n.health=100; n.state='idle';
    g.player.facingAngle=0; g.player.direction='SE'; g.weapons.equipped='unarmed';})()`);
  await delay(400);
  await tap('[data-testid="control-attack"]');
  await delay(90);
  await screenshot('qa-melee-punch');
  assert.ok(await evaluate('qa.target.health < 100'), 'punch must damage the adjacent civilian');
  await until('qa.g.player.attackTimer===0', 'punch animation ends');
  await evaluate(`(() => {const g=qa.g; while (g.weapons.equipped !== 'bat') g.weapons.cycle();})()`);
  await delay(120);
  assert.equal(await evaluate('qa.g.weapons.equipped'), 'bat');
  await evaluate('qa.target.health=100;qa.target.x=qa.g.player.x+1.1;qa.target.y=qa.g.player.y');
  await tap('[data-testid="control-attack"]');
  await delay(140);
  await screenshot('qa-melee-bat');
  assert.ok(await evaluate('qa.target.health <= 62'), `bat swing damage: ${await evaluate('qa.target.health')}`);
  await until('qa.g.player.attackTimer===0', 'bat swing ends');
  await evaluate('qa.g.weapons.acquire("rifle");qa.g.weapons.equipped="rifle";qa.g.weapons.refill();qa.g.player.facingAngle=-Math.PI/2');
  await delay(400);
  await screenshot('qa-weapon-rifle');
  console.log('OK melee: punch and bat swings hit, bat uses the real sprite, rifle held sprite');

  await evaluate(`(() => {const g=qa.g;const crate=g.pickups.items.find(p=>p.kind==='ammo');g.weapons.ammo.pistol.loaded=0;g.weapons.ammo.pistol.reserve=0;g.player.x=crate.x;g.player.y=crate.y;})()`);
  await until('qa.g.weapons.ammo.pistol.reserve===48', 'gunshop ammo pickup');
  await tap('[data-testid="hud-map"]');
  await until('qa.store.getState().mapOpen', 'full map');
  await screenshot('qa-map');
  await tapPoint({x: 520, y: 140});
  await until('qa.store.getState().mapMarker!==null && qa.store.getState().mapRoute.length>1', 'touch map destination and GPS route');
  const marker = await evaluate('qa.store.getState().mapMarker');
  await touches('touchStart', [{x: 350,y: 210,id: 1}]);
  await touches('touchMove', [{x: 405,y: 245,id: 1}]);
  await delay(120);
  await touches('touchEnd', []);
  assert.deepEqual(await evaluate('qa.store.getState().mapMarker'), marker, 'drag must not place another marker');
  await screenshot('qa-map-destination');
  await tap('[data-testid="full-map-close"]');
  await until('!qa.store.getState().mapOpen', 'close map');
  console.log('OK gunshop pickup, real touch map destination, route, pan and close');

  // ---- polícia real: unidades, área de busca no mapa ----
  // A wanted level on its own only spawns escorts; the search area comes from a report.
  await evaluate(`(() => {const g=qa.g; g.player.health=100; g.wanted.raise(g.player, 3);
    g.police.report({ x: g.player.x, y: g.player.y });})()`);
  await until('qa.g.police.cops.length>0 || qa.g.police.units.length>0', 'police response', 30000);
  assert.ok(await evaluate('qa.g.police.searchArea!==null'), 'search area must exist while wanted');
  assert.ok(await evaluate('qa.g.npcs.some(n=>n.kind==="cop")'), 'officers must be cop-kind NPCs');
  await screenshot('qa-police-response');
  await tap('[data-testid="hud-map"]');
  await until('qa.store.getState().mapOpen', 'map for the police area');
  await delay(400);
  await screenshot('qa-map-police-area');
  await tap('[data-testid="full-map-close"]');
  await until('!qa.store.getState().mapOpen', 'close police map');
  await evaluate(`(() => {const g=qa.g; g.wanted.clear(g.player); g.police.reset();})()`);
  console.log('OK police: real officers respond, expanding search area renders on the map');

  await evaluate(`(() => {const g=qa.g; const e=g.interiors.entrances.find(e=>e.kind==='home');qa.door=e;g.player.x=e.x;g.player.y=e.y;g.wanted.clear(g.player);g.police.reset();})()`);
  await until('!!document.querySelector("[data-testid=control-interact]")', 'interior entrance action');
  await evaluate('qa.g.wanted.raise(qa.g.player, 2)');
  await delay(500);
  await tap('[data-testid="control-interact"]');
  await until('qa.g.interiors.active!==null', 'enter furnished home');
  await delay(500);
  await screenshot('qa-interior-home');
  assert.ok(await evaluate('qa.g.interiors.active.furniture.length>=5'));
  await evaluate('qa.g.player.x=qa.g.interiors.active.service.x;qa.g.player.y=qa.g.interiors.active.service.y;qa.g.player.health=50;qa.g.player.money=500');
  await delay(500);
  await tap('[data-testid="control-interact"]');
  await until('qa.g.player.money===475 && qa.g.player.health===100', 'home rest interaction');
  await until('qa.g.player.wantedLevel===1', 'first wanted star fades while concealed', 20000);
  assert.equal(await evaluate('qa.g.police.playerVisible'), false);
  await screenshot('qa-wanted-decaying');
  await until('qa.g.player.wantedLevel===0 && qa.g.police.searchArea===null', 'wanted clears and police stand down', 20000);
  assert.equal(await evaluate('qa.g.police.active'), false);
  await screenshot('qa-wanted-cleared');
  console.log('OK wanted: two stars fade while hidden, then search and reinforcements end');
  await evaluate('qa.g.player.x=qa.g.interiors.active.exit.x;qa.g.player.y=qa.g.interiors.active.exit.y');
  await delay(600);
  await tap('[data-testid="control-interact"]');
  await until('qa.g.interiors.active===null', 'leave interior');
  assert.ok(await evaluate('Math.hypot(qa.g.player.x-qa.door.x,qa.g.player.y-qa.door.y)<0.1'));
  console.log('OK furnished interior: touch enter, furniture, paid rest and safe exit');

  await evaluate(`(() => {const g=qa.g;g.player.x=g.map.data.playerSpawn.x;g.player.y=g.map.data.playerSpawn.y;g.player.facingAngle=0;g.player.direction='SE';g.weather.intensity=0;g.wanted.clear(g.player);g.police.reset();})()`);
  await delay(1000);
  await screenshot('qa-armed-city');
  for (const width of [844, 667]) {
    await viewport(width, 390);
    await delay(500);
    const boxes = await evaluate(`[...document.querySelectorAll('[data-testid^="control-"]')].map(e=>({id:e.dataset.testid,rect:(()=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height}})()}))`);
    for (const b of boxes) {
      assert.ok(b.rect.w >= 48 && b.rect.h >= 48, `small touch target: ${b.id}`);
      assert.ok(b.rect.x >= 0 && b.rect.y >= 0 && b.rect.x+b.rect.w <= width && b.rect.y+b.rect.h <= 390, `offscreen target: ${b.id}`);
    }
  }
  await screenshot('qa-compact');
  console.log('OK mobile layouts: 844x390 and 667x390, targets >=48px and within screen');
  await viewport(844, 390);
  await delay(500);
  await evaluate('qa.g.player.stamina=1');
  const run = await center('[data-testid="control-run"]');
  const origin = {x:150,y:280,id:1};
  const moving = {...origin,x:198};
  await touches('touchStart', [origin]);
  await touches('touchMove', [moving]);
  await delay(350);
  const walkSpeed = await evaluate('qa.g.player.speed');
  assert.ok(walkSpeed>1.5 && walkSpeed<2, `mobile walk ${walkSpeed}`);
  await touches('touchStart', [moving,{...run,id:2}]);
  await delay(350);
  assert.ok(await evaluate('qa.g.player.speed>3.7 && qa.g.player.state==="running"'));
  await screenshot('qa-sprinting');
  await touches('touchEnd', []);
  console.log('OK mobile sprint: full joystick walks, second finger runs at visibly higher speed');

  await evaluate(`qa.pad={index:0,connected:true,mapping:'standard',axes:[0,0,0,0],buttons:Array.from({length:17},()=>({pressed:false,value:0}))};Object.defineProperty(navigator,'getGamepads',{configurable:true,value:()=>[qa.pad]})`);
  await delay(200);
  await evaluate('qa.pad.axes[0]=1;qa.pad.buttons[7]={pressed:true,value:1}');
  for (const [code, value, vk] of [['KeyW','w',87],['Space',' ',32],['KeyM','m',77],['Escape','Escape',27]]) {
    await key('keyDown',code,value,vk); await key('keyUp',code,value,vk);
  }
  await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:570,y:210});
  await send('Input.dispatchMouseEvent',{type:'mousePressed',x:570,y:210,button:'left',clickCount:1});
  await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:570,y:210,button:'left',clickCount:1});
  await delay(300);
  assert.ok(await evaluate('!!document.querySelector("[data-testid=control-attack]") && !document.querySelector("[data-testid=hardware-hints]")'));
  assert.ok(await evaluate('!qa.store.getState().paused && !qa.store.getState().mapOpen && qa.input.magnitude===0 && !qa.input.attackHeld && !qa.input.aimActive'));
  await touches('touchStart', [origin]);
  await touches('touchMove', [moving]);
  await delay(200);
  assert.ok(await evaluate('qa.input.magnitude>0 && !qa.input.attackHeld'));
  await touches('touchCancel', []);
  await delay(100);
  assert.equal(await evaluate('qa.input.magnitude'), 0);
  await screenshot('qa-mobile-touch-only');
  console.log('OK mobile: hardware events never hide touch controls or display keyboard/gamepad hints');

  // O dia inteiro dura 300 s de relógio real, e as seções acima consomem minutos: ler a névoa do
  // relógio livre entregava um referencial em fase sorteada (numa corrida caía em pleno crepúsculo
  // quente, cujo azul fica ABAIXO do azul da noite, e a comparação de todos os canais quebrava sem
  // que nada na névoa tivesse mudado). As duas pontas se amarram, como a medição noturna já fazia.
  await amarrar('qa.g.dayNight.t=0.5');
  await delay(2600);
  const diaFog = await fogState();
  await amarrar('qa.g.dayNight.t=0.05');
  await delay(2600);
  const antesDaNoite = await fogState();
  const fogNight = await screenshot('qa-fog-night');
  const nightFog = await fogState();
  await soltar();
  assert.deepEqual(nightFog.rgb, antesDaNoite.rgb, 'a cor da névoa não pode mudar durante a medição noturna');
  nearPixel(pixel(fogNight, 8, 8), nightFog.rgb, 'night fog must still seal the corners');
  assert.ok(pixel(fogNight, 8, 8).every((channel, i) => channel < diaFog.rgb[i]),
    `night must also darken fog: ${pixel(fogNight, 8, 8)} vs ${diaFog.rgb}`);
  await evaluate('qa.g.weather.force("rain",120);qa.g.weather.intensity=0.8');
  await delay(650);
  await screenshot('qa-fog-rain');
  await amarrar('qa.g.dayNight.t=0.5');
  await delay(2600);
  await evaluate('clearInterval(qa.__amarra);qa.g.paused=true;qa.g.camera.x=-100;qa.g.camera.y=-100');
  await delay(1200);
  for (const [width, height] of [[667,390],[844,390],[1280,720],[2560,1080]]) {
    for (const zoom of [0.95, 1.85]) {
      await viewport(width, height);
      await until(`qa.g.viewW===${width} && qa.g.viewH===${height}`, 'fog viewport resize');
      await evaluate(`qa.g.camera.x=-100;qa.g.camera.y=-100;qa.g.camera.zoom=${zoom}`);
      await delay(300);
      const image = await screenshot(`qa-fog-${width}-${zoom}`);
      const fog = await fogState();
      nearPixel(pixel(image, 8, 8), fog.rgb, 'opaque fog perimeter');
      assert.deepEqual(pixel(image, 8, 8), pixel(image, width - 8, height - 8));
      // The touch HUD sits on the right of the frame, so the ramp is checked from the
      // gradient definition and the centre is checked to stay untouched by it.
      assert.ok(fog.positions[1] >= 0.5, `the clear core must reach the view centre (${fog.positions[1]})`);
      const alphas = fog.colors.map((c) => Number(/([\d.]+)\)$/.exec(c)?.[1] ?? 1));
      assert.ok(alphas.every((a, i) => i === 0 || a >= alphas[i - 1]), 'fog must only thicken outward');
      assert.ok(channelDistance(pixel(image, width / 2, height / 2), fog.rgb) > 18,
        'fog must leave the center clear');
    }
  }
  console.log('OK fog: opaque perimeter, clear center, smooth reveal, night/rain, phone/desktop sizes and both zoom limits');

  await viewport(844, 390, false);
  await send('Page.navigate', { url: 'http://localhost:8082/?isolated-test=desktop' });
  // Navegar reaplica o override da aba: reafirmar, senão o desktop herda o toque e perde o teclado.
  await send('Emulation.setTouchEmulationEnabled', { enabled: false });
  await until('!!document.body?.innerText.match(/JOGAR|NOVO JOGO/)', 'desktop asset loading', 180000);
  const play = await textCenter('JOGAR', 'NOVO JOGO');
  await send('Input.dispatchMouseEvent',{type:'mousePressed',...play,button:'left',clickCount:1});
  await send('Input.dispatchMouseEvent',{type:'mouseReleased',...play,button:'left',clickCount:1});
  await until('!!document.querySelector("[data-testid=control-weapon]")', 'desktop game ready');
  await exposeGame();
  assert.equal(await evaluate('qa.mobile'), false);
  await key('keyDown','KeyW','w',87);
  await delay(350);
  assert.ok(await evaluate('qa.input.magnitude===1 && qa.g.player.speed<2'));
  await key('keyDown','ShiftLeft','Shift',16);
  await delay(300);
  assert.ok(await evaluate('qa.input.runHeld && qa.g.player.speed>3.7'));
  await key('keyUp','ShiftLeft','Shift',16);
  await key('keyUp','KeyW','w',87);
  assert.ok(await evaluate('!!document.querySelector("[data-testid=hardware-hints]") && !document.querySelector("[data-testid=control-attack]")'));
  await key('keyDown','KeyM','m',77); await key('keyUp','KeyM','m',77);
  await until('qa.store.getState().mapOpen','keyboard map');
  await key('keyDown','Escape','Escape',27); await key('keyUp','Escape','Escape',27);
  await until('!qa.store.getState().mapOpen','keyboard close map');
  await evaluate('qa.g.weapons.acquire("pistol");qa.g.weapons.equipped="pistol";qa.g.weapons.refill()');
  await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:570,y:210});
  await send('Input.dispatchMouseEvent',{type:'mousePressed',x:570,y:210,button:'left',clickCount:1});
  await delay(400);
  await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:570,y:210,button:'left',clickCount:1});
  await until('qa.g.weapons.ammo.pistol.loaded===11','mouse fires pistol once');
  assert.ok(await evaluate('!qa.input.aimActive'), 'left button must not enable manual aim');
  await send('Input.dispatchMouseEvent',{type:'mousePressed',x:570,y:210,button:'right',clickCount:1});
  await until('qa.input.aimActive','right button holds manual aim');
  await evaluate('(() => {const a = qa.input; if (a.aimX*a.aimX + a.aimY*a.aimY < 0.99) throw new Error("manual aim is not a unit vector");})()');
  await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:570,y:210,button:'right',clickCount:1});
  await until('!qa.input.aimActive','releasing the right button returns to auto-aim');
  await screenshot('qa-desktop');
  console.log('OK desktop: WASD, Shift, keyboard map, left click fires, right click holds GTA-SA manual aim, hidden touch controls');

  await evaluate(`qa.pad={index:0,connected:true,mapping:'standard',axes:[0,0,0,0],buttons:Array.from({length:17},()=>({pressed:false,value:0}))};Object.defineProperty(navigator,'getGamepads',{configurable:true,value:()=>qa.pad?[qa.pad]:[]})`);
  await delay(200);
  await evaluate('qa.pad.axes[0]=0.8;qa.pad.axes[2]=1');
  await until('qa.input.magnitude>0.7','emulated Xbox left stick walks');
  assert.ok(await evaluate('!qa.input.aimActive'), 'right stick alone must not aim');
  await evaluate('qa.pad.buttons[6]={pressed:true,value:1}');
  await until('qa.input.aimActive','Xbox LT plus right stick holds manual aim');
  await evaluate('qa.pad.buttons[0]={pressed:true,value:1}');
  await until('qa.input.runHeld','emulated Xbox sprint');
  await evaluate('qa.g.weapons.ammo.pistol.loaded=11');
  await evaluate('qa.pad.buttons[7]={pressed:true,value:1}');
  await until('qa.g.weapons.ammo.pistol.loaded===10','Xbox RT fires');
  await evaluate('qa.pad.buttons=[...Array.from({length:17},()=>({pressed:false,value:0}))];qa.pad.axes=[0,0,0,0];qa.pad.buttons[9]={pressed:true,value:1}');
  await until('qa.store.getState().paused','emulated Xbox Start pause');
  assert.ok(await evaluate('!qa.input.attackHeld && qa.input.magnitude===0'));
  await evaluate('qa.pad.buttons[9]={pressed:false,value:0}');
  await delay(200);
  await evaluate('qa.pad.buttons[9]={pressed:true,value:1}');
  await until('!qa.store.getState().paused','emulated Xbox Start resume');
  await evaluate('qa.pad=null');
  await until('qa.input.magnitude===0 && !qa.input.runHeld','gamepad disconnect reset');
  console.log('OK emulated Xbox Standard mapping: left stick walks, LT+right stick aims, RT fires, sprint, pause/resume and disconnect; no physical controller tested');
  // #156: `pointerEvents` e `style.tintColor` passaram a viver no lugar certo, o `clock.value`
  // do WildlifeSprite saiu do render, e a sombra de texto migrou para `readableShadow`, que dá
  // `textShadow` ao react-native-web e as três propriedades antigas ao nativo. Não sobra nenhum
  // aviso de estilo: cada lado recebe a API que ele de fato aplica.
  const proibidos = avisos.filter((a) => /pointerEvents|Reading from `value`|style\.tintColor|textShadow/.test(a));
  // Um console "limpo" também é o que um listener morto imprime. Injeta um aviso conhecido e
  // exige que ele chegue: sem esta prova a contagem zero não significaria nada.
  await evaluate('console.warn("PROVA-156 listener vivo")');
  await delay(120);
  assert.ok(avisos.some((a) => a.includes('PROVA-156')), 'o harness precisa captar console.warn — listener morto fingiria console limpo');
  assert.deepEqual(proibidos, [], `avisos que não podem existir: ${proibidos.slice(0, 3).join(' | ')}`);
  // A sombra trocou de API, não desapareceu: o relógio do HUD continua com text-shadow no CSS
  // final, com o mesmo desvio e o mesmo desfoque de antes da migração.
  const sombra = await evaluate('(() => {const e=document.querySelector("[data-testid=hud-clock]");'
    + 'return e ? getComputedStyle(e).textShadow : "sem elemento";})()');
  assert.ok(/3px/.test(sombra) && !/none/.test(sombra), `a sombra do texto precisa continuar aplicada: ${sombra}`);
  // A régua é total: todo aviso que não seja o da própria prova precisa aparecer aqui, senão um
  // novo passa mudo.
  const novidades = [...new Set(avisos.filter((a) => !/PROVA-156/.test(a)))];
  const culpadas = pilhas.filter((p) => novidades.some((a) => p.startsWith(a.slice(0, 60))));
  // Sem correspondência, a última pilha captada ainda é a pista mais próxima do aviso.
  const mostradas = culpadas.length ? culpadas : pilhas.slice(-3);
  const onde = novidades.map((a) => `após [${fases[avisos.indexOf(a)] || 'boot'}] ${a.slice(0, 90)}`);
  assert.deepEqual(novidades, [], `avisos novos no console:\n${onde.join('\n')}\n`
    + `pilha do componente:\n${mostradas.join('\n---\n')}`);
  console.log(`OK console: ${avisos.length} avisos, listener provado, nenhum de pointerEvents/shared value/tintColor/textShadow, sombra do relógio aplicada (${sombra})`);
  assert.deepEqual(errors.filter(e=>!e.includes('favicon.ico')), []);
  console.log('Browser checks passed; screenshots in tools/tmp/qa-*.png');
})().catch(async (error) => {
  console.error(error);
  console.error('Browser errors:', errors);
  if (socket?.readyState === WebSocket.OPEN) {
    try { console.error(await evaluate('document.body.innerText')); await screenshot('qa-failure'); } catch {}
  }
  process.exitCode = 1;
}).finally(() => socket?.close());
