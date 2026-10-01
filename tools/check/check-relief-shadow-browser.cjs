// Run: node tools/check/check-relief-shadow-browser.cjs (precisa do Expo web em :8082 e Chrome em :9223).
//
// O #129 não é uma opinião sobre sombra: é a diferença entre dois quadros do MESMO lugar,
// um com a tinta do relevo e outro sem ela. `check-map.cjs` já prova, no gerador, que toda
// sombra de copa tem uma árvore em cima; o que ele não pode provar é o que a tinta faz com
// o pixel quando a árvore não existe — e era exatamente ali que o morro nu do deserto
// ganhava um lago azul-cinza: um "telão de sombra" sem nenhum objeto projetando.
//
// Cada mirante é fotografado duas vezes na mesma enquadragem (a célula da câmera é
// empurrada e devolvida, senão o `GroundLayer` nem refaz o bake). Da faixa central da tela
// — longe do joystick, dos botões e do HUD, onde só há chão — sai a média de cada canal. O
// que se afirma é o DELTA entre os dois quadros, medido, não o valor absoluto de um deles.
//
// Medido no mesmo mirante, tinta velha contra tinta nova:
//   pedra nua    escuro 16,9% -> 13,4%   e o frio 27,5 -> 12,3  (era aqui o lago azul)
//   mata fechada escuro 48,9% -> 45,4%   frio 47,2
// As réguas abaixo têm folga em volta dos números de hoje: o talude nu continua sendo
// escurecido (relevo legível, contrato do #124) mas não pode pintar cor, e a copa continua
// sendo o único preto fundo da tela.
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
/** Média de cada canal na faixa central: é chão, não HUD. */
function chao(png) {
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = 100; y < 300; y += 2) {
    for (let x = 250; x < 650; x += 2) {
      const k = (png.width * y + x) << 2;
      r += png.data[k]; g += png.data[k + 1]; b += png.data[k + 2]; n++;
    }
  }
  const media = v => v / n;
  return { r: media(r), g: media(g), b: media(b), lum: media(0.2126 * r + 0.7152 * g + 0.0722 * b) };
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

  await send('Page.navigate', { url: 'about:blank' });
  await send('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 1, mobile: true });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await send('Page.navigate', { url: 'http://localhost:8082/?relief-shadow-qa=1' });
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
  await evaluate(`(()=>{const m=[...__r.getModules().values()].filter(m=>m.isInitialized).map(m=>m.publicModule.exports);
    globalThis.qa={g:m.find(m=>m?.getGame).getGame()};
    const d=qa.g.map.data;
    qa.g.player.invulnUntil=Infinity;qa.g.dayNight.t=.5;qa.g.weather.checkTimer=1e9;qa.g.hazard.cooldown=1e9;
    qa.guard={relevo:d.relevo.slice(),copa:d.copa.slice()};
    qa.ir=(x,y,h)=>{const g=qa.g;g.player.x=x;g.player.y=y;g.camera.x=x;g.camera.y=y;g.camera.h=h;};
    qa.semTinta=()=>{d.relevo.fill(0);d.copa.fill(0);};
    qa.comTinta=()=>{d.relevo.set(qa.guard.relevo);d.copa.set(qa.guard.copa);};})()`);

  // Os dois únicos casos que existem: morro sem nenhuma árvore num raio de três tiles, e
  // copada de mata. Uma faixa que misture os dois não afirma nada sobre nenhum dos dois.
  const mirantes = await evaluate(`(()=>{const d=qa.g.map.data,W=d.tilesW,H=d.tilesH;
    const copa=d.copa,relevo=d.relevo;
    // O relevo declarado é o maior declive num raio de nove tiles: sozinho ele não diz se
    // o tile EM SI é encosta. Sem pender aqui, o mirante "pedra" cai num platô do deserto e
    // a faixa central da tela não tem tinta nenhuma para medir.
    const pende=(x,y)=>{const i=y*W+x;
      return Math.max(Math.abs(d.heights[i+1]-d.heights[i]),Math.abs(d.heights[i+W]-d.heights[i]));};
    const semArvore=(t,i,x,y)=>(t.biome==='desert'||t.biome==='savanna'||t.biome==='beach')
      &&t.kind!=='water'&&t.kind!=='road'&&copa[i]===0&&d.heights[i]>=0.4&&pende(x,y)>=0.06;
    const comCopa=(t,i)=>(t.biome==='forest'||t.biome==='pinewood')&&t.kind!=='water'
      &&t.kind!=='road'&&copa[i]>=0.25;
    // Nota <0 descarta o centro. A janela, esta sim, tem de ser toda do mesmo caso: uma
    // árvore num canto já basta para o quadro não ser mais "relevo nu", e um canto plano
    // basta para a faixa medida ser asfalto de morro, não morro. A régua do relevo é o
    // maior declive num raio de nove tiles, então só a inclinação local conta.
    const varrer=(tipo,nota)=>{let m=null;
      for(let y=10;y<H-10;y++)for(let x=10;x<W-10;x++){const i=y*W+x;
        const v=nota(x,y,i);if(v<0)continue;
        let ok=true;
        for(let dy=-3;dy<=3&&ok;dy++)for(let dx=-3;dx<=3;dx++){const j=(y+dy)*W+x+dx;
          if(!tipo(d.tiles[j],j,x+dx,y+dy)){ok=false;break;}}
        if(!ok)continue;
        if(!m||v>m.v)m={x,y,alt:d.heights[i],v:+v.toFixed(2),biome:d.tiles[i].biome};}
      return m;};
    return { pedra: varrer(semArvore,(x,y,i)=>pende(x,y)>=0.15?relevo[i]:-1),
             mata: varrer(comCopa,(x,y)=>copa[y*W+x]>=0.5?copa[y*W+x]:-1) };})()`);
  console.log(JSON.stringify(mirantes));
  assert.ok(mirantes.pedra, 'não há talude nu sem copa no mapa');
  assert.ok(mirantes.mata, 'não há copada de mata no mapa');
  const nuTemArvore = await evaluate(
    `(()=>{const s=${JSON.stringify(mirantes.pedra)};const d=qa.g.map.data;
      for(const p of d.props){if(!p.key.includes('tree'))continue;
        if(Math.abs(p.x-s.x)<=3&&Math.abs(p.y-s.y)<=3)return true;}return false;})()`);
  assert.ok(!nuTemArvore, 'o mirante "pedra" tem árvore por perto: não é relevo nu');

  /** Os dois quadros do mesmo lugar: com a tinta e sem ela, na mesma célula de câmera. */
  async function par(nome, spot) {
    const tirar = async comTinta => {
      await evaluate(`qa.ir(${spot.x + 3},${spot.y + 3},${spot.alt})`);
      await delay(500);
      await evaluate(`(()=>{${comTinta ? 'qa.comTinta()' : 'qa.semTinta()'};qa.ir(${spot.x},${spot.y},${spot.alt});})()`);
      await delay(1500);
      const { data } = await send('Page.captureScreenshot', { format: 'png' });
      const f = path.resolve(__dirname, '../tmp/relief-shadow-' + nome + '-' + (comTinta ? 'tinta' : 'nu') + '.png');
      fs.writeFileSync(f, Buffer.from(data, 'base64'));
      return chao(PNG.sync.read(fs.readFileSync(f)));
    };
    const tinta = await tirar(true), semTinta = await tirar(false);
    await tirar(true);
    return {
      escuro: (semTinta.lum - tinta.lum) / semTinta.lum * 100,
      // Positivo é a tinta esfriando o chão: o azul caindo menos que o vermelho.
      frio: (tinta.b - tinta.r) - (semTinta.b - semTinta.r),
    };
  }

  let pedra = null, mata = null;
  await test('o talude nu escurece, mas não pinta cor', async () => {
    pedra = await par('pedra', mirantes.pedra);
    console.log(`  pedra nua: luminância -${pedra.escuro.toFixed(1)}%, frio ${pedra.frio.toFixed(1)}`);
    assert.ok(pedra.escuro >= 4, `a tinta sumiu do morro nu: só ${pedra.escuro.toFixed(1)}% de escuro`);
    assert.ok(pedra.escuro <= 20, `o relevo nu virou sombra de novo: ${pedra.escuro.toFixed(1)}% de escuro`);
    assert.ok(pedra.frio <= 18, `a encosta nua pinta azul sem árvore nenhuma: frio ${pedra.frio.toFixed(1)}`);
  });
  await test('a copada é o único preto fundo da tela', async () => {
    mata = await par('mata', mirantes.mata);
    console.log(`  mata fechada: luminância -${mata.escuro.toFixed(1)}%, frio ${mata.frio.toFixed(1)}`);
    assert.ok(mata.escuro >= 25, `a sombra de árvore clareou demais: ${mata.escuro.toFixed(1)}%`);
    assert.ok(mata.escuro > pedra.escuro * 1.8,
      `talude nu (${pedra.escuro.toFixed(1)}%) e copada (${mata.escuro.toFixed(1)}%) não se distinguem`);
  });
  await test('nada quebrou no caminho', async () => {
    assert.deepEqual(errors, [], 'erros na página: ' + errors.slice(0, 3).join(' | '));
  });

  console.log(`\nSombra de relevo: ${passado} passed, ${falhou} failed.`);
})().catch(e => { console.error(e); process.exit(1); })
  .finally(() => socket?.close());
