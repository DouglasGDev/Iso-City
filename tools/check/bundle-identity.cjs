// Por que todo check de navegador deste diretório precisa disto:
//
// O Metro de desenvolvimento serve o bundle com o Accept-Encoding que o Chrome manda
// (gzip, deflate, br, zstd) e a resposta nunca termina: 229.376 bytes em 60 s de uma
// resposta de 9,3 MB, enquanto o mesmo URL com `Accept-Encoding: identity` sai inteiro em
// 113 ms. Sem corpo não há JavaScript: `#root` fica com 0 filhos, `[data-testid]` com 0
// nós e a fila de exceções com zero entradas — o `until('menu')` de um check lê isso como
// "a cidade não abriu", quando quem quebrou foi o transporte.
//
// O CDP permite consertar o pedido antes dele sair: `Fetch.enable` com um padrão pausa cada
// requisição do bundle, e `Fetch.continueRequest` com o cabeçalho reescosto entrega o
// `identity`. Isso fica fora de `src/` — não toca o app nem esconde defeito dele.
//
// Uso: `await require('./bundle-identity.cjs').attach(socket, send);` logo depois de habilitar
// `Page.enable`, antes da primeira navegação. `attach` registra o listener em `socket.on`
// (o `socket.onmessage` dos checks continua funcionando: o setter do ws só remove
// listeners de `addEventListener`) e devolve a promise do `Fetch.enable`.
const PADRAO = [{ urlPattern: '*index.bundle*', requestStage: 'Request' }];

function headersSemCompressao(req) {
  const nomes = Object.keys(req.headers);
  const headers = nomes.map((name) => ({
    name,
    value: name.toLowerCase() === 'accept-encoding' ? 'identity' : req.headers[name],
  }));
  if (!nomes.some((name) => name.toLowerCase() === 'accept-encoding')) {
    headers.push({ name: 'Accept-Encoding', value: 'identity' });
  }
  return headers;
}

async function attach(socket, send) {
  socket.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.method !== 'Fetch.requestPaused') return;
    send('Fetch.continueRequest', { requestId: m.params.requestId, headers: headersSemCompressao(m.params.request) }, 20000)
      .catch(() => {});
  });
  await send('Fetch.enable', { patterns: PADRAO });
}

module.exports = { attach };
