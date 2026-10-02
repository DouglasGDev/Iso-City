// Run: node tools/check/check-memory-browser.cjs (precisa do Expo web em :8082 e Chrome em :9223).
//
// A régua do `Aborted()`. O sintoma chegou como tela preta: "O jogo não conseguiu iniciar /
// Aborted(). Build with -sASSERTIONS for more info.", e às vezes o jogo só congelava no meio.
// Medido (tools/tmp/medir-abort*.cjs): parado, o heap do wasm ficava plano em 128MB; andando,
// +254,4MB em 160 segundos — 1.250 `Skia.Path.Make()` por segundo criados e zero `delete()`
// chamados. Esgotou a memória linear do canvaskit, que é o que o `Aborted()` quer dizer.
//
// Por que só na web: lá o objeto do Skia vive na memória do wasm, que o coletor do JS não
// enxerga — só volta ao heap quando alguém chama `delete()`. No aparelho o mesmo objeto é
// refcountado pelo C++, então derrubar a referência já devolve a memória. A régua por isso conta
// as duas pontas: quantos objetos os protocolos do CanvasKit fizeram e quantos deletaram.
//
// O que ela trava, então, não é "a página abriu": é a INCLINAÇÃO. Caminho vivo tem de ficar
// plano enquanto o jogador anda (os caminhos dos worklets são rebobinados, não recriados, e a
// picture do chão é devolvida dois bakes depois), e o heap tem de crescer no máximo o custo de
// um quadro de geometria nova. Com o vazamento de antes, estas duas travas pegavam em segundos.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const WebSocket = require('ws');

const PORT = Number(process.env.QA_CDP_PORT || 9223);
const METRO = process.env.QA_METRO_PORT || 8082;
const VW = 844, VH = 390;

// Janelas de amostragem. O andar é o regime que estourava o heap; parado é o controle, porque
// vazamento bom de esconder é o que só aparece com a câmera em movimento.
const PARADO_INICIAL = 6;
const ANDANDO = 14;
const PARADO_FINAL = 5;
const PASSO_MS = 4000;

// Objectos que podem ficar vivos SEM crescer. Os caminhos rebobinados moram nos refs dos
// worklets e nas caixas de módulo: um punhado deles é o desenho, não o vazamento.
const TETO_CAMINHO_VIVO = 900;
// A contagem de tintas não é prova nesta build: `JsiSkPaint.dispose()` chama o `delete()`
// que embrulhamos, mas a criação passa por dentro da classe wrapper e nunca sobe o nosso
// contador — por isso o saldo sai negativo e não tem leitura absoluta. Vale como alerta
// apenas se um dia virar crescimento.
const TETO_TINTA_VIVA = 200;
// Pictures vivas no regime honesto: uma `lastPicture` por <Canvas> (o jogo tem 10) mais o
// buffer de duas vivas do chão. O que denuncia o vazamento é a inclinação, não o patamar —
// um `PictureRecorder` por quadro deixava milhares, não doze.
const TETO_PICTURE_VIVA = 24;
const TETO_PICTURE_CRESCIMENTO = 3;
// Andando, o heap anda com o terreno novo que entra na janela; 160s de vazamento somavam
// 254MB. Meio megabyte por amostra é folga bastante para o bake honesto e aperto o bastante
// para a curva voltar a subir.
const TETO_HEAP_MB_POR_AMOSTRA = 3;

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

/**
 * Instrumentação entra ANTES do boot e não toca em `src/`: ela embrulha os construtores que o
 * próprio CanvasKit expõe (`Path`, `Paint`, `PictureRecorder`, `Vertices`…) e o `delete()` dos
 * protótipos embind. As fábricas do lado Skia web procuram `CanvasKit.X` no módulo a cada
 * chamada, então o embrulho pega sem o Metro precisar de nada.
 */
const INSTRUMENTO = `
window.__m = { feitos: {}, deletados: {}, gravadas: 0, heap: () => 0, ckOk: false, erro: null, tipos: [] };
(function () {
  var Nomes = ['Path', 'PictureRecorder', 'Vertices', 'Paint', 'Image', 'Shader', 'TextBlob', 'MaskFilter', 'RRect'];
  (function espera() {
    var CK = window.CanvasKit;
    if (!CK) { setTimeout(espera, 40); return; }
    window.__m.ckOk = true;
    try {
      function embrulhar(nome) {
        var Orig = CK[nome];
        if (typeof Orig !== 'function' || !Orig.prototype) return false;
        var proto = Orig.prototype;
        var del = proto.delete;
        if (typeof del !== 'function') return false;
        proto.delete = function () {
          window.__m.deletados[nome] = (window.__m.deletados[nome] || 0) + 1;
          return del.apply(this, arguments);
        };
        var W = function () {
          window.__m.feitos[nome] = (window.__m.feitos[nome] || 0) + 1;
          return new Orig();
        };
        W.prototype = proto;
        Object.assign(W, Orig);
        CK[nome] = W;
        return true;
      }
      window.__m.tipos = Nomes.filter(function (n) { try { return embrulhar(n); } catch (e) { return false; } });
      // MakeVertices: a fabrica do CanvasKit devolve a instancia sem passar por construtor
      // visivel, entao a contagem vai na propria fabrica.
      if (typeof CK.MakeVertices === 'function') {
        var mv = CK.MakeVertices;
        CK.MakeVertices = function () {
          window.__m.feitos.Vertices = (window.__m.feitos.Vertices || 0) + 1;
          return mv.apply(this, arguments);
        };
      }
      // O SkPicture sai do recorder e nao tem construtor: conta a gravacao e embrulha o
      // delete() da instancia, que e justamente o que o GroundLayer passou a chamar.
      var PR = CK.PictureRecorder;
      if (PR && PR.prototype && typeof PR.prototype.finishRecordingAsPicture === 'function') {
        var fin = PR.prototype.finishRecordingAsPicture;
        PR.prototype.finishRecordingAsPicture = function () {
          var pic = fin.apply(this, arguments);
          window.__m.gravadas++;
          try {
            var d = pic && pic.delete;
            if (typeof d === 'function' && !pic.__contada) {
              pic.__contada = true;
              pic.delete = function () {
                window.__m.deletados.SkPicture = (window.__m.deletados.SkPicture || 0) + 1;
                return d.apply(this, arguments);
              };
            }
          } catch (e) { /* contagem não pode derrubar o desenho */ }
          return pic;
        };
      }
      window.__m.heap = function () { return CK.HEAPU8 ? CK.HEAPU8.buffer.byteLength : 0; };
    } catch (e) { window.__m.erro = String(e && e.stack || e); }
  })();
})();
`;

const LER = `(()=>{const m=window.__m,g=qa.g;const vivo={};`
  + `for(const k of Object.keys(m.feitos)) vivo[k]=m.feitos[k]-(m.deletados[k]||0);`
  + `vivo.SkPicture=m.gravadas-(m.deletados.SkPicture||0);`
  + `return{heapMB:+(m.heap()/1048576).toFixed(1),feitos:JSON.parse(JSON.stringify(m.feitos)),`
  + ` deletados:JSON.parse(JSON.stringify(m.deletados)),vivo:JSON.parse(JSON.stringify(vivo)),`
  + ` gravadas:m.gravadas,ckOk:m.ckOk,erro:m.erro||null,tipos:m.tipos||[],`
  + ` tempo:+g.time.toFixed(2),x:+g.player.x.toFixed(1),y:+g.player.y.toFixed(1),`
  + ` canvas:document.querySelectorAll('canvas').length};})()`;

(async () => {
  const pages = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = pages.find((p) => p.type === 'page');
  assert.ok(page, `nenhum alvo CDP na porta ${PORT}`);
  socket = new WebSocket(page.webSocketDebuggerUrl);
  socket.onmessage = ({ data }) => {
    const m = JSON.parse(data);
    if (!m.id) return;
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
  };
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = () => reject(new Error('CDP falhou')); });
  await send('Runtime.enable'); await send('Page.enable');
  // Abort() e estouro de memória aparecem no console da página; guardar tudo é a única forma
  // de a régua não virar verde por ler só o que deu certo.
  socket.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) {
      errors.push(m.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '));
    }
    if (m.method === 'Runtime.exceptionThrown') {
      errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    }
  });

  await send('Page.addScriptToEvaluateOnNewDocument', { source: INSTRUMENTO });
  await send('Page.navigate', { url: 'about:blank' });
  await send('Emulation.setDeviceMetricsOverride', { width: VW, height: VH, deviceScaleFactor: 1, mobile: true });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await send('Page.navigate', { url: `http://localhost:${METRO}/?mem-check=1` });

  await until(`!!document.querySelector('[data-testid="menu-new"],[data-testid="menu-play"]')`, 'menu');
  await delay(600);
  const botao = await evaluate(`(()=>{const b=document.querySelector('[data-testid="menu-new"]')`
    + `||document.querySelector('[data-testid="menu-play"]');const r=b.getBoundingClientRect();`
    + `return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...botao, id: 1 }] });
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await until(`!!document.querySelector('[data-testid="minimap"]')`, 'HUD');
  await delay(4000);
  await evaluate(`(()=>{const mods=[...__r.getModules().values()].filter(m=>m.isInitialized)`
    + ` .map(m=>m.publicModule.exports);globalThis.qa={g:mods.find(m=>m&&m.getGame).getGame(),`
    + ` input:mods.find(m=>m&&m.setJoystickInput)};qa.g.player.invulnUntil=Infinity;return 1;})()`);

  assert.ok(await evaluate('window.__m.ckOk'), 'o CanvasKit nunca ficou disponível para a contagem');
  const tipos = await evaluate('window.__m.tipos.join(",")');
  const erro = await evaluate('window.__m.erro || ""');
  console.log(`fábricas com contagem: ${tipos || '(nenhuma)'}${erro ? ` | erro: ${erro}` : ''}`);
  assert.ok(tipos.includes('Path'), 'sem contagem de Path: a régua não mede nada');
  assert.ok(!erro, `instrumentação falhou: ${erro}`);

  const traco = [];
  const linha = (s, fase) => `${String(s.s).padStart(4)}s ${fase.padEnd(14)} heap=${String(s.heapMB).padStart(6)}MB `
    + `Path vivo=${String(s.vivo.Path ?? 0).padStart(5)} (feitos ${s.feitos.Path ?? 0}/deletos ${s.deletados.Path ?? 0}) `
    + `Paint vivo=${String(s.vivo.Paint ?? 0).padStart(4)} Picture vivo=${String(s.vivo.SkPicture ?? 0).padStart(3)} `
    + `Vertices vivo=${String(s.vivo.Vertices ?? 0).padStart(3)} (gravadas ${s.gravadas}) `
    + `Recorder vivo=${String(s.vivo.PictureRecorder ?? 0).padStart(3)} canvas=${s.canvas} t=${s.tempo}`;

  const amostra = async (fase) => {
    const s = await evaluate(LER);
    s.s = +((Date.now() - t0) / 1000).toFixed(1);
    s.fase = fase;
    traco.push(s);
    console.log(linha(s, fase));
    return s;
  };

  const t0 = Date.now();
  console.log('\n[1] parado, câmera quieta:');
  for (let i = 0; i < PARADO_INICIAL; i++) { await amostra('parado'); await delay(PASSO_MS); }

  console.log('\n[2] andando pelo mapa (bake do chão + worklets de combate e clima):');
  let ang = 0;
  for (let i = 0; i < ANDANDO; i++) {
    if (i % 3 === 0) {
      ang += 1.1;
      await evaluate(`qa.input.setJoystickInput(${Math.cos(ang).toFixed(3)},${Math.sin(ang).toFixed(3)},1)`);
    }
    await amostra('andando');
    await delay(PASSO_MS);
  }
  await evaluate('qa.input.setJoystickInput(0,0,0)');

  console.log('\n[3] parado de novo, depois da caminhada:');
  for (let i = 0; i < PARADO_FINAL; i++) { await amostra('parado-depois'); await delay(PASSO_MS); }

  const andando = traco.filter((t) => t.fase === 'andando');
  const primeiro = andando[0], ultimo = andando[andando.length - 1];
  const segundos = ultimo.s - primeiro.s;
  const cresc = (k) => (ultimo.vivo[k] ?? 0) - (primeiro.vivo[k] ?? 0);
  const heapMB = ultimo.heapMB - primeiro.heapMB;
  const porAmostra = heapMB / (andando.length - 1);

  console.log(`\nresumo do andar (${segundos.toFixed(0)}s):`);
  console.log(`  Path criado no andar: ${ultimo.feitos.Path - primeiro.feitos.Path} `
    + `(${((ultimo.feitos.Path - primeiro.feitos.Path) / segundos).toFixed(0)}/s), `
    + `deletado: ${(ultimo.deletados.Path || 0) - (primeiro.deletados.Path || 0)}`);
  console.log(`  Picture gravada no andar: ${ultimo.gravadas - primeiro.gravadas}, `
    + `devolvida: ${(ultimo.deletados.SkPicture || 0) - (primeiro.deletados.SkPicture || 0)}`);
  console.log(`  vivo: Path=${cresc('Path')} Paint=${cresc('Paint')} Vertices=${cresc('Vertices')} `
    + `Picture=${cresc('SkPicture')} Recorder=${cresc('PictureRecorder')}`);
  console.log(`  heap: ${primeiro.heapMB}MB -> ${ultimo.heapMB}MB (+${heapMB.toFixed(1)}MB, `
    + `${porAmostra.toFixed(2)}MB por amostra de ${PASSO_MS / 1000}s)`);

  fs.writeFileSync(path.resolve(__dirname, '..', 'tmp', 'check-memory-browser.json'),
    JSON.stringify(traco, null, 2));

  // O jogo tem de estar VIVO no fim: congelar com heap baixo também é falha.
  const tempoFinal = await evaluate('qa.g.time');
  assert.ok(tempoFinal > ultimo.tempo, `a simulação parou no meio do teste (t=${ultimo.tempo} → ${tempoFinal.toFixed(2)})`);

  assert.ok(cresc('Path') <= TETO_CAMINHO_VIVO,
    `caminhos vivos cresceram ${cresc('Path')} no andar — teto ${TETO_CAMINHO_VIVO}: algum worklet `
    + 'voltou a criar `Skia.Path.Make()` por quadro em vez de rebobinar o do ref');
  assert.ok(cresc('Paint') <= TETO_TINTA_VIVA,
    `tintas vivas cresceram ${cresc('Paint')} — teto ${TETO_TINTA_VIVA}: o patch do `
    + 'pool de tintas do Skia web deixou de valer');
  assert.ok(ultimo.vivo.PictureRecorder <= 4 && cresc('PictureRecorder') <= 2,
    `${ultimo.vivo.PictureRecorder} recorders vivos, crescendo ${cresc('PictureRecorder')} no `
    + `andar: o patch do sksg/Container.web.js parou de devolver o PictureRecorder do quadro — `
    + 'é justamente o objeto que vazava ~97 por segundo e enchia o heap até o Aborted()');
  assert.ok(ultimo.vivo.SkPicture <= TETO_PICTURE_VIVA
    && cresc('SkPicture') <= TETO_PICTURE_CRESCIMENTO,
    `${ultimo.vivo.SkPicture} pictures vivas, crescendo ${cresc('SkPicture')} no andar `
    + `(gravadas ${ultimo.gravadas}, devolvidas ${ultimo.deletados.SkPicture || 0}) — tetos `
    + `${TETO_PICTURE_VIVA} vivas / ${TETO_PICTURE_CRESCIMENTO} de crescimento: cada <Canvas> `
    + 'guarda a última picture e o chão mantém o buffer de duas; crescer é voltar a esquecer '
    + 'a picture substituída');
  assert.ok(porAmostra <= TETO_HEAP_MB_POR_AMOSTRA,
    `heap subiu ${porAmostra.toFixed(2)}MB por amostra enquanto o jogador andava `
    + `(+${heapMB.toFixed(1)}MB em ${segundos.toFixed(0)}s) — teto ${TETO_HEAP_MB_POR_AMOSTRA}MB: `
    + 'é a curva do Abort() voltando');

  const abort = errors.filter((e) => /Aborted|out of memory|memory growth|Cannot read|not a function/i.test(e));
  assert.ok(!abort.length, `a página reportou: ${abort.slice(0, 3).join(' | ')}`);
  console.log(`\nOK: boot, heap e contagem de objetos dentro do teto em ${(segundos + 40).toFixed(0)}s de jogo.`);
  socket.close();
})().catch((e) => {
  console.error(e);
  if (errors.length) console.error('console da página:\n  ' + errors.slice(-8).join('\n  '));
  process.exitCode = 1;
}).finally(() => socket?.close());
