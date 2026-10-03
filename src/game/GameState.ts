import { GAME_CONFIG, type Biome } from './GameConfig';
import { consumeAttack, consumeCrouch, consumeEnter, consumeHorn, consumeInteract, consumeJump, consumeReload, consumeWeapon, effectiveAim, inputState, resetActionInput, resetJoystickInput, setRunHeld } from './InputState';
import { WeaponSystem, type WeaponContext } from '../systems/WeaponSystem';
import { Map } from '../world/Map';
import { generateCity } from '../data/maps/city';
import { createCamera, cameraFollow, clampToMap, clampToRoom, indoorZoom, type CameraState } from '../world/Camera';
import { angleToWorldDir, screenToWorld, worldToScreen } from '../world/IsoUtils';
import { createPlayer, type Player } from '../entities/Player';
import { createVehicle, type Vehicle } from '../entities/Vehicle';
import { createNPC, PLAYER_DEATH_DELAY_S, type NPC } from '../entities/NPC';
import { LifeSystem } from '../systems/LifeSystem';
import { WildlifeSystem, WILDLIFE_CALL_RADIUS } from '../systems/WildlifeSystem';
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
import { DestructionSystem } from '../systems/DestructionSystem';
import { FogSystem } from '../systems/FogSystem';
import { AmbientSystem } from '../systems/AmbientSystem';
import { ExplorationSystem } from '../systems/ExplorationSystem';
import { sound } from '../audio/SoundManager';
import type { SfxKey } from '../audio/sounds';
import { useGameStore } from '../stores/useGameStore';
import { remainingRouteDistance } from '../world/Gps';
import { InteriorSystem, type Entrance, type InteriorContext, type InteriorRoom } from '../systems/InteriorSystem';
import { JailSystem, type JailContext, type JailOccupant } from '../systems/JailSystem';
import { InteriorCrowdSystem, type CrowdContext } from '../systems/InteriorCrowdSystem';
import { JAIL_CELL_SPAWN } from '../data/jail';
import { SAVE_VERSION, type SaveGame } from './SaveGame';
import { ChunkIndex } from '../world/streaming/ChunkIndex';
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
  destruction = new DestructionSystem();
  fog = new FogSystem();
  ambient = new AmbientSystem(sound);
  exploration: ExplorationSystem;
  life = new LifeSystem();
  wildlife = new WildlifeSystem();
  jump = new JumpSystem(() => this.interiors.active ? [] : this.vehicles);
  crouch = new CrouchSystem();

  private hitCooldown = 0;
  private exitLock = 0;
  private hornCooldown = 0;
  private hornNoise = 0;
  private gpsRefresh = 0;
  private engineRefresh = 0;
  private cascadeRefresh = 0;
  /** Bioma sob a câmera, lido no tick de ambiente: é o clima que ele escolhe. */
  private biomeAtCamera: Biome = 'residential';
  private nextVehicleId = 0;
  private nextNpcId = 0;
  /** Janela de veículos do `separate`, reutilizada de um tick para o outro. */
  private nearbyVehicles: Vehicle[] = [];
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
    this.map = new Map(generateCity());
    // O índice dos estáticos nasce do mapa pronto e nunca mais muda: é ele que responde
    // "o que esta quadra tem?" sem percorrer as 4.451 estáticas da cidade inteira.
    this.streaming = new WorldStreamingManager(new ChunkIndex(this.map.data));
    this.spatial = new SpatialIndex(this.map.data.worldW, this.map.data.worldH);
    this.cascade = new CascadeSystem(this.map.data);
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

    this.movement = new MovementSystem(this.collision, () => this.interiors.active ? [] : this.vehicles);
    this.npcSystem = new NPCSystem(this.collision);
    this.interaction = new InteractionSystem(this.vehicleSystem);
    this.trafficSystem = new TrafficSystem(this.collision);
    this.trafficSystem.init(this.map, this.vehicles, this.npcs, () => this.nextVehicleId++);
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
   * A câmera sobe junto com o chão que ela mira. É uma translação da tela no mesmo eixo Y
   * da projeção: o losango continua 2:1 e a câmera continua isométrica.
   */
  private snapCameraHeight() {
    this.camera.h = this.activeMap.heightSmoothAt(this.camera.x, this.camera.y);
  }

  /**
   * A cota da câmera persegue a do chão com o mesmo alívio dos eixos x/y. Ler a cota crua
   * a cada quadro faria a tela inteira pular um degrau na borda de cada tile — o solavanco
   * que parece bug, ainda mais em carro.
   */
  private easeCameraHeight(dt: number) {
    const alvo = this.activeMap.heightSmoothAt(this.camera.x, this.camera.y);
    this.camera.h += (alvo - this.camera.h) * (1 - Math.exp(-GAME_CONFIG.CAMERA_LERP * dt));
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
   * O jogador volta a pé: veículos do save não pertencem ao mundo re-simulado.
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
    p.state = 'idle';
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
    if (this.paused || ui.paused || ui.mapOpen || ui.shopOpen || ui.overlay !== null) {
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

    this.trafficSystem.update(this.map, this.npcs, this.vehicles, dt, outdoorPlayer, this.streaming);
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
      onTransition: () => this.afterInteriorTransition(),
    };
  }

  /** Câmera, inputs e som depois de cruzar uma porta — vale para entrar e para sair. */
  private afterInteriorTransition() {
    useGameStore.closeShop();
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

    if (consumeEnter()) {
      if (!wasInVehicle && this.interiors.nearest(player) && !this.interaction.nearestVehicle(player, this.vehicles)) {
        return this.useInterior();
      }
      if (player.currentVehicleId !== null) {
        this.interaction.tryExit(player, this.vehicles, this.map, this.collision);
        this.exitLock = GAME_CONFIG.VEHICLE_EXIT_COOLDOWN;
      } else if (this.exitLock <= 0) {
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
    if ((player.currentVehicleId !== null) !== wasInVehicle) {
      this.jump.cancel(player);
      this.notifyEntityChange();
      sound.play(player.currentVehicleId !== null ? 'doorOpen' : 'doorClose', 0.55);
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
      this.movement.updateVehicle(vehicle, this.map, dt);
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
      allocVehicleId: () => this.nextVehicleId++, allocNpcId: () => this.nextNpcId++,
      onStructChange: () => this.notifyEntityChange(), onBusted: () => this.bust(),
      shake: (amount) => this.shake(amount), rng: this.rnd,
    };
  }

  /**
   * O que os oficiais empenhados enxergam agora, para o radar desenhar. Nada aqui lê a
   * posição do jogador: o cone pertence ao policial, então a HUD não vira raio-x.
   */
  policeVisionCones(): VisionCone[] {
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
      onCrime: (incident) => this.reportCrime(incident),
      map: this.activeMap,
      wanted: this.wanted,
      pickups: this.dropTarget(room),
      aim: effectiveAim(player.facingAngle),
      onStructChange: () => this.notifyEntityChange(),
      shake: (a) => this.shake(a),
      rng: this.rnd,
    } satisfies WeaponContext;
    const blocked = player.currentVehicleId !== null || player.swimming || player.health <= 0 || player.state === 'dead';
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
    const biome = this.map.data.tiles[
      Math.floor(position.y) * this.map.data.tilesW + Math.floor(position.x)]?.biome ?? 'residential';
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
    if (player.currentVehicleId === null) return;
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
      const driving = this.player.currentVehicleId !== null;
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

  private separate(player: Player) {
    if (player.currentVehicleId !== null || (player.jumpTimer > 0 && player.jumpEnd !== null)) return;
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
    for (let i = 0; i < 3; i++) {
      this.collision.resolveCircleVsVehicles(body, pertoVeh);
      this.collision.resolveCircle(body, this.map.queryNearby(body.x, body.y, 2));
    }
    player.x = Math.max(body.radius, Math.min(this.map.worldW - body.radius, body.x));
    player.y = Math.max(body.radius, Math.min(this.map.worldH - body.radius, body.y));
  }

  private updateAnimations(dt: number) {
    const p = this.player;
    if (p.currentVehicleId !== null) {
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
