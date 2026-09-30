"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DIRS_4 = exports.GAME_CONFIG = void 0;
exports.GAME_CONFIG = {
    MAP_TILES_W: 240,
    MAP_TILES_H: 240,
    ZOOM_DEFAULT: 1.55,
    ZOOM_MIN: 0.95,
    ZOOM_MAX: 1.85,
    // Rooms are small, so the close-up zoom is above the outdoor range.
    ZOOM_INDOORS: 1.8,
    CAMERA_LERP: 14.5,
    CAMERA_LOOKAHEAD: 0.5,
    PLAYER_CHAR: 'b',
    PLAYER_WALK_SPEED: 1.85,
    PLAYER_RUN_SPEED: 4.1,
    PLAYER_SWIM_SPEED: 1.15,
    PLAYER_RADIUS: 0.15,
    PLAYER_TURN_SPEED: 12.0,
    PLAYER_ACCEL: 30.0,
    PLAYER_FRICTION: 34.0,
    JOYSTICK_DEADZONE: 0.14,
    WALK_CYCLE_MS: 680,
    // Handling GTA 2D iso: 4 direções, sem girar no eixo
    VEHICLE_ACCEL: 3.4,
    VEHICLE_MAX_SPEED: 3.15,
    VEHICLE_BRAKE: 10.0,
    VEHICLE_COAST: 4.0,
    VEHICLE_TURN_STEP_S: 0.26,
    VEHICLE_TURN_MIN_SPEED: 0.18,
    HELI_MAX_SPEED: 4.6,
    HELI_ACCEL: 5.2,
    /**
     * Altura de levitação (tiles acima do CHÃO DEBAIXO do nariz). Empurrou o manche com o
     * aparelho no solo, ele sobe até aqui e segura — o bastante para passar sobre carros e
     * cercas, pouco demais para cruzar o talude de uma montanha.
     */
    HELI_CRUISE_ALTITUDE: 2.2,
    /** Os comandos SUBIR/DESCER movem a COTA absoluta do aparelho, não a altura do solo. */
    HELI_CLIMB_RATE: 2.6,
    HELI_SINK_RATE: 2.2,
    /**
     * Teto do voo em tiles acima do nível 0 do mundo. O relevo sobe até
     * TERRAIN_MAX_LEVEL * TERRAIN_LEVEL_TILES = 4; restam 4 de ar acima da crista mais alta.
     */
    HELI_CEILING_ELEVATION: 8,
    /** Folga do casco: só passa sobre o ressalto à frente quem está claramente acima dele. */
    HELI_WALL_TOLERANCE: 0.1,
    VEHICLE_REVERSE_RATIO: 0.42,
    VEHICLE_REVERSE_ACCEL: 4.2,
    VEHICLE_STOP_EPS: 0.05,
    VEHICLE_ENTER_RANGE: 1.55,
    VEHICLE_EXIT_COOLDOWN: 0.45,
    VEHICLE_RADIUS: 0.24,
    // População acompanha o mapa: 400 pedestres na malha 240×240 mantêm a densidade do
    // centro e ainda enchem as ruas novas das bordas. Só os ~22 tiles próximos simulam.
    NPC_COUNT: 400,
    NPC_WALK_SPEED: 1.25,
    NPC_FLEE_SPEED: 2.35,
    NPC_SWIM_SPEED: 1.0,
    NPC_PATIENCE_MS: [500, 1600],
    NPC_RADIUS: 0.15,
    NPC_CHARS: ['a', 'c'],
    TRAFFIC_MAX: 56,
    TRAFFIC_SPAWN_CHANCE: 0.94,
    WANTED_MAX: 5,
    WANTED_STEAL: 1,
    WANTED_HIT_PED: 1,
    WANTED_DECAY_S: 14,
    CRASH_DAMAGE_SPEED: 1.85,
    /** Abaixo dessa velocidade o carro só encosta; acima ele atropela. */
    HIT_PED_SPEED: 1.45,
    /** Atropelamento: base + velocidade. Um pedestre de 45 hp não levanta de um carro em curso. */
    RUNOVER_DAMAGE: 18,
    RUNOVER_DAMAGE_PER_SPEED: 16,
    /** O jogador apanha menos que um pedestre: quem para no meio da rua tem tempo de sair. */
    RUNOVER_PLAYER_RATIO: 0.5,
    /** Tiles que o corpo voa para fora da pista. Menos que isso a vítima continua sob as rodas. */
    RUNOVER_THROW: 0.9,
    /** ---- Stamina (corrida) ---- */
    STAMINA_RUN_DRAIN: 0.17,
    STAMINA_REGEN: 0.24,
    STAMINA_SPRINT_MIN: 0.06,
    /** ---- Combate corpo a corpo ---- */
    ATTACK_COOLDOWN_S: 0.46,
    ATTACK_ANIM_S: 0.38,
    ATTACK_RANGE: 0.85,
    ATTACK_ARC: 1.25,
    ATTACK_DAMAGE: 22,
    NPC_DOWN_S: 2.4,
    WANTED_HIT_CIV: 0.6,
    WANTED_HIT_COP: 1.2,
    WANTED_KILL: 1.5,
    COP_PUNCH_DAMAGE: 7,
    COP_PUNCH_COOLDOWN_S: 1.1,
    DROP_MONEY_MIN: 8,
    DROP_MONEY_MAX: 35,
    /** ---- Polícia ---- */
    POLICE_UNITS_BY_WANTED: [0, 1, 2, 3, 4, 6],
    POLICE_COPS_BY_WANTED: [0, 2, 4, 7, 10, 16],
    POLICE_SPAWN_INTERVAL_S: 6.5,
    POLICE_SPEED: 2.5,
    POLICE_DESPAWN_DIST: 52,
    POLICE_RAM_DAMAGE: 9,
    ARREST_RANGE: 1.35,
    ARREST_STAND_STILL_S: 1.1,
    BUSTED_MONEY_LOSS: 150,
    WASTED_MONEY_LOSS: 100,
    /** Pena de cadeia: base + por estrela. Cumprir o tempo abre a cela. */
    JAIL_BASE_S: 18,
    JAIL_PER_STAR_S: 6,
    /** Arrombar a própria cela; o painel dos presos cobra uma estrela a menos. */
    WANTED_JAILBREAK: 3,
    /** Fiança no balcão da delegacia: preço por estrela ainda no seu registro. */
    BAIL_PER_STAR: 60,
    /** Visão do guarda da cadeia: alcance e meio-ângulo do cone, em radianos. */
    GUARD_SIGHT_RANGE: 5.2,
    GUARD_FOV_HALF: 0.95,
    /** Quanto tempo o guarda continua na caçada depois de perder o fugitivo de vista. */
    GUARD_ALERT_S: 4.5,
    /** Encostar no fugitivo é contenção: o guarda devolve o preso para a cela. */
    GUARD_CATCH_RADIUS: 0.7,
    /** Tempo extra de pena por ser recapturado tentando fugir antes da hora. */
    JAIL_BREAK_PENALTY_S: 12,
    /** ---- Apoio aéreo policial (aparece com 4 estrelas ou mais) ---- */
    /** Folga sobre o chão DEBAIXO da aeronave, em tiles. Cada tile vira ELEVATION_PX (64px) de
     *  elevação na tela: 2 ≈ 128px, acima dos prédios e ainda dentro do quadro em celular
     *  deitado (a metade da tela é ~195px e a barra superior da HUD come ~50px). */
    POLICE_HELI_ALTITUDE: 2,
    POLICE_HELI_SPOT_RANGE: 11,
    /** ---- Visão dos inimigos (todos usam o mesmo VisionSystem) ----
     *  A rua: um policial a pé enxerga um arco à sua frente, não os 360° ao redor. */
    POLICE_VISION_RANGE_FOOT: 12,
    /** De viatura o campo é maior (vidros + giroflex), mas continua um cone. */
    POLICE_VISION_RANGE_VEHICLE: 14,
    POLICE_VISION_HALF_FOOT: 1.15,
    POLICE_VISION_HALF_ALERT: 1.45,
    /** A noite encurta o alcance de todo mundo, inclusive dos animais. */
    VISION_NIGHT_LIGHT: 0.72,
    /** Reação por tipo: quanto tempo o policial mantém a guarda alta depois de perder de vista. */
    POLICE_ALERT_MEMORY_S: 6,
    /** Fauna: teto da vista — o raio de alerta da espécie manda, mas nenhum bicho enxerga a
     *  15 tiles como um carro da polícia. De costas só sente o chão tremer (ver WildlifeSystem). */
    WILDLIFE_VISION_RANGE: 7,
    /** Meio-ângulo do arco da fauna, em radianos (~1.0 = 115° de visão, presa olha os lados). */
    WILDLIFE_VISION_HALF: 1.0,
    /** ---- Missões de entrega ---- */
    MISSION_BASE_REWARD: 90,
    MISSION_CHAIN_MULT: 0.35,
    MISSION_CHAIN_MAX: 4,
    MISSION_COOLDOWN_S: 9,
    MISSION_MIN_DIST: 14,
    MISSION_MAX_DIST: 55,
    MISSION_SPEED_ESTIMATE: 2.4,
    MISSION_TIME_BUFFER_S: 9,
    /** ---- Pickups ---- */
    PICKUP_CASH_COUNT: 22,
    PICKUP_HEALTH_COUNT: 9,
    PICKUP_GUN_COUNT: 12,
    PICKUP_RESPAWN_S: 40,
    PICKUP_CASH_MIN: 12,
    PICKUP_CASH_MAX: 45,
    PICKUP_HEALTH_AMOUNT: 30,
    /** ---- Vida ---- */
    HEALTH_REGEN_DELAY_S: 8,
    HEALTH_REGEN_PER_S: 2.2,
    PLAYER_EXPLODE_DAMAGE: 45,
    /** ---- Ciclo dia/noite (s por dia completo) ---- */
    DAY_NIGHT_CYCLE_S: 300,
    DAY_START_T: 0.36,
    NIGHT_TINT_MAX: 0.5,
    /** ---- Clima ---- */
    WEATHER_CHECK_INTERVAL_S: 25,
    WEATHER_FADE_S: 6,
    /** Uma estação do ano dura um dia do jogo; o ano inteiro cabe em 20 minutos. */
    SEASON_LENGTH_S: 300,
    /** ---- Clima severo (tornado, furacão, tsunami) ---- */
    /** Pausa entre eventos: o espetáculo é raro, senão vira cenário permanente. */
    HAZARD_COOLDOWN_S: [210, 420],
    /** Reavalia quando o clima ainda não ajuda o perigo que foi sorteado. */
    HAZARD_RETRY_S: 40,
    HAZARD_WATCH_S: 12,
    HAZARD_FADE_S: 9,
    /** Tempo de vida do funil e o alcance do vento dele em múltiplos do raio. */
    TORNADO_LIFE_S: [48, 82],
    TORNADO_REACH: 2.6,
    TORNADO_RADIUS: [2.2, 5],
    /** Velocidade do funil pelo mapa e da força que arremessa as coisas. */
    TORNADO_TRACK_SPEED: 1.9,
    TORNADO_FORCE: 4.6,
    TORNADO_PLAYER_DMG_S: 26,
    HURRICANE_LIFE_S: [70, 130],
    /** Deslocamento (tiles/s) que o vento global empurra pedestres e carros. */
    HURRICANE_PUSH: 0.85,
    HURRICANE_WET: 0.35,
    TSUNAMI_LIFE_S: [34, 46],
    /** A onda avança até este número de tiles para dentro da costa. */
    TSUNAMI_REACH_TILES: 12,
    TSUNAMI_SPEED: 5.5,
    TSUNAMI_FORCE: 5.2,
    /** Vida por segundo dentro da água da onda: quem entra na corrente se afoga. */
    TSUNAMI_PLAYER_DMG_S: 36,
    /** Largura do trecho de costa que a onda varre. */
    TSUNAMI_SPAN_TILES: 26,
    /** Só faz tsunami perto do mar: longe da costa o aviso não mostraria nada. */
    TSUNAMI_NEAR_TILES: 16,
    /** ---- Relevo (2.5D: altura do chão, nunca uma terceira dimensão de câmera) ---- */
    /** Um nível do campo de altura vale 1/4 de tile de elevação, ou 16px de tela. */
    TERRAIN_LEVEL_TILES: 0.25,
    /** Teto da montanha: 16 níveis = 4 tiles de paredes empilhadas, o máximo que se pinta. */
    TERRAIN_MAX_LEVEL: 16,
    /** A pé se sobe um degrau inteiro sem saltar; o meio impede a parede invisível de 1,25. */
    TERRAIN_STEP_UP_FOOT: 1,
    /** Roda só encara rampa: o gerador suaviza a malha viária exatamente a este teto. */
    TERRAIN_STEP_UP_VEHICLE: 1,
    /** Abaixo disto o cavalo do terraço é face pintada; acima, é pedra de montanha. */
    TERRAIN_CLIFF_LEVELS: 4,
    /** Queda livre: até aqui se despenca andando, mais que isso é parede que se contorna. */
    TERRAIN_MAX_DROP: 3,
    /** Quanto a subida come de velocidade por nível à frente, e o quanto a descida devolve. */
    TERRAIN_SLOPE_SLOW: 0.3,
    /** ---- Destruição de veículos ---- */
    VEHICLE_EXPLOSION_RADIUS: 2.6,
    VEHICLE_EXPLOSION_DMG: 38,
    VIEW_CULL_MARGIN: 1.2,
    /** Simulação NPC: full dentro de NEAR; idle lento até FAR; congelado além. */
    NPC_SIM_NEAR: 22,
    NPC_SIM_FAR: 40,
    BAKE_INTERVAL_MS: 100,
    ENTITY_CULL_MS: 120,
    TARGET_FPS: 60,
    FIXED_DT: 1 / 60,
    MAX_DT: 1 / 20,
    ANIM_FRAME_MS: 80,
};
exports.DIRS_4 = ['NE', 'NW', 'SE', 'SW'];
