// Run: node tools/check/check-cascade-browser.cjs (precisa do Expo web em :8082 e Chrome em :9223).
//
// §6 na tela de verdade. `check-cascade.cjs` prova o que o sistema calcula; aqui o que se
// mede é o pixel. A pergunta do plano é "a água cai do degrau ou é uma textura plana colada
// na parede?", e ela tem uma resposta mensurável: projecta-se o curso da cachoeira duas
// vezes — uma com a cota que o chão daquele mapa tem, outra fingindo chão plano — e vê-se
// onde a folha branca REALMENTE desenhada começa. No chão plano a boca desceria ~170px e
// nasceria no meio do talude; no relevo ela nasce no lábio. É onde a cota muda a tela sem
// poder ser disfarçada: comparar ponto a ponto dentro de uma coluna vertical não distingue
// nada, porque deslizar um ponto ao longo da própria queda continua dentro da folha.
//
// Nada aqui usa o código do render para prever: a projeção é a fórmula iso 2:1 da casa,
// escrita de novo, e a cota vem de `map.heightSmoothAt`, o modelo do mundo.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PNG } = require('pngjs');
const WebSocket = require('ws');
const PORT = Number(process.env.QA_CDP_PORT || 9223);
const VW = 844, VH = 390;
let socket, serial = 0;
const pending = new Map(), errors = [];
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const send = (method, params = {}, timeout = 30000) => new Promise((resolve, reject) => {
  const id = ++serial;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP ${method} timeout`)); }, timeout);
  pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
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
async function frame(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  const buf = Buffer.from(data, 'base64');
  fs.writeFileSync(path.resolve(__dirname, '../tmp/' + name + '.png'), buf);
  return PNG.sync.read(buf);
}
/** Média de cada canal na elipse de tela pedida, com as bordas da tela respeitadas. */
function box(png, cx, cy, rx, ry) {
  let r = 0, g = 0, b = 0, n = 0;
  const x0 = Math.max(0, Math.floor(cx - rx)), x1 = Math.min(png.width - 1, Math.ceil(cx + rx));
  const y0 = Math.max(0, Math.floor(cy - ry)), y1 = Math.min(png.height - 1, Math.ceil(cy + ry));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = (x - cx) / Math.max(1, rx), dy = (y - cy) / Math.max(1, ry);
      if (dx * dx + dy * dy > 1) continue;
      const k = (png.width * y + x) << 2;
      r += png.data[k]; g += png.data[k + 1]; b += png.data[k + 2]; n++;
    }
  }
  if (!n) return { r: 0, g: 0, b: 0, lum: 0, n: 0, vazio: true };
  const m = (v) => v / n;
  return { r: m(r), g: m(g), b: m(b), n, lum: m(0.2126 * r + 0.7152 * g + 0.0722 * b) };
}
/** Quantos pixels da elipse são água clara: o lençol é a coisa mais branca da paisagem. */
function clara(png, cx, cy, rx, ry) {
  let dentro = 0, agua = 0;
  const x0 = Math.max(0, Math.floor(cx - rx)), x1 = Math.min(png.width - 1, Math.ceil(cx + rx));
  const y0 = Math.max(0, Math.floor(cy - ry)), y1 = Math.min(png.height - 1, Math.ceil(cy + ry));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = (x - cx) / Math.max(1, rx), dy = (y - cy) / Math.max(1, ry);
      if (dx * dx + dy * dy > 1) continue;
      dentro++;
      const k = (png.width * y + x) << 2;
      const lum = 0.2126 * png.data[k] + 0.7152 * png.data[k + 1] + 0.0722 * png.data[k + 2];
      if (lum >= 150 && png.data[k + 2] >= png.data[k]) agua++;
    }
  }
  return { dentro, agua, frac: dentro ? agua / dentro : 0 };
}
/**
 * Fração de branco puro na elipse pedida. A folha é um azul-claro (lum ~215) e a espuma é
 * 255,255,255 — a média de uma caixa sobre o lençol mistura as duas e não separa jato de
 * água. Contar só o que é branco de verdade separa.
 */
function branco(png, cx, cy, rx, ry, piso = 235) {
  let dentro = 0, puro = 0, max = 0;
  const x0 = Math.max(0, Math.floor(cx - rx)), x1 = Math.min(png.width - 1, Math.ceil(cx + rx));
  const y0 = Math.max(0, Math.floor(cy - ry)), y1 = Math.min(png.height - 1, Math.ceil(cy + ry));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = (x - cx) / Math.max(1, rx), dy = (y - cy) / Math.max(1, ry);
      if (dx * dx + dy * dy > 1) continue;
      dentro++;
      const k = (png.width * y + x) << 2;
      const lum = 0.2126 * png.data[k] + 0.7152 * png.data[k + 1] + 0.0722 * png.data[k + 2];
      if (lum >= piso) puro++;
      if (lum > max) max = lum;
    }
  }
  return { dentro, puro, frac: dentro ? puro / dentro : 0, max };
}
function diffPixels(a, b, cx, cy, rx, ry) {
  let n = 0, mudado = 0, ambos = 0, soA = 0, soB = 0;
  const x0 = Math.max(0, Math.floor(cx - rx)), x1 = Math.min(a.width - 1, Math.ceil(cx + rx));
  const y0 = Math.max(0, Math.floor(cy - ry)), y1 = Math.min(a.height - 1, Math.ceil(cy + ry));
  const isAgua = (png, x, y) => {
    const k = (png.width * y + x) << 2;
    const lum = 0.2126 * png.data[k] + 0.7152 * png.data[k + 1] + 0.0722 * png.data[k + 2];
    return lum >= 150 && png.data[k + 2] >= png.data[k];
  };
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = (x - cx) / Math.max(1, rx), dy = (y - cy) / Math.max(1, ry);
      if (dx * dx + dy * dy > 1) continue;
      n++;
      const ka = (a.width * y + x) << 2, kb = (b.width * y + x) << 2;
      const d = Math.abs(a.data[ka] - b.data[kb]) + Math.abs(a.data[ka + 1] - b.data[kb + 1])
        + Math.abs(a.data[ka + 2] - b.data[kb + 2]);
      if (d > 24) mudado++;
      const wa = isAgua(a, x, y), wb = isAgua(b, x, y);
      if (wa && wb) ambos++; else if (wa) soA++; else if (wb) soB++;
    }
  }
  return { n, mudado, frac: n ? mudado / n : 0, silhueta: (ambos + 1) / (ambos + soA + soB + 1) };
}
let passado = 0, falhou = 0;
async function test(name, fn) {
  try { await fn(); passado++; console.log('OK ' + name); }
  catch (error) { falhou++; process.exitCode = 1; console.error('FAIL ' + name + '\n' + (error.stack || error.message)); }
}

/** Projeção iso 2:1 da casa, reescrita aqui de propósito: é a régua independente do teste. */
const proj = (cam, x, y, h) => ({
  x: ((x - y) * 64 - (cam.x - cam.y) * 64) * cam.zoom + VW / 2,
  y: ((x + y) * 32 - h * 64 - ((cam.x + cam.y) * 32 - cam.h * 64)) * cam.zoom + VH / 2,
});
/** Meia-largura de tela do canal em `t`: círculo no chão iso vale r·64·√2 de largura. */
const meiaTela = (c, t, zoom) => c.largura * 0.5 * (0.72 + 0.56 * t) * 64 * Math.SQRT2 * zoom;

(async () => {
  const pages = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = pages.find((p) => p.type === 'page');
  assert.ok(page, `nenhum alvo CDP na porta ${PORT}`);
  socket = new WebSocket(page.webSocketDebuggerUrl);
  socket.onmessage = ({ data }) => {
    const m = JSON.parse(data);
    if (m.id) {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errors.push(m.params.entry.text);
  };
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = () => reject(new Error('CDP falhou')); });
  await send('Runtime.enable'); await send('Page.enable'); await send('Log.enable');
  await require('./bundle-identity.cjs').attach(socket, send);

  await send('Page.navigate', { url: 'about:blank' });
  await send('Emulation.setDeviceMetricsOverride', { width: VW, height: VH, deviceScaleFactor: 1, mobile: true });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await send('Page.navigate', { url: 'http://localhost:8082/?cascade-qa=1' });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await until(`!!document.querySelector('[data-testid="menu-new"],[data-testid="menu-play"]')
    ||!!document.body?.innerText.match(/JOGAR|NOVO JOGO/)`, 'menu', 180000);
  await delay(600);
  const botao = await evaluate(`(()=>{const b=document.querySelector('[data-testid="menu-new"]')
    ||document.querySelector('[data-testid="menu-play"]');
    if(!b)return null;const r=b.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  assert.ok(botao, 'nenhum botão de jogar no menu');
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...botao, id: 1 }] });
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await until('document.body.innerText.includes("HP 100")', 'HUD', 60000);
  await evaluate(`(()=>{const mods=[...__r.getModules().values()].filter(m=>m.isInitialized).map(m=>m.publicModule.exports);
    const g=mods.find(m=>m&&m.getGame).getGame();globalThis.qa={g};
    // O que o jogo PIDE ao canal de loop, sem depender do decoder de áudio do browser.
    const sm=mods.find(m=>m&&m.sound&&typeof m.sound.setLoop==='function');
    qa.pedidos={};const original=sm.sound.setLoop.bind(sm.sound);
    sm.sound.setLoop=(ch,key,vol)=>{qa.pedidos[ch]={key,vol:vol===undefined?.5:vol};return original(ch,key,vol);};
    qa.cena=()=>{g.player.invulnUntil=Infinity;g.dayNight.t=.5;g.weather.force('clear',3600);g.hazard.cooldown=1e9;};
    // Estaciona o player ao lado do eixo, em terra seca: é assim que a câmera encosta no
    // lugar pedido sem que o próprio lençol empurre quem serve de âncora da tela.
    qa.estacionar=(i,lado,zoom)=>{const c=g.map.data.cascatas[qa.k],p=c.curso[i],q=c.curso[Math.max(0,i-1)],
      r=c.curso[Math.min(c.curso.length-1,i+1)],m=Math.hypot(r.x-q.x,r.y-q.y)||1,
      x=p.x-(r.y-q.y)/m*lado,y=p.y+(r.x-q.x)/m*lado;
      if(g.map.isWaterWorld(x,y)||g.map.data.buildings.some(b=>Math.hypot(b.x-x,b.y-y)<3))return null;
      g.player.x=x;g.player.y=y;g.player.vx=0;g.player.vy=0;g.player.currentVehicleId=null;
      g.camera.x=x;g.camera.y=y;g.camera.h=g.map.heightSmoothAt(x,y);g.camera.zoom=zoom||1.55;
      g.notifyEntityChange();return {x:+x.toFixed(2),y:+y.toFixed(2)};};
    qa.casc=()=>{const cs=g.map.data.cascatas||[];qa.k=0;
      for(let i=1;i<cs.length;i++)if(cs[i].queda>cs[qa.k].queda)qa.k=i;
      const c=cs[qa.k];return {k:qa.k,count:cs.length,cascade:g.cascade.count,
        curso:c.curso.map(p=>({x:p.x,y:p.y,h:g.map.heightSmoothAt(p.x,p.y)})),
        largura:c.largura,queda:c.queda,bacia:c.bacia,topo:c.topo,base:c.base,
        view:[g.viewW,g.viewH]};};
    qa.cama=()=>({x:qa.g.camera.x,y:qa.g.camera.y,h:qa.g.camera.h,zoom:qa.g.camera.zoom});
    // Congela e re-enquadra: a câmera do jogo segue o player, que precisa ficar em terra
    // seca, mas a foto tem de ser a da queda inteira. O chão da volta já está re-baked
    // porque o passo anterior rodou uns segundos com a câmera ali.
    qa.enquadrar=(x,y,zoom)=>{g.paused=true;g.camera.x=x;g.camera.y=y;
      g.camera.h=g.map.heightSmoothAt(x,y);g.camera.zoom=zoom;g.notifyEntityChange();};
    // Varre as entities para um canto do mapa. O teste da correnteza compara dois quadros do
    // mesmo pixel e um NPC atravessando a caixa de controle muda tudo ali — com o mundo
    // congelado logo depois nada volta, e o que se move na tela é só a água.
    qa.isola=()=>{const longe=(a)=>{for(const e of a||[]){if(!e)continue;e.x=3;e.y=3;e.vx=0;e.vy=0;}};
      longe(g.npcs);longe(g.vehicles);longe(g.wildlife&&g.wildlife.animals);
      g.notifyEntityChange();return (g.npcs||[]).length+(g.vehicles||[]).length;};
    // Some a HUD para a foto medir a tela do jogo, não a interface. O painel de objetivo é
    // alinhado ao centro no topo — exatamente onde o lábio da queda cai na janela de teste,
    // e a faixa escura dele engolia a espuma branca do canto de cima.
    qa.hud=(v)=>{const el=document.querySelector('[data-testid="hud-health"]');if(!el)return null;
      for(let n=el;n;n=n.parentElement){const s=getComputedStyle(n);
        if(s.position==='absolute'&&Number(s.zIndex||0)>=50){n.style.display=v?'':'none';return true;}}
      return null;};
    qa.cena();})()`);

  const geo = await evaluate('qa.casc()');

  // A queda mais alta do seed do jogo desce 402px de tela a zoom 1,55 e a janela tem 390.
  // Encosta-se a câmera já com o zoom de enquadramento: o bake do chão é feito ali, parado,
  // e a foto final só anda ao longo do eixo — assim não aparece canto do mundo sem chão.
  //
  // A coluna cabe em ~62% da tela, não raspando nas bordas, por dois motivos que são o
  // mesmo motivo: névoa e decência. `fogRadii` ancora a zona limpa em 0,6 do raio
  // (138px vertical nesta janela), e uma queda de 326px enfiava o lábio na parede de névoa
  // — a espuma saiu a 237 de brilho porque a névoa da tela passou por cima dela, não porque
  // a tinta esteja errada. E nenhum jogador mede a crista de uma queda com ela cortada no
  // topo do video: quem quer ver a queda inteira primeiro se afasta.
  const ponta = (p) => (p.x + p.y) * 32 - p.h * 64;
  const pxQuedaZoom1 = ponta(geo.curso[geo.curso.length - 1]) - ponta(geo.curso[0]);
  const zoom = Math.min(1.55, (VH * 0.62) / pxQuedaZoom1);
  console.log(`enquadramento: ${pxQuedaZoom1.toFixed(0)}px de queda a zoom 1 → zoom ${zoom.toFixed(3)}`);

  // Enquadra o meio do curso: o player estaciona em terra seca ao lado da queda, a câmera
  // anda atrás dele sozinha e o chão ao redor é re-baked — com o jogo congelado o GroundLayer
  // nem refaz o bake e a foto sairia vazia.
  //
  // O meio é o meio DA COLUNA DE TELA, não a amostra do meio do vetor: as amostras são
  // equally spaced em arco do mundo, e como a cota não desce em linha reta a metade do
  // caminho não é a metade da altura. Centralizar na outra deixa o lábio fora da janela.
  const cotas = geo.curso.map((p) => (p.x + p.y) * 32 - p.h * 64);
  const meioY = (cotas[0] + cotas[cotas.length - 1]) / 2;
  const meioIdx = cotas.reduce((best, y, i) =>
    (Math.abs(y - meioY) < Math.abs(cotas[best] - meioY) ? i : best), 0);
  let parked = null;
  for (const lado of [3.4, -3.4, 2.8, -2.8, 4.2, -4.2]) {
    parked = await evaluate(`qa.estacionar(${meioIdx},${lado},${zoom})`);
    if (parked) break;
  }
  assert.ok(parked, 'não havia terra seca ao lado do curso para encostar a câmera');
  await delay(2600);
  const alvo = geo.curso[meioIdx];
  const varridas = await evaluate('qa.isola()');
  await evaluate(`qa.enquadrar(${alvo.x},${alvo.y},${zoom})`);
  await delay(1200);
  const cam = await evaluate('qa.cama()');
  const parado = await evaluate('qa.cama()');
  await delay(400);
  const depois = await evaluate('qa.cama()');
  assert.ok(Math.abs(depois.x - parado.x) < 0.02 && Math.abs(depois.y - parado.y) < 0.02,
    'a câmera não ficou onde foi posta: o jogo ainda a move');
  const tela = geo.curso.map((p, i) => ({
    i, mundo: p,
    relevo: proj(cam, p.x, p.y, p.h),
    plano: proj(cam, p.x, p.y, 0),
    meia: meiaTela(geo, i / (geo.curso.length - 1), cam.zoom),
  }));
  const desloc = tela.map((s) => +(s.plano.y - s.relevo.y).toFixed(0));
  console.log('cascade do jogo:', JSON.stringify({
    count: geo.count, cascade: geo.cascade, queda: +geo.queda.toFixed(2),
    largura: +geo.largura.toFixed(2), bacia: geo.bacia, amostras: geo.curso.length,
  }));
  console.log('âncora da câmera:', JSON.stringify(parked), 'entities fora do quadro:', varridas,
    'câmera:', JSON.stringify(Object.fromEntries(
    Object.entries(cam).map(([k, v]) => [k, +v.toFixed(2)]))));
  console.log('lençol na tela:', {
    topo: Math.round(tela[0].relevo.y), pe: Math.round(tela[tela.length - 1].relevo.y),
    descido: Math.round(tela[tela.length - 1].relevo.y - tela[0].relevo.y),
    desvioSemCota: desloc,
  });
  const dentro = tela.every((s) => s.relevo.x > 8 && s.relevo.x < VW - 8 && s.relevo.y > 8 && s.relevo.y < VH - 8);
  assert.ok(dentro, 'a queda projetada não cabe inteira na tela de teste');

  // Daqui até a foto do jogo: a HUD some. Os cinco testes de pixel medem a tela desenhada, e
  // medir o painel escuro do objetivo sobre o lábio daria "espuma de 3%" para uma queda
  // perfeita. O teste que confere a HUD volta a exibi-la antes de ler o `innerText`.
  assert.ok(await evaluate('qa.hud(false)'), 'não achei o nó da HUD para esconder na foto');
  await delay(300);

  await test('o mapa vivo tem a cachoeira que o gerador prometeu', async () => {
    assert.ok(geo.count >= 1, 'o mapa do jogo não tem nenhuma cachoeira');
    assert.equal(geo.cascade, geo.count, `CascadeSystem conhece ${geo.cascade} das ${geo.count} quedas`);
    assert.ok(geo.curso.length >= 3, `curso curto demais para cair: ${geo.curso.length} amostras`);
    assert.ok(geo.queda >= 0.7, `desnível de ${geo.queda} tiles não é queda`);
    assert.deepEqual(geo.view, [VW, VH], `a tela não é a do teste: ${geo.view}`);
    assert.ok(Math.max(...desloc) - Math.min(...desloc) > 40,
      'a cota mal muda o desenho desta queda: o controle chão-plano não provaria nada');
  });

  await test('o lençol cobre o curso projectado e para na largura que o mapa promete', async () => {
    // A régua do plano é "a água cai do degrau, não é textura colada", e essa pergunta tem
    // uma só resposta mensurável: o TOPO da folha. Ela está no teste seguinte, onde a cota
    // desloca a boca em ~170px e a diferença é impossível de disfarçar. Aqui se mede a
    // outra metade: a tinta desenhada segue a linha projectada seção por seção, e não
    // borra para o mato ao lado. Uma faixa chumbada na tela cobriria o eixo e o lado
    // inteiro juntos — o controle lateral é o que separa as duas coisas.
    const png = await frame('qa-cascade-queda');
    const linhas = [];
    for (const s of tela.slice(1, tela.length - 1)) {
      const a = tela[Math.max(0, s.i - 1)].relevo, b = tela[Math.min(tela.length - 1, s.i + 1)].relevo;
      const m = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const nx = -(b.y - a.y) / m, ny = (b.x - a.x) / m;
      // 2,6 meia-larguras: a pedra molhada vai até 0,6 e termina antes daqui.
      const lado = 2.6;
      const noEixo = clara(png, s.relevo.x, s.relevo.y, s.meia * 0.55, 16);
      const esq = clara(png, s.relevo.x + nx * s.meia * lado, s.relevo.y + ny * s.meia * lado, s.meia * 0.55, 16);
      const dir = clara(png, s.relevo.x - nx * s.meia * lado, s.relevo.y - ny * s.meia * lado, s.meia * 0.55, 16);
      console.log(`  i=${s.i} eixo(${Math.round(s.relevo.x)},${Math.round(s.relevo.y)}) água ${(noEixo.frac * 100).toFixed(0)}%`
        +` | mato à esquerda ${(esq.frac * 100).toFixed(0)}%, à direita ${(dir.frac * 100).toFixed(0)}%`);
      linhas.push({ noEixo: noEixo.frac, fora: Math.max(esq.frac, dir.frac) });
    }
    const media = (v) => v.reduce((a, b) => a + b, 0) / v.length;
    const cobre = media(linhas.map((l) => l.noEixo));
    const min = Math.min(...linhas.map((l) => l.noEixo));
    const vaza = Math.max(...linhas.map((l) => l.fora));
    console.log(`  cobertura do eixo: média ${(cobre * 100).toFixed(0)}%, pior seção ${(min * 100).toFixed(0)}%;`
      +` fora do canal: ${(vaza * 100).toFixed(0)}% no pior lado`);
    assert.ok(cobre >= 0.7, `o lençol não cobre o curso projectado: média ${(cobre * 100).toFixed(0)}%`);
    assert.ok(min >= 0.45, `uma seção do curso está sem água: ${(min * 100).toFixed(0)}%`);
    assert.ok(vaza <= 0.25, `a tinta vaza para o mato ao lado do canal: ${(vaza * 100).toFixed(0)}%`);
  });

  await test('a folha desce do lábio até o pé: altura de água que só a cota dá', async () => {
    const png = await frame('qa-cascade-coluna');
    // A caixa da queda: a largura do lençol em volta do eixo, da boca à cauda.
    const xs = tela.map((s) => s.relevo.x), ys = tela.map((s) => s.relevo.y);
    const x0 = Math.max(0, Math.round(Math.min(...xs) - geo.largura * 64 * Math.SQRT2 * cam.zoom));
    const x1 = Math.min(VW - 1, Math.round(Math.max(...xs) + geo.largura * 64 * Math.SQRT2 * cam.zoom));
    const topo = [];
    for (let y = 2; y < VH - 2; y++) {
      let n = 0;
      for (let x = x0; x <= x1; x += 2) {
        const k = (png.width * y + x) << 2;
        const lum = 0.2126 * png.data[k] + 0.7152 * png.data[k + 1] + 0.0722 * png.data[k + 2];
        if (lum >= 150 && png.data[k + 2] >= png.data[k]) n++;
      }
      if (n >= 3) topo.push(y);
    }
    assert.ok(topo.length >= 4, 'não há faixa de água clara entre o lábio e o pé');
    const primera = topo[0], ultima = topo[topo.length - 1];
    const boca = tela[0].relevo.y, cauda = tela[tela.length - 1].relevo.y;
    const bocaPlana = tela[0].plano.y;
    console.log(`  água clara de y=${primera} a y=${ultima} (${ultima - primera}px) | lábio projectado ${Math.round(boca)} `
      + `(chão plano diria ${Math.round(bocaPlana)}) | pé ${Math.round(cauda)}`);
    assert.ok(Math.abs(primera - boca) <= 40,
      `o topo da água está em ${primera}, a ${Math.abs(primera - boca)}px do lábio que o relevo marca`);
    assert.ok(bocaPlana - primera > 120,
      'a água começa onde começaria uma textura colada no plano da tela, não no lábio do morro');
    assert.ok(ultima >= cauda - 40, `a folha morre em ${ultima}, muito antes do pé em ${Math.round(cauda)}`);
    assert.ok(ultima - primera >= (cauda - boca) * 0.8, 'a folha é uma faixa curta no meio da encosta');
  });

  await test('tem espuma no lábio, jato no pé e névoa subindo do impacto', async () => {
    const png = await frame('qa-cascade-espuma');
    const boca = tela[0], cauda = tela[tela.length - 1];
    const meio = tela[Math.floor(tela.length / 2)].relevo;
    const labio = branco(png, boca.relevo.x, boca.relevo.y, boca.meia * 0.9, 16);
    const pe = branco(png, cauda.relevo.x, cauda.relevo.y, cauda.meia * 0.9, 16);
    const folha = branco(png, meio.x, meio.y, 20, 26);
    // A névoa não é medida contra um número: é medida contra a encosta seca da mesma altura,
    // três larguras de canal para o lado. Sem ela o ar ali em cima tem a tinta do morro.
    const nevoa = box(png, cauda.relevo.x, cauda.relevo.y - 40, cauda.meia * 0.7, 12);
    const arSeco = box(png, cauda.relevo.x + cauda.meia * 3.2, cauda.relevo.y - 40, 20, 12);
    console.log('  espuma:', {
      labio: `${(labio.frac * 100).toFixed(0)}% branco, pico ${labio.max.toFixed(0)}`,
      pe: `${(pe.frac * 100).toFixed(0)}% branco, pico ${pe.max.toFixed(0)}`,
      folha: `${(folha.frac * 100).toFixed(0)}% branco`,
      nevoa: +nevoa.lum.toFixed(0), arSeco: +arSeco.lum.toFixed(0),
    });
    assert.ok(labio.frac >= 0.08, `o lábio não tem espuma: só ${(labio.frac * 100).toFixed(0)}% de branco`);
    assert.ok(pe.frac >= 0.08, `o pé não tem jato branco: só ${(pe.frac * 100).toFixed(0)}% de branco`);
    assert.ok(pe.puro > folha.puro,
      `a espuma do pé não se destaca da folha (${pe.puro} vs ${folha.puro} pixels brancos)`);
    assert.ok(nevoa.lum >= arSeco.lum + 8,
      `não sobe névoa do impacto: ${nevoa.lum.toFixed(0)} contra ${arSeco.lum.toFixed(0)} do ar seco`);
  });

  await test('a bacia é água parada: escura e azul, longe do jato', async () => {
    const png = await frame('qa-cascade-bacia');
    const cota = await evaluate(`qa.g.map.heightSmoothAt(${geo.bacia.x},${geo.bacia.y})`);
    const centro = proj(cam, geo.bacia.x, geo.bacia.y, cota);
    const rx = geo.bacia.raio * 64 * Math.SQRT2 * cam.zoom;
    // O jato e o anel da onda vivem no miolo da bacia: a água parada é medida nas laterais,
    // a meia distância entre o centro e a borda.
    const um = box(png, centro.x - rx * 0.5, centro.y + rx * 0.1, rx * 0.2, 9);
    const dois = box(png, centro.x + rx * 0.5, centro.y + rx * 0.1, rx * 0.2, 9);
    // O controle tem de cair DENTRO da janela. A elipse da bacia tem meia-altura rx/2 e o pé
    // da queda está a 45px do fundo da tela: qualquer caixa abaixo do centro sai do quadro e
    // volta vazia, com a média 0 provando o teste por burrice, não por tinta.
    const fora = box(png, centro.x + rx * 0.75, centro.y - rx * 0.5, 18, 10);
    const folha = box(png, tela[Math.floor(tela.length / 2)].relevo.x,
      tela[Math.floor(tela.length / 2)].relevo.y, 18, 12);
    console.log('  bacia:', {
      um: +um.lum.toFixed(0), dois: +dois.lum.toFixed(0),
      frio: +((um.b - um.r + dois.b - dois.r) / 2).toFixed(0),
      fora: +fora.lum.toFixed(0), foraFrio: +(fora.b - fora.r).toFixed(0), foraN: fora.n,
      folha: +folha.lum.toFixed(0),
    });
    assert.ok(fora.n >= 150, 'a caixa de chão seco da bacia caiu fora da tela');
    const fria = (m) => m.b - m.r;
    assert.ok(fria(um) >= 12 && fria(dois) >= 12,
      `a bacia não é azul nos dois lados do jato: ${fria(um).toFixed(0)} e ${fria(dois).toFixed(0)}`);
    assert.ok(um.lum <= 150 && dois.lum <= 150,
      `a bacia está clara demais para ser água parada: ${um.lum.toFixed(0)} e ${dois.lum.toFixed(0)}`);
    assert.ok(folha.lum - Math.max(um.lum, dois.lum) > 25,
      `a bacia não é mais escura que a queda em movimento (${folha.lum.toFixed(0)} vs ${um.lum.toFixed(0)})`);
    assert.ok(fora.b - fora.r < fria(um) - 6,
      'a poça tem a mesma tinta do chão em volta: não é água');
  });

  await test('a água se move e a silhueta fica: correnteza, não decalque', async () => {
    // Com o jogo congelado o mundo não anda um tile: o único relógio que existe na tela é o
    // da própria queda (`clock.value = game.time`), então o que muda aqui é só a água.
    //
    // Um Δ só de relógio não provaria nada contra um padrão periódico: 0,55s são exatamente
    // quatro voltas do vão das riscas, e a folha voltaria a ficar pixel por pixel onde
    // estava com a correnteza a todo vapor. Varrem-se passos desiguais e fica a MAIOR
    // mudança medida — se a água anda, um deles pega o meio de um vão; se é decalque,
    // nenhum muda nada.
    const s = tela[Math.floor(tela.length / 2)];
    const pedra = tela[2];
    let a = await frame('qa-cascade-quadro-a');
    const medidas = [];
    let silhueta = 1;
    let seco = { n: 0, frac: 0 };
    for (const dt of [0.05, 0.09, 0.14, 0.21, 0.08]) {
      await evaluate(`qa.g.time += ${dt}`);
      await delay(420);
      const b = await frame('qa-cascade-quadro-b');
      const m = diffPixels(a, b, s.relevo.x, s.relevo.y, s.meia * 0.8, 30);
      seco = diffPixels(a, b, pedra.relevo.x + pedra.meia * 3.2, pedra.relevo.y, 22, 12);
      medidas.push(+(m.frac * 100).toFixed(1));
      silhueta = Math.min(silhueta, m.silhueta);
      a = b;
    }
    const agua = Math.max(...medidas) / 100;
    console.log('  movimento:', {
      passos: medidas.join(' '), agua: +agua.toFixed(3), silhueta: +silhueta.toFixed(3),
      seco: +seco.frac.toFixed(3),
    });
    assert.ok(agua >= 0.15, `a correnteza está parada: o melhor dos passos mudou só ${(agua * 100).toFixed(1)}% do lençol`);
    assert.ok(silhueta >= 0.6, `a folha trocou de lugar entre um quadro e outro: ${(silhueta * 100).toFixed(0)}% comum`);
    assert.ok(seco.n >= 100, 'a caixa de chão seco caiu fora da tela');
    assert.ok(seco.frac <= 0.05, `o chão seco ao lado mudou junto (${(seco.frac * 100).toFixed(1)}%): a tela inteira treme`);
  });

  await test('quem cai no lençol é levado até a bacia e nada nela', async () => {
    const inicio = geo.curso[2];
    await evaluate(`(()=>{const g=qa.g,c=g.map.data.cascatas[${geo.k}];const p=c.curso[2];
      g.player.x=p.x;g.player.y=p.y;g.player.vx=0;g.player.vy=0;g.player.health=100;
      g.player.invulnUntil=0;g.paused=false;g.notifyEntityChange();
      return {x:g.player.x,y:g.player.y,h:g.map.heightSmoothAt(p.x,p.y)}})()`);
    await delay(2500);
    const empurrado = await evaluate(`(()=>{const g=qa.g,p=g.map.data.cascatas[${geo.k}].curso[2];
      return {x:g.player.x,y:g.player.y,d:+Math.hypot(g.player.x-p,g.player.y-p).toFixed(2),
        swimming:g.player.swimming,anim:g.player.anim,hp:g.player.health}})()`);
    const avanco = empurrado.x + empurrado.y - (inicio.x + inicio.y);
    console.log('  arrasto:', JSON.stringify(empurrado), 'avanço (x+y):', avanco.toFixed(2));
    assert.ok(avanco > 0.8, `a correnteza não desceu o player pelo talude (Δx+y ${avanco.toFixed(2)})`);
    assert.ok(empurrado.hp < 100, 'quem está no lençol não se machuca');

    await until(`(()=>{const b=qa.g.map.data.cascatas[${geo.k}].bacia;
      return Math.hypot(qa.g.player.x-b.x,qa.g.player.y-b.y)<b.raio*2.2})()`,
      'o player chegar à bacia', 20000);
    const noPé = await evaluate(`(()=>{const g=qa.g,b=g.map.data.cascatas[${geo.k}].bacia,p=g.player;
      return {d:+Math.hypot(p.x-b.x,p.y-b.y).toFixed(2),raio:b.raio,nada:p.swimming,anim:p.anim,
        agua:g.map.isWaterWorld(p.x,p.y),kind:g.map.tileKindAt(Math.floor(p.x),Math.floor(p.y))}})()`);
    console.log('  na bacia:', JSON.stringify(noPé));
    assert.equal(noPé.nada, true, 'parado na bacia da cachoeira o player continua andando');
    assert.equal(noPé.anim, 'swim', `a pose da bacia é ${noPé.anim}`);
    assert.equal(noPé.agua, true, 'a bacia não é água pisável');
    assert.notEqual(noPé.kind, 'water', 'a bacia reescreveu o tile: o relevo perdeu o contrato');
    await frame('qa-cascade-arrastado');
    await evaluate('qa.g.player.invulnUntil=Infinity;qa.g.player.health=100;qa.cena();');
  });

  await test('o rugido vem do lugar: alto na queda, mudo a 40 tiles', async () => {
    const perto = await evaluate(`(()=>{const g=qa.g;
      return {vol:+g.cascade.volumeEm(g.player.x,g.player.y).toFixed(3),pedido:qa.pedidos.cascade}})()`);
    assert.ok(perto.vol > 0.5, `a beira da queda não ouve nada (volume ${perto.vol})`);
    assert.equal(perto.pedido && perto.pedido.key, 'cascade', `o canal não pediu a cachoeira: ${JSON.stringify(perto.pedido)}`);
    assert.ok(perto.pedido.vol > 0.5, `volume pedido ao canal: ${perto.pedido.vol}`);

    await evaluate(`(()=>{const g=qa.g;g.paused=false;g.player.x=g.map.worldW-8;g.player.y=8;
      g.camera.x=g.player.x;g.camera.y=g.player.y;g.notifyEntityChange();})()`);
    await until('qa.pedidos.cascade&&qa.pedidos.cascade.key===null', 'o canal liberar a cachoeira', 8000);
    const longe = await evaluate(`(()=>{const g=qa.g;
      return {vol:+g.cascade.volumeEm(g.player.x,g.player.y).toFixed(3),pedido:qa.pedidos.cascade}})()`);
    console.log('  longe da queda:', JSON.stringify(longe));
    assert.ok(longe.vol < 0.02, `a 40 tiles da queda ainda se ouve (${longe.vol})`);
    assert.equal(longe.pedido.key, null, 'o loop continua tocando longe da água');
    await evaluate('qa.g.paused=true;qa.cena();');
  });

  await test('a cachoeira não derrubou nada do resto do jogo', async () => {
    await evaluate('qa.hud(true)');
    await delay(300);
    const hud = await evaluate('document.body.innerText');
    assert.match(hud, /HP \d+/, 'a HUD sumiu');
    assert.deepEqual(errors, [], 'erros na página:\n' + errors.slice(0, 6).join('\n'));
  });

  console.log(`\nCachoeira no navegador: ${passado} passed, ${falhou} failed.`);
  if (falhou) process.exitCode = 1;
  socket.close();
})().catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => socket?.close());
