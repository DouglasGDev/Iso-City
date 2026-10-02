// Run: node tools/check/check-radar-fog-browser.cjs (precisa do Expo web em :8082 e Chrome em :9223).
//
// A queixa do jogador foi: "quando vou explorando o mapa, o mini mapa fica bugado! parece que o
// gps não tá pegando a localização do personagem direito!". Medindo, a localização estava certa
// (o pingo fica a menos de 1px do centro do painel) e o que estava errado era a volta dele: com a
// janela do radar alcançando ~57 tiles na diagonal e a descoberta revelando só 8 de raio, 67,3%
// dos pixels do painel eram o cinza de nunca-visitado (#15212c) — inclusive a rua sob o pé e o
// caminho à frente. Um painel escuro com uma setinha no meio é lido como "sem sinal".
//
// Este check trava as duas metades do contrato em pixels da tela:
//   1. o pingo mora no centro do radar a pé, em carro e depois de um salto para terra que o
//      jogador nunca viu, e o pan que o componente recebe bate com a projeção refeita aqui de
//      fora — se divergir, o painel mostra um lugar e a setinha outro;
//   2. a maior parte da janela continua sendo terra não descoberta, mas quase nenhum pixel é o
//      vazio: apagar é tudo que a névoa pode fazer no radar. No mapa cheio a proporção inverte,
//      porque lá a névoa é a recompensa de explorar, não o chão debaixo do pé.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PNG } = require('pngjs');
const WebSocket = require('ws');
const PORT = Number(process.env.QA_CDP_PORT || 9223);
const VW = 844, VH = 390;
/** O radar é desenhado por dentro de uma moldura de 1,5px: mede-se o miolo, não a borda. */
const MOLDURA = 2;
const ZOOM_RADAR = 12;
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
async function until(expression, label, timeout = 240000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try { if (await evaluate(expression)) return; } catch { /* página trocando */ }
    await delay(80);
  }
  throw new Error('Timed out: ' + label);
}
async function frame(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  const buf = Buffer.from(data, 'base64');
  fs.writeFileSync(path.resolve(__dirname, '../tmp/' + name + '.png'), buf);
  return PNG.sync.read(buf);
}
let passado = 0, falhou = 0;
async function test(name, fn) {
  try { await fn(); passado++; console.log('OK ' + name); }
  catch (error) { falhou++; process.exitCode = 1; console.error('FAIL ' + name + '\n' + (error.stack || error.message)); }
}

/** Fração do recorte que é exatamente o vazio do mapa: #15212c (não explorado) e #0c141d. */
function vazio(png, rect) {
  const x0 = Math.round(rect.x), y0 = Math.round(rect.y), total = rect.width * rect.height;
  let ne = 0, bg = 0;
  for (let y = 0; y < rect.height; y++) {
    for (let x = 0; x < rect.width; x++) {
      const k = (png.width * (y0 + y) + x0 + x) << 2;
      const c = [png.data[k], png.data[k + 1], png.data[k + 2]].join(',');
      if (c === '21,33,44') ne++; else if (c === '12,20,29') bg++;
    }
  }
  return { ne: ne / total, bg: bg / total, frac: (ne + bg) / total };
}

/**
 * O pingo do jogador (#edfff9) dentro do recorte: centroide absoluto na tela e o que tem
 * encostado nele. `fundo` conta o vazio puro num raio de 10px — pisar em cinza de nunca-visitado
 * é exatamente o "o radar não mostra onde eu estou".
 */
function pingo(png, rect) {
  const x0 = Math.round(rect.x), y0 = Math.round(rect.y);
  let sx = 0, sy = 0, n = 0;
  for (let y = 0; y < rect.height; y++) {
    for (let x = 0; x < rect.width; x++) {
      const k = (png.width * (y0 + y) + x0 + x) << 2;
      if (png.data[k] > 222 && png.data[k + 1] > 238 && png.data[k + 2] > 232) { sx += x0 + x; sy += y0 + y; n++; }
    }
  }
  if (!n) return { n: 0 };
  const cx = sx / n, cy = sy / n;
  let escuro = 0, total = 0;
  for (let y = 0; y < rect.height; y++) {
    for (let x = 0; x < rect.width; x++) {
      const px = x0 + x, py = y0 + y, dx = px - cx, dy = py - cy;
      if (dx * dx + dy * dy > 100) continue;
      total++;
      const k = (png.width * py + px) << 2;
      const c = [png.data[k], png.data[k + 1], png.data[k + 2]].join(',');
      if (c === '21,33,44' || c === '12,20,29') escuro++;
    }
  }
  return { n, cx: +cx.toFixed(1), cy: +cy.toFixed(1),
    fundo: total ? +(escuro / total).toFixed(2) : null };
}

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

  await send('Page.navigate', { url: 'about:blank' });
  await send('Emulation.setDeviceMetricsOverride', { width: VW, height: VH, deviceScaleFactor: 1, mobile: true });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await send('Page.navigate', { url: 'http://localhost:8082/?radar-fog-qa=1' });
  await until(`!!document.querySelector('[data-testid="menu-new"],[data-testid="menu-play"]')`, 'menu');
  await delay(600);
  const botao = await evaluate(`(()=>{const b=document.querySelector('[data-testid="menu-new"]')
    ||document.querySelector('[data-testid="menu-play"]');const r=b.getBoundingClientRect();
    return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  assert.ok(botao, 'nenhum botão de jogar no menu');
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...botao, id: 1 }] });
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await until(`!!document.querySelector('[data-testid="minimap"]')`, 'HUD', 120000);
  await delay(1600);
  await evaluate(`(()=>{const mods=[...__r.getModules().values()].filter(m=>m.isInitialized).map(m=>m.publicModule.exports);
    globalThis.qa={g:mods.find(m=>m&&m.getGame).getGame(),store:mods.find(m=>m&&m.useGameStore).useGameStore,
      input:mods.find(m=>m&&m.setJoystickInput),pres:mods.find(m=>m&&m.makeProjectors)};
    const g=qa.g;
    g.weather.force('clear',3600);g.dayNight.t=.5;g.player.invulnUntil=Infinity;
    // Nada de pingo roxo no meio do painel: o miolo #f9f5ff do marcador de GPS tem a mesma tinta
    // do jogador e deslocaria o centroide procurado.
    qa.store.clearMapMarker();
    qa.box=()=>{const w=document.querySelector('[data-testid="minimap"]');
      const c=[...w.children].find(el=>getComputedStyle(el).overflow==='hidden');
      const r=c.getBoundingClientRect();
      return{x:+r.x.toFixed(2),y:+r.y.toFixed(2),width:+r.width.toFixed(2),height:+r.height.toFixed(2)};};
    // O que o componente está desenhando agora, lido direto na fibra do MapCanvas.
    qa.props=()=>{const w=document.querySelector('[data-testid="minimap"]');
      const k=Object.keys(w).find(k=>k.startsWith('__reactFiber$'));const pilha=[w[k]];
      while(pilha.length){const f=pilha.pop();if(!f)continue;
        if(f.type&&f.type.name==='MapCanvas')return{mapW:f.memoizedProps.mapW,mapH:f.memoizedProps.mapH,
          zoom:f.memoizedProps.zoom,panX:+f.memoizedProps.panX.toFixed(2),panY:+f.memoizedProps.panY.toFixed(2)};
        if(f.child)pilha.push(f.child);if(f.sibling)pilha.push(f.sibling);}
      return null};
    // A projeção do produto, sem pan e sem zoom: é dela que o MiniMap tira o pan do radar.
    qa.centro=(p)=>{const g=qa.g;p=p||qa.props();
      const s=qa.pres.makeProjectors(p.mapW,p.mapH,0,g.map.data.tilesW,g.map.data.tilesH,1,0,0)
        .worldToScreen(g.worldPosition.x,g.worldPosition.y);
      return{x:+s.x.toFixed(2),y:+s.y.toFixed(2)};};
    // As três leituras no MESMO instante de JS: pan, projeção e estado. Lidas separadas, o
    // jogador anda entre elas e a comparação do pan viraria falso positivo.
    qa.leitura=()=>{const p=qa.props(),g=qa.g,pos=g.worldPosition;
      const base=qa.pres.makeProjectors(p.mapW,p.mapH,0,g.map.data.tilesW,g.map.data.tilesH,1,0,0);
      return{props:p,centro:qa.centro(p),pxPorTile:+(base.scale*p.zoom).toFixed(3),
        estado:{x:+pos.x.toFixed(2),y:+pos.y.toFixed(2),
          sala:!!g.interiors.active,veiculo:g.player.currentVehicleId!==null,
          explorado:+g.exploration.percent.toFixed(2),
          noTile:g.exploration.isExplored(Math.floor(pos.x),Math.floor(pos.y))}};};
    // Fração da JANELA que é terra nunca visitada, medida em tiles do mundo. A conta é a
    // projeção iso da casa refeita aqui de fora: Δtela = ΔmapPoint × escala.
    qa.janela=()=>{const g=qa.g,p=qa.props(),m0=qa.pres.mapPoint(g.worldPosition.x,g.worldPosition.y,
        g.map.data.tilesH),base=qa.pres.makeProjectors(p.mapW,p.mapH,0,g.map.data.tilesW,
        g.map.data.tilesH,1,0,0),escala=base.scale*p.zoom;
      let total=0,disc=0;
      for(let tx=-45;tx<=45;tx++)for(let ty=-45;ty<=45;ty++){
        const x=Math.floor(g.worldPosition.x)+tx,y=Math.floor(g.worldPosition.y)+ty;
        if(x<0||y<0||x>=g.map.data.tilesW||y>=g.map.data.tilesH)continue;
        const m=qa.pres.mapPoint(x+.5,y+.5,g.map.data.tilesH);
        if(Math.abs((m.x-m0.x)*escala)>p.mapW/2||Math.abs((m.y-m0.y)*escala)>p.mapH/2)continue;
        total++;if(g.exploration.isExplored(x,y))disc++;}
      return{tiles:total,naoDescobertos:+(1-disc/total).toFixed(3),pxPorTile:+escala.toFixed(3),
        tilesNaDiagonal:+(p.mapW/escala*Math.SQRT2).toFixed(1)};};
    // Terra seca que o jogador nunca pisou, longe de casa e fora de prédio. Desmonta antes: o
    // painel do condutor segue o corpo, e o corpo continua na garagem se o carro não for solto.
    // worldPosition devolve o próprio objeto do jogador, então a origem é copiada — senão o
    // teletransporte reescreve a régua que acabou de ser medida.
    qa.salto=()=>{const g=qa.g,p={x:g.worldPosition.x,y:g.worldPosition.y};
      if(g.player.currentVehicleId!==null){g.player.currentVehicleId=null;g.player.state='idle';}
      for(let r=34;r<90;r+=2)for(let a=0;a<24;a++){
        const x=Math.round(p.x+Math.cos(a/24*6.283)*r),y=Math.round(p.y+Math.sin(a/24*6.283)*r);
        if(x<6||y<6||x>=g.map.data.tilesW-6||y>=g.map.data.tilesH-6)continue;
        if(g.map.isWaterWorld(x+.5,y+.5))continue;
        if(g.map.data.buildings.some(b=>Math.hypot(b.x-x-.5,b.y-y-.5)<2.2))continue;
        if(g.exploration.isExplored(x,y))continue;
        g.player.x=x+.5;g.player.y=y+.5;g.player.vx=0;g.player.vy=0;
        g.camera.x=x+.5;g.camera.y=y+.5;g.camera.h=g.map.heightSmoothAt(x+.5,y+.5);
        g.notifyEntityChange();
        return{x,y,de:+Math.hypot(x-p.x,y-p.y).toFixed(1)};}};
    // Embarque/desembarque pelos sistemas do próprio jogo, para o teste não inventar um estado
    // de veículo que a simulação ignore — foi assim que a primeira versão ficou 0 tiles andando.
    // O pedal NÃO vem aqui dentro: montar o motorista remonta os pedais do HUD, e essa remontagem
    // roda depois, no flush do React, com o carro parado. Apertar no mesmo tick do embarque é o
    // mesmo que soltar — por isso qa.acelerar() é uma chamada separada, após o render assentar.
    qa.embarcar=(id)=>{const g=qa.g,v=g.vehicles.find(v=>v.id===id);
      if(!v||v.state==='destroyed'||!v.def.driveable)return null;
      // Já estou dentro: não tem o que remontar, o pedal vem na chamada seguinte mesmo.
      if(g.player.currentVehicleId===v.id)return{id:v.id,tipo:v.def.type,state:v.state};
      g.player.x=v.x;g.player.y=v.y;g.camera.x=v.x;g.camera.y=v.y;
      g.camera.h=g.map.heightSmoothAt(v.x,v.y);
      g.vehicleSystem.enterVehicle(g.player,v);
      if(g.player.currentVehicleId!==v.id)return null;
      g.trafficSystem.takeOver(v.id);g.notifyEntityChange();
      return{id:v.id,tipo:v.def.type,state:v.state};};
    qa.descer=()=>{qa.pedal(false);const g=qa.g,v=g.vehicles.find(v=>v.id===g.player.currentVehicleId);
      if(v)g.vehicleSystem.exitVehicle(g.player,v,g.map,g.collision);
      else{g.player.currentVehicleId=null;g.player.state='idle';}
      g.camera.x=g.player.x;g.camera.y=g.player.y;g.notifyEntityChange();};
    // A pé o analógico manda; ao volante o jogo lê pedal e volante, e é isso que precisa ser
    // apertado aqui — com o joystick o carro fica parado e o teste não mediria velocidade.
    qa.pedal=(ligado)=>{qa.input.setVehicleControl('accel',ligado);qa.input.setVehicleControl('brake',false);};
    qa.acelerar=async()=>{await new Promise((r)=>setTimeout(r,250));qa.pedal(true);
      return qa.input.inputState.vehicleAccel;};
    })()`);

  const box = await evaluate('qa.box()');
  assert.ok(box.width >= 78 && box.width <= 92, `o painel do radar não é o quadrado esperado: ${box.width}x${box.height}`);
  // O miolo, fora da moldura de 1,5px: é aí que a cor do mapa é lida. O centro do painel é o
  // mesmo dos dois jeitos, porque a moldura é simétrica.
  const miolo = { x: box.x + MOLDURA, y: box.y + MOLDURA,
    width: Math.round(box.width) - MOLDURA * 2, height: Math.round(box.height) - MOLDURA * 2 };
  const centro = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  console.log('recorte do radar:', JSON.stringify(box), 'miolo medido:', JSON.stringify(miolo));

  async function amostra(rotulo) {
    const l = await evaluate('qa.leitura()');
    assert.equal(l.props.zoom, ZOOM_RADAR, `o radar não está no zoom do produto: ${l.props.zoom}`);
    const png = await frame('qa-radar-' + rotulo);
    return { rotulo, ...l, vazio: vazio(png, miolo), pingo: pingo(png, miolo) };
  }
  /** As invariantes do "onde eu estou": setinha no meio, pan honesto, chão debaixo do pé. */
  function conferePingo(s, folga = 0) {
    assert.ok(s.pingo.n >= 8, `${s.rotulo}: só ${s.pingo.n}px de jogador no radar — painel em branco`
      + ' é exatamente a queixa original');
    const dx = Math.abs(s.pingo.cx - centro.x), dy = Math.abs(s.pingo.cy - centro.y);
    assert.ok(dx <= 2 && dy <= 2, `${s.rotulo}: o pingo está em (${s.pingo.cx},${s.pingo.cy}) quando o centro`
      + ` do painel na tela é (${centro.x.toFixed(1)},${centro.y.toFixed(1)}) — desvio de ${dx}/${dy}px`);
    const esperado = { x: +((s.props.mapW / 2 - s.centro.x) * s.props.zoom).toFixed(2),
      y: +((s.props.mapH / 2 - s.centro.y) * s.props.zoom).toFixed(2) };
    // O pan lido na fibra é o do ÚLTIMO render do radar; a posição é a de agora. Entre um e outro
    // passa até um tick (RADAR_TICK), então a folga legítima é o quanto o corpo anda em um tick —
    // a pé isso é meio pixel, em veículo é alguns. O que não pode é divergir de forma sistemática.
    const tol = 1.5 + folga;
    const desvio = Math.max(Math.abs(s.props.panX - esperado.x), Math.abs(s.props.panY - esperado.y));
    assert.ok(desvio <= tol, `${s.rotulo}: o radar recebeu pan(${s.props.panX},${s.props.panY}) e a projeção`
      + ` deste mesmo ponto pediria (${esperado.x},${esperado.y}) — ${desvio.toFixed(2)}px de diferença,`
      + ` folga de ${tol.toFixed(2)}px, com ${s.pxPorTile}px por tile do mundo`);
    assert.ok(s.pingo.fundo <= 0.12, `${s.rotulo}: ${Math.round(s.pingo.fundo * 100)}% do que cerca o pingo`
      + ' é cinza de nunca-visitado: o jogador está desenhado sobre o vazio');
    assert.ok(s.vazio.frac <= 0.12, `${s.rotulo}: o painel é ${(s.vazio.frac * 100).toFixed(1)}% de vazio`
      + ` (não explorado ${(s.vazio.ne * 100).toFixed(1)}%, fundo ${(s.vazio.bg * 100).toFixed(1)}%)`
      + ' — antes da correção eram 67,3%');
  }
  function relatorio(s) {
    return `  ${s.rotulo.padEnd(11)} pos(${s.estado.x},${s.estado.y}) ${s.estado.veiculo ? 'dirigindo' : 'a pé'}`
      + ` | pan(${s.props.panX},${s.props.panY}) | pingo(${s.pingo.cx},${s.pingo.cy}) n=${s.pingo.n}`
      + ` | vazio ${(s.vazio.frac * 100).toFixed(1)}% do painel, ${Math.round((s.pingo.fundo ?? 1) * 100)}% em volta`
      + ' do pingo';
  }
  /** Um passo de observação × 1,5: a distância que o corpo percorre dentro de um tick do radar. */
  function folgaDaSerie(serie) {
    let passo = 0;
    for (let i = 1; i < serie.length; i++) {
      passo = Math.max(passo, Math.hypot(serie[i].estado.x - serie[i - 1].estado.x,
        serie[i].estado.y - serie[i - 1].estado.y));
    }
    return +(passo * serie[0].pxPorTile * 1.5).toFixed(2);
  }

  // ------------------------------------------------------ 1. parado, no ponto de partida
  const parado = await amostra('parado');
  console.log('alcance do radar:', JSON.stringify(await evaluate('qa.janela()')));
  await test('o pingo do jogador mora no centro do radar', () => conferePingo(parado));
  await test('o radar não é um painel de névoa já no ponto de partida', async () => {
    console.log(relatorio(parado));
    const j = await evaluate('qa.janela()');
    console.log(`  janela: ${(j.naoDescobertos * 100).toFixed(0)}% dos ${j.tiles} tiles (${j.tilesNaDiagonal}`
      + ` tiles na diagonal) nunca foram visitados · ${(parado.vazio.frac * 100).toFixed(1)}% do painel é`
      + ' o cinza do vazio');
    // Sem terra desconhecida na janela o teste abaixo não provaria nada sobre a névoa.
    assert.ok(j.naoDescobertos >= 0.5, `a janela do radar só tem ${(j.naoDescobertos * 100).toFixed(0)}%`
      + ' de terra nunca visitada: o controle da névoa perdeu o sentido');
  });

  // ------------------------------------------------------ 2. andando com o analógico
  await evaluate('qa.input.setJoystickInput(1,-1,1)');
  const andadas = [];
  for (let i = 0; i < 6; i++) { await delay(320); andadas.push(await amostra('andar' + i)); }
  await evaluate('qa.input.resetJoystickInput()');
  await test('andando, o radar acompanha o jogador sem perder o pingo do centro', () => {
    const primeiro = andadas[0], ultimo = andadas[andadas.length - 1];
    const metros = Math.hypot(ultimo.estado.x - primeiro.estado.x, ultimo.estado.y - primeiro.estado.y);
    console.log(`  trajeto a pé: (${primeiro.estado.x},${primeiro.estado.y}) → (${ultimo.estado.x},${ultimo.estado.y}),`
      + ` ${metros.toFixed(1)} tiles · explorado ${primeiro.estado.explorado}% → ${ultimo.estado.explorado}%`);
    assert.ok(metros >= 0.4, `o analógico não moveu o jogador (${metros.toFixed(2)} tiles):`
      + ' sem movimento a perseguição não estaria sendo testada');
    andadas.forEach(relatorio);
    const folga = folgaDaSerie(andadas);
    console.log(`  um tick do radar percorre até ${folga}px de mapa a este ritmo`);
    for (const s of andadas) conferePingo(s, folga);
  });

  // ------------------------------------------------------ 3. dirigindo
  // A velocidade é onde a rolagem do radar mais cobra o preço: a pé o mapa anda meio pixel por
  // tick, de carro ele atravessa o painel. Por isso o teste não aceita "entrei e nada andou" —
  // ele experimenta a frota até achar um veículo que responda ao pedal neste harness.
  const frota = await evaluate(`(()=>qa.g.vehicles.filter(v=>v.state!=='destroyed').slice(0,6)
    .map(v=>({id:v.id,tipo:v.def.type})))()`);
  let dirigido = null;
  const sondados = [];
  for (const c of frota) {
    const embarcou = await evaluate(`qa.embarcar(${c.id})`);
    if (!embarcou) continue;
    // Pedal depois do flush do HUD, e só então a aceleração tem 1,1s para virar velocidade.
    const pedal = await evaluate('qa.acelerar()');
    await delay(1100);
    const antes = await evaluate('qa.leitura()');
    await delay(1100);
    const depois = await evaluate('qa.leitura()');
    const detalhe = await evaluate(`(()=>{const g=qa.g,v=g.vehicles.find(v=>v.id===${c.id});
      return{vid:g.player.currentVehicleId,vstate:v?v.state:null,speed:v?+v.speed.toFixed(2):null,
        acel:qa.input.inputState.vehicleAccel,pstate:g.player.state,paused:g.paused};})()`);
    const ando = Math.hypot(depois.estado.x - antes.estado.x, depois.estado.y - antes.estado.y);
    sondados.push(`${embarcou.tipo}#${c.id}: ${ando.toFixed(1)} tiles pedal=${pedal} ${JSON.stringify(detalhe)}`);
    if (ando >= 1) { dirigido = { ...embarcou, andado: +ando.toFixed(1) }; break; }
    await evaluate('qa.descer()');
  }
  await evaluate('qa.pedal(false)');
  console.log('frota sondada:', sondados.join(' · '), '| escolhido:', JSON.stringify(dirigido));
  await test('dentro de um veículo o radar continua legível e centrado', async () => {
    assert.ok(dirigido, `nenhum veículo andou com o pedal pressionado (${sondados.join(', ')}):`
      + ' sem velocidade o radar em movimento não estaria sendo testado');
    await evaluate(`qa.embarcar(${dirigido.id})`);
    await evaluate('qa.acelerar()');
    const amostras = [];
    for (let i = 0; i < 4; i++) { await delay(300); amostras.push(await amostra('carro' + i)); }
    await evaluate('qa.pedal(false)');
    const vel = await evaluate(`(()=>{const v=qa.g.vehicles.find(v=>v.id===${dirigido.id});
      return v?+Math.abs(v.speed).toFixed(2):null})()`);
    const percorrido = Math.hypot(amostras[3].estado.x - amostras[0].estado.x,
      amostras[3].estado.y - amostras[0].estado.y);
    amostras.forEach(relatorio);
    const folga = folgaDaSerie(amostras);
    for (const s of amostras) {
      assert.equal(s.estado.veiculo, true, `${s.rotulo}: o jogador saiu do veículo no meio do teste`);
      conferePingo(s, folga);
    }
    console.log(`  dirigindo ${dirigido.tipo}: velocidade ${vel} tiles/s, ${percorrido.toFixed(1)} tiles`
      + ` nos 1,2s de amostragem · folga de um tick ${folga}px · vazio máximo`
      + ` ${(Math.max(...amostras.map((s) => s.vazio.frac)) * 100).toFixed(1)}%`);
    await evaluate('qa.descer()');
  });

  // ------------------------------------------------------ 4. salto para terra nunca visitada
  // O caso mais duro do bug: longe de qualquer rastro o painel era 100% cinza. É também o relógio
  // do RADAR_TICK — se o radar não redrawasse em menos de 900ms, a setinha ficaria no lugar velho.
  const salto = await evaluate('qa.salto()');
  assert.ok(salto, 'não havia terra seca nunca visitada a mais de 30 tiles do jogador');
  await delay(900);
  const longe = await amostra('desconhecido');
  await test('em terra que você nunca pisou o radar mostra a terra, apagada', async () => {
    const j = await evaluate('qa.janela()');
    console.log(relatorio(longe));
    console.log(`  salto para (${salto.x},${salto.y}), ${salto.de} tiles de casa · janela ainda`
      + ` ${(j.naoDescobertos * 100).toFixed(0)}% nunca visitada`);
    assert.equal(longe.estado.sala, false, 'o jogador caiu dentro de uma sala: o painel virou planta');
    assert.ok(j.naoDescobertos >= 0.5, `a janela do salto tem só ${(j.naoDescobertos * 100).toFixed(0)}%`
      + ' de terra desconhecida: o salto não saiu do que já foi explorado');
    conferePingo(longe);
  });

  // ------------------------------------------------------ 5. o mapa cheio ainda esconde
  let cheio = null;
  await test('no mapa cheio a névoa continua sendo recompensa de explorar', async () => {
    await evaluate('qa.store.openMap()');
    await until(`!!document.querySelector('[data-testid="full-map"]')`, 'mapa cheio', 20000);
    await delay(1100);
    const png = await frame('qa-radar-mapa-cheio');
    cheio = vazio(png, { x: 0, y: 0, width: VW, height: VH });
    const pct = await evaluate(`(()=>{const el=document.querySelector('[data-testid="map-explored"]');
      return el?el.textContent:null})()`);
    console.log(`  mapa cheio: ${(cheio.ne * 100).toFixed(1)}% do quadro é névoa · ${pct} explorado`);
    assert.ok(cheio.ne >= 0.4, `o mapa cheio perdeu a névoa: só ${(cheio.ne * 100).toFixed(1)}% de não explorado`);
    assert.ok(cheio.ne > longe.vazio.ne + 0.2, 'radar e mapa cheio desenhando a mesma coisa: a assimetria'
      + ` se perdeu (${(longe.vazio.ne * 100).toFixed(1)}% contra ${(cheio.ne * 100).toFixed(1)}%)`);
  });
  await evaluate('qa.store.closeMap()');
  await until('!document.querySelector(\'[data-testid="full-map"]\')', 'fechar o mapa', 20000);
  const deVolta = await amostra('de-volta');
  await test('fechado o mapa, o radar volta a ser legível', () => {
    console.log(relatorio(deVolta));
    conferePingo(deVolta);
  });

  await test('nada mais quebrou no caminho', async () => {
    const hud = await evaluate('document.body.innerText');
    assert.match(hud, /HP \d+/, 'a HUD sumiu');
    assert.match(hud, /RADAR/, 'o rótulo do radar sumiu do painel');
    assert.deepEqual(errors, [], 'erros na página:\n' + errors.slice(0, 6).join('\n'));
  });

  console.log(`\nRadar e névoa no navegador: ${passado} passed, ${falhou} failed.`);
  if (falhou) process.exitCode = 1;
  socket.close();
})().catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => socket?.close());
