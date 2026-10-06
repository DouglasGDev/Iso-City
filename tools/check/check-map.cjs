// Run against current sources, not potentially stale dist-test output. No files emitted.
const fs = require('fs');
const path = require('path');
const Module = require('module');
const ts = require('typescript');
const { PNG } = require('pngjs');
const { performance } = require('perf_hooks');
const root = path.resolve(__dirname, '../..');
const modules = new Map();
const skia = {
  PaintStyle: { Stroke: 'stroke' },
  Skia: {
    Color: (color) => color,
    Paint: () => ({ setColor(color) { this.color = color; }, setStyle() {}, setStrokeWidth() {}, setAntiAlias() {} }),
    Path: { Make: () => ({ moveTo() {}, lineTo() {}, close() {}, rewind() {} }) },
  },
};
function load(filename) {
  if (!path.extname(filename)) filename += '.ts';
  if (modules.has(filename)) return modules.get(filename).exports;
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    fileName: filename, compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  });
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.require = (name) => name === '@shopify/react-native-skia' ? skia
    : name.startsWith('.') ? load(path.resolve(path.dirname(filename), name)) : require(name);
  modules.set(filename, mod);
  mod._compile(compiled.outputText, filename);
  return mod.exports;
}
const { generateCity } = load(path.join(root, 'src/data/maps/city.ts'));
const { GAME_CONFIG } = load(path.join(root, 'src/game/GameConfig.ts'));
const { VEHICLE_DEFS } = load(path.join(root, 'src/data/vehicles.ts'));
const { BUILDING_CATALOG } = load(path.join(root, 'src/data/buildings.ts'));
const { BUILDING_GEOMETRY } = load(path.join(root, 'src/assets/BuildingGeometry.ts'));
const { Map: CityMap } = load(path.join(root, 'src/world/Map.ts'));
const { drawRoad } = load(path.join(root, 'src/render/RoadPainter.ts'));
const { worldToScreen } = load(path.join(root, 'src/world/IsoUtils.ts'));
const { FogSystem, FOG } = load(path.join(root, 'src/systems/FogSystem.ts'));

const manifest = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'assets', 'AssetManifest.ts'), 'utf8');
const registered = new Set([...manifest.matchAll(/"([^"]+\.png)": require\(/g)].map((m) => m[1]));
const catalog = new Map(BUILDING_CATALOG.map((entry) => [entry.name, entry]));
const naturalBiomes = ['forest', 'countryside', 'beach', 'pinewood', 'savanna', 'desert'];
// Os postos da hierarquia que o gerador declara. `access` é a derivação de uma instalação:
// ilegal como rua solta (beco sem saída o grafo dirigido não aceita), obrigatório como pátio
// da rodoviária. A régua abaixo é a que separa um do outro.
const RANKS = ['highway', 'avenue', 'street', 'residential', 'access'];
const ARTERIAIS = ['highway', 'avenue'];
// Cada reserva tem a sua própria trilha seca: terra batida na mata, areia clara
// pisada na praia e no deserto. O gerador escreve exatamente estas chaves.
const TRAIL_KEY = { forest: 'tile_ground_dirt', countryside: 'tile_ground_dirt',
  pinewood: 'tile_ground_dirt', savanna: 'tile_ground_dirt',
  beach: 'tile_ground_sand_dune', desert: 'tile_ground_sand_beach' };
const isTrail = (t) => !!t && TRAIL_KEY[t.biome] === t.key;
const spritesDir = path.join(__dirname, '..', '..', 'assets', 'sprites');
const existing = new Set();
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.toLowerCase().endsWith('.png')) {
      existing.add(path.relative(spritesDir, full).split(path.sep).join('/'));
    }
  }
})(spritesDir);
const hasAsset = (key) => existing.has(key) && registered.has(key);
// Read the real PNG alpha, not a mocked size or transparent canvas bounds.
const fenceImages = Object.fromEntries(['prop_fence_wood_a', 'prop_fence_wood_b', 'prop_fence_wire_a']
  .map((key) => [key, PNG.sync.read(fs.readFileSync(path.join(spritesDir, 'Props', key + '.png')))]));
const fenceGeometry = {
  prop_fence_wood_a: { size: [46, 39], anchor: [19, 29], ends: [[3, 21], [35, 37]], axis: 'x' },
  prop_fence_wood_b: { size: [45, 41], anchor: [19, 29], ends: [[35, 21], [3, 37]], axis: 'y' },
  prop_fence_wire_a: { size: [46, 42], anchor: [19, 31], ends: [[3, 23], [35, 39]], axis: 'x' },
};

let errors = 0;
const report = (ok, msg) => {
  if (!ok) {
    errors++;
    console.error('ERRO: ' + msg);
  }
};
const steps = [[1, 0, 'SE'], [-1, 0, 'NW'], [0, 1, 'SW'], [0, -1, 'NE']];
const circleHits = (p, radius, r) => {
  const dx = p.x - Math.max(r.x0, Math.min(p.x, r.x1));
  const dy = p.y - Math.max(r.y0, Math.min(p.y, r.y1));
  return dx * dx + dy * dy <= radius * radius;
};
const overlaps = (a, b) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
// Fence AABBs replace the old point approximation; decorative props retain 0.6x0.6.
const propRect = (p) => p.collider
  ? { x0: p.collider.x, y0: p.collider.y, x1: p.collider.x + p.collider.width, y1: p.collider.y + p.collider.height }
  : { x0: p.x - 0.3, y0: p.y - 0.3, x1: p.x + 0.3, y1: p.y + 0.3 };
const reachable = (adj, start = 0) => {
  if (!adj.length) return 0;
  const seen = new Uint8Array(adj.length);
  const queue = [start];
  seen[start] = 1;
  for (let i = 0; i < queue.length; i++) {
    for (const next of adj[queue[i]]) {
      if (!seen[next]) { seen[next] = 1; queue.push(next); }
    }
  }
  return queue.length;
};

/**
 * ---- Janela de neblina: o teto de mobile de verdade -------------------------
 * O contrato antigo contava o mapa inteiro ("756 props no mundo"). Nunca foi isso que
 * pesa no celular: o render descarta tudo que a janela de neblina não alcança, então quem
 * decide o quadro é o PIOR ponto do mundo, não a soma dele. Aqui se refaz exatamente o
 * que `buildStaticNodes` + `FogSystem.intersects` fazem, com o PNG e a âncora reais de
 * cada sprite, varrendo a câmera pelo mapa. É o que permite lotar a serra de árvore sem
 * prometer fluidez no escuro.
 */
const TELEFONE = { w: 844, h: 390 };
const pngTam = new Map();
function tamPNG(key) {
  if (!pngTam.has(key)) {
    const arq = path.join(spritesDir, key);
    pngTam.set(key, fs.existsSync(arq) ? PNG.sync.read(fs.readFileSync(arq)) : null);
  }
  return pngTam.get(key);
}
function spritesEstaticos(city) {
  const noAlto = (x, y) => city.heights[Math.max(0, Math.min(city.tilesW * city.tilesH - 1,
    Math.floor(y) * city.tilesW + Math.floor(x)))];
  const nodes = [];
  for (const b of city.buildings) {
    const img = tamPNG(`Buildings/${b.key}.png`);
    const g = BUILDING_GEOMETRY[b.key];
    if (!img || !g) continue;
    const escala = b.footprintW * 64 / g.span;
    const w = img.width * escala, h = img.height * escala;
    const p = worldToScreen(b.x, b.y, noAlto(b.x, b.y));
    nodes.push({ x: p.x + w / 2 - g.anchorX * escala, y: p.y + h - g.anchorY * escala, w, h });
  }
  for (const pr of city.props) {
    const img = tamPNG(`Props/${pr.key}.png`);
    if (!img) continue;
    const escala = pr.renderScale ?? 1;
    const w = img.width * escala, h = img.height * escala;
    const a = pr.renderAnchor ?? { x: 0.5, y: 1 };
    const p = worldToScreen(pr.x, pr.y, noAlto(pr.x, pr.y));
    nodes.push({ x: p.x + w * (0.5 - a.x), y: p.y + h * (1 - a.y), w, h });
  }
  return nodes;
}
function janelaPior(city, nodes) {
  const fog = new FogSystem();
  const zoom = GAME_CONFIG.ZOOM_DEFAULT;
  const amostra = [];
  for (let cy = 3; cy < city.tilesH - 3; cy += 4) {
    for (let cx = 3; cx < city.tilesW - 3; cx += 4) {
      const h = city.heights[Math.floor(cy) * city.tilesW + Math.floor(cx)];
      const view = fog.view({ camera: { x: cx, y: cy, zoom, h }, viewW: TELEFONE.w, viewH: TELEFONE.h });
      let n = 0;
      for (const s of nodes) {
        if (fog.intersects(view, s.x - s.w / 2, s.y - s.h, s.w, s.h)) n++;
      }
      amostra.push(n);
    }
  }
  amostra.sort((a, b) => a - b);
  return { varreduras: amostra.length, mediana: amostra[amostra.length >> 1],
    p99: amostra[Math.floor(amostra.length * 0.99)], max: amostra[amostra.length - 1] };
}

function validate(city, seed, generationMs) {
  const check = (ok, msg) => report(ok, `seed ${seed}: ${msg}`);
  // Números que só interessam para a linha de estatística do fim.
  const medido = {};
  const W = city.tilesW;
  const H = city.tilesH;
  const tileAt = (x, y) => x >= 0 && y >= 0 && x < W && y < H ? city.tiles[y * W + x] : undefined;
  const isRoad = (x, y) => tileAt(x, y)?.kind === 'road';
  const isRiver = (x, y) => tileAt(x, y)?.kind === 'water' || tileAt(x, y)?.bridge;
  const isSidewalk = (x, y) => {
    const t = tileAt(x, y);
    if (!t || t.kind === 'road' || t.kind === 'water') return false;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) if (isRoad(x + dx, y + dy)) return true;
    }
    return false;
  };
  const cells = (r, fn) => {
    for (let y = Math.floor(r.y0 + 1e-7); y <= Math.floor(r.y1 - 1e-7); y++) {
      for (let x = Math.floor(r.x0 + 1e-7); x <= Math.floor(r.x1 - 1e-7); x++) fn(x, y);
    }
  };

  check(W === 240 && H === 240, `dimensoes esperadas 240x240, recebidas ${W}x${H}`);
  check(Math.abs(W * H / (160 * 160) - 2.25) < 1e-9, 'expansao deve aumentar area em 125%');
  check(W === GAME_CONFIG.MAP_TILES_W && H === GAME_CONFIG.MAP_TILES_H, 'dimensoes nao seguem GAME_CONFIG');
  check(city.worldW === W && city.worldH === H && city.tiles.length === W * H, 'dimensoes/array de tiles inconsistentes');
  const roadTiles = [];
  const riverTiles = [];
  const porRanko = new Map();
  const tilesPorRanko = {};
  let waterTop = H;
  let waterBottom = 0;
  let crosswalks = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const t = tileAt(x, y);
      // Estrada não é sprite: o RoadPainter desenha o pavimento a partir da chave.
      if (t?.kind === 'road') {
        check(/^tile_road_(dirt_)?(straight_(SE|SW)|xsing|pelican_(NE|NW|SE|SW)|bridge_body_SW)_normal$/.test(t.key),
          `chave de estrada fora do repertório pintado: ${t.key} em (${x},${y})`);
      } else {
        check(!!t && hasAsset('Roads and Grounds/' + t.key + '.png'), `tile inexistente/nao registrado ${t?.key} em (${x},${y})`);
      }
      if (!t) continue;
      // Fora da reserva a calçada é concreto; dentro dela a beira da estrada de
      // terra é o próprio terreno, sem meio-fio pavimentado.
      if (isSidewalk(x, y)) check(naturalBiomes.includes(t.biome)
        ? t.kind === 'grass' || t.kind === 'dirt'
        : t.kind === 'concrete', `calcada descontinua em (${x},${y})`);
      if (isRiver(x, y)) { riverTiles.push(y * W + x); waterTop = Math.min(waterTop, y); waterBottom = Math.max(waterBottom, y); }
      if (t.kind !== 'road') { check(!t.bridge, 'ponte nao e estrada'); continue; }
      roadTiles.push(y * W + x);
      check(x >= 3 && y >= 3 && x < W - 3 && y < H - 3, `estrada solta na borda (${x},${y})`);
      // Fora da reserva a avenida é asfalto; dentro dela a mesma malha é estrada
      // de terra, e só a ponte sobre o rio continua pavimentada.
      const dirtRoad = t.key.includes('dirt');
      check(naturalBiomes.includes(t.biome) ? dirtRoad !== !!t.bridge : !dirtRoad,
        `pavimento errado em (${x},${y})`);
      // Hierarquia viária é dado do mapa, não tinta: sem posto o tile não diz velocidade
      // de cruzeiro, nem custo de rota, nem onde um ônibus pode parar.
      check(RANKS.includes(t.rank), `estrada sem posto na hierarquia (${x},${y})`);
      porRanko.set(t.rank, (porRanko.get(t.rank) ?? 0) + 1);
      (tilesPorRanko[t.rank] ??= []).push(y * W + x);
      check(steps.filter(([dx, dy]) => isRoad(x + dx, y + dy)).length >= 2, `ponta solta (${x},${y})`);
      if (t.lane == null) {
        const inJunction = [x - 1, x].some((jx) => [y - 1, y].some((jy) =>
          [[0, 0], [1, 0], [0, 1], [1, 1]].every(([dx, dy]) => {
            const n = tileAt(jx + dx, jy + dy);
            return n?.kind === 'road' && n.lane === null && !n.bridge;
          })));
        check(t.lane === null && inJunction, `cruzamento nao e 2x2 (${x},${y})`);
      } else {
        const twin = { NW: [0, 1, 'SE'], SE: [0, -1, 'NW'], SW: [1, 0, 'NE'], NE: [-1, 0, 'SW'] }[t.lane];
        check(!!twin && tileAt(x + twin[0], y + twin[1])?.lane === twin[2], `faixa dupla/sentido incorreto (${x},${y})`);
      }
      if (t.key.includes('pelican')) {
        crosswalks++;
        check(!t.bridge && !!t.lane && steps.some(([dx, dy]) => tileAt(x + dx, y + dy)?.lane === null), `faixa longe do cruzamento (${x},${y})`);
        const stripes = [];
        // O painter recebe a cota dos quatro cantos do tile, que é o que a malha do
        // GroundLayer desenha. Faixa de pedestre só existe na cidade, e a cidade é
        // travada em zero pelo contrato do relevo — os quatro cantos são o próprio tile.
        const h = city.heights[y * city.tilesW + x] ?? 0;
        drawRoad({ drawPath() {}, drawLine(x1, y1, x2, y2, paint) {
          if (paint.color === '#ecebe5') stripes.push([x1, y1, x2, y2]);
        } }, city, x, y, h, h, h, h);
        check(stripes.length === 5, `faixa sem cinco barras (${x},${y})`);
        // O painter eleva o tile inteiro em h * 64 px; o inverso tem que devolver essa
        // elevação antes de recalcular o tile, senão a barra "invade" o vizinho de mentirinha.
        const lift = h * 64;
        for (const [sx, sy, ex, ey] of stripes) {
          const dx = (ex - sx) / 128 + (ey - sy) / 64;
          const dy = (ey - sy) / 64 - (ex - sx) / 128;
          const alongX = t.lane === 'SE' || t.lane === 'NW';
          check(Math.abs(alongX ? dy : dx) < 1e-9 && Math.abs(Math.abs(alongX ? dx : dy) - 0.8) < 1e-9,
            `barras invertidas no sentido ${t.lane} (${x},${y})`);
          for (const [px, py] of [[sx, sy], [ex, ey]]) {
            const wx = px / 128 + (py + lift) / 64, wy = (py + lift) / 64 - px / 128;
            check(wx > x && wx < x + 1 && wy > y && wy < y + 1, 'barra invade tile vizinho');
          }
        }
      }
    }
  }
  check(crosswalks > 0 && crosswalks < roadTiles.length / 8, 'faixas de pedestre ausentes ou excessivas');

  // Test the actual runtime road graph, including both directions of reachability.
  const npcOrder = JSON.stringify(city.npcSpawns);
  const vehicleOrder = JSON.stringify(city.vehicles);
  const mapStart = performance.now();
  const map = new CityMap(city);
  const mapMs = performance.now() - mapStart;
  check(map.roadNodes.length === roadTiles.length && roadTiles.length > 1000, 'grafo viario incompleto');
  check(reachable(map.roadUndirected) === roadTiles.length, 'mais de um componente de estradas');
  check(reachable(map.roadOut) === roadTiles.length, 'transito nao alcanca todas as faixas');
  const reverse = map.roadOut.map(() => []);
  map.roadOut.forEach((neighbors, i) => neighbors.forEach((n) => reverse[n].push(i)));
  check(reachable(reverse) === roadTiles.length, 'transito sem rota de retorno');
  for (let i = 0; i < map.roadNodes.length; i++) check(map.roadOut[i].length > 0, `faixa sem saida ${i}`);

  // Bridge components must be exactly two lanes, without sister-lane exit shortcuts.
  const bridgeSeen = new Set();
  let bridgeCount = 0;
  for (const index of roadTiles) {
    if (!city.tiles[index].bridge || bridgeSeen.has(index)) continue;
    bridgeCount++;
    const queue = [index];
    bridgeSeen.add(index);
    for (let i = 0; i < queue.length; i++) {
      const x = queue[i] % W;
      const y = Math.floor(queue[i] / W);
      for (const [dx, dy] of steps) {
        const next = (y + dy) * W + x + dx;
        if (tileAt(x + dx, y + dy)?.bridge && !bridgeSeen.has(next)) { bridgeSeen.add(next); queue.push(next); }
      }
    }
    const x0 = Math.min(...queue.map((i) => i % W));
    const x1 = Math.max(...queue.map((i) => i % W));
    const y0 = Math.min(...queue.map((i) => Math.floor(i / W)));
    const y1 = Math.max(...queue.map((i) => Math.floor(i / W)));
    check(x1 - x0 === 1 && y1 - y0 >= 2 && y1 - y0 < 12 && queue.length === 2 * (y1 - y0 + 1), 'ponte nao e um vao retangular de duas faixas');
    for (let x = x0; x <= x1; x++) {
      for (const y of [y0 - 2, y0 - 1, y1 + 1, y1 + 2]) check(isRoad(x, y) && !tileAt(x, y).bridge, `ponte sem saida seca (${x},${y})`);
    }
    for (let y = y0; y <= y1; y++) check(tileAt(x0 - 1, y)?.kind === 'water' && tileAt(x1 + 1, y)?.kind === 'water', 'ponte alargada/fora do rio');
    const route = map.findRoadPath(x0 + 0.5, y0 - 1.5, x0 + 0.5, y1 + 2.5);
    check(route.length >= y1 - y0 + 4, 'ponte sem rota dirigida entre margens');
  }
  check(bridgeCount >= 3, `apenas ${bridgeCount} travessias`);
  check(riverTiles.length > W * 2 && waterTop > H * 0.35 && waterBottom < H * 0.65, 'rio ausente ou fora das margens centrais');
  for (let y = waterTop; y <= waterBottom; y++) {
    for (let x = 0; x < W; x++) check(isRiver(x, y), `rio interrompido/canal quadriculado (${x},${y})`);
  }

  // Full south-point ground footprint, with no old 0.08 clipping tolerance.
  const buildingRects = [];
  const biomes = new Set();
  for (const b of city.buildings) {
    check(hasAsset('Buildings/' + b.key + '.png'), `building inexistente/nao registrado ${b.key}`);
    const rect = { x0: b.x - b.footprintW, y0: b.y - b.footprintW, x1: b.x, y1: b.y, key: b.key };
    check(rect.x0 > 0 && rect.y0 > 0 && rect.x1 < W && rect.y1 < H, `building fora do mapa ${b.key}`);
    check(b.footprintW > 0 && b.footprintH > 0, `footprint invalido ${b.key}`);
    const biome = tileAt(Math.floor(b.x), Math.floor(b.y))?.biome;
    biomes.add(biome);
    const entry = catalog.get(b.key);
    const scale = b.tag === 'warehouse' ? 1.5 : 1;
    check(!!entry && entry.tag === b.tag && Math.abs(b.footprintW - entry.footprintW * scale) < 1e-7
      && Math.abs(b.footprintH - entry.footprintH * scale) < 1e-7, `escala/familia incorreta ${b.key}`);
    cells(rect, (x, y) => {
      const t = tileAt(x, y);
      check(!!t && t.kind !== 'road' && t.kind !== 'water' && !isSidewalk(x, y), `building ${b.key} invadiu estrada/agua/calcada (${x},${y})`);
      check(t?.biome === biome && biome !== 'park', `building ${b.key} cruza distritos/parque`);
    });
    cells({ x0: rect.x0 - 0.65, y0: rect.y0 - 0.65, x1: rect.x1 + 0.65, y1: rect.y1 + 0.65 }, (x, y) => {
      check(!isSidewalk(x, y), `building ${b.key} sem recuo de 0.65 da calcada`);
    });
    for (const o of buildingRects) check(!overlaps(rect, o), `buildings ${b.key} e ${o.key} se sobrepoem`);
    if (biome === 'industrial' || biome === 'docks') {
      // O barracão continua maior que a casa; o que mudou é que o polígono também
      // tem escritório e posto, então só essas famílias dividem o lote com ele.
      check(b.tag === 'warehouse' && b.footprintW >= 3 || /^bld_(office_small|gasstation)_/.test(b.key),
        'zona industrial sem armazens maiores');
    }
    buildingRects.push(rect);
  }
  // Encostar no teto de prédios não é "denso o bastante": é o orçamento cheio, e as
  // quadras do fim da lista acordam vazias.
  check(city.buildings.length > 500 && city.buildings.length < 1200, 'esperados mais de 500 buildings dentro do limite mobile');
  check(biomes.size >= 7, 'distritos habitados ausentes');

  // Cada distrito tem de aparecer com cara própria: se o sorteio voltar a fechar
  // numa família só, a cidade inteira acorda igual de novo.
  const familiesPerBiome = new Map();
  for (const b of city.buildings) {
    const biome = tileAt(Math.floor(b.x), Math.floor(b.y))?.biome;
    familiesPerBiome.set(biome, (familiesPerBiome.get(biome) ?? new Set())
      .add(b.key.replace(/^bld_/, '').replace(/_[ab]$/, '')));
  }
  for (const biome of ['residential', 'suburb', 'downtown', 'commercial', 'market', 'industrial']) {
    const size = familiesPerBiome.get(biome)?.size ?? 0;
    check(size >= 4, `distrito ${biome} sortudo demais: só ${size} familias de imovel`);
  }

  // A tipologia desenhada para a reserva (tools/prepare-biome-buildings.cjs) tem de
  // aparecer no chão dela: familia que o gerador nao usa e catalogo de enfeite.
  const reserveSignature = {
    forest: 'cabin_log', pinewood: 'cabin_log', countryside: 'farm_barn',
    savanna: 'adobe_house', beach: 'beach_bungalow', desert: 'adobe_house',
  };
  for (const [biome, family] of Object.entries(reserveSignature)) {
    check((familiesPerBiome.get(biome) ?? new Set()).has(family), `reserva ${biome} sem nenhum ${family}`);
  }

  // Uniformity is checked over each land block bounded by avenue junctions.
  // Keep these paths protected independently of the generator's private masks.
  const protectedPaths = new Set();
  city.tiles.forEach((t, i) => {
    if (isTrail(t)) protectedPaths.add(i);
  });
  const naturalBlocks = { forest: 0, countryside: 0, beach: 0, pinewood: 0, savanna: 0, desert: 0 };
  let naturalLots = 0;
  const xLines = [];
  const yLines = [];
  const firstRoad = roadTiles[0];
  const firstX = firstRoad % W;
  const firstY = Math.floor(firstRoad / W);
  // Caixa de cruzamento não identifica linha de avenida sozinha: a boca de uma rua local
  // é exatamente o mesmo desenho de 2x2. Quem separa uma da outra é o posto na
  // hierarquia, lido uma célula depois da boca — ali a avenida continua, a rua não.
  const arterial = (rank) => rank === 'avenue' || rank === 'highway';
  for (let x = 0; x < W; x++) if (tileAt(x, firstY)?.lane === null && tileAt(x - 1, firstY)?.lane !== null
    && arterial(tileAt(x, firstY + 2)?.rank)) xLines.push(x);
  for (let y = 0; y < H; y++) if (tileAt(firstX, y)?.lane === null && tileAt(firstX, y - 1)?.lane !== null) yLines.push(y);
  for (let row = 0; row < yLines.length - 1; row++) {
    if (yLines[row] < waterTop && yLines[row + 1] > waterBottom) continue;
    for (let col = 0; col < xLines.length - 1; col++) {
      const biome = tileAt(xLines[col] + 2, yLines[row] + 2)?.biome;
      const cx = (xLines[col] + 2 + xLines[col + 1]) / 2;
      const cy = (yLines[row] + 2 + yLines[row + 1]) / 2;
      for (let y = yLines[row] + 2; y < yLines[row + 1]; y++) {
        for (let x = cx - 1; x < cx + 1; x++) protectedPaths.add(y * W + x);
      }
      const blockBuildings = city.buildings.filter((b) => b.x > xLines[col] + 2 && b.x < xLines[col + 1]
        && b.y > yLines[row] + 2 && b.y < yLines[row + 1]);
      if (naturalBiomes.includes(biome)) {
        naturalBlocks[biome]++;
        naturalLots += blockBuildings.length;
        // Reserva com casa é sítio, não loteamento: três prédios por quadra é o teto
        // do que continua lendo como mata/areia/campo no meio do mapa.
        check(blockBuildings.length <= 3, `reserva ${col},${row} virou loteamento (${blockBuildings.length} predios)`);
        for (let y = cy - 1; y < cy + 1; y++) {
          for (let x = xLines[col] + 2; x < xLines[col + 1]; x++) protectedPaths.add(y * W + x);
        }
      }
      // Variedade é o contrato da quadra: uma fileira do mesmo sprite é a reclamação
      // do usuário. As reservas cívicas (hospital/esquadra/armaria) são únicas por
      // desenho e ficam fora da contagem.
      const lots = blockBuildings.filter((b) => !/^bld_(hospital|policestation|gunshop)_/.test(b.key));
      const familyOf = (key) => key.replace(/^bld_/, '').replace(/_[ab]$/, '');
      const families = new Set(lots.map((b) => familyOf(b.key)));
      const share = new Map();
      for (const b of lots) share.set(familyOf(b.key), (share.get(familyOf(b.key)) ?? 0) + 1);
      check(lots.length < 2 || families.size > 1,
        `quadra ${col},${row} repetiu a mesma familia em ${lots.length} lotes`);
      check(lots.length < 4 || Math.max(...share.values()) <= lots.length / 2,
        `quadra ${col},${row} concentrou ${Math.max(...share.values())}/${lots.length} lotes na mesma familia`);
      const rowsOfLots = new Map();
      for (const b of lots) {
        const key = Math.round(b.y * 100);
        rowsOfLots.set(key, [...(rowsOfLots.get(key) ?? []), b]);
      }
      for (const list of rowsOfLots.values()) {
        list.sort((a, b) => a.x - b.x);
        for (let i = 1; i < list.length; i++) {
          // Só quem encosta no vizinho conta: do outro lado do corredor da quadra
          // fica a entrada pedonal, e ali a repetição não é parede, é esquina.
          if (list[i].x - list[i - 1].x > list[i].footprintW + 1.5) continue;
          check(familyOf(list[i].key) !== familyOf(list[i - 1].key),
            `fachada repetida lado a lado na quadra ${col},${row}`);
        }
      }
      for (let y = yLines[row] + 2; y < yLines[row + 1]; y++) {
        for (let x = xLines[col] + 2; x < xLines[col + 1]; x++) check(tileAt(x, y)?.biome === biome, `quadra com biomas misturados (${x},${y})`);
      }
    }
  }

  // Reserva sem um único morador é a outra metade da reclamação: o mapa parava de
  // ter prédio fora da cidade. Cada bioma natural tem de mostrar casa própria,
  // dentro do teto que ainda deixa a reserva lendo como reserva.
  check(naturalLots > 0 && naturalLots <= 90, `reservas com ${naturalLots} predios (esperado entre 1 e 90)`);
  const settledNatural = new Set();
  for (const b of city.buildings) {
    const biome = tileAt(Math.floor(b.x), Math.floor(b.y))?.biome;
    if (naturalBiomes.includes(biome)) settledNatural.add(biome);
  }
  for (const biome of naturalBiomes) {
    check(settledNatural.has(biome), `reserva ${biome} continua sem nenhum morador`);
  }

  const fenceProps = city.props.filter((p) => /fence/i.test(p.key));
  const fences = fenceProps.map(propRect);
  const safeSpawn = (p, label) => {
    check(Number.isFinite(p.x) && Number.isFinite(p.y) && p.x > 0.2 && p.x < W - 0.2 && p.y > 0.2 && p.y < H - 0.2, `${label} fora do mapa`);
    const t = tileAt(Math.floor(p.x), Math.floor(p.y));
    // Calçada urbana é concreto; na reserva o pedestre nasce no terreno da orla.
    const walkable = naturalBiomes.includes(t?.biome) ? t.kind === 'grass' || t.kind === 'dirt'
      : t?.kind === 'concrete';
    check(walkable && isSidewalk(Math.floor(p.x), Math.floor(p.y)), `${label} fora de calcada livre`);
    check(!buildingRects.some((r) => circleHits(p, 0.2, r)), `${label} colide com building`);
    check(!fences.some((r) => circleHits(p, 0.2, r)), `${label} colide com cerca`);
    cells({ x0: p.x - 0.2, y0: p.y - 0.2, x1: p.x + 0.2, y1: p.y + 0.2 }, (x, y) => {
      const kind = tileAt(x, y)?.kind;
      check(!!kind && kind !== 'water' && kind !== 'road', `${label} circulo invade agua/estrada`);
    });
  };
  for (const p of city.props) {
    check(hasAsset('Props/' + p.key + '.png'), `prop inexistente/nao registrado ${p.key}`);
    const r = propRect(p);
    cells(r, (x, y) => check(!!tileAt(x, y) && !isRoad(x, y) && tileAt(x, y).kind !== 'water' && !isSidewalk(x, y), `prop ${p.key} bloqueia calcada/agua/estrada`));
    check(!buildingRects.some((b) => overlaps(r, b)), `prop ${p.key} sobre building`);
  }
  // O que pesa no celular é o pior quadro, não o mapa inteiro: ver o comentário de
  // `spritesEstaticos`. O teto do mundo continua existindo (memória e custo de geração),
  // só que na ordem de grandeza certa — e medido, não chutado.
  check(city.props.length <= 3600, 'cenario excede o teto de props do mundo');
  {
    const estaticos = spritesEstaticos(city);
    check(estaticos.length === city.props.length + city.buildings.length,
      'sprite sem PNG/geometria legivel na varredura de janela');
    const janela = janelaPior(city, estaticos);
    // Medido no gerador atual: mediana 6, p99 33, pior quadro 42 sprites estáticos.
    // O teto abaixo é folga de ~70% sobre o pior, não uma licença para crescer.
    check(janela.max <= 72, `pior quadro de cena tem ${janela.max} sprites estaticos (limite mobile)`);
    medido.janela = `${janela.varreduras} vistas: mediana ${janela.mediana} p99 ${janela.p99} max ${janela.max}`;
  }
  const urbanProps = city.props.filter((p) => !p.collider && !naturalBiomes.includes(tileAt(Math.floor(p.x), Math.floor(p.y))?.biome));
  check(urbanProps.length <= 150, 'decoracao urbana consumiu reserva de arvores/cercas');
  check(urbanProps.filter((p) => p.y < waterTop).length >= 40 && urbanProps.filter((p) => p.y > waterBottom).length >= 40,
    'decoracao urbana concentrada em apenas uma margem');
  check(fenceProps.length >= 36 && fenceProps.length <= 72 && fenceProps.length % 6 === 0, 'esperados 6 a 12 jardins completos com 6 paineis cada');
  check(new Set(fenceProps.map((p) => p.key)).size === 3, 'cercas devem usar madeira nas duas direcoes e arame');
  for (const p of fenceProps) {
    const g = fenceGeometry[p.key], image = fenceImages[p.key], c = p.collider;
    check(!!g && !!c && !!p.renderAnchor && p.renderScale > 0, 'cerca sem contrato fisico/visual completo');
    if (!g || !c || !p.renderAnchor || !image) continue;
    check(image.width === g.size[0] && image.height === g.size[1], `dimensoes PNG ${p.key} mudaram`);
    check([c.x, c.y, c.width, c.height, p.renderScale, p.renderAnchor.x, p.renderAnchor.y].every(Number.isFinite), 'cerca com coordenadas nao finitas');
    check(c.width > 0 && c.height > 0 && Math.abs(Math.min(c.width, c.height) - 0.12) < 1e-7, 'espessura da cerca nao e 0.12');
    check((g.axis === 'x') === (c.width > c.height), 'sprite/collider com orientacoes diferentes');
    check(Math.abs(p.x - c.x - c.width / 2) < 1e-7 && Math.abs(p.y - c.y - c.height / 2) < 1e-7, 'anchor mundo nao coincide com centro AABB');
    check(Math.abs(p.renderAnchor.x * image.width - g.anchor[0]) < 1e-7
      && Math.abs(p.renderAnchor.y * image.height - g.anchor[1]) < 1e-7, 'anchor nao corresponde a base opaca do PNG');
    const endpoints = g.ends.map(([px, py]) => {
      // Post feet must actually touch opaque pixels (allow one pixel at bottom edge).
      const touchesAlpha = [-1, 0, 1].some((dy) => [-1, 0, 1].some((dx) =>
        image.data[((py + dy) * image.width + px + dx) * 4 + 3] > 127));
      check(touchesAlpha, `base do poste ${p.key} fora dos pixels opacos`);
      const sx = (px - p.renderAnchor.x * image.width) * p.renderScale;
      const sy = (py - p.renderAnchor.y * image.height) * p.renderScale;
      return { x: p.x + sx / 128 + sy / 64, y: p.y + sy / 64 - sx / 128 };
    });
    const expected = g.axis === 'x'
      ? [{ x: c.x, y: p.y }, { x: c.x + c.width, y: p.y }]
      : [{ x: p.x, y: c.y }, { x: p.x, y: c.y + c.height }];
    endpoints.forEach((end, i) => check(Math.hypot(end.x - expected[i].x, end.y - expected[i].y) < 1e-7, 'comprimento visual nao corresponde ao collider'));
  }

  // Integration contract harness: feed exact FENCE rectangles into Map's
  // existing extraColliders API, without changing/mocking its implementation.
  // Props are omitted only here to avoid the legacy point-fence duplicates;
  // the main runtime regression above still uses the complete original city.
  const contractColliders = fenceProps.filter((p) => p.collider).map((p) => ({ ...p.collider, type: 'FENCE' }));
  const contractMap = new CityMap({ ...city, props: [] }, contractColliders);
  for (const c of contractColliders) {
    for (const [x, y] of [[c.x, c.y], [c.x + c.width, c.y + c.height], [c.x + c.width / 2, c.y + c.height / 2]]) {
      check(contractMap.queryNearby(x, y, 0.01).includes(c), 'broadphase perdeu parte do collider longo da cerca');
    }
  }
  for (const p of contractMap.sidewalkNodes) {
    check(!contractMap.queryNearby(p.x, p.y, 0.2).some((c) => circleHits(p, 0.2,
      { x0: c.x, y0: c.y, x1: c.x + c.width, y1: c.y + c.height })), 'contrato FENCE bloqueia calcada no grid de runtime');
  }

  const vehicleRects = [];
  for (const v of city.vehicles) {
    check(v.x > 0 && v.x < city.worldW && v.y > 0 && v.y < city.worldH, `veiculo fora do mapa (${v.x},${v.y})`);
    const def = VEHICLE_DEFS[v.defKey];
    check(!!def && ['NE', 'NW', 'SE', 'SW'].includes(v.dir), `definicao/direcao invalida ${v.defKey}`);
    if (!def) continue;
    check(def.colors.length ? def.colors.includes(v.color) : v.color === null, `cor invalida ${v.defKey}`);
    const radius = Math.max(def.footprintW, def.footprintH) / 2;
    const rect = { x0: v.x - radius, y0: v.y - radius, x1: v.x + radius, y1: v.y + radius };
    cells(rect, (x, y) => check(!!tileAt(x, y) && tileAt(x, y).kind !== 'water' && !isSidewalk(x, y)
      && !naturalBiomes.includes(tileAt(x, y).biome), `veiculo ${v.defKey} invade agua/calcada/reserva`));
    check(!buildingRects.some((b) => overlaps(rect, b)), `veiculo ${v.defKey} dentro de building`);
    check(!vehicleRects.some((o) => overlaps(rect, o)), `veiculos estacionados sobrepostos (${v.x},${v.y})`);
    check(!city.props.some((p) => p.collider ? overlaps(propRect(p), rect) : circleHits(p, 0.3, rect)), `veiculo ${v.defKey} sobre prop`);
    vehicleRects.push(rect);
  }
  check(city.vehicles.length === 120, 'frota estacionada deve permanecer em 120');

  // Flood andável do jogador: só entra nisso o que o Map.ts recolhe como collider de
  // verdade (cerca, lixo, rocha, toco). Tratava-se copa de árvore como muro, e com a
  // mata fechada do #129 isso declarou a floresta inteira inacessível — andando, o
  // jogador atravessa árvore sem nem notar. O que continua proibido, e é checado acima
  // com o retângulo cru de TODO prop, é objeto decorar em cima de trilha ou entrada.
  const propRects = city.props.map(propRect);
  for (let i = 0; i < propRects.length; i++) {
    for (let j = 0; j < i; j++) check(!overlaps(propRects[i], propRects[j]), 'props sobrepostos');
  }
  const solido = (p) => !!p.collider || /^prop_(trashcan|rocks|trunk)/.test(p.key);
  const blocked = new Uint8Array(W * H);
  for (const r of [...buildingRects, ...propRects, ...vehicleRects]) {
    cells(r, (x, y) => check(!protectedPaths.has(y * W + x), 'objeto bloqueia entrada central/trilha natural'));
  }
  for (const r of [...buildingRects, ...city.props.filter(solido).map(propRect), ...vehicleRects]) {
    cells({ x0: Math.max(0, r.x0 - 0.2), y0: Math.max(0, r.y0 - 0.2),
      x1: Math.min(W, r.x1 + 0.2), y1: Math.min(H, r.y1 + 0.2) }, (x, y) => {
      if (circleHits({ x: x + 0.5, y: y + 0.5 }, 0.2, r)) blocked[y * W + x] = 1;
    });
  }
  const flood = (start, accepts) => {
    const seen = new Set();
    if (start === undefined || !accepts(start)) return seen;
    const queue = [start];
    seen.add(start);
    for (let i = 0; i < queue.length; i++) {
      const x = queue[i] % W;
      const y = Math.floor(queue[i] / W);
      for (const [dx, dy] of steps) {
        const next = (y + dy) * W + x + dx;
        if (tileAt(x + dx, y + dy) && !seen.has(next) && accepts(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    return seen;
  };
  const dryAccess = flood(Math.floor(city.playerSpawn.y) * W + Math.floor(city.playerSpawn.x),
    (i) => city.tiles[i].kind !== 'water' && !blocked[i]);
  for (const index of protectedPaths) check(dryAccess.has(index), 'entrada/trilha sem acesso seco desde o jogador');

  // Hierarquia viária é topologia, não cor. Cada posto tem que existir no mapa, ter
  // massa suficiente, seguir como faixa dirigida célula a célula e desembocar em
  // arterial nas duas pontas — senão o transporte da Fase 1 não tem o que derivar. O
  // `access` do pátio tem a sua própria régua logo abaixo das filas de rua local.
  for (const rank of ['highway', 'avenue', 'street', 'residential']) {
    check((tilesPorRanko[rank] ?? []).length > 0, `hierarquia sem o posto ${rank}`);
  }
  const miudo = [...(tilesPorRanko.street ?? []), ...(tilesPorRanko.residential ?? [])];
  const miudoSet = new Set(miudo);
  check(miudo.length > 600, `ruas locais geradas em quantidade insuficiente (${miudo.length} tiles)`);

  const nodeIndex = new Map();
  map.roadNodeTiles.forEach((n, i) => nodeIndex.set(n.ty * W + n.tx, i));
  const sentido = { SW: [0, 1], NE: [0, -1], SE: [1, 0], NW: [-1, 0] };
  for (const index of miudo) {
    const t = city.tiles[index];
    const x = index % W, y = Math.floor(index / W);
    const [dx, dy] = sentido[t.lane];
    const from = nodeIndex.get(index);
    const to = nodeIndex.get((y + dy) * W + x + dx);
    check(to !== undefined && map.roadOut[from].includes(to),
      `faixa local para no meio do quarteirao (${x},${y})`);
  }

  // Uma rua começa na boca sul e termina na boca norte. Caminhando na direção da
  // faixa a partir da primeira célula da fila, a única saída possível é uma celula
  // de arterial — e o comprimento mínimo é o quarteirao inteiro, não um beco.
  let filas = 0;
  for (const index of miudo) {
    const t = city.tiles[index];
    const x = index % W, y = Math.floor(index / W);
    const [dx, dy] = sentido[t.lane];
    const atras = (y - dy) * W + x - dx;
    if (miudoSet.has(atras) && city.tiles[atras].lane === t.lane) continue;
    filas++;
    let cx = x, cy = y, comprimento = 0;
    for (;;) {
      cx += dx; cy += dy; comprimento++;
      const proxima = tileAt(cx, cy);
      check(proxima?.kind === 'road', `rua local morre fora do asfalto (${cx},${cy})`);
      if (ARTERIAIS.includes(proxima?.rank)) break;
      check(comprimento < 20, `rua local nunca alcanca uma arterial (${cx},${cy})`);
    }
    check(comprimento >= 8, `rua local curta demais para ser via (${comprimento} celulas)`);
  }
  check(filas >= 40, `apenas ${filas} filas de rua local geradas`);

  // O pátio do terminal é a única razão de `access` existir, então a régua é a de um pátio:
  // todo tile de acesso mora no asfalto carimbado da rodoviária, cada fila sua morre numa
  // caixa (nunca no meio de um lote nem virando rua da cidade), e nada é construído dentro
  // dele. Um beco disfarçado de instalação cai aqui; uma instalação sem beco também.
  {
    const acesso = tilesPorRanko.access ?? [];
    check(acesso.length >= 16, `pátio do terminal raso demais (${acesso.length} tiles de acesso)`);
    check(acesso.every((i) => city.tiles[i].terminal === true),
      'acesso carimbado fora do asfalto do terminal');
    check(city.tiles.some((t) => t.terminal), 'terminal sem asfalto carimbado');
    const acessoSet = new Set(acesso);
    let baias = 0;
    for (const index of acesso) {
      const t = city.tiles[index];
      if (t.lane == null) continue;
      const x = index % W, y = Math.floor(index / W);
      const [dx, dy] = sentido[t.lane];
      const atras = (y - dy) * W + x - dx;
      if (acessoSet.has(atras) && city.tiles[atras].lane === t.lane) continue;
      baias++;
      let px = x, py = y, comprimento = 0;
      for (;;) {
        px += dx; py += dy; comprimento++;
        const proxima = tileAt(px, py);
        check(proxima?.kind === 'road', `faixa do terminal morre no lote (${px},${py})`);
        if (proxima.lane == null) break;
        check(proxima.rank === 'access', `faixa do terminal virou rua da cidade (${px},${py})`);
        check(comprimento < 20, `faixa do terminal comprida demais para ser pátio (${px},${py})`);
      }
    }
    check(baias === 2, `esperadas duas baias no pátio (entrada e saída), encontradas ${baias}`);
    const pátio = city.buildings.filter((b) => {
      const r = { x0: b.x - b.footprintW, y0: b.y - b.footprintW, x1: b.x, y1: b.y };
      let dentro = false;
      cells(r, (x, y) => { if (tileAt(x, y)?.terminal) dentro = true; });
      return dentro;
    });
    check(!pátio.length, `prédio dentro do pátio do terminal (${pátio.map((b) => b.key)})`);
  }

  // O posto mora no bioma certo: comercial tem rua, residencial tem vizinho, e a
  // malha local não invade reserva natural nem zona industrial.
  for (const [rank, permitidos] of [['street', ['downtown', 'commercial', 'market']],
    ['residential', ['residential', 'suburb']]]) {
    for (const index of tilesPorRanko[rank] ?? []) {
      check(permitidos.includes(city.tiles[index].biome),
        `${rank} no bioma ${city.tiles[index].biome} (${index % W},${Math.floor(index / W)})`);
    }
  }
  const espinha = tilesPorRanko.highway;
  check(flood(espinha[0], (i) => city.tiles[i].kind === 'road'
    && city.tiles[i].rank === 'highway').size === espinha.length, 'highway nao e uma espinha continua');
  {
    const a = miudo[Math.floor(miudo.length / 4)];
    const b = miudo[Math.floor(miudo.length * 3 / 4)];
    const rota = map.findRoadPath(a % W + 0.5, Math.floor(a / W) + 0.5,
      b % W + 0.5, Math.floor(b / W) + 0.5);
    check(rota.length > 12 && rota.some((n) => miudoSet.has(Math.floor(n.y) * W + Math.floor(n.x))),
      'transito nao usa as ruas locais para ligar dois bairros');
  }

  for (const r of buildingRects) {
    let accessible = false;
    cells({ x0: r.x0 - 1, y0: r.y0 - 1, x1: r.x1 + 1, y1: r.y1 + 1 }, (x, y) => {
      if (tileAt(x, y) && dryAccess.has(y * W + x)) accessible = true;
    });
    check(accessible, `imovel sem acesso seco ${r.key}`);
  }
  // Measure each garden's physical opening, then sweep a player-sized circle
  // from the connected outdoor approach all the way to the home's front wall.
  // This sub-tile test catches gates a tile-center flood alone would miss.
  const fenceOwners = new Map(fenceProps.map((p) => [p, 0]));
  const obstacles = [...buildingRects, ...propRects, ...vehicleRects];
  let gardens = 0;
  const gardenBlocks = new Set();
  for (const home of city.buildings) {
    const cx = home.x - home.footprintW / 2;
    const panels = fenceProps.filter((p) => Math.abs(p.x - cx) <= 1.061
      && p.y >= home.y + 0.35 - 1e-7 && p.y <= home.y + 1.55 + 1e-7);
    if (!panels.length) continue;
    gardens++;
    panels.forEach((p) => fenceOwners.set(p, fenceOwners.get(p) + 1));
    check(home.tag.startsWith('house_'), 'cerca atribuida a estabelecimento/servico');
    check(['residential', 'suburb'].includes(tileAt(Math.floor(home.x), Math.floor(home.y))?.biome), 'jardim fora de bairro residencial');
    check(panels.length === 6, 'jardim incompleto ou cercas de casas vizinhas misturadas');
    const blockKey = `${xLines.findIndex((x) => x > home.x)},${yLines.findIndex((y) => y > home.y)}`;
    check(!gardenBlocks.has(blockKey), 'mais de um jardim cercado na mesma quadra');
    gardenBlocks.add(blockKey);
    const front = panels.filter((p) => p.collider.width > p.collider.height).map(propRect).sort((a, b) => a.x0 - b.x0);
    check(front.length === 2, 'frente do jardim nao possui dois paineis separados');
    if (front.length !== 2) continue;
    const gap = front[1].x0 - front[0].x1;
    check(gap >= 0.8 && Math.abs(gap - 1) < 1e-7, `abertura real da cerca insuficiente: ${gap}`);
    check(Math.abs(front[0].y0 - front[1].y0) < 1e-7, 'paineis do portao desalinhados');
    const approachY = Math.max(front[0].y1, front[1].y1) + 0.4;
    check(dryAccess.has(Math.floor(approachY) * W + Math.floor(cx)), 'portao sem acesso seco desde jogador');
    for (const offset of [-0.2, 0, 0.2]) {
      for (let y = home.y + 0.25; y <= approachY; y += 0.025) {
        const p = { x: cx + offset, y };
        check(!obstacles.some((r) => circleHits(p, 0.2, r)), 'cerca/objeto bloqueia corredor entre portao e entrada da casa');
        check(tileAt(Math.floor(p.x), Math.floor(p.y))?.kind !== 'water', 'entrada cercada exige nadar');
      }
    }
  }
  check([...fenceOwners.values()].every((count) => count === 1), 'cerca orfa ou compartilhada entre casas');
  check(gardens >= 6 && gardens < city.buildings.filter((b) => b.tag.startsWith('house_')).length / 4, 'cercas ausentes ou atribuidas a casas demais');

  const natureStats = [];
  for (const biome of naturalBiomes) {
    const indices = city.tiles.flatMap((t, i) => t.biome === biome && t.kind !== 'water' ? [i] : []);
    const connected = flood(indices[0], (i) => city.tiles[i].biome === biome && city.tiles[i].kind !== 'water');
    const terrain = indices.filter((i) => ['grass', 'dirt'].includes(city.tiles[i].kind));
    const trails = indices.filter((i) => isTrail(city.tiles[i]));
    const decorations = city.props.filter((p) => tileAt(Math.floor(p.x), Math.floor(p.y))?.biome === biome);
    check(indices.length >= 800 && terrain.length >= 500 && naturalBlocks[biome] >= 2, `regiao ${biome} pequena/somente nominal`);
    check(connected.size === indices.length, `regiao ${biome} fragmentada`);
    check(indices.filter((i) => dryAccess.has(i)).length >= indices.length * 0.95, `regiao ${biome} sem acesso seco suficiente`);
    check(trails.length >= 100 && trails.every((i) => dryAccess.has(i)), `trilhas ${biome} ausentes/bloqueadas`);
    check(decorations.length >= 10 && new Set(decorations.map((p) => p.key)).size >= 3, `props ${biome} ausentes/pouco variados`);
    check(new Set(terrain.map((i) => city.tiles[i].key)).size >= 3, `terreno ${biome} uniforme`);
    if (biome === 'forest') {
      const trees = decorations.filter((p) => p.key.includes('tree'));
      // A cota fixa de "200 árvores + 16 detalhes" morreu com o morro nu do #129: o que
      // define mata não é um número absoluto, é a DENSIDADE POR TILE, que é o que a tela
      // lê. Medido em três seeds: ~1 árvore a cada 5 tiles² de mata (1693-1721 num total
      // de 8961 tiles). A copa abaixo é que cobra o resultado visual.
      check(trees.length >= indices.length * 0.15 && trees.length <= indices.length * 0.25,
        `densidade de mata ${trees.length}/${indices.length} fugiu do dossel medido`);
      check(indices.length >= W * H * 0.09 && naturalBlocks.forest >= 12, 'floresta nao cresceu proporcionalmente ao mundo');
      for (let row = 0; row < yLines.length - 1; row++) {
        for (let col = 0; col < xLines.length - 1; col++) {
          if (tileAt(xLines[col] + 3, yLines[row] + 3)?.biome !== 'forest') continue;
          const local = trees.filter((p) => p.x > xLines[col] + 2 && p.x < xLines[col + 1]
            && p.y > yLines[row] + 2 && p.y < yLines[row + 1]);
          check(local.length >= 5, `quadra florestal ${col},${row} ficou sem cobertura distribuida`);
        }
      }
    } else if (biome === 'countryside') {
      // Campo e praia são faixas de orla com largura fixa: ao crescer o miolo urbano,
      // a fatia delas sobre o mundo inteiro cai de propósito. O que não pode cair é a
      // área absoluta (e a decoração, checada acima). No campo a árvore é rara de
      // propósito — prado com uma ou outra no alto, não mata.
      //
      // A faixa de decoração subiu junto com a cota nova de serra (240-340 -> 330-460):
      // a metade das árvores que o talude do campo recebe agora cai dentro desta reserva.
      // O que segura o prado não é o total, é a proporção de árvore por tile, checada
      // logo abaixo em árvores/tiles.
      //
      // 5% -> 6%: medido nas três seeds depois da quadra do terminal, o campo fica em
      // 287/301/331 árvores (4,34% / 4,56% / 5,01% dos 6608 tiles). A cota velha estava
      // exatamente no topo dessa distribuição, então qualquer re-embaralhamento do baralho
      // de props — e a rodoviária tirou doze prédios de uma quadra comercial, o que muda a
      // ordem de todo o resto — flipava a régua sem mudar nada do que a tela lê. Mata, que
      // é o que a regra quer impedir, está em 21%; 6% ainda não é prado com árvores demais.
      check(decorations.length >= 330 && decorations.length <= 460
        && indices.length >= W * H * 0.09, 'reserva proporcional/cota de campo nao preservada');
      check(decorations.filter((p) => p.key.includes('tree')).length < indices.length * 0.06,
        'campo virou floresta e perdeu o prado');
      check(terrain.filter((i) => city.tiles[i].kind === 'grass').length > 600
        && decorations.some((p) => p.key.includes('flowers')), 'campo sem prados/floracao');
    } else if (biome === 'pinewood') {
      // 500-640 -> 560-720: o pinhal ganhou a cota própria de 900 árvores e o plantio da
      // serra no talude de pinheiro, que antes competia com o teto velho e morria antes
      // da crista.
      check(decorations.length >= 560 && decorations.length <= 720 && naturalBlocks.pinewood >= 6,
        'pinhal sem cota/quadras coerentes');
      check(decorations.every((p) => p.key.includes('tree_pine')), 'pinhal precisa de silhuetas de coniferas');
    } else if (biome === 'savanna') {
      check(decorations.length >= 50 && decorations.length <= 120 && naturalBlocks.savanna >= 6,
        'savana sem cota/quadras coerentes');
      check(terrain.filter((i) => city.tiles[i].key === 'tile_ground_dirt_drypatch').length > terrain.length * 0.4
        && decorations.some((p) => p.key.includes('dry')), 'savana sem manchas secas/vegetacao distinta');
    } else if (biome === 'beach') {
      check(decorations.length >= 36 && decorations.length <= 44 && indices.length >= W * H * 0.035,
        'reserva proporcional/cota de praia nao preservada');
      const shoreline = terrain.filter((i) => steps.some(([dx, dy]) => tileAt(i % W + dx, Math.floor(i / W) + dy)?.kind === 'water'));
      // Areia clara na margem, areia seca um pouco mais para dentro — nada de terra verde.
      check(shoreline.length >= 24
        && terrain.filter((i) => city.tiles[i].key === 'tile_ground_sand_beach').length >= 200
        && terrain.filter((i) => city.tiles[i].key === 'tile_ground_sand_dry').length >= 150,
        'praia sem margem de agua e faixa arenosa seca');
    } else {
      check(decorations.length >= 96 && decorations.length <= 115 && indices.length >= W * H * 0.05 && naturalBlocks.desert >= 4,
        'reserva proporcional/cota de deserto nao preservada');
      check(terrain.filter((i) => city.tiles[i].key === 'tile_ground_sand_dry').length > 1000
        && terrain.filter((i) => city.tiles[i].key === 'tile_ground_sand_dune').length > 400,
        'deserto sem poeira seca e faixas de duna');
      // Pedra e mato seco, sem floresta: a assinatura visual do bioma. E é por isso que o
      // morro do deserto é o único que continua sem sombra de copa — pedra nua não tem.
      check(decorations.every((p) => !p.key.includes('tree')) && decorations.some((p) => p.key.includes('dry'))
        && decorations.some((p) => p.key.includes('rocks')), 'deserto sem vegetacao rasteira/dunas vivas');
    }
    natureStats.push(`${biome}=${indices.length}dry/${decorations.length}props`);
  }

  // ---- Sombra de copa: o contrato do #129 ------------------------------------
  // "Ajustar pra ter sombra apenas onde tem árvore" tem duas metades, e as duas são
  // checáveis: nada escurece sem uma árvore em cima, e a mata fechada ESCURECE de verdade
  // — o morro de pinheiro sem sombra nenhuma é o bug original voltando pelo outro lado.
  const copa = city.copa;
  check(!!copa && copa.length === W * H, 'mapa sem campo de copa para o GroundLayer');
  if (copa) {
    // Mesmo deslocamento do gerador: em iso o borro cai para (+x,+y). O raio 3 é medido,
    // não chutado — a dois tiles de um pé de árvore a copa ainda chega a 0,53, e a três
    // já morre em 0,12, abaixo do que muda pixel. Ou seja: penumbra até onde a pena do
    // borro alcança, e nunca mancha solta em chão onde não existe árvore.
    const VISIVEL = 0.15;
    const pe = new Uint8Array(W * H);
    for (const p of city.props) {
      if (!p.key.includes('tree')) continue;
      const cx = Math.floor(p.x + 0.42), cy = Math.floor(p.y + 0.42);
      for (let y = cy - 3; y <= cy + 3; y++) {
        for (let x = cx - 3; x <= cx + 3; x++) if (x >= 0 && y >= 0 && x < W && y < H) pe[y * W + x] = 1;
      }
    }
    let naCidade = 0, semArvore = 0;
    for (let i = 0; i < W * H; i++) {
      if (copa[i] < VISIVEL) continue;
      const t = city.tiles[i];
      if (!naturalBiomes.includes(t.biome) || t.kind === 'water') naCidade++;
      else if (!pe[i]) semArvore++;
    }
    check(naCidade === 0, `${naCidade} tiles de cidade/agua receberam sombra de copa`);
    check(semArvore === 0, `${semArvore} tiles sombreados sem nenhuma arvore em cima`);
    for (const biome of ['forest', 'pinewood']) {
      const indices = city.tiles.flatMap((t, i) => t.biome === biome && t.kind !== 'water' ? [i] : []);
      const sombreado = indices.filter((i) => copa[i] >= VISIVEL).length;
      // Medido nas três seeds: 75-77% do chão de mata sob dossel. O resto é clareira,
      // orla e a borda do bioma — mata fechada ao ponto de não ter nem um palmo de sol
      // seria floresta de tabuleiro.
      check(sombreado >= indices.length * 0.7,
        `${biome} continua morro nu: só ${(100 * sombreado / indices.length).toFixed(0)}% da reserva tem sombra de copa`);
      natureStats.push(`${biome}-copa ${(100 * sombreado / indices.length).toFixed(0)}%`);
    }
    // O morro nu do pedido original era justamente o alto sem árvore. Nas reservas
    // arborizadas, a crista tem de estar coberta — senão o que pinta o topo é só a tinta
    // de forma e o problema volta pela outra ponta.
    const cristas = city.tiles.flatMap((t, i) => (t.biome === 'forest' || t.biome === 'pinewood')
      && t.kind !== 'water' && city.heights[i] >= 1.6 ? [i] : []);
    const cristaSombra = cristas.filter((i) => copa[i] >= VISIVEL).length;
    check(cristas.length >= 500 && cristaSombra >= cristas.length * 0.65,
      `crista arborizada segue nua: ${(100 * cristaSombra / Math.max(1, cristas.length)).toFixed(0)}% de ${cristas.length} tiles`);
    natureStats.push(`crista-copa ${(100 * cristaSombra / Math.max(1, cristas.length)).toFixed(0)}%`);

    // §8 do relevo: a espécie é do nível, não do desenho da encosta. O pé do morro é a
    // folha larga do vale; o alto, batido de vento e frio, é do pinho. Em float32 de cota
    // a faixa de transição é larga, então as duas réuas abaixo medem dominância, não pureza.
    const nivel = (de, ate) => {
      const arvores = city.props.filter((p) => {
        if (!p.key.includes('tree')) return false;
        const i = (Math.floor(p.y) * W) + Math.floor(p.x);
        const t = city.tiles[i];
        return t && t.biome === 'forest' && city.heights[i] >= de && city.heights[i] < ate;
      });
      return { n: arvores.length, pinho: arvores.filter((p) => p.key.includes('pine')).length };
    };
    const vale = nivel(0, 0.8), topo = nivel(1.6, Infinity);
    const pct = (o) => (100 * o.pinho / Math.max(1, o.n)).toFixed(0);
    check(vale.n >= 40 && topo.n >= 40, `mata sem arvore nas faixas de cota (vale ${vale.n}, crista ${topo.n})`);
    // Medido nas três seeds: o vale fica em 33-35% de conifera e o alto do morro em
    // 63-68%. As duas réguas abaixo têm folga em volta disso; o que não pode acontecer de
    // novo é o que a lista fixa dava — 48% nas duas pontas, ou seja, nenhuma serra na
    // paisagem.
    check(+pct(topo) >= 55, `crista da mata nao virou pinhal: ${pct(topo)}% de conifera`);
    check(+pct(vale) <= 45, `pe do morro perdeu a folha larga: ${pct(vale)}% de conifera`);
    natureStats.push(`cota-arvore vale=${pct(vale)}% topo=${pct(topo)}%`);
  }

  safeSpawn(city.playerSpawn, 'player spawn');
  check(city.playerSpawn.y < waterTop && Math.abs(city.playerSpawn.x - W * 0.57) < 12 && Math.abs(city.playerSpawn.y - H * 0.35) < 12, 'player longe do centro comercial norte');
  check(tileAt(Math.floor(city.playerSpawn.x), Math.floor(city.playerSpawn.y))?.biome === 'commercial', 'player fora do distrito comercial');
  for (const p of city.npcSpawns) safeSpawn(p, 'npc spawn');
  check(GAME_CONFIG.NPC_COUNT === 400 && city.npcSpawns.length === 700, 'esperados 400 NPCs e 700 pontos de spawn');
  check(GAME_CONFIG.NPC_SIM_NEAR === 22 && GAME_CONFIG.NPC_SIM_FAR === 40, 'raios de simulacao NPC devem permanecer limitados');
  // Trânsito tem teto de orçamento porque cada carro de rua agora tem um pedestre ao volante;
  // como o motorista sai da simulação a pé, o custo total da cidade permanece o mesmo.
  check(GAME_CONFIG.TRAFFIC_MAX === 56 && GAME_CONFIG.TRAFFIC_SPAWN_CHANCE === 0.94,
    'orcamento/probabilidades de trafego devem permanecer iguais');
  check(new Set(city.npcSpawns.map((p) => `${p.x},${p.y}`)).size === city.npcSpawns.length, 'spawns NPC duplicados');
  check(city.npcSpawns.some((p) => p.y < waterTop) && city.npcSpawns.some((p) => p.y > waterBottom), 'NPCs faltando em uma margem');
  // Runtime collider checks cover every sidewalk, not only selected spawn points.
  for (const p of map.sidewalkNodes) {
    const colliders = map.queryNearby(p.x, p.y, 0.2);
    check(!colliders.some((c) => circleHits(p, 0.2, { x0: c.x, y0: c.y, x1: c.x + c.width, y1: c.y + c.height })), 'calcada bloqueada no Map de runtime');
  }
  for (const [re, district] of [[/^bld_policestation/, 'downtown'], [/^bld_hospital/, 'commercial'], [/^bld_gunshop/, 'commercial']]) {
    const building = city.buildings.find((b) => re.test(b.key));
    check(!!building, `landmark ausente ${re}`);
    if (!building) continue;
    check(tileAt(Math.floor(building.x), Math.floor(building.y))?.biome === district, `landmark ${building.key} fora do distrito`);
    const landmark = map.landmarks.find((l) => l.key === building.key);
    check(!!landmark, `landmark nao mapeado ${building.key}`);
    if (!landmark) continue;
    safeSpawn(landmark.front, `entrada ${building.key}`);
    check(Math.hypot(landmark.front.x - landmark.x, landmark.front.y - landmark.y) < 4, `landmark ${building.key} inacessivel`);
    check(map.findSidewalkPath(city.playerSpawn.x, city.playerSpawn.y, landmark.front.x, landmark.front.y).length > 0, `landmark ${building.key} sem caminho de pedestre`);
  }
  const stations = map.landmarksOf('police');
  check(stations.length === 3, 'esperadas tres delegacias');
  check(stations.some((s) => s.y < waterTop) && stations.some((s) => s.y > waterBottom), 'delegacias faltando em uma margem');
  for (const station of stations) {
    safeSpawn(station.front, 'entrada delegacia');
    const route = map.findSidewalkPath(city.playerSpawn.x, city.playerSpawn.y, station.front.x, station.front.y);
    check(route.length > 0, 'delegacia sem acesso');
    if (station.y > waterBottom) check(route.some((p) => tileAt(Math.floor(p.x), Math.floor(p.y))?.bridge), 'rota sul nao usa ponte');
    for (let i = 1; i < route.length; i++) {
      const a = route[i - 1], b = route[i];
      const distance = Math.hypot(b.x - a.x, b.y - a.y);
      check(distance <= 3, 'rota de pedestre salta trecho sem nos');
      for (let step = 0; step <= Math.ceil(distance * 4); step++) {
        const t = step / Math.ceil(distance * 4);
        const x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t;
        check(tileAt(Math.floor(x), Math.floor(y))?.kind !== 'water', 'rota para delegacia exige nadar');
      }
    }
    check(dryAccess.has(Math.floor(station.front.y) * W + Math.floor(station.front.x)), 'delegacia sem acesso fisico seco');
  }
  check(npcOrder === JSON.stringify(city.npcSpawns) && vehicleOrder === JSON.stringify(city.vehicles), 'Map alterou ordem/indices NPC/veiculos');
  console.log(`seed ${seed}: ${W}x${H}; buildings=${city.buildings.length}; props=${city.props.length}; parked=${city.vehicles.length}; npcSpawns=${city.npcSpawns.length}; roads=${roadTiles.length}; bridges=${bridgeCount}; ${natureStats.join('; ')}; janela=${medido.janela}; generation=${generationMs.toFixed(1)}ms; runtimeMap=${mapMs.toFixed(1)}ms`);
}

// Preserve exhaustive runtime asset checks, including unused vehicle variants.
const DIRS = ['NE', 'NW', 'SE', 'SW'];
for (const def of Object.values(VEHICLE_DEFS)) {
  if (def.type === 'helicopter') {
    for (const color of def.colors) {
      for (const dir of DIRS) {
        const key = `veh_helicopter_${color}_${dir}.png`;
        report(existing.has('Vehicles/' + key), `sprite veiculo inexistente ${key}`);
      }
    }
    continue;
  }
  const colors = def.colors.length ? def.colors : [null];
  for (const color of colors) {
    for (const dir of DIRS) {
      const key = `${def.baseKey}${color ? '_' + color : ''}_${dir}${def.type === 'garbage' ? '_normal' : ''}.png`;
      report(existing.has('Vehicles/' + key), `sprite veiculo inexistente ${key}`);
    }
  }
}
for (const ch of ['a', 'b', 'c']) {
  for (const anim of ['idle', 'walk']) {
    for (const dir of DIRS) {
      const frames = anim === 'idle' ? 1 : 4;
      for (let f = 1; f <= frames; f++) {
        const key = `char_${ch}_${anim}_${dir}_f0${f}.png`;
        report(existing.has('Characters/' + key), `sprite char inexistente ${key}`);
      }
    }
  }
}

let defaultSnapshot;
for (const seed of [20260909, 20260910, 42]) {
  try {
    const start = performance.now();
    const city = generateCity(seed);
    const generationMs = performance.now() - start;
    const snapshot = JSON.stringify(city);
    report(snapshot === JSON.stringify(generateCity(seed)), `seed ${seed} nao deterministica`);
    if (seed === 20260909) {
      defaultSnapshot = snapshot;
      report(snapshot === JSON.stringify(generateCity()), 'seed padrao mudou');
    } else report(snapshot !== defaultSnapshot, `seed ${seed} ignorada`);
    validate(city, seed, generationMs);
  } catch (error) {
    report(false, `seed ${seed}: ${error.stack || error}`);
  }
}
console.log(errors === 0 ? 'TUDO OK (3 seeds, assets, runtime graphs and placement)' : `${errors} ERROS encontrados`);
if (errors) process.exitCode = 1;
