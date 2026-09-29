// Arte nova derivada de geometria, não de download: desenha os prédios que faltam
// nos biomas (cabana da mata, bangalô da praia, celeiro do campo, casa de adobe do
// deserto) no mesmo losango, com o mesmo contorno preto e a mesma sombra do pack.
//
// A projeção é a do jogo: um tile de 1x1 é o losango de 63x31,5 px visto de cima,
// com o canto sul encostado em (58, 62) do canvas 128x76 — os mesmos números que a
// sonda mediu em `bld_house_small_blue_a.png`. Tudo é rasterizado 4x e reduzido,
// então as bordas saem com anti-aliasing igual ao dos sprites originais.
const fs = require('node:fs');
const path = require('node:path');
const { PNG } = require('pngjs');

const outDir = path.resolve(__dirname, '../assets/sprites/Buildings');
const S = 4; // superamostragem
const HW = 31.5; // meia largura do losango de 1 tile
const HH = 15.75; // meia altura do losango de 1 tile
const OX = 58, OY = 30.5; // canto de trás do lote, no 1x
const OUTLINE = 3; // espessura do contorno preto, no 1x
const INK = [0, 0, 0];
const SHADOW_ALPHA = 64;

/** (u, v) anda sobre o chão no eixo leste/sul; h é a altura acima do piso. */
const project = (u, v, h) => [OX + (u - v) * HW, OY + (u + v) * HH - h];

function inflate(points, r) {
  // Empurra cada vértice na bissetriz externa, com canto limitado: o telhado
  // isométrico tem faces quase de topo, e o corte entre duas arestas paralelas
  // explodiria para fora do canvas se fosse tratado como mitral sem freio.
  let p = points.map(([x, y]) => [x, y]);
  let area = 0;
  for (let i = 0; i < p.length; i++) {
    const [x0, y0] = p[i], [x1, y1] = p[(i + 1) % p.length];
    area += x0 * y1 - x1 * y0;
  }
  if (area < 0) p = p.reverse(); // sentido horário na tela => normal (dy,-dx) é externa
  const normals = p.map(([x0, y0], i) => {
    const [x1, y1] = p[(i + 1) % p.length];
    const dx = x1 - x0, dy = y1 - y0, len = Math.hypot(dx, dy) || 1;
    return [dy / len, -dx / len];
  });
  return p.map(([x, y], i) => {
    const n0 = normals[(i + p.length - 1) % p.length], n1 = normals[i];
    let bx = n0[0] + n1[0], by = n0[1] + n1[1];
    const len = Math.hypot(bx, by);
    if (len < 1e-6) return [x, y]; // aresta oposta: o vértice não tem para onde ir
    bx /= len; by /= len;
    const cos = Math.max(bx * n1[0] + by * n1[1], 0.5); // |n| = r / cos(meio ângulo)
    return [x + bx * r / cos, y + by * r / cos];
  });
}

class Sheet {
  constructor(width, height) {
    this.width = width; this.height = height;
    this.img = new PNG({ width: width * S, height: height * S });
  }
  fill(points, color) {
    const pts = points.map(([x, y]) => [x * S, y * S]);
    let minY = Infinity, maxY = -Infinity;
    for (const [, y] of pts) { minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
    const [r, g, b, a = 255] = color;
    for (let y = Math.max(0, Math.floor(minY)); y < Math.min(this.img.height, Math.ceil(maxY)); y++) {
      const cy = y + 0.5;
      const xs = [];
      for (let i = 0; i < pts.length; i++) {
        const [x0, y0] = pts[i], [x1, y1] = pts[(i + 1) % pts.length];
        if ((y0 <= cy) === (y1 <= cy)) continue;
        xs.push(x0 + ((cy - y0) * (x1 - x0)) / (y1 - y0));
      }
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        for (let x = Math.max(0, Math.round(xs[k])); x < Math.min(this.img.width, Math.round(xs[k + 1])); x++) {
          const i = (y * this.img.width + x) * 4;
          this.img.data[i] = r; this.img.data[i + 1] = g; this.img.data[i + 2] = b; this.img.data[i + 3] = a;
        }
      }
    }
  }
  /** Face colorida com o contorno preto por baixo, como no pack. */
  face(points, color) {
    this.fill(inflate(points, OUTLINE), [...INK, 255]);
    this.fill(points, color);
  }
  /** Sombra no chão: mesmo losango do prédio, empurrado para o canto leste. */
  static groundShadow(u0, v0, u1, v1, dx = 0.28, dy = 0.1) {
    return [[u0 + dx, v0 + dy], [u1 + dx, v0 + dy], [u1 + dx, v1 + dy], [u0 + dx, v1 + dy]].map(([u, v]) => project(u, v, 0));
  }
  shrink() {
    const out = new PNG({ width: this.width, height: this.height });
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        let r = 0, g = 0, b = 0, a = 0;
        for (let sy = 0; sy < S; sy++) {
          for (let sx = 0; sx < S; sx++) {
            const i = ((y * S + sy) * this.img.width + x * S + sx) * 4;
            const al = this.img.data[i + 3];
            r += this.img.data[i] * al; g += this.img.data[i + 1] * al;
            b += this.img.data[i + 2] * al; a += al;
          }
        }
        const o = (y * this.width + x) * 4, n = S * S;
        out.data[o + 3] = Math.round(a / n);
        if (a) { out.data[o] = Math.round(r / a); out.data[o + 1] = Math.round(g / a); out.data[o + 2] = Math.round(b / a); }
      }
    }
    return out;
  }
  mirror() {
    // A face `_b` do pack é o mesmo prédio visto do outro lado: espelhar o `_a`
    // mantém contorno, sombra e escala idênticos sem desenhar uma segunda planta.
    const src = this.shrink();
    const out = new PNG({ width: src.width, height: src.height });
    for (let y = 0; y < src.height; y++) {
      for (let x = 0; x < src.width; x++) {
        const i = (y * src.width + x) * 4, j = (y * src.width + (src.width - 1 - x)) * 4;
        out.data[i] = src.data[j]; out.data[i + 1] = src.data[j + 1];
        out.data[i + 2] = src.data[j + 2]; out.data[i + 3] = src.data[j + 3];
      }
    }
    return out;
  }
}

/** Caixa: piso (u0,v0)-(u1,v1), paredes até `h`. Só as duas faces sul ficam à vista. */
function box(sheet, u0, v0, u1, v1, h, wall, wallShade, roof) {
  const p = (u, v, z) => project(u, v, z);
  sheet.face([p(u0, v1, 0), p(u1, v1, 0), p(u1, v1, h), p(u0, v1, h)], wall); // face oeste-sul
  sheet.face([p(u1, v0, 0), p(u1, v1, 0), p(u1, v1, h), p(u1, v0, h)], wallShade); // face leste-sul
  if (roof) sheet.face([p(u0, v0, h), p(u1, v0, h), p(u1, v1, h), p(u0, v1, h)], roof);
}

/** Cumeeira ao longo de `u`: o telhado desce para os dois lados no eixo v. */
function gable(sheet, u0, v0, u1, v1, eaves, ridge, roofColor, gableColor) {
  const p = (u, v, z) => project(u, v, z);
  const mid = (v0 + v1) / 2;
  // Só a empena próxima é desenhada: a do fundo fica escondida atrás da cumeeira,
  // e pintá-la primeiro solta um triângulo preto no canto de cima da sprite.
  sheet.face([p(u1, v0, eaves), p(u1, v1, eaves), p(u1, mid, ridge)], gableColor);
  sheet.face([p(u0, v0, eaves), p(u1, v0, eaves), p(u1, mid, ridge), p(u0, mid, ridge)], roofColor);
  sheet.face([p(u0, v1, eaves), p(u1, v1, eaves), p(u1, mid, ridge), p(u0, mid, ridge)], roofColor);
}

/** Retângulo na parede: `axis` é o eixo que corre pela parede, `fixed` é a face. */
function wallQuad(axis, fixed, from, to, h0, h1) {
  const p = (u, v, z) => project(u, v, z);
  return axis === 'v'
    ? [p(fixed, from, h0), p(fixed, to, h0), p(fixed, to, h1), p(fixed, from, h1)]
    : [p(from, fixed, h0), p(to, fixed, h0), p(to, fixed, h1), p(from, fixed, h1)];
}

function windowOn(sheet, axis, fixed, from, to, h0, h1, color) {
  sheet.face(wallQuad(axis, fixed, from, to, h0, h1), color);
}

/** Detalhe miúdo (viga, tábua, sombra): pinta sem contorno, que engoliria o traço. */
function detailOn(sheet, axis, fixed, from, to, h0, h1, color) {
  sheet.fill(wallQuad(axis, fixed, from, to, h0, h1), color);
}

/** Caixa de topo plano com platibanda: a laje fica recuada dentro da borda. */
function flatTop(sheet, u0, v0, u1, v1, h, wall, wallShade, deck, rim = 0.07) {
  box(sheet, u0, v0, u1, v1, h, wall, wallShade, wall);
  // A laje entra sem contorno: inflar um losango pequeno o faria maior que a
  // própria platibanda, e o topo ganharia espinhos pretos por fora da casa.
  sheet.fill([
    project(u0 + rim, v0 + rim, h), project(u1 - rim, v0 + rim, h),
    project(u1 - rim, v1 - rim, h), project(u0 + rim, v1 - rim, h),
  ], deck);
}

const GLASS = [144, 182, 200];
const GLASS_DARK = [110, 148, 168];
const WOOD = [126, 84, 48];
const WOOD_DARK = [96, 62, 34];
const TRIM = [240, 236, 226];

function cabin(sheet) {
  const wall = [140, 92, 52], wallShade = [112, 72, 40], roof = [70, 78, 84], gableEnd = [150, 100, 58];
  box(sheet, 0.08, 0.12, 0.92, 0.88, 20, wall, wallShade, null);
  gable(sheet, 0.02, 0.06, 0.98, 0.94, 20, 33, roof, gableEnd);
  // troncos: linhas de sombra na parede da esquerda, antes da porta
  for (const h of [6, 12, 18]) detailOn(sheet, 'u', 0.88, 0.12, 0.9, h, h + 1.4, [120, 78, 44]);
  windowOn(sheet, 'u', 0.88, 0.28, 0.5, 6, 16, WOOD_DARK); // porta
  windowOn(sheet, 'v', 0.92, 0.3, 0.52, 7, 15, GLASS);
  windowOn(sheet, 'v', 0.92, 0.58, 0.8, 7, 15, GLASS);
}

function bungalow(sheet) {
  const wall = [246, 240, 226], wallShade = [222, 214, 196], roof = [214, 128, 96], gableEnd = [238, 176, 140];
  box(sheet, 0.06, 0.1, 0.94, 0.9, 20, wall, wallShade, null);
  // Cumeeira baixa e telhado largo: o bangalô de praia é uma casa térrea esticada.
  // Com topo plano a sprite virava uma mesa de sinuca azul na areia.
  gable(sheet, 0.02, 0.06, 0.98, 0.94, 20, 29, roof, gableEnd);
  windowOn(sheet, 'u', 0.9, 0.14, 0.42, 6, 15, GLASS);
  windowOn(sheet, 'u', 0.9, 0.52, 0.82, 5, 17, WOOD_DARK); // porta da varanda
  windowOn(sheet, 'v', 0.94, 0.28, 0.62, 7, 15, GLASS);
  detailOn(sheet, 'u', 0.9, 0.1, 0.86, 18.5, 20, TRIM); // franja branca sob a beirada
}

function barn(sheet) {
  const wall = [176, 60, 50], wallShade = [142, 46, 40], roof = [116, 122, 130], trim = TRIM;
  // telhado que domina a silhueta: parede baixa e cumeeira alta é o celeiro.
  box(sheet, 0.06, 0.1, 0.94, 0.9, 18, wall, wallShade, null);
  gable(sheet, 0.0, 0.04, 1.0, 0.96, 18, 33, roof, wall);
  detailOn(sheet, 'u', 0.9, 0.08, 0.92, 16.5, 18, trim); // franja branca sob a beirada
  // portão de celeiro: vão largo de moldura branca na parede da esquerda
  windowOn(sheet, 'u', 0.9, 0.26, 0.66, 0, 15, trim);
  detailOn(sheet, 'u', 0.9, 0.3, 0.62, 0.5, 14.5, WOOD_DARK);
  detailOn(sheet, 'u', 0.9, 0.3, 0.62, 7, 8, trim);
  windowOn(sheet, 'v', 0.94, 0.36, 0.6, 20, 27, GLASS_DARK); // feno na empena
}

function adobe(sheet) {
  const wall = [226, 184, 132], wallShade = [202, 156, 106], deck = [176, 130, 88];
  flatTop(sheet, 0.08, 0.12, 0.92, 0.88, 19, wall, wallShade, deck, 0.06);
  // vigas que escapam da parede, logo abaixo da platibanda
  for (const v of [0.26, 0.5, 0.74]) detailOn(sheet, 'v', 0.92, v, v + 0.08, 13.5, 15.5, WOOD);
  for (const u of [0.22, 0.46, 0.7]) detailOn(sheet, 'u', 0.88, u, u + 0.08, 13.5, 15.5, WOOD);
  windowOn(sheet, 'u', 0.88, 0.56, 0.8, 0, 13, WOOD_DARK); // porta
  windowOn(sheet, 'v', 0.92, 0.26, 0.46, 7, 12.5, GLASS_DARK);
}

const BUILDINGS = [
  { key: 'bld_cabin_log', draw: cabin },
  { key: 'bld_beach_bungalow', draw: bungalow },
  { key: 'bld_farm_barn', draw: barn },
  { key: 'bld_adobe_house', draw: adobe },
];

const width = Number(process.argv[3] || 128), height = Number(process.argv[4] || 76);
for (const { key, draw } of BUILDINGS) {
  const sheet = new Sheet(width, height);
  sheet.fill(Sheet.groundShadow(0, 0, 1, 1), [0, 0, 0, SHADOW_ALPHA]);
  draw(sheet);
  fs.writeFileSync(path.join(outDir, `${key}_a.png`), PNG.sync.write(sheet.shrink()));
  fs.writeFileSync(path.join(outDir, `${key}_b.png`), PNG.sync.write(sheet.mirror()));
  console.log(`gerado ${key} (_a/_b)`);
}
