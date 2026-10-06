// Browser check: the people who belong to a room are not a headless idea. They are drawn in
// frame, they walk around their own post, and a shot fired through the real attack button
// empties the floor around the shooter. Leaving through the door freezes the whole cast.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

let socket, serial = 0;
const pending = new Map(), errors = [];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve));
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
  while (Date.now() < end) {
    const value = await evaluate(expression);
    if (value) return value;
    await delay(60);
  }
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
  // A page the browser thinks is in the background gets a couple of animation frames a second
  // and the whole game would idle. Focus emulation and the active lifecycle state say "this tab
  // is on screen", which is what the timing claims below need to actually mean something.
  await send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
  await send('Page.navigate', { url: 'about:blank' });
  await until('location.href==="about:blank"', 'clean context');
  await send('Emulation.setDeviceMetricsOverride', { width, height, screenWidth: width, screenHeight: height, deviceScaleFactor: 1, mobile });
  await send('Emulation.setTouchEmulationEnabled', mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
  await send('Page.navigate', { url: 'http://localhost:8082/' });
  // Navegar reaplica o override da aba: reafirmar, senão o desktop herda o toque e perde o teclado.
  await send('Emulation.setTouchEmulationEnabled', mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
  await until('!!document.body?.innerText.match(/JOGAR|NOVO JOGO/)', 'menu', 240000);
  await tapPoint(await evaluate(`(()=>{const e=[...document.querySelectorAll('div')].find(e=>e.childElementCount===0&&(e.textContent==='JOGAR'||e.textContent==='NOVO JOGO'));
    const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`), mobile);
  await until('document.body.innerText.includes("HP 100")', 'HUD');
  await send('Page.setWebLifecycleState', { state: 'active' }).catch(() => {});
  await evaluate(`(()=>{const m=[...__r.getModules().values()].filter(m=>m.isInitialized).map(m=>m.publicModule.exports);
    globalThis.qa={g:m.find(m=>m?.getGame).getGame(),input:m.find(m=>m?.inputState).inputState};const g=qa.g;
    g.player.invulnUntil=Infinity;g.weather.intensity=0;g.dayNight.t=.5;})()`);
  // HUD on screen is not the world being done: the city is still being generated, and a door
  // teleported onto a block that does not exist yet leads nowhere.
  await until('qa.g.npcs.length>0 && qa.g.interiors.entrances.length>1', 'the generated city', 60000);
}

/**
 * Cruzar a porta pelo mesmo caminho do dedo, e tentar de novo enquanto a cidade assenta:
 * o interact é uma flag consumida no próximo tick, então uma teleportação engolida por um
 * respawn da geração não abre nada e a sala continuaria vazia para sempre.
 */
async function enterRoom(kind, tag) {
  for (let attempt = 0; attempt < 12; attempt++) {
    const found = await evaluate(`(()=>{const g=qa.g,e=g.interiors.entrances.find(e=>e.kind==='${kind}');
      if(!e)return false;const p=g.player;p.x=e.x;p.y=e.y;p.vx=p.vy=0;
      g.camera.x=e.x;g.camera.y=e.y;g.notifyEntityChange();return true})()`);
    assert.ok(found, `${kind} ${tag}: the city must contain a ${kind} entrance`);
    await delay(250);
    await evaluate('qa.input.interactQueued=true');
    try {
      await until(`qa.g.interiors.active?.kind === '${kind}' && qa.g.crowd.inside`, 'the room to open', 5000);
      return;
    } catch { /* a respawn probably swallowed the teleport: stand at the door again */ }
  }
  throw new Error(`${kind} ${tag}: the door never opened`);
}

/** Pela mesma maçaneta: o portal da sala leva de volta à rua. */
async function exitRoom(kind, tag) {
  for (let attempt = 0; attempt < 12; attempt++) {
    await evaluate(`(()=>{const g=qa.g,r=g.interiors.active;if(!r)return;
      g.player.x=r.exit.x;g.player.y=r.exit.y;g.camera.x=r.exit.x;g.camera.y=r.exit.y;g.notifyEntityChange();})()`);
    await delay(250);
    await evaluate('qa.input.interactQueued=true');
    try {
      await until('qa.g.interiors.active === null', 'the street to come back', 12000);
      return;
    } catch { /* the doorway is only answerable once the room has settled: try again */ }
  }
  throw new Error(`${kind} ${tag}: the doorway never led out`);
}

/** Screen position of a room-local point, with the same iso maths the canvas uses. */
const ON_SCREEN = `(()=>{const g=qa.g;const sx=(p)=>((p.x-p.y)*64-(g.camera.x-g.camera.y)*64)*g.camera.zoom+g.viewW/2;
  const sy=(p)=>((p.x+p.y)*32-(g.camera.x+g.camera.y)*32)*g.camera.zoom+g.viewH/2;
  return g.crowd.list.map((o)=>({id:o.id,role:o.role,x:sx(o),y:sy(o)}))})()`;

async function crowdPass(kind, tag, mobile) {
  await enterRoom(kind, tag);
  assert.equal(await evaluate('qa.g.crowd.inside'), true, `${kind} ${tag}: entering a room must hire its people`);

  const cast = await evaluate(`qa.g.crowd.list.map((o)=>({id:o.id,role:o.role,x:o.x,y:o.y}))`);
  assert.ok(cast.length >= 2, `${kind} ${tag}: a room needs more than one person (${cast.length})`);
  const room = await evaluate(`(()=>{const r=qa.g.interiors.active;return{w:r.map.worldW,h:r.map.worldH}})()`);
  assert.ok(cast.every((o) => o.x > 0.4 && o.y > 0.4 && o.x < room.w && o.y < room.h),
    `${kind} ${tag}: the cast is born inside the room`);

  // Framed, not simulated off-camera: the camera is eased to the middle of the room, which is
  // where the whole cast has to be around. A phone screen is narrower than a seven-step room,
  // so the claim is "in view or one step away", never "every corner pixel on screen".
  await evaluate(`(()=>{const g=qa.g,r=g.interiors.active;g.player.x=r.map.worldW/2;g.player.y=r.map.worldH/2;
    g.camera.x=g.player.x;g.camera.y=g.player.y;g.notifyEntityChange();})()`);
  // Waited, not assumed: the camera eases toward the player one frame at a time, and a debug
  // browser still pulling assets through Metro paints those frames slowly.
  await until('Math.hypot(qa.g.camera.x-qa.g.player.x,qa.g.camera.y-qa.g.player.y)<0.3', 'the camera to settle inside the room', 40000);
  const drawn = await evaluate(ON_SCREEN);
  const view = await evaluate(`({w:qa.g.viewW,h:qa.g.viewH})`);
  const onScreen = drawn.filter((o) => o.x > 0 && o.x < view.w && o.y > 0 && o.y < view.h);
  assert.ok(onScreen.length >= Math.min(2, drawn.length),
    `${kind} ${tag}: a sala é pintada sem ninguém em quadro (${drawn.map((o) => `${o.role} ${o.x.toFixed(0)},${o.y.toFixed(0)}`).join(' / ')} de ${view.w}x${view.h})`);
  for (const o of drawn) {
    assert.ok(o.x > -view.w * 0.6 && o.x < view.w * 1.6 && o.y > -view.h * 0.6 && o.y < view.h * 1.6,
      `${kind} ${tag}: ${o.role} is painted a whole screen away from the camera (${o.x.toFixed(0)},${o.y.toFixed(0)})`);
  }
  await screenshot(`crowd-${tag}-${kind}`);

  // They live: the game's own loop has to change the floor under the sprites. The walk is
  // waited for instead of timed by hand, because a debug browser that is still pulling 500
  // assets through Metro paints a frame every couple of seconds — and a room that only moves
  // when the harness pushes the clock is exactly what this claim must never let through.
  const clock = await evaluate('qa.g.time');
  await evaluate('qa.snap=null');
  let walked = 0;
  try {
    walked = await until(`(()=>{const g=qa.g,now=g.crowd.list.map((o)=>[o.id,o.x,o.y]);
      if(!qa.snap)qa.snap=now;
      const s=now.reduce((t,[id,x,y])=>{const p=qa.snap.find((q)=>q[0]===id);
        return t+(p?Math.hypot(x-p[1],y-p[2]):0)},0);
      return s>0.5?s:false})()`, 'the room to be alive', 90000);
  } catch {
    throw new Error(`${kind} ${tag}: the room is a stage set, nobody moved while the game clock ran ` +
      `${((await evaluate('qa.g.time')) - clock).toFixed(2)}s`);
  }

  // The real attack button, a real gun, and the room's answer. Nothing here pokes the crowd
  // system: the shot has to travel through the same input path a player uses.
  await evaluate(`(()=>{const g=qa.g;g.weapons.owned.add('pistol');g.weapons.equipped='pistol';
    g.weapons.ammo.pistol.loaded=8;g.weapons.ammo.pistol.reserve=24;g.notifyEntityChange();})()`);
  const shot = await evaluate(`(()=>{const g=qa.g,o=g.crowd.list[0];
    g.player.x=o.x-1.2;g.player.y=o.y;g.player.facingAngle=Math.atan2(o.y-g.player.y,o.x-g.player.x);
    g.camera.x=g.player.x;g.camera.y=g.player.y;g.notifyEntityChange();
    return g.crowd.list.map((c)=>({id:c.id,d:Math.hypot(c.x-g.player.x,c.y-g.player.y)}))})()`);
  await delay(400);
  await evaluate('qa.input.attackQueued=true');
  await until('qa.g.crowd.list.every((o)=>o.dead||o.panic>0)', `${kind} ${tag}: the gunshot never reached the room`, 60000);
  let fleeing = false;
  try {
    fleeing = await until('qa.g.crowd.list.some((o)=>!o.dead&&o.state==="fleeing")', 'someone to run', 60000);
  } catch { /* the assertion below is the one that has to say what happened */ }
  await screenshot(`crowd-${tag}-${kind}-fleeing`);
  assert.ok(fleeing, `${kind} ${tag}: panicked people must be running, not standing`);

  // Distance is matched by id: a body that ate a bullet leaves the list and the rest keeps
  // its place in the room.
  const base = shot.map((s) => [s.id, s.d]);
  let fled = 0;
  try {
    fled = await until(`(()=>{const g=qa.g,base=${JSON.stringify(base)};let top=0;
      g.crowd.list.forEach((o)=>{const b=base.find((q)=>q[0]===o.id);
        if(b&&!o.dead)top=Math.max(top,Math.hypot(o.x-g.player.x,o.y-g.player.y)-b[1])});
      return top>0.3?top:false})()`, 'the room to empty around the shooter', 60000);
  } catch { /* reported by the number below */ }
  assert.ok(fled > 0.3, `${kind} ${tag}: nobody ran away from the shooter (${fled.toFixed(2)})`);

  // The door still leads out, and the cast stops existing the moment the room is not on screen.
  const street = await evaluate('qa.g.npcs.length');
  await exitRoom(kind, tag);
  assert.equal(await evaluate('qa.g.crowd.inside'), false, `${kind} ${tag}: leaving stops the room`);
  assert.equal(await evaluate('qa.g.crowd.list.length'), 0, `${kind} ${tag}: no ghost occupant after the door`);
  assert.equal(await evaluate('qa.g.npcs.length'), street, `${kind} ${tag}: the room did not dump people on the pavement`);

  // Coming back through the same door reopens the same house, with the same faces.
  await enterRoom(kind, tag);
  assert.deepEqual(await evaluate(`qa.g.crowd.list.map((o)=>o.id)`), cast.map((o) => o.id),
    `${kind} ${tag}: the cast belongs to the room, not to the visit`);
  // And out again: the next room is entered from the street, never from inside another one.
  await exitRoom(kind, tag);
  console.log(`OK ${kind} crowd on ${tag} (${cast.length} people: ${cast.map((o) => o.role).join(', ')}, ` +
    `walked ${walked.toFixed(2)}, ran ${fled.toFixed(2)} from the shot)`);
}

(async () => {
  // CDP_PORT has to point at a debug browser the operating system lets paint: a tab Chrome
  // considers hidden gets a couple of animation frames a second, and every probe below would
  // then be waiting on a paused game instead of a room of people.
  const port = process.env.CDP_PORT || 9223;
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
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
  await require('./bundle-identity.cjs').attach(socket, send);
  await send('Runtime.enable');

  await boot(844, 390, true);
  await crowdPass('home', 'phone', true);
  await crowdPass('shop', 'phone', true);
  await boot(1440, 900, false);
  await crowdPass('office', 'desktop', false);

  assert.deepEqual(errors, [], `page errors: ${errors.join('\n')}`);
  console.log('OK interior crowd drawn, walking, fleeing a real shot, frozen by the door and rehired on the visit');
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
