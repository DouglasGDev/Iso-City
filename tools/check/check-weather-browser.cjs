// Run: node tools/check/check-weather-browser.cjs (precisa do Expo web em :8082 e Chrome em :9223).
// Estações, neve, tempestade e chuva no canvas real, com a simulação rodando de verdade.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
let socket, serial = 0;
const pending = new Map(), errors = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++serial; pending.set(id, { resolve, reject });
  socket.send(JSON.stringify({ id, method, params }));
});
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}
async function until(expression, label, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await evaluate(expression)) return; await delay(60); }
  throw new Error('Timed out: ' + label);
}
async function screenshot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.resolve(__dirname, '../tmp/' + name + '.png'), Buffer.from(data, 'base64'));
}
async function launch(mobile) {
  await send('Page.navigate', { url: 'about:blank' });
  await send('Emulation.setDeviceMetricsOverride', { width: mobile ? 844 : 1000, height: mobile ? 390 : 640, deviceScaleFactor: 1, mobile });
  await send('Emulation.setTouchEmulationEnabled', { enabled: mobile, maxTouchPoints: 5 });
  await send('Page.navigate', { url: 'http://localhost:8082/?weather-qa=' + Number(mobile) });
  await until('!!document.body?.innerText.match(/JOGAR|NOVO JOGO/)', 'menu', 90000);
  const p = await evaluate(`(()=>{const e=[...document.querySelectorAll('div')].find(e=>e.childElementCount===0&&(e.textContent==='JOGAR'||e.textContent==='NOVO JOGO'));const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  if (mobile) {
    await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...p, id: 1 }] });
    await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } else {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...p, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...p, button: 'left', clickCount: 1 });
  }
  await until('document.body.innerText.includes("HP 100")', 'HUD');
  await evaluate(`(()=>{const m=[...__r.getModules().values()].filter(m=>m.isInitialized).map(m=>m.publicModule.exports);
    globalThis.qa={g:m.find(m=>m?.getGame).getGame()};
    qa.g.player.invulnUntil=Infinity;qa.g.dayNight.t=.5;
    // O relógio das frentes fica congelado: aqui só interessa o que foi forçado na agulha.
    qa.g.weather.checkTimer=1e9;
    // Amostra o clarão em 25ms: o flash dura ~0.3s e o polling do Node perderia bordas.
    qa.flashes=0;qa.lit=false;qa.thunder=0;
    qa.samp=setInterval(()=>{const w=qa.g.weather;if(w.bolt>0&&!qa.lit)qa.flashes++;qa.lit=w.bolt>0;},25);
  })()`);
  // Um trovão por clarão: conta sem trocar o caminho real de áudio.
  await evaluate(`(()=>{const w=qa.g.weather,orig=w.onThunder;w.onThunder=()=>{qa.thunder++;orig();};})()`);
}
/** Estado atual do clima + o que a névoa fez com a cena. */
const read = () => evaluate(`(()=>{const g=qa.g,w=g.weather,s=g.fog.snapshot;
  return {season:w.season,kind:w.kind,intensity:w.intensity,cover:w.cover,wind:w.wind,snow:w.snowing,
    bolt:w.bolt,label:w.label,color:s.color,clarity:s.clarity,
    view:[Math.round(g.fog.view({camera:g.camera,viewW:g.viewW,viewH:g.viewH}).radiusX),
      Math.round(g.fog.view({camera:g.camera,viewW:g.viewW,viewH:g.viewH}).radiusY)].join('x')}})()`);
async function teleport(biome) {
  const at = await evaluate(`(()=>{const g=qa.g;
    const bad=(x,y)=>g.map.data.buildings.some(b=>Math.hypot(b.x-x,b.y-y)<3.5);
    const i=g.map.data.tiles.findIndex((t,i)=>t.biome===${JSON.stringify(biome)}
      &&['grass','dirt','sand','concrete'].includes(t.kind)
      &&!bad(i%g.map.data.tilesW+.5,Math.floor(i/g.map.data.tilesW)+.5));
    if(i<0)throw new Error('Nenhum tile aberto em ${biome}');
    const x=i%g.map.data.tilesW+.5,y=Math.floor(i/g.map.data.tilesW)+.5;
    g.player.x=x;g.player.y=y;g.camera.x=x;g.camera.y=y;g.notifyEntityChange();
    return {x,y,biome:g.map.data.tiles[i].biome}})()`);
  await delay(1200);
  return at;
}
let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('OK ' + name); }
  catch (error) { failed++; console.error('FAIL ' + name + '\n' + error.stack); }
}
(async () => {
  const pages = await (await fetch('http://127.0.0.1:9223/json/list')).json();
  socket = new WebSocket(pages.find(p => p.type === 'page').webSocketDebuggerUrl);
  socket.onmessage = ({ data }) => {
    const m = JSON.parse(data);
    if (m.id) { const p = pending.get(m.id); if (!p) return; pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errors.push(m.params.entry.text);
  };
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = () => reject(new Error('CDP falhou')); });
  await send('Runtime.enable'); await send('Page.enable'); await send('Log.enable');

  await launch(true);
  await test('o HUD diz em português a estação e o tempo de agora', async () => {
    const state = await read();
    assert.ok(['primavera', 'verao', 'outono', 'inverno'].includes(state.season));
    assert.match(state.label, /^(Primavera|Verão|Outono|Inverno) · (limpo|nublado|chuva|tempestade|neve)$/);
    assert.ok(await evaluate(`document.body.innerText.includes(${JSON.stringify(state.label)})`),
      `HUD sem a etiqueta "${state.label}"`);
  });

  await test('neve cai devagar, clareia a borda e não mexe na área de corte', async () => {
    const where = await teleport('pinewood');
    assert.equal(where.biome, 'pinewood');
    await evaluate('qa.g.weather.force("clear",1);qa.g.dayNight.t=.5');
    await delay(7000);
    const dry = await read();
    assert.equal(dry.kind, 'clear');
    assert.equal(dry.intensity, 0, 'o céu limpo não terminou de secar');
    await evaluate('qa.g.weather.season="inverno";qa.g.weather.force("snow",3600)');
    await delay(9000);
    const snow = await read();
    assert.equal(snow.snow, true);
    assert.ok(snow.intensity > 0.2 && snow.intensity < 0.6, `umidade da neve ${snow.intensity}`);
    assert.ok(snow.cover > 0.3, 'neve sem céu coberto');
    assert.equal(snow.view, dry.view, 'a neve mudou o footprint do bake');
    assert.ok(snow.clarity < dry.clarity, 'a neve não fechou a visibilidade');
    assert.ok(snow.color !== dry.color, 'a neve não mudou a cor da borda');
    assert.equal(snow.label, 'Inverno · neve');
    await screenshot('qa-weather-snow');
  });

  await test('tempestade relampeja e cada clarão chama um trovão', async () => {
    await evaluate('qa.flashes=0;qa.thunder=0;qa.lit=false');
    await evaluate('qa.g.weather.force("storm",3600);qa.g.dayNight.t=.28');
    await delay(26000);
    const storm = await read();
    assert.equal(storm.kind, 'storm');
    assert.ok(storm.intensity > 0.6, `tempestade fraca ${storm.intensity}`);
    const seen = await evaluate('({flashes:qa.flashes,thunder:qa.thunder})');
    assert.ok(seen.flashes >= 2, `tempestade com ${seen.flashes} clarões`);
    await screenshot('qa-weather-storm');
    await evaluate('qa.g.weather.force("clear",1)');
    await delay(9000);
    const after = await read();
    assert.equal(after.bolt, 0, 'clarão preso depois que a frente passou');
    assert.equal(after.intensity, 0, 'a tempestade não secou');
    // O atraso do trovão é proposital: o último clarão ainda precisa chamar o dele.
    const counted = await evaluate('({flashes:qa.flashes,thunder:qa.thunder})');
    assert.equal(counted.thunder, counted.flashes,
      `${counted.thunder} trovões para ${counted.flashes} clarões`);
  });

  await test('chuva comum molha, entorta com o vento e não relampeja', async () => {
    await teleport('downtown');
    await evaluate('qa.flashes=0;qa.thunder=0;qa.lit=false');
    await evaluate('qa.g.weather.force("rain",3600);qa.g.dayNight.t=.5');
    await delay(9000);
    const rain = await read();
    assert.equal(rain.kind, 'rain');
    assert.ok(rain.intensity > 0.5, `chuva fraca ${rain.intensity}`);
    assert.ok(Math.abs(rain.wind) <= 0.46, `vento da chuva ${rain.wind}`);
    await delay(12000);
    const seen = await evaluate('({flashes:qa.flashes,thunder:qa.thunder})');
    assert.equal(seen.flashes, 0, 'chuva comum relampejando');
    assert.equal(seen.thunder, 0);
    await screenshot('qa-weather-rain');
  });

  await test('a frente expira sozinha e a cena volta a secar', async () => {
    // Relógio das frentes travado: só a expiração da frente em si importa aqui.
    await evaluate('qa.g.weather.checkTimer=3600;qa.g.weather.force("rain",10)');
    await delay(9000);
    assert.equal((await read()).kind, 'rain', 'a frente acabou antes da hora');
    await delay(14000);
    const done = await read();
    assert.equal(done.kind, 'clear', 'a frente de 10s não expirou');
    assert.equal(done.intensity, 0, 'expirou mas a cena continuou molhada');
    assert.equal(done.cover, 0, 'expirou mas o céu continuou coberto');
    assert.equal(done.snow, false);
    assert.equal(done.clarity > 0.55, true, `visibilidade ${done.clarity} sem frente`);
  });

  assert.equal(errors.length, 0, 'erros no console:\n' + errors.slice(0, 6).join('\n'));
  await evaluate('clearInterval(qa.samp)');
  console.log(`Weather browser checks: ${passed} passed, ${failed} failed.`);
  if (failed) process.exitCode = 1;
  socket.close();
})().catch((error) => { console.error(error); process.exitCode = 1; });
