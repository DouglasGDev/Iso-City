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
async function until(expr, label, timeout = 180000, aoEsgotar) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await evaluate(expr)) return; await delay(80); }
  let rastro = '';
  if (aoEsgotar) {
    try { rastro = ' — ' + await aoEsgotar(); } catch { rastro = ' — (o rastro não foi lido)'; }
  }
  throw new Error(`tempo esgotado: ${label}${rastro}`);
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
  // As bordas vêm da projeção da câmera, que é decimal, e o índice do pixel é inteiro. Sem
  // arredondar, `(largura * y + x) << 2` trunca o índice fracionário e a varredura anda numa
  // faixa diagonal em vez de percorrer a caixa: a régua lia 0 px numa camada que estava mudando
  // de verdade (942 pixels de seta provados pela contagem de cor, que arredonda).
  const iy0 = Math.max(0, Math.floor(y0)), iy1 = Math.min(a.height - 1, Math.ceil(y1));
  const ix0 = Math.max(0, Math.floor(x0)), ix1 = Math.min(a.width - 1, Math.ceil(x1));
  for (let y = iy0; y <= iy1; y++) {
    for (let x = ix0; x <= ix1; x++) {
      const k = (a.width * y + x) << 2;
      if (Math.abs(a.data[k] - b.data[k]) + Math.abs(a.data[k + 1] - b.data[k + 1])
        + Math.abs(a.data[k + 2] - b.data[k + 2]) > 24) n++;
    }
  }
  return n;
}
/**
 * Pixels da cor de aviso dentro de uma caixa. A diferença entre dois quadros diz que ALGO sumiu
 * daquele lugar; a cor diz que o que sumiu foi a tinta amarela — a placa do marco, as lâmpadas
 * da linha, o corpo da seta — e não a sombra de um quadro que se regravou sozinho. O corte é
 * amplo de propósito: #f2c14e, #ffc861 e #ffe14a passam, o cinza do passeio e o âmbar lavado da
 * marquise (que é a mesma cor misturada a 60% com o chão) ficam fora.
 */
function amareloEm(png, c) {
  let n = 0;
  const y0 = Math.max(0, Math.floor(c.y0)), y1 = Math.min(png.height - 1, Math.ceil(c.y1));
  const x0 = Math.max(0, Math.floor(c.x0)), x1 = Math.min(png.width - 1, Math.ceil(c.x1));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const k = (png.width * y + x) << 2;
      const r = png.data[k], g = png.data[k + 1], b = png.data[k + 2];
      if (r >= 205 && g >= 165 && b <= 150 && r - b >= 55 && g - b >= 40) n++;
    }
  }
  return n;
}
function rgbDe(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex || ''));
  if (!m) throw new Error('cor de viação que não é hex: ' + hex);
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
}
/**
 * Pixels da tinta de uma viação dentro de uma caixa. A diferença de quadros diz que ALGO mudou
 * de lugar; a cor diz que o que mudou é a polilinha da linha, pintada na cor da empresa, e não
 * um botão de HUD que resolveu respirar. A tolerância é a soma dos três canais, larga de
 * propósito: o traço vem antialiasado sobre o asfalto assado do mapa, então o pixel do miolo é
 * a tinta pura e a borda é tinta + chão.
 */
function tintaEm(png, c, rgb, tol = 110) {
  let n = 0;
  const y0 = Math.max(0, Math.floor(c.y0)), y1 = Math.min(png.height - 1, Math.ceil(c.y1));
  const x0 = Math.max(0, Math.floor(c.x0)), x1 = Math.min(png.width - 1, Math.ceil(c.x1));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const k = (png.width * y + x) << 2;
      if (Math.abs(png.data[k] - rgb[0]) + Math.abs(png.data[k + 1] - rgb[1])
        + Math.abs(png.data[k + 2] - rgb[2]) <= tol) n++;
    }
  }
  return n;
}
/** O retângulo de um elemento da tela, em pixels do quadro (deviceScaleFactor é 1 no harness). */
async function rectDe(testId) {
  return evaluate(`(() => {const el = document.querySelector('[data-testid=${testId}]');
    if (!el) throw new Error('faltando o elemento ${testId}');
    const r = el.getBoundingClientRect();
    return { x0: r.x, y0: r.y, x1: r.x + r.width, y1: r.y + r.height, w: r.width, h: r.height };})()`);
}

(async () => {
  const tabs = await (await fetch(`http://127.0.0.1:${Number(process.env.QA_CDP_PORT || 9223)}/json/list`)).json();
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
  await require('./bundle-identity.cjs').attach(socket, send);
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
  // `access` entrou na lista porque é a faixa do pátio: a linha da rodoviária roda sobre a
  // aresta de acesso das baias, que é rank legítimo do mapa (`RoadRank`) e não um desvio.
  check(rede.servicos.length === 1 && rede.servicos[0] === 'bus'
    && rede.ranks.join() === 'access,avenue,highway,residential,street',
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

  // 5b) O §3d no asfalto vivo: a volta corre na faixa contrária, o ônibus encosta fora do
  // cruzamento e o trânsito tem corpo para frear atrás dele. Medido na rua em movimento, com o
  // relógio do jogo correndo e a câmera na estação mais movimentada — a malha isolada do
  // `check-transport` já cobra a geometria; aqui o que se vê é o mundo rodando.
  // O corpo fica na calçada do ponto de propósito, mas isso pesa na contagem: desde que o
  // ônibus segura para quem está no ponto (#195), um veículo a mais fica parado nesta mesma
  // estação enquanto a amostra roda, e a fatia "andando" encolhe. O piso de leituras andando é
  // o que dá valor à prova de contramão, então é a JANELA que cresce, nunca o piso.
  //
  // A janela cresceu de novo com a frota cortada: menos ônibus por linha e headway de papel
  // significam menos lataria em marcha nesta estação, e 70 quadros de amostra já não passavam
  // do piso. O piso é o mesmo; é o tempo de rua que paga a conta.
  await evaluate('qa.ir(qa.parada.x, qa.parada.y)');
  const asfalto = { anda: 0, para: 0, contra: 0, caixa: 0, zebra: 0, espelho: 0, vivos: 0,
    campos: {}, mínima: Infinity };
  for (let round = 0; round < 160; round++) {
    // O espelho é a palavra do sistema: o corpo que o trânsito freia tem de ser o corpo que o
    // horário escreve, tile, ângulo, sentido e vida. A velocidade tem duas caras e o contrato é
    // o do freio — um ônibus que dosou a marcha para caber no buraco de um cruzamento diz ao
    // trânsito a marcha DOSADA, porque um corpo que anuncia cruzeiro e anda a meia marcha é um
    // carro que freia atrás dele na folga errada. Quem está segurado de verdade diz zero. Um nome
    // de campo por divergência, senão o número diz que algo divergiu e não diz o quê.
    const lida = await evaluate('(() => {const g = qa.g, t = g.transport, m = g.map;'
      + 'const out = { anda: 0, para: 0, contra: 0, caixa: 0, zebra: 0, espelho: 0, vivos: 0,'
      + " campos: {}, mínima: Infinity };"
      + 'const vivas = [];'
      + 'for (let i = 0; i < t.units.length; i++) {'
      + '  const u = t.units[i]; const b = t.bodies[i];'
      + '  const velocidade = t.network.services[t.network.routes[u.route].service].speed;'
      + "  const campo = !b ? 'corpo' : b.x !== u.x ? 'x' : b.y !== u.y ? 'y'"
      + "    : b.angle !== u.angle ? 'ângulo' : b.dir !== u.dir ? 'sentido'"
      + "    : b.live !== u.live ? 'vida'"
      + "    : b.speed !== ((u.held || u.stopped) ? 0 : velocidade * t.marchaAnunciada(i)) ? 'velocidade' : '';"
      + '  if (campo) { out.espelho++; out.campos[campo] = (out.campos[campo] || 0) + 1; }'
      + '  if (!u.live) continue;'
      + '  out.vivos++; vivas.push(u);'
      + '  if (u.stopped) { out.para++;'
      + '    if (m.isIntersectionAt(u.x, u.y)) out.caixa++;'
      + '    if (m.isCrosswalkAt(u.x, u.y)) out.zebra++;'
      + '  } else { out.anda++;'
      + '    const faixa = m.laneAt(u.x, u.y);'
      + '    if (faixa && faixa !== u.dir) out.contra++;'
      + '  }'
      + '}'
      + 'for (let i = 0; i < vivas.length; i++) for (let j = i + 1; j < vivas.length; j++) {'
      + '  const d = Math.hypot(vivas[i].x - vivas[j].x, vivas[i].y - vivas[j].y);'
      + '  if (d < out.mínima) out.mínima = d; }'
      + 'return out;})()');
    asfalto.anda += lida.anda; asfalto.para += lida.para; asfalto.contra += lida.contra;
    asfalto.caixa += lida.caixa; asfalto.zebra += lida.zebra; asfalto.espelho += lida.espelho;
    asfalto.vivos += lida.vivos;
    for (const [campo, n] of Object.entries(lida.campos)) {
      asfalto.campos[campo] = (asfalto.campos[campo] || 0) + n;
    }
    if (lida.mínima < asfalto.mínima) asfalto.mínima = lida.mínima;
    await delay(500);
  }
  check(asfalto.anda > 200 && asfalto.para > 0 && asfalto.contra === 0,
    `nenhum ônibus na contramão: ${asfalto.anda} leituras andando sobre faixa sinalizada, todas com a `
    + `seta do asfalto a favor, e ${asfalto.para} leituras paradas`);
  check(asfalto.caixa === 0 && asfalto.zebra === 0,
    `nenhum ônibus encosta num cruzamento: ${asfalto.caixa} leitura(s) na caixa do semáforo e `
    + `${asfalto.zebra} na faixa de pedestre, de ${asfalto.para} paradas`);
  check(asfalto.espelho === 0, `cada ônibus do horário tem corpo na rua: ${asfalto.espelho} divergência(s) `
    + `entre a unidade e o corpo que o trânsito vê (${JSON.stringify(asfalto.campos)}), `
    + `em ${asfalto.vivos} leituras vivas`);
  console.log(`  rua viva: ${asfalto.anda} leituras andando · ${asfalto.para} paradas · `
    + `dois ônibus nunca mais perto que ${(isFinite(asfalto.mínima) ? asfalto.mínima : 0).toFixed(2)} tiles`);

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
    // A régua da espera: a cada amostra que falha, esta linha pergunta ao SISTEMA de quem é o pé
    // do ônibus embarcado — se ele está parado no horário, colado em lataria, dosado pela frota,
    // dentro da linha de parada ou segurado por um corpo da rua. Sem isto, "o ônibus não encosta
    // numa calçada" não diz se a lataria está presa, se está andando devagar ou se a janela de
    // descida é que é curta. Os nomes dos métodos têm acento e são resolvidos por sufixo no
    // protótipo: Caractere digitado em sonda é fonte de nome quebrado chamando o método errado.
    await evaluate('(() => {const t = qa.g.transport;'
      + 'const nomes = Object.getOwnPropertyNames(Object.getPrototypeOf(t));'
      + 'const por = (p, s) => nomes.find((n) => n.startsWith(p) && n.indexOf(s) >= 0);'
      + 'const L = por("aperto", "Frente"), R = por("aperto", "DaRua"), T = por("aperto", "Travessia"), A = por("abra", "");'
      + 'qa.__muro = (corpo) => {const g = qa.g, cos = Math.cos(corpo.angle), sin = Math.sin(corpo.angle);'
      + ' const viu = [];'
      + ' const olha = (x, y, nome, sp, st) => {'
      + ' const dx = x - corpo.x, dy = y - corpo.y;'
      + ' const f = dx * cos + dy * sin, l = Math.abs(-dx * sin + dy * cos);'
      + ' if (f < -0.4 || f > 3 || l > 1) return;'
      + ' viu.push({ f, txt: nome + " a " + f.toFixed(2) + " de frente, " + l.toFixed(2)'
      + ' + " de lado, v " + sp.toFixed(2) + " " + st });};'
      + ' for (const v of g.vehicles) olha(v.x, v.y, "carro#" + v.id + "(" + (v.def ? v.def.id : "?") + ")",'
      + ' v.speed, v.state + (v.occupied ? " ocupado" : ""));'
      + ' for (const n of g.npcs) { if (n.dead || n.inVehicle) continue;'
      + ' if (g.map.tileKindAt(n.x, n.y) !== "road") continue;'
      + ' olha(n.x, n.y, "pessoa#" + n.id, n.speed, n.kind + " " + n.state);}'
      + ' const p = g.player; if (!g.interiors.active && p.health > 0 && p.busUnit === null)'
      + ' olha(p.x, p.y, "jogador", p.speed, "a pe");'
      + ' viu.sort((a, b) => a.f - b.f);'
      + ' return viu.slice(0, 3).map((c) => c.txt).join(" | ") || "asfalto vazio na frente";};'
      // Quem segura o pé do ônibus quando a rua está livre é lataria da própria malha, e o
      // `__muro` não a enxerga: ela não está na grade da rua, está no `bodies` do sistema. Esta
      // é a mesma varredura, no `bodies`, com o motivo do vizinho escrito dentro (um nível só,
      // senão a linha do log vira uma tese).
      + 'qa.__fila = (i, corpo, fundo) => {const b = t.bodies, cos = Math.cos(corpo.angle),'
      + ' sin = Math.sin(corpo.angle); const viu = [];'
      + ' for (let j = 0; j < b.length; j++) { if (j === i) continue; const o = b[j];'
      + ' if (!o.live) continue;'
      + ' const dx = o.x - corpo.x, dy = o.y - corpo.y;'
      + ' const f = dx * cos + dy * sin, l = Math.abs(-dx * sin + dy * cos);'
      + ' if (f < -0.4 || f > 4 || l > 1) continue;'
      + ' const u = t.units[j];'
      + ' const por = fundo ? "" : " [ele: rua " + t[R](j, o).aperto.toFixed(2) + " trav '
      + ' " + t[T](j, o).toFixed(2) + " frota " + t[L](j, o).aperto.toFixed(2) + " abraco '
      + ' " + t[A](j, o).toFixed(2) + " plantado " + (u.plantado ? "sim" : "nao")'
      + ' + " | " + qa.__muro(o) + " | " + qa.__fila(j, o, true) + "]";'
      + ' viu.push({ f, txt: "onibus#" + j + " linha " + u.route + " " + (u.stopped'
      + ' ? (u.parked ? "descansando no berco" : "parado no ponto") : "andando v " + o.speed.toFixed(2))'
      + ' + " a " + f.toFixed(2) + " de frente, " + l.toFixed(2) + " de lado, atraso "'
      + ' + u.atraso.toFixed(1) + por }); }'
      + ' viu.sort((a, c) => a.f - c.f);'
      + ' return viu.slice(0, 2).map((c) => c.txt).join(" | ") || "nenhum vizinho de malha";};'
      + 'qa.__peia = (i) => {const u = t.units[i], corpo = t.bodies[i];'
      + ' if (!u || !corpo || !corpo.live) return "fora de cena";'
      + ' if (u.stopped) return "no horario parado";'
      + ' const f = t[L](i, corpo), r = t[R](i, corpo), ab = t[A](i, corpo);'
      + ' const df = f.aperto > 0 ? f.aperto : t[T](i, corpo);'
      + ' const ap = Math.max(df, r.aperto), falta = Math.max(f.deficit, ab, r.deficit);'
      + ' const porque = falta > 0 ? (ab >= f.deficit && ab >= r.deficit ? "abraco" : "latarias coladas")'
      + ' : ap >= 1 ? "DENTRO DA LINHA" : r.aperto > 0 && r.aperto >= df ? "aperto da RUA"'
      + ' : df > 0 ? "dosado pela frota" : "livre";'
      + ' const muro = (r.aperto > 0 || r.deficit > 0) ? " | na frente: " + qa.__muro(corpo) : "";'
      + ' const frota = !muro && df > 0 ? " | na minha faixa: " + qa.__fila(i, corpo, false) : "";'
      + ' return porque + " | aperto " + ap.toFixed(2) + " rua " + r.aperto.toFixed(2)'
      + ' + " frente " + f.aperto.toFixed(2) + " abraço " + ab.toFixed(2) + " falta " + falta.toFixed(2)'
      + ' + " | dose " + t.marchaAnunciada(i).toFixed(2) + " v " + corpo.speed.toFixed(2)'
      + ' + " atraso " + u.atraso.toFixed(1) + "/" + t.network.routes[u.route].cycle.toFixed(0)'
      + ' + " plantado " + (u.plantado ? "sim" : "nao") + muro + frota;};'
      + 'qa.__plog = [];})()');
    const descidas = [];
    let descida = null, passeio = null;
    for (let tentativa = 0; tentativa < 5 && !passeio; tentativa++) {
      await until('(() => {const g = qa.g, a = g.transport.aboard(g.player);'
        + 'if (!a || !a.stopped || !document.querySelector("[data-testid=control-exit]")) {'
        + ' qa.__vista = 0;'
        + ' if (((qa.__pn = (qa.__pn || 0) + 1) % 50) === 0)'
        + ' qa.__plog.push(g.time.toFixed(1) + "\'s #" + g.player.busUnit + "\' " + qa.__peia(g.player.busUnit));'
        + ' return false; }'
        + 'qa.__vista = (qa.__vista || 0) + 1; return qa.__vista >= 3;})()',
        'o ônibus encostar numa calçada para o corpo descer', 180000,
        () => evaluate('qa.__plog.slice(-16).join(" ~ ") || "nenhuma amostra"'));
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

  // 6b) O embarque humano no jogo real. A zona de embarque é o passeio contínuo daquele ponto
  // (`TransportStation.ponto`), medida a pé desde o marco, e o ônibus que encosta num ponto onde
  // alguém espera SEGURA o relógio: sem isto a porta é uma janela de `dwell` = 2 s, que é o tempo
  // de um cobrador, não o de um jogador que viu a lataria encostar e foi até ela. Nada aqui chama
  // o sistema por dentro: o corpo é posto no canto da marquise, o relógio do jogo roda, e o que
  // se mede é o que um passageiro vê — quantos segundos UM MESMO ônibus fica parado naquela
  // calçada, e se o botão da HUD existe lá.
  const humano = await evaluate(`(() => {const g = qa.g;
    if (g.interiors.active) g.interiors.leave(g.player);
    g.player.busUnit = null; g.player.state = 'idle'; g.player.currentVehicleId = null;
    g.player.swimming = false; g.player.health = 100; g.player.wantedLevel = 0;
    g.player.invulnUntil = Infinity; g.weather.force('clear', 3600);
    g.notifyEntityChange();
    // A calçada com mais linhas: onde a fila encosta e o embarque é disputado.
    const s = g.transport.network.stations.filter((q) => q.lines.length >= 2)
      .sort((a, b) => b.lines.length - a.lines.length || a.id - b.id)[0];
    // O tile MAIS LONGE do marco dentro da zona pintada — o canto da marquise, onde a régua em
    // linha reta de antes deixava o jogador batendo num ônibus parado a quatro tiles dele.
    const canto = s.ponto.slice().sort((a, b) => Math.hypot(b.x - s.x, b.y - s.y)
      - Math.hypot(a.x - s.x, a.y - s.y))[0];
    qa.__p = { est: s.id, nome: s.name, linhas: s.lines.length, zona: s.ponto.length,
      x: canto.x, y: canto.y, doMarco: +Math.hypot(canto.x - s.x, canto.y - s.y).toFixed(2) };
    qa.ir(canto.x, canto.y);
    qa.__espera = { parado: 0, maiorParada: 0, picoEspera: 0, encostados: 0, portas: 0,
      leituras: 0, longe: 0, ônibus: -1 };
    qa.__último = -1;
    qa.__vigia2 = setInterval(() => {
      const t = qa.g.transport, p = qa.__espera;
      let aqui = null, indice = -1;
      for (let i = 0; i < t.units.length; i++) {
        const u = t.units[i];
        if (!u.live || !u.stopped || u.stop < 0) continue;
        const stops = t.network.routes[u.route].stops;
        if (stops[u.stop] && stops[u.stop].station === qa.__p.est) { aqui = u; indice = i; break; }
      }
      p.leituras++;
      if (aqui) {
        p.encostados++;
        if (aqui.embarque > p.picoEspera) p.picoEspera = +aqui.embarque.toFixed(2);
        p.longe = Math.max(p.longe, +Math.hypot(qa.g.player.x - aqui.x, qa.g.player.y - aqui.y).toFixed(2));
        if (t.boarding(qa.g.player) !== null) p.portas++;
      }
      // A sequência de UM MESMO veículo encostado: sem passageiro no ponto ela é exatamente o
      // dwell do horário, e é isso que torna a régua de baixo uma prova e não uma impressão.
      p.parado = indice >= 0 && indice === qa.__último ? p.parado + 0.1 : indice >= 0 ? 0.1 : 0;
      if (p.parado > p.maiorParada) { p.maiorParada = +p.parado.toFixed(2); p.ônibus = indice; }
      qa.__último = indice;
    }, 100);
    return qa.__p;})()`);
  await delay(46000);
  const vigia = await evaluate('(() => {clearInterval(qa.__vigia2); return qa.__espera;})()');
  const dwell = await evaluate('qa.g.transport.network.services[0].dwell');
  check(humano.zona >= 3 && humano.doMarco > 0,
    `o ponto "${humano.nome}" tem zona de embarque: ${humano.zona} tiles de passeio contínuo, `
    + `o canto mais longe a ${humano.doMarco} tiles do marco`);
  check(vigia.encostados > 0 && vigia.portas > 0,
    `com o corpo no canto da marquise a porta foi oferecida: ${vigia.portas} de ${vigia.encostados} `
    + `leituras com um ônibus da calçada #${humano.est} encostado (ônibus mais longe a ${vigia.longe} tiles)`);
  check(vigia.maiorParada >= dwell + 1.2,
    `o ônibus espera quem está no ponto: ${humano.nome} segurou um veículo parado `
    + `${vigia.maiorParada.toFixed(1)}s na calçada, contra os ${dwell}s do horário`);
  check(vigia.picoEspera <= 8.2,
    `a espera tem teto: nenhum veículo passou de ${vigia.picoEspera.toFixed(2)}s de parada extra `
    + `(o orçamento é 8s por encosto)`);
  check(vigia.maiorParada <= dwell + 8 + 2,
    `e o ônibus vai embora mesmo com o jogador colado no ponto: ${vigia.maiorParada.toFixed(1)}s de `
    + `porta aberta é o dwell mais o orçamento de 8s, não um estacionamento`);

  // End-to-end do reclamo: do canto da marquise, toque no botão da HUD. É a única prova que
  // interessa para "não está dando pra mim entrar".
  let entrou = false;
  for (let tentativa = 0; tentativa < 6 && !entrou; tentativa++) {
    await until('(() => {const g = qa.g; return g.transport.boarding(g.player) !== null'
      + ' && !!document.querySelector("[data-testid=control-enter]");})()',
      `a porta abrir no canto da marquise de ${humano.nome}`, 120000);
    await tapPoint(await textCenter('EMBARCAR'));
    await delay(160);
    entrou = await evaluate('qa.g.player.busUnit !== null');
  }
  const embarcado = await evaluate('(() => {const g = qa.g, i = g.player.busUnit;'
    + 'if (i === null) return null; const u = g.transport.units[i];'
    + 'return { linha: g.transport.network.routes[u.route].name, assento: i, espera: +u.embarque.toFixed(2) };})()');
  check(entrou, `no canto da marquise de ${humano.nome} o toque em EMBARCAR colocou o corpo na `
    + `${embarcado ? embarcado.linha : 'nenhuma linha'} (assento #${embarcado ? embarcado.assento : '-'}); `
    + `zona ${humano.zona} tiles, canto a ${humano.doMarco} tiles do marco`);
  await evaluate('(() => {const g = qa.g; g.player.busUnit = null; g.player.state = "idle";'
    + 'g.notifyEntityChange();})()');

  // 7) O §3c no jogo real: a rodoviária é prédio com porta, o telão é tela de verdade e
  // escolher um destino entrega um plano que se cumpre a pé — nunca um corpo que muda de
  // endereço sozinho. Aqui o toque é no painel React, a viagem é no asfalto, e a régua final
  // é o corpo no passeio do destino com o plano encerrado e o pino do GPS recolhido.
  await evaluate('(() => {const mods=[...__r.getModules().values()].filter(m=>m.isInitialized).map(m=>m.publicModule.exports);'
    + 'qa.store = mods.find(m=>m?.useGameStore).useGameStore;})()');
  const hall = await evaluate(`(() => {const g = qa.g;
    if (g.interiors.active) g.interiors.leave(g.player);
    const door = g.interiors.entrances.find((e) => e.kind === 'terminal');
    if (!door) return null;
    g.player.busUnit = null; g.player.state = 'idle'; g.player.currentVehicleId = null;
    g.player.swimming = false; g.player.health = 100; g.player.money = 500; g.player.wantedLevel = 0;
    // Mexer no corpo por fora exige o aviso do jogo: sem isto a HUD segue oferecendo o painel
    // velho (aBordo) e o botão que o laço procura nunca aparece no DOM.
    g.notifyEntityChange();
    qa.ir(door.x, door.y);
    g.interiors.update(0.6);
    const s = g.transport.platformNear(door.x, door.y);
    return { x: door.x, y: door.y, label: door.label, porta: g.interiors.nearest(g.player) === door,
      plataforma: s ? { id: s.id, nome: s.name, linhas: s.lines.length, x: +s.x.toFixed(2), y: +s.y.toFixed(2),
        baias: (s.platforms || []).length } : null };})()`);
  check(!!hall && hall.label === 'Rodoviária' && hall.porta,
    `a rodoviária tem porta na calçada do prédio: "${hall && hall.label}" anunciada na HUD`);
  check(!!hall && !!hall.plataforma && hall.plataforma.linhas >= 1,
    `da porta se alcança uma calçada com linha: ${hall && hall.plataforma && hall.plataforma.nome} `
    + `(${hall && hall.plataforma && hall.plataforma.linhas} linha(s))`);
  // A quadra exclusiva é a resposta para "tem que ter tudo exclusivo pra ele, inclusive a
  // quadra": a calçada do terminal tem baias numeradas, e cada uma tem passeio, placa e guichê
  // próprios. Uma estação de rua tem marquise só — se a rodoviária voltasse a ser um poste no
  // passeio, este número cairia a zero.
  check(!!hall && !!hall.plataforma && hall.plataforma.baias >= 2,
    `a rodoviária embarca por plataforma: ${hall && hall.plataforma && hall.plataforma.baias} baia(s) `
    + `numerada(s) na quadra de ${hall && hall.plataforma && hall.plataforma.nome}`);

  await evaluate('qa.inp.inputState.interactQueued = true');
  await until('!!qa.g.interiors.active && qa.g.interiors.active.kind === "terminal"',
    'o hall da rodoviária abrir', 60000);
  const sala = await evaluate('(() => {const r = qa.g.interiors.active;'
    + 'return { kind: r.kind, rotulo: r.label, moveis: r.furniture.length, sala: qa.g.activeMap === r.map,'
    + ' servico: r.service.label, custo: r.service.cost, loja: r.shop === null };})()');
  check(sala.kind === 'terminal' && sala.moveis >= 5 && sala.loja && sala.custo === 0,
    `hall de rodoviária por dentro: ${sala.moveis} móveis, sem estoque à venda, `
    + `serviço "${sala.servico}" gratuito, câmera na sala (${sala.sala})`);
  await evaluate('(() => {const r = qa.g.interiors.active; qa.g.player.x = r.service.x; qa.g.player.y = r.service.y;})()');
  await delay(500);
  await screenshot('qa-rodoviaria-hall');

  // O telão antes do toque: as partidas vêm do mesmo horário que desenha o ônibus na rua. A
  // passada e a frota vão junto porque, desde que a linha tocada amarra o plano, o painel deixa
  // de ser uma lista de destinos e passa a ser uma lista de ônibus.
  const partidas = await evaluate('(() => {const g = qa.g, r = g.interiors.active;'
    + 'const p = g.transport.platformNear(r.entrance.x, r.entrance.y);'
    + 'const rows = g.departureRows();'
    + 'return { origem: p ? p.id : -1, linhas: rows.length,'
    + ' relógio: g.dayNight.clock,'
    + ' rows: rows.map((d) => ({ id: `${d.route}:${d.destination}`, destino: d.destination,'
    + ' linha: d.line, lugar: d.place, baia: d.bay, espera: +d.wait.toFixed(1), viagem: +d.ride.toFixed(1),'
    + ' linhaId: d.route, passada: d.pass, unidade: d.unit, hora: d.at, via: d.company,'
    + ' sigla: d.code, cor: d.cor, frota: d.fleet,'
    + ' pernadas: (g.transport.trip(p.id, d.destination, { route: d.route, pass: d.pass, unit: d.unit })'
    + '   || { legs: [] }).legs.length })) };})()');
  check(partidas.origem >= 0 && partidas.linhas >= 1,
    `o telão do hall lista ${partidas.linhas} partida(s) da calçada #${partidas.origem}`);
  // Cada linha do painel é um ônibus, com uma placa, e a hora escrita é a hora do mundo para
  // aquela espera: "SAI EM 22:48" e "em 59s" têm de ser o mesmo instante no mesmo relógio.
  const placas = partidas.rows.map((r) => r.frota);
  check(new Set(placas).size === placas.length,
    `as ${placas.length} partidas do telão apontam ${new Set(placas).size} frota(s) diferente(s)`);
  const horasOk = partidas.rows.every((r) => /^\d{2}:\d{2}$/.test(r.hora)
    && r.sigla.length === 3 && r.frota.split('-')[0] === r.sigla);
  check(horasOk, `cada linha do telão tem hora de relógio e placa ${partidas.rows[0] && partidas.rows[0].frota} `
    + `da sua viação (${partidas.rows.map((r) => `${r.frota} às ${r.hora}`).join(', ')})`);
  const umaPerna = partidas.rows.every((r) => r.pernadas === 1);
  check(umaPerna, `tocar numa linha do telão embarca um ônibus só — as pernas por linha são `
    + `${partidas.rows.map((r) => r.pernadas).join('/')}`);

  await evaluate('qa.inp.inputState.interactQueued = true');
  await until('!!document.querySelector("[data-testid=departures-menu]")', 'o telão abrir na tela', 60000);
  const painel = await evaluate('(() => {const g = qa.g;'
    + 'return { aberto: qa.store.getState().departuresOpen,'
    + ' lidas: g.departureRows().map((d) => ({'
    + ' id: `${d.route}:${d.destination}`, linhaId: d.route, passada: d.pass, unidade: d.unit,'
    + ' destino: d.destination, hora: d.at, via: d.company, sigla: d.code, cor: d.cor,'
    + ' frota: d.fleet, espera: d.wait, viagem: d.ride })), '
    + ' linhas: document.querySelectorAll("[data-testid^=departures-row-]").length,'
    + ' titulo: document.body.innerText.includes("PARTIDAS · RODOVIÁRIA"),'
    + ' relógio: document.body.innerText.includes("embarque na plataforma anunciada"),'
    + ' baias: [...document.querySelectorAll("[data-testid^=departures-bay-]")]'
    + '   .map((e) => e.textContent || \'\'),'
    + ' viações: [...document.querySelectorAll("[data-testid^=departures-company-]")]'
    + '   .map((e) => e.textContent || \'\'),'
    + ' horas: [...document.querySelectorAll("[data-testid^=departures-at-]")]'
    + '   .map((e) => e.textContent || \'\'),'
    + ' contagens: [...document.querySelectorAll("[data-testid^=departures-wait-]")]'
    + '   .map((e) => e.textContent || \'\'),'
    + ' tempo: +qa.g.time.toFixed(3) };})()');
  check(painel.aberto && painel.linhas === partidas.linhas && painel.titulo && painel.relógio,
    `painel desenhado com as ${painel.linhas} partidas do horário e o aviso da plataforma`);
  // O número da plataforma está escrito no painel, e é o mesmo que a malha derivou do berço: na
  // rodoviária o passageiro não escolhe um ônibus, escolhe uma baia.
  const anunciadas = partidas.rows.map((r) => r.baia).filter(Boolean);
  check(anunciadas.length === painel.baias.filter((t) => /PLATAFORMA/.test(t)).length,
    `o telão mostra plataforma em ${painel.baias.filter((t) => /PLATAFORMA/.test(t)).length} de `
    + `${painel.baias.length} linha(s), e a malha anuncia ${anunciadas.length}`);
  // A placa e a hora têm de estar no pixel, não só no objeto: é a resposta para "sem repetir o
  // número do ônibus" e "a partida anunciada no relógio do jogo". Cada linha desenhada carrega a
  // viação, a lataria, a frota que ela manda procurar no pátio e a hora em que ele parte. Lidas
  // no mesmo instante do painel: o telão congela a rua, e é ele que está sendo provado.
  const escritas = painel.lidas.map((r, i) => ({
    frota: (painel.baias[i] || '').includes(`FROTA ${r.frota}`),
    via: painel.viações[i] === r.via,
    hora: painel.horas[i] === r.hora,
    conta: painel.contagens[i] === `em ${Math.ceil(r.espera)}s`,
    cor: !!r.cor && /^#[0-9a-f]{6}$/i.test(r.cor),
  }));
  check(escritas.length === painel.linhas
    && escritas.every((e) => e.frota && e.via && e.hora && e.conta && e.cor),
    `o painel pinta viação, lataria, placa e hora de cada partida: `
    + `${JSON.stringify(escritas[0])} · ${painel.lidas.map((r, i) => `${r.frota} ${painel.horas[i]}`).join(', ')}`);
  await screenshot('qa-rodoviaria-telao');
  // O telão é tela de menu: com ele na frente a rua congela, senão o ônibus partia na escolha.
  await delay(1200);
  const congelada = await evaluate('+qa.g.time.toFixed(3)');
  check(congelada === painel.tempo, `a rua para enquanto o telão está aberto (${painel.tempo}s -> ${congelada}s)`);

  // Escolher é o toque na linha, e o que ele entrega é um plano: o corpo não se move um tile.
  const tocada = [...partidas.rows].sort((a, b) => a.pernadas - b.pernadas || a.viagem - b.viagem)[0];
  // A passada e a placa com que o toque vai ser conferido são as do painel congelado, lidas no
  // mesmo instante em que o desenho foi medido — não as da varredura anterior, que viu a rua
  // andar um pouco antes de a porta do hall abrir.
  const escolhida = tocada && Object.assign({}, tocada,
    painel.lidas.find((r) => r.id === tocada.id) || {});
  check(!!tocada && painel.lidas.some((r) => r.id === tocada.id)
    && Number.isInteger(escolhida.unidade) && Number.isInteger(escolhida.passada)
    && escolhida.pernadas >= 1,
    `o telão tem viagem para "${escolhida && escolhida.lugar}" na ${escolhida && escolhida.linha} `
    + `(${escolhida && escolhida.frota} às ${escolhida && escolhida.hora}, passada `
    + `${escolhida && escolhida.passada}, ${escolhida && escolhida.pernadas} perna(s), `
    + `${Math.round(escolhida && escolhida.espera)}s de espera, `
    + `${Math.round(escolhida && escolhida.viagem)}s de passeio)`);
  const antes = await evaluate('({ x: qa.g.player.x, y: qa.g.player.y, dinheiro: qa.g.player.money })');
  // O testID da linha tem dois números separados por dois-pontos (`3:57`), e em CSS um valor
  // de atributo sem aspas não pode ter `:` — o seletor tem de vir entre aspas.
  const seletor = 'departures-row-' + escolhida.id;
  // O telão é uma lista que passa da dobra da tela: medir o retângulo de uma linha enrolada
  // abaixo devolve coordenada fora do viewport, e o toque cai na linha que estiver naquele
  // pixel. Primeiro rola a escolhida para o centro, depois mede.
  await evaluate('(() => {const e = document.querySelector(\'[data-testid="' + seletor + '"]\');'
    + 'if (!e) throw new Error(\'linha do telão fora da lista\');'
    + "e.scrollIntoView({ block: 'center' }); return true;})()");
  await delay(400);
  const alvo = await evaluate('(() => {const e = document.querySelector(\'[data-testid="' + seletor + '"]\');'
    + 'const r = e.getBoundingClientRect();'
    + "if (r.y < 0 || r.bottom > window.innerHeight) throw new Error('linha do telão ainda fora da tela');"
    + 'return { x: r.x + r.width / 2, y: r.y + r.height / 2 };})()');
  await tapPoint(alvo);
  await until('!qa.store.getState().departuresOpen && !document.querySelector("[data-testid=departures-menu]")',
    'o telão fechar depois do toque', 30000);
  const plano = await evaluate('(() => {const g = qa.g, j = g.journeys.journey, st = qa.store.getState();'
    + 'const perna = j && j.legs[0];'
    + 'return { fase: j && j.phase, alvo: j && j.target, pernadas: j && j.legs.length,'
    + ' linha: perna && perna.route, passada: perna && perna.pass, unidade: perna && perna.unit,'
    + ' dentro: !!g.interiors.active, x: +g.player.x.toFixed(3), y: +g.player.y.toFixed(3),'
    + ' dinheiro: g.player.money, pino: st.mapMarker ? { x: +st.mapMarker.x.toFixed(2), y: +st.mapMarker.y.toFixed(2) } : null,'
    + ' rota: st.mapRoute.length, hud: g.journeyStatus() };})()');
  check(plano.fase === 'walk' && plano.alvo === escolhida.destino && plano.pernadas === escolhida.pernadas,
    `o toque planejou a viagem em vez de teleportar: fase "${plano.fase}", ${plano.pernadas} perna(s), `
    + `destino #${plano.alvo}`);
  // A linha tocada é o ônibus do plano. Se o horário pudesse responder "o mais rápido que eu
  // achei", o passageiro leria AUR-104 às 14:12 no telão e esperaria, na mesma baia, um veículo
  // que não é aquele — que é exatamente a reclamação de "todos fazem a mesma coisa, bagunçado".
  check(plano.linha === escolhida.linhaId && plano.passada === escolhida.passada
    && plano.unidade === escolhida.unidade,
    `o plano embarca o ônibus anunciado: telão ${escolhida.frota} linha #${escolhida.linhaId} `
    + `passada ${escolhida.passada}, plano linha #${plano.linha} passada ${plano.passada} `
    + `unidade ${plano.unidade}`);
  check(!!plano.hud && plano.hud.includes(escolhida.frota),
    `a HUD chama o passageiro pelo número da placa: "${plano.hud}"`);
  check(Math.hypot(plano.x - antes.x, plano.y - antes.y) < 1e-9 && plano.dinheiro === antes.dinheiro,
    'escolher no telão não moveu o corpo nem cobrou passagem');
  check(!!plano.pino && plano.rota >= 2,
    `o plano ganhou pino e rota no GPS: ${JSON.stringify(plano.pino)} com ${plano.rota} pontos`);
  check(!!plano.hud && await evaluate(`document.body.innerText.includes(${JSON.stringify(plano.hud)})`),
    `a HUD diz o que falta: "${plano.hud}"`);

  // Dentro da sala a rua está congelada — a mesma regra do trânsito e da polícia — e o plano
  // espera junto: ele não pode virar "espera" com o corpo ainda dentro do prédio.
  await delay(900);
  const naSala = await evaluate('({ sala: !!qa.g.interiors.active,'
    + ' fase: qa.g.journeys.journey && qa.g.journeys.journey.phase })');
  check(naSala.sala && naSala.fase === 'walk',
    `o plano espera dentro da sala: fase "${naSala.fase}" com o hall ainda aberto`);

  // Sair para a rua é o mesmo caminho da porta: o plano continua de pé lá fora.
  await evaluate('(() => {const r = qa.g.interiors.active; qa.g.player.x = r.exit.x; qa.g.player.y = r.exit.y;})()');
  await delay(250);
  await evaluate('qa.inp.inputState.interactQueued = true');
  await until('!qa.g.interiors.active', 'o hall devolver a rua', 30000);
  const rua = await evaluate('(() => {const g = qa.g, j = g.journeys.journey,'
    + ' st = qa.store.getState();'
    + 'const leg = j && j.legs[j.leg];'
    + 'const s = leg && g.transport.network.stations[leg.from];'
    // O pino do GPS é a baia anunciada no telão, não o marco da estação: no pátio a estação é um
    // ponto no virador, e o que abre a porta é o passeio da plataforma da linha. Andar até o
    // marco deixaria o corpo a vários tiles da porta — o check estaria batendo numa regra que o
    // jogador não vê, e a numeração das baias continuaria provada só na malha.
    + 'const pino = st.mapMarker || s;'
    // A baia da perna, lida da malha pelo mesmo caminho que `plataformaDaLinha` usa: a estação
    // guarda as ids das suas plataformas e cada uma diz quais linhas ali encostam.
    + 'const baia = s ? (s.platforms || []).map((id) => g.transport.network.platforms[id])'
    + '  .find((p) => p && p.lines.includes(leg.route)) || null : null;'
    + 'return { fase: j && j.phase, doPino: pino ? +Math.hypot(g.player.x - pino.x, g.player.y - pino.y).toFixed(2) : -1,'
    + ' x: pino && +pino.x.toFixed(2), y: pino && +pino.y.toFixed(2), nome: s && s.name,'
    + ' doMarco: s ? +Math.hypot(pino.x - s.x, pino.y - s.y).toFixed(2) : -1,'
    + ' pinBaia: baia ? +Math.hypot(pino.x - baia.x, pino.y - baia.y).toFixed(2) : -1,'
    + ' baia: baia ? { nome: baia.name, x: +baia.x.toFixed(2), y: +baia.y.toFixed(2) } : null };})()');
  // A porta do hall dá em cima da calçada: entre o `walk` do plano e o `wait` da plataforma há
  // menos de `BOARDING_REACH` tiles, então sair já pode virar espera no mesmo instante. O que se
  // cobra é que a viagem sobreviva à porta, não a fase exata do segundo em que o corpo aparece.
  check(rua.fase === 'walk' || rua.fase === 'wait',
    `a viagem sobreviveu à porta do hall (fase "${rua.fase}")`);
  // O pino cravado na rua é a baia que o telão anunciou, e o marco da estação fica atrás dele:
  // é a resposta pixelada para "como vou saber em qual plataforma eu entro", dita pelo GPS do
  // jogo — a malha já provava isso em memória, aqui é o store que move o corpo.
  check(!!rua.baia && rua.pinBaia <= 0.05,
    `o GPS aponta para a baia anunciada: pino na ${rua.baia && rua.baia.nome} `
    + `(${rua.pinBaia} tiles do painel da plataforma)`);
  check(rua.doMarco > 1,
    `a baia está a ${rua.doMarco} tiles do marco da estação — quem espera no poste errado `
    + 'não embarca na linha escolhida');

  // A perna a pé é do jogador: o check leva o corpo ao pino (o joystick já foi medido na
  // seção 6) e cobra o plano virar espera só então, na calçada certa.
  await evaluate(`qa.ir(${rua.x}, ${rua.y})`);
  await until('qa.g.journeys.journey && qa.g.journeys.journey.phase === "wait"',
    'o plano virar espera na plataforma anunciada', 30000);
  const espera = await evaluate('({ pino: qa.store.getState().mapMarker, hud: qa.g.journeyStatus() })');
  check(espera.pino === null, 'chegar à calçada tirou o destino do mapa: agora o ônibus é a referência');
  check(/CHEGA EM/.test(espera.hud || ''), `a HUD conta a espera do horário: "${espera.hud}"`);
  // Na calçada o passageiro não espera "a linha": espera a placa que leu no telão, e é ela que a
  // HUD repete em cima da contagem do horário.
  check((espera.hud || '').includes(escolhida.frota),
    `na plataforma a HUD chama o ${escolhida.frota}: "${espera.hud}"`);
  // O pixel que o usuário cobrou: em cima da plataforma, a quadra exclusiva tem de aparecer —
  // a faixa pintada no passeio, a placa com o número da baia, o guichê e o asfalto do pátio.
  await screenshot('qa-rodoviaria-plataforma');

  // Embarcar e descer pelo botão da HUD, até o corpo pisar o passeio do destino. O laço é o
  // mesmo de quem viaja: espera-se a linha do plano (nenhum passageiro entra no ônibus errado
  // de propósito), desce-se na calçada da perna, e se por acaso a linha errada tiver levado
  // o corpo, desce-se na calçada seguinte e o horário é consultado de novo dali. Nada de
  // fingir que chegou: quem encerra a viagem é o `Você chegou`, não o relógio do teste.
  const trajeto = [];
  const embarques = [];
  let chegou = null;
  let embarcadoEm = -1;
  const fim = Date.now() + 300000;
  while (!chegou && Date.now() < fim) {
    const estado = await evaluate('(() => {const g = qa.g, j = g.journeys.journey;'
      + 'if (!j) return { fim: true, msg: g.interiors.message, tempo: +g.time.toFixed(1) };'
      + 'const leg = j.legs[j.leg]; const partida = g.transport.network.stations[leg.from];'
      + 'const u = g.transport.aboard(g.player);'
      // `boarding` devolve o ÍNDICE da unidade encostada, não a unidade: é o que a HUD lê
      // para decidir se o botão EMBARCAR existe.
      + 'const encostado = g.transport.boarding(g.player);'
      + 'const naPorta = encostado === null ? null : g.transport.units[encostado];'
      + 'const parada = u && u.stopped && u.stop >= 0'
      + ' ? g.transport.network.routes[u.route].stops[u.stop].station : -1;'
      + 'const alvo = g.transport.network.stations[j.target];'
      // A leitura do ônibus embarcado é a resposta à pergunta que a falha não respondia: "693
      // passos e o passageiro não desceu" pode ser lataria congelada no asfalto (freio), pode ser
      // o ônibus passando a estação sem dwell nenhum (o atraso comeu a parada) e pode ser um plano
      // que aponta uma estação por onde essa linha nunca passa. Os três têm assinaturas
      // diferentes no mesmo corpo, e sem eles o laço só sabia que não chegou.
      + 'const bus = u ? { x: +u.x.toFixed(1), y: +u.y.toFixed(1), atraso: +u.atraso.toFixed(1),'
      + ' segurado: !!u.held, parado: !!u.stopped, v: +(u.speed || 0).toFixed(2),'
      + ' paradaAtual: u.stop, linha: u.route } : null;'
      // O destino da perna a pé é o pino do GPS, não o poste da estação: na rodoviária o poste é
      // um ponto do virador e a porta abre no passeio da baia.
      + 'const pino = qa.store.getState().mapMarker || partida;'
      + 'return { fase: j.phase, perna: leg.to, destino: j.target, embarcado: !!u,'
      + ' linha: g.transport.network.routes[leg.route].name, parada,'
      + ' doDestino: +Math.hypot(g.player.x - alvo.x, g.player.y - alvo.y).toFixed(2),'
      + ' pino: { x: +pino.x.toFixed(2), y: +pino.y.toFixed(2) },'
      + ' msg: g.interiors.message, tempo: +g.time.toFixed(1), bus,'
      + ' embarcar: !u && !!naPorta && naPorta.route === leg.route'
      + ' && !!document.querySelector("[data-testid=control-enter]"),'
      + ' descer: !!u && u.stopped && u.stop >= 0 && (parada === leg.to'
      + ' || (u.route !== leg.route && parada !== ' + embarcadoEm + '))'
      + ' && !!document.querySelector("[data-testid=control-exit]") };})()');
    if (estado.fim) { chegou = estado; break; }
    trajeto.push({ fase: estado.fase, perna: estado.perna, embarcado: estado.embarcado,
      parada: estado.parada, msg: estado.msg, doDestino: estado.doDestino, bus: estado.bus });
    if (estado.embarcar) {
      const embarque = await evaluate('(() => {const g = qa.g, j = g.journeys.journey, leg = j.legs[j.leg];'
        + 'const i = g.transport.boarding(g.player);'
        + 'const u = i === null ? null : g.transport.units[i];'
        + 'return { parada: u && u.stop >= 0 ? g.transport.network.routes[u.route].stops[u.stop].station : -1,'
        + ' perna: j.leg, planejada: leg.unit, linha: leg.route, embarcada: u ? u.unit : -1,'
        + ' rotaEmbarcada: u ? u.route : -1, placa: u ? g.transport.network.routes[u.route].name : \'\', '
        + ' anunciado: g.busTarget() === i };})()');
      embarques.push(embarque);
      embarcadoEm = embarque.parada;
      await tapPoint(await textCenter('EMBARCAR'));
      await delay(320);
    } else if (estado.descer) {
      await tapPoint(await textCenter('DESEMBARCAR'));
      await delay(320);
    } else if (estado.fase === 'walk') {
      // A perna a pé é do jogador: o check leva o corpo ao pino da vez (o joystick já foi
      // medido na seção 6) e espera o plano virar espera na calçada certa.
      await evaluate(`qa.ir(${estado.pino.x}, ${estado.pino.y})`);
    }
    await delay(420);
  }
  // A assinatura do laço, contada no Node a partir das leituras que já existem: quantos passos a
  // lataria embarcada passou congelada, quantos com o ônibus andando, e para onde a distância ao
  // destino andou. Congelada e crescente é rua entupida; andando e sem descer é o dwell que não
  // aconteceu; andando e a distância parada é o plano que não aponta por onde o ônibus passa.
  const bordoLeit = trajeto.filter((t) => t.bus);
  const Conta = (f) => bordoLeit.filter(f).length;
  const conta = {
    leituras: bordoLeit.length,
    congelada: Conta((t) => t.bus.segurado && t.bus.v === 0),
    marchando: Conta((t) => t.bus.v > 0),
    dwell: Conta((t) => t.bus.parado),
    naParada: Conta((t) => t.bus.paradaAtual >= 0),
  };
  const dists = trajeto.filter((t) => typeof t.doDestino === 'number');
  if (dists.length) {
    conta.doDestinoInicial = dists[0].doDestino;
    conta.doDestinoFinal = dists[dists.length - 1].doDestino;
    conta.maisPerto = Math.min(...dists.map((t) => t.doDestino));
  }
  const atrasos = bordoLeit.map((t) => t.bus.atraso);
  if (atrasos.length) {
    conta.atrasoInicial = atrasos[0];
    conta.atrasoFinal = atrasos[atrasos.length - 1];
    conta.atrasoMaximo = Math.max(...atrasos);
  }
  check(!!chegou, `a viagem terminou dentro do prazo (${trajeto.length} passos do laço) — `
    + `${bordoLeit.length} leitura(s) com ônibus embarcado: ${conta.congelada} congelada por freio, `
    + `${conta.marchando} andando, ${conta.dwell} em dwell, ${conta.naParada} com parada marcada · `
    + `atraso ${conta.atrasoInicial} para ${conta.atrasoFinal} (pico ${conta.atrasoMaximo}) · `
    + `destino a ${conta.doDestinoInicial} tiles, encalhou a ${conta.maisPerto}, `
    + `saiu a ${conta.doDestinoFinal}`);
  // O embarque é a placa, não a linha: o primeiro ônibus que abriu a porta na rodoviária tinha de
  // ser o veículo que o telão anunciou, senão a promessa do painel era só o nome da linha e o
  // passageiro entraria no carro errado da mesma viação.
  const primeiro = embarques[0];
  check(!!primeiro && primeiro.perna === 0 && primeiro.linha === escolhida.linhaId
    && primeiro.embarcada === primeiro.planejada && primeiro.rotaEmbarcada === escolhida.linhaId,
    `embarcou no ônibus anunciado: telão ${escolhida.frota} (unidade ${escolhida.unidade} da linha `
    + `#${escolhida.linhaId}), rua subiu na unidade ${primeiro && primeiro.embarcada} da linha `
    + `#${primeiro && primeiro.rotaEmbarcada} · ${embarques.length} embarque(s)`);
  // A régua de chegada é o destino do *plano*, não o que a lista prometia: se o toque tivesse
  // caído noutra linha, o corpo teria parado na calçada errada e o check acusaria o horário.
  const fuso = await evaluate('(() => {const g = qa.g, st = qa.store.getState();'
    + 'const alvo = g.transport.network.stations[' + plano.alvo + '];'
    + 'return { journey: g.journeys.journey, sala: !!g.interiors.active,'
    + ' doPasseio: +Math.hypot(g.player.x - alvo.x, g.player.y - alvo.y).toFixed(2),'
    + ' lugar: g.journeyStatus(),'
    + ' msg: g.interiors.message, pino: st.mapMarker, rota: st.mapRoute.length,'
    + ' aBordo: g.transport.aboard(g.player) !== null };})()');
  check(fuso.journey === null && !fuso.aBordo && !fuso.sala,
    `o plano se encerrou por conta própria, com o corpo fora do ônibus e da sala (mensagem: "${fuso.msg}")`);
  check(fuso.doPasseio <= 1.5,
    `o viajante está no passeio do destino: ${fuso.doPasseio} tiles da calçada`);
  check(/^Você chegou/.test(fuso.msg), `a rua anunciou a chegada: "${fuso.msg}"`);
  check(fuso.pino === null && fuso.rota === 0, 'o GPS guardou o pino e a rota junto com a viagem');
  check(fuso.lugar === null, 'sem viagem, a HUD não inventa objetivo');
  const aBordo = trajeto.filter((t) => t.fase === 'ride').length;
  console.log(`  rodoviária no navegador: ${partidas.linhas} partidas no telão · `
    + `${escolhida.linha} (${escolhida.via} ${escolhida.frota}, saída às ${escolhida.hora}) até `
    + `"${escolhida.lugar}" · embarque na ${rua.baia ? rua.baia.nome : 'calçada de rua'} · `
    + `${escolhida.pernadas} perna(s) · subiu na unidade ${primeiro ? primeiro.embarcada : '-'}, `
    + `anunciada ${escolhida.unidade} · seta no embarque: ${embarques.filter((e) => e.anunciado).length}/${embarques.length} · `
    + `${aBordo} leitura(s) a bordo · laço de ${trajeto.length} leitura(s) · `
    + `${chegou ? chegou.tempo : '-'}s de mundo`);
  await screenshot('qa-rodoviaria-chegada');

  // 8) A identificação na tela. A pergunta do jogador é literal — "como vou saber qual é o ônibus
  // que eu tenho que entrar?" — e a resposta é pixel: a calçada do ponto pintada, a placa com o
  // número da linha sobre cada ônibus e a seta grande sobre o ônibus da vez. Cada uma das três é
  // medida com a alavanca que a desliga, e só ela: as linhas da estação voltam a zero (a camada
  // do ponto passa a estacione inteira), o nome da linha fica sem dígito (a placa é pulada) e
  // `busTarget()` emudece (a seta é pulada). A rua fica congelada e as janelas comparadas partem
  // da mesma cena, então o que muda de um quadro para o outro é exatamente o que a alavanca
  // desligou — nada de "a tela mudou um pouco".
  const cena = await evaluate(`(() => {
    const g = qa.g;
    if (g.interiors.active) g.interiors.leave(g.player);
    g.player.busUnit = null; g.player.state = 'idle'; g.player.currentVehicleId = null;
    g.player.swimming = false; g.player.health = 100; g.player.wantedLevel = 0;
    g.player.invulnUntil = Infinity;
    g.weather.force('clear', 3600);
    g.dayNight.t = 0.5;
    g.notifyEntityChange();
    qa.ir(qa.parada.x, qa.parada.y);
    // O mapa da cena: a Skia desenha em coordenada local do mundo e a câmera da Skia amplia em
    // torno do ponto dela. Toda caixa abaixo é medida nesse mapa porque a régua que vale é a do
    // pixel — uma camada desenhada em outro lugar é uma camada invisível.
    qa.tela = (lx, ly) => {
      const c = g.camera;
      return { x: window.innerWidth / 2 + c.zoom * (lx - (c.x - c.y) * 64),
        y: window.innerHeight / 2 + c.zoom * (ly - ((c.x + c.y) * 32 - c.h * 64)) };
    };
    qa.local = (x, y) => ({ x: (x - y) * 64, y: (x + y) * 32 - g.map.heightSmoothAt(x, y) * 64 });
    qa.proj = (x, y, dx, dy) => { const l = qa.local(x, y); return qa.tela(l.x + (dx || 0), l.y + (dy || 0)); };
    // O encosto primeiro, a geometria depois. O ônibus não escolhe onde encosta — quem decide é
    // o asfalto do ponto — e a régua antiga exigia que ELE já estivesse no claro com a câmera
    // pregada no marco: a 5 tiles do corpo, a coluna do aviso caía fora do quadro e o check
    // morria à espera de uma coincidência que não é regra nenhuma. Aqui se espera o embarque,
    // congela a rua e é a CÂMERA que vai até o veículo marcado.
    qa.alvo = () => {
      const i = g.busTarget();
      if (i === null) return null;
      const u = g.transport.units[i];
      if (!u || !u.live) return null;
      const perna = u.stop >= 0 ? g.transport.network.routes[u.route].stops[u.stop] : null;
      const est = perna && perna.station >= 0
        ? g.transport.network.stations[perna.station] : qa.parada;
      qa.pintada = est;
      return { i: i, rota: u.route, dir: u.dir, x: u.x, y: u.y, parado: !!u.stopped,
        linha: g.transport.network.routes[u.route].name, est: est.id, nome: est.name,
        linhas: est.lines.length, zona: est.ponto.length,
        doCorpo: +Math.hypot(g.player.x - u.x, g.player.y - u.y).toFixed(2) };
    };
    // Câmera no pé do ônibus marcado: com ele no centro do quadro, a coluna inteira do aviso
    // (do topo da seta até a sombra do corpo) cai no meio da tela, longe do joystick, dos botões
    // e do radar, sem depender da sorte de o veículo encostar do lado certo do marco.
    qa.focar = (x, y) => { g.camera.x = x + 0.6; g.camera.y = y + 0.6;
      g.camera.h = g.map.heightSmoothAt(x, y); };
    qa.marca = () => {
      const i = g.busTarget();
      if (i === null) return null;
      const u = g.transport.units[i];
      if (!u || !u.live) return null;
      const img = qa.sprites['Vehicles/veh_bus_school_' + u.dir + '.png'];
      if (!img || !img.width() || !img.height()) return null;
      const z = g.camera.zoom, W = window.innerWidth, H = window.innerHeight;
      const pe = qa.proj(u.x, u.y);
      const w = img.width() * z, h = img.height() * z;
      // E ainda assim a régua recusa, em vez de contar, um quadro onde a marca não cabe: se a
      // câmera não conseguiu pôr o aviso inteiro na tela, a medição não é honesta.
      const metade = Math.max(w / 2, 42 * z);
      if (pe.x - metade < 8 || pe.x + metade > W - 8) return null;
      if (pe.y - 126 * z < 8 || pe.y + 12 * z > H - 8) return null;
      return { i: i, rota: u.route, dir: u.dir, x: pe.x, y: pe.y, w: w, h: h, z: z,
        linha: g.transport.network.routes[u.route].name, parado: !!u.stopped,
        doCorpo: +Math.hypot(g.player.x - u.x, g.player.y - u.y).toFixed(2),
        porta: g.transport.boarding(g.player) === i };
    };
    // As três faixas de tinta, nos deslocamentos locais que as camadas usam: o corpo do ônibus
    // sobe 55 pixels do pé, a placa nasce a 66 e a seta, a 92, respirando até 9 pixels acima.
    qa.caixas = (a) => ({
      corpo: { x0: a.x - a.w / 2, y0: a.y - a.h, x1: a.x + a.w / 2, y1: a.y + 3 },
      seta: { x0: a.x - 26 * a.z, y0: a.y - 124 * a.z, x1: a.x + 26 * a.z, y1: a.y - 80 * a.z },
      placa: { x0: a.x - 42 * a.z, y0: a.y - 78 * a.z, x1: a.x + 42 * a.z, y1: a.y - 56 * a.z },
    });
    // Um segundo ônibus no claro, longe do primeiro: é o que dá valor à seta. Se a marca fosse da
    // LINHA, e não do veículo, ela apareceria sobre os dois.
    qa.outro = (ax, ay) => {
      const z = g.camera.zoom, W = window.innerWidth, H = window.innerHeight;
      let melhor = null;
      for (let k = 0; k < g.transport.units.length; k++) {
        if (k === g.busTarget()) continue;
        const u = g.transport.units[k];
        if (!u.live) continue;
        const img = qa.sprites['Vehicles/veh_bus_school_' + u.dir + '.png'];
        if (!img || !img.width()) continue;
        const pe = qa.proj(u.x, u.y), w = img.width() * z;
        const metade = Math.max(w / 2, 42 * z);
        if (pe.x - metade < 8 || pe.x + metade > W - 8) continue;
        if (pe.y - 126 * z < 8 || pe.y + 12 * z > H - 8) continue;
        const d = Math.hypot(pe.x - ax, pe.y - ay);
        if (d < 130) continue;
        if (!melhor || d > melhor.d) melhor = { i: k, d: +d.toFixed(0), x: pe.x, y: pe.y, z: z, w: w,
          h: img.height() * z };
      }
      return melhor;
    };
    // Os losangos do passeio são a lista que noPonto() aceita, tile a tile, com a elevação de
    // cada canto — a mesma conta da camada, refeita aqui para a régua não ter geometria própria.
    // Cada um sai marcado como sendo (ou não) o tile do marco, porque o que a camada pinta hoje
    // é UM bloco: sem essa etiqueta não dá para cobrar o resto da calçada limpo.
    qa.tiles = () => {
      const fx = Math.floor(qa.pintada.x), fy = Math.floor(qa.pintada.y);
      const W = window.innerWidth, H = window.innerHeight;
      return qa.pintada.ponto.map((t) => {
        const tx = Math.floor(t.x), ty = Math.floor(t.y);
        const ps = [[0.25, 0.25], [0.75, 0.25], [0.75, 0.75], [0.25, 0.75]]
          .map((f) => qa.proj(tx + f[0], ty + f[1]));
        const x0 = Math.min(...ps.map((p) => p.x)), x1 = Math.max(...ps.map((p) => p.x));
        const y0 = Math.min(...ps.map((p) => p.y)), y1 = Math.max(...ps.map((p) => p.y));
        return { x0: x0, x1: x1, y0: y0, y1: y1, marco: tx === fx && ty === fy,
          naTela: x0 > W * 0.12 && x1 < W * 0.88 && y0 > H * 0.16 && y1 < H * 0.78 };
      });
    };
    // O bloco pintado: o tile do marco, com os mesmos recortes de 0,08 que a camada usa. É a
    // única tinta de chão de um ponto de ônibus na cidade — a zona de embarque continua sendo os
    // sete a doze tiles de calçada que a estação guarda em 'ponto', só não é mais um tapete
    // laranja.
    qa.bloco = () => {
      const tx = Math.floor(qa.pintada.x), ty = Math.floor(qa.pintada.y);
      const ps = [[0.08, 0.08], [0.92, 0.08], [0.92, 0.92], [0.08, 0.92]]
        .map((f) => qa.proj(tx + f[0], ty + f[1]));
      const x0 = Math.min(...ps.map((p) => p.x)), x1 = Math.max(...ps.map((p) => p.x));
      const y0 = Math.min(...ps.map((p) => p.y)), y1 = Math.max(...ps.map((p) => p.y));
      const W = window.innerWidth, H = window.innerHeight;
      return { x0: x0, x1: x1, y0: y0, y1: y1,
        naTela: x0 > W * 0.12 && x1 < W * 0.88 && y0 > H * 0.16 && y1 < H * 0.78 };
    };
    qa.poste = () => { const p = qa.proj(qa.pintada.x, qa.pintada.y), z = g.camera.zoom;
      return { x0: p.x - 9 * z, y0: p.y - 47 * z, x1: p.x + 9 * z, y1: p.y - 30 * z }; };
    return { est: qa.parada.id, nome: qa.parada.name, linhas: qa.parada.lines.length,
      zona: qa.parada.ponto.length };
  })()`);
  await until('!!qa.alvo()', 'um ônibus da malha encostar na calçada onde o corpo espera', 180000);
  // Com a rua congelada é a câmera que vai até o veículo: o chão regravado e o culling de
  // 120 ms precisam de alguns quadros para redesenhar a cena no novo enquadramento.
  await evaluate('(() => {qa.__rua = qa.g.update; qa.g.update = () => {};})()');
  const preso = await evaluate('(() => {const a = qa.alvo(); if (a) qa.focar(a.x, a.y); return a;})()');
  await delay(2200);
  const marcado = await evaluate('(() => {const a = qa.marca(); return a && { a: a, cx: qa.caixas(a), '
    + 'outro: qa.outro(a.x, a.y) };})()');
  if (!marcado) {
    const geo = await evaluate('(() => {const g = qa.g, i = g.busTarget();'
      + 'const u = i === null ? null : g.transport.units[i];'
      + 'return { i: i, zoom: g.camera.zoom, W: window.innerWidth, H: window.innerHeight,'
      + ' pe: u ? qa.proj(u.x, u.y) : null, img: u ? (qa.sprites[\'Vehicles/veh_bus_school_\' '
      + '+ u.dir + \'.png\'] || { width: () => 0 }).width() : 0 };})()');
    await evaluate('(() => {qa.g.update = qa.__rua; delete qa.__rua;})()');
    check(false, `o ônibus marcado coube no quadro para a marca ser medida: encostou `
      + `#${preso ? preso.i : '-'} da ${preso ? preso.linha : 'nenhuma'} na calçada de `
      + `${preso ? preso.nome : cena.nome} a ${preso ? preso.doCorpo : '-'} tiles do corpo, e a `
      + `projeção ficou em ${JSON.stringify(geo)}`);
  } else {
    const cx = marcado.cx, a = marcado.a;
    const linhaSemDigito = a.linha.replace(/\d/g, '');
    // A) seta calada, placa acesa — a base comum das duas comparações. `busTarget()` é lido
    //    por uma camada só (BusMarkLayer), então emudece-lo desliga o aviso e nada mais.
    await evaluate('(() => {qa.g.busTarget = () => null;})()');
    await delay(800);
    const semSeta = await screenshot('qa-seta-sem');
    // B) a mesma cena com `busTarget()` devolvendo o veículo: só a seta mudou.
    await evaluate('delete qa.g.busTarget');
    await delay(800);
    const comSeta = await screenshot('qa-seta-com');
    // C) seta calada de novo e a linha sem dígito no nome: a placa é pulada, e a diferença é só
    //    a placa — por isso as duas janelas partem do quadro A, nunca do B.
    await evaluate('(() => {qa.g.busTarget = () => null;'
      + 'const r = qa.g.transport.network.routes[' + a.rota + ']; qa.__nome = r.name;'
      + 'r.name = ' + JSON.stringify(linhaSemDigito) + ';})()');
    await delay(800);
    const semPlaca = await screenshot('qa-placa-sem');
    // D) tudo de volta ao A: prova que a diferença veio da alavanca, não do tempo.
    await evaluate('(() => {qa.g.transport.network.routes[' + a.rota + '].name = qa.__nome;})()');
    await delay(800);
    const voltou = await screenshot('qa-seta-voltou');
    // Segunda passada: a câmera larga o veículo e vai ao marco da calçada. Com ela colada no
    // ônibus, a marquise inteira e o poste caem fora do claro — medimos 4 de 5 tiles `fora` e o
    // poste debaixo do HUD — e uma régua que lê caixa cortada conta 0 pixels de uma tinta que
    // está na tela. Cada camada é medida no enquadramento onde ELA cabe.
    await evaluate('(() => {qa.focar(qa.pintada.x, qa.pintada.y);})()');
    await delay(2200);
    const moldura = await evaluate('(() => {const t = qa.tiles(), p = qa.poste(), b = qa.bloco();'
      + 'const W = window.innerWidth, H = window.innerHeight;'
      + 'return { t: t, p: p, b: b, dentro: t.filter((x) => x.naTela).length,'
      + ' posteDentro: p.x0 > 8 && p.x1 < W - 8 && p.y0 > 8 && p.y1 < H - 8 };})()');
    // E/F/G) o bloco do ponto: um losango no tile do marco, e a calçada em volta dele limpa. A
    //        seta ainda está calada para a tinta do chão não competir com a tinta de aviso na
    //        conta de pixels. A estação é a do encosto, não a do marco onde o corpo foi posto:
    //        é o passeio daquele ônibus que está no quadro.
    const comPonto = await screenshot('qa-ponto-com');
    await evaluate('(() => {const s = qa.pintada; qa.__linhas = s.lines.slice(); s.lines.length = 0;})()');
    await delay(800);
    const semPonto = await screenshot('qa-ponto-sem');
    await evaluate('(() => {const s = qa.pintada; s.lines.push.apply(s.lines, qa.__linhas);})()');
    await delay(800);
    const voltouPonto = await screenshot('qa-ponto-voltou');
    await evaluate('(() => {delete qa.g.busTarget; qa.g.update = qa.__rua; delete qa.__rua;})()');

    const setaPx = naCaixa(semSeta, comSeta, cx.seta.x0, cx.seta.y0, cx.seta.x1, cx.seta.y1);
    const setaCor = amareloEm(comSeta, cx.seta) - amareloEm(semSeta, cx.seta);
    const corpoInvadido = naCaixa(semSeta, comSeta, cx.corpo.x0, cx.corpo.y0, cx.corpo.x1, cx.corpo.y1);
    check(setaPx >= 120 && setaCor >= 25,
      `a seta grande é desenhada sobre o ônibus marcado: ${setaPx} pixels mudam na faixa acima dele `
      + `(#${a.i} da ${a.linha}, zoom ${a.z.toFixed(2)}) e ${setaCor} deles são a tinta amarela do aviso`);
    check(corpoInvadido <= 12,
      `a seta fica ACIMA da lataria: ${corpoInvadido} pixel(s) do ônibus mudaram quando ela ligou `
      + `— o aviso não pinta por cima do veículo que ele marca`);
    if (marcado.outro) {
      const o = marcado.outro;
      const noOutro = naCaixa(semSeta, comSeta,
        o.x - 26 * o.z, o.y - 124 * o.z, o.x + 26 * o.z, o.y - 80 * o.z);
      check(noOutro <= 10,
        `a seta marca UM veículo, não a linha: no segundo ônibus do claro (#${marcado.outro.i}, `
        + `a ${marcado.outro.d} px do marcado) ligar a seta mudou ${noOutro} pixel(s)`);
    } else {
      check(true, 'nenhum segundo ônibus no claro para comparar — a régua de exclusividade ficou de fora');
    }

    const placaPx = naCaixa(semSeta, semPlaca, cx.placa.x0, cx.placa.y0, cx.placa.x1, cx.placa.y1);
    const placaCor = amareloEm(semSeta, cx.placa) - amareloEm(semPlaca, cx.placa);
    check(placaPx >= 150 && placaCor >= 20,
      `a placa da linha sobre o ônibus: ${placaPx} pixels mudam na faixa do teto quando o nome da `
      + `linha perde o dígito, e ${placaCor} deles são as lâmpadas âmbar do número "${a.linha}"`);
    const deriva = naCaixa(semSeta, voltou,
      Math.min(cx.seta.x0, cx.placa.x0, cx.corpo.x0), Math.min(cx.seta.y0, cx.placa.y0, cx.corpo.y0),
      Math.max(cx.seta.x1, cx.placa.x1, cx.corpo.x1), Math.max(cx.seta.y1, cx.placa.y1, cx.corpo.y1));
    check(deriva <= 30, `tiradas as alavancas, a mesma caixa volta ao mesmo quadro: ${deriva} pixel(s) `
      + `de diferença entre o antes e o depois de ${a.linha}`);

    const naTela = moldura.t.filter((t) => t.naTela);
    const outros = naTela.filter((t) => !t.marco);
    const tintaBloco = naCaixa(comPonto, semPonto, moldura.b.x0, moldura.b.y0, moldura.b.x1, moldura.b.y1);
    const sujos = outros.filter((t) => naCaixa(comPonto, semPonto, t.x0, t.y0, t.x1, t.y1) >= 20);
    const tintaSuja = sujos.reduce((s, t) => s + naCaixa(comPonto, semPonto, t.x0, t.y0, t.x1, t.y1), 0);
    check(moldura.b.naTela && tintaBloco >= 90,
      `o ponto de ônibus é UM bloco no chão: o losango do marco troca de cor no lugar exato onde `
      + `ele projeta (${tintaBloco} pixels na estação ${preso.nome})`);
    check(moldura.dentro >= 3 && outros.length >= 2 && sujos.length === 0,
      `a calçada do embarque deixou de ser um tapete laranja: ${sujos.length} de ${outros.length} `
      + `tiles ao redor do marco ainda trocam de cor (${tintaSuja} pixels), numa zona de `
      + `${preso.zona} tiles que continuam aceitando embarque (${preso.nome})`);
    const poste = moldura.p;
    const postePx = naCaixa(comPonto, semPonto, poste.x0, poste.y0, poste.x1, poste.y1);
    const posteCor = amareloEm(comPonto, poste) - amareloEm(semPonto, poste);
    check(moldura.dentro >= 2 && moldura.posteDentro
      && postePx >= 25 && posteCor >= 10,
      `o marco do ponto existe na cena: ${moldura.dentro} de ${moldura.t.length} tiles e o poste `
      + `inteiro cabiam no claro (${JSON.stringify(poste)}), e ${postePx} pixels somem na faixa do `
      + `poste quando a estação perde as linhas — ${posteCor} deles são a placa amarela do sinal `
      + `(${preso.nome})`);
    const voltouZona = naCaixa(comPonto, voltouPonto,
      Math.min(poste.x0, ...naTela.map((t) => t.x0)), Math.min(poste.y0, ...naTela.map((t) => t.y0)),
      Math.max(poste.x1, ...naTela.map((t) => t.x1)), Math.max(poste.y1, ...naTela.map((t) => t.y1)));
    check(voltouZona <= 40, `o bloco e o poste voltam inteiros quando a estação volta a ter linhas: `
      + `${voltouZona} pixel(s) de diferença`);
    console.log(`  identificação: corpo no marco de ${cena.nome} (${cena.linhas} linhas) · `
      + `encostou o #${a.i} da ${a.linha} na calçada de ${preso.nome} (${preso.linhas} linhas, `
      + `zona de ${preso.zona} tiles), a ${a.doCorpo} tiles do corpo, porta dele: ${a.porta} · `
      + `zoom ${a.z.toFixed(2)}, seta a ${Math.round(a.y - 92 * a.z)} px do topo da tela`);
  }
  await screenshot('qa-identidade');

  // 9) A rua entra no freio no jogo real. O §14 do `check-transport` entrega ao ônibus uma lista
  //          fixa de corpos; aqui a lista sai da GRADE ESPACIAL do `GameState`, construída com o
  //          pedestre que o mundo moveu no tick anterior. É a única forma de provar a reclamação
  //          do jogador — "não param pra pedestres que atravessam a rua", "atravessam carros" —
  //          porque o que está em jogo agora é o encadeamento: `varreRua` → `SpatialIndex` →
  //          cone da faixa → dívida no relógio. Um pedestre de verdade é plantado no meio da
  //          faixa de um ônibus em marcha, depois no passeio ao lado, e a conta cobrada é a do
  //          asfalto: segurar sem tocar, e passar reto quando ele está na calçada.
  {
    await evaluate(`(() => {
      const g = qa.g, t = g.transport, m = g.map;
      // O wrapper de update é o pino: um pedestre teleportado uma única vez é andar do
      // NPCSystem, e a olhada do ônibus lê a grade reconstruída no FIM do quadro — ou ele é
      // plantado a cada tick, ou a travessa some antes do freio. O bind importa: update é método
      // de instância e solto ele perderia o this.
      if (!qa.__updateOriginal) qa.__updateOriginal = g.update.bind(g);
      qa.__zera = () => {
        const u = g.transport.units[qa.__u];
        if (!u) return false;
        qa.__c = { tiquetes: 0, seguradas: 0, parados: 0, paradas: 0, andou: 0, focinho: Infinity,
          atraso0: u.atraso, x0: u.x, y0: u.y, vida: Infinity, morto: 0 };
        return true;
      };
      // O plantado é um ponto FIXO no mundo, e um ônibus que rodou seis segundos já deixou aquele
      // asfalto para trás: plantar nele seria cobrar um pedestre que ele tem pelas costas. Por
      // isso a conta é a do MESMO ônibus, com o corpo re-plantado 2,6 tiles à frente no começo de
      // cada fase — a base sem corpo, o passeio, a faixa e a abertura — porque duas faixas e
      // dois motoristas de horário não são comparáveis, e a diferença que eu quero medir é de um
      // relógio só.
      //
      // Quem garante que o ônibus está na cena é o portão: u.live é a palavra do streaming, e
      // a régua de "perto do corpo" media a mesma coisa por baixo, só que de um ponto fixo. Com a
      // frota cortada e o headway de papel, quase tudo que está vivo numa estação está parado no
      // dwell ou segurando no ponto, e o pouso que sobra em marcha já passou dos 20 tiles do
      // corpo — a amostra nunca achava candidato. Agora é o contrário: o corpo vai até
      // o ônibus escolhido, seis tiles atrás e para fora do asfalto, onde ele não é obstáculo de
      // ninguém e a câmera continua materializando a faixa medida.
      // O critério "atraso > 1" saiu da peneira, e ele já foi regra: com a frota do tamanho
      // antigo, um ônibus quase-nada-atrasado era o motorista sem fila. Medido com a régua nova,
      // o atraso da malha é permanente (dezenas de segundos contra ciclos de centenas), porque
      // cada travessia cobrada é um segundo escrito no relógio e a recuperação de meia marcha só
      // devolve o que a rua tem para dar — nenhum candidato passava daquela peneira e a cena
      // morria em "tempo esgotado". O que a régua compara é a VARIAÇÃO do atraso entre quatro
      // fases do mesmo corpo, então o que importa é a marcha: viva, não parada no horário, não
      // segurada por lataria, com a faixa dos seis tiles atrás aos oito à frente sem obstáculo.
      // Isso a própria peneira abaixo já cobra.
      // Cada rejeição é escrita num censo antes de virar null. "A marcha não dura as quatro
      // fases" e "a rua não tem ônibus em marcha" são reclamações diferentes, e só a contagem de
      // qual portão fecha a porta diz qual das duas está na tela.
      qa.__motivos = {};
      qa.__primeiro = null;
      qa.__rejeita = (k) => {
        qa.__motivos[k] = (qa.__motivos[k] || 0) + 1;
        if (qa.__primeiro == null) qa.__primeiro = k;
        return null;
      };
      qa.__plantaPara = (i, exigeViva, faltam) => {
        const b = t.units[i];
        // 'live' é a palavra da CÂMERA (o portão de streaming), não do asfalto: quem sai do
        // círculo de 40 tiles do jogador deixa de existir, e só volta a existir quando a câmera
        // vai até ele. Cobrá-lo antes de mover a câmera é exigir que um ônibus que andou 70
        // tiles voltasse andando até o poste velho, e foi assim que as cinco tentativas morriam
        // em "fora da cena" com seis unidades em marcha no bairro do lado.
        if (!b) return qa.__rejeita('sem unidade');
        if (exigeViva === true && !b.live) return qa.__rejeita('fora da cena');
        if (b.stopped) return qa.__rejeita('parado no horario');
        if (b.held) return qa.__rejeita('segurado por lataria');
        // O portão que faltava é de tempo, não de metros. As quatro fases somam ~14 s de marcha
        // livre sobre o MESMO ônibus, e medido na malha (418 trechos entre duas paradas) a
        // metade deles dura 4,6 s e só 8% chegam a 13 s: um ônibus a seis segundos do próprio
        // guichê nunca terá as quatro fases, e era exatamente isso que a suja mostrava —
        // 'base' e 'passeio' redondos (0 segurados em 181 quadros, 10 tiles andados) e a fase
        // seguinte sem candidato. A régua de "parada a 5 tiles" varre só os oito tiles à frente,
        // onde o corpo ainda está; quem sabe o resto do caminho é a própria tabela de passadas.
        const rota = t.network.routes[b.route];
        const proxima = (rota.table[b.pass + 1] || { time: rota.cycle }).time;
        if (proxima - b.phase < (faltam || 0)) return qa.__rejeita('dwell no caminho');
        const cos = Math.cos(b.angle), sin = Math.sin(b.angle);
        const planta = { x: b.x + cos * 2.6, y: b.y + sin * 2.6 };
        if (m.tileKindAt(planta.x, planta.y) !== 'road') return qa.__rejeita('pouso fora do asfalto');
        let lado = 0;
        for (const s of [1, -1]) {
          if (m.tileKindAt(planta.x - sin * s * 1.3, planta.y + cos * s * 1.3) !== 'road') {
            lado = s; break;
          }
        }
        if (!lado) return qa.__rejeita('sem passeio ao lado');
        // Onde o corpo pisa é que não pode haver guichê: um pedestre plantado numa zona de
        // embarque seguraria o ônibus por passageiro, e a medição cobraria do freio uma parada
        // que o horário mandou fazer. Varrer a faixa inteira contra estação, porém, é outra
        // conta: com raio de cinco tiles sobre 162 estações, uma parada da avenida vizinha
        // derrubava o candidato embora o próprio guichê dele estivesse a 28 tiles de distância
        // — foi o portão que fechou primeiro em quatro das cinco tentativas, inclusive na que
        // mediu a travessa inteira (base 0/181, passeio 7/181, faixa 163/196 segurados e 0,46
        // tiles andados) e perdeu só a volta. Quem tem de estar limpo à frente é o asfalto de
        // lataria; o resto do caminho é o portão de tempo que já respondeu.
        if (t.network.stations.some((st) => Math.hypot(st.x - planta.x, st.y - planta.y) < 5)) {
          return qa.__rejeita('parada na faixa');
        }
        for (let d = -6; d <= 8; d += 0.5) {
          const px = b.x + cos * d, py = b.y + sin * d;
          if (m.tileKindAt(px, py) !== 'road') continue;
          for (const v of g.vehicles) if (Math.abs(v.x - px) < 1 && Math.abs(v.y - py) < 1) return qa.__rejeita('carro na faixa');
        }
        const tras = { x: b.x - cos * 6, y: b.y - sin * 6 };
        return { sobra: proxima - b.phase, planta,
          passeio: { x: planta.x - sin * lado * 1.3, y: planta.y + cos * lado * 1.3 },
          corpo: { x: tras.x - sin * lado * 2.6, y: tras.y + cos * lado * 2.6 } };
      };
      // O pulo aleatório é o último recurso, não a procura. A régua antiga era esta: a câmera
      // nunca saía da parada mais movimentada do mapa (102 das 109 unidades fora da cena, e das
      // ~7 que entravam as ~3 em marcha estavam encostadas ou de passagem no guichê), então
      // jogava-se a câmera num asfalto a sete tiles de nenhuma parada e torcia para um ônibus
      // passar por ali. Medido contra a tabela, isso não basta: só ~15% da frota tem 14 s de
      // marcha livre pela frente em um instante qualquer, e dessas quase nenhuma está no
      // círculo de 40 tiles do jogador. A caça agora é dirigida, e __pulo só entra quando o
      // mapa inteiro respondeu "nenhum".
      qa.__pulo = () => {
        const W = m.data.tilesW, H = m.data.tilesH;
        for (let tenta = 0; tenta < 400; tenta++) {
          const x = 6 + Math.random() * (W - 12), y = 6 + Math.random() * (H - 12);
          if (m.tileKindAt(x, y) !== 'road') continue;
          if (t.network.stations.some((st) => Math.hypot(st.x - x, st.y - y) < 7)) continue;
          qa.ir(x, y);
          return true;
        }
        return false;
      };
      qa.__saltos = 0;
      qa.__alvo = -1;
      // Quem já foi tentado e não serviu NESTA caça: um asfalto de contorno sem pedestre civ
      // algum dia vai materializar um, e sem esta lista a peneira gira no mesmo ponto morto a
      // cada polling até estourar o tempo da fase.
      qa.__sujo = new Set();
      // Aposenta o corpo no bairro do ônibus. A câmera já foi movida antes desta chamada, e o
      // 'live' é justamente a palavra dela: cobrar vivo depois do ir() é o polling de espera do
      // portão, não uma exigência do asfalto.
      qa.__pega = (i, lugar) => {
        if (!t.units[i].live) { qa.__rejeita('nascendo na cena'); return false; }
        const n = g.npcs.findIndex((q) => !q.dead && !q.inVehicle && q.kind === 'civ'
          && Math.hypot(q.x - g.player.x, q.y - g.player.y) < 26);
        if (n < 0) { qa.__rejeita('sem pedestre civ'); return false; }
        if (!qa.__casa) qa.__casa = { x: g.npcs[n].x, y: g.npcs[n].y };
        qa.__u = i; qa.__npc = n;
        qa.__planta = lugar.planta; qa.__passeio = lugar.passeio;
        qa.__linha = t.network.routes[t.units[i].route].name;
        qa.__reta = +lugar.sobra.toFixed(1);
        return true;
      };
      // A caça escolhe, não aceita o primeiro. Medido na malha, só 8% dos trechos entre duas
      // paradas passam de 13 s, então varrer as unidades por ordem de índice e parar na primeira
      // que passa o portão de tempo quase sempre apanha um ônibus no fim da própria linha: a
      // base mede os três segundos que ainda tinha, e na fase seguinte já não sobra nada — foi o
      // que o censo mostrou (dwell no caminho 19046 rejeições contra 503 latarias). Quem tem de
      // sair da peneira é o ônibus com a maior reta pela frente, e isso só aparece se a varredura
      // inteira antes de mover a câmera.
      qa.__escolhe = () => {
        // O alvo marcado no polling passado é a única coisa que importa agora: a câmera já está
        // onde ele pisa, e o portão só acende no quadro seguinte.
        if (qa.__alvo >= 0) {
          const i = qa.__alvo;
          qa.__alvo = -1;
          const lugar = qa.__plantaPara(i, true, qa.__faltam);
          if (lugar) {
            if (qa.__pega(i, lugar)) return true;
            qa.__sujo.add(i);
            return false;
          }
        }
        let melhor = -1, melhorSobra = -1, melhorLugar = null;
        for (let i = 0; i < t.units.length; i++) {
          if (qa.__sujo.has(i)) continue;
          const lugar = qa.__plantaPara(i, false, qa.__faltam);
          if (!lugar) continue;
          if (lugar.sobra > melhorSobra) { melhor = i; melhorSobra = lugar.sobra; melhorLugar = lugar; }
        }
        if (melhor < 0) {
          qa.__saltos++;
          qa.__pulo();
          return false;
        }
        qa.ir(melhorLugar.corpo.x, melhorLugar.corpo.y);
        if (t.units[melhor].live) {
          if (qa.__pega(melhor, melhorLugar)) return true;
          qa.__sujo.add(melhor);
          return false;
        }
        // A câmera atravessou o mapa até ele; devolve o polling para o portão acender antes de
        // cobrar pedestre, senão a procura iria embora do bairro exatamente onde chegou.
        qa.__alvo = melhor;
        return false;
      };
      qa.__replanta = () => {
        if (qa.__u < 0) return false;
        const lugar = qa.__plantaPara(qa.__u, false, qa.__faltam);
        if (!lugar) return false;
        qa.ir(lugar.corpo.x, lugar.corpo.y);
        return qa.__pega(qa.__u, lugar);
      };
      g.update = (dt) => {
        const n = qa.__npc >= 0 ? g.npcs[qa.__npc] : null;
        if (n && qa.__pin) { n.x = qa.__pin.x; n.y = qa.__pin.y; n.speed = 0; }
        qa.__updateOriginal(dt);
        if (n && qa.__pin) { n.x = qa.__pin.x; n.y = qa.__pin.y; }
        if (qa.__u >= 0) {
          const u = g.transport.units[qa.__u], corpo = g.transport.bodies[qa.__u];
          // A travessa tem duas janelas dentro de uma, e misturá-las foi o falso alarme: o
          // engate (o ônibus vê o corpo, freia, desliza até parar — ~0,8 tile e um bom meio
          // segundo de lataria solta) e a espera (parado, devendo tempo ao horário). Contando
          // as duas juntas, 'segurou o pedestre?' virava 156 de 199 quadros e 'andou 0,83
          // tiles', que é exatamente a física de uma frenagem correta, não um freio frouxo.
          // O relógio da medição liga no PRIMEIRO quadro em que u.held acende, medido na rua em
          // vez de chutado, porque a reação depende da distância que sobrou no plantado.
          if (qa.__engate && u.held) { qa.__engate = false; qa.__zera(); }
          const c = qa.__c;
          if (c) {
            c.tiquetes++;
            if (u.held) c.seguradas++;
            // 'held' é o pedal no chão (aperto acima de FREIO_NO_CHAO); entre ele e a rua aberta
            // o ônibus DOSA, e um corpo a dois centésimos de tile por quadro não é 'held' nenhum
            // — é parado. Cobrar a flag foi o que devolveu 153 de 198 quadros numa travessa em que
            // a lataria andou 0,56 tile e o focinho nunca passou de 1,15: o freio fez o serviço e a
            // régua olhava o nome errado. A grandeza física é a velocidade anunciada no corpo
            // (corpo.speed = cruzeiro * dose), e é ela que para diante de quem atravessa.
            if (corpo && corpo.speed <= 0.2) c.parados++;
            if (u.stopped) c.paradas++;
            c.andou = Math.max(c.andou, Math.hypot(u.x - c.x0, u.y - c.y0));
            if (qa.__pin) {
              c.focinho = Math.min(c.focinho,
                Math.hypot(u.x - qa.__pin.x, u.y - qa.__pin.y) - (corpo ? corpo.meio : 0.625));
            }
            if (n) {
              if (n.health < c.vida) c.vida = n.health;
              if (n.dead || n.downTimer > 0) c.morto++;
            }
          }
        }
      };
      qa.ir(qa.parada.x, qa.parada.y);
      return true;
    })()`);

    const PRAZO_DA_RUA_MS = 300000;
    const inicioDaRua = Date.now();
    /**
     * Roda três segundos de rua com o corpo no lugar pedido e devolve a conta do ônibus medido.
     * `faixa` planta no meio do asfalto, `passeio` planta 1,3 tile para o lado — fora do
     * asfalto, onde a `varreRua` nem olha — e `livre` tira o corpo do mundo sem trocar de ônibus,
     * que é a metade que falta: um freio que não solta é um ônibus que sumiu do horário.
     */
    const fase = async (modo, novo = false) => {
      await evaluate('(() => { qa.__pin = null; qa.__engate = false; return true; })()');
      // A caça é um pedido, não um veredito. Um ônibus pode perder a faixa limpa no exato
      // instante em que a fase começa — ele entrou no próprio dwell, virou uma esquina, parou
      // atrás de um carro — e isso não é "o mundo não dá candidato", é "esta tentativa é suja".
      // O laço de tentativas abaixo já foi escrito para jogar a medição fora e trocar de corpo;
      // o que ele não podia era levar um tempo esgotado que derruba a checagem inteira antes da
      // última régua. Então a espera devolve falso, a fase devolve nulo, e quem decide é o laço.
      const rotulo = novo
        ? 'um ônibus em marcha livre com a faixa da frente limpa para receber o corpo'
        : 'o mesmo ônibus ainda em marcha livre com a faixa da frente limpa';
      // Quantos segundos de marcha livre ainda faltam PARA ESTA fase. A base é a única que pede
      // a reta inteira (15 s): ela escolhe o ônibus, e as três fases seguintes são medidas nele,
      // cada uma com o próprio relógio. Cobrar 15/12/9/5 somados na largada foi o erro que matou
      // a peneira — o ônibus da base queimava os três segundos dela, o polling da fase seguinte
      // queimava mais dois, e o portão de 12 s não deixava nem recomeçar. O que importa é que a
      // janela medida não termine dentro do guichê, e janela é 3 s (4,8 s na travessa, que tem
      // screenshot no meio), com um dedo de folga.
      const orcamento = { base: 15, passeio: 5, faixa: 9, livre: 5 }[novo ? 'base' : modo];
      await evaluate('(() => { qa.__faltam = ' + orcamento
        + '; qa.__sujo = new Set(); qa.__alvo = -1; qa.__primeiro = null; return true; })()');
      // Na fase seguinte o ônibus pode ter entrado no próprio dwell entre uma medição e outra, e
      // isso não é defeito nenhum: as quatro fases medem o MESMO corpo, não uma marcha contínua.
      // Então a espera aqui é longa de propósito — o veículo encosta, parado no guichê a lataria
      // some da faixa medida e ele volta a andar; os 35 s são o dwell urbano mais uma esquina, e
      // estourar esse teto é o que manda trocar de ônibus.
      // O teto é de relógio de parede, não de tentativas: cinco voltas de caça dirigida sobre
      // 180 ônibus com três esperas de 35 s cada passava dos dez minutos e derrubava o run
      // inteiro por fora. A conta é a da seção: quem decide parar é o tempo gasto, e a última
      // tentativa tem direito à fração que sobrou.
      const sobra = Math.max(0, PRAZO_DA_RUA_MS - (Date.now() - inicioDaRua));
      const achou = await until(novo ? 'qa.__escolhe()' : 'qa.__replanta()', rotulo,
        Math.max(4000, Math.min(novo ? 90000 : 35000, sobra))).then(() => true, () => false);
      if (!achou) {
        // "não houve ônibus" sem dizer qual portão fechou é uma reclamação incompleta: a frota
        // parada no dwell, a marcha segurada por lataria, o asfalto de estrada sem pedestre e a
        // faixa com carro são cinco mundos diferentes, e só um deles é defeito de produto.
        const censo = await evaluate('(() => { const t = qa.g.transport.units; return {'
          + ' motivos: qa.__motivos || {}, primeiro: qa.__primeiro || null,'
          + ' saltos: qa.__saltos || 0, vivas: t.filter((u) => u.live).length,'
          + ' andáveis: t.filter((u) => u.live && !u.stopped && !u.held).length,'
          + ' paradas: t.filter((u) => u.stopped).length, seguradas: t.filter((u) => u.held).length }; })()');
        const ordem = Object.entries(censo.motivos).sort((a, b) => b[1] - a[1]);
        console.log(`  peneira sem candidato (${rotulo}): ${censo.vivas} unidades na cena, `
          + `${censo.andáveis} delas em marcha, ${censo.paradas} paradas no horário e `
          + `${censo.seguradas} seguradas por lataria · ${censo.saltos} pulos de câmera · `
          + `portões: ${ordem.map(([k, v]) => `${k} ${v}`).join(', ') || 'nenhum'}`
          + ` · fechou primeiro: ${censo.primeiro || 'nenhum'}`);
        return null;
      }
      const pronto = await evaluate(`(() => {
        qa.__pin = ${modo === 'livre' ? 'null' : modo === 'faixa' ? 'qa.__planta' : 'qa.__passeio'};
        qa.__engate = ${modo === 'faixa'};
        return qa.__zera();
      })()`);
      if (!pronto) return null;
      await delay(modo === 'faixa' ? 2200 : 3000);
      // A foto é no meio da travessa: o número diz que o relógio parou, o pixel diz que o
      // pedestre continua de pé na frente da lataria.
      if (modo === 'faixa') await screenshot('qa-rua-freio');
      await delay(modo === 'faixa' ? 800 : 0);
      return evaluate(`(() => {
        const g = qa.g, u = g.transport.units[qa.__u], c = qa.__c;
        return { tiquetes: c.tiquetes, seguradas: c.seguradas, parados: c.parados,
          paradas: c.paradas,
          andou: +c.andou.toFixed(2),
          tilesPorSegundo: +(c.andou / Math.max(0.1, c.tiquetes / 60)).toFixed(2),
          focinho: c.focinho === Infinity ? null : +c.focinho.toFixed(2),
          atraso: +(u.atraso - c.atraso0).toFixed(2),
          paradoPorQuadro: +(c.parados / Math.max(1, c.tiquetes)).toFixed(2),
          seguradoPorQuadro: +(c.seguradas / Math.max(1, c.tiquetes)).toFixed(2),
          vida: c.vida === Infinity ? null : c.vida, morto: c.morto, linha: qa.__linha,
          reta: qa.__reta, u: qa.__u, plantado: qa.__pin };
      })()`);
    };

    // Quatro fases sobre o MESMO ônibus: a rua sem corpo (a régua), o corpo no passeio (o
    // contraprova), o corpo na faixa (a reclamação do jogador) e a faixa aberta de novo (o
    // horário volta). Se o dwell do horário entrar em qualquer uma delas, a tentativa é jogada
    // fora e o ônibus é outro — parado por guichê não se pode medir parado por pedestre.
    let base = null, passeio = null, faixa = null, livre = null;
    for (let tentativa = 0; tentativa < 5 && !(base && passeio && faixa && livre)
      && Date.now() - inicioDaRua < PRAZO_DA_RUA_MS; tentativa++) {
      await evaluate('(() => { qa.__motivos = {}; return true; })()');
      base = await fase('livre', true);
      passeio = base && await fase('passeio');
      faixa = passeio && await fase('faixa');
      livre = faixa && await fase('livre');
      // Uma tentativa é suja por duas metades: o dwell entrou na janela (paradas), ou a janela
      // não mediu marcha nenhuma porque uma lataria de carro segurou o ônibus antes de qualquer
      // pedestre existir. A segunda metade faltava, e ela aparecia na régua: base #31 com 150 de
      // 184 quadros segurados e 0,93 tiles andados é um ônibus parado atrás de um carro, não o
      // "asfalto sem corpo" que a régua compara — as três janelas de contraste (base, passeio,
      // livre) têm de mostrar marcha, e só a travessa tem permissão de mostrar lataria presa.
      const presa = (m) => !!m && m.parados > m.tiquetes * 0.4;
      const suja = [base, passeio, faixa, livre].some((m) => !m || m.paradas > 6 || m.tiquetes < 40)
        || presa(base) || presa(passeio) || presa(livre);
      if (suja) {
        // A outra metade da mesma pergunta: se houve candidato mas a medição foi jogada fora, o
        // que entrou nela foi o dwell do horário ou o freio de lataria?
        const nomes = ['base', 'passeio', 'faixa', 'livre'];
        console.log(`  tentativa ${tentativa + 1} suja: `
          + [base, passeio, faixa, livre].map((m, k) => `${nomes[k]}=${m ? `#${m.u} com ${m.reta}s `
            + `de reta, ${m.parados}/${m.tiquetes} parados (${m.seguradas} com pedal no chão), `
            + `${m.paradas} paradas de horário, ${m.andou} tiles andados` : 'sem fase'}`).join(' · '));
        base = passeio = faixa = livre = null;
      }
    }
    // "não houve ônibus" e "houve ônibus, mas ele não aguentou as quatro fases" são duas
    // reclamações diferentes, e a segunda já foi confundida com a primeira: a peneira estava
    // certa e a câmera é que nunca saía da parada. O número de pulos diz se a caça rodou; o
    // total de leituras diz se havia marcha suficiente no mapa naquele instante.
    const busca = await evaluate('(() => { const t = qa.g.transport; '
      + 'const reta = (u) => { const r = t.network.routes[u.route]; '
      + 'return (r.table[u.pass + 1] || { time: r.cycle }).time - u.phase; }; '
      + 'return { saltos: globalThis.qa.__saltos || 0, motivos: globalThis.qa.__motivos || {}, '
      + 'vivas: t.units.filter((u) => u.live).length, unidades: t.units.length, '
      + 'melhorReta: +Math.max.apply(null, t.units.filter((u) => !u.stopped && !u.held).map(reta)).toFixed(1) }; })()');

    check(!!(base && passeio && faixa && livre),
      'a rua não deu um ônibus para medir: em cinco tentativas não houve unidade em marcha livre, '
      + 'com asfalto e passeio sob o corpo, a faixa limpa por oito tiles e 15 s de reta pela '
      + `frente (a caça pulou a câmera por ${busca.saltos} vez(es) sobre ${busca.unidades} `
      + 'ônibus, e a maior reta livre que existia no mapa naquele instante era de '
      + `${busca.melhorReta} s — pulo zero é peneira quebrada, muitos pulos é a marcha que não `
      + 'dura as quatro fases)');
    const portoes = Object.entries(busca.motivos).sort((a, b) => b[1] - a[1]);
    console.log('  portões da última tentativa: '
      + portoes.map(([k, v]) => `${k} ${v}`).join(', '));

    if (base && passeio && faixa && livre) {
      check(base.paradoPorQuadro < 0.5 && base.andou > 3,
        `sem corpo na rua o ônibus ${base.u} da ${base.linha} não era um corpo em marcha: `
        + `${base.parados} de ${base.tiquetes} quadros parado e ${base.andou} tiles percorridos`);
      check(faixa.paradoPorQuadro >= 0.8,
        `o pedestre plantado na faixa não prendeu o ônibus ${faixa.u} da ${faixa.linha}: ele foi `
        + `estável em apenas ${faixa.parados} de ${faixa.tiquetes} quadros depois que o freio `
        + `engatou (${faixa.paradoPorQuadro}; ${faixa.seguradas} quadros com o pedal no chão) — `
        + 'a varredura do asfalto não chegou ao freio no jogo real');
      // O teto é uma CADÊNCIA, não uma distância. Cobrar 'andou < 0,6 tile' da janela inteira
      // ignorava o desenho do próprio freio: abaixo de um décimo da marcha o pedal vai ao chão, e
      // até lá a cauda da rampa aproxima o corpo da linha de parada sem nunca encostar nela — a
      // régua achou 0,68 tile num ônibus que passou 163 de 202 quadros a velocidade zero e parou
      // com o focinho a 1,16 tile do pedestre. Isso é a frenagem assentando, não o relógio
      // andando. O que importa é que a marcha dele caia a uma fração do cruzeiro (2,15 tiles/s)
      // enquanto o corpo está na faixa, e a régua de segurança é o focinho, cobrado logo abaixo.
      check(faixa.tilesPorSegundo < 0.4,
        `com o freio já engatado, o ônibus ${faixa.u} seguiu a ${faixa.tilesPorSegundo} tiles por `
        + `segundo (${faixa.andou} tiles em ${faixa.tiquetes} quadros, ${faixa.parados} deles `
        + `parados), contra ${base.tilesPorSegundo} da rua vazia: o relógio não parou, só `
        + 'desacelerou');
      check(faixa.focinho > 0.3,
        `o focinho do ônibus passou a ${faixa.focinho} tiles do corpo plantado na faixa: lataria `
        + 'em cima de quem atravessa, que é exatamente o "eles atravessam pedestres" da tela');
      check(faixa.atraso > 1,
        `o pedestre na faixa não custou tempo nenhum ao horário: ${(faixa.atraso).toFixed(2)}s de `
        + `atraso ganho em três segundos, contra ${(base.atraso).toFixed(2)}s com a rua vazia`);
      check(passeio.paradoPorQuadro < 0.5 && passeio.andou > 3 && passeio.atraso < 0.5,
        `o pedestre do passeio prendeu o ônibus ${passeio.u}: ${passeio.parados} de `
        + `${passeio.tiquetes} quadros parados, ${passeio.andou} tiles andados e `
        + `${passeio.atraso}s de atraso — a faixa está mais larga que a lataria`);
      check(passeio.focinho > 0.3,
        `a lataria passou por cima do pedestre do passeio (${passeio.focinho} tiles do focinho ao `
        + 'corpo): a varredura leu a calçada como se fosse a faixa');
      // A volta da faixa cobra RECOMPOSIÇÃO, não o saldo do relógio. Cobrar 'atraso < -0,5' em
      // três segundos foi o falso alarme seguinte: o ônibus larga a travessa PARADO, gasta ~1 s
      // reacelerando, e a devolução de atraso tem a porta fechada por contrato enquanto houver
      // lataria dentro da própria linha de parada (TransportSystem: a recuperação só volta 'quando
      // a rua abriu de verdade', para não serrar no encosto). Num mapa com 109 ônibus e trânsito
      // vivo, a janela de 3 s cai justo nesse encosto e o saldo sobe por culpa da fila, não do
      // pedestre. O que a travessa promete, e o que esta régua mede, é a cadência da dívida: sem o
      // corpo no asfalto o ônibus volta a andar e para de pagar o preço cheio de quem atravessa.
      // A devolução em si é a metade determinística, cobrada quadro a quadro no espelho da rua do
      // 'check-transport'.
      check(livre.paradoPorQuadro < 0.5 && livre.andou > 2,
        `aberta a faixa, o ônibus ${livre.u} continuou de pé: ${livre.parados} de `
        + `${livre.tiquetes} quadros parados e ${livre.andou} tiles andados — o freio não solta `
        + 'nem com o asfalto vazio, que é o ônibus sumido do horário');
      check(livre.atraso < faixa.atraso,
        `tirado o pedestre, o ônibus ${livre.u} passou a sangrar horário MAIS rápido que com a `
        + `faixa ocupada: ${livre.atraso}s em três segundos contra ${faixa.atraso}s da travessa `
        + `(${livre.paradoPorQuadro} de quadros andandos) — a dívida não é da lataria na faixa`);
      check(faixa.morto === 0 && passeio.morto === 0,
        `o corpo plantado foi atropelado (${faixa.morto} + ${passeio.morto} quadros caído/morto, `
        + `saúde ${faixa.vida}): o freio não protegeu quem estava na faixa`);
      console.log(`  rua no navegador: ônibus ${faixa.u} da ${faixa.linha} com ${base.reta} s de `
        + `reta na largada · sem corpo `
        + `${base.parados}/${base.tiquetes} quadros parados e ${base.andou} tiles · passeio `
        + `${passeio.parados} e ${passeio.andou} tiles (focinho ${passeio.focinho}) · faixa `
        + `${faixa.parados} parados e ${faixa.andou} tiles a ${faixa.tilesPorSegundo} tile/s `
        + `(+${faixa.atraso}s de atraso, focinho `
        + `${faixa.focinho}) · faixa aberta ${livre.andou} tiles e ${livre.atraso}s de dívida`);
    }

    await evaluate(`(() => {
      const g = qa.g;
      g.update = qa.__updateOriginal;
      if (qa.__casa && qa.__npc >= 0 && g.npcs[qa.__npc]) {
        g.npcs[qa.__npc].x = qa.__casa.x; g.npcs[qa.__npc].y = qa.__casa.y;
      }
      qa.__pin = null; qa.__c = null; qa.__u = -1; qa.__npc = -1;
      return true;
    })()`);
  }

  // 10) A rota do ônibus a bordo pintada no mapa. A pergunta do jogador é literal — "se estou
  // dentro do ônibus, conseguir ver no mapa a rota que aquele ônibus vai fazer" — e a régua é a
  // do §5, só que com outra alavanca: a rua é congelada, o enquadramento é o mesmo, e o que se
  // desliga é o ASSENTO. Com o busUnit no banco, o MiniMap desenha a polilinha fechada da linha
  // (ida e volta) na cor da viação; com o banco vazio, na mesma cena, ela não existe. Medido no
  // radar e no mapa cheio, porque o jogador olha os dois. O terceiro quadro — banco de volta no
  // lugar — é o que prova que a diferença foi causada pela alavanca e não por um pixel que se
  // regravou sozinho.
  {
    await evaluate(`(() => {
      const g = qa.g, p = g.player;
      if (g.interiors.active) g.interiors.leave(p);
      p.busUnit = null; p.state = 'idle'; p.currentVehicleId = null; p.swimming = false;
      p.health = 100; p.invulnUntil = Infinity;
      g.weather.force('clear', 3600);
      g.dayNight.t = 0.5;
      // O GPS fora da cena: a rota do destino e a linha do ônibus têm traço e espessura
      // parecidos desenhados no mesmo canvas, e a régua de pixels só vale se uma das duas
      // estiver desligada — aqui é o pino, que a alavanca do assento não alcança.
      qa.store.clearMapMarker();
      g.notifyEntityChange();
      qa.ir(qa.parada.x, qa.parada.y);
      return true;
    })()`);
    await delay(500);
    const encostou = await until('(() => {const g = qa.g; return g.transport.boarding(g.player) !== null;})()',
      'um ônibus da estação mais movimentada encostar para a foto do mapa', 120000)
      .then(() => true, () => false);
    check(encostou, 'a estação mais movimentada deu um ônibus encostado na calçada para a foto do mapa');
    const bordo = encostou && await evaluate(`(() => {
      const g = qa.g, t = g.transport, p = g.player;
      const i = t.boarding(p);
      if (i === null) return null;
      t.board(p, i);
      g.notifyEntityChange();
      const u = t.aboard(p), r = t.network.routes[u.route];
      const empresa = t.network.companies[r.company] || {};
      return { assento: p.busUnit, viva: u.live, encostado: u.stopped, linha: r.name,
        viação: empresa.name || null, sigla: empresa.code || null, tinta: empresa.livery,
        ida: r.points.length, volta: r.back.length,
        pino: qa.store.getState().mapMarker, gps: qa.store.getState().mapRoute.length };
    })()`);
    check(!!bordo && !!bordo.tinta && bordo.pino === null && bordo.gps === 0,
      bordo ? `a bordo da ${bordo.linha} da ${bordo.viação} (${bordo.tinta}), com ${bordo.ida} + `
        + `${bordo.volta} pontos de itinerário e o GPS da cena limpo (pino ${JSON.stringify(bordo.pino)}, `
        + `rota ${bordo.gps} pontos)` : 'nenhum ônibus coube no embarque da foto do mapa');

    if (bordo && bordo.tinta) {
      await delay(500);
      await evaluate('(() => {qa.__rua10 = qa.g.update; qa.g.update = () => {}; return true;})()');
      await delay(1400);
      const radar = await rectDe('minimap');
      const lado = Math.min(radar.w, radar.h);
      const caixa = { x0: radar.x0, y0: radar.y0, x1: radar.x0 + lado, y1: radar.y0 + lado };
      const rgb = rgbDe(bordo.tinta);
      const fora = '(() => {const p = qa.g.player; qa.__banco10 = p.busUnit; p.busUnit = null;'
        + ' qa.g.notifyEntityChange(); return true;})()';
      const dentro = '(() => {const p = qa.g.player, g = qa.g; p.busUnit = qa.__banco10;'
        + ' p.state = "driving"; g.notifyEntityChange(); return true;})()';

      // 10a) O radar — o instrumento que está na tela o tempo todo.
      const com = await screenshot('qa-mapa-rota-a-bordo');
      await evaluate(fora);
      await delay(1400);
      const sem = await screenshot('qa-mapa-rota-sem-bordo');
      await evaluate(dentro);
      await delay(1400);
      const devolta = await screenshot('qa-mapa-rota-de-volta');
      const mudou = naCaixa(com, sem, caixa.x0, caixa.y0, caixa.x1, caixa.y1);
      const voltou = naCaixa(com, devolta, caixa.x0, caixa.y0, caixa.x1, caixa.y1);
      const tintaCom = tintaEm(com, caixa, rgb);
      const tintaSem = tintaEm(sem, caixa, rgb);
      check(mudou >= 120,
        `a rota da ${bordo.linha} pinta no radar: tirar o assento apagou ${mudou} pixels na caixa `
        + `${lado.toFixed(0)}x${lado.toFixed(0)} do painel, e o quadro voltou a ${voltou} pixels `
        + `diferentes ao sentar de novo (tinta ${tintaCom} px da ${bordo.tinta} a bordo contra `
        + `${tintaSem} com o banco vazio)`);
      check(voltou <= Math.max(60, mudou * 0.08),
        `o radar voltou ao quadro original quando o assento voltou: ${voltou} pixels de diferença `
        + `contra ${mudou} que a alavanca apagou — a camada é do assento, não de um quadro que se `
        + 'regravou sozinho');
      check(tintaCom - tintaSem >= mudou * 0.25,
        `o que apareceu no radar é a cor da viação: ${tintaCom - tintaSem} pixels na ${bordo.tinta} `
        + `da ${bordo.viação} contra ${mudou} pixels de mudança total`);

      // 10b) O mapa cheio — onde o jogador abre a cidade inteira para ler o itinerário. O retângulo
      // medido é o miolo do painel: o mapa cobre a janela toda, e as ferramentas e o fechar vivem
      // nas bordas, onde a HUD também troca de painel quando o assento muda.
      const botao = await rectDe('hud-map');
      await tapPoint({ x: (botao.x0 + botao.x1) / 2, y: (botao.y0 + botao.y1) / 2 });
      const abriu = await until('!!document.querySelector("[data-testid=full-map]")',
        'o mapa cheio abrir com o jogador a bordo', 40000).then(() => true, () => false);
      check(abriu, 'o toque no botão do HUD abriu o mapa cheio com o jogador a bordo do ônibus');
      if (abriu) {
        await delay(1600);
        const tela = await rectDe('full-map-surface');
        const miolo = { x0: tela.x0 + tela.w * 0.22, x1: tela.x0 + tela.w * 0.78,
          y0: tela.y0 + tela.h * 0.16, y1: tela.y0 + tela.h * 0.84 };
        const mapA = await screenshot('qa-mapa-cheio-a-bordo');
        await evaluate(fora);
        await delay(1600);
        const mapB = await screenshot('qa-mapa-cheio-sem-bordo');
        await evaluate(dentro);
        await delay(1600);
        const mapC = await screenshot('qa-mapa-cheio-de-volta');
        const cheio = naCaixa(mapA, mapB, miolo.x0, miolo.y0, miolo.x1, miolo.y1);
        const voltouCheio = naCaixa(mapA, mapC, miolo.x0, miolo.y0, miolo.x1, miolo.y1);
        const tintaCheia = tintaEm(mapA, miolo, rgb) - tintaEm(mapB, miolo, rgb);
        check(cheio >= 300,
          `no mapa cheio a linha ${bordo.linha} deixa ${cheio} pixels de itinerário no miolo do `
          + `painel (${(miolo.x1 - miolo.x0).toFixed(0)}x${(miolo.y1 - miolo.y0).toFixed(0)}) contra `
          + `${voltouCheio} ao sentar de novo, e ${tintaCheia} deles na ${bordo.tinta} da `
          + `${bordo.viação}`);
        check(voltouCheio <= Math.max(80, cheio * 0.08),
          `o mapa cheio voltou ao mesmo quadro com o mesmo assento: ${voltouCheio} pixels de `
          + `diferença contra ${cheio} da alavanca`);
        const fechar = await rectDe('full-map-close');
        await tapPoint({ x: (fechar.x0 + fechar.x1) / 2, y: (fechar.y0 + fechar.y1) / 2 });
        await until('!document.querySelector("[data-testid=full-map]")', 'o mapa cheio fechar',
          30000).then(() => true, () => false);
      }
      await evaluate('(() => { if (qa.__rua10) { qa.g.update = qa.__rua10; delete qa.__rua10; }'
        + ' return true;})()');
      console.log(`  mapa no navegador: ${bordo.linha} (${bordo.viação} ${bordo.sigla}, ${bordo.tinta}) `
        + `a bordo do assento #${bordo.assento} · radar ${mudou} pixels que somem com o banco vazio `
        + `e voltam ${voltou} · tinta ${tintaCom}/${tintaSem} · mapa cheio `
        + `${bordo.ida}+${bordo.volta} pontos`);
    }
  }

  // 11) A lataria do ônibus é sólida para quem anda a pé. O check offline cobra a caixa nos quatro
  // rumos e o empurrão do resolveCircleVsBuses; aqui o que se mede é o jogo real — o corpo que o
  // horário move, o separate() do GameState e o joystick do jogador. Duas metades: teleportar o
  // pedestre PARA DENTRO de um ônibus encostado e cronometrar o expurgo (se a lataria fosse de
  // fumaça, ele continuaria lá), e empurrar esse mesmo pedestre contra ela (se ele atravessasse,
  // o "posso atravessar o ônibus" do jogador estaria certo). A leitura é quadro a quadro, com a
  // caixa medida ANTES e DEPOIS do update: sem o antes, o expurgo já teria acontecido dentro do
  // mesmo tick e a régua juraria que o corpo nunca esteve em cima da lataria.
  {
    await evaluate(`(() => {
      const g = qa.g, p = g.player;
      if (g.interiors.active) g.interiors.leave(p);
      p.busUnit = null; p.state = 'idle'; p.currentVehicleId = null; p.swimming = false;
      p.health = 100; p.invulnUntil = Infinity; p.jumpTimer = 0; p.jumpEnd = null;
      g.notifyEntityChange();
      qa.ir(qa.parada.x, qa.parada.y);
      if (!qa.__updateOriginal) qa.__updateOriginal = g.update.bind(g);
      // A caixa é a mesma régua do streetBodyCollider: meio no eixo comprido, flanco no curto.
      // Ela é copiada aqui porque o fonte de página não importa módulo nenhum — é a única forma
      // de medir a lataria sem chamar por dentro do sistema.
      qa.__caixa = (b) => {
        const ao = b.dir === 'SE' || b.dir === 'NW';
        const w = ao ? b.meio * 2 : b.flanco * 2, h = ao ? b.flanco * 2 : b.meio * 2;
        return { x0: b.x - w / 2, x1: b.x + w / 2, y0: b.y - h / 2, y1: b.y + h / 2, w: w, h: h };
      };
      qa.__aCaixa = (x, y, c) => Math.hypot(x - Math.max(c.x0, Math.min(x, c.x1)),
        y - Math.max(c.y0, Math.min(y, c.y1)));
      qa.__p = -1;
      qa.__R = null;
      qa.__mede = () => {
        const g2 = qa.g, i = qa.__p;
        if (i < 0 || !qa.__R) return null;
        const b = g2.transport.bodies[i], p2 = g2.player;
        // O corpo saiu da cena (o portão de streaming desligou a linha): o tick não é lido, não é
        // "o pedestre escapou". Contar isso como livre seria a régua aprovando um vazio.
        if (!b || !b.live) return null;
        const c = qa.__caixa(b), raio = qa.cfg.PLAYER_RADIUS;
        const d = qa.__aCaixa(p2.x, p2.y, c);
        return { dentro: d < raio, folga: +(d - raio).toFixed(3),
          px: +p2.x.toFixed(3), py: +p2.y.toFixed(3), bx: +b.x.toFixed(3), by: +b.y.toFixed(3),
          corpo: +b.speed.toFixed(2), estado: p2.state, saude: p2.health };
      };
      g.update = (dt) => {
        const antes = qa.__mede();
        qa.__updateOriginal(dt);
        const depois = qa.__mede();
        const r = qa.__R;
        if (!r || !antes || !depois) return;
        r.tiques++;
        // O ANTES é o que dá valor ao DEPOIS: no tick seguinte ao plantio o corpo ainda está no
        // centro da caixa, porque nada o moveu desde o teletransporte. Sem essa metade, o expurgo
        // aconteceria dentro do mesmo tick e a régua leria "nunca esteve em cima do ônibus".
        if (antes.dentro) {
          r.antesDentro++;
          if (r.primeiroDentroEm === null) r.primeiroDentroEm = r.tiques;
        }
        if (depois.dentro) r.presos++;
        else if (r.livreEm === null) r.livreEm = r.tiques;
        r.maisPerto = Math.min(r.maisPerto, depois.folga);
        r.folgaFinal = depois.folga;
        r.deslocado = Math.max(r.deslocado, Math.hypot(depois.px - r.x0, depois.py - r.y0));
        r.ultima = depois;
      };
      return true;
    })()`);

    // O corpo da medida é um ônibus PARADO na calçada com tempo de sobra antes de ir embora: um
    // que arranca no meio da janela leva a caixa embora com ele, e o pedestre que a lataria
    // empurrou passaria a ser perseguido por um veículo que já virou horário de outra esquina.
    const alvo = await until(`(() => {
      const g = qa.g, t = g.transport;
      const acha = () => {
        for (let i = 0; i < t.units.length; i++) {
          const u = t.units[i], b = t.bodies[i];
          if (!u.live || !u.stopped || u.parked || b.speed > 0.01) continue;
          if (Math.hypot(u.x - b.x, u.y - b.y) > 0.01) continue;
          const rota = t.network.routes[u.route];
          const proxima = (rota.table[u.pass + 1] || { time: rota.cycle }).time;
          if (proxima - u.phase < 20) continue;
          if (Math.hypot(u.x - g.player.x, u.y - g.player.y) > 26) continue;
          return { i, linha: rota.name, x: +b.x.toFixed(2), y: +b.y.toFixed(2), dir: b.dir,
            meio: b.meio, flanco: b.flanco, dwell: +(proxima - u.phase).toFixed(1),
            raio: +qa.cfg.PLAYER_RADIUS.toFixed(3) };
        }
        return null;
      };
      const a = acha();
      if (a) { qa.__p = a.i; qa.__alvo = a; }
      return !!a;
    })()`, 'um ônibus encostado com 20 s de calçada pela frente', 90000).then(() => true, () => false);
    const corpo = alvo && await evaluate('qa.__alvo');
    check(alvo && !!corpo, alvo
      ? `a rua deu um ônibus parado para medir a lataria: #${corpo.i} da ${corpo.linha}, `
        + `${corpo.meio.toFixed(3)} x ${corpo.flanco.toFixed(3)} de meia-lataria, ${corpo.dwell}s `
        + 'de calçada pela frente'
      : 'nenhum ônibus encostado e vivo apareceu na cena para a régua da lataria');

    if (corpo) {
      // 11a) Dentro da lataria: o pedestre é plantado no centro exato do corpo e o jogo tem de
      // cuspi-lo para fora. O relógio é em ticks do update, não em milissegundos do teste.
      await evaluate(`(() => {
        const g = qa.g, b = g.transport.bodies[qa.__p], p = g.player;
        p.x = b.x; p.y = b.y;
        qa.__R = { tiques: 0, antesDentro: 0, primeiroDentroEm: null, presos: 0, livreEm: null,
          maisPerto: Infinity, folgaFinal: null, ultima: null, x0: p.x, y0: p.y, deslocado: 0 };
        g.notifyEntityChange();
        return true;
      })()`);
      const expulso = await until('(() => {const r = qa.__R; return r && r.antesDentro > 0 '
        + '&& r.livreEm !== null && r.tiques > r.livreEm + 39;})()',
        'a lataria cuspir o pedestre para fora e segurá-lo fora por 40 quadros', 30000)
        .then(() => true, () => false);
      const A = await evaluate('(() => {const r = qa.__R; qa.__R = null; return r;})()');
      check(!!A && expulso && A.primeiroDentroEm !== null && A.livreEm !== null
        && A.presos <= A.livreEm,
        A ? `plantado no centro do ônibus #${corpo.i}, o corpo estava dentro da lataria no quadro `
          + `${A.primeiroDentroEm} e a rua o devolveu para fora no quadro ${A.livreEm} `
          + `(${A.presos} quadro(s) em cima da caixa em ${A.tiques} lidos, ${A.tiques - (A.livreEm || 0)} `
          + `depois deles já livres), parado em [${A.ultima && A.ultima.px}, ${A.ultima && A.ultima.py}] `
          + `com ${A.folgaFinal} tile de folga fora da caixa e o corpo a ${A.ultima && A.ultima.corpo} `
          + `tile/s — ${A.ultima && A.ultima.saude} de saúde, estado ${A.ultima && A.ultima.estado}`
        : 'a régua da lataria não chegou a ler quadro nenhum');
      check(!!A && A.folgaFinal >= -0.02 && A.folgaFinal <= 0.6,
        A ? `o expurgo pôs o pedestre na pele do ônibus, não do outro lado da rua: sobrou `
          + `${A.folgaFinal} tile entre a borda da caixa e a borda do corpo, numa lataria de `
          + `${(corpo.meio * 2).toFixed(3)} x ${(corpo.flanco * 2).toFixed(3)} tiles e corpo de `
          + `raio ${corpo.raio}` : 'sem leitura do expurgo');

      // 11b) O empurrão: de onde a lataria o cuspiu, o jogador anda contra ela por três segundos.
      // O ponto de partida não é escolhido à toa — é a própria pele do ônibus, o lugar onde o
      // expurgo deixou o corpo, e por isso é garantido transitável e livre de outra lataria.
      const B = await evaluate(`(() => {
        const g = qa.g, p = g.player;
        qa.__R = { tiques: 0, antesDentro: 0, primeiroDentroEm: null, presos: 0, livreEm: null,
          maisPerto: Infinity, folgaFinal: null, ultima: null, x0: p.x, y0: p.y, deslocado: 0 };
        qa.__dedos = [];
        // O joystick é lido em tela, não em mundo: o mesmo vetor (dx,dy) de mundo que o
        // MovementSystem converte por screenToWorld é o que tem de sair aqui, ou o corpo andaria
        // para o lado errado e a régua cobraria de um pedestre que nunca empurrou nada.
        qa.__anda = () => {
          const bb = g.transport.bodies[qa.__p];
          if (!bb) return;
          const dx = bb.x - p.x, dy = bb.y - p.y;
          const l = Math.hypot(dx, dy) || 1;
          const wx = dx / l, wy = dy / l;
          const sx = (wx - wy) * 2, sy = wx + wy;
          const m = Math.hypot(sx, sy) || 1;
          qa.inp.setJoystickInput(1, sx / m, sy / m);
        };
        qa.__anda();
        qa.__dedost = setInterval(() => { qa.__dedos.push(+qa.inp.inputState.magnitude.toFixed(2)); }, 120);
        qa.__andost = setInterval(qa.__anda, 90);
        return { x: +p.x.toFixed(3), y: +p.y.toFixed(3) };
      })()`);
      await delay(3200);
      await evaluate('(() => {clearInterval(qa.__andost); clearInterval(qa.__dedost);'
        + ' qa.inp.setJoystickInput(0, 0, 0); return true;})()');
      const emp = await evaluate('(() => {const r = qa.__R; qa.__R = null;'
        + ' return { r, dedos: qa.__dedos };})()');
      const vivo = (emp.dedos || []).filter((m) => m > 0.5).length;
      check(!!emp.r && emp.r.presos === 0 && emp.r.antesDentro === 0 && vivo >= 3
        && emp.r.maisPerto <= 0.25 && emp.r.tiques >= 40,
        `empurrado com o joystick no fim do curso (${vivo} de ${(emp.dedos || []).length} amostras) `
        + `contra a lataria do ônibus #${corpo.i} por ${emp.r ? emp.r.tiques : 0} quadros de rua, o `
        + `pedestre nunca esteve em cima da caixa: ${emp.r ? emp.r.presos : '-'} quadro(s) dentro, `
        + `encostado a ${emp.r && Number.isFinite(emp.r.maisPerto) ? emp.r.maisPerto.toFixed(3) : 'nada'} `
        + `tile da borda, ${emp.r ? emp.r.deslocado.toFixed(2) : '-'} tile(s) de deslocamento a partir `
        + `do ponto onde o expurgo o deixou [${B.x}, ${B.y}]`);
      console.log(`  lataria no navegador: ônibus #${corpo.i} da ${corpo.linha} (${corpo.dir}, `
        + `${(corpo.meio * 2).toFixed(3)}x${(corpo.flanco * 2).toFixed(3)} tiles, `
        + `${corpo.dwell}s de calçada) · expulso no quadro ${A && A.livreEm} com `
        + `${A && A.presos} quadro(s) dentro · empurrão: ${emp.r && emp.r.presos} dentro, pele a `
        + `${emp.r && Number.isFinite(emp.r.maisPerto) ? emp.r.maisPerto.toFixed(3) : 'nada'}, `
        + `dedo vivo ${vivo}/${(emp.dedos || []).length}`);
    }
    await evaluate('(() => { const g = qa.g; qa.inp.setJoystickInput(0, 0, 0);'
      + ' g.update = qa.__updateOriginal; qa.__p = -1; qa.__R = null; return true;})()');
  }

  // 12) O ônibus obedece a luz no jogo real. O §15 do check-transport mediu a obediência com o
  // semáforo PRETO no vermelho, porque a régua precisava de uma única parede; aqui o ciclo de 25
  // segundos roda de verdade e o portão de streaming decide quem existe. A régua é geométrica e
  // quadro a quadro: para cada corpo vivo, a boca do cruzamento no eixo dele, a luz dessa boca, a
  // folga até a linha de parada e a velocidade realizada no asfalto. Três metades têm de aparecer
  // juntas, e a falta de qualquer uma delas muda o veredito: ninguém cruza a linha no vermelho,
  // alguém para diante dela sem lataria nenhuma à frente — a luz é a única parede — e esse mesmo
  // ônibus entra na boca quando o verde chega. Sem a terceira, "0 invasões" seria provado por um
  // trânsito que virou estacionamento.
  {
    const fiação = await evaluate('(() => {const g = qa.g;'
      + ' return { igual: g.transport.signals === g.trafficSystem.signalSystem,'
      + ' posto: !!g.transport.signals,'
      + ' controlados: g.trafficSystem.signalSystem.signals.filter((s) => s.controlled).length };})()');
    check(fiação.posto && fiação.igual && fiação.controlados > 0,
      `o horário dirige com os postes do trânsito, não com uma cópia: `
      + `${fiação.controlados} cruzamentos controlados e transport.signals === `
      + `trafficSystem.signalSystem é ${fiação.igual}`);

    // A boca não é sorteada: é a que segura mais trechos de rota correndo para dentro dela, pelo
    // eixo que corre para dentro. A mesma régua do §15, agora sobre a malha do mapa carregado —
    // o peso de 0,6 na boca do x é preferência declarada, não veto, porque na boca do y a mesma
    // passagem prova também o pedido de vez (demandY) que o ônibus faz.
    const olhos = await evaluate(`(() => {
      const g = qa.g, t = g.transport, sig = t.signals;
      const OLHADA = 7;
      const passosNaBoca = (posto, noX) => {
        let n = 0;
        for (const rota of t.network.routes) {
          for (const perna of [rota.points, rota.back]) {
            for (let k = 1; k < perna.length; k++) {
              const a = perna[k - 1], b = perna[k];
              const dx = Math.sign(b.x - a.x), dy = Math.sign(b.y - a.y);
              if (noX ? (dx === 0 || dy !== 0) : (dy === 0 || dx !== 0)) continue;
              const u = noX ? dx : dy;
              const beira = noX ? (u > 0 ? posto.minX : posto.maxX)
                : (u > 0 ? posto.minY : posto.maxY);
              const falta = (beira - (noX ? a.x : a.y)) * u;
              if (falta <= 0 || falta > OLHADA) continue;
              const lado = noX ? a.y : a.x;
              const span = noX ? [posto.minY, posto.maxY] : [posto.minX, posto.maxX];
              if (lado < span[0] - 1 || lado > span[1] + 1) continue;
              n++;
            }
          }
        }
        return n;
      };
      const lista = [];
      for (const posto of sig.signals) {
        if (!posto.controlled) continue;
        for (const noX of [false, true]) {
          const passos = passosNaBoca(posto, noX);
          if (!passos) continue;
          lista.push({ id: posto.id, noX, passos, peso: noX ? passos * 0.6 : passos,
            x: +posto.x.toFixed(2), y: +posto.y.toFixed(2) });
        }
      }
      lista.sort((a, b) => b.peso - a.peso);
      return { total: lista.length, topo: lista.slice(0, 3),
        controlados: sig.signals.filter((s) => s.controlled).length };
    })()`);
    check(olhos.total > 0 && olhos.controlados > 0,
      `a cidade tem ${olhos.controlados} cruzamentos controlados e ${olhos.total} bocas com rota `
      + `correndo para dentro; a mais movimentada é a #${olhos.topo[0] && olhos.topo[0].id} `
      + `(${olhos.topo[0] && olhos.topo[0].passos} trechos de rota no eixo `
      + `${olhos.topo[0] && (olhos.topo[0].noX ? 'x' : 'y')})`);

    await evaluate(`(() => {
      const g = qa.g, t = g.transport, sig = t.signals;
      if (!qa.__updateOriginal) qa.__updateOriginal = g.update.bind(g);
      qa.__obs = null;
      qa.__L = null;
      qa.__V = {};
      qa.__zeraLuz = () => {
        qa.__L = { ticks: 0, vivas: 0, chegadas: 0, dentro: 0, invasoes: 0, amarelo: 0,
          diagonais: 0, verdes: 0, fluindo: 0, soLuz: 0, liderPlantado: 0, mínFolga: Infinity,
          lider: -1, liderLinha: null, liderBoca: null, verdeDesde: -1, liberado: null,
          cruzouSemVerde: false, demandY: 0, invasor: null, porBoca: {} };
        qa.__V = {};
        qa.__obs = null;
      };
      // O que segura um ônibus NÃO é a luz: é lataria. Para cobrar "a única parede era a luz" sem
      // chamar por dentro do freio, a régua refaz o recorte da rua — corpo vivo, carro dirigível,
      // pedestre no asfalto e o próprio jogador — e pergunta se sobra algum deles na faixa à
      // frente. O cache é do tick: 200 corpos varridos uma vez por quadro, não 14 vezes por corpo.
      qa.__obstáculos = () => {
        const arr = [];
        for (const b of t.bodies) if (b.live) arr.push({ x: b.x, y: b.y, r: 0.9, e: b });
        for (const v of g.vehicles) {
          if (v.state === 'destroyed' || !v.def.driveable || v.altitude > 0.5) continue;
          arr.push({ x: v.x, y: v.y, r: 1, e: v });
        }
        for (const n of g.npcs) {
          if (n.dead || n.inVehicle) continue;
          if (g.map.tileKindAt(n.x, n.y) !== 'road') continue;
          arr.push({ x: n.x, y: n.y, r: 0.7, e: n });
        }
        const p = g.player;
        if (p.busUnit === null && p.currentVehicleId === null && p.state !== 'dead'
          && g.map.tileKindAt(p.x, p.y) === 'road') arr.push({ x: p.x, y: p.y, r: 0.35, e: p });
        return arr;
      };
      qa.__livre = (b, noX, u) => {
        if (!qa.__obs) qa.__obs = qa.__obstáculos();
        for (let d = 0.6; d <= 7; d += 0.5) {
          const x = b.x + (noX ? u * d : 0), y = b.y + (noX ? 0 : u * d);
          for (const o of qa.__obs) {
            if (o.e === b) continue;
            if (Math.abs(o.x - x) < o.r && Math.abs(o.y - y) < o.r) return false;
          }
        }
        return true;
      };
      // Boca, luz e folga do corpo: a mesma conta do §15 offline, agora lida na rua que anda.
      qa.__naBoca = (b) => {
        const ux = Math.cos(b.angle), uy = Math.sin(b.angle);
        if (Math.max(Math.abs(ux), Math.abs(uy)) < 0.999) return null;
        const noX = Math.abs(ux) > Math.abs(uy);
        const u = noX ? (ux > 0 ? 1 : -1) : (uy > 0 ? 1 : -1);
        let posto = null;
        for (let d = 0.5; d <= 7 && !posto; d += 0.5) {
          posto = sig.at(b.x + (noX ? u * d : 0), b.y + (noX ? 0 : u * d));
        }
        if (!posto || !posto.controlled) return null;
        const luz = noX ? posto.xLight : posto.yLight;
        const beira = noX ? (u > 0 ? posto.minX : posto.maxX) : (u > 0 ? posto.minY : posto.maxY);
        return { posto, noX, u, luz, folga: (beira - (noX ? b.x : b.y)) * u - b.meio };
      };
      qa.__censo = () => {
        const L = qa.__L, bodies = t.bodies, un = t.units;
        qa.__obs = null;
        L.ticks++;
        let vivas = 0;
        for (let i = 0; i < bodies.length; i++) {
          const b = bodies[i];
          if (!b || !b.live || !un[i] || un[i].parked) continue;
          vivas++;
          const ux = Math.cos(b.angle), uy = Math.sin(b.angle);
          if (Math.max(Math.abs(ux), Math.abs(uy)) < 0.999) { L.diagonais++; continue; }
          const m = qa.__naBoca(b);
          const v = qa.__V[i] || (qa.__V[i] = { vermelho: 0, folga: Infinity });
          if (!m) { v.vermelho = 0; continue; }
          const rec = L.porBoca[m.posto.id] || (L.porBoca[m.posto.id] = { noX: m.noX,
            chegadas: 0, soLuz: 0, invasoes: 0, luz: m.luz });
          rec.luz = m.luz;
          if (!m.noX && m.posto.demandY > L.demandY) L.demandY = m.posto.demandY;
          if (m.folga <= 0) {
            L.dentro++;
            // Cruzar é o que não pode: de um quadro para o outro, a folga caiu de positivo
            // observados sob vermelho contínuo para dentro da boca. Quem entrou no verde e
            // ainda está na caixa quando a luz vira vermelha não estava mais na linha de parada
            // quando ela fechou, e por isso não tem vermelho acumulado nesta contagem.
            if (m.luz === 'red' && v.vermelho >= 10 && v.folga > 0.05) {
              L.invasoes++;
              rec.invasoes++;
              if (!L.invasor) L.invasor = { i, folga: +m.folga.toFixed(3),
                linha: t.network.routes[un[i].route].name };
            } else if (m.luz === 'yellow' && v.vermelho >= 10 && v.folga > 0.05) {
              L.amarelo++;
            }
            v.vermelho = 0;
            continue;
          }
          if (m.luz === 'red') {
            L.chegadas++;
            rec.chegadas++;
            v.vermelho++;
            v.folga = m.folga;
            if (m.folga < 2.5 && b.speed <= 0.2 && qa.__livre(b, m.noX, m.u)) {
              L.soLuz++;
              rec.soLuz++;
              if (m.folga < L.mínFolga) {
                L.mínFolga = m.folga;
                L.lider = i;
                L.liderLinha = t.network.routes[un[i].route].name;
                L.liderBoca = m.posto.id;
              }
              if (i === L.lider) L.liderPlantado++;
            }
          } else {
            v.vermelho = 0;
            if (m.luz === 'green') {
              L.verdes++;
              if (b.speed > 0.5) L.fluindo++;
            }
          }
        }
        L.vivas = vivas;
        if (L.lider < 0 || L.liberado) return;
        const líder = bodies[L.lider];
        if (!líder || !líder.live) return;
        const mm = qa.__naBoca(líder);
        if (!mm) return;
        if (mm.luz === 'green' && L.verdeDesde < 0) L.verdeDesde = L.ticks;
        if (mm.folga < -0.6) {
          if (L.verdeDesde >= 0) {
            L.liberado = { desdeVerde: +((L.ticks - L.verdeDesde) / 60).toFixed(2),
              folga: +mm.folga.toFixed(2), luz: mm.luz, quadros: L.ticks };
          } else if (L.liderPlantado >= 10) {
            L.cruzouSemVerde = true;
          }
        }
      };
      g.update = (dt) => { qa.__updateOriginal(dt); if (qa.__L) qa.__censo(); };
      return true;
    })()`);

    const leres = (L) => (L ? { ...L, mínFolga: L.mínFolga === Infinity ? null : +L.mínFolga.toFixed(3) } : null);
    const PRAZO_DA_LUZ_MS = 260000;
    const inicioDaLuz = Date.now();
    const tentativas = [];
    let luz = null, onde = null;
    for (const cand of olhos.topo) {
      if (Date.now() - inicioDaLuz > PRAZO_DA_LUZ_MS) break;
      // O pedestre assiste de fora: plantado no asfalto da boca ele seria a lataria que segura o
      // ônibus, e a régua da luz estaria medindo o §11. A busca é o primeiro tile que não é via no
      // anel em volta da boca, de dentro para fora.
      const pouso = await evaluate(`(() => {
        const g = qa.g;
        let ponto = null;
        for (let r = 2.5; r <= 8 && !ponto; r += 0.5) {
          for (let a = 0; a < 6.28 && !ponto; a += 0.4) {
            const x = ${cand.x} + Math.cos(a) * r, y = ${cand.y} + Math.sin(a) * r;
            if (g.map.tileKindAt(x, y) === 'road') continue;
            ponto = { x: +x.toFixed(2), y: +y.toFixed(2) };
          }
        }
        if (!ponto) return null;
        qa.__zeraLuz();
        qa.ir(ponto.x, ponto.y);
        return ponto;
      })()`);
      if (!pouso) { tentativas.push({ id: cand.id, erro: 'nenhum passeio no anel da boca' }); continue; }
      await delay(2600);
      const sobra = Math.max(8000, Math.min(70000, PRAZO_DA_LUZ_MS - (Date.now() - inicioDaLuz)));
      const segurou = await until('(() => {const L = qa.__L; return L.soLuz >= 20 && L.liderPlantado >= 10;})()',
        `um ônibus parado na boca #${cand.id} só porque a luz está vermelha`, sobra)
        .then(() => true, () => false);
      const censo = leres(await evaluate('qa.__L'));
      tentativas.push({ id: cand.id, noX: cand.noX, passos: cand.passos, segurou, ...censo });
      if (!segurou) continue;
      const soltou = await until('(() => {const L = qa.__L; return !!L.liberado || L.cruzouSemVerde;})()',
        'o ônibus parado diante da luz entrar na boca quando o verde abre', 70000)
        .then(() => true, () => false);
      luz = leres(await evaluate('qa.__L'));
      onde = { ...cand, pouso, soltou };
      break;
    }

    const boca = tentativas[tentativas.length - 1] || null;
    check(!!luz, luz
      ? `a rua deu um ônibus segurado pela luz`
      : `nenhuma das bocas mais movimentadas da cidade deu um ônibus parado diante da luz vermelha `
        + `em ${((Date.now() - inicioDaLuz) / 1000).toFixed(0)}s de census: `
        + `${JSON.stringify(tentativas.map((x) => ({ id: x.id, eixo: x.noX ? 'x' : 'y',
          rotas: x.passos, ticks: x.ticks, vivas: x.vivas, chegadas: x.chegadas,
          soLuz: x.soLuz, invasoes: x.invasoes })))}`);
    if (luz) {
      check(luz.diagonais === 0,
        `todo corpo vivo da cena corria num eixo do asfalto: ${luz.diagonais} leitura(s) diagonal `
        + `(boca #${onde.id}, ${luz.vivas} unidades vivas, ${luz.ticks} quadros lidos)`);
      check(luz.chegadas >= 20 && luz.soLuz >= 20 && luz.liderPlantado >= 10,
        `na boca #${onde.id} (${onde.noX ? 'eixo x' : 'eixo y'}, ${onde.passos} trechos de rota) o `
        + `ônibus #${luz.lider} da ${luz.liderLinha} ficou ${luz.liderPlantado} quadros com o pé no `
        + `chão diante da linha de parada tendo a luz como única parede (${luz.soLuz} quadros assim `
        + `no total, ${luz.chegadas} de aproximação, folga mais apertada ${luz.mínFolga} tile)`);
      check(luz.invasoes === 0,
        `nenhum ônibus cruzou a linha de parada no vermelho: ${luz.invasoes} invasão(ões)`
        + (luz.invasor ? ` — a primeira foi o #${luz.invasor.i} da ${luz.invasor.linha}, ${luz.invasor.folga} tile `
          + `para dentro da boca` : ''));
      check(luz.verdes >= 20 && luz.fluindo >= 10,
        `a luz não é um muro em qualquer cor: ${luz.fluindo} de ${luz.verdes} quadro(s) de eixo `
        + `verde mostraram corpo em marcha na mesma cena`);
      check(!!luz.liberado && !luz.cruzouSemVerde,
        luz.liberado
          ? `aberto o verde do eixo dele, o ônibus #${luz.lider} da ${luz.liderLinha} entrou na boca `
            + `${luz.liberado.desdeVerde}s depois (${luz.liberado.quadros} quadros lidos, folga final `
            + `${luz.liberado.folga} tile, luz ${luz.liberado.luz})`
          : `o ônibus parado diante da vermelha nunca foi liberado pelo verde — ${luz.cruzouSemVerde
            ? 'cruzou sem verde' : `esperaram ${((Date.now() - inicioDaLuz) / 1000).toFixed(0)}s e `
              + `ele continuou plantado`}`);
      if (!onde.noX) {
        check(luz.demandY > 0,
          `numa boca do eixo do y o ônibus pediu a vez: demandY chegou a ${luz.demandY.toFixed(2)}s `
          + 'de demanda recente, escrita pelo próprio horário e não por um carro');
      }
      const mais = Object.entries(luz.porBoca).sort((a, b) => b[1].chegadas - a[1].chegadas).slice(0, 3);
      console.log(`  semáforo no navegador: boca #${onde.id} (${onde.noX ? 'x' : 'y'}, ${onde.passos} `
        + `trechos), passeio de ${onde.pouso.x},${onde.pouso.y} · ${luz.vivas} corpos vivos em `
        + `${luz.ticks} quadros · ${luz.chegadas} aproximações, ${luz.soLuz} quadros só de luz `
        + `(líder #${luz.lider} da ${luz.liderLinha}, ${luz.liderPlantado} plantado, folga `
        + `${luz.mínFolga}) · ${luz.invasoes} invasões, ${luz.amarelo} travessias no amarelo · `
        + `${luz.fluindo}/${luz.verdes} quadros de verde em marcha · liberado `
        + `${luz.liberado ? luz.liberado.desdeVerde + 's' : 'não'} · demandY ${luz.demandY.toFixed(2)} · `
        + `bocas medidas: ${mais.map(([k, v]) => `#${k} ${v.chegadas}/${v.soLuz}`).join(', ')}`);
    }
    await evaluate('(() => { const g = qa.g; g.update = qa.__updateOriginal; qa.__L = null;'
      + ' return true;})()');
    if (boca && !luz) console.log('  census da última boca: ' + JSON.stringify(boca));
  }

  check(erros.length === 0 && avisos.length === 0,
    `console limpo com a malha ligada (${erros.length} erros, ${avisos.length} avisos)`);
  for (const e of erros.slice(0, 4)) console.log('  ERRO ' + e.slice(0, 160));
  for (const a of avisos.slice(0, 4)) console.log('  AVISO ' + a.slice(0, 160));

  console.log(`\nTransporte no navegador: ${passed} passaram, ${failures.length} falharam`);
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error('FALHOU: ' + e.message); process.exit(1); });
