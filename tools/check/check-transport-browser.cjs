/**
 * Fase 1 da rede de transporte no jogo real: a malha nasce do mapa no construtor do
 * `GameState`, o portão de zonas decide o que se materializa enquanto a câmera anda, e o
 * relógio do horário é o relógio do jogo — morrer ou entrar numa sala não atrasa ônibus
 * nenhum. Roda contra o bundle do navegador; o que está fora do mapa é o `check-transport`.
 */
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const output = path.resolve(__dirname, '../tmp');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const pending = new Map();
const erros = [];
const avisos = [];
let passed = 0;
const failures = [];
function check(ok, message) {
  if (ok) { passed++; console.log(`OK ${message}`); } else { failures.push(message); console.log(`FALHOU ${message}`); }
}
let socket, id = 0;
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const k = ++id; pending.set(k, { resolve, reject }); socket.send(JSON.stringify({ id: k, method, params }));
});
async function evaluate(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}
async function until(expr, label, timeout = 180000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await evaluate(expr)) return; await delay(80); }
  throw new Error(`tempo esgotado: ${label}`);
}
async function textCenter(...texts) {
  return evaluate('(() => {const want=' + JSON.stringify(texts)
    + ";const e=[...document.querySelectorAll('div')].find((el)=>el.childElementCount===0&&want.indexOf(el.textContent)>=0);"
    + "if(!e) throw new Error('faltando texto');"
    + 'const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2};})()');
}
const touches = (type, points) => send('Input.dispatchTouchEvent', {
  type, touchPoints: points.map((p) => ({ radiusX: 5, radiusY: 5, force: 1, ...p })),
});
async function tapPoint(p) {
  await touches('touchStart', [{ ...p, id: 1 }]); await delay(70);
  await touches('touchEnd', []); await delay(180);
}
async function screenshot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(output, `${name}.png`), Buffer.from(data, 'base64'));
}

(async () => {
  const tabs = await (await fetch('http://127.0.0.1:9223/json/list')).json();
  socket = new WebSocket(tabs.find((t) => t.type === 'page').webSocketDebuggerUrl);
  socket.addEventListener('message', ({ data }) => {
    const m = JSON.parse(data);
    if (m.id) {
      const p = pending.get(m.id); if (!p) return; pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result);
      return;
    }
    if (m.method === 'Runtime.exceptionThrown') erros.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') erros.push(m.params.entry.text);
    else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'warning') avisos.push(m.params.entry.text);
  });
  await new Promise((res, rej) => { socket.addEventListener('open', res); socket.addEventListener('error', rej); });
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Log.clear');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, screenWidth: 1280, screenHeight: 720, deviceScaleFactor: 1, mobile: false });
  await send('Emulation.setTouchEmulationEnabled', { enabled: false });
  await send('Page.navigate', { url: 'http://localhost:8082/?isolated-test=1' });
  await until('!!document.body?.innerText.match(/JOGAR|NOVO JOGO/)', 'menu');
  await tapPoint(await textCenter('JOGAR', 'NOVO JOGO'));
  await until('!!document.querySelector("[data-testid=control-weapon]")', 'controles', 120000);
  await evaluate('(() => {const mods=[...__r.getModules().values()].filter(m=>m.isInitialized).map(m=>m.publicModule.exports);'
    + 'globalThis.qa={g:mods.find(m=>m?.getGame).getGame(),cfg:mods.find(m=>m?.GAME_CONFIG).GAME_CONFIG};})()');
  await delay(600);

  // 1) A malha do jogo é a malha do mapa: derivada no construtor, sem linha sem parada.
  const rede = await evaluate('(() => {const t=qa.g.transport,n=t.network;return {rotas:n.routes.length,'
    + 'paradas:n.stations.length,servidas:n.stations.filter((s)=>s.lines.length).length,units:t.units.length,'
    + 'servicos:n.services.map((s)=>s.modality),ranks:[...new Set(n.routes.flatMap((r)=>r.ranks))].sort(),'
    + 'semParada:n.routes.filter((r)=>r.stops.length<2).length,duplicada:'
    + '(n.routes.length-new Set(n.routes.map((r)=>r.name)).size)}})()');
  check(rede.rotas >= 8 && rede.servidas >= 100 && rede.units > rede.rotas,
    `malha derivada no boot: ${rede.rotas} linhas, ${rede.servidas} paradas servidas, ${rede.units} veículos`);
  check(rede.semParada === 0 && rede.duplicada === 0, 'nenhuma linha nasce sem parada ou repetida');
  check(rede.servicos.length === 1 && rede.servicos[0] === 'bus'
    && rede.ranks.join() === 'avenue,highway,residential,street',
    `só o ônibus opera por enquanto, cobrindo ${rede.ranks.join('/')}`);

  // 2) Câmera na cidade: o portão materializa e nenhuma unidade viva está fora do anel.
  const centro = await evaluate('(() => {const n=qa.g.transport.network;'
    + 'const s=n.stations.filter((x)=>x.lines.length).sort((a,b)=>Math.hypot(a.x-120,a.y-120)-Math.hypot(b.x-120,b.y-120))[0];'
    + 'qa.g.player.x=s.x;qa.g.player.y=s.y;return {x:s.x,y:s.y,nome:s.name};})()');
  await delay(1600);
  const cidade = await evaluate('(() => {const t=qa.g.transport,p=qa.g.player;const viva=t.units.filter((u)=>u.live);'
    + 'return {vivas:viva.length,fora:viva.filter((u)=>Math.hypot(u.x-p.x,u.y-p.y)>qa.cfg.STREAMING_RADIUS_TILES).length,'
    + 'linhas:[...new Set(viva.map((u)=>u.route))].length,relógio:+t.clock.toFixed(2)};})()');
  check(cidade.vivas > 0 && cidade.fora === 0,
    `portão na cidade (${centro.nome}): ${cidade.vivas} unidades vivas de ${cidade.linhas} linhas, nenhuma fora do anel`);

  // 3) O ponto mais longe do asfalto: quase tudo congela, mas a cobertura não deixa nada morrer.
  const longe = await evaluate('(() => {const n=qa.g.transport.network;let pior=null;'
    + 'for(let y=8;y<232;y+=8)for(let x=8;x<232;x+=8){let d=1e9;'
    + 'for(const r of n.routes)for(const q of r.points){const e=Math.hypot(q.x-x,q.y-y);if(e<d)d=e;}'
    + 'if(!pior||d>pior.d)pior={x,y,d};}'
    + 'qa.g.player.x=pior.x;qa.g.player.y=pior.y;return {x:pior.x,y:pior.y,asfalto:+pior.d.toFixed(1)};})()');
  await delay(1400);
  const deserto = await evaluate('(() => {const t=qa.g.transport,p=qa.g.player;const viva=t.units.filter((u)=>u.live);'
    + 'return {vivas:viva.length,fora:viva.filter((u)=>Math.hypot(u.x-p.x,u.y-p.y)>qa.cfg.STREAMING_RADIUS_TILES).length,'
    + 'paradas:t.stopsAt(p.x,p.y,8).length};})()');
  check(deserto.vivas < cidade.vivas && deserto.fora === 0,
    `portão no deserto (asfalto a ${longe.asfalto} tiles): ${deserto.vivas} vivas contra ${cidade.vivas} na cidade`);
  check(deserto.paradas > 0, `nenhum canto do mapa fica sem parada ao alcance: ${deserto.paradas} ali`);

  // 4) O relógio da malha é o do jogo. Morrendo o jogador, o tick da rua é devolvido no meio
  // do caminho e a malha nem é consultada — o que se cobra é que ao voltar ela esteja no
  // mesmo segundo do jogo, e não alguns segundos atrás por causa do tempo perdido.
  await evaluate(`qa.g.player.x=${centro.x};qa.g.player.y=${centro.y};qa.g.playerDeathTimer=0;qa.g.player.state='dead'`);
  await delay(1500);
  const caído = await evaluate('({jogo:+qa.g.time.toFixed(3),malha:+qa.g.transport.clock.toFixed(3)})');
  await evaluate('qa.__volta = qa.g.time + 0.6');
  await until('qa.g.time > qa.__volta && qa.g.player.state !== "dead"', 'a rua voltar a rodar', 40000);
  await delay(400);
  const relogios = await evaluate('({jogo:+qa.g.time.toFixed(3),malha:+qa.g.transport.clock.toFixed(3),'
    + 'estado:qa.g.player.state})');
  check(relogios.malha === relogios.jogo,
    `o horário não perde o tempo em que a rua foi pulada: jogo ${relogios.jogo}s, malha ${relogios.malha}s `
    + `(durante a morte: jogo ${caído.jogo}s contra malha ${caído.malha}s)`);

  await delay(900);
  await screenshot('qa-transport-city');
  check(erros.length === 0 && avisos.length === 0,
    `console limpo com a malha ligada (${erros.length} erros, ${avisos.length} avisos)`);
  for (const e of erros.slice(0, 4)) console.log('  ERRO ' + e.slice(0, 160));
  for (const a of avisos.slice(0, 4)) console.log('  AVISO ' + a.slice(0, 160));

  console.log(`\nTransporte no navegador: ${passed} passaram, ${failures.length} falharam`);
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error('FALHOU: ' + e.message); process.exit(1); });
