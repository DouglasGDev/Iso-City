// Run: node tools/check/check-fauna-browser.cjs (precisa do Expo web em :8082 e Chrome em :9223).
//
// A queixa do #131 é de ouvido, não de código: "muito uhu sem bicho por perto". O
// `check-wildlife.cjs` já prova, no sistema, quem tem direito de abrir a boca — invisível
// não conversa, susto fura a tela, e o coro tem freio. O que ele não pode provar é o que o
// GameState faz com essa decisão: a curva de volume, que antes tinha um piso de 0,08 e por
// isso entregava o mesmo urro a 13 tiles de um animal que ninguém via.
//
// Aqui o microfone é o próprio `sound.play`, embrulhado antes de qualquer chamada. Cada
// "animalCall" sai com o volume pedido e o retrato das distâncias a todos os bichos no
// instante do toque. Duas réguas: longe de todo bicho, o caderno tem de ficar vazio; perto,
// nenhum volume pode passar do teto que o animal mais próximo justifica, e o volume implícito
// tem de bater com a distância de um bicho que realmente existe ali.
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const PORT = Number(process.env.QA_CDP_PORT || 9223);
let socket, serial = 0;
const pending = new Map(), errors = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const send = (method, params = {}, timeout = 30000) => new Promise((resolve, reject) => {
  const id = ++serial;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP ${method} timeout`)); }, timeout);
  pending.set(id, { resolve: r => { clearTimeout(timer); resolve(r); }, reject: e => { clearTimeout(timer); reject(e); } });
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
    try { if (await evaluate(expression)) return; } catch { /* página trocando */ }
    await delay(60);
  }
  throw new Error('Timed out: ' + label);
}
let passado = 0, falhou = 0;
async function test(name, fn) {
  try { await fn(); passado++; console.log('OK ' + name); }
  catch (error) { falhou++; process.exitCode = 1; console.error('FAIL ' + name + '\n' + (error.stack || error.message)); }
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
  await require('./bundle-identity.cjs').attach(socket, send);
  await send('Network.enable'); await send('Network.setCacheDisabled', { cacheDisabled: true });

  await send('Page.navigate', { url: 'about:blank' });
  await send('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 1, mobile: true });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await send('Page.navigate', { url: 'http://localhost:8082/?fauna-qa=1' });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await until(`!!document.querySelector('[data-testid="menu-new"],[data-testid="menu-play"]')`, 'menu', 180000);
  await delay(600);
  const botao = await evaluate(`(()=>{const b=document.querySelector('[data-testid="menu-new"]')
    ||document.querySelector('[data-testid="menu-play"]');
    if(!b)return null;const r=b.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  assert.ok(botao, 'nenhum botão de jogar no menu');
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...botao, id: 1 }] });
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await until('document.body.innerText.includes("HP 100")', 'HUD', 60000);

  const raio = 14;
  await evaluate(`(()=>{const mods=[...__r.getModules().values()].filter(m=>m.isInitialized).map(m=>m.publicModule.exports);
    globalThis.qa={g:mods.find(m=>m?.getGame).getGame(),som:mods.find(m=>m?.sound).sound};
    const G=qa.g;
    G.player.invulnUntil=Infinity;G.dayNight.t=.5;G.weather.checkTimer=1e9;G.weather.force('clear',1);
    G.hazard.cooldown=1e9;
    qa.ir=(x,y)=>{G.player.x=x;G.player.y=y;G.camera.x=x;G.camera.y=y;
      G.camera.h=G.map.heightSmoothAt(x,y);};
    qa.vizinho=()=>{let d=1e9;for(const a of G.wildlife.animals){
      const k=Math.hypot(a.x-G.player.x,a.y-G.player.y);if(k<d)d=k;}return d;};
    // Retrato de todas as distâncias no instante da voz: o bicho anda, e medir depois daria
    // uma curva errada por culpa do relógio, não do código.
    qa.vizinancas=()=>{const l=[];for(const a of G.wildlife.animals){
      const k=Math.hypot(a.x-G.player.x,a.y-G.player.y);if(k<=18)l.push(+k.toFixed(2));}
      return l.sort((p,q)=>p-q);};
    qa.vozes=[];
    if(!qa.som.__embrulhado){const original=qa.som.play.bind(qa.som);
      qa.som.__embrulhado=true;
      qa.som.play=function(key,vol){
        if(key==='animalCall')qa.vozes.push({d:+qa.vizinho().toFixed(2),dd:qa.vizinancas(),v:vol});
        return original(key,vol);};}
    return true;})()`);

  // O lugar mais longe de todo bicho que o mapa tem: se a voz vier de longe, é aqui que ela
  // não pode aparecer.
  const ermo = await evaluate(`(()=>{const G=qa.g,d=G.map.data,W=d.tilesW;
    let m=null;
    for(let y=12;y<d.tilesH-12;y+=2)for(let x=12;x<W-12;x+=2){
      const t=d.tiles[y*W+x];
      if(t.kind==='water'||t.biome==='desert'||t.biome==='beach')continue;
      let dmin=1e9;for(const a of G.wildlife.animals)dmin=Math.min(dmin,Math.hypot(a.x-x,a.y-y));
      if(!m||dmin>m.d)m={x,y,d:+dmin.toFixed(1)};}
    return m;})()`);
  const manada = await evaluate(`(()=>{const G=qa.g;let m=null;
    for(const a of G.wildlife.animals){const vizinhos=G.wildlife.animals.filter(b=>
      Math.hypot(b.x-a.x,b.y-a.y)<10).length;
      if(!m||vizinhos>m.n)m={x:a.x,y:a.y,n:vizinhos,sp:a.species};}
    return m;})()`);
  console.log('ermo', JSON.stringify(ermo), 'manada', JSON.stringify(manada),
    'animais', await evaluate('qa.g.wildlife.animals.length'));
  assert.ok(ermo && ermo.d >= 30, `o mapa não tem um canto a 30 tiles de qualquer bicho (${ermo && ermo.d})`);
  assert.ok(manada && manada.n >= 2, 'não há manada para ouvir');

  await test('sem bicho por perto, nenhuma voz', async () => {
    await evaluate(`qa.ir(${ermo.x},${ermo.y});qa.vozes.length=0;`);
    await delay(25000);
    const vozes = await evaluate('qa.vozes');
    const perto = await evaluate('qa.vizinho()');
    console.log(`  ermo a ${perto.toFixed(1)} tiles do bicho mais próximo: ${vozes.length} vozes`);
    assert.equal(vozes.length, 0, `urrou com o bicho mais próximo a ${perto.toFixed(1)} tiles`);
  });

  await test('com bicho por perto, cada voz cabe na curva de distância', async () => {
    await evaluate(`qa.ir(${manada.x + 5},${manada.y + 2});qa.vozes.length=0;`);
    await delay(25000);
    const vozes = await evaluate('qa.vozes');
    console.log(`  na orla da manada: ${vozes.length} vozes, `
      + `distâncias ${vozes.map(v => v.d).join('/') || '-'}, volumes ${vozes.map(v => +v.v.toFixed(2)).join('/') || '-'}`);
    assert.ok(vozes.length >= 1, 'a few tiles de um bando de bichos ninguém grasna');
    // Quem grasna não é preciso que seja o bicho mais próximo, então a régua vai nos dois
    // sentidos. Para cima: o volume nunca pode passar do teto que o MAIS próximo justifica —
    // é esse teto que o piso de 0,08 antigo rompia. Para baixo: o distância que o volume
    // implica tem de ser a de um bicho que estava ali de fato, senão a queda virou constante.
    for (const v of vozes) {
      const teto = 0.4 * (1 - Math.min(1, v.d / raio));
      assert.ok(v.v <= teto + 0.02,
        `a ${v.d} tiles do bicho mais próximo o volume veio em ${v.v.toFixed(2)}, o teto é ${teto.toFixed(2)}`);
      const pedida = raio * (1 - v.v / 0.4);
      const encaixe = Math.min(...v.dd.map(k => Math.abs(k - pedida)));
      assert.ok(encaixe <= 1,
        `volume ${v.v.toFixed(2)} denuncia um bicho a ${pedida.toFixed(1)} tiles de distância e `
        + `nenhum estava a menos de ${encaixe.toFixed(1)} tiles disso`);
    }
    const longe = vozes.filter(v => v.d > raio * 0.7);
    for (const v of longe) assert.ok(v.v < 0.15, `bicho na borda do raio ainda grita (${v.v.toFixed(2)})`);
  });

  await test('nada quebrou no caminho', async () => {
    assert.deepEqual(errors, [], 'erros na página: ' + errors.slice(0, 3).join(' | '));
  });

  console.log(`\nVoz da fauna: ${passado} passed, ${falhou} failed.`);
})().catch(e => { console.error(e); process.exit(1); })
  .finally(() => socket?.close());
