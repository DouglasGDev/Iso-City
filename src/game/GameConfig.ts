export const GAME_CONFIG = {
  MAP_TILES_W: 240,
  MAP_TILES_H: 240,

  ZOOM_DEFAULT: 1.55,
  ZOOM_MIN: 0.95,
  ZOOM_MAX: 1.85,
  // Rooms are small, so the close-up zoom is above the outdoor range.
  ZOOM_INDOORS: 1.8,
  CAMERA_LERP: 14.5,
  CAMERA_LOOKAHEAD: 0.5,

  PLAYER_CHAR: 'b' as const,
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
   * TERRAIN_MAX_ELEVATION = 4; restam 4 de ar acima da crista mais alta.
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
  NPC_CHARS: ['a', 'c'] as const,

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
  POLICE_UNITS_BY_WANTED: [0, 1, 2, 3, 4, 6] as const,
  POLICE_COPS_BY_WANTED: [0, 2, 4, 7, 10, 16] as const,
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
  /**
   * A partir daqui a frente que já está no céu pode crescer para o próximo estágio (névoa →
   * nublado → garoa → chuva → tempestade). É o "pegar desprevenido": ninguém escolheu a
   * tempestade, ela nasceu da garoa que já estava sobre a cabeça do jogador.
   */
  WEATHER_ESCALATE_FIRST_S: [14, 30],
  /** Recomeço da janela quando a tentativa não pegou: cresce aos poucos, não de uma vez. */
  WEATHER_ESCALATE_RETRY_S: [10, 20],
  /**
   * Neve no chão: uma frente inteira de neve forte (40..95s) cobre o mundo todo. Mais que
   * isso e a nevasca vira paisagem permanente; menos e ela some antes de o jogador voltar.
   */
  SNOW_ACCUMULATE_S: 90,
  /**
   * Derreter é o dobro de acumular. É o "fazer durar" do pedido: a frente passa, o céu
   * limpa, e a serra continua branca por um dia e meio de jogo.
   */
  SNOW_MELT_S: 420,

  /** ---- Clima severo (tornado, furacão, tsunami) ---- */
  /**
   * Pausa entre eventos: dez a meia hora de jogo. O pedido é explícito — tsunami e tornado
   * têm que ser raros, e quem preenche o mundo é o clima normal. Uma sessão comum pode
   * atravessar sem nenhum; quando vem, é notícia em vez de cenário.
   */
  HAZARD_COOLDOWN_S: [600, 1800],
  /** Reavalia quando o clima ainda não ajuda o perigo que foi sorteado. */
  HAZARD_RETRY_S: 90,
  /**
   * Nenhum perigo nos primeiros cinco minutos do jogo recém-carregado: o jogador explora o
   * mapa antes de a casa cair. Sem isso, o reload caía em cima de um funil.
   */
  HAZARD_GRACE_S: 300,
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
  /**
   * Raio do campo de vento, em tiles. O furacão é um olho que anda pelo mapa, não o
   * mundo inteiro: quem está fora deste círculo não é empurrado, não treme e não apanha.
   * A tela inteira cabe dentro dele, então o vento que machuca sempre tem nuvem na tela.
   */
  HURRICANE_REACH_TILES: 11,
  /** Olho calmo: no centro do furacão o vento para, como no furacão de verdade. */
  HURRICANE_EYE_TILES: 2.5,
  /** Parede do olho: a faixa que arremessa e fere, logo depois do olho calmo. */
  HURRICANE_WALL_TILES: 5.5,
  /** Velocidade do olho cruzando o mapa: lento e enorme, como uma massa de tempestade. */
  HURRICANE_TRACK_SPEED: 1.4,
  /** Deslocamento (tiles/s) que a parede do olho empurra pedestres e carros. */
  HURRICANE_PUSH: 0.85,
  /** Vida por segundo na parede do olho: atravessá-la custa, ficar nela mata. */
  HURRICANE_PLAYER_DMG_S: 8,
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

  /** ---- Relevo (2.5D: altura do chão em tiles; campo contínuo, nunca degrau) ---- */
  /** Teto da serra em tiles de elevação: 4 × ELEVATION_PX = 256px na tela. */
  TERRAIN_MAX_ELEVATION: 4,
  /** A pé se sobe meia encosta de um lance. Acima disso a face barra o passo. */
  TERRAIN_STEP_UP_TILES: 0.6,
  /** Queda com que se despenca andando, sem virar parede a contornar. */
  TERRAIN_MAX_DROP_TILES: 1.6,
  /** Roda só encara rampa: o gerador aplaina asfalto, trilha e cidade dentro disto. */
  TERRAIN_STEP_UP_VEHICLE: 0.34,
  /**
   * Teto de declive da reserva funda, em tile de altura por tile de chão. Não é capricho
   * de arte: na projeção isométrica um tile de altura vale 64px de tela e um tile de
   * profundidade vale 32px, então declive 0,5 já fecha o losango em pé e acima disso a
   * encosta inverte e vira beiral. É por isto que o relevo se desenha como encosta
   * sombreada de mapa, e nunca como parede de bloco.
   */
  TERRAIN_MAX_SLOPE_TILES: 0.3,
  /** Quanto a subida come de velocidade por tile de desnível à frente. */
  TERRAIN_SLOPE_SLOW: 0.5,

  /** ---- Cachoeiras do relevo (§6) ---- */
  /**
   * Velocidade da veia no pé da queda, em tiles por segundo. Tem de passar de
   * PLAYER_SWIM_SPEED (1,15), senão quem cai no lençol consegue nadar contra a queda e a
   * cachoeira vira enfeite: aqui a água manda, e sair dela é andar até a margem.
   */
  CASCADE_FLOW_SPEED: 3.4,
  /** Giro da bacia: mais fraco que a queda, para o corpo encostar na borda e poder sair. */
  CASCADE_POOL_SPEED: 1.05,
  /**
   * Folga lateral além da folha desenhada, em fração da meia-largura. O espirro molha e
   * empurra um pouco fora do lençol, e é esta margem que decide onde a beira ainda pega.
   */
  CASCADE_MARGIN: 1.35,
  /** Vida por segundo embaixo do lençol. Dói e empurra para fora, mas não é tsunami. */
  CASCADE_PLAYER_DMG_S: 6,
  /** Ferro batido na pedra molhada: o carro arrastado perde lataria, não explode sozinho. */
  CASCADE_VEHICLE_DMG_S: 9,
  /** Alcance do rugido em tiles: uma cachoeira é um lugar, não uma estação do mapa. */
  CASCADE_NOISE_TILES: 17,

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
} as const;

export type Dir4 = 'NE' | 'NW' | 'SE' | 'SW';
export const DIRS_4: Dir4[] = ['NE', 'NW', 'SE', 'SW'];

export type TileKind = 'grass' | 'dirt' | 'concrete' | 'road' | 'water';
export type Biome =
  | 'downtown'
  | 'commercial'
  | 'residential'
  | 'park'
  | 'industrial'
  | 'suburb'
  | 'market'
  | 'docks'
  | 'forest'
  | 'countryside'
  | 'pinewood'
  | 'savanna'
  | 'beach'
  | 'desert';
