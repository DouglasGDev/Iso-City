// Contrato: o relevo que se pisa é o relevo que se desenha, e ele não tem degrau.
//
// A reclamação do jogador, em uma frase: "ao passar por relevo o personagem sobe e desce
// no mesmo lugar, parece bugado". A causa é uma só: a cota quantizada por tile é ótima
// para DECIDIR (parede, soleira, rampa de roda) e péssima para APARECER — ao cruzar a
// borda do losango a tela inteira salta até `TERRAIN_MAX_ELEVATION · ELEVATION_PX` pixels
// de uma vez. Este arquivo mede as duas coisas: a altura visual nunca pode dar salto, e
// a regra de movimento continua lendo o tile.
//
// Trocar uma pela outra em qualquer um dos lados quebra o jogo: suavizar a regra faz
// montanha virar rampa livre; quantizar o visual é o solavanco que se vê aqui.
const fs = require('fs');
const path = require('path');
const Module = require('module');
const ts = require('typescript');
const assert = require('assert');
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
  mod.require = (name) => name.startsWith('.') ? load(path.resolve(path.dirname(filename), name)) : require(name);
  modules.set(filename, mod);
  mod._compile(compiled.outputText, filename);
  return mod.exports;
}

const { generateCity } = load(path.join(root, 'src/data/maps/city.ts'));
const { GAME_CONFIG } = load(path.join(root, 'src/game/GameConfig.ts'));
const { Map: CityMap, vertexHeight } = load(path.join(root, 'src/world/Map.ts'));
const { ELEVATION_PX, worldToScreen } = load(path.join(root, 'src/world/IsoUtils.ts'));

// Um passo de 0,02 tile é ~1,3px de tela no eixo X da projeção; a 60fps um pedestre
// anda menos que isso por quadro. Com folga de três quadros, 2px é o teto do que o olho
// ainda lê como deslize — acima disso é o degrau.
const PASSO = 0.02;
const SALTO_MAX = 2;
/** O pior caso físico do dia: um tile inteiro de cota atravessado num único passo. */
const SALTO_DO_DEGRAU = GAME_CONFIG.TERRAIN_MAX_ELEVATION * ELEVATION_PX;

let passed = 0;
const test = (nome, fn) => { fn(); passed++; console.log(`OK ${nome}`); };

for (const seed of [20260909, 20260910, 42]) {
  const data = generateCity(seed);
  const map = new CityMap(data);
  const W = data.tilesW;
  const H = data.tilesH;
  const tag = `seed ${seed}`;

  // A fronteira mais íngreme do mapa: é nela que qualquer salto aparece primeiro.
  let maisÍngreme = { dx: 0, dy: 0, delta: 0 };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const h = data.heights[y * W + x];
      for (const [dx, dy] of [[1, 0], [0, 1]]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= W || ny >= H) continue;
        const d = Math.abs(data.heights[ny * W + nx] - h);
        if (d > maisÍngreme.delta) maisÍngreme = { dx, dy, delta: d, x, y };
      }
    }
  }

  test(`${tag}: a cota visual é exatamente o canto do chão desenhado`, () => {
    // Bilinear num vértice da malha devolve o próprio vértice — é a prova de que sprite e
    // malha leem a mesma superfície, não duas médias parecidas.
    for (const [x, y] of [[0, 0], [1, 1], [Math.floor(W / 2), Math.floor(H / 2)], [W, H], [W - 1, H]]) {
      assert.ok(Math.abs(map.heightSmoothAt(x, y) - vertexHeight(data, x, y)) < 1e-6,
        `o canto (${x}, ${y}) diverge do chão: ${map.heightSmoothAt(x, y)} x ${vertexHeight(data, x, y)}`);
    }
  });

  test(`${tag}: atravessar a encosta mais íngreme desliza, não salta`, () => {
    const { x, y, dx, dy } = maisÍngreme;
    const antes = { x: x + 0.4, y: y + 0.4 };
    const depois = { x: x + dx + 0.4, y: y + dy + 0.4 };
    let piorSuave = 0;
    let piorDegrau = 0;
    const n = Math.ceil(1 / PASSO);
    let ultY = worldToScreen(antes.x, antes.y, map.heightSmoothAt(antes.x, antes.y)).y;
    let ultYTile = worldToScreen(antes.x, antes.y, map.heightAt(antes.x, antes.y)).y;
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      const px = antes.x + (depois.x - antes.x) * t;
      const py = antes.y + (depois.y - antes.y) * t;
      const s = worldToScreen(px, py, map.heightSmoothAt(px, py)).y;
      const q = worldToScreen(px, py, map.heightAt(px, py)).y;
      piorSuave = Math.max(piorSuave, Math.abs(s - ultY));
      piorDegrau = Math.max(piorDegrau, Math.abs(q - ultYTile));
      ultY = s;
      ultYTile = q;
    }
    assert.ok(piorSuave <= SALTO_MAX,
      `a cota visual saltou ${piorSuave.toFixed(2)}px num passo de ${PASSO} tile`);
    // O check tem de ter dentes: se o degrau quantizado também deslizar, não há nada
    // provando aqui — é o gerador que mudou, não a leitura.
    assert.ok(piorDegrau > SALTO_MAX,
      `o tile quantizado também desliza (${piorDegrau.toFixed(2)}px): ${tag} não tem relevo para testar`);
    assert.ok(maisÍngreme.delta > 0, `${tag}: sem encosta no mapa não há o que medir`);
  });

  test(`${tag}: a cota visual nunca sai do intervalo dos quatro cantos`, () => {
    for (let y = 0; y < H; y += 3) {
      for (let x = 0; x < W; x += 3) {
        const cantos = [
          vertexHeight(data, x, y), vertexHeight(data, x + 1, y),
          vertexHeight(data, x, y + 1), vertexHeight(data, x + 1, y + 1),
        ];
        const mín = Math.min(...cantos);
        const máx = Math.max(...cantos);
        for (const [fx, fy] of [[0.3, 0.7], [0.65, 0.15], [0.5, 0.5]]) {
          const h = map.heightSmoothAt(x + fx, y + fy);
          assert.ok(h >= mín - 1e-6 && h <= máx + 1e-6,
            `(${x + fx}, ${y + fy}) = ${h} furou o intervalo [${mín}, ${máx}]`);
        }
      }
    }
  });

  test(`${tag}: fora do mapa a cota encosta na borda, nunca some`, () => {
    for (const [x, y] of [[-4, -4], [-1, H / 2], [W + 5, H + 5], [W + 2, H / 2]]) {
      const h = map.heightSmoothAt(x, y);
      assert.ok(Number.isFinite(h), `(${x}, ${y}) devolveu ${h}`);
      assert.ok(h >= 0 && h <= GAME_CONFIG.TERRAIN_MAX_ELEVATION, `(${x}, ${y}) = ${h}`);
    }
    // Posição NaN não pode virar cota NaN: um único número assim no sprite derruba a
    // árvore de transforms do Skia e a tela fecha em branco.
    assert.equal(map.heightSmoothAt(NaN, 3), 0, 'NaN vazou para a cota visual');
    assert.equal(map.heightSmoothAt(3, Infinity), 0, 'Infinity vazou para a cota visual');
  });

  test(`${tag}: quem decide parede ainda pisa no tile`, () => {
    // `heightAt` é o chão das regras: dentro do mesmo losango ele não se move um dedo.
    for (let y = 1; y < H - 1; y += 7) {
      for (let x = 1; x < W - 1; x += 7) {
        assert.equal(map.heightAt(x + 0.05, y + 0.05), map.heightAt(x + 0.9, y + 0.9),
          `a cota de regra vazou para dentro do tile (${x}, ${y})`);
      }
    }
    // E a subida é medida de losango a losango: é isso que mantém montanha = muro.
    const { x, y, dx, dy } = maisÍngreme;
    const de = map.heightAt(x + 0.4, y + 0.4);
    const para = map.heightAt(x + dx + 0.4, y + dy + 0.4);
    assert.equal(para - de, data.heights[(y + dy) * W + (x + dx)] - data.heights[y * W + x],
      'a comparação de cotas deixou de ser a do tile');
  });

  test(`${tag}: a ladeira que pesa no motor é contínua`, () => {
    // O multiplicador de velocidade nasce de `slopeAlong`. Medido no tile, ele piscaria a
    // cada borda cruzada — é o "carro com stuttering" subindo rua inclinada.
    const { x, y, dx, dy } = maisÍngreme;
    const meio = { x: x + 0.4, y: y + 0.4 };
    const passo = { x: dx / Math.SQRT2, y: dy / Math.SQRT2 };
    let antes = map.slopeAlong(meio.x, meio.y, passo.x, passo.y);
    for (let i = 1; i <= 20; i++) {
      const t = i / 20;
      const px = meio.x + dx * t;
      const py = meio.y + dy * t;
      const agora = map.slopeAlong(px, py, passo.x, passo.y);
      assert.ok(Math.abs(agora - antes) < 0.25,
        `a inclinação deu salto de ${Math.abs(agora - antes).toFixed(3)} em (${px.toFixed(2)}, ${py.toFixed(2)})`);
      antes = agora;
    }
  });
}

test(`o degrau que sumiu é o que estava lá: ${SALTO_DO_DEGRAU}px de uma vez`, () => {
  // Só um registro do tamanho do problema: um tile de cota a menos que o teto do pé já é
  // metade da tela. Se `TERRAIN_MAX_ELEVATION` mudar, isto aqui avisa.
  assert.ok(SALTO_DO_DEGRAU >= 128, `teto de elevação diminuiu: ${SALTO_DO_DEGRAU}px`);
});

console.log(`Relief smooth checks: ${passed} passed, 0 failed.`);
