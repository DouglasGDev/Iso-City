// Run: node tools/check/check-boot-browser.cjs (precisa do Expo web em :8082 e Chrome em :9223).
//
// O portão de entrada. O resto dos checks mede a cidade andando; este mede o caminho entre o
// clique em "NOVO JOGO" e o mundo respondendo no teclado, porque foi exatamente ali que o jogo
// travou: 543 sprites gated, ~720 ms por arquivo no Metro de desenvolvimento e o navegador
// segurando ~6 conexões por host davam 76-106 segundos de tela de carregamento. A correção não
// tirou asset nenhum — reordenou a fila, abriu um lote em voo, deixou a cena furar a fila e pôs
// um prazo absoluto para o portão. Este arquivo prova:
//
// §1 — o portão abre rápido depois do clique, e abre com a fila ainda aberta (não porque acabou);
// §1b — o que a câmera aponta se completa logo depois de abrir: chão, boneco e cidade no quadro;
// §2 — a fila continua completa e priorizada: todo asset utilizável ainda entra, chão/personagem
//      na frente de prédio, prédio na frente de adorno;
// §3 — a demanda da cena fura a fila: pedir uma chave ausente a vê chegar em poucos tiques;
// §4 — depois do portão os sprites continuam chegando, sem nunca regredir, até os 543;
// §5 — o mundo que abriu é uma cidade de verdade na quadra mais cheia, e o quadro roda liso
//      sob condução.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const WebSocket = require('ws');

const PORT = Number(process.env.QA_CDP_PORT || 9223);
const METRO = process.env.QA_METRO_PORT || 8082;
const VW = 844, VH = 390;
// O portão tem prazo absoluto de 8 s no código. Em desenvolvimento, com o bundle inteiro sendo
// avaliado no meio, se dá 20 s; acima disso o portão voltou a virar tela de espera.
const PORTAO_MS = 20000;
// A fila inteira em Metro de desenvolvimento (~5 arquivos/s) leva ~100 s. 180 s é margem larga
// sem deixar o check virar espera infinita quando algo engasgar de fato.
const FECHO_MS = 180000;

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
  fs.writeFileSync(path.resolve(__dirname, '../tmp/' + name + '.png'), Buffer.from(data, 'base64'));
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
  await require('./bundle-identity.cjs').attach(socket, send);

  await send('Page.navigate', { url: 'about:blank' });
  await send('Emulation.setDeviceMetricsOverride', { width: VW, height: VH, deviceScaleFactor: 1, mobile: true });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await send('Page.navigate', { url: `http://localhost:${METRO}/?boot-qa=1` });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await until(`!!document.querySelector('[data-testid="menu-new"],[data-testid="menu-play"]')
    || !!document.body?.innerText.match(/JOGAR|NOVO JOGO/)`, 'menu', 240000);
  await delay(600);
  const botao = await evaluate(`(()=>{const b=document.querySelector('[data-testid="menu-new"]')
    ||document.querySelector('[data-testid="menu-play"]');
    if(!b)return null;const r=b.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  assert.ok(botao, 'nenhum botão de jogar no menu');

  // ---- 1. O portão abre depois do clique, e o que se vê logo depois ----------------------
  // O relógio começa no toque, não na navegação: o menu em si leva ~30 s só para avaliar o
  // bundle em desenvolvimento, e isso é custo do Metro, não do carregamento de sprites.
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...botao, id: 1 }] });
  const clicked = Date.now();
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await until('document.body.innerText.includes("HP 100")', 'HUD', PORTAO_MS);
  const atras = Date.now() - clicked;
  // A ponte se monta aqui, e não só na §5: o mundo acabou de montar, e é exatamente desta
  // janela que o jogador reclama quando diz que o jogo "abre travado".
  await evaluate(`(() => {const mods=[...__r.getModules().values()].filter((m)=>m.isInitialized)
      .map((m)=>m.publicModule.exports);
    const g = mods.find((m)=>m&&m.getGame).getGame();
    globalThis.qa = {g, sprites: mods.find((m)=>m&&m.spriteStore).spriteStore,
      nodes: mods.find((m)=>m&&m.staticNodesFor).staticNodesFor,
      cfg: mods.find((m)=>m&&m.GAME_CONFIG).GAME_CONFIG,
      reg: mods.find((m)=>m&&m.buildingKey&&m.propKey)};
    qa.parar = (x, y) => { g.player.x = x; g.player.y = y; g.player.vx = 0; g.player.vy = 0;
      g.camera.x = x; g.camera.y = y; g.camera.h = g.map.heightSmoothAt(x, y); g.notifyEntityChange(); };
    /** Quantos tiles do chão ao redor da câmera ainda não têm sprite. É a tela vazia, contada. */
    qa.chao = (raio) => {const d=g.map.data, W=d.tilesW; let total=0, faltam=0;
      const x0=Math.max(0,Math.floor(g.camera.x-raio)), x1=Math.min(W-1,Math.ceil(g.camera.x+raio));
      const y0=Math.max(0,Math.floor(g.camera.y-raio)), y1=Math.min(d.tilesH-1,Math.ceil(g.camera.y+raio));
      for(let ty=y0;ty<=y1;ty++)for(let tx=x0;tx<=x1;tx++){const t=d.tiles[ty*W+tx]; if(!t)continue;
        // Tile cujo arquivo nem está na fila não é tela vazia: é o chão que o jogo desenha com
        // o fallback do GroundLayer, e esperar por ele seria esperar por algo que não vem.
        const chave=qa.reg.tileKey(t.key); if(!qa.reg.isUsableAsset(chave))continue;
        total++; if(!qa.sprites[chave])faltam++;}
      return {total, faltam};};
    qa.densa = () => {const idx=g.streaming.index, data=g.map.data, T=qa.cfg.CHUNK_SIZE; let best=null;
      for (let c=0;c<idx.buildingsByChunk.length;c++) {
        const predios = (idx.buildingsByChunk[c]||[]).length;
        const n = predios + (idx.propsByChunk[c]||[]).length;
        // Prédio pesa mais que adorno: a câmera tem de cair sobre cidade, não sobre um matagal
        // com muitas árvores, que é o que o simples "mais estáticos" costuma escolher.
        const score = predios * 3 + (idx.propsByChunk[c]||[]).length;
        if (n < 12) continue;
        const x = (c % idx.cols) * T + T/2, y = Math.floor(c / idx.cols) * T + T/2;
        if (g.map.isWaterWorld(x, y)) continue;
        if (!best || score > best.score) best = {c, n, score, x, y};
      }
      return best;};
    qa.oraculo = () => {const idx=g.streaming.index, data=g.map.data; const esperado=new Set();
      for (const id of g.streaming.visibleChunks) {
        for (const i of (idx.buildingsByChunk[id] || []))
          if (qa.sprites[qa.reg.buildingKey(data.buildings[i].key)]) esperado.add('building:' + i);
        for (const i of (idx.propsByChunk[id] || []))
          if (qa.sprites[qa.reg.propKey(data.props[i].key)]) esperado.add('prop:' + i);
      }
      const presentes=new Set(qa.nodes(g,g.streaming).map((x)=>x.id));
      let falta=0; for (const id of esperado) if (!presentes.has(id)) falta++;
      const s=g.streaming.stats;
      return {falta, esperados:esperado.size, desenhados:s.drawnStatics, residentes:s.staticNodes,
        chunks:s.loadedChunks, precisos:g.streaming.neededChunks.length};
    };
    g.player.invulnUntil = Infinity; g.dayNight.t = 0.5; g.weather.force('clear', 3600);})()`);
  const portao = await evaluate(`({sprites:Object.keys(qa.sprites).length,
      fila: (()=>{const mods=[...__r.getModules().values()].filter((m)=>m.isInitialized)
        .map((m)=>m.publicModule.exports); return mods.find((m)=>m&&m.CARREGAMENTO).CARREGAMENTO.length})(),
      chunks:qa.g.streaming.stats.loadedChunks, residentes:qa.g.streaming.stats.staticNodes,
      boneco:Object.keys(qa.sprites).filter((k)=>k.startsWith('Characters/')).length,
      chaodofalta:qa.chao(18), oraculo:qa.oraculo()})`);
  assert.ok(atras <= PORTAO_MS, `o portão demorou ${atras} ms para abrir depois do NOVO JOGO`);
  assert.ok(portao.sprites > 0, 'abriu sem nenhum sprite no depósito');
  await shot('qa-boot-portao');
  console.log(`OK portão: mundo interativo ${atras} ms depois do clique, com ${portao.sprites}/${portao.fila} `
    + `sprites baixados e ${portao.chunks} chunks carregados — abrir ${portao.sprites < portao.fila ? 'com a fila ainda correndo' : 'depois da fila fechar'}`);
  assert.ok(portao.sprites < portao.fila,
    `o portão só deveria abrir antes do fim da fila; abriu com tudo baixado (${portao.sprites}/${portao.fila}) `
    + '— sem janela de entrada, a medição abaixo não prova nada');

  // ---- 1b. A cena pede o que falta e recebe ---------------------------------------------
  // Abrir cedo só vale se o que a câmera aponta se completar rápido. O mundo só monta depois do
  // portão, então é ele quem descobre o que falta e fura a fila: aqui se mede o tempo entre
  // abrir e a tela estar cheia de chão, de boneco e de cidade.
  const encaixe = [];
  const ateEncaixe = Date.now() + 30000;
  let cheioEm = null;
  while (Date.now() < ateEncaixe) {
    const l = await evaluate(`(() => {const c=qa.chao(18), o=qa.oraculo();
      return {tilesSemSprite:c.faltam, tiles:c.total, falta:o.falta, esperados:o.esperados,
        desenhados:o.desenhados, boneco:Object.keys(qa.sprites).filter((k)=>k.startsWith('Characters/')).length,
        sprites:Object.keys(qa.sprites).length};})()`);
    encaixe.push(l);
    if (l.tilesSemSprite === 0 && l.boneco > 0 && l.falta === 0 && l.esperados > 0) { cheioEm = Date.now(); break; }
    await delay(500);
  }
  const primeiro = encaixe[0], ultimo = encaixe[encaixe.length - 1];
  assert.ok(cheioEm, `a tela nunca se completou em 30 s depois do portão: ${JSON.stringify(encaixe.slice(-3))}`);
  assert.ok(cheioEm - clicked <= PORTAO_MS + 30000,
    `a vizinhança da câmera demorou demais para encher: ${JSON.stringify(ultimo)}`);
  console.log(`OK cena completa: do portão até tela cheia em ${Math.round((cheioEm - clicked - atras) / 100) / 10} s `
    + `(${primeiro.sprites} → ${ultimo.sprites} sprites; chão ${primeiro.tilesSemSprite}/${primeiro.tiles} tiles `
    + `sem sprite → 0; ${ultimo.desenhados} estáticas desenhadas de ${ultimo.esperados} esperadas)`);
  await shot('qa-boot-tela-cheia');

  // ---- 2. A fila continua completa e na ordem certa -------------------------------------
  // O ponto da otimização era não remover asset nenhum para ganhar tempo. Se alguém cortar a
  // fila no futuro, esta asserção pega: a fila do carregamento tem de ser exatamente o conjunto
  // de assets utilizáveis, e o pedido da câmera (chão, boneco) tem de vir antes do resto.
  const ordem = await evaluate(`(() => {const mods=[...__r.getModules().values()].filter((m)=>m.isInitialized)
      .map((m)=>m.publicModule.exports);
    const reg = mods.find((m)=>m&&m.CARREGAMENTO&&m.ASSETS_TO_LOAD);
    const grupo = (k)=> k.startsWith('Roads and Grounds/')?0 : k.startsWith('Characters/')?1
      : k.startsWith('Buildings/')?2 : k.startsWith('Vehicles/')?3 : k.startsWith('Props/')?4 : 5;
    const rangos = reg.CARREGAMENTO.map(grupo);
    const invertidos = rangos.filter((r,i)=>i>0&&r<rangos[i-1]).length;
    return {fila: reg.CARREGAMENTO.length, uteis: reg.ASSETS_TO_LOAD.length,
      todos: reg.CARREGAMENTO.length === reg.ASSETS_TO_LOAD.length,
      invertidos, essência: reg.CARREGAMENTO_ESSENCIAL.length,
      primeiros: reg.CARREGAMENTO.slice(0,3).map((k)=>k.split('/')[0]),
      duplicados: reg.CARREGAMENTO.length - new Set(reg.CARREGAMENTO).size};})()`);
  assert.equal(ordem.todos, true, `a fila abandonou assets: ${ordem.fila} na fila contra ${ordem.uteis} utilizáveis`);
  assert.equal(ordem.duplicados, 0, `a fila tem ${ordem.duplicados} chaves repetidas`);
  assert.equal(ordem.invertidos, 0, `a prioridade inverte em ${ordem.invertidos} pontos: ${JSON.stringify(ordem)}`);
  assert.match(ordem.primeiros[0], /Roads and Grounds/, `a fila começa fora do chão: ${ordem.primeiros.join(' → ')}`);
  assert.ok(ordem.essência > 50, `o conjunto essencial encolheu: ${ordem.essência}`);
  console.log(`OK fila: ${ordem.fila} assets na ordem pedida, 0 inversões de prioridade, `
    + `${ordem.essência} essenciais, começa em ${ordem.primeiros[0]}`);

  // ---- 3. A cena fura a fila ------------------------------------------------------------
  // O mecanismo só existe para o que a câmera pede agora, então se mede com a fila ainda
  // correndo: pedir uma chave que ainda não chegou — do jeito que o ChunkStatics e o
  // GroundLayer fazem — e vê-la chegar em poucos tiques, muito antes da volta dela na fila de 543.
  const demanda = await evaluate(`(() => {const mods=[...__r.getModules().values()].filter((m)=>m.isInitialized)
      .map((m)=>m.publicModule.exports);
    const reg = mods.find((m)=>m&&m.CARREGAMENTO); const store = mods.find((m)=>m&&m.spriteStore).spriteStore;
    const falta = reg.CARREGAMENTO.filter((k)=>!store[k]);
    if (!falta.length) return null;
    const chave = falta[Math.floor(falta.length / 2)];
    mods.find((m)=>m&&m.solicitarSprite).solicitarSprite(chave);
    return {chave, faltando: falta.length, posicao: reg.CARREGAMENTO.indexOf(chave)};})()`);
  assert.ok(demanda, `a fila já fechou antes de a demanda poder ser medida: ${JSON.stringify(portao)}`);
  const antes = await evaluate(`Object.keys((()=>{const mods=[...__r.getModules().values()]
    .filter((m)=>m.isInitialized).map((m)=>m.publicModule.exports);
    return mods.find((m)=>m&&m.spriteStore).spriteStore})()).length`);
  await until(`(()=>{const mods=[...__r.getModules().values()].filter((m)=>m.isInitialized)
    .map((m)=>m.publicModule.exports);
    return !!mods.find((m)=>m&&m.spriteStore).spriteStore[${JSON.stringify(demanda.chave)}]})()`,
    `demanda ${demanda.chave} chegar`, 30000);
  const depois = await evaluate(`Object.keys((()=>{const mods=[...__r.getModules().values()]
    .filter((m)=>m.isInitialized).map((m)=>m.publicModule.exports);
    return mods.find((m)=>m&&m.spriteStore).spriteStore})()).length`);
  console.log(`OK fura-fila: ${demanda.chave} (rango ${demanda.posicao} de ${ordem.fila}, `
    + `${demanda.faltando} ainda por chegar) entrou no depósito em menos de 30 s `
    + `(${antes} → ${depois} sprites)`);

  // ---- 4. Depois do portão o depósito continua enchendo ---------------------------------
  // O risco de um portão com prazo é virar descartador: abrir e parar de baixar. Aqui se amostra
  // o tamanho do depósito; ele nunca pode diminuir e tem de chegar ao total da fila.
  const amostras = [depois];
  const espera = [];
  const fim = Date.now() + FECHO_MS;
  let fechado = false;
  while (Date.now() < fim && !fechado) {
    await delay(3000);
    const n = await evaluate(`Object.keys((()=>{const mods=[...__r.getModules().values()]
      .filter((m)=>m.isInitialized).map((m)=>m.publicModule.exports);
      return mods.find((m)=>m&&m.spriteStore).spriteStore})()).length`);
    assert.ok(n >= amostras[amostras.length - 1],
      `o depósito perdeu sprites: ${n} depois de ${amostras[amostras.length - 1]}`);
    if (n !== amostras[amostras.length - 1]) amostras.push(n);
    else espera.push(n);
    fechado = n >= ordem.fila;
  }
  assert.ok(fechado, `a fila não fechou em ${FECHO_MS} ms: ${amostras.join(' → ')} de ${ordem.fila}`);
  const esperaMedia = espera.length ? Math.max(...espera) : 0;
  console.log(`OK fila fechada: ${ordem.fila} sprites no depósito em ${Math.round((FECHO_MS - (fim - Date.now())) / 1000)} s `
    + `depois do portão (${amostras.length} degraus de crescimento, último platô em ${esperaMedia}, `
    + `de ${amostras[0]} para ${amostras[amostras.length - 1]})`);

  // ---- 5. O mundo que abriu é uma cidade ------------------------------------------------
  // Portão rápido sem conteúdo seria só uma tela vazia mais cedo. Se estaciona a câmera na
  // quadra mais cheia do índice e se confere que ela assou e que nada do que devia estar
  // desenhado falta — no spawn o quadro pode cair num trecho de areia, e isso não prova nada.
  const alvo = await evaluate(`(() => {const a = qa.densa(); if (a) qa.parar(a.x, a.y); return a;})()`);
  assert.ok(alvo, 'nenhum chunk denso encontrado para estacionar a câmera');
  // Espera com leitura, não com ponto cego: o `until` engole exceção, e um timeout sem número
  // nenhum não diria se o anel não fechou ou se o oráculo é que quebrou.
  const anel = [];
  const ateAnel = Date.now() + 40000;
  while (Date.now() < ateAnel) {
    anel.push(await evaluate(`(() => {try {const s=qa.g.streaming.stats, o=qa.oraculo();
      return {carregados:s.loadedChunks, precisos:qa.g.streaming.neededChunks.length,
        visiveis:qa.g.streaming.visibleChunks.length, residentes:s.staticNodes, ...o, erro:null};
      } catch (e) { return {erro:String(e && e.message || e)}; }})()`));
    const u = anel[anel.length - 1];
    if (u.erro) break;
    if (u.carregados >= u.precisos && u.esperados > 0) break;
    await delay(1000);
  }
  const lido = anel[anel.length - 1];
  assert.ok(!lido.erro, `o oráculo quebrou na quadra densa: ${JSON.stringify(anel.slice(-3))}`);
  assert.ok(lido.carregados >= lido.precisos,
    `o anel de streaming não fechou na quadra densa: ${JSON.stringify(anel.slice(-4))}`);
  await delay(1200);
  const vida = await evaluate(`(() => {const s=qa.g.streaming.stats; const f=qa.oraculo();
    return {...f, fps:s.fps, quadro:+s.frameMs.toFixed(1), update:+s.updateMs.toFixed(2),
      visiveis:s.visibleChunks, npcs:s.activeNpcs, total:s.totalEntities,
      carros:qa.g.vehicles.length, pedestres:qa.g.npcs.length};})()`);
  assert.ok(vida.esperados >= 8, `a quadra mais cheia do mapa desenhou pouco: ${JSON.stringify(vida)}`);
  assert.equal(vida.falta, 0,
    `o portão abriu com cidade faltando na tela: ${JSON.stringify(vida)}`);
  assert.ok(vida.residentes >= vida.desenhados,
    `desenhando mais do que está residente: ${vida.desenhados} > ${vida.residentes}`);
  assert.ok(vida.carros > 20 && vida.pedestres > 20, `o mundo abriu vazio: ${JSON.stringify(vida)}`);
  await shot('qa-boot-cidade');
  const mapa = await evaluate('({predios:qa.g.map.data.buildings.length, adornos:qa.g.map.data.props.length})');
  console.log(`OK cidade no portão: ${mapa.predios} prédios e ${mapa.adornos} adornos no mapa, `
    + `${vida.chunks}/${vida.precisos} chunks carregados, ${vida.residentes} nós residentes, `
    + `${vida.desenhados} desenhados de ${vida.esperados} esperados (0 faltando), `
    + `${vida.carros} carros e ${vida.pedestres} pedestres, fps ${vida.fps}, quadro ${vida.quadro} ms, update ${vida.update} ms`);

  // Conduz 8 s e mede o quadro: se o portão tivesse só escondido o custo, ele reaparece aqui.
  await evaluate(`(() => {const v=qa.g.vehicles.find((x)=>x.state!=='destroyed');
    qa.g.player.x=v.x+0.7; qa.g.player.y=v.y;
    qa.g.vehicleSystem.enterVehicle(qa.g.player, v); qa.g.trafficSystem.takeOver(v.id); qa.carro=v;
    [...__r.getModules().values()].filter((m)=>m.isInitialized).map((m)=>m.publicModule.exports)
      .find((m)=>m&&m.setVehicleControl).setVehicleControl('accel', true);})()`);
  const quadro = [];
  for (let i = 0; i < 8; i++) {
    await delay(1000);
    quadro.push(await evaluate('qa.g.streaming.stats.frameMs'));
  }
  await evaluate(`(()=>{const g=qa.g;
    [...__r.getModules().values()].filter((m)=>m.isInitialized).map((m)=>m.publicModule.exports)
      .find((m)=>m&&m.setVehicleControl).setVehicleControl('accel', false);
    if (g.player.currentVehicleId !== null) g.vehicleSystem.exitVehicle(g.player, qa.carro, g.map, g.collision);})()`);
  const mediana = quadro.slice().sort((a, b) => a - b)[Math.floor(quadro.length / 2)];
  assert.ok(mediana < 40, `quadro acima de 40 ms conduzindo: ${quadro.map((q) => q.toFixed(1)).join(', ')}`);
  console.log(`OK sob condução: quadro mediano ${mediana.toFixed(1)} ms em 8 amostras `
    + `(${Math.min(...quadro).toFixed(1)}-${Math.max(...quadro).toFixed(1)}), `
    + `${await evaluate('qa.g.streaming.stats.drawnStatics')} estáticas na tela`);

  assert.deepEqual(errors, [], `erros de página: ${errors.slice(0, 3).join(' | ')}`);
  console.log(`Boot checks passed; screenshots in tools/tmp/qa-boot-*.png`);
})().catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => { try { socket?.close(); } catch { /* já fechado */ } });
