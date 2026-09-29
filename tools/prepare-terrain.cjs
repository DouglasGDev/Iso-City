// Terreno novo derivado dos próprios tiles do pack isométrico CC0 (Kenney, "Isometric
// Land Series"): areia do deserto e da praia.
// Nada é baixado aqui — só se reacende um asset que já está no repositório, para o
// terreno arenoso ter tom próprio sem adicionar mais uma textura ao carregamento.
const fs = require('node:fs');
const path = require('node:path');
const { PNG } = require('pngjs');

const dir = path.resolve(__dirname, '../assets/sprites/Roads and Grounds');
const source = PNG.sync.read(fs.readFileSync(path.join(dir, 'tile_ground_dirt_drypatch.png')));

// Luminância média da terra batida é a base; o desvio de cada pixel é comprimido
// para a areia ficar lisa, sem o salpicado escuro da estrada de terra.
function reseat(file, target, spread, ripple) {
  const out = new PNG({ width: source.width, height: source.height });
  let sum = 0, seen = 0;
  for (let i = 0; i < source.data.length; i += 4) {
    if (source.data[i + 3] <= 8) continue;
    sum += source.data[i] * 0.2126 + source.data[i + 1] * 0.7152 + source.data[i + 2] * 0.0722;
    seen++;
  }
  const mean = sum / seen;
  for (let y = 0; y < out.height; y++) {
    for (let x = 0; x < out.width; x++) {
      const i = (y * out.width + x) * 4;
      const lum = source.data[i] * 0.2126 + source.data[i + 1] * 0.7152 + source.data[i + 2] * 0.0722;
      // Ondulação de duna: faixas largas ao longo do eixo do losango isométrico.
      const dune = ripple ? Math.sin(((x / 2 + y) / ripple) * Math.PI * 2) * 5 : 0;
      const deviation = (lum - mean) * spread + dune;
      out.data[i] = Math.max(0, Math.min(255, target[0] + deviation));
      out.data[i + 1] = Math.max(0, Math.min(255, target[1] + deviation));
      out.data[i + 2] = Math.max(0, Math.min(255, target[2] + deviation * 0.72));
      out.data[i + 3] = source.data[i + 3];
    }
  }
  fs.writeFileSync(path.join(dir, file), PNG.sync.write(out));
  console.log(`${file}: média ${Math.round(target[0])},${Math.round(target[1])},${Math.round(target[2])}`);
}

// Praia: areia clara e quente. Deserto: poeira seca, mais pálida e mais cinza.
reseat('tile_ground_sand_beach.png', [214, 196, 152], 0.55, 0);
reseat('tile_ground_sand_dune.png', [206, 186, 143], 0.4, 26);
reseat('tile_ground_sand_dry.png', [196, 175, 136], 0.34, 42);

