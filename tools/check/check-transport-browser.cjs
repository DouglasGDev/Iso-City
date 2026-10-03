/**
 * Rede de transporte no jogo real: a malha nasce do mapa no construtor do `GameState`, o
 * portão de zonas decide o que se materializa enquanto a câmera anda, o relógio do horário é
 * o relógio do jogo — morrer ou entrar numa sala não atrasa ônibus nenhum — e a unidade viva
 * chega de verdade à tela: a prova final congela a rua, esconde UMA unidade e mede o pixel
 * que desaparece no ponto exato onde o horário a projeta. Roda contra o bundle do navegador;
 * o que está fora do mapa é o `check-transport`.
 */
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
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
  const file = path.join(output, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  return PNG.sync.read(fs.readFileSync(file));
}
/**
 * Diferença entre dois quadros da rua congelada, agrupada em manchas 8-vizinhas. O agrupamento
 * é o que separa o ônibus do resto: a HUD continua respirando com o `update` do mundo parado
 * (ela é animada no UI thread, não pela simulação), e uma régua que somasse todos os pixels
 * chamaria de "sprite" o botão do joystick. Cada mancha traz sua caixa, seu centro e a cor que
 * ela tem no primeiro quadro — é assim que se cobra "um ônibus de 82×56, aqui, desta cor".
 */
function manchas(a, b) {
  const W = a.width, H = a.height;
  const mask = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const k = (W * y + x) << 2;
      if (Math.abs(a.data[k] - b.data[k]) + Math.abs(a.data[k + 1] - b.data[k + 1])
        + Math.abs(a.data[k + 2] - b.data[k + 2]) > 24) mask[W * y + x] = 1;
    }
  }
  const visto = new Uint8Array(W * H);
  const grupos = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = W * y + x;
      if (!mask[i] || visto[i]) continue;
      const pilha = [[x, y]];
      visto[i] = 1;
      let n = 0, sx = 0, sy = 0, r = 0, g = 0, bl = 0;
      let x0 = x, x1 = x, y0 = y, y1 = y;
      while (pilha.length) {
        const [cx, cy] = pilha.pop();
        const k = (W * cy + cx) << 2;
        n++; sx += cx; sy += cy; r += a.data[k]; g += a.data[k + 1]; bl += a.data[k + 2];
        if (cx < x0) x0 = cx; if (cx > x1) x1 = cx;
        if (cy < y0) y0 = cy; if (cy > y1) y1 = cy;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const nx = cx + dx, ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
            const j = W * ny + nx;
            if (!mask[j] || visto[j]) continue;
            visto[j] = 1; pilha.push([nx, ny]);
          }
        }
      }
      grupos.push({ n, cx: sx / n, cy: sy / n, x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1,
        cor: [Math.round(r / n), Math.round(g / n), Math.round(bl / n)] });
    }
  }
  grupos.sort((p, q) => q.n - p.n);
  return { total: mask.reduce((s, v) => s + v, 0), grupos };
}
/** Pixels diferentes dentro de uma caixa: é como se confere se o ônibus voltou idêntico. */
function naCaixa(a, b, x0, y0, x1, y1) {
  let n = 0;
  for (let y = Math.max(0, y0); y <= Math.min(a.height - 1, y1); y++) {
    for (let x = Math.max(0, x0); x <= Math.min(a.width - 1, x1); x++) {
      const k = (a.width * y + x) << 2;
      if (Math.abs(a.data[k] - b.data[k]) + Math.abs(a.data[k + 1] - b.data[k + 1])
        + Math.abs(a.data[k + 2] - b.data[k + 2]) > 24) n++;
    }
  }
  return n;
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
    + 'globalThis.qa={g:mods.find(m=>m?.getGame).getGame(),cfg:mods.find(m=>m?.GAME_CONFIG).GAME_CONFIG,'
    + 'sprites:mods.find(m=>m?.spriteStore).spriteStore};})()');
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

  // 5) O ônibus da malha aparece na tela. A rua é congelada e uma ÚNICA unidade é escondida:
  // o pixel que muda entre os dois quadros é o sprite dela, no ponto exato onde o horário
  // projeta aquela unidade na câmera. Sem essa diferença, "a linha roda" continuaria sendo
  // verdade mesmo com o desenho nunca tendo chegado à tela.
  const estação = await evaluate(`(() => {
    const g = qa.g, t = g.transport;
    g.player.invulnUntil = Infinity;
    g.weather.force('clear', 3600);
    g.dayNight.t = 0.5;
    qa.parada = t.network.stations.filter((s) => s.lines.length >= 2)
      .sort((a, b) => b.lines.length - a.lines.length || a.id - b.id)[0];
    qa.ir = (x, y) => { g.player.x = x; g.player.y = y; g.camera.h = g.map.heightSmoothAt(x, y);
      g.camera.x = x + 0.6; g.camera.y = y + 0.6; };
    qa.ir(qa.parada.x, qa.parada.y);
    // Candidato é a unidade viva cuja arte já está no depósito e cujo pé cai dentro da tela,
    // longe o suficiente da borda para o sprite inteiro caber no quadro.
    qa.candidatos = () => {
      const c = g.camera, z = c.zoom;
      const px = (c.x - c.y) * 64, py = (c.x + c.y) * 32 - c.h * 64;
      const W = window.innerWidth, H = window.innerHeight, found = [];
      for (let i = 0; i < t.units.length; i++) {
        const u = t.units[i];
        if (!u.live) continue;
        const chave = 'Vehicles/veh_bus_school_' + u.dir + '.png';
        const img = qa.sprites[chave];
        // A dimensão vem da própria arte, não de uma constante: é o retângulo que o
        // EntitySprite desenha (base centrada no pé, ampliada pelo zoom da câmera).
        if (!img || !img.width() || !img.height()) continue;
        const sx = (u.x - u.y) * 64;
        const sy = (u.x + u.y) * 32 - g.map.heightSmoothAt(u.x, u.y) * 64;
        const ex = W / 2 + z * (sx - px), ey = H / 2 + z * (sy - py);
        const sw = img.width() * z, sh = img.height() * z;
        if (ex - sw / 2 < 8 || ex + sw / 2 > W - 8 || ey - sh < 8 || ey + 24 > H - 8) continue;
        found.push({ i, d: Math.hypot(u.x - c.x, u.y - c.y), dir: u.dir, parado: u.stopped, sw, sh });
      }
      return found.sort((a, b) => a.d - b.d);
    };
    return { nome: qa.parada.name, linhas: qa.parada.lines.length };
  })()`);
  await until('qa.candidatos().length > 0', 'um ônibus da malha chegar ao alcance da câmera', 150000);

  let desenhado = null;
  const tentativas = [];
  for (const c of await evaluate('qa.candidatos().slice(0, 6)')) {
    await evaluate('(() => {qa.__u=' + c.i + '; qa.__rua = qa.g.update; qa.g.update = () => {};})()');
    await delay(1400);
    const alvo = await evaluate(`(() => {const g = qa.g, c = g.camera, u = g.transport.units[qa.__u];
      const px = (c.x - c.y) * 64, py = (c.x + c.y) * 32 - c.h * 64;
      const sx = (u.x - u.y) * 64;
      const sy = (u.x + u.y) * 32 - g.map.heightSmoothAt(u.x, u.y) * 64;
      const img = qa.sprites['Vehicles/veh_bus_school_' + u.dir + '.png'];
      return { viva: u.live, dir: u.dir, zoom: c.zoom, w: img.width(), h: img.height(),
        ex: window.innerWidth / 2 + c.zoom * (sx - px),
        ey: window.innerHeight / 2 + c.zoom * (sy - py) };})()`);
    if (!alvo.viva) {
      await evaluate('(() => {qa.g.update = qa.__rua; delete qa.__rua;})()');
      continue;
    }
    const com = await screenshot('qa-bus-com');
    await evaluate('(() => {const u = qa.g.transport.units[qa.__u]; qa.__era = u.live; u.live = false;})()');
    await delay(700);
    const sem = await screenshot('qa-bus-sem');
    await evaluate('(() => {qa.g.transport.units[qa.__u].live = qa.__era;})()');
    await delay(700);
    const voltou = await screenshot('qa-bus-voltou');
    await evaluate('(() => {qa.g.update = qa.__rua; delete qa.__rua;})()');
    const dif = manchas(com, sem);
    // Onde o horário diz que o ônibus está: base centrada no pé, corpo subindo `h*zoom`.
    const largura = alvo.w * alvo.zoom, altura = alvo.h * alvo.zoom;
    const esperado = { x: alvo.ex, y: alvo.ey - altura / 2 };
    // A mancha que interessa é a que está ONDE o horário manda, não simplesmente a maior:
    // a HUD também se mexe com a rua congelada, e escolher por tamanho aceitaria um botão.
    let melhor = null;
    for (const gr of dif.grupos) {
      if (gr.n < 200) break;
      const d = Math.hypot(gr.cx - esperado.x, gr.cy - esperado.y);
      if (!melhor || d < melhor.dist) melhor = { ...gr, dist: d };
    }
    if (!melhor) { tentativas.push({ i: c.i, manchas: dif.grupos.length, n: dif.total }); continue; }
    // Ao voltar a viver, a mesma caixa tem que voltar a ser o mesmo quadro: é o que prova
    // que a diferença foi causada pelo flag da unidade e não por animação solta.
    const devolta = naCaixa(com, voltou, melhor.x0 - 2, melhor.y0 - 2, melhor.x1 + 2, melhor.y1 + 2);
    tentativas.push({ i: c.i, n: melhor.n, w: melhor.w, h: melhor.h, dist: +melhor.dist.toFixed(1),
      devolta, esperado: { w: +largura.toFixed(1), h: +altura.toFixed(1) } });
    if (melhor.n >= 400 && melhor.n <= com.width * com.height * 0.02 && melhor.dist <= altura / 2
      && melhor.w >= largura * 0.5 && melhor.w <= largura * 1.35
      && melhor.h >= altura * 0.5 && melhor.h <= altura * 1.35 && devolta <= Math.max(60, melhor.n * 0.05)) {
      desenhado = {
        ...melhor, devolta, i: c.i, dir: alvo.dir, largura, altura, total: dif.total, grupos: dif.grupos.length,
      };
      break;
    }
  }
  check(!!desenhado, `cada ônibus vivo da malha é desenhado no ponto exato onde o horário o põe `
    + `(últimas tentativas ${JSON.stringify(tentativas.slice(-3))} na estação ${estação.nome}, `
    + `${estação.linhas} linhas)`);
  if (desenhado) {
    check(true, `ônibus ${desenhado.dir} da malha na tela: ${desenhado.n} pixels na caixa `
      + `${desenhado.w}x${desenhado.h} contra a arte ${desenhado.largura.toFixed(0)}x${desenhado.altura.toFixed(0)} sob zoom, `
      + `centro a ${desenhado.dist.toFixed(1)} px do horário da unidade #${desenhado.i}, cor `
      + `${desenhado.cor}, ${desenhado.devolta} px ao voltar a viver e ${desenhado.total - desenhado.n} `
      + `pixels de HUD deixados de fora da mancha`);
  }

  check(erros.length === 0 && avisos.length === 0,
    `console limpo com a malha ligada (${erros.length} erros, ${avisos.length} avisos)`);
  for (const e of erros.slice(0, 4)) console.log('  ERRO ' + e.slice(0, 160));
  for (const a of avisos.slice(0, 4)) console.log('  AVISO ' + a.slice(0, 160));

  console.log(`\nTransporte no navegador: ${passed} passaram, ${failures.length} falharam`);
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error('FALHOU: ' + e.message); process.exit(1); });
