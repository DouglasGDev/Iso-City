// Ferramenta de arte derivada: limpa o anel escuro que o pack assou em volta do losango
// de cada piso, e opaciza a franja anti-alias de fora do losango.
//
// Por que isso existe: o #137 chegou como "os blocos dos sprites... não mostrar os
// quadrados, fica muito na cara", e a captura era um campo de grama riscado por uma malha
// de losangos. Medido no PNG, tile por tile, em faixas de raio (r = |dx|/64 + |dy|/32, com
// r=1 exatamente na borda do losango):
//
//   tile            ref 0,78-0,90   0,90-0,96   0,96-1,00   franja r>1 (alfa ~70)
//   grass                 153,5        150,3       143,9          144,6
//   dirt                  156,8        152,5       142,7          143,9
//   concrete              187,1        188,2       186,9          180,3
//   sand_beach            197,5        199,5       198,6          193,7
//   dirt_drypatch         154,7        158,4       156,6          147,6
//
// Dois defeitos, e só o primeiro é tinta:
//
// 1. `grass` e `dirt` (e o `grass_puddle_clean`) escurecem 3 a 14 de luminância nos dois
//    últimos pixels antes da borda. É um sombreamento de "bloco" que o artista do pack
//    assou no próprio tile. Colado no vizinho, cada junta perde ~7 de luz para os dois
//    lados ao mesmo tempo: a grade de losangos da captura. Os outros pisos não têm isso —
//    a areia e o drypatch ficam até MAIS claros na borda, porque ali o gradiente radial é
//    conteúdo (a mancha seca no meio do lote), não defeito.
// 2. TODOS os pisos têm uma franja semi-transparente (alfa 64..74) do lado de fora do
//    losango, ~8 a 13 mais escura que o miúdo. Metade das arestas de um tile faz fronteira
//    com um tile desenhado antes, então a franja dessa metade não é coberta por ninguém:
//    ela deixa o fundo escuro da tela passar e risca um fio de cabelo em cada junta.
//
// A correção é deliberadamente de mão única e só na borda:
//  - mede a tendência radial do próprio tile (bins de 0,01, média móvel) e compara com a
//    faixa de referência logo dentro;
//  - se a borda estiver MAIS ESCURA que a referência, empurra a borda para cima, pixel a
//    pixel, preservando o desvio local (o seixo continua seixo, só para de afundar perto
//    da emenda);
//  - se a borda estiver mais clara, não toca — isso é highlight ou conteúdo do tile, e
//    escurecê-la criaria um anel novo exatamente onde hoje não há linha nenhuma;
//  - força alfa 255 a partir de r=0,90, que é onde a franja começa a deixar o fundo vazar.
//
// O que fica de fora, e por intenção: os `*_wateredge_*` e `*_watercorner_*` e os
// `*_water_NE/NW/SE/SW_*` de cada bioma. Ali o degradê de borda É a margem — o traço claro
// que separa a terra do rio — e apagá-lo afogaria a costa num chapado só.
//
// ÁGUA ABERTA É OUTRO CASO, e só apareceu no quadro da costa. `tile_ground_water` e o seu
// `_dirty` não fazem fronteira com terra nenhuma: são o mar, o rio e a lagoa se repetindo
// losango colado em losango. O perfil radial deles é 147.0, 147.0, 147.0 ... até r=0,96, e
// aí salta para 163 e 179 nos dois últimos pixels. É o mesmo bisel de "bloco" que o pack
// assou na grama, só que do lado claro: um edredom de losangos brilhantes por todo o mar.
// Para estes dois a correção é de mão DUAS vias (desce o que a borda acendeu) e a rampa é
// de um centésimo de raio, não de cinco — o anel é estreito demais para uma rampa larga,
// que deixaria metade dele intacta e o resto escuro.
//
// Rodar: node tools/prepare-ground-edges.cjs [--secar]  (--secar mede e não escreve)
const fs = require('node:fs');
const path = require('node:path');
const { PNG } = require('pngjs');

const DIR = path.resolve(__dirname, '../assets/sprites/Roads and Grounds');
const SECO = process.argv.includes('--secar');

const PISOS = [
  'tile_ground_grass',
  'tile_ground_grass_puddle_clean',
  'tile_ground_grass_puddle_dirty',
  'tile_ground_grass_puddles_clean',
  'tile_ground_grass_puddles_dirty',
  'tile_ground_dirt',
  'tile_ground_dirt_drypatch',
  'tile_ground_dirt_grasspatch',
  'tile_ground_dirt_puddle',
  'tile_ground_dirt_puddle_dirty',
  'tile_ground_dirt_puddles',
  'tile_ground_dirt_puddles_dirty',
  'tile_ground_concrete',
  'tile_ground_asphalt',
  'tile_ground_sand_beach',
  'tile_ground_sand_dry',
  'tile_ground_sand_dune',
];

/** Onde a franja anti-alias começa. De 0 até aqui o tile é miúdo e não é tocado. */
const BORDA = 0.90;
/** Largura da rampa da correção dos pisos secos, em raio. */
const RAMPA = 0.05;
/**
 * Faixa de referência: a corona logo dentro da zona corrigida, e NÃO a média do tile
 * inteiro. Ancorar no miúdo todo foi o erro da segunda versão daqui: o
 * `grass_puddle_clean` e o `dirt_puddle` têm a poça clara no meio e a grama escura na
 * beira, e puxar a borda para a média do conjunto acendia um anel claro em volta de cada
 * poça — um losango novo, agora claro, exatamente onde antes só havia sombra. O que a
 * régua pede é continuidade na emenda, e continuidade é sempre contra o vizinho de dentro.
 */
const REF_DE = 0.78;
/** Só escuros acima disto são corrigidos; claridade é conteúdo. */
const TOLERANCIA = 1.0;

/** Água aberta: o anel é estreito e o miúdo é chapado, então a régua é outra. */
const AGUAS = ['tile_ground_water', 'tile_ground_water_dirty'];
const BORDA_AGUA = 0.955;
const RAMPA_AGUA = 0.01;
const REF_AGUA_DE = 0.5;
const REF_AGUA_ATE = 0.95;

const raio = (x, y, cx, cy) => Math.abs(x + 0.5 - cx) / cx + Math.abs(y + 0.5 - cy) / cy;

/** Média por canal em cada bin de raio, sobre os pixels que têm tinta. */
function tendencia(png, cx, cy, janela = 2) {
  const bins = new Map();
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const k = (png.width * y + x) << 2;
      if (!png.data[k + 3]) continue;
      const b = Math.min(119, Math.floor(raio(x, y, cx, cy) * 100));
      let o = bins.get(b);
      if (!o) bins.set(b, (o = { n: 0, c: [0, 0, 0] }));
      o.n++;
      o.c[0] += png.data[k]; o.c[1] += png.data[k + 1]; o.c[2] += png.data[k + 2];
    }
  }
  const media = new Map();
  for (const [b, o] of bins) media.set(b, o.c.map((v) => v / o.n));
  // Média móvel de 5 bins: sem isso a tendência pescaria o salpico do próprio mato e a
  // correção viraria ruído em vez de rampa. Na água aberta a janela é 1 (bin cru), porque
  // o anel claro tem dois pixels de largura e qualquer alisamento o espalharia para dentro
  // do miúdo chapado — que é justamente a única coisa boa do tile.
  const suave = new Map();
  for (const b of media.keys()) {
    const soma = [0, 0, 0]; let n = 0;
    for (let j = -janela; j <= janela; j++) {
      const m = media.get(b + j);
      if (!m) continue;
      n++; for (let c = 0; c < 3; c++) soma[c] += m[c];
    }
    suave.set(b, soma.map((v) => v / n));
  }
  return suave;
}

function faixaMedia(t, de, ate) {
  const soma = [0, 0, 0]; let n = 0;
  for (let b = Math.floor(de * 100); b < Math.round(ate * 100); b++) {
    const m = t.get(b);
    if (!m) continue;
    n++; for (let c = 0; c < 3; c++) soma[c] += m[c];
  }
  return n ? soma.map((v) => v / n) : null;
}

const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

function tratar(nome, o) {
  const arquivo = path.join(DIR, nome + '.png');
  const png = PNG.sync.read(fs.readFileSync(arquivo));
  const cx = png.width / 2, cy = png.height / 2;
  const t = tendencia(png, cx, cy, o.janela);
  const ref = faixaMedia(t, o.refDe, o.borda);
  const antes = [faixaMedia(t, o.borda, 0.96), faixaMedia(t, 0.96, 1), faixaMedia(t, 1, 1.2)];
  let tocados = 0, clareados = 0, opacizados = 0;

  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const k = (png.width * y + x) << 2;
      if (!png.data[k + 3]) continue;
      const r = raio(x, y, cx, cy);
      if (r < o.borda) continue;
      const b = Math.min(119, Math.floor(r * 100));
      const tend = t.get(b) ?? ref;
      // Mão única nos pisos secos: só sobe o que a borda afundou, porque ali claridade na
      // beira é conteúdo (a mancha seca, o seixo ao sol) e apagá-la criaria um anel novo.
      // Duas vias na água aberta: o miúdo é chapado, então o que destoa na beira é bisel.
      const puxa = [0, 1, 2].map((c) => {
        const d = ref[c] - tend[c];
        if (Math.abs(d) <= TOLERANCIA) return 0;
        return d - Math.sign(d) * TOLERANCIA;
      });
      if (o.maoUnica) for (let c = 0; c < 3; c++) puxa[c] = Math.max(0, puxa[c]);
      if (puxa.some((d) => d !== 0)) {
        // A rampa evita o degrau no r=borda, onde a correção começa do zero e chega ao
        // máximo um pedaço de raio depois — justo onde a franja anti-alias começa, para ela
        // já subir corrigida.
        const f = Math.min(1, (r - o.borda) / o.rampa);
        for (let c = 0; c < 3; c++) {
          png.data[k + c] = Math.max(0, Math.min(255, Math.round(png.data[k + c] + puxa[c] * f)));
        }
        tocados++;
        if (Math.abs(lum(puxa)) * f > 1) clareados++;
      }
      if (png.data[k + 3] !== 255) { png.data[k + 3] = 255; opacizados++; }
    }
  }

  const t2 = tendencia(png, cx, cy, o.janela);
  const depois = [faixaMedia(t2, o.borda, 0.96), faixaMedia(t2, 0.96, 1), faixaMedia(t2, 1, 1.2)];
  const linha = (a) => a.map((f) => (f ? lum(f).toFixed(1) : '—')).join(' ');
  console.log(nome.padEnd(34) + 'ref ' + lum(ref).toFixed(1)
    + '  borda ' + linha(antes) + '  →  ' + linha(depois)
    + `  (${tocados} px na borda, ${clareados} corrigidos, ${opacizados} opacizados)`);
  if (!SECO) fs.writeFileSync(arquivo, PNG.sync.write(png));
}

const PISO_SECO = { borda: BORDA, rampa: RAMPA, refDe: REF_DE, janela: 2, maoUnica: true };
for (const nome of PISOS) tratar(nome, PISO_SECO);
for (const nome of AGUAS) tratar(nome, {
  borda: BORDA_AGUA, rampa: RAMPA_AGUA, refDe: REF_AGUA_DE, janela: 0, maoUnica: false,
});
console.log(SECO ? '\n(--secar: nada foi escrito)' : '\nPisos limpos.');
