// Run: node tools/check/check-carjack-browser.cjs
// Precisa do Expo web em :8082 e de um Chrome com --remote-debugging-port (QA_CDP_PORT, padrão 9223).
// Prova no jogo real: todo carro de trânsito tem motorista, assaltar expulsa quem dirige,
// viatura e SWAT são dirigíveis com a guarnição descendo na rua, e carro em curso machuca.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.QA_CDP_PORT || 9223);

let socket, serial = 0;
const pending = new Map(), errors = [];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Uma volta no CDP que nunca responde prendia o script inteiro: toda chamada tem prazo.
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
    // Durante uma navegação o contexto morre no meio da checagem: conta como ainda não pronto.
    try { if (await evaluate(expression)) return true; } catch { /* página trocando */ }
    await delay(60);
  }
  return false;
}
const key = (type, code, value, windowsVirtualKeyCode) => send('Input.dispatchKeyEvent', { type, code, key: value, windowsVirtualKeyCode });
async function tap(code, value, number) { await key('keyDown', code, value, number); await delay(45); await key('keyUp', code, value, number); }
/**
 * O E batido dentro do cooldown de saída (0,45 s) é engolido pelo GameState, e a viatura
 * anda enquanto o harness olha: toda entrada recoloca o jogador na porta e bate de novo.
 */
async function board(finder, idExpr) {
  await until('qa.g.exitLock<=0', 'cooldown de saída do carro', 3000);
  for (let i = 0; i < 8; i++) {
    if (!await evaluate(finder)) { await delay(200); continue; }
    await tap('KeyE', 'e', 69);
    if (await until(`qa.g.player.currentVehicleId===${idExpr}`, 'embarque', 1500)) return true;
    await delay(120);
  }
  return false;
}
async function screenshot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.resolve(__dirname, '../tmp/' + name + '.png'), Buffer.from(data, 'base64'));
}
async function launch() {
  await send('Page.navigate', { url: 'about:blank' });
  await send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 600, deviceScaleFactor: 1, mobile: false });
  await send('Emulation.setTouchEmulationEnabled', { enabled: false, maxTouchPoints: 5 });
  await send('Page.navigate', { url: 'http://localhost:8082/?carjack-qa=1' });
  // Bundle web com perfil de browser novo leva mais de um minuto; sem margem aqui o teste
  // reclama do menu antes de o Metro terminar de servir o bundle.
  if (!await until('!!document.body?.innerText.match(/JOGAR|NOVO JOGO/)', 'menu', 180000)) {
    throw new Error('o menu não abriu: ' + JSON.stringify(await evaluate('document.body?.innerText.slice(0,160)')));
  }
  const p = await evaluate(`(()=>{const e=[...document.querySelectorAll('div')].find(e=>e.childElementCount===0&&(e.textContent==='JOGAR'||e.textContent==='NOVO JOGO'));const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...p, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...p, button: 'left', clickCount: 1 });
  if (!await until('document.body.innerText.includes("HP 100")', 'HUD', 60000)) {
    throw new Error('a cidade não abriu o HUD: ' + JSON.stringify(await evaluate('document.body?.innerText.slice(0,160)')));
  }
  await evaluate(`(()=>{const m=[...__r.getModules().values()].filter(m=>m.isInitialized).map(m=>m.publicModule.exports);
    globalThis.qa={g:m.find(m=>m?.getGame).getGame(),input:m.find(m=>m?.inputState).inputState,
      getState:m.find(m=>m?.useGameStore)?.useGameStore.getState,ins:m.find(m=>m?.resetInputState)};
    qa.g.player.invulnUntil=Infinity;qa.g.weather.intensity=0;qa.g.weather.target=0;qa.g.dayNight.t=.5;})()`);
}

(async () => {
  const pages = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  socket = new WebSocket(pages.find((p) => p.type === 'page').webSocketDebuggerUrl);
  socket.onmessage = ({ data }) => {
    const m = JSON.parse(data);
    if (m.id) { const p = pending.get(m.id); if (!p) return; pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
    else if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  };
  // Um alvo velho travado no renderer nunca abre o socket: sem prazo aqui o script congela.
  await Promise.race([
    new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; }),
    delay(20000).then(() => { throw new Error(`sem alvo CDP na porta ${PORT}`); }),
  ]);
  await send('Page.enable');
  await send('Page.navigate', { url: 'about:blank' });
  await send('Runtime.enable');
  await until('location.href==="about:blank"', 'clean context');
  errors.length = 0;
  await launch();

  // 1) Trânsito é carro dirigido: nenhuma ativação sem pedestre ao volante.
  assert.ok(await until(`(()=>{const t=qa.g.trafficSystem.traffic;
    return t.length>4&&t.every(tv=>tv.driver&&tv.driver.inVehicle&&tv.driver.vehicleId===tv.vehicle.id&&tv.vehicle.occupied)})()`,
    'trânsito com motorista', 30000), 'carro de trânsito sem motorista NPC');
  await screenshot('qa-carjack-traffic');
  const fleet = await evaluate('(()=>({cars:qa.g.trafficSystem.traffic.length,inCars:qa.g.npcs.filter(n=>n.inVehicle).length}))()');
  assert.ok(fleet.inCars >= fleet.cars, JSON.stringify(fleet));
  console.log(`OK ${fleet.cars} carros de trânsito têm motorista NPC (${fleet.inCars} NPCs ao volante)`);

  // 2) Assaltar um carro em movimento bota o motorista na calçada.
  assert.ok(await evaluate(`(()=>{const g=qa.g,tv=g.trafficSystem.traffic.find(tv=>tv.state==='driving'&&tv.driver&&!tv.driver.dead&&Math.abs(tv.vehicle.speed)>.2);
    if(!tv)return false;qa.victim=tv.driver;qa.stolen=tv.vehicle;qa.from={x:tv.vehicle.x,y:tv.vehicle.y};
    tv.vehicle.speed=0;g.player.x=tv.vehicle.x+Math.cos(tv.vehicle.facingAngle+Math.PI/2)*1.1;
    g.player.y=tv.vehicle.y+Math.sin(tv.vehicle.facingAngle+Math.PI/2)*1.1;g.player.crouching=false;
    qa.moneyBefore=g.player.money;g.camera.x=g.player.x;g.camera.y=g.player.y;g.notifyEntityChange();return true})()`), 'nenhum carro de trânsito em movimento');
  await delay(150);
  await tap('KeyE', 'e', 69);
  assert.ok(await until('qa.g.player.currentVehicleId===qa.stolen.id', 'assalto', 12000), 'não assaltou o carro do trânsito');
  assert.ok(await until('qa.victim.inVehicle===false&&qa.victim.state==="fleeing"', 'motorista expulso', 6000), 'o motorista ficou no carro');
  assert.equal(await evaluate('qa.victim.vehicleId'), null);
  assert.equal(await evaluate('qa.victim.dead'), false);
  assert.ok(await evaluate('Math.hypot(qa.victim.x-qa.stolen.x,qa.victim.y-qa.stolen.y)>.4'), 'o motorista ficou dentro do carro');
  assert.ok(await evaluate('qa.g.player.wantedLevel>=1'), 'assalto não sobe a estrela');
  // A carteira do motorista cai aos pés de quem assaltou, e o pickups colhe no mesmo tick:
  // o que prova o derrame é o dinheiro subindo na mão do jogador, não o saco no chão.
  assert.ok(await until('qa.g.player.money>=qa.moneyBefore+40', 'dinheiro do assalto', 5000), 'o assalto não derrubou dinheiro');
  assert.ok(await until('qa.g.trafficSystem.traffic.every(tv=>tv.vehicle!==qa.stolen)', 'sair do trânsito', 6000), 'o carro roubado segue no trânsito');
  await screenshot('qa-carjack-steal');
  console.log('OK E em um carro em movimento expulsa o motorista, rouba o veículo e sobe o procurado');

  // 3) Viatura e SWAT são dirigíveis; a guarnição desce na rua quando o player assume.
  await evaluate('qa.ins.resetInputState();qa.g.player.invulnUntil=Infinity');
  await tap('KeyE', 'e', 69);
  assert.ok(await until('qa.g.player.currentVehicleId===null', 'sair do carro roubado', 8000), 'não saiu do carro roubado');
  for (const [baseKey, tag] of [['veh_police', 'patrulha'], ['veh_police_compact', 'compacta'], ['veh_swat', 'swat']]) {
    await evaluate('qa.g.wanted.clear(qa.g.player);qa.g.police.reset();qa.g.player.invulnUntil=Infinity');
    // Depois de uma perseguição a guarnição está a pé e volta para o carro no próprio tempo.
    // O vão tem de ser maior que o alcance de entrada: com outro carro por perto o E é dele,
    // não da viatura, e a checagem viria uma troca de carro qualquer por "viatura não dirigível".
    const finder = `(()=>{const g=qa.g,u=g.police.units.find(u=>{const v=g.vehicles.find(v=>v.id===u.vehicleId);
      return v&&v.def.baseKey===${JSON.stringify(baseKey)}&&v.state!=='destroyed'&&v.altitude<=0.5&&
      u.crew.some(id=>{const n=g.npcs.find(n=>n.id===id);return n&&!n.dead&&n.inVehicle})});
      if(!u)return 0;const car=g.vehicles.find(v=>v.id===u.vehicleId);
      // Viatura de patrulha não espera visitante: encosta o jogador a 0,85 tile do flanco,
      // bem dentro do alcance de entrada, e zera o impulso deste quadro.
      const px=car.x+Math.cos(car.facingAngle+Math.PI/2)*0.85,py=car.y+Math.sin(car.facingAngle+Math.PI/2)*0.85;
      if(g.vehicles.some(o=>o.id!==car.id&&o.altitude<=0.5&&o.state!=='destroyed'&&Math.hypot(o.x-px,o.y-py)<1.7))return 0;
      car.speed=0;
      qa.unit=u;qa.car=car;
      qa.crew=u.crew.map(id=>g.npcs.find(n=>n.id===id)).filter(n=>n&&!n.dead);
      qa.armedBefore=qa.crew.filter(n=>n.inVehicle).length;
      g.player.x=px;g.player.y=py;
      g.player.crouching=false;g.camera.x=px;g.camera.y=py;g.notifyEntityChange();return qa.armedBefore})()`;
    if (!await until(finder, baseKey + ' guarnição embarcada', 45000)) { console.log(`(nenhuma ${baseKey} tripulada no momento)`); continue; }
    const armed = await evaluate(finder);
    assert.ok(await board(finder, 'qa.car.id'), baseKey + ' não é dirigível');
    assert.ok(await until('qa.crew.some(n=>!n.inVehicle)', baseKey + ' guarnição expulsa', 12000), baseKey + ' reteve a guarnição');
    assert.ok(await evaluate('qa.g.player.wantedLevel>=2'), baseKey + ' roubar viatura não pune dobrado');
    assert.ok(await evaluate('Math.hypot(qa.car.x-qa.g.player.x,qa.car.y-qa.g.player.y)<1.6'), baseKey + ' player fora do volante');
    await delay(250);
    await screenshot('qa-carjack-' + tag);
    await tap('KeyE', 'e', 69);
    assert.ok(await until('qa.g.player.currentVehicleId===null', baseKey + ' saída', 8000), baseKey + ' não devolveu o carro');
    console.log(`OK ${baseKey} é dirigível e a guarnição (${armed}) desce para a rua`);
  }

  // 4) Carro em curso atropela pedestre: nocaute ou morte, corpo para fora da pista e dinheiro.
  await evaluate('qa.g.wanted.clear(qa.g.player);qa.g.police.reset();qa.g.player.invulnUntil=Infinity');
  const hatch = `(()=>{const g=qa.g,v=g.vehicles.find(v=>v.def.baseKey==='veh_hatchback'&&v.state==='parked'&&!v.occupied&&v.altitude<=0.5&&
    !g.vehicles.some(o=>o!==v&&o.altitude<=0.5&&Math.hypot(o.x-v.x,o.y-v.y)<3))||g.vehicles.find(v=>v.def.baseKey==='veh_hatchback'&&v.altitude<=0.5);
    if(!v)return false;qa.car=v;g.player.x=v.x+Math.cos(v.facingAngle+Math.PI/2)*1.2;g.player.y=v.y+Math.sin(v.facingAngle+Math.PI/2)*1.2;
    g.player.crouching=false;g.camera.x=g.player.x;g.camera.y=g.player.y;g.notifyEntityChange();return true})()`;
  assert.ok(await until(hatch, 'hatchback no mundo', 20000), 'nenhum hatchback no mundo');
  assert.ok(await board(hatch, 'qa.car.id'), 'não entrou no hatchback');
  await key('keyDown', 'ArrowUp', 'ArrowUp', 38);
  // Uma só colocação não é prova: o carro pode estar virando, batido ou ainda acelerando.
  // Cada tentativa planta um pedestre novo na frente da pista e dá tempo de ele ser atingido.
  let rammed = false;
  for (let attempt = 0; attempt < 16 && !rammed; attempt++) {
    const staged = await evaluate(`(()=>{const g=qa.g,v=qa.car;if(Math.abs(v.speed)<1.6)return false;
      const D={SE:[1,0],SW:[0,1],NE:[0,-1],NW:[-1,0]}[v.dir];const p={x:v.x+D[0]*3.2,y:v.y+D[1]*3.2};
      if(g.map.isWaterWorld(p.x,p.y)||g.collision.overlapsAny({...p,radius:.25},g.map.queryNearby(p.x,p.y,1)))return false;
      const n=g.npcs.find(n=>n.kind==='civ'&&!n.dead&&!n.inVehicle&&Math.hypot(n.x-v.x,n.y-v.y)<10);if(!n)return false;
      qa.victim=n;qa.victimFrom={x:p.x,y:p.y};qa.ramMoney=g.player.money;n.x=p.x;n.y=p.y;n.lastX=p.x;n.lastY=p.y;n.state='idle';n.inVehicle=false;
      g.camera.x=v.x;g.camera.y=v.y;g.notifyEntityChange();return true})()`);
    if (staged) rammed = await until('qa.victim.dead||qa.victim.state==="knocked"', 'atropelamento do pedestre', 2200);
    else await delay(120);
  }
  assert.ok(rammed, 'o pedestre atravessou o carro');
  await key('keyUp', 'ArrowUp', 'ArrowUp', 38);
  assert.ok(await evaluate('Math.hypot(qa.victim.x-qa.victimFrom.x,qa.victim.y-qa.victimFrom.y)>.3'), 'o corpo não voou para fora da pista');
  assert.ok(await evaluate('qa.g.player.wantedLevel>=1'), 'atropelar não é crime');
  // O saco cai onde o corpo parou, mas o carro por cima dele colhe no mesmo tick: vale
  // qualquer um dos dois — o dinheiro no chão ou o dinheiro já no bolso de quem atropelou.
  assert.ok(await until('qa.g.pickups.items.some(p=>p.kind==="cash"&&p.active&&Math.hypot(p.x-qa.victimFrom.x,p.y-qa.victimFrom.y)<3)||qa.g.player.money>=qa.ramMoney+5',
    'dinheiro do atropelamento', 3000), 'o atropelamento não derrubou dinheiro');
  await screenshot('qa-carjack-runover');
  console.log(`OK o carro em curso atropelou o pedestre (${await evaluate('qa.victim.dead?"morto":"nocauteado"')})`);

  // 5) A pé é o jogador que apanha: o motorista NPC freia para pedestres, nunca para o player.
  await evaluate('qa.ins.resetInputState();qa.g.wanted.clear(qa.g.player);qa.g.police.reset();qa.g.player.invulnUntil=Infinity');
  await tap('KeyE', 'e', 69);
  assert.ok(await until('qa.g.player.currentVehicleId===null', 'sair do hatchback', 8000), 'não saiu do hatchback');
  let hit = false;
  for (let attempt = 0; attempt < 5 && !hit; attempt++) {
    assert.ok(await evaluate(`(()=>{const g=qa.g;g.player.invulnUntil=0;g.player.health=100;
      const tv=g.trafficSystem.traffic.find(tv=>tv.state==='driving'&&Math.abs(tv.vehicle.speed)>1.6&&
        Math.hypot(tv.vehicle.x-g.player.x,tv.vehicle.y-g.player.y)<45);
      if(!tv)return false;const v=tv.vehicle,D={SE:[1,0],SW:[0,1],NE:[0,-1],NW:[-1,0]}[v.dir];
      const p={x:v.x+D[0]*2.2,y:v.y+D[1]*2.2};
      if(g.map.isWaterWorld(p.x,p.y)||g.collision.overlapsAny({...p,radius:.25},g.map.queryNearby(p.x,p.y,1)))return false;
      qa.ai=v;qa.hp=100;g.player.x=p.x;g.player.y=p.y;g.player.crouching=false;
      g.camera.x=p.x;g.camera.y=p.y;g.notifyEntityChange();return true})()`), 'nenhum carro do trânsito em curso');
    hit = await until('qa.g.player.health<qa.hp', 'carro do NPC machuca o jogador a pé', 4000);
    if (!hit) await evaluate('qa.g.player.invulnUntil=Infinity');
  }
  assert.ok(hit, 'o jogador a pé sobreviveu a um carro em curso por cima dele');
  await evaluate('qa.g.player.invulnUntil=Infinity');
  await screenshot('qa-carjack-player-hit');
  console.log(`OK carro dirigido por NPC atropelou o jogador a pé (HP ${await evaluate('qa.g.player.health')})`);

  assert.ok(await evaluate('qa.g.paused=true;qa.ins.resetInputState(),document.body.innerText.length>0'));
  assert.deepEqual(errors, []);
  console.log('OK sem exceções de runtime');
  socket.close();
})().catch(async (error) => {
  console.error(error);
  try { await screenshot('qa-carjack-failure'); await evaluate('qa.g.paused=true;qa.ins.resetInputState()'); } catch {}
  socket?.close();
  process.exitCode = 1;
});
