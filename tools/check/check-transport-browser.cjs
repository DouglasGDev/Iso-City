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
  // O Metro em dev serve cada módulo como chunk com URL fixa (`.../GameCanvas.bundle//&platform=web
  // &dev=true&hot=false&lazy=true...`): depois de mexer no código, a URL não muda e o cache do
  // navegador devolve o chunk velho. A aba passa a rodar gerações misturadas — código novo
  // chamando export que o chunk antigo não conhecia — e uma exceção no meio do quadro corrompe
  // a medição de pixel inteira. Medir o bundle do disco exige cache desligado; num recarregar
  // limpo, 30s de jogo com essa porta a menos não deram nenhuma exceção no console.
  await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  // O `inputState` é um objeto só, compartilhado pelo toque, pelo teclado e pelo gamepad, e no
  // desktop quem ganha é o último a reivindicar: um gamepad que a máquina tem plugada (o Chrome
  // 154 enumera até dongue sem botão pressionado) faz `useHardwareInput` trocar para "gamepad",
  // o App desmonta o ControlTouch e a limpeza dele zera o joystick no meio da janela de medida.
  // O sintoma é um passageiro que desce e para de andar — 0.00 tiles — sem nada ter quebrado no
  // jogo. Este check é de toque, então o gamepad sai de cena antes do primeiro frame.
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: 'Object.defineProperty(navigator, "getGamepads", { configurable: true, value: () => [] });',
  });
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
    // "livre" marca o ônibus que está NO CLARO: com a rua congelada o que se mede é o que mudou
    // na tela, e um ônibus passando por baixo do joystick, atrás de um prédio ou sob a barra de
    // cima tem pixels que não mudam de nada — a mancha vem pela metade e a régua de tamanho chama
    // isso de "não é o sprite". Não é portão, é preferência: se nenhum estiver no claro, a lista
    // inteira continua sendo tentada do mesmo jeito.
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
        found.push({ i, d: Math.hypot(u.x - c.x, u.y - c.y), dir: u.dir, parado: u.stopped, sw, sh,
          livre: ex - sw / 2 > W * 0.28 && ex + sw / 2 < W * 0.80 && ey - sh > H * 0.16 && ey < H * 0.72 });
      }
      return found.sort((a, b) => (a.livre === b.livre ? a.d - b.d : a.livre ? -1 : 1));
    };
    return { nome: qa.parada.name, linhas: qa.parada.lines.length };
  })()`);
  await until('qa.candidatos().length > 0', 'um ônibus da malha chegar ao alcance da câmera', 150000);

  let desenhado = null;
  const tentativas = [];
  for (const c of await evaluate('qa.candidatos().slice(0, 10)')) {
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
    // A mancha do ônibus pode chegar cortada: um carro do trânsito congelado em cima do asfalto
    // dele, um poste, a quina de um prédio. São pixels do mesmo sprite, no mesmo lugar do
    // horário, então o que se soma é o CONJUNTO das manchas cujo centro cai dentro da caixa onde
    // o ônibus deveria estar. Fora da caixa nada é somado — é isso que impede o trânsito de
    // virar ônibus.
    const caixa = { x0: alvo.ex - largura / 2, x1: alvo.ex + largura / 2, y0: alvo.ey - altura, y1: alvo.ey + 4 };
    const dentro = dif.grupos.filter((gr) => gr.n >= 120 && gr.cx >= caixa.x0 && gr.cx <= caixa.x1
      && gr.cy >= caixa.y0 && gr.cy <= caixa.y1);
    if (dentro.length) {
      const n = dentro.reduce((s, gr) => s + gr.n, 0);
      const x0 = Math.min(...dentro.map((gr) => gr.x0));
      const x1 = Math.max(...dentro.map((gr) => gr.x1));
      const y0 = Math.min(...dentro.map((gr) => gr.y0));
      const y1 = Math.max(...dentro.map((gr) => gr.y1));
      melhor = { n, x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1, cor: dentro[0].cor,
        dist: Math.hypot(dentro.reduce((s, gr) => s + gr.cx * gr.n, 0) / n - esperado.x,
          dentro.reduce((s, gr) => s + gr.cy * gr.n, 0) / n - esperado.y),
        cortada: dentro.length };
    } else {
      for (const gr of dif.grupos) {
        if (gr.n < 200) break;
        const d = Math.hypot(gr.cx - esperado.x, gr.cy - esperado.y);
        if (!melhor || d < melhor.dist) melhor = { ...gr, dist: d };
      }
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
    check(true, `ônibus ${desenhado.dir} da malha na tela: ${desenhado.n} pixels em `
      + `${desenhado.cortada || 1} peça(s) dentro da caixa ${desenhado.w}x${desenhado.h} contra a arte `
      + `${desenhado.largura.toFixed(0)}x${desenhado.altura.toFixed(0)} sob zoom, `
      + `centro a ${desenhado.dist.toFixed(1)} px do horário da unidade #${desenhado.i}, cor `
      + `${desenhado.cor}, ${desenhado.devolta} px ao voltar a viver e ${desenhado.total - desenhado.n} `
      + `pixels de HUD deixados de fora da mancha`);
  }

  // 6) O §3b no jogo real. Aqui nada é chamado por dentro do sistema: é o toque no botão da
  // HUD, o corpo que some da tela durante a viagem, o joystick que não empurra passageiro e o
  // corpo que pisa o passeio do destino. Um ônibus desenhado sem porta seria cenário.
  await evaluate('(() => {const mods=[...__r.getModules().values()].filter(m=>m.isInitialized).map(m=>m.publicModule.exports);'
    + 'qa.inp = mods.find(m=>m?.setJoystickInput);})()');
  await evaluate(`(() => {const g = qa.g;
    g.player.busUnit = null; g.player.state = "idle";
    qa.ir(qa.parada.x, qa.parada.y);
    qa.__carros = g.vehicles.length;
    // O vigia da porta: varre a HUD o passeio inteiro e CONTA os ticks em que o botão de descer
    // foi oferecido com o ônibus andando. A HUD lê o "parado" a cada 220 ms, então essa janela de
    // retardo existe e é medida; o que não pode existir é a porta abrir no movimento, e isso é
    // coberto pelo toque deliberado no meio do asfalto, mais abaixo. Uma leitura única no fim do
    // passeio não veria a janela de um frame — por isso o vigia é um intervalo, não uma régua. A
    // régua é a maior sequência seguida (portaPior): o total acumula partida após partida e não
    // diz nada, enquanto a sequência diz por quanto tempo a HUD sustenta a oferta.
    qa.__portaOferecida = 0;
    qa.__portaSequencia = 0;
    qa.__portaPior = 0;
    qa.__vigia = setInterval(() => {
      const a = qa.g.transport.aboard(qa.g.player);
      if (a && !a.stopped && document.querySelector("[data-testid=control-exit]")) {
        qa.__portaOferecida++;
        qa.__portaSequencia++;
        if (qa.__portaSequencia > qa.__portaPior) qa.__portaPior = qa.__portaSequencia;
      } else {
        qa.__portaSequencia = 0;
      }
    }, 60);
  })()`);

  let embarcou = false;
  for (let tentativa = 0; tentativa < 5 && !embarcou; tentativa++) {
    await until('(() => {const g = qa.g; return g.transport.boarding(g.player) !== null'
      + ' && !!document.querySelector("[data-testid=control-enter]");})()',
      'um ônibus encostar na calçada da parada', 180000);
    await tapPoint(await textCenter('EMBARCAR'));
    await delay(140);
    embarcou = await evaluate('qa.g.player.busUnit !== null');
  }
  check(embarcou, `toque em EMBARCAR na calçada da estação ${estação.nome} colocou o jogador no horário`);

  if (embarcou) {
    const bordo = await evaluate(`(() => {const g = qa.g, p = g.player, u = g.transport.aboard(p);
      return { assento: p.busUnit, estado: p.state, carro: p.currentVehicleId,
        linha: g.transport.network.routes[u.route].name, colado: p.x === u.x && p.y === u.y,
        frota: g.vehicles.length - qa.__carros, viva: u.live };})()`);
    check(bordo.estado === 'driving' && bordo.carro === null && bordo.frota === 0 && bordo.colado,
      `a bordo da ${bordo.linha}: assento #${bordo.assento} do horário, sem Vehicle inventado `
      + `(frota ${bordo.frota} +) e colado no asfalto dele`);

    // O passageiro não dirige: o mesmo empurrão de joystick que anda com quem está a pé não
    // move quem vai a bordo — e o controle a pé prova que o empurrão estava vivo.
    // O gravador do dedo é o que sustenta essa segunda metade. O `inputState` é um objeto só,
    // dividido com teclado e gamepad, e no desktop quem manda é o último a reivindicar: um gamepad
    // que a máquina tem plugado faz o App desmontar a camada de toque, a limpeza dela zera o
    // joystick no meio da janela, e o teste leria "a bordo não andou, a pé também não" — uma falha
    // do jogo que não existe. Cada janela de empurrão guarda a magnitude da entrada e quantos
    // controles havia na tela: dedo vivo e camada parada são a condição para a medição do corpo
    // valer. A janela é marcada a cada empurrão, não antes: entre o assento ser solto e a HUD
    // trocar o painel há um ciclo de leitura dela, e contar esse troca como se fosse o dedo.
    await evaluate('(() => {qa.__dedo = {};'
      + 'qa.__marca = (nome) => {clearInterval(qa.__dedost); qa.__dedo[nome] = [];'
      + 'qa.__dedost = setInterval(() => {const s = qa.inp.inputState;'
      + 'qa.__dedo[nome].push([+s.magnitude.toFixed(2),'
      + ' document.querySelectorAll("[data-testid^=control-]").length]);}, 120);};})()');
    const antesDeEmpurrar = await evaluate('qa.g.time');
    await evaluate('(() => {qa.__marca("aBordo"); qa.inp.setJoystickInput(1, 0, 1);})()');
    await delay(900);
    const empurrado = await evaluate(`(() => {const g = qa.g, p = g.player, u = g.transport.aboard(p);
      return { colado: p.x === u.x && p.y === u.y, velocidade: +p.speed.toFixed(3),
        vx: +p.vx.toFixed(3), vy: +p.vy.toFixed(3) };})()`);
    await evaluate('qa.inp.setJoystickInput(0, 0, 0)');
    await evaluate(`(() => {const p = qa.g.player; qa.__assento = p.busUnit;
      p.busUnit = null; p.state = "idle";
      // A saída é bruta de propósito — o assento volta logo abaixo para a viagem continuar —, mas
      // sem o aviso a HUD seguiria oferecendo a porta do ônibus a quem já está a pé.
      qa.g.notifyEntityChange();
      qa.__pe = { x: p.x, y: p.y };})()`);
    await delay(400);
    await evaluate('(() => {qa.__marca("ape"); qa.inp.setJoystickInput(1, 0, 1);})()');
    await delay(900);
    const aPé = await evaluate('Math.hypot(qa.g.player.x - qa.__pe.x, qa.g.player.y - qa.__pe.y)');
    const dedo = await evaluate('(() => {clearInterval(qa.__dedost); return qa.__dedo;})()');
    await evaluate('(() => {const g = qa.g, p = g.player; qa.inp.setJoystickInput(0, 0, 0);'
      + 'p.busUnit = qa.__assento; p.state = "driving"; g.notifyEntityChange();})()');
    const pisa = (janela) => janela.filter((a) => a[0] > 0.5).length;
    const camadas = (janela) => [...new Set(janela.map((a) => a[1]))].sort((a, b) => a - b).join('→');
    const bordoVivo = pisa(dedo.aBordo);
    const peVivo = pisa(dedo.ape);
    // A régua é o magnitude, não a contagem de controles. Ela só acompanha: a pé são oito ou
    // nove (o nono é o botão de contexto que nasce quando o corpo passa perto de algo), a bordo
    // é a porta, e com o ônibus andando o painel do passageiro não tem NENHUM botão — o zero aí é
    // o projeto da HUD, não o dedo morto. O que não pode acontecer é as janelas não terem
    // empurrão: sem elas, "a bordo o corpo não anda" vale também para um teste que não apertou
    // nada, e é isso que um gamepad plugado na máquina provoca quando derruba a camada de toque.
    check(bordoVivo >= 3 && peVivo >= 3,
      `o empurrão esteve vivo nas duas janelas: ${bordoVivo} amostras a bordo e ${peVivo} a pé com o `
      + `joystick no fim do curso (botões na tela: ${camadas(dedo.aBordo)} a bordo, `
      + `${camadas(dedo.ape)} a pé)`);
    // A régua do tempo é o `game.time` do próprio jogo, não o relógio do teste: dois segundos
    // de espera no lado de fora não valem nada se a rua parou de rodar por dentro.
    const puxada = await evaluate('qa.g.time') - antesDeEmpurrar;
    check(empurrado.colado && empurrado.velocidade === 0 && aPé > 0.3,
      `joystick empurrado a bordo não move o corpo (${JSON.stringify(empurrado)}) — e a pé, no mesmo `
      + `tempo, ele andou ${aPé.toFixed(2)} tiles com ${peVivo} amostras do dedo no ar`);
    check(puxada > 0.5, `a rua continuou rodando durante o teste do passageiro (${puxada.toFixed(2)} s de relógio do jogo)`);

    // O corpo some da tela: com o assento posto o jogador não é desenhado, e a diferença entre
    // um quadro a pé e outro a bordo é exatamente o boneco, no ponto onde a câmera o projeta.
    await evaluate('(() => {qa.__rua = qa.g.update; qa.g.update = () => {};})()');
    await delay(1300);
    const projected = await evaluate(`(() => {const g = qa.g, c = g.camera, p = g.player;
      const px = (c.x - c.y) * 64, py = (c.x + c.y) * 32 - c.h * 64;
      const sx = (p.x - p.y) * 64, sy = (p.x + p.y) * 32 - g.map.heightSmoothAt(p.x, p.y) * 64;
      return { x: window.innerWidth / 2 + c.zoom * (sx - px),
        y: window.innerHeight / 2 + c.zoom * (sy - py) };})()`);
    const aBordoFrame = await screenshot('qa-passageiro-a-bordo');
    await evaluate('(() => {const p = qa.g.player; p.busUnit = null; p.state = "idle";})()');
    await delay(700);
    const aPeFrame = await screenshot('qa-passageiro-a-pe');
    await evaluate('(() => {const p = qa.g.player; p.busUnit = qa.__assento; p.state = "driving";})()');
    await delay(700);
    const deNovo = await screenshot('qa-passageiro-a-bordo-de-novo');
    await evaluate('(() => {qa.g.update = qa.__rua; delete qa.__rua;})()');
    const corpo = manchas(aPeFrame, aBordoFrame);
    let osso = null;
    for (const gr of corpo.grupos) {
      if (gr.n < 120) break;
      const d = Math.hypot(gr.cx - projected.x, gr.cy - (projected.y - gr.h / 2));
      if (!osso || d < osso.dist) osso = { ...gr, dist: d };
    }
    const devolta = osso
      ? naCaixa(aBordoFrame, deNovo, osso.x0 - 2, osso.y0 - 2, osso.x1 + 2, osso.y1 + 2) : 1e9;
    // A caixa do boneco não é uma régua: a mancha leva a sombra de contato, o passo da animação
    // e o que quer que a HUD tenha por cima do pé. O que cobra o desaparecimento é o tamanho da
    // mancha, a distância até o ponto onde a câmera projeta o corpo e o quadro voltar idêntico.
    check(!!osso && osso.dist <= 70 && devolta <= Math.max(60, osso.n * 0.05),
      `quem vai a bordo sai da tela: o corpo é a mancha de ${osso ? osso.n : 0} pixels a `
      + `${osso ? osso.dist.toFixed(0) : '-'} px do pé projetado, ${osso ? osso.w : 0}x${osso ? osso.h : 0}, `
      + `e o quadro volta idêntico ao embarcar de novo (${devolta} px de diferença)`);

    // A viagem é de verdade: o corpo anda pelo asfalto, a câmera vai junto e a linha não sai
    // do próprio alcance.
    await evaluate('(() => {const p = qa.g.player; qa.__partida = { x: p.x, y: p.y };})()');
    await delay(7000);
    const andou = await evaluate(`(() => {const g = qa.g, p = g.player, u = g.transport.aboard(p);
      return { tiles: +Math.hypot(p.x - qa.__partida.x, p.y - qa.__partida.y).toFixed(1),
        colado: p.x === u.x && p.y === u.y, camera: +Math.hypot(g.camera.x - p.x, g.camera.y - p.y).toFixed(2),
        viva: u.live, estado: p.state };})()`);
    check(andou.tiles > 4 && andou.colado && andou.camera < 2.5 && andou.viva && andou.estado === 'driving',
      `a viagem levou o corpo por ${andou.tiles} tiles de asfalto em 7s, colada no horário, com a `
      + `câmera a ${andou.camera} tiles e a linha ainda materializada`);

    // A porta no meio do asfalto: a mesma fila de entrada que o botão da HUD empurra
    // (`queueEnter` é o que `ControlTouch` chama no toque), lida aqui com o ônibus andando. O
    // corpo não pode cair na rua — desembarcar em movimento seria um teleporte disfarçado, e é
    // exatamente isso que a rede de transporte proíbe.
    await until('(() => {const a = qa.g.transport.aboard(qa.g.player); return !!a && !a.stopped;})()',
      'o ônibus voltar a andar depois da parada', 90000);
    const andando = await evaluate(`(() => {const g = qa.g, u = g.transport.aboard(g.player);
      return { assento: g.player.busUnit, parado: u.stopped };})()`);
    await evaluate('qa.inp.queueEnter()');
    await delay(320);
    const trancada = await evaluate(`(() => {const g = qa.g, p = g.player, u = g.transport.aboard(p);
      return { assento: p.busUnit, estado: p.state, colado: !!u && p.x === u.x && p.y === u.y };})()`);
    check(!andando.parado && trancada.assento === andando.assento && trancada.estado === 'driving' && trancada.colado,
      `entrada apertada no meio do asfalto não abriu a porta (${JSON.stringify(andando)} -> `
      + `${JSON.stringify(trancada)})`);

    // Descer é o mesmo caminho de volta: a calçada, o botão, o passeio. A calçada da descida é
    // capturada no instante de cada toque, com o ônibus parado e o botão na tela: entre o toque
    // e o corpo pisar o asfalto o ônibus retoma a viagem, e aí a parada seguinte já é outra.
    // Cada tentativa registra a porta inteira no instante do toque e duzentos milissegundos
    // depois — parado, botão, fila de entrada e trava de saída — porque se a descida não
    // acontecer a linha do log tem que dizer qual dos quatro não estava aceso. O `until` pede a
    // porta parada e o botão juntos três vezes seguidas (240 ms): o botão da HUD é lido a cada
    // 220 ms e pode sobreviver um piscar ao ônibus que já partiu, e tocar nessa janela não
    // abriria nada por design.
    await evaluate('(() => {qa.porta = () => {const g = qa.g, p = g.player, u = g.transport.aboard(p);'
      + 'return { parado: !!u && u.stopped, assento: p.busUnit, lock: +(g.exitLock || 0).toFixed(2),'
      + ' botao: !!document.querySelector("[data-testid=control-exit]"),'
      + ' fila: !!qa.inp.inputState.enterQueued, tempo: +g.time.toFixed(2) };};})()');
    const descidas = [];
    let descida = null, passeio = null;
    for (let tentativa = 0; tentativa < 5 && !passeio; tentativa++) {
      await until('(() => {const g = qa.g, a = g.transport.aboard(g.player);'
        + 'if (!a || !a.stopped || !document.querySelector("[data-testid=control-exit]")) { qa.__vista = 0; return false; }'
        + 'qa.__vista = (qa.__vista || 0) + 1; return qa.__vista >= 3;})()',
        'o ônibus encostar numa calçada para o corpo descer', 180000);
      descida = await evaluate(`(() => {const g = qa.g, u = g.transport.aboard(g.player);
        const s = g.transport.network.stations[g.transport.network.routes[u.route].stops[u.stop].station];
        return { nome: s.name, x: s.x, y: s.y };})()`);
      const antes = await evaluate('qa.porta()');
      await tapPoint(await textCenter('DESEMBARCAR'));
      const depois = await evaluate('qa.porta()');
      await delay(200);
      const aberta = await evaluate('qa.porta()');
      descidas.push({ parada: descida.nome, antes, depois, aberta });
      passeio = await evaluate('(() => {const p = qa.g.player; if (p.busUnit !== null) return null;'
        + `return { estado: p.state, doPasseio: +Math.hypot(p.x - ${descida.x}, p.y - ${descida.y}).toFixed(2) };})()`);
    }
    await evaluate('(() => {clearInterval(qa.__vigia); delete qa.__vigia;})()');
    const oferida = await evaluate('({ ticks: qa.__portaOferecida, pior: qa.__portaPior })');
    const registro = JSON.stringify(descidas);
    check(!!passeio, `o toque em DESEMBARCAR num ônibus parado abriu a porta na calçada de `
      + `${descida ? descida.nome : 'nenhuma'} (${registro})`);
    if (passeio) {
      check(passeio.estado === 'idle' && passeio.doPasseio <= 1.5,
        `desembarque na calçada de ${descida.nome}: corpo a ${passeio.doPasseio} tiles do passeio da parada, `
        + `estado "${passeio.estado}", assento livre`);
      check(descida.nome !== estação.nome, `a viagem mudou de bairro: embarcou em ${estação.nome}, desceu em ${descida.nome}`);
    }
    // A janela é o atraso do `setInterval(update, 220)` da HUD, não uma porta malandra: o botão
    // pode sobreviver um piscar ao ônibus que já partiu, e o que ele entrega quando apertado é a
    // portinhola trancada (coberto logo acima), nunca um corpo largado no asfalto em movimento.
    check(oferida.pior * 60 <= 400, `a HUD sustenta o botão de descer no máximo ${oferida.pior * 60} ms com o `
      + `ônibus andando (${oferida.ticks} ticks no passeio inteiro, contra os 220 ms de leitura da HUD) — `
      + `e apertar nessa janela fecha a porta, não abre`);
  }

  check(erros.length === 0 && avisos.length === 0,
    `console limpo com a malha ligada (${erros.length} erros, ${avisos.length} avisos)`);
  for (const e of erros.slice(0, 4)) console.log('  ERRO ' + e.slice(0, 160));
  for (const a of avisos.slice(0, 4)) console.log('  AVISO ' + a.slice(0, 160));

  console.log(`\nTransporte no navegador: ${passed} passaram, ${failures.length} falharam`);
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error('FALHOU: ' + e.message); process.exit(1); });
