// Browser check: a cadeia jogada de ponta a ponta no aparelho — cela, guarda, chaves, fuga, painel, rua.
// Nada aqui chama JailSystem por trás da interface: quem apanha, pega as chaves e abre a
// grade é o mesmo laço de update que o dedo do jogador move.
// Toda posição vem da planta viva (`src/data/jail`, exportada pelo bundle como `qa.plano`) e do
// alcance vivo (`GAME_CONFIG`): se a cela mudar, a checagem muda junto em vez de cobrar um mapa velho.
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
  await send('Emulation.setTouchEmulationEnabled', mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
  await send('Page.navigate', { url: 'http://localhost:8082/' });
  // Navegar reaplica o override da aba: reafirmar, senão o desktop herda o toque e perde o teclado.
  await send('Emulation.setTouchEmulationEnabled', mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
  await until('!!document.body?.innerText.match(/JOGAR|NOVO JOGO/)', 'menu', 90000);
  await tapPoint(await evaluate(`(()=>{const e=[...document.querySelectorAll('div')].find(e=>e.childElementCount===0&&(e.textContent==='JOGAR'||e.textContent==='NOVO JOGO'));
    const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`));
  await until('document.body.innerText.includes("HP 100")', 'HUD');
  await evaluate(`(()=>{const m=[...__r.getModules().values()].filter(x=>x.isInitialized).map(x=>x.publicModule.exports);
    globalThis.qa={g:m.find(x=>x?.getGame).getGame(),input:m.find(x=>x?.inputState).inputState,
      plano:m.find(x=>x?.JAIL_FRONT_Y!==undefined),cfg:m.find(x=>x?.GAME_CONFIG)?.GAME_CONFIG};})()`);
  assert.ok(await evaluate('!!qa.plano && !!qa.cfg'), 'the jail plan and GAME_CONFIG must be reachable in the bundle');
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
  await require('./bundle-identity.cjs').attach(socket, send);
  await send('Runtime.enable');

  for (const [tag, width, height, mobile] of [['phone', 844, 390, true], ['desktop', 1440, 900, false]]) {
    await boot(width, height, mobile);
    assert.equal(await evaluate('qa.g.jail.constructor.name'), 'JailSystem', `${tag}: the live game must own the jail system`);
    const plan = await evaluate(`({w:qa.plano.JAIL_W,h:qa.plano.JAIL_H,barreiras:qa.plano.JAIL_FRONT_Y,
      cela:qa.plano.JAIL_CELLS[0],spawn:qa.plano.JAIL_CELL_SPAWN,posto:qa.plano.JAIL_PATROL[0],
      painel:qa.plano.JAIL_PANEL,patio:qa.plano.JAIL_SPAWN,alcance:qa.cfg.ATTACK_RANGE,
      presos:qa.plano.JAIL_INMATES.length})`);
    // Encostado na grade, do lado de dentro: meio tile é folga suficiente para o raio do
    // jogador não ser empurrado pelo batente e para o guarda da ronda entrar no alcance do soco.
    const barras = { x: (plan.cela.gateX0 + plan.cela.gateX1) / 2, y: plan.barreiras - 0.25 };

    // Ser pego: o PRESO aparece, a cela fecha e o relógio da pena entra no HUD.
    await evaluate('(()=>{const p=qa.g.player;p.wantedLevel=3;p.money=900;p.health=100;qa.g.bust();})()');
    await until('qa.g.jail.locked && qa.g.interiors.active?.kind === "jail"', `${tag}: bust must land inside the cell`, 8000);
    assert.ok((await evaluate('document.body.innerText')).includes('PRESO'), `${tag}: the busted card must say PRESO`);
    assert.ok((await evaluate('document.body.innerText')).includes('cela'), `${tag}: the busted card must explain the sentence`);
    assert.equal(await evaluate('qa.g.player.wantedLevel'), 0, `${tag}: being locked up clears the hunt`);
    const acordado = await evaluate('({x:qa.g.player.x,y:qa.g.player.y})');
    assert.ok(acordado.y < plan.barreiras, `${tag}: the prisoner wakes behind the bars`);
    assert.ok(acordado.x >= plan.cela.x0 && acordado.x <= plan.cela.x1, `${tag}: the prisoner wakes in his own cell`);
    await delay(2900);
    assert.match((await evaluate('document.body.innerText')).replace(/\s+/g, ' '), /CADEIA · \d+s/,
      `${tag}: the HUD must count the sentence down`);
    await screenshot(`jail-${tag}-cell`);

    // Na grade: a dica avisa que está trancada e o guarda ronda em frente à cela.
    const room = await evaluate('(()=>{const r=qa.g.interiors.active;return {w:r.map.worldW,h:r.map.worldH}})()');
    assert.ok(room.w === plan.w && room.h === plan.h, `${tag}: the jail room is the size the plan declares`);
    assert.match((await evaluate('qa.g.interiors.message')) ?? '', /Preso · \d+ s/,
      `${tag}: entering the cell announces the sentence`);
    // Congela a pena para o teste não abrir a cela sozinho, e retira o aviso de entrada
    // para que a grade volte a falar.
    await evaluate('qa.g.jail.sentenceLeft = 999; qa.g.interiors.message = null; qa.g.interiors.messageLeft = 0');
    await goTo(barras.x, barras.y, 1100);
    await evaluate(`qa.g.player.facingAngle = Math.atan2(${plan.posto.y} - ${barras.y}, ${plan.posto.x} - ${barras.x})`);
    assert.match((await evaluate('qa.g.interiors.prompt(qa.g.player)')) ?? '', /cela trancada · \d+ s/i,
      `${tag}: at the bars the prompt tells the sentence`);
    await screenshot(`jail-${tag}-bars`);
    assert.equal(await evaluate('qa.g.jail.keysHeld'), false, `${tag}: no keys yet`);
    await until(`(()=>{const o=qa.g.jail.occupants.find(o=>o.cell===-1);
      return o && Math.hypot(o.x-${plan.posto.x},o.y-${plan.posto.y})<0.3})()`,
      `${tag}: the patrol must come to the cell`, 60000);

    // Soco pela grade: o alcance é o do jogo, não um atalho do teste — quem mede a janela
    // é GAME_CONFIG.ATTACK_RANGE e quem decide se a barra deixa o soco passar é o trace dele.
    const alcance = plan.alcance - 0.02;
    await until(`(()=>{const g=qa.g,o=g.jail.occupants.find(o=>o.cell===-1);
      if(!o||o.downTimer>0)return true;g.player.x=${barras.x};g.player.y=${barras.y};
      g.player.facingAngle=Math.atan2(o.y-${barras.y},o.x-${barras.x});
      if(Math.hypot(o.x-${barras.x},o.y-${barras.y})<${alcance})qa.input.attackQueued=true;
      return false})()`, `${tag}: the guard must go down through the bars`, 60000);
    const chaves = await evaluate('qa.g.jail.keysOnFloor && {x:qa.g.jail.keysOnFloor.x,y:qa.g.jail.keysOnFloor.y}');
    assert.ok(chaves, `${tag}: a knocked guard drops the keys`);
    assert.ok(chaves.y < plan.barreiras && chaves.x >= plan.cela.x0 && chaves.x <= plan.cela.x1,
      `${tag}: the keys land on the prisoner's side of the bars`);
    await goTo(chaves.x, chaves.y, 700);
    assert.ok(await evaluate('qa.g.jail.keysHeld'), `${tag}: walking over the keys picks them up`);
    assert.ok((await evaluate('document.body.innerText')).includes('chaves'), `${tag}: the game says the keys are held`);

    // Arrombar a própria cela é fuga — e fuga silenciosa, até o guarda enxergar o preso solto.
    await goTo(barras.x, barras.y, 400);
    await evaluate('qa.input.interactQueued=true');
    await delay(500);
    assert.equal(await evaluate('qa.g.jail.gates[0]'), true, `${tag}: the unlocked gate stays open`);
    assert.equal(await evaluate('qa.g.jail.locked'), false, `${tag}: breaking out ends the sentence`);
    assert.equal(await evaluate('qa.g.jail.atLarge'), true, `${tag}: the prisoner is loose inside`);
    assert.ok(await evaluate('qa.g.player.wantedLevel') > 0, `${tag}: escaping is a crime`);
    assert.ok(await evaluate(`(()=>{const g=qa.g;return g.activeMap===g.interiors.active.map})()`),
      `${tag}: the cell is still the live map`);
    // Sair de cima da grade: acordar o guarda com o preso na sua frente é contenção, não empate.
    await goTo(plan.patio.x, plan.patio.y, 250);

    // O painel solta a casa inteira e os presos correm para a rua.
    await goTo(plan.painel.x, plan.painel.y, 350);
    await evaluate('qa.input.interactQueued=true');
    await delay(600);
    assert.equal(await evaluate('qa.g.jail.gates.every((o)=>o)'), true, `${tag}: the panel opens every cell`);
    assert.ok(await evaluate('qa.g.jail.occupants.filter((o)=>o.cell>=0).every((o)=>o.free)'), `${tag}: the inmates are loose`);
    assert.ok(await evaluate('qa.g.jail.alarm'), `${tag}: opening the panel raises the alarm`);
    assert.ok((await evaluate('document.body.innerText')).includes('presos soltos'), `${tag}: the panel counts who left`);
    await screenshot(`jail-${tag}-break`);
    const naRua = await evaluate('qa.g.npcs.length');
    await until(`qa.g.npcs.length >= ${naRua + plan.presos}`, `${tag}: every freed inmate must reach the sidewalk`, 30000);

    // E a porta da rua continua sendo a saída da cadeia.
    await goTo(await evaluate('qa.g.interiors.active.exit.x'), await evaluate('qa.g.interiors.active.exit.y'), 700);
    await evaluate('qa.input.interactQueued=true');
    await delay(700);
    assert.equal(await evaluate('qa.g.interiors.active'), null, `${tag}: the door leads out`);
    assert.equal(await evaluate('qa.g.activeMap === qa.g.map'), true, `${tag}: the street is the live map again`);
    assert.equal(await evaluate('qa.g.jail.inside'), false, `${tag}: the cell stops blocking outdoors`);
    assert.ok(await evaluate(`(()=>{const g=qa.g,d=g.interiors.jailEntrance;
      return Math.hypot(g.player.x-d.x,g.player.y-d.y)<1})()`), `${tag}: out through the station door`);
    console.log(`OK cadeia no ${tag}: cela ${plan.w}×${plan.h}, guarda no posto, chaves pela grade, fuga com estrela, painel com alarme e a rua de novo`);
    assert.deepEqual(errors, [], `page errors: ${errors.join('\n')}`);
  }
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
