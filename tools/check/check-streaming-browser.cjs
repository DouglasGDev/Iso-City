// Run: node tools/check/check-streaming-browser.cjs (precisa do Expo web em :8082 e Chrome em :9223).
//
// O streaming na tela de verdade. `check-streaming.cjs` prova a matemática das zonas e do índice
// em memória; aqui o que se mede é o pipeline inteiro, com Skia, React e o GameLoop rodando:
// câmera → chunk → nós residentes → recorte fino → pixel. As perguntas que só a resposta é do
// navegador conseguem fazer:
//
// §14/§21 — existe pop-in? A resposta honesta não é "acha que não": é contar, a cada amostra,
// todo estático que mora num chunk VISÍVEL e tem sprite carregado, e ver quantos deles não
// estavam no desenho daquela passada. Um único pixel faltando de prédios é um buraco na cidade.
// §16 — revisitar a mesma quadra reconstrói exatamente o mesmo conjunto de nós?
// §5 — o pedestre longe da câmera realmente para, e o que volta trás o estado junto?
// §15/§17 — quantos prédios a tela desenha de fato, contra os 4.4xx que existem no mapa.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PNG } = require('pngjs');
const WebSocket = require('ws');

const PORT = Number(process.env.QA_CDP_PORT || 9223);
const METRO = process.env.QA_METRO_PORT || 8082;
const VW = 844, VH = 390;
const DIRIGINDO_MS = 26000;
const AMOSTRA_MS = 100;

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
async function until(expression, label, timeout = 60000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try { if (await evaluate(expression)) return; } catch { /* página trocando */ }
    await delay(60);
  }
  throw new Error('Timed out: ' + label);
}
async function shot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  const buf = Buffer.from(data, 'base64');
  fs.writeFileSync(path.resolve(__dirname, '../tmp/' + name + '.png'), buf);
  return PNG.sync.read(buf);
}
/** Média de luminância e de cor da caixa pedida: é o retrato do que a cidade está desenhando. */
function caixa(png, cx, cy, rx, ry) {
  let lum = 0, n = 0, r = 0, g = 0, b = 0;
  const x0 = Math.max(0, Math.floor(cx - rx)), x1 = Math.min(png.width - 1, Math.ceil(cx + rx));
  const y0 = Math.max(0, Math.floor(cy - ry)), y1 = Math.min(png.height - 1, Math.ceil(cy + ry));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const k = (png.width * y + x) << 2;
      r += png.data[k]; g += png.data[k + 1]; b += png.data[k + 2];
      lum += 0.2126 * png.data[k] + 0.7152 * png.data[k + 1] + 0.0722 * png.data[k + 2];
      n++;
    }
  }
  return { n, lum: lum / n, r: r / n, g: g / n, b: b / n };
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
  await send('Page.navigate', { url: `http://localhost:${METRO}/?streaming-qa=1` });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await until(`!!document.querySelector('[data-testid="menu-new"],[data-testid="menu-play"]')
    || !!document.body?.innerText.match(/JOGAR|NOVO JOGO/)`, 'menu', 240000);
  await delay(600);
  const botao = await evaluate(`(()=>{const b=document.querySelector('[data-testid="menu-new"]')
    ||document.querySelector('[data-testid="menu-play"]');
    if(!b)return null;const r=b.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  assert.ok(botao, 'nenhum botão de jogar no menu');
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...botao, id: 1 }] });
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await until('document.body.innerText.includes("HP 100")', 'HUD', 120000);

  await evaluate(`(() => {
    const mods = [...__r.getModules().values()].filter((m) => m.isInitialized).map((m) => m.publicModule.exports);
    const g = mods.find((m) => m && m.getGame).getGame();
    globalThis.qa = {
      g,
      cfg: mods.find((m) => m && m.GAME_CONFIG).GAME_CONFIG,
      nodes: mods.find((m) => m && m.staticNodesFor).staticNodesFor,
      reg: mods.find((m) => m && m.buildingKey && m.propKey),
      sprites: mods.find((m) => m && m.spriteStore).spriteStore,
      input: mods.find((m) => m && m.setVehicleControl),
    };
    const q = globalThis.qa;
    // Cena controlada: sem susto de clima, de bicho ou da rua enquanto se mede o recorte. O
    // procurado fica zerado porque perseguição move a câmera e moveria as zonas junto.
    q.cena = () => { g.player.invulnUntil = Infinity; g.dayNight.t = 0.5;
      g.weather.force('clear', 3600); g.hazard.cooldown = 1e9;
      g.wanted.clear(g.player); g.police.reset(); };
    // A âncora do teste é o player, e a câmera dele é lerpada: estaciona os dois no mesmo
    // ponto para que duas passadas pelo mesmo lugar sejam, de fato, o mesmo lugar.
    q.parar = (x, y, zoom) => { g.player.x = x; g.player.y = y; g.player.vx = 0; g.player.vy = 0;
      g.camera.x = x; g.camera.y = y; g.camera.h = g.map.heightSmoothAt(x, y);
      if (zoom) g.camera.zoom = zoom; g.notifyEntityChange(); };
    /**
     * O oráculo do pop-in. Reconstrói, sem olhar o cache, a conta "o que devia estar desenhado":
     * todo estático dos chunks VISÍVEIS cujo sprite já chegou. Depois compara com o que o
     * pipeline devolveu nesta passada. O campo "falta" é literalmente prédios e árvores
     * invisíveis.
     */
    q.oraculo = () => {
      const idx = g.streaming.index, data = g.map.data;
      const esperado = new Set();
      for (const id of g.streaming.visibleChunks) {
        for (const i of idx.buildingsByChunk[id]) {
          if (q.sprites[q.reg.buildingKey(data.buildings[i].key)]) esperado.add('building:' + i);
        }
        for (const i of idx.propsByChunk[id]) {
          if (q.sprites[q.reg.propKey(data.props[i].key)]) esperado.add('prop:' + i);
        }
      }
      const presentes = new Set(q.nodes(g, g.streaming).map((n) => n.id));
      let falta = 0;
      for (const id of esperado) if (!presentes.has(id)) falta++;
      const s = g.streaming.stats;
      return { falta, esperado: esperado.size, IDs: [...esperado].sort().join(','),
        cx: g.camera.x, cy: g.camera.y,
        chunks: g.streaming.visibleChunks.length, precisos: g.streaming.neededChunks.length,
        carregados: s.loadedChunks, residentes: s.staticNodes, desenhados: s.drawnStatics,
        visiveis: s.visibleEntities, ativos: s.simulatedEntities, pedestres: s.activeNpcs,
        total: s.totalEntities, fps: s.fps, quadro: s.frameMs, loop: s.updateMs, corte: s.cullMs };
    };
    /**
     * Frota que presta: nem todo carro estacionado responde ao pedal. Um deles está de focinho
     * na parede e anda zero tiles, e uma corrida parada deixaria de medir travessia sem que
     * nenhuma asserção percebesse. Então se experimenta a fila até o veículo acelerar de fato,
     * do mesmo jeito que o check do radar faz.
     */
    q.candidatos = () => g.vehicles
      .filter((v) => v.state !== 'destroyed')
      .map((v) => ({ id: v.id, tipo: v.def.type, d: Math.hypot(v.x - g.player.x, v.y - g.player.y) }))
      .sort((a, b) => a.d - b.d).slice(0, 10);
    q.embarcar = (id) => {
      const v = g.vehicles.find((x) => x.id === id);
      if (!v) return null;
      g.player.x = v.x + 0.7; g.player.y = v.y;
      g.vehicleSystem.enterVehicle(g.player, v);
      g.trafficSystem.takeOver(v.id);
      q.carro = v;
      return v.def.type;
    };
    // O pedal é chamada separada do embarque: montar o motorista remonta os pedais do HUD, e
    // apertar no mesmo tick é segurar um botão que ainda está sendo desmontado.
    q.pedal = (ligado) => { q.input.setVehicleControl('accel', ligado); q.input.setVehicleControl('brake', false); };
    q.volante = (lado, ligado) => q.input.setVehicleControl(lado, ligado);
    q.velocidade = () => (q.carro ? +Math.abs(q.carro.speed).toFixed(2) : 0);
    q.solta = () => { if (q.carro) { q.input.setVehicleControl('accel', false); q.input.setVehicleControl('brake', false); } };
    /** Desce do carro pelo sistema do jogo: parado dentro do carro, o player volta para o
     *  carro a cada tick e nenhum teleporte de teste seguraria a câmera no ponto pedido. */
    q.sairDoCarro = () => { if (g.player.currentVehicleId !== null && q.carro)
      g.vehicleSystem.exitVehicle(g.player, q.carro, g.map, g.collision); q.solta(); };
    /**
     * Empurra tudo que se mexe para 60 tiles do ponto medido, guardando de onde tirou.
     * Estacionar no canto do mapa deixaria a cidade sem pedestre nenhum para as medidas
     * seguintes; aqui a praça fica limpa para a foto e o mundo volta a ser o que era.
     */
    q.estacionaTudo = (cx, cy) => {
      q.guardado = [];
      const afasta = (o) => {
        q.guardado.push({ o, x: o.x, y: o.y });
        const dx = o.x - cx, dy = o.y - cy, d = Math.hypot(dx, dy) || 1;
        o.x = Math.max(4, Math.min(g.map.worldW - 4, cx + (dx / d) * 60));
        o.y = Math.max(4, Math.min(g.map.worldH - 4, cy + (dy / d) * 60));
      };
      for (const n of g.npcs) if (!n.inVehicle) afasta(n);
      for (const a of g.wildlife.animals) afasta(a);
      for (const v of g.vehicles) if (v.state !== 'destroyed') { afasta(v); v.speed = 0; }
    };
    q.devolve = () => { for (const s of q.guardado || []) { s.o.x = s.x; s.o.y = s.y; } q.guardado = []; };
    q.tudoCarregado = () => g.streaming.stats.loadedChunks >= g.streaming.neededChunks.length;
  })()`);

  const cfg = await evaluate('({chunk:qa.cfg.CHUNK_SIZE, ativo:qa.cfg.ACTIVE_RADIUS_TILES, '
    + 'streaming:qa.cfg.STREAMING_RADIUS_TILES, limite:qa.cfg.CHUNK_CACHE_LIMIT, '
    + 'orcamento:qa.cfg.CHUNK_BUILD_BUDGET, cols:qa.g.streaming.index.cols, '
    + 'rows:qa.g.streaming.index.rows, total:qa.g.map.data.buildings.length+qa.g.map.data.props.length})');
  assert.equal(cfg.total > 4000, true, `o mapa precisa ter estáticos suficientes para o teste valer: ${cfg.total}`);
  console.log(`OK boot: cidade com ${cfg.total} estáticas em ${cfg.cols}x${cfg.rows} chunks de ${cfg.chunk} tiles `
    + `(ativo ${cfg.ativo}, streaming ${cfg.streaming}, teto ${cfg.limite}, orçamento ${cfg.orcamento}/passada)`);

  // ---- 1. A tela cheia de cidade desenha uma fração dela -------------------------------
  await evaluate('qa.cena()');
  const centro = await evaluate('({x:qa.g.player.x,y:qa.g.player.y})');
  await delay(2500);
  const parado = await evaluate('qa.oraculo()');
  assert.ok(parado.chunks > 0 && parado.esperado > 0, `a câmera precisa ter o que ver: ${JSON.stringify(parado)}`);
  assert.equal(parado.falta, 0, `nada pode faltar na tela com o mundo parado: ${JSON.stringify(parado)}`);
  assert.ok(parado.residentes < cfg.total * 0.6,
    `o cache residente deveria ser uma fração da cidade, não a cidade: ${parado.residentes}/${cfg.total}`);
  assert.ok(parado.pedestres > 0 && parado.pedestres < parado.total,
    `IA em camadas: pedestres simulados ${parado.pedestres} de ${parado.total} entidades`);
  console.log(`OK primeira leitura: ${parado.desenhados} estáticas na tela de ${cfg.total} no mundo `
    + `(${parado.chunks} chunks visíveis, ${parado.carregados}/${parado.precisos} carregados, `
    + `${parado.residentes} nós residentes), fps ${parado.fps}, corte ${parado.corte}ms, loop ${parado.loop}ms`);

  // ---- 2. Conduzir atravessando quadras: o anel nunca chega nu -------------------------
  // A travessia só vale se o carro andar de fato: encalhado atrás de um para-choque ele cobre
  // meio chunk em vinte segundos e as asserções abaixo não mediriam streaming nenhum. Então se
  // testa a frota até achar quem responda ao pedal, e o resto da corrida anda com esse.
  const fila = await evaluate('qa.candidatos()');
  assert.ok(fila.length >= 3, `a cidade precisa de frota para o teste dirigir: ${fila.length} veículos`);
  let motorista = null;
  const sondados = [];
  for (const c of fila) {
    if (motorista) continue;
    const tipo = await evaluate(`qa.embarcar(${c.id})`);
    if (!tipo) continue;
    await delay(320);
    await evaluate('qa.cena();qa.pedal(true)');
    const a = await evaluate('({x:qa.carro.x,y:qa.carro.y})');
    await delay(1500);
    const b = await evaluate('({x:qa.carro.x,y:qa.carro.y,v:qa.velocidade()})');
    const andado = Math.hypot(b.x - a.x, b.y - a.y);
    sondados.push(`${tipo}#${c.id}: ${andado.toFixed(1)} tiles, ${b.v} tiles/s`);
    // O limiar é a física do jogo, não um palpite: do zero, o veículo chega a ~3,1 tiles/s em
    // 1,5s, o que dá 3-4 tiles. Abaixo disso é carro encaixotado, acima é espera irreal.
    if (andado >= 2.5 && b.v >= 1.5) { motorista = { id: c.id, tipo, vel: b.v }; continue; }
    await evaluate('qa.solta();qa.sairDoCarro()');
  }
  assert.ok(motorista, `nenhum veículo respondeu ao pedal (${sondados.join(' · ')}) — sem travessia `
    + 'real não há como provar que o anel de streaming chega carregado');
  console.log(`OK motorista: ${motorista.tipo}#${motorista.id} a ${motorista.vel} tiles/s `
    + `(${sondados.length} veículos sondados)`);
  const partida = await evaluate('({x:qa.carro.x,y:qa.carro.y})');
  const amostras = [];
  // Travessia medida em células de chunk, não em tiles: o que se quer provar é que a corrida
  // entrou em quadras novas, e quadra é exatamente a unidade do streaming.
  const celulas = new Set();
  const fim = Date.now() + DIRIGINDO_MS;
  let manobras = 0;
  let semAvanco = 0;
  while (Date.now() < fim) {
    const amostra = await evaluate('qa.oraculo()');
    const anterior = amostras[amostras.length - 1];
    amostras.push(amostra);
    celulas.add(`${Math.floor(amostra.cx / cfg.chunk)},${Math.floor(amostra.cy / cfg.chunk)}`);
    if (anterior && Math.hypot(amostra.cx - anterior.cx, amostra.cy - anterior.cy) < 0.05) semAvanco++;
    else semAvanco = 0;
    // Preso no trânsito não é teste: dá ré, vira o volante e volta a acelerar, para a corrida
    // continuar sendo travessia em vez de uma foto do mesmo quarteirão.
    if (semAvanco >= 8) {
      manobras++;
      semAvanco = 0;
      await evaluate('qa.pedal(false);qa.volante("brake", true)');
      await delay(650);
      await evaluate('qa.volante("brake", false);qa.volante("right", true)');
      await delay(750);
      await evaluate('qa.volante("right", false);qa.pedal(true)');
      continue;
    }
    await delay(AMOSTRA_MS);
  }
  await evaluate('qa.solta()');
  const dist = await evaluate(`Math.hypot(qa.carro.x-${partida.x},qa.carro.y-${partida.y}).toFixed(1)`);
  const movidas = amostras.filter((a) => a.esperado > 0);
  assert.ok(movidas.length >= 20, `a corrida precisa de amostras com tela cheia: ${movidas.length}`);
  const nus = movidas.filter((a) => a.falta > 0);
  const pior = movidas.reduce((m, a) => Math.max(m, a.falta), 0);
  const mediaEsperado = movidas.reduce((s, a) => s + a.esperado, 0) / movidas.length;
  console.log(`OK condução: ${dist} tiles e ${celulas.size} células de chunk atravessadas em ${movidas.length} `
    + `amostras (${manobras} manobras de ré), `
    + `${nus.length} com chunk visível incompleto (pior ${pior} de ~${mediaEsperado.toFixed(0)} esperados), `
    + `residentes ${Math.min(...movidas.map((a) => a.residentes))}-${Math.max(...movidas.map((a) => a.residentes))}, `
    + `fps ${Math.min(...movidas.map((a) => a.fps))}-${Math.max(...movidas.map((a) => a.fps))}, `
    + `corte ${Math.max(...movidas.map((a) => a.corte))}ms`);
  assert.ok(celulas.size >= 4,
    `a corrida não foi travessia nenhuma: só ${celulas.size} célula(s) de chunk em ${dist} tiles `
    + `(${manobras} manobras) — o streaming de condução não foi medido`);
  assert.equal(nus.length, 0, `pop-in de verdade: ${nus.length} de ${movidas.length} amostras desenhando menos do que o visível pede `
    + `(pior ${pior} faltando). Primeira: ${JSON.stringify(nus[0] || {})}`);
  const teto = await evaluate('qa.g.streaming.stats.loadedChunks');
  assert.ok(teto <= cfg.limite, `o cache passou do teto de chunks: ${teto} > ${cfg.limite}`);
  await evaluate('qa.sairDoCarro()');

  // ---- 3. Salto longo: o pior caso, uma quadra nova por vez ----------------------------
  const paradas = [];
  for (let k = 0; paradas.length < 8 && k < 24; k++) {
    // Cai em cima de um adorno: chão seco garantido e conteúdo para desenhar, e o salto de
    // dezenas de tiles de uma vez é mais brusco do que qualquer veículo consegue ser.
    const alvo = await evaluate(`(() => {const g=qa.g;
      const p=g.map.data.props[Math.floor(Math.random()*g.map.data.props.length)];
      if(g.map.isWaterWorld(p.x,p.y))return null;
      qa.parar(p.x,p.y); qa.cena(); return {x:p.x,y:p.y};})()`);
    if (!alvo) continue;
    await until('qa.tudoCarregado()', `anel completo em ${JSON.stringify(alvo)}`, 20000);
    await delay(250);
    const lido = await evaluate('qa.oraculo()');
    assert.equal(lido.falta, 0, `salto ${k}: chunk visível nu em ${JSON.stringify(alvo)} → ${JSON.stringify(lido)}`);
    paradas.push({ ...alvo, ...lido });
  }
  assert.ok(paradas.length >= 4, `saltos demais caíram em água: ${paradas.length}`);
  console.log(`OK saltos longos: ${paradas.length} quadras novas atingiram o anel completo sem um único nó faltando `
    + `(mais lento ${Math.max(...paradas.map((p) => p.esperado))} esperados por tela)`);

  // ---- 4. Revisitar: o mesmo lugar volta a ser o mesmo lugar (§16) ---------------------
  // O ponto de volta é a parada com mais cidade na tela: é nela que o §5 tira a foto, e
  // quanto mais prédio no quadro, menos a comparação vira sorteio de pixel.
  const ida = paradas.slice().sort((a, b) => b.esperado - a.esperado)[0];
  await evaluate(`qa.parar(${ida.x},${ida.y});qa.cena()`);
  await until('qa.tudoCarregado()', 'primeira passada do revisitado', 20000);
  await delay(300);
  const lidoAntes = await evaluate('qa.oraculo()');
  const nomesAntes = lidoAntes.IDs;
  const idsAntes = new Set(nomesAntes.split(','));
  assert.ok(idsAntes.size > 5, `o ponto revisitado tem pouco conteúdo para provar alguma coisa: ${idsAntes.size}`);
  // Vai para o outro lado da cidade: os chunks dali saem do conjunto necessário e o cache
  // devolve os nós — é assim que se prova que a volta reconstrói, e não que nunca foi embora.
  const longe = await evaluate(`(() => {const g=qa.g; let best=null;
    for (let i=0;i<g.map.data.props.length;i+=7) { const p=g.map.data.props[i];
      const d=Math.hypot(p.x-${ida.x},p.y-${ida.y}); if (!best||d>best.d) best={x:p.x,y:p.y,d}; }
    qa.parar(best.x,best.y); return best;})()`);
  assert.ok(longe.d > 60, `o outro lado da cidade não é tão longe: ${longe.d.toFixed(0)} tiles`);
  await until('qa.tudoCarregado()', 'anel do outro lado da cidade', 25000);
  await delay(500);
  const noLongo = await evaluate('qa.oraculo()');
  assert.ok(!noLongo.IDs.split(',').some((id) => idsAntes.has(id)),
    'a varredura de cache não devolveu os chunks antigos quando eles saíram da área de streaming');
  await evaluate(`qa.parar(${ida.x},${ida.y})`);
  await until('qa.tudoCarregado()', 'anel de volta ao ponto visitado', 25000);
  await delay(400);
  const depois = await evaluate('qa.oraculo()');
  assert.equal(depois.IDs, nomesAntes, 'revisitar a quadra não reconstruiu o mesmo conjunto de nós');
  assert.equal(depois.falta, 0, `volta com buraco: ${JSON.stringify(depois)}`);
  console.log(`OK revisitado: ${idsAntes.size} nós voltaram idênticos depois de ir a `
    + `(${longe.x.toFixed(0)},${longe.y.toFixed(0)}) a ${longe.d.toFixed(0)} tiles e voltar — o mundo não é reembaralhado`);

  // ---- 5. O pixel acompanha: a mesma praça, duas visitas -------------------------------
  // Congela tudo antes das duas fotos: entre uma e outra o trânsito e os pedestres andam, e
  // um táxi diferente no meio do quadro não é pop-in de chunk nenhum. O trânsito é o único
  // sistema que re-semeia perto da câmera, então é o único que o harness segura.
  await evaluate(`(() => {const g=qa.g; g.__semTrafego=g.trafficSystem.update;
    g.trafficSystem.update=()=>{}; qa.estacionaTudo(${ida.x},${ida.y}); qa.cena(); g.paused=true;})()`);
  await delay(500);
  const fotoA = await shot('qa-streaming-visita-a');
  await evaluate(`(() => {const g=qa.g; g.paused=false; qa.parar(${longe.x},${longe.y});})()`);
  await until('qa.tudoCarregado()', 'anel do lado de lá (fotos)', 25000);
  await evaluate(`qa.parar(${ida.x},${ida.y})`);
  await until('qa.tudoCarregado()', 'anel da volta (fotos)', 25000);
  await delay(300);
  await evaluate(`(() => {const g=qa.g; qa.estacionaTudo(${ida.x},${ida.y}); qa.cena(); g.paused=true;})()`);
  await delay(500);
  const fotoB = await shot('qa-streaming-visita-b');
  await evaluate('(() => {const g=qa.g; g.trafficSystem.update=g.__semTrafego; qa.devolve(); g.paused=false;})()');
  const a = caixa(fotoA, VW / 2, VH / 2, 180, 110), b = caixa(fotoB, VW / 2, VH / 2, 180, 110);
  const dLum = Math.abs(a.lum - b.lum), dCor = Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b);
  console.log(`OK pixel da volta: luminância ${a.lum.toFixed(1)} → ${b.lum.toFixed(1)} `
    + `(Δ${dLum.toFixed(1)}), cor Δ${dCor.toFixed(1)} na caixa central de ${a.n} pixels`);
  assert.ok(a.lum > 12, `a praça saiu preta na primeira foto: luminância ${a.lum.toFixed(1)}`);
  assert.ok(dLum < 8, `a mesma praça mudou de cara na volta: luminância ${a.lum.toFixed(1)} vs ${b.lum.toFixed(1)}`);
  assert.ok(dCor < 8, `a mesma praça mudou de cor na volta: Δ${dCor.toFixed(1)}`);

  // ---- 6. Densidade: o miolo da cidade contra a borda ----------------------------------
  const denso = await evaluate(`(() => {const g=qa.g;
    // O miolo da cidade é onde o índice mais pesa: pega o prédio mais central que existir.
    let best=null; for (const b of g.map.data.buildings) {
      const d=Math.hypot(b.x-g.map.worldW/2,b.y-g.map.worldH/2);
      if (!best || d<best.d) best={x:b.x,y:b.y,d}; }
    qa.parar(best.x,best.y); qa.cena(); return best;})()`);
  await until('qa.tudoCarregado()', 'anel do centro denso', 25000);
  await delay(600);
  const telaDensa = await evaluate('qa.oraculo()');
  assert.equal(telaDensa.falta, 0, `centro denso com chunk visível nu: ${JSON.stringify(telaDensa)}`);
  assert.ok(telaDensa.pedestres > 0, 'no miolo da cidade não havia um pedestre sequer simulado');
  await shot('qa-streaming-centro');
  const borda = await evaluate(`(() => {const g=qa.g; let best=null;
    for (let i=0;i<g.map.data.props.length;i+=5) { const p=g.map.data.props[i];
      const d=Math.hypot(p.x-g.map.worldW/2,p.y-g.map.worldH/2);
      if (!best || d>best.d) best={x:p.x,y:p.y,d}; }
    qa.parar(best.x,best.y); qa.cena(); return best;})()`);
  await until('qa.tudoCarregado()', 'anel da borda', 25000);
  await delay(600);
  const telaBorda = await evaluate('qa.oraculo()');
  assert.equal(telaBorda.falta, 0, `borda com chunk visível nu: ${JSON.stringify(telaBorda)}`);
  console.log(`OK densidade: centro com ${telaDensa.desenhados} desenhadas de ${telaDensa.residentes} residentes `
    + `(${telaDensa.chunks} chunks, ${telaDensa.ativos} entidades simuladas), borda com `
    + `${telaBorda.desenhados} de ${telaBorda.residentes} (${telaBorda.ativos} simuladas) — `
    + `em nenhum dos dois faltou um único nó`);

  // ---- 7. Camadas de IA: longe dorme, perto acorda com o estado junto ------------------
  await evaluate(`qa.parar(${denso.x},${denso.y});qa.cena()`);
  await delay(400);
  // O miolo denso é denso de prédios, não de gente: a multidão mora onde o trânsito passa, e o
  // prédio mais central não é necessariamente uma calçada. Encosta a câmera no pedestre vivo mais
  // perto antes de medir — senão o teste cobraria IA acordada num raio onde nunca houve ninguém.
  const pedestre = await evaluate(`(() => {const g=qa.g; let best=null;
    for (const n of g.npcs) { if (n.dead || n.inVehicle) continue;
      const d = Math.hypot(n.x-g.camera.x, n.y-g.camera.y);
      if (!best || d<best.d) best={x:n.x,y:n.y,d}; }
    if (best && best.d > 20) { qa.parar(best.x,best.y); qa.cena(); }
    return best;})()`);
  assert.ok(pedestre, 'o mapa inteiro estava sem um único pedestre vivo');
  await delay(400);
  const dormir = await evaluate(`(() => {const g=qa.g;
    // Um pedestre a mais de 70 tiles da câmera: fora da zona ativa, dentro do mundo.
    const longe = g.npcs.find((n) => !n.dead && !n.inVehicle &&
      Math.hypot(n.x-g.camera.x, n.y-g.camera.y) > 70);
    if (!longe) return null;
    longe.x0 = longe.x; longe.y0 = longe.y;
    return { id: longe.id, d: Math.hypot(longe.x-g.camera.x, longe.y-g.camera.y) };})()`);
  assert.ok(dormir, 'não havia pedestre fora da zona ativa para medir a IA em camadas');
  const perto = await evaluate(`(() => {const g=qa.g;
    const vivo = g.npcs.find((n) => !n.dead && !n.inVehicle && Math.hypot(n.x-g.camera.x,n.y-g.camera.y) < 20);
    if (!vivo) return null; vivo.x0 = vivo.x; vivo.y0 = vivo.y;
    return { id: vivo.id, d: Math.hypot(vivo.x-g.camera.x, vivo.y-g.camera.y) };})()`);
  assert.ok(perto, 'não havia pedestre dentro da zona ativa para comparar com o que dorme');
  await delay(1600);
  const [dormido, andou] = await evaluate(`(() => {const g=qa.g;
    const a=g.npcs.find((n)=>n.id===${dormir.id}), b=g.npcs.find((n)=>n.id===${perto.id});
    return [a?{mudou:Math.hypot(a.x-a.x0,a.y-a.y0),saude:a.health,vivo:!a.dead}:null,
            b?{mudou:Math.hypot(b.x-b.x0,b.y-b.y0),saude:b.health,vivo:!b.dead}:null];})()`);
  assert.ok(dormido && dormido.mudou < 0.2,
    `pedestre a ${dormir.d.toFixed(0)} tiles continuou andando (Δ${dormido && dormido.mudou.toFixed(2)}): a IA em camadas não desligou`);
  assert.ok(andou.mudou > 0.1,
    `pedestre a ${perto.d.toFixed(0)} tiles ficou congelado com a câmera em cima dele (Δ${andou.mudou.toFixed(2)})`);
  console.log(`OK camadas: a ${dormir.d.toFixed(0)} tiles o pedestre andou ${dormido.mudou.toFixed(2)} tiles em 1,6s e `
    + `mantém vida ${dormido.saude}; a ${perto.d.toFixed(0)} tiles andou ${andou.mudou.toFixed(2)} com vida ${andou.saude}`);

  // ---- 8. Métricas na tela: F3 liga, F3 desliga, e o painel mostra número vivo ---------
  await send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false });
  await send('Emulation.setTouchEmulationEnabled', { enabled: false });
  await delay(400);
  assert.equal(await evaluate(`!!document.querySelector('[data-testid="hud-metrics"]')`), false,
    'o painel de métricas não pode nascer ligado');
  const tecla = (type) => send('Input.dispatchKeyEvent', { type, code: 'F3', key: 'F3', windowsVirtualKeyCode: 114 });
  await tecla('keyDown'); await tecla('keyUp');
  await until(`!!document.querySelector('[data-testid="hud-metrics"]')`, 'painel F3 abre', 15000);
  const painel = await evaluate(`document.querySelector('[data-testid="hud-metrics"]').innerText`);
  assert.match(painel, /FPS \d+/, `painel sem FPS: ${painel}`);
  assert.match(painel, /chunks \d+ visíveis \/ \d+ ativos \/ \d+ carregados/, `painel sem chunks: ${painel}`);
  assert.match(painel, /entidades \d+ na tela/, `painel sem entidades: ${painel}`);
  await tecla('keyDown'); await tecla('keyUp');
  await until(`!document.querySelector('[data-testid="hud-metrics"]')`, 'painel F3 fecha', 15000);
  console.log(`OK métricas: F3 liga e desliga o painel —\n    ${painel.split('\n').join('\n    ')}`);

  // ---- 9. O mundo continua vivo depois de tudo -----------------------------------------
  await evaluate(`qa.parar(${denso.x},${denso.y});qa.cena();qa.g.paused=false`);
  const vivo = await evaluate(`(() => {const g=qa.g;
    return {tempo:+g.time.toFixed(1), npcs:g.npcs.length, carros:g.vehicles.length, bichos:g.wildlife.animals.length,
      coletaveis:g.pickups.items.length, missao:g.missions.state.phase, procurado:g.player.wantedLevel,
      dia:+g.dayNight.t.toFixed(2), clima:g.weather.kind,
      dentro:g.player.x>0&&g.player.y>0&&g.player.x<g.map.worldW&&g.player.y<g.map.worldH&&g.player.health>0};})()`);
  assert.equal(vivo.dentro, true, 'o jogador terminou fora do mundo ou sem vida');
  assert.ok(vivo.npcs > 20 && vivo.carros > 20, `o mundo esvaziou: ${JSON.stringify(vivo)}`);
  await delay(900);
  // Só os pedestres da vizinhança valem como prova: o que dorme longe da câmera NÃO anda, e é
  // exatamente assim que a §5 funciona.
  const mexeu = await evaluate(`(() => {const g=qa.g;
    const andam=g.npcs.filter((n)=>!n.dead&&!n.inVehicle&&Math.hypot(n.x-g.camera.x,n.y-g.camera.y)<26).slice(0,40);
    const antes=andam.map((n)=>n.x+','+n.y);
    return new Promise((r)=>setTimeout(()=>r({total:andam.length,
      mexidos:andam.filter((n,i)=>n.x+','+n.y!==antes[i]).length}),800));})()`);
  assert.ok(mexeu.total > 0 && mexeu.mexidos > 0,
    `nenhum pedestre se mexeu perto da câmera no fim da corrida (${JSON.stringify(mexeu)}): a simulação parou de acordar`);
  console.log(`OK mundo vivo: ${vivo.npcs} pedestres, ${vivo.carros} carros, ${vivo.bichos} bichos, `
    + `${vivo.coletaveis} coletáveis, missão ${vivo.missao}, procurado ${vivo.procurado}, clima ${vivo.clima}, `
    + `hora ${vivo.dia}, tempo ${vivo.tempo}s — ${mexeu.mexidos}/${mexeu.total} pedestres vizinhos andaram`);

  assert.deepEqual(errors, [], `erros de página: ${errors.slice(0, 3).join(' | ')}`);
  console.log('Streaming browser checks passed; screenshots in tools/tmp/qa-streaming-*.png');
})().catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => { try { socket?.close(); } catch { /* já fechado */ } });
