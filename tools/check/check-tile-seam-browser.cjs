// Run: node tools/check/check-tile-seam-browser.cjs (precisa do Expo web em :8082 e Chrome em :9223).
//
// O #137 chegou como impressão de tela: "os blocos dos sprites... não mostrar os quadrados,
// fica muito na cara", e a captura era um campo de grama atravessado por uma malha de
// losangos. Medido no PNG do pack: `tile_ground_grass.png` é 128×64 e tem 256 pixels de
// borda SEMI-TRANSPARENTE (alfa 67..219) exatamente sobre as quatro arestas do losango, com
// o anel externo ainda por cima mais escuro que o miúdo (142,153,79 contra 155,162,81). O
// caminho inclinado já sangra o tile em 0,6% (TILE_OVER); o caminho plano não — desenha
// `drawImage(img, A.x-64, A.y)`, colado. Vizinho colado a vizinho deixa a fresta aberta
// sobre o fundo escuro da tela, e a fresta se repete em cada junta: a grade.
//
// A régua então não olha "se tem quadradinho de sprite": monta um lote de um só piso, de
// cota exata, e mede o degrau entre a luminância da linha de emenda e a da coroa
// imediatamente dentro dela. `emenda` grande é a grade que o usuário viu; o quadro fica em
// tools/tmp/sema-<tile>.png para conferir o número com o olho.
//
// Comparar a junta com o miúdo inteiro foi o erro da primeira versão desta régua. O
// `sand_dune` é claro na beira e escuro no meio por pinta, e dava fosso negativo num piso
// perfeitamente contínuo na emenda — a régua chamava de grade o desenho do próprio tile.
// Continuidade de emenda só se mede contra o vizinho de dentro.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const WebSocket = require('ws');
const { PNG } = require('pngjs');
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
async function screenshot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  const file = `tools/tmp/${name}.png`;
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  return PNG.sync.read(fs.readFileSync(file));
}
/**
 * O chão medido pela FASE dentro do tile, não por energia de borda. A grama do pack é
 * salpicada de tufos claros e escuros, e um medidor genérico de contraste leria o mato e a
 * junta na mesma moeda. Aqui cada pixel da faixa é convertido de volta para coordenada de
 * mundo iso, e o resto da divisão pela unidade do tile diz a que distância ele está da
 * emenda. `fosso` é quanto mais escuro o miúdo da junta é que o miúdo do campo: é
 * exatamente o que o olho lê como grade, e o ruído do mato cancela na média.
 */
function malha(png, cam, alt) {
  const lum = (x, y) => {
    const k = (png.width * y + x) << 2;
    return 0.2126 * png.data[k] + 0.7152 * png.data[k + 1] + 0.0722 * png.data[k + 2];
  };
  const junta = [], adj = [], miudo = [];
  for (let sy = 102; sy < 298; sy++) {
    for (let sx = 252; sx < 648; sx++) {
      // O jogador é sempre desenhado no centro da tela, e é a coisa mais escura do quadro.
      // A régua mede chão, então o boneco fica de fora.
      if (Math.abs(sx - cam.w / 2) < 44 && Math.abs(sy - cam.h / 2) < 74) continue;
      const wx = (sx - cam.w / 2) / cam.zoom + cam.px;
      // O mundo elevado desloca Y; para voltar à grade é preciso devolver a cota do campo.
      const wy = (sy - cam.h / 2) / cam.zoom + cam.py + alt * 64;
      const u = (wx / 64 + wy / 32) / 2;
      const v = (wy / 32 - wx / 64) / 2;
      const fu = u - Math.floor(u), fv = v - Math.floor(v);
      const fase = Math.min(fu, 1 - fu, fv, 1 - fv);
      const L = lum(sx, sy);
      if (fase < 0.012) junta.push(L);
      else if (fase >= 0.02 && fase < 0.06) adj.push(L);
      else if (fase > 0.08 && fase < 0.4) miudo.push(L);
    }
  }
  const ordenado = (a) => a.slice().sort((x, y) => x - y);
  const mediana = (a) => a[a.length >> 1];
  // Percentil 5 de CADA bucket, comparado com o percentil 5 do outro. O fio de 1px da
  // franja anti-alias é mais estreito que a mediana do bucket da junta, então a mediana
  // sozinha o perdoaria; mas um percentil baixo só da junta também não prestaria, porque
  // o mato do pack tem tufo escuro em todo canto. Comparado pelo mesmo percentil, o tufo
  // cancela e sobra a emenda.
  const p05 = (a) => a[Math.max(0, (a.length * 0.05) | 0)];
  const j = ordenado(junta), a = ordenado(adj), m = ordenado(miudo);
  // `emenda` é a régua de verdade, e `fosso` ficou para trás por um motivo que só apareceu
  // na areia: comparar a junta com o miúdo inteiro mede também o gradiente radial do tile.
  // O `sand_dune` é claro na beira e escuro no meio, então um piso perfeitamente contínuo
  // na emenda ainda assim daria fosso negativo grande — a régua chamaria de grade o que é
  // pinta do próprio tile. Continuidade de emenda é sempre contra o vizinho de dentro, e o
  // bucket de adjacência (2 a 12 px para dentro da linha) é exatamente esse vizinho.
  return { junta: mediana(j), miudo: mediana(m), fosso: mediana(m) - mediana(j),
    fio: p05(m) - p05(j),
    adj: mediana(a), emenda: mediana(a) - mediana(j), emendaFio: p05(a) - p05(j),
    nJunta: j.length, nMiudo: m.length, nAdj: a.length };
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
  await send('Network.enable'); await send('Network.setCacheDisabled', { cacheDisabled: true });

  await send('Page.navigate', { url: 'about:blank' });
  await send('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 1, mobile: true });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await send('Page.navigate', { url: 'http://localhost:8082/?seam-qa=1' });
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
  await evaluate(`(()=>{const mods=[...__r.getModules().values()].filter(m=>m.isInitialized).map(m=>m.publicModule.exports);
    globalThis.qa={g:mods.find(m=>m?.getGame).getGame()};
    const G=qa.g;
    G.player.invulnUntil=Infinity;G.hazard.cooldown=1e9;G.weather.checkTimer=1e9;G.weather.force('clear',3600);
    G.dayNight.t=.5;
    qa.ir=(x,y)=>{G.player.x=x;G.player.y=y;G.camera.x=x;G.camera.y=y;G.camera.h=G.map.heightSmoothAt(x,y);
      // A folha do chão só é regravada quando a chave da câmera muda: empurra e puxa.
      G.camera.x=x+0.6;G.camera.y=y+0.6;};
    // A LAB: um lote de um só piso, cota zero, sem tinta e sem nada em cima. Não é batota —
    // é o único jeito de medir a emenda. O terreno natural nunca tem um platô de cota
    // idêntica (a altura é ruído contínuo), e sem cota única a inversão de fase do pixel
    // para o tile erra e a junta se espalha. Aqui a geometria é exata, e o que sobra na
    // emenda é só a tinta do próprio tile.
    qa.lab=(cx,cy,kind,key)=>{const d=G.map.data,W=d.tilesW;
      for(let j=-9;j<=9;j++)for(let i=-9;i<=9;i++){const idx=(cy+j)*W+(cx+i),t=d.tiles[idx];
        t.kind=kind;t.key=key;t.lane=null;t.bridge=false;d.heights[idx]=0;
        if(d.relevo)d.relevo[idx]=0;
        if(d.copa)d.copa[idx]=0;
        if(d.shades)d.shades[idx]=0;}
      qa.n=(qa.n|0)+1;
      // Cada lote precisa de uma chave de câmera sua. A folha do chão só é regravada quando
      // a cameraCellKey muda, e a chave arredonda camera.x*2: dois empurrões que caem no
      // mesmo inteiro medem a MESMA folha. Um alternador de dois lados (+2/-2) bastava para
      // quatro pisos e foi exatamente o que enganou o concreto da primeira vez; com oito
      // pisos ele reciclava a chave no sétimo e no oitavo, e a água foi lida com a folha da
      // grama. Os oito empurrões abaixo são oito chaves distintas, todos dentro dos 19x19
      // do lote e da faixa amostrada pela régua.
      const lado = (qa.n % 8) * 1.5 - 5.25;
      G.player.x=cx+lado;G.player.y=cy+lado;
      G.camera.x=cx+lado;G.camera.y=cy+lado;G.camera.h=0;};
    // O lote tem de nascer num canto que o gerador já deixou vazio. Não adianta apagar os
    // props do array: o allStatic do SortedWorldLayer é memoizado por game, então o sprite
    // da árvore continua na tela depois de a entrada sumir da lista. A única maneira de
    // medir chão nu é escolher um lugar sem prop nem prédio nenhum.
    qa.canto=()=>{const d=G.map.data,W=d.tilesW,H=d.tilesH;
      const sujo=new Uint8Array(W*H);
      const sujar=(x,y)=>{for(let j=-1;j<=1;j++)for(let i=-1;i<=1;i++){
        const tx=Math.round(x)+i,ty=Math.round(y)+j;
        if(tx>=0&&ty>=0&&tx<W&&ty<H)sujo[ty*W+tx]=1;}};
      for(const p of d.props)sujar(p.x,p.y);
      for(const b of d.buildings)for(let j=0;j<=b.footprintH;j++)
        for(let i=0;i<=b.footprintW;i++)sujar(b.x+i,b.y+j);
      const R=10;
      for(let y=R+2;y<H-R-2;y+=2)for(let x=R+2;x<W-R-2;x+=2){
        let vazio=true;
        for(let j=-R;j<=R&&vazio;j++)for(let i=-R;i<=R&&vazio;i++)if(sujo[(y+j)*W+(x+i)])vazio=false;
        if(vazio)return{x,y};
      }
      return null;};})()`);

  const lote = await evaluate('qa.canto()');
  assert.ok(lote, 'não há um lote 21×21 sem prop nem prédio no mapa');
  console.log('lote da lab em', JSON.stringify(lote));

  // Os quatro pisos de preenchimento do jogo. `sand_dry` entra lido como `dirt` porque é
  // assim que o deserto o usa: ele não tinha anel escuro, mas tinha a mesma franja.
  // As duas areias da praia entraram depois, medidas por foto: o quadro da costa mostrou
  // que `sand_beach` e `sand_dune` também são pintados lado a lado em platô de cota única,
  // e são justamente os pisos cuja franja foi opacizada sobre um degradê natural.
  const alvos = [
    { kind: 'grass', key: 'tile_ground_grass' },
    { kind: 'dirt', key: 'tile_ground_dirt' },
    { kind: 'concrete', key: 'tile_ground_concrete' },
    { kind: 'dirt', key: 'tile_ground_sand_dry' },
    { kind: 'dirt', key: 'tile_ground_sand_beach' },
    { kind: 'dirt', key: 'tile_ground_sand_dune' },
    // O piso de água aberta. Entrou depois, pelo quadro da costa: o mar inteiro é um
    // edredom de losangos de borda clara, e o bisel dele é o mesmo defeito da grama
    // atravessado para o outro lado — o pack assou brilho na aresta, não sombra. O
    // `tile_ground_water_dirty` ficou de fora da régua de propósito: o gerador nunca pinta
    // aquela chave (só a `tile_ground_water`), então medi-la era medir o piso que o
    // desenhista usa quando não acha a imagem, não a areia suja.
    { kind: 'water', key: 'tile_ground_water' },
  ];

  // QA_PISOS=tile_ground_sand_dune,tile_ground_grass mede só o que interessa: comparar o
  // mesmo piso antes e depois de rodar o prepare-ground-edges exige duas passadas curtas.
  const filtro = (process.env.QA_PISOS || '').split(',').filter(Boolean);
  const alvosMedidos = filtro.length ? alvos.filter(a => filtro.includes(a.key)) : alvos;

  const medidos = [];
  for (const campo of alvosMedidos) {
    await evaluate(`qa.lab(${lote.x},${lote.y},'${campo.kind}','${campo.key}')`);
    await delay(700);
    // Prova de que o lote é o lote e a folha é nova: o tile do centro lido de volta, a
    // posição real da câmera depois do clamp e a chave que decide se o chão re-grava. Sem
    // esta linha a oitava medição saiu com os números exatos da primeira, e a régua chamou
    // de "água suja" uma folha de grama.
    console.log(await evaluate(`(()=>{const d=qa.g.map.data,W=d.tilesW,c=qa.g.camera;
      return '  ['+qa.n+'] ${campo.key} centro='+d.tiles[${lote.y}*W+${lote.x}].key
        + ' camera='+c.x.toFixed(3)+','+c.y.toFixed(3)
        + ' chave='+Math.round(c.x*2)+','+Math.round(c.y*2);})()`));
    const cam = await evaluate(`(()=>{const c=qa.g.camera;const p={x:(c.x-c.y)*64,y:(c.x+c.y)*32-c.h*64};
      return {zoom:c.zoom,px:p.x,py:p.y,w:window.innerWidth,h:window.innerHeight};})()`);
    const m = malha(await screenshot(`sema-${campo.key}`), cam, 0);
    medidos.push({ campo, m });
    console.log(`  ${campo.key} zoom ${cam.zoom.toFixed(2)}: emenda ${m.emenda > 0 ? '+' : ''}${m.emenda.toFixed(1)} `
      + `(fio ${m.emendaFio > 0 ? '+' : ''}${m.emendaFio.toFixed(1)}) · junta ${m.junta.toFixed(1)} `
      + `vs coroa ${m.adj.toFixed(1)} vs miúdo ${m.miudo.toFixed(1)}, fosso ${m.fosso > 0 ? '+' : ''}${m.fosso.toFixed(1)}, `
      + `${m.nJunta} px na junta, ${m.nAdj} na coroa, ${m.nMiudo} no miúdo)`);
  }

  await test('nenhum chão plano é riscado por uma malha de losangos', async () => {
    // Os tetos são ±6 e ±8, e não apertados no zero por dois motivos medidos aqui: a própria
    // régua tem ruído de fase de ~2 de luminância (a grama deu +0,8 numa passada e -1,1 na
    // outra, só de a câmera ter parado um pouco antes de chegar no pedido), e os pisos têm
    // estria de conteúdo — o `sand_dry` é listrado numa família só, e a lista de pixels da
    // junta amostra um pouco mais de uma estria que a da coroa. O que a régua precisa
    // separar não é 4 de 6: é 13 a 20 de menos de 5. Foi +17,0 na grama, +20,3 no barro,
    // +13,4 no concreto e +13,2 na areia da praia antes do conserto.
    for (const { campo, m } of medidos) {
      assert.ok(Math.abs(m.emenda) <= 6, `${campo.key}: a linha da emenda difere da coroa `
        + `imediatamente dentro dela por ${m.emenda.toFixed(1)} de luminância (o teto é ±6; `
        + `quadro em tools/tmp/sema-${campo.key}.png)`);
      // A mediana da junta sai num bucket mais largo que o fio de 1px da franja, então ela
      // sozinha perdoaria justamente o defeito da franja. O percentil 5 não tem essa desculpa.
      assert.ok(Math.abs(m.emendaFio) <= 8, `${campo.key}: o fio mais escuro da emenda cai `
        + `${m.emendaFio.toFixed(1)} abaixo da coroa (o teto é ±8)`);
    }
  });

  await test('nada quebrou no caminho', async () => {
    assert.deepEqual(errors, [], 'erros na página: ' + errors.slice(0, 3).join(' | '));
  });

  console.log(`\nMalha do chão: ${passado} passed, ${falhou} failed.`);
})().catch(e => { console.error(e); process.exit(1); })
  .finally(() => socket?.close());
