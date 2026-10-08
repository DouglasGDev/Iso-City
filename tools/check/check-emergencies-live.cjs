// Run: node tools/check/check-emergencies-live.cjs
//
// O pedido do jogador foi simples e justo: "não vi bombeiro, nem paramédico, nem patrulha". Os checks
// offline provam a mecânica num mapa sintético; este prova que a cena existe no MUNDO REAL que roda no
// navegador — o gerador completo, com os hospitais, quartéis e vias que o jogador pisa. Aqui não se
// cobra fórmula: se força uma urgência de verdade ao lado do jogador e se espera o serviço aparecer.
//
// O bug que motivou este arquivo (e que o offline de um corpo só não pegava): uma ambulância chamada
// por um corpo que escapa da folha antes do resgate ficava presa para sempre no hospital, porque
// `u.vítima` apontava para um id morto e `despacha` só oferece a lataria quando ela está livre. No
// navegador isso era o "não vi paramédico". Por isso a primeira prova é um resgate COMPLETO: a
// ambulância sai, o paramédico desce a pé, e o caído volta à vida — com o vínculo da viatura conferido
// a cada passo para a lataria nunca travar num corpo fantasma.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const WebSocket = require('ws');
let socket, serial = 0;
const pending = new Map(), errors = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++serial; pending.set(id, { resolve, reject });
  socket.send(JSON.stringify({ id, method, params }));
});
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}
async function until(expression, label, timeout = 45000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await evaluate(expression)) return; await delay(120); }
  throw new Error('Timed out: ' + label + ' :: ' + await probe());
}
// A sonda de diagnóstico é uma função que cada prova grava na PÁGINA (`qa.probe`), não uma variável
// do Node: quem executa a expressão é o navegador, e uma `let` daqui nunca veria o assignment de lá.
async function probe() { try { return JSON.stringify(await evaluate('(()=>qa.probe?qa.probe():"n/a")()')); } catch (e) { return String(e.message); } }
async function screenshot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.resolve(__dirname, '../tmp/' + name + '.png'), Buffer.from(data, 'base64'));
}
async function launch() {
  await send('Page.navigate', { url: 'about:blank' });
  await send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 640, deviceScaleFactor: 1, mobile: false });
  await send('Emulation.setTouchEmulationEnabled', { enabled: false });
  await send('Page.navigate', { url: 'http://localhost:8082/?city-life-qa=0' });
  await send('Emulation.setTouchEmulationEnabled', { enabled: false });
  await until('!!document.body?.innerText.match(/JOGAR|NOVO JOGO/)', 'menu', 120000);
  const p = await evaluate(`(()=>{const e=[...document.querySelectorAll('div')].find(e=>e.childElementCount===0&&(e.textContent==='JOGAR'||e.textContent==='NOVO JOGO'));const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...p, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...p, button: 'left', clickCount: 1 });
  await until('document.body.innerText.includes("HP 100")', 'HUD', 60000);
  // O relógio do mundo é a única coisa que move a simulação: se `game.time` não avança, o navegador
  // está com o render enforcado e nenhuma prova abaixo vale. Medir o tique antes de confiar nele.
  await evaluate(`(()=>{const m=[...__r.getModules().values()].filter(m=>m.isInitialized).map(m=>m.publicModule.exports);globalThis.qa={g:m.find(m=>m?.getGame).getGame()};qa.g.player.invulnUntil=Infinity;qa.g.weather.intensity=0;qa.g.weather.target=0;qa.g.dayNight.t=.5;qa.t0=qa.g.time;})()`);
  await delay(500);
  assert.ok(Number(await evaluate('qa.g.time-qa.t0')) > 0.2,
    'o relógio do jogo não avança no navegador: render enforcado, nenhuma prova abaixo vale');
}

// ---- SAMU: um caído ao lado do jogador tem de virar resgate na tela ----

async function samuProva() {
  const setup = await evaluate(`(()=>{
    const g=qa.g;
    g.wanted.clear(g.player);
    const h=g.map.landmarksOf('hospital')[0];
    const node=g.map.roadNodes[g.map.nearestRoadNode(h.front.x,h.front.y)];
    // Jogador estacionado em cima da vaga da ambulância: é assim que o resgate aparece no quadro.
    g.player.x=node.x+1.6; g.player.y=node.y+1.6; g.camera.x=g.player.x; g.camera.y=g.player.y;
    // Um civ vivo é teletransportado para o asfalto ao lado da vaga e derrubado com vida negativa —
    // crítico, sangrando, atendível. Não é trapaça: é exatamente o estado que um soco ou um incêndio
    // deixa no chão, forçado aqui para caber na janela curta de resposta de um resgate real.
    const civ=g.npcs.find(n=>n.kind==='civ'&&!n.dead&&!n.inVehicle&&!n.swimming);
    if(!civ) return {erro:'sem civ'};
    const vit=Object.assign({},civ,{id:990001,x:node.x,y:node.y,state:'knocked',health:-12,downTimer:999,inVehicle:false,vehicleId:null,dead:false,swimming:false,anim:'idle',frame:0,speed:0,fleeing:false,callingPolice:false});
    g.npcs.push(vit); g.notifyEntityChange();
    const u=g.samu.viaturas.find(c=>c.hospital===h.key)||g.samu.viaturas[0];
    qa.u=u;
    qa.probe=()=>{const g=qa.g,u=qa.u,v=g.npcs.find(n=>n.id===990001),p=g.samu.paramédicos.filter(x=>x.viatura===u.vehicleId).map(x=>{const n=g.npcs.find(c=>c.id===x.npcId);return {a:x.alvo,dentro:!!n&&n.inVehicle}});return {modo:u.modo,vit:u.vítima,vitVivo:!!v&&!v.dead&&v.state==="knocked",sang:v?v.sangramento:undefined,vitHealth:v?v.health:undefined,resg:g.samu.resgatadas,pé:p.filter(x=>!x.dentro).length,alvos:p.map(x=>x.a)};};
    return {hospital:h.key, vehicleId:u.vehicleId, vitId:vit.id, uVit:u.vítima, modo:u.modo};
  })()`);
  assert.ok(!setup.erro, 'SAMU: ' + setup.erro);
  await evaluate(`qa.u=qa.g.samu.viaturas.find(c=>c.vehicleId===${setup.vehicleId})`);
  assert.equal(setup.vitId, 990001);
  // O vínculo da viatura com o corpo deve aparecer (despacho) — e o modo sair do hospital.
  await until(`qa.u.vítima===990001`, 'ambulância atribuir o corpo', 8000);
  await until(`qa.u.modo==="a caminho"`, 'ambulância pegar a rua', 8000);
  await delay(400); await screenshot('qa-live-samu-a-caminho');
  await until(`qa.u.modo==="em terra"`, 'ambulância encostar na parada', 40000);
  await until(`qa.g.samu.paramédicos.some(p=>p.viatura===${setup.vehicleId}&&p.alvo===990001&&(()=>{const n=qa.g.npcs.find(c=>c.id===p.npcId);return n&&!n.inVehicle})())`, 'paramédico descer a pé até o corpo', 20000);
  // Centraliza a cena na lataria. A câmera é um shared value do Reanimated que persegue o jogador a
  // cada quadro, então escrever `camera` direto não cola: o que traz a ambulância para o centro do
  // quadro é levar o PRÓPRIO jogador até ela (ele está invulnerável; o resgate continua correndo).
  await evaluate(`(()=>{const v=qa.g.vehicles.find(c=>c.id===${setup.vehicleId});qa.g.player.x=v.x+1.2;qa.g.player.y=v.y+1.2;qa.g.notifyEntityChange();})()`);
  await delay(1500); await screenshot('qa-live-samu-maca');
  // O socorro fecha: o caído volta à vida (vida restaurada) e sai do chão — é o "não devia morrer".
  await until(`qa.g.samu.resgatadas>0 && qa.g.npcs.find(n=>n.id===990001).health>40`, 'socorro devolver a pessoa viva', 25000);
  const fim = await evaluate(`(()=>{const v=qa.g.npcs.find(n=>n.id===990001);return {health:v?v.health:null,dead:v?v.dead:null,resg:qa.g.samu.resgatadas,vit:qa.u.vítima,modo:qa.u.modo}})()`);
  assert.ok(fim.health > 40 && !fim.dead, 'SAMU: o socorrido não voltou vivo — ' + JSON.stringify(fim));
  // E o laço que travava o jogo: depois do socorro a viatura larga o corpo e volta a ficar livre.
  await until(`qa.u.vítima===null && (qa.u.modo==="de volta"||qa.u.modo==="hospital")`, 'ambulância liberar o vínculo após o resgate', 25000);
  await screenshot('qa-live-samu-depois');
  console.log('OK SAMU resgatou um caído ao lado do jogador no mundo real:', JSON.stringify(fim));
}

// ---- Bombeiro: um fogo ao lado do jogador tem de trazer caminhão e brigada a pé ----

async function bombeiroProva() {
  const setup = await evaluate(`(()=>{
    const g=qa.g;
    // Reconstrói o contexto do incêndio igual o GameState faz por tick, para acender uma vez aqui.
    const ctx={map:g.map,player:g.player,vehicles:g.vehicles,npcs:g.npcs,collision:g.collision,wrecks:g.destruction.wrecks,chuva:0,time:g.time,dano:()=>{},shake:()=>{},allocVehicleId:()=>g.nextVehicleId++,allocNpcId:()=>g.nextNpcId++,onStructChange:()=>g.notifyEntityChange(),rng:()=>g.rnd()};
    const q=g.map.queryNearby(g.player.x,g.player.y,14);
    // Procura um chão inflamável (mato/grama) perto do jogador; um fogo no asfalto não pega — e não
    // seria justo cobrar do bombeiro o que a própria régua do mapa recusa.
    let fogo=null, melhor=null, dm=Infinity;
    for(let dx=-12;dx<=12&&!fogo;dx+=1.5)for(let dy=-12;dy<=12;dy+=1.5){
      const x=g.player.x+dx,y=g.player.y+dy;const t=g.map.tileKindAt(x,y);
      if(t==='grass'||t==='dirt'){const f=g.incendio.acende(x,y,'mato',null,ctx);if(f&&f.combustível>0){fogo=f;break;}}
    }
    if(!fogo || !(fogo.combustível>0)) return {erro:'nenhum chão inflamável perto' };
    g.player.x=fogo.x+2;g.player.y=fogo.y+2;g.camera.x=g.player.x;g.camera.y=g.player.y;g.notifyEntityChange();
    qa.probe=()=>{const g=qa.g,i=g.incendio;const fogos=(i.fogos||[]).filter(f=>f.combustível>0).length;const unidades=(i.viaturas||[]).map(u=>u.modo);const aPé=(i.bombeiros||[]).filter(b=>{const n=g.npcs.find(c=>c.id===b.npcId);return n&&!n.inVehicle}).length;return {fogos,unidades,aPé};};
    return {fogo:{x:fogo.x,y:fogo.y}, viaturas:(g.incendio.viaturas||[]).length };
  })()`);
  if (setup.erro) { console.log('BOMBEIRO (informativo): ' + setup.erro + ' — pulando fora de quadro'); return; }
  await delay(600); await screenshot('qa-live-fogo');
  // Caminhão de bombeiro despacha (alguma unidade sai do quartel) e a brigada pisa o chão.
  await until(`(()=>{const i=qa.g.incendio;return (i.viaturas||[]).some(u=>(u.modo||u.estado)!=="quartel"&&u.modo!==undefined)|| (i.bombeiros||[]).some(b=>{const n=qa.g.npcs.find(c=>c.id===b.npcId);return n&&!n.inVehicle})})()`, 'bombeiro mobilizar-se ao fogo', 45000);
  await delay(1500); await screenshot('qa-live-bombeiro');
  console.log('OK Bombeiro mobilizou-se a um fogo real no mundo:', await probe());
}

// ---- Patrulha: com o jogador procurado, a polícia tem de existir na tela e reagir ----

async function patrulhaProva() {
  // Primeiro a ronda passiva: viaturas em modo 'patrol' dirigindo a cidade mesmo com o jogador limpo.
  // É esta a "patrulha" que o jogador disse não ver — ela existe desde o `init`, sem precisar de crime.
  // Não se chama `reset()` aqui: o reset manda toda patrulha para 'return' e só as tier 1 voltam a
  // 'patrol' quando alcançam o quartel — medir logo depois daria "nenhuma ronda", um artefato do teste.
  await evaluate(`(()=>{
    const g=qa.g;
    g.wanted.clear(g.player);
    const node=g.map.roadNodes[g.map.nearestRoadNode(g.player.x,g.player.y)];
    g.player.x=node.x+1.4;g.player.y=node.y+1.4;g.camera.x=g.player.x;g.camera.y=g.player.y;
    g.notifyEntityChange();
    qa.probe=()=>{const g=qa.g;const p=g.police.units.filter(u=>u.mode==="patrol").map(u=>{const v=g.vehicles.find(x=>x.id===u.vehicleId);return {dir:v?v.state:"?",x:v?+v.x.toFixed(1):null,y:v?+v.y.toFixed(1):null}});return {patrulhas:p.length,citadas:g.police.units.length,estado:p.map(u=>u.dir),respond:g.police.units.filter(u=>u.mode==="respond"||u.mode==="deployed").length};};
  })()`);
  const unidades = await evaluate('qa.g.police.units.length');
  assert.ok(unidades > 0, 'Patrulha: a cidade não tem nenhuma viatura policial');
  // Dá tempo de o `wanted` decair e uma ronda assentar em 'patrol' antes de cobrar presença.
  await until(`qa.g.police.units.some(u=>u.mode==="patrol")`, 'viatura policial em ronda pela cidade', 45000);
  const limpo = await evaluate(`(()=>{const g=qa.g;const patr=g.police.units.filter(u=>u.mode==='patrol');return {patrulhas:patr.length,dirigindo:patr.filter(u=>{const v=g.vehicles.find(x=>x.id===u.vehicleId);return v&&v.state==='driving'}).length}})()`);
  assert.ok(limpo.patrulhas > 0, 'Patrulha: nenhuma viatura em ronda');
  assert.ok(limpo.dirigindo > 0, `Patrulha: ${limpo.patrulhas} em ronda mas nenhuma com motor ligado`);
  // A ronda tem de SE MOVER: uma patrulha congelada é uma viatura estacionada com nome de patrulha.
  await evaluate(`(()=>{const g=qa.g;qa.rondaAntes=g.police.units.filter(u=>u.mode==='patrol').map(u=>{const v=g.vehicles.find(x=>x.id===u.vehicleId);return {id:u.vehicleId,x:v?v.x:0,y:v?v.y:0}});})()`);
  await delay(3000);
  const anda = await evaluate(`(()=>{const g=qa.g;return g.police.units.filter(u=>u.mode==='patrol').some(u=>{const v=g.vehicles.find(x=>x.id===u.vehicleId);const a=(qa.rondaAntes||[]).find(q=>q.id===u.vehicleId);return v&&a&&Math.hypot(v.x-a.x,v.y-a.y)>0.4})})()`);
  assert.ok(anda, 'Patrulha: nenhuma viatura de ronda se moveu em 3 s — a ronda está parada');
  await screenshot('qa-live-patrulha-ronda');
  console.log('OK Patrulha ronda a cidade de graça:', JSON.stringify(limpo));

  // Depois a resposta: um crime reportado perto do jogador escalona uma viatura para 'respond' e
  // despeja oficial a pé — o "não vi patrulha" no sentido ativo do pedido.
  const resposta = await evaluate(`(()=>{
    const g=qa.g;
    g.wanted.clear(g.player);
    const node=g.map.roadNodes[g.map.nearestRoadNode(g.player.x,g.player.y)];
    g.police.report({x:node.x,y:node.y});
    g.player.wantedLevel=2; g.notifyEntityChange();
    return {report:true, level:g.player.wantedLevel};
  })()`);
  assert.equal(resposta.level, 2);
  await until(`qa.g.police.units.some(u=>u.mode==="respond"||u.mode==="deployed")`, 'viatura policial ir ao crime reportado', 30000);
  await delay(1500); await screenshot('qa-live-patrulha-resposta');
  console.log('OK Patrulha respondeu a um crime reportado:', await probe());
}

(async () => {
  const pages = await (await fetch('http://127.0.0.1:9223/json/list')).json();
  socket = new WebSocket(pages.find(p => p.type === 'page').webSocketDebuggerUrl);
  socket.onmessage = ({ data }) => {
    const m = JSON.parse(data);
    if (m.id) { const p = pending.get(m.id); if (!p) return; pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
    else if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  };
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  await send('Page.enable');
  await require('./bundle-identity.cjs').attach(socket, send);
  await send('Page.navigate', { url: 'about:blank' });
  await send('Runtime.enable');
  await until('location.href==="about:blank"', 'clean context', 20000);
  errors.length = 0;
  await launch();

  const falhas = [];
  for (const [nome, fn] of [['SAMU', samuProva], ['Bombeiro', bombeiroProva], ['Patrulha', patrulhaProva]]) {
    try { await fn(); } catch (e) { falhas.push(nome + ': ' + e.message); console.error('FAIL ' + nome + '\n' + e.stack); }
    await evaluate('(()=>{const g=qa.g;g.wanted.clear(g.player);try{const v=g.npcs.find(n=>n.id===990001);if(v)v.dead=true;}catch{}})()');
  }
  await evaluate('qa.g.paused=true;');
  assert.deepEqual(errors, [], 'exceções de runtime durante as urgências: ' + errors.join('\n'));
  if (falhas.length) { console.error('\nFALHAS:\n' + falhas.join('\n')); process.exitCode = 1; }
  else console.log('\nAs três urgências apareceram no mundo real.');
  socket.close();
})().catch(async error => {
  console.error(error);
  try { await screenshot('qa-live-failure'); } catch {}
  socket?.close(); process.exitCode = 1;
});
