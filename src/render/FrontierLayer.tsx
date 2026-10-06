import { memo, useEffect, useRef, useState } from 'react';
import {
  Picture, Skia,
  type SkImage, type SkPaint, type SkPath, type SkPicture,
} from '@shopify/react-native-skia';
import { ELEVATION_PX, worldToScreen } from '../world/IsoUtils';
import { FOG } from '../systems/FogSystem';
import { GAME_CONFIG } from '../game/GameConfig';
import { tileKey } from '../assets/AssetRegistry';
import { spriteStore } from '../assets/SpriteStore';
import { solicitarSprite } from '../assets/SpriteRequests';
import { chãoDaFronteira, chaveDoTile, luzDoDossel, profundidade, tintaDoChão } from '../world/Frontier';
import { CÉLULA_DA_TRIBO, acampamentoDaCélula, clareiraNoTile, type Acampamento } from '../world/Tribo';
import type { GameState } from '../game/GameState';
import { drawTiltedTile, TILE_OVER } from './GroundLayer';
import { devolverNoTempoDoDesenho } from './SkiaLifetime';

/**
 * O chão da mata sem fim.
 *
 * A cidade tem 57.600 tiles pintados pelo `GroundLayer`; o que existe além deles era o
 * `#3d4a2f` do fundo do `<Canvas>` — um verde de tela, chapado, que não anda com a câmera e
 * denuncia o buraco onde o mapa acaba. Esta camada assenta losango por losango o tile da
 * cidade — o material da beira que cada um deles continua — e para no instante em que a janela
 * da neblina volta inteira para dentro da grade: no meio da cidade o bake devolve `null` e o
 * custo da floresta é zero.
 *
 * Por que o tile da cidade e não uma pinta própria: o limite do mapa não é uma mudança de
 * terreno — é a cidade acabar. Se do lado de dentro é grama desenhada e do lado de fora é
 * losango chapado, a fronteira vira parede visível, e o jogador lê "aqui termina" exatamente
 * onde o pedido foi "não termina". Então o chão de fora é o tile da cidade, e não um tile
 * só: cada losango continua o material do tile de borda que ele encosta, porque medido na
 * malha gerada a grama é só 51% do anel externo — o resto é terra da savana, areia da praia e
 * a água por onde o rio sai do mapa. Fixar a grama trocaria de material na beira em mais da
 * metade do perímetro, que é o mesmo muro que esta camada veio derrubar.
 *
 * O entortar é o `drawTiltedTile` do `GroundLayer`, não um irmão reimplementado: fora da grade
 * o relevo continua (é a mesma leitura contínua que pisa o jogador), e um tile inclinado por
 * duas máscaras compartilhadas é o que fecha a emenda sem degrau.
 *
 * O relevo entra pela leitura contínua (`heightSmoothAt`), não pela cota do tile: fora da grade
 * não há `data.heights`, e o canto compartilhado com a última fila da cidade tem de voltar o
 * MESMO número que o vizinho de dentro usa. É isso que deita a mata no degrau da borda em vez
 * de deixá-la boiar um tile acima ou afundar um abaixo.
 */

/**
 * Passo de quantização da luz do dossel, em alfa. A copa fecha de 1 a 0,62 ao longo de 60
 * tiles, então sete faixas bastam para o olho ler a mata escurecendo sem ver o degrau entre
 * elas — e cada faixa é UM traçado, não um pincel por tile.
 */
const FAIXA_DO_DOSSEL = 0.06;

interface Pincel {
  path: SkPath;
  paint: SkPaint;
}

/**
 * Os pincéis vivem fora do componente e são criados sob demanda: no boot do aparelho o Skia
 * ainda não tem contexto, e um `Skia.Path.Make()` na linha de import foi o que fechou a tela
 * em branco antes da fila de carregamento abrir o mundo.
 */
const tintas = new Map<string, Pincel>();
const dosséis = new Map<number, Pincel>();

function pincelDeTinta(cor: string): Pincel {
  let p = tintas.get(cor);
  if (!p) {
    const paint = Skia.Paint();
    // Sem antialias pelo mesmo motivo das mantas de neve: duas folhas vizinhas com borda
    // suavizada deixam um fio de fundo entre si, e o fio se repete em cada junta da malha.
    paint.setAntiAlias(false);
    paint.setColor(Skia.Color(cor));
    p = { path: Skia.Path.Make(), paint };
    tintas.set(cor, p);
  }
  return p;
}

function pincelDoDossel(faixa: number): Pincel {
  let p = dosséis.get(faixa);
  if (!p) {
    const paint = Skia.Paint();
    paint.setAntiAlias(false);
    // A copa é o único escuro fundo fora do mapa, e é tinta de luz: preto com alfa sobre o
    // chão é exatamente "menos sol passando pela folha", o mesmo papel do `data.copa` na cidade.
    paint.setColor(Skia.Color('#0d1610'));
    paint.setAlphaf(Math.min(1, faixa * FAIXA_DO_DOSSEL));
    p = { path: Skia.Path.Make(), paint };
    dosséis.set(faixa, p);
  }
  return p;
}

/**
 * As duas faixas da terra pisada, de fora para dentro: a orla onde a grama ainda resiste e o
 * centro apertado de tanto andar. Cada faixa é UM traçado por clareira, e é por isso que as duas
 * podem se somar sem manchar: dentro de um path os losangos sobrepostos são um único preenchimento,
 * e o que se empilha aqui é exatamente a intenção — o meio do lugar é mais pisado que a beira.
 */
const FAIXAS_DA_PISADA: readonly { cor: string; alfa: number; fator: number }[] = [
  { cor: '#6a5637', alfa: 0.26, fator: 1.1 },
  { cor: '#5d4a2d', alfa: 0.3, fator: 0.62 },
];
const passos = new Map<number, Pincel>();

function pincelDaPisada(faixa: number): Pincel {
  let p = passos.get(faixa);
  if (!p) {
    const paint = Skia.Paint();
    paint.setAntiAlias(false);
    paint.setColor(Skia.Color(FAIXAS_DA_PISADA[faixa].cor));
    paint.setAlphaf(FAIXAS_DA_PISADA[faixa].alfa);
    p = { path: Skia.Path.Make(), paint };
    passos.set(faixa, p);
  }
  return p;
}

/**
 * A borda da clareira em coordenada de tela: a elipse de mundo amostrada em 22 pontos, cada um
 * projetado pela cota contínua do próprio ponto. Não é um losango por tile porque o losango por
 * tile faria da terra pisada um dente de serra, e não um lugar calcado; também não é uma elipse
 * de tela porque a cota dentro da clareira não é chapada, e um contorno rígido flutuaria ou
 * afundaria conforme o morro.
 */
function contornoDaClareira(p: Pincel, ac: Acampamento, game: GameState, fator: number): void {
  const path = p.path;
  const passosDaElipse = 22;
  for (let i = 0; i < passosDaElipse; i++) {
    const θ = (i / passosDaElipse) * Math.PI * 2;
    const wx = ac.x + Math.cos(θ) * ac.meiaLargura * fator;
    const wy = ac.y + Math.sin(θ) * ac.meiaAltura * fator;
    const s = worldToScreen(wx, wy, game.map.heightSmoothAt(wx, wy));
    if (i === 0) path.moveTo(s.x, s.y);
    else path.lineTo(s.x, s.y);
  }
  path.close();
}

function bakeFrontier(game: GameState): SkPicture | null {
  const view = game.fog.view(game);
  const aabb = game.fog.worldBounds(view);
  const W = game.map.worldW;
  const H = game.map.worldH;
  if (!Number.isFinite(aabb.minX) || !Number.isFinite(aabb.maxY)) return null;
  const tx0 = Math.floor(aabb.minX);
  const tx1 = Math.ceil(aabb.maxX);
  const ty0 = Math.floor(aabb.minY);
  const ty1 = Math.ceil(aabb.maxY);
  // Janela inteira dentro da grade: a cidade já tem chão próprio, e esta camada não pinta um
  // pixel. É o retorno que faz o custo da mata sem fim ser nulo dentro do mapa.
  if (tx0 >= 0 && tx1 < W && ty0 >= 0 && ty1 < H) return null;

  for (const { path } of tintas.values()) path.rewind();
  for (const { path } of dosséis.values()) path.rewind();
  for (const { path } of passos.values()) path.rewind();
  let temChão = false;
  // As clareiras vistas neste bake, indexadas pela chave da célula: o tile detecta a terra pisada,
  // a célula monta o lugar uma única vez. É o mesmo par de papéis do resto da camada — quem varre
  // é o laço de tiles, quem desenha é um traçado por objeto.
  const clareiras = new Map<number, Acampamento>();

  const recorder = Skia.PictureRecorder();
  const rx = view.radiusX + FOG.padding + 128;
  // A mesma cota dilatada do chão da cidade: a última fila do mapa pode estar no alto de um
  // morro, e o tile de mata que se apoia nesse canto é pintado `h * ELEVATION_PX` pixels acima
  // da posição plana. Sem o termo, a picture recortaria a beira da mata num talude elevado.
  const ry = view.radiusY + FOG.padding + 64 + GAME_CONFIG.TERRAIN_MAX_ELEVATION * ELEVATION_PX;
  const canvas = recorder.beginRecording(Skia.XYWHRect(view.x - rx, view.y - ry, rx * 2, ry * 2));

  // A regra da matéria mora em `Frontier` (`chãoDaFronteira`), não aqui: é dela que o check em
  // memória cobra a conta contra a cidade gerada, e um bake de Skia não roda em node. O que
  // sobra para esta camada é trocar o nome pelo sprite e pedir o que falta.
  const pedidas = new Map<string, SkImage | null>();
  const chãoDeFora = (tx: number, ty: number): SkImage | null => {
    const chave = tileKey(chãoDaFronteira(game.map.data.tiles, W, H, tx, ty));
    let img = pedidas.get(chave);
    if (img === undefined) {
      img = spriteStore[chave] ?? null;
      // A fila de carregamento não conhece a fronteira — ela só conhece o que a grade usa por
      // dentro. Este é o único lugar do jogo que pede um chão fora do mapa, e o pedido é
      // idempotente: chamar a cada bake custa um `Set.add` e devolve o tile na volta seguinte.
      if (!img) solicitarSprite(chave);
      pedidas.set(chave, img);
    }
    return img;
  };

  const losango = (A: { x: number; y: number }, B: { x: number; y: number },
    C: { x: number; y: number }, D: { x: number; y: number }, folha: Pincel) => {
    // A folga é a mesma da malha da cidade, medida a partir do centro do losango: sem ela a
    // junta entre dois tiles de cores diferentes mostra um fio do fundo, e a mata sairia
    // quadriculada igual ao relevo de bloco que o contrato proíbe.
    const ox = (A.x + B.x + C.x + D.x) / 4;
    const oy = (A.y + B.y + C.y + D.y) / 4;
    const p = folha.path;
    p.moveTo(ox + (A.x - ox) * TILE_OVER, oy + (A.y - oy) * TILE_OVER);
    p.lineTo(ox + (B.x - ox) * TILE_OVER, oy + (B.y - oy) * TILE_OVER);
    p.lineTo(ox + (C.x - ox) * TILE_OVER, oy + (C.y - oy) * TILE_OVER);
    p.lineTo(ox + (D.x - ox) * TILE_OVER, oy + (D.y - oy) * TILE_OVER);
    p.close();
  };

  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      if (tx >= 0 && ty >= 0 && tx < W && ty < H) continue;
      // Os quatro cantos pela leitura contínua: em coordenada inteira ela devolve exatamente o
      // número que o `vertexHeight` do vizinho de dentro usa, e é isso que faz o tile de fora
      // encostar no de dentro sem degrau. `game.map.heightSmoothAt` chamada sem o objeto perde
      // o `this` e lê `this.data` de undefined: desestruturar quebraria o bake na 1ª mata visível.
      const vA = game.map.heightSmoothAt(tx, ty);
      const vB = game.map.heightSmoothAt(tx + 1, ty);
      const vC = game.map.heightSmoothAt(tx + 1, ty + 1);
      const vD = game.map.heightSmoothAt(tx, ty + 1);
      const A = worldToScreen(tx, ty, vA);
      if (!game.fog.intersects(view, A.x - 65, A.y - 2, 130, 68 + vA * ELEVATION_PX)) continue;
      const B = worldToScreen(tx + 1, ty, vB);
      const C = worldToScreen(tx + 1, ty + 1, vC);
      const D = worldToScreen(tx, ty + 1, vD);
      const prof = profundidade(tx + 0.5, ty + 0.5, W, H);
      temChão = true;
      // A mesma leitura que faz o canal ser navegável: o tile de fora é água quando a beira de
      // dentro é água, e é `isWaterWorld` que o movimento já consulta. Perguntar duas vezes,
      // por caminhos diferentes, é como um rio pintado fica seco sob os pés de quem nada.
      const canal = game.map.isWaterWorld(tx + 0.5, ty + 0.5);
      // A terra pisada é lida pela MESMA função que diz à mata para não crescer ali — é
      // `clareiraNoTile` que `árvoreDoTile` consulta antes de deitar um tronco. Perguntar duas
      // vezes, por caminhos diferentes, é como um acampamento pintado sobre mato fechado ou um
      // claro no chão sem cabana nenhuma: as duas metades do mesmo lugar.
      const pisada = clareiraNoTile(tx, ty, W, H, game.map);
      if (pisada) {
        // Uma vez por clareira, não uma vez por tile: a elipse é um traçado só, e o custo de
        // montar o acampamento (hashes e arrays) não pode ser pago por cada losango do lugar.
        const cx = Math.floor(tx / CÉLULA_DA_TRIBO);
        const cy = Math.floor(ty / CÉLULA_DA_TRIBO);
        const chave = chaveDoTile(cx, cy);
        if (!clareiras.has(chave)) {
          const ac = acampamentoDaCélula(cx, cy, W, H, game.map);
          if (ac) clareiras.set(chave, ac);
        }
      }
      const chão = chãoDeFora(tx, ty);
      if (chão) {
        // Caminho plano primeiro, exatamente como no `GroundLayer`: sem relevo não há por que
        // pagar matriz e máscara, e a beira da mata é a parte mais andada do mapa.
        if (vA === vB && vB === vC && vC === vD) canvas.drawImage(chão, A.x - 64, A.y);
        else drawTiltedTile(canvas, chão, A, B, C, D);
      } else {
        // Sem o tile carregado o chão ainda é a pinta derivada da coordenada — o tom de
        // serapilheira que a grama tem por baixo da junta. Buraco verde-de-tela no lugar da mata
        // é exatamente o que esta camada existe para não mostrar.
        losango(A, B, C, D, pincelDeTinta(tintaDoChão(tx, ty, prof)));
      }
      // Copa só sobre mata: dossel fechado sobre a superfície do rio seria uma faixa escura
      // correndo pelo meio da água, e o canal é justamente a coisa que o jogador VÊ como saída.
      // E dossel sobre a clareira seria sombra de uma copa que `árvoreDoTile` recusou ali — a
      // aldeia apareceria escurecida por árvores que não estão lá.
      const faixa = (canal || pisada) ? 0 : Math.round((1 - luzDoDossel(prof)) / FAIXA_DO_DOSSEL);
      if (faixa > 0) losango(A, B, C, D, pincelDoDossel(faixa));
    }
  }
  if (!temChão) {
    recorder.dispose();
    return null;
  }
  for (const { path, paint } of tintas.values()) {
    if (!path.isEmpty()) canvas.drawPath(path, paint);
  }
  // A terra pisada vem sobre o chão e antes da copa: ela é tinta no solo, no mesmo papel do
  // escuro do dossel, e uma faixa por clareira — nunca uma faixa por tile — para a borda do lugar
  // ser a curva do lugar, não o dente da grade.
  for (const ac of clareiras.values()) {
    for (let f = 0; f < FAIXAS_DA_PISADA.length; f++) {
      contornoDaClareira(pincelDaPisada(f), ac, game, FAIXAS_DA_PISADA[f].fator);
    }
  }
  for (const { path, paint } of passos.values()) {
    if (!path.isEmpty()) canvas.drawPath(path, paint);
  }
  // Uma faixa por tile, nunca duas no mesmo pixel: o escuro do dossel é tinta de luz, e somar
  // faixas sobre a mesma folha duplicaria o alfa onde dois tiles vizinhos caíram em bandas
  // diferentes. Dentro de um path os losangos sobrepostos são UM preenchimento (regra de
  // winding não-zero), então a dilatação de junta nunca escurece a emenda.
  for (const { path, paint } of dosséis.values()) {
    if (!path.isEmpty()) canvas.drawPath(path, paint);
  }
  const picture = recorder.finishRecordingAsPicture();
  recorder.dispose();
  return picture;
}

/**
 * A chave do rebake é a metade de tile da câmera, o zoom e o tamanho da tela — os mesmos
 * termos do chão da cidade, sem a neve: fora do mapa o que escurece é a copa, e ela é função
 * da coordenada, não do clima.
 */
function cameraCellKey(game: GameState): string {
  const cx = Math.round(game.camera.x * 2);
  const cy = Math.round(game.camera.y * 2);
  return `${cx},${cy},${game.camera.zoom},${Math.round(game.viewW)},${Math.round(game.viewH)}`;
}

export const FrontierLayer = memo(function FrontierLayer({ game }: { game: GameState }) {
  const [picture, setPicture] = useState<SkPicture | null>(null);
  const lastKey = useRef('');
  const entregue = useRef<SkPicture | null>(null);

  useEffect(() => {
    const anterior = entregue.current;
    entregue.current = picture;
    if (anterior && anterior !== picture) {
      devolverNoTempoDoDesenho(anterior, () => entregue.current === anterior);
    }
  }, [picture]);

  useEffect(() => () => {
    const atual = entregue.current;
    entregue.current = null;
    if (atual) devolverNoTempoDoDesenho(atual);
  }, []);

  useEffect(() => {
    lastKey.current = '';
    const tick = () => {
      const key = cameraCellKey(game);
      if (key === lastKey.current) return;
      lastKey.current = key;
      setPicture(bakeFrontier(game));
    };
    tick();
    const iv = setInterval(tick, GAME_CONFIG.BAKE_INTERVAL_MS);
    return () => clearInterval(iv);
  }, [game]);

  if (!picture) return null;
  return <Picture picture={picture} />;
});
