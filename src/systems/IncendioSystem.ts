import { GAME_CONFIG, type Biome, type TileKind } from '../game/GameConfig';
import type { Landmark, Map } from '../world/Map';
import { createNPC, type NPC } from '../entities/NPC';
import { isAboard, type Player } from '../entities/Player';
import { createVehicle, type Vehicle } from '../entities/Vehicle';
import { VEHICLE_DEFS } from '../data/vehicles';
import { sound } from '../audio/SoundManager';
import type { Wreck } from './DestructionSystem';
import type { CollisionSystem } from './CollisionSystem';
import {
  apontaViatura, deslizaViatura, esqueceARota, linhaLivre, passaAndando, pontoDeSaída, rotaNova,
  waypoint, direçãoDoPasso, type Ponto, type Rota,
} from './Pilotagem';

/**
 * O fogo do mundo — e quem vem apagá-lo.
 *
 * Até aqui o fogo deste jogo era uma **consequência de um quadro**: o carro batia, explodia, e a
 * bola de fogo do `WreckSprite` durava sete segundos sobre a carcaça. Nada depois disso. Uma
 * cidade onde um incêndio não come, não alastra e não tem ninguém para combatê-lo é um efeito
 * especial, e é por isso que este arquivo existe: o incêndio vira um **lugar** com estado próprio
 * (tem o que queimar, cresce, machuca, passa para o vizinho e morre quando acaba o combustível) e
 * o corpo de bombeiros vira uma **rotina** (frota parada no quartel do mapa, chamada, asfalto até
 * perto, mangueira até o fogo, água, volta).
 *
 * A régua inteira foi escolhida para caber na cidade:
 * — **um fogo urbano médio queima de 45 s a 95 s** sem ninguém, e um bombeiro com água leva
 *   ~12 s por homem para derrubar uma boca cheia. Ou seja: quem chega em 20 s salva o lugar, quem
 *   chega em 40 s molha cinza. É isso que faz o tempo de resposta ser uma mecânica e não um texto.
 * — **a água acaba.** O tanque do caminhão é o que manda, não a vontade do sistema: sem tanque a
 *   tripulação recolhe a linha, volta ao quartel, enche e só então atende outra ocorrência. Sem
 *   isso o incêndio seria um temporizador e o caminhão, um enfeite que dirige.
 * — **nem todo fogo é atendível.** O caminhão precisa de asfalto a `ALCANCE_DA_PARADA` tiles do
 *   fogo; um incêndio no meio do matagal, sem rua perto, não tem brigada — queima e se apaga
 *   sozinho. É a diferença entre um mundo com regras e um mundo com teletransporte.
 * — **o fogo passa para o vizinho.** Um carro aceso acende o carro ao lado, um mato aceso acende o
 *   mato na direção do vento. É o que faz um incêndio pequeno virar um problema grande se ninguém
 *   vier, e é também o que faz a explosão do seu próprio carro ter consequência depois do clarão.
 * — **a chuva molha.** O `chuva` que o `GameState` entrega é o mesmo número que pinta o céu:
 *   tempestade consome o combustível mais rápido e derruba o teto da chama, então um mundo
 *   chuvoso pega fogo menos. Ninguém precisa apagar o que a chuva já apagou.
 */

/** Boca mínima de um fogo aceso — o ponto em que ele já existe mas ainda não ameaça nada. */
const RAIO_MÍNIMO = 0.55;
/**
 * Teto de uma boca urbana. 3,4 tiles é maior que um lote de casa e menor que uma quadra: um fogo
 * que encosta nesse teto cobre o quarteirão em que você entrou, que é exatamente o susto pedido.
 */
const RAIO_TETO = 3.4;
/** Tiles por segundo de crescimento (lento, para dar tempo de reagir) e de queda sob a água. */
const CRESCIMENTO = 0.3;
const QUEDA = 0.85;

/**
 * Combustível por fonte, em fração por segundo: `1/50` significa que aquela boca, sozinha, queima
 * cinquenta segundos de material cheio. O carro é rápido porque é tanque e plástico; o mato é
 * lento porque é área; o raio é médio porque acende a serrapilheira de um ponto só.
 */
const CONSUMO_DA_FONTE: Record<FonteDoFogo, number> = {
  carro: 1 / 50,
  mato: 1 / 95,
  raio: 1 / 70,
};
/** Chuva forte (1,0) mais que triplica o consumo e derruba 45% do teto da chama. */
const CHUVA_NO_CONSUMO = 2.3;
const CHUVA_NO_RAIO = 0.45;
/** A partir desta força o fogo é um incidente, não uma vela: alarme, dano sério, alastre. */
const FORÇA_DO_INCIDENTE = 0.3;

const FOGO_DANO_JOGADOR = 24;
const FOGO_DANO_NPC = 30;
/** O bombeiro tem equipamento: é 1/8 do pedestre. Ele aguenta, mas não é de bronze. */
const FOGO_DANO_BOMBEIRO = 4;
const FOGO_DANO_CARRO = 16;
/** A pessoa carbonizada na fogueira do fogo morre depois de aguentar isto de dano além do chão. */
const MORTE_POR_QUEIMADURA = 34;

/** O fogo leva este tempo pegando corpo antes de tentar passar para o vizinho, e tenta a cada… */
const IDADE_DO_ALASTRE = 5;
const INTERVALO_DO_ALASTRE = 7;
/** …tiles além da própria boca ele alcança um vizinho. Um palmo de chama não acende nada. */
const ALCANCE_DO_ALASTRE = 1.1;

/** Um incêndio urbano deste tamanho é um evento; dez deles ao mesmo tempo é um mapa quebrado. */
const MAX_FOGOS = 8;

// ---- a brigada ----
/** Caminhões por quartel. Com um só, a cidade tem uma chance por incêndio — e é assim que é. */
const FROTA_POR_QUARTEL = 1;
const TRIPULAÇÃO = 3;
/** Tiles do asfalto até o fogo para o caminhão conseguir parar: acima disso, ninguém atende. */
const ALCANCE_DA_PARADA = 6.5;
/** O caminhão estaciona quando está a esta distância do ponto de parada. */
const PAROU_A_DISTÂNCIA = 1.3;
/** Comprimento máximo da linha de mangueira a partir do caminhão. */
const MANGUEIRA = 9;
/** Distance, do corpo do bombeiro até a boca do fogo, em que o jato ainda chega. */
const JATO = 3;
/** Fração do tanque por bombeiro por segundo de jato aberto: ~3 homens × 18 s esvaziam o caminhão. */
const VAZÃO = 0.018;
/** Tanque cheio no quartel em ~6 s parado: o suficiente para a volta ao fogo ter espera, sem ser
 *  castigo — ninguém aprende nada olhando um caminhão estacionado encher a bomba por vinte segundos. */
const RECARREGA = 1 / 6;
const PASSO_DO_BOMBEIRO = 2.1;
const PASSO_DO_CAMINHÃO = 3.2;
/** Um caminhão perdido (roubado, explodido) volta ao quartel depois disto: o quartel repõe. */
const REPOSIÇÃO_S = 50;

export type FonteDoFogo = 'carro' | 'mato' | 'raio';

/** Um incêndio no mundo: um lugar com combustível, não um sprite. */
export interface Fogo {
  readonly id: number;
  x: number;
  y: number;
  /** tiles de boca acesa. */
  raio: number;
  /** 0..1: o que ainda tem para queimar aí. Acabou o combustível, o fogo morre. */
  combustível: number;
  /** 0..1: a altura da chama agora — o que machuca, o que alastra e o que se desenha. */
  força: number;
  fonte: FonteDoFogo;
  /** O carro que arde aqui, enquanto ele ainda estiver em cima do fogo. */
  veículo: number | null;
  /** Quantos bombeiros estão com a linha aberta nele agora (0 quando ninguém). */
  atacado: number;
  idade: number;
  /** O ponto de asfalto de onde a brigada trabalha; `null` = fogo sem rua perto, não atendível. */
  parada: Ponto | null;
  /** id da viatura empenhada — um caminhão por fogo, porque dois mangueiram no mesmo ponto. */
  viatura: number | null;
  /** O próximo instante em que ele tenta passar para um vizinho. */
  alastre: number;
}

type ModoDaViatura = 'quartel' | 'a caminho' | 'em terra' | 'reabastecendo' | 'de volta';

interface Viatura extends Rota {
  vehicleId: number;
  home: Ponto;
  /** id do quartel de origem: é o que a HUD nomeia quando diz "destacamento do Centro". */
  quartel: string;
  crew: number[];
  modo: ModoDaViatura;
  fogo: number | null;
  /** ponto de asfalto escolhido perto do fogo, recalculado a cada atribuição. */
  parada: Ponto | null;
  /** 0..1 do tanque. */
  água: number;
  stuckTimer: number;
}

interface Bombeiro extends Rota {
  npcId: number;
  viatura: number;
  /** O posto de trabalho ao redor da boca do fogo, distribuído entre a tripulação. */
  posto: Ponto | null;
}

export interface IncendioContext {
  map: Map;
  player: Player;
  vehicles: Vehicle[];
  npcs: NPC[];
  collision: CollisionSystem;
  /**
   * Os cascos do `DestructionSystem`: todo carro que explode aqui em cima vira um incêndio de
   * verdade. É a fonte primária da cidade, e é por isso que a lista entra inteira no contexto — o
   * fogo não pode ser um callback que o explosivo precisa lembrar de disparar, senão cada
   * caminho novo de explosão esqueceria o incêndio.
   */
  wrecks: readonly Wreck[];
  /** Intensidade de chuva (`weather.intensity + hazard.wet`): a mesma água que molha o chão apaga fogo. */
  chuva: number;
  time: number;
  /** O `HealthSystem.damage` do jogador, aplicado ao mesmo objeto que este sistema move. */
  dano: (amount: number) => void;
  shake: (amount: number) => void;
  allocVehicleId: () => number;
  allocNpcId: () => number;
  onStructChange: () => void;
  rng: () => number;
}

/** O que arde depende do chão: asfalto e concreto não pegam, mato sim, e o tipo de mato importa. */
const COMBUSTÍVEL_DO_BIOMA: Partial<Record<Biome, number>> = {
  forest: 1,
  pinewood: 0.95,
  savanna: 0.85,
  countryside: 0.8,
  park: 0.75,
  beach: 0.35,
  desert: 0.25,
  residential: 0.6,
  suburb: 0.6,
  commercial: 0.5,
  industrial: 0.5,
  downtown: 0.45,
  market: 0.5,
  docks: 0.45,
};

function inflamável(map: Map, x: number, y: number): number {
  const chão: TileKind | null = map.tileKindAt(x, y);
  if (chão === 'water' || chão === 'concrete' || chão === 'road' || chão === null) return 0;
  const biome = map.biomeAt(x, y);
  const base = biome ? COMBUSTÍVEL_DO_BIOMA[biome] ?? 0.5 : 0;
  // Serra e areia não seguram brasa: o fogo rasteiro precisa de capim, e um raio no rochedo
  // simplesmente não acende — é a diferença entre um mapa temático e um mapa que obedece o chão.
  return chão === 'dirt' ? base * 0.4 : base;
}

export class IncendioSystem {
  readonly fogos: Fogo[] = [];
  readonly viaturas: Viatura[] = [];
  readonly bombeiros: Bombeiro[] = [];
  /** O maior incêndio vivo agora, para a HUD dizer "tem fogo em algum lugar" antes de ver. */
  perigo = 0;
  private próximoId = 1;
  private initialized = false;
  private reposiçãoTimer = 0;
  /** Segundos até o próximo "shhh" da linha: o jato é uma presença, não uma metralhadora d'água. */
  private somDeJato = 0;
  /** Ritmo da sirene no canal `alarme`, igual ao da polícia: volume escrito por fração de segundo, não por tick. */
  private sireneTimer = 0;
  /** Último volume escrito no alto-falante; `-1` é "ainda não escrevemos nada", então a mudez também grava. */
  private sireneVolume = -1;
  /**
   * Cascos já convertidos em fogo. É um `WeakSet` e não uma lista de chaves: o `Wreck` é o objeto
   * que o `DestructionSystem` criou e é o objeto que ele joga fora, então a marca some junto com o
   * casco sem nunca crescer com a sessão — e sem depender de coordenada, que é como dois carros
   * explodindo no mesmo tile virariam um fogo só.
   */
  private readonly cobrados = new WeakSet<Wreck>();

  init(ctx: IncendioContext): void {
    if (this.initialized) return;
    this.initialized = true;
    for (const quartel of ctx.map.landmarksOf('firestation')) this.armaQuartel(quartel, ctx);
    ctx.onStructChange();
  }

  /**
   * Um raio cai perto de quem ouve o trovão. Escolhe um ponto inflamável numa coroa em volta do
   * jogador — nunca em cima dele — e devolve o fogo criado, ou `null` quando o céu caiu em
   * asfalto, água ou rocha: um mundo em que relâmpago sempre incendeia é um mundo com chão
   * decorativo.
   */
  descarga(ctx: IncendioContext): Fogo | null {
    const ângulo = ctx.rng() * Math.PI * 2;
    for (let tentativa = 0; tentativa < 6; tentativa++) {
      const distância = 26 + tentativa * 8 + ctx.rng() * 6;
      const x = ctx.player.x + Math.cos(ângulo) * distância;
      const y = ctx.player.y + Math.sin(ângulo) * distância;
      if (inflamável(ctx.map, x, y) <= 0.25) continue;
      return this.acende(x, y, 'raio', null, ctx);
    }
    return null;
  }

  /**
   * Acende um incêndio num ponto do mundo. É a única porta de entrada de fogo novo, e é pública
   * de propósito: a missão, o cheat e a explosão de um carro têm de atravessar a mesma régua de
   * combustível, de atendimento e de teto — um `IncêndioSystem` com dois caminhos de ignição
   * diferentes daria dois mundos diferentes.
   */
  acende(x: number, y: number, fonte: FonteDoFogo, veículo: number | null, ctx: IncendioContext): Fogo | null {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    if (this.fogos.length >= MAX_FOGOS) return null;
    if (ctx.map.isWaterWorld(x, y)) return null;
    const combustível = fonte === 'carro' ? 1 : inflamável(ctx.map, x, y);
    // Um ponto sem material não segura fogo: é isto que impede um raio no meio da avenida de
    // virar um incêndio de 90 segundos sobre concreto.
    if (combustível <= 0) return null;
    const fogo: Fogo = {
      id: this.próximoId++, x, y, raio: RAIO_MÍNIMO,
      // O combustível inicial é o chão, não um número de dificuldade: um mato alto queima o
      // dobro do tempo de um quintal aparado, e isso é o que faz o incêndio ser daquele lugar.
      combustível, força: RAIO_MÍNIMO / RAIO_TETO, fonte, veículo, atacado: 0, idade: 0,
      parada: this.pontoDeParada(x, y, ctx), viatura: null,
      // O relógio do mundo é absoluto (`ctx.time` nunca volta a zero); uma idade relativa nasceria
      // no passado e o fogo alastraria no primeiro tick, antes de pegar corpo.
      alastre: ctx.time + IDADE_DO_ALASTRE,
    };
    this.fogos.push(fogo);
    // Só o carro que explode faz barulho: é o mesmo clarão que o `WreckSprite` mostra. Um raio no
    // mato não tem estampido — o trovão já tocou lá fora, no `WeatherSystem` — e fogo silencioso
    // crescendo na mata é exatamente como ele aparece na vida real.
    if (fonte === 'carro') {
      sound.play('explosion', 0.3);
      ctx.shake(0.25);
    }
    return fogo;
  }

  /** O incêndio mais perto deste ponto, ou `null` se não há fogo atendível por perto. */
  incêndioMaisPerto(x: number, y: number): Fogo | null {
    let melhor: Fogo | null = null;
    let distância = Infinity;
    for (const f of this.fogos) {
      const d = Math.hypot(f.x - x, f.y - y);
      if (d < distância) { distância = d; melhor = f; }
    }
    return melhor;
  }

  stats(): { fogos: number; incidentes: number; viaturas: number; bombeiros: number; água: number } {
    let água = 0;
    for (const u of this.viaturas) água += u.água;
    return {
      fogos: this.fogos.length,
      incidentes: this.fogos.filter((f) => f.força >= FORÇA_DO_INCIDENTE).length,
      viaturas: this.viaturas.length,
      bombeiros: this.bombeiros.length,
      água: água / Math.max(1, this.viaturas.length),
    };
  }

  update(dt: number, ctx: IncendioContext): void {
    if (!Number.isFinite(dt) || dt <= 0) return;
    this.init(ctx);
    this.colheCascos(ctx);
    for (let i = this.fogos.length - 1; i >= 0; i--) this.queima(this.fogos[i], dt, ctx);
    this.despacha(ctx);
    // `conduz` pode baixar o caminhão (carjack, a própria lataria em chamas) e `trabalha` pode
    // riscar um nome da folha (morte em serviço): percorrer a lista viva enquanto ela encolhe pularia
    // o próximo da fila — e o próximo é justamente o que está atendendo o outro fogo.
    for (const u of this.viaturas.slice()) this.conduz(dt, u, ctx);
    // A contagem de linhas abertas é por tick: sem zerar aqui, `atacado` cresceria para sempre e o
    // "fogo atacado por três homens" viraria um número sem significado para o render e para o som.
    for (const f of this.fogos) f.atacado = 0;
    for (const b of this.bombeiros.slice()) this.trabalha(dt, b, ctx);
    this.ruidoDaLinha(dt);
    this.repõe(dt, ctx);
    this.alarme(dt, ctx);
    this.perigo = this.fogos.reduce((m, f) => Math.max(m, f.força), 0);
  }

  /** Todo casco novo do `DestructionSystem` é um incêndio de carro no mesmo lugar. */
  private colheCascos(ctx: IncendioContext): void {
    for (const w of ctx.wrecks) {
      if (this.cobrados.has(w)) continue;
      this.cobrados.add(w);
      this.acende(w.x, w.y, 'carro', null, ctx);
    }
  }

  private queima(f: Fogo, dt: number, ctx: IncendioContext): void {
    const chuva = Math.max(0, ctx.chuva);
    f.idade += dt;
    // Um carro que saiu de cima do fogo não alimenta mais nada: ele levava a chama embora, e o
    // que fica no asfalto é o que já estava queimando ali.
    if (f.veículo !== null) {
      const v = ctx.vehicles.find((c) => c.id === f.veículo);
      if (!v || v.state === 'destroyed' || Math.hypot(v.x - f.x, v.y - f.y) > f.raio + 1) f.veículo = null;
    }

    const alvo = RAIO_MÍNIMO + (RAIO_TETO - RAIO_MÍNIMO) *
      Math.sqrt(Math.max(0, f.combustível)) * (1 - Math.min(0.55, chuva * CHUVA_NO_RAIO));
    const passo = (alvo > f.raio ? CRESCIMENTO : QUEDA) * dt;
    f.raio += Math.sign(alvo - f.raio) * Math.min(Math.abs(alvo - f.raio), passo);
    f.combustível = Math.max(0, f.combustível - dt * CONSUMO_DA_FONTE[f.fonte] * (1 + chuva * CHUVA_NO_CONSUMO));
    f.força = Math.min(1, f.raio / RAIO_TETO);

    this.machuca(f, dt, ctx);
    this.alastra(f, ctx);

    if (f.combustível <= 0) {
      const i = this.fogos.indexOf(f);
      if (i >= 0) this.fogos.splice(i, 1);
      // O fogo apagado não prende mais ninguém: solta a viatura antes que ela molhe cinza.
      const u = this.viaturas.find((c) => c.fogo === f.id);
      if (u) { u.fogo = null; esqueceARota(u); }
    }
  }

  private machuca(f: Fogo, dt: number, ctx: IncendioContext): void {
    if (f.força < 0.08) return;
    const raio = f.raio;
    const player = ctx.player;
    // Dentro de um carro o corpo está atrás da lataria: é o carro que queima, e a lataria
    // explodindo é o que chega nele. Fora dele, é a pele.
    if (!isAboard(player) && Math.hypot(player.x - f.x, player.y - f.y) < raio) {
      ctx.dano(FOGO_DANO_JOGADOR * f.força * dt);
      if (f.força > FORÇA_DO_INCIDENTE) ctx.shake(0.06 * f.força);
    }
    for (const npc of ctx.npcs) {
      if (npc.dead || npc.inVehicle) continue;
      const d = Math.hypot(npc.x - f.x, npc.y - f.y);
      if (d > raio) continue;
      const equipamento = npc.kind === 'bombeiro' ? FOGO_DANO_BOMBEIRO : npc.kind === 'cop' ? FOGO_DANO_NPC * 0.5 : FOGO_DANO_NPC;
      this.fereNpc(npc, equipamento * f.força * dt);
    }
    for (const v of ctx.vehicles) {
      if (v.state === 'destroyed' || v.health <= 0 || v.altitude > 0.5) continue;
      const d = Math.hypot(v.x - f.x, v.y - f.y);
      if (d > raio + Math.max(v.def.footprintW, v.def.footprintH) / 2) continue;
      // O carro que é a fonte do fogo queima o dobro: é ele o combustível daquele lugar.
      v.health -= FOGO_DANO_CARRO * f.força * dt * (v.id === f.veículo ? 2 : 1);
    }
  }

  /**
   * Queimar até cair é diferente de queimar até morrer. O pedestre a zero vai para o chão com a
   * queimadura aberta — é a janela que o SAMU (#235) tem para existir — e só vira corpo depois de
   * aguentar `MORTE_POR_QUEIMADURA` de dano além disso. Um fogo que só mata não gera resgate.
   */
  private fereNpc(npc: NPC, amount: number): void {
    npc.health -= amount;
    if (npc.health > 0) return;
    if (npc.health > -MORTE_POR_QUEIMADURA && npc.state !== 'knocked') {
      npc.state = 'knocked';
      npc.downTimer = Math.max(npc.downTimer, 6);
      npc.speed = 0;
      npc.anim = 'idle';
      return;
    }
    if (npc.health <= -MORTE_POR_QUEIMADURA) {
      npc.health = 0;
      npc.dead = true;
      npc.state = 'dead';
      // O corpo de um bombeiro morto em serviço é devolvido ao sistema de vida como civil: é
      // assim que o `LifeSystem` o recicla e a população não vaza com a sessão.
      if (npc.kind === 'bombeiro') npc.kind = 'civ';
    }
  }

  /** Chama alta em material vizinho = fogo novo. Um carro acende o carro, um mato acende o mato. */
  private alastra(f: Fogo, ctx: IncendioContext): void {
    if (f.força < FORÇA_DO_INCIDENTE || ctx.time < f.alastre) return;
    f.alastre = ctx.time + INTERVALO_DO_ALASTRE;
    const carro = ctx.vehicles.find((v) => v.state !== 'destroyed' && v.health > 0 && v.altitude <= 0.5 &&
      !this.fogos.some((o) => o.veículo === v.id) &&
      Math.hypot(v.x - f.x, v.y - f.y) < f.raio + ALCANCE_DO_ALASTRE);
    if (carro) {
      const novo = this.acende(carro.x, carro.y, 'carro', carro.id, ctx);
      if (novo) { novo.raio = RAIO_MÍNIMO + 0.2; novo.combustível = 1; return; }
    }
    if (f.fonte === 'carro') return;
    // Rastejamento para o lado: sorteia uma direção e anda um passo além da própria boca. Sem
    // isso o fogo seria um círculo que encolhe no centro; com ele, um incêndio de mato *avança*.
    const ângulo = ctx.rng() * Math.PI * 2;
    const passo = f.raio + ALCANCE_DO_ALASTRE * (0.6 + ctx.rng() * 0.9);
    const x = f.x + Math.cos(ângulo) * passo;
    const y = f.y + Math.sin(ângulo) * passo;
    if (inflamável(ctx.map, x, y) < inflamável(ctx.map, f.x, f.y) * 0.6) return;
    this.acende(x, y, f.fonte === 'raio' ? 'mato' : f.fonte, null, ctx);
  }

  /**
   * O asfalto de onde a linha trabalha: o nó de rua mais perto, deslocado para a faixa, aceitando
   * só quem está a `ALCANCE_DA_PARADA` tiles do fogo. Acima disso a brigada não tem como chegar —
   * e é isto que faz um incêndio no matagal fundo queimando sozinho parecer a regra do lugar, não
   * um bug de pathfinding.
   */
  private pontoDeParada(x: number, y: number, ctx: IncendioContext): Ponto | null {
    const i = ctx.map.nearestRoadNode(x, y);
    const nó = ctx.map.roadNodes[i];
    if (!nó) return null;
    const distância = Math.hypot(nó.x - x, nó.y - y);
    if (distância > ALCANCE_DA_PARADA) return null;
    const faixa = ctx.map.laneAt(nó.x, nó.y);
    return {
      x: nó.x + (faixa === 'NE' ? 1.1 : faixa === 'SW' ? -1.1 : 0),
      y: nó.y + (faixa === 'SE' ? 1.1 : faixa === 'NW' ? -1.1 : 0),
    };
  }

  /**
   * Um caminhão por quartel, parado no asfalto em frente à porta, com tripulação dentro. É o
   * mesmo desenho da frota da polícia — vaga a menos de 10 tiles da frente do prédio, fora da
   * calçada, longe de parede e de outro veículo — porque um quartel tem de ter o veículo *visível*
   * na porta: é assim que o jogador descobre que existe bombeiro neste mapa antes de queimar algo.
   */
  private armaQuartel(quartel: Landmark, ctx: IncendioContext): void {
    for (let slot = 0; slot < FROTA_POR_QUARTEL; slot++) {
      const spot = this.vagaDoQuartel(quartel, ctx);
      if (!spot) continue;
      const def = VEHICLE_DEFS.firetruck;
      const v = createVehicle(ctx.allocVehicleId(), def, '', spot.x, spot.y, spot.lane ?? 'SE');
      v.health = 180;
      v.occupied = true;
      v.state = 'parked';
      ctx.vehicles.push(v);
      const u: Viatura = { ...rotaNova(), vehicleId: v.id, home: { x: spot.x, y: spot.y },
        quartel: quartel.key, crew: [], modo: 'quartel', fogo: null, parada: null, água: 1, stuckTimer: 0 };
      this.viaturas.push(u);
      for (let seat = 0; seat < TRIPULAÇÃO; seat++) {
        // `createNPC` já dá ao bombeiro a saúde de equipamento: é o mesmo número que o incêndio
        // usa para saber quanto tempo ele aguenta em cima da boca.
        const npc = createNPC(ctx.allocNpcId(), 'a', spot.x, spot.y, 'bombeiro', ctx.rng);
        npc.inVehicle = true;
        npc.vehicleId = v.id;
        ctx.npcs.push(npc);
        u.crew.push(npc.id);
        this.bombeiros.push({ ...rotaNova(), npcId: npc.id, viatura: v.id, posto: null });
      }
    }
  }

  private vagaDoQuartel(quartel: Landmark, ctx: IncendioContext):
    (Ponto & { lane: ReturnType<Map['laneAt']> }) | null {
    const candidatos = ctx.map.roadNodes
      .filter((p) => Math.hypot(p.x - quartel.front.x, p.y - quartel.front.y) < 10)
      .map((node) => {
        const lane = ctx.map.laneAt(node.x, node.y);
        return { x: node.x + (lane === 'NE' ? 1.1 : lane === 'SW' ? -1.1 : 0),
          y: node.y + (lane === 'SE' ? 1.1 : lane === 'NW' ? -1.1 : 0), lane };
      })
      .filter((p) => !!p.lane && ctx.map.tileKindAt(p.x, p.y) !== 'road')
      .sort((a, b) => Math.hypot(a.x - quartel.front.x, a.y - quartel.front.y) -
        Math.hypot(b.x - quartel.front.x, b.y - quartel.front.y));
    for (const p of candidatos) {
      const circle = { ...p, radius: 1.15 };
      if (!ctx.map.isInside(p.x, p.y, circle.radius) || ctx.map.isWaterWorld(p.x, p.y)) continue;
      if (ctx.collision.overlapsAny(circle, ctx.map.queryNearby(p.x, p.y, 2.5))) continue;
      if (ctx.vehicles.some((other) => Math.hypot(other.x - p.x, other.y - p.y) < 2.6)) continue;
      return p;
    }
    return null;
  }

  /** Um fogo por caminhão livre, do mais forte para o mais perto. Sem estoquista de ocorrência. */
  private despacha(ctx: IncendioContext): void {
    const livres = this.viaturas.filter((u) => u.modo === 'quartel');
    if (!livres.length) return;
    // Só atende incêndio de verdade: a boca recém-acesa ainda é uma vela, e mandar um caminhão com
    // três homens para cada fogueira de quintal esvaziaria a cidade inteira de brigada.
    const alvos = this.fogos
      .filter((f) => f.parada && f.viatura === null && f.força >= FORÇA_DO_INCIDENTE)
      .sort((a, b) => b.força - a.força);
    for (const f of alvos) {
      let melhor: Viatura | null = null;
      let distância = Infinity;
      for (const u of livres) {
        if (u.fogo !== null) continue;
        const v = this.vehicle(ctx, u.vehicleId);
        if (!v || !this.operacional(u, ctx)) continue;
        const d = Math.hypot(v.x - f.x, v.y - f.y);
        if (d < distância) { distância = d; melhor = u; }
      }
      if (!melhor) return;
      melhor.modo = 'a caminho';
      melhor.fogo = f.id;
      melhor.parada = f.parada;
      esqueceARota(melhor);
      f.viatura = melhor.vehicleId;
    }
  }

  private vehicle(ctx: IncendioContext, id: number) { return ctx.vehicles.find((v) => v.id === id); }
  private npc(ctx: IncendioContext, id: number) { return ctx.npcs.find((n) => n.id === id); }
  private fogo(id: number | null) { return id === null ? null : this.fogos.find((f) => f.id === id) ?? null; }

  /** Tripulação viva e lataria inteira: um caminhão carbonizado não atende ninguém. */
  private operacional(u: Viatura, ctx: IncendioContext): boolean {
    const v = this.vehicle(ctx, u.vehicleId);
    return !!v && v.health > 0 && v.state !== 'destroyed' && ctx.player.currentVehicleId !== v.id &&
      u.crew.some((id) => {
        const n = this.npc(ctx, id);
        return !!n && !n.dead && n.health > -MORTE_POR_QUEIMADURA;
      });
  }

  private conduz(dt: number, u: Viatura, ctx: IncendioContext): void {
    const v = this.vehicle(ctx, u.vehicleId);
    if (!v) return;
    const fogo = this.fogo(u.fogo);
    // Roubaram ou explodiu a viatura: a tripulação desce, a ocorrência volta para a fila e o
    // quartel repõe o caminhão. Sem isto um único carjack encerrava o corpo de bombeiros.
    if (v.state === 'destroyed' || ctx.player.currentVehicleId === v.id ||
      !u.crew.some((id) => !this.npc(ctx, id)?.dead)) {
      this.baixa(u, ctx, !!fogo);
      return;
    }
    const crew = u.crew.map((id) => this.npc(ctx, id)).filter((n): n is NPC => !!n);

    if (u.modo === 'quartel') {
      if (fogo) { u.modo = 'a caminho'; esqueceARota(u); }
      else { v.speed = 0; v.state = 'parked'; return; }
    }

    if (u.modo === 'a caminho') {
      // O fogo se apagou (ou a chuva apagou) no meio do caminho: vai para casa, não molhar cinza.
      if (!fogo || !u.parada) { u.modo = 'de volta'; esqueceARota(u); return; }
      const meta = u.parada;
      const target = waypoint(u, v, meta, dt, ctx.map, ctx.rng, false, false);
      const dx = target.x - v.x, dy = target.y - v.y, distância = Math.hypot(dx, dy);
      if (distância < 0.05) { u.stuckTimer += dt; if (u.stuckTimer > 3) esqueceARota(u); return; }
      apontaViatura(v, dx, dy);
      v.speed = Math.min(PASSO_DO_CAMINHÃO, v.speed + GAME_CONFIG.VEHICLE_ACCEL * dt, distância / dt);
      v.state = 'driving';
      const antes = { x: v.x, y: v.y };
      deslizaViatura(v, ctx.map, ctx.collision, ctx.vehicles, dx / distância * v.speed, dy / distância * v.speed, dt);
      if (Math.hypot(v.x - antes.x, v.y - antes.y) < v.speed * dt * 0.15) {
        u.stuckTimer += dt;
        if (u.stuckTimer > 1) esqueceARota(u);
      } else u.stuckTimer = 0;
      for (const n of crew) if (n.inVehicle) { n.x = v.x; n.y = v.y; n.lastX = v.x; n.lastY = v.y; }
      if (Math.hypot(v.x - meta.x, v.y - meta.y) <= PAROU_A_DISTÂNCIA) {
        v.speed = 0;
        v.state = 'parked';
        this.desce(u, ctx);
        u.modo = 'em terra';
      }
      return;
    }

    if (u.modo === 'em terra') {
      v.speed = 0;
      v.state = 'parked';
      // A boca muda de tamanho todo segundo — cresce, a chuva derruba, o jato fecha. Os postos
      // acompanham: um homem parado a três tiles de um fogo que encolheu está molhando ar.
      if (fogo) this.espalhaPostos(u, ctx);
      // Sem fogo, sem água ou sem ninguém em pé na linha: recolhe e embarca. A ordem é esta porque
      // o tanque é o que manda — um caminhão seco volta para encher, não fica molhando cinza.
      const semÁgua = u.água <= 0;
      const semLinha = !this.bombeiros.some((b) => {
        if (b.viatura !== u.vehicleId) return false;
        const n = this.npc(ctx, b.npcId);
        return !!n && !n.dead && n.state !== 'knocked';
      });
      if (!fogo || semÁgua || semLinha) {
        if (this.embarca(u, dt, ctx)) u.modo = semÁgua && fogo ? 'reabastecendo' : 'de volta';
      }
      return;
    }

    if (u.modo === 'reabastecendo' || u.modo === 'de volta') {
      // Parado na porta do quartel o pessoal espera dentro: um bombeiro a pé no pátio não serve
      // para nada e ainda aparece como pedestre no radar.
      if (Math.hypot(v.x - u.home.x, v.y - u.home.y) < 2 && !this.embarca(u, dt, ctx)) return;
      const meta = u.home;
      const atéCasa = Math.hypot(v.x - meta.x, v.y - meta.y);
      // A volta não é ronda: `patrol` é a mão única de quem circula um setor, e a própria
      // `PoliceSystem` usa a rota sem direção no modo `return`. Insistir na mão única aqui deixaria
      // o caminhão parado num cruzamento onde a malha dirigida não tem caminho de volta.
      const target = atéCasa < 2 && linhaLivre(ctx.map, v, meta)
        ? meta : waypoint(u, v, meta, dt, ctx.map, ctx.rng, false, false);
      const dx = target.x - v.x, dy = target.y - v.y, rumo = Math.hypot(dx, dy);
      // Estar em casa é a régua da chegada, nunca o resto da rota: quando a malha não entrega
      // caminho, `waypoint` devolve a própria posição do caminhão — medir contra esse alvo faria a
      // lataria "encostar no quartel" no meio da avenida, enchendo o tanque e repondo tripulação
      // onde ninguém vê, sem nunca ter voltado. É por isso que o passo sem rumo tem o mesmo
      // desenrugo da ida: espera, esquece a rota e tenta de novo por outra rua.
      if (atéCasa < 0.4) {
        v.speed = 0;
        v.state = 'parked';
        u.stuckTimer = 0;
        if (u.modo === 'reabastecendo') {
          u.água = Math.min(1, u.água + RECARREGA * dt);
          if (u.água < 1) return;
          const f = this.fogo(u.fogo);
          u.modo = f ? 'a caminho' : 'quartel';
          if (f) { u.parada = f.parada; f.viatura = u.vehicleId; esqueceARota(u); }
          return;
        }
        this.recompõe(u, ctx);
        u.modo = 'quartel';
        return;
      }
      if (rumo < 0.05) { u.stuckTimer += dt; if (u.stuckTimer > 3) esqueceARota(u); return; }
      apontaViatura(v, dx, dy);
      v.speed = Math.min(PASSO_DO_CAMINHÃO, v.speed + GAME_CONFIG.VEHICLE_ACCEL * dt, rumo / dt);
      v.state = 'driving';
      deslizaViatura(v, ctx.map, ctx.collision, ctx.vehicles, dx / rumo * v.speed, dy / rumo * v.speed, dt);
      for (const n of crew) if (n.inVehicle) { n.x = v.x; n.y = v.y; }
    }
  }

  /**
   * Desce a tripulação: a lataria encosta no asfalto e os corpos saem para o lado de fora que tem
   * calçada. É o passo que faz "bombeiro" existir como pessoa no mundo — sem ele o caminhão chega,
   * fica parado e a água não sai de lugar nenhum.
   */
  private desce(u: Viatura, ctx: IncendioContext): void {
    const v = this.vehicle(ctx, u.vehicleId);
    if (!v) return;
    let mudou = false;
    for (const id of u.crew) {
      const npc = this.npc(ctx, id);
      if (!npc || !npc.inVehicle || npc.dead) continue;
      const point = pontoDeSaída(v, npc, ctx.map, ctx.collision, ctx.vehicles, ctx.npcs);
      if (!point) continue;
      npc.x = point.x; npc.y = point.y;
      npc.lastX = point.x; npc.lastY = point.y;
      npc.inVehicle = false; npc.vehicleId = null;
      if (npc.state !== 'knocked') npc.state = 'chasing';
      mudou = true;
    }
    if (mudou) {
      ctx.onStructChange();
      sound.play('doorOpen', 0.28);
      this.espalhaPostos(u, ctx);
    }
  }

  /**
   * Os postos de trabalho ao redor da boca: um arco no lado do caminhão, um homem por fatia, cada um
   * a um passo de jato da borda do fogo e nunca a mais de uma mangueira da lataria. Três homens no
   * mesmo ponto molham a mesma pedra; um em cada lado fecha a boca — e se a boca está longe demais
   * para a linha, o posto vem para trás, na ponta da mangueira, porque é o homem que vai até onde o
   * caminhão consegue alcançar, não o contrário.
   */
  private espalhaPostos(u: Viatura, ctx: IncendioContext): void {
    const fogo = this.fogo(u.fogo);
    const v = this.vehicle(ctx, u.vehicleId);
    if (!fogo || !v) return;
    // O arco abre a partir da direção do caminhão: ninguém trabalha atrás da fachada de fogo que o
    // próprio jato ainda não abriu, e o vento leva a brasa para quem está de costas para ela.
    const doCaminhão = Math.atan2(v.y - fogo.y, v.x - fogo.x);
    const viva = this.bombeiros.filter((b) => b.viatura === u.vehicleId);
    const fatia = Math.PI / Math.max(2, viva.length + 1);
    for (let i = 0; i < viva.length; i++) {
      const ângulo = doCaminhão + (i - (viva.length - 1) / 2) * fatia;
      const raio = fogo.raio + 1;
      let x = fogo.x + Math.cos(ângulo) * raio;
      let y = fogo.y + Math.sin(ângulo) * raio;
      const daLataria = Math.hypot(x - v.x, y - v.y);
      if (daLataria > MANGUEIRA) {
        const puxa = (MANGUEIRA * 0.92) / daLataria;
        x = v.x + (x - v.x) * puxa;
        y = v.y + (y - v.y) * puxa;
      }
      viva[i].posto = { x, y };
    }
  }

  private trabalha(dt: number, b: Bombeiro, ctx: IncendioContext): void {
    const npc = this.npc(ctx, b.npcId);
    if (!npc || npc.dead) { this.licenca(b, npc, ctx); return; }
    const u = this.viaturas.find((c) => c.vehicleId === b.viatura);
    if (!u) return;
    const v = this.vehicle(ctx, b.viatura);
    const fogo = this.fogo(u.fogo);
    if (u.modo !== 'em terra' || !v) {
      // Fora do trabalho ele é um corpo parado no canto da rua, sem travar o trânsito.
      if (!npc.inVehicle) { npc.speed = 0; npc.anim = 'idle'; npc.frame = 0; }
      return;
    }
    if (!fogo) { this.andaPara(dt, npc, v.x, v.y, ctx, b, true); return; }
    const meta = b.posto ?? { x: fogo.x, y: fogo.y };
    const atéOFogo = Math.hypot(npc.x - fogo.x, npc.y - fogo.y);
    const naLinha = Math.hypot(npc.x - v.x, npc.y - v.y) <= MANGUEIRA;
    if (atéOFogo <= fogo.raio + JATO && naLinha && u.água > 0 && npc.state !== 'knocked') {
      this.molha(dt, u, fogo);
      npc.state = 'chasing';
      npc.anim = 'idle';
      npc.speed = 0;
      npc.dir = direçãoDoPasso(fogo.x - npc.x, fogo.y - npc.y);
      return;
    }
    this.andaPara(dt, npc, meta.x, meta.y, ctx, b, false);
  }

  /**
   * Sai da folha de serviço e da tripulação. O corpo é devolvido à cidade como civil **em vida ou
   * morto**: é isto que permite ao `LifeSystem` reciclar o cadáver (ele só libera vaga de quem é
   * `civ`) e ao `NPCSystem` voltar a andar com quem está de pé. Um bombeiro que perde o caminhão —
   * roubado, carbonizado — e continua `bombeiro` seria uma estátua na rua: a multidão não o dirige
   * (o predicado é `kind !== 'civ'`) e nenhum sistema nosso o move outra vez. Sem essa devolução
   * cada incêndio com baixa vazaria população e deixaria gente parada no asfalto para sempre, e a
   * vaga na tripulação ficaria presa para o quartel recompor quando o caminhão voltar.
   */
  private licenca(b: Bombeiro, npc: NPC | undefined, ctx: IncendioContext): void {
    const i = this.bombeiros.indexOf(b);
    if (i >= 0) this.bombeiros.splice(i, 1);
    const u = this.viaturas.find((c) => c.vehicleId === b.viatura);
    if (u) {
      const j = u.crew.indexOf(b.npcId);
      if (j >= 0) u.crew.splice(j, 1);
    }
    if (npc && npc.kind === 'bombeiro') npc.kind = 'civ';
    ctx.onStructChange();
  }

  private andaPara(dt: number, npc: NPC, x: number, y: number, ctx: IncendioContext, b: Bombeiro, volta: boolean): void {
    if (npc.state === 'knocked') {
      npc.downTimer -= dt;
      npc.speed = 0;
      npc.anim = 'idle';
      npc.frame = 0;
      if (npc.downTimer <= 0) npc.state = 'chasing';
      return;
    }
    if (volta && Math.hypot(npc.x - x, npc.y - y) < 0.5) {
      npc.inVehicle = true;
      npc.vehicleId = b.viatura;
      npc.speed = 0;
      ctx.onStructChange();
      return;
    }
    const target = waypoint(b, npc, { x, y }, dt, ctx.map, ctx.rng, true);
    const dx = target.x - npc.x, dy = target.y - npc.y, d = Math.hypot(dx, dy);
    npc.speed = d < 0.12 ? 0 : Math.min(PASSO_DO_BOMBEIRO, d / dt);
    npc.anim = npc.speed ? 'walk' : 'idle';
    if (npc.speed) passaAndando(npc, dx, dy, dt, ctx.map, ctx.collision, ctx.vehicles);
    else npc.frame = 0;
    npc.lastX = npc.x;
    npc.lastY = npc.y;
  }

  private molha(dt: number, u: Viatura, f: Fogo): void {
    if (u.água <= 0) return;
    u.água = Math.max(0, u.água - VAZÃO * dt);
    f.atacado++;
    // A água não "reseta" o fogo: come o combustível e derruba a boca mais rápido do que ela
    // cresce. É por isso que um incêndio grande leva tempo e um pequeno fecha na hora.
    f.combustível = Math.max(0, f.combustível - dt * VAZÃO * 3.2);
    f.raio = Math.max(RAIO_MÍNIMO, f.raio - QUEDA * 1.6 * dt);
  }

  /**
   * O barulho da linha aberta. O pack não tem som de mangueira, e o único transitório de água que
   * o jogo tem é o corpo que sai do rio — é ele que soa aqui, baixo e espaçado, porque o que se
   * ouve é a cena ("tem água sendo jogada ali"), não um efeito de água específico. Trocar por um
   * `jato.wav` gerado é uma linha, e é só esta.
   */
  private ruidoDaLinha(dt: number): void {
    this.somDeJato -= dt;
    if (this.somDeJato > 0 || !this.fogos.some((f) => f.atacado > 0)) return;
    this.somDeJato = 0.8;
    sound.play('piranhaSplash', 0.16);
  }

  /** A tripulação que voltou para o veículo: embarca um por vez, no lado livre da lataria. */
  private embarca(u: Viatura, dt: number, ctx: IncendioContext): boolean {
    const v = this.vehicle(ctx, u.vehicleId);
    if (!v) return true;
    let todos = true;
    for (const id of u.crew) {
      const npc = this.npc(ctx, id);
      if (!npc || npc.dead || npc.inVehicle) continue;
      const b = this.bombeiros.find((x) => x.npcId === id);
      // Sem folha de serviço ele deixou de ser nosso (morreu e virou civil, ou foi baixado com o
      // caminhão): bloquear o embarque da viatura por um corpo que não nos pertence mais seria a
      // viatura parada na rua para sempre.
      if (!b) continue;
      todos = false;
      const door = pontoDeSaída(v, npc, ctx.map, ctx.collision, ctx.vehicles, ctx.npcs) ??
        { x: v.x + 0.9, y: v.y };
      this.andaPara(dt, npc, door.x, door.y, ctx, b, true);
    }
    if (!todos) return false;
    if (ctx.player.currentVehicleId !== v.id) v.occupied = true;
    return true;
  }

  /**
   * Perda de viatura: a ocorrência volta para a fila e a tripulação sai da folha — quem estava a pé
   * é devolvido à cidade como civil (é o que o põe de volta no fluxo do `NPCSystem` e no ciclo do
   * `LifeSystem`, sem vazamento de população) e a vaga entra na reposição do quartel.
   */
  private baixa(u: Viatura, ctx: IncendioContext, soltaFogo: boolean): void {
    const fogo = this.fogo(u.fogo);
    if (soltaFogo && fogo && fogo.viatura === u.vehicleId) fogo.viatura = null;
    // Quem ainda está na lataria sai por ela: a viatura deixou de ser nossa — roubada no pátio,
    // carbonizada no atendimento — e um tripulante marcado `inVehicle` dentro de um carro que outra
    // pessoa dirige seria desenhado dentro dele. É o mesmo passo que a `PoliceSystem` faz ao perder
    // a unidade, e é o que devolve a pessoa para a rua antes de `licenca` entregá-la à multidão.
    this.desce(u, ctx);
    for (const b of this.bombeiros.filter((x) => x.viatura === u.vehicleId)) this.licenca(b, this.npc(ctx, b.npcId), ctx);
    const i = this.viaturas.indexOf(u);
    if (i >= 0) this.viaturas.splice(i, 1);
    this.reposiçãoTimer = REPOSIÇÃO_S;
    ctx.onStructChange();
  }

  /**
   * No quartel a frota se recompõe: a tripulação que morreu (ou foi baixada com o caminhão) é
   * substituída por gente nova, e o tanque volta a cheio. Sem isto o corpo de bombeiros seria uma
   * mecânica de uma única tarde: o primeiro carjack e a cidade nunca mais apagaria nada.
   */
  private recompõe(u: Viatura, ctx: IncendioContext): void {
    const v = this.vehicle(ctx, u.vehicleId);
    while (u.crew.length < TRIPULAÇÃO && v) {
      const npc = createNPC(ctx.allocNpcId(), 'a', v.x, v.y, 'bombeiro', ctx.rng);
      npc.inVehicle = true;
      npc.vehicleId = v.id;
      ctx.npcs.push(npc);
      u.crew.push(npc.id);
      this.bombeiros.push({ ...rotaNova(), npcId: npc.id, viatura: v.id, posto: null });
    }
    u.água = 1;
    if (u.crew.length) ctx.onStructChange();
  }

  /**
   * A varredura do quartel: um caminhão perdido volta a existir, e um quartel que nasceu sem vaga
   * livre ganha a frota na segunda passada. Ela é feita no relógio (`REPOSIÇÃO_S`), nunca a cada
   * tick, porque achar a vaga filtra e ordena todos os nós de rua do mapa — o corpo de bombeiros
   * não pode custar frame para o resto da cidade.
   */
  private repõe(dt: number, ctx: IncendioContext): void {
    this.reposiçãoTimer -= dt;
    if (this.reposiçãoTimer > 0) return;
    this.reposiçãoTimer = REPOSIÇÃO_S;
    let armado = false;
    for (const quartel of ctx.map.landmarksOf('firestation')) {
      if (this.viaturas.some((u) => u.quartel === quartel.key)) continue;
      this.armaQuartel(quartel, ctx);
      armado = true;
    }
    if (armado) ctx.onStructChange();
  }

  /**
   * A sirene vem antes da vista: o jogador ouve o atendimento do caminhão mais perto dele, e é esse
   * volume no ouvido que faz um incêndio do outro lado da cidade ser encontrado sem ler a HUD. O
   * canal é o `alarme`, separado do da polícia: duas viaturas em dois atendimentos diferentes não
   * podem calar uma à outra porque as duas disputam o mesmo alto-falante.
   */
  private alarme(dt: number, ctx: IncendioContext): void {
    // Mesmo ritmo da polícia: escrever volume no alto-falante a cada tick é trabalho de áudio por
    // quadro, e sirene que muda de volume sessenta vezes por segundo não soa como aproximação.
    this.sireneTimer -= dt;
    if (this.sireneTimer > 0) return;
    this.sireneTimer = 0.3;
    let maisPerto = Infinity;
    for (const u of this.viaturas) {
      if (u.modo !== 'a caminho' && u.modo !== 'em terra') continue;
      const v = this.vehicle(ctx, u.vehicleId);
      if (!v) continue;
      maisPerto = Math.min(maisPerto, Math.hypot(v.x - ctx.player.x, v.y - ctx.player.y));
    }
    const volume = maisPerto === Infinity ? 0 : Math.max(0, Math.min(0.5, 0.55 * (1 - maisPerto / 34)));
    // Silêncio não é notícia: `setLoop` atravessa para o alto-falante nativo mesmo quando escreve o
    // mesmo zero, e um atendimento que termina deixa a cidade muda para sempre — sem esta trava a
    // sirene cobraria uma chamada de áudio a cada 0,3 s pelo resto da sessão por nada.
    if (volume === this.sireneVolume) return;
    this.sireneVolume = volume;
    sound.setLoop('alarme', volume > 0 ? 'siren' : null, volume);
  }
}
