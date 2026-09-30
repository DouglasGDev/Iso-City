// Browser check: entering a room frames it correctly on a phone and a desktop.
// Nothing here trusts the Node camera maths: every assertion reads the live
// GameState after the game has actually eased the camera into place.
// Run: node tools/check/check-interiors-browser.cjs
// Precisa do Expo web em :8082 e de um Chrome com --remote-debugging-port (QA_CDP_PORT, padrão 9223).
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const PORT = Number(process.env.QA_CDP_PORT || 9223);
let socket, serial = 0;
const pending = new Map(), errors = [];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Uma volta no CDP que nunca responde prende o script inteiro: toda chamada tem prazo.
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
    try { const v = await evaluate(expression); if (v) return v; } catch { /* página trocando */ }
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
  await send('Page.navigate', { url: 'about:blank' });
  await until('location.href==="about:blank"', 'clean context');
  await send('Emulation.setDeviceMetricsOverride', { width, height, screenWidth: width, screenHeight: height, deviceScaleFactor: 1, mobile });
  await send('Emulation.setTouchEmulationEnabled', { enabled: mobile, maxTouchPoints: 5 });
  await send('Page.navigate', { url: 'http://localhost:8082/' });
  // Bundle web frio leva mais de um minuto no Metro: sem margem aqui a checagem reclama do menu.
  await until(`!!document.querySelector('[data-testid="menu-new"],[data-testid="menu-play"]')
    ||!!document.body?.innerText.match(/JOGAR|NOVO JOGO/)`, 'menu', 180000);
  // O menu abre sem saber se existe save ("JOGAR") e troca para "CONTINUAR / NOVO JOGO" quando o
  // readSummary responde. Um toque no meio dessa troca cai no CONTINUAR — que está no mesmo pixel
  // — e o segundo boot herdaria o save do primeiro: a pistola já comprada, a loja sem preço.
  await delay(600);
  const menu = await evaluate(`(()=>{const b=document.querySelector('[data-testid="menu-new"]')
    ||document.querySelector('[data-testid="menu-play"]')
    ||[...document.querySelectorAll('div')].find((e)=>e.childElementCount===0&&e.textContent==='NOVO JOGO')
    ||[...document.querySelectorAll('div')].find((e)=>e.childElementCount===0&&e.textContent==='JOGAR');
    if(!b)return null;const r=b.getBoundingClientRect();
    return{cx:r.x+r.width/2,cy:r.y+r.height/2,t:b.getAttribute('data-testid')||b.textContent}})()`);
  assert.ok(menu, 'nenhum botão de jogar no menu');
  await tapPoint({ x: menu.cx, y: menu.cy }, mobile);
  console.log(`OK menu aberto por ${menu.t}`);
  await until('document.body.innerText.includes("HP 100")', 'HUD', 60000);
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

/**
 * Delegacia aberta a qualquer hora: a porta está na calçada da esquadra, o plantão é de
 * farda e o balcão cobra a fiança pelas estrelas do registro. Nada aqui chama o sistema
 * por trás — é o mesmo interact que o botão da tela enfileira.
 */
async function bailPass(tag) {
  const door = await evaluate(`(()=>{const g=qa.g,e=g.interiors.entrances.find(e=>e.kind==='precinct');
    if(!e)return null;const p=g.player;p.x=e.x;p.y=e.y;p.vx=p.vy=0;p.money=5000;p.wantedLevel=0;
    g.camera.x=e.x;g.camera.y=e.y;g.notifyEntityChange();return{label:e.label,x:e.x,y:e.y}})()`);
  assert.ok(door, 'a cidade tem delegacia com porta na calçada');
  assert.equal(door.label, 'Delegacia');
  // Na calçada, de frente para a porta, o recado tem de ser o nome da esquadra.
  await delay(400);
  assert.equal(await evaluate('qa.g.interiors.prompt(qa.g.player)'), 'Delegacia', 'a porta não anuncia a delegacia');
  await evaluate('qa.g.wanted.raise(qa.g.player,3)');
  await delay(300);
  assert.equal(await evaluate('qa.g.player.wantedLevel'), 3, 'o registro abriu antes de entrar');
  await evaluate('qa.input.interactQueued=true');
  await until(`(()=>qa.g.interiors.active&&qa.g.interiors.active.kind==='precinct')()`, 'a porta da delegacia abre', 6000);
  const cast = await evaluate(`(()=>{const c=qa.g.crowd;return{dentro:c.inside,
    farda:c.list.filter((o)=>o.kind==='cop').length,civis:c.list.filter((o)=>o.kind==='civ').length}})()`);
  assert.ok(cast.dentro && cast.farda >= 2, `a delegacia tem oficiais de plantão (${JSON.stringify(cast)})`);
  assert.ok(cast.civis >= 1, 'tem cidadão na sala de espera');
  await evaluate(`(()=>{const g=qa.g,s=g.interiors.active.service;g.player.x=s.x;g.player.y=s.y;g.notifyEntityChange();})()`);
  await delay(400);
  assert.equal(await evaluate('qa.g.interiors.prompt(qa.g.player)'), 'Pagar fiança · $180',
    'o balcão tem de mostrar o preço das estrelas que o jogador tem');
  await screenshot(`interiors-${tag}-delegacia`);
  await evaluate('qa.input.interactQueued=true');
  await until('qa.g.player.wantedLevel===0', 'a fiança limpou o registro', 6000);
  const paid = await evaluate(`(()=>{const g=qa.g;return{money:g.player.money,msg:g.interiors.message,
    dentro:g.interiors.active.kind}})()`);
  assert.equal(paid.money, 5000 - 180, `a fiança cobra por estrela (${paid.money})`);
  assert.equal(paid.msg, 'Fiança paga');
  assert.equal(paid.dentro, 'precinct', 'pagar não põe o jogador na rua');
  await until('qa.g.police.searchArea===null', 'a caçada acaba com o registro limpo', 6000);
  // O recado do balcão demora 2,4 s de jogo a sumir: é ele, não o relógio do node.
  await until('qa.g.interiors.message===""', 'o recado do balcão apagou', 8000);
  assert.equal(await evaluate('qa.g.interiors.prompt(qa.g.player)'), 'Balcão de atendimento',
    'sem registro o balcão só atende');
  await evaluate(`(()=>{const g=qa.g;g.player.x=g.interiors.active.exit.x;g.player.y=g.interiors.active.exit.y;g.notifyEntityChange();})()`);
  await delay(600);
  await evaluate('qa.input.interactQueued=true');
  await until('!qa.g.interiors.active', 'a delegacia devolve a rua', 6000);
  const back = await evaluate(`Math.hypot(qa.g.player.x-${door.x},qa.g.player.y-${door.y}).toFixed(2)`);
  assert.ok(Number(back) < 0.2, `a porta devolve o jogador na calçada da esquadra (${back})`);
  assert.equal(await evaluate('qa.g.activeMap===qa.g.map'), true);
  console.log(`OK delegacia aberta em ${tag}: porta na calçada, ${cast.farda} oficiais, fiança de $180 paga e registro limpo`);
}

/**
 * Uma exceção repetida a cada frame gera megabytes de stack idêntica e não diz nada.
 * Guardamos uma assinatura (mensagem + arquivo do topo) e contamos as repetições, para
 * o checkpoint dizer o QUE quebrou e em QUAL etapa, não quantas vezes o mesmo frame girou.
 */
const seen = new Map();
let reported = 0;
function noteError(text) {
  const lines = String(text).split('\n').map((l) => l.trim()).filter(Boolean);
  const where = (lines[1] || '').replace(/^at\s+/, '').split('/').pop().split('?')[0];
  const sig = where ? `${lines[0]}  (${where})` : lines[0];
  const hit = seen.get(sig);
  if (hit) hit.count++;
  else { seen.set(sig, { count: 1 }); errors.push(sig); }
}
function checkpointErrors(label) {
  for (const sig of errors.slice(reported)) console.log(`  ! ${label}: ${seen.get(sig).count}x ${sig}`);
  reported = errors.length;
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
  const pages = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = pages.find((p) => p.type === 'page');
  assert.ok(page, `nenhum alvo CDP na porta ${PORT}`);
  socket = new WebSocket(page.webSocketDebuggerUrl);
  socket.onmessage = ({ data }) => {
    const m = JSON.parse(data);
    if (m.id) {
      const p = pending.get(m.id); if (!p) return; pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    } else if (m.method === 'Runtime.exceptionThrown') {
      noteError(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    }
  };
  // Um alvo velho travado no renderer nunca abre o socket: sem prazo aqui o script congela.
  await Promise.race([
    new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; }),
    delay(20000).then(() => { throw new Error(`sem alvo CDP na porta ${PORT}`); }),
  ]);
  await send('Page.enable');
  await send('Runtime.enable');

  await boot(844, 390, true);
  checkpointErrors('abertura no celular');
  for (const kind of ['home', 'shop', 'office', 'precinct']) await roomPass(kind, 'phone');
  checkpointErrors('salas do celular');
  await bailPass('phone');
  checkpointErrors('delegacia no celular');
  await counterPass('armaria', 'phone', true);
  await counterPass('pizza', 'phone', true);
  checkpointErrors('balcões do celular');
  await boot(1440, 900, false);
  checkpointErrors('abertura no desktop');
  for (const kind of ['home', 'shop']) await roomPass(kind, 'desktop');
  checkpointErrors('salas do desktop');
  await counterPass('armaria', 'desktop', false);
  checkpointErrors('balcão do desktop');

  assert.deepEqual(errors, [], `page errors: ${errors.join('\n')}`);
  console.log('OK interiors framed and escapable on phone and desktop, delegacia aberta com fiança, counters sell, no page errors');
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
