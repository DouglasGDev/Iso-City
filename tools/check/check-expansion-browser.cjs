const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
let socket, serial = 0;
const requests = new Map(), errors = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++serial;
  requests.set(id, { resolve, reject });
  socket.send(JSON.stringify({ id, method, params }));
});
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}
async function until(expression, label, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await evaluate(expression)) return;
    await delay(80);
  }
  throw new Error('Timed out: ' + label);
}
async function screenshot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.resolve(__dirname, '../tmp/' + name + '.png'), Buffer.from(data, 'base64'));
}
const key = (type, code, key, windowsVirtualKeyCode, modifiers = 0) =>
  send('Input.dispatchKeyEvent', { type, code, key, windowsVirtualKeyCode, modifiers });
async function point(selector) {
  return evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw new Error('Missing control');const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
}
async function touch(selector) {
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...await point(selector), id: 1 }] });
  await delay(50);
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}
async function launch(mobile) {
  await send('Page.navigate', { url: 'about:blank' });
  await delay(100);
  await send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 600, deviceScaleFactor: 1, mobile });
  await send('Emulation.setTouchEmulationEnabled', mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
  await send('Page.navigate', { url: 'http://localhost:8082/?expansion-qa=' + Number(mobile) });
  // Navegar reaplica o override de toque que a aba guardou: reafirmar agora, senão a rodada
  // desktop herda o toque da rodada mobile e o jogo passa a descartar todo o teclado.
  await send('Emulation.setTouchEmulationEnabled', mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
  await until('!!document.body?.innerText.match(/JOGAR|NOVO JOGO/)', 'asset loading', 90000);
  const play = await evaluate(`(()=>{const e=[...document.querySelectorAll('div')].find(e=>e.childElementCount===0&&(e.textContent==='JOGAR'||e.textContent==='NOVO JOGO'));const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  if (mobile) {
    await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...play, id: 1 }] });
    await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } else {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...play, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...play, button: 'left', clickCount: 1 });
  }
  await until('!!document.querySelector("[data-testid=control-weapon]")', 'game loaded');
  await evaluate(`(()=>{const m=[...__r.getModules().values()].filter(m=>m.isInitialized).map(m=>m.publicModule.exports);globalThis.qa={g:m.find(m=>m?.getGame).getGame(),input:m.find(m=>m?.inputState),store:m.find(m=>m?.useGameStore).useGameStore};qa.g.weather.intensity=0;qa.g.dayNight.t=.5;qa.g.player.invulnUntil=Infinity;qa.g.player.money=1000;})()`);
  await delay(200);
}
(async () => {
  const pages = await (await fetch('http://127.0.0.1:9223/json/list')).json();
  socket = new WebSocket(pages.find(p => p.type === 'page').webSocketDebuggerUrl);
  socket.addEventListener('message', ({ data }) => {
    const m = JSON.parse(data);
    if (m.id) {
      const request = requests.get(m.id); if (!request) return;
      requests.delete(m.id);
      m.error ? request.reject(new Error(m.error.message)) : request.resolve(m.result);
    } else if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  });
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve); socket.addEventListener('error', reject); });
  await send('Page.enable'); await send('Runtime.enable');
  await launch(false);
  // O tamanho é lido do GAME_CONFIG do próprio bundle: crescer o mapa não exige
  // editar este teste, apenas que mundo e configuração continuem iguais.
  assert.deepEqual(await evaluate(`(()=>{const c=[...__r.getModules().values()].filter(m=>m.isInitialized).map(m=>m.publicModule.exports).find(m=>m?.GAME_CONFIG).GAME_CONFIG;return[qa.g.map.worldW,qa.g.map.worldH,c.MAP_TILES_W,c.MAP_TILES_H]})()`).then(([w,h,cw,ch])=>({world:[w,h],config:[cw,ch]})), { world: [240, 240], config: [240, 240] });
  await key('keyDown', 'Space', ' ', 32);
  await key('keyUp', 'Space', ' ', 32);
  await until('qa.g.player.jumpHeight>4', 'Space starts jump');
  assert.equal(await evaluate('qa.g.player.attackTimer'), 0);
  await screenshot('qa-expansion-jump');
  await until('qa.g.player.jumpHeight===0', 'jump lands');
  await key('keyDown', 'ControlLeft', 'Control', 17, 2);
  await until('qa.g.player.attackTimer>0', 'Ctrl attacks');
  await key('keyUp', 'ControlLeft', 'Control', 17);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 650, y: 260 });
  assert.equal(await evaluate('qa.input.inputState.aimActive'), false, 'hovering alone must not aim');
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 650, y: 260, button: 'right', clickCount: 1 });
  await until('qa.input.inputState.aimActive', 'the right mouse button aims');
  await screenshot('qa-expansion-aim');
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 650, y: 260, button: 'right', clickCount: 1 });
  console.log('OK keyboard: Space jumps without attacking, Ctrl attacks, right mouse button holds aim');

  await evaluate(`(()=>{
    qa.pad={index:0,connected:true,mapping:'standard',axes:[0,0,0,0],buttons:Array.from({length:17},()=>({pressed:false,value:0}))};
    Object.defineProperty(navigator,'getGamepads',{configurable:true,value:()=>[qa.pad]});
    qa.padStart={x:qa.g.player.x,y:qa.g.player.y};
  })()`);
  await delay(100);
  await evaluate('qa.pad.axes[2]=1');
  assert.equal(await evaluate('qa.input.inputState.aimActive'), false, 'right stick alone must not aim');
  await evaluate('qa.pad.buttons[6]={pressed:true,value:1}');
  await until('document.querySelector("[data-testid=hardware-hints]")?.textContent.includes("LT+RS mirar") && qa.input.inputState.aimActive', 'LT plus right stick aim');
  await delay(350);
  assert.ok(await evaluate('qa.g.camera.x-qa.g.player.x>.2 && qa.g.camera.y-qa.g.player.y<-.2'));
  assert.ok(await evaluate('Math.hypot(qa.g.player.x-qa.padStart.x,qa.g.player.y-qa.padStart.y)<.03'));
  await screenshot('qa-expansion-gamepad');
  await evaluate('qa.pad.axes[2]=0;qa.pad.buttons[6]={pressed:false,value:0};qa.pad.buttons[1]={pressed:true,value:1}');
  await until('qa.g.player.jumpHeight>0', 'gamepad B jump');
  await evaluate('qa.pad.buttons[1]={pressed:false,value:0}');
  await until('qa.g.player.jumpTimer===0', 'gamepad landing');
  await evaluate('delete navigator.getGamepads');
  await delay(100);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 650, y: 265 });
  console.log('OK standard gamepad LT+RS moves aim/camera independently; B jumps');

  await evaluate(`qa.input.resetInputState();qa.car=qa.g.vehicles.find(v=>v.state==='parked'&&v.def.type==='sedan');qa.g.player.x=qa.car.x;qa.g.player.y=qa.car.y;qa.g.camera.x=qa.car.x;qa.g.camera.y=qa.car.y;`);
  await delay(200);
  assert.ok(await evaluate('Math.hypot(qa.g.player.x-qa.car.x,qa.g.player.y-qa.car.y)>.35'));
  await screenshot('qa-expansion-car-collision');
  console.log('OK player cannot occupy a parked vehicle');

  await evaluate(`(()=>{qa.input.resetInputState();const b=qa.g.map.data.buildings.find(b=>b.tag==='office_tall'&&!qa.g.collision.overlapsAny({x:b.x-b.footprintW-.5,y:b.y-b.footprintW-.5,radius:.15},qa.g.map.queryNearby(b.x-b.footprintW-.5,b.y-b.footprintW-.5,1)));if(!b)throw new Error('No test building');qa.g.player.x=b.x-b.footprintW-.5;qa.g.player.y=b.y-b.footprintW-.5;qa.g.camera.x=qa.g.player.x;qa.g.camera.y=qa.g.player.y;})()`);
  await delay(400);
  await screenshot('qa-expansion-occlusion');
  console.log('OK localized building transparency scene captured');

  await evaluate(`(()=>{
    const g=qa.g,p=g.player;qa.input.resetInputState();g.jump.cancel(p);
    for(const c of g.map.staticColliders.filter(c=>c.type==='FENCE')) {
      const alongX=c.width<c.height;
      p.x=alongX?c.x-.25:c.x+c.width/2;p.y=alongX?c.y+c.height/2:c.y-.25;
      p.vx=p.vy=p.speed=0;p.facingAngle=alongX?0:Math.PI/2;
      if(g.jump.tryJump(p,g.map,g.collision)&&p.jumpEnd){
        qa.vaultEnd={...p.jumpEnd};qa.vaultStart={x:p.x,y:p.y};g.jump.cancel(p);
        g.camera.x=p.x;g.camera.y=p.y;return;
      }
      g.jump.cancel(p);
    }
    throw new Error('No clear generated garden fence');
  })()`);
  await key('keyDown', 'Space', ' ', 32);
  await key('keyUp', 'Space', ' ', 32);
  await until('qa.g.player.jumpEnd!==null && qa.g.player.jumpHeight>10', 'generated fence vault');
  await screenshot('qa-expansion-vault');
  await until('qa.g.player.jumpTimer===0', 'vault landing');
  assert.ok(await evaluate('Math.hypot(qa.g.player.x-qa.vaultEnd.x,qa.g.player.y-qa.vaultEnd.y)<.03'));
  console.log('OK generated house fence vault lands on clear opposite side');

  await evaluate(`(()=>{
    const g=qa.g,p=g.player;qa.input.resetInputState();
    const ws=[...__r.getModules().values()].filter(m=>m.isInitialized).map(m=>m.publicModule.exports).find(m=>m?.segmentAabb);
    // O disparo do teste é sempre ao longo de uma linha y constante, então o corredor
    // livre pode ser verificado sem reproduzir o hitscan inteiro.
    const clearCorridor=(start,a,dir)=>{
      const far=start.x+dir*20;
      const inLane=(e)=>Math.abs(e.y-a.y)<.7&&(e.x-start.x)*dir>-.5&&(e.x-far)*dir<0;
      if(g.map.queryNearby(a.x,a.y,24).some((c)=>ws.segmentAabb(start.x,start.y,far,a.y,c)!==null))return false;
      if(g.npcs.some((n)=>!n.inVehicle&&inLane(n)))return false;
      if(g.vehicles.some((v)=>v.altitude<=.5&&inLane(v)))return false;
      return true;
    };
    for(const a of g.wildlife.animals.filter(a=>a.species==='rabbit'&&!a.dead)){
      for(const dx of [-2,2]) {
        const start={x:a.x+dx,y:a.y};
        if(g.map.isWaterWorld(start.x,start.y)||g.collision.overlapsAny({...start,radius:.15},g.map.queryNearby(start.x,start.y,1)))continue;
        if(!clearCorridor(start,a,-Math.sign(dx)))continue;
        p.x=start.x;p.y=start.y;p.vx=p.vy=p.speed=0;p.facingAngle=dx<0?0:Math.PI;
        g.camera.x=p.x;g.camera.y=p.y;qa.animal=a;
        g.weapons.reset();g.weapons.acquire('pistol');g.weapons.equipped='pistol';g.paused=true;
        // A fauna agora foge pela cidade inteira; o teste congela a simulação de vida
        // selvagem para disparar contra um alvo imóvel e depois a devolve normalmente.
        qa.wildlifeUpdate=g.wildlife.update.bind(g.wildlife);
        g.wildlife.update=()=>{};
        return;
      }
    }
    throw new Error('No clear wildlife target');
  })()`);
  await delay(180);
  await screenshot('qa-expansion-wildlife');
  await evaluate('qa.g.paused=false');
  for (let shot = 0; shot < 5 && !(await evaluate('qa.animal.dead')); shot++) {
    const target = await evaluate(`(()=>{const g=qa.g,a=qa.animal;return{x:g.viewW/2+(a.x-a.y-g.camera.x+g.camera.y)*64*g.camera.zoom,y:g.viewH/2+(a.x+a.y-g.camera.x-g.camera.y)*32*g.camera.zoom}})()`);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...target });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...target, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...target, button: 'left', clickCount: 1 });
    await delay(360);
  }
  await until('qa.animal.dead', 'mouse shot kills wildlife');
  await evaluate('qa.g.wildlife.update=qa.wildlifeUpdate');
  await delay(300);
  await screenshot('qa-expansion-animal-death');
  assert.ok(await evaluate('qa.animal.deathTimer>=0 && qa.animal.deathTimer<3'));
  console.log('OK forest wildlife can be hunted by mouse and animates death');

  await evaluate(`(()=>{const n=qa.g.npcs.find(n=>n.kind==='civ'&&!n.inVehicle&&!n.dead);n.x=qa.g.player.x+.3;n.y=qa.g.player.y+.1;n.dead=true;n.health=0;n.state='dead';qa.corpse=n;qa.g.notifyEntityChange()})()`);
  await delay(450);
  assert.ok(await evaluate('qa.corpse.dead && qa.corpse.deathTimer>=0 && qa.corpse.deathTimer<2'));
  await screenshot('qa-expansion-death');
  console.log('OK NPC death advances instead of disappearing immediately');

  await evaluate(`qa.g.player.health=0`);
  await until('qa.g.player.state==="dead"', 'player death animation');
  assert.equal(await evaluate('qa.store.getState().overlay'), null);
  await screenshot('qa-expansion-player-death');
  await until('qa.store.getState().overlay!==null', 'delayed death overlay');
  assert.equal(await evaluate('qa.g.player.health'), 100);
  console.log('OK player death animates before respawn');

  await launch(true);
  assert.ok(await evaluate('!!document.querySelector("[data-testid=control-jump]")'));
  await touch('[data-testid=control-jump]');
  await until('qa.g.player.jumpHeight>0', 'touch jump');
  await screenshot('qa-expansion-touch');
  await until('qa.g.player.jumpHeight===0', 'touch landing');
  assert.equal(await evaluate('!!document.querySelector("[data-testid=hardware-hints]")'), false);
  console.log('OK mobile jump button and touch-only layout');
  await send('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 1, mobile: true });
  await delay(250);
  assert.ok(await evaluate(`['jump','attack','run','weapon','reload'].every(id=>{const e=document.querySelector('[data-testid="control-'+id+'"]');if(!e)return false;const r=e.getBoundingClientRect();return r.width>0&&r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight})`));
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 120, y: 270, id: 1 }] });
  await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 150, y: 270, id: 1 }] });
  await until('qa.input.inputState.magnitude>.2', 'compact touch joystick');
  const jumpPoint = await point('[data-testid=control-jump]');
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 150, y: 270, id: 1 }, { ...jumpPoint, id: 2 }] });
  await until('qa.g.player.jumpHeight>5 && qa.input.inputState.magnitude>.2', 'simultaneous joystick and jump');
  await screenshot('qa-expansion-compact-touch');
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await until('qa.g.player.jumpTimer===0 && qa.input.inputState.magnitude===0', 'compact touch release');
  console.log('OK 844x390 controls fit; simultaneous joystick and jump preserve movement');
  assert.deepEqual(errors, []);
  await evaluate('qa.store.pause()');
  socket.close();
})().catch(async error => {
  console.error(error);
  try { await screenshot('qa-expansion-failure'); } catch {}
  socket?.close(); process.exitCode = 1;
});
