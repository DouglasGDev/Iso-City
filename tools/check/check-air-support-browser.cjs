// Run: node tools/check/check-air-support-browser.cjs
// Validação no navegador: apoio aéreo policial por estrela + helicóptero do player voando alto sem colidir.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
let socket, serial = 0;
const pending = new Map(), errors = [];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++serial; pending.set(id, { resolve, reject });
  socket.send(JSON.stringify({ id, method, params }));
});
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}
async function until(expression, label, timeout = 25000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await evaluate(expression)) return; await delay(80); }
  throw new Error('Timed out: ' + label);
}
async function hold(code, keyCode, ms) {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', code, key: code, windowsVirtualKeyCode: keyCode });
  await delay(ms);
  await send('Input.dispatchKeyEvent', { type: 'keyUp', code, key: code, windowsVirtualKeyCode: keyCode });
}
async function tap(code, keyCode) { await hold(code, keyCode, 45); }
async function screenshot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.resolve(__dirname, '../tmp/' + name + '.png'), Buffer.from(data, 'base64'));
}
let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('OK ' + name); }
  catch (error) { failed++; process.exitCode = 1; console.error('FAIL ' + name, error.message || error); }
}

(async () => {
  const pages = await (await fetch('http://127.0.0.1:9223/json/list')).json();
  socket = new WebSocket(pages.find((p) => p.type === 'page').webSocketDebuggerUrl);
  socket.onmessage = ({ data }) => {
    const m = JSON.parse(data);
    if (m.id) { const p = pending.get(m.id); if (!p) return; pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
    else if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  };
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url: 'about:blank' });
  await until('location.href==="about:blank"', 'clean context');
  await send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 600, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: 'http://localhost:8082/?air-support-qa=0' });
  // Navegar reaplica o override da aba: reafirmar, senão o desktop herda o toque e perde o teclado.
  await send('Emulation.setTouchEmulationEnabled', { enabled: false });
  await until('!!document.body?.innerText.match(/JOGAR|NOVO JOGO/)', 'menu', 90000);
  const p = await evaluate(`(()=>{const e=[...document.querySelectorAll('div')].find(e=>e.childElementCount===0&&(e.textContent==='JOGAR'||e.textContent==='NOVO JOGO'));const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...p, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...p, button: 'left', clickCount: 1 });
  await until('document.body.innerText.includes("HP 100")', 'HUD');
  // Os módulos do Metro podem estar parcialmente inicializados no boot (importações circulares),
  // então cada exportação é resolvida tarde, no momento em que o teste realmente usa.
  await evaluate(`(()=>{const modules=()=>[...__r.getModules().values()].filter(m=>m.isInitialized).map(m=>m.publicModule.exports);
    const pick=(t)=>modules().find(t);
    globalThis.qa={g:pick(x=>x?.getGame).getGame(),input:pick(x=>x?.inputState),pick};
    qa.cfg=()=>pick(x=>x?.GAME_CONFIG).GAME_CONFIG;
    qa.elevPx=()=>pick(x=>x?.ELEVATION_PX&&x?.worldToScreen).ELEVATION_PX;
    qa.defs=()=>pick(x=>x?.VEHICLE_DEFS).VEHICLE_DEFS;
    qa.newVehicle=()=>pick(x=>x?.createVehicle&&x?.vehicleSpriteKey);
    qa.heliImage=(v)=>{if(!v)return null;const s=pick(x=>x?.resolveEntityImage);return s?!!s.resolveEntityImage('veh:'+qa.g.vehicles.indexOf(v)):false};
    qa.g.player.invulnUntil=Infinity;qa.g.weather.intensity=0;qa.g.dayNight.t=.5;})()`);
  await evaluate(`(()=>{const g=qa.g,p=g.player;g.wanted.clear(p);g.police.reset();
    p.health=100;g.vehicles.length=0;})()`);

  await test('quatro estrelas fazem um helicóptero chegar e pairar alto', async () => {
    await evaluate(`(()=>{const g=qa.g;g.wanted.raise(g.player,4);g.police.report({x:g.player.x,y:g.player.y});})()`);
    await until('qa.g.police.air.helis.length>0', 'helicóptero spawn');
    await until('qa.g.police.air.helis[0]&&qa.g.police.air.helis[0].phase!=="inbound"', 'helicóptero em ronda', 40000);
    const state = await evaluate(`(()=>{const h=qa.g.police.air.helis[0],v=qa.g.vehicles.find(v=>v.id===h.vehicleId);
      return{alt:h.altitude,vehicleAlt:v&&v.altitude,occupied:v&&v.occupied,phase:h.phase,crafts:qa.g.police.air.helis.length,
      sprite:!!qa.heliImage(v),type:v&&v.def.type,cruise:qa.cfg().POLICE_HELI_ALTITUDE};})()`);
    assert.equal(state.crafts, 1); assert.equal(state.type, 'helicopter');
    assert.ok(state.alt > state.cruise * 0.9, `altitude ${state.alt} vs cruzeiro ${state.cruise}`);
    assert.ok(Math.abs(state.vehicleAlt - state.alt) < 0.02, 'a ficha do veículo acompanha o voo');
    assert.equal(state.occupied, true, 'o aparelho precisa continuar pilotado pelo sistema');
    assert.ok(state.sprite, 'o sprite do rotor deve existir na loja de imagens');
  });

  await test('a equipe desce de corda e fica a pé no mapa', async () => {
    await until('qa.g.police.cops.some(c=>c.vehicleId===-1)', 'policial de corda', 45000);
    const dropped = await evaluate(`(()=>{const cops=qa.g.police.cops.filter(c=>c.vehicleId===-1);
      return cops.map(c=>{const n=qa.g.npcs.find(n=>n.id===c.npcId);return n&&{kind:n.kind,vehicle:n.inVehicle,hp:n.health,armed:c.armed};});})()`);
    assert.ok(dropped.length > 0);
    for (const cop of dropped) {
      assert.equal(cop.kind, 'cop'); assert.equal(cop.vehicle, false);
      assert.ok(cop.hp > 0); assert.equal(cop.armed, true);
    }
  });

  await test('o aparelho aparece na tela lá de cima', async () => {
    // Congela a ronda no teto: sem isso a amostra pode cair no meio de um rapel.
    await evaluate(`(()=>{const h=qa.g.police.air.helis[0];h.deployTimer=9999;if(h.phase!=='outbound')h.phase='orbit';})()`);
    await until('qa.g.police.air.helis[0].altitude>1.8', 'helicóptero no teto de ronda', 20000);
    await evaluate(`(()=>{const h=qa.g.police.air.helis[0],p=qa.g.player;
      p.x=h.x;p.y=h.y;p.vx=p.vy=0;p.health=100;qa.g.camera.x=h.x;qa.g.camera.y=h.y;})()`);
    await delay(250);
    await screenshot('qa-air-heli');
    const shot = await evaluate(`(()=>{const h=qa.g.police.air.helis[0],v=qa.g.vehicles.find(v=>v.id===h.vehicleId);
      const c=[...document.querySelectorAll('canvas')].sort((a,b)=>b.width*b.height-a.width*a.height)[0];
      // A folga do voo é desenhada na mesma escala do relevo (ELEVATION_PX px por tile).
      return{w:c&&c.width,h:c&&c.height,px:qa.elevPx(),lift:v?v.altitude*qa.elevPx():0,alt:v&&v.altitude};})()`);
    assert.ok(shot.w > 400 && shot.h > 300, 'canvas de render presente');
    assert.ok(shot.alt > 1.7, `pairando acima dos prédios (${shot.alt})`);
    assert.equal(Math.round(shot.px), 64, 'um tile de ar tem que valer um tile de chão');
    assert.ok(shot.lift >= 100 && shot.lift <= 145, `elevação ${shot.lift}px legível numa tela de ${shot.h}px`);
    assert.ok(shot.h / 2 - shot.lift > 60, `o sprite fica a ${Math.round(shot.h / 2 - shot.lift)}px do topo, fora da HUD`);
  });

  await test('a caça acabar recolhe a aeronave e a equipe de corda', async () => {
    await evaluate('qa.g.wanted.clear(qa.g.player)');
    await until('!qa.g.police.air.helis.length', 'helicóptero recolhido', 20000);
    const left = await evaluate(`(()=>({crafts:qa.g.vehicles.filter(v=>v.def.type==="helicopter").length,
      airborne:qa.g.police.cops.filter(c=>c.vehicleId===-1).length,
      cops:qa.g.npcs.filter(n=>n.kind==="cop"&&!qa.g.police.cops.some(c=>c.npcId===n.id)).length}))()`);
    assert.deepEqual(left, { crafts: 0, airborne: 0, cops: 0 }, JSON.stringify(left));
  });

  await test('cinco estrelas mandam duas aeronaves', async () => {
    await evaluate(`(()=>{const g=qa.g;g.wanted.raise(g.player,5);g.police.report({x:g.player.x,y:g.player.y});})()`);
    await until('qa.g.police.air.helis.length===2', 'duas aeronaves', 20000);
    await evaluate('qa.g.wanted.clear(qa.g.player)');
    await until('!qa.g.police.air.helis.length', 'recolhida');
  });

  await test('o helicóptero do player sobe até a altura de cruzeiro', async () => {
    await evaluate(`(()=>{const g=qa.g,p=g.player;
      const v=qa.newVehicle().createVehicle(987654,qa.defs().helicopter,'red',p.x+0.9,p.y,'SE');
      g.vehicles.push(v);g.notifyEntityChange();qa.heliId=v.id;})()`);
    await until(`(()=>{const v=qa.g.vehicles.find(v=>v.id===987654);return v&&Math.hypot(v.x-qa.g.player.x,v.y-qa.g.player.y)<2;})()`, 'helicóptero ao alcance');
    await evaluate(`(()=>{const p=qa.g.player,v=qa.g.vehicles.find(v=>v.id===987654);p.x=v.x;p.y=v.y;})()`);
    await tap('KeyE', 69);
    await until('qa.g.player.currentVehicleId===qa.heliId', 'entrou no helicóptero');
    await hold('KeyW', 87, 2600);
    const air = await evaluate(`(()=>{const g=qa.g,v=g.vehicles.find(v=>v.id===qa.heliId);
      return{alt:v.altitude,elev:v.elevation,chao:g.map.heightSmoothAt(v.x,v.y),
        regra:g.map.heightAt(v.x,v.y),speed:v.speed,cruise:qa.cfg().HELI_CRUISE_ALTITUDE};})()`);
    assert.ok(Math.abs(air.alt - air.cruise) < 0.05, `folga ${air.alt} vs cruzeiro ${air.cruise}`);
    // A cota é o estado mandão; a folga é ela menos o chão que está DESENHADO embaixo da
    // máquina — a malha contínua, que é a superfície que o casco raspa.
    assert.ok(Math.abs(air.elev - (air.chao + air.alt)) < 1e-6,
      `cota ${air.elev} não bate com o chão ${air.chao} + folga ${air.alt}`);
    // E o cruzeiro persegue a cota da REGRA (o platô onde a máquina está), não a rampa
    // misturada à frente: se perseguisse a frente, a montanha içaria o helicóptero sozinha.
    assert.ok(Math.abs(air.elev - (air.regra + air.cruise)) < 0.05,
      `cota ${air.elev} não é o platô ${air.regra} + cruzeiro ${air.cruise}`);
    assert.ok(air.speed > 0.5, 'o aparelho anda quando se acelera');
    assert.equal(air.cruise > 1.25, true, 'tem que subir mais do que antes');
  });

  await test('atravessar prédio voando não colide nem estraga nada', async () => {
    // O losango no chão é o quadrado [b.x - footprintW, b.x]²: b.x é a âncora, não o canto inicial.
    const plan = await evaluate(`(()=>{const g=qa.g,v=g.vehicles.find(v=>v.id===qa.heliId);
      const b=g.map.data.buildings.filter(x=>x.footprintW>=3).sort((a,b)=>b.footprintW-a.footprintW
        ||Math.hypot(a.x-v.x,a.y-v.y)-Math.hypot(b.x-v.x,b.y-v.y))[0];
      if(!b)throw new Error('sem prédio largo no mapa');
      const c={x:b.x-b.footprintW/2,y:b.y-b.footprintW/2};
      v.x=c.x;v.y=c.y;v.speed=0;v.dir='SE';g.player.x=c.x;g.player.y=c.y;g.camera.x=c.x;g.camera.y=c.y;
      return{x:c.x,y:c.y,side:b.footprintW,water:g.map.isWaterWorld(c.x,c.y)};})()`);
    assert.equal(plan.water, false, 'o centro do prédio tem que ser seco');
    await delay(500);
    const settled = await evaluate(`(()=>{const g=qa.g,v=g.vehicles.find(v=>v.id===qa.heliId);
      const inside=(b)=>v.x>b.x-b.footprintW&&v.x<b.x&&v.y>b.y-b.footprintW&&v.y<b.y;
      return{inside:g.map.data.buildings.some(inside),alt:v.altitude,hp:v.health};})()`);
    assert.equal(settled.inside, true, 'nenhum sistema empurra o aparelho para fora do prédio');
    assert.ok(settled.alt > 1.7, `pairando sobre o telhado (${settled.alt})`);
    await hold('KeyW', 87, 1200);
    const after = await evaluate(`(()=>{const g=qa.g,v=g.vehicles.find(v=>v.id===qa.heliId);
      return{x:v.x,y:v.y,state:v.state,hp:v.health,playerHp:g.player.health,alt:v.altitude};})()`);
    assert.equal(after.state, 'driving'); assert.equal(after.hp, 100); assert.equal(after.playerHp, 100);
    assert.ok(after.alt > 1.7, `continua voando (${after.alt})`);
    assert.ok(Math.hypot(after.x - plan.x, after.y - plan.y) > 1, 'o voo continua andando sobre o telhado');
    await screenshot('qa-air-over-roof');
    await evaluate(`(()=>{const g=qa.g;g.player.currentVehicleId=null;const v=g.vehicles.find(v=>v.id===qa.heliId);
      v.occupied=false;v.state='parked';v.elevation=g.map.heightAt(v.x,v.y);v.altitude=0;
      g.wanted.clear(g.player);g.police.reset();})()`);
  });

  assert.deepEqual(errors, [], 'exceções de runtime: ' + errors.join(' | '));
  console.log(`Apoio aéreo no navegador: ${passed} passaram, ${failed} falharam`);
  if (failed) process.exitCode = 1;
  socket.close();
})().catch((error) => { console.error('ERRO', error); process.exit(1); });
