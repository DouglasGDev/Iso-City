import { GAME_CONFIG, type Dir4 } from '../game/GameConfig';
import {
  BOARDING_DOOR,
  BOARDING_REACH,
  buildTransportNetwork,
  meiaCaixaEntre,
  MEIA_LARGURA,
  naPlataforma,
  noPonto,
  plataformaDaLinha,
  RAIO_DO_ONIBUS,
  seEncostamEntre,
} from '../data/transport/network';
import {
  departures,
  nextArrivals,
  passAt,
  planTrip,
  sampleRoute,
  stopsNear,
} from '../data/transport/schedule';
import type { RoadGraph, TransportNetwork, TransportStation } from '../data/transport/types';
import type { TransportArrival, TransportDeparture, TransportLeg, TransportTrip } from '../data/transport/schedule';
import { isAboard, type Player } from '../entities/Player';
import type { CollisionSystem } from './CollisionSystem';
import type { Map } from '../world/Map';
import { angleToWorldDirStable } from '../world/IsoUtils';
import type { WorldStreamingManager, StreamingTier } from '../world/streaming/WorldStreamingManager';
import type { TrafficSignal, TrafficSignalSystem } from './TrafficSignalSystem';
import { TIER } from '../world/streaming/WorldStreamingManager';

/**
 * Uma sonda do portão a cada tantos tiles de polilinha. Quatro é um quarto de chunk: o
 * portão decide em chunks, então a amostra nunca muda a decisão que a rota inteira daria.
 */
const PROBE_STEP = 4;

/** Resto positivo: o ciclo do horário é um anel, e um `passo` negativo ali é volta anterior. */
const mod = (v: number, m: number) => ((v % m) + m) % m;

/**
 * O corpo de um ônibus no asfalto, na forma mais estreita que uma aproximação de trânsito
 * precisa saber de quem ela não dirige: onde está, para onde aponta, quão rápido vai e quão
 * largo é. Um ônibus do horário ainda não é um `Vehicle` — não tem lataria, motorista nem
 * banco —, mas ele ocupa uma faixa, e um carro que o atravessa é o acidente que o jogador vê
 * e não consegue explicar. É por isso que a malha entrega estes corpos ao `TrafficSystem`,
 * que os põe na mesma vizinhança onde estão os carros que ele dirige.
 */
export interface StreetBody {
  x: number;
  y: number;
  dir: Dir4;
  /** Rumo real em radianos, o mesmo `angle` da unidade que o corpo representa. */
  angle: number;
  /** 0 na calçada, o cruzeiro da linha no asfalto — é o que diz se o corpo segura fila. */
  speed: number;
  /** Meia-largura no eixo da via, no mesmo padrão do `radiusOf` do trânsito. */
  radius: number;
  /**
   * Meia-lataria nos dois eixos do corpo: comprimento (`meio`) e largura (`flanco`). Para um
   * ônibus da malha são `RAIO_DO_ONIBUS` × `MEIA_LARGURA`, e é isto que faz da caixa uma caixa
   * de ônibus. Um corpo emprestado da rua traz a lataria dele — um sedã é mais curto e mais
   * estreito, um pedestre é um círculo de quinze centésimos de tile — e é por isso que a régua
   * não pode mais presumir que tudo que encontra no asfalto é outro ônibus: com a largura do
   * ônibus no pedestre, a faixa de um ponto engoliria o passeio e cada pessoa parada no
   * meio-fio prenderia a linha inteira.
   */
  meio: number;
  flanco: number;
  /** Fora do alcance da câmera o horário não é calculado, então o corpo não está na rua. */
  live: boolean;
}

/**
 * Um corpo que a rua entrega ao ônibus: pedestre, bicho, carro. É a mesma forma que a olhada
 * para a frente já sabe medir no `StreetBody` — posição, rumo, velocidade e lataria — só que
 * sem horário, sem fila e sem índice na frota.
 */
export interface RuaCorpo {
  x: number;
  y: number;
  angle: number;
  speed: number;
  meio: number;
  flanco: number;
  /**
   * Mole é corpo vivo: quem o ônibus sempre cede o passo, e a quem ele nunca empurra — recuar
   * de um pedestre é dar ré na avenida porque um atravessou a faixa. Fundo é lataria: um veículo
   * na minha faixa disputa asfalto como qualquer ônibus, com corrente e tudo.
   */
  mole: boolean;
}

/**
 * A rua vista do asfalto, do jeito que o ônibus precisa: um raio em torno de um ponto e uma
 * visita para cada corpo que mora ali. É a grade de vizinhança do `GameState` por trás de um
 * contrato que não aloca nada, porque a olhada para a frente roda para cada ônibus vivo, a cada
 * quadro, e um array novo por consulta é trabalho para o coletor no meio do frame.
 *
 * O corpo visitado é emprestado de quem fornece e só vale durante a chamada: quem quiser guardar
 * um tem de copiar.
 */
export interface RuaVisivel {
  pertoDe(x: number, y: number, raio: number, visita: (corpo: RuaCorpo) => void): void;
}

/**
 * O corpo de um veículo do horário de uma linha. O estado é derivado do relógio a cada leitura,
 * então um ônibus congelado fora da área de streaming não acumula erro: quando o jogador volta,
 * a posição que aparece é a que o horário manda, não a última que ele viu.
 */
export interface TransportUnit {
  route: number;
  unit: number;
  x: number;
  y: number;
  angle: number;
  /**
   * Quadrante do sprite. Derivado do `angle` com a mesma histerese do jogador a pé, porque
   * uma linha que contorna uma caixa faz o ângulo cruzar a fronteira do quadrante no meio
   * do gesto — sem folga o ônibus piscaria entre duas artes a cada curva.
   */
  dir: Dir4;
  /** Encostado na calçada, embarcando. */
  stopped: boolean;
  /**
   * Encostado no berço de origem, fechando a volta: a porta abre para quem desce e não embarca
   * ninguém. A partida que o telão anuncia é a primeira passada do ciclo seguinte, no mesmo tile,
   * e embarcar neste aqui seria viajar antes do horário prometido — painel e asfalto contando
   * histórias diferentes.
   */
  parked: boolean;
  /**
   * Índice da parada da rota que o veículo está servindo agora — a calçada onde ele encosta,
   * e o único lugar onde a porta abre. É o espelho do `stop` do horário: sem ele, um
   * passageiro que desembarcasse não teria calçada nenhuma para pisar.
   */
  stop: number;
  /**
   * Índice da passada desta unidade na tabela da rota. É o `stop` com o sentido: a mesma
   * calçada é servida duas vezes por volta, uma para cada ponta, e o plano de viagem promete
   * uma delas. Embarcar na outra é descer do outro lado da cidade uma volta depois.
   */
  pass: number;
  /**
   * Instante da volta de que o último `sampleRoute` foi lido, em [0, ciclo). É o espelho do
   * horário, e a única peça que diz *há quanto* este ônibus está encostado: parado, o corpo não
   * depende de `phase`, mas `atraso` depende — ver `recede`.
   */
  phase: number;
  /**
   * A linha desta unidade está no alcance da câmera, então o horário dela é calculado. É o
   * portão da linha inteira: uma rota que atravessa a cidade tem carro nos dois cantos, e o
   * que decide se ele existe é o chunk onde ele está, não a distância dele até a câmera.
   */
  live: boolean;
  /**
   * Segundos que este ônibus vai atrás do horário porque a faixa dele estava ocupada. É o
   * único estado que a malha guarda: a posição continua sendo função pura do relógio, só que
   * lido em `time - atraso`. Sem isto dois ônibus da mesma esquina chegam no mesmo pixel — o
   * horário é uma conta, não uma fila, e nada nele impede um carro de encostar no outro.
   * O teto é a volta do ciclo menos a parada: um ônibus a quem a rua comeu uma volta inteira
   * não é um ônibus atrasado, é um ônibus que sumiu do telão.
   */
  atraso: number;
  /**
   * Está sendo segurado por alguém à frente neste frame. É o que faz o corpo reportar
   * velocidade zero: o carro atrás do ônibus freia diante de um parado, não diante de um que
   * o horário jura estar andando.
   */
  held: boolean;
  /**
   * Se o pé deste ônibus está no chão: o aperto chegou ao teto, e o teto é a lataria dentro da
   * própria linha de parada. Abaixo dele o freio dosa, e a dosagem é o que mantém a fila andando
   * — ver o degrau em `cuidaDaFrente`. É a memória que o `held` não tem: `held` é posto também
   * pelo recuo de emergência e pela espera do passageiro, e aqui só conta o pedal.
   */
  plantado: boolean;
  /**
   * Segundos de parada extra que esta unidade já deu a quem está no ponto dela neste encosto.
   * É conta de *encontro*, não de relógio: zera no instante em que o ônibus deixa a calçada,
   * porque o próximo veículo do horário deve a mesma chance ao próximo passageiro. Sem ele a
   * espera seria um contrato infinito — um pedestre passeando ao lado do marco prendceria a
   * linha inteira no passeio.
   */
  embarque: number;
}

/**
 * Palmo de asfalto entre dois para-choques que param na mesma fila — o mesmo 0,25 que o
 * trânsito deixa entre carros, para a régua dos dois sistemas dizer a mesma coisa.
 */
export const FOLGA_PARA_CHOQUE = 0.25;

/**
 * Rua a partir da qual o ônibus tira o pé. Sem este horizonte a fila seria um "pare tudo" no
 * instante em que o para-choque encosta, e um corpo que freia de 3,5 tiles por segundo para
 * zero num frame atravessa o da frente: o aperto precisa crescer antes do encontro, não depois.
 */
const HORIZONTE_DE_FREIO = 1.25;

/**
 * Margem lateral além de onde as duas latarias se encostam. É um dedo, não meia faixa: com
 * meio tile de folga o ônibus do sentido contrário — a um tile de centro a centro no asfalto
 * gerado — entraria na conta e a avenida inteira pararia de um lado só.
 */
const FOLGA_LATERAL = 0.05;

/**
 * O relógio da malha é o do jogo, e um ônibus parado não é um relógio atrasado de verdade: ele
 * anda um passo para trás no horário enquanto a rua estiver ocupada, e recupera a marcha quando
 * ela abre. Recuperar é mais lento que perder — metade por segundo — porque um ônibus que cola
 * no horário a cada buraco de dois segundos nunca forma fila em ponto nenhum.
 */
const ATRASO_RECUPERA = 0.5;

/**
 * Janela de tempo em que dois rumos que se cruzam disputam o mesmo ponto do asfalto. Fora
 * dela um passa antes de o outro chegar, e ônibus nenhum freia para o que ainda é hipótese do
 * outro lado do cruzamento. Dentro de `ENCONTRO_IMINENTE` o pé vai fundo: ali não é dosar, é
 * parar, porque os dois corpos já não cabem no mesmo quadro.
 */
const JANELA_DE_ENCONTRO = 1.2;
const ENCONTRO_IMINENTE = 0.4;

/**
 * Rua que um ônibus recém-chegado ao alcance da câmera aceita percorrer para descolar lataria,
 * para trás e para frente. O horário é uma conta e a conta não sabe que existe um corpo
 * naquele pixel: quando a linha entra em cena, as unidades dela aparecem todas de uma vez, e
 * a rua pode estar tomada. Meio tile a mais que a própria lataria é o suficiente para achar
 * buraco; se não houver, o ônibus nasce na frente do ponto, não em cima do vizinho.
 */
const BUSCA_DE_BURACO = 12;

/**
 * Corpos em fila no ponto de ônibus: quantos corpos um ônibus parado pode avançar pela
 * calçada adiante antes de se entender que a fila não cabe ali. Quatro é meia quadra de
 * marquise — mais que isso o veículo estaria esperando um ponto longe do passeio onde o
 * passageiro está, e um ponto de ônibus não é um estacionamento de rodoviária.
 */
export const FILA_DO_PONTO = 4;

/**
 * Segundos de porta aberta a mais que um ônibus dá a quem está esperando no ponto. O horário
 * só dá `service.dwell` — dois segundos, que é o tempo de uma conta de cobrador, não o de um
 * pedestre que viu o ônibus encostar do outro lado da faixa, andou até lá e ainda tem de tocar
 * no botão. A espera extra não é comida da marcha: ela é escrita como atraso, um segundo de
 * relógio por segundo de rua, então o corpo fica plantado no berço e o `dwell` do horário não
 * muda. É por isso também que ela tem teto próprio, além do teto do horário: ônibus nenhum vira
 * ponto de estacionamento.
 */
const EMBARQUE_ESPERA_MÁX = 8;

/**
 * Distância do marco até onde se considera que alguém *está* no ponto, e não só passando na
 * calçada ao lado. É a zona de embarque pintada (`TransportStation.ponto`) mais uns poucos
 * passos de aproximação: quem vem pela calçada na direção do poste já é o passageiro que o
 * motorista está esperando, e obrigá-lo a pisar exatamente na marquise para a porta fechar na
 * sua cara é o "não dá para entrar" que o jogador reclama.
 */
const EMBARQUE_APROXIMA = 5;

/**
 * Dois para-choques no mesmo milímetro não dizem quem é o de trás. É o caso do ônibus que
 * nasce em cena em cima do vizinho e o das duas linhas que o horário pôs no mesmo ponto da
 * mesma faixa: sem esta folga o cone devolve `null` para os dois lados, ninguém freia para
 * ninguém e a lataria atravessa a lataria para sempre.
 */
const MESMO_MILIMETRE = 0.02;

/**
 * Rua que um ônibus precisa para se descolar sozinho de um vizinho que está em cima dele: a
 * lataria inteira mais o palmo de para-choque. É o mínimo que o `abraço` exige de quem vai
 * ceder, porque corda de relógio menor que isto paga um recuo que não chega para separar as duas
 * caixas — o par continuaria colado, só que com os dois lados da conta concordando que não há
 * nada a fazer.
 */
const PREÇO_DO_ABRAÇO = 2 * RAIO_DO_ONIBUS + FOLGA_PARA_CHOQUE;

/**
 * Até onde o ônibus enxerga a rua. O cone de freio alcança, no máximo, a linha de parada mais o
 * horizonte (`~2,9` tiles), e a travessia é conta de tempo: a marcha de cruzeiro pela janela de
 * encontro (`3,5 × 1,2 = 4,2` tiles) é o corpo mais longe que ainda pode chegar antes de mim no
 * mesmo ponto. Seis tiles cobrem as duas contas com a lataria do visitado, e é a caixa da grade
 * de vizinhança — nada de varrer a cidade.
 */
const RAIO_DA_OLHADA = 6;

/**
 * Até onde o ônibus procura o próximo semáforo, no próprio rumo. É a mesma janela do carro: sete
 * tiles cobrem o horizonte de freio de um corpo em cruzeiro (`~2,9`) e ainda deixam o poste ser
 * visto antes de a boca do cruzamento estar encostada no para-choque. Olhar mais longe seria o
 * ônibus freando para a luz de dois cruzamentos adiante, que ele só alcança depois de o verde
 * ter mudado três vezes.
 */
const OLHADA_DO_SINAL = 7;

/**
 * Rua que um ônibus dá de folga a um corpo mole antes de encostar nele. No eixo da via a lataria
 * não é a régua: um ônibus a quinze centímetros de um pedestre é um ônibus *em cima* do pedestre,
 * e quem para um veículo pesado é o freio, não o toque. No eixo lateral a folga não entra — com
 * meio tile de lado cada pessoa parada no meio-fio prenderia a linha inteira no cruzamento.
 */
const FOLGA_DE_ATROPELAMENTO = 0.5;

/**
 * Um salto grande do relógio é pausa (morte, interior, aba em segundo plano), não rua andada:
 * o atraso come no máximo um frame por chamada, senão o ônibus voltaria do nada minutos atrás
 * do horário e atravessaria o jogador que desceu dele.
 */
const PASSO_MÁXIMO = 1 / 30;

/**
 * O ritmo de quem cede o asfalto andando para trás: fração do cruzeiro com que um ônibus
 * emparedado devolve relógio a mais, depois de `PESO_DO_EMPERRA` com o pé no chão. É de propósito
 * um terço do passo de uma marcha dosada e nada disso é lataria voando: a 30 quadros por segundo
 * o corpo recua um centésimo e meio de tile por quadro, o que é menos que a folga de encosto e
 * muito menos que o palmo que o jogador chama de teleporte. O que importa é o sinal: um recuo
 * contínuo e lento abre o bolso sem corrente de emergência, sem `recede`, sem salto.
 *
 * A marcha anunciada continua zero durante a ceda — é `dose` que escreve `corpo.speed`, e um
 * corpo que anda para trás com velocidade positiva mentiria para o trânsito. A régua de
 * `marchava` vê o deslocamento negativo e o aperta em zero, então quem vem atrás lê um plantado
 * que está, de fato, abrindo rua para ele.
 */
const CEDENDO_A_VEZ = 0.12;

/**
 * Quanto tempo um ônibus pode ficar com o pé no chão sem nada em cima da lataria dele antes de
 * a malha concluir que o bolso é mútuo e precisa de uma ordem. Não é reação: uma fila normal no
 * ponto encosta e dosa em menos de um segundo, e é só o empate de dois corpos que se seguram um
 * ao outro dentro da linha do outro que chega aqui. Duas vezes e meia o `HORIZONTE_DE_FREIO` é
 * também o teto de quanto um ônibus pode dever por quadro sem que a volta do horário comece a
 * mascarar a conta.
 */
const PESO_DO_EMPERRA = 2.5;

/**
 * Folga que quem começou a cede precisa ver aberta antes de parar de ceder. Sem histerese o
 * primeiro quadro de recuo tira o vizinho da minha linha de parada, a pergunta de "ele ainda me
 * segura?" responde não, o pé sai do pedal, e o bolso volta a fechar no quadro seguinte: os dois
 * serrando entre ceder e andar é a lataria tremendo no meio do cruzamento. Um palmo de rua
 * aberta é o suficiente para o líder da fila passar por ele e o bolso se dissolver de vez.
 */
const PALMO_DE_CEDA = 0.5;

/**
 * A marcha com que um ônibus entra numa curva cujo flanco vai encostar em alguém, em fração do
 * cruzeiro: um quarto de 3,5 tiles por segundo é pouco mais de meio tile por segundo, o passo de
 * quem manobra olhando o retrovisor. Não é freio de distância, é manobra — a lataria continua
 * andando, e é andando que ela sai do vértice e deixa de olhar o próprio flanco. Plantar seria a
 * tradução literal de "o giro encosta", e o relógio não perdoa a letra: ver `apertoDaCurva`.
 */
const MARCHA_DA_CURVA = 0.25;

/**
 * A rede de transporte da cidade: a malha é derivada do mapa na construção, e o que roda
 * aqui é o horário das linhas, lido do tempo de jogo. É o portão de zonas do streaming que
 * decide o que se materializa — fora da área simulada ninguém calcula posição de nada.
 */
export class TransportSystem {
  readonly network: TransportNetwork;
  readonly units: TransportUnit[] = [];
  /**
   * Os corpos das unidades, no mesmo índice de `units`: cada unidade tem o seu, escrito no
   * lugar a cada leitura do horário, para o trânsito não criar lixo por quadro ao enxergar a
   * rua. É a mesma posição que o render desenha, lida pelo mesmo relógio.
   */
  readonly bodies: StreetBody[] = [];
  /**
   * Polilinha de cada linha amostrada a cada `PROBE_STEP` tiles, em [x, y, x, y...]. É o que
   * o portão de zonas consulta: a rota real, não a caixa dela.
   */
  private readonly probes: Float32Array[] = [];
  private readonly tiers: Uint8Array;
  /**
   * Distância acima da qual nenhum ponto amostrado pode definir a zona. Uma margem de um
   * passo de sonda cobre o trecho entre duas sondas, que é o único erro que o portão tem.
   */
  private readonly streamFloor2: number;
  private time = 0;
  private frame = 0;
  /**
   * Unidades cujo relógio a rua moveu neste frame. São as únicas que precisam reler o horário
   * antes de o quadro ser desenhado — ver `reamostra`.
   */
  private readonly escorregou: number[] = [];
  /**
   * Os ônibus já empurrados pela corrente de um único `recede`. É a lista que impede a fila de
   * dar a volta em si mesma — ver `recede`.
   */
  private readonly corrente: number[] = [];
  /**
   * A rua do quadro: os corpos que o `GameState` tem no asfalto e que nenhum horário da malha
   * dirige — carros, pedestres, bichos e o próprio jogador a pé. É `null` quando quem roda a
   * malha é um teste sem cidade: aí o ônibus só enxerga a própria linha, exatamente como antes
   * de existir trânsito na conta.
   */
  private rua: RuaVisivel | null = null;
  /**
   * Os semáforos da cidade. É ligado por quem tem os dois sistemas na mão (`GameState`), e fica
   * `null` no teste que roda só a malha: aí o ônibus continua não obedecendo luz nenhuma, que é
   * exatamente o que o teste quer medir — o horário, sem a cidade por cima.
   */
  signals: TrafficSignalSystem | null = null;
  /**
   * A boca do cruzamento à frente, emprestada como corpo: um muro de meia-lataria zero plantado
   * na borda da caixa, para o vermelho ser a mesma conta de freio que um carro parado na faixa.
   * Sem isto a luz teria régua própria — e régua própria é como uma regra vira uma segunda
   * verdade sobre onde o ônibus pode estar.
   */
  private readonly muro: StreetBody = {
    x: 0, y: 0, dir: 'SE', angle: 0, speed: 0, radius: 0, meio: 0, flanco: 0, live: true,
  };
  /**
   * A lataria do quadro que vem, emprestada como corpo: a minha caixa no ponto e no rumo em que
   * o horário vai escrevê-la se ninguém pisar no freio. É o que fecha o buraco de um quadro entre
   * o cone, que olha o asfalto de agora, e o abraço, que conserta o de ontem.
   */
  private readonly esquina: StreetBody = {
    x: 0, y: 0, dir: 'SE', angle: 0, speed: 0, radius: 0, meio: 0, flanco: 0, live: true,
  };
  private readonly contaDoSinal = { aperto: 0, colado: false };
  /**
   * O corpo visitado, na forma que a olhada para a frente já sabe medir. É um só, reescrito a
   * cada visita: a rua empresta o objeto e a conta tem de ser feita ali, dentro da visita, que é
   * o mesmo contrato do buffer emprestado da `SpatialIndex`.
   */
  private readonly risco: StreetBody = {
    x: 0, y: 0, dir: 'SE', angle: 0, speed: 0, radius: 0, meio: 0, flanco: 0, live: true,
  };
  /**
   * O corpo de um ônibus numa tentativa de recuo, para `descolaDaRua` medir a lataria sem criar
   * objeto a cada palmo procurado.
   */
  private readonly sonda: StreetBody = {
    x: 0, y: 0, dir: 'SE', angle: 0, speed: 0, radius: RAIO_DO_ONIBUS,
    meio: RAIO_DO_ONIBUS, flanco: MEIA_LARGURA, live: true,
  };
  /**
   * De qual ônibus é a olhada para a rua em curso, e qual é a marcha de cruzeiro da linha dele:
   * a visita é chamada pelo `GameState` e não tem como receber esses dois por parâmetro sem
   * criar função nova a cada quadro.
   */
  private olhado = -1;
  private cruzeiroOlhado = 0;
  /** O resultado da olhada para a rua. É emprestado de um só e lido logo depois da chamada. */
  private readonly contaRua = { aperto: 0, deficit: 0, colado: false };
  /**
   * Fração da marcha com que cada corpo andou no último frame em que foi lido: 1 para quem
   * correu a ciclo, 0 para quem ficou parado ou foi segurado, e o meio para quem dosou o freio.
   * É a única maneira de um ônibus saber se está *fechando* sobre o da frente ou só andando
   * atrás dele: a geometria da faixa vê os dois casos igual, e frear quando o buraco não fecha
   * come tempo do horário sem ganhar rua nenhuma — a fila inteira sangrando atraso até o teto.
   */
  private readonly marchava: Float32Array;
  /**
   * Onde cada corpo terminou o último quadro, em [x, y, x, y...]: a régua de quanto rua ele de
   * fato andou. O relógio não serve como velocímetro — dentro da janela de espera de um ponto o
   * ônibus some do asfalto sem comer atraso nenhum.
   */
  private readonly andava: Float64Array;
  /**
   * Tiles que cada corpo foi empurrado para trás por recuo de emergência neste quadro. Não é
   * velocidade: um `recede` teletransporta lataria, e sem devolver esse pulo a régua de
   * acima leria um ônibus recém-recuado como "parado" e a fila atrás dele frearia para um
   * carro que está a caminho.
   */
  private readonly pulo: Float32Array;
  /**
   * A marcha com que este corpo anda quando a rua manda dosar o pé, em fração do cruzeiro do
   * serviço: 1 é horário puro, 0 é lataria parada, 0,4 é o ônibus que freia *em progresso*
   * atrás de outro ônibus. É ela, e não o `held`, que escreve `corpo.speed`, porque a marcha
   * anunciada é o que o trânsito lê e o que o vizinho em movimento projeta no meu eixo. Ela não
   * entra mais na rampa de quem freia: medir `alcanço` com a marcha anunciada é o pedal desligando
   * a própria rampa no quadro em que está no fundo, e o preço era a fila do ponto serrando entre
   * marcha cheia e recuo de emergência — ver a doca de `freio`. O `corte` de travessia continua
   * lendo a anunciada, porque ali a pergunta é de tempo até o encontro, e corpo plantado não tem
   * rua nenhuma a percorrer.
   */
  private readonly dose: Float32Array;
  /**
   * Este corpo teve o lugar escrito neste quadro? A régua de marcha só pode medir quem andou de
   * verdade, e a zona distante congela lataria no asfalto do último cálculo sem dever tempo a
   * ninguém: lida como parada, ela frearia fila em volta de um ônibus que está correndo.
   */
  private readonly lida: Uint8Array;
  /**
   * O mesmo sinal para o quadro que acabou de nascer: ele não tem asfalto anterior contra o qual
   * se medir, e a única marcha honesta de quem aparece do nada é a do próprio horário.
   */
  private readonly nascida: Uint8Array;
  /**
   * Segundos seguidos que este corpo passou com o pedal no chão, acumulados no mesmo ritmo do
   * relógio da rua. É o cronômetro do bolso: um plantado de quadro único é uma fila normal, e um
   * plantado de dois segundos e meio é dois ônibus que se seguram dentro da linha um do outro sem
   * que ninguém tenha asfalto para ceder. Só aí entra a ceda de `CEDENDO_A_VEZ`.
   */
  private readonly piso: Float32Array;
  /**
   * Lataria que este corpo já deu para trás na ceda atual, em tiles: zero é ninguém cedendo. É
   * uma régua de distância e não um sinal liga-desliga porque o gesto precisa de um fim — um
   * ônibus que começou a recuar porque o vizinho tinha mais atraso que ele continua recuando até
   * abrir `PALMO_DE_CEDA` de rua ou até o vizinho sair da sua linha, e para aí. Sem teto, a ceda
   * viraria o recuo contínuo de uma fila inteira, que é o contrário do que ela compra.
   */
  private readonly cedendo: Float32Array;
  /**
   * O vizinho plantado que dá o aperto deste quadro, ou -1: a aresta do "quem espera quem". Ela é
   * o que permite à malha enxergar a diferença entre uma fila e um bolso — na fila a corrente sobe
   * até uma lataria parada no embarque e para ali; no bolso ela volta ao ponto de partida, e não
   * existe ordem nenhuma que a rua respeite enquanto os dois juram que o outro é o último.
   */
  private readonly quemMeSegura: Int32Array;
  /**
   * As flags de onde veio o aperto do quadro (ver a conta em `cuidaDaFrente`). Não é estado do
   * trânsito: é a etiqueta que o observatório lê para não confundir uma fila no vermelho com um
   * bolso de dois ônibus, e é zerada em quem o quadro não olhou.
   */
  private readonly origem: Uint8Array;

  constructor(graph: RoadGraph, seed: number) {
    this.network = buildTransportNetwork(graph, seed);
    this.tiers = new Uint8Array(this.network.routes.length);
    const frota = this.network.routes.reduce((n, r) => n + r.units, 0);
    this.marchava = new Float32Array(frota);
    this.andava = new Float64Array(frota * 2);
    this.pulo = new Float32Array(frota);
    this.dose = new Float32Array(frota).fill(1);
    this.lida = new Uint8Array(frota);
    this.nascida = new Uint8Array(frota);
    this.piso = new Float32Array(frota);
    this.cedendo = new Float32Array(frota);
    this.quemMeSegura = new Int32Array(frota).fill(-1);
    this.origem = new Uint8Array(frota);
    this.streamFloor2 = (GAME_CONFIG.STREAMING_RADIUS_TILES + PROBE_STEP) ** 2;
    for (const route of this.network.routes) {
      const sonda: number[] = [];
      // As duas faixas: uma linha que corre de um lado da via e volta do outro pode ter o
      // portão alcançando uma e não a outra, e o ônibus parado do lado errado da câmera é o
      // mesmo que não existir para quem está na calçada.
      for (const meia of [route.points, route.back]) {
        for (let i = 0; i < meia.length; i += PROBE_STEP) {
          sonda.push(meia[i].x, meia[i].y);
        }
        const ultimo = meia[meia.length - 1];
        if (sonda[sonda.length - 2] !== ultimo.x || sonda[sonda.length - 1] !== ultimo.y) {
          sonda.push(ultimo.x, ultimo.y);
        }
      }
      this.probes[route.id] = Float32Array.from(sonda);
      for (let unit = 0; unit < route.units; unit++) {
        const p = sampleRoute(route, this.network.services[route.service], 0, unit);
        this.units.push({
          route: route.id, unit, x: p.x, y: p.y, angle: p.angle,
          dir: angleToWorldDirStable(p.angle, 'SE'), stopped: p.stopped, stop: p.stop,
          pass: p.pass, phase: p.phase, parked: p.parked,
          live: false, atraso: 0, held: false, plantado: false, embarque: 0,
        });
        // O corpo nasce dizendo a mesma verdade que o horário diz naquele instante: um
        // `speed: 0` escrito na construção seria um ônibus estacionado para o trânsito até o
        // primeiro tick da câmera chegar até ele.
        this.bodies.push({
          x: p.x, y: p.y, angle: p.angle, dir: angleToWorldDirStable(p.angle, 'SE'),
          speed: p.stopped ? 0 : this.network.services[route.service].speed,
          radius: RAIO_DO_ONIBUS, meio: RAIO_DO_ONIBUS, flanco: MEIA_LARGURA, live: false,
        });
      }
    }
  }

  /** Relógio da malha: é o espelho do relógio do jogo, nunca um tempo acumulado à parte. */
  get clock(): number {
    return this.time;
  }

  /**
   * Espelha o relógio do jogo e materializa o que a câmera alcança. Não é `dt`: a posição de
   * um veículo é função pura do tempo, então acumular um tempo próprio faria a cidade atrasar
   * toda vez que o tick dela é pulado — morrendo o jogador ou entrando numa sala — e o
   * horário passaria a depender de quantos frames alguém deixou de rodar. `x`/`y` são a
   * âncora da câmera, o mesmo ponto que define as zonas: sem `streaming` (teste, mapa
   * pequeno) toda a cidade é materializada. `espera` é o pedestre do jogo, a pé e fora de uma
   * sala — é ele que segura um ônibus no ponto; sem ele a malha é só horário. `rua` é o que o
   * `GameState` tem no asfalto e a malha não dirige: carros, pedestres, bichos. Sem ela o ônibus
   * só enxerga os próprios horários, que é o estado em que a malha foi escrita antes de existir
   * trânsito na conta.
   */
  update(
    time: number, x: number, y: number,
    streaming?: WorldStreamingManager, espera?: Player, rua?: RuaVisivel,
  ): void {
    if (!Number.isFinite(time)) return;
    const dt = Math.max(0, Math.min(PASSO_MÁXIMO, time - this.time));
    this.time = time;
    this.frame++;
    this.rua = rua ?? null;

    // A zona é lida da linha, não do veículo: as unidades de um mesmo horário moram no mesmo
    // asfalto, e uma consulta por linha basta para saber quais horários calcular. O recorte
    // de quem existe na tela vem depois, do chunk onde cada carro está.
    if (streaming) this.readTiers(x, y, streaming);
    for (let i = 0; i < this.units.length; i++) {
      const u = this.units[i];
      const corpo = this.bodies[i];
      this.lida[i] = 0;
      const tier = streaming ? this.tiers[u.route] : TIER.VISIBLE;
      if (tier === TIER.OUTSIDE) {
        u.live = false;
        corpo.live = false;
        continue;
      }
      // No anel distante a linha continua no horário, só que materializada um a cada
      // `VEHICLE_SIM_TICK_DIVISOR` frames — o mesmo descompasso do trânsito, com o `+ unit`
      // para não cair tudo no mesmo frame. O corpo fica onde o último cálculo o pôs, igual à
      // unidade: o carro que freia diante dele não vê um fantasma nem um buraco. Congelado
      // não é atrasado: o `atraso` da unidade não cresce nem decai enquanto ela não é lida,
      // senão a rua que o jogador nunca viu teria comido tempo de uma fila inexistente.
      if (tier === TIER.DISTANT
        && (this.frame + u.route * 3 + u.unit) % GAME_CONFIG.VEHICLE_SIM_TICK_DIVISOR !== 0) continue;
      const route = this.network.routes[u.route];
      const service = this.network.services[route.service];
      // A dívida do quadro anterior é lida antes da conta: segurar um segundo de fila é dever um
      // segundo de horário, e o `atraso` já foi cobrado — mas o `time` também andou, então a
      // amostra ingênua de `time - atraso` escreve a lataria um `dt` ADIANTE do corpo que a
      // reamostra vai devolver ao asfalto no fim do mesmo quadro. Medida no fim do quadro
      // anterior, a marcha realizada diz exatamente quanto falta: quem andou tudo não deve nada,
      // quem ficou plantado deve um passo inteiro. Cobrar adiantado é o que fazia o ônibus
      // segurado ser visto um passo adiante de onde ele é desenhado, e num ônibus plantado no
      // vértice de uma curva um passo troca o ângulo da caixa — o corpo de 1,25 tile gira noventa
      // graus e atravessa a faixa do vizinho, que olhou para uma lataria que não está mais lá.
      const deve = dt * (1 - this.marchava[i]);
      const s = sampleRoute(route, service, this.time - u.atraso - deve, u.unit);
      u.x = s.x;
      u.y = s.y;
      u.angle = s.angle;
      u.stopped = s.stopped;
      u.parked = s.parked;
      u.stop = s.stop;
      u.pass = s.pass;
      u.phase = s.phase;
      u.dir = angleToWorldDirStable(s.angle, u.dir);
      // A zona da linha decide o que é calculado; a zona do asfalto onde o carro está decide
      // o que existe na tela e no som. Uma linha que atravessa o mapa tem unidade dos dois
      // lados da câmera, e o render não pode repetir esse recorte por conta própria.
      const viva = !streaming || streaming.tierOf(u.x, u.y) >= TIER.ACTIVE;
      const nasce = !u.live && viva;
      u.live = viva;
      u.held = false;
      // A dosagem é história, não posição: um ônibus que volta para a cena pelo portão não tem
      // asfalto anterior, e a única marcha honesta de quem aparece do nada é a do horário cheio.
      if (nasce) {
        this.dose[i] = 1;
        u.plantado = false;
        this.piso[i] = 0;
        this.cedendo[i] = 0;
      }
      this.lida[i] = 1;
      this.nascida[i] = nasce ? 1 : 0;
      corpo.x = u.x;
      corpo.y = u.y;
      corpo.angle = u.angle;
      corpo.dir = u.dir;
      corpo.speed = u.stopped ? 0 : service.speed * this.dose[i];
      corpo.live = u.live;
      // O ônibus que acabou de entrar em cena não tem história: ele aparece onde a conta manda,
      // e a conta não sabe que já existe lataria naquele pixel. É aqui, e só aqui, que se
      // empurra corpo para a rua — com o veículo já vivo, quem cuida do encontro é o relógio.
      if (nasce) this.descolaDaRua(i, corpo);
    }
    // A doca antes da olhada para a frente: é a lataria parada de agora que quem vem atrás
    // precisa enxergar, e um ônibus enfileirado no berço é exatamente isso.
    this.encaixaNaDoca();
    // A espera do ponto depois da doca e antes do freio da rua. Depois da doca porque é o berço
    // de agora que segura o passageiro; antes do freio porque este laço pula os veículos parados
    // — um ônibus na calçada não disputa asfalto com ninguém, e a marcha que ele perde é só do
    // pedestre. O atraso é o mesmo mecanismo do carro parado à frente: um segundo de relógio por
    // segundo de rua, e o corpo fica plantado onde a porta está aberta.
    this.seguraNoPonto(dt, espera);
    // Olhar para a frente depois que a rua inteira do frame foi escrita: é a posição de AGORA
    // de cada corpo que um ônibus precisa enxergar, e não a do frame passado — com o horário
    // rodando a 60 quadros por segundo, um carro lido com um frame de atraso é meio tile de
    // asfalto, que é justamente a folga que separa "freou antes" de "atravessou".
    if (dt > 0) this.cuidaDaFrente(dt);
    // O relógio que a rua acabou de mover precisa ser lido no mesmo quadro: atrás do
    // `cuidaDaFrente` o corpo ainda está onde o horário o pôs, e um frame de lataria em cima
    // de lataria é exatamente o que o jogador chama de "um ônibus atravessando o outro".
    this.reamostra();
    // A régua da próxima olhada: onde cada corpo realmente ficou, depois da doca, do freio e
    // da reamostra — porque recuar no relógio é andar para trás no asfalto, e um ônibus que
    // recuou não está fechando sobre ninguém.
    //
    // A marcha se mede AQUI e não no topo do quadro, quando o corpo sai do relógio: no topo, a
    // lataria de um ônibus segurado está sempre um `dt` inteiro adiante de onde o atraso novo o
    // pôs no quadro anterior, porque o relógio ainda não foi corrigido. Lida ali, toda unidade
    // em marcha daria exatamente 1,00 — inclusive a que passou o quadro inteiro plantada — e o
    // `fecho` que separa fila de paredão seria sempre zero entre dois ônibus em movimento:
    // ninguém frearia para ninguém, e os dois só se separariam depois que a lataria encostasse,
    // no recuo de emergência. Medida no fim, a régua vê o deslocamento que o jogador vê.
    for (let i = 0; i < this.bodies.length; i++) {
      const corpo = this.bodies[i];
      const pulo = this.pulo[i];
      this.pulo[i] = 0;
      if (this.lida[i]) {
        const rota = this.network.routes[this.units[i].route];
        const marcha = this.network.services[rota.service].speed * dt;
        const andado = this.nascida[i] ? marcha
          : (corpo.x - this.andava[i * 2]) * Math.cos(corpo.angle)
          + (corpo.y - this.andava[i * 2 + 1]) * Math.sin(corpo.angle) + pulo;
        this.marchava[i] = marcha > 0 ? Math.max(0, Math.min(1, andado / marcha)) : 1;
      }
      this.andava[i * 2] = corpo.x;
      this.andava[i * 2 + 1] = corpo.y;
    }
  }

  /**
   * Relê o horário de quem acabou de escorregar para trás e escreve o corpo no lugar novo.
   * Depois vem a doca de novo: um ônibus que recuou pode ter caído na janela de espera de um
   * berço que já tem lataria nele, e fila no passeio é o `encaixaNaDoca` quem resolve.
   */
  private reamostra(): void {
    if (this.escorregou.length === 0) return;
    for (const i of this.escorregou) {
      if (!this.units[i].live) continue;
      this.recolocaNoRelógio(i);
    }
    this.escorregou.length = 0;
    this.encaixaNaDoca();
    this.separaLataria();
  }

  /**
   * A última palavra sobre o asfalto do quadro: depois da reamostra ninguém mais move corpo, e
   * o que está aqui é exatamente o que o jogador vê. A olhada para a frente decidiu sobre a
   * lataria *prevista* do quadro — um passo de marcha, no pior caso, atrás da que a reamostra
   * acabou de escrever — e meio passo de diferença é menos que a folga de encosto, mas é lataria
   * dentro de lataria no papel. Recuar de novo é barato e raro: só acontece quando o corpo se
   * adiantou ao próprio previsão, e o `abraço` não conhece encontro imaginado — ele só pergunta
   * aos quatro eixos dos dois retângulos se aquilo já é um monte.
   */
  private separaLataria(): void {
    for (let i = 0; i < this.bodies.length; i++) {
      const corpo = this.bodies[i];
      if (!corpo.live) continue;
      const falta = this.abraço(i, corpo);
      if (falta <= 0) continue;
      this.corrente.length = 0;
      this.recede(i, falta, this.corrente);
    }
  }

  /**
   * O corpo volta a ser o que a conta dele diz: é a mesma escrita do quadro normal, só que
   * feita no meio do quadro, depois de o relógio da unidade mudar. Corpos que se movem por
   * fora do relógio são o que fazia o ônibus recém-chegado saltar de volta para cima do outro
   * no mesmo quadro — ver `descolaDaRua`.
   */
  private recolocaNoRelógio(i: number): void {
    const u = this.units[i];
    const corpo = this.bodies[i];
    const route = this.network.routes[u.route];
    const service = this.network.services[route.service];
    const s = sampleRoute(route, service, this.time - u.atraso, u.unit);
    u.x = s.x;
    u.y = s.y;
    u.angle = s.angle;
    u.stopped = s.stopped;
    u.parked = s.parked;
    u.stop = s.stop;
    u.pass = s.pass;
    u.phase = s.phase;
    u.dir = angleToWorldDirStable(s.angle, u.dir);
    corpo.x = u.x;
    corpo.y = u.y;
    corpo.angle = u.angle;
    corpo.dir = u.dir;
    corpo.speed = u.held || u.stopped ? 0 : service.speed * this.dose[i];
  }

  /**
   * A única regra que o horário não sabe escrever sozinho: dois corpos não podem ocupar o mesmo
   * pixel. Cada ônibus vivo enxerga o corpo mais perto dentro da sua faixa e, se há alguém ali,
   * anda um passo para trás no relógio proporcionalmente ao aperto — colado, para por completo;
   * ainda longe, só segura a aceleração. A faixa abrindo, ele recupera metade do atraso por
   * segundo, o suficiente para o painel de partidas não virar ficção.
   *
   * A olhada tem dois baldes, e a diferença entre eles é de *quem cede*. O primeiro é a própria
   * malha: outro ônibus, com fila atrás, relógio e índice, disputando asfalto na mesma régua. O
   * segundo é a rua que o `GameState` dirige — carro, pedestre, bicho, o jogador a pé —, e ali o
   * ônibus não tem nada a ganhar fazendo valer prioridade: quem atravessa a faixa a pé não tem
   * horário nenhum a perder, e um carro parado na minha frente é uma parede que eu contorno
   * esperando. Por isso corpo mole nunca é empurrado por recuo, e corpo fundo entra na corrente
   * igual a um vizinho de frota.
   *
   * Na calçada a regra não se aplica: o ônibus parado já está parado *no ponto do embarque*, e
   * segurar o relógio ali não move lataria nenhuma — só cola um ônibus no outro para sempre,
   * que é exatamente o monte que apareceu na tela. Quem está na doca anda no próprio tempo e é
   * o que chega atrás dele que freia; a fila do ponto se desfaz sozinha.
   *
   * O terceiro balde é a cidade parada: não lataria na minha frente, mas a luz que não me deixa
   * entrar no cruzamento. Ele entra na mesma régua porque é o mesmo gesto — pé no pedal, atraso
   * no relógio, marcha devolvida quando abre — e a mesma função, porque um ônibus que passa no
   * vermelho empurra o carro que espera, e o carro empurrado é a fila que a própria malha lê.
   */
  private cuidaDaFrente(dt: number): void {
    for (let i = 0; i < this.units.length; i++) {
      const u = this.units[i];
      const corpo = this.bodies[i];
      if (!corpo.live || u.stopped) {
        // Parar no ponto apaga a memória do bolso: a planta de um embarque é o horário quem manda,
        // não um vizinho plantado dentro da minha linha, e o cronômetro de `PESO_DO_EMPERRA` só
        // conta o tempo que a rua está prendendo alguém.
        this.piso[i] = 0;
        this.cedendo[i] = 0;
        this.origem[i] = 0;
        continue;
      }
      // A decisão de marcha é por quadro, não acumulada: quem não tem aperto nenhum anda o
      // cruzeiro inteiro, e um dose que sobrou do quadro anterior seria um ônibus freando para
      // um carro que já virou a esquina.
      this.dose[i] = 1;
      const cruzeiro = this.cruzeiroDo(i);
      const naFrente = this.apertoÀFrente(i, corpo);
      const abraço = this.abraço(i, corpo);
      const rua = this.apertoDaRua(i, corpo);
      const sinal = this.apertoDoSinal(i, corpo);
      const daFrota = naFrente.aperto > 0 ? naFrente.aperto : this.apertoDeTravessia(i, corpo);
      const esquina = this.apertoDaCurva(i, corpo, dt);
      const aperto = Math.max(daFrota, rua.aperto, sinal.aperto, esquina);
      // De onde veio o aperto deste quadro, em flags: 1 é a própria malha no cone, 2 é a
      // travessia prevista, 4 é a rua do `GameState`, 8 é a luz, 16 é a curva e 32 é lataria já
      // em cima de lataria. É o que o observatório (`tools/tmp/prova-livelock.cjs`) precisa para
      // não chamar de bolso uma fila parada no vermelho: a corrente de quem-espera-quem só existe
      // dentro do bit 1, e um corpo plantado por um sinal ou por um pedestre não tem vizinho a
      // quem ceder rua — recuar ali seria perder a frente do semáforo por nada.
      this.origem[i] = (naFrente.aperto > 0 ? 1 : 0)
        | (naFrente.aperto <= 0 && daFrota > 0 ? 2 : 0)
        | (rua.aperto > 0 ? 4 : 0)
        | (sinal.aperto > 0 ? 8 : 0)
        | (esquina > 0 ? 16 : 0)
        | (abraço > 0 || naFrente.deficit > 0 || rua.deficit > 0 ? 32 : 0);
      // O `deficit` entra no portão ao lado do aperto e do abraço: lataria dentro de lataria é
      // rua que já acabou, e a régua de marcha não tem mais nada a dizer — dois corpos colados
      // correndo a mesma marcha estão, pelos números, "andando junto", e sem esta porta eles
      // continuariam correndo em cima um do outro para sempre. O aperto decide quem freia antes
      // do encontro; o deficit paga o encontro que já aconteceu.
      if (aperto > 0 || abraço > 0 || naFrente.deficit > 0 || rua.deficit > 0) {
        const antes = u.atraso;
        const falta = Math.max(naFrente.deficit, abraço, rua.deficit);
        // Recuar é o gesto de quem já está em cima, e ele tem corrente, não teto — ver `recede`.
        // Esperar, o degrau de antes, é o ramo da marcha dosada adiante.
        if (falta > 0) {
          this.corrente.length = 0;
          this.recede(i, falta, this.corrente);
        } else {
          // Freiar é dosar a marcha, e o que dosar é decidido pela distância que falta até a
          // linha de parada, não por *quem* está na frente do pé. Corpo mole da rua — pedestre,
          // bicho, lataria parada — tem a folga de atropelamento dentro do `linha`, então aperto
          // cheio diante de quem atravessa a faixa é a lataria plantada *antes* da folga, e o
          // resto de marcha abaixo dele é só o caminho até essa marca.
          // Dosar é também o que a rua cobra, e foi não dosar que a malha congelou: "aperto da
          // rua existe ⇒ pedal no chão" planta o corpo no limite exterior da rampa, um
          // `HORIZONTE_DE_FREIO` *depois* da própria linha de parada. Um carro esperando o verde na
          // faixa passa então a ter um ônibus colado a dois tiles e meio dele para sempre, um
          // segundo de dívida por segundo de relógio, atraso subindo até o teto da volta e a fila
          // inteira atrás pagando o mesmo — a lataria emperrada no meio do asfalto sem nada em
          // cima dela, que é o que a tela mostrou.
          //
          // O pé no chão é a rua acabada, não a rampa apertada: `aperto` teto é lataria dentro da
          // própria linha de parada, e é só ali que não existe mais marcha a dosar. Dosar o resto
          // é o que desfaz a parede da fila — medido em `tools/tmp/prova-livelock.cjs`, com o
          // pedal descendo aos nove décimos da rampa uma corrente de ônibus a um corpo e três
          // quartos de distância uns dos outros planta inteira, cada um devolvendo um segundo de
          // atraso por segundo de relógio sem que ninguém chegue à parada prometida: 565 s
          // seguidos segurados, 91 unidades acima de dez segundos de planta, e o ciclo inteiro do
          // horário passando sem a passada acontecer. Dosando, a fila anda no ritmo do líder dela,
          // e o aperto de cada um é a equação que equilibra marcha com rua que falta — `dose` de
          // `1 - aperto` e dívida de `aperto` por segundo são as duas metades dessa conta, e é
          // exatamente o espelho do corpo que o check lê. Abaixo de um décimo de marcha a lataria
          // anda um centésimo de tile por quadro: é a cauda de Zenão da rampa, e ela é assintótica
          // *para a linha de parada*, que fica um passo de marcha depois da folga de encosto — o
          // encosto não vem. Recuar entra quando a lataria já está em cima, e recuar tem corrente,
          // não teto — ver `recede`.
          const noChao = aperto >= 1;
          u.plantado = noChao;
          // O cronômetro do bolso não é o pé no chão, é a lataria parada: a rampa dosada que anda
          // dois centésimos de tile por segundo é um ônibus parado aos olhos de quem espera a
          // passada, e é ela que emperra a malha inteira sem nunca marcar `aperto` teto. Contar
          // só `noChao` seria cobrar do recuo uma emergência que chega sempre tarde demais.
          if (noChao || 1 - aperto <= MESMO_MILIMETRE) this.piso[i] += dt;
          else this.piso[i] = 0;
          // O bolso que a disputa de `falta` não destruiu é o que entra aqui, e ele tem de ser
          // ciclo, não fila: `cedePara` é o vizinho plantado que me segura dentro da minha linha
          // e tem mais atraso que eu, e `emBolso` percorre a corrente de quem-segue-quem para ver
          // se ela volta em mim. Fila atrás de lataria parada não é bolso — é fila, e o ônibus
          // que recua nela perde a vaga do embarque para ninguém.
          const ceda = naFrente.cedePara >= 0 && this.piso[i] > PESO_DO_EMPERRA
            && this.emBolso(naFrente.cedePara, i);
          if (ceda) this.cedendo[i] += cruzeiro * dt * CEDENDO_A_VEZ;
          else if (this.cedendo[i] > 0 && !(naFrente.emperra && this.cedendo[i] < PALMO_DE_CEDA)) {
            this.cedendo[i] = 0;
          }
          const dáRua = this.cedendo[i] > 0;
          // Ceder custa o aperto *mais* um dedo de relógio: o corpo plantado fica onde está, e o
          // corpo que cede anda um `CEDENDO_A_VEZ` de cruzeiro para trás no mesmo quadro. Não é
          // recuo de emergência — não tem corrente, não tem `recede`, não tem lataria saltando um
          // corpo e meio por cima do cruzamento. É o ônibus encostando a traseira na própria
          // calçada para o outro passar, e a única coisa que a malha ainda não sabia fazer.
          u.atraso = antes + dt * (dáRua ? Math.max(1, aperto) + CEDENDO_A_VEZ : aperto);
          // O desconto que não move lataria nenhuma: o horário é periódico pela volta, então
          // tirar um `cycle` inteiro do atraso escreve o corpo no mesmo pixel de antes, com o
          // mesmo ângulo e a mesma paradinha. O corte antigo era por baixo e silencioso —
          // `min(teto, dívida)` devolvia marcha a um ônibus parado, e era aí que a lataria
          // passava por cima do carro da frente e o corpo saltava para um ponto do mapa que
          // ninguém viu, o "some do nada" do jogador. Aqui a dívida só encolhe por volta, e
          // quem está parado continua parado pelo tempo que a rua levar para abrir.
          const ciclo = this.network.routes[u.route].cycle;
          if (u.atraso >= ciclo) u.atraso -= ciclo;
          if (noChao || dáRua) u.held = true;
          this.dose[i] = dáRua ? 0 : 1 - aperto;
          if (u.atraso !== antes) this.escorregou.push(i);
        }
      } else {
        // Rua aberta de verdade: o pé sai do pedal, e é aqui — não na marca de um décimo — que a
        // memória do freio termina. Sem isto, um ônibus que passou a volta inteira dosando antes
        // de um cruzamento levaria o plantado para o asfalto livre seguinte e pararia no primeiro
        // palmo de aperto que ele visse.
        u.plantado = false;
        this.piso[i] = 0;
        this.cedendo[i] = 0;
        if (u.atraso > 0 && !naFrente.colado && !rua.colado && !sinal.colado) {
          // Recuperar atraso é andar para a frente no asfalto mais rápido que a marcha, e é por
          // isso que a fila à frente tem de ser olhada antes: com lataria dentro da própria linha
          // de parada o ônibus segura o relógio onde está, e a recuperação só volta quando a rua
          // abriu de verdade. Sem isso o atraso recuperado fecharia de novo o buraco que o `recede`
          // acabou de abrir, e os dois ficariam serrando no encosto — o toque que dura quadro a
          // quadro e nenhum dos dois destrava.
          u.atraso = Math.max(0, u.atraso - dt * ATRASO_RECUPERA);
        }
      }
      // A marcha decidida é a marcha anunciada no MESMO quadro. Deixar o corpo escrito com a
      // decisão anterior é o ônibus que voltou a ter rua livre e ainda anuncia meia marcha — ou
      // o contrário, parado com o asfalto aberto à frente, e quem vem atrás freia para uma
      // lataria que já andou. O espelho da rua (`check-transport`) cobra exatamente isto.
      corpo.speed = cruzeiro * this.dose[i];
    }
  }

  /**
   * A marcha com que o corpo deste ônibus anda no quadro, em fração do cruzeiro do serviço: 1 é
   * horário puro, 0 é lataria plantada, e o meio é o freio dosado entre dois ônibus. O espelho
   * da rua lê isto antes de acusar `corpo.speed` de mentiroso: com a dosagem, velocidade do
   * corpo e estado do relógio são duas metades da mesma conta, e uma régua que só conhece o
   * tudo-ou-nada chama de "ônibus parado andando" o comboio que freia em progresso.
   */
  marchaAnunciada(i: number): number {
    return this.dose[i];
  }

  /**
   * A marcha de cruzeiro da linha deste ônibus, em tiles por segundo: o que o corpo dele *pode*
   * percorrer quando a rua deixa. É a régua com que o freio mede o quanto ele alcança o vizinho —
   * ver a doca de `freio` —, porque a marcha anunciada é a saída do pedal, não a entrada.
   */
  private cruzeiroDo(i: number): number {
    const rota = this.network.routes[this.units[i].route];
    return this.network.services[rota.service].speed;
  }

  /**
   * A olhada para a rua: o que o `GameState` tem no asfalto e nenhum horário da malha dirige.
   * É a mesma régua do cone e da travessia, com o corpo visitado escrito no `risco` — um só,
   * reempurrado a cada visita, porque a grade de vizinhança empresta o buffer e o objeto que ela
   * devolve vale só durante a chamada.
   *
   * O resultado é emprestado do `contaRua` e lido imediatamente por `cuidaDaFrente`, no mesmo
   * frame: um array de aperto por ônibus seria lixo por quadro no meio do tick, que é justamente
   * o que o contrato de alocação da cidade não deixa fazer.
   */
  private apertoDaRua(i: number, corpo: StreetBody): { aperto: number; deficit: number; colado: boolean } {
    const conta = this.contaRua;
    conta.aperto = 0;
    conta.deficit = 0;
    conta.colado = false;
    const rua = this.rua;
    if (!rua) return conta;
    this.olhado = i;
    this.cruzeiroOlhado = this.cruzeiroDo(i);
    rua.pertoDe(corpo.x, corpo.y, RAIO_DA_OLHADA, this.recebeRua);
    this.olhado = -1;
    return conta;
  }

  /**
   * Cada corpo que a rua devolve, medido na hora: o cone da própria faixa primeiro, e a
   * travessia depois, porque um pedestre cortando a avenida na minha frente não está na minha
   * faixa — está no mesmo ponto do asfalto em outro instante, e é de tempo que se trata.
   *
   * Corpo mole tem duas regalias que nenhum vizinho de frota tem: a marcha dele nunca entra na
   * conta do fechamento (o `fecho` seria "ele corre comigo", e quem atravessa a faixa a pé não
   * corre com ônibus nenhum), e ele jamais é empurrado para trás — recuar de um pedestre é dar ré
   * numa avenida porque alguém foi atravessar. Se as duas caixas já se tocam e o cone não viu
   * ninguém (o corpo está ao meu lado, ou colou por fora do cone), o ônibus para em cima do que
   * encosta nele: lataria sobre um corpo é a última coisa que o jogador aceita ver.
   */
  private readonly recebeRua = (c: RuaCorpo): void => {
    const i = this.olhado;
    if (i < 0) return;
    const corpo = this.bodies[i];
    const risco = this.risco;
    risco.x = c.x;
    risco.y = c.y;
    risco.angle = c.angle;
    risco.speed = c.speed;
    risco.meio = c.meio;
    risco.flanco = c.flanco;
    risco.radius = c.flanco;
    const conta = this.contaRua;
    // Contra corpo mole, ou lataria que não anda sozinha, o freio é medido com a marcha que o
    // ônibus *pode* ter, não com a que ele anunciou neste quadro. É a diferença entre uma fila e
    // um atropelamento devagar: parado diante de um pedestre, `alcanço = velocidade anunciada - 0`
    // daria zero, a rampa de distância se desligaria, o aperto sumiria por um quadro, e o quadro
    // sem pressão adianta a lataria um passo de cruzeiro inteiro — um passo a cada dois quadros é
    // o ônibus subindo sobre o corpo, que é exatamente o que a folga de atropelamento existe para
    // impedir. A mesma régua vale hoje para toda lataria de frota, e por isso a marcha possível
    // entrou como parâmetro do `freio` em vez de corpo emprestado: ver a doca de `freio`.
    const meu = this.freio(corpo, risco,
      c.mole ? 0 : Math.max(0, Math.min(1, this.marchava[i] - c.speed / this.cruzeiroOlhado)),
      this.cruzeiroOlhado,
      c.mole ? FOLGA_PARA_CHOQUE + FOLGA_DE_ATROPELAMENTO : FOLGA_PARA_CHOQUE);
    const cortando = this.corte(i, corpo, risco, -1);
    if (cortando > conta.aperto) conta.aperto = cortando;
    if (!meu) {
      // O cone não viu ninguém e as duas caixas se tocam: o corpo está ao meu lado, ou colou por
      // fora da régua de frente. O ônibus para em cima mesmo assim.
      if (seEncostamEntre(corpo, risco) && conta.aperto < 1) conta.aperto = 1;
      return;
    }
    if (meu.aperto > conta.aperto) conta.aperto = meu.aperto;
    if (c.mole) return;
    // Fundo: lataria disputando asfalto. Aqui o ônibus é um veículo como qualquer outro, e o
    // recuo de emergência com corrente vale igual — um carro parado na minha faixa, ou a lataria
    // de um ônibus que nasceu em cena em cima dele, se descola andando para trás.
    if (meu.colado) conta.colado = true;
    if (meu.deficit > conta.deficit) conta.deficit = meu.deficit;
  };

  /**
   * A outra regra que o horário não sabe escrever sozinho: um ônibus não arranca do ponto com
   * alguém esperando nele. O `dwell` da tabela é o tempo de um cobrador, não o de um pedestre
   * que viu a lataria encostar, atravessou a faixa a pé e ainda tem de acertar o botão — dois
   * segundos é o atraso entre "o ônibus está ali" e "o ônibus embora", e foi exatamente assim
   * que o embarque virou loteria.
   *
   * Esperar é escrito como atraso, do mesmo jeito que o freio de fila: um segundo de relógio por
   * segundo de rua congela a marcha efetiva da unidade, e o corpo fica plantado no berço com a
   * porta aberta. Não se move lataria, não se empurra ninguém e não se cobra nada do veículo
   * atrás — o `dwell` continuado pela conta é o mesmo, só que vivido mais devagar. O teto é
   * duplo: o do horário, para o ônibus nunca sumir do telão, e o dos `EMBARQUE_ESPERA_MÁX`
   * segundos por encosto, para um passeiante ao lado do poste não prender a linha no passeio.
   */
  private seguraNoPonto(dt: number, espera: Player | undefined): void {
    const aPé = espera && !isAboard(espera) ? espera : null;
    for (let i = 0; i < this.units.length; i++) {
      const u = this.units[i];
      // Só de quem foi lida neste frame: a unidade congelada no anel distante não tem pedestre
      // na calçada nem berço de agora, e gastar atraso dela seria comer horário de uma rua que
      // ninguém está vendo.
      if (!this.lida[i]) continue;
      // A porta do ônibus descansando no pátio está fechada: ele não deve espera a ninguém,
      // porque a partida dele é a hora que o telão mostra, não a vontade de quem passou ali.
      if (!u.stopped || u.parked) {
        u.embarque = 0;
        continue;
      }
      if (!aPé || u.embarque >= EMBARQUE_ESPERA_MÁX) continue;
      const parada = this.stopStation(u);
      const station = parada >= 0 ? this.network.stations[parada] : null;
      if (!station) continue;
      // A zona pintada manda, e fora dela vale o passo de aproximação: quem vem pela calçada na
      // direção do poste já é o passageiro que o motorista está esperando. É a mesma régua do
      // `boarding`, e tem de ser a mesma: o ônibus fica por quem embarcaria nele.
      if (!noPonto(station, aPé.x, aPé.y)) {
        // A aproximação só vale na margem de cá. O normal da via separa as duas calçadas, e o
        // produto dos dois lados diz em qual deles o pedestre e o marco moram: alguém na
        // calçada do outro lado de uma avenida não está indo a pé neste ônibus, e sem esta
        // porta ele seguraria cada veículo da linha por oito segundos, para sempre.
        const nx = -Math.sin(u.angle), ny = Math.cos(u.angle);
        const lado = (px: number, py: number) => (px - u.x) * nx + (py - u.y) * ny;
        if (Math.hypot(station.x - aPé.x, station.y - aPé.y) > EMBARQUE_APROXIMA) continue;
        if (lado(aPé.x, aPé.y) * lado(station.x, station.y) <= 0) continue;
      }
      const rota = this.network.routes[u.route];
      const teto = rota.cycle - this.network.services[rota.service].dwell;
      u.atraso = Math.min(teto, u.atraso + dt);
      u.embarque += dt;
    }
  }

  /**
   * A doca vista da rua. O horário dá a cada linha o seu berço na calçada, mas um ônibus
   * segurado pelo trânsito anda para trás no relógio e pode cair na janela de espera de um
   * ponto que já tem lataria nele — e relógio nenhum move um ônibus parado, porque esperar é
   * exatamente parar. O que sobra é o corpo: quem acha um vizinho estacionado na sua faixa
   * avança um corpo e um palmo pela calçada adiante e espera o ponto desocupar na fila, em
   * vez de em cima da linha da frente. Dois ônibus no mesmo pixel são um muro que ninguém
   * atravessa a pé; um atrás do outro, com o palmo de para-choque no meio, são dois ônibus.
   */
  private encaixaNaDoca(): void {
    for (let i = 0; i < this.units.length; i++) {
      const u = this.units[i];
      const corpo = this.bodies[i];
      if (!corpo.live || !u.stopped) continue;
      const cos = Math.cos(corpo.angle), sin = Math.sin(corpo.angle);
      const x0 = corpo.x, y0 = corpo.y;
      let coube = false;
      for (let tentativa = 0; tentativa <= FILA_DO_PONTO; tentativa++) {
        const aperta = this.apertaNaDoca(i, corpo);
        if (aperta <= 0) { coube = true; break; }
        if (tentativa === FILA_DO_PONTO) break;
        corpo.x += cos * aperta;
        corpo.y += sin * aperta;
      }
      // A fila não coube no asfalto: o ônibus volta para onde o horário o pôs. Um toque que
      // dura um quadro vale menos que um carro plantado meia quadra adiante, longe do passeio
      // onde alguém espera — e no quadro seguinte a rua abriu ou o ponto esvaziou.
      if (!coube) {
        corpo.x = x0;
        corpo.y = y0;
      }
      u.x = corpo.x;
      u.y = corpo.y;
    }
  }

  /**
   * Quanto este corpo parado precisa andar pela própria faixa para deixar de tocar o corpo
   * estacionado NA FRENTE dele. Quem está atrás não entra nesta conta, e a razão é de fila, não
   * de gosto: os dois no mesmo berço têm o mesmo ângulo e a mesma régua, então se o da frente
   * também se empurrasse por causa do de trás, a fila inteira avançaria uníssono e o toque
   * continuaria o mesmo — só que meia quadra adiante do passeio onde alguém espera. O de trás é
   * quem tem andar até o palmo do para-choque do que está na sua frente, e é ele quem anda,
   * porque o laço percorre as unidades por ordem e o corpo da frente já foi escrito. Recuar um
   * ônibus parado nunca é opção: é empurrá-lo para dentro do cruzamento que ele acabou de
   * liberar. Devolve zero quando ninguém o encosta.
   */
  private apertaNaDoca(i: number, corpo: StreetBody): number {
    const cos = Math.cos(corpo.angle), sin = Math.sin(corpo.angle);
    let falta = 0;
    for (let j = 0; j < this.bodies.length; j++) {
      if (j === i) continue;
      const outro = this.bodies[j];
      if (!outro.live || !seEncostamEntre(corpo, outro)) continue;
      const projeção = (outro.x - corpo.x) * cos + (outro.y - corpo.y) * sin;
      if (projeção < -MESMO_MILIMETRE) continue;
      const precisa = meiaCaixaEntre(corpo, outro).frente + FOLGA_PARA_CHOQUE - projeção;
      if (precisa > falta) falta = precisa;
    }
    return falta;
  }

  /**
   * Empurra um ônibus recém-chegado para dentro do primeiro buraco de asfalto que caiba nele.
   * O buraco é procurado PARA TRÁS, e a distância até ele é escrita no relógio (`atraso`), não
   * no corpo — que é a diferença entre um ônibus que chegou atrás da fila e um risco de lápis.
   * Corpo empurrado à mão dura até a próxima amostra da própria unidade, e no meio do mesmo
   * quadro um aperto de paciência já chama a `reamostra`: o recém-chegado voltava para cima do
   * horário puro, que é o lugar onde o outro já estava. No relógio o lugar é dele: nenhuma
   * reamostra apaga, e quem vem atrás freia para o corpo que o jogador vê.
   *
   * Para frente não se empurra nunca: adiante do berço teórico é a boca do cruzamento, e um
   * corpo que nasce lá dentro atropela a fila que o jogador já vê. Sem buraco atrás em doze
   * tiles de busca, o horário é a única verdade que sobra, e o toque dura o tempo de um dos
   * dois sair da frente — o `abraço` resolve no quadro seguinte, agora sem ser desfeito.
   */
  private descolaDaRua(i: number, corpo: StreetBody): void {
    const cos = Math.cos(corpo.angle), sin = Math.sin(corpo.angle);
    const x0 = corpo.x, y0 = corpo.y;
    let recuo = 0;
    let coube = false;
    // A sonda é o próprio corpo, um passo mais atrás: a lataria é a mesma e o rumo também, só o
    // lugar muda a cada tentativa.
    const sonda = this.sonda;
    sonda.angle = corpo.angle;
    sonda.meio = corpo.meio;
    sonda.flanco = corpo.flanco;
    for (let tentativa = 0; tentativa < 24; tentativa++) {
      sonda.x = x0 - cos * recuo;
      sonda.y = y0 - sin * recuo;
      let precisa = 0;
      for (let j = 0; j < this.bodies.length; j++) {
        if (j === i) continue;
        const outro = this.bodies[j];
        if (!outro.live || !seEncostamEntre(sonda, outro)) continue;
        const dx = outro.x - sonda.x, dy = outro.y - sonda.y;
        const falta = meiaCaixaEntre(sonda, outro).frente + FOLGA_PARA_CHOQUE
          - (dx * cos + dy * sin);
        if (falta > precisa) precisa = falta;
      }
      if (precisa <= 0) { coube = true; break; }
      recuo += precisa;
      if (recuo > BUSCA_DE_BURACO) break;
    }
    if (!coube || recuo === 0) return;
    this.recuaNoRelógio(i, recuo);
  }

  /**
   * O aperto que `de` deve dar por causa de `para`: quanto da marcha ele precisa devolver para
   * o relógio, indo de 0 (o outro não é problema) a 1 (a lataria já encostaria se ele andar
   * mais um passo). `falta` é a rua que ainda separa o para-choque da linha de parada, e é
   * pelo número dela que os dois se comparam quando ambos se veem. `deficit` é o mesmo número
   * do avesso: quanto falta quando a rua já acabou e as duas caixas se tocam.
   *
   * O `fecho` é o que separa uma fila de um paredão: dois corpos na mesma faixa a 1,6 tile um
   * do outro são um comboio correndo junto, e o de trás não deve tempo nenhum a ninguém — ele
   * só precisa *não fechar*. Sem essa régua o cone veria a lataria à frente e mandaria o de
   * trás devolver marcha em cada quadro para sempre; o comboio inteiro sangraria atraso até o
   * teto do ciclo, e lá em cima o relógio volta a andar, que é o ônibus passando por cima do
   * outro. Quem está parado ou mais lento é que produz o encontro, e é só contra ele que se
   * freia. O `deficit` não obedece a essa lógica: lataria em cima de lataria tem de se descolar
   * mesmo que os dois estejam parados, e é por isso que ele continua geométrico.
   *
   * `folga` é o palmo somado à lataria antes do toque. Para dois ônibus é o palmo de para-choque;
   * para um corpo mole é esse palmo mais a rua de atropelamento, porque um veículo pesado não
   * para *em cima* de quem atravessa a faixa — para antes dela. A folga entra só no eixo da via:
   * no eixo lateral ela alargaria a faixa até a calçada, e cada pessoa parada no meio-fio
   * prenderia a linha no cruzamento.
   *
   * `marchaDe` é a marcha de cruzeiro da linha de quem freia, e nunca a marcha que ele anunciou
   * no quadro. É o último grau da mesma inversão que `recebeRua` já evitava: o freio decide a
   * `dose`, a `dose` escreve `corpo.speed`, e se `corpo.speed` decide o freio, o pedal governa o
   * próprio acelerador. Medida na lataria anunciada, a fila atrás de um ônibus parado no ponto
   * serra: parado, `alcanço = 0 - 0` zera a rampa, `fecho = marchava[i] - marchava[j]` é 0-0, o
   * aperto some por um quadro, o quadro sem pressão anda o passo de cruzeiro inteiro, e quatro
   * passos depois as duas caixas se tocam — aí vem o `abraço`, que devolve um corpo e meio de
   * asfalto de uma vez. Marcha cheia, marcha zero, recuo de emergência: é o "fica indo até alguém
   * sair do que está parado e fica um tempão ali parado" da tela, e o recuo é o teleporte. Com a
   * marcha *possível*, quem está plantado diante de uma parede continua plantado, e quem cede no
   * cruzamento continua sendo decidido pela disputa de `falta`, não pelo próprio pedal.
   */
  private freio(de: StreetBody, para: StreetBody, fecho: number, marchaDe: number,
    folga = FOLGA_PARA_CHOQUE):
    { aperto: number; falta: number; colado: boolean; deficit: number } | null {
    const cos = Math.cos(de.angle), sin = Math.sin(de.angle);
    const dx = para.x - de.x, dy = para.y - de.y;
    const frente = dx * cos + dy * sin;
    const caixa = meiaCaixaEntre(de, para);
    if (Math.abs(-dx * sin + dy * cos) > caixa.lado + FOLGA_LATERAL) return null;
    if (frente < -MESMO_MILIMETRE) return null;
    const parada = caixa.frente + folga;
    // A linha de parada tem de ficar um corpo *depois* da folga de encosto: o ônibus que corre
    // a 3,5 tiles por segundo anda quase um décimo de tile entre dois quadros, e quem freia
    // exatamente na marca chega ao encosto um quadro tarde — lataria a 1,2 tile, dentro da
    // caixa, o toque raso que o check pega e nenhum recuo destrava, porque o de trás já está
    // parado e o buraco que ele abre é do tamanho de um passo. A margem é a marcha de um quadro
    // no pior `dt` aceito, e é a marcha *possível*, não a anunciada: um corpo plantado diante de
    // uma parede continua com a linha no mesmo palmo de sempre, e a disputa de `falta` no
    // cruzamento não pisca conforme o próprio pedal de quem pergunta.
    const linha = parada + marchaDe * PASSO_MÁXIMO;
    const horizonte = linha + HORIZONTE_DE_FREIO;
    if (frente > horizonte) return null;
    // A rampa de distância só vale para quem ESTÁ ALCANÇANDO o corpo da frente. Medida na malha
    // inteira (`tools/tmp/prova-fonte.cjs`), sem esta porta a frota se congela sozinha: de cada
    // lado de um cruzamento apertado o ônibus lê o vizinho a 1,6 tile — dentro da linha, portanto
    // aperto 1,00 — e os dois devolvem um segundo de marcha por segundo de relógio. Devolvendo
    // igual, a distância entre eles não muda; não mudando, o aperto nunca sai de 1,00; e a dívida
    // dos dois sobe junto até o teto da volta sem que um milímetro de lataria se abra. Aos 120 s
    // eram 191 de 213 unidades seguradas e nada andava em parte alguma do mapa: é o "eles se
    // atravessam, somem do nada" vivido pela malha inteira, e é a razão pela qual a perna da
    // viagem nunca encosta na calçada do destino. O que desfaz o empate dos dois plantados não é
    // mais o próprio pedal — é a disputa de `falta` em `apertoÀFrente`, que deixa um dos dois sem
    // aperto nenhum sobre o outro; ver a nota lá.
    //
    // O `alcanço` é a aproximação em tiles por segundo: a marcha que eu *posso* ter menos a
    // projeção da marcha que ele anuncia no meu rumo. Quem está no horário anda a 3,5 e pode
    // andar a 3,5; o parado no ponto — ou travado pela espera do passageiro — anuncia zero, e é
    // ele que some da conta. A fila legítima, aquela atrás de uma lataria parada, tem alcanço do
    // cruzeiro inteiro e freia na rampa exatamente como sempre freou. O comboio que corre junto é
    // que deixa de dever tempo a ninguém, e é por isso que a régua não precisa mais da promessa
    // antiga de que "dois ônibus da mesma linha ficam a dezoito segundos um do outro": apertados
    // por um ponto, eles ficam a um corpo, e uma regra que só funciona no horário ideal é a regra
    // que não funciona.
    //
    // O que fecha devagar — o vizinho que só está dosando o pé, e portanto continua anunciando
    // quase a marcha cheia — não é a rampa que segura: é o `fecho` da marcha realizada, que
    // enxerga a aproximação no quadro em que ela aconteceu. Os dois juntos cobrem o encontro sem
    // que um precise parar o outro por suposição.
    //
    // A aproximação é lida no MEU eixo, e por isso a marcha dele entra projetada e não subtraída:
    // o ônibus que corta a boca do cruzamento diante do que entra nele fecha rua a cruzeiro
    // inteiro, mas subtraindo as duas marchas o número diz zero. Zera a rampa, os dois entram no
    // encontro a 3,5 tiles por segundo sem um quadro de dosagem, e a única defesa que sobra é o
    // recuo de emergência do `deficit` — um corpo e meio de lataria para trás no mesmo quadro, que
    // é o teletransporte que a tela mostra. Projetada no meu rumo, a marcha dele dá o cruzeiro
    // inteiro no perpendicular (quem cruza não foge nem vem no meu eixo), a soma das duas no de
    // frente, e no mesmo rumo a conta é exatamente a subtração de sempre: a fila atrás de lataria
    // parada não muda nada. A *minha* marcha entra como a possível pelo motivo escrito na doca
    // desta função: medida na anunciada, o pedal do freio desliga a própria rampa no quadro em
    // que ele está no fundo, e a fila do ponto passa a serrar.
    const alcanço = marchaDe - para.speed * Math.cos(para.angle - de.angle);
    // Fila não é disputa. O portão do `alcanço` existe para o cruzamento — dois rumos que se
    // cortam, cada um plantado porque o outro está a 1,6 tile, e a distância entre os dois nunca
    // muda porque os dois devem o mesmo tempo. Num engarrafamento da própria linha a resposta é
    // oposta: lataria parada atrás de lataria parada É a fila, e soltar o de trás porque "ele não
    // alcança ninguém" é o dente de serra que a régua de acima descreve — um quadro de marcha
    // cheia, um quadro de pé no chão, e o passo de avance vem sempre antes da leitura, então a
    // fila come a própria folga um décimo de tile por ciclo. Dentro da linha de parada, na mesma
    // faixa e no mesmo sentido, o freio é de distância e não de velocidade relativa.
    const virada = Math.abs(((para.angle - de.angle + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
    const naMesmaFila = Math.abs(Math.sin(virada)) < 0.25 && Math.cos(virada) > 0;
    const aberta = !naMesmaFila && alcanço <= 0 ? 0
      : frente <= linha ? 1 : (horizonte - frente) / HORIZONTE_DE_FREIO;
    return {
      // Igualar a marcha de quem fecha sobre mim é uma metade da régua; a outra é parar na linha
      // *tendo a quem alcançar*. `fecho` é medido no quadro que acabou, então o tudo-ou-nada dele
      // atrasa um quadro: o ônibus plantado atrás de outro plantado lê duas marchas zero, o fecho
      // dá zero, o freio solta, e a recuperação de atraso — meia marcha por segundo correndo atrás
      // do horário — empurra a lataria dois terços de um passo à frente. No quadro seguinte ela está
      // fechando de novo, e trava. É o dente de serra que come a folga aos poucos: a fila anda, para,
      // anda, e uma hora encosta. Dentro da linha, diante de quem eu alcanço, não é dosagem, é
      // parada — a rua que falta para o encosto não é minha.
      aperto: Math.max(fecho, aberta),
      falta: frente - linha,
      // Colado é a folga de encosto, não a linha de freio: é a régua de quem ainda tem rua para
      // *comprar* ao recuperar atraso. Um comboio a 1,6 tile — a linha de freio de um corpo em
      // marcha — não tem o que devolver a ninguém, e segurar a recuperação ali é o que deixa a
      // fila sangrando tempo volta após volta até o teto do horário.
      colado: frente < parada,
      deficit: frente < caixa.frente ? parada - frente : 0,
    };
  }

  /**
   * O quanto este corpo precisa recuar na própria faixa para deixar de estar em cima de um
   * vizinho com quem nenhum dos dois tem conversa: no abraço de dois rumos que se cruzam, cada
   * um jurando que o outro está atrás de si, o cone não vê ninguém e a lataria passa por dentro
   * da lataria. Aqui a pergunta não é quem tem a frente, é quem cede: cede quem tem o outro à
   * sua frente, e no bolso diagonal em que os dois juram que o outro ficou para trás cede quem
   * tem corda no relógio — ver `corda`. Sem uma ordem os dois recuam e nenhum dos dois sai do
   * bolso do outro. Separar pelo eixo comprido de quem cede chega: se as duas caixas se tocam,
   * todos os quatro eixos estão penetrados, e abrir o meu próprio basta para os dois voltarem a
   * ser dois.
   */
  private abraço(i: number, corpo: StreetBody): number {
    const cos = Math.cos(corpo.angle), sin = Math.sin(corpo.angle);
    let falta = 0;
    for (let j = 0; j < this.bodies.length; j++) {
      if (j === i) continue;
      const outro = this.bodies[j];
      if (!outro.live) continue;
      if (!seEncostamEntre(corpo, outro) || !seEncostamEntre(outro, corpo)) continue;
      const dx = outro.x - corpo.x, dy = outro.y - corpo.y;
      const frente = dx * cos + dy * sin;
      const dele = (corpo.x - outro.x) * Math.cos(outro.angle)
        + (corpo.y - outro.y) * Math.sin(outro.angle);
      // Recuar abre a lataria de quem está NA MINHA FRENTE e fecha a de quem está atrás: se o
      // vizinho é o que me segue, ceder é dar um passo para dentro dele, e a corrente inteira
      // atrás anda o mesmo tanto junto — foi assim que uma fila desceu a avenida de ré a
      // noventa tiles por segundo, sem que nenhum dois deixasse de estar em cima do outro. Quem
      // está atrás cede por si só, porque na conta dele eu sou o corpo à frente. Só no bolso
      // diagonal em que os dois juram que o outro ficou para trás é que a ordem volta a decidir,
      // uma vez, sem corrente — e a ordem é o índice, com uma exceção: o designado que está com
      // o relógio falido não anda um milímetro, e um par soldado no mesmo pixel não é prioridade
      // de horário, é o "eles se atravessam" do jogador dura mil quadros. Nessa peia cede quem
      // tem com que pagar — ver `quemCedeNaPeia`.
      if (frente <= MESMO_MILIMETRE) {
        if (dele > MESMO_MILIMETRE) continue;
        if (!this.quemCedeNaPeia(i, j)) continue;
      }
      const precisa = meiaCaixaEntre(corpo, outro).frente + FOLGA_PARA_CHOQUE - frente;
      if (precisa > falta) falta = precisa;
    }
    return falta;
  }

  /**
   * Na peia diagonal, quem é o da vez de recuar. A regra é o índice (o de número maior cede), a
   * mesma do `apertoÀFrente`, porque sem uma ordem os dois recuam e nenhum dos dois sai do bolso
   * do outro. O índice só perde uma vez: quando o designado não tem corda no relógio para pagar
   * um corpo de recuo e o outro tem. Aí ceder é palavra vazia — `recuaNoRelógio` cobra o fundo
   * que não existe, o corpo fica onde está, e no quadro seguinte o horário escreve a lataria
   * em cima da outra de novo. Foi assim que duas linhas perpendiculares passaram 974 quadros
   * desenhadas como um ônibus só, e nenhum dos dois destrava: enquanto as caixas se tocam, a
   * recuperação de atraso está fechada, então a dívida nunca volta a dar corda.
   */
  private quemCedeNaPeia(i: number, j: number): boolean {
    const eu = this.podePagarRecuo(i), ele = this.podePagarRecuo(j);
    // Só um dos dois tem corda: é esse quem cede. Mandar o falido recuar é a conta que devolve
    // zero tiles, o corpo fica onde está e o horário escreve a lataria em cima da outra no quadro
    // seguinte — foi assim que duas linhas perpendiculares passaram 974 quadros desenhadas como
    // um ônibus só.
    if (eu !== ele) return eu;
    // Nenhum dos dois paga um corpo: não há ordem melhor que a antiga, e o par se separa quando
    // a fila destrava e o relógio de alguém volta a ter fundo.
    if (!eu) return i > j;
    // Os dois pagam: cede o mais atrasado. O pontual é o que tem painel a cumprir, e o que já
    // comeu metade da volta está justamente no asfalto onde não deveria estar.
    const minha = this.corda(i), doOutro = this.corda(j);
    if (minha !== doOutro) return minha < doOutro;
    return i > j;
  }

  /**
   * Se o relógio desta unidade ainda aguenta comprar a rua que um abraço custa. Fundo é a volta
   * da linha menos a espera do ponto menos a dívida já carregada, e o preço é a lataria mais o
   * palmo de para-choque: corda que não paga um corpo não separa duas caixas, e o par ficaria
   * colado com os dois lados da conta concordando que não há nada a fazer.
   */
  private podePagarRecuo(i: number): boolean {
    const rota = this.network.routes[this.units[i].route];
    return this.corda(i) * this.network.services[rota.service].speed >= PREÇO_DO_ABRAÇO;
  }

  /**
   * Quem vem atrás, na mesma faixa, e o quarto que ele deixou livre: o tanto que este corpo pode
   * recuar antes de encostar no para-choque de trás. Sem ninguém atrás, o asfalto inteiro é livre.
   *
   * Fila é gente que corre para o mesmo lado, e o rumo é o que separa uma fila de um encontro:
   * dois corpos que se cruzam de lado veem um ao outro às suas costas — para quem olha na
   * própria direção, o outro ficou para trás — e uma corrente que segue esse par não tem fim,
   * porque cada elos empurra o outro e nenhum dos dois sai do lugar. O que se atravessa não é
   * fila: é o `abraço`, e no abraço quem cede é decidido pelo índice, uma vez, sem corrente.
   */
  private quemVemAtrás(i: number, corpo: StreetBody): { de: number; livre: number } {
    const cos = Math.cos(corpo.angle), sin = Math.sin(corpo.angle);
    let de = -1, livre = Infinity;
    for (let j = 0; j < this.bodies.length; j++) {
      if (j === i) continue;
      const outro = this.bodies[j];
      if (!outro.live) continue;
      if (Math.cos(corpo.angle - outro.angle) < 0.5) continue;
      const dx = outro.x - corpo.x, dy = outro.y - corpo.y;
      const trás = -(dx * cos + dy * sin);
      if (trás < -MESMO_MILIMETRE) continue;
      // Lado a lado não é fila de ninguém: dois corpos que se encostam de lado têm um ao outro
      // exatamente às costas — a projeção no rumo de cada um é zero — e uma corrente que siga
      // esse par dá a volta em si mesma, com cada elo empurrando o elos que o empurra. Sem uma
      // ordem, nenhum dos dois anda e os dois ficam em cima um do outro para sempre. A ordem é o
      // índice, a mesma do `abraço`: ombro a ombro, quem cede é o de índice menor, uma vez.
      if (trás < MESMO_MILIMETRE && j < i) continue;
      const caixa = meiaCaixaEntre(corpo, outro);
      if (Math.abs(-dx * sin + dy * cos) > caixa.lado + FOLGA_LATERAL) continue;
      const folga = trás - caixa.frente - FOLGA_PARA_CHOQUE;
      if (folga < livre) { livre = folga; de = j; }
    }
    return { de, livre: de < 0 ? Infinity : Math.max(0, livre) };
  }

  /**
   * Recuar um corpo até `metros` tiles na própria faixa, e entregar ao que vem atrás o que não
   * coube: um ônibus que precisa abrir lataria e tem lataria colada nas suas costas não para,
   * empurra, e o empurrado faz o mesmo até o último da fila, que tem o asfalto inteiro atrás de
   * si. O recuo não tem teto de fila porque não precisa: tem corrente. Congelar os dois era a
   * parede — um de frente para o outro, nenhum dos dois anda, e tudo o que chega depois encosta
   * em cima, que é o monte de ônibus parado no mesmo ponto que o jogador vê.
   *
   * Cada elos escreve no relógio e volta ao relógio na mesma hora: é assim que o próximo da
   * corrente enxerga o corpo já movido, e não o que ele era no começo do quadro.
   *
   * A corrente é uma lista, não um contador: um elo que voltasse a um ônibus já empurrado nesta
   * mesma volta teria de recuar a si mesmo, e o teto de profundidade que segurava esse laço
   * simplesmente parava a conta no meio — os dois ficavam em cima um do outro para sempre, com
   * a fila toda atrás deles plantada no mesmo palmo de asfalto.
   */
  private recede(i: number, metros: number, corrente: number[]): void {
    if (metros <= 0 || corrente.includes(i)) return;
    corrente.push(i);
    const u = this.units[i];
    const corpo = this.bodies[i];
    const trás = this.quemVemAtrás(i, corpo);
    // Primeiro abre o quarto, depois usa o quarto: quem está atrás recua o que falta antes de
    // quem está na frente pisar no freio, porque na ordem contrária o corpo fica onde estava e a
    // lataria da frente continua em cima dele — a fila empurraria sem andar.
    const faltaDeQuarto = metros - trás.livre;
    if (trás.de >= 0 && faltaDeQuarto > 0) this.recede(trás.de, faltaDeQuarto, corrente);
    u.held = true;
    this.dose[i] = 0;
    const eixo = corpo.angle;
    const antesX = corpo.x, antesY = corpo.y;
    this.recuaNoRelógio(i, metros);
    this.escorregou.push(i);
    // O buraco que se abre atrás é o asfalto que o corpo realmente deixou, e isso só se sabe
    // depois de ele pousar. Pedir um tile e andar oito é o preço de pular a janela de espera de
    // um ponto: dentro dela atrasar não move lataria nenhuma, então a conta salta a espera
    // inteira e o corpo cai uma quadra para trás — em cima de quem vinha atrás e estava a oito.
    // A corrente aberta antes tinha o tamanho do pedido; aqui ela toma o tamanho do pouso, lido
    // no corpo já escrito, e empurra o seguidor que ficou por baixo.
    const pouso = Math.max(0, (antesX - corpo.x) * Math.cos(eixo)
      + (antesY - corpo.y) * Math.sin(eixo));
    const depois = this.quemVemAtrás(i, corpo);
    const sobra = Math.max(metros, pouso) - depois.livre;
    if (depois.de >= 0 && sobra > 0) this.recede(depois.de, sobra, corrente);
  }

  /**
   * A corda do relógio: quanto de atraso esta unidade ainda pode comprar antes de a volta
   * inteira ter sido comida pela fila. Recuar no asfalto é pagar com `atraso`, e o relógio de um
   * ônibus tem fundo — a volta menos a espera do ponto menos a dívida que ele já carrega. Fundo
   * zero não é ônibus atrasado, é ônibus falido: o `recuaNoRelógio` dele custa zero tiles, e um
   * par colado nessa marca nunca se separa. É por esta régua que o `abraço` escolhe quem cede no
   * bolso diagonal, e é por ela que o recuo para de comprar asfalto em vez de teleportar a
   * lataria para outra volta da mesma linha.
   */
  private corda(i: number): number {
    const u = this.units[i];
    const rota = this.network.routes[u.route];
    return rota.cycle - this.network.services[rota.service].dwell - u.atraso;
  }

  /**
   * Compra `metros` tiles de asfalto atrás deste corpo pagando apenas com relógio, e paga
   * exato. O relógio tem janelas em que atrasar não move lataria nenhuma: dentro da espera de um
   * ponto, esperar É parar no mesmo lugar, então um passo curto deixa o ônibus em cima do vizinho
   * pelo tempo inteiro que falta. Se a amostra pousou dentro de uma espera, o preço não é só o
   * asfalto que falta — é a profundidade daquela espera (o tempo que ela ainda tem pela frente)
   * somada ao asfalto, o que põe o corpo exatamente `metros` atrás do passeio, no meio da própria
   * fila de chegada. Pular a janela inteira, um `dwell` de cada vez, jogaria a lataria uma quadra
   * para trás e ela iria encostar em quem vinha atrás — o recuo viraria um atropelamento.
   *
   * O corpo nunca é empurrado à mão: o que se move é o `atraso`, e a posição volta a ser lida da
   * conta, porque um corpo escrito fora do relógio é apagado pela próxima amostra.
   */
  private recuaNoRelógio(i: number, metros: number): void {
    const u = this.units[i];
    const corpo = this.bodies[i];
    const rota = this.network.routes[u.route];
    const serviço = this.network.services[rota.service];
    const marcha = serviço.speed;
    const cos = Math.cos(corpo.angle), sin = Math.sin(corpo.angle);
    let deve = metros / marcha;
    for (let tentativa = 0; tentativa < 4; tentativa++) {
      const s = sampleRoute(rota, serviço, this.time - (u.atraso + deve), u.unit);
      const andou = (corpo.x - s.x) * cos + (corpo.y - s.y) * sin;
      if (andou >= metros - MESMO_MILIMETRE) break;
      // `fundo` é o quanto desta espera ainda existe entre a amostra e o instante em que ela
      // começa: é o pedaço do preço que não produz rua, e por isso se paga antes do resto.
      deve += (s.stopped ? s.phase - rota.table[s.pass].time : 0) + (metros - andou) / marcha;
    }
    // O recuo compra asfalto com relógio, e o relógio de um ônibus tem fundo: a volta do horário
    // menos a espera. Passar do fundo é o ônibus virar outra volta da mesma linha — e o preço
    // cobrado no quadro seguinte, quando o freio devolve o que passou, é um corpo arremessado
    // quatro tiles à frente, em cima de quem ele freou a vida inteira. Então o que não cabe no
    // fundo não é comprado: lataria na parede do horário espera a rua abrir, não teleporta.
    const fundo = this.corda(i);
    const pago = Math.min(deve, Math.max(0, fundo));
    u.atraso += pago;
    // O recuo é salto, não marcha: guardado para a régua de velocidade do próximo quadro não
    // ler um ônibus recém-recuado como um que estava parado.
    this.pulo[i] += metros * (deve > 0 ? pago / deve : 1);
    this.recolocaNoRelógio(i);
  }

  /**
   * O aperto máximo entre todos os corpos vivos à frente deste, e o quanto de lataria já se
   * toca com o pior deles. Quem está do outro lado da via não entra na conta — a caixa lateral
   * dos dois paralelos é 0,85 tile e as duas faixas do asfalto gerado ficam a um tile de centro
   * a centro —, e um ônibus atravessando a minha frente entra, porque a caixa de dois corpos
   * perpendiculares é maior justamente no lado.
   *
   * No cruzamento em que os dois se veem, cede quem tem mais rua até a própria linha de
   * parada: o que passa é o que já quase chegou, e o que espera é o que ainda tem asfalto
   * antes da tragédia. No empate do virador de terminal, onde as duas distâncias são a mesma
   * conta, segue o de índice menor — sem uma ordem os dois freiam um para o outro e a rua
   * trava, que é o beco sem saída que o jogador não destrava a pé.
   */
  /**
   * O aperto do semáforo. O ônibus já lê a lataria da sua faixa, cede passo a quem atravessa e
   * dosa antes do encosto — o que faltava era a luz: nenhuma conta da malha pergunta a um poste
   * se ele deixa entrar no cruzamento, e é por isso que a lataria passa no vermelho por cima do
   * carro que espera o verde.
   *
   * A olhada é a do carro, sete tiles no rumo real do corpo, e o primeiro poste que ela encontra
   * é o cruzamento em que este ônibus entra. Da caixa do poste sai a linha de parada: a borda que
   * ele encara, não o centro do cruzamento — parar com a lataria na boca é tapar a faixa que os
   * outros atravessam, o entupimento que o jogador vê e ninguém explica.
   *
   * Quem já entrou não freia: o corpo que pegou o amarelo atravessa, não planta no meio do
   * asfalto e para as duas correntes ao mesmo tempo. E a vez pedida (`request`) é a mesma
   * cortesia do carro — um ônibus que não demanda nada é um ônibus esperando verde no eixo errado.
   */
  private apertoDoSinal(i: number, corpo: StreetBody): { aperto: number; colado: boolean } {
    const conta = this.contaDoSinal;
    conta.aperto = 0;
    conta.colado = false;
    const sinais = this.signals;
    if (!sinais) return conta;
    // Dentro da caixa não há luz a obedecer: quem entrou, atravessa.
    if (sinais.at(corpo.x, corpo.y)) return conta;
    const ux = Math.cos(corpo.angle), uy = Math.sin(corpo.angle);
    let posto: TrafficSignal | null = null;
    for (let d = 0.5; d <= OLHADA_DO_SINAL; d += 0.5) {
      const s = sinais.at(corpo.x + ux * d, corpo.y + uy * d);
      if (s) { posto = s; break; }
    }
    if (!posto) return conta;
    sinais.request(posto, corpo.dir);
    // Sem poste não há luz nenhuma, e o cruzamento aberto é a conta do vizinho que já chega
    // cortando a minha faixa — que `apertoDeTravessia` e a rua cobrem, cada um no seu eixo.
    if (!posto.controlled || sinais.allows(posto, corpo.dir)) return conta;
    const beiraX = ux >= 0 ? posto.minX : posto.maxX;
    const beiraY = uy >= 0 ? posto.minY : posto.maxY;
    // O encontro do rumo com a borda da caixa, em tiles de asfalto à frente do corpo. Negativo é
    // quem já está na boca — e na boca não se freia, se atravessa.
    const atéBeira = Math.abs(ux) >= Math.abs(uy)
      ? (beiraX - corpo.x) / ux
      : (beiraY - corpo.y) / uy;
    if (atéBeira <= 0) return conta;
    const muro = this.muro;
    muro.x = corpo.x + ux * atéBeira;
    muro.y = corpo.y + uy * atéBeira;
    muro.angle = corpo.angle;
    muro.dir = corpo.dir;
    // O `fecho` é a minha marcha realizada, porque o muro no asfalto não anda: a distância fecha
    // na velocidade de quem chega, e é ela que diz se o freio é de rampa ou de parada.
    const meu = this.freio(corpo, muro, this.marchava[i], this.cruzeiroDo(i));
    if (meu) {
      conta.aperto = meu.aperto;
      conta.colado = meu.colado;
    }
    return conta;
  }

  /**
   * A lataria do próximo quadro encosta em alguém por causa do GIRO? O cone olha o asfalto de
   * agora e o `abraço` conserta o de ontem; entre os dois sobra um quadro, e é nele que a esquina
   * entra: o ônibus vira, e a própria caixa de 1,25 × 0,85 gira noventa graus num só traço,
   * passando por cima de quem estava a um palmo do seu flanco. Medido no asfalto os dois nunca
   * estiveram um na frente do outro — os dois cones são cegos para isso —, e nenhum freio de
   * distância os viu. Esta régua não pergunta quem está onde: pergunta onde o horário vai escrever
   * esta lataria se ninguém pisar no freio, e só responde quando é a rotação que cria o encontro.
   * A traslação é do cone, com rampa, folga de para-choque e fila — porque plantar um ônibus antes
   * da fila do ponto seria negar a parada que o horário prometeu ao passageiro.
   *
   * Encostando pelo giro, a lataria entra na curva a passo de manobra. Dosar é pagar relógio sem
   * parar de andar, então o corpo sai do vértice em vez de ficar proibido de girar: é a marcha
   * dosada de sempre, sem o recuo de emergência e sem o pulo de um corpo e meio que o jogador
   * chama de teleporte.
   *
   * Corpo parado no berço não devolve curva — ele não recua sem pular a própria espera —, e os
   * dois virando para o mesmo bolso têm uma vez só, decidida pelo índice da frota como no cone e
   * na peia: sem ordem os dois plantam e ninguém passa nunca.
   */
  private apertoDaCurva(i: number, corpo: StreetBody, dt: number): number {
    const u = this.units[i];
    const rota = this.network.routes[u.route];
    const s = sampleRoute(rota, this.network.services[rota.service],
      this.time - u.atraso + dt, u.unit);
    if (Math.abs(Math.sin(s.angle - corpo.angle)) < 0.25) return 0;
    const esquina = this.esquina;
    esquina.meio = corpo.meio;
    esquina.flanco = corpo.flanco;
    for (let j = 0; j < this.bodies.length; j++) {
      if (j === i) continue;
      const outro = this.bodies[j];
      if (!outro.live) continue;
      const dx = outro.x - corpo.x, dy = outro.y - corpo.y;
      if (dx * dx + dy * dy > 2.6 * 2.6) continue;
      // O corpo emprestado é um só e a visita ao vizinho de fora o reescreve: a minha caixa de
      // amanhã é escrita a cada olhada, não uma vez por quadro.
      esquina.x = s.x;
      esquina.y = s.y;
      esquina.angle = s.angle;
      if (!this.encosta(esquina, outro)) continue;
      esquina.angle = corpo.angle;
      if (this.encosta(esquina, outro)) continue;
      const vizinho = this.units[j];
      if (vizinho.stopped || vizinho.parked) return 1;
      if (this.encosta(this.caixaQueVem(j, dt), corpo) && i < j) continue;
      // E aqui a manobra anda a passo de calçada, não a pé no chão. O pé no chão era a tradução
      // literal de "o giro encosta", e ela se mordiu sozinha: a caixa de amanhã é amostrada com
      // um `dt` de horário, e um corpo plantado paga exatamente um `dt` de atraso — os dois se
      // cancelam no relógio e o amanhã da curva nunca chega. O ônibus do vértice ficava proibido
      // de girar para sempre, sem lataria nenhuma na frente dele, e cada fila que nascia atrás
      // dele fechava a malha inteira: contada em `tools/tmp/prova-livelock.cjs`, sete desses
      // plantados pela curva bastaram para parar setenta e nove ônibus e estourar o atraso da
      // frota no teto da volta. Dosada, a mesma regra vira o que o motorista faz: entra na curva
      // devagar, e se o flanco ainda esbarra é o `abraço` quem decide quem recua — com os dois
      // corpos no asfalto de verdade, não com um amanhã que o relógio nunca alcança.
      return 1 - MARCHA_DA_CURVA;
    }
    return 0;
  }

  /** A caixa do quadro que vem, escrita no corpo emprestado: o ponto e o rumo do horário. */
  private caixaQueVem(k: number, dt: number): StreetBody {
    const corpo = this.bodies[k];
    const u = this.units[k];
    const rota = this.network.routes[u.route];
    const s = sampleRoute(rota, this.network.services[rota.service],
      this.time - u.atraso + dt, u.unit);
    const caixa = this.esquina;
    caixa.x = s.x;
    caixa.y = s.y;
    caixa.angle = s.angle;
    caixa.meio = corpo.meio;
    caixa.flanco = corpo.flanco;
    return caixa;
  }

  /** Dois retângulos de verdade, olhados dos dois lados: é assim que o `abraço` pergunta. */
  private encosta(a: StreetBody, b: StreetBody): boolean {
    return seEncostamEntre(a, b) && seEncostamEntre(b, a);
  }

  private apertoÀFrente(i: number, corpo: StreetBody):
    { aperto: number; deficit: number; colado: boolean; cedePara: number; emperra: boolean } {
    let aperto = 0, deficit = 0, colado = false, emperra = false;
    let cedePara = -1, cedeClaim = -Infinity, segurado = -1, seguradoFalta = Infinity;
    const meuRelógio = this.units[i].atraso;
    for (let j = 0; j < this.bodies.length; j++) {
      if (j === i) continue;
      const outro = this.bodies[j];
      if (!outro.live) continue;
      const meu = this.freio(corpo, outro, this.marchava[i] - this.marchava[j], this.cruzeiroDo(i));
      if (!meu) continue;
      // Colado é a geometria pura, sem o `fecho` do aperto: lataria na folga de encosto é rua
      // acabada, e quem cede no empate do cruzamento continua sem rua nenhuma. É por esta régua
      // que a fila de trás segura o relógio em vez de recuperar atraso e fechar de novo o buraco
      // que o recuo acabou de abrir — e é por ela ser a folga, não o freio, que um comboio
      // andando junto continua podendo correr atrás do horário.
      if (meu.colado) colado = true;
      const dele = this.freio(outro, corpo, this.marchava[j] - this.marchava[i], this.cruzeiroDo(j));
      if (dele && (meu.falta > dele.falta || (meu.falta === dele.falta && i < j))) continue;
      // Esta linha é o único desempate do cruzamento agora que o `alcanço` é medido na marcha
      // possível: dois corpos plantados um de frente para o outro dentro da linha do outro lêem
      // rampa cheia, os dois devem tempo igual, a distância entre eles não muda e o aperto nunca
      // sai de 1,00 — a parede de 191 unidades seguradas que a doca de `freio` conta. Quem tem
      // menos rua até a própria linha de parada é quem precisa dela: o outro cede o asfalto e
      // anda, e o bolso se desfaz sozinho. Medindo na marcha anunciada o empate se desfazia por
      // acidente, um quadro de cada vez, e o preço era o dente de serra que a tela vê.
      if (meu.aperto > aperto) aperto = meu.aperto;
      if (meu.deficit > deficit) deficit = meu.deficit;
      // A conta do bolso, para quem a disputa de cima não abriu. Três coisas têm de ser verdade
      // ao mesmo tempo: o vizinho está *dentro da minha linha de parada* (`frente` é a projeção
      // para a frente, e um corpo atrás de mim devolve null na régua — nada aqui vem de lataria
      // que eu deixei para trás); ele não está a caminho de lugar nenhum (`marchava` é a rua
      // percorrida no quadro que acabou, e zero é lataria plantada); e ele não está *no embarque*
      // (`stopped`/`parked`), porque quem espera na fila de um ônibus que pega passageiro não tem
      // asfalto a comprar de ninguém — a fila anda no ritmo do embarque, e é o certo.
      //
      // `segurado` é a aresta do "quem espera quem" e entra no `quemMeSegura` do quadro; o bolso
      // só é bolso quando a corrente volta ao ponto de partida (`emBolso`), e uma fila que sobe
      // até uma lataria parada no ponto não é. `cedePara` é o mesmo vizinho, mas só quando ele
      // está colado na minha linha *e* deve mais atraso que eu: entre dois emperrados, o mais
      // atrasado é quem tem mais a perder parado, e mandá-lo na frente é o menor prejuízo da volta
      // inteira. Com dívida igual o índice maior é que cede — sorteio, sim, mas um sorteio que
      // forma ordem total: num bolso de n corpos, exatamente o de maior claim não cede, e os
      // outros n-1 abrem rua para ele.
      const plantado = !this.units[j].stopped && !this.units[j].parked
        && this.marchava[j] <= MESMO_MILIMETRE;
      if (plantado && meu.falta <= PALMO_DE_CEDA) {
        emperra = true;
        if (meu.falta < seguradoFalta) { seguradoFalta = meu.falta; segurado = j; }
        const deveMais = this.units[j].atraso > meuRelógio + MESMO_MILIMETRE
          || (Math.abs(this.units[j].atraso - meuRelógio) <= MESMO_MILIMETRE && j > i);
        if (deveMais && meu.falta <= MESMO_MILIMETRE && this.units[j].atraso > cedeClaim) {
          cedeClaim = this.units[j].atraso;
          cedePara = j;
        }
      }
    }
    this.quemMeSegura[i] = segurado;
    return { aperto, deficit, colado, cedePara, emperra };
  }

  /**
   * A corrente de quem-espera-quem começa em `de` e volta em `eu`? É a diferença entre fila e
   * bolso, e ela não cabe em uma olhada só de vizinho: um ônibus plantado atrás de outro plantado
   * atrás de outro é uma fila normal, e a lataria que recua numa fila perde a vaga do embarque
   * para ninguém. Num bolso a corrente fecha — cada um dos presos está dentro da linha de parada
   * de alguém do próprio bolso — e aí não existe ordem que a rua respeite enquanto os dois
   * seguram, porque cada um cede o asfalto para quem lhe cede o asfalto.
   *
   * Um teto de dezesseis saltos é o custo da pergunta: ela só é feita por quem já passou de
   * `PESO_DO_EMPERRA` com a lataria parada, e o anel que emperra a malha inteira cabe em muito
   * menos que isso. Acima do teto a resposta é "não", que é o mesmo erro de um quadro atrás: a
   * fila continua esperando do jeito certo.
   */
  private emBolso(de: number, eu: number): boolean {
    let atual = de;
    for (let fundo = 0; fundo < 16 && atual >= 0; fundo++) {
      if (atual === eu) return true;
      atual = this.quemMeSegura[atual];
    }
    return false;
  }

  /**
   * O aperto de quem não está na minha faixa mas vai passar pelo mesmo ponto: o ônibus que
   * atravessa a boca do cruzamento corre no meu eixo curto, então a régua lateral do cone só o
   * vê quando ele já está colado de lado — tarde demais para dois carros de 3,5 tiles por
   * segundo. Aqui a conta é de tempo, não de distância: os dois rumos se cortam num ponto, cada
   * um tem uma rua até ele, e cede quem chega depois. Um corpo parado no meio do caminho não
   * tem tempo nenhum — o ponto está tomado, e é quem se aproxima que espera.
   */
  private apertoDeTravessia(i: number, corpo: StreetBody): number {
    let aperto = 0;
    for (let j = 0; j < this.bodies.length; j++) {
      if (j === i) continue;
      const outro = this.bodies[j];
      if (!outro.live) continue;
      const apertando = this.corte(i, corpo, outro, j);
      if (apertando > aperto) aperto = apertando;
    }
    return aperto;
  }

  /**
   * O aperto de um encontro entre dois rumos que se cortam — a conta do `apertoDeTravessia` para
   * um corpo só. `j` é o índice do outro na frota, e `-1` é a rua: o empate entre dois ônibus é
   * sorteio de índice, porque um dos dois tem de passar e a ordem precisa ser a mesma nos dois
   * lados da conta; o empate entre um ônibus e um corpo da rua não é sorteio nenhum — quem tem
   * horário a perder sou eu, e quem atravessa a faixa a pé não tem fila nenhuma atrás de si.
   */
  private corte(i: number, corpo: StreetBody, outro: StreetBody, j: number): number {
    if (corpo.speed <= 0) return 0;
    const ux = Math.cos(corpo.angle), uy = Math.sin(corpo.angle);
    const vx = Math.cos(outro.angle), vy = Math.sin(outro.angle);
    const cante = ux * vy - uy * vx;
    // Quase paralelos não têm encontro: é a mesma faixa, e quem cuida dela é o cone.
    if (Math.abs(cante) < 0.25) return 0;
    const dx = outro.x - corpo.x, dy = outro.y - corpo.y;
    const minhaRua = (dx * vy - dy * vx) / cante;
    const ruaDele = (dx * uy - dy * ux) / cante;
    const caixa = meiaCaixaEntre(corpo, outro).frente;
    if (minhaRua < 0) return 0;
    if (outro.speed > 0) {
      if (ruaDele < -caixa) return 0;
    } else if (Math.abs(ruaDele) > caixa) {
      return 0;
    }
    const meuTempo = minhaRua / corpo.speed;
    const tempoDele = outro.speed > 0 ? ruaDele / outro.speed : 0;
    const diferença = meuTempo - tempoDele;
    if (Math.abs(diferença) > JANELA_DE_ENCONTRO) return 0;
    if (diferença < 0 || (diferença === 0 && i < j)) return 0;
    return Math.abs(diferença) <= ENCONTRO_IMINENTE ? 1
      : 1 - Math.abs(diferença) / JANELA_DE_ENCONTRO;
  }

  /**
   * Zona de cada linha vista da câmera, do ponto mais próximo da polilinha. A caixa da rota
   * não serve de teste: uma linha que atravessa o mapa tem uma caixa enorme, e a câmera no
   * canto estaria "dentro" de tudo enquanto o asfalto mais perto está do outro lado do mundo.
   * Os pontos são a polilinha amostrada a cada `PROBE_STEP` tiles na construção — a margem
   * de erro é menor que um chunk, que é a granularidade com que o portão decide.
   */
  private readTiers(x: number, y: number, streaming: WorldStreamingManager): void {
    for (const route of this.network.routes) {
      const probes = this.probes[route.id];
      let best: StreamingTier = TIER.OUTSIDE;
      for (let i = 0; i < probes.length; i += 2) {
        const dx = probes[i] - x;
        const dy = probes[i + 1] - y;
        // Longe demais para ser sequer o anel de streaming: nem consulta o tierOf.
        if (dx * dx + dy * dy > this.streamFloor2) continue;
        const t = streaming.tierOf(probes[i], probes[i + 1]);
        if (t > best) {
          best = t;
          if (t === TIER.VISIBLE) break;
        }
      }
      this.tiers[route.id] = best;
    }
  }

  /** Paradas ao alcance de quem está a pé no ponto pedido. */
  stopsAt(x: number, y: number, radius = 2.4): TransportStation[] {
    return stopsNear(this.network, x, y, radius);
  }

  /**
   * A calçada de embarque de um lugar do mundo: a parada com linha mais perto, procurada em
   * raio crescente. É derivada do mapa, nunca uma coordenada escrita à mão — trocando a
   * semente, a rodoviária cai em outra quadra e a plataforma dela muda junto. `null` é o lote
   * sem ônibus nenhum a sessenta e quatro tiles, o que a malha atual não produz.
   */
  platformNear(x: number, y: number): TransportStation | null {
    let queda: TransportStation | null = null;
    for (const radius of [3, 8, 16, 32, 64]) {
      for (const station of stopsNear(this.network, x, y, radius)) {
        if (!station.lines.length) continue;
        // A rodoviária vence qualquer calçada de rua no mesmo raio: quem está na quadra do
        // terminal embarca no terminal, não na avenida em volta dele. A preferência é por
        // raio, nunca global — a 8 tiles do hall ainda vale a parada da esquina, e um
        // predomínio absoluto transformaria cada bordo da cidade em fila de rodoviária.
        if (station.terminal) return station;
        if (!queda) queda = station;
      }
    }
    return queda;
  }

  /** O telão de partidas de uma calçada, no relógio da malha. */
  departuresAt(station: number): TransportDeparture[] {
    return departures(this.network, station, this.time);
  }

  /** Próximas passadas de uma parada, com o tempo de espera no relógio da malha. */
  arrivals(station: number, count = 3): TransportArrival[] {
    return nextArrivals(this.network, station, this.time, count);
  }

  /**
   * Quantos segundos até O veículo prometido pela perna encostar naquela calçada — não "um
   * ônibus da linha", que na mesma passada pode ser o colega dois carros atrás. É a conta do
   * horário, no mesmo relógio do telão, e enrola para a volta seguinte quando a hora prometida
   * já passou e o passageiro ainda está no passeio.
   */
  esperaDaPerna(leg: TransportLeg): number {
    const route = this.network.routes[leg.route];
    return Math.max(0, passAt(route, leg.pass, this.time, leg.unit) - this.time);
  }

  /**
   * Viagem de uma calçada a outra pelo horário. `null` é cidade sem linha entre elas. O
   * `anunciado` é a linha do telão que o passageiro tocou: com ele, o plano é aquele ônibus
   * daquela passada, e não o mais rápido que o horário encontrou depois.
   */
  trip(from: number, to: number, anunciado?: { route: number; pass: number; unit: number } | null):
    TransportTrip | null {
    return planTrip(this.network, from, to, this.time, anunciado);
  }

  /**
   * A calçada onde uma unidade encostou, ou -1 quando ela não está servindo parada nenhuma.
   * É o `stop` do horário devolvido como estação: é por ele que o embarque sabe se o ônibus
   * parado na frente do jogador é o ônibus *daquela* calçada.
   */
  private stopStation(u: TransportUnit): number {
    if (!u.stopped || u.stop < 0) return -1;
    const stops = this.network.routes[u.route].stops;
    return u.stop < stops.length ? stops[u.stop].station : -1;
  }

  /**
   * A unidade do horário que ainda vai servir uma passada — o corpo sobre o qual a tela põe a
   * seta. Não é "o ônibus mais perto" nem "o da mesma linha": a ida e a volta correm em faixas
   * vizinhas da mesma rua, então dois veículos da *mesma* `Linha 7` passam pelo jogador ao mesmo
   * tempo, para lados opostos da cidade, e só um deles cumpre a perna planejada. A resposta vem
   * do anel do ciclo: quanto falta para a fase desta unidade bater o instante daquela entrada
   * da tabela, e a menor espera vence.
   *
   * Dentro da janela de `dwell` daquela entrada a espera é zero de propósito. O ônibus que está
   * encostado agora é o alvo, e uma seta que pulasse para o próximo — porque a fase dele já
   * passou do instante da tabela em um frame — faria o jogador correr atrás de um veículo que
   * acabou de abrir a porta na calçada dele.
   *
   * Só concorrem as unidades que o relógio escreveu neste frame (`lida`): um ônibus de um tier
   * distante tem fase parada no tempo e venceria a conta com um número falso, desenhando uma
   * seta sobre um veículo que nem está na tela.
   */
  expectedUnit(route: number, pass: number): number | null {
    const rota = this.network.routes[route];
    const entrada = rota?.table[pass];
    if (!rota || !entrada) return null;
    const dwell = this.network.services[rota.service].dwell;
    let best: number | null = null;
    let menor = Infinity;
    for (let i = 0; i < this.units.length; i++) {
      const u = this.units[i];
      if (!u.live || !this.lida[i] || u.route !== route) continue;
      const encostado = u.phase >= entrada.time && u.phase <= entrada.time + dwell;
      const falta = encostado ? 0 : mod(entrada.time - u.phase, rota.cycle);
      if (falta < menor) {
        menor = falta;
        best = i;
      }
    }
    return best;
  }

  /**
   * A unidade com a porta aberta para quem está a pé, ou `null`. É o embarque do horário, não
   * do asfalto: um ônibus que passa sem parar não abre porta, e quem já vai a bordo de um
   * veículo não embarca em outro.
   *
   * Dois modos de ter a porta aberta, porque o ônibus encosta no tile de faixa da esquina e o
   * marco da parada é o passeio daquela caixa — no canto diagonal de um cruzamento são quase
   * cinco tiles de asfalto entre os dois. Estar ao lado do veículo usa o alcance da porta
   * (`BOARDING_REACH`); estar no ponto usa a **zona de embarque daquela calçada**
   * (`TransportStation.ponto`), os tiles de passeio contínuo em que se espera o ônibus, limitada
   * pelo alcance físico da porta (`BOARDING_DOOR`). A zona é medida a pé desde o marco, e é
   * exatamente o que se pinta no chão: quem está no outro lado da avenida não embarca por
   * telepatia, e quem está na marquise embarca de qualquer canto dela — inclusive do canto da
   * esquina, onde a régua em linha reta de antes deixava o jogador batendo num ônibus parado a
   * quatro tiles dele.
   *
   * Na quadra exclusiva da rodoviária a régua aperta, e tem de apertar: lá cada linha tem a sua
   * **plataforma**, e a porta abre só para quem está na plataforma daquela linha. Dois ônibus
   * param no pátio um atrás do outro, a dois tiles de calçada um do outro, e sem a baia o
   * passageiro que escolheu a Linha 3 no telão embarcaria na Linha 7 porque ela encostou primeiro
   * — que é justamente o engano que a numeração das plataformas existe para impedir.
   */
  boarding(player: Player): number | null {
    if (isAboard(player)) return null;
    let best = -1;
    let bestD = BOARDING_DOOR ** 2;
    for (let i = 0; i < this.units.length; i++) {
      const u = this.units[i];
      if (!u.live || !u.stopped || u.parked) continue;
      const d = (player.x - u.x) ** 2 + (player.y - u.y) ** 2;
      if (d >= bestD) continue;
      const parada = this.stopStation(u);
      const station = parada >= 0 ? this.network.stations[parada] : null;
      if (!station) continue;
      const baia = plataformaDaLinha(this.network, station.id, u.route);
      if (baia) {
        if (!naPlataforma(baia, player.x, player.y)) continue;
      } else if (d > BOARDING_REACH ** 2 && !noPonto(station, player.x, player.y)) {
        continue;
      }
      bestD = d;
      best = i;
    }
    return best < 0 ? null : best;
  }

  /** A unidade que leva o jogador, ou `null` se ele está a pé ou num carro. */
  aboard(player: Player): TransportUnit | null {
    return player.busUnit === null ? null : this.units[player.busUnit];
  }

  /** Embarca: a partir daqui quem manda na posição do jogador é o horário daquela unidade. */
  board(player: Player, index: number): void {
    const u = this.units[index];
    if (!u || !u.live || !u.stopped || u.parked) return;
    player.busUnit = index;
    player.state = 'driving';
    player.speed = 0;
    player.vx = 0;
    player.vy = 0;
    player.swimming = false;
    player.direction = u.dir;
    player.facingAngle = u.angle;
  }

  /**
   * Copia a unidade para o jogador. Chama-se depois do `update`, com o horário do tick já
   * lido: o passageiro não tem física própria, e integrar um `dt` dele faria o corpo atrasar
   * em relação ao ônibus um pouco a cada quadro.
   */
  ride(player: Player): void {
    const u = this.aboard(player);
    if (!u) return;
    player.x = u.x;
    player.y = u.y;
    player.direction = u.dir;
    player.facingAngle = u.angle;
    player.speed = 0;
    player.vx = 0;
    player.vy = 0;
    player.swimming = false;
  }

  /**
   * A porta só abre na calçada: desembarcar em movimento seria um teletransporte disfarçado,
   * exatamente o que a rede de transporte proíbe. Quando ela abre, o corpo pisa o passeio da
   * parada em que o ônibus encostou — não o ponto do asfalto onde ele está parado.
   */
  alight(player: Player, map: Map, collision: CollisionSystem): boolean {
    const u = this.aboard(player);
    if (!u) return false;
    if (!u.stopped) return false;
    const station = this.network.stations[this.network.routes[u.route].stops[u.stop].station];
    // Desembarcar é pisar a plataforma de quem desce, não o marco da calçada: no pátio o marco
    // é a beirada do virador, e fazer o passageiro da Linha 3 aparecer na Plataforma da Linha 7
    // seria o mesmo desfecho errado do embarque — a placa e o chão contando histórias
    // diferentes. Numa calçada de rua não há baia, e o marco é o passeio certo mesmo.
    const baia = plataformaDaLinha(this.network, station.id, u.route);
    const alvo = baia ?? station;
    player.busUnit = null;
    player.state = 'idle';
    player.direction = u.dir;
    player.facingAngle = u.angle;
    const c = { x: alvo.x, y: alvo.y, radius: GAME_CONFIG.PLAYER_RADIUS };
    collision.resolveCircle(c, map.queryNearby(c.x, c.y, 1.8));
    player.x = Math.max(c.radius, Math.min(map.worldW - c.radius, c.x));
    player.y = Math.max(c.radius, Math.min(map.worldH - c.radius, c.y));
    return true;
  }
}
