// Run: node tools/prepare-paramedico.cjs
//
// O paramédico do SAMU precisa ser lido a 20 tiles, por cima do tint de noite e da névoa da moldura,
// e precisa se distinguir do bombeiro (capacete amarelo, casaco areia) e da polícia (azul-marinho) no
// mesmo segundo — senão o jogador vê "mais um uniforme" correndo e não "o resgate chegou". A paleta
// é a do SAMU brasileiro: branco e verde. O branco é o corpo inteiro (jaleco), o verde vai no boné
// porque é o único ponto que nunca some, nem de costas nem no escuro — a mesma razão do amarelo do
// bombeiro.
//
// A anatomia é a do pack Kenney medida em `char_a_idle_SE_f01.png` (24x32): y 2..5 cabeça/boné,
// y 6..8 rosto (intocado — é o que separa "boneco" de "pessoa"), y 9..18 tronco com braços, y 19 cinto,
// y 20..28 pernas. São as mesmas faixas de `prepare-bombeiro.cjs` e `prepare-police.cjs`, porque os três
// corpos saem do mesmo pack; o que muda é só a cor.
const fs = require('node:fs');
const path = require('node:path');
const { PNG } = require('pngjs');

const root = path.resolve(__dirname, '../assets/sprites/Characters');
const files = fs.readdirSync(root).filter((name) => /^char_a_(idle|walk)_/.test(name));

for (const file of files) {
  const image = PNG.sync.read(fs.readFileSync(path.join(root, file)));
  const front = /_(SE|SW)_/.test(file);
  const right = /_(NE|SE)_/.test(file);
  /** Põe a cor nos pixels opacos, preservando o sombreado que o próprio pack já tem. */
  const pixel = (x, y, rgb) => {
    const i = (y * image.width + x) * 4;
    if (image.data[i + 3] < 50) return;
    for (let c = 0; c < 3; c++) image.data[i + c] = rgb[c];
  };
  const luz = (x, y) => {
    const i = (y * image.width + x) * 4;
    return (image.data[i] + image.data[i + 1] + image.data[i + 2]) / 3;
  };
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const i = (y * image.width + x) * 4;
      if (image.data[i + 3] < 50) continue;
      const light = luz(x, y);
      if (y === 19) {
        // O cinto corta o jaleco da calça: sem essa linha escura as duas faixas viram um bloco e o
        // corpo perde a cintura, que é o que faz a silhueta ler "gente" em 24 pixels.
        pixel(x, y, [24, 30, 26]);
      } else if (y <= 5) {
        // Boné verde SAMU; a última linha da cabeça é a aba, mais escuro para dar volume de aba
        // arredondada em vez de um bloco chato no lugar do cabelo.
        const cor = y === 5
          ? [18 + light * 0.10, 74 + light * 0.14, 48 + light * 0.10]
          : [24 + light * 0.14, 108 + light * 0.20, 70 + light * 0.14];
        pixel(x, y, cor);
      } else if (y >= 9 && y < 19) {
        // Mãos fora de propósito: pintura de luva sobre a pele produz o terceiro braço que o
        // `prepare-police.cjs` já evitava.
        const mãos = y >= 16 && (right ? x < 9 : x > 14);
        if (mãos) continue;
        // Duas faixas verdes atravessam o jaleco branco (manga inclusa): é a leitura de uniforme de
        // resgate em 10 pixels de tronco, e o verde sobre branco é o oposto exato do amarelo sobre
        // areia do bombeiro — os dois nunca se confundem no mesmo incêndio.
        const faixa = y === 12 || y === 15;
        pixel(x, y, faixa
          ? [Math.min(255, 30 + light * 0.10), Math.min(255, 132 + light * 0.16), Math.min(255, 84 + light * 0.12)]
          : [Math.min(255, 226 + light * 0.12), Math.min(255, 230 + light * 0.10), Math.min(255, 228 + light * 0.10)]);
      } else if (y >= 20) {
        // Calça verde-escura, o par do boné, para fechar a silhueta branco/verde do SAMU.
        pixel(x, y, [30 + light * 0.08, 52 + light * 0.10, 40 + light * 0.08]);
      }
    }
  }
  // A cruz verde frontal do boné só existe para quem olha a cara do paramédico; de costas não há o
  // que mostrar, e pintar ali seria um ponto claro flutuando na nuca.
  if (front) pixel(right ? 13 : 10, 4, [40, 150, 96]);
  fs.writeFileSync(path.join(root, file.replace('char_a_', 'char_paramedico_')), PNG.sync.write(image));
}
console.log(`Prepared ${files.length} paramedic sprites with green cap, white jacket and green bands`);
