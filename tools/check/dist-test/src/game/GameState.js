"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GameState = void 0;
exports.getGame = getGame;
exports.peekGame = peekGame;
exports.resetGame = resetGame;
const GameConfig_1 = require("./GameConfig");
const InputState_1 = require("./InputState");
const WeaponSystem_1 = require("../systems/WeaponSystem");
const Map_1 = require("../world/Map");
const city_1 = require("../data/maps/city");
const Camera_1 = require("../world/Camera");
const IsoUtils_1 = require("../world/IsoUtils");
const Player_1 = require("../entities/Player");
const Vehicle_1 = require("../entities/Vehicle");
const NPC_1 = require("../entities/NPC");
const LifeSystem_1 = require("../systems/LifeSystem");
const WildlifeSystem_1 = require("../systems/WildlifeSystem");
const vehicles_1 = require("../data/vehicles");
const weapons_1 = require("../data/weapons");
const CollisionSystem_1 = require("../systems/CollisionSystem");
const MovementSystem_1 = require("../systems/MovementSystem");
const JumpSystem_1 = require("../systems/JumpSystem");
const CrouchSystem_1 = require("../systems/CrouchSystem");
const VehicleSystem_1 = require("../systems/VehicleSystem");
const VehicleImpactSystem_1 = require("../systems/VehicleImpactSystem");
const NPCSystem_1 = require("../systems/NPCSystem");
const InteractionSystem_1 = require("../systems/InteractionSystem");
const TrafficSystem_1 = require("../systems/TrafficSystem");
const WantedSystem_1 = require("../systems/WantedSystem");
const StaminaSystem_1 = require("../systems/StaminaSystem");
const HealthSystem_1 = require("../systems/HealthSystem");
const CombatSystem_1 = require("../systems/CombatSystem");
const PoliceSystem_1 = require("../systems/PoliceSystem");
const WitnessSystem_1 = require("../systems/WitnessSystem");
const MissionSystem_1 = require("../systems/MissionSystem");
const PickupSystem_1 = require("../systems/PickupSystem");
const DayNightSystem_1 = require("../systems/DayNightSystem");
const WeatherSystem_1 = require("../systems/WeatherSystem");
const HazardSystem_1 = require("../systems/HazardSystem");
const DestructionSystem_1 = require("../systems/DestructionSystem");
const FogSystem_1 = require("../systems/FogSystem");
const AmbientSystem_1 = require("../systems/AmbientSystem");
const ExplorationSystem_1 = require("../systems/ExplorationSystem");
const SoundManager_1 = require("../audio/SoundManager");
const useGameStore_1 = require("../stores/useGameStore");
const Gps_1 = require("../world/Gps");
const InteriorSystem_1 = require("../systems/InteriorSystem");
const JailSystem_1 = require("../systems/JailSystem");
const InteriorCrowdSystem_1 = require("../systems/InteriorCrowdSystem");
const jail_1 = require("../data/jail");
const SaveGame_1 = require("./SaveGame");
let _game = null;
const SHOT_SFX = {
    pistol: 'pistolShot',
    revolver: 'revolverShot',
    smg: 'smgShot',
    micro: 'microShot',
    rifle: 'rifleShot',
    sniper: 'sniperShot',
    shotgun: 'shotgunShot',
};
function getGame() {
    if (!_game)
        _game = new GameState();
    return _game;
}
/** O jogo já foi criado? Serve para o menu e o boot nunca gerarem a cidade de raspão. */
function peekGame() {
    return _game;
}
function resetGame() {
    SoundManager_1.sound.stopLoops();
    _game = new GameState();
    return _game;
}
/**
 * Orquestrador fino: só posições, inputs e a ordem dos sistemas.
 * Cada mecânica mora no seu sistema em src/systems/.
 */
class GameState {
    subscribeEntityChange(cb) {
        this.entityListeners.add(cb);
        return () => {
            this.entityListeners.delete(cb);
        };
    }
    notifyEntityChange() {
        this.entityVersion++;
        for (const cb of this.entityListeners)
            cb();
    }
    shake(amount) {
        this.shakeAmp = Math.min(1.6, this.shakeAmp + amount);
    }
    constructor() {
        /** Cela, guarda e presos: só existe enquanto a sala da cadeia está aberta. */
        this.jail = new JailSystem_1.JailSystem();
        /** Moradores, atendentes, clientes e funcionários da sala que estiver aberta. */
        this.crowd = new InteriorCrowdSystem_1.InteriorCrowdSystem();
        this.vehicles = [];
        this.npcs = [];
        this.time = 0;
        this.viewW = 800;
        this.viewH = 400;
        this.showDebug = false;
        this.entityVersion = 0;
        this.paused = false;
        this.playerDeathTimer = 0;
        /** offset de screen-shake em px de tela (lido pelo GameCanvas) */
        this.shakeX = 0;
        this.shakeY = 0;
        this.collision = new CollisionSystem_1.CollisionSystem();
        this.vehicleSystem = new VehicleSystem_1.VehicleSystem();
        this.impact = new VehicleImpactSystem_1.VehicleImpactSystem();
        this.wanted = new WantedSystem_1.WantedSystem();
        this.stamina = new StaminaSystem_1.StaminaSystem();
        this.health = new HealthSystem_1.HealthSystem();
        this.combat = new CombatSystem_1.CombatSystem();
        this.weapons = new WeaponSystem_1.WeaponSystem();
        this.police = new PoliceSystem_1.PoliceSystem();
        this.witnesses = new WitnessSystem_1.WitnessSystem();
        this.pickups = new PickupSystem_1.PickupSystem();
        this.dayNight = new DayNightSystem_1.DayNightSystem();
        this.weather = new WeatherSystem_1.WeatherSystem(() => SoundManager_1.sound.play('thunder'));
        this.hazard = new HazardSystem_1.HazardSystem();
        this.destruction = new DestructionSystem_1.DestructionSystem();
        this.fog = new FogSystem_1.FogSystem();
        this.ambient = new AmbientSystem_1.AmbientSystem(SoundManager_1.sound);
        this.life = new LifeSystem_1.LifeSystem();
        this.wildlife = new WildlifeSystem_1.WildlifeSystem();
        this.jump = new JumpSystem_1.JumpSystem(() => this.interiors.active ? [] : this.vehicles);
        this.crouch = new CrouchSystem_1.CrouchSystem();
        this.hitCooldown = 0;
        this.exitLock = 0;
        this.hornCooldown = 0;
        this.hornNoise = 0;
        this.gpsRefresh = 0;
        this.engineRefresh = 0;
        /** Bioma sob a câmera, lido no tick de ambiente: é o clima que ele escolhe. */
        this.biomeAtCamera = 'residential';
        this.nextVehicleId = 0;
        this.nextNpcId = 0;
        this.rnd = () => Math.random();
        this.entityListeners = new Set();
        this.shakeAmp = 0;
        (0, InputState_1.resetActionInput)();
        this.weapons.events = {
            onShot: (weapon) => SoundManager_1.sound.play(SHOT_SFX[weapon.id], weapon.id === 'shotgun' ? 0.7 : 0.55),
            onReload: () => SoundManager_1.sound.play('weaponReload', 0.4),
            onEmpty: () => SoundManager_1.sound.play('weaponEmpty', 0.4),
        };
        this.map = new Map_1.Map((0, city_1.generateCity)());
        this.wildlife.init(this.map);
        this.interiors = new InteriorSystem_1.InteriorSystem(this.map);
        // A cadeia fala pela sala, mas quem decide é o JailSystem — laço de função, não de import.
        this.interiors.delegate = {
            prompt: (player) => (this.jail.inside ? this.jail.prompt(player) : null),
            interact: () => this.jail.tryInteract(this.jailContext()),
        };
        const spawn = this.map.data.playerSpawn;
        this.player = (0, Player_1.createPlayer)(spawn.x, spawn.y);
        this.player.facingAngle = 0;
        {
            const c = { x: this.player.x, y: this.player.y, radius: GameConfig_1.GAME_CONFIG.PLAYER_RADIUS };
            this.collision.resolveCircle(c, this.map.staticColliders);
            this.player.x = c.x;
            this.player.y = c.y;
        }
        this.camera = (0, Camera_1.createCamera)(this.player.x, this.player.y);
        this.exploration = new ExplorationSystem_1.ExplorationSystem(this.map.data.tilesW, this.map.data.tilesH);
        this.exploration.update({ position: this.player, outdoors: true });
        for (const v of this.map.data.vehicles) {
            const def = vehicles_1.VEHICLE_DEFS[v.defKey];
            if (!def)
                continue;
            this.vehicles.push((0, Vehicle_1.createVehicle)(this.nextVehicleId++, def, v.color ?? def.colors[0] ?? '', v.x, v.y, v.dir));
        }
        const spawns = this.map.data.npcSpawns.slice().sort((a, b) => Math.hypot(a.x - spawn.x, a.y - spawn.y) - Math.hypot(b.x - spawn.x, b.y - spawn.y));
        for (let i = spawns.length - 1; i > 48; i--) {
            const j = 48 + Math.floor(this.rnd() * (i - 47));
            [spawns[i], spawns[j]] = [spawns[j], spawns[i]];
        }
        const npcChars = GameConfig_1.GAME_CONFIG.NPC_CHARS;
        for (let i = 0; i < GameConfig_1.GAME_CONFIG.NPC_COUNT; i++) {
            if (i >= spawns.length)
                break;
            const s = spawns[i];
            const char = npcChars[Math.floor(Math.random() * npcChars.length)];
            const npc = (0, NPC_1.createNPC)(this.nextNpcId++, char, s.x, s.y);
            const c = { x: npc.x, y: npc.y, radius: GameConfig_1.GAME_CONFIG.NPC_RADIUS * 0.8 };
            this.collision.resolveCircle(c, this.map.staticColliders);
            npc.x = c.x;
            npc.y = c.y;
            this.npcs.push(npc);
        }
        this.movement = new MovementSystem_1.MovementSystem(this.collision, () => this.interiors.active ? [] : this.vehicles);
        this.npcSystem = new NPCSystem_1.NPCSystem(this.collision);
        this.interaction = new InteractionSystem_1.InteractionSystem(this.vehicleSystem);
        this.trafficSystem = new TrafficSystem_1.TrafficSystem(this.collision);
        this.trafficSystem.init(this.map, this.vehicles, this.npcs, () => this.nextVehicleId++);
        this.pickups.init(this.map, this.rnd);
        this.missions = new MissionSystem_1.MissionSystem(this.map, this.rnd);
        this.police.init(this.policeContext());
        for (const npc of this.npcs) {
            if (npc.inVehicle || npc.dead)
                continue;
            npc.patienceTimer = 50 + Math.random() * 200;
        }
    }
    setViewSize(w, h) {
        this.viewW = w;
        this.viewH = h;
        this.clampCamera();
        this.snapCameraHeight();
    }
    clampCamera() {
        const room = this.interiors.active;
        if (room)
            (0, Camera_1.clampToRoom)(this.camera, room.map.worldW, room.map.worldH, this.viewW, this.viewH);
        else
            (0, Camera_1.clampToMap)(this.camera, this.map.worldW, this.map.worldH, this.viewW, this.viewH);
    }
    /**
     * A câmera sobe junto com o chão que ela mira. É uma translação da tela no mesmo eixo Y
     * da projeção: o losango continua 2:1 e a câmera continua isométrica.
     */
    snapCameraHeight() {
        this.camera.h = this.activeMap.heightSmoothAt(this.camera.x, this.camera.y);
    }
    /**
     * A cota da câmera persegue a do chão com o mesmo alívio dos eixos x/y. Ler a cota crua
     * a cada quadro faria a tela inteira pular um degrau na borda de cada tile — o solavanco
     * que parece bug, ainda mais em carro.
     */
    easeCameraHeight(dt) {
        const alvo = this.activeMap.heightSmoothAt(this.camera.x, this.camera.y);
        this.camera.h += (alvo - this.camera.h) * (1 - Math.exp(-GameConfig_1.GAME_CONFIG.CAMERA_LERP * dt));
    }
    /**
     * Instantâneo do save. Só estado persistente faz sentido: jogador, arsenal, relógio e o
     * mapa de exploração. NPCs/trânsito/destruição pertencem ao mundo, que é re-simulado.
     */
    snapshot() {
        const p = this.player;
        // Salvar dentro de uma sala não pode gravar o plano do interior como se fosse a rua:
        // a posição persistida é a âncora na porta, e o load devolve o jogador para fora.
        const where = this.worldPosition;
        return {
            version: SaveGame_1.SAVE_VERSION,
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
                ammo: weapons_1.GUN_IDS.reduce((acc, id) => {
                    acc[id] = { loaded: this.weapons.ammo[id].loaded, reserve: this.weapons.ammo[id].reserve };
                    return acc;
                }, {}),
            },
            exploration: this.exploration.serialize(),
        };
    }
    /**
     * Aplica um save sobre um GameState recém-criado (mesma seed, mesmo mundo).
     * O jogador volta a pé: veículos do save não pertencem ao mundo re-simulado.
     */
    applySave(save) {
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
        const c = { x: p.x, y: p.y, radius: GameConfig_1.GAME_CONFIG.PLAYER_RADIUS };
        this.collision.resolveCircle(c, this.map.staticColliders);
        p.x = c.x;
        p.y = c.y;
        this.camera = (0, Camera_1.createCamera)(p.x, p.y);
        this.weapons.reset();
        this.weapons.owned.clear();
        for (const id of save.weapons.owned)
            this.weapons.owned.add(id);
        this.weapons.equipped = this.weapons.owned.has(save.weapons.equipped) ? save.weapons.equipped : 'unarmed';
        for (const id of weapons_1.GUN_IDS) {
            const saved = save.weapons.ammo[id];
            this.weapons.ammo[id].loaded = saved?.loaded ?? 0;
            this.weapons.ammo[id].reserve = saved?.reserve ?? 0;
        }
        this.exploration.update({ position: p, outdoors: true });
        this.notifyEntityChange();
    }
    update(dt) {
        // Always drain taps, including while driving or simulation is suspended.
        const attack = (0, InputState_1.consumeAttack)();
        const reload = (0, InputState_1.consumeReload)();
        const weapon = (0, InputState_1.consumeWeapon)();
        const jump = (0, InputState_1.consumeJump)();
        const crouch = (0, InputState_1.consumeCrouch)();
        const ui = useGameStore_1.useGameStore.getState();
        if (this.paused || ui.paused || ui.mapOpen || ui.shopOpen || ui.overlay !== null) {
            (0, InputState_1.resetActionInput)();
            this.weapons.suspend();
            return;
        }
        this.time += dt;
        if (this.player.state === 'dead') {
            this.playerDeathTimer += dt;
            (0, InputState_1.resetActionInput)();
            this.weapons.suspend();
            if (this.playerDeathTimer >= NPC_1.PLAYER_DEATH_DELAY_S) {
                if (this.player.wantedLevel > 0 && this.police.nearestPoliceDist < 14)
                    this.bust();
                else
                    this.waste();
            }
            this.updateCamera(dt);
            this.updateShake(dt);
            return;
        }
        this.dayNight.update(dt);
        this.weather.update(dt, this.rnd, this.biomeAtCamera);
        this.hazard.update(dt, this.rnd, this.hazardContext());
        this.combat.update(dt);
        this.player.attackTimer = Math.max(0, this.player.attackTimer - dt);
        this.exitLock = Math.max(0, this.exitLock - dt);
        this.hornCooldown = Math.max(0, this.hornCooldown - dt);
        this.hornNoise = Math.max(0, this.hornNoise - dt);
        this.interiors.update(dt);
        if (this.jail.inside)
            this.jail.update(dt, this.jailContext());
        if ((0, InputState_1.consumeInteract)() && this.useInterior())
            return;
        if (this.interiors.active) {
            if ((0, InputState_1.consumeEnter)() && this.useInterior())
                return;
        }
        else if (this.handleVehicleInput())
            return;
        if (crouch)
            this.crouch.toggle(this.player);
        this.crouch.update(this.player);
        if (jump && this.jump.tryJump(this.player, this.activeMap, this.collision)) {
            SoundManager_1.sound.play(this.player.jumpEnd ? 'vault' : 'jump', 0.4);
        }
        this.handleMovement(dt);
        this.crouch.update(this.player);
        // Grades fechadas: colisão dinâmica, depois do movimento, para a cela prender de fato.
        if (this.jail.inside)
            this.jail.blockPlayer(this.player, this.collision);
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
        const outdoorPlayer = room
            ? { ...this.player, x: this.worldPosition.x, y: this.worldPosition.y, vx: 0, vy: 0, speed: 0, invulnUntil: Infinity }
            : this.player;
        this.trafficSystem.update(this.map, this.npcs, this.vehicles, dt, outdoorPlayer);
        this.updateNpcs(dt, outdoorPlayer);
        this.witnesses.update(dt, this.witnessContext(outdoorPlayer));
        outdoorPlayer.wantedLevel = this.player.wantedLevel;
        this.police.update(dt, this.policeContext(outdoorPlayer));
        this.missions.update(dt, outdoorPlayer, (money) => {
            this.player.money += money;
        }, !room);
        if (!room)
            this.pickups.update(this.time, this.player, this.rnd, (p) => {
                if (p.kind === 'cash') {
                    this.player.money += p.amount;
                    SoundManager_1.sound.play('coin', 0.55);
                }
                else if (p.kind === 'ammo') {
                    this.weapons.refill();
                    SoundManager_1.sound.play('uiSwitch', 0.55);
                }
                else if (p.kind === 'gun' && p.weapon) {
                    this.weapons.acquire(p.weapon);
                    this.weapons.equipped = p.weapon;
                    SoundManager_1.sound.play('uiSwitch', 0.7);
                    this.notifyEntityChange();
                }
                else {
                    this.health.heal(this.player, p.amount);
                    SoundManager_1.sound.play('healthPickup', 0.55);
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
        const noises = [];
        if (!room) {
            if (this.weapons.fireFlash > 0)
                noises.push({ x: this.player.x, y: this.player.y, radius: 18 });
            if (this.hornNoise > 0)
                noises.push({ x: this.player.x, y: this.player.y, radius: 10 });
        }
        this.wildlife.update(dt, {
            map: this.map, player: outdoorPlayer, vehicles: this.vehicles,
            night: this.dayNight.isNight,
            noise: noises.length ? noises : undefined,
            onDeath: (animal) => {
                if (!room && Math.hypot(animal.x - this.player.x, animal.y - this.player.y) < 12)
                    SoundManager_1.sound.play('bodyHit', 0.3);
            },
            onCall: (animal) => {
                if (!room)
                    SoundManager_1.sound.play('animalCall', Math.max(0.08, 0.4 - Math.hypot(animal.x - this.player.x, animal.y - this.player.y) * 0.02));
            },
            isVisible: (x, y) => {
                const p = (0, IsoUtils_1.worldToScreen)(x, y, this.map.heightSmoothAt(x, y));
                return this.fog.intersects(view, p.x - 45, p.y - 65, 90, 90);
            },
            onStructChange: () => this.notifyEntityChange(),
        });
        this.life.update(dt, {
            player: outdoorPlayer, npcs: this.npcs, map: this.map, vehicles: this.vehicles,
            collision: this.collision, rng: this.rnd,
            isPointVisible: (x, y) => {
                const p = (0, IsoUtils_1.worldToScreen)(x, y, this.map.heightSmoothAt(x, y));
                return this.fog.intersects(view, p.x - 40, p.y - 40, 80, 80);
            },
            onStructChange: () => this.notifyEntityChange(),
        });
        this.health.update(dt, this.player, this.time);
        // Depois de todo mundo se mover: o perigo empurra, arremessa e machuca o que cruzar.
        this.hazard.sweep(dt, this.hazardSweepContext(!!room));
        this.wanted.update(dt, this.player, !room && this.police.playerVisible);
        if (!room)
            this.separate(this.player);
        if (this.jump.update(this.player, this.activeMap, this.collision, dt) === 'landed')
            SoundManager_1.sound.play('land', 0.4);
        this.exploration.update({ position: this.worldPosition, outdoors: !this.interiors.active });
        this.updateAnimations(dt);
        this.updateSceneryVehicles(dt);
        this.updateCamera(dt);
        this.updateEngineAudio(dt);
        if (!room)
            this.updateGpsArrival();
        if (this.player.health <= 0) {
            this.ejectFromVehicle();
            this.player.state = 'dead';
            this.player.vx = this.player.vy = this.player.speed = 0;
            this.player.attackTimer = 0;
            this.player.crouching = false;
            this.playerDeathTimer = 0;
            SoundManager_1.sound.play('death', 0.55);
            this.weapons.suspend();
            (0, InputState_1.resetActionInput)();
            this.notifyEntityChange();
        }
        this.updateShake(dt);
    }
    // ---------------------------------------------------------------- inputs
    get activeMap() {
        return this.interiors.active?.map ?? this.map;
    }
    /**
     * Onde a cidade enxerga o jogador. Na rua é o próprio corpo; dentro de uma sala são as
     * coordenadas do pé da porta — o plano do interior não é um lugar do mapa, então nem o
     * trânsito, nem a polícia, nem o radar, nem o save podem ler `player.x/y` nesse momento.
     */
    get worldPosition() {
        const room = this.interiors.active;
        if (!room)
            return this.player;
        return this.interiors.street ?? room.entrance;
    }
    /** O chão que o jogador pisa: o piso plano da sala, ou o relevo da cidade. */
    playerGround() {
        return this.activeMap.heightSmoothAt(this.player.x, this.player.y);
    }
    useInterior() {
        return this.interiors.interact(this.interiorContext());
    }
    /** Compra no balcão aberto (chamada pela interface da loja). */
    purchaseShopItem(itemId) {
        return this.interiors.buy(itemId, this.interiorContext());
    }
    interiorContext() {
        return {
            player: this.player,
            heal: () => this.health.heal(this.player, 100),
            grantGun: (id) => {
                const fresh = this.weapons.acquire(id);
                if (fresh)
                    this.weapons.equipped = id;
                return fresh;
            },
            refillOwned: () => {
                if (!weapons_1.GUN_IDS.some((id) => this.weapons.owned.has(id)))
                    return false;
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
                SoundManager_1.sound.play(room?.shop || room?.service.action === 'bail' ? 'coin' : 'healthPickup', 0.45);
            },
            onOpenShop: () => useGameStore_1.useGameStore.openShop(),
            onTransition: () => this.afterInteriorTransition(),
        };
    }
    /** Câmera, inputs e som depois de cruzar uma porta — vale para entrar e para sair. */
    afterInteriorTransition() {
        useGameStore_1.useGameStore.closeShop();
        this.jump.cancel(this.player);
        this.exploration.breakTrail();
        this.exploration.update({ position: this.worldPosition, outdoors: true });
        (0, InputState_1.resetActionInput)();
        (0, InputState_1.resetJoystickInput)();
        (0, InputState_1.setRunHeld)(false);
        this.weapons.suspend();
        this.weapons.tracers.length = 0;
        this.camera = (0, Camera_1.createCamera)(this.player.x, this.player.y);
        const room = this.interiors.active;
        this.camera.zoom = room
            ? (0, Camera_1.indoorZoom)(room.map.worldW, room.map.worldH, this.viewW, this.viewH)
            : GameConfig_1.GAME_CONFIG.ZOOM_DEFAULT;
        this.clampCamera();
        // Trocar de cenário é corte, não travessia: a cota nova vale na hora, senão a sala
        // abriria descendo a rampa do morro que ficou do lado de fora da porta.
        this.snapCameraHeight();
        // A cadeia só existe enquanto a sala dela está aberta.
        if (room?.kind === 'jail')
            this.jail.enter();
        else
            this.jail.leave();
        // Nas outras salas o elenco é da própria casa: ninguém atravessa a parede para fugir.
        if (room)
            this.crowd.enter(room);
        else
            this.crowd.leave();
        SoundManager_1.sound.play('uiSwitch', 0.35);
        this.notifyEntityChange();
    }
    jailContext() {
        return {
            player: this.player,
            damagePlayer: (amount) => this.health.damage(this.player, amount, this.time),
            raiseWanted: (stars) => this.wanted.raise(this.player, stars),
            releaseInmate: (inmate) => this.releaseToStreet(inmate),
            grantGun: (id) => {
                const fresh = this.weapons.acquire(id);
                if (fresh)
                    this.weapons.equipped = id;
                return fresh;
            },
            say: (text) => this.interiors.say(text),
            notify: () => this.notifyEntityChange(),
        };
    }
    crowdContext(room) {
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
    releaseToStreet(inmate) {
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
    handleVehicleInput() {
        const player = this.player;
        const wasInVehicle = player.currentVehicleId !== null;
        if ((0, InputState_1.consumeEnter)()) {
            if (!wasInVehicle && this.interiors.nearest(player) && !this.interaction.nearestVehicle(player, this.vehicles)) {
                return this.useInterior();
            }
            if (player.currentVehicleId !== null) {
                this.interaction.tryExit(player, this.vehicles, this.map, this.collision);
                this.exitLock = GameConfig_1.GAME_CONFIG.VEHICLE_EXIT_COOLDOWN;
            }
            else if (this.exitLock <= 0) {
                const target = this.interaction.nearestVehicle(player, this.vehicles);
                const stolen = this.trafficSystem.tryStealCar(player, this.vehicles, this.npcs);
                if (stolen) {
                    SoundManager_1.sound.play('glassBreak', 0.65);
                    this.wanted.raise(player, GameConfig_1.GAME_CONFIG.WANTED_STEAL);
                    this.pickups.spawnDrop(player.x, player.y, 40 + Math.floor(this.rnd() * 80));
                }
                else if (target && this.interaction.tryEnter(player, this.vehicles) && player.currentVehicleId === target.id) {
                    // `occupied` é NPC no banco: assaltar é tirar quem dirige. O TrafficSystem devolve o
                    // motorista do trânsito à calçada e o PoliceSystem despeja a guarnição da viatura.
                    const police = target.def.type === 'police' || target.def.type === 'swat';
                    if (target.occupied || police)
                        SoundManager_1.sound.play('glassBreak', 0.65);
                    if (police)
                        this.wanted.raise(player, GameConfig_1.GAME_CONFIG.WANTED_STEAL + 1);
                    this.trafficSystem.takeOver(target.id);
                }
            }
        }
        if ((player.currentVehicleId !== null) !== wasInVehicle) {
            this.jump.cancel(player);
            this.notifyEntityChange();
            SoundManager_1.sound.play(player.currentVehicleId !== null ? 'doorOpen' : 'doorClose', 0.55);
        }
        return false;
    }
    handleMovement(dt) {
        const player = this.player;
        const inVehicle = player.currentVehicleId !== null;
        const vehicle = inVehicle ? this.vehicles.find((v) => v.id === player.currentVehicleId) ?? null : null;
        const honk = (0, InputState_1.consumeHorn)();
        if (inVehicle && vehicle) {
            if (honk)
                this.soundHorn();
            const flying = vehicle.def.type === 'helicopter';
            const bfx = vehicle.x;
            const bfy = vehicle.y;
            this.movement.updateVehicle(vehicle, this.map, dt);
            if (!flying) {
                const vc = {
                    x: vehicle.x,
                    y: vehicle.y,
                    radius: Math.max(GameConfig_1.GAME_CONFIG.VEHICLE_RADIUS, Math.min(vehicle.def.footprintW, vehicle.def.footprintH) * 0.32),
                };
                const nearby = this.map.queryNearby(vehicle.x, vehicle.y, 2.5);
                this.collision.resolveCircle(vc, nearby);
                this.collision.resolveCircleVsVehicles(vc, this.vehicles, vehicle.id);
                vehicle.x = vc.x;
                vehicle.y = vc.y;
                const expectedMove = Math.abs(vehicle.speed) * dt * 0.55;
                const moved = Math.hypot(vehicle.x - bfx, vehicle.y - bfy);
                if (this.hitCooldown <= 0 && Math.abs(vehicle.speed) > 1.1 && moved < expectedMove) {
                    SoundManager_1.sound.play('metalHit', 0.5);
                    if (Math.abs(vehicle.speed) > 2.0) {
                        SoundManager_1.sound.play('glassBreak', 0.3);
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
        }
        else {
            const wantsRun = InputState_1.inputState.runHeld && !player.crouching;
            const moving = InputState_1.inputState.magnitude > GameConfig_1.GAME_CONFIG.JOYSTICK_DEADZONE;
            // Dentro de casa a rua não alcança ninguém: as coordenadas da sala não são do mundo.
            const wading = this.interiors.active ? false : this.hazard.floodedAt(player.x, player.y);
            this.movement.updatePlayer(player, this.activeMap, dt, wantsRun && this.stamina.canSprint(player), wading);
            this.stamina.update(player, dt, wantsRun, moving);
        }
    }
    /** Buzina do motorista: o carro do jogador soa, assusta a fauna e um carro preso responde. */
    soundHorn() {
        if (this.hornCooldown > 0)
            return;
        this.hornCooldown = 0.55;
        this.hornNoise = 0.6;
        SoundManager_1.sound.play('carHorn', 0.85);
        this.trafficSystem.honk(this.player);
    }
    policeContext(player = this.player) {
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
    policeVisionCones() {
        // O cone pertence à rua. Dentro de uma sala o radar mostra o plano do interior, e a
        // posição real do jogador não existe no mapa — nada aqui pode desenhá-la.
        if (this.interiors.active)
            return [];
        return this.police.visionCones(this.policeContext());
    }
    witnessContext(player = this.player) {
        return {
            map: this.map, player, npcs: this.npcs, vehicles: this.vehicles,
            onReport: (incident) => {
                this.wanted.raise(this.player, Math.max(0.5, incident.severity - this.player.wantedLevel));
                this.police.report(incident);
            },
            onCallStart: () => SoundManager_1.sound.play('uiSwitch', 0.18),
        };
    }
    reportCrime(incident) {
        if (!this.interiors.active)
            this.witnesses.observe(incident, this.witnessContext());
    }
    handleWeaponInput(dt, attack, reload, weapon) {
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
            aim: (0, InputState_1.effectiveAim)(player.facingAngle),
            onStructChange: () => this.notifyEntityChange(),
            shake: (a) => this.shake(a),
            rng: this.rnd,
        };
        const blocked = player.currentVehicleId !== null || player.swimming || player.health <= 0 || player.state === 'dead';
        if (!blocked && weapon)
            this.weapons.cycle(weapon);
        // Cancel reload before its timer can finish on the vehicle/water entry tick.
        this.weapons.updateAim(ctx);
        this.weapons.update(dt);
        if (blocked) {
            (0, InputState_1.resetActionInput)();
            return;
        }
        if (reload)
            this.weapons.reload(ctx);
        const equipped = this.weapons.equipped;
        if ((0, weapons_1.isGunId)(equipped)) {
            this.weapons.tryFire(ctx, { pressed: attack, held: InputState_1.inputState.attackHeld });
        }
        else if (attack) {
            this.combat.tryAttack({ ...ctx, time: this.time }, equipped === 'bat' ? 'bat' : 'unarmed');
        }
    }
    /**
     * Dentro de uma sala as coordenadas são locais e o pickup é do mundo: o espólio de quem
     * cai ali cai na calçada, na porta, senão ficaria inalcançável num mapa que não existe.
     */
    dropTarget(room) {
        if (!room)
            return this.pickups;
        const { x, y } = room.entrance;
        return {
            spawnDrop: (_x, _y, amount) => this.pickups.spawnDrop(x, y, amount),
            spawnWeaponDrop: (_x, _y, gun) => this.pickups.spawnWeaponDrop(x, y, gun),
        };
    }
    // ---------------------------------------------------------------- npcs
    updateNpcs(dt, player = this.player) {
        for (const npc of this.npcs) {
            const wasDead = npc.dead;
            // cops são dirigidos pelo PoliceSystem (a pé) ou pelo carro (dentro)
            if (npc.kind === 'cop') {
                if (npc.dead && !wasDead)
                    this.notifyEntityChange();
                continue;
            }
            if (!npc.dead && !npc.inVehicle) {
                const dist = Math.hypot(npc.x - player.x, npc.y - player.y);
                const fleeing = npc.state === 'fleeing';
                if (!fleeing && dist > GameConfig_1.GAME_CONFIG.NPC_SIM_FAR) {
                    // congelado longe da câmera
                }
                else if (!fleeing && dist > GameConfig_1.GAME_CONFIG.NPC_SIM_NEAR && npc.state === 'idle') {
                    npc.patienceTimer -= dt * 350;
                }
                else if (!fleeing && dist > GameConfig_1.GAME_CONFIG.NPC_SIM_NEAR && npc.state === 'walking') {
                    if ((Math.floor(this.time * 28) + npc.id) % 2 === 0) {
                        this.npcSystem.update(npc, this.map, this.vehicles, dt, player.x, player.y, player.wantedLevel, this.trafficSystem.signalSystem);
                    }
                }
                else {
                    this.npcSystem.update(npc, this.map, this.vehicles, dt, player.x, player.y, player.wantedLevel, this.trafficSystem.signalSystem);
                }
            }
            if (npc.dead && !wasDead)
                this.notifyEntityChange();
        }
    }
    // ---------------------------------------------------------------- áudio ambiente
    /** Called when the UI freezes the sim (menu, pause, map, round overlay): nothing may keep playing. */
    suspendEnvironment() {
        this.ambient.suspend();
        SoundManager_1.sound.stopLoops();
    }
    updateEnvironment(dt) {
        const position = this.worldPosition;
        const biome = this.map.data.tiles[Math.floor(position.y) * this.map.data.tilesW + Math.floor(position.x)]?.biome ?? 'residential';
        this.biomeAtCamera = biome;
        const environment = { timeOfDay: this.dayNight.t, rain: this.weather.intensity + this.hazard.wet,
            cover: this.weather.cover, dark: this.hazard.dark, biome };
        this.fog.update(dt, environment);
        this.ambient.update(dt, {
            ...environment,
            outdoors: !this.interiors.active,
            snow: this.weather.snowing,
            hazardBed: this.hazard.bed,
            hazardVolume: this.hazard.bedVolume,
        });
    }
    hazardContext() {
        return {
            indoors: !!this.interiors.active || this.jail.inside,
            season: this.weather.season,
            weather: this.weather.kind,
            camera: this.camera,
            terrain: this.map,
            onAlert: () => SoundManager_1.sound.play('weatherAlert', 0.75),
        };
    }
    hazardSweepContext(indoors) {
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
    updateEngineAudio(dt) {
        this.engineRefresh -= dt;
        if (this.engineRefresh > 0)
            return;
        this.engineRefresh = 0.25;
        const player = this.player;
        if (player.currentVehicleId === null) {
            SoundManager_1.sound.setLoop('engine', null);
            return;
        }
        const v = this.vehicles.find((x) => x.id === player.currentVehicleId);
        if (!v || v.state === 'destroyed') {
            SoundManager_1.sound.setLoop('engine', null);
            return;
        }
        const isHeli = v.def.type === 'helicopter';
        const load = Math.min(1, Math.abs(v.speed) / (isHeli ? GameConfig_1.GAME_CONFIG.HELI_MAX_SPEED : GameConfig_1.GAME_CONFIG.VEHICLE_MAX_SPEED));
        SoundManager_1.sound.setLoop('engine', 'engine', isHeli ? 0.34 + load * 0.3 : 0.2 + load * 0.42);
    }
    // ---------------------------------------------------------------- câmera/shake
    updateCamera(dt) {
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
        }
        else if (InputState_1.inputState.magnitude > GameConfig_1.GAME_CONFIG.JOYSTICK_DEADZONE) {
            const direction = (0, IsoUtils_1.screenToWorld)(InputState_1.inputState.dx, InputState_1.inputState.dy);
            const length = Math.hypot(direction.x, direction.y);
            lookX = direction.x / length * 0.55;
            lookY = direction.y / length * 0.55;
        }
        if (InputState_1.inputState.aimActive) {
            lookX = InputState_1.inputState.aimX * 1.2;
            lookY = InputState_1.inputState.aimY * 1.2;
        }
        (0, Camera_1.cameraFollow)(this.camera, followX, followY, lookX, lookY, dt, this.activeMap.worldW, this.activeMap.worldH);
        this.clampCamera();
        this.easeCameraHeight(dt);
    }
    updateShake(dt) {
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
    applyCrashDamage(speed, vehicle) {
        if (speed < GameConfig_1.GAME_CONFIG.CRASH_DAMAGE_SPEED)
            return;
        const dmg = (speed - GameConfig_1.GAME_CONFIG.CRASH_DAMAGE_SPEED) * 7.5;
        this.health.damage(this.player, dmg, this.time);
        vehicle.health = Math.max(0, vehicle.health - dmg * 1.15);
    }
    /** Atropelamento: o carro do jogador e o de qualquer NPC em curso, inclusive a polícia. */
    impactContext(indoors) {
        return {
            map: this.map, collision: this.collision, player: this.player,
            vehicles: this.vehicles, npcs: this.npcs, animals: this.wildlife.animals,
            health: this.health, wanted: this.wanted, pickups: this.pickups, time: this.time,
            indoors, rng: this.rnd, shake: (amount) => this.shake(amount),
            onStructChange: () => this.notifyEntityChange(),
        };
    }
    ejectFromVehicle() {
        const player = this.player;
        if (player.currentVehicleId === null)
            return;
        const v = this.vehicles.find((x) => x.id === player.currentVehicleId);
        if (v)
            this.vehicleSystem.exitVehicle(player, v, this.map, this.collision);
        player.currentVehicleId = null;
        player.state = 'idle';
        this.notifyEntityChange();
    }
    bust() {
        const door = this.interiors.jailEntrance;
        SoundManager_1.sound.play('busted', 0.7);
        // Com cadeia no mapa não há "ressurreção" na porta da esquadra: o preso entra.
        if (door)
            this.sendToJail(door);
        else
            this.finishRound('busted', GameConfig_1.GAME_CONFIG.BUSTED_MONEY_LOSS, 'police');
    }
    /** Levado algemado para a cela: a pena corre e a grade só abre no fim (ou com as chaves). */
    sendToJail(door) {
        const player = this.player;
        const sentence = JailSystem_1.JailSystem.sentenceFor(player.wantedLevel);
        this.finishRound('busted', GameConfig_1.GAME_CONFIG.BUSTED_MONEY_LOSS, 'police', true);
        this.jail.incarcerate(sentence);
        this.interiors.open(door, player);
        player.x = jail_1.JAIL_CELL_SPAWN.x;
        player.y = jail_1.JAIL_CELL_SPAWN.y;
        player.facingAngle = Math.PI / 2;
        player.direction = (0, IsoUtils_1.angleToWorldDir)(player.facingAngle);
        this.afterInteriorTransition();
        this.interiors.say(`Preso · ${sentence} s de pena`, 4);
    }
    waste() {
        this.finishRound('wasted', GameConfig_1.GAME_CONFIG.WASTED_MONEY_LOSS, 'hospital');
        SoundManager_1.sound.play('wasted', 0.7);
    }
    finishRound(kind, moneyLoss, landmarkKind, keepInside = false) {
        const player = this.player;
        this.jump.cancel(player);
        this.interiors.leave(player);
        // Sem sala, sem cela: as grades deixam de bloquear o mundo lá fora.
        this.jail.leave();
        this.crowd.leave();
        this.camera.zoom = GameConfig_1.GAME_CONFIG.ZOOM_DEFAULT;
        this.ejectFromVehicle();
        this.weapons.reset();
        (0, InputState_1.resetActionInput)();
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
        const c = { x: player.x, y: player.y, radius: GameConfig_1.GAME_CONFIG.PLAYER_RADIUS };
        this.collision.resolveCircle(c, this.activeMap.staticColliders);
        player.x = c.x;
        player.y = c.y;
        this.exploration.breakTrail();
        this.exploration.update({ position: this.activeMap === this.map ? player : this.map.data.playerSpawn, outdoors: true });
        this.notifyEntityChange();
        useGameStore_1.useGameStore.showOverlay(kind);
    }
    // ---------------------------------------------------------------- gps
    updateGpsArrival() {
        const st = useGameStore_1.useGameStore.getState();
        if (!st.mapMarker)
            return;
        this.gpsRefresh -= 1 / 60;
        if (this.gpsRefresh <= 0) {
            this.gpsRefresh = 0.85;
            const driving = this.player.currentVehicleId !== null;
            useGameStore_1.useGameStore.refreshMapRoute(this.map, this.player.x, this.player.y, driving);
        }
        const st2 = useGameStore_1.useGameStore.getState();
        const d = Math.hypot(this.player.x - st2.mapMarker.x, this.player.y - st2.mapMarker.y);
        const rem = st2.mapRoute.length >= 2
            ? (0, Gps_1.remainingRouteDistance)(st2.mapRoute, this.player.x, this.player.y)
            : d;
        if (d <= 2.4 || rem <= 2.4) {
            useGameStore_1.useGameStore.clearMapMarker();
            SoundManager_1.sound.play('uiSwitch', 0.45);
        }
    }
    // ---------------------------------------------------------------- helpers antigos
    separate(player) {
        if (player.currentVehicleId !== null || (player.jumpTimer > 0 && player.jumpEnd !== null))
            return;
        for (const npc of this.npcs) {
            if (npc.dead || npc.inVehicle || npc.state === 'chasing' || npc.state === 'knocked')
                continue;
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
        const body = { x: player.x, y: player.y, radius: GameConfig_1.GAME_CONFIG.PLAYER_RADIUS };
        for (let i = 0; i < 3; i++) {
            this.collision.resolveCircleVsVehicles(body, this.vehicles);
            this.collision.resolveCircle(body, this.map.queryNearby(body.x, body.y, 2));
        }
        player.x = Math.max(body.radius, Math.min(this.map.worldW - body.radius, body.x));
        player.y = Math.max(body.radius, Math.min(this.map.worldH - body.radius, body.y));
    }
    updateAnimations(dt) {
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
                if (p.frame === 0 || p.frame === 2)
                    SoundManager_1.sound.play('stepWood', 0.28);
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
        const base = p.state === 'running' ? GameConfig_1.GAME_CONFIG.WALK_CYCLE_MS * 0.72 : GameConfig_1.GAME_CONFIG.WALK_CYCLE_MS;
        const speedNorm = Math.max(0.55, Math.min(1.35, p.speed / GameConfig_1.GAME_CONFIG.PLAYER_WALK_SPEED));
        const frameMs = base / 4 / speedNorm;
        p.animTimer += dt * 1000;
        while (p.animTimer >= frameMs) {
            p.animTimer -= frameMs;
            p.frame = (p.frame + 1) % 4;
            if (p.frame === 0 || p.frame === 2)
                this.playFootstep();
        }
    }
    playFootstep() {
        const { tiles, tilesW, tilesH, worldW, worldH } = this.activeMap.data;
        const tx = Math.floor(this.player.x);
        const ty = Math.floor(this.player.y);
        if (tx < 0 || ty < 0 || tx >= tilesW || ty >= tilesH || this.player.x > worldW || this.player.y > worldH) {
            SoundManager_1.sound.play('stepConcrete', 0.45);
            return;
        }
        const kind = tiles[ty * tilesW + tx].kind;
        if (kind === 'grass' || kind === 'dirt')
            SoundManager_1.sound.play('stepGrass', 0.45);
        else if (kind === 'water')
            SoundManager_1.sound.play('stepWood', 0.45);
        else if (kind === 'concrete')
            SoundManager_1.sound.play('softStep', 0.4);
        else
            SoundManager_1.sound.play('stepConcrete', 0.45);
    }
    /** Helicóptero: rotor sempre; no chão ou no ar. */
    updateSceneryVehicles(dt) {
        for (const v of this.vehicles) {
            if (v.def.type !== 'helicopter' || v.state === 'destroyed')
                continue;
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
exports.GameState = GameState;
