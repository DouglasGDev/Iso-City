// Run: node tools/check/check-snow-browser.cjs (precisa do Expo web em :8082 e Chrome em :9223).
//
// O #130 é o pedido do contrário do #129: a neve não pode ser só o floco que cai e some.
// Ela tem de FICAR no chão, crescer enquanto nevando e demorar a derreter depois. Nada
// disso é opinião: é diferença de pixel entre dois quadros do mesmo lugar, com o mesmo
// céu limpo, mudando apenas o acumulado do `SnowSystem`.
//
// Três coisas são afirmadas aqui, e cada uma pega um jeito diferente de errar:
//   1. o acúmulo e a persistência, no relógio real do jogo — uma neve que só existe
//      enquanto o widget de clima diz "neve" não passou por aqui;
//   2. o branco no chão, medido no pixel, com a tinta do relevo e a neve disputando o
//      mesmo losango — por isso o quadro é lido com a frente já seca, sem floco caindo
//      por cima da média;
//   3. a areia que não branqueia: o mesmo par de quadros no deserto tem de ser o MESMO
//      quadro, senão a neve virou pintura mundial e não cobertura.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PNG } = require('pngjs');
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
/** Média de cada canal na faixa central: é chão, não HUD. `tex` é o contraste vizinho. */
function chao(png) {
  let r = 0, g = 0, b = 0, n = 0, tex = 0, t = 0;
  const lum = (o) => 0.2126 * png.data[o] + 0.7152 * png.data[o + 1] + 0.0722 * png.data[o + 2];
  for (let y = 100; y < 300; y += 2) {
    for (let x = 250; x < 649; x += 2) {
      const k = (png.width * y + x) << 2;
      r += png.data[k]; g += png.data[k + 1]; b += png.data[k + 2]; n++;
      tex += Math.abs(lum(k) - lum(k + 4)); t++;
    }
  }
  const media = v => v / n;
  return { r: media(r), g: media(g), b: media(b), lum: media(0.2126 * r + 0.7152 * g + 0.0722 * b),
    tex: tex / t };
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
  // Sem isto o Chrome pode devolver o `index.bundle` do disco e o quadro medir a tinta da
  // compilação passada: a calibração da neve saiu idêntica a si mesma por exatamente esse
  // motivo. O feixe é o que está no servidor, sempre.
  await send('Network.enable'); await send('Network.setCacheDisabled', { cacheDisabled: true });

  await send('Page.navigate', { url: 'about:blank' });
  await send('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 1, mobile: true });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await send('Page.navigate', { url: 'http://localhost:8082/?snow-qa=1' });
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
  await evaluate(`(()=>{const m=[...__r.getModules().values()].filter(m=>m.isInitialized).map(m=>m.publicModule.exports);
    globalThis.qa={g:m.find(m=>m?.getGame).getGame()};
    qa.g.player.invulnUntil=Infinity;qa.g.dayNight.t=.5;
    qa.g.hazard.cooldown=1e9;qa.g.weather.checkTimer=1e9;
    qa.ir=(x,y,h)=>{const g=qa.g;g.player.x=x;g.player.y=y;g.camera.x=x;g.camera.y=y;g.camera.h=h;g.dayNight.t=.5;};
    // O relógio de frentes fica travado: quem manda no acumulado é só o tipo de clima.
    qa.tempo=k=>{qa.g.weather.checkTimer=1e9;qa.g.weather.force(k,3600);};
    qa.seco=()=>{qa.g.weather.checkTimer=1e9;qa.g.weather.force('clear',1);};
    qa.nivel=()=>+qa.g.snow.depth.toFixed(4);})()`);

  // Um mirante de mato (segura neve) e um de areia (não segura), longe da cidade.
  const mirantes = await evaluate(`(()=>{const d=qa.g.map.data,W=d.tilesW,H=d.tilesH;
    const varrer=biomas=>{let m=null;
      for(let y=12;y<H-12;y++)for(let x=12;x<W-12;x++){
        let ok=true;
        for(let dy=-3;dy<=3&&ok;dy++)for(let dx=-3;dx<=3;dx++){
          const t=d.tiles[(y+dy)*W+x+dx];
          if(!biomas.includes(t.biome)||t.kind==='water'||t.kind==='road'){ok=false;break;}}
        if(!ok)continue;
        const i=y*W+x;
        if(!m||d.heights[i]>m.alt)m={x,y,alt:d.heights[i],biome:d.tiles[i].biome};}
      return m;};
    return { mato: varrer(['pinewood','forest']), areia: varrer(['desert','beach']) };})()`);
  console.log(JSON.stringify(mirantes));
  assert.ok(mirantes.mato && mirantes.areia, 'faltam mirantes de mato e de areia no mapa');

  await test('a cobertura é do chão, não do mapa inteiro', async () => {
    // Duas réguas, porque uma só não afirma nada: a 100% de neve quase tudo está saturado,
    // e é no meio do degelo que a ordem entre as superfícies aparece.
    const leitura = await evaluate(`(()=>{const s=qa.g.snow;
      s.depth=1;const cheios={quente:s.cobertura(0,'desert','dirt')+s.cobertura(0,'beach','grass')
        +s.cobertura(0,'docks','concrete'), agua:s.cobertura(0,'forest','water')};
      s.depth=0.45;const meio={vale:s.cobertura(0,'forest','grass'),topo:s.cobertura(2.6,'forest','grass'),
        rua:s.cobertura(0,'downtown','road'),calcada:s.cobertura(0,'downtown','concrete')};
      s.depth=0;return {cheios,meio};})()`);
    assert.equal(leitura.cheios.quente, 0, 'areia, praia e cais seguraram neve');
    assert.equal(leitura.cheios.agua, 0, 'o rio branqueou');
    assert.ok(leitura.meio.topo > leitura.meio.vale,
      `a cota alta não segura mais neve que o vale: ${leitura.meio.topo} x ${leitura.meio.vale}`);
    assert.ok(leitura.meio.vale > leitura.meio.rua && leitura.meio.rua > 0,
      `asfalto e mato na mesma altura: rua ${leitura.meio.rua}, mato ${leitura.meio.vale}`);
    assert.ok(leitura.meio.calcada > leitura.meio.rua, 'a calçada derrete antes do asfalto');
  });

  /**
   * Os dois quadros do mesmo lugar, só mudando o acumulado — a frente fica seca nos dois.
   *
   * A câmera é empurrada três tiles para fora e devolvida antes de cada foto, pelo mesmo
   * motivo do espelho do #129: o `GroundLayer` só refaz o bake quando a célula da câmera
   * muda, e um `snow.depth` escrito por fora do laço, com o jogador parado, não compra
   * quadro novo. Sem o empurrão as duas fotos saem byte-idênticas e o "ganho" que se lê
   * do par é a deriva do céu entre elas, não a neve.
   */
  async function par(nome, spot, nivel) {
    const tirar = async depth => {
      await evaluate(`qa.ir(${spot.x + 3},${spot.y + 3},${spot.alt})`);
      await delay(600);
      await evaluate(`qa.g.snow.depth=${depth};qa.ir(${spot.x},${spot.y},${spot.alt})`);
      await delay(1800);
      const { data } = await send('Page.captureScreenshot', { format: 'png' });
      const f = path.resolve(__dirname, '../tmp/snow-' + nome + (depth ? '-neve' : '-seco') + '.png');
      fs.writeFileSync(f, Buffer.from(data, 'base64'));
      return chao(PNG.sync.read(fs.readFileSync(f)));
    };
    // A/B/A/B, não A/B: a cena assobia sozinha (o fog e o tint convergem depois do
    // teleporte), e um par só conta a deriva como se fosse tinta. O ganho é a média dos
    // dois quadros com neve contra a média dos dois sem ela, e os quatro brutos são
    // impressos para quem ler a régua poder ver o que cada quadro realmente mostrou.
    const a1 = await tirar(0), b1 = await tirar(nivel), a2 = await tirar(0), b2 = await tirar(nivel);
    const medio = (x, y) => (x.lum + y.lum) / 2;
    const seco = medio(a1, a2), neve = medio(b1, b2);
    console.log(`    quadros: seco ${a1.lum.toFixed(1)} / neve ${b1.lum.toFixed(1)}`
      + ` / seco ${a2.lum.toFixed(1)} / neve ${b2.lum.toFixed(1)}`);
    console.log(`    canais do último par: rgb ${a2.r.toFixed(0)},${a2.g.toFixed(0)},${a2.b.toFixed(0)}`
      + ` -> ${b2.r.toFixed(0)},${b2.g.toFixed(0)},${b2.b.toFixed(0)}`);
    return { seco: +seco.toFixed(1), neve: +neve.toFixed(1),
      ganho: (neve - seco) / seco * 100,
      textura: ((b1.tex + b2.tex) / (a1.tex + a2.tex)) * 100 };
  }

  let mato = null, farelo = null, areia = null;
  await test('a neve acende o chão de mato', async () => {
    await evaluate(`qa.seco();qa.ir(${mirantes.mato.x},${mirantes.mato.y},${mirantes.mato.alt})`);
    await delay(9000);
    mato = await par('mato', mirantes.mato, 0.95);
    console.log(`  mato: luminância ${mato.seco} -> ${mato.neve} (+${mato.ganho.toFixed(1)}%)`
      + `, textura do chão ${mato.textura.toFixed(0)}%`);
    assert.ok(mato.ganho >= 8, `a neve não clareou o mato: +${mato.ganho.toFixed(1)}%`);
    // O teto é o contrato visual: nevão é chão coberto, não lençol lavado.
    assert.ok(mato.ganho <= 45, `a neve apagou o chão em vez de cobri-lo: +${mato.ganho.toFixed(1)}%`);
    // A régua que o teto sozinho não era: o branco tem de continuar deixando junta de tile,
    // pedrinha e sombra de copa embaixo dele. Um lençol opaco passa nas duas de cima.
    assert.ok(mato.textura >= 60, `a neve soterrou o detalhe do chão: sobrou ${mato.textura.toFixed(0)}%`);
  });
  await test('pouca neve clareia pouco: o pixel acompanha o acumulado', async () => {
    // A régua que a malha de `Screen` não passava: no CanvasKit da web o drawVertices lê a
    // cor do pincel e ignora a cor por vértice, então 0,15 e 0,95 de neve saíam iguais.
    farelo = await par('farelo', mirantes.mato, 0.2);
    console.log(`  farelo: luminância ${farelo.seco} -> ${farelo.neve} (+${farelo.ganho.toFixed(1)}%)`);
    assert.ok(farelo.ganho >= 2, `nem o primeiro farelo toca o chão: +${farelo.ganho.toFixed(1)}%`);
    assert.ok(farelo.ganho <= mato.ganho * 0.6,
      `farelo (+${farelo.ganho.toFixed(1)}%) e nevão (+${mato.ganho.toFixed(1)}%) são o mesmo quadro`);
  });
  await test('a areia continua areia', async () => {
    await evaluate(`qa.ir(${mirantes.areia.x},${mirantes.areia.y},${mirantes.areia.alt})`);
    await delay(1200);
    areia = await par('areia', mirantes.areia, 0.95);
    console.log(`  areia: luminância ${areia.seco} -> ${areia.neve} (${areia.ganho.toFixed(1)}%)`);
    assert.ok(Math.abs(areia.ganho) <= 1.5, `nevou na areia: ${areia.ganho.toFixed(1)}%`);
  });

  await test('nevando cresce, parando dura', async () => {
    await evaluate('qa.g.snow.depth=0;qa.tempo("snow")');
    await delay(24000);
    const cheio = await evaluate('qa.nivel()');
    assert.ok(cheio > 0.15, `nevando há 24s e o chão continua seco (${cheio})`);
    // A frente passa, o céu limpa, e o branco tem de ficar: é o "fazer durar" do pedido.
    // A régua é absoluta porque é o que se vê — nove segundos de céu aberto não podem
    // levar embora mais do que a taxa de degelo manda (9 / SNOW_MELT_S).
    await evaluate('qa.seco()');
    await delay(9000);
    const depois = await evaluate('qa.nivel()');
    assert.ok(depois >= cheio - 0.035, `a neve derreteu junto com a frente: ${cheio} -> ${depois}`);
    const visivel = await evaluate(`qa.g.snow.cobertura(1,'forest','grass')`);
    // A régua segue o tempo real de teste: 24s de nevasca levam o acumulado a ~0,2, não a
    // 1. O que se afirma é que o número ainda virou branco no chão (limiar de cobertura
    // 0,08 com rampa de 0,55), não que a cena inteira esteja no pico do nevão.
    assert.ok(visivel > 0.15, `sobrou neve no número mas não no chão: cobertura ${visivel}`);
    // Chuva não é só ausência de neve: ela leva o que já caiu embora de verdade.
    await evaluate('qa.tempo("rain")');
    await delay(9000);
    const molhado = await evaluate('qa.nivel()');
    assert.ok(molhado <= depois - 0.08, `chuva morna com a neve no chão: ${depois} -> ${molhado}`);
    console.log(`  acúmulo ${cheio} -> parado ${depois} -> chuva ${molhado}`);
    await evaluate('qa.g.snow.depth=0;qa.seco()');
  });

  await test('nada quebrou no caminho', async () => {
    assert.deepEqual(errors, [], 'erros na página: ' + errors.slice(0, 3).join(' | '));
  });

  console.log(`\nNeve no chão: ${passado} passed, ${falhou} failed.`);
})().catch(e => { console.error(e); process.exit(1); })
  .finally(() => socket?.close());
