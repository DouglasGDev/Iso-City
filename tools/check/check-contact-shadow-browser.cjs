// Run: node tools/check/check-contact-shadow-browser.cjs (precisa do Expo web em :8082 e Chrome em :9223).
//
// A sombra de contato (#114) é a única pista de ALTURA que o hillshade não dá: o morro tem luz
// e sombra no próprio chão, mas um carro em cima de um muro continua desenhado na mesma linha
// de quem está na rua. Aqui se mede o pixel, em dois quadros do MESMO lugar, com a MESMA câmera:
// um com o corpo no chão e outro com o corpo a 60px de folga. Comparar o mesmo pixel entre os
// dois quadros cancela o ruído do tile (cor, mote, tinta, hillshade) — sobe só o que a sombra
// fez. Medir contra uma referência LATERAL foi a primeira versão e cobria um buraco: o lote de
// estacionamento é `concrete` com textura `asphalt`, um losango escuro colado num claro, e a
// referência pegava o vizinho escuro — dava 37% de "clareamento" sem bug nenhum no render.
//
// Por que a sombra dos PRÉDIOS não é medida aqui: o arte original de cada fachada já traz uma
// faixa translúcida de sombra embaixo (medido nos PNGs: até 31px de fonte por sprite, alpha até
// 148). Um delta de pixel sob a base de um prédio não diz se escureceu o losango do lote ou a
// tinta do autor — afirmar isso seria verde falso. O contrato do losango (forma = o lote do
// colisor, deslocamento = buildingShadowDrop, desenhado por baixo da fachada e FORA do recorte
// de oclusão, teto de 18px) é o que check-fog.cjs cobra na árvore real de render.
//
// As três caixas, todas abaixo do pé projetado (o corpo só desenha ACIMA do pé, então nada
// aqui é arte do jogador disfarçada de sombra):
//   A  rente ao pé   — escura com o corpo embaixo, limpa com ele no ar: a sombra estava ali e soltou;
//   B  mais abaixo    — limpa no chão, escura no ar: ela escorregou para baixo, na direção do
//     sun do hillshade (descer na tela = +x,+y no mundo), que é o que vende altura em iso;
//   C  26px abaixo de B — igual nos dois quadros: a mancha morre na sombra de contato, não
//     desce colada no corpo. Foi exatamente o "telão" que o #129 tirou do relevo nu.
//
// Antes de medir qualquer caixa, a checagem CALIBRA o próprio mapa print↔tela: esconde o sprite
// na loja e mede onde a silhueta desaparece no print. É a única forma de provar que as caixas
// caem sobre a sombra desenhada e não sobre poeira — a página tem o canvas mais alto que o
// `viewH` medido pelo layout, então qualquer conta de escala assumida aqui seria um chute.
//
// Os limites das caixas vêm da MESMA fórmula do sprite (entityShadowWidth sobre a largura real
// do frame do player, achatado por SHADOW_FLATTEN, na cota do chão) lida do bundle da página.
// Se a folga pedida não separar as caixas, a checagem grita em vez de medir poeira.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PNG } = require('pngjs');
const WebSocket = require('ws');

/** Folga vertical de QA em px de tela. Maior que o ápice do pulo (24) de propósito: a 24px o
 *  descolamento é 4px — abaixo do que uma caixa de pixels resolve. 60px é o que um alpendre,
 *  um terraço ou a caçamba de uma picape já apresentam no jogo de hoje. */
const FOLGA = 60;
const SUN_DROP_RATIO = 0.16, SHADOW_FLATTEN = 0.5;

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
async function shot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  const f = path.resolve(__dirname, '../tmp/contato-' + name + '.png');
  fs.writeFileSync(f, Buffer.from(data, 'base64'));
  return PNG.sync.read(fs.readFileSync(f));
}
/** Luminância média de uma caixa do print. x2/y2 exclusivos. */
function lum(png, x1, y1, x2, y2) {
  let s = 0, n = 0;
  for (let y = Math.max(0, y1 | 0); y < Math.min(png.height, y2 | 0); y++) {
    for (let x = Math.max(0, x1 | 0); x < Math.min(png.width, x2 | 0); x++) {
      const k = (png.width * y + x) << 2;
      s += 0.2126 * png.data[k] + 0.7152 * png.data[k + 1] + 0.0722 * png.data[k + 2]; n++;
    }
  }
  if (n < 6) throw new Error(`caixa demais pequena para medir (${x1},${y1})-(${x2},${y2})`);
  return s / n;
}
const mediana = xs => [...xs].sort((a, b) => a - b)[xs.length >> 1];
/** Quanto a caixa escureceu contra a referência lateral do MESMO quadro. */
const escuro = (alvo, ref) => (ref - alvo) / ref * 100;
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
  await send('Page.navigate', { url: 'http://localhost:8082/?contact-shadow-qa=1' });
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
  // O mundo abre com a fila de sprites ainda correndo, e esta medição é pixel por pixel contra
  // o frame exato do player: sem a fila pousada, a ponte não acharia a arte e o quadro sairia
  // sem sombra por motivo nenhum. A espera é da fila, não do jogo.
  await until(`(()=>{const ms=[...__r.getModules().values()].filter(m=>m.isInitialized)
      .map(m=>m.publicModule.exports);const store=ms.find(m=>m?.spriteStore).spriteStore;
    return ms.find(m=>m?.CARREGAMENTO).CARREGAMENTO.every((k)=>!!store[k])})()`,
    'fila de sprites fechada', 180000);

  // Ponte: o jogo, a projeção iso e a ARTE do player — tudo do bundle que está desenhando.
  // Refazer a conta da sombra no arquivo do teste seria provar outra coisa.
  const ponte = await evaluate(`(()=>{const ms=[...__r.getModules().values()].filter(m=>m.isInitialized).map(m=>m.publicModule.exports);
    const iso=ms.find(m=>m?.worldToScreen&&m?.screenToWorld);
    const reg=ms.find(m=>m?.characterKey&&m?.buildingKey);
    const store=ms.find(m=>m?.spriteStore);
    if(!iso||!reg||!store)return 'faltam módulos: '+[!iso?'iso':'',!reg?'registry':'',!store?'store':''].join(' ');
    const g=ms.find(m=>m?.getGame).getGame();
    globalThis.qa={g,iso,characterKey:reg.characterKey,spriteStore:store.spriteStore};
    g.player.invulnUntil=Infinity;g.player.health=100;
    g.dayNight.t = .5;
    // Céu limpo e parado: chuva desenhada no meio do quadro é ruído entre os dois quadros.
    const w = g.weather;
    w.kind = 'clear'; w.intensity = 0; w.cover = 0; w.mist = 0; w.wind = 0;
    w.target = 0; w.coverTarget = 0; w.mistTarget = 0; w.windTarget = 0;
    w.frontLeft = 0; w.escalateIn = 1e9; w.checkTimer = 1e9;
    // Corpo limpo: sem arma na mão (o recorte do braço muda o sprite) e sem ninguém por perto —
    // NPC, carro, bicho e destroço também projetam sombra e cairiam na caixa do player.
    g.weapons.equipped = 'unarmed';
    g.npcs.length = 0; g.vehicles.length = 0; g.crowd.list.length = 0;
    g.wildlife.animals.length = 0; g.pickups.items.length = 0; g.destruction.wrecks.length = 0;
    // Em pé, parado, num frame só: é a única forma de os dois quadros differem APENAS da sombra.
    g.player.speed = 0; g.player.vx = 0; g.player.vy = 0; g.player.anim = 'idle'; g.player.frame = 0;
    g.player.jumpTimer = 0; g.player.jumpHeight = 0; g.shakeX = 0; g.shakeY = 0;
    // Congela a simulação pelo caminho de sempre (GameState.update sai antes de mover
    // câmera, tempo e entidades). O laço de render continua: é ele que leva a posição nova
    // para a tela e refaz a malha do chão a cada meio tile de câmera.
    g.paused = true;
    g.notifyEntityChange();
    // O pixel do print a partir do mundo: a mesma projeção da câmera, no mesmo recorte.
    qa.tela=(x,y,h)=>{const p=qa.iso.worldToScreen(x,y,h),c=qa.iso.worldToScreen(g.camera.x,g.camera.y,g.camera.h);
      return{x:g.viewW/2+g.shakeX+(p.x-c.x)*g.camera.zoom,y:g.viewH/2+g.shakeY+(p.y-c.y)*g.camera.zoom};};
    // A superfície Skia é o canvas do maior; o desenho dele é em px de CSS, 1:1 com o print.
    const el=[...document.querySelectorAll('canvas')].sort((a,b)=>b.width*b.height-a.width*a.height)[0];
    const r=el.getBoundingClientRect();
    qa.ox=r.left; qa.oy=r.top; qa.rect={x:r.left,y:r.top,w:r.width,h:r.height};
    qa.telaPrint=(x,y,h)=>{const p=qa.tela(x,y,h);return{x:p.x+qa.ox,y:p.y+qa.oy};};
    // Print → mundo: desfaz a origem do canvas, a centragem da câmera e o zoom, e devolve a
    // SUPERFÍCIE pintada naquele pixel — tipo, textura do tile e copa. Não basta o kind: o lote
    // de estacionamento é concrete com textura asphalt, e medir sombra de contato sobre um
    // losango claro ao lado de um escuro daria 37% de clareamento sem bug nenhum no render.
    qa.chaoDaTela=(sx,sy)=>{const d=g.map.data;
      const c=qa.iso.worldToScreen(g.camera.x,g.camera.y,g.camera.h);
      const q=qa.iso.screenToWorld(c.x+(sx-qa.ox-g.viewW/2-g.shakeX)/g.camera.zoom,
                                  c.y+(sy-qa.oy-g.viewH/2-g.shakeY)/g.camera.zoom);
      const x=Math.round(q.x),y=Math.round(q.y);
      if(x<0||y<0||x>=d.tilesW||y>=d.tilesH)return null;
      const i=y*d.tilesW+x,t=d.tiles[i];
      return t?t.kind+':'+t.key.replace('tile_ground_','')+(d.copa[i]>0?'|copa':'|nu'):null};
    const key=reg.characterKey(g.player.char,g.player.anim,g.player.direction,g.player.frame);
    const img=store.spriteStore[key];
    if(!img)return 'frame do player não está na loja: '+key;
    return{rx:Math.max(6,Math.min(26,img.width()*0.36)),z:g.camera.zoom,vw:g.viewW,vh:g.viewH,
      dpr:devicePixelRatio,rect:qa.rect,pw:innerWidth,ph:innerHeight,key,spriteW:img.width()};})()`);
  assert.equal(typeof ponte, 'object', 'ponte de QA: ' + ponte);
  const { rx, z, vw, vh, dpr, rect, pw, ph, key, spriteW } = ponte;
  console.log(`  sombra do player: rx ${rx.toFixed(2)}px de um sprite ${spriteW}px, zoom ${z} (${key})`);
  assert.equal(dpr, 1, `pixel ratio ${dpr}: o print deixaria de ser 1:1 com o desenho`);
  assert.ok(Math.abs(rect.w - vw) <= 2 && Math.abs(rect.x) <= 0.5 && Math.abs(rect.y) <= 0.5,
    `o canvas de jogo não está em (0,0) com a largura da vista: rect ${JSON.stringify(rect)} vs view ${vw}x${vh} (print ${pw}x${ph})`);
  // A altura do canvas pode passar da vista (o layout do RN mede menos que a superfície
  // Skia); o que não pode é haver ESCALA — e é a calibração abaixo que prova isso no pixel.

  /**
   * Vãos de calçada nivelada: a MESMA textura de chão num quadrado 3x3, sem copa, sem lote e
   * sem prop. Toda a medição vive dentro de ±0,6 tile do pé (a caixa mais funda está 40px
   * abaixo e a mais larga 52px ao lado, no zoom da página), então é esse o território que
   * precisa estar limpo — pedir 5x5 não existe na malha desta cidade: o calçamento entre
   * lotes tem dois tiles, e a grade de ocupantes com folga mataria todos os candidatos.
   *
   * A exigência é o `key`, não o `kind`: o lote de estacionamento é `concrete` com textura
   * `asphalt`. Ela não serve mais para a conta (o delta é pixel contra o próprio pixel), mas
   * serve para o vão ser chão de calçada e não um tapete de asfalto onde 16% de sombra sobre
   * luminância 51 não deixa nada medir.
   */
  const vãos = await evaluate(`(()=>{const g=qa.g,d=g.map.data,W=d.tilesW,H=d.tilesH;
    const ocupado=new Uint8Array(W*H);
    // Marca o que de fato pisa o tile: o lote do prédio e o tile do prop, sem folga. A folga
    // grande (1 tile de um lado, 2 do outro) era para a referência lateral, que não existe mais.
    for(const b of d.buildings){const s=b.footprintW||2;
      for(let y=Math.round(b.y-s);y<=Math.round(b.y);y++)for(let x=Math.round(b.x-s);x<=Math.round(b.x);x++)
        if(x>=0&&y>=0&&x<W&&y<H)ocupado[y*W+x]=1;}
    for(const p of d.props){const x=Math.round(p.x),y=Math.round(p.y);
      if(x>=0&&y>=0&&x<W&&y<H)ocupado[y*W+x]=1;}
    const out=[];
    for(let y=20;y<H-20&&out.length<6;y++)for(let x=20;x<W-20&&out.length<6;x++){
      const i=y*W+x,t=d.tiles[i];
      if(!t||ocupado[i]||t.kind!=='concrete'||t.key!=='tile_ground_concrete')continue;
      let ok=true;
      for(let dy=-1;dy<=1&&ok;dy++)for(let dx=-1;dx<=1;dx++){
        const j=(y+dy)*W+x+dx;const v=d.tiles[j];
        if(!v||ocupado[j]||v.kind!=='concrete'||v.key!=='tile_ground_concrete'
          ||d.copa[j]>0||Math.abs(d.heights[j])>0.01){ok=false;break;}}
      if(!ok)continue;
      out.push({x,y});}
    return out;})()`);
  assert.ok(vãos.length >= 2, `não há dois vãos de chão liso para medir: ${vãos.length}`);

  /**
   * Coloca o corpo sobre o vão (no canto do tile pedido, mais o deslocamento dentro dele) e
   * devolve o pé já em pixel de print. O deslocamento importa: sem ele as três amostras cairiam
   * no mesmo pixel do mesmo tile repetido e a mediana seria uma leitura só vestida de três.
   */
  async function pisar(x, y) {
    await evaluate(`(()=>{const g=qa.g,p=g.player,h=g.map.heightSmoothAt(${x},${y});
      p.x=${x};p.y=${y};p.vx=0;p.vy=0;p.speed=0;p.jumpTimer=0;p.jumpHeight=0;
      g.camera.x=${x};g.camera.y=${y};g.camera.h=h;g.shakeX=0;g.shakeY=0;g.notifyEntityChange();})()`);
    // A simulação está congelada: quem ancora a cena é o laço de render, não o passo do mundo.
    await delay(420);
    const fixo = await evaluate(`(()=>{const g=qa.g;return Math.abs(g.camera.x-${x})<0.01
      &&Math.abs(g.camera.y-${y})<0.01&&Math.abs(g.player.jumpHeight)<0.01;})()`);
    assert.ok(fixo, `a câmera não ficou no vão pedido: ${JSON.stringify(await evaluate('[qa.g.camera.x,qa.g.camera.y]'))}`);
    return evaluate(`qa.telaPrint(${x},${y},qa.g.map.heightSmoothAt(${x},${y}))`);
  }

  /**
   * Calibração: esconde o frame do player na loja e mede onde a silhueta sumiu no print. A
   * ponta de baixo da silhueta é a elipse da própria sombra (o corpo termina no pé), então
   * isto prova, em pixel, o mapa print↔tela E que a sombra está sendo desenhada onde a fórmula
   * diz — antes de qualquer caixa confiar nisso.
   */
  const vão0 = vãos[0];
  const pe0 = await pisar(vão0.x, vão0.y);
  const cheio = await shot('calib-cheio');
  await evaluate(`qa.__k=qa.characterKey(qa.g.player.char,qa.g.player.anim,qa.g.player.direction,qa.g.player.frame);
    qa.__old=qa.spriteStore[qa.__k];delete qa.spriteStore[qa.__k];qa.g.notifyEntityChange();`);
  await delay(420);
  const semCorpo = await shot('calib-sem-corpo');
  await evaluate(`qa.spriteStore[qa.__k]=qa.__old;qa.g.notifyEntityChange();`);
  await delay(420);
  let cx1 = 1e9, cy1 = 1e9, cx2 = -1, cy2 = -1, npx = 0, fora = 0;
  // Só a vizinhança do corpo: o HUD (radar, relógio, botões) também é canvas e muda sozinho
  // entre dois prints — contar a tela inteira daria silhueta onde há ícone.
  const jx0 = Math.max(0, Math.round(pe0.x - 90)), jx1 = Math.min(cheio.width - 1, Math.round(pe0.x + 90));
  const jy0 = Math.max(0, Math.round(pe0.y - 90)), jy1 = Math.min(cheio.height - 1, Math.round(pe0.y + 60));
  for (let y = 0; y < Math.min(cheio.height, semCorpo.height); y++) {
    for (let x = 0; x < Math.min(cheio.width, semCorpo.width); x++) {
      const i = (cheio.width * y + x) << 2;
      const d = Math.abs(cheio.data[i] - semCorpo.data[i]) + Math.abs(cheio.data[i + 1] - semCorpo.data[i + 1])
        + Math.abs(cheio.data[i + 2] - semCorpo.data[i + 2]);
      if (d <= 12) continue;
      if (x < jx0 || x > jx1 || y < jy0 || y > jy1) { fora++; continue; }
      npx++;
      if (x < cx1) cx1 = x; if (x > cx2) cx2 = x; if (y < cy1) cy1 = y; if (y > cy2) cy2 = y;
    }
  }
  console.log(`  diff fora da vizinhança do corpo: ${fora}px (HUD/ícones, ignorados de propósito)`);
  assert.ok(npx > 120, `esconder o sprite não mudou o print (${npx}px): nada seria medido`);
  assert.ok(Math.abs(cx2 - cx1 + 1 - rx * 2 * z) <= 14,
    `a silhueta sumida tem ${cx2 - cx1 + 1}px de largura, não os ${(rx * 2 * z).toFixed(0)}px da sombra`);
  const ponta = cy2 + 1;
  const prevista = pe0.y - 1 + rx * SHADOW_FLATTEN * z;
  console.log(`  calibração: silhueta em x ${cx1}..${cx2}, y ${cy1}..${cy2}; pé do print em ` +
    `(${pe0.x.toFixed(1)},${pe0.y.toFixed(1)}), ponta da sombra prevista em ${prevista.toFixed(1)}px`);
  assert.ok(Math.abs(ponta - prevista) <= 4,
    `a sombra desenhada não termina onde a fórmula projecta (print ${ponta} vs previsto ${prevista.toFixed(1)}): ` +
    `o mapa print↔tela não é 1:1, as caixas mediriam poeira`);
  assert.ok(Math.abs((cx1 + cx2 + 1) / 2 - pe0.x) <= 3,
    `a sombra não está centrada no pé: print ${(cx1 + cx2 + 1) / 2} vs ${pe0.x.toFixed(1)}`);
  assert.ok(ponta - cy1 >= 3, `a silhueta sumida tem só ${ponta - cy1}px de altura`);

  /**
   * As três caixas, em pixels do print, nascidas da geometria real da sombra nos dois estados
   * (a mesma `entityShadowWidth`/`SHADOW_FLATTEN`/`SUN_DROP_RATIO` do sprite, na largura do
   * frame do player e no zoom da câmera). Se a folga pedida não as separa, isto joga fora em
   * vez de medir: sobreposição de elipse não afirma nada.
   */
  function caixas(pe, r, zz) {
    const s0x = r * zz, s0y = s0x * SHADOW_FLATTEN, y0 = pe.y - 1;
    const spread = 1 - Math.min(0.35, FOLGA / 600);
    const s1x = s0x * spread, s1y = s0y * spread, y1 = y0 + FOLGA * SUN_DROP_RATIO * zz;
    const A = { x1: Math.round(pe.x - s0x * 0.45), x2: Math.round(pe.x + s0x * 0.45),
      y1: Math.ceil(y0 + s0y * 0.3), y2: Math.floor(y0 + s0y * 0.75) + 1 };
    const B = { x1: Math.round(pe.x - s1x * 0.45), x2: Math.round(pe.x + s1x * 0.45),
      y1: Math.ceil(y1 - s1y * 0.6), y2: Math.floor(y1 + s1y * 0.6) + 1 };
    const C = { x1: Math.round(pe.x - s0x * 0.7), x2: Math.round(pe.x + s0x * 0.7),
      y1: Math.floor(y0 + s0y + 26), y2: Math.floor(y0 + s0y + 33) };
    assert.ok((A.y2 - A.y1) * (A.x2 - A.x1) >= 12,
      `faixa do pé miúda demais para resolver no print (${A.x2 - A.x1}x${A.y2 - A.y1}px de uma sombra ${s0x.toFixed(1)}x${s0y.toFixed(1)})`);
    assert.ok((B.y2 - B.y1) * (B.x2 - B.x1) >= 12, `caixa de baixo miúda demais (${B.x2 - B.x1}x${B.y2 - B.y1})`);
    assert.ok(B.y1 > y0 + s0y + 1,
      `a sombra de quem está no chão já descia até a caixa de baixo (${B.y1} <= ${(y0 + s0y + 1).toFixed(1)})`);
    assert.ok(y1 - s1y > A.y2,
      `no ar a sombra ainda cobria a faixa do pé (${(y1 - s1y).toFixed(1)} <= ${A.y2})`);
    assert.ok(C.y2 <= vh - 4 && C.x2 <= vw - 4 && C.x1 > 4,
      `as caixas saíram da superfície desenhada: ${JSON.stringify(C)} num recorte de ${vw}x${vh}`);
    // Referência lateral não existe mais: o delta é o mesmo pixel nos dois quadros.
    return { A, B, C };
  }

  /** A média de luminância das três caixas no quadro dado. */
  function ler(png, cx) {
    const caixa = (b) => lum(png, b.x1, b.y1, b.x2, b.y2);
    return { A: caixa(cx.A), B: caixa(cx.B), C: caixa(cx.C) };
  }

  /** Chão de cada canto e do centro das três caixas, de uma vez. */
  async function tipos(cx) {
    const pts = [];
    for (const b of [cx.A, cx.B, cx.C]) {
      pts.push([b.x1 + 1, b.y1 + 1], [(b.x1 + b.x2) / 2, (b.y1 + b.y2) / 2], [b.x2 - 1, b.y2 - 1]);
    }
    const out = await evaluate(`(()=>[${pts.map(([x, y]) => `qa.chaoDaTela(${x},${y})`).join(',')}])()`);
    return out.map((t, i) => t ?? `nulo(${pts[i][0].toFixed(1)},${pts[i][1].toFixed(1)})`);
  }

  /** Um vão: os dois quadros do MESMO pixel e as médias que saem deles. */
  async function medir(vão, desvio) {
    const x = vão.x + desvio, y = vão.y + desvio;
    const pe = await pisar(x, y);
    const chao = await shot('chao-' + x + '-' + y);
    const cx = caixas(pe, rx, z);
    const solo = ler(chao, cx);

    // Ar: a folga é escrita directo no player, com a simulação congelada — ninguém se move,
    // é por isso que as duas leituras são do mesmo pixel, sem ruído de tile.
    await evaluate(`(()=>{const g=qa.g;g.player.jumpHeight=${FOLGA};})()`);
    const peAr = await pisarAr(x, y);
    assert.ok(Math.abs(peAr.x - pe.x) < 0.4 && Math.abs(peAr.y - pe.y) < 0.4,
      `o corpo mudou de lugar entre os dois quadros: ${pe.x.toFixed(1)},${pe.y.toFixed(1)} → ${peAr.x.toFixed(1)},${peAr.y.toFixed(1)}`);
    const noAr = ler(await shot('ar-' + x + '-' + y), cx);
    await evaluate(`qa.g.player.jumpHeight=0;`);
    return { vão, x, y, solo, noAr, tipos: await tipos(cx) };
  }

  /** Como `pisar`, mas sem zerar a folga: o corpo continua a 60px, a câmera no mesmo pixel. */
  async function pisarAr(x, y) {
    await delay(420);
    const fixo = await evaluate(`(()=>{const g=qa.g;return Math.abs(g.camera.x-${x})<0.01
      &&Math.abs(g.camera.y-${y})<0.01&&Math.abs(g.player.jumpHeight-${FOLGA})<0.01;})()`);
    assert.ok(fixo, 'a folga de QA não ficou aplicada entre os dois quadros');
    return evaluate(`qa.telaPrint(${x},${y},qa.g.map.heightSmoothAt(${x},${y}))`);
  }

  // Três deslocamentos dentro do mesmo vão: o tile de concreto é repetido, e o pé sempre no
  // mesmo canto dele daria três leituras do MESMO pixel — uma amostra vestida de três.
  const amostras = [];
  for (const [i, desvio] of [0, 0.34, 0.67].entries()) {
    amostras.push(await medir(vãos[i % vãos.length], desvio));
  }
  assert.ok(amostras.length >= 2, `não medi dois vãos: ${amostras.length}`);
  for (const a of amostras) {
    assert.ok(a.tipos.every((t) => t === a.tipos[0]),
      `vão ${a.x},${a.y}: as caixas pegaram tipos de chão diferentes: ${a.tipos.join(' ')}`);
    assert.ok(!a.tipos[0].endsWith('|copa'),
      `vão ${a.x},${a.y} está sob copa de árvore: a sombra da árvore entraria na conta`);
    assert.ok(a.tipos[0] === 'concrete:concrete|nu',
      `vão ${a.x},${a.y}: o chão amostrado não é concreto claro nivelado: ${a.tipos[0]}`);
    // Sem luz no chão não há sombra que medir: caixa escura aqui é arte de prop ou prédio
    // cobrindo o losango, e o delta sairia zero por um motivo que não é o #114.
    assert.ok(a.noAr.A >= 120,
      `vão ${a.x},${a.y}: o pé nem está sobre chão claro (luminância ${a.noAr.A.toFixed(0)} no ar): ` +
      `a caixa está coberta por alguma arte e não mediria sombra nenhuma`);
    console.log(`  vão ${a.x.toFixed(2)},${a.y.toFixed(2)} (${a.tipos[0]}): A ${a.solo.A.toFixed(1)}→${a.noAr.A.toFixed(1)}, ` +
      `B ${a.solo.B.toFixed(1)}→${a.noAr.B.toFixed(1)}, C ${a.solo.C.toFixed(1)}→${a.noAr.C.toFixed(1)}`);
  }

  await test('quem está no chão pisa uma sombra', async () => {
    // O MESMO pixel, com e sem o corpo embaixo: 100% do que mudou é sombra de contato.
    const pisa = amostras.map((m) => escuro(m.solo.A, m.noAr.A));
    console.log(`  faixa do pé escurece ` + pisa.map((v) => v.toFixed(1) + '%').join(' / ') +
      ` com o corpo no chão`);
    assert.ok(mediana(pisa) >= 3, `a sombra de contato não escurece o chão sob o pé: mediana ${mediana(pisa).toFixed(1)}%`);
  });

  await test('o corpo sobe e a sombra solta o pé', async () => {
    // Distinto do primeiro por medir o outro lado do mesmo fenômeno: não basta o pé clarear
    // (a sombra poderia ter simplesmente esvanecido com a altura, o que não vende nada).
    const pisa = amostras.map((m) => escuro(m.solo.A, m.noAr.A));
    const solta = amostras.map((m) => escuro(m.noAr.B, m.solo.B));
    console.log(`  o que saiu do pé (` + pisa.map(v => v.toFixed(1) + '%').join('/') +
      `) chegou abaixo (` + solta.map(v => v.toFixed(1) + '%').join('/') + `)`);
    assert.ok(mediana(solta) >= mediana(pisa) * 0.6,
      `a sombra sumiu em vez de descer: saiu ${mediana(pisa).toFixed(1)}% do pé e só chegou ` +
      `${mediana(solta).toFixed(1)}% na caixa de baixo`);
  });

  await test('ela escorrega para baixo, na direção do sol', async () => {
    const cai = amostras.map((m) => escuro(m.noAr.B, m.solo.B));
    console.log(`  caixa abaixo do pé escureceu ` + cai.map(v => v.toFixed(1) + '%').join(' / ') +
      ` quando o corpo subiu`);
    assert.ok(mediana(cai) >= 3,
      `a sombra não desceu com a folga: ${mediana(cai).toFixed(1)}% na caixa de baixo — ` +
      `ou ela ficou colada no chão, ou subiu junto com o corpo (tela escura acima do pé não vende altura)`);
  });

  await test('a mancha morre na sombra de contato', async () => {
    const cauda = amostras.map((m) => Math.abs(escuro(m.noAr.C, m.solo.C)));
    console.log(`  26px abaixo da sombra: mudou ` + cauda.map(v => v.toFixed(2) + '%').join(' / '));
    assert.ok(mediana(cauda) <= 1.5,
      `a sombra desceu junto com o corpo: ${mediana(cauda).toFixed(1)}% na cauda — é o telão do #129 de novo`);
  });

  await test('nada quebrou no caminho', async () => {
    assert.deepEqual(errors, [], 'erros na página: ' + errors.slice(0, 3).join(' | '));
  });

  console.log(`\nSombra de contato: ${passado} passed, ${falhou} failed.`);
})().catch(e => { console.error(e); process.exit(1); })
  .finally(() => socket?.close());
