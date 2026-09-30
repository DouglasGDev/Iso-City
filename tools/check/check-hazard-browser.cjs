// Run: node tools/check/check-hazard-browser.cjs (precisa do Expo web em :8082 e Chrome em :9223).
// Tornado, furacão e tsunami no canvas real: aviso na HUD, arrasto, leito de áudio e névoa.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const PORT = Number(process.env.QA_CDP_PORT || 9223);
let socket, serial = 0;
const pending = new Map(), errors = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
// Toda volta ao CDP tem prazo: uma chamada presa no renderer congela a checagem inteira.
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
    // Durante a navegação o contexto morre no meio da checagem: conta como ainda não pronto.
    try { const v = await evaluate(expression); if (v) return v; } catch { /* página trocando */ }
    await delay(60);
  }
  throw new Error('Timed out: ' + label);
}
async function screenshot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.resolve(__dirname, '../tmp/' + name + '.png'), Buffer.from(data, 'base64'));
}
async function launch() {
  await send('Page.navigate', { url: 'about:blank' });
  await send('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 1, mobile: true });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await send('Page.navigate', { url: 'http://localhost:8082/?hazard-qa=1' });
  await until(`!!document.querySelector('[data-testid="menu-new"],[data-testid="menu-play"]')
    ||!!document.body?.innerText.match(/JOGAR|NOVO JOGO/)`, 'menu', 180000);
  // O menu troca "JOGAR" por "CONTINUAR / NOVO JOGO" quando o save é lido: no mesmo pixel, um
  // toque apressado continua o jogo salvo em vez de abrir um mundo novo.
  await delay(600);
  const p = await evaluate(`(()=>{const b=document.querySelector('[data-testid="menu-new"]')
    ||document.querySelector('[data-testid="menu-play"]');
    if(!b)return null;const r=b.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  assert.ok(p, 'nenhum botão de jogar no menu');
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...p, id: 1 }] });
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await until('document.body.innerText.includes("HP 100")', 'HUD', 60000);
  await evaluate(`(()=>{const m=[...__r.getModules().values()].filter(m=>m.isInitialized).map(m=>m.publicModule.exports);
    globalThis.qa={g:m.find(m=>m?.getGame).getGame()};
    qa.g.player.invulnUntil=Infinity;
    qa.g.dayNight.t=.5;
    // Nada nasce sorteado no meio da cena: o sorteio roda só no teste que pede isso.
    qa.g.hazard.cooldown=1e9;
    qa.g.weather.checkTimer=1e9;
  })()`);
}
/** O perigo agora, do ponto de vista da tela, do áudio e da névoa. */
const read = () => evaluate(`(()=>{const g=qa.g,h=g.hazard,s=g.fog.snapshot,
  v=g.fog.view({camera:g.camera,viewW:g.viewW,viewH:g.viewH});
  return {kind:h.kind,phase:h.phase,strength:+h.strength.toFixed(3),alert:h.alert,bed:h.bed,
    bedVolume:+h.bedVolume.toFixed(3),wet:+h.wet.toFixed(3),dark:+h.dark.toFixed(3),slant:+h.slant.toFixed(3),
    vortex:{x:+h.vortex.x.toFixed(2),y:+h.vortex.y.toFixed(2),r:+h.vortex.radius.toFixed(2)},
    reach:+h.wave.reach.toFixed(2),from:+h.wave.from.toFixed(2),edge:+h.wave.edge.toFixed(2),
    dir:h.wave.dir,axis:h.wave.axis,u0:+h.wave.u0.toFixed(2),u1:+h.wave.u1.toFixed(2),
    player:{x:+g.player.x.toFixed(2),y:+g.player.y.toFixed(2)},
    rain:+g.weather.intensity.toFixed(3),sentBed:g.ambient.sentBed,sentRain:g.ambient.sentRain,
    clarity:+s.clarity.toFixed(3),view:[Math.round(v.radiusX),Math.round(v.radiusY)].join('x'),
    hud:document.body.innerText}})()`);
/** Leva o player para um tile aberto do bioma e para a câmera ali. */
async function teleport(biome) {
  const at = await evaluate(`(()=>{const g=qa.g;
    const bad=(x,y)=>g.map.data.buildings.some(b=>Math.hypot(b.x-x,b.y-y)<3.5);
    const i=g.map.data.tiles.findIndex((t,i)=>t.biome===${JSON.stringify(biome)}
      &&['grass','dirt','sand','concrete'].includes(t.kind)&&!bad(i%g.map.data.tilesW+.5,Math.floor(i/g.map.data.tilesW)+.5));
    if(i<0)throw new Error('Nenhum tile aberto em ${biome}');
    const x=i%g.map.data.tilesW+.5,y=Math.floor(i/g.map.data.tilesW)+.5;
    g.player.x=x;g.player.y=y;g.camera.x=x;g.camera.y=y;g.notifyEntityChange();
    return {x,y}})()`);
  await delay(1500);
  return at;
}
/** Põe o player num tile aberto do ponto pedido; false = ali não dá para ficar. */
async function standAt(x, y) {
  return await evaluate(`(()=>{const g=qa.g,d=g.map.data;
    const t=d.tiles[Math.floor(${y})*d.tilesW+Math.floor(${x})];
    if(!t||!['grass','dirt','sand','concrete'].includes(t.kind))return false;
    if(d.buildings.some(b=>Math.hypot(b.x-${x},b.y-${y})<3.5))return false;
    g.player.x=${x};g.player.y=${y};g.camera.x=${x};g.camera.y=${y};g.notifyEntityChange();return true})()`);
}
/** Onde um ponto do mundo cai na tela de 844x390, com o zoom da câmera. */
async function screenOf(x, y) {
  return await evaluate(`(()=>{const g=qa.g,c=g.camera;
    return {x:(((${x})-(${y}))*64-(c.x-c.y)*64)*c.zoom+422,
      y:(((${x})+(${y}))*32-(c.x+c.y)*32)*c.zoom+195}})()`);
}
const away = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('OK ' + name); }
  catch (error) { failed++; console.error('FAIL ' + name + '\n' + error.stack); }
}
(async () => {
  const pages = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = pages.find(p => p.type === 'page');
  assert.ok(page, `nenhum alvo CDP na porta ${PORT}`);
  socket = new WebSocket(page.webSocketDebuggerUrl);
  socket.onmessage = ({ data }) => {
    const m = JSON.parse(data);
    if (m.id) { const p = pending.get(m.id); if (!p) return; pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errors.push(m.params.entry.text);
  };
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = () => reject(new Error('CDP falhou')); });
  await send('Runtime.enable'); await send('Page.enable'); await send('Log.enable');

  await launch();
  await test('o jogo abre em tempo normal, sem perigo na tela', async () => {
    const calm = await read();
    assert.equal(calm.kind, null, 'o jogo já abriu com perigo');
    assert.equal(calm.phase, 'calm');
    assert.equal(calm.alert, null);
    assert.equal(calm.bed, null);
    assert.equal(calm.strength, 0);
    assert.ok(!calm.hud.includes('PERIGO'), 'faixa de perigo em céu limpo');
  });

  await test('o tornado fecha o céu, ruge no canal do tempo e arrasta o player', async () => {
    await teleport('residential');
    const base = await read();
    await evaluate('qa.g.hazard.force("tornado",40);'
      + 'qa.g.hazard.vortex.x=qa.g.player.x+1.6;qa.g.hazard.vortex.y=qa.g.player.y');
    await delay(6000);
    const h = await read();
    assert.equal(h.kind, 'tornado');
    assert.equal(h.phase, 'active');
    assert.ok(h.strength > 0.8, `funil fraco ${h.strength}`);
    assert.equal(h.alert, 'PERIGO · TORNADO');
    assert.ok(h.hud.includes('PERIGO · TORNADO'), 'a HUD sem a faixa de perigo');
    assert.equal(h.bed, 'tornado');
    assert.ok(h.bedVolume > 0.3 && h.bedVolume <= 1, `volume do leito ${h.bedVolume}`);
    assert.equal(h.sentBed, 'tornado', `o canal do tempo tocou ${h.sentBed}`);
    assert.ok(h.vortex.r > 3, `raio do funil ${h.vortex.r}`);
    assert.ok(h.dark > 0.05, 'o tornado não fechou o céu');
    assert.ok(away(h.player, base.player) > 2, `o funil não arrastou o player (${away(h.player, base.player).toFixed(2)} tiles)`);
    assert.ok(h.clarity < base.clarity, 'a névoa não fechou com o perigo');
    assert.equal(h.view, base.view, 'o perigo moveu a área de corte da névoa');
    // O funil anda pelo mapa e pode sair da tela: puxa ele de volta para a foto.
    await evaluate('const h=qa.g.hazard;h.vortex.x=qa.g.player.x+1.2;h.vortex.y=qa.g.player.y-0.6;');
    await delay(900);
    await screenshot('qa-hazard-tornado');
    await evaluate('qa.g.hazard.left=0.4');
    await delay(6000);
    const after = await read();
    assert.equal(after.kind, null, 'o tornado não acabou');
    assert.equal(after.bed, null, 'o funil não devolveu o canal do tempo');
    assert.equal(after.sentBed, 'rain', `o leito depois do perigo é ${after.sentBed}`);
    assert.ok(Math.abs(after.clarity - base.clarity) < 0.01,
      `a visibilidade não voltou (base ${base.clarity}, agora ${after.clarity})`);
    assert.ok(!after.hud.includes('PERIGO'), 'a faixa de perigo ficou na tela');
  });

  await test('o furacão deita a chuva pesada sem abrir um segundo leito', async () => {
    const base = await read();
    await evaluate('qa.g.weather.force("rain",3600);qa.g.hazard.force("hurricane",30)');
    await delay(7000);
    const h = await read();
    assert.equal(h.kind, 'hurricane');
    assert.equal(h.alert, 'PERIGO · FURACÃO');
    assert.ok(h.hud.includes('PERIGO · FURACÃO'), 'a HUD sem o furacão');
    assert.equal(h.bed, null, 'o furacão abriu leito próprio em cima da chuva');
    assert.ok(h.rain > 0.4, `a frente de chuva não abriu (${h.rain})`);
    assert.ok(h.wet > 0.1, `o furacão não molhou nada (${h.wet})`);
    assert.ok(Math.abs(h.slant) > 0.2, `a chuva não deitou (slant ${h.slant})`);
    assert.ok(h.dark > 0.05, 'o furacão não escureceu o céu');
    assert.equal(h.sentBed, 'rain', `o leito pedido foi ${h.sentBed}`);
    assert.ok(h.sentRain > 0.2, `o leito embedado ficou muda (${h.sentRain})`);
    assert.ok(h.clarity < 0.55, `visibilidade ${h.clarity} com furacão`);
    await screenshot('qa-hazard-hurricane');
    await evaluate('qa.g.hazard.left=0.4;qa.g.weather.force("clear",1)');
    await delay(9000);
    const dry = await read();
    assert.equal(dry.kind, null);
    assert.equal(dry.slant, 0, 'a chuva continuou torta sem o furacão');
    assert.equal(dry.sentRain, 0, 'a cena não secou depois do perigo');
  });

  await test('o tsunami sobe da costa na frente do player e volta sozinho', async () => {
    await evaluate('qa.g.hazard.force("tsunami",30)');
    const probe = await read();
    assert.equal(probe.kind, 'tsunami');
    assert.ok(probe.axis === 'x' || probe.axis === 'y', `eixo ${probe.axis}`);
    // A onda pode nascer na praia do outro lado do mapa: o teste vai para onde ela está.
    const along = (probe.u0 + probe.u1) / 2;
    let spot = null;
    let stood = false;
    for (const step of [5, 8, 3, 12, 16, 22]) {
      for (let k = 0; k < 11 && !stood; k++) {
        const u = along + (k % 2 ? -1 : 1) * Math.ceil(k / 2) * 3;
        const inland = probe.from + probe.dir * step;
        const x = probe.axis === 'y' ? u : inland;
        const y = probe.axis === 'y' ? inland : u;
        stood = await standAt(x, y);
        spot = { x: +x.toFixed(1), y: +y.toFixed(1), step, u: +u.toFixed(1) };
      }
      if (stood) break;
    }
    assert.ok(stood, `não havia onde ficar na praia da onda: ${JSON.stringify(spot)} de ${JSON.stringify(probe)}`);
    await delay(1500);
    const base = await read();
    await evaluate('qa.g.hazard.cooldown=1e9;qa.g.hazard.force("tsunami",24)');
    await delay(4000);
    const up = await read();
    assert.equal(up.kind, 'tsunami');
    assert.equal(up.alert, 'PERIGO · TSUNAMI');
    assert.ok(up.hud.includes('PERIGO · TSUNAMI'), 'a HUD sem o tsunami');
    assert.equal(up.bed, 'wave');
    assert.equal(up.sentBed, 'wave', `o mar não tomou o canal do tempo (${up.sentBed})`);
    assert.ok(up.wet > 0.2, `a onda não molhou (${up.wet})`);
    // 4s a 5.5 tiles/s estouram o teto de subida: a onda encosta no limite, não atravessa o mapa.
    assert.ok(up.reach > 3 && up.reach <= 12.5, `a água subiu ${up.reach} tiles da costa`);
    assert.equal(up.axis, probe.axis, 'a onda trocou de eixo ao recentrar na câmera');
    const mid = (up.u0 + up.u1) / 2;
    const crest = await screenOf(up.axis === 'y' ? mid : up.edge, up.axis === 'y' ? up.edge : mid);
    assert.ok(crest.x > -40 && crest.x < 884 && crest.y > -40 && crest.y < 430,
      `a crista passou fora da tela (${Math.round(crest.x)}, ${Math.round(crest.y)})`);
    assert.ok(away(up.player, base.player) > 1, 'a onda não arrastou o player');
    await screenshot('qa-hazard-tsunami');
    // Vida de 24s + retirada: a onda tem que voltar para o mar sozinha.
    await delay(24000);
    const back = await read();
    assert.equal(back.phase, 'calm', 'o tsunami não recuou');
    assert.equal(back.reach, 0, `a água ficou na cidade (reach ${back.reach})`);
    assert.equal(back.edge, back.from, 'a frente parou fora da costa');
    assert.equal(back.bed, null);
    assert.equal(back.wet, 0);
    assert.ok(!back.hud.includes('PERIGO'), 'sobrou faixa de perigo na HUD');
  });

  await test('a água da onda é o corredor inteiro: embaixo dela se nada e se afoga', async () => {
    // Onda de 120 s: a página pode ficar muitos segundos presa no bundle, e uma onda curta
    // acabaria no meio de uma leitura. A vida em 1000 é só para a medição não matar o player
    // antes da próxima volta ao CDP.
    await evaluate('qa.g.hazard.cooldown=1e9;qa.g.hazard.force("tsunami",120)');
    // A onda sobe um tique por vez: sem esperar, a leitura cai no instante em que reach é 0.
    await until('qa.g.hazard.wave.reach>6', 'a onda subir a praia', 30000);
    const molhado = await evaluate(`(()=>{const g=qa.g,w=g.hazard.wave,mid=(w.u0+w.u1)/2,
      along=w.from+w.dir*(w.reach/2);
      const x=w.axis==='y'?mid:along,y=w.axis==='y'?along:mid;
      g.player.x=x;g.player.y=y;g.camera.x=x;g.camera.y=y;g.player.health=1000;
      g.notifyEntityChange();return {alagado:g.hazard.floodedAt(x,y),passo:w.reach}})()`);
    assert.ok(molhado.passo > 3, `a onda mal saiu do mar (${molhado.passo})`);
    assert.equal(molhado.alagado, true, 'no meio do corredor alagado o chão ainda é seco');
    await until('qa.g.player.swimming===true&&qa.g.player.anim==="swim"',
      'o player ser posto a nadar pela onda', 20000);
    await screenshot('qa-hazard-tsunami-nadando');
    await evaluate('qa.g.player.invulnUntil=0');
    await until('qa.g.player.health<960', 'a onda afogar o player', 20000);
    const ferido = await evaluate('({hp:qa.g.player.health,alagado:qa.g.hazard.floodedAt(qa.g.player.x,qa.g.player.y)})');
    assert.ok(ferido.alagado, 'o player atravessou a onda a pé e saiu seco do outro lado');
    await evaluate('qa.g.player.invulnUntil=Infinity;qa.g.player.health=100;qa.g.hazard.left=0.4');
    await until('qa.g.hazard.phase==="calm"', 'a onda voltar para o mar', 40000);
    assert.equal(await evaluate('qa.g.hazard.floodedAt(qa.g.player.x,qa.g.player.y)'), false,
      'a água recolheu e o chão continua alagado');
  });

  await test('o sorteio do jogo avisa antes de o perigo encostar no chão', async () => {
    // Começa do calma de verdade: sem isso um perigo sobrando de outro teste viraria "aviso".
    await evaluate('if(qa.g.hazard.phase!=="calm")qa.g.hazard.left=0.2');
    await until('qa.g.hazard.phase==="calm"', 'o perigo anterior acabar', 20000);
    await evaluate('qa.g.weather.season="verao";qa.g.weather.force("storm",3600);qa.g.hazard.cooldown=0');
    await until('qa.g.hazard.phase==="watch"||qa.g.hazard.phase==="active"', 'o sorteio abrir um perigo', 8000);
    // A HUD pinta em tick próprio: espera a faixa entrar antes de ler o resto.
    await until('!qa.g.hazard.alert||document.body.innerText.includes(qa.g.hazard.alert)', 'a faixa do aviso na HUD', 6000);
    const watch = await read();
    assert.ok(['tornado', 'hurricane', 'tsunami'].includes(watch.kind), `sorteou ${watch.kind}`);
    assert.match(watch.alert, /^AVISO · |^PERIGO · /, `alerta ${watch.alert}`);
    assert.ok(watch.hud.includes(watch.alert), 'a HUD sem o aviso');
    // O aviso dura HAZARD_WATCH_S: antes disso o perigo ainda não encostou no chão.
    assert.ok(watch.strength < 0.9, `força ${watch.strength} já no aviso`);
    await delay(14000);
    const active = await read();
    assert.equal(active.kind, watch.kind, 'o perigo trocou no meio do evento');
    assert.match(active.alert, /^PERIGO · /, `alerta ${active.alert}`);
    assert.ok(active.hud.includes('PERIGO'), 'a HUD não mudou de aviso para perigo');
    await screenshot('qa-hazard-alert');
    await evaluate('qa.g.hazard.left=0.4;qa.g.weather.force("clear",1)');
    await delay(11000);
    const done = await read();
    assert.equal(done.kind, null, 'o evento sorteado não terminou');
    assert.equal(done.strength, 0);
    assert.equal(done.clarity > 0.5, true, `visibilidade ${done.clarity} sem perigo`);
    assert.ok(!done.hud.includes('PERIGO') && !done.hud.includes('AVISO'), 'sobrou faixa na HUD');
  });

  assert.equal(errors.length, 0, 'erros no console:\n' + errors.slice(0, 6).join('\n'));
  console.log(`Hazard browser checks: ${passed} passed, ${failed} failed.`);
  if (failed) process.exitCode = 1;
  socket.close();
})().catch((error) => { console.error(error); process.exitCode = 1; });
