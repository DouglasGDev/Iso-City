const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const output = path.resolve(__dirname, '../tmp');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pending = new Map(), errors = [];
let socket, id = 0;
function send(method, params = {}) {
  return new Promise((resolve, reject) => { const key = ++id; pending.set(key, { resolve, reject }); socket.send(JSON.stringify({ id: key, method, params })); });
}
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}
async function until(expression, label, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await evaluate(expression)) return; await delay(80); }
  throw new Error(`Timed out: ${label}`);
}
async function viewport(width, height, mobile = true) {
  await send('Emulation.setDeviceMetricsOverride', { width, height, screenWidth: width, screenHeight: height, deviceScaleFactor: 1, mobile });
  await send('Emulation.setTouchEmulationEnabled', { enabled: mobile, maxTouchPoints: 5 });
}
const touch = (type, points) => send('Input.dispatchTouchEvent', { type, touchPoints: points.map((p) => ({ radiusX: 4, radiusY: 4, force: 1, ...p })) });
async function tapPoint(p) { await touch('touchStart', [{ ...p, id: 1 }]); await delay(60); await touch('touchEnd', []); await delay(160); }
async function center(selector) {
  return evaluate(`(() => {const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
}
async function tap(testId) { await tapPoint(await center(`[data-testid="${testId}"]`)); }
async function shot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(output, `qa-exploration-${name}.png`), Buffer.from(data, 'base64'));
}
async function expose() {
  await evaluate(`(() => {const mods=[...__r.getModules().values()].filter(m=>m.isInitialized).map(m=>m.publicModule.exports);
    globalThis.qa={g:mods.find(m=>m?.getGame).getGame(),store:mods.find(m=>m?.useGameStore).useGameStore,
    presentation:mods.find(m=>m?.makeProjectors),input:mods.find(m=>m?.inputState).inputState};})()`);
}
const progress = () => evaluate('({version:qa.g.exploration.version,explored:qa.g.exploration.exploredCount,visited:qa.g.exploration.visitedCount})');
// Com save no storage o menu troca "JOGAR" por "NOVO JOGO"; os dois abrem partida nova.
const PLAY_LABEL = `(() => {const t=['JOGAR','NOVO JOGO'];for(const l of t){const e=[...document.querySelectorAll('div')].find(e=>e.childElementCount===0&&e.textContent===l);if(e){const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}}}return null})()`;
async function startGame() {
  await until(`${PLAY_LABEL}!==null`, 'menu assets', 120000);
  const p = await evaluate(PLAY_LABEL);
  await tapPoint(p);
  await until('!!document.querySelector("[data-testid=control-weapon]")', 'game');
  await expose();
}
async function openMap() { await tap('hud-map'); await until('qa.store.getState().mapOpen', 'open map'); await delay(300); }
async function closeMap() { await tap('full-map-close'); await until('!qa.store.getState().mapOpen', 'close map'); }
async function readView() {
  return evaluate(`(() => {let f=document.querySelector('[data-testid=full-map]').__reactFiber$;
    const el=document.querySelector('[data-testid=full-map]');f=el[Object.keys(el).find(k=>k.startsWith('__reactFiber$'))];
    while(f&&f.type?.name!=='FullMap')f=f.return;
    function find(n){if(!n)return null;if(n.type?.name==='MapCanvas')return n.memoizedProps;return find(n.child)||find(n.sibling)}
    const p=find(f.child);return {zoom:p.zoom,panX:p.panX,panY:p.panY,mapW:p.mapW,mapH:p.mapH};})()`);
}
async function playerScreen() {
  const view = await readView();
  return evaluate(`(() => {const v=${JSON.stringify(view)},g=qa.g,p=g.interiors.active?.entrance??g.player;return qa.presentation.makeProjectors(v.mapW,v.mapH,0,g.map.data.tilesW,g.map.data.tilesH,v.zoom,v.panX,v.panY).worldToScreen(p.x,p.y)})()`);
}
async function checkCentered() {
  const p = await playerScreen(), view = await readView();
  assert.ok(Math.abs(p.x - view.mapW / 2) < 1 && Math.abs(p.y - view.mapH / 2) < 1, `not centered: ${JSON.stringify({ p, view })}`);
}
(async () => {
  const tabs = await (await fetch('http://127.0.0.1:9223/json/list')).json();
  const page = tabs.find((p) => p.type === 'page');
  socket = new WebSocket(page.webSocketDebuggerUrl);
  socket.addEventListener('message', ({ data }) => {
    const m = JSON.parse(data);
    if (m.id) { const p = pending.get(m.id); pending.delete(m.id); if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result); }
    else if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errors.push(m.params.entry.text);
  });
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve); socket.addEventListener('error', reject); });
  await send('Page.enable'); await send('Page.navigate', { url: 'about:blank' });
  await until('location.href==="about:blank"', 'clean context');
  await send('Runtime.enable'); await send('Log.enable'); await send('Log.clear'); errors.length = 0;
  await viewport(844, 390);
  await send('Page.navigate', { url: 'http://localhost:8082/?map-test=1' });
  await startGame();
  const initial = await progress();
  assert.ok(initial.explored > 0 && initial.explored < 250 && initial.visited < 4);
  await openMap(); await checkCentered(); await shot('fresh');
  const frozen = await progress();
  await delay(500); assert.deepEqual(await progress(), frozen);
  await closeMap();
  await touch('touchStart', [{ x: 170, y: 290, id: 1 }]);
  await touch('touchMove', [{ x: 211, y: 311, id: 1 }]);
  await delay(1600); await touch('touchEnd', []);
  await until(`qa.g.exploration.visitedCount>${initial.visited}`, 'touch walking leaves a trail');
  await openMap(); await shot('walked');
  const walked = await progress();
  assert.ok(walked.explored > initial.explored);
  const initialView = await readView();
  await tap('map-zoom-in');
  assert.ok((await readView()).zoom > initialView.zoom);
  await tap('map-zoom-out');
  assert.equal((await readView()).zoom, initialView.zoom);
  await tap('map-overview'); assert.equal((await readView()).zoom, 1);
  await shot('overview');
  await tapPoint({ x: 10, y: 190 });
  assert.equal(await evaluate('qa.store.getState().mapMarker'), null, 'outside-city tap must be ignored');
  await tapPoint({ x: 420, y: 190 });
  await until('qa.store.getState().mapMarker!==null', 'tap places destination');
  const marker = await evaluate('qa.store.getState().mapMarker');
  assert.ok(await evaluate('qa.store.getState().mapRoute.length>1'));
  assert.deepEqual(await progress(), walked, 'GPS must not discover any cells');
  await shot('destination');
  const beforePan = await readView();
  await touch('touchStart', [{ x: 370, y: 195, id: 1 }]);
  for (let i = 1; i <= 6; i++) { await touch('touchMove', [{ x: 370 + i * 10, y: 195 + i * 3, id: 1 }]); await delay(30); }
  await touch('touchEnd', []); await delay(200);
  assert.notEqual((await readView()).panX, beforePan.panX);
  assert.deepEqual(await evaluate('qa.store.getState().mapMarker'), marker, 'pan cannot mark');
  await tap('map-center'); await checkCentered();
  const beforePinch = await readView();
  await touch('touchStart', [{ x: 360, y: 195, id: 1 }, { x: 484, y: 195, id: 2 }]);
  for (let i = 1; i <= 5; i++) { await touch('touchMove', [{ x: 360 - 10 * i, y: 195, id: 1 }, { x: 484 + 10 * i, y: 195, id: 2 }]); await delay(40); }
  await touch('touchEnd', []); await delay(200);
  assert.ok((await readView()).zoom > beforePinch.zoom + 0.3, 'pinch must zoom');
  assert.deepEqual(await evaluate('qa.store.getState().mapMarker'), marker, 'pinch cannot mark');
  await checkCentered();
  assert.deepEqual(await progress(), walked, 'pan/pinch/zoom cannot reveal');
  await tap('map-clear'); assert.equal(await evaluate('qa.store.getState().mapMarker'), null);
  for (let i = 0; i < 12; i++) await tap('map-zoom-in');
  assert.equal((await readView()).zoom, 6);
  for (let i = 0; i < 12; i++) await tap('map-zoom-out');
  assert.equal((await readView()).zoom, 1);
  assert.deepEqual(await progress(), walked, 'zoom limits cannot change discoveries');
  await tap('map-center'); await shot('navigation');
  console.log('OK fresh map, real touch movement, discoveries/trail, GPS, pan, pinch, zoom limits, centering and clear');

  for (const [width, height] of [[667, 375], [844, 390], [390, 844], [1280, 720]]) {
    await viewport(width, height); await delay(350); await checkCentered();
    const boxes = await evaluate(`[...document.querySelectorAll('[data-testid^="map-"][role=button],[data-testid=full-map-close]')].map(e=>{const r=e.getBoundingClientRect();return {id:e.dataset.testid,x:r.x,y:r.y,w:r.width,h:r.height}})`);
    for (const b of boxes) {
      assert.ok(b.w >= 48 && b.h >= 48, `small ${b.id}`);
      assert.ok(b.x >= 0 && b.y >= 0 && b.x + b.w <= width && b.y + b.h <= height, `offscreen ${b.id}: ${JSON.stringify(b)}`);
    }
    await shot(`${width}x${height}`);
  }
  await viewport(844, 390); await delay(300);
  await closeMap(); await delay(250); await shot('radar');
  await evaluate(`(() => {const g=qa.g,e=g.interiors.entrances.find(e=>e.kind==='home');qa.door=e;g.player.x=e.x;g.player.y=e.y;g.wanted.clear(g.player);g.police.reset();})()`);
  await until('!!document.querySelector("[data-testid=control-interact]")', 'door action');
  await tap('control-interact'); await until('qa.g.interiors.active!==null', 'enter interior');
  const inside = await progress();
  await openMap(); await checkCentered();
  await tap('map-center'); await checkCentered();
  assert.deepEqual(await progress(), inside, 'interior map must not reveal local coordinates');
  await shot('interior'); await closeMap();
  await evaluate('qa.g.player.x=qa.g.interiors.active.exit.x;qa.g.player.y=qa.g.interiors.active.exit.y');
  await delay(400); await tap('control-interact'); await until('qa.g.interiors.active===null', 'leave room');
  await openMap(); assert.deepEqual(await progress(), inside, 'reopening must retain progress'); await closeMap();
  console.log('OK compact/portrait/desktop map targets, interior coordinates and retained discoveries');

  await evaluate('qa.store.goToMenu()'); await startGame();
  assert.ok((await progress()).explored < inside.explored, 'new game resets exploration');
  await openMap(); await checkCentered(); await shot('new-game'); await closeMap();
  await viewport(1280, 720, false);
  await send('Page.navigate', { url: 'http://localhost:8082/?map-test=desktop' });
  await until(`${PLAY_LABEL}!==null`, 'desktop menu', 120000);
  const play = await evaluate(PLAY_LABEL);
  const click = async (p) => { await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...p, button: 'left', clickCount: 1 }); await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...p, button: 'left', clickCount: 1 }); await delay(200); };
  await click(play); await until('!!document.querySelector("[data-testid=control-weapon]")', 'desktop game'); await expose();
  for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, code: 'KeyM', key: 'm', windowsVirtualKeyCode: 77 });
  await until('qa.store.getState().mapOpen', 'keyboard map'); await delay(300); await checkCentered();
  const desktop = await progress();
  await click(await center('[data-testid=map-overview]'));
  await click({ x: 670, y: 360 }); await until('qa.store.getState().mapMarker!==null', 'mouse destination');
  assert.deepEqual(await progress(), desktop);
  await shot('desktop');
  for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, code: 'Escape', key: 'Escape', windowsVirtualKeyCode: 27 });
  await until('!qa.store.getState().mapOpen', 'keyboard close');
  assert.deepEqual(errors.filter((e) => !e.includes('favicon.ico')), []);
  console.log('OK new-game reset, desktop keyboard/mouse and no browser errors');
})().catch(async (error) => {
  console.error(error); console.error('Browser errors:', errors); process.exitCode = 1;
  if (socket?.readyState === WebSocket.OPEN) { try { await shot('failure'); console.error(await evaluate('document.body.innerText')); } catch {} }
}).finally(() => socket?.close());
