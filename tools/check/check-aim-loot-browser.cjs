const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
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
  fs.writeFileSync(path.resolve(__dirname, name + '.png'), Buffer.from(data, 'base64'));
}
const tapPoint = async (p, id = 1) => {
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...p, id }] });
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await delay(160);
};
// O CDP só deriva `buttons` do botão do próprio evento, então uma segunda pressão pareceria
// com a soltura do primeiro. Um navegador real acumula a máscara, e é dela que o jogo lê
// "mirando + atirando": por isso as máscaras são mantidas aqui, no lado do motorista.
const BITS = { left: 1, right: 2, middle: 4 };
let mask = 0;
const dispatch = (type, x, y, button) => send('Input.dispatchMouseEvent',
  { type, x, y, buttons: mask, ...(button ? { button, clickCount: 1 } : {}) });
const press = async (x, y, button) => { mask |= BITS[button]; await dispatch('mousePressed', x, y, button); await delay(160); };
const release = async (x, y, button) => { mask &= ~BITS[button]; await dispatch('mouseReleased', x, y, button); await delay(160); };
const click = async (x, y, button = 'left') => { await press(x, y, button); await release(x, y, button); };
const moveTo = async (x, y) => { await dispatch('mouseMoved', x, y); await delay(60); };
// Com um save no storage o menu troca "JOGAR" por "NOVO JOGO"; os dois abrem uma partida nova.
const PLAY_LABEL = `(() => {const t=['JOGAR','NOVO JOGO'];for(const l of t){
  const e=[...document.querySelectorAll('div')].find(e=>e.childElementCount===0&&e.textContent===l);
  if(e){const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}}}return null})()`;
async function main() {
  const pages = await (await fetch('http://127.0.0.1:9223/json/list')).json();
  socket = new WebSocket(pages.find(p => p.type === 'page').webSocketDebuggerUrl);
  socket.onmessage = ({ data }) => {
    const m = JSON.parse(data);
    if (m.id) { const p = pending.get(m.id); if (!p) return; pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
    else if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  };
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  await send('Page.enable');
  await require('./bundle-identity.cjs').attach(socket, send);
  await send('Page.navigate', { url: 'about:blank' });
  await send('Runtime.enable');
  await until('location.href==="about:blank"', 'clean context');
  await send('Emulation.setDeviceMetricsOverride', { width: 900, height: 520, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: 'http://localhost:8082/' });
  // Navegar reaplica o override da aba: reafirmar, senão o desktop herda o toque e perde o teclado.
  await send('Emulation.setTouchEmulationEnabled', { enabled: false });
  await until(`${PLAY_LABEL}!==null`, 'menu', 90000);
  await tapPoint(await evaluate(PLAY_LABEL));
  await until('document.body.innerText.includes("HP 100")', 'HUD');
  await evaluate(`(()=>{const m=[...__r.getModules().values()].filter(m=>m.isInitialized).map(m=>m.publicModule.exports);
    globalThis.qa={g:m.find(m=>m?.getGame).getGame(),input:m.find(m=>m?.inputState).inputState,
      cover:m.find(m=>m?.CoverSystem)?.CoverSystem,guns:m.find(m=>m?.GUN_IDS)?.GUN_IDS};
    const g=qa.g;g.player.invulnUntil=Infinity;g.weather.intensity=0;g.dayNight.t=.5;
    g.police.reset();g.wanted.clear(g.player);})()`);
  assert.ok(await evaluate('!!qa.cover?.firstHit'), 'CoverSystem module must be reachable');

  // ---- 1. melee-only loadout at spawn ----
  // A lista de armas vem do próprio bundle (GUN_IDS): assim o teste não precisa
  // ser editado toda vez que o arsenal cresce.
  const start = await evaluate(`(()=>{const w=qa.g.weapons;return{owned:[...w.owned],equipped:w.equipped,
    all:[...qa.guns],guns:qa.guns.map(id=>({...w.ammo[id]}))}})()`);
  assert.deepEqual(start.owned, ['unarmed', 'bat']);
  assert.equal(start.equipped, 'unarmed');
  assert.ok(start.all.length >= 4, 'arsenal encolheu');
  for (const ammo of start.guns) assert.deepEqual(ammo, { loaded: 0, reserve: 0 });
  assert.match(await evaluate('document.body.innerText'), /Desarmado/, 'HUD shows the unarmed label');
  console.log('OK spawn: so soco e taco, nenhuma arma de fogo');

  // ---- 2. hidden gun caches are collectable ----
  const caches = await evaluate(`(()=>{const guns=qa.g.pickups.items.filter(p=>p.kind==='gun');
    return{count:guns.length,weapons:[...new Set(guns.map(p=>p.weapon))].sort(),all:[...qa.guns].sort()}})()`);
  assert.equal(caches.count, 12);
  assert.deepEqual(caches.weapons, caches.all, 'todo tipo de arma aparece em algum esconderijo');
  await evaluate(`(()=>{const g=qa.g,c=g.pickups.items.find(p=>p.kind==='gun');
    g.player.x=c.x;g.player.y=c.y;g.player.vx=g.player.vy=0;
    g.camera.x=c.x;g.camera.y=c.y;qa.want=c.weapon;g.notifyEntityChange();})()`);
  await until('qa.g.weapons.owned.has(qa.want)', 'gun cache grants ownership');
  const picked = await evaluate(`(()=>({equipped:qa.g.weapons.equipped,loaded:qa.g.weapons.ammo[qa.want].loaded,
    reserve:qa.g.weapons.ammo[qa.want].reserve}))()`);
  assert.ok(picked.loaded > 0 && picked.reserve > 0, JSON.stringify(picked));
  console.log('OK cache:', picked.equipped, picked.loaded + '/' + picked.reserve);

  // ---- 3. right button holds aim, left button shoots, manual aim beats autoaim ----
  const spot = await evaluate(`(() => {
    const g=qa.g,W=g.map.data.tilesW,H=g.map.data.tilesH;
    const clear=(x,y,tx,ty)=>!g.vehicles.some(v=>Math.hypot(v.x-x,v.y-y)<4)&&
      !qa.cover.firstHit({x,y,z:1.35},{x:tx,y:ty,z:1.2},{map:g.map,vehicles:g.vehicles});
    for(let i=0;i<W*H;i++){const t=g.map.data.tiles[i];
      if(!t||t.kind!=='road'||!t.lane)continue;
      const x=(i%W)+0.5,y=Math.floor(i/W)+0.5;
      if(!clear(x,y,x+3.2,y+0.35))continue;
      return{x,y};}
    throw new Error('No open shooting lane');
  })()`);
  const aimScene = (pickTarget = true) => evaluate(`(()=>{const g=qa.g,p=g.player;
    g.wanted.clear(p);g.police.reset();g.weather.intensity=0;g.dayNight.t=.5;
    p.x=${spot.x};p.y=${spot.y};p.vx=p.vy=p.speed=0;p.facingAngle=0;p.direction='SE';p.currentVehicleId=null;p.swimming=false;
    g.camera.x=p.x;g.camera.y=p.y;
    g.weapons.acquire('pistol');g.weapons.equipped='pistol';g.weapons.refill();g.weapons.update(2);
    const pool=g.npcs.filter(n=>n.kind==='civ'&&!n.dead&&!n.inVehicle);
    qa.ahead=pool[0];qa.side=pool[1];qa.other=pool[2];
    Object.assign(qa.ahead,{x:p.x+3,y:p.y+0.35,health:100,dead:false,state:'idle',patienceTimer:1e6});
    Object.assign(qa.other,{x:p.x-4,y:p.y-4,health:100,dead:false,state:'idle',patienceTimer:1e6});
    // The mouse can only aim at a point that is really on the game surface, so
    // pick the first open side direction whose projection avoids HUD/controls.
    // Touch scenes aim along facingAngle instead, so they skip the picker.
    if (!${pickTarget}) {
      Object.assign(qa.side,{x:p.x+2,y:p.y+3,health:100,dead:false,state:'idle',patienceTimer:1e6});
      qa.aimWorld=null;g.notifyEntityChange();return;
    }
    const canvases=[...document.querySelectorAll('canvas')];
    let surface=null,area=0;
    for(const c of canvases){const r=c.getBoundingClientRect();if(r.width*r.height>area){surface=c;area=r.width*r.height;}}
    const rect=surface.getBoundingClientRect();
    const free=(x,y)=>{if(x<rect.left+8||x>rect.right-8||y<rect.top+8||y>rect.bottom-8)return false;
      const el=document.elementFromPoint(x,y);
      return !el||!el.closest('[data-testid^="control-"],[data-testid^="hud-"],[data-hardware-input="ui"],button,[role="button"]');};
    // Exact inverse of mouseWorldAim: the mouse selects a point on the ground
    // plane, which is also where the shot ray and the hitboxes live.
    const project=(dx,dy)=>({x:rect.left+(g.viewW/2+64*(dx-dy)*g.camera.zoom)*rect.width/g.viewW,
      y:rect.top+(g.viewH/2+32*(dx+dy)*g.camera.zoom)*rect.height/g.viewH});
    let chosen=null;const tries=[];qa.tries=tries;
    for(const [dx,dy] of [[1,-3],[-1,3],[2,-2],[-2,-2],[1,3],[-1,-3],[-2,2]]){
      const s=project(dx,dy);
      const blocked=!!qa.cover.firstHit({x:p.x,y:p.y,z:1.35},{x:p.x+dx,y:p.y+dy,z:1.2},{map:g.map,vehicles:g.vehicles});
      const ok=free(s.x,s.y);
      tries.push({d:[dx,dy],s:{x:Math.round(s.x),y:Math.round(s.y)},blocked,ok});
      if(blocked||!ok)continue;
      chosen={dx,dy,screen:s};break;
    }
    if(!chosen)throw new Error('No clickable aim direction: '+JSON.stringify({rect:{l:rect.left,t:rect.top,r:rect.right,b:rect.bottom},
      view:{w:g.viewW,h:g.viewH,zoom:g.camera.zoom},tries:qa.tries}));
    Object.assign(qa.side,{x:p.x+chosen.dx,y:p.y+chosen.dy,health:100,dead:false,state:'idle',patienceTimer:1e6});
    qa.aimPoint=chosen.screen;qa.aimWorld={dx:chosen.dx,dy:chosen.dy};
    g.notifyEntityChange();})()`);
  await aimScene();
  await delay(250);
  const side = await evaluate('({x:qa.aimPoint.x,y:qa.aimPoint.y,world:qa.aimWorld})');
  await moveTo(side.x, side.y);
  assert.equal(await evaluate('qa.input.aimActive'), false, 'hovering alone must not aim');
  await press(side.x, side.y, 'right');
  assert.equal(await evaluate('qa.input.aimActive'), true, 'the right button holds manual aim');
  // A mira tem que cair no ponto do mundo sob o cursor, não a 2 tiles do player.
  // The aim re-projects the saved pixel every frame, so compare it against the
  // cursor's world point under the *current* camera instead of the one used to
  // pick the pixel: the camera keeps easing and zooming while the sim runs.
  const reticle = await evaluate(`(()=>{const g=qa.g,i=qa.input;
    const canvases=[...document.querySelectorAll('canvas')];let s=null,a=0;
    for(const c of canvases){const r=c.getBoundingClientRect();if(r.width*r.height>a){s=c;a=r.width*r.height;}}
    const rect=s.getBoundingClientRect();
    const sx=((qa.aimPoint.x-rect.left)*g.viewW/rect.width-g.viewW/2-g.shakeX)/g.camera.zoom;
    const sy=((qa.aimPoint.y-rect.top)*g.viewH/rect.height-g.viewH/2-g.shakeY)/g.camera.zoom;
    const px=g.camera.x+sx/128+sy/64,py=g.camera.y+sy/64-sx/128;
    const d=[i.aimPointX-g.player.x,i.aimPointY-g.player.y],want=[px-g.player.x,py-g.player.y];
    return{finite:Number.isFinite(i.aimPointX),got:d,want,
      dist:Math.hypot(d[0],d[1]),wantDist:Math.hypot(want[0],want[1])};})()`);
  assert.equal(reticle.finite, true, 'the cursor world point must reach the reticle');
  assert.ok(Math.abs(reticle.got[0] - reticle.want[0]) < 0.2 && Math.abs(reticle.got[1] - reticle.want[1]) < 0.2 &&
    Math.abs(reticle.dist - reticle.wantDist) < 0.2,
    'reticle must sit on the cursor: ' + JSON.stringify(reticle));
  await screenshot('qa-aim-right-button');
  const before = await evaluate('qa.g.weapons.ammo.pistol.loaded');
  await click(side.x, side.y, 'left');
  const aimed = await evaluate('({loaded:qa.g.weapons.ammo.pistol.loaded,aim:qa.g.weapons.aimAngle,'+
    'manual:qa.input.aimActive,'+
    'ahead:qa.ahead.health,side:qa.side.health,other:qa.other.health})');
  assert.equal(aimed.loaded, before - 1, 'the left button fires while aiming');
  // Atirar por cima não pode derrubar a mira: é exatamente aqui que o mouse quebrava.
  assert.equal(aimed.manual, true, 'the left click must not cancel the held right-button aim');
  const expected = Math.atan2(side.world.dy, side.world.dx);
  // The camera keeps easing toward the player, so the projected pixel is only
  // accurate to a fraction of a degree; what matters is that facing (0 rad) lost.
  assert.ok(Math.abs(Math.atan2(Math.sin(aimed.aim - expected), Math.cos(aimed.aim - expected))) < 0.01,
    `the aim ray follows the mouse: ${aimed.aim} vs ${expected}`);
  assert.ok(aimed.side < 100, 'manual aim must hit the pointed target');
  assert.equal(aimed.ahead, 100, 'autoaim must be ignored while manually aiming');
  assert.equal(aimed.other, 100);
  await release(side.x, side.y, 'right');
  assert.equal(await evaluate('qa.input.aimActive'), false, 'releasing the right button stops aiming');

  // ---- 4. with no manual aim the soft cone still assists ----
  await aimScene();
  await delay(200);
  await click(450, 300, 'left');
  const soft = await evaluate('({loaded:qa.g.weapons.ammo.pistol.loaded,ahead:qa.ahead.health,side:qa.side.health})');
  assert.equal(soft.loaded, 11, 'left click still shoots without aiming');
  assert.ok(soft.ahead < 100, 'the forward civilian keeps the cone assist');
  assert.equal(soft.side, 100);
  console.log('OK mira: LT/botao direito segura, RT/esquerdo atira, manual vence a automatica');

  // ---- 5. a killed cop drops a collectable pistol ----
  await evaluate(`(()=>{const g=qa.g,p=g.player;g.wanted.clear(p);g.police.reset();
    const pool=g.npcs.filter(n=>n.kind==='civ'&&!n.dead&&!n.inVehicle);
    const cop=pool[0];cop.kind='cop';cop.health=1;cop.x=p.x+3;cop.y=p.y;cop.state='idle';cop.dead=false;
    qa.cop=cop;g.weapons.equipped='pistol';g.weapons.refill();g.notifyEntityChange();})()`);
  await delay(250);
  await click(450, 300, 'left');
  await until('qa.cop.dead', 'cop killed');
  const drop = await evaluate(`(()=>{const d=qa.g.pickups.items.find(p=>p.kind==='gun'&&p.temporary&&
    Math.hypot(p.x-qa.cop.x,p.y-qa.cop.y)<0.3);return d&&{weapon:d.weapon,active:d.active}})()`);
  assert.ok(drop, 'a killed cop must drop a pistol');
  assert.equal(drop.weapon, 'pistol');
  await screenshot('qa-cop-pistol-drop');
  await evaluate(`(()=>{const g=qa.g,d=g.pickups.items.find(p=>p.kind==='gun'&&p.temporary&&p.weapon==='pistol'&&p.active);
    g.weapons.ammo.pistol.loaded=0;g.player.x=d.x;g.player.y=d.y;})()`);
  await until('qa.g.weapons.ammo.pistol.loaded===12', 'the dropped pistol is collected');
  console.log('OK policial abatido derruba pistola coletavel');

  // ---- 6. touch MIRA button on a phone viewport ----
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, screenWidth: 390, screenHeight: 844, deviceScaleFactor: 1, mobile: true });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await delay(400);
  // The first finger claims touch mode, which is what mounts the on-screen controls.
  // A single synthetic tap can land while React is still re-laying the resized viewport,
  // so keep pressing until the control cluster actually appears.
  const controlsMounted = () => evaluate(`!!document.querySelector('[data-testid=control-aim]')`);
  {
    const end = Date.now() + 20000;
    while (!await controlsMounted() && Date.now() < end) {
      await tapPoint({ x: 195, y: 420 });
      await delay(500);
    }
    assert.ok(await controlsMounted(), 'the first touch must mount the on-screen controls');
  }
  const aimButton = await evaluate(`(()=>{const e=document.querySelector('[data-testid=control-aim]');
    if(!e)return null;const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  assert.ok(aimButton, 'the touch build must expose the MIRA button');
  await tapPoint(aimButton);
  assert.equal(await evaluate('qa.input.aimTouchHeld'), true, 'MIRA turns manual aim on');
  assert.equal(await evaluate('qa.input.aimActive'), false, 'touch aim does not fake the mouse axis');
  await aimScene(false);
  await delay(250);
  const attack = await evaluate(`(()=>{const r=document.querySelector('[data-testid=control-attack]').getBoundingClientRect();
    return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  await tapPoint(attack, 2);
  const held = await evaluate('({loaded:qa.g.weapons.ammo.pistol.loaded,aim:qa.g.weapons.aimAngle,ahead:qa.ahead.health,side:qa.side.health})');
  assert.equal(held.loaded, 11, 'the attack button fires while MIRA is held');
  assert.ok(Math.abs(held.aim) < 1e-6, 'held MIRA aims exactly along facingAngle');
  assert.equal(held.ahead, 100, 'the cone assist stays off while MIRA is held');
  await screenshot('qa-aim-touch-mira');
  await tapPoint(aimButton);
  assert.equal(await evaluate('qa.input.aimTouchHeld'), false, 'MIRA toggles back off');
  await aimScene(false);
  await delay(250);
  await tapPoint(attack, 2);
  const free = await evaluate('({loaded:qa.g.weapons.ammo.pistol.loaded,ahead:qa.ahead.health})');
  assert.equal(free.loaded, 11, 'the attack button fires without MIRA');
  assert.ok(free.ahead < 100, 'without MIRA the soft cone still assists');
  console.log('OK MIRA no touch: liga/desliga e desliga a mira automatica');

  console.log('QA mira + loot OK. erros de pagina:', errors);
}
main().then(() => process.exit(0)).catch(e => { console.error('FAIL', e); process.exit(1); });
