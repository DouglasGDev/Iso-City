import { useEffect, useMemo, useState } from 'react';
import { Group, LinearGradient, Path, RadialGradient, Skia, type SkPath } from '@shopify/react-native-skia';
import { useDerivedValue, type SharedValue } from 'react-native-reanimated';
import { GAME_CONFIG } from '../game/GameConfig';
import type { GameState } from '../game/GameState';
import { geometriaDaCascata, type GeometriaCascata } from './CascadeGeometry';

/**
 * Cachoeira desenhada sobre o próprio relevo. A folha não é um retângulo de água colado na
 * encosta: cada seção do lençol vem da cota do chão naquele ponto (ver `CascadeGeometry`),
 * então a folha entorta junto com o morro. A animação segue a regra da casa — nada por
 * quadro no JS thread: os caminhos são montados uma vez por mapa e o que se move é
 * transform e opacidade saindo de `useDerivedValue`, calculados na UI thread.
 *
 * O que faz a folha parecer água e não laje é o miolo do desenho, não o contorno: duas
 * faixas de sombra nas bordas (o lençol é um cilindro, e um cilindro escurece para fora),
 * cordões de água correndo AO LONGO do fluxo e não travessados nele, e espuma que chega a
 * branco de verdade no lábio e no pé. Travessa em cima de travessa, espaçada igual, é
 * degrau de escada — foi exatamente assim que a primeira versão foi lida, e a causa era
 * própria: o lençol é uma fila de quadriláteros fechados, e traçar o caminho do lençol
 * desenha uma régua em cada emenda de seção. O contorno daqui são as duas margens, cada
 * uma em seu caminho aberto.
 *
 * A correnteza também tem de ser periódica com o próprio passo da animação. Um traço
 * sorteado por posição absoluta desliza certo até o transform voltar ao zero, e aí cada
 * cordão cai no lugar do vizinho com tamanho diferente: é um estalo a cada décimo de
 * segundo. Por isso o desenho é um bloco que se repete — dentro do bloco os cordões variam
 * de tamanho e de vão pelo índice do vão, nunca pela posição no morro.
 */

/** Velocidade de tela da correnteza. A queda é curta, então a água passa rápido mesmo. */
const FLUXO_PX_S = 210;
/** ciclos por segundo da névoa: a espuma do pé respira, a bacia não para. */
const NEVOA_HZ = 0.9;
const NEVOA_ALTA = 52;
const ONDA_HZ = 1 / 1.7;
/**
 * Em que ponto da largura do canal corre cada cordão. Sete faixas e não um lençol inteiro
 * de riscas: a água caindo se agrupa em cordões, e entre eles aparece o fundo escuro.
 * Espaçadas de propósito de modo irregular — em partes iguais viram colunas de um prédio.
 */
const FAIXAS = [0.07, 0.2, 0.32, 0.44, 0.57, 0.71, 0.9];
/** Cordões por bloco e por faixa. O bloco é o período da animação; dentro dele cada vão é
 *  um traço de tamanho próprio, e é isso que quebra a grade sem quebrar o ciclo. */
const VAOS = 3;
/** Hash estável: o mesmo par (i, k) devolve sempre o mesmo número em [0,1). */
function rnd(i: number, k: number) {
  const v = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453;
  return v - Math.floor(v);
}

/**
 * Faixa entre duas margens: um quadrilátero por trecho do fluxo, todos no mesmo caminho.
 * Não é o polígono de ida-e-volta das margens porque a corrente curva: quando o raio da
 * curva é menor que a meia-largura, o bordo interno passa para o lado de fora e o
 * preenchimento fecha por dentro da barriga — água desenhada como laje de concreto.
 */
function faixa(p: SkPath, esq: number[], dir: number[]) {
  for (let i = 0; i + 3 < esq.length; i += 2) {
    const j = i + 2;
    p.moveTo(esq[i], esq[i + 1]);
    p.lineTo(dir[i], dir[i + 1]);
    p.lineTo(dir[j], dir[j + 1]);
    p.lineTo(esq[j], esq[j + 1]);
    p.close();
  }
}

/**
 * Uma margem traçada sozinha. É o contorno do lençol sem as travessas: traçar `faixa`
 * fecha cada seção e risca o lençol inteiro de régua, que foi o defeito da folha anterior.
 */
function margem(p: SkPath, pts: number[]) {
  p.moveTo(pts[0], pts[1]);
  for (let i = 2; i + 1 < pts.length; i += 2) p.lineTo(pts[i], pts[i + 1]);
}

/** Margem intermediária entre a borda do canal e o eixo, na fração pedida. */
function entre(a: number[], b: number[], f: number) {
  return a.map((v, i) => v + (b[i] - v) * f);
}

/**
 * Elipse isométrica exata: um círculo de `r` tiles no chão vira meia-largura r·64·√2 e
 * meia-altura a metade. Quatro cônicas de peso √2/2, uma por quadrante — a parábola de um
 * só `conicTo` por lado até fecha no ápice certo, mas incha no meio e afina na ponta, e o
 * círculo iso sai como losango de concreto pintado na relva.
 */
const KAPPA = Math.SQRT1_2;
function isoElipse(p: SkPath, cx: number, cy: number, rx: number, ry: number) {
  p.moveTo(cx - rx, cy);
  p.conicTo(cx - rx, cy - ry, cx, cy - ry, KAPPA);
  p.conicTo(cx + rx, cy - ry, cx + rx, cy, KAPPA);
  p.conicTo(cx + rx, cy + ry, cx, cy + ry, KAPPA);
  p.conicTo(cx - rx, cy + ry, cx - rx, cy, KAPPA);
  p.close();
}

/** Seção do eixo que contém `s` pixels de arco, e em que fração dela. */
function segao(g: GeometriaCascata, s: number) {
  const t = Math.max(0, Math.min(g.total - 1e-6, s));
  let i = 0;
  while (i + 2 < g.amostras && g.arco[i + 1] < t) i++;
  const vao = g.arco[i + 1] - g.arco[i] || 1;
  return { k: i * 2, f: (t - g.arco[i]) / vao };
}

/**
 * Um ponto do canal em tela: `s` de arco percorrido e `parte` da largura, de 0 (margem
 * esquerda) a 1 (direita). É o que permite desenhar cordões que acompanham a calha em vez
 * de riscos retos no eixo da tela — a folha entorta, e eles têm de entortar junto.
 */
function pontoNoCanal(g: GeometriaCascata, s: number, parte: number): [number, number] {
  const { k, f } = segao(g, s);
  const j = k + 2;
  const ax = g.lencoEsq[k] + (g.lencoDir[k] - g.lencoEsq[k]) * parte;
  const ay = g.lencoEsq[k + 1] + (g.lencoDir[k + 1] - g.lencoEsq[k + 1]) * parte;
  const bx = g.lencoEsq[j] + (g.lencoDir[j] - g.lencoEsq[j]) * parte;
  const by = g.lencoEsq[j + 1] + (g.lencoDir[j + 1] - g.lencoEsq[j + 1]) * parte;
  return [ax + (bx - ax) * f, ay + (by - ay) * f];
}

/**
 * Cordões de água: traços compridos na direção do fluxo, escalonados entre si. O clip no
 * lençol apara o que passa da borda, e é o conjunto dos dois que faz a água escorrer POR
 * DENTRO da calha em vez de deslizar por cima dela como um adesivo.
 */
function riscos(g: GeometriaCascata, bloco: number) {
  const p = Skia.Path.Make();
  const passo = bloco / VAOS;
  for (let f = 0; f < FAIXAS.length; f++) {
    for (let v = 0; v < VAOS; v++) {
      // Contra-tempo por faixa: com o mesmo vão em todas, as pontas dos cordões alinhariam
      // e voltariam a formar degrau atravessado — o defeito que esta passagem tira.
      const turno = (f * 0.37 + v / VAOS) * bloco;
      // O tamanho e o deslocado do traço saem do índice do vão, não da posição no morro:
      // é o que mantém o bloco repetível e o ciclo da correnteza invisível.
      const compr = (0.58 + 0.34 * rnd(f * 7 + v, 1)) * passo;
      const inicio = turno + v * passo + rnd(f * 5 + v, 2) * passo * 0.16;
      for (let s = -bloco; s <= g.total + bloco; s += bloco) {
        const s0 = s + inicio;
        const a = pontoNoCanal(g, s0, FAIXAS[f]);
        const b = pontoNoCanal(g, s0 + compr, FAIXAS[f]);
        p.moveTo(a[0], a[1]);
        p.lineTo(b[0], b[1]);
      }
    }
  }
  return p;
}

/**
 * Ondas transversais: curtas, apagadas e cobrindo um pedaço da calha. Travessadas de borda
 * a borda e de vão igual, elas são a escada — por isso o vão aqui é o dobro do bloco dos
 * cordões, com duas ondas de pesos diferentes dentro dele: a correnteza continua periódica
 * (o ciclo é o que se repete, não o espaçamento) e o olho deixa de contar régua.
 */
function veias(g: GeometriaCascata, ciclo: number) {
  const p = Skia.Path.Make();
  for (let v = -1; v * ciclo <= g.total + ciclo; v++) {
    for (const par of [0, 1]) {
      const de = 0.06 + rnd(par, 3) * 0.3;
      const ate = de + 0.34 + rnd(par, 4) * 0.4;
      const s0 = (v + par * 0.5) * ciclo + rnd(par, 5) * ciclo * 0.3;
      const a = pontoNoCanal(g, s0, de);
      const b = pontoNoCanal(g, s0, ate);
      const dy = b[1] - a[1];
      // Levemente curvada para baixo: a calha de água em queda livre estufa no meio.
      p.moveTo(a[0], a[1]);
      p.quadTo((a[0] + b[0]) / 2, (a[1] + b[1]) / 2 + Math.abs(dy) * 0.16 + 2, b[0], b[1]);
    }
  }
  return p;
}

/**
 * O lábio. Não é uma elipse em volta da boca da queda: desenhada assim, a espuma virava um
 * olho claro boiando na relva, maior que o próprio canal. A crista é a água dobrando a
 * pedra, então ela é a boca do canal subida de alguns pixels no meio — largo exatamente o
 * que a folha tem, e nem um tique a mais. E curta: uma faixa branca de um quinto da queda
 * não é o lábio, é um escorregador.
 */
function crista(g: GeometriaCascata) {
  const p = Skia.Path.Make();
  const k = Math.max(2, Math.round(g.amostras * 0.1));
  const arco = g.arco[k] || 1;
  const sobe = (i: number) => Math.cos(Math.min(1, g.arco[i] / arco) * Math.PI / 2) * g.labio.rx * 0.34;
  for (let i = 0; i < k; i++) {
    const a = i * 2;
    const b = a + 2;
    const ea = sobe(i);
    const eb = sobe(i + 1);
    p.moveTo(g.lencoEsq[a], g.lencoEsq[a + 1] - ea);
    p.lineTo(g.lencoDir[a], g.lencoDir[a + 1] - ea);
    p.lineTo(g.lencoDir[b], g.lencoDir[b + 1] - eb);
    p.lineTo(g.lencoEsq[b], g.lencoEsq[b + 1] - eb);
    p.close();
  }
  return p;
}

/**
 * Espuma: cacho de bolhas achatadas. O vão lateral é sorteado e a largura do cacho é dada
 * de fora — névoa que abre mais que o canal não é névoa do impacto, é mancha cinza no mato
 * ao lado da queda, e era exatamente isso que aparecia nos dois ombros do pé.
 *
 * `sz` é o tamanho do bolha como fração do cacho. No jato ela é grande (a espuma é grossa
 * onde a água bate); na névoa é um quinto disso, porque bolha grande e opaca suspensa a
 * trinta pixels do pé não é vapor — é carneiro de nuvem pousado na relva.
 */
function bolhas(cx: number, cy: number, rx: number, count: number, sobe: number,
  k = 0, sz = 0.12, sv = 0.17) {
  const p = Skia.Path.Make();
  for (let i = 0; i < count; i++) {
    const lado = (rnd(i, 1 + k) * 2 - 1) * 0.82;
    const r = rx * (sz + rnd(i, 2 + k) * sv);
    isoElipse(p, cx + lado * rx, cy - (i * sobe) / count - rnd(i, 3 + k) * r * 0.5, r, r * 0.44);
  }
  return p;
}

function montarCaminhos(g: GeometriaCascata) {
  const lenco = Skia.Path.Make();
  faixa(lenco, g.lencoEsq, g.lencoDir);
  const contorno = Skia.Path.Make();
  margem(contorno, g.lencoEsq);
  margem(contorno, g.lencoDir);
  const pedra = Skia.Path.Make();
  faixa(pedra, g.pedraEsq, g.pedraDir);
  // Sombra nas duas bordas: o lençol é um cilindro de água caindo, e um cilindro escurece
  // para fora. Sem ela a folha tem o mesmo valor de ponta a ponta e o olho lê régua. É um
  // filete, não um terço da calha: largo demais, o centro claro some e volta a laje.
  const sombra = Skia.Path.Make();
  faixa(sombra, g.lencoEsq, entre(g.lencoEsq, g.eixo, 0.22));
  faixa(sombra, entre(g.lencoDir, g.eixo, 0.22), g.lencoDir);
  // O período da correnteza: dois cordões por bloco por faixa, num bloco curto o bastante
  // para repetir umas quatro vezes na queda inteira.
  const bloco = Math.max(56, g.total / 4);
  const boca = crista(g);
  const jato = bolhas(g.pe.x, g.pe.y, g.pe.rx * 0.95, 11, 12, 1);
  const respingo = bolhas(g.pe.x, g.pe.y + 3, g.pe.rx * 0.8, 7, 4, 4);
  const nevoa = bolhas(g.pe.x, g.pe.y - 16, g.pe.rx * 1.05, 16, 34, 7, 0.045, 0.06);
  const poca = Skia.Path.Make();
  isoElipse(poca, g.bacia.x, g.bacia.y, g.bacia.rx, g.bacia.rx * 0.5);
  // A margem da bacia é lama encharcada, não corte de tinta: um disco de água da mesma cor
  // do começo ao fim pousado na relva é um carimbo. A praia clara em volta é o que devolve
  // a poça ao chão em que ela escavou.
  const ombro = Skia.Path.Make();
  isoElipse(ombro, g.bacia.x, g.bacia.y, g.bacia.rx * 1.09, g.bacia.rx * 0.545);
  // O anel da onda é desenhado no tamanho cheio e escalado em torno do centro da bacia:
  // assim a animação custa um transform, não um caminho novo por quadro.
  const anel = Skia.Path.Make();
  isoElipse(anel, g.bacia.x, g.bacia.y, g.bacia.rx * 0.9, g.bacia.rx * 0.45);
  return {
    lenco, contorno, pedra, sombra, bloco, ciclo: bloco * 2,
    riscos: riscos(g, bloco), veias: veias(g, bloco * 2),
    boca, jato, respingo, nevoa, poca, ombro, anel,
  };
}

function Queda({ g, clock }: { g: GeometriaCascata; clock: SharedValue<number> }) {
  const caminhos = useMemo(() => montarCaminhos(g), [g]);
  // Só números entram no worklet. Capturar o objeto de geometria inteiro jogaria um payload
  // fundo demais para a UI thread, e é assim que o device quebra em silêncio.
  const bloco = caminhos.bloco;
  const ciclo = caminhos.ciclo;
  const cx = g.bacia.x;
  const cy = g.bacia.y;
  // O gradiente do lençol é pedido no espaço de projeção, do lábio ao pé: a água clareia na
  // crista, afina no meio da queda e embranquece de novo antes de bater.
  const bocaX = g.labio.x;
  const bocaY = g.labio.y;
  const peX = g.pe.x;
  const peY = g.pe.y;
  const cristaY = g.labio.y - g.labio.rx * 0.34;

  const fluxo = useDerivedValue(
    () => (((clock.value * FLUXO_PX_S) % bloco) + bloco) % bloco, [clock, bloco]);
  const riscoTransform = useDerivedValue(() => [{ translateY: fluxo.value }], [fluxo]);
  // A ondulação corre um pouco mais devagar que o cordão: dois ritmos na mesma calha são o
  // que faz a folha ter espessura em vez de ser uma estampa só deslizando. O vão do ciclo é
  // o mesmo bloco, só o ritmo difere — e é o vão que tem de bater com o caminho.
  const ondula = useDerivedValue(
    () => (((clock.value * FLUXO_PX_S * 0.72) % ciclo) + ciclo) % ciclo, [clock, ciclo]);
  const veiaTransform = useDerivedValue(() => [{ translateY: ondula.value }], [ondula]);

  const faseA = useDerivedValue(() => (((clock.value * NEVOA_HZ) % 1) + 1) % 1, [clock]);
  const faseB = useDerivedValue(() => (((clock.value * NEVOA_HZ + 0.5) % 1) + 1) % 1, [clock]);
  const nevoaA = useDerivedValue(() => [{ translateY: -faseA.value * NEVOA_ALTA }], [faseA]);
  const nevoaB = useDerivedValue(() => [{ translateY: -faseB.value * NEVOA_ALTA }], [faseB]);
  // Nasce sumindo (o olho ainda está dentro do jato) e morre dissolvida, nunca cortada.
  const nevoaOpA = useDerivedValue(
    () => 0.3 * (1 - faseA.value) * Math.min(1, faseA.value * 5), [faseA]);
  const nevoaOpB = useDerivedValue(
    () => 0.26 * (1 - faseB.value) * Math.min(1, faseB.value * 5), [faseB]);

  const ondaA = useDerivedValue(() => (((clock.value * ONDA_HZ) % 1) + 1) % 1, [clock]);
  const ondaB = useDerivedValue(() => (((clock.value * ONDA_HZ + 0.55) % 1) + 1) % 1, [clock]);
  const ondaTA = useDerivedValue(() => [
    { translateX: cx }, { translateY: cy },
    { scaleX: 0.22 + ondaA.value * 0.68 }, { scaleY: 0.22 + ondaA.value * 0.68 },
    { translateX: -cx }, { translateY: -cy },
  ], [cx, cy, ondaA]);
  const ondaTB = useDerivedValue(() => [
    { translateX: cx }, { translateY: cy },
    { scaleX: 0.22 + ondaB.value * 0.68 }, { scaleY: 0.22 + ondaB.value * 0.68 },
    { translateX: -cx }, { translateY: -cy },
  ], [cx, cy, ondaB]);
  const ondaOpA = useDerivedValue(() => 0.42 * (1 - ondaA.value), [ondaA]);
  const ondaOpB = useDerivedValue(() => 0.34 * (1 - ondaB.value), [ondaB]);

  const pulso = useDerivedValue(() => 0.5 + 0.5 * Math.sin(clock.value * 3.1), [clock]);
  const espumaOp = useDerivedValue(() => 0.86 + pulso.value * 0.14, [pulso]);

  return (
    <Group>
      {/* Pedra encharcada: mais larga que a água e assentada na cota seca do chão. É ela que
          ancora a folha no relevo em vez de deixá-la boiando — e tem de ser um filete, porque
          ombro largo de pedra cinza em volta de um canal estreito é acostamento de asfalto. */}
      <Path path={caminhos.pedra} color="rgba(52,60,68,0.34)" />
      {/* A poça vem antes do lençol: o jato cai POR CIMA da água parada, e a margem da bacia
          aparece em volta sem cortar a queda. */}
      <Path path={caminhos.ombro} color="rgba(96,104,78,0.5)" />
      {/* A bacia clareia no miolo, onde o jato ainda está mexendo, e aprofunda para a
          margem. Sem o gradiente o disco inteiro tem o mesmo valor e é tinta derramada. */}
      <Path path={caminhos.poca}>
        <RadialGradient c={{ x: 0, y: 0 }} r={1}
          transform={[{ translateX: cx }, { translateY: cy }, { scaleX: g.bacia.rx },
            { scaleY: g.bacia.rx * 0.5 }]}
          colors={['rgba(46,106,126,0.86)', 'rgba(26,78,98,0.86)', 'rgba(15,54,72,0.9)']}
          positions={[0, 0.62, 1]}
        />
      </Path>
      <Path path={caminhos.anel} style="stroke" strokeWidth={1.8} color="rgba(214,240,252,0.85)"
        transform={ondaTA} opacity={ondaOpA} />
      <Path path={caminhos.anel} style="stroke" strokeWidth={1.5} color="rgba(214,240,252,0.75)"
        transform={ondaTB} opacity={ondaOpB} />
      {/* Corpo do lençol: a queda é a parte mais clara da paisagem, mas o meio é o lugar onde
          a pedra molhada aparece por dentro da cortina — opaco do começo ao fim, o lençol é
          tinta, não água. Só as pontas branqueiam: a aeração no lábio e o choque no pé. */}
      <Path path={caminhos.lenco}>
        <LinearGradient
          start={{ x: bocaX, y: bocaY }}
          end={{ x: peX, y: peY }}
          colors={[
            'rgba(240,251,255,0.96)',
            'rgba(206,232,246,0.78)',
            'rgba(176,208,230,0.64)',
            'rgba(170,202,226,0.64)',
            'rgba(206,232,246,0.8)',
            'rgba(244,252,255,0.96)',
          ]}
          positions={[0, 0.05, 0.3, 0.6, 0.88, 1]}
        />
      </Path>
      <Path path={caminhos.contorno} color="rgba(104,146,178,0.5)" style="stroke" strokeWidth={1.4} />
      {/* Crista do lábio: a água dobrando a pedra, branca e dentro da largura do canal. Vem
          ANTES dos cordões porque depois deles a boca tapava o começo da correnteza e a
          queda inteira nascia de um retângulo liso. O gradiente desce além do pé da crista
          para ela terminar no meio do declive da folha, não no corte dele. */}
      <Path path={caminhos.boca}>
        <LinearGradient
          start={{ x: bocaX, y: cristaY }}
          end={{ x: bocaX, y: bocaY + g.labio.rx * 1.1 }}
          colors={['rgba(255,255,255,0.98)', 'rgba(232,247,255,0.7)', 'rgba(214,238,250,0.22)']}
          positions={[0, 0.5, 1]}
        />
      </Path>
      <Group clip={caminhos.lenco}>
        <Path path={caminhos.sombra} color="rgba(78,116,148,0.26)" />
        <Path path={caminhos.veias} transform={veiaTransform} color="rgba(255,255,255,0.14)"
          style="stroke" strokeWidth={1.2} strokeCap="round" />
        <Path path={caminhos.riscos} transform={riscoTransform} color="rgba(255,255,255,0.85)"
          style="stroke" strokeWidth={2.6} strokeCap="round" />
      </Group>
      {/* Névoa, jato e respingo no pé: o impacto é mais branco que a folha, e a névoa sobe
          porque o choque arremessa bolha para cima mesmo com a água descendo. */}
      <Group transform={nevoaA} opacity={nevoaOpA}>
        <Path path={caminhos.nevoa} color="rgba(236,246,252,0.9)" />
      </Group>
      <Group transform={nevoaB} opacity={nevoaOpB}>
        <Path path={caminhos.nevoa} color="rgba(236,246,252,0.85)" />
      </Group>
      <Path path={caminhos.jato} color="rgba(250,253,255,0.92)" opacity={espumaOp} />
      <Path path={caminhos.respingo} color="rgba(255,255,255,0.9)" opacity={espumaOp} />
    </Group>
  );
}

/**
 * Camada das cachoeiras do mapa, entre o chão e os marcadores: é tinta sobre o relevo, e por
 * isso o mato e as entidades, que vêm depois na ordem do pintor, passam na frente dela. O
 * descarte é o da própria neblina, refeito no intervalo das outras camadas.
 */
export function CascadeLayer({ game, clock }: { game: GameState; clock: SharedValue<number> }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const iv = setInterval(() => setTick((t) => t + 1), GAME_CONFIG.ENTITY_CULL_MS);
    return () => clearInterval(iv);
  }, []);

  const quedas = useMemo(() => {
    const out: { id: number; g: GeometriaCascata }[] = [];
    for (const c of game.map.data.cascatas ?? []) {
      const g = geometriaDaCascata(c, (x, y) => game.map.heightSmoothAt(x, y));
      if (g) out.push({ id: c.id, g });
    }
    return out;
  }, [game]);

  const view = game.fog.view(game);
  const visiveis = quedas.filter(({ g }) => game.fog.intersects(view, g.caixa.x, g.caixa.y, g.caixa.w, g.caixa.h));

  return (
    <Group>
      {visiveis.map(({ id, g }) => <Queda key={id} g={g} clock={clock} />)}
    </Group>
  );
}
