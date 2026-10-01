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
const key = (type, code, key, windowsVirtualKeyCode) => send('Input.dispatchKeyEvent', { type, code, key, windowsVirtualKeyCode });
async function tap(code, value, number) { await key('keyDown', code, value, number); await delay(45); await key('keyUp', code, value, number); }
async function screenshot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.resolve(__dirname, '../tmp/' + name + '.png'), Buffer.from(data, 'base64'));
}
async function point(selector) {
  return evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw new Error('Missing '+${JSON.stringify(selector)});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
}
async function touch(selector) {
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...await point(selector), id: 1 }] });
  await delay(60);
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}
async function launch(mobile) {
  await send('Page.navigate', { url: 'about:blank' });
  await send('Emulation.setDeviceMetricsOverride', { width: mobile ? 844 : 1000, height: mobile ? 390 : 600, deviceScaleFactor: 1, mobile });
  await send('Emulation.setTouchEmulationEnabled', mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
  await send('Page.navigate', { url: 'http://localhost:8082/?city-life-qa=' + Number(mobile) });
  // Navegar reaplica o override da aba: reafirmar, senão o desktop herda o toque e perde o teclado.
  await send('Emulation.setTouchEmulationEnabled', mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
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
  await evaluate(`(()=>{const m=[...__r.getModules().values()].filter(m=>m.isInitialized).map(m=>m.publicModule.exports);globalThis.qa={g:m.find(m=>m?.getGame).getGame(),input:m.find(m=>m?.inputState),store:m.find(m=>m?.useGameStore).useGameStore,Cover:m.find(m=>m?.CoverSystem).CoverSystem};qa.g.player.invulnUntil=Infinity;qa.g.weather.intensity=0;qa.g.dayNight.t=.5;})()`);
}
(async () => {
  const pages = await (await fetch('http://127.0.0.1:9223/json/list')).json();
  socket = new WebSocket(pages.find(p => p.type === 'page').webSocketDebuggerUrl);
  socket.onmessage = ({ data }) => {
    const m = JSON.parse(data);
    if (m.id) { const p = pending.get(m.id); if (!p) return; pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
    else if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  };
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  await send('Page.enable');
  await send('Page.navigate', { url: 'about:blank' });
  await send('Runtime.enable');
  await until('location.href==="about:blank"', 'clean context');
  errors.length = 0;
  await launch(false);
  await tap('KeyQ', 'q', 81); await until('qa.g.weapons.equipped==="bat"', 'previous weapon wraps');
  await tap('KeyZ', 'z', 90); await until('qa.g.weapons.equipped==="unarmed"', 'next weapon reverses');
  await tap('KeyC', 'c', 67); await until('qa.g.player.crouching', 'keyboard crouch');
  await screenshot('qa-city-crouch');
  await tap('Space', ' ', 32); await until('qa.g.player.jumpTimer>0&&!qa.g.player.crouching', 'jump leaves crouch');
  await until('qa.g.player.jumpTimer===0', 'landing');
  console.log('OK keyboard previous/next, crouch and jump cancellation');
  await evaluate(`(()=>{qa.pad={index:0,connected:true,mapping:'standard',axes:[0,0,0,0],buttons:Array.from({length:17},()=>({pressed:false,value:0}))};Object.defineProperty(navigator,'getGamepads',{configurable:true,value:()=>[qa.pad]});})()`);
  await delay(120);
  for (const [button, condition] of [[4,'qa.g.weapons.equipped==="bat"'],[5,'qa.g.weapons.equipped==="unarmed"'],[10,'qa.g.player.crouching']]) {
    await evaluate(`qa.pad.buttons[${button}]={pressed:true,value:1}`);
    await until(condition, 'gamepad button ' + button);
    await evaluate(`qa.pad.buttons[${button}]={pressed:false,value:0}`); await delay(80);
  }
  await evaluate('delete navigator.getGamepads;qa.g.player.crouching=false;qa.input.resetInputState()');
  console.log('OK gamepad LB/RB are opposite; LS click toggles crouch');
  await evaluate(`(()=>{const g=qa.g,p=g.player;g.wanted.clear(p);g.police.reset();g.witnesses.reset(g.npcs);g.weapons.acquire('pistol');g.weapons.equipped='pistol';
    for(const n of g.npcs.filter(n=>n.kind==='civ'&&!n.dead&&!n.inVehicle)) {
      const s={x:n.x+3,y:n.y};
      if(g.police.cops.some(c=>{const cop=g.npcs.find(n=>n.id===c.npcId);return cop&&Math.hypot(cop.x-s.x,cop.y-s.y)<22}))continue;
      if(g.collision.overlapsAny({...s,radius:.2},g.map.queryNearby(s.x,s.y,1))||g.map.isWaterWorld(s.x,s.y))continue;
      if(qa.Cover.firstHit({...n,z:1.55},{...s,z:1.4},{map:g.map,vehicles:g.vehicles}))continue;
      p.x=s.x;p.y=s.y;p.vx=p.vy=p.speed=0;g.camera.x=s.x;g.camera.y=s.y;n.patienceTimer=100000;n.state='idle';qa.witness=n;qa.incident={...s};return;
    }throw new Error('No witness scene');})()`);
  await delay(250);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 740, y: 290 });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 740, y: 290, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 740, y: 290, button: 'left', clickCount: 1 });
  await until('qa.g.witnesses.calls.length>0', 'gunshot produces witnesses');
  assert.equal(await evaluate('qa.g.player.wantedLevel'), 0);
  await until('qa.g.npcs.some(n=>n.callingPolice)', 'witness phone animation');
  await screenshot('qa-city-witness-call');
  await until('qa.g.player.wantedLevel>0 && qa.g.police.searchArea', 'delayed dispatch');
  assert.ok(await evaluate('Math.hypot(qa.g.police.searchArea.x-qa.incident.x,qa.g.police.searchArea.y-qa.incident.y)<.5'));
  console.log('OK a real shot waits for visible civilians to call before dispatch');
  await evaluate(`(()=>{const g=qa.g;qa.input.resetInputState();g.witnesses.reset(g.npcs);g.wanted.clear(g.player);g.police.reset();
    const u=g.police.units.find(u=>u.tier===1);const v=g.vehicles.find(v=>v.id===u.vehicleId);
    qa.unit=u;qa.vehicle=v;g.player.x=v.x+3;g.player.y=v.y;g.camera.x=g.player.x;g.camera.y=g.player.y;
    g.wanted.raise(g.player,1);g.police.report(g.player);qa.fleetCount=g.vehicles.length;qa.copCount=g.npcs.filter(n=>n.kind==='cop').length;
    qa.stationary={x:g.player.x,y:g.player.y};})()`);
  await until('qa.g.police.units.some(u=>u.mode==="deployed"&&u.crew.some(id=>qa.g.npcs.find(n=>n.id===id&&!n.inVehicle)))', 'patrol crew disembarks', 15000);
  await evaluate('qa.unit=qa.g.police.units.find(u=>u.mode==="deployed"&&u.crew.some(id=>qa.g.npcs.find(n=>n.id===id&&!n.inVehicle)));qa.vehicle=qa.g.vehicles.find(v=>v.id===qa.unit.vehicleId)');
  await screenshot('qa-city-police-disembark');
  assert.equal(await evaluate('qa.g.vehicles.length'), await evaluate('qa.fleetCount'));
  assert.equal(await evaluate('qa.g.npcs.filter(n=>n.kind==="cop").length'), await evaluate('qa.copCount'));
  assert.equal(await evaluate('qa.g.police.tracers.length'), 0);
  await evaluate(`(()=>{const g=qa.g,p=g.player;p.wantedLevel=2;p.invulnUntil=0;qa.startHealth=p.health;const n=g.npcs.find(n=>qa.unit.crew.includes(n.id)&&!n.inVehicle);for(const [dx,dy] of [[4,0],[-4,0],[0,4],[0,-4]]){const s={x:n.x+dx,y:n.y+dy};if(g.map.isWaterWorld(s.x,s.y)||g.collision.overlapsAny({...s,radius:.2},g.map.queryNearby(s.x,s.y,1))||qa.Cover.firstHit({...n,z:1.55},{...s,z:1.45},{map:g.map,vehicles:g.vehicles}))continue;p.x=s.x;p.y=s.y;g.camera.x=p.x;g.camera.y=p.y;g.police.report(p);return;}throw new Error('No clear firing scene');})()`);
  await until('qa.g.player.health<qa.startHealth', 'level two shoots', 20000);
  await screenshot('qa-city-police-fire');
  await evaluate('qa.g.player.invulnUntil=Infinity;qa.g.wanted.clear(qa.g.player);qa.g.police.reset();qa.g.witnesses.reset(qa.g.npcs)');
  console.log('OK existing patrol crew disembarks without spawning; level one unarmed, level two fires');
  const fleet = await evaluate(`(()=>{const g=qa.g;return{stations:g.map.landmarksOf('police').length,animals:g.wildlife.animals.length,species:[...new Set(g.wildlife.animals.map(a=>a.species))],variants:[...new Set(g.vehicles.map(v=>v.def.baseKey))]}})()`);
  assert.equal(fleet.stations, 3); assert.equal(fleet.animals, 224);
  for (const species of ['rabbit','deer','fox','boar']) assert.ok(fleet.species.includes(species));
  for (const variant of ['taxi','ambulance','hatchback','police_compact']) {
    assert.ok(fleet.variants.includes('veh_' + variant));
    await evaluate(`(()=>{const g=qa.g;qa.input.resetInputState();const v=g.vehicles.find(v=>v.def.baseKey===${JSON.stringify('veh_' + variant)}&&!v.occupied&&v.state==='parked');if(!v)throw new Error('No parked variant');qa.car=v;g.player.x=v.x+.8;g.player.y=v.y;g.player.crouching=false;g.camera.x=g.player.x;g.camera.y=g.player.y;g.notifyEntityChange();})()`);
    await delay(450); await screenshot('qa-city-vehicle-' + variant);
    await tap('KeyE', 'e', 69); await until('qa.g.player.currentVehicleId===qa.car.id', variant + ' entry');
    await evaluate('qa.beforeDrive={x:qa.car.x,y:qa.car.y}');
    await key('keyDown','ArrowUp','ArrowUp',38); await delay(500); await key('keyUp','ArrowUp','ArrowUp',38);
    assert.ok(await evaluate('Math.hypot(qa.car.x-qa.beforeDrive.x,qa.car.y-qa.beforeDrive.y)>.01'), variant + ' moves');
    await tap('KeyE', 'e', 69); await until('qa.g.player.currentVehicleId===null', variant + ' exit');
    await evaluate('qa.g.wanted.clear(qa.g.player);qa.g.police.reset()');
  }
  console.log('OK taxi, ambulance, hatchback and compact patrol spawn, render and drive');
  await evaluate(`(()=>{const mods=[...__r.getModules().values()].filter(m=>m.isInitialized).map(m=>m.publicModule.exports);const s=mods.find(m=>m?.sound?.ambient).sound;qa.sound=s;qa.beds=[];qa.rain=[];const ambient=s.ambient.bind(s),weather=s.weather.bind(s);s.ambient=(k,v)=>{qa.beds.push({k,v});ambient(k,v)};s.weather=v=>{qa.rain.push(v);weather(v)};})()`);
  for (const biome of ['forest','pinewood','savanna','beach','industrial']) {
    await evaluate(`(()=>{const g=qa.g;qa.input.resetInputState();const biome=${JSON.stringify(biome)};const a=g.wildlife.animals.find(a=>!a.dead&&g.map.data.tiles[Math.floor(a.y)*g.map.data.tilesW+Math.floor(a.x)]?.biome===biome);let p=a?{x:a.x+1,y:a.y}:null;if(!p){const i=g.map.data.tiles.findIndex((t,i)=>t.biome===biome&&['grass','dirt','concrete'].includes(t.kind)&&!g.collision.overlapsAny({x:i%g.map.data.tilesW+.5,y:Math.floor(i/g.map.data.tilesW)+.5,radius:.3},g.map.queryNearby(i%g.map.data.tilesW+.5,Math.floor(i/g.map.data.tilesW)+.5,1)));p={x:i%g.map.data.tilesW+.5,y:Math.floor(i/g.map.data.tilesW)+.5}}g.player.x=p.x;g.player.y=p.y;g.camera.x=p.x;g.camera.y=p.y;g.dayNight.t=.5;g.weather.intensity=0;g.weather.target=0;qa.beds.length=0;g.notifyEntityChange();})()`);
    await delay(400); await screenshot('qa-city-biome-' + biome);
    const bed = {forest:'forestDay',pinewood:'pinewoodDay',savanna:'savannaDay',beach:'coastDay',industrial:'industryDay'}[biome];
    await until(`qa.beds.some(b=>b.k===${JSON.stringify(bed)})`, biome + ' regional sound', 6000);
  }
  for (const species of ['fox','boar']) {
    await evaluate(`(()=>{const g=qa.g;const a=g.wildlife.animals.find(a=>a.species===${JSON.stringify(species)}&&!a.dead);qa.animal=a;g.paused=true;g.player.x=a.x+1.5;g.player.y=a.y;g.camera.x=g.player.x;g.camera.y=g.player.y;g.notifyEntityChange();})()`);
    await until(`(()=>{const m=[...__r.getModules().values()].filter(m=>m.isInitialized).map(m=>m.publicModule.exports);const sv=m.find(m=>m?.animalSVs)?.animalSVs.get(qa.animal.id);return sv&&Math.hypot(sv.position.value.x-qa.animal.x,sv.position.value.y-qa.animal.y)<.01})()`, species + ' visible sprite');
    await delay(350); await screenshot('qa-city-animal-' + species);
    await evaluate('qa.g.paused=false');
  }
  const dayFog = await evaluate('qa.g.fog.snapshot.color');
  await evaluate('qa.g.dayNight.t=.05;qa.g.weather.intensity=.8;qa.g.weather.target=.8');
  await until('qa.rain.some(v=>v>.1)', 'independent rain channel');
  await delay(1500); await screenshot('qa-city-night-rain');
  assert.notEqual(await evaluate('qa.g.fog.snapshot.color'), dayFog);
  assert.ok(await evaluate('qa.g.fog.snapshot.colors.at(-1)===qa.g.fog.snapshot.color'));
  // Pausa e menu não podem deixar leito nem chuva tocando sozinhos.
  await evaluate('qa.store.pause()');
  await until('qa.store.getState().paused', 'pause menu');
  await delay(400);
  assert.equal(await evaluate('qa.beds.at(-1)?.k'), null, 'environment bed keeps playing in the pause menu');
  assert.equal(await evaluate('qa.rain.at(-1)'), 0, 'rain keeps playing in the pause menu');
  await evaluate('qa.store.resume()');
  await until('qa.beds.at(-1)?.k!==null && qa.rain.at(-1)>0', 'bed and rain come back after resume');
  await evaluate('qa.store.goToMenu()');
  await until("qa.store.getState().screen==='menu'", 'main menu');
  await delay(400);
  assert.equal(await evaluate('qa.beds.at(-1)?.k'), null, 'environment bed keeps playing in the main menu');
  assert.equal(await evaluate('qa.rain.at(-1)'), 0, 'rain keeps playing in the main menu');
  await launch(false);
  await evaluate(`(()=>{const g=qa.g;const i=g.map.data.tiles.findIndex((t,i)=>t.biome==='savanna'&&t.kind==='dirt'&&!g.map.data.props.some(p=>Math.hypot(p.x-(i%g.map.data.tilesW+.5),p.y-(Math.floor(i/g.map.data.tilesW)+.5))<2));if(i<0)throw new Error('No open cash scene');g.player.x=i%g.map.data.tilesW+.5;g.player.y=Math.floor(i/g.map.data.tilesW)+.5;g.camera.x=g.player.x;g.camera.y=g.player.y;g.dayNight.t=.5;g.weather.intensity=0;g.weather.target=0;g.pickups.spawnDrop(g.player.x+1,g.player.y,75);qa.cash=g.pickups.items.findLast(p=>p.kind==='cash'&&p.active);g.notifyEntityChange();})()`);
  await delay(2000); await screenshot('qa-city-cash-a');
  await delay(550); await screenshot('qa-city-cash-b');
  await evaluate('qa.money=qa.g.player.money;qa.g.player.x=qa.cash.x;qa.g.player.y=qa.cash.y');
  await until('qa.g.player.money>qa.money', 'cash collection');
  console.log('OK four wildlife species, regional sound, changing opaque fog, rain and cash collection');
  await launch(true);
  const ids = await evaluate(`Array.from(document.querySelectorAll('[data-testid]')).map(e=>e.getAttribute('data-testid')).filter(s=>s.startsWith('control-'))`);
  console.log('Touch controls:', ids.join(', '));
  await touch('[data-testid=control-weaponPrev]'); await until('qa.g.weapons.equipped==="bat"', 'touch previous');
  await touch('[data-testid=control-weapon]'); await until('qa.g.weapons.equipped==="unarmed"', 'touch next');
  await touch('[data-testid=control-crouch]'); await until('qa.g.player.crouching', 'touch crouch');
  const bounds = await evaluate(`Array.from(document.querySelectorAll('[data-testid^="control-"]')).map(e=>({id:e.getAttribute('data-testid'),r:e.getBoundingClientRect()})).filter(x=>x.r.width>0).map(x=>({id:x.id,ok:x.r.left>=0&&x.r.top>=0&&x.r.right<=innerWidth+1&&x.r.bottom<=innerHeight+1}))`);
  assert.ok(bounds.every(b=>b.ok), JSON.stringify(bounds));
  await screenshot('qa-city-touch-landscape');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await delay(350);
  await screenshot('qa-city-touch-portrait');
  assert.equal(await evaluate('!!document.querySelector("[data-testid=hardware-hints]")'), false);
  await evaluate('qa.g.paused=true;qa.input.resetInputState()');
  assert.deepEqual(errors, []);
  console.log('OK touch portrait/landscape, no runtime exceptions');
  socket.close();
})().catch(async error => {
  console.error(error);
  try { await screenshot('qa-city-failure'); await evaluate('qa.g.paused=true;qa.input.resetInputState()'); } catch {}
  socket?.close(); process.exitCode = 1;
});
