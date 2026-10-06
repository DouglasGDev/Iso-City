import { GAME_CONFIG, type Biome } from './GameConfig';
import { consumeAttack, consumeCrouch, consumeEnter, consumeHorn, consumeInteract, consumeJump, consumeReload, consumeWeapon, effectiveAim, inputState, resetActionInput, resetJoystickInput, setRunHeld } from './InputState';
import { WeaponSystem, type WeaponContext } from '../systems/WeaponSystem';
import { Map } from '../world/Map';
import { generateCity, WORLD_SEED } from '../data/maps/city';
import { createCamera, cameraFollow, clampToMap, clampToRoom, indoorZoom, type CameraState } from '../world/Camera';
import { angleToWorldDir, dirToAngle, screenToWorld, worldToScreen } from '../world/IsoUtils';
import { biomaDaFronteira, faceDaFronteira, nomeDaTerra, profundidade, seguraNaFronteira } from '../world/Frontier';
import { expulsaDaClareira, type Acampamento } from '../world/Tribo';
import { createPlayer, isAboard, type Player } from '../entities/Player';
import { createVehicle, type Vehicle } from '../entities/Vehicle';
import { createNPC, PLAYER_DEATH_DELAY_S, type NPC } from '../entities/NPC';
import { LifeSystem } from '../systems/LifeSystem';
import { WildlifeSystem, WILDLIFE_CALL_RADIUS } from '../systems/WildlifeSystem';
import { GorilaSystem, type GorilaContext } from '../systems/GorilaSystem';
import { FrontierFallSystem, type FrontierFallContext } from '../systems/FrontierFallSystem';
import { PiranhaSystem, noRioSemFim, type PiranhaContext } from '../systems/PiranhaSystem';
import { TriboSystem, type TriboContext } from '../systems/TriboSystem';
import { CativeiroSystem, type CativeiroContext } from '../systems/CativeiroSystem';
import type { CharId } from '../entities/types';
import { VEHICLE_DEFS } from '../data/vehicles';
import { GUN_IDS, isGunId, type GunId } from '../data/weapons';
import { CollisionSystem } from '../systems/CollisionSystem';
import { MovementSystem } from '../systems/MovementSystem';
import { JumpSystem } from '../systems/JumpSystem';
import { CrouchSystem } from '../systems/CrouchSystem';
import { VehicleSystem } from '../systems/VehicleSystem';
import { VehicleImpactSystem, type ImpactContext } from '../systems/VehicleImpactSystem';
import { NPCSystem } from '../systems/NPCSystem';
import { InteractionSystem } from '../systems/InteractionSystem';
import { TrafficSystem } from '../systems/TrafficSystem';
import { WantedSystem } from '../systems/WantedSystem';
import { StaminaSystem } from '../systems/StaminaSystem';
import { HealthSystem } from '../systems/HealthSystem';
import { CombatSystem } from '../systems/CombatSystem';
import { PoliceSystem, type PoliceContext, type VisionCone } from '../systems/PoliceSystem';
import { WitnessSystem, type CrimeIncident, type WitnessContext } from '../systems/WitnessSystem';
import { MissionSystem } from '../systems/MissionSystem';
import { PickupSystem } from '../systems/PickupSystem';
import { DayNightSystem } from '../systems/DayNightSystem';
import { WeatherSystem } from '../systems/WeatherSystem';
import { SnowSystem } from '../systems/SnowSystem';
import { HazardSystem, type HazardContext, type HazardSweepContext } from '../systems/HazardSystem';
import { CascadeSystem, type CascadeSweepContext } from '../systems/CascadeSystem';
import { TransportSystem, type RuaCorpo, type StreetBody, type RuaVisivel } from '../systems/TransportSystem';
import { JourneySystem, stationName, type JourneyContext } from '../systems/JourneySystem';
import { DestructionSystem } from '../systems/DestructionSystem';
import { FogSystem, type FogView } from '../systems/FogSystem';
import { AltitudeSystem, ancoraDaCamera, folgaDoQuadro, zoomDaAltura, type SkyEnvironment } from '../systems/AltitudeSystem';
import type { AirSky } from '../systems/AirSupportSystem';
import { AmbientSystem } from '../systems/AmbientSystem';
import { ExplorationSystem } from '../systems/ExplorationSystem';
import { sound } from '../audio/SoundManager';
import type { SfxKey } from '../audio/sounds';
import { useGameStore } from '../stores/useGameStore';
import { buildGpsRoute, remainingRouteDistance } from '../world/Gps';
import type { TransportDeparture } from '../data/transport/schedule';
import { fleetLabel } from '../data/transport/network';
import type { TransportStation } from '../data/transport/types';
import { InteriorSystem, type Entrance, type InteriorContext, type InteriorRoom } from '../systems/InteriorSystem';
import { JailSystem, type JailContext, type JailOccupant } from '../systems/JailSystem';
import { InteriorCrowdSystem, type CrowdContext } from '../systems/InteriorCrowdSystem';
import { JAIL_CELL_SPAWN } from '../data/jail';
import { SAVE_VERSION, type SaveGame } from './SaveGame';
import { ChunkIndex, type WorldRect } from '../world/streaming/ChunkIndex';
import { SpatialIndex } from '../world/streaming/SpatialIndex';
import { WorldStreamingManager } from '../world/streaming/WorldStreamingManager';

let _game: GameState | null = null;

const SHOT_SFX: Record<GunId, SfxKey> = {
  pistol: 'pistolShot',
  revolver: 'revolverShot',
  smg: 'smgShot',
  micro: 'microShot',
  rifle: 'rifleShot',
  sniper: 'sniperShot',
  shotgun: 'shotgunShot',
};

export function getGame(): GameState {
  if (!_game) _game = new GameState();
  return _game;
}

/** O jogo já foi criado? Serve para o menu e o boot nunca gerarem a cidade de raspão. */
export function peekGame(): GameState | null {
  return _game;
}

export function resetGame(): GameState {
  sound.stopLoops();
  _game = new GameState();
  return _game;
}

/**
 * Orquestrador fino: só posições, inputs e a ordem dos sistemas.
 * Cada mecânica mora no seu sistema em src/systems/.
 */
export class GameState {
  map: Map;
  /**
   * Dono das três zonas do mundo (visível / simula / carrega). Uma instância por partida,
   * alimentada pelo `update` e lida pelo render: nada aqui dentro vive na árvore React.
   */
  streaming: WorldStreamingManager;
  /** Grade espacial do que se move, recarregada uma vez por tick no fim do `update`. */
  spatial: SpatialIndex;
  interiors: InteriorSystem;
  /** Cela, guarda e presos: só existe enquanto a sala da cadeia está aberta. */
  jail = new JailSystem();
  /** Moradores, atendentes, clientes e funcionários da sala que estiver aberta. */
  crowd = new InteriorCrowdSystem();
  camera: CameraState;
  player: Player;
  vehicles: Vehicle[] = [];
  npcs: NPC[] = [];
  time = 0;
  viewW = 800;
  viewH = 400;
  showDebug = false;
  entityVersion = 0;
  paused = false;
  playerDeathTimer = 0;
  /** offset de screen-shake em px de tela (lido pelo GameCanvas) */
  shakeX = 0;
  shakeY = 0;

  interaction: InteractionSystem;
  movement: MovementSystem;
  collision = new CollisionSystem();
  vehicleSystem = new VehicleSystem();
  impact = new VehicleImpactSystem();
  npcSystem: NPCSystem;
  trafficSystem: TrafficSystem;
  wanted = new WantedSystem();
  stamina = new StaminaSystem();
  health = new HealthSystem();
  combat = new CombatSystem();
  weapons = new WeaponSystem();
  police = new PoliceSystem();
  witnesses = new WitnessSystem();
  missions: MissionSystem;
  pickups = new PickupSystem();
  dayNight = new DayNightSystem();
  weather = new WeatherSystem(() => sound.play('thunder'));
  /** A neve que fica depois que a frente passa; lê o clima, não o contrário. */
  snow = new SnowSystem();
  hazard = new HazardSystem();
  /** Correnteza das cachoeiras do relevo: nasce do mapa, por isso é montada no construtor. */
  cascade: CascadeSystem;
  /** Malha de transporte derivada das ruas do mapa: nasce dele, então também monta no construtor. */
  transport: TransportSystem;
  /**
   * A viagem que o telão da rodoviária planejou. Guarda só o plano e a fase: quem anda, espera
   * e embarca é o jogador no mundo, e o sistema observa o horário acontecer.
   */
  journeys = new JourneySystem();
  destruction = new DestructionSystem();
  fog = new FogSystem();
  /**
   * O ar acima da linha onde o iso ainda desenha altura. Lê o clima e a cota de quem está no
   * comando e devolve a coluna inteira — manta, bruma, vento, teto, rarefação — para o manche,
   * para a câmera, para as nuvens e para o som olharem a mesma curva no mesmo quadro. Vem depois
   * do `fog` porque é o irmão vertical dele: o fog fecha o horizonte, isto fecha o céu.
   */
  altitude = new AltitudeSystem();
  ambient = new AmbientSystem(sound);
  exploration: ExplorationSystem;
  life = new LifeSystem();
  wildlife = new WildlifeSystem();
  /**
   * A cobrança da mata sem fim. Não tem `init` porque não tem nada do mapa para ler: a
   * fronteira é uma função da coordenada, e o único estado do sistema é a dívida acumulada e o
   * corpo que ela comprou — os dois sobrevivem a salas, mortes e reinício de round tão bem
   * quanto um número sobrevive.
   */
  gorilas = new GorilaSystem();
  /**
   * A mesma cobrança pelo lado do céu. Também não tem `init`: o que este sistema guarda é o
   * histórico de queda de cada casco (`id → altura, pousou, noChão`), e nada nele depende do
   * mapa. Roda **antes** do `gorilas` porque é a descida que entrega a dívida: se a caçada
   * lesse o rancor um tick depois de ser paga, a fera só poderia nascer no quadro seguinte, e
   * o pedido — o helicóptero cai e a coisa grande aparece — viraria dois pedidos separados.
   */
  quedas = new FrontierFallSystem();
  /**
   * A cobrança do rio sem fim — o espelho aquático do `gorilas`, pelo mesmo motivo e com a mesma
   * espinha dorsal: o canal continua além da grade pela mesma função da coordenada, e um lugar que
   * continua tem de custar.
   *
   * Os dois nunca cobram o mesmo trecho, e isso não é uma consequência da ordem de chamada: é o
   * campo `água` do `GorilaContext`, que faz a mata recusar a dívida de quem está nadando no canal
   * enquanto o rio recusa a de quem está na margem. Deixar os dois contarem a mesma água daria
   * duas feras subindo no mesmo lugar — e um gigante no meio do rio é exatamente a cena que a
   * separação de mecanismos existe para impedir.
   */
  piranhas = new PiranhaSystem();
  /**
   * Os donos da terra pisada, do lado de dentro da banda do gigante. Como as duas feras, não tem
   * `init`: o acampamento é uma função da coordenada, e o único estado do sistema são os bandos
   * materializados perto do jogador.
   *
   * A ordem no tick é a parte que importa, e ela é diferente das outras três por um motivo físico:
   * o bando é o único sistema daqui que **move o corpo do jogador** (`arrasta`). Rodasse antes do
   * `separate`, a separação de corpos passaria por cima do arrasto e empurraria o prisioneiro para
   * fora da corda; rodando depois, quem escreveu a última palavra no `x`/`y` foi quem está puxando.
   */
  tribos = new TriboSystem();
  /**
   * O outro relógio da mesma clareira: o bando decide quem é levado, este decide quanto tempo a
   * corda segura. Fica num sistema separado porque as duas mecânicas têm donos diferentes — o
   * prisioneiro não é um guerreiro com um estado a menos, é o jogador com uma coordenada que ele não
   * manda. O único laço entre os dois é o `acorda` do contexto, e ele é uma porta e não um campo.
   */
  cativeiro = new CativeiroSystem();
  jump = new JumpSystem(() => this.interiors.active ? [] : this.vehicles,
    () => this.latariaDaRua());
  crouch = new CrouchSystem();

  private hitCooldown = 0;
  private exitLock = 0;
  private hornCooldown = 0;
  private hornNoise = 0;
  private gpsRefresh = 0;
  private engineRefresh = 0;
  private cascadeRefresh = 0;
  /**
   * O pino que a viagem pôs no mapa. Só ela é apagada no fim: o destino que o jogador marcou
   * no mapa antes de consultar o telão não pode sumir porque um ônibus passou.
   */
  private journeyMark: { x: number; y: number } | null = null;
  /** Bioma sob a câmera, lido no tick de ambiente: é o clima que ele escolhe. */
  private biomeAtCamera: Biome = 'residential';
  private nextVehicleId = 0;
  private nextNpcId = 0;
  /** Janela de veículos do `separate`, reutilizada de um tick para o outro. */
  private nearbyVehicles: Vehicle[] = [];
  private nearbyBuses: StreetBody[] = [];
  /**
   * A rua entregue ao ônibus: o mesmo `spatial` que a HUD e o trânsito consultam, embrulhado no
   * contrato que a malha sabe ler. Uma instância fixa porque `TransportSystem.update` recebe a
   * rua por parâmetro a cada quadro, e um objeto novo por frame é exatamente o lixo no meio do
   * frame que o contrato do índice existe para evitar.
   */
  private readonly rua: RuaVisivel = {
    pertoDe: (x, y, raio, visita) => this.varreRua(x, y, raio, visita),
  };
  /** O corpo visitado é emprestado: vale só durante a chamada, e por isso mora aqui. */
  private readonly corpoVisitado: RuaCorpo = {
    x: 0, y: 0, angle: 0, speed: 0, meio: 0, flanco: 0, mole: false,
  };
  private readonly caixaDaRua: WorldRect = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  private rnd = () => Math.random();

  private entityListeners = new Set<() => void>();

  subscribeEntityChange(cb: () => void): () => void {
    this.entityListeners.add(cb);
    return () => {
      this.entityListeners.delete(cb);
    };
  }

  notifyEntityChange() {
    this.entityVersion++;
    for (const cb of this.entityListeners) cb();
  }

  shake(amount: number) {
    this.shakeAmp = Math.min(1.6, this.shakeAmp + amount);
  }
  private shakeAmp = 0;

  constructor() {
    resetActionInput();
    this.weapons.events = {
      onShot: (weapon) => sound.play(SHOT_SFX[weapon.id], weapon.id === 'shotgun' ? 0.7 : 0.55),
      onReload: () => sound.play('weaponReload', 0.4),
      onEmpty: () => sound.play('weaponEmpty', 0.4),
    };
    this.map = new Map(generateCity(WORLD_SEED));
    // O índice dos estáticos nasce do mapa pronto e nunca mais muda: é ele que responde
    // "o que esta quadra tem?" sem percorrer as 4.451 estáticas da cidade inteira.
    this.streaming = new WorldStreamingManager(new ChunkIndex(this.map.data));
    this.spatial = new SpatialIndex(this.map.data.worldW, this.map.data.worldH);
    this.cascade = new CascadeSystem(this.map.data);
    // A malha de transporte é lida do mapa pronto, do mesmo jeito que o índice de chunks:
    // derives do que o gerador pôs no chão, nunca de uma lista de pontos no código.
    this.transport = new TransportSystem(this.map, WORLD_SEED);
    this.wildlife.init(this.map);
    this.interiors = new InteriorSystem(this.map);
    // A cadeia fala pela sala, mas quem decide é o JailSystem — laço de função, não de import.
    this.interiors.delegate = {
      prompt: (player) => (this.jail.inside ? this.jail.prompt(player) : null),
      interact: () => this.jail.tryInteract(this.jailContext()),
    };
    const spawn = this.map.data.playerSpawn;
    this.player = createPlayer(spawn.x, spawn.y);
    this.player.facingAngle = 0;
    {
      const c = { x: this.player.x, y: this.player.y, radius: GAME_CONFIG.PLAYER_RADIUS };
      this.collision.resolveCircle(c, this.map.staticColliders);
      this.player.x = c.x;
      this.player.y = c.y;
    }
    this.camera = createCamera(this.player.x, this.player.y);
    this.exploration = new ExplorationSystem(this.map.data.tilesW, this.map.data.tilesH);
    this.exploration.update({ position: this.player, outdoors: true });

    for (const v of this.map.data.vehicles) {
      const def = VEHICLE_DEFS[v.defKey];
      if (!def) continue;
      this.vehicles.push(
        createVehicle(this.nextVehicleId++, def, v.color ?? def.colors[0] ?? '', v.x, v.y, v.dir),
      );
    }

    const spawns = this.map.data.npcSpawns.slice().sort((a, b) =>
      Math.hypot(a.x - spawn.x, a.y - spawn.y) - Math.hypot(b.x - spawn.x, b.y - spawn.y));
    for (let i = spawns.length - 1; i > 48; i--) {
      const j = 48 + Math.floor(this.rnd() * (i - 47));
      [spawns[i], spawns[j]] = [spawns[j], spawns[i]];
    }
    const npcChars = GAME_CONFIG.NPC_CHARS as readonly CharId[];
    for (let i = 0; i < GAME_CONFIG.NPC_COUNT; i++) {
      if (i >= spawns.length) break;
      const s = spawns[i];
      const char = npcChars[Math.floor(Math.random() * npcChars.length)];
      const npc = createNPC(this.nextNpcId++, char, s.x, s.y);
      const c = { x: npc.x, y: npc.y, radius: GAME_CONFIG.NPC_RADIUS * 0.8 };
      this.collision.resolveCircle(c, this.map.staticColliders);
      npc.x = c.x;
      npc.y = c.y;
      this.npcs.push(npc);
    }

    this.movement = new MovementSystem(this.collision, () => this.interiors.active ? [] : this.vehicles,
      () => this.latariaDaRua());
    this.npcSystem = new NPCSystem(this.collision);
    this.interaction = new InteractionSystem(this.vehicleSystem);
    this.trafficSystem = new TrafficSystem(this.collision);
    this.trafficSystem.init(this.map, this.vehicles, this.npcs, () => this.nextVehicleId++);
    // O semáforo é um só para a rua inteira. Os ônibus do horário existem antes de haver
    // trânsito na cidade e liam apenas a lataria à frente; ligados aqui, eles passam a obedecer
    // a mesma luz que os carros — dois conjuntos de verdade sobre quem entra no cruzamento é
    // como o ônibus atropela o carro que espera o verde.
    this.transport.signals = this.trafficSystem.signalSystem;
    this.pickups.init(this.map, this.rnd);
    this.missions = new MissionSystem(this.map, this.rnd);
    this.police.init(this.policeContext());

    for (const npc of this.npcs) {
      if (npc.inVehicle || npc.dead) continue;
      npc.patienceTimer = 50 + Math.random() * 200;
    }

    // As zonas e o índice antes do primeiro quadro: sem isto a cidade nasceria sem chunk
    // carregado, e o render só veria prédio depois do primeiro tick do GameLoop.
    this.updateStreaming();
    this.rebuildSpatial();
  }

  setViewSize(w: number, h: number) {
    this.viewW = w;
    this.viewH = h;
    this.clampCamera();
    this.snapCameraHeight();
  }

  private clampCamera() {
    const room = this.interiors.active;
    if (room) clampToRoom(this.camera, room.map.worldW, room.map.worldH, this.viewW, this.viewH);
    else clampToMap(this.camera, this.map.worldW, this.map.worldH, this.viewW, this.viewH);
  }

  /**
   * A câmera sobe junto com o chão que ela mira, e sobe junto com o casco quando ele passa da
   * linha de passagem. É uma translação da tela no mesmo eixo Y da projeção: o losango continua
   * 2:1 e a câmera continua isométrica — o que muda é que acima de oito tiles de cota a âncora
   * para de perseguir o chão e passa a segurar a lataria no quadro, deixando o mundo encolher
   * embaixo dela.
   */
  private snapCameraHeight() {
    const chao = this.activeMap.heightSmoothAt(this.camera.x, this.camera.y);
    this.camera.h = this.alvoDaCâmera(chao);
  }

  /**
   * A cota da câmera persegue a do chão com o mesmo alívio dos eixos x/y. Ler a cota crua a cada
   * quadro faria a tela inteira pular um degrau na borda de cada tile — o solavanco que parece bug,
   * ainda mais em carro.
   */
  private easeCameraHeight(dt: number) {
    const chao = this.activeMap.heightSmoothAt(this.camera.x, this.camera.y);
    const alvo = this.alvoDaCâmera(chao);
    this.camera.h += (alvo - this.camera.h) * (1 - Math.exp(-GAME_CONFIG.CAMERA_LERP * dt));
  }

  /**
   * Dentro de uma sala não há céu: o plano é outro mundo e a cota dele é o próprio piso. A
   * checagem existe porque o instantâneo da coluna ainda carrega a última viagem — quem descesse
   * do helicóptero direto para uma porta levaria o teto de nuvem para dentro da parede.
   */
  private alvoDaCâmera(chao: number): number {
    if (this.interiors.active) return chao;
    return Math.max(chao, ancoraDaCamera(this.altitude.snapshot.cota, chao,
      folgaDoQuadro(this.viewH, this.camera.zoom)));
  }

  /**
   * O ar de cima é largo e o de baixo é apertado: a mesma rua que enche o quadro a dois tiles do
   * chão é uma ficha a quarenta. O zoom vai junto com a cota, e só com ela — em sala o valor é
   * mandado pela porta, e a pé o alvo é o zoom padrão de sempre.
   */
  private easeCameraZoom(dt: number) {
    if (this.interiors.active) return;
    const alvo = zoomDaAltura(this.altitude.snapshot.cota);
    this.camera.zoom += (alvo - this.camera.zoom) * (1 - Math.exp(-2.4 * dt));
  }

  /**
   * Quem manda na coluna de ar deste quadro: o casco pilotado, ou o chão que a câmera mira quando
   * ninguém está voando. É lido antes do movimento, então a manta que você vê fechar é a manta em
   * que você estava no quadro passado — a um terço de segundo de diferença, com a borda macia que
   * o sistema já tem por cima.
   */
  private skyEnvironment(): SkyEnvironment {
    const v = this.aeronaveNoComando();
    const x = v ? v.x : this.camera.x;
    const y = v ? v.y : this.camera.y;
    const chao = this.activeMap.heightSmoothAt(x, y);
    return {
      x, y,
      cota: v ? v.elevation : chao,
      chao,
      cobertura: this.weather.cover,
      nevoia: this.weather.mist,
      vento: this.weather.wind + this.hazard.slant,
      severidade: this.weather.intensity,
      tempo: this.time,
    };
  }

  /** O helicóptero que o jogador pilota, ou nenhum. Só ele manda na coluna: o céu não é da rua. */
  private aeronaveNoComando() {
    const id = this.player.currentVehicleId;
    if (id === null) return null;
    const v = this.vehicles.find((x) => x.id === id);
    return v && v.def.type === 'helicopter' ? v : null;
  }

  /**
   * Instantâneo do save. Só estado persistente faz sentido: jogador, arsenal, relógio e o
   * mapa de exploração. NPCs/trânsito/destruição pertencem ao mundo, que é re-simulado.
   */
  snapshot(): SaveGame {
    const p = this.player;
    // Salvar dentro de uma sala não pode gravar o plano do interior como se fosse a rua:
    // a posição persistida é a âncora na porta, e o load devolve o jogador para fora.
    const where = this.worldPosition;
    return {
      version: SAVE_VERSION,
      time: this.time,
      dayT: this.dayNight.t,
      player: {
        x: where.x,
        y: where.y,
        direction: p.direction,
        facingAngle: this.interiors.street?.facing ?? p.facingAngle,
        health: p.health,
        money: p.money,
        wantedLevel: p.wantedLevel,
        stamina: p.stamina,
        char: p.char,
        busUnit: p.busUnit,
      },
      weapons: {
        equipped: this.weapons.equipped,
        owned: [...this.weapons.owned],
        ammo: GUN_IDS.reduce((acc, id) => {
          acc[id] = { loaded: this.weapons.ammo[id].loaded, reserve: this.weapons.ammo[id].reserve };
          return acc;
        }, {} as SaveGame['weapons']['ammo']),
      },
      exploration: this.exploration.serialize(),
    };
  }

  /**
   * Aplica um save sobre um GameState recém-criado (mesma seed, mesmo mundo).
   * O carro dirigido não volta: ele é do mundo re-simulado, não do save. O ônibus é o
   * contrário — ele não é do mundo, é do relógio, e o relógio voltou junto.
   */
  applySave(save: SaveGame) {
    this.time = save.time;
    this.dayNight.t = save.dayT;

    this.exploration.restore(save.exploration);
    this.exploration.breakTrail();

    const p = this.player;
    p.x = save.player.x;
    p.y = save.player.y;
    p.direction = save.player.direction;
    p.walkDir = save.player.direction;
    p.facingAngle = save.player.facingAngle;
    p.health = save.player.health;
    p.money = save.player.money;
    p.wantedLevel = save.player.wantedLevel;
    p.stamina = save.player.stamina;
    p.char = save.player.char;
    p.currentVehicleId = null;
    // O assento volta porque o relógio voltou: `time` já foi restaurado logo acima, e a
    // posição de uma unidade é função pura dele. Não é guardar onde o ônibus estava — é o
    // próprio horário, que continua exatamente onde parou.
    const seat = save.player.busUnit;
    p.busUnit = typeof seat === 'number' && seat >= 0 && seat < this.transport.units.length ? seat : null;
    p.state = p.busUnit !== null ? 'driving' : 'idle';
    p.anim = 'idle';
    p.swimming = false;
    p.crouching = false;
    p.jumpHeight = 0;
    p.jumpTimer = 0;
    p.jumpStart = null;
    p.jumpEnd = null;

    const c = { x: p.x, y: p.y, radius: GAME_CONFIG.PLAYER_RADIUS };
    this.collision.resolveCircle(c, this.map.staticColliders);
    p.x = c.x;
    p.y = c.y;

    this.camera = createCamera(p.x, p.y);

    this.weapons.reset();
    this.weapons.owned.clear();
    for (const id of save.weapons.owned) this.weapons.owned.add(id);
    this.weapons.equipped = this.weapons.owned.has(save.weapons.equipped) ? save.weapons.equipped : 'unarmed';
    for (const id of GUN_IDS) {
      const saved = save.weapons.ammo[id];
      this.weapons.ammo[id].loaded = saved?.loaded ?? 0;
      this.weapons.ammo[id].reserve = saved?.reserve ?? 0;
    }

    this.exploration.update({ position: p, outdoors: true });
    // O save teleporta o jogador: as zonas têm que pular para o ponto novo na hora, senão o
    // primeiro quadro depois do carregar seria a cidade do spawn.
    this.updateStreaming();
    this.rebuildSpatial();
    this.notifyEntityChange();
  }

  update(dt: number) {
    // Always drain taps, including while driving or simulation is suspended.
    const attack = consumeAttack();
    const reload = consumeReload();
    const weapon = consumeWeapon();
    const jump = consumeJump();
    const crouch = consumeCrouch();
    const ui = useGameStore.getState();
    if (this.paused || ui.paused || ui.mapOpen || ui.shopOpen || ui.departuresOpen || ui.overlay !== null) {
      resetActionInput();
      this.weapons.suspend();
      return;
    }
    this.time += dt;
    if (this.player.state === 'dead') {
      this.playerDeathTimer += dt;
      resetActionInput();
      this.weapons.suspend();
      if (this.playerDeathTimer >= PLAYER_DEATH_DELAY_S) {
        if (this.player.wantedLevel > 0 && this.police.nearestPoliceDist < 14) this.bust();
        else this.waste();
      }
      this.updateCamera(dt);
      this.updateShake(dt);
      return;
    }

    this.dayNight.update(dt);
    this.weather.update(dt, this.rnd, this.biomeAtCamera);
    this.snow.update(dt, this.weather.kind, this.weather.intensity);
    this.hazard.update(dt, this.rnd, this.hazardContext());
    // A coluna depois do clima e do perigo: ela lê a cobertura, a névoa e o vento que as duas
    // frentes acabaram de escrever, e o que ela devolve é o ar que o manche deste quadro pisa.
    this.altitude.update(dt, this.skyEnvironment());
    this.combat.update(dt);
    this.player.attackTimer = Math.max(0, this.player.attackTimer - dt);
    this.exitLock = Math.max(0, this.exitLock - dt);
    this.hornCooldown = Math.max(0, this.hornCooldown - dt);
    this.hornNoise = Math.max(0, this.hornNoise - dt);
    this.interiors.update(dt);
    if (this.jail.inside) this.jail.update(dt, this.jailContext());
    if (consumeInteract() && this.useInterior()) return;
    if (this.interiors.active) {
      if (consumeEnter() && this.useInterior()) return;
    } else if (this.handleVehicleInput()) return;
    // As zonas acompanham a câmera antes de qualquer sistema decidir quem vive. Dentro de
    // uma sala a câmera mira o plano do interior, que não é um lugar do mapa: a cidade fica
    // congelada na última configuração, exatamente como estava quando a porta fechou.
    if (!this.interiors.active) this.updateStreaming();
    if (crouch) this.crouch.toggle(this.player);
    this.crouch.update(this.player);
    if (jump && this.jump.tryJump(this.player, this.activeMap, this.collision)) {
      sound.play(this.player.jumpEnd ? 'vault' : 'jump', 0.4);
    }
    this.handleMovement(dt);
    this.crouch.update(this.player);
    // Grades fechadas: colisão dinâmica, depois do movimento, para a cela prender de fato.
    if (this.jail.inside) this.jail.blockPlayer(this.player, this.collision);
    this.handleWeaponInput(dt, attack, reload, weapon);
    // Depois do tiro: é assim que quem está na sala ouve o estampido no mesmo tick.
    if (this.crowd.inside && this.interiors.active) {
      this.crowd.update(dt, this.crowdContext(this.interiors.active));
      this.crowd.separatePlayer(this.player, this.collision);
    }
    this.updateEnvironment(dt);
    const room = this.interiors.active;
    // Dentro de uma sala o jogador não existe no mapa da cidade: as coordenadas dele são
    // do plano do interior. A rua lida com a âncora — o pé da porta por onde ele entrou.
    const outdoorPlayer: Player = room
      ? { ...this.player, x: this.worldPosition.x, y: this.worldPosition.y, vx: 0, vy: 0, speed: 0, invulnUntil: Infinity }
      : this.player;

    // O horário da cidade é o relógio da cidade: o sistema recebe o tempo do jogo, não um
    // intervalo, então morrer ou entrar numa sala não atrasa nenhum ônibus. Lê o trânsito por
    // último porque o trânsito lê os ônibus por primeiro: um motorista que freia diante de um
    // corpo no asfalto tem de ver esse corpo onde o tick de hoje o pôs, não onde o de ontem o
    // deixou. O passageiro que espera só conta lá fora: dentro de uma sala o âncora é um lugar
    // do mapa, não um pedestre no ponto, e um hall de rodoviária não segura linha nenhuma.
    // A rua vai junto pelo mesmo motivo, mas do lado de lá: o ônibus precisa saber quem está no
    // asfalto dele, e quem está no asfalto ele não dirige — é o trânsito, os pedestres e os
    // bichos que a grade dele acabou de organizar. Dentro de uma sala a grade ainda é a da cidade
    // (a rua congela na última configuração, como o trânsito e a polícia), então a varredura é
    // entregue do mesmo jeito: um hall não muda onde um sedã parado está.
    this.transport.update(this.time, outdoorPlayer.x, outdoorPlayer.y, this.streaming,
      room ? undefined : outdoorPlayer, this.rua);
    this.trafficSystem.update(this.map, this.npcs, this.vehicles, dt, outdoorPlayer,
      this.streaming, this.transport.bodies);
    // O cola do passageiro vem logo depois da leitura do horário: o ônibus já sabe onde o
    // tick o pôs, e o corpo tem que estar lá no mesmo tick. Fizesse isso no `handleMovement`
    // o jogador seria arrastado um frame atrás do próprio ônibus.
    if (!room) this.transport.ride(this.player);
    // A viagem acompanha o corpo lá fora. Dentro de uma sala a rua está congelada na última
    // configuração— a mesma regra do trânsito e da polícia — então o plano espera também.
    if (!room) this.journeys.update(this.journeyContext());
    this.updateNpcs(dt, outdoorPlayer);

    this.witnesses.update(dt, this.witnessContext(outdoorPlayer));
    outdoorPlayer.wantedLevel = this.player.wantedLevel;
    this.police.update(dt, this.policeContext(outdoorPlayer));

    this.missions.update(dt, outdoorPlayer, (money) => {
      this.player.money += money;
    }, !room);

    if (!room) this.pickups.update(this.time, this.player, this.rnd, (p) => {
      if (p.kind === 'cash') {
        this.player.money += p.amount;
        sound.play('coin', 0.55);
      } else if (p.kind === 'ammo') {
        this.weapons.refill();
        sound.play('uiSwitch', 0.55);
      } else if (p.kind === 'gun' && p.weapon) {
        this.weapons.acquire(p.weapon);
        this.weapons.equipped = p.weapon;
        sound.play('uiSwitch', 0.7);
        this.notifyEntityChange();
      } else {
        this.health.heal(this.player, p.amount);
        sound.play('healthPickup', 0.55);
      }
    });

    this.destruction.update(dt, {
      player: outdoorPlayer,
      vehicles: this.vehicles,
      npcs: this.npcs,
      health: this.health,
      wanted: this.wanted,
      time: this.time,
      onPlayerExitedVehicle: () => this.ejectFromVehicle(),
      shake: (a) => this.shake(a),
      onStructChange: () => this.notifyEntityChange(),
    });

    // Depois de tudo ter se movido: é assim que a roda pega o corpo onde ele realmente está.
    this.impact.update(dt, this.impactContext(!!room));

    const view = this.fog.view(this);
    const noises: { x: number; y: number; radius: number }[] = [];
    if (!room) {
      if (this.weapons.fireFlash > 0) noises.push({ x: this.player.x, y: this.player.y, radius: 18 });
      if (this.hornNoise > 0) noises.push({ x: this.player.x, y: this.player.y, radius: 10 });
    }
    this.wildlife.update(dt, {
      map: this.map, player: outdoorPlayer, vehicles: this.vehicles,
      night: this.dayNight.isNight,
      noise: noises.length ? noises : undefined,
      onDeath: (animal) => {
        if (!room && Math.hypot(animal.x - this.player.x, animal.y - this.player.y) < 12) sound.play('bodyHit', 0.3);
      },
      onCall: (animal) => {
        if (room) return;
        // Queda até zero, sem piso. O `Math.max(0.08, ...)` de antes é metade do pedido:
        // um bicho na beira do mundo soava a 0,12 e um ao lado do player a 0,4 — três
        // vezes mais baixo continua sendo um uivo na mesma sala, e a sala estava vazia.
        const d = Math.hypot(animal.x - this.player.x, animal.y - this.player.y);
        const perto = 1 - d / WILDLIFE_CALL_RADIUS;
        if (perto <= 0) return;
        sound.play('animalCall', 0.4 * perto);
      },
      isVisible: (x, y) => {
        const p = worldToScreen(x, y, this.map.heightSmoothAt(x, y));
        return this.fog.intersects(view, p.x - 45, p.y - 65, 90, 90);
      },
      onStructChange: () => this.notifyEntityChange(),
    });
    this.life.update(dt, {
      player: outdoorPlayer, npcs: this.npcs, map: this.map, vehicles: this.vehicles,
      collision: this.collision, rng: this.rnd,
      isPointVisible: (x, y) => {
        const p = worldToScreen(x, y, this.map.heightSmoothAt(x, y));
        return this.fog.intersects(view, p.x - 40, p.y - 40, 80, 80);
      },
      onStructChange: () => this.notifyEntityChange(),
    });
    if (!room) this.quedas.update(dt, this.frontierFallContext());
    this.gorilas.update(dt, this.gorilaContext(!!room, view));
    this.piranhas.update(dt, this.piranhaContext(!!room, view));
    this.health.update(dt, this.player, this.time);
    // Depois de todo mundo se mover: o perigo empurra, arremessa e machuca o que cruzar.
    this.hazard.sweep(dt, this.hazardSweepContext(!!room));
    // A queda é um lugar fixo: a mesma varredura leva para a bacia quem encostar no lençol.
    this.cascade.sweep(dt, this.cascadeSweepContext(!!room));
    this.wanted.update(dt, this.player, !room && this.police.playerVisible);

    // Todo mundo já se moveu: é aqui, uma vez por tick, que a grade de vizinhança é montada
    // para a separação de corpos de agora e para o recorte do render no próximo quadro.
    this.rebuildSpatial();
    if (!room) this.separate(this.player);
    // O bando depois da separação, e não ao lado das outras três cobranças da fronteira: é o único
    // sistema daqui que escreve a coordenada do jogador (`arrasta`), e quem arriva por último chega
    // com a palavra final. Rodasse na linha de cima, a separação de corpos passaria por cima do
    // arrasto e o prisioneiro escorregaria para fora da amarra a cada quadro.
    this.tribos.update(dt, this.triboContext(!!room, view));
    // O cativeiro logo depois do bando porque os dois relógios têm que ver o mesmo mundo no mesmo
    // tick: é aqui que uma entrega vira amarra, e uma janela que começasse a contar no quadro
    // seguinte daria ao prisioneiro um segundo de graça a mais do que o lugar promete.
    this.cativeiro.update(dt, this.cativeiroContext(!!room));
    if (this.jump.update(this.player, this.activeMap, this.collision, dt) === 'landed') sound.play('land', 0.4);
    this.exploration.update({ position: this.worldPosition, outdoors: !this.interiors.active });
    this.updateAnimations(dt);
    this.updateSceneryVehicles(dt);
    this.updateCamera(dt);
    this.updateEngineAudio(dt);
    this.updateCascadeAudio(dt);
    if (!room) this.updateGpsArrival();

    if (this.player.health <= 0) {
      this.ejectFromVehicle();
      this.player.state = 'dead';
      this.player.vx = this.player.vy = this.player.speed = 0;
      this.player.attackTimer = 0;
      this.player.crouching = false;
      this.playerDeathTimer = 0;
      sound.play('death', 0.55);
      this.weapons.suspend();
      resetActionInput();
      this.notifyEntityChange();
    }
    this.updateShake(dt);
  }

  // ---------------------------------------------------------------- inputs

  get activeMap(): Map {
    return this.interiors.active?.map ?? this.map;
  }

  /**
   * Onde a cidade enxerga o jogador. Na rua é o próprio corpo; dentro de uma sala são as
   * coordenadas do pé da porta — o plano do interior não é um lugar do mapa, então nem o
   * trânsito, nem a polícia, nem o radar, nem o save podem ler `player.x/y` nesse momento.
   */
  get worldPosition(): { x: number; y: number } {
    const room = this.interiors.active;
    if (!room) return this.player;
    return this.interiors.street ?? room.entrance;
  }

  /** O chão que o jogador pisa: o piso plano da sala, ou o relevo da cidade. */
  playerGround(): number {
    return this.activeMap.heightSmoothAt(this.player.x, this.player.y);
  }

  private useInterior(): boolean {
    return this.interiors.interact(this.interiorContext());
  }

  /** Compra no balcão aberto (chamada pela interface da loja). */
  purchaseShopItem(itemId: string): boolean {
    return this.interiors.buy(itemId, this.interiorContext());
  }

  /**
   * Uma linha do telão: a partida do horário mais o nome de quem fica em frente ao ponto
   * final. O destino é sempre uma calçada real da malha, nunca um lugar inventado pelo menu.
   * `bay` é o número da plataforma onde aquele ônibus encosta — na rua é vazio, porque marquise
   * não tem baia, e na rodoviária é o que o passageiro procura no pátio inteiro.
   *
   * `at` é a hora do mundo em que ele encosta, e `fleet` é a matrícula do veículo que serve
   * aquela partida. Um painel de rodoviária anuncia hora, não contagem regressiva, e anuncia o
   * ônibus — não a linha — porque é o número no teto que o passageiro lê entre as latarias
   * paradas na baia.
   */
  departureRows(): (TransportDeparture & {
    line: string; place: string; bay: string; company: string; code: string; cor: string;
    at: string; fleet: string;
  })[] {
    const platform = this.terminalPlatform();
    if (!platform) return [];
    const network = this.transport.network;
    return this.transport.departuresAt(platform.id).map((d) => {
      const route = network.routes[d.route];
      const via = network.companies[route.company];
      return {
        ...d,
        line: route.name,
        place: stationName(network, this.map, d.destination),
        bay: d.platform >= 0 ? network.platforms[d.platform].name : '',
        company: via.name,
        code: via.code,
        cor: via.livery,
        fleet: fleetLabel(route, d.unit),
        at: this.dayNight.clockIn(d.wait),
      };
    });
  }

  /**
   * A calçada de embarque da rodoviária onde o jogador está: a parada com linha mais perto da
   * porta do hall, derivada do mapa. `null` é sala que não é terminal, ou terminal sem ônibus.
   */
  private terminalPlatform(): TransportStation | null {
    const room = this.interiors.active;
    if (room?.kind !== 'terminal') return null;
    return this.transport.platformNear(room.entrance.x, room.entrance.y);
  }

  /**
   * Escolheu uma linha no telão. Isto não move o jogador um passo: devolve false quando o
   * horário não tem viagem entre a plataforma e o destino, e quando tem, entrega um plano que
   * ele vai ter de andar, esperar e embarcar. O menu fecha; a viagem começa na rua.
   *
   * A linha tocada é o ônibus anunciado, com a passada e a frota que o painel escreveu. Sem
   * isso o plano procuraria o mais rápido do horário, e a HUD prometceria embarcar num veículo
   * dois minutos antes da hora que o telão acabou de anunciar.
   */
  chooseDeparture(line: number, destination: number): boolean {
    const platform = this.terminalPlatform();
    if (!platform) return false;
    const row = this.transport.departuresAt(platform.id)
      .find((d) => d.route === line && d.destination === destination);
    const anunciado = row ? { route: row.route, pass: row.pass, unit: row.unit } : null;
    if (!this.journeys.begin(this.journeyContext(), platform.id, destination, anunciado)) {
      this.interiors.say('Sem linha do telão até esse destino');
      return false;
    }
    useGameStore.closeDepartures();
    sound.play('uiSwitch', 0.5);
    return true;
  }

  /** A linha do objetivo na HUD enquanto a viagem estiver de pé. */
  journeyStatus(): string | null {
    return this.journeys.journey ? this.journeys.status(this.journeyContext()) : null;
  }

  /**
   * O que a fronteira sabe do jogador agora, numa leitura só.
   *
   * Existe porque a HUD desenha a mesma dívida em dois lugares — a linha de texto e a barra — e
   * duas leituras separadas quereriam dizer coisas diferentes no quadro em que o nadador cruza a
   * margem: a linha falaria do gigante enquanto a barra ainda mostrasse o rio. Quem decide qual
   * fera cobra é `noRioSemFim`, e só pode haver um lugar no jogo onde essa pergunta é feita.
   */
  private frontierLeitura() {
    // Sala aberta congela a rua: lá dentro o corpo é uma coordenada do plano da sala, e uma
    // profundidade lida dela apontaria uma fronteira que não existe.
    if (this.interiors.active) return null;
    const { worldW: W, worldH: H } = this.map;
    const p = this.worldPosition;
    const nadando = noRioSemFim(this.player, W, H, this.map);
    const fera = nadando ? this.piranhas.fera : this.gorilas.fera;
    // As duas feras medem o perigo na mesma régua (dívida / limiar da caçada), então a HUD lê um
    // número só. Fora da água a piranha não pode estar caçando ninguém, e ler `piranhas.perigo`
    // sempre faria a linha da mata acusar um perigo que não existe.
    const perigo = Math.max(this.gorilas.perigo, nadando ? this.piranhas.perigo : 0);
    // A aldeia é lida na mesma respiração porque está *dentro* dessa mesma terra: a banda do
    // gigante termina na porta deles, e quem atravessa o mapa para fora troca de cobrador no meio
    // do nada. `perigo` não entra na barra das feras — são duas medidas diferentes (dívida até a
    // caçada x quantos olhos estão em você), e uma barra que aceitasse as duas ensinaria o
    // jogador a não confiar nela.
    const aldeia = this.tribos.aldeiaEmDisputa() !== null;
    // O manche que parou de responder é a fronteira mais literal do jogo: quem voa além da borda
    // não vê profundidade nenhuma, vê o aviso de que caiu. A linha tem de existir mesmo com o
    // casco de volta sobre o mapa, senão o jogador acorda "sem motor" dentro da cidade e acusa o
    // buggy que não existe.
    return {
      W, H, p,
      prof: profundidade(p.x, p.y, W, H),
      nadando,
      perigo,
      semMotor: this.quedas.semMotor(this.player.currentVehicleId),
      caçado: !!fera && !fera.morto,
      aldeia,
    };
  }

  /**
   * A frase da fronteira na HUD, ou `null` em território conhecido.
   *
   * É lida pelo polling de 200 ms da HUD, não por um evento, porque a fronteira não tem porta,
   * letreiro nem horário: o que há é uma distância crescendo debaixo do pé de quem anda, e a
   * única forma de o jogador descobrir que está sendo cobrado é ver o número antes de ouvir o
   * urro. Sem esta linha a caçada começaria com um corpo no meio da tela e nenhuma explicação.
   */
  frontierStatus(): string | null {
    const ler = this.frontierLeitura();
    if (!ler) return null;
    const { W, H, p, prof, nadando, perigo, semMotor, caçado, aldeia } = ler;
    // Dentro do mapa e sem dívida a mata é só paisagem: uma linha fixa dizendo "nada" seria a
    // primeira coisa ensinada a ser ignorada na HUD.
    if (prof <= 0 && perigo <= 0.02 && !semMotor) return null;
    const face = faceDaFronteira(p.x, p.y, W, H);
    // A palavra é de quem está cobrando agora. O bando vem primeiro não por preferência de tema,
    // mas porque as duas posse nunca se sobrepõem de verdade (a banda do gigante para na porta
    // deles e o rio é do peixe): se a aldeia nomeou o lugar, a caçada da mata é outra terra.
    return `FRONTEIRA · ${nadando ? 'rio sem fim' : nomeDaTerra(prof)} ${Math.round(prof)}t`
      + `${face ? ` · ${face}` : ''} · `
      + (semMotor ? 'SEM MOTOR' : aldeia ? 'ALDEIA ACORDADA'
        : caçado ? 'CAÇADO' : perigo >= 0.5 ? 'aviso' : 'quieta');
  }

  /**
   * A dívida da barra e a fera que a está cobrando. É a mesma leitura da linha de texto, e é por
   * isso que existe um método em vez de o HUD ler `game.gorilas.perigo`: no rio quem cobra não é o
   * gigante, e uma barra que mostra o rancor errado ensinaria o jogador a não confiar nela.
   */
  frontierDanger(): { perigo: number; caçado: boolean } {
    const ler = this.frontierLeitura();
    return ler ? { perigo: ler.perigo, caçado: ler.caçado } : { perigo: 0, caçado: false };
  }

  /**
   * O índice da unidade que a tela deve marcar com a seta, ou `null` para não marcar nenhuma.
   * A ordem é a da viagem, não a da conveniência do desenho: com plano de pé, o ônibus certo é o
   * que serve a passada prometida pelo horário — mesmo que outro veículo tenha a porta aberta
   * agora na mesma calçada, porque embarcar no que encostou primeiro é descer do outro lado da
   * cidade uma volta depois. Sem plano, o ônibus certo é simplesmente o que está com a porta
   * aberta para quem está a pé. Dentro de uma sala não há seta nenhuma: lá o `x`/`y` do corpo é
   * uma coordenada do plano da sala, e medir alcance de porta com ela apontaria um ônibus
   * qualquer na parede do hall.
   */
  busTarget(): number | null {
    if (this.interiors.active) return null;
    const journey = this.journeys.journey;
    const leg = journey ? journey.legs[journey.leg] : undefined;
    if (journey && leg) {
      const aguardado = this.transport.expectedUnit(leg.route, leg.pass);
      if (aguardado !== null) return aguardado;
    }
    return this.transport.boarding(this.player);
  }

  private journeyContext(): JourneyContext {
    return {
      player: this.player,
      map: this.map,
      transport: this.transport,
      world: this.worldPosition,
      // O pino do GPS é o do plano, não o do jogador: a perna a pé termina na calçada, e é
      // ela que tem de aparecer no mapa cheio e no radar.
      mark: (x, y) => {
        const from = this.worldPosition;
        this.journeyMark = { x, y };
        useGameStore.setMapDestination(x, y, buildGpsRoute(this.map, from.x, from.y, x, y, false));
      },
      clearMark: () => {
        const mark = this.journeyMark;
        if (!mark) return;
        this.journeyMark = null;
        const st = useGameStore.getState();
        if (st.mapMarker && Math.hypot(st.mapMarker.x - mark.x, st.mapMarker.y - mark.y) < 1e-6) {
          useGameStore.clearMapMarker();
        }
      },
      say: (text) => this.interiors.say(text, 3.2),
    };
  }

  private interiorContext(): InteriorContext {
    return {
      player: this.player,
      heal: () => this.health.heal(this.player, 100),
      grantGun: (id) => {
        const fresh = this.weapons.acquire(id);
        if (fresh) this.weapons.equipped = id;
        return fresh;
      },
      refillOwned: () => {
        if (!GUN_IDS.some((id) => this.weapons.owned.has(id))) return false;
        this.weapons.refill();
        return true;
      },
      feed: (health, stamina) => {
        this.health.heal(this.player, health);
        this.player.stamina = Math.min(1, this.player.stamina + stamina);
      },
      // O balcão cobrou: o registro é limpo pelo WantedSystem e a rua volta a ficar calma.
      clearRecord: () => {
        this.wanted.clear(this.player);
        this.police.reset();
      },
      onUse: () => {
        const room = this.interiors.active;
        sound.play(room?.shop || room?.service.action === 'bail' ? 'coin' : 'healthPickup', 0.45);
      },
      onOpenShop: () => useGameStore.openShop(),
      onOpenDepartures: () => useGameStore.openDepartures(),
      onTransition: () => this.afterInteriorTransition(),
    };
  }

  /** Câmera, inputs e som depois de cruzar uma porta — vale para entrar e para sair. */
  private afterInteriorTransition() {
    useGameStore.closeShop();
    useGameStore.closeDepartures();
    this.jump.cancel(this.player);
    this.exploration.breakTrail();
    this.exploration.update({ position: this.worldPosition, outdoors: true });
    resetActionInput();
    resetJoystickInput();
    setRunHeld(false);
    this.weapons.suspend();
    this.weapons.tracers.length = 0;
    this.camera = createCamera(this.player.x, this.player.y);
    const room = this.interiors.active;
    this.camera.zoom = room
      ? indoorZoom(room.map.worldW, room.map.worldH, this.viewW, this.viewH)
      : GAME_CONFIG.ZOOM_DEFAULT;
    this.clampCamera();
    // Trocar de cenário é corte, não travessia: a cota nova vale na hora, senão a sala
    // abriria descendo a rampa do morro que ficou do lado de fora da porta.
    this.snapCameraHeight();
    // A cadeia só existe enquanto a sala dela está aberta.
    if (room?.kind === 'jail') this.jail.enter();
    else this.jail.leave();
    // Nas outras salas o elenco é da própria casa: ninguém atravessa a parede para fugir.
    if (room) this.crowd.enter(room);
    else this.crowd.leave();
    sound.play('uiSwitch', 0.35);
    this.notifyEntityChange();
  }

  private jailContext(): JailContext {
    return {
      player: this.player,
      damagePlayer: (amount) => this.health.damage(this.player, amount, this.time),
      raiseWanted: (stars) => this.wanted.raise(this.player, stars),
      releaseInmate: (inmate) => this.releaseToStreet(inmate),
      grantGun: (id) => {
        const fresh = this.weapons.acquire(id);
        if (fresh) this.weapons.equipped = id;
        return fresh;
      },
      say: (text) => this.interiors.say(text),
      notify: () => this.notifyEntityChange(),
    };
  }

  private crowdContext(room: InteriorRoom): CrowdContext {
    return {
      player: this.player,
      room,
      collision: this.collision,
      shot: this.weapons.fireFlash > 0,
      melee: this.player.attackTimer > 0,
      notify: () => this.notifyEntityChange(),
    };
  }

  /** Solto de verdade: o ex-preso sai pela porta da delegacia e vira pedestre da cidade. */
  private releaseToStreet(inmate: JailOccupant) {
    const door = this.interiors.jailEntrance;
    if (door) {
      inmate.x = door.x;
      inmate.y = door.y;
    }
    inmate.free = false;
    inmate.state = 'idle';
    inmate.anim = 'idle';
    inmate.frame = 0;
    inmate.speed = 0;
    this.npcs.push(inmate);
    this.notifyEntityChange();
  }

  private handleVehicleInput(): boolean {
    const player = this.player;
    const wasInVehicle = player.currentVehicleId !== null;
    const wasAboard = player.busUnit !== null;

    if (consumeEnter()) {
      if (wasAboard) {
        // Dentro do ônibus a única porta que abre é a da calçada. Sair no meio do trajeto
        // seria um atalho sem representação no mundo — o que a rede de transporte proíbe —
        // então o que se ouve é a porta trancada e o horário segue sem passageiro nenhum.
        if (this.transport.alight(player, this.map, this.collision)) {
          this.exitLock = GAME_CONFIG.VEHICLE_EXIT_COOLDOWN;
        } else {
          sound.play('doorClose', 0.45);
        }
      } else if (!wasInVehicle && this.interiors.nearest(player) && !this.interaction.nearestVehicle(player, this.vehicles)) {
        return this.useInterior();
      } else if (wasInVehicle) {
        this.interaction.tryExit(player, this.vehicles, this.map, this.collision);
        this.exitLock = GAME_CONFIG.VEHICLE_EXIT_COOLDOWN;
      } else if (this.exitLock <= 0) {
        // O ônibus parado na calçada tem prioridade sobre o carro estacionado ao lado: foi o
        // que o jogador escolheu ao esperar no ponto, e o carro ele pode roubar a qualquer
        // momento. Dentro de um ônibus não se rouba nada — ele obedece ao horário.
        const onibus = this.transport.boarding(player);
        if (onibus !== null) {
          this.transport.board(player, onibus);
        } else {
          const target = this.interaction.nearestVehicle(player, this.vehicles);
          const stolen = this.trafficSystem.tryStealCar(player, this.vehicles, this.npcs);
          if (stolen) {
            sound.play('glassBreak', 0.65);
            this.wanted.raise(player, GAME_CONFIG.WANTED_STEAL);
            this.pickups.spawnDrop(player.x, player.y, 40 + Math.floor(this.rnd() * 80));
          } else if (target && this.interaction.tryEnter(player, this.vehicles) && player.currentVehicleId === target.id) {
            // `occupied` é NPC no banco: assaltar é tirar quem dirige. O TrafficSystem devolve o
            // motorista do trânsito à calçada e o PoliceSystem despeja a guarnição da viatura.
            const police = target.def.type === 'police' || target.def.type === 'swat';
            if (target.occupied || police) sound.play('glassBreak', 0.65);
            if (police) this.wanted.raise(player, GAME_CONFIG.WANTED_STEAL + 1);
            this.trafficSystem.takeOver(target.id);
          }
        }
      }
    }
    if ((player.currentVehicleId !== null) !== wasInVehicle || (player.busUnit !== null) !== wasAboard) {
      this.jump.cancel(player);
      this.notifyEntityChange();
      sound.play(isAboard(player) ? 'doorOpen' : 'doorClose', 0.55);
    }
    return false;
  }

  private handleMovement(dt: number) {
    const player = this.player;
    const inVehicle = player.currentVehicleId !== null;
    const vehicle = inVehicle ? this.vehicles.find((v) => v.id === player.currentVehicleId) ?? null : null;
    const honk = consumeHorn();

    if (inVehicle && vehicle) {
      if (honk) this.soundHorn();
      const flying = vehicle.def.type === 'helicopter';
      const bfx = vehicle.x;
      const bfy = vehicle.y;
      this.movement.updateVehicle(vehicle, this.map, dt, this.altitude.snapshot);
      if (!flying) {
        const vc = {
          x: vehicle.x,
          y: vehicle.y,
          radius: Math.max(
            GAME_CONFIG.VEHICLE_RADIUS,
            Math.min(vehicle.def.footprintW, vehicle.def.footprintH) * 0.32,
          ),
        };
        const nearby = this.map.queryNearby(vehicle.x, vehicle.y, 2.5);
        this.collision.resolveCircle(vc, nearby);
        this.collision.resolveCircleVsVehicles(vc, this.vehicles, vehicle.id);
        vehicle.x = vc.x;
        vehicle.y = vc.y;

        const expectedMove = Math.abs(vehicle.speed) * dt * 0.55;
        const moved = Math.hypot(vehicle.x - bfx, vehicle.y - bfy);
        if (this.hitCooldown <= 0 && Math.abs(vehicle.speed) > 1.1 && moved < expectedMove) {
          sound.play('metalHit', 0.5);
          if (Math.abs(vehicle.speed) > 2.0) {
            sound.play('glassBreak', 0.3);
            vehicle.health -= 6;
          }
          this.applyCrashDamage(Math.abs(vehicle.speed), vehicle);
          this.hitCooldown = 0.35;
        }
        this.hitCooldown -= dt;
      }

      player.x = vehicle.x;
      player.y = vehicle.y;
      player.direction = vehicle.dir;
      player.facingAngle = vehicle.facingAngle;
      player.vx = 0;
      player.vy = 0;
      player.swimming = false;
    } else if (player.busUnit !== null) {
      // passageiro: o joystick não empurra quem está dentro de um veículo do horário.
      player.vx = 0;
      player.vy = 0;
      player.speed = 0;
      player.swimming = false;
      this.stamina.update(player, dt, false, false);
    } else if (!this.interiors.active && this.tribos.arrastado) {
      // Prisioneiro: o corpo na ponta da corda não obedece ao manche, pelo mesmo motivo do
      // passageiro e com uma razão a mais — aqui há quem esteja escrevendo estas duas coordenadas
      // no fim do tick, e um passo tentado contra o arrasto seria desfazido no mesmo quadro, com o
      // sprite andando e o lugar não. A perna que se cansa é a dele: sem esforço, o fôlego volta.
      player.vx = 0;
      player.vy = 0;
      player.speed = 0;
      player.swimming = false;
      this.stamina.update(player, dt, false, false);
    } else if (!this.interiors.active && this.cativeiro.amarrado) {
      // Amarrado: aqui o manche não leva a lugar nenhum porque já há quem decida o pé — o poste. O
      // `arrastado` acima tira o joystick do caminho por um motivo (um corpo em movimento), este o
      // tira por outro: não existe passo que não seja desfazido pelo `empurraDoAcampamento` no
      // quadro seguinte, e um sprite andando parado seria a única coisa na tela mentindo sobre a
      // mecânica. O que o manche **faz** é o esforço: a leitura do lado é a mão puxando a corda, e
      // é por isto que o `dx` continua sendo lido aqui, no ramo que proíbe andar.
      player.vx = 0;
      player.vy = 0;
      player.speed = 0;
      player.swimming = false;
      this.cativeiro.puxa(inputState.dx);
      this.stamina.update(player, dt, false, false);
    } else {
      const wantsRun = inputState.runHeld && !player.crouching;
      const moving = inputState.magnitude > GAME_CONFIG.JOYSTICK_DEADZONE;
      // Dentro de casa a rua não alcança ninguém: as coordenadas da sala não são do mundo.
      const wading = this.interiors.active ? false : this.hazard.floodedAt(player.x, player.y);
      this.movement.updatePlayer(player, this.activeMap, dt,
        wantsRun && this.stamina.canSprint(player), wading);
      this.stamina.update(player, dt, wantsRun, moving);
    }
  }

  /** Buzina do motorista: o carro do jogador soa, assusta a fauna e um carro preso responde. */
  private soundHorn() {
    if (this.hornCooldown > 0) return;
    this.hornCooldown = 0.55;
    this.hornNoise = 0.6;
    sound.play('carHorn', 0.85);
    this.trafficSystem.honk(this.player);
  }

  private policeContext(player = this.player): PoliceContext {
    return {
      map: this.map, player, concealed: this.interiors.active !== null,
      vehicles: this.vehicles, npcs: this.npcs, collision: this.collision,
      health: this.health, wanted: this.wanted, time: this.time,
      night: this.dayNight.isNight,
      sky: this.skyDaRonda(),
      allocVehicleId: () => this.nextVehicleId++, allocNpcId: () => this.nextNpcId++,
      onStructChange: () => this.notifyEntityChange(), onBusted: () => this.bust(),
      shake: (amount) => this.shake(amount), rng: this.rnd,
    };
  }

  private skyDaRondaCache: AirSky | null = null;

  /**
   * A leitura de ar que a ronda policial faz do nosso céu: o pé-direito da manta e a espessura de
   * nuvem entre dois andares. Uma ficha só para o mundo inteiro — o `PoliceContext` é reconstruído a
   * cada quadro, e um objeto novo ali seria lixo por quadro dentro do laço da polícia.
   */
  private skyDaRonda(): AirSky {
    if (!this.skyDaRondaCache) {
      const ar = this.altitude;
      this.skyDaRondaCache = {
        get base() { return ar.daBase; },
        obstrucao: (x, y, de, ate, tempo) => ar.obstrucao(x, y, de, ate, tempo),
      };
    }
    return this.skyDaRondaCache;
  }

  /**
   * O que os oficiais empenhados enxergam agora, para o radar desenhar. Nada aqui lê a
   * posição do jogador: o cone pertence ao policial, então a HUD não vira raio-x.
   */  policeVisionCones(): VisionCone[] {
    // O cone pertence à rua. Dentro de uma sala o radar mostra o plano do interior, e a
    // posição real do jogador não existe no mapa — nada aqui pode desenhá-la.
    if (this.interiors.active) return [];
    return this.police.visionCones(this.policeContext());
  }

  private witnessContext(player = this.player): WitnessContext {
    return {
      map: this.map, player, npcs: this.npcs, vehicles: this.vehicles,
      onReport: (incident) => {
        this.wanted.raise(this.player, Math.max(0.5, incident.severity - this.player.wantedLevel));
        this.police.report(incident);
      },
      onCallStart: () => sound.play('uiSwitch', 0.18),
    };
  }

  private reportCrime(incident: CrimeIncident) {
    if (!this.interiors.active) this.witnesses.observe(incident, this.witnessContext());
  }

  private handleWeaponInput(dt: number, attack: boolean, reload: boolean, weapon: -1 | 0 | 1) {
    const player = this.player;
    const room = this.interiors.active;
    const ctx = {
      player,
      npcs: !room ? this.npcs : room.kind === 'jail' ? this.jail.occupants : this.crowd.list,
      vehicles: room ? [] : this.vehicles,
      animals: room ? [] : this.wildlife.animals,
      // O gigante é o único alvo do mundo que não é uma lista: um por mundo, e `alvo` já devolve
      // `null` para o cadáver, então quem atira no corpo caído não ganha dois prêmios.
      gorila: room ? null : this.gorilas.alvo,
      onGorilaHit: (damage) => { if (this.gorilas.fere(damage)) this.notifyEntityChange(); },
      // A outra fera da fronteira, pela mesma porta e pelo mesmo motivo: um corpo por mundo, o
      // cadáver deixa de ser alvo, e o tiro que a acerta é o que ela usa para ficar mais rápida.
      piranha: room ? null : this.piranhas.alvo,
      onPiranhaHit: (damage) => { if (this.piranhas.fere(damage)) this.notifyEntityChange(); },
      // O bando inteiro, não um alvo por mundo: são corpos com id, e a arma precisa poder acertar
      // o segundo depois de derrubar o primeiro. A porta devolve o id junto com o dano porque é o
      // sistema que sabe qual corpo caiu — e um companheiro caindo é o que acende os outros.
      guerreiros: room ? [] : this.tribos.alvos(),
      onGuerreiroHit: (id, damage) => { if (this.tribos.fere(id, damage)) this.notifyEntityChange(); },
      onCrime: (incident) => this.reportCrime(incident),
      map: this.activeMap,
      wanted: this.wanted,
      pickups: this.dropTarget(room),
      aim: effectiveAim(player.facingAngle),
      onStructChange: () => this.notifyEntityChange(),
      shake: (a) => this.shake(a),
      rng: this.rnd,
    } satisfies WeaponContext;
    const blocked = isAboard(player) || player.swimming || player.health <= 0 || player.state === 'dead';
    if (!blocked && weapon) this.weapons.cycle(weapon);
    // Cancel reload before its timer can finish on the vehicle/water entry tick.
    this.weapons.updateAim(ctx);
    this.weapons.update(dt);
    if (blocked) {
      resetActionInput();
      return;
    }
    if (reload) this.weapons.reload(ctx);
    const equipped = this.weapons.equipped;
    if (isGunId(equipped)) {
      this.weapons.tryFire(ctx, { pressed: attack, held: inputState.attackHeld });
    } else if (attack) {
      this.combat.tryAttack({ ...ctx, time: this.time }, equipped === 'bat' ? 'bat' : 'unarmed');
    }
  }

  /**
   * Dentro de uma sala as coordenadas são locais e o pickup é do mundo: o espólio de quem
   * cai ali cai na calçada, na porta, senão ficaria inalcançável num mapa que não existe.
   */
  private dropTarget(room: InteriorRoom | null): Pick<PickupSystem, 'spawnDrop' | 'spawnWeaponDrop'> {
    if (!room) return this.pickups;
    const { x, y } = room.entrance;
    return {
      spawnDrop: (_x, _y, amount) => this.pickups.spawnDrop(x, y, amount),
      spawnWeaponDrop: (_x, _y, gun) => this.pickups.spawnWeaponDrop(x, y, gun),
    };
  }

  // ---------------------------------------------------------------- streaming

  /**
   * câmera → footprint → chunks → o que existe neles. A cadeia inteira anda por aqui, uma vez
   * por tick, e o `notifyEntityChange` só dispara quando o CONJUNTO de chunks muda — meio tile
   * de câmera não acorda o render.
   */
  private updateStreaming() {
    const changed = this.streaming.update({
      ax: this.camera.x,
      ay: this.camera.y,
      zoom: this.camera.zoom,
      viewBounds: this.fog.worldBounds(this.fog.view(this)),
    });
    this.streaming.stats.totalEntities =
      this.npcs.length + this.vehicles.length + this.wildlife.animals.length +
      this.destruction.wrecks.length;
    if (changed) this.notifyEntityChange();
  }

  /**
   * Recarrega a grade do que se move, no fim do tick, depois de todo mundo ter andado. É a
   * única forma de as camadas perguntarem "quem está nesta janela?" sem varrer a cidade.
   */
  private rebuildSpatial() {
    const s = this.spatial;
    s.rebuild('npc', this.npcs, (n) => n.x, (n) => n.y);
    s.rebuild('veh', this.vehicles, (v) => v.x, (v) => v.y);
    s.rebuild('animal', this.wildlife.animals, (a) => a.x, (a) => a.y);
    s.rebuild('wreck', this.destruction.wrecks, (w) => w.x, (w) => w.y);
    const z = this.streaming.zones;
    this.streaming.stats.activeNpcs = s.countIn('npc', z.active);
    this.streaming.stats.simulatedEntities = this.streaming.stats.activeNpcs +
      s.countIn('veh', z.active);
  }

  /**
   * Quem está no asfalto em volta de um ponto, entregue ao ônibus corpo por corpo. É a rua que a
   * malha não dirige — carros do trânsito, pedestres, bichos e o próprio jogador a pé —, e sem
   * ela o freio do ônibus só enxerga o próprio horário: dois ônibus combinando de não se encostar
   * enquanto um sedã atravessa a faixa dele, que é o "eles atravessam carros" da tela.
   *
   * Três contas mandam aqui. A primeira é o tipo de corpo: lataria (`mole: false`) disputa asfalto
   * com corrente e recuo, corpo vivo (`mole: true`) é sempre cedido e nunca empurrado — dar ré num
   * pedestre que atravessou é pior do que o atraso que ele causa. A segunda é a lataria dele
   * mesmo: um pedestre do tamanho de um ônibus estreitaria a faixa de um ponto em meio tile para
   * cada lado, e cada pessoa parada no meio-fio prenderia a linha inteira; por isso cada corpo
   * traz `meio` e `flanco` próprios. A terceira é o recorte: só pisa na rua quem está num tile de
   * via, porque um cachorro deitado na grama não pode parar um ônibus que passa do outro lado do
   * canteiro, do mesmo jeito que o `pedestrianStopDistance` do trânsito já exige o asfalto.
   *
   * O buffer da grade é emprestado por tipo e vale até a próxima consulta do MESMO tipo, então cada
   * varredura é consumida antes da seguinte. O corpo visitado é o `corpoVisitado` desta instância:
   * quem quiser guardar um tem de copiar, e o `TransportSystem` copia para o próprio risco.
   */
  private varreRua(x: number, y: number, raio: number, visita: (corpo: RuaCorpo) => void): void {
    const caixa = this.caixaDaRua;
    caixa.minX = x - raio; caixa.maxX = x + raio;
    caixa.minY = y - raio; caixa.maxY = y + raio;
    const corpo = this.corpoVisitado;

    // Lataria primeiro: é o corpo que disputa a faixa, e o recuo dele já tem corrente própria.
    for (const i of this.spatial.query('veh', caixa)) {
      const v = this.vehicles[i];
      if (!v || v.state === 'destroyed' || !v.def.driveable || v.altitude > 0.5) continue;
      const dx = v.x - x, dy = v.y - y;
      if (dx * dx + dy * dy > raio * raio) continue;
      corpo.x = v.x; corpo.y = v.y;
      corpo.angle = v.facingAngle;
      corpo.speed = v.speed;
      corpo.meio = Math.max(v.def.footprintW, v.def.footprintH) / 2;
      corpo.flanco = Math.min(v.def.footprintW, v.def.footprintH) / 2;
      corpo.mole = false;
      visita(corpo);
    }

    // Pedestre e bicho depois: corpo mole, que o ônibus cede o passo e nunca empurra.
    //
    // Congelado não segura fila. O mundo para de simular quem está longe da câmera — o pedestre
    // além do `NPC_SIM_FAR`, o bicho fora das fichas do `WildlifeSystem` — e o corpo fica no
    // asfalto com a velocidade do último quadro escrita nele: um javali `fleeing` a 3,15 tiles por
    // segundo que não anda um milímetro. O ônibus que freia para esse corpo planta o pé com a
    // dívida inteira (um segundo de atraso por segundo de relógio) e espera por algo que o mundo
    // decidiu não mover mais: foi assim que a linha 16 ficou parada 30 s e o passageiro nunca
    // chegou à calçada. O trânsito já tem esta regra (`pedestrianStopDistance`) e é a mesma que
    // vale aqui — quem atravessa a faixa de verdade continua parado o ônibus, porque quem está
    // sendo simulado está nesta lista.
    const px = this.player.x, py = this.player.y;
    const longeDoMundo2 = GAME_CONFIG.NPC_SIM_FAR * GAME_CONFIG.NPC_SIM_FAR;
    for (const i of this.spatial.query('npc', caixa)) {
      const n = this.npcs[i];
      if (!n || n.dead || n.inVehicle) continue;
      const dx = n.x - x, dy = n.y - y;
      if (dx * dx + dy * dy > raio * raio) continue;
      const pdx = n.x - px, pdy = n.y - py;
      if (n.kind !== 'cop' && n.state !== 'fleeing' && pdx * pdx + pdy * pdy > longeDoMundo2) continue;
      if (this.map.tileKindAt(n.x, n.y) !== 'road') continue;
      corpo.x = n.x; corpo.y = n.y;
      corpo.angle = dirToAngle(n.dir);
      corpo.speed = n.speed;
      corpo.meio = corpo.flanco = GAME_CONFIG.NPC_RADIUS;
      corpo.mole = true;
      visita(corpo);
    }

    for (const i of this.spatial.query('animal', caixa)) {
      const a = this.wildlife.animals[i];
      if (!a || a.dead || !a.simulated) continue;
      const dx = a.x - x, dy = a.y - y;
      if (dx * dx + dy * dy > raio * raio) continue;
      if (this.map.tileKindAt(a.x, a.y) !== 'road') continue;
      corpo.x = a.x; corpo.y = a.y;
      corpo.angle = a.moveX || a.moveY ? Math.atan2(a.moveY, a.moveX) : dirToAngle(a.dir);
      corpo.speed = a.speed;
      corpo.meio = corpo.flanco = a.radius;
      corpo.mole = true;
      visita(corpo);
    }

    // O jogador a pé é o pedestre mais importante da rua: é ele que o ônibus não pode passar por
    // cima. Dentro de uma sala ele não existe no mapa, e num ônibus do horário ele já é lataria do
    // próprio ônibus — nos dois casos não há corpo mole a visitar.
    const p = this.player;
    if (!this.interiors.active && !isAboard(p) && p.health > 0) {
      const dx = p.x - x, dy = p.y - y;
      if (dx * dx + dy * dy <= raio * raio && this.map.tileKindAt(p.x, p.y) === 'road') {
        corpo.x = p.x; corpo.y = p.y;
        corpo.angle = p.facingAngle;
        corpo.speed = p.speed;
        corpo.meio = corpo.flanco = GAME_CONFIG.PLAYER_RADIUS;
        corpo.mole = true;
        visita(corpo);
      }
    }
  }

  // ---------------------------------------------------------------- npcs

  private updateNpcs(dt: number, player = this.player) {
    // Varrer os 400 pedestres da cidade inteira a cada tick era o "todos os objetos → um por
    // um". A grade entrega só quem está na janela ativa; o teste de distância abaixo é o de
    // sempre e a janela é uma CIRCUNSCRIÇÃO dele (raio + margem de chunk), nunca um corte a mais.
    const nearby = this.spatial.query('npc', this.streaming.zones.active);
    for (const i of nearby) {
      const npc = this.npcs[i];
      if (!npc) continue;
      const wasDead = npc.dead;
      // cops são dirigidos pelo PoliceSystem (a pé) ou pelo carro (dentro)
      if (npc.kind === 'cop') {
        if (npc.dead && !wasDead) this.notifyEntityChange();
        continue;
      }
      if (!npc.dead && !npc.inVehicle) {
        const dist = Math.hypot(npc.x - player.x, npc.y - player.y);
        const fleeing = npc.state === 'fleeing';
        if (!fleeing && dist > GAME_CONFIG.NPC_SIM_FAR) {
          // congelado longe da câmera
        } else if (!fleeing && dist > GAME_CONFIG.NPC_SIM_NEAR && npc.state === 'idle') {
          npc.patienceTimer -= dt * 350;
        } else if (!fleeing && dist > GAME_CONFIG.NPC_SIM_NEAR && npc.state === 'walking') {
          if ((Math.floor(this.time * 28) + npc.id) % 2 === 0) {
            this.npcSystem.update(npc, this.map, this.vehicles, dt, player.x, player.y, player.wantedLevel,
              this.trafficSystem.signalSystem);
          }
        } else {
          this.npcSystem.update(npc, this.map, this.vehicles, dt, player.x, player.y, player.wantedLevel,
            this.trafficSystem.signalSystem);
        }
      }
      if (npc.dead && !wasDead) this.notifyEntityChange();
    }
  }

  // ---------------------------------------------------------------- áudio ambiente

  /** Called when the UI freezes the sim (menu, pause, map, round overlay): nothing may keep playing. */
  suspendEnvironment() {
    this.ambient.suspend();
    sound.stopLoops();
  }

  private updateEnvironment(dt: number) {
    const position = this.worldPosition;
    // Fora da grade o tile não existe, mas a beira existe: a névoa da terra sem nome é a do bioma
    // que o limite do mapa tinha, pela mesma regra que veste o chão sem fim. O `?? 'residential'`
    // cru fazia duas coisas erradas de uma vez — o índice linear atravessava para a linha vizinha
    // quando x ou y saíam da grade, e onde ele acertava um tile de verdade vestia a parede da
    // moldura com a cor do asfalto sobre um chão de pinheiro. Num dia fechado a moldura é quase
    // tudo o que se vê, e era ela que mentia.
    const biome = this.map.biomeAt(position.x, position.y)
      ?? biomaDaFronteira(this.map.data.tiles, this.map.data.tilesW, this.map.data.tilesH,
        Math.floor(position.x), Math.floor(position.y));
    this.biomeAtCamera = biome;
    const environment = { timeOfDay: this.dayNight.t, rain: this.weather.intensity + this.hazard.wet,
      cover: this.weather.cover, mist: this.weather.mist, dark: this.hazard.dark, biome };
    this.fog.update(dt, environment);
    this.ambient.update(dt, {
      ...environment,
      outdoors: !this.interiors.active,
      snow: this.weather.snowing,
      hazardBed: this.hazard.bed,
      hazardVolume: this.hazard.bedVolume,
    });
  }

  private hazardContext(): HazardContext {
    return {
      indoors: !!this.interiors.active || this.jail.inside,
      season: this.weather.season,
      weather: this.weather.kind,
      camera: this.camera,
      terrain: this.map,
      onAlert: () => sound.play('weatherAlert', 0.75),
    };
  }

  private hazardSweepContext(indoors: boolean): HazardSweepContext {
    return {
      time: this.time,
      indoors,
      player: this.player,
      npcs: this.npcs,
      vehicles: this.vehicles,
      animals: this.wildlife.animals,
      health: this.health,
      clamp: (body) => {
        this.collision.resolveCircle(body, this.map.queryNearby(body.x, body.y, 2));
      },
      shake: (amount) => this.shake(amount),
      onStructChange: () => this.notifyEntityChange(),
    };
  }

  /**
   * O que a correnteza alcança agora. É a mesma varredura do perigo, só que de um lugar
   * parado: sem `shake` nem alerta, porque a queda não anda pelo mapa — ela está onde foi
   * desenhada, e quem entra nela é que se move.
   */
  private cascadeSweepContext(indoors: boolean): CascadeSweepContext {
    return {
      time: this.time,
      indoors,
      player: this.player,
      npcs: this.npcs,
      vehicles: this.vehicles,
      animals: this.wildlife.animals,
      health: this.health,
      clamp: (body) => {
        this.collision.resolveCircle(body, this.map.queryNearby(body.x, body.y, 2));
      },
      shake: (amount) => this.shake(amount),
    };
  }

  /**
   * O que a fronteira sabe do jogador.
   *
   * `player: null` dentro de uma sala não é uma convenience: é o contrato de que a rua congela
   * com a porta. O sistema receberia `outdoorPlayer` — uma cópia, no caso da sala — e o soco
   * empurraria um corpo que não existe, deixando o real exatamente onde estava.
   *
   * O dano sai pelo `HealthSystem`, nunca por `player.health -=`: é a invulnerabilidade do
   * pós-dano que faz três marteladas em 1,15 s doerem em vez de matarem no segundo frame, e uma
   * regra própria de invulnerabilidade seria a primeira divergência do jogo.
   */
  private gorilaContext(indoors: boolean, view: FogView): GorilaContext {
    return {
      worldW: this.map.worldW,
      worldH: this.map.worldH,
      player: indoors ? null : this.player,
      worldPosition: this.worldPosition,
      água: this.map,
      damages: (amount) => this.health.damage(this.player, amount, this.time),
      shake: (amount) => this.shake(amount),
      say: (text, seconds) => this.interiors.say(text, seconds),
      play: (key, volume) => sound.play(key, volume),
      isVisible: (x, y) => {
        // A caixa é o corpo inteiro do bicho, não o tile do pé: um gigante cujo tronco está na
        // tela e os pés ainda não é visível, e o rugido teria de vir antes dele.
        const p = worldToScreen(x, y, this.map.heightSmoothAt(x, y));
        return this.fog.intersects(view, p.x - 60, p.y - 150, 120, 170);
      },
      onStructChange: () => this.notifyEntityChange(),
    };
  }

  /**
   * O que o rio sabe do mundo. É o espelho exato do `gorilaContext`, inclusive no `água: this.map`
   * — o `Map` real é a única autoridade sobre onde há água, dentro e fora da grade, e um segundo
   * oracle inventado aqui seria a primeira divergência entre o que o movimento pisa e o que a
   * fera persegue.
   *
   * A caixa de visibilidade é larga e baixa porque o corpo dela é assim: 140x84 de quadro ancorado
   * na linha d'água, com o salto subindo acima dela. Copiar a caixa do gigante faria o trote
   * surface soar dentro de casa.
   */
  private piranhaContext(indoors: boolean, view: FogView): PiranhaContext {
    return {
      worldW: this.map.worldW,
      worldH: this.map.worldH,
      player: indoors ? null : this.player,
      água: this.map,
      damages: (amount) => this.health.damage(this.player, amount, this.time),
      shake: (amount) => this.shake(amount),
      say: (text, seconds) => this.interiors.say(text, seconds),
      play: (key, volume) => sound.play(key, volume),
      isVisible: (x, y) => {
        const p = worldToScreen(x, y, this.map.heightSmoothAt(x, y));
        return this.fog.intersects(view, p.x - 78, p.y - 120, 156, 132);
      },
      onStructChange: () => this.notifyEntityChange(),
    };
  }

  /**
   * O que o bando sabe do mundo. Espelho dos dois anteriores nas leituras (mesma `água: this.map`,
   * mesmo `damages` pelo `HealthSystem`, mesma régua de profundidade pelo `worldPosition`) e com
   * quatro campos que as feras não têm, cada um por uma razão:
   *
   * - `vidaDoJogador` é leitura, nunca escrita. É o que permite ao golpe **parar** antes de matar:
   *   sem saber onde está o chão do alvo, o sistema só saberia machucar, e a captura viraria morte.
   * - `aPé` fecha a porta da captura para quem está num carro, numa moto, num ônibus do horário ou
   *   nadando. Ninguém arrasta um corpo que está dentro de outro corpo.
   * - `arrasta` escreve a coordenada do jogador. É a única chamada deste contexto que move o
   *   jogador, e é por ela que o tick do bando roda depois do `separate` — ver o campo `tribos`.
   * - `raioDoCorpo` é a largura do prisioneiro. O bando precisa dela para saber **onde** pousar o
   *   corpo na ponta da corda — a amarra é a soma dos dois raios — e o raio não é dele: é do
   *   jogador, e este arquivo é o único lugar do mundo que sabe quanto mede um pé aqui.
   *
   * A caixa de visibilidade é o quadro desenhado: 36x46 pixels de tela ancorados no pé, com folga
   * de um pixel e meio para cada lado. Copiar a caixa do gigante faria o tambor do bando soar
   * dentro de casa, exatamente o erro que a caixa baixa e larga da piranha existe para não repetir.
   */
  private triboContext(indoors: boolean, view: FogView): TriboContext {
    return {
      worldW: this.map.worldW,
      worldH: this.map.worldH,
      player: indoors ? null : this.player,
      worldPosition: this.worldPosition,
      água: this.map,
      damages: (amount) => this.health.damage(this.player, amount, this.time),
      vidaDoJogador: () => this.player.health,
      aPé: () => !isAboard(this.player) && !this.player.swimming,
      arrasta: (x, y) => this.tribosArrasta(x, y),
      raioDoCorpo: () => GAME_CONFIG.PLAYER_RADIUS,
      captura: (ac) => this.tribosCapturam(ac),
      shake: (amount) => this.shake(amount),
      say: (text, seconds) => this.interiors.say(text, seconds),
      play: (key, volume) => sound.play(key, volume),
      isVisible: (x, y) => {
        const p = worldToScreen(x, y, this.map.heightSmoothAt(x, y));
        return this.fog.intersects(view, p.x - 20, p.y - 48, 40, 50);
      },
      onStructChange: () => this.notifyEntityChange(),
    };
  }

  /**
   * O corpo na ponta da corda. Escreve a coordenada e apaga a intenção de andar: o `arrastado` já
   * tirou o joystick do caminho no começo do tick, e zerar o velocidade aqui é o que impede o
   * inércia de um passo anterior de continuar escorregando o prisioneiro para fora da amarra.
   * Não passa por `resolveCircle` de propósito: quem puxa já foi empurrado para fora das paredes
   * pelo `empurraDoAcampamento` dentro do sistema, e resolver o corpo do meio do caminho criaria
   * dois donos discordando do mesmo pé no mesmo quadro.
   */
  private tribosArrasta(x: number, y: number) {
    const player = this.player;
    player.x = x;
    player.y = y;
    player.vx = 0;
    player.vy = 0;
    player.speed = 0;
  }

  /**
   * O prisioneiro foi atado ao poste, e o custo é do jogo — a mecânica é do sistema. O bando revira
   * quem carrega e leva o dinheiro solto do bolso: um sequestro sem preço seria um teletransporte com
   * drama, e a alternativa — matar — é a cutscene que o pedido proibiu. A vida fica onde o abolo
   * parou (no piso do `PISO_DO_ABOLO`, nunca abaixo).
   *
   * Depois do bolso, este método entrega o acampamento ao cativeiro e **não fala mais com o
   * prisioneiro**: a frase de levada era um adeus ao centro da aldeia, e agora quem tem a última
   * palavra é a corda. O `amarra` só acende os relógios porque o corpo já foi pousado no ponto da
   * amarra pelo próprio bando, um pouco antes de chamar isto.
   */
  private tribosCapturam(ac: Acampamento) {
    const player = this.player;
    const levado = Math.min(player.money, Math.ceil(player.money * 0.25));
    if (levado > 0) player.money -= levado;
    if (levado > 0) {
      this.interiors.say(`Levaram ${levado} de você — agora se solta do poste`, 4);
    }
    this.cativeiro.amarra(ac);
    this.notifyEntityChange();
  }

  /**
   * O que o poste sabe do mundo. É o contexto mais curto da fronteira inteira de propósito: o
   * cativeiro não tem alvo, não tem ferimento e não tem coordenada própria — ele só tem dois relógios
   * e uma porta para bater quando a corda cede.
   *
   * - `player` é `null` dentro de uma sala, e isto não é uma defesa contra o impossível: é a mesma
   *   regra do bando, e ela mantém os dois relógios parados juntos. Entrar numa casa com as mãos
   *   presas não afrouxa nada, e o jogador não pode escapar de uma mecânica da rua pelo banheiro.
   * - `expulsa` é a ferramenta do gigante: `expulsaDaClareira` põe o corpo fora da jurisdição pela
   *   borda da clareira, vivo. O cativeiro não inventa um segundo destino para o fracasso porque
   *   "fora daqui" já tem dono neste mundo.
   * - `acorda` é a porta do bando, e não um `alerta = 1`: quem solta a corda devolve ao lugar a
   *   disposição de olhar, e se um sentinela tem o ex-prisioneiro no cone, o grito sai pelo caminho
   *   normal — com o aviso antes da fera.
   */
  private cativeiroContext(indoors: boolean): CativeiroContext {
    return {
      player: indoors ? null : this.player,
      aPé: () => !isAboard(this.player) && !this.player.swimming,
      acorda: (aldeiaId) => this.tribos.acorda(aldeiaId),
      expulsa: () => expulsaDaClareira(this.player, this.map.worldW, this.map.worldH, this.map),
      say: (text, seconds) => this.interiors.say(text, seconds),
      play: (key, volume) => sound.play(key, volume),
      shake: (amount) => this.shake(amount),
    };
  }

  /**
   * O que a fronteira pelo ar sabe do mundo.
   *
   * A frota inteira, não uma seleção: o céu não tem dono, e um sistema que olhasse só a máquina
   * pilotada deixaria o helicóptero estacionado no heliporto atravessar a borda ileso — a mesma
   * exceção silenciosa que a cobrança a pé não pode ter.
   *
   * `pilotado` é lido do `currentVehicleId`, e não de uma flag no casco, porque quem viaja como
   * passageiro de um motorista de trânsito não pilotei o nariz que amorteceu o pouso: a mata
   * cobra o casco dele, não o corpo dele. O dano sai pelo `HealthSystem` pela mesma razão do
   * gorila — a invulnerabilidade pós-dano é uma regra do jogo, não do sistema.
   */
  private frontierFallContext(): FrontierFallContext {
    return {
      worldW: this.map.worldW,
      worldH: this.map.worldH,
      vehicles: this.vehicles,
      pilotado: this.player.currentVehicleId,
      damages: (amount) => this.health.damage(this.player, amount, this.time),
      shake: (amount) => this.shake(amount),
      say: (text, seconds) => this.interiors.say(text, seconds),
      play: (key, volume) => sound.play(key, volume),
      cobra: (dívida) => this.gorilas.cobra(dívida),
      água: this.map,
      cobraÁgua: (dívida) => this.piranhas.cobra(dívida),
      onStructChange: () => this.notifyEntityChange(),
    };
  }

  /**
   * Volume do rugido ouvido onde o jogador está, no mesmo ritmo de 0,25s do motor: um
   * pedido por quadro ao canal nativo afogaria a ponte assíncrona por uma diferença
   * inaudível. Dentro de casa a queda fica do lado de fora do plano da sala.
   */
  private updateCascadeAudio(dt: number) {
    this.cascadeRefresh -= dt;
    if (this.cascadeRefresh > 0) return;
    this.cascadeRefresh = 0.25;
    if (this.interiors.active || !this.cascade.count) {
      sound.setLoop('cascade', null);
      return;
    }
    const position = this.worldPosition;
    const volume = this.cascade.volumeEm(position.x, position.y);
    sound.setLoop('cascade', volume > 0.02 ? 'cascade' : null, volume);
  }

  private updateEngineAudio(dt: number) {
    this.engineRefresh -= dt;
    if (this.engineRefresh > 0) return;
    this.engineRefresh = 0.25;
    const player = this.player;
    if (player.currentVehicleId === null) {
      sound.setLoop('engine', null);
      return;
    }
    const v = this.vehicles.find((x) => x.id === player.currentVehicleId);
    if (!v || v.state === 'destroyed') {
      sound.setLoop('engine', null);
      return;
    }
    const isHeli = v.def.type === 'helicopter';
    // Motor morto pela fronteira: o loop do motor é a única fonte de verdade audível de que a
    // máquina parou. Sem este silêncio o jogador ouviria o rotor girando durante a própria queda
    // e concluiria, com razão, que o controle de subida está com defeito.
    if (v.motorDead) {
      sound.setLoop('engine', null);
      return;
    }
    const load = Math.min(1, Math.abs(v.speed) / (isHeli ? GAME_CONFIG.HELI_MAX_SPEED : GAME_CONFIG.VEHICLE_MAX_SPEED));
    sound.setLoop('engine', 'engine', isHeli ? 0.34 + load * 0.3 : 0.2 + load * 0.42);
  }

  // ---------------------------------------------------------------- câmera/shake

  private updateCamera(dt: number) {
    const player = this.player;
    const inVehicle = player.currentVehicleId !== null;
    const vehicle = inVehicle ? this.vehicles.find((v) => v.id === player.currentVehicleId) ?? null : null;
    const followX = inVehicle && vehicle ? vehicle.x : player.x;
    const followY = inVehicle && vehicle ? vehicle.y : player.y;
    let lookX = 0;
    let lookY = 0;
    if (inVehicle && vehicle) {
      const look = Math.min(0.85, 0.18 + Math.abs(vehicle.speed) * 0.12);
      const sign = vehicle.speed >= 0 ? 1 : -0.45;
      lookX = Math.cos(vehicle.facingAngle) * look * sign;
      lookY = Math.sin(vehicle.facingAngle) * look * sign;
    } else if (inputState.magnitude > GAME_CONFIG.JOYSTICK_DEADZONE) {
      const direction = screenToWorld(inputState.dx, inputState.dy);
      const length = Math.hypot(direction.x, direction.y);
      lookX = direction.x / length * 0.55;
      lookY = direction.y / length * 0.55;
    }
    if (inputState.aimActive) {
      lookX = inputState.aimX * 1.2;
      lookY = inputState.aimY * 1.2;
    }
    cameraFollow(this.camera, followX, followY, lookX, lookY, dt, this.activeMap.worldW, this.activeMap.worldH);
    // O zoom antes do clamp: as margens que prendem a câmera ao mapa são medidas em pixels de
    // tela, e uma tela que acabou de alargar ainda estava sendo apertada pelo quadro anterior.
    this.easeCameraZoom(dt);
    this.clampCamera();
    this.easeCameraHeight(dt);
  }

  private updateShake(dt: number) {
    if (this.shakeAmp <= 0.005) {
      this.shakeAmp = 0;
      this.shakeX = 0;
      this.shakeY = 0;
      return;
    }
    this.shakeAmp *= Math.exp(-3.4 * dt);
    const a = this.shakeAmp * 7;
    this.shakeX = (this.rnd() * 2 - 1) * a;
    this.shakeY = (this.rnd() * 2 - 1) * a * 0.6;
  }

  // ---------------------------------------------------------------- dano/respawn

  private applyCrashDamage(speed: number, vehicle: Vehicle) {
    if (speed < GAME_CONFIG.CRASH_DAMAGE_SPEED) return;
    const dmg = (speed - GAME_CONFIG.CRASH_DAMAGE_SPEED) * 7.5;
    this.health.damage(this.player, dmg, this.time);
    vehicle.health = Math.max(0, vehicle.health - dmg * 1.15);
  }

  /** Atropelamento: o carro do jogador e o de qualquer NPC em curso, inclusive a polícia. */
  private impactContext(indoors: boolean): ImpactContext {
    return {
      map: this.map, collision: this.collision, player: this.player,
      vehicles: this.vehicles, npcs: this.npcs, animals: this.wildlife.animals,
      health: this.health, wanted: this.wanted, pickups: this.pickups, time: this.time,
      indoors, rng: this.rnd, shake: (amount) => this.shake(amount),
      onStructChange: () => this.notifyEntityChange(),
    };
  }

  private ejectFromVehicle() {
    const player = this.player;
    // O passageiro do horário não tem carro para deixar: ele perde o assento. Onde o corpo
    // vai parar é decisão de quem chamou — preso vai para a cela, morto para o hospital.
    const wasAboard = player.busUnit !== null;
    player.busUnit = null;
    if (player.currentVehicleId === null) {
      if (wasAboard) {
        player.state = 'idle';
        this.notifyEntityChange();
      }
      return;
    }
    const v = this.vehicles.find((x) => x.id === player.currentVehicleId);
    if (v) this.vehicleSystem.exitVehicle(player, v, this.map, this.collision);
    player.currentVehicleId = null;
    player.state = 'idle';
    this.notifyEntityChange();
  }

  private bust() {
    const door = this.interiors.jailEntrance;
    sound.play('busted', 0.7);
    // Com cadeia no mapa não há "ressurreção" na porta da esquadra: o preso entra.
    if (door) this.sendToJail(door);
    else this.finishRound('busted', GAME_CONFIG.BUSTED_MONEY_LOSS, 'police');
  }

  /** Levado algemado para a cela: a pena corre e a grade só abre no fim (ou com as chaves). */
  private sendToJail(door: Entrance) {
    const player = this.player;
    const sentence = JailSystem.sentenceFor(player.wantedLevel);
    this.finishRound('busted', GAME_CONFIG.BUSTED_MONEY_LOSS, 'police', true);
    this.jail.incarcerate(sentence);
    this.interiors.open(door, player);
    player.x = JAIL_CELL_SPAWN.x;
    player.y = JAIL_CELL_SPAWN.y;
    player.facingAngle = Math.PI / 2;
    player.direction = angleToWorldDir(player.facingAngle);
    this.afterInteriorTransition();
    this.interiors.say(`Preso · ${sentence} s de pena`, 4);
  }

  private waste() {
    this.finishRound('wasted', GAME_CONFIG.WASTED_MONEY_LOSS, 'hospital');
    sound.play('wasted', 0.7);
  }

  private finishRound(kind: 'busted' | 'wasted', moneyLoss: number, landmarkKind: 'police' | 'hospital', keepInside = false) {
    const player = this.player;
    this.jump.cancel(player);
    this.interiors.leave(player);
    // Sem sala, sem cela: as grades deixam de bloquear o mundo lá fora.
    this.jail.leave();
    this.crowd.leave();
    this.camera.zoom = GAME_CONFIG.ZOOM_DEFAULT;
    this.ejectFromVehicle();
    this.weapons.reset();
    resetActionInput();
    player.attackTimer = 0;
    player.swimming = false;
    player.crouching = false;
    if (!keepInside) {
      const lm = this.map.landmark(landmarkKind);
      const spawn = lm ? lm.front : this.map.data.playerSpawn;
      player.x = spawn.x;
      player.y = spawn.y;
    }
    player.vx = 0;
    player.vy = 0;
    player.state = 'idle';
    player.anim = 'idle';
    player.frame = 0;
    player.health = 100;
    this.playerDeathTimer = 0;
    player.stamina = 1;
    player.arrestTimer = 0;
    player.money = Math.max(0, player.money - moneyLoss);
    player.invulnUntil = this.time + 2.5;
    this.wanted.clear(player);
    this.witnesses.reset(this.npcs);
    this.police.reset();
    const c = { x: player.x, y: player.y, radius: GAME_CONFIG.PLAYER_RADIUS };
    this.collision.resolveCircle(c, this.activeMap.staticColliders);
    player.x = c.x;
    player.y = c.y;
    this.exploration.breakTrail();
    this.exploration.update({ position: this.activeMap === this.map ? player : this.map.data.playerSpawn, outdoors: true });
    this.notifyEntityChange();
    useGameStore.showOverlay(kind);
  }

  // ---------------------------------------------------------------- gps

  private updateGpsArrival() {
    const st = useGameStore.getState();
    if (!st.mapMarker) return;
    this.gpsRefresh -= 1 / 60;
    if (this.gpsRefresh <= 0) {
      this.gpsRefresh = 0.85;
      const driving = isAboard(this.player);
      useGameStore.refreshMapRoute(this.map, this.player.x, this.player.y, driving);
    }
    const st2 = useGameStore.getState();
    const d = Math.hypot(this.player.x - st2.mapMarker!.x, this.player.y - st2.mapMarker!.y);
    const rem =
      st2.mapRoute.length >= 2
        ? remainingRouteDistance(st2.mapRoute, this.player.x, this.player.y)
        : d;
    if (d <= 2.4 || rem <= 2.4) {
      useGameStore.clearMapMarker();
      sound.play('uiSwitch', 0.45);
    }
  }

  // ---------------------------------------------------------------- helpers antigos

  /**
   * A lataria do horário que existe no chão agora: os ônibus vivos da malha, do lado de fora de
   * uma sala e de um veículo. Dentro do ônibus não há parede — quem está sentado no banco não
   * bate na lataria em que está, e é a mesma razão que tira o pedestre da rua quando ele embarca
   * (`varreRua`). O array é devolvido vazio, nunca filtrado por fora: quem chama guarda a lista
   * entre quadros e uma lataria parada no último pixel visto é uma parede invisível.
   */
  private latariaDaRua(): readonly StreetBody[] {
    if (this.interiors.active || isAboard(this.player)) return [];
    return this.transport.bodies;
  }

  private separate(player: Player) {
    if (isAboard(player) || (player.jumpTimer > 0 && player.jumpEnd !== null)) return;
    // O empurra-empurra só diz respeito a quem está a um tile de distância. Varredura da cidade
    // inteira aqui seria trabalho de sobra: a grade responde a janela em vez disso.
    const perto = {
      minX: player.x - 1, minY: player.y - 1, maxX: player.x + 1, maxY: player.y + 1,
    };
    for (const i of this.spatial.query('npc', perto)) {
      const npc = this.npcs[i];
      if (!npc || npc.dead || npc.inVehicle || npc.state === 'chasing' || npc.state === 'knocked') continue;
      const dx = player.x - npc.x;
      const dy = player.y - npc.y;
      const d2 = dx * dx + dy * dy;
      const minD = 0.34;
      if (d2 > 0.0001 && d2 < minD * minD) {
        const d = Math.sqrt(d2);
        const push = (minD - d) / d;
        player.x += dx * push * 0.35;
        player.y += dy * push * 0.35;
        npc.x -= dx * push * 0.65;
        npc.y -= dy * push * 0.65;
      }
    }
    const body = { x: player.x, y: player.y, radius: GAME_CONFIG.PLAYER_RADIUS };
    // O array de carro por perto é reusado de um tick para o outro: o recorte do jogador roda
    // a 60 Hz, e um array novo por frame é lixo que o coletor cata no meio do desenho.
    const pertoVeh = this.nearbyVehicles;
    pertoVeh.length = 0;
    const caixa = { minX: body.x - 4, minY: body.y - 4, maxX: body.x + 4, maxY: body.y + 4 };
    for (const i of this.spatial.query('veh', caixa)) {
      const v = this.vehicles[i];
      if (v) pertoVeh.push(v);
    }
    // O ônibus do horário não é `Vehicle` — não tem lataria, motorista nem banco —, mas ele
    // ocupa a faixa, e até aqui quem andava a pé atravessava a lataria como se ela fosse de
    // fumaça. O recorte é o mesmo dos carros: quatro tiles em volta do pé.
    const pertoBus = this.nearbyBuses;
    pertoBus.length = 0;
    const naRua = this.latariaDaRua();
    for (const b of naRua) {
      if (!b.live) continue;
      if (Math.abs(b.x - body.x) > 4 || Math.abs(b.y - body.y) > 4) continue;
      pertoBus.push(b);
    }
    for (let i = 0; i < 3; i++) {
      this.collision.resolveCircleVsVehicles(body, pertoVeh);
      this.collision.resolveCircleVsBuses(body, pertoBus);
      this.collision.resolveCircle(body, this.map.queryNearby(body.x, body.y, 2));
    }
    // O empurrão de um carro também tem mundo além da borda: sem aqui, quem é atropelado
    // junto da última fila de tiles é encostado contra um nada.
    seguraNaFronteira(body, this.map.worldW, this.map.worldH, this.map);
    player.x = body.x;
    player.y = body.y;
  }

  private updateAnimations(dt: number) {
    const p = this.player;
    if (isAboard(p)) {
      p.frame = 0;
      p.animTimer = 0;
      return;
    }
    if (p.jumpTimer > 0) {
      p.anim = 'walk';
      p.frame = p.jumpHeight > 12 ? 2 : 0;
      p.animTimer = 0;
      return;
    }
    if (p.swimming) {
      p.anim = 'swim';
      if (p.speed < 0.08) {
        p.animTimer += dt * 1000;
        if (p.animTimer > 280) {
          p.animTimer = 0;
          p.frame = (p.frame + 1) % 4;
        }
        return;
      }
      p.animTimer += dt * 1000;
      const frameMs = 140;
      while (p.animTimer >= frameMs) {
        p.animTimer -= frameMs;
        p.frame = (p.frame + 1) % 4;
        if (p.frame === 0 || p.frame === 2) sound.play('stepWood', 0.28);
      }
      return;
    }
    if (p.anim !== 'walk' || p.speed < 0.12) {
      if (p.anim !== 'walk') {
        p.frame = 0;
        p.animTimer = 0;
      }
      return;
    }
    const base = p.state === 'running' ? GAME_CONFIG.WALK_CYCLE_MS * 0.72 : GAME_CONFIG.WALK_CYCLE_MS;
    const speedNorm = Math.max(0.55, Math.min(1.35, p.speed / GAME_CONFIG.PLAYER_WALK_SPEED));
    const frameMs = base / 4 / speedNorm;
    p.animTimer += dt * 1000;
    while (p.animTimer >= frameMs) {
      p.animTimer -= frameMs;
      p.frame = (p.frame + 1) % 4;
      if (p.frame === 0 || p.frame === 2) this.playFootstep();
    }
  }

  private playFootstep() {
    const { tiles, tilesW, tilesH, worldW, worldH } = this.activeMap.data;
    const tx = Math.floor(this.player.x);
    const ty = Math.floor(this.player.y);
    if (tx < 0 || ty < 0 || tx >= tilesW || ty >= tilesH || this.player.x > worldW || this.player.y > worldH) {
      sound.play('stepConcrete', 0.45);
      return;
    }
    const kind = tiles[ty * tilesW + tx].kind;
    if (kind === 'grass' || kind === 'dirt') sound.play('stepGrass', 0.45);
    else if (kind === 'water') sound.play('stepWood', 0.45);
    else if (kind === 'concrete') sound.play('softStep', 0.4);
    else sound.play('stepConcrete', 0.45);
  }

  /** Helicóptero: rotor sempre; no chão ou no ar. */
  private updateSceneryVehicles(dt: number) {
    for (const v of this.vehicles) {
      if (v.def.type !== 'helicopter' || v.state === 'destroyed') continue;
      v.animTimer += dt;
      const spin = v.occupied ? 0.05 : 0.07;
      if (v.animTimer >= spin) {
        v.animTimer = 0;
        v.animFrame = v.animFrame === 1 ? 2 : 1;
      }
      if (!v.occupied && v.altitude > 0) {
        this.movement.settleAirborne(v, this.map, dt);
      }
    }
  }
}
