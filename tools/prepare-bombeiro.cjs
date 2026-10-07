// Run: node tools/prepare-bombeiro.cjs
//
// O bombeiro precisa ser reconhecido a 20 tiles de distância, com o tint de noite por cima e a
// névoa da moldura na beira do quadro. Nesse tamanho não sobra nada do rosto nem do corte do
// uniforme: o que sobrevive é a silhueta de cores, e é ela que este arquivo pinta.
//
// A anatomia foi medida em `char_a_idle_SE_f01.png` (24x32): y 2..5 é a cabeça, y 6..8 o rosto (que
// fica intacto — é o que separa "boneco" de "pessoa"), y 9..18 o tronco com os braços, y 19 o cinto e
// y 20..28 as pernas. São as mesmas faixas que `prepare-police.cjs` usa, porque os dois corpos saem do
// mesmo pack Kenney; o que muda é a paleta.
//
// Capacete amarelo em cima de casaco areia de propósito: o azul-marinho já é a polícia, o cinza claro
// já é o pedestre, e um bombeiro de azul seria lido como mais um policial correndo para o outro lado
// da rua. O amarelo vai na cabeça porque é o único ponto que nunca some — nem de costas, nem no escuro.
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
        // O cinto corta o casaco da calça: sem essa linha escura as duas faixas de cor virariam um
        // bloco só e o corpo perderia a cintura, que é o que faz a silhueta ler "gente" em 24 pixels.
        pixel(x, y, [26, 24, 22]);
      } else if (y <= 5) {
        // A aba do capacete é a última linha da cabeça: é ela que dá o volume de aba arredondada em
        // vez de um simples bloco amarelo no lugar do cabelo.
        const cor = y === 5
          ? [126 + light * 0.16, 84 + light * 0.16, 20 + light * 0.06]
          : [170 + light * 0.24, 118 + light * 0.26, 26 + light * 0.08];
        pixel(x, y, cor);
      } else if (y >= 9 && y < 19) {
        // Mãos ficam de fora: pintura de luva sobre a pele produz aquele terceiro braço que o
        // `prepare-police.cjs` já evitava pelas mesmas razões.
        const mãos = y >= 16 && (right ? x < 9 : x > 14);
        if (mãos) continue;
        // Duas faixas reflexivas horizontais atravessam o casaco inteiro, manga inclusa: é o que faz
        // a leitura "uniforme de combate a incêndio" em 10 pixels de tronco.
        const faixa = y === 12 || y === 15;
        pixel(x, y, faixa
          ? [Math.min(255, 186 + light * 0.24), Math.min(255, 158 + light * 0.24), 60 + light * 0.06]
          : [112 + light * 0.16, 86 + light * 0.16, 50 + light * 0.16]);
      } else if (y >= 20) {
        pixel(x, y, [34 + light * 0.08, 32 + light * 0.08, 30 + light * 0.09]);
      }
    }
  }
  // O escudo frontal do capacete só existe para quem olha para a cara do bombeiro; de costas ele não
  // tem o que mostrar, e pintar ali seria um ponto claro flutuando na nuca.
  if (front) pixel(right ? 13 : 10, 4, [248, 226, 120]);
  fs.writeFileSync(path.join(root, file.replace('char_a_', 'char_bombeiro_')), PNG.sync.write(image));
}
console.log(`Prepared ${files.length} firefighter sprites with yellow helmet, sand turnout coat and reflective bands`);
