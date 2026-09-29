// Browser check: entering a room frames it correctly on a phone and a desktop.
// Nothing here trusts the Node camera maths: every assertion reads the live
// GameState after the game has actually eased the camera into place.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

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
async function until(expression, label, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await evaluate(expression)) return; await delay(60); }
  throw new Error('Timed out: ' + label);
}
async function screenshot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.resolve(__dirname, `../tmp/${name}.png`), Buffer.from(data, 'base64'));
}
const tapPoint = async (p, mobile) => {
  if (mobile) {
    await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...p, id: 1 }] });
    await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } else {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 });
  }
  await delay(160);
};
async function boot(width, height, mobile) {
  await send('Page.navigate', { url: 'about:blank' });
  await until('location.href==="about:blank"', 'clean context');
  await send('Emulation.setDeviceMetricsOverride', { width, height, screenWidth: width, screenHeight: height, deviceScaleFactor: 1, mobile });
  await send('Emulation.setTouchEmulationEnabled', { enabled: mobile, maxTouchPoints: 5 });
  await send('Page.navigate', { url: 'http://localhost:8082/' });
  await until('!!document.body?.innerText.match(/JOGAR|NOVO JOGO/)', 'menu', 90000);
  await tapPoint(await evaluate(`(()=>{const e=[...document.querySelectorAll('div')].find(e=>e.childElementCount===0&&(e.textContent==='JOGAR'||e.textContent==='NOVO JOGO'));
    const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`), mobile);
  await until('document.body.innerText.includes("HP 100")', 'HUD');
  await evaluate(`(()=>{const m=[...__r.getModules().values()].filter(m=>m.isInitialized).map(m=>m.publicModule.exports);
    globalThis.qa={g:m.find(m=>m?.getGame).getGame(),input:m.find(m=>m?.inputState).inputState};const g=qa.g;
    g.player.invulnUntil=Infinity;g.weather.intensity=0;g.dayNight.t=.5;})()`);
}

/** Walk into a room, then probe the framing from the doorway and both far corners. */
async function roomPass(kind, tag) {
  const door = await evaluate(`(()=>{const g=qa.g,e=g.interiors.entrances.find(e=>e.kind==='${kind}');
    if(!e)return null;const p=g.player;p.x=e.x;p.y=e.y;p.vx=p.vy=0;g.camera.x=e.x;g.camera.y=e.y;
    g.notifyEntityChange();return{label:e.label}})()`);
  assert.ok(door, `the city must contain a ${kind} entrance`);
  await delay(400);
  await evaluate('qa.input.interactQueued=true');
  await delay(500);
  const active = await evaluate(`(()=>{const r=qa.g.interiors.active;return r&&{kind:r.kind,zoom:qa.g.camera.zoom,w:r.map.worldW,h:r.map.worldH}})()`);
  assert.equal(active?.kind, kind, `${door.label} must open`);
  assert.ok(active.zoom >= 1.8, `${kind} ${tag}: indoor zoom stays close enough to read the furniture (${active.zoom})`);
  await screenshot(`interiors-${tag}-${kind}`);
  // The camera eases toward the player, so each corner needs a settle before measuring.
  for (const [name, x, y] of [['back', 1.6, 1.4], ['front', active.w - 1.2, active.h - 0.9], ['left', 1.2, active.h - 0.9]]) {
    await evaluate(`(()=>{const g=qa.g;g.player.x=${x};g.player.y=${y};g.notifyEntityChange();})()`);
    await delay(2000);
    const frame = await evaluate(`(()=>{const g=qa.g,r=qa.g.interiors.active,z=g.camera.zoom;
      const sx=(p)=>((p.x-p.y)*64-(g.camera.x-g.camera.y)*64)*z+g.viewW/2;
      const sy=(p)=>((p.x+p.y)*32-(g.camera.x+g.camera.y)*32)*z+g.viewH/2;
      return{px:sx(g.player),py:sy(g.player),back:sy({x:0,y:0}),front:sy({x:r.map.worldW,y:r.map.worldH}),
        w:g.viewW,h:g.viewH,cx:g.camera.x,cy:g.camera.y,rw:r.map.worldW,rh:r.map.worldH};})()`);
    assert.ok(frame.px > 40 && frame.px < frame.w - 40, `${kind} ${tag} ${name}: player off the horizontal edge`);
    assert.ok(frame.py > 40 && frame.py < frame.h - 40, `${kind} ${tag} ${name}: player off the vertical edge`);
    assert.ok(frame.cx >= 0 && frame.cx <= frame.rw && frame.cy >= 0 && frame.cy <= frame.rh,
      `${kind} ${tag} ${name}: camera drifted outside the room`);
    // Framing rules out the old bug where the room filled the screen with bare floor:
    // from any corner the far walls descend into frame and the near sill does too.
    assert.ok(frame.back <= 1 && frame.front >= frame.h - 1, `${kind} ${tag} ${name}: no wall edge is in frame`);
  }
  await evaluate(`(()=>{const g=qa.g;g.player.x=g.interiors.active.exit.x;g.player.y=g.interiors.active.exit.y;g.notifyEntityChange();})()`);
  await delay(1600);
  await evaluate('qa.input.interactQueued=true');
  await delay(600);
  assert.equal(await evaluate('qa.g.interiors.active'), null, `${kind} ${tag}: the doorway must lead back out`);
  assert.equal(await evaluate('qa.g.activeMap === qa.g.map'), true, `${kind} ${tag}: exit returns to the street`);
  console.log(`OK ${kind} framed on ${tag} (zoom ${active.zoom.toFixed(2)})`);
}

/**
 * Balcão de venda de verdade: entra na loja, senta no balcão, e compra tocando no preço —
 * o mesmo caminho do dedo do jogador, sem chamar purchaseShopItem por trás da interface.
 */
async function counterPass(counter, tag, mobile) {
  const MENU_TEXT = counter === 'armaria' ? 'ARMARIA' : 'PIZZARIA';
  const found = await evaluate(`(()=>{const g=qa.g,e=g.interiors.entrances.find(e=>e.counter==='${counter}');
    if(!e)return null;const p=g.player;p.x=e.x;p.y=e.y;p.vx=p.vy=0;p.money=5000;g.camera.x=e.x;g.camera.y=e.y;
    g.notifyEntityChange();return{label:e.label}})()`);
  assert.ok(found, `the city must contain a ${counter} counter`);
  await delay(500);
  await evaluate('qa.input.interactQueued=true');
  await delay(700);
  const room = await evaluate(`(()=>{const r=qa.g.interiors.active;return r&&{kind:r.kind,titulo:r.shop?.title,
    moveis:r.furniture.map((f)=>f.kind),servico:r.service}})()`);
  assert.equal(room?.kind, 'shop', `${counter} ${tag}: a counter only exists inside a shop`);
  assert.equal(room.titulo, MENU_TEXT === 'ARMARIA' ? 'Armaria' : 'Pizzaria', `${counter} ${tag}: wrong menu on the counter`);
  for (const piece of counter === 'armaria' ? ['rack', 'counter', 'crate', 'stool'] : ['counter', 'grill', 'booth', 'crate'])
    assert.ok(room.moveis.includes(piece), `${counter} ${tag}: the room is missing its ${piece}`);
  await screenshot(`shop-${tag}-${counter}-room`);
  // Send the player to the counter and press the same interact the on-screen button uses.
  await evaluate(`(()=>{const g=qa.g,s=g.interiors.active.service;g.player.x=s.x;g.player.y=s.y;g.notifyEntityChange();})()`);
  await delay(300);
  await evaluate('qa.input.interactQueued=true');
  await delay(700);
  assert.ok((await evaluate('document.body.innerText')).includes(MENU_TEXT), `${counter} ${tag}: the counter menu never opened`);
  assert.ok((await evaluate('document.body.innerText')).includes('Em caixa: $5000'), `${counter} ${tag}: the menu must show the cash`);
  // With the menu open the world waits: browsing cannot be interrupted by a car or a bullet.
  const before = await evaluate('qa.g.time');
  await delay(600);
  assert.equal(await evaluate('qa.g.time'), before, `${counter} ${tag}: the counter must freeze the simulation`);
  await screenshot(`shop-${tag}-${counter}-menu`);

  const first = counter === 'armaria' ? { price: 400, id: 'gun-pistol' } : { price: 30, id: 'pizza-grande' };
  await evaluate(`qa.g.player.health=20;qa.g.player.stamina=0.2`);
  await tapText(`$${first.price}`, mobile);
  await delay(500);
  assert.equal(await evaluate('qa.g.player.money'), 5000 - first.price, `${counter} ${tag}: the price was not charged`);
  if (counter === 'armaria') {
    assert.equal(await evaluate('qa.g.weapons.owned.has("pistol")'), true, `${counter} ${tag}: the gun was not delivered`);
    assert.ok((await evaluate('document.body.innerText')).includes('SEU'), `${counter} ${tag}: an owned gun must stop being for sale`);
    await tapText('$80', mobile);
    await delay(400);
    assert.equal(await evaluate('qa.g.player.money'), 5000 - first.price - 80, `${counter} ${tag}: the ammo box was not charged`);
    assert.ok((await evaluate('document.body.innerText')).includes('Munição reabastecida'), `${counter} ${tag}: the ammo box did not refill the magazines`);
  } else {
    assert.ok(await evaluate('qa.g.player.health > 20'), `${counter} ${tag}: the meal did not feed anyone`);
    assert.equal(await evaluate('qa.g.player.stamina'), 1, `${counter} ${tag}: the meal did not restore stamina`);
    assert.ok((await evaluate('document.body.innerText')).includes('Bom apetite'), `${counter} ${tag}: no receipt message`);
  }
  await tapText('SAIR DO BALCÃO', mobile);
  await delay(400);
  assert.ok(!(await evaluate('document.body.innerText')).includes('Em caixa:'), `${counter} ${tag}: the menu must close`);
  // And the door still leads back to the street.
  await evaluate(`(()=>{const g=qa.g;g.player.x=g.interiors.active.exit.x;g.player.y=g.interiors.active.exit.y;g.notifyEntityChange();})()`);
  await delay(1600);
  await evaluate('qa.input.interactQueued=true');
  await delay(600);
  assert.equal(await evaluate('qa.g.interiors.active'), null, `${counter} ${tag}: the shop door must lead back out`);
  console.log(`OK ${counter} counter bought on ${tag} (menu, price and delivery)`);
}

/** Taps the innermost element whose whole text equals `text`, the way a finger would. */
async function tapText(text, mobile) {
  const search = `(()=>{const list=[...document.querySelectorAll('div,span')].filter((e)=>
    e.textContent.trim()===${JSON.stringify(text)} && e.getBoundingClientRect().width > 4 && e.getBoundingClientRect().height > 4);
    return list[list.length-1]})()`;
  await evaluate(`(()=>{const e=${search}; if(e)e.scrollIntoView({block:'center'}); return !!e})()`);
  await delay(260);
  // Reading the coordinates is not enough: an element can be painted under another one, and a
  // finger there hits whoever is on top. Only a free elementFromPoint is a button you can press.
  const hit = await evaluate(`(()=>{const e=${search}; if(!e)return null;const r=e.getBoundingClientRect();
    const x=r.x+r.width/2, y=r.y+r.height/2, top=document.elementFromPoint(x,y);
    return{x,y,livre:!!top&&(top===e||e.contains(top)||top.contains(e))}})()`);
  assert.ok(hit, `nothing on screen says ${text}`);
  assert.ok(hit.livre, `${text} is on screen but something else is on top of it`);
  await tapPoint({ x: hit.x, y: hit.y }, mobile);
}

(async () => {
  const pages = await (await fetch('http://127.0.0.1:9223/json/list')).json();
  socket = new WebSocket(pages.find((p) => p.type === 'page').webSocketDebuggerUrl);
  socket.onmessage = ({ data }) => {
    const m = JSON.parse(data);
    if (m.id) {
      const p = pending.get(m.id); if (!p) return; pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    } else if (m.method === 'Runtime.exceptionThrown') {
      errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    }
  };
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  await send('Page.enable');
  await send('Runtime.enable');

  await boot(844, 390, true);
  for (const kind of ['home', 'shop', 'office']) await roomPass(kind, 'phone');
  await counterPass('armaria', 'phone', true);
  await counterPass('pizza', 'phone', true);
  await boot(1440, 900, false);
  for (const kind of ['home', 'shop']) await roomPass(kind, 'desktop');
  await counterPass('armaria', 'desktop', false);

  assert.deepEqual(errors, [], `page errors: ${errors.join('\n')}`);
  console.log('OK interiors framed and escapable on phone and desktop, counters sell, no page errors');
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
