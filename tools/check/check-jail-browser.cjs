// Browser check: a cadeia jogada de ponta a ponta no aparelho — cela, guarda, chaves, fuga, rua.
// Nada aqui chama JailSystem por trás da interface: quem apanha, pega as chaves e abre a
// grade é o mesmo laço de update que o dedo do jogador move.
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
const tapPoint = async (p) => {
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...p, id: 1 }] });
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
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
    const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`));
  await until('document.body.innerText.includes("HP 100")', 'HUD');
  await evaluate(`(()=>{const m=[...__r.getModules().values()].filter(x=>x.isInitialized).map(x=>x.publicModule.exports);
    globalThis.qa={g:m.find(x=>x?.getGame).getGame(),input:m.find(x=>x?.inputState).inputState};})()`);
}

/** Põe o jogador num ponto da sala e deixa a câmera chegar até ele. */
async function goTo(x, y, settle = 1200) {
  await evaluate(`(()=>{const g=qa.g;g.player.x=${x};g.player.y=${y};g.player.vx=0;g.player.vy=0;g.notifyEntityChange();})()`);
  await delay(settle);
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

  for (const [tag, width, height, mobile] of [['phone', 844, 390, true], ['desktop', 1440, 900, false]]) {
    await boot(width, height, mobile);
    assert.equal(await evaluate('qa.g.jail.constructor.name'), 'JailSystem', `${tag}: the live game must own the jail system`);

    // Ser pego: o PRESO aparece, a cela fecha e o relógio da pena entra no HUD.
    await evaluate('(()=>{const p=qa.g.player;p.wantedLevel=3;p.money=900;p.health=100;qa.g.bust();})()');
    await until('qa.g.jail.locked && qa.g.interiors.active?.kind === "jail"', `${tag}: bust must land inside the cell`, 8000);
    assert.ok((await evaluate('document.body.innerText')).includes('PRESO'), `${tag}: the busted card must say PRESO`);
    assert.ok((await evaluate('document.body.innerText')).includes('cela'), `${tag}: the busted card must explain the sentence`);
    assert.equal(await evaluate('qa.g.player.wantedLevel'), 0, `${tag}: being locked up clears the hunt`);
    await until('qa.g.player.y < 3.3', `${tag}: the prisoner starts behind the bars`);
    await delay(2900);
    assert.match((await evaluate('document.body.innerText')).replace(/\s+/g, ' '), /CADEIA · \d+s/,
      `${tag}: the HUD must count the sentence down`);
    await screenshot(`jail-${tag}-cell`);

    // Na grade: a dica avisa que está trancada e o guarda ronda em frente à cela.
    const room = await evaluate('(()=>{const r=qa.g.interiors.active;return {w:r.map.worldW,h:r.map.worldH}})()');
    assert.ok(room.w === 12 && room.h === 8, `${tag}: the jail room is the one the map declares`);
    assert.match((await evaluate('qa.g.interiors.message')) ?? '', /Preso · \d+ s/,
      `${tag}: entering the cell announces the sentence`);
    // Congela a pena para o teste não abrir a cela sozinho, e retira o aviso de entrada
    // para que a grade volte a falar.
    await evaluate('qa.g.jail.sentenceLeft = 999; qa.g.interiors.message = null; qa.g.interiors.messageLeft = 0');
    await goTo(2.15, 3.13, 1100);
    await evaluate('qa.g.player.facingAngle = Math.PI/2');
    assert.match((await evaluate('qa.g.interiors.prompt(qa.g.player)')) ?? '', /cela trancada · \d+ s/i,
      `${tag}: at the bars the prompt tells the sentence`);
    await screenshot(`jail-${tag}-bars`);
    assert.equal(await evaluate('qa.g.jail.keysHeld'), false, `${tag}: no keys yet`);
    await until(`(()=>{const o=qa.g.jail.occupants.find(o=>o.cell===-1);
      return o && Math.hypot(o.x-2.15,o.y-3.9)<0.12})()`, `${tag}: the guard must come to the cell`);

    // Soco pela grade: o alcance é o do jogo, não um atalho do teste.
    await until(`(()=>{const g=qa.g,o=g.jail.occupants.find(o=>o.cell===-1);
      if(!o||o.downTimer>0)return true;g.player.x=2.15;g.player.y=3.13;g.player.facingAngle=Math.PI/2;
      qa.input.attackQueued=true;return false})()`, `${tag}: the guard must go down through the bars`, 12000);
    assert.ok(await evaluate('qa.g.jail.keysOnFloor'), `${tag}: a knocked guard drops the keys`);
    assert.ok(await evaluate('qa.g.jail.keysOnFloor.y < 3.3'), `${tag}: the keys land on the prisoner's side`);
    await goTo(await evaluate('qa.g.jail.keysOnFloor.x'), await evaluate('qa.g.jail.keysOnFloor.y'), 700);
    assert.ok(await evaluate('qa.g.jail.keysHeld'), `${tag}: walking over the keys picks them up`);
    assert.ok((await evaluate('document.body.innerText')).includes('chaves'), `${tag}: the game says the keys are held`);

    // Arrombar a própria cela é fuga: estrela nova e alarme.
    await goTo(2.15, 3.13, 500);
    await evaluate('qa.input.interactQueued=true');
    await delay(500);
    assert.equal(await evaluate('qa.g.jail.gates[0]'), true, `${tag}: the unlocked gate stays open`);
    assert.equal(await evaluate('qa.g.jail.locked'), false, `${tag}: breaking out ends the sentence`);
    assert.ok(await evaluate('qa.g.player.wantedLevel') > 0, `${tag}: escaping is a crime`);
    assert.ok(await evaluate('qa.g.jail.alarm'), `${tag}: the alarm brings the guard down`);
    assert.ok(await evaluate(`(()=>{const g=qa.g;return g.activeMap===g.interiors.active.map})()`),
      `${tag}: the cell is still the live map`);

    // O painel solta a casa inteira e os presos correm para a rua.
    await goTo(10.9, 5.4, 900);
    await evaluate('qa.input.interactQueued=true');
    await delay(600);
    assert.equal(await evaluate('qa.g.jail.gates.every((o)=>o)'), true, `${tag}: the panel opens every cell`);
    assert.ok(await evaluate('qa.g.jail.occupants.filter((o)=>o.cell>=0).every((o)=>o.free)'), `${tag}: the inmates are loose`);
    assert.ok((await evaluate('document.body.innerText')).includes('presos soltos'), `${tag}: the panel counts who left`);
    await screenshot(`jail-${tag}-break`);
    const onTheStreet = await evaluate('qa.g.npcs.length');
    await until('qa.g.npcs.length > ' + onTheStreet, `${tag}: freed inmates must reach the sidewalk`, 25000);

    // E a porta da rua continua sendo a saída da cadeia.
    await goTo(await evaluate('qa.g.interiors.active.exit.x'), await evaluate('qa.g.interiors.active.exit.y'), 900);
    await evaluate('qa.input.interactQueued=true');
    await delay(700);
    assert.equal(await evaluate('qa.g.interiors.active'), null, `${tag}: the door leads out`);
    assert.equal(await evaluate('qa.g.activeMap === qa.g.map'), true, `${tag}: the street is the live map again`);
    assert.equal(await evaluate('qa.g.jail.inside'), false, `${tag}: the cell stops blocking outdoors`);
    assert.ok(await evaluate(`(()=>{const g=qa.g,d=g.interiors.jailEntrance;
      return Math.hypot(g.player.x-d.x,g.player.y-d.y)<1})()`), `${tag}: out through the station door`);
    console.log(`OK cadeia no ${tag}: cela, guarda, chaves, fuga com estrela, painel e a rua de novo`);
    assert.deepEqual(errors, [], `page errors: ${errors.join('\n')}`);
  }
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
