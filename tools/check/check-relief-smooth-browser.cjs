// Run: node tools/check/check-relief-smooth-browser.cjs (precisa do Expo web em :8082 e Chrome em :9223).
//
// O degrau medido na tela, não na teoria. `check-relief-smooth.cjs` prova que a cota
// contínua é contínua; este arquivo prova que o JOGO anda por ela: a posição vertical do
// sprite em relação à câmera, quadro a quadro, enquanto alguém sobe a serra a pé e depois
// ao volante. É o "sobe e desce no mesmo lugar" do jogador virado número.
//
// Cada traço compara as duas leituras do mesmo relevo no mesmo quadro: a cota contínua
// (a que o render usa hoje) e a cota quantizada por tile (a que pulava um degrau por
// borda). Se a quantizada também deslizar, o mapa não tem serra nenhuma e o teste grita.
//
// Medido na encosta mais íngreme pisável do mapa (salto de ~0,46 tile por borda):
//   a pé      1,6px por quadro contra 29,8px da leitura velha
//   ao volante 0,6px contra 29,8px, com 2,61 de 3,15 tiles/s no meio da rampa
//   câmera    0,5px por quadro e 0,03 tile de atraso
// e o caminho percorrido é igual ao deslocamento, quadro a quadro — nada devolve passo.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const WebSocket = require('ws');
const PORT = Number(process.env.QA_CDP_PORT || 9223);
let socket, serial = 0;
const pending = new Map(), errors = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const send = (method, params = {}, timeout = 30000) => new Promise((resolve, reject) => {
  const id = ++serial;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP ${method} timeout`)); }, timeout);
  pending.set(id, { resolve: (r) => { clearTimeout(timer); resolve(r); }, reject: (e) => { clearTimeout(timer); reject(e); } });
  socket.send(JSON.stringify({ id, method, params }));
});
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}
async function until(expression, label, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try { if (await evaluate(expression)) return; } catch { /* página trocando */ }
    await delay(60);
  }
  throw new Error('Timed out: ' + label);
}
async function screenshot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.resolve(__dirname, '../tmp/' + name + '.png'), Buffer.from(data, 'base64'));
}
let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('OK ' + name); }
  catch (error) { failed++; process.exitCode = 1; console.error('FAIL ' + name + '\n' + (error.stack || error.message)); }
}

/**
 * Y do sprite na tela, em pixels não ampliados do mundo, relativo à câmera: é exatamente o
 * que `cameraTransform` + a âncora do entity produzem. `degrau` refaz a conta com a cota
 * quantizada no sprite E na câmera, como o jogo fazia antes.
 */
const TRACAR = (alvo, frames) => `(()=>{const g=qa.g;
  const sy=(x,y,h)=>(x+y)*32-h*64;
  // Os parênteses são o que separa um objeto literal de um bloco: sem eles o objeto
  // interpolado aqui embaixo vira um "SyntaxError: Unexpected token ':'" na página.
  const onde=()=>(${alvo});
  qa.trace=[];
  const tick=()=>{const c=g.camera,p=onde();if(!p)return;
    const z=c.zoom;
    qa.trace.push({suave:(sy(p.x,p.y,p.hSuave)-sy(c.x,c.y,c.h))*z,
      degrau:(sy(p.x,p.y,p.hTile)-sy(c.x,c.y,g.map.heightAt(c.x,c.y)))*z,
      x:p.x,y:p.y,t:g.time,vel:p.vel===undefined?null:p.vel});
    if(qa.trace.length<${frames})requestAnimationFrame(tick);};
  requestAnimationFrame(tick)})()`;

/** Maior salto de um quadro para o outro na série. */
const salto = (serie) => serie.reduce((pior, v, i) => (i ? Math.max(pior, Math.abs(v - serie[i - 1])) : pior), 0);

/** Caminho percorrido, quadro a quadro: soma de cada empurrãozinho, não o deslocamento final. */
const caminho = (serie) => serie.reduce((soma, p, i) => (i ? soma + Math.hypot(p[0] - serie[i - 1][0], p[1] - serie[i - 1][1]) : 0), 0);

(async () => {
  const pages = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = pages.find(p => p.type === 'page');
  assert.ok(page, `nenhum alvo CDP na porta ${PORT}`);
  socket = new WebSocket(page.webSocketDebuggerUrl);
  socket.onmessage = ({ data }) => {
    const m = JSON.parse(data);
    if (m.id) { const p = pending.get(m.id); if (!p) return; pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errors.push(m.params.entry.text);
  };
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = () => reject(new Error('CDP falhou')); });
  await send('Runtime.enable'); await send('Page.enable'); await send('Log.enable');
  await require('./bundle-identity.cjs').attach(socket, send);

  await send('Page.navigate', { url: 'about:blank' });
  await send('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 1, mobile: true });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await send('Page.navigate', { url: 'http://localhost:8082/?relief-qa=1' });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await until(`!!document.querySelector('[data-testid="menu-new"],[data-testid="menu-play"]')
    ||!!document.body?.innerText.match(/JOGAR|NOVO JOGO/)`, 'menu', 180000);
  await delay(600);
  const botao = await evaluate(`(()=>{const b=document.querySelector('[data-testid="menu-new"]')
    ||document.querySelector('[data-testid="menu-play"]');
    if(!b)return null;const r=b.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  assert.ok(botao, 'nenhum botão de jogar no menu');
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...botao, id: 1 }] });
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await until('document.body.innerText.includes("HP 100")', 'HUD', 60000);
  await evaluate(`(()=>{const m=[...__r.getModules().values()].filter(m=>m.isInitialized).map(m=>m.publicModule.exports);
    // createVehicle e VEHICLE_DEFS moram em módulos diferentes: um único find com os
    // dois nunca casa, e o carro não nasce.
    globalThis.qa={g:m.find(m=>m?.getGame).getGame(),input:m.find(m=>m?.inputState).inputState,
      criar:m.find(m=>m?.createVehicle&&m?.vehicleSpriteKey),defs:m.find(m=>m?.VEHICLE_DEFS).VEHICLE_DEFS,
      cfg:m.find(m=>m?.GAME_CONFIG).GAME_CONFIG};
    qa.g.player.invulnUntil=Infinity;qa.g.dayNight.t=.5;qa.g.weather.checkTimer=1e9;
    qa.g.hazard.cooldown=1e9;})()`);
  // O teto de velocidade vem do jogo, não de um número copiado aqui: se o config mudar, a
  // régua da rampa muda junto.
  const MAX_SPEED = await evaluate('qa.cfg.VEHICLE_MAX_SPEED');
  assert.ok(MAX_SPEED > 0, 'o GameConfig não expôs VEHICLE_MAX_SPEED');

  // A encosta mais íngreme por onde se pode andar, e por onde se pode rodar: é nelas que
  // qualquer degrau aparece primeiro. Andar e rodar têm tetos diferentes, então cada uma
  // tem sua trilha.
  await test('a serra tem por onde andar e por onde rodar', async () => {
    const spots = await evaluate(`(()=>{const g=qa.g,d=g.map.data,W=d.tilesW,H=d.tilesH;
      const livre=(x,y)=>{const t=d.tiles[y*W+x];return t&&['grass','dirt','sand','concrete'].includes(t.kind)
        &&!d.buildings.some(b=>Math.hypot(b.x-(x+.5),b.y-(y+.5))<3.2);};
      const achar=(pode)=>{let best=null;
        for(let y=1;y<H-1;y++)for(let x=1;x<W-3;x++){
          const delta=Math.abs(d.heights[y*W+x+1]-d.heights[y*W+x]);
          if(delta<0.18)continue;
          if(!livre(x,y)||!livre(x+1,y)||!livre(x-1,y)||!livre(x-2,y))continue;
          if(!pode(x,y))continue;
          if(!best||delta>best.delta)best={x,y,delta};
        }return best};
      const a=achar((x,y)=>g.map.canClimb(x+.5,y+.5,x+1.5,y+.5));
      const b=achar((x,y)=>g.map.canDriveOver(x+.5,y+.5,x+1.5,y+.5));
      qa.spots={a,b};return{a:a&&+a.delta.toFixed(3),b:b&&+b.delta.toFixed(3)}})()`);
    assert.ok(spots.a, 'o gerador não deixou nenhuma encosta íngreme e pisável no mapa');
    assert.ok(spots.b, 'o gerador não deixou nenhuma encosta íngreme e rodável no mapa');
  });

  /** Põe o player dois tiles antes da crista, olhando para +x, com a câmera já colada nele. */
  async function subir(onde) {
    await evaluate(`(()=>{const g=qa.g,s=qa.spots.${onde};
      const x=s.x-1.5,y=s.y+.5;
      g.player.x=x;g.player.y=y;g.camera.x=x;g.camera.y=y;g.camera.h=g.map.heightSmoothAt(x,y);
      g.player.vx=g.player.vy=0;g.player.speed=0;g.player.state='idle';
      g.player.currentVehicleId=null;g.notifyEntityChange()})()`);
    await delay(400);
  }

  await test('a pé a tela desliza morro acima, sem degrau de tile', async () => {
    await subir('a');
    // +x do mundo é (0.894, 0.447) na tela: é o vetor que o joystick produziria para lá.
    await evaluate(`(()=>{const i=qa.input;i.dx=0.894;i.dy=0.447;i.magnitude=1})()`);
    await evaluate(TRACAR(`{x:g.player.x,y:g.player.y,
      hSuave:g.map.heightSmoothAt(g.player.x,g.player.y),hTile:g.map.heightAt(g.player.x,g.player.y)}`, 260));
    await until('qa.trace.length>=260', 'traçado a pé', 30000);
    await evaluate('qa.input.magnitude=0;qa.input.dx=0;qa.input.dy=0');
    const t = await evaluate('qa.trace.map(f=>[f.suave,f.degrau,f.t,f.x,f.y])');
    const suave = t.map(r => r[0]), degrau = t.map(r => r[1]);
    const andou = Math.hypot(t[t.length - 1][3] - t[0][3], t[t.length - 1][4] - t[0][4]);
    const percorrido = caminho(t.map(r => [r[3], r[4]]));
    assert.ok(andou > 2, `o player não andou (${andou.toFixed(2)} tiles): a trilha não mede nada`);
    assert.ok(t[t.length - 1][2] > t[0][2], 'o tempo do jogo congelou durante a trilha');
    const pSuave = salto(suave), pDegrau = salto(degrau);
    console.log(`   a pé: salto suave ${pSuave.toFixed(2)}px, salto do tile ${pDegrau.toFixed(2)}px`);
    console.log(`   a pé: ${andou.toFixed(2)} tiles de deslocamento para ${percorrido.toFixed(2)} tiles de caminho`);
    assert.ok(pSuave <= 3, `a cota visual saltou ${pSuave.toFixed(2)}px num quadro`);
    assert.ok(pDegrau > pSuave * 1.5,
      `a leitura quantizada só saltou ${pDegrau.toFixed(2)}px contra ${pSuave.toFixed(2)}px: sem serra para medir`);
    // "Sobe e desce no mesmo lugar" é isto: cada quadro gasta um passo e devolve um passo.
    assert.ok(percorrido <= andou * 1.5,
      `o passo foi devolvido ${((percorrido / andou - 1) * 100).toFixed(0)}% das vezes: alguém pisca no lugar`);
    await screenshot('qa-relief-a-pe');
  });

  await test('ao volante o carro desliza na rampa em vez de piscar', async () => {
    await subir('b');
    const id = await evaluate(`(()=>{const g=qa.g,s=qa.spots.b;
      const v=qa.criar.createVehicle(g.nextVehicleId++,qa.defs.sedan,'red',s.x-1.5,s.y+.5,'SE');
      g.vehicles.push(v);g.vehicleSystem.enterVehicle(g.player,v);g.notifyEntityChange();return v.id})()`);
    await delay(500);
    await evaluate('qa.input.vehicleAccel=true');
    await evaluate(TRACAR(`(()=>{const v=qa.g.vehicles.find(v=>v.id===${id});if(!v)return null;
      return{x:v.x,y:v.y,vel:v.speed,
        hSuave:qa.g.map.heightSmoothAt(v.x,v.y),hTile:qa.g.map.heightAt(v.x,v.y)}})()`, 260));
    await until('qa.trace.length>=260', 'traçado ao volante', 30000);
    await evaluate('qa.input.vehicleAccel=false');
    const t = await evaluate('qa.trace.map(f=>[f.suave,f.degrau,f.t,f.x,f.y,f.vel])');
    const suave = t.map(r => r[0]), degrau = t.map(r => r[1]);
    const rodou = Math.hypot(t[t.length - 1][3] - t[0][3], t[t.length - 1][4] - t[0][4]);
    const percorrido = caminho(t.map(r => [r[3], r[4]]));
    assert.ok(rodou > 3, `o carro não rodou (${rodou.toFixed(2)} tiles): a trilha não mede nada`);
    const pSuave = salto(suave), pDegrau = salto(degrau);
    console.log(`   ao volante: salto suave ${pSuave.toFixed(2)}px, salto do tile ${pDegrau.toFixed(2)}px`);
    console.log(`   ao volante: ${rodou.toFixed(2)} tiles de deslocamento para ${percorrido.toFixed(2)} tiles de caminho`);
    assert.ok(pSuave <= 3, `o sprite do carro saltou ${pSuave.toFixed(2)}px num quadro`);
    assert.ok(pDegrau > pSuave * 1.5,
      `a leitura quantizada só saltou ${pDegrau.toFixed(2)}px contra ${pSuave.toFixed(2)}px: sem rampa para medir`);
    assert.ok(percorrido <= rodou * 1.5,
      `o carro andou ${percorrido.toFixed(2)} tiles para chegar ${rodou.toFixed(2)} tiles adiante: a roda é devolvida`);
    // A subida tem peso, não cachopa: depois de 1 tile de rampa o motor ainda empurra, e a
    // velocidade não denteia de um quadro para o outro.
    const vel = t.map(r => r[5]).filter((v) => v !== null);
    const naRampa = vel.slice(t.findIndex(r => r[3] - t[0][3] > 1));
    assert.ok(naRampa.length > 20, 'o carro nunca chegou à rampa: não há subida amostrada');
    const minima = Math.min(...naRampa);
    console.log(`   ao volante: velocidade mínima na rampa ${minima.toFixed(2)} / ${MAX_SPEED} tiles por segundo`);
    assert.ok(minima > MAX_SPEED * 0.55,
      `na rampa o carro caiu para ${minima.toFixed(2)} tiles/s (teto ${MAX_SPEED}): é ré no morro, não subida`);
    const saltoVel = salto(naRampa);
    assert.ok(saltoVel <= 0.25, `a velocidade pulou ${saltoVel.toFixed(2)} tiles/s num quadro: o motor engasga`);
    await screenshot('qa-relief-carro');
    await evaluate(`(()=>{const g=qa.g;g.vehicleSystem.exitVehicle(g.player,g.vehicles.find(v=>v.id===${id}),g.map,g.collision);
      g.vehicles.splice(g.vehicles.findIndex(v=>v.id===${id}),1);g.notifyEntityChange()})()`);
  });

  await test('a câmera segue o chão sem solavanco e encosta na cota certa', async () => {
    await subir('a');
    const h = await evaluate(`(()=>{const g=qa.g;qa.cam=[];
      const tick=()=>{qa.cam.push({h:g.camera.h,alvo:g.map.heightSmoothAt(g.camera.x,g.camera.y)});
        if(qa.cam.length<120)requestAnimationFrame(tick)};
      const i=qa.input;i.dx=0.894;i.dy=0.447;i.magnitude=1;requestAnimationFrame(tick)})()`);
    await until('qa.cam.length>=120', 'traçado da câmera', 20000);
    await evaluate('qa.input.magnitude=0;qa.input.dx=0;qa.input.dy=0');
    const serie = await evaluate('qa.cam.map(c=>c.h)');
    const alvo = await evaluate('qa.cam.map(c=>c.alvo)');
    // A cota da câmera é em tiles; na tela ela vale `ELEVATION_PX` por tile.
    const pxPorQuadro = salto(serie) * 64;
    const atraso = Math.max(...serie.map((v, i) => Math.abs(alvo[i] - v)));
    console.log(`   câmera: ${pxPorQuadro.toFixed(2)}px por quadro, ${atraso.toFixed(2)} tiles de atraso máximo`);
    assert.ok(pxPorQuadro <= 4, `a cota da câmera saltou ${pxPorQuadro.toFixed(2)}px por quadro`);
    // O alívio exponencial persegue o chão sem nunca se atrasar uma encosta inteira.
    assert.ok(atraso < 1.2, `a câmera chegou a ${atraso.toFixed(2)} tiles do chão que ela mira`);
  });

  assert.deepEqual(errors, [], 'a página registrou erros durante as trilhas');
  console.log(`Relief smooth browser checks: ${passed} passed, ${failed} failed.`);
  await send('Emulation.setTouchEmulationEnabled', { enabled: false });
  socket.close();
  process.exit(failed ? 1 : 0);
})();
