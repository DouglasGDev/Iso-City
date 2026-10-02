// Run: node tools/check/check-cascade.cjs. Cachoeira do relevo: queda nascida do degrau,
// bacia navegável, correnteza que empurra e rugido que obedece à distância.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('module');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');
const modules = new Map();

function load(filename) {
  if (!path.extname(filename)) filename += '.ts';
  if (modules.has(filename)) return modules.get(filename).exports;
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    fileName: filename, compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  });
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.require = (name) => (name.startsWith('.')
    ? load(path.resolve(path.dirname(filename), name))
    : require(name));
  modules.set(filename, mod);
  mod._compile(compiled.outputText, filename);
  return mod.exports;
}

const { GAME_CONFIG: C } = load(path.join(root, 'src/game/GameConfig.ts'));
const { generateCity } = load(path.join(root, 'src/data/maps/city.ts'));
const { Map: CityMap } = load(path.join(root, 'src/world/Map.ts'));
const { CascadeSystem } = load(path.join(root, 'src/systems/CascadeSystem.ts'));
const { worldToScreen } = load(path.join(root, 'src/world/IsoUtils.ts'));

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('OK ' + name); }
  catch (error) { failed++; console.error('FAIL ' + name + '\n' + error.stack); }
}

const DT = 0.1;
const MAX_CASCATA = 4;
/** Meia-largura do canal: exatamente a fórmula do lençol desenhado, sem a margem de espirro. */
const meia = (largura, t) => Math.max(0.25, largura * 0.5 * (0.72 + 0.56 * t));
/**
 * Rumo do curso na amostra `i`, medido três amostras de cada lado (~1 tile de caminho).
 * É a régua do teste: o eixo é uma escada de meio tile, e o que se cobra da força é que
 * ela siga o rio — não o dente da escada em que o corpo parou.
 */
function eixoLocal(curso, i) {
  const a = curso[Math.max(0, i - 3)];
  const b = curso[Math.min(curso.length - 1, i + 3)];
  const m = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  return { tx: (b.x - a.x) / m, ty: (b.y - a.y) / m };
}
/**
 * Distância real de um ponto ao eixo amostrado: é ela que decide se é lençol, beira ou
 * chão seco. O caminho é uma escada de meio tile, então a perpendicular do desenho nunca
 * é a distância de verdade — medir sai mais barato que discutir.
 */
function distanciaDoEixo(curso, x, y) {
  let best = Infinity;
  for (let i = 0; i + 1 < curso.length; i++) {
    const ax = curso[i].x;
    const ay = curso[i].y;
    const bx = curso[i + 1].x - ax;
    const by = curso[i + 1].y - ay;
    const len2 = bx * bx + by * by;
    const u = len2 > 1e-9 ? Math.max(0, Math.min(1, ((x - ax) * bx + (y - ay) * by) / len2)) : 0;
    best = Math.min(best, Math.hypot(x - (ax + bx * u), y - (ay + by * u)));
  }
  return best;
}

const swept = (over = {}) => ({
  time: 10, indoors: false,
  player: { x: -50, y: -50, currentVehicleId: null },
  npcs: [], vehicles: [], animals: [],
  health: { damage: () => true }, clamp: () => {}, shake: () => {},
  ...over,
});
/** Descida na tela: é o que decide se é queda, não a cota crua. */
const descidaNaTela = (c, data) => {
  const boca = c.curso[0];
  const pe = c.curso[c.curso.length - 1];
  const a = worldToScreen(boca.x, boca.y, data.heights[Math.floor(boca.y) * data.tilesW + Math.floor(boca.x)]);
  const b = worldToScreen(pe.x, pe.y, data.heights[Math.floor(pe.y) * data.tilesW + Math.floor(pe.x)]);
  return { dy: b.y - a.y, dx: b.x - a.x };
};

const cities = [20260909, 20260910, 42].map((seed) => {
  const data = generateCity(seed);
  return { seed, data, map: new CityMap(data), cascade: new CascadeSystem(data) };
});

test('todo seed do jogo tem cachoeira, e nenhuma delas é um riacho', () => {
  for (const { seed, data, cascade } of cities) {
    const list = data.cascatas ?? [];
    assert.ok(list.length >= 1, `seed ${seed} ficou sem cachoeira`);
    assert.ok(list.length <= MAX_CASCATA, `seed ${seed} passou de ${MAX_CASCATA}: ${list.length}`);
    assert.equal(cascade.count, list.length, `seed ${seed}: o sistema descartou corredor do mapa`);
    for (const c of list) {
      assert.ok(c.curso.length >= 3, `seed ${seed} cascata ${c.id}: eixo com ${c.curso.length} amostras`);
      assert.ok(c.queda >= 0.8, `seed ${seed} cascata ${c.id}: desnível de ${c.queda.toFixed(2)} tile`);
      const { dy, dx } = descidaNaTela(c, data);
      assert.ok(dy >= 112, `seed ${seed} cascata ${c.id}: ${dy.toFixed(0)}px de descida na tela`);
      assert.ok(Math.abs(dx) < dy * 0.6,
        `seed ${seed} cascata ${c.id}: ${dx.toFixed(0)}px para o lado em ${dy.toFixed(0)}px de queda`);
    }
  }
});

test('a bacia não afoga quem pisa: nem passeio, nem asfalto mora na água', () => {
  // `isWaterWorld` julga pelo tile que o disco encosta, não pelo centro, então uma bacia
  // perto da rua encharca o tile do node de passeio. Node na água é armadilha sem saída: o
  // pedestre nada em cima do próprio destino e a faixa inteira para atrás dele. O asfalto
  // vale pelo carro. Medido antes do corte: 14 nodes afogados na seed 20260909.
  for (const { seed, data, map } of cities) {
    // Uma regra de bacia que apaga as quedas passa escondida em qualquer teste de "não há
    // água onde não deve haver": a cachoeira continua obrigada a existir aos montes.
    assert.ok((data.cascatas ?? []).length >= 2,
      `seed ${seed}: a regra da bacia deixou só ${(data.cascatas ?? []).length} queda(s)`);
    const afogados = map.sidewalkNodes.filter((n) => map.isWaterWorld(n.x, n.y));
    assert.deepEqual(afogados.map((n) => `${n.x},${n.y}`), [],
      `seed ${seed}: ${afogados.length} nodes de passeio dentro da bacia`);
    const W = data.tilesW;
    const pista = [];
    for (let ty = 0; ty < data.tilesH; ty++) {
      for (let tx = 0; tx < W; tx++) {
        if (data.tiles[ty * W + tx].kind !== 'road') continue;
        if (map.isWaterWorld(tx + 0.5, ty + 0.5)) pista.push(`${tx},${ty}`);
      }
    }
    assert.deepEqual(pista, [], `seed ${seed}: ${pista.length} tiles de asfalto viraram água`);
  }
});

test('a folha desce em coluna: nenhum ponto se perde da reta do lábio ao pé', () => {
  // É a régua do desenho, não do mundo: a folha é um quadrilátero por trecho do fluxo, e
  // uma corrente que curva mais que a própria meia-largura torce a faixa sobre si mesma.
  // A medição é em tela, com a cota de verdade, no mesmo espaço em que o lençol é pintado.
  for (const { seed, data } of cities) {
    for (const c of data.cascatas ?? []) {
      const alt = (p) => data.heights[Math.floor(p.y) * data.tilesW + Math.floor(p.x)];
      const a = worldToScreen(c.curso[0].x, c.curso[0].y, alt(c.curso[0]));
      const fim = worldToScreen(c.curso[c.curso.length - 1].x,
        c.curso[c.curso.length - 1].y, alt(c.curso[c.curso.length - 1]));
      const dx = fim.x - a.x;
      const dy = fim.y - a.y;
      const corda = Math.hypot(dx, dy);
      assert.ok(corda > 100, `seed ${seed} cascata ${c.id}: ${corda.toFixed(0)}px de queda desenhada`);
      let max = 0;
      for (const p of c.curso) {
        const q = worldToScreen(p.x, p.y, alt(p));
        max = Math.max(max, Math.abs((q.x - a.x) * dy - (q.y - a.y) * dx) / corda);
      }
      assert.ok(max <= corda * 0.3,
        `seed ${seed} cascata ${c.id}: o traçado passa ${max.toFixed(0)}px da reta em ${corda.toFixed(0)}px`);
      assert.ok(max <= Math.max(24, corda * 0.3), 'a régua da folha mudou sem revisão');
    }
  }
});

test('a cachoeira é determinística: o mesmo seed dá o mesmo curso', () => {
  for (const { seed, data } of cities) {
    const again = generateCity(seed);
    assert.deepEqual((again.cascatas ?? []).map((c) => [c.id, c.curso.length, c.queda]),
      (data.cascatas ?? []).map((c) => [c.id, c.curso.length, c.queda]),
      `seed ${seed}: a cachoeira mudou de lugar na segunda geração`);
  }
});

test('a cachoeira não mexe no relevo: é camada sobre a encosta, não tile novo', () => {
  for (const { seed, data, map } of cities) {
    for (const c of data.cascatas ?? []) {
      // Bacia navegável sem reescrever o tile: o morro continua com a mesma cota e a mesma
      // classe de chão — um 'water' aqui afundaria a encosta no gerador (bug #115).
      assert.ok(map.isWaterWorld(c.bacia.x, c.bacia.y), `seed ${seed}: a bacia não é água`);
      assert.notEqual(map.tileKindAt(c.bacia.x, c.bacia.y), 'water',
        `seed ${seed}: a bacia virou tile de água`);
      for (const p of c.curso) {
        const t = map.tileKindAt(p.x, p.y);
        assert.ok(t && t !== 'water', `seed ${seed}: o eixo atravessa água feita de tile (${t})`);
        assert.ok(p.x > 0 && p.y > 0 && p.x < data.tilesW && p.y < data.tilesH,
          `seed ${seed}: o eixo sai do mapa`);
      }
      assert.ok(c.bacia.x > 4 && c.bacia.y > 4
        && c.bacia.x < data.tilesW - 4 && c.bacia.y < data.tilesH - 4,
        `seed ${seed}: bacia encostada na borda do mundo`);
    }
  }
});

test('a correnteza empurra rio abaixo, mais forte do que se nada', () => {
  const f = { fx: 0, fy: 0, core: false, near: false };
  for (const { seed, data, cascade } of cities) {
    for (const c of data.cascatas ?? []) {
      const i = Math.floor(c.curso.length / 2);
      const p = c.curso[i];
      assert.ok(cascade.forceAt(p.x, p.y, f), `seed ${seed} cascata ${c.id}: no meio do lençol não há água`);
      assert.ok(f.core && f.near, `seed ${seed} cascata ${c.id}: o meio do lençol não é o núcleo`);
      const { tx, ty } = eixoLocal(c.curso, i);
      const mod = Math.hypot(f.fx, f.fy);
      assert.ok(mod > C.PLAYER_SWIM_SPEED,
        `seed ${seed} cascata ${c.id}: ${mod.toFixed(2)} tiles/s não vence ${C.PLAYER_SWIM_SPEED} de natação`);
      assert.ok((f.fx * tx + f.fy * ty) / mod > 0.9,
        `seed ${seed} cascata ${c.id}: a força não desce o eixo`);
      // A veia acelera até o pé: é o que faz a folha desenhada correr mais embaixo.
      cascade.forceAt(c.curso[1].x, c.curso[1].y, f);
      const topo = Math.hypot(f.fx, f.fy);
      cascade.forceAt(c.curso[c.curso.length - 2].x, c.curso[c.curso.length - 2].y, f);
      assert.ok(Math.hypot(f.fx, f.fy) > topo,
        `seed ${seed} cascata ${c.id}: a água não ganha força na descida`);
    }
  }
});

test('a beira espirrada empurra menos, e longe dela a queda não alcança ninguém', () => {
  const f = { fx: 0, fy: 0, core: false, near: false };
  /** O que a correnteza diz de um ponto: núcleo, beira ou seco, com a força que empurra. */
  const leitura = (cascade, x, y) => {
    cascade.forceAt(x, y, f);
    return { core: f.core, near: f.near, mod: Math.hypot(f.fx, f.fy) };
  };
  for (const { seed, data, cascade } of cities) {
    const todas = data.cascatas ?? [];
    for (const c of todas) {
      const p = c.curso[1];
      // Saia pelo lado: só uma direção que termina em chão seco vale, senão a bacia
      // entraria na conta de "longe" e o teste mediria outra água.
      let raio = null;
      for (let k = 0; k < 24 && !raio; k++) {
        const a = k * Math.PI / 12;
        const fim = { x: p.x + Math.cos(a) * 8, y: p.y + Math.sin(a) * 8 };
        const seco = todas.every((o) => distanciaDoEixo(o.curso, fim.x, fim.y) > 6
          && Math.hypot(fim.x - o.bacia.x, fim.y - o.bacia.y) > o.bacia.raio + 4);
        if (seco) raio = { dx: Math.cos(a), dy: Math.sin(a) };
      }
      assert.ok(raio, `seed ${seed} cascata ${c.id}: não há para onde sair do lençol`);
      const naVeia = leitura(cascade, p.x, p.y);
      assert.ok(naVeia.core && naVeia.mod > 0, `seed ${seed} cascata ${c.id}: o eixo não é a veia`);
      let beiras = 0;
      let ultimaVeia = -1;
      let primeiraBeira = -1;
      let ultimoMolhado = -1;
      for (let d = 0.05; d <= 8; d += 0.05) {
        const l = leitura(cascade, p.x + raio.dx * d, p.y + raio.dy * d);
        if (l.core) ultimaVeia = d;
        if (l.near && !l.core) {
          beiras++;
          if (primeiraBeira < 0) primeiraBeira = d;
          assert.ok(l.mod < naVeia.mod,
            `seed ${seed} cascata ${c.id}: a beira empurra tanto quanto a veia`);
        }
        if (l.near) ultimoMolhado = d;
      }
      assert.ok(beiras > 0, `seed ${seed} cascata ${c.id}: nada espirra fora do lençol`);
      // A beira começa onde a veia acaba, sem faixa muda no meio do caminho.
      assert.ok(primeiraBeira - ultimaVeia < 0.15,
        `seed ${seed} cascata ${c.id}: a beira só aparece a ${primeiraBeira.toFixed(2)} tiles, ` +
        `sendo a veia até ${ultimaVeia.toFixed(2)}`);
      assert.ok(ultimoMolhado < 7.9, `seed ${seed} cascata ${c.id}: a correnteza não morre no chão seco`);
    }
  }
});

test('a bacia gira e solta: empurra para fora, fraco o bastante para nadar para fora', () => {
  const f = { fx: 0, fy: 0, core: false, near: false };
  for (const { seed, data, cascade } of cities) {
    for (const c of data.cascatas ?? []) {
      const pe = c.curso[c.curso.length - 1];
      const margem = meia(c.largura, 1) * C.CASCADE_MARGIN;
      // Um ponto que é bacia e não é lençol: fora da margem do canal, dentro do disco.
      const r = (margem + c.bacia.raio) / 2;
      let p = null;
      for (let k = 0; k < 24 && !p; k++) {
        const a = k * Math.PI / 12;
        const q = { x: pe.x + Math.cos(a) * r, y: pe.y + Math.sin(a) * r };
        if (distanciaDoEixo(c.curso, q.x, q.y) > margem * 1.05) p = q;
      }
      assert.ok(p, `seed ${seed} cascata ${c.id}: a bacia não tem canto fora do lençol`);
      assert.ok(cascade.forceAt(p.x, p.y, f), `seed ${seed} cascata ${c.id}: a bacia não mexe na água`);
      const mod = Math.hypot(f.fx, f.fy);
      assert.ok(!f.core, `seed ${seed} cascata ${c.id}: o giro da bacia machuca`);
      assert.ok(mod < C.PLAYER_SWIM_SPEED,
        `seed ${seed} cascata ${c.id}: ${mod.toFixed(2)} tiles/s na bacia não deixam ninguém sair nadando`);
      const ux = (p.x - pe.x) / r;
      const uy = (p.y - pe.y) / r;
      assert.ok((f.fx * ux + f.fy * uy) / mod > 0.9,
        `seed ${seed} cascata ${c.id}: a bacia não esvazia para fora`);
    }
  }
});

test('quem cai no lençol é levado até a bacia, e a queda dói enquanto segura', () => {
  for (const { seed, data, cascade } of cities) {
    for (const c of data.cascatas ?? []) {
      let feriu = 0;
      const player = { x: c.curso[0].x, y: c.curso[0].y, currentVehicleId: null };
      for (let i = 0; i < 60; i++) {
        cascade.sweep(DT, swept({ player, health: { damage: () => { feriu++; return true; } } }));
      }
      const naBacia = Math.hypot(player.x - c.bacia.x, player.y - c.bacia.y);
      assert.ok(naBacia < c.bacia.raio * 2.4,
        `seed ${seed} cascata ${c.id}: depois de 6s o corpo está a ${naBacia.toFixed(1)} tiles da bacia`);
      assert.ok(feriu > 0, `seed ${seed} cascata ${c.id}: passar pela queda não custa nada`);
      assert.ok(Number.isFinite(player.x) && Number.isFinite(player.y), `seed ${seed}: corpo nanado`);
    }
  }
});

test('NPC, bicho e carro são arrastados junto; dentro de casa ninguém se molha', () => {
  for (const { seed, data, cascade } of cities) {
    const c = (data.cascatas ?? [])[0];
    if (!c) continue;
    const alvo = { x: c.curso[c.curso.length - 2].x, y: c.curso[c.curso.length - 2].y };
    const npc = { ...alvo, dead: false, inVehicle: false };
    const animal = { ...alvo, dead: false, radius: 0.4 };
    const veh = { ...alvo, state: 'alive', altitude: 0, health: 100, id: 7 };
    const voando = { ...alvo, state: 'alive', altitude: 2, health: 100, id: 8 };
    for (let i = 0; i < 10; i++) {
      cascade.sweep(DT, swept({ npcs: [npc], animals: [animal], vehicles: [veh, voando] }));
    }
    // Rio abaixo é (x+y) crescendo: o mesmo eixo que desce na tela.
    const abaixo = (e) => e.x + e.y > alvo.x + alvo.y + 0.2;
    assert.ok(abaixo(npc), `seed ${seed}: o pedestre não desceu (${npc.x.toFixed(1)},${npc.y.toFixed(1)})`);
    assert.ok(abaixo(animal), `seed ${seed}: o bicho não desceu`);
    assert.ok(abaixo(veh), `seed ${seed}: o carro não desceu`);
    assert.ok(veh.health < 100, `seed ${seed}: arrastar o carro na queda não custa lataria`);
    assert.equal(voando.x, alvo.x, `seed ${seed}: a queda puxou quem está voando`);

    const preso = { ...alvo, dead: false, inVehicle: false };
    cascade.sweep(DT, swept({ indoors: true, npcs: [preso] }));
    assert.equal(preso.x, alvo.x, `seed ${seed}: dentro de casa a cachoeira empurrou alguém`);
  }
});

test('o rugido obedece à distância: cheio embaixo da queda, sumido longe de todo eixo', () => {
  for (const { seed, data, cascade } of cities) {
    const todas = data.cascatas ?? [];
    for (const c of todas) {
      const pe = c.curso[c.curso.length - 1];
      const perto = cascade.volumeEm(pe.x, pe.y);
      assert.ok(perto > 0.7, `seed ${seed} cascata ${c.id}: embaixo da queda só ${perto.toFixed(2)}`);
      const meio = cascade.volumeEm(pe.x + C.CASCADE_NOISE_TILES * 0.75, pe.y);
      assert.ok(meio <= perto, `seed ${seed} cascata ${c.id}: o volume cresce com a distância`);
      // Oito saídas: só a que afasta de todo eixo mapa a fora pode exigir silêncio.
      let melhor = null;
      for (let k = 0; k < 8; k++) {
        const a = k * Math.PI / 4;
        const p = {
          x: pe.x + Math.cos(a) * (C.CASCADE_NOISE_TILES + 3),
          y: pe.y + Math.sin(a) * (C.CASCADE_NOISE_TILES + 3),
        };
        let d = Infinity;
        for (const o of todas) for (const q of o.curso) d = Math.min(d, Math.hypot(p.x - q.x, p.y - q.y));
        if (!melhor || d > melhor.d) melhor = { p, d };
      }
      if (melhor.d > C.CASCADE_NOISE_TILES) {
        assert.equal(cascade.volumeEm(melhor.p.x, melhor.p.y), 0,
          `seed ${seed} cascata ${c.id}: ouve-se água a ${melhor.d.toFixed(1)} tiles do eixo`);
      }
    }
  }
});

test('mapa sem cachoeira continua sendo um mapa: nenhuma força, nenhum volume, nenhum crash', () => {
  const vazio = new CascadeSystem({ cascatas: undefined });
  assert.equal(vazio.count, 0);
  const f = { fx: 0, fy: 0, core: false, near: false };
  assert.equal(vazio.forceAt(10, 10, f), false);
  assert.equal(vazio.volumeEm(10, 10), 0);
  const npc = { x: 10, y: 10, dead: false, inVehicle: false };
  vazio.sweep(DT, swept({ npcs: [npc] }));
  assert.equal(npc.x, 10);
  // Número quebrado não derruba a varredura: NaN atravessaria toda comparação de limite.
  const cheio = cities[0].cascade;
  assert.equal(cheio.forceAt(NaN, 12, f), false);
  assert.equal(cheio.volumeEm(Infinity, -Infinity), 0);
  const torto = { x: NaN, y: NaN, dead: false, inVehicle: false };
  cheio.sweep(DT, swept({ npcs: [torto] }));
  assert.ok(Number.isNaN(torto.x), 'a varredura inventou posição para um corpo quebrado');
  cheio.sweep(0, swept({ npcs: [npc] }));
  assert.equal(npc.x, 10, 'dt zero empurrou alguém');
});

console.log(`\nCachoeira checks: ${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
