import { GAME_CONFIG } from '../game/GameConfig';
import { ELEVATION_PX } from '../world/IsoUtils';

/**
 * A coluna de ar.
 *
 * Até hoje a altura só existia como deslocamento de tela: `worldToScreen` tira `h * 64` pixels do
 * eixo Y e o teto do voo era o ponto em que a lataria saía do quadro. Isso não é voar — é deslizar
 * um sprite para cima até ele sumir, e é por isso que o helicóptero parecia preso ao iso: acima de
 * oito tiles o mundo não encolhia, não fechava, não mudava de natureza, só escorregava para fora
 * da tela.
 *
 * Este sistema é o único lugar onde a coluna existe. Ele não integra nada nem manda em corpo
 * nenhum: recebe a cota de quem está no comando e devolve um instantâneo numérico — onde está a
 * manta, quanta nuvem há neste ponto do céu, quanto do ar ainda iça, para onde o vento empurra e
 * quanta cidade ainda se vê lá embaixo. Câmera, movimento, nuvens e som leem daqui, e é por isso
 * que atravessar a linha de nuvem é uma travessia e não um corte de cena: os quatro olham para a
 * mesma curva no mesmo quadro.
 *
 * A manta não é um plano texturizado: é um CAMPO sobre o mundo (`mantaEm`), com buracos, que anda
 * com o vento do clima. Ter buraco é o que faz a coisa parecer ar em vez de parede — você sobe pela
 * barriga cinza, a cidade fecha num algodão, e de repente abre um rasgo e lá está o bairro outra
 * vez, trinta segundos antes de sumir de novo.
 */

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0);
const mix = (a: number, b: number, t: number) => a + (b - a) * clamp01(t);

/** Sobe de 0 a 1 entre `de` e `ate` em curva, sem degrau nas pontas. Inverte se `de > ate`. */
function rampa(de: number, ate: number, v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (Math.abs(ate - de) <= 1e-6) return v >= ate ? 1 : 0;
  const t = clamp01((v - de) / (ate - de));
  return t * t * (3 - 2 * t);
}

// ---------------------------------------------------------------------------
// O campo de nuvem
// ---------------------------------------------------------------------------

const RAIZ2 = Math.SQRT1_2;
const ONDE = GAME_CONFIG.NUVEM_ONDE;

/**
 * Ruído de valor determinístico. Não passa pelo `rng` do jogo de propósito: a nuvem é um lugar, não
 * um sorteio — ela tem de estar no mesmo ponto quando o jogador voltar por ela depois de descer e
 * subir de novo, e um save carregado não pode encontrar o céu em outro lugar.
 */
function celula(i: number, j: number): number {
  const s = Math.sin(i * 127.1 + j * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

function ruido(x: number, y: number): number {
  const i = Math.floor(x), j = Math.floor(y);
  const fx = x - i, fy = y - j;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  const a = celula(i, j), b = celula(i + 1, j), c = celula(i, j + 1), d = celula(i + 1, j + 1);
  return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v;
}

/**
 * 0..1 de nuvem neste ponto do céu, em três escalas: o vulto grande que decide onde a manta existe,
 * o médio que abre o buraco, o pequeno que mastiga a borda. A deriva desloca o campo com o vento, e
 * é ela que faz a sombra da nuvem andar sobre a cidade.
 *
 * O número é um RANKING do céu, não uma opacidade: ele só diz qual é o tojo daquele ponto. Quem
 * decide quantos tojos existem é a cobertura do clima, na `nuvemNoCampo`. Misturar as duas aqui é o
 * erro que parece sutil e entrega um céu limpo num dia de tempestade.
 */
export function mantaEm(
  x: number, y: number, tempo: number, derivaX: number, derivaY: number,
): number {
  const dx = x - derivaX * tempo;
  const dy = y - derivaY * tempo;
  const bruto = ruido(dx / 26, dy / 26) * 0.58
    + ruido(dx / 9.5 + 4.3, dy / 9.5 - 2.1) * 0.29
    + ruido(dx / 3.4 - 7.7, dy / 3.4 + 5.2) * 0.13;
  // O somatório de ruídos se acumula no meio; o estiramento devolve o campo a um ranking igualmente
  // provável em todo o céu, que é o que faz "45% de cobertura" fechar 45% do mundo.
  return clamp01(0.5 + (bruto - 0.5) * 1.7);
}

/**
 * O ranking virou nuvem: um ponto do céu está fechado quando o tojo dele está acima do limiar que a
 * cobertura deixou sobrando. As bordas têm ONDE/7 de maciez para o tojo ter contorno visível em vez
 * de um dente de serra na tela — e para haver, dentro da manta, o rasgo por onde a cidade reaparece.
 */
export function nuvemNoCampo(
  x: number, y: number, tempo: number, derivaX: number, derivaY: number, fechada: number,
): number {
  // Calibre medido, não teoria: o somatório de ruídos é denso no meio, então o limiar cru fecharia
  // 71% do céu num dia de 60% de cobertura. Os dois números abaixo são o ajuste que devolve ao
  // número do clima o que ele promete na tela.
  const coberto = clamp01((clamp01(fechada) - 0.02) / 1.12);
  const limiar = 1 - coberto;
  const mole = ONDE / 12;
  return rampa(limiar - mole, limiar + mole, mantaEm(x, y, tempo, derivaX, derivaY));
}

// ---------------------------------------------------------------------------
// As curvas que a tela e o manche partilham
// ---------------------------------------------------------------------------

const MAO = GAME_CONFIG.HELI_CEILING_ELEVATION;

/**
 * Onde a altura ainda é pixel de tela, e onde ela passa a ser escala.
 *
 * Abaixo da linha de passagem a função é a identidade, e isso não é elegância de corte: é o que
 * garante que o voo raso não se moveu um décimo de pixel. Um helicóptero pairando a 2,2 tiles sobre
 * o platô continua com a lataria exatamente `altitude * ELEVATION_PX` acima da própria sombra, como
 * sempre esteve, e o check que mede isso no canvas continua medindo a mesma coisa.
 *
 * Acima da linha, a curva satura. A cota continua subindo de verdade — é ela que o piloto comanda e
 * que decide se você está ou não atrás da nuvem — mas a tela para de receber translação, porque o
 * que faz "subir" parecer subir não é a lataria ir para o topo do quadro: é o mundo embaixo dela
 * encolher e a nuvem fechar.
 */
export function alturaDeTela(cota: number): number {
  if (!Number.isFinite(cota)) return 0;
  if (cota <= MAO) return cota;
  return MAO + GAME_CONFIG.ISO_SPAN_ACIMA_DO_QUADRO
    * (1 - Math.exp(-(cota - MAO) / GAME_CONFIG.ISO_SATURACAO));
}

/**
 * Quantos tiles de tela cabem na folga que a lataria tem acima do anchor da câmera. É a conta que
 * transforma a fração do quadro em unidade de mundo, e ela depende do zoom porque meio quadro são
 * PIXELS: a mesma máquina que enche um retrato de 360 px é uma ficha num monitor de 1200, e a cota
 * onde ela para de escorregar para cima tem de ser outra em cada um.
 */
export function folgaDoQuadro(viewH: number, zoom: number): number {
  const metade = (Number.isFinite(viewH) ? Math.max(1, viewH) : 1) / 2;
  return GAME_CONFIG.ALTURA_NO_QUADRO * metade / (ELEVATION_PX * Math.max(0.05, zoom));
}

/**
 * A cota que a câmera mira. É o par da função acima e só existe para que as duas se cancelem
 * embaixo: a lataria fica `alturaDeTela(cota) - aqui` acima do centro do quadro. Enquanto ela cabe
 * na folga, o `max` segura a câmera no chão de sempre e a distância é `altitude * 64` pixels — o
 * voo raso não se move um décimo. Quando estoura, a câmera sobe junto e a folga vira o teto da
 * translação: a máquina para de escorregar pelo quadro em vez de ir embora da tela.
 */
export function ancoraDaCamera(cota: number, chao: number, folga: number): number {
  return Math.max(chao, alturaDeTela(cota) - Math.max(0, folga));
}

/**
 * Pixels de tela entre a lataria e o chão debaixo dela. É uma conta só, num lugar só, para que o
 * sprite, o descarte de visibilidade e o laço de simulação concordem sobre onde a máquina está
 * desenhada: abaixo da linha de passagem ela vale `altitude * ELEVATION_PX`, exatamente como sempre
 * valeu, e é ela que o check do rotor lê no canvas.
 */
export function liftDeTela(cota: number, chao: number): number {
  return (alturaDeTela(cota) - chao) * ELEVATION_PX;
}

/**
 * O teto da curva acima, em tiles de tela: `alturaDeTela` não passa de 15 por construção, não
 * importa a cota. É o número que o descarte de visibilidade usa para dilatar a janela dos
 * aparelhos — com a cota livre até 46 tiles, dilatar pelo antigo teto isométrico deixaria um
 * helicóptero entrar voando pelo canto da tela com um sumiço no lugar.
 */
export const ALTURA_DE_TELA_MAX = MAO + GAME_CONFIG.ISO_SPAN_ACIMA_DO_QUADRO;

/** Quanto do quadro ainda é cidade desenhada: 1 no voo raso, 0 lá em cima. */
export function cidadeNaCota(cota: number): number {
  // O fim da curva é perto do teto, não no meio do caminho: quem tira a cidade do quadro é a
  // nuvem, e a altitude só vai afastando o chão devagar até você estar acima de tudo.
  return 1 - rampa(MAO, GAME_CONFIG.CEU_TETO * 0.8, cota);
}

/** O zoom que a altura pede. Abaixo da linha de passagem é o zoom de sempre, sem tocar. */
export function zoomDaAltura(cota: number): number {
  return mix(GAME_CONFIG.ZOOM_DEFAULT, GAME_CONFIG.ZOOM_ALTO, 1 - cidadeNaCota(cota));
}

// ---------------------------------------------------------------------------
// O instantâneo
// ---------------------------------------------------------------------------

export interface SkyEnvironment {
  /** Posição no mundo de quem está no comando — a manta é um campo, então o ponto importa. */
  x: number;
  y: number;
  /** Cota absoluta em tiles do aparelho (ou da câmera, quando não há aparelho no ar). */
  cota: number;
  /** Chão desenhado debaixo daquele ponto, em tiles. */
  chao: number;
  /** 0..1 de céu coberto (`WeatherSystem.cover`): decide se há manta e onde ela está. */
  cobertura: number;
  /** 0..1 de névoa da frente: a parede que fecha embaixo e que se sobe para deixar atrás. */
  nevoia: number;
  /** -1..1 do vento (frente + perigo): a mesma inclinação que deita a chuva na tela. */
  vento: number;
  /** 0..1 de frente severa: tempestade derruba a base da manta até o nível do voo raso. */
  severidade: number;
  /** Relógio do mundo: é o que faz o campo andar com o vento. */
  tempo: number;
}

export interface SkySnapshot {
  readonly cota: number;
  readonly chao: number;
  readonly teto: number;
  readonly base: number;
  readonly topo: number;
  /**
   * 0..1 de céu que fecha. Sem este número a manta não existe: `base` e `topo` são um intervalo
   * TEÓRICO que o sistema sempre publica, mesmo num dia de azul absoluto — e quem desenha nuvem a
   * partir só deles pinta algodão e escreve "NUVEM 480 m" para um céu limpo. A opacidade do mundo
   * vem daqui; a geometria vem daqueles dois.
   */
  readonly cobertura: number;
  /** 0..1 de nuvem DENTRO DO CASCO: a parede branca, e o que a polícia não vê através. */
  readonly dentro: number;
  /** 0..1 da parede branca JÁ SUAVIZADA: o que o render pinta, para a borda não piscar. */
  readonly bruma: number;
  /** 0..1 de manta pendurada ENTRE quem olha e o chão: lá de cima, a cidade fechou no algodão. */
  readonly fechamento: number;
  /** 0..1 por cima de tudo: o mar de nuvens é o chão e a cidade é o que você não vê mais. */
  readonly acima: number;
  /** 0..1 de quanta cidade ainda se vê lá embaixo, entre o raro, o longe e o tapado. */
  readonly visivel: number;
  /** 0..1 o ar já não iça: é o teto sentido no manche, não um clamp na cota. */
  readonly rarefeito: number;
  /** 0..1 a cidade ainda é o chão (a curva geométrica da câmera, exposta para o render). */
  readonly cidade: number;
  /** Tiles por segundo de deriva no plano do mundo. */
  readonly ventoX: number;
  readonly ventoY: number;
}

const VAZIO: SkySnapshot = Object.freeze({
  cota: 0, chao: 0, teto: GAME_CONFIG.CEU_TETO, base: GAME_CONFIG.NUVEM_BASE_ALTA,
  topo: GAME_CONFIG.NUVEM_BASE_ALTA, cobertura: 0, dentro: 0, bruma: 0, fechamento: 0, acima: 0,
  visivel: 1, rarefeito: 0, cidade: 1, ventoX: 0, ventoY: 0,
});

/** Uma bolha do teto de nuvem, no plano do mundo. O raio é em tiles. */
export interface CloudBlob { x: number; y: number; r: number }

/**
 * O ar acima da cidade. Não tem mapa, não tem save, não tem `init`: o único estado é o que ele
 * suaviza de um quadro para o outro para a parede de nuvem não piscar quando o casco roça uma borda
 * do campo.
 */
export class AltitudeSystem {
  private published: SkySnapshot = VAZIO;
  private brumaSuavizada = 0;
  private teto: number = GAME_CONFIG.CEU_TETO;
  private base: number = GAME_CONFIG.NUVEM_BASE_ALTA;
  private topo: number = GAME_CONFIG.NUVEM_BASE_ALTA;
  /** O quanto o céu do dia fecha: 0 é um azul sem nada, 1 é teto de nuvem colado no voo raso. */
  private fechada = 0;

  get snapshot(): SkySnapshot { return this.published; }
  /** O ar tem teto, e ele fica ACIMA da manta: sem folga sobrando, nuvem seria parede. */
  get doTeto(): number { return this.teto; }
  get daBase(): number { return this.base; }
  get doTopo(): number { return this.topo; }
  /** Zero quando a bruma foi embora: o render desliga a camada inteira em vez de pintar branco. */
  get bruma(): number { return this.brumaSuavizada; }
  get doCeu(): number { return this.fechada; }

  update(dt: number, env: SkyEnvironment): SkySnapshot {
    if (!Number.isFinite(dt) || dt <= 0) return this.published;

    this.fechada = clamp01(Math.max(env.cobertura, env.severidade * 0.85));
    this.base = mix(GAME_CONFIG.NUVEM_BASE_ALTA, GAME_CONFIG.NUVEM_BASE_BAIXA, this.fechada);
    this.topo = this.base
      + mix(GAME_CONFIG.NUVEM_ESPESSURA[0], GAME_CONFIG.NUVEM_ESPESSURA[1], this.fechada);
    this.teto = Math.max(GAME_CONFIG.CEU_TETO, this.topo + GAME_CONFIG.CEU_FOLGA);

    // O vento é o da tela (é ele que deita a chuva) e vira deriva no eixo iso: +X de tela é a
    // diagonal (1,-1) no plano. A força cresce com a altura porque no meio da rua o prédio barra o
    // ar, e lá em cima não há nada que o barra.
    const altitude = 1 - cidadeNaCota(env.cota);
    const rajada = 1 + 0.22 * Math.sin(env.tempo * 0.31) + 0.13 * Math.sin(env.tempo * 0.83 + 1.7);
    const forca = GAME_CONFIG.VENTO_MAX * env.vento * (0.35 + 0.65 * altitude) * rajada;
    const ventoX = forca * RAIZ2;
    const ventoY = -ventoX;

    const tojo = nuvemNoCampo(env.x, env.y, env.tempo, ventoX, ventoY, this.fechada);
    const dentro = this.nuvemNoPonto(env.cota, tojo);
    // A névoa da manhã é um andar embaixo de tudo: fecha no chão e acaba uma hora depois do
    // telhado. Subir acima dela e ver a cidade reaparecer é a prova mais barata que existe de que a
    // altura é de verdade — e era impossível de notar enquanto altura só movia sprite.
    const bruma = Math.max(dentro, env.nevoia * rampa(env.chao + GAME_CONFIG.BRUMA_DO_CHAO,
      env.chao - 0.4, env.cota));
    // Histerese de um terço de segundo: na borda mastigada do campo o casco entra e sai a cada
    // quadro, e sem memória a tela esbranaça e volta em vez de fechar.
    this.brumaSuavizada += (clamp01(bruma) - this.brumaSuavizada) * (1 - Math.exp(-dt * 3.2));

    // Duas coisas tapam a cidade lá de baixo e a mais forte vence: a manta no meio do caminho do
    // olhar (não adianta haver buraco no meu ponto se o teto de nuvem inteiro está entre mim e o
    // chão) e a parede em que eu mesmo estou metido. Depois vem a distância: a 46 tiles o bairro é
    // uma ficha, e ficha nenhuma se lê.
    const fechamento = this.fechada * rampa(this.base - ONDE, this.base + ONDE * 2, env.cota);
    const tapado = Math.max(fechamento, this.brumaSuavizada);

    const next: SkySnapshot = {
      cota: env.cota,
      chao: env.chao,
      teto: this.teto,
      base: this.base,
      topo: this.topo,
      cobertura: this.fechada,
      dentro,
      bruma: this.brumaSuavizada,
      fechamento,
      acima: tojo * rampa(this.topo - ONDE, this.topo + ONDE * 2, env.cota),
      visivel: clamp01((1 - tapado) * (1 - rampa(MAO * 2.5, this.teto, env.cota) * 0.55)),
      rarefeito: rampa(MAO + 4, this.teto, env.cota),
      cidade: cidadeNaCota(env.cota),
      ventoX,
      ventoY,
    };
    this.published = next;
    return next;
  }

  /**
   * Quanta nuvem tem dentro deste casco. É a pergunta que a perseguição aérea faz: um helicóptero
   * de polícia atrás de você não vê através de algodão, e quem some na manta não fugiu por
   * velocidade — foi para um ar que a máquina dele não alcança.
   */
  dentroDoCasco(x: number, y: number, cota: number, tempo: number): number {
    const { ventoX, ventoY } = this.published;
    return this.nuvemNoPonto(cota,
      nuvemNoCampo(x, y, tempo, ventoX, ventoY, this.fechada));
  }

  /**
   * Quanta nuvem há na LAJE de ar entre duas cotas do mesmo ponto. É a pergunta que a perseguição
   * aérea faz de cabeça para baixo: o piloto da ronda não está dentro do algodão, ele está embaixo
   * olhando para cima, e o que separa os dois é a espessura da manta no meio do olhar.
   *
   * Não é a fração da linha que conta — é a espessura. Um dedo de nuvem já some com um aparelho a
   * vinte tiles de altitude, e é por isso que a curva satura em pouco mais de um tile.
   */
  obstrucao(x: number, y: number, cotaA: number, cotaB: number, tempo: number): number {
    if (!Number.isFinite(cotaA) || !Number.isFinite(cotaB)) return 0;
    const de = Math.min(cotaA, cotaB), ate = Math.max(cotaA, cotaB);
    const espessura = Math.min(ate, this.topo) - Math.max(de, this.base);
    if (espessura <= 0) return 0;
    const { ventoX, ventoY } = this.published;
    const tojo = nuvemNoCampo(x, y, tempo, ventoX, ventoY, this.fechada);
    return clamp01(tojo * (0.35 + this.fechada * 0.8)) * rampa(0.2, 1.6, espessura);
  }

  /**
   * As bolhas que o render desenha deste lado do casco. A grade é grossa e deslocada por um hash
   * fixo, e o que cada bolha carrega é o TAMANHO, não a opacidade: assim a manta inteira sai num
   * caminho Skia só, preenchido uma vez, e o buraco continua sendo a ausência de bolha — que é o
   * que faz a cidade reaparecer por cima do ombro quando você sobe.
   *
   * O passo é parâmetro porque o quadro muda de tamanho: com o zoom no teto a janela visível é ~2,5
   * vezes mais larga, e engrossar a grade é o que mantém o custo parado — bolha maior no lugar de
   * bolha a mais, nunca um canto do quadro sem manta porque a lista estourou o teto.
   *
   * Roda no laço de simulação, não no worklet: o UI thread não tem campo de nuvem nenhum, e a
   * manta é lenta o bastante para ser redesenhada seis vezes por segundo sem que ninguém note.
   */
  pinta(x: number, y: number, alcance: number, tempo: number,
    passo: number = GAME_CONFIG.NUVEM_PINTURA): CloudBlob[] {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !(alcance > 0)) return [];
    const { ventoX, ventoY } = this.published;
    const blobs: CloudBlob[] = [];
    const i0 = Math.floor((x - alcance) / passo), i1 = Math.ceil((x + alcance) / passo);
    const j0 = Math.floor((y - alcance) / passo), j1 = Math.ceil((y + alcance) / passo);
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        // O desencontro tira o xadrez da grade sem tirar o lugar: o mesmo tile dá a mesma bolha
        // em qualquer quadro, em qualquer dia. A folga é de três décimos do passo, e esse número
        // é o que separa nuvem de peneira: com um passo inteiro de deslocamento, dois vizinhos
        // podem cair a dois passos um do outro e, com raio de um passo, aquilo que era laje vira
        // malha. A cidade legível através de um céu fechado, no navegador, não veio desta linha:
        // veio da ordem de pintura — a manta entrava antes dos prédios, e prédio desenha por cima.
        const cx = (i + 0.5 + (celula(i, j) - 0.5) * 0.6) * passo;
        const cy = (j + 0.5 + (celula(j + 7919, i - 131) - 0.5) * 0.6) * passo;
        const v = nuvemNoCampo(cx, cy, tempo, ventoX, ventoY, this.fechada);
        if (v < 0.45) continue;
        // Raio mínimo de 1,26 passo: vizinho ortogonal mais distante possível fica a 1,6, o
        // diagonal a 2,26 — e duas bolhas desses raios somam 2,52. Onde o campo diz que há nuvem,
        // há nuvem pintada; o buraco que sobra é lugar do campo, não lacuna da grade.
        blobs.push({ x: cx, y: cy, r: passo * (0.95 + 0.7 * v) });
        if (blobs.length >= 420) return blobs;
      }
    }
    return blobs;
  }

  /**
   * A barriga e o lombo engolem antes e depois do bloco: não há linha onde a visibilidade acaba, há
   * dois tiles e meio de "está ficando branco". A espessura é o que separa uma nuvem alta e fofa —
   * onde ainda dá para ver a asa — de um céu fechado e cego.
   */
  private nuvemNoPonto(cota: number, tojo: number): number {
    const atravessa = rampa(this.base - ONDE, this.base + ONDE, cota)
      * (1 - rampa(this.topo - ONDE, this.topo + ONDE * 2, cota));
    return clamp01(tojo * (0.35 + this.fechada * 0.8) * atravessa);
  }
}
